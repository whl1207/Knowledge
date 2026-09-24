/**
 * agentBridge.ts — Agent 循环的渲染进程桥接层
 *
 * 把 `window.dsh.agent.*`（IPC）封装为带**本地状态投影**的会话视图：
 * - 单例订阅 `agent:event`，把事件流投影为 `AgentSessionView`
 *   （status / turn / step / 流式文本 / 工具调用卡片 / plan / todos / 提问）；
 * - UI 组件订阅视图变化即可实时渲染，无需各自解析事件；
 * - 提供 create/send/steer/inject/cancel/answer/dispose 的异步封装与
 *   restore/refreshAll（页面刷新后恢复已存活的 agent）。
 *
 * 这是"聊天执行从 home.vue 拆分"的渲染侧核心：home.vue 只负责输入与消息
 * 列表，执行细节（循环/工具/状态）都在 agent 循环 + 本桥接层。
 */

import type { AgentEvent, AgentOptions, AgentStateView, AgentStatus, AgentStepUsage, TodoItem } from '@/types/agent'
import type { EditDiffPreview } from '@/shared/editDiff'
import type { PtcRunPreview } from '@/types/tool'

// ---------------------------------------------------------------------------
// 视图类型
// ---------------------------------------------------------------------------

export interface ToolCallView {
  callId: string
  name: string
  args: any
  status: 'running' | 'success' | 'error'
  result?: any
  error?: string
  /** UI 专用预览（编辑类差异 / PTC 程序内子调用入参；均不进模型上下文） */
  preview?: EditDiffPreview | PtcRunPreview
  startTime: number
  endTime?: number
  /** 工具参数原始累积串（agent/tool-args 流式累积；尽力解析为 args，失败时保留原文） */
  _argsRaw?: string
}

export interface StepView {
  turn: number
  step: number
  /** 流式增量（assistant/chunk 累积） */
  stream: string
  /** 完整内容（assistant/message 后） */
  content: string
  /** 思维链（assistant/reasoning 流式累积，全量文本） */
  reasoning: string
  toolCalls: ToolCallView[]
  startTime: number
  endTime?: number
}

export interface AgentSessionView {
  id: string
  status: AgentStatus
  label?: string
  turn: number
  step: number
  inbox: number
  plan: string | null
  todos: TodoItem[]
  /** 最近一个 turn 的步骤时间线 */
  steps: StepView[]
  currentStream: string
  pendingQuestion: { askId: string; question: string } | null
  /** 服务端联网搜索状态（deepseek-responses web_search_call 投影；仅 UI 展示） */
  searchStatus: { status: string; query?: string; results?: Array<{ title?: string; url?: string }>; visitedUrls?: string[] } | null
  /**
   * 服务端搜索事件队列（按到达顺序累积；useAgentRun 用已消费序号推进，不依赖快照对比）。
   * 事件类型：reasoning（推理全量文本快照）/ search（查询词）/ open（访问网页）/ done（结果）
   */
  searchEvents: Array<{ kind: 'reasoning' | 'search' | 'open' | 'done'; at: number; text?: string; len?: number; query?: string; url?: string; results?: Array<{ title?: string; url?: string }> }>
  lastError?: string
  disposed: boolean
  /** 本会话发出的最后一条完整 assistant 消息（供聊天区渲染） */
  lastAssistantContent: string
  /** 是否服务端搜索会话（deepseek-responses + web_search）：决定推理是否走事件队列切分思考段 */
  serverSearch: boolean
  /** 最近一步 LLM 的真实 token 用量（promptTokens = 真实上下文占用） */
  lastUsage?: AgentStepUsage
  /** 本会话累计消耗 token 数（所有 step 的 totalTokens 之和） */
  usageTotal: number
}

type Listener = (view: AgentSessionView) => void

// ---------------------------------------------------------------------------
// 桥接实现
// ---------------------------------------------------------------------------

function createView(id: string, label?: string): AgentSessionView {
  return {
    id,
    status: 'idle',
    label,
    turn: 0,
    step: 0,
    inbox: 0,
    plan: null,
    todos: [],
    steps: [],
    currentStream: '',
    pendingQuestion: null,
    searchStatus: null,
    searchEvents: [],
    disposed: false,
    lastAssistantContent: '',
    serverSearch: false,
    usageTotal: 0,
  }
}

class AgentBridge {
  private sessions = new Map<string, AgentSessionView>()
  private listeners = new Set<Listener>()
  private unsub: (() => void) | null = null
  /** 工具参数流式节流（长内容写入时合并通知，避免每 chunk 全量重渲染卡顿） */
  private toolArgsTimer: ReturnType<typeof setTimeout> | null = null

  /** 惰性订阅 agent:event（只在真正使用时订阅一次） */
  private ensureSubscribed(): void {
    if (this.unsub || !window.dsh?.agent?.onEvent) return
    this.unsub = window.dsh.agent.onEvent((ev) => this.onEvent(ev))
  }

  get available(): boolean {
    return !!window.dsh?.agent
  }

  /** 取 window.dsh.agent（不可用时抛错，fail-loud） */
  private dshAgent() {
    if (!window.dsh?.agent) {
      throw new Error('window.dsh.agent 不可用（智能体功能仅桌面版支持）')
    }
    return window.dsh.agent
  }

  /**
   * 把 options 净化为纯 JSON（structured clone 安全）。
   * 即使 preload 未同步（旧构建），这里也保证不把 Vue reactive proxy /
   * 类实例等非克隆对象送进 IPC。
   */
  private sanitizeOptions(options: AgentOptions): AgentOptions {
    try {
      return JSON.parse(JSON.stringify(options))
    } catch (e) {
      console.error('[agentBridge] options 无法 JSON 序列化:', e)
      throw new Error('智能体配置包含无法序列化的值（可能混入了响应式对象/函数）')
    }
  }

  get(id: string): AgentSessionView | undefined {
    return this.sessions.get(id)
  }

  list(): AgentSessionView[] {
    return Array.from(this.sessions.values())
  }

  /** 创建 agent 会话并返回视图 */
  async create(options: AgentOptions): Promise<AgentSessionView> {
    this.ensureSubscribed()
    const agent = this.dshAgent()
    const { id } = await agent.create(this.sanitizeOptions(options))
    const view = createView(id, options.label)
    // 注意：DeepSeek Responses 的服务端联网搜索已被官方移除（内置 web_search 被忽略），
    // 联网搜索改由本地 web_search 工具承担 → 不再存在「服务端搜索会话」的推理切分特例
    view.serverSearch = false
    this.sessions.set(id, view)
    return view
  }

  /** 页面刷新后恢复一个仍存活的 agent（从主进程拉状态） */
  async restore(id: string): Promise<AgentSessionView | undefined> {
    this.ensureSubscribed()
    const agent = this.dshAgent()
    const state: AgentStateView | undefined = await agent.state(id).catch(() => undefined)
    if (!state) return undefined
    let view = this.sessions.get(id)
    if (!view) {
      view = createView(id, state.label)
      this.sessions.set(id, view)
    }
    view.status = state.status
    view.turn = state.turn
    view.step = state.step
    view.plan = state.plan
    view.todos = state.todos
    view.inbox = state.pendingInbox
    view.lastError = state.lastError
    return view
  }

  /** 刷新全部活跃 agent 的视图（主进程 agent:list + 状态） */
  async refreshAll(): Promise<AgentSessionView[]> {
    this.ensureSubscribed()
    const agent = this.dshAgent()
    const summaries = await agent.list()
    for (const s of summaries) {
      if (!this.sessions.has(s.id)) {
        await this.restore(s.id)
      }
    }
    // 主进程已销毁的从本地清除
    const alive = new Set<string>(summaries.map((s) => s.id))
    for (const id of Array.from(this.sessions.keys())) {
      if (!alive.has(id)) this.sessions.delete(id)
    }
    return this.list()
  }

  // ---------------- 控制 ----------------

  /**
   * 发送用户任务（source 可选：区分输入来源，如 agent-batch / swarm）。
   * `images` 为多模态附图（data URL 字符串数组）——必须是字符串：
   * IPC 前会经 sanitizeOptions/structured clone，typed array 不安全。
   */
  async send(id: string, content: string, source?: string, images?: string[]): Promise<void> {
    await this.dshAgent().send(id, content, source, images)
    const view = this.sessions.get(id)
    if (view) {
      view.lastAssistantContent = ''
      view.currentStream = ''
      // 注意：不能在这里清空 view.steps。agent/turn-start 事件会在 runTurn 内
      // 与 step-start 同步顺序地统一重置 steps；若在此清空，会与「新 turn 早期
      // 事件已到达 bridge」形成竞争——第一个 step 的 assistant/message / tool/call
      // 会因 lastStep 为空而丢失，导致新任务的第 1 步（或继续后的首个步骤）显示为空。
      this.notify(id)
    }
  }

  /**
   * 运行中「转向/引导」（steer）：投递到最近 step 边界，运行中立即消费。
   * 返回是否被受理——`false` 表示该会话本轮已结束/正在停止（主进程判定，不是新任务），
   * 调用方应改为按「新任务」发送（见 useAgentRun.steerRunningAgents）。
   */
  async steer(id: string, content: string): Promise<boolean> {
    const res = await this.dshAgent().steer(id, content)
    return res?.success !== false
  }

  async inject(id: string, content: string): Promise<void> {
    await this.dshAgent().inject(id, content)
  }

  async cancel(id: string, cause?: string, keepInbox?: boolean): Promise<void> {
    await this.dshAgent().cancel(id, cause, keepInbox)
  }

  async answer(id: string, askId: string, message: string): Promise<void> {
    await this.dshAgent().answer(id, askId, message)
    const view = this.sessions.get(id)
    if (view) {
      view.pendingQuestion = null
      this.notify(id)
    }
  }

  /** PTC（Code Mode）：获取模型可见的 SDK 声明文本（scope / 能力白名单可选） */
  async getSdkDocs(scope?: string, whitelist?: string[]): Promise<string> {
    return this.dshAgent().sdkDocs(scope, whitelist)
  }

  /** 声明编排级期望并发（AgentBatch 等运行期调用：让远端模型并发跟随自身并发数） */
  async declareConcurrency(scopeId: string, concurrency: number): Promise<void> {
    try { await this.dshAgent().declareConcurrency(scopeId, concurrency) } catch { /* 无桌面/旧构建忽略 */ }
  }

  /** 撤销编排级并发声明（运行结束/停止时调用） */
  async revokeConcurrency(scopeId: string): Promise<void> {
    try { await this.dshAgent().revokeConcurrency(scopeId) } catch { /* 忽略 */ }
  }

  async dispose(id: string): Promise<void> {
    await this.dshAgent().dispose(id)
    const view = this.sessions.get(id)
    if (view) {
      view.disposed = true
      this.notify(id)
    }
  }

  // ---------------- 订阅 ----------------

  on(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(id: string): void {
    const view = this.sessions.get(id)
    if (!view) return
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(view)
      } catch (e) {
        console.error('[agentBridge] 监听器异常:', e)
      }
    }
  }

  /** 工具参数流式节流通知：合并连续的 agent/tool-args 事件，避免长内容每 chunk 全量重渲染卡顿 */
  private scheduleToolArgsNotify(id: string): void {
    if (this.toolArgsTimer) return
    this.toolArgsTimer = setTimeout(() => {
      this.toolArgsTimer = null
      this.notify(id)
    }, 50)
  }

  // ---------------- 事件投影 ----------------

  private lastStep(view: AgentSessionView): StepView | undefined {
    return view.steps[view.steps.length - 1]
  }

  private onEvent(ev: AgentEvent): void {
    let view = this.sessions.get(ev.agentId)
    if (!view) {
      // 该会话在本窗口「不知情」的情况下被创建（例：主窗口新建智能体、设置窗口里的智能体控制台已经打开，
      // 或本窗口在本控制台挂载前就已创建会话）。旧实现在这里直接 return，事件被静默丢弃，
      // 结果就是「新建的智能体不出现在控制台/列表里」。现改为先建占位视图让人看得到，再异步补齐状态。
      view = createView(ev.agentId)
      this.sessions.set(ev.agentId, view)
      void this.restore(ev.agentId).catch(() => { /* 主进程已销毁 / 旧构建无 state：保留占位视图 */ })
      this.notify(ev.agentId)
    }
    switch (ev.type) {
      case 'agent/status':
        view.status = ev.payload.status
        // turn 结束（idle）时清理挂起的提问状态（取消/异常路径的兜底）
        if (ev.payload.status === 'idle') view.pendingQuestion = null
        break
      case 'agent/turn-start':
        view.turn = ev.payload.turn
        view.steps = []
        view.lastAssistantContent = ''
        view.searchStatus = null
        view.searchEvents = []
        break
      case 'agent/step-start':
        view.step = ev.payload.step
        view.steps.push({
          turn: ev.payload.turn,
          step: ev.payload.step,
          stream: '',
          content: '',
          reasoning: '',
          toolCalls: [],
          startTime: Date.now(),
        })
        break
      case 'agent/step-end': {
        const s = this.lastStep(view)
        if (s) s.endTime = Date.now()
        const u = ev.payload.usage
        if (u) {
          view.lastUsage = u
          view.usageTotal = (view.usageTotal || 0) + (u.totalTokens || 0)
        }
        break
      }
      case 'assistant/chunk': {
        const s = this.lastStep(view)
        if (s) {
          s.stream += ev.payload.content
          view.currentStream = s.stream
        }
        break
      }
      case 'assistant/reasoning': {
        const s = this.lastStep(view)
        if (s) s.reasoning = ev.payload.text
        // 事件队列：推理全量文本快照（切分思考段用）。仅服务端搜索会话入队——
        // 普通智能体推理由 useAgentRun 的 projectSteps 聚合思考单元按 step 顺序展示；
        // 入队会触发搜索专用的思考段切分，导致思考框错序/重复/封口覆盖。
        if (view.serverSearch) {
          view.searchEvents.push({ kind: 'reasoning', at: Date.now(), text: String(ev.payload.text || ''), len: String(ev.payload.text || '').length })
        }
        break
      }
      case 'assistant/message': {
        const s = this.lastStep(view)
        if (s) {
          s.content = ev.payload.content
          s.stream = ''
          // 助手消息携带的工具调用先登记进步骤（tool/call 事件到达时按 callId 更新状态），
          // 保证工具名即使工具事件延迟/缺失也能显示
          const calls: any[] = Array.isArray((ev.payload as any).toolCalls) ? (ev.payload as any).toolCalls : []
          for (const tc of calls) {
            const callId = String(tc?.id || tc?.callId || '')
            if (!callId || s.toolCalls.some(c => c.callId === callId)) continue
            s.toolCalls.push({
              callId,
              name: String(tc?.name || tc?.function?.name || ''),
              args: tc?.arguments ?? tc?.function?.arguments ?? tc?.args ?? '',
              status: 'running',
              startTime: Date.now(),
            })
          }
        }
        view.currentStream = ''
        if (ev.payload.content) view.lastAssistantContent = ev.payload.content
        break
      }
      case 'tool/call': {
        const s = this.lastStep(view)
        if (s) {
          const callId = String(ev.payload.callId || '')
          // 该 callId 可能已由 assistant/message 预登记：存在则补齐更准确的 name/args，
          // 避免同一工具调用登记两条（后登记的 running 空结果会覆盖前一条的结果）
          const existing = s.toolCalls.find(c => c.callId === callId)
          if (existing) {
            if (ev.payload.name) existing.name = ev.payload.name
            const incoming = ev.payload.args
            const incomingEmpty = !!incoming && typeof incoming === 'object' && !Array.isArray(incoming) && Object.keys(incoming).length === 0
            const streamedRaw = String(existing._argsRaw || '')
            const keepStreamed = streamedRaw.trim().length > 0 || (typeof existing.args === 'string' && existing.args.trim().length > 0)
            // 已经流式显示出来的参数内容不被随后的空 args 覆盖：参数解析失败（主进程回退成错误提示）
            // 或网关最终 payload 丢参时，界面上已流出的代码/命令不能变成 `{}`
            if (incoming !== undefined && incoming !== null && !(incomingEmpty && keepStreamed)) existing.args = incoming
          } else {
            s.toolCalls.push({
              callId,
              name: ev.payload.name,
              args: ev.payload.args,
              status: 'running',
              startTime: Date.now(),
            })
          }
        }
        break
      }
      case 'tool/result': {
        const s = this.lastStep(view)
        const tc = s?.toolCalls.find((c) => c.callId === ev.payload.callId)
        if (tc) {
          tc.status = ev.payload.ok ? 'success' : 'error'
          tc.result = ev.payload.value
          tc.error = ev.payload.error
          // UI 专用：编辑类工具的差异预览（不含在 result/value 里，不进模型上下文）
          if (ev.payload.preview) tc.preview = ev.payload.preview
          tc.endTime = Date.now()
        }
        break
      }
      case 'agent/tool-args': {
        // 工具参数流式增量：模型生成 write_file 等长内容工具的参数期间，实时登记/更新
        // tool 单元，前端立即显示 tool-box + 流式代码内容（不再等整段参数生成完）。
        // 即使首帧 argsFragment 为空（仅带 callId/name）也先创建 tool 单元，让 tool-box 立刻出现
        const s = this.lastStep(view)
        if (s) {
          const callId = String(ev.payload.callId || '')
          const frag = String(ev.payload.argsFragment || '')
          if (!callId) break
          const existing = s.toolCalls.find((c) => c.callId === callId)
          if (existing) {
            existing.status = 'running'
            if (ev.payload.name) existing.name = ev.payload.name
            if (frag) {
              // 兼容「增量片段」（OpenAI/DeepSeek 拼接）与「全量快照」（Gemini/Ollama 覆盖）：
              // 新串是旧串的前缀扩展 → 覆盖；否则拼接
              const prev = existing._argsRaw || ''
              existing._argsRaw = frag.length > prev.length && frag.startsWith(prev) ? frag : prev + frag
              // 尽力解析为对象（JSON 未闭合时保留原始字符串，前端从原文流式提取 content）
              try { existing.args = JSON.parse(existing._argsRaw) } catch { existing.args = existing._argsRaw }
            }
          } else {
            s.toolCalls.push({
              callId,
              name: ev.payload.name || '',
              args: '',
              _argsRaw: frag,
              status: 'running',
              startTime: Date.now(),
            })
          }
        }
        // 节流通知（跳过末尾立即 notify，由节流器统一触发）
        this.scheduleToolArgsNotify(view.id)
        return
      }
      case 'agent/question':
        view.pendingQuestion = { askId: ev.payload.askId, question: ev.payload.question }
        break
      case 'agent/plan':
        view.plan = ev.payload.plan
        break
      case 'agent/todos':
        view.todos = ev.payload.todos
        break
      case 'agent/search-status':
        // 服务端联网搜索结果累积去重（同一会话多次搜索追加，不覆盖已有结果）；
        // open_page 动作的访问网址累积到 visitedUrls（思考序列展示访问了哪些网站）
        {
          const prev = view.searchStatus
          const results = prev?.results || []
          const seen = new Set(results.map((r: any) => r?.url))
          const merged = [...results]
          for (const r of ev.payload.results || []) {
            if (r?.url) {
              if (!seen.has(r.url)) { seen.add(r.url); merged.push(r) }
            } else if (!merged.includes(r)) {
              merged.push(r)
            }
          }
          const visited = prev?.visitedUrls || []
          const action = ev.payload.action
          if (action?.type === 'open_page' && action?.url) {
            // 去掉 DeepSeek 注入的会话噪声片段（#ws_call_id=xxx），仅展示干净链接
            const u = String(action.url).replace(/#ws_call_id=[^#]*$/i, '')
            if (!visited.includes(u)) visited.push(u)
            // 事件队列：访问网页
            view.searchEvents.push({ kind: 'open', at: Date.now(), url: u })
          }
          // 本次事件的查询词：searching 事件直接带 query；DeepSeek search 动作带 queries/query
          let eventQuery = ev.payload.query ? String(ev.payload.query).trim() : ''
          if (!eventQuery && action?.type === 'search') {
            const qs = Array.isArray(action.queries) ? action.queries : (action.query ? [action.query] : [])
            eventQuery = String(qs[0] || '').trim()
          }
          // 统一记录查询词（含 action 来源），保证后续 completed 的 done 事件携带同一查询词，
          // 前端才能把「搜索（查询词）」与「结果」配对到同一张卡片
          const query = eventQuery || prev?.query
          // 事件队列：搜索（searching 事件带 query，或 search 动作带 queries/query）与完成（completed 带 results + 同一查询词）
          if ((ev.payload.status === 'searching' || action?.type === 'search') && eventQuery) {
            view.searchEvents.push({ kind: 'search', at: Date.now(), query: eventQuery })
          } else if (ev.payload.status === 'completed') {
            view.searchEvents.push({ kind: 'done', at: Date.now(), results: merged, query })
          }
          view.searchStatus = {
            status: ev.payload.status,
            query,
            results: merged,
            visitedUrls: visited,
          }
        }
        break
      case 'agent/inbox':
        view.inbox = ev.payload.pending
        break
      case 'agent/error':
        view.lastError = ev.payload.message
        break
    }
    this.notify(ev.agentId)
  }
}

/** 全局单例 */
export const agentBridge = new AgentBridge()
