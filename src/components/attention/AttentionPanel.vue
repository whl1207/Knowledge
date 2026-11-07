<!--
  AttentionPanel.vue — 「待我处理」浮层面板（贴在导航按钮下方 / 上方，右对齐窗口右侧）

  形态三条硬约束（按使用反馈定）：
  1. **对齐到窗口右侧**（不是按钮右侧）：右侧留 8px，始终与窗口右边缘齐平；
  2. **宽度按内容自适应**：没有需要选择的东西（无待办 / 只有通知）时窄（300px），
     有提问或计划待裁决时才变宽（420px）；
  3. **高度按内容自适应**：没有条目时只有表头 + 一行空态；满了才滚动。
  位置：顶栏/窄窗口/底部导航贴着按钮在下方或上方展开；左侧导航同样靠窗口右侧，永不影响导航栏。

  内容两段：待我处理（不解决不消失）+ 动态（ElMessage 提示的收件箱副本，可清空）。
  状态与动作全在 store/attention 与 store/notices；本组件只做定位与渲染。
-->
<template>
  <div v-if="open" ref="rootRef" class="attention-pop" :class="{ 'attention-compact': compact }" :style="popStyle" role="dialog" :aria-label="title">
    <header class="attention-head">
      <i class="fa fa-inbox attention-head-icon"></i>
      <span class="attention-head-title">{{ title }}</span>
      <span v-if="openCount" class="attention-head-count">{{ openCount }}</span>
      <button class="attention-close" :title="zh ? '关闭（Esc）' : 'Close (Esc)'" @click="emit('close')">
        <i class="fa fa-times"></i>
      </button>
    </header>

    <div v-if="items.length || notices.length" class="attention-scroll scoll">
      <!-- 待我处理：不解决不消失 -->
      <template v-if="items.length">
        <section v-for="g in groups" :key="g.group" class="attention-group">
          <h4 class="attention-group-title">
            {{ groupTitle(g.group, zh) }}
            <span class="attention-group-count">{{ g.items.length }}</span>
          </h4>
          <AttentionItemRow v-for="it in g.items" :key="it.key" :item="it" />
        </section>
      </template>

      <!-- 动态：轻提示的收件箱副本（错过也能回看）。
           分割线只在「上方确实有待我处理条目」时才画——只有通知时上方直接是表头，
           再出现一条边框会像是漏画了半个框。 -->
      <section
        v-if="notices.length"
        class="attention-activity"
        :class="{ 'has-divider': items.length > 0 }"
      >
        <h4 class="attention-group-title">
          {{ zh ? '动态' : 'Activity' }}
          <button class="attention-clear" :title="zh ? '清空动态' : 'Clear activity'" @click="clearNotices">
            <i class="fa fa-trash-o"></i>
          </button>
        </h4>
        <div
          v-for="n in visibleNotices"
          :key="n.id"
          class="attention-notice"
          :class="`n-${n.kind}`"
        >
          <i class="fa notice-icon" :class="noticeIcon(n.kind)"></i>
          <span class="notice-text" :title="n.text">{{ n.text }}</span>
          <span class="notice-time">{{ relativeTime(n.at, now, zh) }}</span>
        </div>
        <div v-if="notices.length > visibleNotices.length" class="attention-empty-sub">
          {{ zh ? `还有 ${notices.length - visibleNotices.length} 条…` : `${notices.length - visibleNotices.length} more…` }}
        </div>
      </section>
    </div>

    <!-- 没有待办也没有动态：只占一行高度 -->
    <div v-else class="attention-empty">
      <i class="fa fa-check-circle-o attention-empty-icon"></i>
      <span class="attention-empty-text">{{ zh ? '没有需要你处理的事' : 'Nothing needs you' }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { groupTitle, relativeTime } from '@/lib/attention/model'
import { closePanel, groups, items, openCount, panelAnchor } from '@/store/attention'
import { clearNotices, markNoticesRead, notices, type NoticeKind } from '@/store/notices'
import { usestore } from '@/store'
import AttentionItemRow from '@/components/attention/AttentionItemRow.vue'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const store = usestore()
const zh = computed(() => store.locales !== 'en')
const title = computed(() => (zh.value ? '待我处理' : 'Needs me'))

const rootRef = ref<HTMLElement | null>(null)
/** 动态区最多展示多少条（其余只给一个「还有 N 条」提示，避免面板被通知撑长） */
const NOTICE_ROWS = 8
const visibleNotices = computed(() => notices.value.slice(0, NOTICE_ROWS))

/** 需要用户做选择（回答 / 裁决）时用宽版；只有运行状态类条目用中版；空态与「只有通知」用 200px */
const wide = computed(() => items.value.some((i) => i.kind === 'question' || i.kind === 'plan'))
const PANEL_WIDE = 420
const PANEL_REPORT = 300
const PANEL_COMPACT = 200

/** 当前应有的宽度（改这一处即可；measure() 读它，watch 后会自动重新定位） */
const panelWidth = computed(() => (wide.value ? PANEL_WIDE : items.value.length ? PANEL_REPORT : PANEL_COMPACT))
/** 紧凑版：收起通知的时间列等，给正文让位 */
const compact = computed(() => panelWidth.value <= 240)

/** 相对时间用的"现在"：面板打开时每 30 秒推进一次（不需要秒级精度） */
const now = ref(Date.now())
let nowTimer: ReturnType<typeof setInterval> | null = null
function startNowTimer(): void {
  if (nowTimer) return
  now.value = Date.now()
  nowTimer = setInterval(() => { now.value = Date.now() }, 30_000)
}
function stopNowTimer(): void {
  if (!nowTimer) return
  clearInterval(nowTimer)
  nowTimer = null
}

/** 定位结果：left + (top | bottom) + width + maxHeight。height 交给内容决定。 */
const pos = reactive<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number }>({
  left: 8,
  top: 48,
  width: PANEL_COMPACT,
  maxHeight: 480,
})

const popStyle = computed(() => {
  const style: Record<string, string> = {
    left: `${pos.left}px`,
    width: `${pos.width}px`,
    maxHeight: `${pos.maxHeight}px`,
  }
  if (pos.top !== undefined) style.top = `${pos.top}px`
  if (pos.bottom !== undefined) style.bottom = `${pos.bottom}px`
  return style
})

const GAP = 6
const MARGIN = 8

/**
 * 贴着锚点按钮定位（水平永远对齐窗口右侧）：
 * - 垂直：顶栏/窄窗口/左侧导航优先在按钮**下方**，下方放不下或按钮在底部导航时**向上**展开；
 * - 水平：`left = 视口宽 − 面板宽 − 8`，与窗口右边缘齐平（不跟按钮右边缘走）。
 */
function measure(): void {
  const el = panelAnchor.value
  const vw = window.innerWidth
  const vh = window.innerHeight
  const width = Math.min(panelWidth.value, Math.max(220, vw - MARGIN * 2))
  // 右对齐窗口右侧
  pos.left = Math.max(MARGIN, vw - width - MARGIN)
  pos.width = width
  if (!el || !el.isConnected) {
    pos.top = 48
    pos.bottom = undefined
    pos.maxHeight = Math.min(480, vh - 96)
    return
  }
  const r = el.getBoundingClientRect()
  const inBottomNav = !!el.closest('.bottom-nav')
  const spaceBelow = vh - r.bottom - GAP - MARGIN
  const spaceAbove = r.top - GAP - MARGIN
  const cap = Math.min(560, vh - MARGIN * 2)
  const MIN_BELOW = 132

  if (!inBottomNav && spaceBelow >= MIN_BELOW) {
    pos.top = r.bottom + GAP
    pos.bottom = undefined
    pos.maxHeight = Math.min(cap, spaceBelow)
  } else {
    pos.bottom = vh - r.top + GAP
    pos.top = undefined
    pos.maxHeight = Math.min(cap, Math.max(MIN_BELOW, spaceAbove))
  }
}

function scheduleMeasure(): void {
  nextTick(() => {
    if (!props.open) return
    measure()
  })
}

watch(() => props.open, (open) => {
  if (open) {
    // 打开即视为已读：动态是"刚才弹过什么"的回看，不是待办
    markNoticesRead()
    startNowTimer()
    scheduleMeasure()
  } else {
    stopNowTimer()
  }
})
watch(panelAnchor, () => { if (props.open) scheduleMeasure() })
// 宽度档位变化（回答完最后一个提问 / 动态从无到有）都要重新定位
watch(panelWidth, () => { if (props.open) scheduleMeasure() })

function onResize(): void { measure() }
function onDocDown(e: MouseEvent): void {
  const t = e.target as Node | null
  if (!t) return
  if (rootRef.value && rootRef.value.contains(t)) return
  const el = panelAnchor.value
  if (el && (el === t || el.contains(t))) return
  if (t instanceof Element && t.closest('.attention-entry')) return
  closePanel()
}

let listening = false
function bind(open: boolean): void {
  if (typeof window === 'undefined') return
  if (open && !listening) {
    listening = true
    window.addEventListener('resize', onResize)
    // capture：页面上任何滚动容器滚动都要跟着挪，否则浮层会飘走
    window.addEventListener('scroll', onResize, true)
    document.addEventListener('mousedown', onDocDown, true)
  } else if (!open && listening) {
    listening = false
    window.removeEventListener('resize', onResize)
    window.removeEventListener('scroll', onResize, true)
    document.removeEventListener('mousedown', onDocDown, true)
  }
}
watch(() => props.open, bind, { immediate: true })

onBeforeUnmount(() => {
  bind(false)
  stopNowTimer()
})

function noticeIcon(kind: NoticeKind): string {
  if (kind === 'success') return 'fa-check-circle-o'
  if (kind === 'error') return 'fa-times-circle-o'
  if (kind === 'warning') return 'fa-exclamation-triangle'
  return 'fa-info-circle'
}
</script>

<style scoped>
.attention-pop {
  position: fixed;
  z-index: 1550;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--backgroundColor);
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, .18);
  animation: attention-in .12s ease-out;
}
@keyframes attention-in {
  from { opacity: 0; transform: translateY(-3px); }
  to { opacity: 1; transform: none; }
}

.attention-head {
  flex-shrink: 0;
  height: 34px;
  padding: 0 10px;
  display: flex;
  align-items: center;
  gap: 6px;
  border-bottom: 1px solid var(--borderColor);
}
.attention-head-icon { font-size: 12px; opacity: .8; }
.attention-head-title { font-size: 12.5px; font-weight: 600; color: var(--fontActiveColor); }
.attention-head-count {
  font-size: 10px; line-height: 15px; min-width: 15px; padding: 0 4px;
  text-align: center; border-radius: 8px; color: #fff; background: #f56c6c;
}
.attention-close {
  margin-left: auto;
  width: 24px; height: 24px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: none; border-radius: 4px; background: none;
  color: var(--fontColor); cursor: pointer; font-size: 12px;
}
.attention-close:hover { background: var(--menuActiveColor); color: var(--fontActiveColor); }

/* 内容区：只有这里滚动，表头固定；max-height 由外层限制 */
.attention-scroll { min-height: 0; overflow-y: auto; padding: 8px 10px 10px; }

.attention-group { margin-bottom: 8px; }
.attention-group-title {
  margin: 2px 0 6px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: .02em;
  opacity: .55;
  display: flex;
  align-items: center;
  gap: 5px;
}
.attention-group-count { font-weight: 400; opacity: .8; }
.attention-clear {
  margin-left: auto;
  border: none; background: none; padding: 0 2px;
  color: var(--fontColor); opacity: .5; cursor: pointer; font-size: 11px;
}
.attention-clear:hover { opacity: 1; color: var(--fontActiveColor); }

/* 动态条目：一行一条，窄版也不会挤（文字单行省略，时间靠右） */
.attention-notice {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 2px;
  font-size: 11.5px;
  line-height: 1.4;
}
.notice-icon { flex-shrink: 0; font-size: 11px; opacity: .8; }
.n-success .notice-icon { color: #67c23a; }
.n-error .notice-icon { color: #f56c6c; }
.n-warning .notice-icon { color: #e6a23c; }
.n-info .notice-icon { color: #909399; }
.notice-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: .85;
}
.notice-time { flex-shrink: 0; font-size: 10px; opacity: .45; white-space: nowrap; }

/* 空态：一行高度（无条目时面板就该这么小） */
.attention-empty {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 12px 12px;
}
.attention-empty-icon { font-size: 14px; color: #67c23a; opacity: .85; }
.attention-empty-text { font-size: 12px; opacity: .7; }
.attention-empty-sub { font-size: 10.5px; opacity: .5; padding: 2px 2px 0; }

.attention-activity { padding-top: 2px; margin-top: 0; }
/* 只有「上面有待我处理条目」时才画分隔线：单独的通知列表不该在表头下多出一条边 */
.attention-activity.has-divider {
  border-top: 1px solid var(--borderColor);
  padding-top: 7px;
  margin-top: 2px;
}

/* 紧凑版（200px，空态 / 只有通知）：压缩内边距与字号，正文单行省略；**时间仍保留在右侧** */
.attention-compact .attention-head { padding: 0 8px; }
.attention-compact .attention-scroll { padding: 6px 8px 8px; }
.attention-compact .attention-group-title { margin: 1px 0 4px; }
.attention-compact .attention-notice { gap: 4px; padding: 3px 1px; }
.attention-compact .notice-time { font-size: 9.5px; opacity: .5; }
.attention-compact .attention-empty { padding: 10px 9px; gap: 6px; }
.attention-compact .attention-empty-text { font-size: 11.5px; }
</style>
