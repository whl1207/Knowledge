/**
 * slots.selftest.ts — 「并发槽位 + 给人留 1 个」的调度判定自测
 *
 * 锁住三条不变量（改错任意一条，用户点"重跑"就会重新变慢）：
 * 1. 保留位只给人、且只 1 个；
 * 2. 不抢占：自动任务照常跑，只是多开一个位；
 * 3. 远端并发只在保留位真的用掉时才 +1。
 *
 * 运行：npm run test:selftest slots
 */

import { canStart, effectiveConcurrency, reserveInUse, type ConcurrencySnapshot } from './slots'

export interface SlotCase {
  name: string
  ok: boolean
  detail?: string
}

function snap(over: Partial<ConcurrencySnapshot> = {}): ConcurrencySnapshot {
  return { active: 0, userActive: 0, userWaiting: false, ...over }
}

export function runSlotsSelfTest(): SlotCase[] {
  const cases: SlotCase[] = []
  const check = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, detail })

  // ---- 基础：没满时谁都能起 ----
  check('0/5 时空闲，自动任务可起', canStart('auto', 5, snap()))
  check('0/5 时空闲，用户任务可起', canStart('user', 5, snap()))

  // ---- 普通槽位已满：自动任务必须等 ----
  check('5/5 满，自动任务不能起', !canStart('auto', 5, snap({ active: 5 })))
  check('5/5 满，用户任务可占用保留位', canStart('user', 5, snap({ active: 5 })))
  check('5/5 满且保留位已被占，第二个用户任务不能起', !canStart('user', 5, snap({ active: 6, userActive: 1 })))
  check('5/5 满且保留位已占，再来自动任务也不能起', !canStart('auto', 5, snap({ active: 6, userActive: 1 })))

  // ---- 用户任务先用普通槽位（active < base）也算用户任务，但不额外放行 ----
  check('3/5 时用户任务走普通槽位', canStart('user', 5, snap({ active: 3, userActive: 1 })))
  check('3/5 时自动任务也能起（普通槽位没满）', canStart('auto', 5, snap({ active: 3, userActive: 1 })))

  // ---- 不抢占：6 个在跑（含保留位）时没人能再起 ----
  check('6/5（保留位已用）谁都不能再起', !canStart('user', 5, snap({ active: 6, userActive: 1 })))

  // ---- 兜底：base 非法值按 1 处理 ----
  check('base=0 兜底为 1', canStart('auto', 0, snap()) && !canStart('auto', 0, snap({ active: 1 })))

  // ---- 远端并发声明 ----
  check('空闲时不额外声明（5）', effectiveConcurrency(5, snap({ active: 2 })) === 5)
  check('用户任务排队且已顶到 5 → 声明 6', effectiveConcurrency(5, snap({ active: 5, userWaiting: true })) === 6)
  check('用户任务已占用保留位 → 声明 6', effectiveConcurrency(5, snap({ active: 6, userActive: 1 })) === 6)
  check('用户任务只是走普通槽位 → 仍声明 5', effectiveConcurrency(5, snap({ active: 3, userActive: 1 })) === 5)
  check('上限封顶：不会超过 MAX+1', effectiveConcurrency(500, snap({ active: 500, userWaiting: true }), 501) === 501)

  // ---- reserveInUse：给日志/UI 判断"现在用的是保留位" ----
  check('reserveInUse：6/5 为真', reserveInUse(5, snap({ active: 6, userActive: 1 })))
  check('reserveInUse：5/5 为假', !reserveInUse(5, snap({ active: 5 })))

  return cases
}
