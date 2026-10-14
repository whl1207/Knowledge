<!--
  solverView.vue —— 学习模块 · 答疑（P1-3）
  参考 DeepTutor 的 Smart Solver 思路做的本地化版本：复用现有 .kb 检索（kbRetrieval）
  与统一 AI 客户端（kbAiClient），强制模型「只依据检索到的切片作答 + 句末 [n] 引用」，
  答案用 Markdown 渲染（支持 mermaid），下方列出被引用的切片。

  与主页问答的区别：这里面向「学习场景」——偏概念讲解与复习，答案必须落在切片上，
  没有切片依据时要显式说明，避免编造。
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import block_md from '@/components/block_md.vue'
import * as kbAi from '@/shared/kbAiClient'
import { retrieveKnowledge, resolveStrategyId } from '@/shared/kbRetrieval'
import { normalizeLlmType, resolveLlmSource } from '@/shared/llmSources'
import { solverPrompt, solverAgentPrompt } from '@/services/learningPrompt'
import { keywordSearchBlocks } from '@/services/learningSearch'
import { agentBridge, type AgentSessionView, type ToolCallView } from '@/platform/agentBridge'
import { normalizeAgentMaxSteps } from '@/shared/agent-loop-rounds'

interface SolverRef { label: string; content: string; similarity: number }
/** 执行步骤（在卡片上展示本轮的“做了什么”，类似智能体执行过程） */
interface SolverStep {
  key: string
  zh: string
  en: string
  status: 'pending' | 'running' | 'done' | 'error'
  detail?: string
}
/** 本轮上下文来源：概览（文件摘要） / 向量检索 / 关键词兜底 */
type SolverScope = 'overview' | 'retrieval' | 'keyword'
interface SolverTurn {
  q: string
  a: string
  refs: SolverRef[]
  steps: SolverStep[]
  error?: string
  warn?: string              // 降级提示（向量检索不可用 → 已改用关键词兜底）
  scope?: SolverScope
  streaming?: boolean        // 流式输出中（正文以纯文本追写，结束后再渲染 Markdown）
  showSteps?: boolean        // 执行步骤展开开关
  elapsed?: number           // 本轮耗时（ms）
  sessionId?: string         // agent 会话 id（agent 模式；用于把会话视图投影回本轮）
  sawRunning?: boolean       // 是否见过 running（避免把创建期的初始 idle 误判为完成）
  lastPaint?: number         // 流式渲染节流时间戳
  at: number
}

const props = defineProps<{
  store: any
  kbPath: string
  model: any
  blocks?: any[]             // 当前 .kb 的切片（关键词兜底 / 概览代表切片）
  files?: { path: string; label: string }[]
  fileSummaries?: { path: string; label: string; content: string }[]   // 文件级摘要（概览型提问）
  entities?: any[]           // 本体实体（概览型提问的补充上下文）
}>()
const tr = (zh: string, en: string) => (props.store.locales === 'zh' ? zh : en)
const zh = () => props.store.locales === 'zh'

const question = ref('')
const turns = ref<SolverTurn[]>([])
const asking = ref(false)
const bodyEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLTextAreaElement | null>(null)

// ==================== agent 会话订阅 ====================
// 答疑走主页同一套 agent 循环（工具自主检索 + 流式 + 工具步骤可见）；
// 无 agent 运行时（纯网页端 / 未启用）时回退到本地检索 + 对话管线。
let agentUnsub: (() => void) | null = null
onMounted(() => { agentUnsub = agentBridge.on(onAgentView) })
onBeforeUnmount(() => { if (agentUnsub) { agentUnsub(); agentUnsub = null } })

const kbName = computed(() => {
  const p = String(props.kbPath || '')
  return p ? (p.split(/[\\/]/).pop() || '').replace(/\.kb$/i, '') : ''
})
const sliceCount = computed(() => (props.blocks || []).filter((b: any) => String(b?.A || '').trim()).length)

/** 引导问题卡片（图标 + 标题 + 问法）：面向学习的常见问法 */
const examples = computed(() => (zh()
  ? [
      { icon: 'fa-lightbulb-o', t: '梳理核心概念', d: '这份知识库讲了哪些核心概念？' },
      { icon: 'fa-list-ol', t: '按逻辑串一遍', d: '把重点内容按逻辑顺序梳理一遍' },
      { icon: 'fa-exchange', t: '辨析易混点', d: '容易混淆的概念之间有什么区别？' },
      { icon: 'fa-search', t: '定位出处原文', d: '某个结论对应的原文依据在哪里？' },
    ]
  : [
      { icon: 'fa-lightbulb-o', t: 'Core concepts', d: 'What core concepts does this KB cover?' },
      { icon: 'fa-list-ol', t: 'Logical outline', d: 'Walk me through the key content in logical order' },
      { icon: 'fa-exchange', t: 'Confusable pairs', d: 'What is the difference between the confusable concepts?' },
      { icon: 'fa-search', t: 'Locate the source', d: 'Where is the source text for this conclusion?' },
    ]))
/** 点击引导卡：只把问法填进输入框（可继续编辑），不直接提问 */
function fillExample(ex: { d: string }) {
  question.value = ex.d
  nextTick(() => {
    const el = inputEl.value
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) }
  })
}

async function scrollToBottom() {
  await new Promise(r => setTimeout(r, 30))
  const el = bodyEl.value
  if (el) el.scrollTop = el.scrollHeight
}

/** 知识库检索（复用主页同一套来源配置与嵌入兜底设置） */
async function retrieve(q: string) {
  const llmCfg = props.store.AIconfig?.llm
  const llmType = normalizeLlmType((llmCfg?.type as string) || 'ollama')
  const providerCfg = resolveLlmSource(llmCfg, llmType).config
  const embedFallback = kbAi.buildEmbedFallbackFromStore(props.store)
  return retrieveKnowledge(q, props.kbPath, {
    topK: 5,
    summaryWeight: 0.7,
    strategy: resolveStrategyId(undefined),
    llmType: llmType as any,
    providerConfig: providerCfg || undefined,
    embedFallbackType: embedFallback?.llmType,
    embedFallbackProviderConfig: embedFallback?.config,
    embedFallbackModel: embedFallback?.embed,
    missingModelStrategy: 'fallback',
  })
}

// ==================== 概览型提问（不只靠 RAG 片段） ====================
/**
 * 识别「总览性」提问：问全库的主题/结构/覆盖范围这类问题，向量 top-K 只能拿到零散几片，
 * 容易答不全。这类问题改用「文件级摘要 + 每文件代表切片 + 本体实体清单」作为上下文。
 */
const OVERVIEW_RE = /(概览|概述|总结|综述|整体|总体|总体介绍|主要(讲|说|内容|观点)|大?框架|知识体系|结构|脉络|大纲|目录|讲了什么|包含哪些|有哪些(主题|概念|知识点|内容)|主题有哪些|都讲|全书|整体上|overview|summar|outline|main (points|topics|ideas)|what.*(cover|about)|list (all|the) )/i
function isOverviewQuestion(q: string): boolean {
  return OVERVIEW_RE.test(q)
}

/** 概览上下文：文件摘要（或每文件首条切片） + 本体实体清单；单条截断，总量可控 */
function buildOverviewContext(): { refs: SolverRef[]; detail: string; source: string } {
  const refs: SolverRef[] = []
  const MAX_FILES = 40
  const PER_FILE = 400
  const summaries = props.fileSummaries || []
  for (const s of summaries) {
    if (refs.length >= MAX_FILES) break
    const text = String(s.content || '').trim()
    if (!text) continue
    refs.push({ label: `${s.label}（文件摘要）`, content: text.slice(0, PER_FILE), similarity: 0 })
  }
  let source = refs.length ? '文件摘要' : ''
  if (!refs.length) {
    // 没有文件摘要（精简模式 / 未跑摘要）：退化为「每文件首条切片」作代表
    const seen = new Set<string>()
    for (const b of (props.blocks || [])) {
      if (refs.length >= MAX_FILES) break
      const key = b.filePath || b.path || b.label || ''
      const text = String(b.A || '').trim()
      if (!key || !text || seen.has(key)) continue
      seen.add(key)
      refs.push({ label: `${b.label || key}（首条切片）`, content: text.slice(0, PER_FILE), similarity: 0 })
    }
    if (refs.length) source = '代表切片'
  }
  // 本体实体清单（补充“讲了哪些概念”）：只取名字，截断数量
  const nCtx = refs.length   // 上下文条数（不含实体清单这条补充项）
  const names = (props.entities || [])
    .map((e: any) => String(e?.name || e?.label || e?.entityName || ''))
    .filter(Boolean)
    .slice(0, 60)
  if (names.length) {
    refs.push({ label: '本体实体清单', content: names.join('、'), similarity: 0 })
  }
  const detail = nCtx
    ? tr(`${source || '全库'} ${nCtx} 条`, `${source || 'KB'} ${nCtx} items`)
    : tr('无摘要可用', 'no summary')
  return { refs, detail, source }
}

/** 把检索异常翻译成「原因 + 怎么办」；最常见的是当前来源没有可用的嵌入模型 */
function explainRetrievalError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const looksEmbed = /no models loaded|embedding|embed|嵌入|not found|404|400/i.test(raw)
  if (looksEmbed) {
    return tr(
      `向量检索不可用：${raw}。检索需要嵌入模型，请在 设置 → 模型 → 嵌入 把「嵌入兜底」设为本地 Ollama（或为当前来源加载一个嵌入模型）；本次已改用本地关键词匹配。`,
      `Vector retrieval unavailable: ${raw}. Retrieval needs an embedding model — set Embedding fallback to local Ollama in Settings → Models, or load one for the current provider. Falling back to local keyword matching.`
    )
  }
  return tr(
    `向量检索失败：${raw}。本次已改用本地关键词匹配。`,
    `Retrieval failed: ${raw}. Falling back to local keyword matching.`
  )
}

// ==================== 执行步骤 ====================
function setStep(turn: SolverTurn, key: string, status: SolverStep['status'], detail?: string) {
  const s = turn.steps.find(x => x.key === key)
  if (!s) return
  s.status = status
  if (detail !== undefined) s.detail = detail
  scrollToBottom()
}
/** 把仍在进行/等待的步骤标为失败（异常中断时） */
function abortSteps(turn: SolverTurn) {
  for (const s of turn.steps) if (s.status === 'running' || s.status === 'pending') s.status = 'error'
}
function stepIcon(s: SolverStep): string {
  if (s.status === 'running') return 'fa-spinner fa-spin'
  if (s.status === 'done') return 'fa-check-circle'
  if (s.status === 'error') return 'fa-times-circle'
  return 'fa-circle-o'
}
function stepText(s: SolverStep): string {
  return zh() ? s.zh : s.en
}
/** 执行步骤汇总（折叠时的一行：范围 + 命中数 + 耗时） */
function stepSummary(t: SolverTurn): string {
  const parts: string[] = []
  if (t.sessionId) {
    // agent 模式：汇总各步工具结果（如“1 条切片”）
    const details = t.steps.map(s => s.detail).filter(d => !!d && d !== tr('进行中', 'running'))
    if (details.length) parts.push(details.join(' · '))
  } else {
    const g = t.steps.find(s => s.key === 'gather')
    if (g?.detail) parts.push(g.detail)
    if (t.scope === 'overview') parts.push(tr('概览模式', 'overview'))
    else if (t.scope === 'keyword') parts.push(tr('关键词兜底', 'keyword'))
  }
  if (t.elapsed != null) parts.push(`${(t.elapsed / 1000).toFixed(1)}s`)
  return parts.join(' · ')
}

// ==================== agent 模式：工具步骤与引用投影 ====================
/** agent 循环可用工具（学习答疑只读：不给写文件/命令） */
const SOLVER_AGENT_TOOLS = ['kb_search', 'search_files', 'read_file', 'list_dir']
const TOOL_LABELS: Record<string, { zh: string; en: string }> = {
  kb_search: { zh: '检索知识库', en: 'kb_search' },
  search_files: { zh: '查找文件', en: 'search_files' },
  read_file: { zh: '读取文件', en: 'read_file' },
  list_dir: { zh: '列出目录', en: 'list_dir' },
  run_python: { zh: '执行代码', en: 'run_python' },
  web_search: { zh: '联网搜索', en: 'web_search' },
  web_fetch: { zh: '抓取网页', en: 'web_fetch' },
  update_plan: { zh: '更新计划', en: 'update_plan' },
}
function toolLabel(name: string) { return TOOL_LABELS[name] || { zh: name, en: name } }
/** 工具结果摘要（步骤行右侧小字） */
function toolDetail(tc: ToolCallView): string {
  if (tc.status === 'error') return String(tc.error || 'failed').slice(0, 80)
  if (tc.status === 'running') return tr('进行中', 'running')
  const r: any = tc.result
  if (tc.name === 'kb_search') {
    const n = Array.isArray(r?.blocks) ? r.blocks.length : (Array.isArray(r?.results) ? r.results.length : null)
    if (n) return `${n} ${tr('条切片', 'slices')}`
    // 0 条：把失败原因带出来，避免只显示「0 条切片」看不出原因
    const reason = String(r?.context || '').match(/检索失败：([^\n（]{0,60})/)
    return reason ? tr('检索失败', 'retrieval failed') + `：${reason[1]}` : tr('0 条', '0 hits')
  }
  if (tc.name === 'search_files') return Array.isArray(r?.results) ? `${r.results.length} ${tr('条', 'hits')}` : ''
  if (tc.name === 'read_file') return String(r?.path || '').split(/[\\/]/).pop() || ''
  return ''
}
/** agent 会话视图 → 执行步骤（每个 step 一行：调用了哪些工具 / 生成回答） */
function projectAgentSteps(view: AgentSessionView): SolverStep[] {
  const out: SolverStep[] = []
  const steps = view.steps || []
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i]
    const tools = st.toolCalls || []
    const done = !!st.endTime
    const zhNames = tools.length ? tools.map(tc => toolLabel(tc.name).zh).join('、') : (done ? '生成回答' : '思考中')
    const enNames = tools.length ? tools.map(tc => toolLabel(tc.name).en).join(', ') : (done ? 'Generate answer' : 'Thinking')
    out.push({
      key: 'st' + (i + 1),
      zh: `第 ${i + 1} 步 · ${zhNames}`,
      en: `Step ${i + 1} · ${enNames}`,
      status: tools.some(tc => tc.status === 'error') ? 'error' : (done ? 'done' : 'running'),
      detail: tools.map(tc => toolDetail(tc)).filter(Boolean).join(' · '),
    })
  }
  if (!out.length) out.push({ key: 'st0', zh: '思考中…', en: 'Thinking…', status: 'running' })
  return out
}
/** 从工具结果收集引用来源（kb_search 的 blocks / search_files 的 results），按 label+片段去重 */
function collectRefsFromView(view: AgentSessionView): SolverRef[] {
  const refs: SolverRef[] = []
  const seen = new Set<string>()
  const push = (label: string, content: string, similarity: number) => {
    if (!label && !content) return
    const key = label + '|' + content.slice(0, 40)
    if (seen.has(key)) return
    seen.add(key)
    refs.push({ label, content, similarity })
  }
  for (const st of view.steps || []) {
    for (const tc of st.toolCalls || []) {
      const r: any = tc.result
      if (tc.name === 'kb_search' && Array.isArray(r?.blocks)) {
        for (const b of r.blocks) push(String(b?.label || ''), String(b?.content || ''), Number(b?.similarity || 0))
      } else if (tc.name === 'search_files' && Array.isArray(r?.results)) {
        for (const x of r.results) push(String(x?.path || x?.label || ''), String(x?.text || ''), Number(x?.score || 0))
      }
    }
  }
  return refs.slice(0, 12)
}
/** agent 会话视图 → 当前轮（按 sessionId 匹配；结束态落定内容与引用） */
function onAgentView(v: AgentSessionView) {
  const turn = turns.value.find(t => !!t.sessionId && t.sessionId === v.id)
  if (!turn) return
  turn.steps = projectAgentSteps(v)
  const running = v.status === 'running' || v.status === 'stopping'
  turn.streaming = running
  if (running) {
    turn.sawRunning = true
    const cur = (v.steps || [])[(v.steps || []).length - 1]
    // 节流：Markdown/mermaid 重渲染代价不低，约 160ms 更新一次（与主页流式渲染观感一致）
    const next = String(cur?.stream || v.currentStream || turn.a || '')
    const now = Date.now()
    if (next !== turn.a && now - (turn.lastPaint || 0) > 160) {
      turn.lastPaint = now
      turn.a = next
    }
    scrollToBottom()
    return
  }
  // 未见过 running 且无错误 → 创建期的初始 idle（占位视图），不当作完成
  if (!turn.sawRunning && !v.lastError) return
  turn.a = String(v.lastAssistantContent || v.currentStream || turn.a || '').trim() || tr('（无返回内容）', '(empty response)')
  turn.refs = collectRefsFromView(v)
  turn.streaming = false
  turn.showSteps = false
  turn.elapsed = Date.now() - turn.at
  if (v.lastError) turn.error = v.lastError
  asking.value = false
  scrollToBottom()
}
/** 组装 agent 循环所需来源配置（与主页智能体模式同一套解析） */
function buildAgentProvider() {
  const llm = props.store.AIconfig?.llm || {}
  const provider = normalizeLlmType((llm?.type as string) || 'ollama')
  const config: any = { ...(resolveLlmSource(llm, provider).config || {}) }
  const model = props.model?.chat || props.model?.process || config.model || ''
  if (model) config.model = model
  const llmConfig: any = { ...llm, type: provider, stream: true, ...(model ? { model } : {}) }
  return { provider, config, llmConfig }
}
/** 传给 agent 的检索参数：与本地 retrieve() 同源（当前来源 + 嵌入兜底 + 相似度策略） */
function buildRetrievalOptions() {
  const llmCfg = props.store.AIconfig?.llm
  const llmType = normalizeLlmType((llmCfg?.type as string) || 'ollama')
  const providerCfg = resolveLlmSource(llmCfg, llmType).config
  const embedFallback = kbAi.buildEmbedFallbackFromStore(props.store)
  return {
    llmType,
    providerConfig: providerCfg || undefined,
    embedModel: props.model?.embed || undefined,
    chatModel: props.model?.chat || undefined,
    processModel: props.model?.process || undefined,
    strategy: resolveStrategyId(undefined),
    embedFallbackType: embedFallback?.llmType,
    embedFallbackProviderConfig: embedFallback?.config,
    embedFallbackModel: embedFallback?.embed,
  }
}
/** agent 模式：创建会话 → 订阅视图 → 下发问题 */
async function runAgent(turn: SolverTurn, q: string) {
  const { provider, config, llmConfig } = buildAgentProvider()
  const view = await agentBridge.create({
    systemPrompt: solverAgentPrompt(zh(), {
      kbName: kbName.value,
      kbPath: props.kbPath,
      workspace: props.store.root || '',
      overview: isOverviewQuestion(q),
    }),
    provider,
    config,
    llmConfig,
    tools: SOLVER_AGENT_TOOLS,
    cwd: props.store.root || undefined,
    kbPaths: [props.kbPath],
    kbTopK: 8,
    // 检索参数：否则主进程 kb_search 默认走 ollama，LM Studio 等来源下会检索为空
    retrieval: buildRetrievalOptions(),
    sandboxMode: 'safe',
    // 循环轮数跟随全局「设置 → 智能体预设 → 通用智能体 → 循环轮数」（不再写死小数值）
    maxSteps: normalizeAgentMaxSteps(props.store.generalAgentMaxSteps),
    label: '学习答疑',
  })
  turn.sessionId = view.id
  onAgentView(view)          // 创建期间可能已有事件到达，先同步一次
  await agentBridge.send(view.id, q)
}

async function ask() {
  const q = question.value.trim()
  if (!q || asking.value) return
  if (!props.kbPath) {
    turns.value.push({ q, a: '', refs: [], steps: [], error: tr('请先在上方选择知识库', 'Pick a knowledge base first'), at: Date.now() })
    return
  }
  if (!props.model?.chat && !props.model?.process) {
    turns.value.push({
      q, a: '', refs: [], steps: [],
      error: tr('未配置可用的对话模型（请到 设置 → 模型 配置）', 'No chat model configured (Settings → Models)'),
      at: Date.now(),
    })
    return
  }
  asking.value = true
  question.value = ''
  const started = Date.now()
  const turn: SolverTurn = { q, a: '', refs: [], at: started, streaming: false, showSteps: true, steps: [] }
  turns.value.push(turn)
  scrollToBottom()

  // 优先：agent 循环（与主页智能体模式同一运行时 —— 工具自主检索、流式输出、工具步骤可见）
  if (agentBridge.available) {
    turn.steps = [{ key: 'init', zh: '启动智能体…', en: 'Starting agent…', status: 'running' }]
    turn.streaming = true
    try {
      await runAgent(turn, q)
    } catch (e) {
      turn.error = (e instanceof Error ? e.message : String(e)) || tr('智能体启动失败', 'Agent failed to start')
      abortSteps(turn)
      turn.streaming = false
      asking.value = false
    }
    return
  }

  // 回退：无 agent 运行时（如纯网页端）走本地检索 + 对话管线
  await runLocal(turn, q, started)
}

/** 本地回退路径：概览型问题用文件摘要，具体问题走向量检索（失败则关键词兜底），再交给对话模型 */
async function runLocal(turn: SolverTurn, q: string, started: number) {
  turn.steps = [
    { key: 'classify', zh: '识别问题类型', en: 'Classify question', status: 'running' },
    { key: 'gather', zh: '收集上下文', en: 'Gather context', status: 'pending' },
    { key: 'answer', zh: '生成回答', en: 'Generate answer', status: 'pending' },
  ]
  try {
    // ① 概览型还是具体型
    const overview = isOverviewQuestion(q)
    setStep(turn, 'classify', 'done', overview ? tr('概览型', 'overview') : tr('具体型', 'specific'))

    // ② 收集上下文：概览型用文件摘要（不只靠 RAG 片段）；具体型走向量检索，失败/无果再关键词兜底
    setStep(turn, 'gather', 'running')
    let refs: SolverRef[] = []
    let warn = ''
    if (overview) {
      const ctx = buildOverviewContext()
      refs = ctx.refs
      turn.scope = 'overview'
      setStep(turn, 'gather', 'done', ctx.detail)
    } else {
      try {
        const found = await retrieve(q)
        refs = (found.relevantBlocks || []).map(b => ({
          label: b.label, content: b.content, similarity: b.similarity,
        }))
        if (refs.length) setStep(turn, 'gather', 'done', tr(`向量检索 ${refs.length} 条`, `vector ${refs.length} hits`))
      } catch (e) {
        warn = explainRetrievalError(e)
      }
      if (!refs.length) {
        const hits = keywordSearchBlocks(
          q,
          (props.blocks || []).map((b: any) => ({ label: b.label, content: String(b.A || '') })),
          5
        )
        if (hits.length) {
          refs = hits
          turn.scope = 'keyword'
          if (!warn) warn = tr('本次引用由本地关键词匹配得到（未使用向量检索）。', 'Citations come from local keyword matching (no vector retrieval).')
          setStep(turn, 'gather', 'done', tr(`关键词兜底 ${refs.length} 条`, `keyword ${refs.length} hits`))
        }
      }
    }
    turn.refs = refs
    turn.warn = warn || undefined
    if (!refs.length) {
      setStep(turn, 'gather', 'error', tr('无可用切片', 'no slices'))
      setStep(turn, 'answer', 'error', tr('已跳过', 'skipped'))
      turn.a = tr(
        '没有找到与该问题相关的切片，无法作答。可以换个问法，或先到「知识处理」补充这部分内容。',
        'No relevant slices found. Try rephrasing, or add the content in Knowledge Processing.'
      )
      return
    }

    // ③ 生成回答（流式：先纯文本追写，结束后再渲染 Markdown/mermaid）
    setStep(turn, 'answer', 'running')
    turn.streaming = true
    const contextText = refs.map((r, i) => `[${i + 1}] ${r.label}\n${r.content}`).join('\n\n')
    const prompt = solverPrompt(zh(), q, contextText)
    const spec = kbAi.buildSpecFromModel(props.model, props.store)
    let acc = ''
    let lastPaint = 0
    const out = await kbAi.streamChat(spec, [{ role: 'user', content: prompt }], (chunk: string) => {
      acc += chunk
      const now = Date.now()
      if (now - lastPaint > 60) { lastPaint = now; turn.a = acc; scrollToBottom() }
    })
    turn.a = String(out || acc || '').trim() || tr('（无返回内容）', '(empty response)')
    const secs = (Date.now() - started) / 1000
    setStep(turn, 'answer', 'done', `${turn.a.length} ${tr('字', 'chars')} · ${secs.toFixed(1)}s`)
    turn.elapsed = Date.now() - started
    turn.showSteps = false   // 完成后折叠为一行汇总（可点开）
  } catch (e) {
    turn.error = (e instanceof Error ? e.message : String(e))
    abortSteps(turn)
  } finally {
    turn.streaming = false
    asking.value = false
    scrollToBottom()
  }
}

/** 引用切片的悬停 title：[序号] 标签 · 相似度 + 切片原文（过长截断） */
function refTitle(r: SolverRef, i: number): string {
  const score = r.similarity > 0 ? ` · ${Math.round(r.similarity * 100)}%` : ''
  const text = String(r.content || '')
  const body = text.length > 600 ? text.slice(0, 600) + '…' : text
  return `[${i + 1}] ${r.label || ''}${score}\n${body}`
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    ask()
  }
}
function clearAll() { turns.value = [] }
</script>

<template>
  <div class="sv-root">
    <!-- 会话区（空态居中引导；有消息时按气泡排布） -->
    <div ref="bodyEl" class="sv-messages scoll">
      <div v-if="!turns.length" class="sv-welcome">
        <div class="sv-welcome-ico"><i class="fa fa-graduation-cap"></i></div>
        <div class="sv-welcome-title">{{ tr('有问题就问，答案都带切片出处', 'Ask anything — every answer cites its slices') }}</div>
        <div class="sv-welcome-sub">
          {{ tr(
            '只依据「' + (kbName || '当前知识库') + '」的 ' + sliceCount + ' 条切片作答，句末标注 [n] 引用，可展开原文核对',
            'Answers use only the ' + sliceCount + ' slices of "' + (kbName || 'this KB') + '", citing them as [n] so you can verify against the source'
          ) }}
          <br />
          {{ tr('问「整体讲了什么」这类总览性问题时会自动改用文件摘要 + 代表切片，不只依赖片段检索。', 'Overview questions (e.g. "what does it cover") automatically use file summaries + representative slices, not just snippet retrieval.') }}
        </div>
        <div class="sv-cards">
          <div v-for="(ex, i) in examples" :key="i" class="sv-card" @click="fillExample(ex)"
            :title="tr('点击填入输入框（可编辑后发送）', 'Click to fill the input box (editable before sending)')">
            <i class="fa" :class="ex.icon"></i>
            <div class="sv-card-main">
              <div class="sv-card-t">{{ ex.t }}</div>
              <div class="sv-card-d">{{ ex.d }}</div>
            </div>
          </div>
        </div>
      </div>

      <div v-for="(t, ti) in turns" :key="ti" class="sv-pair">
        <!-- 提问（右） -->
        <div class="sv-msg sv-user">{{ t.q }}</div>
        <!-- 回答（左） -->
        <div class="sv-msg sv-ai">
          <div class="sv-ai-head">
            <i class="fa fa-graduation-cap"></i>
            <span>{{ tr('知识库答疑', 'KB tutor') }}</span>
            <span v-if="t.scope === 'overview'" class="sv-badge sv-badge-scope"
              :title="tr('总览性问题：上下文用文件摘要 + 每文件代表切片 + 本体实体清单（不只是向量片段）', 'Overview question: context uses file summaries + representative slices + ontology entities (not just vector snippets)')">
              {{ tr('概览模式', 'overview') }}
            </span>
            <span v-if="t.scope === 'keyword'" class="sv-badge"
              :title="tr('向量检索不可用，本次引用由本地关键词匹配得到', 'Vector retrieval unavailable; citations come from local keyword matching')">
              {{ tr('关键词兑底', 'keyword fallback') }}
            </span>
          </div>

          <!-- 执行步骤（进行中展开；完成后折叠为一行可点开） -->
          <div v-if="t.steps && t.steps.length" class="sv-steps-wrap">
            <div class="sv-stepbar" @click="t.showSteps = !t.showSteps">
              <i class="fa" :class="t.showSteps ? 'fa-caret-down' : 'fa-caret-right'"></i>
              <span v-if="t.showSteps">{{ tr('执行步骤', 'Steps') }}</span>
              <span v-else>{{ tr('执行步骤', 'Steps') }} · {{ stepSummary(t) }}</span>
            </div>
            <div v-if="t.showSteps" class="sv-steps">
              <div v-for="s in t.steps" :key="s.key" class="sv-step" :class="s.status">
                <i class="fa" :class="stepIcon(s)"></i>
                <span class="sv-step-t">{{ stepText(s) }}</span>
                <span v-if="s.detail" class="sv-step-d">{{ s.detail }}</span>
              </div>
            </div>
          </div>

          <div v-if="t.error" class="sv-ai-err"><i class="fa fa-exclamation-triangle"></i> {{ t.error }}</div>
          <div v-else-if="!t.a && !t.streaming" class="sv-ai-loading"><i class="fa fa-spinner fa-spin"></i> {{ tr('正在检索切片并作答…', 'Retrieving slices and answering…') }}</div>
          <template v-else>
            <div v-if="t.warn" class="sv-ai-warn"><i class="fa fa-info-circle"></i> {{ t.warn }}</div>
            <!-- 流式期间同样渲染 Markdown（与主页一致）；更新由投影侧节流，避免每个 chunk 重渲染 -->
            <div class="sv-ai-body">
              <block_md v-if="t.a" :content="t.a" :fontSize="'13px'" />
              <span v-if="t.streaming" class="sv-caret"></span>
            </div>
            <!-- 引用切片：单行图标，具体内容看悬停 title -->
            <div v-if="t.refs.length" class="sv-src">
              <i class="fa fa-book sv-src-cap"></i>
              <span class="sv-src-cap">{{ tr('引用切片', 'Cited slices') }} {{ t.refs.length }}</span>
              <i
                v-for="(r, ri) in t.refs"
                :key="ri"
                class="fa fa-file-text-o sv-src-ico"
                :title="refTitle(r, ri)"
              ></i>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- 输入卡片（视觉与主页输入卡片一致：圆角卡片 + 聚焦高亮 + 底部操作行） -->
    <div class="sv-input-area">
      <div class="sv-input-card">
        <textarea v-model="question" ref="inputEl" class="sv-textarea scoll" rows="2" spellcheck="false"
          :placeholder="tr('就当前知识库提问…（Enter 发送，Shift+Enter 换行）', 'Ask about this KB… (Enter to send, Shift+Enter for newline)')"
          @keydown="onKeydown"></textarea>
        <div class="sv-controls">
          <span class="sv-kb-chip" :title="tr('回答只使用该知识库的切片', 'Answers use only this KB')">
            <i class="fa fa-book"></i> {{ kbName || tr('未选择知识库', 'No KB') }}
          </span>
          <span class="sv-tip">{{ tr('答案仅依据切片，标注 [n] 引用', 'Answers cite slices as [n]') }}</span>
          <span style="flex:1;"></span>
          <button v-if="turns.length" class="sv-icon-btn" @click="clearAll" :title="tr('清空本次答疑', 'Clear session')">
            <i class="fa fa-eraser"></i>
          </button>
          <button class="sv-send" :disabled="asking || !question.trim()" @click="ask">
            <i class="fa" :class="asking ? 'fa-spinner fa-spin' : 'fa-paper-plane'"></i>{{ tr('提问', 'Ask') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 答疑页：对齐主页聊天区的视觉语言（圆角卡片 / 底部输入卡片 / 左右气泡），
   但把重心放在「学习」：引导卡片 → 带引用的讲解 → 可核对的切片出处。 */
.sv-root { display: flex; flex-direction: column; height: 100%; min-height: 0; box-sizing: border-box; overflow: hidden; }

/* ===== 会话区 ===== */
.sv-messages { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column; gap: 6px; padding: 6px 6px 8px; }

/* 空态引导（与主页空聊天一致：居中、标题 + 副标题 + 引导项） */
.sv-welcome { margin: auto; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px; padding: 12px 10px 20px; animation: sv-fade .3s ease; }
.sv-welcome-ico { width: 40px; height: 40px; border-radius: 12px; display: flex; align-items: center; justify-content: center; background: var(--menuActiveColor, #eee); color: var(--fontActiveColor, #0969da); font-size: 19px; margin-bottom: 2px; }
.sv-welcome-title { font-size: 17px; font-weight: 600; color: var(--fontColor, #1f2328); }
.sv-welcome-sub { font-size: 11px; line-height: 1.7; opacity: .6; color: var(--fontColor, #1f2328); max-width: 560px; }
.sv-cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; width: min(620px, 100%); margin-top: 8px; }
.sv-card { display: flex; align-items: flex-start; gap: 8px; text-align: left; padding: 8px 10px; cursor: pointer; border: 1px solid var(--borderColor, #d0d7de); border-radius: 8px; background: var(--backgroundColor, #fff); transition: border-color .15s ease, transform .15s ease; }
.sv-card:hover { border-color: var(--fontActiveColor, #0969da); transform: translateY(-1px); }
.sv-card > i { color: var(--fontActiveColor, #0969da); font-size: 13px; padding-top: 2px; }
.sv-card-main { min-width: 0; }
.sv-card-t { font-size: 12px; font-weight: 600; color: var(--fontColor, #1f2328); }
.sv-card-d { font-size: 11px; line-height: 1.5; opacity: .65; color: var(--fontColor, #1f2328); margin-top: 1px; }

/* 一问一答 */
.sv-pair { display: flex; flex-direction: column; gap: 6px; }
@keyframes sv-fade { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
.sv-msg { border-radius: 8px; padding: 6px 9px; animation: sv-fade .2s ease; }
.sv-user { margin-left: auto; max-width: 85%; min-width: 60px; border: 1px solid var(--borderColor, #d0d7de); background: var(--menuColor, #f6f6f6); font-size: 13px; line-height: 1.6; color: var(--fontColor, #1f2328); white-space: pre-wrap; word-break: break-word; }
/* 注意：宽度必须用 border-box —— width:100% + 内边距 + 边框在 content-box 下会比容器宽 22px（撑出横向滚动） */
.sv-ai { margin-right: auto; width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box; border: 1px solid var(--borderColor, #d0d7de); background: var(--backgroundColor, #fff); }
.sv-ai-head { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--fontColor, #1f2328); opacity: .75; margin-bottom: 2px; }
.sv-ai-head > i { color: var(--fontActiveColor, #0969da); }
.sv-badge { font-size: 10px; padding: 0 6px; border-radius: 8px; border: 1px solid #FF9800; color: #FF9800; opacity: 1; }
.sv-badge-scope { border-color: var(--fontActiveColor, #0969da); color: var(--fontActiveColor, #0969da); }
.sv-ai-body { font-size: 13px; line-height: 1.7; color: var(--fontColor, #1f2328); min-width: 0; overflow-wrap: anywhere; }
/* 宽内容不自适应（长代码行 / 表格 / 图）→ 在内部滚动，不撑宽整个卡片（对齐 home 消息区规则） */
.sv-ai-body :deep(pre) { max-width: 100%; overflow-x: auto; }
.sv-ai-body :deep(table) { display: block; width: max-content; max-width: 100%; overflow-x: auto; }
.sv-ai-body :deep(img), .sv-ai-body :deep(svg) { max-width: 100%; height: auto; }
.sv-ai-body :deep(.mermaid-wrapper) { max-width: 100%; overflow: hidden; }
.sv-ai-body :deep(.mermaid-rendered-svg), .sv-ai-body :deep(.mermaid) { max-width: 100%; overflow-x: auto; }
/* 紧凑排版：block_md 没重设段落/标题的外边距（浏览器默认 p 1em、h2 0.83em）→ 卡片看起来很空 */
.sv-ai-body :deep(p) { margin: 4px 0; }
.sv-ai-body :deep(h1), .sv-ai-body :deep(h2), .sv-ai-body :deep(h3), .sv-ai-body :deep(h4) { margin: 6px 0 2px; line-height: 1.45; }
.sv-ai-body :deep(h1) { font-size: 15px; }
.sv-ai-body :deep(h2) { font-size: 14px; }
.sv-ai-body :deep(h3), .sv-ai-body :deep(h4) { font-size: 13px; }
.sv-ai-body :deep(blockquote) { margin: 4px 0; padding: 2px 8px; }
.sv-ai-body :deep(hr) { margin: 6px 0; }
/* 首尾元素去掉外边距，避免卡片上下多出一条空白 */
.sv-ai-body :deep(.md) > :first-child { margin-top: 0; }
.sv-ai-body :deep(.md) > :last-child { margin-bottom: 0; }
/* 流式输出：正文与结束态同样用 block_md 渲染 Markdown，仅末尾多一个光标 */
.sv-caret { display: inline-block; width: 1px; height: 1em; vertical-align: -0.15em; background: var(--fontActiveColor, #0969da); animation: sv-blink 1s steps(1) infinite; margin-left: 1px; }
@keyframes sv-blink { 50% { opacity: 0; } }

/* ===== 执行步骤 ===== */
.sv-steps-wrap { margin: 1px 0 3px; }
.sv-stepbar { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--fontColor, #1f2328); opacity: .65; cursor: pointer; user-select: none; }
.sv-stepbar:hover { opacity: 1; color: var(--fontActiveColor, #0969da); }
.sv-steps { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; padding-left: 2px; border-left: 2px solid var(--borderColor, #d0d7de); }
.sv-step { display: flex; align-items: baseline; gap: 6px; font-size: 11px; line-height: 1.6; padding-left: 6px; color: var(--fontColor, #1f2328); }
.sv-step > i { font-size: 10px; opacity: .55; }
.sv-step.done > i { color: #4CAF50; opacity: 1; }
.sv-step.running > i { color: var(--fontActiveColor, #0969da); opacity: 1; }
.sv-step.error > i { color: #d93025; opacity: 1; }
.sv-step-t { font-weight: 500; }
.sv-step-d { opacity: .6; }
.sv-ai-err { font-size: 12px; line-height: 1.6; color: #d93025; }
.sv-ai-warn { font-size: 11px; line-height: 1.6; color: #FF9800; background: rgba(255, 152, 0, .08); border-left: 2px solid #FF9800; border-radius: 4px; padding: 4px 8px; margin-bottom: 6px; }
.sv-ai-loading { font-size: 12px; color: var(--borderColor, #888); }

/* 引用切片（对位主页「参考知识片段」区块） */
/* 引用切片：单行图标，具体内容看悬停 title */
.sv-src { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin-top: 4px; border-top: 1px solid var(--borderColor, #d0d7de); padding-top: 4px; }
.sv-src-cap { font-size: 11px; color: var(--fontColor, #1f2328); opacity: .6; }
.sv-src-ico { font-size: 11px; color: var(--fontActiveColor, #0969da); opacity: .8; cursor: help; padding: 0 1px; }
.sv-src-ico:hover { opacity: 1; }

/* ===== 输入卡片（与主页 .input-container 同款） ===== */
.sv-input-area { flex-shrink: 0; padding: 0 6px 6px; }
.sv-input-card { box-sizing: border-box; width: 100%; padding: 8px 10px 6px; border: 1px solid var(--borderColor, #d0d7de); border-radius: 10px; background: var(--backgroundColor, #fff); box-shadow: 0 10px 30px rgba(0, 0, 0, .07); transition: border-color .2s ease, box-shadow .2s ease; }
.sv-input-card:focus-within { border-color: var(--menuActiveColor, #e5e5e5); box-shadow: 0 12px 34px rgba(0, 0, 0, .12); }
.sv-textarea { width: 100%; box-sizing: border-box; resize: none; border: none; outline: none; background: transparent; color: var(--fontColor, #1f2328); font-family: inherit; font-size: 13px; line-height: 1.6; max-height: calc(30vh / var(--ui-zoom, 1)); }
.sv-controls { display: flex; align-items: center; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
.sv-kb-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; padding: 1px 8px; border-radius: 10px; border: 1px solid var(--borderColor, #d0d7de); color: var(--fontColor, #1f2328); max-width: 40%; }
.sv-kb-chip > i { color: var(--fontActiveColor, #0969da); }
.sv-tip { font-size: 10px; opacity: .5; color: var(--fontColor, #1f2328); }
.sv-icon-btn { cursor: pointer; width: 26px; height: 26px; border-radius: 6px; border: none; background: transparent; color: var(--fontColor, #1f2328); opacity: .7; }
.sv-icon-btn:hover { background: var(--menuActiveColor, #e5e5e5); opacity: 1; }
.sv-send { cursor: pointer; display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--fontActiveColor, #0969da); color: var(--fontActiveColor, #0969da); background: var(--backgroundColor, #fff); border-radius: 6px; font-size: 12px; padding: 4px 14px; white-space: nowrap; }
.sv-send:hover { background: var(--menuActiveColor, #e5e5e5); }
.sv-send:disabled { opacity: .5; cursor: default; }
</style>
