/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// 导入所需类型
import type {ReactNodeList} from 'shared/ReactTypes'; // 导入React节点列表类型
import type {
  FiberRoot,
  SuspenseHydrationCallbacks,
  TransitionTracingCallbacks,
} from './ReactInternalTypes'; // 导入内部类型定义
import type {RootTag} from './ReactRootTags'; // 导入根标签类型
import type {Cache} from './ReactFiberCacheComponent.new'; // 导入缓存类型
import type {
  PendingSuspenseBoundaries,
  Transition,
} from './ReactFiberTracingMarkerComponent.new'; // 导入待处理Suspense边界和过渡类型

// 从宿主配置导入相关常量
import {noTimeout, supportsHydration} from './ReactFiberHostConfig'; 
// 创建宿主根fiber的函数
import {createHostRootFiber} from './ReactFiber.new';
// 导入车道相关的常量和函数
import {
  NoLane,
  NoLanes,
  NoTimestamp,
  TotalLanes,
  createLaneMap,
} from './ReactFiberLane.new';
// 导入各种特性开关
import {
  enableSuspenseCallback,
  enableCache,
  enableProfilerCommitHooks,
  enableProfilerTimer,
  enableUpdaterTracking,
  enableTransitionTracing,
} from 'shared/ReactFeatureFlags';
// 初始化更新队列的函数
import {initializeUpdateQueue} from './ReactFiberClassUpdateQueue.new';
// 导入根标签常量
import {LegacyRoot, ConcurrentRoot} from './ReactRootTags';
// 创建和保留缓存的函数
import {createCache, retainCache} from './ReactFiberCacheComponent.new';

// 定义根状态类型，包含根组件的元素、是否脱水、缓存等信息
export type RootState = {
  element: any, // 根组件的元素
  isDehydrated: boolean, // 是否是脱水状态
  cache: Cache, // 缓存
  pendingSuspenseBoundaries: PendingSuspenseBoundaries | null, // 待处理的Suspense边界
  transitions: Set<Transition> | null, // 过渡集合
};

// Fiber根节点构造函数，初始化根节点的各种属性
function FiberRootNode(
  containerInfo, // 容器信息
  tag, // 标签类型
  hydrate, // 是否水合
  identifierPrefix, // 标识符前缀
  onRecoverableError, // 可恢复错误处理函数
) {
  // 设置根节点的基本属性
  this.tag = tag; // 根标签类型
  this.containerInfo = containerInfo; // 容器信息
  this.pendingChildren = null; // 待处理的子节点
  this.current = null; // 当前fiber
  this.pingCache = null; // ping缓存
  this.finishedWork = null; // 已完成的工作
  this.timeoutHandle = noTimeout; // 超时句柄
  this.context = null; // 上下文
  this.pendingContext = null; // 待处理的上下文
  this.callbackNode = null; // 回调节点
  this.callbackPriority = NoLane; // 回调优先级
  this.eventTimes = createLaneMap(NoLanes); // 事件时间映射
  this.expirationTimes = createLaneMap(NoTimestamp); // 过期时间映射

  // 初始化各种车道相关属性
  this.pendingLanes = NoLanes; // 待处理车道
  this.suspendedLanes = NoLanes; // 暂停的车道
  this.pingedLanes = NoLanes; // pinged车道
  this.expiredLanes = NoLanes; // 过期的车道
  this.mutableReadLanes = NoLanes; // 可变读取车道
  this.finishedLanes = NoLanes; // 已完成的车道

  // 初始化纠缠车道相关属性
  this.entangledLanes = NoLanes; // 纠缠车道
  this.entanglements = createLaneMap(NoLanes); // 纠缠映射

  // 隐藏的更新
  this.hiddenUpdates = createLaneMap(null);

  // 设置标识符前缀和可恢复错误处理函数
  this.identifierPrefix = identifierPrefix;
  this.onRecoverableError = onRecoverableError;

  // 如果启用了缓存功能
  if (enableCache) {
    this.pooledCache = null; // 缓存池
    this.pooledCacheLanes = NoLanes; // 缓存池车道
  }

  // 如果支持水合功能
  if (supportsHydration) {
    this.mutableSourceEagerHydrationData = null; // 可变源急切水合数据
  }

  // 如果启用了Suspense回调功能
  if (enableSuspenseCallback) {
    this.hydrationCallbacks = null; // 水合回调
  }

  // 如果启用了过渡跟踪功能
  if (enableTransitionTracing) {
    this.transitionCallbacks = null; // 过渡回调
    const transitionLanesMap = (this.transitionLanes = []); // 过渡车道映射
    for (let i = 0; i < TotalLanes; i++) { // 初始化过渡车道数组
      transitionLanesMap.push(null);
    }
  }

  // 如果启用了分析器计时器和提交钩子
  if (enableProfilerTimer && enableProfilerCommitHooks) {
    this.effectDuration = 0; // 效果持续时间
    this.passiveEffectDuration = 0; // 被动效果持续时间
  }

  // 如果启用了更新器跟踪
  if (enableUpdaterTracking) {
    this.memoizedUpdaters = new Set(); // 记住的更新器集合
    const pendingUpdatersLaneMap = (this.pendingUpdatersLaneMap = []); // 待处理更新器车道映射
    for (let i = 0; i < TotalLanes; i++) { // 为每个车道创建一个空的更新器集
      pendingUpdatersLaneMap.push(new Set());
    }
  }

  // 在开发环境下
  if (__DEV__) {
    switch (tag) { // 根据标签类型设置调试根类型
      case ConcurrentRoot: // 并发根
        this._debugRootType = hydrate ? 'hydrateRoot()' : 'createRoot()'; // 设置调试根类型
        break;
      case LegacyRoot: // 传统根
        this._debugRootType = hydrate ? 'hydrate()' : 'render()'; // 设置调试根类型
        break;
    }
  }
}

// 创建fiber根节点函数
export function createFiberRoot(
  containerInfo: any, // 容器信息
  tag: RootTag, // 根标签类型
  hydrate: boolean, // 是否水合
  initialChildren: ReactNodeList, // 初始子节点
  hydrationCallbacks: null | SuspenseHydrationCallbacks, // 水合回调
  isStrictMode: boolean, // 是否严格模式
  concurrentUpdatesByDefaultOverride: null | boolean, // 并发更新默认覆盖
  // TODO: 我们有几个在概念上属于宿主配置的参数，
  // 但由于它们是在运行时传递的，我们必须通过根构造函数传递它们。
  // 也许我们应该将它们全部放入一个单一类型中，
  // 比如由渲染器定义的DynamicHostConfig。
  identifierPrefix: string, // 标识符前缀
  onRecoverableError: null | ((error: mixed) => void), // 可恢复错误处理函数
  transitionCallbacks: null | TransitionTracingCallbacks, // 过渡回调
): FiberRoot {
  // 创建新的FiberRootNode实例
  const root: FiberRoot = (new FiberRootNode(
    containerInfo,
    tag,
    hydrate,
    identifierPrefix,
    onRecoverableError,
  ): any);
  
  // 如果启用了Suspense回调功能，设置水合回调
  if (enableSuspenseCallback) {
    root.hydrationCallbacks = hydrationCallbacks;
  }

  // 如果启用了过渡跟踪功能，设置过渡回调
  if (enableTransitionTracing) {
    root.transitionCallbacks = transitionCallbacks;
  }

  // 循环构造。这目前欺骗了类型系统，因为stateNode是any类型。
  // 创建宿主根fiber
  const uninitializedFiber = createHostRootFiber(
    tag, // 标签类型
    isStrictMode, // 是否严格模式
    concurrentUpdatesByDefaultOverride, // 并发更新默认覆盖
  );
  root.current = uninitializedFiber; // 设置根的当前fiber
  uninitializedFiber.stateNode = root; // 设置fiber的状态节点为根

  // 如果启用了缓存功能
  if (enableCache) {
    const initialCache = createCache(); // 创建初始缓存
    retainCache(initialCache); // 保留初始缓存

    // pooledCache是一个临时用于渲染期间新挂载边界的全新缓存实例。
    // 通常，在渲染结束时，pooledCache总是从根中清除：
    // 渲染提交时释放，或者渲染暂停时移动到Offscreen组件。
    // 由于pooled cache的生命周期与main memoizedState.cache不同，
    // 必须单独保留。
    root.pooledCache = initialCache; // 设置根的缓存池
    retainCache(initialCache); // 保留缓存
    // 创建初始状态
    const initialState: RootState = {
      element: initialChildren, // 初始子元素
      isDehydrated: hydrate, // 是否脱水状态
      cache: initialCache, // 初始缓存
      transitions: null, // 过渡集合
      pendingSuspenseBoundaries: null, // 待处理Suspense边界
    };
    uninitializedFiber.memoizedState = initialState; // 设置fiber的记忆化状态
  } else { // 如果未启用缓存
    const initialState: RootState = {
      element: initialChildren, // 初始子元素
      isDehydrated: hydrate, // 是否脱水状态
      cache: (null: any), // 缓存（尚未启用）
      transitions: null, // 过渡集合
      pendingSuspenseBoundaries: null, // 待处理Suspense边界
    };
    uninitializedFiber.memoizedState = initialState; // 设置fiber的记忆化状态
  }

  initializeUpdateQueue(uninitializedFiber); // 初始化更新队列

  return root; // 返回创建的根节点
}