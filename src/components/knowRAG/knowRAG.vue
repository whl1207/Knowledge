<!-- /knowRAG.vue -->
<script setup lang="ts">
defineOptions({ name: 'Knowledge' })
import {onMounted,onBeforeUnmount,onActivated,onDeactivated,ref, nextTick,computed, watch, reactive} from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import * as kbAi from '@/shared/kbAiClient'
import type { KbModelSpec, KbProvider } from '@/shared/kbAiClient'
import block_md from '@/components/block_md.vue'
import testManager from '@/components/knowRAG/testManager.vue'
import configManager from '@/components/knowRAG/configManager.vue'

import OntologyViewer from '@/components/knowRAG/OntologyViewer.vue'
import questionView from '@/components/knowRAG/questionView.vue'
import sliceView from '@/components/knowRAG/sliceView.vue'
import fileView from '@/components/knowRAG/fileView.vue'
import cardView from '@/components/knowRAG/cardView.vue'

// 问题库（Question Bank）数据层与纯逻辑工具
import {
  splitQuestionText,
  parseQuestionAnswerPairs,
  answerText,
  computeBlockQuestionVectors,
} from '@/shared/kbQuestions'
import type { KbQuestion, QuestionAnswerRef } from '@/shared/kbQuestions'

import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'

// PDF 文本提取所需（参考 PdfViewer.vue），全局只需设置一次 worker 路径
GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs'

// GraphRAG 风格工具
import {
  buildExtractionSystemPrompt,
  buildEntityDescriptionPrompt,
  buildCommunityReportPrompt,
  detectCommunitiesFromOntology,
  computeBM25Score,
  runStrategy,
  getStrategies,
  getEnabledStrategies,
  setUserStrategies,
} from '@/shared/graphrag'
import { summarizeFile, INGESTION_PRIMITIVES, PRIMITIVE_META, clearEntityVectorCache } from '@/shared/graphrag/primitives'
import type { ExtractedEntity, ExtractedRelation, CommunityReport, RetrievalContext, IngestionContext } from '@/shared/graphrag'
import type { CommunityResult } from '@/shared/graphrag/community'
import { collectCommunityContext } from '@/shared/graphrag/community'

// KB 文件级通用工具（文件类型判定/规范化/格式化/Markdown 预处理），父壳与视图子组件共享
import { isPdfFile, isWordFile, isImageFile, isMediaFile, stripFrontmatter, mdPathOf, hasCorrespondingMd, isKbSidecarFile } from '@/lib/kbFile'
// 检索基础：余弦相似度等（单一实现，父壳与 headless/子组件共享）
import { cosineSimilarity } from '@/shared/kbRetrieval'

const ontologyData = ref<{
  nodes: any[],
  edges: any[]
}>({
  nodes: [],
  edges: []
})

// 本体节点坐标缓存：更新时保留已有节点位置，避免整图重置闪烁
const ontologyNodePosCache = new Map<string, { x: number; y: number }>()

// 本体视图全部节点总数（实体 + 切片 + 文件 + 元信息，由 OntologyViewer 上报）
const ontologyTotalNodes = ref(0)

// 社区检测结果数据
const communityResult = ref<CommunityResult | null>(null)
// 社区报告列表（LLM 生成）
const communityReports = ref<CommunityReport[]>([])

// 测试用例（测试页自动生成/编辑，随 .kb 保存与加载）
// refs[i] = 第 i 条问题的「关联切片」（由问题库 answerBlocks/srcBlockId 派生）：
// 测试页据此按「切片身份」判定检索是否召回了正确切片，而非拿 LLM 推理答案文本做子串匹配。
interface TestCaseRef { srcBlockId?: string; blockIds: string[] }
// source: 'bank'=测试用例由问题库派生（自动跟随）；'external'=外部 Excel 导入的独立测试集（仅评测，不写入问题库/知识库）
const testCases = ref<{ questions: string[], answers: string[], refs?: TestCaseRef[], source?: 'bank' | 'external' }>({ questions: [], answers: [], refs: [], source: 'bank' })
const onTestCasesChange = (data: { questions: string[], answers: string[], refs?: TestCaseRef[], source?: 'bank' | 'external' }) => {
    testCases.value = {
        questions: data.questions || [],
        answers: data.answers || [],
        refs: data.refs || [],
        // 未显式变更来源时沿用当前来源（对「外部导入集」的手动编辑仍保持 external，不被自动派生误覆盖）
        source: data.source ?? testCases.value?.source ?? 'bank',
    }
}

let idCounters = {
    block: 0,
    entity: 0,
    relation: 0
}

// 生成简短ID
const shortId = (type: 'block' | 'entity' | 'relation'): string => {
    idCounters[type]++
    const prefix = type === 'block' ? 'b' : (type === 'entity' ? 'e' : 'r')
    return `${prefix}${idCounters[type]}`
}

// 重置ID计数器（构建本体前调用）
const resetIdCounters = () => {
    idCounters = { block: 0, entity: 0, relation: 0 }
}

const handleNodeClick = (node:any) => {
  console.log('点击节点:', node)
}

import { Matrix,SingularValueDecomposition } from 'ml-matrix'
import {usestore} from '@/store'
const store=usestore()

let files = ref([]) as any
const selectedFileIndex = ref(-1) as any
let documents = ref([{name:'全部'}]) as any
let documentName = ref("全部") as any
let blocks = ref([]) as any
let viewMode = ref('qa')
let prompt = ref("")
let result = ref(store.locales=="zh"
    ? `### 👋 欢迎使用知识库问答

提问前请先准备好知识库，有以下几种方式：

- **📂 打开文件夹**：点击右上角「选择知识库文件夹」按钮，选择存放 Markdown 文档的文件夹
- **⚡ 自动知识库**：默认使用当前文件夹数据，提问时若尚未切片/向量化，系统将自动处理
- **💾 选择 .kb 文件**：在右上角知识库下拉框中选择一个已保存的知识库版本

也可以先到「切片」标签页手动切片/向量化，再回来提问。`
    : `### 👋 Welcome to Knowledge Base QA

Prepare a knowledge base before asking:

- **📂 Open folder**: click the "Select KB folder" button at top-right and choose a folder with Markdown documents
- **⚡ Auto KB**: uses the current folder's data by default; slicing/embedding runs automatically when you ask
- **💾 Pick a .kb file**: select a saved knowledge base version from the top-right dropdown

You can also manually slice/embed in the "Slices" tab, then come back to ask.`)
let kb_state = ref("")
// 独立性评审「不合适」计数（问题页评审仅会话内标记；由 questionView 上报，用于底部状态栏常驻项）
const questionBadCount = ref(0)
// 独立性评审活动状态：进行中/完成汇总（底部状态栏常驻显示，不受 6s 自动清除影响）
const questionReviewStatus = ref('')
const questionReviewRunning = ref(false)

// 底部状态栏（prep-status-panel）显示的当前状态行：所有 kb_state 更新都会反映到面板，避免弹窗刷屏
let kbPanelMsg = ref('')
let kbPanelKind = ref<'info' | 'success' | 'warning' | 'error'>('info')

// 实时状态（检索测试/批测进度等，由 testManager 通过 updateLiveState 上报，显示在底部状态栏而非 ElMessage 弹窗）
let kbLiveState = ref("")

// 自动处理问题进度（语义去重+择优+多答案合并，由 testManager 通过 updateDedupProgress 上报，显示在底部状态栏）
let dedupProgress = ref<{ total: number; compared: number; dupCount: number; mergedCount: number; current: number } | null>(null)

// 底部状态栏实时状态的图标与样式（根据文本推断进行中/完成/失败）
const kbLiveStateIcon = computed(() => {
  const v = kbLiveState.value
  if (/失败|错误|error|fail|出错/.test(v)) return 'fa-exclamation-circle'
  if (/完成|成功|complete|success|已生成|判定/.test(v)) return 'fa-check-circle'
  if (/正在|进行|评分|判分|生成|补齐/.test(v)) return 'fa-spinner fa-spin'
  return 'fa-info-circle'
})
const kbLiveStateClass = computed(() => {
  const v = kbLiveState.value
  if (/失败|错误|error|fail|出错/.test(v)) return 'error'
  if (/完成|成功|complete|success|已生成|判定/.test(v)) return 'done'
  if (/正在|进行|评分|判分|生成|补齐/.test(v)) return 'running'
  return ''
})

// 检索方式选择（策略可配置，选项来自策略注册表）
let queryMethod = ref('similarity')

// 策略注册表加载与刷新（配置 UI 写入 localStorage 后在此合并）
const strategyVersion = ref(0)
const refreshStrategies = () => { strategyVersion.value++ }
const loadPersistedStrategies = () => {
    try {
        const saved = JSON.parse(localStorage.getItem('knowrag_strategies') || '[]')
        setUserStrategies(saved)
    } catch {
        setUserStrategies([])
    }
}
loadPersistedStrategies()
// QA 下拉选项来自可配置策略注册表（响应策略配置变更）
const strategyOptions = computed(() => {
    void strategyVersion.value
    return getEnabledStrategies().map(s => ({ id: s.id, label: s.label, kind: s.kind }))
})

// 按所选检索方式执行查询（统一走 runChatStrategy）
const handleSearch = async () => {
    const q = prompt.value
    if (!q || !q.trim()) {
        ElMessage.warning(store.locales == 'zh' ? '请输入问题' : 'Please enter a question')
        return
    }
    if (!getEnabledStrategies().some(s => s.id === queryMethod.value)) {
        queryMethod.value = 'similarity'
    }
    await runChatStrategy(queryMethod.value, q)
}
// 只显示文件夹名称（悬停时显示完整路径）
const rootFolderName = computed(() => {
    if (!store.root) return store.locales == 'zh' ? '未选择文件夹' : 'No folder'
    const parts = store.root.split(/[\\/]/).filter(Boolean)
    return parts[parts.length - 1] || store.root
})

// 当前问答的佐证（证据）列表
let currentEvidence = ref<Array<{
    id: string
    label: string
    filePath: string
    content: string
    score: number
    method: string
    reason?: string
}>>([])

// Agentic 推理步骤（工具调用轨迹，问答右侧「推理路径」tab 展示）
let agentSteps = ref<Array<{
    round: number
    tool: string
    args: any
    result: string
    status: 'running' | 'done' | 'error'
}>>([])

// 问答右侧面板 tab（推理路径 / 佐证，两栏切换）
const rightTab = ref<'steps' | 'evidence'>('steps')
// 有效 tab：所选 tab 无内容时自动回退到有内容的 tab
const activeRightTab = computed(() => {
    const hasSteps = agentSteps.value.length > 0
    const hasEvidence = currentEvidence.value.length > 0
    if (rightTab.value === 'steps' && hasSteps) return 'steps'
    if (rightTab.value === 'evidence' && hasEvidence) return 'evidence'
    if (hasSteps) return 'steps'
    if (hasEvidence) return 'evidence'
    return 'steps'
})

// Agentic 工具中文标签（推理路径面板展示）
const qaAgentToolLabel = (tool: string): string => {
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

// 佐证筛选（topK）：按来源（method）分组、组内按分数降序（0 分保持原序），
// 跨组轮转取前 topK（每组各出 1 条轮流选，避免单一来源垄断），最后按原顺序返回
const filterEvidenceTopK = (evidence: any[], topK: number): any[] => {
    const K = Math.max(1, topK || 10)
    if (!evidence || evidence.length <= K) return evidence || []
    const groups = new Map<string, any[]>()
    for (const e of evidence) {
        const key = e.method || 'other'
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key)!.push(e)
    }
    for (const arr of groups.values()) arr.sort((a, b) => (b.score || 0) - (a.score || 0))
    const keys = [...groups.keys()]
    const idx: Record<string, number> = {}
    keys.forEach(k => idx[k] = 0)
    const chosen: any[] = []
    let anyLeft = true
    while (chosen.length < K && anyLeft) {
        anyLeft = false
        for (const k of keys) {
            if (chosen.length >= K) break
            const arr = groups.get(k)!
            if (idx[k] < arr.length) { chosen.push(arr[idx[k]++]); anyLeft = true }
        }
    }
    const chosenSet = new Set(chosen)
    return evidence.filter(e => chosenSet.has(e))
}

// Agentic 佐证筛选（topK）：所有证据已按原始问题重排（score=语义相关度），
// 全局按分数降序取前 K（0 分垫底、同分保持原顺序），不再跨来源轮转，
// 使 Agentic 的 topK 严格对齐问题相关度
const pickTopKByScore = (evidence: any[], topK: number): any[] => {
    const K = Math.max(1, topK || 10)
    if (!evidence || evidence.length <= K) return evidence || []
    const ranked = evidence
        .map((e, i) => ({ e, i, s: e.score || 0 }))
        .sort((a, b) => (b.s - a.s) || (a.i - b.i))
    const chosen = new Set(ranked.slice(0, K).map(x => x.e))
    return evidence.filter(e => chosen.has(e))
}

// 佐证分数的相对展示基准：取当前显示证据的最大分（避免高分饱和/伪分值导致全部显示 100%），
// 展示为「该条证据相关度 / 当前最相关证据」的相对百分比
const evidenceMaxScore = computed(() => {
    let m = 0
    for (const e of currentEvidence.value) m = Math.max(m, e.score || 0)
    return m || 0
})

// 佐证方法标签
const getEvidenceMethodLabel = (method: string): string => {
    const labels: Record<string, string> = {
        'similarity': store.locales == 'zh' ? '相似度' : 'Similarity',
        'community': store.locales == 'zh' ? '社区' : 'Community',
        'multiHop': store.locales == 'zh' ? '多跳' : 'Multi-hop',
        'ontology': store.locales == 'zh' ? '本体' : 'Ontology',
        'agentic': store.locales == 'zh' ? '智能检索' : 'Agentic',
        'file': store.locales == 'zh' ? '文件' : 'File',
        'entity': store.locales == 'zh' ? '实体' : 'Entity',
        'dense': store.locales == 'zh' ? '稠密' : 'Dense',
        'graph': store.locales == 'zh' ? '图谱' : 'Graph',
    }
    return labels[method] || method
}

// 监听 kb_state 变化：更新底部状态栏（prep-status-panel）；仅「错误」保留 ElMessage 弹窗，
// 其余状态（进度/成功/警告）统一显示在面板状态行，避免打开知识库/批处理时弹窗刷屏
let _kbMsgInstance: any = null
// 自动处理（自动准备知识库/自动构建本体社区）期间抑制弹窗，避免遮挡底部状态栏
let _suppressKbMsg = false
// 面板状态行自动清除定时器（无新状态一段时间后恢复显示知识库概况）
let _kbPanelClearTimer: any = null

// 持续进行中的任务（问题提取 / 自动准备 / 本体构建 / 处理管线）：期间状态栏提示不自动清除。
// 避免提取问题等长任务在两次更新间隔（>6s，如单块 LLM 推理）时回落到“最近完成摘要（向量化完成）”打断进度显示。
const _kbTaskBusy = () =>
  (extractProgress?.value?.isRunning ?? false) ||
  (prepState?.active ?? false) ||
  (ingestRunning?.value ?? false) ||
  (buildProgress?.value?.isRunning ?? false)

// 状态文本分类：错误 / 成功 / 警告 / 普通信息
const classifyKbMsg = (val: string): 'success' | 'warning' | 'info' | 'error' => {
  if (/失败|错误|error|fail|出错|Error/.test(val)) return 'error'
  if (/完成|成功|complete|success|已生成|判定/.test(val)) return 'success'
  if (/没有|未找到|警告|warning|暂停|停止|已暂停/.test(val)) return 'warning'
  return 'info'
}

// 面板状态行：图标与样式（复用 prep-status-step 的 done/error/running 配色）
const kbPanelStepIcon = computed(() => {
  switch (kbPanelKind.value) {
    case 'success': return 'fa-check-circle'
    case 'warning': return 'fa-exclamation-triangle'
    case 'error': return 'fa-times-circle'
    default: return 'fa-info-circle'
  }
})
const kbPanelStepClass = computed(() => {
  switch (kbPanelKind.value) {
    case 'success': return 'done'
    case 'warning': return 'warning'
    case 'error': return 'error'
    default: return ''
  }
})

watch(kb_state, (val) => {
  // 1) 底部状态栏始终显示最新状态（无新状态 6s 后自动清除，恢复知识库概况；持续任务进行中不清除）
  kbPanelMsg.value = val || ''
  kbPanelKind.value = val ? classifyKbMsg(val) : 'info'
  if (_kbPanelClearTimer) { clearTimeout(_kbPanelClearTimer); _kbPanelClearTimer = null }
  if (val && !_kbTaskBusy()) {
    _kbPanelClearTimer = setTimeout(() => {
      kbPanelMsg.value = ''
      kbPanelKind.value = 'info'
      _kbPanelClearTimer = null
    }, 6000)
  }
  // 2) 弹窗策略：仅错误弹窗；自动处理期间完全静默（只进面板）
  if (_suppressKbMsg) return
  if (!val || kbPanelKind.value !== 'error') return
  if (_kbMsgInstance) {
    _kbMsgInstance.close()
    _kbMsgInstance = null
  }
  _kbMsgInstance = ElMessage({
    message: val,
    type: 'error',
    duration: 3000,
    grouping: true
  })
})

let knowledgeBases = ref([]) as any
let selectedKbIndex = ref(0) as any
// 是否已从 .kb 文件读取知识库（false 表示处于自动知识库模式）
const isKbLoaded = ref(false)

// 从 localStorage 恢复上次选择的嵌入模型（作为无 .kb、且设置页未配置默认嵌入模型时的兜底）
const savedEmbedModel = localStorage.getItem('knowrag_embed_model') || 'nomic-embed-text:latest'

// 当前全局 AI 来源（统一跟随 store.AIconfig.llm.type，不再单独选择来源）
const curLlmType = (store.AIconfig?.llm?.type as KbProvider) || 'ollama'
const curLlmCfg = kbAi.getProviderConfig(store.AIconfig?.llm, curLlmType) || {}

// 嵌入模型是否被「知识库显式锁定」：true = 处理配置中用户自选 或 .kb 自带；false = 跟随设置页默认嵌入模型
const embedPinned = ref(false)

let model = ref({
    // 兼容旧字段（仅 Ollama 旧版地址，已不使用；连接配置取自 store.AIconfig.llm[type]）
    url:"http://127.0.0.1:11434",
    list:[] as any,
    think:false,
    // 默认嵌入模型：优先设置页(AI 来源)配置的默认嵌入模型；无 .kb 且未显式指定时跟随它
    embed: curLlmCfg.embed_model || savedEmbedModel,
    process: curLlmCfg.model || store.AIconfig.llm.ollama.model,
    processPrompt:store.locales=="zh"?"请阅读下面的资料，针对资料内容列出若干“问题”，并为每个问题给出一个能直接回答它的“答案”。严格遵循以下格式，每个问题与答案独占一行成对出现：\n问题：<问题文本>\n答案：<答案文本>\n问题与答案都要分开存储，不要拼接成一句话；不要编号、不要标题、不要分组、不要任何解释或前后缀。若资料无法回答某个设问，则只保留“问题：”行、省略“答案：”。资料如下：":"Read the following information. For each question it can answer, output the question and a concise answer, one pair per two lines as: \nQuestion: <question>\nAnswer: <answer>\nKeep the question and answer as separate lines/fields; do NOT merge them into one sentence. No numbering, headings, grouping labels, explanations, or any prefix/suffix. If the text cannot answer a question you posed, output only its \"Question:\" line without \"Answer:\". The information is as follows:",
    searchMethod:"CS",
    searchMode:"按数量",
    matchRatio:0.58,
    searchNum:10,
    evidenceTopK:10,
    searchCharacter:2500,
    chat: curLlmCfg.model || store.AIconfig.llm.ollama.model,
    sliceStrategy:"语义",
    // Agentic 最终重排：融合工具子查询检索分数的权重（0=只用原始问题，1=只用子查询分数）
    agentSubQueryWeight: 0.3,
    sliceMaxChars: 4000,
    sliceOverlapChars: 300,
    semanticSplitThreshold: 0.86,
    maxTestCases: 50,
    questionDedupEnabled: true,
    questionDedupThreshold: 0.85,
    questionMergeEnabled: true,
    mdsIterations: 50,
    mdsEpsilon: 0.1,
    pcaComponents: 2,
    tsnePerplexity: 30,
    tsneIterations: 1000,
    tsneLearningRate: 200,
    umapNeighbors: 15,
    umapMinDist: 0.1,
    umapSpread: 1.0,
    summaryWeight: 0.0,
    sliceWeight: 1.0,
    // 是否把向量数据写入 .kb 文件（false=精简模式：不存向量、KB 文件更小，首次问答按需重新向量化）
    saveVectors: true,
    // BM25相关配置
    bm25Enabled: false,
    bm25Weight: 0.3,
    bm25K1: 1.5,
    bm25B: 0.75,
    cosineWeight: 0.7,
    // 本体构建配置
    ontologyBatchSize: 8,
    // 本体推理描述词 - 实体类型
    ontologyEntityTypes: '概念、对象、事物、主体、人物、组织、地点、事件、时间、地点、角色、系统、过程、方法、工具、材料、属性、状态、规则、策略',
    // 卡片描述推理提示词模板（默认自带模板，留空则使用代码内置默认），占位符: {{entityName}} {{entityTypes}} {{content}} {{language}}
    entityDescriptionPrompt: '你是一个知识图谱专家。请根据提供的文本内容，为实体"{{entityName}}"生成一个准确、完整的描述。\n\n实体类型参考：{{entityTypes}}\n\n要求：\n1. 描述应完全基于提供的文本，不要添加外部知识\n2. 概括该实体的核心特征、定义、职能或作用\n3. 如果文本中有多个方面的信息，应综合概括\n4. 描述应简洁明了，控制在200字以内\n5. 不要用引号包裹整个描述\n6. 只返回描述文本，不要有任何其他内容\n\n文本内容：\n{{content}}',
    // 本体推理描述词 - 关系类型
    ontologyRelationTypes: '- **is_a**：继承关系。例如："医疗保险" is_a "保险合同"\n- **part_of**：组成关系。例如："保险条款" part_of "保险合同"\n- **depends_on**：依赖关系。例如："理赔" depends_on "保险合同"\n- **related_to**：一般关联关系\n- **contains**：包含关系\n- **causes**：因果关系。例如："火灾" causes "烟雾"\n- **uses**：使用关系。例如："系统" uses "算法"\n- **located_in**：位置关系。例如："仓库" located_in "城市"\n- **produce**：产出关系。例如："工厂" produce "产品"\n- **influences**：影响关系。例如："政策" influences "经济"',
})

// ==================== 统一模型来源客户端（多 provider 支持） ====================
// 知识处理模块统一使用全局 AI 配置（store.AIconfig.llm.type），连接配置（URL / API Key / 模型）
// 取自 store.AIconfig.llm[type]；嵌入模型优先用已加载 .kb 的配置，否则用该来源的默认嵌入模型。
const buildKbSpec = (): KbModelSpec => {
    const type: KbProvider = (store.AIconfig?.llm?.type as KbProvider) || 'ollama'
    const cfg = kbAi.getProviderConfig(store.AIconfig?.llm, type) || {}
    return {
        llmType: type,
        config: cfg,
        embed: model.value.embed || cfg.embed_model || '',
        chat: model.value.chat || cfg.model || '',
        process: model.value.process || cfg.model || '',
        think: model.value.think,
        temperature: store.AIconfig?.llm?.temperature ?? 0.7,
        maxTokens: store.AIconfig?.llm?.max_tokens ?? 8192,
        topP: store.AIconfig?.llm?.top_p ?? 1,
        // 当前来源无嵌入模型时，嵌入回退到「嵌入兜底」设置的来源（默认 Ollama；聊天/处理仍用当前来源）
        embedFallback: kbAi.buildEmbedFallbackFromStore(store),
    }
}

// 全局 AI 来源切换 → 重新拉取该来源模型列表并同步模型选择（不再单独维护来源）
watch(() => store.AIconfig?.llm?.type, async () => {
    const cfg = kbAi.getProviderConfig(store.AIconfig?.llm, (store.AIconfig?.llm?.type as KbProvider) || 'ollama') || {}
    model.value.list = []
    if (!model.value.chat) model.value.chat = cfg.model || ''
    if (!model.value.process) model.value.process = cfg.model || ''
    try { await getModel() } catch (e) { console.error('同步模型来源拉取失败:', e) }
})

// 全局 AI 配置中「当前来源」模型调整（设置页修改后）→ 及时同步本模块对话/处理模型，
// 避免只使用打开模块时配置的模型（buildKbSpec / testManager 均优先读取 model.value.chat/process）
watch(
    () => {
        const llm = store.AIconfig?.llm || {}
        const type: KbProvider = (llm.type as KbProvider) || 'ollama'
        return kbAi.getProviderConfig(llm, type)?.model || ''
    },
    (m) => {
        if (!m) return
        if (model.value.chat !== m) model.value.chat = m
        if (model.value.process !== m) model.value.process = m
    }
)

// 「设置页默认嵌入模型」变化（设置 → AI 来源 → 默认嵌入模型）→ 本知识库未被显式锁定、且尚未向量化时自动跟随，
// 使「知识库默认嵌入模型 = 设置页默认嵌入模型」成立；已被 .kb / 处理配置锁定或已向量化则不改动（避免维度不一致）。
watch(
    () => {
        const llm = store.AIconfig?.llm || {}
        const type: KbProvider = (llm.type as KbProvider) || 'ollama'
        return kbAi.getProviderConfig(llm, type)?.embed_model || ''
    },
    (def, old) => {
        if (!def || def === old || embedPinned.value) return
        if (blocks.value.some((b: any) => b.A_vector && b.A_vector.length)) return
        if (questionBank.value.some((q: any) => q.qVector && q.qVector.length)) return
        if (model.value.embed === def) return
        model.value.embed = def
    }
)

// 便捷封装：嵌入 / 对话 / 流式对话 / Agentic
const kbEmbed = async (input: string | string[]): Promise<number[][]> => kbAi.embed(buildKbSpec(), input)
const kbChat = async (messages: any[], opts?: any): Promise<string> => kbAi.chat(buildKbSpec(), messages, opts)
const kbStreamChat = async (messages: any[], onChunk: (c: string) => void, opts?: any): Promise<string> =>
    kbAi.streamChat(buildKbSpec(), messages, onChunk, opts)

// ==================== 切片卡片显示（Ctrl + 滚轮缩放） ====================
// 基准尺寸（100%），按住 Ctrl + 滚轮整体缩放，缩放值持久化
const SLICE_BASE = {
    minColWidth: 180,       // 网格最小列宽(px)，越大卡片越宽、每行数量越少
    cardHeight: 150,        // 卡片高度(px)
    labelSize: 10,          // 卡片标题字号(px)
    contentSize: 8,         // 内容字号(px)
    contentMaxHeight: 120,  // 内容最大高度(px)
}
const savedSliceZoom = parseFloat(localStorage.getItem('knowrag_slice_zoom') || '1')
const sliceZoom = ref(isFinite(savedSliceZoom) ? Math.min(2, Math.max(0.6, savedSliceZoom)) : 1)
const sliceViewCfg = computed(() => {
    const z = sliceZoom.value
    return {
        minColWidth: Math.round(SLICE_BASE.minColWidth * z),
        cardHeight: Math.round(SLICE_BASE.cardHeight * z),
        labelSize: +(SLICE_BASE.labelSize * z).toFixed(1),
        contentSize: +(SLICE_BASE.contentSize * z).toFixed(1),
        contentMaxHeight: Math.round(SLICE_BASE.contentMaxHeight * z),
    }
})
watch(sliceZoom, (v) => {
    localStorage.setItem('knowrag_slice_zoom', String(v))
})
// Ctrl + 滚轮缩放；返回 false 阻止浏览器默认页面缩放
const handleSliceWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) return
    e.preventDefault()
    const step = e.deltaY > 0 ? -0.1 : 0.1
    sliceZoom.value = Math.min(2, Math.max(0.6, +(sliceZoom.value + step).toFixed(2)))
    // 卡片变大后若可视区出现空白且仍有更多切片，自动补足填满
    nextTick(() => fillViewportIfShort())
    return false
}
const resetSliceZoom = () => {
    sliceZoom.value = 1
}

// 底部状态栏提示（行为/提示信息）：替代 ElMessage 弹窗，显示在 prep-status-panel；6s 无更新自动清除
const showPrepHint = (msg: string) => {
    kbPanelMsg.value = msg
    kbPanelKind.value = 'info'
    if (_kbPanelClearTimer) { clearTimeout(_kbPanelClearTimer); _kbPanelClearTimer = null }
    if (msg && !_kbTaskBusy()) {
        _kbPanelClearTimer = setTimeout(() => {
            kbPanelMsg.value = ''
            kbPanelKind.value = 'info'
            _kbPanelClearTimer = null
        }, 6000)
    }
}

// 切片策略实施说明（切换策略时用底部状态栏提示，不再弹窗）
function getSliceStrategyDesc(strategy: string): string {
    const maxChars = model.value.sliceMaxChars
    const overlapChars = model.value.sliceOverlapChars
    const threshold = model.value.semanticSplitThreshold
    if (strategy === '标识符') {
        return `按文档中的多个连续空行切分为段落；段落超过 ${maxChars} 字符时按句子二次切分，并为相邻切片补充 ${overlapChars} 字符重叠（仅用于向量化）。`
    }
    if (strategy === '智能') {
        return `按一级标题（章节/第X条/一、/1./【】等）切分；未识别到标题时自动回退到标识符策略，同样应用大小上限与重叠。`
    }
    if (strategy === '语义') {
        return `先将内容按段落拆分并向量化，计算相邻段落余弦相似度，在相似度低于阈值（${threshold}）的主题边界处切分；更适合无标题的连续性文档，无法切分时自动回退到标识符策略。`
    }
    return ''
}

watch(() => model.value.sliceStrategy, (val) => {
    const desc = getSliceStrategyDesc(val)
    if (desc) {
        showPrepHint(store.locales === 'zh' ? `切片策略「${val}」：${desc}` : `Slice strategy "${val}": ${desc}`)
    }
})

// ==================== 手动添加实体相关状态 ====================
const showAddEntityModal = ref(false)
const newEntityName = ref('')
const isAddingEntity = ref(false)
const addEntityError = ref('')

// 新增：实时匹配统计
const matchStats = ref({
    matchedBlocksCount: 0,
    isDuplicate: false,
    duplicateName: '',
    matchedFilePaths: [] as string[]
})

// 新增：实时搜索匹配切片
const searchMatchingBlocks = () => {
    const name = newEntityName.value.trim()
    
    if (!name) {
        matchStats.value = {
            matchedBlocksCount: 0,
            isDuplicate: false,
            duplicateName: '',
            matchedFilePaths: []
        }
        addEntityError.value = ''
        return
    }
    
    if (name.length > 100) {
        matchStats.value = {
            matchedBlocksCount: 0,
            isDuplicate: false,
            duplicateName: '',
            matchedFilePaths: []
        }
        addEntityError.value = store.locales === 'zh' ? '实体名称不能超过100个字符' : 'Entity name cannot exceed 100 characters'
        return
    }
    
    // 检查是否重复
    const key = name.toLowerCase()
    const isDuplicate = globalEntities.value.has(key)
    const duplicateName = isDuplicate ? globalEntities.value.get(key)?.name || '' : ''
    
    if (blocks.value.length === 0) {
        matchStats.value = {
            matchedBlocksCount: 0,
            isDuplicate,
            duplicateName,
            matchedFilePaths: []
        }
        addEntityError.value = store.locales === 'zh' ? '没有切片数据，请先处理文件' : 'No slice data, please process files first'
        return
    }
    
    // 搜索匹配的切片
    const matchedBlockIds: string[] = []
    const matchedFilePaths: string[] = []
    
    for (const block of blocks.value) {
        let isMatched = false
        
        // 在切片内容中搜索
        if (block.A && block.A.includes(name)) {
            isMatched = true
        }
        
        // 在问题中搜索
        if (!isMatched && block.Q && block.Q !== '问题未推理' && block.Q.includes(name)) {
            isMatched = true
        }
        
        if (isMatched) {
            if (!matchedBlockIds.includes(block.id)) {
                matchedBlockIds.push(block.id)
            }
            if (!matchedFilePaths.includes(block.filePath)) {
                matchedFilePaths.push(block.filePath)
            }
        }
    }
    
    matchStats.value = {
        matchedBlocksCount: matchedBlockIds.length,
        isDuplicate,
        duplicateName,
        matchedFilePaths
    }
    
    // 清除之前的错误（如果没有问题的话）
    if (matchedBlockIds.length === 0) {
        addEntityError.value = store.locales === 'zh' ? 
            `未找到包含"${name}"的切片` : 
            `No blocks containing "${name}" found`
    } else if (isDuplicate) {
        addEntityError.value = store.locales === 'zh' ? 
            `实体"${name}"已存在，添加将更新关联切片` : 
            `Entity "${name}" already exists, adding will update associations`
    } else {
        addEntityError.value = ''
    }
}

// 监听实体名称变化，实时更新匹配统计
watch(newEntityName, () => {
    searchMatchingBlocks()
})

// 打开模态框时重置并清空统计
const openAddEntityModal = () => {
    newEntityName.value = ''
    addEntityError.value = ''
    matchStats.value = {
        matchedBlocksCount: 0,
        isDuplicate: false,
        duplicateName: '',
        matchedFilePaths: []
    }
    showAddEntityModal.value = true
    // 下一帧聚焦输入框
    nextTick(() => {
        const input = document.getElementById('newEntityNameInput')
        if (input) input.focus()
    })
}

// 关闭模态框
const closeAddEntityModal = () => {
    if (isAddingEntity.value) return // 正在添加中不允许关闭
    showAddEntityModal.value = false
    newEntityName.value = ''
    addEntityError.value = ''
}

// 手动添加实体
const addEntityManually = async () => {
    const name = newEntityName.value.trim()
    
    // 验证
    if (!name) {
        addEntityError.value = store.locales === 'zh' ? '请输入实体名称' : 'Please enter entity name'
        return
    }
    
    if (name.length > 100) {
        addEntityError.value = store.locales === 'zh' ? '实体名称不能超过100个字符' : 'Entity name cannot exceed 100 characters'
        return
    }
    
    // 检查是否已存在
    const key = name.toLowerCase()
    if (globalEntities.value.has(key)) {
        addEntityError.value = store.locales === 'zh' ? 
            `实体"${name}"已存在` : 
            `Entity "${name}" already exists`
        return
    }
    
    if (blocks.value.length === 0) {
        addEntityError.value = store.locales === 'zh' ? 
            '没有切片数据，请先处理文件' : 
            'No slice data, please process files first'
        return
    }
    
    isAddingEntity.value = true
    addEntityError.value = ''
    kb_state.value = store.locales === 'zh' ? 
        `正在添加实体"${name}"...` : 
        `Adding entity "${name}"...`
    
    try {
        // 查找所有匹配的切片
        const matchedBlocks: any[] = []
        const matchedBlockIds: string[] = []
        const matchedFilePaths: string[] = []
        
        for (const block of blocks.value) {
            let isMatched = false
            
            // 在切片内容中搜索
            if (block.A && block.A.includes(name)) {
                isMatched = true
            }
            
            // 在问题中搜索
            if (!isMatched && block.Q && block.Q !== '问题未推理' && block.Q.includes(name)) {
                isMatched = true
            }
            
            if (isMatched) {
                matchedBlocks.push(block)
                if (!matchedBlockIds.includes(block.id)) {
                    matchedBlockIds.push(block.id)
                }
                if (!matchedFilePaths.includes(block.filePath)) {
                    matchedFilePaths.push(block.filePath)
                }
            }
        }
        
        if (matchedBlocks.length === 0) {
            addEntityError.value = store.locales === 'zh' ? 
                `未找到包含"${name}"的切片，请检查实体名称` : 
                `No blocks containing "${name}" found, please check entity name`
            isAddingEntity.value = false
            return
        }
        
        // 创建新实体
        const newEntity: OntologyEntity = {
            id: shortId('entity'),
            name: name,
            type: 'entity',
            nodeType: 'entity',
            layer: 'data',
            description: '',
            associatedBlocks: matchedBlockIds,
            associatedFiles: matchedFilePaths
        }
        
        // 添加到全局实体
        globalEntities.value.set(key, newEntity)
        
        // 更新索引
        if (!entityToBlocksIndex.value.has(key)) {
            entityToBlocksIndex.value.set(key, new Set())
        }
        for (const blockId of matchedBlockIds) {
            entityToBlocksIndex.value.get(key)!.add(blockId)
        }
        
        // 更新视图
        updateOntologyViewer()
        updateEntityCards()
        
        kb_state.value = store.locales === 'zh' ? 
            `实体"${name}"已添加，关联${matchedBlockIds.length}个切片，正在生成描述...` : 
            `Entity "${name}" added, associated with ${matchedBlockIds.length} blocks, generating description...`
        
        // 生成描述
        await reasonEntityDescription(newEntity)
        
        // 刷新卡片视图
        updateEntityCards()
        handleCardSearch()
        
        // 更新本体视图
        updateOntologyViewer()
        
        kb_state.value = store.locales === 'zh' ? 
            `实体"${name}"添加完成！关联${matchedBlockIds.length}个切片` : 
            `Entity "${name}" added successfully! Associated with ${matchedBlockIds.length} blocks`
        
        // 关闭模态框
        showAddEntityModal.value = false
        newEntityName.value = ''
        
    } catch (error) {
        console.error('添加实体失败:', error)
        addEntityError.value = store.locales === 'zh' ? 
            `添加失败: ${error}` : 
            `Failed to add: ${error}`
        kb_state.value = store.locales === 'zh' ? 
            `添加实体"${name}"失败` : 
            `Failed to add entity "${name}"`
    } finally {
        isAddingEntity.value = false
    }
}

// 编辑实体描述
const isEditingDescription = ref(false)
const saveDescriptionToGlobal = () => {
    if (!selectedEntityForCards.value) return
    const key = selectedEntityForCards.value.name.toLowerCase()
    const existing = globalEntities.value.get(key)
    if (existing) {
        existing.description = selectedEntityForCards.value.description
        globalEntities.value.set(key, existing)
        updateEntityCards()
        updateOntologyViewer()
    }
}
// 文件摘要信息存储
let fileSummaries = ref(new Map()) as any

// 文件级摘要索引（方案B：独立于切片的文件粒度数据，summarize_file/file_score 原语消费）
let fileIndex = ref(new Map()) as any
// 摘要索引版本号（summarize_file 写入 fileIndex 后自增，触发依赖它的 computed 刷新当前选中文件摘要）
let fileIndexVersion = ref(0)
// 构建清单：filePath → { size, mtime, contentHash }，用于打开 KB 时增量变更检测
let buildManifest = ref({}) as any
// 增量更新运行标记
const incrementalRunning = ref(false)

// 保证 summaryWeight 和 sliceWeight 和为 1
watch(() => model.value.summaryWeight, (val) => {
    const v = Number(val) || 0
    model.value.sliceWeight = Math.max(0, Math.min(1, 1 - v))
})

// 保证 cosineWeight 和 bm25Weight 和为 1
watch(() => model.value.bm25Weight, (val) => {
    const v = Number(val) || 0
    model.value.cosineWeight = Math.max(0, Math.min(1, 1 - v))
})

const sliceSearchKeyword = ref('')

const filteredBlocks = computed(() => {
    // 关键字搜索：跨全库切片检索（命中 label/正文/问题/文件路径），此时忽略当前文档选择
    const kw = sliceSearchKeyword.value.trim().toLowerCase()
    if (kw) {
        return blocks.value.filter((block: any) =>
            (block.label && block.label.toLowerCase().includes(kw)) ||
            (block.A && block.A.toLowerCase().includes(kw)) ||
            (block.filePath && block.filePath.toLowerCase().includes(kw)) ||
            (block.Q && block.Q !== '问题未推理' && block.Q.toLowerCase().includes(kw))
        )
    }
    if (documentName.value === '全部') {
        return blocks.value;
    } else {
        return blocks.value.filter((block: any) => block.label === documentName.value);
    }
});

// ========== 滚动加载（无限滚动）相关状态 ==========
const LOAD_CHUNK_SIZE = 40
const displayedCount = ref(LOAD_CHUNK_SIZE)
const isLoadingMore = ref(false)
const hasMoreBlocks = computed(() => {
    return displayedCount.value < filteredBlocks.value.length
})

const displayedBlocks = computed(() => {
    return filteredBlocks.value.slice(0, displayedCount.value)
})

function appendMoreBlocks() {
    if (!hasMoreBlocks.value) return
    displayedCount.value = Math.min(
        displayedCount.value + LOAD_CHUNK_SIZE,
        filteredBlocks.value.length
    )
}

function loadMoreBlocks() {
    if (isLoadingMore.value || !hasMoreBlocks.value) return
    
    isLoadingMore.value = true
    
    requestAnimationFrame(() => {
        setTimeout(() => {
            appendMoreBlocks()
            isLoadingMore.value = false
            // 追加后若仍未填满可视区且还有更多，继续补足（窗口拉大 / 初始高度不足场景）
            fillViewportIfShort()
        }, 50)
    })
}

/** 当容器内容高度不足以填满可视区且仍有更多切片时，自动继续加载（窗口缩放 / 切回切片视图调用） */
async function fillViewportIfShort() {
    const container = document.querySelector('.blocks')
    if (!container || !hasMoreBlocks.value) return
    let guard = 0
    while (hasMoreBlocks.value && container.scrollHeight <= container.clientHeight + 4 && guard < 60) {
        appendMoreBlocks()
        guard++
        // 等待 DOM 渲染后再判断容器高度（displayedCount 为响应式，需下一帧生效）
        await nextTick()
    }
}

const onWindowResize = () => {
    if (viewMode.value === 'slice') {
        fillViewportIfShort()
    }
}

function handleScroll(event: Event) {
    const container = event.target as HTMLElement
    if (!container) return
    
    const scrollBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    
    if (scrollBottom < 200 && hasMoreBlocks.value && !isLoadingMore.value) {
        loadMoreBlocks()
    }
}

function resetScrollLoad() {
    displayedCount.value = LOAD_CHUNK_SIZE
    isLoadingMore.value = false
}

watch(() => documentName.value, () => {
    resetScrollLoad()
})

watch(() => blocks.value.length, () => {
    resetScrollLoad()
})

// 切片视图搜索词变化 → 重置分页；切片视图可见时补足可视区（命中很少也能看到结果）
watch(() => sliceSearchKeyword.value, () => {
    resetScrollLoad()
    if (viewMode.value === 'slice') {
        nextTick(() => fillViewportIfShort())
    }
})

// 切回切片视图时，若可视区放大而切片不足，自动补足（等 DOM 渲染后再判断高度）
watch(() => viewMode.value, (v) => {
    if (v === 'slice') {
        nextTick(() => fillViewportIfShort())
    }
    // 进入「文件」标签页时刷新摘要提示状态（直接打开文件夹/未切片时也能显示判断栏）
    if (v === 'file') {
        scanSummaryStatus()
        // 检测磁盘文件相对知识库基准的变更，刷新文件行徽标（新增/修改/删除）
        scheduleFileViewChangeCheck()
    }
})

// ==================== 问题库（Question Bank，一等实体） ====================
// 方案 A：问题只存问题库（每条独立文本 + qVector + 关联切片引用 answerBlocks/srcBlockId）；
// 切片不再持有 Q / Q_vector / Q_vectors。检索的问题增强（Q 通道）由
// computeBlockQuestionVectors 建立「切片 → 关联问题向量」索引，在 buildRetrievalContext 注入，
// UI 问答与 headless(kb_search) 的 dense_score 共用同一索引。
const questionBank = ref<KbQuestion[]>([])

// 问题 id 自增（推理/手动新增时分配；加载 .kb 后推进到现有最大值）
let qSeq = 0
const nextQuestionId = () => { qSeq++; return `q${qSeq}` }

/** 把单条问题加入问题库（prepend=true 插入最前，供手动添加便于立刻看到；默认追加末尾） */
const pushQuestion = (q: Partial<KbQuestion> & { text: string }, prepend = false): KbQuestion => {
  const full: KbQuestion = {
    id: q.id || nextQuestionId(),
    text: q.text,
    qVector: q.qVector,
    srcBlockId: q.srcBlockId,
    srcFilePath: q.srcFilePath,
    srcLabel: q.srcLabel,
    answerBlocks: q.answerBlocks || [],
    origin: q.origin || 'manual',
    status: q.status || 'kept',
    createdAt: q.createdAt || Date.now(),
    note: q.note,
    // 答案与问题分开存储（手动/导入/推理生成），必须透传否则入库即丢失
    extraAnswer: q.extraAnswer,
  }
  if (prepend) questionBank.value.unshift(full)
  else questionBank.value.push(full)
  return full
}

/** 批量替换某切片推理产生的问题（重推理时调用；问题只入问题库，不写切片；answers 与 texts 对齐，存入 extraAnswer） */
const replaceBlockReasonedQuestions = (block: any, texts: string[], vecs: (number[] | undefined)[], answers?: (string | undefined)[]) => {
  const blockId = block?.id
  if (!blockId) return
  // 仅移除该块「推理产生」的问题（含已合并进别的答案的），保留手动/导入等其他来源
  questionBank.value = questionBank.value.filter(q => !(q.srcBlockId === blockId && q.origin === 'reasoned'))
  const createdAt = Date.now()
  const filePath = block.filePath, label = block.label
  texts.forEach((text, k) => {
    const t = (text || '').trim()
    if (!t) return
    const ans = answers?.[k]
    pushQuestion({
      text: t,
      qVector: vecs?.[k] || undefined,
      srcBlockId: blockId,
      srcFilePath: filePath,
      srcLabel: label,
      answerBlocks: [{ blockId, filePath, label }],
      // LLM 顺带生成的答案与问题分开存储（见 KbQuestion.extraAnswer）
      extraAnswer: ans || undefined,
      origin: 'reasoned',
      status: 'kept',
      createdAt,
    })
  })
}

// ---------- 供「问题」标签页（questionView）调用的操作原语 ----------

/** 整体替换问题库（去重应用 / 导入 / 审核结果落地等） */
const applyQuestionBank = (list: KbQuestion[]) => {
  questionBank.value = list || []
  for (const q of questionBank.value) {
    const m = /(\d+)$/.exec(q.id || '')
    if (m) qSeq = Math.max(qSeq, Number(m[1]))
  }
}

/** 手动添加问题（自动补向量；可选外部参考答案与参考切片） */
const addManualQuestion = async (text: string, extraAnswer?: string, answerBlocks?: QuestionAnswerRef[]) => {
  const t = (text || '').trim()
  if (!t) return null as KbQuestion | null
  // 手动问题也可指定参考切片（答案来源）：首个切片补为主来源切片，参与问题增强索引关联
  const first = (answerBlocks || [])[0]
  const q = pushQuestion({
    text: t,
    extraAnswer,
    origin: 'manual',
    status: 'kept',
    answerBlocks: answerBlocks || [],
    srcBlockId: first?.blockId || undefined,
    srcFilePath: first?.filePath || undefined,
    srcLabel: first?.label || undefined,
  }, true)
  try {
    const e = await kbEmbed(t)
    if (e?.[0]) q.qVector = e[0]
  } catch (e) { console.warn('问题向量化失败', e) }
  return q
}

/** 按 id 删除问题 */
const removeQuestionById = (id: string) => {
  const i = questionBank.value.findIndex(q => q.id === id)
  if (i >= 0) questionBank.value.splice(i, 1)
}

/** 更新问题（文本变化时重新向量化） */
const updateQuestionById = async (id: string, patch: Partial<KbQuestion>) => {
  const q = questionBank.value.find(x => x.id === id)
  if (!q) return
  if (patch.text !== undefined && patch.text !== q.text) {
    q.text = patch.text
    try {
      const e = await kbEmbed(q.text)
      q.qVector = e?.[0] || undefined
    } catch (e) { console.warn('问题重新向量化失败', e) }
  }
  Object.assign(q, patch)
}

/** 后台补全缺失问题向量 */
const embedMissingQuestionVectors = async (onMsg?: (msg: string) => void) => {
  const todo = questionBank.value.filter(q => q.status !== 'merged' && q.text && !(q.qVector && q.qVector.length))
  let done = 0
  for (const q of todo) {
    try {
      const e = await kbEmbed(q.text)
      if (e?.[0]) q.qVector = e[0]
    } catch { /* 单条失败继续 */ }
    done++
    onMsg?.(`向量化问题 ${done}/${todo.length}`)
  }
  return done
}

/** 设置页「处理配置」修改嵌入模型：确认后用新模型清空并重新向量化切片与问题（维度不一致会破坏检索，故默认重算） */
const handleEmbedModelChange = async (next: string) => {
    const raw = (next || '').trim()
    // “跟随默认”或留空：解析为当前实际生效的嵌入模型（设置页默认 → Ollama 默认 → nomic）并固化为具体值，
    // 避免在向量生成后默认值再变化导致维度不一致（存储/写入 .kb 的一律是具体模型名）。
    let target = raw
    if (!target) {
        const cfg = kbAi.getProviderConfig(store.AIconfig?.llm, (store.AIconfig?.llm?.type as KbProvider) || 'ollama') || {}
        const ollamaCfg = kbAi.getProviderConfig(store.AIconfig?.llm, 'ollama') || {}
        target = cfg.embed_model || ollamaCfg.embed_model || 'nomic-embed-text:latest'
    }
    const prevM = String(model.value.embed || '')
    if (target === prevM) return
    const zh = store.locales === 'zh'
    const sliceCount = blocks.value.length
    const questionCount = questionBank.value.filter((q: any) => q.status !== 'merged').length
    const hasOldVectors = blocks.value.some((b: any) => b.A_vector && b.A_vector.length)
        || questionBank.value.some((q: any) => q.qVector && q.qVector.length)
    // 已有旧向量 → 需先确认（将清空并重算）；尚无向量 → 直接切换即可
    if (hasOldVectors) {
        try {
            await ElMessageBox.confirm(
                zh
                    ? `将嵌入模型由「${prevM}」切换为「${target}」。\n\n现有切片/问题向量由旧模型生成，切换后需清空并用新模型重新向量化（切片 ${sliceCount} / 问题 ${questionCount}）。是否继续？`
                    : `Switch embedding model from "${prevM}" to "${target}".\n\nExisting slice/question vectors were built with the old model and must be cleared & re-embedded with the new one (${sliceCount} slices / ${questionCount} questions). Continue?`,
                zh ? '切换嵌入模型' : 'Change Embedding Model',
                { confirmButtonText: zh ? '切换并重新向量化' : 'Switch & re-embed', cancelButtonText: zh ? '取消' : 'Cancel', type: 'warning' }
            )
        } catch { return }
    }
    embedPinned.value = true
    model.value.embed = target
    if (!hasOldVectors) {
        kb_state.value = zh ? `嵌入模型已设为「${target}」` : `Embedding model set to "${target}"`
        return
    }
    // 1) 清空旧切片向量
    let clearedSlice = 0
    for (const b of blocks.value) {
        if (b.A_vector && b.A_vector.length) { b.A_vector = []; clearedSlice++ }
    }
    // 2) 清空旧问题向量
    let clearedQuestion = 0
    for (const q of questionBank.value) {
        if (q.status !== 'merged' && q.qVector && q.qVector.length) { q.qVector = undefined; clearedQuestion++ }
    }
    // 3) 用新模型重新向量化切片
    if (clearedSlice > 0) {
        kb_state.value = zh ? `用「${target}」重新向量化切片...` : `Re-embedding ${clearedSlice} slices with "${target}"...`
        await embedBlocks()
    }
    // 4) 用新模型重新向量化问题
    if (clearedQuestion > 0) {
        kb_state.value = zh ? `用「${target}」重新向量化问题...` : `Re-embedding ${clearedQuestion} questions with "${target}"...`
        await embedMissingQuestionVectors()
    }
    kb_state.value = zh
        ? `嵌入模型已切换为「${target}」并完成重新向量化`
        : `Switched to "${target}" and re-embedded`
    scheduleRefreshAtlas(0)
}

/** 问题参考答案文本（外部答案优先，否则聚合答案切片内容） */
const resolveQuestionAnswerText = (q: KbQuestion): string => answerText(q, blocks.value, ' | ')

/** 问题增强索引（供 buildRetrievalContext 注入 dense_score 的问题增强通道） */
const questionVectorsByBlockIndex = () => computeBlockQuestionVectors(questionBank.value)

/** 问题库 → 测试用例派生（testCases 为派生产物：测试页实时反映问题库 kept 问题） */
const syncTestCasesFromBank = (notify = false) => {
  const kept = questionBank.value.filter(q => q.status !== 'merged' && q.text && q.text.trim())
  const MAX = Number(model.value.maxTestCases) || 50
  const use = kept.slice(0, MAX)
  const qs = use.map(q => q.text)
  const as = use.map(q => resolveQuestionAnswerText(q))
  // 关联切片（命中判定基准）：主来源切片 + answerBlocks 各切片 id；测试页按切片身份判定召回
  const refs: TestCaseRef[] = use.map(q => ({
    srcBlockId: q.srcBlockId,
    blockIds: (q.answerBlocks || []).map(r => r.blockId).filter((x): x is string => !!x),
  }))
  const same = JSON.stringify(testCases.value.questions) === JSON.stringify(qs)
    && JSON.stringify(testCases.value.answers) === JSON.stringify(as)
    && JSON.stringify(testCases.value.refs || []) === JSON.stringify(refs)
  if (!same) testCases.value = { questions: qs, answers: as, refs, source: 'bank' }
  if (notify) {
    kb_state.value = store.locales === 'zh'
      ? `测试用例已刷新：${qs.length} 条（上限 ${MAX}${kept.length > MAX ? `，问题库共 ${kept.length} 条` : ''}）`
      : `Test cases refreshed: ${qs.length} (max ${MAX}${kept.length > MAX ? `, ${kept.length} in bank` : ''})`
  }
}
let _deriveTimer: ReturnType<typeof setTimeout> | null = null
const deriveTestCasesFromBank = () => {
  if (_deriveTimer) clearTimeout(_deriveTimer)
  _deriveTimer = setTimeout(() => {
    // 外部导入的独立测试集不跟随问题库自动更新（用户显式点「读取测试用例」才会切回问题库派生）
    if (testCases.value.source === 'external') return
    const bankVectored = questionBank.value.some(q => q.qVector && q.qVector.length)
    const bankTouched = questionBank.value.some(q => q.origin === 'manual' || q.origin === 'imported' || q.origin === 'complex' || !!q.extraAnswer)
    if (testCases.value.questions.length > 0 && !bankVectored && !bankTouched) return
    syncTestCasesFromBank(false)
  }, 350)
}
watch(questionBank, deriveTestCasesFromBank, { deep: true })
/** 手动刷新（测试页「读取测试用例」按钮）：切回问题库来源，忽略自动派生守卫，按当前上限重新从问题库派生测试用例 */
const refreshTestCasesFromBank = () => {
  if (_deriveTimer) { clearTimeout(_deriveTimer); _deriveTimer = null }
  testCases.value.source = 'bank'
  syncTestCasesFromBank(true)
}

// ==================== 问题提取状态管理 ====================
interface ExtractProgress {
    isRunning: boolean
    isPaused: boolean
    currentIndex: number
    totalCount: number
    startTime: number | null
}

const extractProgress = ref<ExtractProgress>({
    isRunning: false,
    isPaused: false,
    currentIndex: 0,
    totalCount: 0,
    startTime: null
})

const saveExtractProgress = () => {
    const progressToSave = {
        currentIndex: extractProgress.value.currentIndex,
        totalCount: extractProgress.value.totalCount,
        startTime: extractProgress.value.startTime
    }
    localStorage.setItem('extractProgress', JSON.stringify(progressToSave))
}

const loadExtractProgress = () => {
    const saved = localStorage.getItem('extractProgress')
    if (saved) {
        try {
            const progress = JSON.parse(saved)
            if (progress.startTime && Date.now() - progress.startTime < 3600000) {
                extractProgress.value.currentIndex = progress.currentIndex
                extractProgress.value.totalCount = progress.totalCount
                extractProgress.value.isPaused = true
                return true
            }
        } catch (e) {}
    }
    return false
}

const clearExtractProgress = () => {
    localStorage.removeItem('extractProgress')
    extractProgress.value = {
        isRunning: false,
        isPaused: false,
        currentIndex: 0,
        totalCount: 0,
        startTime: null
    }
}

const extractProgressPercent = computed(() => {
    if (extractProgress.value.totalCount === 0) return 0
    return Math.round((extractProgress.value.currentIndex / extractProgress.value.totalCount) * 100)
})

const extractProgressText = computed(() => {
    return `提取问题: ${extractProgress.value.currentIndex}/${extractProgress.value.totalCount} (${extractProgressPercent.value}%)`
})

const pauseExtract = () => {
    if (extractProgress.value.isRunning && !extractProgress.value.isPaused) {
        extractProgress.value.isPaused = true
        saveExtractProgress()
        kb_state.value = store.locales === 'zh' ? '问题提取已暂停，点击"继续"按钮恢复' : 'Extraction paused, click "Resume" to continue'
    }
}

// ==================== 本体构建独立状态管理 ====================
interface BuildProgress {
    isRunning: boolean
    isPaused: boolean
    currentBatchIndex: number
    totalBatches: number
    currentFileIndex: number
    totalFiles: number
    currentBatchInFile: number
    totalBatchesInFile: number
    startTime: number | null
    savedOntologyState: {
        entities: any[]
        relations: any[]
        entityToBlocksIndex: any[]
    } | null
}

const buildProgress = ref<BuildProgress>({
    isRunning: false,
    isPaused: false,
    currentBatchIndex: 0,
    totalBatches: 0,
    currentFileIndex: 0,
    totalFiles: 0,
    currentBatchInFile: 0,
    totalBatchesInFile: 0,
    startTime: null,
    savedOntologyState: null
})

// 本体构建在底部状态栏（prep-status-panel）中的步骤索引（null = 未显示）；手动/按钮触发构建时用于展示进度，自动构建 ensureOntology 自行管理步骤
let ontologyStepIdx: number | null = null

const saveBuildProgress = () => {
    const ontologyState = {
        entities: Array.from(globalEntities.value.entries()).map(([key, entity]) => ({
            key: key,
            id: entity.id,
            name: entity.name,
            type: entity.type,
            nodeType: entity.nodeType,
            layer: entity.layer,
            description: entity.description,
            associatedBlocks: entity.associatedBlocks,
            associatedFiles: entity.associatedFiles
        })),
        relations: Array.from(globalRelations.value.entries()).map(([key, relation]) => ({
            key: key,
            id: relation.id,
            source: relation.source,
            target: relation.target,
            type: relation.type,
            layer: relation.layer,
            description: relation.description,
            sourceBlocks: relation.sourceBlocks
        })),
        entityToBlocksIndex: Array.from(entityToBlocksIndex.value.entries()).map(([entityName, blockIds]) => ({
            entityName: entityName,
            blockIds: Array.from(blockIds)
        }))
    }
    
    const progressToSave = {
        currentBatchIndex: buildProgress.value.currentBatchIndex,
        totalBatches: buildProgress.value.totalBatches,
        currentFileIndex: buildProgress.value.currentFileIndex,
        totalFiles: buildProgress.value.totalFiles,
        currentBatchInFile: buildProgress.value.currentBatchInFile,
        totalBatchesInFile: buildProgress.value.totalBatchesInFile,
        startTime: buildProgress.value.startTime,
        savedOntologyState: ontologyState
    }
    localStorage.setItem('buildProgressV3', JSON.stringify(progressToSave))
}

const loadBuildProgress = () => {
    const saved = localStorage.getItem('buildProgressV3')
    if (saved) {
        try {
            const progress = JSON.parse(saved)
            if (progress.startTime && Date.now() - progress.startTime < 3600000) {
                buildProgress.value.currentBatchIndex = progress.currentBatchIndex
                buildProgress.value.totalBatches = progress.totalBatches
                buildProgress.value.currentFileIndex = progress.currentFileIndex
                buildProgress.value.totalFiles = progress.totalFiles
                buildProgress.value.currentBatchInFile = progress.currentBatchInFile
                buildProgress.value.totalBatchesInFile = progress.totalBatchesInFile
                buildProgress.value.isPaused = true
                buildProgress.value.savedOntologyState = progress.savedOntologyState
                return true
            }
        } catch (e) {}
    }
    return false
}

const clearBuildProgress = () => {
    localStorage.removeItem('buildProgressV3')
    buildProgress.value = {
        isRunning: false,
        isPaused: false,
        currentBatchIndex: 0,
        totalBatches: 0,
        currentFileIndex: 0,
        totalFiles: 0,
        currentBatchInFile: 0,
        totalBatchesInFile: 0,
        startTime: null,
        savedOntologyState: null
    }
}

const buildProgressPercent = computed(() => {
    if (buildProgress.value.totalBatches === 0) return 0
    return Math.round((buildProgress.value.currentBatchIndex / buildProgress.value.totalBatches) * 100)
})

const buildProgressText = computed(() => {
    return `构建本体: ${buildProgress.value.currentBatchIndex}/${buildProgress.value.totalBatches} (${buildProgressPercent.value}%)`
})

const pauseBuildOntology = () => {
    if (buildProgress.value.isRunning && !buildProgress.value.isPaused) {
        buildProgress.value.isPaused = true
        saveBuildProgress()
        kb_state.value = store.locales === 'zh' ? '本体构建已暂停，点击"继续"按钮恢复' : 'Ontology building paused, click "Resume" to continue'
        if (ontologyStepIdx != null) setPrepStep(ontologyStepIdx, 'pending', store.locales === 'zh' ? '已暂停' : 'Paused')
    }
}

const stopBuildOntology = () => {
    buildProgress.value.isRunning = false
    buildProgress.value.isPaused = false
    clearBuildProgress()
    kb_state.value = store.locales === 'zh' ? '本体构建已停止' : 'Ontology building stopped'
    if (ontologyStepIdx != null) setPrepStep(ontologyStepIdx, 'error', store.locales === 'zh' ? '已停止' : 'Stopped')
    ontologyStepIdx = null
}

const setOntologyBatchSize = (size: number) => {
    model.value.ontologyBatchSize = Math.max(1, Math.min(50, size))
}

async function getModel(){
    const spec = buildKbSpec()
    try {
        const names = await kbAi.listModels(spec)
        if (names && names.length) {
            // 统一为 {name} 结构（兼容 configManager 的下拉渲染）
            model.value.list = names.map(name => ({ name }))
            // 模型列表加载后，自动恢复/设置嵌入模型
            autoSetEmbedModel()
            // 若对话/处理模型为空，回填第一个非嵌入模型（避免空 model 调用报 "model not found"）
            const nonEmbed = model.value.list.find((m: any) => !/embed|embedding/i.test(m.name || ''))
            if (!model.value.chat && nonEmbed) model.value.chat = nonEmbed.name
            if (!model.value.process && nonEmbed) model.value.process = nonEmbed.name
            // 同步回 store（仅当 store 中该来源尚未选择模型），便于其它模块复用
            const llmCfg = store.AIconfig?.llm
            const providerCfg = kbAi.getProviderConfig(llmCfg, spec.llmType)
            if (providerCfg && 'model' in providerCfg && !providerCfg.model && nonEmbed) {
                if (spec.llmType === 'custom' && llmCfg?.custom) {
                    // custom：getProviderConfig 返回合并副本，需写回权威来源对象（sources[activeIndex]）
                    const srcs = Array.isArray(llmCfg.custom.sources) ? llmCfg.custom.sources : []
                    const src = srcs[llmCfg.custom.activeIndex]
                    if (src) {
                        src.model = nonEmbed.name
                        if (!llmCfg.custom.model) llmCfg.custom.model = nonEmbed.name
                    }
                } else if (providerCfg) {
                    providerCfg.model = nonEmbed.name
                }
                store.saveConfig()
            }
        }
    } catch (error) {
        console.error('Fetch error:', error);
        kb_state.value = store.locales === 'zh'
            ? `${kbAi.KB_PROVIDER_LABELS[spec.llmType]?.zh || spec.llmType} 未在运行或配置错误`
            : `${spec.llmType} is not running or misconfigured`
    }
}

// 自动设置嵌入模型：若当前值无效，从列表中选取第一个匹配的嵌入模型
function autoSetEmbedModel() {
    if (!model.value.list || model.value.list.length === 0) return
    // 已被 .kb 或处理配置显式锁定：不自动改选，保证与已存向量维度一致
    if (embedPinned.value) return
    const embedPattern = /^(bge|text-embedding|ada-embedding|instructor|e5|gte|m3e)|embed|embedding/i
    const embedModels = model.value.list.filter((m: any) => embedPattern.test(m.name || ''))
    if (embedModels.length === 0) return

    // 1) 若当前 embed 值在列表中有效（已加载 .kb 的嵌入模型 或 已有效选择），保持不变
    const currentEmbed = model.value.embed
    if (currentEmbed && embedModels.some((m: any) => m.name === currentEmbed)) return

    // 2) 优先使用全局 AI 配置中该来源的默认嵌入模型（set.vue 中配置）
    const cfg = kbAi.getProviderConfig(store.AIconfig.llm, store.AIconfig.llm.type) || {}
    if (cfg.embed_model && embedModels.some((m: any) => m.name === cfg.embed_model)) {
        model.value.embed = cfg.embed_model
        return
    }

    // 3) 若 localStorage 中有之前保存的嵌入模型名且可用，使用它
    const savedEmbed = localStorage.getItem('knowrag_embed_model')
    if (savedEmbed && embedModels.some((m: any) => m.name === savedEmbed)) {
        model.value.embed = savedEmbed
        return
    }

    // 4) 否则选取第一个嵌入模型
    model.value.embed = embedModels[0].name
}

// 监听嵌入模型变化，持久化到 localStorage
watch(() => model.value.embed, (val) => {
    if (val) localStorage.setItem('knowrag_embed_model', val)
})

async function loadFolderFiles(rootPath?: string, switchToFile = true) {
    if (switchToFile) viewMode.value = 'file'
    isKbLoaded.value = false
    // 打开/切换文件夹（自动知识库模式）：解除嵌入模型锁定，恢复「跟随设置页默认嵌入模型」
    embedPinned.value = false
    files.value = []
    previewContent.value = ''
    documents.value = [{name: '全部'}]
    documentName.value = '全部'
    blocks.value = []
    questionBank.value = []
    fileSummaries.value.clear()
    resetScrollLoad()
    clearExtractProgress()
    clearBuildProgress()

    const root = rootPath || store.root
    if (!root) {
        kb_state.value = '未选择文件夹'
        return
    }

    const result = await window.ipcRenderer.invoke('getFilesRelation', root, 3)
    if (!result || !result.fileList) {
        kb_state.value = '获取文件列表失败'
        return
    }

    const fileList = result.fileList.filter((f: any) => 
        f.type === 'file' && !isKbSidecarFile(f.path)
    )

    files.value = fileList.map((f: any) => ({
        label: f.label,
        path: f.path,
        extension: f.extension,
        size: f.size || 0,
        mtime: f.mtime || 0,
        content: '',
        attributes: f.attributes || {}
    }))

    for (const f of files.value) {
        // 仅 Markdown 文档进入切片视图的文档下拉（切片只针对 .md）
        if ((f.extension || '').toLowerCase() !== '.md') continue
        const name = f.label && f.label.lastIndexOf('.') > 0 ? f.label.substring(0, f.label.lastIndexOf('.')) : f.label
        documents.value.push({ name })
    }

    for (let i = 0; i < files.value.length; i++) {
        try {
            const file = files.value[i]
            const ext = file.extension?.toLowerCase()
            
            if (isPdfFile(ext)) {
                file.content = '[PDF文件 - 使用预览功能查看]'
                continue
            }
            if (isImageFile(ext)) {
                file.content = store.locales == 'zh' ? '[图片文件 - 不参与切片]' : '[Image file - not sliced]'
                continue
            }
            if (isMediaFile(ext)) {
                file.content = store.locales == 'zh' ? '[音视频文件 - 不参与切片]' : '[Media file - not sliced]'
                continue
            }
            
            if (isWordFile(ext)) {
                const result = await window.ipcRenderer.invoke('readFile', file.path)
                
                if (typeof result === 'object' && result !== null) {
                    if (result.success === false) {
                        file.content = result.content || `[Word文档读取失败]`
                    } else {
                        file.content = result.content || ''
                    }
                } else {
                    file.content = result ?? ''
                }
                
                extractFileSummary(file)
                continue
            }
            
            const content = await window.ipcRenderer.invoke('readFile', file.path)
            file.content = content ?? ''
            
            extractFileSummary(file)
        } catch (err) {
            const errorMessage = getErrorMessage(err)
            console.error('读取文件内容失败', files.value[i].path, errorMessage)
            
            if (isPdfFile(files.value[i].extension)) {
                files.value[i].content = '[PDF文件 - 预览时加载]'
            } else if (isWordFile(files.value[i].extension)) {
                files.value[i].content = store.locales == 'zh' ? 
                    `[Word文档读取失败: ${errorMessage}]` : 
                    `[Word document read failed: ${errorMessage}]`
            } else {
                files.value[i].content = store.locales == 'zh' ? 
                    `读取失败: ${errorMessage}` : 
                    `Read failed: ${errorMessage}`
            }
        }
    }

    if (files.value.length > 0) {
        if (isPdfFile(files.value[0].extension)) {
            previewContent.value = store.locales == 'zh' ? 
                'PDF文件 - 使用右侧预览功能查看内容' : 
                'PDF file - Use the preview function on the right to view content'
        } else {
            previewContent.value = stripFrontmatter(files.value[0].content || '')
        }
        selectedFileIndex.value = 0
    }

    // 扫描 PDF/Word 文件的规范化状态（是否有同名 .md 文档）
    scanNormalizeStatus()
    // 扫描文件摘要状态（刚加载/重载文件夹后刷新；未切片时 total 为 0，摘要提示栏不显示）
    scanSummaryStatus()
    // 文件列表就绪后检测一次文件变更（刷新文件行徽标）
    scheduleFileViewChangeCheck()

    await scanKnowledgeBases()
    return files.value
}

function extractFileSummary(file: any) {
    if (!file.content || typeof file.content !== 'string') return
    
    const yamlMatch = file.content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/)
    if (yamlMatch) {
        const yamlContent = yamlMatch[1]
        const summaryMatch = yamlContent.match(/^(摘要|summary|abstract):\s*(.+)$/mi)
        if (summaryMatch && summaryMatch[2]) {
            const summary = summaryMatch[2].trim()
            fileSummaries.value.set(file.path, {
                content: summary,
                vector: null
            })
            return
        }
    }
    
    if (file.attributes && (file.attributes.summary || file.attributes.摘要 || file.attributes.abstract)) {
        const summary = file.attributes.summary || file.attributes.摘要 || file.attributes.abstract
        fileSummaries.value.set(file.path, {
            content: summary.toString().trim(),
            vector: null
        })
    }
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message
    } else if (typeof error === 'string') {
        return error
    } else if (error && typeof error === 'object' && 'message' in error) {
        return String((error as any).message)
    } else {
        return '未知错误'
    }
}

/** 清洗 LLM 输出的 JSON 文本（处理非法转义/控制字符），使其可被 JSON.parse */
function cleanLlmJson(raw: string): string {
    // 1. 去除不可见控制字符（除 \t \r \n）
    let s = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    // 2. 修复 \u{...}（ES6 码点转义，JSON 不支持）→ 还原字符
    s = s.replace(/\\u\{([0-9a-fA-F]+)\}/g, (_: string, hex: string) => {
        try { return String.fromCodePoint(parseInt(hex, 16)) } catch { return '' }
    })
    // 3. 修复非法 \uXXXX（\u 后不足 4 位十六进制或非十六进制）
    s = s.replace(/\\(?=u[^0-9a-fA-F]|u[0-9a-fA-F]{0,3}[^0-9a-fA-F])/g, '\\\\')
    // 4. 修复 C 风格 \xNN → 还原为字符
    s = s.replace(/\\x([0-9a-fA-F]{2})/g, (_: string, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    // 5. 修复其它非法转义：\ 后跟非 JSON 合法转义字符 → 保留为字面量（双写）
    s = s.replace(/\\(?!["\\\\\/bfnrtu]|u[0-9a-fA-F]{4})/g, '\\\\')
    return s
}

/** 从 LLM 输出中安全解析 JSON（提取首个 {...} 块，多重清洗 + 兜底），失败返回 null */
function safeParseLlmJson(content: string): any {
    if (!content) return null
    const m = content.match(/\{[\s\S]*\}/)
    if (!m) return null
    const cleaned = cleanLlmJson(m[0])
    try { return JSON.parse(cleaned) } catch {
        // 激进兜底：剥离所有转义反斜杠
        try { return JSON.parse(cleaned.replace(/\\(.)/g, '$1')) } catch { return null }
    }
}

const openFolder = async function() {
    try {
        const picked = await window.ipcRenderer.invoke('openFolderDialog')
        if (!picked) {
            kb_state.value = '未选择文件夹'
            return
        }

        // 注册为工作区并设为当前工作区
        store.addRoot(picked)

        await loadFolderFiles(store.root)
        await loadKnowledgeBases()
    } catch (error) {
        console.error('打开文件夹失败', error)
        kb_state.value = '打开文件夹失败'
    }
}

const sliceOnly = async function(noSwitch?: boolean, onProgress?: (detail: string) => void) {
    // 后台任务（路线图 2.4）：知识库构建注册为 kb-build job，进度实时上报
    let kbJob: string | null = null
    try {
        if (window.dsh?.jobs?.start) {
            const j = await window.dsh.jobs.start('kb-build', 'kb-build', store.locales === 'zh' ? '知识库切片' : 'KB Slicing')
            kbJob = j.id
        }
    } catch { /* 无桌面环境时忽略 */ }
    try {
        let { fileList } = await window.ipcRenderer.invoke("getFilesRelation", store.root, 3);
        
        files.value = fileList
            .filter((obj: any) => obj.type === 'file' && !isKbSidecarFile(obj.path))
            .map((obj: any, index: number) => {
                return { ...obj };
            });
        // 扫描 PDF/Word 文件的规范化状态
        scanNormalizeStatus()
        kb_state.value = "读取到" + files.value.length + "个文件。正在处理...";
        isKbLoaded.value = false
        documents.value = [{name:'全部'}];
        // 备份现有切片，用于增量复用向量（必须在清空前构建）
        const existingBlocksByPath = new Map<string, any[]>()
        for (const b of blocks.value) {
            if (!existingBlocksByPath.has(b.filePath)) existingBlocksByPath.set(b.filePath, [])
            existingBlocksByPath.get(b.filePath)!.push(b)
        }
        blocks.value = [];
        questionBank.value = [];
        fileSummaries.value.clear();
        resetScrollLoad();
        clearExtractProgress();
        clearBuildProgress();
        
        for (let i = 0; i < files.value.length; i++) {
            try {
                // 仅对 Markdown 文档进行切片，其他格式（PDF/Word/图片/txt 等）跳过
                if ((files.value[i].extension || '').toLowerCase() !== '.md') {
                    continue
                }
                let result = await window.ipcRenderer.invoke('readFile', files.value[i].path);
                
                let fileContent = result;
                if (typeof result === 'object' && result !== null) {
                    if (result.success === false) {
                        kb_state.value = `文件 ${files.value[i].label} 读取失败: ${result.error}`;
                        continue;
                    }
                    fileContent = result.content || '';
                }
                
                if (fileContent != undefined) {
                    files.value[i].content = fileContent;
                    extractFileSummary(files.value[i]);
                    documents.value.push({
                        name: files.value[i].label.substring(0, files.value[i].label.lastIndexOf('.')),
                    });
                    
                    let contentWithoutYaml = stripFrontmatter(fileContent);
                    
                    let block = [];
                    let strategyLabel = '标识符'
                    
                    if (model.value.sliceStrategy === '智能') {
                        block = splitByHeadings(contentWithoutYaml);
                        strategyLabel = '智能'
                        kb_state.value = `文件 ${files.value[i].label} 使用智能策略，识别到 ${block.length} 个一级标题段落`;
                    } else if (model.value.sliceStrategy === '语义') {
                        try {
                            block = await semanticSplitText(
                                contentWithoutYaml,
                                async (texts: string[]) => {
                                    const embs = await kbEmbed(texts)
                                    if (!embs || embs.length !== texts.length) {
                                        throw new Error("向量化处理错误，请检查嵌入模型。")
                                    }
                                    return embs
                                },
                                model.value.sliceMaxChars,
                                model.value.semanticSplitThreshold,
                            )
                            strategyLabel = '语义'
                            kb_state.value = `文件 ${files.value[i].label} 使用语义策略，识别到 ${block.length} 个主题片段`;
                        } catch (semanticError) {
                            console.warn('语义切分失败，回退到标识符切分:', semanticError)
                            block = contentWithoutYaml.split(/(?:\r?\n){3,}/);
                            strategyLabel = '标识符'
                            kb_state.value = `文件 ${files.value[i].label} 语义切分失败，回退到标识符策略`;
                        }
                    } else {
                        block = contentWithoutYaml.split(/(?:\r?\n){3,}/);
                        strategyLabel = '标识符'
                        kb_state.value = `文件 ${files.value[i].label} 使用标识符策略，切分为 ${block.length} 个段落`;
                    }
                    
                    block = block.filter((para: string) => para.trim().length > 0);
                    // 第二步：应用大小上限 + 相邻重叠（overlap 仅用于向量化，不改变展示原文）
                    const sliced = applyOverlapAndLimit(block, model.value.sliceMaxChars, model.value.sliceOverlapChars);
                    
                    const procMsg = "读取到" + files.value.length + "个文件，正在切分第" + (i + 1) + "个文件并向量化。";
                    kb_state.value = procMsg;
                    onProgress?.(procMsg);
                    
                    if (sliced.length > 0) {
                        try {
                            const filePath = files.value[i].path;

                            // 第三步：幂等增量 —— 复用未变化切片的向量
                            const existingHashToBlock = new Map<string, any>();
                            const existingFileBlocks = existingBlocksByPath.get(filePath) || [];
                            for (const eb of existingFileBlocks) {
                                if (eb.contentHash) existingHashToBlock.set(eb.contentHash, eb);
                            }

                            const toEmbedSlices: { text: string; overlapText: string }[] = [];
                            let reusedCount = 0;

                            for (const s of sliced) {
                                const hash = hashContent(s.text);
                                const prev = existingHashToBlock.get(hash);
                                if (prev) {
                                    // 内容未变化：复用切片/推理状态，保留原 id 以维持本体关联
                                    blocks.value.push({
                                        id: prev.id,
                                        filePath: filePath,
                                        label: files.value[i].label.substring(0, files.value[i].label.lastIndexOf('.')),
                                        path: filePath,
                                        extension: files.value[i].extension,
                                        A: s.text,
                                        A_overlap: s.overlapText,
                                        A_vector: prev.A_vector,
                                        Q: prev.Q || '问题未推理',
                                        Q_vector: prev.Q_vector || [],
                                        p: 0,
                                        state: false,
                                        show: 'A',
                                        contentHash: hash,
                                    });
                                    reusedCount++;
                                    scheduleRefreshAtlas(120);
                                } else {
                                    toEmbedSlices.push(s);
                                }
                            }

                            // 第四步：新切片暂不向量化（由"向量化"按钮统一生成嵌入）

                            for (let bi = 0; bi < toEmbedSlices.length; bi++) {
                                const s = toEmbedSlices[bi];
                                blocks.value.push({
                                    id: shortId('block'),
                                    filePath: filePath,
                                    label: files.value[i].label.substring(0, files.value[i].label.lastIndexOf('.')),
                                    path: filePath,
                                    extension: files.value[i].extension,
                                    A: s.text,
                                    A_overlap: s.overlapText,
                                    A_vector: [],
                                    Q: '问题未推理',
                                    Q_vector: [],
                                    p: 0,
                                    state: false,
                                    show: 'A',
                                    contentHash: hashContent(s.text),
                                });
                                scheduleRefreshAtlas(120);
                            }

                            if (reusedCount > 0) {
                                kb_state.value = `文件 ${files.value[i].label}(${strategyLabel})：复用 ${reusedCount} 个切片，新增 ${toEmbedSlices.length} 个待向量化`;
                            }
                        } catch (embedError) {
                            console.error("向量化处理失败:", embedError);
                            kb_state.value = `文件 ${files.value[i].label} 向量化失败`;
                            continue;
                        }
                    } else {
                        kb_state.value = `文件 ${files.value[i].label} 没有可切片的内容`;
                    }
                }
            } catch (fileError) {
                console.error("文件读取失败:", fileError);
                kb_state.value = `文件 ${files.value[i].label} 读取失败`;
                continue;
            }
            // 实时进度：已处理文件数 + 累计切片数
            if (onProgress) {
                const processed = i + 1
                const totalMd = files.value.filter((f: any) => (f.extension || '').toLowerCase() === '.md').length
                onProgress?.(store.locales === 'zh'
                    ? `正在处理 ${processed}/${totalMd} 个文件，已生成 ${blocks.value.length} 个切片...`
                    : `Processing ${processed}/${totalMd} files, ${blocks.value.length} slices so far...`)
            }
            // 任务进度（路线图 2.4）：按已处理文件数上报
            if (kbJob && window.dsh?.jobs?.progress) {
                try {
                    const done = files.value.filter((f: any) => (f.extension || '').toLowerCase() === '.md').length
                    const pct = done > 0 ? Math.min(99, Math.round(((i + 1) / done) * 100)) : null
                    window.dsh.jobs.progress(kbJob, pct, `处理文件 ${i + 1}/${files.value.length}`)
                } catch { /* 忽略 */ }
            }
        }
        kb_state.value = store.locales === 'zh' ? `切片完成：共 ${blocks.value.length} 个切片，点击向量化按钮生成嵌入` : `Slicing done: ${blocks.value.length} slices, click embed to vectorize`;
        // 切片完成后刷新摘要状态（blocks 已就绪，可判断哪些已切片文档缺少摘要）
        scanSummaryStatus();
        
        if (!noSwitch) viewMode.value = 'slice'
        if (kbJob && window.dsh?.jobs?.complete) {
            try { window.dsh.jobs.complete(kbJob, { slices: blocks.value.length }) } catch { /* 忽略 */ }
        }
    } catch (globalError) {
        console.error("处理过程中发生全局错误:", globalError);
        kb_state.value = `处理失败`;
        if (kbJob && window.dsh?.jobs?.fail) {
            try { window.dsh.jobs.fail(kbJob, `处理失败: ${(globalError as any)?.message || globalError}`) } catch { /* 忽略 */ }
        }
    }
}

// ==================== 向量化阶段（与切片分离） ====================
// 已切片且已向量化的切片数
const embeddedCount = computed(() => {
    return blocks.value.filter((b: any) => b.A_vector && b.A_vector.length > 0).length
})
// 切片阶段是否完成（存在切片数据）
const isSliced = computed(() => blocks.value.length > 0)
// 向量化阶段是否完成（所有切片都已向量化）
const isEmbedded = computed(() => {
    return blocks.value.length > 0 && blocks.value.every((b: any) => b.A_vector && b.A_vector.length > 0)
})

// 知识库概况（底部状态栏左侧始终显示：文件/切片/增强/本体/社区，精简为图标+数量，完整说明放 title）
const prepStatusItems = computed(() => {
    const fileCount = files.value.length
    const zh = store.locales == 'zh'
    const embeddedCount = blocks.value.filter((b: any) => b.A_vector && b.A_vector.length > 0).length
    const items: { icon: string; status: string; text: string; title: string }[] = []
    // 文件数
    items.push({
        icon: 'fa-folder-open-o',
        status: fileCount > 0 ? 'done' : 'pending',
        text: zh ? `文件 ${fileCount}` : `Files ${fileCount}`,
        title: zh ? `知识库文件：${fileCount} 个` : `KB files: ${fileCount}`,
    })
    // 切片 / 向量化
    if (!isSliced.value) {
        items.push({ icon: 'fa-file-text-o', status: 'pending', text: zh ? '未切片' : 'Unsliced', title: zh ? `已加载 ${fileCount} 个文件，提问时将自动切片/向量化` : `Loaded ${fileCount} files, will auto slice/embed on ask` })
    } else if (!isEmbedded.value) {
        items.push({ icon: 'fa-file-text-o', status: 'pending', text: zh ? `切片 ${blocks.value.length}` : `Slices ${blocks.value.length}`, title: zh ? `已切片 ${blocks.value.length} 个，已向量化 ${embeddedCount}，尚有切片未向量化` : `Sliced ${blocks.value.length} (${embeddedCount} embedded), some not embedded yet` })
    } else {
        items.push({ icon: 'fa-file-text-o', status: 'done', text: zh ? `切片 ${blocks.value.length}` : `Slices ${blocks.value.length}`, title: zh ? `已就绪：${fileCount} 个文件 / ${blocks.value.length} 个切片已向量化` : `Ready: ${fileCount} files / ${blocks.value.length} blocks embedded` })
    }
    // 问题库（问题数；活动问题 = 未合并且有文本）
    const activeQuestions = questionBank.value.filter((q: any) => q.status !== 'merged' && q.text)
    const reasonedTotal = activeQuestions.filter((q: any) => q.origin === 'reasoned').length
    const questionTotal = activeQuestions.length
    items.push({
        icon: 'fa-question-circle-o',
        status: questionTotal > 0 ? 'done' : 'pending',
        text: zh ? `问题 ${questionTotal}` : `Questions ${questionTotal}`,
        title: questionTotal > 0
            ? (zh ? `问题库：${questionTotal} 个问题（推理 ${reasonedTotal}，手动/导入 ${questionTotal - reasonedTotal}）` : `Question bank: ${questionTotal} (reasoned ${reasonedTotal}, manual/imported ${questionTotal - reasonedTotal})`)
            : (zh ? '问题库：尚未提取问题（可在「问题」页提取）' : 'Question bank: no questions yet (extract in Questions tab)'),
    })
    // 独立性评审：进行中/结果状态（常驻显示，不随 kb_state 6s 自动清除）
    if (questionReviewStatus.value) {
        items.push({
            icon: 'fa-balance-scale',
            status: questionReviewRunning.value ? 'running' : 'done',
            text: questionReviewStatus.value,
            title: questionReviewRunning.value
                ? (zh ? '独立性评审进行中…' : 'Independence review running…')
                : (zh ? '独立性评审结果（持续显示，直到下次评审或离开问题页）' : 'Independence review result (persists until next review or leaving the tab)'),
        })
    }
    // 独立性评审：不合适项计数（会话内，来自问题页评审标记）
    if (questionBadCount.value > 0) {
        items.push({
            icon: 'fa-exclamation-triangle',
            status: 'error',
            text: zh ? `不合适 ${questionBadCount.value}` : `Bad ${questionBadCount.value}`,
            title: zh ? `独立性评审：${questionBadCount.value} 个问题不适合独立作答（已在问题列表中标红；可在「问题」页清除评审标记）` : `Independence review: ${questionBadCount.value} unsuitable (marked red in the question list; clear marks in the Questions tab)`,
        })
    }
    // 本体（实体/关系）
    const entityCount = globalEntities.value.size
    const relationCount = globalRelations.value.size
    items.push({
        icon: 'fa-eercast',
        status: entityCount > 0 ? 'done' : 'pending',
        text: zh ? `本体 ${entityCount}/${relationCount}` : `Onto ${entityCount}/${relationCount}`,
        title: entityCount > 0
            ? (zh ? `本体：${entityCount} 个实体 / ${relationCount} 个关系` : `Ontology: ${entityCount} entities / ${relationCount} relations`)
            : (zh ? '本体：未构建' : 'Ontology: not built'),
    })
    // 社区 / 报告
    const commCount = communityResult.value?.count || 0
    const reportCount = communityReports.value.length
    items.push({
        icon: 'fa-sitemap',
        status: commCount > 0 ? 'done' : 'pending',
        text: zh ? `社区 ${commCount}` : `Comm ${commCount}`,
        title: commCount > 0
            ? (zh ? `社区：${commCount} 个` + (reportCount ? `，${reportCount} 份报告` : '') : `Communities: ${commCount}` + (reportCount ? `, ${reportCount} reports` : ''))
            : (zh ? '社区：未检测' : 'Communities: not detected'),
    })
    return items
})

// 向量化：对未向量化的切片批量嵌入
const embedBlocks = async function(onProgress?: (detail: string) => void) {
    if (blocks.value.length === 0) {
        kb_state.value = store.locales === 'zh' ? '没有切片数据，请先切片' : 'No slices, please slice first'
        return
    }

    const toEmbed: { index: number; text: string }[] = []
    for (let i = 0; i < blocks.value.length; i++) {
        const b = blocks.value[i]
        if (!b.A_vector || b.A_vector.length === 0) {
            toEmbed.push({ index: i, text: b.A_overlap || b.A })
        }
    }

    if (toEmbed.length === 0) {
        kb_state.value = store.locales === 'zh' ? '所有切片均已向量化' : 'All slices already embedded'
        return
    }

    kb_state.value = store.locales === 'zh' ? `正在向量化 ${toEmbed.length} 个切片...` : `Embedding ${toEmbed.length} slices...`
    const BATCH = 10
    for (let start = 0; start < toEmbed.length; start += BATCH) {
        const batch = toEmbed.slice(start, start + BATCH)
        try {
            const embeddings = await kbEmbed(batch.map(x => x.text))
            if (!embeddings || embeddings.length !== batch.length) {
                throw new Error("向量化处理错误，请检查嵌入模型。");
            }
            for (let j = 0; j < batch.length; j++) {
                blocks.value[batch[j].index].A_vector = embeddings[j]
            }
            const done = Math.min(start + BATCH, toEmbed.length)
            const embedMsg = store.locales === 'zh' ? `已向量化 ${done}/${toEmbed.length} 个切片` : `Embedded ${done}/${toEmbed.length} slices`
            kb_state.value = embedMsg
            onProgress?.(embedMsg)
            scheduleRefreshAtlas(120)
        } catch (embedError) {
            console.error("向量化处理失败:", embedError);
            kb_state.value = `向量化失败: ${embedError}`
            return
        }
    }
    kb_state.value = store.locales === 'zh' ? `向量化完成：共 ${toEmbed.length} 个切片` : `Embedding done: ${toEmbed.length} slices`
}

// ==================== 自动准备知识库（提问前自动切片/向量化） ====================
// 自动预处理状态：在问答区域下方实时显示执行状态
const prepState = reactive({
    active: false,
    steps: [] as { step: string; status: 'pending' | 'running' | 'done' | 'error'; detail: string }[]
})

const resetPrepState = () => {
    prepState.active = false
    prepState.steps = []
}

const setPrepStep = (index: number, status: 'pending' | 'running' | 'done' | 'error', detail: string) => {
    if (prepState.steps[index]) {
        prepState.steps[index].status = status
        prepState.steps[index].detail = detail
    }
}

// 向状态栏追加一个步骤（供自动构建本体等使用），返回步骤索引
const prepPushStep = (step: string): number => {
    prepState.steps.push({ step, status: 'running', detail: '' })
    return prepState.steps.length - 1
}

// 右侧行为状态：只显示最新一条（进行中步骤 > 实时状态 > 一般提示 > 最近完成步骤；避免 kbPanelMsg 与步骤/去重进度重复堆叠）
const latestBehavior = computed<{ status: string; icon: string; text: string; detail?: string } | null>(() => {
    const zh = store.locales == 'zh'
    // 1) 自动处理问题去重/合并进度（进行中的长任务，最优先）
    if (dedupProgress.value) {
        return {
            status: 'running',
            icon: 'fa-spinner fa-spin',
            text: zh
                ? (dedupProgress.value.current > 0
                    ? `自动处理：正在复核第 ${dedupProgress.value.current}/${dedupProgress.value.total} 个问题`
                    : `自动处理：正在嵌入 ${dedupProgress.value.total} 个问题向量...`)
                : (dedupProgress.value.current > 0
                    ? `Processing: reviewing ${dedupProgress.value.current}/${dedupProgress.value.total}`
                    : `Processing: embedding ${dedupProgress.value.total} questions...`),
            detail: zh
                ? `对比 ${dedupProgress.value.compared} 个 · 重复 ${dedupProgress.value.dupCount} 个` + (dedupProgress.value.mergedCount ? ` · 合并答案 ${dedupProgress.value.mergedCount} 段` : '')
                : `compared ${dedupProgress.value.compared} · dups ${dedupProgress.value.dupCount}` + (dedupProgress.value.mergedCount ? ` · merged ${dedupProgress.value.mergedCount}` : ''),
        }
    }
    const stepIcon = (status: string) => status === 'running' ? 'fa-spinner fa-spin' : status === 'done' ? 'fa-check-circle' : status === 'error' ? 'fa-exclamation-circle' : 'fa-clock-o'
    // 2) 进行中的准备/增量步骤（正在干什么，最新进度）
    const runningStep = [...prepState.steps].reverse().find(x => x.status === 'running')
    if (runningStep) {
        return { status: runningStep.status, icon: stepIcon(runningStep.status), text: runningStep.step, detail: runningStep.detail || undefined }
    }
    // 3) 实时状态（检索测试/批测进度等）
    if (kbLiveState.value) {
        return { status: kbLiveStateClass.value, icon: kbLiveStateIcon.value, text: kbLiveState.value }
    }
    // 4) 一般状态提示（kb_state 等，6s 自动清除）
    if (kbPanelMsg.value) {
        return { status: kbPanelStepClass.value, icon: kbPanelStepIcon.value, text: kbPanelMsg.value }
    }
    // 5) 无进行中/提示时：显示最近完成/出错的步骤作为摘要
    if (prepState.steps.length > 0) {
        const s = prepState.steps[prepState.steps.length - 1]
        return { status: s.status, icon: stepIcon(s.status), text: s.step, detail: s.detail || undefined }
    }
    return null
})

/** 是否有未完成的处理进度（问题提取 / 本体构建），决定状态栏是否显示"继续"图标 */
const hasUnfinishedProgress = computed(() => {
    return extractProgress.value.isPaused || buildProgress.value.isPaused
})

/** 继续未完成的处理（优先问题提取，其次本体构建） */
const continuePendingWork = async () => {
    if (extractProgress.value.isPaused) {
        await continueExtract()
    } else if (buildProgress.value.isPaused) {
        await continueBuildOntology()
    }
}

/**
 * 提问前确保知识库已切片/向量化：
 * - 未切片时自动执行 sliceOnly()
 * - 切片后仍有未向量化切片时自动执行 embedBlocks()
 * - 全程在问答下方显示执行状态，就绪后返回 true 继续提问
 */
const ensureKbReady = async (): Promise<boolean> => {
    // 已就绪（已切片且已向量化）直接通过，不打扰用户
    if (isSliced.value && isEmbedded.value) return true

    // 自动准备进行中：避免并发切片/向量化导致状态错乱
    if (prepState.active) {
        ElMessage.info(store.locales == 'zh' ? '正在自动准备知识库，请稍候...' : 'Auto-preparing KB, please wait...')
        return false
    }

    // 未选择文件夹无法自动切片
    if (!store.root) {
        ElMessage.warning(store.locales == 'zh' ? '请先选择知识库文件夹' : 'Please select a knowledge base folder first')
        return false
    }

    resetPrepState()
    prepState.active = true
    // 自动准备期间抑制 ElMessage 弹窗（底部状态栏已显示进度）
    _suppressKbMsg = true
    // 处理过程中在输出内容区显示状态
    result.value = store.locales == 'zh' ? '正在处理知识库...' : 'Processing knowledge base...'

    const needSlice = !isSliced.value
    const needEmbed = !isEmbedded.value

    prepState.steps = [
        ...(needSlice ? [{ step: store.locales == 'zh' ? '切片' : 'Slice', status: 'pending' as const, detail: '' }] : []),
        ...(needEmbed ? [{ step: store.locales == 'zh' ? '向量化' : 'Embed', status: 'pending' as const, detail: '' }] : []),
    ]
    const sliceIdx = needSlice ? 0 : -1
    const embedIdx = needEmbed ? (needSlice ? 1 : 0) : -1

    try {
        // 步骤一：自动切片
        if (needSlice) {
            setPrepStep(sliceIdx, 'running', store.locales == 'zh' ? '正在读取文件并按策略切分...' : 'Reading files and slicing...')
            await sliceOnly(true, (detail) => setPrepStep(sliceIdx, 'running', detail))
            if (!isSliced.value) {
                setPrepStep(sliceIdx, 'error', store.locales == 'zh' ? '切片失败：没有可切片的文档' : 'Slicing failed: no documents to slice')
                result.value = store.locales == 'zh' ? '自动准备失败：没有可切片的文档' : 'Auto-prepare failed: no documents to slice'
                return false
            }
            setPrepStep(sliceIdx, 'done', store.locales == 'zh' ? `切片完成：共 ${blocks.value.length} 个切片` : `Sliced: ${blocks.value.length} blocks`)
        }

        // 步骤二：自动向量化（切片刚生成待向量化切片）
        if (needEmbed && !isEmbedded.value) {
            setPrepStep(embedIdx, 'running', store.locales == 'zh' ? '正在生成切片向量...' : 'Generating embeddings...')
            await embedBlocks((detail) => setPrepStep(embedIdx, 'running', detail))
            if (!isEmbedded.value) {
                setPrepStep(embedIdx, 'error', store.locales == 'zh' ? '向量化失败，请检查嵌入模型配置' : 'Embedding failed, check embed model config')
                result.value = store.locales == 'zh' ? '自动准备失败：向量化失败，请检查嵌入模型配置' : 'Auto-prepare failed: check embed model config'
                return false
            }
            setPrepStep(embedIdx, 'done', store.locales == 'zh' ? '向量化完成' : 'Embedding done')
        }

        return true
    } catch (e) {
        console.error('自动准备知识库失败:', e)
        const failMsg = store.locales == 'zh' ? `自动准备失败: ${getErrorMessage(e)}` : `Auto-prepare failed: ${getErrorMessage(e)}`
        kb_state.value = failMsg
        result.value = failMsg
        return false
    } finally {
        prepState.active = false
        _suppressKbMsg = false
    }
}

function splitByHeadings(content: string): string[] {
    if (!content) return [];
    
    const headingPatterns = [
        /^第[一二三四五六七八九十百千万\d]+章\s+/gm,
        /^第[一二三四五六七八九十百千万\d]+条\s+/gm,
        /^[一二三四五六七八九十]+、\s*/gm,
        /^\(\d+\)\s*/gm,
        /^\d+\.\s*/gm,
        /^[A-Z]\.\s*/gm,
        /^【[^】]+】\s*/gm,
        /^第[一二三四五六七八九十百千万\d]+节\s+/gm,
        /^[IVX]+\.\s*/gm,
    ];
    
    const lines = content.split(/\r?\n/);
    const sections: string[] = [];
    let currentSection: string[] = [];
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        const isHeading = headingPatterns.some(pattern => {
            const regex = new RegExp(pattern);
            return regex.test(line);
        });
        
        if (isHeading) {
            if (currentSection.length > 0) {
                sections.push(currentSection.join('\n'));
                currentSection = [];
            }
            currentSection.push(lines[i]);
        } else {
            currentSection.push(lines[i]);
        }
    }
    
    if (currentSection.length > 0) {
        sections.push(currentSection.join('\n'));
    }
    
    if (sections.length <= 1) {
        console.log('智能切分未识别到一级标题，回退到默认切分');
        return content.split(/(?:\r?\n){3,}/);
    }
    
    return sections;
}

// ==================== 切片增强：语义切分 / 大小上限 / 重叠 ====================

function hashContent(text: string): string {
    let hash = 5381
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) + hash) ^ text.charCodeAt(i)
        hash = hash & 0xffffffff
    }
    return (hash >>> 0).toString(36)
}

function splitSentences(text: string): string[] {
    return text.split(/(?<=[。！？!?；;])\s*/).filter(s => s.trim().length > 0)
}

function splitOversizedBlock(text: string, maxChars: number): string[] {
    if (text.length <= maxChars) return [text]
    const result: string[] = []
    const paragraphs = text.split(/(?:\r?\n){2,}/)
    let current = ''
    for (const para of paragraphs) {
        if ((current + '\n' + para).trim().length <= maxChars) {
            current = current ? current + '\n' + para : para
        } else {
            if (current.trim()) result.push(current.trim())
            current = ''
            if (para.length > maxChars) {
                const sentences = splitSentences(para)
                let buf = ''
                for (const sent of sentences) {
                    if ((buf + sent).length <= maxChars) {
                        buf += sent
                    } else {
                        if (buf.trim()) result.push(buf.trim())
                        if (sent.length > maxChars) {
                            for (let k = 0; k < sent.length; k += maxChars) {
                                result.push(sent.slice(k, k + maxChars))
                            }
                            buf = ''
                        } else {
                            buf = sent
                        }
                    }
                }
                if (buf.trim()) result.push(buf.trim())
            } else {
                current = para
            }
        }
    }
    if (current.trim()) result.push(current.trim())
    return result.filter(p => p.length > 0)
}

function applyOverlapAndLimit(rawBlocks: string[], maxChars: number, overlapChars: number): { text: string; overlapText: string }[] {
    const splitBlocks: string[] = []
    for (const raw of rawBlocks) {
        if (raw.length <= maxChars) {
            splitBlocks.push(raw)
        } else {
            splitBlocks.push(...splitOversizedBlock(raw, maxChars))
        }
    }
    const result: { text: string; overlapText: string }[] = []
    for (let i = 0; i < splitBlocks.length; i++) {
        const text = splitBlocks[i]
        let overlapText = text
        if (overlapChars > 0 && i > 0) {
            overlapText = splitBlocks[i - 1].slice(-overlapChars) + '\n' + text
        }
        result.push({ text, overlapText })
    }
    return result
}

async function semanticSplitText(
    content: string,
    embedFn: (texts: string[]) => Promise<number[][]>,
    maxChars: number,
    threshold: number,
): Promise<string[]> {
    let candidates = content.split(/(?:\r?\n){2,}/).filter(p => p.trim().length > 0)
    if (candidates.length === 0) return []

    // 合并过短段落，避免碎片化嵌入
    const merged: string[] = []
    for (const c of candidates) {
        if (merged.length > 0 && (merged[merged.length - 1].length < 80 || c.length < 40)) {
            merged[merged.length - 1] += '\n' + c
        } else {
            merged.push(c)
        }
    }
    candidates = merged

    // 超长段按句再切
    const finalCandidates: string[] = []
    for (const m of candidates) {
        if (m.length > maxChars * 1.5) {
            const sentences = splitSentences(m)
            let buf = ''
            for (const s of sentences) {
                if ((buf + s).length <= maxChars) {
                    buf += s
                } else {
                    if (buf.trim()) finalCandidates.push(buf.trim())
                    if (s.length > maxChars) {
                        for (let k = 0; k < s.length; k += maxChars) {
                            finalCandidates.push(s.slice(k, k + maxChars))
                        }
                        buf = ''
                    } else {
                        buf = s
                    }
                }
            }
            if (buf.trim()) finalCandidates.push(buf.trim())
        } else {
            finalCandidates.push(m)
        }
    }

    if (finalCandidates.length <= 1) return finalCandidates.filter(p => p.length > 0)

    // 嵌入候选段，计算相邻相似度找主题边界
    const vectors = await embedFn(finalCandidates)
    const sims: number[] = []
    for (let i = 0; i < vectors.length - 1; i++) {
        sims.push(cosineSimilarity(vectors[i], vectors[i + 1]))
    }

    const boundaries = new Set<number>()
    for (let i = 0; i < sims.length; i++) {
        if (sims[i] < threshold) {
            const left = i > 0 ? sims[i - 1] : Infinity
            const right = i < sims.length - 1 ? sims[i + 1] : Infinity
            if (sims[i] <= left && sims[i] <= right) {
                boundaries.add(i + 1)
            } else if (sims[i] < threshold * 0.95) {
                boundaries.add(i + 1)
            }
        }
    }

    const result: string[] = []
    let start = 0
    const sorted = Array.from(boundaries).sort((a, b) => a - b)
    for (const b of sorted) {
        result.push(finalCandidates.slice(start, b).join('\n\n'))
        start = b
    }
    if (start < finalCandidates.length) {
        result.push(finalCandidates.slice(start).join('\n\n'))
    }
    return result.filter(p => p.trim().length > 0)
}

let previewContent = ref('') as any

/** 把推理摘要写回文件 YAML frontmatter（新增/替换 摘要 字段），返回是否成功（用于文件摘要持久化） */
const syncFileSummaryToFrontmatter = async (filePath: string, summary: string): Promise<boolean> => {
    try {
        const content: string = await window.ipcRenderer.invoke('readFile', filePath)
        if (typeof content !== 'string') return false
        const clean = String(summary || '').replace(/\s+/g, ' ').trim()
        if (!clean) return false
        // YAML 双引号标量：转义反斜杠与双引号，保证多行/特殊字符安全
        const quoted = '"' + clean.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
        const fmMatch = content.match(/^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
        let newContent: string
        if (fmMatch) {
            const fmBody = fmMatch[1]
            const lineRe = /^(摘要|summary|abstract):\s*(.*)$/m
            const newBody = lineRe.test(fmBody)
                ? fmBody.replace(lineRe, `摘要: ${quoted}`)
                : fmBody + `\n摘要: ${quoted}`
            newContent = content.slice(0, fmMatch.index) + '---\n' + newBody + '\n---\n' + content.slice((fmMatch.index || 0) + fmMatch[0].length)
        } else {
            newContent = `---\n摘要: ${quoted}\n---\n\n` + content
        }
        const res = await window.ipcRenderer.invoke('writeFile', filePath, newContent)
        return !!(res && res.success)
    } catch (e) {
        console.error('回写文件摘要失败:', filePath, e)
        return false
    }
}

/** 当前选中文件的推理摘要（优先 fileIndex：summarize_file 推理生成；其次 fileSummaries：YAML frontmatter） */
const currentFileSummary = computed((): string => {
    // 依赖 fileIndex 版本号：批量生成摘要后即使 Map 原地写入也能即时刷新显示
    void fileIndexVersion.value
    const f = files.value[selectedFileIndex.value]
    if (!f) return ''
    const idx = fileIndex.value.get(f.path)
    if (idx?.content) return idx.content
    const fs = fileSummaries.value.get(f.path)
    if (fs?.content) return fs.content
    return ''
})

const previewFile = async function(i: number) {
    selectedFileIndex.value = i
    try {
        const file = files.value[i]
        if (!file) return
        
        if (isPdfFile(file?.extension)) {
            previewContent.value = ''
            return
        }
        
        if (isWordFile(file?.extension)) {
            if (file.content && file.content !== '') {
                previewContent.value = file.content
                return
            }
            
            const result = await window.ipcRenderer.invoke('readFile', file.path)
            
            if (typeof result === 'object' && result !== null) {
                if (result.success === false) {
                    previewContent.value = result.content || `读取Word文档失败: ${result.error || '未知错误'}`
                } else {
                    previewContent.value = result.content || ''
                }
            } else {
                previewContent.value = result || ''
            }
            
            file.content = previewContent.value
            extractFileSummary(file)
            return
        }

        if (file && file.content !== undefined && file.content !== '') {
            previewContent.value = stripFrontmatter(file.content)
            return
        }

        const content = await window.ipcRenderer.invoke('readFile', file.path)
        previewContent.value = stripFrontmatter(content ?? '')
        if (file) file.content = content ?? ''
        extractFileSummary(file)
    } catch (err) {
        console.error('预览文件失败', err)
        previewContent.value = store.locales=='zh' ? '读取文件失败' : 'Failed to read file'
    }
}

// ====================== PDF/Word → Markdown 规范化 ======================
// 规范化状态：统计当前打开文件夹中缺少同名 .md 文档的 PDF/Word 文件
const normalizeState = ref({
    total: 0,            // PDF/Word 文件总数
    missing: 0,          // 缺少同名 .md 文档的文件数
    converting: false,   // 是否正在转换
    convertingText: ''   // 转换进度文本
})
const normalizeTargets = ref<any[]>([])

// ---- 悬浮提示（跟随鼠标） ----
const tooltipVisible = ref(false)
const tooltipPos = ref({ x: 0, y: 0 })
const tooltipData = ref<any>(null)
let tipSize = { w: 0, h: 0 }

/** 鼠标悬浮时显示提示（首次显示时测量尺寸以决定防溢出方向） */
const showTooltip = (e: MouseEvent, data: any) => {
    tooltipData.value = data
    if (!tooltipVisible.value) {
        tooltipVisible.value = true
        nextTick(() => {
            const el = document.querySelector('.tree-tooltip') as HTMLElement | null
            if (el) tipSize = { w: el.offsetWidth, h: el.offsetHeight }
        })
    }
    // 跟随鼠标（与鼠标位置对齐，无偏移），超出视口时翻转方向
    let x = e.clientX
    let y = e.clientY
    if (tipSize.w && x + tipSize.w > window.innerWidth - 4) x = e.clientX - tipSize.w
    if (tipSize.h && y + tipSize.h > window.innerHeight - 4) y = e.clientY - tipSize.h
    tooltipPos.value = { x: Math.max(4, x), y: Math.max(4, y) }
}

// 提示内容变化时（如不同长度文件名）重新测量尺寸，确保防溢出方向正确
watch(tooltipData, () => {
    if (tooltipVisible.value && tooltipData.value) {
        nextTick(() => {
            const el = document.querySelector('.tree-tooltip') as HTMLElement | null
            if (el) tipSize = { w: el.offsetWidth, h: el.offsetHeight }
        })
    }
})

/** 隐藏提示 */
const hideTooltip = () => {
    tooltipVisible.value = false
    tooltipData.value = null
}

// 扫描当前文件夹中 PDF/Word/图片 文件的规范化状态
function scanNormalizeStatus() {
    // 需规范化判断的文件类型：PDF / Word / 图片
    const docFiles: any[] = files.value.filter((f: any) =>
        isPdfFile(f.extension) || isWordFile(f.extension) || isImageFile(f.extension)
    )
    // 可自动转换的目标：仅 PDF/Word（图片无法自动转换，只能手动提供同名 .md）
    const targetable = files.value.filter((f: any) => isPdfFile(f.extension) || isWordFile(f.extension))
    normalizeTargets.value = targetable.filter((f: any) => !hasCorrespondingMd(f, files.value))
    normalizeState.value = {
        total: docFiles.length,
        missing: docFiles.filter((f: any) => !hasCorrespondingMd(f, files.value)).length,
        converting: false,
        convertingText: ''
    }
}

// 提取 PDF 文本（参考 PdfViewer.vue：readFileBase64 + pdfjs-dist 读取每一页文本）
async function extractPdfText(filePath: string): Promise<string> {
    const result = await window.ipcRenderer.invoke('readFileBase64', filePath)
    if (typeof result !== 'string' || !result.startsWith('data:')) {
        throw new Error(typeof result === 'string' ? result : '读取PDF文件失败')
    }

    const base64 = result.split(',')[1]
    const binaryStr = atob(base64)
    const bytes = new Uint8Array(binaryStr.length)
    for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i)
    }

    const loadingTask = getDocument({ data: bytes })
    const pdf = await loadingTask.promise
    const pageCount = pdf.numPages
    let text = ''
    for (let i = 1; i <= pageCount; i++) {
        const page = await pdf.getPage(i)
        const content = await page.getTextContent()
        const strings = (content.items as any[]).map((item: any) => item.str)
        text += strings.join(' ') + '\n\n'
    }
    try { pdf.destroy() } catch {}
    return text.trim()
}

// 转换缺失的 PDF/Word 文件为同名 .md 文档（PDF 参考 PdfViewer.vue，Word 参考主进程 readFile）
async function normalizeFiles() {
    if (normalizeState.value.converting) return
    const targets = normalizeTargets.value
    if (targets.length === 0) {
        ElMessage.info(store.locales == 'zh' ? '所有 PDF/Word 文件均已规范化' : 'All PDF/Word files are already normalized')
        return
    }

    normalizeState.value.converting = true
    const successList: any[] = []
    let failed = 0
    const total = targets.length
    for (let i = 0; i < total; i++) {
        const target = targets[i]
        normalizeState.value.convertingText = `(${i + 1}/${total}) ${target.label}`
        try {
            let markdown = ''
            if (isPdfFile(target.extension)) {
                markdown = await extractPdfText(target.path)
            } else {
                // 注：主进程 readFile 仅支持 .docx（mammoth → turndown 转 Markdown，已忽略图片），旧版 .doc 无法转换
                if (target.extension?.toLowerCase() === '.doc') {
                    console.warn('不支持转换旧版 .doc 格式', target.path)
                    failed++
                    continue
                }
                // Word 文件转换参考 electron/main/index.ts 的 readFile
                const result = await window.ipcRenderer.invoke('readFile', target.path)
                markdown = (typeof result === 'object' && result !== null)
                    ? (result.content || '')
                    : (result ?? '')
            }

            // 读取失败（错误信息文本）时不写入 .md，避免生成垃圾文件
            if (typeof markdown === 'string' && (/^Error reading file/.test(markdown) || /^不支持的文件格式/.test(markdown))) {
                failed++
                continue
            }

            const writeResult = await window.ipcRenderer.invoke('writeFile', mdPathOf(target.path), markdown)
            if (writeResult && writeResult.success) {
                successList.push(target)
            } else {
                failed++
            }
        } catch (e) {
            console.error('规范化失败', target.path, e)
            failed++
        }
    }

    // 将新生成的 .md 文件加入文件列表（名称一致，仅扩展名不同）
    for (const t of successList) {
        const mdPath = mdPathOf(t.path)
        const label = mdPath.split(/[\\/]/).pop() || mdPath
        files.value.push({
            label,
            path: mdPath,
            extension: '.md',
            size: 0,
            content: '',
            attributes: {}
        })
        const docName = label.lastIndexOf('.') > 0 ? label.substring(0, label.lastIndexOf('.')) : label
        documents.value.push({ name: docName })
    }

    scanNormalizeStatus()
    // 规范化会新增 .md 文档（尚无摘要），同步刷新摘要提示状态
    scanSummaryStatus()
    kb_state.value = store.locales == 'zh'
        ? `规范化完成：成功 ${successList.length} 个，失败 ${failed} 个`
        : `Normalization done: ${successList.length} succeeded, ${failed} failed`
}

// ====================== 文件摘要状态（判断 + 批量生成缺失摘要） ======================
// 摘要状态：统计文件列表中「缺少摘要」的 Markdown 文档（无论是否已切片）；批量生成复用 summarize_file 原语
const summaryState = ref({
    total: 0,            // Markdown 文档总数
    missing: 0,          // 缺少摘要的文档数
    generating: false,   // 是否正在批量生成
    generatingText: ''   // 生成进度文本
})
const summaryTargets = ref<any[]>([])

/** 文件是否已有摘要（优先 LLM 推理 fileIndex；其次 fileSummaries / frontmatter·attributes 中的 摘要/summary/abstract） */
const hasFileSummary = (file: any): boolean => {
    if (!file?.path) return false
    const idx = fileIndex.value.get(file.path)
    if (idx?.content) return true
    const fs = fileSummaries.value.get(file.path)
    if (fs?.content) return true
    const a = file.attributes || {}
    if (a.summary || a.摘要 || a.abstract) return true
    return false
}

/** 扫描文件摘要状态：统计文件列表中缺少摘要的 Markdown 文档 */
const scanSummaryStatus = () => {
    if (!store.root) {
        summaryState.value = { total: 0, missing: 0, generating: false, generatingText: '' }
        summaryTargets.value = []
        return
    }
    const targets: any[] = []
    let total = 0
    for (const f of files.value) {
        if ((f.extension || '').toLowerCase() !== '.md') continue
        total++
        if (!hasFileSummary(f)) targets.push(f)
    }
    summaryState.value.total = total
    summaryState.value.missing = targets.length
    summaryTargets.value = targets
}

/** 读取 Markdown 正文（去除 frontmatter），供未切片文档生成摘要用 */
const readMdBody = async (file: any): Promise<string> => {
    let content = (typeof file.content === 'string' && file.content) ? file.content : ''
    if (!content) {
        try {
            const r = await window.ipcRenderer.invoke('readFile', file.path)
            content = (typeof r === 'object' && r !== null) ? (r.content || '') : (r ?? '')
        } catch (e) {
            console.error('读取文件内容失败（生成摘要）:', file.path, e)
            return ''
        }
    }
    return stripFrontmatter(content || '').trim()
}

/** 批量生成缺少摘要的 Markdown 文档摘要：
 *  已切片文档用其切片文本（与知识库管线一致）；未切片文档以整篇正文作为单个块喂给 summarize_file，
 *  统一复用 summarize_file → fileIndex + 回写 frontmatter。 */
const generateFileSummaries = async () => {
    if (summaryState.value.generating) return
    const targets = summaryTargets.value
    if (targets.length === 0) {
        ElMessage.info(store.locales == 'zh' ? '文件均已有摘要' : 'All docs already have summaries')
        return
    }

    summaryState.value.generating = true
    summaryState.value.generatingText = ''
    let skippedEmpty = 0
    try {
        // 为缺失目标收集喂给 summarize_file 的切片：优先真实切片；未切片文档用整篇正文
        const blocksCtx: any[] = []
        for (const t of targets) {
            const real = blocks.value.filter((b: any) => b.filePath === t.path)
            if (real.length > 0) {
                blocksCtx.push(...real)
                continue
            }
            const body = await readMdBody(t)
            if (!body) { skippedEmpty++; continue }
            blocksCtx.push({ filePath: t.path, A: body })
        }
        if (blocksCtx.length === 0) {
            ElMessage.warning(store.locales == 'zh' ? '没有可生成摘要的内容（文档为空？）' : 'No content to summarize (empty docs?)')
            return
        }
        const ingestCtx: IngestionContext = {
            blocks: blocksCtx,
            config: {
                url: model.value.url,
                embed: model.value.embed,
                chat: model.value.chat,
                process: model.value.process,
                processPrompt: model.value.processPrompt,
                fileSummaryPrompt: getConfiguredIngestPrompt('fileSummaryPrompt') || undefined,
                think: model.value.think,
            },
            services: kbAi.buildIngestionServices(buildKbSpec(), {
                // 推理摘要回写文件 frontmatter（持久化）
                syncFileSummary: (fp: string, s: string) => syncFileSummaryToFrontmatter(fp, s),
            }),
            fileIndex: fileIndex.value as Map<string, any>,
            onProgress: (msg: string) => { summaryState.value.generatingText = msg },
            isCancelled: () => !summaryState.value.generating,
        }
        const r = await summarizeFile(ingestCtx, {})
        // 摘要索引已写入：自增版本号触发依赖它的 computed 刷新（当前选中文件摘要即时更新）
        fileIndexVersion.value++
        scanSummaryStatus()
        // 摘要回写改变文件 mtime/size，刷新构建清单避免下次被误判为文件变更
        await refreshBuildManifest()
        const skipText = skippedEmpty > 0
            ? (store.locales == 'zh' ? `（${skippedEmpty} 个空文档跳过）` : ` (${skippedEmpty} empty skipped)`)
            : ''
        kb_state.value = store.locales == 'zh'
            ? `文件摘要生成完成：成功 ${r.processed} / 失败 ${r.failed}${skipText}`
            : `Summaries generated: ok ${r.processed} / fail ${r.failed}${skipText}`
        ElMessage.success(store.locales == 'zh'
            ? `文件摘要生成完成：成功 ${r.processed} 个 / 失败 ${r.failed} 个${skipText}`
            : `Summaries generated: ${r.processed} ok / ${r.failed} failed${skipText}`)
    } catch (e) {
        console.error('批量生成文件摘要失败:', e)
        kb_state.value = store.locales == 'zh' ? '文件摘要生成失败' : 'Summary generation failed'
        ElMessage.error(store.locales == 'zh' ? '文件摘要生成失败' : 'Summary generation failed')
    } finally {
        summaryState.value.generating = false
        scanSummaryStatus()
    }
}

const reasoning = async function(i: number) {
    let qBuffer = ''
    let history = [{role: 'user', content: model.value.processPrompt + blocks.value[i].A}];
    try {
        await kbStreamChat(history, (chunk) => { qBuffer += chunk }, { think: false });
        const qText = (qBuffer || '').trim();
        if (!qText) throw new Error("推理结果为空");
        // 解析“问题 + 答案”成对（答案缺省时兼容旧纯问题列表）；问题→text、答案→extraAnswer 分开存储
        const pairs = parseQuestionAnswerPairs(qText)
        const texts = pairs.map(p => p.text).filter(Boolean)
        const answers = pairs.map(p => p.answer)
        let vecs: (number[] | undefined)[] = []
        if (texts.length) {
            try {
                const embs = await kbEmbed(texts)
                vecs = texts.map((_, k) => embs?.[k])
            } catch (e) { console.warn('独立问题向量化失败', e) }
        }
        replaceBlockReasonedQuestions(blocks.value[i], texts, vecs, answers)
        try { scheduleRefreshAtlas(120) } catch (e) {}
    } catch (error) {
        console.error("处理失败:", error);
    }
}

const extractQuestionsWithProgress = async function(startIndex: number = 0) {
    const totalBlocks = blocks.value.length
    extractProgress.value.totalCount = totalBlocks
    extractProgress.value.isRunning = true
    extractProgress.value.isPaused = false
    
    for (let i = startIndex; i < totalBlocks; i++) {
        while (extractProgress.value.isPaused) {
            await new Promise(resolve => setTimeout(resolve, 100))
            if (!extractProgress.value.isRunning) return
        }
        
        // 方案 A：该切片在问题库中已有推理问题则跳过（问题不再存于切片）
        const bId = blocks.value[i]?.id
        if (bId && questionBank.value.some(q => q.srcBlockId === bId && q.origin === 'reasoned' && q.status !== 'merged')) continue
        
        extractProgress.value.currentIndex = i + 1
        saveExtractProgress()
        
        kb_state.value = store.locales === 'zh' ?
            `提取问题: ${i+1}/${totalBlocks} (${Math.round((i+1)/totalBlocks*100)}%)` :
            `Extracting: ${i+1}/${totalBlocks} (${Math.round((i+1)/totalBlocks*100)}%)`
        
        await reasoning(i)
    }
    
    extractProgress.value.isRunning = false
    extractProgress.value.isPaused = false
    clearExtractProgress()
    kb_state.value = store.locales === 'zh' ? '问题提取完成！' : 'Extraction complete!'
}

const continueExtract = async () => {
    if (extractProgress.value.isPaused) {
        extractProgress.value.isPaused = false
        extractProgress.value.isRunning = true
        await extractQuestionsWithProgress(extractProgress.value.currentIndex)
    } else if (loadExtractProgress()) {
        kb_state.value = store.locales === 'zh' ? 
            `从保存的进度恢复问题提取: ${extractProgressText.value}` : 
            `Resuming extraction from saved progress: ${extractProgressText.value}`
        await extractQuestionsWithProgress(extractProgress.value.currentIndex)
    } else {
        kb_state.value = store.locales === 'zh' ? '没有可恢复的问题提取进度，请重新开始' : 'No extraction progress to resume'
    }
}

const startExtract = async () => {
    if (extractProgress.value.isRunning) {
        kb_state.value = store.locales === 'zh' ? '问题提取已在运行中' : 'Extraction already running'
        return
    }
    if (!store.root) {
        kb_state.value = store.locales === 'zh' ? '请先选择知识库文件夹' : 'Please select a KB folder first'
        return
    }
    // 知识库就绪后再推理：自动知识库且尚无切片 → 先自动切片一次，等准备完成再继续提取问题
    if (!blocks.value.length && !isKbLoaded.value) {
        kb_state.value = store.locales === 'zh'
            ? '知识库尚未切片，正在自动切片，完成后继续提取问题...'
            : 'KB not sliced yet — slicing first, then extracting questions...'
        await sliceOnly(true)
    }
    if (!blocks.value.length) {
        kb_state.value = store.locales === 'zh'
            ? (isKbLoaded.value ? '该 .kb 知识库没有切片内容，请重新切片后保存' : '没有可提取问题的切片')
            : (isKbLoaded.value ? 'This .kb has no slices — re-slice and save' : 'No slices to extract questions from')
        return
    }
    clearExtractProgress()
    extractProgress.value.startTime = Date.now()
    await extractQuestionsWithProgress(0)
}

const stopExtract = () => {
    extractProgress.value.isRunning = false
    extractProgress.value.isPaused = false
    clearExtractProgress()
    kb_state.value = store.locales === 'zh' ? '问题提取已停止' : 'Extraction stopped'
}

// ===== 处理管线：按当前策略的 ingestionSteps 统一执行（semantic_enhance / extract_entities 等） =====
const ingestRunning = ref(false)
const ingestStats = ref<Record<string, { processed: number; failed: number }>>({})

/** 读取当前策略处理管线中配置的步骤级提示词（semantic_enhance 的 processPrompt / summarize_file 的 fileSummaryPrompt） */
const getConfiguredIngestPrompt = (key: 'processPrompt' | 'fileSummaryPrompt'): string => {
    const def = getStrategies().find(s => s.id === queryMethod.value)
    if (!def?.ingestionSteps?.length) return ''
    for (const st of def.ingestionSteps) {
        if (st.params?.[key]) return st.params[key]
    }
    return ''
}

const runStrategyIngestion = async (strategyId?: string) => {
    const sid = strategyId || queryMethod.value
    if (ingestRunning.value) {
        ElMessage.info(store.locales == 'zh' ? '处理管线已在运行中' : 'Ingestion pipeline already running')
        return
    }
    const def = getStrategies().find(s => s.id === sid)
    if (!def || !def.ingestionSteps?.length) {
        ElMessage.info(store.locales == 'zh' ? '该策略没有配置处理管线' : 'This strategy has no ingestion pipeline')
        return
    }
    if (!blocks.value.length) {
        ElMessage.warning(store.locales == 'zh' ? '没有切片数据，请先切片' : 'No slices, please slice first')
        return
    }

    ingestRunning.value = true
    ingestStats.value = {}
    kb_state.value = store.locales == 'zh' ? '处理管线执行中...' : 'Ingestion pipeline running...'
    resetPrepState()
    prepState.active = true
    // 应用策略处理管线的步骤级参数（semantic_enhance 的 processPrompt、summarize_file 的 fileSummaryPrompt 覆盖全局默认）
    const ingestSteps = def.ingestionSteps || []
    let stepProcessPrompt = ''
    let stepFileSummaryPrompt = ''
    for (const st of ingestSteps) {
        if (!st.params) continue
        if (st.params.processPrompt) stepProcessPrompt = st.params.processPrompt
        if (st.params.fileSummaryPrompt) stepFileSummaryPrompt = st.params.fileSummaryPrompt
    }
    // 状态栏：每个处理原语一个步骤（label 用原语元数据，如"切片语义增强"/"文件语义增强"）
    prepState.steps = ingestSteps.map(st => ({
        step: PRIMITIVE_META[st.primitive]?.label || st.primitive,
        status: 'pending' as const,
        detail: '',
    }))
    const baseCtx: IngestionContext = {
        blocks: blocks.value as any,
        config: {
            url: model.value.url,
            embed: model.value.embed,
            chat: model.value.chat,
            process: model.value.process,
            processPrompt: stepProcessPrompt || model.value.processPrompt,
            fileSummaryPrompt: stepFileSummaryPrompt || undefined,
            think: model.value.think,
        },
        services: kbAi.buildIngestionServices(buildKbSpec(), {
            // 推理摘要写回文件 frontmatter（持久化）
            syncFileSummary: (fp: string, s: string) => syncFileSummaryToFrontmatter(fp, s),
        }),
        fileIndex: fileIndex.value as Map<string, any>,
        // 问题语义增强：传入问题库（有文本缺向量的问题会被补全问题向量）
        questions: questionBank.value as any,
        isCancelled: () => !ingestRunning.value,
    }

    try {
        // 逐个原语执行，实时进度显示在底部状态栏对应步骤
        for (let si = 0; si < ingestSteps.length; si++) {
            const st = ingestSteps[si]
            const fn = INGESTION_PRIMITIVES[st.primitive]
            if (!fn) continue
            setPrepStep(si, 'running', store.locales == 'zh' ? '执行中...' : 'Running...')
            const stepCtx: IngestionContext = {
                ...baseCtx,
                onProgress: (msg: string) => {
                    kb_state.value = msg
                    setPrepStep(si, 'running', msg)
                },
            }
            try {
                const r = await fn(stepCtx, st.params)
                const processed = (r as any)?.processed ?? 0
                const failed = (r as any)?.failed ?? 0
                ingestStats.value[st.primitive] = { processed, failed }
                setPrepStep(si, 'done', store.locales == 'zh' ? `成功 ${processed} / 失败 ${failed}` : `ok ${processed} / fail ${failed}`)
            } catch (e) {
                console.error(`处理原语 ${st.primitive} 失败:`, e)
                ingestStats.value[st.primitive] = { processed: 0, failed: 0 }
                setPrepStep(si, 'error', store.locales == 'zh' ? '执行失败' : 'Failed')
            }
        }
        try { scheduleRefreshAtlas(120) } catch (e) {}
        const doneText = Object.entries(ingestStats.value)
            .map(([k, v]) => `${(PRIMITIVE_META as Record<string, { label: string }>)[k]?.label || k}: 成功${v.processed}/失败${v.failed}`)
            .join('，')
        kb_state.value = store.locales == 'zh'
            ? `处理管线完成（${doneText}）`
            : `Ingestion complete (${doneText})`
    } catch (error) {
        console.error('处理管线执行失败:', error)
        kb_state.value = store.locales == 'zh' ? '处理管线执行失败' : 'Ingestion pipeline failed'
    } finally {
        prepState.active = false
        ingestRunning.value = false
        // 摘要回写会改变文件 mtime/size，刷新构建清单避免下次被误判为文件变更
        if (ingestSteps.some(st => st.primitive === 'summarize_file')) {
            refreshBuildManifest()
        }
        // 处理管线可能写入文件摘要（summarize_file），刷新摘要状态
        scanSummaryStatus()
    }
}

/** 确保处理管线就绪：策略需要语义增强/文件增强时，若对应向量未生成则自动执行处理管线 */
const ensureIngestionReady = async (sid: string): Promise<boolean> => {
    const def = getStrategies().find(s => s.id === sid)
    if (!def || !def.ingestionSteps?.length) return true
    if (blocks.value.length === 0) return true

    // 语义增强（semantic_enhance → Q_vector）：切片尚未全部增强时需补跑
    const needSemantic = def.ingestionSteps.some(st => st.primitive === 'semantic_enhance')
    if (needSemantic) {
        const enhancedCount = blocks.value.filter((b: any) => b.Q_vector && b.Q_vector.length > 0).length
        if (enhancedCount < blocks.value.length) {
            await runStrategyIngestion(sid)
            return true
        }
    }

    // 文件语义增强（summarize_file → fileIndex）：存在未生成摘要向量的文件时需补跑
    const needFile = def.ingestionSteps.some(st => st.primitive === 'summarize_file')
    if (needFile) {
        const filePaths = new Set(blocks.value.map((b: any) => b.filePath))
        let covered = 0
        for (const p of filePaths) {
            if (fileIndex.value.has(p) && fileIndex.value.get(p)?.vector) covered++
        }
        if (covered < filePaths.size) {
            await runStrategyIngestion(sid)
            return true
        }
    }

    return true
}

let sr: any = null

// ===== 增量更新（打开 KB 时自动检测文件变更） =====

/** 快速内容哈希：FNV-1a + djb2 双 32 位拼为 "hex-hex"（非加密，仅用于文件内容比对，碰撞概率约 2^-64） */
const contentHash = (s: string): string => {
    let h1 = 0x811c9dc5
    let h2 = 5381
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i)
        h1 ^= c
        h1 = Math.imul(h1, 0x01000193)
        h2 = ((h2 << 5) + h2 + c) | 0
    }
    return (h1 >>> 0).toString(16) + '-' + (h2 >>> 0).toString(16)
}

/** 读取 .md 文本并计算内容哈希（读取失败返回 null） */
const readFileContentHash = async (filePath: string): Promise<string | null> => {
    try {
        const result: any = await window.ipcRenderer.invoke('readFile', filePath)
        if (result && typeof result === 'object') {
            if (result.success === false) return null
            return contentHash(String(result.content ?? ''))
        }
        return contentHash(String(result ?? ''))
    } catch { return null }
}

/** 检测文件变更：两级判定 → { added, modified, deleted }
 *  ① 廉价筛子：与 buildManifest 比 size/mtime（不读文件内容）：size 不同 → 内容必变直接标修改；
 *  ② size 相同但 mtime 不同（疑似"仅 touch/同内容重写"）→ 读全文算内容哈希确认：
 *     内容一致则不标「修改」只静默同步 mtime；内容真变才标「修改」。
 *  旧基准（历史 .kb）无 hash 字段时惰性补录，首次按 mtime 差异保守判修改。 */
const detectFileChanges = async (): Promise<{ added: string[]; modified: string[]; deleted: string[] }> => {
    const changes = { added: [] as string[], modified: [] as string[], deleted: [] as string[] }
    if (!store.root) { fileChanges.value = changes; return changes }
    let fileList: any[] = []
    try {
        const r = await window.ipcRenderer.invoke("getFilesRelation", store.root, 3)
        fileList = (r.fileList || []).filter((f: any) =>
            f.type === 'file' && (f.extension || '').toLowerCase() === '.md' && !f.path.toLowerCase().endsWith('.kb'))
    } catch { fileChanges.value = changes; return changes }
    const current: Record<string, any> = {}
    for (const f of fileList) current[f.path] = { size: f.size ?? 0, mtime: f.mtime ?? 0 }
    const prev = buildManifest.value || {}
    const pendingHash = new Map<string, any>()

    for (const [path, meta] of Object.entries(current)) {
        const p = prev[path]
        if (!p) { changes.added.push(path); continue }
        if (p.size !== meta.size) { changes.modified.push(path); continue }   // 字节数不同 → 内容必变，无需读哈希
        if (p.mtime === meta.mtime) continue                                  // size/mtime 均同 → 未变
        pendingHash.set(path, meta)                                           // size 同、mtime 异 → 待哈希确认
    }
    // ② 内容哈希确认：只对"疑似变更"文件并发读全文，避免全量扫描开销
    if (pendingHash.size > 0) {
        const hashed = await Promise.all(Array.from(pendingHash.keys()).map(async (path) => ({ path, hash: await readFileContentHash(path) })))
        for (const { path, hash } of hashed) {
            const meta = pendingHash.get(path)
            const p = prev[path]
            if (!meta || !p) continue
            if (hash === null) { changes.modified.push(path); continue }      // 读取失败：保守判修改
            if (p.hash === undefined || p.hash === null) {
                // 历史基准无内容哈希：补录当前哈希 + 同步 mtime，按 mtime 差异保守判修改（兼容旧 .kb）
                p.hash = hash
                p.mtime = meta.mtime
                changes.modified.push(path)
                continue
            }
            if (p.hash === hash) { p.mtime = meta.mtime; continue }           // 内容未变（仅 mtime 漂移）→ 不标，同步基准
            changes.modified.push(path)                                        // 内容真变 → 标修改
        }
    }
    for (const p of Object.keys(prev)) {
        if (!(p in current)) changes.deleted.push(p)
    }
    // 同步最近一次检测结果 → 文件标签页标记（新增/修改/删除）
    fileChanges.value = changes
    return changes
}

/** 最近一次检测到的文件变更（供「文件」标签页标记新增/修改/删除） */
const fileChanges = ref<{ added: string[]; modified: string[]; deleted: string[] }>({ added: [], modified: [], deleted: [] })

/** 文件变更总数（新增 + 修改 + 删除，供底部状态栏提示） */
const fileChangeTotal = computed(() =>
    fileChanges.value.added.length + fileChanges.value.modified.length + fileChanges.value.deleted.length)

/** 刷新构建清单（记录当前文件 size/mtime，作为下次增量基准）。
 *  内容未变的文件尽量保留已补录的 hash，避免重建时丢失内容基准；
 *  处理流程改写过的文件（size/mtime 变化）hash 留空，下次检测时惰性补录。 */
const refreshBuildManifest = async () => {
    if (!store.root) return
    try {
        const r = await window.ipcRenderer.invoke("getFilesRelation", store.root, 3)
        const fileList = (r.fileList || []).filter((f: any) =>
            f.type === 'file' && (f.extension || '').toLowerCase() === '.md')
        const old = buildManifest.value || {}
        const manifest: Record<string, any> = {}
        for (const f of fileList) {
            const rec: any = { size: f.size ?? 0, mtime: f.mtime ?? 0 }
            const o = old[f.path]
            if (o && o.size === rec.size && o.mtime === rec.mtime && o.hash !== undefined && o.hash !== null) {
                rec.hash = o.hash
            }
            manifest[f.path] = rec
        }
        buildManifest.value = manifest
    } catch { /* 忽略 */ }
}

/** 判断当前文件夹内是否存在有效的知识库基准（buildManifest 中有属于本文件夹的文件记录） */
const hasManifestUnderRoot = (): boolean => {
    if (!store.root || !buildManifest.value) return false
    const rootNorm = String(store.root).replace(/\\/g, '/').replace(/\/+$/, '')
    return Object.keys(buildManifest.value)
        .some((p) => String(p).replace(/\\/g, '/').startsWith(rootNorm + '/'))
}

/** 「文件」标签页进入/文件列表就绪时：检测一次磁盘文件变更并刷新文件行徽标（新增/修改/删除）。
 *  无有效知识库基准（从未加载 .kb 或基准属于其它文件夹）时，先把当前 .md 列表登记为基准，
 *  避免首次浏览误把所有文件标成「新增」；此后磁盘有增/删/改，再次进入即可被检出。 */
const checkFileChangesOnFileView = async () => {
    if (!store.root || incrementalRunning.value) return
    if (!hasManifestUnderRoot()) {
        await refreshBuildManifest()
        fileChanges.value = { added: [], modified: [], deleted: [] }
        return
    }
    await detectFileChanges()
}

/** 去抖调度：同一批事件（如进入文件页 + 文件列表加载完成）只合并执行一次检测 */
let fileViewCheckScheduled = false
const scheduleFileViewChangeCheck = () => {
    if (fileViewCheckScheduled) return
    fileViewCheckScheduled = true
    setTimeout(async () => {
        fileViewCheckScheduled = false
        try { await checkFileChangesOnFileView() }
        catch (e) { console.error('文件变更检测失败:', e) }
    }, 80)
}

/** 应用窗口重新获得焦点：若停在「文件」标签页则检测一次文件变更（外部改完文件切回可见徽标） */
const onWindowFocusFileCheck = () => {
    if (viewMode.value === 'file') scheduleFileViewChangeCheck()
}

/** 把 idCounters 推进到现有最大值（增量构建前调用，避免新 id 与已有冲突） */
const syncIdCountersToExisting = () => {
    let maxB = 0, maxE = 0, maxR = 0
    const parseNum = (id: string) => { const n = parseInt(String(id || '').replace(/^\D+/, '')); return isNaN(n) ? 0 : n }
    for (const b of blocks.value) maxB = Math.max(maxB, parseNum(b.id))
    for (const e of globalEntities.value.values()) maxE = Math.max(maxE, parseNum(e.id))
    for (const r of globalRelations.value.values()) maxR = Math.max(maxR, parseNum(r.id))
    idCounters = { block: maxB, entity: maxE, relation: maxR }
}

/** 清理被删除文件的本体关联（实体关联块/文件移除 → 孤立实体/关系删除） */
const cleanupOntologyForDeletedFiles = (deletedFiles: string[]) => {
    if (!deletedFiles.length) return
    const deletedSet = new Set(deletedFiles)
    const removedBlockIds = new Set<string>()
    for (const b of blocks.value) if (deletedSet.has(b.filePath)) removedBlockIds.add(b.id)
    for (const [key, entity] of globalEntities.value.entries()) {
        const before = entity.associatedBlocks.length
        entity.associatedBlocks = entity.associatedBlocks.filter((id: string) => !removedBlockIds.has(id))
        entity.associatedFiles = entity.associatedFiles.filter((p: string) => !deletedSet.has(p))
        if (entity.associatedBlocks.length !== before) globalEntities.value.set(key, entity)
    }
    for (const [, set] of entityToBlocksIndex.value) {
        for (const id of removedBlockIds) set.delete(id)
    }
    for (const [key, entity] of globalEntities.value.entries()) {
        if (entity.associatedBlocks.length === 0 && entity.associatedFiles.length === 0) {
            globalEntities.value.delete(key)
            entityToBlocksIndex.value.delete(key)
        }
    }
    const ids = new Set([...globalEntities.value.values()].map(e => e.id))
    for (const [key, rel] of globalRelations.value.entries()) {
        if (!ids.has(rel.source) || !ids.has(rel.target)) globalRelations.value.delete(key)
    }
}

/** 本体增量：只对变更文件做实体/关系抽取（复用 merge 函数，幂等） */
const incrementalExtractEntities = async (changedFiles: string[], deletedFiles: string[], onProgress?: (d: string) => void) => {
    cleanupOntologyForDeletedFiles(deletedFiles)
    syncIdCountersToExisting()
    for (let fi = 0; fi < changedFiles.length; fi++) {
        const filePath = changedFiles[fi]
        const fileBlocks = blocks.value.filter((b: any) => b.filePath === filePath)
        if (fileBlocks.length === 0) continue
        onProgress?.(`本体增量: ${fi + 1}/${changedFiles.length} ${filePath.split(/[\\/]/).pop()}`)
        const BATCH_SIZE = model.value.ontologyBatchSize || 8
        for (let i = 0; i < fileBlocks.length; i += BATCH_SIZE) {
            const batch = fileBlocks.slice(i, i + BATCH_SIZE)
            const batchContent = batch.map((b: any) => b.A).join('\n\n---\n\n')
            const batchResult = await extractOntologyFromBatch(batchContent, batch, getCurrentOntologyContext())
            if (batchResult.entities.length > 0) await mergeEntitiesToGlobal(batchResult.entities, filePath, batch)
            if (batchResult.relations.length > 0) await mergeRelationsToGlobal(batchResult.relations, filePath)
        }
    }
    updateOntologyViewer()
    updateEntityCards()
}

/** 社区稳定签名：排序后的成员实体 ID 集合的哈希（判断社区是否变化，不受 communityId 漂移影响） */
const communitySignature = (entityIds: string[]): string => {
    const sorted = [...entityIds].sort()
    let h = 5381
    for (const id of sorted) {
        for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0
        h = (h * 31 + 7) | 0
    }
    return String(h >>> 0)
}

/** 社区报告增量：按稳定签名对比，只重生成受影响社区的报告，未变社区复用旧报告 */
const incrementalCommunityReports = async (onProgress?: (d: string) => void): Promise<{ generated: number; reused: number }> => {
    if (!communityResult.value || communityResult.value.count === 0) return { generated: 0, reused: 0 }
    const oldSignatureToReport = new Map<string, any>()
    for (const rep of communityReports.value) {
        if (rep.signature) oldSignatureToReport.set(rep.signature, rep)
    }
    const idToNameMap = new Map<string, string>()
    for (const [nameKey, entity] of globalEntities.value.entries()) idToNameMap.set(entity.id, nameKey)

    const comMap = communityResult.value.communities
    const totalComs = comMap.size
    let generated = 0, reused = 0
    const reports: any[] = []

    for (const [comId, entityIds] of comMap.entries()) {
        const sig = communitySignature(entityIds)
        const old = oldSignatureToReport.get(sig)
        if (old) { reports.push({ ...old, communityId: comId }); reused++; continue }
        generated++
        onProgress?.(`社区报告增量: 生成 ${generated} / 复用 ${reused}（${totalComs}）`)
        const entityNameKeys = entityIds.map(eid => idToNameMap.get(eid)).filter(Boolean) as string[]
        const entityNames = entityNameKeys.map(key => globalEntities.value.get(key)?.name).filter(Boolean) as string[]
        const contextText = collectCommunityContext(entityNameKeys, entityToBlocksIndex.value, blocks.value)
        const communityName = entityNames[0] || `社区${comId}`
        if (!contextText) {
            reports.push({ communityId: comId, title: communityName, summary: '', findings: [], rating: 5, signature: sig })
            continue
        }
        const prompt = buildCommunityReportPrompt({ communityName, entityNames, contextText, language: store.locales })
        let ok = false
        for (let attempt = 0; attempt < 2 && !ok; attempt++) {
            if (attempt > 0) onProgress?.(`社区报告增量: 重试 ${comId}`)
            try {
                const content = await kbChat([{ role: 'user', content: prompt }])
                const parsed = safeParseLlmJson(content)
                if (!parsed) throw new Error('无法解析社区报告 JSON')
                reports.push({
                    communityId: comId, title: parsed.title || communityName, summary: parsed.summary || '',
                    findings: parsed.findings || [], rating: parsed.rating ?? 5, signature: sig,
                })
                ok = true
            } catch (e) {
                if (attempt === 1) {
                    console.error(`社区 ${comId} 报告增量生成失败:`, e)
                    reports.push({ communityId: comId, title: communityName, summary: '', findings: [], rating: 5, signature: sig })
                }
            }
        }
        communityReports.value = [...reports]
    }
    communityReports.value = reports
    return { generated, reused }
}

/** 增量更新主流程：检测 → 切片 → 文件摘要 → 本体 → 社区 → 报告（prep-status-panel 展示） */
const runIncrementalUpdate = async () => {
    if (incrementalRunning.value) return
    if (!store.root) { ElMessage.warning(store.locales === 'zh' ? '请先选择知识库文件夹' : 'Select a KB folder first'); return }
    incrementalRunning.value = true
    resetPrepState()
    prepState.active = true
    const zh = (s: string, e: string) => (store.locales === 'zh' ? s : e)
    prepState.steps = [
        { step: zh('检测变更', 'Detect changes'), status: 'pending', detail: '' },
        { step: zh('切片增量', 'Slice'), status: 'pending', detail: '' },
        { step: zh('文件摘要', 'File summary'), status: 'pending', detail: '' },
        { step: zh('本体增量', 'Ontology'), status: 'pending', detail: '' },
        { step: zh('社区', 'Communities'), status: 'pending', detail: '' },
        { step: zh('报告增量', 'Reports'), status: 'pending', detail: '' },
    ]
    try {
        // 1. 检测变更
        setPrepStep(0, 'running', zh('扫描文件...', 'Scanning files...'))
        const changes = await detectFileChanges()
        const changedFiles = [...changes.added, ...changes.modified]
        const total = changedFiles.length + changes.deleted.length
        if (total === 0) {
            setPrepStep(0, 'done', zh('无文件变更', 'No changes'))
            kb_state.value = zh('未检测到文件变更', 'No file changes detected')
            return
        }
        setPrepStep(0, 'done', zh(`新增 ${changes.added.length} / 修改 ${changes.modified.length} / 删除 ${changes.deleted.length}`, `+${changes.added.length} ~${changes.modified.length} -${changes.deleted.length}`))

        // 2. 切片（全量重切 + 向量/推理复用，增量体现在不重复计算）
        if (changedFiles.length > 0) {
            setPrepStep(1, 'running', zh('重切变更文件...', 'Re-slicing changed files...'))
            await sliceOnly(true, (d) => setPrepStep(1, 'running', d))
            setPrepStep(1, 'done', zh(`切片完成：${blocks.value.length} 个`, `Sliced: ${blocks.value.length}`))
        } else {
            setPrepStep(1, 'done', zh('无切片变更', 'No slice change'))
        }

        // 3. 文件摘要（summarize_file 原语，fileIndex 幂等增量）
        if (changedFiles.length > 0) {
            setPrepStep(2, 'running', zh('生成变更文件的摘要...', 'Summarizing changed files...'))
            const ingestCtx: IngestionContext = {
                blocks: blocks.value as any,
                config: { url: model.value.url, embed: model.value.embed, chat: model.value.chat, process: model.value.process, processPrompt: model.value.processPrompt, fileSummaryPrompt: getConfiguredIngestPrompt('fileSummaryPrompt') || undefined, think: model.value.think },
                services: kbAi.buildIngestionServices(buildKbSpec(), {
                    // 推理摘要写回文件 frontmatter（持久化）
                    syncFileSummary: (fp: string, s: string) => syncFileSummaryToFrontmatter(fp, s),
                }),
                fileIndex: fileIndex.value as Map<string, any>,
                onProgress: (msg) => setPrepStep(2, 'running', msg),
                isCancelled: () => !incrementalRunning.value,
            }
            const fs = await summarizeFile(ingestCtx, {})
            setPrepStep(2, 'done', zh(`摘要：成功 ${fs.processed} / 失败 ${fs.failed}`, `Summary: ok ${fs.processed} / fail ${fs.failed}`))
        } else {
            setPrepStep(2, 'done', zh('无摘要变更', 'No summary change'))
        }

        // 4. 本体增量
        if (changedFiles.length > 0 || changes.deleted.length > 0) {
            setPrepStep(3, 'running', zh('本体增量抽取与清理...', 'Incremental ontology...'))
            await incrementalExtractEntities(changedFiles, changes.deleted, (d) => setPrepStep(3, 'running', d))
            setPrepStep(3, 'done', zh(`本体：${globalEntities.value.size} 实体`, `Ontology: ${globalEntities.value.size} entities`))
        } else {
            setPrepStep(3, 'done', zh('无本体变更', 'No ontology change'))
        }

        // 5. 社区（全量重跑 Louvain，毫秒级）
        setPrepStep(4, 'running', zh('重跑社区检测...', 'Re-running communities...'))
        detectCommunities()
        setPrepStep(4, 'done', zh(`社区：${communityResult.value?.count ?? 0} 个`, `Communities: ${communityResult.value?.count ?? 0}`))

        // 6. 报告增量
        if (communityResult.value && communityResult.value.count > 0) {
            setPrepStep(5, 'running', zh('社区报告增量更新...', 'Updating community reports...'))
            const r = await incrementalCommunityReports((d) => setPrepStep(5, 'running', d))
            setPrepStep(5, 'done', zh(`报告：生成 ${r.generated} / 复用 ${r.reused}`, `Reports: gen ${r.generated} / reuse ${r.reused}`))
        } else {
            setPrepStep(5, 'done', zh('无社区', 'No communities'))
        }

        await refreshBuildManifest()
        // 增量处理已应用：清除文件标签页的变更标记（新增/修改/删除已同步到知识库）
        fileChanges.value = { added: [], modified: [], deleted: [] }
        try { scheduleRefreshAtlas(120) } catch (e) {}
        kb_state.value = zh('增量更新完成', 'Incremental update done')
    } catch (error) {
        console.error('增量更新失败:', error)
        kb_state.value = zh('增量更新失败', 'Incremental update failed')
    } finally {
        prepState.active = false
        incrementalRunning.value = false
        // 增量更新会重建切片/文件摘要，结束后刷新摘要状态
        scanSummaryStatus()
    }
}

/** 打开 KB 后自动检测：有变更 → prep-status-panel 展示并执行增量更新 */
const autoCheckIncremental = async () => {
    if (!store.root || !buildManifest.value || Object.keys(buildManifest.value).length === 0) return
    if (incrementalRunning.value) return
    // 知识库(.kb)来自其他文件夹（不在当前工作区）时，buildManifest 记录的是原文件夹的路径，
    // 与当前工作区文件无交集，增量比对必然全量"变更"。跳过自动更新，避免误触发整库重切片/重嵌入/重构建。
    const rootNorm = String(store.root).replace(/\\/g, '/').replace(/\/+$/, '')
    const manifestUnderRoot = Object.keys(buildManifest.value).some((p) =>
        String(p).replace(/\\/g, '/').startsWith(rootNorm + '/')
    )
    if (!manifestUnderRoot) return
    const changes = await detectFileChanges()
    const total = changes.added.length + changes.modified.length + changes.deleted.length
    if (total === 0) return

    // 打开/选择知识库后检测到更新：先提示用户，可选择「立即处理」或「跳过」
    // （避免打开旧知识库时自动触发切片/摘要/本体/社区报告等大量 LLM 处理）
    kb_state.value = store.locales === 'zh'
        ? `检测到 ${total} 个文件变更`
        : `${total} file changes detected`
    try {
        const action = await ElMessageBox.confirm(
            store.locales === 'zh'
                ? `检测到知识库更新：新增 ${changes.added.length} 个 / 修改 ${changes.modified.length} 个 / 删除 ${changes.deleted.length} 个文件。是否立即处理？`
                : `Knowledge base update detected: +${changes.added.length} added / ~${changes.modified.length} modified / -${changes.deleted.length} deleted. Process now?`,
            store.locales === 'zh' ? '知识库更新' : 'KB Update',
            {
                confirmButtonText: store.locales === 'zh' ? '立即处理' : 'Process',
                cancelButtonText: store.locales === 'zh' ? '跳过' : 'Skip',
                type: 'info',
                distinguishCancelAndClose: true,
            }
        )
        if (action !== 'confirm') {
            kb_state.value = store.locales === 'zh'
                ? '已跳过知识库更新处理，可点击切片中的「增量更新」按钮手动处理'
                : 'KB update skipped; use the "Incremental update" button to process manually'
            return
        }
    } catch {
        // 用户点击右上角 X 关闭对话框 → 同样视为跳过
        kb_state.value = store.locales === 'zh'
            ? '已跳过知识库更新处理，可点击切片中的「增量更新」按钮手动处理'
            : 'KB update skipped; use the "Incremental update" button to process manually'
        return
    }
    kb_state.value = store.locales === 'zh'
        ? `检测到 ${total} 个文件变更，正在增量更新...`
        : `${total} file changes detected, running incremental update...`
    await runIncrementalUpdate()
}

const pipelineChat = async function(strategyId: string, prompt: string, method: string = 'similarity') {
    // 提问前自动完成切片/向量化（未就绪时）
    if (!(await ensureKbReady())) return false
    result.value = store.locales == 'zh' ? "正在思考..." : 'Thinking...'
    
    const queryEmbeddings = await kbEmbed(prompt);
    const queryEmbedding = queryEmbeddings?.[0];
    
    try {
        // 统一走策略框架：dense_score + 可选的 entity_link/graph_hop/boost 由 runStrategy 完成
        const ctx = buildRetrievalContext(prompt)
        sr = await runStrategy(strategyId, prompt, ctx, {
            onProgress: (msg: string) => { kb_state.value = msg }
        })
        for (let i = 0; i < blocks.value.length; i++) {
            blocks.value[i].p = sr.scores.get(blocks.value[i].id) || 0
        }

        blocks.value.sort((a:any,b:any) => (b.p||0) - (a.p||0))
    } catch (err) {
        console.error('相似度计算失败:', err)
        for (let i = 0; i < blocks.value.length; i++) {
            if (blocks.value[i].A_vector && queryEmbedding) {
                try {
                    blocks.value[i].p = cosineSimilarity(queryEmbedding, blocks.value[i].A_vector)
                } catch (e) {
                    blocks.value[i].p = 0
                }
            } else {
                blocks.value[i].p = 0
            }
        }
        blocks.value.sort((a:any,b:any) => (b.p||0) - (a.p||0))
    }

    const allVectors = [];
    const allBlocks = [] as Array<{ 
        originalIndex: number, 
        type: 'A' | 'Q', 
        label: string, 
        content: string 
    }>;
    
    blocks.value.forEach((b: any, index: number) => {
        allVectors.push(b.A_vector);
        allBlocks.push({
            originalIndex: index,
            type: 'A',
            label: b.label,
            content: b.A
        });
    });
    
    allVectors.push(queryEmbedding);
    
    if (model.value.searchMethod === "MDS") {
        const mdsResult = computeMDS(allVectors, model.value.mdsIterations, model.value.mdsEpsilon);
        processDimensionalityReductionResults(mdsResult);
    } else if(model.value.searchMethod === "MDS(M)") {
        const mergedVectors = await computeMergedEmbeddings();
        mergedVectors.push(queryEmbedding);
        const mdsResult = computeMDS(mergedVectors, model.value.mdsIterations, model.value.mdsEpsilon);
        processMergedDimensionalityReductionResults(mdsResult);
    } else if(model.value.searchMethod === "PCA") {
        const pcaResult = computePCA(allVectors);
        processDimensionalityReductionResults(pcaResult);
    } else if (model.value.searchMethod === "CS(M)") {
        const mergedVectors = await computeMergedEmbeddings();
        for(let i = 0; i < blocks.value.length; i++) {
            blocks.value[i].p = cosineSimilarity(queryEmbedding, mergedVectors[i]);
        }
    }
    
    blocks.value.sort((a: any, b: any) => b.p - a.p);
    
    let history = [];
    let content = prompt + ((store.locales == "zh") ? 
        '。请根据参考资料解决以上问题，如果不相关可以忽略后续资料。' : 
        '. Please solve the above problems based on the reference materials. If they are not relevant, you can ignore the subsequent materials.');
    let num = 0;
    
    blocks.value.forEach((b:any) => b.state = false);
    
    if(model.value.searchMode == "按数量"){
        for (let i = 0; i < Math.min(model.value.searchNum, blocks.value.length); i++) {
            content += "《" + blocks.value[i].label + "》：";
            content += blocks.value[i].A + "。";
            blocks.value[i].state = true;
            num++;
        }
    } else if(model.value.searchMode == "按匹配率"){
        for (let i = 0; i < blocks.value.length; i++) {
            if(blocks.value[i].p >= model.value.matchRatio) {
                content += "《" + blocks.value[i].label + "》：";
                content += blocks.value[i].A + "。";
                blocks.value[i].state = true;
                num++;
            } else {
                break;
            }
        }
    } else if(model.value.searchMode == "按字符"){
        let currentLength = content.length;
        for (let i = 0; i < blocks.value.length; i++) {
            const blockContent = "《" + blocks.value[i].label + "》：" + blocks.value[i].A + "。";
            if (currentLength + blockContent.length <= model.value.searchCharacter) {
                content += blockContent;
                currentLength += blockContent.length;
                blocks.value[i].state = true;
                num++;
            } else {
                break;
            }
        }
    }
    
    console.log(content);
    if (viewMode.value === 'atlas') {
        if (atlasModuleRef.value) {
            setTimeout(() => {
                atlasModuleRef.value.refreshAtlas()
            }, 100)
        }
    }
    result.value = store.locales == 'zh' ? 
        `正在思考，查询到${num}个资料。` : 
        `Thinking and found ${num} pieces of data.`;

    // 收集当前问答的佐证切片（state=true 的被使用切片）
    const sliceEvidence = blocks.value
        .filter((b: any) => b.state)
        .slice(0, 10)
        .map((b: any) => ({
            id: b.id,
            label: b.label || '',
            filePath: b.filePath || '',
            content: b.A || '',
            score: b.p || 0,
            method: method
        }))

    // 推理路径佐证（多跳策略）排在前面，切片佐证跟在后面
    const pathEvidence = (sr?.meta?.paths || []).slice(0, 10).map((p: string, i: number) => ({
        id: `hop-path-${i}`,
        label: store.locales === 'zh' ? `推理路径 ${i + 1}` : `Path ${i + 1}`,
        filePath: '',
        content: p,
        score: 0,
        method: 'multiHop',
        reason: sr?.meta?.matchedEntities?.[0]
            ? (store.locales === 'zh' ? `从「${sr.meta.matchedEntities[0]}」出发` : `from "${sr.meta.matchedEntities[0]}"`)
            : ''
    }))
    // 异构路径佐证（方案C：实体 → 切片 → 文件）
    const heteroEvidence = (sr?.meta?.heteroPaths || []).slice(0, 10).map((p: string, i: number) => ({
        id: `hetero-path-${i}`,
        label: store.locales === 'zh' ? `异构路径 ${i + 1}` : `Hetero Path ${i + 1}`,
        filePath: '',
        content: p,
        score: 0,
        method: 'multiHop',
        reason: store.locales === 'zh' ? '实体 → 切片 → 文件' : 'entity → slice → file'
    }))
    currentEvidence.value = filterEvidenceTopK(method === 'multiHop' ? [...heteroEvidence, ...pathEvidence, ...sliceEvidence] : sliceEvidence, model.value.evidenceTopK)

    history.push({ role: 'user', content: content });
    result.value = "";
    await kbStreamChat(history, (chunk) => {
        result.value += chunk;
    }, { think: model.value.think });
    
    return true;

    function processDimensionalityReductionResults(points: number[][]) {
        const queryPoint = points[points.length - 1];
        const blockSimilarities = new Map<number, number[]>();
        
        for(let i = 0; i < allBlocks.length; i++) {
            const originalIndex = allBlocks[i].originalIndex;
            const point = points[i];
            
            const dx = point[0] - queryPoint[0];
            const dy = point[1] - queryPoint[1];
            const distance = Math.sqrt(dx * dx + dy * dy);
            const similarity = 1 / (1 + distance);
            
            if(!blockSimilarities.has(originalIndex)) {
                blockSimilarities.set(originalIndex, []);
            }
            blockSimilarities.get(originalIndex)!.push(similarity);
        }
        
        blocks.value.forEach((block:any, index:any) => {
            const similarities = blockSimilarities.get(index) || [];
            block.p = similarities.length > 0 ? 
                similarities.reduce((a, b) => a + b, 0) / similarities.length : 
                0;
        });
    }
    
    async function computeMergedEmbeddings() {
        // 方案 A：切片不再拼问题文本；合并向量 = 切片内容向量 A_vector（已预计算，缺失时才补 embed）
        const mergedVectors = [];
        for (const block of blocks.value) {
            if (block.A_vector && block.A_vector.length) mergedVectors.push(block.A_vector)
            else {
                const embeddings = await kbEmbed(block.A || '')
                mergedVectors.push(embeddings?.[0])
            }
        }
        return mergedVectors;
    }

    function processMergedDimensionalityReductionResults(points: number[][]) {
        const queryPoint = points[points.length - 1];
            
        for(let i = 0; i < blocks.value.length; i++) {
            const point = points[i];
            const dx = point[0] - queryPoint[0];
            const dy = point[1] - queryPoint[1];
            const distance = Math.sqrt(dx * dx + dy * dy);
            blocks.value[i].p = 1 / (1 + distance);
        }
    }
}

// 构造检索上下文（供策略框架 runStrategy 使用；适配器绑定当前模型/服务）
const buildRetrievalContext = (query: string): RetrievalContext => {
    const modelCfg = model.value
    return {
        query,
        blocks: blocks.value,
        entities: Array.from(globalEntities.value.values()).map((e: any) => ({
            id: e.id,
            name: e.name,
            type: e.nodeType,
            description: e.description,
        })),
        relations: Array.from(globalRelations.value.values()).map((r: any) => ({
            source: r.source,
            target: r.target,
            type: r.type,
        })),
        entityToBlocksIndex: entityToBlocksIndex.value,
        communityReports: communityReports.value,
        communityResult: communityResult.value as any,
        fileIndex: fileIndex.value as Map<string, any>,
        // 问题增强索引：问题库 → 关联切片（dense_score 的问题增强分 max 池化）
        questionVectorsByBlock: questionVectorsByBlockIndex(),
        config: {
            url: modelCfg.url,
            embed: modelCfg.embed,
            chat: modelCfg.chat,
            process: modelCfg.process,
            locale: store.locales,
            summaryWeight: modelCfg.summaryWeight ?? 0.7,
            bm25Enabled: modelCfg.bm25Enabled || false,
            bm25Weight: modelCfg.bm25Weight || 0.3,
            bm25K1: modelCfg.bm25K1,
            bm25B: modelCfg.bm25B,
            searchNum: modelCfg.searchNum || 5,
            think: modelCfg.think,
            agentSubQueryWeight: modelCfg.agentSubQueryWeight ?? 0.3,
        },
        services: kbAi.buildRetrievalServices(buildKbSpec(), { cosineSimilarity, computeBM25: computeBM25Score }),
    }
}

// ====== Agentic RAG（LLM 自主多轮检索，参照集群的 kb_search 方案） ======
/** Agentic 检索：LLM 自主路由检索原语（OAG-RAG，检索循环在策略框架 runStrategy('agentic') 内） */
const agenticChat = async function(prompt: string) {
    if (!prompt) return
    // 提问前自动完成切片/向量化（未就绪时）
    if (!(await ensureKbReady())) return
    if (!blocks.value.length) {
        ElMessage.warning(store.locales == 'zh' ? '请先加载知识库' : 'Please load the knowledge base first')
        return
    }
    result.value = store.locales == 'zh' ? '正在规划检索策略...' : 'Planning retrieval strategy...'
    currentEvidence.value = []
    agentSteps.value = []
    let streamStarted = false
    const ctx = buildRetrievalContext(prompt)
    const sr = await runStrategy('agentic', prompt, ctx, {
        onProgress: (msg: string) => { kb_state.value = msg },
        onStream: (chunk: string) => {
            if (!streamStarted) { streamStarted = true; result.value = '' }
            result.value += chunk
        },
        onEvidence: (evidence: any[]) => { currentEvidence.value = pickTopKByScore(evidence, model.value.evidenceTopK) },
        onAgentStep: (step) => {
            // 每次工具调用都独立追加一条（支持同一轮内同一个工具被多次调用，如并行检索多个定义）；
            // running 追加新条目，done/error 从后往前回填最近一条同轮同工具仍为 running 的条目
            if (step.status === 'running') {
                agentSteps.value.push(step)
                return
            }
            for (let i = agentSteps.value.length - 1; i >= 0; i--) {
                const s = agentSteps.value[i]
                if (s.round === step.round && s.tool === step.tool && s.status === 'running') {
                    agentSteps.value[i] = step
                    return
                }
            }
            // 兜底：未找到对应 running 条目（异常顺序）时直接追加
            agentSteps.value.push(step)
        },
    })
    return !!sr
}

// ====== 多路混合（hybrid）：确定性多通道召回 + 统一排序 ======
const hybridChat = async function(strategyId: string, prompt: string) {
    if (!prompt) return
    // 提问前自动完成切片/向量化（未就绪时）
    if (!(await ensureKbReady())) return
    if (!blocks.value.length) {
        ElMessage.warning(store.locales == 'zh' ? '请先加载知识库' : 'Please load the knowledge base first')
        return
    }
    result.value = store.locales == 'zh' ? '正在多路召回...' : 'Multi-channel recall...'
    currentEvidence.value = []
    let streamStarted = false
    const ctx = buildRetrievalContext(prompt)
    const sr = await runStrategy(strategyId, prompt, ctx, {
        onProgress: (msg: string) => { kb_state.value = msg },
        onStream: (chunk: string) => {
            if (!streamStarted) { streamStarted = true; result.value = '' }
            result.value += chunk
        },
        // hybrid 的证据已按原始问题统一重排，取全局分数 topK
        onEvidence: (evidence: any[]) => { currentEvidence.value = pickTopKByScore(evidence, model.value.evidenceTopK) },
    })
    // 兜底：流式未启动但已有答案（如无流式服务）
    if (!streamStarted && sr.answer) {
        result.value = sr.answer
    }
    return !!sr
}


function computeMDS(vectors: number[][], iterations: number, epsilon: number): number[][] {
    const n = vectors.length;
    if (n === 0) return [];
    
    const distances = Matrix.zeros(n, n);
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            distances.set(i, j, 1 - cosineSimilarity(vectors[i], vectors[j]));
        }
    }
    
    const H = Matrix.eye(n).sub(Matrix.ones(n, n).mul(1 / n));
    
    const D2 = Matrix.zeros(n, n);
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            const val = distances.get(i, j);
            D2.set(i, j, val * val);
        }
    }
    
    const B = H.mmul(D2).mmul(H).mul(-0.5);
    
    const svd = new SingularValueDecomposition(B);
    const U = svd.leftSingularVectors;
    const s = svd.diagonal;
    
    const sqrtS = Matrix.zeros(n, n);
    for (let i = 0; i < s.length; i++) {
        sqrtS.set(i, i, Math.sqrt(Math.max(s[i], 0)));
    }
    
    const X = U.mmul(sqrtS);
    
    const result: number[][] = [];
    for (let i = 0; i < n; i++) {
        result.push([X.get(i, 0), X.get(i, 1)]);
    }
    
    return result;
}

function computePCA(vectors: number[][]): number[][] {
    const n = vectors.length;
    if (n === 0) return [];
    
    const matrix = new Matrix(vectors);
    
    const means = [];
    for (let j = 0; j < matrix.columns; j++) {
        let sum = 0;
        for (let i = 0; i < matrix.rows; i++) {
            sum += matrix.get(i, j);
        }
        means[j] = sum / matrix.rows;
    }
    
    for (let i = 0; i < matrix.rows; i++) {
        for (let j = 0; j < matrix.columns; j++) {
            matrix.set(i, j, matrix.get(i, j) - means[j]);
        }
    }
    
    const covMatrix = matrix.transpose().mmul(matrix).mul(1 / (matrix.rows - 1));
    
    const svd = new SingularValueDecomposition(covMatrix);
    const eigenvectors = svd.leftSingularVectors;
    
    const result: number[][] = [];
    for (let i = 0; i < matrix.rows; i++) {
        const row = matrix.getRow(i);
        const pc1 = row.reduce((sum, val, j) => sum + val * eigenvectors.get(j, 0), 0);
        const pc2 = row.reduce((sum, val, j) => sum + val * eigenvectors.get(j, 1), 0);
        result.push([pc1, pc2]);
    }
    
    return result;
}

const save = async function(){
    const now = new Date();
    const timestamp = `${now.getFullYear()}-${(now.getMonth()+1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}-${now.getMinutes().toString().padStart(2, '0')}-${now.getSeconds().toString().padStart(2, '0')}`;
    
    // 精简模式：关闭「保存向量数据」时，不把向量写入 .kb（切片/文件摘要/问题向量），
    // 首次问答用当前嵌入模型按需重新推导（模块内 ensureKbReady 与外部 kbRetrieval 均已支持懒补全）
    const persistVectors = model.value.saveVectors !== false
    
    // 弹出输入框获取知识库名称（而非默认保存为时间名）
    let kbFileName = `${timestamp}.kb`
    try {
        const { value } = await ElMessageBox.prompt(
            store.locales === 'zh' ? '请输入知识库名称：' : 'Enter knowledge base name:',
            store.locales === 'zh' ? '保存知识库' : 'Save Knowledge Base',
            {
                confirmButtonText: store.locales === 'zh' ? '保存' : 'Save',
                cancelButtonText: store.locales === 'zh' ? '取消' : 'Cancel',
                inputPlaceholder: store.locales === 'zh' ? '知识库名称' : 'KB name',
                inputValidator: (v: string) => {
                    if (!v || !v.trim()) return store.locales === 'zh' ? '名称不能为空' : 'Name is required'
                    return true
                }
            }
        )
        const name = (value || '').trim()
        if (name) kbFileName = `${name.replace(/[\\/:*?"<>|]/g, '_')}.kb`
    } catch {
        return // 用户取消保存
    }
    
    const fileSummaryData = {} as any
    fileSummaries.value.forEach((value: any, key: string) => {
        fileSummaryData[key] = {
            content: value.content,
            // 精简模式：文件摘要向量不落盘（检索时按需重新向量化）
            ...(persistVectors ? { vector: value.vector } : {})
        }
    })
    
    const fileIndexData = {} as any
    fileIndex.value.forEach((value: any, key: string) => {
        fileIndexData[key] = {
            content: value.content,
            // 精简模式：文件级摘要索引向量不落盘
            ...(persistVectors ? { vector: value.vector } : {}),
            contentHash: value.contentHash
        }
    })
    
    const extractProgressData = extractProgress.value.isPaused ? {
        currentIndex: extractProgress.value.currentIndex,
        totalCount: extractProgress.value.totalCount,
        startTime: extractProgress.value.startTime,
        isPaused: true
    } : (extractProgress.value.isRunning ? {
        currentIndex: extractProgress.value.currentIndex,
        totalCount: extractProgress.value.totalCount,
        startTime: extractProgress.value.startTime,
        isRunning: true
    } : null)
    
    const buildProgressData = (buildProgress.value.isPaused || buildProgress.value.isRunning) ? {
        currentBatchIndex: buildProgress.value.currentBatchIndex,
        totalBatches: buildProgress.value.totalBatches,
        currentFileIndex: buildProgress.value.currentFileIndex,
        totalFiles: buildProgress.value.totalFiles,
        currentBatchInFile: buildProgress.value.currentBatchInFile,
        totalBatchesInFile: buildProgress.value.totalBatchesInFile,
        startTime: buildProgress.value.startTime,
        isPaused: buildProgress.value.isPaused,
        isRunning: buildProgress.value.isRunning,
        savedOntologyState: {
            entities: Array.from(globalEntities.value.entries()).map(([key, entity]) => ({
                key: key,
                id: entity.id,
                name: entity.name,
                type: entity.type,
                nodeType: entity.nodeType,
                layer: entity.layer,
                description: entity.description,
                associatedBlocks: entity.associatedBlocks,
                associatedFiles: entity.associatedFiles
            })),
            relations: Array.from(globalRelations.value.entries()).map(([key, relation]) => ({
                key: key,
                id: relation.id,
                source: relation.source,
                target: relation.target,
                type: relation.type,
                layer: relation.layer,
                description: relation.description,
                sourceBlocks: relation.sourceBlocks
            })),
            entityToBlocksIndex: Array.from(entityToBlocksIndex.value.entries()).map(([entityName, blockIds]) => ({
                entityName: entityName,
                blockIds: Array.from(blockIds)
            }))
        }
    } : null
    
    const ontologySaveData = {
        entities: Array.from(globalEntities.value.entries()).map(([key, entity]) => ({
            key: key,
            id: entity.id,
            name: entity.name,
            type: entity.type,
            nodeType: entity.nodeType,
            layer: entity.layer,
            description: entity.description,
            associatedBlocks: entity.associatedBlocks,
            associatedFiles: entity.associatedFiles
        })),
        relations: Array.from(globalRelations.value.entries()).map(([key, relation]) => ({
            key: key,
            id: relation.id,
            source: relation.source,
            target: relation.target,
            type: relation.type,
            layer: relation.layer,
            description: relation.description,
            sourceBlocks: relation.sourceBlocks
        })),
        entityToBlocksIndex: Array.from(entityToBlocksIndex.value.entries()).map(([entityName, blockIds]) => ({
            entityName: entityName,
            blockIds: Array.from(blockIds)
        }))
    }
    
    const saveData = {
        config: {
            embedModel: model.value.embed,
            timestamp: new Date().toISOString(),
            version: "3.0",
            // false=精简模式：向量未写入 .kb（加载时据此恢复开关并标记）
            saveVectors: persistVectors,
            summaryWeight: model.value.summaryWeight,
            sliceWeight: model.value.sliceWeight,
            ontologyBatchSize: model.value.ontologyBatchSize,
            agentSubQueryWeight: model.value.agentSubQueryWeight,
            searchConfig: {
                bm25Enabled: model.value.bm25Enabled,
                bm25Weight: model.value.bm25Weight,
                bm25K1: model.value.bm25K1,
                bm25B: model.value.bm25B,
                cosineWeight: model.value.cosineWeight,
                searchMethod: model.value.searchMethod,
                searchMode: model.value.searchMode,
                searchNum: model.value.searchNum,
                matchRatio: model.value.matchRatio,
                searchCharacter: model.value.searchCharacter,
                evidenceTopK: model.value.evidenceTopK,
                strategy: queryMethod.value,
            }
        },
        fileSummaries: fileSummaryData,
        fileIndex: fileIndexData,
        buildManifest: buildManifest.value,
        blocks: blocks.value.map((block: any) => {
            // 方案 A：切片不再保存问题相关字段（Q/Q_vector/Q_vectors），问题只存问题库
            const { fileSummaryScore, sliceScore, bm25Score, fileSummaryContent, A_overlap, Q, Q_vector, Q_vectors, A_vector, ...rest } = block
            // 精简模式：A_vector 也不写入 .kb（KB 体积大幅缩小；仅落盘剥离，内存中的向量保留）
            return persistVectors ? { ...rest, A_vector } : rest
        }),
        ontology: ontologySaveData,
        communityResult: communityResult.value ? {
            communities: Array.from(communityResult.value.communities.entries()).map(([id, ids]) => ({ id, ids })),
            assignments: Array.from(communityResult.value.assignments.entries()).map(([nodeId, comId]) => ({ nodeId, comId })),
            count: communityResult.value.count,
            modularity: communityResult.value.modularity
        } : null,
        communityReports: communityReports.value,
        testCases: testCases.value,
        // 精简模式：问题向量(qVector)不写入 .kb（内存保留；问题语义增强/首次问答按需补全）
        questions: persistVectors
            ? questionBank.value
            : questionBank.value.map((q: any) => {
                const { qVector, ...qRest } = q || {}
                return qRest
            }),
        extractProgress: extractProgressData,
        buildProgress: buildProgressData
    };
    
    window.ipcRenderer.invoke('saveFile', `${store.root}/${kbFileName}`, JSON.stringify(saveData))
        .then((success) => {
            if (success) {
                kb_state.value = persistVectors
                    ? `文件 ${kbFileName} 保存成功`
                    : (store.locales === 'zh'
                        ? `文件 ${kbFileName} 保存成功（精简模式：未写入向量数据，首次问答将重新推导）`
                        : `${kbFileName} saved (slim mode: no vectors stored, re-derived on first Q&A)`);
            } else {
                kb_state.value = '文件保存失败';
            }
        })
        .catch((error) => {
            console.error(error);
            kb_state.value = '文件保存出错';
        })
    await scanKnowledgeBases()
}

const loadKnowledgeBases = async function(index?: number) {
    const loadIndex = index !== undefined ? index : selectedKbIndex.value
    
    if (knowledgeBases.value.length === 0 || loadIndex < 0 || loadIndex >= knowledgeBases.value.length) {
        kb_state.value = store.locales === 'zh' ? '没有可用的知识库文件' : 'No knowledge base files available'
        return
    }
    
    const kbFile = knowledgeBases.value[loadIndex]

    // 自动知识库：使用当前文件夹自动切片/向量化构建的数据（问答时自动准备，也可手动处理）
    if ((kbFile as any).auto) {
        // 重新选择自动知识库时，清除所有切片/文件摘要/本体/社区/报告/测试用例等，与初始化进入模块一致
        resetKbState()
        // 刷新当前文件夹文件列表（不切块），等同 init 入口行为
        if (store.root) {
            try { await loadFolderFiles(store.root, false) } catch (e) { console.warn('刷新文件列表失败:', e) }
        }
        viewMode.value = 'qa'
        isKbLoaded.value = false
        kb_state.value = store.locales === 'zh'
            ? '已切换到自动知识库：问答将自动切片/向量化，也可手动处理'
            : 'Auto KB: QA will auto-slice/embed, or process manually'
        return
    }

    try {
        const content = await window.ipcRenderer.invoke('readFile', kbFile.path)
        const saveData = JSON.parse(content)
        
        const version = saveData.config?.version || "1.0"
        
        if (version !== "3.0" && version !== "2.5" && version !== "2.4") {
            throw new Error(`不支持的知识库版本: ${version}，请使用版本 2.4+ 的知识库文件`)
        }
        
        if (!saveData.blocks || !saveData.config || !saveData.fileSummaries) {
            throw new Error('知识库文件格式错误')
        }
        
        fileSummaries.value.clear()
        Object.entries(saveData.fileSummaries).forEach(([key, value]: [string, any]) => {
            fileSummaries.value.set(key, {
                content: value.content,
                vector: value.vector
            })
        })
        
        // 恢复文件级摘要索引（方案B）
        fileIndex.value.clear()
        if (saveData.fileIndex) {
            Object.entries(saveData.fileIndex).forEach(([key, value]: [string, any]) => {
                fileIndex.value.set(key, {
                    content: value.content,
                    vector: value.vector,
                    contentHash: value.contentHash
                })
            })
        }
        // 恢复构建清单（增量变更检测基准）
        buildManifest.value = saveData.buildManifest || {}
        
        blocks.value = saveData.blocks
        isKbLoaded.value = true
        resetScrollLoad()
        
        if (saveData.config.embedModel) {
            model.value.embed = saveData.config.embedModel
            // .kb 自带的嵌入模型（与已存向量维度一致）：锁定，避免被设置页默认自动覆盖
            embedPinned.value = true
        } else {
            embedPinned.value = false
        }
        if (saveData.config.summaryWeight !== undefined) {
            model.value.summaryWeight = saveData.config.summaryWeight
        }
        if (saveData.config.sliceWeight !== undefined) {
            model.value.sliceWeight = saveData.config.sliceWeight
        }
        // 精简模式开关：.kb 记录了 saveVectors=false 时恢复（后续保存默认仍不写向量）
        if (saveData.config.saveVectors !== undefined) {
            model.value.saveVectors = saveData.config.saveVectors !== false
        }
        if (saveData.config.ontologyBatchSize !== undefined) {
            model.value.ontologyBatchSize = saveData.config.ontologyBatchSize
        }
        if (saveData.config.agentSubQueryWeight !== undefined) {
            model.value.agentSubQueryWeight = saveData.config.agentSubQueryWeight
        }
        
        if (saveData.config.searchConfig) {
            const sc = saveData.config.searchConfig
            if (sc.bm25Enabled !== undefined) model.value.bm25Enabled = sc.bm25Enabled
            if (sc.bm25Weight !== undefined) model.value.bm25Weight = sc.bm25Weight
            if (sc.bm25K1 !== undefined) model.value.bm25K1 = sc.bm25K1
            if (sc.bm25B !== undefined) model.value.bm25B = sc.bm25B
            if (sc.cosineWeight !== undefined) model.value.cosineWeight = sc.cosineWeight
            if (sc.searchMethod !== undefined) model.value.searchMethod = sc.searchMethod
            if (sc.searchMode !== undefined) model.value.searchMode = sc.searchMode
            if (sc.searchNum !== undefined) model.value.searchNum = sc.searchNum
            if (sc.matchRatio !== undefined) model.value.matchRatio = sc.matchRatio
            if (sc.searchCharacter !== undefined) model.value.searchCharacter = sc.searchCharacter
            if (sc.evidenceTopK !== undefined) model.value.evidenceTopK = sc.evidenceTopK
            // 优先使用 .kb 保存的检索策略；策略名称对应不上时回退相似度
            if (sc.strategy !== undefined) {
                queryMethod.value = getEnabledStrategies().some(s => s.id === sc.strategy) ? sc.strategy : 'similarity'
            }
        }
        
        if (saveData.ontology) {
            globalEntities.value.clear()
            globalRelations.value.clear()
            entityToBlocksIndex.value.clear()
            
            for (const entityData of saveData.ontology.entities) {
                const entity: OntologyEntity = {
                    id: entityData.id,
                    name: entityData.name,
                    type: entityData.type || 'entity',
                    nodeType: entityData.nodeType || entityData.type || 'entity',
                    layer: entityData.layer || 'data',
                    description: entityData.description,
                    associatedBlocks: entityData.associatedBlocks,
                    associatedFiles: entityData.associatedFiles
                }
                globalEntities.value.set(entityData.key || entityData.name.toLowerCase(), entity)
            }
            
            for (const relationData of saveData.ontology.relations) {
                const relation: OntologyRelation = {
                    id: relationData.id,
                    source: relationData.source,
                    target: relationData.target,
                    type: relationData.type,
                    layer: relationData.layer,
                    description: relationData.description,
                    sourceBlocks: relationData.sourceBlocks || []
                }
                globalRelations.value.set(relationData.key, relation)
            }
            
            for (const indexData of saveData.ontology.entityToBlocksIndex || []) {
                entityToBlocksIndex.value.set(indexData.entityName, new Set(indexData.blockIds))
            }
            
            // 恢复社区检测结果
            if (saveData.communityResult) {
                const communities = new Map<number, string[]>()
                for (const { id, ids } of (saveData.communityResult.communities || [])) {
                    communities.set(id, ids)
                }
                const assignments = new Map<string, number>()
                for (const { nodeId, comId } of (saveData.communityResult.assignments || [])) {
                    assignments.set(nodeId, comId)
                }
                communityResult.value = {
                    communities,
                    assignments,
                    count: saveData.communityResult.count || communities.size,
                    modularity: saveData.communityResult.modularity ?? 0
                }
            }

            // 恢复社区报告
            if (saveData.communityReports) {
                communityReports.value = saveData.communityReports
            }

            // 恢复测试用例（若 .kb 中保存了；旧文件无 refs 字段时归一为 []，测试页退化为文本匹配）
            // source 记录该测试集是「问题库派生」还是「外部 Excel 导入的独立测试集」
            if (saveData.testCases) {
                const tc = saveData.testCases as any
                testCases.value = {
                    questions: tc.questions || [],
                    answers: tc.answers || [],
                    refs: Array.isArray(tc.refs) ? tc.refs : [],
                    source: tc.source === 'external' ? 'external' : 'bank',
                }
            }

            // 恢复问题库（若 .kb 保存了 questions；旧库无此字段则从切片 Q 向后兼容重建）
            // 方案 A：问题库只从 .kb 的 questions 字段恢复（旧库无该字段 → 为空，不再从切片重建）
            if (saveData.questions && Array.isArray(saveData.questions)) {
                questionBank.value = saveData.questions as KbQuestion[]
                for (const q of questionBank.value) {
                    const m = /(\d+)$/.exec(q.id || '')
                    if (m) qSeq = Math.max(qSeq, Number(m[1]))
                }
            } else {
                questionBank.value = []
            }
            // 剥离旧 .kb 切片上遗留的问题字段（Q/Q_vector/Q_vectors），统一由问题库承载
            for (const b of saveData.blocks || []) {
                if (!b) continue
                delete b.Q; delete b.Q_vector; delete b.Q_vectors
            }

            // 恢复本体数据和社区数据后再更新视图（确保 communityId 能写入节点）
            updateOntologyViewer()
            updateEntityCards()
            // 知识库概况（本体/社区等）由问答页底部状态栏显示，此处不再弹通知
        } else {
            kb_state.value = (store.locales === 'zh' ? 
                `已加载知识库: ${kbFile.label}` : 
                `Loaded knowledge base: ${kbFile.label}`)
        }
        
        if (saveData.extractProgress && saveData.extractProgress.currentIndex > 0 && saveData.extractProgress.currentIndex < saveData.extractProgress.totalCount) {
            extractProgress.value = {
                isRunning: false,
                isPaused: true,
                currentIndex: saveData.extractProgress.currentIndex,
                totalCount: saveData.extractProgress.totalCount,
                startTime: saveData.extractProgress.startTime
            }
            saveExtractProgress()
            kb_state.value += (store.locales === 'zh' ? 
                `，检测到未完成的问题提取进度，可点击"继续"恢复` : 
                `, unfinished extraction progress detected, click "Resume" to continue`)
        } else {
            clearExtractProgress()
        }
        
        if (saveData.buildProgress && saveData.buildProgress.currentBatchIndex > 0 && saveData.buildProgress.currentBatchIndex < saveData.buildProgress.totalBatches) {
            if (saveData.buildProgress.savedOntologyState) {
                globalEntities.value.clear()
                globalRelations.value.clear()
                entityToBlocksIndex.value.clear()
                
                for (const entityData of saveData.buildProgress.savedOntologyState.entities) {
                    const entity: OntologyEntity = {
                        id: entityData.id,
                        name: entityData.name,
                        type: entityData.type || 'entity',
                        nodeType: entityData.nodeType || entityData.type || 'entity',
                        layer: entityData.layer || 'data',
                        description: entityData.description,
                        associatedBlocks: entityData.associatedBlocks,
                        associatedFiles: entityData.associatedFiles
                    }
                    globalEntities.value.set(entityData.key, entity)
                }
                
                for (const relationData of saveData.buildProgress.savedOntologyState.relations) {
                    const relation: OntologyRelation = {
                        id: relationData.id,
                        source: relationData.source,
                        target: relationData.target,
                        type: relationData.type,
                        layer: relationData.layer,
                        description: relationData.description,
                        sourceBlocks: relationData.sourceBlocks
                    }
                    globalRelations.value.set(relationData.key, relation)
                }
                
                for (const indexData of saveData.buildProgress.savedOntologyState.entityToBlocksIndex) {
                    entityToBlocksIndex.value.set(indexData.entityName, new Set(indexData.blockIds))
                }
                
                updateOntologyViewer()
                updateEntityCards()
            }
            
            // 与「问题提取」一致：加载到未完成/进行中的本体构建进度时不自动继续，
            // 统一恢复为「可恢复（暂停）」状态，等待用户在底部状态栏或「百科」页点击「继续」后再运行。
            const savedRun = saveData.buildProgress.isRunning === true || saveData.buildProgress.isPaused === true
            // 旧版 bug 残留：批次索引 ≥ 总批次数（已完成/越界如 20/19）→ 视为“已完成”，不再进入可恢复状态
            const staleDone = (saveData.buildProgress.totalBatches || 0) > 0
                && (saveData.buildProgress.currentBatchIndex || 0) >= saveData.buildProgress.totalBatches
            const resumable = savedRun && !staleDone
            
            if (resumable) {
                buildProgress.value = {
                    isRunning: true,
                    isPaused: true,
                    currentBatchIndex: saveData.buildProgress.currentBatchIndex,
                    totalBatches: saveData.buildProgress.totalBatches,
                    currentFileIndex: saveData.buildProgress.currentFileIndex,
                    totalFiles: saveData.buildProgress.totalFiles,
                    currentBatchInFile: saveData.buildProgress.currentBatchInFile,
                    totalBatchesInFile: saveData.buildProgress.totalBatchesInFile,
                    startTime: saveData.buildProgress.startTime,
                    savedOntologyState: saveData.buildProgress.savedOntologyState
                }
                saveBuildProgress()
                kb_state.value += (store.locales === 'zh'
                    ? `，检测到未完成的本体构建进度 (${buildProgress.value.currentBatchIndex}/${buildProgress.value.totalBatches} 批次)，请在底部状态栏或「百科」页点击「继续」恢复`
                    : `, unfinished ontology build progress detected (${buildProgress.value.currentBatchIndex}/${buildProgress.value.totalBatches} batches), click "Resume" in the status bar or the Encyclopedia tab to continue`)
            } else if (staleDone) {
                // 忽略旧版遗留的“已完成/越界”进度记录，避免每次重读都提示 20/19
                clearBuildProgress()
                kb_state.value += (store.locales === 'zh'
                    ? '，已忽略旧的本体构建进度记录（批次已越界，视为已完成）'
                    : ', ignored stale ontology build progress record (batch index out of range, treated as done)')
            }
        } else {
            clearBuildProgress()
        }
        
        // 打开 KB 后自动检测文件变更 → 增量更新（异步，状态/进度在 prep-status-panel 展示）
        // 恢复 fileIndex/fileSummaries/blocks 后刷新文件摘要状态
        scanSummaryStatus()
        autoCheckIncremental()
    } catch (error:any) {
        console.error('加载知识库出错:', error)
        kb_state.value = store.locales === 'zh' ? 
            `加载知识库出错: ${error.message}` : 
            `Error loading knowledge base: ${error.message}`
    }
}

const scanKnowledgeBases = async function() {
    if (!store.root) return
    // 记录当前选中的知识库：重建列表后若它不在扫描结果里（如从外部打开的工作区外 .kb），需保留
    const prevSelected: any = knowledgeBases.value[selectedKbIndex.value]
    try {
        const result = await window.ipcRenderer.invoke("getFilesRelation", store.root, 1)
        if (!result) return

        const { fileList = [] } = result
        const kbFiles = fileList.filter((file: any) => file.path.endsWith('.kb'))
        
        kbFiles.sort((a: any, b: any) => {
            return (b.mtime || 0) - (a.mtime || 0)
        })
        
        // 有已保存的知识库时，最前面提供"自动知识库"（当前文件夹自动切片/向量化，问答时自动准备）
        if (kbFiles.length > 0) {
            knowledgeBases.value = [
                { label: store.locales == 'zh' ? '自动知识库' : 'Auto KB', auto: true, path: '' },
                ...kbFiles
            ]
        } else {
            knowledgeBases.value = []
        }
        
        // 保留当前选择；失效时回退到自动知识库
        if (selectedKbIndex.value >= knowledgeBases.value.length || selectedKbIndex.value < 0) {
            selectedKbIndex.value = 0
        }
    } catch (error) {
        console.error('扫描知识库出错:', error)
    }
    // 外部打开的 .kb 可能不在工作区扫描结果中：把它加回列表并保持选中，避免初始化扫描“偷走”当前知识库
    if (prevSelected && prevSelected.path && !knowledgeBases.value.some((k: any) => k.path === prevSelected.path)) {
        const autoCount = knowledgeBases.value.filter((k: any) => k.auto).length
        knowledgeBases.value.splice(autoCount, 0, prevSelected)
        selectedKbIndex.value = autoCount
    }
}

const init = async function(skipFolderLoad = false) {
    // skipFolderLoad：已从外部打开知识库时跳过工作区文件加载。
    // loadFolderFiles 会清空 blocks/问题库/文件摘要（并把 embedPinned 置回 false，
    // 使 .kb 自带的嵌入模型被设置页默认模型覆盖）——这正是「只看到本体、看不到切片和问题」的原因。
    if (!skipFolderLoad && store.root) {
        try {
            // 初始化时保持问答页，不切换到文件视图
            await loadFolderFiles(store.root, false)
        } catch (e) {
            console.warn('加载文件夹失败或无内容:', e)
        }
    }

    await scanKnowledgeBases()
    await getModel()
    // 默认进入问答模块（loadFolderFiles 默认会切到文件视图，这里恢复）
    viewMode.value = 'qa'
}

const atlasModuleRef = ref()
function scheduleRefreshAtlas(delay = 180) {
    if (viewMode.value === 'atlas' && atlasModuleRef.value) {
        atlasModuleRef.value.scheduleRefreshAtlas(delay)
    }
}

const handleLoadKnowledgeBase = async (index: number) => {
    await loadKnowledgeBases(index)
}

/** 按路径打开知识库文件（从知识库模块双击 .kb 文件跳转而来） */
const openKbByPath = async (path: string) => {
    if (!path) return
    let idx = knowledgeBases.value.findIndex((f: any) => f.path === path)
    if (idx === -1) {
        // 不在列表里：直接构造条目加入并选中。
        // 不在这里做全工作区扫描（scanKnowledgeBases）——工作区大/含大文件时扫描很慢，
        // 会让「双击 .kb 打开」长时间无反应；后续 init 扫描时会保留这个选中项。
        const label = path.replace(/\\/g, '/').split('/').pop() || path
        const autoCount = knowledgeBases.value.filter((k: any) => k.auto).length
        knowledgeBases.value.splice(autoCount, 0, { path, label, type: 'file', extension: '.kb' })
        idx = autoCount
    }
    selectedKbIndex.value = idx
    viewMode.value = 'qa'
    await loadKnowledgeBases(idx)
}

/** 初始化是否已完成（init 内含工作区文件扫描，期间不让 onActivated 抢先消费打开标记，避免列表重建后丢选中的知识库） */
let kbInitDone = false

/** 消费 store.kbPathToOpen 标记并加载对应的知识库文件（文件关联双击 / 知识管理打开 .kb） */
const openExternalKb = async () => {
    const path = store.kbPathToOpen
    if (!path) return
    store.kbPathToOpen = null // 消费标记，避免重复加载
    const label = path.replace(/\\/g, '/').split('/').pop() || path
    const isZhKb = store.locales === 'zh'
    // 显式的外部打开动作：给出可见反馈（面板内手动切换知识库仍只写状态行，避免弹窗刷屏）
    kb_state.value = isZhKb ? `正在加载知识库: ${label} ...` : `Loading knowledge base: ${label} ...`
    try {
        await openKbByPath(path)
        const cur: any = knowledgeBases.value[selectedKbIndex.value]
        const loaded = isKbLoaded.value && cur && String(cur.path || '').toLowerCase() === path.toLowerCase()
        if (loaded) {
            ElMessage.success(isZhKb ? `已打开知识库: ${label}` : `Opened knowledge base: ${label}`)
            return true
        } else {
            // 未加载成功：把具体原因（loadKnowledgeBases 写入的 kb_state）回显给用户，避免“看起来没反应”
            console.warn('[knowRAG] 外部知识库未加载成功:', path, kb_state.value)
            ElMessage.error(kb_state.value || (isZhKb ? `未能加载知识库: ${label}` : `Failed to load knowledge base: ${label}`))
            return false
        }
    } catch (e: any) {
        console.error('[knowRAG] 打开外部知识库失败:', e)
        kb_state.value = isZhKb ? `打开知识库失败: ${e?.message || e}` : `Failed to open knowledge base: ${e?.message || e}`
        ElMessage.error(kb_state.value)
        return false
    }
}

// 知识库面板打开 .kb 文件后，若本组件已挂载则直接响应
watch(() => store.kbPathToOpen, (val) => {
    if (val) openExternalKb()
})

function cleanupScrollListener() {
    const container = document.querySelector('.blocks')
    if (container) {
        container.removeEventListener('scroll', handleScroll)
    }
}

// ==================== 本体构建模块 ====================

interface OntologyEntity {
  id: string
  name: string
  type: string
  nodeType: string
  layer: string
  description: string
  associatedBlocks: string[]
  associatedFiles: string[]
}

interface OntologyRelation {
  id: string
  source: string
  target: string
  type: string
  layer: string
  description: string
  sourceBlocks: string[]
}

const globalEntities = ref<Map<string, OntologyEntity>>(new Map())
const globalRelations = ref<Map<string, OntologyRelation>>(new Map())
const entityToBlocksIndex = ref<Map<string, Set<string>>>(new Map())

// ==================== 卡片视图相关 ====================
const entityCards = ref<Array<{
  id: string
  name: string
  description: string
  layer: string
  associatedBlocks: string[]
  associatedFiles: string[]
}>>([])

const selectedEntityForCards = ref<OntologyEntity | null>(null)
const entityCardDetailBlocks = ref<any[]>([])
const showEntityCardDetail = ref(false)

// ==================== 卡片搜索和推理功能 ====================
const cardSearchKeyword = ref('')
const filteredEntityCards = ref<Array<any>>([])

// 批量推理相关状态
const isBatchReasoning = ref(false)
const batchReasoningQueue = ref<Array<any>>([])
const batchReasoningCurrentIndex = ref(0)
const batchReasoningProgress = computed(() => {
    if (batchReasoningQueue.value.length === 0) return 0
    return Math.round((batchReasoningCurrentIndex.value / batchReasoningQueue.value.length) * 100)
})
const batchReasoningProgressText = computed(() => {
    return `${batchReasoningCurrentIndex.value}/${batchReasoningQueue.value.length} (${batchReasoningProgress.value}%)`
})

// 正在推理的卡片ID集合
const reasoningCardsSet = ref<Set<string>>(new Set())
const isReasoningDetail = ref(false)

// 搜索处理
const handleCardSearch = () => {
    const keyword = cardSearchKeyword.value.trim().toLowerCase()
    if (!keyword) {
        filteredEntityCards.value = [...entityCards.value]
        return
    }
    
    filteredEntityCards.value = entityCards.value.filter(card => 
        card.name.toLowerCase().includes(keyword) || 
        card.description.toLowerCase().includes(keyword)
    )
}

// 批量推理所有卡片
const batchReasoningAllCards = async () => {
    if (isBatchReasoning.value) {
        kb_state.value = store.locales === 'zh' ? '批量推理正在进行中' : 'Batch reasoning is in progress'
        return
    }
    
    // 收集所有需要推理的卡片（描述为"无描述"或为空的）
    batchReasoningQueue.value = filteredEntityCards.value.filter(card => 
        !card.description || card.description === '无描述'
    )
    
    if (batchReasoningQueue.value.length === 0) {
        kb_state.value = store.locales === 'zh' ? '所有卡片都已有描述' : 'All cards already have descriptions'
        return
    }
    
    isBatchReasoning.value = true
    batchReasoningCurrentIndex.value = 0
    
    kb_state.value = store.locales === 'zh' ?
        `开始批量推理 ${batchReasoningQueue.value.length} 个卡片...` :
        `Starting batch reasoning for ${batchReasoningQueue.value.length} cards...`
    
    for (let i = 0; i < batchReasoningQueue.value.length; i++) {
        if (!isBatchReasoning.value) break
        
        batchReasoningCurrentIndex.value = i + 1
        
        const card = batchReasoningQueue.value[i]
        const fullEntity = globalEntities.value.get(card.name.toLowerCase())
        
        if (fullEntity) {
            await reasonEntityDescription(fullEntity, card)
        }
        
        // 等待一小段时间避免请求过快
        await new Promise(resolve => setTimeout(resolve, 500))
    }
    
    isBatchReasoning.value = false
    batchReasoningQueue.value = []
    batchReasoningCurrentIndex.value = 0
    
    updateEntityCards()
    handleCardSearch()
    
    kb_state.value = store.locales === 'zh' ?
        `批量推理完成！共处理 ${batchReasoningCurrentIndex.value} 个卡片` :
        `Batch reasoning completed! Processed ${batchReasoningCurrentIndex.value} cards`
}

// 停止批量推理
const stopBatchReasoning = () => {
    isBatchReasoning.value = false
    reasoningCardsSet.value.clear()
    kb_state.value = store.locales === 'zh' ? '批量推理已停止' : 'Batch reasoning stopped'
}

// 从详情页推理
const reasonSingleCardFromDetail = async () => {
    if (!selectedEntityForCards.value || isReasoningDetail.value) return
    await reasonEntityDescription(selectedEntityForCards.value)
    updateEntityCards()
    handleCardSearch()
    
    // 更新详情页显示
    const updatedEntity = globalEntities.value.get(selectedEntityForCards.value.name.toLowerCase())
    if (updatedEntity) {
        selectedEntityForCards.value = updatedEntity
        const relatedBlocks = []
        for (const blockId of updatedEntity.associatedBlocks || []) {
            const block = blocks.value.find((b: any) => b.id === blockId)
            if (block) {
                relatedBlocks.push({
                    ...block,
                    preview: block.A?.substring(0, 200) + (block.A?.length > 200 ? '...' : '')
                })
            }
        }
        entityCardDetailBlocks.value = relatedBlocks
    }
}

// 推理实体描述（基于所有关联切片）
const reasonEntityDescription = async (entity: OntologyEntity, card?: any) => {
    const entityId = entity.id
    const cardId = card?.id || entityId
    
    reasoningCardsSet.value.add(cardId)
    if (selectedEntityForCards.value?.id === entity.id) {
        isReasoningDetail.value = true
    }
    
    try {
        // 获取所有关联切片的内容
        const associatedBlocksContent: string[] = []
        for (const blockId of entity.associatedBlocks || []) {
            const block = blocks.value.find((b: any) => b.id === blockId)
            if (block && block.A) {
                associatedBlocksContent.push(block.A)
            }
        }
        
        if (associatedBlocksContent.length === 0) {
            entity.description = store.locales === 'zh' ? '无关联切片，无法生成描述' : 'No associated blocks, cannot generate description'
            globalEntities.value.set(entity.name.toLowerCase(), entity)
            kb_state.value = store.locales === 'zh' ?
                `实体"${entity.name}"没有关联切片` :
                `Entity "${entity.name}" has no associated blocks`
            return
        }
        
        // 合并内容并限制长度
        let combinedContent = associatedBlocksContent.join('\n\n---\n\n')
        if (combinedContent.length > 8000) {
            combinedContent = combinedContent.substring(0, 8000) + '...'
        }
        
        // 使用 GraphRAG 风格的描述提示词
        const entityTypeDescriptors = model.value.ontologyEntityTypes || '概念、对象、事物、主体、人物、组织、地点等'
        const descriptionPrompt = buildEntityDescriptionPrompt({
          entityName: entity.name,
          entityTypes: entityTypeDescriptors,
          content: combinedContent,
          language: store.locales,
          customPrompt: model.value.entityDescriptionPrompt
        })

        const response = await kbChat([
            { role: 'user', content: descriptionPrompt }
        ])
        
        let description = response.trim()
        description = description.replace(/^["']|["']$/g, '').trim()
        
        if (description.length > 500) {
            description = description.substring(0, 500) + '...'
        }
        
        entity.description = description
        globalEntities.value.set(entity.name.toLowerCase(), entity)
        
        kb_state.value = store.locales === 'zh' ?
            `成功为"${entity.name}"生成描述 (基于${associatedBlocksContent.length}个切片)` :
            `Successfully generated description for "${entity.name}" (based on ${associatedBlocksContent.length} blocks)`
            
    } catch (error) {
        console.error('推理实体描述失败:', error)
        entity.description = store.locales === 'zh' ? '描述生成失败，请重试' : 'Description generation failed, please retry'
        globalEntities.value.set(entity.name.toLowerCase(), entity)
        kb_state.value = store.locales === 'zh' ?
            `为"${entity.name}"生成描述失败: ${error}` :
            `Failed to generate description for "${entity.name}": ${error}`
    } finally {
        reasoningCardsSet.value.delete(cardId)
        if (selectedEntityForCards.value?.id === entity.id) {
            isReasoningDetail.value = false
        }
    }
}

const updateEntityCards = () => {
  const cards = []
  for (const entity of globalEntities.value.values()) {
    cards.push({
      id: entity.id,
      name: entity.name,
      description: entity.description || '无描述',
      layer: entity.layer,
      associatedBlocks: entity.associatedBlocks || [],
      associatedFiles: entity.associatedFiles || []
    })
  }
  entityCards.value = cards
  handleCardSearch()
}

const selectEntityCard = (entity: any) => {
  const fullEntity = globalEntities.value.get(entity.name.toLowerCase())
  if (fullEntity) {
    selectedEntityForCards.value = fullEntity
    
    const relatedBlocks = []
    for (const blockId of fullEntity.associatedBlocks || []) {
      const block = blocks.value.find((b: any) => b.id === blockId)
      if (block) {
        relatedBlocks.push({
          ...block,
          preview: block.A?.substring(0, 200) + (block.A?.length > 200 ? '...' : '')
        })
      }
    }
    entityCardDetailBlocks.value = relatedBlocks
    showEntityCardDetail.value = true
  }
}

const closeEntityCardDetail = () => {
  showEntityCardDetail.value = false
  selectedEntityForCards.value = null
  entityCardDetailBlocks.value = []
}

const deleteEntity = async (entity: OntologyEntity) => {
    if (!entity) return
    
    const entityName = entity.name
    const key = entityName.toLowerCase()
    
    // 确认对话框
    try {
      await ElMessageBox.confirm(
        store.locales === 'zh'
          ? `确定要删除实体"${entityName}"及其所有关联关系吗？`
          : `Are you sure you want to delete entity "${entityName}" and all its associations?`,
        store.locales === 'zh' ? '提示' : 'Confirm',
        {
          confirmButtonText: store.locales === 'zh' ? '确定' : 'OK',
          cancelButtonText: store.locales === 'zh' ? '取消' : 'Cancel',
          type: 'warning'
        }
      )
    } catch { return }
    
    // 1. 删除与该实体相关的所有关系
    const relationsToDelete: string[] = []
    for (const [relKey, relation] of globalRelations.value.entries()) {
        if (relation.source === entity.id || relation.target === entity.id) {
            relationsToDelete.push(relKey)
        }
    }
    for (const relKey of relationsToDelete) {
        globalRelations.value.delete(relKey)
    }
    
    // 2. 从全局实体中删除
    globalEntities.value.delete(key)
    
    // 3. 从索引中删除
    entityToBlocksIndex.value.delete(key)
    
    // 4. 如果当前选中的实体是被删除的，关闭详情页
    if (selectedEntityForCards.value?.id === entity.id) {
        closeEntityCardDetail()
    }
    
    // 5. 更新所有视图
    updateOntologyViewer()
    updateEntityCards()
    handleCardSearch()
    
    kb_state.value = store.locales === 'zh' ? 
        `已删除实体"${entityName}"及其 ${relationsToDelete.length} 个关联关系` : 
        `Deleted entity "${entityName}" and its ${relationsToDelete.length} associated relationships`
    
    console.log(`已删除实体: ${entityName}, 关联关系: ${relationsToDelete.length} 个`)
}

const getBlockFileInfo = (block: any) => {
  const file = files.value.find((f: any) => f.path === block.filePath)
  return {
    name: block.label || file?.label || '未知文件',
    extension: block.extension || file?.extension || ''
  }
}

const getFileIcon = (extension: string): string => {
  const icons: Record<string, string> = {
    '.md': 'fa fa-file-text-o',
    '.txt': 'fa fa-file-text-o',
    '.pdf': 'fa fa-file-pdf-o',
    '.docx': 'fa fa-file-word-o',
    '.doc': 'fa fa-file-word-o',
    '.excalidraw': 'fa fa-paint-brush',
    '.drawio': 'fa fa-object-group',
    '.dio': 'fa fa-object-group'
  }
  return icons[extension] || 'fa fa-file-o'
}

const viewBlockContent = (block: any) => {
  viewMode.value = 'slice'
  const blockIndex = blocks.value.findIndex((b: any) => b.id === block.id)
  if (blockIndex !== -1) {
    setTimeout(() => {
      const blockElements = document.querySelectorAll('.block')
      if (blockElements[blockIndex]) {
        blockElements[blockIndex].scrollIntoView({ behavior: 'smooth', block: 'center' })
        ;(blockElements[blockIndex] as HTMLElement).style.border = '2px solid #2196F3'
        setTimeout(() => {
          ;(blockElements[blockIndex] as HTMLElement).style.border = ''
        }, 2000)
      }
    }, 100)
  }
}

const getCurrentOntologyContext = () => {
  const entities = Array.from(globalEntities.value.values()).map(e => ({
    name: e.name,
    type: e.nodeType,
    description: e.description.substring(0, 100)
  }))
  
  const relations = Array.from(globalRelations.value.values()).map(r => {
    let sourceName = r.source
    let targetName = r.target
    for (const [name, entity] of globalEntities.value.entries()) {
      if (entity.id === r.source) sourceName = name
      if (entity.id === r.target) targetName = name
    }
    return { source: sourceName, target: targetName, type: r.type }
  })
  
  return { entities, relations }
}

const buildOntologyFromKnowledgeBase = async (onProgress?: (detail: string) => void) => {
    if (blocks.value.length === 0) {
        kb_state.value = store.locales === 'zh' ? '没有切片数据，请先处理文件' : 'No slice data, please process files first';
        return;
    }
    
    resetIdCounters()

    const filePaths: string[] = Array.from(new Set(blocks.value.map((b: any) => String(b.filePath))))
    buildProgress.value.totalFiles = filePaths.length
    buildProgress.value.isRunning = true
    buildProgress.value.isPaused = false
    buildProgress.value.startTime = Date.now()
    
    if (buildProgress.value.totalBatches === 0) {
        let totalBatches = 0
        for (let i = buildProgress.value.currentFileIndex; i < filePaths.length; i++) {
            const filePath = filePaths[i]
            const fileBlocks = blocks.value.filter((b: any) => b.filePath === filePath)
            const numBatches = Math.ceil(fileBlocks.length / model.value.ontologyBatchSize)
            totalBatches += numBatches
        }
        buildProgress.value.totalBatches = totalBatches
    }
    
    saveBuildProgress()
    
    // batchCounter = 已完成的批次累计（前面文件 + 本文件已完成），恢复时从该值续算
    let batchCounter = buildProgress.value.currentBatchIndex
    
    for (let i = buildProgress.value.currentFileIndex; i < filePaths.length; i++) {
        while (buildProgress.value.isPaused) {
            await new Promise(resolve => setTimeout(resolve, 100))
            if (!buildProgress.value.isRunning) return
        }
        // 取消检查：停止/清空本体会把 isRunning 置 false，这里立即退出，避免后台继续把剩余批次跑完（重建已清空的数据）
        if (!buildProgress.value.isRunning) return
        
        const filePath = filePaths[i]
        buildProgress.value.currentFileIndex = i
        await processSingleFileWithBatchProgress(filePath, i, filePaths.length, batchCounter, onProgress)
        
        const fileBlocks = blocks.value.filter((b: any) => b.filePath === filePath)
        const numBatches = Math.ceil(fileBlocks.length / model.value.ontologyBatchSize)
        batchCounter += numBatches
        buildProgress.value.currentBatchIndex = batchCounter
        // 关键修复：处理完该文件后，把 currentFileIndex 前移到「下一个文件」并清零批内进度，
        // 使暂停/保存后恢复不会重复处理已完成文件（旧实现停在已处理文件 → 重复计数出现 20/19）
        buildProgress.value.currentFileIndex = i + 1
        buildProgress.value.currentBatchInFile = 0
        saveBuildProgress()
    }
    
    updateOntologyViewer()
    updateEntityCards()
    
    buildProgress.value.isRunning = false
    buildProgress.value.isPaused = false
    clearBuildProgress()
    
    const doneMsg = store.locales === 'zh' ?
        `本体构建完成！共 ${globalEntities.value.size} 个实体节点，${globalRelations.value.size} 个关系` :
        `Ontology built! ${globalEntities.value.size} entity nodes, ${globalRelations.value.size} relations`
    kb_state.value = doneMsg
    onProgress?.(doneMsg)
}

const processSingleFileWithBatchProgress = async (filePath: string, fileIndex: number, totalFiles: number, startBatchIndex: number, onProgress?: (detail: string) => void) => {
    const fileName = filePath.split('/').pop() || filePath
    const fileBlocks = blocks.value.filter((b: any) => b.filePath === filePath)
    
    if (fileBlocks.length === 0) {
        console.warn(`文件 ${fileName} 没有切片`)
        return
    }
    
    const BATCH_SIZE = model.value.ontologyBatchSize
    const batches = []
    for (let i = 0; i < fileBlocks.length; i += BATCH_SIZE) {
        batches.push(fileBlocks.slice(i, i + BATCH_SIZE))
    }
    
    buildProgress.value.totalBatchesInFile = batches.length
    // 同文件恢复：若暂停时正处理的就是本文件且批内进度 >0，则从该批继续，
    // 避免整个文件从头重跑（会叠加批次号导致越界，如 20/19）
    const resumeInFile = (buildProgress.value.currentFileIndex === fileIndex && buildProgress.value.currentBatchInFile > 0)
        ? Math.min(buildProgress.value.currentBatchInFile, batches.length)
        : 0
    buildProgress.value.currentBatchInFile = resumeInFile
    
    for (let batchIdx = resumeInFile; batchIdx < batches.length; batchIdx++) {
        while (buildProgress.value.isPaused) {
            await new Promise(resolve => setTimeout(resolve, 100))
            if (!buildProgress.value.isRunning) return
        }
        // 取消检查：停止/清空本体后不再继续处理本文件的剩余批次
        if (!buildProgress.value.isRunning) return
        
        buildProgress.value.currentBatchInFile = batchIdx + 1
        buildProgress.value.currentBatchIndex = startBatchIndex + batchIdx
        saveBuildProgress()
        
        kb_state.value = store.locales === 'zh' ?
            `构建本体: 文件 ${fileIndex+1}/${totalFiles} (${fileName}) - 批次 ${batchIdx+1}/${batches.length}` :
            `Building ontology: file ${fileIndex+1}/${totalFiles} (${fileName}) - batch ${batchIdx+1}/${batches.length}`
        onProgress?.(store.locales === 'zh' ? `第 ${startBatchIndex + batchIdx + 1}/${buildProgress.value.totalBatches} 批` : `Batch ${startBatchIndex + batchIdx + 1}/${buildProgress.value.totalBatches}`)
        
        const batch = batches[batchIdx]
        
        const batchContent = batch.map((b: any) => b.A).join('\n\n---\n\n')
        const currentContext = getCurrentOntologyContext()
        const batchResult = await extractOntologyFromBatch(batchContent, batch, currentContext)
        
        if (batchResult.entities.length > 0) {
            await mergeEntitiesToGlobal(batchResult.entities, filePath, batch)
        }
        
        if (batchResult.relations.length > 0) {
            await mergeRelationsToGlobal(batchResult.relations, filePath)
        }
        
        if (batchResult.entities.length > 0 || batchResult.relations.length > 0) {
            updateOntologyViewer()
            updateEntityCards()
        }
    }
}

const extractOntologyFromBatch = async (content: string, blocks: any[], contextOntology?: { entities: any[], relations: any[] }) => {
    if (!content.trim()) return { entities: [], relations: [] }
    
    // 构建上下文提示 - GraphRAG 风格的已有知识注入
    let contextPrompt = ''
    if (contextOntology && (contextOntology.entities.length > 0 || contextOntology.relations.length > 0)) {
        const topEntities = contextOntology.entities.slice(0, 50)
        const topRelations = contextOntology.relations.slice(0, 30)
        
        contextPrompt = `
## 已构建的本体（请在此基础上扩展）

### 已有实体节点：
${topEntities.map((e: any) => `- ${e.name}`).join('\n')}

### 已有关系：
${topRelations.map((r: any) => `- ${r.source} → ${r.target} (${r.type})`).join('\n')}

### 要求：
1. 如果遇到与已有节点相似的实体，请使用相同的名称
2. 不要创建重复的节点
3. 新节点可以与已有节点建立关系
`
    }
    
    const entityTypes = model.value.ontologyEntityTypes || '概念、对象、事物、主体、人物、组织、地点等'
    const relationTypes = model.value.ontologyRelationTypes || '- **is_a**：继承关系。例如："医疗保险" is_a "保险合同"\n- **part_of**：组成关系。例如："保险条款" part_of "保险合同"\n- **depends_on**：依赖关系。例如："理赔" depends_on "保险合同"\n- **related_to**：一般关联关系\n- **contains**：包含关系'

    // 使用 GraphRAG 风格的提示词构建
    const systemPrompt = buildExtractionSystemPrompt({
      entityTypes,
      relationTypes,
      contextPrompt,
      language: store.locales
    })

    // 更宽容的 JSON 解析：剥 Markdown 围栏、按首尾 {} 截取、去注释与尾逗号后多次尝试
    const parseOntologyJsonLenient = (raw: string): any | null => {
      if (!raw) return null
      let s = String(raw).trim()
      const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
      if (fence) s = fence[1].trim()
      const a = s.indexOf('{')
      const b = s.lastIndexOf('}')
      if (a < 0 || b <= a) return null
      s = s.slice(a, b + 1)
      const stripped = s
        .replace(/\/\*[\s\S]*?\*\//g, '')          // 去块注释 /* ... */
        .replace(/^\s*\/\/.*$/gm, '')              // 去整行注释 // ...
      const noTrail = stripped.replace(/,\s*([}\]])/g, '$1')  // 去尾逗号 ,]
      for (const t of [s, stripped, noTrail]) {
        try { return JSON.parse(t) } catch { /* 尝试下一种 */ }
      }
      return null
    }

    // 自动重试：模型输出偶发非合法 JSON 时，重试多次并提醒只输出严格 JSON
    const MAX_ATTEMPTS = 3
    let lastErr: any = null
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const userContent = content.substring(0, 6000) + (attempt > 1
          ? `\n\n[注意] 你上一次的输出不是合法 JSON。请只输出一个严格合法的 JSON 对象：{"entities":[{"name":"实体名","type":"类型","description":"描述"}],"relations":[{"source":"源实体","target":"目标实体","type":"关系code","description":"描述"}]}。不要 Markdown 代码围栏、不要注释、不要任何其它文字。`
          : '')
        const response = await kbChat([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ])
        const result = parseOntologyJsonLenient(response)
        if (result && typeof result === 'object') {
          // 验证实体 - 需要名称和类型
          const validEntities: ExtractedEntity[] = (result.entities || []).filter((e: any) => 
              e.name && typeof e.name === 'string' && e.name.trim().length > 0
          ).map((e: any) => ({
              name: e.name.trim(),
              type: e.type || '概念',
              description: (e.description || '').trim()
          }))
          
          // 验证关系 - 需要源、目标和类型
          const validRelations: ExtractedRelation[] = (result.relations || []).filter((r: any) => 
              r.source && typeof r.source === 'string' && r.source.trim().length > 0 &&
              r.target && typeof r.target === 'string' && r.target.trim().length > 0
          ).map((r: any) => ({
              source: r.source.trim(),
              target: r.target.trim(),
              type: r.type || 'related_to',
              description: (r.description || '').trim(),
              strength: Math.min(10, Math.max(1, Math.round(r.strength || 5)))
          }))
          
          // 如果有新增实体不在当前实体列表中，保留关系（可能在全局中有）
          return { entities: validEntities, relations: validRelations }
        }
        lastErr = new Error('输出中未找到合法 JSON')
        console.warn(`本体批次解析失败，正在重试 ${attempt}/${MAX_ATTEMPTS}...`)
      } catch (error) {
        lastErr = error
        console.warn(`本体批次提取失败，正在重试 ${attempt}/${MAX_ATTEMPTS}:`, error)
      }
    }
    
    console.error('批次提取失败（已自动重试仍失败）:', lastErr)
    return { entities: [], relations: [] }
}

const calculateStringSimilarity = (str1: string, str2: string): number => {
    if (str1 === str2) return 1.0
    if (str1.includes(str2) || str2.includes(str1)) return 0.8
    
    const longer = str1.length > str2.length ? str1 : str2
    const shorter = str1.length > str2.length ? str2 : str1
    
    if (longer.length === 0) return 1.0
    
    const editDistance = (a: string, b: string): number => {
        const matrix = []
        for (let i = 0; i <= b.length; i++) {
            matrix[i] = [i]
        }
        for (let j = 0; j <= a.length; j++) {
            matrix[0][j] = j
        }
        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                if (b.charAt(i - 1) === a.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1]
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                    )
                }
            }
        }
        return matrix[b.length][a.length]
    }
    
    const distance = editDistance(longer, shorter)
    return (longer.length - distance) / longer.length
}

const mergeEntitiesToGlobal = async (newEntities: ExtractedEntity[], filePath: string, fileBlocks: any[]): Promise<number> => {
    let addedCount = 0
    
    for (const newEntity of newEntities) {
        if (!newEntity.name || typeof newEntity.name !== 'string') {
            console.warn(`实体名称无效，跳过:`, newEntity)
            continue
        }
        
        const key = newEntity.name.toLowerCase()
        const existing = globalEntities.value.get(key)
        
        const matchedBlockIds: string[] = []
        for (const block of fileBlocks) {
            if (block.A && block.A.includes(newEntity.name)) {
                matchedBlockIds.push(block.id)
            }
            if (block.Q && block.Q !== '问题未推理' && block.Q.includes(newEntity.name)) {
                if (!matchedBlockIds.includes(block.id)) {
                    matchedBlockIds.push(block.id)
                }
            }
        }
        
        if (matchedBlockIds.length === 0) {
            // 方案 A（更严）：字面零命中不再丢弃——保留该概念为孤立实体节点，避免推理出的概念凭空消失，便于后续手动补关联
            console.warn(`实体 "${newEntity.name}" 未在切片文本中字面命中，已保留为孤立概念（无关联切片）`)
        }
        
        if (!existing) {
            const entity: OntologyEntity = {
                id: shortId('entity'),
                name: newEntity.name,
                type: newEntity.type || '概念',       // 使用 LLM 识别的类型
                nodeType: 'entity',
                layer: 'data',
                description: newEntity.description || '',
                associatedBlocks: matchedBlockIds,
                associatedFiles: [filePath]
            }
            globalEntities.value.set(key, entity)
            addedCount++
        } else {
            let newAssociations = 0
            for (const blockId of matchedBlockIds) {
                if (!existing.associatedBlocks.includes(blockId)) {
                    existing.associatedBlocks.push(blockId)
                    newAssociations++
                }
            }
            
            if (!existing.associatedFiles.includes(filePath)) {
                existing.associatedFiles.push(filePath)
            }
            
            // 合并描述：优先使用更详细的
            if (newEntity.description && newEntity.description.length > existing.description.length) {
                existing.description = newEntity.description
            }
            
            // 更新实体类型（如果之前未分类）
            if (newEntity.type && (existing.type === 'entity' || existing.type === '概念')) {
                existing.type = newEntity.type
            }
            
            globalEntities.value.set(key, existing)
        }
        
        // 更新 entityToBlocksIndex
        if (!entityToBlocksIndex.value.has(key)) {
            entityToBlocksIndex.value.set(key, new Set())
        }
        for (const blockId of matchedBlockIds) {
            entityToBlocksIndex.value.get(key)!.add(blockId)
        }
    }
    
    return addedCount
}

const mergeRelationsToGlobal = async (newRelations: ExtractedRelation[], filePath: string): Promise<number> => {
    let addedCount = 0
    
    for (const newRel of newRelations) {
        const sourceKey = newRel.source?.toLowerCase()
        const targetKey = newRel.target?.toLowerCase()
        
        let sourceEntity = globalEntities.value.get(sourceKey)
        let targetEntity = globalEntities.value.get(targetKey)
        
        if (!sourceEntity) {
            for (const [name, entity] of globalEntities.value.entries()) {
                if (name === sourceKey || calculateStringSimilarity(name, sourceKey) > 0.7) {
                    sourceEntity = entity
                    break
                }
            }
        }
        
        if (!targetEntity) {
            for (const [name, entity] of globalEntities.value.entries()) {
                if (name === targetKey || calculateStringSimilarity(name, targetKey) > 0.7) {
                    targetEntity = entity
                    break
                }
            }
        }
        
        if (!sourceEntity || !targetEntity) {
            continue
        }
        
        const relKey = `${sourceEntity.id}|${targetEntity.id}|${newRel.type}`
        
        if (!globalRelations.value.has(relKey)) {
            const relation: OntologyRelation = {
                id: shortId('relation'),
                source: sourceEntity.id,
                target: targetEntity.id,
                type: newRel.type || 'related_to',
                layer: 'data',
                description: newRel.description || '',
                sourceBlocks: []
            }
            globalRelations.value.set(relKey, relation)
            addedCount++
        } else {
            // 已有关系，更新描述（如果更详细）
            const existingRel = globalRelations.value.get(relKey)!
            if (newRel.description && newRel.description.length > existingRel.description.length) {
                existingRel.description = newRel.description
                globalRelations.value.set(relKey, existingRel)
            }
        }
    }
    
    return addedCount}

// ==================== 手动连线（本体图：概念 ↔ 概念，由大模型判定关系类型） ====================
const findEntityByIdInGlobal = (id: string): any => {
    for (const e of globalEntities.value.values()) if (e.id === id) return e
    return null
}
const relationZhLabel = (t: string): string => {
    const map: Record<string, string> = { has_attribute: '拥有属性', is_a: '继承', part_of: '组成部分', depends_on: '依赖', related_to: '关联', contains: '包含', causes: '因果', uses: '使用', located_in: '位于', produce: '产出', influences: '影响' }
    return map[t] || t
}
const allowedRelationCodes = (): string[] => {
    const s = String(model.value?.ontologyRelationTypes || '')
    const codes = Array.from(s.matchAll(/\*\*([\w_]+)\*\*/g)).map(m => m[1])
    return codes.length ? codes : ['is_a', 'part_of', 'depends_on', 'related_to', 'contains', 'causes', 'uses', 'located_in', 'produce', 'influences']
}
const extractJsonObject = (raw: string): any | null => {
    if (!raw) return null
    const a = raw.indexOf('{'); const b = raw.lastIndexOf('}')
    if (a < 0 || b <= a) return null
    try { return JSON.parse(raw.slice(a, b + 1)) } catch { return null }
}
/** 大模型判定 A、B 两个概念之间的关系类型（仅概念之间；由本体图手动连线调用） */
const inferManualRelationType = async (A: any, B: any): Promise<{ type: string; reversed: boolean; description: string } | null> => {
    const codes = allowedRelationCodes()
    const definitions = String(model.value?.ontologyRelationTypes || '')
    const prompt = (store.locales == 'zh'
        ? `你是一名本体建模专家。下面给出两个知识实体（概念）：\nA：「${A.name}」${A.description ? `\n描述：${String(A.description).slice(0, 200)}` : ''}\nB：「${B.name}」${B.description ? `\n描述：${String(B.description).slice(0, 200)}` : ''}\n\n请判断 A 与 B 之间是否存在有意义的本体关系。若存在，从以下允许的关系类型中选择最贴切的一个：\n${definitions}\n\n默认方向为 A → B；若该关系更自然的方向是 B → A，请设 reversed=true。若无合适关系，type 填 "none"。\n只输出 JSON：{"type":"关系code或none","reversed":true或false,"description":"≤25字的一句话中文说明"}，不要其它文字。`
        : `You are an ontology modeling expert. Two knowledge entities (concepts):\nA: "${A.name}"${A.description ? `\nDescription: ${String(A.description).slice(0, 200)}` : ''}\nB: "${B.name}"${B.description ? `\nDescription: ${String(B.description).slice(0, 200)}` : ''}\n\nDecide whether a meaningful ontology relation exists between A and B. If so pick the best type from: ${codes.join(', ')}.\nDefault direction is A → B; set reversed=true if B → A is more natural. If none fits, set type to "none".\nOutput ONLY JSON: {"type":"code or none","reversed":true/false,"description":"short one-line reason"}.\n`)
    try {
        const out = await kbChat([{ role: 'user', content: prompt }])
        const obj = extractJsonObject(out || '')
        if (!obj) return null
        const type = String(obj.type || '').trim()
        if (!type || type === 'none') return null
        return { type: codes.includes(type) ? type : 'related_to', reversed: obj.reversed === true, description: String(obj.description || '').trim().slice(0, 60) }
    } catch (e) { console.error('手动连线判型失败:', e); return null }
}
/** 本体图手动连线：两个概念节点 → 大模型判型 → 写入本体关系（随 .kb 保存） */
const handleManualLink = async (payload: { source: any; target: any }) => {
    const A = findEntityByIdInGlobal(payload.source?.id)
    const B = findEntityByIdInGlobal(payload.target?.id)
    if (!A || !B) { kb_state.value = store.locales == 'zh' ? '连线失败：节点不存在（请先构建本体）' : 'Link failed: node not found (build the ontology first)'; return }
    if (A.id === B.id) return
    for (const rel of globalRelations.value.values()) {
        if ((rel.source === A.id && rel.target === B.id) || (rel.source === B.id && rel.target === A.id)) {
            kb_state.value = store.locales == 'zh' ? `「${A.name}」与「${B.name}」之间已有连线` : `"${A.name}" and "${B.name}" are already linked`
            return
        }
    }
    kb_state.value = store.locales == 'zh' ? `正在判断「${A.name}」↔「${B.name}」的连线类型…` : `Deciding relation type between "${A.name}" and "${B.name}"…`
    const info = await inferManualRelationType(A, B)
    if (!info) { kb_state.value = store.locales == 'zh' ? '大模型判定两者之间无合适关系，未连线' : 'LLM found no meaningful relation — not linked'; return }
    const source = info.reversed ? B : A
    const target = info.reversed ? A : B
    const key = `${source.id}|${target.id}|${info.type}`
    if (globalRelations.value.has(key)) { kb_state.value = store.locales == 'zh' ? '该连线已存在' : 'That link already exists'; return }
    globalRelations.value.set(key, { id: shortId('relation'), source: source.id, target: target.id, type: info.type, layer: 'data', description: info.description || '', sourceBlocks: [] })
    updateOntologyViewer()
    kb_state.value = store.locales == 'zh' ? `已连线：${A.name} → ${B.name}（${relationZhLabel(info.type)}${info.reversed ? ' · 反向' : ''}）` : `Linked: ${A.name} → ${B.name} (${info.type})`
}

const updateOntologyViewer = () => {
    const nodes: any[] = []
    const edges: any[] = []
    const communityAssign = communityResult.value?.assignments
    
    for (const entity of globalEntities.value.values()) {
        // 复用已有节点坐标，避免整图重置闪烁（新增节点用随机初始坐标）
        const cached = ontologyNodePosCache.get(entity.id)
        nodes.push({
            id: entity.id,
            name: entity.name,
            type: entity.nodeType,
            layer: entity.layer,
            description: entity.description,
            associatedBlocks: entity.associatedBlocks || [],
            associatedFiles: entity.associatedFiles || [],
            communityId: communityAssign?.get(entity.id) ?? -1,
            size: 20,
            x: cached ? cached.x : (Math.random() * 800),
            y: cached ? cached.y : (Math.random() * 600)
        })
    }
    
    for (const relation of globalRelations.value.values()) {
        edges.push({
            id: relation.id,
            source: relation.source,
            target: relation.target,
            type: relation.type,
            layer: relation.layer,
            description: relation.description || ''
        })
    }
    
    // 更新坐标缓存（仅保留当前仍存在的节点）
    ontologyNodePosCache.clear()
    for (const n of nodes) {
        ontologyNodePosCache.set(n.id, { x: n.x, y: n.y })
    }
    
    ontologyData.value.nodes = nodes
    ontologyData.value.edges = edges
}

const clearOntology = async () => {
    // 危险操作：二次确认，避免误触清空全部实体/关系/卡片/社区
    try {
        await ElMessageBox.confirm(
            store.locales === 'zh'
                ? '确定要清空本体/百科吗？将删除全部实体（即百科条目/卡片）及其实体间的关系，并清除由此派生的社区与报告；切片内容不受影响。此操作无法撤销。'
                : 'Clear the ontology/encyclopedia? This removes all entities (the encyclopedia cards), their relations, and the derived communities/reports. Slice content is unaffected. This cannot be undone.',
            store.locales === 'zh' ? '清空本体' : 'Clear Ontology',
            {
                type: 'warning',
                confirmButtonText: store.locales === 'zh' ? '清空' : 'Clear',
                cancelButtonText: store.locales === 'zh' ? '取消' : 'Cancel',
                closeOnClickModal: false,
            },
        )
    } catch { return }
    // 清空构建进度（含断点 savedOntologyState）：清空后应从「开始」重新抽取，而非显示「继续」
    clearBuildProgress()
    // 若仍有正在运行/展示的「构建本体」步骤，先收尾，避免状态栏残留“构建本体 第 x/y 批”或误判为“完成”
    if (ontologyStepIdx != null) {
        setPrepStep(ontologyStepIdx, 'error', store.locales === 'zh' ? '已清空本体' : 'Ontology cleared')
        ontologyStepIdx = null
    }
    globalEntities.value.clear()
    globalRelations.value.clear()
    entityToBlocksIndex.value.clear()
    ontologyData.value.nodes = []
    ontologyData.value.edges = []
    entityCards.value = []
    filteredEntityCards.value = []
    communityResult.value = null
    communityReports.value = []
    ontologyNodePosCache.clear()
    clearEntityVectorCache() // 实体变更后清空共享向量缓存，避免陈旧向量
    kb_state.value = store.locales === 'zh' ? '本体已清空' : 'Ontology cleared'
}

/** 重置知识库所有状态（与初始化进入模块一致：清除切片/文件摘要/本体/社区/报告/测试用例等） */
const resetKbState = () => {
    blocks.value = []
    files.value = []
    documents.value = [{ name: '全部' }]
    documentName.value = '全部'
    previewContent.value = ''
    result.value = ''
    currentEvidence.value = []
    testCases.value = { questions: [], answers: [], source: 'bank' }
    fileSummaries.value.clear()
    fileIndex.value.clear()
    buildManifest.value = {}
    fileChanges.value = { added: [], modified: [], deleted: [] }
    clearOntology()
    clearExtractProgress()
    clearBuildProgress()
    resetScrollLoad()
    isKbLoaded.value = false
}

// 社区检测
const detectCommunities = () => {
    if (globalEntities.value.size === 0) {
        kb_state.value = store.locales === 'zh' ? '没有实体数据，请先构建本体' : 'No entity data, please build ontology first'
        return
    }
    if (globalRelations.value.size === 0) {
        kb_state.value = store.locales === 'zh' ? '没有关系数据，社区检测需要实体间的关系' : 'No relationship data, community detection requires relations'
        return
    }

    const entities = Array.from(globalEntities.value.values())
    const relations = Array.from(globalRelations.value.values())
    
    kb_state.value = store.locales === 'zh' ?
        `运行社区检测: ${entities.length}实体, ${relations.length}关系...` :
        `Running community detection: ${entities.length} entities, ${relations.length} relations...`

    const result = detectCommunitiesFromOntology(entities, relations, {
        resolution: 1.0,
        defaultWeight: 1,
    })

    communityResult.value = result

    // 更新本体视图以显示社区信息
    updateOntologyViewer()

    // 输出统计
    const communityList = Array.from(result.communities.entries())
        .sort(([, a], [, b]) => b.length - a.length)
    
    let stats = store.locales === 'zh' ?
        `社区检测完成: ${result.count}个社区, 模块度:${result.modularity.toFixed(3)}` :
        `Community detection done: ${result.count} communities, modularity:${result.modularity.toFixed(3)}`
    
    if (communityList.length > 0) {
        const top5 = communityList.slice(0, 5)
        stats += store.locales === 'zh' ?
            `，最大社区: ${top5.map(([id, nodes]) => `${nodes.length}个实体`).join(', ')}` :
            `, largest: ${top5.map(([id, nodes]) => `${nodes.length} entities`).join(', ')}`
    }
    
    kb_state.value = stats
    console.log('社区检测结果:', result)
}

const continueBuildOntology = async () => {
    if (buildProgress.value.isPaused) {
        buildProgress.value.isPaused = false
        buildProgress.value.isRunning = true
        saveBuildProgress()
        
        if (buildProgress.value.savedOntologyState) {
            kb_state.value = store.locales === 'zh' ? 
                `恢复本体状态: ${buildProgress.value.savedOntologyState.entities.length}个实体节点, ${buildProgress.value.savedOntologyState.relations.length}个关系` : 
                `Restoring ontology state: ${buildProgress.value.savedOntologyState.entities.length} entity nodes, ${buildProgress.value.savedOntologyState.relations.length} relations`
        }
        // 底部状态栏：恢复时若没有「构建本体」步骤（如刷新后恢复）则补一个
        if (ontologyStepIdx == null) ontologyStepIdx = prepPushStep(store.locales === 'zh' ? '构建本体' : 'Build Ontology')
        setPrepStep(ontologyStepIdx, 'running', store.locales === 'zh' ? '继续构建...' : 'Resuming...')
        await buildOntologyFromKnowledgeBase((detail) => { if (ontologyStepIdx != null) setPrepStep(ontologyStepIdx, 'running', detail) })
        if (ontologyStepIdx != null && !buildProgress.value.isPaused) setPrepStep(ontologyStepIdx, 'done', store.locales === 'zh' ? '本体构建完成' : 'Ontology built')
    } else if (loadBuildProgress()) {
        kb_state.value = store.locales === 'zh' ? 
            `从保存的进度恢复本体构建: ${buildProgressText.value}` : 
            `Resuming ontology building from saved progress: ${buildProgressText.value}`
        if (ontologyStepIdx == null) ontologyStepIdx = prepPushStep(store.locales === 'zh' ? '构建本体' : 'Build Ontology')
        setPrepStep(ontologyStepIdx, 'running', store.locales === 'zh' ? '从保存进度恢复...' : 'Resuming from saved progress...')
        await buildOntologyFromKnowledgeBase((detail) => { if (ontologyStepIdx != null) setPrepStep(ontologyStepIdx, 'running', detail) })
        if (ontologyStepIdx != null && !buildProgress.value.isPaused) setPrepStep(ontologyStepIdx, 'done', store.locales === 'zh' ? '本体构建完成' : 'Ontology built')
    } else {
        kb_state.value = store.locales === 'zh' ? '没有可恢复的本体构建进度，请重新开始' : 'No ontology building progress to resume'
    }
}

const startBuildOntology = async (onProgress?: (detail: string) => void) => {
    if (buildProgress.value.isRunning) {
        kb_state.value = store.locales === 'zh' ? '本体构建已在运行中' : 'Ontology building already running'
        return
    }
    clearBuildProgress()
    buildProgress.value.startTime = Date.now()
    // 底部状态栏：手动/按钮触发时向 prep-status-panel 推送「构建本体」步骤（自动构建 ensureOntology 已自行管理步骤，避免重复）
    const hasBlocks = blocks.value.length > 0
    const stepIdx = onProgress ? null : prepPushStep(store.locales === 'zh' ? '构建本体' : 'Build Ontology')
    ontologyStepIdx = stepIdx
    const cb = stepIdx != null
        ? (detail: string) => setPrepStep(stepIdx, 'running', detail)
        : onProgress
    try {
        await buildOntologyFromKnowledgeBase(cb)
        // 正常完成（若中途被停止，stopBuildOntology 已把 ontologyStepIdx 置空并标记「已停止」）
        if (stepIdx != null && ontologyStepIdx === stepIdx) {
            if (!hasBlocks) setPrepStep(stepIdx, 'error', store.locales === 'zh' ? '没有切片数据，请先处理文件' : 'No slice data, process files first')
            else setPrepStep(stepIdx, 'done', store.locales === 'zh' ? '本体构建完成' : 'Ontology built')
        }
    } catch (e) {
        console.error('本体构建失败:', e)
        if (stepIdx != null) setPrepStep(stepIdx, 'error', store.locales === 'zh' ? '本体构建失败' : 'Ontology build failed')
    } finally {
        ontologyStepIdx = null
    }
}

// ===== 社区报告生成（GraphRAG 风格） =====
const generateCommunityReportsAction = async (onProgress?: (detail: string) => void) => {
    if (!communityResult.value || communityResult.value.count === 0) {
        kb_state.value = store.locales === 'zh' ? '请先运行社区检测' : 'Please run community detection first'
        return
    }
    if (blocks.value.length === 0) {
        kb_state.value = store.locales === 'zh' ? '没有切片数据' : 'No block data'
        return
    }

    const reportIdx = prepPushStep(store.locales === 'zh' ? '社区报告' : 'Community Reports')
    const comMap = communityResult.value.communities
    const totalComs = comMap.size
    let completed = 0
    let generatedOk = 0
    let failedCount = 0
    const reports: CommunityReport[] = []

    // 构建实体 ID → 实体名称（小写）的映射，entityToBlocksIndex 的 key 是实体名称
    const idToNameMap = new Map<string, string>()
    for (const [nameKey, entity] of globalEntities.value.entries()) {
        idToNameMap.set(entity.id, nameKey)
    }

    for (const [comId, entityIds] of comMap.entries()) {
        completed++
        setPrepStep(reportIdx, 'running', `(${completed}/${totalComs})`)
        const reportMsg = store.locales === 'zh' ?
            `正在生成社区报告 (${completed}/${totalComs})...` :
            `Generating community report (${completed}/${totalComs})...`
        kb_state.value = reportMsg
        onProgress?.(reportMsg)

        // 通过 ID→名称映射获取该社区的实体名称列表（小写）
        const entityNameKeys = entityIds
            .map(eid => idToNameMap.get(eid))
            .filter(Boolean) as string[]

        // 收集实体显示名
        const entityNames = entityNameKeys
            .map(key => globalEntities.value.get(key)?.name)
            .filter(Boolean) as string[]

        // 收集关联文本（传入实体名称，与 entityToBlocksIndex 的 key 匹配）
        const contextText = collectCommunityContext(
            entityNameKeys,
            entityToBlocksIndex.value,
            blocks.value
        )

        const communityName = entityNames[0] || `社区${comId}`
        const signature = communitySignature(entityIds)

        if (!contextText) {
            console.warn(`社区 ${comId} 跳过: 无关联切片 (实体数=${entityIds.length}, 映射到名称=${entityNameKeys.length})`)
            // 占位报告，保持报告列表完整（供后续增量按签名复用）
            reports.push({ communityId: comId, title: communityName, summary: '', findings: [], rating: 0, signature })
            communityReports.value = [...reports]
            continue
        }

        const prompt = buildCommunityReportPrompt({
            communityName,
            entityNames,
            contextText,
            language: store.locales
        })

        // 自动重试：最多 2 次（LLM 输出偶发 JSON 解析失败）
        let ok = false
        for (let attempt = 0; attempt < 2 && !ok; attempt++) {
            if (attempt > 0) {
                setPrepStep(reportIdx, 'running', `(${completed}/${totalComs}) 重试 ${attempt}`)
                kb_state.value = store.locales === 'zh' ? `社区 ${comId} 生成失败，正在重试...` : `Community ${comId} failed, retrying...`
            }
            try {
                const response = await kbChat([{ role: 'user', content: prompt }])
                const parsed = safeParseLlmJson(response)
                if (!parsed) throw new Error('无法解析社区报告 JSON')
                reports.push({
                    communityId: comId,
                    title: parsed.title || communityName,
                    summary: parsed.summary || '',
                    findings: parsed.findings || [],
                    rating: parsed.rating ?? 5,
                    signature,
                })
                generatedOk++
                ok = true
            } catch (e) {
                if (attempt === 1) {
                    console.error(`社区 ${comId} 报告生成失败:`, e)
                    failedCount++
                    // 占位报告，避免该社区缺失
                    reports.push({ communityId: comId, title: communityName, summary: '', findings: [], rating: 0, signature })
                }
            }
        }
        // 每生成一个报告就更新 communityReports，让 UI 实时刷新
        communityReports.value = [...reports]
    }

    setPrepStep(reportIdx, 'done', store.locales === 'zh' ? `生成 ${generatedOk} / 失败 ${failedCount}（共 ${totalComs}）` : `ok ${generatedOk} / fail ${failedCount} (of ${totalComs})`)
    kb_state.value = store.locales === 'zh' ?
        `社区报告生成完成！成功 ${generatedOk} / 失败 ${failedCount} / 共 ${totalComs} 份` :
        `Community reports generated! ok ${generatedOk} / fail ${failedCount} / of ${totalComs}`

    console.log('社区报告:', reports)
}

// ===== 策略统一入口（前置条件 + 分派） =====

/** 对单个社区重新推理（重新生成该社区的报告，保留其它社区报告） */
const reReasonCommunity = async (comId: number | null) => {
    if (comId === null) return
    if (!communityResult.value || communityResult.value.count === 0) return
    const entityIds = communityResult.value.communities.get(comId)
    if (!entityIds || entityIds.length === 0) {
        kb_state.value = store.locales === 'zh' ? `未找到社区 #${comId}` : `Community #${comId} not found`
        return
    }
    const reportIdx = prepPushStep(store.locales === 'zh' ? `社区 #${comId} 重新推理` : `Community #${comId} re-reason`)
    setPrepStep(reportIdx, 'running', store.locales === 'zh' ? '正在生成报告...' : 'Generating report...')

    // 实体 ID → 实体名称（小写）映射，与 entityToBlocksIndex 的 key 匹配
    const idToNameMap = new Map<string, string>()
    for (const [nameKey, entity] of globalEntities.value.entries()) {
        idToNameMap.set(entity.id, nameKey)
    }
    const entityNameKeys = entityIds.map(eid => idToNameMap.get(eid)).filter(Boolean) as string[]
    const entityNames = entityNameKeys.map(key => globalEntities.value.get(key)?.name).filter(Boolean) as string[]
    const contextText = collectCommunityContext(entityNameKeys, entityToBlocksIndex.value, blocks.value)
    const communityName = entityNames[0] || `社区${comId}`
    const signature = communitySignature(entityIds)

    if (!contextText) {
        setPrepStep(reportIdx, 'error', store.locales === 'zh' ? '无关联切片' : 'No linked blocks')
        kb_state.value = store.locales === 'zh' ? `社区 #${comId} 无关联切片，无法推理` : `Community #${comId} has no linked blocks`
        return
    }

    const prompt = buildCommunityReportPrompt({ communityName, entityNames, contextText, language: store.locales })
    // 自动重试：最多 2 次
    let ok = false
    let newReport: CommunityReport | null = null
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        if (attempt > 0) setPrepStep(reportIdx, 'running', store.locales === 'zh' ? '重试...' : 'Retrying...')
        try {
            const response = await kbChat([{ role: 'user', content: prompt }])
            const parsed = safeParseLlmJson(response)
            if (!parsed) throw new Error('无法解析社区报告 JSON')
            newReport = {
                communityId: comId,
                title: parsed.title || communityName,
                summary: parsed.summary || '',
                findings: parsed.findings || [],
                rating: parsed.rating ?? 5,
                signature,
            }
            ok = true
        } catch (e) {
            if (attempt === 1) {
                console.error(`社区 ${comId} 重新推理失败:`, e)
                setPrepStep(reportIdx, 'error', store.locales === 'zh' ? '生成失败' : 'Failed')
                kb_state.value = store.locales === 'zh' ? `社区 #${comId} 重新推理失败` : `Community #${comId} re-reason failed`
                return
            }
        }
    }
    if (newReport) {
        // 替换该社区的报告，保留其它社区
        communityReports.value = [...communityReports.value.filter(r => r.communityId !== comId), newReport]
        setPrepStep(reportIdx, 'done', store.locales === 'zh' ? '重新推理完成' : 'Done')
        kb_state.value = store.locales === 'zh' ? `社区 #${comId} 重新推理完成` : `Community #${comId} re-reasoned`
    }
}

/** 确保本体就绪（自动构建），失败返回 false */
const ensureOntology = async (): Promise<boolean> => {
    if (globalEntities.value.size > 0) return true
    const buildIdx = prepPushStep(store.locales === 'zh' ? '构建本体' : 'Build Ontology')
    _suppressKbMsg = true
    try {
        await startBuildOntology((detail) => setPrepStep(buildIdx, 'running', detail))
    } finally {
        _suppressKbMsg = false
    }
    if (globalEntities.value.size === 0) {
        setPrepStep(buildIdx, 'error', store.locales === 'zh' ? '本体构建失败' : 'Ontology build failed')
        return false
    }
    setPrepStep(buildIdx, 'done', store.locales === 'zh' ? '本体构建完成' : 'Ontology built')
    return true
}

/** 确保社区报告就绪（本体 → 社区检测 → 报告），失败返回 false */
const ensureCommunityReports = async (): Promise<boolean> => {
    if (communityReports.value.length > 0) return true
    if (!communityResult.value || communityResult.value.count === 0) {
        if (!(await ensureOntology())) return false
        detectCommunities()
        if (!communityResult.value || communityResult.value.count === 0) return false
    }
    _suppressKbMsg = true
    try {
        await generateCommunityReportsAction(() => {})
    } finally {
        _suppressKbMsg = false
    }
    return communityReports.value.length > 0
}

/**
 * 统一策略执行入口：按策略类型做前置准备（本体/社区）后分派到对应执行器。
 * 相似度/本体/多跳 → pipelineChat（runStrategy pipeline）
 * 社区            → communityChat（runStrategy mapreduce）
 * Agentic         → agenticChat（runStrategy agentic）
 */
const runChatStrategy = async (strategyId: string, prompt: string) => {
    if (!prompt || !prompt.trim()) return false
    if (!(await ensureKbReady())) return false
    const def = getStrategies().find(s => s.id === strategyId)
    if (!def) return false

    result.value = store.locales == 'zh' ? '正在准备检索策略...' : 'Preparing retrieval strategy...'

    // 自动执行处理管线（语义增强/文件增强）：Q_vector / fileIndex 未就绪时补跑，确保增强相似度可用
    await ensureIngestionReady(strategyId)

    // 前置条件：Agentic 按启用的工具判定；Hybrid 按启用的通道判定（entity/graph/community → 本体/社区）
    const agentTools = def.agentTools || {}
    const hybridChannels = def.channels || {}
    const needsOntology = def.kind === 'agentic'
        ? (agentTools.entity_link !== false || agentTools.graph_hop !== false)
        : def.kind === 'hybrid'
            ? (hybridChannels.entity !== false || hybridChannels.graph !== false || hybridChannels.community !== false)
            : (def.kind === 'pipeline' && def.steps.some(st => ['entity_link', 'graph_hop', 'community_select', 'boost'].includes(st.primitive)))
    if (needsOntology && !(await ensureOntology())) {
        result.value = store.locales === 'zh' ? '本体构建失败，无法使用该策略。' : 'Ontology build failed.'
        return false
    }

    const needsCommunity = def.kind === 'agentic'
        ? agentTools.community_search !== false
        : def.kind === 'hybrid'
            ? hybridChannels.community !== false
            : def.kind === 'mapreduce'
    if (needsCommunity && !(await ensureCommunityReports())) {
        result.value = store.locales === 'zh' ? '社区报告构建失败，无法使用该策略。' : 'Community reports build failed.'
        return false
    }

    // 非 Agentic 策略清空旧的推理步骤（避免右侧「推理路径」面板残留上次的 agentic 轨迹）
    if (def.kind === 'pipeline') { agentSteps.value = []; return pipelineChat(strategyId, prompt, strategyId) }
    if (def.kind === 'mapreduce') { agentSteps.value = []; return communityChat(prompt) }
    if (def.kind === 'hybrid') { agentSteps.value = []; return hybridChat(strategyId, prompt) }
    return agenticChat(prompt)
}

// ===== 社区搜索（GraphRAG Map-Reduce，经 runStrategy('community')） =====
const communityChat = async (userPrompt: string) => {
    result.value = ''
    const appendResult = (msg: string) => { result.value += msg + '\n\n' }
    appendResult(store.locales === 'zh' ? '社区搜索启动中...' : 'Community search starting...')

    let summaryStarted = false
    const ctx = buildRetrievalContext(userPrompt)
    const sr = await runStrategy('community', userPrompt, ctx, {
        onProgress: (msg: string) => { appendResult(msg) },
        onStream: (chunk: string) => {
            if (!summaryStarted) { summaryStarted = true; result.value += '\n---\n\n' }
            result.value += chunk
        },
    })

    if (!sr.meta.mapResults?.length) {
        appendResult(store.locales === 'zh' ? '未生成中间结果' : 'No intermediate results generated')
    }
    if (!summaryStarted && sr.answer) {
        result.value += (sr.answer || (store.locales === 'zh' ? '未找到相关信息' : 'No relevant information found'))
    }
    currentEvidence.value = filterEvidenceTopK(sr.evidence, model.value.evidenceTopK)
    return true
}

// ===== 本体增强检索（runStrategy('ontology')） =====
const chatWithOntology = async (userPrompt: string) => {
    return runChatStrategy('ontology', userPrompt)
}

const blocksWithId = computed(() => {
  return blocks.value.map((block: any) => ({
    ...block,
    preview: block.A?.substring(0, 150) + (block.A?.length > 150 ? '...' : ''),
    fileName: block.label || block.filePath?.split('/').pop() || '未知文件'
  }))
})

const handleBlockClick = (block: any) => {
    console.log('点击切片:', block)
    const index = blocks.value.findIndex((b: any) => b.id === block.id)
    if (index !== -1) {
        const blockElements = document.querySelectorAll('.block')
        if (blockElements[index]) {
            blockElements[index].scrollIntoView({ behavior: 'smooth', block: 'center' })
            ;(blockElements[index] as HTMLElement).style.border = '2px solid #2196F3'
            setTimeout(() => {
                ;(blockElements[index] as HTMLElement).style.border = ''
            }, 2000)
        }
    }
}

// 键盘事件处理：在模态框中按Enter键提交
const handleModalKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !isAddingEntity.value) {
        event.preventDefault()
        addEntityManually()
    } else if (event.key === 'Escape') {
        closeAddEntityModal()
    }
}

onMounted(async () => {
    // 外部打开（文件关联双击 .kb / 知识管理双击 .kb）：**优先处理**，不等 init。
    // init 内含工作区文件扫描（loadFolderFiles），工作区大或含大文件时会非常慢，
    // 排在它后面会导致「知识处理模块打开了，但目标知识库很久/一直没加载」。
    await nextTick()
    const loadedExternalKb = await openExternalKb()
    kbInitDone = true
    // init 失败（如模型配置异常）只记录日志，不影响已完成的文件打开；
    // 已加载外部知识库时跳过工作区加载，避免它清空刚加载的切片/问题库/文件摘要
    try {
        await init(loadedExternalKb)
    } catch (e) {
        console.warn('[knowRAG] 初始化失败:', e)
    }
    // 窗口缩放时，若可视区放大而切片不足，自动补足显示（避免空白）
    window.addEventListener('resize', onWindowResize)
    // 外部程序改动知识库文件后切回应用时，自动检测并刷新「文件」标签页徽标
    window.addEventListener('focus', onWindowFocusFileCheck)
})

// KeepAlive 缓存：切回本面板时恢复 Atlas 视图（首次挂载由 onMounted 走 init，这里不重复初始化）
onActivated(() => {
    // 兜底：初始化已完成而仍有待打开标记（如面板在后台时收到「打开 .kb」请求）→ 补做加载
    if (kbInitDone && store.kbPathToOpen) openExternalKb()
    if (viewMode.value === 'atlas' && atlasModuleRef.value) {
        try { atlasModuleRef.value.refreshAtlas() } catch (e) {}
    }
    // 切回本面板时若停在「文件」标签页，检测一次文件变更
    if (viewMode.value === 'file') scheduleFileViewChangeCheck()
})

// KeepAlive 缓存：切走本面板时清理 Atlas 释放资源（后台任务如切片/构建不受影响）
onDeactivated(() => {
    if (atlasModuleRef.value) {
        atlasModuleRef.value.cleanupAtlas()
    }
})

onBeforeUnmount(() => {
    if (atlasModuleRef.value) {
        atlasModuleRef.value.cleanupAtlas()
    }
    cleanupScrollListener()
    window.removeEventListener('resize', onWindowResize)
    window.removeEventListener('focus', onWindowFocusFileCheck)
    store.saveConfig()
})
</script>
    
<template>
    <div class="main">
        <div class="top-bar">
            <div class="top-tabs">
                <button class="tab-btn" :class="{ active: viewMode=='qa' }" @click="viewMode='qa'">
                    <i class="fa fa-comment-o"></i> {{ store.locales == 'zh' ? '问答' : 'QA' }}
                </button>
                <button class="tab-btn" :class="{ active: viewMode=='file' }" @click="viewMode='file'">
                    <i class="fa fa-book"></i> {{ store.locales == 'zh' ? '文件' : 'Files' }}
                </button>
                <button class="tab-btn" :class="{ active: viewMode=='slice' }" @click="viewMode='slice'">
                    <i class="fa fa-file-text-o"></i> {{ store.locales == 'zh' ? '切片' : 'Slices' }}
                </button>
                <button class="tab-btn" :class="{ active: viewMode=='question' }" @click="viewMode='question'">
                    <i class="fa fa-question-circle-o"></i> {{ store.locales == 'zh' ? '问题' : 'Questions' }}
                </button>
                <button class="tab-btn" :class="{ active: viewMode=='card' }" @click="viewMode='card'">
                    <i class="fa fa-cubes"></i> {{ store.locales == 'zh' ? '百科' : 'Encyclopedia' }}
                </button>
                <button class="tab-btn" :class="{ active: viewMode=='ontology' }" @click="viewMode='ontology'">
                    <i class="fa fa-eercast"></i> {{ store.locales == 'zh' ? '本体' : 'Ontology' }}
                </button>
                <button class="tab-btn" :class="{ active: viewMode=='test' }" @click="viewMode='test'">
                    <i class="fa fa-flask"></i> {{ store.locales == 'zh' ? '测试' : 'Test' }}
                </button>
                <button class="tab-btn" :class="{ active: viewMode=='set' }" @click="viewMode='set'">
                    <i class="fa fa-cog"></i> {{ store.locales == 'zh' ? '设置' : 'Settings' }}
                </button>
            </div>
            <div class="top-spacer"></div>
            <!-- 顶部右侧工具栏（知识库） -->
            <div class="manage-toolbar">
                <select v-if="knowledgeBases.length > 0" v-model="selectedKbIndex" class="kb-select" @change="loadKnowledgeBases(selectedKbIndex)" title="知识库版本切换">
                    <option v-for="(kb, index) in knowledgeBases" :key="index" :value="index">
                        {{ kb.label }}
                    </option>
                </select>
                <div class="button" @click="openFolder" :title="store.locales == 'zh' ? '选择知识库文件夹' : 'Select KB folder'">
                    <i class="fa fa-folder-open"></i>
                </div>
                <div class="button" v-if="isSliced" title="保存知识库" @click="save">
                    <i class="fa fa-floppy-o"></i>
                </div>
            </div>
        </div>

        <!-- ====== 问答视图 ====== -->
        <div v-if="viewMode=='qa'" class="qa-view">
            <!-- 左侧：问答主区域 -->
            <div class="qa-main">
                <div class="qa-input-wrap">
                    <input class="qa-input" v-model="prompt" :placeholder="store.locales=='zh'?'请输入问题':'Please enter your question'" @keyup.enter="handleSearch"/>
                    <!-- 切片策略（提问前自动准备 / 增量切片时按此策略执行；已切片需重新切片生效） -->
                    <select class="qa-method-select" v-model="model.sliceStrategy" :title="store.locales=='zh' ? '切片策略（自动准备 / 增量切片时生效）' : 'Slice strategy (used when auto-prepping / incremental slicing)'">
                        <option value="语义">{{ store.locales=='zh' ? '语义' : 'semantic' }}</option>
                        <option value="智能">{{ store.locales=='zh' ? '智能' : 'smart' }}</option>
                        <option value="标识符">{{ store.locales=='zh' ? '标识符' : 'identifier' }}</option>
                    </select>
                    <select class="qa-method-select" v-model="queryMethod" :title="store.locales=='zh'?'检索方式':'Search method'">
                        <option v-for="opt in strategyOptions" :key="opt.id" :value="opt.id">{{ opt.label }}</option>
                    </select>
                    <input type="number" v-model.number="model.evidenceTopK" min="1" max="50" class="qa-evidence-topk-input"
                        :title="store.locales=='zh' ? '佐证数量（右侧面板展示上限）' : 'Evidence count (right panel display cap)'" />
                    <button class="button qa-search-btn" :title="store.locales=='zh'?'查询':'Search'" @click="handleSearch">
                        <i class="fa fa-search"></i>
                    </button>
                </div>
                <div class="scoll qa-result-scroll">
                    <block_md :content="result" :fontSize="'12px'"/>
                </div>
            </div>
            <!-- 右侧：推理路径 / 佐证 tab 面板（两栏切换） -->
            <div v-if="agentSteps.length > 0 || currentEvidence.length > 0" class="qa-right-panel">
                <div class="qa-right-tabs">
                    <button v-if="agentSteps.length > 0" class="qa-right-tab" :class="{ on: activeRightTab === 'steps' }" @click="rightTab = 'steps'">
                        <i class="fa fa-random"></i> {{ store.locales == 'zh' ? `推理路径 (${agentSteps.length})` : `Reasoning (${agentSteps.length})` }}
                    </button>
                    <button v-if="currentEvidence.length > 0" class="qa-right-tab" :class="{ on: activeRightTab === 'evidence' }" @click="rightTab = 'evidence'">
                        <i class="fa fa-gavel"></i> {{ store.locales == 'zh' ? `佐证 (${currentEvidence.length})` : `Evidence (${currentEvidence.length})` }}
                    </button>
                </div>
                <!-- 推理路径 tab：Agentic 工具调用轨迹 -->
                <div v-if="activeRightTab === 'steps' && agentSteps.length > 0" class="qa-right-body">
                    <div v-for="(st, i) in agentSteps" :key="i" class="qa-agent-step" :class="st.status">
                        <div class="qa-agent-step-head">
                            <span class="qa-agent-step-round">#{{ st.round }}</span>
                            <span class="qa-agent-step-tool">{{ qaAgentToolLabel(st.tool) }}</span>
                            <span class="qa-agent-step-status" :class="st.status">
                                <i class="fa" :class="st.status === 'running' ? 'fa-spinner fa-spin' : st.status === 'done' ? 'fa-check-circle' : 'fa-times-circle'"></i>
                                {{ store.locales == 'zh' ? (st.status === 'running' ? '执行中' : st.status === 'done' ? '完成' : '失败') : st.status }}
                            </span>
                        </div>
                        <div class="qa-agent-step-args" v-if="st.args && Object.keys(st.args).length">
                            {{ store.locales == 'zh' ? '参数' : 'Args' }}: {{ JSON.stringify(st.args) }}
                        </div>
                        <div class="qa-agent-step-result">{{ st.result }}</div>
                    </div>
                </div>
                <!-- 佐证 tab：当前问答的证据 -->
                <div v-else-if="activeRightTab === 'evidence' && currentEvidence.length > 0" class="qa-right-body">
                    <div v-for="(ev, idx) in currentEvidence" :key="ev.id" class="evidence-item">
                        <div class="evidence-item-head">
                            <span class="evidence-idx">{{ idx + 1 }}</span>
                            <span class="evidence-label" :title="ev.filePath">{{ ev.label }}</span>
                            <span class="evidence-method">{{ getEvidenceMethodLabel(ev.method) }}</span>
                            <span class="evidence-score" v-if="ev.score > 0 && evidenceMaxScore > 0">{{ ((ev.score / evidenceMaxScore) * 100).toFixed(1) }}%</span>
                        </div>
                        <div class="evidence-content">
                            <block_md :content="ev.content" :fontSize="'10px'" :maxHeight="'80px'"/>
                        </div>
                        <div class="evidence-reason" v-if="ev.reason">{{ ev.reason }}</div>
                    </div>
                </div>
            </div>
        </div>

        <!-- ====== 其他视图（文件/切片/本体/百科/设置；问题页已独立为常驻容器） ====== -->
        <div v-else-if="viewMode !== 'test' && viewMode !== 'question'" class="content-view">
            <div class="scoll" style="max-width: 100%;flex:2;height:100%;overflow-y: auto;overflow-x: hidden;">
                    <!-- 文件视图（状态/规范化 + 文件列表 + 摘要 + 预览 + 悬浮提示） -->
                    <fileView
                        v-if="viewMode=='file'"
                        :store="store"
                        :files="files"
                        :selected-file-index="selectedFileIndex"
                        :file-changes="fileChanges"
                        :current-file-summary="currentFileSummary"
                        :preview-content="previewContent"
                        :tooltip-visible="tooltipVisible"
                        :tooltip-data="tooltipData"
                        :tooltip-pos="tooltipPos"
                        :on-preview="previewFile"
                        :on-show-tooltip="showTooltip"
                        :on-hide-tooltip="hideTooltip"
                    />

                    <!-- 切片视图 -->
                    <!-- 切片视图（工具栏 + 卡片网格；逻辑/数据由父壳注入） -->
                    <sliceView
                        v-if="viewMode=='slice'"
                        :store="store"
                        :model="model"
                        :documents="documents"
                        :document-name="documentName"
                        :blocks="blocks"
                        :filtered-blocks="filteredBlocks"
                        :displayed-blocks="displayedBlocks"
                        :displayed-count="displayedCount"
                        :has-more-blocks="hasMoreBlocks"
                        :is-loading-more="isLoadingMore"
                        :load-chunk-size="LOAD_CHUNK_SIZE"
                        :slice-view-cfg="sliceViewCfg"
                        :slice-zoom="sliceZoom"
                        :is-sliced="isSliced"
                        :is-embedded="isEmbedded"
                        :ingest-running="ingestRunning"
                        :incremental-running="incrementalRunning"
                        :embedded-count="embeddedCount"
                        :search-keyword="sliceSearchKeyword"
                        :on-search="(kw: string) => { sliceSearchKeyword = kw }"
                        :on-slice="sliceOnly"
                        :on-embed="embedBlocks"
                        :on-ingestion="runStrategyIngestion"
                        :on-incremental="runIncrementalUpdate"
                        :on-reset-zoom="resetSliceZoom"
                        :on-scroll="handleScroll"
                        :on-wheel="handleSliceWheel"
                        @change-document="(n: string) => { documentName = n }"
                    />
                    
                    <!-- 本体视图 -->
                    <div v-if="viewMode=='ontology'" style="display: flex;flex-direction: column;height:100%;">
                        <OntologyViewer
                            :ontology-data="ontologyData"
                            :blocks="blocksWithId"
                            :files="files"
                            :community-result="communityResult"
                            :build-progress="buildProgress"
                            :build-progress-percent="buildProgressPercent"
                            :build-progress-text="buildProgressText"
                            :model-ontology-batch-size="model.ontologyBatchSize"
                            :community-reports-count="communityReports.length"
                            :community-reports="communityReports"
                            :questions="questionBank"
                            @node-click="handleNodeClick"
                            @block-click="handleBlockClick"
                            @start-build="startBuildOntology"
                            @pause-build="pauseBuildOntology"
                            @stop-build="stopBuildOntology"
                            @continue-build="continueBuildOntology"
                            @detect-communities="detectCommunities"
                            @generate-reports="generateCommunityReportsAction"
                            @re-reason-community="reReasonCommunity"
                            @update-batch-size="(v: number) => setOntologyBatchSize(v)"
                            @update-total-nodes="(v: number) => ontologyTotalNodes = v"
                            @link-concepts="handleManualLink"
                            @state-message="(s: string) => kb_state = s"
                            style="flex:1;overflow: hidden;"
                        />
                    </div>

                    <!-- 卡片视图 -->
                    <!-- 百科视图（实体卡片；搜索/推理/描述编辑等逻辑由父壳注入） -->
                    <cardView
                        v-if="viewMode=='card'"
                        :store="store"
                        :entity-cards="entityCards"
                        :filtered-entity-cards="filteredEntityCards"
                        :reasoning-cards-set="reasoningCardsSet"
                        :is-batch-reasoning="isBatchReasoning"
                        :batch-reasoning-progress="batchReasoningProgress"
                        :batch-reasoning-progress-text="batchReasoningProgressText"
                        :show-detail="showEntityCardDetail"
                        :selected="selectedEntityForCards"
                        :entity-card-detail-blocks="entityCardDetailBlocks"
                        :is-reasoning-detail="isReasoningDetail"
                        :editing="isEditingDescription"
                        :search-keyword="cardSearchKeyword"
                        :on-search="(kw: string) => { cardSearchKeyword = kw; handleCardSearch() }"
                        :on-add-entity="openAddEntityModal"
                        :on-clear-ontology="clearOntology"
                        :on-batch-reason="batchReasoningAllCards"
                        :on-stop-batch="stopBatchReasoning"
                        :on-select="selectEntityCard"
                        :on-delete="deleteEntity"
                        :on-close-detail="closeEntityCardDetail"
                        :on-reason-detail="reasonSingleCardFromDetail"
                        :on-toggle-edit="(on: boolean) => { isEditingDescription = on }"
                        :on-save-description="saveDescriptionToGlobal"
                        :on-view-block="viewBlockContent"
                        :on-get-file-icon="getFileIcon"
                        :on-get-block-file-info="getBlockFileInfo"
                        :build-progress="buildProgress"
                        :build-progress-percent="buildProgressPercent"
                        :build-progress-text="buildProgressText"
                        :on-start-build="startBuildOntology"
                        :on-pause-build="pauseBuildOntology"
                        :on-stop-build="stopBuildOntology"
                        :on-continue-build="continueBuildOntology"
                    />

                    <!-- 设置视图 -->
                    <div v-if="viewMode=='set'" style="display:flex;height:100%;width:100%;">
                        <configManager
                            :store="store"
                            :model="model"
                            :getModel="getModel"
                            @updateState="(state:any) => kb_state = state"
                            @loadKnowledgeBase="handleLoadKnowledgeBase"
                            @strategiesChanged="refreshStrategies"
                            @embed-model-change="handleEmbedModelChange"
                        />
                    </div>

                </div>
            </div>

        <!-- 问题视图（常驻保活：v-show 切走不销毁组件，独立性评审等会话内状态 / 滚动位置得以保留） -->
        <div v-show="viewMode=='question'" class="question-view-host">
            <questionView
                :model="model"
                :question-bank="questionBank"
                :blocks="blocks"
                :files="files"
                :extract-progress="extractProgress"
                :extract-progress-percent="extractProgressPercent"
                :extract-progress-text="extractProgressText"
                :get-model="getModel"
                :on-start-extract="startExtract"
                :on-pause-extract="pauseExtract"
                :on-stop-extract="stopExtract"
                :on-continue-extract="continueExtract"
                :on-apply-question-bank="applyQuestionBank"
                :on-add-manual-question="addManualQuestion"
                :on-remove-question="removeQuestionById"
                :on-update-question="updateQuestionById"
                :on-embed-missing="embedMissingQuestionVectors"
                @update-state="(s: any) => kb_state = s"
                @update-live-state="(s: any) => kbLiveState = s"
                @update-review-bad="(n: number) => questionBadCount = n"
                @update-review-status="(s: string) => questionReviewStatus = s"
                @update-review-running="(b: boolean) => questionReviewRunning = b"
            />
        </div>

        <!-- 测试视图（常驻保活：切换视图不销毁组件，批量测试可在后台继续运行） -->
        <div v-show="viewMode=='test'" class="test-view-host">
            <testManager
                :store="store"
                :blocks="blocks"
                :files="files"
                :model="model"
                :getModel="getModel"
                :globalEntities="globalEntities"
                :getCurrentOntologyContext="getCurrentOntologyContext"
                :communityReports="communityReports"
                :communityResult="communityResult"
                :chatWithOntology="chatWithOntology"
                :testCases="testCases"
                :onRefreshTestCases="refreshTestCasesFromBank"
                :fileIndex="fileIndex"
                :questionVectorsByBlock="questionVectorsByBlockIndex()"
                :strategyVersion="strategyVersion"
                :ensureCommunityReports="ensureCommunityReports"
                @testCasesChange="onTestCasesChange"
                @updateState="(state:any) => kb_state = state"
                @updateLiveState="(state:any) => kbLiveState = state"
                @updateDedupProgress="(p:any) => dedupProgress = p"
            />
        </div>

        <!-- 考试模块已迁移至「学习」主面板（components/learning/examView.vue） -->

        <!-- 状态栏：显示在所有标签页下方（当前文件夹 + 知识库状态 + 行为状态） -->
        <div class="prep-status-panel">
            <!-- 最左：当前知识库文件夹（悬停 title 显示完整路径） -->
            <span class="folder-path prep-folder" :title="store.root || (store.locales == 'zh' ? '未选择文件夹' : 'No folder selected')">
                <i class="fa fa-folder prep-folder-ic"></i>
                {{ rootFolderName }}
            </span>
            <!-- 有未完成处理进度时，左侧提供"继续"图标（仅 fa-icon） -->
            <i v-if="hasUnfinishedProgress" class="fa fa-play-circle prep-continue-btn" :title="store.locales == 'zh' ? '继续处理知识库' : 'Resume processing'" @click="continuePendingWork"></i>
            <!-- 知识库当前状态（文件/切片/向量化/语义增强/本体/社区/报告）始终显示，悬浮 title 显示完整说明 -->
            <div v-for="(item, i) in prepStatusItems" :key="'kb-' + i" class="prep-status-step" :class="item.status" :title="item.title">
                <i class="fa" :class="item.icon"></i>
                <span class="prep-step-name">{{ item.text }}</span>
            </div>
            <!-- 行为状态：只显示最新一条（正在干什么 / 提示；悬浮 title 显示完整说明） -->
            <div v-if="latestBehavior" class="prep-status-step prep-live" :class="latestBehavior.status" :title="latestBehavior.text + (latestBehavior.detail ? ' · ' + latestBehavior.detail : '')">
                <i class="fa" :class="latestBehavior.icon"></i>
                <span class="prep-step-name">{{ latestBehavior.text }}</span>
                <span class="prep-step-detail" v-if="latestBehavior.detail">{{ latestBehavior.detail }}</span>
            </div>
            <!-- 文件标签页专属：规范化 + 摘要 状态与批量操作（仅 viewMode==file 显示；置于状态栏最右） -->
            <template v-if="viewMode === 'file'">
                <span class="prep-file-sep"></span>
                <!-- 规范化（PDF/Word → Markdown） -->
                <div v-if="normalizeState.total > 0" class="prep-file-opts" :title="store.locales=='zh' ? 'PDF/Word 规范化状态（可批量转为同名 .md）' : 'PDF/Word normalization status'">
                    <i class="fa fa-file-code-o" :style="{color: normalizeState.missing > 0 ? '#FF9800' : '#4CAF50'}"></i>
                    <span v-if="normalizeState.converting" class="prep-file-text">
                        {{ normalizeState.convertingText || (store.locales == 'zh' ? '转换中…' : 'Converting…') }}
                        <i class="fa fa-spinner fa-spin"></i>
                    </span>
                    <span v-else-if="normalizeState.missing > 0" class="prep-file-text">{{ normalizeState.missing }} {{ store.locales == 'zh' ? '待转 md' : 'to convert' }}</span>
                    <span v-else class="prep-file-text"><i class="fa fa-check-circle"></i> {{ store.locales == 'zh' ? '均已规范化' : 'All normalized' }}</span>
                    <button
                        v-if="normalizeTargets.length > 0"
                        class="prep-file-btn"
                        :disabled="normalizeState.converting"
                        :title="store.locales == 'zh' ? '批量将 PDF/Word 转为同名 .md' : 'Batch convert PDF/Word to .md'"
                        @click="normalizeFiles()"
                    >
                        <i class="fa" :class="normalizeState.converting ? 'fa-spinner fa-spin' : 'fa-magic'"></i>
                    </button>
                </div>
                <!-- 摘要批量生成（Markdown 文档缺摘要） -->
                <div v-if="summaryState.total > 0" class="prep-file-opts" :title="store.locales=='zh' ? '文件摘要状态（可批量生成缺失摘要并回写 frontmatter）' : 'File summary status'">
                    <i class="fa fa-file-text-o" :style="{color: summaryState.missing > 0 ? '#FF9800' : '#4CAF50'}"></i>
                    <span v-if="summaryState.generating" class="prep-file-text">
                        {{ summaryState.generatingText || (store.locales == 'zh' ? '生成中…' : 'Generating…') }}
                        <i class="fa fa-spinner fa-spin"></i>
                    </span>
                    <span v-else-if="summaryState.missing > 0" class="prep-file-text">{{ summaryState.missing }} {{ store.locales == 'zh' ? '缺摘要' : 'missing summary' }}</span>
                    <span v-else class="prep-file-text"><i class="fa fa-check-circle"></i> {{ store.locales == 'zh' ? '均有摘要' : 'All summarized' }}</span>
                    <button
                        v-if="summaryState.missing > 0"
                        class="prep-file-btn"
                        :disabled="summaryState.generating"
                        :title="store.locales == 'zh' ? '为缺少摘要的文档批量生成摘要（LLM 并回写 frontmatter）' : 'Generate summaries for docs missing one'"
                        @click="generateFileSummaries()"
                    >
                        <i class="fa" :class="summaryState.generating ? 'fa-spinner fa-spin' : 'fa-magic'"></i>
                    </button>
                </div>
                <!-- 文件变更汇总（新增/修改/删除，仅提示非操作） -->
                <div v-if="fileChangeTotal > 0" class="prep-file-opts" :title="store.locales=='zh' ? '最近一次检测到的文件变更' : 'Recent file changes'">
                    <i class="fa fa-refresh"></i>
                    <span class="prep-file-text">{{ store.locales == 'zh'
                        ? `变更 新增 ${fileChanges.added.length} / 修改 ${fileChanges.modified.length} / 删除 ${fileChanges.deleted.length}`
                        : `+${fileChanges.added.length} ~${fileChanges.modified.length} -${fileChanges.deleted.length}` }}</span>
                </div>
            </template>
        </div>

        <!-- 手动添加实体模态框 -->
        <div v-if="showAddEntityModal" class="modal-overlay" @click.self="closeAddEntityModal">
            <div class="modal-content" @keydown="handleModalKeydown">
                <div class="modal-header">
                    <h3>{{ store.locales == 'zh' ? '手动添加实体' : 'Add Entity Manually' }}</h3>
                    <button class="modal-close" @click="closeAddEntityModal" :disabled="isAddingEntity">
                        <i class="fa fa-times"></i>
                    </button>
                </div>
                <div class="modal-body">
                    <div class="modal-description">
                        {{ store.locales == 'zh' ? 
                            '输入实体名称，系统将自动在所有切片中搜索匹配的内容，关联相关切片，并生成描述。' : 
                            'Enter entity name, the system will automatically search all slices for matching content, associate relevant slices, and generate a description.' 
                        }}
                    </div>
                    <div class="modal-input-group">
                        <label for="newEntityNameInput">
                            {{ store.locales == 'zh' ? '实体名称：' : 'Entity Name:' }}
                        </label>
                        <input 
                            id="newEntityNameInput"
                            v-model="newEntityName" 
                            type="text"
                            :placeholder="store.locales == 'zh' ? '例如：装备、人物等...' : 'e.g., AI, Machine Learning, Contract Terms...'"
                            :disabled="isAddingEntity"
                            autocomplete="off"
                        />
                    </div>
                    
                    <!-- 新增：匹配统计显示 -->
                    <div v-if="newEntityName.trim()" class="match-stats">
                        <div class="match-stats-header">
                            <i class="fa fa-search"></i>
                            {{ store.locales == 'zh' ? '匹配结果' : 'Match Results' }}
                        </div>
                        <div class="match-stats-item" :class="{ 'match-warning': matchStats.matchedBlocksCount === 0, 'match-success': matchStats.matchedBlocksCount > 0 }">
                            <i class="fa fa-file-text-o"></i>
                            <span>{{ store.locales == 'zh' ? `匹配切片: ${matchStats.matchedBlocksCount} 个` : `Matched blocks: ${matchStats.matchedBlocksCount}` }}</span>
                        </div>
                        <div class="match-stats-item" :class="{ 'match-warning': matchStats.isDuplicate, 'match-success': !matchStats.isDuplicate && matchStats.matchedBlocksCount > 0 }">
                            <i class="fa" :class="matchStats.isDuplicate ? 'fa-exclamation-triangle' : 'fa-check-circle'"></i>
                            <span v-if="matchStats.isDuplicate">
                                {{ store.locales == 'zh' ? `实体已存在: "${matchStats.duplicateName}"，添加将更新关联切片` : `Entity already exists: "${matchStats.duplicateName}", adding will update associations` }}
                            </span>
                            <span v-else>
                                {{ store.locales == 'zh' ? '新实体，可直接添加' : 'New entity, ready to add' }}
                            </span>
                        </div>
                        <div v-if="matchStats.matchedFilePaths.length > 0" class="match-stats-item match-files">
                            <i class="fa fa-folder-open"></i>
                            <span>{{ store.locales == 'zh' ? `关联文件: ${matchStats.matchedFilePaths.length} 个` : `Associated files: ${matchStats.matchedFilePaths.length}` }}</span>
                            <div class="match-file-list" v-if="matchStats.matchedFilePaths.length <= 5">
                                <span v-for="filePath in matchStats.matchedFilePaths" :key="filePath" class="match-file-item">
                                    {{ filePath.split('/').pop() }}
                                </span>
                            </div>
                            <div v-else class="match-file-list">
                                <span class="match-file-item">{{ matchStats.matchedFilePaths.length }} {{ store.locales == 'zh' ? '个文件' : 'files' }}</span>
                            </div>
                        </div>
                    </div>
                    
                    <div v-if="addEntityError && !(matchStats.matchedBlocksCount === 0 && newEntityName.trim())" class="modal-error">
                        <i class="fa fa-exclamation-triangle"></i> {{ addEntityError }}
                    </div>
                    <div v-if="isAddingEntity" class="modal-loading">
                        <i class="fa fa-spinner fa-spin"></i> 
                        {{ store.locales == 'zh' ? '正在搜索切片并生成描述...' : 'Searching slices and generating description...' }}
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="modal-btn modal-btn-cancel" @click="closeAddEntityModal" :disabled="isAddingEntity">
                        {{ store.locales == 'zh' ? '取消' : 'Cancel' }}
                    </button>
                    <button class="modal-btn modal-btn-confirm" @click="addEntityManually" :disabled="isAddingEntity || !newEntityName.trim() || matchStats.matchedBlocksCount === 0">
                        <i class="fa fa-plus"></i> 
                        {{ matchStats.isDuplicate ? (store.locales == 'zh' ? '更新并生成描述' : 'Update & Generate Description') : (store.locales == 'zh' ? '添加并生成描述' : 'Add & Generate Description') }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>
    
<style scoped>
    .main{
        display:flex;
        flex-direction: column;
        width:100%;
        height:calc(100% - 0px);
        overflow: hidden;
    }
    .top-bar {
        display: flex;
        align-items: center;
        border-bottom: 1px solid var(--borderColor);
        flex-shrink: 0;
        background: var(--menuColor);
    }
    .top-tabs {
        display: flex;
        flex-shrink: 0;
    }
    .top-tabs .tab-btn {
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
    .top-tabs .tab-btn:hover {
        background: var(--backgroundColor);
    }
    .top-tabs .tab-btn.active {
        border-bottom-color: var(--fontActiveColor);
        color: var(--fontActiveColor);
        background: var(--backgroundColor);
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
    /* 顶部工具栏弹性占位 */
    .top-spacer {
        flex: 1;
    }
    /* 知识库版本切换下拉框 */
    .kb-select {
        width: 120px;
        height: 26px;
        margin: 0 5px;
        background-color: var(--backgroundColor);
        flex-shrink: 0;
        border: 0px;
    }

    /* ====== 问答视图 ====== */
    .qa-view {
        display: flex;
        flex-direction: row;
        flex: 1;
        min-height: 0;
        min-width: 0;
        overflow: hidden;
    }
    /* 问答主区域（左侧） */
    .qa-main {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-width: 0;
        container-type: inline-size;
    }
    /* 提问输入容器（问题/检索方式/查询按钮同一行） */
    .qa-input-wrap {
        display: flex;
        flex-direction: row;
        align-items: center;
        width: 100%;
        box-sizing: border-box;
        padding: 5px;
        gap: 5px;
    }
    /* 提问输入框 */
    .qa-input {
        flex: 1;
        min-width: 0;
        box-sizing: border-box;
        margin: 0px;
        padding: 5px;
        height: 30px;
        background-color: var(--backgroundColor);
    }
    /* 检索方式下拉框 */
    .qa-method-select {
        flex-shrink: 0;
        width: 90px;
        height: 30px;
        padding: 0 4px;
        background-color: var(--backgroundColor);
        color: var(--fontColor);
        border: 1px solid var(--borderColor);
        border-radius: 3px;
        font-size: 12px;
        box-sizing: border-box;
        margin: 0px
    }
    /* 佐证数量输入框（样式与检索方式下拉一致，带上下调节按钮） */
    .qa-evidence-topk-input {
        flex-shrink: 0;
        width: 40px;
        height: 30px;
        padding: 0 2px;
        background-color: var(--backgroundColor);
        color: var(--fontColor);
        border: 1px solid var(--borderColor);
        border-radius: 3px;
        font-size: 12px;
        text-align: center;
        box-sizing: border-box;
        margin: 0px;
        outline: none;
    }
    /* 查询按钮（仅图标；双类名提升特异性，避免被 .button 的 border:0 覆盖） */
    .button.qa-search-btn {
        flex-shrink: 0;
        height: 30px;
        min-width: 30px;
        border: 1px solid var(--borderColor);
        background-color: var(--backgroundColor);
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--fontColor);
    }
    /* 问答结果滚动区 */
    .qa-result-scroll {
        flex: 1;
        overflow-y: auto;
        border: 1px solid var(--borderColor);
        margin: 0px 5px 5px 5px;
        border-radius: 5px;
    }
    /* ====== 问答右侧面板（推理路径 / 佐证 tab 切换） ====== */
    .qa-right-panel {
        border-left: 1px solid var(--borderColor);
        flex-shrink: 0;
        width: 320px;
        min-width: 220px;
        max-width: 45%;
        display: flex;
        flex-direction: column;
        background: var(--backgroundColor);
    }
    .qa-right-tabs {
        display: flex;
        flex-direction: row;
        align-items: stretch;
        gap: 2px;
        padding: 4px 4px 0 4px;
        background: var(--menuColor);
        flex-shrink: 0;
    }
    .qa-right-tab {
        flex: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        padding: 4px 6px;
        font-size: 11px;
        color: var(--fontColor);
        background: transparent;
        border: 1px solid transparent;
        border-bottom: none;
        border-radius: 4px 4px 0 0;
        cursor: pointer;
        user-select: none;
        opacity: .75;
        transition: all .12s;
    }
    .qa-right-tab:hover { opacity: 1; color: var(--fontActiveColor); }
    .qa-right-tab.on {
        opacity: 1;
        color: var(--fontActiveColor);
        font-weight: 600;
        background: var(--backgroundColor);
        border-color: var(--borderColor);
    }
    .qa-right-tab .fa { font-size: 11px; }
    .qa-right-body {
        flex: 1;
        overflow-y: auto;
        padding: 5px;
    }
    .qa-agent-step {
        border: 1px solid var(--borderColor);
        border-radius: 4px;
        padding: 4px 5px;
        margin-bottom: 4px;
        background: var(--backgroundColor);
    }
    .qa-agent-step-head {
        display: flex;
        align-items: center;
        gap: 6px;
    }
    .qa-agent-step-round {
        font-size: 10px;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: var(--fontActiveColor);
        color: #fff;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
    }
    .qa-agent-step-tool {
        font-size: 11px;
        font-weight: 500;
        color: var(--fontColor);
    }
    .qa-agent-step-status {
        font-size: 9px;
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: 3px;
        flex-shrink: 0;
    }
    .qa-agent-step-status.running { color: #409EFF; }
    .qa-agent-step-status.done { color: #67C23A; }
    .qa-agent-step-status.error { color: #F56C6C; }
    .qa-agent-step-args {
        font-size: 9px;
        color: var(--borderColor);
        margin-top: 3px;
        word-break: break-all;
    }
    .qa-agent-step-result {
        font-size: 10px;
        color: var(--fontColor);
        line-height: 1.4;
        margin-top: 2px;
        max-height: 100px;
        overflow-y: auto;
        word-break: break-all;
        white-space: pre-wrap;
    }

    /* ====== 其他内容视图 ====== */
    .content-view {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        overflow: hidden;
    }
    /* 问题视图常驻容器（v-show 保活：切走不销毁组件，独立性评审等会话内状态 / 滚动位置保留） */
    .question-view-host {
        display: flex;
        flex: 1;
        min-height: 0;
        width: 100%;
        overflow: hidden;
    }
    /* 测试视图常驻容器（v-show 保活：切走不销毁组件，批量测试可在后台继续运行） */
    .test-view-host {
        display: flex;
        flex: 1;
        min-height: 0;
        width: 100%;
        overflow: hidden;
    }

    /* ====== 自动准备知识库状态栏（输出内容下方，底部状态栏） ====== */
    .prep-status-panel {
        display: flex;
        flex-direction: row;
        align-items: center;
        flex-wrap: nowrap;
        column-gap: 12px;
        padding: 6px 10px;
        background: var(--menuColor);
        border-top: 1px solid var(--borderColor);
        border-radius: 0;
        flex-shrink: 0;
        overflow: hidden;
        min-width: 0;
    }
    /* 状态栏最左：当前文件夹（小字号 + 文件夹图标，与状态步骤同风格；右分隔线，可收缩截断） */
    .prep-status-panel .prep-folder {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        flex-shrink: 1;
        min-width: 0;
        max-width: 240px;
        padding-right: 10px;
        border-right: 1px solid var(--borderColor);
        font-size: 11px;
        overflow: hidden;
        white-space: nowrap;
    }
    .prep-status-panel .prep-folder-ic {
        flex-shrink: 0;
        font-size: 11px;
        color: #E6A23C;
    }
    /* 文件标签页专属操作区（规范化/摘要/文件变更）：与行为状态用分隔线隔开，置最右 */
    .prep-file-sep {
        flex: 1;
        min-width: 8px;
        flex-shrink: 0;
    }
    .prep-file-opts {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: 11px;
        color: var(--fontColor);
        white-space: nowrap;
        flex-shrink: 0;
        min-width: 0;
    }
    .prep-file-opts > i.fa:first-child {
        font-size: 11px;
        flex-shrink: 0;
    }
    .prep-file-text {
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
        max-width: 240px;
    }
    .prep-file-text .fa {
        font-size: 11px;
    }
    .prep-file-btn {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: auto;
        height: auto;
        padding: 0 2px;
        border: none;
        background: transparent;
        color: var(--fontActiveColor);
        font-size: 12px;
        line-height: 1;
        cursor: pointer;
        border-radius: 3px;
        transition: opacity 0.15s;
    }
    .prep-file-btn:hover:not(:disabled) {
        opacity: 0.75;
    }
    .prep-file-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
    /* 未完成处理进度时的"继续"图标（仅 fa-icon，无按钮） */
    .prep-continue-btn {
        font-size: 14px;
        color: #409EFF;
        cursor: pointer;
        flex-shrink: 0;
        user-select: none;
    }
    .prep-continue-btn:hover {
        opacity: 0.7;
    }
    /* 实时状态（检索测试/批测进度等）：与知识库标题区分 */
    .prep-live {
        border-left: 1px solid var(--borderColor);
        padding-left: 10px;
        max-width: 340px;
    }
    /* 状态信息行（kb_state 显示于此）：可收缩 + 限制最大宽度，长文本省略 */
    .prep-status-step.prep-msg {
        flex-shrink: 1;
        max-width: 420px;
    }
    .prep-status-step.prep-msg .prep-step-name {
        max-width: 400px;
    }
    .prep-status-step.warning .fa {
        color: #E6A23C;
    }
    .prep-status-step {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        color: var(--fontColor);
        white-space: nowrap;
        min-width: 0;
        overflow: hidden;
    }
    .prep-status-step .fa {
        font-size: 11px;
    }
    .prep-status-step.pending {
        opacity: 0.6;
    }
    .prep-status-step.running .fa {
        color: #409EFF;
    }
    .prep-status-step.running .prep-step-detail {
        color: #409EFF;
    }
    .prep-status-step.done .fa {
        color: #67C23A;
    }
    .prep-status-step.error .fa {
        color: #F56C6C;
    }
    .prep-step-name {
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
        max-width: 200px;
    }
    .prep-step-detail {
        color: var(--borderColor);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
        min-width: 0;
    }

    /* ====== 佐证条目样式（在右侧 tab 面板内复用） ====== */
    .evidence-item {
        border: 1px solid var(--borderColor);
        border-radius: 4px;
        padding: 5px;
        margin-bottom: 5px;
        background: var(--backgroundColor);
    }
    .evidence-item-head {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 3px;
    }
    .evidence-idx {
        font-size: 10px;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: var(--fontActiveColor);
        color: #fff;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
    }
    .evidence-label {
        font-size: 11px;
        font-weight: 500;
        color: var(--fontColor);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .evidence-method {
        font-size: 9px;
        color: #9b59b6;
        background: rgba(155, 89, 182, 0.1);
        padding: 1px 4px;
        border-radius: 8px;
        flex-shrink: 0;
    }
    .evidence-score {
        font-size: 10px;
        color: #FF9800;
        margin-left: auto;
        flex-shrink: 0;
    }
    .evidence-content {
        font-size: 10px;
        color: var(--fontColor);
        line-height: 1.4;
        margin-top: 2px;
        min-width: 0;
    }
    .evidence-reason {
        font-size: 9px;
        color: var(--borderColor);
        margin-top: 3px;
        display: -webkit-box;
        line-clamp: 2;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
    }

    .button{
        background-color: var(--menuColor);
        border: 0px;
        height:29px;
        min-width:29px;
        padding:0px;
        line-height:29px;
        margin:0px;
    }
    .button.active{
        border: 1px solid var(--fontActiveColor);
        color: var(--fontActiveColor);
        background: rgba(33, 150, 243, 0.12);
    }
    .button.disabled {
        opacity: 0.5;
        pointer-events: none;
    }
    /* ==================== 模态框样式 ==================== */
    .modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        backdrop-filter: blur(2px);
    }
    
    .modal-content {
        background: var(--backgroundColor);
        border: 1px solid var(--borderColor);
        border-radius: 8px;
        width: 450px;
        max-width: 90vw;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        animation: modalSlideIn 0.3s ease;
    }
    
    @keyframes modalSlideIn {
        from {
            opacity: 0;
            transform: translateY(-20px) scale(0.95);
        }
        to {
            opacity: 1;
            transform: translateY(0) scale(1);
        }
    }
    
    .modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 6px 8px;
        border-bottom: 1px solid var(--borderColor);
    }
    
    .modal-header h3 {
        margin: 0;
        font-size: 14px;
        color: var(--fontColor);
        display: flex;
        align-items: center;
        gap: 8px;
    }
    
    .modal-header h3::before {
        content: '\f067';
        font-family: FontAwesome;
        color: var(--fontActiveColor);
        font-size: 12px;
    }
    
    .modal-close {
        background: none;
        border: none;
        color: var(--borderColor);
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 16px;
        transition: all 0.2s;
    }
    
    .modal-close:hover {
        background: rgba(244, 67, 54, 0.1);
        color: #f44336;
    }
    
    .modal-close:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
    
    .modal-body {
        padding: 8px;
    }
    
    .modal-description {
        font-size: 11px;
        color: var(--borderColor);
        line-height: 1.5;
        padding: 8px 12px;
        background: rgba(33, 150, 243, 0.05);
        border-radius: 6px;
        border-left: 3px solid var(--fontActiveColor);
    }
    
    .modal-input-group {
        margin-bottom: 5px;
    }
    
    .modal-input-group label {
        display: block;
        font-size: 12px;
        color: var(--fontColor);
        font-weight: 500;
    }
    
    .modal-input-group input {
        width: 100%;
        margin: 0px;
        padding: 8px 12px;
        border: 1px solid var(--borderColor);
        border-radius: 6px;
        background: var(--backgroundColor);
        color: var(--fontColor);
        font-size: 13px;
        box-sizing: border-box;
        transition: border-color 0.2s;
    }
    
    .modal-input-group input:focus {
        outline: none;
        border-color: #2196F3;
        box-shadow: 0 0 0 2px rgba(33, 150, 243, 0.1);
    }
    
    .modal-input-group input:disabled {
        opacity: 0.6;
        cursor: not-allowed;
    }
    
    .modal-error {
        font-size: 11px;
        color: #f44336;
        padding: 8px 12px;
        background: rgba(244, 67, 54, 0.05);
        border-radius: 6px;
        border-left: 3px solid #f44336;
        margin-top: 5px;
        display: flex;
        align-items: center;
        gap: 6px;
    }
    
    .modal-loading {
        font-size: 11px;
        color: #FF9800;
        padding: 8px 12px;
        background: rgba(255, 152, 0, 0.05);
        border-radius: 6px;
        border-left: 3px solid #FF9800;
        margin-bottom: 12px;
        display: flex;
        align-items: center;
        gap: 6px;
    }
    
    .modal-footer {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 6px 8px;
        border-top: 1px solid var(--borderColor);
    }
    
    .modal-btn {
        padding: 8px 16px;
        border: 1px solid var(--borderColor);
        border-radius: 6px;
        font-size: 12px;
        cursor: pointer;
        transition: all 0.2s;
        display: flex;
        align-items: center;
        gap: 6px;
        background: var(--backgroundColor);
        color: var(--fontColor);
    }
    
    .modal-btn:hover:not(:disabled) {
        transform: translateY(-1px);
    }
    
    .modal-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
    
    .modal-btn-cancel:hover:not(:disabled) {
        background: rgba(158, 158, 158, 0.1);
    }
    
    .modal-btn-confirm {
        background: var(--fontActiveColor);
        color: white;
        border-color: var(--borderColor);
    }
    
    .modal-btn-confirm:hover:not(:disabled) {
        background: #1976D2;
        border-color: #1976D2;
        box-shadow: 0 2px 8px rgba(33, 150, 243, 0.3);
    }
    
    .match-stats {
        background: var(--backgroundColor);
        border: 1px solid var(--borderColor);
        border-radius: 6px;
        padding: 8px 12px;
    }

    .match-stats-header {
        font-size: 11px;
        font-weight: 500;
        color: #2196F3;
        margin-bottom: 8px;
        display: flex;
        align-items: center;
        gap: 6px;
        padding-bottom: 4px;
        border-bottom: 1px solid var(--borderColor);
    }

    .match-stats-item {
        font-size: 10px;
        padding: 4px 0;
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .match-stats-item i {
        width: 14px;
        font-size: 10px;
    }

    .match-stats-item.match-warning {
        color: #FF9800;
    }

    .match-stats-item.match-success {
        color: #4CAF50;
    }

    .match-stats-item.match-files {
        color: var(--fontColor);
        flex-wrap: wrap;
    }

    .match-file-list {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-left: 20px;
    }

    .match-file-item {
        font-size: 9px;
        background: rgba(33, 150, 243, 0.1);
        padding: 2px 6px;
        border-radius: 10px;
        color: var(--fontColor);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    /* ==================== 卡片视图样式（已迁移至 cardView.vue，此处移除） ==================== */
    
    ::-webkit-scrollbar {
        width: 4px;
        height: 4px;
    }
    
    ::-webkit-scrollbar-track {
        background: var(--backgroundColor);
    }
    
    ::-webkit-scrollbar-thumb {
        background: var(--borderColor);
        border-radius: 2px;
    }
</style>