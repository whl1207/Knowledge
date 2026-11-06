/**
 * sessionLogImport.ts — 把 agent 会话事件投影成聊天消息（含工具步骤）
 *
 * 外部渠道（微信）导入首页时，只取 `user/message` / `assistant/message` 会丢掉
 * 工具调用、思考、轮次——导入出来的聊天只剩两句话。这里按 **turn** 聚合：
 * - 一个 turn 的工具调用 → `executionUnits`（与首页实时投影同形状）
 * - 工具结果、失败状态、参数都保留
 * - 正文取该 turn 的 assistant 文本，思考取 `assistant/reasoning`
 *
 * 纯函数，便于自测；不依赖 Vue / store。
 */

export interface ImportedToolUnit {
  id: string
  description: string
  args: unknown
  result?: unknown
  resultPreview?: string
  error?: string
  status: 'success' | 'error'
  startTime?: number
  endTime?: number
  stepType?: string
}

export interface ImportedChatMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  reasoning?: string
  executionUnits?: ImportedToolUnit[]
  agentTurn?: number
  agentStep?: number
  /** 本轮耗时（折叠“已执行 N 步 · xs”需要；没有它首页不会折叠历史步骤） */
  executionTime?: number
  executionType?: 'skill'
}

interface TurnBucket {
  turn?: number
  step?: number
  startedAt: number
  tools: ImportedToolUnit[]
  pending: Map<string, { id: string; name: string; args: unknown; startTime?: number; step?: number }>
  textParts: string[]
  reasoningParts: string[]
  lastTs: number
}

const clean = (text: unknown): string => (typeof text === 'string' ? text : '').trim()

/** 渠道提示拼在用户正文后：`你好\n\n[渠道：微信] ...` → `你好` */
export function stripChannelHint(text: string): string {
  return text.split(/\n{1,2}\[渠道：/)[0].trim()
}

const isNoise = (text: string): boolean =>
  /^Time sampled while preparing/i.test(text) ||
  /^Browser time zone for this request/i.test(text) ||
  /^\[渠道：/.test(text)

function pushAssistant(out: ImportedChatMessage[], bucket: TurnBucket, turnEndTs?: number): void {
  // 没有结果的工具调用：保留为失败步骤，避免“看到调用了但结果消失”
  for (const pending of bucket.pending.values()) {
    bucket.tools.push({
      id: pending.id,
      description: pending.name,
      args: pending.args,
      status: 'error',
      error: '工具调用没有返回结果',
      ...(pending.startTime !== undefined ? { startTime: pending.startTime } : {}),
    })
  }
  bucket.pending.clear()
  const content = bucket.textParts.join('\n\n').trim()
  const reasoning = bucket.reasoningParts.join('').trim()
  if (!content && !reasoning && bucket.tools.length === 0) return
  const elapsed = turnEndTs !== undefined ? Math.max(0, turnEndTs - bucket.startedAt) : 0
  out.push({
    role: 'assistant',
    content,
    timestamp: turnEndTs || bucket.lastTs || Date.now(),
    executionType: 'skill',
    ...(elapsed > 0 ? { executionTime: elapsed } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(bucket.tools.length ? { executionUnits: bucket.tools } : {}),
    ...(bucket.turn !== undefined ? { agentTurn: bucket.turn } : {}),
    ...(bucket.step !== undefined ? { agentStep: bucket.step } : {}),
  })
}

/**
 * 投影一个会话的全部事件。
 *
 * 顺序：用户消息按事件顺序；每个 turn 聚合成一条 assistant 消息，工具步骤挂在它上面。
 */
export function projectSessionEvents(events: readonly any[]): ImportedChatMessage[] {
  const out: ImportedChatMessage[] = []
  let bucket: TurnBucket | null = null
  let lastUserTs = 0

  const finishTurn = (ts?: number) => {
    if (!bucket) return
    pushAssistant(out, bucket, ts)
    bucket = null
  }

  for (const event of events || []) {
    if (!event || typeof event.type !== 'string') continue
    const ts = typeof event.ts === 'number' ? event.ts : Date.now()
    switch (event.type) {
      case 'user/message': {
        const content = stripChannelHint(clean(event.content))
        if (!content || isNoise(content)) break
        /*
         * 真实日志的顺序是 `turn/start → step/start → user/message → …`：
         * 用户消息在 turn 内，**不能**在这里收尾，否则当前 bucket 被清空，
         * 后面的 assistant/message / tool 事件全部丢掉（表现：导入只剩用户文字）。
         */
        out.push({ role: 'user', content, timestamp: ts })
        lastUserTs = ts
        break
      }
      case 'turn/start': {
        finishTurn(ts)
        bucket = {
          turn: typeof event.turn === 'number' ? event.turn : undefined,
          startedAt: ts,
          tools: [],
          pending: new Map(),
          textParts: [],
          reasoningParts: [],
          lastTs: ts,
        }
        break
      }
      case 'step/start': {
        if (bucket && typeof event.step === 'number') bucket.step = event.step
        if (bucket) bucket.lastTs = ts
        break
      }
      case 'tool/call': {
        if (!bucket) break
        const id = String(event.callId || `tool-${bucket.tools.length + bucket.pending.size}`)
        bucket.pending.set(id, {
          id,
          name: String(event.name || 'tool'),
          args: event.args,
          ...(typeof event.ts === 'number' ? { startTime: event.ts } : {}),
          ...(typeof event.step === 'number' ? { step: event.step } : {}),
        })
        bucket.lastTs = ts
        break
      }
      case 'tool/result': {
        if (!bucket) break
        const id = String(event.callId || '')
        const pending = bucket.pending.get(id)
        if (pending) bucket.pending.delete(id)
        bucket.tools.push({
          id: id || pending?.id || `tool-${bucket.tools.length}`,
          description: pending?.name || String(event.name || 'tool'),
          args: pending?.args,
          ...(event.ok === false
            ? { status: 'error' as const, error: clean(event.error) || '工具执行失败' }
            : { status: 'success' as const, result: event.value }),
          ...(pending?.startTime !== undefined ? { startTime: pending.startTime } : {}),
          endTime: ts,
        })
        bucket.lastTs = ts
        break
      }
      case 'assistant/message': {
        if (!bucket) break
        const text = clean(event.content)
        if (text) bucket.textParts.push(text)
        if (typeof event.step === 'number') bucket.step = event.step
        bucket.lastTs = ts
        break
      }
      case 'assistant/reasoning': {
        if (!bucket) break
        const text = clean(event.content)
        if (text) bucket.reasoningParts.push(text)
        bucket.lastTs = ts
        break
      }
      case 'turn/end': {
        finishTurn(ts)
        break
      }
      default:
        break
    }
  }
  finishTurn(lastUserTs || undefined)
  return out
}
