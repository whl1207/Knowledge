/// <reference types="vite-plugin-electron/electron-env" />

declare namespace NodeJS {
  interface ProcessEnv {
    VSCODE_DEBUG?: 'true'
    DIST_ELECTRON: string
    DIST: string
    /** /dist/ or /public/ */
    VITE_PUBLIC: string
  }
}

// 与 src/vite-env.d.ts 相同的 Window 声明（electron/ai-core.ts 会被主进程与渲染进程
// 两个工程共同引用，主进程工程未包含 src/vite-env.d.ts，因此这里补齐）。
interface IpcRendererApi {
  on(channel: string, listener: (event: any, ...args: any[]) => void): void
  off(channel: string, ...omit: any[]): void
  removeListener(channel: string, listener: (event: any, ...args: any[]) => void): void
  removeAllListeners(channel: string): void
  send(channel: string, ...args: any[]): void
  invoke(channel: string, ...args: any[]): Promise<any>
}

interface Window {
  ipcRenderer: IpcRendererApi
}
