<!--
  /learning.vue —— 学习大模块（P1：记录 + 掌握度 + 间隔复习闭环）
  P0 已迁入考试(examView，原 examManager)。P1 新增：总览 / 学习地图(按文件) / 复习队列 / 错题本 /
  闪卡练习会话；作答记录落盘 <库名>.learning（learningRecord），掌握度/间隔复习见 learningCore。
  顶部标签样式与「知识处理」保持一致（.top-tabs/.tab-btn 同款视觉）。
-->
<script setup lang="ts">
defineOptions({ name: 'Learning' })
import { ref, computed, watch, onMounted, onActivated, onDeactivated } from 'vue'
import { usestore } from '@/store'
import * as kbAi from '@/shared/kbAiClient'
import {
  listKbFiles, readKbForLearning,
  type LearningKbFile, type LearningKbLoaded,
} from '@/services/kbReader'
import {
  emptyLData, loadLData, saveLData, syncObjectsWithKb,
  recordAttempt, clearObject, clearStale, objectMastery, wrongAttempts,
  trendStats, streakDays, claimMastered, tagAttemptErr,
  type LData, type LAttempt, type ErrType,
} from '@/services/learningRecord'
import {
  computeMastery, MASTERY_GATE,
  type KbType, guessKbType, kbTypeLabel,
} from '@/services/learningCore'
import type { LvmItem, PracticeItem, EntityItem } from '@/components/learning/types'
import overview from '@/components/learning/overview.vue'
import mapView from '@/components/learning/mapView.vue'
import entityView from '@/components/learning/entityView.vue'
import reviewView from '@/components/learning/reviewView.vue'
import mistakesView from '@/components/learning/mistakesView.vue'
import practiceView from '@/components/learning/practiceView.vue'
import examView from '@/components/learning/examView.vue'

const store = usestore()
const tr = (zh: string, en: string) => (store.locales === 'zh' ? zh : en)

// ==================== 知识库（自制读盘） ====================
const kbFiles = ref<LearningKbFile[]>([])
const selectedPath = ref('')
const loading = ref(false)
const kb = ref<LearningKbLoaded | null>(null)
const loadedMtime = ref(0)
const stateMsg = ref('')
const liveMsg = ref('')

// 判分/描述 LLM 模型（跟随全局 AI 配置）
const model = ref<any>({})
function syncModel() {
  const type = (store.AIconfig?.llm?.type as string) || 'ollama'
  const cfg = kbAi.getProviderConfig(store.AIconfig?.llm, type) || {}
  const ollama = kbAi.getProviderConfig(store.AIconfig?.llm, 'ollama') || {}
  model.value = {
    embed: cfg.embed_model || ollama.embed_model || 'nomic-embed-text:latest',
    chat: cfg.model || '',
    process: cfg.model || '',
    think: false,
  }
}

// ==================== 学习记录 ====================
const ldata = ref<LData | null>(null)
// 文件切片元信息缓存（key=文件相对路径；type=按切片正文启发式聚合的知识类型）
const metaMap = ref<Record<string, { sliceCount: number; qCount: number; blockIds: (string | number)[]; type?: KbType }>>({})

let saveTimer: any = null
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => { saveTimer = null; await flushSave() }, 400)
}
async function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  if (selectedPath.value && ldata.value) {
    const ok = await saveLData(selectedPath.value, ldata.value)
    if (!ok) liveMsg.value = tr('学习记录保存失败', 'Failed to save learning records')
  }
}

function fileKeyOf(b: any): string {
  return b.filePath || b.path || b.label || ''
}
type FileMeta = { sliceCount: number; qCount: number; blockIds: (string | number)[]; type?: KbType }
const TYPE_KEYS: KbType[] = ['memory', 'procedure', 'concept', 'design']
function buildMeta() {
  const map: Record<string, FileMeta & { counts?: Record<KbType, number> }> = {}
  if (!kb.value) return map
  const bidToFile = new Map<string, string>()
  for (const b of kb.value.blocks) {
    const k = fileKeyOf(b)
    if (b.id != null) bidToFile.set(String(b.id), k)
    if (!k) continue
    if (!map[k]) map[k] = { sliceCount: 0, qCount: 0, blockIds: [], counts: { memory: 0, procedure: 0, concept: 0, design: 0 } }
    const m = map[k]
    m.blockIds.push(b.id)
    if (String(b.A || '').trim()) {
      m.sliceCount += 1
      if (m.counts) m.counts[guessKbType(String(b.A || ''))] += 1
    }
  }
  // 问题数：由问题库统计（方案 A：问题只存问题库，不再拆切片 Q）
  for (const q of kb.value.questions || []) {
    if (q.status === 'merged' || !q.text) continue
    const f = q.srcFilePath
      || bidToFile.get(q.srcBlockId != null ? String(q.srcBlockId) : '')
      || (q.answerBlocks && q.answerBlocks[0] && (q.answerBlocks[0].filePath || bidToFile.get(q.answerBlocks[0].blockId != null ? String(q.answerBlocks[0].blockId) : '')))
      || ''
    if (!f || !map[f]) continue
    map[f].qCount += 1
  }
  for (const k of Object.keys(map)) {
    const m = map[k]
    let best: KbType = 'memory'
    let bn = -1
    for (const t of TYPE_KEYS) if ((m.counts?.[t] || 0) > bn) { best = t; bn = m.counts?.[t] || 0 }
    delete m.counts
    m.type = best
  }
  return map as Record<string, FileMeta>
}

async function loadSelected() {
  await flushSave()
  if (!selectedPath.value) { kb.value = null; ldata.value = null; return }
  loading.value = true
  kb.value = await readKbForLearning(selectedPath.value)
  loadedMtime.value = kbFiles.value.find(k => k.path === selectedPath.value)?.mtime || 0
  if (!kb.value) {
    ldata.value = null
    metaMap.value = {}
    liveMsg.value = tr('知识库加载失败（格式/版本不支持或仍在构建中）', 'Failed to load KB (unsupported format/version or still building)')
  } else {
    metaMap.value = buildMeta()
    const loaded = await loadLData(selectedPath.value)
    ldata.value = loaded || emptyLData(kb.value.label)
    // 同步对象（新建/过期标记）；有变化则落盘
    const files = Object.keys(metaMap.value).map(k => ({ key: k, label: kbLabelOf(k), type: metaMap.value[k].type, blockIds: metaMap.value[k].blockIds }))
    const changed = syncObjectsWithKb(ldata.value, files)
    if (changed) scheduleSave()
    if (kb.value.blockCount === 0) {
      liveMsg.value = tr('该知识库还没有切片内容，请先在「知识处理」切片后保存 .kb', 'This KB has no slices yet — slice & save in Knowledge Processing first')
    }
  }
  loading.value = false
}
function kbLabelOf(key: string): string {
  const f = kb.value?.files.find(x => x.path === key)
  return f?.label || key.split(/[\\/]/).pop() || key
}

async function scan() {
  if (!store.root) { kbFiles.value = []; return }
  kbFiles.value = await listKbFiles(store.root)
  if (selectedPath.value && !kbFiles.value.some(k => k.path === selectedPath.value)) {
    selectedPath.value = ''
    kb.value = null
    ldata.value = null
    practice.value = null
  } else if (selectedPath.value) {
    await loadSelected()
  }
}
function onPick() {
  kb.value = null
  ldata.value = null
  practice.value = null
  stateMsg.value = ''
  loadSelected()
}
/** 切回时按需刷新（仅列表变化或所选库 mtime 变化才重载） */
async function refreshOnActivate() {
  if (!store.root) { kbFiles.value = []; return }
  kbFiles.value = await listKbFiles(store.root)
  if (!selectedPath.value) return
  const cur = kbFiles.value.find(k => k.path === selectedPath.value)
  if (!cur) { selectedPath.value = ''; kb.value = null; ldata.value = null; practice.value = null; return }
  if (!kb.value || cur.mtime !== loadedMtime.value) await loadSelected()
}

// ==================== 视图 ====================
type ViewKey = 'overview' | 'map' | 'exam' | 'review' | 'mistakes'
const activeView = ref<ViewKey>('overview')
const showStale = ref(false)
const entityShowAll = ref(true) // 实体轴默认显示所有实体（含未练习）
const examTrack = ref(false) // 考试结果计入学习对象
const tabs: { key: ViewKey; icon: string; zh: string; en: string }[] = [
  { key: 'overview', icon: 'fa fa-dashboard', zh: '总览', en: 'Overview' },
  { key: 'map', icon: 'fa fa-map-o', zh: '地图', en: 'Map' },
  { key: 'review', icon: 'fa fa-refresh', zh: '复习', en: 'Review' },
  { key: 'mistakes', icon: 'fa fa-exclamation-circle', zh: '错题本', en: 'Mistakes' },
  { key: 'exam', icon: 'fa fa-graduation-cap', zh: '考试', en: 'Exam' },
]

const now = () => Date.now()
const vm = computed<LvmItem[]>(() => {
  const out: LvmItem[] = []
  if (!ldata.value) return out
  for (const key of Object.keys(ldata.value.objects)) {
    const o = ldata.value.objects[key]
    const meta = metaMap.value[key]
    const mastery = o.claimMastered ? 1 : objectMastery(o)
    const status = o.claimMastered || mastery >= MASTERY_GATE ? 'mastered' : mastery <= 0 ? 'new' : 'learning'
    const due = !o.claimMastered && !!o.attempts.length && !o.stale && o.srs.dueAt <= now()
    out.push({
      key,
      label: o.label,
      type: o.type || 'memory',
      sliceCount: meta?.sliceCount || 0,
      qCount: meta?.qCount || 0,
      attempts: o.attempts.length,
      mastery,
      status,
      due,
      dueAt: due ? o.srs.dueAt : 0,
      stale: o.stale,
      learnerClaimed: o.claimMastered || undefined,
    })
  }
  return out
})
const dueList = computed(() => vm.value.filter(it => it.due))
const stats = computed(() => ({
  totalPractice: ldata.value?.meta.totalPractice || 0,
  totalCorrect: ldata.value?.meta.totalCorrect || 0,
  lastPracticeAt: ldata.value?.meta.lastPracticeAt || 0,
}))
const wrongList = computed(() => {
  if (!ldata.value) return []
  return wrongAttempts(ldata.value).map(({ key, o, a }) => ({ key, label: o.label, a }))
})
const errTagged = computed(() => wrongList.value.filter(w => !!w.a.errType).length)
const summaryCounts = computed(() => {
  const c = { mastered: 0, learning: 0, nnew: 0, due: 0, stale: 0 }
  for (const it of vm.value) {
    if (it.stale) c.stale++
    if (it.due) c.due++
    if (it.status === 'mastered') c.mastered++
    else if (it.status === 'learning') c.learning++
    else c.nnew++
  }
  return c
})
// ==================== 地图轴（文件 / 实体） ====================
const mapAxis = ref<'file' | 'entity'>('file')
// 地图过滤下拉（all=显示过期/未开始, active=仅已有练习）→ 双向映射到各轴显示开关
const filterSel = computed<string>({
  get: () => {
    if (mapAxis.value === 'entity') return entityShowAll.value ? 'all' : 'active'
    return showStale.value ? 'all' : 'active'
  },
  set: (v: string) => {
    if (mapAxis.value === 'entity') entityShowAll.value = v === 'all'
    else showStale.value = v === 'all'
  },
})
// 学习统计（P2）：近 7 天趋势 + 连续打卡
const trend7 = computed(() => (ldata.value ? trendStats(ldata.value, 7) : []))
const trend30 = computed(() => (ldata.value ? trendStats(ldata.value, 30) : []))
const trendTotals = computed(() => trend7.value.map(t => t.total))
const trend30Totals = computed(() => trend30.value.map(t => t.total))
const streak = computed(() => (ldata.value ? streakDays(ldata.value) : 0))
// 实体轴（P2）：由文件作答经 entityNames 投影；实体本身不单独落盘（同一份记录两套视图）
const entityVM = computed<EntityItem[]>(() => {
  const out: EntityItem[] = []
  if (!kb.value || !ldata.value) return out
  const idxList = kb.value.entityToBlocks || []
  const all: { o: any; a: any }[] = []
  for (const key of Object.keys(ldata.value.objects)) {
    const o = ldata.value.objects[key]
    for (const a of o.attempts) all.push({ o, a })
  }
  const nowMs = Date.now()
  for (const en of idxList) {
    const ids = (en.blockIds || []).map(String)
    const present = kb.value.blocks.filter(b => ids.includes(String(b.id)))
    const fileSet = new Set<string>()
    for (const b of present) fileSet.add(fileKeyOf(b))
    const mine = all.filter(x => x.a.entityNames.includes(en.entityName))
    const mastery = computeMastery(mine.map((x: any) => x.a.ok))
    const status: EntityItem['status'] = mastery <= 0 ? 'new' : mastery >= MASTERY_GATE ? 'mastered' : 'learning'
    const due = mine.length > 0 && mine.some((x: any) => x.o.attempts.length > 0 && !x.o.stale && x.o.srs.dueAt <= nowMs)
    out.push({ name: en.entityName, label: en.entityName, blockCount: present.length, fileCount: fileSet.size, attempts: mine.length, mastery, status, due })
  }
  return out
})
// 主面板到期红徽标：不需要（用户决定），学习模块内用「复习」标签页到期数即可

type SC = { total: number; m: number; l: number; n: number; d: number }
const emptySC = (): SC => ({ total: 0, m: 0, l: 0, n: 0, d: 0 })
const fileSummary = computed<SC>(() => {
  const c = emptySC()
  for (const it of vm.value) {
    if (it.stale) continue
    c.total++
    if (it.status === 'mastered') c.m++
    else if (it.status === 'learning') c.l++
    else c.n++
    if (it.due) c.d++
  }
  return c
})
const entitySummary = computed<SC>(() => {
  const c = emptySC()
  for (const e of entityVM.value) {
    c.total++
    if (e.status === 'mastered') c.m++
    else if (e.status === 'learning') c.l++
    else c.n++
    if (e.due) c.d++
  }
  return c
})
const mapSummary = computed<SC>(() => (mapAxis.value === 'file' ? fileSummary.value : entitySummary.value))
const kbInfoText = computed(() =>
  kb.value
    ? `${tr('知识库', 'KB')}：${kb.value.label} · ${kb.value.files.length} ${tr('文件', 'files')} · ${kb.value.blockCount} ${tr('切片', 'slices')}${kb.value.entities.length ? ` · ${kb.value.entities.length} ${tr('实体', 'entities')}` : ''}`
    : ''
)

function fmtTime(t: number): string {
  if (!t) return ''
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// ==================== 练习会话（闪卡） ====================
const practice = ref<{
  label: string
  mode: 'self' | 'review'
  items: PracticeItem[]
  idx: number
  ok: number
  from: ViewKey            // 发起来源视图（结束时还原，错题本重练完回到错题本）
} | null>(null)

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
  return a
}
function entityNamesOf(blockId: any): string[] {
  const out: string[] = []
  if (!kb.value?.entityToBlocks) return out
  const bid = String(blockId)
  for (const e of kb.value.entityToBlocks) {
    if ((e.blockIds || []).some((id: any) => String(id) === bid)) out.push(e.entityName)
  }
  return out
}
function makeItems(blocks: any[], max = 10): PracticeItem[] {
  const chosen: PracticeItem[] = []
  const kbv = kb.value
  const bidSet = new Set(blocks.map((b: any) => (b.id != null ? String(b.id) : '')))
  // 方案 A：优先从问题库出题（每条问题 = 一个练习卡；答案 = 问题库生成答案，参考切片 = answerBlocks）
  const poolQ = (kbv?.questions || []).filter(q =>
    q.status !== 'merged' && q.text && q.srcBlockId && bidSet.has(String(q.srcBlockId)))
  for (const q of shuffle(poolQ).slice(0, max)) {
    const block = kbv?.blocks.find(b => String(b.id) === String(q.srcBlockId))
    const exAns = (q.extraAnswer && q.extraAnswer.trim()) ? q.extraAnswer.trim() : ''
    const f = q.srcFilePath || (block ? fileKeyOf(block) : '')
    if (!f) continue
    // 参考切片：问题库 answerBlocks → 切片正文（主来源缺失时回退到 srcBlockId）
    const refs: { label: string; content: string }[] = []
    const refList = (q.answerBlocks && q.answerBlocks.length) ? q.answerBlocks : [{ blockId: q.srcBlockId }]
    for (const r of refList) {
      const b = kbv?.blocks.find((x: any) => String(x.id) === String(r.blockId))
      const content = b ? String(b.A || '').trim() : ''
      if (!content) continue
      refs.push({ label: r.label || b?.label || String(r.blockId), content })
    }
    chosen.push({
      q: q.text,
      back: exAns || refs[0]?.content || '',
      hasAnswer: !!exAns,
      slices: exAns ? refs : [],
      objKey: f,
      filePath: f,
      blockId: q.srcBlockId,
      entityNames: entityNamesOf(q.srcBlockId),
    })
  }
  // 兜底：问题不足时按切片「复述」补足（保证无问题库的知识库仍可练习）
  if (chosen.length < max) {
    const usable = shuffle(blocks.filter((b: any) => String(b.A || '').trim()))
    for (const b of usable.slice(0, max - chosen.length)) {
      chosen.push({
        q: tr('请用自己的话复述本切片要点', 'Summarize this slice in your own words'),
        back: String(b.A || '').trim(),
        objKey: fileKeyOf(b),
        filePath: fileKeyOf(b),
        blockId: b.id,
        entityNames: entityNamesOf(b.id),
      })
    }
  }
  return chosen
}
function buildItems(fileKey?: string, onlyBlockId?: any, forReviewKeys?: string[]): PracticeItem[] {
  if (!kb.value) return []
  let pool: any[] = []
  if (fileKey) {
    pool = kb.value.blocks.filter(b => fileKeyOf(b) === fileKey)
    if (onlyBlockId) pool = pool.filter(b => String(b.id) === String(onlyBlockId))
    return makeItems(pool, 10)
  }
  if (forReviewKeys && forReviewKeys.length) {
    for (const k of forReviewKeys) pool = pool.concat(kb.value.blocks.filter(b => fileKeyOf(b) === k))
    return makeItems(pool, 10)
  }
  return []
}

function startPractice(fileKey?: string, blockId?: any) {
  const items = buildItems(fileKey, blockId)
  if (!items.length) { liveMsg.value = tr('没有可练习的切片（文件可能没有正文切片）', 'No practiceable slices') ; return }
  practice.value = { label: fileKey ? kbLabelOf(fileKey) : tr('练习', 'Practice'), mode: 'self', items, idx: 0, ok: 0, from: activeView.value }
  activeView.value = 'map'
}
function startReviewOne(key: string) {
  const items = buildItems(key)
  if (!items.length) { liveMsg.value = tr('该文件没有可复习的切片', 'No slices to review') ; return }
  practice.value = { label: tr('复习', 'Review') + '：' + kbLabelOf(key), mode: 'review', items, idx: 0, ok: 0, from: activeView.value }
  activeView.value = 'review'
}
function startReviewAll() {
  const keys = dueList.value.map(it => it.key)
  if (!keys.length) { liveMsg.value = tr('暂无到期复习', 'Nothing due') ; return }
  const items = buildItems(undefined, undefined, keys)
  if (!items.length) { liveMsg.value = tr('没有可复习的切片', 'No slices to review') ; return }
  practice.value = { label: tr('到期复习', 'Due review'), mode: 'review', items, idx: 0, ok: 0, from: activeView.value }
  activeView.value = 'review'
}

/** 实体轴练习：在实体关联切片上随机出题（作答仍记到各切片所属文件对象） */
function startEntityPractice(name: string) {
  if (!kb.value) return
  const en = kb.value.entityToBlocks?.find(e => e.entityName === name)
  const ids = (en?.blockIds || []).map(String)
  const blocks = kb.value.blocks.filter(b => ids.includes(String(b.id)))
  const items = makeItems(blocks, 10)
  if (!items.length) { liveMsg.value = tr('该实体没有可练习的切片（可能内容已变更）', 'No practiceable slices for this entity (content may have changed)') ; return }
  practice.value = { label: tr('实体', 'Entity') + '：' + name, mode: 'self', items, idx: 0, ok: 0, from: activeView.value }
  activeView.value = 'map'
}

/** 实体轴到期复习：对实体关联切片闪卡复习（作答计入所属文件对象） */
function startEntityReview(name: string) {
  if (!kb.value) return
  const en = kb.value.entityToBlocks?.find(e => e.entityName === name)
  const ids = (en?.blockIds || []).map(String)
  const blocks = kb.value.blocks.filter(b => ids.includes(String(b.id)))
  const items = makeItems(blocks, 10)
  if (!items.length) { liveMsg.value = tr('该实体没有可复习的切片（可能内容已变更）', 'No slices to review for this entity') ; return }
  practice.value = { label: tr('复习', 'Review') + '：' + name, mode: 'review', items, idx: 0, ok: 0, from: activeView.value }
  activeView.value = 'map'
}

/** 考试判分完成回传 → 计入对应来源文件的学习对象（仅勾选启用时） */
function onExamGraded(rows: { q: string; ok: boolean; score: number; blockId: any; filePath: string }[]) {
  if (!examTrack.value || !ldata.value) return
  let n = 0
  for (const r of rows) {
    if (!ldata.value.objects[r.filePath]) continue
    recordAttempt(ldata.value, r.filePath, {
      q: r.q, ok: r.ok, score: r.score, at: Date.now(), src: 'exam',
      blockId: r.blockId, filePath: r.filePath, entityNames: entityNamesOf(r.blockId),
    })
    n++
  }
  if (n) { scheduleSave(); liveMsg.value = tr(`已计入 ${n} 题到对应文件的学习对象`, `Tracked ${n} answers into their file learning objects`) }
}

function onPracticeResult(ok: boolean) {
  const p = practice.value
  if (!p || !ldata.value) return
  const it = p.items[p.idx]
  if (!it) return
  const o = ldata.value.objects[it.objKey]
  const wasMastered = !!o?.masteredAt
  const attempt: Omit<LAttempt, 'id'> = {
    q: it.q,
    ok,
    score: ok ? 100 : 0,
    at: Date.now(),
    src: p.mode === 'review' ? 'review' : 'self',
    blockId: it.blockId,
    filePath: it.filePath,
    entityNames: it.entityNames,
    // 答案快照：错题本直接读此，不再依赖切片现状；旧记录无此字段时回退来源切片正文
    answer: it.back,
    hasAnswer: !!it.hasAnswer,
  }
  const m = recordAttempt(ldata.value, it.objKey, attempt)
  scheduleSave()
  if (!wasMastered && m >= MASTERY_GATE) {
    liveMsg.value = tr(`🎉 已掌握「${ldata.value.objects[it.objKey]?.label || ''}」`, `Mastered "${ldata.value.objects[it.objKey]?.label || ''}"`)
  }
  if (ok) p.ok += 1
  p.idx += 1
  if (p.idx >= p.items.length) {
    const wrongN = p.idx - p.ok
    stateMsg.value = tr(
      `本组完成：${p.idx} 题 · 答对 ${p.ok} · 待加强 ${wrongN}`,
      `Done: ${p.idx} Q · correct ${p.ok} · to review ${wrongN}`
    )
  }
}
function closePractice() {
  flushSave()
  const from = practice.value?.from
  practice.value = null
  // 还原到发起来源视图（错题本重练 → 回到错题本；地图/复习/总览同理）
  if (from) activeView.value = from
}
/** 顶部标签切换：练习进行中先结束练习（落盘），再切到目标视图，避免练习卡片挡住其它视图 */
function goTab(v: ViewKey) {
  if (practice.value) closePractice()
  activeView.value = v
}

// ==================== 对象操作 ====================
function doClearStale(key: string) {
  if (ldata.value) { clearStale(ldata.value, key); scheduleSave() }
}
function doRelearn(key: string) {
  if (ldata.value) { clearObject(ldata.value, key); scheduleSave(); liveMsg.value = tr('已清空并重置该文件学习状态', 'Reset this file learning state') }
}
/** 声明已掌握（跳测/压缩已会内容）：“重学/清空”即可撤销 */
function doClaimMastered(key: string) {
  if (!ldata.value) return
  claimMastered(ldata.value, key)
  scheduleSave()
  liveMsg.value = tr('已声明掌握「' + (ldata.value.objects[key]?.label || '') + '」', 'Claimed mastered')
}
/** 手动设置知识类型（影响该对象的分型复习节奏） */
function doSetType(key: string, type: string) {
  const o = ldata.value?.objects[key]
  if (!o) return
  o.type = type as KbType
  scheduleSave()
  liveMsg.value = tr('已设为「' + kbTypeLabel(type as KbType, store.locales === 'zh') + '」类型', 'Type set to ' + kbTypeLabel(type as KbType, false))
}
/** 给一次错答标注错因 */
function doSetErr(key: string, attemptId: string, errType: string) {
  if (ldata.value && tagAttemptErr(ldata.value, key, attemptId, errType as ErrType)) scheduleSave()
}

// ==================== 生命周期 ====================
watch(() => store.root, () => {
  selectedPath.value = ''
  kb.value = null
  ldata.value = null
  practice.value = null
  stateMsg.value = ''
  refreshOnActivate()
})
watch(() => store.AIconfig?.llm, () => syncModel(), { deep: true })

onMounted(async () => {
  syncModel()
  await refreshOnActivate()
})
onActivated(async () => {
  syncModel()
  await refreshOnActivate()
})
onDeactivated(async () => {
  await flushSave()
})
</script>

<template>
  <div class="main">
    <!-- 顶栏：子标签（与知识处理同款） + 知识库选择 -->
    <div class="top-bar">
      <div class="top-tabs">
        <button
          v-for="tb in tabs"
          :key="tb.key"
          class="tab-btn"
          :class="{ active: activeView === tb.key }"
          @click="goTab(tb.key)"
        >
          <i class="fa" :class="tb.icon"></i> {{ store.locales === 'zh' ? tb.zh : tb.en }}
          <span v-if="tb.key === 'review' && dueList.length" class="due-badge">{{ dueList.length }}</span>
        </button>
      </div>
      <div class="top-spacer"></div>
      <div class="manage-toolbar">
        <span v-if="kb" class="folder-path" :title="tr('切片/文件/作答统计', 'slices/files/answers')">
          {{ kb.blockCount }} {{ tr('切片', 'slices') }} · {{ kb.files.length }} {{ tr('文件', 'files') }}
        </span>
        <select
          v-model="selectedPath"
          class="kb-select"
          :disabled="!kbFiles.length || loading"
          @change="onPick"
          :title="tr('选择知识库（仅已保存的 .kb）', 'Select a saved .kb')"
        >
          <option value="" disabled>
            {{ kbFiles.length ? tr('请选择知识库…', 'Select KB…') : tr('暂无知识库', 'No KB') }}
          </option>
          <option v-for="k in kbFiles" :key="k.path" :value="k.path">{{ k.label }}</option>
        </select>
        <button class="tb-btn" :title="tr('刷新知识库列表', 'Refresh KB list')" @click="scan">
          <i class="fa fa-refresh" :class="{ 'fa-spin': loading }"></i>
        </button>
      </div>
    </div>

    <!-- 空态 / 加载（未选库时显示帮助引导，与「知识处理」欢迎风格一致） -->
    <div v-if="!store.root" class="empty-state lk-help">
      <i class="fa fa-graduation-cap"></i>
      <h3>{{ tr('欢迎使用学习模块', 'Welcome to Learning') }}</h3>
      <p class="lk-help-desc">{{ tr('学习模块围绕知识库（.kb）做掌握度追踪、间隔复习与考试。开始前请先选择一个工作区文件夹：', 'Learning tracks mastery over your knowledge bases (.kb) with spaced review and exams. Start by picking a workspace folder:') }}</p>
      <ul class="lk-help-list">
        <li>{{ tr('点击右上角「选择知识库文件夹」，选择存放 Markdown 文档与 .kb 的文件夹（与「知识处理」同一工作区）', 'Click "Select KB folder" at top-right and choose the folder holding Markdown docs & .kb (same workspace as Knowledge Processing)') }}</li>
        <li>{{ tr('若还没有 .kb，可先到「知识处理」切片 / 向量化后保存生成', 'No .kb yet? Slice/embed then save one in Knowledge Processing') }}</li>
      </ul>
    </div>
    <div v-else-if="!kbFiles.length" class="empty-state lk-help">
      <i class="fa fa-book"></i>
      <h3>{{ tr('还没有可学习的知识库', 'No knowledge base yet') }}</h3>
      <p class="lk-help-desc">{{ tr('学习内容来自「知识处理」保存的 .kb 文件，请按以下步骤准备：', 'Learning content comes from .kb files saved in Knowledge Processing. Prepare one like this:') }}</p>
      <ul class="lk-help-list">
        <li>{{ tr('① 到「知识处理」打开工作区并完成：文件 → 切片 → 向量化（可按需构建本体 / 推理问题）', '① Open the folder in Knowledge Processing: Files → Slices → Embed (optionally build ontology / infer questions)') }}</li>
        <li>{{ tr('② 点击上方「保存知识库」生成 .kb 文件', '② Click "Save KB" to produce a .kb file') }}</li>
        <li>{{ tr('③ 回到本页右上角刷新列表并选择它即可开始（作答记录另存为 .learning，绝不改写 .kb）', '③ Refresh & pick it here — records go to .learning, never into .kb') }}</li>
      </ul>
    </div>
    <div v-else-if="!selectedPath" class="empty-state lk-help">
      <i class="fa fa-dashboard"></i>
      <h3>{{ tr('请选择一个知识库', 'Pick a knowledge base') }}</h3>
      <p class="lk-help-desc">{{ tr('当前工作区共有 ' + kbFiles.length + ' 个知识库，选择后即可开始：', 'There are ' + kbFiles.length + ' KB(s) in this workspace — pick one to start:') }}</p>
      <ul class="lk-help-list">
        <li>{{ tr('从右上角下拉选择一个知识库（「总览」会给出下一步建议）', 'Choose one from the top-right dropdown; Overview suggests your next step') }}</li>
        <li>{{ tr('点击下拉旁的刷新按钮可重新扫描；新保存的 .kb 刷新后才会出现', 'Click refresh next to the dropdown to rescan; freshly saved .kb appears after refresh') }}</li>
      </ul>
    </div>
    <div v-else-if="loading || !kb || !ldata" class="empty-state">
      <i class="fa fa-spinner fa-spin"></i>
      <p>{{ tr('正在加载知识库…', 'Loading knowledge base…') }}</p>
    </div>

    <!-- 内容 -->
    <template v-else>
      <!-- 练习会话（覆盖内容区） -->
      <practiceView
        v-if="practice"
        :store="store"
        :item="practice.items[practice.idx] || null"
        @result="onPracticeResult"
        @close="closePractice"
      />
      <!-- 考试（P0 迁入；“计入学习对象”开关已收进考试工具栏） -->
      <div v-else-if="activeView === 'exam'" class="map-shell">
        <div class="view-wrap exam-host">
          <examView
            :store="store"
            :blocks="kb.blocks"
            :model="model"
            :exam-track="examTrack"
            @updateState="(s: any) => { stateMsg = s }"
            @updateLiveState="(s: any) => { liveMsg = s }"
            @update-exam-track="(v: any) => { examTrack = v }"
            @exam-graded="onExamGraded"
          />
        </div>
      </div>
      <!-- 总览（行动中心：下一步建议 + 整体进度 + 趋势） -->
      <div v-else-if="activeView === 'overview'" class="view-wrap">
        <overview
          :store="store"
          :vm="vm"
          :streak="streak"
          :days="trendTotals"
          :days-30="trend30Totals"
          :wrong-count="wrongList.length"
          :total-practice="stats.totalPractice"
          :total-correct="stats.totalCorrect"
          @review="startReviewAll"
          @practice="(k) => startPractice(k)"
          @mistakes="activeView = 'mistakes'"
          @map="activeView = 'map'"
        />
      </div>
      <!-- 学习地图（按文件 | 按实体） -->
      <div v-else-if="activeView === 'map'" class="map-shell">
        <div class="map-axis">
          <button class="axis-btn" :class="{ active: mapAxis === 'file' }" @click="mapAxis = 'file'"><i class="fa fa-file-text-o"></i> {{ tr('按文件', 'By file') }}</button>
          <button class="axis-btn" :class="{ active: mapAxis === 'entity' }" @click="mapAxis = 'entity'"><i class="fa fa-eercast"></i> {{ tr('按实体', 'By entity') }}</button>
          <span class="axis-note">{{ mapAxis === 'file' ? tr('以来源文件为学习单位', 'files as learning units') : tr('以本体实体为学习单位（由文件作答投影）', 'entities as units (projected from file answers)') }}</span>
          <span style="flex:1;"></span>
          <select
            v-if="mapAxis === 'file'"
            v-model="filterSel"
            class="axis-select"
            :title="tr('对象范围：仅有效 / 含过期（知识库更新后被标记，记录保留）', 'Scope: active only / include stale (marked after KB update, records kept)')"
          >
            <option value="active">{{ tr('仅有效', 'Active only') }}</option>
            <option value="all">{{ tr('含过期', 'Include stale') }}</option>
          </select>
          <select
            v-else
            v-model="filterSel"
            class="axis-select"
            :title="tr('实体范围：全部实体 / 仅已有练习的实体', 'Entity scope: all / only with attempts')"
          >
            <option value="all">{{ tr('全部实体', 'All entities') }}</option>
            <option value="active">{{ tr('仅已练习', 'With attempts') }}</option>
          </select>
        </div>
        <div class="view-wrap">
          <mapView
            v-if="mapAxis === 'file'"
            :store="store"
            :vm="vm"
            :show-stale="showStale"
            @practice="(k) => startPractice(k)"
            @review="startReviewOne"
            @clear-stale="doClearStale"
            @relearn="doRelearn"
            @claim-mastered="doClaimMastered"
            @set-type="doSetType"
          />
          <entityView v-else :store="store" :items="entityVM" :show-all="entityShowAll" @practice="startEntityPractice" @review="startEntityReview" />
        </div>
      </div>
      <!-- 复习 -->
      <div v-else-if="activeView === 'review'" class="view-wrap">
        <reviewView :store="store" :due="dueList" @start-all="startReviewAll" @review="startReviewOne" />
      </div>
      <!-- 错题本 -->
      <div v-else class="view-wrap">
        <mistakesView
          :store="store"
          :kb="kb"
          :model="model"
          :wrong="wrongList"
          @practice-one="(k, bid) => startPractice(k, bid)"
          @update-err="doSetErr"
        />
      </div>
    </template>

    <!-- 底部状态栏：练习/加载等操作状态；地图轴统计（其余视图统计在各视图内容区，避免重复） -->
    <div class="status-panel">
      <!-- 未选择 / 未加载知识库：提示当前工作区有多少个知识库 -->
      <template v-if="!kb && !practice">
        <span class="status-hint" :title="tr('点击右上角选择知识库', 'Pick a KB at top-right')">
          <i class="fa fa-book"></i>
          <template v-if="kbFiles.length">{{ kbFiles.length }} {{ tr('个知识库', 'KB(s)') }}</template>
          <template v-else>{{ tr('暂无知识库，请先到「知识处理」切片并保存 .kb', 'No KB yet — slice & save .kb in Knowledge Processing') }}</template>
        </span>
      </template>
      <!-- 练习会话：文件名 / 进度 / 对错计数 -->
      <template v-if="practice">
        <span class="status-name" :title="practice.label"><i class="fa fa-pencil-square-o"></i> {{ practice.label }}</span>
        <span class="status-prog">
          {{ tr('进度', 'Progress') }} {{ practice.items.length ? Math.min(practice.idx + 1, practice.items.length) : 0 }}/{{ practice.items.length }}
        </span>
        <span class="status-live">
          {{ tr('答对', 'Correct') }} {{ practice.ok }} · {{ tr('待加强', 'To review') }} {{ practice.idx - practice.ok }}
        </span>
      </template>
      <!-- 学习地图：当前轴相关统计 -->
      <template v-else-if="kb && ldata && activeView === 'map'">
        <span class="status-hint">
          <i class="fa" :class="mapAxis === 'file' ? 'fa-file-text-o' : 'fa-eercast'"></i>
          {{ mapAxis === 'file' ? tr('文件对象', 'Files') : tr('实体', 'Entities') }} {{ mapSummary.total }} · {{ tr('掌握', 'Mastered') }} {{ mapSummary.m }} · {{ tr('学习中', 'Learning') }} {{ mapSummary.l }} · {{ tr('未开始', 'New') }} {{ mapSummary.n }}<template v-if="mapSummary.d > 0"> · {{ tr('到期', 'Due') }} {{ mapSummary.d }}</template>
        </span>
        <span v-if="mapAxis === 'file' && summaryCounts.stale > 0" class="status-warn" :title="tr('知识库更新后旧记录保留并标记过期，可在「学习地图」清除或重学', 'KB updated — stale records kept; clear or relearn in Map')">
          <i class="fa fa-exclamation-triangle"></i> {{ summaryCounts.stale }} {{ tr('个过期', 'stale') }}
        </span>
      </template>
      <!-- 错题本：错题统计显示于底部状态栏 -->
      <template v-else-if="kb && ldata && activeView === 'mistakes'">
        <span class="status-hint"><i class="fa fa-exclamation-circle"></i> {{ tr('错题', 'Mistakes') }} <b>{{ wrongList.length }}</b><template v-if="errTagged"> · {{ tr('已标错因', 'tagged') }} <b>{{ errTagged }}</b></template></span>
      </template>
      <!-- 其余视图：仅显示知识库加载信息（文件/切片/实体） -->
      <span v-else-if="kb && !practice" class="status-hint"><i class="fa fa-database"></i> {{ kbInfoText }}</span>

      <span v-if="!practice" class="status-live"><i v-if="loading" class="fa fa-spinner fa-spin"></i> {{ liveMsg }}</span>
      <span style="flex:1;"></span>
      <span v-if="!practice" class="status-state">{{ stateMsg }}</span>
    </div>
  </div>
</template>

<style scoped>
.main {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  box-sizing: border-box;
  overflow: hidden;
}
/* ===== 顶栏（与知识处理一致） ===== */
.top-bar {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--borderColor);
  flex-shrink: 0;
  background: var(--menuColor);
}
.top-tabs { display: flex; flex-shrink: 0; }
.top-tabs .tab-btn {
  position: relative;
  padding: 8px 12px;
  font-size: 12px;
  border: none;
  background: none;
  color: var(--fontColor);
  cursor: pointer;
  text-align: center;
  border-bottom: 2px solid transparent;
  transition: all 0.2s;
}
.top-tabs .tab-btn:hover { background: var(--backgroundColor); }
.top-tabs .tab-btn.active {
  border-bottom-color: var(--fontActiveColor);
  color: var(--fontActiveColor);
  background: var(--backgroundColor);
}
.due-badge {
  position: absolute;
  top: 4px;
  right: 2px;
  min-width: 14px;
  height: 14px;
  line-height: 14px;
  border-radius: 7px;
  background: #d93025;
  color: #fff;
  font-size: 9px;
  padding: 0 3px;
  box-sizing: border-box;
}
.manage-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 5px;
  background: var(--menuColor);
}
.folder-path {
  font-size: 12px;
  color: var(--fontColor);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.top-spacer { flex: 1; }
.kb-select {
  width: 120px;
  height: 26px;
  margin: 0 5px;
  background-color: var(--backgroundColor);
  flex-shrink: 0;
  border: 0px;
  color: var(--fontColor);
  font-size: 12px;
}
.tb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  cursor: pointer;
  color: var(--fontColor);
  background: var(--backgroundColor);
  font-size: 12px;
}
.tb-btn:hover { background: var(--menuActiveColor); }
/* ===== 内容区 ===== */
.view-wrap {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.view-wrap > :deep(*) { flex: 1; min-height: 0; }
.exam-host > :deep(*) { flex: 1; min-height: 0; }
.empty-state {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--borderColor);
  font-size: 13px;
  padding: 20px;
  text-align: center;
}
.empty-state i { font-size: 30px; }
.empty-state p { margin: 0; }
/* 帮助引导（未选库空态，仿「知识处理」欢迎引导）：图标 + 标题 + 说明 + 要点列表 */
.empty-state.lk-help { gap: 10px; }
.empty-state.lk-help h3 { margin: 0; font-size: 15px; color: var(--fontActiveColor); font-weight: 600; }
.empty-state.lk-help .lk-help-desc { margin: 0; max-width: 600px; line-height: 1.7; color: var(--fontColor); }
.empty-state.lk-help .lk-help-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 5px; max-width: 640px; text-align: left; }
.empty-state.lk-help .lk-help-list li { position: relative; padding-left: 16px; line-height: 1.7; color: var(--fontColor); font-size: 12px; }
.empty-state.lk-help .lk-help-list li::before { content: '\25B8'; position: absolute; left: 0; top: 0; color: var(--fontActiveColor); }
/* ===== 地图轴切换（文件 / 实体） ===== */
.map-shell { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
.map-axis { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-bottom: 1px solid var(--borderColor); flex-shrink: 0; background: var(--menuColor); }
.axis-btn { cursor: pointer; border: 1px solid var(--borderColor); background: var(--backgroundColor); color: var(--fontColor); border-radius: 4px; font-size: 12px; padding: 2px 10px; }
.axis-btn:hover { background: var(--menuActiveColor); }
.axis-btn.active { border-color: var(--fontActiveColor); color: var(--fontActiveColor); background: var(--menuActiveColor); }
.axis-note { font-size: 11px; color: var(--borderColor); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 地图过滤下拉：参照 kb-select（无边框、无底色），固定高度不撑开地图轴 */
.axis-select {
  height: 24px;
  box-sizing: border-box;
  flex-shrink: 0;
  max-width: 130px;
  background-color: var(--backgroundColor);
  border: 0;
  outline: none;
  color: var(--fontColor);
  font-size: 12px;
  cursor: pointer;
  padding: 0 2px;
  margin: 0px
}
.axis-select:hover { color: var(--fontActiveColor); }
/* ===== 考试计入开关条 ===== */
/* ===== 底部状态栏 ===== */
.status-panel {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  overflow: hidden;
  padding: 6px 10px; /* 与「知识处理」prep-status-panel 对齐 */
  background: var(--menuColor);
  border-top: 1px solid var(--borderColor);
  font-size: 11px;
  /* 行高继承全局（与 RAG 状态栏同一来源），保证高度一致 */
}
.status-live { color: #FF9800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.status-state { color: var(--borderColor); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.status-hint { display: inline-flex; align-items: center; gap: 4px; color: var(--fontColor); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.status-hint b { color: var(--fontActiveColor); font-weight: 700; }
.status-sep { width: 1px; height: 11px; background: var(--borderColor); flex-shrink: 0; }
.status-name { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 500; color: var(--fontColor); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 40%; }
.status-prog { color: var(--fontColor); white-space: nowrap; }
.status-warn { color: #FF9800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.status-time { color: var(--borderColor); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.status-action { cursor: pointer; border: 1px solid #d93025; color: #d93025; background: transparent; border-radius: 4px; font-size: 11px; padding: 1px 8px; white-space: nowrap; flex-shrink: 0; }
.status-action:hover { background: rgba(217, 48, 37, 0.08); }
</style>
