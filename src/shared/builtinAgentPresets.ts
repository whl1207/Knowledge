/**
 * builtinAgentPresets.ts — 出厂自带的 Agent 预设（内置项）
 *
 * 除「通用智能体」（未绑定预设时的默认自主入口，见 AgentPreset.vue 的 __general__ 虚拟项）外，
 * 软件还内置「代码智能体」「办公智能体」两个可直接选用的预设：
 *   - 它们是**真实进入 store.agentPresets 的普通预设**（可在聊天 / 工作流节点 / 集群 / 批量 /
 *     网页端访客清单中选到），可自由编辑；只有一点特殊：**不可删除**（列表/右键菜单隐藏删除，
 *     与内置 MCP 服务同策略）。
 *   - 注入是**幂等**的（按 id 判重，只补不缺，绝不覆盖用户改过的内容），
 *     入口：store.loadConfig()、useAgentPresets.scanAgentPresets()、设置页 AgentPreset.vue onMounted。
 *
 * 新增 / 修改内置预设只需改本文件（唯一数据源）。
 */

/** 内置预设的固定 id（不随语言 / 版本变化；持久化与判重都以此为准） */
export const BUILTIN_AGENT_PRESET_IDS = {
  code: 'builtin-code-agent',
  office: 'builtin-office-agent',
} as const

/** 内置预设的 id 集合（判定「是否内置项」） */
export const BUILTIN_AGENT_PRESET_ID_SET: Set<string> = new Set(Object.values(BUILTIN_AGENT_PRESET_IDS))

/** 是否内置预设（按 id 判定；导入/复制出来的副本不会被误判） */
export const isBuiltinAgentPreset = (preset: any): boolean =>
  !!preset && typeof preset.id === 'string' && BUILTIN_AGENT_PRESET_ID_SET.has(preset.id)

/**
 * 内置预设定义（与 store.agentPresets 项结构一致）。
 *
 * 能力同时写 `enabledTools`（逐工具模式的权威数据）与各能力槽布尔（供旧逻辑 / 图标 / 提示词门控读取），
 * 两者必须保持一致（见 src/lib/agent/capabilities.ts）。
 */
export const BUILTIN_AGENT_PRESETS: ReadonlyArray<Record<string, any>> = [
  {
    id: BUILTIN_AGENT_PRESET_IDS.code,
    name: '代码智能体',
    builtin: true,
    tags: ['代码', '编程', 'code'],
    // 内置预设不绑定具体来源 / 模型：运行时跟随聊天右上角的当前来源与模型（预设字段仅作回退）
    llmType: '',
    model: '',
    temperature: 0.3,
    kbTopK: 3,
    systemPrompt: [
      '你是「代码智能体」，一名专业的软件开发助手，可直接读写用户工作区中的文件、执行命令与代码。',
      '',
      '工作方式：',
      '1. 先探查再动手：用 list_dir / search_files / read_file 了解项目结构与现有实现，不要凭猜测改代码。',
      '2. 改动最小化、精确化：优先用 replace_in_file / multi_replace 做局部修改，保持原有代码风格；新建文件才用 write_file，非必要不整体重写文件。',
      '3. 多步任务先用 update_plan 列出简短计划（每步一句话），执行过程中逐步更新；用 update_todo 维护任务清单。',
      '4. 改动后尽量验证：用 run_python 或 shell 运行测试 / 构建（如 npm run build、npx tsc --noEmit），发现报错继续修，不要交付未经验证的结论。',
      '5. 不猜测、不编造：不确定的 API、路径、依赖先读文件或搜索确认；关键信息缺失时用 ask_user 询问用户。',
      '6. 汇报时说明改了哪些文件（文件路径用行内代码）、为什么这样改、如何验证，保持简洁。',
      '7. 使用与用户相同的语言回答（用户说中文就用中文）。',
    ].join('\n'),
    // 默认不勾选技能（本机技能路径因机器而异）；可在预设页「技能」中一键全选，与通用智能体一致
    selectedSkills: [],
    capabilities: {
      readFiles: true,
      writeFiles: true,
      listDirs: true,
      executeCode: true,
      runShell: true,
      webSearch: true,
      browseWebsites: true,
      runSubagent: true,
      skills: true,
      accessKnowledgeBase: false,
      mcpAccess: false,
      mcpServerIds: [],
      mcpEquipmentIds: [],
      askUser: true,
      updatePlan: true,
      updateTodo: true,
      knowledgeBaseFiles: [],
      enabledTools: [
        'ask_user', 'update_plan', 'update_todo',
        'read_file', 'search_files', 'list_dir',
        'write_file', 'replace_in_file', 'multi_replace',
        'run_python', 'shell',
        'web_search', 'web_fetch',
        'run_subagent', 'skill',
      ],
    },
    seedHistory: true,
    loopPromptMode: 'auto',
    loopSections: [],
  },
  {
    id: BUILTIN_AGENT_PRESET_IDS.office,
    name: '办公智能体',
    builtin: true,
    tags: ['办公', '文档', 'office'],
    llmType: '',
    model: '',
    temperature: 0.5,
    kbTopK: 3,
    systemPrompt: [
      '你是「办公智能体」，一名专业的办公与文档处理助手，可读写用户工作区中的文件并调用办公类服务。',
      '',
      '主要职责：',
      '- 起草与润色公文、报告、方案、邮件、会议纪要等书面材料，输出结构清晰、措辞得体的 Markdown。',
      '- 处理表格与数据：用 run_python 读取、清洗、统计 CSV / Excel 数据，必要时产出汇总表。',
      '- 交付正式文档：需要 Word 文件时用 export_word 导出 .docx；读写已有 Office 文档 / 表格 / 演示文稿时优先调用已启用的 Office MCP 服务（mcp_call；注意 open_document / open_workbook 返回的 docId / workbookId 在后续每次调用中都必须原样带上）。',
      '- 需要流程图、示意图时可用 drawio 服务；需要外部资料时用 web_search / web_fetch 查证后引用。',
      '',
      '工作方式：',
      '1. 先明确交付物（文体、篇幅、格式、受众），关键信息不足时用 ask_user 追问，不要自行假设。',
      '2. 多步任务先用 update_plan 列出计划，并用 update_todo 跟踪进度。',
      '3. 修改用户已有文件前先 read_file 读原文，再用 replace_in_file / write_file 改动，保留用户原有的格式与用词习惯。',
      '4. 默认使用规范的中文书面语；用户使其它语言时跟随用户语言。',
    ].join('\n'),
    selectedSkills: [],
    capabilities: {
      readFiles: true,
      writeFiles: true,
      listDirs: true,
      executeCode: true,
      runShell: false,
      webSearch: true,
      browseWebsites: true,
      runSubagent: false,
      skills: true,
      accessKnowledgeBase: false,
      mcpAccess: true,
      // 预绑定软件内置的 Office / drawio 服务（用户可自行调整；服务不存在时仅影响提示词中的服务清单）
      mcpServerIds: ['builtin-office', 'builtin-drawio'],
      mcpEquipmentIds: [],
      askUser: true,
      updatePlan: true,
      updateTodo: true,
      knowledgeBaseFiles: [],
      enabledTools: [
        'ask_user', 'update_plan', 'update_todo',
        'read_file', 'search_files', 'list_dir',
        'write_file', 'replace_in_file',
        'run_python',
        'web_search', 'web_fetch',
        'skill', 'mcp_call', 'export_word',
      ],
    },
    seedHistory: true,
    loopPromptMode: 'auto',
    loopSections: [],
  },
]

/**
 * 取当前全局 LLM 配置作为内置预设的默认来源 / 模型（预设注入时写入，避免预设来源为空；
 * 运行时仍以聊天右上角的当前来源与模型为准，预设字段仅作回退）。
 */
export function builtinPresetDefaultsFromStore(store: any): { llmType: string; model: string } {
  const llm: any = store?.AIconfig?.llm || {}
  const type = String(llm.type || '')
  const model = String((type && llm[type]?.model) || llm.model || '')
  return { llmType: type, model }
}

/**
 * 幂等注入内置预设：只补缺失的 id，绝不覆盖同名 id 的现有项（用户改过的内容保留）。
 * 补齐的项统一插到列表最前（保持 BUILTIN_AGENT_PRESETS 的展示顺序）。
 *
 * @param list 目标列表（通常是 store.agentPresets，就地修改）
 * @param defaults 新插入项的默认来源 / 模型（留空则跟随运行时的全局配置）
 * @returns 是否发生了新增（调用方据此决定是否需要落盘）
 */
export function ensureBuiltinAgentPresets(
  list: any[],
  defaults: { llmType?: string; model?: string } = {},
): boolean {
  if (!Array.isArray(list)) return false
  let changed = false
  // 逆序遍历 + unshift：最终顺序与 BUILTIN_AGENT_PRESETS 一致（代码智能体在前）
  for (let i = BUILTIN_AGENT_PRESETS.length - 1; i >= 0; i--) {
    const seed = BUILTIN_AGENT_PRESETS[i]
    if (list.some((p: any) => p && p.id === seed.id)) continue
    const item: any = JSON.parse(JSON.stringify(seed))
    if (!item.llmType && defaults.llmType) item.llmType = defaults.llmType
    if (!item.model && defaults.model) item.model = defaults.model
    list.unshift(item)
    changed = true
  }
  return changed
}
