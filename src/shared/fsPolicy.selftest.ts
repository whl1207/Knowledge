/**
 * fsPolicy.selftest.ts — 「先读后写」策略的纯判定自测
 *
 * 这一层的每条规则都对应一个真实误用：
 * - 没读过就覆盖 → 静默改掉用户刚写的版本；
 * - 读过但不校验版本 → 读到之后别人改了，仍然覆盖；
 * - 读过"不存在"再新建 → 报错（少了 absent 这一态就会出现）；
 * - 编辑却只看版本不看是否读过 → 凭想象改一段没看过的文本。
 *
 * 用 `runFsPolicySelfTest()` 返回数组，由 `scripts/run-selftests.mjs` 执行。
 */

import {
  decideEdit,
  decideRemove,
  decideWrite,
  forgetObservation,
  observationOf,
  recordObservation,
  type FsObservationTable,
} from '@/shared/fsPolicy'

export interface SelfTestCase {
  name: string
  ok: boolean
  detail?: string
}

export function runFsPolicySelfTest(): SelfTestCase[] {
  const cases: SelfTestCase[] = []
  const check = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })
  const empty = (): FsObservationTable => ({})

  // ---- 未观察 ----
  const w1 = decideWrite(empty(), 'c:/a.md', {})
  check('没读过就写 → FS_NOT_OBSERVED', w1.kind === 'deny' && w1.code === 'FS_NOT_OBSERVED', JSON.stringify(w1))

  const e1 = decideEdit(empty(), 'c:/a.md', {})
  check('没读过就编辑 → FS_NOT_OBSERVED', e1.kind === 'deny' && e1.code === 'FS_NOT_OBSERVED', JSON.stringify(e1))

  const e1b = decideEdit(empty(), 'c:/a.md', { expectedVersion: '1:2' })
  check('**即使给了版本**，没读过也不能编辑（版本防不住"凭想象改"）', e1b.kind === 'deny', JSON.stringify(e1b))

  const r1 = decideRemove(empty(), 'c:/a.md', {})
  check('没读过就删 → FS_NOT_OBSERVED', r1.kind === 'deny' && r1.code === 'FS_NOT_OBSERVED', JSON.stringify(r1))

  // ---- 调用方显式意图：尊重 ----
  const w2 = decideWrite(empty(), 'c:/a.md', { expectedVersion: '9:9' })
  check('调用方显式给了版本 → 放行且不注入', w2.kind === 'allow' && !w2.expectedVersion && !w2.presence, JSON.stringify(w2))
  const w3 = decideWrite(empty(), 'c:/a.md', { presence: 'mustNotExist' })
  check('调用方显式给了 presence → 放行', w3.kind === 'allow', JSON.stringify(w3))

  // ---- 观察到"存在" ----
  const table: FsObservationTable = {}
  recordObservation(table, 'c:/a.md', { kind: 'present', version: '12:100:100' })
  const w4 = decideWrite(table, 'c:/a.md', {})
  check(
    '读过之后写 → 注入观察到的版本（别人改过就会 FS_STALE_VERSION）',
    w4.kind === 'allow' && w4.expectedVersion === '12:100:100',
    JSON.stringify(w4),
  )
  const e2 = decideEdit(table, 'c:/a.md', {})
  check('读过之后编辑 → 注入观察到的版本', e2.kind === 'allow' && e2.expectedVersion === '12:100:100', JSON.stringify(e2))
  const e3 = decideEdit(table, 'c:/a.md', { expectedVersion: '5:5:5' })
  check('调用方给了版本时以调用方为准', e3.kind === 'allow' && e3.expectedVersion === '5:5:5', JSON.stringify(e3))

  // ---- 观察到"缺失" ----
  const absent: FsObservationTable = {}
  recordObservation(absent, 'c:/new.md', { kind: 'absent' })
  const w5 = decideWrite(absent, 'c:/new.md', {})
  check(
    '读过"不存在"→ 写时自动带 mustNotExist（可以安全重建，且不会覆盖并发创建者）',
    w5.kind === 'allow' && w5.presence === 'mustNotExist',
    JSON.stringify(w5),
  )
  const e4 = decideEdit(absent, 'c:/new.md', {})
  check('编辑一个"确认缺失"的目标 → FS_NOT_FOUND', e4.kind === 'deny' && e4.code === 'FS_NOT_FOUND', JSON.stringify(e4))
  const r2 = decideRemove(absent, 'c:/new.md', {})
  check('删除一个"确认缺失"的目标 → 放行（结果自然是 missing）', r2.kind === 'allow', JSON.stringify(r2))

  // ---- 表操作 ----
  check('观察可读回', observationOf(table, 'c:/a.md')?.kind === 'present')
  forgetObservation(table, 'c:/a.md')
  check('忘记观察后重新变回"未读过"（写被拒）', observationOf(table, 'c:/a.md') === undefined && decideWrite(table, 'c:/a.md', {}).kind === 'deny')
  check('空 targetKey 不记录', (() => {
    const t: FsObservationTable = {}
    recordObservation(t, '', { kind: 'absent' })
    return Object.keys(t).length === 0
  })())

  return cases
}
