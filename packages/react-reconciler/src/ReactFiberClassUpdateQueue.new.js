/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// UpdateQueue is a linked list of prioritized updates.
//
// Like fibers, update queues come in pairs: a current queue, which represents
// the visible state of the screen, and a work-in-progress queue, which can be
// mutated and processed asynchronously before it is committed — a form of
// double buffering. If a work-in-progress render is discarded before finishing,
// we create a new work-in-progress by cloning the current queue.
//
// Both queues share a persistent, singly-linked list structure. To schedule an
// update, we append it to the end of both queues. Each queue maintains a
// pointer to first update in the persistent list that hasn't been processed.
// The work-in-progress pointer always has a position equal to or greater than
// the current queue, since we always work on that one. The current queue's
// pointer is only updated during the commit phase, when we swap in the
// work-in-progress.
//
// For example:
//
//   Current pointer:           A - B - C - D - E - F
//   Work-in-progress pointer:              D - E - F
//                                          ^
//                                          The work-in-progress queue has
//                                          processed more updates than current.
//
// The reason we append to both queues is because otherwise we might drop
// updates without ever processing them. For example, if we only add updates to
// the work-in-progress queue, some updates could be lost whenever a work-in
// -progress render restarts by cloning from current. Similarly, if we only add
// updates to the current queue, the updates will be lost whenever an already
// in-progress queue commits and swaps with the current queue. However, by
// adding to both queues, we guarantee that the update will be part of the next
// work-in-progress. (And because the work-in-progress queue becomes the
// current queue once it commits, there's no danger of applying the same
// update twice.)
//
// Prioritization
// --------------
//
// Updates are not sorted by priority, but by insertion; new updates are always
// appended to the end of the list.
//
// The priority is still important, though. When processing the update queue
// during the render phase, only the updates with sufficient priority are
// included in the result. If we skip an update because it has insufficient
// priority, it remains in the queue to be processed later, during a lower
// priority render. Crucially, all updates subsequent to a skipped update also
// remain in the queue *regardless of their priority*. That means high priority
// updates are sometimes processed twice, at two separate priorities. We also
// keep track of a base state, that represents the state before the first
// update in the queue is applied.
//
// For example:
//
//   Given a base state of '', and the following queue of updates
//
//     A1 - B2 - C1 - D2
//
//   where the number indicates the priority, and the update is applied to the
//   previous state by appending a letter, React will process these updates as
//   two separate renders, one per distinct priority level:
//
//   First render, at priority 1:
//     Base state: ''
//     Updates: [A1, C1]
//     Result state: 'AC'
//
//   Second render, at priority 2:
//     Base state: 'A'            <-  The base state does not include C1,
//                                    because B2 was skipped.
//     Updates: [B2, C1, D2]      <-  C1 was rebased on top of B2
//     Result state: 'ABCD'
//
// Because we process updates in insertion order, and rebase high priority
// updates when preceding updates are skipped, the final result is deterministic
// regardless of priority. Intermediate state may vary according to system
// resources, but the final state is always the same.

import type {Fiber, FiberRoot} from './ReactInternalTypes';
import type {Lanes, Lane} from './ReactFiberLane.new';

import {
  NoLane,
  NoLanes,
  OffscreenLane,
  isSubsetOfLanes,
  mergeLanes,
  removeLanes,
  isTransitionLane,
  intersectLanes,
  markRootEntangled,
} from './ReactFiberLane.new';
import {
  enterDisallowedContextReadInDEV,
  exitDisallowedContextReadInDEV,
} from './ReactFiberNewContext.new';
import {Callback, ShouldCapture, DidCapture} from './ReactFiberFlags';

import {debugRenderPhaseSideEffectsForStrictMode} from 'shared/ReactFeatureFlags';

import {StrictLegacyMode} from './ReactTypeOfMode';
import {
  markSkippedUpdateLanes,
  isUnsafeClassRenderPhaseUpdate,
  getWorkInProgressRootRenderLanes,
} from './ReactFiberWorkLoop.new';
import {
  enqueueConcurrentClassUpdate,
  unsafe_markUpdateLaneFromFiberToRoot,
} from './ReactFiberConcurrentUpdates.new';
import {setIsStrictModeForDevtools} from './ReactFiberDevToolsHook.new';

import assign from 'shared/assign';

// 定义更新类型，描述一次状态或属性的更改
export type Update<State> = {|
  // TODO: 临时字段。将通过在根节点上存储 transition -> event time 映射来移除此字段
  eventTime: number,           // 事件发生的时间戳，用于优先级计算和调度

  lane: Lane,                 // 该更新所属的优先级车道，决定更新的执行顺序

  tag: 0 | 1 | 2 | 3,        // 更新标签，区分不同类型的更新操作：
                              // 0 = UpdateState (状态更新)
                              // 1 = ReplaceState (替换状态)
                              // 2 = ForceUpdate (强制更新)
                              // 3 = CaptureUpdate (捕获更新，用于错误处理)

  payload: any,               // 更新的负载数据，根据更新类型不同而不同：
                              // - 对于状态更新，是新的状态值或状态计算函数
                              // - 对于属性更新，是新的属性对象

  callback: (() => mixed) | null,  // 更新完成后的回调函数，通常用于 componentDidUpdate
                                   // 或 setState 的回调参数

  next: Update<State> | null,      // 指向下一个更新的指针，形成链表结构，用于连接同一队列中的多个更新
|};
// 共享队列类型定义，用于跟踪等待中的更新
export type SharedQueue<State> = {|
  pending: Update<State> | null,  // 指向等待处理的最新更新，形成一个循环链表
  lanes: Lanes,                   // 表示当前等待的更新所处的优先级车道
|};

// 更新队列类型定义，完整描述了一个组件的更新状态
export type UpdateQueue<State> = {|
  baseState: State,                                    // 计算更新时的基准状态
  firstBaseUpdate: Update<State> | null,               // 第一个待处理的基准更新
  lastBaseUpdate: Update<State> | null,                // 最后一个待处理的基准更新
  shared: SharedQueue<State>,                          // 共享队列，包含待处理的更新
  effects: Array<Update<State>> | null,                // 存储产生副作用的更新数组，主要用于DevTools调试
|};

export const UpdateState = 0;
export const ReplaceState = 1;
export const ForceUpdate = 2;
export const CaptureUpdate = 3;

// Global state that is reset at the beginning of calling `processUpdateQueue`.
// It should only be read right after calling `processUpdateQueue`, via
// `checkHasForceUpdateAfterProcessing`.
let hasForceUpdate = false;

let didWarnUpdateInsideUpdate;
let currentlyProcessingQueue;
export let resetCurrentlyProcessingQueue;
if (__DEV__) {
  didWarnUpdateInsideUpdate = false;
  currentlyProcessingQueue = null;
  resetCurrentlyProcessingQueue = () => {
    currentlyProcessingQueue = null;
  };
}
// 这里初始化fiber.updateQueue。在beginWork阶段，updateHostRoot中使用processUpdateQueue函数来再具体赋值
// 初始化更新队列的函数，为给定的 Fiber 创建一个全新的、空的更新队列
export function initializeUpdateQueue<State>(fiber: Fiber): void {
  // 创建一个新的更新队列对象
  const queue: UpdateQueue<State> = {
    // 设置基准状态为当前 Fiber 的记忆化状态
    // 基准状态是计算新状态的起点，后续的更新会基于此状态进行计算
    baseState: fiber.memoizedState,

    // 初始化时没有基准更新，firstBaseUpdate 指向第一批待处理的更新中的第一个
    // 在队列刚创建时为 null，随着更新的加入而改变
    firstBaseUpdate: null,

    // 初始化时没有基准更新，lastBaseUpdate 指向第一批待处理的更新中的最后一个
    // 在队列刚创建时为 null，随着更新的加入而改变
    lastBaseUpdate: null,

    // 创建共享队列部分，这部分可以在多个 Fiber 之间共享（如 current 与 workInProgress 之间）
    shared: {
      // 刚开始时没有等待处理的更新，pending 指向最新的等待处理的更新
      // pending 形成一个循环链表，存储所有待处理的更新
      pending: null,

      // 表示当前没有任何优先级车道有待处理的更新
      // NoLanes 表示空的车道集合
      lanes: NoLanes,
    },

    // 用于存储产生副作用的更新，主要用于 DevTools 调试
    // 在初始化时为空，后续可能被填充
    effects: null,
  };

  // 将创建的更新队列赋值给 Fiber 节点的 updateQueue 属性
  // 这样该 Fiber 节点就有了自己的更新队列，可以用来处理状态更新
  fiber.updateQueue = queue;
}

export function cloneUpdateQueue<State>(
  current: Fiber,
  workInProgress: Fiber,
): void {
  // Clone the update queue from current. Unless it's already a clone.
  const queue: UpdateQueue<State> = (workInProgress.updateQueue: any);
  const currentQueue: UpdateQueue<State> = (current.updateQueue: any);
  if (queue === currentQueue) {
    const clone: UpdateQueue<State> = {
      baseState: currentQueue.baseState,
      firstBaseUpdate: currentQueue.firstBaseUpdate,
      lastBaseUpdate: currentQueue.lastBaseUpdate,
      shared: currentQueue.shared,
      effects: currentQueue.effects,
    };
    workInProgress.updateQueue = clone;
  }
}

// 创建一个新的更新对象的函数
// eventTime: 事件发生的时间戳
// lane: 更新的优先级车道
export function createUpdate(eventTime: number, lane: Lane): Update<*> {
  // 创建一个 Update 对象，包含所有必要的更新信息
  const update: Update<*> = {
    // 设置事件发生的时间戳，用于优先级计算和调度决策
    eventTime,

    // 设置更新的优先级车道，决定更新的执行顺序
    lane,

    // 设置更新标签为 UpdateState (值为0)，表示这是一个状态更新
    // 这是最常见的更新类型，用于常规的状态变更
    tag: UpdateState,

    // 初始时没有负载数据，payload 会在后续被赋予实际的状态值或函数
    // payload 可以是新的状态值或一个返回新状态的函数
    payload: null,

    // 初始时没有回调函数，callback 会在后续被设置（如 setState 的回调）
    // 回调函数会在更新提交后执行
    callback: null,

    // 初始时没有下一个更新，next 为 null，当需要形成更新队列时会指向下一个更新
    // 这允许将多个更新链接成一个链表结构
    next: null,
  };

  // 返回创建的更新对象
  return update;
}
// 将更新添加到 Fiber 节点的更新队列中的函数
// fiber: 要更新的 Fiber 节点
// update: 要添加的更新对象
// lane: 更新的优先级车道
export function enqueueUpdate<State>(
  fiber: Fiber,
  update: Update<State>,
  lane: Lane,
): FiberRoot | null {
  // 获取 Fiber 节点的更新队列
  const updateQueue = fiber.updateQueue;
  if (updateQueue === null) {
    // 如果更新队列不存在，说明该 fiber 已经被卸载
    return null;
  }

  // 获取共享队列部分，这是可以跨 Fiber 实例共享的部分
  const sharedQueue: SharedQueue<State> = (updateQueue: any).shared;

  if (__DEV__) {
    // 在开发环境中，检测是否在更新函数内部调度了更新
    if (
      currentlyProcessingQueue === sharedQueue &&  // 检查是否在处理相同的队列
      !didWarnUpdateInsideUpdate  // 检查是否已经警告过
    ) {
      // 发出警告：从更新函数内部调度了更新，更新函数应该是纯函数，不应该有副作用
      console.error(
        'An update (setState, replaceState, or forceUpdate) was scheduled ' +
          'from inside an update function. Update functions should be pure, ' +
          'with zero side-effects. Consider using componentDidUpdate or a ' +
          'callback.',
      );
      // 标记已警告，避免重复警告
      didWarnUpdateInsideUpdate = true;
    }
  }

  // 类组件的旧的生命周期相关的update，这里不再展开详解
  // 检查是否是不安全的渲染阶段更新（在类组件中）
  if (isUnsafeClassRenderPhaseUpdate(fiber)) {
    // 这是一个不安全的渲染阶段更新。直接添加到更新队列，
    // 以便我们可以在当前渲染期间立即处理它

    // 获取当前等待处理的更新
    const pending = sharedQueue.pending;
    if (pending === null) {
      // 如果没有等待处理的更新，这是第一个更新，创建一个循环链表
      update.next = update;  // 将更新的 next 指向自己，形成循环
    } else {
      // 如果已有等待处理的更新，将新更新插入到链表中
      update.next = pending.next;  // 新更新的 next 指向原来第一个更新
      pending.next = update;       // 原来的最后一个更新指向新更新
    }
    // 将新更新设为等待处理的更新（最新的更新）
    sharedQueue.pending = update;

    // 即使我们很可能已经在渲染这个 fiber，也要更新 childLanes
    // 这是为了向后兼容，以防你在渲染阶段更新了与当前渲染组件
    // 不同的组件（这种模式会伴随一个警告）
    return unsafe_markUpdateLaneFromFiberToRoot(fiber, lane);
  } else {
    // 对于非渲染阶段的更新，使用并发更新队列
    return enqueueConcurrentClassUpdate(fiber, sharedQueue, update, lane);
  }
}

export function entangleTransitions(root: FiberRoot, fiber: Fiber, lane: Lane) {
  const updateQueue = fiber.updateQueue;
  if (updateQueue === null) {
    // Only occurs if the fiber has been unmounted.
    return;
  }

  const sharedQueue: SharedQueue<mixed> = (updateQueue: any).shared;
  if (isTransitionLane(lane)) {
    let queueLanes = sharedQueue.lanes;

    // If any entangled lanes are no longer pending on the root, then they must
    // have finished. We can remove them from the shared queue, which represents
    // a superset of the actually pending lanes. In some cases we may entangle
    // more than we need to, but that's OK. In fact it's worse if we *don't*
    // entangle when we should.
    queueLanes = intersectLanes(queueLanes, root.pendingLanes);

    // Entangle the new transition lane with the other transition lanes.
    const newQueueLanes = mergeLanes(queueLanes, lane);
    sharedQueue.lanes = newQueueLanes;
    // Even if queue.lanes already include lane, we don't know for certain if
    // the lane finished since the last time we entangled it. So we need to
    // entangle it again, just to be sure.
    markRootEntangled(root, newQueueLanes);
  }
}

export function enqueueCapturedUpdate<State>(
  workInProgress: Fiber,
  capturedUpdate: Update<State>,
) {
  // Captured updates are updates that are thrown by a child during the render
  // phase. They should be discarded if the render is aborted. Therefore,
  // we should only put them on the work-in-progress queue, not the current one.
  let queue: UpdateQueue<State> = (workInProgress.updateQueue: any);

  // Check if the work-in-progress queue is a clone.
  const current = workInProgress.alternate;
  if (current !== null) {
    const currentQueue: UpdateQueue<State> = (current.updateQueue: any);
    if (queue === currentQueue) {
      // The work-in-progress queue is the same as current. This happens when
      // we bail out on a parent fiber that then captures an error thrown by
      // a child. Since we want to append the update only to the work-in
      // -progress queue, we need to clone the updates. We usually clone during
      // processUpdateQueue, but that didn't happen in this case because we
      // skipped over the parent when we bailed out.
      let newFirst = null;
      let newLast = null;
      const firstBaseUpdate = queue.firstBaseUpdate;
      if (firstBaseUpdate !== null) {
        // Loop through the updates and clone them.
        let update = firstBaseUpdate;
        do {
          const clone: Update<State> = {
            eventTime: update.eventTime,
            lane: update.lane,

            tag: update.tag,
            payload: update.payload,
            callback: update.callback,

            next: null,
          };
          if (newLast === null) {
            newFirst = newLast = clone;
          } else {
            newLast.next = clone;
            newLast = clone;
          }
          update = update.next;
        } while (update !== null);

        // Append the captured update the end of the cloned list.
        if (newLast === null) {
          newFirst = newLast = capturedUpdate;
        } else {
          newLast.next = capturedUpdate;
          newLast = capturedUpdate;
        }
      } else {
        // There are no base updates.
        newFirst = newLast = capturedUpdate;
      }
      queue = {
        baseState: currentQueue.baseState,
        firstBaseUpdate: newFirst,
        lastBaseUpdate: newLast,
        shared: currentQueue.shared,
        effects: currentQueue.effects,
      };
      workInProgress.updateQueue = queue;
      return;
    }
  }

  // Append the update to the end of the list.
  const lastBaseUpdate = queue.lastBaseUpdate;
  if (lastBaseUpdate === null) {
    queue.firstBaseUpdate = capturedUpdate;
  } else {
    lastBaseUpdate.next = capturedUpdate;
  }
  queue.lastBaseUpdate = capturedUpdate;
}
// 根据更新计算新状态的函数
// workInProgress: 当前正在工作的 Fiber 节点
// queue: 更新队列
// update: 当前更新对象
// prevState: 之前的状态
// nextProps: 新的属性
// instance: 组件实例
function getStateFromUpdate<State>(
  workInProgress: Fiber,
  queue: UpdateQueue<State>,
  update: Update<State>,
  prevState: State,
  nextProps: any,
  instance: any,
): any {
  // 根据更新的标签类型处理不同的更新
  switch (update.tag) {
    case ReplaceState: {
      // 替换状态：完全替换当前状态
      const payload = update.payload;
      if (typeof payload === 'function') {
        // 如果 payload 是函数，调用该函数计算新状态
        if (__DEV__) {
          // 在开发模式下，防止在更新函数中读取上下文
          enterDisallowedContextReadInDEV();
        }
        // 调用更新函数，传入当前状态和新属性
        const nextState = payload.call(instance, prevState, nextProps);
        if (__DEV__) {
          // 在严格模式下，为了检测副作用，再次调用更新函数
          if (
            debugRenderPhaseSideEffectsForStrictMode &&
            workInProgress.mode & StrictLegacyMode
          ) {
            setIsStrictModeForDevtools(true);
            try {
              // 再次调用更新函数以检测副作用
              payload.call(instance, prevState, nextProps);
            } finally {
              // 恢复非严格模式
              setIsStrictModeForDevtools(false);
            }
          }
          // 退出不允许读取上下文的模式
          exitDisallowedContextReadInDEV();
        }
        // 返回计算出的新状态
        return nextState;
      }
      // 如果 payload 不是函数，则直接返回 payload 作为新状态
      return payload;
    }
    case CaptureUpdate: {
      // 捕获更新：用于错误边界
      // 设置 Fiber 的标志，表示需要捕获错误
      workInProgress.flags =
        (workInProgress.flags & ~ShouldCapture) | DidCapture;
    }
    // 注意：这里故意不加 break，继续执行下面的 UpdateState 逻辑
    case UpdateState: {
      // 状态更新：部分更新状态
      const payload = update.payload;
      let partialState;
      if (typeof payload === 'function') {
        // 如果 payload 是函数，调用该函数计算部分状态
        if (__DEV__) {
          // 在开发模式下，防止在更新函数中读取上下文
          enterDisallowedContextReadInDEV();
        }
        // 调用更新函数，传入当前状态和新属性
        partialState = payload.call(instance, prevState, nextProps);
        if (__DEV__) {
          // 在严格模式下，为了检测副作用，再次调用更新函数
          if (
            debugRenderPhaseSideEffectsForStrictMode &&
            workInProgress.mode & StrictLegacyMode
          ) {
            setIsStrictModeForDevtools(true);
            try {
              // 再次调用更新函数以检测副作用
              payload.call(instance, prevState, nextProps);
            } finally {
              // 恢复非严格模式
              setIsStrictModeForDevtools(false);
            }
          }
          // 退出不允许读取上下文的模式
          exitDisallowedContextReadInDEV();
        }
      } else {
        // 如果 payload 不是函数，则直接使用 payload 作为部分状态
        partialState = payload;
      }
      if (partialState === null || partialState === undefined) {
        // 如果部分状态为 null 或 undefined，则视为无操作，返回之前的状态
        return prevState;
      }
      // 合并部分状态和之前的状态，返回新状态
      return assign({}, prevState, partialState);
    }
    case ForceUpdate: {
      // 强制更新：仅标记需要强制更新，但不改变状态
      hasForceUpdate = true;  // 设置强制更新标志
      return prevState;       // 返回之前的状态
    }
  }
  // 默认返回之前的状态
  return prevState;
}
// 处理更新队列的函数
// workInProgress: 当前正在工作的 Fiber 节点
// props: 当前组件的属性
// instance: 组件实例
// renderLanes: 当前渲染的优先级车道
export function processUpdateQueue<State>(
  workInProgress: Fiber,
  props: any,
  instance: any,
  renderLanes: Lanes,
): void {
  // 获取当前 Fiber 的更新队列（在类组件或宿主根节点上始终非空）
  const queue: UpdateQueue<State> = (workInProgress.updateQueue: any);

  // 重置强制更新标志
  hasForceUpdate = false;

  if (__DEV__) {
    // 在开发环境中标记当前正在处理的队列
    currentlyProcessingQueue = queue.shared;
  }

  // 获取基础更新队列的首尾节点
  let firstBaseUpdate = queue.firstBaseUpdate;
  let lastBaseUpdate = queue.lastBaseUpdate;

  // 这里注意pending update不同于baseQueue，pending update只记录了尾节点
  // 检查是否有待处理的更新。如果有，将它们转移到基础队列。
  let pendingQueue = queue.shared.pending;
  if (pendingQueue !== null) {
    // 清空共享队列的待处理部分
    queue.shared.pending = null;

    // 待处理队列是循环链表。断开首尾指针使其变为非循环链表。
    const lastPendingUpdate = pendingQueue;         // 最后一个待处理更新
    const firstPendingUpdate = lastPendingUpdate.next; // 第一个待处理更新
    lastPendingUpdate.next = null;                  // 断开循环链接

    // 把pending update转移到base queue上
    // 接下来构建单链表：firstBaseUpdate-->...-->lastBaseUpdate
    // 将待处理更新追加到基础队列
    if (lastBaseUpdate === null) {
      // 如果基础队列为空，直接设置第一个基础更新
      firstBaseUpdate = firstPendingUpdate;
    } else {
      // 如果基础队列非空，将待处理更新连接到基础队列末尾
      lastBaseUpdate.next = firstPendingUpdate;
    }
    // 更新最后基础更新为最后待处理更新
    lastBaseUpdate = lastPendingUpdate;

    // 如果存在当前队列（current）且与基础队列不同，则需要将更新也转移到那个队列
    // 由于基础队列是无循环的单链表，我们可以同时追加到两个列表并利用结构共享
    const current = workInProgress.alternate;  // 获取对应的工作进程 Fiber
    // 如果有current queue，并且它和base queue不同，那么我们也需要把更新转移到那个queue上
    if (current !== null) {
      // 类组件和HostRoot的updateQueue都初始化过，所以这里不会是null
      // 这在类组件或宿主根节点上始终非空
      const currentQueue: UpdateQueue<State> = (current.updateQueue: any);
      const currentLastBaseUpdate = currentQueue.lastBaseUpdate;
      // 如果当前队列的最后基础更新与工作进程队列的不同
      if (currentLastBaseUpdate !== lastBaseUpdate) {
        if (currentLastBaseUpdate === null) {
          // 如果当前队列没有基础更新，设置第一个基础更新
          currentQueue.firstBaseUpdate = firstPendingUpdate;
        } else {
          // 否则将待处理更新连接到当前队列末尾
          currentLastBaseUpdate.next = firstPendingUpdate;
        }
        // 更新当前队列的最后基础更新
        currentQueue.lastBaseUpdate = lastPendingUpdate;
      }
    }
  }

  // 这些值在处理队列时可能会改变
  if (firstBaseUpdate !== null) {
    // 遍历更新列表以计算结果
    let newState = queue.baseState;  // 从基准状态开始
    // TODO: 不需要积累这个。相反，我们可以从原始车道中移除 renderLanes
    let newLanes = NoLanes;

    // 新的基础状态和更新队列
    let newBaseState = null;
    let newFirstBaseUpdate = null;
    let newLastBaseUpdate = null;

    // 从第一个基础更新开始遍历
    let update = firstBaseUpdate;
    do {
      // TODO: 不再需要这个字段
      const updateEventTime = update.eventTime;

      // 开始：这部分为Offscreen的处理，还未完成，这里不展开讲解

      // 为隐藏树中的更新添加额外的 OffscreenLane 位，
      // 以便我们可以将它们与树隐藏时已存在的更新区分开
      const updateLane = removeLanes(update.lane, OffscreenLane);
      const isHiddenUpdate = updateLane !== update.lane;
      // 检查此更新是否在树被隐藏时进行的
      // 如果是，则这不是"基础"更新，我们应该忽略进入 Offscreen 树时添加到 renderLanes 的额外基础车道
      const shouldSkipUpdate = isHiddenUpdate
        ? !isSubsetOfLanes(getWorkInProgressRootRenderLanes(), updateLane)  // 检查工作进程根渲染车道
        : !isSubsetOfLanes(renderLanes, updateLane);                       // 检查当前渲染车道

      if (shouldSkipUpdate) {
        // 优先级不足。跳过此更新。如果这是第一个跳过的更新，
        // 则前面的更新/状态是新的基础更新/状态。
        const clone: Update<State> = {
          eventTime: updateEventTime,
          lane: updateLane,

          tag: update.tag,
          payload: update.payload,
          callback: update.callback,

          next: null,
        };
        if (newLastBaseUpdate === null) {
          // 如果新基础更新队列为空，初始化它
          newFirstBaseUpdate = newLastBaseUpdate = clone;
          newBaseState = newState;
        } else {
          // 否则将克隆的更新添加到队列末尾
          newLastBaseUpdate = newLastBaseUpdate.next = clone;
        }
        // 更新队列中的剩余优先级
        newLanes = mergeLanes(newLanes, updateLane);

        // 结束：这部分为Offscreen的处理，还未完成，这里不展开讲解
      } else {
        // 此更新具有足够的优先级。

        if (newLastBaseUpdate !== null) {
          const clone: Update<State> = {
            eventTime: updateEventTime,
            // 此更新将被提交，所以我们永远不想取消提交它
            // 使用 NoLane 是可行的，因为 0 是所有位掩码的子集，
            // 所以永远不会被上面的检查跳过
            lane: NoLane,

            tag: update.tag,
            payload: update.payload,
            callback: update.callback,

            next: null,
          };
          newLastBaseUpdate = newLastBaseUpdate.next = clone;
        }

        // 处理此更新
        newState = getStateFromUpdate(
          workInProgress,
          queue,
          update,
          newState,
          props,
          instance,
        );

        // 类组件的setState会在这里存储
        // 获取更新的回调函数
        const callback = update.callback;
        if (
          callback !== null &&
          // 如果更新已经被提交，我们不应再次排队其回调
          update.lane !== NoLane
        ) {
          // 设置回调标志
          workInProgress.flags |= Callback;
          // 获取副作用数组
          const effects = queue.effects;
          if (effects === null) {
            // 如果副作用数组为空，创建新的数组
            queue.effects = [update];
          } else {
            // 否则将更新推送到现有数组
            effects.push(update);
          }
        }
      }

      // 移动到下一个更新
      update = update.next;
      if (update === null) {
        // 如果到达队列末尾，检查是否有新添加的待处理更新
        pendingQueue = queue.shared.pending;
        if (pendingQueue === null) {
          // 没有新添加的待处理更新，退出循环
          break;
        } else {
          // 在 reducer 内部调度了更新。将新的待处理更新添加到列表末尾并继续处理。
          const lastPendingUpdate = pendingQueue;
          // 故意不安全。待处理更新形成循环列表，但在将它们转移到基础队列时我们会解开它们。
          const firstPendingUpdate = ((lastPendingUpdate.next: any): Update<State>);
          lastPendingUpdate.next = null;
          update = firstPendingUpdate;
          queue.lastBaseUpdate = lastPendingUpdate;
          queue.shared.pending = null;
        }
      }
    } while (true);

    // 如果没有新的基础更新，将新状态设为基础状态
    if (newLastBaseUpdate === null) {
      newBaseState = newState;
    }

    // 更新队列状态
    queue.baseState = ((newBaseState: any): State);      // 设置新的基准状态
    queue.firstBaseUpdate = newFirstBaseUpdate;          // 设置新的第一个基础更新
    queue.lastBaseUpdate = newLastBaseUpdate;            // 设置新的最后一个基础更新

    if (firstBaseUpdate === null) {
      // `queue.lanes` 用于纠缠过渡。一旦队列为空，我们可以将其设置回零。
      queue.shared.lanes = NoLanes;
    }

    // 设置剩余到期时间为队列中剩余的任何时间
    // 这应该是可行的，因为贡献到期时间的另外两件事是 props 和 context。
    // 我们已经在开始阶段中途开始处理队列，所以我们已经处理了 props。
    // 在指定 shouldComponentUpdate 的组件中的 context 是棘手的；
    // 但我们无论如何都必须考虑这一点。
    markSkippedUpdateLanes(newLanes);     // 标记跳过的更新车道
    workInProgress.lanes = newLanes;      // 设置工作进程节点的车道
    workInProgress.memoizedState = newState; // 设置工作进程节点的记忆状态
  }

  if (__DEV__) {
    // 在开发环境中重置当前处理队列
    currentlyProcessingQueue = null;
  }
}
function callCallback(callback, context) {
  if (typeof callback !== 'function') {
    throw new Error(
      'Invalid argument passed as callback. Expected a function. Instead ' +
        `received: ${callback}`,
    );
  }

  callback.call(context);
}

export function resetHasForceUpdateBeforeProcessing() {
  hasForceUpdate = false;
}

export function checkHasForceUpdateAfterProcessing(): boolean {
  return hasForceUpdate;
}

export function commitUpdateQueue<State>(
  finishedWork: Fiber,
  finishedQueue: UpdateQueue<State>,
  instance: any,
): void {
  // Commit the effects
  const effects = finishedQueue.effects;
  finishedQueue.effects = null;
  if (effects !== null) {
    for (let i = 0; i < effects.length; i++) {
      const effect = effects[i];
      const callback = effect.callback;
      if (callback !== null) {
        effect.callback = null;
        callCallback(callback, instance);
      }
    }
  }
}
