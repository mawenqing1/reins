/* 渲染层经典脚本（app / icons / brands）共享的全局声明。
   这三个文件是 module:none 的经典脚本，靠 <script> 直引 + window 挂载协作，
   这里集中声明这些全局量，让 TS 能查。运行时语义不变。 */

interface Window {
  /* preload.ts 暴露的客户端桥（约 60 个 IPC 方法），渲染层只读不写 */
  reins: any;
  /* execlog.ts / taskflow.ts 编译为 UMD 后挂的全局 */
  ExecLog: typeof import('./execlog');
  TaskFlow: typeof import('./taskflow');
  /* icons.ts / brands.ts 挂载 */
  BRANDS: Record<string, string>;
  ICONS: Record<string, string>;
  ICON_CHAR: Record<string, string>;
  bi(key: string, cls?: string): string;
  ic(name: string, cls?: string): string;
  gic(ch: string, cls?: string): string;
  /* 调试探针 */
  __sessLog?: any;
}

/* 经典脚本里裸标识符与 window.X 是同一绑定，app.ts 里大量裸调用 */
declare const ExecLog: Window['ExecLog'];
declare const TaskFlow: Window['TaskFlow'];
declare function ic(name: string, cls?: string): string;
declare function bi(key: string, cls?: string): string;
declare function gic(ch: string, cls?: string): string;

/* —— legacy JS 松散 DOM 访问的类型垫片（纯类型面，无任何运行时影响）——
   app.ts 由 JS 直接转 TS，大量 querySelector/getElementById 结果被按具体元素
   直接读写（.value/.disabled/.dataset/.style/.title/.onclick），lib.dom 的
   Element/EventTarget 类型面没有这些成员。在基类上按旧行为补宽：HTMLInputElement
   等具体元素自带的同名成员在派生接口里优先，类型与行为都不受影响。 */
interface Element {
  disabled: any;
  value: any;
  title: any;
  dataset: Record<string, string>;
  style: CSSStyleDeclaration;
  onclick: any;
}
interface EventTarget {
  closest(selectors: string): any;
}

/* 已知隐患占位（勿模仿）：createSpace() 里引用了 `tpl`，但该名字既不是全局量、
   函数参数，也没有任何外层闭包——运行时会 ReferenceError。为保持 TS 化过程
   运行时行为零变化，这里先声明兜底，修复应改 app.ts 本身（下一提交处理）。 */
declare const tpl: any;
