/**
 * toolWhitelist.selftest.ts — 全局工具白名单的纯逻辑自测
 *
 * 锁住三条曾经真实出问题的规矩：
 *   1. **插件工具必须能出现在列表里**（以前只渲染静态表 AGENT_TOOL_REGISTRY，插件工具看不见）；
 *   2. **插件工具名不能被当成非法名丢掉**（以前 `loadEnabled` 拿内置表判合法性，
 *      用户勾了插件工具、重启后白名单里就没了）；
 *   3. **默认态**：未配置时内置按 defaultEnabled、**插件工具默认关闭**
 *      （方案 B：插件工具显式勾选才生效），且 alwaysOn 不落盘、插件工具要落盘。
 *
 * 用法：`node scripts/run-selftests.mjs toolWhitelist`
 */
import {
  computeEnabledTools,
  persistableToolNames,
  pluginNameOfScope,
  pluginToolRows,
  type WhitelistToolRow,
} from './toolWhitelist'

export interface ToolWhitelistCase {
  name: string
  ok: boolean
  detail?: string
}

const row = (name: string, extra: Partial<WhitelistToolRow> = {}): WhitelistToolRow => ({
  name,
  labelZh: name,
  labelEn: name,
  icon: 'fa-cube',
  description: '',
  sandboxPreference: 'none',
  approvalRequirement: 'auto',
  defaultEnabled: true,
  ...extra,
})

const BUILTIN_ROWS: WhitelistToolRow[] = [
  row('read_file'),
  row('write_file'),
  row('ask_user'),
  row('run_code', { alwaysOn: true, defaultEnabled: false }),
  row('export_word', { defaultEnabled: false }),
  row('mcp_call', { defaultEnabled: false }),
]

const PLUGIN_ROWS: WhitelistToolRow[] = pluginToolRows(
  ['mathproof_init', 'mathproof_add_fact', 'hello_echo'],
  { mathproof_init: 'plugin:math-proof-graph', mathproof_add_fact: 'plugin:math-proof-graph', hello_echo: 'plugin:hello-panel' },
)

const ALL_ROWS = [...BUILTIN_ROWS, ...PLUGIN_ROWS]

export function runToolWhitelistSelfTest(): ToolWhitelistCase[] {
  const cases: ToolWhitelistCase[] = []
  const push = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, detail })

  // ---- 1) 插件工具行能被构造出来，并带来源标识 ----
  push('pluginToolRows 造出 3 行', PLUGIN_ROWS.length === 3, String(PLUGIN_ROWS.length))
  push('插件行标记 srcKind=plugin 并带来源名',
    PLUGIN_ROWS.every((r) => r.srcKind === 'plugin' && !!r.srcLabel),
    JSON.stringify(PLUGIN_ROWS.map((r) => `${r.name}:${r.srcLabel}`)))
  push('插件行默认关闭（defaultEnabled=false）', PLUGIN_ROWS.every((r) => r.defaultEnabled === false))
  push('scope 解析：plugin:xxx → xxx；其它 → 空串',
    pluginNameOfScope('plugin:math-proof-graph') === 'math-proof-graph' &&
    pluginNameOfScope('plugin:a/b') === 'a' &&
    pluginNameOfScope('') === '' && pluginNameOfScope(undefined) === '' && pluginNameOfScope('core') === '',
    JSON.stringify([pluginNameOfScope('plugin:math-proof-graph'), pluginNameOfScope('core')]))

  // ---- 2) 未配置（null）：内置默认开、插件默认关 ----
  const dflt = computeEnabledTools(null, ALL_ROWS)
  push('未配置时内置 defaultEnabled 项默认开启',
    dflt.has('read_file') && dflt.has('write_file') && dflt.has('ask_user'),
    [...dflt].join(','))
  push('未配置时 defaultEnabled=false 的内置项默认关闭',
    !dflt.has('export_word') && !dflt.has('mcp_call'),
    [...dflt].join(','))
  push('未配置时 alwaysOn 恒开（即使 defaultEnabled=false）', dflt.has('run_code'), [...dflt].join(','))
  push('未配置时**插件工具默认关闭**（方案 B 的核心）',
    !dflt.has('mathproof_init') && !dflt.has('hello_echo'),
    [...dflt].join(','))

  // ---- 3) 显式白名单：插件工具名必须被保留（这条以前是坏的）----
  const stored = ['read_file', 'mathproof_init', 'mathproof_add_fact', 'hello_echo']
  const explicit = computeEnabledTools(stored, ALL_ROWS)
  push('显式白名单里的插件工具被保留（不被当非法名丢掉）',
    explicit.has('mathproof_init') && explicit.has('mathproof_add_fact') && explicit.has('hello_echo'),
    [...explicit].join(','))
  push('显式白名单只保留列出的项（未列出的内置项不进来）',
    !explicit.has('write_file') && !explicit.has('web_search'),
    [...explicit].join(','))
  push('显式白名单模式下 alwaysOn 仍被合并进来', explicit.has('run_code'), [...explicit].join(','))

  // ---- 4) 失效/脏数据：不在列表里的名字被剔除，且不抛错 ----
  const dirty = computeEnabledTools(['read_file', 'a_tool_from_uninstalled_plugin', 42, null, ''], ALL_ROWS)
  push('不在当前列表里的名字被剔除', !dirty.has('a_tool_from_uninstalled_plugin'), [...dirty].join(','))
  push('非字符串项被忽略且不抛错', dirty.has('read_file'), [...dirty].join(','))
  push('空数组 = 全部关闭（仅保留 alwaysOn）',
    (() => { const s = computeEnabledTools([], ALL_ROWS); return s.size === 1 && s.has('run_code') })(),
    [...computeEnabledTools([], ALL_ROWS)].join(','))

  // ---- 5) 落盘规则：alwaysOn 不写、插件工具要写 ----
  const persisted = persistableToolNames(new Set(['read_file', 'run_code', 'mathproof_init', 'hello_echo']), ALL_ROWS)
  push('alwaysOn 不落盘', !persisted.includes('run_code'), persisted.join(','))
  push('插件工具要落盘（否则重启即丢）',
    persisted.includes('mathproof_init') && persisted.includes('hello_echo'),
    persisted.join(','))
  push('落盘顺序稳定（按列表顺序）', persisted.join(',') === 'read_file,mathproof_init,hello_echo', persisted.join(','))

  // ---- 6) 往返：落盘后再读回，启用集不变 ----
  const roundTrip = computeEnabledTools(persisted, ALL_ROWS)
  push('启用集往返一致（落盘→读回）',
    ['read_file', 'mathproof_init', 'hello_echo', 'run_code'].every((n) => roundTrip.has(n)) && roundTrip.size === 4,
    [...roundTrip].join(','))

  return cases
}

/** 命令行入口 */
export function logToolWhitelistSelfTest(): boolean {
  const cases = runToolWhitelistSelfTest()
  const failed = cases.filter((c) => !c.ok)
  for (const c of failed) console.log(`  [FAIL] ${c.name}${c.detail ? ' -- ' + c.detail : ''}`)
  console.log(`[toolWhitelist] ${cases.length - failed.length}/${cases.length} passed`)
  return failed.length === 0
}
