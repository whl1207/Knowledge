/**
 * 节点定义注册表
 *
 * 每种节点类型的单一事实来源：默认 data、输出变量声明、属性面板组件、节点级校验。
 * 变量选择器与属性面板都从这里取信息，避免各处各写一份。
 */

import type { Component } from 'vue'
import type { AnyNodeType, BaseNodeData, VarType } from '../dsl/types'
import { isKnownNodeType, isPrivateNodeType } from '../dsl/types'

/** 输出变量声明（决定变量选择器里能选到什么） */
export interface NodeOutputDeclaration {
  name: string
  type: VarType
  /** 变量名的本地化键（可选） */
  labelKey?: string
}

export interface NodeDefinition {
  type: string
  /** 本地扩展节点（导出 Dify 时需要剥离或降级） */
  private?: boolean
  /** 静态输出变量 */
  outputs?: NodeOutputDeclaration[]
  /** 动态输出变量（开始节点变量、代码节点自定义输出、文件模板切片等） */
  dynamicOutputs?: (data: BaseNodeData) => NodeOutputDeclaration[]
  /** 分支节点的输出端口（if-else 的 case、分类器的 class 等） */
  branches?: (data: BaseNodeData) => Array<{ id: string; label: string }>
  /** 新建节点时写入的节点特有默认字段 */
  defaults?: Record<string, unknown>
  /** 容器类节点（迭代 / 循环）：子节点归属它 */
  container?: boolean
  /** 属性面板组件（懒加载） */
  panel?: () => Promise<{ default: Component }>
  /** 节点级校验，返回问题描述（空数组 = 通过） */
  validate?: (data: BaseNodeData) => string[]
  /** 是否已实现（未实现的节点仍可添加，但面板只显示原始数据） */
  implemented?: boolean
  /** 画布卡片副标题：展示该节点的关键配置（模型、变量、文件等），Dify 同款 */
  summary?: (data: BaseNodeData) => NodeSummary | null
}

/**
 * 节点卡片副标题：可本地化的键 + 占位符参数，或直接给成品文本（如模型名、文件名）。
 * 注册表不依赖 UI 层，所以这里只产出「键」，由画布用 t() 渲染。
 */
export type NodeSummary =
  | { key: string; params?: Record<string, string | number> }
  | { text: string }

const stringOutput = (name: string, type: VarType = 'string'): NodeOutputDeclaration => ({ name, type })

/* ── 卡片副标题的取值助手（注册表只产出可本地化的键或成品文本） ── */

const field = (data: BaseNodeData, key: string): unknown => (data as unknown as Record<string, unknown>)[key]

const arrayField = (data: BaseNodeData, key: string): Array<Record<string, unknown>> => {
  const raw = field(data, key)
  return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []
}

const objectField = (data: BaseNodeData, key: string): Record<string, unknown> => {
  const raw = field(data, key)
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
}

/** 变量选择器末段（['nodeId', 'field'] → field） */
const selectorTail = (selector: unknown): string =>
  Array.isArray(selector) && selector.length ? String(selector[selector.length - 1]) : ''

/** 取文件名（兼容 Windows 反斜杠路径） */
const fileNameOf = (value: unknown): string => {
  const text = String(value ?? '').replace(/\\/g, '/').trim()
  return text ? text.slice(text.lastIndexOf('/') + 1) : ''
}

/** 名称列表摘要：最多保留 max 个，其余用 +n 表示 */
const namesOf = (values: string[], max = 3): string => {
  const items = values.filter(Boolean)
  const shown = items.slice(0, max).join(', ')
  return items.length > max ? `${shown} +${items.length - max}` : shown
}

/** 截断长文本（模板 / 回复正文的预览） */
const clip = (value: unknown, max = 24): string => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * 注册表。输出变量名对齐 Dify 各节点的约定，保证从原生节点换到本地节点时下游引用不用改。
 */
const DEFINITIONS: NodeDefinition[] = [
  {
    type: 'start',
    implemented: true,
    defaults: { variables: [] },
    dynamicOutputs: (data) => {
      const vars = Array.isArray((data as Record<string, unknown>).variables)
        ? ((data as Record<string, unknown>).variables as Array<Record<string, unknown>>)
        : []
      return vars
        .filter((v) => typeof v?.variable === 'string' && v.variable)
        .map((v) => ({ name: String(v.variable), type: normalizeVarType(v.type) }))
    },
    panel: () => import('./start/Properties.vue'),
    summary: (data) => {
      // 显示变量名（与变量选择器里的「输出名」一致，便于对照 {{#节点.变量#}} 写法）
      const names = arrayField(data, 'variables')
        .map((item) => String(item.variable || item.label || ''))
        .filter(Boolean)
      return names.length
        ? { key: 'flow.summary.inputs', params: { list: namesOf(names) } }
        : { key: 'flow.summary.inputMissing' }
    },
  },
  {
    type: 'start-placeholder',
    defaults: { variables: [] },
    outputs: [],
  },
  {
    type: 'end',
    implemented: true,
    defaults: { outputs: [] },
    outputs: [],
    panel: () => import('./end/Properties.vue'),
    summary: (data) => {
      const names = arrayField(data, 'outputs')
        .map((item) => String(item.variable || ''))
        .filter(Boolean)
      return names.length
        ? { key: 'flow.summary.outputs', params: { list: namesOf(names) } }
        : { key: 'flow.summary.outputMissing' }
    },
  },
  {
    type: 'answer',
    implemented: true,
    defaults: { answer: '', variables: [] },
    outputs: [],
    panel: () => import('./answer/Properties.vue'),
    summary: (data) => (clip(field(data, 'answer')) ? { text: clip(field(data, 'answer')) } : null),
  },
  {
    type: 'llm',
    implemented: true,
    defaults: {
      model: { provider: '', name: '', mode: 'chat', completion_params: {} },
      prompt_template: [],
      context: { enabled: false, variable_selector: [] },
      vision: { enabled: false, configs: {} },
    },
    outputs: [
      stringOutput('text'),
      stringOutput('reasoning_content'),
      { name: 'usage', type: 'object' },
      { name: 'files', type: 'array[file]' },
    ],
    panel: () => import('./llm/Properties.vue'),
    summary: (data) => {
      const model = objectField(data, 'model')
      const name = String(model.name || '')
      if (!name) return { key: 'flow.summary.modelMissing' }
      const provider = String(model.provider || '')
      return { text: provider ? `${provider} · ${name}` : name }
    },
  },

  // ── 以下类型暂未实现编辑能力：仅声明输出变量，便于作为上游被引用 ──
  {
    type: 'knowledge-retrieval',
    implemented: true,
    defaults: {
      query_variable_selector: [],
      dataset_ids: [],
      retrieval_mode: 'single',
      multiple_retrieval_config: { top_k: 5, score_threshold: 0, summary_weight: 0.7 },
      kb_path: '',
    },
    outputs: [{ name: 'result', type: 'array[object]' }],
    panel: () => import('./knowledge-retrieval/Properties.vue'),
    summary: (data) => {
      const kb = fileNameOf(field(data, 'kb_path'))
      if (kb) return { text: kb }
      const ids = field(data, 'dataset_ids')
      return { key: 'flow.summary.datasets', params: { n: Array.isArray(ids) ? ids.length : 0 } }
    },
  },
  {
    type: 'question-classifier',
    implemented: true,
    defaults: {
      query_variable_selector: [],
      model: { provider: '', name: '', mode: 'chat', completion_params: {} },
      classes: [
        { id: '1', name: '分类1' },
        { id: '2', name: '分类2' },
      ],
    },
    outputs: [stringOutput('class_name'), stringOutput('class_label'), { name: 'usage', type: 'object' }],
    branches: (data) => readClasses(data).map((item) => ({ id: item.id, label: item.label || item.name || item.id })),
    panel: () => import('./question-classifier/Properties.vue'),
    summary: (data) => ({ key: 'flow.summary.classes', params: { n: readClasses(data).length } }),
  },
  {
    type: 'if-else',
    implemented: true,
    defaults: {
      cases: [{ case_id: 'true', logical_operator: 'and', conditions: [] }],
    },
    outputs: [],
    branches: (data) => [
      ...readCases(data).map((item, index) => ({
        id: item.case_id || `case_${index}`,
        label: `${index + 1}`,
      })),
      { id: 'false', label: 'ELSE' },
    ],
    panel: () => import('./if-else/Properties.vue'),
    summary: (data) => ({ key: 'flow.summary.cases', params: { n: readCases(data).length } }),
  },
  {
    type: 'code',
    implemented: true,
    defaults: { code: '', code_language: 'python3', outputs: {}, variables: [] },
    dynamicOutputs: (data) => {
      const raw = (data as Record<string, unknown>).outputs
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
      return Object.entries(raw as Record<string, unknown>).map(([name, meta]) => ({
        name,
        type: normalizeVarType((meta as Record<string, unknown>)?.type),
      }))
    },
    panel: () => import('./code/Properties.vue'),
    summary: (data) => {
      const lang = String(field(data, 'code_language') || 'python3')
      return { text: lang === 'python3' ? 'Python 3' : lang }
    },
  },
  {
    type: 'template-transform',
    implemented: true,
    defaults: { template: '', variables: [] },
    outputs: [stringOutput('output')],
    panel: () => import('./template-transform/Properties.vue'),
    summary: (data) => (clip(field(data, 'template')) ? { text: clip(field(data, 'template')) } : null),
  },
  {
    type: 'http-request',
    implemented: true,
    defaults: {
      method: 'get',
      url: '',
      headers: [],
      params: [],
      body: { type: 'none', data: [] },
      authorization: { type: 'no-auth', config: {} },
      timeout: { connect: 10000, read: 30000, write: 30000 },
    },
    outputs: [
      stringOutput('body'),
      stringOutput('status_code', 'number'),
      { name: 'headers', type: 'object' },
      { name: 'files', type: 'array[file]' },
    ],
    panel: () => import('./http-request/Properties.vue'),
    summary: (data) => {
      const method = String(field(data, 'method') || 'get').toUpperCase()
      const url = clip(field(data, 'url'), 30)
      return { text: url ? `${method} ${url}` : method }
    },
  },
  {
    type: 'tool',
    implemented: true,
    defaults: {
      provider_id: '',
      provider_type: 'mcp',
      tool_name: '',
      tool_parameters: {},
      mcp_server: { mode: 'inline', transport: 'stdio', command: '', args: [], server_url: '' },
    },
    outputs: [stringOutput('text'), { name: 'files', type: 'array[file]' }, { name: 'json', type: 'array[object]' }],
    panel: () => import('./tool/Properties.vue'),
    summary: (data) => {
      const tool = String(field(data, 'tool_name') || '')
      if (!tool) return { key: 'flow.summary.toolMissing' }
      const provider = String(field(data, 'provider_type') || '')
      return { text: provider ? `${provider} · ${tool}` : tool }
    },
  },
  {
    type: 'variable-aggregator',
    implemented: true,
    defaults: { variables: [] },
    outputs: [{ name: 'output', type: 'any' }],
    panel: () => import('./variable-aggregator/Properties.vue'),
    summary: (data) => ({ key: 'flow.summary.variables', params: { n: arrayField(data, 'variables').length } }),
  },
  // Dify 现行类型为 assigner（variable-assigner 是旧别名，保留注册以兼容旧文件）
  {
    type: 'variable-assigner',
    defaults: { items: [] },
    outputs: [],
    panel: () => import('./assigner/Properties.vue'),
    summary: (data) => ({ key: 'flow.summary.items', params: { n: arrayField(data, 'items').length } }),
  },
  {
    type: 'assigner',
    implemented: true,
    defaults: { items: [], version: '2' },
    outputs: [],
    panel: () => import('./assigner/Properties.vue'),
    summary: (data) => ({ key: 'flow.summary.items', params: { n: arrayField(data, 'items').length } }),
  },
  {
    type: 'parameter-extractor',
    implemented: true,
    defaults: { query: [], model: { provider: '', name: '', mode: 'chat', completion_params: {} }, parameters: [], reasoning_mode: 'prompt' },
    outputs: [
      stringOutput('__reason'),
      stringOutput('__is_success', 'number'),
    ],
    dynamicOutputs: (data) => {
      const params = (data as Record<string, unknown>).parameters
      if (!Array.isArray(params)) return []
      return params
        .filter((p) => typeof (p as Record<string, unknown>)?.name === 'string' && (p as Record<string, unknown>).name)
        .map((p) => ({ name: String((p as Record<string, unknown>).name), type: normalizeVarType((p as Record<string, unknown>).type) }))
    },
    panel: () => import('./parameter-extractor/Properties.vue'),
    summary: (data) => ({ key: 'flow.summary.params', params: { n: arrayField(data, 'parameters').length } }),
  },
  {
    type: 'iteration',
    container: true,
    implemented: true,
    defaults: {
      iterator_selector: [],
      output_selector: [],
      is_parallel: false,
      parallel_nums: 10,
      error_handle_mode: 'terminated',
    },
    outputs: [{ name: 'output', type: 'array[any]' }],
    panel: () => import('./iteration/Properties.vue'),
    summary: (data) => {
      const iterator = selectorTail(field(data, 'iterator_selector'))
      return iterator ? { text: iterator } : { key: 'flow.summary.iteratorMissing' }
    },
  },
  {
    type: 'iteration-start',
    outputs: [
      stringOutput('item', 'any'),
      stringOutput('index', 'number'),
    ],
  },
  {
    type: 'loop',
    container: true,
    implemented: true,
    defaults: {
      loop_count: 10,
      loop_variables: [],
      break_conditions: [],
      error_handle_mode: 'terminated',
    },
    outputs: [{ name: 'output', type: 'any' }, stringOutput('rounds', 'number')],
    panel: () => import('./loop/Properties.vue'),
    summary: (data) => ({ key: 'flow.summary.loop', params: { n: Number(field(data, 'loop_count')) || 0 } }),
  },
  { type: 'loop-start', outputs: [stringOutput('index', 'number')] },
  { type: 'loop-end', outputs: [] },
  {
    type: 'document-extractor',
    implemented: true,
    defaults: { variable_selector: [] },
    outputs: [stringOutput('text')],
    panel: () => import('./document-extractor/Properties.vue'),
    summary: (data) => {
      const target = selectorTail(field(data, 'variable_selector'))
      return target ? { text: target } : { key: 'flow.summary.fileMissing' }
    },
  },
  {
    type: 'list-operator',
    implemented: true,
    defaults: {
      variable: [],
      filter_by: { enabled: false, conditions: [], logical_operator: 'and' },
      order_by: { enabled: false, value: '', order: 'asc' },
      extract_by: { enabled: false, value: '' },
      limit: { enabled: false, size: 10 },
    },
    outputs: [{ name: 'result', type: 'array[any]' }],
    panel: () => import('./list-operator/Properties.vue'),
    summary: (data) => {
      const enabled = ['filter_by', 'order_by', 'extract_by', 'limit'].filter(
        (key) => objectField(data, key).enabled === true,
      )
      return { key: 'flow.summary.ops', params: { n: enabled.length } }
    },
  },
  { type: 'agent', defaults: {}, outputs: [stringOutput('text'), { name: 'files', type: 'array[file]' }, { name: 'json', type: 'array[object]' }] },
  { type: 'agent-v2', defaults: {}, outputs: [stringOutput('text'), { name: 'files', type: 'array[file]' }] },
  { type: 'human-input', defaults: {}, outputs: [] },
  { type: 'datasource', defaults: {}, outputs: [] },
  { type: 'datasource-empty', defaults: {}, outputs: [] },
  { type: 'knowledge-index', defaults: {}, outputs: [] },
  { type: 'trigger-schedule', defaults: {}, outputs: [] },
  { type: 'trigger-webhook', defaults: {}, outputs: [] },
  { type: 'trigger-plugin', defaults: {}, outputs: [] },

  // ── 本地扩展节点（身份私有，契约与 Dify 节点一致） ──
  {
    type: 'ai-km-word',
    private: true,
    implemented: true,
    defaults: { content_variable_selector: [], content: '', template: '', style_path: '', dir_path: '', file_name: '', overwrite: false },
    outputs: [stringOutput('file_path'), stringOutput('file_name')],
    panel: () => import('./private/WordProperties.vue'),
    summary: (data) => {
      const target =
        fileNameOf(field(data, 'template')) ||
        fileNameOf(field(data, 'style_path')) ||
        selectorTail(field(data, 'content_variable_selector'))
      return target ? { text: target } : null
    },
  },
  {
    type: 'ai-km-csv',
    private: true,
    implemented: true,
    defaults: { file_path: '', has_header: true, delimiter: ',', load_mode: 'preview', preview_rows: 20, max_rows: 0, batch_size: 0 },
    outputs: [
      { name: 'rows', type: 'array[object]' },
      { name: 'headers', type: 'array[string]' },
      stringOutput('total', 'number'),
      { name: 'batches', type: 'array[array[object]]' },
    ],
    panel: () => import('./private/CsvProperties.vue'),
    summary: (data) => {
      const file = fileNameOf(field(data, 'file_path'))
      return file ? { text: file } : { key: 'flow.summary.fileMissing' }
    },
  },
  {
    type: 'ai-km-file',
    private: true,
    implemented: true,
    defaults: { file_path: '', file_mode: 'full', file_templates: [] },
    outputs: [stringOutput('content')],
    dynamicOutputs: (data) => {
      const raw = (data as Record<string, unknown>).file_templates
      if (!Array.isArray(raw)) return []
      return raw
        .filter((t) => typeof (t as Record<string, unknown>)?.output_name === 'string' && (t as Record<string, unknown>).output_name)
        .map((t) => stringOutput(String((t as Record<string, unknown>).output_name)))
    },
    panel: () => import('./private/LocalFileProperties.vue'),
    summary: (data) => {
      const file = fileNameOf(field(data, 'file_path'))
      return file ? { text: file } : { key: 'flow.summary.fileMissing' }
    },
  },
  {
    type: 'ai-km-knowledge',
    private: true,
    implemented: true,
    defaults: { kb_path: '', query_variable_selector: [], query: '', multiple_retrieval_config: { top_k: 5, score_threshold: 0, summary_weight: 0.7 } },
    outputs: [{ name: 'result', type: 'array[object]' }],
    panel: () => import('./private/KnowledgeProperties.vue'),
    summary: (data) => {
      const kb = fileNameOf(field(data, 'kb_path'))
      return kb ? { text: kb } : { key: 'flow.summary.fileMissing' }
    },
  },
  {
    type: 'ai-km-mcp',
    private: true,
    implemented: true,
    defaults: { provider_id: '', provider_type: 'mcp', tool_name: '', tool_parameters: {}, mcp_server: { mode: 'inline', transport: 'stdio', command: '', args: [], server_url: '' } },
    outputs: [stringOutput('text'), { name: 'json', type: 'object' }],
    panel: () => import('./private/McpProperties.vue'),
    summary: (data) => {
      const tool = String(field(data, 'tool_name') || '')
      if (!tool) return { key: 'flow.summary.toolMissing' }
      const server = objectField(data, 'mcp_server')
      const label = fileNameOf(server.command) || clip(server.server_url, 20)
      return { text: label ? `${label} · ${tool}` : tool }
    },
  },
  {
    type: 'ai-km-subflow',
    private: true,
    implemented: true,
    defaults: { subflow_path: '', subflow_name: '', variables: [] },
    outputs: [{ name: 'output', type: 'any' }],
    panel: () => import('./private/SubflowProperties.vue'),
    summary: (data) => {
      const name = String(field(data, 'subflow_name') || '') || fileNameOf(field(data, 'subflow_path'))
      return name ? { text: name } : { key: 'flow.summary.fileMissing' }
    },
  },
]

/** 归一化 Dify 的变量类型字符串到 VarType */
function normalizeVarType(raw: unknown): VarType {
  const value = String(raw ?? '').trim()
  if (!value) return 'any'
  if (value.startsWith('array[')) return value as VarType
  const allowed: VarType[] = ['string', 'number', 'integer', 'float', 'boolean', 'object', 'secret', 'file', 'llm', 'any']
  return (allowed as string[]).includes(value) ? (value as VarType) : 'any'
}

/** 读取分类器的分类列表（缺失时补默认 id） */
export function readClasses(data: BaseNodeData): Array<{ id: string; name?: string; label?: string }> {
  const raw = (data as unknown as Record<string, unknown>).classes
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item) => item && typeof item === 'object')
    .map((item, index) => {
      const record = item as Record<string, unknown>
      return {
        id: String(record.id ?? index + 1),
        name: record.name === undefined ? undefined : String(record.name),
        label: record.label === undefined ? undefined : String(record.label),
      }
    })
}

/** 读取 if-else 的分支列表（case_id 缺省按顺序补） */
export function readCases(data: BaseNodeData): Array<{ case_id?: string; logical_operator?: 'and' | 'or'; conditions?: unknown[] }> {
  const raw = (data as unknown as Record<string, unknown>).cases
  if (!Array.isArray(raw)) return []
  return raw.filter((item) => item && typeof item === 'object') as ReturnType<typeof readCases>
}

/**
 * 节点的输出端口（分支节点按分支展开；其余返回单个 'source'）。
 * `error_strategy === 'fail-branch'` 时追加异常分支端口（与 Dify 一致）。
 */
export function getNodeBranches(data: BaseNodeData): Array<{ id: string; label: string }> {
  const def = REGISTRY.get(String(data.type))
  const branches = def?.branches?.(data) ?? []
  const result = branches.length ? branches : [{ id: 'source', label: '' }]
  if (data.error_strategy === 'fail-branch') result.push({ id: 'fail-branch', label: '异常' })
  return result
}

/** 是否为分支节点（输出端口不止一个） */
export function isBranchNode(data: BaseNodeData): boolean {
  return getNodeBranches(data).length > 1
}

/** 画布卡片副标题：返回可本地化的键 + 参数，或成品文本；无摘要时返回 null */
export function getNodeSummary(data: BaseNodeData): NodeSummary | null {
  return getNodeDefinition(data.type as AnyNodeType)?.summary?.(data) ?? null
}

const REGISTRY = new Map<string, NodeDefinition>(DEFINITIONS.map((d) => [d.type, d]))

/** 取节点定义；未知类型返回 undefined */
export function getNodeDefinition(type: AnyNodeType): NodeDefinition | undefined {
  return REGISTRY.get(String(type))
}

/** 是否已实现编辑能力 */
export function isNodeImplemented(type: AnyNodeType): boolean {
  return !!REGISTRY.get(String(type))?.implemented
}

/** 节点是否为容器（迭代 / 循环） */
export function isContainerNode(type: AnyNodeType): boolean {
  return !!REGISTRY.get(String(type))?.container
}

/** 取节点的输出变量声明（静态 + 动态） */
export function getNodeOutputs(data: BaseNodeData): NodeOutputDeclaration[] {
  const def = REGISTRY.get(String(data.type))
  if (!def) return []
  return [...(def.outputs ?? []), ...(def.dynamicOutputs?.(data) ?? [])]
}

/** 新建节点时写入节点特有默认字段 */
export function getNodeDefaults(type: AnyNodeType): Record<string, unknown> {
  return { ...(REGISTRY.get(String(type))?.defaults ?? {}) }
}

/** 属性面板组件加载器（未注册的返回 undefined，由调用方回落到通用面板） */
export function getNodePanel(type: AnyNodeType): (() => Promise<{ default: Component }>) | undefined {
  return REGISTRY.get(String(type))?.panel
}

/** 节点级校验（数据驱动，返回问题描述） */
export function validateNode(data: BaseNodeData): string[] {
  const issues = REGISTRY.get(String(data.type))?.validate?.(data) ?? []
  if (!isKnownNodeType(String(data.type))) {
    issues.push(`未识别的节点类型「${data.type}」，暂不可编辑或执行`)
  }
  return issues
}

/** 节点选择器里可选的全部类型（按分组） */
export interface NodePickerGroup {
  key: string
  labelKey: string
  types: string[]
}

export const NODE_PICKER_GROUPS: NodePickerGroup[] = [
  { key: 'basic', labelKey: 'picker.group.basic', types: ['start', 'end', 'answer', 'llm'] },
  {
    key: 'logic',
    labelKey: 'picker.group.logic',
    types: ['if-else', 'question-classifier', 'iteration', 'loop', 'variable-aggregator', 'assigner'],
  },
  {
    key: 'data',
    labelKey: 'picker.group.data',
    types: ['knowledge-retrieval', 'code', 'template-transform', 'http-request', 'tool', 'parameter-extractor', 'document-extractor', 'list-operator', 'agent'],
  },
  {
    key: 'private',
    labelKey: 'picker.group.private',
    types: ['ai-km-word', 'ai-km-csv', 'ai-km-file', 'ai-km-knowledge', 'ai-km-mcp', 'ai-km-subflow'],
  },
]

/** Dify 里只允许一个的节点类型 */
export const SINGLETON_TYPES = ['start', 'end']

export { isPrivateNodeType }
