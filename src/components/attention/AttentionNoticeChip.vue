<!--
  AttentionNoticeChip.vue — 轻提示的「就地冒出」：贴在「待我处理」按钮左侧，几秒后收回面板

  背景（使用反馈）：不要 ElMessage 那种角落 toast。提示应当出现在**用户正在看的导航栏上**——
  从「待我处理」按钮左侧伸出一个小胶囊，停几秒，再收缩收回按钮里（同时这条提示留在面板
  「动态」段里可回看）。ElMessage 本身已在 style.css 里被隐藏，全部提示改由这里呈现。

  行为约定：
  - 一次只显示一条（FIFO），每条停留 3 秒后收缩；最多排队 5 条，其余只进「动态」不弹；
  - 面板打开时不弹（用户已经能看到「动态」），打开面板会清空待弹出队列；
  - 点胶囊 = 打开面板（并定位到当前入口）；
  - 布局适配：顶栏/底部导航/窄窗口在按钮**左侧**；左侧竖直导航栏没有"左边"，改为从按钮**右侧**伸出。
-->
<template>
  <Transition name="notice-chip" @after-leave="onAfterLeave">
    <div
      v-if="current && showing"
      class="notice-chip"
      :class="[`kind-${current.kind}`, { 'chip-rail': anchorInRail }]"
      :style="chipStyle"
      :title="current.text"
      @click="onClick"
    >
      <i class="fa chip-icon" :class="iconOf(current.kind)"></i>
      <span class="chip-text">{{ current.text }}</span>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { NoticeItem, NoticeKind } from '@/store/notices'
import { notices } from '@/store/notices'
import { findVisibleEntry, openPanel, panelOpen } from '@/store/attention'

/** 每条停留时长（毫秒） */
const HOLD_MS = 3000
/** 离场动画时长（与 CSS 的 leave-active 对齐） */
const LEAVE_MS = 220
/** 最多排队的提示条数（其余只进面板「动态」，不再弹） */
const MAX_QUEUE = 5

const queue = ref<NoticeItem[]>([])
const current = ref<NoticeItem | null>(null)
const showing = ref(false)
/** 已经处理过的 id（不重复弹；打开应用前就存在的旧提示也不补弹） */
const seen = new Set<string>()

const anchorEl = ref<HTMLElement | null>(null)
const anchorRect = ref<{ top: number; left: number; right: number; height: number } | null>(null)
const anchorInRail = ref(false)

let holdTimer: ReturnType<typeof setTimeout> | null = null
let leaveTimer: ReturnType<typeof setTimeout> | null = null

function clearTimers(): void {
  if (holdTimer) { clearTimeout(holdTimer); holdTimer = null }
  if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null }
}

function captureAnchor(): void {
  const el = findVisibleEntry()
  anchorEl.value = el
  anchorInRail.value = !!(el && el.closest('.side-nav'))
  anchorRect.value = el
    ? (() => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, height: r.height } })()
    : null
}

const chipStyle = computed<Record<string, string>>(() => {
  const r = anchorRect.value
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  if (!r) return { top: '48px', right: '12px' }
  const style: Record<string, string> = {}
  if (anchorInRail.value) {
    // 左侧竖直导航栏：按钮左边是窗口边缘，改为从按钮**右侧**伸出
    style.top = `${Math.min(Math.max(4, r.top + r.height / 2 - 14), vh - 34)}px`
    style.left = `${r.right + 6}px`
    return style
  }
  // 顶栏 / 底部导航 / 窄窗口：贴到窗口右上角关闭按钮的左侧，避免通知停在导航栏中间
  const closeEl = typeof document !== 'undefined'
    ? document.querySelector<HTMLElement>('.mainPanel .app-window-close')
    : null
  const cr = closeEl?.getBoundingClientRect()
  if (cr && cr.width > 0) {
    style.top = `${Math.min(Math.max(4, cr.top + cr.height / 2 - 14), vh - 34)}px`
    style.right = `${vw - cr.left + 6}px`
  } else {
    style.top = `${Math.min(Math.max(4, r.top + r.height / 2 - 14), vh - 34)}px`
    style.right = `${vw - r.left + 6}px`
  }
  return style
})

function iconOf(kind: NoticeKind): string {
  if (kind === 'success') return 'fa-check-circle'
  if (kind === 'error') return 'fa-times-circle'
  if (kind === 'warning') return 'fa-exclamation-triangle'
  return 'fa-info-circle'
}

/** 显示下一条（若当前没有在显示） */
function pump(): void {
  if (current.value || panelOpen.value) return
  const next = queue.value.shift()
  if (!next) return
  captureAnchor()
  current.value = next
  showing.value = true
  clearTimers()
  holdTimer = setTimeout(() => { hideCurrent() }, HOLD_MS)
}

/** 收缩：先走离场动画，after-leave 再取下一条 */
function hideCurrent(): void {
  if (!showing.value) return
  showing.value = false
  clearTimers()
  leaveTimer = setTimeout(() => { onAfterLeave() }, LEAVE_MS + 60)
}

function onAfterLeave(): void {
  if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null }
  if (showing.value) return
  current.value = null
  pump()
}

function onClick(): void {
  if (current.value) seen.add(current.value.id)
  hideCurrent()
  // 只有主窗口有「待我处理」入口；设置 / 文件 / 浏览器等独立窗口里没有面板，点击只收起提示
  const anchor = anchorEl.value || findVisibleEntry()
  if (anchor) openPanel(anchor)
}

// 新提示入队（不补弹历史：应用启动前已存在的只进「动态」）
watch(notices, (list) => {
  const fresh: NoticeItem[] = []
  for (const n of [...list].reverse()) {
    if (seen.has(n.id)) continue
    seen.add(n.id)
    fresh.push(n)
  }
  if (!fresh.length) return
  // 面板开着时不弹：用户已经在看「动态」，再冒胶囊是噪音
  if (panelOpen.value) return
  queue.value.push(...fresh)
  if (queue.value.length > MAX_QUEUE) queue.value = queue.value.slice(queue.value.length - MAX_QUEUE)
  pump()
})

// 面板打开时不再弹（用户已经能看到「动态」）；关闭后从新的提示继续
watch(panelOpen, (open) => {
  if (!open) return
  queue.value = []
  hideCurrent()
})

function onResize(): void {
  if (!current.value) return
  captureAnchor()
}

onMounted(() => {
  // 挂载前已经产生的提示不补弹（它们都在面板「动态」里），避免启动时连播
  for (const n of notices.value) seen.add(n.id)
  window.addEventListener('resize', onResize)
})

onBeforeUnmount(() => {
  clearTimers()
  window.removeEventListener('resize', onResize)
})
</script>

<style scoped>
.notice-chip {
  position: fixed;
  z-index: 1460;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 280px;
  padding: 5px 10px;
  border: 1px solid var(--borderColor);
  border-radius: 14px;
  background: var(--menuColor);
  color: var(--fontActiveColor);
  box-shadow: 0 4px 14px rgba(0, 0, 0, .18);
  cursor: pointer;
  font-size: 11.5px;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  /* 默认从右侧（按钮方向）伸出/收回 */
  transform-origin: right center;
}
.chip-rail { transform-origin: left center; }
.chip-icon { flex-shrink: 0; font-size: 12px; }
.kind-success .chip-icon { color: #67c23a; }
.kind-error .chip-icon { color: #f56c6c; }
.kind-warning .chip-icon { color: #e6a23c; }
.kind-info .chip-icon { color: #909399; }
.chip-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 232px;
}

/* 伸出：从按钮一侧展开；收缩：缩回按钮里 */
.notice-chip-enter-active { transition: opacity .18s ease-out, transform .18s ease-out; }
.notice-chip-leave-active { transition: opacity .22s ease-in, transform .22s ease-in; }
.notice-chip-enter-from { opacity: 0; transform: scale(.72) translateX(10px); }
.notice-chip-leave-to { opacity: 0; transform: scale(.82) translateX(14px); }
.chip-rail.notice-chip-enter-from { transform: scale(.72) translateX(-10px); }
.chip-rail.notice-chip-leave-to { transform: scale(.82) translateX(-14px); }
</style>
