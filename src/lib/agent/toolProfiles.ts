/**
 * toolProfiles.ts — Agent 预设的「能力模板」（工具包）
 *
 * 背景：逐工具开关（`caps.enabledTools`）精确但难维护——一个预设要手工点几十个工具，
 * 新工具发布后旧预设不会自动获得。这里提供若干**能力模板**：选中模板时一次性把该场景
 * 需要的工具集写进 `enabledTools`，之后用户仍可逐组 / 逐工具调整（调整后模板显示为「自定义」）。
 *
 * 注意：模板只是一次性批量赋值，不是运行时的第二套权威。运行时仍然只认
 * `capabilities.enabledTools`（见 capabilities.ts），因此不会出现「模板与手工开关打架」。
 */

import { TOOL_GROUPS } from './toolGroups'

export type ToolProfileId = 'readonly' | 'coding' | 'knowledge' | 'office' | 'browser' | 'full' | 'custom'

export interface ToolProfileDef {
  id: Exclude<ToolProfileId, 'custom'>
  labelZh: string
  labelEn: string
  icon: string
  /** 模板包含的能力域（TOOL_GROUPS.id） */
  groups: string[]
  /** 从这些组里剔除的工具（例如只读模板要去掉写入类工具） */
  exclude?: string[]
  /** 额外补入的工具（不属于任何能力域时使用） */
  include?: string[]
}

const WRITE_TOOLS = ['write_file', 'replace_in_file', 'multi_replace']
const EXPORT_TOOL = 'export_word'

/**
 * 模板清单（顺序即下拉框顺序）。
 *
 * 「只读分析 / 编码 / 知识库 / 办公 / 浏览器 / 全部」覆盖常见预设场景；
 * 「自定义」不在这里——它只是 UI 上表示「当前工具集不匹配任何模板」。
 */
export const TOOL_PROFILES: readonly ToolProfileDef[] = [
  {
    id: 'readonly',
    labelZh: '只读分析',
    labelEn: 'Read-only analysis',
    icon: 'fa-search',
    groups: ['files', 'interaction', 'web'],
    exclude: [...WRITE_TOOLS, EXPORT_TOOL],
  },
  {
    id: 'coding',
    labelZh: '编码助手',
    labelEn: 'Coding',
    icon: 'fa-code',
    groups: ['files', 'code', 'interaction', 'web', 'subagent'],
  },
  {
    id: 'knowledge',
    labelZh: '知识库问答',
    labelEn: 'Knowledge Q&A',
    icon: 'fa-cubes',
    groups: ['files', 'interaction', 'web', 'knowledge'],
    exclude: [...WRITE_TOOLS, EXPORT_TOOL],
  },
  {
    id: 'office',
    labelZh: '办公写作',
    labelEn: 'Office & writing',
    icon: 'fa-file-word-o',
    groups: ['files', 'interaction', 'knowledge'],
  },
  {
    id: 'browser',
    labelZh: '浏览器自动化',
    labelEn: 'Browser automation',
    icon: 'fa-window-maximize',
    groups: ['browser', 'browser-extra', 'web', 'interaction'],
  },
  {
    id: 'full',
    labelZh: '全部工具',
    labelEn: 'All tools',
    icon: 'fa-th',
    groups: TOOL_GROUPS.map((g) => g.id),
  },
]

const GROUP_TOOLS = new Map(TOOL_GROUPS.map((g) => [g.id, [...g.tools]]))

/** 某个能力域包含的工具名（未知组返回空数组） */
export function groupToolsOf(groupId: string): string[] {
  return (GROUP_TOOLS.get(groupId) || []).slice()
}

/** 模板对应的工具名集合（去重，保持模板内组顺序） */
export function toolsOfProfile(id: ToolProfileId): string[] {
  if (id === 'custom') return []
  const profile = TOOL_PROFILES.find((p) => p.id === id)
  if (!profile) return []
  const out = new Set<string>()
  for (const group of profile.groups) for (const tool of groupToolsOf(group)) out.add(tool)
  for (const tool of profile.include || []) out.add(tool)
  for (const tool of profile.exclude || []) out.delete(tool)
  return Array.from(out)
}

/**
 * 当前工具集匹配哪个模板（集合完全相等才算）。
 * 手工增删过任意工具后返回 'custom'——不把「接近」误报成模板，避免选择器显示错误状态。
 */
export function profileOfTools(tools: readonly string[] | undefined | null): ToolProfileId {
  const set = new Set((tools || []).map(String))
  for (const profile of TOOL_PROFILES) {
    const expected = toolsOfProfile(profile.id)
    if (expected.length !== set.size) continue
    if (expected.every((t) => set.has(t))) return profile.id
  }
  return 'custom'
}

/**
 * 自动模式按「能力域集合」匹配模板：单工具覆盖不影响模板归属。
 * 这样用户选完「编码助手」再关掉某一个工具，选择器仍显示「编码助手」，而不是跳成「自定义」。
 */
export function profileOfBundles(bundles: readonly string[] | undefined | null): ToolProfileId {
  const set = new Set((bundles || []).map(String))
  for (const profile of TOOL_PROFILES) {
    if (profile.groups.length !== set.size) continue
    if (profile.groups.every((g) => set.has(g))) return profile.id
  }
  return 'custom'
}

/** 模板的本地化名称（找不到返回原 id） */
export function profileLabel(id: string, zh: boolean): string {
  if (id === 'custom') return zh ? '自定义' : 'Custom'
  const p = TOOL_PROFILES.find((x) => x.id === id)
  return p ? (zh ? p.labelZh : p.labelEn) : id
}
