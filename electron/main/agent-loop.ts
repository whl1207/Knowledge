/**
 * agent-loop.ts — Agent 循环标准化（turn/step/inbox/cancel/steer/inject）
 *
 * 借鉴 DeepSeek-Harness core 子系统（docs/subsystems/core.md）：
 * - **step** = 一次模型请求 + 它调用的工具；**turn** = 零个或多个 step；
 * - 输入通过统一 **inbox** 到达驱动器：`send`/`followup` 唤醒驱动器并开新
 *   turn；`steer` 投递到最近 step 边界（运行中立即消费）；`inject` 只排队
 *   不唤醒（落到下一次 step 的上下文中）；
 * - `cancel(cause)` 中止当前 turn（首个 cause 生效），`keepInbox` 保留排队工作；
 * - `whenIdle()` 等待 agent 收敛；`dispose()` 终止并注销；
 * - **会话事件落盘**：turn/step/user/assistant/tool 全部写入 session-log
 *   （单一事实源），模型历史由 `deriveMessages` 从日志重建；
 * - 生命周期：`idle → running → stopping → disposed`，每次迁移广播
 *   `agent/status`。
 *
 * 运行在主进程：渲染进程切模块 / 关窗口后 agent 继续执行（对齐 ai-service
 * 的断线续传设计）。LLM 调用复用 `AIUtils`（与 ai-service 同一套 provider
 * 适配），工具执行走统一工具注册表（toolRegistry）。
 */

import { randomUUID } from 'node:crypto'
import { AIUtils } from '@/shared/ai-core'
import { toolRegistry } from '@/shared/toolRegistry'
import { sessionLog } from './session-log'
import { jobRegistry } from './job-registry'
import { browserAgentService } from './browser-agent'
import { credentialStore } from './credentials'
import type {
  AgentOptions,
  AgentStatus,
  AgentControl,
  AgentCancelCause,
  AgentEvent,
  AgentEventMap,
  AgentEventType,
  AgentStepUsage,
  AgentSummary,
  AgentStateView,
  TodoItem,
} from '@/types/agent'
import type { DerivedMessage } from '@/types/session-log'
import type { ToolResult, ToolExecutionContext } from '@/types/tool'
import { brand, type ToolName, type AgentId } from '@/types/ids'
import { runCodeFunctionSchema } from './code-sdk'
import { DEFAULT_AGENT_MAX_STEPS } from '@/shared/agent-loop-rounds'

// ---------------------------------------------------------------------------
// 广播
// ---------------------------------------------------------------------------

let broadcast: ((ev: AgentEvent) => void) | null = null

/** 设置 agent 事件广播（main/index.ts 在 app ready 时注入） */
export function setAgentBroadcast(fn: ((ev: AgentEvent) => void) | null): void {
  broadcast = fn
}

/** 向指定 agent 广播事件（供模块级函数使用，如 requestAnswer） */
function emitTo<K extends AgentEventType>(agentId: string, type: K, payload: AgentEventMap[K]): void {
  broadcast?.({ agentId: agentId as any, type, payload } as AgentEvent)
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function stripTrailing(url: string | undefined): string {
  return (url || '').replace(/\/+$/, '')
}

function authHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  return headers
}

/** 把日志派生的消息转换为 OpenAI 风格消息（tool_calls / tool_call_id） */
function toOpenAIMessage(m: DerivedMessage): any {
  const out: any = { role: m.role, content: m.content }
  if (m.role === 'assistant' && m.toolCalls?.length) out.tool_calls = m.toolCalls
  if (m.role === 'tool') out.tool_call_id = m.toolCallId
  return out
}

function parseToolArgs(raw: any): any {
  // 容错解析工具参数。部分后端/parser（如 GPUStack 的 qwen3_xml）会把 JSON 再包一层字符串
  // （arguments 形如 "\"{...}\"" 或带多余引号），单次 JSON.parse 会失败或得到字符串。
  let v: any = raw
  for (let i = 0; i < 4; i++) {
    if (typeof v !== 'string') break
    const t = v.trim()
    if (!t) { v = {}; break }
    try {
      const parsed = JSON.parse(t)
      // 解出一层：若仍是字符串（嵌套字符串化 JSON）则继续解包，直到得到对象/数组
      v = parsed
      if (typeof parsed !== 'string') break
    } catch {
      // 尝试去掉最外层多余引号后重试（qwen3_xml 偶发前后多余引号）
      const cleaned = t.replace(/^"+|"+$/g, '')
      if (cleaned !== t) { v = cleaned; continue }
      return { _raw: t }
    }
  }
  if (typeof v === 'string') {
    // 多次解包后仍是纯字符串（非 JSON 对象）：清理外围引号后尽力再解析一次
    const cleaned = v.trim().replace(/^"+|"+$/g, '')
    try { return JSON.parse(cleaned) } catch { return { _raw: v } }
  }
  return v && typeof v === 'object' ? v : {}
}

/**
 * 修复「字符串内部未转义的控制字符」再解析：模型 / 本地网关把多行代码直接塞进 JSON 字符串
 * （真实换行 / 制表符 / 回车）是最常见的坏参数来源。
 */
function escapeRawControlCharsInStrings(text: string): string {
  let out = ''
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (!inStr) {
      if (ch === '"') inStr = true
      out += ch
      continue
    }
    if (ch === '\\') { out += ch + (text[i + 1] ?? ''); i++; continue }
    if (ch === '"') { inStr = false; out += ch; continue }
    if (ch === '\n') { out += '\\n'; continue }
    if (ch === '\r') { out += '\\r'; continue }
    if (ch === '\t') { out += '\\t'; continue }
    const code = ch.charCodeAt(0)
    if (code < 0x20) { out += '\\u' + code.toString(16).padStart(4, '0'); continue }
    out += ch
  }
  return out
}

/** 解析是否真的拿到了参数对象（`_raw` 标记表示解析失败） */
function parseOk(parsed: any): boolean {
  return !!parsed && typeof parsed === 'object' && parsed._raw === undefined
}

/** 宽容解析：先按 parseToolArgs（含多层解包），失败再修复裸控制字符后重试 */
function parseToolArgsLenient(raw: any): any {
  const first = parseToolArgs(raw)
  if (parseOk(first)) return first
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const repaired = JSON.parse(escapeRawControlCharsInStrings(raw.trim()))
      if (repaired && typeof repaired === 'object') return repaired
    } catch { /* 仍然失败：保留原结果（_raw）供上层报错 */ }
  }
  return first
}

/**
 * 归一化 assistant 工具调用列表：把每个 call 的 arguments 解析并重新序列化为干净的单层 JSON 字符串。
 * 目的：GPUStack qwen3_xml 给出的 arguments 常是多层转义/带多余引号的畸形 JSON，若原样写入会话日志，
 * 下一轮会把畸形 arguments 回传给 vLLM，触发其模板解析失败（HTTP 400 Extra data）。
 *
 * `streamedFor`：按 callId 取本步「参数流式增量累积的原文」。部分本地网关（GPUStack / LM Studio 等）
 * 在最终 tool_calls 里丢掉或截断了 arguments，而参数增量已完整发出——用流式原文兜底可救回参数；
 * 否则工具会拿空参数执行（表现为 "code 参数必填" 这类误导报错，且模型会反复重试同样的调用）。
 *
 * 解析失败时**不再退化成 `{}`**（那会静默丢掉参数），而是把原文保留到 `_raw` 字段：
 * 它仍是合法 JSON（不会被 vLLM 模板判为 Extra data），模型也能看出自己的参数被截断/畸形。
 */
function normalizeToolCalls(
  calls: any[] | undefined,
  streamedFor?: (callId: string) => string | undefined,
): { calls: any[]; recovered: string[]; failed: string[] } {
  const recovered: string[] = []
  const failed: string[] = []
  if (!Array.isArray(calls)) return { calls: [], recovered, failed }
  const out = calls.map((c: any) => {
    const fn = c?.function
    if (!fn || typeof c !== 'object') return c
    let args = fn.arguments
    if (typeof args === 'string') {
      const callId = String(c?.id || '')
      const streamed = (streamedFor && callId ? String(streamedFor(callId) || '') : '').trim()
      const current = args.trim()
      if (!current && !streamed) {
        // 无参数（部分网关对无参工具给空字符串）：保持原行为，由工具自身校验必填参数
        args = '{}'
      } else {
        let parsed: any
        let chosen = ''
        let fromStream = false
        for (const cand of [current, streamed]) {
          if (!cand) continue
          const p = parseToolArgsLenient(cand)
          if (parseOk(p)) { parsed = p; chosen = cand; fromStream = cand === streamed; break }
        }
        if (parseOk(parsed)) {
          args = JSON.stringify(parsed)
          // 最终 payload 的参数不可用、靠流式原文救回：记一笔便于诊断
          if (fromStream && callId && !parseOk(parseToolArgs(current))) recovered.push(callId)
        } else {
          const raw = chosen || current
          if (callId) failed.push(callId)
          args = JSON.stringify({ _raw: raw })
        }
      }
    }
    return { ...c, function: { ...fn, arguments: args } }
  })
  return { calls: out, recovered, failed }
}

// ---------------------------------------------------------------------------
// 同后端并发限流（远程自托管推理服务）：多并发流式请求打到远端 LM Studio /
// GPUStack 等单机推理服务时，拿不到生成 slot 的请求会被静默丢弃（200 空流）或
// 返回 500，因此对同一后端的在途请求数做信号量限制，让多线程排队而不是同时压上
// ---------------------------------------------------------------------------

/** 远程自托管后端在途请求上限的取值范围 */
const REMOTE_BACKEND_MAX_INFLIGHT_MIN = 1
const REMOTE_BACKEND_MAX_INFLIGHT_MAX = 500
/**
 * 全局基准上限（默认 2，本机 localhost 服务不受此限制）。
 * 来自「设置 → 大模型 → 通用参数」的 remoteMaxInflight，经 agent 选项 llmConfig 带主进程，
 * createAgent 时调用 setRemoteBackendMaxInflight 同步。
 */
let remoteBackendMaxInflight = 2
/** 可自托管的 OpenAI 兼容后端（本地/内网部署，受单机推理能力限制） */
const SELFHOSTED_PROVIDERS = new Set(['ollama', 'lmstudio', 'custom'])

const backendInflight = new Map<string, number>()
/**
 * 各编排运行（AgentBatch / AgentSwarm …）声明的期望并发：scopeId → 并发数。
 * 生效上限 = max(全局基准, 活跃声明)，使「远端大模型并发」跟随编排自身设置的 agent 并发数。
 */
const concurrencyIntents = new Map<string, number>()

function clampInflight(n: number): number {
  if (!Number.isFinite(n)) return 2
  return Math.min(REMOTE_BACKEND_MAX_INFLIGHT_MAX, Math.max(REMOTE_BACKEND_MAX_INFLIGHT_MIN, Math.round(n)))
}

/** 更新全局基准上限（非法/缺省值忽略，不改变当前值） */
export function setRemoteBackendMaxInflight(value: unknown): void {
  const n = Number(value)
  if (!Number.isFinite(n)) return
  remoteBackendMaxInflight = clampInflight(n)
}

/** 编排运行时声明期望并发（幂等；结束/停止时应调用 revokeRemoteConcurrency 释放） */
export function declareRemoteConcurrency(scopeId: string, concurrency: number): void {
  if (!scopeId) return
  concurrencyIntents.set(scopeId, clampInflight(Number(concurrency) || 2))
}

/** 编排运行结束/停止：撤销并发声明（无该声明则忽略） */
export function revokeRemoteConcurrency(scopeId: string): void {
  if (!scopeId) return
  concurrencyIntents.delete(scopeId)
}

/** 当前生效上限 = max(全局基准, 所有活跃编排声明的并发) */
function effectiveRemoteMaxInflight(): number {
  let m = remoteBackendMaxInflight
  for (const n of concurrencyIntents.values()) if (n > m) m = n
  return m
}

/** URL 是否指向本机（本机推理服务并发通常能自持，不限流） */
function isLocalEndpoint(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return !host || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0'
  } catch {
    return false
  }
}

/** 生成后端限流键：provider + origin（同一服务的不同路径共享配额） */
function backendKey(provider: string, url: string): string {
  try {
    return `${provider}:${new URL(url).origin}`
  } catch {
    return `${provider}:${url}`
  }
}

/** 申请一个后端在途配额；超出上限时轮询等待空位（setTimeout 让步，不阻塞其它会话），返回释放函数 */
async function acquireBackendLease(key: string): Promise<() => void> {
  for (;;) {
    const cur = backendInflight.get(key) || 0
    if (cur < effectiveRemoteMaxInflight()) {
      backendInflight.set(key, cur + 1)
      return () => {
        const n = (backendInflight.get(key) || 1) - 1
        if (n <= 0) backendInflight.delete(key)
        else backendInflight.set(key, n)
      }
    }
    // 让出事件循环，避免忙等；释放方会递减计数，轮询自然感知空位
    await new Promise((r) => setTimeout(r, 80))
  }
}

// ---------------------------------------------------------------------------
// Agent 实现
// ---------------------------------------------------------------------------

type InboxItem = { kind: 'user' | 'steer' | 'inject'; content: string; source?: string; images?: string[] }

class AgentImpl implements AgentControl {
  readonly id: AgentId
  readonly options: AgentOptions
  private _status: AgentStatus = 'idle'
  private inbox: InboxItem[] = []
  private pendingWake: Array<() => void> = []
  private idleWaiters: Array<() => void> = []
  private turnController: AbortController | null = null
  private turnCount = 0
  /** 当前 turn 内的 step 编号（每次 turn 重新从 1 计数，turn+step 组合全局唯一） */
  private stepInTurn = 0
  private disposed = false
  private driverRunning = false
  // plan / todos（update_plan、update_todo 工具维护，随 agent/plan、agent/todos 事件广播）
  private _plan: string | null = null
  private _todos: TodoItem[] = []
  private lastError: string | undefined
  /** 最近一次 assistant/message 的完整内容（供工作流智能体节点/agent:run 取最终结果） */
  private lastAssistantContent = ''
  /** 最近一步 LLM 的 finish_reason（length = 被 max_tokens/上下文截断；用于参数解析失败的诊断提示） */
  private lastFinishReason = ''
  /**
   * 本 step 工具参数流式增量累积（callId → JSON 原文）。
   * 仅用于最终 tool_calls 丢参/截断时兜底（见 normalizeToolCalls），每 step 开始前清空。
   */
  private streamedArgs = new Map<string, string>()
  // 带图任务：user 消息序号（1 基）→ 图片 data URL 数组。
  // 图片只在内存里（会话日志只记数量），每次 buildMessages 按序号挂回对应消息；
  // 只保留最近 4 个带图任务，避免长会话/多次传图长期占内存。
  private taskImagesBySeq = new Map<number, string[]>()
  private optionImagesUsed = false

  // 当前 turn 对应的后台任务（路线图 2.4；turn 结束/取消时完成或取消）
  private jobId: string | null = null
  // 已加载过的技能（防模型反复调用 skill 工具导致死循环）
  private loadedSkills = new Set<string>()

  constructor(options: AgentOptions) {
    this.id = brand(`agent-${randomUUID()}`)
    this.options = options
    // 会话事件日志：创建即写 session/start（模型可见的 systemPrompt 落盘）
    sessionLog.append(this.id, 'session/start', {
      provider: options.provider,
      model: options.llmConfig?.model || options.config?.model,
      systemPrompt: options.systemPrompt,
      createdAt: Date.now(),
    })
    // 会话历史种子：聊天窗口的既有上下文写入本 agent 的日志（模型可见即已记录），
    // 使模型继承多轮对话上下文（deriveMessages 自动包含）
    for (const seed of options.seedHistory || []) {
      sessionLog.append(this.id, seed.role === 'assistant' ? 'assistant/message' : 'user/message', {
        content: seed.content,
        source: 'seed',
      })
    }
  }

  get status(): AgentStatus {
    return this._status
  }

  /** 最近一次 assistant 完整内容（工作流智能体节点取结果用） */
  get lastContent(): string {
    return this.lastAssistantContent
  }

  /** 已完成的 turn 数 */
  get currentTurn(): number {
    return this.turnCount
  }

  // ---------------- inbox 语义 ----------------

  /**
   * 发送用户任务。`images`（data URL 数组）为多模态附图：
   * - 显式传入优先；
   * - 否则首次 send 时取 `options.taskImages`（agent:create 时带的图，供工作流节点等入口使用）；
   * 图片只在内存里保存（见 taskImageData），会话日志只记数量。
   */
  send(content: string, source?: string, images?: string[]): void {
    let imgs = Array.isArray(images) ? images.filter(Boolean) : []
    if (imgs.length === 0 && !this.optionImagesUsed && this.options.taskImages?.length) {
      imgs = this.options.taskImages.filter(Boolean)
      this.optionImagesUsed = true
    }
    this.inbox.push({ kind: 'user', content, source, images: imgs.length ? imgs : undefined })
    this.wake()
  }

  followup(content: string, source?: string, images?: string[]): void {
    this.send(content, source, images)
  }

  steer(content: string): void {
    this.inbox.push({ kind: 'steer', content })
    this.wake()
  }

  inject(content: string): void {
    // 只排队不唤醒：落到下一次 step 的上下文中
    this.inbox.push({ kind: 'inject', content })
    this.emit('agent/inbox', { pending: this.inbox.length })
  }

  cancel(cause: AgentCancelCause, opts?: { keepInbox?: boolean }): void {
    if (this._status === 'disposed') return
    if (!opts?.keepInbox) {
      // 清空排队与转向工作（注入上下文随取消丢弃，对齐 DSH 语义）
      this.inbox = []
      this.emit('agent/inbox', { pending: 0 })
    }
    this._status = 'stopping'
    this.emitStatus()
    // 中止 turn 的同时 reject 挂起的 ask_user 问题，防止驱动器卡在工具等待上
    rejectPendingQuestions(this.id, `执行已取消（${cause}）`)
    rejectPendingRendererTasks(this.id, `执行已取消（${cause}）`)
    this.turnController?.abort(cause)
  }

  whenIdle(): Promise<void> {
    return new Promise((resolve) => {
      if (this._status === 'idle' || this._status === 'disposed') {
        resolve()
        return
      }
      this.idleWaiters.push(resolve)
    })
  }

  async dispose(): Promise<void> {
    if (this._status === 'disposed') return
    this.disposed = true
    this._status = 'disposed'
    this.emitStatus()
    this.inbox = []
    this.turnController?.abort('dispose')
    this.wake() // 让驱动器收敛退出
    // 等待驱动器退出（有界）
    const deadline = Date.now() + 5000
    while (this.driverRunning && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    agents.delete(this.id)
    // reject 全部挂起问题（防止 ask_user 的 Promise 悬挂）
    rejectPendingQuestions(this.id, 'agent 已销毁')
    rejectPendingRendererTasks(this.id, 'agent 已销毁')
    // 取消该 agent 的后台任务（路线图 2.4：owner 级联取消）
    if (this.jobId) {
      jobRegistry.cancel(this.jobId, 'agent 已销毁')
      this.jobId = null
    }
    jobRegistry.cancelForOwner(this.id, 'agent 已销毁')
    sessionLog.append(this.id, 'session/end', { status: 'disposed' })
    // 会话销毁：回收该会话仍遗留的浏览器 AI 标签
    try { browserAgentService.recycleOwnerTabs(this.id) } catch { /* 忽略 */ }
    this.notifyIdle()
  }

  // ---------------- 驱动器 ----------------

  /** 启动驱动器（createAgent 调用一次；内部循环直到 dispose） */
  drive(): void {
    void this.driveInternal()
  }

  private async driveInternal(): Promise<void> {
    this.driverRunning = true
    try {
      while (!this.disposed) {
        const item = await this.waitForWake()
        if (!item || this.disposed) break
        if (this._status === 'stopping') {
          // 取消后收敛：把未处理的输入归还 inbox，回到 idle 等待下次唤醒
          this.inbox.unshift(item)
          this._status = 'idle'
          this.emitStatus()
          this.notifyIdle()
          continue
        }
        this._status = 'running'
        this.emitStatus()
        await this.runTurn(item)
        if (this.disposed) break
        this._status = 'idle'
        this.emitStatus()
        // 浏览器会话标签按属主精确回收：本会话跑完（回到 idle）即回收它自己开的 AI 标签，
        // 10 个 agent 谁结束收谁的，不依赖全局 90s 静默 / cap（保留：当前激活 / 用户接管的标签）
        try { browserAgentService.recycleOwnerTabs(this.id) } catch { /* 忽略（窗口未开/已关等） */ }
        this.notifyIdle()
      }
    } finally {
      this.driverRunning = false
      this.notifyIdle()
    }
  }

  private waitForWake(): Promise<InboxItem | null> {
    return new Promise((resolve) => {
      const check = () => {
        const idx = this.inbox.findIndex((i) => i.kind !== 'inject')
        if (idx >= 0) {
          resolve(this.inbox.splice(idx, 1)[0])
        } else if (this.disposed) {
          resolve(null)
        } else {
          this.pendingWake.push(check)
        }
      }
      check()
    })
  }

  private wake(): void {
    this.emit('agent/inbox', { pending: this.inbox.length })
    while (this.pendingWake.length) this.pendingWake.shift()?.()
  }

  private notifyIdle(): void {
    while (this.idleWaiters.length) this.idleWaiters.shift()?.()
  }

  // ---------------- turn / step ----------------

  private async runTurn(firstItem: InboxItem): Promise<void> {
    const turn = ++this.turnCount
    // 每个 turn（一次任务）的 step 从 1 重新编号：控制台执行时间线从 Step 1 开始，
    // 而不是沿用跨 turn 的全局递增序号（旧实现第二次任务从 Step 2 起）
    this.stepInTurn = 0
    sessionLog.append(this.id, 'turn/start', { turn })
    this.emit('agent/turn-start', { turn })

    // 后台任务身份（路线图 2.4）：每个 turn 一个 job，owner = agent id
    const job = jobRegistry.start('agent', this.id, `Agent turn ${turn}`, { progress: 0, detail: '开始处理' })
    this.jobId = job.id

    this.turnController = new AbortController()
    let item: InboxItem | null = firstItem
    let owesWork = true
    let aborted = false
    let stepsInTurn = 0
    // 循环轮数：由渲染进程按唯一数据源（store.generalAgentMaxSteps / preset.maxSteps）注入；兜底同源默认值
    const maxSteps = this.options.maxSteps ?? DEFAULT_AGENT_MAX_STEPS

    try {
      while (owesWork && !this.disposed) {
        if (this.turnController.signal.aborted) break
        if (stepsInTurn >= maxSteps) {
          // 防死循环：达到单 turn step 上限（fail-loud，不静默截断）
          const message = `达到单个 turn 的最大 step 数（${maxSteps}），已停止`
          sessionLog.append(this.id, 'agent/status', { status: 'error' })
          this.emit('agent/error', { message })
          this.setError(message)
          jobRegistry.fail(this.jobId!, message)
          break
        }
        stepsInTurn++

        // 领取本 step 的注入上下文（inject 只排队不唤醒，在 step 边界消费）
        const injected = this.drainInjected()
        const step = ++this.stepInTurn
        sessionLog.append(this.id, 'step/start', { turn, step })
        this.emit('agent/step-start', { turn, step })
        // 任务进度（0..100；maxSteps 为上限，步骤完成即推进）
        jobRegistry.progress(this.jobId!, Math.min(95, Math.round((stepsInTurn / Math.max(1, maxSteps)) * 100)), `步骤 ${stepsInTurn}/${maxSteps}`)

        // item 为 null 时（工具调用后续轮）消息仅由日志历史 + 注入上下文组成
        const messages = this.buildMessages(item, injected)
        // 本 step 的工具参数流式累积清零（最终 payload 丢参时按 callId 兜底用）
        this.streamedArgs.clear()
        const result = await this.runStep(messages)
        item = null // 本 step 的输入已消费

        if (this.turnController.signal.aborted) break
        // 归一化工具调用 arguments（GPUStack qwen3_xml 常给多层转义畸形 JSON），
        // 入日志/回传前解析为干净单层 JSON 字符串，避免下一轮回传 vLLM 时 400 Extra data；
        // 最终 payload 丢参/截断时用本步流式原文兜底（否则工具会拿空参数执行）
        const norm = normalizeToolCalls(result.toolCalls, (callId) => this.streamedArgs.get(callId))
        const cleanCalls = norm.calls
        this.lastFinishReason = result.finishReason || ''
        if (norm.recovered.length) {
          console.warn(`[agent] 工具参数已用流式原文兜底（callId=${norm.recovered.join(',')}）：最终 tool_calls 缺失/截断参数`)
        }
        sessionLog.append(this.id, 'assistant/message', {
          content: result.content,
          toolCalls: cleanCalls,
          reasoning: result.reasoning,
        })
        this.lastAssistantContent = result.content
        this.emit('assistant/message', { content: result.content, toolCalls: cleanCalls })

        let toolCallsCount = 0
        if (cleanCalls.length) {
          for (const call of cleanCalls) {
            await this.executeToolCall(call, step)
          }
          toolCallsCount = cleanCalls.length
        }

        sessionLog.append(this.id, 'step/end', { turn, step, toolCalls: toolCallsCount })
        this.emit('agent/step-end', { turn, step, toolCalls: toolCallsCount, usage: result.usage })

        // 工具调用欠一次请求（继续下一 step 携带工具结果），
        // 或运行期间收到了 steer（转向下一 step）→ 继续
        const pendingSteer = this.claimPendingSteer()
        owesWork = toolCallsCount > 0 || !!pendingSteer
        item = pendingSteer
      }
    } catch (err: any) {
      aborted = this.turnController.signal.aborted
      if (!aborted) {
        const message = err?.message || String(err)
        this.setError(message)
        sessionLog.append(this.id, 'agent/status', { status: 'error' })
        this.emit('agent/error', { message })
      }
    } finally {
      // 中止可能是抛异常路径（catch 已置 aborted）或 step 之间检查到 signal.aborted
      const wasAborted = aborted || (this.turnController?.signal.aborted ?? false)
      const reason = wasAborted ? 'cancelled' : 'completed'
      sessionLog.append(this.id, 'turn/end', { turn, reason })
      this.emit('agent/turn-end', { turn, reason })
      // 后台任务收尾：取消/异常 → 标记取消或失败；正常 → 完成
      if (this.jobId) {
        if (wasAborted) {
          jobRegistry.cancel(this.jobId, this.lastError ? `已取消：${this.lastError}` : '用户取消')
        } else if (this.lastError) {
          jobRegistry.fail(this.jobId, this.lastError)
        } else {
          jobRegistry.complete(this.jobId)
        }
        this.jobId = null
      }
      this.turnController = null
    }
  }

  private drainInjected(): InboxItem[] {
    const injected = this.inbox.filter((i) => i.kind === 'inject')
    this.inbox = this.inbox.filter((i) => i.kind !== 'inject')
    if (injected.length) this.emit('agent/inbox', { pending: this.inbox.length })
    return injected
  }

  private claimPendingSteer(): InboxItem | null {
    const idx = this.inbox.findIndex((i) => i.kind === 'steer')
    if (idx < 0) return null
    const [item] = this.inbox.splice(idx, 1)
    return item
  }

  private buildMessages(item: InboxItem | null, injected: InboxItem[]): any[] {
    // "模型可见即已记录"：本 step 的输入（用户消息 / 注入上下文）先落盘，
    // 再从日志派生历史——工具续轮时原始输入不会丢失，且可完整重建
    if (injected.length > 0) {
      const text = injected.map((i) => i.content).join('\n\n')
      sessionLog.append(this.id, 'user/message', {
        content: `<injected_context>\n${text}\n</injected_context>`,
        source: 'inject',
      })
    }
    if (item) {
      sessionLog.append(this.id, 'user/message', {
        content: item.content,
        source: item.source,
        images: item.images?.length || undefined,
      })
    }
    // 模型历史从会话日志派生（单一事实源，而不是第二份消息状态）
    const history = sessionLog.deriveMessages(this.id)
    // 附图任务：记住「第 N 条 user 消息带图」（图片本体不进日志，后续 step / 多轮都从这里复原）
    if (item?.images?.length) {
      const seq = history.filter((m) => m.role === 'user').length
      this.taskImagesBySeq.set(seq, item.images)
      if (this.taskImagesBySeq.size > 4) {
        const oldest = this.taskImagesBySeq.keys().next().value
        if (typeof oldest === 'number') this.taskImagesBySeq.delete(oldest)
      }
    }
    let userSeq = 0
    return history.map((m) => {
      const msg = toOpenAIMessage(m)
      if (msg.role === 'user') {
        userSeq++
        const imgs = this.taskImagesBySeq.get(userSeq)
        if (imgs?.length) msg.images = imgs
      }
      return msg
    })
  }

  private visibleTools(): any[] {
    // PTC（Code Mode）：能力目录（options.tools）不变，但模型可见的工具
    // schema 坍缩为单个 run_code——模型写程序用 ctx SDK 组合多步操作
    if (this.options.toolsPresentation === 'code') {
      return [runCodeFunctionSchema() as any]
    }
    const defs = toolRegistry.list(this.options.scope)
    const whitelist = this.options.tools
    let selected = whitelist === null
      ? defs
      : defs.filter((d) => whitelist?.includes(d.name))
    // 联网搜索：DeepSeek Responses API 已移除服务端 web_search（官方兼容表：内置工具一律忽略），
    // 因此不再为 deepseek-responses 隐藏本地 web_search / web_fetch —— 所有后端的联网搜索
    // 统一由本地工具层提供（能力插槽仍通过 tools 白名单生效）
    // run_code 是 PTC（Code Mode）专属呈现工具：仅在 toolsPresentation==='code' 时可见，
    // native 模式一律隐藏（fail-closed），避免 tools=null（全部工具）时泄漏到普通智能体
    selected = selected.filter((d) => d.name !== 'run_code')
    return selected.map((d) => ({
      type: 'function',
      function: {
        name: d.name,
        description: d.description,
        parameters: d.inputSchema || { type: 'object', properties: {} },
      },
    }))
  }

  // ---------------- LLM step ----------------

  /**
   * runStep 外层：对远程自托管后端做在途并发限流——
   * 多个 agent（批量多线程）同时压向同一远端 LM Studio 时排队请求，避免空回/500。
   */
  private async runStep(messages: any[]): Promise<{ content: string; toolCalls: any[]; reasoning?: string; usage?: AgentStepUsage; finishReason?: string }> {
    const provider = this.options.provider
    const cfg: any = this.options.config || {}
    // 自托管后端取实际服务地址（lmstudio/openai/... 用 base_url；ollama 用 model_url；custom 用 api_url/base_url）
    const inflightUrl =
      provider === 'ollama' ? (cfg.model_url || '')
      : provider === 'custom' ? (cfg.api_url || cfg.base_url || '')
      : (cfg.base_url || '')
    const limit = SELFHOSTED_PROVIDERS.has(provider) && !isLocalEndpoint(inflightUrl)
    const release = limit ? await acquireBackendLease(backendKey(provider, inflightUrl)) : null
    try {
      return await this.runStepInner(messages)
    } finally {
      release?.()
    }
  }

  private async runStepInner(messages: any[]): Promise<{ content: string; toolCalls: any[]; reasoning?: string; usage?: AgentStepUsage; finishReason?: string }> {
    const { provider, config } = this.options
    // Agent/批量工具循环强制关闭深度思考：thinking 模式下（尤其 GPUStack 畸形输出：缺 <think> 开标签、
    // 思考以正文流出）会把思考内容混入/挤掉正文，导致最终无正文结果。home 单轮问答仍由全局推理强度控制。
    const llmConfig = { ...(this.options.llmConfig || {}), think: 'none' }
    const signal = this.turnController?.signal
    const tools = this.visibleTools()
    let stepUsage: AgentStepUsage | undefined

    // 凭据接缝（路线图 2.3）：配置可只存 apiKeyRef（引用名），请求前由主进程
    // 从受保护的 credentials.json 解析明文；内联 api_key 保持向后兼容。
    const resolvedConfig = this.resolveConfigWithCredential(config)

    // 瞬态错误自动重试（HTTP 5xx / 网络抖动 / 本地后端瞬时过载）：仅当失败前未产出任何
    // 内容时重试，避免把已写入会话日志的部分 chunk 重复进模型历史（"模型可见即已记录"）
    const MAX_LLM_RETRY = 5
    // AICore 直连抛出的 500 错误为中文格式（HTTP错误! 状态码: 500），同时兼容英文 status: 5xx
    // 与网络层错误——若不识别，500 不会被当作瞬态错误，导致该行任务直接终止
    const isTransientError = (msg: string) =>
      /status[:：] ?5\d\d/i.test(msg) ||
      /HTTP错误!? ?状态码[:：]? ?5\d\d/i.test(msg) ||
      /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed|network error/i.test(msg)

    for (let attempt = 0; attempt < MAX_LLM_RETRY; attempt++) {
      // 每次尝试重置累积器（重试时不并入上一次残留内容）
      let content = ''
      let toolCalls: any[] = []
      let reasoning: string | undefined
      // 结束原因（finish_reason）：length = 被 max_tokens / 模型上下文截断（“没推理完就结束”的典型原因）
      let finishReason = ''

      const callbacks: any = {
        signal,
        tools,
        toolChoice: 'auto',
        onStream: (chunk: string) => {
          content += chunk
          sessionLog.append(this.id, 'assistant/chunk', { content: chunk })
          this.emit('assistant/chunk', { content: chunk })
        },
        onReasoning: (text: string) => {
          reasoning = text
          console.log('[agent-reasoning]', this.id, text.length)
          // 思维链流式：把全量累积文本广播给渲染进程（前端按 step 时间线插入思考单元）
          this.emit('assistant/reasoning', { text })
        },
        onToolCalls: (calls: any[]) => {
          toolCalls = calls || []
        },
        // 工具参数流式增量（function calling）：write_file 等长内容工具在模型生成参数期间
        // 实时透传渲染进程，前端立即显示 tool-box + 流式代码内容（不再等整段参数生成完）。
        // 同时在本进程累积原文：部分本地网关最终 tool_calls 会丢参/截断，用它兜底。
        onToolCallArgs: (callId: string, name: string, argsFragment: string) => {
          const id = String(callId || '')
          if (id) {
            const prev = this.streamedArgs.get(id) || ''
            const frag = String(argsFragment || '')
            // 与渲染层同一语义：新串是旧串的前缀扩展 → 覆盖（全量快照），否则拼接（增量片段）
            this.streamedArgs.set(id, frag.length > prev.length && frag.startsWith(prev) ? frag : prev + frag)
          }
          this.emit('agent/tool-args', { callId, name, argsFragment })
        },
        // 服务端联网搜索状态（deepseek-responses web_search_call）：透传给渲染进程展示
        // 「正在联网搜索…/搜到 N 条结果 + 来源链接」，与普通聊天的 message.webSearch 一致
        onSearchStatus: (info: any) => {
          sessionLog.append(this.id, 'assistant/search-status', {
            status: info?.status || '',
            query: info?.query,
            results: Array.isArray(info?.results) ? info.results : undefined,
            action: info?.action,
          })
          this.emit('agent/search-status', {
            status: info?.status || '',
            query: info?.query,
            results: Array.isArray(info?.results) ? info.results : undefined,
            action: info?.action,
          })
        },
        onComplete: (c: string, metadata?: any) => {
          if (c !== undefined && c !== null) content = c
          if (metadata) {
            if (metadata.finish_reason) finishReason = String(metadata.finish_reason)
            const pt = metadata?.prompt_tokens ?? metadata?.promptTokens
            const ct = metadata?.completion_tokens ?? metadata?.completionTokens
            if (typeof pt === 'number' || typeof ct === 'number') {
              stepUsage = {
                promptTokens: typeof pt === 'number' ? pt : 0,
                completionTokens: typeof ct === 'number' ? ct : 0,
                totalTokens: metadata?.total_tokens ?? metadata?.totalTokens ?? ((typeof pt === 'number' ? pt : 0) + (typeof ct === 'number' ? ct : 0)),
              }
            }
          }
        },
      }

      let p: Promise<any>
      switch (provider) {
        case 'ollama':
          p = AIUtils.sendToOllama(resolvedConfig, llmConfig, messages, callbacks)
          break
        case 'lmstudio':
          p = AIUtils.sendToLMStudio(resolvedConfig, llmConfig, messages, callbacks)
          break
        case 'openai':
        case 'custom': {
          const body: any = AIUtils.buildOpenAIRequest(resolvedConfig, llmConfig, messages)
          if (tools.length) {
            body.tools = tools
            body.tool_choice = 'auto'
          }
          // custom 配置用 api_url（完整聊天端点，如 GPUStack / 各类 OpenAI 兼容网关）；
          // openai 用 base_url + /chat/completions
          const endpoint = resolvedConfig?.api_url
            ? AIUtils.buildCustomChatEndpoint(resolvedConfig.api_url)
            : `${stripTrailing(resolvedConfig?.base_url)}/chat/completions`
          p = AIUtils.makeAPIRequest(
            endpoint,
            body,
            authHeaders(resolvedConfig?.api_key),
            callbacks,
          )
          break
        }
        // DeepSeek 单来源：接口样式决定用 Chat Completions 还是 Responses API
        // （'deepseek-responses' 为已合并的历史别名，仅作兜底）
        case 'deepseek-responses':
        case 'deepseek': {
          const isResponsesStyle = provider === 'deepseek-responses' || resolvedConfig?.api_style === 'responses'
          if (isResponsesStyle) {
            const body: any = AIUtils.buildDeepSeekResponsesRequest(resolvedConfig, llmConfig, messages, {
              tools,
              toolChoice: 'auto',
            })
            p = AIUtils.makeDeepSeekResponsesRequest(
              `${stripTrailing(resolvedConfig?.base_url)}/responses`,
              body,
              authHeaders(resolvedConfig?.api_key),
              callbacks,
            )
          } else {
            const body: any = AIUtils.buildOpenAIRequest(resolvedConfig, llmConfig, messages)
            if (tools.length) {
              body.tools = tools
              body.tool_choice = 'auto'
            }
            p = AIUtils.makeAPIRequest(
              `${stripTrailing(resolvedConfig?.base_url)}/chat/completions`,
              body,
              authHeaders(resolvedConfig?.api_key),
              callbacks,
            )
          }
          break
        }
        case 'azure': {
          const body: any = AIUtils.buildOpenAIRequest(resolvedConfig, llmConfig, messages)
          if (tools.length) {
            body.tools = tools
            body.tool_choice = 'auto'
          }
          const ep = `${stripTrailing(resolvedConfig?.endpoint)}/openai/deployments/${resolvedConfig?.deployment}/chat/completions?api-version=${resolvedConfig?.api_version || '2024-02-15-preview'}`
          p = AIUtils.makeAPIRequest(ep, body, authHeaders(resolvedConfig?.api_key), callbacks)
          break
        }
        case 'gpustack': {
          // GPUStack：OpenAI 兼容端点（裸地址自动补 /v1-openai/chat/completions）
          const body: any = AIUtils.buildOpenAIRequest(resolvedConfig, llmConfig, messages)
          if (tools.length) {
            body.tools = tools
            body.tool_choice = 'auto'
          }
          const endpoint = AIUtils.buildCustomChatEndpoint(resolvedConfig?.base_url || resolvedConfig?.api_url || '')
          p = AIUtils.makeAPIRequest(endpoint, body, authHeaders(resolvedConfig?.api_key), callbacks)
          break
        }
        default:
          throw new Error(`agent 循环暂不支持的 provider: ${provider}`)
      }

      try {
        await p
        // 空流重试：200 但整轮未产出任何内容/工具/推理——远程自托管服务在高并发下可能被
        // 静默丢弃直接返回空流，这里自动按瞬态再试一次，避免被误判成“正常空结果”
        if (!content && toolCalls.length === 0 && !reasoning && SELFHOSTED_PROVIDERS.has(provider) && attempt < MAX_LLM_RETRY - 1) {
          const delay = 500 * Math.pow(2, attempt)
          console.warn(`[agent] LLM 返回空流（${provider}，第 ${attempt + 1} 次，tools=${tools.length}），${delay}ms 后重试`)
          await new Promise((r) => setTimeout(r, delay))
          continue
        }
        // 诊断：每次 LLM 步骤结果摘要（便于定位“模型返回为空”是空流 / 只有工具 / 解析丢失）
        console.info(`[agent-result] ${this.id} provider=${provider} tools=${tools.length} attempt=${attempt} content=${(content || '').length} toolCalls=${toolCalls.length} reasoning=${(reasoning || '').length} finish=${finishReason || '-'} usage=${stepUsage ? (stepUsage.totalTokens ?? (stepUsage.promptTokens + stepUsage.completionTokens)) : '-'}`)
        if (finishReason === 'length') {
          // 被 max_tokens / 模型上下文截断：正文可能为空或不完整，明确告警而不是静默当作正常完成
          console.warn(`[agent] LLM 输出被截断（finish_reason=length，provider=${provider}，正文 ${(content || '').length} 字符）：请增大 max_tokens，或在本地推理服务中提高模型加载的上下文长度`)
        }
        return { content, toolCalls, reasoning, usage: stepUsage, finishReason }
      } catch (err: any) {
        const msg = err?.message || String(err)
        // 仅当失败前未产出任何内容（内容/工具/推理均为空）时重试——
        // 已产出内容说明已写入会话日志，重试会导致模型历史重复
        const clean = content === '' && toolCalls.length === 0 && !reasoning
        if (attempt < MAX_LLM_RETRY - 1 && isTransientError(msg) && clean) {
          // 指数退避：500ms / 1s / 2s / 4s / 8s，给本地后端（LM Studio / Ollama）过载或模型重载留出恢复时间
          const delay = 500 * Math.pow(2, attempt)
          console.warn(`[agent] LLM 请求失败（第 ${attempt + 1} 次，瞬态错误），${delay}ms 后重试: ${msg}`)
          await new Promise((r) => setTimeout(r, delay))
          continue
        }
        throw err
      }
    }
    // 不可达（循环内必然 return 或 throw）
    throw new Error('LLM 请求失败')
  }

  // ---------------- 工具执行 ----------------

  private async executeToolCall(call: any, step: number): Promise<void> {
    const name = String(call?.name || call?.function?.name || '')
    const callId = String(call?.id || `call-${step}-${Math.random().toString(36).slice(2, 8)}`)
    const rawArgs = call?.arguments ?? call?.function?.arguments
    const args = parseToolArgs(rawArgs)

    // 参数解析失败（normalizeToolCalls 已把畸形/截断的原文放进 `_raw`）：
    // 不再用空参数去执行工具——那会得到 "code 参数必填" 这类误导性报错（模型看不出参数是它自己
    // 输出被截断造成的，会反复重试同样的调用）。这里直接给出可诊断的失败说明。
    if (args && typeof args === 'object' && typeof args._raw === 'string') {
      const rawText = String(args._raw)
      const head = rawText.slice(0, 160)
      const tail = rawText.length > 320 ? rawText.slice(-160) : ''
      const truncHint = this.lastFinishReason === 'length'
        ? '本步输出被截断（finish_reason=length，max_tokens / 上下文长度不够）'
        : '参数 JSON 不合法或缺失'
      const error = `工具参数无法解析（${truncHint}，收到 ${rawText.length} 字符）：`
        + `原文开头「${head}」${tail ? `…结尾「${tail}」` : ''}。`
        + '请缩短一次提交的内容后重试（例如一次 run_code 只做少量步骤、大文件分段写入），并确保 JSON 字符串内的换行/引号已正确转义。'
      sessionLog.append(this.id, 'tool/call', { callId, name, args: undefined, argsRawLen: rawText.length, step })
      sessionLog.append(this.id, 'tool/result', { callId, name, ok: false, value: undefined, error })
      this.emit('tool/call', { callId, name, args: undefined, argsParseFailed: true })
      this.emit('tool/result', { callId, name, ok: false, value: undefined, error })
      return
    }

    sessionLog.append(this.id, 'tool/call', { callId, name, args, step })
    this.emit('tool/call', { callId, name, args })

      // 引擎级白名单守卫：即使模型试图调用未启用工具，也直接返回失败而不是执行
      const toolWhitelist = this.options.tools
      if (toolWhitelist !== null && Array.isArray(toolWhitelist) && !toolWhitelist.includes(name as any)) {
        const result: ToolResult = { ok: false, error: `工具 ${name} 未启用（不在当前工具白名单中）` }
        sessionLog.append(this.id, 'tool/result', { callId, name, ok: false, value: undefined, error: result.error })
        this.emit('tool/result', { callId, name, ok: false, value: undefined, error: result.error })
        return
      }

    // PTC（Code Mode）呈现坍缩守卫：坍缩后模型可见的只有 run_code，
    // 直接点名其它工具（幻觉 / 从技能文档或历史里知道的名字）一律拒绝并指出正确写法。
    // 程序内的子调用走 SDK → toolRegistry.execute，不经过本函数，因此天然豁免
    // （对齐 DSH：model-direct 调用只能点名 run_code，子调用 bypass collapse）。
    if (this.options.toolsPresentation === 'code' && name !== 'run_code') {
      const error = `PTC（代码模式）下不能直接调用 ${name}：请把该调用写进 run_code 程序的 tools 里`
        + `（程序内 await tools.${name}({ ... })）`
      sessionLog.append(this.id, 'tool/result', { callId, name, ok: false, value: undefined, error })
      this.emit('tool/result', { callId, name, ok: false, value: undefined, error })
      return
    }


    // 引擎级防死循环：同一技能重复加载 → 直接返回"继续执行"提示，不再执行加载
    let result: ToolResult
    if (name === 'skill') {
      const skillName = String(args?.name ?? '').trim()
      // 禁用技能：拒绝加载（技能管理开关关闭的）
      const disabledSkills = this.options.disabledSkills || []
      if (skillName && disabledSkills.includes(skillName)) {
        result = {
          ok: false,
          error: `技能「${skillName}」已禁用，禁止加载（可在技能管理中启用）`,
        }
      } else if (skillName && this.loadedSkills.has(skillName)) {
        result = {
          ok: true,
          value: `技能「${skillName}」已在之前的步骤中加载过。请立即按已获得的技能指令继续执行任务（生成代码用 run_python 执行），不要再次调用 skill 工具。`,
        }
      } else {
        result = await toolRegistry.execute(name, args, this.ctx())
        // 只有加载成功才记入「已加载」：失败（技能名不存在等）不能占用这个名字，
        // 否则模型按报错改正名字后重试时会被误判为「已加载过」而拿不到技能指令。
        if (skillName && result.ok) this.loadedSkills.add(skillName)
      }
    } else {
      result = await toolRegistry.execute(name, args, this.ctx())
    }

    sessionLog.append(this.id, 'tool/result', {
      callId,
      name,
      ok: result.ok,
      value: result.value,
      error: result.error,
      preview: result.preview,
    })
    this.emit('tool/result', {
      callId,
      name,
      ok: result.ok,
      value: result.value,
      error: result.error,
      preview: result.preview,
    })
  }

  private ctx(): ToolExecutionContext {
    return {
      agentId: this.id,
      sessionId: this.id,
      scope: this.options.scope,
      cwd: this.options.cwd,
        // 当前 agent 的工具白名单（供 run_subagent 等工具继承父级配置）
        tools: this.options.tools,
        // 群成员注册表（swarm 注入；run_subagent(member) 以成员设定建子代理）
        swarmMembers: (this.options as any)?.swarmMembers,
        // 子代理嵌套深度与调用链（tools.ts runSubagent 递归守卫读取）
        swarmDepth: (this.options as any)?.swarmDepth,
        swarmChain: (this.options as any)?.swarmChain,
      signal: this.turnController?.signal,
      sandboxMode: (this.options as any).sandboxMode,
      // 技能管理中关闭的技能（skill 工具加载时校验）
      disabledSkills: this.options.disabledSkills || [],
      // 预设模式的知识库候选范围与召回数（kb_search 工具读取）
      kbPaths: this.options.kbPaths,
      kbTopK: this.options.kbTopK,
        // MCP 配置（mcp_call 工具读取）
        mcpServerId: this.options.mcpServerId,
        mcpServerConfig: this.options.mcpServerConfig,
        mcpEquipmentIds: this.options.mcpEquipmentIds,
          mcpServerIds: this.options.mcpServerIds,
          mcpServerConfigs: this.options.mcpServerConfigs,
    }
  }

  // ---------------- 事件 ----------------

  private emit<K extends AgentEventType>(type: K, payload: AgentEventMap[K]): void {
    broadcast?.({ agentId: this.id as any, type, payload } as AgentEvent)
  }

  private emitStatus(): void {
    this.emit('agent/status', { status: this._status })
  }

  toSummary(): AgentSummary {
    return {
      id: this.id as any,
      status: this._status,
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
      plan: this._plan,
      todos: this._todos,
      lastError: this.lastError,
      lastAssistantContent: this.lastAssistantContent,
    }
  }

  // ---------------- plan / todos（update_plan、update_todo 工具） ----------------

  setPlan(plan: string | null): void {
    this._plan = plan
    this.emit('agent/plan', { plan })
  }

  getTodos(): TodoItem[] {
    return this._todos
  }

  setTodos(todos: TodoItem[]): void {
    this._todos = Array.isArray(todos) ? todos : []
    this.emit('agent/todos', { todos: this._todos })
  }

  setError(message: string): void {
    this.lastError = message
  }

  /**
   * 凭据接缝（路线图 2.3）：把配置中的 `apiKeyRef`（凭据名）解析为主进程
   * 受保护存储中的明文；内联 `api_key` 原样保留（向后兼容）。
   */
  private resolveConfigWithCredential(config: any): any {
    if (!config || typeof config !== 'object') return config
    const ref = config.apiKeyRef
    if (typeof ref === 'string' && ref.trim() && !config.api_key) {
      const value = credentialStore.resolveValue(ref.trim())
      if (value) return { ...config, api_key: value }
      console.warn(`[agent] 凭据 "${ref}" 不存在或为空，请求将不带 api_key`)
    }
    return config
  }
}

// ---------------------------------------------------------------------------
// Agent 管理器
// ---------------------------------------------------------------------------

const agents = new Map<string, AgentImpl>()

// 子代理接缝（路线图 2.6）：parentId → 活跃子代理 id 集合；父销毁时级联销毁
const childAgents = new Map<string, Set<string>>()

/** 创建 agent（异步驱动立即启动，返回控制句柄） */
export function createAgent(options: AgentOptions): AgentControl {
  // 远端自托管并发基准随 agent 的 llm 通用配置同步（未携带该字段则不改变当前值）
  setRemoteBackendMaxInflight(options?.llmConfig?.remoteMaxInflight)
  const agent = new AgentImpl(options)
  agents.set(agent.id, agent)
  if (options.parentId) {
    let children = childAgents.get(options.parentId)
    if (!children) {
      children = new Set()
      childAgents.set(options.parentId, children)
    }
    children.add(agent.id)
  }
  agent.drive()
  return agent
}

/** 按 id 取 agent */
export function getAgent(id: string): AgentControl | undefined {
  return agents.get(id)
}

/** 列出全部活跃 agent */
export function listAgents(): AgentSummary[] {
  return Array.from(agents.values()).map((a) => a.toSummary())
}

/** 终止并注销 agent */
export async function disposeAgent(id: string): Promise<void> {
  const agent = agents.get(id)
  if (agent) {
    // 子代理接缝：先销毁子代理（含孙代理），再销毁父代理
    const children = childAgents.get(id)
    if (children && children.size > 0) {
      for (const childId of Array.from(children)) {
        await disposeAgent(childId)
      }
      childAgents.delete(id)
    }
    await agent.dispose()
  }
  // 清理父引用（若自身是子代理，从父的集合中移除）
  for (const [, children] of childAgents) {
    children.delete(id)
  }
}

/** 注册后生效的作用域工具名（供 UI 展示可见工具） */
export function listAgentTools(agentId: string, scope?: string): { name: ToolName; description: string }[] {
  const agent = agents.get(agentId)
  const defs = toolRegistry.list(agent?.options.scope ?? scope)
  const whitelist = agent?.options.tools
  const selected = whitelist === null ? defs : defs.filter((d) => whitelist?.includes(d.name))
  return selected.map((d) => ({ name: d.name, description: d.description }))
}

// ---------------------------------------------------------------------------
// ask_user 问答接缝（对齐 DSH user-questions seam）
// ---------------------------------------------------------------------------

interface PendingQuestion {
  askId: string
  question: string
  resolve: (answer: string) => void
  reject: (reason?: any) => void
}

const pendingQuestions = new Map<string, Map<string, PendingQuestion>>()

/**
 * 请求用户回答（ask_user 工具调用）。返回的 Promise 挂起，直到渲染进程
 * 通过 agent:answer IPC 回复；agent dispose 时 reject 全部挂起问题。
 */
export function requestAnswer(agentId: string, question: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const askId = `ask-${randomUUID()}`
    let map = pendingQuestions.get(agentId)
    if (!map) {
      map = new Map()
      pendingQuestions.set(agentId, map)
    }
    map.set(askId, { askId, question, resolve, reject })
    emitTo(agentId, 'agent/question', { askId, question })
  })
}

/** 渲染进程回复问题（agent:answer） */
export function resolveAnswer(agentId: string, askId: string, answer: string): boolean {
  const map = pendingQuestions.get(agentId)
  const p = map?.get(askId)
  if (!p) return false
  map!.delete(askId)
  p.resolve(answer)
  return true
}

/** 销毁 agent 时 reject 全部挂起问题（防止悬挂 Promise） */
function rejectPendingQuestions(agentId: string, reason: string): void {
  const map = pendingQuestions.get(agentId)
  if (!map) return
  for (const p of map.values()) {
    p.reject(new Error(reason))
  }
  pendingQuestions.delete(agentId)
}

// ---------------------------------------------------------------------------
// 渲染层任务接缝（主进程工具 → 渲染进程执行浏览器侧工作，如 Word 导出）
//
// 有些工具需要 DOM / MathJax / canvas 等只有渲染进程具备的能力（典型：把 Markdown
// 导出为 .docx）。主进程无法自行完成，故：广播 `agent/renderer-task` → 任一渲染窗口
// claim（先到先得，避免多窗口重复执行）→ 执行 → 经 `agent:renderer-result` 回传结果。
// ---------------------------------------------------------------------------

interface PendingRendererTask {
  taskId: string
  kind: string
  claimed: boolean
  resolve: (result: any) => void
  reject: (reason?: any) => void
  timer: NodeJS.Timeout
}

const pendingRendererTasks = new Map<string, Map<string, PendingRendererTask>>()

/**
 * 请求渲染进程执行一项任务，Promise 挂起到渲染层回传结果。
 * 无人 claim（窗口全部关闭 / 未初始化接缝）或超时 → reject（默认 3 分钟）。
 */
export function requestRendererTask(agentId: string, kind: string, payload: any, timeoutMs = 3 * 60 * 1000): Promise<any> {
  return new Promise<any>((resolve, reject) => {
    const taskId = `rtask-${randomUUID()}`
    let map = pendingRendererTasks.get(agentId)
    if (!map) {
      map = new Map()
      pendingRendererTasks.set(agentId, map)
    }
    const timer = setTimeout(() => {
      map!.delete(taskId)
      reject(new Error('渲染层未响应（可能所有窗口都不可执行该任务）'))
    }, timeoutMs)
    map.set(taskId, { taskId, kind, claimed: false, resolve, reject, timer })
    emitTo(agentId, 'agent/renderer-task', { taskId, kind, payload })
  })
}

/** 渲染进程抢占任务：第一个 claim 成功的窗口负责执行，其余窗口忽略（返回 false） */
export function claimRendererTask(agentId: string, taskId: string): boolean {
  const t = pendingRendererTasks.get(agentId)?.get(taskId)
  if (!t || t.claimed) return false
  t.claimed = true
  return true
}

/** 渲染进程回传任务结果：{ ok:false, error } 转为 reject，其余 resolve(value) */
export function resolveRendererTask(agentId: string, taskId: string, result: any): boolean {
  const map = pendingRendererTasks.get(agentId)
  const t = map?.get(taskId)
  if (!t) return false
  clearTimeout(t.timer)
  map!.delete(taskId)
  if (result && result.ok === false) t.reject(new Error(String(result.error || '渲染层任务执行失败')))
  else t.resolve(result?.value !== undefined ? result.value : result)
  return true
}

/** 销毁/取消 agent 时 reject 全部挂起任务（防止工具调用悬挂） */
function rejectPendingRendererTasks(agentId: string, reason: string): void {
  const map = pendingRendererTasks.get(agentId)
  if (!map) return
  for (const t of map.values()) {
    clearTimeout(t.timer)
    t.reject(new Error(reason))
  }
  pendingRendererTasks.delete(agentId)
}

// ---------------------------------------------------------------------------
// 管理器对外扩展（供 tools.ts 的工具实现调用）
// ---------------------------------------------------------------------------

/** 读取 agent 完整状态（agent:state） */
export function getAgentState(id: string): AgentStateView | undefined {
  return agents.get(id)?.toStateView()
}

/** 读取 agent 最近一次 assistant 完整内容（工具/工作流取结果用：比从日志重建更可靠） */
export function getAgentLastContent(id: string): string {
  return agents.get(id)?.lastContent || ''
}

/**
 * 工作流智能体节点用：创建 agent → 发送输入 → 等待收敛 → 返回最后一次 assistant 内容。
 * 附超时（默认 10 分钟），超时自动取消并返回。无论成败都销毁该临时 agent。
 */
export async function runAgentAndAwait(
  options: AgentOptions,
  input: string,
  timeoutMs = 10 * 60 * 1000,
): Promise<{ content: string; error?: string; timedOut: boolean; turn: number }> {
  const agent = createAgent(options) as unknown as AgentImpl
  const before = agent.currentTurn
  agent.send(String(input ?? ''))
  const started = Date.now()
  try {
    while (Date.now() - started < timeoutMs) {
      const s = agent.status
      if (s === 'disposed') break
      // 任务已推进且收敛到 idle → 完成
      if (s === 'idle' && agent.currentTurn > before) break
      await new Promise((r) => setTimeout(r, 60))
    }
  } finally {
    if (agent.status !== 'idle' && agent.status !== 'disposed') {
      agent.cancel('timeout', { keepInbox: true })
    }
  }
  const timedOut = Date.now() - started >= timeoutMs
  const state = agent.toStateView()
  const content = agent.lastContent || ''
  await disposeAgent(agent.id)
  return { content, error: state.lastError, timedOut, turn: state.turn }
}

/** update_plan 工具：设置执行计划并广播 */
export function setAgentPlan(agentId: string, plan: string | null): boolean {
  const agent = agents.get(agentId)
  if (!agent) return false
  agent.setPlan(plan)
  return true
}

/** update_todo 工具：设置待办清单并广播 */
export function setAgentTodos(agentId: string, todos: TodoItem[]): boolean {
  const agent = agents.get(agentId)
  if (!agent) return false
  agent.setTodos(todos)
  return true
}
