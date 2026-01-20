/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// 导入所需的类型定义
import type {MutableSource, ReactNodeList} from 'shared/ReactTypes'; // 导入可变源和React节点列表类型
import type {
  FiberRoot,
  TransitionTracingCallbacks,
} from 'react-reconciler/src/ReactInternalTypes'; // 导入Fiber根节点和过渡跟踪回调类型

// 从事件模块导入函数
import {queueExplicitHydrationTarget} from '../events/ReactDOMEventReplaying'; // 导入队列显式水合目标函数
import {REACT_ELEMENT_TYPE} from 'shared/ReactSymbols'; // 导入React元素类型符号

// 定义RootType类型，包含渲染、卸载方法和内部根节点
export type RootType = {
  render(children: ReactNodeList): void, // 渲染方法，接收React节点列表作为参数
  unmount(): void, // 卸载方法
  _internalRoot: FiberRoot | null, // 内部根节点，可能是FiberRoot或null
  ...
};

// 定义创建根节点的选项类型
export type CreateRootOptions = {
  unstable_strictMode?: boolean, // 不稳定版本的严格模式选项
  unstable_concurrentUpdatesByDefault?: boolean, // 默认启用并发更新的不稳定版本选项
  identifierPrefix?: string, // 标识符前缀
  onRecoverableError?: (error: mixed) => void, // 可恢复错误的回调函数
  transitionCallbacks?: TransitionTracingCallbacks, // 过渡跟踪回调
  ...
};

// 定义水合根节点的选项类型
export type HydrateRootOptions = {
  // 水合选项
  hydratedSources?: Array<MutableSource<any>>, // 已水合的数据源数组
  onHydrated?: (suspenseNode: Comment) => void, // 水合完成时的回调函数
  onDeleted?: (suspenseNode: Comment) => void, // 删除时的回调函数
  // 所有根节点的选项
  unstable_strictMode?: boolean, // 不稳定版本的严格模式选项
  unstable_concurrentUpdatesByDefault?: boolean, // 默认启用并发更新的不稳定版本选项
  identifierPrefix?: string, // 标识符前缀
  onRecoverableError?: (error: mixed) => void, // 可恢复错误的回调函数
  ...
};

// 从DOM组件树模块导入相关函数
import {
  isContainerMarkedAsRoot, // 检查容器是否标记为根节点
  markContainerAsRoot, // 将容器标记为根节点
  unmarkContainerAsRoot, // 取消容器的根节点标记
} from './ReactDOMComponentTree';
// 从DOM插件事件系统导入监听所有支持事件的函数
import {listenToAllSupportedEvents} from '../events/DOMPluginEventSystem';
// 导入HTML节点类型常量
import {
  ELEMENT_NODE, // 元素节点类型
  COMMENT_NODE, // 注释节点类型
  DOCUMENT_NODE, // 文档节点类型
  DOCUMENT_FRAGMENT_NODE, // 文档片段节点类型
} from '../shared/HTMLNodeType';

// 从React Fiber协调器导入相关函数
import {
  createContainer, // 创建容器函数
  createHydrationContainer, // 创建水合容器函数
  updateContainer, // 更新容器函数
  findHostInstanceWithNoPortals, // 查找没有Portal的宿主实例
  registerMutableSourceForHydration, // 为水合注册可变源
  flushSync, // 同步刷新函数
  isAlreadyRendering, // 检查是否已在渲染中
} from 'react-reconciler/src/ReactFiberReconciler';
// 从React根标签导入并发根类型
import {ConcurrentRoot} from 'react-reconciler/src/ReactRootTags';
// 从React特性标志导入相关特性标志
import {
  allowConcurrentByDefault, // 允许默认并发
  disableCommentsAsDOMContainers, // 禁用注释作为DOM容器
} from 'shared/ReactFeatureFlags';

/* global reportError */
// 定义默认的可恢复错误处理函数
const defaultOnRecoverableError =
  typeof reportError === 'function'
    ? // 在现代浏览器中，reportError将分发一个错误事件，
      // 模拟未捕获的JavaScript错误
      reportError
    : (error: mixed) => {
        // 在旧版浏览器和测试环境中，回退到console.error
        // eslint-disable-next-line react-internal/no-production-logging
        console['error'](error);
      };

// ReactDOMRoot构造函数，接收一个内部FiberRoot作为参数
function ReactDOMRoot(internalRoot: FiberRoot) {
  this._internalRoot = internalRoot; // 将传入的内部根节点赋值给实例的_internalRoot属性
}

// 为 ReactDOMHydrationRoot 和 ReactDOMRoot 原型添加 render 方法
// children: 要渲染的 React 节点列表
ReactDOMHydrationRoot.prototype.render = ReactDOMRoot.prototype.render = function(
  children: ReactNodeList, // 接收要渲染的React节点列表
): void {
  const root = this._internalRoot; // 获取内部根节点
  if (root === null) {
    // 如果根节点为空（已经被卸载），则抛出错误，不能更新已卸载的根节点
    throw new Error('Cannot update an unmounted root.');
  }

  if (__DEV__) { // 如果在开发环境中
    // 检查是否有第二个参数（回调函数）
    if (typeof arguments[1] === 'function') {
      // 如果传递了回调函数，发出错误提示：render 方法不再支持回调函数
      console.error(
        'render(...): does not support the second callback argument. ' +
          'To execute a side effect after rendering, declare it in a component body with useEffect().',
      );
    } else if (isValidContainer(arguments[1])) { // 检查第二个参数是否是有效的容器
      // 如果传递了容器作为第二个参数，发出错误提示：不需要再次传递容器
      console.error(
        'You passed a container to the second argument of root.render(...). ' +
          "You don't need to pass it again since you already passed it to create the root.",
      );
    } else if (typeof arguments[1] !== 'undefined') { // 检查第二个参数是否是未定义之外的其他值
      // 如果传递了第二个参数，发出错误提示：render 方法只接受一个参数
      console.error(
        'You passed a second argument to root.render(...) but it only accepts ' +
          'one argument.',
      );
    }

    const container = root.containerInfo; // 获取根节点的容器信息

    if (container.nodeType !== COMMENT_NODE) { // 如果容器不是注释节点
      // 查找宿主实例（排除Portal）
      const hostInstance = findHostInstanceWithNoPortals(root.current);
      if (hostInstance) { // 如果找到了宿主实例
        // 检查宿主实例的父节点是否与容器匹配
        if (hostInstance.parentNode !== container) {
          // 如果不匹配，说明React渲染的内容被外部修改了，发出错误提示
          console.error(
            'render(...): It looks like the React-rendered content of the ' +
              'root container was removed without using React. This is not ' +
              'supported and will cause errors. Instead, call ' +
              "root.unmount() to empty a root's container.",
          );
        }
      }
    }
  }
  // 更新容器，将children渲染到root中
  // 这是实际执行渲染的核心方法调用
  updateContainer(children, root, null, null);
};
// 为ReactDOMHydrationRoot和ReactDOMRoot原型添加unmount方法
ReactDOMHydrationRoot.prototype.unmount = ReactDOMRoot.prototype.unmount = function(): void {
  if (__DEV__) { // 如果在开发环境中
    if (typeof arguments[0] === 'function') { // 检查是否有第一个参数（回调函数）
      console.error(
        'unmount(...): does not support a callback argument. ' +
          'To execute a side effect after rendering, declare it in a component body with useEffect().',
      );
    }
  }
  const root = this._internalRoot; // 获取内部根节点
  if (root !== null) { // 如果根节点不为空
    this._internalRoot = null; // 将实例的内部根节点设为null
    const container = root.containerInfo; // 获取容器信息
    if (__DEV__) { // 如果在开发环境中
      if (isAlreadyRendering()) { // 检查是否已经在渲染中
        console.error(
          'Attempted to synchronously unmount a root while React was already ' +
            'rendering. React cannot finish unmounting the root until the ' +
            'current render has completed, which may lead to a race condition.',
        );
      }
    }
    flushSync(() => { // 同步执行刷新
      updateContainer(null, root, null, null); // 更新容器，传入null来清空内容
    });
    unmarkContainerAsRoot(container); // 取消容器的根节点标记
  }
};

// 创建根节点的函数
export function createRoot(
  container: Element | Document | DocumentFragment, // 接收DOM元素、文档或文档片段作为容器
  options?: CreateRootOptions, // 可选的创建选项
): RootType {
  // 检查容器是否有效
  if (!isValidContainer(container)) {
    throw new Error('createRoot(...): Target container is not a DOM element.'); // 如果容器无效则抛出错误
  }

  warnIfReactDOMContainerInDEV(container); // 在开发环境中警告某些不当用法

  let isStrictMode = false; // 严格模式标志，默认为false
  let concurrentUpdatesByDefaultOverride = false; // 并发更新默认标志，默认为false
  let identifierPrefix = ''; // 标识符前缀，默认为空字符串
  let onRecoverableError = defaultOnRecoverableError; // 可恢复错误处理函数，默认为上面定义的函数
  let transitionCallbacks = null; // 过渡回调函数，默认为null

  // 处理options
  if (options !== null && options !== undefined) { // 如果提供了选项
    if (__DEV__) { // 在开发环境中
      if ((options: any).hydrate) { // 检查是否使用了废弃的hydrate选项
        console.warn(
          'hydrate through createRoot is deprecated. Use ReactDOMClient.hydrateRoot(container, <App />) instead.',
        );
      } else {
        if (
          typeof options === 'object' &&
          options !== null &&
          (options: any).$$typeof === REACT_ELEMENT_TYPE
        ) { // 检查是否错误地传入了JSX元素而不是选项对象
          console.error(
            'You passed a JSX element to createRoot. You probably meant to ' +
              'call root.render instead. ' +
              'Example usage:\n\n' +
              '  let root = createRoot(domContainer);\n' +
              '  root.render(<App />);',
          );
        }
      }
    }
    if (options.unstable_strictMode === true) { // 如果启用了严格模式
      isStrictMode = true;
    }
    if (
      allowConcurrentByDefault && // 如果允许默认并发
      options.unstable_concurrentUpdatesByDefault === true // 且选项中启用了默认并发更新
    ) {
      concurrentUpdatesByDefaultOverride = true; // 设置并发更新默认覆盖标志
    }
    if (options.identifierPrefix !== undefined) { // 如果指定了标识符前缀
      identifierPrefix = options.identifierPrefix;
    }
    if (options.onRecoverableError !== undefined) { // 如果指定了错误处理函数
      onRecoverableError = options.onRecoverableError;
    }
    if (options.transitionCallbacks !== undefined) { // 如果指定了过渡回调函数
      transitionCallbacks = options.transitionCallbacks;
    }
  }

  // 创建容器，传入各种配置参数
  const root = createContainer(
    container, // 容器
    ConcurrentRoot, // 根类型为并发根
    null, // 水合回调为空
    isStrictMode, // 严格模式标志
    concurrentUpdatesByDefaultOverride, // 并发更新默认覆盖标志
    identifierPrefix, // 标识符前缀
    onRecoverableError, // 错误处理函数
    transitionCallbacks, // 过渡回调函数
  );
  markContainerAsRoot(root.current, container); // 标记容器为根节点

  // 获取根容器元素，如果是注释节点则获取其父节点
  const rootContainerElement: Document | Element | DocumentFragment =
    container.nodeType === COMMENT_NODE
      ? (container.parentNode: any)
      : container;
  listenToAllSupportedEvents(rootContainerElement); // 监听根容器元素上的所有支持事件

  return new ReactDOMRoot(root); // 返回新的ReactDOMRoot实例
}

// ReactDOMHydrationRoot构造函数，接收一个内部FiberRoot作为参数
function ReactDOMHydrationRoot(internalRoot: FiberRoot) {
  this._internalRoot = internalRoot; // 将传入的内部根节点赋值给实例的_internalRoot属性
}

// 调度水合的函数
function scheduleHydration(target: Node) {
  if (target) { // 如果目标存在
    queueExplicitHydrationTarget(target); // 将目标加入水合队列
  }
}
// 将调度水合函数添加到ReactDOMHydrationRoot原型上
ReactDOMHydrationRoot.prototype.unstable_scheduleHydration = scheduleHydration;

// 水合根节点的函数
export function hydrateRoot(
  container: Document | Element, // 接收文档或元素作为容器
  initialChildren: ReactNodeList, // 初始要水合的React节点列表
  options?: HydrateRootOptions, // 可选的水合选项
): RootType {
  if (!isValidContainer(container)) { // 检查容器是否有效
    throw new Error('hydrateRoot(...): Target container is not a DOM element.'); // 如果容器无效则抛出错误
  }

  warnIfReactDOMContainerInDEV(container); // 在开发环境中警告某些不当用法

  if (__DEV__) { // 在开发环境中
    if (initialChildren === undefined) { // 检查是否提供了初始子节点
      console.error(
        'Must provide initial children as second argument to hydrateRoot. ' +
          'Example usage: hydrateRoot(domContainer, <App />)',
      );
    }
  }

  // 目前我们重用整个选项包，因为它们包含水合回调
  const hydrationCallbacks = options != null ? options : null;
  // TODO: 删除此选项
  const mutableSources = (options != null && options.hydratedSources) || null;

  let isStrictMode = false; // 严格模式标志，默认为false
  let concurrentUpdatesByDefaultOverride = false; // 并发更新默认标志，默认为false
  let identifierPrefix = ''; // 标识符前缀，默认为空字符串
  let onRecoverableError = defaultOnRecoverableError; // 可恢复错误处理函数，默认为上面定义的函数
  if (options !== null && options !== undefined) { // 如果提供了选项
    if (options.unstable_strictMode === true) { // 如果启用了严格模式
      isStrictMode = true;
    }
    if (
      allowConcurrentByDefault && // 如果允许默认并发
      options.unstable_concurrentUpdatesByDefault === true // 且选项中启用了默认并发更新
    ) {
      concurrentUpdatesByDefaultOverride = true; // 设置并发更新默认覆盖标志
    }
    if (options.identifierPrefix !== undefined) { // 如果指定了标识符前缀
      identifierPrefix = options.identifierPrefix;
    }
    if (options.onRecoverableError !== undefined) { // 如果指定了错误处理函数
      onRecoverableError = options.onRecoverableError;
    }
  }

  // 创建水合容器，传入各种配置参数
  const root = createHydrationContainer(
    initialChildren, // 初始子节点
    null, // 不使用回调
    container, // 容器
    ConcurrentRoot, // 根类型为并发根
    hydrationCallbacks, // 水合回调
    isStrictMode, // 严格模式标志
    concurrentUpdatesByDefaultOverride, // 并发更新默认覆盖标志
    identifierPrefix, // 标识符前缀
    onRecoverableError, // 错误处理函数
    // TODO(luna) 支持稍后的水合
    null,
  );
  markContainerAsRoot(root.current, container); // 标记容器为根节点
  // 这不能是注释节点，因为水合不适用于注释节点
  listenToAllSupportedEvents(container); // 监听容器上的所有支持事件

  if (mutableSources) { // 如果存在可变源
    for (let i = 0; i < mutableSources.length; i++) { // 遍历所有可变源
      const mutableSource = mutableSources[i]; // 获取当前可变源
      registerMutableSourceForHydration(root, mutableSource); // 为水合注册可变源
    }
  }

  return new ReactDOMHydrationRoot(root); // 返回新的ReactDOMHydrationRoot实例
}

// 检查容器是否有效的函数
export function isValidContainer(node: any): boolean {
  return !!(
    node && // 如果节点存在
    (node.nodeType === ELEMENT_NODE || // 且节点类型是元素节点
      node.nodeType === DOCUMENT_NODE || // 或文档节点
      node.nodeType === DOCUMENT_FRAGMENT_NODE || // 或文档片段节点
      (!disableCommentsAsDOMContainers && // 或（如果不禁用注释作为DOM容器）
        node.nodeType === COMMENT_NODE && // 且节点类型是注释节点
        (node: any).nodeValue === ' react-mount-point-unstable ')) // 且节点值是预期的挂载点标识
  );
}

// TODO: 删除也包含注释节点的此函数
// 我们只在当前较为宽松的地方使用它
export function isValidContainerLegacy(node: any): boolean {
  return !!(
    node && // 如果节点存在
    (node.nodeType === ELEMENT_NODE || // 且节点类型是元素节点
      node.nodeType === DOCUMENT_NODE || // 或文档节点
      node.nodeType === DOCUMENT_FRAGMENT_NODE || // 或文档片段节点
      (node.nodeType === COMMENT_NODE && // 或（节点类型是注释节点
        (node: any).nodeValue === ' react-mount-point-unstable ')) // 且节点值是预期的挂载点标识
  );
}

// 在开发环境中警告如果容器是ReactDOM容器的函数
function warnIfReactDOMContainerInDEV(container: any) {
  if (__DEV__) { // 如果在开发环境中
    if (
      container.nodeType === ELEMENT_NODE && // 如果容器是元素节点
      ((container: any): Element).tagName && // 且有标签名
      ((container: any): Element).tagName.toUpperCase() === 'BODY' // 且标签名为BODY（转为大写比较）
    ) {
      console.error(
        'createRoot(): Creating roots directly with document.body is ' +
          'discouraged, since its children are often manipulated by third-party ' +
          'scripts and browser extensions. This may lead to subtle ' +
          'reconciliation issues. Try using a container element created ' +
          'for your app.',
      );
    }
    if (isContainerMarkedAsRoot(container)) { // 如果容器已被标记为根节点
      if (container._reactRootContainer) { // 如果容器有_reactRootContainer属性
        console.error(
          'You are calling ReactDOMClient.createRoot() on a container that was previously ' +
            'passed to ReactDOM.render(). This is not supported.',
        );
      } else { // 否则
        console.error(
          'You are calling ReactDOMClient.createRoot() on a container that ' +
            'has already been passed to createRoot() before. Instead, call ' +
            'root.render() on the existing root instead if you want to update it.',
        );
      }
    }
  }
}
