/**
 * useBackLayer.ts — 把「模块自己的一层界面」登记到系统返回手势（见 platform/backLayers.ts）
 *
 * 只在安卓壳生效（其它环境没有系统返回手势，注册也无意义，因此直接跳过以减少开销）。
 *
 * 生命周期：KeepAlive 面板在**失活**时不会 unmount，所以除了 mounted/unmounted 之外
 * 还要跟 activated/deactivated 对齐——否则一个被缓存住、已经不可见的面板仍会抢返回手势。
 */

import { onActivated, onDeactivated, onMounted, onUnmounted, type Ref } from 'vue'
import { getPlatform } from '@/platform'
import { BACK_ORDER, registerBackLayer, type BackLayer } from '@/platform/backLayers'

/** 是否安卓壳（有系统返回手势的环境） */
function hasSystemBack(): boolean {
  try {
    return getPlatform().kind === 'android'
  } catch {
    return false
  }
}

/**
 * 登记一层可回退的界面。
 *
 * @param id      层标识（调试 / 自检用）
 * @param order   优先级（用 `BACK_ORDER` 里的常量；数值越大越靠内层、越先被询问）
 * @param canGoBack 当前是否有东西可回退（请在这里判断「本层是否可见 + 内部状态是否可退」）
 * @param goBack  执行回退
 */
export function useBackLayer(
  id: string,
  order: number,
  canGoBack: () => boolean,
  goBack: () => void,
): void {
  if (!hasSystemBack()) return

  let off: (() => void) | null = null
  const layer: BackLayer = { id, order, canGoBack, goBack }
  const attach = () => {
    if (off) return
    off = registerBackLayer(layer)
  }
  const detach = () => {
    off?.()
    off = null
  }

  onMounted(attach)
  onActivated(attach)
  onDeactivated(detach)
  onUnmounted(detach)
}

/**
 * 「整屏列表 ⇄ 整屏内容」两屏面板的通用登记（细长窗口下手机上的标准交互）。
 *
 * 各设置面板的状态都是同一对 ref：`isTallLayout`（是否细长窗口）+ `showNavScreen`
 * （true = 正在看列表）。返回手势在内容屏时回到列表；已在列表则由更外层（关设置）接手。
 */
export function useMobileBackScreen(
  id: string,
  isTallLayout: Ref<boolean>,
  showNavScreen: Ref<boolean>,
  order: number = BACK_ORDER.settingsPanel,
): void {
  useBackLayer(id, order, () => isTallLayout.value && !showNavScreen.value, () => { showNavScreen.value = true })
}
