/**
 * toolResultBudget.ts — 工具结果的有界化（复刻 DSH 的 token 管控第一层）
 *
 * 背景（为什么要这一层）：工具返回的原文会**原样回灌模型**。真实运行里最占上下文的
 * 从来不是对话，而是少数几次"巨型工具结果"：`run_python` 打了一屏中间态、
 * `shell` 吐了整份构建日志、`kb_search` 命中几十条片段、`web_fetch` 抓回整页 HTML。
 * 一次就能吃掉几万 token，而且这些内容里真正有用的通常只有**开头**（结论 / 命中列表）
 * 和**结尾**（报错栈 / 汇总行）。
 *
 * 复刻自 DSH 的两条做法：
 *  1. `@deepseek-ai/dsh-compaction-tool-result-pruner`：结果正文超过阈值就**掐掉中段**，
 *     保留 head + tail，中段替换成一个固定标记；按 **Unicode 码点**计数（不是 UTF-16
 *     长度），因此不会把代理对切开；替换结果必须**严格小于**原文且在预算内，否则报错而不是
 *     静默输出一个没变小甚至变大的结果。
 *  2. `@deepseek-ai/dsh-output-retention` 的 `TextRetainer`：head / tail / headTail 三策略，
 *     按**码点**切，刻意不做码点补齐之外的"聪明"处理——只回答"留了什么、丢了什么"。
 *
 * 与 DSH 的差异（刻意保留，不要"对齐"掉）：
 *  - 本模块**只服务模型可见副本**。会话日志仍然落原文（详见 `tool/result.modelValue`），
 *    这对应 DSH 的「append-only 日志是唯一事实源，模型只看 surface」。
 *  - DSH 对每个工具结果独立定价；ai-km 的工具返回值形状多样（字符串 / 对象），
 *    所以这里提供 `boundToolResult()` 作为统一入口：先 `serializeToolValue` 成与
 *    `deriveMessages` 完全一致的那一份文本，再对其做有界化，避免"估算的文本"和
 *    "真正发出去的文本"是两份东西。
 *
 * 本模块是纯函数库：不读磁盘、不依赖 electron、不 import 平台层，
 * 因此主进程（`electron/main/agent-loop.ts`）与渲染层（`src/platform/rendererAgent.ts`）
 * 可以共用同一份实现与同一组阈值。
 */

// ---------------------------------------------------------------------------
// 预算与策略
// ---------------------------------------------------------------------------

/**
 * 有界化预算。默认值取自 DSH 本机 profile 的实际配置
 * （`dsh-base/cordis.patch.yml` 的 `tool-result-pruner`：8192 / 4096 / 1024），
 * 但 ai-km 的工具粒度更粗（`read_file` 一次就能返回 100KB、`web_fetch` 抓整页），
 * 因此把阈值放大到 16K，让"正常一次读取"不被切开、只有真正异常大的结果才动手。
 */
export interface ToolResultBudget {
  /** 超过这个码点数才掐中段 */
  thresholdChars: number
  /** 保留开头多少码点 */
  headChars: number
  /** 保留结尾多少码点（`headOnly` 策略下忽略） */
  tailChars: number
  /**
   * `headTail`（默认）：保留头尾，掐中段 —— 适合"结论在头、报错在尾"的命令 / 脚本输出。
   * `headOnly`：只保留开头 —— 适合结果本身已按相关性排序的工具（检索 / 目录列表），
   * 它们的尾部命中价值低，保留尾部反而会挤掉更有用的头部内容。
   */
  strategy?: 'headTail' | 'headOnly'
}

/** 截断标记（与 DSH 同款措辞，便于对照阅读；纯 ASCII 以免污染上下文） */
export const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'

/** 默认预算（大窗口/未知窗口时使用）：超过 16K 码点才掐，头部保 12K、尾部保 2K */
export const DEFAULT_TOOL_RESULT_BUDGET: ToolResultBudget = Object.freeze({
  thresholdChars: 16_384,
  headChars: 12_288,
  tailChars: 2_048,
  strategy: 'headTail',
})

// ---------------------------------------------------------------------------
// 按窗口缩放（小窗口的关键）
// ---------------------------------------------------------------------------

/**
 * 单条工具结果最多占窗口的比例（**主口径**）。
 *
 * 为什么必须按比例而不是固定值：固化到 16K 字符时，在 1M 窗口里只占 1.6%，
 * 在 32K 窗口里却占 11%（英文）~34%（中文）——一次 `kb_search` + 一次 `read_file`
 * 就能逼近压缩阈值，触发压缩 → 摘要 → 很快又触发，形成"压缩抖动"。
 * 取 12%：留出约 8 条工具结果的余量，同时保证单条结果仍有实用信息量。
 */
export const TOOL_RESULT_WINDOW_RATIO = 0.12

/**
 * 预算的 token 上下限。
 * - 下限 3000：再小就连"文件路径 + 少量命中"都放不下，工具会变得不可用；
 * - 上限 16384：大窗口下仍需有界，且等于原先经实测的默认值（大窗口行为不变）。
 */
export const TOOL_RESULT_TOKENS_MIN = 3_000
export const TOOL_RESULT_TOKENS_MAX = 16_384

/**
 * **未知窗口**时的保底阈值（码点）＝历史上用的 16K 字符。
 *
 * 刻意保留原值（而不是折算成 16384 tokens）：窗口读不到时不缩小既有行为，
 * 大窗口后端与"窗口未知"两条路径都不受影响。已知窗口时一律按比例缩放。
 */
export const UNKNOWN_WINDOW_THRESHOLD_CHARS = 16_384

/** 纯 ASCII / JSON 的字符-码点换算是 1:1，但**预算单位是 token**，需要折算 */
export const ASCII_CHARS_PER_TOKEN = 4

/**
 * 最坏情况的码点/token 比（CJK 实测约 1.4~1.8）。
 * 用它把 token 预算翻译成码点上限：宁可保守（英文内容少留一点），
 * 也不要按 4 折算导致中文内容实际吃掉 2~2.5 倍预算。
 */
export const WORST_CASE_CHARS_PER_TOKEN = 2

/** 窗口 → 工具结果预算（token）；传 0 / 缺省时回落到大窗口默认上限 */
export function toolResultTokensForWindow(windowTokens?: number): number {
  const w = Number(windowTokens)
  if (!(w > 0)) return TOOL_RESULT_TOKENS_MAX
  const raw = Math.floor(w * TOOL_RESULT_WINDOW_RATIO)
  return Math.min(TOOL_RESULT_TOKENS_MAX, Math.max(TOOL_RESULT_TOKENS_MIN, raw))
}

/**
 * 窗口 → 工具结果预算（**码点**，即 `ToolResultBudget` 的单位）。
 *
 * 分配：约 75% 头 + 12.5% 尾 + 12.5% 留给截断标记与续读提示。
 * 窗口未知（0/undefined）时回落到 {@link DEFAULT_TOOL_RESULT_BUDGET}（= 历史行为）。
 */
export function toolResultBudgetForWindow(windowTokens?: number): ToolResultBudget {
  const w = Number(windowTokens)
  if (!(w > 0)) return DEFAULT_TOOL_RESULT_BUDGET
  const chars = Math.max(1, toolResultTokensForWindow(w) * WORST_CASE_CHARS_PER_TOKEN)
  return {
    thresholdChars: chars,
    headChars: Math.floor(chars * 0.75),
    tailChars: Math.floor(chars * 0.125),
    strategy: 'headTail',
  }
}

// ---------------------------------------------------------------------------
// 第二层：超大结果落盘（spill）
// ---------------------------------------------------------------------------

/**
 * 落盘门槛 = 该窗口下"第一层预算"的多少倍（**相对值**）。
 *
 * 为什么必须相对：原先是固定 200K 码点，而第一层在 16K 字符处就掐了，
 * 于是 `bounded.raw` 永远到不了 200K —— 落盘在 32K 窗口下成了**死代码**，
 * 模型被掐掉的中段永久丢失、没有任何回读能力。
 * 取 2 倍：只要"掐掉的中段明显大于落盘后的预览"，回读才有意义；
 * 一次 100KB 的 `read_file`（第一层预算 6~8KB）会稳定触发落盘。
 */
export const TOOL_RESULT_SPILL_BUDGET_MULTIPLE = 2

/** 落盘预览的预算 = 第一层预算（预览本身也要有界；头/尾比例沿用 75/12.5） */
export function spillPreviewBudgetForWindow(windowTokens?: number): ToolResultBudget {
  return toolResultBudgetForWindow(windowTokens)
}

/** 该窗口下的落盘门槛（码点）；窗口未知时按保底预算推导 */
export function spillThresholdForWindow(windowTokens?: number): number {
  const budget = toolResultBudgetForWindow(windowTokens)
  return Math.max(1, budget.thresholdChars * TOOL_RESULT_SPILL_BUDGET_MULTIPLE)
}

/**
 * 落盘产物在磁盘上的位置（由存储实现填写）。
 * 渲染层（手机 / 网页）没有可写的文件系统，因此**没有**这个能力，该能力仅在桌面主进程提供。
 */
export interface SpillRef {
  /** 可直接交给 `read_file` 的绝对路径 */
  path: string
  /** 完整文本的字节数 */
  bytes: number
}

/** 落盘后的预览 + 定位提示（模型可见） */
export interface SpillPreview {
  text: string
  /** 模型可见文本的码点数 */
  previewChars: number
  /** 原文码点数 */
  originalChars: number
  /** 完整文本落盘的位置 */
  ref: SpillRef
}

/** 落盘提示语。措辞对齐 DSH spill notice，并把"用什么工具回读"讲清楚。 */
export function spillNotice(ref: SpillRef, omittedChars: number): string {
  return `\n\n[... middle pruned ...]\n\n(Omitted ${omittedChars} chars. Full result stored at: ${ref.path}. `
    + '需要完整内容时用 read_file 读取该文件（可用 offset/limit 只读需要的区段），'
    + '或用 search_files 在该路径内检索；不要仅凭以上预览下结论。)\n\n'
}

/**
 * 构造落盘后的模型可见文本：`头 + 尾 + 定位提示`，**整体**在预览预算内。
 *
 * 先按提示的实际长度预留，再决定头尾留多长——与 DSH spill-policy 的 `reserve` 同一手法，
 * 避免"预览刚好达标、拼上提示就超标"。
 *
 * @param windowTokens 该会话的上下文窗口（决定预览预算；缺省用大窗口默认值）
 */
export function buildSpillPreview(
  text: string,
  ref: SpillRef,
  windowTokens?: number,
): SpillPreview {
  const budget = spillPreviewBudgetForWindow(windowTokens)
  const originalChars = countCodePoints(text)
  const omitted = Math.max(0, originalChars - budget.thresholdChars)
  const notice = spillNotice(ref, omitted)
  const noticeChars = countCodePoints(notice)
  const bounded = boundToolResultText(text, budget, noticeChars)
  return {
    text: bounded.text + notice,
    previewChars: countCodePoints(bounded.text) + noticeChars,
    originalChars,
    ref,
  }
}

/**
 * 该结果是否超过落盘门槛（只看原文码点数，与工具无关）。
 *
 * @param windowTokens 该会话的上下文窗口；门槛 = 该窗口下第一层预算 × 2。
 *   不传时按大窗口默认预算推导（大窗口行为与改造前一致）。
 */
export function shouldSpill(text: string, windowTokens?: number): boolean {
  return countCodePoints(text) > spillThresholdForWindow(windowTokens)
}

/** 只保头部的工具：返回值已按相关性 / 重要性排序，尾部没有额外价值 */
const HEAD_ONLY_TOOLS = new Set<string>([
  'list_dir',
  'search_files',
  'kb_search',
  'web_search',
  'read_file',
])

/**
 * 每个工具"被掐掉之后怎么办"的提示语。
 *
 * 这一层是 **ai-km 特有**的，DSH 不需要：DSH 的 spill notice 会说
 * "Full result stored at: <path>. Use read offset/limit" —— 因为它有 spill 文件可回读。
 * ai-km 的第一层没有落盘（那是第 ② 步的事），所以必须告诉模型**用什么工具把剩下的拿回来**，
 * 否则模型会以为"内容就这么多"，得出错误结论（这正是最危险的失败模式）。
 */
const CONTINUATION_HINTS: Record<string, string> = {
  read_file: '内容仍不完整：用同一个 read_file 带上 offset = 上次返回的 nextOffset 继续读，'
    + '反复续读直到 truncated=false 才算读完（不要只读第一段就下结论）。',
  list_dir: '列表已被截断：目录条目过多。请改用 search_files 按文件名 / 后缀精确检索，或缩小到子目录再列。',
  search_files: '结果已被截断：命中过多。请收窄 pattern（更具体的正则 / 后缀过滤）后重试。',
  kb_search: '命中片段已被截断：请缩小问题范围、换更具体的关键词，或减少 topK 后重新检索。',
  web_search: '搜索结果已被截断：请换更精确的查询词，或直接用 web_fetch 打开最相关的那一条。',
  web_fetch: '正文已被截断（只保留了开头与结尾）。需要中间部分时，改用更具体的 URL / 站内检索定位后再抓取。',
  run_python: '输出已被截断（只保留了开头与结尾）。需要完整数据时，请让代码只 print 结论 / 汇总行，或把完整结果写进文件后再读取。',
  shell: '输出已被截断（只保留了开头与结尾）。需要完整输出时，请把命令输出重定向到文件，再用 read_file 分段读取。',
}

/** 该工具被截断时的续读提示（没有专属提示则用通用兜底） */
export function continuationHintFor(name: string): string {
  const n = String(name || '')
  return CONTINUATION_HINTS[n]
    ?? '结果已被截断（只保留了开头' + (HEAD_ONLY_TOOLS.has(n) ? '' : '与结尾') + '）。请缩小本次请求的范围后重试。'
}

/** 工具的预算（含 per-tool 策略）；未知工具用默认预算 */
export function budgetForTool(name: string, base: ToolResultBudget = DEFAULT_TOOL_RESULT_BUDGET): ToolResultBudget {
  return HEAD_ONLY_TOOLS.has(String(name || ''))
    ? { ...base, strategy: 'headOnly' }
    : base
}

// ---------------------------------------------------------------------------
// 有界化
// ---------------------------------------------------------------------------

/** 丢弃了多少内容（四舍五入到"码点"，因为只有掐中段一种丢法） */
export interface OmittedChars {
  kind: 'exact'
  count: number
}

/** 有界化结果：模型可见的那一份文本 + 精确的丢弃计量 */
export interface BoundedText {
  /** 模型可见文本（可能已掐中段） */
  text: string
  /** 是否发生了掐中段 */
  pruned: boolean
  /** 丢弃计量（未掐时为 undefined） */
  omitted?: OmittedChars
  /** 原文码点数（审计 / UI 展示用） */
  originalChars: number
}

/** 码点数（不切断代理对：用 Array.from 而不是 .length） */
export function countCodePoints(text: string): number {
  return Array.from(String(text ?? '')).length
}

/**
 * 按预算有界化一段文本。
 *
 * 语义（严格对齐 DSH 的 pruner）：
 *  - 码点数 ≤ `thresholdChars`：原样返回，`pruned: false`；
 *  - 超出：`headTail` 保前 `headChars` + 标记 + 后 `tailChars`；
 *    `headOnly` 保前 `thresholdChars - 标记长度`；
 *  - 结果必须**严格小于**原文且在预算内，否则抛错（配置错误应当显式暴露，
 *    不能悄悄发一个没变小的结果给模型）；
 *  - 预算装不下"标记 + 头 + 尾"时抛错（同 DSH 的 `emittedChars > thresholdChars` 校验）。
 *
 * @param text 原始文本
 * @param budget 预算（默认 `DEFAULT_TOOL_RESULT_BUDGET`）
 * @param reserveChars 额外预留的码点数（调用方随后要拼的"续读提示"长度）。
 *   与 DSH spill-policy 的 `reserve` 同义：先扣掉尾注，再决定预览留多长，
 *   保证最终发出去的文本**仍然在预算内**，而不是"预览刚好达标、加上提示就超标"。
 * @returns 有界化结果
 * @throws 预算自相矛盾，或替换结果没有变小
 */
export function boundToolResultText(
  text: string,
  budget: ToolResultBudget = DEFAULT_TOOL_RESULT_BUDGET,
  reserveChars = 0,
): BoundedText {
  const raw = String(text ?? '')
  const originalChars = countCodePoints(raw)
  const threshold = Math.floor(Number(budget?.thresholdChars))
  const headChars = Math.max(0, Math.floor(Number(budget?.headChars)))
  const tailChars = Math.max(0, Math.floor(Number(budget?.tailChars)))
  const strategy = budget?.strategy ?? 'headTail'
  const reserve = Math.max(0, Math.floor(Number(reserveChars) || 0))

  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw new Error(`toolResultBudget: thresholdChars 必须是正整数（收到 ${budget?.thresholdChars}）`)
  }
  if (originalChars <= threshold) {
    return { text: raw, pruned: false, originalChars }
  }

  const markerChars = countCodePoints(PRUNE_MARKER)
  const points = Array.from(raw)

  if (strategy === 'headOnly') {
    // 头 + 标记 + 预留，整体不超过阈值
    const keep = threshold - markerChars - reserve
    if (keep < 0) {
      throw new Error(
        `toolResultBudget: 预算 ${threshold} 装不下截断标记（${markerChars}）与预留（${reserve}）码点，`
        + '请提高 thresholdChars 或缩短标记 / 提示语',
      )
    }
    return finishBounded(points.slice(0, keep).join('') + PRUNE_MARKER, originalChars, threshold - reserve)
  }

  const emitted = headChars + markerChars + tailChars + reserve
  if (emitted > threshold) {
    throw new Error(
      `toolResultBudget: headChars + 标记 + tailChars + 预留（${emitted} 码点）不得超过 thresholdChars（${threshold}），请调整预算`,
    )
  }
  const out = points.slice(0, headChars).join('') + PRUNE_MARKER + points.slice(points.length - tailChars).join('')
  return finishBounded(out, originalChars, threshold - reserve)
}

/** 收口：校验"确实变小了、且在预算内"，并给出精确丢弃量（与 DSH pruner 的断言同义） */
function finishBounded(out: string, before: number, threshold: number): BoundedText {
  const after = countCodePoints(out)
  if (after >= before) {
    throw new Error(`toolResultBudget: 有界化必须让文本变小（${before} → ${after} 码点），请检查预算配置`)
  }
  if (after > threshold) {
    throw new Error(`toolResultBudget: 有界化后仍超过阈值（${after} > ${threshold} 码点）`)
  }
  return {
    text: out,
    pruned: true,
    omitted: { kind: 'exact', count: before - after },
    originalChars: before,
  }
}

// ---------------------------------------------------------------------------
// 工具返回值 → 模型可见文本（与 deriveMessages 同口径）
// ---------------------------------------------------------------------------

/**
 * 把工具返回值序列化成**模型可见的那一份文本**。
 *
 * 必须与 `electron/main/session-log.ts` 的 `deriveEntries` 保持同口径
 * （`res.ok ? JSON.stringify(res.value ?? null) : 'ERROR: …'`），否则"被有界化的文本"
 * 和"真正发出去的文本"会是两份东西，阈值就失去意义。
 */
export function serializeToolValue(ok: boolean, value: unknown, error?: string): string {
  if (!ok) return `ERROR: ${error || '工具执行失败'}`
  // 与 `deriveMessages` 的历史口径**逐字一致**（`JSON.stringify(res.value ?? null)`，字符串也会带引号）。
  // 刻意不去"修正"这层引号：这一层的职责只是让**超大**结果变小，任何口径改动都会顺带改变
  // 所有工具结果的字节，属于超出本层职责的行为变更。
  // `undefined` 兜底成 'null'：JSON.stringify(undefined) 返回 undefined（不是字符串），
  // 直接塞进 tool 消息的 content 会变成非字符串，宽松后端可能报错。
  const text = JSON.stringify(value ?? null)
  return typeof text === 'string' ? text : 'null'
}

/** 一次有界化的完整结果（含原文，便于调用方落盘 / 落日志） */
export interface BoundedToolResult {
  /** 与 `deriveMessages` 同口径的原文（未掐） */
  raw: string
  /** 模型可见文本（可能已掐） */
  model: string
  /** 是否掐了中段 */
  pruned: boolean
  /** 丢弃计量 */
  omitted?: OmittedChars
  originalChars: number
}

/**
 * 工具返回值的统一有界化入口。
 *
 * 超过预算时，模型可见文本 = `头[+尾]` + 截断标记 + **续读提示**（见 `continuationHintFor`）。
 * 提示语长度会先从预算里扣掉，因此结果**整体**仍在预算内（不做"预览达标、加提示超标"的事）。
 *
 * @param name 工具名（决定 per-tool 策略与续读提示）
 * @param ok 工具是否成功
 * @param value 工具返回值
 * @param error 失败原因
 * @param budget 预算覆盖；不传时按 `windowTokens` 缩放（这是小窗口下最关键的一处）
 * @param opts.windowTokens 该会话的上下文窗口。**强烈建议传**：不传则用大窗口默认预算，
 *   在 32K 窗口下单条结果可能占到 1/3 窗口，引发压缩抖动。
 * @param opts.skipContinuationHint 适用于**引擎自己构造的短诊断**（参数解析失败 / 白名单拦截）：
 *   这类消息里没有任何"续读锚点"，套用工具专属提示（如 read_file 的 "用 nextOffset 继续读"）
 *   会指着一个不存在的字段，把模型带偏。此时只留标记、不给提示。
 */
export function boundToolResult(
  name: string,
  ok: boolean,
  value: unknown,
  error?: string,
  budget?: ToolResultBudget,
  opts: { skipContinuationHint?: boolean; windowTokens?: number } = {},
): BoundedToolResult {
  const effective = budget ?? toolResultBudgetForWindow(opts.windowTokens)
  const raw = serializeToolValue(ok, value, error)
  const originalChars = countCodePoints(raw)
  // 原文没超预算时不留任何提示：正常结果必须与改造前逐字一致
  if (originalChars <= Math.floor(Number(effective?.thresholdChars))) {
    return { raw, model: raw, pruned: false, originalChars }
  }
  const hint = opts.skipContinuationHint ? '' : continuationHintFor(name)
  const notice = hint.length > 0 ? `\n\n(${hint})` : ''
  const bounded = boundToolResultText(raw, budgetForTool(name, effective), countCodePoints(notice))
  return {
    raw,
    model: bounded.text + notice,
    pruned: true,
    ...(bounded.omitted ? { omitted: bounded.omitted } : {}),
    originalChars: bounded.originalChars,
  }
}

/** 人类可读的丢弃说明（与 DSH 的 `describeOmitted` 同款：exact 给数字，unknown 不给假精度） */
export function describeOmitted(omitted: OmittedChars | undefined, unit = 'chars'): string {
  if (!omitted) return ''
  return `Omitted ${omitted.count} ${unit}.`
}
