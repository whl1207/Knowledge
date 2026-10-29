<!--
  UsageChart.vue — 每日 token 消耗柱状图（输入在下、输出堆叠在上）

  为什么单独成组件：总体用量在「设置 → 通用 → 数据」，单个来源的用量在
  「设置 → 模型 → 来源」，两处画的是同一张图，只是数据来源不同。
  纯展示：数据由调用方按 range 传进来（`days` 是「日期 → {i,o}」的桶），
  这里只负责摊平补零、缩放、悬停提示与空状态，不带任何 IPC / 业务判断。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { buildUsageDaySeries, formatTokenCount, formatTokenCountExact, type UsageDayBucket } from '@/shared/usageStats'

const props = withDefaults(defineProps<{
  /** 日期 → {i,o} 的原始桶（可缺日，组件会按 range 补 0） */
  days: Record<string, UsageDayBucket>
  /** 7 / 30 / 90 / 0（0 = 全部，最多回看 366 天） */
  range: number
  /** 界面上是否用中文（日期/图例/提示文案） */
  zh: boolean
  /** 这个范围内完全没有数据时的提示 */
  emptyText?: string
}>(), {
  emptyText: '',
})

/**
 * 逻辑坐标：宽度 = 容器实际像素宽度（ResizeObserver 跟随窗口 / 侧栏变化重排），高度固定 132。
 * 之前把宽度写死 640、靠 viewBox 等比缩放：svg 的 height 固定后 `meet` 只会缩小不会放大，
 * 宽面板里图只画到 640、两侧留白，看着就像被限了最大宽度。
 */
const H = 132
const PAD = { l: 38, r: 8, t: 10, b: 18 }

const hostEl = ref<HTMLElement | null>(null)
const hostW = ref(640)
let ro: ResizeObserver | null = null

onMounted(() => {
  const el = hostEl.value
  if (!el || typeof ResizeObserver === 'undefined') return
  const measure = () => {
    const w = Math.round(el.clientWidth)
    if (w > 0 && Math.abs(w - hostW.value) > 0.5) hostW.value = w
  }
  measure()
  ro = new ResizeObserver(measure)
  ro.observe(el)
})
onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
})

const W = computed(() => Math.max(240, hostW.value))

const points = computed(() => buildUsageDaySeries(props.days, props.range))
const hasData = computed(() => points.value.some((d) => d.total > 0))
const maxValue = computed(() => {
  let max = 0
  for (const d of points.value) max = Math.max(max, d.total)
  return max > 0 ? max : 1
})

/** 柱子：输入在下、输出堆叠在上 */
const bars = computed(() => {
  const list = points.value
  const n = list.length
  if (!n) return []
  const innerW = W.value - PAD.l - PAD.r
  const innerH = H - PAD.t - PAD.b
  const step = innerW / n
  const scale = (v: number) => (v / maxValue.value) * innerH
  const barW = Math.max(1.5, Math.min(16, step * 0.66))
  return list.map((d, idx) => {
    const hI = scale(d.i)
    const hO = scale(d.o)
    const x = PAD.l + idx * step + (step - barW) / 2
    const baseY = PAD.t + innerH
    return { ...d, x, barW, hI, hO, yI: baseY - hI, yO: baseY - hI - hO }
  })
})

/** Y 轴网格：0 / 50% / 100% */
const grid = computed(() =>
  [0, 0.5, 1].map((f) => ({
    y: PAD.t + (H - PAD.t - PAD.b) * (1 - f),
    label: formatTokenCount(maxValue.value * f),
  })),
)

/** X 轴刻度：最多 6 个，避免日期重叠 */
const ticks = computed(() => {
  const list = bars.value
  const n = list.length
  if (!n) return []
  const step = Math.max(1, Math.ceil(n / 6))
  return list.filter((_, i) => i % step === 0 || i === n - 1)
})

const dayLabel = (date: string): string => (date.length >= 10 ? date.slice(5) : date)

const barTitle = (d: { date: string; i: number; o: number }): string =>
  props.zh
    ? `${d.date} · 输入 ${formatTokenCountExact(d.i)} · 输出 ${formatTokenCountExact(d.o)} · 合计 ${formatTokenCountExact(d.i + d.o)}`
    : `${d.date} · in ${formatTokenCountExact(d.i)} · out ${formatTokenCountExact(d.o)} · total ${formatTokenCountExact(d.i + d.o)}`
</script>

<template>
  <div class="usage-chart" ref="hostEl">
    <div v-if="hasData" class="usage-chart-canvas">
      <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="xMidYMid meet"
        role="img" :aria-label="zh ? '每日 token 消耗' : 'Daily token usage'">
        <g class="usage-grid">
          <line v-for="g in grid" :key="'g' + g.label + g.y" :x1="PAD.l" :x2="W - PAD.r" :y1="g.y" :y2="g.y"></line>
          <text v-for="g in grid" :key="'gt' + g.label + g.y" :x="PAD.l - 6" :y="g.y + 3" text-anchor="end">{{ g.label }}</text>
        </g>
        <g v-for="b in bars" :key="b.date">
          <title>{{ barTitle(b) }}</title>
          <rect v-if="b.hI > 0" class="bar-in" :x="b.x" :y="b.yI" :width="b.barW" :height="b.hI" rx="1"></rect>
          <rect v-if="b.hO > 0" class="bar-out" :x="b.x" :y="b.yO" :width="b.barW" :height="b.hO" rx="1"></rect>
        </g>
        <g class="usage-axis">
          <text v-for="t in ticks" :key="'x' + t.date" :x="t.x + t.barW / 2" :y="H - 5" text-anchor="middle">{{ dayLabel(t.date) }}</text>
        </g>
      </svg>
    </div>
    <div v-else class="usage-chart-empty">
      <i class="fa fa-area-chart"></i>
      <span>{{ emptyText || (zh ? '这个时间范围内没有用量。' : 'No usage in the selected range.') }}</span>
    </div>
    <div class="usage-chart-legend">
      <i class="sw sw-in"></i><span>{{ zh ? '输入' : 'Input' }}</span>
      <i class="sw sw-out"></i><span>{{ zh ? '输出' : 'Output' }}</span>
    </div>
  </div>
</template>

<style scoped>
.usage-chart { width: 100%; }
.usage-chart-canvas svg { display: block; width: 100%; height: 132px; }
.usage-grid line { stroke: var(--borderColor); stroke-width: 1; opacity: .55; }
.usage-grid text { fill: var(--fontColor); opacity: .45; font-size: 8px; }
.usage-axis text { fill: var(--fontColor); opacity: .55; font-size: 8px; }
/* 输入 = 主题色；输出 = 绿（与「在线」状态同一套色语义） */
.bar-in { fill: var(--fontActiveColor); opacity: .9; }
.bar-out { fill: #4CAF50; opacity: .85; }
svg rect { transition: opacity .12s; }
svg rect:hover { opacity: 1; }

.usage-chart-empty {
  display: flex; align-items: center; gap: 6px; font-size: 11px; opacity: .7;
  padding: 10px 2px; line-height: 1.5;
}
.usage-chart-empty i { font-size: 13px; opacity: .7; flex-shrink: 0; }

.usage-chart-legend {
  display: flex; align-items: center; gap: 4px; font-size: 10px; opacity: .62; margin-top: 2px;
}
.usage-chart-legend .sw { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
.usage-chart-legend .sw-in { background: var(--fontActiveColor); opacity: .9; }
.usage-chart-legend .sw-out { background: #4CAF50; opacity: .85; margin-left: 8px; }
</style>
