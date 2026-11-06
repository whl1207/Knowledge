/**
 * pluginEventAdapter.ts — AI-KM agent 事件 → DSH `agent/assistant-stream` 帧（纯函数）
 *
 * 为什么单独放：DSH 插件按 `{revision, type: 'start' | 'chunk' | 'end', attemptId, turn, step}`
 * 解析流式回复；形状不对**不会报错**，只会静默丢内容（"装上了但没回复"）。
 * 把映射做成纯函数，就能被自测钉住，而不是等微信那边发现空回复。
 *
 * 目前只映射有明确对等物的四类；未知类型返回 null（调用方跳过，不猜）。
 */

import type { AssistantStreamFrame } from './pluginServices'

/** AI-KM 的 agent 事件（只取映射需要的字段） */
export interface AgentEventLike {
  readonly type?: string
  readonly agentId?: string
  readonly payload?: Record<string, unknown>
}

function textOf(payload: Record<string, unknown> | undefined): string {
  const content = payload?.content
  return typeof content === 'string' ? content : ''
}

function numberField(payload: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = payload?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 把一条 AI-KM agent 事件转成 DSH 的流式帧；未知事件返回 null。
 *
 * 映射：
 * - `agent/turn-start` → `start`
 * - `agent/step-start` → `start`（带 step）
 * - `assistant/chunk`  → `chunk`（`{ type:'text-delta', text }`）
 * - `assistant/message`→ `end`
 * - `agent/turn-end`   → `end`
 */
export function toAssistantStreamFrame(ev: AgentEventLike): AssistantStreamFrame | null {
  const type = String(ev?.type || '')
  /*
   * 真实事件有两种到达形状：
   * - 原始 AgentEvent：`{ agentId, type, payload: { content } }`
   * - 插件总线扁平化后的 envelope：`{ agentId, type, content, turn, ... }`
   * 只读 `ev.payload` 会让第二种永远拿不到文本（表现：end 帧到了、回复是空的）。
   */
  const payload =
    ev?.payload && typeof ev.payload === 'object'
      ? ev.payload
      : (ev as unknown as Record<string, unknown>)
  switch (type) {
    case 'agent/turn-start':
      return {
        type: 'start',
        ...(numberField(payload, 'turn') !== undefined ? { turn: numberField(payload, 'turn') } : {}),
      }
    case 'agent/step-start':
      return {
        type: 'start',
        ...(numberField(payload, 'turn') !== undefined ? { turn: numberField(payload, 'turn') } : {}),
        ...(numberField(payload, 'step') !== undefined ? { step: numberField(payload, 'step') } : {}),
      }
    case 'assistant/chunk': {
      const text = textOf(payload)
      // 空增量没有意义（DSH 那边会当成空回复的一帧），直接丢
      if (!text) return null
      return { type: 'chunk', chunk: { type: 'text-delta', text } }
    }
    case 'assistant/message':
    case 'agent/turn-end':
      return { type: 'end' }
    default:
      return null
  }
}

/**
 * 包成 DSH `agent/assistant-stream` 的载荷。
 *
 * **必须同时给 `agent.session.id`**：DSH 插件（微信）读的是
 * `payload.agent?.session?.id`，只给顶层 `sessionId` 会被当成"没有会话 id"而丢掉整帧——
 * 表现正是"推理完成了，但微信里没有回复"。
 */
export function toAssistantStreamPayload(
  ev: AgentEventLike,
): { sessionId?: string; agent?: { session: { id: string } }; frame: AssistantStreamFrame } | null {
  const frame = toAssistantStreamFrame(ev)
  if (!frame) return null
  const rawId = (ev as any)?.agentId ?? (ev as any)?.payload?.agentId ?? (ev as any)?.agent?.session?.id
  const sessionId = String(rawId || '').trim()
  if (!sessionId) return { frame }
  return {
    sessionId,
    agent: { session: { id: sessionId } },
    frame,
  }
}
