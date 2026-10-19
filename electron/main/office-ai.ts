/**
 * Office 编辑器 AI / 环境桥（主进程）
 *
 * 背景：内嵌的 GenOffice 编辑器把「模型、主题、语言、知识库」都当作**宿主注入的能力**
 * （见 docs/plan/Word 展示与编辑-落地方案（借鉴 GenOffice）.md 附录 C）。它自己那套设置与
 * 账号体系我们不使用，因此由本模块接管它请求的全部通道：
 *
 *   模型    ai:get-settings / ai:set-settings / ai:chat / ai:stream / ai:stream-cancel
 *   账号    ai:gsk-status（固定未登录）、ai:web-search / ai:image-search（空结果）
 *   知识库  kb:list / kb:search / kb:read（实现后编辑器 AI 面板会自动出现检索工具）
 *   环境    app:get-theme / app:get-document-theme / app:get-language /
 *           app:get-auto-save-default / app:get-ai-panel-prefs(+set)
 *   云项目  project:*（本地优先，返回空）
 *
 * 模型配置由渲染层推送（AI-KM 的模型配置存在渲染层的 store 里）：
 *   渲染层 buildOfficeAiConfig() → ipcRenderer.invoke('office:set-ai-config', cfg)
 *   主进程只负责把请求转成 OpenAI 兼容 / Ollama 两种线协议，并把增量回推给编辑器。
 *
 * 为什么自己实现流式客户端：编辑器要的是「OpenAI 形状的增量 + 工具调用分片」，
 * 而 AI-KM 主进程的 ai-service 面向自家会话与日志（spec 形状不同），直接复用会把两套
 * 会话模型耦合在一起；这里的实现约 150 行且完全受控。
 */
import { ipcMain, nativeTheme, type WebContents } from 'electron'
import { logInfo } from './log'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { viewInfoOfWebContents } from './office-host'
import { docxToMarkdown } from './office/docx-to-markdown'
import { sessionLog } from './session-log'

// ==================== 状态 ====================

export interface OfficeAiConfig {
  /** 线协议：openai = OpenAI 兼容 /chat/completions；ollama = 原生 /api/chat */
  kind: 'openai' | 'ollama'
  endpoint: string
  apiKey: string
  model: string
  /** 模型显示名（编辑器模型选择器用） */
  label: string
  /** 来源类型（ollama / openai / custom …），仅用于展示与排障 */
  provider: string
}

const state = {
  ai: null as OfficeAiConfig | null,
  /** 渲染层推送的界面环境（编辑器要跟随宿主主题与语言） */
  locale: 'zh-CN',
  dark: nativeTheme.shouldUseDarkColors,
  /**
   * 编辑器内的 AI 面板偏好（上游会读；这里原样存取，只把「默认展开」改成「默认收起」）。
   *
   * `openInNewDocs: false` —— 打开 Word / Excel / PPT 时左侧 AI 面板默认是**收起**的。
   * 上游的默认值是 true，且会叠加 localStorage 里记住的上次状态（`aiPanelInitiallyOpen()`），
   * 于是每个新文档一打开就把左侧一大块宽度交给 AI 面板；而 AI-KM 的文件窗口本身还有
   * 标签栏 / 工具栏，正文区被挤得很窄。置 false 后上游的 `aiPanelInitiallyOpen()` 恒为收起，
   * 用户仍可随时点 AI 入口展开，只是不再记住「上次是展开的」。
   */
  aiPanelPrefs: { openInNewDocs: false } as Record<string, unknown>,
  /** 进行中的流：requestId → 中止句柄 */
  streams: new Map<string, { abort: AbortController; sender: WebContents }>(),
  initialized: false,
}

/** 渲染层推送模型配置（OfficeView 挂载与模型切换时调用） */
export function setOfficeAiConfig(cfg: OfficeAiConfig | null) {
  if (!cfg || !cfg.endpoint || !cfg.model) {
    state.ai = null
    return
  }
  state.ai = cfg
  logInfo('main', `[office-ai] 模型已接入：${cfg.provider} · ${cfg.model}`)
}

/** 渲染层推送界面环境（主题 / 语言） */
export function setOfficeEnv(payload: { locale?: string; dark?: boolean }) {
  if (payload?.locale) state.locale = payload.locale
  if (typeof payload?.dark === 'boolean') state.dark = payload.dark
}

export function getOfficeAiState() {
  return { configured: !!state.ai, model: state.ai?.model || '', provider: state.ai?.provider || '' }
}

// ==================== 消息转换 ====================

/** 上游 AgentMessage[] → OpenAI chat messages（含 tool_calls / tool 结果往返） */
function toOpenAiMessages(system: string, messages: any[] = []): any[] {
  const out: any[] = []
  if (system) out.push({ role: 'system', content: String(system) })
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    if (m.role === 'user') {
      const images: any[] = Array.isArray(m.images) ? m.images : []
      if (images.length) {
        out.push({
          role: 'user',
          content: [
            { type: 'text', text: String(m.text || '') },
            ...images
              .filter((i: any) => i?.base64)
              .map((i: any) => ({
                type: 'image_url',
                image_url: { url: `data:${i.mime || 'image/png'};base64,${i.base64}` },
              })),
          ],
        })
      } else {
        out.push({ role: 'user', content: String(m.text || '') })
      }
    } else if (m.role === 'assistant') {
      const entry: any = { role: 'assistant', content: m.text || null }
      if (Array.isArray(m.toolCalls) && m.toolCalls.length) {
        entry.tool_calls = m.toolCalls.map((tc: any, i: number) => ({
          id: String(tc?.id || `call_${i}`),
          type: 'function',
          function: { name: String(tc?.name || ''), arguments: safeJson(tc?.input) },
        }))
      }
      // 交错思考模型需要把上一轮思考内容回传，否则工具循环里质量骤降
      if (m.reasoning) entry.reasoning_content = String(m.reasoning)
      out.push(entry)
    } else if (m.role === 'tool' && Array.isArray(m.results)) {
      for (const r of m.results) {
        out.push({
          role: 'tool',
          tool_call_id: String(r?.id || r?.name || ''),
          content: String(r?.output ?? ''),
        })
      }
    }
  }
  return out
}

/** 上游 AgentToolDef[] → OpenAI tools */
function toOpenAiTools(tools: any[] = []): any[] | undefined {
  const list = tools
    .filter((t) => t?.name)
    .map((t) => ({
      type: 'function',
      function: {
        name: String(t.name),
        description: String(t.description || ''),
        parameters:
          t.inputSchema && Object.keys(t.inputSchema).length
            ? flattenSchemaTypes(t.inputSchema)
            : { type: 'object', properties: {} },
      },
    }))
  return list.length ? list : undefined
}

/**
 * 把 JSON Schema 里的「类型数组」（`type: ["number", "null"]` 这种联合类型）压成单类型。
 *
 * 上游文档技能的工具就有这种 schema（insert_chart / edit_chart 的 values 是 `["number","null"]`），
 * 而 LM Studio 的推理引擎遇到类型数组会直接返回 500（日志：`NotImplemented: map: filter-mapping
 * not implemented`）——请求整条失败、编辑器只能显示「AI 没有返回内容」。实测压平后同一份请求
 * 恢复正常。只改发给模型的结构，不改工具本身的校验与执行。
 */
function flattenSchemaTypes(node: any): any {
  if (Array.isArray(node)) return node.map(flattenSchemaTypes)
  if (!node || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' && Array.isArray(value)) {
      const single = value.find((t) => typeof t === 'string' && t !== 'null') ?? value[0]
      if (typeof single === 'string' && single) out.type = single
      continue
    }
    out[key] = flattenSchemaTypes(value)
  }
  return out
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v ?? {})
  } catch {
    return '{}'
  }
}

// ==================== 流式请求 ====================

interface StreamCallbacks {
  onDelta(text: string): void
  onReasoning?(text: string): void
  onToolCall(call: { id: string; name: string; input: Record<string, unknown> }): void
  onUsage?(usage: { inputTokens?: number; outputTokens?: number }): void
  onStopReason?(reason: string): void
  onDone(): void
  onError(message: string, code?: string): void
}

function normalizeStopReason(r: unknown): string | undefined {
  const s = String(r || '')
  if (!s) return undefined
  if (s === 'length' || s === 'max_tokens') return 'max_tokens'
  if (s === 'tool_calls' || s === 'tool_use') return 'tool_calls'
  if (s === 'stop' || s === 'end_turn') return 'stop'
  return s
}

/** OpenAI 兼容 /chat/completions 的 SSE 流 */
async function streamOpenAiCompatible(
  cfg: OfficeAiConfig,
  body: Record<string, unknown>,
  cb: StreamCallbacks,
  signal: AbortSignal,
) {
  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: cfg.model, stream: true, ...body }),
  })
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  /** 工具调用按 index 累积（arguments 是分片流） */
  const toolAcc = new Map<number, { id: string; name: string; args: string }>()
  let stopReason: string | undefined
  let usage: { inputTokens?: number; outputTokens?: number } | undefined
  /** 可解析的 `data:` 行数；为 0 说明服务其实没在流式说话（见下方报错） */
  let dataLines = 0
  let rawHead = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      nl = buf.indexOf('\n')
      if (!line.startsWith('data:')) {
        if (!rawHead) rawHead = line.slice(0, 200)
        continue
      }
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let json: any
      try {
        json = JSON.parse(payload)
      } catch {
        if (!rawHead) rawHead = payload.slice(0, 200)
        continue
      }
      // 有的服务把错误也塞进 SSE（LM Studio 引擎报错就是 `event: error` + `data:{"error":{…}}`）：
      // 不识别就会被当成「正常结束但没内容」，编辑器只显示「AI 没有返回内容」，真实原因全丢了
      if (json.error) {
        const raw = typeof json.error === 'string' ? json.error : json.error?.message || JSON.stringify(json.error)
        throw new Error(`模型服务返回错误：${String(raw).slice(0, 300)}`)
      }
      dataLines++
      const choice = json.choices?.[0]
      const delta = choice?.delta || {}
      if (typeof delta.content === 'string' && delta.content) cb.onDelta(delta.content)
      const reasoning = delta.reasoning_content ?? delta.reasoning
      if (typeof reasoning === 'string' && reasoning && cb.onReasoning) cb.onReasoning(reasoning)
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = Number(tc.index ?? 0)
          const cur = toolAcc.get(idx) || { id: '', name: '', args: '' }
          if (tc.id) cur.id = String(tc.id)
          if (tc.function?.name) cur.name = String(tc.function.name)
          if (typeof tc.function?.arguments === 'string') cur.args += tc.function.arguments
          toolAcc.set(idx, cur)
        }
      }
      if (choice?.finish_reason) stopReason = normalizeStopReason(choice.finish_reason)
      if (json.usage) {
        usage = { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens }
      }
    }
  }

  // HTTP 200 但整条流里没有一条可解析的 data 行：本地推理服务（LM Studio 等）遇到
  // 未知端点 / 未知模型时会返回 200 + JSON 错误体（如 `{"error":"Unexpected endpoint…"}`），
  // 直接当成功会让编辑器只显示「AI 没有返回内容」，看不到真正的原因
  if (dataLines === 0) {
    // LM Studio 的错误体常常没有结尾换行，留在 buf 里，一并带出（否则报错没有线索）
    const detail = (rawHead || buf).replace(/\s+/g, ' ').trim().slice(0, 200)
    throw new Error(`模型服务未返回流式响应${detail ? `：${detail}` : ''}`)
  }

  for (const [, tc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
    if (!tc.name) continue
    let input: Record<string, unknown> = {}
    try {
      input = tc.args ? JSON.parse(tc.args) : {}
    } catch {
      input = {}
    }
    cb.onToolCall({ id: tc.id || `call_${tc.name}`, name: tc.name, input })
  }
  if (usage && cb.onUsage) cb.onUsage(usage)
  if (stopReason && cb.onStopReason) cb.onStopReason(stopReason)
  cb.onDone()
}

/** Ollama 原生 /api/chat 的 NDJSON 流 */
async function streamOllama(
  cfg: OfficeAiConfig,
  body: Record<string, unknown>,
  cb: StreamCallbacks,
  signal: AbortSignal,
) {
  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, stream: true, ...body }),
  })
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let usage: { inputTokens?: number; outputTokens?: number } | undefined
  let lines = 0
  let rawHead = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      nl = buf.indexOf('\n')
      if (!line) continue
      let json: any
      try {
        json = JSON.parse(line)
      } catch {
        if (!rawHead) rawHead = line.slice(0, 200)
        continue
      }
      lines++
      // Ollama 的失败也是 200 + `{"error":"model … not found"}`：不拦就会静默变成「没有返回内容」
      if (json.error) throw new Error(`模型服务返回错误：${String(json.error).slice(0, 200)}`)
      const msg = json.message || {}
      if (typeof msg.content === 'string' && msg.content) cb.onDelta(msg.content)
      if (typeof msg.thinking === 'string' && msg.thinking && cb.onReasoning) cb.onReasoning(msg.thinking)
      if (Array.isArray(msg.tool_calls)) {
        msg.tool_calls.forEach((tc: any, i: number) => {
          const fn = tc.function || {}
          let input: Record<string, unknown> = {}
          try {
            input = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments || {}
          } catch {
            input = {}
          }
          cb.onToolCall({ id: String(tc.id || `call_${i}`), name: String(fn.name || ''), input })
        })
      }
      if (json.prompt_eval_count !== undefined || json.eval_count !== undefined) {
        usage = { inputTokens: json.prompt_eval_count, outputTokens: json.eval_count }
      }
      if (json.done) {
        if (usage && cb.onUsage) cb.onUsage(usage)
        if (json.done_reason && cb.onStopReason) cb.onStopReason(normalizeStopReason(json.done_reason) || 'stop')
      }
    }
  }
  if (lines === 0) {
    const detail = (rawHead || buf).replace(/\s+/g, ' ').trim().slice(0, 200)
    throw new Error(`模型服务未返回流式响应${detail ? `：${detail}` : ''}`)
  }
  cb.onDone()
}

// ==================== 会话事件日志 ====================

/**
 * 编辑器里的 AI 走的是**它自己的智能体循环**（GenOffice 的 agent-core + 文档技能），
 * 不经 AI-KM 的 agent-loop / ai-service —— 桥接层只是「模型网关」。所以这里必须自己把
 * 「模型可见的事实」按同一套事件写进 sessionLog，否则编辑器里的对话在「设置 → 日志」里
 * 完全看不见（排查工具调用问题时只能去翻模型服务的日志）。
 *
 * 事件序列与 agent-loop 对齐：session/start → user/message → assistant/chunk（流式增量）
 * → assistant/message（+ toolCalls）→ 下一轮补 tool/result → turn/end。
 */
interface OfficeChatLog {
  /** 已写入日志的消息条数：每轮只补写新增的尾巴，避免重复落盘历史 */
  logged: number
  /** 面板重置对话时另开一条会话（否则日志里会出现重复轮次） */
  epoch: number
  turn: number
}
const chatLogs = new Map<string, OfficeChatLog>()

/** 当前编辑器对话（文档 + 编辑器类型）的可读来源标签，写进 user/message.source */
function chatSourceLabel(sender: WebContents): string {
  const info = viewInfoOfWebContents(sender)
  if (!info) return '内置编辑器'
  const kind = { docs: 'Word', sheets: 'Excel', slides: 'PPT' }[info.type] || info.type
  const name = info.filePath ? path.basename(info.filePath) : ''
  return name ? `${kind} 编辑器 · ${name}` : `${kind} 编辑器`
}

/**
 * 记录「本轮请求带来」的新消息（用户提问 / 上一轮的助手消息与工具结果），返回日志 id。
 * 消息数组每轮都会把全部历史重发，所以只按条数补写尾巴；数组变短说明面板重置了对话。
 */
function logOfficeIncoming(sender: WebContents, baseId: string, cfg: OfficeAiConfig, system: string, messages: any[]): string {
  const base = baseId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'session'
  let state = chatLogs.get(base)
  if (!state) {
    state = { logged: 0, epoch: 0, turn: 0 }
    chatLogs.set(base, state)
  }
  if (messages.length < state.logged) {
    sessionLog.append(state.epoch ? `${base}-${state.epoch}` : base, 'session/end', { status: 'disposed' })
    state.epoch += 1
    state.logged = 0
  }
  const logId = state.epoch ? `${base}-${state.epoch}` : base
  if (state.logged === 0) {
    sessionLog.append(logId, 'session/start', {
      provider: cfg.provider,
      model: cfg.model,
      systemPrompt: system,
      createdAt: Date.now(),
    })
  }
  const source = chatSourceLabel(sender)
  // 助手消息不从历史里记：它们都是我们自己上一轮流式回复的回声（模型网关只有一个出口），
  // 已由 logOfficeReply 实时落盘；再从历史补一次就会重复。首次请求（logged === 0）例外，
  // 例如主进程重启后面板带着完整历史重新发来，这时必须把历史补全。
  const skipAssistant = state.logged > 0
  for (const m of messages.slice(state.logged)) {
    if (!m || typeof m !== 'object') continue
    if (m.role === 'user') {
      const images = Array.isArray(m.images) ? m.images.length : 0
      sessionLog.append(logId, 'user/message', {
        content: String(m.text ?? ''),
        source,
        ...(images ? { images } : {}),
      })
    } else if (m.role === 'assistant') {
      if (skipAssistant) continue
      const toolCalls = Array.isArray(m.toolCalls)
        ? m.toolCalls.map((tc: any) => ({ id: String(tc?.id || ''), name: String(tc?.name || ''), arguments: tc?.input ?? {} }))
        : []
      sessionLog.append(logId, 'assistant/message', {
        content: String(m.text ?? ''),
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(m.reasoning ? { reasoning: String(m.reasoning) } : {}),
      })
    } else if (m.role === 'tool' && Array.isArray(m.results)) {
      for (const r of m.results) {
        sessionLog.append(logId, 'tool/result', {
          callId: String(r?.id || r?.name || ''),
          name: String(r?.name || ''),
          ok: !r?.isError,
          value: String(r?.output ?? '').slice(0, 200000),
        })
      }
    }
  }
  state.logged = messages.length
  state.turn += 1
  sessionLog.append(logId, 'turn/start', { turn: state.turn })
  return logId
}

/** 一轮流式结束：写完整助手消息 + turn/end（含错误原因，便于在日志里复盘） */
function logOfficeReply(
  logId: string,
  state: { turn: number } | undefined,
  text: string,
  reasoning: string,
  toolCalls: Array<{ id: string; name: string; arguments: any }>,
  reason: 'completed' | 'cancelled' | 'error',
  error?: string,
): void {
  if (text || reasoning || toolCalls.length) {
    sessionLog.append(logId, 'assistant/message', {
      content: text,
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(reasoning ? { reasoning } : {}),
    })
  }
  sessionLog.append(logId, 'turn/end', { turn: state?.turn ?? 0, reason, ...(error ? { error } : {}) })
}

/** 取得该日志会话的轮次状态（供 logOfficeReply 用） */
function turnStateOf(baseId: string): { turn: number } | undefined {
  const base = baseId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'session'
  return chatLogs.get(base)
}

// ==================== 通道注册 ====================

/** 把 AiSettings 形状的配置给编辑器（模型选择器据此显示 AI-KM 当前模型） */
function aiSettingsPayload(cfg: OfficeAiConfig | null) {
  const model = cfg?.model || ''
  const usable = !!cfg
  return {
    // 固定为自定义来源：编辑器只读该槽位，不弹它自己的模型设置
    provider: 'custom',
    providers: {
      custom: {
        apiKey: cfg?.apiKey || 'aikm-managed',
        model,
        baseUrl: cfg?.endpoint || '',
      },
    },
    customEndpoints: usable
      ? [
          {
            id: 'aikm-active',
            name: cfg!.label || model,
            baseUrl: cfg!.endpoint,
            apiKey: cfg!.apiKey || 'aikm-managed',
            model,
            models: [model],
          },
        ]
      : [],
    customEndpoint: usable ? 'aikm-active' : undefined,
    gskToolsEnabled: false,
    maxOutputTokens: 8192,
  }
}

export function registerOfficeAiIpc() {
  if (state.initialized) return
  state.initialized = true

  // ---- 渲染层 → 主进程：推送模型配置与界面环境 ----
  ipcMain.handle('office:set-ai-config', (_e, cfg: OfficeAiConfig | null) => {
    setOfficeAiConfig(cfg)
    return { ok: true }
  })
  ipcMain.handle('office:set-env', (_e, payload: { locale?: string; dark?: boolean }) => {
    setOfficeEnv(payload || {})
    return { ok: true }
  })
  ipcMain.handle('office:ai-state', () => getOfficeAiState())

  // ---- 环境（主题 / 语言 / 自动保存 / AI 面板偏好）----
  ipcMain.handle('app:get-theme', () => (state.dark ? 'dark' : 'light'))
  ipcMain.handle('app:get-document-theme', () => (state.dark ? 'dark' : 'light'))
  ipcMain.handle('app:get-language', () => state.locale)
  ipcMain.handle('app:get-auto-save-default', () => true)
  ipcMain.handle('app:get-ai-panel-prefs', () => state.aiPanelPrefs)
  ipcMain.handle('app:set-ai-panel-prefs', (_e, patch: Record<string, unknown>) => {
    state.aiPanelPrefs = { ...state.aiPanelPrefs, ...(patch || {}) }
    return state.aiPanelPrefs
  })

  // ---- 模型 ----
  ipcMain.handle('ai:get-settings', () => aiSettingsPayload(state.ai))
  // 编辑器不允许改宿主模型：接受写入但不落库（下次 get 仍返回宿主的）
  ipcMain.handle('ai:set-settings', () => ({ ok: true }))
  ipcMain.handle('ai:open-model-settings', () => ({ ok: false, error: '模型来自 AI-KM 设置' }))

  ipcMain.handle('ai:chat', async (event, request: any) => {
    const cfg = state.ai
    if (!cfg) return { ok: false, error: '未配置模型：请先在 AI-KM 设置中启用一个模型' }
    const system = request?.system || ''
    const user = String(request?.user || '')
    const chatBaseId = String(request?.requestId || `chat-${Date.now()}`)
    const logId = logOfficeIncoming(event.sender, chatBaseId, cfg, system, [{ role: 'user', text: user }])
    let content = ''
    let failed = ''
    try {
      await runStream(cfg, system, [{ role: 'user', text: user }], [], undefined, event.sender, {
        onDelta: (t) => (content += t),
        onToolCall: () => {},
        onDone: () => {},
        onError: (m) => (failed = m),
      })
    } catch (e) {
      failed = (e as Error)?.message || String(e)
    }
    logOfficeReply(logId, turnStateOf(chatBaseId), content, '', [], failed ? 'error' : 'completed', failed || undefined)
    return failed ? { ok: false, error: failed } : { ok: true, content }
  })

  ipcMain.handle('ai:stream', async (event, request: any) => {
    const cfg = state.ai
    const requestId = String(request?.requestId || '')
    if (!requestId) return { ok: false, error: '缺少 requestId' }
    if (!cfg) {
      event.sender.send('ai:stream-chunk', {
        requestId,
        type: 'error',
        error: '未配置模型：请先在 AI-KM 设置中启用一个模型',
      })
      return { ok: false, error: 'no-model' }
    }
    const abort = new AbortController()
    state.streams.set(requestId, { abort, sender: event.sender })

    // 会话日志：把这一轮（含上一轮的助手消息/工具结果）写进「设置 → 日志」能看到的事件流
    const system = request?.system || ''
    const messages = Array.isArray(request?.messages) ? request.messages : []
    const logBaseId = String(request?.sessionId || requestId)
    const logId = logOfficeIncoming(event.sender, logBaseId, cfg, system, messages)
    const turnState = turnStateOf(logBaseId)
    let loggedText = ''
    let loggedReasoning = ''
    const loggedToolCalls: Array<{ id: string; name: string; arguments: any }> = []

    const callbacks: StreamCallbacks = {
      onDelta: (text) => {
        loggedText += text
        sessionLog.append(logId, 'assistant/chunk', { content: text })
        push(event.sender, { requestId, type: 'delta', text })
      },
      onReasoning: (text) => {
        loggedReasoning += text
        push(event.sender, { requestId, type: 'reasoning', text })
      },
      onToolCall: (toolCall) => {
        loggedToolCalls.push({ id: toolCall.id, name: toolCall.name, arguments: toolCall.input })
        push(event.sender, { requestId, type: 'tool-call', toolCall })
      },
      onUsage: (usage) => push(event.sender, { requestId, type: 'usage', usage }),
      onStopReason: () => {},
      onDone: () => {
        push(event.sender, { requestId, type: 'done' })
        state.streams.delete(requestId)
        logOfficeReply(logId, turnState, loggedText, loggedReasoning, loggedToolCalls, 'completed')
      },
      onError: (message, code) => {
        push(event.sender, { requestId, type: 'error', error: message, errorCode: code as any })
        state.streams.delete(requestId)
        // 用户点了停止（ai:stream-cancel）→ 记成 cancelled，与 AI-KM 自己的会话日志口径一致
        const cancelled = abort.signal.aborted
        logOfficeReply(logId, turnState, loggedText, loggedReasoning, loggedToolCalls, cancelled ? 'cancelled' : 'error', cancelled ? undefined : message)
      },
    }

    // 立即回一个 ping，让渲染层确认流已建立（与上游心跳约定一致）
    push(event.sender, { requestId, type: 'ping' })

    void runStream(
      cfg,
      system,
      messages,
      Array.isArray(request?.tools) ? request.tools : [],
      request?.maxTokens,
      event.sender,
      callbacks,
      abort.signal,
    ).catch((e) => callbacks.onError((e as Error)?.message || String(e)))

    return { ok: true }
  })

  ipcMain.handle('ai:stream-cancel', (_e, requestId: string) => {
    const entry = state.streams.get(String(requestId))
    if (entry) {
      entry.abort.abort()
      state.streams.delete(String(requestId))
    }
    return { ok: true }
  })

  // ---- 账号 / 联网（未接入：返回空结果而不是报错）----
  ipcMain.handle('ai:gsk-status', () => ({ signedIn: false, provider: 'custom' }))
  ipcMain.handle('ai:gsk-login', () => ({ ok: false, error: '未启用账号登录' }))
  ipcMain.handle('ai:web-search', () => [])
  ipcMain.handle('ai:image-search', () => [])
  ipcMain.handle('ai:fetch-image', () => null)

  /**
   * 知识库工具（上游的 search_knowledge_base / read_knowledge_file 据此启用）。
   * 语料 = 当前文档所在目录（含子目录）内的可读文本文件；检索为大小写不敏感的子串匹配。
   * 引用回来的路径就是真实文件路径，编辑器会渲染成可点击的 filenav:/// 链接。
   */
  ipcMain.handle('kb:list', (event) => {
    const info = viewInfoOfWebContents(event.sender)
    if (!info) return []
    return kbList(info.filePath)
  })
  ipcMain.handle('kb:search', async (event, query: { q?: string; limit?: number } | string) => {
    const info = viewInfoOfWebContents(event.sender)
    if (!info) return []
    const q = typeof query === 'string' ? query : String(query?.q || '')
    const limit = typeof query === 'object' && query?.limit ? Number(query.limit) : 8
    return kbSearch(info.filePath, q, Math.min(Math.max(limit, 1), 20))
  })
  ipcMain.handle('kb:read', async (event, args: { path?: string; offset?: number }) => {
    const info = viewInfoOfWebContents(event.sender)
    if (!info) return { text: '', totalChars: 0, offset: 0 }
    return kbRead(info.filePath, String(args?.path || ''), Number(args?.offset || 0))
  })

  // ---- 云项目对话（本地优先：空实现）----
  ipcMain.handle('project:resolveChat', () => null)
  ipcMain.handle('project:appendChat', () => ({ ok: true }))
  ipcMain.handle('project:loadChat', () => [])
  ipcMain.handle('project:rebindChat', () => ({ ok: true }))
}

function push(sender: WebContents, chunk: Record<string, unknown>) {
  if (!sender.isDestroyed()) sender.send('ai:stream-chunk', chunk)
}

// ==================== 知识库（语料 = 当前文档所在目录树） ====================
/**
 * 上游的 KB 工具契约（knowledge-base-skill.ts）：listFiles / search / read，
 * 引用必须指向语料内的**真实文件路径**（它会把路径渲染成可点击的 filenav:/// 链接，
 * 并拒绝引用语料之外的路径来防幻觉）。
 *
 * 这里的实现刻意保持「主进程 + Node fs」这一最小依赖：
 * - 语料：当前文档所在目录（含子目录，深度受控）；
 * - 检索：大小写不敏感的子串匹配（扫描文件数与字节数都有上限，避免大目录卡死）；
 * - 取文：按扩展名分派 —— `.docx` 复用 docxToMarkdown 转 Markdown，其余按 UTF-8 文本读。
 *
 * 后续若要换成 AI-KM 的向量 / GraphRAG 检索（loadKnowledgeBase / retrieveKnowledge），
 * 只需替换 kbSearch 的实现，其余契约不变。
 */
const KB_MAX_FILES = 400
const KB_MAX_DEPTH = 2
const KB_MAX_TEXT_BYTES = 8 * 1024 * 1024
const KB_SEARCH_SCAN_FILES = 80
const KB_SEARCH_SCAN_BYTES = 256 * 1024
const KB_READ_CHUNK_CHARS = 24000
const KB_TEXT_EXTS = new Set([
  '.md', '.markdown', '.mdown', '.mkd', '.mdx', '.txt', '.log', '.rst', '.org',
  '.docx', '.csv', '.tsv', '.json', '.json5', '.yaml', '.yml', '.toml', '.ini',
  '.html', '.htm', '.xml', '.tex', '.bib', '.js', '.jsx', '.ts', '.tsx', '.vue',
  '.py', '.java', '.c', '.h', '.cpp', '.cs', '.go', '.rs', '.rb', '.php', '.sh',
  '.ps1', '.sql', '.css', '.scss',
])

interface KbFileInfo {
  path: string
  folder: string
  name: string
  ext: string
  sizeBytes: number
}

interface KbSearchHit {
  path: string
  name: string
  ext: string
  folder: string
  snippet: string
}

/** 语料根：当前文档所在目录 */
function kbRootOf(docPath: string): string {
  return docPath && fs.existsSync(docPath) ? path.dirname(docPath) : ''
}

/** 收集语料内的文本文件（深度 / 数量受控） */
function kbWalk(root: string): KbFileInfo[] {
  const out: KbFileInfo[] = []
  if (!root) return out
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  while (queue.length && out.length < KB_MAX_FILES) {
    const { dir, depth } = queue.shift()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (out.length >= KB_MAX_FILES) break
      if (e.name.startsWith('.')) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < KB_MAX_DEPTH) queue.push({ dir: full, depth: depth + 1 })
        continue
      }
      const ext = path.extname(e.name).toLowerCase()
      if (!KB_TEXT_EXTS.has(ext)) continue
      let size = 0
      try {
        size = fs.statSync(full).size
      } catch {
        continue
      }
      if (size <= 0 || size > KB_MAX_TEXT_BYTES) continue
      out.push({
        path: full,
        folder: path.basename(path.dirname(full)),
        name: e.name,
        ext: ext.replace(/^\./, ''),
        sizeBytes: size,
      })
    }
  }
  return out
}

function kbList(docPath: string): KbFileInfo[] {
  return kbWalk(kbRootOf(docPath))
}

/** 取纯文本（.docx 走统一转换；其余按 UTF-8 读，失败返回空串） */
async function kbTextOf(file: string): Promise<string> {
  const ext = path.extname(file).toLowerCase()
  try {
    if (ext === '.docx') {
      return await docxToMarkdown({ filePath: file, extractImages: false })
    }
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

async function kbSearch(docPath: string, rawQuery: string, limit: number): Promise<KbSearchHit[]> {
  const q = String(rawQuery || '').trim()
  if (!q) return []
  const needle = q.toLowerCase()
  const hits: KbSearchHit[] = []
  let scanned = 0
  for (const file of kbWalk(kbRootOf(docPath))) {
    if (hits.length >= limit || scanned >= KB_SEARCH_SCAN_FILES) break
    scanned++
    let text = await kbTextOf(file.path)
    if (!text) continue
    if (text.length > KB_SEARCH_SCAN_BYTES) text = text.slice(0, KB_SEARCH_SCAN_BYTES)
    const at = text.toLowerCase().indexOf(needle)
    if (at < 0) continue
    const from = Math.max(0, at - 120)
    const to = Math.min(text.length, at + needle.length + 160)
    hits.push({
      path: file.path,
      name: file.name,
      ext: file.ext,
      folder: file.folder,
      snippet: text.slice(from, to).replace(/\s+/g, ' ').trim(),
    })
  }
  return hits
}

async function kbRead(
  docPath: string,
  target: string,
  offset: number,
): Promise<{ text: string; totalChars: number; offset: number }> {
  const root = kbRootOf(docPath)
  const resolved = path.resolve(target || '')
  // 只允许读语料内的文件（防止模型读到目录外的任意文件）
  if (!root || !resolved.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(resolved)) {
    return { text: '', totalChars: 0, offset: 0 }
  }
  const text = await kbTextOf(resolved)
  const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0
  if (start >= text.length) return { text: '', totalChars: text.length, offset: start }
  return {
    text: text.slice(start, start + KB_READ_CHUNK_CHARS),
    totalChars: text.length,
    offset: start,
  }
}

/** 按配置的线协议分发 */
async function runStream(
  cfg: OfficeAiConfig,
  system: string,
  messages: any[],
  tools: any[],
  maxTokens: number | undefined,
  _sender: WebContents,
  cb: StreamCallbacks,
  signal?: AbortSignal,
) {
  const openaiMessages = toOpenAiMessages(system, messages)
  const toolDefs = toOpenAiTools(tools)
  const signalToUse = signal || new AbortController().signal

  if (cfg.kind === 'ollama') {
    await streamOllama(
      cfg,
      {
        messages: openaiMessages,
        ...(toolDefs ? { tools: toolDefs } : {}),
        ...(maxTokens ? { options: { num_predict: maxTokens } } : {}),
      },
      cb,
      signalToUse,
    )
    return
  }
  await streamOpenAiCompatible(
    cfg,
    {
      messages: openaiMessages,
      ...(toolDefs ? { tools: toolDefs } : {}),
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    },
    cb,
    signalToUse,
  )
}
