/// <reference types="vite/client" />

// 构建时注入（见 vite.config.ts 的 define 配置）：应用版本号与构建时刻
// 由 Vite 编译期替换为实际字符串，运行期不可变
// eslint-disable-next-line no-var
declare const __APP_VERSION__: string
declare const __BUILD_TIME__: string

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

interface IpcRendererApi {
  on(channel: string, listener: (event: any, ...args: any[]) => void): void
  off(channel: string, ...omit: any[]): void
  removeListener(channel: string, listener: (event: any, ...args: any[]) => void): void
  removeAllListeners(channel: string): void
  send(channel: string, ...args: any[]): void
  invoke(channel: string, ...args: any[]): Promise<any>
}

interface Window {
  // expose in the `electron/preload/index.ts`
  ipcRenderer: IpcRendererApi
  // Excalidraw 静态资源（字体等）路径，相对 index.html 指向 dist 根目录
  EXCALIDRAW_ASSET_PATH?: string
}
