/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// 导入各种类型定义
import type {Source} from 'shared/ReactElementType'; // 来源信息类型，包含文件路径和行号
import type {
  RefObject, // 引用对象类型
  ReactContext, // React 上下文类型
  MutableSourceSubscribeFn, // 可变源订阅函数类型
  MutableSourceGetSnapshotFn, // 可变源获取快照函数类型
  MutableSourceVersion, // 可变源版本类型
  MutableSource, // 可变源类型
  StartTransitionOptions, // 开始过渡选项类型
  Wakeable, // 可唤醒类型
} from 'shared/ReactTypes'; // 从共享的 React 类型模块导入
import type {SuspenseInstance} from './ReactFiberHostConfig'; // Suspense 实例类型
import type {WorkTag} from './ReactWorkTags'; // 工作标签类型，标识 Fiber 的类型
import type {TypeOfMode} from './ReactTypeOfMode'; // 模式类型，表示渲染模式
import type {Flags} from './ReactFiberFlags'; // 标志位类型，描述 Fiber 或其子树的属性
import type {Lane, Lanes, LaneMap} from './ReactFiberLane.old'; // 车道类型，用于优先级调度
import type {RootTag} from './ReactRootTags'; // 根节点标签类型，标识根节点类型
import type {TimeoutHandle, NoTimeout} from './ReactFiberHostConfig'; // 超时句柄类型
import type {Cache} from './ReactFiberCacheComponent.old'; // 缓存类型
import type {Transition} from './ReactFiberTracingMarkerComponent.new'; // 过渡类型
import type {ConcurrentUpdate} from './ReactFiberConcurrentUpdates.new'; // 并发更新类型

// 解决循环引用：从 ReactFiberHooks.old 移过来的
export type HookType =
  | 'useState' // React state 钩子
  | 'useReducer' // React reducer 钩子
  | 'useContext' // React context 钩子
  | 'useRef' // React ref 钩子
  | 'useEffect' // React effect 钩子
  | 'useInsertionEffect' // React 插入 effect 钩子
  | 'useLayoutEffect' // React 布局 effect 钩子
  | 'useCallback' // React 回调缓存钩子
  | 'useMemo' // React 记忆化值钩子
  | 'useImperativeHandle' // React 命令式句柄钩子
  | 'useDebugValue' // React 调试值钩子
  | 'useDeferredValue' // React 延迟值钩子
  | 'useTransition' // React 过渡钩子
  | 'useMutableSource' // React 可变源钩子
  | 'useSyncExternalStore' // React 同步外部存储钩子
  | 'useId' // React ID 钩子
  | 'useCacheRefresh'; // React 缓存刷新钩子

// Context 依赖项类型定义
export type ContextDependency<T> = {
  context: ReactContext<T>, // 依赖的上下文
  next: ContextDependency<mixed> | null, // 下一个依赖项，形成链表
  memoizedValue: T, // 记忆化的上下文值
  ...
};

// 依赖集合类型定义
export type Dependencies = {
  lanes: Lanes, // 通道/车道
  firstContext: ContextDependency<mixed> | null, // 第一个上下文依赖项
  ...
};

// Fiber 是对组件需要完成的工作或已完成工作的抽象。每个组件可以有一个或多个 Fiber。
export type Fiber = {|
  // 以下字段概念上属于 Instance 的成员。以前是分成单独类型并与其他 Fiber 字段相交，
  // 但由于 Flow 存在交叉类型的问题，我们把它们合并到了一个单一类型中。

  // 一个 Instance 在组件的所有版本之间共享。我们可以轻松将其拆分为单独的对象，
  // 以避免复制过多数据到树的交替版本中。目前为了减少初始渲染期间创建的对象数量，
  // 我们将其放在了单个对象上。

  // 标记fiber的类型，即组件类型（如原生标签、函数组件、类组件、Fragment等）。这里参考ReactWorkTags.js
  // 标识 Fiber 类型的标签
  tag: WorkTag,

  // 组件在当前层级下的唯一标识
  // 协调阶段使用key区分组件。复用组件满足三大要素：同一层级、相同类型、相同的key值
  // 此子节点的唯一标识符
  key: null | string,

  // element.type 的值，用于在协调此子节点时保持身份
  // 等同于下面的type
  elementType: any,

  // 标记组件类型，原生组件是字符串，函数组件是函数名/函数引用，类组件是类名/类引用
  // 与此 Fiber 关联的解析后的函数/类等
  type: any,

  // 原生标签是DOM；类组件是实例；函数组件是null
  // 与此 Fiber 相关联的本地状态
  stateNode: any,

  // 概念上的别名
  // parent : Instance -> return 父节点恰好与 return Fiber 相同，因为我们已经合并了 Fiber 和 Instance。

  // 剩余字段属于 Fiber

  // 完成处理此 Fiber 后要返回的 Fiber
  // 这实际上就是父节点，但由于可能存在多个父节点（两个），
  // 所以这仅是我们当前正在处理的节点的父节点。
  // 概念上与堆栈帧的返回地址相同。
  // 父fiber
  return: Fiber | null,

  // 单链表树结构
  child: Fiber | null, // 第一个子fiber，子节点
  sibling: Fiber | null, // 下一个兄弟fiber，兄弟节点
  index: number, // 索引，记录了fiber在当前层级中的位置下标，用于diff时候判断节点是否移动了

  // 最后用于附加此节点的 ref
  // 我会避免为生产环境添加 owner 字段并将其建模为函数
  ref:
    | null
    | (((handle: mixed) => void) & {_stringRef: ?string, ...})
    | RefObject,

  // 输入是进入此 Fiber 的数据。参数。属性。
  pendingProps: any, // 新的props。此类型在重载标签后将更具体
  memoizedProps: any, // 上一次渲染时使用的props。用于创建输出的 props

  // 队列，存储updates与callbacks，比如createRoot(root).render或者setState的更新
  // 状态更新和回调队列
  updateQueue: mixed,

  // 函数组件是第一个hook（hook单链表的头节点）；类组件是state
  // 用于创建输出的状态
  memoizedState: any,

  // 此 Fiber 的依赖项（上下文、事件），如果有的话
  dependencies: Dependencies | null,

  // 描述 Fiber 及其子树属性的位域。例如，
  // ConcurrentMode 标志表示子树是否默认为异步。
  // 当创建 Fiber 时，它继承父节点的模式。
  // 可以在创建时设置其他标志，但在那之后，该值应在其生命周期内保持不变，
  // 特别是在其子 Fiber 创建之前。
  mode: TypeOfMode,

  // 效果
  flags: Flags, // 初次渲染，新增插入是Placement；更新时是Update。当前 Fiber 的标志
  subtreeFlags: Flags, // 子节点的flags。子树的标志
  deletions: Array<Fiber> | null, // 记录要删除的子节点。删除的 Fiber 数组

  // 指向下一个有副作用的 Fiber 的单链表快捷路径
  nextEffect: Fiber | null,

  // 此子树中第一个和最后一个有副作用的 Fiber。这允许我们在重用在此 Fiber 中完成的工作时重用链接列表的片段
  firstEffect: Fiber | null, // 第一个有副作用的 Fiber
  lastEffect: Fiber | null, // 最后一个有副作用的 Fiber

  lanes: Lanes, // 当前 Fiber 的车道
  childLanes: Lanes, // 子节点的车道

  // 用于存储更新前的fiber
  // 这是 Fiber 的池化版本。每个被更新的 Fiber 最终都会有一对。
  // 在某些情况下，我们可以清理配对以节省内存。
  alternate: Fiber | null,

  // 当前更新对这个 Fiber 及其后代进行渲染所花费的时间
  // 这告诉我们树如何很好地利用 sCU 进行记忆化
  // 每次我们渲染时它都被重置为 0，并且只在我们不退出时更新
  // 仅当启用 enableProfilerTimer 标志时才设置此字段
  actualDuration?: number,

  // 如果 Fiber 当前在 "render" 阶段处于活动状态，
  // 这标记了工作开始的时间
  // 仅当启用 enableProfilerTimer 标志时才设置此字段
  actualStartTime?: number,

  // 此 Fiber 最近一次渲染时间的持续时间
  // 当我们为了记忆化目的而退出时，此值不会更新
  // 仅当启用 enableProfilerTimer 标志时才设置此字段
  selfBaseDuration?: number,

  // 此 Fiber 的所有后代的基本时间总和
  // 此值在 "complete" 阶段向上冒泡
  // 仅当启用 enableProfilerTimer 标志时才设置此字段
  treeBaseDuration?: number,

  // 概念上的别名
  // workInProgress : Fiber ->  alternate 用于重用的备用恰好与正在进行的工作相同
  // __DEV__ only

  _debugSource?: Source | null, // 调试源信息
  _debugOwner?: Fiber | null, // 调试拥有者信息
  _debugIsCurrentlyTiming?: boolean, // 是否当前正在计时
  _debugNeedsRemount?: boolean, // 是否需要重新挂载

  // 用于验证钩子顺序在渲染之间是否发生变化
  _debugHookTypes?: Array<HookType> | null, // 调试钩子类型数组
|};

// 基础 Fiber 根节点属性类型定义
type BaseFiberRootProperties = {|
  // 根节点的类型（传统、批处理、并发等）
  tag: RootTag,

  // 与此根节点关联的宿主提供的任何附加信息
  containerInfo: any,
  // 仅由持久更新使用
  pendingChildren: any,
  // 当前活动的根 Fiber。这是树的可变根
  current: Fiber,

  // 可唤醒对象的弱映射缓存，用于处理 Promise
  pingCache: WeakMap<Wakeable, Set<mixed>> | Map<Wakeable, Set<mixed>> | null,

  // 已完成的待提交的工作进行中的 HostRoot
  finishedWork: Fiber | null,
  // 由 setTimeout 返回的超时句柄。用于取消待处理的超时，
  // 如果它被新的超时取代
  timeoutHandle: TimeoutHandle | NoTimeout,
  // 顶层上下文对象，由 renderSubtreeIntoContainer 使用
  context: Object | null,
  pendingContext: Object | null,

  // 由 useMutableSource 钩子使用，以避免在水合过程中撕裂
  mutableSourceEagerHydrationData?: Array<
    MutableSource<any> | MutableSourceVersion,
  > | null,

  // 由 Scheduler.scheduleCallback 返回的节点。代表根将要处理的下一个渲染任务
  callbackNode: *,
  callbackPriority: Lane, // 回调优先级
  eventTimes: LaneMap<number>, // 事件时间映射
  expirationTimes: LaneMap<number>, // 过期时间映射
  hiddenUpdates: LaneMap<Array<ConcurrentUpdate> | null>, // 隐藏更新映射

  pendingLanes: Lanes, // 待处理通道
  suspendedLanes: Lanes, // 挂起通道
  pingedLanes: Lanes, // pinged 通道
  expiredLanes: Lanes, // 过期通道
  mutableReadLanes: Lanes, // 可变读取通道

  finishedLanes: Lanes, // 完成通道

  entangledLanes: Lanes, // 纠缠通道
  entanglements: LaneMap<Lanes>, // 纠缠映射

  pooledCache: Cache | null, // 缓存池
  pooledCacheLanes: Lanes, // 缓存池通道

  // TODO: 在 Fizz 中，ID 生成对于每个服务器配置都是特定的。也许我们也应该
  // 在 Fiber 中这样做？推迟这个决定，因为除了公共 createRoot 对象上的内部字段外，
  // 没有其他地方可以存储前缀，而 fiber 树目前没有对该对象的引用
  identifierPrefix: string, // 标识符前缀

  // 可恢复错误处理函数
  onRecoverableError: (
    error: mixed,
    errorInfo: {digest?: ?string, componentStack?: ?string}, // 错误信息：摘要和组件堆栈
  ) => void,
|};

// 以下属性仅由 DevTools 使用，且仅存在于 DEV 构建中
// 它们使 DevTools Profiler UI 能够显示哪些 Fiber 计划了给定提交
type UpdaterTrackingOnlyFiberRootProperties = {|
  memoizedUpdaters: Set<Fiber>, // 记住的更新器集合
  pendingUpdatersLaneMap: LaneMap<Set<Fiber>>, // 待处理更新器通道映射
|};

// Suspense 水合回调类型定义
export type SuspenseHydrationCallbacks = {
  onHydrated?: (suspenseInstance: SuspenseInstance) => void, // 水合完成回调
  onDeleted?: (suspenseInstance: SuspenseInstance) => void, // 删除回调
  ...
};

// 以下字段仅由 enableSuspenseCallback 用于水合
type SuspenseCallbackOnlyFiberRootProperties = {|
  hydrationCallbacks: null | SuspenseHydrationCallbacks, // 水合回调
|};

// 过渡跟踪回调类型定义
export type TransitionTracingCallbacks = {
  onTransitionStart?: (transitionName: string, startTime: number) => void, // 过渡开始回调
  onTransitionProgress?: (
    transitionName: string,
    startTime: number,
    currentTime: number,
    pending: Array<{name: null | string}>, // 待处理的过渡名称数组
  ) => void, // 过渡进展回调
  onTransitionIncomplete?: (
    transitionName: string,
    startTime: number,
    deletions: Array<{
      type: string,
      name?: string,
      newName?: string,
      endTime: number,
    }>, // 删除的过渡详情
  ) => void, // 过渡未完成回调
  onTransitionComplete?: (
    transitionName: string,
    startTime: number,
    endTime: number,
  ) => void, // 过渡完成回调
  onMarkerProgress?: (
    transitionName: string,
    marker: string,
    startTime: number,
    currentTime: number,
    pending: Array<{name: null | string}>,
  ) => void, // 标记进展回调
  onMarkerIncomplete?: (
    transitionName: string,
    marker: string,
    startTime: number,
    deletions: Array<{
      type: string,
      name?: string,
      newName?: string,
      endTime: number,
    }>, // 标记删除详情
  ) => void, // 标记未完成回调
  onMarkerComplete?: (
    transitionName: string,
    marker: string,
    startTime: number,
    endTime: number,
  ) => void, // 标记完成回调
};

// 以下字段仅在 Profile 构建中的过渡跟踪中使用
type TransitionTracingOnlyFiberRootProperties = {|
  transitionCallbacks: null | TransitionTracingCallbacks, // 过渡回调
  transitionLanes: Array<Array<Transition> | null>, // 过渡通道
|};

// 导出的 FiberRoot 类型包括所有属性，
// 以避免在整个项目中需要潜在的易错的 :any 类型转换。
// 类型在此文件中分别定义，以确保它们保持同步。
export type FiberRoot = {
  ...BaseFiberRootProperties,
  ...SuspenseCallbackOnlyFiberRootProperties,
  ...UpdaterTrackingOnlyFiberRootProperties,
  ...TransitionTracingOnlyFiberRootProperties,
  ...
};

// 基本状态操作类型，接受状态或返回状态的函数
type BasicStateAction<S> = (S => S) | S;
// 派发类型，接受动作并返回无
type Dispatch<A> = A => void;

// React 钩子调度器类型定义
export type Dispatcher = {|
  getCacheSignal?: () => AbortSignal, // 获取缓存信号
  getCacheForType?: <T>(resourceType: () => T) => T, // 获取指定类型的缓存
  readContext<T>(context: ReactContext<T>): T, // 读取上下文值
  useState<S>(initialState: (() => S) | S): [S, Dispatch<BasicStateAction<S>>], // 状态钩子
  useReducer<S, I, A>(
    reducer: (S, A) => S, // reducer 函数
    initialArg: I, // 初始参数
    init?: (I) => S, // 初始化函数
  ): [S, Dispatch<A>], // reducer 钩子
  useContext<T>(context: ReactContext<T>): T, // 上下文钩子
  useRef<T>(initialValue: T): {|current: T|}, // 引用钩子
  useEffect(
    create: () => (() => void) | void, // 创建效果函数
    deps: Array<mixed> | void | null, // 依赖数组
  ): void, // 副作用钩子
  useInsertionEffect(
    create: () => (() => void) | void, // 创建插入效果函数
    deps: Array<mixed> | void | null, // 依赖数组
  ): void, // 插入效果钩子
  useLayoutEffect(
    create: () => (() => void) | void, // 创建布局效果函数
    deps: Array<mixed> | void | null, // 依赖数组
  ): void, // 布局效果钩子
  useCallback<T>(callback: T, deps: Array<mixed> | void | null): T, // 回调记忆化钩子
  useMemo<T>(nextCreate: () => T, deps: Array<mixed> | void | null): T, // 记忆化值钩子
  useImperativeHandle<T>(
    ref: {|current: T | null|} | ((inst: T | null) => mixed) | null | void, // 引用
    create: () => T, // 创建函数
    deps: Array<mixed> | void | null, // 依赖数组
  ): void, // 命令式句柄钩子
  useDebugValue<T>(value: T, formatterFn: ?(value: T) => mixed): void, // 调试值钩子
  useDeferredValue<T>(value: T): T, // 延迟值钩子
  useTransition(): [
    boolean, // 是否在过渡中
    (callback: () => void, options?: StartTransitionOptions) => void, // 开始过渡函数
  ], // 过渡钩子
  useMutableSource<Source, Snapshot>(
    source: MutableSource<Source>, // 可变源
    getSnapshot: MutableSourceGetSnapshotFn<Source, Snapshot>, // 获取快照函数
    subscribe: MutableSourceSubscribeFn<Source, Snapshot>, // 订阅函数
  ): Snapshot, // 可变源钩子
  useSyncExternalStore<T>(
    subscribe: (() => void) => () => void, // 订阅函数
    getSnapshot: () => T, // 获取快照函数
    getServerSnapshot?: () => T, // 获取服务端快照函数
  ): T, // 同步外部存储钩子
  useId(): string, // ID 钩子
  useCacheRefresh?: () => <T>(?() => T, ?T) => void, // 缓存刷新钩子

  unstable_isNewReconciler?: boolean, // 不稳定的：新协调器标识
|};
