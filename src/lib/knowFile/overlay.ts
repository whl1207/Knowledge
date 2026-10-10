/**
 * overlay.ts — 知识管理各视图里「浮层」的公用交互
 *
 * 看板 / 日历等视图的浮层（右键菜单、时间编辑面板、筛选面板）都需要同一套收起与定位行为，
 * 这里集中实现，避免每个视图各写一份出现差异（此前只存在于 view_kanban.vue）。
 */
import { onBeforeUnmount, watch, type Ref } from 'vue'

/**
 * 浮层关闭：打开时监听「点击外部」与 Esc（命中 keepSelector 的元素不关闭，便于点按钮自己切换）。
 * 需要在组件 setup 顶层调用（内部注册的监听随组件卸载自动移除）。
 */
export function bindDismiss(isOpen: Ref<boolean>, keepSelector: string, close: () => void) {
  let onDown: ((e: MouseEvent) => void) | null = null
  let onKey: ((e: KeyboardEvent) => void) | null = null
  const unbind = () => {
    if (onDown) { document.removeEventListener('mousedown', onDown, true); onDown = null }
    if (onKey) { document.removeEventListener('keydown', onKey, true); onKey = null }
  }
  watch(isOpen, (open) => {
    unbind()
    if (!open) return
    onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (t && t.closest(keepSelector)) return
      close()
    }
    onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
  })
  onBeforeUnmount(unbind)
}

/**
 * 子菜单溢出检测（文件视图 / 浏览视图 / 看板 / 日历同一套）：右侧或底部空间不足时翻转展开方向。
 * 返回的处理函数挂在菜单根节点的 mouseover 上；仅在首次进入某个二级菜单项时计算，
 * 避免在子菜单内部移动时反复翻转（闪烁）。
 */
export function createSubmenuHoverFix(rootSelector: string) {
  let activeItem: HTMLElement | null = null
  return (e: MouseEvent) => {
    const target = (e.target as HTMLElement).closest(`${rootSelector} .has-submenu`) as HTMLElement | null
    if (!target) {
      activeItem = null
      return
    }
    if (activeItem === target) return
    activeItem = target
    const submenu = target.querySelector(':scope > .submenu') as HTMLElement | null
    if (!submenu) return
    requestAnimationFrame(() => {
      submenu.classList.remove('submenu-up', 'submenu-left')
      const rect = submenu.getBoundingClientRect()
      if (rect.bottom > window.innerHeight) submenu.classList.add('submenu-up')
      if (rect.right > window.innerWidth) submenu.classList.add('submenu-left')
    })
  }
}

/** 浮动面板贴边回收：把 (x, y) 收进视口内（渲染后量尺寸再调用） */
export function clampToViewport(el: HTMLElement | null, x: number, y: number): { x: number; y: number } {
  if (!el) return { x, y }
  const r = el.getBoundingClientRect()
  return {
    x: Math.min(x, Math.max(4, window.innerWidth - r.width - 4)),
    y: Math.min(y, Math.max(4, window.innerHeight - r.height - 4)),
  }
}
