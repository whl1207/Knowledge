<!-- /questionView.vue - 问题库（Question Bank）标签页 -->
<script setup lang="ts">
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { ElMessageBox } from 'element-plus'
import * as XLSX from 'xlsx'
import { usestore } from '@/store'
import * as kbAi from '@/shared/kbAiClient'
import block_md from '@/components/block_md.vue'
import { splitQuestionText, detectDuplicateGroups, answerText } from '@/shared/kbQuestions'
import { cosineSimilarity } from '@/shared/kbRetrieval'
import type { KbQuestion, DupGroup, QuestionAnswerRef } from '@/shared/kbQuestions'

defineOptions({ name: 'QuestionView' })

// ---------------- 组件接口（能力由父壳 knowRAG 注入，保证问题库单真源） ----------------
interface Props {
  store?: any
  model: any
  questionBank: KbQuestion[]
  blocks: any[]
  files?: any[]
  // 提取进度（父壳维护，与 .kb 保存/恢复联动）
  extractProgress?: any
  extractProgressPercent?: number
  extractProgressText?: string
  getModel: () => Promise<void>
  // 能力注入
  onStartExtract?: () => void
  onPauseExtract?: () => void
  onStopExtract?: () => void
  onContinueExtract?: () => void
  onApplyQuestionBank?: (list: KbQuestion[]) => void
  onAddManualQuestion?: (text: string, extraAnswer?: string, answerBlocks?: QuestionAnswerRef[]) => Promise<KbQuestion | null>
  onRemoveQuestion?: (id: string) => void
  onUpdateQuestion?: (id: string, patch: Partial<KbQuestion>) => Promise<void>
  onEmbedMissing?: (onMsg?: (msg: string) => void) => Promise<number>
}
const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'updateState', s: string): void
  (e: 'updateLiveState', s: string): void
  (e: 'updateReviewBad', n: number): void
  (e: 'updateReviewStatus', s: string): void
  (e: 'updateReviewRunning', b: boolean): void
}>()
const store = props.store || usestore()
const zh = computed(() => store.locales == 'zh')

// 模型规格（与 knowRAG / testManager 同一构建方式）
const kbSpec = () => kbAi.buildSpecFromModel(props.model, store)
const kbEmbed = async (input: string | string[]) => kbAi.embed(kbSpec(), input)
const kbChat = async (messages: any[], opts?: any) => kbAi.chat(kbSpec(), messages, opts)

const blocksById = computed(() => new Map((props.blocks || []).map((b: any) => [b.id, b])))
const blockFileOf = (q: KbQuestion) => {
  if (q.srcFilePath) return q.srcFilePath.split(/[\\/]/).pop() || q.srcFilePath
  const b = blocksById.value.get(q.srcBlockId || '')
  return b?.label || ''
}
/** 切片所在文件名（展示用） */
const sliceFileOf = (b: any) => {
  const fp = b?.filePath || ''
  return fp.split(/[\\/]/).pop() || b?.label || b?.id || ''
}
/** 当前知识库是否已加载切片（无切片时隐藏「指定切片」按钮与相关入口） */
const hasSlices = computed(() => !!(props.blocks && props.blocks.length))
/** 截断长文本（展示切片正文用） */
const qbSnippet = (t: any, n = 300) => {
  const s = String(t ?? '')
  return s.length > n ? s.slice(0, n) + '…' : s
}

// ---------------- 统计 ----------------
const activeQuestions = computed(() => (props.questionBank || []).filter(q => q.status !== 'merged'))
const mergedQuestions = computed(() => (props.questionBank || []).filter(q => q.status === 'merged'))
const embeddedCount = computed(() => activeQuestions.value.filter(q => q.qVector && q.qVector.length).length)
const bankSlices = computed(() => new Set(activeQuestions.value.map(q => q.srcBlockId).filter(Boolean)).size)
const originLabel = (o?: string) => {
  const map: Record<string, [string, string]> = {
    reasoned: ['切片推理', 'Reasoned'],
    manual: ['手动', 'Manual'],
    imported: ['导入', 'Imported'],
    complex: ['复合', 'Complex'],
  }
  const v = map[o || ''] || ['', '']
  return zh.value ? v[0] : v[1]
}

// ---------------- 搜索 / 筛选 / 展开 ----------------
const keyword = ref('')
const filterMode = ref<'all' | 'nov' | 'noans' | 'bad'>('all')
const filtered = computed(() => {
  let list = activeQuestions.value
  const kw = keyword.value.trim().toLowerCase()
  if (kw) list = list.filter(q => q.text.toLowerCase().includes(kw) || (q.extraAnswer || '').toLowerCase().includes(kw) || blockFileOf(q).toLowerCase().includes(kw))
  if (filterMode.value === 'nov') list = list.filter(q => !(q.qVector && q.qVector.length))
  if (filterMode.value === 'noans') list = list.filter(q => resolveAnswer(q).length === 0)
  if (filterMode.value === 'bad') list = list.filter(q => reviewMap.value.get(q.id)?.bad)
  return list
})

// ---------------- 问题悬停显示文件名（不在右侧展示） ----------------
const fileTitle = (q: KbQuestion) => q.srcFilePath || blockFileOf(q) || ''

// ---------------- 滚动分批加载（与切片页一致：40/批 + 触底加载 + 首屏填充） ----------------
const Q_PAGE = 40
const qRenderCount = ref(Q_PAGE)
const qLoadingMore = ref(false)
const qListEl = ref<HTMLElement | null>(null)
const hasMoreQ = computed(() => qRenderCount.value < filtered.value.length)
const displayedQ = computed(() => filtered.value.slice(0, qRenderCount.value))

function appendMoreQ() {
  if (!hasMoreQ.value) return
  qRenderCount.value = Math.min(qRenderCount.value + Q_PAGE, filtered.value.length)
}
function loadMoreQ() {
  if (qLoadingMore.value || !hasMoreQ.value) return
  qLoadingMore.value = true
  requestAnimationFrame(() => {
    setTimeout(() => {
      appendMoreQ()
      qLoadingMore.value = false
      fillViewportQ()
    }, 50)
  })
}
async function fillViewportQ() {
  const el = qListEl.value
  if (!el || !hasMoreQ.value) return
  // 组件常驻挂载后可能处于隐藏态（v-show 切到其它标签页，display:none 时 clientHeight 为 0）：
  // 此时补屏会触发后台批量渲染，跳过，待切回可见后再由滚动/变更补齐。
  if (!el.clientHeight) return
  let guard = 0
  while (hasMoreQ.value && el.scrollHeight <= el.clientHeight + 4 && guard < 60) {
    appendMoreQ()
    guard++
    await nextTick()
  }
}
function resetScrollQ() {
  qRenderCount.value = Q_PAGE
  qLoadingMore.value = false
}
function handleQListScroll(e: Event) {
  const el = e.target as HTMLElement
  if (!el) return
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 200 && hasMoreQ.value && !qLoadingMore.value) {
    loadMoreQ()
  }
}
// 搜索词 / 筛选变化 → 回到第一屏并补齐可视高度
watch(
  () => [keyword.value, filterMode.value],
  () => { resetScrollQ(); nextTick(() => fillViewportQ()) },
)
// 问题数量变化：数量增加（批量提取/导入/单条新增）→ 回第一屏并补齐可视高度；
// 数量减少（删除/合并移除单条）→ 不重置分页、不回顶，
// 否则会把已「下滑加载更多」的列表瞬间缩回首批，内容高度塌缩导致 scrollTop 被钳制回顶、当前浏览位置丢失。
const prevQCount = ref(props.questionBank?.length || 0)
watch(
  () => props.questionBank?.length,
  (n) => {
    const grew = n >= prevQCount.value
    prevQCount.value = n
    if (grew) resetScrollQ()
    nextTick(() => fillViewportQ())
  },
)

// ---------------- 答案文本 ----------------
const resolveAnswer = (q: KbQuestion) => answerText(q, props.blocks, ' | ')

const removeQ = async (q: KbQuestion) => {
  props.onRemoveQuestion?.(q.id)
  reviewMap.value.delete(q.id)
}
const reVectorize = async (q: KbQuestion) => {
  try {
    const e = await kbEmbed(q.text)
    if (e?.[0]) await props.onUpdateQuestion?.(q.id, { qVector: e[0] })
    else emit('updateState', zh.value ? '向量化失败' : 'Embedding failed')
  } catch { emit('updateState', zh.value ? '向量化失败' : 'Embedding failed') }
}

// ---------------- 手动添加（可附带参考答案 + 参考切片） ----------------
const showAdd = ref(false)
const addText = ref('')
const addAnswer = ref('')
// 手动添加时已选定的参考切片 id（添加成功后清空）
const addPickIds = ref<string[]>([])
const addPickBlocks = computed(() => addPickIds.value.map(id => blocksById.value.get(id)).filter(Boolean))
const removeAddSlice = (id: string) => { addPickIds.value = addPickIds.value.filter(x => x !== id) }
const cancelAdd = () => { showAdd.value = false; addPickIds.value = [] }
const submitAdd = async () => {
  const refs = buildRefsFromIds(addPickIds.value)
  const q = await props.onAddManualQuestion?.(addText.value, addAnswer.value, refs as QuestionAnswerRef[])
  if (q) {
    showAdd.value = false; addText.value = ''; addAnswer.value = ''
    addPickIds.value = []
    // 手动添加的问题已插入列表最前：回到顶部第一屏，确保刚添加的问题立即可见
    nextTick(() => {
      const el = qListEl.value
      if (el) el.scrollTop = 0
      resetScrollQ()
      fillViewportQ()
    })
    emit('updateState', zh.value ? `已添加问题 ${q.text.slice(0, 24)}...` : `Added "${q.text.slice(0, 24)}..."`)
  } else emit('updateState', zh.value ? '问题不能为空' : 'Question must not be empty')
}

// ---------------- 参考切片选择（手动输入答案可指定切片：模态框搜索 / 大模型推荐） ----------------
/** 模态框上下文：add=手动添加时选取；edit=编辑某问题的答案与参考切片 */
type PickCtx = { kind: 'add' } | { kind: 'edit'; q: KbQuestion }
const picker = ref<PickCtx | null>(null)
const pickOpen = computed(() => !!picker.value)
const pickKw = ref('')
const pickSel = ref<string[]>([])
const pickAnswerDraft = ref('')
/** 模态框内待编辑的问题文本草稿（问题配置模式下可改问题；保存时写回） */
const pickQuestionDraft = ref('')
const pickMsg = ref('')
const llmRecRunning = ref(false)
const PICK_PAGE = 60
const pickShown = ref(PICK_PAGE)
/** LLM 推荐结果（保持推荐顺序；与搜索一样在下方列表过滤显示，不默认展示全库） */
const llmRecIds = ref<string[]>([])
/** 列表当前来源：search=关键词搜索；rec=LLM 推荐结果；sel=当前已选切片（默认，供直接核对/管理参考切片） */
const listSrc = ref<'search' | 'rec' | 'sel'>('sel')
/** 正在查看完整内容的切片（block_md 渲染） */
const slicePreview = ref<any>(null)
const closeSlicePreview = () => { slicePreview.value = null }
const openSlicePreview = (b: any) => { if (b) slicePreview.value = b }
const isRecId = (id: string) => llmRecIds.value.includes(id)
const clearLlmRec = () => { llmRecIds.value = []; listSrc.value = 'sel' }
/** 下方列表显示的切片：关键词搜索 / LLM 推荐 / 当前已选切片（默认，便于直接核对与管理参考切片） */
const pickList = computed(() => {
  const kw = pickKw.value.trim().toLowerCase()
  const all = props.blocks || []
  if (kw && listSrc.value === 'search') {
    return all.filter((b: any) =>
      (b.label || '').toLowerCase().includes(kw) ||
      (b.A || '').toLowerCase().includes(kw) ||
      (b.filePath || '').toLowerCase().includes(kw))
  }
  if (listSrc.value === 'rec' && llmRecIds.value.length) {
    return llmRecIds.value.map(id => blocksById.value.get(id)).filter(Boolean)
  }
  // 默认「已选」视图：展示当前选中的参考切片（保持选中顺序）
  return pickSel.value.map(id => blocksById.value.get(id)).filter(Boolean)
})
/** 列表来源模式：search=关键词搜索；rec=LLM 推荐；sel=当前已选；none=尚无内容 */
const pickListMode = computed<'search' | 'rec' | 'sel' | 'none'>(() => {
  if (pickKw.value.trim() && listSrc.value === 'search') return 'search'
  if (listSrc.value === 'rec' && llmRecIds.value.length) return 'rec'
  if (pickSel.value.length) return 'sel'
  return 'none'
})
const pickVisible = computed(() => pickList.value.slice(0, pickShown.value))
const pickMore = computed(() => pickShown.value < pickList.value.length)
// 输入关键词 → 搜索视图；清空关键词且已有推荐 → 推荐视图；否则回默认「已选」（均重置分页）
watch(() => pickKw.value, () => {
  pickShown.value = PICK_PAGE
  if (pickKw.value.trim()) listSrc.value = 'search'
  else if (llmRecIds.value.length) listSrc.value = 'rec'
  else listSrc.value = 'sel'
})
// 选中集 / 推荐集变化 → 重置分页（避免「已选」视图在移除后留白）
watch(() => pickSel.value.length, () => { pickShown.value = PICK_PAGE })
watch(() => llmRecIds.value.length, () => { pickShown.value = PICK_PAGE })
const isPickSel = (id: string) => pickSel.value.includes(id)
const togglePick = (id: string) => {
  pickSel.value = pickSel.value.includes(id)
    ? pickSel.value.filter(x => x !== id)
    : [...pickSel.value, id]
}
const pickSelBlocks = computed(() => pickSel.value.map(id => blocksById.value.get(id)).filter(Boolean))
const loadMorePick = () => { pickShown.value += PICK_PAGE }
const pickerTitle = computed(() => {
  if (!picker.value) return ''
  if (picker.value.kind === 'edit') {
    // 编辑模式已扩展为同时编辑问题/答案/参考切片，统一以「问题配置」命名
    return zh.value ? '问题配置' : 'Question Config'
  }
  return zh.value ? '选择参考切片（该问题答案的来源）' : 'Pick reference slices (answer source)'
})

// 打开：手动添加
const openPickerAdd = () => {
  addPickIds.value = addPickIds.value.filter(id => blocksById.value.has(id))
  pickSel.value = [...addPickIds.value]
  llmRecIds.value = []
  listSrc.value = 'sel'
  slicePreview.value = null
  pickKw.value = ''; pickShown.value = PICK_PAGE; pickMsg.value = ''
  picker.value = { kind: 'add' }
}
// 打开：编辑某问题的答案文本 + 参考切片
const openPickerEdit = (q: KbQuestion) => {
  const ids = (q.answerBlocks || [])
    .map(r => r.blockId)
    .filter((x): x is string => !!x && blocksById.value.has(x))
  pickSel.value = ids
  pickQuestionDraft.value = q.text || ''
  pickAnswerDraft.value = q.extraAnswer || ''
  llmRecIds.value = []
  listSrc.value = 'sel'
  slicePreview.value = null
  pickKw.value = ''; pickShown.value = PICK_PAGE; pickMsg.value = ''
  picker.value = { kind: 'edit', q }
}
const closePicker = () => {
  if (llmRecRunning.value) return
  picker.value = null
  llmRecIds.value = []
  slicePreview.value = null
  pickMsg.value = ''; pickKw.value = ''
}

/** 由已选切片 id 构造切片引用（保序去重） */
const buildRefsFromIds = (ids: string[]) => {
  const seen = new Set<string>()
  const out: { blockId: string; filePath?: string; label?: string }[] = []
  for (const id of ids) {
    const b = blocksById.value.get(id)
    if (!b || seen.has(id)) continue
    seen.add(id)
    out.push({ blockId: id, filePath: b.filePath, label: b.label })
  }
  return out
}

/** 组装用于 LLM 推荐的「问题 + 答案」文本 */
const pickerQueryText = (): string => {
  const ctx = picker.value
  if (!ctx) return ''
  // 编辑模式优先用模态框内草稿（问题/答案文本可能在配置中尚未保存）
  const q = ctx.kind === 'edit' ? (pickQuestionDraft.value.trim() || ctx.q?.text || '') : addText.value.trim()
  const a = ctx.kind === 'edit' ? (pickAnswerDraft.value.trim() || ctx.q?.extraAnswer || answerShort(ctx.q)) : addAnswer.value.trim()
  return `问题：${q}\n参考答案：${a}`.trim()
}

/**
 * 大模型推荐切片：先「问题+答案」向量召回 + 关键词加权取前 10 候选，
 * 再由 LLM 从候选中挑出真正支撑答案的切片（输出序号），并并入当前已选。
 */
const runLlmRecommend = async () => {
  const ctx = picker.value
  if (!ctx || llmRecRunning.value) return
  const blocks = (props.blocks || []).filter((b: any) => b && (b.A || '').trim())
  if (!blocks.length) { pickMsg.value = zh.value ? '知识库暂无切片' : 'No slices in KB'; return }
  const query = pickerQueryText()
  if (!query) { pickMsg.value = zh.value ? '请先输入问题/答案，再让模型推荐切片' : 'Type a question/answer first'; return }
  llmRecRunning.value = true
  pickMsg.value = zh.value ? '正在召回相关切片…' : 'Finding relevant slices…'
  try {
    // 1) 向量召回（切片可能未向量化，失败时退化为关键词打分）
    let qv: number[] | undefined
    try { const em = await kbEmbed(query); qv = em?.[0] } catch { /* 忽略向量失败 */ }
    const kw = query.toLowerCase()
    const tokens = kw.split(/[？?。；;，,、\s\n]+/).filter((t: string) => t.length > 1)
    const scored: { b: any; s: number }[] = []
    for (const b of blocks) {
      let s = 0
      if (qv?.length && b.A_vector?.length) { try { s = cosineSimilarity(qv, b.A_vector) } catch { s = 0 } }
      const body = (b.A || '').toLowerCase()
      const loc = (b.filePath || '').toLowerCase() + ' ' + (b.label || '').toLowerCase()
      const hits = tokens.filter(t => body.includes(t) || loc.includes(t)).length
      if (s > 0.18 || hits > 0) {
        scored.push({ b, s: s + Math.min(0.5, hits * 0.16) })
      }
    }
    scored.sort((x, y) => y.s - x.s)
    const cand = scored.slice(0, 10)
    let chosenIds: string[] = []
    if (!cand.length) {
      pickMsg.value = zh.value ? '未召回到相关切片（切片可能未向量化，可先“补全向量”再试）' : 'No candidate slices (maybe not embedded yet)'
    } else if (cand.length <= 3) {
      chosenIds = cand.map(c => c.b.id)
      pickMsg.value = zh.value ? `候选较少，已直接推荐 ${chosenIds.length} 个切片` : `Recommended ${chosenIds.length} slices`
    } else {
      const listTxt = cand.map((c, i) => `${i + 1}. ${c.b.filePath} / ${c.b.label}\n${qbSnippet(c.b.A, 260)}`).join('\n\n---\n\n')
      const qText = ctx.kind === 'edit' ? (pickQuestionDraft.value.trim() || ctx.q?.text || '') : addText.value.trim()
      const prompt = (zh.value
        ? `你是一名知识库助手。用户的问题是「${qText}」。请从下面候选切片中，选出真正能够作为该问题参考答案依据的切片（0-4 条，越相关越靠前；若无合适切片返回空数组）。只输出 JSON 数组（如 [1,3]），不要任何其它文字。\n\n${listTxt}`
        : `You are a KB assistant. The user's question is "${qText}". From the candidate slices below, pick the ones that genuinely support the reference answer (0-4, most relevant first; empty array if none fits). Reply ONLY a JSON array like [1,3]. No other text.\n\n${listTxt}`)
      let arr: any[] | null = null
      try { arr = extractJsonArray((await kbChat([{ role: 'user', content: prompt }])) || '') } catch { arr = null }
      if (!Array.isArray(arr)) arr = cand.slice(0, 3).map((_, i) => i + 1)
      const nums = new Set<number>()
      for (const v of arr) { const n = Number(v); if (Number.isFinite(n) && n >= 1 && n <= cand.length) nums.add(Math.round(n)) }
      chosenIds = Array.from(nums).sort((a, b) => a - b).map(n => cand[n - 1].b.id)
      pickMsg.value = chosenIds.length
        ? (zh.value ? `已推荐 ${chosenIds.length} 个切片，可在列表中继续增删` : `Recommended ${chosenIds.length} slices; fine-tune below`)
        : (zh.value ? '模型认为候选切片均不够相关，已保留当前选择' : 'Model found no relevant slices, kept current selection')
    }
    // 与搜索一致：把推荐结果作为下方列表的过滤显示源（非全库铺开）
    llmRecIds.value = chosenIds
    listSrc.value = 'rec'
    pickShown.value = PICK_PAGE
    if (chosenIds.length) pickSel.value = [...new Set([...pickSel.value, ...chosenIds])]
  } catch (e) {
    console.error('LLM 推荐切片失败:', e)
    pickMsg.value = zh.value ? '推荐失败：模型调用出错' : 'Recommendation failed'
  } finally {
    llmRecRunning.value = false
  }
}

/** 模态框确定：add → 写入手动添加的待提交选择；edit → 直接保存该问题的答案与参考切片 */
const confirmPicker = async () => {
  const ctx = picker.value
  if (!ctx) return
  const refs = buildRefsFromIds(pickSel.value)
  if (ctx.kind === 'edit') {
    const q = ctx.q
    const qText = pickQuestionDraft.value.trim()
    const ans = pickAnswerDraft.value.trim()
    const patch: any = {
      // 问题文本（清空则保留原文，避免把问题置空）
      ...(qText && qText !== (q.text || '') ? { text: qText } : {}),
      // 答案文本留空 → 移除外部答案（此时答案退化为所选切片内容）；非空则作为外部参考答案
      extraAnswer: ans || undefined,
    }
    // 仅当知识库存在切片时才允许改参考切片（无切片时保留原 answerBlocks，避免误清空）
    if (hasSlices.value) {
      patch.answerBlocks = refs as QuestionAnswerRef[]
      // 手动问题原无主切片：补为首个参考切片（让答案与切片形成关联，参与问题增强索引）
      if (!q.srcBlockId && refs.length) {
        patch.srcBlockId = refs[0].blockId
        patch.srcFilePath = refs[0].filePath
        patch.srcLabel = refs[0].label
      } else if (!refs.length) {
        // 全部参考切片被移除：同步清除主来源切片，避免问题仍挂靠在不再引用的切片上
        patch.srcBlockId = undefined
        patch.srcFilePath = undefined
        patch.srcLabel = undefined
      }
    }
    try {
      await props.onUpdateQuestion?.(q.id, patch)
      reviewMap.value.delete(q.id)
      picker.value = null
      emit('updateState', zh.value ? '问题配置已保存' : 'Question config saved')
    } catch (e: any) {
      console.error('更新答案失败:', e)
      emit('updateState', zh.value ? '更新失败' : 'Update failed')
    }
  } else {
    addPickIds.value = [...pickSel.value]
    picker.value = null
    emit('updateState', addPickIds.value.length
      ? (zh.value ? `已选 ${addPickIds.value.length} 个参考切片，点击 ✔ 完成添加` : `${addPickIds.value.length} slices picked, click ✔ to add`)
      : (zh.value ? '未选切片' : 'No slices picked'))
  }
}

// ---------------- 独立性评审（LLM 判定「问题+答案」能否独立推导 / 由用户解出；仅会话内标记，不写入库） ----------------
const REVIEW_BATCH = 8
const reviewRunning = ref(false)
const reviewMap = ref<Map<string, { bad: boolean; reason?: string; ts: number }>>(new Map())
const badQuestions = computed(() => activeQuestions.value.filter(q => reviewMap.value.get(q.id)?.bad))
const reviewBad = (q: KbQuestion) => !!reviewMap.value.get(q.id)?.bad
const reviewReason = (q: KbQuestion) => reviewMap.value.get(q.id)?.reason || ''
const clearReview = () => { reviewMap.value.clear() }
const dismissReview = (id: string) => { reviewMap.value.delete(id) }
// 批量删除所有被标记为「不合适」的问题（先确认避免误删；删除后同步清理对应评审标记与状态栏计数）
const deleteAllBad = async () => {
  const qs = badQuestions.value
  if (!qs.length) return
  try {
    await ElMessageBox.confirm(
      zh.value
        ? `确定删除全部 ${qs.length} 条被标记为「不合适」的问题？删除后不可恢复。`
        : `Delete all ${qs.length} flagged unsuitable questions? This cannot be undone.`,
      zh.value ? '批量删除不合适问题' : 'Delete unsuitable questions',
      {
        type: 'warning',
        confirmButtonText: zh.value ? '删除' : 'Delete',
        cancelButtonText: zh.value ? '取消' : 'Cancel',
      },
    )
  } catch { return }
  const ids = qs.map(q => q.id)
  for (const id of ids) {
    props.onRemoveQuestion?.(id)
    reviewMap.value.delete(id)
  }
  emit('updateState', zh.value ? `已删除 ${qs.length} 条不合适的问题` : `Deleted ${qs.length} unsuitable questions`)
}
// 不合适计数变化 → 同步到底部状态栏常驻项；组件销毁时清零并复位评审状态（评审标记本就不持久化）
watch(() => badQuestions.value.length, (n) => emit('updateReviewBad', n))
onBeforeUnmount(() => {
  emit('updateReviewBad', 0)
  emit('updateReviewRunning', false)
  emit('updateReviewStatus', '')
})

const answerShort = (q: KbQuestion) => {
  const a = (resolveAnswer(q) || '').trim()
  if (!a) return zh.value ? '（无）' : '(none)'
  return a.length > 240 ? a.slice(0, 240) + '…' : a
}

const extractJsonArray = (raw: string): any[] | null => {
  if (!raw) return null
  const a = raw.indexOf('[')
  const b = raw.lastIndexOf(']')
  if (a < 0 || b <= a) return null
  try { const v = JSON.parse(raw.slice(a, b + 1)); return Array.isArray(v) ? v : null } catch { return null }
}

/** 评审一批：模型判定 ok/bad 并给原因；结论只写入 reviewMap（不落盘） */
const reviewChunk = async (qs: KbQuestion[]) => {
  const lines = qs.map((q, i) => `${i + 1}. ${zh.value ? '问题' : 'Q'}: ${q.text}\n   ${zh.value ? '答案' : 'A'}: ${answerShort(q)}`).join('\n')
  const prompt = (zh.value
    ? `你是一名知识库评测助手。下面给出一批「问题-参考答案」对（编号 1..${qs.length}）。请逐条独立评审该问答对是否「合格」：
合格(ok=true)：问题自包含、表述清晰，用户仅凭问题本身即可独立理解并作答（不依赖源文档或前文）；参考答案直接、完整地回应了问题，且内容独立自洽（不含“见上文/根据材料/如上所述/该方法”这类依赖源文的表述，也不含无法由问题推出的假设）。
不合格(ok=false)：存在任一情况——问题需依赖未提供的上下文才能理解或作答；问题空泛、含糊、无法独立作答；无参考答案；答案答非所问或明显不完整；答案只有依赖源切片/前文才能成立。
只输出 JSON 数组，每条形如 {"i":序号,"ok":true或false,"reason":"仅当 ok=false 时给出 ≤30 字中文原因"}，不要任何其它文字。\n\n${lines}`
    : `You are a KB evaluation assistant. Below are numbered "question-reference answer" pairs (1..${qs.length}). Judge EACH pair as PASS or FAIL:
PASS(ok=true): the question is self-contained, clear, and a user can understand and answer it from the question alone (no source doc / prior context); the reference answer directly and completely answers it and is self-contained (no source-anchored phrasing like "as above/according to the text/the method", no assumptions not implied by the question).
FAIL(ok=false): any of — the question needs unprovided context to be understood or answered; the question is vague and not independently answerable; no answer; the answer does not answer or is clearly incomplete; the answer only holds with the source slice / prior context.
Reply with ONLY a JSON array like [{"i":index,"ok":true|false,"reason":"short reason only when ok=false"}]. No other text.\n\n${lines}`)
  let out = (await kbChat([{ role: 'user', content: prompt }])) || ''
  let arr = extractJsonArray(out)
  if (!arr) {
    out = (await kbChat([
      { role: 'user', content: prompt },
      { role: 'assistant', content: out },
      { role: 'user', content: zh.value ? '请只输出严格的 JSON 数组，不要任何其它文字。' : 'Output ONLY the strict JSON array, nothing else.' },
    ])) || ''
    arr = extractJsonArray(out)
  }
  if (!arr) throw new Error('评审输出解析失败')
  const byIdx = new Map<number, any>()
  for (const it of arr) { if (it && typeof it === 'object') byIdx.set(Number(it.i), it) }
  const now = Date.now()
  qs.forEach((q, i) => {
    const it = byIdx.get(i + 1)
    const bad = !!it && it.ok === false
    reviewMap.value.set(q.id, { bad, reason: bad && it.reason ? String(it.reason).trim().slice(0, 80) : '', ts: now })
  })
}

/** 全库独立性评审：分批调 LLM；进度/结果作为底部状态栏常驻项持续显示更新（不走 kb_state 的 6s 清除），只作会话内标记（不落盘 / 不写 .kb） */
const runReview = async () => {
  if (reviewRunning.value) return
  const qs = activeQuestions.value
  if (!qs.length) { emit('updateState', zh.value ? '暂无问题可评审' : 'No questions to review'); return }
  reviewMap.value.clear()
  reviewRunning.value = true
  emit('updateReviewRunning', true)
  let failed = 0
  try {
    const total = qs.length
    const setStatus = (s: string) => emit('updateReviewStatus', s)
    setStatus(zh.value ? `独立性评审：0/${total}` : `Independence review: 0/${total}`)
    for (let s = 0; s < total; s += REVIEW_BATCH) {
      const chunk = qs.slice(s, s + REVIEW_BATCH)
      const done = Math.min(s + chunk.length, total)
      try {
        await reviewChunk(chunk)
        setStatus(zh.value ? `独立性评审：${done}/${total}，不合适 ${badQuestions.value.length}` : `Independence review: ${done}/${total}, unsuitable ${badQuestions.value.length}`)
      } catch (e) {
        failed++
        console.error('独立性评审批次失败:', e)
        for (const q of chunk) reviewMap.value.delete(q.id)
        setStatus(zh.value ? `独立性评审：${done}/${total}（本批失败已跳过）` : `Independence review: ${done}/${total} (batch skipped)`)
      }
    }
    setStatus(zh.value
      ? `独立性评审完成${failed ? `（跳过 ${failed} 批失败）` : ''}`
      : `Independence review done${failed ? ` (${failed} batch(es) skipped)` : ''}`)
  } finally {
    reviewRunning.value = false
    emit('updateReviewRunning', false)
  }
}

// ---------------- 批量整理 + 审核（重复分组，只判组不改库；逐组由用户决定） ----------------
const threshold = computed(() => Number(props.model?.questionDedupThreshold) || 0.85)
const sliceEvidence = computed(() => !!props.model?.questionSliceEvidence)
const groups = ref<DupGroup[]>([])
const showDup = ref(false)
const runDetect = () => {
  groups.value = detectDuplicateGroups(activeQuestions.value, {
    threshold: threshold.value,
    cosineSimilarity,
    sliceEvidence: sliceEvidence.value,
  })
  showDup.value = true
  emit('updateState', zh.value
    ? `疑似重复 ${groups.value.length} 组（阈值 ${(threshold.value * 100).toFixed(0)}%）`
    : `${groups.value.length} potential duplicate groups (threshold ${(threshold.value * 100).toFixed(0)}%)`)
}

/** 把组内除 keepIdx 外的成员全部并入 keepIdx（答案块合并；其余成员移除） */
const mergeGroup = async (gi: number, keepIdx: number, mergeTextWithLlm = false) => {
  const group = groups.value[gi]
  if (!group) return
  const keep = group.members[keepIdx]
  let finalText = keep.text
  // 可选：LLM 综合更完整的问题文本
  if (mergeTextWithLlm) {
    const prompt = (zh.value
      ? `你是一名知识库评测助手。下面几个问题语义相似（可能考察同一知识点）。请把它们综合成【一条】更完整、更规范的问题，涵盖所有考察角度。要求：只输出合并后的问题本身，不要任何编号、标题、引号、解释或换行；若角度差异过大无法合并，则原样返回第 1 条。\n`
      : `You are a KB evaluation assistant. The questions below are semantically similar. Combine them into ONE more complete and well-formed question covering all aspects. Output ONLY the merged question itself, no numbering, headings, quotes, explanation or newlines; if too different, return question 1 verbatim.\n`) +
      group.members.map((m, i) => `Q${i + 1}: ${m.text}`).join('\n')
    try {
      const out0 = await kbChat([{ role: 'user', content: prompt }])
      let out = (out0 || '').trim().replace(/^["“”‘’]+|["“”‘’]+$/g, '').replace(/\s*\n+\s*/g, ' ').replace(/^(问题[:：]|Question[:：])\s*/i, '')
      if (out) finalText = out
    } catch { /* 失败保留原文 */ }
  }
  const seen = new Set<string>()
  const refs: any[] = []
  for (const r of keep.answerBlocks || []) { const k = r.blockId || `${r.filePath}#${r.label}`; if (!seen.has(k)) { seen.add(k); refs.push(r) } }
  for (let j = 0; j < group.members.length; j++) {
    if (j === keepIdx) continue
    const d = group.members[j]
    for (const r of d.answerBlocks || []) { const k = r.blockId || `${r.filePath}#${r.label}`; if (!seen.has(k)) { seen.add(k); refs.push(r) } }
  }
  await props.onUpdateQuestion?.(keep.id, { text: finalText, answerBlocks: refs as any })
  // 合并后内容已变，清掉相关问题的评审标记
  for (const m of group.members) reviewMap.value.delete(m.id)
  for (let j = 0; j < group.members.length; j++) {
    if (j === keepIdx) continue
    props.onRemoveQuestion?.(group.members[j].id)
  }
  groups.value.splice(gi, 1)
  emit('updateState', zh.value ? `已合并 1 组，剩余疑似 ${groups.value.length} 组` : `Merged 1 group, ${groups.value.length} left`)
}
const keepAll = (gi: number) => { groups.value.splice(gi, 1) }

// ---------------- 补全缺失向量 ----------------
const embedMissing = async () => {
  const n = await props.onEmbedMissing?.((m) => emit('updateLiveState', m))
  if (n !== undefined) emit('updateState', zh.value ? `已补全 ${n} 条问题向量` : `Embedded ${n} question vectors`)
}

// ---------------- Excel 导入 / 导出（含对应切片） ----------------
/** 把导出的切片引用解析回当前知识库切片（优先 contentHash → blockId → filePath+label → filePath） */
const resolveSliceRef = (r: any): any | null => {
  const bs = props.blocks || []
  if (!r || typeof r !== 'object') return null
  if (r.hash) { const b = bs.find((x: any) => x.contentHash && x.contentHash === r.hash); if (b) return b }
  if (r.blockId) { const b = bs.find((x: any) => x.id === r.blockId); if (b) return b }
  if (r.filePath) {
    const norm = (p: any) => String(p || '').replace(/\\/g, '/')
    const sameFile = bs.filter((x: any) => norm(x.filePath) === norm(r.filePath))
    if (r.label != null) {
      const exact = sameFile.filter((x: any) => String(x.label || '') === String(r.label || ''))
      if (exact.length === 1) return exact[0]
    }
    if (sameFile.length === 1) return sameFile[0]
  }
  return null
}
const doImport = () => {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.xlsx,.xls,.csv'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    try {
      const data = await file.arrayBuffer()
      const wb = XLSX.read(data, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 })
      const imported: KbQuestion[] = []
      const now = Date.now()
      let cnt = 0
      // 表头行识别（新/旧模板均含「问题」「参考答案/答案」等表头）
      const isHeader = (row: any[], idx: number) => {
        if (idx !== 0) return false
        const c0 = String(row?.[0] || '').trim().toLowerCase()
        const c1 = String(row?.[1] || '').trim().toLowerCase()
        return c0 === '问题' || c0 === 'question' || /^(参考答案|答案|answer)/.test(c1)
      }
      for (let ri = 0; ri < (rows || []).length; ri++) {
        const row = rows[ri] || []
        if (isHeader(row, ri)) continue
        const q = String(row?.[0] || '').trim()
        if (!q) continue
        const a = String(row?.[1] || '').trim()
        // 第 3 列：对应切片（JSON：含 blockId/filePath/label/hash）
        let refs: any[] = []
        const rawRefs = row.length >= 3 && row[2] != null ? String(row[2]).trim() : ''
        if (rawRefs && rawRefs.startsWith('[')) {
          try { const p = JSON.parse(rawRefs); if (Array.isArray(p)) refs = p } catch { refs = [] }
        }
        const resolvedRefs = refs
          .filter((r: any) => r && typeof r === 'object')
          .map((r: any) => {
            const hit = resolveSliceRef(r)
            return hit
              ? { blockId: hit.id, filePath: hit.filePath, label: hit.label }
              : { blockId: '', filePath: r.filePath || '', label: r.label || '' }
          })
          .filter((r: any) => r.filePath || r.blockId)
        // 答案文本语义：有切片且能定位到切片 → 答案文本仅当与切片内容不一致时才作为外部答案保留（保证往返一致）；
        // 无切片（旧版两列 / 切片在当前库不存在）→ 整段答案作为外部参考答案
        let extraAnswer: string | undefined
        if (resolvedRefs.length) {
          const derived = answerText({ answerBlocks: resolvedRefs as any } as any, props.blocks, ' | ')
          if (a && a !== derived) extraAnswer = a
        } else if (a) extraAnswer = a
        imported.push({
          id: `imp_${now}_${cnt}`,
          text: q,
          qVector: undefined,
          srcBlockId: resolvedRefs[0]?.blockId || undefined,
          srcFilePath: resolvedRefs[0]?.filePath || undefined,
          srcLabel: resolvedRefs[0]?.label || undefined,
          answerBlocks: resolvedRefs as QuestionAnswerRef[],
          extraAnswer,
          origin: 'imported',
          status: 'kept',
          createdAt: now + cnt,
        })
        cnt++
      }
      if (cnt === 0) { emit('updateState', zh.value ? '未读取到有效问题' : 'No valid questions found'); return }
      props.onApplyQuestionBank?.([...(props.questionBank || []), ...imported])
      await props.onEmbedMissing?.()
      emit('updateState', zh.value ? `成功导入 ${cnt} 个问题（含切片关联）` : `Imported ${cnt} questions (with slices)`)
    } catch (e: any) {
      console.error('导入失败:', e)
      emit('updateState', zh.value ? '导入失败' : 'Import failed')
    }
  }
  input.click()
}
const exportTemplate = () => {
  // 三列：问题 / 参考答案（可读文本；外部答案或切片内容聚合）/ 对应切片（JSON，含 hash 便于跨库定位）
  const rows: any[][] = [['问题', '参考答案', '对应切片']]
  for (const q of activeQuestions.value) {
    const slicePayload = (q.answerBlocks || []).map(r => {
      const b = blocksById.value.get(r.blockId)
      return {
        blockId: r.blockId || b?.id || '',
        filePath: r.filePath || b?.filePath || '',
        label: r.label || b?.label || '',
        hash: b?.contentHash || '',
      }
    })
    rows.push([q.text, resolveAnswer(q), slicePayload.length ? JSON.stringify(slicePayload) : ''])
  }
  const ws = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '问题库')
  XLSX.writeFile(wb, `question_bank_${new Date().toISOString().slice(0, 10)}.xlsx`)
  emit('updateState', zh.value ? '问题模板导出成功（含答案与切片）' : 'Question template exported (with answers & slices)')
}

// ---------------- 复合问题生成（需综合多切片；参考答案 = 多切片内容） ----------------
const complexCount = ref(5)
const complexRunning = ref(false)
const generateComplex = async () => {
  const blocks = (props.blocks || []).filter((b: any) => b.A && b.A.trim())
  if (blocks.length < 2) { emit('updateState', zh.value ? '切片不足（≥2），无法生成复合问题' : 'Need ≥2 slices'); return }
  const MAX_GEN = Math.max(1, Math.min(20, Number(complexCount.value) || 5))
  // 语义相关配对：A_vector 余弦落在 [0.35, 0.8]，优先跨文件
  const pairs: any[][] = []
  const byPath = new Map<string, any[]>()
  for (const b of blocks) { if (!byPath.has(b.filePath)) byPath.set(b.filePath, []); byPath.get(b.filePath)!.push(b) }
  const seenPair = new Set<string>()
  for (let t = 0; t < 30 && pairs.length < MAX_GEN; t++) {
    const i = Math.floor(Math.random() * blocks.length)
    let bestJ = -1, bestSim = -1
    for (let j = 0; j < blocks.length; j++) {
      if (j === i) continue
      const a = blocks[i].A_vector, b2 = blocks[j].A_vector
      let sim = 0
      if (a?.length && b2?.length) { try { sim = cosineSimilarity(a, b2) } catch { sim = 0 } }
      if (sim >= 0.35 && sim <= 0.8 && sim > bestSim) { bestSim = sim; bestJ = j }
    }
    if (bestJ >= 0) {
      const key = [i, bestJ].sort().join('_')
      if (!seenPair.has(key)) { seenPair.add(key); pairs.push([blocks[i], blocks[bestJ]]) }
    } else if (byPath.size >= 2) {
      // 跨文件兜底
      const p = Array.from(byPath.values()).filter(x => x.length)
      const gi = Math.floor(Math.random() * p.length)
      const gj = Math.floor(Math.random() * p.length)
      if (gi !== gj && p[gi]?.length && p[gj]?.length) {
        const bi = p[gi][0], bj = p[gj][0]
        const key = [blocks.indexOf(bi), blocks.indexOf(bj)].sort().join('_')
        if (!seenPair.has(key)) { seenPair.add(key); pairs.push([bi, bj]) }
      }
    }
  }
  if (!pairs.length) { emit('updateState', zh.value ? '未找到可配对的切片' : 'No slice pairs available'); return }
  complexRunning.value = true
  const added: KbQuestion[] = []
  for (let gi = 0; gi < pairs.length; gi++) {
    const [b1, b2] = pairs[gi]
    const labeled = `[切片 A]: ${b1.A}\n\n[切片 B]: ${b2.A}`
    const prompt = (zh.value
      ? `你是一名知识库评测助手。下面是知识库中【互不连续】的若干资料片段。请提出 1-2 个【必须综合这些片段联合信息才能得出结论】的复杂问题（如跨主题对比、多步骤因果、需拼接多片段信息）。要求：单凭一个片段无法回答；只输出问题本身，每行一个，不要编号/标题/解释或前后缀。\n\n片段：\n`
      : `You are a KB evaluation assistant. Below are several NON-CONTIGUOUS snippets. Raise 1-2 complex questions that REQUIRE combining these snippets to conclude (e.g., comparison, causality, info synthesis). A single snippet must NOT be sufficient. Output ONLY the questions, one per line, no numbering/headings/explanation.\n\nSnippets:\n`) + labeled
    let text = ''
    try {
      text = (await kbChat([{ role: 'user', content: prompt }])) || ''
    } catch (e) { console.error('生成复合问题失败:', e) }
    const texts = splitQuestionText(text || '')
    for (const t of texts.slice(0, 2)) {
      added.push({
        id: `cx_${Date.now()}_${added.length}`,
        text: t,
        qVector: undefined,
        srcBlockId: b1.id,
        srcFilePath: b1.filePath,
        srcLabel: b1.label,
        answerBlocks: [
          { blockId: b1.id, filePath: b1.filePath, label: b1.label },
          { blockId: b2.id, filePath: b2.filePath, label: b2.label },
        ],
        origin: 'complex',
        status: 'kept',
        createdAt: Date.now(),
      })
    }
    emit('updateLiveState', zh.value ? `生成复合问题 ${gi + 1}/${pairs.length}` : `Generating ${gi + 1}/${pairs.length}`)
  }
  if (added.length) {
    props.onApplyQuestionBank?.([...(props.questionBank || []), ...added])
    await props.onEmbedMissing?.()
  }
  complexRunning.value = false
  emit('updateState', zh.value ? `已生成 ${added.length} 条复合问题` : `Generated ${added.length} complex questions`)
}
</script>

<template>
  <div class="qb-root">
    <!-- ========== 顶部工具栏（单行；图标按钮，名称用 title；样式与切片/本体等统一 kt-*） ========== -->
    <div class="kt-toolbar">
      <div class="kt-search">
        <i class="fa fa-search"></i>
        <input v-model="keyword" class="kt-search-input" :placeholder="zh ? '搜索问题/答案/来源...' : 'Search...'" />
      </div>
      <!-- 分区一：问题推理（由切片页迁入；仅运行/暂停时显示控制） -->
      <template v-if="extractProgress && (extractProgress.isRunning || extractProgress.isPaused)">
        <template v-if="extractProgress.isRunning && !extractProgress.isPaused">
          <div class="kt-btn" :title="zh ? '暂停提取' : 'Pause'" @click="onPauseExtract && onPauseExtract()"><i class="fa fa-pause"></i></div>
          <div class="kt-btn" :title="zh ? '停止提取' : 'Stop'" @click="onStopExtract && onStopExtract()"><i class="fa fa-stop"></i></div>
        </template>
        <template v-else>
          <div class="kt-btn resume" :title="zh ? '继续提取' : 'Resume'" @click="onContinueExtract && onContinueExtract()"><i class="fa fa-play"></i></div>
          <div class="kt-btn" :title="zh ? '停止提取' : 'Stop'" @click="onStopExtract && onStopExtract()"><i class="fa fa-stop"></i></div>
        </template>
      </template>
      <template v-else>
        <div class="kt-btn" :title="zh ? '对未推理切片提取问题（推理结果进入问题库）' : 'Extract questions from unreasoned slices'"
          @click="onStartExtract && onStartExtract()"><i class="fa fa-play"></i></div>
      </template>

      <div class="kt-btn" :class="{ warn: complexRunning }" :title="zh ? '生成需综合多切片的复合问题' : 'Generate complex questions'" @click="generateComplex">
        <i class="fa fa-cubes" :class="{ 'fa-spin': complexRunning }"></i>
      </div>
      
      <div class="kt-btn" :title="zh ? '手动添加问题' : 'Add question'" @click="showAdd = !showAdd"><i class="fa fa-plus"></i></div>
      
      <input type="number" v-model.number="complexCount" min="1" max="20" class="kt-num" @click.stop :title="zh ? '复合问题组数 (1-20)' : 'Complex question count (1-20)'" />
      <span class="kt-sep"></span>
      <div class="kt-btn" :title="zh ? '为缺失向量的问题补全向量' : 'Embed missing vectors'" @click="embedMissing"><i class="fa fa-magnet"></i></div>

      <!-- 分区三：整理与审核 -->
      <div class="kt-btn" :title="zh ? '语义去重：检测疑似重复组（阈值 ' + (threshold*100).toFixed(0) + '%），逐组审核后合并' : 'Dedup: detect potential duplicate groups'" @click="runDetect"><i class="fa fa-compress"></i></div>
      <!-- 独立性评审：LLM 判定「问题+答案」能否独立推导/由用户解出；不合适项仅在会话内标记，不写入库 -->
      <div class="kt-btn" :class="{ warn: reviewRunning }" :title="zh ? '独立性评审：由大模型评审问题与答案能否独立推导或由用户解出，不合适的问题会被标记；进度与不合适数量显示在底部状态栏（仅当前会话，不保存）' : 'Independence review: LLM judges whether each Q&A is independently derivable / solvable by users; unsuitable ones are flagged; progress & count show in the bottom status bar (session-only, not saved)'" @click="runReview">
        <i class="fa fa-balance-scale" :class="{ 'fa-spin': reviewRunning }"></i>
      </div>
      <!-- 评审完成后：批量删除所有「不合适」的问题（位于评审按钮之后，仅存在被标记项时显示） -->
      <div v-if="badQuestions.length && !reviewRunning" class="kt-btn qb-del-batch" :title="zh ? `删除全部 ${badQuestions.length} 条被标记为「不合适」的问题` : `Delete all ${badQuestions.length} flagged unsuitable questions`" @click="deleteAllBad">
        <i class="fa fa-trash-o"></i>
        <span class="qb-del-batch-num">{{ badQuestions.length }}</span>
      </div>
      <span v-if="reviewMap.size && !reviewRunning" class="kt-label ok" :title="zh ? '清除独立性评审标记（仅当前会话）' : 'Clear review marks (session only)'" @click="clearReview"><i class="fa fa-eraser"></i></span>
      <span v-if="mergedQuestions.length" class="kt-label">{{ zh ? '已合并' : 'merged' }}{{ mergedQuestions.length }}</span>

      <span class="kt-sep"></span>

      <!-- 分区四：导入导出 / 测试用例 / 复合生成 -->
      <div class="kt-btn" :title="zh ? '从 Excel 导入问题与参考答案' : 'Import from Excel'" @click="doImport"><i class="fa fa-upload"></i></div>
      <div class="kt-btn" :title="zh ? '导出问题与参考答案模板 (Excel)' : 'Export template (Excel)'" @click="exportTemplate"><i class="fa fa-download"></i></div>

      <span class="kt-spacer"></span>

      <!-- 计数 / 搜索 / 筛选（并入同一行工具栏） -->
      <span class="kt-label ok" :title="zh ? `已向量化 ${embeddedCount} / 共 ${activeQuestions.length} 个有效问题` : `${embeddedCount} embedded / ${activeQuestions.length} active questions`"><i class="fa fa-magnet"></i> {{ embeddedCount }}/{{ activeQuestions.length }}</span>
      <span class="kt-label" :title="zh ? `问题库共关联 ${bankSlices} 个去重来源切片` : `${bankSlices} unique source slices referenced by the bank`"><i class="fa fa-file-text-o"></i> {{ bankSlices }}</span>
      <select v-model="filterMode" class="kt-select qb-filter">
        <option value="all">{{ zh ? '全部' : 'All' }}</option>
        <option value="nov">{{ zh ? '无向量' : 'No vector' }}</option>
        <option value="noans">{{ zh ? '无答案' : 'No answer' }}</option>
        <option value="bad">{{ zh ? '不合适' : 'Unsuitable' }}</option>
      </select>
    </div>

    <!-- ========== 手动添加行 ========== -->
    <div v-if="showAdd" class="kt-toolbar">
      <input v-model="addText" :placeholder="zh ? '问题文本（必填）' : 'Question text (required)'" class="kt-input qb-add-text" @keyup.enter="submitAdd" />
      <input v-model="addAnswer" :placeholder="zh ? '参考答案（可选；可含 | 多段）' : 'Reference answer (optional)'" class="kt-input qb-add-answer" @keyup.enter="submitAdd" />
      <!-- 指定参考切片（答案来源）：仅当知识库已加载切片时才显示该按钮 -->
      <div v-if="hasSlices" class="kt-btn" :class="{ on: addPickIds.length }"
        :title="zh ? '指定该问题的参考切片（答案来源）：弹出模态框搜索，或由大模型推荐' : 'Attach reference slices (answer source): search in modal or let the LLM recommend'"
        @click="openPickerAdd">
        <i class="fa fa-paperclip"></i>
      </div>
      <span class="kt-spacer"></span>
      <div class="kt-btn ok" :title="zh ? '添加问题' : 'Add question'" @click="submitAdd"><i class="fa fa-check"></i></div>
      <div class="kt-btn" :title="zh ? '取消' : 'Cancel'" @click="cancelAdd"><i class="fa fa-times"></i></div>
    </div>
    <!-- 手动添加已选切片 chips（数量在标题处显示） -->
    <div v-if="showAdd && addPickBlocks.length" class="qb-add-picks">
      <span class="qb-picks-cap"><i class="fa fa-paperclip"></i> {{ zh ? `参考切片（${addPickBlocks.length}）：` : `slices (${addPickBlocks.length}): ` }}</span>
      <span v-for="b in addPickBlocks" :key="b.id" class="qb-chip">
        <i class="fa fa-file-text-o"></i> {{ sliceFileOf(b) }}
        <i class="fa fa-times qb-chip-x" :title="zh ? '移除' : 'remove'" @click="removeAddSlice(b.id)"></i>
      </span>
      <span class="qb-flex"></span>
    </div>

    <!-- ========== 重复检测审核面板 ========== -->
    <div v-if="showDup" class="qb-dup-panel">
      <div class="qb-dup-head">
        <i class="fa fa-compress qb-dup-ico"></i>
        <span class="qb-dup-title">{{ zh ? '疑似重复组' : 'Potential duplicates' }}（{{ groups.length }}）· {{ zh ? '阈值' : 'threshold' }} {{ (threshold*100).toFixed(0) }}%</span>
        <span class="qb-flex"></span>
        <span v-if="!groups.length" class="qb-dup-clean">{{ zh ? '无重复 🎉' : 'No duplicates 🎉' }}</span>
        <div class="kt-btn" :title="zh ? '关闭审核面板' : 'Close'" @click="showDup = false"><i class="fa fa-times"></i></div>
      </div>
      <div v-if="groups.length" class="qb-dup-list">
        <div v-for="(g, gi) in groups" :key="gi" class="qb-dup-group">
          <div class="qb-dup-group-cap">{{ zh ? '组' : 'Group' }} {{ gi + 1 }} · {{ g.members.length }} {{ zh ? '条' : 'items' }} · {{ zh ? '保留其中 1 条（其余并入答案）' : 'keep one, merge others into its answer' }}</div>
          <div v-for="(m, mi) in g.members" :key="m.id" class="qb-dup-member">
            <input type="radio" :name="'qg'+gi" :checked="mi===0" class="qb-dup-radio" @change="(e)=>{ if((e.target as any).checked) mergeGroup(gi, mi) }" />
            <div class="qb-dup-member-main">
              <div><b>{{ mi + 1 }}</b>. {{ m.text }}</div>
              <div class="qb-dup-member-meta">{{ originLabel(m.origin) }} · {{ blockFileOf(m) }} · <i class="fa fa-file-text-o"></i> {{ m.answerBlocks?.length || 0 }}</div>
            </div>
          </div>
          <div class="qb-dup-actions">
            <div class="kt-btn" :title="zh ? '用 LLM 合并为一条更完整的问题' : 'Merge into one (LLM)'" @click="mergeGroup(gi, 0, true)"><i class="fa fa-magic"></i></div>
            <div class="kt-btn ok" :title="zh ? '全部保留（不合并）' : 'Keep all (no merge)'" @click="keepAll(gi)"><i class="fa fa-check"></i></div>
          </div>
        </div>
      </div>
    </div>

    <!-- ========== 问题列表（滚动分批加载） ========== -->
    <div ref="qListEl" class="qb-scroll qb-list" @scroll="handleQListScroll">
      <div v-if="!filtered.length" class="qb-empty">
        <i :class="activeQuestions.length ? 'fa fa-search' : 'fa fa-question-circle-o'"></i>
        <div v-if="activeQuestions.length === 0">{{ zh ? '暂无问题：先在「切片」页推理问题，或点击上方「提取问题」' : 'No questions yet: reason slices first or click "Extract"' }}</div>
        <div v-else>{{ zh ? '没有匹配的问题' : 'No matching questions' }}</div>
      </div>
      <div v-for="(q, qi) in displayedQ" :key="q.id" class="qb-item" :class="{ 'qb-item-bad': reviewBad(q) }">
        <div class="qb-item-inner">
          <span class="qb-idx">{{ qi + 1 }}</span>
          <div class="qb-main">
            <!-- 展示态：问题文本在左，qb-meta 全部要素（标签/来源/状态/操作）在同一行右侧，更紧凑 -->
            <div class="qb-line">
                <div class="qb-text" :title="fileTitle(q) || undefined">
                  <span v-if="q.status === 'merged'" class="qb-text-merged">{{ q.text }}</span>
                  <span v-else>{{ q.text }}</span>
                </div>
                <div class="qb-meta">
                  <span v-if="reviewMap.get(q.id)" class="qb-tag" :class="reviewBad(q) ? 'qb-tag-bad' : 'qb-tag-ok'" :title="reviewBad(q) ? (zh ? '不合适：' + reviewReason(q) + '（点击忽略，不再标为不合适）' : 'Unsuitable: ' + reviewReason(q) + ' (click to ignore)') : ''" @click="reviewBad(q) && dismissReview(q.id)">{{ reviewBad(q) ? (zh ? '不合适' : 'bad') : '✔' }}</span>
                  <span v-if="q.origin" class="qb-tag" :class="q.origin === 'reasoned' ? 'qb-tag-r' : q.origin === 'complex' ? 'qb-tag-c' : ''" :title="zh ? '问题来源' : 'origin'">{{ originLabel(q.origin) }}</span>
                  <span v-if="q.srcBlockId" class="qb-meta-item" :title="zh ? '来源切片' : 'source slice'"><i class="fa fa-tag"></i> {{ q.srcBlockId }}</span>
                  <span class="qb-meta-item" :title="zh ? '参考切片数' : 'reference slices'"><i class="fa fa-gavel"></i> {{ q.answerBlocks?.length || 0 }}</span>
                  <span class="qb-meta-item qb-vec" :class="(q.qVector && q.qVector.length) ? 'ok' : 'warn'"
                    :title="(q.qVector && q.qVector.length) ? (zh ? '已向量化（' + q.qVector.length + 'd），点击重新向量化' : 'embedded (' + q.qVector.length + 'd), click to re-embed') : (zh ? '未向量化，参与检索前需补全' : 'no vector yet')"
                    @click.stop="(q.qVector && q.qVector.length) && reVectorize(q)">
                    <i class="fa" :class="(q.qVector && q.qVector.length) ? 'fa-check-circle' : 'fa-exclamation-circle'"></i>
                  </span>
                  <span class="qb-ops">
                    <!-- 问题配置：编辑问题文本 + 参考答案 + 参考切片（原「编辑问题文本」入口已并入此模态框） -->
                    <span class="qb-link" :class="{ on: hasSlices && (q.answerBlocks?.length || q.extraAnswer) }" :title="zh ? '问题配置：编辑问题文本、参考答案与参考切片（可搜索或由大模型推荐切片）' : 'Question config: edit question text, answer and reference slices (search or let LLM recommend)'" @click.stop="openPickerEdit(q)"><i class="fa fa-cog"></i></span>
                    <!-- 已向量化时点击绿色“已向量化”图标即可重新向量化，不再重复显示磁铁图标 -->
                    <span v-if="!(q.qVector && q.qVector.length)" class="qb-link" @click.stop="reVectorize(q)" :title="zh ? '向量化（补全缺失向量）' : 'Embed (fill missing vector)'"><i class="fa fa-magnet"></i></span>
                    <span class="qb-link qb-del" @click.stop="removeQ(q)" :title="zh ? '删除' : 'Delete'"><i class="fa fa-trash-o"></i></span>
                  </span>
                </div>
            </div>
            <!-- 问题答案（提取/手动生成，独立于参考切片；点右侧 ⚙ 打开“问题配置”一并编辑） -->
            <div v-if="q.extraAnswer" class="qb-answer" :title="zh ? '该问题的答案（与问题分开存储；点右侧 ⚙ 打开“问题配置”可一并编辑）' : 'Answer (stored separately from question text)'">
              <i class="fa fa-check-circle-o"></i> {{ q.extraAnswer }}
            </div>
          </div>
        </div>
      </div>
      <div v-if="hasMoreQ" class="qb-loadmore">
        <i class="fa fa-angle-double-down"></i> {{ zh ? '下滑加载更多' : 'scroll for more' }} <span class="qb-loadmore-num">{{ displayedQ.length }}/{{ filtered.length }}</span>
      </div>
    </div>

    <!-- ========== 参考切片选择模态框（手动输入答案时指定切片：搜索 / 大模型推荐） ========== -->
    <div v-if="pickOpen" class="qb-pick-overlay" @mousedown.self="closePicker">
      <div class="qb-pick-dialog">
        <div class="qb-pick-head">
          <i class="fa" :class="picker && picker.kind === 'edit' ? 'fa-cog' : 'fa-paperclip'"></i>
          <span class="qb-pick-title">{{ pickerTitle }}</span>
          <span class="qb-flex"></span>
          <div class="kt-btn" :title="zh ? '关闭' : 'Close'" @click="closePicker"><i class="fa fa-times"></i></div>
        </div>
        <div class="qb-pick-body">
          <!-- 编辑模式（问题配置）：问题文本 + 答案文本 + 参考切片（答案可留空用切片内容作为答案） -->
          <div v-if="picker && picker.kind === 'edit'" class="qb-pick-edit">
            <textarea v-model="pickQuestionDraft" rows="2" class="qb-input qb-pick-q"
              :placeholder="zh ? '问题文本（可在此修改）' : 'Question text (editable here)'"></textarea>
            <textarea v-model="pickAnswerDraft" rows="3" class="qb-input qb-pick-answer"
              :placeholder="zh ? '参考答案文本（留空则使用所选切片内容作为答案）' : 'Answer text (leave empty to use slice content as the answer)'"></textarea>
          </div>
          <!-- 切片区（无切片时不显示，仅编辑问题/答案文本）：工具条与已选 chips 合并为一行 -->
          <template v-if="hasSlices">
            <div class="qb-pick-tools">
              <!-- 搜索切片：固定长度 -->
              <div class="kt-search qb-pick-search">
                <i class="fa fa-search"></i>
                <input v-model="pickKw" class="kt-search-input" :placeholder="zh ? '搜索切片（正文/文件名）…' : 'Search slices…'" />
                <i v-if="pickKw" class="fa fa-times-circle qb-pick-clear" :title="zh ? '清除' : 'Clear'" @click="pickKw = ''"></i>
              </div>
              <!-- LLM 推荐 -->
              <div class="kt-btn ok qb-pick-llm" :class="{ on: llmRecRunning }"
                :title="zh ? '由大模型根据问题/答案推荐最相关的切片' : 'Let the LLM recommend the most relevant slices'"
                @click="runLlmRecommend">
                <i class="fa fa-magic" :class="{ 'fa-spin': llmRecRunning }"></i>
                <span>{{ llmRecRunning ? (zh ? '推荐中' : 'Working') : (zh ? 'LLM 推荐' : 'LLM pick') }}</span>
              </div>
              <!-- 已选切片数量：显示在最右（--fontColor）；具体切片在下方列表按需查看 -->
              <span class="qb-pick-count" :title="zh ? '已选参考切片数' : 'selected reference slices'"><i class="fa fa-check-circle-o"></i> {{ zh ? '已选 ' : '' }}{{ pickSel.length }}</span>
            </div>
            <!-- 提示信息行：仅出现提示时才渲染 -->
            <div v-if="pickMsg" class="qb-pick-tools-sub">
              <span class="qb-pick-msg"><i class="fa fa-info-circle"></i> {{ pickMsg }}</span>
            </div>
            <!-- 主区：左侧切片列表（默认全宽；点击“查看”后收窄为两行导航）+ 右侧 block_md 完整预览 -->
            <div class="qb-pick-main">
              <div class="qb-pick-list" :class="{ nav: !!slicePreview }">
                <div v-if="pickListMode !== 'none'" class="qb-pick-modebar">
                  <template v-if="pickListMode === 'rec'">
                    <i class="fa fa-magic"></i> {{ zh ? 'LLM 推荐结果' : 'LLM recommended' }}（{{ pickList.length }}）
                    <i class="fa fa-times qb-pick-mode-x" :title="zh ? '清除推荐结果' : 'Clear recommendation'" @click="clearLlmRec"></i>
                  </template>
                  <template v-else-if="pickListMode === 'search'">
                    <i class="fa fa-search"></i> {{ zh ? '搜索结果' : 'Search results' }}（{{ pickList.length }}）
                  </template>
                  <template v-else>
                    <i class="fa fa-check-circle-o"></i> {{ zh ? '已选切片' : 'Selected slices' }}（{{ pickList.length }}）
                  </template>
                </div>
                <div v-if="!pickList.length" class="qb-pick-empty">
                  <i :class="pickListMode === 'search' ? 'fa fa-search' : pickListMode === 'rec' ? 'fa fa-magic' : 'fa fa-hand-pointer-o'"></i>
                  <div v-if="pickListMode === 'none'">{{ zh ? '当前没有已选参考切片：可输入关键词搜索，或点击「LLM 推荐」让模型按问题推荐' : 'No slices selected yet: type to search, or use "LLM pick" to recommend by the question' }}</div>
                  <div v-else-if="pickListMode === 'rec'">{{ zh ? '暂无可显示的推荐切片' : 'No recommended slices to show' }}</div>
                  <div v-else>{{ zh ? '没有匹配的切片，换个关键词试试' : 'No matching slices, try another keyword' }}</div>
                </div>
                <div v-for="b in pickVisible" :key="b.id" class="qb-pick-row"
                  :class="{ sel: isPickSel(b.id), cur: !!slicePreview && slicePreview.id === b.id }"
                  @click="openSlicePreview(b)">
                  <!-- 左侧勾选为唯一的选择切换入口；点击行其它区域仅打开/切换预览 -->
                  <i class="fa qb-pick-check" :class="isPickSel(b.id) ? 'fa-check-square-o' : 'fa-square-o'"
                    :title="zh ? (isPickSel(b.id) ? '取消选择该切片' : '选择该切片') : (isPickSel(b.id) ? 'Unselect this slice' : 'Select this slice')"
                    @click.stop="togglePick(b.id)"></i>
                  <div class="qb-pick-row-main">
                    <div class="qb-pick-row-meta"><i class="fa fa-file-text-o"></i> {{ sliceFileOf(b) }}<span class="qb-pick-row-sub"> · {{ b.filePath }}</span></div>
                    <div class="qb-pick-row-a">{{ qbSnippet(b.A, 320) }}</div>
                  </div>
                  <span class="qb-pick-row-ops">
                    <span v-if="isRecId(b.id)" class="qb-pick-rec" :title="zh ? 'LLM 推荐' : 'LLM recommended'"><i class="fa fa-magic"></i></span>
                  </span>
                </div>
                <div v-if="pickMore" class="qb-pick-more" @click="loadMorePick">
                  <i class="fa fa-angle-double-down"></i> {{ zh ? '加载更多' : 'Load more' }}（{{ pickShown }}/{{ pickList.length }}）
                </div>
              </div>
              <!-- 右侧完整预览（左右布局；点击左侧导航项可切换预览目标） -->
              <div v-if="slicePreview" class="qb-slice-view">
                <div class="qb-slice-view-head">
                  <i class="fa fa-eye"></i>
                  <span class="qb-pick-title ellipsis">{{ sliceFileOf(slicePreview) }}</span>
                  <span class="qb-slice-file ellipsis" :title="slicePreview.filePath">{{ slicePreview.filePath }}</span>
                  <span class="qb-flex"></span>
                  <span class="qb-slice-view-sel" :class="isPickSel(slicePreview.id) ? 'on' : ''"
                    :title="isPickSel(slicePreview.id) ? (zh ? '取消选择该切片' : 'Unselect this slice') : (zh ? '选择该切片' : 'Select this slice')"
                    @click.stop="togglePick(slicePreview.id)">
                    <i class="fa" :class="isPickSel(slicePreview.id) ? 'fa-check-circle-o' : 'fa-plus-circle-o'"></i>
                    {{ isPickSel(slicePreview.id) ? (zh ? '已选' : 'Selected') : (zh ? '选择' : 'Select') }}
                  </span>
                  <span class="qb-slice-close" :title="zh ? '收起预览，恢复全宽列表' : 'Collapse preview & restore full list'" @click="closeSlicePreview"><i class="fa fa-times"></i></span>
                </div>
                <div class="qb-slice-view-body"><block_md :content="slicePreview.A || ''" :fontSize="'13px'" /></div>
              </div>
            </div>
          </template>
        </div>
        <div class="qb-pick-foot">
          <div class="kt-btn" @click="closePicker">{{ zh ? '取消' : 'Cancel' }}</div>
          <div class="kt-btn ok" @click="confirmPicker">{{ picker && picker.kind === 'edit' ? (zh ? '保存' : 'Save') : (zh ? '应用选择' : 'Apply') }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.qb-btn {
  display: inline-flex; align-items: center; gap: 4px;
  border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--backgroundColor); color: var(--fontColor);
  padding: 3px 8px; font-size: 11px; cursor: pointer; user-select: none; white-space: nowrap;
}
.qb-btn:hover { color: var(--fontActiveColor); border-color: var(--fontActiveColor); }
.qb-primary { color: #4CAF50; border-color: #4CAF50; }
.qb-running { color: #FF9800; }
.qb-sep { width: 1px; height: 18px; background: var(--borderColor); margin: 0 2px; }
.qb-num { width: 34px; height: 18px; border: 1px solid var(--borderColor); background: var(--backgroundColor); color: var(--fontColor); border-radius: 3px; font-size: 10px; text-align: center; }
.qb-input { border: 1px solid var(--borderColor); background: var(--backgroundColor); color: var(--fontColor); border-radius: 4px; padding: 3px 6px; font-size: 11px; }
.qb-input:focus { outline: none; border-color: var(--fontActiveColor); }
/* 工具栏单行：隐藏横向滚动滑块（提取进度已在底部状态栏展示，无需占横向空间） */
.kt-toolbar { overflow-x: hidden; }
/* 筛选下拉：限宽（选项简短，避免按内容撑开占位/撑破工具栏） */
.qb-filter { width: 92px; min-width: 92px; max-width: 92px; }
.qb-tag { display: inline-block; padding: 0 4px; border: 1px solid var(--borderColor); border-radius: 3px; font-size: 9px; line-height: 14px; }
.qb-link { cursor: pointer; color: var(--borderColor); margin-left: 6px; }
.qb-link.on { color: var(--fontActiveColor); }
.qb-link:hover { color: var(--fontActiveColor); }
.qb-del:hover { color: #F56C6C; }
/* 批量删除不合适问题按钮（评审后显示，红色强调破坏性操作） */
.qb-del-batch { color: #F56C6C; border-color: #F56C6C; }
.qb-del-batch:hover { background: #F56C6C; color: #fff; border-color: #F56C6C; }
.qb-del-batch .qb-del-batch-num { margin-left: 3px; font-size: 10px; line-height: 1; }
/* ===== 页面布局 / 列表 / 问题行（class 化） ===== */
.qb-root { display: flex; flex-direction: column; height: 100%; width: 100%; overflow: hidden; box-sizing: border-box; }
/* 手动添加行 */
.qb-add-text { flex: 2; min-width: 180px; }
.qb-add-answer { flex: 3; min-width: 200px; }
/* 去重审核面板 */
.qb-dup-panel { border-bottom: 1px solid var(--borderColor); background: var(--backgroundColor); }
.qb-dup-head { display: flex; align-items: center; gap: 6px; padding: 4px 8px; font-size: 11px; }
.qb-dup-ico, .qb-dup-title { color: #FF9800; }
.qb-dup-title { display: inline-flex; align-items: center; gap: 5px; }
.qb-dup-clean { color: #4CAF50; }
.qb-dup-list { max-height: 220px; overflow: auto; padding: 4px 8px 8px; }
.qb-dup-group { border: 1px solid var(--borderColor); border-radius: 5px; margin-bottom: 6px; padding: 6px; background: var(--backgroundHoverColor, transparent); }
.qb-dup-group-cap { font-size: 11px; color: var(--borderColor); margin-bottom: 4px; }
.qb-dup-member { display: flex; gap: 6px; align-items: flex-start; margin-bottom: 3px; }
.qb-dup-radio { margin-top: 6px; }
.qb-dup-member-main { flex: 1; font-size: 11px; word-break: break-all; }
.qb-dup-member-meta { color: var(--borderColor); font-size: 10px; }
.qb-dup-actions { display: flex; gap: 6px; margin-top: 4px; }
/* 列表 / 空态 */
.qb-list { flex: 1; overflow: auto; min-height: 0; }
.qb-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: var(--borderColor); font-size: 12px; text-align: center; padding: 10px; gap: 4px; }
.qb-empty i { font-size: 22px; }
/* 滚动分批加载：底部加载更多提示 */
.qb-loadmore { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 6px 0 8px; font-size: 10px; color: var(--borderColor); }
.qb-loadmore-num { opacity: .8; }
/* 问题行 */
.qb-item { border-bottom: 1px solid var(--borderColor); padding: 5px 8px; }
.qb-item-inner { display: flex; gap: 8px; align-items: flex-start; }
.qb-idx { color: var(--fontColor); font-size: 10px; margin-top: 3px; width: 26px; flex-shrink: 0; }
.qb-main { flex: 1; min-width: 0; }
/* 问题文本 + meta 同排：文本在左占满剩余，meta 各要素（标签/来源/状态/操作）贴右侧 */
.qb-line { display: flex; align-items: flex-start; gap: 8px; }
.qb-text { flex: 1; min-width: 0; font-size: 12px; word-break: break-all; }
.qb-text-merged { color: var(--borderColor); text-decoration: line-through; }
.qb-meta { display: flex; align-items: center; justify-content: flex-end; gap: 5px; font-size: 10px; color: var(--borderColor); flex-wrap: wrap; flex-shrink: 1; min-width: 0; max-width: 62%; padding-top: 1px; }
.qb-ops { display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0; }
.qb-meta-item { display: inline-flex; align-items: center; gap: 3px; }
.qb-flex { flex: 1; }
.qb-tag-r { color: #42A5F5; border-color: #42A5F5; }
.qb-tag-c { color: #AB47BC; border-color: #AB47BC; }
.qb-vec.ok { color: #4CAF50; cursor: pointer; }
.qb-vec.ok:hover { color: var(--fontActiveColor); }
.qb-vec.warn { color: #FF9800; }
.qb-answer { margin-top: 2px; font-size: 11px; color: #42A5F5; line-height: 1.5; word-break: break-all; }
.qb-scroll::-webkit-scrollbar { width: 6px; }
/* ===== 独立性评审 ===== */
.qb-item-bad { background: color-mix(in srgb, #F56C6C 7%, transparent); }
.qb-tag-bad { color: #F56C6C; border-color: #F56C6C; cursor: pointer; }
.qb-tag-bad:hover { text-decoration: line-through; }
.qb-tag-ok { color: #4CAF50; border-color: #4CAF50; }
/* ===== 参考切片：手动添加的已选 chips ===== */
.qb-add-picks { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; padding: 3px 8px; border-bottom: 1px solid var(--borderColor); font-size: 10px; background: var(--backgroundHoverColor, transparent); }
.qb-picks-cap { color: var(--borderColor); display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
.qb-chip { display: inline-flex; align-items: center; gap: 4px; max-width: 320px; padding: 1px 6px; border: 1px solid var(--borderColor); border-radius: 10px; background: var(--backgroundColor); color: var(--fontColor); font-size: 10px; white-space: nowrap; overflow: hidden; }
.qb-chip .fa-file-text-o { color: var(--borderColor); flex-shrink: 0; }
.qb-chip-x { cursor: pointer; color: var(--borderColor); flex-shrink: 0; }
.qb-chip-x:hover { color: #F56C6C; }
/* ===== 参考切片选择模态框 ===== */
.qb-pick-overlay { position: fixed; inset: 0; z-index: 1200; background: rgba(0, 0, 0, .35); display: flex; align-items: center; justify-content: center; }
.qb-pick-dialog { display: flex; flex-direction: column; width: min(850px, 92vw); max-height: min(720px, 90vh); background: var(--backgroundColor); border: 1px solid var(--borderColor); border-radius: 8px; box-shadow: 0 8px 28px rgba(0, 0, 0, .3); overflow: hidden; }
.qb-pick-head { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--borderColor); font-size: 12px; flex-shrink: 0; }
.qb-pick-head > .fa-paperclip, .qb-pick-head > .fa-cog { color: #42A5F5; }
.qb-pick-title { font-weight: 600; color: var(--fontColor); }
.qb-pick-body { display: flex; flex-direction: column; gap: 6px; padding: 8px; overflow: hidden; min-height: 0; }
.qb-pick-edit { display: flex; flex-direction: column; gap: 5px; flex-shrink: 0; }
.qb-pick-q { width: 100%; box-sizing: border-box; resize: vertical; font-size: 11px; color: var(--fontColor); line-height: 1.5; }
.qb-pick-answer { width: 100%; resize: vertical; box-sizing: border-box; line-height: 1.5; }
.qb-pick-tools { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; flex-shrink: 0; }
/* 搜索切片框：占满剩余空间（LLM 推荐与已选计数之外的整行空白） */
.qb-pick-search { flex: 1 1 auto; min-width: 120px; width: auto; }
/* 提示信息行（仅消息出现时渲染） */
.qb-pick-tools-sub { display: flex; align-items: center; flex-shrink: 0; }
.qb-pick-clear { cursor: pointer; color: var(--borderColor); flex-shrink: 0; }
.qb-pick-clear:hover { color: var(--fontActiveColor); }
.qb-pick-llm { padding: 0 10px; }
.qb-pick-msg { font-size: 10px; color: #FF9800; display: inline-flex; align-items: center; gap: 3px; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qb-pick-count { font-size: 10px; color: var(--fontColor); white-space: nowrap; flex-shrink: 0; display: inline-flex; align-items: center; gap: 3px; }
/* 主区分栏：默认列表全宽；预览时左侧收窄为两行导航 + 右侧完整预览 */
.qb-pick-main { flex: 1 1 0%; min-height: 160px; min-width: 0; display: flex; gap: 8px; }
.qb-pick-list { flex: 1 1 auto; min-width: 0; min-height: 0; overflow: auto; border: 1px solid var(--borderColor); border-radius: 6px; }
.qb-pick-list.nav { flex: 0 0 300px; }
.qb-pick-row.cur { outline: 1px solid var(--fontActiveColor, #42A5F5); outline-offset: -1px; }
/* 预览态导航：每个切片最多两行（meta 一行 + 正文截断一行） */
.qb-pick-list.nav .qb-pick-row-a { display: -webkit-box; -webkit-line-clamp: 1; line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
.qb-pick-list::-webkit-scrollbar { width: 6px; }
.qb-pick-row { display: flex; align-items: flex-start; gap: 6px; padding: 5px 8px; cursor: pointer; border-bottom: 1px solid color-mix(in srgb, var(--borderColor) 45%, transparent); font-size: 11px; }
.qb-pick-row:hover { background: var(--menuColor); }
.qb-pick-row.sel { background: color-mix(in srgb, #42A5F5 12%, transparent); }
.qb-pick-check { margin-top: 2px; color: var(--borderColor); flex-shrink: 0; }
.qb-pick-row.sel .qb-pick-check { color: #42A5F5; }
.qb-pick-row-main { flex: 1; min-width: 0; }
.qb-pick-row-meta { font-size: 10px; color: var(--borderColor); display: flex; align-items: center; gap: 4px; white-space: nowrap; overflow: hidden; }
.qb-pick-row-meta .fa-file-text-o { color: var(--fontActiveColor, #42A5F5); flex-shrink: 0; }
.qb-pick-row-sub { color: var(--borderColor); overflow: hidden; text-overflow: ellipsis; }
.qb-pick-row-a { color: var(--fontColor); word-break: break-all; line-height: 1.45; margin-top: 1px; }
.qb-pick-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; height: 100%; min-height: 160px; color: var(--borderColor); font-size: 11px; }
.qb-pick-empty i { font-size: 20px; }
.qb-pick-more { padding: 6px; text-align: center; font-size: 10px; color: var(--borderColor); cursor: pointer; }
.qb-pick-more:hover { color: var(--fontActiveColor); }
.qb-pick-foot { display: flex; align-items: center; justify-content: flex-end; gap: 6px; padding: 6px 8px; border-top: 1px solid var(--borderColor); flex-shrink: 0; }
.qb-pick-foot .kt-btn { padding: 0 12px; }
/* ===== 参考切片：chips 可点开预览完整内容 ===== */
.qb-chip-body { display: inline-flex; align-items: center; gap: 4px; overflow: hidden; cursor: pointer; }
.qb-chip-body:hover { color: var(--fontActiveColor); }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* ===== 切片列表模式条（搜索 / LLM 推荐在下方过滤显示） ===== */
.qb-pick-modebar { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-bottom: 1px solid color-mix(in srgb, var(--borderColor) 45%, transparent); font-size: 10px; color: var(--fontActiveColor, #42A5F5); position: sticky; top: 0; background: var(--backgroundColor); z-index: 1; }
.qb-pick-modebar .fa-magic { color: #AB47BC; }
.qb-pick-modebar .fa-search { color: #42A5F5; }
.qb-pick-mode-x { margin-left: auto; cursor: pointer; color: var(--borderColor); padding: 2px 4px; }
.qb-pick-mode-x:hover { color: #F56C6C; }
.qb-pick-row-ops { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; margin-left: 4px; }
.qb-pick-rec { color: #AB47BC; font-size: 11px; cursor: default; }
/* ===== 右侧完整切片预览（左右布局；block_md 渲染） ===== */
.qb-slice-view { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; border: 1px solid var(--borderColor); border-radius: 6px; overflow: hidden; background: var(--backgroundColor); }
.qb-slice-view-head { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-bottom: 1px solid var(--borderColor); font-size: 11px; flex-shrink: 0; }
.qb-slice-view-head > .fa-eye { color: #42A5F5; }
.qb-slice-view-head .qb-pick-title { max-width: 40%; }
/* 收起预览：仅图标（非按钮样式） */
.qb-slice-close { display: inline-flex; align-items: center; color: var(--borderColor); font-size: 12px; cursor: pointer; flex-shrink: 0; }
.qb-slice-close:hover { color: var(--fontActiveColor); }
.qb-slice-file { font-size: 10px; color: var(--borderColor); max-width: 45%; flex-shrink: 1; }
.qb-slice-view-sel { display: inline-flex; align-items: center; gap: 3px; font-size: 10px; white-space: nowrap; cursor: pointer; flex-shrink: 0; }
.qb-slice-view-sel.on { color: #4CAF50; }
.qb-slice-view-sel:not(.on) { color: #42A5F5; }
.qb-slice-view-sel:hover { text-decoration: underline; }
.qb-slice-view-body { flex: 1; min-height: 0; overflow: auto; padding: 10px 12px; font-size: 13px; color: var(--fontColor); }
.qb-slice-view-body::-webkit-scrollbar { width: 8px; }
</style>
