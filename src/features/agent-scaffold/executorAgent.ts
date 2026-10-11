/**
 * executorAgent.ts — 智能体执行器（Step 2 无损搬迁）
 *
 * 从 pipelineRunner.ts 原样搬出「智能体执行器」的静态部分：
 *   - 从 store.AIconfig 组装 LLM provider（对齐 useAgentRun.buildAgentProviderConfig）
 *   - 解析生效 LLM 后端（跟随全局 / 跟随预设 / 显式）
 *   - 批量 MCP 服务选择与工具清单（整批只解析一次）
 *   - 组装 AgentOptions（system prompt 统一由 @/lib/agent/promptContext 组装）
 *
 * 类内的会话编排（agentBridge.create / send / 完成检测 / 日志）暂留 pipelineRunner.ts，
 * 后续提交将迁入本文件并实现 ../types.ts 的 PipelineExecutor 接口（run(unit, ctx)）。
 * 搬迁为「参照平移」：函数体逐字未改（含运行期 scope/label 的 'batch' / 'agent-batch'）。
 */

import type { AgentOptions } from '@/types/agent'
import { agentBridge } from '@/platform/agentBridge'
import { SKILL_AGENT_DEFAULT_TOOLS } from '@/lib/agent/skill'
import { assembleAgentSystemPrompt, ensureAgentSkills, workspaceRoot } from '@/lib/agent/promptContext'
import { getSkillManager } from '@/services/agentSkills'
import { toolsFromCapabilities } from '@/lib/agent/capabilities'
import { normalizeAgentMaxSteps, resolveAgentMaxSteps } from '@/shared/agent-loop-rounds'
import { resolveLlmSource, normalizeLlmType } from '@/shared/llmSources'
import { renderTemplate, buildStructuredOutputInstruction } from './render'
import { tryParseJson } from './parsers'
import type {
  BatchConfig, BatchCallbacks, BatchRuntimeContext, BatchRow, ExecutorContext,
  ExecutorDeps, ExecutorOutcome, PipelineExecutor, PipelineUnit,
} from './types'
export type { BatchRuntimeContext } from './types'

// ==================== 预设能力槽 → 工具白名单（统一数据源：src/lib/agent/capabilities.ts） ====================
function presetTools(caps: any): string[] {
  return toolsFromCapabilities(caps)
}

// ==================== 从 store.AIconfig 组装 provider（对齐 useAgentRun.buildAgentProviderConfig） ====================
function buildProvider(store: any, llmType?: string): { provider: string; config: any; llmConfig: any } {
  const llm = store?.AIconfig?.llm || {}
  // 单来源解析：DeepSeek 只有一个来源（deepseek），接口样式随 config.api_style 下发；
  // 历史别名 'deepseek-responses' 在此归一（见 @/shared/llmSources）
  const { type, config } = resolveLlmSource(llm, llmType || llm.type || 'ollama')
  return { provider: type, config, llmConfig: { ...llm, type, stream: true, temperature: llm.temperature, max_tokens: llm.max_tokens } }
}

// ==================== 已启用 MCP 服务（对齐 workflow agent node） ====================
function activeMcpServers(store: any): any[] {
  return (store?.mcpServers || []).filter((s: any) => s && s.enabled !== false && s.transport !== 'inmemory')
}

/**
 * 本批量实际启用/注入的 MCP 服务（供「整批一次」构建工具清单用）：
 * 预设 → 按预设能力；通用 → 全局已启用服务（仅当工具白名单含 mcp_call）。
 */
export function batchMcpServers(config: BatchConfig, store: any): any[] {
  const preset = config.presetId
    ? (store?.agentPresets || []).find((p: any) => p.id === config.presetId)
    : undefined
  if (preset) {
    const caps = preset.capabilities || {}
    if (!caps.mcpAccess) return []
    const ids: string[] = caps.mcpServerIds || (caps.mcpServerId ? [caps.mcpServerId] : [])
    return activeMcpServers(store).filter((s: any) => ids.includes(s.id))
  }
  const toolList: string[] = config.toolsOverride
    ? config.toolsOverride.split(',').map((t) => t.trim()).filter(Boolean)
    : ((store?.agentTools === null || store?.agentTools === undefined) ? [...SKILL_AGENT_DEFAULT_TOOLS] : [...store.agentTools])
  return toolList.includes('mcp_call') ? activeMcpServers(store) : []
}

/**
 * 解析最终生效的 LLM 后端类型（UI 与运行时共用，保证一致）：
 * - `''`        = 跟随全局设置（store.AIconfig.llm.type）
 * - `'agent'`   = 跟随智能体（预设）设置；预设未配置时回退全局
 * - 其它值      = 显式后端 id（兼容旧任务文件里保存的显式选择）
 */
export function effectiveLlmType(config: Pick<BatchConfig, 'llmType' | 'presetId'>, store: any): string {
  const explicit = String(config.llmType || '').trim()
  if (explicit === 'agent') {
    const preset = config.presetId
      ? (store?.agentPresets || []).find((p: any) => p.id === config.presetId)
      : undefined
    return normalizeLlmType(preset?.llmType || store?.AIconfig?.llm?.type || '')
  }
  if (explicit) return normalizeLlmType(explicit)
  return normalizeLlmType(store?.AIconfig?.llm?.type || '')
}

/** 批量模式剔除交互工具（批量无人在线回答） */
const BATCH_EXCLUDED_TOOLS = ['ask_user']

function excludeBatchTools(tools: string[]): string[] {
  return tools.filter((t) => !BATCH_EXCLUDED_TOOLS.includes(t))
}

// 注：批量曾额外在 system prompt 末尾追加一条「用任务语言作答」的硬性要求（BATCH_LANGUAGE_RULE），
// 已移除——批量与聊天/工作流/集群一律使用 assembleAgentSystemPrompt 的原样输出，不再有批量专属段落。

// ==================== AgentOptions 组装 ====================
// 注：BatchRuntimeContext 已移至 ../types（供 ExecutorContext.runtime 引用），本文件原样再导出以保持旧路径兼容。

// ==================== AgentOptions 组装（提示词统一由 @/lib/agent/promptContext 组装） ====================
export async function buildBatchAgentOptions(row: BatchRow, config: BatchConfig, store: any, runtime?: BatchRuntimeContext): Promise<AgentOptions> {
  const preset = config.presetId
    ? (store?.agentPresets || []).find((p: any) => p.id === config.presetId)
    : undefined
  const skillMgr = getSkillManager(store)
  // 技能库引导：与聊天/工作流/集群同一逻辑（按当前 store.skillsPath 加载，含主进程 skillService 根目录）。
  // 批量以前从不加载技能库 → 技能清单与预设勾选的技能都注入不进提示词，skill 工具还会报「技能不存在」。
  const enabledSkillObjs: any[] = await ensureAgentSkills(store)
  const sandboxMode: any = store?.pythonSandbox || (store?.TrustedPython ? 'trusted' : 'safe')
  const mcpServers = activeMcpServers(store)
  const base: any = {
    toolsPresentation: 'native',
    scope: 'batch',
    label: `batch:${row.id}`,
    // 循环轮数：批量级显式配置优先，未配置时用唯一数据源（预设分支再覆盖）
    maxSteps: normalizeAgentMaxSteps(config.maxSteps ?? store?.generalAgentMaxSteps),
    sandboxMode,
    disabledSkills: store?.disabledSkills || [],
    cwd: workspaceRoot(store) || undefined,
  }

  // ---- 自定义工具白名单（显式指定时优先级最高） ----
  const customTools = config.toolsOverride
    ? excludeBatchTools(config.toolsOverride.split(',').map((t) => t.trim()).filter(Boolean))
    : null

  // ---- 模型/后端解析：''=全局；'agent'=预设智能体（后端与模型都跟预设，预设未配置则回退全局）----
  const effLlmType = effectiveLlmType(config, store)
  // 模型：批量级显式填写优先；「跟随智能体设置」时使用预设自带模型
  const effModel = String(config.model || '').trim()
    || (String(config.llmType || '').trim() === 'agent' ? String(preset?.model || '').trim() : '')
  let provider = buildProvider(store, effLlmType || undefined)
  if (effModel) provider = { ...provider, config: { ...provider.config, model: effModel } }
  // 说明：DeepSeek Responses API 已移除服务端 web_search（官方兼容表：内置工具一律忽略），
  // 因此该后端不再走「纯联网调研」特例——与其它 OpenAI 兼容后端一样加载本地工具
  // （联网搜索由本地 web_search / web_fetch 工具 + Agent 能力插槽控制）

  // ---- 预设智能体：能力/模型/知识库/MCP 均来自预设 ----
  if (preset) {
    const caps = preset.capabilities || {}
    const tools = customTools !== null ? customTools : excludeBatchTools(presetTools(caps))
    const ids: string[] = caps.mcpServerIds || (caps.mcpServerId ? [caps.mcpServerId] : [])
    // system prompt 统一由共享组装函数生成（指令段模式 / 知识库 / 所选技能 / MCP 工具清单 / 工作区）
    const assembled = assembleAgentSystemPrompt({
      store,
      preset,
      tools,
      enabledSkills: enabledSkillObjs,
      resolveSkill: (key: string) => skillMgr.getSkills().find((s: any) => s.path === key) ?? skillMgr.getSkill(key),
      disabledSkills: store?.disabledSkills || [],
      mcpContext: caps.mcpAccess ? (runtime?.mcpContext || '') : '',
      model: effModel || undefined,
      provider: effLlmType || undefined,
    })
    return {
      ...base,
      cwd: assembled.cwd,
      systemPrompt: assembled.systemPrompt,
      tools: assembled.tools,
      ...provider,
      kbPaths: caps.knowledgeBaseFiles || [],
      kbTopK: typeof preset.kbTopK === 'number' ? preset.kbTopK : 5,
      mcpServerIds: caps.mcpAccess ? ids : undefined,
      mcpServerConfigs: caps.mcpAccess ? mcpServers.filter((s: any) => ids.includes(s.id)) : undefined,
      mcpEquipmentIds: caps.mcpEquipmentIds || undefined,
      // 循环轮数：预设自带轮数为唯一例外，未配置时回退批量级配置 / 全局唯一数据源
      maxSteps: resolveAgentMaxSteps(preset.maxSteps ?? config.maxSteps, store?.generalAgentMaxSteps),
    }
  }

  // ---- 通用智能体：自主规划 prompt + 全局工具白名单 ----
  const rawGlobalTools = (store?.agentTools === null || store?.agentTools === undefined)
    ? [...SKILL_AGENT_DEFAULT_TOOLS]
    : [...store.agentTools]
  const tools = customTools !== null ? customTools : excludeBatchTools(rawGlobalTools)
  const assembled = assembleAgentSystemPrompt({
    store,
    tools,
    enabledSkills: enabledSkillObjs,
    // 与聊天自主规划一致：仅当 mcp_call 在白名单内才注入 MCP 工具清单
    mcpContext: tools.includes('mcp_call') ? (runtime?.mcpContext || '') : '',
    model: effModel || undefined,
    provider: effLlmType || undefined,
  })
  return {
    ...base,
    cwd: assembled.cwd,
    systemPrompt: assembled.systemPrompt,
    tools: assembled.tools,
    ...provider,
    mcpServerIds: mcpServers.map((s: any) => s.id),
    mcpServerConfigs: mcpServers,
  }
}

// ==================== 智能体执行器（会话编排，Step 2 从 pipelineRunner 拆出） ====================
/**
 * 一单元 = 一个完整 agentBridge 会话：
 *   占位符渲染 → 构建 AgentOptions → 创建会话 → 发送 prompt → 等待结束（含推理/工具/搜索日志观察）→ 返回结果
 * 完成信号 / token 累计 / 活动日志均来自自身对 agentBridge 的订阅（subscribe/unsubscribe 由 runner 在批量前后调用）。
 * 行为与拆分前逐位一致：运行期 scope/label、完成判定（runningSeen 守卫）、ask_user 自动取消等均原样保留。
 */
export class AgentExecutor implements PipelineExecutor {
  readonly kind = 'agent' as const
  private config: BatchConfig
  private store: any
  private callbacks: BatchCallbacks
  /** 线程日志出口（runner 经构造注入：保持 worker.logs 写入与 onLog 回调行为一致） */
  private logFn: (level: string, message: string, workerId?: number, detail?: string) => void
  /** 是否已被请求停止（runner 经构造注入） */
  private stopRequested: () => boolean
  // 行完成信号（viewId → resolver）
  private completers = new Map<string, { resolve: (r: ExecutorOutcome) => void }>()
  // 已进入 running 状态的会话（防止 send() 的初始 idle 通知误判完成）
  private runningSeen = new Set<string>()
  private unsub: (() => void) | null = null
  // token 统计（累计）
  private totalInput = 0
  private totalOutput = 0
  // viewId → 最近已统计的 usage 对象（按对象身份去重，避免同一 step 重复累计）
  private prevUsage = new Map<string, any>()
  // viewId → 服务端联网搜索（DeepSeek Responses）事件已消费游标（按 view 增量消费，避免重复记录）
  private searchConsumed = new Map<string, number>()
  // 日志追踪：viewId → 每步已记录状态（推理已输出 / 已记录的工具调用）
  private stepLogState = new Map<string, Array<{ reasoningLogged: boolean; calls: Set<string>; endedCalls: Set<string> }>>()
  // viewId → 并发槽位（把工具/推理日志路由到对应线程）
  private viewSlot = new Map<string, number>()

  constructor(config: BatchConfig, store: any, callbacks: BatchCallbacks = {}, deps?: ExecutorDeps) {
    this.config = config
    this.store = store
    this.callbacks = callbacks
    // 依赖一次性注入（日志出口 / 停止判定）；缺省为无副作用的空实现
    const d = deps || { log: () => {}, isStopRequested: () => false }
    this.logFn = d.log
    this.stopRequested = d.isStopRequested
  }

  /** 开始新一轮批量时的 token 归零（对齐 runner.start 的原有行为） */
  resetTokens(): void {
    this.totalInput = 0
    this.totalOutput = 0
  }

  /** 取某会话所在的并发槽位（runner 打日志 / 重跑需要） */
  slotOf(viewId: string): number | undefined {
    return this.viewSlot.get(viewId)
  }

  // ==================== 事件订阅（完成检测 + token 累计 + 活动日志） ====================
  subscribe(): void {
    this.unsub = agentBridge.on((view: any) => {
      // token 累计（按 lastUsage 对象身份去重）
      const u = view?.lastUsage
      if (u) {
        const prev = this.prevUsage.get(view.id)
        if (prev !== u) {
          this.prevUsage.set(view.id, u)
          this.totalInput += u.promptTokens || 0
          this.totalOutput += u.completionTokens || 0
          this.callbacks.onTokenUsage?.(this.totalInput, this.totalOutput, this.totalInput + this.totalOutput)
        }
      }

      // 日志：推理增量 + 工具调用 + 服务端联网搜索状态（仅本批量运行中的行）
      if (this.completers.has(view.id)) {
        this.logAgentActivity(view)
        this.logSearchEvents(view)
      }

      // 进入运行态：记录并等待（send() 后的初始 idle 通知不可作为完成信号）
      if (view.status === 'running') {
        this.runningSeen.add(view.id)
        return
      }

      const c = this.completers.get(view.id)
      if (!c) return
      // 交互提问：批量模式无人在线，自动取消并判失败
      if (view.pendingQuestion) {
        agentBridge.cancel(view.id, 'user').catch(() => {})
        c.resolve({ ok: false, error: 'Agent 需要交互提问，批量模式已自动取消该任务' })
        this.completers.delete(view.id)
        return
      }
      if (view.status === 'idle') {
        // 未真正运行过（初始 idle / send 前置通知），忽略，等待真正结束
        if (!this.runningSeen.has(view.id)) return
        if (this.stopRequested()) {
          c.resolve({ ok: false, error: '已手动停止' })
        } else if (view.lastError) {
          c.resolve({ ok: false, error: view.lastError })
        } else {
          c.resolve({ ok: true, result: view.lastAssistantContent || '' })
        }
        this.completers.delete(view.id)
        this.runningSeen.delete(view.id)
      } else if (view.status === 'disposed') {
        c.resolve({ ok: false, error: view.lastError || 'Agent 会话已销毁' })
        this.completers.delete(view.id)
        this.runningSeen.delete(view.id)
      }
    })
  }

  unsubscribe(): void {
    if (this.unsub) {
      this.unsub()
      this.unsub = null
    }
  }

  // ==================== 执行 / 回收 ====================
  /** 执行一个单元：渲染占位符 → （结构化输出时附加 JSON 约束）→ 建会话 → 发送 → 等结束 */
  async run(unit: PipelineUnit, ctx: ExecutorContext): Promise<ExecutorOutcome> {
    let prompt = renderTemplate(this.config.template, { ...(unit.data || {}), ...(unit.roundRefs || {}) }, ctx.rowIndex, this.config.keepUnmatched)
    if (!prompt.trim()) {
      throw new Error('占位符替换后任务为空（请检查任务指令与列名）')
    }

    // 结构化输出（sink=dataRows）：要求智能体最后只输出 JSON，并在收尾时解析为数据行（按主键合并进数据表）
    const structured = (this.config.sinkKind || 'resultColumn') === 'dataRows'
    if (structured) {
      const schema = (this.config.schema || []).filter((f) => f.name.trim())
      if (!schema.length) throw new Error('结构化输出需要先配置提取字段（至少一个字段名）')
      prompt = `${prompt}\n\n${buildStructuredOutputInstruction(schema)}`
    }

    const options = await buildBatchAgentOptions(unit, this.config, this.store, ctx.runtime)
    const view = await agentBridge.create(options)
    this.viewSlot.set(view.id, ctx.slotIndex)
    ctx.attachSession(unit, view.id)

    const completer = new Promise<ExecutorOutcome>((resolve) => {
      this.completers.set(view.id, { resolve })
    })
    await agentBridge.send(view.id, prompt, 'agent-batch')
    const outcome = await completer

    if (structured && outcome.ok) {
      const text = String(outcome.result || '').trim()
      const rows = tryParseJson(text) || []
      if (!rows.length && text) {
        ctx.log('warning', `未能从智能体输出中解析出 JSON 数据（该行按 0 条处理，原始输出已保留在该行）: ${text.slice(0, 100)}`)
        // 原始输出带回去：runner 会写到行上 → 行详情「输出」与导出的「原始输出」列都能看到，不再静默丢弃
        return { ok: true, rows, rawText: text }
      }
      return { ok: true, rows }
    }
    return outcome
  }

  /** 单元结束后的回收：清理观察状态 + dispose 会话（对齐拆分前 runner 的 finally 段） */
  async cleanup(unit: PipelineUnit): Promise<void> {
    const viewId = unit.viewId
    if (!viewId) return
    this.completers.delete(viewId)
    this.runningSeen.delete(viewId)
    this.stepLogState.delete(viewId)
    this.searchConsumed.delete(viewId)
    this.viewSlot.delete(viewId)
    try { await agentBridge.dispose(viewId) } catch { /* 忽略 */ }
    this.prevUsage.delete(viewId)
    unit.viewId = undefined
  }

  // ==================== 日志：推理增量 + 工具调用 ====================
  /**
   * 值 → 日志文本。
   * @param limit  最大字符数（超出加 …）
   * @param pretty true = 对象格式化为多行 JSON 且保留换行（供日志展开时看完整内容）
   */
  private summarizeValue(v: any, limit = 200, pretty = false): string {
    if (v === null || v === undefined) return ''
    let s: string
    if (typeof v === 'string') s = v
    else if (typeof v === 'object') { try { s = pretty ? JSON.stringify(v, null, 2) : JSON.stringify(v) } catch { s = String(v) } }
    else s = String(v)
    s = pretty ? s.trim() : s.replace(/\s+/g, ' ').trim()
    return s.length > limit ? s.slice(0, limit) + '…' : s
  }

  private logAgentActivity(view: any): void {
    const workerId = this.viewSlot.get(view.id)
    const steps: any[] = view.steps || []
    let state = this.stepLogState.get(view.id)
    // 新 turn 步骤被重置（steps 变短）→ 清空状态，重新从第一段记录
    if (!state || steps.length < state.length) {
      state = []
      this.stepLogState.set(view.id, state)
    }
    for (let si = 0; si < steps.length; si++) {
      const step = steps[si]
      if (!step) continue
      if (!state[si]) state[si] = { reasoningLogged: false, calls: new Set<string>(), endedCalls: new Set<string>() }
      const st = state[si]
      // 推理：本步进入“行动阶段”（已有正文 / 工具调用 / 步骤已结束）时整段输出一次
      const reasoning = step.reasoning || ''
      if (reasoning && !st.reasoningLogged && (step.content || (step.toolCalls && step.toolCalls.length > 0) || step.endTime)) {
        st.reasoningLogged = true
        this.logFn('info', `  💭 ${reasoning}`, workerId)
      }
      // 工具调用：开始 + 结果
      const calls: any[] = step.toolCalls || []
      for (const tc of calls) {
        if (!tc.callId) continue
        if (!st.calls.has(tc.callId)) {
          st.calls.add(tc.callId)
          if (tc.status === 'running') {
            this.logFn('info', `  🧰 调用工具: ${tc.name}`, workerId)
          }
        }
        if ((tc.status === 'success' || tc.status === 'error') && !st.endedCalls.has(tc.callId)) {
          st.endedCalls.add(tc.callId)
          const ok = tc.status === 'success'
          // 行内只放 200 字摘要；展开时看 detail（工具名 + 完整内容，最多 4000 字，对象为格式化 JSON 保留换行）
          const head = `  ✔ 工具 ${tc.name}`
          const short = ok ? this.summarizeValue(tc.result) : this.summarizeValue(tc.error)
          const full = ok ? this.summarizeValue(tc.result, 4000, true) : this.summarizeValue(tc.error, 4000, true)
          this.logFn(
            ok ? 'success' : 'error',
            head + (short ? `: ${short}` : ''),
            workerId,
            full.length > short.length ? head + (full ? `:\n${full}` : '') : '',
          )
        }
      }
    }
  }

  /** 服务端联网搜索（DeepSeek Responses）状态 → 线程日志（增量消费 view.searchEvents） */
  private logSearchEvents(view: any): void {
    const events: any[] = Array.isArray(view?.searchEvents) ? view.searchEvents : []
    let consumed = this.searchConsumed.get(view.id) || 0
    // 事件队列在 turn 开始时会被清空 → 游标回落（续跑/新一轮时重新消费）
    if (events.length < consumed) consumed = 0
    if (events.length <= consumed) return
    const workerId = this.viewSlot.get(view.id)
    for (let i = consumed; i < events.length; i++) {
      const ev = events[i]
      if (!ev) continue
      if (ev.kind === 'search') {
        this.logFn('info', `  🔎 正在联网搜索: ${String(ev.query || '').trim()}`, workerId)
      } else if (ev.kind === 'open') {
        this.logFn('info', `  🌐 打开网页: ${String(ev.url || '').trim()}`, workerId)
      } else if (ev.kind === 'done') {
        const n = Array.isArray(ev.results) ? ev.results.length : 0
        this.logFn('success', `  ✔ 联网搜索完成，搜到 ${n} 条链接`, workerId)
      }
    }
    this.searchConsumed.set(view.id, events.length)
  }
}
