/**
 * contextBudget.selftest.ts — 压缩区间挑选自测（纯计算）
 *
 * 覆盖第 ③ 步改造：按 token 预算保留尾部、工具配对平衡切点、
 * keepTurns 安全阀、minDrop 下限、无预算时回退轮次口径、以及旧轮次口径的回归。
 *
 * 用法：`npm run test:selftest`
 */

import {
  COMPACT_HEADROOM_TOKENS,
  COMPACT_KEEP_TURNS,
  COMPACT_MIN_DROP,
  COMPACT_RETAIN_RATIO,
  compactThresholdTokens,
  computePairingBalance,
  estimateMessageTokens,
  pickCompactionRange,
  pickCompactionRangeByTokens,
  pruneToolResults,
  renderCompactedCheckpoint,
  planAgentBudget,
  PRUNE_KEEP_RECENT,
  PRUNE_THRESHOLD_CHARS,
  type BudgetMessage,
} from './contextBudget'

export interface BudgetCase {
  name: string
  ok: boolean
  detail?: string
}

/** 造一条足够大的消息（content 越大估算 token 越多） */
function big(role: string, chars: number): BudgetMessage {
  return { role, content: '字'.repeat(chars) }
}

/** 造一轮"用户提问 + 助手调用工具 + 工具结果"（配对合法的形态） */
function toolRound(userText: string, resultChars: number): BudgetMessage[] {
  return [
    { role: 'user', content: userText },
    { role: 'assistant', content: '', toolCalls: [{ id: `c-${userText}`, name: 'read_file', arguments: {} }] },
    { role: 'tool', content: '字'.repeat(resultChars) },
  ]
}

export function runContextBudgetSelfTest(): BudgetCase[] {
  const cases: BudgetCase[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  // 1. 配对平衡表：tool 结果的左右两侧都不能切
  {
    const seq: BudgetMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 't', arguments: {} }] },
      { role: 'tool', content: 'r1' },
      { role: 'assistant', content: 'done' },
    ]
    const b = computePairingBalance(seq)
    add('配对：0（序列开头）永远安全', b[0] === true)
    add('配对：tool 结果之前不安全', b[3] === false)
    add('配对：tool 结果之后不安全', b[4] === false)
    add('配对：user 之前安全', b[1] === true)
    add('配对：assistant(带 tool_calls) 之前安全', b[2] === true)
    add('配对：序列末尾安全', b[5] === true)
    add('配对：表长度 = n+1', b.length === seq.length + 1)
  }

  // 2. 空 / 极短序列不产生计划
  {
    add('空序列：返回 null', pickCompactionRangeByTokens([], { retainTokens: 100 }) === null)
    add('只有 system：返回 null', pickCompactionRangeByTokens([{ role: 'system', content: 's' }], { retainTokens: 100 }) === null)
    add('system + 1 条：丢弃不足 minDrop → null', pickCompactionRangeByTokens([{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], { retainTokens: 1 }) === null)
  }

  // 3. 尾部 token 预算：只压到预算之外
  {
    const items: BudgetMessage[] = [
      { role: 'system', content: 'sys' },
      ...toolRound('task-1', 20_000),
      ...toolRound('task-2', 20_000),
      ...toolRound('task-3', 20_000),
    ]
    const tailTokens = estimateMessageTokens(items[items.length - 1]) + estimateMessageTokens(items[items.length - 2])
    const plan = pickCompactionRangeByTokens(items, { retainTokens: tailTokens, keepTurns: 1 })
    add('token 口径：产生计划', !!plan)
    if (plan) {
      add('token 口径：basis=tokens', plan.basis === 'tokens')
      add('token 口径：首条 system 不压', plan.startIndex === 1)
      add('token 口径：cut 落在配对平衡处', computePairingBalance(items)[plan.endIndex] === true, `endIndex=${plan.endIndex}`)
      add('token 口径：保留尾部 token ≥ 预算', (plan.retainedTokens ?? 0) >= tailTokens, `retained=${plan.retainedTokens} budget=${tailTokens}`)
      add('token 口径：保留内容含最后一条', plan.endIndex <= items.length - 1)
      add('token 口径：kept 与 dropped 自洽', plan.kept === items.length - plan.endIndex && plan.dropped === plan.endIndex - plan.startIndex)
    }
  }

  // 4. 关键回归：token 预算很大时压不动（这正是"轮次口径"会误判的情形）
  {
    const items: BudgetMessage[] = [
      { role: 'system', content: 'sys' },
      ...toolRound('task-1', 30_000),
      ...toolRound('task-2', 30_000),
      ...toolRound('task-3', 30_000),
    ]
    const huge = 10_000_000
    const plan = pickCompactionRangeByTokens(items, { retainTokens: huge, keepTurns: 1 })
    // 预算覆盖全部历史 → 没有可压区间（keepFrom 会走到 system 之后）
    add('token 口径：预算覆盖全部历史 → null', plan === null, plan ? `start=${plan.startIndex} end=${plan.endIndex}` : '')

    // 换成轮次口径（旧行为）：同样历史、"保留最近 1 轮" → 能压（这正是不对齐的地方）
    const byTurns = pickCompactionRange(items, { keepTurns: 1 })
    add('轮次口径（对照）：同样历史会压掉旧轮次', !!byTurns, byTurns ? `dropped=${byTurns.dropped}` : '')
  }

  // 5. keepTurns 安全阀：token 预算很大但轮次下限更保守
  {
    const items: BudgetMessage[] = [
      { role: 'system', content: 'sys' },
      ...toolRound('t1', 10),
      ...toolRound('t2', 10),
      ...toolRound('t3', 10),
    ]
    // 预算只够 1 条，但安全阀要求至少保留 3 轮 → 保留点应不晚于第 3 轮起点
    const plan = pickCompactionRangeByTokens(items, { retainTokens: 50, keepTurns: 3 })
    add('安全阀：keepTurns 生效（保留最近 3 轮）', plan === null || plan.endIndex <= 4, plan ? `endIndex=${plan.endIndex}` : 'null（无可压区间）')
  }

  // 6. minDrop 下限：不值得为一次摘要调用压掉 1 条
  {
    const items: BudgetMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '字'.repeat(20_000) },
      { role: 'assistant', content: '字'.repeat(20_000) },
    ]
    const plan = pickCompactionRangeByTokens(items, { retainTokens: 10, minDrop: COMPACT_MIN_DROP })
    add('minDrop：丢弃不足时不压', plan === null)
  }

  // 7. 无 token 预算时回退轮次口径（行为与改造前一致）
  {
    const items: BudgetMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
    ]
    const plan = pickCompactionRangeByTokens(items, { keepTurns: 2 })
    const legacy = pickCompactionRange(items, { keepTurns: 2 })
    add('回退：无预算 → 结果与轮次口径一致', JSON.stringify(plan) === JSON.stringify(legacy), JSON.stringify(plan))
    add('回退：basis=turns', plan?.basis === 'turns' && plan?.endIndex === 3)
    // 比例存在但窗口缺失（拿不到可靠窗口值）同样必须回退，而不是算出 0 或 NaN
    const noWindow = pickCompactionRangeByTokens(items, { retainRatio: COMPACT_RETAIN_RATIO, keepTurns: 2 })
    add('回退：只有比例没有窗口 → 同样回退', JSON.stringify(noWindow) === JSON.stringify(legacy))
  }

  // 8. retainRatio + contextWindow 换算与 retainTokens 等价
  {
    const items: BudgetMessage[] = [
      { role: 'system', content: 'sys' },
      ...toolRound('a', 20_000),
      ...toolRound('b', 20_000),
      ...toolRound('c', 20_000),
    ]
    const window = 100_000
    const byRatio = pickCompactionRangeByTokens(items, { retainRatio: COMPACT_RETAIN_RATIO, contextWindow: window, keepTurns: 1 })
    const byTokens = pickCompactionRangeByTokens(items, { retainTokens: Math.floor(window * COMPACT_RETAIN_RATIO), keepTurns: 1 })
    add('比例换算：与等值 token 预算结果一致', JSON.stringify(byRatio) === JSON.stringify(byTokens))
    add('默认保留比例 = DSH 的 0.16', COMPACT_RETAIN_RATIO === 0.16)
  }

  // 9. 真实形态：重工具链路（每条 tool 结果都很大）按窗口比例能压动
  {
    const items: BudgetMessage[] = [{ role: 'system', content: 'sys' }]
    for (let i = 0; i < 6; i++) items.push(...toolRound(`task-${i}`, 30_000))
    // 窗口 128K，保留 16% ≈ 20K token → 远小于 6 轮的总量
    const plan = pickCompactionRangeByTokens(items, { retainRatio: COMPACT_RETAIN_RATIO, contextWindow: 128_000, keepTurns: 1 })
    add('重工具链路：可压（不被"才几轮"卡住）', !!plan, plan ? `dropped=${plan.dropped} retained=${plan.retainedTokens}` : 'null')
    if (plan) {
      const keptTokens = plan.retainedTokens ?? 0
      const window = 128_000
      const budget = window * COMPACT_RETAIN_RATIO
      // 尾部按**整条消息**保留，因此会略微超过预算——但最多超一条消息的量级，
      // 这正是 DSH `accumulated >= retainTokens` 的语义（不能把消息切一半）。
      const lastMsgTokens = estimateMessageTokens(items[items.length - 1])
      add('重工具链路：保留量不超过预算 + 一条消息', keptTokens <= budget + lastMsgTokens, `retained=${keptTokens} budget=${budget} last=${lastMsgTokens}`)
      add('重工具链路：cut 配对平衡', computePairingBalance(items)[plan.endIndex] === true)
    }
  }

  // 10. 旧接口回归：pickCompactionRange 行为未变（普通聊天在用）
  {
    const items: BudgetMessage[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
    ]
    const plan = pickCompactionRange(items, { keepTurns: 2 })
    add('旧接口：保留最近 2 轮（从 u2 起）', plan?.endIndex === 3, `endIndex=${plan?.endIndex}`)
    add('旧接口：startIndex 跳过 system', plan?.startIndex === 1)
    add('旧接口：COMPACT_KEEP_TURNS 默认值仍为 3', COMPACT_KEEP_TURNS === 3)
  }

  // 11. 工具结果剪枝（对齐 DSH 的 tool-result-pruner）
  {
    const bigText = '甲'.repeat(PRUNE_THRESHOLD_CHARS + 5000)
    const items: BudgetMessage[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read_file', arguments: {} }] },
      { role: 'tool', content: bigText },
      ...Array.from({ length: PRUNE_KEEP_RECENT }, (_, i) => ({ role: 'user' as const, content: `filler-${i}` })),
    ]
    const res = pruneToolResults(items)
    const pruned = res.items[2]
    add('剪枝：超阈值的老工具结果被改短', res.pruned === 1 && Array.from(String(pruned.content)).length < PRUNE_THRESHOLD_CHARS)
    add('剪枝：头尾都保留', String(pruned.content).startsWith('甲') && String(pruned.content).endsWith('甲'))
    add('剪枝：标记里写了剪掉的字符数', String(pruned.content).includes('中间已剪枝'))
    add('剪枝：省下的字符数大于 0', res.savedChars > 5000)

    const again = pruneToolResults(res.items)
    add('剪枝：幂等（再跑一次不再变）', again.pruned === 0)

    const tailItems: BudgetMessage[] = [
      { role: 'user', content: 'u' },
      { role: 'tool', content: '乙'.repeat(PRUNE_THRESHOLD_CHARS + 1) },
    ]
    add('剪枝：最近 keepRecent 条不动', pruneToolResults(tailItems).pruned === 0)

    const nonTool: BudgetMessage[] = [{ role: 'assistant', content: '丙'.repeat(PRUNE_THRESHOLD_CHARS + 1) }, ...Array.from({ length: PRUNE_KEEP_RECENT }, (_, i) => ({ role: 'user' as const, content: `f-${i}` }))]
    add('剪枝：只动 tool 角色', pruneToolResults(nonTool).pruned === 0)

    const emoji = { role: 'tool' as const, content: '😀'.repeat(PRUNE_THRESHOLD_CHARS + 100) }
    const emojiRes = pruneToolResults([{ role: 'user', content: 'u' }, emoji, ...Array.from({ length: PRUNE_KEEP_RECENT }, (_, i) => ({ role: 'user' as const, content: `g-${i}` }))])
    add('剪枝：不切碎 emoji 代理对', !/\uFFFD/.test(String(emojiRes.items[1].content)))
  }

  // 12. 压缩检查点渲染（前导语 + 标签）
  {
    const text = renderCompactedCheckpoint('## 主要请求与意图\n- 做某件事')
    add('检查点：带前导语', text.startsWith('以下是更早对话的自动检查点'))
    add('检查点：包在 <compacted-summary> 里', text.includes('<compacted-summary>') && text.includes('</compacted-summary>'))
    add('检查点：正文原样保留', text.includes('## 主要请求与意图'))
  }

  // 13. DSH 触发阈值：大窗口留出 headroom；小窗口退回 80%（64K 余量对小窗口过大）
  {
    add('阈值：128K 窗口按 80%（96K 触发）', compactThresholdTokens({ limit: 128_000, reserve: 8_000 }) === 96_000, String(compactThresholdTokens({ limit: 128_000, reserve: 8_000 })))
    add('阈值：1M 窗口按 0.8 比例上限（800K）', compactThresholdTokens({ limit: 1_000_000, reserve: 32_000 }) === 800_000, String(compactThresholdTokens({ limit: 1_000_000, reserve: 32_000 })))
    add('阈值：64K 窗口按 80% 消息预算', compactThresholdTokens({ limit: 65_536, reserve: 5_243 }) === Math.floor((65_536 - 5_243) * 0.8), String(compactThresholdTokens({ limit: 65_536, reserve: 5_243 })))
    add('阈值：32K 窗口按 80% 消息预算', compactThresholdTokens({ limit: 32_768, reserve: 2_621 }) === Math.floor((32_768 - 2_621) * 0.8), String(compactThresholdTokens({ limit: 32_768, reserve: 2_621 })))
    add('阈值：8K 窗口按 80% 消息预算', compactThresholdTokens({ limit: 8_192, reserve: 655 }) === Math.floor((8_192 - 655) * 0.8), String(compactThresholdTokens({ limit: 8_192, reserve: 655 })))
    add('阈值：默认余量是 DSH 的 64K', COMPACT_HEADROOM_TOKENS === 65_536)
    add('阈值：大窗口可覆盖余量（1M → 768K）', compactThresholdTokens({ limit: 1_000_000, reserve: 32_000, headroomTokens: 200_000 }) === 768_000, String(compactThresholdTokens({ limit: 1_000_000, reserve: 32_000, headroomTokens: 200_000 })))
    // 预算分级确实走该阈值：95K 字 CJK ≈ 63K tokens < 96K（ok）；150K 字 ≈ 100K tokens ≥ 96K（compact）
    const under = planAgentBudget({ limit: 128_000, reserve: 8_000, entries: [big('user', 95_000)] })
    const over = planAgentBudget({ limit: 128_000, reserve: 8_000, entries: [big('user', 150_000)] })
    add('预算分级：低于阈值时不为 compact', under.level !== 'compact', under.level + ' / ' + under.used)
    add('预算分级：高于阈值时为 compact', over.level === 'compact', over.level + ' / ' + over.used)
  }

  return cases
}

/** 打印自测结果并返回是否全通过 */
export function logContextBudgetSelfTest(): boolean {
  const cases = runContextBudgetSelfTest()
  const failed = cases.filter((c) => !c.ok)
  // eslint-disable-next-line no-console
  console.table(cases.map((c) => ({ 用例: c.name, 结果: c.ok ? '通过' : '失败', 备注: c.detail ?? '' })))
  // eslint-disable-next-line no-console
  console.log(`[contextBudget] ${cases.length - failed.length}/${cases.length} 通过`)
  return failed.length === 0
}
