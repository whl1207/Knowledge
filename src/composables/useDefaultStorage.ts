/**
 * useDefaultStorage.ts — 「技能 / 智能体预设」的默认数据存储位置
 *
 * 目标（对齐「插件」目录的体验）：**开箱即用，不用先点「选择文件夹」**。
 * - 技能：默认 `userData/skills`（每个技能一个子目录，含 SKILL.md）
 * - Agent 预设：默认 `userData/agent-presets`（每个预设一个 `.agent` 文件）
 * 用户点了「选择文件夹」之后，路径才改成对应目录（仍然持久化在 localStorage 的
 * `skillsPath` / `agentPresetPath`，与设置页显示的是同一份值）；「恢复默认位置」把路径清掉
 * 再解析一次默认目录。
 *
 * 为什么不做成主进程常量：两个路径都要参与渲染层的「列表 / 编辑 / 提示词注入」，
 * 单一事实源是 store 里的字段；主进程只负责提供 `userData` 根目录（`app.dataDirPath`）。
 *
 * 迁移：老用户 `agentPresetPath` 为空（预设只在 localStorage）。首次运行会把预设
 * **写进默认文件夹**再以文件夹为准，避免切过去之后列表变空（见 applyAgentPresetFolder 的回滚逻辑）。
 */

import { usestore } from '@/store'
import { getPlatform } from '@/platform'
import { isBuiltinAgentPreset } from '@/shared/builtinAgentPresets'
import { applyAgentPresetFolder, type AgentPresetScanSummary } from '@/composables/useAgentPresets'

/** 默认技能目录（userData 下的子目录名） */
export const DEFAULT_SKILLS_DIR = 'skills'
/** 默认 Agent 预设目录（userData 下的子目录名） */
export const DEFAULT_AGENT_PRESET_DIR = 'agent-presets'

/**
 * 解析 `userData/<sub>` 的绝对路径并确保目录存在。
 * 浏览器 / 安卓等没有应用数据目录的环境返回 ''（调用方据此保持原行为）。
 */
export async function defaultDataDir(sub: string): Promise<string> {
  try {
    const res: any = await getPlatform().app.dataDirPath(sub)
    if (!res?.success || !res?.path) return ''
    const dir = String(res.path)
    try { await getPlatform().fs.ensureDir(dir) } catch { /* 建不出来也先把路径返回：后续写入会给出明确错误 */ }
    return dir
  } catch {
    return ''
  }
}

/** 默认技能目录（不修改 store） */
export const defaultSkillsFolder = (): Promise<string> => defaultDataDir(DEFAULT_SKILLS_DIR)
/** 默认预设目录（不修改 store） */
export const defaultAgentPresetFolder = (): Promise<string> => defaultDataDir(DEFAULT_AGENT_PRESET_DIR)

/**
 * 确保技能目录有值：为空时指向默认目录（已有自定义目录则原样返回）。
 * @returns 实际生效的技能目录（'' = 当前平台不支持）
 */
export async function ensureDefaultSkillsPath(): Promise<string> {
  const store = usestore() as any
  const current = String(store.skillsPath || '')
  if (current) return current
  const dir = await defaultSkillsFolder()
  if (!dir) return ''
  store.skillsPath = dir
  store.saveConfig?.()
  return dir
}

/** 恢复技能目录到默认位置（清掉自定义路径后重新解析；不删除旧目录里的文件） */
export async function resetSkillsPathToDefault(): Promise<string> {
  const store = usestore() as any
  store.skillsPath = ''
  return await ensureDefaultSkillsPath()
}

/** 进行中的预设初始化（自动初始化与设置页 onMounted 可能同时触发，合并成一次） */
let presetInitInFlight: Promise<AgentPresetScanSummary | null> | null = null

/**
 * 确保预设存储有值：为空时切到默认目录，并把当前内存里的自建预设落进去
 * （老用户迁移；空目录才会写，已有 .agent 文件的目录一律不碰）。
 * @returns 切换/扫描结果；不需要或当前平台不支持时返回 null
 */
export async function ensureDefaultAgentPresetFolder(seedPresets?: any[]): Promise<AgentPresetScanSummary | null> {
  const store = usestore() as any
  if (String(store.agentPresetPath || '')) return null
  if (presetInitInFlight) return await presetInitInFlight
  presetInitInFlight = (async () => {
    const dir = await defaultAgentPresetFolder()
    if (!dir) return null
    const seeds = (seedPresets || store.agentPresets || []).filter((p: any) => p && p.id && !isBuiltinAgentPreset(p))
    return await applyAgentPresetFolder(dir, { seedPresets: seeds })
  })()
  try {
    return await presetInitInFlight
  } finally {
    presetInitInFlight = null
  }
}

/** 恢复预设存储到默认目录（同样带「空目录先落盘」的防丢逻辑） */
export async function resetAgentPresetFolderToDefault(seedPresets?: any[]): Promise<AgentPresetScanSummary | null> {
  const dir = await defaultAgentPresetFolder()
  if (!dir) return null
  const seeds = (seedPresets || (usestore() as any).agentPresets || []).filter((p: any) => p && p.id && !isBuiltinAgentPreset(p))
  return await applyAgentPresetFolder(dir, { seedPresets: seeds })
}

/** 当前预设是否就在默认目录（设置页据此显示「默认位置」徽标） */
export async function isDefaultAgentPresetFolder(): Promise<boolean> {
  const store = usestore() as any
  const current = String(store.agentPresetPath || '')
  if (!current) return false
  const dir = await defaultAgentPresetFolder()
  return !!dir && current === dir
}

/** 当前技能目录是否就是默认目录（设置页据此显示「默认位置」徽标） */
export async function isDefaultSkillsFolder(): Promise<boolean> {
  const store = usestore() as any
  const current = String(store.skillsPath || '')
  if (!current) return false
  const dir = await defaultSkillsFolder()
  return !!dir && current === dir
}

/**
 * 启动时初始化默认存储（幂等；App.vue 在 `store.loadConfig()` 之后调用一次）。
 * 失败不抛：技能/预设各自保持原状，用户仍可在设置页手动选择目录。
 */
export async function initDefaultStorage(): Promise<void> {
  try { await ensureDefaultSkillsPath() } catch { /* 技能目录失败不影响预设 */ }
  try { await ensureDefaultAgentPresetFolder() } catch { /* 预设迁移失败时保持原存储 */ }
}
