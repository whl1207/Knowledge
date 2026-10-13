import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Capacitor 配置（安卓壳）。
 *
 * 定位：**复用同一套渲染层**（Vue3 应用 + 平台能力层 src/platform），
 * 桌面仍走 Electron（electron-builder），两者互不影响。
 *
 * 能力映射（见 src/platform/android/index.ts）：
 * - 文件：Capacitor Filesystem（应用文档目录为根）+ SAF 用户授权目录
 *   （原生插件 android/app/src/main/java/com/whl/aikm/SafFolderPlugin.java；渲染层用 `saf:` 前缀路径）
 * - LLM：本机直连（`llm.hosted` = none → services/ai-utils 走 shared/ai-core）
 *   也可改用「主机后端」连接桌面端（src/platform/host 的 HTTP 实现）
 * - 窗口壳 / 系统集成 / 宿主重能力：无（降级或后续以原生插件补齐）
 */
const config: CapacitorConfig = {
  appId: 'com.whl.aikm',
  appName: 'AI-KM',
  // 渲染层构建产物（vite build 输出，与 Electron 共用）
  webDir: 'dist',
  android: {
    // 允许 http 明文（局域网主机 http://<ip>:3345、本地 Ollama 等）
    allowMixedContent: true,
  },
  server: {
    // 生产构建走本地资源；如需连桌面主机做联调，可临时改 url 指向主机局域网地址
    androidScheme: 'http',
  },
}

export default config
