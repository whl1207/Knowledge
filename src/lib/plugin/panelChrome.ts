/**
 * panelChrome.ts — 「主面板要全屏」时的宿主外壳开关（插件可请求隐藏顶栏 / 导航栏）
 *
 * 背景：插件面板全屏（电影式沉浸）有两条路：
 *  1) 插件自己 `position:fixed` 铺满窗口 + 高 z-index 盖住宿主外壳（retro-emulator 早期做法）。
 *     在 Chromium 里实测可行，但依赖 z-index / 层叠上下文 / 固定定位的细节——
 *     安卓 WebView（版本、界面缩放 CSS zoom、插件面板外面还套了 .plugin-panel-scroll 滚动容器）
 *     上出现「画面全屏了但顶栏还露着」这类偏差时就很难解释。
 *  2) **请宿主把外壳收起来**（本模块）：插件通过 `ctx.app.setChromeHidden(true)` 说一声，
 *     宿主给 `.container` 加 `chrome-hidden` 类，顶栏 / 左侧导航 / 底部导航整块 `display:none`。
 *     这才叫真隐藏：不留层叠隐患，也不占地方。
 *
 * 用法（宿主内部）：App.vue 绑定 `:class="{ 'chrome-hidden': panelChromeHidden }"`；
 * 面板切换 / 插件卸载时调用 `resetPanelChrome()` 兜底，避免插件异常时外壳一直藏着。
 * 插件侧：`ctx.app.setChromeHidden(on)`（见 lib/plugin/appApi.ts）。老版本宿主没有这个方法，
 * 插件应当 feature-detect 并退回方案 1（retro-emulator 就是两支都做了）。
 */

import { ref } from 'vue'

/** 是否隐藏宿主外壳（顶栏 / 左侧导航 / 底部导航） */
export const panelChromeHidden = ref(false)

/** 请求隐藏 / 恢复宿主外壳；返回是否被接受 */
export function setPanelChromeHidden(on: boolean): boolean {
  panelChromeHidden.value = on === true
  return panelChromeHidden.value
}

/** 兜底恢复（切面板、插件卸载、异常时调用） */
export function resetPanelChrome(): void {
  panelChromeHidden.value = false
}
