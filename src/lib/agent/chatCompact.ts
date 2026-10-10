/**
 * chatCompact.ts — 普通聊天的上下文压缩（P0）
 *
 * 问题：home.vue 的 `buildMessagesWithFunction` / `buildMultimodalMessages` 会把
 * `chat.messages` 全量、全文发给模型。超出窗口时云端 API 直接 400（运行中断），
 * 本地 Ollama / LM Studio 则从 prompt 头部静默截断（system prompt / 任务描述被丢 = "失忆"）。
 *
 * 方案（用户已确认的参数）：
 *  - 占用 ≥ 80%（CONTEXT_COMPACT_RATIO）→ 主动压缩旧轮次；
 *  - 逐字保留最近 COMPACT_KEEP_TURNS 个用户轮次，其余中段压成结构化摘要；
 *  - 摘要写进 `chat.compaction`（不改动可见消息，UI 无副作用）：
 *    `{ summary, coveredCount, tokensBefore, at }`；
 *  - `coveredCount` 之前的消息不再发送（请求里以 `<compacted_context>` 替代），
 *    但**聊天里原样保留**，用户可随时回看。
 *
 * 摘要由当前模型生成（调用方传入 summarize；失败时退化为无 LLM 的关键信息索引）。
 */

import {
  CONTEXT_COMPACT_RATIO,
  COMPACT_KEEP_TURNS,
  buildCompactionPrompt,
  compactedContextMessage,
  estimateMessagesTokens,
  indexSummary,
  pickCompactionRange,
  type BudgetMessage,
  type CompactionPlan,
} from '@/shared/contextBudget'
import { estimateChatContextTokens } from '@/lib/contextUsage'

/** 聊天压缩水位（挂在 chat 上，随聊天持久化） */
export interface ChatCompactionState {
  /** 结构化摘要（模型可见，包裹在 <compacted_context> 内） */
  summary: string
  /** 前 N 条消息已被摘要覆盖，不再随请求发送 */
  coveredCount: number
  /** 压缩前这部分消息的估算 token（展示用） */
  tokensBefore: number
  at: number
}

/** 已被摘要覆盖的历史条数（末尾的助手占位消息永不覆盖） */
export function chatCoveredCount(chat: any): number {
  const n = Number(chat?.compaction?.coveredCount) || 0
  const max = Math.max(0, (chat?.messages?.length || 0) - 1)
  return Math.max(0, Math.min(n, max))
}

/** 聊天消息 → 预算消息（只取模型可见部分） */
function budgetItems(msgs: readonly any[]): BudgetMessage[] {
  return msgs.map((m) => ({
    role: m?.role,
    content: typeof m?.content === 'string' ? m.content : '',
    toolCalls: m?.toolCalls,
  }))
}

/** 挑选可压缩区间（基于「未覆盖的历史」，不含末尾助手占位） */
export function planChatCompaction(chat: any, keepTurns = COMPACT_KEEP_TURNS): (CompactionPlan & { items: BudgetMessage[]; offset: number }) | null {
  const msgs: any[] = chat?.messages || []
  const offset = chatCoveredCount(chat)
  const history = msgs.slice(offset, Math.max(offset, msgs.length - 1))
  if (!history.length) return null
  const items = budgetItems(history)
  const plan = pickCompactionRange(items, { keepTurns })
  if (!plan) return null
  return { ...plan, items, offset }
}

/** 是否达到主动压缩阈值 */
export function shouldCompactChat(chat: any, limit: number): boolean {
  if (!(Number(limit) > 0)) return false
  if (!planChatCompaction(chat)) return false
  return estimateChatContextTokens(chat) / Number(limit) >= CONTEXT_COMPACT_RATIO
}

export interface CompactChatResult {
  ok: boolean
  /** 是否由「自动摘要不可用 → 关键信息索引」兜底生成 */
  fallback?: boolean
  dropped?: number
  summary?: string
  error?: string
}

/**
 * 压缩聊天历史：把旧轮次替换为摘要水位。
 * @param summarize 生成摘要的一次性 LLM 调用（失败应抛错，本函数会退化为无 LLM 兜底）
 */
export async function compactChat(
  chat: any,
  opts: { summarize: (prompt: string) => Promise<string>; keepTurns?: number },
): Promise<CompactChatResult> {
  const plan = planChatCompaction(chat, opts.keepTurns)
  if (!plan) return { ok: false, error: '可压缩内容不足（轮次太少）' }
  const droppedItems = plan.items.slice(plan.startIndex, plan.endIndex)
  let summary = ''
  let fallback = false
  try {
    summary = String((await opts.summarize(buildCompactionPrompt(droppedItems))) || '').trim()
  } catch (e: any) {
    summary = ''
    fallback = true
  }
  if (!summary) {
    summary = indexSummary(droppedItems)
    fallback = true
  }
  // 多级压缩：沿用上一次的摘要作为前置（避免旧摘要丢失）
  const prev = String(chat?.compaction?.summary || '').trim()
  const merged = prev && !summary.includes(prev) ? `${prev}\n\n${summary}` : summary
  const coveredCount = plan.offset + plan.endIndex
  chat.compaction = {
    summary: merged,
    coveredCount,
    tokensBefore: estimateMessagesTokens(droppedItems),
    at: Date.now(),
  } satisfies ChatCompactionState
  return { ok: true, fallback, dropped: plan.dropped, summary: merged }
}

/**
 * 构造请求历史（发送用；可见的 chat.messages 不受影响）：
 * 有压缩水位时，先用一条 user 消息注入 `<compacted_context>` 摘要，再拼未覆盖的消息。
 * @param withImages 多模态分支：历史里带图的消息原样挂回 images
 */
export function chatHistoryForRequest(chat: any, withImages = false): any[] {
  const msgs: any[] = chat?.messages || []
  const covered = chatCoveredCount(chat)
  const summary = String(chat?.compaction?.summary || '')
  const out: any[] = []
  if (covered > 0 && summary) out.push({ role: 'user', content: compactedContextMessage(summary) })
  for (let i = covered; i < msgs.length - 1; i++) {
    const m = msgs[i]
    if (withImages && Array.isArray(m?.images) && m.images.length > 0) {
      out.push({ role: m.role, content: m.content, images: m.images })
    } else {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}
