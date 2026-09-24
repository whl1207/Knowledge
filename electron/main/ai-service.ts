// electron/main/ai-service.ts
// 主进程 AI 会话服务
//
// 职责：
// 1. 在**主进程**执行所有 AI 网络请求（Ollama / LM Studio / OpenAI 兼容 /
//    DeepSeek（Chat / Responses 两种接口样式）/ Anthropic / Google / 自定义），渲染进程不再直连。
// 2. 按 requestId 维护会话，缓冲流式 chunk 与最终完整回答；即使渲染进程切模块
//    （home.vue 卸载 / 监听器断开）请求也继续在后台运行并完成。
// 3. 通过 ai:event 把流式事件广播给所有窗口；渲染进程可用 ai:get 随时取回
//    已缓冲的部分内容或最终完整回答（断线续传）。
// 4. 会话结果持久化到 userData/ai-sessions/<requestId>.json，应用重启后仍可恢复。
//
// IPC 通道：
//   ai:start   { requestId, spec }              -> 启动/续跑一个请求（立即返回）
//   ai:get     { requestId }                    -> 取会话快照（内存/磁盘）
//   ai:abort   { requestId }                    -> 中止（保留已生成内容）
//   ai:release { requestId }                    -> 释放会话（内存+磁盘）
//   ai:list    {}                               -> 列出所有会话快照
//   ai:check   { provider, config }             -> 连接探测
//   事件通道   ai:event  { requestId, type, ... }

import { app } from 'electron'
import { join } from 'node:path'
import * as fs from 'node:fs'
import { AIUtils, type ContextWindowProbe } from '@/shared/ai-core'
import { sessionLog } from './session-log'
import type { SessionEvent, DerivedMessage, SessionLogIntegrity } from '@/types/session-log'

export type AIProvider =
  | 'ollama'
  | 'lmstudio'
  | 'openai'
  | 'deepseek'
  | 'gpustack'
  | 'anthropic'
  | 'google'
  | 'azure'
  | 'custom'

/** DeepSeek 接口样式：chat=Chat Completions（默认）/ responses=Responses API */
export type DeepSeekApiStyle = 'chat' | 'responses'

export interface AIRequestSpec {
  provider: AIProvider
  /** DeepSeek 单来源的接口样式（provider 为 'deepseek' 时生效；缺省 = chat） */
  apiStyle?: DeepSeekApiStyle
  // ollama / lmstudio 专用：直接传配置与消息
  config?: any
  llmConfig?: any
  messages?: any[]
  // 模型可见的 system prompt（写入会话事件日志，保证可重建）
  systemPrompt?: string
  // function calling 工具定义与选择策略（OpenAI 兼容 / Ollama / LM Studio 在请求时由 options 注入）
  tools?: any[]
  toolChoice?: any
  // 其余 provider：传已构建好的请求
  endpoint?: string
  headers?: Record<string, string>
  body?: any
}

interface AISession {
  requestId: string
  provider: AIProvider
  status: 'running' | 'completed' | 'aborted' | 'error'
  content: string
  metadata?: any
  toolCalls: any[]
  searchResults: any[]
  reasoning: string
  error?: string
  createdAt: number
  updatedAt: number
  aborted?: boolean
  failed?: boolean
  completed?: boolean
  controller?: AbortController
}

export interface AISessionSnapshot {
  requestId: string
  provider: AIProvider
  status: string
  content: string
  metadata?: any
  toolCalls: any[]
  searchResults: any[]
  reasoning: string
  error?: string
  createdAt: number
  updatedAt: number
}

// ---------------- 会话存储 ----------------

const sessions = new Map<string, AISession>()

function sessionsDir(): string {
  return join(app.getPath('userData'), 'ai-sessions')
}

function ensureSessionsDir(): void {
  try { fs.mkdirSync(sessionsDir(), { recursive: true }) } catch (e) { /* ignore */ }
}

function sessionFilePath(requestId: string): string {
  return join(sessionsDir(), `${sanitizeRequestId(requestId)}.json`)
}

function sanitizeRequestId(requestId: string): string {
  // 防止路径穿越
  return requestId.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function persistSession(session: AISession): void {
  try {
    ensureSessionsDir()
    const snap = toSnapshot(session)
    fs.writeFileSync(sessionFilePath(session.requestId), JSON.stringify(snap), 'utf-8')
  } catch (e) {
    console.error('[ai] 持久化会话失败:', e)
  }
}

function loadSessionFromDisk(requestId: string): AISessionSnapshot | null {
  try {
    const file = sessionFilePath(requestId)
    if (!fs.existsSync(file)) return null
    const raw = fs.readFileSync(file, 'utf-8')
    const data = JSON.parse(raw)
    return data as AISessionSnapshot
  } catch (e) {
    return null
  }
}

function deleteSessionFromDisk(requestId: string): void {
  try {
    const file = sessionFilePath(requestId)
    if (fs.existsSync(file)) fs.unlinkSync(file)
  } catch (e) { /* ignore */ }
}

// 定期清理过期会话文件（只保留最近 24h / 上限 500 个）
function pruneOldSessions(): void {
  try {
    const dir = sessionsDir()
    if (!fs.existsSync(dir)) return
    const cutoff = Date.now() - 24 * 3600 * 1000
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => ({ f, stat: fs.statSync(join(dir, f)) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    const toDelete = files.slice(500)
    for (const file of files) {
      if (file.stat.mtimeMs < cutoff && !sessions.has(file.f.replace('.json', ''))) {
        toDelete.push(file)
      }
    }
    for (const file of toDelete) {
      try { fs.unlinkSync(join(dir, file.f)) } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
}

// ---------------- 事件广播 ----------------

type BroadcastFn = (payload: any) => void
let broadcast: BroadcastFn | null = null

export function setBroadcast(fn: BroadcastFn | null): void {
  broadcast = fn
}

function emit(type: string, requestId: string, extra: any = {}): void {
  broadcast?.({ type, requestId, ...extra })
}

// ---------------- 快照与合并 ----------------

function toSnapshot(s: AISession): AISessionSnapshot {
  return {
    requestId: s.requestId,
    provider: s.provider,
    status: s.status,
    content: s.content,
    metadata: s.metadata,
    toolCalls: s.toolCalls || [],
    searchResults: s.searchResults || [],
    reasoning: s.reasoning || '',
    error: s.error,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }
}

function mergeSearchResults(session: AISession, results: any[]): void {
  const seen = new Set((session.searchResults || []).map((r: any) => r?.url))
  for (const r of results || []) {
    if (!r?.url || !seen.has(r.url)) {
      if (r?.url) seen.add(r.url)
      session.searchResults.push(r)
    }
  }
}

/** 把一条消息内容（string 或 content blocks/parts）压成纯文本（只取文本部分） */
function messageText(content: any): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const out: string[] = []
    for (const p of content) {
      if (p == null) continue
      if (typeof p === 'string') { if (p.trim()) out.push(p); continue }
      if (typeof p.text === 'string' && p.text.trim()) out.push(p.text)
    }
    return out.join('\n')
  }
  return ''
}

/**
 * 从请求 spec 提取「模型可见的 system 指令」（会话事件日志用）。
 * 注意：普通问答走 AIUtils.sendChat → makeAPIRequest，spec 只带 provider/endpoint/body/headers，
 * **不带 spec.systemPrompt**（只有 agent 路径才显式传），所以必须从请求体里反推，
 * 否则 session/start 里看不到系统提示词，deriveMessages 也重建不出首条 system。
 * 兼容：body.messages[] / body.input[]（Responses）/ body.system（Anthropic）/ 
 *      body.systemInstruction|system_instruction（Gemini）/ body.instructions。
 */
function extractSystemPrompt(spec: AIRequestSpec): string | undefined {
  if (typeof spec.systemPrompt === 'string' && spec.systemPrompt.trim()) return spec.systemPrompt
  const pools: any[][] = []
  if (Array.isArray(spec.messages)) pools.push(spec.messages)
  const body: any = spec.body
  if (body && typeof body === 'object') {
    if (Array.isArray(body.messages)) pools.push(body.messages)
    if (Array.isArray(body.input)) pools.push(body.input)
    if (Array.isArray(body.contents)) pools.push(body.contents)
  }
  for (const pool of pools) {
    for (const m of pool) {
      if (!m || typeof m !== 'object') continue
      const role = String(m.role ?? '').toLowerCase()
      if (role !== 'system' && role !== 'developer') continue
      let text = messageText(m.content)
      if (!text.trim() && Array.isArray(m.parts)) text = messageText(m.parts) // Gemini
      if (text.trim()) return text
    }
  }
  if (!body || typeof body !== 'object') return undefined
  const direct =
    messageText(body.system) ||
    messageText(body.systemInstruction) ||
    messageText(body.system_instruction) ||
    messageText(body.instructions)
  return direct.trim() ? direct : undefined
}

/**
 * 从请求 spec 提取“本次请求对模型可见的最后一条用户内容”。
 * 兼容多种消息形态：messages[]（Ollama/LM Studio）、body.messages[]（OpenAI 兼容 /
 * Anthropic / Azure / 自定义）、body.input[]（DeepSeek Responses）、
 * body.contents[]（Gemini，内容在 parts）。
 * 原则“模型可见即已记录”：普通 req 问答的用户问题也要能落盘到会话日志。
 */
function extractUserQuestion(spec: AIRequestSpec): string | undefined {
  const pools: any[][] = []
  if (Array.isArray(spec.messages)) pools.push(spec.messages)
  const body: any = spec.body
  if (body && typeof body === 'object') {
    if (Array.isArray(body.messages)) pools.push(body.messages)
    if (Array.isArray(body.input)) pools.push(body.input)
    if (Array.isArray(body.contents)) pools.push(body.contents)
  }
  for (const pool of pools) {
    for (let i = pool.length - 1; i >= 0; i--) {
      const m = pool[i]
      if (!m || typeof m !== 'object') continue
      if (String(m.role ?? '').toLowerCase() !== 'user') continue
      let text = messageText(m.content)
      if (!text.trim() && Array.isArray(m.parts)) text = messageText(m.parts) // Gemini
      if (text.trim()) return text
    }
  }
  return undefined
}

// ---------------- 请求执行 ----------------

let persistTimer: NodeJS.Timeout | null = null

async function runSession(session: AISession, spec: AIRequestSpec): Promise<void> {
  const controller = new AbortController()
  session.controller = controller
  // 会话事件日志：本次请求的全部模型可见事实均落盘（单一事实源）
  let ended = false
  const endSession = (status: 'completed' | 'error' | 'aborted', error?: string) => {
    if (ended) return
    ended = true
    sessionLog.append(session.requestId, 'session/end', { status, error })
  }

  const callbacks: any = {
    signal: controller.signal,
    // function calling 工具定义与选择策略（由渲染进程经 spec 传入，供执行函数注入请求体）
    tools: spec.tools,
    toolChoice: spec.toolChoice,
    onStream: (chunk: string) => {
      session.content += chunk
      session.updatedAt = Date.now()
      sessionLog.append(session.requestId, 'assistant/chunk', { content: chunk })
      emit('stream', session.requestId, { chunk })
      // 节流落盘（每 2s 一次），保证崩溃/重启时尽量保留已生成内容
      if (!persistTimer) {
        persistTimer = setTimeout(() => {
          persistTimer = null
          if (session.status === 'running') persistSession(session)
        }, 2000)
      }
    },
    onSearchStatus: (info: any) => {
      if (info?.status === 'completed' && Array.isArray(info.results)) {
        mergeSearchResults(session, info.results)
      }
      session.updatedAt = Date.now()
      emit('search', session.requestId, { info })
    },
    onReasoning: (text: string) => {
      session.reasoning = text
      session.updatedAt = Date.now()
      emit('reasoning', session.requestId, { text })
    },
    onToolCalls: (calls: any[]) => {
      session.toolCalls = calls || []
      session.updatedAt = Date.now()
      // 模型发起的工具调用是模型可见事实 → 写入会话事件日志
      for (const call of session.toolCalls || []) {
        sessionLog.append(session.requestId, 'tool/call', {
          callId: String(call?.id || call?.callId || ''),
          name: String(call?.name || call?.function?.name || ''),
          args: call?.arguments ?? call?.function?.arguments ?? {},
        })
      }
      emit('toolcalls', session.requestId, { calls: session.toolCalls })
    },
    onToolCallArgs: (callId: string, name: string, argsFragment: string) => {
      emit('toolargs', session.requestId, { callId, name, argsFragment })
    },
    onComplete: (content: string, metadata?: any) => {
      if (content !== undefined && content !== null) session.content = content
      if (metadata) session.metadata = metadata
      session.completed = true
      session.updatedAt = Date.now()
      // 完整助手消息（模型可见）→ 落盘；chunk 流已记录，此处记录最终事实
      sessionLog.append(session.requestId, 'assistant/message', {
        content: session.content,
        toolCalls: session.toolCalls || [],
        reasoning: session.reasoning || undefined,
      })
    },
    onError: (err: Error) => {
      if (session.aborted) return
      session.failed = true
      session.status = 'error'
      session.error = err?.message || String(err)
      session.updatedAt = Date.now()
      endSession('error', session.error)
      persistSession(session)
      emit('error', session.requestId, { message: session.error })
    },
  }

  // 提取必需的请求字段（AIRequestSpec 均为可选，这里收敛为必填，满足严格类型检查）
  const endpoint = spec.endpoint || ''
  const headers = spec.headers || {}
  const body = spec.body
  const messages = spec.messages || []

  try {
    let p: Promise<any>
    switch (spec.provider) {
      case 'ollama':
        p = AIUtils.sendToOllama(spec.config, spec.llmConfig, messages, callbacks)
        break
      case 'lmstudio':
        p = AIUtils.sendToLMStudio(spec.config, spec.llmConfig, messages, callbacks)
        break
      case 'openai':
      case 'custom':
      case 'gpustack':
      case 'azure':
        p = AIUtils.makeAPIRequest(endpoint, body, headers, callbacks)
        break
      case 'deepseek':
        // DeepSeek 单来源：按接口样式选择请求执行器（'deepseek-responses' 已在 start() 归一为别名）
        p = spec.apiStyle === 'responses'
          ? AIUtils.makeDeepSeekResponsesRequest(endpoint, body, headers, callbacks)
          : AIUtils.makeAPIRequest(endpoint, body, headers, callbacks)
        break
      case 'anthropic':
        p = AIUtils.makeAnthropicRequest(endpoint, body, headers, callbacks)
        break
      case 'google':
        p = AIUtils.makeGoogleRequest(endpoint, body, headers, callbacks)
        break
      default:
        throw new Error(`未知的 AI provider: ${spec.provider}`)
    }
    const content = await p

    if (session.aborted) {
      session.status = 'aborted'
      endSession('aborted')
    } else if (session.failed) {
      session.status = 'error'
      // onError 已调用 endSession('error')
    } else {
      session.status = 'completed'
      if (content !== undefined && content !== null) session.content = content
      endSession('completed')
    }
    session.updatedAt = Date.now()
    persistSession(session)
    emit('done', session.requestId, {
      content: session.content,
      metadata: session.metadata,
      aborted: session.status === 'aborted',
    })
  } catch (err: any) {
    if (session.aborted || err?.name === 'AbortError') {
      session.status = 'aborted'
      session.updatedAt = Date.now()
      endSession('aborted')
      persistSession(session)
      emit('done', session.requestId, { content: session.content, aborted: true })
    } else if (session.failed) {
      // onError 已发射 error 事件并落盘 session/end
      session.status = 'error'
      session.updatedAt = Date.now()
      persistSession(session)
    } else {
      session.status = 'error'
      session.error = err?.message || String(err)
      session.updatedAt = Date.now()
      endSession('error', session.error)
      persistSession(session)
      emit('error', session.requestId, { message: session.error })
    }
  } finally {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null }
    session.controller = undefined
  }
}

// ---------------- 对外操作 ----------------

/**
 * 归一请求 spec：'deepseek-responses' 是已合并的 DeepSeek 历史别名
 * → provider='deepseek' + apiStyle='responses'（单来源 + 接口样式）。
 */
function normalizeSpec(spec: any): AIRequestSpec {
  const s = spec || {}
  if (String(s.provider || '') === 'deepseek-responses') {
    return { ...s, provider: 'deepseek', apiStyle: 'responses' }
  }
  return s as AIRequestSpec
}

/** 启动（或幂等续跑）一个会话。requestId 相同且已在运行时不重复发起。 */
export async function start(payload: { requestId: string; spec: AIRequestSpec }): Promise<{ success: boolean; error?: string }> {
  const { requestId } = payload || {}
  const spec = normalizeSpec(payload?.spec)
  if (!requestId) return { success: false, error: '缺少 requestId' }
  if (!spec?.provider) return { success: false, error: '缺少 provider' }

  const existing = sessions.get(requestId)
  if (existing && (existing.status === 'running')) {
    // 已在运行（可能是断线续传时重复 start），直接复用
    return { success: true }
  }

  const session: AISession = {
    requestId,
    provider: spec.provider,
    status: 'running',
    content: existing?.content || '',
    metadata: existing?.metadata,
    toolCalls: existing?.toolCalls || [],
    searchResults: existing?.searchResults || [],
    reasoning: existing?.reasoning || '',
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
  }
  sessions.set(requestId, session)
  // 会话事件日志：新会话写 session/start（模型可见的 system prompt 一并落盘）
  if (!existing) {
    sessionLog.append(requestId, 'session/start', {
      provider: spec.provider,
      model: spec.llmConfig?.model || spec.config?.model,
      systemPrompt: extractSystemPrompt(spec),
      createdAt: Date.now(),
    })
    // 用户问题（本次请求对模型可见的最后一条 user 内容）一并落盘：
    // 否则普通 req 问答的派生消息里看不到用户提问
    const question = extractUserQuestion(spec)
    if (question) {
      sessionLog.append(requestId, 'user/message', { content: question })
    }
  }
  // 清理过期的已完成/出错会话（内存），防止长期运行内存增长；
  // 磁盘文件仍保留 24h（pruneOldSessions），应用重启后仍可通过 ai:get 恢复
  const now = Date.now()
  for (const [rid, s] of sessions) {
    if (s !== session && s.status !== 'running' && now - s.updatedAt > 30 * 60 * 1000) {
      sessions.delete(rid)
    }
  }
  pruneOldSessions()
  // 异步执行，不阻塞 IPC 返回
  runSession(session, spec).catch((e) => console.error('[ai] 会话执行异常:', e))
  return { success: true }
}

/** 获取会话快照（内存优先，其次磁盘持久化文件） */
export async function get(requestId: string): Promise<AISessionSnapshot | null> {
  if (!requestId) return null
  const s = sessions.get(requestId)
  if (s) return toSnapshot(s)
  const disk = loadSessionFromDisk(requestId)
  if (disk) {
    // 磁盘上的 running 会话说明主进程在流式中途退出（应用重启），无法真正续跑，
    // 降级为 aborted，让前端保留已生成的部分内容作为最终结果
    if (disk.status === 'running') disk.status = 'aborted'
    return disk
  }
  return null
}

/** 中止会话（保留已生成内容，后续由 runSession 发射 done(aborted)） */
export async function abort(requestId: string): Promise<{ success: boolean; error?: string }> {
  const s = sessions.get(requestId)
  if (!s) return { success: false, error: '会话不存在' }
  if (s.status === 'running') {
    s.aborted = true
    s.controller?.abort()
  }
  return { success: true }
}

/** 释放会话（内存 + 磁盘），通常在渲染进程确认已消费最终结果后调用 */
export async function release(requestId: string): Promise<{ success: boolean }> {
  sessions.delete(requestId)
  deleteSessionFromDisk(requestId)
  // 会话事件日志一并释放
  sessionLog.remove(requestId)
  return { success: true }
}

/** 列出所有会话快照（内存 + 磁盘） */
export async function list(): Promise<AISessionSnapshot[]> {
  const out: AISessionSnapshot[] = []
  for (const s of sessions.values()) out.push(toSnapshot(s))
  try {
    const dir = sessionsDir()
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue
        const id = f.replace('.json', '')
        if (sessions.has(id)) continue
        const snap = loadSessionFromDisk(id)
        if (snap) out.push(snap)
      }
    }
  } catch (e) { /* ignore */ }
  return out
}

/** 连接探测（走主进程，渲染进程不再直连） */
export async function check(payload: { provider: string; config: any; apiStyle?: DeepSeekApiStyle }): Promise<any> {
  const { provider, config } = payload || {}
  // DeepSeek 单来源：按接口样式探测（兼容历史 provider 别名）
  const dsResponsesStyle = payload?.apiStyle === 'responses' || provider === 'deepseek-responses'
  try {
    switch (provider) {
      case 'ollama': return await AIUtils.checkOllamaConnection(config)
      case 'lmstudio': return await AIUtils.checkLMStudioConnection({ base_url: config?.base_url, model: config?.model })
      case 'openai': return await AIUtils.checkOpenAIConnection(config)
      case 'deepseek':
      case 'deepseek-responses':
        return dsResponsesStyle
          ? await AIUtils.checkDeepSeekResponsesConnection(config)
          : await AIUtils.checkOpenAIConnection(config)
      case 'custom': return await AIUtils.checkCustomConnection(config)
      case 'deepseek-balance': return await AIUtils.fetchDeepSeekBalance(config)
      case 'anthropic': return await AIUtils.checkAnthropicConnection(config)
      case 'google': return await AIUtils.checkGoogleConnection(config)
      case 'azure': return await AIUtils.checkAzureConnection(config)
      case 'gpustack': return await AIUtils.checkCustomConnection(config)
      default: return { online: false, error: `未知 provider: ${provider}` }
    }
  } catch (e: any) {
    console.error('[ai] 连接探测失败:', e)
    return { online: false, error: e?.message || String(e) }
  }
}

/** 读取模型真实上下文窗口（tokens）：Ollama /api/show、Google /models 可读；主进程直接 fetch（渲染进程有 CORS/CSP 限制） */
export async function fetchModelContextWindow(payload: { provider: string; config: any; model: string }): Promise<number | null> {
  const { provider, config, model } = payload || {}
  try {
    return await AIUtils.fetchModelContextWindow(provider, config || {}, model)
  } catch (e: any) {
    console.error('[ai] 读取模型上下文窗口失败:', e)
    return null
  }
}

/**
 * 同上，但带上来源可信度（loaded = 已加载实例真正生效的值 / model-file / model-max）。
 * 上层需要区分「真正生效值」与「模型上限」才能正确排序（见 src/lib/contextUsage.ts）。
 */
export async function fetchModelContextWindowDetail(payload: { provider: string; config: any; model: string }): Promise<ContextWindowProbe | null> {
  const { provider, config, model } = payload || {}
  try {
    return await AIUtils.fetchModelContextWindowDetail(provider, config || {}, model)
  } catch (e: any) {
    console.error('[ai] 读取模型上下文窗口失败:', e)
    return null
  }
}

/**
 * LM Studio 模型清单（含 type / state）：设置页用它显示「哪些模型已加载」。
 * 只有 LM Studio 有该能力（原生 /api/v0/models），其余来源不调用。
 */
export async function listLmStudioModels(payload: { config: any }): Promise<any> {
  const { config } = payload || ({} as any)
  try {
    return await AIUtils.listLmStudioModels(config || {})
  } catch (e: any) {
    console.error('[ai] 读取 LM Studio 模型清单失败:', e)
    return { online: false, models: [], native: false, error: e?.message || String(e) }
  }
}

/**
 * Ollama 模型清单（/api/tags + /api/ps + 逐模型 /api/show）：设置页「模型 → Ollama」显示模型明细与加载状态。
 * 外部服务（远程 Ollama）也走同一实现，仅 base 不同。
 */
export async function listOllamaModels(payload: { config: any }): Promise<any> {
  const { config } = payload || ({} as any)
  try {
    return await AIUtils.listOllamaModels(config || {})
  } catch (e: any) {
    console.error('[ai] 读取 Ollama 模型清单失败:', e)
    return { online: false, models: [], loaded: [], error: e?.message || String(e) }
  }
}

/** Ollama 加载 / 卸载模型（/api/generate 的 keep_alive：加载=时长，卸载=0） */
export async function ollamaModelAction(payload: { config: any; action: 'load' | 'unload'; model: string; keepAlive?: string }): Promise<any> {
  const { config, action, model, keepAlive } = payload || ({} as any)
  try {
    return await AIUtils.ollamaModelAction(config || {}, action, model, keepAlive)
  } catch (e: any) {
    console.error('[ai] Ollama 模型', action, '失败:', e)
    return { ok: false, error: e?.message || String(e) }
  }
}

// ==================== 会话事件日志桥接（单一事实源） ====================

/**
 * 读取某会话的事件流（JSONL 日志，按 seq 升序）。
 * 支持分段加载：
 * - 不传 opts → 完整事件流（兼容旧调用）；
 * - opts.limit + 无 beforeSeq → 最近 limit 条（首屏尾部窗口）；
 * - opts.limit + beforeSeq → seq < beforeSeq 的最后 limit 条（加载更早历史）。
 * UI 保真渲染 / 回放 / 审计都从这里取，而不是维护第二份消息状态。
 */
export function getSessionEvents(
  requestId: string,
  opts?: { limit?: number; beforeSeq?: number },
): SessionEvent[] {
  const limit = opts?.limit && opts.limit > 0 ? Math.floor(opts.limit) : 0
  const beforeSeq = opts?.beforeSeq && opts.beforeSeq > 0 ? Math.floor(opts.beforeSeq) : 0
  if (limit > 0) {
    return beforeSeq > 0
      ? sessionLog.readBefore(requestId, beforeSeq, limit)
      : sessionLog.readTail(requestId, limit)
  }
  return sessionLog.readAll(requestId)
}

/**
 * 从会话事件日志派生模型历史（对齐 DSH deriveMessages）。
 * 用途：恢复上下文、fork 会话、生成 transcript、调试"模型到底看到了什么"。
 */
export function deriveMessages(requestId: string): DerivedMessage[] {
  return sessionLog.deriveMessages(requestId)
}

/** 会话日志完整性校验（运行时不变式："模型可见即已记录"的近似断言） */
export function checkSessionLogIntegrity(requestId: string): SessionLogIntegrity {
  return sessionLog.assertIntegrity(requestId)
}

/**
 * 追加工具执行结果事件（供渲染进程驱动的流程使用：模型返回 tool/call 后，
 * 渲染进程执行工具，再把结果经此通道写回日志，保证模型可见事实完整）。
 * 仅允许追加 tool/result 与 user/message（其余类型由主进程自己写）。
 */
export function appendSessionEvent(
  requestId: string,
  type: 'tool/result' | 'user/message',
  payload: any,
): { success: boolean; error?: string } {
  if (!requestId) return { success: false, error: '缺少 requestId' }
  try {
    if (type === 'tool/result') {
      if (!payload?.callId || !payload?.name) return { success: false, error: 'tool/result 缺少 callId/name' }
      sessionLog.append(requestId, 'tool/result', {
        callId: String(payload.callId),
        name: String(payload.name),
        ok: !!payload.ok,
        value: payload.value,
        error: payload.error,
      })
      return { success: true }
    }
    if (type === 'user/message') {
      sessionLog.append(requestId, 'user/message', {
        content: String(payload?.content ?? ''),
        source: payload?.source,
      })
      return { success: true }
    }
    return { success: false, error: `不允许从渲染进程追加事件类型: ${type}` }
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) }
  }
}
