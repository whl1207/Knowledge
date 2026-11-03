/**
 * toolGroups.selftest.ts — 工具分组表（lib/agent/toolGroups.ts）的纯逻辑自测
 *
 * 锁住几条“界面会静默出错”的规矩：
 *   1. **注册表里的每个工具都必须能落到某个组**：漏登记会掉进「其他」兜底组，
 *      界面上虽然还在，但分组语义已经错了 —— 这里直接判失败，逼开发者登记。
 *   2. **组表里写的工具名必须真实存在**：拼错名字会让一个组永远少一行，且没人报错。
 *   3. **一个工具只能属于一个组**：重复登记时 `toolGroupIdOf` 先到先得，另一处永远不显示。
 *   4. **插件工具恒归「MCP 与插件」**，与插件名 / 工具名无关（插件可以注册任意名字）。
 *   5. **浏览器族只出现在浏览器组**：groupToolRows 没有按前缀猜组，归属全靠表，这条防止
 *      以后有人图省事改成前缀匹配、把 web_fetch 之类也吸走。
 *
 * 用法：`node scripts/run-selftests.mjs toolGroups`
 */
import { AGENT_TOOL_REGISTRY } from '@/services/agentSkills'
import { CAPABILITY_TOOL_SLOTS } from './capabilities'
import {
  INTEGRATION_GROUP_ID,
  OTHER_GROUP_ID,
  TOOL_GROUPS,
  groupToolRows,
  toolGroupIdOf,
  type GroupableToolRow,
} from './toolGroups'

export interface ToolGroupsCase {
  name: string
  ok: boolean
  detail?: string
}

const registryNames = AGENT_TOOL_REGISTRY.map((t) => t.name)

const rowOf = (name: string, extra: Partial<GroupableToolRow> = {}): GroupableToolRow => {
  const info = AGENT_TOOL_REGISTRY.find((t) => t.name === name)
  return {
    name,
    labelZh: info?.labelZh || name,
    labelEn: info?.labelEn || name,
    icon: info?.icon || 'fa-cube',
    description: info?.description || '',
    on: true,
    srcKind: 'builtin',
    ...extra,
  }
}

export function runToolGroupsSelfTest(): ToolGroupsCase[] {
  const cases: ToolGroupsCase[] = []
  const push = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, detail })

  const allGroupTools = TOOL_GROUPS.flatMap((g) => g.tools as string[])
  const duplicated = allGroupTools.filter((n, i) => allGroupTools.indexOf(n) !== i)

  // ---- 1) 表本身自洽 ----
  push('分组 id 不重复', new Set(TOOL_GROUPS.map((g) => g.id)).size === TOOL_GROUPS.length,
    TOOL_GROUPS.map((g) => g.id).join(','))
  push('组表里没有重复登记的工具', duplicated.length === 0, duplicated.join(','))
  push('每个组都至少有一个工具', TOOL_GROUPS.every((g) => g.tools.length > 0),
    TOOL_GROUPS.map((g) => `${g.id}:${g.tools.length}`).join(' '))
  push('组表里的工具名都真实存在于注册表（防拼错）',
    allGroupTools.every((n) => registryNames.includes(n)),
    allGroupTools.filter((n) => !registryNames.includes(n)).join(','))
  push('组表覆盖注册表全部工具（防漏登记 → 掉进「其他」）',
    registryNames.every((n) => allGroupTools.includes(n)),
    registryNames.filter((n) => !allGroupTools.includes(n)).join(','))

  // ---- 2) 分组函数：全覆盖、不丢行、无兜底 ----
  const rows = AGENT_TOOL_REGISTRY.map((t) => rowOf(t.name))
  const sections = groupToolRows(rows)
  const outRows = sections.flatMap((s) => s.rows)
  push('分组后行数不变（不丢工具）', outRows.length === rows.length,
    `${outRows.length} / ${rows.length}`)
  push('分组后没有重复行', new Set(outRows.map((r) => r.name)).size === outRows.length,
    outRows.map((r) => r.name).join(','))
  push('没有工具掉进「其他」兜底组',
    !sections.some((s) => s.id === OTHER_GROUP_ID),
    sections.filter((s) => s.id === OTHER_GROUP_ID).flatMap((s) => s.rows.map((r) => r.name)).join(','))
  push('全部能力域都出现（含 MCP 与插件）',
    sections.length === TOOL_GROUPS.length && sections.some((s) => s.id === INTEGRATION_GROUP_ID),
    sections.map((s) => s.id).join(','))

  // ---- 3) 归属正确性 ----
  const sectionOf = (name: string) => sections.find((s) => s.rows.some((r) => r.name === name))?.id || ''
  push('read_file / write_file 在「文件与目录」',
    sectionOf('read_file') === 'files' && sectionOf('write_file') === 'files',
    `${sectionOf('read_file')} / ${sectionOf('write_file')}`)
  push('mcp_call 在「MCP 与插件」', sectionOf('mcp_call') === INTEGRATION_GROUP_ID, sectionOf('mcp_call'))
  push('browser_* 只在「浏览器自动化 / 扩展」两组（不按前缀吸走别的工具）',
    registryNames.filter((n) => n.startsWith('browser_')).every((n) => sectionOf(n) === 'browser' || sectionOf(n) === 'browser-extra') &&
    sections.find((s) => s.id === 'browser')!.rows.every((r) => r.name.startsWith('browser_')) &&
    sections.find((s) => s.id === 'browser-extra')!.rows.every((r) => r.name.startsWith('browser_')),
    [sections.find((s) => s.id === 'browser')!, sections.find((s) => s.id === 'browser-extra')!].map((s) => s.rows.map((r) => r.name).join(',')).join(' | '))
  push('web_fetch 属于「联网搜索」而不是浏览器组', sectionOf('web_fetch') === 'web', sectionOf('web_fetch'))

  // ---- 4) 插件工具：名字随便起，都归「MCP 与插件」 ----
  const pluginRow = rowOf('hello_echo', { srcKind: 'plugin' })
  const pluginSections = groupToolRows([...rows, pluginRow])
  const integration = pluginSections.find((s) => s.id === INTEGRATION_GROUP_ID)!
  push('插件工具归入「MCP 与插件」',
    integration.rows.some((r) => r.name === 'hello_echo'),
    integration.rows.map((r) => r.name).join(','))
  push('插件工具不会占用内置工具的组归属（内置那行仍在原位）',
    pluginSections.filter((s) => s.rows.some((r) => r.name === 'read_file')).length === 1)

  // ---- 5) 未知工具兜底：宁可多一组，也不能让工具消失 ----
  const unknown = rowOf('brand_new_tool_not_registered_yet')
  const withUnknown = groupToolRows([...rows, unknown])
  const other = withUnknown.find((s) => s.id === OTHER_GROUP_ID)
  push('未登记工具落到「其他」而不是消失',
    !!other && other.rows.some((r) => r.name === 'brand_new_tool_not_registered_yet'),
    other?.rows.map((r) => r.name).join(','))
  push('「其他」组排在最后', withUnknown[withUnknown.length - 1].id === OTHER_GROUP_ID,
    withUnknown.map((s) => s.id).join(','))
  push('toolGroupIdOf 对未知工具返回空串', toolGroupIdOf('nope_not_a_tool') === '')

  // ---- 6) 与运行时能力槽交叉校验：槽里出现、注册表里也有的工具必须能查到组 ----
  const slotTools = [...new Set(CAPABILITY_TOOL_SLOTS.flatMap((s) => s.tools))]
  const slotToolsInRegistry = slotTools.filter((n) => registryNames.includes(n))
  push('能力槽里的注册表工具都能查到所属组',
    slotToolsInRegistry.every((n) => !!toolGroupIdOf(n)),
    slotToolsInRegistry.filter((n) => !toolGroupIdOf(n)).join(','))

  // ---- 7) 默认折叠：浏览器 / 插件默认收起，常用组默认展开 ----
  const defOf = (id: string) => TOOL_GROUPS.find((g) => g.id === id)!
  push('浏览器 / 扩展工具 / MCP 与插件默认折叠',
    !!defOf('browser').defaultCollapsed && !!defOf('browser-extra').defaultCollapsed && !!defOf(INTEGRATION_GROUP_ID).defaultCollapsed)
  push('文件 / 对话 / 联网 默认展开',
    !defOf('files').defaultCollapsed && !defOf('interaction').defaultCollapsed && !defOf('web').defaultCollapsed)

  return cases
}

/** 命令行入口 */
export function logToolGroupsSelfTest(): boolean {
  const cases = runToolGroupsSelfTest()
  const failed = cases.filter((c) => !c.ok)
  for (const c of failed) console.log(`  [FAIL] ${c.name}${c.detail ? ' -- ' + c.detail : ''}`)
  console.log(`[toolGroups] ${cases.length - failed.length}/${cases.length} passed`)
  return failed.length === 0
}
