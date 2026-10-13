/**
 * platform/android/back — 系统返回手势 / 返回键桥（BackButton 插件）封装
 *
 * 原生侧见 android/app/src/main/java/com/whl/aikm/BackButtonPlugin.java：
 * 安卓的返回手势默认直接结束 Activity，而本应用的「界面栈」是渲染层状态
 * （设置浮层 / 应用内文件窗口 / 主面板切换），WebView 与 URL 历史都不知道，
 * 所以渲染层必须先声明接管，再由原生把返回事件推给页面。
 *
 * 使用方式（见 src/platform/android/index.ts 的 makeBackApi 与 App.vue）：
 *   const off = onBackPressed(async () => { …; return true /* 已处理 *\/ })
 */

import { registerPlugin } from '@capacitor/core'

/** 原生插件的最小接口（与 BackButtonPlugin.java 一一对应） */
export interface BackButtonPluginApi {
  /** 声明渲染层是否接管返回（true = 原生把返回事件推给 JS，不再结束应用） */
  setHandled(payload: { handled: boolean }): Promise<{ handled: boolean }>
  isHandled(): Promise<{ handled: boolean }>
  /** 渲染层确认「回无可回」：结束应用（与系统在根页面的返回语义一致） */
  exit(): Promise<{ success: boolean }>
  addListener(
    eventName: 'back',
    listener: () => void,
  ): Promise<{ remove: () => Promise<void> }> & { remove: () => Promise<void> }
}

/** 原生插件实例（未安装时调用会 reject，由上层按能力降级） */
export const BackButton = registerPlugin<BackButtonPluginApi>('BackButton')
