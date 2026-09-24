<script setup lang="ts">
import { ref, computed, reactive, watch, onMounted, nextTick } from 'vue'
import block_md from '@/components/block_md.vue'
import * as XLSX from 'xlsx'
import {usestore} from '@/store'
import { runStrategy, getEnabledStrategies } from '@/shared/graphrag/strategy'
import { computeBM25Score } from '@/shared/graphrag/search'
import { INGESTION_PRIMITIVES, prewarmEntityVectors } from '@/shared/graphrag/primitives'
import type { RetrievalContext, IngestionContext } from '@/shared/graphrag/primitives'
import { cosineSimilarity } from '@/shared/kbRetrieval'
import * as kbAi from '@/shared/kbAiClient'
const store=usestore()

// 统一模型来源客户端（多 provider）：连接配置取自 store.AIconfig.llm[llmType]
const kbSpec = () => kbAi.buildSpecFromModel(props.model, props.store)

// 一条测试问题的「关联切片」判定基准（由问题库 answerBlocks/srcBlockId 派生）
interface TestCaseRef { srcBlockId?: string; blockIds: string[] }

// 定义组件接口
interface Props {
  store: any
  blocks: any[]
  model: any
  getModel: () => Promise<void>
  files?: any[]
  // 本体/图谱相关
  globalEntities?: Map<string, any>
  getCurrentOntologyContext?: () => { entities: any[], relations: any[] }
  communityReports?: any[]
  communityResult?: any
  chatWithOntology?: (prompt: string) => Promise<any>
  // 随 .kb 保存/加载的测试用例（refs[i] = 第 i 条问题的关联切片，命中判定基准）
  // source: 'bank'=由问题库派生（自动跟随问题库）；'external'=外部 Excel 导入的独立测试集（仅评测，不写入问题库/知识库）
  testCases?: { questions?: string[], answers?: string[], refs?: TestCaseRef[], source?: 'bank' | 'external' }
  // 读取/刷新测试用例：按设置中的上限从问题库重新派生问题
  onRefreshTestCases?: () => void
  // 文件级摘要索引（summarize_file 预热写入用，来自父组件 ref 自动解包后的 Map）
  fileIndex?: any
  // 问题增强索引（问题库 → 关联切片问题向量，与 QA 检索 buildRetrievalContext 同源）。
  // 缺失时「问题增强/本体/多跳」等含 dense_score(summaryWeight>0) 的策略在评测中 Q 通道为空，退化为纯切片分。
  questionVectorsByBlock?: Map<string, number[][]>
  // 策略注册表版本（父级在策略配置开关/改名后自增，用于刷新本面板策略下拉）
  strategyVersion?: number
  // 预热社区报告：预生成社区报告（由父组件提供）
  ensureCommunityReports?: () => Promise<boolean>
}

// 检索策略类型（与 QA 标签页的检索方式对齐，策略可配置）
type SearchAlgorithm = string

// 测试结果类型
interface TestResult {
  question: string
  answer: string
  algorithm: SearchAlgorithm
  slices: Array<{
    label: string
    content: string
    score: number
    extension: string
    /** 切片身份（供关联切片基准比对） */
    id?: string
    filePath?: string
    /** 该检索切片是否正是本问题的关联切片（按切片身份比对，为主判定基准） */
    isReferenceSlice: boolean
    /** 是否命中本问题判定基准：有关联切片时=isReferenceSlice；无关联切片（手动/导入）时=参考答案文本匹配 */
    containsAnswer: boolean
    answerText: string
    rank: number
    detailedScores: {
      fileSummaryScore: number
      sliceScore: number
      /** 问题增强通道分（问题库关联问题向量余弦；仅含 dense_score 且 summaryWeight>0 的策略有值） */
      questionScore: number
      overallScore: number
      /** 该切片无关联问题（问题增强通道缺失）：总分已按「切片分兜底」，问题分为 0 不代表不相关 */
      qMissing?: boolean
      /** 该切片所属文件无文件摘要（文件摘要通道缺失）：不参与文件通道叠加 */
      fMissing?: boolean
      entityBoostMultiplier?: number
      matchedEntities?: string[]
      hopExpansionCount?: number
      communityBoostMultiplier?: number
    }
  }>
  avgScore: number
  timestamp: string
  /** 本次检索/召回耗时（毫秒） */
  recallTimeMs?: number
  /** 本问题的关联切片判定基准（来源切片/参考切片，随 testCases.refs 行对齐传入） */
  ref?: TestCaseRef
  testConfig: {
    searchNum: number
    summaryWeight: number
    sliceWeight: number
  }
}

// 位次分析结果类型
interface RankAnalysisResult {
  question: string
  answer: string
  algorithm: SearchAlgorithm
  ranks: string
  firstRank: number
  bestRank: number
  foundCount: number
  answerParts?: string[]
  /** 判定基准类型：slice=按关联切片身份比对；text=按参考答案文本（手动/导入无关联切片） */
  refMode?: 'slice' | 'text'
  hitRate?: number
  hitCount?: number
  totalAnswers?: number
  matchedAnswers?: string[]
  hitDetails?: Array<{
    rank: number
    matchedAnswers: string[]
    totalAnswers: number
    hitCount: number
    hitRate: number
  }>
  timestamp: string
  /** 本次召回耗时（毫秒） */
  timeMs?: number
}

const props = defineProps<Props>()

// 测试相关状态（refs 与 questions 按行对齐：该行问题的关联切片判定基准）
const test = reactive({
  questions: [''] as string[],
  answers: [''] as string[],
  refs: [] as TestCaseRef[],
  /** 命中判定基准：'slice'=切片精准命中（默认，按关联切片身份比对）；'text'=答案命中（按参考答案文本匹配，旧口径） */
  hitMode: 'slice' as 'slice' | 'text',
  /** 答案命中子策略：'precise'=精准（切片须完整包含某段参考答案）；'fuzzy'=模糊（整段/反向前缀/分段/词比例任一命中，旧口径） */
  matchMode: 'fuzzy' as 'precise' | 'fuzzy',
  searchNum: 5 as any,
  isRunning: false,
  progress: 0,
  currentAlgorithm: 'similarity' as SearchAlgorithm,
  questionStatus: [] as Array<{text: string, color: string, icon: string, time?: string, algorithm?: SearchAlgorithm}>
})

// 切片数量与 QA 检索数量（model.searchNum）保持一致：双向同步，测试与 QA 用同一个值
if (props.model?.searchNum) test.searchNum = props.model.searchNum
watch(() => props.model?.searchNum, (v) => {
  if (v !== undefined && Number(test.searchNum) !== Number(v)) test.searchNum = v
})
watch(() => test.searchNum, (v) => {
  if (props.model && Number(props.model.searchNum) !== Number(v)) props.model.searchNum = v
})

// 把 refs 归一为与 questions 行对齐的数组（缺行补空，保证后续按索引取判定基准不越界）
const normalizeRefs = (refs: any, len: number): TestCaseRef[] => {
  const out: TestCaseRef[] = []
  for (let i = 0; i < len; i++) {
    const r = refs?.[i]
    out.push(r && (r.srcBlockId || (r.blockIds || []).length)
      ? { srcBlockId: r.srcBlockId, blockIds: (r.blockIds || []) }
      : { srcBlockId: undefined, blockIds: [] })
  }
  return out
}

// 问题库 → testCases（父壳派生产物）→ 同步到本表（运行中不打断；仅内容变化时同步）
watch(() => props.testCases, (tc: any) => {
  if (test.isRunning || !tc) return
  const qs = (tc.questions || []).map((q: string) => q || '')
  const as = (tc.answers || []).map((a: string) => a || '')
  const refs = normalizeRefs(tc.refs || [], qs.length)
  const changed = qs.length !== test.questions.length
    || qs.some((q: string, i: number) => q !== test.questions[i])
    || as.some((a: string, i: number) => a !== (test.answers[i] || ''))
    || refs.some((r: TestCaseRef, i: number) => JSON.stringify(r) !== JSON.stringify(test.refs[i]))
  if (!changed) return
  const prevSource = testSource.value
  testSource.value = (tc.source === 'external') ? 'external' : 'bank'
  test.questions = qs.length ? [...qs] : ['']
  test.answers = [...as]
  test.refs = refs.length ? refs : normalizeRefs([], test.questions.length)
  test.questionStatus = qs.map(() => ({
    text: store.locales=='zh' ? '未测试' : 'Not Tested',
    color: 'var(--borderColor)', icon: 'fa fa-circle-o'
  }))
  // 来源切换（问题库 ↔ 外部导入）意味着列表整体被替换：旧结果/位次已与行失配 → 清空，避免误读
  if (prevSource !== testSource.value) {
    testResults.value = []
    rankAnalysisResults.value = []
    allStrategyStats.value = []
    allStrategySliceResults.value = []
  }
}, { deep: true })

// 测试用例来源：'bank'=由问题库派生（自动跟随问题库）；'external'=外部 Excel 导入的独立测试集（仅评测，不写入问题库/知识库）。
// 外部来源时父组件会暂停「问题库 → 测试用例」的自动覆盖，保证独立测试集不被误冲掉。
const testSource = ref<'bank' | 'external'>('bank')
watch(() => props.testCases?.source, (s) => {
  testSource.value = (s === 'external') ? 'external' : 'bank'
}, { immediate: true })

const testResults = ref<TestResult[]>([])
const rankAnalysisResults = ref<RankAnalysisResult[]>([])
const lastUpdateTime = ref('')
const isExporting = ref(false)
const activeTab = ref('test') // 'test' | 'rank' | 'batch'

// ===== 问题列表分段加载（参照切片标签页：问题过多时向下滚动分批渲染） =====
const TEST_LOAD_CHUNK = 50
const displayedQuestions = ref(TEST_LOAD_CHUNK)
const isLoadingMoreRows = ref(false)
const testScrollRef = ref<HTMLElement | null>(null)
const hasMoreQuestions = computed(() => displayedQuestions.value < test.questions.length)
const visibleQuestionCount = computed(() => Math.min(displayedQuestions.value, test.questions.length))
// 可见问题的原始索引（0-based），模板 v-for 直接用原始索引访问 test.questions / testResults 等
const visibleRows = computed(() => Array.from({ length: visibleQuestionCount.value }, (_, i) => i))

function appendMoreQuestions() {
  if (!hasMoreQuestions.value) return
  displayedQuestions.value = Math.min(displayedQuestions.value + TEST_LOAD_CHUNK, test.questions.length)
}

function loadMoreQuestions() {
  if (isLoadingMoreRows.value || !hasMoreQuestions.value) return
  isLoadingMoreRows.value = true
  requestAnimationFrame(() => {
    setTimeout(() => {
      appendMoreQuestions()
      isLoadingMoreRows.value = false
      fillTestViewportIfShort()
    }, 50)
  })
}

// 滚动到底部附近时加载更多（与切片标签页 handleScroll 一致：距底 <200px 触发）
function handleTestScroll(event: Event) {
  const el = event.target as HTMLElement
  if (!el) return
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 200 && hasMoreQuestions.value && !isLoadingMoreRows.value) {
    loadMoreQuestions()
  }
}

// 容器内容不足一屏时自动补足（切换 tab / 窗口拉大场景，与切片页 fillViewportIfShort 一致）
async function fillTestViewportIfShort() {
  const el = testScrollRef.value
  if (!el || !hasMoreQuestions.value) return
  let guard = 0
  while (hasMoreQuestions.value && el.scrollHeight <= el.clientHeight + 4 && guard < 60) {
    appendMoreQuestions()
    guard++
    await nextTick()
  }
}

function resetQuestionPaging() {
  displayedQuestions.value = TEST_LOAD_CHUNK
  isLoadingMoreRows.value = false
}

watch(() => test.questions.length, () => { resetQuestionPaging() })
watch(() => activeTab.value, (v) => { if (v === 'test') nextTick(() => fillTestViewportIfShort()) })

// 判定基准（切片命中 ↔ 答案命中）或答案命中子策略（精准/模糊）变化 → 旧结果口径失效，清空重测，避免误读
const clearJudgementResults = () => {
  testResults.value = []
  rankAnalysisResults.value = []
  allStrategyStats.value = []
  allStrategySliceResults.value = []
  test.questionStatus = test.questions.map(() => ({
    text: store.locales=='zh' ? '未测试' : 'Not Tested',
    color: 'var(--borderColor)', icon: 'fa fa-circle-o'
  }))
}
watch(() => test.hitMode, () => { if (!test.isRunning) clearJudgementResults() })
watch(() => test.matchMode, () => { if (!test.isRunning) clearJudgementResults() })

// 手动清空全部测试结果（释放内存）
const clearAllResults = () => {
  if (test.isRunning) return
  clearJudgementResults()
  lastUpdateTime.value = ''
}

// 策略选项（与 QA 标签页的检索方式一致，来自可配置策略注册表；仅启用的策略参与测试）
const algorithmOptions = computed(() => {
  // 依赖父级策略版本：策略配置开关/改名后父级自增 strategyVersion → 本面板选项即时刷新
  void props.strategyVersion
  return getEnabledStrategies().map(s => ({
    value: s.id,
    label: s.label,
    icon: s.kind === 'pipeline' ? 'fa fa-cubes' : s.kind === 'mapreduce' ? 'fa fa-users' : s.kind === 'hybrid' ? 'fa fa-th-large' : 'fa fa-magic',
  }))
})

// 当前所选策略被停用（从注册表消失）时自动回退到首个可用策略，避免后续测试跑向失效策略
watch(algorithmOptions, (opts) => {
  if (opts.length && !opts.some(o => o.value === test.currentAlgorithm)) {
    test.currentAlgorithm = opts[0].value
  }
}, { immediate: true })

// 文件摘要信息存储
const fileSummaries = ref(new Map()) as any

// 监听语言切换
watch(() => props.store?.locales, (newLocale) => {
  test.questionStatus = test.questionStatus.map(status => {
    const textMap: Record<string, {zh: string, en: string}> = {
      '未测试': {zh: '未测试', en: 'Not Tested'},
      '测试中...': {zh: '测试中...', en: 'Testing...'},
      '完成': {zh: '完成', en: 'Completed'},
      '完成 ✓': {zh: '完成 ✓', en: 'Completed ✓'},
      '测试失败': {zh: '测试失败', en: 'Test Failed'}
    }
    
    const statusText = status.text
    if (textMap[statusText]) {
      return {
        ...status,
        text: newLocale === 'zh' ? textMap[statusText].zh : textMap[statusText].en
      }
    }
    return status
  })
})

// 文件自带摘要文本（markdown frontmatter 的 摘要/summary/abstract，或 attributes），不做 LLM 生成
function getFileSummaryText(file: any): string {
  if (!file) return ''
  if (typeof file.content === 'string') {
    const yaml = file.content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/)
    if (yaml) {
      const m = yaml[1].match(/^(摘要|summary|abstract):\s*(.+)$/mi)
      if (m && m[2]) return m[2].trim()
    }
  }
  if (file.attributes && (file.attributes.summary || file.attributes.摘要 || file.attributes.abstract)) {
    return (file.attributes.summary || file.attributes.摘要 || file.attributes.abstract).toString().trim()
  }
  return ''
}

// 从文件内容中提取摘要信息（复用 getFileSummaryText：frontmatter / attributes 摘要）
function extractFileSummary(file: any) {
  const summary = getFileSummaryText(file)
  if (!summary || !file?.path) return
  fileSummaries.value.set(file.path, { content: summary, vector: null })
}

// 获取文件摘要向量
// 构建实体 → 关联切片 索引（供策略框架 entity_link/graph_hop/boost 使用）
function buildEntityToBlocksIndex(): Map<string, Set<string>> {
  const idx = new Map<string, Set<string>>()
  if (!props.globalEntities) return idx
  for (const [name, entity] of props.globalEntities.entries()) {
    const key = name.toLowerCase()
    const set = new Set<string>()
    if (entity.associatedBlocks?.length) {
      entity.associatedBlocks.forEach((id: string) => set.add(id))
    }
    // 兜底：文本包含实体名的块
    if (set.size === 0) {
      for (const b of props.blocks) {
        if ((b.A && b.A.includes(name)) || (b.Q && b.Q.includes(name))) {
          set.add(b.id)
        }
      }
    }
    if (set.size) idx.set(key, set)
  }
  return idx
}

// ==================== 关联切片判定基准（gold） ====================
// 测试的目的：评测检索是否召回了问题的「正确切片」。每条问题在问题库中带有关联切片
// (answerBlocks/srcBlockId)——即它的 ground-truth 切片。命中判定应比对「检索切片是否为
// 关联切片本身」（身份匹配），而非拿 LLM 推理出的答案文本做子串匹配（措辞差异会造成误判）。

// 该行问题是否有可用的关联切片基准
const hasGoldRef = (ref?: TestCaseRef): boolean => !!ref && !!(ref.srcBlockId || (ref.blockIds || []).length > 0)

// 关联切片 → 唯一 blockId 集合（只按精确 id 比对，避免同标题多块被误判为同一参考切片）
const goldIdSet = (ref?: TestCaseRef): Set<string> => {
  const ids = new Set<string>()
  if (!ref) return ids
  if (ref.srcBlockId) ids.add(ref.srcBlockId)
  for (const bid of ref.blockIds || []) if (bid) ids.add(bid)
  return ids
}

// 检索切片是否为该问题的关联切片：仅当切片 blockId 与关联切片 id 完全相等（同一块）。
// 不采用 filePath#label 兜底：同文件/同标题会切出多个块，按“路径+标题”会把 1 个参考切片误判成多块命中。
const isReferenceSlice = (block: any, ref?: TestCaseRef): boolean => {
  const ids = goldIdSet(ref)
  if (ids.size === 0) return false
  const id = block?.id || ''
  return !!id && ids.has(id)
}

// ==================== 关联切片 UI 展示（判定基准） ====================
// 每行问题的「关联切片」清单（来源/参考切片）与最近一次检索的召回命中状态，供人眼与检索切片对比
const blocksByIdGold = computed(() => new Map((props.blocks || []).map((b: any) => [b.id, b])))

// ===== 切片原文按需回源：结果只存切片 id/元数据，不深拷贝、不保存正文；点击查看/命中判定/导出时才按 id 从 props.blocks 读取 =====
const blocksByIdMap = computed(() => new Map((props.blocks || []).map((b: any) => [b.id, b])))
// 取某检索切片的展示文本：优先用块内内联 content（无法回源的合成切片），否则按 id 回源 props.blocks
const sliceTextOf = (slice: any): string => {
  if (!slice) return ''
  if (typeof slice.content === 'string' && slice.content) return slice.content
  const b = slice?.id ? blocksByIdMap.value.get(slice.id) : undefined
  return (b?.A ?? b?.content ?? '') || ''
}
// 结果单元格快捷访问（n：第 n 个检索切片）
const cellSlice = (qIndex: number, n: number) => testResults.value[qIndex]?.slices?.[n - 1] || null
// 切片命中状态（供单元格小对勾）
const sliceHitInfo = (qIndex: number, n: number) => {
  const s = cellSlice(qIndex, n)
  return { hit: !!s?.containsAnswer, ref: !!s?.isReferenceSlice }
}

// ===== 切片 / 关联切片查看模态框（点击后按需渲染；正文实时回源） =====
const preview = ref<any>(null)
const closeSlicePreview = () => { preview.value = null }
const openSlicePreview = (qIndex: number, n: number) => {
  const s = cellSlice(qIndex, n)
  if (!s) return
  const d = s.detailedScores || {}
  preview.value = {
    question: testResults.value[qIndex]?.question || '',
    heading: (store.locales=='zh' ? '检索切片 · 位次 #' : 'Slice · Rank #') + n,
    entries: [{
      kind: 'slice',
      title: s.label || '',
      file: s.filePath || '',
      icon: store.icon(s.extension || ''),
      hit: !!s.containsAnswer,
      isReference: !!s.isReferenceSlice,
      sScore: d.sliceScore,
      qScore: d.questionScore,
      qMissing: !!d.qMissing,
      fScore: d.fileSummaryScore,
      fMissing: !!d.fMissing,
      hop: d.hopExpansionCount,
      boost: d.entityBoostMultiplier,
      total: s.score,
      content: sliceTextOf(s),
    }],
  }
}
const openGoldPreview = (qIndex: number) => {
  const list = rowGoldList(qIndex)
  if (!list || list.length === 0) return
  preview.value = {
    question: test.questions[qIndex] || '',
    heading: store.locales=='zh' ? `关联切片（判定基准 · ${list.length}）` : `Linked slices (gold · ${list.length})`,
    entries: list.map(g => {
      const b = blocksByIdMap.value.get(g.id)
      return {
        kind: 'gold',
        title: g.label || g.id,
        file: g.file || '',
        icon: store.icon(b?.extension || ''),
        hit: !!g.hit,
        content: g.content || '',
      }
    }),
  }
}

const rowGoldList = (idx: number) => {
  const ref = test.refs?.[idx]
  const ids = ref ? [...(ref.blockIds || [])] : []
  const byId = blocksByIdGold.value
  const result = testResults.value[idx]
  return ids.map(id => {
    const b = byId.get(id)
    const label = b?.label || id
    // 该关联切片是否已被最近一次检索召回（仅按 blockId 精确比对，与 performSearch 一致）
    const hit = !!result?.slices?.some((s: any) => !!s.id && s.id === id)
    return {
      id,
      label,
      hit,
      file: (b?.filePath || '').split(/[\\/]/).pop() || '',
      content: b?.A || '',
      title: b ? `${b.label || id} · ${(b.filePath || '').split(/[\\/]/).pop() || ''}` : id,
    }
  })
}
const rowGoldCount = (idx: number): number => rowGoldList(idx).length
const rowGoldHitCount = (idx: number): number => rowGoldList(idx).filter(g => g.hit).length

// 位次分析页列头随判定基准类型变化（首行模式）
const rankRefMode = computed<'slice' | 'text'>(() => rankAnalysisResults.value[0]?.refMode || 'text')

// ==================== 答案命中（text 模式）子策略：精准 / 模糊 ====================
// 参考答案按 | 分段（去空白段）——精准模式按段判定，位次分析也按段展示命中成分/完整率
const answerSegments = (answerText: string): string[] =>
  (answerText || '').split('|').map((s: string) => s.trim()).filter((s: string) => s.length > 0)

// 精准命中：切片须完整包含某段参考答案（按 | 分段，任一整段包含即命中），统一忽略大小写，不做任何模糊兜底
const preciseAnswerHit = (sliceContent: string, answerText: string): boolean => {
  const segs = answerSegments(answerText)
  if (segs.length === 0) return false
  const sc = (sliceContent || '').toLowerCase()
  return segs.some((seg: string) => sc.includes(seg.toLowerCase()))
}

// 模糊命中：沿用原有 textHit 完整逻辑（整段包含 / 反向前缀50字 / | 分段任一 / 词比例≥0.7），并统一为忽略大小写
const fuzzyAnswerHit = (sliceContent: string, answerText: string): boolean => {
  const ans = (answerText || '').trim()
  if (!ans) return false
  const sc = sliceContent || ''
  const scL = sc.toLowerCase()
  const ansL = ans.toLowerCase()
  return scL.includes(ansL) ||
    ansL.includes(scL.substring(0, Math.min(50, scL.length))) ||
    fuzzyMatch(sc, ans)
}

// 答案命中的统一切片命中判定（随 matchMode 变化）。performSearch（切片对勾/行状态）与
// generateRankAnalysis（位次命中）共用同一判定，保证切片表格、位次分析、策略对比与导出口径一致。
const textSliceHit = (sliceContent: string, answerText: string): boolean =>
  test.matchMode === 'precise' ? preciseAnswerHit(sliceContent, answerText) : fuzzyAnswerHit(sliceContent, answerText)

// 执行检索（统一走策略框架 runStrategy，与聊天共用同一套检索逻辑，消除实现漂移）
async function performSearch(question: string, searchNum: number, algorithm: SearchAlgorithm, answer?: string, ref?: TestCaseRef): Promise<{
  slices: TestResult['slices'],
  avgScore: number,
  timeMs: number
}> {
  const startTime = performance.now()
  // 该策略启用的增强通道（决定是否展示「通道缺失·切片分兜底」标记）
  const algoCh = channelFlagsOf(algorithm)

  const ctx: RetrievalContext = {
    query: question,
    blocks: props.blocks,
    entities: (props.getCurrentOntologyContext?.()?.entities || []),
    relations: (props.getCurrentOntologyContext?.()?.relations || []),
    entityToBlocksIndex: buildEntityToBlocksIndex(),
    communityReports: props.communityReports,
    communityResult: props.communityResult as any,
    // 用真实的文件摘要索引（来自父组件 fileIndex），让 file_score 步骤在评测中真实参与，避免所有策略的文件通道失效
    fileIndex: (props.fileIndex as any) || new Map() as Map<string, any>,
    // 问题增强索引（与 QA 检索同源）：让「问题增强」等 dense_score(summaryWeight>0) 策略的问题通道在评测中真实参与，
    // 否则 Q 通道为空 → p=0.3×切片分 → 排序与「相似度」一致，评测结果完全相同
    questionVectorsByBlock: (props.questionVectorsByBlock as any) || new Map() as Map<string, number[][]>,
    config: {
      url: props.model.url,
      embed: props.model.embed,
      chat: props.model.chat,
      process: props.model.process,
      locale: props.store.locales,
      summaryWeight: props.model.summaryWeight ?? 0.7,
      bm25Enabled: props.model.bm25Enabled || false,
      bm25Weight: props.model.bm25Weight || 0.3,
      bm25K1: props.model.bm25K1,
      bm25B: props.model.bm25B,
      searchNum,
      think: props.model.think,
    },
    services: kbAi.buildRetrievalServices(kbSpec(), {
      cosineSimilarity,
      computeBM25: computeBM25Score,
    }),
  }

  const sr = await runStrategy(algorithm, question, ctx, {}, { skipAnswer: true })

  // 通道分解分明细：dense_score/file_score 把「切片/问题/文件」原始通道分经管线累积到 sr.meta.blockDetails，
  // 这里按 blockId 取出，供查看模态框分项展示；总分(results.score)仍为各通道按策略权重合成的最终值
  const scoreDetailMap: Map<string, any> | undefined = (sr as any).meta?.blockDetails

  // 从策略结果构建切片（pipeline 用排名块；mapreduce/agentic 有落回切片则用，否则用佐证兜底）
  let rankedBlocks: any[] = sr.sortedBlocks
  if (rankedBlocks.length === 0) {
    rankedBlocks = sr.evidence.map(e => ({
      id: e.id,
      label: e.label,
      filePath: e.filePath,
      A: e.content,
      p: e.score,
      extension: '',
      entityBoostMultiplier: undefined,
      matchedEntities: undefined,
      hopExpansionCount: undefined,
      communityBoostMultiplier: undefined,
    }))
  }

  // 收集结果
  const slices = []
  let totalScore = 0
  const numToTake = Math.min(searchNum, rankedBlocks.length)
  const answerText = answer?.trim() || ''

  // 统一总分权威来源：pipeline 类策略（相似度/问题增强/文件增强…）返回的 sortedBlocks 是原始
  // block 对象、不携带 p（仅 hybrid/agentic 及佐证兜底分支才在块上附 p），因此从 sr.scores
  // （blockId → 融合总分）取分才是权威；无分时回退块上 p / 0，与 QA 路径 kbRetrieval 同源。
  const totalOf = (b: any): number => {
    const fromScores = sr.scores?.get?.(b?.id)
    if (typeof fromScores === 'number' && !Number.isNaN(fromScores)) return fromScores
    return b?.p || 0
  }

  for (let i = 0; i < numToTake; i++) {
    const block = rankedBlocks[i]
    const sliceContent = block.A || ''
    // 该切片的通道分解分（切片/问题/文件 原始分；无则退回块内字段/0）
    const det = scoreDetailMap?.get(block.id)

    // 命中判定由测试页选项决定：
    //  - hitMode='slice'（默认，切片精准命中）：仅当检索切片正是本问题的关联切片（身份比对）才算命中，忽略答案文本；
    //  - hitMode='text'（答案命中）：按参考答案文本匹配，判定随 matchMode 子策略——precise=精准 / fuzzy=模糊
    const refSliceHit = isReferenceSlice(block, ref)
    const textHit = textSliceHit(sliceContent, answerText)
    const hitModeHit = test.hitMode === 'slice' ? refSliceHit : textHit

    // 可回源（id 存在于 props.blocks）时不保存正文，仅留 id/元数据，大幅降低结果占用；无法回源的合成切片才内联正文
    const canBackRef = !!(block.id && blocksByIdMap.value.has(block.id))
    const overall = totalOf(block)
    slices.push({
      label: block.label,
      content: canBackRef ? '' : sliceContent,
      score: overall,
      extension: block.extension,
      id: block.id,
      filePath: block.filePath,
      isReferenceSlice: refSliceHit,
      containsAnswer: hitModeHit,
      answerText: answerText,
      rank: i + 1,
      detailedScores: {
        fileSummaryScore: det?.fileScore ?? block.fileSummaryScore ?? 0,
        sliceScore: det?.sliceScore ?? block.sliceScore ?? 0,
        questionScore: det?.questionScore ?? block.questionScore ?? 0,
        overallScore: overall,
        // 通道缺失标记（仅当该策略启用了对应增强通道且该切片确实缺失时置位，
        // 供查看模态框提示「无关联问题/无文件摘要 → 切片分兜底」，避免把缺失误读为低分）
        qMissing: (algoCh.qOn && det && det.hasQ === false) ? true : undefined,
        fMissing: (algoCh.fOn && det && det.hasFile === false) ? true : undefined,
        entityBoostMultiplier: block.entityBoostMultiplier,
        matchedEntities: block.matchedEntities,
        hopExpansionCount: block.hopExpansionCount,
        communityBoostMultiplier: block.communityBoostMultiplier
      }
    })
    totalScore += overall
  }

  const avgScore = slices.length > 0 ? totalScore / slices.length : 0

  // 统一按总分（score / overallScore）从高到低稳定排序，并重编位次。
  // 原因：部分策略（多源融合/分组/佐证合并等）返回顺序不保证按总分降序，
  // 若不在此收口排序，表格展示与「位次分析」会与分数不一致（如中间出现更高分）。
  slices.sort((a, b) => (b.score || 0) - (a.score || 0))
  slices.forEach((s, i) => { s.rank = i + 1 })

  return { slices, avgScore, timeMs: Math.round(performance.now() - startTime) }
}


// 执行测试（支持算法选择；ref 为该问题关联切片判定基准）
const performTestChat = async (question: string, searchNum: number, algorithm: SearchAlgorithm, index?: number, answer?: string, ref?: TestCaseRef) => {
  try {
    const { slices, avgScore, timeMs } = await performSearch(question, searchNum, algorithm, answer, ref)
    
    const result: TestResult = {
      question: question,
      answer: answer || '',
      algorithm: algorithm,
      slices: slices,
      avgScore: avgScore,
      recallTimeMs: timeMs,
      ref: hasGoldRef(ref) ? { srcBlockId: ref?.srcBlockId, blockIds: ref?.blockIds || [] } : undefined,
      timestamp: new Date().toISOString(),
      testConfig: {
        searchNum: searchNum,
        summaryWeight: props.model.summaryWeight || 0.7,
        sliceWeight: (1 - (props.model.summaryWeight || 0.7)),
      }
    }
    
    if (index !== undefined) {
      testResults.value[index] = result
    } else {
      testResults.value.push(result)
    }
    
    // 生成位次分析
    generateRankAnalysis(result)
    
    return slices
  } catch (error) {
    console.error('测试聊天失败:', error)
    throw error
  }
}

// 参考答案分段数（按 | 分隔统计，空段不计）
const answerPartCount = (index: number): number => {
  const a = test.answers?.[index]?.trim()
  if (!a) return 0
  return a.split('|').map(s => s.trim()).filter(s => s.length > 0).length
}

// 生成位次分析：判定基准有两类
//  - slice（默认，reasoned/complex 问题）：该问题关联切片(answerBlocks/srcBlockId)是否被检索召回（按切片身份比对）
//  - text（手动/导入等无关联切片问题）：参考答案成分是否出现在检索切片中（文本子串匹配）
// 输出统一写入 RankAnalysisResult（answerParts/totalAnswers/hitRate/matchedAnswers 等字段），下游统计与导出无需感知差异。
const generateRankAnalysis = (result: TestResult) => {
  const ref = result.ref
  const sliceMode = test.hitMode === 'slice'
  // 切片精准命中：仅当该问题有关联切片时按身份比对；无关联切片则无判定基准，不产生位次记录
  const goldMode = sliceMode && hasGoldRef(ref)
  // 答案命中：一律按参考答案文本匹配（忽略关联切片）
  const textMode = !sliceMode
  const answerText = result.answer?.trim()

  // 关联切片基准：解析每个关联切片（id → blocks 中切片 → 展示名与身份键）
  const blocksById = new Map((props.blocks || []).map((b: any) => [b.id, b]))
  const goldRefs = goldMode
    ? (ref?.blockIds || []).map(id => {
        const b = blocksById.get(id)
        return {
          id,
          label: b?.label || id,
          filePath: b?.filePath,
        }
      })
    : []

  // 文本基准成分（参考答案 | 分段；答案命中模式）
  const textParts = (textMode && answerText) ? answerText.split('|').map((s: string) => s.trim()).filter((s: string) => s.length > 0) : []

  // 判定基准成分清单：关联切片模式=关联切片标签；答案命中模式=参考答案分段
  const parts = goldMode ? goldRefs.map(g => g.label) : textParts
  if (parts.length === 0) return

  // 逐检索切片统计命中的基准成分与位次
  const answerRanks: number[] = []
  const hitDetails: Array<{
    rank: number
    matchedAnswers: string[]
    totalAnswers: number
    hitCount: number
    hitRate: number
  }> = []

  for (const slice of result.slices) {
    const matchedAnswers: string[] = []
    if (goldMode) {
      // 切片身份命中：仅与关联切片 blockId 精确比对（同一块），避免同标题多块被误判
      for (const g of goldRefs) {
        if (slice.id && g.id && slice.id === g.id) matchedAnswers.push(g.label)
      }
    } else {
      // 文本成分命中：参考答案按 | 分段逐段比对（忽略大小写），供命中成分/完整率展示
      const sliceContent = sliceTextOf(slice).toLowerCase()
      for (const part of parts) {
        if (sliceContent.includes(part.toLowerCase())) matchedAnswers.push(part)
      }
    }

    // 该切片是否计为一次命中位次：
    //  - 切片命中（goldMode）：按关联切片成分命中（matchedAnswers > 0）
    //  - 答案命中（textMode）：按所选子策略统一判定 textSliceHit——
    //    precise=任一整段完整包含（等价于 matchedAnswers>0）；fuzzy=整段/反向前缀50字/分段/词比例任一命中
    //    （fuzzy 可能整段成分都未完整包含却仍算命中，故不能仅用 matchedAnswers 判断命中位次）
    const isHit = goldMode
      ? matchedAnswers.length > 0
      : textSliceHit(sliceTextOf(slice), answerText || '')

    if (isHit) {
      answerRanks.push(slice.rank)
      hitDetails.push({
        rank: slice.rank,
        matchedAnswers,
        totalAnswers: parts.length,
        hitCount: matchedAnswers.length,
        hitRate: matchedAnswers.length / parts.length
      })
    }
  }

  // 总体命中率：命中的基准成分数 / 成分总数
  const matchedPartSet = new Set<string>()
  for (const slice of result.slices) {
    if (goldMode) {
      for (const g of goldRefs) {
        if (slice.id && g.id && slice.id === g.id) matchedPartSet.add(g.label)
      }
    } else {
      const sliceContent = sliceTextOf(slice).toLowerCase()
      for (const part of parts) {
        if (sliceContent.includes(part.toLowerCase())) matchedPartSet.add(part)
      }
    }
  }
  const overallHitRate = parts.length > 0 ? matchedPartSet.size / parts.length : 0

  const rankAnalysis: RankAnalysisResult = {
    question: result.question,
    answer: result.answer,
    algorithm: result.algorithm,
    ranks: answerRanks.length > 0 ? answerRanks.join(',') : '未找到',
    firstRank: answerRanks.length > 0 ? Math.min(...answerRanks) : -1,
    bestRank: answerRanks.length > 0 ? Math.min(...answerRanks) : -1,
    foundCount: answerRanks.length,
    answerParts: parts,
    refMode: goldMode ? 'slice' : 'text',
    hitRate: overallHitRate,
    hitCount: matchedPartSet.size,
    totalAnswers: parts.length,
    matchedAnswers: Array.from(matchedPartSet),
    hitDetails,
    timestamp: result.timestamp,
    timeMs: result.recallTimeMs || 0
  }

  // 检查是否已存在相同问题和算法的记录
  const existingIndex = rankAnalysisResults.value.findIndex(
    r => r.question === result.question && r.algorithm === result.algorithm
  )

  if (existingIndex !== -1) {
    rankAnalysisResults.value[existingIndex] = rankAnalysis
  } else {
    rankAnalysisResults.value.push(rankAnalysis)
  }
}


// 模糊匹配函数（中文友好）：除 | 整段包含外，还把参考答案按 、 ， 空格等切分为「概念单元」，
// 切片中出现 ≥ threshold 比例的单元即命中——兼容“答案列点分散在切片各列表项/各句中”的表述差异，
// 例如答案「可靠性建模、可靠性分配、可靠性预计」在切片中分散为三行列表项也能命中。
function fuzzyMatch(text: string, search: string, threshold = 0.7): boolean {
  if (!text || !search) return false

  const textLower = text.toLowerCase()
  const searchLower = search.toLowerCase()

  // 1. 整段互含（答案在切片中完整出现，或切片被答案包含）
  if (textLower.includes(searchLower) || searchLower.includes(textLower)) {
    return true
  }

  // 2. | 分段强条件：任一整段完整出现即命中（与精准口径一致，保证 | 场景模糊不劣于精准）
  const segs = searchLower.split('|').map(s => s.trim()).filter(s => s.length > 0)
  if (segs.length > 1) {
    for (const part of segs) {
      if (textLower.includes(part)) return true
    }
  }

  // 3. 概念单元比例：按空白 / 中英文标点 / | 等切分为原子单元，出现在切片中的比例 ≥ threshold
  const units = searchLower
    .split(/[\s,，、;；:：|｜.。!！?？()（）【】"“”'‘’\-—]+/)
    .map(s => s.trim())
    .filter(s => s.length > 1)
  if (units.length > 1) {
    let matchedUnits = 0
    for (const unit of units) {
      if (textLower.includes(unit)) matchedUnits++
    }
    if (matchedUnits / units.length >= threshold) return true
  }

  return false
}

// 单独测试某一行
const runSingleTest = async (index: number) => {
  const question = test.questions[index]?.trim()
  const answer = test.answers && test.answers[index] ? test.answers[index].trim() : ''
  
  if (!question || isJunkQuestion(question)) {
    emit('updateState', store.locales=='zh' ? '请输入有效问题' : 'Please enter a valid question')
    return
  }
  
  try {
    test.questionStatus[index] = {
      text: store.locales=='zh' ? '测试中...' : 'Testing...',
      color: '#FF9800',
      icon: 'fa fa-spinner fa-spin',
      algorithm: test.currentAlgorithm
    }
    
    const searchNum = parseInt(test.searchNum.toString())
    const ref = test.refs?.[index]
    
    await performTestChat(question, searchNum, test.currentAlgorithm, index, answer, ref)
    
    const result = testResults.value[index]
    // 切片精准命中模式下，无关联切片的问题无判定基准（不按分数误判，明确提示）
    const notJudgeable = test.hitMode === 'slice' && !hasGoldRef(test.refs?.[index])
    const hasAnswerMatch = result?.slices?.some((s: any) => s.containsAnswer) || false
    const avgScore = result?.avgScore || 0
    
    let statusText = store.locales=='zh' ? '完成' : 'Completed'
    let statusColor = '#4CAF50'
    let statusIcon = 'fa fa-check-circle'
    
    if (notJudgeable) {
      statusText = store.locales=='zh' ? '无基准' : 'No Ref'
      statusColor = 'var(--borderColor)'
      statusIcon = 'fa fa-minus-circle'
    } else if (hasAnswerMatch) {
      statusText = store.locales=='zh' ? '完成 ✓' : 'Completed ✓'
      statusColor = '#4CAF50'
    } else if (avgScore > 0.7) {
      statusText = store.locales=='zh' ? '完成' : 'Completed'
      statusColor = '#4CAF50'
    } else if (avgScore > 0.4) {
      statusText = store.locales=='zh' ? '完成' : 'Completed'
      statusColor = '#FF9800'
      statusIcon = 'fa fa-exclamation-circle'
    } else {
      statusText = store.locales=='zh' ? '完成' : 'Completed'
      statusColor = '#f44336'
      statusIcon = 'fa fa-times-circle'
    }
    
    test.questionStatus[index] = {
      text: statusText,
      color: statusColor,
      icon: statusIcon,
      time: new Date().toLocaleTimeString(),
      algorithm: test.currentAlgorithm
    }
    
    lastUpdateTime.value = new Date().toLocaleTimeString()
    // 实时刷新策略召回对比：单测完成后该策略出现一行数据
    updateStrategyStats()
    
  } catch (error) {
    console.error('单行测试失败:', error)
    
    test.questionStatus[index] = {
      text: store.locales=='zh' ? '测试失败' : 'Test Failed',
      color: '#f44336',
      icon: 'fa fa-times-circle',
      time: new Date().toLocaleTimeString(),
      algorithm: test.currentAlgorithm
    }
    
    emit('updateState', store.locales=='zh' ? '测试失败: ' : 'Test Failed: ') + (error instanceof Error ? error.message : String(error))
  }
}

// ===== 批量测试面板：预热配置（向量化准备，时间单独计时、不计入检索） =====
const prewarm = reactive({ file: false, entity: false, community: false })
const prewarmTimes = ref<Record<string, number>>({})
const prewarmTotalMs = ref(0)
const prewarmRunning = ref(false)
const prewarmDone = ref(false)

// 预热运行进度：每项状态（待处理/进行中/完成）+ 已处理数量；运行中实时更新
const prewarmItemStates = reactive<Record<string, { status: 'pending' | 'running' | 'done'; index: number; total: number; detail: string }>>({})
const prewarmRunningItemKey = ref('')

interface PrewarmItem { key: 'file' | 'entity' | 'community'; label: string; labelEn: string; icon: string }
const PREWARM_ITEMS: PrewarmItem[] = [
  { key: 'file', label: '文件语义增强（摘要向量）', labelEn: 'File semantic enhance (fileIndex)', icon: 'fa-file-text-o' },
  { key: 'entity', label: '实体向量缓存', labelEn: 'Entity vectorization (cache)', icon: 'fa-cube' },
  { key: 'community', label: '社区报告（预生成报告）', labelEn: 'Community reports (pre-generate)', icon: 'fa-sitemap' },
]

// 可选预热配置：按当前知识库数据状态过滤（对应数据缺失时该项不可选）。
// 全部不可选（length === 0）时，隐藏工具栏预热按钮 / toggle 与批量面板中的预热说明。
const availablePrewarmItems = computed(() => {
  const hasFiles = (props.files?.length || 0) > 0
  const hasEntities = (props.getCurrentOntologyContext?.()?.entities?.length || 0) > 0
  const hasCommunity = (props.communityResult?.count || 0) > 0 || (props.communityReports?.length || 0) > 0
  return PREWARM_ITEMS.filter(item => {
    if (item.key === 'file' && !hasFiles) return false
    if (item.key === 'entity' && !hasEntities) return false
    if (item.key === 'community' && !hasCommunity) return false
    return true
  })
})

// 已勾选且可选的预热项（预热实际执行的顺序）
const prewarmEnabledItems = computed(() => availablePrewarmItems.value.filter(item => prewarm[item.key]))

// 预热单项进度百分比（0-100，无总量时返回 0）
const prewarmPct = (key: string): number => {
  const st = prewarmItemStates[key]
  if (!st || st.total <= 0) return 0
  return Math.min(100, Math.round((st.index / st.total) * 100))
}

// 执行预热：按勾选项目执行向量化准备，每项单独计时，不计入后续检索时间
const runPrewarm = async () => {
  if (prewarmRunning.value) return
  const items = prewarmEnabledItems.value
  if (items.length === 0) {
    emit('updateState', store.locales=='zh' ? '请先勾选需要预热的项目' : 'Check at least one pre-warm item first')
    return
  }
  prewarmRunning.value = true
  // 初始化每项进度状态
  for (const item of PREWARM_ITEMS) {
    prewarmItemStates[item.key] = { status: 'pending', index: 0, total: 0, detail: '' }
  }
  prewarmRunningItemKey.value = ''
  allTestProgressText.value = store.locales=='zh' ? '预热中（向量化准备，不计入检索时间）...' : 'Pre-warming (index vectorization, not counted into retrieval)...'
  const times: Record<string, number> = {}
  const started = performance.now()
  const ingestServices = kbAi.buildIngestionServices(kbSpec())
  const embedFn = async (text: string) => ingestServices.embed(text)
  const streamChatFn = async (messages: any[], onChunk: (c: string) => void) =>
    ingestServices.streamChat(messages, onChunk)
  // 标记当前处理项；原语 onProgress 回调更新该项的 index/total/detail
  const onItemProgress = (key: string) => (msg: string) => {
    const st = prewarmItemStates[key]
    if (!st) return
    const m = msg.match(/(\d+)\s*\/\s*(\d+)/)
    if (m) { st.index = +m[1]; st.total = +m[2] }
    st.detail = msg
  }

  try {
    for (const item of items) {
      const key = item.key
      const t0 = performance.now()
      prewarmRunningItemKey.value = key
      prewarmItemStates[key].status = 'running'
      try {
        if (key === 'file') {
          const ctx: IngestionContext = {
            blocks: props.blocks as any,
            config: { url: props.model.url, embed: props.model.embed, chat: props.model.chat, process: props.model.process, processPrompt: props.model.processPrompt, think: props.model.think },
            services: { embed: embedFn, streamChat: streamChatFn },
            fileIndex: props.fileIndex as any,
            onProgress: onItemProgress(key),
            isCancelled: () => false,
          }
          const fsRaw = await INGESTION_PRIMITIVES.summarize_file(ctx, { reuseExistingSummary: true })
          const fs = fsRaw as { processed: number; failed: number; skipped?: number }
          const st = prewarmItemStates.file
          if (st) st.detail = `文件摘要: 复用 ${fs.skipped ?? 0} / 新增 ${fs.processed} / 失败 ${fs.failed}`
        } else if (key === 'entity') {
          const entities = props.getCurrentOntologyContext?.()?.entities || []
          const total = entities.length
          let done = 0
          // prewarmEntityVectors 无回调，包装 embed 逐实体计数
          const entityEmbed = async (text: string) => {
            const v = await embedFn(text)
            done++
            const st = prewarmItemStates.entity
            if (st) { st.index = done; st.total = total; st.detail = `实体向量化: ${done}/${total}` }
            return v
          }
          await prewarmEntityVectors(entities, entityEmbed)
        } else if (key === 'community') {
          // ensureCommunityReports 无逐条进度，给出提示（父组件底部状态栏会显示报告进度）
          prewarmItemStates.community.detail = store.locales=='zh' ? '社区报告生成中（进度见底部状态栏）' : 'Generating community reports (see status bar)'
          if (props.ensureCommunityReports) await props.ensureCommunityReports()
        }
      } catch (e) { console.error(`预热-${key}失败:`, e) }
      prewarmItemStates[key].status = 'done'
      times[key] = performance.now() - t0
    }
  } finally {
    prewarmTimes.value = times
    prewarmTotalMs.value = performance.now() - started
    prewarmDone.value = true
    prewarmRunning.value = false
    prewarmRunningItemKey.value = ''
    allTestProgressText.value = ''
  }
}

// 按「被测策略对应的处理管线」做就绪处理：pipeline 含 file_score（文件通道）时，自动对文件自带摘要向量化
// （仅 embed、不调用 LLM 生成）。本体 / 社区 / 问题向量等较重管线由父级建库时实施，这里不做隐式生成模型调用。
let _fileWarmFailed = false
const ensureStrategyChannelsReady = async (algoIds?: string[]) => {
  const fileMap = props.fileIndex as any
  if (fileMap && fileMap.size > 0) return // 已就绪：永不需补齐
  // 仅当「本次要测试的策略」本身用到 file_score 才自动补齐文件摘要，
  // 避免单测相似度等纯切片策略也被其它启用策略（文件增强/本体/多跳）的文件依赖误触发生成摘要
  const defs = (algoIds && algoIds.length)
    ? getEnabledStrategies().filter(d => algoIds.includes(d.id))
    : getEnabledStrategies()
  const needFile = defs.some((def: any) =>
    (def?.steps || []).some((s: any) => s?.primitive === 'file_score'))
  if (!needFile) return
  if (_fileWarmFailed) return // 已尝试补齐但失败，本次会话不再重复打扰
  _fileWarmFailed = true
  // 文件本身自带摘要（markdown frontmatter / attributes）→ 不调用 LLM 重新生成，仅收集已有摘要文本待向量化
  const targets: Array<{ path: string; text: string }> = []
  const seenPaths = new Set<string>()
  for (const f of props.files || []) {
    if (!f?.path || seenPaths.has(f.path)) continue
    const text = getFileSummaryText(f)
    if (text) { seenPaths.add(f.path); targets.push({ path: f.path, text }) }
  }
  if (targets.length === 0) return // 库中无自带摘要的文件 → 无可向量化内容
  prewarmRunning.value = true
  prewarmRunningItemKey.value = 'file'
  prewarmItemStates.file = { status: 'running', index: 0, total: targets.length, detail: '' }
  // 提示走底部状态栏（updateLiveState），便于跨视图看到文件摘要向量化的进度
  emit('updateLiveState', store.locales=='zh'
    ? `文件摘要向量化（文件增强通道）0/${targets.length}`
    : `Vectorizing file summaries (file-enhance) 0/${targets.length}`)
  try {
    const ingestServices = kbAi.buildIngestionServices(kbSpec())
    let done = 0
    for (const t of targets) {
      try {
        const vector = await ingestServices.embed(t.text)
        fileMap.set(t.path, { content: t.text, vector, contentHash: `fs:${t.path}:${t.text.length}` })
      } catch (e) {
        console.error(`文件摘要向量化失败: ${t.path}`, e)
      }
      done++
      const st = prewarmItemStates.file
      if (st) { st.index = done; st.total = targets.length; st.detail = `文件摘要向量化: ${done}/${targets.length}` }
      emit('updateLiveState', store.locales=='zh'
        ? `文件摘要向量化: ${done}/${targets.length}`
        : `Vectorizing file summaries: ${done}/${targets.length}`)
    }
    const st = prewarmItemStates.file
    if (st) st.detail = `文件摘要向量化完成: ${done}/${targets.length}`
  } catch (e) {
    console.error('自动向量化文件摘要失败（文件增强将退化为纯切片）：', e)
  } finally {
    prewarmRunning.value = false
    prewarmRunningItemKey.value = ''
    if (prewarmItemStates.file) prewarmItemStates.file.status = 'done'
    emit('updateLiveState', '')
  }
}

// 运行计时（批量测试）：已用时间 + 预计剩余时间（进度百分比由 test.progress 提供）
const testStartedAt = ref(0)
const nowMs = ref(0)
let clockTimer: any = null
const startTestClock = () => {
  testStartedAt.value = Date.now()
  nowMs.value = testStartedAt.value
  if (clockTimer) clearInterval(clockTimer)
  clockTimer = setInterval(() => { nowMs.value = Date.now() }, 1000)
}
const stopTestClock = () => {
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null }
}
const fmtClock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const p2 = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p2(m)}:${p2(ss)}` : `${p2(m)}:${p2(ss)}`
}
// 已用时间
const elapsedText = computed(() => (testStartedAt.value && test.isRunning) ? fmtClock(nowMs.value - testStartedAt.value) : '')
// 预计剩余：按 已用时间 / 已完成进度 推算剩余
const etaText = computed(() => {
  if (!testStartedAt.value || !test.isRunning) return ''
  const p = Number(test.progress) / 100
  const el = nowMs.value - testStartedAt.value
  if (!(p > 0) || el <= 0) return '-'
  return fmtClock((el / p) * (1 - p))
})
// 运行结束自动停止计时并清零
watch(() => test.isRunning, (v) => { if (!v) { stopTestClock(); testStartedAt.value = 0 } })

// 批量测试（使用当前算法）
const runBatchTest = async () => {
  const validQuestions = test.questions.filter((q, i) => q && q.trim())
  if (validQuestions.length === 0) {
    emit('updateState', store.locales=='zh' ? '请输入至少一个有效问题' : 'Please enter at least one valid question')
    return
  }
  
  test.isRunning = true
  test.progress = 0
  startTestClock()
  
  initFileSummaries()
  
  // 单策略批量：只实施当前策略对应的处理管线（下方 ensure 自动向量化文件自带摘要），不按勾选全库预热，
  // 避免单测相似度等纯切片策略也触发无关的预热 / LLM 生成
  // 跨策略聚合：在测试结果页换策略反复批量时，保留其它策略的位次/统计（批量面板汇总对比多行），
  // 仅清当前策略旧记录（同策略重测 = 替换为新结果）；testResults 为按问题覆盖的最新一次展示，无累积
  rankAnalysisResults.value = rankAnalysisResults.value.filter(r => r.algorithm !== test.currentAlgorithm)
  allStrategySliceResults.value = allStrategySliceResults.value.filter(row => row.strategyId !== test.currentAlgorithm)

  // 仅当本次被测策略需要 file 通道时，自动对文件自带摘要向量化补齐（幂等、失败不阻断）
  await ensureStrategyChannelsReady([test.currentAlgorithm])
  
  for (let i = 0; i < test.questions.length; i++) {
    const question = test.questions[i]?.trim()
    const answer = test.answers && test.answers[i] ? test.answers[i].trim() : ''
    
    if (!question || isJunkQuestion(question)) {
      test.questionStatus[i] = {
        text: store.locales=='zh' ? '未测试' : 'Not Tested',
        color: 'var(--borderColor)',
        icon: 'fa fa-circle-o'
      }
      test.progress = ((i + 1) / test.questions.length) * 100
      continue
    }
    
    try {
      test.questionStatus[i] = {
        text: store.locales=='zh' ? '测试中...' : 'Testing...',
        color: '#FF9800',
        icon: 'fa fa-spinner fa-spin',
        algorithm: test.currentAlgorithm
      }
      
      const searchNum = parseInt(test.searchNum.toString())
      
      const slices = (await performTestChat(question, searchNum, test.currentAlgorithm, i, answer, test.refs?.[i])) || []
      // 累积当前策略×问题切片明细（供批量面板「导出全部测试数据」跨策略聚合；同策略重测已在上方过滤旧行）
      allStrategySliceResults.value.push({
        strategyId: test.currentAlgorithm,
        label: getAlgorithmLabel(test.currentAlgorithm),
        question,
        answer,
        avgScore: slices.length > 0 ? slices.reduce((s: number, x: any) => s + (x.score || 0), 0) / slices.length : 0,
        timestamp: new Date().toISOString(),
        slices
      })
      
      const result = testResults.value[i]
      // 切片精准命中模式下，无关联切片的问题无判定基准（不按分数误判，明确提示）
      const notJudgeable = test.hitMode === 'slice' && !hasGoldRef(test.refs?.[i])
      const hasAnswerMatch = result?.slices?.some((s: any) => s.containsAnswer) || false
      const avgScore = result?.avgScore || 0
      
      let statusText = store.locales=='zh' ? '完成' : 'Completed'
      let statusColor = '#4CAF50'
      let statusIcon = 'fa fa-check-circle'
      
      if (notJudgeable) {
        statusText = store.locales=='zh' ? '无基准' : 'No Ref'
        statusColor = 'var(--borderColor)'
        statusIcon = 'fa fa-minus-circle'
      } else if (hasAnswerMatch) {
        statusText = store.locales=='zh' ? '完成 ✓' : 'Completed ✓'
        statusColor = '#4CAF50'
      } else if (avgScore > 0.7) {
        statusText = store.locales=='zh' ? '完成' : 'Completed'
        statusColor = '#4CAF50'
      } else if (avgScore > 0.4) {
        statusText = store.locales=='zh' ? '完成' : 'Completed'
        statusColor = '#FF9800'
        statusIcon = 'fa fa-exclamation-circle'
      } else {
        statusText = store.locales=='zh' ? '完成' : 'Completed'
        statusColor = '#f44336'
        statusIcon = 'fa fa-times-circle'
      }
      
      test.questionStatus[i] = {
        text: statusText,
        color: statusColor,
        icon: statusIcon,
        time: new Date().toLocaleTimeString(),
        algorithm: test.currentAlgorithm
      }
      
    } catch (error) {
      console.error(store.locales=='zh' ? '第 ' : 'Row ' + (i + 1) + (store.locales=='zh' ? ' 行测试失败:' : ' test failed:'), error)
      
      test.questionStatus[i] = {
        text: store.locales=='zh' ? '测试失败' : 'Test Failed',
        color: '#f44336',
        icon: 'fa fa-times-circle',
        time: new Date().toLocaleTimeString(),
        algorithm: test.currentAlgorithm
      }
    }
    
    test.progress = ((i + 1) / test.questions.length) * 100
  }
  
  test.isRunning = false
  lastUpdateTime.value = new Date().toLocaleTimeString()
  // 实时刷新策略召回对比：批测单个策略完成后该策略出现一行数据
  updateStrategyStats()
  
  const answerMatches = testResults.value.reduce((count, result) => {
    if (!result || !result.slices) return count
    return count + result.slices.filter((s: any) => s.containsAnswer).length
  }, 0)
  
  const doneCount = testResults.value.filter(Boolean).length
  if (store.locales=='zh') {
    emit('updateState', `批量测试完成：共处理 ${doneCount} 个问题，${answerMatches} 个切片命中基准（关联切片 / 参考答案）`)
  } else {
    emit('updateState', `Batch test completed: ${doneCount} questions processed, ${answerMatches} slices hit the reference (linked slices / answer text)`)
  }
}

// ==================== 批量测试所有策略的召回准确率 ====================

// 各策略的召回对比统计（含 Hit@1 / MRR / 完整率，以及单切片/复合分组）
interface StrategyGroupStat {
  testedCount: number
  hitCount: number
  recallRate: number
  avgHitRate: number
  hitAt1: number
  mrr: number
  completeRate: number
  avgFirstRank: number
}
const allStrategyStats = ref<Array<{
  strategyId: string
  label: string
  testedCount: number
  hitCount: number
  recallRate: number
  avgHitRate: number
  avgFirstRank: number
  avgTimeMs: number
  hitAt1: number
  mrr: number
  completeRate: number
  groups: { single: StrategyGroupStat, complex: StrategyGroupStat }
}>>([])

// 分组统计视图：全部 / 单切片 / 复合
const statsGroup = ref<'all' | 'single' | 'complex'>('all')
const displayStats = computed(() => {
  return allStrategyStats.value.map(s => {
    if (statsGroup.value === 'all') return s
    const g = statsGroup.value === 'single' ? s.groups.single : s.groups.complex
    return {
      strategyId: s.strategyId,
      label: s.label,
      testedCount: g.testedCount,
      hitCount: g.hitCount,
      recallRate: g.recallRate,
      avgHitRate: g.avgHitRate,
      avgFirstRank: g.avgFirstRank,
      avgTimeMs: s.avgTimeMs,
      hitAt1: g.hitAt1,
      mrr: g.mrr,
      completeRate: g.completeRate,
      groups: s.groups,
    }
  })
})

// 批量测试所有策略时累积的完整切片明细（策略 × 问题 × 切片），供「导出全部测试数据」使用
const allStrategySliceResults = ref<Array<{
  strategyId: string
  label: string
  question: string
  answer: string
  avgScore: number
  timestamp: string
  slices: TestResult['slices']
}>>([])

// 批量测试所有策略时的当前进度文本（策略 + 问题序号）
const allTestProgressText = ref('')

// 展开查看位次明细的策略 id（点击汇总行切换）
const expandedStrategy = ref('')
const expandedStrategyLabel = computed(() =>
  allStrategyStats.value.find(s => s.strategyId === expandedStrategy.value)?.label || expandedStrategy.value)
const strategyDetailRows = computed(() =>
  rankAnalysisResults.value.filter(r => r.algorithm === expandedStrategy.value))
const toggleStrategyDetail = (id: string) => {
  expandedStrategy.value = expandedStrategy.value === id ? '' : id
}

// 召回完整性：成分命中数（x/y）与徽标（完整/部分/缺失）。
// 对复合问题（参考答案含多个 | 成分）而言：hitRate=1 需全部成分所在的切片都被检索到 = 召回完整。
const completenessBadge = (r: any) => {
  const parts = Array.isArray(r?.answerParts) ? r.answerParts.length : 0
  const hit = parts > 0 ? Math.round((r.hitRate || 0) * parts) : (r.foundCount > 0 ? 1 : 0)
  const base = store.locales=='zh'
  if (parts <= 1) {
    return hit >= 1
      ? { label: base ? '命中' : 'Hit', color: '#4CAF50', text: `${hit}/${parts || 1}` }
      : { label: base ? '缺失' : 'Miss', color: '#f44336', text: `${hit}/${parts || 1}` }
  }
  if (hit >= parts) return { label: base ? '完整' : 'Complete', color: '#4CAF50', text: `${hit}/${parts}` }
  if (hit > 0) return { label: base ? '部分' : 'Partial', color: '#FF9800', text: `${hit}/${parts}` }
  return { label: base ? '缺失' : 'Miss', color: '#f44336', text: `${hit}/${parts}` }
}

// 从位次分析记录实时聚合各策略召回统计（供「策略召回对比」使用）
// 单测/批测单个策略后调用，即可让该策略以一行数据出现在对比中
const updateStrategyStats = () => {
  // 每组累加器（single/complex 分组）
  const mkGroup = () => ({
    testedCount: 0, hitCount: 0, sumHitRate: 0, sumFirstRank: 0,
    rankCount: 0, hit1Count: 0, sumMRR: 0, completeCount: 0,
  })
  const agg = new Map<string, {
    strategyId: string
    label: string
    testedCount: number
    hitCount: number
    sumHitRate: number
    sumFirstRank: number
    sumTimeMs: number
    rankCount: number
    hit1Count: number
    sumMRR: number
    completeCount: number
    single: ReturnType<typeof mkGroup>
    complex: ReturnType<typeof mkGroup>
  }>()
  for (const r of rankAnalysisResults.value) {
    const key = r.algorithm
    const cur = agg.get(key) || {
      strategyId: key,
      label: getAlgorithmLabel(key),
      testedCount: 0, hitCount: 0, sumHitRate: 0, sumFirstRank: 0,
      sumTimeMs: 0, rankCount: 0, hit1Count: 0, sumMRR: 0, completeCount: 0,
      single: mkGroup(), complex: mkGroup(),
    }
    // 复合问题 = 参考答案含多个 | 成分（须综合多切片）
    const isComplex = Array.isArray(r.answerParts) && r.answerParts.length > 1
    const g = isComplex ? cur.complex : cur.single
    cur.testedCount++; g.testedCount++
    if (r.foundCount > 0) { cur.hitCount++; g.hitCount++ }
    const hr = r.hitRate || 0
    cur.sumHitRate += hr; g.sumHitRate += hr
    cur.sumTimeMs += r.timeMs || 0
    if (r.firstRank > 0) {
      const rr = 1 / r.firstRank
      cur.sumFirstRank += r.firstRank; cur.rankCount++
      g.sumFirstRank += r.firstRank; g.rankCount++
      if (r.firstRank === 1) { cur.hit1Count++; g.hit1Count++ }
      cur.sumMRR += rr; g.sumMRR += rr
    }
    if (hr >= 1) { cur.completeCount++; g.completeCount++ }
    agg.set(key, cur)
  }
  const fmt = (a: any) => {
    const st = (g: any): StrategyGroupStat => ({
      testedCount: g.testedCount,
      hitCount: g.hitCount,
      recallRate: g.testedCount > 0 ? g.hitCount / g.testedCount : 0,
      avgHitRate: g.testedCount > 0 ? g.sumHitRate / g.testedCount : 0,
      hitAt1: g.testedCount > 0 ? g.hit1Count / g.testedCount : 0,
      mrr: g.testedCount > 0 ? g.sumMRR / g.testedCount : 0,
      completeRate: g.testedCount > 0 ? g.completeCount / g.testedCount : 0,
      avgFirstRank: g.rankCount > 0 ? g.sumFirstRank / g.rankCount : -1,
    })
    return {
      strategyId: a.strategyId,
      label: a.label,
      testedCount: a.testedCount,
      hitCount: a.hitCount,
      recallRate: a.testedCount > 0 ? a.hitCount / a.testedCount : 0,
      avgHitRate: a.testedCount > 0 ? a.sumHitRate / a.testedCount : 0,
      avgFirstRank: a.rankCount > 0 ? a.sumFirstRank / a.rankCount : -1,
      avgTimeMs: a.testedCount > 0 ? a.sumTimeMs / a.testedCount : 0,
      hitAt1: a.testedCount > 0 ? a.hit1Count / a.testedCount : 0,
      mrr: a.testedCount > 0 ? a.sumMRR / a.testedCount : 0,
      completeRate: a.testedCount > 0 ? a.completeCount / a.testedCount : 0,
      groups: { single: st(a.single), complex: st(a.complex) },
    }
  }
  allStrategyStats.value = Array.from(agg.values()).map(fmt).sort((a, b) => {
    // 冠军判定：先比召回率（高者胜）；相同再比平均位次（小者胜，-1=无命中视为最差）；仍相同比平均答案命中率（高者胜）
    if (b.recallRate !== a.recallRate) return b.recallRate - a.recallRate
    const ra = a.avgFirstRank > 0 ? a.avgFirstRank : Number.MAX_VALUE
    const rb = b.avgFirstRank > 0 ? b.avgFirstRank : Number.MAX_VALUE
    if (ra !== rb) return ra - rb
    return b.avgHitRate - a.avgHitRate
  })
}

// 批量测试所有检索策略：每个策略跑一遍全部问题，统计召回准确率
const runAllStrategyTest = async () => {
  // 可测条件：答案命中=需参考答案文本；切片精准命中=需关联切片基准或参考答案文本（无基准问题仅检索、不计命中）
  const sliceMode = test.hitMode === 'slice'
  const hasTestable = test.questions.some((q, i) => q && q.trim() && (
    sliceMode ? (hasGoldRef(test.refs?.[i]) || !!test.answers?.[i]?.trim()) : !!test.answers?.[i]?.trim()
  ))
  if (!hasTestable) {
    emit('updateState', store.locales=='zh'
      ? (sliceMode ? '请至少输入一个带关联切片或参考答案的问题' : '请至少输入一个带参考答案的问题')
      : (sliceMode ? 'Please enter at least one question with linked slices or a reference answer' : 'Please enter at least one question with a reference answer'))
    return
  }

  test.isRunning = true
  test.progress = 0
  startTestClock()
  initFileSummaries()

  // 全部启用策略对应管线就绪（当前自动覆盖：文件自带摘要向量化；本体/社区/Q 由父级建库管线提供）
  await ensureStrategyChannelsReady()

  // 已配置预热且未执行 → 先预热（时间单独计时，不计入检索时间）
  if (!prewarmDone.value && (prewarm.file || prewarm.entity || prewarm.community)) {
    await runPrewarm()
  }

  const strategies = algorithmOptions.value
  const searchNum = parseInt(test.searchNum.toString())
  const rows = test.questions.map((q, i) => ({ question: q?.trim(), answer: test.answers?.[i]?.trim() || '' }))
  const totalRuns = strategies.length * rows.length
  let done = 0

  // 新一次「全部策略」测试：自动清空上一次结果/位次/统计，只保留本次
  clearJudgementResults()

  let firstStrategyDone = false
  for (const algo of strategies) {
    for (let i = 0; i < rows.length; i++) {
      const { question, answer } = rows[i]
      if (!question || isJunkQuestion(question)) { done++; continue }
      allTestProgressText.value = store.locales=='zh'
        ? `策略「${algo.label}」· ${i + 1}/${rows.length}`
        : `Strategy "${algo.label}" · ${i + 1}/${rows.length}`
      let slices: TestResult['slices'] = []
      try {
        test.questionStatus[i] = {
          text: store.locales=='zh' ? `测试中 [${algo.label}]...` : `Testing [${algo.label}]...`,
          color: '#FF9800', icon: 'fa fa-spinner fa-spin', algorithm: algo.value
        }
        slices = await performTestChat(question, searchNum, algo.value, i, answer, test.refs?.[i]) || []
      } catch (error) {
        console.error(`策略 ${algo.value} 问题 ${i + 1} 测试失败:`, error)
      }
      // 累积该策略×问题的切片明细（只存 id/元数据，正文按 id 回源；直接引用返回数组，不再深拷贝）
      allStrategySliceResults.value.push({
        strategyId: algo.value,
        label: algo.label,
        question,
        answer,
        avgScore: slices.length > 0 ? slices.reduce((s, x) => s + (x.score || 0), 0) / slices.length : 0,
        timestamp: new Date().toISOString(),
        slices
      })
      done++
      test.progress = Math.round((done / totalRuns) * 100)
    }
    // 每测完一个策略，立即刷新「策略召回对比」，让该策略数据实时可见
    updateStrategyStats()
    if (!firstStrategyDone) {
      firstStrategyDone = true
      activeTab.value = 'batch'
    }
  }

  // 聚合每个策略的召回统计（与单测/批测共用同一聚合逻辑）
  updateStrategyStats()
  expandedStrategy.value = ''
  activeTab.value = 'batch'

  test.isRunning = false
  allTestProgressText.value = ''
  lastUpdateTime.value = new Date().toLocaleTimeString()

  const best = allStrategyStats.value[0]
  emit('updateState', store.locales=='zh'
    ? `全部策略测试完成：共 ${allStrategyStats.value.length} 个策略，最优「${best?.label}」召回 ${best ? (best.recallRate*100).toFixed(1) : 0}%`
    : `All strategies tested: ${allStrategyStats.value.length} strategies, best "${best?.label}" recall ${best ? (best.recallRate*100).toFixed(1) : 0}%`)
}

// 导出策略召回对比到 Excel（汇总 + 明细两个工作表）
const exportAllStrategyStats = async () => {
  if (allStrategyStats.value.length === 0) {
    emit('updateState', store.locales=='zh' ? '请先运行「批量测试所有策略」' : 'Run "Test All Strategies" first')
    return
  }
  isExporting.value = true
  try {
    // 汇总表（按 策略 × 分组 展开：全部 / 单切片 / 复合，便于论文分组对比）
    const summary: any[][] = [
      ['策略', '策略ID', '分组', '测试问题数', '命中问题数', '召回率', '答案命中率', 'Hit@1', 'MRR', '完整率', '平均位次', '平均时间(ms)']
    ]
    for (const s of allStrategyStats.value) {
      const groups: Array<{ key: string, g: any }> = [
        { key: store.locales=='zh' ? '全部' : 'All', g: { testedCount: s.testedCount, hitCount: s.hitCount, recallRate: s.recallRate, avgHitRate: s.avgHitRate, hitAt1: s.hitAt1, mrr: s.mrr, completeRate: s.completeRate, avgFirstRank: s.avgFirstRank } },
        { key: store.locales=='zh' ? '单切片' : 'Single', g: s.groups.single },
        { key: store.locales=='zh' ? '复合' : 'Complex', g: s.groups.complex },
      ]
      for (const { key, g } of groups) {
        summary.push([
          s.label,
          s.strategyId,
          key,
          g.testedCount,
          g.hitCount,
          g.testedCount > 0 ? (g.recallRate * 100).toFixed(1) + '%' : '-',
          g.testedCount > 0 ? (g.avgHitRate * 100).toFixed(1) + '%' : '-',
          g.testedCount > 0 ? (g.hitAt1 * 100).toFixed(1) + '%' : '-',
          g.testedCount > 0 ? g.mrr.toFixed(3) : '-',
          g.testedCount > 0 ? (g.completeRate * 100).toFixed(1) + '%' : '-',
          g.avgFirstRank > 0 ? g.avgFirstRank.toFixed(1) : '-',
          s.avgTimeMs > 0 ? Math.round(s.avgTimeMs) : '-'
        ])
      }
    }

    // 明细表
    const detail: any[][] = [
      ['策略', '策略ID', '问题', '参考答案', '是否命中', '答案命中率', '最优位次', '命中切片数', '召回时间(ms)']
    ]
    const sorted = [...rankAnalysisResults.value].sort((a, b) =>
      a.algorithm.localeCompare(b.algorithm) || a.question.localeCompare(b.question))
    for (const r of sorted) {
      detail.push([
        algorithmOptions.value.find(a => a.value === r.algorithm)?.label || r.algorithm,
        r.algorithm,
        r.question,
        r.answer,
        r.foundCount > 0 ? '是' : '否',
        ((r.hitRate || 0) * 100).toFixed(1) + '%',
        r.firstRank > 0 ? r.firstRank : '-',
        r.foundCount,
        r.timeMs ? Math.round(r.timeMs) : '-'
      ])
    }

    const ws1 = XLSX.utils.aoa_to_sheet(summary)
    ws1['!cols'] = [{ wch: 18 }, { wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 }]
    const ws2 = XLSX.utils.aoa_to_sheet(detail)
    ws2['!cols'] = [{ wch: 16 }, { wch: 14 }, { wch: 40 }, { wch: 30 }, { wch: 10 }, { wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 12 }]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws1, '策略召回对比')
    XLSX.utils.book_append_sheet(wb, ws2, '明细')

    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-')
    XLSX.writeFile(wb, `strategy_recall_${timestamp}.xlsx`)
    emit('updateState', store.locales=='zh' ? '策略召回对比导出成功' : 'Strategy recall comparison exported')
  } catch (error) {
    console.error('导出策略召回失败:', error)
    emit('updateState', store.locales=='zh' ? '导出失败' : 'Export failed')
  } finally {
    isExporting.value = false
  }
}

// 导出全部测试数据到 Excel（策略召回对比汇总 + 位次明细 + 切片明细 三个工作表）
const exportAllTestData = async () => {
  if (allStrategyStats.value.length === 0 && rankAnalysisResults.value.length === 0 && allStrategySliceResults.value.length === 0) {
    emit('updateState', store.locales=='zh' ? '暂无测试数据，请先运行测试' : 'No test data yet, run tests first')
    return
  }
  isExporting.value = true
  try {
    // 表1：策略召回对比汇总（按 策略 × 分组 展开：全部 / 单切片 / 复合）
    const summary: any[][] = [
      ['策略', '策略ID', '分组', '测试问题数', '命中问题数', '召回率', '答案命中率', 'Hit@1', 'MRR', '完整率', '平均位次', '平均时间(ms)']
    ]
    for (const s of allStrategyStats.value) {
      const groups: Array<{ key: string, g: any }> = [
        { key: store.locales=='zh' ? '全部' : 'All', g: { testedCount: s.testedCount, hitCount: s.hitCount, recallRate: s.recallRate, avgHitRate: s.avgHitRate, hitAt1: s.hitAt1, mrr: s.mrr, completeRate: s.completeRate, avgFirstRank: s.avgFirstRank } },
        { key: store.locales=='zh' ? '单切片' : 'Single', g: s.groups.single },
        { key: store.locales=='zh' ? '复合' : 'Complex', g: s.groups.complex },
      ]
      for (const { key, g } of groups) {
        summary.push([
          s.label,
          s.strategyId,
          key,
          g.testedCount,
          g.hitCount,
          g.testedCount > 0 ? (g.recallRate * 100).toFixed(1) + '%' : '-',
          g.testedCount > 0 ? (g.avgHitRate * 100).toFixed(1) + '%' : '-',
          g.testedCount > 0 ? (g.hitAt1 * 100).toFixed(1) + '%' : '-',
          g.testedCount > 0 ? g.mrr.toFixed(3) : '-',
          g.testedCount > 0 ? (g.completeRate * 100).toFixed(1) + '%' : '-',
          g.avgFirstRank > 0 ? g.avgFirstRank.toFixed(1) : '-',
          s.avgTimeMs > 0 ? Math.round(s.avgTimeMs) : '-'
        ])
      }
    }

    // 表2：位次明细
    const detail: any[][] = [
      ['策略', '策略ID', '问题', '参考答案', '是否命中', '答案命中率', '最优位次', '命中切片数', '召回时间(ms)']
    ]
    const sorted = [...rankAnalysisResults.value].sort((a, b) =>
      a.algorithm.localeCompare(b.algorithm) || a.question.localeCompare(b.question))
    for (const r of sorted) {
      detail.push([
        algorithmOptions.value.find(a => a.value === r.algorithm)?.label || r.algorithm,
        r.algorithm,
        r.question,
        r.answer,
        r.foundCount > 0 ? '是' : '否',
        ((r.hitRate || 0) * 100).toFixed(1) + '%',
        r.firstRank > 0 ? r.firstRank : '-',
        r.foundCount,
        r.timeMs ? Math.round(r.timeMs) : '-'
      ])
    }

    // 表3：切片明细（每个策略×问题的每个切片一行）
    const sliceSheet: any[][] = [
      ['策略', '策略ID', '问题', '参考答案', '平均分', '切片位次', '切片文件', '切片内容', '切片分', '文件摘要分', '总分', '实体增强乘数', '多跳扩展数', '匹配实体', '命中基准']
    ]
    const sortedSlices = [...allStrategySliceResults.value].sort((a, b) =>
      a.strategyId.localeCompare(b.strategyId) || a.question.localeCompare(b.question))
    for (const row of sortedSlices) {
      if (row.slices.length === 0) {
        sliceSheet.push([row.label, row.strategyId, row.question, row.answer, row.avgScore.toFixed(4), '无结果', '', '', '', '', '', '', '', '', '否'])
        continue
      }
      for (const slice of row.slices) {
        sliceSheet.push([
          row.label,
          row.strategyId,
          row.question,
          row.answer,
          row.avgScore.toFixed(4),
          slice.rank,
          slice.label,
          sliceTextOf(slice).substring(0, 500),
          (slice.score || 0).toFixed(4),
          slice.detailedScores?.fileSummaryScore?.toFixed(4) || '',
          slice.detailedScores?.overallScore?.toFixed(4) || '',
          slice.detailedScores?.entityBoostMultiplier?.toFixed(2) || '',
          slice.detailedScores?.hopExpansionCount || '',
          (slice.detailedScores?.matchedEntities || []).join(', '),
          slice.containsAnswer ? '是' : '否'
        ])
      }
    }

    const ws1 = XLSX.utils.aoa_to_sheet(summary)
    ws1['!cols'] = [{ wch: 18 }, { wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 }]
    const ws2 = XLSX.utils.aoa_to_sheet(detail)
    ws2['!cols'] = [{ wch: 16 }, { wch: 14 }, { wch: 40 }, { wch: 30 }, { wch: 10 }, { wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 12 }]
    const ws3 = XLSX.utils.aoa_to_sheet(sliceSheet)
    ws3['!cols'] = [{ wch: 16 }, { wch: 14 }, { wch: 40 }, { wch: 30 }, { wch: 10 }, { wch: 8 }, { wch: 20 }, { wch: 50 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 20 }, { wch: 12 }]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws1, '策略召回对比')
    XLSX.utils.book_append_sheet(wb, ws2, '位次明细')
    XLSX.utils.book_append_sheet(wb, ws3, '切片明细')

    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-')
    XLSX.writeFile(wb, `strategy_test_all_${timestamp}.xlsx`)
    emit('updateState', store.locales=='zh' ? '全部测试数据导出成功' : 'All test data exported')
  } catch (error) {
    console.error('导出全部测试数据失败:', error)
    emit('updateState', store.locales=='zh' ? '导出失败' : 'Export failed')
  } finally {
    isExporting.value = false
  }
}

// 初始化文件摘要信息
const initFileSummaries = () => {
  if (!props.files || props.files.length === 0) return
  
  fileSummaries.value.clear()
  
  for (const file of props.files) {
    if (file.content) {
      extractFileSummary(file)
    }
  }
  
  if (props.blocks && props.blocks.length > 0) {
    const uniqueFilePaths = new Set()
    for (const block of props.blocks) {
      if (block.filePath || block.path) {
        uniqueFilePaths.add(block.filePath || block.path)
      }
    }
    
    for (const filePath of uniqueFilePaths) {
      const file = props.files.find(f => f.path === filePath)
      if (file && file.content) {
        extractFileSummary(file)
      }
    }
  }
}

// 辅助函数 - 安全获取详细分数
const getDetailedScore = (slice: any, key: string, defaultValue: number = 0): number => {
  if (!slice || !slice.detailedScores) return defaultValue
  const value = slice.detailedScores[key]
  return value !== undefined && value !== null ? value : defaultValue
}

// 辅助函数 - 安全获取匹配实体
const getMatchedEntities = (slice: any): string[] => {
  if (!slice || !slice.detailedScores) return []
  return slice.detailedScores.matchedEntities || []
}

// 辅助函数 - 安全获取实体增强乘数
const getEntityBoostMultiplier = (slice: any): number => {
  if (!slice || !slice.detailedScores) return 1
  return slice.detailedScores.entityBoostMultiplier || 1
}

const getScoreClass = (rowIndex: number, sliceIndex: number) => {
  const result = testResults.value[rowIndex]
  if (!result || !result.slices || !result.slices[sliceIndex]) return ''
  
  const slice = result.slices[sliceIndex]
  // 与格子/模态框一致：优先 slice.score，缺失时回退 detailedScores.overallScore
  const score = slice.score != null ? slice.score : getDetailedScore(slice, 'overallScore')
  
  if (slice.containsAnswer) return 'answer-match'
  if (score > 0.7) return 'high-score'
  if (score > 0.5) return 'medium-score'
  return 'low-score'
}

const formatPercent = (value: number) => {
  if (value === undefined || value === null) return '0%'
  return (value * 100).toFixed(1) + '%'
}

// 获取算法标签
const getAlgorithmLabel = (algo: SearchAlgorithm) => {
  const option = algorithmOptions.value.find(o => o.value === algo)
  return option ? option.label : algo
}

// 该策略是否启用 问题增强(Q) / 文件摘要 通道（仅启用对应通道的策略才展示「通道缺失·切片分兜底」标记，
// 避免 similarity 等纯切片策略也把 dense 的 hasQ=false 误标为「无关联问题」）
const channelFlagsOf = (algo: string): { qOn: boolean; fOn: boolean } => {
  const def = getEnabledStrategies().find(s => s.id === algo)
  const steps: any[] = ((def?.steps || []) as any[])
  const denseStep = steps.find((st: any) => st?.primitive === 'dense_score')
  const qOn = Number(denseStep?.params?.summaryWeight ?? props.model?.summaryWeight ?? 0.7) > 0
  const fOn = steps.some((st: any) => st?.primitive === 'file_score')
  return { qOn, fOn }
}

// 耗时格式化（毫秒 → 可读文本）
const formatTime = (ms?: number) => (ms && ms > 0) ? Math.round(ms) + ' ms' : '-'

// 过滤粘贴残留的附件占位问题（形如 #attachment:Pasted text #1），避免进入测试与汇总；
// 占位可能出现在行首或混在文本中，故按任意位置匹配
const isJunkQuestion = (q: string) => /#attachment:/i.test(q.trim() || '')

// 组件挂载时初始化
onMounted(() => {
  initFileSummaries()
  // 若 .kb 已保存测试用例，恢复它们（连同关联切片 refs）
  if (props.testCases?.questions?.length) {
    test.questions = [...props.testCases.questions]
    test.answers = [...(props.testCases.answers || [])]
    test.refs = normalizeRefs(props.testCases.refs || [], test.questions.length)
    test.questionStatus = test.questions.map(() => ({
      text: store.locales=='zh' ? '未测试' : 'Not Tested',
      color: 'var(--borderColor)', icon: 'fa fa-circle-o'
    }))
  }
})

// 监听文件和blocks的变化
watch(() => [props.files, props.blocks], () => {
  initFileSummaries()
}, { deep: true })

// 测试用例与 .kb 同步：本地变化上报父组件（保存到 .kb；refs 与行对齐后一并回传；source 随行告知当前来源）
watch(
  () => [test.questions, test.answers] as const,
  () => emit('testCasesChange', {
    questions: [...test.questions],
    answers: [...test.answers],
    refs: normalizeRefs(test.refs, test.questions.length),
    source: testSource.value,
  }),
  { deep: true }
)

// 从 .kb 加载恢复测试用例（内容与本地相同则不覆盖，避免回灌循环）
watch(
  () => props.testCases,
  (val) => {
    if (!val?.questions?.length) return
    testSource.value = (val.source === 'external') ? 'external' : 'bank'
    const refs = normalizeRefs(val.refs || [], val.questions.length)
    const same = test.questions.length === val.questions.length &&
      val.questions.every((q, i) => q === test.questions[i]) &&
      (test.answers.length === (val.answers || []).length) &&
      (val.answers || []).every((a, i) => a === test.answers[i]) &&
      refs.every((r, i) => JSON.stringify(r) === JSON.stringify(test.refs[i]))
    if (same) return
    test.questions = [...val.questions]
    test.answers = [...(val.answers || [])]
    test.refs = refs
    test.questionStatus = test.questions.map(() => ({
      text: store.locales=='zh' ? '未测试' : 'Not Tested',
      color: 'var(--borderColor)', icon: 'fa fa-circle-o'
    }))
    testResults.value = []
    rankAnalysisResults.value = []
    allStrategyStats.value = []
    allStrategySliceResults.value = []
  },
  { deep: true }
)

// 定义发射事件
const emit = defineEmits<{
  updateState: [state: string]
  updateLiveState: [state: string]
  updateDedupProgress: [progress: { total: number; compared: number; dupCount: number; mergedCount: number; current: number } | null]
  testCasesChange: [data: { questions: string[], answers: string[], refs?: TestCaseRef[], source?: 'bank' | 'external' }]
}>()

// 测试用例上限（读取按钮右侧可快速设置；与「设置 · 处理配置」的 model.maxTestCases 同源同步）
const maxCasesInput = ref<number>(Number(props.model?.maxTestCases) || 50)
watch(
  () => props.model?.maxTestCases,
  (v) => {
    const n = Number(v) || 50
    if (Number(maxCasesInput.value) !== n) maxCasesInput.value = n
  }
)
/** 上限变更（回车/失焦）：夹取合法范围 → 写回 model → 按新上限重新从问题库派生测试用例 */
const onMaxCasesChange = () => {
  let v = Math.floor(Number(maxCasesInput.value))
  if (!Number.isFinite(v) || v < 1) v = 1
  if (v > 5000) v = 5000
  maxCasesInput.value = v
  if (props.model) props.model.maxTestCases = v
  props.onRefreshTestCases?.()
}

/** 解析导入单元格中的「对应/关联切片」→ 当前知识库切片 blockId 列表（供「切片命中」判定）。
 * 支持：问题库导出模板的 JSON 数组（[{blockId,filePath,label,hash}] 或字符串数组）；
 * 裸 blockId / contentHash；filePath 或 filePath#标题；多项可用 | ；, 分隔。
 * 解析优先级：blockId → contentHash → filePath#标题（唯一） → filePath（唯一）。 */
const resolveImportSliceRefs = (raw: any): string[] => {
  if (raw == null) return []
  const bs: any[] = props.blocks || []
  const normPath = (p: any) => String(p || '').replace(/\\/g, '/')
  const out: string[] = []
  const addId = (b: any) => { if (b && b.id && !out.includes(b.id)) out.push(b.id) }
  const resolveToken = (t0: string) => {
    const t = String(t0 || '').trim()
    if (!t) return
    const byId = bs.find((x: any) => x.id === t)
    if (byId) { addId(byId); return }
    const byHash = bs.find((x: any) => x.contentHash && x.contentHash === t)
    if (byHash) { addId(byHash); return }
    const sepIdx = Math.max(t.indexOf('#'), t.indexOf('＃'))
    if (sepIdx >= 0) {
      const fp = t.slice(0, sepIdx)
      const lb = t.slice(sepIdx + 1).trim()
      const same = bs.filter((x: any) => normPath(x.filePath) === normPath(fp))
      const exact = same.filter((x: any) => String(x.label || '') === lb)
      if (exact.length === 1) addId(exact[0])
      return
    }
    const sameFile = bs.filter((x: any) => normPath(x.filePath) === normPath(t))
    if (sameFile.length === 1) addId(sameFile[0])
  }
  const txt = String(raw ?? '').trim()
  if (!txt) return []
  if (txt.startsWith('[')) {
    try {
      const parsed = JSON.parse(txt)
      if (Array.isArray(parsed)) {
        for (const it of parsed) {
          if (it && typeof it === 'object') {
            if (it.blockId) { const b = bs.find((x: any) => x.id === it.blockId); if (b) { addId(b); continue } }
            if (it.hash) { const b = bs.find((x: any) => x.contentHash && x.contentHash === it.hash); if (b) { addId(b); continue } }
            if (it.filePath) {
              const same = bs.filter((x: any) => normPath(x.filePath) === normPath(it.filePath))
              if (it.label != null) {
                const exact = same.filter((x: any) => String(x.label || '') === String(it.label || ''))
                if (exact.length === 1) { addId(exact[0]); continue }
              }
              if (same.length === 1) { addId(same[0]); continue }
            }
          } else if (typeof it === 'string' && it) {
            resolveToken(it)
          }
        }
        return out
      }
    } catch { /* 非法 JSON → 按普通文本尝试 */ }
  }
  txt.split(/[|｜;；,，\r\n]+/).forEach(resolveToken)
  return out
}

/** 导入外部 Excel 测试用例（独立测试集）：
 *  - 只用于评测知识库检索效果，不写入问题库/知识库（不影响切片向量化、不会被 LLM 生成问题流程使用）；
 *  - 覆盖当前测试列表并切换来源为 external；问题库用例仍可点「读取测试用例」恢复；
 *  - 支持三列：问题 / 参考答案 / 对应切片（含切片数据即可按「切片命中」对比是否召回参考切片）；表头中/英兼容。 */
const importTestCasesFromExcel = () => {
  if (test.isRunning) {
    emit('updateState', store.locales=='zh' ? '测试运行中，请先停止再导入' : 'Testing in progress, stop it before importing')
    return
  }
  const existing = test.questions.filter(q => q && q.trim()).length
  if (existing > 0) {
    const ok = window.confirm(store.locales=='zh'
      ? `将用外部 Excel 的独立测试集替换当前 ${existing} 条测试用例（问题库用例可随时点「读取测试用例」恢复）。是否继续？`
      : `This will replace the current ${existing} test case(s) with the imported external set (question-bank cases can be restored via the "Read test cases" button anytime). Continue?`)
    if (!ok) return
  }
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.xlsx,.xls'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    try {
      const data = await file.arrayBuffer()
      const wb = XLSX.read(data, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 }) || []
      // 识别表头行并映射「问题 / 参考答案 / 对应切片」列（无表头时退回 第1列=问题 第2列=答案 第3列=切片）
      let headerIdx = -1
      let colQ = 0
      let colA = 1
      let colS = 2
      for (let i = 0; i < Math.min(rows.length, 20); i++) {
        const r = rows[i] || []
        const c0 = String(r[0] ?? '').trim().toLowerCase()
        const c1 = String(r[1] ?? '').trim().toLowerCase()
        if (/^(问题|提问|题目|question|query|测试问题)/.test(c0) || /^(参考答案|参考回答|答案|回答|answer|expected|gold)/.test(c1)) {
          headerIdx = i
          const norm = (v: any) => String(v ?? '').trim().toLowerCase()
          const header = (r || []).map(norm)
          const pick = (tokens: string[], fallback: number): number => {
            const hit = header.findIndex(h => tokens.some(t => h === t || h.startsWith(t)))
            return hit >= 0 ? hit : fallback
          }
          colQ = pick(['问题', '提问', '题目', 'question', 'query', '测试问题'], 0)
          colA = pick(['参考答案', '参考回答', '答案', '回答', 'expected', 'gold', 'answer'], 1)
          colS = pick(['对应切片', '关联切片', '参考切片', '切片', 'slice', 'refs', 'blocks', 'gold'], 2)
          break
        }
      }
      const questions: string[] = []
      const answers: string[] = []
      const refs: TestCaseRef[] = []
      let sliceCount = 0
      for (let ri = headerIdx + 1; ri < rows.length; ri++) {
        const row = rows[ri] || []
        const q = String(row[colQ] ?? '').trim()
        if (!q || isJunkQuestion(q)) continue
        const a = (colA < row.length && row[colA] != null) ? String(row[colA]).trim() : ''
        // 「对应/关联切片」列：解析为当前知识库切片 blockId（供「切片命中」判定：召回是否命中参考切片）
        const ids = (colS < row.length && row[colS] != null) ? resolveImportSliceRefs(row[colS]) : []
        questions.push(q)
        answers.push(a)
        refs.push({ srcBlockId: ids[0] || undefined, blockIds: ids })
        if (ids.length) sliceCount++
      }
      if (questions.length === 0) {
        emit('updateState', store.locales=='zh' ? '未在 Excel 中读取到有效问题' : 'No valid questions found in the Excel')
        return
      }
      // 切到「外部导入」来源并替换列表（不触碰问题库，故不影响知识库/向量化）
      testSource.value = 'external'
      test.questions = [...questions]
      test.answers = answers
      test.refs = refs
      resetQuestionPaging()
      clearJudgementResults()
      // 判定模式：含关联切片 → 「切片命中」（对比是否召回参考切片）；无切片但有参考答案 → 「答案命中」按文本判定
      const isZh = store.locales == 'zh'
      const hasAnswer = answers.some(a => !!a)
      if (sliceCount > 0 && test.hitMode !== 'slice') test.hitMode = 'slice'
      else if (sliceCount === 0 && hasAnswer && test.hitMode !== 'text') test.hitMode = 'text'
      nextTick(() => fillTestViewportIfShort())
      let detail = ''
      if (sliceCount > 0) {
        detail = isZh
          ? `，其中 ${sliceCount} 条带关联切片（按「切片命中」对比召回）`
          : `, ${sliceCount} with linked slices (Slice-Hit rule)`
        if (questions.length > sliceCount) {
          detail += isZh
            ? `；另 ${questions.length - sliceCount} 条无切片，可切「答案命中」`
            : `; ${questions.length - sliceCount} without slices, can use Answer Hit`
        }
      } else if (hasAnswer) {
        detail = isZh ? '；命中判定已切到「答案命中」' : '; hit rule switched to Answer Hit'
      }
      emit('updateState', isZh
        ? `已导入 ${questions.length} 条独立测试用例（仅用于评测，未写入问题库${detail}）`
        : `Imported ${questions.length} standalone test case(s) for evaluation (not written to the question bank${detail})`)
    } catch (e: any) {
      console.error('导入测试用例失败:', e)
      emit('updateState', store.locales=='zh' ? '导入失败' : 'Import failed')
    }
  }
  input.click()
}

/** 读取测试用例（从问题库派生）：
 * 若当前处于「外部导入」来源，切回问题库后关联切片判定基准恢复可用，命中判定回到默认「切片命中」
 * （与导入外部用例时按其是否含关联切片自动选择「切片命中/答案命中」对称）；已在问题库来源时保持用户当前的判定设置不变。 */
const readTestCasesFromBank = () => {
  if (testSource.value === 'external' && test.hitMode !== 'slice') test.hitMode = 'slice'
  props.onRefreshTestCases?.()
}

/** 清空测试用例：清空当前列表（问题/答案/关联切片一并清空，结果与统计同步清空），来源回到「问题库跟随」。
 * 只影响测试用例本身，不触碰问题库/知识库。 */
const clearTestCases = () => {
  if (test.isRunning) {
    emit('updateState', store.locales=='zh' ? '测试运行中，请先停止再清空' : 'Testing in progress, stop it before clearing')
    return
  }
  const cnt = test.questions.filter(q => q && q.trim()).length
  if (cnt === 0) {
    clearJudgementResults()
    lastUpdateTime.value = ''
    emit('updateState', store.locales=='zh' ? '测试用例已是空列表' : 'Test cases are already empty')
    return
  }
  const ok = window.confirm(store.locales=='zh'
    ? `清空当前 ${cnt} 条测试用例？（问题库用例可随时点「读取测试用例」重新派生恢复；仅影响测试列表，不删除问题库/知识库内容）`
    : `Clear all ${cnt} test case(s)? (question-bank cases can be restored via "Read test cases" anytime; only the test list is affected)`)
  if (!ok) return
  // 从外部导入来源清空 → 回到默认「切片命中」与「问题库跟随」，与「读取测试用例」行为一致
  if (testSource.value === 'external' && test.hitMode !== 'slice') test.hitMode = 'slice'
  testSource.value = 'bank'
  test.questions = ['']
  test.answers = ['']
  test.refs = normalizeRefs([], 1)
  resetQuestionPaging()
  clearJudgementResults()
  lastUpdateTime.value = ''
  emit('updateState', store.locales=='zh' ? `已清空 ${cnt} 条测试用例` : `Cleared ${cnt} test case(s)`)
}

</script>

<template>
  <div style="display:flex;height:100%;width:100%;box-sizing:border-box;align-items:stretch;flex-direction:column;">

    <!-- 工具栏（kt-* 统一：单行图标按钮 + title；三个页面切换为按钮样式） -->
    <div class="kt-toolbar">
      <div class="kt-btn" :class="{ active: activeTab === 'test' }" :title="store.locales=='zh' ? '测试结果' : 'Test Results'" @click="activeTab = 'test'">
        <i class="fa fa-table"></i>
      </div>
      <div class="kt-btn" :class="{ active: activeTab === 'rank' }" :title="store.locales=='zh' ? '位次分析' : 'Rank Analysis'" @click="activeTab = 'rank'">
        <i class="fa fa-line-chart"></i>
      </div>
      <div class="kt-btn" :class="{ active: activeTab === 'batch' }" :title="store.locales=='zh' ? '批量测试面板' : 'Batch Panel'" @click="activeTab = 'batch'">
        <i class="fa fa-tasks"></i>
      </div>
      <span class="kt-sep"></span>
      <!-- 读取测试用例：按当前上限（可在右侧输入框快速设置）从问题库重新派生问题（会覆盖外部导入的独立用例） -->
      <div class="kt-btn" @click="readTestCasesFromBank"
           :title="store.locales=='zh' ? '读取测试用例：按右侧「上限」从问题库重新派生并刷新问题（会覆盖外部导入的独立用例）' : 'Read test cases: re-derive questions from the question bank (respects the max limit at right; replaces imported standalone cases)'">
        <i class="fa fa-download"></i>
      </div>
      <input
        type="number"
        class="kt-input"
        style="width:62px;"
        min="1"
        max="5000"
        step="1"
        v-model.number="maxCasesInput"
        @change="onMaxCasesChange"
        :title="store.locales=='zh' ? '测试用例上限（1-5000）：回车或失焦后按新上限重新派生测试用例' : 'Max test cases (1-5000): re-derive on Enter/blur'"
      />
      <!-- 导入外部 Excel 测试用例（独立测试集：仅用于评测知识库，不写入问题库/知识库） -->
      <div class="kt-btn" @click="importTestCasesFromExcel" :disabled="test.isRunning"
           :title="store.locales=='zh' ? '导入测试用例：从外部 Excel 读取独立测试集（仅用于评测，不写入问题库/知识库）。支持 问题/参考答案/对应切片 三列或仅问题：第 3 列填参考切片（JSON、blockId、hash 或 filePath）即可按「切片命中」对比是否召回；无切片时自动切「答案命中」' : 'Import test cases: load a standalone test set from Excel (evaluation only, not written to the question bank). Supports Question / Reference-Answer / Linked-Slice columns: fill col 3 with the reference slice(s) (JSON, blockId, hash or filePath) to compare recall via Slice-Hit; falls back to Answer Hit when no slices'">
        <i class="fa fa-file-excel-o"></i>
      </div>
      <!-- 清空测试用例：清空当前问题/答案/关联切片列表（结果与统计一并清空；不影响问题库/知识库） -->
      <div class="kt-btn" @click="clearTestCases" :disabled="test.isRunning"
           :title="store.locales=='zh' ? '清空测试用例：清空当前 问题/答案/关联切片 列表（结果与统计一并清空）；问题库用例可点「读取测试用例」重新派生' : 'Clear test cases: empty the current question/answer/linked-slice list (results & stats cleared too); question-bank cases can be restored via \'Read test cases\''">        <i class="fa fa-trash"></i>
      </div>
      <span class="kt-sep"></span>
      <!-- 批量测试（当前策略）：仅前两个面板（测试结果/位次分析）显示 -->
      <div v-if="activeTab === 'test' || activeTab === 'rank'" class="kt-btn" @click="runBatchTest" :disabled="test.isRunning"
           :title="store.locales=='zh' ? '批量测试（当前策略）：用当前策略跑全部问题' : 'Batch test (current strategy): run all questions'">
        <i class="fa fa-play"></i>
      </div>

      <!-- 批量测试面板工具栏按钮组（仅该标签显示；窗口窄时右侧溢出隐藏，不显示横向滑块）。
           容器带 gap 保证 kt-btn 之间始终有间隔；导出按钮经 margin-left:auto 推到最右 -->
      <div v-if="activeTab === 'batch'" style="display:flex;align-items:center;flex:1;flex-wrap:nowrap;overflow:hidden;min-width:0;gap:5px;">
        <!-- 批量测试 / 清空 -->
        <div class="kt-btn" @click="runAllStrategyTest" :disabled="test.isRunning"
             :title="store.locales=='zh' ? '批量测试所有策略：每个策略跑一遍全部问题，统计召回准确率' : 'Test all strategies: run all questions for every strategy'">
          <i class="fa fa-play"></i>
        </div>
        <div class="kt-btn" @click="clearAllResults" :disabled="test.isRunning || prewarmRunning"
             :title="store.locales=='zh' ? '清空批量测试结果 / 位次 / 统计（释放内存）' : 'Clear batch results / stats (free memory)'">
          <i class="fa fa-eraser"></i>
        </div>
        <!-- 预热（仅当有可勾选项时显示）：开始 + 勾选项 -->
        <template v-if="availablePrewarmItems.length > 0">
          <span style="width:1px;height:20px;background:var(--borderColor);flex-shrink:0;"></span>
          <div class="kt-btn" @click="runPrewarm" :disabled="prewarmRunning || test.isRunning"
               :title="store.locales=='zh' ? '开始预热：按勾选的预热项执行向量化（耗时单独计时、不计入检索）' : 'Pre-warm: run checked vectorization (time excluded from retrieval)'">
            <i class="fa" :class="prewarmRunning ? 'fa-spinner fa-spin' : 'fa-fire'"></i>
          </div>
          <span style="width:1px;height:20px;background:var(--borderColor);flex-shrink:0;"></span>
          <div v-for="item in availablePrewarmItems" :key="item.key"
               class="kt-btn" :class="{ on: prewarm[item.key] }"
               :title="(prewarm[item.key] ? (store.locales=='zh' ? '已勾选：' : 'On: ') : (store.locales=='zh' ? '点击勾选：' : 'Click to enable: ')) + (store.locales=='zh' ? item.label : item.labelEn)"
               @click="prewarm[item.key] = !prewarm[item.key]">
            <i class="fa" :class="item.icon"></i>
          </div>
        </template>
        <!-- 导出（固定放最右：margin-left:auto 吸收左侧剩余空间，与操作按钮自然分隔） -->
        <div class="kt-btn" style="margin-left:auto;" @click="exportAllTestData" :disabled="isExporting" :title="store.locales=='zh'?'导出全部测试数据（汇总+位次+切片明细）':'Export all test data (summary+rank+slices)'">
          <i class="fa fa-database"></i>
        </div>
        <div class="kt-btn" @click="exportAllStrategyStats" :disabled="isExporting" :title="store.locales=='zh'?'导出策略召回对比汇总 (Excel)':'Export strategy recall comparison (Excel)'">
          <i class="fa fa-table"></i>
        </div>
      </div>

      <!-- 问题行操作 / 策略 / 数量 / 统计（仅测试结果/位次分析标签显示） -->
      <template v-if="activeTab === 'test' || activeTab === 'rank'">
        <div class="kt-btn" @click="clearAllResults" :disabled="test.isRunning"
             :title="store.locales=='zh' ? '清空所有测试结果/位次/统计（释放内存）' : 'Clear all test results / stats (free memory)'">
          <i class="fa fa-eraser"></i>
        </div>
        <span class="kt-sep"></span>

        <select 
          v-model="test.currentAlgorithm" 
          class="kt-select" style="width:110px;"
          :title="store.locales=='zh' ? '选择检索策略' : 'Select search strategy'"
        >
          <option v-for="algo in algorithmOptions" :key="algo.value" :value="algo.value">
            {{ algo.label }}
          </option>
        </select>
        
        <!-- 命中判定基准：切片精准命中（默认，按关联切片身份）/ 答案命中（按参考答案文本，旧口径） -->
        <select v-model="test.hitMode" class="kt-select" style="width:92px;"
                :title="store.locales=='zh' ? '命中判定：切片精准命中=检索到该问题的关联切片才算命中（推荐默认）；答案命中=按参考答案文本匹配（可在右侧选择 精准/模糊 子策略）' : 'Hit rule: Slice = hit only when the question\'s linked slice is recalled (default); Answer = match by reference-answer text (pick Exact/Fuzzy sub-strategy at right)'">
          <option value="slice">{{ store.locales=='zh' ? '切片命中' : 'Slice Hit' }}</option>
          <option value="text">{{ store.locales=='zh' ? '答案命中' : 'Answer Hit' }}</option>
        </select>

        <!-- 答案命中子策略（仅选中「答案命中」时显示）：精准=切片须完整包含某段参考答案；模糊=原有模糊口径 -->
        <select v-if="test.hitMode === 'text'" v-model="test.matchMode" class="kt-select" style="width:96px;"
                :title="store.locales=='zh' ? '答案命中策略：精准=切片须完整包含某段参考答案（按 | 分段，任一整段包含即命中，去掉模糊兜底）；模糊=整段/反向前缀50字/分段任一/词比例任一命中（旧口径）' : 'Answer-hit strategy: Exact = slice must fully contain an answer segment (split by |, any whole segment); Fuzzy = whole / reverse-50-prefix / any part / word-ratio (legacy)'">
          <option value="precise">{{ store.locales=='zh' ? '精准命中' : 'Exact Hit' }}</option>
          <option value="fuzzy">{{ store.locales=='zh' ? '模糊命中' : 'Fuzzy Hit' }}</option>
        </select>

        <!-- 切片数量选择 -->
        <input v-model="test.searchNum" type="number" class="kt-input" style="width:42px;" :title="store.locales=='zh'?'切片数量':'Slice Count'"/>
      </template>
      
      <!-- 进度 / 计数 -->
      <template v-if="test.isRunning">
        <span class="kt-spacer"></span>
        <span class="kt-progress" style="flex:0 1 200px;width:auto;max-width:200px;"><span class="kt-progress-fill" :style="{ width: test.progress + '%', backgroundColor: '#4CAF50' }"></span></span>
        <span class="kt-label">{{ test.progress.toFixed(0) }}%</span>
        <span class="kt-label" :title="store.locales=='zh' ? '已运行时间' : 'Elapsed'"><i class="fa fa-clock-o"></i> {{ elapsedText }}</span>
        <span class="kt-label" :title="store.locales=='zh' ? '预计剩余（按当前进度推算）' : 'Estimated remaining'"><i class="fa fa-hourglass-half"></i> {{ etaText }}</span>
        <span v-if="allTestProgressText" class="kt-label">{{ allTestProgressText }}</span>
      </template>
      <span v-else class="kt-label" style="margin-left:auto;font-size:12px;">
        {{ testResults.filter(Boolean).length }} / {{ test.questions.length }}
      </span>
    </div>
    
    <!-- 测试结果表格区域 -->
    <div v-if="activeTab === 'test'" style="flex:1;display:flex;flex-direction:column;overflow:hidden;">
      <div ref="testScrollRef" class="scoll" style="flex:1;overflow:auto;" @scroll="handleTestScroll">
        <table style="width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed;">
          <thead style="position:sticky;top:0;background-color:var(--menuColor);">
            <tr>
              <th style="padding:5px;border:1px solid var(--borderColor);text-align:left;width:200px;">
                <div style="font-weight:bold;">{{ store.locales=='zh' ? '问题' : 'Question' }}</div>
                <div style="font-size:9px;color:var(--borderColor);">{{ store.locales=='zh' ? '操作 · 状态 · 分段' : 'actions · status' }}</div>
              </th>
              <th style="padding:5px;border:1px solid var(--borderColor);text-align:left;width:200px;">
                <div style="font-weight:bold;">{{ store.locales=='zh' ? '参考答案' : 'Answer' }}</div>
                <div style="font-size:9px;color:var(--borderColor);">{{ store.locales=='zh' ? '关联切片（命中基准）' : 'linked slices (hit ref)' }}</div>
              </th>
              <th v-for="n in parseInt(test.searchNum)" :key="n" style="padding:5px;border:1px solid var(--borderColor);text-align:left;width:auto;">
                <div style="font-weight:bold;">{{ store.locales=='zh' ? '切片 ' : 'Slice ' }}{{ n }}</div>
                <div style="font-size:9px;color:var(--borderColor);">{{ store.locales=='zh' ? '位次:' : 'Rank:' }}{{ n }}</div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="qIndex in visibleRows" :key="'question-' + qIndex" 
                :style="{backgroundColor: qIndex % 2 === 0 ? 'var(--backgroundColor)' : 'var(--menuColor)'}">
              
              <!-- 问题列：问题输入 + 操作/状态行 -->
              <td style="padding:5px;border:1px solid var(--borderColor);vertical-align:top;width:200px;">
                <textarea
                  v-model="test.questions[qIndex]" class="scoll" style="width:calc(100% - 8px);min-height:56px;padding:4px;font-size:12px;resize:vertical;border:1px solid var(--borderColor);border-radius:3px;"
                  :placeholder="store.locales=='zh' ? '输入问题 ' : 'Enter question ' + (qIndex + 1)"
                  @keydown.ctrl.enter="runSingleTest(qIndex)"
                ></textarea>
                <!-- 操作 / 状态 / 算法 / 分段数（问题列下方） -->
                <div style="margin-top:4px;font-size:10px;display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
                  <span @click="runSingleTest(qIndex)" :title="store.locales=='zh' ? '单独测试 (Ctrl+Enter)' : 'Test individually (Ctrl+Enter)'">
                    <i class="fa fa-play"></i>
                  </span>
                  <span v-if="test.questionStatus[qIndex]" :style="{color: test.questionStatus[qIndex].color}">
                    <i :class="test.questionStatus[qIndex].icon"></i>
                    {{ test.questionStatus[qIndex].text }}
                  </span>
                  <span v-if="test.questionStatus[qIndex]?.algorithm" style="font-size:9px;background:var(--menuColor);padding:0 4px;border-radius:3px;">
                    {{ getAlgorithmLabel(test.questionStatus[qIndex].algorithm as SearchAlgorithm) }}
                  </span>
                  <span style="flex:1"></span>
                  <span v-if="answerPartCount(qIndex) > 0" style="font-size:10px;color:var(--borderColor);display:inline-flex;align-items:center;gap:3px;"
                        :title="store.locales=='zh' ? '参考答案分段数' : 'answer segments'">
                    <i class="fa fa-list-ul"></i>{{ answerPartCount(qIndex) }}
                  </span>
                </div>
              </td>

              <!-- 参考答案列：答案输入 + 关联切片图标（命中基准，点击查看） -->
              <td style="padding:5px;border:1px solid var(--borderColor);vertical-align:top;width:200px;">
                <textarea v-model="test.answers[qIndex]" class="scoll" style="width:calc(100% - 8px);min-height:56px;padding:4px;font-size:12px;resize:vertical;border:1px solid var(--borderColor);border-radius:3px;"
                  :placeholder="store.locales=='zh' ? '参考答案 ' : 'Answer ' + (qIndex + 1)"
                  @keydown.ctrl.enter="runSingleTest(qIndex)"
                ></textarea>
                <div v-if="rowGoldCount(qIndex) > 0" class="tm-gold-ic"
                     :class="rowGoldHitCount(qIndex) >= rowGoldCount(qIndex) ? 'all' : (rowGoldHitCount(qIndex) > 0 ? 'some' : 'none')"
                     @click="openGoldPreview(qIndex)"
                     :title="store.locales=='zh' ? `查看该问题的 ${rowGoldCount(qIndex)} 个关联切片（命中判定基准）：绿色=已被检索召回` : `View ${rowGoldCount(qIndex)} linked slice(s) (hit reference): green = recalled`">
                  <i class="fa fa-link"></i>
                  <span class="tm-gold-dot">{{ rowGoldHitCount(qIndex) }}/{{ rowGoldCount(qIndex) }}</span>
                </div>
              </td>
              
              
              <!-- 切片结果单元格 -->
              <td v-for="n in parseInt(test.searchNum)" :key="'result-' + qIndex + '-' + n" style="padding:5px;border:1px solid var(--borderColor);vertical-align:top;position:relative;width:auto;" :class="getScoreClass(qIndex, n-1)">
                <template v-if="testResults[qIndex] && testResults[qIndex].slices && testResults[qIndex].slices[n-1]">
                  <!-- 总分：水平+垂直居中于整个切片结果单元格（与模态框一致用 slice.score，缺失时回退 overallScore） -->
                  <div class="slice-cell">
                    <span class="slice-cell-total" :title="store.locales=='zh' ? '总分' : 'Total score'">
                      {{ cellSlice(qIndex, n) ? formatPercent(cellSlice(qIndex, n).score != null ? cellSlice(qIndex, n).score : getDetailedScore(cellSlice(qIndex, n), 'overallScore')) : '-' }}
                    </span>
                  </div>
                  <!-- 左下角标记：参考切片图标（该检索切片正是本问题关联切片）+ 命中对勾 -->
                  <div class="slice-badges">
                    <span v-if="sliceHitInfo(qIndex, n).ref" class="slice-ref-ic"
                          :title="store.locales=='zh' ? '与关联切片相同：该检索切片正是本问题的参考切片' : 'Same as linked slice: this retrieved slice is the reference slice'">
                      <i class="fa fa-scissors"></i>
                    </span>
                    <span v-if="sliceHitInfo(qIndex, n).hit" class="slice-hit-ic"
                          :title="store.locales=='zh' ? (sliceHitInfo(qIndex, n).ref ? '命中关联切片（参考基准被召回）' : '命中参考答案文本') : (sliceHitInfo(qIndex, n).ref ? 'Hit linked slice (reference recalled)' : 'Hit answer text')">
                      <i class="fa fa-check-circle"></i>
                    </span>
                  </div>
                  <!-- 查看：右下角（锚定整个单元格底部） -->
                  <span class="slice-view-ic" @click="openSlicePreview(qIndex, n)"
                        :title="store.locales=='zh' ? '查看全文 / 文件名 / 具体分值' : 'View full text / file / scores'">
                    <i class="fa fa-eye"></i>
                  </span>
                </template>
                  

                  

                  

                  

                <div v-else style="color:var(--borderColor);font-size:11px;text-align:center;padding:35px 0;">
                  <i class="fa fa-hourglass-o"></i>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 位次分析页面 -->
    <div v-if="activeTab === 'rank'" style="flex:1;display:flex;flex-direction:column;overflow:hidden;">
      <div class="scoll" style="flex:1;overflow:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead style="position:sticky;top:0;background-color:var(--menuColor);">
            <tr>
              <th style="padding:8px;border:1px solid var(--borderColor);text-align:left;">{{ store.locales=='zh' ? '问题' : 'Question' }}</th>
              <th style="padding:8px;border:1px solid var(--borderColor);text-align:left;"
                  :title="rankRefMode === 'slice' ? (store.locales=='zh' ? '关联切片=判定基准；绿色=已被检索召回' : 'Linked slices are the hit reference; green = recalled') : ''">
                {{ store.locales=='zh' ? (rankRefMode === 'slice' ? '关联切片' : '参考答案') : (rankRefMode === 'slice' ? 'Linked Slices' : 'Answer') }}
              </th>
              <th style="padding:8px;border:1px solid var(--borderColor);text-align:left;">{{ store.locales=='zh' ? '策略' : 'Strategy' }}</th>
              <th style="padding:8px;border:1px solid var(--borderColor);text-align:left;">{{ store.locales=='zh' ? '命中率' : 'Hit Rate' }}</th>
              <th style="padding:8px;border:1px solid var(--borderColor);text-align:left;">{{ store.locales=='zh' ? '命中/总数' : 'Hit/Total' }}</th>
              <th style="padding:8px;border:1px solid var(--borderColor);text-align:left;">{{ store.locales=='zh' ? '命中的答案' : 'Hit Answers' }}</th>
              <th style="padding:8px;border:1px solid var(--borderColor);text-align:left;">{{ store.locales=='zh' ? '答案出现位次' : 'Answer Ranks' }}</th>
              <th style="padding:8px;border:1px solid var(--borderColor);text-align:left;">{{ store.locales=='zh' ? '首次位次' : 'First Rank' }}</th>
              <th style="padding:8px;border:1px solid var(--borderColor);text-align:left;">{{ store.locales=='zh' ? '命中数' : 'Hit Count' }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(result, idx) in rankAnalysisResults" :key="idx"
                :style="{backgroundColor: idx % 2 === 0 ? 'var(--backgroundColor)' : 'var(--menuColor)'}">
              <td style="padding:8px;border:1px solid var(--borderColor);vertical-align:top;word-break:break-word;max-width:200px;">
                {{ result.question }}
              </td>
              <td style="padding:8px;border:1px solid var(--borderColor);vertical-align:top;word-break:break-word;max-width:200px;">
                <div class="rank-cell-scroll scoll">
                  <div v-for="(part, pIdx) in result.answerParts" :key="pIdx" 
                      :style="{color: result.matchedAnswers?.includes(part) ? '#4CAF50' : '#f44336'}">
                    {{ part }}
                    <span v-if="result.matchedAnswers?.includes(part)" style="font-size:10px;color:#4CAF50;">
                      <i class="fa fa-check"></i>
                    </span>
                    <span v-else style="font-size:10px;color:#f44336;">
                      <i class="fa fa-times"></i>
                    </span>
                  </div>
                </div>
              </td>
              <td style="padding:8px;border:1px solid var(--borderColor);vertical-align:top;">
                {{ getAlgorithmLabel(result.algorithm) }}
              </td>
              <td style="padding:8px;border:1px solid var(--borderColor);vertical-align:top;">
                <span :style="{color: (result.hitRate || 0) > 0.7 ? '#4CAF50' : (result.hitRate || 0) > 0.3 ? '#FF9800' : '#f44336', fontWeight: 'bold'}">
                  {{ ((result.hitRate || 0) * 100).toFixed(1) }}%
                </span>
              </td>
              <td style="padding:8px;border:1px solid var(--borderColor);vertical-align:top;">
                {{ result.hitCount || 0 }} / {{ result.totalAnswers || 0 }}
              </td>
              <td style="padding:8px;border:1px solid var(--borderColor);vertical-align:top;max-width:150px;">
                <div class="rank-cell-scroll scoll">
                  <span v-if="result.matchedAnswers && result.matchedAnswers.length > 0" 
                        style="font-size:11px;word-break:break-word;">
                    {{ result.matchedAnswers.join(', ') }}
                  </span>
                  <span v-else style="color:#f44336;font-size:11px;">
                    {{ store.locales=='zh' ? '无命中' : 'No hit' }}
                  </span>
                </div>
              </td>
              <td style="padding:8px;border:1px solid var(--borderColor);vertical-align:top;">
                <span :style="{color: result.ranks === '未找到' ? '#f44336' : '#4CAF50', fontWeight: result.ranks !== '未找到' ? 'bold' : 'normal'}">
                  {{ result.ranks }}
                </span>
              </td>
              <td style="padding:8px;border:1px solid var(--borderColor);vertical-align:top;">
                <span :style="{color: result.firstRank === -1 ? '#f44336' : '#4CAF50'}">
                  {{ result.firstRank === -1 ? (store.locales=='zh' ? '未找到' : 'Not Found') : result.firstRank }}
                </span>
              </td>
              <td style="padding:8px;border:1px solid var(--borderColor);vertical-align:top;">
                <span :style="{color: result.foundCount > 0 ? '#4CAF50' : '#f44336'}">
                  {{ result.foundCount }}
                </span>
              </td>
            </tr>
            <tr v-if="rankAnalysisResults.length === 0">
              <td colspan="9" style="padding:40px;text-align:center;color:var(--borderColor);">
                <i class="fa fa-info-circle"></i> 
                {{ store.locales=='zh' ? '暂无位次分析数据，请先运行测试' : 'No rank analysis data, please run tests first' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 批量测试面板页面（批量测试 / 预热 / 用例管理 / 策略召回对比；顶部按钮见工具栏） -->
    <div v-if="activeTab === 'batch'" style="flex:1;border-radius:5px;padding:5px;display:flex;flex-direction:column;overflow:hidden;">
      <div class="scoll" style="flex:1;overflow:auto;">
        <!-- 预热进度（运行中显示：每项状态 + 已处理数量 + 进度条） -->
        <div v-if="prewarmRunning && prewarmEnabledItems.length > 0" class="as-detail" style="margin-bottom:6px;">
          <div class="as-detail-title"><i class="fa fa-fire"></i> {{ store.locales=='zh' ? '预热进度（不计入检索时间）' : 'Pre-warm progress (excluded from retrieval)' }}</div>
          <div v-for="item in prewarmEnabledItems" :key="item.key" class="prewarm-row">
            <span class="prewarm-row-icon"><i class="fa" :class="item.icon"></i></span>
            <span class="prewarm-row-name" :title="store.locales=='zh' ? item.label : item.labelEn">{{ store.locales=='zh' ? item.label : item.labelEn }}</span>
            <div class="prewarm-row-bar">
              <div class="prewarm-row-fill" :style="{ width: prewarmPct(item.key) + '%' }"></div>
            </div>
            <span class="prewarm-row-status" :class="prewarmItemStates[item.key]?.status || 'pending'">
              <template v-if="prewarmItemStates[item.key]?.status === 'done'">
                <i class="fa fa-check-circle"></i> {{ store.locales=='zh' ? '完成' : 'Done' }}
              </template>
              <template v-else-if="prewarmItemStates[item.key]?.status === 'running'">
                <i class="fa fa-spinner fa-spin"></i>
                <template v-if="prewarmItemStates[item.key].total > 0">{{ prewarmItemStates[item.key].index }}/{{ prewarmItemStates[item.key].total }}</template>
                <template v-else>{{ store.locales=='zh' ? '处理中' : 'Running' }}</template>
              </template>
              <template v-else>{{ store.locales=='zh' ? '待处理' : 'Pending' }}</template>
            </span>
          </div>
        </div>

        <!-- 预热耗时（配置且执行过才显示） -->
        <div v-if="prewarmDone && prewarmTotalMs > 0" class="as-detail">
          <div class="as-detail-title"><i class="fa fa-clock-o"></i> {{ store.locales=='zh' ? '预热耗时（不计入检索时间）' : 'Pre-warm time (excluded from retrieval)' }}</div>
          <table class="as-table as-detail-table">
            <thead>
              <tr>
                <th>{{ store.locales=='zh' ? '项目' : 'Item' }}</th>
                <th style="text-align:center;">{{ store.locales=='zh' ? '耗时' : 'Time' }}</th>
                <th style="text-align:center;">{{ store.locales=='zh' ? '状态' : 'Status' }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in availablePrewarmItems" :key="item.key">
                <td>{{ store.locales=='zh' ? item.label : item.labelEn }}</td>
                <td style="text-align:center;">{{ prewarmTimes[item.key] != null ? formatTime(prewarmTimes[item.key]) : '-' }}</td>
                <td style="text-align:center;">
                  <span v-if="prewarm[item.key]" style="color:#4CAF50;"><i class="fa fa-check-circle"></i></span>
                  <span v-else style="color:var(--borderColor);">-</span>
                </td>
              </tr>
              <tr>
                <td style="font-weight:bold;">{{ store.locales=='zh' ? '合计' : 'Total' }}</td>
                <td style="text-align:center;font-weight:bold;">{{ formatTime(prewarmTotalMs) }}</td>
                <td style="text-align:center;"><span style="color:#4CAF50;"><i class="fa fa-check-circle"></i></span></td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 策略召回对比 -->
        <div class="as-detail">
          <div class="as-detail-title">
            <i class="fa fa-bar-chart"></i> {{ store.locales=='zh' ? '策略召回对比' : 'Strategy Recall Comparison' }}
            <span class="ae-note">{{ store.locales=='zh' ? `${allStrategyStats.length} 个策略 · 点击行查看位次明细` : `${allStrategyStats.length} strategies · click a row for rank detail` }}</span>
            <span class="as-group-tabs">
              <button :class="{ on: statsGroup === 'all' }" @click="statsGroup = 'all'">{{ store.locales=='zh' ? '全部' : 'All' }}</button>
              <button :class="{ on: statsGroup === 'single' }" @click="statsGroup = 'single'">{{ store.locales=='zh' ? '单切片' : 'Single' }}</button>
              <button :class="{ on: statsGroup === 'complex' }" @click="statsGroup = 'complex'">{{ store.locales=='zh' ? '复合' : 'Complex' }}</button>
            </span>
          </div>
          <!-- 汇总表（按召回率降序，最优高亮；可切换 全部/单切片/复合 分组） -->
          <div v-if="allStrategyStats.length === 0" class="as-empty">
            <i class="fa fa-info-circle"></i>
            {{ store.locales=='zh' ? '暂无汇总数据，请先运行「批量测试所有策略」' : 'No data yet, run "Test All Strategies" first' }}
          </div>
          <table v-else class="as-table">
            <thead>
              <tr>
                <th>{{ store.locales=='zh' ? '策略' : 'Strategy' }}</th>
                <th style="text-align:center;">{{ store.locales=='zh' ? '命中/测试' : 'Hit/Tested' }}</th>
                <th style="text-align:center;">{{ store.locales=='zh' ? '召回率' : 'Recall' }}</th>
                <th style="text-align:center;">{{ store.locales=='zh' ? '答案命中率' : 'HitRate' }}</th>
                <th style="text-align:center;">Hit@1</th>
                <th style="text-align:center;">MRR</th>
                <th style="text-align:center;">{{ store.locales=='zh' ? '完整率' : 'Complete' }}</th>
                <th style="text-align:center;">{{ store.locales=='zh' ? '平均位次' : 'Avg Rank' }}</th>
                <th style="text-align:center;">{{ store.locales=='zh' ? '平均时间' : 'Avg Time' }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(s, idx) in displayStats" :key="s.strategyId"
                  :class="{ 'as-best': idx === 0, expanded: expandedStrategy === s.strategyId }"
                  @click="toggleStrategyDetail(s.strategyId)"
                  :title="store.locales=='zh' ? '点击查看位次明细' : 'Click to view rank detail'">
                <td>{{ idx === 0 ? '🏆 ' : '' }}{{ s.label }}</td>
                <td style="text-align:center;">{{ s.hitCount }}/{{ s.testedCount }}</td>
                <td style="text-align:center;font-weight:bold;"
                    :style="{ color: s.recallRate>=0.7 ? '#4CAF50' : (s.recallRate>=0.4 ? '#FF9800' : '#f44336') }">
                  {{ (s.recallRate*100).toFixed(1) }}%
                </td>
                <td style="text-align:center;">{{ (s.avgHitRate*100).toFixed(1) }}%</td>
                <td style="text-align:center;font-weight:bold;"
                    :style="{ color: s.hitAt1>=0.7 ? '#4CAF50' : (s.hitAt1>=0.4 ? '#FF9800' : '#f44336') }">
                  {{ (s.hitAt1*100).toFixed(1) }}%
                </td>
                <td style="text-align:center;">{{ s.mrr.toFixed(3) }}</td>
                <td style="text-align:center;" :style="{ color: s.completeRate>=0.7 ? '#4CAF50' : (s.completeRate>=0.4 ? '#FF9800' : '#f44336') }">
                  {{ (s.completeRate*100).toFixed(1) }}%
                </td>
                <td style="text-align:center;">{{ s.avgFirstRank>0 ? s.avgFirstRank.toFixed(1) : '-' }}</td>
                <td style="text-align:center;">{{ formatTime(s.avgTimeMs) }}</td>
              </tr>
            </tbody>
          </table>
          <!-- 位次明细（点击策略行展开） -->
          <div v-if="expandedStrategy" class="as-detail">
            <div class="as-detail-title">
              <i class="fa fa-list"></i> {{ store.locales=='zh' ? '位次明细 · ' : 'Rank detail · ' }}{{ expandedStrategyLabel }}
              <span class="ae-note">({{ strategyDetailRows.length }} {{ store.locales=='zh' ? '条' : 'rows' }})</span>
            </div>
            <table class="as-table as-detail-table">
              <thead>
                <tr>
                  <th style="width:28px;">#</th>
                  <th>{{ store.locales=='zh' ? '问题' : 'Question' }}</th>
                  <th style="text-align:center;">{{ store.locales=='zh' ? '完整性' : 'Completeness' }}</th>
                  <th style="text-align:center;">{{ store.locales=='zh' ? '答案命中率' : 'HitRate' }}</th>
                  <th style="text-align:center;">{{ store.locales=='zh' ? '最优位次' : 'Best Rank' }}</th>
                  <th style="text-align:center;">{{ store.locales=='zh' ? '召回时间' : 'Recall Time' }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(r, i) in strategyDetailRows" :key="i">
                  <td style="text-align:center;">{{ i + 1 }}</td>
                  <td :title="r.question">{{ r.question }}</td>
                  <td style="text-align:center;font-weight:bold;" :style="{ color: completenessBadge(r).color }">
                    {{ completenessBadge(r).label }} <span style="opacity:.7;font-weight:400;">({{ completenessBadge(r).text }})</span>
                  </td>
                  <td style="text-align:center;">{{ ((r.hitRate||0)*100).toFixed(0) }}%</td>
                  <td style="text-align:center;">{{ r.firstRank>0 ? r.firstRank : '-' }}</td>
                  <td style="text-align:center;">{{ formatTime(r.timeMs) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- 切片 / 关联切片查看模态框：仅在点击查看时渲染，正文按 id 回源 props.blocks（结果不保存全文） -->
    <div v-if="preview" class="tm-overlay" @click.self="closeSlicePreview">
      <div class="tm-modal">
        <div class="ae-head">
          <div class="ae-title">
            <i class="fa fa-eye"></i>
            <span class="tm-modal-title" :title="preview.question">{{ preview.heading }}</span>
            <span v-if="preview.question" class="ae-note ellipsis" style="max-width:300px;" :title="preview.question">{{ preview.question }}</span>
          </div>
          <button class="ae-close" @click="closeSlicePreview" :title="store.locales=='zh' ? '关闭' : 'Close'"><i class="fa fa-times"></i></button>
        </div>
        <div class="tm-body">
          <div v-for="(it, idx) in preview.entries" :key="idx" class="tm-entry">
            <div class="tm-entry-head">
              <i :class="it.icon || 'fa fa-file-text-o'"></i>
              <span class="tm-entry-title ellipsis" :title="it.title">{{ it.title }}</span>
              <span v-if="it.file" class="tm-entry-file ellipsis" :title="it.file">{{ it.file }}</span>
              <span class="tm-entry-badge" :class="it.hit ? 'hit' : 'miss'">
                <template v-if="it.kind === 'slice'">
                  <template v-if="it.isReference"><i class="fa fa-check-circle"></i> {{ store.locales=='zh' ? '命中关联切片' : 'Linked-slice hit' }}</template>
                  <template v-else-if="it.hit"><i class="fa fa-check-circle"></i> {{ store.locales=='zh' ? '命中答案' : 'Answer hit' }}</template>
                  <template v-else><i class="fa fa-circle-o"></i> {{ store.locales=='zh' ? '未命中' : 'No hit' }}</template>
                </template>
                <template v-else>
                  <template v-if="it.hit"><i class="fa fa-check-circle"></i> {{ store.locales=='zh' ? '已召回' : 'Recalled' }}</template>
                  <template v-else><i class="fa fa-circle-o"></i> {{ store.locales=='zh' ? '未召回' : 'Not recalled' }}</template>
                </template>
              </span>
            </div>
            <div v-if="it.kind === 'slice'" class="tm-entry-scores">
              <span v-if="(it.sScore ?? 0) > 0" style="color:#2196F3;white-space:nowrap;" :title="store.locales=='zh' ? '切片分：正文向量与查询的相似度（未加权原始通道分）' : 'Slice score: content-vector similarity (raw channel)'">{{ store.locales=='zh' ? '切片' : 'Slice' }} {{ formatPercent(it.sScore) }}</span>
              <span v-if="(it.qScore ?? 0) > 0" style="color:#9C27B0;white-space:nowrap;" :title="store.locales=='zh' ? '问题分：问题库关联问题向量与查询的相似度（未加权原始通道分）' : 'Question score: linked-question vector similarity (raw channel)'">{{ store.locales=='zh' ? '问题' : 'Question' }} {{ formatPercent(it.qScore) }}</span>
              <span v-else-if="it.qMissing" style="color:var(--borderColor);white-space:nowrap;" :title="store.locales=='zh' ? '无关联问题（问题增强通道缺失）：总分已按切片分兜底，问题分为 0 不代表不相关' : 'No linked question (Q-channel missing): total fell back to slice score'">{{ store.locales=='zh' ? '问题' : 'Question' }} —</span>
              <span v-if="(it.fScore ?? 0) > 0" style="color:#4CAF50;white-space:nowrap;" :title="store.locales=='zh' ? '文件分：所属文件摘要与查询的相似度（未加权原始通道分）' : 'File score: file-summary vector similarity (raw channel)'">{{ store.locales=='zh' ? '文件' : 'File' }} {{ formatPercent(it.fScore) }}</span>
              <span v-else-if="it.fMissing" style="color:var(--borderColor);white-space:nowrap;" :title="store.locales=='zh' ? '无文件摘要（文件摘要通道缺失）：不参与文件通道叠加，总分未受影响' : 'No file summary (file channel missing): no file-channel add-on'">{{ store.locales=='zh' ? '文件' : 'File' }} —</span>
              <span v-if="(it.hop || 0) > 0" style="color:#3F51B5;white-space:nowrap;" :title="store.locales=='zh' ? '多跳扩展实体数' : 'Multi-hop expansion'">H {{ it.hop }}</span>
              <span v-if="(it.boost || 1) > 1" style="color:#FF9800;font-weight:bold;white-space:nowrap;" :title="store.locales=='zh' ? `实体增强乘数: ${(it.boost || 1).toFixed(2)}` : `Entity boost: ${(it.boost || 1).toFixed(2)}`">×{{ (it.boost || 1).toFixed(2) }}</span>
              <span class="tm-entry-total" :title="store.locales=='zh' ? '总分：各通道按策略权重合成（含文件融合 / 乘性提升）' : 'Total: channels fused by strategy weights (incl. file/boost)'">{{ store.locales=='zh' ? '总分' : 'Total' }} {{ formatPercent(it.total || 0) }}</span>
            </div>
            <div class="tm-entry-body scoll">
              <block_md :content="it.content" :fontSize="'13px'" />
            </div>
          </div>
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
/* 位次分析表格单元格滚动限制（参考答案 / 命中的答案） */
.rank-cell-scroll {
  max-height: 50px;
  overflow-y: auto;
  word-break: break-word;
}

.algorithm-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s;
}

.algorithm-btn:hover {
  background-color: rgba(33, 150, 243, 0.1);
}

.algorithm-btn.active {
  background-color: #2196F3;
  color: white;
}

.answer-match {
  background-color: rgba(76, 175, 80, 0.1) !important;
  border-left: 3px solid #4CAF50 !important;
}

/* ===== 关联切片（命中判定基准）列：紧凑列表，内容区可滚动 ===== */
.gold-hit {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: #f44336;
  font-weight: bold;
}
.gold-hit.all { color: #4CAF50; }
.gold-hit.some { color: #FF9800; }
.gold-item {
  display: flex;
  gap: 5px;
  align-items: flex-start;
  padding: 3px 0;
  border-bottom: 1px dashed var(--borderColor);
}
.gold-item:last-child { border-bottom: none; }
.gold-ic { color: var(--borderColor); padding-top: 1px; flex-shrink: 0; }
.gold-item.hit .gold-ic { color: #4CAF50; }
.gold-meta { flex: 1; min-width: 0; }
.gold-name { color: #42A5F5; }
.gold-item.hit .gold-name { color: #4CAF50; }
.gold-content {
  margin-top: 2px;
  font-size: 9px;
  line-height: 1.4;
  color: var(--fontColor);
  opacity: 0.85;
  max-height: 75px;
  overflow: auto;
  word-break: break-word;
}

/* 检索切片命中「关联切片」徽标 */
.ref-badge {
  background: #4CAF50;
  color: #fff;
  font-size: 9px;
  line-height: 13px;
  padding: 0 4px;
  border-radius: 3px;
  white-space: nowrap;
}

.high-score {
  background-color: rgba(76, 175, 80, 0.05);
}

.medium-score {
  background-color: rgba(255, 152, 0, 0.05);
}

.low-score {
  background-color: rgba(244, 67, 54, 0.05);
}

.scoll {
  overflow: auto;
}

.ellipsis {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.button {
  background-color: var(--backgroundColor);
}

.button:hover {
  background-color: var(--menuColor);
}

/* 批量测试面板内的按钮（与工具栏按钮同一样式）选中态：预热配置切换高亮 */
.button.active {
  border-color: var(--fontActiveColor);
  color: var(--fontActiveColor);
  background-color: color-mix(in srgb, var(--fontActiveColor) 16%, var(--backgroundColor));
}
.button.active:hover {
  background-color: color-mix(in srgb, var(--fontActiveColor) 22%, var(--backgroundColor));
}

/* ===== 预热进度行（批量面板预热进度区） ===== */
.prewarm-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-size: 11px;
}
.prewarm-row-icon {
  width: 16px;
  text-align: center;
  color: var(--fontActiveColor);
  flex-shrink: 0;
}
.prewarm-row-name {
  flex-shrink: 0;
  min-width: 150px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.prewarm-row-bar {
  flex: 1;
  height: 5px;
  min-width: 60px;
  background: var(--borderColor);
  border-radius: 3px;
  overflow: hidden;
}
.prewarm-row-fill {
  height: 100%;
  background: #FF9800;
  border-radius: 3px;
  transition: width 0.15s;
}
.prewarm-row-status {
  flex-shrink: 0;
  min-width: 80px;
  text-align: right;
  color: var(--borderColor);
  white-space: nowrap;
}
.prewarm-row-status.running { color: #FF9800; }
.prewarm-row-status.done { color: #4CAF50; }

/* ===== 策略召回对比表格样式（批量测试面板标签页使用） ===== */
.as-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.as-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; color: var(--borderColor); font-size: 12px; padding: 30px 10px; }
.as-table th, .as-table td { padding: 4px 6px; border: 1px solid var(--borderColor); text-align: left; }
.as-table th { background: var(--menuColor); }
.as-table tbody tr { cursor: pointer; transition: background .12s; }
.as-table tbody tr:hover { background: color-mix(in srgb, var(--fontColor) 6%, transparent); }
.as-table tbody tr.as-best { background: color-mix(in srgb, #4CAF50 10%, transparent); }
.as-table tbody tr.expanded { background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent); }
.as-detail { border-bottom: 1px solid var(--borderColor); padding-top: 4px; }
.as-detail-title { font-size: 11px; font-weight: 600; margin-bottom: 3px; display: flex; align-items: center; gap: 4px; }
/* 分组切换（全部/单切片/复合） */
.as-group-tabs { display: inline-flex; gap: 2px; margin-left: auto; }
.as-group-tabs button {
  padding: 1px 8px; font-size: 10px; cursor: pointer;
  border: 1px solid var(--borderColor); border-radius: 3px;
  background: var(--backgroundColor); color: var(--fontColor);
}
.as-group-tabs button:hover { border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
.as-group-tabs button.on { border-color: var(--fontActiveColor); color: var(--fontActiveColor); background: color-mix(in srgb, var(--fontActiveColor) 12%, transparent); }
.as-detail-table tbody tr { cursor: default; }
.as-detail-table td { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 弹层头部 / 标题 / 关闭 / 动作（复用集群编辑 Agent 的 ae-* 类） */
.ae-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; flex-shrink: 0; }
.ae-title { font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 5px; }
.ae-title i { color: var(--fontActiveColor); font-size: 11px; }
.ae-note { font-size: 9px; font-weight: 400; color: var(--fontColor); opacity: .6; }
.ae-close {
  width: 20px; height: 20px; padding: 0; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--backgroundColor); color: var(--fontColor);
  cursor: pointer; font-size: 11px;
}
.ae-close:hover { color: #f44336; border-color: #f44336; }
.ae-body { display: flex; flex-direction: column; gap: 8px; overflow-y: auto; min-height: 0; }
.ae-actions { display: flex; gap: 6px; justify-content: flex-end; flex-shrink: 0; }
.ae-save, .ae-cancel {
  padding: 3px 12px; font-size: 11px; cursor: pointer;
  border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--backgroundColor); color: var(--fontColor);
}
.ae-save {
  background: color-mix(in srgb, var(--fontActiveColor) 16%, transparent);
  border-color: var(--fontActiveColor); color: var(--fontActiveColor);
}
.ae-save:hover { filter: brightness(1.1); }

/* ===== 测试结果切片格（只显示 命中√ + 总分 + 查看按钮） ===== */
/* 切片结果单元格(td)：总分填满整格并居中；命中/查看图标锚定整格(td)的左下/右下 */
.slice-cell {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  padding: 0 4px;
}
.slice-cell-total { font-size: 13px; font-weight: 700; color: var(--fontColor); }
/* 左下角标记容器：参考切片图标 + 命中对勾（锚定整个单元格底部左侧，并排） */
.slice-badges {
  position: absolute; left: 5px; bottom: 3px;
  display: inline-flex; align-items: center; gap: 5px;
}
.slice-hit-ic {
  color: #4CAF50; font-size: 12px; display: inline-flex; flex-shrink: 0;
}
.slice-ref-ic {
  color: #42A5F5; font-size: 12px; display: inline-flex; flex-shrink: 0;
}
.slice-view-ic {
  position: absolute; right: 5px; bottom: 3px;
  display: inline-flex; align-items: center;
  cursor: pointer; font-size: 13px;
  color: var(--fontColor); opacity: .55;
}
.slice-view-ic:hover { color: var(--fontActiveColor); opacity: 1; }

/* ===== 关联切片图标（参考答案列下方，替代整列/文字按钮） ===== */
.tm-gold-ic {
  display: inline-flex; align-items: center; gap: 4px;
  margin-top: 5px; cursor: pointer; font-size: 13px;
  color: var(--fontActiveColor);
}
.tm-gold-ic:hover { filter: brightness(1.15); }
.tm-gold-dot {
  font-size: 9px; line-height: 14px; padding: 0 4px;
  border-radius: 8px; background: var(--menuColor);
}
.tm-gold-ic.all .tm-gold-dot { color: #4CAF50; }
.tm-gold-ic.some .tm-gold-dot { color: #FF9800; }
.tm-gold-ic.none .tm-gold-dot { color: #f44336; }

/* ===== 切片 / 关联切片查看模态框 ===== */
.tm-overlay {
  position: fixed; inset: 0; z-index: 1000;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, .45); padding: 30px;
}
.tm-modal {
  display: flex; flex-direction: column; gap: 8px;
  width: min(860px, 92vw); height: min(80vh, 760px);
  background: var(--menuColor); border: 1px solid var(--borderColor); border-radius: 8px;
  padding: 10px 12px; box-shadow: 0 6px 24px rgba(0, 0, 0, .3);
}
.tm-modal-title { font-size: 12px; font-weight: 700; }
.tm-body { flex: 1; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; min-height: 0; }
.tm-entry { border: 1px solid var(--borderColor); border-radius: 6px; padding: 6px 8px; background: var(--backgroundColor); }
.tm-entry-head { display: flex; align-items: center; gap: 6px; font-size: 11px; }
.tm-entry-head > i { color: var(--fontActiveColor); }
.tm-entry-title { font-weight: 600; color: #42A5F5; max-width: 45%; }
.tm-entry-file { color: var(--borderColor); max-width: 35%; }
.tm-entry-badge { margin-left: auto; font-size: 10px; white-space: nowrap; display: inline-flex; align-items: center; gap: 3px; }
.tm-entry-badge.hit { color: #4CAF50; }
.tm-entry-badge.miss { color: var(--borderColor); }
.tm-entry-scores { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 10px; margin: 4px 0 2px; }
/* 总分：右对齐（相对本行其余分项） */
.tm-entry-total { margin-left: auto; font-weight: 700; white-space: nowrap; }
.tm-entry-body { max-height: 46vh; overflow: auto; margin-top: 4px; padding: 6px; border: 1px dashed var(--borderColor); border-radius: 4px; }

/* 工具栏无需横向滑块（覆盖 kb-view.css 的 overflow-x:auto）：空间不足时内容裁切，保持单行 */
.kt-toolbar { overflow-x: hidden; }

</style>