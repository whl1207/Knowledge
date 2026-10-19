/**
 * toolRegistryView.selftest.ts — 注册表面板「查看作用域」的纯逻辑自测
 *
 * 锁住的规矩（这些错了界面都会**理直气壮地说错话**）：
 *   1. 默认口径**不判状态**（返回 null），不能把"没选作用域"当成"全部未启用"；
 *   2. 目标消失 / 会话清单没取到时同样返回 null —— "名单缺失"绝不能被当成"全部关闭"；
 *   3. 全局口径与 Agent 循环同源：数组原样、未配置回退默认集、合并 alwaysOn；
 *   4. 预设口径与预设运行时同源（复用 toolsFromCapabilities：逐工具模式、kb 需挂库、
 *      run_subagent 整族、插件工具"仍存在"净化）；
 *   5. select 值解析容错（脏值 / `agent:` 缺 id → none），会话名可读、已结束的会话不进选项。
 *
 * 用法：`node scripts/run-selftests.mjs toolRegistryView`
 */
import {
  REGISTRY_SCOPE_GLOBAL,
  REGISTRY_SCOPE_NONE,
  agentEnabledNames,
  agentLabel,
  agentStatusText,
  disabledNamesOf,
  enabledNamesForScope,
  globalEnabledNames,
  missingNamesOf,
  parseRegistryScope,
  presetEnabledNames,
  registryScopeOptions,
  scopeTargetAlive,
  scopeValueOf,
} from './toolRegistryView'
import { setPluginDeclaredToolNames, setPluginToolNames } from './capabilities'

export interface ToolRegistryViewCase {
  name: string
  ok: boolean
  detail?: string
}

const DEFAULT_TOOLS = ['read_file', 'list_dir', 'web_search', 'browser_navigate']
const ALWAYS_ON = ['run_code']

export function runToolRegistryViewSelfTest(): ToolRegistryViewCase[] {
  const cases: ToolRegistryViewCase[] = []
  const push = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, detail })

  // ---- 1) select 值 ↔ 结构化作用域 ----
  push('空值 = 不判状态',
    parseRegistryScope('').kind === 'none' && parseRegistryScope(undefined).kind === 'none',
    JSON.stringify(parseRegistryScope(undefined)))
  push('global 解析', parseRegistryScope(REGISTRY_SCOPE_GLOBAL).kind === 'global')
  push('preset: 解析出 id',
    (() => { const s = parseRegistryScope('preset:office'); return s.kind === 'preset' && s.id === 'office' })(),
    JSON.stringify(parseRegistryScope('preset:office')))
  push('agent: 解析出 id',
    (() => { const s = parseRegistryScope('agent:abc-123'); return s.kind === 'agent' && s.id === 'abc-123' })(),
    JSON.stringify(parseRegistryScope('agent:abc-123')))
  push('脏值 / 缺 id 一律回落 none（不能拿空名单把整页标成未启用）',
    parseRegistryScope('bogus').kind === 'none' &&
    parseRegistryScope('agent:').kind === 'none' &&
    parseRegistryScope('preset:').kind === 'none' &&
    parseRegistryScope(42 as any).kind === 'none',
    JSON.stringify([parseRegistryScope('bogus'), parseRegistryScope('agent:')]))
  push('scopeValueOf 往返一致',
    scopeValueOf('none') === REGISTRY_SCOPE_NONE &&
    scopeValueOf('global') === REGISTRY_SCOPE_GLOBAL &&
    scopeValueOf('preset', 'p1') === 'preset:p1' &&
    scopeValueOf('agent', 'a1') === 'agent:a1' &&
    scopeValueOf('agent', '') === REGISTRY_SCOPE_NONE,
    [scopeValueOf('preset', 'p1'), scopeValueOf('agent', 'a1')].join(','))

  // ---- 2) 目标是否还在（预设被删 / 会话结束 → 面板要回落） ----
  const presetScope = parseRegistryScope('preset:p1')
  const agentScope = parseRegistryScope('agent:a1')
  push('预设还在 → true；被删 → false',
    scopeTargetAlive(presetScope, { presets: [{ id: 'p1' }] }) &&
    !scopeTargetAlive(presetScope, { presets: [{ id: 'p2' }] }))
  push('会话还在 → true；已结束 → false',
    scopeTargetAlive(agentScope, { agents: [{ id: 'a1' }] }) &&
    !scopeTargetAlive(agentScope, { agents: [] }))
  push('none / global 恒为 true',
    scopeTargetAlive(parseRegistryScope(''), {}) && scopeTargetAlive(parseRegistryScope('global'), {}))

  // ---- 3) 全局口径：与 Agent 循环同源 ----
  const gDefault = globalEnabledNames(null, { defaultTools: DEFAULT_TOOLS, alwaysOn: ALWAYS_ON })
  push('未配置 → 默认集 + alwaysOn',
    DEFAULT_TOOLS.every((n) => gDefault.has(n)) && gDefault.has('run_code') && gDefault.size === 5,
    [...gDefault].join(','))
  const gArray = globalEnabledNames(['read_file', 'browser_extract_markdown'], { defaultTools: DEFAULT_TOOLS, alwaysOn: ALWAYS_ON })
  push('显式数组**原样**生效（不在静态默认集里的 browser_* 也算启用）',
    gArray.has('browser_extract_markdown') && gArray.has('run_code') && !gArray.has('list_dir'),
    [...gArray].join(','))
  push('空数组 = 全部关闭（仅 alwaysOn）',
    (() => { const s = globalEnabledNames([], { defaultTools: DEFAULT_TOOLS, alwaysOn: ALWAYS_ON }); return s.size === 1 && s.has('run_code') })(),
    [...globalEnabledNames([], { defaultTools: DEFAULT_TOOLS })].join(','))
  push('脏值（对象 / 数字）回退默认集',
    globalEnabledNames({ a: 1 }, { defaultTools: DEFAULT_TOOLS }).has('read_file') &&
    globalEnabledNames(42, { defaultTools: DEFAULT_TOOLS }).has('web_search'))
  push('数组里的非字符串项被忽略且不抛错',
    (() => { const s = globalEnabledNames(['read_file', 42, null, ''], { defaultTools: [] }); return s.size === 2 && s.has('read_file') })(),
    [...globalEnabledNames(['read_file', 42, null, ''], { defaultTools: [] })].join(','))

  // ---- 4) 预设口径：与预设运行时同源（复用 toolsFromCapabilities）----
  const legacyCaps = { readFiles: true, executeCode: false, knowledgeBaseFiles: [] }
  const legacy = presetEnabledNames(legacyCaps)
  push('旧模式：能力槽布尔 → 工具名',
    legacy.has('read_file') && legacy.has('search_files') && !legacy.has('run_python'),
    [...legacy].join(','))
  push('旧模式：askUser / updatePlan / updateTodo 缺省开启',
    legacy.has('ask_user') && legacy.has('update_plan') && legacy.has('exit_plan_mode') && legacy.has('update_todo'),
    [...legacy].join(','))
  push('旧模式：知识库检索需已挂库文件（避免"开了检索却无库可检"）',
    !legacy.has('kb_search') &&
    presetEnabledNames({ ...legacyCaps, accessKnowledgeBase: true, knowledgeBaseFiles: ['a.kb'] }).has('kb_search'),
    [...legacy].join(','))
  const perTool = presetEnabledNames({ enabledTools: ['replace_in_file', 'run_subagent', 'kb_search'], knowledgeBaseFiles: [] })
  push('逐工具模式：精确到单个工具（只开 replace_in_file 就不带 write_file）',
    perTool.has('replace_in_file') && !perTool.has('write_file'),
    [...perTool].join(','))
  push('逐工具模式：run_subagent 整族一起开（否则收不到 jobId 的结果）',
    perTool.has('job_output') && perTool.has('job_kill'),
    [...perTool].join(','))
  push('逐工具模式：没挂库文件时 kb_search 被剔除',
    !perTool.has('kb_search'), [...perTool].join(','))

  // ---- 5) 插件工具"仍存在"净化（预设里残留的名字要剔掉） ----
  setPluginDeclaredToolNames(['hello_echo'])
  setPluginToolNames([])
  const dropped = presetEnabledNames({ enabledTools: ['read_file', 'hello_echo'] })
  setPluginToolNames(['hello_echo'])
  const kept = presetEnabledNames({ enabledTools: ['read_file', 'hello_echo'] })
  setPluginDeclaredToolNames([])
  setPluginToolNames([])
  push('插件已停用 → 预设里残留的插件工具被剔除',
    !dropped.has('hello_echo') && dropped.has('read_file'), [...dropped].join(','))
  push('插件已激活 → 插件工具保留', kept.has('hello_echo'), [...kept].join(','))

  // ---- 6) 作用域 → 启用集（null = 不显示启用状态） ----
  const presets = [{ id: 'p1', capabilities: { enabledTools: ['read_file'] } }]
  push('默认口径 → null（不判状态）',
    enabledNamesForScope({ scope: parseRegistryScope(''), globalStored: null }) === null)
  push('全局口径 → 与 globalEnabledNames 一致',
    (() => {
      const s = enabledNamesForScope({
        scope: parseRegistryScope('global'),
        globalStored: ['write_file'],
        globalDefaultTools: DEFAULT_TOOLS,
        globalAlwaysOn: ALWAYS_ON,
      })
      return !!s && s.has('write_file') && s.has('run_code') && !s.has('read_file')
    })())
  push('预设不存在 → null（不能拿空集当"全部未启用"）',
    enabledNamesForScope({ scope: parseRegistryScope('preset:gone'), presets }) === null)
  push('预设已存在 → 该预设的工具集',
    (() => { const s = enabledNamesForScope({ scope: parseRegistryScope('preset:p1'), presets }); return !!s && s.has('read_file') && !s.has('write_file') })())
  push('会话清单未取到（null / undefined）→ null',
    enabledNamesForScope({ scope: parseRegistryScope('agent:a1'), agentToolNames: null }) === null &&
    enabledNamesForScope({ scope: parseRegistryScope('agent:a1') }) === null)
  push('会话清单已取到 → 该会话下发集',
    (() => { const s = enabledNamesForScope({ scope: parseRegistryScope('agent:a1'), agentToolNames: ['read_file', 'mcp_call'] }); return !!s && s.size === 2 && s.has('mcp_call') })())
  push('agentEnabledNames：null → null；数组 → 集合',
    agentEnabledNames(null) === null && agentEnabledNames(['a'])?.has('a') === true)

  // ---- 7) 未启用 / 缺失名单 ----
  const disabled = disabledNamesOf(['read_file', 'write_file', 'shell'], new Set(['read_file']))
  push('未启用 = 注册表里有但不在启用集',
    disabled.size === 2 && disabled.has('write_file') && disabled.has('shell'), [...disabled].join(','))
  push('不判状态时不标未启用（空集）',
    disabledNamesOf(['read_file'], null).size === 0)
  push('缺失名单 = 启用集里有但注册表里没有（插件未加载 / 渲染层工具）',
    missingNamesOf(new Set(['read_file', 'ghost_tool']), ['read_file']).join(',') === 'ghost_tool',
    missingNamesOf(new Set(['read_file', 'ghost_tool']), ['read_file']).join(','))
  push('不判状态时缺失名单为空', missingNamesOf(null, ['read_file']).length === 0)

  // ---- 8) 会话名与状态（select 里要看得懂是哪个入口） ----
  push('agent-loop → 通用智能体 / General agent',
    agentLabel({ id: 'abcdefgh-1234', label: 'agent-loop' }, true) === '通用智能体' &&
    agentLabel({ id: 'abcdefgh-1234', label: 'agent-loop' }, false) === 'General agent',
    agentLabel({ id: 'x', label: 'agent-loop' }, true))
  push('skill: / workflow: / subagent: 带名字',
    agentLabel({ id: 'x', label: 'skill:my-skill' }, true) === '技能 my-skill' &&
    agentLabel({ id: 'x', label: 'workflow:办公智能体' }, true) === '工作流 办公智能体' &&
    agentLabel({ id: 'x', label: 'subagent:scout' }, true) === '子代理 scout',
    [agentLabel({ id: 'x', label: 'skill:my-skill' }, true), agentLabel({ id: 'x', label: 'workflow:办公智能体' }, true)].join(' | '))
  push('没有 label → 用短 id 兜底（不出现空选项）',
    agentLabel({ id: 'abcdefgh-1234' }, true).includes('abcdefgh'),
    agentLabel({ id: 'abcdefgh-1234' }, true))
  push('状态文案：运行中 / 空闲 / 已结束',
    agentStatusText('running', true) === '运行中' &&
    agentStatusText('idle', true) === '空闲' &&
    agentStatusText('disposed', true) === '已结束',
    [agentStatusText('running', true), agentStatusText('idle', true), agentStatusText('disposed', true)].join(','))

  // ---- 9) 选项分组：预设全量、会话过滤已结束 ----
  const groups = registryScopeOptions({
    presets: [{ id: 'p1', name: '办公智能体' }, { id: 'p2' }],
    agents: [
      { id: 'a1', label: 'agent-loop', status: 'running' },
      { id: 'a2', label: 'skill:x', status: 'idle' },
      { id: 'a3', label: 'batch:r1', status: 'disposed' },
    ],
    zh: true,
  })
  push('预设选项带 value=preset:id 与可读名',
    groups.preset.length === 2 &&
    groups.preset[0].value === 'preset:p1' && groups.preset[0].label === '办公智能体' &&
    groups.preset[1].label === 'p2',
    JSON.stringify(groups.preset))
  push('会话选项过滤 disposed 并标状态',
    groups.agent.length === 2 &&
    groups.agent[0].value === 'agent:a1' && groups.agent[0].label === '通用智能体 · 运行中' &&
    groups.agent[1].label === '技能 x · 空闲',
    JSON.stringify(groups.agent))

  return cases
}

/** 命令行入口 */
export function logToolRegistryViewSelfTest(): boolean {
  const cases = runToolRegistryViewSelfTest()
  const failed = cases.filter((c) => !c.ok)
  for (const c of failed) console.log(`  [FAIL] ${c.name}${c.detail ? ' -- ' + c.detail : ''}`)
  console.log(`[toolRegistryView] ${cases.length - failed.length}/${cases.length} passed`)
  return failed.length === 0
}
