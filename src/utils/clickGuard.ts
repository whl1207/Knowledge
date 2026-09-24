/**
 * src/utils/clickGuard.ts — 防「拖动划选文字」被当成点击
 *
 * 场景：表格「点击行 → 打开行详情」、模态框「点击遮罩 → 关闭」这两类交互，
 * 用户在内容上拖动划选文字、松手落在行外 / 遮罩上时，浏览器仍会补发一个 click
 * （按 UI Events 规范，click 派发给 mousedown/mouseup 最近的共同祖先），
 * 于是出现「想复制文字却打开了详情 / 弹窗自己关掉了」。
 *
 * 判定：按下与抬起位移超过阈值 → 拖动；本次交互中「新产生或改变了文字选区」→ 划选。
 * 两者都不算点击。
 *
 * ⚠ 不能只看「当前存在选区」：划选一次后选区会一直留着，
 *   之后任何一次正常点击都会被误吞（要点两次才生效）。必须比较按下与点击时的选区是否变化。
 *
 * 用法：
 *   const guard = createDragGuard()
 *   <div @mousedown="guard.onMouseDown" @click="guard.isRealClick($event) && doSomething()">
 */

/** 位移阈值（像素）：小于它才可能是「点击」 */
export const DRAG_TOLERANCE = 5

/** 当前非折叠选区的文本（无选区 / 空白选区 → 空串） */
function currentSelectionText(): string {
  const sel = typeof window !== 'undefined' ? window.getSelection() : null
  if (!sel || sel.isCollapsed) return ''
  return (sel.toString() || '').trim()
}

export interface DragGuard {
  /** 绑到会触发点击的元素上（可绑容器，事件会从子元素冒泡上来） */
  onMouseDown: (e: MouseEvent) => void
  /** 在 click 处理器里调用：true = 真正的点击，false = 拖动/划选，应忽略 */
  isRealClick: (e: MouseEvent, tolerance?: number) => boolean
}

export function createDragGuard(): DragGuard {
  let downX = 0
  let downY = 0
  let hasDown = false
  let selectionAtDown = ''
  return {
    onMouseDown(e: MouseEvent) {
      downX = e.clientX
      downY = e.clientY
      hasDown = true
      selectionAtDown = currentSelectionText()
    },
    isRealClick(e: MouseEvent, tolerance = DRAG_TOLERANCE) {
      const hadDown = hasDown
      const selectionBefore = selectionAtDown
      hasDown = false
      // 没有按下记录（键盘 Enter/空格触发、程序化 click）：按点击放行
      if (!hadDown) return true
      if (Math.abs(e.clientX - downX) > tolerance || Math.abs(e.clientY - downY) > tolerance) return false
      const selectionNow = currentSelectionText()
      // 本次按下→抬起过程中新产生 / 改动了选区 → 划选，不算点击
      if (selectionNow && selectionNow !== selectionBefore) return false
      return true
    },
  }
}
