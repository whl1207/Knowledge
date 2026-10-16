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

/**
 * 局域网主机注入的运行时信息（见 electron/main/index.ts 的 withHostRuntime）：
 * 网页端据此注册 HTTP 版平台后端（src/platform/host）。
 */
declare global {
  interface Window {
    __AIKM_HOST__?: { fs?: 'off' | 'read' | 'write'; rootName?: string }
  }
}

/**
 * 通用 IPC 桥的形状（preload 的 `api` 对象）。
 *
 * ⚠️ 它**不再挂在 window 上**——渲染层一律经 `src/lib/aikmIpc.ts` 导出的 `aikmIpc` 访问。
 * 原因见该文件顶部注释（界面半边插件与宿主同 realm，通用桥挂 window 等于给出全部宿主能力）。
 */

interface Window {
  // Excalidraw 静态资源（字体等）路径，相对 index.html 指向 dist 根目录
  EXCALIDRAW_ASSET_PATH?: string
}
