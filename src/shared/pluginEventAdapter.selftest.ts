/**
 * pluginEventAdapter.selftest.ts — DSH 流式帧映射的自测（纯逻辑）
 *
 * 这条映射错了不会报错，只会让 DSH 插件"收到流但没有文本"——所以用自测钉住
 * 每种事件的确切形状，而不是等微信那边发现空回复。
 */

import { toAssistantStreamFrame, toAssistantStreamPayload } from './pluginEventAdapter'
import type { AgentEventLike } from './pluginEventAdapter'

export interface SelfTestResult {
  name: string
  ok: boolean
  detail?: string
}

export function runPluginEventAdapterSelfTest(): SelfTestResult[] {
  const results: SelfTestResult[] = []
  const check = (name: string, fn: () => string | null) => {
    try {
      const problem = fn()
      results.push({ name, ok: !problem, ...(problem ? { detail: problem } : {}) })
    } catch (e) {
      results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) })
    }
  }

  check('turn-start → start（带 turn）', () => {
    const frame = toAssistantStreamFrame({ type: 'agent/turn-start', payload: { turn: 3 } })
    if (!frame || frame.type !== 'start') return '不是 start'
    if (frame.turn !== 3) return `turn 不对：${frame.turn}`
    return null
  })

  check('assistant/chunk → chunk(text-delta) 且文本原样', () => {
    const frame = toAssistantStreamFrame({ type: 'assistant/chunk', payload: { content: '你好' } })
    if (!frame || frame.type !== 'chunk') return '不是 chunk'
    const chunk = frame.chunk as { type?: string; text?: string } | undefined
    if (chunk?.type !== 'text-delta' || chunk.text !== '你好') return `chunk 形状不对：${JSON.stringify(chunk)}`
    return null
  })

  check('空 chunk 不产生帧（避免空回复）', () => {
    const frame = toAssistantStreamFrame({ type: 'assistant/chunk', payload: { content: '' } })
    if (frame !== null) return '空增量应返回 null'
    return null
  })

  check('assistant/message → end', () => {
    const frame = toAssistantStreamFrame({ type: 'assistant/message', payload: { content: 'x' } })
    if (!frame || frame.type !== 'end') return '不是 end'
    return null
  })

  check('turn-end → end', () => {
    const frame = toAssistantStreamFrame({ type: 'agent/turn-end', payload: { turn: 1 } })
    if (!frame || frame.type !== 'end') return '不是 end'
    return null
  })

  check('未知事件 → null（不猜）', () => {
    if (toAssistantStreamFrame({ type: 'agent/status', payload: {} }) !== null) return '未知事件应返回 null'
    return null
  })

  check('扁平 envelope（插件总线真实形状）也能取到文本', () => {
    const frame = toAssistantStreamFrame({ type: 'assistant/chunk', agentId: 'a', content: 'hello' } as any)
    if (!frame || frame.type !== 'chunk') return '没有 chunk'
    const chunk = frame.chunk as any
    if (chunk?.type !== 'text-delta' || chunk?.text !== 'hello') return '文本没取到'
    return null
  })

  check('扁平 envelope 的 sessionId / 文本都能进载荷', () => {
    const wrapped = toAssistantStreamPayload({ type: 'assistant/chunk', agentId: 'a', content: 'hi' } as any)
    if (!wrapped) return '没有包装结果'
    if (wrapped.agent?.session?.id !== 'a') return '缺 agent.session.id'
    const chunk = wrapped.frame.chunk as any
    if (chunk?.text !== 'hi') return '文本没取到'
    return null
  })

  check('payload 包装带 sessionId，且带 DSH 读法 agent.session.id', () => {
    const ev: AgentEventLike = { type: 'assistant/chunk', agentId: 'agent-1', payload: { content: 'a' } }
    const wrapped = toAssistantStreamPayload(ev)
    if (!wrapped) return '没有包装结果'
    if (wrapped.sessionId !== 'agent-1') return `sessionId 不对：${wrapped.sessionId}`
    if (wrapped.agent?.session?.id !== 'agent-1') return '缺 agent.session.id（DSH 插件按这个键过滤）'
    if (wrapped.frame.type !== 'chunk') return '帧类型不对'
    return null
  })

  check('没有 agentId 时不编造 sessionId', () => {
    const wrapped = toAssistantStreamPayload({ type: 'assistant/message', payload: {} })
    if (!wrapped) return '没有包装结果'
    if ('sessionId' in wrapped) return '不应有 sessionId 字段'
    if ('agent' in wrapped) return '不应有 agent 字段'
    return null
  })

  return results
}
