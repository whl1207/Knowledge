// src/components/workFlow/WorkflowTypes.ts
// 工作流模块共享类型定义

// 节点类型枚举
export type NodeType = 'reasoning' | 'decision' | 'local' | 'web' | 'text' | 'webpage' | 'python' | 'knowledge' | 'structured' | 'start' | 'end' | 'mcp' | 'subflow' | 'iteration' | 'aggregator' | 'list' | 'data' | 'agent' | 'word'

// 文件处理模式
export type FileMode = 'full' | 'template'

// 节点执行状态
export type NodeStatus = 'idle' | 'running' | 'success' | 'error'

// ── 端口（Handle）系统 ─────────────────────────────────────────

/** 端口方向 */
export type HandlePosition = 'left' | 'right' | 'top' | 'bottom'

/** 端口类型 */
export type HandleType = 'input' | 'output'

/** 端口定义 */
export interface HandleDef {
  id: string
  label: string
  type: HandleType
  position: HandlePosition
  /** 在该侧的顺序索引（从 0 开始） */
  index: number
}

/** 端口渲染颜色 */
export interface HandleStyle {
  fill: string
  stroke: string
}

/** 获取端口颜色 */
export function getHandleStyle(type: HandleType, nodeType: NodeType): HandleStyle {
  const isOutput = type === 'output'
  const colorMap: Record<NodeType, string> = {
    start: '#4CAF50', end: '#f44336', text: '#FF5722',
    local: '#2196F3', web: '#FF9800', webpage: '#795548',
    reasoning: '#4CAF50', decision: '#E91E63', python: '#3776AB',
    knowledge: '#9C27B0', structured: '#673AB7', mcp: '#00BCD4', subflow: '#FF6F00',
    iteration: '#00897B', aggregator: '#5E35B1', list: '#00838F', data: '#546E7A',
    agent: '#512DA8', word: '#2B579A'
  }
  const base = colorMap[nodeType] || '#757575'
  return {
    fill: isOutput ? base + '55' : 'rgba(150,150,150,0.25)',
    stroke: isOutput ? base : '#999'
  }
}

/** 每个节点类型的默认端口配置 */
export const NODE_HANDLES: Record<NodeType, HandleDef[]> = {
  start: [
    { id: 'output', label: '输出', type: 'output', position: 'right', index: 0 }
  ],
  end: [
    { id: 'input', label: '输入', type: 'input', position: 'left', index: 0 }
  ],
  reasoning: [
    { id: 'input', label: '输入', type: 'input', position: 'left', index: 0 },
    { id: 'output', label: '输出', type: 'output', position: 'right', index: 0 }
  ],
  decision: [
    { id: 'input', label: '输入', type: 'input', position: 'left', index: 0 }
    // 分支端口在运行时动态生成
  ],
  text: [
    { id: 'input', label: '输入', type: 'input', position: 'left', index: 0 },
    { id: 'output', label: '输出', type: 'output', position: 'right', index: 0 }
  ],
  local: [
    { id: 'input', label: '输入', type: 'input', position: 'left', index: 0 },
    { id: 'output', label: '完整文件', type: 'output', position: 'right', index: 0 }
    // 模板模式下端口在运行时动态生成
  ],
  web: [
    { id: 'input', label: '搜索词', type: 'input', position: 'left', index: 0 },
    { id: 'output', label: '搜索结果', type: 'output', position: 'right', index: 0 }
  ],
  webpage: [
    { id: 'input', label: 'URL', type: 'input', position: 'left', index: 0 },
    { id: 'output', label: '页面内容', type: 'output', position: 'right', index: 0 }
  ],
  knowledge: [
    { id: 'input', label: '查询', type: 'input', position: 'left', index: 0 },
    { id: 'output', label: '检索结果', type: 'output', position: 'right', index: 0 }
  ],
  structured: [
    { id: 'output', label: '结构化数据', type: 'output', position: 'right', index: 0 }
  ],
  python: [
    { id: 'input', label: '输入', type: 'input', position: 'left', index: 0 },
    { id: 'output', label: '执行结果', type: 'output', position: 'right', index: 0 }
  ],
  mcp: [
    { id: 'input', label: '输入', type: 'input', position: 'left', index: 0 },
    { id: 'output', label: '工具结果', type: 'output', position: 'right', index: 0 }
  ],
  subflow: [
    { id: 'input', label: '输入', type: 'input', position: 'left', index: 0 },
    { id: 'output', label: '子工作流输出', type: 'output', position: 'right', index: 0 }
  ],
  iteration: [
    { id: 'input', label: '输入', type: 'input', position: 'left', index: 0 },
    { id: 'output', label: '聚合输出', type: 'output', position: 'right', index: 0 }
  ],
  aggregator: [
    { id: 'input', label: '输入', type: 'input', position: 'left', index: 0 },
    { id: 'output', label: '聚合结果', type: 'output', position: 'right', index: 0 }
  ],
  list: [
    { id: 'input', label: '输入列表', type: 'input', position: 'left', index: 0 },
    { id: 'output', label: '处理结果', type: 'output', position: 'right', index: 0 }
  ],
  data: [
    { id: 'output', label: '数据输出', type: 'output', position: 'right', index: 0 }
  ],
  agent: [
    { id: 'input', label: '输入', type: 'input', position: 'left', index: 0 },
    { id: 'output', label: '智能体输出', type: 'output', position: 'right', index: 0 }
  ],
  word: [
    { id: 'input', label: '输入', type: 'input', position: 'left', index: 0 },
    { id: 'output', label: '导出结果', type: 'output', position: 'right', index: 0 }
  ]
}

/** 获取节点动态端口（含决策分支、文件模板端口） */
export function getDynamicHandles(node: NodeData): HandleDef[] {
  const base = NODE_HANDLES[node.type]?.filter(h => h.id !== 'output' && h.id !== 'input') || []
  if (node.type === 'decision' && node.decisionBranches) {
    node.decisionBranches.forEach((b, i) => {
      base.push({ id: `branch_${b.id}`, label: b.name, type: 'output', position: 'right', index: i + 1 })
    })
  }
  if (node.type === 'local' && node.fileMode === 'template' && node.fileTemplates) {
    node.fileTemplates.forEach((t, i) => {
      base.push({ id: `port_${t.outputName}`, label: t.name, type: 'output', position: 'right', index: i + 1 })
    })
  }
  return base
}

/** 获取节点所有输入端口 */
export function getInputHandles(node: NodeData): HandleDef[] {
  const base = NODE_HANDLES[node.type]?.filter(h => h.type === 'input') || []
  const dynamic = getDynamicHandles(node).filter(h => h.type === 'input')
  return [...base, ...dynamic]
}

/** 获取节点所有输出端口 */
export function getOutputHandles(node: NodeData): HandleDef[] {
  const base = NODE_HANDLES[node.type]?.filter(h => h.type === 'output') || []
  const dynamic = getDynamicHandles(node).filter(h => h.type === 'output')
  return [...base, ...dynamic]
}

// ── 节点尺寸约束 ────────────────────────────────────────────

/** 节点头部标题栏高度（端口位置计算时扣除，端口不占用标题区域） */
export const TITLE_HEIGHT = 22
/** 端口最小间距（每个端口槽位至少需要的高度） */
export const PORT_SPACING_MIN = 24
/** 节点底部额外留白 */
export const BOTTOM_PADDING = 10

/**
 * 根据端口数计算节点最小高度
 * 端口均匀分布在标题栏下方的可用区域内
 */
export function computeMinNodeHeight(node: NodeData): number {
  const inputCount = getInputHandles(node).length
  const outputCount = getOutputHandles(node).length
  const maxPorts = Math.max(inputCount, outputCount)
  if (maxPorts <= 0) {
    return TITLE_HEIGHT + PORT_SPACING_MIN + BOTTOM_PADDING
  }
  // 端口分布在标题下方，(maxPorts+1) 个等分槽位
  return TITLE_HEIGHT + PORT_SPACING_MIN * (maxPorts + 1) + BOTTOM_PADDING
}

/** 确保节点高度 ≥ 端口数要求的最小高度 */
export function ensureMinNodeHeight(node: NodeData, shrink = false): void {
  const minH = computeMinNodeHeight(node)
  if (shrink) {
    node.height = minH      // 删除端口后缩小
  } else if (!node.height || node.height < minH) {
    node.height = minH      // 仅增大
  }
}

// Subflow 子工作流节点额外字段（用于 NodeData）
export interface SubflowConfig {
  subflowPath?: string       // .flow 文件路径
  subflowName?: string       // 子工作流名称
  subflowItems?: NodeData[]  // 子工作流节点缓存（用于预览）
  subflowLinks?: Link[]      // 子工作流连线缓存
}

// MCP 配置
export interface McpConfig {
  // 模式：inline=节点内联配置（自定义 MCP 工具），server=引用设置中配置的 MCP 服务
  mode?: 'inline' | 'server'
  // 引用设置服务时的 serverId（store.mcpServers 中的 id）
  serverId?: string
  transport: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string | string[]
  env?: Record<string, string> | string
  serverUrl?: string
  selectedTool?: string
  toolArguments?: Record<string, any>
  autoConnect?: boolean
  tools?: Array<{
    name: string
    description: string
    inputSchema: any
  }>
}

// 文件模板配置
export interface FileTemplate {
  name: string
  pattern: string
  outputName: string
}

// 决策分支
export interface DecisionBranch {
  id: string
  name: string
  description: string
  condition?: string
  dataTemplate?: string
}

// 决策配置
export interface DecisionConfig {
  mode: 'llm' | 'rule'
  prompt?: string
  rules?: string
  branches: DecisionBranch[]
  selectedBranch?: string
}

// 结构化列
export interface StructuredColumn {
  id: number
  name: string
  type: 'text' | 'number' | 'boolean' | 'date'
  required: boolean
}

// 结构化行
export interface StructuredRow {
  id: number
  columns: Record<string, string>
}

// 结构化配置
export interface StructuredConfig {
  outputFormat: 'json' | 'markdown' | 'text' | 'csv'
  includeHeaders: boolean
  tableDescription: string
}

// 知识库选项
export interface KbOptions {
  topK?: number
  summaryWeight?: number
  embedModel?: string
  debug?: boolean
  missingModelStrategy?: 'error' | 'fallback'
  fallbackModels?: string[]
}

// 知识库验证
export interface KbValidation {
  valid: boolean
  issues: string[]
  availableModel?: string
  config?: any
}

// 输出端口
export interface OutputPort {
  id: string
  name: string
  description?: string
  enabled: boolean
  data?: any
}

export interface OutputPorts {
  default: boolean
  ports: OutputPort[]
}

export interface WebpageOptions {
  visitMode?: 'single' | 'followLinks' | 'pattern'
  includeLinks?: boolean
  followLinks?: boolean
  maxPages?: number
  sameDomainOnly?: boolean
  mainContentStrategy?: 'simple' | 'textDensity' | 'readability'
  patternTemplate?: string
  patternStart?: number
  patternEnd?: number
  patternStep?: number
}

// 网络搜索选项（复用统一 web_search 工具，无需 API Key）
export interface WebSearchOptions {
  searchApi?: 'web_search'
}

// 迭代错误处理模式（对齐 Dify error_handle_mode）
// terminated 出错终止；continue_with_error 跳过继续；remove_abnormal_output 跳过并剔除异常输出；
// continue_with_error_inject 出错不中断——把错误注入该步骤输出，继续执行后续节点（供大模型总结）
export type IterationErrorMode = 'terminated' | 'continue_with_error' | 'continue_with_error_inject' | 'remove_abnormal_output'

/** 迭代内部流水线节点（迷你节点） */
export interface IterationInnerNode {
  id: number
  type: NodeType
  name: string
  prompt?: string
  model_type?: string
  model?: string
}

// 迭代节点配置
// inputArray: 数组来源，支持 {{节点.字段}} 模板 或 JSON 数组；innerItems 为内部线性流水线
export interface IterationConfig {
  inputArray?: string
  innerItems?: IterationInnerNode[]
  /** 收集哪个内部节点的输出（默认内部最后一个节点） */
  outputNodeId?: number
  /** 收集的字段（默认 result） */
  outputKey?: string
  concurrency?: number
  errorMode?: IterationErrorMode
  maxIterations?: number
  /** 输出形态：value=仅收集值（默认）；row=把原行字段与结果合并为对象 { ...行字段, index, result } */
  outputMode?: 'value' | 'row'
}

// 列表操作步骤
export type ListOpStep =
  | { op: 'filter'; field?: string; operator: 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'is_empty' | 'is_not_empty' | 'exists'; value?: string }
  | { op: 'extract'; fields: string[] }
  | { op: 'sort'; field: string; order: 'asc' | 'desc' }
  | { op: 'limit'; n: number }
  | { op: 'unique'; field?: string }
  | { op: 'slice'; start: number; end: number }

// 列表操作节点配置
export interface ListOpConfig {
  inputList?: string
  operations?: ListOpStep[]
}

// 数据(CSV)节点加载模式：
// - auto    自动：设置了 maxRows/batchSize 则全量收集（受 maxRows 限制），否则仅统计+预览
// - stats   仅统计：返回 total + headers，不保留数据行
// - preview 统计 + 前 previewRows 行预览
// - full    全量收集（受 maxRows 限制），batchSize>0 时额外输出 batches
export type DataLoadMode = 'auto' | 'stats' | 'preview' | 'full'

// 数据(CSV)节点配置
export interface DataConfig {
  filePath?: string
  delimiter?: string
  hasHeader?: boolean
  maxRows?: number
  batchSize?: number
  loadMode?: DataLoadMode
  previewRows?: number
}

// 变量聚合节点配置
export interface AggregatorConfig {
  mode?: 'collect' | 'merge'
  inputVar?: string
}

// 智能体节点配置（选择通用/预设智能体，仅需任务提示词）
export interface AgentConfig {
  /** 预设智能体 id（store.agentPresets）；空 = 通用智能体 */
  presetId?: string
  /** 任务提示词模板（与上游节点共同构造任务），支持 {{节点.字段}} */
  prompt?: string
  /** 超时（毫秒），默认 600000 */
  timeoutMs?: number
  /**
   * 历史字段（保留兼容旧存档）：循环轮数已统一由「智能体预设」管理，Agent 节点不再读此值。
   * 预设节点 → preset.maxSteps；通用节点 → store.generalAgentMaxSteps。
   */
  maxSteps?: number
}

// Word 导出节点配置（复用 markdown → .docx 统一导出管线）
export interface WordExportConfig {
  /** 内容（Markdown）模板，支持 {{节点.字段}}；为空则取上游节点上下文 */
  content?: string
  /** 导出模板 key：'' = 跟随设置页；gongwen/cn/en/custom */
  template?: string
  /** 自定义模板的样式 .docx 路径（template='custom' 时生效；为空则用设置页所选） */
  stylePath?: string
  /** 保存目录（绝对路径，支持 {{}} 模板）；为空则落系统下载目录 */
  dirPath?: string
  /** 文件名（不含扩展名，支持 {{}} 模板）；为空则用节点名 */
  fileName?: string
  /** 是否覆盖同名文件（默认 false：重名自动加 (1)） */
  overwrite?: boolean
}

// 开始节点端口配置（简化：仅需一个提示词端口）
export interface StartPorts {
  prompt: boolean
}

// 节点数据
export interface NodeData {
  id: number
  name: string
  type: NodeType
  model_type: string
  /** 绑定的自定义来源索引（model_type='custom' 时生效；缺省用设置页当前激活来源） */
  customSourceIndex?: number
  model: string
  prompt: string
  result: string
  x: number
  y: number
  width: number
  height: number
  status: NodeStatus
  // 开始节点
  startPorts?: StartPorts
  // 推理节点
  reasoningConfig?: any
  // 决策节点
  decisionMode?: 'llm' | 'rule'
  decisionPrompt?: string
  decisionRules?: string
  decisionConfig?: DecisionConfig
  decisionBranches?: DecisionBranch[]
  // 本地文件节点
  fileMode?: FileMode
  fileTemplates?: FileTemplate[]
  outputPorts?: OutputPorts
  /** 切换至完整文件模式时隐藏的模板端口连线（切换回模板模式时恢复） */
  hiddenLinks?: Link[]
  // 知识库节点
  kbPath?: string
  kbQuery?: string
  kbOptions?: KbOptions
  kbValidation?: KbValidation
  // 结构化节点
  structuredData?: StructuredRow[]
  structuredColumns?: StructuredColumn[]
  structuredConfig?: StructuredConfig
  // MCP 节点
  mcpConfig?: McpConfig
  mcpConnected?: boolean
  mcpTools?: any[]
  // 网页节点
  webpageOptions?: WebpageOptions
  // 网络搜索节点
  webSearchOptions?: WebSearchOptions
  // 子工作流节点
  subflowPath?: string
  subflowName?: string
  // 迭代节点
  iterationConfig?: IterationConfig
  // 列表操作节点
  listOpConfig?: ListOpConfig
  // 数据(CSV)节点
  dataConfig?: DataConfig
  // 变量聚合节点
  aggregatorConfig?: AggregatorConfig
  // 智能体节点
  agentConfig?: AgentConfig
  // Word 导出节点
  wordConfig?: WordExportConfig
  /** 迭代节点断点续跑缓存（内部字段，随 .flow 持久化；中断时保存，续跑时读取后清除） */
  _iterResume?: IterationResumeState
}

/** 迭代节点断点续跑状态：记录已完成的项，便于中断后「继续执行」 */
export interface IterationResumeState {
  total: number
  done: Array<{ index: number; value: any }>
  failed: Array<{ index: number; error: string }>
  errorMode?: string
  outputNodeId?: number
  outputKey?: string
}

// 连接线
export interface Link {
  source: number
  target: number
  sourcePort?: string
  targetPort?: string
  branch?: string
}

// 工作流数据
export interface WorkflowData {
  items: NodeData[]
  links: Link[]
}

// 视图变换
export interface ViewTransform {
  x: number
  y: number
  k: number
}

// 节点模板
export interface NodeTemplate {
  name: string
  type: NodeType
  model_type: string
  model: string
  prompt: string
  result: string
  width: number
  height: number
  status: NodeStatus
  fileMode?: FileMode
  fileTemplates?: FileTemplate[]
  webpageOptions?: WebpageOptions
  webSearchOptions?: WebSearchOptions
  iterationConfig?: IterationConfig
  listOpConfig?: ListOpConfig
  dataConfig?: DataConfig
  aggregatorConfig?: AggregatorConfig
  agentConfig?: AgentConfig
  wordConfig?: WordExportConfig
}

// 执行回调
export interface ExecutionCallback {
  onNodeStart?: (nodeId: number, nodeName: string, nodeType: NodeType) => void
  onNodeComplete?: (nodeId: number, nodeName: string, nodeType: NodeType, status: NodeStatus, result: any) => void
  onPythonError?: (nodeId: number, nodeName: string, error: string, traceback?: string) => void
  onDecisionBranchSelected?: (nodeId: number, nodeName: string, branchId: string, branchName: string, reason?: string) => void
  onMcpStatusChange?: (nodeId: number, connected: boolean, tools?: any[]) => void
  onProgress?: (completed: number, total: number, currentNode?: string) => void
  onComplete?: (success: boolean, finalResult: string, aggregatedResults?: Record<string, any>) => void
  onLog?: (message: string, level: 'info' | 'warning' | 'error') => void
  onNodeStatusUpdate?: (nodeId: number, status: NodeStatus, result?: string) => void
  onSaveWorkflow?: () => void
  t?: (key: string) => string
}

// 连接模式
export type OperationMode = 'normal' | 'linking'

// 连接点位置
export type ConnectorPosition = 'top' | 'bottom' | 'left' | 'right' | string

// 位置
export interface Position {
  x: number
  y: number
}

// 本地化字典
export interface LocaleDict {
  [key: string]: {
    [key: string]: string
  }
}
