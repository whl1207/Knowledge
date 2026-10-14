/**
 * truncation.selftest.ts — `finish_reason=length` 截断续跑判定自测（纯计算）
 *
 * 覆盖六个判定分支与边界：非 length、零产出、有工具调用、有 steer、
 * 额度未满、额度用尽、额度复位语义、非法入参。
 *
 * 用法：`npm run test:selftest`
 */

import { decideTruncationContinue, type TruncationDecisionInput } from './truncation'

export interface TruncationCase {
  name: string
  ok: boolean
  detail?: string
}

/** 默认输入：一次正常结束的 step（finish=stop、有正文、1 次工具调用） */
function base(over: Partial<TruncationDecisionInput> = {}): TruncationDecisionInput {
  return {
    finishReason: 'stop',
    contentChars: 100,
    toolCallCount: 1,
    hasPendingSteer: false,
    continuesSoFar: 0,
    maxContinues: 3,
    ...over,
  }
}

export function runTruncationSelfTest(): TruncationCase[] {
  const cases: TruncationCase[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  // 1. 正常结束：什么都不做
  {
    const d = decideTruncationContinue(base())
    add('非 length：不判定为截断', !d.truncated && !d.shouldContinue && !d.gaveUp)
  }

  // 2. 各种非 length 的 finish_reason 都不续跑
  {
    const reasons = ['stop', 'tool_calls', 'content_filter', 'function_call', '', 'STOP', 'Length']
    const bad = reasons.filter((r) => decideTruncationContinue(base({ finishReason: r, toolCallCount: 0 })).shouldContinue)
    add('非 length 一律不续跑（含大小写不匹配）', bad.length === 0, bad.join(','))
  }

  // 3. 核心场景：被截断 + 有正文 + 无工具调用 → 续跑
  {
    const d = decideTruncationContinue(base({ finishReason: 'length', contentChars: 500, toolCallCount: 0 }))
    add('截断 + 有正文 + 无工具调用 → 续跑', d.truncated && d.shouldContinue && !d.gaveUp)
  }

  // 4. 截断但零产出：记为截断但不续跑（再请求一次也不会有新内容）
  {
    const d = decideTruncationContinue(base({ finishReason: 'length', contentChars: 0, toolCallCount: 0 }))
    add('截断 + 零产出 → 不续跑（不浪费调用）', d.truncated && !d.shouldContinue && !d.gaveUp)
    const whitespace = decideTruncationContinue(base({ finishReason: 'length', contentChars: 0, toolCallCount: 0 }))
    add('截断 + 只有空白（trim 后为 0）→ 不续跑', !whitespace.shouldContinue)
  }

  // 5. 截断但本步有工具调用：交给"工具调用欠一次请求"的既有路径，不重复驱动
  {
    const d = decideTruncationContinue(base({ finishReason: 'length', contentChars: 10, toolCallCount: 2 }))
    add('截断 + 有工具调用 → 不因截断续跑（走工具路径）', d.truncated && !d.shouldContinue && !d.gaveUp)
  }

  // 6. steer 优先，且不消耗额度
  {
    const d = decideTruncationContinue(base({ finishReason: 'length', contentChars: 10, toolCallCount: 0, hasPendingSteer: true }))
    add('截断 + 有 steer → 让位给 steer', d.truncated && !d.shouldContinue && !d.gaveUp)
    // 让位不等于放弃：gaveUp=false，因此调用方不会误报"任务可能未完成"
    add('让位给 steer 时不算放弃', !d.gaveUp)
  }

  // 7. 额度边界：未满续跑 / 刚好用尽放弃
  {
    const justUnder = decideTruncationContinue(base({ finishReason: 'length', contentChars: 10, toolCallCount: 0, continuesSoFar: 2, maxContinues: 3 }))
    add('额度 2/3 → 续跑（第 3 次）', justUnder.shouldContinue && !justUnder.gaveUp)

    const atLimit = decideTruncationContinue(base({ finishReason: 'length', contentChars: 10, toolCallCount: 0, continuesSoFar: 3, maxContinues: 3 }))
    add('额度 3/3 → 放弃续跑', !atLimit.shouldContinue && atLimit.gaveUp && atLimit.truncated)

    const over = decideTruncationContinue(base({ finishReason: 'length', contentChars: 10, toolCallCount: 0, continuesSoFar: 99, maxContinues: 3 }))
    add('额度超限 → 仍放弃（不因计数异常而放开）', !over.shouldContinue && over.gaveUp)
  }

  // 8. maxContinues=0：一次都不续跑，直接明确告知
  {
    const d = decideTruncationContinue(base({ finishReason: 'length', contentChars: 10, toolCallCount: 0, maxContinues: 0 }))
    add('额度为 0 → 直接放弃并告知', !d.shouldContinue && d.gaveUp)
  }

  // 9. 非法入参不产生"续跑"这种有副作用的判定
  {
    const nan = decideTruncationContinue(base({ finishReason: 'length', contentChars: 10, toolCallCount: 0, continuesSoFar: NaN, maxContinues: NaN }))
    add('NaN 额度 → 归零后放弃（不无限续跑）', !nan.shouldContinue && nan.gaveUp)
    const neg = decideTruncationContinue(base({ finishReason: 'length', contentChars: 10, toolCallCount: 0, continuesSoFar: -5, maxContinues: 3 }))
    add('负数计数 → 夹到 0 后按正常额度续跑', neg.shouldContinue)
  }

  // 10. 纯函数：同样输入必得同样输出（可重放）
  {
    const a = decideTruncationContinue(base({ finishReason: 'length', contentChars: 10, toolCallCount: 0 }))
    const b = decideTruncationContinue(base({ finishReason: 'length', contentChars: 10, toolCallCount: 0 }))
    add('确定性：同输入同输出', JSON.stringify(a) === JSON.stringify(b))
  }

  return cases
}

/** 打印自测结果并返回是否全通过 */
export function logTruncationSelfTest(): boolean {
  const cases = runTruncationSelfTest()
  const failed = cases.filter((c) => !c.ok)
  // eslint-disable-next-line no-console
  console.table(cases.map((c) => ({ 用例: c.name, 结果: c.ok ? '通过' : '失败', 备注: c.detail ?? '' })))
  // eslint-disable-next-line no-console
  console.log(`[truncation] ${cases.length - failed.length}/${cases.length} 通过`)
  return failed.length === 0
}
