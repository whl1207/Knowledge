<!-- KbGraphPreview.vue — 问答页空闲态：知识库结构概览（文件 / 实体 / 问题） -->
<script setup lang="ts">
import { computed } from 'vue'

interface GraphProps {
  files: any[]
  blocks: any[]
  questions: any[]
  entities: any[]
  relations: any[]
  isSliced: boolean
  isEmbedded: boolean
  embeddedCount: number
  zh: boolean
  /** 当前选中的节点 id（点击后高亮） */
  selectedId?: string
  /** 右侧窄栏：文件标题放大，保证缩小时仍可读 */
  compact?: boolean
  /** 问答生成后：这些节点是本次答案的佐证节点（高亮） */
  highlightIds?: string[]
  /** 生成答案后：节点 id → 检索分数（用于按真实相似度排序） */
  scores?: Record<string, number>
  /** 有 highlightIds 时，其他节点淡出 */
  dimOthers?: boolean
  /** 右侧面板用父级“图谱 / 列表”按钮做标题时隐藏自身头部 */
  hideHead?: boolean
  /** 横向（未问答全宽）/ 纵向（生成后右侧窄栏）椭圆布局 */
  orientation?: 'horizontal' | 'vertical'
}

const emit = defineEmits<{ (e: 'select', payload: { node: GraphNode; item: any }): void }>()

const layout = computed(() => {
  const vertical = props.orientation === 'vertical'
  const W = vertical ? 560 : 800
  const H = vertical ? 900 : 500
  const cx = W / 2
  const cy = H / 2
  return {
    W, H, cx, cy,
    rings: vertical
      ? {
          file: { rx: 120, ry: 190 },
          slice: { rx: 175, ry: 285 },
          entity: { rx: 225, ry: 365 },
          question: { rx: 255, ry: 420 },
        }
      : {
          file: { rx: 190, ry: 110 },
          slice: { rx: 245, ry: 150 },
          entity: { rx: 300, ry: 190 },
          question: { rx: 350, ry: 225 },
        },
  }
})

function normalizeId(v: unknown): string {
  return String(v == null ? '' : v).replace(/\\/g, '/').replace(/^f:\/?/, 'f:')
}
const highlightSet = computed(() => new Set((props.highlightIds || []).map(normalizeId)))

function scoreOf(kind: NodeKind, item: any): number {
  if (!item) return 0
  if (kind === 'file') return Number(props.scores?.[`f:${normalizeId(item.path || '')}`] || 0)
  if (kind === 'slice') return Number(props.scores?.[`slice:${item.id}`] || 0)
  if (kind === 'entity') return Number(props.scores?.[`entity:${item.id || item.name}`] || 0)
  return Number(props.scores?.[`question:${item.id}`] || 0)
}
const maxNodeScore = computed(() => {
  const vals = Object.values(props.scores || {}).map((v) => Number(v) || 0)
  return vals.length ? Math.max(...vals, 1e-9) : 0
})
/** 相似度越高节点越大；没有分数时保持基础大小 */
function radiusFor(kind: NodeKind, item: any, base: number, extra: number): number {
  if (!maxNodeScore.value) return base
  const t = Math.min(1, Math.max(0, scoreOf(kind, item) / maxNodeScore.value))
  return base + extra * t
}

type NodeState = 'ready' | 'pending' | 'empty'
type NodeKind = 'file' | 'entity' | 'question' | 'slice'

interface GraphNode {
  id: string
  kind: NodeKind
  label: string
  sub: string
  state: NodeState
  x: number
  y: number
  r: number
  anchor: 'start' | 'end'
  labelX: number
  labelY: number
  delay: number
  showLabel: boolean
  item: any
}

const props = defineProps<GraphProps>()



function hasVector(block: any): boolean {
  return Array.isArray(block?.A_vector) && block.A_vector.length > 0
}

function sample<T>(list: T[], max: number): T[] {
  if (!list.length) return []
  if (list.length <= max) return list
  const step = list.length / max
  return Array.from({ length: max }, (_, i) => list[Math.floor(i * step)])
}

function shortLabel(text: unknown, max = 14): string {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function baseName(path: unknown): string {
  const s = String(path == null ? '' : path).replace(/\\/g, '/')
  return s.split('/').filter(Boolean).pop() || s
}

const blockById = computed(() => {
  const map = new Map<string, any>()
  for (const block of props.blocks || []) {
    if (block?.id) map.set(String(block.id), block)
  }
  return map
})

const statsByPath = computed(() => {
  const map = new Map<string, { total: number; ready: number }>()
  for (const block of props.blocks || []) {
    const path = String(block?.filePath || '')
    if (!path) continue
    const stat = map.get(path) || { total: 0, ready: 0 }
    stat.total += 1
    if (hasVector(block)) stat.ready += 1
    map.set(path, stat)
  }
  return map
})

const blockPaths = computed(() => {
  const seen = new Set<string>()
  const out: Array<{ path: string; label: string; extension: string }> = []
  for (const block of props.blocks || []) {
    const path = String(block?.filePath || '')
    if (!path || seen.has(path)) continue
    seen.add(path)
    out.push({ path, label: baseName(path), extension: '.md' })
  }
  return out
})

const fileCandidates = computed(() => {
  const list = (props.files || []).filter((f) => f && f.path)
  const md = list.filter((f) => String(f.extension || '').toLowerCase() === '.md')
  const base = (md.length ? md : list).slice()
  const source = base.length ? base : blockPaths.value
  // 有分数时按证据/相似度排；没有分数保持原顺序，避免把「关联切片多」误当成相似度
  const sorted = source.slice().sort((a: any, b: any) => scoreOf('file', b) - scoreOf('file', a))
  // 有实体/问题时文件环 30 个，外层再补切片/实体/问题共 50 个（总 80）；只有文件时至少铺 50 个
  const hasOuter = (props.entities || []).length > 0 || (props.questions || []).length > 0 || (props.blocks || []).length > 0
  return sample(sorted, hasOuter ? 30 : 50)
})

const fileNodes = computed<GraphNode[]>(() => {
  const list = fileCandidates.value
  const n = list.length
  if (!n) return []
  return list.map((file: any, i) => {
    const path = String(file.path || '')
    const stat = statsByPath.value.get(path) || { total: 0, ready: 0 }
    const state: NodeState = !stat.total
      ? 'empty'
      : stat.ready >= stat.total
        ? 'ready'
        : 'pending'
    const angle = -Math.PI / 2 + (i * Math.PI * 2) / n
    const ring = layout.value.rings.file
    const x = layout.value.cx + Math.cos(angle) * ring.rx
    const y = layout.value.cy + Math.sin(angle) * ring.ry
    const label = shortLabel(String(file.label || baseName(path)).replace(/\.[^.]+$/, ''), 13)
    const sub = stat.total
      ? `${stat.ready}/${stat.total}`
      : (props.zh ? '未切片' : 'unsliced')
    return {
      id: `f:${path || i}`,
      kind: 'file',
      label,
      sub,
      state,
      x,
      y,
      r: radiusFor('file', file, 4.5 + Math.min(4.5, Math.log2(stat.total + 1) * 1.5), 6),
      anchor: x < layout.value.cx ? 'end' : 'start',
      labelX: x < layout.value.cx ? x - 9 : x + 9,
      labelY: y + 3,
      delay: i * 24,
      // 节点多时全部隐藏标题，悬停 <title> 查看；避免 40+ 文件标题糊成一片
      showLabel: false,
      item: file,
    }
  })
})

const entityCandidates = computed(() =>
  sample((props.entities || []).slice().sort((a: any, b: any) => scoreOf('entity', b) - scoreOf('entity', a)), 20)
)
const questionCandidates = computed(() =>
  sample((props.questions || []).filter((q) => q?.status !== 'merged').slice().sort((a: any, b: any) => scoreOf('question', b) - scoreOf('question', a)), 15)
)
const sliceCandidates = computed(() =>
  sample((props.blocks || []).filter((b) => b && b.id != null).slice().sort((a: any, b: any) => scoreOf('slice', b) - scoreOf('slice', a)), 15)
)

function buildRing(kind: NodeKind, list: any[], ringKey: 'slice' | 'entity' | 'question', delayBase: number): GraphNode[] {
  const n = list.length
  if (!n) return []
  const ring = layout.value.rings[ringKey]
  return list.map((item, i) => {
    // 顺时针：12 点方向开始
    const angle = -Math.PI / 2 + (i * Math.PI * 2) / n
    const x = layout.value.cx + Math.cos(angle) * ring.rx
    const y = layout.value.cy + Math.sin(angle) * ring.ry
    let state: NodeState = 'empty'
    let label = ''
    let sub = ''
    if (kind === 'entity') {
      const ids = Array.isArray(item.associatedBlocks) ? item.associatedBlocks.map(String) : []
      const ready = ids.filter((id: string) => hasVector(blockById.value.get(id))).length
      state = !ids.length ? 'empty' : ready >= ids.length ? 'ready' : 'pending'
      label = shortLabel(item.name || item.id, 16)
      sub = String(item.type || item.nodeType || '')
    } else if (kind === 'slice') {
      state = hasVector(item) ? 'ready' : 'pending'
      label = shortLabel(item.label || item.A || item.content || item.id, 18)
      sub = props.zh ? '切片' : 'slice'
    } else {
      state = hasVector(item?.qVector) ? 'ready' : 'pending'
      label = shortLabel(item.text || item.question || '', 18)
      sub = props.zh ? '问题' : 'question'
    }
    return {
      id: `${kind}:${item.id || item.name || i}`,
      kind,
      label,
      sub,
      state,
      x,
      y,
      r: radiusFor(kind, item, kind === 'entity' ? 5.5 : kind === 'slice' ? 3.5 : 4, kind === 'entity' ? 7 : kind === 'slice' ? 4 : 5),
      anchor: x < layout.value.cx ? 'end' : 'start',
      labelX: x < layout.value.cx ? x - 9 : x + 9,
      labelY: y + 3,
      delay: delayBase + i * 14,
      showLabel: false,
      item,
    }
  })
}

const sliceNodes = computed(() => buildRing('slice', sliceCandidates.value, 'slice', 0))
const entityNodes = computed(() => buildRing('entity', entityCandidates.value, 'entity', 120))
const questionNodes = computed(() => buildRing('question', questionCandidates.value, 'question', 240))
const outerNodes = computed(() => [...sliceNodes.value, ...entityNodes.value, ...questionNodes.value])

const allNodes = computed(() => [...fileNodes.value, ...outerNodes.value])

function isRelevant(node: GraphNode): boolean {
  if (!highlightSet.value.size) return false
  if (highlightSet.value.has(normalizeId(node.id))) return true
  if (node.kind === 'file') return highlightSet.value.has(normalizeId(`f:${node.item?.path || ''}`))
  return false
}

// 关系边：只画两端都在当前采样里的关系，避免图谱变成一团
const entityAliases = computed(() => {
  const map = new Map<string, GraphNode>()
  for (const node of outerNodes.value) {
    if (node.kind !== 'entity') continue
    const item = entityCandidates.value.find((e: any) => String(e.id || e.name) === node.id.slice('entity:'.length))
    if (!item) continue
    for (const key of [item.id, item.name]) {
      if (key) map.set(String(key), node)
    }
  }
  return map
})

const relationLines = computed(() => {
  const lines: Array<{ id: string; x1: number; y1: number; x2: number; y2: number }> = []
  for (const rel of props.relations || []) {
    const a = entityAliases.value.get(String(rel.source))
    const b = entityAliases.value.get(String(rel.target))
    if (!a || !b || a.id === b.id) continue
    lines.push({ id: String(rel.id || `${a.id}-${b.id}`), x1: a.x, y1: a.y, x2: b.x, y2: b.y })
    if (lines.length >= 28) break
  }
  return lines
})

const totalFiles = computed(() => {
  const list = (props.files || []).filter((f) => f && f.path)
  return list.length || blockPaths.value.length
})
const totalBlocks = computed(() => (props.blocks || []).length)
const totalEntities = computed(() => (props.entities || []).length)
const totalQuestions = computed(() =>
  (props.questions || []).filter((q) => q?.status !== 'merged').length
)
const readySlices = computed(() => (props.blocks || []).filter(hasVector).length)

const isEmpty = computed(() => !totalFiles.value && !totalBlocks.value && !totalEntities.value && !totalQuestions.value)

const statusText = computed(() => {
  if (!props.isSliced) return props.zh ? '尚未切片' : 'Not sliced'
  if (totalBlocks.value === 0) return props.zh ? '没有切片' : 'No slices'
  if (props.isEmbedded || readySlices.value >= totalBlocks.value) {
    return props.zh ? `${totalBlocks.value} 切片 · 已全部向量化` : `${totalBlocks.value} slices · all embedded`
  }
  return props.zh
    ? `${totalBlocks.value} 切片 · ${readySlices.value} 已向量化`
    : `${totalBlocks.value} slices · ${readySlices.value} embedded`
})

const legend = computed(() => [
  { state: 'ready', label: props.zh ? '已向量化' : 'Embedded' },
  { state: 'pending', label: props.zh ? '待向量化' : 'Pending' },
  { state: 'empty', label: props.zh ? '未切片' : 'Unsliced' },
])
const hubTitle = computed(() => {
  const lines = props.zh
    ? [
        '知识库概览',
        `${totalFiles.value} 文件 · ${totalBlocks.value} 切片 · ${totalEntities.value} 实体 · ${totalQuestions.value} 问题`,
        `已向量化 ${readySlices.value}/${totalBlocks.value} 切片`,
        statusText.value,
      ]
    : [
        'Knowledge overview',
        `${totalFiles.value} files · ${totalBlocks.value} slices · ${totalEntities.value} entities · ${totalQuestions.value} questions`,
        `${readySlices.value}/${totalBlocks.value} slices embedded`,
        statusText.value,
      ]
  return lines.join('\n')
})
const ringLegend = computed(() => [
  { key: 'file', color: '#58a6ff', label: props.zh ? '文件' : 'Files' },
  { key: 'slice', color: '#ff7b72', label: props.zh ? '切片' : 'Slices' },
  { key: 'entity', color: '#a371f7', label: props.zh ? '实体' : 'Entities' },
  { key: 'question', color: '#2dd4bf', label: props.zh ? '问题' : 'Questions' },
])
const ringMeta = computed(() => [
  { key: 'file' as const, color: '#58a6ff', label: props.zh ? '文件' : 'Files', count: fileNodes.value.length },
  { key: 'slice' as const, color: '#ff7b72', label: props.zh ? '切片' : 'Slices', count: sliceNodes.value.length },
  { key: 'entity' as const, color: '#a371f7', label: props.zh ? '实体' : 'Entities', count: entityNodes.value.length },
  { key: 'question' as const, color: '#2dd4bf', label: props.zh ? '问题' : 'Questions', count: questionNodes.value.length },
])
</script>

<template>
  <div class="kbg" :class="{ 'kbg-compact': props.compact }">
    <div v-if="!props.hideHead" class="kbg-head">
      <div class="kbg-title">
        <i class="fa fa-sitemap" aria-hidden="true"></i>
        {{ props.zh ? '知识库概览' : 'Knowledge overview' }}
      </div>
      <slot name="actions" />
      <div class="kbg-status">{{ statusText }}</div>
    </div>

    <div v-if="isEmpty" class="kbg-empty">
      <i class="fa fa-sitemap" aria-hidden="true"></i>
      <div class="kbg-empty-title">{{ props.zh ? '还没有可展示的知识结构' : 'No knowledge structure yet' }}</div>
      <div class="kbg-empty-sub">
        {{ props.zh ? '打开文件夹或选择 .kb 后，这里会出现文件、实体与问题的图谱' : 'Open a folder or pick a .kb to see files, entities and questions here' }}
      </div>
    </div>

    <svg v-else class="kbg-svg" :viewBox="`0 0 ${layout.W} ${layout.H}`" preserveAspectRatio="xMidYMid meet" role="img" :aria-label="props.zh ? '知识库结构图' : 'Knowledge structure graph'">
      <g class="kbg-orbits">
        <g v-for="ring in ringMeta" :key="'orbit-' + ring.key" v-show="ring.count > 0">
          <ellipse
            :cx="layout.cx"
            :cy="layout.cy"
            :rx="layout.rings[ring.key].rx"
            :ry="layout.rings[ring.key].ry"
            class="kbg-orbit"
            :class="'orbit-' + ring.key"
          />
        </g>
      </g>
      <g class="kbg-edges">
        <line
          v-for="node in allNodes"
          :key="'e' + node.id"
          :x1="layout.cx"
          :y1="layout.cy"
          :x2="node.x"
          :y2="node.y"
          class="kbg-edge"
        />
        <line
          v-for="line in relationLines"
          :key="'r' + line.id"
          :x1="line.x1"
          :y1="line.y1"
          :x2="line.x2"
          :y2="line.y2"
          class="kbg-edge kbg-edge-relation"
        />
      </g>

      <g class="kbg-hub">
        <title>{{ hubTitle }}</title>
        <circle v-if="props.isEmbedded" class="kbg-hub-pulse" :cx="layout.cx" :cy="layout.cy" r="38" />
        <circle class="kbg-hub-circle" :cx="layout.cx" :cy="layout.cy" r="34" />
        <foreignObject :x="layout.cx - 16" :y="layout.cy - 16" width="32" height="32" class="kbg-hub-icon-wrap">
          <div xmlns="http://www.w3.org/1999/xhtml" class="kbg-hub-icon"><i class="fa fa-database"></i></div>
        </foreignObject>
      </g>

      <g
        v-for="node in allNodes"
        :key="node.id"
        class="kbg-node"
        :class="['st-' + node.state, 'ring-' + node.kind, { 'is-selected': node.id === props.selectedId, 'is-relevant': isRelevant(node), 'is-dim': props.dimOthers && highlightSet.size > 0 && !isRelevant(node) }]"
        :style="{ animationDelay: node.delay + 'ms' }"
        :transform="`translate(${node.x} ${node.y})`"
        @click.stop="emit('select', { node, item: node.item })"
      >
        <circle class="kbg-halo" :r="node.r + 4" />
        <circle :r="node.r" />
        <text
          v-if="node.showLabel && node.label"
          class="kbg-label"
          :x="node.anchor === 'end' ? -9 : 9"
          :y="3"
          :text-anchor="node.anchor"
        >{{ node.label }}</text>
        <title>{{ node.kind === 'file' ? (props.zh ? '文件' : 'File') : node.kind === 'entity' ? (props.zh ? '实体' : 'Entity') : node.kind === 'slice' ? (props.zh ? '切片' : 'Slice') : (props.zh ? '问题' : 'Question') }}: {{ node.label }}{{ node.sub ? ' · ' + node.sub : '' }}</title>
      </g>
    </svg>

    <div class="kbg-ring-legend">
      <span v-for="item in ringLegend" :key="item.key" class="kbg-legend-item">
        <i class="kbg-ring-dot" :style="{ borderColor: item.color }" aria-hidden="true"></i>
        {{ item.label }}
      </span>
    </div>
    <div class="kbg-legend">
      <span v-for="item in legend" :key="item.state" class="kbg-legend-item">
        <i class="kbg-dot" :class="'st-' + item.state" aria-hidden="true"></i>
        {{ item.label }}
      </span>
      <span v-if="totalEntities" class="kbg-legend-extra">{{ props.zh ? `${totalEntities} 实体` : `${totalEntities} entities` }}</span>
      <span v-if="totalQuestions" class="kbg-legend-extra">{{ props.zh ? `${totalQuestions} 问题` : `${totalQuestions} questions` }}</span>
    </div>
  </div>
</template>

<style scoped>
.kbg {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
  border: 1px solid var(--borderColor);
  border-radius: 7px;
  background:
    radial-gradient(circle at 50% 46%, color-mix(in srgb, var(--fontActiveColor) 9%, transparent) 0, transparent 62%),
    var(--backgroundColor);
}
.kbg-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px 0;
  min-width: 0;
}
.kbg-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--fontColor);
  white-space: nowrap;
}
.kbg-title i {
  color: var(--fontActiveColor);
  font-size: 12px;
}
.kbg-status {
  margin-left: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  color: var(--fontColor);
  opacity: .6;
}
.kbg-svg {
  flex: 1;
  min-height: 0;
  width: 100%;
  display: block;
}
/* 四圈轨道：让“文件→切片→实体→问题”的层次一眼可见 */
.kbg-orbit {
  fill: none;
  stroke-width: 1;
  stroke-dasharray: 2 6;
  opacity: .26;
}
.orbit-file { stroke: #58a6ff; }
.orbit-slice { stroke: #ff7b72; }
.orbit-entity { stroke: #a371f7; }
.orbit-question { stroke: #2dd4bf; }
.kbg-orbit-label {
  font-size: 8.5px;
  letter-spacing: .04em;
  opacity: .7;
  paint-order: stroke;
  stroke: var(--backgroundColor);
  stroke-width: 2px;
}
.orbit-label-file { fill: #58a6ff; }
.orbit-label-slice { fill: #ff7b72; }
.orbit-label-entity { fill: #a371f7; }
.orbit-label-question { fill: #2dd4bf; }
.kbg-edge {
  stroke: var(--borderColor);
  stroke-width: 1;
  opacity: .55;
}
.kbg-edge-relation {
  stroke-dasharray: 3 4;
  opacity: .75;
}
.kbg-hub-circle {
  fill: var(--fontActiveColor);
}
.kbg-hub-icon-wrap {
  overflow: visible;
  pointer-events: none;
}
.kbg-hub-icon {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--backgroundColor);
  font-size: 16px;
  pointer-events: none;
}
.kbg-hub:hover .kbg-hub-circle {
  filter: drop-shadow(0 0 7px color-mix(in srgb, var(--fontActiveColor) 65%, transparent));
}
.kbg-hub-title {
  fill: var(--backgroundColor);
  font-size: 12px;
  font-weight: 700;
}
.kbg-hub-sub {
  fill: var(--backgroundColor);
  font-size: 8px;
  opacity: .85;
}
.kbg-hub-pulse {
  fill: none;
  stroke: var(--fontActiveColor);
  stroke-width: 1.2;
  opacity: .35;
  transform-box: fill-box;
  transform-origin: center;
  animation: kbgHubPulse 2.8s ease-out infinite;
}
.kbg-node {
  opacity: 0;
  animation: kbgFadeIn .45s ease forwards;
  transition: opacity .3s ease;
  cursor: pointer;
}
.kbg-node:hover circle { stroke: var(--fontActiveColor); stroke-width: 2; }
.kbg-node.is-selected circle {
  stroke: var(--fontActiveColor);
  stroke-width: 3;
  filter: drop-shadow(0 0 4px color-mix(in srgb, var(--fontActiveColor) 55%, transparent));
}
/* 生成答案后：最相关的佐证节点蓝色高亮，其余淡出 */
.kbg-node.is-relevant circle {
  stroke: #58a6ff;
  stroke-width: 3;
  filter: drop-shadow(0 0 5px rgba(88, 166, 255, .75));
}
.kbg-node.is-dim { opacity: .18; }
.kbg-node circle {
  transition: fill .5s ease, r .3s ease;
  stroke: color-mix(in srgb, var(--backgroundColor) 65%, transparent);
  stroke-width: 1.5;
}
.kbg-node .kbg-halo {
  stroke: none;
  opacity: .13;
  transition: r .3s ease, opacity .3s ease;
}
.kbg-node.ring-file .kbg-halo { fill: #58a6ff; }
.kbg-node.ring-slice .kbg-halo { fill: #ff7b72; }
.kbg-node.ring-entity .kbg-halo { fill: #a371f7; }
.kbg-node.ring-question .kbg-halo { fill: #2dd4bf; }
.kbg-node:hover .kbg-halo { opacity: .3; }
.kbg-node.st-ready circle { fill: #3fb950; }
.kbg-node.st-pending circle { fill: #d29922; }
.kbg-node.st-empty circle { fill: var(--borderColor); }
/* 四圈用不同描边色区分：文件 / 切片 / 实体 / 问题 */
.kbg-node.ring-file circle { stroke: #58a6ff; stroke-width: 2; }
.kbg-node.ring-slice circle { stroke: #ff7b72; stroke-width: 2; }
.kbg-node.ring-entity circle { stroke: #a371f7; stroke-width: 2; }
.kbg-node.ring-question circle { stroke: #2dd4bf; stroke-width: 2; }
.kbg-ring-legend {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 2px 12px 0;
  flex-shrink: 0;
  font-size: 10px;
  color: var(--fontColor);
}
.kbg-ring-dot {
  width: 8px;
  height: 8px;
  border: 2px solid;
  border-radius: 50%;
  display: inline-block;
  box-sizing: border-box;
}
.kbg-label {
  fill: var(--fontColor);
  font-size: 9.5px;
  paint-order: stroke;
  stroke: var(--backgroundColor);
  stroke-width: 2.5px;
  stroke-linejoin: round;
  pointer-events: none;
}
/* 右侧窄栏：节点/标题放大，50+ 节点时文字仍可辨认 */
.kbg-compact .kbg-label { font-size: 12px; stroke-width: 3px; }
.kbg-compact .kbg-head { padding: 5px 8px; }
.kbg-compact .kbg-title { font-size: 12px; }
.kbg-legend {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 12px 8px;
  font-size: 10px;
  color: var(--fontColor);
  opacity: .65;
}
.kbg-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}
.kbg-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  display: inline-block;
  background: var(--borderColor);
}
.kbg-dot.st-ready { background: #3fb950; }
.kbg-dot.st-pending { background: #d29922; }
.kbg-dot.st-empty { background: var(--borderColor); }
.kbg-legend-extra {
  margin-left: auto;
  white-space: nowrap;
}
.kbg-empty {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 20px;
  text-align: center;
  color: var(--fontColor);
}
.kbg-empty > i {
  font-size: 24px;
  color: var(--fontActiveColor);
  opacity: .7;
}
.kbg-empty-title {
  font-size: 13px;
  font-weight: 600;
}
.kbg-empty-sub {
  max-width: 420px;
  font-size: 11px;
  line-height: 1.7;
  opacity: .6;
}
@keyframes kbgFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes kbgHubPulse {
  0% { transform: scale(.8); opacity: .35; }
  70% { transform: scale(1.35); opacity: 0; }
  100% { transform: scale(1.35); opacity: 0; }
}
@media (max-width: 640px) {
  .kbg-label {
    display: none;
  }
  .kbg-head {
    padding: 8px 9px 0;
  }
  .kbg-legend {
    gap: 8px;
    padding: 0 9px 7px;
    font-size: 9.5px;
  }
  .kbg-legend-extra {
    display: none;
  }
}
</style>
