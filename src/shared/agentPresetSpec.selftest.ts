/**
 * agentPresetSpec.selftest.ts — 「AI 自己创建 Agent 预设」的校验规则自测
 *
 * 背景：预设原来只能由用户在设置页手改（store.agentPresets ← localStorage / .agent 文件）。
 * 现在模型可以经内置 MCP 服务 `builtin-agent-preset` 的 preset_write 代写，
 * 于是校验成了**唯一闸门**：判松了会写进一批运行时被静默剔除的坏预设，
 * 判紧了模型就写不进去。这里把边界固定下来：
 *
 *   1. 只有 error 阻断；warning 不阻断（但要如实回报）
 *   2. enabledTools 是唯一权威，能力槽布尔会被重算（不是反过来）
 *   3. 未知工具名 / 未知字段 / 重名 / 非法 id 一律 error（这些都会在运行时静默失效）
 *   4. 能自动修的就修，并记进 fixes（静默修正会让模型误以为它写的就是生效的）
 *
 * 用法：`node scripts/run-selftests.mjs agentPresetSpec`
 */

import {
  AGENT_PRESET_TOOL_SPECS,
  PRESET_CAPABILITY_DOCS,
  PRESET_FIELDS,
  formatValidationIssues,
  nearestName,
  presetCapabilitiesText,
  presetExampleText,
  presetIdProblem,
  presetSchemaText,
  validatePreset,
} from './agentPresetSpec'

export interface AgentPresetSpecCase {
  name: string
  ok: boolean
  detail?: string
}

const TOOLS = [
  'read_file', 'write_file', 'replace_in_file', 'multi_replace', 'list_dir', 'search_files',
  'kb_search', 'web_search', 'web_fetch', 'run_python', 'shell', 'mcp_call', 'skill',
  'ask_user', 'update_plan', 'exit_plan_mode', 'update_todo', 'run_subagent', 'job_output', 'job_kill',
]

const base = (over: any = {}) => ({
  id: 'note-coach',
  name: '笔记教练',
  systemPrompt: '你是笔记教练。',
  capabilities: { enabledTools: ['read_file', 'ask_user'] },
  ...over,
})

const ctx = {
  availableTools: TOOLS,
  existing: [{ id: 'builtin-code-agent', name: '代码智能体', builtin: true }, { id: 'mine', name: '我的预设' }],
  skillKeys: ['C:/skills/writer/SKILL.md'],
  kbPaths: ['C:/kb/notes.kb'],
  mcpServerIds: ['builtin-office', 'builtin-agent-preset'],
  llmTypes: ['deepseek', 'ollama'],
}

export function runAgentPresetSpecSelfTest(): AgentPresetSpecCase[] {
  const cases: AgentPresetSpecCase[] = []
  const add = (name: string, ok: boolean, detail = '') => cases.push({ name, ok, detail })

  // ---- 1. 正常路径 ----
  const okRes = validatePreset(base(), ctx)
  add('正常预设通过校验', okRes.ok && !okRes.errors.length, formatValidationIssues(okRes))
  add('正常预设保留 enabledTools 顺序', okRes.preset.capabilities.enabledTools.join('|') === 'read_file|ask_user', okRes.preset.capabilities.enabledTools.join('|'))
  add('缺省字段被补齐（tags/温度/轮数）',
    Array.isArray(okRes.preset.tags) && okRes.preset.temperature === 0.7 && okRes.preset.seedHistory === true,
    JSON.stringify({ tags: okRes.preset.tags, t: okRes.preset.temperature }))

  // ---- 2. id / name 的硬约束 ----
  add('缺 id = error', validatePreset(base({ id: undefined }), ctx).errors.some((e) => e.code === 'id.invalid'))
  add('中文 id = error', validatePreset(base({ id: '笔记教练' }), ctx).errors.some((e) => e.code === 'id.invalid'))
  add('大写 id = error', validatePreset(base({ id: 'NoteCoach' }), ctx).errors.some((e) => e.code === 'id.invalid'))
  add('带空格 id = error', validatePreset(base({ id: 'note coach' }), ctx).errors.some((e) => e.code === 'id.invalid'))
  add('文件名非法字符的 name = error', validatePreset(base({ name: 'a/b' }), ctx).errors.some((e) => e.code === 'name.illegal_char'))
  add('与现有预设重名 = error', validatePreset(base({ name: '我的预设' }), ctx).errors.some((e) => e.code === 'name.duplicate'))
  add('覆盖自己（同 id 同名）不算重名', validatePreset(base({ id: 'mine', name: '我的预设' }), ctx).ok)
  add('超长 name = error', validatePreset(base({ name: 'x'.repeat(61) }), ctx).errors.some((e) => e.code === 'name.too_long'))

  // ---- 3. 工具白名单：唯一权威 ----
  const unknownTool = validatePreset(base({ capabilities: { enabledTools: ['read_file', 'read_flie'] } }), ctx)
  add('未知工具名 = error', unknownTool.errors.some((e) => e.code === 'tools.unknown'), formatValidationIssues(unknownTool))
  add('未知工具名给出拼写建议', unknownTool.errors.some((e) => e.message.includes('read_file')), unknownTool.errors.map((e) => e.message).join(' '))
  add('插件未加载时其工具算未知', validatePreset(base({ capabilities: { enabledTools: ['my_plugin_tool'] } }), ctx).errors.some((e) => e.code === 'tools.unknown'))
  const slotOnly = validatePreset(base({ capabilities: { readFiles: true, writeFiles: false } }), { ...ctx, availableTools: [] })
  add('只给能力槽布尔 → 推导出 enabledTools 并记 fix',
    slotOnly.fixes.some((f) => f.includes('enabledTools')) && slotOnly.preset.capabilities.enabledTools.includes('read_file'),
    JSON.stringify(slotOnly.fixes))
  add('能力槽布尔被 enabledTools 反推（不反向覆盖）',
    validatePreset(base({ capabilities: { readFiles: true, writeFiles: true, enabledTools: ['read_file'] } }), ctx).preset.capabilities.writeFiles === false)
  add('run_code 不进 enabledTools（PTC 自动提供）',
    !validatePreset(base({ capabilities: { enabledTools: ['run_code', 'read_file'] } }), ctx).preset.capabilities.enabledTools.includes('run_code'))
  add('空 enabledTools = warning 但不阻断',
    (() => { const r = validatePreset(base({ capabilities: { enabledTools: [] } }), ctx); return r.ok && r.warnings.some((w) => w.code === 'tools.empty') })())

  // ---- 4. MCP 联动 ----
  const mcpFix = validatePreset(base({ capabilities: { enabledTools: ['read_file'], mcpAccess: true, mcpServerIds: ['builtin-office'] } }), ctx)
  add('mcpAccess 没勾 mcp_call → 自动补入并记 fix',
    mcpFix.preset.capabilities.enabledTools.includes('mcp_call') && mcpFix.fixes.some((f) => f.includes('mcp_call')),
    JSON.stringify(mcpFix.fixes))
  add('mcpServerIds 未配置 = warning（不阻断）',
    (() => { const r = validatePreset(base({ capabilities: { enabledTools: ['mcp_call'], mcpAccess: true, mcpServerIds: ['nope'] } }), ctx); return r.ok && r.warnings.some((w) => w.code === 'mcp.unknown_server') })())
  add('勾了 mcp_call 但没开 mcpAccess → 提示服务清单不注入',
    validatePreset(base({ capabilities: { enabledTools: ['mcp_call'] } }), ctx).warnings.some((w) => w.code === 'mcp.access_off'))

  // ---- 5. 知识库 ----
  add('kb_search 无关联文件 = warning',
    validatePreset(base({ capabilities: { enabledTools: ['kb_search'] } }), ctx).warnings.some((w) => w.code === 'kb.no_files'))
  add('kb_search + 真实 .kb 路径 = 无该 warning',
    !validatePreset(base({ capabilities: { enabledTools: ['kb_search'], knowledgeBaseFiles: ['C:/kb/notes.kb'] } }), ctx).warnings.some((w) => w.code === 'kb.no_files'))
  add('不存在的 .kb = warning',
    validatePreset(base({ capabilities: { enabledTools: ['kb_search'], knowledgeBaseFiles: ['C:/kb/nope.kb'] } }), ctx).warnings.some((w) => w.code === 'kb.unknown_path'))

  // ---- 6. 未知字段（模型最容易写错的字段名）----
  add('system_prompt 这类错字段 = error 且给建议',
    (() => { const r = validatePreset(base({ system_prompt: 'x' }), ctx); return !r.ok && r.errors.some((e) => e.code === 'field.unknown' && e.message.includes('systemPrompt')) })())
  add('builtin 标记被忽略（warning，不阻断）',
    (() => { const r = validatePreset(base({ builtin: true }), ctx); return r.ok && r.warnings.some((w) => w.code === 'field.builtin') && r.preset.builtin === undefined })())

  // ---- 7. 提示词 / 指令段 ----
  add('sections 模式没有段 = error',
    validatePreset(base({ loopPromptMode: 'sections', loopSections: [] }), ctx).errors.some((e) => e.code === 'sections.missing'))
  add('sections 模式正常拼装',
    validatePreset(base({
      loopPromptMode: 'sections',
      loopSections: [{ id: 'p', title: '人格', text: '你是评审员 {{cwd}}' }],
    }), ctx).ok)
  add('不支持的占位符 = warning',
    validatePreset(base({ loopPromptMode: 'sections', loopSections: [{ title: 'x', text: '{{date}}' }] }), ctx)
      .warnings.some((w) => w.code === 'sections.placeholder'))
  add('空提示词（auto 模式）= warning 不阻断',
    validatePreset(base({ systemPrompt: '' }), ctx).warnings.some((w) => w.code === 'prompt.empty'))
  add('超长提示词 = error',
    validatePreset(base({ systemPrompt: 'x'.repeat(20001) }), ctx).errors.some((e) => e.code === 'prompt.too_long'))

  // ---- 8. 数值边界 ----
  const clamped = validatePreset(base({ temperature: 9, kbTopK: 999, maxSteps: 0 }), ctx)
  add('temperature 超界 → 夹取并记 fix',
    clamped.preset.temperature === 2 && clamped.fixes.some((f) => f.includes('temperature')))
  add('kbTopK 超界 → 夹取', clamped.preset.kbTopK === 20)
  add('maxSteps=0 → error', clamped.errors.some((e) => e.code === 'maxSteps.invalid'))

  // ---- 9. 模型 / 技能 ----
  add('未知来源 = warning',
    validatePreset(base({ llmType: 'openai' }), ctx).warnings.some((w) => w.code === 'llm.unknown'))
  add('跟随默认（llmType 空）= 合法',
    validatePreset(base({ llmType: '' }), ctx).ok)
  add('未知技能 = warning（不静默丢掉）',
    validatePreset(base({ selectedSkills: ['C:/skills/nope/SKILL.md'] }), ctx).warnings.some((w) => w.code === 'skills.unknown'))
  add('已知技能 = 无 warning',
    !validatePreset(base({ selectedSkills: ['C:/skills/writer/SKILL.md'] }), ctx).warnings.some((w) => w.code === 'skills.unknown'))

  // ---- 10. 呈现方式 ----
  add('presentation=ptc 被保留', validatePreset(base({ presentation: 'ptc' }), ctx).preset.presentation === 'ptc')
  add('未知 presentation → native 并记 fix',
    (() => { const r = validatePreset(base({ presentation: 'code' }), ctx); return r.preset.presentation === 'native' && r.fixes.some((f) => f.includes('presentation')) })())

  // ---- 11. 辅助函数与工具表 ----
  add('presetIdProblem：合法 slug 通过', presetIdProblem('note-coach') === null && presetIdProblem('a.b_c-1') === null)
  add('presetIdProblem：空 / 中文 / 大写都拒绝', !!presetIdProblem('') && !!presetIdProblem('预设') && !!presetIdProblem('A'))
  add('nearestName 只在近距离给建议', nearestName('read_flie', TOOLS) === 'read_file' && nearestName('zzzz', TOOLS) === null)
  const names = AGENT_PRESET_TOOL_SPECS.map((s) => s.name)
  add('MCP 工具清单包含读写与自查',
    ['preset_schema', 'preset_list', 'preset_get', 'preset_validate', 'preset_write', 'preset_delete', 'preset_host', 'preset_capabilities', 'preset_example']
      .every((n) => names.includes(n)), names.join(' '))
  add('每个工具都有入参 schema', AGENT_PRESET_TOOL_SPECS.every((s) => s.inputSchema && s.inputSchema.type === 'object'))
  add('每个工具都有说明且不含空描述', AGENT_PRESET_TOOL_SPECS.every((s) => typeof s.description === 'string' && s.description.length > 20))

  // ---- 12. 给模型看的正文（内置 MCP 服务的静态话题）----
  // 这些正文是纯字符串，类型检查查不出内容退化；AGENT_PRESET_TOOL_SPECS 里广告的话题必须真的能取到内容。
  const schemaText = presetSchemaText()
  const capsText = presetCapabilitiesText()
  const exampleText = presetExampleText()
  add('preset_schema 说清 enabledTools 是唯一权威', schemaText.includes('enabledTools') && schemaText.includes('唯一权威'))
  add('preset_schema 给出六步工作流入口（list/get/validate/write）',
    ['preset_list', 'preset_get', 'preset_validate', 'preset_write'].every((n) => schemaText.includes(n)))
  add('preset_capabilities 覆盖全部能力槽', PRESET_CAPABILITY_DOCS.every((s) => capsText.includes(s.key)))
  add('preset_capabilities 给出四套常见组合', ['只读分析', '编码助手', '知识库问答', '工具调度'].every((n) => capsText.includes(n)))
  add('preset_example 含两份可照抄的完整预设',
    exampleText.includes('"id": "note-coach"') && exampleText.includes('"loopPromptMode": "sections"'))
  add('preset_example 里的键都是合法字段名（防止示例教会模型写错字段）',
    (() => {
      const known = new Set(PRESET_FIELDS.map((f) => f.key))
      const keys = Array.from(exampleText.matchAll(/^ {2}"([a-zA-Z_]+)":/gm)).map((m) => m[1])
      return keys.length > 5 && keys.every((k) => known.has(k))
    })(), '')
  add('三个静态话题都在 12k 字符以内（按需取用，别挤占上下文）',
    [schemaText, capsText, exampleText].every((t) => t.length < 12000),
    JSON.stringify({ schema: schemaText.length, caps: capsText.length, example: exampleText.length }))

  return cases
}
