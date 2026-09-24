/**
 * useSwarmMembers.ts — 集群成员（= Agent 预设引用）
 *
 * 集群不再有自己的成员定义与 .swarm 预案文件：每个对话只保存参与成员的
 * 预设 id 列表（`chat.config.swarmPresetIds`），成员配置一律以
 * 「设置 → 智能体 → 预设」的 `store.agentPresets` 为单一事实源。
 *
 * 收益：
 * - 改预设即改成员，无需快照同步；
 * - 对话只存几十字节 id，不随成员配置膨胀；
 * - `@点名` 依赖的成员名永远与预设一致，不会因改名而失效。
 *
 * 代价：预设被删/改名后引用会悬空 —— `deriveMembers` 会把无效 id 收集到
 * `missing`，调用方需在 UI 上提示「已失效」并允许移除。
 */

import { usestore } from '@/store'
import { syncCapabilityBooleans, toolsFromCapabilities } from '@/lib/agent/capabilities'
import type { SwarmAgent, SwarmCapabilities } from '@/types/swarm'

/**
 * 预设能力 → 集群能力。
 * 字段与 AgentPresetCapabilities 完全对齐，只做缺省兜底（不引入集群侧默认值，
 * 避免把预设显式关闭的能力重新打开）。
 */
export function normalizePresetCaps(src: any): SwarmCapabilities {
  const caps: SwarmCapabilities = {
    readFiles: !!src?.readFiles,
    listDirs: !!src?.listDirs,
    executeCode: !!src?.executeCode,
    webSearch: !!src?.webSearch,
    browseWebsites: !!src?.browseWebsites,
    writeFiles: !!src?.writeFiles,
    // 对话规划三项：预设语义为「undefined !== false」（旧预设缺省开启）
    askUser: src?.askUser !== false,
    updatePlan: src?.updatePlan !== false,
    updateTodo: src?.updateTodo !== false,
    accessKnowledgeBase: !!src?.accessKnowledgeBase,
    runShell: !!src?.runShell,
    runSubagent: !!src?.runSubagent,
    skills: !!src?.skills,
    mcpAccess: !!src?.mcpAccess,
    mcpServerIds: Array.isArray(src?.mcpServerIds) ? [...src.mcpServerIds] : [],
    mcpEquipmentIds: Array.isArray(src?.mcpEquipmentIds) ? [...src.mcpEquipmentIds] : [],
    knowledgeBaseFiles: Array.isArray(src?.knowledgeBaseFiles) ? [...src.knowledgeBaseFiles] : [],
  }
  if (Array.isArray(src?.enabledTools)) {
    // 逐工具模式：原样继承，并把能力槽布尔镜像回来（供仍读布尔的旧逻辑使用）
    caps.enabledTools = [...src.enabledTools]
    syncCapabilityBooleans(caps)
  } else {
    caps.enabledTools = toolsFromCapabilities(caps)
  }
  return caps
}

/** 预设 → 集群成员（`presetId` 恒为预设自身 id，成员名/模型/能力始终跟随预设） */
export function presetToMember(preset: any, idx = 0): SwarmAgent {
  const store = usestore()
  const selectedSkills: string[] = Array.isArray(preset?.selectedSkills) ? [...preset.selectedSkills] : []
  return {
    id: String(preset?.id || `preset-${idx}`),
    name: preset?.name || `Agent ${idx + 1}`,
    // 角色设定已并入预设的 systemPrompt（预设侧不再有 role 字段）
    role: '',
    llmType: preset?.llmType || store.AIconfig.llm.type,
    model: preset?.model || '',
    systemPrompt: preset?.systemPrompt || '',
    temperature: typeof preset?.temperature === 'number' ? preset.temperature : 0.7,
    capabilities: normalizePresetCaps(preset?.capabilities),
    skillMode: selectedSkills.length > 0 ? 'select' : 'none',
    selectedSkill: selectedSkills[0] || '',
    selectedSkills,
    presetId: preset?.id,
  }
}

/**
 * 按预设 id 列表派生成员数组（顺序 = 发言顺序）。
 * 不存在的 id 收集进 `missing`，交由 UI 提示「已失效」。
 */
export function deriveMembers(presetIds: string[] = []): { members: SwarmAgent[]; missing: string[] } {
  const store = usestore()
  const members: SwarmAgent[] = []
  const missing: string[] = []
  const seen = new Set<string>()
  presetIds.forEach((id, i) => {
    const preset = (store.agentPresets || []).find((c: any) => c.id === id)
    if (!preset) {
      missing.push(id)
      return
    }
    // 同一预设重复出现只保留一次（避免 @点名 歧义与重复执行）
    if (seen.has(id)) return
    seen.add(id)
    members.push(presetToMember(preset, i))
  })
  return { members, missing }
}

/** 分派执行前把成员写入集群运行时（`swarmState.agents`）；返回派生结果供 UI 提示失效项 */
export function applyMembers(presetIds: string[], target: { value: SwarmAgent[] }): { members: SwarmAgent[]; missing: string[] } {
  const result = deriveMembers(presetIds)
  target.value = result.members
  return result
}
