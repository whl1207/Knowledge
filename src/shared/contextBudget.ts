/**
 * contextBudget.ts — 上下文预算、压缩区间与溢出识别（主进程 / 渲染进程共用的纯函数）
 *
 * 背景（P0 上下文压缩）：
 *  - 普通聊天（home.vue）与智能体（agent-loop）此前都把历史**全量**发给模型，没有任何预算检查；
 *    云端 API 直接 400（运行中断），本地 Ollama/LM Studio 则从 prompt 头部**静默截断**
 *    （system prompt / 任务描述被丢 = 用户感知的"失忆"）。
 *  - 本模块只做纯计算：token 估算、预算分级、（旧轮次）压缩区间挑选、压缩提示词拼装、溢出错误识别。
 *    不依赖 electron / DOM，因此主进程与渲染进程可共用同一口径。
 *
 * 阈值与保留策略（用户已确认）：
 *  - 占用 ≥ 80%（CONTEXT_COMPACT_RATIO）→ 主动压缩；
 *  - ≥ 70%（CONTEXT_WARN_RATIO）→ 仅预警（圆环 / 日志）；
 *  - 逐字保留最近 COMPACT_KEEP_TURNS 个用户轮次，其余中段压成结构化摘要。
 */

/** 完全无法判定窗口时的兜底分母（与 src/lib/contextUsage.ts 的 UNKNOWN_CONTEXT_WINDOW 同值） */
export const FALLBACK_CONTEXT_WINDOW = 128_000

/** 单张图片计入上下文的粗略 token（视觉模型高细节档量级） */
export const IMAGE_TOKEN_ESTIMATE = 800

/** 单个工具 / 函数的 JSON schema 粗略 token */
export const TOOL_SCHEMA_TOKEN_ESTIMATE = 140

/** 预警阈值：只提示（圆环色阶 / 日志），不触发压缩 */
export const CONTEXT_WARN_RATIO = 0.7

/** 主动压缩阈值：占用达到该比例即压缩旧轮次 */
export const CONTEXT_COMPACT_RATIO = 0.8

/** 输出预留：max_tokens 之外的额外安全余量（按窗口比例计） */
export const OUTPUT_RESERVE_RATIO = 0.08

/** 压缩时逐字保留的最近用户轮次数 */
export const COMPACT_KEEP_TURNS = 3

/** 溢出后「压缩 + 重放本 step」的最大次数 */
export const OVERFLOW_RETRY_LIMIT = 2

/** 压缩摘要请求里单条消息的字符上限（防止被压缩段自身撑爆摘要请求） */
export const COMPACT_PER_MESSAGE_CHARS = 4000

/** 压缩摘要请求的整体字符上限 */
export const COMPACT_MAX_TRANSCRIPT_CHARS = 60_000

// ---------------------------------------------------------------------------
// token 估算
// ---------------------------------------------------------------------------

/**
 * 按字符类型粗估 token：CJK ≈ 1.5 字/token（主流 BPE 中文实测 1.4~1.8），
 * ASCII ≈ 4 字符/token，其它（emoji/西里尔等）折中按 2。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let ascii = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff)) cjk++
    else if (code < 0x80) ascii++
    else other++
  }
  return Math.ceil(cjk / 1.5) + Math.ceil(ascii / 4) + Math.ceil(other / 2)
}

/** 计入预算的最小消息形态（OpenAI 风格 + 附图数量） */
export interface BudgetMessage {
  role?: string
  content?: string
  /** assistant 的工具调用（会随请求回传，必须计入） */
  toolCalls?: any
  /** 附图数量（图片本体不在此处，只按张数估算） */
  images?: number
}

/** 单条消息的 token 估算（正文 + tool_calls + 图片） */
export function estimateMessageTokens(m: BudgetMessage): number {
  let t = estimateTokens(typeof m?.content === 'string' ? m.content : '')
  if (m?.toolCalls && (Array.isArray(m.toolCalls) ? m.toolCalls.length : true)) {
    try { t += estimateTokens(JSON.stringify(m.toolCalls) ?? '') } catch { /* 循环引用兜底 */ }
  }
  if (m?.images) t += Number(m.images) * IMAGE_TOKEN_ESTIMATE
  return t
}

/** 一组消息的 token 估算 */
export function estimateMessagesTokens(msgs: readonly BudgetMessage[] | null | undefined): number {
  let t = 0
  for (const m of msgs || []) t += estimateMessageTokens(m)
  return t
}

// ---------------------------------------------------------------------------
// 预算分级
// ---------------------------------------------------------------------------

export type ContextBudgetLevel = 'ok' | 'warn' | 'compact'

export interface ContextBudget {
  /** 生效窗口上限（tokens） */
  limit: number
  /** 已用（含预留输出） */
  used: number
  /** 预留的输出 token */
  reserve: number
  /** 已用 / 上限（0~n，可能 >1） */
  ratio: number
  level: ContextBudgetLevel
  remaining: number
}

/**
 * 预算分级：`used` 应包含「system + 工具 schema + 全部历史消息」的估算值。
 * reserve 默认按窗口比例预留（OUTPUT_RESERVE_RATIO）。
 */
export function planContextBudget(opts: { limit?: number; used: number; reserve?: number }): ContextBudget {
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : FALLBACK_CONTEXT_WINDOW
  const reserve = Number(opts.reserve) >= 0 ? Number(opts.reserve) : Math.round(limit * OUTPUT_RESERVE_RATIO)
  const used = Math.max(0, Number(opts.used) || 0) + reserve
  const ratio = limit > 0 ? used / limit : 0
  const level: ContextBudgetLevel = ratio >= CONTEXT_COMPACT_RATIO ? 'compact' : (ratio >= CONTEXT_WARN_RATIO ? 'warn' : 'ok')
  return { limit, used, reserve, ratio, level, remaining: Math.max(0, limit - used) }
}

// ---------------------------------------------------------------------------
// 溢出识别
// ---------------------------------------------------------------------------

/**
 * 判断 provider 报错是否属于「上下文超限」。
 * 覆盖主流云端（OpenAI / DeepSeek / Anthropic / Google）与本地后端（Ollama / LM Studio / vLLM）
 * 的典型措辞；无法识别时返回 false（保持原有报错行为，不做压缩重试）。
 */
export function isContextOverflowError(message: string): boolean {
  const m = String(message || '')
  if (!m) return false
  if (/context[_ ]length[_ ]exceeded/i.test(m)) return true
  if (/maximum context length|max context length/i.test(m)) return true
  if (/(exceed|greater than|larger than|over)[^.\n]{0,40}context (length|window)/i.test(m)) return true
  if (/context (length|window)[^.\n]{0,40}(exceed|too (small|long)|limit)/i.test(m)) return true
  if (/prompt is too long|input is too long|too many tokens|exceeds? the maximum number of tokens/i.test(m)) return true
  if (/reduce the length of the (messages|conversation)|truncat[^.\n]{0,20}(prompt|input)/i.test(m)) return true
  if (/上下文(长度)?(超|过)限|超出(最大)?上下文|上下文窗口(不足|超)/.test(m)) return true
  // 兜底：明确是 400/invalid_request 且同时提到 context / token / length
  if (/(^|\D)400(\D|$)|invalid_request_error/i.test(m) && /context|token|length/i.test(m)) return true
  return false
}

// ---------------------------------------------------------------------------
// 压缩区间挑选
// ---------------------------------------------------------------------------

export interface CompactionPlan {
  /** 被压缩区间（左闭右开，索引基于传入的 items） */
  startIndex: number
  endIndex: number
  /** 被压缩的消息条数 */
  dropped: number
  /** 逐字保留的消息条数（含当前任务输入） */
  kept: number
}

/**
 * 挑选「可压缩的旧轮次区间」：
 *  - 首条 system（若有）永不压缩；
 *  - 从末尾往前数 `keepTurns` 个 user 消息，它们及其之后的内容逐字保留；
 *  - 其余前段整体压缩（以 user 边界切分，不会留下悬空的 tool 消息）。
 * 无法形成有效区间（轮次不足 / 可丢消息太少）时返回 null。
 */
export function pickCompactionRange(
  items: readonly BudgetMessage[],
  opts: { keepTurns?: number; minDrop?: number } = {},
): CompactionPlan | null {
  const keepTurns = Math.max(1, Number(opts.keepTurns) || COMPACT_KEEP_TURNS)
  const minDrop = Math.max(1, Number(opts.minDrop) || 2)
  if (!items?.length) return null
  const start = items[0]?.role === 'system' ? 1 : 0
  let seen = 0
  let keepFrom = items.length
  for (let i = items.length - 1; i >= start; i--) {
    if (items[i]?.role === 'user') {
      seen++
      if (seen >= keepTurns) { keepFrom = i; break }
    }
  }
  if (seen < keepTurns) return null
  if (keepFrom <= start) return null
  const dropped = keepFrom - start
  if (dropped < minDrop) return null
  return { startIndex: start, endIndex: keepFrom, dropped, kept: items.length - keepFrom }
}

// ---------------------------------------------------------------------------
// 摘要提示词
// ---------------------------------------------------------------------------

/** 压缩器系统提示（要求结构化、可操作、不臆测；语言随对话内容） */
export const COMPACT_SYSTEM_PROMPT = [
  '你是对话上下文压缩器。把给定的早期对话压缩成一份结构化摘要，供后续步骤继续工作使用。',
  '只输出摘要本身：不要前言、不要解释、不要代码围栏。',
  '必须保留（若原文有）：',
  '1. 用户任务目标、明确约束与偏好；',
  '2. 已完成的事实与结论（含关键数字、名称、标识符）；',
  '3. 涉及的文件路径 / 目录 / 命令 / 接口；',
  '4. 未决问题、报错原文要点与已试过但失败的方案；',
  '5. 当前计划与待办进度。',
  '不要复述原文，不要臆测；无法确定的信息标注「未确认」。',
  '输出语言与对话内容保持一致（中文对话输出中文）。',
].join('\n')

/** 压缩后的历史以该标签包裹后注入（模型据此知道前文已被压缩） */
export function compactedContextMessage(summary: string): string {
  return `<compacted_context>\n${summary.trim()}\n</compacted_context>`
}

/**
 * 无 LLM 兜底摘要：摘要模型不可用时（超时/报错/离线），仍要保证「绝不因超限中断」。
 * 保留被压缩区间的可操作索引：用户要求、助手结论、工具调用与关键参数、工具结果摘要。
 */
export function indexSummary(items: readonly BudgetMessage[]): string {
  const lines: string[] = ['（自动摘要不可用，以下为被压缩区间的关键信息索引）']
  for (const m of items) {
    const text = String(m?.content || '').replace(/\s+/g, ' ').trim()
    if (m?.role === 'user') lines.push(`- 用户要求: ${text.slice(0, 200)}`)
    else if (m?.role === 'assistant') {
      if (text) lines.push(`- 助手结论: ${text.slice(0, 200)}`)
      for (const c of (Array.isArray(m?.toolCalls) ? m.toolCalls : [])) {
        let args = ''
        try { args = JSON.stringify(c?.arguments ?? '') ?? '' } catch { /* 忽略 */ }
        lines.push(`- 调用工具 ${c?.name || 'tool'}: ${args.slice(0, 160)}`)
      }
    } else if (m?.role === 'tool') {
      lines.push(`- 工具结果: ${text.slice(0, 120)}`)
    }
  }
  return lines.slice(0, 200).join('\n')
}

/** 把待压缩消息拼成转录文本（单条与整体都有字符上限，防止摘要请求自身超限） */
export function buildCompactionPrompt(
  items: readonly BudgetMessage[],
  opts: { maxPerMessage?: number; maxTotalChars?: number } = {},
): string {
  const per = Math.max(200, Number(opts.maxPerMessage) || COMPACT_PER_MESSAGE_CHARS)
  const total = Math.max(2000, Number(opts.maxTotalChars) || COMPACT_MAX_TRANSCRIPT_CHARS)
  const parts: string[] = []
  for (const m of items) {
    const role = m?.role || 'user'
    let text = typeof m?.content === 'string' ? m.content : ''
    if (m?.toolCalls?.length) {
      try { text += `\n[tool_calls] ${JSON.stringify(m.toolCalls)}` } catch { /* 忽略 */ }
    }
    if (text.length > per) text = text.slice(0, per) + `\n…（本条已截断，原 ${text.length} 字符）`
    parts.push(`### ${role}\n${text}`)
  }
  let out = parts.join('\n\n')
  if (out.length > total) out = out.slice(0, total) + '\n…（转录已截断）'
  return `以下是需要压缩的早期对话（按时间顺序）：\n\n${out}\n\n请输出结构化摘要。`
}
