<script setup lang="ts">
import { ref, computed, reactive, watch, onMounted, nextTick } from 'vue'
import block_md from '@/components/block_md.vue'
import * as XLSX from 'xlsx'
import {usestore} from '@/store'
import { runStrategy, getEnabledStrategies, getStrategy } from '@/shared/graphrag/strategy'
import type { AgentStep } from '@/shared/graphrag/strategy'
import { computeBM25Score } from '@/shared/graphrag/search'
import { INGESTION_PRIMITIVES, prewarmEntityVectors, entityVectorCacheStats } from '@/shared/graphrag/primitives'
import type { RetrievalContext, IngestionContext } from '@/shared/graphrag/primitives'
import { cosineSimilarity } from '@/shared/kbRetrieval'
import * as kbAi from '@/shared/kbAiClient'
const store=usestore()

// 评测用嵌入模型（测试标签页选择）：留空则跟随设置中的嵌入模型（model.embed）
const effectiveEmbedModel = (): string => String(props.model?.testEmbed || props.model?.embed || '')

// 统一模型来源客户端（多 provider）：连接配置取自 store.AIconfig.llm[llmType]；
// 评测用嵌入模型（testEmbed）优先于设置中的嵌入模型，保证评测与向量化用同一模型
const kbSpec = () => {
  const m = props.model
  const embed = effectiveEmbedModel()
  return kbAi.buildSpecFromModel(embed && embed !== m?.embed ? { ...m, embed } : m, props.store)
}

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
  // 评测前置：确保切片向量就绪（精简模式 .kb 无向量时按当前嵌入模型懒补全），返回是否就绪
  ensureSliceVectors?: (onProgress: (msg: string) => void) => Promise<boolean>
  // 测试标签页「评测用嵌入模型」切换（留空=跟随设置中的嵌入模型）；返回 false 表示用户取消
  onTestEmbedChange?: (name: string) => Promise<boolean> | boolean | void
  // 预热「问题向量缓存」：补齐未向量化问题（提取问题默认不再即时向量化），返回补全条数
  ensureQuestionVectors?: (onProgress?: (msg: string) => void) => Promise<number>
  // 问题库问题数（用于判断「问题向量缓存」预热项是否可用）
  questionBankCount?: number
  // 未向量化的问题数（预热项「问题向量缓存」的已就绪判断）
  questionVectorMissing?: number
  /** 随 .kb 保存/加载的测试页结果快照（结构见 SavedTestData；来自 JSON 文件故按 any 接收并做运行时校验） */
  testData?: any
}

// 检索策略类型（与 QA 标签页的检索方式对齐，策略可配置）
type SearchAlgorithm = string

/** Agentic（智能路由）检索过程：工具调用轨迹 + 工具就绪汇总（供测试结果「检索过程」按钮回显） */
interface AgentTrace {
  /** 工具调用步骤（每轮每个工具一条，含参数与返回结果） */
  steps: AgentStep[]
  /** 本次实际暴露给模型的工具名（已按开关与数据就绪过滤） */
  tools: string[]
  /** 因索引未就绪被隐藏的工具名（模型不会调用） */
  droppedTools: string[]
  /** 模型未返回工具调用、退化为单次稠密检索 */
  degraded?: boolean
  /** 模型全程未调用任何检索工具（工具定义已下发但未被使用） */
  noToolCalls?: boolean
  /** 模型不调工具时已执行「确定性补充召回」 */
  fallback?: boolean
  /** 对话模型调用次数（含工具轮与最终作答） */
  llmCalls: number
}

/**
 * 测试页结果快照（随 .kb 保存/加载）。
 * 仅在「处理配置 → 保存测试结果到 KB 文件」开启时写入 .kb；切片正文一律不存，按 id 回源知识库，
 * 因此体积主要来自位次分析与智能路由的检索过程文本。
 */
interface SavedTestData {
  savedAt: string
  /** 测试页设置（复现同一批结果用） */
  settings: { searchNum: number; repeat: number; hitMode: 'slice' | 'text' | 'llm'; matchMode: 'precise' | 'fuzzy' }
  /** 每题最新一次检索结果 */
  testResults: TestResult[]
  /** 位次分析（含智能路由的检索过程轨迹） */
  rankAnalysisResults: RankAnalysisResult[]
  /** 策略召回对比汇总（含成本列与重复运行的均值/标准差） */
  allStrategyStats: any[]
  /** 策略 × 问题 × 切片明细（导出用） */
  allStrategySliceResults: any[]
  /** 重复运行的各轮汇总（恢复均值±标准差用） */
  strategyRuns: Record<string, StrategyRunStat[]>
}

// 测试结果类型
interface TestResult {  question: string
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
    /** LLM 判定模式下：该切片被大模型判为答案所在片段（紧随其后的位次不再重复标记） */
    llmHit?: boolean
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
  /** Agentic（智能路由）：本次检索的工具调用过程（其它策略为 undefined） */
  agent?: AgentTrace
  /** 大模型判定结果（仅 hitMode='llm' 且智能路由策略）：命中与否、最前位次与理由 */
  llmJudge?: { hit: boolean; rank: number; reason: string; error?: string }
  /** 本次检索的对话模型调用次数（Agentic 工具轮 + 最终作答；社区 Map-Reduce 等也有值）：成本对比用 */
  llmCalls?: number
  /** 本次检索的工具调用次数（Agentic：工具步骤数；其它策略为 0） */
  toolCalls?: number
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
  /** 判定基准类型：slice=按关联切片身份比对；text=按参考答案文本（手动/导入无关联切片）；llm=大模型判定 */
  refMode?: 'slice' | 'text' | 'llm'
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
  /** Agentic（智能路由）：本次检索的工具调用过程（供批量面板「检索过程」回看） */
  agent?: AgentTrace
  /** 大模型判定结果（仅大模型判定模式：命中与否、最前位次与理由） */
  llmJudge?: { hit: boolean; rank: number; reason: string; error?: string }
  /** 本次检索的对话模型调用次数（成本对比用） */
  llmCalls?: number
  /** 本次检索的工具调用次数（Agentic：agent.steps 长度；其它策略为 0） */
  toolCalls?: number
}

const props = defineProps<Props>()

// 测试相关状态（refs 与 questions 按行对齐：该行问题的关联切片判定基准）
const test = reactive({
  questions: [''] as string[],
  answers: [''] as string[],
  refs: [] as TestCaseRef[],
  /** 命中判定基准：'slice'=切片精准命中（默认，按关联切片身份比对）；'text'=答案命中（按参考答案文本匹配，旧口径）；
   *  'llm'=大模型判定（仅智能路由类策略可用：由对话模型对比检索片段与问题/参考答案给命中与位次） */
  hitMode: 'slice' as 'slice' | 'text' | 'llm',
  /** 答案命中子策略：'precise'=精准（切片须完整包含某段参考答案）；'fuzzy'=模糊（整段/反向前缀/分段/词比例任一命中，旧口径） */
  matchMode: 'fuzzy' as 'precise' | 'fuzzy',
  searchNum: 5 as any,
  /** 「批量测试所有策略」的重复次数：同批问题重复 N 轮，用于报告各指标均值±标准差（1=不重复） */
  repeat: 1 as any,
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
  strategyRuns.value = {}
  test.questionStatus = test.questions.map(() => ({
    text: store.locales=='zh' ? '未测试' : 'Not Tested',
    color: 'var(--borderColor)', icon: 'fa fa-circle-o'
  }))
  emitTestData()
}
watch(() => test.hitMode, () => { if (!test.isRunning && !restoringTestData) clearJudgementResults() })
watch(() => test.matchMode, () => { if (!test.isRunning && !restoringTestData) clearJudgementResults() })

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

// ===== 智能路由（Agentic）检索过程模态框：工具调用轨迹（轮次 / 工具 / 参数 / 结果） =====
const agentTrace = ref<{ question: string; heading: string; agent: AgentTrace; judge?: { hit: boolean; rank: number; reason: string; error?: string } } | null>(null)
const closeAgentTrace = () => { agentTrace.value = null }
// Agentic 工具中文标签（与问答侧「推理路径」面板同一套文案）
const agentToolLabel = (tool: string): string => {
  const map: Record<string, string> = {
    'kb_search': store.locales == 'zh' ? '事实检索' : 'kb_search',
    'file_search': store.locales == 'zh' ? '文件搜索' : 'file_search',
    'entity_link': store.locales == 'zh' ? '实体定位' : 'entity_link',
    'entity_slice': store.locales == 'zh' ? '实体切片' : 'entity_slice',
    'graph_hop': store.locales == 'zh' ? '图谱多跳' : 'graph_hop',
    'community_search': store.locales == 'zh' ? '社区搜索' : 'community_search',
  }
  return map[tool] || tool
}
const agentStepArgsText = (args: any): string => {
  if (!args || Object.keys(args).length === 0) return ''
  try { return JSON.stringify(args) } catch { return '' }
}
/** 步骤来源标签：系统预取 / 模型决策 / 模型工具 / 系统补检索 */
const agentStepKindLabel = (st: AgentStep): string => {
  const kind = st.kind || 'tool'
  if (kind === 'prefetch') return store.locales == 'zh' ? '系统预取' : 'pre-fetch'
  if (kind === 'model') return store.locales == 'zh' ? '模型决策' : 'model'
  if (kind === 'fallback') return store.locales == 'zh' ? '系统补检索' : 'fallback'
  return store.locales == 'zh' ? '模型工具' : 'tool'
}
// 某问题的智能路由检索过程（仅智能路由策略的结果有值；无则 undefined → 不显示「过程」按钮）
const rowAgent = (qIndex: number): AgentTrace | undefined => testResults.value[qIndex]?.agent
/** 该问题的「检索步骤数」= 模型工具调用 + 系统补检索（系统预取与模型决策不计入） */
const agentRetrievalStepCount = (agent?: AgentTrace): number =>
  (agent?.steps || []).filter(s => (s.kind || 'tool') === 'tool' || s.kind === 'fallback').length
const openAgentTrace = (source: { question?: string; agent?: AgentTrace; llmJudge?: { hit: boolean; rank: number; reason: string; error?: string } } | undefined | null) => {
  if (!source?.agent) return
  agentTrace.value = {
    question: source.question || '',
    heading: store.locales == 'zh' ? '智能路由检索过程' : 'Agentic retrieval trace',
    agent: source.agent,
    judge: source.llmJudge,
  }
}
const agentTraceRoundCount = computed(() =>
  (agentTrace.value?.agent.steps || []).reduce((max, s) => Math.max(max, s.round || 0), 0))

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
const rankRefMode = computed<'slice' | 'text' | 'llm'>(() => rankAnalysisResults.value[0]?.refMode || 'text')

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

// 未向量化切片数：精简模式（.kb 未保存向量）加载后全部缺失。缺失时 dense_score 拿不到切片向量，
// 各通道原始分恒为 0 → 所有「总分」都是 0%（排序退化为原始切片顺序，看起来「顺序正常」但并非按分数）
const missingSliceVectorCount = computed(() =>
  (props.blocks || []).filter((b: any) => !b.A_vector || b.A_vector.length === 0).length)

/** 评测前置：切片向量缺失时先懒补全（与问答路径一致），避免静默全 0 分；返回是否可就绪地开测 */
const ensureTestVectors = async (): Promise<boolean> => {
  if (!(props.blocks || []).length) {
    emit('updateState', store.locales=='zh' ? '没有切片数据，请先切片或选择已构建的知识库' : 'No slices: slice the KB or load a built KB first')
    return false
  }
  if (missingSliceVectorCount.value === 0) return true
  if (!props.ensureSliceVectors) {
    emit('updateState', store.locales=='zh'
      ? `有 ${missingSliceVectorCount.value} 个切片未向量化，相似度分将全为 0：请先在「切片」页向量化`
      : `${missingSliceVectorCount.value} slices have no vector → all scores would be 0; embed them in the Slice view first`)
    return false
  }
  emit('updateLiveState', store.locales=='zh'
    ? `评测前补齐切片向量 0/${missingSliceVectorCount.value}`
    : `Embedding slices 0/${missingSliceVectorCount.value}`)
  let ok = false
  try {
    ok = await props.ensureSliceVectors((msg: string) => emit('updateLiveState', msg))
  } catch (e) {
    console.error('切片向量补齐失败:', e)
  }
  emit('updateLiveState', '')
  if (!ok || missingSliceVectorCount.value > 0) {
    emit('updateState', store.locales=='zh'
      ? `切片向量化未完成（仍缺 ${missingSliceVectorCount.value} 个），总分不可用：请检查嵌入模型配置`
      : `Slice embedding incomplete (${missingSliceVectorCount.value} missing); scores unusable — check the embed model`)
    return false
  }
  return true
}

// 执行检索（统一走策略框架 runStrategy，与聊天共用同一套检索逻辑，消除实现漂移）
async function performSearch(question: string, searchNum: number, algorithm: SearchAlgorithm, answer?: string, ref?: TestCaseRef): Promise<{
  slices: TestResult['slices'],
  avgScore: number,
  timeMs: number,
  agent?: AgentTrace,
  llmCalls: number,
  toolCalls: number
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
      // 评测用嵌入模型优先（与实际向量化用的 kbSpec 保持一致）
      embed: effectiveEmbedModel(),
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
      // 实体链接 LLM 兜底开关（关闭后本体增强评测全程只用嵌入模型，不再逐题换载对话模型）
      entityLinkLlm: props.model.entityLinkLlm !== false,
      // Agentic 最终重排权重（评测与 QA 用同一配置，避免评测口径与实际问答不一致）
      agentSubQueryWeight: props.model.agentSubQueryWeight ?? 0.5,
    },
    services: kbAi.buildRetrievalServices(kbSpec(), {
      cosineSimilarity,
      computeBM25: computeBM25Score,
    }),
  }

  const sr = await runStrategy(algorithm, question, ctx, {}, { skipAnswer: true })

  // Agentic（智能路由）：把工具调用轨迹与工具就绪信息带回，供测试结果「检索过程」按钮回显
  // （runAgentic 已在 meta 内收口 running→done 的合并，其它策略无该字段）
  const agent: AgentTrace | undefined = getStrategy(algorithm)?.kind === 'agentic'
    ? {
        steps: (sr.meta.agentSteps || []) as AgentStep[],
        tools: sr.meta.agentTools || [],
        droppedTools: sr.meta.agentDroppedTools || [],
        degraded: !!sr.meta.agentDegraded,
        noToolCalls: !!sr.meta.agentNoToolCalls,
        fallback: !!sr.meta.agentFallback,
        llmCalls: sr.meta.llmCalls || 0,
      }
    : undefined

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

  return { slices, avgScore, timeMs: Math.round(performance.now() - startTime), agent, llmCalls: sr.meta.llmCalls || 0, toolCalls: agent?.steps.length || 0 }
}


// ==================== 大模型判定（仅智能路由类策略可用） ====================
// 由对话模型对比「检索到的片段」与问题 / 参考答案，判定是否命中以及最前命中位次。
// 用途：检索可能命中「同义但非同一切片」的内容（如改写过的答案），切片身份比对会漏判。
// 说明：判定发生在检索计时之外（不计入平均检索时间），但会累加进「模型调用 / 题」成本列。

/** 实际生效的判定模式：'llm' 仅对智能路由类策略有效，其它策略回退到 slice（有关联切片）或 text 口径 */
const effectiveHitMode = (algorithm: string, ref?: TestCaseRef): 'slice' | 'text' | 'llm' => {
  if (test.hitMode !== 'llm') return test.hitMode
  if (getStrategy(algorithm)?.kind === 'agentic') return 'llm'
  return hasGoldRef(ref) ? 'slice' : 'text'
}

/** 该策略当前是否支持大模型判定 */
const llmJudgeAvailable = computed(() => getStrategy(test.currentAlgorithm)?.kind === 'agentic')

/** 由对话模型判定「检索片段是否包含足以回答问题的内容」 */
const judgeByLlm = async (question: string, answer: string, slices: TestResult['slices']): Promise<{ hit: boolean; rank: number; reason: string; error?: string }> => {
  const top = slices.slice(0, Math.max(1, parseInt(String(test.searchNum)) || 5))
  const zh = store.locales == 'zh'
  const listText = top
    .map((s, i) => `${i + 1}. 《${s.label}》：${(sliceTextOf(s) || '').slice(0, 800)}`)
    .join('\n')
  const prompt = zh
    ? `你是检索评测员。判断下列「检索片段」是否包含足以回答问题的内容（参考答案仅供参考，以片段本身能否回答问题为准；同义改写、答案分散在片段中也算命中）。\n\n问题：${question}\n参考答案：${answer || '（未提供）'}\n\n检索片段：\n${listText}\n\n只输出 JSON，不要任何其他文字：{"hit": true|false, "rank": 最前命中位次（1-${top.length}，无命中填 0）, "reason": "一句话理由"}`
    : `You are a retrieval judge. Decide whether the retrieved snippets below contain enough content to answer the question (the reference answer is only a hint; judge by the snippets themselves; paraphrases or answers spread across snippets count as a hit).\n\nQuestion: ${question}\nReference answer: ${answer || '(none)'}\n\nSnippets:\n${listText}\n\nReply with JSON only, no other text: {"hit": true|false, "rank": first matching rank (1-${top.length}, 0 if none), "reason": "one-line reason"}`
  try {
    const raw = await kbAi.chat(kbSpec(), [{ role: 'user', content: prompt }], { format: 'json' } as any)
    const m = String(raw || '').match(/\{[\s\S]*\}/)
    if (!m) throw new Error('未返回 JSON')
    const obj = JSON.parse(m[0])
    const rank = Math.max(0, Math.min(top.length, Math.floor(Number(obj?.rank) || 0)))
    const hit = obj?.hit === true && rank > 0
    return { hit, rank: hit ? rank : 0, reason: String(obj?.reason || '') }
  } catch (e: any) {
    return { hit: false, rank: 0, reason: '', error: String(e?.message || e) }
  }
}

// 执行测试（支持算法选择；ref 为该问题关联切片判定基准）
const performTestChat = async (question: string, searchNum: number, algorithm: SearchAlgorithm, index?: number, answer?: string, ref?: TestCaseRef) => {
  try {
    const { slices, avgScore, timeMs, agent, llmCalls, toolCalls } = await performSearch(question, searchNum, algorithm, answer, ref)

    // 大模型判定（仅智能路由类策略）：在检索计时之外调用，避免判定耗时混入检索时间
    let llmJudge: TestResult['llmJudge']
    let judgeCalls = 0
    if (effectiveHitMode(algorithm, ref) === 'llm' && slices.length) {
      const j = await judgeByLlm(question, answer || '', slices)
      judgeCalls = 1
      llmJudge = j
      // 仅标记「最前命中位次」那一片（与切片命中口径一致：命中数=1），判定失败时不标记以避免误判为未命中
      if (!j.error) slices.forEach((s, i) => { s.llmHit = !!j.hit && i + 1 === j.rank })
    }

    const result: TestResult = {
      question: question,
      answer: answer || '',
      algorithm: algorithm,
      slices: slices,
      avgScore: avgScore,
      recallTimeMs: timeMs,
      agent,
      llmJudge,
      llmCalls: llmCalls + judgeCalls,
      toolCalls,
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
  // 判定模式按「该结果所属策略」解析：大模型判定仅智能路由类可用，其余策略回退 slice / text 口径
  const mode = effectiveHitMode(result.algorithm, ref)
  const sliceMode = mode === 'slice'
  const llmMode = mode === 'llm'
  // 切片精准命中：仅当该问题有关联切片时按身份比对；无关联切片则无判定基准，不产生位次记录
  const goldMode = sliceMode && hasGoldRef(ref)
  // 答案命中：一律按参考答案文本匹配（忽略关联切片）
  const textMode = mode === 'text'
  const answerText = result.answer?.trim()
  // 大模型判定：调用/解析失败（无判定结果）→ 视为无判定基准，不产生位次记录（避免误判为未命中）
  if (llmMode && (!result.llmJudge || result.llmJudge.error)) return

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

  // 判定基准成分清单：关联切片模式=关联切片标签；答案命中模式=参考答案分段；大模型判定=单一成分（整题命中与否）
  const parts = llmMode
    ? [store.locales=='zh' ? '大模型判定命中' : 'LLM judgement hit']
    : goldMode ? goldRefs.map(g => g.label) : textParts
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
    if (llmMode) {
      // 大模型判定：仅「最前命中位次」那一片计为命中（成分=整题）
      if (slice.llmHit) matchedAnswers.push(parts[0])
    } else if (goldMode) {
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
    //  - 大模型判定（llmMode）：按模型给出的命中位次标记
    //  - 切片命中（goldMode）：按关联切片成分命中（matchedAnswers > 0）
    //  - 答案命中（textMode）：按所选子策略统一判定 textSliceHit——
    //    precise=任一整段完整包含（等价于 matchedAnswers>0）；fuzzy=整段/反向前缀50字/分段/词比例任一命中
    const isHit = llmMode
      ? !!slice.llmHit
      : goldMode
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
  if (llmMode) {
    // 大模型判定：整题命中与否（单一成分）
    if (result.llmJudge?.hit) matchedPartSet.add(parts[0])
  } else {
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
    refMode: llmMode ? 'llm' : (goldMode ? 'slice' : 'text'),
    hitRate: overallHitRate,
    hitCount: matchedPartSet.size,
    totalAnswers: parts.length,
    matchedAnswers: Array.from(matchedPartSet),
    hitDetails,
    timestamp: result.timestamp,
    timeMs: result.recallTimeMs || 0,
    agent: result.agent,
    llmCalls: result.llmCalls || 0,
    toolCalls: result.toolCalls || 0,
    llmJudge: result.llmJudge
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

  if (!(await ensureTestVectors())) return

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
    // 无判定基准的情况（不按分数误判，明确提示）：切片命中但无关联切片；或大模型判定未得到结果（调用/解析失败）
    const notJudgeable = (effectiveHitMode(test.currentAlgorithm, test.refs?.[index]) === 'slice' && !hasGoldRef(test.refs?.[index]))
      || (effectiveHitMode(test.currentAlgorithm, test.refs?.[index]) === 'llm' && !result?.llmJudge)
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
    // 单测结果同样进入 .kb 快照（保留上一批统计数据，便于逐题补测）
    emitTestData()
    
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

// ===== 评测用嵌入模型（当前模型来源可用；留空=跟随设置中的嵌入模型） =====
// 选择只覆盖本知识库评测/检索时实际使用的嵌入模型，不改动设置里的嵌入模型；随 .kb 保存（config.testEmbedModel）
const testEmbedSel = ref('')
watch(() => props.model?.testEmbed, (v) => {
  const s = String(v || '')
  if (testEmbedSel.value !== s) testEmbedSel.value = s
}, { immediate: true })

/** 嵌入模型名判定（与 knowRAG.autoSetEmbedModel / configManager 保持一致） */
const isEmbedModelName = (name: string) => /^(bge|text-embedding|ada-embedding|instructor|e5|gte|m3e)|embed|embedding/i.test(name || '')

/** 下拉候选：当前来源可用模型中的嵌入模型 + 当前生效模型（不在列表时补上，避免已有选择丢失） */
const embedModelOptions = computed<string[]>(() => {
  const out: string[] = []
  const add = (n: string) => { if (n && !out.includes(n)) out.push(n) }
  const list = (props.model?.list || []).map((m: any) => String(m?.name || '')).filter(Boolean)
  list.filter((n: string) => isEmbedModelName(n)).forEach(add)
  add(effectiveEmbedModel())
  return out
})

const followEmbedLabel = computed(() => store.locales == 'zh'
  ? `跟随设置（${props.model?.embed || '未配置'}）`
  : `Follow settings (${props.model?.embed || 'not set'})`)

/** 切换评测用嵌入模型：交给父级确认/清空旧向量并落盘；取消则还原下拉选择 */
const onTestEmbedModelChange = async () => {
  const next = String(testEmbedSel.value || '')
  const ok = await props.onTestEmbedChange?.(next)
  if (ok === false) testEmbedSel.value = String(props.model?.testEmbed || '')
}

/** 模型列表为空/来源切换后，从当前 AI 来源重新拉取（无需进入设置） */
const refreshEmbedModels = () => { props.getModel?.() }

// ===== 批量测试面板：预热配置（摘要生成 + 各类向量缓存，时间单独计时、不计入检索） =====
const prewarm = reactive({
  summary: false, summaryVec: false, sliceVec: false, questionVec: false, entity: false, community: false,
})
const prewarmTimes = ref<Record<string, number>>({})
const prewarmTotalMs = ref(0)
const prewarmRunning = ref(false)
const prewarmDone = ref(false)

// 预热运行进度：每项状态（待处理/进行中/完成）+ 已处理数量；运行中实时更新
const prewarmItemStates = reactive<Record<string, { status: 'pending' | 'running' | 'done'; index: number; total: number; detail: string }>>({})
const prewarmRunningItemKey = ref('')

interface PrewarmItem { key: 'summary' | 'summaryVec' | 'sliceVec' | 'questionVec' | 'entity' | 'community'; label: string; labelEn: string; icon: string }
// 预热项：摘要生成与各类向量缓存分开（生成只调对话模型、向量化只调嵌入模型，各自一轮内不换载模型）
const PREWARM_ITEMS: PrewarmItem[] = [
  { key: 'summary', label: '批量生成摘要（缺摘要才生成，已有摘要复用）', labelEn: 'Generate file summaries (reuse existing)', icon: 'fa-file-text-o' },
  { key: 'summaryVec', label: '摘要向量缓存（只嵌入已有摘要，不重新生成）', labelEn: 'Summary vectors (embed existing summaries only)', icon: 'fa-magnet' },
  { key: 'sliceVec', label: '切片向量缓存（补齐未向量化切片）', labelEn: 'Slice vectors (embed missing slices)', icon: 'fa-cubes' },
  { key: 'questionVec', label: '问题向量缓存（补齐未向量化问题）', labelEn: 'Question vectors (embed missing questions)', icon: 'fa-question-circle-o' },
  { key: 'entity', label: '实体向量缓存', labelEn: 'Entity vectors (cache)', icon: 'fa-cube' },
  { key: 'community', label: '社区报告（预生成报告）', labelEn: 'Community reports (pre-generate)', icon: 'fa-sitemap' },
]

/** 知识库实际引用到的文件（切片所属文件；可能是建库时的路径，文件夹改名后与当前列表不同名） */
const referencedFilePaths = computed(() => {
  const set = new Set<string>()
  for (const b of (props.blocks || []) as any[]) if (b?.filePath) set.add(String(b.filePath))
  return set
})
const fileNameOf = (p: string) => String(p || '').replace(/\\/g, '/').split('/').pop() || ''

/** 文件自带摘要（md frontmatter 元信息 / attributes）：按完整路径 + 文件名（同名兜底）建索引 */
const frontmatterSummaries = computed(() => {
  const byPath = new Map<string, string>()
  const byName = new Map<string, string>()
  for (const f of (props.files || []) as any[]) {
    if (!f?.path) continue
    const text = getFileSummaryText(f)
    if (!text) continue
    byPath.set(String(f.path), text)
    const name = fileNameOf(f.path)
    if (name && !byName.has(name)) byName.set(name, text)
  }
  return { byPath, byName }
})

/** 取某文件（按切片记录的路径）已有的摘要文本：优先索引，其次「同名文件」的自带摘要 */
const existingSummaryOf = (path: string): string => {
  const idx = (props.fileIndex as any)?.get?.(path)
  if (idx?.content) return String(idx.content)
  const fm = frontmatterSummaries.value
  return fm.byPath.get(path) || fm.byName.get(fileNameOf(path)) || ''
}

/** 已有摘要文本的文件数（索引或文件元信息；= 无需再生成的） */
const summaryTextCount = computed(() => {
  let n = 0
  for (const p of referencedFilePaths.value) if (existingSummaryOf(p)) n++
  return n
})
/** 已有摘要向量的文件数（只有索引里的向量可用于检索） */
const summaryVecCount = computed(() => {
  let n = 0
  const m = props.fileIndex as any
  if (!m?.get) return 0
  for (const p of referencedFilePaths.value) {
    const v = m.get(p)
    if (v?.content && v.vector && v.vector.length) n++
  }
  return n
})

/**
 * 把「文件自带摘要」（md frontmatter 元信息）导入文件摘要索引：
 * - 按切片记录的文件路径写入（同名文件也能匹配，兼容「建库后文件夹改名/移动」的情况）；
 * - 只补摘要文本、不嵌入（向量交给「摘要向量缓存」或策略自动补齐）；
 * - 导入后「批量生成摘要」会跳过这些文件，不再重复调用大模型。
 */
const importFrontmatterSummaries = (): number => {
  const fi = props.fileIndex as any
  if (!fi?.set) return 0
  let n = 0
  for (const p of referencedFilePaths.value) {
    if (existingSummaryOf(p) && fi.get(p)?.content) continue // 索引里已有
    const text = existingSummaryOf(p)
    if (!text) continue
    const cur = fi.get(p)
    fi.set(p, { content: text, vector: cur?.vector, contentHash: cur?.contentHash })
    n++
  }
  return n
}
/** 实体向量缓存状态（预热项「实体向量缓存」） */
const entityVecStats = computed(() => {
  const entities = props.getCurrentOntologyContext?.()?.entities || []
  return entityVectorCacheStats(entities)
})

// 可选预热项：按当前知识库数据状态过滤（对应数据缺失时该项不可选）。
// 全部不可选（length === 0）时，隐藏工具栏预热按钮 / toggle 与批量面板中的预热说明。
const availablePrewarmItems = computed(() => {
  const hasFiles = (props.files?.length || 0) > 0
  const hasSlices = (props.blocks?.length || 0) > 0
  const hasSummaryText = summaryTextCount.value > 0
  const hasQuestions = (props.questionBankCount || 0) > 0
  const hasEntities = (props.getCurrentOntologyContext?.()?.entities?.length || 0) > 0
  const hasCommunity = (props.communityResult?.count || 0) > 0 || (props.communityReports?.length || 0) > 0
  return PREWARM_ITEMS.filter(item => {
    // 摘要由切片内容按文件聚合生成，故以「有切片」为准（.kb 加载时 files 列表可能为空）
    if (item.key === 'summary' && !hasSlices) return false
    if (item.key === 'summaryVec' && !hasSummaryText) return false

    if (item.key === 'sliceVec' && !hasSlices) return false
    if (item.key === 'questionVec' && !hasQuestions) return false
    if (item.key === 'entity' && !hasEntities) return false
    if (item.key === 'community' && !hasCommunity) return false
    return true
  })
})

// 已勾选且可选的预热项（预热实际执行的顺序）
const prewarmEnabledItems = computed(() => availablePrewarmItems.value.filter(item => prewarm[item.key]))

// 预热浮层开关：所有预热项与状态、进度、耗时都集中在浮层里，工具栏只留一个入口按钮
const prewarmPanelOpen = ref(false)
const selectAllPrewarm = (on: boolean) => { for (const it of availablePrewarmItems.value) prewarm[it.key] = on }

/**
 * 预热项「已就绪」判断：对应数据（摘要 / 向量）已齐备 → 无需再跑，执行时会直接跳过。
 * 用于按钮配色（就绪用 fontActiveColor）与提示文案。
 */
const prewarmReady = (key: string): boolean => {
  switch (key) {
    case 'summary':
      return referencedFilePaths.value.size > 0 && summaryTextCount.value >= referencedFilePaths.value.size
    case 'summaryVec':
      return summaryTextCount.value > 0 && summaryVecCount.value >= summaryTextCount.value
    case 'sliceVec':
      return (props.blocks?.length || 0) > 0 && missingSliceVectorCount.value === 0
    case 'questionVec':
      return (props.questionBankCount || 0) > 0 && (props.questionVectorMissing ?? 1) === 0
    case 'entity': {
      const s = entityVecStats.value
      return s.total > 0 && s.cached >= s.total
    }
    case 'community': {
      const total = props.communityResult?.count || 0
      return total > 0 && (props.communityReports?.length || 0) >= total
    }
    default:
      return false
  }
}

/** 就绪状态摘要（按钮 title 后缀：已就绪 / 还有多少待处理） */
const prewarmStatusText = (key: string): string => {
  const zh = store.locales == 'zh'
  if (prewarmReady(key)) return zh ? '✅ 已就绪（执行时会跳过，不重复生成）' : '✅ Ready (skipped on run)'
  switch (key) {
    case 'summary': {
      const miss = Math.max(0, referencedFilePaths.value.size - summaryTextCount.value)
      return zh ? `待生成摘要：${miss} 个文件` : `${miss} file(s) need summaries`
    }
    case 'summaryVec': {
      const miss = Math.max(0, summaryTextCount.value - summaryVecCount.value)
      return zh ? `待向量化摘要：${miss} 个` : `${miss} summary vector(s) missing`
    }
    case 'sliceVec':
      return zh ? `待向量化切片：${missingSliceVectorCount.value} 个` : `${missingSliceVectorCount.value} slice vector(s) missing`
    case 'questionVec':
      return zh ? `待向量化问题：${props.questionVectorMissing ?? 0} 条` : `${props.questionVectorMissing ?? 0} question vector(s) missing`
    case 'entity': {
      const s = entityVecStats.value
      return zh ? `待缓存实体向量：${Math.max(0, s.total - s.cached)} 个` : `${Math.max(0, s.total - s.cached)} entity vector(s) missing`
    }
    case 'community': {
      const total = props.communityResult?.count || 0
      const miss = Math.max(0, total - (props.communityReports?.length || 0))
      return zh ? `待生成报告：${miss} 份` : `${miss} report(s) missing`
    }
    default:
      return ''
  }
}

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
  const embedBatchFn = async (texts: string[]) => ingestServices.embedBatch(texts)
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
  // summarize_file 的摄取上下文（摘要生成 / 摘要向量缓存共用）
  const buildSummaryCtx = (key: string): IngestionContext => ({
    blocks: props.blocks as any,
    config: { url: props.model.url, embed: props.model.embed, chat: props.model.chat, process: props.model.process, processPrompt: props.model.processPrompt, think: props.model.think },
    services: { embed: embedFn, embedBatch: embedBatchFn, streamChat: streamChatFn },
    fileIndex: props.fileIndex as any,
    onProgress: onItemProgress(key),
    isCancelled: () => false,
  })
  // 先把 md 元信息（frontmatter 摘要）导入文件摘要索引：已有摘要的文件不会被重新生成
  const importedCount = importFrontmatterSummaries()

  try {
    for (const item of items) {
      const key = item.key
      const t0 = performance.now()
      prewarmRunningItemKey.value = key
      prewarmItemStates[key].status = 'running'
      try {
        if (key === 'summary') {
          // 只生成缺失的摘要（已有摘要一律复用，不重新生成），不在本项里向量化
          const r = await INGESTION_PRIMITIVES.summarize_file(buildSummaryCtx(key), { reuseExistingSummary: true, skipEmbed: true }) as { processed: number; failed: number; skipped?: number }
          const st = prewarmItemStates.summary
          if (st) st.detail = `摘要生成: 复用 ${r.skipped ?? 0}${importedCount ? `（含文件元信息 ${importedCount}）` : ''} / 新增 ${r.processed} / 失败 ${r.failed}`
        } else if (key === 'summaryVec') {
          // 只嵌入已有摘要文本，不调用 LLM 生成（无摘要的文件跳过）
          const r = await INGESTION_PRIMITIVES.summarize_file(buildSummaryCtx(key), { embedOnly: true }) as { processed: number; failed: number; skipped?: number }
          const st = prewarmItemStates.summaryVec
          if (st) st.detail = `摘要向量: 已嵌入 ${r.processed} / 无摘要跳过 ${r.skipped ?? 0} / 失败 ${r.failed}`
        } else if (key === 'sliceVec') {
          // 切片向量缓存：补齐未向量化切片（与评测前自动补齐同一路径，精简模式 .kb 必需）
          const st = prewarmItemStates.sliceVec
          if (st) st.detail = '正在补齐切片向量...'
          const ok = await props.ensureSliceVectors?.((msg) => onItemProgress(key)(msg))
          if (st) st.detail = ok ? '切片向量已就绪' : '切片向量补齐未完成（检查嵌入模型配置）'
        } else if (key === 'questionVec') {
          // 问题向量缓存：补齐未向量化问题（Q 增强通道数据源；提取问题默认不再即时向量化）
          const st = prewarmItemStates.questionVec
          if (st) st.detail = '正在补齐问题向量...'
          const n = await props.ensureQuestionVectors?.((msg) => onItemProgress(key)(msg))
          if (st) st.detail = `问题向量: 已补全 ${n ?? 0} 条`
        } else if (key === 'entity') {
          const entities = props.getCurrentOntologyContext?.()?.entities || []
          await prewarmEntityVectors(entities, embedFn, embedBatchFn, (done, total) => {
            const st = prewarmItemStates.entity
            if (st) { st.index = done; st.total = total; st.detail = `实体向量化: ${done}/${total}` }
          })
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
  // 仅当「本次要测试的策略」本身用到 file_score 才自动补齐文件摘要向量，
  // 避免单测相似度等纯切片策略也被其它启用策略（文件增强/本体/多跳）的文件依赖误触发
  const defs = (algoIds && algoIds.length)
    ? getEnabledStrategies().filter(d => algoIds.includes(d.id))
    : getEnabledStrategies()
  const needFile = defs.some((def: any) =>
    (def?.steps || []).some((s: any) => s?.primitive === 'file_score'))
  if (!needFile) return
  if (prewarmReady('summaryVec')) return // 已有摘要的向量均已就绪，无需补齐
  if (_fileWarmFailed) return // 已尝试补齐但失败，本次会话不再重复打扰
  _fileWarmFailed = true
  // 先把「文件自带摘要」（markdown frontmatter 元信息 / attributes）导入索引（按切片路径 + 同名兜底），
  // 再只对「已有摘要但缺向量」的文件统一嵌入：不调用 LLM 生成摘要
  importFrontmatterSummaries()
  if (summaryTextCount.value === 0) return // 库中无任何摘要文本 → 无可向量化内容
  const total = summaryTextCount.value
  prewarmRunning.value = true
  prewarmRunningItemKey.value = 'summaryVec'
  prewarmItemStates.summaryVec = { status: 'running', index: 0, total, detail: '' }
  // 提示走底部状态栏（updateLiveState），便于跨视图看到文件摘要向量化的进度
  emit('updateLiveState', store.locales=='zh'
    ? `文件摘要向量化（文件增强通道）0/${total}`
    : `Vectorizing file summaries (file-enhance) 0/${total}`)
  try {
    const ingestServices = kbAi.buildIngestionServices(kbSpec())
    const ctx: IngestionContext = {
      blocks: props.blocks as any,
      config: { url: props.model.url, embed: props.model.embed, chat: props.model.chat, process: props.model.process, processPrompt: props.model.processPrompt, think: props.model.think },
      services: {
        embed: (t: string) => ingestServices.embed(t),
        embedBatch: (ts: string[]) => ingestServices.embedBatch(ts),
        streamChat: (m: any[], cb: (c: string) => void) => ingestServices.streamChat(m, cb),
      },
      fileIndex: props.fileIndex as any,
      onProgress: (msg: string) => {
        const st = prewarmItemStates.summaryVec
        const m = msg.match(/(\d+)\s*\/\s*(\d+)/)
        if (st && m) { st.index = +m[1]; st.total = +m[2]; st.detail = msg }
        emit('updateLiveState', msg)
      },
      isCancelled: () => false,
    }
    await INGESTION_PRIMITIVES.summarize_file(ctx, { embedOnly: true })
    const st = prewarmItemStates.summaryVec
    if (st) st.detail = `文件摘要向量化完成: ${summaryVecCount.value}/${total}`
  } catch (e) {
    console.error('自动向量化文件摘要失败（文件增强将退化为纯切片）：', e)
  } finally {
    prewarmRunning.value = false
    prewarmRunningItemKey.value = ''
    if (prewarmItemStates.summaryVec) prewarmItemStates.summaryVec.status = 'done'
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

// ===== 批量测试（当前策略 / 全部策略）暂停与停止 =====
// 暂停：在「问题之间」停下（当前问题的检索/推理跑完即可暂停），可继续；停止：立即结束剩余问题，已测结果保留
const batchCtl = reactive({ paused: false, aborted: false })
/** 正在运行的批量类型：''=未运行 / 'one'=当前策略 / 'all'=全部策略（决定按钮组显示暂停还是启动） */
const batchRunKind = ref<'' | 'one' | 'all'>('')

const resetBatchCtl = () => { batchCtl.paused = false; batchCtl.aborted = false }

/** 暂停等待：暂停中挂起；返回 false 表示已停止（调用方应结束循环） */
const waitWhilePaused = async (): Promise<boolean> => {
  while (batchCtl.paused && !batchCtl.aborted) {
    await new Promise(resolve => setTimeout(resolve, 120))
  }
  return !batchCtl.aborted
}

const pauseBatchTest = () => {
  if (!test.isRunning || batchCtl.paused) return
  batchCtl.paused = true
  emit('updateState', store.locales=='zh' ? '批量测试已暂停（当前问题跑完后停下），点击「继续」或「停止」' : 'Batch test paused (after the current question); click Resume or Stop')
}

const continueBatchTest = () => {
  if (!batchCtl.paused) return
  batchCtl.paused = false
  emit('updateState', store.locales=='zh' ? '继续批量测试...' : 'Resuming batch test...')
}

const stopBatchTest = () => {
  if (!test.isRunning && !batchCtl.paused) return
  batchCtl.aborted = true
  batchCtl.paused = false
}

// 批量测试（使用当前算法）
const runBatchTest = async () => {
  // 已有批量测试（当前 / 全部策略）在跑：避免并发写进度与结果
  if (test.isRunning) {
    emit('updateState', store.locales=='zh' ? '已有批量测试正在运行，请先停止或等待完成' : 'A batch test is already running — stop it or wait for it to finish')
    return
  }
  const validQuestions = test.questions.filter((q, i) => q && q.trim())
  if (validQuestions.length === 0) {
    emit('updateState', store.locales=='zh' ? '请输入至少一个有效问题' : 'Please enter at least one valid question')
    return
  }

  // 先补齐切片向量再计时开测（向量化耗时不计入检索时间）
  if (!(await ensureTestVectors())) return
  if (test.hitMode === 'llm' && !llmJudgeAvailable.value) {
    emit('updateState', store.locales=='zh'
      ? `大模型判定仅对智能路由类策略生效：当前策略「${getAlgorithmLabel(test.currentAlgorithm)}」将按切片/答案口径判定`
      : `LLM judgement applies to agentic strategies only; "${getAlgorithmLabel(test.currentAlgorithm)}" will use slice/answer judging`)
  }

  resetBatchCtl()
  batchRunKind.value = 'one'
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
  // 同策略重测的「重复轮汇总」也一并作废（否则对比表的均值/标准差会混入旧轮次）
  if (strategyRuns.value[test.currentAlgorithm]) {
    const next = { ...strategyRuns.value }
    delete next[test.currentAlgorithm]
    strategyRuns.value = next
  }

  // 仅当本次被测策略需要 file 通道时，自动对文件自带摘要向量化补齐（幂等、失败不阻断）
  await ensureStrategyChannelsReady([test.currentAlgorithm])
  
  for (let i = 0; i < test.questions.length; i++) {
    // 暂停/停止：在问题之间生效（已测结果保留）
    if (!(await waitWhilePaused())) break
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
      // 无判定基准的情况（不按分数误判，明确提示）：切片命中但无关联切片；或大模型判定未得到结果
      const notJudgeable = (effectiveHitMode(test.currentAlgorithm, test.refs?.[i]) === 'slice' && !hasGoldRef(test.refs?.[i]))
        || (effectiveHitMode(test.currentAlgorithm, test.refs?.[i]) === 'llm' && !result?.llmJudge)
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
  
  const aborted = batchCtl.aborted
  batchRunKind.value = ''
  resetBatchCtl()
  test.isRunning = false
  lastUpdateTime.value = new Date().toLocaleTimeString()
  // 实时刷新策略召回对比：批测单个策略完成后该策略出现一行数据
  updateStrategyStats()
  // 批量结果进入 .kb 快照
  emitTestData()
  
  const answerMatches = testResults.value.reduce((count, result) => {
    if (!result || !result.slices) return count
    return count + result.slices.filter((s: any) => s.containsAnswer).length
  }, 0)
  
  const doneCount = testResults.value.filter(Boolean).length
  if (aborted) {
    emit('updateState', store.locales=='zh'
      ? `批量测试已停止：已测 ${doneCount}/${test.questions.length} 个问题（结果保留）`
      : `Batch test stopped: ${doneCount}/${test.questions.length} questions tested (results kept)`)
    return
  }
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
  /** 平均对话模型调用次数 / 题（成本对比：Agentic 工具轮、社区 Map-Reduce 都会计入） */
  avgLlmCalls: number
  /** 平均工具调用次数 / 题（Agentic 专用：只统计模型自己调用的工具；其它策略为 0） */
  avgToolCalls: number
  /** 平均「系统补检索」次数 / 题（仅当模型不调工具时执行；用于判断模型是否真的会用工具） */
  avgFallbackCalls?: number
  /** 工具调用分布（工具名 → 平均次数/题），用于消融实验确认工具真被调用 */
  toolDistribution: Record<string, number>
  /** 已完成重复轮数（>1 时各指标附标准差） */
  runs: number
  /** 重复运行的标准差（仅 runs>1 有意义；缺失表示未重复） */
  std?: Partial<Record<'recallRate' | 'avgHitRate' | 'hitAt1' | 'mrr' | 'completeRate' | 'avgFirstRank' | 'avgTimeMs' | 'avgLlmCalls' | 'avgToolCalls', number>>
}>>([])

/** 单轮（一次完整跑完全部问题）的策略汇总：重复运行时按轮聚合，得到均值±标准差 */
interface StrategyRunStat {
  recallRate: number
  avgHitRate: number
  hitAt1: number
  mrr: number
  completeRate: number
  avgFirstRank: number
  avgTimeMs: number
  avgLlmCalls: number
  avgToolCalls: number
}
/** strategyId → 各轮汇总（每次「全部策略」批量测试开始时清空） */
const strategyRuns = ref<Record<string, StrategyRunStat[]>>({})

/** 均值 / 样本标准差（n<2 时标准差为 undefined） */
const meanOf = (list: number[]): number => (list.length ? list.reduce((s, x) => s + x, 0) / list.length : 0)
const stdOf = (list: number[]): number | undefined => {
  if (list.length < 2) return undefined
  const m = meanOf(list)
  return Math.sqrt(list.reduce((s, x) => s + (x - m) * (x - m), 0) / (list.length - 1))
}
/** 指标展示：有标准差时「均值 ± 标准差」 */
const fmtStat = (mean: number, std: number | undefined, scale = 100, digits = 1): string => {
  const base = (mean * scale).toFixed(digits)
  return std === undefined ? base : `${base} ± ${(std * scale).toFixed(digits)}`
}

// 分组统计视图：全部 / 单切片 / 复合（成本列与重复标准差为策略级，不随分组变化）
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
      avgLlmCalls: s.avgLlmCalls,
      avgToolCalls: s.avgToolCalls,
      avgFallbackCalls: s.avgFallbackCalls,
      toolDistribution: s.toolDistribution,
      runs: s.runs,
      std: undefined as typeof s.std,
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
    sumLlmCalls: number
    sumToolCalls: number
    sumFallbackCalls: number
    toolCalls: Record<string, number>
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
      sumLlmCalls: 0, sumToolCalls: 0, sumFallbackCalls: 0, toolCalls: {},
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
    // 成本：对话模型调用次数 + 工具调用分布（工具调用用于消融实验核对「工具是否真被调用」）
    cur.sumLlmCalls += r.llmCalls || 0
    // 工具分布只统计「模型自己调用的工具」；系统预取/系统补检索/模型决策不计入（补检索单列，见 avgFallbackCalls）
    for (const st of (r.agent?.steps || [])) {
      const kind = st.kind || 'tool'
      if (kind === 'tool') {
        cur.sumToolCalls += 1
        cur.toolCalls[st.tool] = (cur.toolCalls[st.tool] || 0) + 1
      } else if (kind === 'fallback') {
        cur.sumFallbackCalls += 1
      }
    }
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
      avgLlmCalls: a.testedCount > 0 ? a.sumLlmCalls / a.testedCount : 0,
      avgToolCalls: a.testedCount > 0 ? a.sumToolCalls / a.testedCount : 0,
      avgFallbackCalls: a.testedCount > 0 ? a.sumFallbackCalls / a.testedCount : 0,
      // 工具分布按「平均次数/题」归一，便于消融实验直接读「该工具平均每题被调用几次」
      toolDistribution: Object.fromEntries(
        Object.entries(a.toolCalls as Record<string, number>).map(([k, v]) => [k, a.testedCount > 0 ? v / a.testedCount : 0]),
      ),
      runs: 1,
    }
  }
  const stats = Array.from(agg.values()).map(fmt).sort((a, b) => {
    // 冠军判定：先比召回率（高者胜）；相同再比平均位次（小者胜，-1=无命中视为最差）；仍相同比平均答案命中率（高者胜）
    if (b.recallRate !== a.recallRate) return b.recallRate - a.recallRate
    const ra = a.avgFirstRank > 0 ? a.avgFirstRank : Number.MAX_VALUE
    const rb = b.avgFirstRank > 0 ? b.avgFirstRank : Number.MAX_VALUE
    if (ra !== rb) return ra - rb
    return b.avgHitRate - a.avgHitRate
  })
  // 重复运行（runs>1）时，用各轮汇总覆盖为「均值 ± 标准差」，用于判断差异是否稳定（见 fmtStat）
  allStrategyStats.value = stats.map(s => withRunStd(s))
}

/**
 * 把某策略「刚跑完的这一轮」汇总入 strategyRuns（重复运行时用于均值±标准差）。
 * 必须在跑完该策略全部问题后调用：此时 rankAnalysisResults 中该策略的行只属于本轮。
 */
const snapshotStrategyRun = (strategyId: string) => {
  const rows = rankAnalysisResults.value.filter(r => r.algorithm === strategyId)
  if (!rows.length) return
  const hit = rows.filter(r => r.foundCount > 0).length
  const ranked = rows.filter(r => r.firstRank > 0)
  const sumFirst = ranked.reduce((s, r) => s + r.firstRank, 0)
  const stat: StrategyRunStat = {
    recallRate: hit / rows.length,
    avgHitRate: rows.reduce((s, r) => s + (r.hitRate || 0), 0) / rows.length,
    hitAt1: rows.filter(r => r.firstRank === 1).length / rows.length,
    mrr: rows.reduce((s, r) => s + (r.firstRank > 0 ? 1 / r.firstRank : 0), 0) / rows.length,
    completeRate: rows.filter(r => (r.hitRate || 0) >= 1).length / rows.length,
    avgFirstRank: ranked.length ? sumFirst / ranked.length : -1,
    avgTimeMs: rows.reduce((s, r) => s + (r.timeMs || 0), 0) / rows.length,
    avgLlmCalls: rows.reduce((s, r) => s + (r.llmCalls || 0), 0) / rows.length,
    avgToolCalls: rows.reduce((s, r) => s + (r.toolCalls || 0), 0) / rows.length,
  }
  const list = strategyRuns.value[strategyId] || []
  list.push(stat)
  strategyRuns.value = { ...strategyRuns.value, [strategyId]: list }
}

/** 用各轮汇总覆盖展示指标为均值 + 标准差（仅 1 轮时原样返回） */
const withRunStd = (s: (typeof allStrategyStats.value)[number]) => {
  const runs = strategyRuns.value[s.strategyId] || []
  if (runs.length < 2) return { ...s, runs: runs.length || 1 }
  const pick = (fn: (r: StrategyRunStat) => number) => ({
    mean: meanOf(runs.map(fn)),
    std: stdOf(runs.map(fn)),
  })
  const recall = pick(r => r.recallRate)
  const hitRate = pick(r => r.avgHitRate)
  const hit1 = pick(r => r.hitAt1)
  const mrr = pick(r => r.mrr)
  const complete = pick(r => r.completeRate)
  const firstRank = pick(r => (r.avgFirstRank > 0 ? r.avgFirstRank : 0))
  const time = pick(r => r.avgTimeMs)
  const llm = pick(r => r.avgLlmCalls)
  const tools = pick(r => r.avgToolCalls)
  return {
    ...s,
    recallRate: recall.mean,
    avgHitRate: hitRate.mean,
    hitAt1: hit1.mean,
    mrr: mrr.mean,
    completeRate: complete.mean,
    avgFirstRank: firstRank.mean > 0 ? firstRank.mean : -1,
    avgTimeMs: time.mean,
    avgLlmCalls: llm.mean,
    avgToolCalls: tools.mean,
    runs: runs.length,
    std: {
      recallRate: recall.std,
      avgHitRate: hitRate.std,
      hitAt1: hit1.std,
      mrr: mrr.std,
      completeRate: complete.std,
      avgFirstRank: firstRank.std,
      avgTimeMs: time.std,
      avgLlmCalls: llm.std,
      avgToolCalls: tools.std,
    },
  }
}

// ==================== 配对显著性检验（同一批问题、同一判定基准下比较两策略） ====================
// 199 题规模下 2~3% 的召回率差距常为噪声，故对「同一问题」做配对检验：
//  - 命中/未命中（召回率口径 foundCount>0）→ McNemar 精确检验（二项双侧，取 min(b,c)）
//  - 首次位次（未命中记 K+1）→ Wilcoxon 符号秩检验（正态近似 + 并列校正 + 连续性校正）
// 结论以 p<0.05 为准：命中差异显著优先判定；否则看位次差异是否显著。
interface PairedComparison {
  strategyId: string
  label: string
  /** 双方都有判定记录的共同问题数 */
  n: number
  /** 基线命中而对比策略未命中（b） */
  baseOnly: number
  /** 基线未命中而对比策略命中（c） */
  otherOnly: number
  /** 配对命中率变化（对比 - 基线） */
  deltaRecall: number
  /** McNemar 精确检验 p 值 */
  mcnemarP: number
  /** Wilcoxon 符号秩检验 p 值 */
  wilcoxonP: number
  /** 平均位次差（对比 - 基线，负=对比更靠前；未命中记 K+1） */
  rankDelta: number
  verdict: 'better' | 'worse' | 'same'
}

/** 对数组合数 log C(n,k)：大 n 下避免溢出 */
const logChoose = (n: number, k: number): number => {
  if (k < 0 || k > n) return -Infinity
  const kk = Math.min(k, n - k)
  let s = 0
  for (let i = 1; i <= kk; i++) s += Math.log(n - kk + i) - Math.log(i)
  return s
}

/** McNemar 精确检验（双侧）：2*P(X ≤ min(b,c))，X ~ B(b+c, 0.5) */
const mcnemarExactP = (b: number, c: number): number => {
  const n = b + c
  if (n <= 0) return 1
  const logs: number[] = []
  for (let i = 0; i <= n; i++) logs.push(logChoose(n, i) - n * Math.log(2))
  const maxLog = Math.max(...logs)
  let partial = 0
  for (let i = 0; i <= Math.min(b, c); i++) partial += Math.exp(logs[i] - maxLog)
  return Math.min(1, Math.max(0, 2 * Math.exp(maxLog) * partial))
}

/** 标准正态 CDF（Abramowitz–Stegun 7.1.26 近似，精度约 1e-7，足够 p 值展示） */
const normalCdf = (z: number): number => {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2)
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return z >= 0 ? 1 - p : p
}

/** Wilcoxon 符号秩检验（配对、双侧；正态近似 + 并列校正 + 连续性校正） */
const wilcoxonSignedRankP = (diffs: number[]): number => {
  const d = diffs.filter(x => x !== 0)
  const n = d.length
  if (n === 0) return 1
  const order = d.map((v, i) => ({ v: Math.abs(v), i })).sort((a, b) => a.v - b.v)
  const ranks = new Array<number>(n).fill(0)
  const tieGroups: number[] = []
  let i = 0
  while (i < n) {
    let j = i
    while (j + 1 < n && order[j + 1].v === order[i].v) j++
    const size = j - i + 1
    tieGroups.push(size)
    const avgRank = (i + 1 + j + 1) / 2
    for (let k = i; k <= j; k++) ranks[order[k].i] = avgRank
    i = j + 1
  }
  let wPlus = 0
  for (let k = 0; k < n; k++) if (d[k] > 0) wPlus += ranks[k]
  const mu = (n * (n + 1)) / 4
  let variance = (n * (n + 1) * (2 * n + 1)) / 24
  for (const t of tieGroups) if (t > 1) variance -= (t ** 3 - t) / 48
  const sd = Math.sqrt(Math.max(variance, 1e-9))
  const delta = wPlus - mu
  const z = (delta - Math.sign(delta) * 0.5) / sd
  return Math.min(1, Math.max(0, 2 * (1 - normalCdf(Math.abs(z)))))
}

/** 行标识（同一问题可能出现多行）：问题文本 + 判定基准成分，保证配对到同一道题 */
const rankRowKey = (r: RankAnalysisResult): string => `${r.question}\u0000${(r.answerParts || []).join('|')}`

/** 以 baselineId 为基线，构建与其它策略的配对比较（共同题数不足时返回空） */
const buildPairedComparisons = (baselineId: string): PairedComparison[] => {
  const byStrategy = new Map<string, Map<string, RankAnalysisResult>>()
  for (const r of rankAnalysisResults.value) {
    if (!byStrategy.has(r.algorithm)) byStrategy.set(r.algorithm, new Map())
    byStrategy.get(r.algorithm)!.set(rankRowKey(r), r)
  }
  const base = byStrategy.get(baselineId)
  if (!base || base.size === 0) return []
  const missRank = (parseInt(String(test.searchNum)) || 5) + 1
  const out: PairedComparison[] = []
  for (const [sid, rows] of byStrategy) {
    if (sid === baselineId) continue
    let n = 0, b = 0, c = 0
    const diffs: number[] = []
    for (const [key, baseRow] of base) {
      const otherRow = rows.get(key)
      if (!otherRow) continue
      n++
      const baseHit = baseRow.foundCount > 0
      const otherHit = otherRow.foundCount > 0
      if (baseHit && !otherHit) b++
      else if (!baseHit && otherHit) c++
      const baseRank = baseRow.firstRank > 0 ? baseRow.firstRank : missRank
      const otherRank = otherRow.firstRank > 0 ? otherRow.firstRank : missRank
      diffs.push(otherRank - baseRank)
    }
    if (n === 0) continue
    const deltaRecall = (c - b) / n
    const mcnemarP = mcnemarExactP(b, c)
    const wilcoxonP = wilcoxonSignedRankP(diffs)
    const rankDelta = meanOf(diffs)
    let verdict: PairedComparison['verdict'] = 'same'
    if (mcnemarP < 0.05 && deltaRecall !== 0) verdict = deltaRecall > 0 ? 'better' : 'worse'
    else if (wilcoxonP < 0.05 && rankDelta !== 0) verdict = rankDelta < 0 ? 'better' : 'worse'
    out.push({
      strategyId: sid,
      label: getAlgorithmLabel(sid),
      n, baseOnly: b, otherOnly: c, deltaRecall, mcnemarP, wilcoxonP, rankDelta, verdict,
    })
  }
  return out.sort((a, b) => b.deltaRecall - a.deltaRecall)
}

const sigBaseline = ref('similarity')
/** 实际生效的基线（所选策略不在当前结果中时退回榜首或第一个可用策略） */
const sigBaselineId = computed(() => {
  const ids = allStrategyStats.value.map(s => s.strategyId)
  if (ids.includes(sigBaseline.value)) return sigBaseline.value
  return ids[0] || ''
})
const pairedComparisons = computed<PairedComparison[]>(() =>
  allStrategyStats.value.length ? buildPairedComparisons(sigBaselineId.value) : [])

const pText = (p: number): string => (p < 0.001 ? 'p<0.001' : `p=${p.toFixed(3)}`)
const verdictLabel = (v: PairedComparison['verdict']): string =>
  v === 'better' ? (store.locales=='zh' ? '显著更优' : 'Significantly better')
    : v === 'worse' ? (store.locales=='zh' ? '显著更差' : 'Significantly worse')
      : (store.locales=='zh' ? '无显著差异' : 'No significant difference')
const verdictColor = (v: PairedComparison['verdict']): string =>
  v === 'better' ? '#4CAF50' : v === 'worse' ? '#f44336' : 'var(--borderColor)'
/** 增量着色：正=绿（更好），负=红 */
const deltaColor = (delta: number): string => (delta > 0 ? '#4CAF50' : delta < 0 ? '#f44336' : 'var(--borderColor)')
/** 工具分布文本（消融实验核对用）：kb_search 2.1/题 · entity_slice 0.4/题；含系统补检索时追加说明 */
const toolDistText = (dist: Record<string, number>, fallback = 0): string => {
  const main = Object.entries(dist).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${agentToolLabel(k)} ${v.toFixed(2)}/题`).join(' · ')
  const fb = fallback > 0
    ? (store.locales=='zh' ? `系统补检索 ${fallback.toFixed(2)}/题（模型未调工具时执行）` : `system fallback ${fallback.toFixed(2)}/q`)
    : ''
  return [main, fb].filter(Boolean).join(' · ') || (store.locales=='zh' ? '本次未调用检索工具' : 'no retrieval tools used')
}

// ==================== 测试结果随 .kb 保存/加载 ====================
// 开启「处理配置 → 保存测试结果到 KB 文件」后：批量/单题测试的检索结果、位次分析、策略召回对比、
// 检索过程（智能路由工具轨迹）都会随 .kb 落盘，重新加载即可复现对比数据（不重跑），便于论文/复现实验。
// 切片正文一律不写盘（按 id 回源当前知识库），因此换库/重新切片后旧结果的正文与命中标记可能失配。
let restoringTestData = false

/** 上报当前测试结果快照（传引用、不做深拷贝；父组件仅在保存 .kb 时序列化） */
const emitTestData = () => {
  emit('testDataChange', {
    savedAt: new Date().toISOString(),
    settings: {
      searchNum: parseInt(String(test.searchNum)) || 5,
      repeat: Math.max(1, Math.min(5, parseInt(String(test.repeat)) || 1)),
      hitMode: test.hitMode,
      matchMode: test.matchMode,
    },
    testResults: testResults.value,
    rankAnalysisResults: rankAnalysisResults.value,
    allStrategyStats: allStrategyStats.value,
    allStrategySliceResults: allStrategySliceResults.value,
    strategyRuns: strategyRuns.value,
  })
}

/** 从 .kb 恢复测试结果（含测试页设置；恢复期间屏蔽「口径变更即清空」的监听，避免刚恢复就被清掉） */
const restoreTestData = async (data: any) => {
  if (!data) return
  restoringTestData = true
  const st: any = data.settings || {}
  if (st.searchNum) test.searchNum = st.searchNum
  if (st.repeat) test.repeat = Math.max(1, Math.min(5, Number(st.repeat) || 1))
  if (st.hitMode === 'slice' || st.hitMode === 'text' || st.hitMode === 'llm') test.hitMode = st.hitMode
  if (st.matchMode === 'precise' || st.matchMode === 'fuzzy') test.matchMode = st.matchMode
  testResults.value = Array.isArray(data.testResults) ? data.testResults : []
  rankAnalysisResults.value = Array.isArray(data.rankAnalysisResults) ? data.rankAnalysisResults : []
  allStrategyStats.value = Array.isArray(data.allStrategyStats) ? data.allStrategyStats : []
  allStrategySliceResults.value = Array.isArray(data.allStrategySliceResults) ? data.allStrategySliceResults : []
  strategyRuns.value = (data.strategyRuns && typeof data.strategyRuns === 'object') ? data.strategyRuns : {}
  test.questionStatus = test.questions.map((_, i) => testResults.value[i]
    ? { text: store.locales=='zh' ? '已加载' : 'Loaded', color: '#2196F3', icon: 'fa fa-history' }
    : { text: store.locales=='zh' ? '未测试' : 'Not Tested', color: 'var(--borderColor)', icon: 'fa fa-circle-o' })
  activeTab.value = allStrategyStats.value.length ? 'batch' : 'test'
  await nextTick()
  restoringTestData = false
  emit('updateState', store.locales=='zh'
    ? `已从知识库恢复测试结果：${testResults.value.length} 题结果 · ${allStrategyStats.value.length} 个策略统计`
    : `Test results restored from the KB: ${testResults.value.length} result(s) · ${allStrategyStats.value.length} strategy stats`)
}

// 批量测试所有检索策略：每个策略跑一遍全部问题，统计召回准确率
const runAllStrategyTest = async () => {
  // 已有批量测试（当前 / 全部策略）在跑：避免并发写进度与结果
  if (test.isRunning) {
    emit('updateState', store.locales=='zh' ? '已有批量测试正在运行，请先停止或等待完成' : 'A batch test is already running — stop it or wait for it to finish')
    return
  }
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

  // 先补齐切片向量再计时开测（向量化耗时不计入检索时间）
  if (!(await ensureTestVectors())) return
  if (test.hitMode === 'llm') {
    emit('updateState', store.locales=='zh'
      ? '大模型判定已启用：仅智能路由类策略按大模型判定，其余策略按切片/答案口径判定'
      : 'LLM judgement on: agentic strategies are judged by the LLM, others fall back to slice/answer')
  }

  resetBatchCtl()
  batchRunKind.value = 'all'
  test.isRunning = true
  test.progress = 0
  startTestClock()
  initFileSummaries()

  // 全部启用策略对应管线就绪（当前自动覆盖：文件自带摘要向量化；本体/社区/Q 由父级建库管线提供）
  await ensureStrategyChannelsReady()

  // 已配置预热且未执行 → 先预热（时间单独计时，不计入检索时间）
  if (!prewarmDone.value && (prewarm.summary || prewarm.summaryVec || prewarm.sliceVec || prewarm.questionVec || prewarm.entity || prewarm.community)) {
    await runPrewarm()
  }

  const strategies = algorithmOptions.value
  const searchNum = parseInt(test.searchNum.toString())
  const rows = test.questions.map((q, i) => ({ question: q?.trim(), answer: test.answers?.[i]?.trim() || '' }))
  // 重复次数：同一批问题重复跑 N 轮（各轮独立汇总，用于均值±标准差；默认 1=不重复）
  const repeat = Math.max(1, Math.min(5, parseInt(String(test.repeat)) || 1))
  const totalRuns = strategies.length * rows.length * repeat
  let done = 0

  // 新一次「全部策略」测试：自动清空上一次结果/位次/统计，只保留本次
  clearJudgementResults()
  strategyRuns.value = {}

  let abortedRuns = false
  for (let rep = 0; rep < repeat && !abortedRuns; rep++) {
    for (const algo of strategies) {
      for (let i = 0; i < rows.length; i++) {
        // 暂停/停止：在问题之间生效（已测结果与统计保留）
        if (!(await waitWhilePaused())) { abortedRuns = true; break }
        const { question, answer } = rows[i]
        if (!question || isJunkQuestion(question)) { done++; continue }
        allTestProgressText.value = store.locales=='zh'
          ? `策略「${algo.label}」· ${i + 1}/${rows.length}${repeat > 1 ? `（第 ${rep + 1}/${repeat} 轮）` : ''}`
          : `Strategy "${algo.label}" · ${i + 1}/${rows.length}${repeat > 1 ? ` (run ${rep + 1}/${repeat})` : ''}`
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
      // 本轮该策略已跑完全部问题：汇总本轮指标（重复运行时用于均值±标准差）
      snapshotStrategyRun(algo.value)
      // 每测完一个策略，立即刷新「策略召回对比」，让该策略数据实时可见
      updateStrategyStats()
      // 每跑完一个策略即刷新 .kb 快照（中途保存也能拿到已完成部分）
      emitTestData()
      activeTab.value = 'batch'
      if (abortedRuns) break
    }
  }

  // 聚合每个策略的召回统计（与单测/批测共用同一聚合逻辑）
  updateStrategyStats()
  emitTestData()
  expandedStrategy.value = ''
  activeTab.value = 'batch'

  batchRunKind.value = ''
  resetBatchCtl()
  test.isRunning = false
  allTestProgressText.value = ''
  lastUpdateTime.value = new Date().toLocaleTimeString()

  if (abortedRuns) {
    emit('updateState', store.locales=='zh'
      ? `全部策略测试已停止：已完成 ${done}/${totalRuns} 次检索（已测结果与统计保留）`
      : `All-strategy test stopped: ${done}/${totalRuns} retrievals done (results & stats kept)`)
    return
  }

  const best = allStrategyStats.value[0]
  emit('updateState', store.locales=='zh'
    ? `全部策略测试完成：共 ${allStrategyStats.value.length} 个策略${repeat > 1 ? `（每策略 ${repeat} 轮，指标为均值±标准差）` : ''}，最优「${best?.label}」召回 ${best ? (best.recallRate*100).toFixed(1) : 0}%`
    : `All strategies tested: ${allStrategyStats.value.length} strategies${repeat > 1 ? ` (${repeat} runs each, mean±std)` : ''}, best "${best?.label}" recall ${best ? (best.recallRate*100).toFixed(1) : 0}%`)
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
      ['策略', '策略ID', '分组', '重复轮数', '测试问题数', '命中问题数', '召回率', '答案命中率', 'Hit@1', 'MRR', '完整率', '平均位次', '平均时间(ms)', '模型调用/题', '工具调用/题', '工具分布']
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
          s.runs,
          g.testedCount,
          g.hitCount,
          g.testedCount > 0 ? (g.recallRate * 100).toFixed(1) + '%' : '-',
          g.testedCount > 0 ? (g.avgHitRate * 100).toFixed(1) + '%' : '-',
          g.testedCount > 0 ? (g.hitAt1 * 100).toFixed(1) + '%' : '-',
          g.testedCount > 0 ? g.mrr.toFixed(3) : '-',
          g.testedCount > 0 ? (g.completeRate * 100).toFixed(1) + '%' : '-',
          g.avgFirstRank > 0 ? g.avgFirstRank.toFixed(1) : '-',
          s.avgTimeMs > 0 ? Math.round(s.avgTimeMs) : '-',
          s.avgLlmCalls > 0 ? s.avgLlmCalls.toFixed(2) : '-',
          s.avgToolCalls > 0 ? s.avgToolCalls.toFixed(2) : '-',
          s.avgToolCalls > 0 ? toolDistText(s.toolDistribution) : '-'
        ])
      }
    }

    // 配对显著性表（vs 当前所选基线）：命中差异（McNemar 精确）与位次差异（Wilcoxon 符号秩）
    const significance: any[][] = [
      ['基线', '对比策略', '对比策略ID', '共同题数', 'b(基线命中/对比未命中)', 'c(基线未命中/对比命中)', '命中率变化', 'McNemar p', 'Wilcoxon p', '平均位次变化', '结论']
    ]
    for (const c of pairedComparisons.value) {
      significance.push([
        getAlgorithmLabel(sigBaselineId.value),
        c.label,
        c.strategyId,
        c.n,
        c.baseOnly,
        c.otherOnly,
        (c.deltaRecall * 100).toFixed(1) + '%',
        c.mcnemarP < 0.001 ? '<0.001' : c.mcnemarP.toFixed(4),
        c.wilcoxonP < 0.001 ? '<0.001' : c.wilcoxonP.toFixed(4),
        c.rankDelta.toFixed(2),
        verdictLabel(c.verdict),
      ])
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
    ws1['!cols'] = [{ wch: 18 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 32 }]
    const ws2 = XLSX.utils.aoa_to_sheet(detail)
    ws2['!cols'] = [{ wch: 16 }, { wch: 14 }, { wch: 40 }, { wch: 30 }, { wch: 10 }, { wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 12 }]
    const ws3 = XLSX.utils.aoa_to_sheet(significance)
    ws3['!cols'] = [{ wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 10 }, { wch: 20 }, { wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws1, '策略召回对比')
    XLSX.utils.book_append_sheet(wb, ws2, '明细')
    XLSX.utils.book_append_sheet(wb, ws3, '配对显著性')

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

// 导出全部测试数据到 Excel（策略召回对比汇总 + 位次明细 + 切片明细 + 配对显著性 四个工作表）
const exportAllTestData = async () => {
  if (allStrategyStats.value.length === 0 && rankAnalysisResults.value.length === 0 && allStrategySliceResults.value.length === 0) {
    emit('updateState', store.locales=='zh' ? '暂无测试数据，请先运行测试' : 'No test data yet, run tests first')
    return
  }
  isExporting.value = true
  try {
    // 表1：策略召回对比汇总（按 策略 × 分组 展开：全部 / 单切片 / 复合）
    const summary: any[][] = [
      ['策略', '策略ID', '分组', '测试问题数', '命中问题数', '召回率', '答案命中率', 'Hit@1', 'MRR', '完整率', '平均位次', '平均时间(ms)', '模型调用/题', '工具调用/题', '工具分布']
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
          s.avgTimeMs > 0 ? Math.round(s.avgTimeMs) : '-',
          s.avgLlmCalls > 0 ? s.avgLlmCalls.toFixed(2) : '-',
          s.avgToolCalls > 0 ? s.avgToolCalls.toFixed(2) : '-',
          s.avgToolCalls > 0 ? toolDistText(s.toolDistribution) : '-'
        ])
      }
    }

    // 表2：位次明细
    const detail: any[][] = [
      ['策略', '策略ID', '问题', '参考答案', '是否命中', '答案命中率', '最优位次', '命中切片数', '召回时间(ms)', '模型调用', '工具调用', '判定方式', '大模型判定理由']
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
        r.timeMs ? Math.round(r.timeMs) : '-',
        r.llmCalls || 0,
        r.toolCalls || 0,
        r.refMode === 'llm' ? (store.locales=='zh' ? '大模型判定' : 'LLM judge') : (r.refMode === 'slice' ? (store.locales=='zh' ? '切片命中' : 'Slice hit') : (store.locales=='zh' ? '答案命中' : 'Answer hit')),
        r.llmJudge ? (r.llmJudge.error ? (store.locales=='zh' ? '判定失败：' : 'failed: ') + r.llmJudge.error : r.llmJudge.reason || '') : ''
      ])
    }

    // 表4：配对显著性（vs 当前所选基线）
    const significance: any[][] = [
      ['基线', '对比策略', '对比策略ID', '共同题数', 'b(基线命中/对比未命中)', 'c(基线未命中/对比命中)', '命中率变化', 'McNemar p', 'Wilcoxon p', '平均位次变化', '结论']
    ]
    for (const c of pairedComparisons.value) {
      significance.push([
        getAlgorithmLabel(sigBaselineId.value),
        c.label,
        c.strategyId,
        c.n,
        c.baseOnly,
        c.otherOnly,
        (c.deltaRecall * 100).toFixed(1) + '%',
        c.mcnemarP < 0.001 ? '<0.001' : c.mcnemarP.toFixed(4),
        c.wilcoxonP < 0.001 ? '<0.001' : c.wilcoxonP.toFixed(4),
        c.rankDelta.toFixed(2),
        verdictLabel(c.verdict),
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
    ws1['!cols'] = [{ wch: 18 }, { wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 32 }]
    const ws2 = XLSX.utils.aoa_to_sheet(detail)
    ws2['!cols'] = [{ wch: 16 }, { wch: 14 }, { wch: 40 }, { wch: 30 }, { wch: 10 }, { wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }]
    const ws3 = XLSX.utils.aoa_to_sheet(sliceSheet)
    ws3['!cols'] = [{ wch: 16 }, { wch: 14 }, { wch: 40 }, { wch: 30 }, { wch: 10 }, { wch: 8 }, { wch: 20 }, { wch: 50 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 20 }, { wch: 12 }]
    const ws4 = XLSX.utils.aoa_to_sheet(significance)
    ws4['!cols'] = [{ wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 10 }, { wch: 20 }, { wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws1, '策略召回对比')
    XLSX.utils.book_append_sheet(wb, ws2, '位次明细')
    XLSX.utils.book_append_sheet(wb, ws3, '切片明细')
    XLSX.utils.book_append_sheet(wb, ws4, '配对显著性')

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
  // 若 .kb 已保存测试结果（处理配置勾选「保存测试结果到 KB 文件」），恢复位次/策略对比/检索过程
  if (props.testData) restoreTestData(props.testData)
})

// 从 .kb 加载恢复测试结果（同一次会话内换库/重新打开 .kb 时也会触发；空值不覆盖已有结果）
watch(() => props.testData, (val) => {
  if (val && !test.isRunning) restoreTestData(val)
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
  /** 测试结果快照变化（父组件据此在保存 .kb 时落盘；仅在「保存测试结果到 KB 文件」开启时写入） */
  testDataChange: [data: SavedTestData]
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
      <!-- 评测用嵌入模型（当前模型来源可用模型；留空=跟随设置中的嵌入模型）：只影响本知识库评测/检索，
              不改动设置里的嵌入模型；切换后旧向量清空并按需用新模型重新生成；选择随 .kb 保存 -->
      <select class="kt-select" style="width:175px;" v-model="testEmbedSel" @change="onTestEmbedModelChange"
                 :disabled="test.isRunning || prewarmRunning"
                 :title="(store.locales=='zh' ? '评测用嵌入模型：只影响本知识库评测/检索时使用的嵌入模型，不改动设置里的嵌入模型；留空=跟随设置。切换后旧向量会被清空，评测/问答时按需用新模型重新生成；选择随 .kb 保存' : 'Evaluation embedding model: affects only this KB\'s evaluation/retrieval; the settings embed model is untouched; empty = follow settings. Switching clears old vectors (re-derived on demand); the choice is saved with the .kb') + (props.model?.embed ? (store.locales=='zh' ? `｜设置在用：${props.model.embed}` : ` | settings: ${props.model.embed}`) : '')">
           <option value="">{{ followEmbedLabel }}</option>
           <option v-for="m in embedModelOptions" :key="m" :value="m">{{ m }}</option>
      </select>
      <div class="kt-btn" @click="refreshEmbedModels" :title="store.locales=='zh' ? '刷新嵌入模型列表（从当前 AI 来源拉取）' : 'Refresh embed model list (fetch from the current AI source)'">
           <i class="fa fa-refresh"></i>
      </div>
      <span class="kt-sep"></span>
      <!-- 批量测试（当前策略）/ 暂停 / 继续 / 停止：仅前两个面板（测试结果/位次分析）显示 -->
      <template v-if="activeTab === 'test' || activeTab === 'rank'">
        <template v-if="test.isRunning && batchRunKind === 'one'">
          <div class="kt-btn" v-if="batchCtl.paused" @click="continueBatchTest"
               :title="store.locales=='zh' ? '继续批量测试' : 'Resume batch test'">
            <i class="fa fa-play"></i>
          </div>
          <div class="kt-btn" v-else @click="pauseBatchTest"
               :title="store.locales=='zh' ? '暂停批量测试（当前问题跑完后停下，可继续）' : 'Pause batch test (stops after the current question, resumable)'">
            <i class="fa fa-pause"></i>
          </div>
          <div class="kt-btn" @click="stopBatchTest"
               :title="store.locales=='zh' ? '停止批量测试（已测结果保留）' : 'Stop batch test (keep tested results)'">
            <i class="fa fa-stop"></i>
          </div>
        </template>
        <div v-else class="kt-btn" @click="runBatchTest" :disabled="test.isRunning"
             :title="store.locales=='zh' ? '批量测试（当前策略）：用当前策略跑全部问题' : 'Batch test (current strategy): run all questions'">
          <i class="fa fa-play"></i>
        </div>
      </template>

      <!-- 批量测试面板工具栏按钮组（仅该标签显示；窗口窄时右侧溢出隐藏，不显示横向滑块）。
           容器带 gap 保证 kt-btn 之间始终有间隔；导出按钮经 margin-left:auto 推到最右 -->
      <div v-if="activeTab === 'batch'" style="display:flex;align-items:center;flex:1;flex-wrap:nowrap;overflow:hidden;min-width:0;gap:5px;">
        <!-- 批量测试（全部策略）/ 暂停 / 继续 / 停止 -->
        <template v-if="test.isRunning && batchRunKind === 'all'">
          <div class="kt-btn" v-if="batchCtl.paused" @click="continueBatchTest"
               :title="store.locales=='zh' ? '继续批量测试所有策略' : 'Resume all-strategy test'">
            <i class="fa fa-play"></i>
          </div>
          <div class="kt-btn" v-else @click="pauseBatchTest"
               :title="store.locales=='zh' ? '暂停批量测试（当前问题跑完后停下，可继续）' : 'Pause batch test (stops after the current question, resumable)'">
            <i class="fa fa-pause"></i>
          </div>
          <div class="kt-btn" @click="stopBatchTest"
               :title="store.locales=='zh' ? '停止批量测试（已测结果与统计保留）' : 'Stop batch test (keep tested results & stats)'">
            <i class="fa fa-stop"></i>
          </div>
        </template>
        <div v-else class="kt-btn" @click="runAllStrategyTest" :disabled="test.isRunning"
             :title="store.locales=='zh' ? '批量测试所有策略：每个策略跑一遍全部问题，统计召回准确率' : 'Test all strategies: run all questions for every strategy'">
          <i class="fa fa-play"></i>
        </div>
        <!-- 重复次数（仅「全部策略」批量生效）：同批问题重复 N 轮，各指标以均值±标准差呈现 -->
        <input v-model="test.repeat" type="number" min="1" max="5" class="kt-input" style="width:42px;"
               :disabled="test.isRunning"
               :title="store.locales=='zh' ? '重复次数（仅「批量测试所有策略」生效）：同一批问题重复跑 N 轮，指标以均值±标准差呈现，用于判断策略差异是否稳定（默认 1）' : 'Repeat count (all-strategy test only): run the same questions N times and report mean ± std (default 1)'"/>
        <!-- 清空批量测试结果 -->
        <div class="kt-btn" @click="clearAllResults" :disabled="test.isRunning || prewarmRunning"
             :title="store.locales=='zh' ? '清空批量测试结果 / 位次 / 统计（释放内存）' : 'Clear batch results / stats (free memory)'">
          <i class="fa fa-eraser"></i>
        </div>
        <!-- 预热入口（仅当有可勾选项时显示）：摘要生成 / 各类向量缓存都在浮层里操作 -->
        <div v-if="availablePrewarmItems.length > 0" class="kt-btn"
             :class="{ on: prewarmPanelOpen, warn: prewarmRunning }"
             @click="prewarmPanelOpen = !prewarmPanelOpen"
             :title="store.locales=='zh' ? '预热 / 向量缓存：生成缺失摘要、补齐各类向量（已有数据自动跳过，耗时不计入检索）' : 'Pre-warm / vector caches: generate missing summaries, fill missing vectors (existing data is skipped)'">
          <i class="fa" :class="prewarmRunning ? 'fa-spinner fa-spin' : 'fa-fire'"></i>
          <span v-if="prewarmEnabledItems.length" class="pw-badge">{{ prewarmEnabledItems.length }}</span>
        </div>
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
        
        <!-- 命中判定基准：切片精准命中（默认，按关联切片身份）/ 答案命中（按参考答案文本，旧口径）/ 大模型判定（仅智能路由） -->
        <select v-model="test.hitMode" class="kt-select" style="width:104px;"
                :title="store.locales=='zh' ? '命中判定：切片精准命中=检索到该问题的关联切片才算命中（推荐默认）；答案命中=按参考答案文本匹配（可在右侧选择 精准/模糊 子策略）；大模型判定=由对话模型对比检索片段与问题/参考答案判定命中与位次（仅智能路由类策略可用，判定调用计入成本、不计入检索时间）' : 'Hit rule: Slice = hit only when the linked slice is recalled (default); Answer = match by reference-answer text; LLM = the chat model judges whether the retrieved snippets answer the question (agentic strategies only)'">
          <option value="slice">{{ store.locales=='zh' ? '切片命中' : 'Slice Hit' }}</option>
          <option value="text">{{ store.locales=='zh' ? '答案命中' : 'Answer Hit' }}</option>
          <option value="llm" :disabled="!llmJudgeAvailable">
            {{ store.locales=='zh' ? '大模型判定' : 'LLM Judge' }}{{ llmJudgeAvailable ? '' : (store.locales=='zh' ? '（仅智能路由）' : ' (agentic only)') }}
          </option>
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
        <!-- 已暂停：等当前问题跑完后停下，可继续 / 停止 -->
        <span v-if="batchCtl.paused" class="kt-label" style="color:#FF9800;">
          <i class="fa fa-pause"></i> {{ store.locales=='zh' ? '已暂停' : 'Paused' }}
        </span>
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
                  <!-- 智能路由（Agentic）：查看本次检索的工具调用过程（其它策略不显示） -->
                  <span v-if="rowAgent(qIndex)" class="tm-trace-btn" @click="openAgentTrace(testResults[qIndex])"
                        :title="store.locales=='zh'
                          ? `查看智能路由检索过程：检索步骤 ${agentRetrievalStepCount(rowAgent(qIndex))} 步 / 模型调用 ${rowAgent(qIndex)?.llmCalls || 0} 次${rowAgent(qIndex)?.noToolCalls ? '（模型未调用工具' + (rowAgent(qIndex)?.fallback ? '，已系统补检索）' : '）') : ''}`
                          : `View agentic trace: ${agentRetrievalStepCount(rowAgent(qIndex))} retrieval step(s), ${rowAgent(qIndex)?.llmCalls || 0} LLM call(s)`">
                    <i class="fa fa-random"></i>{{ store.locales=='zh' ? '过程' : 'Trace' }}
                    <span v-if="agentRetrievalStepCount(rowAgent(qIndex))"> {{ agentRetrievalStepCount(rowAgent(qIndex)) }}</span>
                    <span v-else-if="rowAgent(qIndex)?.noToolCalls" style="color:#FF9800;"> 0</span>
                  </span>
                  <!-- 大模型判定结果（仅智能路由 + 大模型判定模式）：显示命中/位次与理由 -->
                  <span v-if="testResults[qIndex]?.llmJudge" class="tm-trace-btn"
                        :class="{ 'tm-judge-hit': testResults[qIndex]?.llmJudge?.hit }"
                        @click="openAgentTrace(testResults[qIndex])"
                        :title="store.locales=='zh'
                          ? `大模型判定：${testResults[qIndex]?.llmJudge?.hit ? '命中（位次 ' + testResults[qIndex]?.llmJudge?.rank + '）' : '未命中'}${testResults[qIndex]?.llmJudge?.reason ? ' · ' + testResults[qIndex]?.llmJudge?.reason : ''}`
                          : `LLM judge: ${testResults[qIndex]?.llmJudge?.hit ? 'hit (rank ' + testResults[qIndex]?.llmJudge?.rank + ')' : 'miss'}`">
                      <i class="fa fa-gavel"></i>{{ testResults[qIndex]?.llmJudge?.hit ? (store.locales=='zh' ? '判定✓' : 'judged✓') : (store.locales=='zh' ? '判定✗' : 'judged✗') }}
                  </span>
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
                  :title="rankRefMode === 'slice' ? (store.locales=='zh' ? '关联切片=判定基准；绿色=已被检索召回' : 'Linked slices are the hit reference; green = recalled') : (rankRefMode === 'llm' ? (store.locales=='zh' ? '大模型判定：由对话模型给出命中与最前位次' : 'LLM judge: hit and best rank decided by the chat model') : '')">
                {{ store.locales=='zh' ? (rankRefMode === 'slice' ? '关联切片' : rankRefMode === 'llm' ? '大模型判定' : '参考答案') : (rankRefMode === 'slice' ? 'Linked Slices' : rankRefMode === 'llm' ? 'LLM Judge' : 'Answer') }}
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
                <th style="text-align:center;"
                    :title="store.locales=='zh' ? '平均对话模型调用次数/题（成本）：Agentic 的工具轮与最终作答、社区 Map-Reduce 均计入' : 'Avg LLM calls per question (cost): agentic tool rounds + final answer, community map-reduce included'">
                  {{ store.locales=='zh' ? '模型调用/题' : 'LLM/Qs' }}
                </th>
                <th style="text-align:center;"
                    :title="store.locales=='zh' ? '平均工具调用次数/题（仅智能路由策略有值）：鼠标悬停看工具分布，消融实验可核对「工具是否真被调用」' : 'Avg tool calls per question (agentic only); hover for the distribution'">
                  {{ store.locales=='zh' ? '工具/题' : 'Tools/Qs' }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(s, idx) in displayStats" :key="s.strategyId"
                  :class="{ 'as-best': idx === 0, expanded: expandedStrategy === s.strategyId }"
                  @click="toggleStrategyDetail(s.strategyId)"
                  :title="store.locales=='zh' ? '点击查看位次明细' : 'Click to view rank detail'">
                <td>{{ idx === 0 ? '🏆 ' : '' }}{{ s.label }}<span v-if="s.runs > 1" class="ae-note"> ·{{ s.runs }}{{ store.locales=='zh' ? '轮' : 'runs' }}</span></td>
                <td style="text-align:center;">{{ s.hitCount }}/{{ s.testedCount }}</td>
                <td style="text-align:center;font-weight:bold;"
                    :style="{ color: s.recallRate>=0.7 ? '#4CAF50' : (s.recallRate>=0.4 ? '#FF9800' : '#f44336') }">
                  {{ fmtStat(s.recallRate, s.std?.recallRate) }}%
                </td>
                <td style="text-align:center;">{{ fmtStat(s.avgHitRate, s.std?.avgHitRate) }}%</td>
                <td style="text-align:center;font-weight:bold;"
                    :style="{ color: s.hitAt1>=0.7 ? '#4CAF50' : (s.hitAt1>=0.4 ? '#FF9800' : '#f44336') }">
                  {{ fmtStat(s.hitAt1, s.std?.hitAt1) }}%
                </td>
                <td style="text-align:center;">{{ fmtStat(s.mrr, s.std?.mrr, 1, 3) }}</td>
                <td style="text-align:center;" :style="{ color: s.completeRate>=0.7 ? '#4CAF50' : (s.completeRate>=0.4 ? '#FF9800' : '#f44336') }">
                  {{ fmtStat(s.completeRate, s.std?.completeRate) }}%
                </td>
                <td style="text-align:center;">
                  {{ s.avgFirstRank>0 ? fmtStat(s.avgFirstRank, s.std?.avgFirstRank, 1, 2) : '-' }}
                </td>
                <td style="text-align:center;">{{ s.avgTimeMs > 0 ? fmtStat(s.avgTimeMs, s.std?.avgTimeMs, 1, 0) + ' ms' : '-' }}</td>
                <td style="text-align:center;"
                    :title="store.locales=='zh' ? (s.avgLlmCalls > 0 ? `平均每题 ${s.avgLlmCalls.toFixed(2)} 次对话模型调用` : '本题集未产生对话模型调用') : `avg ${s.avgLlmCalls.toFixed(2)} LLM calls per question`">
                  {{ s.avgLlmCalls > 0 ? fmtStat(s.avgLlmCalls, s.std?.avgLlmCalls, 1, 2) : '-' }}
                </td>
                <td style="text-align:center;"
                    :title="s.avgToolCalls > 0 || (s.avgFallbackCalls || 0) > 0 ? toolDistText(s.toolDistribution, s.avgFallbackCalls || 0) : (store.locales=='zh' ? '该策略不使用检索工具' : 'no retrieval tools')">
                  {{ s.avgToolCalls > 0 ? fmtStat(s.avgToolCalls, s.std?.avgToolCalls, 1, 2) : ((s.avgFallbackCalls || 0) > 0 ? '0*' : '-') }}
                </td>
              </tr>
            </tbody>
          </table>
          <!-- 配对显著性检验（vs 所选基线）：同批问题上的配对比较，判断策略差异是否显著 -->
          <div v-if="allStrategyStats.length > 1" class="as-detail" style="margin-top:8px;">
            <div class="as-detail-title">
              <i class="fa fa-balance-scale"></i> {{ store.locales=='zh' ? '配对显著性检验' : 'Paired significance' }}
              <span class="as-group-tabs">
                <span class="ae-note">{{ store.locales=='zh' ? '基线' : 'Baseline' }}</span>
                <select v-model="sigBaseline" class="kt-select" style="width:auto;max-width:170px;">
                  <option v-for="s in allStrategyStats" :key="s.strategyId" :value="s.strategyId">{{ s.label }}</option>
                </select>
              </span>
            </div>
            <div class="ae-note" style="margin:2px 0 5px;">
              {{ store.locales=='zh'
                ? '同一批问题、同一判定基准下与基线配对：命中差异用 McNemar 精确检验（b=基线命中/对比未命中，c=反之），位次差异用 Wilcoxon 符号秩检验（未命中记 K+1）；p<0.05 视为显著'
                : 'Paired on the same questions vs the baseline: McNemar exact test for hit differences (b = baseline hit & other miss, c = vice versa), Wilcoxon signed-rank for ranks (miss = K+1); p<0.05 = significant' }}
            </div>
            <div v-if="!pairedComparisons.length" class="as-empty">
              <i class="fa fa-info-circle"></i>
              {{ store.locales=='zh' ? '暂无可配对数据（需至少两个策略各有判定记录）' : 'No paired data yet (need two strategies with judgements)' }}
            </div>
            <table v-else class="as-table as-detail-table">
              <thead>
                <tr>
                  <th>{{ store.locales=='zh' ? '对比策略' : 'Strategy' }}</th>
                  <th style="text-align:center;">{{ store.locales=='zh' ? '共同题' : 'Paired' }}</th>
                  <th style="text-align:center;">{{ store.locales=='zh' ? '命中变化' : 'Δ Recall' }}</th>
                  <th style="text-align:center;">b/c</th>
                  <th style="text-align:center;">McNemar</th>
                  <th style="text-align:center;">Wilcoxon</th>
                  <th style="text-align:center;">{{ store.locales=='zh' ? '位次变化' : 'Δ Rank' }}</th>
                  <th style="text-align:center;">{{ store.locales=='zh' ? '结论' : 'Verdict' }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in pairedComparisons" :key="c.strategyId">
                  <td>{{ c.label }}</td>
                  <td style="text-align:center;">{{ c.n }}</td>
                  <td style="text-align:center;font-weight:bold;" :style="{ color: deltaColor(c.deltaRecall) }">
                    {{ c.deltaRecall > 0 ? '+' : '' }}{{ (c.deltaRecall * 100).toFixed(1) }}%
                  </td>
                  <td style="text-align:center;" :title="store.locales=='zh' ? 'b/c（基线命中而对比未命中 / 反之）' : 'b/c (baseline-only hits / other-only hits)'">
                    {{ c.baseOnly }}/{{ c.otherOnly }}
                  </td>
                  <td style="text-align:center;" :style="{ color: c.mcnemarP < 0.05 ? '#4CAF50' : 'var(--borderColor)', fontWeight: c.mcnemarP < 0.05 ? 700 : 400 }">
                    {{ pText(c.mcnemarP) }}
                  </td>
                  <td style="text-align:center;" :style="{ color: c.wilcoxonP < 0.05 ? '#4CAF50' : 'var(--borderColor)', fontWeight: c.wilcoxonP < 0.05 ? 700 : 400 }">
                    {{ pText(c.wilcoxonP) }}
                  </td>
                  <td style="text-align:center;" :style="{ color: deltaColor(-c.rankDelta) }">
                    {{ c.rankDelta > 0 ? '+' : '' }}{{ c.rankDelta.toFixed(2) }}
                  </td>
                  <td style="text-align:center;font-weight:bold;" :style="{ color: verdictColor(c.verdict) }">
                    {{ verdictLabel(c.verdict) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

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
                  <th style="text-align:center;width:74px;">{{ store.locales=='zh' ? '检索过程' : 'Trace' }}</th>
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
                  <!-- 智能路由：回看该问题的工具调用过程（其它策略无该数据） -->
                  <td style="text-align:center;">
                    <span v-if="r.agent" class="tm-trace-btn" @click="openAgentTrace(r)"
                          :title="store.locales=='zh'
                            ? `查看智能路由检索过程：检索步骤 ${agentRetrievalStepCount(r.agent)} 步 / 模型调用 ${r.agent.llmCalls} 次`
                            : `View agentic trace: ${agentRetrievalStepCount(r.agent)} step(s), ${r.agent.llmCalls} LLM call(s)`">
                      <i class="fa fa-random"></i>{{ agentRetrievalStepCount(r.agent) }}
                    </span>
                    <span v-else style="color:var(--borderColor);">-</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- 预热 / 向量缓存浮层：所有预热操作按钮与状态、进度、耗时集中在这里，工具栏只留一个入口 -->
    <div v-if="prewarmPanelOpen" class="tm-overlay" @click.self="prewarmPanelOpen = false">
      <div class="tm-modal pw-modal">
        <div class="ae-head">
          <div class="ae-title">
            <i class="fa fa-fire"></i>
            <span class="tm-modal-title">{{ store.locales=='zh' ? '预热 / 向量缓存' : 'Pre-warm / Vector Caches' }}</span>
            <span class="ae-note">{{ store.locales=='zh' ? '已有摘要或向量会自动跳过、不重复生成；耗时单独计时、不计入检索时间' : 'Existing summaries/vectors are skipped; time is excluded from retrieval' }}</span>
          </div>
          <button class="ae-close" @click="prewarmPanelOpen = false" :title="store.locales=='zh' ? '关闭' : 'Close'"><i class="fa fa-times"></i></button>
        </div>

        <!-- 预热项表格：每项只出现一行，勾选 / 状态 / 进度 / 耗时 都在这行里 -->
        <div class="pw-table-wrap scoll">
          <table class="as-table as-detail-table pw-table">
            <thead>
              <tr>
                <th style="width:26px;"></th>
                <th>{{ store.locales=='zh' ? '项目' : 'Item' }}</th>
                <th>{{ store.locales=='zh' ? '状态' : 'Status' }}</th>
                <th style="width:132px;text-align:center;">{{ store.locales=='zh' ? '进度' : 'Progress' }}</th>
                <th style="width:64px;text-align:center;">{{ store.locales=='zh' ? '耗时' : 'Time' }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in availablePrewarmItems" :key="item.key" class="pw-tr"
                  :class="{ on: prewarm[item.key] }"
                  :title="(store.locales=='zh' ? item.label : item.labelEn) + ' ｜ ' + prewarmStatusText(item.key)"
                  @click="prewarm[item.key] = !prewarm[item.key]">
                <td class="pw-td-check"><i class="fa" :class="prewarm[item.key] ? 'fa-check-square-o' : 'fa-square-o'"></i></td>
                <td class="pw-td-item">
                  <i class="fa" :class="item.icon" :style="prewarmReady(item.key) ? { color: 'var(--fontActiveColor)' } : {}"></i>
                  <span>{{ store.locales=='zh' ? item.label : item.labelEn }}</span>
                </td>
                <td class="pw-td-status">
                  <template v-if="prewarmItemStates[item.key]?.status === 'running'">
                    <i class="fa fa-spinner fa-spin"></i> {{ store.locales=='zh' ? '处理中' : 'Running' }}
                  </template>
                  <template v-else-if="prewarmItemStates[item.key]?.status === 'done'">
                    <i class="fa fa-check-circle" style="color:#4CAF50;"></i> {{ store.locales=='zh' ? '已完成' : 'Done' }}
                  </template>
                  <span v-else :style="prewarmReady(item.key) ? { color: 'var(--fontActiveColor)' } : {}">{{ prewarmStatusText(item.key) }}</span>
                </td>
                <td class="pw-td-progress">
                  <div class="prewarm-row-bar"><div class="prewarm-row-fill" :style="{ width: prewarmPct(item.key) + '%' }"></div></div>
                  <span v-if="(prewarmItemStates[item.key]?.total || 0) > 0" class="pw-pct">{{ prewarmItemStates[item.key].index }}/{{ prewarmItemStates[item.key].total }}</span>
                </td>
                <td class="pw-td-time">{{ prewarmTimes[item.key] != null ? formatTime(prewarmTimes[item.key]) : '-' }}</td>
              </tr>
            </tbody>
            <tfoot v-if="prewarmDone && prewarmTotalMs > 0">
              <tr>
                <td></td>
                <td style="font-weight:600;">{{ store.locales=='zh' ? '合计' : 'Total' }}</td>
                <td></td>
                <td></td>
                <td class="pw-td-time" style="font-weight:600;">{{ formatTime(prewarmTotalMs) }}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <!-- 当前项明细（运行中一行提示，不再重复整张表） -->
        <div v-if="prewarmRunning" class="pw-detail">
          {{ prewarmItemStates[prewarmRunningItemKey]?.detail || (store.locales=='zh' ? '准备中...' : 'Preparing...') }}
        </div>

        <!-- 操作 -->
        <div class="pw-actions">
          <div class="kt-btn" @click="selectAllPrewarm(true)" :title="store.locales=='zh' ? '勾选全部可预热项' : 'Select all'"><i class="fa fa-check-square-o"></i></div>
          <div class="kt-btn" @click="selectAllPrewarm(false)" :title="store.locales=='zh' ? '清空勾选' : 'Clear selection'"><i class="fa fa-square-o"></i></div>
          <span style="flex:1"></span>
          <div class="kt-btn ok" :class="{ 'kt-disabled': prewarmRunning || test.isRunning || prewarmEnabledItems.length === 0 }"
               :title="prewarmEnabledItems.length === 0
                 ? (store.locales=='zh' ? '请先勾选需要的项' : 'Check at least one item')
                 : (store.locales=='zh' ? `开始预热（${prewarmEnabledItems.length} 项）` : `Run pre-warm (${prewarmEnabledItems.length} item(s))`)"
               @click="runPrewarm">
            <i class="fa" :class="prewarmRunning ? 'fa-spinner fa-spin' : 'fa-play'"></i>
            <span class="pw-run-label">{{ store.locales=='zh' ? '开始预热' : 'Run' }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 智能路由（Agentic）检索过程模态框：工具调用轨迹（仅智能路由策略的结果带该数据） -->
    <div v-if="agentTrace" class="tm-overlay" @click.self="closeAgentTrace">
      <div class="tm-modal tm-trace-modal">
        <div class="ae-head">
          <div class="ae-title">
            <i class="fa fa-random"></i>
            <span class="tm-modal-title">{{ agentTrace.heading }}</span>
            <span v-if="agentTrace.question" class="ae-note ellipsis" style="max-width:320px;" :title="agentTrace.question">{{ agentTrace.question }}</span>
          </div>
          <button class="ae-close" @click="closeAgentTrace" :title="store.locales=='zh' ? '关闭' : 'Close'"><i class="fa fa-times"></i></button>
        </div>
        <!-- 汇总：本次可用工具 / 轮次 / 模型调用 / 降级与未就绪工具提示 -->
        <div class="tm-trace-sum">
          <span class="tm-trace-stat">{{ store.locales=='zh' ? '下发工具定义' : 'Tool defs' }} {{ agentTrace.agent.tools.length }}</span>
          <span v-for="tl in agentTrace.agent.tools" :key="tl" class="tm-trace-tool">{{ agentToolLabel(tl) }}</span>
          <span class="tm-trace-stat">{{ store.locales=='zh' ? '轮次' : 'Rounds' }} {{ agentTraceRoundCount }}</span>
          <span class="tm-trace-stat">{{ store.locales=='zh' ? '模型调用' : 'LLM calls' }} {{ agentTrace.agent.llmCalls }}</span>
          <span v-if="agentTrace.agent.noToolCalls" class="tm-trace-warn">
            <i class="fa fa-exclamation-triangle"></i>
            {{ store.locales=='zh'
              ? '模型本轮未调用任何检索工具（可能：该模型/服务不支持 function calling、提示词被忽略）'
              : 'The model called no retrieval tool (model/service may lack function calling support)' }}
          </span>
          <span v-if="agentTrace.agent.fallback" class="tm-trace-warn">
            <i class="fa fa-life-ring"></i>
            {{ store.locales=='zh' ? '已按可用通道执行系统补检索' : 'Deterministic supplementary retrieval ran' }}
          </span>
          <span v-if="agentTrace.agent.degraded" class="tm-trace-warn">
            <i class="fa fa-exclamation-triangle"></i>
            {{ store.locales=='zh' ? '模型未返回工具调用，已退化为单次检索' : 'No tool calls returned; degraded to a single retrieval' }}
          </span>
          <span v-if="agentTrace.agent.droppedTools.length" class="tm-trace-note">
            {{ store.locales=='zh' ? '未就绪工具' : 'Tools without data' }}: {{ agentTrace.agent.droppedTools.join(', ') }}
          </span>
        </div>
        <div class="tm-body">
          <!-- 大模型判定结果（仅大模型判定模式）：命中与否 / 位次 / 理由 -->
          <div v-if="agentTrace.judge" class="tm-judge-line" :class="{ hit: agentTrace.judge.hit, err: !!agentTrace.judge.error }">
            <i class="fa fa-gavel"></i>
            <span v-if="agentTrace.judge.error">
              {{ store.locales=='zh' ? '大模型判定失败：' : 'LLM judgement failed: ' }}{{ agentTrace.judge.error }}
            </span>
            <span v-else>
              {{ store.locales=='zh'
                ? `大模型判定：${agentTrace.judge.hit ? `命中（最前位次 ${agentTrace.judge.rank}）` : '未命中'}`
                : `LLM judge: ${agentTrace.judge.hit ? `hit (best rank ${agentTrace.judge.rank})` : 'miss'}` }}
              <span v-if="agentTrace.judge.reason" class="tm-judge-reason">· {{ agentTrace.judge.reason }}</span>
            </span>
          </div>
          <div v-if="agentTrace.agent.steps.length === 0" class="tm-trace-empty">
            {{ store.locales=='zh' ? '本次未记录到任何检索步骤（连系统预取都为空：知识库可能没有可用切片）。' : 'No retrieval step recorded (even the pre-fetch was empty).' }}
          </div>
          <div v-for="(st, i) in agentTrace.agent.steps" :key="i" class="tm-step" :class="st.status">
            <div class="tm-step-head">
              <span class="tm-step-round">{{ st.kind === 'prefetch' ? '预' : '#' + st.round }}</span>
              <span class="tm-step-kind" :class="st.kind || 'tool'">{{ agentStepKindLabel(st) }}</span>
              <span class="tm-step-tool">{{ st.tool ? agentToolLabel(st.tool) : '' }}</span>
              <span v-if="st.note" class="tm-step-note">{{ st.note }}</span>
              <span class="tm-step-status" :class="st.status">
                <i class="fa" :class="st.status === 'running' ? 'fa-spinner fa-spin' : st.status === 'done' ? 'fa-check-circle' : 'fa-times-circle'"></i>
                {{ store.locales=='zh' ? (st.status === 'running' ? '执行中' : st.status === 'done' ? '完成' : '失败') : st.status }}
              </span>
            </div>
            <!-- 参数：工具调用参数（prefetch/补检索同样有参数），便于核对「用什么检索词查了什么」 -->
            <div v-if="agentStepArgsText(st.args)" class="tm-step-args">
              <span class="tm-step-args-label">{{ store.locales=='zh' ? '参数' : 'Args' }}:</span>
              <span class="tm-step-args-value">{{ agentStepArgsText(st.args) }}</span>
            </div>
            <div class="tm-step-result">{{ st.result || '—' }}</div>
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

/* ===== 预热项进度条（预热 / 向量缓存浮层的表格内） ===== */
.prewarm-row-bar {
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

/* ===== 预热 / 向量缓存浮层 ===== */
/* 高度自适应内容（覆盖 .tm-modal 的固定高度；内容多少就多高，超过视口才在表格内滚动） */
.tm-modal.pw-modal { width: min(720px, 94vw); height: auto; max-height: 88vh; overflow: hidden; }
.pw-modal .ae-head { flex: none; }
.pw-table-wrap { overflow: auto; min-height: 0; flex: 0 1 auto; }
.pw-table { font-size: 12px; }
.pw-table th { white-space: nowrap; }
.pw-tr { cursor: pointer; }
.pw-tr:hover td { background: var(--menuColor); }
.pw-tr.on td { background: var(--menuColor); }
.pw-td-check { text-align: center; color: var(--borderColor); }
.pw-tr.on .pw-td-check { color: var(--fontActiveColor); }
.pw-td-item { white-space: nowrap; }
.pw-td-item > i { margin-right: 6px; }
.pw-td-status { font-size: 11px; color: var(--borderColor); }
.pw-td-progress { text-align: center; }
.pw-td-progress .prewarm-row-bar { width: 100%; }
.pw-pct { font-size: 10px; color: var(--borderColor); }
.pw-td-time { text-align: center; font-size: 11px; }
.pw-detail { font-size: 11px; color: var(--borderColor); margin-top: 4px; white-space: pre-wrap; flex: none; }
.pw-actions { display: flex; align-items: center; gap: 6px; border-top: 1px solid var(--borderColor); padding-top: 8px; flex: none; }
.pw-actions .kt-btn { width: auto; min-width: 29px; padding: 0 8px; }
.pw-run-label { margin-left: 5px; font-size: 12px; }
.pw-badge {
  position: absolute; top: -4px; right: -4px; min-width: 13px; height: 13px;
  padding: 0 3px; border-radius: 7px; background: var(--fontActiveColor); color: #fff;
  font-size: 9px; line-height: 13px; text-align: center;
}
.kt-btn { position: relative; }
.kt-disabled { opacity: .5; pointer-events: none; }

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

/* ===== 智能路由（Agentic）检索过程：行内按钮 + 轨迹模态框 ===== */
.tm-trace-btn {
  font-size: 10px; color: #42A5F5; cursor: pointer;
  display: inline-flex; align-items: center; gap: 3px; white-space: nowrap;
}
.tm-trace-btn:hover { text-decoration: underline; }
.tm-trace-modal { width: min(760px, 92vw); height: min(80vh, 720px); }
.tm-trace-sum {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  padding-bottom: 6px; border-bottom: 1px solid var(--borderColor); font-size: 10px; flex-shrink: 0;
}
.tm-trace-tool {
  padding: 0 5px; line-height: 16px; border-radius: 3px;
  background: color-mix(in srgb, var(--fontActiveColor) 14%, var(--backgroundColor));
  color: var(--fontActiveColor); white-space: nowrap;
}
.tm-trace-stat { color: var(--fontColor); opacity: .8; white-space: nowrap; }
.tm-trace-warn { color: #FF9800; }
.tm-trace-note { color: var(--borderColor); }
.tm-trace-empty { padding: 10px; font-size: 11px; color: var(--borderColor); line-height: 1.6; }
/* 大模型判定结果行 */
.tm-judge-line {
  display: flex; align-items: flex-start; gap: 5px; flex-shrink: 0;
  padding: 5px 7px; font-size: 11px; line-height: 1.5; border-radius: 4px;
  border: 1px solid var(--borderColor); background: var(--backgroundColor); color: var(--fontColor);
}
.tm-judge-line.hit { border-color: #4CAF50; color: #4CAF50; }
.tm-judge-line.err { border-color: #FF9800; color: #FF9800; }
.tm-judge-reason { color: var(--fontColor); opacity: .8; }
.tm-judge-hit { color: #4CAF50 !important; }
.tm-step {
  border: 1px solid var(--borderColor); border-radius: 4px;
  padding: 4px 6px; margin-bottom: 5px; background: var(--backgroundColor);
}
.tm-step-head { display: flex; align-items: center; gap: 6px; }
.tm-step-round {
  min-width: 18px; height: 16px; padding: 0 3px; border-radius: 8px;
  background: var(--fontActiveColor); color: #fff; font-size: 10px;
  display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.tm-step-kind {
  font-size: 9px; padding: 0 4px; line-height: 14px; border-radius: 3px; white-space: nowrap;
  border: 1px solid var(--borderColor); color: var(--borderColor);
}
.tm-step-kind.prefetch { border-color: #607D8B; color: #607D8B; }
.tm-step-kind.tool { border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
.tm-step-kind.fallback { border-color: #FF9800; color: #FF9800; }
.tm-step-kind.model { border-color: var(--borderColor); color: var(--fontColor); opacity: .7; }
.tm-step-note { font-size: 9px; color: var(--fontColor); opacity: .7; }
.tm-step-args-label { color: var(--borderColor); margin-right: 3px; }
.tm-step-tool { font-size: 11px; font-weight: 600; color: var(--fontColor); }
.tm-step-status { margin-left: auto; font-size: 9px; display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0; }
.tm-step-status.running { color: #409EFF; }
.tm-step-status.done { color: #67C23A; }
.tm-step-status.error { color: #F56C6C; }
.tm-step-args { margin-top: 3px; font-size: 9px; color: var(--borderColor); word-break: break-all; }
.tm-step-result {
  margin-top: 3px; font-size: 11px; line-height: 1.45; color: var(--fontColor);
  max-height: 160px; overflow: auto; white-space: pre-wrap; word-break: break-word;
}

/* 工具栏无需横向滑块（覆盖 kb-view.css 的 overflow-x:auto）：空间不足时内容裁切，保持单行 */
.kt-toolbar { overflow-x: hidden; }

</style>