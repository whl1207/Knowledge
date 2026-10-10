<!--
  graphView.vue —— 学习地图 · 本体图谱轴
  三种显示模式（地图轴的范围下拉控制）：
  - entity：本体（实体 + 关系），节点颜色即掌握状态，点击看掌握度并可直接练习/复习；
  - slice + question：切片节点 + 问题节点（问题连到它依据的切片），点击切片可直接练这一片；
  - file + question：文件节点 + 问题节点（问题连到它来源的文件），点击文件可直接练该文件。
  渲染复用 AgentScaffold/KnowledgeGraphViewer（d3 力导向，自带缩放/拖拽/悬停详情/自动适配）。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import KnowledgeGraphViewer from '@/components/AgentScaffold/KnowledgeGraphViewer.vue'
import { fmtPct } from '@/services/learningCore'
import type { EntityItem } from '@/components/learning/types'

const props = defineProps<{
  store: any
  entities: any[]
  relations: any[]
  items: EntityItem[]
  showAll: boolean
  /** 问题库（.kb questions）；开启「含问题」时作为额外节点 */
  questions?: any[]
  /** 是否在图谱里一并显示问题节点（由地图轴的范围下拉控制） */
  withQuestions?: boolean
  /** 实体 → 切片索引（把问题挂到它们依据的切片所属实体上） */
  entityToBlocks?: Array<{ entityName: string; blockIds: string[] }>
  /** 显示模式：实体 / 切片+问题 / 文件+问题（由地图轴的范围下拉控制） */
  mode?: 'entity' | 'slice' | 'file'
  /** .kb 切片（切片模式用） */
  blocks?: any[]
  /** 文件清单（.kb files，文件模式兜底用） */
  files?: { path: string; label: string }[]
  /** 文件掌握情况（learning.vue 的 vm；key=文件相对路径） */
  fileItems?: Array<{ key: string; label: string; status: string; attempts: number; mastery: number; sliceCount: number }>
  /** 切片作答统计（blockId → 作答数 / 答对数） */
  blockStats?: Record<string, { attempts: number; ok: number }>
}>()
const emit = defineEmits<{
  practice: [name: string]
  review: [name: string]
  practiceBlock: [filePath: string, blockId: any]
  practiceFile: [filePath: string]
}>()
const tr = (zh: string, en: string) => (props.store.locales === 'zh' ? zh : en)

/**
 * 节点显示数量（渲染预算）：图里问题 / 切片各自最多画多少个。
 * 图例栏可调（默认 2000），选择写进 localStorage 记住。
 */
const LIMIT_KEY = 'learning:graphNodeLimit'
const LIMIT_OPTIONS = [200, 500, 1000, 2000, 5000, 10000, 20000]
function readLimit(): number {
  try {
    const v = Number(localStorage.getItem(LIMIT_KEY))
    if (LIMIT_OPTIONS.includes(v)) return v
  } catch { /* ignore */ }
  return 2000
}
const nodeLimit = ref<number>(readLimit())
watch(nodeLimit, (v) => { try { localStorage.setItem(LIMIT_KEY, String(v)) } catch { /* ignore */ } })

/**
 * 节点标题（标签）显示策略：auto=按节点数自动（≤500 显示）/ on=总是显示 / off=不显示。
 * 图例栏可调，选择写进 localStorage 记住。
 */
const LABEL_KEY = 'learning:graphLabels'
type LabelMode = 'auto' | 'on' | 'off'
function readLabelMode(): LabelMode {
  try {
    const v = String(localStorage.getItem(LABEL_KEY) || '')
    if (v === 'on' || v === 'off' || v === 'auto') return v
  } catch { /* ignore */ }
  return 'auto'
}
const labelMode = ref<LabelMode>(readLabelMode())
watch(labelMode, (v) => { try { localStorage.setItem(LABEL_KEY, v) } catch { /* ignore */ } })
/** 传给共享图谱组件：null = 自动 */
const showLabels = computed<boolean | null>(() => labelMode.value === 'auto' ? null : labelMode.value === 'on')

/**
 * 节点间距（疏密）：值越大越疏（同步影响斥力 / 连线长度 / 碰撞半径），默认 1.6（宽松）。
 * 图例栏可调，选择写进 localStorage 记住。
 */
const SPACING_KEY = 'learning:graphSpacing'
const SPACING_OPTIONS = [
  { v: 0.7, zh: '间距:紧凑', en: 'Spacing: tight' },
  { v: 1, zh: '间距:标准', en: 'Spacing: normal' },
  { v: 1.6, zh: '间距:宽松', en: 'Spacing: wide' },
  { v: 2.4, zh: '间距:很宽', en: 'Spacing: extra' },
]
/** 默认「宽松」：宁可疏一点，也不让节点挤成一团 */
const SPACING_DEFAULT = 1.6
function readSpacing(): number {
  try {
    const v = Number(localStorage.getItem(SPACING_KEY))
    if (SPACING_OPTIONS.some(o => o.v === v)) return v
  } catch { /* ignore */ }
  return SPACING_DEFAULT
}
const spacing = ref<number>(readSpacing())
watch(spacing, (v) => { try { localStorage.setItem(SPACING_KEY, String(v)) } catch { /* ignore */ } })
/** 是否含问题节点：由父级（范围下拉）传入，只读 */
const withQuestions = computed(() => !!props.withQuestions)
/** 显示模式（父级控制） */
const mode = computed<'entity' | 'slice' | 'file'>(() => props.mode || 'entity')

const selected = ref<EntityItem | null>(null)
/** 选中的问题节点（与实体详情互斥） */
const selectedQ = ref<{ text: string; entities: string } | null>(null)
/** 选中的切片节点（切片模式） */
const selectedB = ref<{ label: string; filePath: string; blockId: any; text: string; attempts: number; ok: number } | null>(null)
/** 选中的文件节点（文件模式） */
const selectedF = ref<{ path: string; label: string; status: string; attempts: number; mastery: number; sliceCount: number } | null>(null)

/** 切片 id → 关联实体名（问题按其来源/答案切片归到实体上） */
const entityByBlock = computed(() => {
  const m = new Map<string, string[]>()
  for (const e of (props.entityToBlocks || [])) {
    const name = String(e?.entityName || '')
    if (!name) continue
    for (const id of (e?.blockIds || [])) {
      const k = String(id)
      if (!m.has(k)) m.set(k, [])
      const arr = m.get(k)!
      if (!arr.includes(name)) arr.push(name)
    }
  }
  return m
})

const itemByName = computed(() => {
  const m = new Map<string, EntityItem>()
  for (const it of props.items) m.set(it.name, it)
  return m
})

/** 参与显示的实体：全部 / 仅已有练习（与「按实体」轴同一范围语义） */
const shown = computed(() => props.entities.filter((e: any) => {
  const name = String(e?.name || '')
  if (!name) return false
  if (props.showAll) return true
  const it = itemByName.value.get(name)
  return !!it && it.attempts > 0
}))

/** 颜色即状态：绿=已掌握 / 橙=学习中 / 灰=未开始（与卡片进度条同色系） */
const STATUS_COLOR: Record<string, string> = { mastered: 'green', learning: 'orange', new: 'gray' }
/** 颜色取值域（与 KnowledgeGraphViewer 的调色板一致） */
type NodeColor = 'green' | 'blue' | 'orange' | 'red' | 'gray' | 'purple'

function baseName(p: string): string {
  const parts = String(p || '').split(/[\\/]/)
  return parts[parts.length - 1] || String(p || '')
}

/** 问题节点构建：resolve 返回该问题要连到的目标节点（为空则不画，避免孤立点）；超预算时回传总数供提示 */
function questionGraph(zh: boolean, resolve: (q: any) => { id: string; label: string }[]) {
  const nodes: any[] = []
  const edges: any[] = []
  let count = 0
  let total = 0
  for (const q of (props.questions || [])) {
    const text = String(q?.text || '').trim()
    if (!text || q?.status === 'merged') continue
    const targets = resolve(q)
    if (!targets.length) continue
    total++
    if (count >= nodeLimit.value) continue   // 超预算：只计数，不画
    const qid = 'q:' + String(q?.id ?? count)
    const data: Record<string, any> = {
      [zh ? '题干' : 'Question']: text,
      [zh ? '关联' : 'Linked']: targets.map(t => t.label).join('、'),
    }
    const file = baseName(String(q?.srcFilePath || ''))
    if (file) data[zh ? '来源文件' : 'File'] = file
    nodes.push({ id: qid, label: text, type: 'question' as const, color: 'blue' as NodeColor, data })
    for (const t of targets) edges.push({ id: 'qe-' + qid + '-' + t.id, source: t.id, target: qid, type: 'about', label: '' })
    count++
  }
  return { nodes, edges, questionCount: count, questionTotal: total }
}

/** 切片 id 集合（问题关联用） */
function questionBlockIds(q: any): string[] {
  return [q?.srcBlockId, ...((q?.answerBlocks || []).map((b: any) => b?.blockId))]
    .filter((x: any) => x !== undefined && x !== null && x !== '')
    .map((x: any) => String(x))
}

// ==================== ① 本体（实体）图 ====================
function entityGraph(zh: boolean) {
  const nodes: any[] = shown.value.map((e: any) => {
    const name = String(e.name)
    const it = itemByName.value.get(name)
    const status = it?.status || 'new'
    const data: Record<string, any> = {
      [zh ? '掌握度' : 'Mastery']: it ? fmtPct(it.mastery) : '—',
      [zh ? '作答' : 'Answers']: it ? it.attempts : 0,
      [zh ? '关联切片' : 'Slices']: it ? it.blockCount : 0,
      [zh ? '来源文件' : 'Files']: it ? it.fileCount : 0,
    }
    if (e?.layer) data[zh ? '层级' : 'Layer'] = String(e.layer)
    if (e?.type) data[zh ? '类型' : 'Type'] = String(e.type)
    return {
      id: String(e.id ?? name),
      label: name,
      type: 'data' as const,
      color: (STATUS_COLOR[status] || 'gray') as NodeColor,
      data,
    }
  })
  // 关系端点兼容实体 id 与实体名两种写法（历史 .kb 可能不一致）
  const idSet = new Set(nodes.map(n => n.id))
  const nameToId = new Map(shown.value.map((e: any) => [String(e.name), String(e.id ?? e.name)]))
  const edges: Array<{ id: string; source: string; target: string; type: string; label: string }> = []
  for (let i = 0; i < props.relations.length; i++) {
    const r: any = props.relations[i]
    const s = idSet.has(String(r?.source)) ? String(r.source) : nameToId.get(String(r?.source))
    const t = idSet.has(String(r?.target)) ? String(r.target) : nameToId.get(String(r?.target))
    if (!s || !t || s === t || !idSet.has(s) || !idSet.has(t)) continue
    edges.push({ id: String(r?.id ?? 'r' + i), source: s, target: t, type: String(r?.type || 'rel'), label: String(r?.type || '') })
  }

  // 可选：问题节点（问题 → 其依据切片所属的实体）
  let qShown = 0
  let qTotal = 0
  if (withQuestions.value) {
    const visibleNames = new Set(shown.value.map((e: any) => String(e.name)))
    const qg = questionGraph(zh, (q) => {
      const names: string[] = []
      for (const bid of questionBlockIds(q)) for (const nm of (entityByBlock.value.get(bid) || [])) if (!names.includes(nm)) names.push(nm)
      return names
        .filter(n => visibleNames.has(n) && idSet.has(String(nameToId.get(n))))
        .map(n => ({ id: String(nameToId.get(n)), label: n }))
    })
    nodes.push(...qg.nodes)
    edges.push(...qg.edges)
    qShown = qg.questionCount
    qTotal = qg.questionTotal
  }
  return { nodes, edges, questionCount: qShown, questionTotal: qTotal, unitShown: 0, unitTotal: 0 }
}

// ==================== ② 切片 + 问题 ====================
function sliceGraph(zh: boolean) {
  const nodes: any[] = []
  const edges: any[] = []
  const idSet = new Set<string>()
  const all = (props.blocks || [])
  const used = all.slice(0, nodeLimit.value)
  for (const b of used) {
    const bid = String(b?.id ?? '')
    if (!bid) continue
    const st = props.blockStats?.[bid]
    const attempts = st?.attempts || 0
    const ok = st?.ok || 0
    const rate = attempts ? ok / attempts : 0
    const color: NodeColor = !attempts ? 'gray' : rate >= 0.9 ? 'green' : 'orange'
    const text = String(b?.A || '').replace(/\s+/g, ' ').trim()
    const label = text.slice(0, 16) || String(b?.label || bid)
    const data: Record<string, any> = {
      [zh ? '摘要' : 'Excerpt']: text.length > 200 ? text.slice(0, 200) + '…' : text,
      [zh ? '来源文件' : 'File']: baseName(String(b?.filePath || '')),
      [zh ? '作答' : 'Answers']: attempts,
      [zh ? '正确率' : 'Accuracy']: attempts ? fmtPct(rate) : '—',
    }
    nodes.push({ id: 'b:' + bid, label, type: 'slice' as const, color, data })
    idSet.add('b:' + bid)
  }
  // 问题 → 其来源切片（answerBlocks 里的其它切片也算关联）
  if (withQuestions.value) {
    const qg = questionGraph(zh, (q) => {
      const out: { id: string; label: string }[] = []
      for (const bid of questionBlockIds(q)) {
        const nid = 'b:' + bid
        if (!idSet.has(nid) || out.some(t => t.id === nid)) continue
        const b = used.find((x: any) => String(x?.id) === bid)
        const t = String(b?.A || '').replace(/\s+/g, ' ').trim().slice(0, 16)
        out.push({ id: nid, label: t || bid })
      }
      return out
    })
    nodes.push(...qg.nodes)
    edges.push(...qg.edges)
    return { nodes, edges, questionCount: qg.questionCount, questionTotal: qg.questionTotal, unitShown: used.length, unitTotal: all.length }
  }
  return { nodes, edges, questionCount: 0, questionTotal: 0, unitShown: used.length, unitTotal: all.length }
}

// ==================== ③ 文件 + 问题 ====================
function fileGraph(zh: boolean) {
  const nodes: any[] = []
  const edges: any[] = []
  const idOf = new Map<string, string>()
  const byKey = new Map<string, any>()
  for (const it of (props.fileItems || [])) byKey.set(String(it.key), it)
  const list: Array<{ path: string; label: string }> = (props.files || []).length
    ? (props.files || []).map(f => ({ path: String(f.path), label: String(f.label || baseName(f.path)) }))
    : Array.from(byKey.values()).map(it => ({ path: String(it.key), label: String(it.label || baseName(it.key)) }))
  for (const f of list) {
    const it = byKey.get(f.path)
    const status = it?.status || 'new'
    const nid = 'f:' + f.path
    idOf.set(f.path, nid)
    idOf.set(baseName(f.path), nid)
    const data: Record<string, any> = {
      [zh ? '掌握度' : 'Mastery']: it ? fmtPct(it.mastery) : '—',
      [zh ? '作答' : 'Answers']: it ? it.attempts : 0,
      [zh ? '切片' : 'Slices']: it ? it.sliceCount : 0,
    }
    if (it?.type) data[zh ? '知识类型' : 'Type'] = String(it.type)
    nodes.push({ id: nid, label: f.label, type: 'file' as const, color: (STATUS_COLOR[status] || 'gray') as NodeColor, data })
  }
  // 问题 → 其来源文件（按路径或文件名匹配）
  if (withQuestions.value) {
    const qg = questionGraph(zh, (q) => {
      const p = String(q?.srcFilePath || '')
      const nid = idOf.get(p) || idOf.get(baseName(p))
      if (!nid) return []
      const nm = nodes.find(n => n.id === nid)?.label || ''
      return [{ id: nid, label: nm }]
    })
    nodes.push(...qg.nodes)
    edges.push(...qg.edges)
    return { nodes, edges, questionCount: qg.questionCount, questionTotal: qg.questionTotal, unitShown: list.length, unitTotal: list.length }
  }
  return { nodes, edges, questionCount: 0, questionTotal: 0, unitShown: list.length, unitTotal: list.length }
}

const graphData = computed(() => {
  const zh = props.store.locales === 'zh'
  if (mode.value === 'slice') return sliceGraph(zh)
  if (mode.value === 'file') return fileGraph(zh)
  return entityGraph(zh)
})

/** 图例计数：按当前图里非问题节点的颜色统计（三种模式通用） */
const counts = computed(() => {
  let mastered = 0, learning = 0, nnew = 0
  for (const n of graphData.value.nodes) {
    if (n.type === 'question') continue
    if (n.color === 'green') mastered++
    else if (n.color === 'orange') learning++
    else nnew++
  }
  const total = mastered + learning + nnew
  return { mastered, learning, nnew, total }
})

/** 图例单位与说明文案随模式切换 */
const legendUnit = computed(() => mode.value === 'slice' ? tr('切片', 'slices') : mode.value === 'file' ? tr('文件', 'files') : tr('实体', 'entities'))

/**
 * 截断提示：只有真的超预算才显示。
 * 说明「已画多少 / 共多少」——上限只是渲染保护，不是固定 120 的业务限制。
 */
const truncated = computed(() => {
  const g: any = graphData.value
  const parts: string[] = []
  if (g.questionTotal > g.questionCount && g.questionTotal > 0) {
    parts.push(`${tr('问题', 'questions')} ${g.questionCount}/${g.questionTotal}`)
  }
  if (g.unitTotal > g.unitShown && g.unitTotal > 0) {
    parts.push(`${legendUnit.value} ${g.unitShown}/${g.unitTotal}`)
  }
  return parts.join(' · ')
})

/** 截断提示的悬停说明（带当前显示数量） */
const truncTitle = computed(() => tr(
  `图里节点太多，每类只画前 ${nodeLimit.value} 个（渲染保护）。可在右侧「显示数量」改小，或收窄范围（如「仅已练习」）。`,
  `Too many nodes: only the first ${nodeLimit.value} per kind are drawn (render guard). Lower “Show” on the right, or narrow the scope (e.g. practised only).`,
))

/** 节点很多（但没超过显示数量）时的性能提示 */
const perfHint = computed(() => {
  const total = graphData.value.nodes.length
  return total > 2000
    ? tr(`已画 ${total} 个节点，布局与拖拽会变慢`, `${total} nodes drawn — layout and dragging get slower`)
    : ''
})

const modeNote = computed(() => mode.value === 'slice'
  ? tr('切片图谱：节点=切片（标签取内容前 16 字），连线=该题依据的切片；颜色=作答情况。点击切片可直接练习这一片。', 'Slice graph: nodes = slices (label from the first 16 characters), edges = the slices a question is based on, colour = practice status. Click a slice to practise just that slice.')
  : mode.value === 'file'
    ? tr('文件图谱：节点=文件，连线=该题来源文件；颜色=掌握状态。点击文件可直接练习该文件。', 'File graph: nodes = files, edges = the file a question comes from, colour = mastery. Click a file to practise it.')
    : tr('本体图谱：节点=实体，连线=本体关系；颜色=掌握状态（与卡片进度条同色）。点击节点看详情或开始练习；范围下拉可选是否带问题节点。', 'Ontology graph: nodes = entities, edges = ontology relations, colour = mastery. Click a node for details or to practise; the scope dropdown controls whether question nodes are included.'))

/** 空态提示 */
const showAllText = computed(() => props.showAll
  ? tr('当前知识库没有本体数据。请到「知识处理」构建本体后再回来查看。', 'This KB has no ontology yet. Build it in Knowledge Processing first.')
  : tr('还没有已练习的实体。先按文件练习，作答会投影到本体实体上。', 'No practiced entities yet. Practice by file first — answers project onto ontology entities.'))
const emptyText = computed(() => {
  if (mode.value === 'slice') return tr('当前知识库没有切片，或切片还未入库。', 'This KB has no slices yet.')
  if (mode.value === 'file') return tr('当前知识库没有文件记录。', 'This KB has no file records.')
  return showAllText.value
})

/** 点击节点 → 实体 / 切片 / 文件 / 问题四种详情（互斥） */
function closeSel() { selected.value = null; selectedQ.value = null; selectedB.value = null; selectedF.value = null }
function onNodeClick(node: any) {
  const name = String(node?.label || '')
  const zh = props.store.locales === 'zh'
  if (node?.type === 'question') {
    closeSel()
    selectedQ.value = {
      text: String(node?.data?.[zh ? '题干' : 'Question'] || name),
      entities: String(node?.data?.[zh ? '关联' : 'Linked'] || ''),
    }
    return
  }
  if (node?.type === 'slice') {
    const bid = String(node?.id || '').replace(/^b:/, '')
    const b = (props.blocks || []).find((x: any) => String(x?.id) === bid)
    const st = props.blockStats?.[bid]
    closeSel()
    selectedB.value = {
      label: name,
      filePath: String(b?.filePath || ''),
      blockId: b?.id ?? bid,
      text: String(node?.data?.[zh ? '摘要' : 'Excerpt'] || ''),
      attempts: st?.attempts || 0,
      ok: st?.ok || 0,
    }
    return
  }
  if (node?.type === 'file') {
    const path = String(node?.id || '').replace(/^f:/, '')
    const it = (props.fileItems || []).find(x => String(x.key) === path)
    closeSel()
    selectedF.value = {
      path,
      label: name,
      status: it?.status || 'new',
      attempts: it?.attempts || 0,
      mastery: it?.mastery || 0,
      sliceCount: it?.sliceCount || 0,
    }
    return
  }
  closeSel()
  const it = itemByName.value.get(name)
  selected.value = it || {
    name, label: name, blockCount: 0, fileCount: 0, attempts: 0, mastery: 0, status: 'new', due: false,
  }
}
</script>

<template>
  <div class="gv-root">
    <!-- 顶部：图例 + 概览（颜色即掌握状态） -->
    <div class="gv-bar">
      <span class="gv-legend"><i class="gv-dot" style="background:#4CAF50"></i>{{ tr('已掌握', 'Mastered') }} {{ counts.mastered }}</span>
      <span class="gv-legend"><i class="gv-dot" style="background:#FF9800"></i>{{ tr('学习中', 'Learning') }} {{ counts.learning }}</span>
      <span class="gv-legend"><i class="gv-dot" style="background:#9E9E9E"></i>{{ tr('未开始', 'New') }} {{ counts.nnew }}</span>
      <span class="gv-legend" :title="tr('当前图的节点单位', 'Node unit of the current graph')">· {{ legendUnit }} {{ counts.total }}</span>
      <span v-if="withQuestions" class="gv-legend" :title="tr('问题节点（蓝）：挂在它们依据的实体 / 切片 / 文件上', 'Question nodes (blue), attached to the entities / slices / files they are based on')"><i class="gv-dot" style="background:#2196F3"></i>{{ tr('问题', 'Questions') }} {{ graphData.questionCount }}<template v-if="graphData.questionTotal > graphData.questionCount"> / {{ graphData.questionTotal }}</template></span>
      <span v-if="truncated" class="gv-legend gv-warn" :title="truncTitle"><i class="fa fa-info-circle"></i>{{ truncated }}</span>
      <span v-else-if="perfHint" class="gv-legend gv-warn" :title="tr('可在右侧「显示数量」重新调节点数量', 'Adjust the node count with “Show” on the right')"><i class="fa fa-clock-o"></i>{{ perfHint }}</span>
      <span style="flex:1;"></span>
      <span class="gv-limit" :title="tr('节点间距：节点挤在一起时可调大（同时放大斥力、连线长度与碰撞半径），调后会重新布局并自动适配视图', 'Node spacing: enlarge when nodes crowd together (scales repulsion, link length and collision radius); the graph re-layouts and re-fits')">
        <i class="fa fa-arrows-alt"></i>
        <select v-model.number="spacing" class="gv-limit-sel" :aria-label="tr('节点间距', 'Spacing')">
          <option v-for="o in SPACING_OPTIONS" :key="o.v" :value="o.v">{{ store.locales === 'zh' ? o.zh : o.en }}</option>
        </select>
      </span>
      <span class="gv-limit" :title="tr('节点标题：跟随数量=节点超过 500 时自动隐藏标题（默认）；总是显示 / 不显示可强制。节点很多时显示标题会明显变慢', 'Node labels: follow count = auto-hide above 500 nodes (default); always / never forces it. Labels on very large graphs slow things down noticeably')">
        <i class="fa fa-font"></i>
        <select v-model="labelMode" class="gv-limit-sel" :aria-label="tr('节点标题', 'Node labels')">
          <option value="auto">{{ tr('标题:跟随数量', 'Labels: auto') }}</option>
          <option value="on">{{ tr('标题:总是显示', 'Labels: always') }}</option>
          <option value="off">{{ tr('标题:不显示', 'Labels: never') }}</option>
        </select>
      </span>
      <span class="gv-limit" :title="tr('显示数量：图里问题 / 切片各自最多画多少个节点（超出只计数不画），默认 2000；选得越大，布局与拖拽越慢', 'Show: max nodes per kind (questions / slices) drawn, others are counted only. Default 2000 — larger values slow layout down')">
        <i class="fa fa-sliders"></i>
        <select v-model.number="nodeLimit" class="gv-limit-sel" :aria-label="tr('显示数量', 'Show')">
          <option v-for="n in LIMIT_OPTIONS" :key="n" :value="n">{{ n }}</option>
        </select>
      </span>
      <span class="gv-sep"></span>
      <span class="gv-legend gv-note" :title="modeNote"><i class="fa fa-info-circle"></i></span>
    </div>

    <!-- 图谱（缩放/拖拽/悬停详情由共享组件提供） -->
    <div class="gv-body">
      <div v-if="!graphData.nodes.length" class="gv-empty">
        <i class="fa fa-sitemap"></i>
        <p>{{ emptyText }}</p>
      </div>
      <KnowledgeGraphViewer v-else :graph-data="graphData" :show-labels="showLabels" :spacing="spacing" @node-click="onNodeClick" />
    </div>

    <!-- 底部：选中实体详情 + 练习/复习入口 -->
    <div v-if="selected" class="gv-sel">
      <i class="fa fa-eercast"></i>
      <span class="gv-sel-name" :title="selected.name">{{ selected.label }}</span>
      <span class="gv-sel-meta">
        {{ tr('掌握', 'Mastery') }} {{ fmtPct(selected.mastery) }} · {{ selected.attempts }} {{ tr('作答', 'answers') }} · {{ selected.blockCount }} {{ tr('切片', 'slices') }} · {{ selected.fileCount }} {{ tr('文件', 'files') }}
      </span>
      <span style="flex:1;"></span>
      <button class="gv-btn" :disabled="selected.blockCount === 0" @click="emit('practice', selected.name)" :title="tr('练习该实体关联切片', 'Practice this entity')"><i class="fa fa-pencil-square-o"></i> {{ tr('练习', 'Practice') }}</button>
      <button v-if="selected.due" class="gv-btn due" @click="emit('review', selected.name)" :title="tr('到期复习', 'Review')"><i class="fa fa-refresh"></i> {{ tr('复习', 'Review') }}</button>
      <button class="gv-btn ghost" @click="closeSel" :title="tr('关闭详情', 'Close')"><i class="fa fa-times"></i></button>
    </div>

    <!-- 底部：选中的切片节点（内容摘要 + 练习本片） -->
    <div v-else-if="selectedB" class="gv-sel">
      <i class="fa fa-file-text-o"></i>
      <span class="gv-sel-name" :title="selectedB.text">{{ selectedB.label }}</span>
      <span class="gv-sel-meta">
        {{ tr('切片', 'Slice') }} {{ selectedB.attempts }} {{ tr('作答', 'answers') }}{{ selectedB.attempts ? ` · ${tr('正确率', 'accuracy')} ${fmtPct(selectedB.ok / selectedB.attempts)}` : '' }}<template v-if="selectedB.filePath"> · {{ selectedB.filePath }}</template>
      </span>
      <span style="flex:1;"></span>
      <button class="gv-btn" :disabled="!selectedB.filePath" @click="emit('practiceBlock', selectedB.filePath, selectedB.blockId)" :title="tr('练习该切片', 'Practice this slice')"><i class="fa fa-pencil-square-o"></i> {{ tr('练习这一片', 'Practice slice') }}</button>
      <button class="gv-btn ghost" @click="closeSel" :title="tr('关闭详情', 'Close')"><i class="fa fa-times"></i></button>
    </div>

    <!-- 底部：选中的文件节点（掌握情况 + 练习该文件） -->
    <div v-else-if="selectedF" class="gv-sel">
      <i class="fa fa-file-o"></i>
      <span class="gv-sel-name" :title="selectedF.path">{{ selectedF.label }}</span>
      <span class="gv-sel-meta">
        {{ tr('掌握', 'Mastery') }} {{ fmtPct(selectedF.mastery) }} · {{ selectedF.attempts }} {{ tr('作答', 'answers') }} · {{ selectedF.sliceCount }} {{ tr('切片', 'slices') }}
      </span>
      <span style="flex:1;"></span>
      <button class="gv-btn" @click="emit('practiceFile', selectedF.path)" :title="tr('练习该文件', 'Practice this file')"><i class="fa fa-pencil-square-o"></i> {{ tr('练习此文件', 'Practice file') }}</button>
      <button class="gv-btn ghost" @click="closeSel" :title="tr('关闭详情', 'Close')"><i class="fa fa-times"></i></button>
    </div>

    <!-- 底部：选中的问题节点（题干 + 关联目标） -->
    <div v-else-if="selectedQ" class="gv-sel">
      <i class="fa fa-question-circle-o"></i>
      <span class="gv-sel-meta">{{ tr('问题', 'Question') }}</span>
      <span class="gv-sel-name" style="max-width:60%;" :title="selectedQ.text">{{ selectedQ.text }}</span>
      <span v-if="selectedQ.entities" class="gv-sel-meta">· {{ tr('关联', 'Linked') }} {{ selectedQ.entities }}</span>
      <span style="flex:1;"></span>
      <button class="gv-btn ghost" @click="closeSel" :title="tr('关闭详情', 'Close')"><i class="fa fa-times"></i></button>
    </div>
  </div>
</template>

<style scoped>
.gv-root { display: flex; flex-direction: column; height: 100%; min-height: 0; box-sizing: border-box; overflow: hidden; }
.gv-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 4px 6px; font-size: 11px; color: var(--fontColor, #1f2328); border-bottom: 1px solid var(--borderColor, #d0d7de); flex-shrink: 0; }
.gv-legend { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.gv-warn { color: #d99100; cursor: help; }
/* 显示数量配置（图例栏右侧） */
.gv-limit { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; opacity: .85; cursor: help; }
.gv-limit-sel { cursor: pointer; border: 1px solid var(--borderColor, #d0d7de); background: var(--backgroundColor, #fff); color: var(--fontColor, #1f2328); border-radius: 4px; font-size: 11px; padding: 1px 3px; height: 20px; }
.gv-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.gv-sep { width: 1px; height: 12px; background: var(--borderColor, #d0d7de); }
.gv-note { opacity: .7; cursor: help; }
.gv-body { flex: 1; min-height: 0; position: relative; }
.gv-empty { margin: auto; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--borderColor, #888); padding: 20px; text-align: center; }
.gv-empty i { font-size: 22px; }
.gv-empty p { font-size: 12px; line-height: 1.6; max-width: 420px; }
.gv-sel { display: flex; align-items: center; gap: 6px; flex-shrink: 0; padding: 4px 6px; border-top: 1px solid var(--borderColor, #d0d7de); font-size: 12px; color: var(--fontColor, #1f2328); }
.gv-sel > i { color: var(--fontActiveColor, #0969da); }
.gv-sel-name { font-weight: 500; max-width: 30%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gv-sel-meta { opacity: .65; font-size: 11px; }
.gv-btn { cursor: pointer; border: 1px solid var(--borderColor, #d0d7de); background: var(--backgroundColor, #fff); color: var(--fontColor, #1f2328); border-radius: 4px; font-size: 11px; padding: 3px 10px; display: inline-flex; align-items: center; gap: 4px; }
.gv-btn:hover { background: var(--menuActiveColor, #e5e5e5); }
.gv-btn:disabled { opacity: .5; cursor: default; }
.gv-btn.due { color: #d93025; border-color: #d93025; }
.gv-btn.ghost { border-color: transparent; }
</style>
