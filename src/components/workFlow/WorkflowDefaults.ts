// src/components/workFlow/WorkflowDefaults.ts
// 工作流节点默认配置

import type { NodeData, NodeType, NodeTemplate, McpConfig, KbOptions, StructuredConfig, DecisionConfig, DecisionBranch, FileTemplate, FileMode, StructuredColumn, WebSearchOptions } from '@/components/workFlow/WorkflowTypes'
import { normalizeLlmType } from '@/shared/llmSources'

// MCP节点默认配置
export const defaultMCPConfig: McpConfig = {
  mode: 'inline',
  transport: 'stdio',
  command: '',
  args: '',
  env: {},
  serverUrl: '',
  selectedTool: '',
  toolArguments: {},
  autoConnect: true,
  tools: []
}

// 知识库节点默认选项
export const defaultKbOptions: KbOptions = {
  topK: 5,
  summaryWeight: 0.7,
  embedModel: '',
  debug: false,
  missingModelStrategy: 'error' as const,
  fallbackModels: ['nomic-embed-text:latest', 'all-minilm:latest']
}

// 结构化节点默认配置
export const defaultStructuredConfig: StructuredConfig = {
  outputFormat: 'json',
  includeHeaders: true,
  tableDescription: ''
}

// 默认决策分支
export const defaultDecisionBranches: DecisionBranch[] = [
  { id: 'branch_1', name: '分支1', description: '第一条路径', dataTemplate: '{input}' },
  { id: 'branch_2', name: '分支2', description: '第二条路径', dataTemplate: '{input}' }
]

// 决策节点默认配置
export const defaultDecisionConfig: DecisionConfig = {
  mode: 'llm',
  prompt: '请根据以下内容进行分析决策，从提供的分支中选择最合适的一个：\n\n输入内容：{input}\n\n可用分支：{branches}\n\n请只返回分支ID，不要包含其他内容。',
  rules: '',
  branches: defaultDecisionBranches
}

// 文件模板默认配置
export const defaultFileTemplates: FileTemplate[] = [
  { name: 'chapter_1', pattern: 'chapter_1', outputName: 'chapter_1' },
  { name: 'chapter_2', pattern: 'chapter_2', outputName: 'chapter_2' },
  { name: 'chapter_3', pattern: 'chapter_3', outputName: 'chapter_3' }
]

// 默认结构化列
export const defaultStructuredColumns: StructuredColumn[] = [
  { id: 0, name: '键', type: 'text', required: true },
  { id: 1, name: '值', type: 'text', required: true }
]

// 克隆文件模板
export function cloneFileTemplates(templates?: FileTemplate[] | null): FileTemplate[] {
  if (!templates) return []
  return templates.map(t => ({ ...t }))
}

// 等待状态文本映配置
export function getWaitingText(type: NodeType, t: (key: string) => string): string {
  const map: Record<NodeType, string> = {
    'text': 'waiting',
    'local': 'waiting',
    'web': 'waiting_search',
    'webpage': 'waiting_fetch',
    'reasoning': 'waiting_reasoning',
    'decision': 'waiting_decision',
    'python': 'waiting_execute',
    'knowledge': 'waiting_retrieval',
    'structured': 'waiting_structured',
    'mcp': 'waiting',
    'subflow': 'waiting',
    'iteration': 'waiting_iteration',
    'aggregator': 'waiting_aggregator',
    'list': 'waiting_list',
    'data': 'waiting_data',
    'agent': 'waiting_agent',
    'word': 'waiting_word',
    'start': 'waiting_start',
    'end': 'waiting_end'
  }
  return t(map[type])
}

// 节点图标映射
export function getNodeIconByType(type: NodeType): string {
  const icons: Record<NodeType, string> = {
    'start': 'fa-play-circle',
    'end': 'fa-flag-checkered',
    'text': 'fa-tag',
    'local': 'fa-file-text',
    'web': 'fa-search',
    'webpage': 'fa-globe',
    'reasoning': 'fa-microchip',
    'decision': 'fa-code-fork',
    'python': 'fa-code',
    'knowledge': 'fa-database',
    'structured': 'fa-table',
    'mcp': 'fa-plug',
    'subflow': 'fa-sitemap',
    'iteration': 'fa-repeat',
    'aggregator': 'fa-object-group',
    'list': 'fa-list',
    'data': 'fa-file-excel-o',
    'agent': 'fa-android',
    'word': 'fa-file-word-o'
  }
  return icons[type] || 'fa-circle'
}

// 节点图标颜色映射
export function getNodeColorByType(type: NodeType): string {
  const colors: Record<NodeType, string> = {
    'start': '#3a5900',
    'end': '#7e0800',
    'text': '#161fc4',
    'local': '#0464b2',
    'web': '#FF9800',
    'webpage': '#795548',
    'reasoning': '#007504',
    'decision': '#a00070',
    'python': '#005296',
    'knowledge': '#6c0080',
    'structured': '#300082',
    'mcp': '#00BCD4',
    'subflow': '#FF6F00',
    'iteration': '#00897B',
    'aggregator': '#5E35B1',
    'list': '#00838F',
    'data': '#546E7A',
    'agent': '#512DA8',
    'word': '#2B579A'
  }
  return colors[type] || '#757575'
}

// 状态颜色映配置
export function getStatusColor(status: string): string {
  const colors: Record<string, string> = {
    'running': '#2196F3',
    'success': '#4CAF50',
    'error': '#f44336'
  }
  return colors[status] || '#757575'
}

// 状态图标映配置
export function getStatusIcon(status: string): string {
  const icons: Record<string, string> = {
    'idle': 'fa-clock-o',
    'running': 'fa-spinner fa-spin',
    'success': 'fa-check-circle',
    'error': 'fa-exclamation-circle'
  }
  return icons[status] || 'fa-circle'
}

// 节点模板（不含国际化文本配置）
export function createNodeTemplates(t: (key: string) => string): Record<NodeType, NodeTemplate> {
  return {
    text: {
      name: t('text_node'), type: 'text',
      model_type: '', model: '',
      prompt: t('input_text') + '...', result: t('waiting'),
      width: 250, height: 80, status: 'idle'
    },
    local: {
      name: t('local_node'), type: 'local',
      model_type: '', model: '',
      prompt: t('drag_file'), result: t('waiting'),
      width: 250, height: 80, status: 'idle',
      fileMode: 'full', fileTemplates: cloneFileTemplates(defaultFileTemplates)
    },
    web: {
      name: t('web_node'), type: 'web',
      model_type: '', model: '',
      prompt: t('input_search') + '...', result: t('waiting_search'),
      width: 250, height: 80, status: 'idle',
      webSearchOptions: { searchApi: 'web_search' }
    },
    webpage: {
      name: t('webpage_node'), type: 'webpage',
      model_type: '', model: '',
      prompt: 'https://', result: t('waiting_fetch'),
      width: 250, height: 80, status: 'idle',
      webpageOptions: {
        visitMode: 'single',
        includeLinks: true,
        followLinks: false,
        maxPages: 1,
        sameDomainOnly: true,
        mainContentStrategy: 'textDensity',
        patternTemplate: '',
        patternStart: 1,
        patternEnd: 10,
        patternStep: 1
      }
    },
    reasoning: {
      name: t('reasoning_node'), type: 'reasoning',
      model_type: '', model: '',
      prompt: t('input_prompt') + '...', result: t('waiting_reasoning'),
      width: 250, height: 80, status: 'idle'
    },
    decision: {
      name: t('decision_node'), type: 'decision',
      model_type: 'ollama', model: '',
      prompt: t('decision_prompt_placeholder'), result: t('waiting_decision'),
      width: 250, height: 80, status: 'idle'
    },
    python: {
      name: t('python_node'), type: 'python',
      model_type: 'python', model: 'python',
      prompt: `# ${t('input_code')}\n# ${t('available_vars')}: input, output, log()\noutput=input\nprint(output)`,
      result: t('waiting_execute'),
      width: 250, height: 80, status: 'idle'
    },
    knowledge: {
      name: t('knowledge_node'), type: 'knowledge',
      model_type: '', model: '',
      prompt: t('drag_kb_file'), result: t('waiting_retrieval'),
      width: 250, height: 80, status: 'idle'
    },
    structured: {
      name: t('structured_node'), type: 'structured',
      model_type: '', model: '',
      prompt: t('table_editor'), result: t('waiting_structured'),
      width: 250, height: 80, status: 'idle'
    },
    mcp: {
      name: t('mcp_node'), type: 'mcp',
      model_type: '', model: '',
      prompt: '', result: t('mcp_disconnected'),
      width: 250, height: 80, status: 'idle'
    },
    subflow: {
      name: t('subflow_node'), type: 'subflow',
      model_type: '', model: '',
      prompt: t('drop_flow_file'), result: t('waiting'),
      width: 250, height: 80, status: 'idle'
    },
    iteration: {
      name: t('iteration_node'), type: 'iteration',
      model_type: '', model: '',
      prompt: t('iteration_prompt_placeholder'), result: t('waiting_iteration'),
      width: 280, height: 120, status: 'idle',
      iterationConfig: {
        inputArray: '', innerItems: [],
        concurrency: 1, errorMode: 'terminated', maxIterations: 1000000,
        outputMode: 'value'
      }
    },
    aggregator: {
      name: t('aggregator_node'), type: 'aggregator',
      model_type: '', model: '',
      prompt: '', result: t('waiting_aggregator'),
      width: 250, height: 80, status: 'idle',
      aggregatorConfig: { mode: 'collect', inputVar: '' }
    },
    list: {
      name: t('list_node'), type: 'list',
      model_type: '', model: '',
      prompt: t('list_prompt_placeholder'), result: t('waiting_list'),
      width: 250, height: 80, status: 'idle',
      listOpConfig: { inputList: '', operations: [] }
    },
    data: {
      name: t('data_node'), type: 'data',
      model_type: '', model: '',
      prompt: t('data_prompt_placeholder'), result: t('waiting_data'),
      width: 250, height: 80, status: 'idle',
      dataConfig: { filePath: '', delimiter: ',', hasHeader: true, maxRows: 0, batchSize: 0, loadMode: 'auto', previewRows: 100 }
    },
    agent: {
      name: t('agent_node'), type: 'agent',
      model_type: '', model: '',
      prompt: '', result: t('waiting_agent'),
      width: 250, height: 80, status: 'idle',
      agentConfig: { presetId: '', prompt: '', timeoutMs: 600000 }
    },
    word: {
      name: t('word_node'), type: 'word',
      model_type: '', model: '',
      prompt: '', result: t('waiting_word'),
      width: 250, height: 80, status: 'idle',
      wordConfig: { content: '', template: '', stylePath: '', dirPath: '', fileName: '', overwrite: false }
    },
    start: {
      name: t('start_node'), type: 'start',
      model_type: '', model: '',
      prompt: t('input_text') + '...', result: t('waiting_start'),
      width: 250, height: 80, status: 'idle'
    },
    end: {
      name: t('end_node'), type: 'end',
      model_type: '', model: '',
      prompt: '', result: t('waiting_end'),
      width: 250, height: 80, status: 'idle'
    }
  }
}

// 创建新节点的扩展默认配置
export function createNodeDefaults(node: NodeData, store: any, t: (key: string) => string): void {
  // 单来源迁移：旧 .flow 里的历史别名 'deepseek-responses' → 'deepseek'
  // （接口样式由全局 deepseek.api_style 决定，节点不再单独保留第二个 DeepSeek 来源）
  if (node.model_type) node.model_type = normalizeLlmType(node.model_type)
  if (node.type === 'reasoning' && !node.model_type) {
    node.model_type = normalizeLlmType(store.AIconfig?.llm?.type) || 'ollama'
  }

  if (node.type === 'decision') {
    if (!node.decisionMode) node.decisionMode = 'llm'
    if (!node.decisionConfig) node.decisionConfig = { ...defaultDecisionConfig }
    if (!node.decisionBranches) node.decisionBranches = [...defaultDecisionConfig.branches]
    if (!node.decisionPrompt && node.decisionMode === 'llm') node.decisionPrompt = defaultDecisionConfig.prompt || ''
    if (!node.decisionRules && node.decisionMode === 'rule') node.decisionRules = defaultDecisionConfig.rules || ''
    // 与现行模型来源对齐（与推理节点一致）；当前为 custom 时默认使用自定义来源
    if (!node.model_type) node.model_type = normalizeLlmType(store.AIconfig?.llm?.type) || 'ollama'
  }

  if (node.type === 'knowledge') {
    if (!node.kbOptions) node.kbOptions = { ...defaultKbOptions }
    if (!node.kbQuery) node.kbQuery = t('input_search') + '...'
    if (!node.kbValidation) {
      node.kbValidation = { valid: false, issues: [t('kb_file_required')] }
    }
  }

  if (node.type === 'structured') {
    if (!node.structuredData) node.structuredData = []
    if (!node.structuredColumns) node.structuredColumns = [...defaultStructuredColumns.map(c => ({ ...c }))]
    if (!node.structuredConfig) node.structuredConfig = { ...defaultStructuredConfig }
  }

  if (node.type === 'mcp') {
    if (!node.mcpConfig) node.mcpConfig = { ...defaultMCPConfig }
    if (node.mcpConnected === undefined) node.mcpConnected = false
    if (!node.mcpTools) node.mcpTools = []
    if (!node.result || node.result === t('waiting')) node.result = t('mcp_disconnected')
  }

  if (node.type === 'local') {
    if (!node.fileMode) node.fileMode = 'full'
    if (!node.fileTemplates || node.fileTemplates.length === 0) {
      node.fileTemplates = cloneFileTemplates(defaultFileTemplates)
    } else {
      node.fileTemplates = cloneFileTemplates(node.fileTemplates)
    }
  }

  if (node.type === 'webpage') {
    if (!node.webpageOptions) {
      node.webpageOptions = {
        includeLinks: true,
        followLinks: false,
        maxPages: 1,
        sameDomainOnly: true,
        mainContentStrategy: 'textDensity'
      }
    }
  }

  if (node.type === 'start') {
    if (!node.startPorts) node.startPorts = { prompt: true }
  }

  if (node.type === 'iteration') {
    if (!node.iterationConfig) {
      node.iterationConfig = { inputArray: '', innerItems: [], concurrency: 1, errorMode: 'terminated', maxIterations: 1000000, outputMode: 'value' }
    }
    if (!node.iterationConfig.innerItems) node.iterationConfig.innerItems = []
    if (!node.iterationConfig.concurrency) node.iterationConfig.concurrency = 1
    if (!node.iterationConfig.errorMode) node.iterationConfig.errorMode = 'terminated'
    if (!node.iterationConfig.outputMode) node.iterationConfig.outputMode = 'value'
  }

  if (node.type === 'aggregator') {
    if (!node.aggregatorConfig) node.aggregatorConfig = { mode: 'collect', inputVar: '' }
  }

  if (node.type === 'list') {
    if (!node.listOpConfig) node.listOpConfig = { inputList: '', operations: [] }
    if (!node.listOpConfig.operations) node.listOpConfig.operations = []
  }

  if (node.type === 'data') {
    if (!node.dataConfig) node.dataConfig = { filePath: '', delimiter: ',', hasHeader: true, maxRows: 0, batchSize: 0, loadMode: 'auto', previewRows: 100 }
  }

  if (node.type === 'agent') {
    if (!node.agentConfig) node.agentConfig = { presetId: '', prompt: '', timeoutMs: 600000 }
  }

  // Word 导出节点：内容/模板/位置（目录与文件名支持 {{节点.字段}} 模板）
  if (node.type === 'word') {
    if (!node.wordConfig) node.wordConfig = { content: '', template: '', stylePath: '', dirPath: '', fileName: '', overwrite: false }
  }
}
