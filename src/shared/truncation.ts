/**
 * truncation.ts — `finish_reason=length` 截断续跑的判定（纯函数）
 *
 * **为什么单独成文件**：这是 agent 循环里"截断后该怎么办"的唯一判定点。
 * 判错的两个方向都很糟：
 *  - 该续跑却结束 → 模型"任务做到一半被截断"被当成"任务做完了"，**没有任何信号**（比报错更糟）；
 *  - 不该续跑却续跑 → 模型撞 max_tokens 时无限续跑，白白烧 token。
 * 所以把六个条件抽成纯函数，让它可以被自测覆盖（见 `truncation.selftest.ts`），
 * 而不是埋在 `runTurn` 的闭包里只靠人眼审。
 *
 * 复刻自 DSH `dsh-agent-loop`：那里把 `finish.kind === "max-tokens"` 单独作为一种 step 结果
 * （`return { kind: "max-tokens" }`），`turn()` 里用它决定"还不结束 turn、再走一个 step"；
 * 其余情况才按 `toolCalls.length === 0 → completed` 收尾。
 */

/**
 * 一次 step 结束时，用于判断"是否因截断而继续"的输入。
 * 字段全部来自 agent 循环已经算好的结果，判定本身不产生副作用。
 */
export interface TruncationDecisionInput {
  /** 本步的 finish_reason（`'length'` = 被 max_tokens / 上下文截断） */
  finishReason: string
  /** 本步 assistant 产出的正文长度（trim 后） */
  contentChars: number
  /** 本步模型点名调用的工具数 */
  toolCallCount: number
  /** 本步是否领取到了 steer（转向消息优先，不被续跑抢走） */
  hasPendingSteer: boolean
  /** 本 turn 已经因截断续跑过几次 */
  continuesSoFar: number
  /** 允许的最大续跑次数 */
  maxContinues: number
}

/** 判定结果 */
export interface TruncationDecision {
  /** 是否本步确实被截断（且产出了内容——空输出续跑没有意义） */
  truncated: boolean
  /** 是否要为此再走一个 step */
  shouldContinue: boolean
  /** 是否"截断了但达到上限、放弃续跑"（需要明确告知用户，不能静默） */
  gaveUp: boolean
}

/**
 * 判定 `finish_reason=length` 之后的行为。
 *
 * 规则（顺序即优先级）：
 *  1. 不是 `length` → 不续跑（`truncated: false`）；
 *  2. 被截断但**本步没有任何产出**（正文为空且没有工具调用）→ 记 truncated，但不续跑：
 *     空输出说明再请求一次也不会有新内容，只是浪费一次调用；
 *  3. 本步有工具调用 → 不因截断而续跑：工具结果会自然驱动下一个 step（走工具那条路径）；
 *  4. 领取到了 steer → 让位给 steer（用户的转向意图优先于自动续跑），但**不消耗**续跑额度；
 *  5. 未达上限 → 续跑（`shouldContinue: true`）；
 *  6. 达到上限 → 放弃续跑并标记 `gaveUp`（调用方据此发"任务可能未完成"的提示）。
 *
 * @param input 判定输入
 * @returns 判定结果
 */
export function decideTruncationContinue(input: TruncationDecisionInput): TruncationDecision {
  const maxContinues = Math.max(0, Math.floor(Number(input.maxContinues) || 0))
  const continuesSoFar = Math.max(0, Math.floor(Number(input.continuesSoFar) || 0))
  const truncatedByLength = input.finishReason === 'length'

  // 1. 不是截断：什么都不做
  if (!truncatedByLength) return { truncated: false, shouldContinue: false, gaveUp: false }

  // 2. 截断了但零产出：记为截断（供上层计数/提示），但不值得再请求一次
  if (input.contentChars <= 0 && input.toolCallCount === 0) {
    return { truncated: true, shouldContinue: false, gaveUp: false }
  }

  // 3. 有工具调用：交给"工具调用欠一次请求"的既有路径，不重复驱动
  if (input.toolCallCount > 0) return { truncated: true, shouldContinue: false, gaveUp: false }

  // 4. steer 优先，且不消耗续跑额度
  if (input.hasPendingSteer) return { truncated: true, shouldContinue: false, gaveUp: false }

  // 5/6. 额度判定
  if (continuesSoFar < maxContinues) return { truncated: true, shouldContinue: true, gaveUp: false }
  return { truncated: true, shouldContinue: false, gaveUp: true }
}
