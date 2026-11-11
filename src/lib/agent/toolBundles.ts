/**
 * toolBundles.ts — 预设级「工具包 + 覆盖 + 运行门控」的纯逻辑
 *
 * 目标：预设不再只保存一份巨大的 `enabledTools`，而是保存
 *   - `toolBundles`: 选中的能力域（toolGroups 的 id）
 *   - `toolOverrides`: 单个工具的偏差（include 额外加、exclude 单独关）
 * 运行时按「包 ∪ include ∖ exclude」解析；新工具只要登记进对应能力域，
 * 所有选该域的预设都会自动获得它。用户仍可逐工具开关，开关写进 overrides。
 *
 * 纯函数，不依赖 Vue / store，供 capabilities.ts、AgentPreset UI 与自测共用。
 */

import { INTEGRATION_GROUP_ID, OTHER_GROUP_ID, TOOL_GROUPS } from './toolGroups'

/** 自动模式 = 由 toolBundles + toolOverrides 解析；custom / 缺省 = 旧 enabledTools 模式 */
export type ToolMode = 'auto' | 'custom'

export interface ToolOverrides {
  /** 额外加入（插件工具、不属于任何能力域的工具，或用户从包外单独开启的工具） */
  include?: string[]
  /** 单独关闭（用户从已选包中关掉的工具） */
  exclude?: string[]
}

/** 运行门控所需的环境事实。字段缺省 = 不知道，不拦（避免误伤） */
export interface ToolGateEnv {
  supportsVision?: boolean
  /** 与 store.pythonSandbox / sandboxMode 同口径 */
  sandboxMode?: 'safe' | 'workspace' | 'trusted' | string
  hasKnowledge?: boolean
  hasMcpServers?: boolean
  browserAvailable?: boolean
  interactive?: boolean
  /** 子代理嵌套深度：0=主会话，≥1=子代理 */
  nestedDepth?: number
}

const GROUP_TOOLS = new Map(TOOL_GROUPS.map((g) => [g.id, [...g.tools]]))
const TOOL_GROUP = new Map<string, string>()
for (const g of TOOL_GROUPS) for (const t of g.tools) if (!TOOL_GROUP.has(t)) TOOL_GROUP.set(t, g.id)

/** 某能力域的工具（未知组为空） */
export function groupTools(groupId: string): string[] {
  return (GROUP_TOOLS.get(groupId) || []).slice()
}

/** 某工具是否属于已选中的工具包 */
export function bundleHasTool(caps: any, tool: string): boolean {
  const g = TOOL_GROUP.get(String(tool))
  if (!g) return false
  return Array.isArray(caps?.toolBundles) && caps.toolBundles.includes(g)
}

/**
 * 从一份具体的工具集反推「包 + 覆盖」。
 * - 组内有任意工具被选中 → 选该组；
 * - 组内未选中的工具全部进入 exclude；
 * - 不属于任何组的工具（插件工具 / 未知工具）进入 include。
 */
export function bundlesOfTools(tools: readonly string[] | undefined | null): { bundles: string[]; overrides: ToolOverrides } {
  const enabled = new Set((tools || []).map(String))
  const bundles: string[] = []
  const exclude: string[] = []
  const known = new Set<string>()
  for (const group of TOOL_GROUPS) {
    const toolsOfGroup = group.tools as readonly string[]
    for (const t of toolsOfGroup) known.add(t)
    if (!toolsOfGroup.some((t) => enabled.has(t))) continue
    bundles.push(group.id)
    for (const t of toolsOfGroup) if (!enabled.has(t)) exclude.push(t)
  }
  const include = Array.from(enabled).filter((t) => !known.has(t))
  return { bundles, overrides: { ...(include.length ? { include } : {}), ...(exclude.length ? { exclude } : {}) } }
}

/** 旧预设升级：把 enabledTools 一次性折算成 toolBundles + toolOverrides（幂等） */
export function migrateCapsToToolBundles(caps: any): boolean {
  if (!caps || typeof caps !== 'object') return false
  if (caps.toolMode === 'auto' || caps.toolMode === 'custom') return false
  if (!Array.isArray(caps.enabledTools) || caps.enabledTools.length === 0) return false
  const { bundles, overrides } = bundlesOfTools(caps.enabledTools)
  caps.toolMode = 'auto'
  caps.toolBundles = bundles
  caps.toolOverrides = overrides
  return true
}

/** 按包 + 覆盖解析出的工具集（不做运行门控 / 插件剔除） */
export function autoToolsOf(caps: any): string[] {
  const out = new Set<string>()
  const selected = new Set(Array.isArray(caps?.toolBundles) ? caps.toolBundles.map(String) : [])
  for (const group of TOOL_GROUPS) {
    if (!selected.has(group.id)) continue
    for (const t of group.tools) out.add(t)
  }
  for (const t of caps?.toolOverrides?.include || []) out.add(String(t))
  for (const t of caps?.toolOverrides?.exclude || []) out.delete(String(t))
  return Array.from(out)
}

/** 用户当前的选择集（自动模式按包解析；旧模式读 enabledTools） */
export function selectedToolsOf(caps: any): string[] {
  if (caps?.toolMode === 'auto') return autoToolsOf(caps)
  return Array.isArray(caps?.enabledTools) ? caps.enabledTools.slice() : []
}

/** 包级开关（组头「全开 / 全关」用）：自动模式改 toolBundles，并清掉该组的单工具覆盖 */
export function setBundleEnabled(caps: any, groupId: string, on: boolean): boolean {
  if (!caps || caps.toolMode !== 'auto') return false
  const toolsOfGroup = groupTools(groupId)
  if (!toolsOfGroup.length) return false
  const bundles = new Set<string>(Array.isArray(caps.toolBundles) ? caps.toolBundles.map(String) : [])
  if (on) bundles.add(groupId)
  else bundles.delete(groupId)
  caps.toolBundles = Array.from(bundles)
  const overrides: ToolOverrides = {
    include: (Array.isArray(caps.toolOverrides?.include) ? caps.toolOverrides.include : []).filter((t: string) => !toolsOfGroup.includes(String(t))),
    exclude: (Array.isArray(caps.toolOverrides?.exclude) ? caps.toolOverrides.exclude : []).filter((t: string) => !toolsOfGroup.includes(String(t))),
  }
  caps.toolOverrides = overrides
  return true
}

/**
 * 单工具开关（自动模式写 overrides，旧模式由 capabilities.setToolEnabled 处理）。
 * @returns true=自动模式已处理；false=调用方走旧的 enabledTools 逻辑
 */
export function setToolOverride(caps: any, tool: string, on: boolean): boolean {
  if (!caps || caps.toolMode !== 'auto') return false
  const name = String(tool)
  const inBundle = bundleHasTool(caps, name)
  const selected = autoToolsOf(caps).includes(name)
  if (on === selected) return true
  const include = new Set<string>(Array.isArray(caps.toolOverrides?.include) ? caps.toolOverrides.include.map(String) : [])
  const exclude = new Set<string>(Array.isArray(caps.toolOverrides?.exclude) ? caps.toolOverrides.exclude.map(String) : [])
  if (on) {
    exclude.delete(name)
    if (!inBundle) include.add(name)
  } else {
    include.delete(name)
    if (inBundle) exclude.add(name)
  }
  caps.toolOverrides = {
    ...(include.size ? { include: Array.from(include) } : {}),
    ...(exclude.size ? { exclude: Array.from(exclude) } : {}),
  }
  return true
}

/** 运行门控原因（空串 = 不拦；供 UI 与运行时共用） */
export function toolGateReason(tool: string, env: ToolGateEnv = {}, zh = true): string {
  const name = String(tool)
  if (env.supportsVision === false && (name === 'read_image' || name === 'browser_screenshot')) {
    return zh ? '当前模型不支持图片输入' : 'Current model cannot take images'
  }
  if (env.sandboxMode === 'safe' && (name === 'shell' || ['write_file', 'replace_in_file', 'multi_replace'].includes(name))) {
    return zh ? '「只读」沙箱模式不可写入 / 执行命令' : 'Writes and shell are disabled in read-only sandbox mode'
  }
  if (env.hasKnowledge === false && name === 'kb_search') {
    return zh ? '未关联知识库' : 'No knowledge base linked'
  }
  if (env.hasMcpServers === false && name === 'mcp_call') {
    return zh ? '未选择 MCP 服务' : 'No MCP server selected'
  }
  if (env.browserAvailable === false && name.startsWith('browser_')) {
    return zh ? '浏览器未启用' : 'Browser is not available'
  }
  if (env.interactive === false && (name === 'ask_user' || name === 'exit_plan_mode')) {
    return zh ? '当前环境无法向用户提问' : 'No interactive user in this context'
  }
  if ((env.nestedDepth ?? 0) >= 1 && (name === 'run_subagent' || name.startsWith('job_'))) {
    return zh ? '子代理内不再嵌套子代理' : 'Nested subagents are disabled'
  }
  return ''
}

/** 按环境过滤工具（只做确定性的硬门控；字段缺省不拦） */
export function applyToolGates(tools: readonly string[], env: ToolGateEnv = {}, zh = true): string[] {
  return tools.filter((t) => !toolGateReason(t, env, zh))
}

/** 确保能力的 toolOverrides 形状合法（读旧存档 / 插件工具名时兜底） */
export function normalizeToolOverrides(raw: any): ToolOverrides {
  const include = Array.isArray(raw?.include) ? raw.include.map(String).filter(Boolean) : []
  const exclude = Array.isArray(raw?.exclude) ? raw.exclude.map(String).filter(Boolean) : []
  return {
    ...(include.length ? { include: Array.from(new Set(include)) } : {}),
    ...(exclude.length ? { exclude: Array.from(new Set(exclude)) } : {}),
  }
}

export { INTEGRATION_GROUP_ID, OTHER_GROUP_ID }
