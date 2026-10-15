<script setup lang="ts">
import { ref, computed, reactive, watch, onMounted, nextTick } from 'vue'
import block_md from '@/components/block_md.vue'
import * as XLSX from 'xlsx'
import {usestore} from '@/store'
import { runStrategy, runStrategyWith, getEnabledStrategies, getStrategy } from '@/shared/graphrag/strategy'
import type { AgentStep, StrategyDef } from '@/shared/graphrag/strategy'
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
  settings: {
    searchNum: number
    repeat: number
    hitMode: 'slice' | 'text' | 'llm'
    matchMode: 'precise' | 'fuzzy'
    /** Hit@K 曲线 K 上限（0=跟随切片数量） */
    hitKMax?: number
    /** 消融实验配置（策略参数变体）：随 .kb 保存，用于复现实验与解析变体标签 */
    ablation?: any[]
  }
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
  /** 本次检索/召回耗时（毫秒，墙钟）：含本次实际发生的嵌入与对话模型调用 */
  recallTimeMs?: number
  /** 耗时拆分（本地计算 / 嵌入 / 对话模型 + 嵌入缓存命中率）：见 RetrievalTiming */
  timing?: RetrievalTiming
  /** Hit@K 用：关联切片/参考答案在完整排名池里的最前位次（0=池内未命中；大模型判定=模型给出的位次） */
  hitRank?: number
  /** Hit@K 的分母基准：本次考察的排名池深度（深度不足 K 的题不计入该 K 的分母） */
  rankPoolSize?: number
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
  /** 本次召回耗时（毫秒，墙钟） */
  timeMs?: number
  /** 耗时拆分（本地计算 / 嵌入 / 对话模型 + 嵌入缓存命中率）：见 RetrievalTiming */
  timing?: RetrievalTiming
  /** Hit@K 用（随 .kb 保存）：完整排名池里的最前命中位次与池深度 */
  hitRank?: number
  rankPoolSize?: number
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
  /** Hit@K 曲线的 K 上限：0=跟随切片数量（默认）；1~100 可显式指定（画更深的召回曲线用） */
  hitKMax: 0 as any,
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

// ==================== 消融实验：策略参数变体 ====================
// 一个「变体」= 基础策略 + 参数覆盖（步骤参数 / 全局检索参数 / 策略级开关）。
// 同一策略可以配置多组（复制变体 → 改一个参数），批量测试「全部策略」时逐个变体跑同一批问题，
// 结果在对比表 / Hit@K 曲线 / 导出里各占一列（或一行），从而看清单个参数的边际贡献。
// 变体不改动全局策略注册表：运行时用 runStrategyWith(变体 def) 直接执行。
interface AblationRun {
  /** 变体唯一 id（创建时生成；复制变体会生成新 id）：结果归属与保存/恢复用 */
  id: string
  /** 基础策略 id（来自策略注册表） */
  strategyId: string
  /** 自定义标签；留空则按「策略名 · 覆盖参数摘要」自动生成（摘要用短键，便于画图图例） */
  label?: string
  enabled: boolean
  /** 该变体检索的切片数 K（留空=跟随面板「切片数量」）。它同时也是该变体 Hit@K 曲线的 K 上限 */
  searchNum?: number
  /** 全局检索参数覆盖（写进 ctx.config：BM25 / 增强权重 / 实体链接 LLM 兜底等） */
  config?: {
    summaryWeight?: number
    bm25Enabled?: boolean
    bm25Weight?: number
    entityLinkLlm?: boolean
    agentToolTopN?: number
    agentSubQueryWeight?: number
  }
  /** 步骤参数覆盖：键 = `${原语}#${第几次出现}`（如 dense_score#0），值 = 该步骤的参数补丁 */
  stepParams?: Record<string, Record<string, any>>
  /** 策略级字段覆盖（agentic：maxRounds / agentTools / agentFallback / agentToolTopN / agentSubQueryWeight；
   *  hybrid：channels / channelTopN / rerank 等） */
  defPatch?: Record<string, any>
}

/** 由消融配置构建出的可执行变体 */
interface AblationVariant {
  /** 变体 id（=`${基础策略id}~${变体id}`）：作为结果里的 algorithm/strategyId，统计与导出都按它分组 */
  id: string
  runId: string
  strategyId: string
  label: string
  searchNum?: number
  config?: AblationRun['config']
  def: StrategyDef
}

const ablation = reactive({ runs: [] as AblationRun[] })
const ABLATION_LS_KEY = 'kb_test_ablation_v1'
let _ablationSeq = 0
const newAblationId = () => `v${Date.now().toString(36)}${(_ablationSeq++).toString(36)}`

/** 消融组参数弹出面板：当前正在编辑的组 id（''=未选中）。表格行内只显示参数摘要，避免列宽被控件撑坏 */
const ablationEditRunId = ref('')
const ablationEditRun = computed<AblationRun | null>(() =>
  ablation.runs.find(r => r.id === ablationEditRunId.value) || null)
/** 策略配置面板（消融组列表 + 参数 + 将执行清单）：开关与关闭 */
const configPanelOpen = ref(false)
const openConfigPanel = (run?: AblationRun) => {
  if (run) ablationEditRunId.value = run.id
  else if (!ablationEditRunId.value && ablation.runs.length) ablationEditRunId.value = ablation.runs[0].id
  configPanelOpen.value = true
}
const closeConfigPanel = () => { configPanelOpen.value = false }
/** 配对显著性检验面板（内容较宽，改为弹出面板 + 工具栏按钮） */
const sigPanelOpen = ref(false)

/** 参数短名（自动标签用；保持 ASCII 便于直接作为图表图例） */
const ABLATION_KEY_ABBR: Record<string, string> = {
  summaryWeight: 'sw', weight: 'fw', boostWeight: 'bw', minBaseScore: 'minBase',
  hops: 'hops', maxPerHop: 'maxPerHop', maxRounds: 'rounds', agentToolTopN: 'toolTopN',
  agentSubQueryWeight: 'subQ', bm25Weight: 'bm25w', bm25Enabled: 'bm25', entityLinkLlm: 'entLLM',
  agentFallback: 'fallback', agentWarmStart: 'warm', topK: 'topK', metric: 'rerank',
  dense: 'dense', entity: 'ent', file: 'file', community: 'comm', graph: 'graph',
}
const abbrOf = (k: string): string => ABLATION_KEY_ABBR[k] || k
const fmtParamVal = (v: any): string =>
  typeof v === 'boolean' ? (v ? 'on' : 'off') : (typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : String(v))

/** 变体显示标签：用户填了用用户的，否则「策略名 · 覆盖参数摘要」 */
const ablationLabel = (run: AblationRun, base: StrategyDef): string => {
  if (run.label && run.label.trim()) return run.label.trim()
  const ovr = ablationOverrideText(run)
  return ovr ? `${base.label} · ${ovr}` : base.label
}

/** 参数覆盖摘要（行内展示 / 自动标签共用）：如「sw=0.3 · bw=2 · K=10」，短键便于直接当图表图例 */
const ablationOverrideText = (run: AblationRun): string => {
  const parts: string[] = []
  if (run.searchNum) parts.push(`K=${run.searchNum}`)
  for (const [k, v] of Object.entries(run.config || {})) if (v !== undefined) parts.push(`${abbrOf(k)}=${fmtParamVal(v)}`)
  for (const patch of Object.values(run.stepParams || {})) {
    for (const [k, v] of Object.entries(patch || {})) if (v !== undefined) parts.push(`${abbrOf(k)}=${fmtParamVal(v)}`)
  }
  const dp: any = run.defPatch || {}
  for (const k of ['maxRounds', 'agentToolTopN', 'agentSubQueryWeight', 'agentWarmStart', 'agentFallback']) {
    if (dp[k] !== undefined) parts.push(`${abbrOf(k)}=${fmtParamVal(dp[k])}`)
  }
  if (dp.channels) parts.push('ch=' + Object.entries(dp.channels).filter(([, on]) => on).map(([c]) => abbrOf(c)).join('+'))
  if (dp.agentTools) parts.push('tools=' + Object.entries(dp.agentTools).filter(([, on]) => on).map(([t]) => abbrOf(t)).join('+'))
  if (dp.rerank?.metric) parts.push('rerank=' + dp.rerank.metric)
  if (dp.rerank?.topK !== undefined) parts.push(`topK=${fmtParamVal(dp.rerank.topK)}`)
  return parts.join(' · ')
}

/** 仅保留已定义的覆盖项（避免用 undefined 覆盖掉配置里的有效值） */
const definedOnly = (o?: Record<string, any>): Record<string, any> => {
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(o || {})) if (v !== undefined && v !== null) out[k] = v
  return out
}

/** 由消融配置构建可执行变体（步骤参数与通道/工具开关「深合并」到基础策略定义上） */
const ablationVariants = computed<AblationVariant[]>(() => {
  // 依赖父级策略版本：策略改名/停用/改步骤后（注册表在模块级），变体定义与标签需要跟着刷新
  void props.strategyVersion
  const out: AblationVariant[] = []
  for (const run of ablation.runs) {
    const base = getStrategy(run.strategyId)
    if (!base) continue
    const occ = new Map<string, number>()
    const steps = (base.steps || []).map((st) => {
      const n = occ.get(st.primitive) || 0
      occ.set(st.primitive, n + 1)
      const patch = run.stepParams?.[`${st.primitive}#${n}`]
      return (patch && Object.keys(patch).length)
        ? { ...st, params: { ...(st.params || {}), ...definedOnly(patch) } }
        : { ...st }
    })
    const dp: any = definedOnly(run.defPatch)
    const def: StrategyDef = {
      ...base,
      ...dp,
      id: `${base.id}~${run.id}`,
      label: ablationLabel(run, base),
      steps,
      // 开关类字段深合并：不能整体替换，否则会丢掉基础策略其它通道/工具的既有配置
      agentTools: dp.agentTools ? { ...(base.agentTools || {}), ...dp.agentTools } : base.agentTools,
      channels: dp.channels ? { ...(base.channels || {}), ...dp.channels } : base.channels,
      channelTopN: dp.channelTopN ? { ...(base.channelTopN || {}), ...dp.channelTopN } : base.channelTopN,
      rerank: dp.rerank ? { ...(base.rerank || {}), ...dp.rerank } : base.rerank,
      builtin: true,
      enabled: true,
    }
    out.push({
      id: def.id, runId: run.id, strategyId: base.id,
      label: def.label, searchNum: run.searchNum,
      config: Object.keys(definedOnly(run.config)).length ? definedOnly(run.config) as any : undefined,
      def,
    })
  }
  return out
})
const ablationVariantMap = computed(() => new Map(ablationVariants.value.map(v => [v.id, v])))

/** 启用的消融变体（批量测试实际执行的配置）：为空则退回「每个启用策略跑一次」的默认行为 */
const ablationEnabledVariants = computed(() => {
  const baseIds = new Set(getEnabledStrategies().map(s => s.id))
  const enabled = new Set(ablation.runs.filter(r => r.enabled).map(r => r.id))
  return ablationVariants.value.filter(v => enabled.has(v.runId) && baseIds.has(v.strategyId))
})

/**
 * 「批量测试所有策略」实际会执行的清单（策略配置面板里预览用，也是运行循环的唯一来源，
 * 保证预览与实际执行完全一致）：有启用的消融组 → 逐组执行；否则 → 每个启用策略按默认参数跑一次。
 */
const batchRunPreview = computed<Array<{ id: string; runId?: string; label: string; searchNum?: number; kind: 'variant' | 'strategy' }>>(() =>
  ablationEnabledVariants.value.length
    ? ablationEnabledVariants.value.map(v => ({ id: v.id, runId: v.runId, label: v.label, searchNum: v.searchNum, kind: 'variant' as const }))
    : algorithmOptions.value.map(o => ({ id: o.value, runId: undefined, label: o.label, searchNum: undefined, kind: 'strategy' as const })))

/** 组的显示名：自定义标签优先，否则用基础策略名（参数摘要另起一行展示） */
const ablationBaseLabel = (run: AblationRun): string => {
  const custom = (run.label || '').trim()
  if (custom) return custom
  const base = ablationBaseDef(run)
  return base ? base.label : run.strategyId
}

/** 算法 id → 策略定义：变体 id 走变体表，普通 id 走注册表 */
const defOf = (algo: string): StrategyDef | undefined => ablationVariantMap.value.get(algo)?.def || getStrategy(algo)
/** 算法 id → 策略类型（判断是否智能路由等） */
const kindOf = (algo: string): string | undefined => defOf(algo)?.kind
/** 算法 id → 展示标签（变体优先；未注册变体（如恢复的旧结果）退化为 id） */
const labelOf = (algo: string): string =>
  ablationVariantMap.value.get(algo)?.label || algorithmOptions.value.find(o => o.value === algo)?.label || algo

/** 变体的「机器可读参数摘要」（导出/复现实验用）：只列覆盖项，如 "searchNum=10; dense_score#0.summaryWeight=0.3" */
const variantParamSummary = (algo: string): string => {
  const v = ablationVariantMap.value.get(algo)
  const run = v ? ablation.runs.find(r => r.id === v.runId) : undefined
  if (!run) return ''
  const parts: string[] = []
  if (run.searchNum) parts.push(`searchNum=${run.searchNum}`)
  for (const [k, val] of Object.entries(run.config || {})) if (val !== undefined) parts.push(`config.${k}=${fmtParamVal(val)}`)
  for (const [stepKey, patch] of Object.entries(run.stepParams || {})) {
    for (const [k, val] of Object.entries(patch || {})) if (val !== undefined) parts.push(`${stepKey}.${k}=${fmtParamVal(val)}`)
  }
  for (const [k, val] of Object.entries(run.defPatch || {})) {
    if (val === undefined) continue
    parts.push(typeof val === 'object' ? `${k}=${JSON.stringify(val)}` : `${k}=${fmtParamVal(val)}`)
  }
  return parts.join('; ')
}

/** 变体面板：基础策略定义（决定展示哪些参数、以及各参数的默认值提示） */
const ablationBaseDef = (run: AblationRun): StrategyDef | undefined => getStrategy(run.strategyId)
const ablationKind = (run: AblationRun): string => ablationBaseDef(run)?.kind || 'pipeline'
const ablationHasPrimitive = (run: AblationRun, p: string): boolean =>
  (ablationBaseDef(run)?.steps || []).some((s: any) => s?.primitive === p)
/** 未填 label 时输入框的占位（= 自动标签） */
const ablationAutoLabel = (run: AblationRun): string => {
  const base = ablationBaseDef(run)
  return base ? ablationLabel({ ...run, label: '' }, base) : ''
}
/** 基础策略里某步骤的当前参数（输入框占位用，提示「留空=用默认」） */
const ablationBaseParams = (run: AblationRun, stepKey: string): Record<string, any> => {
  const base = ablationBaseDef(run)
  if (!base) return {}
  const occ = new Map<string, number>()
  for (const st of base.steps || []) {
    const n = occ.get(st.primitive) || 0
    occ.set(st.primitive, n + 1)
    if (`${st.primitive}#${n}` === stepKey) return { ...(st.params || {}) }
  }
  return {}
}
/** 该变体的覆盖项数量（面板折叠标题显示） */
const ablationOverrideCount = (run: AblationRun): number => {
  let n = 0
  if (run.searchNum) n++
  n += Object.keys(definedOnly(run.config)).length
  for (const patch of Object.values(run.stepParams || {})) n += Object.keys(definedOnly(patch)).length
  const dp: any = run.defPatch || {}
  for (const [k, v] of Object.entries(dp)) if (v !== undefined && k !== 'agentTools' && k !== 'channels' && k !== 'channelTopN') n++
  n += Object.keys(dp.agentTools || {}).length + Object.keys(dp.channels || {}).length + Object.keys(dp.channelTopN || {}).length
  return n
}
/** 智能路由工具开关：变更写入 defPatch（稀疏写入，未触碰的跟随基础策略） */
const ablationToolOn = (run: AblationRun, key: string): boolean => {
  const patch = (run.defPatch as any)?.agentTools
  return patch?.[key] ?? (ablationBaseDef(run)?.agentTools?.[key] ?? true)
}
const setAblationTool = (run: AblationRun, key: string, on: boolean) => {
  const dp = ablationDefPatchRef(run)
  if (!dp.agentTools) dp.agentTools = {}
  dp.agentTools[key] = on
}
/** 混合策略通道开关 */
const ablationChannelOn = (run: AblationRun, key: string): boolean => {
  const patch = (run.defPatch as any)?.channels
  return patch?.[key] ?? (ablationBaseDef(run)?.channels?.[key] ?? false)
}
const setAblationChannel = (run: AblationRun, key: string, on: boolean) => {
  const dp = ablationDefPatchRef(run)
  if (!dp.channels) dp.channels = {}
  dp.channels[key] = on
}
/** 通道候选上限（hybrid） */
const ablationChannelTopN = (run: AblationRun, key: string): number | string => {
  const patch = (run.defPatch as any)?.channelTopN
  return patch?.[key] ?? ''
}
const setAblationChannelTopN = (run: AblationRun, key: string, v: any) => {
  const dp = ablationDefPatchRef(run)
  if (!dp.channelTopN) dp.channelTopN = {}
  if (v === '' || v === null || isNaN(Number(v))) delete dp.channelTopN[key]
  else dp.channelTopN[key] = Number(v)
}
/** 策略级数值/布尔覆盖（maxRounds / agentToolTopN / agentSubQueryWeight / agentFallback 等） */
const ablationPatchVal = (run: AblationRun, key: string): any => (run.defPatch as any)?.[key] ?? ''
const setAblationPatchVal = (run: AblationRun, key: string, v: any) => {
  const dp = ablationDefPatchRef(run)
  if (v === '' || v === null || v === undefined || (typeof v === 'number' && isNaN(v))) delete dp[key]
  else dp[key] = v
}
/** 该变体可编辑的步骤参数分组（含基础值，供占位提示） */
const ablationStepsOf = (run: AblationRun) => {
  const base = ablationBaseDef(run)
  return ablationStepFields(base).map(st => ({ ...st, base: ablationBaseParams(run, st.key) }))
}
/** 一键按「每个启用策略一组」铺开消融列表（默认无覆盖=基线） */
const addDefaultAblationSet = () => {
  for (const opt of algorithmOptions.value) {
    if (!ablation.runs.some(r => r.strategyId === opt.value)) addAblationRun(opt.value)
  }
}

/** 全局检索参数覆盖的写入（空值=删除覆盖，回到设置面板默认） */
const setAblationConfigVal = (run: AblationRun, key: string, v: any) => {
  const cfg = ablationConfigRef(run)
  if (v === '' || v === null || v === undefined || (typeof v === 'number' && isNaN(Number(v)))) delete cfg[key]
  else cfg[key] = typeof v === 'boolean' ? v : Number(v)
}
const setAblationConfigBool = (run: AblationRun, key: string, on: boolean) => {
  const cfg = ablationConfigRef(run)
  cfg[key] = on
}
/** 全局检索参数当前值（未覆盖时显示设置面板的值，便于对比） */
const ablationConfigDefault = (key: string): string => {
  const d: Record<string, string> = {
    summaryWeight: String(props.model?.summaryWeight ?? 0.7),
    bm25Weight: String(props.model?.bm25Weight ?? 0.3),
    bm25Enabled: props.model?.bm25Enabled ? 'on' : 'off',
    entityLinkLlm: props.model?.entityLinkLlm !== false ? 'on' : 'off',
    agentToolTopN: String(props.model?.agentToolTopN ?? 15),
    agentSubQueryWeight: String(props.model?.agentSubQueryWeight ?? 0.5),
  }
  return d[key] ?? ''
}
const ablationConfigOn = (run: AblationRun, key: string): boolean => {
  const v = (run.config as any)?.[key]
  if (v !== undefined) return !!v
  if (key === 'bm25Enabled') return !!props.model?.bm25Enabled
  if (key === 'entityLinkLlm') return props.model?.entityLinkLlm !== false
  return false
}
/** 步骤参数覆盖的写入（空值=删除覆盖） */
const setAblationStepParam = (run: AblationRun, stepKey: string, key: string, v: any) => {
  const patch = ablationParamRef(run, stepKey)
  if (v === '' || v === null || v === undefined || (typeof v === 'number' && isNaN(Number(v)))) delete patch[key]
  else patch[key] = typeof v === 'boolean' ? v : Number(v)
}
const ablationStepParamVal = (run: AblationRun, stepKey: string, key: string): any =>
  (run.stepParams?.[stepKey] as any)?.[key]
/** 某智能路由变体是否需要展示「工具候选数 / 子查询权重」（策略级字段优先于全局配置） */
const ablationAgentic = (run: AblationRun): boolean => ablationKind(run) === 'agentic'
const ablationHybrid = (run: AblationRun): boolean => ablationKind(run) === 'hybrid'

/** 智能路由工具键（消融：关掉某个工具看它对召回的贡献） */
const AGENT_TOOL_KEYS = [
  { key: 'kb_search', desc: '事实检索（稠密切片 + 文件语义）', descEn: 'dense + file-semantic search' },
  { key: 'file_search', desc: '文件摘要检索', descEn: 'file summary search' },
  { key: 'entity_link', desc: '实体定位', descEn: 'entity linking' },
  { key: 'entity_slice', desc: '实体关联切片', descEn: 'entity-linked slices' },
  { key: 'graph_hop', desc: '图谱多跳', descEn: 'graph multi-hop' },
  { key: 'community_search', desc: '社区报告检索', descEn: 'community reports' },
]
/** 混合策略通道键（消融：逐个关闭通道看边际贡献） */
const CHANNEL_KEYS = [
  { key: 'dense', desc: '语义通道（切片稠密检索）', descEn: 'dense slices' },
  { key: 'entity', desc: '实体通道', descEn: 'entity' },
  { key: 'file', desc: '文件摘要通道', descEn: 'file summaries' },
  { key: 'community', desc: '社区通道', descEn: 'community' },
  { key: 'graph', desc: '图谱多跳通道', descEn: 'graph' },
]
/** 该组的切片数 K（留空=跟随工具栏「切片数量」） */
const setAblationSearchNum = (run: AblationRun, v: any) => {
  const n = Number(v)
  if (v === '' || v === null || v === undefined || isNaN(n)) delete run.searchNum
  else run.searchNum = Math.max(1, Math.min(100, Math.round(n)))
}
/** 混合策略 rerank 覆盖（metric / topK） */
const setAblationRerank = (run: AblationRun, key: string, v: any) => {
  const dp = ablationDefPatchRef(run)
  if (!dp.rerank) dp.rerank = {}
  if (v === '' || v === null || v === undefined || (key === 'topK' && isNaN(Number(v)))) delete dp.rerank[key]
  else dp.rerank[key] = key === 'topK' ? Number(v) : v
  if (!Object.keys(dp.rerank).length) delete dp.rerank
}
/** 重置该组的所有参数覆盖（保留策略、标签与启用状态） */
const resetAblationRun = (run: AblationRun) => {
  delete run.searchNum
  delete run.config
  delete run.stepParams
  delete run.defPatch
}


/** Hit@K 曲线在「完整排名池」里统计到的最大深度：更深的位次对召回评测无意义，同时限制逐块匹配的开销 */
const HIT_K_POOL_CAP = 100
/** Hit@K 的 K 上限：面板设置优先，否则取本次评测用到的最大切片数（= 用户说的「切片数量」） */
const hitKCap = computed(() => {
  const set = Math.max(0, Math.min(HIT_K_POOL_CAP, parseInt(String(test.hitKMax)) || 0))
  if (set > 0) return set
  const used = [parseInt(String(test.searchNum)) || 5, ...ablationEnabledVariants.value.map(v => v.searchNum || 0)]
  return Math.max(1, Math.min(HIT_K_POOL_CAP, Math.max(...used)))
})

// 消融配置的增删改（面板用）
const addAblationRun = (strategyId?: string, copyFrom?: AblationRun) => {
  const sid = strategyId || copyFrom?.strategyId || algorithmOptions.value[0]?.value || ''
  if (!sid) return
  const run: AblationRun = copyFrom
    ? { ...JSON.parse(JSON.stringify(copyFrom)), id: newAblationId(), label: '', enabled: true }
    : { id: newAblationId(), strategyId: sid, enabled: true, stepParams: {}, defPatch: {} }
  ablation.runs.push(run)
}
const removeAblationRun = (id: string) => {
  const i = ablation.runs.findIndex(r => r.id === id)
  if (i >= 0) ablation.runs.splice(i, 1)
}
const setAblationEnabled = (on: boolean) => { for (const r of ablation.runs) r.enabled = on }
const clearAblationRuns = () => { ablation.runs = [] }
/** 复制一组并选中新组（便于只改一个参数做对照） */
const duplicateAblationRun = (run: AblationRun) => {
  addAblationRun(undefined, run)
  const last = ablation.runs[ablation.runs.length - 1]
  if (last) ablationEditRunId.value = last.id
}
/** 尚未配置消融组的启用策略（左栏列出，点击即可为其新增一组=用默认参数跑基线） */
const ablationStrategiesWithoutGroup = computed(() =>
  algorithmOptions.value.filter(o => !ablation.runs.some(r => r.strategyId === o.value)))
/** 为某策略新增一组并选中 */
const addAblationRunFor = (strategyId: string) => {
  addAblationRun(strategyId)
  const last = ablation.runs[ablation.runs.length - 1]
  if (last) ablationEditRunId.value = last.id
}

/**
 * 取/建某变体某步骤的参数补丁（面板 v-model 用）：键 = `${原语}#${出现序号}`。
 * 写值时若与基础策略默认值相同会被清掉（保持覆盖集最小，自动标签也只显示真正的改动）。
 */
const ablationParamRef = (run: AblationRun, key: string): Record<string, any> => {
  if (!run.stepParams) run.stepParams = {}
  if (!run.stepParams[key]) run.stepParams[key] = {}
  return run.stepParams[key]
}
const ablationConfigRef = (run: AblationRun): Record<string, any> => {
  if (!run.config) (run as any).config = {}
  return run.config as any
}
const ablationDefPatchRef = (run: AblationRun): Record<string, any> => {
  if (!run.defPatch) (run as any).defPatch = {}
  return run.defPatch as any
}
/** 该策略定义里可编辑的步骤参数清单（原语 + 出现序号 + 参数描述符 + 当前生效值） */
const ablationStepFields = (def: StrategyDef | undefined) => {
  const occ = new Map<string, number>()
  return (def?.steps || []).map((st) => {
    const n = occ.get(st.primitive) || 0
    occ.set(st.primitive, n + 1)
    return {
      key: `${st.primitive}#${n}`,
      primitive: st.primitive,
      index: n,
      fields: stepParamFields(st),
    }
  })
}

/** 步骤参数描述符：只列「值得做消融」的参数；表里没有但步骤自身携带的数值/布尔参数也会自动补上 */
interface StepParamField {
  key: string
  label: string
  labelEn: string
  type: 'number' | 'checkbox' | 'select'
  min?: number
  max?: number
  step?: number
  options?: Array<{ value: string; label: string; labelEn?: string }>
  tip?: string
  tipEn?: string
}
const STEP_PARAM_FIELDS: Record<string, StepParamField[]> = {
  dense_score: [
    { key: 'summaryWeight', label: '增强权重 Q', labelEn: 'Enhance weight', type: 'number', min: 0, max: 1, step: 0.05, tip: '问题增强通道（问题向量）权重：0=纯切片相似度，1=纯问题增强', tipEn: 'Question-enhance channel weight: 0 = pure slice similarity' },
    { key: 'bm25Enabled', label: 'BM25', labelEn: 'BM25', type: 'checkbox', tip: '该步骤是否叠加 BM25 稀疏分', tipEn: 'Add BM25 sparse score in this step' },
    { key: 'bm25Weight', label: 'BM25 权重', labelEn: 'BM25 weight', type: 'number', min: 0, max: 1, step: 0.05 },
  ],
  file_score: [
    { key: 'weight', label: '文件通道权重', labelEn: 'File weight', type: 'number', min: 0, max: 1, step: 0.05 },
  ],
  boost: [
    { key: 'boostWeight', label: '提升倍率', labelEn: 'Boost', type: 'number', min: 0.5, max: 3, step: 0.1 },
    { key: 'minBaseScore', label: '生效门槛', labelEn: 'Min base', type: 'number', min: 0, max: 1, step: 0.05, tip: '基础分低于该值时乘性提升不生效（抑制假阳性）', tipEn: 'Boost is skipped when base score is below this' },
    { key: 'source', label: '来源', labelEn: 'Source', type: 'select', options: [
      { value: 'entity', label: '实体', labelEn: 'entity' },
      { value: 'hop', label: '多跳', labelEn: 'hop' },
      { value: 'community', label: '社区', labelEn: 'community' },
    ] },
  ],
  graph_hop: [
    { key: 'hops', label: '跳数', labelEn: 'Hops', type: 'number', min: 1, max: 3, step: 1 },
    { key: 'maxPerHop', label: '每跳上限', labelEn: 'Max per hop', type: 'number', min: 1, max: 10, step: 1 },
  ],
  community_select: [],
}

/** 某步骤可编辑的参数：描述符 ∪ 步骤自定义参数（数值/布尔），并带上当前生效值 */
const stepParamFields = (st: any): Array<StepParamField & { current: any }> => {
  const declared = STEP_PARAM_FIELDS[st?.primitive] || []
  const known = new Set(declared.map(d => d.key))
  const extra: StepParamField[] = Object.entries(st?.params || {})
    .filter(([k, v]) => !known.has(k) && (typeof v === 'number' || typeof v === 'boolean'))
    .map(([k, v]) => ({ key: k, label: k, labelEn: k, type: typeof v === 'boolean' ? 'checkbox' : 'number' }))
  return [...declared, ...extra].map(f => ({ ...f, current: st?.params?.[f.key] }))
}

// 消融配置持久化：随 .kb 快照保存（emitTestData/restoreTestData），并额外写一份 localStorage，
// 便于「重开应用后沿用上次的消融矩阵」
const saveAblationLocal = () => {
  try { localStorage.setItem(ABLATION_LS_KEY, JSON.stringify(ablation.runs)) } catch { /* 忽略隐私模式等写入失败 */ }
}
const loadAblationLocal = () => {
  try {
    const raw = localStorage.getItem(ABLATION_LS_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) ablation.runs = parsed.filter((r: any) => r?.id && r?.strategyId)
  } catch { /* 忽略损坏数据 */ }
}
watch(() => ablation.runs, saveAblationLocal, { deep: true })


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

// ==================== 批量测试提速：查询向量缓存 / 批量预嵌入 / 运行内共享数据 ====================
// 批量测试对「同一问题 × 每个策略 × 每轮重复」反复检索，而每个策略内部都要把查询文本嵌入一次
// （dense_score / file_score / entity_link / 智能路由重排共享同一查询向量）。原实现每次检索都新建
// 检索服务并即时请求，于是同一问题被重复嵌入「策略数 × 重复轮数」次，且每次都是一条独立 HTTP 往返
// （本地嵌入服务还会因为与对话调用交替而反复换载模型）。这里做三件事：
//   1) 查询向量缓存（文本 → 向量）：同一问题在整个评测期间只嵌入一次，所有策略 / 重复轮共享；
//   2) 批量预嵌入：评测开始前按批（QUERY_EMBED_BATCH 条/请求）一次嵌入全部问题，把「N 次往返」
//      压成「⌈N/批量⌉ 次」，并把嵌入调用集中到对话调用之前（避免模型反复换载）；
//   3) 运行内共享「本体上下文 + 实体→切片索引 + 检索服务对象」：整轮评测恒定，无需每题每策略重建
//      （父级 getCurrentOntologyContext 的关系映射是 O(关系×实体)，实体缺关联时索引是 O(实体×切片)）。
// 计时口径见 RetrievalTiming：命中缓存的嵌入耗时≈0，故检索墙钟时间变成「热缓存耗时」；
// 「在线延迟」用冷启动单条嵌入延迟（coldEmbedMs，由预嵌入阶段实测）替代被缓存掉的嵌入耗时还原。
const QUERY_EMBED_BATCH = 32

/** 查询向量缓存（问题文本 → 向量）：同一文本整个评测期间只嵌入一次（跨策略 / 跨重复轮 / 跨批量运行） */
const queryVecCache = new Map<string, number[]>()

/** 缓存容量上限（FIFO 淘汰）：长时间评测（智能路由子查询文本各不相同）不至于无限增长；
 *  淘汰只降低命中率（miss 会重新嵌入），不影响正确性 */
const QUERY_VEC_CACHE_MAX = 5000
const cacheQueryVec = (text: string, v?: number[]): boolean => {
  if (!v || !v.length) return false
  const k = String(text ?? '')
  if (queryVecCache.size >= QUERY_VEC_CACHE_MAX && !queryVecCache.has(k)) {
    const oldest = queryVecCache.keys().next().value
    if (oldest !== undefined) queryVecCache.delete(oldest)
  }
  queryVecCache.set(k, v)
  return true
}

/**
 * 单次检索的耗时拆分（毫秒）。用于把「策略自身成本」与「模型/网络成本」分开统计：
 *  - localMs：本地检索计算（打分/融合/排序/图遍历等）= 墙钟 − 嵌入 − 对话模型；
 *  - embedMs：本次检索真正花在嵌入请求上的时间（命中缓存≈0）；
 *  - llmMs：本次检索真正花在对话模型上的时间（智能路由含工具轮）；
 *  - embedHits/embedMisses：嵌入缓存命中情况（说明「热缓存」程度）。
 */
interface RetrievalTiming {
  totalMs: number
  embedMs: number
  llmMs: number
  localMs: number
  embedHits: number
  embedMisses: number
}

/** 当前正在计时的检索桶。performSearch 顺序执行（批量/单题都不并发），故用单个可变桶；
 *  将来若引入并发检索，需改成按题传入上下文，避免串桶。 */
let timingBucket: { embedMs: number; llmMs: number; embedHits: number; embedMisses: number } | null = null
const newTimingBucket = () => ({ embedMs: 0, llmMs: 0, embedHits: 0, embedMisses: 0 })

/** 冷启动单条嵌入延迟（毫秒，中位数）：用于把被缓存掉的嵌入耗时还原进「在线延迟」口径 */
const coldEmbedMs = ref(0)
/** 本次批量预嵌入的统计（问题数 / 请求数 / 每题摊销耗时），供界面说明批量向量化的收益 */
const embedRunStats = reactive({ questions: 0, requests: 0, amortizedMs: 0, coldSingleMs: 0 })

/** 检索服务缓存（含查询向量缓存 + 计时包装）：嵌入端点或模型变化即重建 */
let cachedServices: { key: string; services: ReturnType<typeof kbAi.buildRetrievalServices> } | null = null

/** 检索服务缓存键：嵌入端点或模型变化（含兜底来源）即重建服务并作废查询向量缓存 */
const specServicesKey = (spec: any): string => {
  const c = spec?.config || {}
  const fb = spec?.embedFallback || {}
  const fbc = fb?.config || {}
  return [
    spec?.llmType, spec?.embed,
    c.model_url, c.base_url, c.api_url, c.endpoint, c.apiKeyRef, c.api_version, c.deployment,
    fb.llmType, fb.embed, fbc.model_url, fbc.base_url, fbc.api_url, fbc.endpoint, fbc.apiKeyRef,
  ].map(v => String(v ?? '')).join('|')
}

/**
 * 取检索服务（带查询向量缓存 + 计时包装）。整轮评测复用同一对象：
 *  - embed/embedBatch 命中 queryVecCache 直接返回（不再请求嵌入模型）；
 *  - 同时把嵌入/对话模型耗时累加进 timingBucket，供 performSearch 拆分本次检索耗时。
 */
const retrievalServicesOf = (spec: any): ReturnType<typeof kbAi.buildRetrievalServices> => {
  const key = specServicesKey(spec)
  if (cachedServices && cachedServices.key === key) return cachedServices.services
  const base = kbAi.buildRetrievalServices(spec, { cosineSimilarity, computeBM25: computeBM25Score })
  // 端点/模型变了：旧向量与新模型不可比，全部作废
  queryVecCache.clear()
  coldEmbedMs.value = 0
  const lookup = (text: string): number[] | undefined => queryVecCache.get(String(text ?? ''))
  const remember = cacheQueryVec
  const timedLlm = async <T>(fn: () => Promise<T>): Promise<T> => {
    const t0 = performance.now()
    try { return await fn() } finally { if (timingBucket) timingBucket.llmMs += performance.now() - t0 }
  }
  const services: ReturnType<typeof kbAi.buildRetrievalServices> = {
    ...base,
    embed: async (text: string) => {
      const hit = lookup(text)
      if (hit) { if (timingBucket) timingBucket.embedHits++; return hit }
      const t0 = performance.now()
      try {
        const v = await base.embed(String(text ?? ''))
        remember(text, v)
        return v
      } finally {
        if (timingBucket) { timingBucket.embedMs += performance.now() - t0; timingBucket.embedMisses++ }
      }
    },
    // 批量嵌入：命中缓存的直接返回，只请求缺失部分，且同样按批发送
    embedBatch: async (texts: string[]) => {
      const out: (number[] | undefined)[] = new Array(texts.length)
      const missing: number[] = []
      texts.forEach((t, i) => {
        const hit = lookup(t)
        if (hit) { out[i] = hit; if (timingBucket) timingBucket.embedHits++ } else missing.push(i)
      })
      for (let s = 0; s < missing.length; s += QUERY_EMBED_BATCH) {
        const idx = missing.slice(s, s + QUERY_EMBED_BATCH)
        const t0 = performance.now()
        try {
          const vecs = await base.embedBatch!(idx.map(i => String(texts[i] ?? '')))
          idx.forEach((i, j) => { out[i] = vecs?.[j]; remember(String(texts[i] ?? ''), vecs?.[j]) })
        } catch {
          // 批量接口不可用 → 逐条兜底（与 primitives.embedMany 行为一致，不阻断检索）
          for (const i of idx) {
            try { const v = await base.embed(String(texts[i] ?? '')); out[i] = v; remember(String(texts[i] ?? ''), v) } catch { out[i] = undefined }
          }
        } finally {
          if (timingBucket) { timingBucket.embedMs += performance.now() - t0; timingBucket.embedMisses += idx.length }
        }
      }
      return out
    },
    chat: (messages: any[]) => timedLlm(() => base.chat(messages)),
    streamChat: (messages: any[], onChunk: (c: string) => void) => timedLlm(() => base.streamChat(messages, onChunk)),
    agenticChat: (messages: any[], tools: any[]) => timedLlm(() => base.agenticChat(messages, tools)),
  }
  cachedServices = { key, services }
  return services
}

/**
 * 批量预嵌入问题向量：把「逐问题一次嵌入往返」合并成按批请求，并写入 queryVecCache 供所有策略 /
 * 重复轮直接命中。返回本次真正嵌入成功的问题数（耗时由调用方排除在检索计时之外）。
 * 批量失败（个别端点不接受数组输入）时直接放弃批量、由检索路径按需逐条嵌入，不阻断评测。
 */
const prewarmQueryVectors = async (questions: string[], onProgress?: (msg: string) => void): Promise<number> => {
  const spec = kbSpec()
  // 先确保检索服务与当前嵌入端点一致：端点/模型变化时这里会作废旧向量缓存（必须在预嵌入之前，
  // 否则首次 performSearch 建服务时会把刚批量嵌入的结果清掉）；同一模型下则沿用已有缓存（跨批次复用）
  retrievalServicesOf(spec)
  const uniq: string[] = []
  const seen = new Set<string>()
  for (const q of questions) {
    const t = String(q ?? '').trim()
    if (!t || seen.has(t) || queryVecCache.has(t)) continue
    seen.add(t); uniq.push(t)
  }
  let done = 0
  let requests = 0
  let embedMs = 0
  for (let s = 0; s < uniq.length; s += QUERY_EMBED_BATCH) {
    const chunk = uniq.slice(s, s + QUERY_EMBED_BATCH)
    onProgress?.(store.locales === 'zh'
      ? `批量向量化问题 ${Math.min(s + chunk.length, uniq.length)}/${uniq.length}（每批 ${QUERY_EMBED_BATCH} 条）`
      : `Embedding questions ${Math.min(s + chunk.length, uniq.length)}/${uniq.length} (batch of ${QUERY_EMBED_BATCH})`)
    const t0 = performance.now()
    try {
      const vecs = await kbAi.embed(spec, chunk)
      embedMs += performance.now() - t0
      requests++
      chunk.forEach((t, i) => { if (cacheQueryVec(t, vecs?.[i])) done++ })
    } catch (e) {
      console.warn('[评测] 问题向量批量预嵌入失败，改为检索时按需逐条嵌入:', e)
      break
    }
  }
  // 冷启动单条嵌入延迟：批量完成后模型已加载，再量 3 次单条请求取中位数（无冷启动/换载干扰），
  // 用于「在线延迟」口径——真实的一次用户提问只会嵌入 1 条查询文本。
  // 全部命中缓存（重复跑同一批）时也要测：否则「在线延迟」会退化成 0 嵌入的热缓存时间，失去可比性。
  if (coldEmbedMs.value <= 0) {
    const sampleTexts = (uniq.length ? uniq : questions.map(q => String(q ?? '').trim()).filter(Boolean)).slice(0, 3)
    const samples: number[] = []
    for (const text of sampleTexts) {
      const t0 = performance.now()
      try { await kbAi.embed(spec, text); samples.push(performance.now() - t0) } catch { /* 忽略单次失败 */ }
    }
    if (samples.length) coldEmbedMs.value = samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]
  }
  embedRunStats.questions = done
  embedRunStats.requests = requests
  embedRunStats.amortizedMs = done > 0 ? embedMs / done : 0
  embedRunStats.coldSingleMs = coldEmbedMs.value
  return done
}

/** 评测前批量向量化本次要测的问题（耗时不计入检索时间；结果写入查询向量缓存，整轮复用） */
const prewarmTestQueries = async () => {
  const qs = (test.questions || []).map(q => String(q ?? '').trim()).filter(q => q && !isJunkQuestion(q))
  if (qs.length < 2) return
  const n = await prewarmQueryVectors(qs, (msg) => emit('updateLiveState', msg))
  emit('updateLiveState', '')
  if (n > 0) {
    console.log(store.locales === 'zh'
      ? `[评测] 已批量向量化 ${n} 条问题（${embedRunStats.requests} 次请求，摊销 ${embedRunStats.amortizedMs.toFixed(1)} ms/题；单条请求 ${embedRunStats.coldSingleMs.toFixed(1)} ms）：本批次所有策略 / 重复轮复用缓存向量`
      : `[Eval] batch-embedded ${n} questions (${embedRunStats.requests} requests, ${embedRunStats.amortizedMs.toFixed(1)} ms/question amortized, ${embedRunStats.coldSingleMs.toFixed(1)} ms single): reused by every strategy/round`)
  }
}

/** 单次评测运行内共享的准备数据：整轮恒定（评测期间不改本体/切片），避免每题每策略重建 */
let runScope: {
  ontology: { entities: any[]; relations: any[] }
  entityToBlocks: Map<string, Set<string>>
} | null = null

const beginRunScope = () => {
  runScope = {
    ontology: props.getCurrentOntologyContext?.() || { entities: [], relations: [] },
    entityToBlocks: buildEntityToBlocksIndex(),
  }
  embedRunStats.questions = 0; embedRunStats.requests = 0; embedRunStats.amortizedMs = 0; embedRunStats.coldSingleMs = 0
  coldEmbedMs.value = 0
}
const endRunScope = () => { runScope = null }

// 执行检索（统一走策略框架 runStrategy，与聊天共用同一套检索逻辑，消除实现漂移）
async function performSearch(question: string, searchNum: number, algorithm: SearchAlgorithm, answer?: string, ref?: TestCaseRef): Promise<{
  slices: TestResult['slices'],
  avgScore: number,
  timeMs: number,
  timing: RetrievalTiming,
  /** Hit@K 用：该问题关联切片/参考在「完整排名池」中的最前位次（0=池内未命中） */
  hitRank: number,
  /** Hit@K 的分母基准：本次实际考察的排名池深度（= min(排名池长度, HIT_K_POOL_CAP)；大模型判定=呈现切片数） */
  rankPoolSize: number,
  agent?: AgentTrace,
  llmCalls: number,
  toolCalls: number
}> {
  const startTime = performance.now()
  // 消融变体：命中变体表时用变体定义（步骤参数/开关覆盖）执行，并把变体配置合并进检索配置
  const variant = ablationVariantMap.value.get(algorithm)
  const def = variant?.def || getStrategy(algorithm)
  // 本次检索的耗时桶：由带缓存的检索服务把嵌入/对话模型耗时累加进来（检索顺序执行，见 timingBucket 说明）
  const bucket = newTimingBucket()
  timingBucket = bucket
  // 该策略启用的增强通道（决定是否展示「通道缺失·切片分兜底」标记）
  const algoCh = channelFlagsOf(algorithm)
  // 运行内共享的本体上下文 / 实体→切片索引：批量测试整轮复用（单题测试则即时构建）
  const ontology = runScope?.ontology
  const sharedE2B = runScope?.entityToBlocks

  const ctx: RetrievalContext = {
    query: question,
    blocks: props.blocks,
    entities: (ontology?.entities || props.getCurrentOntologyContext?.()?.entities || []),
    relations: (ontology?.relations || props.getCurrentOntologyContext?.()?.relations || []),
    entityToBlocksIndex: sharedE2B || buildEntityToBlocksIndex(),
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
      // Agentic 最终重排权重与工具候选池（评测与 QA / 主页用同一配置，保证口径一致）
      agentSubQueryWeight: props.model.agentSubQueryWeight ?? 0.5,
      agentToolTopN: props.model.agentToolTopN ?? 15,
      // 消融变体的全局检索参数覆盖（只覆盖显式设置的项，其余跟随设置面板）
      ...(variant?.config || {}),
    },
    services: retrievalServicesOf(kbSpec()),
  }

  let sr: Awaited<ReturnType<typeof runStrategy>>
  try {
    // 变体：用变体定义执行（不改全局注册表）；普通策略走 runStrategy（按 id 查注册表）
    sr = def
      ? await runStrategyWith(def, question, ctx, {}, { skipAnswer: true })
      : await runStrategy(algorithm, question, ctx, {}, { skipAnswer: true })
  } finally {
    // 计时桶收口：策略抛错时也要摘掉，避免后续调用把耗时累加进本次检索
    timingBucket = null
  }

  // Agentic（智能路由）：把工具调用轨迹与工具就绪信息带回，供测试结果「检索过程」按钮回显
  // （runAgentic 已在 meta 内收口 running→done 的合并，其它策略无该字段）
  const agent: AgentTrace | undefined = kindOf(algorithm) === 'agentic'
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

  // ===== Hit@K 曲线：在「策略给出的完整排名池」里找该问题关联切片/参考答案的最前位次 =====
  // 与只看前 searchNum 的 firstRank 分开统计：即使面板切片数=5，也能画出 Hit@1..Hit@20/50 的召回曲线。
  // 大模型判定模式（llm）只能判定被呈现的 searchNum 条，故池深度记为 slices.length，深层 K 由分母缺失显示为「-」。
  let hitRank = 0
  const rankPoolSize = test.hitMode === 'llm'
    ? slices.length
    : Math.min(rankedBlocks.length, HIT_K_POOL_CAP)
  if (test.hitMode !== 'llm') {
    for (let i = 0; i < rankPoolSize; i++) {
      const b = rankedBlocks[i]
      const hit = test.hitMode === 'slice' ? isReferenceSlice(b, ref) : textSliceHit(b?.A || '', answerText)
      if (hit) { hitRank = i + 1; break }
    }
  }

  // 本次检索耗时拆分：总耗时（墙钟）− 嵌入 − 对话模型 = 本地检索计算（策略自身成本）；
  // 嵌入 / 对话模型耗时由 retrievalServicesOf 的计时包装在调用现场累加（命中缓存的嵌入≈0）。
  const totalMs = performance.now() - startTime
  const timing: RetrievalTiming = {
    totalMs: Math.round(totalMs),
    embedMs: Math.round(bucket.embedMs),
    llmMs: Math.round(bucket.llmMs),
    localMs: Math.max(0, Math.round(totalMs - bucket.embedMs - bucket.llmMs)),
    embedHits: bucket.embedHits,
    embedMisses: bucket.embedMisses,
  }

  return { slices, avgScore, timeMs: timing.totalMs, timing, hitRank, rankPoolSize, agent, llmCalls: sr.meta.llmCalls || 0, toolCalls: agent?.steps.length || 0 }
}


// ==================== 大模型判定（仅智能路由类策略可用） ====================
// 由对话模型对比「检索到的片段」与问题 / 参考答案，判定是否命中以及最前命中位次。
// 用途：检索可能命中「同义但非同一切片」的内容（如改写过的答案），切片身份比对会漏判。
// 说明：判定发生在检索计时之外（不计入平均检索时间），但会累加进「模型调用 / 题」成本列。

/** 实际生效的判定模式：'llm' 仅对智能路由类策略有效，其它策略回退到 slice（有关联切片）或 text 口径 */
const effectiveHitMode = (algorithm: string, ref?: TestCaseRef): 'slice' | 'text' | 'llm' => {
  if (test.hitMode !== 'llm') return test.hitMode
  if (kindOf(algorithm) === 'agentic') return 'llm'
  return hasGoldRef(ref) ? 'slice' : 'text'
}

/** 该策略当前是否支持大模型判定 */
const llmJudgeAvailable = computed(() => kindOf(test.currentAlgorithm) === 'agentic')

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
    const { slices, avgScore, timeMs, timing, hitRank: poolHitRank, rankPoolSize, agent, llmCalls, toolCalls } = await performSearch(question, searchNum, algorithm, answer, ref)

    // 大模型判定（仅智能路由类策略）：在检索计时之外调用，避免判定耗时混入检索时间
    let llmJudge: TestResult['llmJudge']
    let judgeCalls = 0
    let hitRank = poolHitRank
    if (effectiveHitMode(algorithm, ref) === 'llm' && slices.length) {
      const j = await judgeByLlm(question, answer || '', slices)
      judgeCalls = 1
      llmJudge = j
      // 仅标记「最前命中位次」那一片（与切片命中口径一致：命中数=1），判定失败时不标记以避免误判为未命中
      if (!j.error) slices.forEach((s, i) => { s.llmHit = !!j.hit && i + 1 === j.rank })
      // Hit@K（大模型判定口径）：命中位次取模型给出的最前命中位次（只可能落在被呈现的 searchNum 条内）
      hitRank = (!j.error && j.hit) ? j.rank : 0
    }

    const result: TestResult = {
      question: question,
      answer: answer || '',
      algorithm: algorithm,
      slices: slices,
      avgScore: avgScore,
      recallTimeMs: timeMs,
      timing,
      hitRank,
      rankPoolSize,
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
  // 复用组件级 blocksByIdMap（computed 已缓存）：原来每题都重建一次 O(切片数) 的 Map，
  // 616 题 × 多策略时是白白的固定开销
  const blocksById = blocksByIdMap.value
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
    timing: result.timing,
    hitRank: result.hitRank || 0,
    rankPoolSize: result.rankPoolSize || 0,
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
  // 工具栏已不再显示进度/状态，预热进度同样上报到底部状态栏
  emit('updateLiveState', allTestProgressText.value)
  const times: Record<string, number> = {}
  const started = performance.now()
  const ingestServices = kbAi.buildIngestionServices(kbSpec())
  const embedFn = async (text: string) => ingestServices.embed(text)
  const embedBatchFn = async (texts: string[]) => ingestServices.embedBatch(texts)
  const streamChatFn = async (messages: any[], onChunk: (c: string) => void) =>
    ingestServices.streamChat(messages, onChunk)
  // 标记当前处理项；原语 onProgress 回调更新该项的 index/total/detail，并同步到底部状态栏
  const onItemProgress = (key: string) => (msg: string) => {
    const st = prewarmItemStates[key]
    if (!st) return
    const m = msg.match(/(\d+)\s*\/\s*(\d+)/)
    if (m) { st.index = +m[1]; st.total = +m[2] }
    st.detail = msg
    emit('updateLiveState', msg)
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
    // 预热结束：清掉底部状态栏的预热进度行（随后的批测循环会重新占用该行）
    emit('updateLiveState', '')
  }
}

// 按「被测策略对应的处理管线」做就绪处理：pipeline 含 file_score（文件通道）时，自动对文件自带摘要向量化
// （仅 embed、不调用 LLM 生成）。本体 / 社区 / 问题向量等较重管线由父级建库时实施，这里不做隐式生成模型调用。
let _fileWarmFailed = false
const ensureStrategyChannelsReady = async (algoIds?: string[]) => {
  // 仅当「本次要测试的策略」本身用到 file_score 才自动补齐文件摘要向量，
  // 避免单测相似度等纯切片策略也被其它启用策略（文件增强/本体/多跳）的文件依赖误触发。
  // algoIds 可能是消融变体 id → 用 defOf 解析（变体定义里同样带 steps / file_score）
  const defs = (algoIds && algoIds.length)
    ? algoIds.map(id => defOf(id)).filter(Boolean) as StrategyDef[]
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

// ===== 主线程让出（批量测试期间保持界面可刷新/可点击） =====
// 为什么必须显式让出：批量测试在「纯本地策略」（相似度/问题增强/文件增强/本体/混合等）下，
// 查询向量命中的是内存缓存 —— 一次检索里已经没有任何真实 I/O await（嵌入不再走网络、也没有对话调用），
// 整轮循环就变成了「一个接一个的微任务」，浏览器的渲染步骤永远排不上队：
// 表现就是进度不动、界面像卡死（其实还在算）。用 MessageChannel 做宏任务让出，
// 没有 setTimeout(0) 的 4ms 最小间隔，开销可忽略。
const _yieldChannel: MessageChannel | null = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null
const _yieldWaiters: Array<() => void> = []
if (_yieldChannel) {
  _yieldChannel.port1.onmessage = () => { _yieldWaiters.shift()?.() }
}
/** 让出主线程一帧：宏任务边界，浏览器得以重绘、处理点击（暂停/停止按钮因此才点得动） */
const yieldToUi = (): Promise<void> => new Promise<void>(resolve => {
  if (!_yieldChannel) { setTimeout(resolve, 0); return }
  _yieldWaiters.push(resolve)
  _yieldChannel.port2.postMessage(null)
})

/** 循环进度日志（每 25 题或每 10 秒一条，最后一条必打）：控制台能看到「在推进 / 卡在哪」 */
let _loopLogAt = 0
let _loopLogDone = -1
const logLoopProgress = (done: number, total: number, label: string) => {
  if (done !== total && done - _loopLogDone < 25 && Date.now() - _loopLogAt < 10000) return
  _loopLogAt = Date.now()
  _loopLogDone = done
  console.log(`[评测] 进度 ${done}/${total} · ${label}`)
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
  // 评测准备（都不计入检索计时）：1) 快照本体上下文与实体→切片索引（整轮复用，避免每题每策略重建）；
  // 2) 批量向量化本次全部问题（一次请求多条）→ 同一问题在后续每次检索都命中缓存，不再请求嵌入模型
  beginRunScope()
  await prewarmTestQueries()
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

  // 检索循环开始：进度/状态从这里起上报到底部状态栏（预热阶段的状态由预热流程自己上报，避免被顶掉）
  batchLoopActive.value = true
  // 先让出一帧：让「0% + 当前策略」先画出来，否则第一个问题的本地计算会直接顶住首帧
  await yieldToUi()
  for (let i = 0; i < test.questions.length; i++) {
    // 暂停/停止：在问题之间生效（已测结果保留）
    if (!(await waitWhilePaused())) break
    const question = test.questions[i]?.trim()
    const answer = test.answers && test.answers[i] ? test.answers[i].trim() : ''
    allTestProgressText.value = `${getAlgorithmLabel(test.currentAlgorithm)} ${i + 1}/${test.questions.length}`
    logLoopProgress(i, test.questions.length, getAlgorithmLabel(test.currentAlgorithm))
    
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
    // 每题让出一次主线程：纯本地策略整轮无真实 I/O await，不让出会让浏览器无法重绘（表现为卡死）
    await yieldToUi()
  }
  logLoopProgress(test.questions.length, test.questions.length, getAlgorithmLabel(test.currentAlgorithm))
  batchLoopActive.value = false
  allTestProgressText.value = ''
  endRunScope()
  
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
  /** 平均检索墙钟耗时（毫秒）：含本次实际发生的嵌入与对话模型调用。
   *  批量测试已批量向量化问题，故此处嵌入耗时≈0，是「热缓存」耗时；与配置相关的横向对比请用 onlineTimeMs */
  avgTimeMs: number
  /** 在线延迟（毫秒，中位数）：本地检索计算 + 冷启动单条嵌入延迟 + 对话模型耗时。
   *  即「一次真实用户提问（查询必须现嵌入一次）该策略要多久」——与是否命中问题向量缓存无关，跨批次可比 */
  onlineTimeMs: number
  /** 在线延迟 p90（毫秒）：尾延迟，看最慢那批问题的体验（均值/中位数之外的第三个数） */
  onlineP90Ms: number
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
  /** 耗时拆分（每题均值，毫秒）：本地检索计算 / 嵌入 / 对话模型（三者相加 = avgTimeMs） */
  avgLocalMs: number
  avgEmbedMs: number
  avgLlmMs: number
  /** 检索阶段嵌入缓存的命中率（0~1）：越接近 1 说明批量预嵌入/缓存覆盖越完整 */
  embedHitRate: number
  /** 命中率曲线：Hit@1..Hit@K（下标 k-1 = Hit@k，-1 = 该 K 无有效分母/无数据）。
   *  与 Hit@1 同源（关联切片身份 / 参考答案文本 / 大模型判定），但统计到「完整排名池」深度（默认跟随切片数量） */
  hitAtK: number[]
  /** 每个 K 的有效问题数（排名池深度 < K 的问题不计入该 K：如某策略只返回 5 条时 Hit@20 无意义） */
  hitKDenom: number[]
  /** Hit@K 的 K 上限（= hitAtK.length） */
  hitKMax: number
  /** 已完成重复轮数（>1 时各指标附标准差） */
  runs: number
  /** 重复运行的标准差（仅 runs>1 有意义；缺失表示未重复） */
  std?: Partial<Record<'recallRate' | 'avgHitRate' | 'hitAt1' | 'mrr' | 'completeRate' | 'avgFirstRank' | 'avgTimeMs' | 'onlineTimeMs' | 'avgLlmCalls' | 'avgToolCalls', number>>
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
  onlineTimeMs: number
  /** 本轮 Hit@1..Hit@K（重复运行时按 K 求均值±标准差，用于曲线误差带） */
  hitAtK?: number[]
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
/** 中位数（偶数个取中间两数均值）：耗时分布长尾（个别题触发模型换载/长回答），中位数比均值更稳健 */
const medianOf = (list: number[]): number => {
  if (!list.length) return 0
  const s = [...list].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
/** 分位数（线性插值）：p90 反映尾延迟（最慢那批问题的体验），用于提示均值是否被长尾拉高 */
const quantileOf = (list: number[], q: number): number => {
  if (!list.length) return 0
  const s = [...list].sort((a, b) => a - b)
  const pos = (s.length - 1) * q
  const lo = Math.floor(pos), hi = Math.ceil(pos)
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

/**
 * 某次检索的「在线延迟」（毫秒）：本地计算 + 对话模型 + 该次查询必付的单条嵌入延迟。
 * 批量测试已批量向量化问题，检索阶段对查询文本的嵌入基本命中缓存（测得的嵌入耗时≈0），若直接用墙钟
 * 时间会把「用户单次提问必须现嵌入一次查询」这一固定成本算没（同时也会让不同批次不可比）。口径：
 *  - 本次检索发生过嵌入缓存命中（embedHits>0）→ 说明查询向量是复用的，补上 coldEmbedMs 作为那次嵌入；
 *  - 未命中（如单题测试）→ 查询嵌入的时间已包含在墙钟里，直接采用。
 * 注意：命中缓存的实际耗时≈0，所以这里等价于「墙钟 + 一次单条嵌入」；智能路由等自行发起子查询嵌入的
 * 策略，其子查询嵌入是真实未命中（时间已含在墙钟内），不会被这一步重复计入。
 * 无冷启动测量值（恢复的旧快照、单条嵌入失败）时退化为墙钟时间。
 */
const onlineTimeOf = (r: { timeMs?: number; timing?: RetrievalTiming }): number => {
  const total = r.timeMs || 0
  if (!coldEmbedMs.value) return total
  return (r.timing?.embedHits || 0) > 0 ? total + coldEmbedMs.value : total
}

/**
 * 由「位次记录」算 Hit@K 曲线（K=1..kMax）：
 *  - 分子：hitRank 在 1..K 内的题数（hitRank=完整排名池里的最前命中位次；大模型判定=模型给出位次）；
 *  - 分母：排名池深度 ≥ K 的题数（某题/某策略只排了 5 条时，Hit@20 无意义，不计入该 K 的分母）；
 *  - 返回值 -1 表示该 K 没有有效分母（界面/导出显示 '-'，不要当成 0%）。
 */
const hitKCurve = (rows: Array<{ hitRank?: number; rankPoolSize?: number }>, kMax: number): { hitAtK: number[]; denom: number[] } => {
  const hitAtK: number[] = []
  const denom: number[] = []
  const K = Math.max(1, Math.min(HIT_K_POOL_CAP, Math.round(kMax) || 1))
  for (let k = 1; k <= K; k++) {
    let d = 0, n = 0
    for (const r of rows) {
      const pool = r.rankPoolSize || 0
      if (pool < k) continue
      d++
      const rank = r.hitRank || 0
      if (rank > 0 && rank <= k) n++
    }
    denom.push(d)
    hitAtK.push(d > 0 ? n / d : -1)
  }
  return { hitAtK, denom }
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
      onlineTimeMs: s.onlineTimeMs,
      onlineP90Ms: s.onlineP90Ms,
      hitAt1: g.hitAt1,
      mrr: g.mrr,
      completeRate: g.completeRate,
      groups: s.groups,
      avgLlmCalls: s.avgLlmCalls,
      avgToolCalls: s.avgToolCalls,
      avgFallbackCalls: s.avgFallbackCalls,
      toolDistribution: s.toolDistribution,
      avgLocalMs: s.avgLocalMs,
      avgEmbedMs: s.avgEmbedMs,
      avgLlmMs: s.avgLlmMs,
      embedHitRate: s.embedHitRate,
      hitAtK: s.hitAtK,
      hitKDenom: s.hitKDenom,
      hitKMax: s.hitKMax,
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

// 批量测试进行中的「当前项」文本（策略 + 问题序号 / 轮次），由运行循环每题更新
const allTestProgressText = ref('')

/**
 * 检索循环是否已真正开始（预热/就绪处理阶段为 false）。
 * 原因：批量测试的进度上报到底部状态栏，而预热阶段的状态栏消息由预热流程自己 emit，
 * 只用 test.isRunning 判断会让每秒刷新的进度把预热进度顶掉。
 */
const batchLoopActive = ref(false)

/**
 * 批量测试的底部状态栏文本（工具栏不再显示进度/状态，避免挤占按钮空间）：
 * 第一行 = 核心进度（百分比 + 暂停 + 当前策略/题号），第二行（换行后）= 时间信息，
 * 由父级状态栏按「正文 + detail」两段渲染（完整文本也在悬停 title 里）。
 */
const batchLiveText = computed(() => {
  if (!test.isRunning || !batchLoopActive.value) return ''
  const zh = store.locales == 'zh'
  const pct = `${(Number(test.progress) || 0).toFixed(0)}%`
  const head = [zh ? `批量测试 ${pct}` : `Batch ${pct}`, batchCtl.paused ? (zh ? '已暂停' : 'paused') : '', allTestProgressText.value]
    .filter(Boolean).join(' · ')
  const tail = [
    elapsedText.value ? (zh ? `已用 ${elapsedText.value}` : `elapsed ${elapsedText.value}`) : '',
    etaText.value ? (zh ? `剩 ${etaText.value}` : `eta ${etaText.value}`) : '',
  ].filter(Boolean).join(' · ')
  return tail ? `${head}\n${tail}` : head
})
// 运行进度实时上报底部状态栏（运行结束文本变空 → 清空该行）
watch(batchLiveText, (v) => emit('updateLiveState', v))

// 展开查看位次明细的策略 id（点击汇总行切换）
const expandedStrategy = ref('')
const expandedStrategyLabel = computed(() =>
  allStrategyStats.value.find(s => s.strategyId === expandedStrategy.value)?.label || expandedStrategy.value)
const strategyDetailRows = computed(() =>
  rankAnalysisResults.value.filter(r => r.algorithm === expandedStrategy.value))
/** 打开某策略/变体的位次明细弹出面板（点击策略召回对比行） */
const openStrategyDetail = (id: string) => { expandedStrategy.value = id }
/** 关闭位次明细弹出面板 */
const closeStrategyDetail = () => { expandedStrategy.value = '' }

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
    /** 耗时拆分累加（本地检索 / 嵌入 / 对话模型，毫秒） */
    sumLocalMs: number
    sumEmbedMs: number
    sumLlmMs: number
    /** 检索阶段嵌入缓存命中 / 未命中次数 */
    embedHits: number
    embedMisses: number
    /** 每题在线延迟（求中位数 / p90）：耗时分布长尾，中位数比均值更稳健 */
    onlineList: number[]
    /** Hit@K 用：逐题的「完整排名池最前命中位次」与池深度（随后统一按 K 统计） */
    hits: Array<{ hitRank: number; rankPoolSize: number }>
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
      sumLocalMs: 0, sumEmbedMs: 0, sumLlmMs: 0, embedHits: 0, embedMisses: 0,
      onlineList: [], hits: [],
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
    // 耗时拆分：有 timing 用实测拆分；恢复的旧数据（无 timing）退化为「全部算本地计算」
    const tt = r.timing
    cur.sumEmbedMs += tt?.embedMs || 0
    cur.sumLlmMs += tt?.llmMs || 0
    cur.sumLocalMs += tt ? tt.localMs : (r.timeMs || 0)
    cur.embedHits += tt?.embedHits || 0
    cur.embedMisses += tt?.embedMisses || 0
    // Hit@K：逐题记录「完整排名池里的最前命中位次 + 池深度」，随后统一按 K=1..hitKCap 统计
    cur.hits.push({ hitRank: r.hitRank || 0, rankPoolSize: r.rankPoolSize || 0 })
    // 在线延迟：把被缓存掉的嵌入耗时换回「冷启动单条嵌入延迟」（真实一次提问必须现嵌入一条查询）
    cur.onlineList.push(onlineTimeOf(r))
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
      onlineTimeMs: medianOf(a.onlineList),
      onlineP90Ms: quantileOf(a.onlineList, 0.9),
      hitAt1: a.testedCount > 0 ? a.hit1Count / a.testedCount : 0,
      mrr: a.testedCount > 0 ? a.sumMRR / a.testedCount : 0,
      completeRate: a.testedCount > 0 ? a.completeCount / a.testedCount : 0,
      groups: { single: st(a.single), complex: st(a.complex) },
      avgLlmCalls: a.testedCount > 0 ? a.sumLlmCalls / a.testedCount : 0,
      avgToolCalls: a.testedCount > 0 ? a.sumToolCalls / a.testedCount : 0,
      avgFallbackCalls: a.testedCount > 0 ? a.sumFallbackCalls / a.testedCount : 0,
      avgLocalMs: a.testedCount > 0 ? a.sumLocalMs / a.testedCount : 0,
      avgEmbedMs: a.testedCount > 0 ? a.sumEmbedMs / a.testedCount : 0,
      avgLlmMs: a.testedCount > 0 ? a.sumLlmMs / a.testedCount : 0,
      // 无 timing 数据（旧快照）时给 -1 → 界面显示 '-'，避免误读为「0% 命中」
      embedHitRate: (a.embedHits + a.embedMisses) > 0 ? a.embedHits / (a.embedHits + a.embedMisses) : -1,
      // Hit@K 曲线（Hit@1..Hit@K）：分子=池内最前命中位次 ≤ K 的题数，分母=排名池深度 ≥ K 的题数
      ...(() => {
        const curve = hitKCurve(a.hits, hitKCap.value)
        return { hitAtK: curve.hitAtK, hitKDenom: curve.denom, hitKMax: curve.hitAtK.length }
      })(),
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

// Hit@K 上限改变：位次是按「完整排名池」（最多 100 位）记录的，所以直接重算曲线即可，无需重跑测试
watch(() => test.hitKMax, () => {
  if (!test.isRunning && !restoringTestData && rankAnalysisResults.value.length) updateStrategyStats()
})

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
    // 与展示口径一致：在线延迟取该轮全部问题的中位数（对长尾更稳健）
    onlineTimeMs: medianOf(rows.map(r => onlineTimeOf(r))),
    // 本轮 Hit@K 曲线（重复运行时在 withRunStd 里按 K 求均值±标准差，供曲线画误差带）
    hitAtK: hitKCurve(rows.map(r => ({ hitRank: r.hitRank, rankPoolSize: r.rankPoolSize })), hitKCap.value).hitAtK,
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
  // Hit@K：多轮时按 K 求各轮均值（曲线用均值；某轮缺该 K 的取值则不参与该 K 的平均）
  const hitKMean = ((): number[] => {
    const base = s.hitAtK || []
    if (runs.length < 2) return base
    const K = Math.max(base.length, ...runs.map(r => r.hitAtK?.length || 0))
    const out: number[] = []
    for (let k = 0; k < K; k++) {
      const vals = runs.map(r => r.hitAtK?.[k]).filter((v): v is number => typeof v === 'number' && v >= 0)
      out.push(vals.length ? meanOf(vals) : (base[k] ?? -1))
    }
    return out
  })()
  if (runs.length < 2) return { ...s, runs: runs.length || 1, hitAtK: hitKMean }
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
  // 旧快照（本次改动前保存的 .kb）没有 onlineTimeMs：退回该轮的平均墙钟，避免出现 NaN
  const online = pick(r => r.onlineTimeMs || r.avgTimeMs || 0)
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
    onlineTimeMs: online.mean,
    hitAtK: hitKMean,
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
      onlineTimeMs: online.std,
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

/**
 * 「在线延迟」单元格悬停说明：把耗时拆成「策略自身成本 / 嵌入 / 对话模型」三段，并给出热缓存下的实测墙钟，
 * 让「批量向量化省掉了多少、策略本身多贵、模型多贵」一眼可辨（而不是一个含义模糊的总毫秒数）。
 */
const timeBreakdownTitle = (s: any): string => {
  const zh = store.locales == 'zh'
  const ms = (n: number) => `${Math.round(n || 0)} ms`
  const hit = s.embedHitRate >= 0 ? `${(s.embedHitRate * 100).toFixed(1)}%` : '-'
  const cold = coldEmbedMs.value > 0 ? ms(coldEmbedMs.value) : (zh ? '未测量' : 'not measured')
  const batch = embedRunStats.questions > 0
    ? (zh
        ? `批量预嵌入：${embedRunStats.questions} 题 / ${embedRunStats.requests} 次请求，摊销 ${embedRunStats.amortizedMs.toFixed(1)} ms/题`
        : `Batch pre-embed: ${embedRunStats.questions} q / ${embedRunStats.requests} req, ${embedRunStats.amortizedMs.toFixed(1)} ms/q amortized`)
    : (zh ? '本次未做批量预嵌入（问题数 < 2 或已全部命中缓存）' : 'no batch pre-embed this run')
  return zh
    ? `在线延迟（每题中位数）：${ms(s.onlineTimeMs)}（p90 ${ms(s.onlineP90Ms)}）\n`
      + `定义：一次真实用户提问（查询必须现嵌入一次）在该策略下的检索延迟 = 实测检索墙钟 + 单条查询嵌入 ${cold}\n`
      + `（批量向量化把「查询嵌入」移到了评测准备阶段，所以墙钟里不含它；这里补回来，跨批次/开关缓存都可比）\n`
      + `三段均值参考：本地检索计算 ${ms(s.avgLocalMs)}｜对话模型 ${ms(s.avgLlmMs)}｜本次实测嵌入 ${ms(s.avgEmbedMs)}\n`
      + `热缓存实测墙钟（均值）：${ms(s.avgTimeMs)}；检索阶段嵌入缓存命中率 ${hit}\n${batch}`
    : `Online latency (per-question median): ${ms(s.onlineTimeMs)} (p90 ${ms(s.onlineP90Ms)})\n`
      + `Definition: retrieval latency for one real user query (the query must be embedded once) = measured wall clock + one query embed ${cold}\n`
      + `(batch pre-embedding moved the query embed into the preparation phase, so the wall clock excludes it; adding it back keeps runs comparable)\n`
      + `Component means: local retrieval ${ms(s.avgLocalMs)} | chat model ${ms(s.avgLlmMs)} | measured embed ${ms(s.avgEmbedMs)}\n`
      + `Measured wall clock under hot cache (mean): ${ms(s.avgTimeMs)}; retrieval-phase embed cache hit rate ${hit}\n${batch}`
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
      hitKMax: Math.max(0, parseInt(String(test.hitKMax)) || 0),
      // 消融实验配置（策略参数变体）：随 .kb 一起保存，重新加载后变体标签/统计仍可解析（复现实验）
      ablation: JSON.parse(JSON.stringify(ablation.runs)),
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
  if (st.hitKMax !== undefined) test.hitKMax = Math.max(0, Math.min(HIT_K_POOL_CAP, Number(st.hitKMax) || 0))
  // 消融配置：恢复后变体标签/统计分组才能解析（老快照无该字段则保留当前面板配置）
  if (Array.isArray(st.ablation)) ablation.runs = st.ablation.filter((r: any) => r?.id && r?.strategyId)
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
  // 评测准备（都不计入检索计时）：快照本体/实体索引 + 批量向量化全部问题。
  // 批量预嵌入在「全部策略」测试里收益最大：同一问题原本会被 策略数 × 重复轮数 次重复嵌入。
  beginRunScope()
  await prewarmTestQueries()
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

  // 执行清单：有启用的消融变体 → 逐变体跑（同一策略的不同参数各占一行）；否则退回「每个启用策略跑一次」。
  // 与策略配置面板里的「将执行」预览同源（batchRunPreview），避免预览与实际执行不一致。
  const runList: Array<{ id: string; label: string; searchNum?: number }> =
    batchRunPreview.value.map(p => ({ id: p.id, label: p.label, searchNum: p.searchNum }))

  // 全部启用策略（含消融变体）对应管线就绪（当前自动覆盖：文件自带摘要向量化；本体/社区/Q 由父级建库管线提供）
  await ensureStrategyChannelsReady(runList.map(r => r.id))

  // 已配置预热且未执行 → 先预热（时间单独计时，不计入检索时间）
  if (!prewarmDone.value && (prewarm.summary || prewarm.summaryVec || prewarm.sliceVec || prewarm.questionVec || prewarm.entity || prewarm.community)) {
    await runPrewarm()
  }

  const searchNum = parseInt(test.searchNum.toString())
  const rows = test.questions.map((q, i) => ({ question: q?.trim(), answer: test.answers?.[i]?.trim() || '' }))
  // 重复次数：同一批问题重复跑 N 轮（各轮独立汇总，用于均值±标准差；默认 1=不重复）
  const repeat = Math.max(1, Math.min(5, parseInt(String(test.repeat)) || 1))
  const totalRuns = runList.length * rows.length * repeat
  let done = 0

  // 新一次「全部策略」测试：自动清空上一次结果/位次/统计，只保留本次
  clearJudgementResults()
  strategyRuns.value = {}

  let abortedRuns = false
  // 检索循环开始：进度/状态从这里起上报到底部状态栏（前面的预热阶段由预热流程自己上报状态）
  batchLoopActive.value = true
  // 先让出一帧：让首帧状态（0% + 将执行的清单）先画出来
  await yieldToUi()
  for (let rep = 0; rep < repeat && !abortedRuns; rep++) {
    for (const algo of runList) {
      // 变体可自带切片数 K（消融「K 值」用）；留空则跟随面板的切片数量
      const algoSearchNum = algo.searchNum ? Math.max(1, Math.min(100, parseInt(String(algo.searchNum)) || searchNum)) : searchNum
      for (let i = 0; i < rows.length; i++) {
        // 暂停/停止：在问题之间生效（已测结果与统计保留）
        if (!(await waitWhilePaused())) { abortedRuns = true; break }
        const { question, answer } = rows[i]
        allTestProgressText.value = `${algo.label} ${i + 1}/${rows.length}${repeat > 1 ? ` (${rep + 1}/${repeat})` : ''}`
        logLoopProgress(done, totalRuns, `${algo.label} · ${i + 1}/${rows.length}`)
        if (!question || isJunkQuestion(question)) { done++; await yieldToUi(); continue }
        let slices: TestResult['slices'] = []
        try {
          test.questionStatus[i] = {
            text: store.locales=='zh' ? `测试中 [${algo.label}]...` : `Testing [${algo.label}]...`,
            color: '#FF9800', icon: 'fa fa-spinner fa-spin', algorithm: algo.id
          }
          slices = await performTestChat(question, algoSearchNum, algo.id, i, answer, test.refs?.[i]) || []
        } catch (error) {
          console.error(`策略 ${algo.id} 问题 ${i + 1} 测试失败:`, error)
        }
        // 累积该策略×问题的切片明细（只存 id/元数据，正文按 id 回源；直接引用返回数组，不再深拷贝）
        allStrategySliceResults.value.push({
          strategyId: algo.id,
          label: algo.label,
          question,
          answer,
          avgScore: slices.length > 0 ? slices.reduce((s, x) => s + (x.score || 0), 0) / slices.length : 0,
          timestamp: new Date().toISOString(),
          slices
        })
        done++
        test.progress = Math.round((done / totalRuns) * 100)
        // 每题让出一次主线程：纯本地策略整轮无真实 I/O await，不让出会让浏览器无法重绘（表现为卡死）
        await yieldToUi()
      }
      // 本轮该策略已跑完全部问题：汇总本轮指标（重复运行时用于均值±标准差）
      snapshotStrategyRun(algo.id)
      // 每测完一个策略，立即刷新「策略召回对比」，让该策略数据实时可见
      updateStrategyStats()
      // 每跑完一个策略即刷新 .kb 快照（中途保存也能拿到已完成部分）
      emitTestData()
      activeTab.value = 'batch'
      if (abortedRuns) break
    }
  }
  logLoopProgress(totalRuns, totalRuns, store.locales == 'zh' ? '全部策略完成' : 'all strategies done')
  batchLoopActive.value = false
  endRunScope()

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
    ? `全部策略测试完成：共 ${allStrategyStats.value.length} 个策略/变体${repeat > 1 ? `（每项 ${repeat} 轮，指标为均值±标准差）` : ''}，最优「${best?.label}」召回 ${best ? (best.recallRate*100).toFixed(1) : 0}%`
    : `All strategies/variants tested: ${allStrategyStats.value.length} rows${repeat > 1 ? ` (${repeat} runs each, mean±std)` : ''}, best "${best?.label}" recall ${best ? (best.recallRate*100).toFixed(1) : 0}%`)
}

/**
 * Hit@K 曲线表（宽格式，行=K、列=每个策略/变体）：上半部是 Hit@K(%)，下半部是各 K 的有效题数分母。
 * 直接插入 Excel 折线图即可得到 Hit@K 曲线；长表（策略,K,Hit@K）可用「转置」或逐列选取。
 */
const hitKSheetRows = (): any[][] => {
  const stats = allStrategyStats.value
  const K = stats.reduce((m, s) => Math.max(m, s.hitKMax || s.hitAtK?.length || 0), 0)
  if (!stats.length || K <= 0) return [['Hit@K', store.locales == 'zh' ? '暂无数据' : 'no data']]
  const header = ['K', ...stats.map(s => s.label)]
  const pct: any[][] = [header]
  const long: any[][] = [['策略', '策略ID', 'K', 'Hit@K(%)', '有效题数']]
  for (let k = 1; k <= K; k++) {
    pct.push([k, ...stats.map(s => {
      const v = s.hitAtK?.[k - 1]
      return (typeof v === 'number' && v >= 0) ? +(v * 100).toFixed(1) : '-'
    })])
    for (const s of stats) {
      const v = s.hitAtK?.[k - 1]
      long.push([s.label, s.strategyId, k, (typeof v === 'number' && v >= 0) ? +(v * 100).toFixed(1) : '-', s.hitKDenom?.[k - 1] ?? '-'])
    }
  }
  return [
    [store.locales == 'zh' ? 'Hit@K(%)：行=K（位次截断），列=策略/变体' : 'Hit@K(%) rows = K, columns = strategy/variant'],
    ...pct,
    [],
    [store.locales == 'zh' ? '有效题数（排名池深度 ≥ K 的题数；深度不足的题不计入该 K）' : 'Valid question count (rank pool depth >= K)'],
    ...pct.map((row, i) => i === 0
      ? ['K', ...stats.map(s => s.label)]
      : [row[0], ...stats.map(s => s.hitKDenom?.[Number(row[0]) - 1] ?? '-')]),
    [],
    [store.locales == 'zh' ? '长表（便于用 pandas/ggplot 画图）' : 'Long format (for pandas/ggplot)'],
    ...long,
  ]
}

// ==================== Hit@K（仅统计数据与导出，不在界面画图） ====================
// 曲线不再在面板里可视化：导出 Excel 的「Hit@K曲线」工作表同时含
// 宽表（行=K、列=策略）与长表（策略,K,Hit@K,有效题数），可直接用 Excel/pandas 自行画图。
// K 上限由工具栏的「K」输入控制（0=跟随切片数量），统计口径见 hitKCurve()。

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
      ['策略', '策略ID', '分组', '重复轮数', '测试问题数', '命中问题数', '召回率', '答案命中率', 'Hit@1', 'MRR', '完整率', '平均位次', '在线延迟(ms,中位数)', '在线延迟p90(ms)', '热缓存耗时(ms,均值)', '本地计算(ms)', '嵌入(ms)', '对话模型(ms)', '嵌入缓存命中率', '模型调用/题', '工具调用/题', '工具分布']
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
          // 耗时口径：在线延迟（中位，含单条冷嵌入）= 与真实单次提问可比；热缓存耗时=本次批量实测墙钟
          s.onlineTimeMs > 0 ? Math.round(s.onlineTimeMs) : '-',
          s.onlineP90Ms > 0 ? Math.round(s.onlineP90Ms) : '-',
          s.avgTimeMs > 0 ? Math.round(s.avgTimeMs) : '-',
          Math.round(s.avgLocalMs || 0),
          Math.round(s.avgEmbedMs || 0),
          Math.round(s.avgLlmMs || 0),
          s.embedHitRate >= 0 ? (s.embedHitRate * 100).toFixed(1) + '%' : '-',
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
      ['策略', '策略ID', '问题', '参考答案', '是否命中', '答案命中率', '最优位次', '池内位次(Hit@K用)', '排名池深度', '命中切片数', '召回时间(ms)', '策略参数']
    ]
    const sorted = [...rankAnalysisResults.value].sort((a, b) =>
      a.algorithm.localeCompare(b.algorithm) || a.question.localeCompare(b.question))
    for (const r of sorted) {
      detail.push([
        labelOf(r.algorithm),
        r.algorithm,
        r.question,
        r.answer,
        r.foundCount > 0 ? '是' : '否',
        ((r.hitRate || 0) * 100).toFixed(1) + '%',
        r.firstRank > 0 ? r.firstRank : '-',
        r.hitRank ? r.hitRank : (r.hitRank === 0 ? '未命中' : '-'),
        r.rankPoolSize ?? '-',
        r.foundCount,
        r.timeMs ? Math.round(r.timeMs) : '-',
        variantParamSummary(r.algorithm)
      ])
    }

    const ws1 = XLSX.utils.aoa_to_sheet(summary)
    ws1['!cols'] = [{ wch: 18 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 32 }]
    const ws2 = XLSX.utils.aoa_to_sheet(detail)
    ws2['!cols'] = [{ wch: 16 }, { wch: 14 }, { wch: 40 }, { wch: 30 }, { wch: 10 }, { wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 12 }]
    const ws3 = XLSX.utils.aoa_to_sheet(significance)
    ws3['!cols'] = [{ wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 10 }, { wch: 20 }, { wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }]
    const ws4 = XLSX.utils.aoa_to_sheet(hitKSheetRows())

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws1, '策略召回对比')
    XLSX.utils.book_append_sheet(wb, ws2, '明细')
    XLSX.utils.book_append_sheet(wb, ws3, '配对显著性')
    XLSX.utils.book_append_sheet(wb, ws4, 'Hit@K曲线')

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
      ['策略', '策略ID', '分组', '测试问题数', '命中问题数', '召回率', '答案命中率', 'Hit@1', 'MRR', '完整率', '平均位次', '在线延迟(ms,中位数)', '在线延迟p90(ms)', '热缓存耗时(ms,均值)', '本地计算(ms)', '嵌入(ms)', '对话模型(ms)', '嵌入缓存命中率', '模型调用/题', '工具调用/题', '工具分布']
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
          s.onlineTimeMs > 0 ? Math.round(s.onlineTimeMs) : '-',
          s.onlineP90Ms > 0 ? Math.round(s.onlineP90Ms) : '-',
          s.avgTimeMs > 0 ? Math.round(s.avgTimeMs) : '-',
          Math.round(s.avgLocalMs || 0),
          Math.round(s.avgEmbedMs || 0),
          Math.round(s.avgLlmMs || 0),
          s.embedHitRate >= 0 ? (s.embedHitRate * 100).toFixed(1) + '%' : '-',
          s.avgLlmCalls > 0 ? s.avgLlmCalls.toFixed(2) : '-',
          s.avgToolCalls > 0 ? s.avgToolCalls.toFixed(2) : '-',
          s.avgToolCalls > 0 ? toolDistText(s.toolDistribution) : '-'
        ])
      }
    }

    // 表2：位次明细
    const detail: any[][] = [
      ['策略', '策略ID', '问题', '参考答案', '是否命中', '答案命中率', '最优位次', '命中切片数', '召回时间(ms)', '在线延迟(ms)', '本地计算(ms)', '嵌入(ms)', '对话模型(ms)', '池内位次(Hit@K用)', '排名池深度', '模型调用', '工具调用', '判定方式', '大模型判定理由']
    ]
    const sorted = [...rankAnalysisResults.value].sort((a, b) =>
      a.algorithm.localeCompare(b.algorithm) || a.question.localeCompare(b.question))
    for (const r of sorted) {
      detail.push([
        labelOf(r.algorithm),
        r.algorithm,
        r.question,
        r.answer,
        r.foundCount > 0 ? '是' : '否',
        ((r.hitRate || 0) * 100).toFixed(1) + '%',
        r.firstRank > 0 ? r.firstRank : '-',
        r.foundCount,
        r.timeMs ? Math.round(r.timeMs) : '-',
        Math.round(onlineTimeOf(r)),
        r.timing ? Math.round(r.timing.localMs) : '-',
        r.timing ? Math.round(r.timing.embedMs) : '-',
        r.timing ? Math.round(r.timing.llmMs) : '-',
        r.hitRank ? r.hitRank : (r.hitRank === 0 ? '未命中' : '-'),
        r.rankPoolSize ?? '-',
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
    const ws5 = XLSX.utils.aoa_to_sheet(hitKSheetRows())

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws1, '策略召回对比')
    XLSX.utils.book_append_sheet(wb, ws2, '位次明细')
    XLSX.utils.book_append_sheet(wb, ws3, '切片明细')
    XLSX.utils.book_append_sheet(wb, ws4, '配对显著性')
    XLSX.utils.book_append_sheet(wb, ws5, 'Hit@K曲线')

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

// 获取算法标签（消融变体优先：变体标签里带覆盖参数摘要，图表与导出可直接用）
const getAlgorithmLabel = (algo: SearchAlgorithm) => labelOf(algo)

// 该策略是否启用 问题增强(Q) / 文件摘要 通道（仅启用对应通道的策略才展示「通道缺失·切片分兜底」标记，
// 避免 similarity 等纯切片策略也把 dense 的 hasQ=false 误标为「无关联问题」）
const channelFlagsOf = (algo: string): { qOn: boolean; fOn: boolean } => {
  const def = defOf(algo)
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
  // 消融实验配置：先读本地保存的（.kb 里若带配置，下面的 restoreTestData 会覆盖）
  loadAblationLocal()
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
             :title="store.locales=='zh'
               ? (ablationEnabledVariants.length
                 ? `批量测试所有配置：${ablationEnabledVariants.length} 个消融组（策略/变体）各跑一遍全部问题，统计召回率与 Hit@K`
                 : '批量测试所有策略：每个策略跑一遍全部问题，统计召回准确率（如需参数消融，先在批量面板配置消融组）')
               : (ablationEnabledVariants.length
                 ? `Test all configured groups: ${ablationEnabledVariants.length} ablation group(s) over all questions`
                 : 'Test all strategies: run all questions for every strategy')">
          <i class="fa fa-play"></i>
        </div>
        <!-- 重复次数（仅「全部策略」批量生效）：同批问题重复 N 轮，各指标以均值±标准差呈现 -->
        <input v-model="test.repeat" type="number" min="1" max="5" class="kt-input" style="width:42px;"
               :disabled="test.isRunning"
               :title="store.locales=='zh' ? '重复次数（仅「批量测试所有策略」生效）：同一批问题重复跑 N 轮，指标以均值±标准差呈现，用于判断策略差异是否稳定（默认 1）' : 'Repeat count (all-strategy test only): run the same questions N times and report mean ± std (default 1)'"/>
        <!-- Hit@K 统计的 K 上限（仅影响导出的「Hit@K曲线」工作表；界面上不画曲线，导出后用 Excel 自行处理） -->
        <input v-model="test.hitKMax" type="number" min="0" :max="HIT_K_POOL_CAP" class="kt-input" style="width:42px;"
               :disabled="test.isRunning"
               :title="store.locales=='zh'
                 ? `Hit@K 统计的 K 上限（导出 Excel 的「Hit@K曲线」工作表用）：0=跟随切片数量（当前 ${test.searchNum}）；填 1~${HIT_K_POOL_CAP} 可统计更深的召回位次（需重新跑批量测试才有对应数据；改数值后已有的位次数据可直接重算）`
                 : `K cap for the exported Hit@K sheet: 0 = follow the slice count (now ${test.searchNum}); 1..${HIT_K_POOL_CAP} for deeper ranks (re-run to collect deeper data)`" />
        <!-- 清空批量测试结果 -->
        <div class="kt-btn" @click="clearAllResults" :disabled="test.isRunning || prewarmRunning"
             :title="store.locales=='zh' ? '清空批量测试结果 / 位次 / 统计（释放内存）' : 'Clear batch results / stats (free memory)'">
          <i class="fa fa-eraser"></i>
        </div>
        <!-- 策略配置（消融实验）：组列表 / 参数 / 将执行清单都在弹出面板里 -->
        <div class="kt-btn" :class="{ on: configPanelOpen }" @click="openConfigPanel()"
             :title="store.locales=='zh'
               ? `策略配置（消融实验）：配置 ${ablation.runs.length} 组（启用 ${ablationEnabledVariants.length} 组）、设置各组策略参数，并预览「批量测试所有策略」将执行哪些策略/组`
               : `Strategy config (ablation): ${ablation.runs.length} group(s), ${ablationEnabledVariants.length} enabled; tune params and preview what the batch run will test`">
          <i class="fa fa-flask"></i>
        </div>
        <!-- 配对显著性检验（同一批问题、与基线配对做 McNemar / Wilcoxon）：内容较宽，放入弹出面板 -->
        <div class="kt-btn" :class="{ on: sigPanelOpen }"
             :style="{ opacity: allStrategyStats.length ? 1 : .45 }"
             @click="allStrategyStats.length && (sigPanelOpen = true)"
             :title="store.locales=='zh'
               ? '配对显著性检验：同一批问题下与基线配对，命中差异用 McNemar 精确检验、位次差异用 Wilcoxon 符号秩检验（需先跑测试）'
               : 'Paired significance: McNemar (hits) + Wilcoxon signed-rank (ranks) vs the baseline (run a test first)'">
          <i class="fa fa-balance-scale"></i>
        </div>
        <!-- 预热入口（仅当有可勾选项时显示）：摘要生成 / 各类向量缓存都在浮层里操作 -->
        <div v-if="availablePrewarmItems.length > 0" class="kt-btn"
             :class="{ on: prewarmPanelOpen, warn: prewarmRunning }"
             @click="prewarmPanelOpen = !prewarmPanelOpen"
             :title="store.locales=='zh' ? '预热 / 向量缓存：生成缺失摘要、补齐各类向量（已有数据自动跳过，耗时不计入检索）' : 'Pre-warm / vector caches: generate missing summaries, fill missing vectors (existing data is skipped)'">
          <i class="fa" :class="prewarmRunning ? 'fa-spinner fa-spin' : 'fa-fire'"></i>
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
      
      <!-- 已测/总题数（仅空闲时显示；运行中的进度/耗时/当前策略与题号都在下方状态栏，见 batchLiveText） -->
      <span v-if="!test.isRunning" class="kt-label" style="margin-left:auto;font-size:12px;"
            :title="store.locales=='zh' ? '已测问题数 / 问题总数（运行中的进度与预计剩余见底部状态栏）' : 'Tested / total questions (live progress shows in the status bar)'">
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
        <!-- ===== 策略配置（消融实验）：全部在工具栏「烧瓶」按钮打开的弹出面板里（此处不占内容区） ===== -->

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
                <th style="text-align:center;"
                    :title="store.locales=='zh'
                      ? '在线延迟/题（中位数，括号内为轮间标准差）：一次真实用户提问（查询必须现嵌入一次）在该策略下的检索延迟 = 实测检索墙钟 + 单条查询嵌入延迟。批量向量化把「查询嵌入」移到了评测准备阶段，这里补回来，故与是否命中问题向量缓存无关、跨批次可比。悬停单元格看三段拆分（本地计算/嵌入/对话模型）、p90 尾延迟与嵌入缓存命中率'
                      : 'Online latency per question (median ± std across rounds) = local retrieval + one cold query embed + chat-model time — what a single real user query costs; independent of the question-vector cache. Hover a cell for the breakdown'">
                  {{ store.locales=='zh' ? '在线延迟/题' : 'Online/Qs' }}
                </th>
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
                  @click="openStrategyDetail(s.strategyId)"
                  :title="store.locales=='zh' ? '点击查看位次明细（弹出面板）' : 'Click to view rank detail (panel)'">
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
                <!-- 在线延迟（中位数）：含单条冷嵌入，跨批次可比；悬停看 本地/嵌入/模型 拆分与热缓存实测耗时 -->
                <td style="text-align:center;"
                    :title="timeBreakdownTitle(s)">
                  {{ s.onlineTimeMs > 0 ? fmtStat(s.onlineTimeMs, s.std?.onlineTimeMs, 1, 0) + ' ms' : '-' }}
                </td>
                <td style="text-align:center;"
                    :title="store.locales=='zh' ? (s.avgLlmCalls > 0 ? `平均每题 ${s.avgLlmCalls.toFixed(2)} 次对话模型调用` : '本题集未产生对话模型调用') : `avg ${s.avgLlmCalls.toFixed(2)} LLM calls per question`">
                  {{ s.avgLlmCalls > 0 ? fmtStat(s.avgLlmCalls, s.std?.avgLlmCalls, 1, 2) : '-' }}
                </td>
                <td style="text-align:center;"
                    :title="s.avgToolCalls > 0 || (s.avgFallbackCalls || 0) > 0 ? toolDistText(s.toolDistribution, s.avgFallbackCalls || 0) : (store.locales=='zh' ? '该策略不使用检索工具' : 'no retrieval tools')">
                  <!-- 模型自己调用的工具次数/题；为 0 但发生过系统补检索时显示 0*（括号内为补检索次数/题） -->
                  {{ s.avgToolCalls > 0
                    ? fmtStat(s.avgToolCalls, s.std?.avgToolCalls, 1, 2)
                    : ((s.avgFallbackCalls || 0) > 0 ? `0* (${(s.avgFallbackCalls || 0).toFixed(2)})` : '-') }}
                </td>
              </tr>
            </tbody>
          </table>
          <!-- 列说明：工具/题 与 模型调用/题 的读法（Agentic 成本与「模型是否真在用工具」一眼可辨） -->
          <div v-if="allStrategyStats.length" class="ae-note" style="margin:4px 0 0;">
            {{ store.locales=='zh'
              ? '「模型调用/题」= 平均对话模型调用次数（Agentic 含工具轮与作答；本体增强的 LLM 兜底实体链接也会计入）；「工具/题」= 模型自己发起检索工具的次数，0* 表示模型全程未调工具、仅由系统按可用通道补检索（括号内为补检索次数/题，悬停可见工具分布与提示）'
              : '"LLM/Qs" = avg chat-model calls per question (agentic tool rounds + answer; ontology LLM entity-link fallback counts too); "Tools/Qs" = tool calls the model itself issued — 0* means the model never called a tool and only the deterministic fallback ran (the number in brackets is fallback calls per question; hover for the tool mix)' }}
          </div>

          <!-- Hit@K 曲线：不在界面里画图（导出 Excel 的「Hit@K曲线」工作表里自带宽表 + 长表，方便自行画图/统计） -->
          <!-- 配对显著性检验已移到弹出面板（工具栏「天平」按钮打开），此处不再内联展示 -->
          <!-- 位次明细：点击策略行 → 弹出面板查看（见下方 tm-dlg-rank） -->
        </div>
      </div>
    </div>

    <!-- ===== 位次明细面板（弹出层）：点击策略召回对比里的某一行打开 =====
         z-index 950：低于「智能路由检索过程」弹层（tm-overlay = 1000），
         这样在明细里点「检索过程」时，过程面板能正常盖在它之上 -->
    <div v-if="expandedStrategy" class="tm-dlg-overlay tm-dlg-rank" @mousedown.self="closeStrategyDetail">
      <div class="tm-dlg tm-rank-modal">
        <div class="tm-dlg-head">
          <i class="fa fa-list"></i>
          <span class="tm-dlg-title">{{ store.locales=='zh' ? '位次明细' : 'Rank detail' }}</span>
          <span class="ae-note ellipsis" style="max-width:380px;" :title="expandedStrategyLabel">{{ expandedStrategyLabel }}</span>
          <span class="ae-note">({{ strategyDetailRows.length }} {{ store.locales=='zh' ? '条' : 'rows' }})</span>
          <span style="flex:1"></span>
          <div class="kt-btn" :title="store.locales=='zh' ? '关闭' : 'Close'" @click="closeStrategyDetail"><i class="fa fa-times"></i></div>
        </div>

        <div class="tm-dlg-body scoll">
          <table class="as-table as-detail-table">
            <thead>
              <tr>
                <th style="width:28px;">#</th>
                <th>{{ store.locales=='zh' ? '问题' : 'Question' }}</th>
                <th style="text-align:center;">{{ store.locales=='zh' ? '完整性' : 'Completeness' }}</th>
                <th style="text-align:center;">{{ store.locales=='zh' ? '答案命中率' : 'HitRate' }}</th>
                <th style="text-align:center;">{{ store.locales=='zh' ? '最优位次' : 'Best Rank' }}</th>
                <th style="text-align:center;"
                    :title="store.locales=='zh' ? '在线延迟（本地计算 + 单条冷嵌入 + 对话模型）｜悬停看该题的三段拆分与热缓存实测耗时' : 'Online latency (local + one cold embed + LLM); hover for the per-question breakdown'">
                  {{ store.locales=='zh' ? '在线延迟' : 'Online' }}
                </th>
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
                <td style="text-align:center;"
                    :title="store.locales=='zh'
                      ? `在线延迟 ${Math.round(onlineTimeOf(r))} ms = 实测墙钟 ${formatTime(r.timeMs)}${r.timing && r.timing.embedHits > 0 && coldEmbedMs > 0 ? ` + 单条查询嵌入 ${Math.round(coldEmbedMs)}（本次命中缓存，未计入墙钟）` : ''}\n本地计算 ${r.timing ? Math.round(r.timing.localMs) : '-'} / 嵌入（实测）${r.timing ? Math.round(r.timing.embedMs) : '-'} / 对话模型 ${r.timing ? Math.round(r.timing.llmMs) : '-'} ms；嵌入缓存命中 ${r.timing?.embedHits ?? 0} 次`
                      : `Online ${Math.round(onlineTimeOf(r))} ms = wall clock ${formatTime(r.timeMs)}${r.timing && r.timing.embedHits > 0 && coldEmbedMs > 0 ? ` + one cached query embed ${Math.round(coldEmbedMs)}` : ''}\nlocal ${r.timing ? Math.round(r.timing.localMs) : '-'} / embed ${r.timing ? Math.round(r.timing.embedMs) : '-'} / LLM ${r.timing ? Math.round(r.timing.llmMs) : '-'} ms; embed cache hits ${r.timing?.embedHits ?? 0}`">
                  {{ formatTime(onlineTimeOf(r)) }}
                </td>
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
              <tr v-if="!strategyDetailRows.length">
                <td colspan="7" style="text-align:center;color:var(--borderColor);padding:16px;">
                  {{ store.locales=='zh' ? '该策略暂无位次记录' : 'No rank rows for this strategy' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="tm-dlg-foot">
          <span class="ae-note">{{ store.locales=='zh' ? '「在线延迟」= 本地计算 + 单条查询嵌入 + 对话模型；悬停单元格看拆分' : 'Online = local + one query embed + LLM; hover a cell for the breakdown' }}</span>
          <span style="flex:1"></span>
          <div class="kt-btn ok" @click="closeStrategyDetail"><i class="fa fa-check"></i><span class="pw-run-label">{{ store.locales=='zh' ? '关闭' : 'Close' }}</span></div>
        </div>
      </div>
    </div>

    <!-- ===== 配对显著性检验面板（弹出层）：与基线配对做 McNemar / Wilcoxon ===== -->
    <div v-if="sigPanelOpen" class="tm-dlg-overlay" @mousedown.self="sigPanelOpen = false">
      <div class="tm-dlg tm-sig-modal">
        <div class="tm-dlg-head">
          <i class="fa fa-balance-scale"></i>
          <span class="tm-dlg-title">{{ store.locales=='zh' ? '配对显著性检验' : 'Paired significance' }}</span>
          <span class="ae-note">{{ store.locales=='zh' ? `共 ${pairedComparisons.length} 个对比策略` : `${pairedComparisons.length} comparison(s)` }}</span>
          <span style="flex:1"></span>
          <div class="kt-btn" :title="store.locales=='zh' ? '关闭' : 'Close'" @click="sigPanelOpen = false"><i class="fa fa-times"></i></div>
        </div>

        <div class="tm-dlg-body scoll">
        <div class="tm-abl-base">
          <label class="tm-abl-field" :title="store.locales=='zh' ? '选择配对基线：其余策略/变体都与它做同题配对检验' : 'Baseline for paired tests'">
            <span>{{ store.locales=='zh' ? '基线' : 'Baseline' }}</span>
            <select v-model="sigBaseline" class="kt-select" style="width:auto;max-width:200px;">
              <option v-for="s in allStrategyStats" :key="s.strategyId" :value="s.strategyId">{{ s.label }}</option>
            </select>
          </label>
        </div>

        <div class="ae-note" style="line-height:1.5;">
          {{ store.locales=='zh'
            ? '同一批问题、同一判定基准下与基线配对：命中差异用 McNemar 精确检验（b=基线命中/对比未命中，c=反之），位次差异用 Wilcoxon 符号秩检验（未命中记 K+1）；p<0.05 视为显著'
            : 'Paired on the same questions vs the baseline: McNemar exact test for hit differences (b = baseline hit & other miss, c = vice versa), Wilcoxon signed-rank for ranks (miss = K+1); p<0.05 = significant' }}
        </div>

          <div v-if="!pairedComparisons.length" class="as-empty">
            <i class="fa fa-info-circle"></i>
            {{ store.locales=='zh' ? '暂无可配对数据（需至少两个策略/变体各有判定记录）' : 'No paired data yet (need two strategies/variants with judgements)' }}
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

        <div class="tm-dlg-foot">
          <span class="ae-note">{{ store.locales=='zh' ? '想补充对比项？在「策略配置」里增加消融组后重跑批量测试即可' : 'Add ablation groups in Strategy config and re-run to extend the comparison' }}</span>
          <span style="flex:1"></span>
          <div class="kt-btn ok" @click="sigPanelOpen = false"><i class="fa fa-check"></i><span class="pw-run-label">{{ store.locales=='zh' ? '关闭' : 'Close' }}</span></div>
        </div>
      </div>
    </div>

    <!-- ===== 策略配置面板（弹出层）：左侧策略组导航 + 右侧详细配置；底部为操作与检索次数 ===== -->
    <div v-if="configPanelOpen" class="tm-dlg-overlay" @mousedown.self="closeConfigPanel">
      <div class="tm-dlg tm-abl-modal">
        <div class="tm-dlg-head">
          <i class="fa fa-flask"></i>
          <span class="tm-dlg-title">{{ store.locales=='zh' ? '策略配置（消融实验）' : 'Strategy config (ablation)' }}</span>
          <span class="ae-note">
            {{ store.locales=='zh'
              ? `${ablation.runs.length} 组 · 启用 ${ablationEnabledVariants.length} 组`
              : `${ablation.runs.length} group(s) · ${ablationEnabledVariants.length} enabled` }}
          </span>
          <span style="flex:1"></span>
          <div class="kt-btn" :title="store.locales=='zh' ? '关闭' : 'Close'" @click="closeConfigPanel"><i class="fa fa-times"></i></div>
        </div>

        <div class="tm-dlg-body">
        <!-- 左右布局：左侧=已配置/启用的策略组导航，右侧=选中组的详细配置 -->
        <div class="tm-abl-split">
          <!-- 左：导航（组管理按钮 + 组列表；勾选框即该组是否参与批量测试） -->
          <div class="tm-abl-nav">
            <div class="tm-abl-nav-acts">
              <div class="kt-btn" @click="addAblationRun()" :title="store.locales=='zh' ? '新增一组（默认选第一个启用策略）' : 'Add a group'"><i class="fa fa-plus"></i></div>
              <div class="kt-btn" @click="addDefaultAblationSet()" :title="store.locales=='zh' ? '按启用策略铺开：为每个启用策略各建一组（默认参数=基线）' : 'One group per enabled strategy (baselines)'"><i class="fa fa-th-list"></i></div>
              <div class="kt-btn" @click="setAblationEnabled(true)" :title="store.locales=='zh' ? '全启用' : 'Enable all'"><i class="fa fa-check-square-o"></i></div>
              <div class="kt-btn" @click="setAblationEnabled(false)" :title="store.locales=='zh' ? '全停用（回到「每个启用策略跑一次」）' : 'Disable all'"><i class="fa fa-square-o"></i></div>
              <div class="kt-btn" @click="clearAblationRuns()" :title="store.locales=='zh' ? '清空所有组（只清配置，不动已有测试结果）' : 'Clear all groups (config only)'"><i class="fa fa-trash-o"></i></div>
            </div>
            <div class="tm-abl-nav-list scoll">
              <div v-for="run in ablation.runs" :key="run.id" class="tm-abl-nav-item"
                   :class="{ on: run.id === ablationEditRunId, off: !run.enabled }"
                   :title="ablationAutoLabel(run)" @click="ablationEditRunId = run.id">
                <input type="checkbox" v-model="run.enabled" @click.stop
                       :title="store.locales=='zh' ? '该组是否参与批量测试' : 'Include in the batch run'" />
                <div class="tm-abl-nav-txt">
                  <div class="nm">{{ ablationBaseLabel(run) }}</div>
                  <div class="sub" v-if="ablationOverrideCount(run)">{{ ablationOverrideText(run) }}</div>
                  <div class="sub none" v-else>{{ store.locales=='zh' ? '默认参数（基线）' : 'defaults (baseline)' }}</div>
                </div>
                <span v-if="run.searchNum" class="tm-abl-nav-k">K{{ run.searchNum }}</span>
              </div>
              <div v-if="!ablation.runs.length" class="ae-note" style="line-height:1.5;padding:4px;">
                {{ store.locales=='zh'
                  ? '暂无消融组。点上方「铺开」（每个启用策略一组）或「+」新增一组；不配置时批量测试按每个启用策略的默认参数各跑一次。'
                  : 'No groups yet. Use the buttons above; with none configured every enabled strategy runs once with defaults.' }}
              </div>
              <!-- 未配置的启用策略：点一下即为它新增一组（默认参数=基线），左栏因此始终能看到「启用了哪些策略」 -->
              <template v-if="ablationStrategiesWithoutGroup.length">
                <div class="tm-abl-nav-sec">{{ store.locales=='zh' ? '未配置的启用策略（点击新增一组）' : 'enabled strategies without a group (click to add)' }}</div>
                <div v-for="opt in ablationStrategiesWithoutGroup" :key="'ng-' + opt.value" class="tm-abl-nav-item add"
                     :title="store.locales=='zh' ? `为「${opt.label}」新增一组消融配置（默认参数）` : `Add a group for ${opt.label} (defaults)`"
                     @click="addAblationRunFor(opt.value)">
                  <i class="fa fa-plus"></i>
                  <div class="tm-abl-nav-txt">
                    <div class="nm">{{ opt.label }}</div>
                    <div class="sub none">{{ store.locales=='zh' ? '默认参数' : 'defaults' }}</div>
                  </div>
                </div>
              </template>
            </div>
          </div>

          <!-- 右：选中组的详细配置 -->
          <div class="tm-abl-detail scoll">
        <!-- 选中组的参数（无选中时提示从左侧列表点击） -->
        <div v-if="ablationEditRun" class="tm-abl-edit">
          <div class="tm-abl-base">
            <label class="tm-abl-field">
              <span>{{ store.locales=='zh' ? '策略' : 'Strategy' }}</span>
              <select v-model="ablationEditRun.strategyId" class="kt-select" style="width:150px;">
                <option v-for="opt in algorithmOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
              </select>
            </label>
            <label class="tm-abl-field">
              <span>{{ store.locales=='zh' ? '标签' : 'Label' }}</span>
              <input v-model="ablationEditRun.label" class="kt-input" style="width:190px;"
                     :placeholder="ablationAutoLabel(ablationEditRun)"
                     :title="store.locales=='zh' ? '留空则用自动标签（策略名 + 覆盖参数摘要），图表图例直接用它' : 'Empty = auto label from overridden params'" />
            </label>
            <label class="tm-abl-field" :title="store.locales=='zh' ? '该组的切片数 K（留空=跟随工具栏「切片数量」）；也是该组 Hit@K 曲线的上限' : 'Top-K for this group (empty = follow toolbar)'">
              <span>{{ store.locales=='zh' ? '切片数 K' : 'Top-K' }}</span>
              <input :value="ablationEditRun.searchNum" @input="setAblationSearchNum(ablationEditRun, ($event.target as HTMLInputElement).value)"
                     type="number" min="1" max="100" class="kt-input" style="width:60px;" placeholder="—" />
            </label>
            <label class="tm-abl-field" :title="store.locales=='zh' ? '该组是否参与「批量测试所有策略」' : 'Include in the batch run'">
              <span>{{ store.locales=='zh' ? '启用' : 'Enabled' }}</span>
              <input type="checkbox" v-model="ablationEditRun.enabled" />
            </label>
          </div>

        <!-- 参数覆盖：留空/未勾选 = 跟随策略默认值（占位符显示默认值） -->
        <div class="tm-abl-params-wrap">
          <div class="tm-abl-params">
            <!-- 实体链接 LLM 兜底：影响本体/多跳/智能路由的实体匹配（关闭可显著提速） -->
            <label v-if="ablationHasPrimitive(ablationEditRun, 'entity_link') || ablationAgentic(ablationEditRun) || ablationHasPrimitive(ablationEditRun, 'graph_hop')"
                   class="tm-abl-field" :title="store.locales=='zh' ? '实体链接的 LLM 兜底匹配（关闭后只用嵌入模型做实体匹配，评测更快、更稳定）' : 'LLM fallback for entity linking'">
              <span>{{ store.locales=='zh' ? '实体LLM兜底' : 'entLLM' }}</span>
              <input type="checkbox" :checked="ablationConfigOn(ablationEditRun, 'entityLinkLlm')"
                     @change="setAblationConfigBool(ablationEditRun, 'entityLinkLlm', ($event.target as HTMLInputElement).checked)" />
            </label>
            <!-- 步骤参数（按策略定义自动列出该策略真正用到的原语参数） -->
            <span v-for="st in ablationStepsOf(ablationEditRun)" v-show="st.fields.length" :key="st.key"
                  class="tm-abl-field tm-abl-step" :title="st.primitive">
              <span class="tm-abl-prim">{{ st.primitive }}</span>
              <template v-for="f in st.fields" :key="st.key + '.' + f.key">
                <span class="tm-abl-sub">{{ store.locales=='zh' ? f.label : f.labelEn }}</span>
                <select v-if="f.type === 'select'" class="kt-select"
                        :value="ablationStepParamVal(ablationEditRun, st.key, f.key) ?? f.current"
                        @change="setAblationStepParam(ablationEditRun, st.key, f.key, ($event.target as HTMLSelectElement).value)">
                  <option v-for="o in f.options" :key="o.value" :value="o.value">{{ store.locales=='zh' ? o.label : (o.labelEn || o.label) }}</option>
                </select>
                <input v-else-if="f.type === 'checkbox'" type="checkbox"
                       :checked="ablationStepParamVal(ablationEditRun, st.key, f.key) ?? !!f.current"
                       @change="setAblationStepParam(ablationEditRun, st.key, f.key, ($event.target as HTMLInputElement).checked)" />
                <input v-else type="number" class="kt-input" :min="f.min" :max="f.max" :step="f.step"
                       :value="ablationStepParamVal(ablationEditRun, st.key, f.key)" :placeholder="String(st.base[f.key] ?? f.current ?? '')"
                       :title="store.locales=='zh' ? (f.tip || `默认 ${st.base[f.key] ?? f.current ?? '-'}（留空=用默认）`) : (f.tipEn || `default ${st.base[f.key] ?? f.current ?? '-'}`)"
                       @input="setAblationStepParam(ablationEditRun, st.key, f.key, ($event.target as HTMLInputElement).value)" />
              </template>
            </span>
            <!-- 智能路由策略级参数 -->
            <template v-if="ablationAgentic(ablationEditRun)">
              <label class="tm-abl-field" :title="store.locales=='zh' ? '最大工具轮次上限（默认 5）' : 'Max tool rounds'">
                <span>{{ store.locales=='zh' ? '最大轮次' : 'rounds' }}</span>
                <input type="number" min="1" max="10" step="1" class="kt-input"
                       :value="ablationPatchVal(ablationEditRun, 'maxRounds')" placeholder="5"
                       @input="setAblationPatchVal(ablationEditRun, 'maxRounds', ($event.target as HTMLInputElement).value === '' ? '' : Number(($event.target as HTMLInputElement).value))" />
              </label>
              <label class="tm-abl-field" :title="store.locales=='zh' ? '工具内部候选切片数（默认跟随设置）' : 'Tool candidate pool size'">
                <span>{{ store.locales=='zh' ? '工具候选' : 'toolTopN' }}</span>
                <input type="number" min="1" max="100" step="1" class="kt-input"
                       :value="ablationPatchVal(ablationEditRun, 'agentToolTopN')" :placeholder="ablationConfigDefault('agentToolTopN')"
                       @input="setAblationPatchVal(ablationEditRun, 'agentToolTopN', ($event.target as HTMLInputElement).value === '' ? '' : Number(($event.target as HTMLInputElement).value))" />
              </label>
              <label class="tm-abl-field" :title="store.locales=='zh' ? '最终重排里子查询分的权重（0=只用原始问题）' : 'Sub-query re-rank weight'">
                <span>{{ store.locales=='zh' ? '子查询权重' : 'subQ' }}</span>
                <input type="number" min="0" max="1" step="0.05" class="kt-input"
                       :value="ablationPatchVal(ablationEditRun, 'agentSubQueryWeight')" :placeholder="ablationConfigDefault('agentSubQueryWeight')"
                       @input="setAblationPatchVal(ablationEditRun, 'agentSubQueryWeight', ($event.target as HTMLInputElement).value === '' ? '' : Number(($event.target as HTMLInputElement).value))" />
              </label>
              <label class="tm-abl-field" :title="store.locales=='zh' ? '模型未调用工具时，系统是否按可用通道补一次确定性召回（关掉=纯 LLM 路由消融）' : 'Deterministic fallback recall'">
                <span>{{ store.locales=='zh' ? '系统补检索' : 'fallback' }}</span>
                <input type="checkbox" :checked="ablationPatchVal(ablationEditRun, 'agentFallback') === '' ? true : !!ablationPatchVal(ablationEditRun, 'agentFallback')"
                       @change="setAblationPatchVal(ablationEditRun, 'agentFallback', ($event.target as HTMLInputElement).checked)" />
              </label>
              <label v-for="tool in AGENT_TOOL_KEYS" :key="'tool-' + ablationEditRun.id + tool.key"
                     class="tm-abl-field tm-abl-tool" :title="store.locales=='zh' ? tool.desc : tool.descEn">
                <input type="checkbox" :checked="ablationToolOn(ablationEditRun, tool.key)"
                       @change="setAblationTool(ablationEditRun, tool.key, ($event.target as HTMLInputElement).checked)" />
                <span>{{ tool.key }}</span>
              </label>
            </template>
            <!-- 混合策略通道开关与候选上限 -->
            <template v-if="ablationHybrid(ablationEditRun)">
              <label v-for="ch in CHANNEL_KEYS" :key="'ch-' + ablationEditRun.id + ch.key"
                     class="tm-abl-field tm-abl-tool" :title="store.locales=='zh' ? ch.desc : ch.descEn">
                <input type="checkbox" :checked="ablationChannelOn(ablationEditRun, ch.key)"
                       @change="setAblationChannel(ablationEditRun, ch.key, ($event.target as HTMLInputElement).checked)" />
                <span>{{ ch.key }}</span>
              </label>
              <label v-for="ch in CHANNEL_KEYS" :key="'chn-' + ablationEditRun.id + ch.key" class="tm-abl-field"
                     :title="store.locales=='zh' ? `${ch.key} 通道候选切片上限（留空=策略默认）` : `${ch.key} candidate cap`">
                <span>{{ ch.key }}·topN</span>
                <input type="number" min="1" max="50" step="1" class="kt-input"
                       :value="ablationChannelTopN(ablationEditRun, ch.key)" placeholder="—"
                       @input="setAblationChannelTopN(ablationEditRun, ch.key, ($event.target as HTMLInputElement).value)" />
              </label>
              <label class="tm-abl-field" :title="store.locales=='zh' ? '统一排序口径：cosine=余弦重排 / rrf=排名融合' : 'Unified rerank metric'">
                <span>{{ store.locales=='zh' ? '排序口径' : 'rerank' }}</span>
                <select class="kt-select" :value="(ablationEditRun.defPatch as any)?.rerank?.metric ?? ''"
                        @change="setAblationRerank(ablationEditRun, 'metric', ($event.target as HTMLSelectElement).value)">
                  <option value="">{{ store.locales=='zh' ? '默认' : 'default' }}</option>
                  <option value="cosine">cosine</option>
                  <option value="rrf">rrf</option>
                </select>
              </label>
              <label class="tm-abl-field" :title="store.locales=='zh' ? '融合后保留的候选上限' : 'rerank topK'">
                <span>topK</span>
                <input type="number" min="1" max="100" step="1" class="kt-input"
                       :value="(ablationEditRun.defPatch as any)?.rerank?.topK" placeholder="10"
                       @input="setAblationRerank(ablationEditRun, 'topK', ($event.target as HTMLInputElement).value)" />
              </label>
            </template>
            <span v-if="ablationOverrideCount(ablationEditRun) === 0" class="ae-note">
              {{ store.locales=='zh' ? '当前 = 策略默认参数（该组将作为基线行）' : 'Currently strategy defaults (baseline row)' }}
            </span>
          </div>
          <div class="ae-note" style="margin-top:6px;">
            {{ store.locales=='zh'
              ? '留空 / 不勾选 = 跟随策略默认值（占位符就是默认值）；自动标签与实际参数同步变化，修改后无需手动改标签。'
              : 'Empty / unchecked = follow the strategy default (placeholder shows it); the auto label follows the params.' }}
          </div>
        </div>
          </div>
          <div v-else class="ae-note" style="padding:10px 0;">
            <!-- 未选中任何组：提示从左侧导航选择 -->
            {{ store.locales=='zh' ? '从左侧选择一个策略组，即可在这里设置它的参数。' : 'Pick a group on the left to edit its params here.' }}
          </div>
          </div>
        </div>
        </div>

        <!-- 操作：复制 / 重置 / 删除该组；右侧「检索次数」+ 完成（次数即批量测试将执行的检索总数） -->
        <div class="tm-dlg-foot">
          <template v-if="ablationEditRun">
            <div class="kt-btn" :title="store.locales=='zh' ? '复制该组（新 id，便于只改一个参数做对照）' : 'Duplicate group'"
                 @click="duplicateAblationRun(ablationEditRun)"><i class="fa fa-copy"></i><span class="pw-run-label">{{ store.locales=='zh' ? '复制该组' : 'Copy' }}</span></div>
            <div class="kt-btn" :title="store.locales=='zh' ? '清空该组所有参数覆盖（保留策略/标签/启用）' : 'Reset overrides'"
                 @click="resetAblationRun(ablationEditRun)"><i class="fa fa-undo"></i><span class="pw-run-label">{{ store.locales=='zh' ? '重置参数' : 'Reset' }}</span></div>
            <div class="kt-btn" :title="store.locales=='zh' ? '删除该组' : 'Delete group'"
                 @click="removeAblationRun(ablationEditRun.id)"><i class="fa fa-trash-o"></i><span class="pw-run-label">{{ store.locales=='zh' ? '删除该组' : 'Delete' }}</span></div>
          </template>
          <span style="flex:1"></span>
          <span class="ae-note" :title="store.locales=='zh'
                  ? `批量测试所有策略将执行 ${batchRunPreview.length} 项（策略/消融组）× ${test.questions.length} 题 × ${Math.max(1, Math.min(5, parseInt(String(test.repeat)) || 1))} 轮`
                  : `${batchRunPreview.length} item(s) × ${test.questions.length} questions × ${Math.max(1, Math.min(5, parseInt(String(test.repeat)) || 1))} round(s)`">
            {{ store.locales=='zh'
              ? `共 ${batchRunPreview.length * test.questions.length * Math.max(1, Math.min(5, parseInt(String(test.repeat)) || 1))} 次检索`
              : `${batchRunPreview.length * test.questions.length * Math.max(1, Math.min(5, parseInt(String(test.repeat)) || 1))} retrievals` }}
          </span>
          <div class="kt-btn ok" @click="closeConfigPanel"><i class="fa fa-check"></i><span class="pw-run-label">{{ store.locales=='zh' ? '完成' : 'Done' }}</span></div>
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
        <div class="tm-body scoll">
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
            <div class="tm-step-result scoll">{{ st.result || '—' }}</div>
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
        <div class="tm-body scoll">
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
.tm-modal.pw-modal { width: min(720px, calc(94vw / var(--ui-zoom, 1))); height: auto; max-height: calc(88vh / var(--ui-zoom, 1)); overflow: hidden; }
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
.kt-btn { position: relative; }
.kt-disabled { opacity: .5; pointer-events: none; }

/* ===== 策略配置面板 / 消融组列表（弹层内：固定列宽 + 输入框不再溢出单元格） ===== */
.tm-abl-table { table-layout: fixed; }
.tm-abl-table tbody tr { cursor: pointer; }
.tm-abl-table td { vertical-align: middle; }
/* 关键：kt-input/kt-select 是 content-box，width:100% 时会因 padding+border 溢出单元格 → 统一 border-box */
.tm-abl-table input, .tm-abl-table select { box-sizing: border-box; max-width: 100%; }
.tm-abl-table .kt-select { min-width: 0; }
.tm-abl-table input[type="number"], .tm-abl-table input[type="text"] { height: 22px; }
.tm-abl-table input[type="checkbox"] { vertical-align: middle; margin: 0 2px; }
/* 选中行（下方参数区正在编辑该组） */
.tm-abl-table tbody tr.tm-abl-sel { background: color-mix(in srgb, var(--fontActiveColor) 12%, transparent); }
.tm-abl-ovr { font-size: 10px; color: var(--fontActiveColor); word-break: break-word; }
.tm-abl-ovr.none { color: var(--borderColor); }
.tm-abl-edit { border-top: 1px solid var(--borderColor); padding-top: 6px; flex: none; }
.tm-abl-params-wrap { padding: 2px 0; }
.tm-abl-base { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; }
.tm-abl-params { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; }
.tm-abl-field { display: inline-flex; align-items: center; gap: 3px; font-size: 10px; white-space: nowrap; }
.tm-abl-field > span { opacity: .72; }
.tm-abl-field .kt-input { width: 46px; height: 20px; padding: 0 3px; font-size: 10px; }
.tm-abl-field .kt-select { height: 20px; min-width: 0; padding: 0 2px; }
.tm-abl-step { border-left: 2px solid var(--fontActiveColor); padding-left: 4px; }
.tm-abl-prim { color: var(--fontActiveColor); font-size: 9px; }
.tm-abl-sub { opacity: .6; }
.tm-abl-tool { background: color-mix(in srgb, var(--fontColor) 4%, transparent); border-radius: 3px; padding: 0 3px; }
.tm-abl-btn {
  width: 20px; height: 18px; margin-right: 2px; cursor: pointer; font-size: 10px;
  background: none; border: 1px solid var(--borderColor); border-radius: 3px; color: inherit;
}
.tm-abl-btn:hover { border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
/* ===== 弹出面板通用样式（对齐 questionView 的 qb-pick-overlay / qb-pick-dialog） ===== */
.tm-dlg-overlay {
  position: fixed; inset: 0; z-index: 1200;
  background: rgba(0, 0, 0, .35);
  display: flex; align-items: center; justify-content: center;
}
.tm-dlg {
  display: flex; flex-direction: column;
  width: min(850px, calc(92vw / var(--ui-zoom, 1)));
  max-height: min(720px, calc(90vh / var(--ui-zoom, 1)));
  background: var(--backgroundColor);
  border: 1px solid var(--borderColor); border-radius: 8px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, .3); overflow: hidden;
}
.tm-dlg-head {
  display: flex; align-items: center; gap: 6px; padding: 6px 8px;
  border-bottom: 1px solid var(--borderColor); font-size: 12px; flex-shrink: 0;
}
.tm-dlg-head > i { color: #42A5F5; }
.tm-dlg-title { font-weight: 600; color: var(--fontColor); }
.tm-dlg-body {
  display: flex; flex-direction: column; gap: 6px;
  padding: 8px; overflow: hidden; min-height: 0; flex: 1;
}
.tm-dlg-body.scoll { overflow: auto; }
.tm-dlg-foot {
  display: flex; align-items: center; justify-content: flex-end; gap: 6px;
  padding: 6px 8px; border-top: 1px solid var(--borderColor); flex-shrink: 0;
}
.tm-dlg-foot .kt-btn { padding: 0 12px; }
/* 策略配置：左右布局（左=策略组导航，右=详细配置）；宽度比通用面板略宽 */
.tm-dlg.tm-abl-modal { width: min(920px, calc(94vw / var(--ui-zoom, 1))); }
.tm-dlg.tm-sig-modal { width: min(880px, calc(92vw / var(--ui-zoom, 1))); }
/* 位次明细：与其它面板同风格；层级低于 tm-overlay(1000)，让「检索过程」弹层能盖在它之上 */
.tm-dlg.tm-rank-modal { width: min(900px, calc(94vw / var(--ui-zoom, 1))); }
.tm-dlg-overlay.tm-dlg-rank { z-index: 950; }
.tm-abl-split { flex: 1 1 0%; min-height: 300px; display: flex; gap: 8px; min-width: 0; }
.tm-abl-nav {
  width: 266px; flex: none; display: flex; flex-direction: column; gap: 4px;
  border-right: 1px solid var(--borderColor); padding-right: 8px; min-height: 0;
}
.tm-abl-nav-acts { display: flex; gap: 4px; flex: none; }
.tm-abl-nav-list { flex: 1 1 0%; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 3px; }
.tm-abl-nav-item {
  display: flex; align-items: center; gap: 5px; padding: 3px 5px; cursor: pointer;
  border: 1px solid transparent; border-radius: 5px;
}
.tm-abl-nav-item:hover { background: color-mix(in srgb, var(--fontColor) 6%, transparent); }
.tm-abl-nav-item.on { border-color: var(--fontActiveColor); background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent); }
.tm-abl-nav-item.off { opacity: .5; }
.tm-abl-nav-txt { min-width: 0; flex: 1; }
.tm-abl-nav-item .nm { font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tm-abl-nav-item .sub { font-size: 9px; color: var(--fontActiveColor); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tm-abl-nav-item .sub.none { color: var(--borderColor); }
.tm-abl-nav-item.add { opacity: .72; border-style: dashed; border-color: var(--borderColor); }
.tm-abl-nav-item.add > i { font-size: 9px; color: var(--borderColor); }
.tm-abl-nav-sec { font-size: 9px; color: var(--borderColor); margin: 6px 0 2px; }
.tm-abl-nav-k {
  flex: none; font-size: 9px; padding: 0 4px; border-radius: 8px;
  border: 1px solid var(--borderColor); color: var(--borderColor);
}
.tm-abl-detail { flex: 1; min-width: 0; overflow: auto; }

/* 批量测试「将执行」预览（策略配置面板 + 面板内联摘要共用） */
.tm-run-preview { display: flex; flex-wrap: wrap; gap: 3px 5px; padding: 2px 0 4px; }
.tm-run-chip {
  display: inline-flex; align-items: center; gap: 3px; max-width: 260px;
  padding: 1px 6px; border: 1px solid var(--borderColor); border-radius: 9px;
  font-size: 10px; color: var(--fontColor); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.tm-run-chip > i { opacity: .65; font-size: 9px; }
/* 消融组（非默认策略）用高亮色，一眼区分「基线策略」与「参数变体」 */
.tm-run-chip.variant { border-color: var(--fontActiveColor); color: var(--fontActiveColor); }

/* ===== 切片 / 关联切片查看模态框 ===== */
.tm-overlay {
  position: fixed; inset: 0; z-index: 1000;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, .45); padding: 30px;
}
.tm-modal {
  display: flex; flex-direction: column; gap: 8px;
  width: min(860px, calc(92vw / var(--ui-zoom, 1))); height: min(calc(80vh / var(--ui-zoom, 1)), 760px);
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
.tm-entry-body { max-height: calc(46vh / var(--ui-zoom, 1)); overflow: auto; margin-top: 4px; padding: 6px; border: 1px dashed var(--borderColor); border-radius: 4px; }

/* ===== 智能路由（Agentic）检索过程：行内按钮 + 轨迹模态框 ===== */
.tm-trace-btn {
  font-size: 10px; color: #42A5F5; cursor: pointer;
  display: inline-flex; align-items: center; gap: 3px; white-space: nowrap;
}
.tm-trace-btn:hover { text-decoration: underline; }
.tm-trace-modal { width: min(760px, calc(92vw / var(--ui-zoom, 1))); height: min(calc(80vh / var(--ui-zoom, 1)), 720px); }
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