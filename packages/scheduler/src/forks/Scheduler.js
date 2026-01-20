/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* eslint-disable no-var */

// 导入调度器特性标志，控制各种功能开关
import {
  enableSchedulerDebugging,  // 是否启用调度器调试
  enableProfiling,           // 是否启用性能分析
  enableIsInputPending,      // 是否启用 isInputPending API
  enableIsInputPendingContinuous, // 是否对连续输入启用 isInputPending
  frameYieldMs,              // 每帧让出时间的毫秒数
  continuousYieldMs,         // 连续输入让出时间的毫秒数
  maxYieldMs,                // 最大让出时间的毫秒数
} from '../SchedulerFeatureFlags';

// 导入最小堆操作函数，用于维护任务队列
import {push, pop, peek} from '../SchedulerMinHeap';

// 导入优先级常量定义
import {
  ImmediatePriority,     // 立即执行优先级
  UserBlockingPriority,  // 用户阻断优先级
  NormalPriority,        // 正常优先级
  LowPriority,           // 低优先级
  IdlePriority,          // 空闲优先级
} from '../SchedulerPriorities';

// 导入性能分析相关函数
import {
  markTaskRun,              // 标记任务开始运行
  markTaskYield,            // 标记任务让出执行
  markTaskCompleted,        // 标记任务完成
  markTaskCanceled,         // 标记任务取消
  markTaskErrored,          // 标记任务出错
  markSchedulerSuspended,   // 标记调度器暂停
  markSchedulerUnsuspended, // 标记调度器恢复
  markTaskStart,            // 标记任务开始
  stopLoggingProfilingEvents, // 停止记录性能分析事件
  startLoggingProfilingEvents, // 开始记录性能分析事件
} from '../SchedulerProfiling';

// 获取当前时间的函数，优先使用 performance.now()，否则使用 Date.now()
let getCurrentTime;
// 检查是否存在 performance 对象和 performance.now 方法
const hasPerformanceNow =
  typeof performance === 'object' && typeof performance.now === 'function';

if (hasPerformanceNow) {
  // 使用本地 performance 对象，避免被 polyfill 覆盖
  const localPerformance = performance;
  // 返回当前时间
  getCurrentTime = () => localPerformance.now();
} else {
  // 使用 Date 对象，计算相对于初始时间的差值
  const localDate = Date;
  const initialTime = localDate.now();
  // 返回当前时间减去初始时间
  getCurrentTime = () => localDate.now() - initialTime;
}

// 最大的 31 位有符号整数，V8 中 32 位系统的最大整数大小
// Math.pow(2, 30) - 1
// 0b111111111111111111111111111111
var maxSigned31BitInt = 1073741823;

// 立即超时的优先级值
var IMMEDIATE_PRIORITY_TIMEOUT = -1;
// 最终会超时的优先级值
var USER_BLOCKING_PRIORITY_TIMEOUT = 250; // 250ms 后超时
var NORMAL_PRIORITY_TIMEOUT = 5000;        // 5s 后超时
var LOW_PRIORITY_TIMEOUT = 10000;          // 10s 后超时
// 永不过期的优先级值
var IDLE_PRIORITY_TIMEOUT = maxSigned31BitInt;

// 任务存储在最小堆中，包含两种队列
var taskQueue = [];   // 存储待执行的任务，按过期时间排序
var timerQueue = [];  // 存储延迟任务，按开始时间排序

// 递增的任务 ID 计数器，用于保持插入顺序
var taskIdCounter = 1;

// 暂停调度器对调试很有用
var isSchedulerPaused = false;

// 当前正在执行的任务
var currentTask = null;
// 当前优先级级别（正在执行的任务）
var currentPriorityLevel = NormalPriority;

// 执行工作时设置此标志，防止重新进入
var isPerformingWork = false;

// 主线程是否在调度（主机回调是否已调度）
var isHostCallbackScheduled = false;
// 主机超时是否已调度
var isHostTimeoutScheduled = false;

// 捕获本地对原生 API 的引用，以防 polyfill 覆盖它们
const localSetTimeout = typeof setTimeout === 'function' ? setTimeout : null;
const localClearTimeout =
  typeof clearTimeout === 'function' ? clearTimeout : null;
const localSetImmediate =
  typeof setImmediate !== 'undefined' ? setImmediate : null; // IE 和 Node.js + jsdom

// 获取浏览器的 isInputPending API，用于检测是否有待处理的用户输入
const isInputPending =
  typeof navigator !== 'undefined' &&
  navigator.scheduling !== undefined &&
  navigator.scheduling.isInputPending !== undefined
    ? navigator.scheduling.isInputPending.bind(navigator.scheduling)
    : null;

// 传递给 isInputPending 的选项，包括连续输入
const continuousOptions = {includeContinuous: enableIsInputPendingContinuous};

// 推进计时器，检查不再延迟的任务并将它们添加到队列
function advanceTimers(currentTime) {
  // 检查计时器队列中已到期的任务，并将它们转移到任务队列
  let timer = peek(timerQueue);  // 查看计时器队列的第一个元素
  while (timer !== null) {       // 循环处理计时器队列中的所有任务
    if (timer.callback === null) {
      // 计时器已被取消
      pop(timerQueue);
    } else if (timer.startTime <= currentTime) {
      // 计时器已触发，转移到任务队列
      pop(timerQueue);
      timer.sortIndex = timer.expirationTime; // 设置排序索引为过期时间
      push(taskQueue, timer);                 // 添加到任务队列
      if (enableProfiling) {
        markTaskStart(timer, currentTime); // 标记任务开始
        timer.isQueued = true;             // 标记任务已在队列中
      }
    } else {
      // 剩余计时器仍在等待
      return;
    }
    timer = peek(timerQueue);  // 查看下一个计时器
  }
}

// 处理超时的函数
function handleTimeout(currentTime) {
  isHostTimeoutScheduled = false;  // 清除主机超时计划标记
  advanceTimers(currentTime);      // 推进计时器

  if (!isHostCallbackScheduled) {  // 如果没有主机回调被调度
    if (peek(taskQueue) !== null) {  // 如果任务队列不为空
      isHostCallbackScheduled = true; // 标记主机回调已调度
      requestHostCallback(flushWork); // 请求主机回调执行 flushWork
    } else {  // 任务队列为空
      const firstTimer = peek(timerQueue); // 获取计时器队列中的第一个任务
      if (firstTimer !== null) {  // 如果存在延迟任务
        // 请求主机超时，等待第一个延迟任务开始
        requestHostTimeout(handleTimeout, firstTimer.startTime - currentTime);
      }
    }
  }
}

/**
 * 刷新工作的主函数
 * @param {*} hasTimeRemaining
 * @param {*} initialTime
 * @returns workLoop的返回值：true：currentTask !== null，仍有工作要做；false：没有更多工作
 */
function flushWork(hasTimeRemaining, initialTime) {
  if (enableProfiling) {
    markSchedulerUnsuspended(initialTime); // 标记调度器恢复
  }

  // 下次调度工作时需要主机回调
  isHostCallbackScheduled = false;
  if (isHostTimeoutScheduled) {
    // 我们计划了一个超时，但它不再需要了，取消它
    isHostTimeoutScheduled = false;
    cancelHostTimeout();
  }

  isPerformingWork = true;  // 标记正在进行工作
  const previousPriorityLevel = currentPriorityLevel; // 保存之前的优先级
  try {
    if (enableProfiling) {
      try {
        return workLoop(hasTimeRemaining, initialTime); // 执行工作循环
      } catch (error) {
        if (currentTask !== null) {
          const currentTime = getCurrentTime();
          markTaskErrored(currentTask, currentTime);  // 标记任务错误
          currentTask.isQueued = false;
        }
        throw error;
      }
    } else {
      // 生产环境中不捕获异常
      return workLoop(hasTimeRemaining, initialTime);
    }
  } finally {
    currentTask = null;  // 清除当前任务
    currentPriorityLevel = previousPriorityLevel; // 恢复之前的优先级
    isPerformingWork = false;  // 标记工作完成
    if (enableProfiling) {
      const currentTime = getCurrentTime();
      markSchedulerSuspended(currentTime);  // 标记调度器暂停
    }
  }
}


/**
 * 实际的工作循环
 * @param {*} hasTimeRemaining
 * @param {*} initialTime
 * @returns true：currentTask !== null，仍有工作要做；false：没有更多工作
 */
function workLoop(hasTimeRemaining, initialTime) {
  let currentTime = initialTime;  // 当前时间
  advanceTimers(currentTime);     // 推进计时器
  currentTask = peek(taskQueue);  // 获取任务队列中的第一个任务
  while (
    currentTask !== null &&       // 当前任务不为空
    !(enableSchedulerDebugging && isSchedulerPaused)  // 不处于调试暂停状态
  ) {
    // 检查是否需要让出主线程的控制权（控制权给浏览器）
    if (
      currentTask.expirationTime > currentTime &&  // 当前任务未过期
      (!hasTimeRemaining || shouldYieldToHost())   // 没有剩余时间或应该让出给主机
    ) {
      // 当前任务未过期，且（没有剩余时间或应该让出给主机），跳出循环
      break;
    }

    const callback = currentTask.callback;  // 获取任务回调函数
    // 执行任务的回调，或弹出任务
    if (typeof callback === 'function') {   // 如果任务的回调函数存在
      currentTask.callback = null;          // 清空任务回调，防止重复执行
      currentPriorityLevel = currentTask.priorityLevel;  // 设置当前优先级为任务优先级
      const didUserCallbackTimeout = currentTask.expirationTime <= currentTime;  // 检查任务是否已过期

      if (enableProfiling) {
        markTaskRun(currentTask, currentTime);  // 标记任务运行
      }

      const continuationCallback = callback(didUserCallbackTimeout);  // 执行任务的回调
      currentTime = getCurrentTime();  // 更新当前时间

      // 任务还没完成
      if (typeof continuationCallback === 'function') {  // 如果返回了延续回调，任务还没完成
        currentTask.callback = continuationCallback;     // 将延续回调保存到任务，continuationCallback由scheduler的使用者（外部使用者）控制
        if (enableProfiling) {
          markTaskYield(currentTask, currentTime);  // 标记任务让出
        }
      } else {  // 任务完成
        if (enableProfiling) {
          markTaskCompleted(currentTask, currentTime);  // 标记任务完成
          currentTask.isQueued = false;                 // 标记任务不在队列中
        }
        if (currentTask === peek(taskQueue)) {  // 如果当前任务仍是队列中的第一个
          pop(taskQueue);  // 从队列中弹出任务
        }
      }

      advanceTimers(currentTime);  // 推进计时器
    } else {  // 任务的回调函数不存在
      pop(taskQueue);  // 弹出任务
    }
    // 获取下一个任务，继续下一个循环
    currentTask = peek(taskQueue);
  }

  // 任务队列taskQueue中是否还有任务未完成
  if (currentTask !== null) {
    return true;  // 还有任务未完成，返回true
  } else {// taskQueue中，没有任务了
    // 处理计时器队列timerQueue中的任务
    const firstTimer = peek(timerQueue);  // 获取计时器队列timerQueue中的第一个任务
    if (firstTimer !== null) {  // 如果存在延迟任务
      // 请求主机超时，等待第一个延迟任务开始
      requestHostTimeout(handleTimeout, firstTimer.startTime - currentTime);
    }
    return false;
  }
}

// 以特定优先级运行事件处理器
function unstable_runWithPriority(priorityLevel, eventHandler) {
  // 验证优先级级别
  switch (priorityLevel) {
    case ImmediatePriority:
    case UserBlockingPriority:
    case NormalPriority:
    case LowPriority:
    case IdlePriority:
      break;
    default:
      priorityLevel = NormalPriority;  // 默认为正常优先级
  }

  var previousPriorityLevel = currentPriorityLevel;  // 保存之前的优先级
  currentPriorityLevel = priorityLevel;              // 设置当前优先级

  try {
    return eventHandler();  // 执行事件处理器
  } finally {
    currentPriorityLevel = previousPriorityLevel;  // 恢复之前的优先级
  }
}

// 以比当前优先级更低的级别运行事件处理器
function unstable_next(eventHandler) {
  var priorityLevel;
  switch (currentPriorityLevel) {
    case ImmediatePriority:
    case UserBlockingPriority:
    case NormalPriority:
      // 降级到正常优先级
      priorityLevel = NormalPriority;
      break;
    default:
      // 低于正常优先级的应保持在当前级别
      priorityLevel = currentPriorityLevel;
      break;
  }

  var previousPriorityLevel = currentPriorityLevel;  // 保存之前的优先级
  currentPriorityLevel = priorityLevel;              // 设置当前优先级

  try {
    return eventHandler();  // 执行事件处理器
  } finally {
    currentPriorityLevel = previousPriorityLevel;  // 恢复之前的优先级
  }
}

// 包装回调函数，使其运行在特定优先级
function unstable_wrapCallback(callback) {
  var parentPriorityLevel = currentPriorityLevel;  // 保存父级优先级
  return function() {
    // 这是 runWithPriority 的分支，为了性能而内联
    var previousPriorityLevel = currentPriorityLevel;  // 保存当前优先级
    currentPriorityLevel = parentPriorityLevel;        // 设置为父级优先级

    try {
      return callback.apply(this, arguments);  // 执行回调
    } finally {
      currentPriorityLevel = previousPriorityLevel;  // 恢复之前的优先级
    }
  };
}

/*
主要对外接口函数，任务调度器与外界交互的核心函数

安排、调度一个回调函数：
  创建一个新任务：
    处理任务开始时间（不是执行时间）：
      处理延迟选项
    计算任务的过期时间（设置任务的排序索引为过期时间，最小二叉堆排序使用）：

    将回调函数封装成任务
    优先级：根据传递的参数priorityLevel

  将新任务添加到适当的队列中：
    如果是延迟任务，放入 timerQueue；
    否则，是一个立即执行的任务，放入 taskQueue，安排执行任务。

*/
function unstable_scheduleCallback(priorityLevel, callback, options) {
  var currentTime = getCurrentTime();  // 获取当前时间

  var startTime;  // 任务开始时间，不是执行时间
  // 处理延迟选项
  if (typeof options === 'object' && options !== null) {
    var delay = options.delay;  // 获取延迟时间
    if (typeof delay === 'number' && delay > 0) {
      startTime = currentTime + delay;  // 计算延迟任务的开始时间
    } else {
      startTime = currentTime;  // 立即开始
    }
  } else {
    startTime = currentTime;  // 立即开始
  }

  // 根据优先级设置超时时间
  var timeout;  // 超时时间
  switch (priorityLevel) {
    case ImmediatePriority:
      timeout = IMMEDIATE_PRIORITY_TIMEOUT;  // 立即执行
      break;
    case UserBlockingPriority:
      timeout = USER_BLOCKING_PRIORITY_TIMEOUT;  // 用户阻断
      break;
    case IdlePriority:
      timeout = IDLE_PRIORITY_TIMEOUT;  // 空闲
      break;
    case LowPriority:
      timeout = LOW_PRIORITY_TIMEOUT;  // 低优先级
      break;
    case NormalPriority:
    default:
      timeout = NORMAL_PRIORITY_TIMEOUT;  // 正常优先级
      break;
  }

  // 计算任务的过期时间（设置任务的排序索引为过期时间，最小二叉堆排序使用）
  var expirationTime = startTime + timeout;

  // 创建新任务对象，构建任务对象
  var newTask = {
    id: taskIdCounter++,     // 任务ID，自增
    callback,               // 回调函数
    priorityLevel,          // 优先级
    startTime,              // 开始时间
    expirationTime,         // 过期时间
    sortIndex: -1,         // 排序索引
  };
  if (enableProfiling) {
    newTask.isQueued = false;  // 标记任务不在队列中
  }

  // 如果是延迟任务，放入 timerQueue；否则放入 taskQueue
  if (startTime > currentTime) {
    // 这是一个延迟任务
    newTask.sortIndex = startTime;  // 设置排序索引为开始时间
    push(timerQueue, newTask);      // 添加到计时器队列
    if (peek(taskQueue) === null && newTask === peek(timerQueue)) {
      // 所有任务都被延迟，且这是最早延迟的任务
      if (isHostTimeoutScheduled) {
        // 取消现有超时
        cancelHostTimeout();
      } else {
        isHostTimeoutScheduled = true;
      }
      // 计划一个超时
      requestHostTimeout(handleTimeout, startTime - currentTime);
    }
  } else {
    // 这是一个立即执行的任务，放入 taskQueue
    newTask.sortIndex = expirationTime;  // 设置排序索引为过期时间
    push(taskQueue, newTask);            // 添加到任务队列
    if (enableProfiling) {
      markTaskStart(newTask, currentTime);  // 标记任务开始
      newTask.isQueued = true;              // 标记任务在队列中
    }
    // 安排执行
    // 如果需要的话，调度一个HostCallback。如果我们已经在执行work，就等到下次我们让出控制权的时候。
    // 如有必要，计划一个主机回调。如果我们已经在执行工作，等到下次让出时再执行
    if (!isHostCallbackScheduled && !isPerformingWork) {
      isHostCallbackScheduled = true;  // 标记主线程在调度，标记主机回调已调度
      requestHostCallback(flushWork);  // 请求主机回调，执行刷新工作
    }
  }

  return newTask;  // 返回新任务
}

// 暂停执行
function unstable_pauseExecution() {
  isSchedulerPaused = true;  // 设置调度器暂停标记
}

// 继续执行
function unstable_continueExecution() {
  isSchedulerPaused = false;  // 清除调度器暂停标记
  if (!isHostCallbackScheduled && !isPerformingWork) {
    isHostCallbackScheduled = true;  // 标记主机回调已调度
    requestHostCallback(flushWork);  // 请求主机回调执行刷新工作
  }
}

// 获取第一个回调节点
function unstable_getFirstCallbackNode() {
  return peek(taskQueue);  // 返回任务队列中的第一个任务
}

// 取消任务回调
function unstable_cancelCallback(task) {
  if (enableProfiling) {
    if (task.isQueued) {
      const currentTime = getCurrentTime();
      markTaskCanceled(task, currentTime);  // 标记任务已取消
      task.isQueued = false;                // 标记任务不在队列中
    }
  }

  // 将回调设为 null 表示任务已取消（不能从队列中删除，
  // 因为无法从基于数组的堆中删除任意节点，只能删除第一个）
  task.callback = null;
}

// 获取当前优先级级别
function unstable_getCurrentPriorityLevel() {
  return currentPriorityLevel;  // 返回当前优先级
}

// 消息循环（时间切片）是否正在运行
let isMessageLoopRunning = false;
// 计划的主回调，即flushWork()
let scheduledHostCallback = null;
// 任务超时ID
let taskTimeoutID = -1;

// 调度器定期让出控制权，以防主线程上有其他工作，
// 比如用户事件。默认情况下，它每帧多次让出。
// 它不尝试与帧边界对齐，因为大多数任务不需要帧对齐；
// 对于那些需要的，请使用 requestAnimationFrame。
let frameInterval = frameYieldMs;  // 每帧间隔
const continuousInputInterval = continuousYieldMs;  // 连续输入间隔
const maxInterval = maxYieldMs;  // 最大间隔
let startTime = -1;  // 开始时间

let needsPaint = false;  // 是否需要绘制

// 是否应该让出控制权给主机
function shouldYieldToHost() {
  const timeElapsed = getCurrentTime() - startTime;  // 计算经过的时间
  if (timeElapsed < frameInterval) {
    // 主线程仅被阻塞了很短时间；小于单帧时间，暂不让出
    return false;
  }

  // 主线程已被阻塞了相当长的时间。我们可能想让出主线程的控制权，
  // 以便浏览器可以执行高优先级任务。主要任务是绘制和用户输入。
  // 如果有待处理的绘制或输入，则应让出。但如果两者都没有，
  // 则可以在保持响应的同时减少让出次数。最终无论如何都会让出，
  // 因为可能存在未伴随调用 requestPaint 的待处理绘制，
  // 或其他主线程任务如网络事件。
  if (enableIsInputPending) {
    if (needsPaint) {
      // 有待处理的绘制（由 requestPaint 发信号）。立即让出。
      return true;
    }
    if (timeElapsed < continuousInputInterval) {
      // 我们阻塞线程的时间不长。只有在有待处理的离散输入（如点击）时才让出。
      // 连续输入（如鼠标悬停）是可以接受的。
      if (isInputPending !== null) {
        return isInputPending();
      }
    } else if (timeElapsed < maxInterval) {
      // 如果有待处理的离散或连续输入，则让出。
      if (isInputPending !== null) {
        return isInputPending(continuousOptions);
      }
    } else {
      // 我们已经阻塞线程很长时间了。即使没有待处理输入，
      // 也可能有一些我们不知道的其他计划任务，如网络事件。立即让出。
      return true;
    }
  }

  // isInputPending 不可用。立即让出。
  return true;
}

// 请求绘制
function requestPaint() {
  if (
    enableIsInputPending &&
    navigator !== undefined &&
    navigator.scheduling !== undefined &&
    navigator.scheduling.isInputPending !== undefined
  ) {
    needsPaint = true;  // 标记需要绘制
  }

  // 由于我们每帧都会让出，requestPaint 没有效果。
}

// 强制帧率
function forceFrameRate(fps) {
  if (fps < 0 || fps > 125) {
    // 使用 console['error'] 以避开 Babel 和 ESLint
    console['error'](
      'forceFrameRate takes a positive int between 0 and 125, ' +
        'forcing frame rates higher than 125 fps is not supported',
    );
    return;
  }
  if (fps > 0) {
    frameInterval = Math.floor(1000 / fps);  // 计算帧间隔
  } else {
    // 重置帧率
    frameInterval = frameYieldMs;
  }
}

// 新的时间切片开始执行
// 执行work（执行多个task）直到时间切片结束
// 直到截止时间的工作执行函数
const performWorkUntilDeadline = () => {
  if (scheduledHostCallback !== null) {
    const currentTime = getCurrentTime();
    // 时间切片的起始时间
    // 跟踪开始时间，以测量主线程被阻塞了多长时间
    startTime = currentTime;
    const hasTimeRemaining = true;

    // 如果调度程序任务抛出异常，退出当前浏览器任务，
    // 以便错误可以被观察到。
    //
    // 故意不使用 try-catch，因为这会使某些调试技术更困难。
    // 相反，如果 scheduledHostCallback 出错，则
    // hasMoreWork 将保持为 true，我们将继续工作循环。
    let hasMoreWork = true;
    try {
      // scheduledHostCallback = callback = flushWork; flushWork --> workLoop;
      // 开始 flushWork(hasTimeRemaining, initialTime)
      // hasMoreWork，来自flushWork的返回值，来自workLoop的放回值，true：currentTask !== null，任务队列中还有task；false：没有task了
      hasMoreWork = scheduledHostCallback(hasTimeRemaining, currentTime);
    } finally {
      // 如果还有更多task
      if (hasMoreWork) {
        // ！！！当前的时间切片结束时，安排下一个时间切片，安排执行work、任务，直到截止时间
        // 在前一个（当前）消息事件结束时，安排下一个消息事件（安排下一个微任务）
        schedulePerformWorkUntilDeadline();
      } else {//任务队列中，没有任务了
        isMessageLoopRunning = false;  // 消息循环停止，时间切片循环停止
        scheduledHostCallback = null;  // 清空计划的主机回调
      }
    }
  } else {
    isMessageLoopRunning = false;  // 消息循环停止
  }
  // 让出给浏览器将给它绘制的机会，因此我们可以重置这个值
  needsPaint = false;
};

let schedulePerformWorkUntilDeadline;
if (typeof localSetImmediate === 'function') {
  // Node.js 和旧版 IE。
  // 有几个原因使我们更喜欢 setImmediate。
  //
  // 与 MessageChannel 不同，它不会阻止 Node.js 进程退出。
  // （即使这是 DOM 的调度器分支，你可能会在这里
  // 使用 Node.js 15+ 和 jsdom 的混合。）
  // https://github.com/facebook/react/issues/20756
  //
  // 但也是，它运行得更早，这是我们想要的语义。
  // 如果其他浏览器实现了它，最好使用它。
  // 尽管这些都比原生调度要差。
  schedulePerformWorkUntilDeadline = () => {
    localSetImmediate(performWorkUntilDeadline);
  };
} else if (typeof MessageChannel !== 'undefined') {
  // DOM 和 Worker 环境。
  // 我们更喜欢 MessageChannel 是因为 4ms 的 setTimeout 限制。
  const channel = new MessageChannel();
  const port = channel.port2;
  channel.port1.onmessage = performWorkUntilDeadline;
  schedulePerformWorkUntilDeadline = () => {
    port.postMessage(null);
  };
} else {
  // 我们只应在非浏览器环境中回退到这里。
  schedulePerformWorkUntilDeadline = () => {
    localSetTimeout(performWorkUntilDeadline, 0);
  };
}

// 请求主回调
// scheduledHostCallback = callback = flushWork
function requestHostCallback(callback) {
  scheduledHostCallback = callback;  // 设置计划的主回调，即flushWork
  if (!isMessageLoopRunning) {      // 如果消息循环（时间切片）未运行
    isMessageLoopRunning = true;    // 启动消息循环
    schedulePerformWorkUntilDeadline();  // 触发、安排、启动，下一个时间切片（安排执行work、任务，直到截止时间）
  }
}

// 请求主机超时
function requestHostTimeout(callback, ms) {
  taskTimeoutID = localSetTimeout(() => {
    callback(getCurrentTime());  // 执行回调并传入当前时间
  }, ms);
}

// 取消主机超时
function cancelHostTimeout() {
  localClearTimeout(taskTimeoutID);  // 清除超时
  taskTimeoutID = -1;                // 重置超时ID
}

// 请求绘制函数导出
const unstable_requestPaint = requestPaint;

// 导出公共 API
export {
  ImmediatePriority as unstable_ImmediatePriority,
  UserBlockingPriority as unstable_UserBlockingPriority,
  NormalPriority as unstable_NormalPriority,
  IdlePriority as unstable_IdlePriority,
  LowPriority as unstable_LowPriority,
  unstable_runWithPriority,
  unstable_next,
  unstable_scheduleCallback,
  unstable_cancelCallback,
  unstable_wrapCallback,
  unstable_getCurrentPriorityLevel,
  shouldYieldToHost as unstable_shouldYield,
  unstable_requestPaint,
  unstable_continueExecution,
  unstable_pauseExecution,
  unstable_getFirstCallbackNode,
  getCurrentTime as unstable_now,
  forceFrameRate as unstable_forceFrameRate,
};

// 导出性能分析 API
export const unstable_Profiling = enableProfiling
  ? {
      startLoggingProfilingEvents,
      stopLoggingProfilingEvents,
    }
  : null;
