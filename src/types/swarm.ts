/**
 * swarm.ts — 集群数据模型
 *
 * 集群成员 = Agent 预设引用（配置在「设置 → 预设」，映射见 `useSwarmMembers`），
 * 成员汇报 = 对话消息（见 `useSwarmChat`）。因此这里只保留运行期真正需要的形状：
 * 成员、能力插槽、执行模式、单成员运行状态。
 */

/**
 * 执行模式（策略注册表键名，见 src/lib/agent/swarmStrategies.ts）：
 * - `auto`：全员响应（`settings.collabMode` 再分「点名 / 接力 / 撮合 / 仅发言」档），可选群主总结；
 * - `debate`：多轮辩论，最后由群主中立总结。
 *
 * 输入框 `@成员名` → 由发送层 `runNamedTask` 拦截（点名执行，不经策略、不总结）。
 */
export type SwarmRunMode = 'auto' | 'debate'

/**
 * Agent 能力插槽（与预设 AgentPresetCapabilities 完全对齐）。
 * askUser/updatePlan/updateTodo 默认开启。
 */
export interface SwarmCapabilities {
  readFiles: boolean          // 读取文件 → read_file / search_files
  listDirs: boolean           // 列出目录 → list_dir
  executeCode: boolean        // 执行代码 → run_python
  webSearch: boolean          // 搜索网页 → web_search
  browseWebsites: boolean     // 浏览网站 → web_fetch
  writeFiles: boolean         // 写入文件 → write_file
  askUser: boolean            // 询问用户 → ask_user
  updatePlan: boolean         // 更新计划 → update_plan
  updateTodo: boolean         // 任务清单 → update_todo
  accessKnowledgeBase: boolean // 访问知识库 → kb_search
  runShell: boolean           // Shell 命令 → shell
  runSubagent: boolean        // 子智能体 → run_subagent
  skills: boolean             // 技能库 → skill（按需加载已安装技能）
  /** MCP 控制 → mcp_call */
  mcpAccess: boolean
  /** 选中的 MCP 服务 id 列表（mcpAccess=true 时生效） */
  mcpServerIds?: string[]
  /** 选中的 MCP 装备 key 列表（`${serverId}:${id}`；mcpAccess=true 时生效） */
  mcpEquipmentIds?: string[]
  /** 选中的知识库/参考文件路径列表（仅 accessKnowledgeBase=true 时生效） */
  knowledgeBaseFiles: string[]
  /** 逐工具启用集（精确到工具名；缺省/undefined = 由能力槽布尔推导） */
  enabledTools?: string[]
}

/** 集群成员（由 Agent 预设映射而来；`presetId` 恒指向来源预设） */
export interface SwarmAgent {
  id: string
  name: string
  role: string
  llmType: string
  model: string
  systemPrompt: string
  temperature: number
  capabilities: SwarmCapabilities
  /** 技能配置：none=不配置 / all=所有技能 / select=选择技能 */
  skillMode: 'none' | 'all' | 'select'
  /** 选中的技能路径（skillMode='select' 时生效；旧数据单选用） */
  selectedSkill: string
  /** 多选技能路径（skillMode='select' 时生效；优先级高于 selectedSkill） */
  selectedSkills?: string[]
  /** 来源预设 id（成员名/模型/能力始终跟随预设） */
  presetId?: string
}

export type SwarmAgentRunStatus = 'pending' | 'retrieving' | 'thinking' | 'tool' | 'done' | 'error'

/** 单个成员的运行状态（进度展示） */
export interface SwarmAgentRunState {
  agentIdx: number
  status: SwarmAgentRunStatus
  /** 辩论/执行轮次 */
  round?: number
  /** 阶段：点名 / 执行 / 总结等 */
  stage?: string
  role?: 'manager' | 'worker'
  /** 附加详情（工具名、等待依赖等） */
  detail?: string
  startTime: number
  /** agentBridge 会话 id */
  agentId?: string
}
