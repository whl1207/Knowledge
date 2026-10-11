/**
 * Dify DSL 类型定义（对齐 langgenius/dify 的 App DSL，当前版本 0.7.0）
 *
 * 本文件是工作流的唯一数据模型：画布、引擎、属性面板、文件读写都直接使用这里的结构，
 * 不再有额外的中间层。字段名与 Dify 导出的 YAML 完全一致。
 */

/** 当前支持导入/导出的 Dify DSL 版本（api/constants/dsl_version.py） */
export const SUPPORTED_DSL_VERSION = '0.7.0'

/** 无 version 字段的历史文件按此版本处理（对齐 Dify 的默认值） */
export const LEGACY_DSL_VERSION = '0.1.0'

/** DSL 内容大小上限，与 Dify 的 DSL_MAX_SIZE 一致 */
export const DSL_MAX_SIZE = 10 * 1024 * 1024

// ── 变量类型 ────────────────────────────────────────────────

/** 变量值类型（Dify VarType 的子集 + array 组合） */
export type VarType =
  | 'string'
  | 'number'
  | 'integer'
  | 'float'
  | 'boolean'
  | 'object'
  | 'secret'
  | 'file'
  | 'llm'
  | 'any'
  | `array[${string}]`

/** 变量引用选择器：[节点 id, 变量名]，或 ['sys'|'env'|'conversation'|'rag', 名字] */
export type ValueSelector = string[]

/** 系统变量命名空间（api/core/workflow/variable_prefixes.py） */
export const SYSTEM_VARIABLE_NODE_ID = 'sys'
export const ENVIRONMENT_VARIABLE_NODE_ID = 'env'
export const CONVERSATION_VARIABLE_NODE_ID = 'conversation'
export const RAG_PIPELINE_VARIABLE_NODE_ID = 'rag'

// ── 节点类型 ────────────────────────────────────────────────

/** Dify 内置节点类型（BlockEnum 的值，含容器入口节点） */
export type DifyBuiltinNodeType =
  | 'start'
  | 'start-placeholder'
  | 'end'
  | 'answer'
  | 'llm'
  | 'knowledge-retrieval'
  | 'question-classifier'
  | 'if-else'
  | 'code'
  | 'template-transform'
  | 'http-request'
  | 'tool'
  | 'variable-aggregator'
  | 'variable-assigner'
  | 'assigner'
  | 'parameter-extractor'
  | 'iteration'
  | 'iteration-start'
  | 'loop'
  | 'loop-start'
  | 'loop-end'
  | 'document-extractor'
  | 'list-operator'
  | 'agent'
  | 'agent-v2'
  | 'human-input'
  | 'datasource'
  | 'datasource-empty'
  | 'knowledge-index'
  | 'trigger-schedule'
  | 'trigger-webhook'
  | 'trigger-plugin'

/**
 * 本地私有节点类型：身份私有，但完全遵守 Dify 的节点契约
 * （ReactFlow 外形 + value_selector 输入 + 显式输出声明 + error_strategy）。
 * 导出到 Dify 时按导出模式被剥离或降级。
 */
export type PrivateNodeType =
  | 'ai-km-word'
  | 'ai-km-csv'
  | 'ai-km-file'
  | 'ai-km-knowledge'
  | 'ai-km-mcp'
  | 'ai-km-subflow'

export type DslNodeType = DifyBuiltinNodeType | PrivateNodeType

/**
 * 运行时可能出现的任意节点类型字符串（Dify 未来新增 / 第三方节点）。
 * 遇到不认识的值一律**原样保留** `data.type`，只标注「未实现」，
 * 绝不改写成占位类型——这样再导出时可以逐字节还原。
 */
export type AnyNodeType = DslNodeType | (string & {})

/** 运行时类型清单：与上面的联合类型保持同步 */
export const DIFY_BUILTIN_NODE_TYPES = [
  'start',
  'start-placeholder',
  'end',
  'answer',
  'llm',
  'knowledge-retrieval',
  'question-classifier',
  'if-else',
  'code',
  'template-transform',
  'http-request',
  'tool',
  'variable-aggregator',
  'variable-assigner',
  'assigner',
  'parameter-extractor',
  'iteration',
  'iteration-start',
  'loop',
  'loop-start',
  'loop-end',
  'document-extractor',
  'list-operator',
  'agent',
  'agent-v2',
  'human-input',
  'datasource',
  'datasource-empty',
  'knowledge-index',
  'trigger-schedule',
  'trigger-webhook',
  'trigger-plugin',
] as const satisfies readonly DifyBuiltinNodeType[]

export const PRIVATE_NODE_TYPES = [
  'ai-km-word',
  'ai-km-csv',
  'ai-km-file',
  'ai-km-knowledge',
  'ai-km-mcp',
  'ai-km-subflow',
] as const satisfies readonly PrivateNodeType[]

/** 类型是否可识别（Dify 内置或本地私有）；不认识的原样保留并标注 */
export function isKnownNodeType(type: string): type is DslNodeType {
  return (DIFY_BUILTIN_NODE_TYPES as readonly string[]).includes(type)
    || (PRIVATE_NODE_TYPES as readonly string[]).includes(type)
}

/** 私有节点类型前缀 */
export const PRIVATE_NODE_PREFIX = 'ai-km-'

/** 是否为本地私有节点 */
export function isPrivateNodeType(type: string): type is PrivateNodeType {
  return type.startsWith(PRIVATE_NODE_PREFIX)
}

/** ReactFlow 节点外壳的 type 值；容器入口节点另有两种 */
export type NodeWrapperType = 'custom' | 'custom-iteration-start' | 'custom-loop-start'

// ── 错误处理 / 重试（对齐 Dify BaseNodeData） ─────────────────

/** 节点错误策略（对齐 Dify：无 / 继续执行 / 移出异常输出 / 异常分支 / 默认值） */
export type ErrorStrategy = 'terminated' | 'continue-on-error' | 'remove-abnormal-output' | 'fail-branch' | 'default-value'

export interface RetryConfig {
  enabled?: boolean
  max_retries?: number
  retry_interval?: number
  exponential_backoff?: {
    enabled?: boolean
    multiplier?: number
    max_interval?: number
  }
}

// ── 节点 data ───────────────────────────────────────────────

/** 所有节点 data 的公共字段（对齐 BaseNodeData） */
export interface BaseNodeData {
  type: AnyNodeType
  title: string
  desc?: string
  /** 节点自身 schema 版本，Dify 用字符串（如 '1'、'2'） */
  version?: string
  error_strategy?: ErrorStrategy
  retry_config?: RetryConfig
  /**
   * 「默认值」错误策略的兜底输出：输出变量名 → 值（对齐 Dify 的 default_value）。
   * 节点失败时把这里的值写进变量池并继续往下跑，下游照常拿到数据。
   */
  default_value?: Record<string, unknown>
  /** 容器归属（子节点同时带 wrapper 级 parentId 与这里的 isInIteration/isInLoop） */
  isInIteration?: boolean
  iteration_id?: string | null
  isInLoop?: boolean
  loop_id?: string | null
  /** 本地私有扩展：非执行必需信息（UI 状态、来源标记、运行态缓存），导出 Dify 时剥离 */
  'x-ai-km'?: PrivateNodeExtras
  /** 各节点私有字段；实现到具体节点时再收窄 */
  [key: string]: unknown
}

/** 节点上的本地私有扩展（不参与 Dify 语义） */
export interface PrivateNodeExtras {
  /** 节点来源：本地新建 / 从 Dify 导入 / 无法识别的类型 */
  origin?: 'native' | 'dify' | 'unknown'
  /** 上次运行状态与结果（不落 Dify） */
  status?: 'idle' | 'running' | 'success' | 'error'
  result?: string
  /** 迭代/循环断点续跑状态 */
  resume?: Record<string, unknown>
  [key: string]: unknown
}

/** 开始节点变量定义 */
export interface StartVariable {
  variable: string
  label: string
  /** text-input | paragraph | select | number | url | files | json | json_object | contexts | file | file-list | checkbox | iterator | loop */
  type: string
  required?: boolean
  max_length?: number | null
  options?: string[]
  hint?: string
  default?: unknown
  placeholder?: string
  unit?: string
  value_selector?: ValueSelector
  json_schema?: unknown
}

export interface StartNodeData extends BaseNodeData {
  type: 'start'
  variables: StartVariable[]
}

export interface EndOutput {
  variable: string
  value_selector: ValueSelector
  value_type?: VarType
}

export interface EndNodeData extends BaseNodeData {
  type: 'end'
  outputs: EndOutput[]
}

export interface AnswerNodeData extends BaseNodeData {
  type: 'answer'
  answer: string
  variables?: Array<{ variable: string; value_selector: ValueSelector; value_type?: VarType }>
}

/** LLM 提示词消息（role 决定消息角色） */
export interface PromptMessage {
  id?: string
  role: 'system' | 'user' | 'assistant'
  text: string
  edition_type?: string
  jinja2_text?: string
}

export interface ModelConfig {
  provider: string
  name: string
  mode?: string
  completion_params?: Record<string, unknown>
}

export interface LlmNodeData extends BaseNodeData {
  type: 'llm'
  model: Partial<ModelConfig>
  prompt_template: PromptMessage[]
  context?: { enabled?: boolean; variable_selector?: ValueSelector }
  vision?: { enabled?: boolean; configs?: unknown }
  memory?: {
    query_prompt_template?: string
    window?: { enabled?: boolean; size?: number }
    role_prefix?: unknown
  }
  structured_output?: { enabled?: boolean; schema?: unknown }
  model_selector?: ValueSelector
}

// ── 私有节点 data（字段名尽量对齐 Dify 同类节点） ─────────────

export interface WordNodeData extends BaseNodeData {
  type: 'ai-km-word'
  content_variable_selector?: ValueSelector
  content?: string
  template?: string
  style_path?: string
  dir_path?: string
  file_name?: string
  overwrite?: boolean
}

export type CsvLoadMode = 'auto' | 'stats' | 'preview' | 'full'

export interface CsvNodeData extends BaseNodeData {
  type: 'ai-km-csv'
  file_path: string
  delimiter?: string
  has_header?: boolean
  max_rows?: number
  batch_size?: number
  load_mode?: CsvLoadMode
  preview_rows?: number
}

export interface FileTemplate {
  name: string
  pattern: string
  output_name: string
}

export interface LocalFileNodeData extends BaseNodeData {
  type: 'ai-km-file'
  file_path: string
  file_mode: 'full' | 'template'
  file_templates?: FileTemplate[]
}

export interface LocalKnowledgeNodeData extends BaseNodeData {
  type: 'ai-km-knowledge'
  kb_path: string
  query_variable_selector?: ValueSelector
  query?: string
  retrieval_mode?: 'single' | 'multiple'
  multiple_retrieval_config?: {
    top_k?: number
    score_threshold?: number
    summary_weight?: number
    reranking_enable?: boolean
  }
  embed_model?: string
  missing_model_strategy?: 'error' | 'fallback'
  fallback_models?: string[]
}

export interface McpNodeData extends BaseNodeData {
  type: 'ai-km-mcp'
  provider_id: string
  provider_name?: string
  provider_type: 'mcp'
  tool_name: string
  tool_label?: string
  tool_parameters?: Record<string, unknown>
  mcp_server: {
    mode?: 'inline' | 'server'
    server_id?: string
    transport: 'stdio' | 'sse' | 'http'
    command?: string
    args?: string | string[]
    env?: Record<string, string> | string
    server_url?: string
  }
}

export interface SubflowNodeData extends BaseNodeData {
  type: 'ai-km-subflow'
  subflow_path: string
  subflow_name?: string
  variables?: Array<{ variable: string; value_selector: ValueSelector; value_type?: VarType }>
}

export type KnownNodeData =
  | StartNodeData
  | EndNodeData
  | AnswerNodeData
  | LlmNodeData
  | WordNodeData
  | CsvNodeData
  | LocalFileNodeData
  | LocalKnowledgeNodeData
  | McpNodeData
  | SubflowNodeData

// ── 节点 / 边 / 图 ──────────────────────────────────────────

export interface XYPosition {
  x: number
  y: number
}

export interface DslNode<T extends BaseNodeData = BaseNodeData> {
  type: NodeWrapperType
  id: string
  position: XYPosition
  positionAbsolute?: XYPosition
  width?: number
  height?: number
  sourcePosition?: 'left' | 'right' | 'top' | 'bottom'
  targetPosition?: 'left' | 'right' | 'top' | 'bottom'
  selected?: boolean
  zIndex?: number
  /** 容器子节点：指向 iteration/loop 容器的 id */
  parentId?: string
  draggable?: boolean
  selectable?: boolean
  data: T
}

export interface DslEdgeData {
  sourceType: string
  targetType: string
  isInIteration?: boolean
  iteration_id?: string | null
  isInLoop?: boolean
  loop_id?: string | null
}

export interface DslEdge {
  id: string
  source: string
  target: string
  sourceHandle: string
  targetHandle: string
  type: 'custom'
  zIndex?: number
  data: DslEdgeData
}

export interface DslViewport {
  x: number
  y: number
  zoom: number
}

export interface DslGraph {
  nodes: DslNode[]
  edges: DslEdge[]
  viewport?: DslViewport
}

// ── 变量（环境 / 会话） ─────────────────────────────────────

export interface EnvironmentVariable {
  id: string
  name: string
  value_type: VarType
  value: unknown
  description?: string
  selector?: ValueSelector
}

export interface ConversationVariable {
  id: string
  name: string
  value_type: VarType
  value: unknown
  description?: string
  selector?: ValueSelector
}

// ── features ────────────────────────────────────────────────

export interface FileUploadFeature {
  enabled?: boolean
  allowed_file_extensions?: string[]
  allowed_file_types?: string[]
  allowed_file_upload_methods?: string[]
  number_limits?: number
  fileUploadConfig?: Record<string, number>
  image?: {
    enabled?: boolean
    number_limits?: number
    transfer_methods?: string[]
  }
}

export interface WorkflowFeatures {
  file_upload?: FileUploadFeature
  opening_statement?: string
  retriever_resource?: { enabled?: boolean }
  sensitive_word_avoidance?: { enabled?: boolean }
  speech_to_text?: { enabled?: boolean }
  suggested_questions?: string[]
  suggested_questions_after_answer?: { enabled?: boolean }
  text_to_speech?: { enabled?: boolean; language?: string; voice?: string }
  [key: string]: unknown
}

// ── 信封 ────────────────────────────────────────────────────

/** 应用模式；本编辑器只处理 workflow / advanced-chat */
export type AppMode =
  | 'workflow'
  | 'advanced-chat'
  | 'chat'
  | 'agent-chat'
  | 'completion'
  | 'agent'
  | 'channel'
  | 'rag-pipeline'

export interface DslAppMeta {
  name: string
  mode: AppMode
  icon?: string
  icon_type?: string
  icon_background?: string
  description?: string
  use_icon_as_answer_icon?: boolean
  [key: string]: unknown
}

export interface PluginDependency {
  current_identifier: string | null
  type: 'marketplace' | 'package' | 'github'
  value: Record<string, unknown>
}

export interface DslWorkflow {
  graph: DslGraph
  features?: WorkflowFeatures
  environment_variables?: EnvironmentVariable[]
  conversation_variables?: ConversationVariable[]
  rag_pipeline_variables?: unknown[]
}

/** 文档级本地私有扩展，导出 Dify 时剥离 */
export interface DslDocExtras {
  /** 画布 UI 状态等 */
  ui?: Record<string, unknown>
  /** 上次运行摘要 */
  lastRun?: Record<string, unknown>
  [key: string]: unknown
}

export interface DslDocument {
  version: string
  kind: 'app'
  app: DslAppMeta
  workflow: DslWorkflow
  dependencies?: PluginDependency[]
  site?: Record<string, unknown>
  agent_packages?: unknown[]
  /** 本地私有扩展（导出 Dify 时剥离） */
  'x-ai-km'?: DslDocExtras
}

// ── 版本工具 ────────────────────────────────────────────────

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
}

/** 解析语义化版本；无法解析时返回 null */
export function parseDslVersion(version: unknown): ParsedVersion | null {
  if (typeof version !== 'string') return null
  const m = version.trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0) }
}

/** DSL 导入兼容性结论（对齐 Dify 的 check_version_compatibility） */
export type VersionCompatibility = 'completed' | 'completed_with_warnings' | 'pending' | 'unsupported'

export function checkVersionCompatibility(
  imported: unknown,
  current = SUPPORTED_DSL_VERSION,
): VersionCompatibility {
  const a = parseDslVersion(imported ?? LEGACY_DSL_VERSION)
  const b = parseDslVersion(current)
  if (!a || !b) return 'unsupported'
  if (a.major > b.major || a.minor > b.minor) return 'pending'
  if (a.major < b.major) return 'pending'
  if (a.minor < b.minor) return 'completed_with_warnings'
  return 'completed'
}
