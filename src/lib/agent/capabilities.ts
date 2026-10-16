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
  { key: 'updatePlan', defaultOn: true, tools: ['update_plan', 'exit_plan_mode'] },
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
  { key: 'runSubagent', tools: ['run_subagent', 'job_output', 'job_kill'] },
  { key: 'skills', tools: ['skill'] },
]

/**
 * 能力槽 → 该槽位工具列表（供 UI 逐槽展示；未知槽位返回空数组）
 */
export const slotToolsOf = (key: string): string[] =>
  CAPABILITY_TOOL_SLOTS.find((s) => s.key === key)?.tools || []

// ---------------------------------------------------------------------------
// 插件工具（**显式勾选才生效**）
//
// 插件注册的工具在**主进程**工具注册表里（作用域 `plugin:<id>`），渲染层无法自行枚举，
// 因此由渲染层在插件状态变化时（见 src/lib/plugin/runtime.ts）把「已激活插件注册的工具名」
// 推到这里，供预设界面列出来源与勾选状态。
//
// ⚠️ 这里的语义在 2026-10 由「自动追加」改为「显式勾选」（方案 B）：
//   - 以前：`toolsFromCapabilities` 会把已激活插件的工具**无条件追加**到白名单末尾，
//     于是用户在预设里既看不到、也关不掉插件工具，只能整体停用插件；
//   - 现在：预设的 `enabledTools` 是**唯一权威**。插件工具与内置工具一视同仁——
//     没勾就没有，勾了才有。插件新装/新加的工具**不会**自动进入任何预设，
//     需要用户在预设的工具页里显式勾选（界面上会标出"来自哪个插件"）。
// ---------------------------------------------------------------------------

let pluginToolNames: string[] = []
/**
 * 「所有已加载插件声明过的工具」——**含未启用 / 加载失败 / 已停用的插件**。
 *
 * 为什么要与 `pluginToolNames`（只含已激活）分开：判定"这个名字属于插件"与判定"它现在可用"
 * 是两件事。若只用已激活名单，插件一停用我们就认不出它那些工具是插件工具了，
 * **预设里残留的工具名会被当作内置工具放行**，继续暴露给模型（实测：新自测抓到了这条）。
 */
let pluginDeclaredToolNames: string[] = []

/** 更新「当前已激活插件注册的工具名」（由渲染层同步；空数组即清空） */
export function setPluginToolNames(names: string[]): void {
  pluginToolNames = Array.isArray(names) ? names.filter((n) => typeof n === 'string' && n.trim() !== '') : []
}

/** 更新「插件声明过的全部工具名」（含未启用插件）；不设则退回已激活名单，旧调用点行为不退化 */
export function setPluginDeclaredToolNames(names: string[]): void {
  pluginDeclaredToolNames = Array.isArray(names) ? names.filter((n) => typeof n === 'string' && n.trim() !== '') : []
}

/** 当前已激活插件提供的工具名（只读快照） */
export function getPluginToolNames(): string[] {
  return pluginToolNames.slice()
}

/** 插件声明过的全部工具名（含未启用插件）；没有单独设置过时 = 已激活名单 */
export function getPluginDeclaredToolNames(): string[] {
  return (pluginDeclaredToolNames.length ? pluginDeclaredToolNames : pluginToolNames).slice()
}

/** 某工具是不是插件提供的（判定用「声明过」而不是「当前激活」，否则停用后会漏判） */
export function isPluginTool(name: string): boolean {
  return getPluginDeclaredToolNames().includes(String(name))
}

/**
 * 对预设声明的工具集做净化：**只有仍然可用的插件工具才留下**。
 *
 * 1. 插件工具必须同时"在激活名单里"——插件停用/卸载后，预设里残留的名字要剔除，
 *    否则模型会看到一堆调不通的工具名；
 * 2. 内置工具原样保留、顺序不变。
 *
 * 为什么收敛在这一处：`toolsFromCapabilities` 是运行时白名单的**统一入口**
 * （预设 / 集群 / 工作流节点 / 局域网访客都走它），只有在这里收口才能保证
 * "界面勾了什么 = 运行时能用什么"。
 */
function withPluginTools(base: string[]): string[] {
  if (!base.length) return base
  const active = new Set(pluginToolNames)
  const declared = new Set(getPluginDeclaredToolNames())
  return base.filter((name) => (declared.has(name) ? active.has(name) : true))
}

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
    // 子代理整族一起开：run_subagent 的后台模式要靠 job_output 收结果、job_kill 停止，
    // 只开 run_subagent 会让模型拿到一个永远收不到结果的 jobId。
    if (set.has('run_subagent')) { set.add('job_output'); set.add('job_kill') }
    if (opts.includeMcp === false) set.delete('mcp_call')
    return withPluginTools(Array.from(set))
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
  return withPluginTools(out)
}

// ---------------------------------------------------------------------------
// 逐工具模式（enabledTools）辅助
//   caps.enabledTools?: string[]  精确启用的工具名集（新数据源）
//   caps 上的能力槽布尔（readFiles 等）由 syncCapabilityBooleans 自动镜像，
//   供仍读取布尔值的旧逻辑（门控 / 图标 / 提示词 / 图谱）继续工作，避免两套并存失配。
// ---------------------------------------------------------------------------

/** 读取某 agent/preset 的有效工具集（逐工具优先；旧模式由能力槽推导）。只读不落盘 */
export function effectiveToolsOf(caps: any): string[] {
  return toolsFromCapabilities(caps)
}

/**
 * 某工具当前是否启用。
 *
 * ⚠️ 这里必须走 `toolsFromCapabilities` 而不是直接 `caps.enabledTools.includes(tool)`：
 * 前者才会应用"插件工具必须仍然存在"这条剔除规则。否则插件卸载后，预设界面会把一个
 * 已经不可用的工具显示成"开着"，用户点它一下就写进 `enabledTools`，接着又"显示开、实际调不到"。
 */
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
