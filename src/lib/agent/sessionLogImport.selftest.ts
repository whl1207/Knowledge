/**
 * sessionLogImport.selftest.ts — 外部会话导入投影（含工具步骤）
 *
 * 锁住三件事：
 * 1. 用户正文后的 `[渠道：微信]` 提示被剥掉；
 * 2. turn 内的 tool/call + tool/result 变成 assistant 消息的 executionUnits；
 * 3. 没有结果的工具调用不会静默消失（保留为失败步骤）。
 */

import { projectSessionEvents, stripChannelHint } from './sessionLogImport'

export interface SelfTestResult {
  name: string
  ok: boolean
  detail?: string
}

export function runSessionLogImportSelfTest(): SelfTestResult[] {
  const results: SelfTestResult[] = []
  const check = (name: string, fn: () => string | null) => {
    try {
      const problem = fn()
      results.push({ name, ok: !problem, ...(problem ? { detail: problem } : {}) })
    } catch (e) {
      results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) })
    }
  }

  check('剥掉用户正文后的渠道提示', () => {
    if (stripChannelHint('你好\n\n[渠道：微信] 你在和微信上的用户对话') !== '你好') return '没剥掉'
    return null
  })

  check('真实顺序 turn/start 在 user/message 之前也不丢回复', () => {
    const messages = projectSessionEvents([
      { seq: 1, ts: 1, type: 'turn/start', turn: 1 },
      { seq: 2, ts: 2, type: 'step/start', turn: 1, step: 1 },
      { seq: 3, ts: 3, type: 'user/message', content: '你好' },
      { seq: 4, ts: 4, type: 'assistant/message', content: '你好呀' },
      { seq: 5, ts: 5, type: 'turn/end', turn: 1 },
    ])
    if (messages.length !== 2) return `消息数不对：${messages.length}`
    if (messages[0].role !== 'user') return '第一条不是用户'
    if (messages[1].role !== 'assistant' || messages[1].content !== '你好呀') return '回复丢了'
    return null
  })

  check('工具调用 + 结果投影进 assistant.executionUnits', () => {
    const messages = projectSessionEvents([
      { seq: 1, ts: 100, type: 'user/message', content: '看看目录\n\n[渠道：微信] ...' },
      { seq: 2, ts: 101, type: 'turn/start', turn: 1 },
      { seq: 3, ts: 102, type: 'step/start', turn: 1, step: 1 },
      { seq: 4, ts: 103, type: 'assistant/chunk', content: '我先看看' },
      { seq: 5, ts: 104, type: 'tool/call', callId: 'c1', name: 'list_dir', args: { path: 'D:\\x' }, step: 1 },
      { seq: 6, ts: 105, type: 'tool/result', callId: 'c1', name: 'list_dir', ok: true, value: { entries: [{ name: 'a' }] } },
      { seq: 7, ts: 106, type: 'assistant/message', content: '目录里有一个 a' },
      { seq: 8, ts: 107, type: 'turn/end', turn: 1, reason: 'completed' },
    ])
    if (messages.length !== 2) return `消息数不对：${messages.length}`
    if (messages[0].role !== 'user' || messages[0].content !== '看看目录') return '用户消息不对'
    const assistant = messages[1]
    if (assistant.role !== 'assistant' || !assistant.content.includes('目录里有一个')) return '正文不对'
    if (!(Number(assistant.executionTime) > 0)) return '缺 executionTime（首页不会折叠步骤）'
    const unit = assistant.executionUnits?.[0]
    if (!unit) return '没有工具步骤'
    if (unit.description !== 'list_dir') return `工具名不对：${unit.description}`
    if (unit.status !== 'success') return `状态不对：${unit.status}`
    if ((unit.args as any)?.path !== 'D:\\x') return '参数没保留'
    return null
  })

  check('没有结果的工具调用保留为失败步骤', () => {
    const messages = projectSessionEvents([
      { seq: 1, ts: 1, type: 'user/message', content: 'hi' },
      { seq: 2, ts: 2, type: 'turn/start', turn: 1 },
      { seq: 3, ts: 3, type: 'tool/call', callId: 'c1', name: 'list_dir', args: {} },
      { seq: 4, ts: 4, type: 'turn/end', turn: 1 },
    ])
    const unit = messages.find((m) => m.role === 'assistant')?.executionUnits?.[0]
    if (!unit) return '失败步骤丢了'
    if (unit.status !== 'error') return `状态不对：${unit.status}`
    return null
  })

  check('思考事件进入 reasoning', () => {
    const messages = projectSessionEvents([
      { seq: 1, ts: 1, type: 'user/message', content: 'hi' },
      { seq: 2, ts: 2, type: 'turn/start', turn: 1 },
      { seq: 3, ts: 3, type: 'assistant/reasoning', content: '想一想' },
      { seq: 4, ts: 4, type: 'assistant/message', content: '答案' },
      { seq: 5, ts: 5, type: 'turn/end', turn: 1 },
    ])
    const assistant = messages.find((m) => m.role === 'assistant')
    if (!assistant) return '没有 assistant'
    if (assistant.reasoning !== '想一想') return `reasoning 不对：${assistant.reasoning}`
    if (assistant.content !== '答案') return '正文不对'
    return null
  })

  return results
}
