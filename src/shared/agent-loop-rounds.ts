/**
 * agent-loop-rounds.ts — 智能体「循环轮数（单 turn 最大 step 数）」的唯一数据源
 *
 * 单一数据管理规则：
 * - **唯一权威数据**：`store.generalAgentMaxSteps`（「设置 → 智能体预设 → 通用智能体 → 循环轮数」），
 *   随 localStorage key `generalAgentMaxSteps` 持久化；
 * - **唯一例外**：智能体预设自带的 `preset.maxSteps`（预设层面显式配置的轮数）；
 * - 其余任何执行入口（自主规划 / 技能 / 预设未配置轮数 / 工作流 Agent 节点 / 批量 / 集群）
 *   一律经 `resolveAgentMaxSteps` 落到上述两处数据，不得再写死 20 之类的「隐性注入」，
 *   否则会出现「设置里改了轮数、实际仍跑 20 步」的问题。
 *
 * 主进程（electron/main/agent-loop.ts）与渲染进程共用本模块（`@/` → `src/`）。
 */

/** 默认循环轮数（单 turn 最大 step 数） */
export const DEFAULT_AGENT_MAX_STEPS = 500
/** 允许范围（UI 输入与存档校验共用） */
export const AGENT_MAX_STEPS_MIN = 1
export const AGENT_MAX_STEPS_MAX = 1000

/** 归一化轮数：非有限数值 → 默认值；越界 → 夹到边界；小数 → 向下取整 */
export function normalizeAgentMaxSteps(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_AGENT_MAX_STEPS
  return Math.min(AGENT_MAX_STEPS_MAX, Math.max(AGENT_MAX_STEPS_MIN, Math.floor(n)))
}

/** 解析实际生效的轮数：预设自带轮数优先（唯一例外），否则用全局唯一数据 */
export function resolveAgentMaxSteps(presetSteps?: unknown, generalSteps?: unknown): number {
  if (typeof presetSteps === 'number' && Number.isFinite(presetSteps)) return normalizeAgentMaxSteps(presetSteps)
  return normalizeAgentMaxSteps(generalSteps)
}
