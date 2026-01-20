/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {FiberRoot} from './ReactInternalTypes';
import type {
  UpdateQueue as HookQueue,
  Update as HookUpdate,
} from './ReactFiberHooks.new';
import type {
  SharedQueue as ClassQueue,
  Update as ClassUpdate,
} from './ReactFiberClassUpdateQueue.new';
import type {Lane, Lanes} from './ReactFiberLane.new';
import type {OffscreenInstance} from './ReactFiberOffscreenComponent';

import {warnAboutUpdateOnNotYetMountedFiberInDEV} from './ReactFiberWorkLoop.new';
import {
  NoLane,
  NoLanes,
  mergeLanes,
  markHiddenUpdate,
} from './ReactFiberLane.new';
import {NoFlags, Placement, Hydrating} from './ReactFiberFlags';
import {HostRoot, OffscreenComponent} from './ReactWorkTags';
// 定义并发更新的类型
// 这是 React 并发更新机制中的核心数据结构
export type ConcurrentUpdate = {
  next: ConcurrentUpdate,  // 指向下一个并发更新，形成链表结构
  lane: Lane,             // 更新的优先级车道
};

// 定义并发队列的类型
// 用于管理待处理的并发更新
type ConcurrentQueue = {
  pending: ConcurrentUpdate | null,  // 指向队列中待处理的更新，可能是 null
};

// 如果正在渲染过程中，且我们收到并发事件的更新，
// 我们会等到当前渲染结束（完成或中断）后再将其添加到 fiber/hook 队列。
// 推送到此数组以便我们稍后访问队列、fiber、更新等。
const concurrentQueues: Array<any> = [];  // 暂存并发更新信息的全局数组

let concurrentQueuesIndex = 0;  // 指向 concurrentQueues 数组的索引，用于追踪当前写入位置

// 跟踪当前并发更新的车道（优先级）
// 用于记录当前正在处理的更新优先级
let concurrentlyUpdatedLanes: Lanes = NoLanes;  // 初始为无车道（NoLanes）

// 处理并发更新队列中的所有更新
// 这个函数会在批量处理阶段将所有暂存的更新添加到相应的队列中
// 把concurrentQueues的内容添加到fiber的queue中
export function finishQueueingConcurrentUpdates(): void {
  // 获取当前暂存的并发队列的结束索引
  const endIndex = concurrentQueuesIndex;
  // 重置索引为0，准备下一批处理
  concurrentQueuesIndex = 0;

  // 重置全局变量，表示当前没有正在并发更新的车道
  concurrentlyUpdatedLanes = NoLanes;

  // 初始化索引，用于遍历暂存的并发队列
  let i = 0;
  // 遍历暂存的每个并发更新
  while (i < endIndex) {
    // 获取更新关联的 Fiber 节点
    const fiber: Fiber = concurrentQueues[i];
    concurrentQueues[i++] = null;  // 清空已处理的元素，帮助垃圾回收

    // 获取更新队列
    const queue: ConcurrentQueue = concurrentQueues[i];
    concurrentQueues[i++] = null;  // 清空已处理的元素

    // 获取更新对象
    const update: ConcurrentUpdate = concurrentQueues[i];
    concurrentQueues[i++] = null;  // 清空已处理的元素

    // 获取更新的优先级车道
    const lane: Lane = concurrentQueues[i];
    concurrentQueues[i++] = null;  // 清空已处理的元素

    // 如果队列和更新都不为空，则将更新添加到队列中
    // 注意:这里构建完之后的fiber.updateQueue.shared.pending数据类型是Update，但是其实这里构建成了一个单向循环链表，所以fiber.updateQueue.shared.pending其实是指循环链表的最后一个update，它的next指向的是第一个update
    if (queue !== null && update !== null) {
      // 获取队列中当前等待的更新
      const pending = queue.pending;
      if (pending === null) {
        // 如果没有等待的更新，这是第一个更新，创建一个循环链表
        update.next = update;  // 让更新的 next 指向自己，形成循环
      } else {
        // 如果已有等待的更新，将新更新插入到链表中
        update.next = pending.next;  // 新更新的 next 指向原来的第一个更新
        pending.next = update;       // 原来的最后一个更新指向新更新
      }
      // 将新更新设置为等待处理的更新（最新的更新）
      queue.pending = update;
    }

    // 如果更新有优先级车道，则标记从 Fiber 到根节点的更新车道
    if (lane !== NoLane) {
      // 更新fiber.lanes
      // 从当前节点开始,往上找到根节点,更新childLanes

      // 这个函数会标记从当前 Fiber 到根节点的路径上的车道
      // 以便知道哪些部分需要重新渲染
      markUpdateLaneFromFiberToRoot(fiber, update, lane);
    }
  }
}
export function getConcurrentlyUpdatedLanes(): Lanes {
  return concurrentlyUpdatedLanes;
}
// 将更新添加到并发更新队列的函数
// fiber: 要更新的 Fiber 节点
// queue: 并发队列，可能为空
// update: 并发更新，可能为空
// lane: 更新的优先级车道
function enqueueUpdate(
  fiber: Fiber,
  queue: ConcurrentQueue | null,
  update: ConcurrentUpdate | null,
  lane: Lane,
) {
  // 暂时不更新返回路径上的 [childLanes](file:///Users/ll/Desktop/资料/编程/仓库/react/react-18.2.0/packages/react-reconciler/src/ReactFiber.new.js#L152-L152)。如果我们正在渲染过程中，
  // 等到渲染完成后再说。
  // 将 fiber、queue、update 和 lane 添加到并发队列暂存数组中
  concurrentQueues[concurrentQueuesIndex++] = fiber;
  concurrentQueues[concurrentQueuesIndex++] = queue;
  concurrentQueues[concurrentQueuesIndex++] = update;
  concurrentQueues[concurrentQueuesIndex++] = lane;

  // 合并当前并发更新的车道到全局并发更新车道中
  concurrentlyUpdatedLanes = mergeLanes(concurrentlyUpdatedLanes, lane);

  // Fiber 的 [lane](file:///Users/ll/Desktop/资料/编程/仓库/react/react-18.2.0/packages/react-reconciler/src/ReactFiberReconciler.old.js#L502-L502) 字段在某些地方用于检查是否已安排任何工作，
  // 以执行急切的提前退出，因此我们需要立即更新它。
  // TODO: 我们可能应该将其移到 "shared" 队列中。
  // 更新 Fiber 的车道信息，合并新的优先级
  fiber.lanes = mergeLanes(fiber.lanes, lane);

  // 同时更新备选 Fiber（如果存在）的车道信息
  const alternate = fiber.alternate;
  if (alternate !== null) {
    alternate.lanes = mergeLanes(alternate.lanes, lane);
  }
}
export function enqueueConcurrentHookUpdate<S, A>(
  fiber: Fiber,
  queue: HookQueue<S, A>,
  update: HookUpdate<S, A>,
  lane: Lane,
): FiberRoot | null {
  const concurrentQueue: ConcurrentQueue = (queue: any);
  const concurrentUpdate: ConcurrentUpdate = (update: any);
  enqueueUpdate(fiber, concurrentQueue, concurrentUpdate, lane);
  return getRootForUpdatedFiber(fiber);
}

export function enqueueConcurrentHookUpdateAndEagerlyBailout<S, A>(
  fiber: Fiber,
  queue: HookQueue<S, A>,
  update: HookUpdate<S, A>,
): void {
  // This function is used to queue an update that doesn't need a rerender. The
  // only reason we queue it is in case there's a subsequent higher priority
  // update that causes it to be rebased.
  const lane = NoLane;
  const concurrentQueue: ConcurrentQueue = (queue: any);
  const concurrentUpdate: ConcurrentUpdate = (update: any);
  enqueueUpdate(fiber, concurrentQueue, concurrentUpdate, lane);
}
// 在类组件中将更新添加到并发更新队列的函数
// fiber: 要更新的 Fiber 节点
// queue: 类组件的更新队列
// update: 要添加的更新对象
// lane: 更新的优先级车道
export function enqueueConcurrentClassUpdate<State>(
  fiber: Fiber,
  queue: ClassQueue<State>,
  update: ClassUpdate<State>,
  lane: Lane,
): FiberRoot | null {
  // 将队列转换为并发队列类型
  const concurrentQueue: ConcurrentQueue = (queue: any);

  // 将更新转换为并发更新类型
  const concurrentUpdate: ConcurrentUpdate = (update: any);

  // 调用通用的 enqueueUpdate 函数将更新添加到队列中
  // 这里使用类型转换是因为参数类型名称不同，但实际结构兼容
  enqueueUpdate(fiber, concurrentQueue, concurrentUpdate, lane);

  // 获取并返回与更新的 Fiber 相关的根节点
  // 这个根节点将用于后续的调度和渲染过程
  return getRootForUpdatedFiber(fiber);
}

export function enqueueConcurrentRenderForLane(
  fiber: Fiber,
  lane: Lane,
): FiberRoot | null {
  enqueueUpdate(fiber, null, null, lane);
  return getRootForUpdatedFiber(fiber);
}

// Calling this function outside this module should only be done for backwards
// compatibility and should always be accompanied by a warning.
export function unsafe_markUpdateLaneFromFiberToRoot(
  sourceFiber: Fiber,
  lane: Lane,
): FiberRoot | null {
  markUpdateLaneFromFiberToRoot(sourceFiber, null, lane);
  return getRootForUpdatedFiber(sourceFiber);
}
// 从 Fiber 节点到根节点标记更新的优先级车道
// sourceFiber: 源 Fiber 节点
// update: 并发更新对象，可能为空
// lane: 更新的优先级车道
function markUpdateLaneFromFiberToRoot(
  sourceFiber: Fiber,
  update: ConcurrentUpdate | null,
  lane: Lane,
): void {
  // 更新源 Fiber 节点的车道，将新的车道合并到现有车道中
  sourceFiber.lanes = mergeLanes(sourceFiber.lanes, lane);

  // 如果存在备选 Fiber（工作进程中的 Fiber），也需要更新其车道
  let alternate = sourceFiber.alternate;
  if (alternate !== null) {
    // 同样将新的车道合并到备选 Fiber 的车道中
    alternate.lanes = mergeLanes(alternate.lanes, lane);
  }

  // 沿着父路径向根节点遍历，并更新子车道
  let isHidden = false; // 标记是否存在隐藏的离屏组件
  let parent = sourceFiber.return; // 获取父 Fiber 节点
  let node = sourceFiber; // 当前处理的节点

  // 向上遍历到根节点
  while (parent !== null) {
    // 将车道合并到父节点的子车道中
    parent.childLanes = mergeLanes(parent.childLanes, lane);

    // 同样更新备选 Fiber 的子车道
    alternate = parent.alternate;
    if (alternate !== null) {
      alternate.childLanes = mergeLanes(alternate.childLanes, lane);
    }

    // 检查父节点是否是离屏组件（Offscreen component）
    if (parent.tag === OffscreenComponent) {
      // 获取离屏组件实例
      const offscreenInstance: OffscreenInstance = parent.stateNode;
      // 检查该离屏组件是否被隐藏
      if (offscreenInstance.isHidden) {
        // 如果是隐藏的，设置隐藏标记
        isHidden = true;
      }
    }

    // 移动到父节点继续遍历
    node = parent;
    parent = parent.return;
  }

  // 如果存在隐藏的离屏组件，且更新和节点有效，且节点是宿主根节点
  if (isHidden && update !== null && node.tag === HostRoot) {
    // 获取 Fiber 根节点
    const root: FiberRoot = node.stateNode;
    // 标记隐藏的更新
    markHiddenUpdate(root, update, lane);
  }
}
function getRootForUpdatedFiber(sourceFiber: Fiber): FiberRoot | null {
  // When a setState happens, we must ensure the root is scheduled. Because
  // update queues do not have a backpointer to the root, the only way to do
  // this currently is to walk up the return path. This used to not be a big
  // deal because we would have to walk up the return path to set
  // the `childLanes`, anyway, but now those two traversals happen at
  // different times.
  // TODO: Consider adding a `root` backpointer on the update queue.
  detectUpdateOnUnmountedFiber(sourceFiber, sourceFiber);
  let node = sourceFiber;
  let parent = node.return;
  while (parent !== null) {
    detectUpdateOnUnmountedFiber(sourceFiber, node);
    node = parent;
    parent = node.return;
  }
  return node.tag === HostRoot ? (node.stateNode: FiberRoot) : null;
}

function detectUpdateOnUnmountedFiber(sourceFiber: Fiber, parent: Fiber) {
  if (__DEV__) {
    const alternate = parent.alternate;
    if (
      alternate === null &&
      (parent.flags & (Placement | Hydrating)) !== NoFlags
    ) {
      warnAboutUpdateOnNotYetMountedFiberInDEV(sourceFiber);
    }
  }
}
