// Electron adds a non-standard `path` property to File objects from drag-and-drop
interface File {
  path: string
}

/**
 * 命名空间 IPC（preload 里的 `dsh` 对象）的形状。
 *
 * ⚠️ 它**不再挂在 window 上**：preload 只在 window 上暴露一次性的 `__aikmClaimIpcBridge()`，
 * 渲染层一律经 `src/lib/aikmIpc.ts` 导出的 `aikmDsh` 访问（原因见该文件顶部注释）。
 * 保留形状定义供该模块引用；再写 `window.dsh` 会被 vue-tsc 直接拦下。
 *
 * 类型经 import() 按需引用，避免把本文件变成模块（保持全局 augment 语义）。
 */

/**
 * preload 暴露给渲染层的**一次性** IPC 桥领取入口（见 electron/preload/index.ts）。
 * 由 `src/lib/aikmIpc.ts` 在应用启动时领取一次，随后自行焚毁；
 * 除该模块外不要直接调用 —— 那会把桥重新暴露给同 realm 的插件代码。
 */
interface Window {
  __aikmClaimIpcBridge?: () => {
    ipcRenderer: import('./src/types/ipcBridge').IpcRendererApi
    dsh: import('./src/types/ipcBridge').AikmDshApi
  } | null
}

declare module 'js-yaml' {
  const yaml: any;
  export default yaml;
}

// sherpa-onnx 原生运行时（sherpa-onnx-node）在 electron/vendor-shims.d.ts 声明
declare module 'markdown-it-toc-and-anchor' {
  const tocAndAnchor: any;
  export default tocAndAnchor;
}
  
declare module 'markdown-it-mark' {
  const mark: any;
  export default mark;
}
declare module 'pdfjs-dist' {
  export * from 'pdfjs-dist/types/src/pdf';
}