<!-- DashboardView.vue - 主页（数据看板：图表渲染 d3 + 地图展示 Leaflet） -->
<template>
  <div class="dc-dashboard-view scoll">
    <!-- 顶部工具栏：主页模式切换（hideToolbar 时由父级标签栏渲染，此处隐藏） -->
    <div v-if="charts.length && !hideToolbar" class="dc-dash-toolbar">
      <span class="dc-dash-toolbar-title"><i class="fa fa-home"></i> {{ t('主页') }}</span>
      <div class="dc-dash-mode-switch">
        <button
          class="dc-btn dc-btn-sm"
          :class="{ active: dashboardMode === 'flow' }"
          :title="t('图表按顺序自动排列')"
          @click="setDashboardMode('flow')"
        >
          <i class="fa fa-th-large"></i> {{ t('顺序排列') }}
        </button>
        <button
          class="dc-btn dc-btn-sm"
          :class="{ active: dashboardMode === 'free' }"
          :title="t('自定义拖放：拖动位置、调整大小、设置底图与悬浮层级')"
          @click="setDashboardMode('free')"
        >
          <i class="fa fa-arrows-alt"></i> {{ t('自定义拖放') }}
        </button>
      </div>
      <button
        v-if="dashboardMode === 'free'"
        class="dc-btn dc-btn-sm dc-dash-restore"
        :title="t('恢复默认布局：图表丢失或被遮挡时，重置为默认排布')"
        @click="resetFreeLayout"
      >
        <i class="fa fa-refresh"></i> {{ t('恢复布局') }}
      </button>
      <span v-if="dashboardMode === 'free'" class="dc-dash-mode-hint">
        <i class="fa fa-info-circle"></i>
        {{ t('拖拽标题移动、右下角调整大小；「置顶/置底」控制悬浮层级（可将地图设为底图）') }}
      </span>
    </div>

    <div v-if="!charts.length" class="dc-dash-empty">
      <i class="fa fa-dashboard"></i>
      <span>{{ t('暂无图表。请在画布中添加图表节点并连接数据源') }}</span>
    </div>

    <!-- 图表区：flow=顺序排列（grid 多列）；free=自定义拖放（绝对定位，尺寸随窗口等比缩放） -->
    <div
      v-if="charts.length"
      :class="dashboardMode === 'free' ? 'dc-dash-free' : 'dc-charts-grid'"
      ref="freeContainerRef"
    >
      <div
        v-for="c in charts"
        :key="c.chartId"
        class="dc-chart-card"
        :class="{
          'dc-chart-fullscreen': fullscreenId === c.chartId,
          // 全屏时移除 free 卡片样式，避免 absolute 定位覆盖 fixed 全屏
          'dc-free-card': dashboardMode === 'free' && fullscreenId !== c.chartId,
          'dc-free-dragging': draggingId === c.chartId,
          // 自由模式下变量节点：仅显示标签+数值的紧凑悬浮块
          'dc-free-value': dashboardMode === 'free' && c.type === 'value',
        }"
        :style="fullscreenId === c.chartId ? fullscreenStyle : (dashboardMode === 'free' ? freeCardStyle(c) : undefined)"
        @pointerdown="c.type === 'value' ? startDrag(c, $event) : undefined"
      >
        <div
          class="dc-chart-head"
          :class="{ 'dc-free-drag': dashboardMode === 'free' }"
          @pointerdown="c.type === 'value' ? undefined : startDrag(c, $event)"
        >
          <span class="dc-chart-title">{{ c.title }}</span>
          <!-- 锁定后隐藏类型与操作按钮，仅保留标题 -->
          <span v-if="!dashboardLocked && !(dashboardMode === 'free' && c.type === 'value')" class="dc-chart-type">{{ chartTypeLabel(c.type) }}</span>
          <template v-if="dashboardMode === 'free' && !dashboardLocked && c.type !== 'value'">
            <button class="dc-btn dc-btn-sm dc-free-zbtn" :title="t('置顶（悬浮到最上层）')" @click.stop="bringToFront(c)">
              <i class="fa fa-arrow-up"></i>
            </button>
            <button class="dc-btn dc-btn-sm dc-free-zbtn" :title="t('置底（作为底图）')" @click.stop="sendToBack(c)">
              <i class="fa fa-arrow-down"></i>
            </button>
          </template>
          <button
            v-if="!dashboardLocked && !(dashboardMode === 'free' && c.type === 'value')"
            class="dc-btn dc-btn-sm dc-fullscreen-btn"
            :title="fullscreenId === c.chartId ? t('退出全屏') : t('全屏')"
            @click="toggleFullscreen(c)"
          >
            <i class="fa" :class="fullscreenId === c.chartId ? 'fa-compress' : 'fa-expand'"></i>
          </button>
        </div>
        <div v-if="c.type === 'map'" class="dc-chart-body dc-map" :ref="(el) => setChartEl(c.chartId, el)"></div>
        <div v-else class="dc-chart-body" :ref="(el) => setChartEl(c.chartId, el)"></div>
        <!-- 自由模式：右下角调整大小手柄（变量节点仅调宽度） -->
        <div v-if="dashboardMode === 'free'" class="dc-free-resize" @pointerdown.stop="startResize(c, $event)"></div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onBeforeUnmount, onMounted } from 'vue'
import * as d3 from 'd3'
import 'leaflet/dist/leaflet.css'
import * as L from 'leaflet'
import { useDataCanvas } from '@/components/DataCanvas/store'
import { computeModel, type ComputeResults } from '@/components/DataCanvas/compute'
import type { Model, DcNode } from '@/components/DataCanvas/types'
import { createMbtilesLayer, pickPreferredMbSource } from '@/lib/mbTiles'

const props = withDefaults(defineProps<{ hideToolbar?: boolean }>(), { hideToolbar: false })
const emit = defineEmits<{
  chartClick: [data: { chartId: string; series: string; value: any }]
  'update:dashMode': [mode: 'flow' | 'free']
  'update:dashLocked': [locked: boolean]
}>()

const store = useDataCanvas()
const isEn = ref(false)
function t(zh: string): string { return isEn.value ? zh : zh }

const CHART_COLORS = ['#2196F3', '#4CAF50', '#FF9800', '#E91E63', '#9C27B0', '#00BCD4', '#FDD835', '#8BC34A']

interface ChartItem {
  chartId: string
  title: string
  type: string
  xField: string
  yField: string
  labelField: string
  valueField: string
  labels: (string | number)[]
  values: number[]
  hasData: boolean
  mapPoints?: MapPoint[]
  geojson?: any
  geojsonFill?: string
  geojsonStroke?: string
  mapPointStyle?: string
  mapPointColor?: string
  geojsonFillOpacity?: number
  geojsonStrokeOpacity?: number
  mapPointOpacity?: number
  unit?: string
  value?: any
}

interface MapPoint {
  name: string
  lat: number
  lng: number
  info: string
  value?: number
}

// ==================== 数据收集（当前模型 + 所有子画布） ====================
function walkModels(model: Model | null, visit: (m: Model, results: ComputeResults) => void, depth = 0) {
  if (!model || depth > (store.config.maxDepth || 5)) return
  const results = computeModel(model, store.models.value)
  visit(model, results)
  for (const n of model.nodes) {
    if (n.type === 'subcanvas') {
      walkModels(store.getModelById(n.data.modelId), visit, depth + 1)
    }
  }
}

// 从行中按字段取值：兼容对象行（row[列名]）与数组行（按列索引）
function rowValue(row: any, columns: string[], field: string | undefined): any {
  if (!field) return undefined
  if (Array.isArray(row)) {
    const idx = columns.indexOf(field)
    return idx >= 0 ? row[idx] : undefined
  }
  return row?.[field]
}
// 规范化列名：去除所有空白（含全角空格/隐藏字符）并转小写，用于容错匹配
function normKey(k: string): string {
  return String(k).replace(/\s+/g, '').toLowerCase()
}
// 从行数据按标签字段解析名称；返回空字符串表示不显示名称
function pickPointName(row: any, columns: string[], labF: string | undefined): string {
  // 用户显式配置过标签字段（含“不显示名称”空串）
  if (labF !== undefined && labF !== null) {
    if (labF === '') return ''
    const v = rowValue(row, columns, labF)
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v)
    // 容错：列名大小写/空白/隐藏字符差异
    if (Array.isArray(row)) {
      const ci = columns.findIndex((c) => normKey(c) === normKey(labF))
      if (ci >= 0) {
        const kv = row[ci]
        if (kv !== undefined && kv !== null && String(kv).trim() !== '') return String(kv)
      }
    } else {
      const key = Object.keys(row || {}).find((k) => normKey(k) === normKey(labF))
      if (key !== undefined) {
        const kv = row[key]
        if (kv !== undefined && kv !== null && String(kv).trim() !== '') return String(kv)
      }
    }
    return ''
  }
  // 未配置：自动尝试常见名称列
  for (const k of ['name', '名称', '姓名', 'label', '标签', 'title', '标题']) {
    const v = rowValue(row, columns, k)
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v)
  }
  return ''
}

const charts = computed<ChartItem[]>(() => {
  const out: ChartItem[] = []
  // 收集所有数据表节点的列单位（列名 → 单位），供图表数值显示
  const colUnits: Record<string, string> = {}
  walkModels(store.activeModel.value, (model) => {
    for (const n of model.nodes) {
      if (n.type === 'table' && n.data?.columnUnits) {
        for (const [c, u] of Object.entries(n.data.columnUnits)) {
          if (u) colUnits[c] = String(u)
        }
      }
    }
  })
  walkModels(store.activeModel.value, (model, results) => {
    for (const n of model.nodes) {
      if (n.type !== 'chart' && n.type !== 'variable') continue
      const r = results[n.id]
      const d = n.data || {}
      // 变量节点：仅显式勾选「在主页显示」才展示（默认关闭；旧节点无字段视为不显示）
      if (n.type === 'variable') {
        if (n.data?.showInDashboard !== true) continue
        const raw = r?.value
        out.push({
          chartId: n.id,
          title: n.name,
          type: 'value',
          xField: '',
          yField: '',
          labelField: '',
          valueField: '',
          unit: n.data?.unit || '',
          labels: [],
          values: [],
          hasData: raw !== undefined && raw !== null && raw !== '',
          value: raw,
        })
        continue
      }
      // 图表节点：默认开启，仅显式关闭时过滤
      if (n.data?.showInDashboard === false) continue
      const type = d.chartType || 'bar'
      // 数值单位：按图表数值字段（yField/valueField）匹配数据表列单位
      const unit = colUnits[d.yField] || colUnits[d.valueField] || ''
      const labels: (string | number)[] = []
      const values: number[] = []
      let mapPoints: MapPoint[] = []
      if (type === 'map') {
        // 地图类型：按配置的经度/纬度/数值/标签字段收集气泡点（兼容数组行与对象行）
        const src = r?.source
        if (src?.rows?.length) {
          const cols = src.columns || []
          const latF = d.latField
          const lngF = d.lngField
          const valF = d.valueField
          const labF = d.labelField
          if (latF && lngF) {
            src.rows.forEach((row: any, i: number) => {
              const lat = Number(rowValue(row, cols, latF))
              const lng = Number(rowValue(row, cols, lngF))
              if (isNaN(lat) || isNaN(lng)) return
              const rawV = valF ? Number(rowValue(row, cols, valF)) : NaN
              mapPoints.push({
                name: pickPointName(row, cols, labF),
                lat,
                lng,
                value: isNaN(rawV) ? undefined : rawV,
                info: JSON.stringify(row).slice(0, 200),
              })
            })
          }
        }
      } else {
        const multiSeries = r?.multiSeries || []
        // 图表节点无论是否已连接数据源都会出现在看板（无数据时显示占位提示）
        const hasData = !!(r?.source?.rows?.length || multiSeries.length)
        if (hasData) {
          if (multiSeries.length) {
            // 多条连线：按端口名/节点名自动生成类别（柱状/折线/饼图通用）
            for (const s of multiSeries) {
              labels.push(String(s.key))
              values.push(Number(s.value) || 0)
            }
          } else if (type === 'pie') {
            const lf = d.labelField
            const vf = d.valueField
            for (const row of r.source.rows) {
              labels.push(String(row[lf] ?? ''))
              values.push(Number(row[vf]) || 0)
            }
          } else {
            const xf = d.xField
            const yf = d.yField
            for (const row of r.source.rows) {
              labels.push(String(row[xf] ?? ''))
              values.push(Number(row[yf]) || 0)
            }
          }
        }
      }
      out.push({
        chartId: n.id,
        title: n.name,
        type,
        xField: d.xField || '',
        yField: d.yField || '',
        labelField: d.labelField || '',
        valueField: d.valueField || '',
        unit,
        labels,
        values,
        hasData: type === 'map' ? (mapPoints.length > 0 || hasGeojsonData(d.geojson)) : !!(r?.source?.rows?.length || r?.multiSeries?.length),
        mapPoints,
        geojson: d.geojson,
        geojsonFill: d.geojsonFill,
        geojsonStroke: d.geojsonStroke,
        mapPointStyle: d.mapPointStyle,
        mapPointColor: d.mapPointColor,
        geojsonFillOpacity: d.geojsonFillOpacity,
        geojsonStrokeOpacity: d.geojsonStrokeOpacity,
        mapPointOpacity: d.mapPointOpacity,
      })
    }
  })
  return out
})

// ==================== 图表渲染 ====================
const chartEls = new Map<string, HTMLElement | null>()
function setChartEl(id: string, el: unknown) {
  chartEls.set(id, el as HTMLElement | null)
}

// 重绘所有图表（数据变化 / 模式切换复用）
function rerenderAllCharts() {
  for (const c of charts.value) {
    const el = chartEls.get(c.chartId)
    if (!el) continue
    if (c.type === 'map') renderMap(el, c)
    else renderChart(el, c)
  }
}

watch(charts, async () => {
  await nextTick()
  rerenderAllCharts()
  // 自由模式下新出现的图表自动补默认布局（不覆盖已有）
  if (dashboardMode.value === 'free') ensureMissingLayouts()
}, { immediate: true, deep: true })

// ==================== 主页模式：顺序排列（flow）/ 自定义拖放（free） ====================
type DashboardMode = 'flow' | 'free'
const dashboardMode = ref<DashboardMode>('flow')
// 通知父级当前主页模式（父级标签栏据此渲染切换按钮高亮）
watch(dashboardMode, (m) => emit('update:dashMode', m), { immediate: true })

// 自由模式锁定：锁定后图表不可移动/缩放/调整层级（持久化到根模型 meta）
const dashboardLocked = ref(false)
watch(dashboardLocked, (v) => emit('update:dashLocked', v), { immediate: true })

// 自由布局：固定尺寸（px）+ 四角停靠（anchor + offset 比例 0~1，随窗口缩放贴边）
// 旧版归一化坐标（x/y/w/h 0~1）在加载时自动迁移
type DashAnchor = 'tl' | 'tr' | 'bl' | 'br' | 'l' | 'r' | 't' | 'b'
interface DashLayout { chartId: string; anchor: DashAnchor; offsetX: number; offsetY: number; width: number; height: number; z: number }
const dashLayouts = ref<DashLayout[]>([])

// 全屏状态（持久化到根模型 meta，切换标签页后恢复）
const fullscreenId = ref<string | null>(null)
const fullscreenStyle = ref<Record<string, string>>({})
// 自由模式退出时记住的全屏底图（切回自由模式时重新全屏恢复）
const freeFullscreenId = ref<string | null>(null)

// 布局配置存根模型 meta（随数据包导出/导入一并保存）
const rootModel = computed(() => store.getModelById(store.activeModelId.value) ?? store.activeModel.value)

function loadDashboardConfig() {
  const meta = rootModel.value?.meta
  dashboardMode.value = meta?.dashboardMode === 'free' ? 'free' : 'flow'
  dashboardLocked.value = !!meta?.dashboardLocked
  dashLayouts.value = Array.isArray(meta?.dashboardLayout)
    ? JSON.parse(JSON.stringify(meta.dashboardLayout))
    : []
  // 恢复已保存的全屏状态
  const fs = meta?.dashboardFullscreenId
  if (fs && charts.value.some((x) => x.chartId === fs)) {
    fullscreenId.value = fs
    nextTick(() => { updateFullscreenStyle(); observeDashboardSize() })
  } else {
    fullscreenId.value = null
  }
  // 自由模式缺布局时自动补齐，避免图表因无布局而被隐藏
  if (dashboardMode.value === 'free' && charts.value.length) ensureMissingLayouts()
}
watch(rootModel, loadDashboardConfig, { immediate: true })

function saveDashboardConfig() {
  const m = rootModel.value
  if (!m) return
  const meta = {
    params: [],
    formFields: [],
    formRecords: [],
    ...(m.meta || {}),
    dashboardMode: dashboardMode.value,
    dashboardLayout: dashLayouts.value,
    dashboardLocked: dashboardLocked.value,
  }
  store.updateModel(m.id, { meta })
}

// 保存当前全屏状态（随数据包导入导出，切换标签页后恢复）
function persistFullscreenId() {
  const m = rootModel.value
  if (!m) return
  const meta = {
    params: [],
    formFields: [],
    formRecords: [],
    ...(m.meta || {}),
    dashboardFullscreenId: fullscreenId.value ?? undefined,
  }
  store.updateModel(m.id, { meta })
}

// 自由模式下为缺失布局的图表自动补默认布局（按网格排布，不覆盖已有），变化后保存
function ensureMissingLayouts() {
  const existing = new Set(dashLayouts.value.map((l) => l.chartId))
  const maxZ = dashLayouts.value.length ? Math.max(...dashLayouts.value.map((l) => l.z)) : -1
  let z = maxZ
  let changed = false
  charts.value.forEach((c, i) => {
    if (existing.has(c.chartId)) return
    z += 1
    changed = true
    dashLayouts.value.push({
      chartId: c.chartId,
      anchor: 'tl',
      offsetX: 12 + (i % 5) * 24,
      offsetY: 12 + (i % 5) * 24,
      width: 340,
      height: 240,
      z,
    })
  })
  if (changed) saveDashboardConfig()
}

function setDashboardMode(mode: DashboardMode) {
  if (dashboardMode.value === mode) return
  const prev = dashboardMode.value
  dashboardMode.value = mode
  // 从自由模式切回顺序排列：记住全屏底图并全部还原（顺序排列下不保持全屏）
  if (prev === 'free' && mode === 'flow') {
    freeFullscreenId.value = fullscreenId.value
    exitFullscreen()
  }
  // 回到自由模式：恢复原有布局，且之前全屏的图表重新全屏（作为底图）
  if (mode === 'free') {
    ensureMissingLayouts()
    const restoreId = freeFullscreenId.value
    freeFullscreenId.value = null
    if (restoreId && fullscreenId.value !== restoreId) {
      const c = charts.value.find((x) => x.chartId === restoreId)
      if (c) nextTick(() => enterFullscreen(c))
    }
  }
  saveDashboardConfig()
  nextTick(() => {
    rerenderAllCharts()
    for (const c of charts.value) invalidateMap(c.chartId)
  })
}

function layoutFor(chartId: string): DashLayout | undefined {
  return dashLayouts.value.find((l) => l.chartId === chartId)
}

function updateLayout(chartId: string, patch: Partial<DashLayout>, persistNow = false) {
  let l = layoutFor(chartId)
  if (!l) {
    l = { chartId, anchor: 'tl', offsetX: 12, offsetY: 12, width: 340, height: 240, z: 0 }
    dashLayouts.value.push(l)
  }
  Object.assign(l, patch)
  if (persistNow) saveDashboardConfig()
}

// 卡片相对容器左上角的像素位置（按停靠锚点 + 固定像素偏移换算，供拖拽/吸附计算）
function cardRectInContainer(l: DashLayout, r: DOMRect): { left: number; top: number } {
  switch (l.anchor) {
    case 'tr':
    case 'r': return { left: r.width - l.width - l.offsetX, top: l.offsetY }
    case 'bl':
    case 'b': return { left: l.offsetX, top: r.height - l.height - l.offsetY }
    case 'br': return { left: r.width - l.width - l.offsetX, top: r.height - l.height - l.offsetY }
    default: return { left: l.offsetX, top: l.offsetY } // tl / l / t
  }
}

// 吸附阈值：拖动时卡片靠近容器边界/四角即自动吸附贴边
const SNAP_THRESHOLD = 30
function findSnapAnchor(left: number, top: number, w: number, h: number, r: DOMRect): { anchor: DashAnchor; offsetX: number; offsetY: number } | null {
  const cands = [
    // 四角
    { anchor: 'tl' as const, dist: Math.hypot(left, top), offsetX: left, offsetY: top },
    { anchor: 'tr' as const, dist: Math.hypot(r.width - (left + w), top), offsetX: r.width - (left + w), offsetY: top },
    { anchor: 'bl' as const, dist: Math.hypot(left, r.height - (top + h)), offsetX: left, offsetY: r.height - (top + h) },
    { anchor: 'br' as const, dist: Math.hypot(r.width - (left + w), r.height - (top + h)), offsetX: r.width - (left + w), offsetY: r.height - (top + h) },
    // 四边
    { anchor: 'l' as const, dist: left, offsetX: left, offsetY: top },
    { anchor: 'r' as const, dist: r.width - (left + w), offsetX: r.width - (left + w), offsetY: top },
    { anchor: 't' as const, dist: top, offsetX: left, offsetY: top },
    { anchor: 'b' as const, dist: r.height - (top + h), offsetX: left, offsetY: r.height - (top + h) },
  ]
  let best: (typeof cands)[0] | null = null
  for (const c of cands) {
    if (c.dist <= SNAP_THRESHOLD && (!best || c.dist < best.dist)) best = c
  }
  return best ? { anchor: best.anchor, offsetX: Math.max(0, best.offsetX), offsetY: Math.max(0, best.offsetY) } : null
}

// 旧版布局迁移 → 固定尺寸 + 像素偏移：
//  1) 更旧归一化布局（x/y/w/h 0~1）→ anchor tl + 像素尺寸/偏移
//  2) 上一版比例偏移（offset 0~1）→ 换算为固定像素偏移
function migrateLegacyLayouts() {
  const el = freeContainerRef.value
  if (!el) return
  const r = el.getBoundingClientRect()
  if (!r.width || !r.height) return
  let changed = false
  for (const l of dashLayouts.value) {
    const old = l as unknown as { x?: number; y?: number; w?: number; h?: number }
    if (typeof old.w === 'number' && typeof old.x === 'number') {
      l.anchor = 'tl'
      l.width = Math.max(200, Math.round((old.w ?? 0.4) * r.width))
      l.height = Math.max(140, Math.round((old.h ?? 0.3) * r.height))
      l.offsetX = Math.round((old.x ?? 0) * r.width)
      l.offsetY = Math.round((old.y ?? 0) * r.height)
      delete (l as any).x
      delete (l as any).y
      delete (l as any).w
      delete (l as any).h
      changed = true
    } else if (l.offsetX >= 0 && l.offsetX <= 1 && l.offsetY >= 0 && l.offsetY <= 1) {
      // 上一版比例偏移（0~1）→ 固定像素（随窗口缩放时保持像素距离）
      l.offsetX = Math.round(l.offsetX * r.width)
      l.offsetY = Math.round(l.offsetY * r.height)
      changed = true
    }
  }
  if (changed) saveDashboardConfig()
}

// 固定尺寸 + 四角停靠样式：宽高固定 px，偏移用 CSS 百分比 → 窗口缩放时自动按比例贴边
function freeCardStyle(c: ChartItem) {
  const l = layoutFor(c.chartId)
  if (!l) return { display: 'none' }
  // 防御：布局数据异常时仍保证可见尺寸（避免 0/NaN 导致图表消失）
  const w = isFinite(l.width) && l.width > 0 ? l.width : 340
  const h = isFinite(l.height) && l.height > 0 ? l.height : 240
  // 拖拽中的卡片临时浮到最上层（松手后恢复原层级）；z 从 0（底图）开始，加偏移保证可见
  const z = draggingId.value === c.chartId ? 9999 : 10 + l.z
  const s: Record<string, string> = {
    width: `${Math.round(w)}px`,
    height: `${Math.round(h)}px`,
    zIndex: String(z),
  }
  // 变量节点：高度自适应内容（单行标签+数值），避免面板过高
  if (c.type === 'value') {
    s.height = 'auto'
    s.minHeight = '0'
  }
  // 偏移用固定像素：缩放窗口时距锚点/边界的像素距离保持不变
  switch (l.anchor) {
    case 'tr':
    case 'r': s.right = `${Math.round(l.offsetX)}px`; s.top = `${Math.round(l.offsetY)}px`; break
    case 'bl':
    case 'b': s.left = `${Math.round(l.offsetX)}px`; s.bottom = `${Math.round(l.offsetY)}px`; break
    case 'br': s.right = `${Math.round(l.offsetX)}px`; s.bottom = `${Math.round(l.offsetY)}px`; break
    default: s.left = `${Math.round(l.offsetX)}px`; s.top = `${Math.round(l.offsetY)}px` // tl / l / t
  }
  return s
}

// ==================== 自由模式交互：拖动 / 调整大小 / 层级 ====================
const freeContainerRef = ref<HTMLElement | null>(null)
const draggingId = ref<string | null>(null)
let dragSession: { chartId: string; startX: number; startY: number; origX: number; origY: number; origW: number; origH: number; resize: boolean; resizeWOnly?: boolean } | null = null

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function startDrag(c: ChartItem, e: PointerEvent) {
  if (dashboardMode.value !== 'free' || dashboardLocked.value || e.button !== 0) return
  // 点击按钮不触发拖动
  if ((e.target as HTMLElement)?.closest?.('button')) return
  e.preventDefault()
  beginDragSession(c, e, false)
}

function startResize(c: ChartItem, e: PointerEvent) {
  if (dashboardMode.value !== 'free' || dashboardLocked.value || e.button !== 0) return
  e.preventDefault()
  beginDragSession(c, e, true)
}

function beginDragSession(c: ChartItem, e: PointerEvent, resize: boolean) {
  const el = freeContainerRef.value
  const l = layoutFor(c.chartId)
  if (!el || !l) return
  const r = el.getBoundingClientRect()
  // 记录卡片当前相对容器左上角的像素位置
  const { left, top } = cardRectInContainer(l, r)
  dragSession = {
    chartId: c.chartId,
    startX: e.clientX,
    startY: e.clientY,
    origX: left,
    origY: top,
    origW: l.width,
    origH: l.height,
    resize,
    // 变量节点：只调宽度（高度自适应内容）
    resizeWOnly: resize && c.type === 'value',
  }
  draggingId.value = c.chartId
  window.addEventListener('pointermove', onDragSessionMove)
  window.addEventListener('pointerup', onDragSessionEnd)
}

function onDragSessionMove(e: PointerEvent) {
  const s = dragSession
  const el = freeContainerRef.value
  if (!s || !el) return
  const r = el.getBoundingClientRect()
  const dx = e.clientX - s.startX
  const dy = e.clientY - s.startY
  if (s.resize) {
    // 调整大小：更新固定宽高（px）；最小尺寸兜底（容器过小时也不允许缩到 0）
    const w = clamp(s.origW + dx, 160, Math.max(160, r.width))
    if (s.resizeWOnly) {
      // 变量节点：仅调整宽度（高度保持自适应内容）
      updateLayout(s.chartId, { width: Math.round(w) })
    } else {
      const h = clamp(s.origH + dy, 120, Math.max(120, r.height))
      updateLayout(s.chartId, { width: Math.round(w), height: Math.round(h) })
    }
  } else {
    // 拖动：以像素定位，靠近四角/四边时自动吸附贴边；否则按卡片所在象限自动锚定
    // （偏右用 right、偏下用 bottom，缩放窗口时保持距所在边界的像素距离）
    const left = clamp(s.origX + dx, 0, Math.max(0, r.width - s.origW))
    const top = clamp(s.origY + dy, 0, Math.max(0, r.height - s.origH))
    const snap = findSnapAnchor(left, top, s.origW, s.origH, r)
    if (snap) {
      updateLayout(s.chartId, { anchor: snap.anchor, offsetX: Math.round(snap.offsetX), offsetY: Math.round(snap.offsetY) })
    } else {
      const toRight = left > r.width / 2
      const toBottom = top > r.height / 2
      let anchor: DashAnchor = 'tl'
      let offsetX = left
      let offsetY = top
      if (toRight) { anchor = 'tr'; offsetX = r.width - left - s.origW }
      if (toBottom) { anchor = toRight ? 'br' : 'bl'; offsetY = r.height - top - s.origH }
      updateLayout(s.chartId, { anchor, offsetX: Math.round(offsetX), offsetY: Math.round(offsetY) })
    }
  }
  invalidateMap(s.chartId)
}

function onDragSessionEnd() {
  if (dragSession) {
    saveDashboardConfig()
    invalidateMap(dragSession.chartId)
  }
  dragSession = null
  draggingId.value = null
  window.removeEventListener('pointermove', onDragSessionMove)
  window.removeEventListener('pointerup', onDragSessionEnd)
}

// 切换自由模式锁定（锁定后图表不可移动/缩放/调整层级）
function toggleDashboardLock() {
  dashboardLocked.value = !dashboardLocked.value
  saveDashboardConfig()
}

// 层级控制：置顶（悬浮到最上层）/ 置底（z=0，作为底图，永不被遮挡）；锁定状态下禁用
function bringToFront(c: ChartItem) {
  if (dashboardLocked.value) return
  const zs = dashLayouts.value.map((l) => l.z)
  updateLayout(c.chartId, { z: (zs.length ? Math.max(...zs) : 0) + 1 }, true)
}
function sendToBack(c: ChartItem) {
  if (dashboardLocked.value) return
  updateLayout(c.chartId, { z: 0 }, true)
}

// 恢复默认布局：退出全屏 + 重置所有卡片为默认排布（图表丢失/被遮挡时使用）
function resetFreeLayout() {
  // 先退出全屏（全屏底图可能被悬浮卡片完全遮挡）
  const fs = fullscreenId.value
  if (fs) {
    const c = charts.value.find((x) => x.chartId === fs)
    if (c) toggleFullscreen(c)
  }
  dashLayouts.value = charts.value.map((c, i) => ({
    chartId: c.chartId,
    anchor: 'tl',
    offsetX: 0.03 + (i % 5) * 0.03,
    offsetY: 0.03 + (i % 5) * 0.03,
    width: 340,
    height: 240,
    z: i,
  }))
  saveDashboardConfig()
  nextTick(() => {
    rerenderAllCharts()
    for (const c of charts.value) invalidateMap(c.chartId)
  })
}

// 地图实例尺寸变化后需重新测量（leaflet invalidateSize）
function invalidateMap(chartId: string) {
  const inst = mapInstances.get(chartId)
  if (!inst) return
  requestAnimationFrame(() => {
    try { inst.map.invalidateSize() } catch { /* ignore */ }
  })
}

// 变量数值卡片格式化：数字保留两位，对象/数组紧凑展示
function formatVarValue(v: any): string {
  if (typeof v === 'number') {
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100)
  }
  if (typeof v === 'string') return escapeHtml(v)
  if (v && typeof v === 'object') {
    try {
      return `<pre style="margin:0;font-size:11px;text-align:left;max-height:100%;overflow:auto">${escapeHtml(JSON.stringify(v, null, 2))}</pre>`
    } catch { return '' }
  }
  return escapeHtml(String(v ?? ''))
}

function renderChart(el: HTMLElement, c: ChartItem) {
  d3.select(el).selectAll('*').remove()
  if (!c.hasData) {
    d3.select(el).append('div').attr('class', 'dc-chart-empty').text('暂无数据，请连接数据源')
    return
  }
  // 数值卡片（变量节点）：大号结果显示计算结果
  if (c.type === 'value') {
    const txt = formatVarValue(c.value)
    const unitHtml = c.unit ? `<span class="dc-var-unit">${escapeHtml(c.unit)}</span>` : ''
    d3.select(el)
      .append('div')
      .attr('class', 'dc-var-value')
      .html(`<div class="dc-var-value-text">${txt}${unitHtml ? ' ' + unitHtml : ''}</div>`)
    return
  }
  // 图表尺寸跟随图表区实际宽高：窗口拉宽时图表同步变宽（文字不变形、不溢出）
  const W = Math.max(280, Math.round(el.clientWidth || 340))
  const H = Math.max(140, Math.round(el.clientHeight || 220))
  const margin = { top: 12, right: 12, bottom: 34, left: 42 }
  const svg = d3.select(el)
    .append('svg')
    .attr('class', 'dc-chart-svg')
    .attr('width', '100%')
    .attr('height', '100%')
    .attr('viewBox', `0 0 ${W} ${H}`)
    .attr('preserveAspectRatio', 'xMidYMid meet')
    .style('overflow', 'visible')
  const g = svg.append('g')

  const clickChart = (series: string, value: any) => {
    emit('chartClick', { chartId: c.chartId, series, value })
  }

  if (c.type === 'pie') {
    const radius = Math.min(W, H) / 2 - 16
    const pieG = g.append('g').attr('transform', `translate(${W / 2},${H / 2 + 4})`)
    const pie = d3.pie<number>().sort(null)(c.values)
    const arc = d3.arc<d3.PieArcDatum<number>>().innerRadius(0).outerRadius(radius)
    const color = d3.scaleOrdinal<string>().domain(c.labels.map(String)).range(CHART_COLORS)
    pieG.selectAll('path').data(pie).enter().append('path')
      .attr('d', arc as any)
      .attr('fill', (d) => color(String(c.labels[d.index])))
      .style('stroke', 'var(--backgroundColor)')
      .style('cursor', 'pointer')
      .on('click', (_ev, d) => clickChart(String(c.labels[d.index]), d.value))
    pieG.selectAll('path').data(pie).enter().append('title')
      .text((d) => `${c.labels[d.index]}: ${d.value}${c.unit ? ' ' + c.unit : ''}`)
    // 标签（饼图外侧 + 引导线，颜色跟随主题）
    const labelArc = d3.arc<d3.PieArcDatum<number>>().innerRadius(radius).outerRadius(radius + 20)
    const midAngle = (d: d3.PieArcDatum<number>) => d.startAngle + (d.endAngle - d.startAngle) / 2
    // 引导线：扇区中部 → 外侧标签
    pieG.selectAll('polyline').data(pie).enter().append('polyline')
      .attr('points', (d) => {
        const mid = arc.centroid(d)
        const pos = labelArc.centroid(d)
        return `${mid[0]},${mid[1]} ${pos[0]},${pos[1]}`
      })
      .style('stroke', (d) => color(String(c.labels[d.index])))
      .style('stroke-width', 1)
      .style('fill', 'none')
      .style('opacity', 0.5)
    // 标签：左侧扇区靠右对齐、右侧扇区靠左对齐，避免超出图表
    pieG.selectAll('text').data(pie).enter().append('text')
      .attr('transform', (d) => `translate(${labelArc.centroid(d)})`)
      .attr('text-anchor', (d) => (midAngle(d) < Math.PI ? 'start' : 'end'))
      .attr('font-size', 15)
      .attr('font-weight', 600)
      .style('fill', 'var(--fontColor)')
      .text((d) => (d.value > 0 ? String(c.labels[d.index]) : ''))
    return
  }

  // 柱状 / 折线
  const x = d3.scaleBand<string>()
    .domain(c.labels.map(String))
    .range([margin.left, W - margin.right])
    .padding(0.25)
  const y = d3.scaleLinear()
    .domain([0, d3.max(c.values) || 1])
    .nice()
    .range([H - margin.bottom, margin.top])

  // 数值单位（显示在图表右上角，如 万元/人）
  if (c.unit) {
    g.append('text')
      .attr('x', W - margin.right)
      .attr('y', margin.top - 8)
      .attr('text-anchor', 'end')
      .attr('font-size', 9)
      .attr('fill', '#FF9800')
      .text(c.unit)
  }

  g.append('g')
    .attr('transform', `translate(0,${H - margin.bottom})`)
    .call(d3.axisBottom(x))
    .selectAll('text').attr('font-size', 8).attr('transform', 'rotate(-25)').style('text-anchor', 'end')

  g.append('g')
    .attr('transform', `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(4))
    .selectAll('text').attr('font-size', 8)

  // 使用携带索引的对象数据，便于点击回调
  const data = c.values.map((v, i) => ({ v, i }))
  const labelOf = (d: { i: number }) => String(c.labels[d.i])

  if (c.type === 'line') {
    const line = d3.line<{ v: number; i: number }>()
      .x((d) => (x(labelOf(d)) || 0) + x.bandwidth() / 2)
      .y((d) => y(d.v))
      .curve(d3.curveMonotoneX)
    g.append('path')
      .datum(data)
      .attr('fill', 'none')
      .attr('stroke', CHART_COLORS[0])
      .attr('stroke-width', 2)
      .attr('d', line as any)
    g.selectAll('circle').data(data).enter().append('circle')
      .attr('cx', (d) => (x(labelOf(d)) || 0) + x.bandwidth() / 2)
      .attr('cy', (d) => y(d.v))
      .attr('r', 3)
      .attr('fill', CHART_COLORS[0])
      .style('cursor', 'pointer')
      .on('click', (_ev, d) => clickChart(labelOf(d), d.v))
    g.selectAll('circle').data(data).enter().append('title')
      .text((d) => `${labelOf(d)}: ${d.v}${c.unit ? ' ' + c.unit : ''}`)
  } else {
    g.selectAll('rect').data(data).enter().append('rect')
      .attr('x', (d) => x(labelOf(d)) || 0)
      .attr('y', (d) => y(d.v))
      .attr('width', x.bandwidth())
      .attr('height', (d) => H - margin.bottom - y(d.v))
      .attr('fill', (d) => CHART_COLORS[d.i % CHART_COLORS.length])
      .style('cursor', 'pointer')
      .on('click', (_ev, d) => clickChart(labelOf(d), d.v))
    g.selectAll('rect').data(data).enter().append('title')
      .text((d) => `${labelOf(d)}: ${d.v}${c.unit ? ' ' + c.unit : ''}`)
  }
}

function chartTypeLabel(type: string): string {
  return type === 'bar' ? '柱状图' : type === 'line' ? '折线图' : type === 'map' ? '地图' : type === 'value' ? '数值' : '饼图'
}

// ==================== 地图渲染（按卡片独立 Leaflet 实例，与其他图表同尺寸） ====================
const mapInstances = new Map<string, { map: L.Map; layer: L.LayerGroup; ro?: ResizeObserver }>()
// 底图源（内置/挂载的 MBTiles 包）只取一次，各卡片共用
let mbBaseSource: Promise<any | null> | null = null
function ensureMbBaseSource(): Promise<any | null> {
  if (!mbBaseSource) {
    mbBaseSource = (async () => {
      try {
        const list = (await window.dsh?.mapTiles?.list?.()) || []
        return pickPreferredMbSource(list)
      } catch {
        return null
      }
    })()
  }
  return mbBaseSource
}

function renderMap(el: HTMLElement, c: ChartItem) {
  const points = c.mapPoints || []
  const gj = c.geojson
  const hasGj = hasGeojsonData(gj)
  let inst = mapInstances.get(c.chartId)
  if (!points.length && !hasGj) {
    if (inst) { inst.ro?.disconnect(); inst.map.remove(); mapInstances.delete(c.chartId) }
    return
  }
  if (!inst) {
    // 底图：内置/挂载的 MBTiles 离线包（单文件，主进程按需读取）；无可用包时不加底图，仅显示数据层
    const initLat = hasGj ? 0 : (points[0]?.lat ?? 0)
    const initLng = hasGj ? 0 : (points[0]?.lng ?? 0)
    inst = {
      map: L.map(el, { zoomControl: false, attributionControl: false }).setView([initLat, initLng], 4),
      layer: L.layerGroup(),
    }
    const chartId = c.chartId
    ensureMbBaseSource().then((src) => {
      // 底图异步就绪前，地图可能已被销毁/重建
      if (mapInstances.get(chartId) !== inst || !inst) return
      try {
        if (src) {
          inst.map.setMinZoom(src.minZoom || 4)
          inst.map.setMaxZoom(src.maxZoom || 7)
          createMbtilesLayer(src, { placeholder: 'public/errorMap.png' }).addTo(inst.map)
        }
        inst.map.invalidateSize()
      } catch (err) {
        console.warn('[Dashboard] 底图加载失败', err)
      }
    })
    inst.layer.addTo(inst.map)
    mapInstances.set(c.chartId, inst)
    // 监听容器尺寸变化自动重测（grid 行高 / 窗口缩放 / 模式切换时地图始终铺满）
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        try { inst?.map.invalidateSize() } catch { /* ignore */ }
      })
      ro.observe(el)
      inst.ro = ro
    }
    // 容器可能刚由 v-if 显示，确保 Leaflet 拿到正确尺寸
    requestAnimationFrame(() => inst?.map.invalidateSize())
  }
  inst.layer.clearLayers()
  const bounds: [number, number][] = []
  // 同时渲染 GeoJSON 图层（面/线/点/名称标记）与字段点标记
  const gjFill = c.geojsonFill || '#2196F3'
  const gjStroke = c.geojsonStroke || '#4FC3F7'
  const gjFillOpacity = c.geojsonFillOpacity ?? 0.45
  const gjStrokeOpacity = c.geojsonStrokeOpacity ?? 1
  if (hasGj) {
    try {
      renderGeojsonLayers(inst.layer, gj, bounds, gjFill, gjStroke, gjFillOpacity, gjStrokeOpacity)
    } catch (err) {
      console.warn('[Dashboard] GeoJSON 渲染失败', err)
    }
  }
  // 数据点：按配置样式渲染（圆形气泡/柱状柱/分级配色/菱形）
  if (points.length) {
    renderFieldPoints(inst.map, inst.layer, points, c.mapPointStyle || 'circle', c.mapPointColor || '#2196F3', bounds, c.mapPointOpacity)
  }
  if (bounds.length > 1) inst.map.fitBounds(L.latLngBounds(bounds))
  else if (bounds.length === 1) inst.map.setView(bounds[0], Math.max(inst.map.getZoom(), 5))
}

// ==================== 数据点渲染（流入字段点：圆形/柱状/分级配色/菱形） ====================
// 数值 → 颜色插值（蓝 #2196F3 → 黄 #FFC107 → 红 #F44336）
function heatColor(v: number | undefined, vMin: number, vMax: number): string {
  if (typeof v !== 'number' || isNaN(v)) return '#9E9E9E'
  const t = vMax <= vMin ? 0.5 : (v - vMin) / (vMax - vMin)
  const stops: [number, [number, number, number]][] = [
    [0, [33, 150, 243]],
    [0.5, [255, 193, 7]],
    [1, [244, 67, 54]],
  ]
  const seg = t <= 0.5 ? 0 : 1
  const a = stops[seg][1]
  const b = stops[seg + 1][1]
  const lt = t <= 0.5 ? t / 0.5 : (t - 0.5) / 0.5
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * lt)},${Math.round(a[1] + (b[1] - a[1]) * lt)},${Math.round(a[2] + (b[2] - a[2]) * lt)})`
}

// 按配置样式渲染数据点；bar/diamond 用像素坐标换算成经纬度多边形，随缩放保持屏幕尺寸
function renderFieldPoints(
  map: L.Map,
  layer: L.LayerGroup,
  points: MapPoint[],
  style: string,
  baseColor: string,
  bounds: [number, number][],
  opacity?: number,
) {
  const vals = points.map((p) => p.value).filter((v): v is number => typeof v === 'number' && !isNaN(v))
  const vMin = vals.length ? Math.min(...vals) : 0
  const vMax = vals.length ? Math.max(...vals) : 1
  const radiusOf = (v?: number) => {
    if (typeof v !== 'number' || isNaN(v)) return 4
    if (vMax <= vMin) return 14
    return 10 + ((v - vMin) / (vMax - vMin)) * 22
  }
  const pxToLatLng = (x: number, y: number) => map.layerPointToLatLng(L.point(x, y))
  // 透明度：未设置时按样式取默认（保持既有观感），用户可全局覆盖
  const defaultOp = style === 'bar' ? 0.75 : style === 'diamond' ? 0.6 : style === 'gradient' ? 0.8 : 0.35
  const op = typeof opacity === 'number' ? opacity : defaultOp
  for (const p of points) {
    bounds.push([p.lat, p.lng])
    const r = radiusOf(p.value)
    const c = map.latLngToLayerPoint([p.lat, p.lng])
    let shape: L.Layer
    if (style === 'bar') {
      // 柱状柱：宽度固定 12px，高度按数值（底部在点上，向上延伸）
      const h = Math.max(6, r * 1.8)
      const w = 12
      shape = L.polygon([
        pxToLatLng(c.x - w / 2, c.y),
        pxToLatLng(c.x + w / 2, c.y),
        pxToLatLng(c.x + w / 2, c.y - h),
        pxToLatLng(c.x - w / 2, c.y - h),
      ], { color: baseColor, weight: 1, fillColor: baseColor, fillOpacity: op })
    } else if (style === 'diamond') {
      // 菱形：对角线长度按数值
      shape = L.polygon([
        pxToLatLng(c.x, c.y - r),
        pxToLatLng(c.x + r, c.y),
        pxToLatLng(c.x, c.y + r),
        pxToLatLng(c.x - r, c.y),
      ], { color: baseColor, weight: 1, fillColor: baseColor, fillOpacity: op })
    } else {
      // circle / gradient：圆形标记；gradient 按数值插值颜色（蓝→黄→红）
      const fill = style === 'gradient' ? heatColor(p.value, vMin, vMax) : baseColor
      shape = L.circleMarker([p.lat, p.lng], {
        radius: style === 'gradient' ? Math.max(6, r * 0.8) : r,
        color: '#fff',
        weight: 1,
        fillColor: fill,
        fillOpacity: op,
      })
    }
    // 永久标签（名称 + 数值），点击显示详情
    const labelText = p.name
      ? (p.value !== undefined ? `${p.name} ${p.value}` : p.name)
      : (p.value !== undefined ? String(p.value) : '')
    if (labelText) {
      shape.bindTooltip(labelText, {
        permanent: true,
        direction: 'top',
        offset: [0, -(r + 3)],
        className: 'dc-map-label',
        opacity: 0.95,
      })
    }
    shape
      .bindPopup(`<b>${p.name || '未命名'}</b><br/>${p.value !== undefined ? `数值：${p.value}<br/>` : ''}${p.info}`)
      .addTo(layer)
  }
}

// ==================== GeoJSON 渲染 ====================
// 判断 GeoJSON 是否含可渲染数据
function hasGeojsonData(gj: any): boolean {
  if (!gj) return false
  if (Array.isArray(gj.features)) return gj.features.length > 0
  return !!(gj.geometry)
}

// 用 Leaflet 官方 GeoJSON 渲染：自动支持 Point/MultiPoint/LineString/Polygon/MultiPolygon
// 面/线要素的名称标签由 Leaflet 自动置于几何中心；收集 bounds
function renderGeojsonLayers(layer: L.LayerGroup, gj: any, bounds: [number, number][], fillColor: string, strokeColor: string, fillOpacity: number, strokeOpacity: number) {
  if (!gj) return
  // 省名标签：位置优先用数据自带中心（center/cp/centroid 等），否则用边界框中心
  const labels: { name: string; pos: L.LatLng | null }[] = []
  const geoLayer = L.geoJSON(gj as any, {
    style: () => ({ color: strokeColor, weight: 3, opacity: strokeOpacity, fillColor: fillColor, fillOpacity: fillOpacity }),
    pointToLayer: (feature, latlng) =>
      L.circleMarker(latlng, { radius: 7, color: '#fff', fillColor: '#2196F3', fillOpacity: 0.85, weight: 2 }),
    onEachFeature: (feature, fLayer) => {
      const props = feature.properties || {}
      const name = props.name || props.Name || props.title || props.label || props['名称'] || ''
      const popupHtml = geojsonPopupHtml(name, props)
      if (popupHtml) fLayer.bindPopup(popupHtml)
      if (name) labels.push({ name: String(name), pos: featureLabelPos(feature, fLayer) })
    },
  })
  geoLayer.addTo(layer)
  // 独立渲染省名标签（divIcon，位置受控，避免 Leaflet 几何重心偏移）
  for (const lb of labels) {
    if (!lb.pos) continue
    const icon = L.divIcon({
      className: 'dc-map-label-pin',
      html: `<span class="dc-map-label">${escapeHtml(lb.name)}</span>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    })
    L.marker(lb.pos, { icon, interactive: false, keyboard: false }).addTo(layer)
  }
  // 收集所有坐标用于 fitBounds
  geoLayer.eachLayer((l: any) => {
    if (l.getLatLng) {
      const ll = l.getLatLng()
      if (ll && isFinite(ll.lat) && isFinite(ll.lng)) bounds.push([ll.lat, ll.lng])
    } else if (l.getLatLngs) {
      collectLatLngs(l.getLatLngs(), bounds)
    }
  })
}

// 省名标签位置：优先数据自带中心字段，否则用边界框中心（比 Leaflet 几何重心更稳定）
function featureLabelPos(feature: any, fLayer: any): L.LatLng | null {
  const props = feature?.properties || {}
  for (const k of ['center', 'cp', 'centroid', 'labelPoint', 'lngLat', 'lnglat', 'labelPos']) {
    const v = props[k]
    if (Array.isArray(v) && v.length >= 2 && isFinite(Number(v[0])) && isFinite(Number(v[1]))) {
      return L.latLng(Number(v[1]), Number(v[0]))
    }
    if (v && typeof v === 'object' && isFinite(Number(v.lng)) && isFinite(Number(v.lat))) {
      return L.latLng(Number(v.lat), Number(v.lng))
    }
  }
  try {
    const b = fLayer?.getBounds?.()
    if (b && b.isValid()) return b.getCenter()
  } catch { /* ignore */ }
  return null
}

// HTML 转义（标签内容来自数据，避免特殊字符破坏结构）
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

// 递归收集 LatLng / 坐标数组
function collectLatLngs(v: any, out: [number, number][]) {
  if (!v) return
  if (typeof v.lat === 'number' && typeof v.lng === 'number') {
    if (isFinite(v.lat) && isFinite(v.lng)) out.push([v.lat, v.lng])
  } else if (Array.isArray(v)) {
    v.forEach((x) => collectLatLngs(x, out))
  }
}

// 生成 GeoJSON 要素的 popup 内容（名称 + 其余属性）
function geojsonPopupHtml(name: string, props: any): string {
  const skip = ['name', 'Name', 'title', 'label', '名称']
  const keys = Object.keys(props || {}).filter((k) => !skip.includes(k))
  const rows = keys.slice(0, 15)
    .map((k) => `<tr><td><b>${k}</b></td><td>${String(props[k])}</td></tr>`)
    .join('')
  const head = name ? `<b>${name}</b>` : ''
  const table = rows ? `<table style="border-collapse:collapse;font-size:11px;margin-top:3px"><tbody>${rows}</tbody></table>` : ''
  return head || table ? `<div style="font-size:12px">${head}${table}</div>` : ''
}

// ==================== 全屏 ====================
// 放大到数据看板视图区域（dc-view / dc-dashboard-view 大小），不铺满整个屏幕
function updateFullscreenStyle() {
  const el = document.querySelector<HTMLElement>('.dc-dashboard-view')
  const rect = el?.getBoundingClientRect()
  fullscreenStyle.value = rect
    ? {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      }
    : {}
}

// 监听看板区域尺寸变化（窗口缩放 / 侧边栏拖拽等），全屏时跟随缩放
let resizeObserver: ResizeObserver | null = null
function observeDashboardSize() {
  const el = document.querySelector<HTMLElement>('.dc-dashboard-view')
  if (!el) return
  resizeObserver?.disconnect()
  resizeObserver = new ResizeObserver(() => {
    if (!fullscreenId.value) return
    updateFullscreenStyle()
    // 尺寸变化后刷新图表：d3 用 viewBox 自适应，地图需 invalidateSize 重测
    const id = fullscreenId.value
    requestAnimationFrame(() => invalidateMap(id))
  })
  resizeObserver.observe(el)
}

// 退出全屏：清除全屏状态并持久化（手动退出 / 模式切换退出共用）
function exitFullscreen() {
  if (!fullscreenId.value) return
  fullscreenId.value = null
  fullscreenStyle.value = {}
  resizeObserver?.disconnect()
  resizeObserver = null
  persistFullscreenId()
}

// 进入全屏：设为全屏并跟随看板尺寸（手动进入 / 模式切换恢复共用）
function enterFullscreen(c: ChartItem) {
  fullscreenId.value = c.chartId
  persistFullscreenId()
  updateFullscreenStyle()
  observeDashboardSize()
  nextTick(() => {
    const el = chartEls.get(c.chartId)
    if (!el) return
    if (c.type === 'map') {
      // 进入全屏容器尺寸会变化：重建地图实例确保瓦片与标记正确铺满
      requestAnimationFrame(() => {
        const inst = mapInstances.get(c.chartId)
        if (inst) { inst.ro?.disconnect(); inst.map.remove(); mapInstances.delete(c.chartId) }
        renderMap(el, c)
      })
    } else {
      renderChart(el, c)
    }
  })
}

function toggleFullscreen(c: ChartItem) {
  if (fullscreenId.value === c.chartId) exitFullscreen()
  else enterFullscreen(c)
}

// 窗口尺寸变化时重绘图表（图表尺寸跟随容器宽高，实时响应窗口拉宽/缩窄）
let resizeRaf = 0
function onWindowResize() {
  cancelAnimationFrame(resizeRaf)
  resizeRaf = requestAnimationFrame(() => {
    rerenderAllCharts()
    for (const c of charts.value) invalidateMap(c.chartId)
  })
}

onMounted(() => {
  nextTick(() => {
    migrateLegacyLayouts()
    if (fullscreenId.value) { updateFullscreenStyle(); observeDashboardSize() }
  })
  window.addEventListener('resize', onWindowResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize)
  cancelAnimationFrame(resizeRaf)
  resizeObserver?.disconnect()
  resizeObserver = null
  for (const inst of mapInstances.values()) { inst.ro?.disconnect(); inst.map.remove() }
  mapInstances.clear()
})

defineExpose({ setDashboardMode, resetFreeLayout, toggleDashboardLock })
</script>

<style scoped>
.dc-dashboard-view {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 12px;
  overflow-y: auto;
  padding: 4px;
  box-sizing: border-box;
  gap: 8px;
}
.dc-dash-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--borderColor); gap: 8px; }
.dc-dash-empty i { font-size: 40px; }

/* 主页工具栏：模式切换（顺序排列 / 自定义拖放） */
.dc-dash-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 2px 0; }
.dc-dash-toolbar-title { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.dc-dash-mode-switch { display: flex; gap: 4px; }
.dc-dash-mode-switch .dc-btn.active { background: var(--fontActiveColor); color: var(--backgroundColor); border-color: var(--fontActiveColor); }
.dc-dash-mode-hint { font-size: 11px; color: var(--borderColor); }

.dc-charts-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 4px; }
.dc-chart-card { border: 1px solid var(--borderColor); border-radius: 6px; background: var(--menuColor); overflow: hidden; display: flex; flex-direction: column; }
.dc-chart-empty { display: flex; align-items: center; justify-content: center; height: 220px; color: var(--borderColor); font-size: 12px; }
.dc-var-value { display: flex; align-items: center; justify-content: center; width: 100%; min-height: 140px; font-size: 24px; font-weight: 700; color: var(--fontActiveColor); padding: 8px; box-sizing: border-box; }
.dc-var-unit { font-size: 14px; font-weight: 400; color: var(--borderColor); margin-left: 4px; }
.dc-var-value-text { max-width: 100%; max-height: 100%; overflow: auto; word-break: break-word; text-align: center; }
.dc-chart-head { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--borderColor); font-weight: 600; font-size: 12px; }
.dc-chart-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dc-chart-type { margin-left: auto; font-size: 10px; color: var(--borderColor); font-weight: normal; }
.dc-fullscreen-btn { padding: 1px 6px; font-size: 11px; line-height: 1.2; }
.dc-chart-body { padding: 4px; display: flex; justify-content: center; flex: 1; min-height: 0; }
/* 图表 SVG：填满图表区高度，viewBox 保持比例居中（meet），窗口变宽时不等比放大溢出到卡片下方 */
.dc-chart-body :deep(svg.dc-chart-svg) { width: 100%; height: 100%; display: block; }

/* 地图卡片：占满卡片剩余高度（flex:1），最小 220px，避免同行更高图表拉伸卡片后下方留白 */
.dc-chart-body.dc-map { flex: 1; width: 100%; min-height: 220px; padding: 0; background: #333; }

/* ====== 自由模式（自定义拖放）：绝对定位，尺寸随窗口等比缩放 ====== */
.dc-dash-free { position: relative; flex: 1; min-height: 300px; overflow: hidden; border: 1px dashed var(--borderColor); border-radius: 6px; }
.dc-dash-free .dc-chart-card.dc-free-card { position: absolute; margin: 0; box-sizing: border-box; }
.dc-dash-free .dc-chart-card.dc-free-card .dc-chart-body { flex: 1; height: auto; padding: 6px; }
.dc-dash-free .dc-chart-card.dc-free-card .dc-chart-body.dc-map { height: auto; }
.dc-dash-free .dc-chart-card.dc-free-card .dc-chart-body :deep(svg.dc-chart-svg) { height: 100% !important; }
.dc-free-drag { cursor: move; user-select: none; }

/* 自由模式下变量节点：单行悬浮块，左侧标签、右侧数值 */
.dc-dash-free .dc-chart-card.dc-free-value {
  background: var(--menuColor);
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
  overflow: hidden;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 6px 12px;
  box-sizing: border-box;
  cursor: move;
  user-select: none;
  -webkit-user-select: none;
}
.dc-dash-free .dc-chart-card.dc-free-value .dc-chart-head {
  background: transparent;
  border-bottom: none;
  padding: 0;
  width: auto;
  box-sizing: border-box;
}
.dc-dash-free .dc-chart-card.dc-free-value .dc-chart-title {
  font-size: 13px;
  color: var(--fontColor);
}
.dc-dash-free .dc-chart-card.dc-free-value .dc-chart-body {
  padding: 0;
  min-height: 0;
  width: auto;
}
.dc-dash-free .dc-chart-card.dc-free-value .dc-var-value {
  min-height: 0;
  width: auto;
  font-size: 22px;
}
.dc-free-card.dc-free-dragging { box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35); opacity: 0.92; }
/* 自由模式头部操作按钮（置顶/置底/全屏）：无边框、窄而紧凑的纯图标按钮 */
.dc-chart-head.dc-free-drag .dc-btn {
  border: none;
  width: 20px;
  padding: 1px 0;
  justify-content: center;
}
.dc-free-zbtn { padding: 1px 6px; font-size: 11px; line-height: 1.2; }
.dc-free-resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 14px;
  height: 14px;
  cursor: nwse-resize;
  border-right: 2px solid var(--borderColor);
  border-bottom: 2px solid var(--borderColor);
  border-bottom-right-radius: 4px;
  opacity: 0.6;
}
.dc-free-resize:hover { opacity: 1; }

/* 全屏：放大到数据看板视图区域（位置与尺寸由 JS 计算） */
.dc-chart-card.dc-chart-fullscreen {
  position: fixed;
  z-index: 10000;
  margin: 0;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}
/* 双保险：即使 free 卡片样式仍生效，也强制全屏为 fixed 铺满 */
/* free 模式下全屏图表作为底图垫底（z 低于所有悬浮卡片），便于在其上悬浮其他图表 */
.dc-dash-free .dc-chart-card.dc-chart-fullscreen { position: fixed; z-index: 1; }
.dc-chart-card.dc-chart-fullscreen .dc-chart-body { flex: 1; height: auto; padding: 6px; }
.dc-chart-card.dc-chart-fullscreen .dc-chart-body.dc-map { height: auto; }
.dc-chart-card.dc-chart-fullscreen .dc-chart-body :deep(svg.dc-chart-svg) { width: 100% !important; height: 100% !important; }
</style>

<style>
/* 非 scoped：Leaflet 地图标记样式 */
.dc-map-label {
  background: rgba(0, 0, 0, 0.55);
  border: none;
  box-shadow: none;
  border-radius: 3px;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 5px;
  line-height: 1.3;
  white-space: nowrap;
}
.dc-map-label::before { display: none; }
/* 省名标签 pin：divIcon 容器透明，标签居中于锚点 */
.dc-map-label-pin { background: transparent; border: none; }
.dc-map-label-pin .dc-map-label { display: inline-block; transform: translate(-50%, -50%); }
</style>
