/**
 * rendererAgent.ts — 渲染层智能体循环（安卓壳 / 网页端等「无宿主」环境的执行者）
 *
 * 背景：桌面版的智能体循环在主进程（`electron/main/agent-loop.ts` + `tools.ts`），
 * 渲染层只组装提示词、投影事件。安卓壳与纯网页没有主进程，`agentBridge` 找不到传输层，
 * 于是智能体模式点了没有任何反应。本模块补上这条链路：
 *
 * ```
 * useAgentRun → agentBridge（UI 投影，不改）→ rendererAgentTransport（本模块）
 *                                              ├─ LLM：AIUtils.sendChat（直连，见 shared/ai-core）
 *                                              └─ 工具：lib/agent/rendererTools（平台文件端口 / 检索 / 联网）
 * ```
 *
 * 行为对齐主进程循环：turn/step 事件、流式 chunk 与思维链、工具参数流式、工具白名单守卫、
 * 瞬态错误重试、maxSteps 防死循环、steer（step 边界生效）与 inject（step 边界消费）、
 * ask_user 挂起与回答、plan/todos 状态、状态快照（state/list）。
 *
 * **不支持的宿主能力**：跑 Python / shell / 子代理 / MCP / 技能 / 插件工具 / PTC 代码模式。
 * 这些工具不会暴露给模型（避免它反复调用必然失败的工具）；若模型仍点名调用，返回明确的
 * 「当前环境不支持」说明并提示改用可用工具。
 */

import type {
  AgentEvent, AgentEventMap, AgentEventType, AgentOptions, AgentStateView,
  AgentStatus, AgentSummary, TodoItem,
} from '@/types/agent'
import type { AgentId } from '@/types/ids'
import { normalizeLlmType } from '@/shared/llmSources'
import { DEFAULT_AGENT_MAX_STEPS } from '@/shared/agent-loop-rounds'
import {
  RENDERER_TOOL_NAMES, executeRendererTool, hostOnlyToolError, isRendererTool,
  rendererToolSchemas, type RendererToolContext,
} from '@/lib/agent/rendererTools'

interface InboxItem {
  kind: 'task' | 'steer' | 'inject'
  content: string
  images?: string[]
}

interface ToolCall {
  id: string
  name: string
  arguments: any
}

/** 一步 LLM 的函数签名（默认为 AIUtils.sendChat；测试可注入脚本化实现） */
export type RendererSendChat = (
  provider: string,
  config: any,
  llmConfig: any,
  messages: any[],
  options: any,
) => Promise<any>

export interface RendererAgentDeps {
  /** 覆盖 LLM 调用（默认动态 import AIUtils.sendChat） */
  sendChat?: RendererSendChat
}

/** 单步 LLM 结果 */
interface StepResult {
  content: string
  toolCalls: ToolCall[]
  reasoning?: string
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  finishReason?: string
}

const MAX_LLM_RETRY = 3

/** 工具参数解析失败时的可诊断说明（与主进程同一口径：截断/畸形都提示缩短后重试） */
function parseFailedError(raw: string, truncated: boolean): string {
  const head = raw.slice(0, 160)
  const tail = raw.length > 320 ? raw.slice(-160) : ''
  const hint = truncated ? '本步输出被截断（finish_reason=length，max_tokens / 上下文长度不够）' : '参数 JSON 不合法或缺失'
  return `工具参数无法解析（${hint}，收到 ${raw.length} 字符）：原文开头「${head}」${tail ? `…结尾「${tail}」` : ''}。`
    + '请缩短一次提交的内容后重试（例如大文件分段写入），并确保 JSON 字符串内的换行/引号已正确转义。'
}

/** 宽松解析工具参数（对象直接用；字符串先严格再宽松） */
function parseToolArgs(raw: any): any {
  if (raw === undefined || raw === null || raw === '') return {}
  if (typeof raw === 'object') return raw
  const text = String(raw)
  try {
    return JSON.parse(text)
  } catch {
    /* 尝试宽松修复：转义字符串内的裸控制符 */
  }
  try {
    const escaped = text.replace(/("(?:[^"\\]|\\.)*")/g, (m) => m.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t'))
    return JSON.parse(escaped)
  } catch {
    return { _raw: text }
  }
}

function stripTrailing(url: string | undefined): string {
  return String(url || '').replace(/\/+$/, '')
}

// ---------------------------------------------------------------------------
// 单个会话
// ---------------------------------------------------------------------------

class RendererAgent {
  readonly id: string
  readonly options: AgentOptions

  private emit: (ev: AgentEvent) => void
  private deps: RendererAgentDeps
  private status: AgentStatus = 'idle'
  private inbox: InboxItem[] = []
  private idleWaiters: Array<() => void> = []
  private turnCount = 0
  private stepInTurn = 0
  private disposed = false
  private driverRunning = false
  private turnController: AbortController | null = null
  private plan: string | null = null
  private todos: TodoItem[] = []
  private lastError?: string
  private lastAssistantContent = ''
  private lastFinishReason = ''
  private pendingQuestion: { askId: string; resolve: (answer: string) => void } | null = null
  private streamedArgs = new Map<string, string>()
  /** 会话历史（模型可见；与主进程「模型可见即已记录」同一口径） */
  private history: any[] = []

  constructor(id: string, options: AgentOptions, emit: (ev: AgentEvent) => void, deps: RendererAgentDeps = {}) {
    this.id = id
    this.options = options
    this.emit = emit
    this.deps = deps
    if (options.systemPrompt) this.history.push({ role: 'system', content: options.systemPrompt })
    for (const seed of options.seedHistory || []) {
      this.history.push({ role: seed.role, content: seed.content })
    }
  }

  // ---------------- 状态 ----------------

  toSummary(): AgentSummary {
    return {
      id: this.id as AgentId,
      status: this.status,
      provider: this.options.provider,
      label: this.options.label,
      pendingInbox: this.inbox.length,
    }
  }

  toStateView(): AgentStateView {
    return {
      ...this.toSummary(),
      turn: this.turnCount,
      step: this.stepInTurn,
      plan: this.plan,
      todos: this.todos,
      lastError: this.lastError,
      lastAssistantContent: this.lastAssistantContent,
    }
  }

  private fire<K extends AgentEventType>(type: K, payload: AgentEventMap[K]): void {
    this.emit({ agentId: this.id as any, type, payload } as AgentEvent)
  }

  private setStatus(status: AgentStatus): void {
    this.status = status
    this.fire('agent/status', { status })
  }

  setPlan(plan: string | null): void {
    this.plan = plan
    this.fire('agent/plan', { plan })
  }

  setTodos(todos: TodoItem[]): void {
    this.todos = Array.isArray(todos) ? todos : []
    this.fire('agent/todos', { todos: this.todos })
  }

  // ---------------- 控制 ----------------

  push(item: InboxItem): void {
    this.inbox.push(item)
    this.fire('agent/inbox', { pending: this.inbox.length })
    if (this.status !== 'running' && this.status !== 'stopping') void this.drive()
  }

  answer(askId: string, message: string): boolean {
    if (!this.pendingQuestion || this.pendingQuestion.askId !== askId) return false
    const pending = this.pendingQuestion
    this.pendingQuestion = null
    pending.resolve(message)
    return true
  }

  async cancel(): Promise<void> {
    if (this.status === 'running') this.setStatus('stopping')
    this.turnController?.abort()
    // 挂起的提问用「已取消」收口，避免工具永久等待
    if (this.pendingQuestion) {
      const pending = this.pendingQuestion
      this.pendingQuestion = null
      pending.resolve('（用户取消了本次提问）')
    }
    // 等待驱动器退出（最多 5s，避免界面卡在「停止中」）
    await Promise.race([
      new Promise<void>((resolve) => {
        if (!this.driverRunning) return resolve()
        this.idleWaiters.push(resolve)
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ])
    if (this.status === 'stopping') this.setStatus('idle')
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.cancel()
    this.status = 'disposed'
    this.history = []
  }

  // ---------------- 驱动器 ----------------

  private async drive(): Promise<void> {
    if (this.driverRunning || this.disposed) return
    this.driverRunning = true
    this.setStatus('running')
    try {
      while (!this.disposed) {
        const first = this.inbox.shift()
        if (!first) break
        this.fire('agent/inbox', { pending: this.inbox.length })
        await this.runTurn(first)
        if (this.disposed) break
      }
    } finally {
      this.driverRunning = false
      this.setStatus(this.disposed ? 'disposed' : 'idle')
      const waiters = this.idleWaiters.splice(0)
      for (const w of waiters) w()
    }
  }

  private drainInjected(): InboxItem[] {
    const injected = this.inbox.filter((i) => i.kind === 'inject')
    this.inbox = this.inbox.filter((i) => i.kind !== 'inject')
    if (injected.length) this.fire('agent/inbox', { pending: this.inbox.length })
    return injected
  }

  private claimPendingSteer(): InboxItem | null {
    const idx = this.inbox.findIndex((i) => i.kind === 'steer')
    if (idx < 0) return null
    const [item] = this.inbox.splice(idx, 1)
    return item
  }

  private async runTurn(first: InboxItem): Promise<void> {
    const turn = ++this.turnCount
    this.stepInTurn = 0
    this.fire('agent/turn-start', { turn })
    this.turnController = new AbortController()
    let item: InboxItem | null = first
    let owesWork = true
    let aborted = false
    let stepsInTurn = 0
    const maxSteps = Number(this.options.maxSteps) > 0 ? Number(this.options.maxSteps) : DEFAULT_AGENT_MAX_STEPS

    try {
      while (owesWork && !this.disposed) {
        if (this.turnController.signal.aborted) break
        if (stepsInTurn >= maxSteps) {
          const message = `达到单个 turn 的最大 step 数（${maxSteps}），已停止`
          this.lastError = message
          this.fire('agent/error', { message })
          break
        }
        stepsInTurn++
        const injected = this.drainInjected()
        const step = ++this.stepInTurn
        this.fire('agent/step-start', { turn, step })

        // 本 step 输入：任务 / 转向（user）；注入内容（system，仅本步可见）
        if (item) {
          if (item.kind === 'inject') this.history.push({ role: 'system', content: item.content })
          else this.history.push({ role: 'user', content: item.content })
        }
        for (const inj of injected) this.history.push({ role: 'system', content: inj.content })
        item = null

        this.streamedArgs.clear()
        const result = await this.runStep()
        if (this.turnController.signal.aborted) break
        this.lastFinishReason = result.finishReason || ''

        // 工具参数在最终 payload 里缺失/截断时，用流式原文兜底
        const calls = result.toolCalls.map((c) => {
          const raw = this.streamedArgs.get(String(c.id))
          if (raw && (c.arguments === undefined || c.arguments === null || c.arguments === '')) {
            return { ...c, arguments: raw }
          }
          return c
        })

        this.history.push({
          role: 'assistant',
          content: result.content || '',
          ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}) } })) } : {}),
        })
        this.lastAssistantContent = result.content
        this.fire('assistant/message', {
          content: result.content,
          toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
        })

        let toolCallsCount = 0
        if (calls.length) {
          for (const call of calls) {
            if (this.turnController.signal.aborted) break
            await this.executeToolCall(call, step)
          }
          toolCallsCount = calls.length
        }

        this.fire('agent/step-end', { turn, step, toolCalls: toolCallsCount, usage: result.usage })

        const pendingSteer = this.claimPendingSteer()
        if (pendingSteer) this.fire('agent/inbox', { pending: this.inbox.length })
        owesWork = toolCallsCount > 0 || !!pendingSteer
        item = pendingSteer
      }
    } catch (err: any) {
      aborted = this.turnController.signal.aborted
      if (!aborted) {
        const message = String(err?.message || err)
        this.lastError = message
        this.fire('agent/error', { message })
      }
    } finally {
      const wasAborted = aborted || (this.turnController?.signal.aborted ?? false)
      this.fire('agent/turn-end', { turn, reason: wasAborted ? 'cancelled' : 'completed' })
      this.turnController = null
    }
  }

  // ---------------- LLM ----------------

  /**
   * 一步 LLM 调用（走 AIUtils.sendChat 的统一分派：桌面 = 主进程，本环境 = 直连）。
   * 工具循环强制关闭深度思考：thinking 模式下部分后端会把思考混进正文挤掉结果。
   */
  private async runStep(): Promise<StepResult> {
    const provider = normalizeLlmType(this.options.provider) || 'ollama'
    const cfg: any = this.options.config || {}
    const llmConfig = { ...(this.options.llmConfig || {}), think: 'none' }
    // PTC（代码模式）在渲染层没有 run_code 执行器 → 退化为原生工具模式（把可用工具交给模型）
    const tools = rendererToolSchemas(this.visibleToolNames())
    const signal = this.turnController?.signal

    const isTransientError = (msg: string) =>
      /status[:：] ?5\d\d/i.test(msg) ||
      /HTTP错误!? ?状态码[:：]? ?5\d\d/i.test(msg) ||
      /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed|network error|Load failed/i.test(msg)

    for (let attempt = 0; attempt < MAX_LLM_RETRY; attempt++) {
      let content = ''
      let toolCalls: ToolCall[] = []
      let reasoning: string | undefined
      let finishReason = ''
      let usage: StepResult['usage']

      const callbacks: any = {
        signal,
        tools,
        toolChoice: 'auto',
        onStream: (chunk: string) => {
          content += chunk
          this.fire('assistant/chunk', { content: chunk })
        },
        onReasoning: (text: string) => {
          reasoning = text
          this.fire('assistant/reasoning', { text })
        },
        onToolCalls: (calls: any[]) => {
          toolCalls = (calls || []).map((c: any, i: number) => ({
            id: String(c?.id || `call-${this.stepInTurn}-${i}`),
            name: String(c?.name || c?.function?.name || ''),
            arguments: parseToolArgs(c?.arguments ?? c?.function?.arguments),
          })).filter((c) => c.name)
        },
        onToolCallArgs: (callId: string, name: string, argsFragment: string) => {
          const id = String(callId || '')
          if (id) {
            const prev = this.streamedArgs.get(id) || ''
            const frag = String(argsFragment || '')
            this.streamedArgs.set(id, frag.length > prev.length && frag.startsWith(prev) ? frag : prev + frag)
          }
          this.fire('agent/tool-args', { callId, name, argsFragment })
        },
        onComplete: (c: string, metadata?: any) => {
          if (c !== undefined && c !== null) content = c
          if (metadata) {
            if (metadata.finish_reason) finishReason = String(metadata.finish_reason)
            const pt = metadata?.prompt_tokens ?? metadata?.promptTokens
            const ct = metadata?.completion_tokens ?? metadata?.completionTokens
            if (typeof pt === 'number' || typeof ct === 'number') {
              usage = {
                promptTokens: typeof pt === 'number' ? pt : 0,
                completionTokens: typeof ct === 'number' ? ct : 0,
                totalTokens: metadata?.total_tokens ?? metadata?.totalTokens ?? ((typeof pt === 'number' ? pt : 0) + (typeof ct === 'number' ? ct : 0)),
              }
            }
          }
        },
      }

      try {
        if (this.deps.sendChat) {
          await this.deps.sendChat(provider, cfg, llmConfig, this.history, callbacks)
        } else {
          const { AIUtils } = await import('@/services/ai-utils')
          await AIUtils.sendChat(provider, cfg, llmConfig, this.history, callbacks)
        }
        return { content, toolCalls, reasoning, usage, finishReason }
      } catch (err: any) {
        const msg = String(err?.message || err)
        const clean = content === '' && toolCalls.length === 0 && !reasoning
        if (attempt < MAX_LLM_RETRY - 1 && isTransientError(msg) && clean) {
          await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)))
          continue
        }
        throw new Error(`模型请求失败（来源 ${provider}）：${msg}`)
      }
    }
    throw new Error('模型请求失败')
  }

  /**
   * 暴露给模型的工具：白名单 ∩ 渲染层能执行的工具。
   * 白名单为 null（= 全部）时用渲染层默认清单，保证手机端不会暴露必然失败的工具。
   */
  private visibleToolNames(): string[] {
    const allowed = this.options.tools
    const fallback = Array.from(RENDERER_TOOL_NAMES) as string[]
    // PTC 代码模式：模型以为只有 run_code，本层没有执行器 → 退回原生工具集（否则模型必然失败）
    if (this.options.toolsPresentation === 'code') return fallback.filter((n) => n !== 'run_code')
    if (!Array.isArray(allowed)) return fallback
    return allowed.filter((n) => isRendererTool(n))
  }

  // ---------------- 工具执行 ----------------

  private toolContext(): RendererToolContext {
    return {
      cwd: this.options.cwd,
      kbPaths: this.options.kbPaths,
      kbTopK: this.options.kbTopK,
      retrieval: (this.options as any).retrieval,
      signal: this.turnController?.signal,
      askUser: (question: string) => this.askUser(question),
      setPlan: (plan) => this.setPlan(plan),
      setTodos: (todos) => this.setTodos(todos),
      getTodos: () => this.todos,
    }
  }

  /** 提问：发出 agent/question 事件并挂起，直到 answer()/cancel() 收口 */
  private askUser(question: string): Promise<string> {
    const askId = `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    return new Promise<string>((resolve) => {
      this.pendingQuestion = { askId, resolve }
      this.fire('agent/question', { askId, question })
    })
  }

  private async executeToolCall(call: ToolCall, step: number): Promise<void> {
    const name = String(call?.name || '')
    const callId = String(call?.id || `call-${step}-${Math.random().toString(36).slice(2, 8)}`)
    const args = call?.arguments
    const parsed = typeof args === 'object' && args !== null ? args : parseToolArgs(args)

    // 参数解析失败：不再用空参数执行（否则得到「参数必填」这类误导性报错）
    if (parsed && typeof parsed === 'object' && typeof parsed._raw === 'string') {
      const error = parseFailedError(String(parsed._raw), this.lastFinishReason === 'length')
      this.fire('tool/call', { callId, name, args: undefined, argsParseFailed: true })
      this.pushToolResult(callId, name, false, undefined, error)
      return
    }

    this.fire('tool/call', { callId, name, args: parsed })

    const whitelist = this.options.tools
    if (Array.isArray(whitelist) && !whitelist.includes(name as any)) {
      this.pushToolResult(callId, name, false, undefined, `工具 ${name} 未启用（不在当前工具白名单中）`)
      return
    }

    const result = isRendererTool(name)
      ? await executeRendererTool(name, parsed, this.toolContext())
      : { ok: false as const, error: hostOnlyToolError(name) }
    this.pushToolResult(callId, name, result.ok, (result as any).value, (result as any).error, (result as any).preview)
  }

  private pushToolResult(callId: string, name: string, ok: boolean, value?: any, error?: string, preview?: any): void {
    this.fire('tool/result', { callId, name, ok, value, error, preview })
    // 工具结果回灌模型（错误也回灌：让模型据此改写法，而不是卡死）
    this.history.push({
      role: 'tool',
      tool_call_id: callId,
      name,
      content: ok
        ? (typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 1))
        : `ERROR: ${error || '工具执行失败'}`,
    })
  }
}

// ---------------------------------------------------------------------------
// 传输层（agentBridge 的 AgentTransport 实现）
// ---------------------------------------------------------------------------

class RendererAgentTransport {
  private sessions = new Map<string, RendererAgent>()
  private listeners = new Set<(ev: AgentEvent) => void>()
  private seq = 0
  private deps: RendererAgentDeps

  constructor(deps: RendererAgentDeps = {}) {
    this.deps = deps
  }

  private emit = (ev: AgentEvent): void => {
    for (const cb of [...this.listeners]) {
      try {
        cb(ev)
      } catch (e) {
        console.error('[rendererAgent] 事件订阅者抛错:', e)
      }
    }
  }

  async create(options: AgentOptions): Promise<{ id: string }> {
    const id = `local-${Date.now().toString(36)}-${++this.seq}`
    this.sessions.set(id, new RendererAgent(id, options, this.emit, this.deps))
    return { id }
  }

  async send(id: string, content: string, _source?: string, images?: string[]): Promise<{ success: boolean }> {
    const agent = this.sessions.get(id)
    if (!agent) return { success: false }
    agent.push({ kind: 'task', content, images })
    return { success: true }
  }

  async steer(id: string, content: string): Promise<{ success: boolean; reason?: string }> {
    const agent = this.sessions.get(id)
    if (!agent) return { success: false, reason: '会话不存在' }
    if (agent.toSummary().status !== 'running') return { success: false, reason: '会话未在运行' }
    agent.push({ kind: 'steer', content })
    return { success: true }
  }

  async inject(id: string, content: string): Promise<{ success: boolean }> {
    const agent = this.sessions.get(id)
    if (!agent) return { success: false }
    agent.push({ kind: 'inject', content })
    return { success: true }
  }

  async cancel(id: string, _cause?: string, _keepInbox?: boolean): Promise<{ success: boolean }> {
    const agent = this.sessions.get(id)
    if (!agent) return { success: false }
    await agent.cancel()
    return { success: true }
  }

  async answer(id: string, askId: string, message: string): Promise<{ success: boolean }> {
    const agent = this.sessions.get(id)
    if (!agent) return { success: false }
    return { success: agent.answer(askId, message) }
  }

  async dispose(id: string): Promise<{ success: boolean }> {
    const agent = this.sessions.get(id)
    if (!agent) return { success: false }
    await agent.dispose()
    this.sessions.delete(id)
    return { success: true }
  }

  async list(): Promise<AgentSummary[]> {
    return Array.from(this.sessions.values()).map((a) => a.toSummary())
  }

  async state(id: string): Promise<AgentStateView> {
    const agent = this.sessions.get(id)
    if (!agent) throw new Error(`会话不存在：${id}`)
    return agent.toStateView()
  }

  onEvent(cb: (ev: AgentEvent) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }
}

let transport: RendererAgentTransport | null = null

/**
 * 取渲染层智能体传输层（单例）。
 * 仅在「没有桌面 IPC（window.dsh.agent）、也不是局域网访客」时使用，见 agentBridge.resolveTransport。
 */
export function rendererAgentTransport(): RendererAgentTransport {
  if (!transport) transport = new RendererAgentTransport()
  return transport
}

/** 新建一个传输层实例（自检 / 测试用：可注入脚本化的 sendChat 与独立的会话表） */
export function createRendererAgentTransport(deps: RendererAgentDeps = {}): RendererAgentTransport {
  return new RendererAgentTransport(deps)
}
