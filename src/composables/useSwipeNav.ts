/**
 * useSwipeNav.ts — 触屏左右滑动翻页（演示视图 / 思维导图讲解模式共用）。
 *
 * 这两处的翻页入口不同（演示视图改 `showIndex`，讲解模式走 `talkNext` / `talkPrevOrExit`），
 * 但「什么样的手势才算一次横滑」的判定完全一样，且比键盘 / 按钮复杂得多：要避开纵向滚动、
 * 双指捏合、横向可滚动区域（代码块 / 宽图）与工具栏，所以抽成一份共用实现。
 *
 * 判定（在 touchend 时一次性决定）：
 *   1. 单指、时长 ≤ maxDuration、水平位移 ≥ minDistance，且水平位移 ≥ dominance × 垂直位移；
 *   2. 起点不在 `ignore` 选择器内（工具栏 / 目录面板 / 图片查看浮层等）；
 *   3. `respectInnerScrollX` 打开时，手指下方若还有「能朝该方向继续横滚」的容器，本次当作
 *      滚动不翻页；已滚到边缘再滑才翻页 —— 与演示视图「滚轮先滚到底再翻页」的规则一致。
 *
 * ⚠ 监听挂在**捕获阶段**：markmap 的 d3-zoom 在 touchstart / touchmove 上调用
 *   stopImmediatePropagation()（见 d3-zoom 的 nopropagation），冒泡阶段收不到事件，
 *   而捕获阶段先于 svg 上的监听执行，不受影响。
 *   手势过程不调用 preventDefault，纵向滚动等浏览器默认行为保持原样。
 */
import { onBeforeUnmount, onMounted, watch, type Ref } from 'vue'

/** 触发翻页所需的最小水平位移（px） */
export const SWIPE_MIN_DISTANCE = 50
/** 水平位移须达到垂直位移的多少倍才算横滑（避免纵向滚动时误翻页） */
export const SWIPE_DOMINANCE = 1.5
/** 手势最长时长（ms）：更久的拖动视为平移 / 滚动，不翻页 */
export const SWIPE_MAX_DURATION = 1000

export interface SwipeNavOptions {
  /** 左滑（手指自右向左）：通常是「下一页」 */
  onSwipeLeft: () => void
  /** 右滑（手指自左向右）：通常是「上一页」 */
  onSwipeRight: () => void
  /** 当前是否允许翻页（返回 false 时本次手势直接忽略，如总览打开时） */
  enabled?: () => boolean
  /** 忽略的起点区域（CSS 选择器） */
  ignore?: string
  minDistance?: number
  dominance?: number
  maxDuration?: number
  /** 手指下方存在可继续横滚的容器时，优先让它滚动而不翻页（默认关闭） */
  respectInnerScrollX?: boolean
}

/**
 * 绑定左右滑动翻页手势。
 *
 * @param target 翻页容器（手势在此元素范围内生效），要能被模板 ref 拿到
 * @param options 回调与判定参数
 */
export function useSwipeNav(target: Ref<HTMLElement | null>, options: SwipeNavOptions): void {
  const minDistance = options.minDistance ?? SWIPE_MIN_DISTANCE
  const dominance = options.dominance ?? SWIPE_DOMINANCE
  const maxDuration = options.maxDuration ?? SWIPE_MAX_DURATION

  let el: HTMLElement | null = null
  let tracking = false
  let startX = 0
  let startY = 0
  let lastX = 0
  let lastY = 0
  let startAt = 0

  /** 手指下方是否还有「能朝 dir 方向继续横滚」的容器（不含翻页容器自身） */
  const canScrollXFurther = (from: HTMLElement, dir: 1 | -1): boolean => {
    let node: HTMLElement | null = from
    while (node && node !== el) {
      const overflowX = getComputedStyle(node).overflowX
      if (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'overlay') {
        const max = node.scrollWidth - node.clientWidth
        if (max > 2 && (dir > 0 ? node.scrollLeft < max - 1 : node.scrollLeft > 1)) return true
      }
      node = node.parentElement
    }
    return false
  }

  const onTouchStart = (e: TouchEvent) => {
    tracking = false
    if (e.touches.length !== 1) return // 双指（捏合缩放）不翻页
    if (options.enabled && !options.enabled()) return
    const start = e.target as HTMLElement | null
    if (start && options.ignore && start.closest(options.ignore)) return
    const touch = e.touches[0]
    if (!touch) return
    tracking = true
    startX = lastX = touch.clientX
    startY = lastY = touch.clientY
    startAt = Date.now()
  }

  const onTouchMove = (e: TouchEvent) => {
    if (!tracking) return
    if (e.touches.length !== 1) {
      tracking = false // 中途变多指：放弃本次手势
      return
    }
    const touch = e.touches[0]
    if (!touch) return
    lastX = touch.clientX
    lastY = touch.clientY
  }

  const onTouchEnd = (e: TouchEvent) => {
    if (!tracking) return
    tracking = false
    if (Date.now() - startAt > maxDuration) return
    const dx = lastX - startX
    const dy = lastY - startY
    if (Math.abs(dx) < minDistance) return
    if (Math.abs(dx) < Math.abs(dy) * dominance) return
    // 左滑（dx < 0）= 内容左移、看后一页 → 内部横滚也朝 +scrollLeft 方向
    const dir: 1 | -1 = dx < 0 ? 1 : -1
    if (options.respectInnerScrollX) {
      const start = e.target as HTMLElement | null
      if (start && canScrollXFurther(start, dir)) return
    }
    if (dx < 0) options.onSwipeLeft()
    else options.onSwipeRight()
  }

  const onTouchCancel = () => {
    tracking = false
  }

  const bind = (node: HTMLElement) => {
    node.addEventListener('touchstart', onTouchStart, { capture: true, passive: true })
    node.addEventListener('touchmove', onTouchMove, { capture: true, passive: true })
    node.addEventListener('touchend', onTouchEnd, { capture: true, passive: true })
    node.addEventListener('touchcancel', onTouchCancel, { capture: true, passive: true })
  }

  const unbind = (node: HTMLElement) => {
    node.removeEventListener('touchstart', onTouchStart, { capture: true })
    node.removeEventListener('touchmove', onTouchMove, { capture: true })
    node.removeEventListener('touchend', onTouchEnd, { capture: true })
    node.removeEventListener('touchcancel', onTouchCancel, { capture: true })
  }

  // v-if 重建 / 模板 ref 变化时重新绑定
  const sync = () => {
    const next = target.value
    if (next === el) return
    if (el) unbind(el)
    el = next
    tracking = false
    if (el) bind(el)
  }

  onMounted(sync)
  watch(target, sync)
  onBeforeUnmount(() => {
    if (el) unbind(el)
    el = null
    tracking = false
  })
}
