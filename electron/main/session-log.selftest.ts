/**
 * session-log.selftest.ts — 会话派生的「模型可见 vs 落盘原文」分离自测
 *
 * 为什么需要它：第一层/第二层裁剪（shared/toolResultBudget.ts）只负责"算出模型该看到什么"，
 * 真正决定"模型到底收到什么"的是 `deriveEntries`。本自测覆盖这条**集成缝**：
 *  - 未裁剪的结果：模型可见文本与改造前逐字一致（回归保护）；
 *  - 已裁剪的结果：模型拿到 `modelValue`（有界），日志里 `value` 仍是原文（可审计、可回放）；
 *  - 落盘 spill：模型拿到预览 + 路径，而不是整份原文；
 *  - 工具配对：assistant 的 tool_calls 与 tool 结果成对出现在派生历史里。
 *
 * 依赖注入：`session-log.ts` 通过 `electron` 的 `app.getPath('userData')` 决定日志目录，
 * 而 electron 在纯 node 下不存在——由 `scripts/run-selftests.mjs` 把 `electron`
 * 别名到 `scripts/electron-stub.mjs`，并用 `AIMK_SELFTEST_USERDATA` 指向临时目录。
 * 因此这里跑的是**真实实现**，不是替身。
 *
 * 用法：`npm run test:selftest`
 */

import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  boundToolResult,
  buildSpillPreview,
  countCodePoints,
  DEFAULT_TOOL_RESULT_BUDGET,
  spillThresholdForWindow,
} from '@/shared/toolResultBudget'
import { sessionLog } from './session-log'

export interface SessionLogCase {
  name: string
  ok: boolean
  detail?: string
}

/** 造一个未落盘的新会话（每个用例一个 id，避免相互污染） */
let seq = 0
function newSession(): string {
  return `selftest-${Date.now().toString(36)}-${++seq}`
}

/** 走一遍真实写路径：assistant(tool_calls) + tool/result(+modelValue) → 派生模型历史 */
function writeAndDerive(opts: {
  sessionId: string
  toolName: string
  ok: boolean
  value: unknown
  error?: string
  modelValue?: string
  omittedChars?: number
  spillPath?: string
}): { modelContent: string; rawValue: unknown } {
  const callId = 'call-1'
  sessionLog.append(opts.sessionId, 'session/start', { systemPrompt: 'SYS', createdAt: Date.now() })
  sessionLog.append(opts.sessionId, 'user/message', { content: '读一下这个文件' })
  sessionLog.append(opts.sessionId, 'assistant/message', {
    content: '',
    toolCalls: [{ id: callId, name: opts.toolName, arguments: { path: '/kb/x.md' } }],
  })
  sessionLog.append(opts.sessionId, 'tool/result', {
    callId,
    name: opts.toolName,
    ok: opts.ok,
    value: opts.value,
    error: opts.error,
    ...(opts.modelValue !== undefined ? { modelValue: opts.modelValue } : {}),
    ...(opts.omittedChars !== undefined ? { omittedChars: opts.omittedChars } : {}),
    ...(opts.spillPath !== undefined ? { spillPath: opts.spillPath } : {}),
  })
  const entries = sessionLog.deriveEntries(opts.sessionId)
  const toolMsg = entries.find((e) => e.msg.role === 'tool')
  const rawEvent = sessionLog.readAll(opts.sessionId).find((e) => e.type === 'tool/result') as any
  return { modelContent: String(toolMsg?.msg.content ?? ''), rawValue: rawEvent?.value }
}

export function runSessionLogSelfTest(): SessionLogCase[] {
  const cases: SessionLogCase[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  // 0. 前置：日志目录真的落在自测临时目录里（否则会污染真实用户数据）
  {
    const dir = process.env.AIMK_SELFTEST_USERDATA
    const wrote = sessionLog.append(newSession(), 'session/start', { systemPrompt: 'x', createdAt: Date.now() })
    const okDir = !!dir && fs.existsSync(dir)
    add('前置：日志写入自测临时目录（不污染真实 userData）', okDir, dir || '(AIMK_SELFTEST_USERDATA 未设置)')
    add('前置：append 返回带 seq 的事件', typeof wrote?.seq === 'number' && wrote.seq >= 1)
  }

  // 1. 未裁剪：模型可见文本与历史口径逐字一致
  {
    const sid = newSession()
    const value = { path: '/kb/small.md', content: '短内容', truncated: false }
    const r = writeAndDerive({ sessionId: sid, toolName: 'read_file', ok: true, value })
    add('未裁剪：模型可见 = JSON.stringify(value)', r.modelContent === JSON.stringify(value), r.modelContent.slice(0, 60))
    add('未裁剪：日志里仍是原文对象', JSON.stringify(r.rawValue) === JSON.stringify(value))
  }

  // 2. 失败结果：ERROR 前缀（与改造前一致）
  {
    const sid = newSession()
    const r = writeAndDerive({ sessionId: sid, toolName: 'shell', ok: false, value: undefined, error: '命令不存在' })
    add('失败结果：ERROR 前缀', r.modelContent === 'ERROR: 命令不存在', r.modelContent)
  }

  // 3. 已裁剪：模型拿到 modelValue，日志拿到原文（核心集成断言）
  {
    const sid = newSession()
    const bigValue = { stdout: 'x'.repeat(DEFAULT_TOOL_RESULT_BUDGET.thresholdChars * 3) }
    const bounded = boundToolResult('shell', true, bigValue)
    add('前置：构造出被裁剪的结果', bounded.pruned)
    const r = writeAndDerive({
      sessionId: sid,
      toolName: 'shell',
      ok: true,
      value: bigValue,
      modelValue: bounded.model,
      omittedChars: bounded.omitted?.count,
    })
    add('已裁剪：模型可见 = modelValue', r.modelContent === bounded.model)
    add('已裁剪：模型可见带截断标记', r.modelContent.includes('[... tool result middle pruned ...]'))
    add('已裁剪：模型可见在预算内', countCodePoints(r.modelContent) <= DEFAULT_TOOL_RESULT_BUDGET.thresholdChars)
    add('已裁剪：日志 value 仍是原文（未裁剪）', countCodePoints(JSON.stringify(r.rawValue)) > DEFAULT_TOOL_RESULT_BUDGET.thresholdChars)
    add('已裁剪：日志 value 与原文逐字一致', JSON.stringify(r.rawValue) === JSON.stringify(bigValue))
  }

  // 4. 落盘 spill：模型拿到预览 + 路径，而不是整份原文
  {
    const sid = newSession()
    // 用 32K 窗口：该场景下 spill 门槛 = 第一层预算 × 2（小窗口下才可达，见 toolResultBudget 自测）
    const w = 32_000
    const spillThreshold = spillThresholdForWindow(w)
    const big = 'y'.repeat(spillThreshold + 1_000)
    const raw = JSON.stringify({ stdout: big })
    const spillPath = 'C:\\Users\\admin\\AppData\\Local\\Temp\\aikm-spill-Ab12Cd\\session-0123456789ab\\deadbeef-shell.txt'
    const preview = buildSpillPreview(raw, { path: spillPath, bytes: raw.length }, w).text
    const r = writeAndDerive({
      sessionId: sid,
      toolName: 'shell',
      ok: true,
      value: { stdout: big },
      modelValue: preview,
      spillPath,
    })
    add('spill：模型可见含落盘路径', r.modelContent.includes(spillPath))
    add('spill：模型可见要求用 read_file 回读', r.modelContent.includes('read_file'))
    // 预览 ≈ 该窗口的预算（10K 量级），原文 ≈ 门槛（16K 量级）：断言"明显更小"而非"小一个数量级"
    add('spill：模型可见明显小于原文（不到一半）', countCodePoints(r.modelContent) < countCodePoints(raw) / 2, `model=${countCodePoints(r.modelContent)} raw=${countCodePoints(raw)}`)
    add('spill：日志仍保留原文 value（可审计）', countCodePoints(JSON.stringify(r.rawValue)) > spillThreshold)
  }

  // 5. 工具配对：派生的 tool 消息带 toolCallId，且紧跟在发起它的 assistant 之后
  {
    const sid = newSession()
    writeAndDerive({ sessionId: sid, toolName: 'read_file', ok: true, value: { path: '/kb/a.md', content: 'x' } })
    const entries = sessionLog.deriveEntries(sid)
    const withCalls = entries.findIndex((e) => e.msg.role === 'assistant' && !!e.msg.toolCalls?.length)
    const toolIdx = entries.findIndex((e) => e.msg.role === 'tool')
    add('配对：tool 消息紧跟发起它的 assistant', toolIdx === withCalls + 1, `assistant@${withCalls} tool@${toolIdx}`)
    add('配对：tool 消息带 toolCallId', entries[toolIdx]?.msg?.toolCallId === 'call-1', String(entries[toolIdx]?.msg?.toolCallId))
    add('配对：tool 消息带工具名', entries[toolIdx]?.msg?.name === 'read_file')
  }

  // 6. 会话级隔离：不同会话的派生结果互不串
  {
    const a = newSession()
    const b = newSession()
    writeAndDerive({ sessionId: a, toolName: 'read_file', ok: true, value: { path: '/kb/a.md', content: 'AAA' } })
    writeAndDerive({ sessionId: b, toolName: 'read_file', ok: true, value: { path: '/kb/b.md', content: 'BBB' } })
    const ca = sessionLog.deriveEntries(a).find((e) => e.msg.role === 'tool')?.msg.content ?? ''
    const cb = sessionLog.deriveEntries(b).find((e) => e.msg.role === 'tool')?.msg.content ?? ''
    add('隔离：A 会话只看到 A 的结果', ca.includes('AAA') && !ca.includes('BBB'))
    add('隔离：B 会话只看到 B 的结果', cb.includes('BBB') && !cb.includes('AAA'))
  }

  // 7. 缺失结果：日志不完整时给明确提示（而不是空字符串）
  {
    const sid = newSession()
    sessionLog.append(sid, 'assistant/message', {
      content: '',
      toolCalls: [{ id: 'orphan', name: 'read_file', arguments: {} }],
    })
    const content = sessionLog.deriveEntries(sid).find((e) => e.msg.role === 'tool')?.msg.content ?? ''
    add('缺失结果：给出「结果缺失」提示', content.includes('工具结果缺失'), content.slice(0, 40))
  }

  // 8. sourceEventSeqs：同一 callId 在两次 assistant 消息里被复用（真实场景：崩溃后重放、
  //    或将来的并行执行），显式引用必须让**每次调用各自**拿到它那次的结果
  {
    const sid = newSession()
    // 第一次调用 → 结果 A
    const callA = sessionLog.append(sid, 'tool/call', { callId: 'reused', name: 'read_file', args: { path: '/a' } })
    sessionLog.append(sid, 'assistant/message', {
      content: '',
      toolCalls: [{ id: 'reused', name: 'read_file', arguments: { path: '/a' } }],
    })
    sessionLog.append(sid, 'tool/result', { callId: 'reused', name: 'read_file', ok: true, value: { which: 'A' }, sourceEventSeqs: [callA.seq] })
    // 第二次调用（同 callId）→ 结果 B
    const callB = sessionLog.append(sid, 'tool/call', { callId: 'reused', name: 'read_file', args: { path: '/b' } })
    sessionLog.append(sid, 'assistant/message', {
      content: '',
      toolCalls: [{ id: 'reused', name: 'read_file', arguments: { path: '/b' } }],
    })
    sessionLog.append(sid, 'tool/result', { callId: 'reused', name: 'read_file', ok: true, value: { which: 'B' }, sourceEventSeqs: [callB.seq] })

    const toolMsgs = sessionLog.deriveEntries(sid).filter((e) => e.msg.role === 'tool')
    add('显式引用：两次调用都派生出 tool 消息', toolMsgs.length === 2, `count=${toolMsgs.length}`)
    add('显式引用：第一次调用拿到 A（不被最后一次覆盖）', String(toolMsgs[0]?.msg.content).includes('"which":"A"'), String(toolMsgs[0]?.msg.content))
    add('显式引用：第二次调用拿到 B', String(toolMsgs[1]?.msg.content).includes('"which":"B"'), String(toolMsgs[1]?.msg.content))
  }

  // 9. 向后兼容：旧日志没有 sourceEventSeqs，退回"callId 最后一条胜出"
  {
    const sid = newSession()
    sessionLog.append(sid, 'assistant/message', {
      content: '',
      toolCalls: [{ id: 'legacy', name: 'shell', arguments: {} }],
    })
    sessionLog.append(sid, 'tool/result', { callId: 'legacy', name: 'shell', ok: true, value: { v: 1 } })
    sessionLog.append(sid, 'tool/result', { callId: 'legacy', name: 'shell', ok: true, value: { v: 2 } })
    const content = sessionLog.deriveEntries(sid).find((e) => e.msg.role === 'tool')?.msg.content ?? ''
    add('旧日志兼容：无引用 → 最后一条胜出', content.includes('"v":2'), content)
  }

  // 10. 崩溃恢复：结果被补写后，模型看到的是**真实结果**而不是"结果缺失"
  {
    const sid = newSession()
    const call = sessionLog.append(sid, 'tool/call', { callId: 'recovered', name: 'read_file', args: { path: '/x' } })
    sessionLog.append(sid, 'assistant/message', {
      content: '',
      toolCalls: [{ id: 'recovered', name: 'read_file', arguments: { path: '/x' } }],
    })
    // 补写（等价于 runTurn catch 块里做的事）
    sessionLog.append(sid, 'tool/result', {
      callId: 'recovered',
      name: 'read_file',
      ok: true,
      value: { path: '/x', content: '已跑成功的内容' },
      sourceEventSeqs: [call.seq],
    })
    const content = sessionLog.deriveEntries(sid).find((e) => e.msg.role === 'tool')?.msg.content ?? ''
    add('崩溃恢复：模型看到真实结果', content.includes('已跑成功的内容'), content.slice(0, 60))
    add('崩溃恢复：不再出现「结果缺失」', !content.includes('结果缺失'))
  }

  // 11. 工具图片：日志只存路径，派生时合成一条 synthetic user 图片消息（紧随工具结果之后）
  {
    const sid = newSession()
    const dir = fs.mkdtempSync(join(tmpdir(), 'aikm-selftest-img-'))
    const imgPath = join(dir, 'shot.png')
    // 1x1 PNG
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    fs.writeFileSync(imgPath, Buffer.from(pngBase64, 'base64'))
    try {
      const call = sessionLog.append(sid, 'tool/call', { callId: 'shot', name: 'browser_screenshot', args: {} })
      sessionLog.append(sid, 'assistant/message', {
        content: '',
        toolCalls: [{ id: 'shot', name: 'browser_screenshot', arguments: {} }],
      })
      sessionLog.append(sid, 'tool/result', {
        callId: 'shot',
        name: 'browser_screenshot',
        ok: true,
        value: '已截图（1x1）',
        images: [{ mime: 'image/png', path: imgPath, width: 1, height: 1 }],
        sourceEventSeqs: [call.seq],
      })
      const entries = sessionLog.deriveEntries(sid)
      const toolIndex = entries.findIndex((e) => e.msg.role === 'tool')
      const imgEntry = entries.find((e) => e.msg.role === 'user' && e.msg.synthetic === true)
      add('工具图片：派生出一条 synthetic 图片消息', !!imgEntry)
      add('工具图片：排在 tool 消息之后', !!imgEntry && entries.indexOf(imgEntry) > toolIndex)
      add('工具图片：data URL 形态正确', String(imgEntry?.msg.images?.[0] || '').startsWith('data:image/png;base64,'))
      add('工具图片：tool 文本里没有 base64', !String(entries[toolIndex]?.msg.content || '').includes('base64'))
      const raw = sessionLog.readAll(sid).find((e) => e.type === 'tool/result') as any
      add('工具图片：日志只存路径不存 base64', !!raw?.images?.[0]?.path && !JSON.stringify(raw).includes(pngBase64.slice(0, 24)))

      // 文件被系统清理：派生不抛错、只是少一张图
      let tolerated = false
      try {
        const sid2 = newSession()
        const call2 = sessionLog.append(sid2, 'tool/call', { callId: 'gone', name: 'browser_screenshot', args: {} })
        sessionLog.append(sid2, 'assistant/message', { content: '', toolCalls: [{ id: 'gone', name: 'browser_screenshot', arguments: {} }] })
        sessionLog.append(sid2, 'tool/result', {
          callId: 'gone',
          name: 'browser_screenshot',
          ok: true,
          value: 'x',
          images: [{ mime: 'image/png', path: join(dir, 'missing.png') }],
          sourceEventSeqs: [call2.seq],
        })
        const derived = sessionLog.deriveEntries(sid2)
        tolerated = derived.every((e) => !e.msg.synthetic)
      } catch {
        tolerated = false
      }
      add('工具图片：文件丢失时静默跳过', tolerated)
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
  }

  return cases
}

/** 打印自测结果并返回是否全通过 */
export function logSessionLogSelfTest(): boolean {
  const cases = runSessionLogSelfTest()
  const failed = cases.filter((c) => !c.ok)
  // eslint-disable-next-line no-console
  console.table(cases.map((c) => ({ 用例: c.name, 结果: c.ok ? '通过' : '失败', 备注: c.detail ?? '' })))
  // eslint-disable-next-line no-console
  console.log(`[session-log] ${cases.length - failed.length}/${cases.length} 通过`)
  return failed.length === 0
}
