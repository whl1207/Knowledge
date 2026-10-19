/**
 * fsPolicy.ts — 「先读后写」策略的**纯判定层**（无 I/O、两侧可复用）
 *
 * 对齐 DSH 的 `fs-observation-policy`（见 docs/plan/插件能力面向DSH风格收敛-设计方案 §四 D2）：
 * 策略不写进文件能力基座，而是基于「本会话观察过什么」做**决策**——
 * - 没读过就写 → 拒绝（`FS_NOT_OBSERVED`）；
 * - 读过之后文件变了 → 用观察到的版本当 `expectedVersion`，于是 `FS_STALE_VERSION`；
 * - 读过且当时**不存在**（确认缺失）→ 后续写入自动带 `presence: 'mustNotExist'`，可以安全重建；
 * - 调用方自己给了 `expectedVersion` / `presence` → **尊重调用方**（他显式表达了意图）。
 *
 * 为什么要有"确认缺失"这一态：只记"见过的版本"会让"先读一个不存在的文件、再新建"永远被拒；
 * DSH 同样把缺失记成一种观察（`{kind:'absent'}`）。
 *
 * 状态的生命周期在调用方（`electron/main/plugin-fs-policy.ts`）：按插件隔离、
 * **不跨会话持久**、插件卸载即丢（否则 HMR / 重装会把上一份代码的观察带给新代码）。
 */

import type { FsErrorCode } from '@/shared/fsContract'

/** 一次观察：`present` 带版本；`absent` = 确认当时不存在 */
export type FsObservation = { kind: 'present'; version: string } | { kind: 'absent' }

/** 一个插件的观察表：targetKey → 观察（用普通对象，便于落日志与测试断言） */
export type FsObservationTable = Record<string, FsObservation>

/** 策略对一次写入/编辑的裁定 */
export type FsPolicyDecision =
  | { kind: 'allow'; expectedVersion?: string; presence?: 'mustExist' | 'mustNotExist' }
  | { kind: 'deny'; code: FsErrorCode; message: string }

export function observationOf(table: FsObservationTable | undefined, targetKey: string): FsObservation | undefined {
  if (!table || !targetKey) return undefined
  return table[targetKey]
}

export function recordObservation(table: FsObservationTable, targetKey: string, obs: FsObservation): void {
  if (!targetKey) return
  table[targetKey] = obs
}

export function forgetObservation(table: FsObservationTable, targetKey: string): void {
  if (!table || !targetKey) return
  delete table[targetKey]
}

export interface FsPolicyIntent {
  /** 调用方已经显式给的版本（给了就不再被策略覆盖） */
  expectedVersion?: string
  /** 调用方已经显式给的存在性要求 */
  presence?: 'any' | 'mustExist' | 'mustNotExist'
}

/**
 * 写入（覆盖 / 新建）的裁定。
 *
 * 调用方显式给了 `expectedVersion` 或非 `any` 的 `presence` → 放行且**不注入**任何东西：
 * 那已经是比"先读后写"更明确的意图声明（例如导出插件本来就要覆盖自己的产物）。
 */
export function decideWrite(table: FsObservationTable | undefined, targetKey: string, intent: FsPolicyIntent): FsPolicyDecision {
  if (intent.expectedVersion || (intent.presence && intent.presence !== 'any')) return { kind: 'allow' }
  const obs = observationOf(table, targetKey)
  if (!obs) {
    return {
      kind: 'deny',
      code: 'FS_NOT_OBSERVED',
      message: `写入前请先读一次该文件（当前插件开启了「先读后写」策略）：${targetKey}`,
    }
  }
  if (obs.kind === 'absent') return { kind: 'allow', presence: 'mustNotExist' }
  return { kind: 'allow', expectedVersion: obs.version }
}

/**
 * 字面量编辑的裁定：**必须**先读（编辑的内容取决于读到的正文，没读就不该改）。
 *
 * 与写入不同，这里即使调用方给了 `expectedVersion` 也要有观察记录：版本能防并发，
 * 但防不住"凭想象编辑一段没看过的文本"。
 */
export function decideEdit(table: FsObservationTable | undefined, targetKey: string, intent: FsPolicyIntent): FsPolicyDecision {
  const obs = observationOf(table, targetKey)
  if (!obs) {
    return {
      kind: 'deny',
      code: 'FS_NOT_OBSERVED',
      message: `编辑前请先读一次该文件（当前插件开启了「先读后写」策略）：${targetKey}`,
    }
  }
  if (obs.kind === 'absent') {
    return { kind: 'deny', code: 'FS_NOT_FOUND', message: `文件不存在（你观察到它是缺失的）：${targetKey}` }
  }
  return { kind: 'allow', expectedVersion: intent.expectedVersion || obs.version }
}

/**
 * 删除的裁定：与写入同口径（没读过就删，等于闭着眼睛删）。
 * 观察到"缺失"时放行——删除一个本来就不存在的东西应返回 `missing`，而不是报错。
 */
export function decideRemove(table: FsObservationTable | undefined, targetKey: string, intent: FsPolicyIntent): FsPolicyDecision {
  if (intent.expectedVersion) return { kind: 'allow' }
  const obs = observationOf(table, targetKey)
  if (!obs) {
    return {
      kind: 'deny',
      code: 'FS_NOT_OBSERVED',
      message: `删除前请先读一次该文件（当前插件开启了「先读后写」策略）：${targetKey}`,
    }
  }
  if (obs.kind === 'absent') return { kind: 'allow', presence: 'mustNotExist' }
  return { kind: 'allow', expectedVersion: obs.version }
}
