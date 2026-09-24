/**
 * agentCapabilities.ts — 能力槽 → 工具白名单（统一数据源）
 *
 * 收敛「预设能力槽 → 工具名列表」映射。该映射历史上散落在 5 处运行时/预览
 * 硬编码（useAgentRun.buildPresetTools、AgentPreset.presetTools、
 * swarmRunner.buildSwarmTools、batchRunnerAgent、workFlow agent 节点），
 * 以及 AgentPreset「工具」标签页的展示文本，导致新增工具（如 replace_in_file /
 * multi_replace）时各点极易漏改。
 *
 * 约定：以后调整某个能力槽产生的工具，只改下方 CAPABILITY_TOOL_SLOTS 对应项；
 * 运行时白名单（toolsFromCapabilities）与 UI 展示（slotToolsOf）自动同步。
 * 工具的展示元数据（名称/图标/描述）在 src/services/agentSkills.ts 的
 * AGENT_TOOL_REGISTRY 维护。
 */

/** 能力槽 → 工具（顺序即 toolsFromCapabilities 的 push 顺序，须与历史各调用点一致） */
export interface CapabilityToolSlot {
  /** 能力槽字段名（AgentPresetCapabilities / SwarmCapabilities 的布尔能力键） */
  key: string
  /** 该槽位启用时注入的工具名列表 */
  tools: string[]
  /** 旧预设未配置该开关时默认开启（askUser / updatePlan / updateTodo，语义：undefined !== false） */
  defaultOn?: boolean
  /** 需已关联知识库文件（knowledgeBaseFiles 非空）才产生工具（accessKnowledgeBase → kb_search） */
  needsKnowledgeFiles?: boolean
}

export const CAPABILITY_TOOL_SLOTS: CapabilityToolSlot[] = [
  { key: 'askUser', defaultOn: true, tools: ['ask_user'] },
  { key: 'updatePlan', defaultOn: true, tools: ['update_plan'] },
  { key: 'updateTodo', defaultOn: true, tools: ['update_todo'] },
  { key: 'mcpAccess', tools: ['mcp_call'] },
  { key: 'accessKnowledgeBase', needsKnowledgeFiles: true, tools: ['kb_search'] },
  { key: 'readFiles', tools: ['read_file', 'search_files'] },
  { key: 'listDirs', tools: ['list_dir'] },
  { key: 'writeFiles', tools: ['write_file', 'replace_in_file', 'multi_replace'] },
  { key: 'executeCode', tools: ['run_python'] },
  { key: 'runShell', tools: ['shell'] },
  { key: 'webSearch', tools: ['web_search', 'web_fetch'] },
  { key: 'browseWebsites', tools: ['web_fetch'] },
  { key: 'runSubagent', tools: ['run_subagent'] },
  { key: 'skills', tools: ['skill'] },
]

/** 能力槽 → 该槽位工具列表（供 UI 逐槽展示；未知槽位返回空数组） */
export const slotToolsOf = (key: string): string[] =>
  CAPABILITY_TOOL_SLOTS.find((s) => s.key === key)?.tools || []

/**
 * 按能力槽组装工具白名单（统一入口）。
 * - **逐工具模式（新，caps.enabledTools 为数组）**：直接以启用的工具集为准，精确到单个工具
 *   （如写入文件只开 replace_in_file、不开 write_file）。
 * - **旧模式（无 enabledTools）**：由能力槽布尔推导（含 askUser/updatePlan/updateTodo 缺省开启）。
 * @param caps 能力槽对象（AgentPresetCapabilities / SwarmCapabilities）
 * @param opts.includeMcp mcp_call 是否并入（默认并入；swarm 需经 agentMcpConfig 单独判定，传 false 自行追加）
 */
export function toolsFromCapabilities(caps: any, opts: { includeMcp?: boolean } = {}): string[] {
  if (!caps) return []
  // —— 逐工具模式（新）：显式启用集 ——
  if (Array.isArray(caps.enabledTools)) {
    const set = new Set<string>(caps.enabledTools as string[])
    // 历史语义保持一致：知识库检索需已关联文件才真正注入（避免“开了检索却无库可检”）
    const hasKb = Array.isArray(caps.knowledgeBaseFiles) && caps.knowledgeBaseFiles.length
    if (!hasKb) set.delete('kb_search')
    // 兼容旧路径（图谱等直接置 accessKnowledgeBase=true 并关联文件、未同步工具集）：
    // 只要“访问知识库能力 + 已关联文件”成立即注入 kb_search，避免模型检索失效
    if (hasKb && caps.accessKnowledgeBase && !set.has('kb_search')) set.add('kb_search')
    if (opts.includeMcp === false) set.delete('mcp_call')
    return Array.from(set)
  }
  // —— 旧模式：由能力槽布尔推导 ——
  const out: string[] = []
  for (const slot of CAPABILITY_TOOL_SLOTS) {
    if (slot.key === 'mcpAccess' && opts.includeMcp === false) continue
    const v = caps?.[slot.key]
    let on = !!v
    if (slot.defaultOn) on = v !== false // 旧预设缺省开启
    if (on && slot.needsKnowledgeFiles && !(Array.isArray(caps?.knowledgeBaseFiles) && caps.knowledgeBaseFiles.length)) on = false
    if (on) out.push(...slot.tools)
  }
  return out
}

// ---------------------------------------------------------------------------
// 逐工具模式（enabledTools）辅助
//   caps.enabledTools?: string[]  精确启用的工具名集（新数据源）
//   caps 上的能力槽布尔（readFiles 等）由 syncCapabilityBooleans 自动镜像，
//   供仍读取布尔值的旧逻辑（门控 / 图标 / 提示词 / 图谱）继续工作，避免两套并存失配。
// ---------------------------------------------------------------------------

/** 读取某 agent/preset 的有效工具集（逐工具优先；旧模式由能力槽推导）。只读不落盘 */
export function effectiveToolsOf(caps: any): string[] {
  if (caps && Array.isArray(caps.enabledTools)) return caps.enabledTools.slice()
  return toolsFromCapabilities(caps)
}

/** 某工具当前是否启用 */
export function toolOn(caps: any, tool: string): boolean {
  return effectiveToolsOf(caps).includes(tool)
}

/** 能力槽当前是否开启（逐工具模式 = 该槽任一工具开启；旧模式 = 布尔值本身）。供 UI 门控/展示 */
export function capabilityOn(caps: any, key: string): boolean {
  if (!caps) return false
  if (Array.isArray(caps.enabledTools)) {
    const slot = CAPABILITY_TOOL_SLOTS.find((s) => s.key === key)
    return !!slot && slot.tools.some((t) => caps.enabledTools.includes(t))
  }
  return !!(caps as any)[key]
}

/** 若尚无 enabledTools，则由能力槽推导并落盘（把旧数据升级为逐工具模式）。返回是否发生升级 */
export function ensureEnabledTools(caps: any): boolean {
  if (!caps || Array.isArray(caps.enabledTools)) return false
  caps.enabledTools = toolsFromCapabilities(caps)
  syncCapabilityBooleans(caps)
  return true
}

/** 由 enabledTools 反推各能力槽布尔（镜像；供仍读布尔值的旧逻辑/门控/图标/图谱继续工作） */
export function syncCapabilityBooleans(caps: any): void {
  if (!caps || !Array.isArray(caps.enabledTools)) return
  for (const slot of CAPABILITY_TOOL_SLOTS) {
    caps[slot.key] = slot.tools.some((t) => caps.enabledTools.includes(t))
  }
}

/** 开关单个工具（逐工具模式）：自动升级→增删→同步能力槽布尔镜像 */
export function setToolEnabled(caps: any, tool: string, on: boolean): void {
  if (!caps) return
  ensureEnabledTools(caps)
  const list = caps.enabledTools
  const i = list.indexOf(tool)
  if (on && i === -1) list.push(tool)
  else if (!on && i !== -1) list.splice(i, 1)
  syncCapabilityBooleans(caps)
}
