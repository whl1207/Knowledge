/**
 * builtinAgentPresets.selftest.ts — 内置预设清单的「注入 / 顺序 / 改名」自测
 *
 * 为什么值得测：内置预设是**持久化副本**，注入逻辑一旦把顺序弄反，
 * 用户看到的就是「技能设计师跑到代码智能体前面」，而代码审查很难看出来；
 * 三个「设计师」必须排在其它内置之后（技能 → 智能体 → 插件），用户自建预设的位置不能被动。
 *
 * 用法：`node scripts/run-selftests.mjs builtinPresets`
 */

import {
  BUILTIN_AGENT_PRESET_IDS,
  BUILTIN_AGENT_PRESETS,
  ensureBuiltinAgentPresets,
  builtinPresetDefaultOf,
  refreshBuiltinAgentPresets,
  resetBuiltinAgentPreset,
} from './builtinAgentPresets'

export interface BuiltinPresetsCase {
  name: string
  ok: boolean
  detail?: string
}

const ids = (list: any[]): string[] => list.map((p) => String(p?.id))

export function runBuiltinPresetsSelfTest(): BuiltinPresetsCase[] {
  const cases: BuiltinPresetsCase[] = []
  const add = (name: string, ok: boolean, detail = '') => cases.push({ name, ok, detail })

  const expected = [
    BUILTIN_AGENT_PRESET_IDS.code,
    BUILTIN_AGENT_PRESET_IDS.office,
    BUILTIN_AGENT_PRESET_IDS.ptc,
    BUILTIN_AGENT_PRESET_IDS.pi,
    BUILTIN_AGENT_PRESET_IDS.dsh,
    BUILTIN_AGENT_PRESET_IDS.codex,
    BUILTIN_AGENT_PRESET_IDS.skillDesigner,
    BUILTIN_AGENT_PRESET_IDS.designer,
    BUILTIN_AGENT_PRESET_IDS.plugin,
  ]

  // 1. 出厂数组顺序 = 展示顺序
  add('出厂数组顺序：其它内置在前、三个设计师在后', JSON.stringify(ids(BUILTIN_AGENT_PRESETS)) === JSON.stringify(expected),
    ids(BUILTIN_AGENT_PRESETS).join(' > '))

  // 2. 空列表注入
  const fresh: any[] = []
  const changed = ensureBuiltinAgentPresets(fresh)
  add('空列表：注入全部内置预设', changed && fresh.length === expected.length, `${fresh.length}`)
  add('空列表：顺序与展示顺序一致', JSON.stringify(ids(fresh)) === JSON.stringify(expected), ids(fresh).join(' > '))
  add('空列表：全部带内置标记', fresh.every((p) => p.builtin === true))
  add('再次注入是幂等的', ensureBuiltinAgentPresets(fresh) === false)

  // 3. 改名后的显示名
  add('插件设计师名称已更新', fresh.find((p) => p.id === BUILTIN_AGENT_PRESET_IDS.plugin)?.name === '插件设计师')
  add('智能体设计师名称已更新', fresh.find((p) => p.id === BUILTIN_AGENT_PRESET_IDS.designer)?.name === '智能体设计师')
  add('技能设计师已注册', fresh.some((p) => p.id === BUILTIN_AGENT_PRESET_IDS.skillDesigner && p.name === '技能设计师'))
  add('技能设计师绑定内置技能服务',
    JSON.stringify(fresh.find((p) => p.id === BUILTIN_AGENT_PRESET_IDS.skillDesigner)?.capabilities?.mcpServerIds) === '["builtin-skill-dev"]')

  // 4. 老用户存档（旧顺序 + 缺技能设计师 + 中间夹着自建预设）→ 只整理内置项
  const legacy: any[] = [
    { id: BUILTIN_AGENT_PRESET_IDS.code, name: '代码智能体', builtin: true },
    { id: 'user-a', name: '我的预设' },
    { id: BUILTIN_AGENT_PRESET_IDS.office, name: '办公智能体', builtin: true },
    { id: BUILTIN_AGENT_PRESET_IDS.ptc, name: 'PTC 智能体', builtin: true },
    { id: BUILTIN_AGENT_PRESET_IDS.plugin, name: '插件开发智能体', builtin: true },
    { id: 'user-b', name: '另一个自建' },
  ]
  const legacyChanged = ensureBuiltinAgentPresets(legacy)
  add('老存档：补上缺失的内置项', legacyChanged && legacy.some((p) => p.id === BUILTIN_AGENT_PRESET_IDS.skillDesigner))
  const builtinSubsequence = legacy.filter((p) => p.builtin).map((p) => p.id)
  add('老存档：内置项之间的顺序被整理成展示顺序',
    JSON.stringify(builtinSubsequence) === JSON.stringify(expected), builtinSubsequence.join(' > '))
  const firstCustom = legacy.findIndex((p) => !p.builtin)
  add('老存档：内置项全部排在自定义项之前',
    firstCustom === expected.length, ids(legacy).join(' > '))
  add('老存档：自定义项之间保持原相对顺序',
    JSON.stringify(legacy.filter((p) => !p.builtin).map((p) => p.id)) === JSON.stringify(['user-a', 'user-b']))
  add('老存档：不覆盖已有的内置预设内容（旧名字保留）',
    legacy.find((p) => p.id === BUILTIN_AGENT_PRESET_IDS.plugin)?.name === '插件开发智能体')

  // 4.5 自定义项拖到最前 / 内置项被拖到自定义之后 → 一律还原为「内置在前、自定义在后」
  const dragged: any[] = [
    { id: 'custom-first', name: '拖到最前的自建', builtin: false },
    ...expected.slice().reverse().map((id) => ({ id, name: id, builtin: true })),
    { id: 'custom-last', name: '自建', builtin: false },
  ]
  const draggedChanged = ensureBuiltinAgentPresets(dragged)
  add('自定义项被拖到最前：自动回到内置项之后',
    draggedChanged === true && dragged.findIndex((p) => !p.builtin) === expected.length, ids(dragged).join(' > '))
  add('重排后内置项仍是展示顺序',
    JSON.stringify(dragged.filter((p) => p.builtin).map((p) => p.id)) === JSON.stringify(expected))
  add('重排后自定义项相对顺序不变',
    JSON.stringify(dragged.filter((p) => !p.builtin).map((p) => p.id)) === JSON.stringify(['custom-first', 'custom-last']))
  add('重排后再调用是幂等的', ensureBuiltinAgentPresets(dragged) === false)

  // 5. 恢复出厂
  const resetList: any[] = [{ id: BUILTIN_AGENT_PRESET_IDS.skillDesigner, name: '改坏了', builtin: true }]
  add('恢复出厂：按 id 还原名称', resetBuiltinAgentPreset(resetList, BUILTIN_AGENT_PRESET_IDS.skillDesigner) &&
    resetList[0].name === '技能设计师')
  add('恢复出厂：非内置 id 不动', resetBuiltinAgentPreset(resetList, 'nope') === false)
  add('取出厂定义返回深拷贝', (() => {
    const a: any = builtinPresetDefaultOf(BUILTIN_AGENT_PRESET_IDS.plugin)
    a.name = 'x'
    const b: any = builtinPresetDefaultOf(BUILTIN_AGENT_PRESET_IDS.plugin)
    return b.name === '插件设计师'
  })())

  // 6. 改名迁移（老存档里仍是旧名字）
  const legacyNames: any[] = [
    { id: BUILTIN_AGENT_PRESET_IDS.plugin, name: '插件开发智能体', builtin: true, systemPrompt: '你是「插件开发智能体」，负责写插件。' },
    { id: BUILTIN_AGENT_PRESET_IDS.designer, name: '预设设计师', builtin: true, systemPrompt: '你是「预设设计师」。', loopSections: [{ id: 'p', title: '人格', text: '你是「预设设计师」。' }] },
    { id: 'mine', name: '插件开发智能体', systemPrompt: '用户自建，不该被动' },
  ]
  const renamed = refreshBuiltinAgentPresets(legacyNames)
  add('改名迁移：内置插件预设改成「插件设计师」',
    renamed && legacyNames[0].name === '插件设计师' && legacyNames[0].systemPrompt.includes('「插件设计师」'), legacyNames[0].systemPrompt)
  add('改名迁移：内置智能体预设（含指令段）一起改',
    legacyNames[1].name === '智能体设计师' &&
    legacyNames[1].systemPrompt.includes('「智能体设计师」') &&
    legacyNames[1].loopSections[0].text.includes('「智能体设计师」'))
  add('改名迁移：不碰用户自建预设', legacyNames[2].name === '插件开发智能体')

  const userRenamed: any[] = [{ id: BUILTIN_AGENT_PRESET_IDS.plugin, name: '我的插件设计师', builtin: true, systemPrompt: '你是「插件开发智能体」。' }]
  refreshBuiltinAgentPresets(userRenamed)
  add('改名迁移：用户改过的内置名不覆盖（提示词仍会订正自称）',
    userRenamed[0].name === '我的插件设计师' && userRenamed[0].systemPrompt.includes('「插件设计师」'))

  // 6.5 智能体设计师：补「直写文件」兜底能力（老存档只有 mcp_call）
  const designerOld: any[] = [{
    id: BUILTIN_AGENT_PRESET_IDS.designer,
    name: '智能体设计师',
    builtin: true,
    systemPrompt: '你是「智能体设计师」。\n你不直接改任何文件：读、校验、写全部经内置 MCP 服务 `builtin-agent-preset`，用 mcp_call 调。',
    capabilities: {
      readFiles: false, writeFiles: false, listDirs: false,
      mcpAccess: true, mcpServerIds: ['builtin-agent-preset'],
      enabledTools: ['ask_user', 'update_plan', 'exit_plan_mode', 'update_todo', 'mcp_call'],
    },
  }]
  const designerMigrated = refreshBuiltinAgentPresets(designerOld)
  const dCaps = designerOld[0].capabilities
  add('智能体设计师：补上文件工具', designerMigrated &&
    ['read_file', 'write_file', 'replace_in_file', 'multi_replace', 'list_dir', 'search_files']
      .every((t) => dCaps.enabledTools.includes(t)), dCaps.enabledTools.join(','))
  add('智能体设计师：能力槽布尔同步', dCaps.readFiles === true && dCaps.writeFiles === true && dCaps.listDirs === true)
  add('智能体设计师：提示词改成「只写文件」', designerOld[0].systemPrompt.includes('write_file') &&
    designerOld[0].systemPrompt.includes('preset_reload') &&
    !designerOld[0].systemPrompt.includes('preset_write') &&
    !designerOld[0].systemPrompt.includes('preset_validate'))
  add('智能体设计师迁移是幂等的', refreshBuiltinAgentPresets(designerOld) === false)

  return cases
}
