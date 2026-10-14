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

/** 压缩时逐字保留的最近用户轮次数（token 预算不可用时的回退口径） */
export const COMPACT_KEEP_TURNS = 3

/**
 * 压缩时逐字保留的近期上下文比例（**主口径**，对齐 DSH 的 `retainRatio: 0.16`）。
 *
 * 为什么主口径是 token 比例而不是"保留 N 轮"：
 * 「3 轮」在"每轮只问一句话"和"每轮带 10 个工具结果"之间差两个数量级。
 * 轮次口径会让后者在压缩后依然远超窗口，前者则白压了本可以保留的上下文。
 * 按「窗口的固定比例」保留近期尾部，"还剩多少空间"才是可控的。
 */
export const COMPACT_RETAIN_RATIO = 0.16

/** 压缩最少要丢掉多少条消息（否则不值得为一次摘要调用花一次 LLM 请求） */
export const COMPACT_MIN_DROP = 2

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

/**
 * 工具 schema 的 token 估算：按真实下发形态（`[{type:'function',function:{...}}]`）序列化后估算。
 * 早年用「工具数 × 140」的固定值，实测与本项目 schema 体量接近（41 个工具约 5.4k tokens），
 * 但换成显式序列化后能跟随 schema 增减（PTC 模式只有 1 个 run_code；插件工具可动态追加）。
 */
export function estimateToolSchemaTokens(tools: readonly any[] | null | undefined): number {
  const list = tools || []
  if (!list.length) return 0
  try {
    return estimateTokens(JSON.stringify(list) ?? '')
  } catch {
    return list.length * TOOL_SCHEMA_TOKEN_ESTIMATE
  }
}

/** 真实用量锚点：上一次请求由 provider 自报的 promptTokens + 当时发出的条目数 */
export interface TokenAccountingAnchor {
  /** 该次请求发出的条目数（派生条目与预算条目一一对应） */
  entryCount: number
  /** provider 自报的真实 prompt 计数（含 system prompt 与工具 schema） */
  promptTokens: number
}

/** 估算校准系数的合法区间：本地 tokenizer 与字符启发式的偏差可达 ±30%，超出区间视为异常样本 */
export const TOKEN_SCALE_MIN = 0.5
export const TOKEN_SCALE_MAX = 2.5

/** 把校准系数夹到合法区间（非法值回落 1） */
export function clampTokenScale(value: unknown): number {
  const n = Number(value)
  if (!(n > 0)) return 1
  return Math.min(TOKEN_SCALE_MAX, Math.max(TOKEN_SCALE_MIN, n))
}

/**
 * 用「真实计数 / 本次估算」更新校准系数（EWMA，新样本权重 0.3）。
 *
 * 为什么需要：字符启发式与各模型 tokenizer 差异是**系统性**的，且对代码/JSON 这类
 * 内容偏差最大（实测 Ollama gemma4 上代码/工具结果 JSON 的真实值是估算的 1.30 倍）。
 * 工具结果（read_file 内容）与工具参数（write_file 正文）正是这两类内容，
 * 不校准就会系统性低估 → 压缩触发太晚。
 */
export function calibrateTokenScale(prev: number, estimate: number, real: number): number {
  const base = clampTokenScale(prev)
  if (!(Number(estimate) > 0) || !(Number(real) > 0)) return base
  const sample = Number(real) / Number(estimate)
  if (!Number.isFinite(sample) || sample <= 0) return base
  return clampTokenScale(base * 0.7 + sample * 0.3)
}

/**
 * 智能体「请求前预算」：优先用 provider 自报的真实计数做锚点，只对锚点之后新增的
 * 内容做估算（并乘校准系数）；没有锚点（本会话第一次请求 / 刚压缩过）时回退纯估算。
 *
 * 口径说明：
 *  - 有锚点：`used = 锚点真实值 + 新增内容估算 × 系数`（锚点已含 system prompt 与工具 schema，
 *    不能再加 schemaTokens，否则重复计入）；
 *  - 无锚点：`used = 全部条目估算 × 系数 + 工具 schema`。
 */
export function planAgentBudget(opts: {
  limit?: number
  /** 与请求消息一一对应的预算条目（含附图张数） */
  entries: readonly BudgetMessage[]
  /** 工具 schema 的 token（无锚点时计入） */
  schemaTokens?: number
  anchor?: TokenAccountingAnchor | null
  /** 估算校准系数（真实 / 估算） */
  scale?: number
  reserve?: number
}): ContextBudget {
  const scale = clampTokenScale(opts.scale)
  const entries = opts.entries || []
  const anchor = opts.anchor
  if (anchor && Number(anchor.promptTokens) > 0 && entries.length >= Number(anchor.entryCount)) {
    const delta = entries.slice(Number(anchor.entryCount))
    const used = Number(anchor.promptTokens) + estimateMessagesTokens(delta) * scale
    return planContextBudget({ limit: opts.limit, used, reserve: opts.reserve })
  }
  const used = estimateMessagesTokens(entries) * scale + (Number(opts.schemaTokens) || 0)
  return planContextBudget({ limit: opts.limit, used, reserve: opts.reserve })
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
  /** 逐字保留尾部的估算 token（token 口径下才有；轮次口径为 undefined） */
  retainedTokens?: number
  /** 挑选口径（审计 / 日志用） */
  basis?: 'tokens' | 'turns'
}

// ---------------------------------------------------------------------------
// 工具配对平衡（复刻 DSH 的 tool-pairing balance）
// ---------------------------------------------------------------------------

/**
 * 计算每个位置作为切点是否"配对平衡"。
 *
 * 消息序列里，assistant 发起的 `tool_calls` 必须与紧随其后的 `role: 'tool'` 结果**成对出现**：
 * 在两者之间切开，就会得到"有 tool 结果、没有 tool 调用"（或反之）的历史，
 * 严格校验的服务端会直接 400，宽松的本地后端则可能静默丢弃。
 *
 * 与 DSH 的差异：DSH 按"未应答 tool-call 计数归零"判断（可以跨多条 assistant 消息）；
 * ai-km 的消息形态是 OpenAI 风格的**相邻配对**，因此这里用等价但更严的规则——
 * 切点前一条不能是 tool 结果，切点后一条不能是 tool 结果。两者都保证了同一件事：
 * 切完不会出现悬空的 tool 消息。
 *
 * @param items 消息序列
 * @returns `balanced[i]` 表示"在下标 i 之前切开是安全的"（i ∈ [0, items.length]）
 */
export function computePairingBalance(items: readonly BudgetMessage[]): boolean[] {
  const n = items?.length ?? 0
  const balanced = new Array<boolean>(n + 1).fill(true)
  if (n === 0) return balanced
  const isToolResult = (i: number) => items[i]?.role === 'tool'
  balanced[0] = true
  for (let i = 1; i <= n; i++) {
    // 切点前一条是 tool 结果 → 会把"调用 → 结果"拆开
    if (isToolResult(i - 1)) { balanced[i] = false; continue }
    // 切点后一条是 tool 结果 → 结果的前置调用被压掉，同样悬空
    if (i < n && isToolResult(i)) { balanced[i] = false; continue }
    balanced[i] = true
  }
  return balanced
}

/** 从 `from` 起的尾部估算 token（含 i 本身） */
function tailTokensFrom(items: readonly BudgetMessage[], from: number): number {
  let sum = 0
  for (let i = from; i < items.length; i++) sum += estimateMessageTokens(items[i])
  return sum
}

/**
 * 挑选「可压缩的旧轮次区间」：
 *  - 首条 system（若有）永不压缩；
 *  - 从末尾往前数 `keepTurns` 个 user 消息，它们及其之后的内容逐字保留；
 *  - 其余前段整体压缩（以 user 边界切分，不会留下悬空的 tool 消息）。
 * 无法形成有效区间（轮次不足 / 可丢消息太少）时返回 null。
 *
 * @deprecated 轮次口径对"每轮体积差异很大"的会话不可控，建议改用
 * {@link pickCompactionRangeByTokens}（按 token 预算保留尾部）。本函数保留给
 * 普通聊天等按轮次组织、且拿不到可靠窗口值的场景。
 */
export function pickCompactionRange(
  items: readonly BudgetMessage[],
  opts: { keepTurns?: number; minDrop?: number } = {},
): CompactionPlan | null {
  const keepTurns = Math.max(1, Number(opts.keepTurns) || COMPACT_KEEP_TURNS)
  const minDrop = Math.max(1, Number(opts.minDrop) || COMPACT_MIN_DROP)
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
  return { startIndex: start, endIndex: keepFrom, dropped, kept: items.length - keepFrom, basis: 'turns' }
}

export interface TokenCompactionOptions {
  /** 逐字保留尾部的 token 预算（优先；与 retainRatio/keepTurns 三选一） */
  retainTokens?: number
  /** 逐字保留尾部占**可用预算**的比例（`retainTokens` 缺省时用） */
  retainRatio?: number
  /**
   * 比例口径的**基准**（tokens）：应当传"可用预算"而不是原始窗口。
   *
   * 可用预算 = 窗口 − 预留输出 − 工具 schema。传原始窗口会在小窗口 + 多工具时高估余量：
   * 32K 窗口 + 41 个工具时 schema 就占 2.2K（6.9%），压缩却以为还有 20% 空间可留。
   * 由调用方用 {@link compactionBasisTokens} 算好传进来。
   */
  contextWindow?: number
  /** 保留的最近用户轮次下限（安全阀：即使 token 预算允许，也不要压掉最近这几轮） */
  keepTurns?: number
  /** 最少丢弃条数 */
  minDrop?: number
}

/**
 * 压缩比例口径的基准：**可用预算**（复刻 DSH 的
 * `messageBudgetTokens = contextWindow − reservedCompletionTokens`，
 * 再减掉它自己的 `headroomTokens`）。
 *
 * @param opts.limit 生效窗口
 * @param opts.reserve 预留的输出 token
 * @param opts.schemaTokens 工具 schema 的 token
 * @returns 用于压缩比例换算的基准 token（下限 1，绝不返回 0/负数）
 */
export function compactionBasisTokens(opts: { limit?: number; reserve?: number; schemaTokens?: number }): number {
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : FALLBACK_CONTEXT_WINDOW
  const reserve = Math.max(0, Number(opts.reserve) || 0)
  const schema = Math.max(0, Number(opts.schemaTokens) || 0)
  return Math.max(1, limit - reserve - schema)
}

/**
 * 按 **token 预算** 挑选可压缩区间（复刻 DSH 的 `selectCompactableRange`）。
 *
 * 语义：
 *  1. 首条 system 永不压缩；
 *  2. 从尾部往前累加估算 token，直到达到 `retainTokens` —— 这段逐字保留；
 *  3. 把切点**再往前回退**到最近一个「工具配对平衡」的位置（不允许拆开
 *     assistant tool_calls 与其 tool 结果）；
 *  4. 同时满足 `keepTurns` 下限（安全阀）与 `minDrop` 下限，否则返回 null。
 *
 * 与回退口径的区别：不再用"压到几轮之前"决定边界，而是"尾部还剩多少 token"，
 * 因此重工具链路（一次 read_file 就几万 token）不会因为"才 3 轮"而压不动。
 *
 * @param items 消息序列（system 在首位的形态）
 * @param opts 预算选项；没有可用 token 预算时自动回退 `pickCompactionRange`
 * @returns 压缩区间，或 null（无需 / 无法压缩）
 */
export function pickCompactionRangeByTokens(
  items: readonly BudgetMessage[],
  opts: TokenCompactionOptions = {},
): CompactionPlan | null {
  if (!items?.length) return null
  const minDrop = Math.max(1, Number(opts.minDrop) || COMPACT_MIN_DROP)
  const keepTurns = Math.max(1, Number(opts.keepTurns) || COMPACT_KEEP_TURNS)

  // 解析 token 预算；拿不到有效预算就回退轮次口径（行为与改造前一致）
  let retainTokens = Number(opts.retainTokens)
  if (!(retainTokens > 0)) {
    const ratio = Number(opts.retainRatio)
    const window = Number(opts.contextWindow)
    if (ratio > 0 && window > 0) retainTokens = Math.floor(window * ratio)
  }
  if (!(retainTokens > 0)) return pickCompactionRange(items, { keepTurns, minDrop })

  const start = items[0]?.role === 'system' ? 1 : 0
  if (start >= items.length) return null

  // 1) 尾部 token 预算：从后往前累加到 retainTokens
  let accumulated = 0
  let keepFrom = items.length
  for (let i = items.length - 1; i >= start; i--) {
    accumulated += estimateMessageTokens(items[i])
    keepFrom = i
    if (accumulated >= retainTokens) break
  }

  // 2) keepTurns 安全阀：逐字保留的尾部至少要覆盖最近 keepTurns 个 user 消息
  let seenUsers = 0
  let turnFloor = items.length
  for (let i = items.length - 1; i >= start; i--) {
    if (items[i]?.role === 'user') {
      seenUsers++
      turnFloor = i
      if (seenUsers >= keepTurns) break
    }
  }
  if (seenUsers >= keepTurns) keepFrom = Math.min(keepFrom, turnFloor)

  // 3) 配对平衡回退：不允许把 tool_calls 与它的 tool 结果切开
  const balanced = computePairingBalance(items)
  while (keepFrom > start && !balanced[keepFrom]) keepFrom--

  if (keepFrom <= start) return null
  const dropped = keepFrom - start
  if (dropped < minDrop) return null
  return {
    startIndex: start,
    endIndex: keepFrom,
    dropped,
    kept: items.length - keepFrom,
    retainedTokens: tailTokensFrom(items, keepFrom),
    basis: 'tokens',
  }
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
