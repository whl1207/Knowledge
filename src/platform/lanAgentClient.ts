/**
 * lanAgentClient.ts — 局域网访客（网页端）→ 主机智能体桥的 HTTP/SSE 客户端
 *
 * 桌面端 `window.dsh.agent`（IPC）在网页端不存在，但 `agentBridge` 的会话视图
 * 投影（状态/步骤/流式文本/工具卡片/提问）是纯渲染逻辑，可以原样复用 ——
 * 只要提供一个形状相同的「传输层」。本文件就是那个传输层：
 *
 * - `POST /api/agent/create` 建会话（工具白名单 / 沙箱 / 轮数上限 / 工作区均由主机决定，
 *   本端只送 locale、附图与聊天种子历史）；
 * - `POST /api/agent/send|steer|inject|cancel|answer|dispose` 控制会话；
 * - `GET  /api/agent/events?id=…`（SSE）接收 agent 事件流，原样喂给 `agentBridge`。
 *
 * 权限说明：网页端**没有**任何本地文件 / 执行能力，全部动作都由主机按
 * 「设置 → 协作 → 权限」的白名单执行；令牌（如主机开启）经 `X-AIKM-Token`
 * 或 SSE 查询串携带（见 src/shared/lanGuest.ts）。
 */

import { LAN_AGENT_API_BASE, LAN_GUEST_TOKEN_HEADER, LAN_GUEST_TOKEN_KEY } from '@/shared/lanGuest'
import type { AgentEvent, AgentOptions, AgentStateView, AgentSummary } from '@/types/agent'

/** 主机侧能力概览（/api/agent/info） */
export interface LanAgentInfo {
  agent: boolean
  modes: string[]
  tools: Array<{ name: string; description: string }>
  skills: Array<{ name: string; description: string }>
  /** 访客可选的智能体（首位固定为通用智能体） */
  agents: Array<{ id: string; name: string }>
  maxSteps: number
  sandbox: string
  shareKb: string[]
  concurrency: { active: number; waiting: number; max: number }
  tokenRequired: boolean
  provider?: string
  model?: string
}

function readToken(): string {
  try {
    return localStorage.getItem(LAN_GUEST_TOKEN_KEY) || ''
  } catch {
    return ''
  }
}

function buildHeaders(json: boolean): Record<string, string> {
  const headers: Record<string, string> = {}
  if (json) headers['Content-Type'] = 'application/json'
  const token = readToken()
  if (token) headers[LAN_GUEST_TOKEN_HEADER] = token
  return headers
}

/** 解包主机返回的统一信封（失败抛带原因的 Error，UI 直接展示） */
async function unwrap<T>(resp: Response): Promise<T> {
  let data: any = null
  try {
    data = await resp.json()
  } catch {
    /* 非 JSON 响应（网关错误等）走下面的通用错误 */
  }
  if (!resp.ok || data?.ok === false) {
    const message = data?.error || `${resp.status} ${resp.statusText || '请求失败'}`
    throw new Error(String(message))
  }
  return data as T
}

async function postJson<T>(path: string, body: any): Promise<T> {
  const resp = await fetch(`${LAN_AGENT_API_BASE}${path}`, {
    method: 'POST',
    headers: buildHeaders(true),
    // 策略 / 智能体清单随时可能被主机改动：一律不走浏览器缓存
    cache: 'no-store',
    body: JSON.stringify(body ?? {}),
  })
  return unwrap<T>(resp)
}

/**
 * GET 请求：**必须绕开浏览器缓存**（加时间戳参数 + cache:'no-store'）。
 * 否则主机改了「可用智能体」后，网页端点开列表仍是缓存里的旧清单，只有刷新页面才更新。
 */
async function getJson<T>(path: string, query = ''): Promise<T> {
  const bust = `${query ? '&' : '?'}_t=${Date.now()}`
  const resp = await fetch(`${LAN_AGENT_API_BASE}${path}${query}${bust}`, {
    headers: buildHeaders(false),
    cache: 'no-store',
  })
  return unwrap<T>(resp)
}

// ---------------------------------------------------------------------------
// 事件流（每个会话一条 SSE）
// ---------------------------------------------------------------------------

type Listener = (ev: AgentEvent) => void

const listeners = new Set<Listener>()
/** 会话 id → SSE 连接（插入顺序 = 建立顺序，用于回收最早的连接） */
const streams = new Map<string, EventSource>()
/**
 * 同时保持的 SSE 连接上限。
 * 浏览器对同域 HTTP/1.1 连接有并发上限（约 6 个），而每轮任务都会新建一个主机会话。
 * 若旧连接迟迟不回收，后续的普通请求（如 /api/agent/info）会被排队，
 * 表现为「点了半天列表才出来」——因此这里主动限制为最多 2 条（当前 + 上一条）。
 */
const MAX_SSE_STREAMS = 2
/** 已收敛（agent/status = idle）的会话 id：新一轮建连时回收它们的 SSE */
const idleSessions = new Set<string>()

function closeStream(id: string): void {
  const source = streams.get(id)
  idleSessions.delete(id)
  if (!source) return
  streams.delete(id)
  try {
    source.close()
  } catch {
    /* 已关闭 */
  }
}

/** 回收已收敛的旧连接（保留正在运行的那些） */
function reapIdleStreams(exceptId?: string): void {
  for (const id of Array.from(idleSessions)) {
    if (id !== exceptId) closeStream(id)
  }
}

/** 超出上限时关闭最早的连接（防止同域连接被旧会话占满） */
function enforceStreamCap(): void {
  while (streams.size > MAX_SSE_STREAMS) {
    const oldest = streams.keys().next().value
    if (typeof oldest !== 'string') break
    closeStream(oldest)
  }
}

/** 会话连接断开（主机会话已不存在 / 主机停了共享）：合成收尾事件，避免网页端一直「运行中」 */
function emitSessionGone(id: string, reason: string): void {
  for (const cb of Array.from(listeners)) {
    try {
      cb({ agentId: id as any, type: 'agent/error', payload: { message: reason } } as AgentEvent)
      cb({ agentId: id as any, type: 'agent/status', payload: { status: 'idle' } } as AgentEvent)
    } catch (e) {
      console.error('[lanAgentClient] 断线收尾事件异常:', e)
    }
  }
}

function openStream(id: string): void {
  if (streams.has(id)) return
  if (typeof EventSource === 'undefined') return
  const token = readToken()
  // 时间戳防缓存：部分代理/中间层会缓存 SSE 响应导致事件收不到
  const url = `${LAN_AGENT_API_BASE}/events?id=${encodeURIComponent(id)}&_t=${Date.now()}${token ? `&token=${encodeURIComponent(token)}` : ''}`
  let source: EventSource
  try {
    source = new EventSource(url)
  } catch (e) {
    console.warn('[lanAgentClient] 事件流建立失败:', e)
    return
  }
  streams.set(id, source)
  // 连接数上限保护：关掉最早的连接（其会话若仍在跑，主机会话不受影响，只是本端不再实时刷新）
  enforceStreamCap()
  source.onmessage = (e) => {
    let ev: any = null
    try {
      ev = JSON.parse(e.data)
    } catch {
      return
    }
    // 连接建立时主机回送的会话状态快照（非 agent 事件）：只用于标记「已连接」
    if (ev?.type === 'lan/session') return
    if (!ev?.type) return
    // 收敛标记：本轮结束后该连接即可回收（多轮对话会不断新建会话）
    if (ev.type === 'agent/status' && (ev.payload?.status === 'idle' || ev.payload?.status === 'disposed')) {
      idleSessions.add(id)
    }
    for (const cb of Array.from(listeners)) {
      try {
        cb(ev as AgentEvent)
      } catch (err) {
        console.error('[lanAgentClient] 事件监听器异常:', err)
      }
    }
  }
  source.onerror = () => {
    // EventSource 在「非 200 / 类型不符」时会直接关闭（不再重连）：此时会话已不可用
    if (source.readyState === EventSource.CLOSED) {
      streams.delete(id)
      idleSessions.delete(id)
      emitSessionGone(id, '与主机的会话连接已断开（主机可能已停止共享或会话已结束）')
    }
  }
}

/** 释放全部连接（页面卸载 / 停止使用时） */
export function closeAllLanAgentStreams(): void {
  for (const id of Array.from(streams.keys())) closeStream(id)
  idleSessions.clear()
}

// ---------------------------------------------------------------------------
// 传输层（形状对齐 preload 暴露的 window.dsh.agent）
// ---------------------------------------------------------------------------

export const lanAgentTransport = {
  get available(): boolean {
    return true
  },

  info(): Promise<LanAgentInfo> {
    return getJson<LanAgentInfo>('/info')
  },

  async create(options: AgentOptions): Promise<{ id: string }> {
    const opts = options as AgentOptions & { guestLocale?: 'zh' | 'en' }
    // 新一轮任务：先回收上一轮已收敛的连接，避免同域连接数被占满
    reapIdleStreams()
    const res = await postJson<{ id: string }>('/create', {
      locale: opts.guestLocale || 'zh',
      // 选用的智能体（'general'/空 = 通用智能体）
      agentId: opts.guestAgentId || 'general',
      images: Array.isArray(opts.taskImages) ? opts.taskImages : [],
      seedHistory: Array.isArray(opts.seedHistory) ? opts.seedHistory : [],
    })
    if (res?.id) openStream(res.id)
    return res
  },

  send(id: string, content: string): Promise<{ success: boolean }> {
    return postJson<{ success: boolean }>('/send', { id, content })
  },

  steer(id: string, content: string): Promise<{ success: boolean; reason?: string }> {
    return postJson<{ success: boolean; reason?: string }>('/steer', { id, content })
  },

  inject(id: string, content: string): Promise<{ success: boolean }> {
    return postJson<{ success: boolean }>('/inject', { id, content })
  },

  cancel(id: string, cause?: string, keepInbox?: boolean): Promise<{ success: boolean }> {
    return postJson<{ success: boolean }>('/cancel', { id, cause, keepInbox })
  },

  answer(id: string, askId: string, message: string): Promise<{ success: boolean }> {
    return postJson<{ success: boolean }>('/answer', { id, askId, message })
  },

  async dispose(id: string): Promise<{ success: boolean }> {
    try {
      return await postJson<{ success: boolean }>('/dispose', { id })
    } finally {
      closeStream(id)
    }
  },

  async list(): Promise<AgentSummary[]> {
    const res = await getJson<{ list: AgentSummary[] }>('/list')
    return Array.isArray(res?.list) ? res.list : []
  },

  async state(id: string): Promise<AgentStateView> {
    const res = await getJson<{ state: AgentStateView }>('/state', `?id=${encodeURIComponent(id)}`)
    return res.state
  },

  /** 订阅事件流（与桌面端 agent:event 同一形状；单例订阅，多会话共用多个 SSE 连接） */
  onEvent(cb: Listener): () => void {
    listeners.add(cb)
    return () => {
      listeners.delete(cb)
    }
  },
}

/** 网页端不支持的能力（PTC SDK 文本 / 编排级并发声明 / 渲染层任务）在调用处兜底忽略 */
export type LanAgentTransport = typeof lanAgentTransport
