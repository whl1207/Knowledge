/**
 * slots.ts — 批量并发的「调度判定」纯逻辑（含给人预留的 1 个槽位）
 *
 * 参照 dsh-superagent-prototype 的做法（`docs/003-execution.md:55-61`）：
 * **配置的并发上限之外，再留 1 个只给人手触发的动作**。自动任务（批量剩余行、
 * 自动重试、抓取新行）永远占不到这个位；人点「重跑」时即使并发已满也能立刻开跑。
 *
 * 三条不变量：
 * 1. 保留位**只给人**，且同一时刻最多 1 个（第二个用户动作照常排队）；
 * 2. **不抢占**：正在跑的自动任务不会因此被暂停；
 * 3. 保留位只在"真的用掉"时才把远端并发声明 +1（常态不多占后端配额）。
 *
 * 这里只做判定，不碰队列/计时器/agentBridge —— 便于单测（见 slots.selftest.ts）。
 */

/** 并发快照：正在跑的数量、其中用户动作的数量、队列里是否有用户在等 */
export interface ConcurrencySnapshot {
  active: number
  /** 其中有几个是用户触发的（占用保留位或普通槽位） */
  userActive: number
  /** 队列里是否有用户任务在等 */
  userWaiting: boolean
}

/** 任务来源：auto = 批量自动调度 / user = 人手动触发（重跑某行、重跑命中行） */
export type SlotTaskKind = 'auto' | 'user'

/** 这个任务现在能不能开始（不考虑队列顺序，由调用方从队首找第一个能起的） */
export function canStart(kind: SlotTaskKind, base: number, snap: ConcurrencySnapshot): boolean {
  const baseLimit = Math.max(1, Math.floor(base))
  if (snap.active < baseLimit) return true
  // 普通槽位已满：只有"用户任务 + 保留位还没被占 + 总并发仍在上限+1 之内"才放行
  return kind === 'user' && snap.userActive <= 0 && snap.active < baseLimit + 1
}

/**
 * 应当向远端后端声明的并发数（等于"最多可能同时跑几个"）。
 * 只有保留位真的在用（或用户在排队且总并发已经顶到 base）时才 +1。
 */
export function effectiveConcurrency(base: number, snap: ConcurrencySnapshot, max = Number.POSITIVE_INFINITY): number {
  const baseLimit = Math.max(1, Math.floor(base))
  const reserveInUse = snap.active >= baseLimit && (snap.userActive > 0 || snap.userWaiting)
  return Math.min(max, baseLimit + (reserveInUse ? 1 : 0))
}

/** 当前是否用到了保留位（用于日志/UI 提示） */
export function reserveInUse(base: number, snap: ConcurrencySnapshot): boolean {
  return snap.active > Math.max(1, Math.floor(base))
}
