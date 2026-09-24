// src/components/workFlow/engine/WorkflowRunner.ts
// 重构：引入 VariablePool + GraphEngine

import { retrieveKnowledge, validateKnowledgeBase } from '@/shared/kbRetrieval'
import { mcpManager, type McpTool } from '@/platform/mcpManager'
import { VariablePool } from '@/components/workFlow/engine/VariablePool'
import { GraphEngine } from '@/components/workFlow/engine/GraphEngine'
import { createExecutorRegistry } from '@/components/workFlow/engine/nodes/index'
import type { NodeExecutorRegistry, ExecutionContext } from '@/components/workFlow/engine/NodeExecutor'
import { validateModelConfig, extractErrorFromResult, extractPythonErrorInfo, applyDataTemplate } from '@/components/workFlow/engine/executorHelpers'
import { resolveTemplate, resolveTemplateRaw as resolveTemplateRawImpl } from '@/components/workFlow/engine/templateResolver'

// 定义节点类型
export type NodeType = 'reasoning' | 'decision' | 'local' | 'web' | 'text' | 'webpage' | 'python' | 'knowledge' | 'structured' | 'start' | 'end' | 'mcp' | 'subflow' | 'iteration' | 'aggregator' | 'list' | 'data' | 'agent' | 'word'

// MCP 节点特有字段
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

// 文件节点模板配置
export interface FileTemplate {
  name: string
  pattern: string
  outputName: string
}

// 文件节点处理模式
export type FileMode = 'full' | 'template'

// 决策分支接口
export interface DecisionBranch {
  id: string
  name: string
  description: string
  condition?: string // 规则决策的条件表达式
  dataTemplate?: string // 传递给下游的数据模板，默认 {input}
}

export interface WebpageOptions {
  includeLinks?: boolean
  followLinks?: boolean
  maxPages?: number
  sameDomainOnly?: boolean
  mainContentStrategy?: 'simple' | 'textDensity' | 'readability'
  visitMode?: 'single' | 'followLinks' | 'pattern'
  patternTemplate?: string
  patternStart?: number
  patternEnd?: number
  patternStep?: number
}

// 工作流数据结构接口
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
  status: 'idle' | 'running' | 'success' | 'error'
  startPorts?: {
    prompt: boolean
  }
  // 推理节点特有字段
  reasoningConfig?: any
  
  // 决策节点特有字段
  decisionMode?: 'llm' | 'rule'
  decisionPrompt?: string
  decisionRules?: string
  decisionConfig?: {
    mode: 'llm' | 'rule'
    prompt?: string
    rules?: string
    branches: DecisionBranch[]
    selectedBranch?: string
  }
  decisionBranches?: DecisionBranch[]
  
  // 知识库节点特有字段
  kbPath?: string
  kbQuery?: string
  kbOptions?: {
    topK?: number
    summaryWeight?: number
    embedModel?: string
    debug?: boolean
    missingModelStrategy?: 'error' | 'fallback'
    fallbackModels?: string[]
  }
  kbValidation?: {
    valid: boolean
    issues: string[]
    availableModel?: string
    config?: any
  }
  
  // 结构化节点特有字段
  structuredData?: any[]
  structuredColumns?: any[]
  structuredConfig?: any
  
  // MCP 节点特有字段
  mcpConfig?: McpConfig
  mcpConnected?: boolean
  mcpTools?: McpTool[]
  
  // 文件节点特有字段
  fileMode?: FileMode
  fileTemplates?: FileTemplate[]
  outputPorts?: {
    default: boolean;  // 默认输出端口
    ports: Array<{
      id: string;
      name: string;
      description?: string;
      enabled: boolean;
      data?: any; // 新增：存储该端口的数据
    }>;
  };
  
  // 网页节点特有字段
  webpageOptions?: WebpageOptions
  
  // 网络搜索节点特有字段（复用统一 web_search 工具，无需 API Key）
  webSearchOptions?: {
    searchApi?: 'web_search'
  }
  
  // 子工作流节点特有字段
  subflowPath?: string
  subflowName?: string
  
  // 迭代节点特有字段
  iterationConfig?: any
  // 列表操作节点特有字段
  listOpConfig?: any
  // 数据(CSV)节点特有字段
  dataConfig?: any
  // 变量聚合节点特有字段
  aggregatorConfig?: any
  // 工具节点特有字段
  toolConfig?: any
  // 智能体节点特有字段
  agentConfig?: any
  // Word 导出节点特有字段
  wordConfig?: any
  /** 迭代节点断点续跑缓存（内部字段，随 .flow 持久化；中断时保存，续跑时读取后清除） */
  _iterResume?: {
    total: number
    done: Array<{ index: number; value: any }>
    failed: Array<{ index: number; error: string }>
    errorMode?: string
    outputNodeId?: number
    outputKey?: string
  }
}

export interface Link {
  source: number
  target: number
  sourcePort?: string  // 源端口ID
  targetPort?: string  // 目标端口ID
  branch?: string // 决策节点的分支连接
}

export interface WorkflowData {
  items: NodeData[]
  links: Link[]
}

// 执行状态回调接口
export interface ExecutionCallback {
  // 节点执行开始
  onNodeStart?: (nodeId: number, nodeName: string, nodeType: NodeType) => void
  
  // 节点执行结束
  onNodeComplete?: (nodeId: number, nodeName: string, nodeType: NodeType, status: NodeData['status'], result: any) => void
  
  // Python节点执行错误
  onPythonError?: (nodeId: number, nodeName: string, error: string, traceback?: string) => void
  
  // 决策节点分支选择
  onDecisionBranchSelected?: (nodeId: number, nodeName: string, branchId: string, branchName: string, reason?: string) => void
  
  // MCP节点连接状态更新
  onMcpStatusChange?: (nodeId: number, connected: boolean, tools?: McpTool[]) => void
  
  // 工作流进度更新
  onProgress?: (completed: number, total: number, currentNode?: string) => void
  
  // 工作流执行完成
  onComplete?: (success: boolean, finalResult: string, aggregatedResults?: Record<string, any>) => void
  
  // 实时日志
  onLog?: (message: string, level: 'info' | 'warning' | 'error') => void
  
  // 节点流式输出（逐块更新）
  onNodeStream?: (nodeId: number, chunk: string, accumulated: string) => void
  
  // 节点状态更新（用于Vue组件响应式更新）
  onNodeStatusUpdate?: (nodeId: number, status: NodeData['status'], result?: string) => void
  
  // 工作流数据保存回调
  onSaveWorkflow?: () => void
  
  // 国际化函数
  t?: (key: string) => string
}

// 工作流运行器类
export class WorkflowRunner {
  private workflowData: WorkflowData
  private store: any
  callbacks: ExecutionCallback
  private _isRunning: boolean = false
  private currentStep: number = 0
  private abortController: AbortController | null = null
  private decisionPaths: Map<number, string> = new Map() // 记录决策节点选中的分支
  private decisionDataTemplates: Map<number, string> = new Map() // 记录决策节点的数据模板
  private executionLogs: Array<{message: string, level: 'info' | 'warning' | 'error', timestamp: Date}> = []
  private executedNodes: Set<number> = new Set() // 记录已执行的节点
  private nodeExecutionOrder: number[] = [] // 记录节点执行顺序
  private t: (key: string) => string // 国际化函数
  /** 累加器存储（变量聚合节点跨迭代累计；nodeId -> 数组） */
  private accumulators = new Map<number, any[]>()
  /** 数据节点全量数据缓存（run 级；nodeId -> 全量行/批次，供迭代/列表直接取用，避免大 JSON 字符串化） */
  private dataCache = new Map<number, { rows: any[]; batches?: any[][]; headers: string[]; total: number }>()
  /** 数组节点全量输出缓存（run 级；迭代/列表节点 output -> 全量数组，node.result 只存预览） */
  private arrayCache = new Map<number, any[]>()

  /** 变量池 - 节点间数据传递 */
  readonly variablePool: VariablePool
  /** 图引擎 - 拓扑排序与依赖分析 */
  private graphEngine: GraphEngine
  /** 节点执行器注册表 - 替代 switch/case */
  private executorRegistry: NodeExecutorRegistry
  
  constructor(workflowData: WorkflowData, store: any, callbacks: ExecutionCallback = {}) {
    this.workflowData = workflowData
    this.store = store
    this.callbacks = callbacks
    // 使用传入的国际化函数或默认返回 key
    this.t = callbacks.t || ((key: string) => key)
    this.variablePool = new VariablePool()
    this.graphEngine = new GraphEngine(workflowData.items, workflowData.links)
    this.executorRegistry = createExecutorRegistry()
  }
  
  // 获取是否正在运行
  get isRunning(): boolean {
    return this._isRunning
  }
  
  // 获取执行日志
  get logs(): Array<{message: string, level: 'info' | 'warning' | 'error', timestamp: Date}> {
    return this.executionLogs
  }
  
  // 获取节点执行顺序
  get executionOrder(): number[] {
    return this.nodeExecutionOrder
  }
  
  // 设置工作流数据
  setWorkflowData(data: WorkflowData): void {
    this.workflowData = data
    this.graphEngine.update(data.items, data.links)
  }
  
  // 设置起始节点输入
  setStartNodeInput(inputText: string): boolean {
    const startNode = this.workflowData.items.find(item => item.type === 'start')
    if (!startNode) {
      this.log('未找到开始节点', 'error')
      return false
    }
    
    startNode.prompt = inputText
    return true
  }
  
  // 运行工作流
  async run(inputText?: string, options?: { resume?: boolean }): Promise<{
    success: boolean
    result: string
    aggregatedResults: Record<string, any>
    executionStats: {
      totalNodes: number
      completedNodes: number
      failedNodes: number
      errors: Array<{nodeId: number, nodeName: string, error: string}>
      decisionPaths: Map<number, string>
      executionTime: number
      executedNodes: number[]
      executionOrder: number[]
    }
  }> {
    if (this._isRunning) {
      throw new Error('工作流正在运行中')
    }
    
    this._isRunning = true
    this.currentStep = 0
    this.executionLogs = []
    this.executedNodes.clear()
    this.nodeExecutionOrder = []
    this.decisionPaths.clear()
    this.decisionDataTemplates.clear()
    this.accumulators.clear()
    this.dataCache.clear()
    this.arrayCache.clear()
    
    const startTime = Date.now()
    const errors: Array<{nodeId: number, nodeName: string, error: string}> = []
    
    // 创建中止控制器
    this.abortController = new AbortController()
    
    try {
      if (options?.resume) {
        // ===== 继续执行模式：跳过已成功节点，仅执行未完成节点 =====
        this.variablePool.clear()
        let skipped = 0
        for (const node of this.workflowData.items) {
          // 有断点的迭代节点不跳过（即使曾标 success），由执行器从断点续跑；
          // 数据(CSV)节点不跳过：其全量行在运行期 dataCache（run 开头已清空），跳过会导致
          // 迭代/列表续跑时输入只剩预览行（node.result 只存 preview），必须重新执行重建全量缓存
          if (node.status === 'success' && node.result && !node._iterResume && node.type !== 'data') {
            // 标记为已执行，后续 executeSingleNodeWithDependencies 会自动跳过
            this.executedNodes.add(node.id)
            this.nodeExecutionOrder.push(node.id)
            // 将缓存结果预填到变量池，供下游节点取用
            this.syncResultToVariablePool(node)
            // 恢复决策分支路径，避免执行未选中的分支
            if (node.type === 'decision') {
              try {
                const p = JSON.parse(node.result)
                if (p && p.selectedBranch) {
                  this.decisionPaths.set(node.id, p.selectedBranch)
                  const br = node.decisionBranches?.find(b => b.id === p.selectedBranch)
                  if (br?.dataTemplate) this.decisionDataTemplates.set(node.id, br.dataTemplate)
                }
              } catch { /* 忽略解析失败 */ }
            }
            skipped++
          } else {
            // 未完成/失败的节点重置为待执行状态
            node.status = 'idle'
            node.result = this.getWaitingText(node.type)
            this.callbacks.onNodeStatusUpdate?.(node.id, 'idle', node.result)
          }
        }
        this.log(`继续执行：跳过 ${skipped} 个已完成节点`, 'info')
      } else {
        // 重置所有节点状态
        this.resetNodes()
        // 清空变量池
        this.variablePool.clear()
      }
      
      // 设置起始节点输入（如果提供了）
      if (inputText) {
        if (!this.setStartNodeInput(inputText)) {
          throw new Error('设置起始节点输入失败')
        }
      }
      
      // 使用 GraphEngine 验证工作流
      const validation = this.graphEngine.validate()
      if (!validation.valid) {
        const msg = validation.errors.join('; ')
        this.log(`工作流验证失败: ${msg}`, 'error')
        throw new Error(`工作流验证失败: ${msg}`)
      }
      validation.warnings.forEach(w => this.log(w, 'warning'))
      
      // 找到开始节点
      const startNode = this.workflowData.items.find(item => item.type === 'start')
      if (!startNode) {
        throw new Error('未找到开始节点')
      }
      
      // 使用 GraphEngine 制定执行计划
      const plan = this.graphEngine.planExecution(startNode.id, this.decisionPaths)
      for (const w of plan.warnings) this.log(w, 'warning')
      
      if (plan.order.length === 0) {
        throw new Error('无法生成执行计划')
      }
      
      this.log(`开始执行工作流，执行计划: ${plan.order.length} 个节点`, 'info')
      this.log(`执行顺序: ${plan.order.map(id => {
        const node = this.workflowData.items.find(n => n.id === id)
        return node ? `${node.name}(${id})` : `${id}`
      }).join(' -> ')}`, 'info')
      
      this.callbacks.onProgress?.(0, plan.order.length, '准备开始')
      
      // 按执行计划依次执行节点
      let success = true
      for (const nodeId of plan.order) {
        // 检查是否被中止
        if (this.abortController?.signal.aborted) {
          success = false
          break
        }
        
        const nodeSuccess = await this.executeSingleNodeWithDependencies(nodeId)
        if (!nodeSuccess) {
          success = false
          break
        }
      }
      
      // 计算执行统计
      const completedNodes = this.workflowData.items.filter(n => n.status === 'success').length
      const failedNodes = this.workflowData.items.filter(n => n.status === 'error').length
      
      // 收集错误信息
      this.workflowData.items.forEach(node => {
        if (node.status === 'error') {
          const error = extractErrorFromResult(node.result)
          errors.push({
            nodeId: node.id,
            nodeName: node.name,
            error: error
          })
          
          // Python节点特殊处理
          if (node.type === 'python') {
            const errorInfo = extractPythonErrorInfo(node.result)
            this.callbacks.onPythonError?.(node.id, node.name, errorInfo.error, errorInfo.traceback)
          }
        }
      })
      
      // 获取最终结果（从变量池汇总）
      let finalResult = ''
      let aggregatedResults: Record<string, any> = {}
      
      const endNode = this.workflowData.items.find(item => item.type === 'end')
      if (endNode && endNode.status === 'success') {
        const endOutput = this.variablePool.getNodeOutputs(endNode.id)
        if (endOutput) {
          finalResult = endOutput.result || ''
          aggregatedResults = endOutput.aggregated_results || {}
        }
      }
      
      const executionTime = Date.now() - startTime
      const executionStats = {
        totalNodes: this.workflowData.items.length,
        completedNodes: completedNodes,
        failedNodes: failedNodes,
        errors: errors,
        decisionPaths: this.decisionPaths,
        executionTime: executionTime,
        executedNodes: Array.from(this.executedNodes),
        executionOrder: this.nodeExecutionOrder
      }
      
      const overallSuccess = success && failedNodes === 0
      
      this.log(`工作流执行${overallSuccess ? '成功' : '失败'}，耗时: ${executionTime}ms`, overallSuccess ? 'info' : 'error')
      this.callbacks.onComplete?.(overallSuccess, finalResult, aggregatedResults)
      
      return {
        success: overallSuccess,
        result: finalResult,
        aggregatedResults,
        executionStats
      }
      
    } catch (error: any) {
      this.log(`工作流执行异常: ${error.message}`, 'error')
      
      return {
        success: false,
        result: `工作流执行失败: ${error.message}`,
        aggregatedResults: {},
        executionStats: {
          totalNodes: this.workflowData.items.length,
          completedNodes: this.currentStep,
          failedNodes: errors.length + 1,
          errors: [...errors, {nodeId: -1, nodeName: '系统', error: error.message}],
          decisionPaths: this.decisionPaths,
          executionTime: Date.now() - startTime,
          executedNodes: Array.from(this.executedNodes),
          executionOrder: this.nodeExecutionOrder
        }
      }
    } finally {
      this._isRunning = false
      this.abortController = null
    }
  }

  /**
   * 将节点运行结果同步到变量池
   * 在每个 run*Node 方法设置 node.result 后调用此方法
   */
  private syncResultToVariablePool(node: NodeData): void {
    try {
      const parsed = JSON.parse(node.result)
      if (typeof parsed === 'object' && parsed !== null) {
        this.variablePool.setAll(node.id, parsed)
      } else {
        this.variablePool.set(node.id, 'result', node.result)
      }
    } catch {
      this.variablePool.set(node.id, 'result', node.result)
    }
  }
  
  // 执行所有可达节点（使用 GraphEngine）
  private async executeAllReachableNodes(startNodeId: number): Promise<{ success: boolean; executedNodes: number[] }> {
    const plan = this.graphEngine.planExecution(startNodeId, this.decisionPaths)
    for (const w of plan.warnings) this.log(w, 'warning')
    
    if (plan.order.length === 0) {
      return { success: false, executedNodes: [] }
    }
    
    const executedNodes: number[] = []
    let success = true
    
    for (const nodeId of plan.order) {
      if (this.abortController?.signal.aborted) {
        success = false
        break
      }
      const nodeSuccess = await this.executeSingleNodeWithDependencies(nodeId)
      executedNodes.push(nodeId)
      if (!nodeSuccess) {
        success = false
        break
      }
    }
    
    return { success, executedNodes }
  }
  
  // 带依赖检查的节点执行 - 使用 GraphEngine 进行依赖分析
  private async executeSingleNodeWithDependencies(nodeId: number): Promise<boolean> {
    const node = this.workflowData.items.find(item => item.id === nodeId)
    if (!node) return false
    
    // 检查节点是否已经执行过
    if (this.executedNodes.has(nodeId)) {
      return node.status === 'success'
    }
    
    // 检查是否被中止
    if (this.abortController?.signal.aborted) {
      return false
    }
    
    // 开始节点没有前置依赖，可以直接执行
    if (node.type === 'start') {
      return await this.executeSingleNode(nodeId)
    }
    
    // 使用 GraphEngine 获取前置依赖
    const predecessors = this.graphEngine.getPredecessors(nodeId, this.decisionPaths)
    
    if (predecessors.length === 0) {
      // 没有输入连接的节点可以直接执行
      return await this.executeSingleNode(nodeId)
    }
    
    // 检查每个前置依赖节点是否都已执行
    for (const sourceId of predecessors) {
      const sourceNode = this.workflowData.items.find(n => n.id === sourceId)
      
      // 如果源节点还没有执行，先执行它
      if (!this.executedNodes.has(sourceId)) {
        const sourceSuccess = await this.executeSingleNodeWithDependencies(sourceId)
        if (!sourceSuccess) {
          this.log(`节点 ${node.name} 的前置节点 ${sourceNode?.name || sourceId} 执行失败`, 'error')
          return false
        }
      }
    }
    
    // 所有必要的前置节点都已执行，执行当前节点
    return await this.executeSingleNode(nodeId)
  }
  
  // 停止工作流
  stop(): void {
    if (this.abortController) {
      this.abortController.abort()
    }
    this._isRunning = false
  }
  
  // 获取当前执行状态
  getExecutionStatus(): {
    isRunning: boolean
    currentStep: number
    totalSteps: number
    currentNode?: string
    progress: number
    activeDecisionPaths: Map<number, string>
    executionOrder: number[]
  } {
    return {
      isRunning: this._isRunning,
      currentStep: this.currentStep,
      totalSteps: this.workflowData.items.length,
      currentNode: undefined,
      progress: this.workflowData.items.length > 0 ? 
        (this.currentStep / this.workflowData.items.length) * 100 : 0,
      activeDecisionPaths: this.decisionPaths,
      executionOrder: this.nodeExecutionOrder
    }
  }
  
  // 获取工作流错误信息
  getErrors(): Array<{nodeId: number, nodeName: string, error: string}> {
    const errors: Array<{nodeId: number, nodeName: string, error: string}> = []
    
    this.workflowData.items.forEach(node => {
      if (node.status === 'error') {
        errors.push({
          nodeId: node.id,
          nodeName: node.name,
          error: extractErrorFromResult(node.result)
        })
      }
    })
    
    return errors
  }
  
  // 执行单个节点
  async executeSingleNode(nodeId: number): Promise<boolean> {
    const node = this.workflowData.items.find(item => item.id === nodeId)
    if (!node) return false
    
    // 检查节点是否正在运行
    if (node.status === 'running') {
      this.log(`节点 ${node.name} 正在运行中，请稍后`, 'warning')
      return false
    }
    
    // 检查是否被中止
    if (this.abortController?.signal.aborted) {
      return false
    }
    
    // 保存原始运行状态
    const wasRunning = this._isRunning
    const oldAbortController = this.abortController
    
    try {
      // 临时设置运行状态
      this._isRunning = true
      this.abortController = new AbortController()
      
      // 更新节点状态为运行中
      node.status = 'running'
      this.callbacks.onNodeStatusUpdate?.(node.id, 'running', node.result)
      this.callbacks.onNodeStart?.(node.id, node.name, node.type)
      
      // 直接执行节点逻辑，不经过 executeNode（避免 executedNodes 检查）
      const success = await this.executeNodeDirect(node)
      
      if (success) {
        // 将结果同步到变量池
        this.syncResultToVariablePool(node)
        
        // 更新 executedNodes 记录（用于工作流整体运行时的依赖追踪）
        this.executedNodes.add(nodeId)
        // 确保节点顺序记录
        if (!this.nodeExecutionOrder.includes(nodeId)) {
          this.nodeExecutionOrder.push(nodeId)
        }
      }
      
      return success
      
    } catch (error: any) {
      node.status = 'error'
      node.result = JSON.stringify({
        error: error.message,
        type: node.type,
        timestamp: new Date().toISOString()
      })
      this.syncResultToVariablePool(node)
      this.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      this.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      this.callbacks.onSaveWorkflow?.()
      return false
      
    } finally {
      // 恢复原始运行状态
      this._isRunning = wasRunning
      if (oldAbortController) {
        this.abortController = oldAbortController
      } else {
        this.abortController = null
      }
    }
  }

  /** 构建节点执行上下文（支持内层子图覆盖：pool/workflowData/callbacks/extraNodes） */
  private createExecutionContext(overrides?: {
    variablePool?: VariablePool
    workflowData?: WorkflowData
    callbacks?: ExecutionCallback
    /** 解析模板时额外可引用的节点（如迭代节点自身，供 {{迭代节点.item}}） */
    extraNodes?: Array<{ id: number; name: string; type: string }>
  }): ExecutionContext {
    const pool = overrides?.variablePool || this.variablePool
    const wfData = overrides?.workflowData || this.workflowData
    const cbs = overrides?.callbacks || this.callbacks
    const resolveNodes: Array<{ id: number; name: string; type: string }> = [
      ...(overrides?.extraNodes || []),
      ...wfData.items,
    ]
    return {
      store: this.store,
      variablePool: pool,
      workflowData: wfData,
      callbacks: cbs,
      abortController: this.abortController,
      decisionPaths: this.decisionPaths,
      decisionDataTemplates: this.decisionDataTemplates,
      t: (key: string) => this.t(key),
      log: (msg, lvl) => this.log(msg, lvl),
      getNodeContextWithPorts: (nodeId, _dp) => this.getNodeContextWithPorts(nodeId, pool, wfData),
      getSourceNodeData: (sourceNodeId, sourcePort, targetNodeId, _dp, _ddt) =>
        this.getSourceNodeData(sourceNodeId, sourcePort, targetNodeId, pool, wfData),
      getUpstreamDataWithPorts: (nodeId) => this.getUpstreamDataWithPorts(nodeId, pool, wfData),
      getAllUpstreamQueryTextWithPorts: (nodeId) => this.getAllUpstreamQueryTextWithPorts(nodeId, pool, wfData),
      safeIpcInvoke: (channel, ...args) => this.safeIpcInvoke(channel, ...args),
      connectMcpNode: (nodeId) => this.connectMcpNode(nodeId),
      validateModelConfig: (node) => validateModelConfig(node, this.store, (k) => this.t(k)),
      syncResultToVariablePool: (node) => this.syncResultToVariablePool(node),
      sendToAI: (messages: any[], options: any) => {
        if (!this.store.sendToAI) throw new Error('store.sendToAI 不存在')
        return this.store.sendToAI(messages, options)
      },
      readFile: (filePath) => window.ipcRenderer.invoke('readFile', filePath),
      resolveTemplate: (template: string, currentNodeId?: number) =>
        resolveTemplate(template, resolveNodes, pool, currentNodeId),
      getAccumulator: (nodeId) => this.getAccumulator(nodeId),
      setAccumulator: (nodeId, value) => this.setAccumulator(nodeId, value),
      resolveTemplateRaw: (template, currentNodeId) => {
        const r = resolveTemplateRawImpl(template, resolveNodes, pool, currentNodeId)
        if (!r || !r.found || !r.node || r.selfRef) return undefined
        // 数据节点全量行/批次：优先返回运行期缓存（避免 10 万行 JSON 字符串化/反序列化）
        if (r.node.type === 'data') {
          const cached = this.dataCache.get(r.node.id)
          if (cached) {
            if (r.path.length === 1 && r.path[0] === 'rows' && Array.isArray(cached.rows)) return cached.rows
            if (r.path.length === 1 && r.path[0] === 'batches' && Array.isArray(cached.batches)) return cached.batches
          }
        }
        // 迭代/列表等数组节点：output 字段优先返回全量缓存
        if (r.path.length === 1 && r.path[0] === 'output') {
          const cachedArr = this.arrayCache.get(r.node.id)
          if (Array.isArray(cachedArr)) return cachedArr
        }
        return r.value
      },
      setDataCache: (nodeId, data) => this.setDataCache(nodeId, data),
      getDataCache: (nodeId) => this.getDataCache(nodeId),
      setArrayCache: (nodeId, arr) => this.setArrayCache(nodeId, arr),
      getArrayCache: (nodeId) => this.getArrayCache(nodeId),
      /** 代码场景模板解析：所有 {{表达式}} 替换为 JSON 字面量；数组字段优先全量缓存 */
      resolveTemplateForCode: (template, currentNodeId) => {
        const rawToJson = (expr: string): string | null => {
          const trimmed = expr.trim()
          const [nodeName, ...keyParts] = trimmed.split(/[.|]/).map((s: string) => s.trim())
          const n2 = nodeName.replace(/\s+/g, '').toLowerCase()
          const node = resolveNodes.find(n => n.name === nodeName)
            || resolveNodes.find(n => n.name.toLowerCase() === nodeName.toLowerCase())
            || resolveNodes.find(n => n.name.replace(/\s+/g, '').toLowerCase() === n2)
            || (/^\d+$/.test(nodeName) ? resolveNodes.find(n => n.id === parseInt(nodeName)) : undefined)
          if (!node) return null
          if (currentNodeId !== undefined && node.id === currentNodeId) return null
          const path = keyParts.length > 0 ? keyParts : ['result']
          // 数组字段：优先全量缓存
          if (path.length === 1 && path[0] === 'output') {
            const cachedArr = this.arrayCache.get(node.id)
            if (Array.isArray(cachedArr)) return JSON.stringify(cachedArr)
          }
          const output = pool.getNodeOutputs(node.id)
          if (!output) return null
          let value: any = output
          for (const p of path) {
            if (value && typeof value === 'object' && p in value) value = value[p]
            else return null
          }
          if (value === null || value === undefined) return 'null'
          try { return JSON.stringify(value) } catch { return null }
        }
        return template.replace(/\{\{([^}]+)\}\}/g, (match, expr: string) => rawToJson(expr) ?? match)
      },
      runInnerGraph: (innerItems, innerLinks, seed, opts) =>
        this.runInnerGraph(innerItems, innerLinks, seed, opts),
    }
  }

  /** 获取累加器（变量聚合节点跨迭代累计） */
  getAccumulator(nodeId: number): any[] | undefined {
    return this.accumulators.get(nodeId)
  }

  /** 设置累加器 */
  setAccumulator(nodeId: number, value: any[]): void {
    this.accumulators.set(nodeId, value)
  }

  /** 数据节点全量数据缓存（run 级） */
  setDataCache(nodeId: number, data: { rows: any[]; batches?: any[][]; headers: string[]; total: number }): void {
    this.dataCache.set(nodeId, data)
  }

  getDataCache(nodeId: number): { rows: any[]; batches?: any[][]; headers: string[]; total: number } | undefined {
    return this.dataCache.get(nodeId)
  }

  /** 数组节点全量输出缓存（迭代/列表 output 全量，node.result 只留预览） */
  setArrayCache(nodeId: number, arr: any[]): void {
    this.arrayCache.set(nodeId, arr)
  }

  getArrayCache(nodeId: number): any[] | undefined {
    return this.arrayCache.get(nodeId)
  }

  /**
   * 运行内部子图（迭代/循环容器内部流水线）
   * 每次运行克隆内部节点（并发安全）；seed 以 nodeId 预置变量（如迭代 item/index）。
   */
  private async runInnerGraph(
    innerItems: NodeData[],
    innerLinks: Link[],
    seed: Record<number, Record<string, any>> = {},
    opts: {
      startNodeId?: number
      extraNodes?: Array<{ id: number; name: string; type: string }>
      /** 内层节点出错时如何处理；默认 terminated（中断），continue_with_error_inject 会注入错误并继续 */
      errorMode?: 'terminated' | 'continue_with_error' | 'continue_with_error_inject' | 'remove_abnormal_output'
    } = {}
  ): Promise<{
    success: boolean
    outputs: Record<number, Record<string, any>>
    order: number[]
    failedNodeId?: number
    failedNodeName?: string
    error?: string
    failedCount: number
    failedNodes: Array<{ nodeId: number; nodeName: string; error: string }>
  }> {
    if (!innerItems || innerItems.length === 0) {
      return { success: false, outputs: {}, order: [], failedCount: 0, failedNodes: [] }
    }
    const clonedItems: NodeData[] = JSON.parse(JSON.stringify(innerItems))
    const clonedLinks: Link[] = JSON.parse(JSON.stringify(innerLinks || []))
    const innerPool = new VariablePool()
    for (const [nid, outs] of Object.entries(seed || {})) {
      innerPool.setAll(Number(nid), outs)
    }

    const engine = new GraphEngine(clonedItems, clonedLinks)
    let startId = opts?.startNodeId
    if (startId === undefined) {
      startId = clonedItems.find(n => n.type === 'start')?.id
    }
    if (startId === undefined) {
      startId = clonedItems.find(n => !clonedLinks.some(l => l.target === n.id))?.id
    }
    if (startId === undefined) {
      startId = clonedItems[0]?.id
    }
    const plan = engine.planExecution(startId)
    if (plan.order.length === 0) {
      return { success: false, outputs: {}, order: [], failedCount: 0, failedNodes: [] }
    }

    const noopCallbacks: ExecutionCallback = {}
    const outputs: Record<number, Record<string, any>> = {}
    const execCtx = this.createExecutionContext({
      variablePool: innerPool,
      workflowData: { items: clonedItems, links: clonedLinks },
      callbacks: noopCallbacks,
      extraNodes: opts?.extraNodes || [],
    })

    const innerErrorMode = opts?.errorMode || 'terminated'
    const injectOnError = innerErrorMode === 'continue_with_error_inject'
    let success = true
    let failedNodeId: number | undefined
    let failedNodeName: string | undefined
    let failError: string | undefined
    const failedNodes: Array<{ nodeId: number; nodeName: string; error: string }> = []

    for (const nodeId of plan.order) {
      if (this.abortController?.signal.aborted) { success = false; failError = 'aborted'; break }
      const node = clonedItems.find(n => n.id === nodeId)
      if (!node) continue
      if (node.type === 'start') {
        innerPool.set(node.id, 'result', node.prompt || '')
        continue
      }

      // 处理内层节点失败：inject 模式注入错误并继续；否则中断（由迭代决定终止/跳过）
      const handleFailure = (errText: string): boolean => {
        failedNodes.push({ nodeId: node.id, nodeName: node.name, error: errText })
        if (!injectOnError) {
          success = false
          failedNodeId = node.id
          failedNodeName = node.name
          failError = errText
          return false
        }
        // 注入错误到该节点输出（status 置 success 使下游上下文也能取到），继续执行后续节点
        node.status = 'success'
        innerPool.set(node.id, 'result', `[${this.t('node_failed')} ${node.type}] ${errText || this.t('unknown_error')}`)
        innerPool.set(node.id, 'success', false)
        innerPool.set(node.id, 'error', errText)
        outputs[node.id] = innerPool.getNodeOutputs(node.id) || {}
        return true
      }

      try {
        const executor = this.executorRegistry.get(node.type)
        node.status = 'running'
        const ok = await executor.execute(node, execCtx)
        if (ok) {
          try {
            const parsed = JSON.parse(node.result || '')
            if (parsed && typeof parsed === 'object') innerPool.setAll(node.id, parsed)
            else innerPool.set(node.id, 'result', node.result)
          } catch {
            innerPool.set(node.id, 'result', node.result)
          }
        }
        outputs[node.id] = innerPool.getNodeOutputs(node.id) || {}
        if (!ok) {
          let errText = ''
          try {
            const p = JSON.parse(node.result || '')
            errText = (p && typeof p === 'object' && (p.error || p.result)) ? String(p.error || p.result) : (node.result || '')
          } catch {
            errText = node.result || ''
          }
          errText = String(errText).slice(0, 300)
          if (!handleFailure(errText)) break
        }
      } catch (e: any) {
        node.status = 'error'
        node.result = JSON.stringify({ error: String(e?.message || e), type: node.type })
        const errText = String(e?.message || e).slice(0, 300)
        if (!handleFailure(errText)) break
      }
    }
    return {
      success,
      outputs,
      order: plan.order,
      failedNodeId,
      failedNodeName,
      error: failError,
      failedCount: failedNodes.length,
      failedNodes,
    }
  }

  // 直接执行节点逻辑的方法（通过执行器注册表分发）
  private async executeNodeDirect(node: NodeData): Promise<boolean> {
    try {
      const executor = this.executorRegistry.get(node.type)
      const ctx = this.createExecutionContext()
      const success = await executor.execute(node, ctx)
      
      if (success) {
        // 同步结果到变量池
        this.syncResultToVariablePool(node)
        this.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'success', node.result)
        this.callbacks.onSaveWorkflow?.()
      }
      
      return success
      
    } catch (error: any) {
      node.status = 'error'
      node.result = JSON.stringify({
        error: error.message,
        type: node.type,
        timestamp: new Date().toISOString()
      })
      this.syncResultToVariablePool(node)
      this.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      this.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      this.callbacks.onSaveWorkflow?.()
      return false
    }
  }
  
  // MCP节点专用方法
  /** 解析 MCP 节点运行所需配置：server 模式从设置中取服务配置并共享连接；inline 模式用节点内联配置 */
  private resolveMcpNodeRuntime(node: any): { config: any; serverId?: string } {
    const cfg = node?.mcpConfig
    if (!cfg) return { config: undefined }
    if (cfg.mode === 'server' && cfg.serverId) {
      const server = (this.store?.mcpServers || []).find((s: any) => s.id === cfg.serverId && s.enabled !== false)
      if (server) {
        return { config: server, serverId: server.id }
      }
    }
    return { config: cfg }
  }

  async testMcpConnection(nodeId: number): Promise<{ success: boolean; error?: string; tools?: McpTool[] }> {
    const node = this.workflowData.items.find(item => item.id === nodeId)
    if (!node || !node.mcpConfig) {
      return { success: false, error: '节点或MCP配置不存在' }
    }

    const { config } = this.resolveMcpNodeRuntime(node)
    if (!config) {
      return { success: false, error: 'MCP服务配置不存在' }
    }

    try {
      return await mcpManager.testConnection(config)
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  }

  async connectMcpNode(nodeId: number): Promise<boolean> {
    const node = this.workflowData.items.find(item => item.id === nodeId)
    if (!node || !node.mcpConfig) {
      this.log(`MCP节点 ${nodeId} 配置不存在`, 'error')
      return false
    }

    try {
      const { config, serverId } = this.resolveMcpNodeRuntime(node)
      if (!config) {
        this.log(`MCP节点 ${node.name} 引用的服务配置不存在`, 'error')
        return false
      }
      const success = await mcpManager.connect(nodeId, config, serverId)
      if (success) {
        node.mcpConnected = true
        node.mcpTools = mcpManager.getTools(nodeId, serverId)
        this.callbacks.onMcpStatusChange?.(nodeId, true, node.mcpTools)
        this.log(`MCP节点 ${node.name} 连接成功，工具数量: ${node.mcpTools?.length || 0}`, 'info')
      }
      return success
    } catch (error: any) {
      this.log(`MCP节点连接失败: ${error.message}`, 'error')
      return false
    }
  }

  async disconnectMcpNode(nodeId: number): Promise<void> {
    try {
      const node = this.workflowData.items.find(item => item.id === nodeId)
      const serverId = node?.mcpConfig?.mode === 'server' ? node.mcpConfig.serverId : undefined
      await mcpManager.disconnect(nodeId, serverId)
      if (node) {
        node.mcpConnected = false
        this.callbacks.onMcpStatusChange?.(nodeId, false)
        this.log(`MCP节点 ${node.name} 已断开连接`, 'info')
      }
    } catch (error: any) {
      this.log(`断开MCP连接失败: ${error.message}`, 'error')
    }
  }

  async refreshMcpTools(nodeId: number): Promise<McpTool[]> {
    try {
      const node = this.workflowData.items.find(item => item.id === nodeId)
      const { config, serverId } = this.resolveMcpNodeRuntime(node)
      if (!config) return []
      const tools = await mcpManager.refreshTools(nodeId, config, serverId)
      if (node) {
        node.mcpTools = tools
        this.callbacks.onMcpStatusChange?.(nodeId, true, tools)
      }
      return tools
    } catch (error: any) {
      this.log(`刷新MCP工具失败: ${error.message}`, 'error')
      return []
    }
  }

  async callMcpTool(nodeId: number, toolName: string, arguments_: Record<string, any> = {}): Promise<any> {
    try {
      const node = this.workflowData.items.find(item => item.id === nodeId)
      const serverId = node?.mcpConfig?.mode === 'server' ? node.mcpConfig.serverId : undefined
      return await mcpManager.callTool(nodeId, toolName, arguments_, serverId)
    } catch (error: any) {
      throw new Error(`调用MCP工具失败: ${error.message}`)
    }
  }
  
  // 私有方法
  private log(message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    const logEntry = {
      message,
      level,
      timestamp: new Date()
    }
    this.executionLogs.push(logEntry)
    
    console.log(`[WorkflowRunner ${level.toUpperCase()}] ${message}`)
    this.callbacks.onLog?.(message, level)
  }
  
  /** 获取节点等待状态文本（含开始/结束节点） */
  private getWaitingText(type: NodeType): string {
    const waitingTextMap: Record<NodeType, string> = {
      'text': this.t('waiting'),
      'local': this.t('waiting'),
      'web': this.t('waiting_search'),
      'webpage': this.t('waiting_fetch'),
      'reasoning': this.t('waiting_reasoning'),
      'decision': this.t('waiting_decision'),
      'python': this.t('waiting_execute'),
      'knowledge': this.t('waiting_retrieval'),
      'structured': this.t('waiting_structured'),
      'mcp': this.t('waiting'),
      'subflow': this.t('waiting'),
      'iteration': this.t('waiting_iteration'),
      'aggregator': this.t('waiting_aggregator'),
      'list': this.t('waiting_list'),
      'data': this.t('waiting_data'),
      'agent': this.t('waiting_agent'),
      'word': this.t('waiting_word'),
      'start': this.t('waiting_start'),
      'end': this.t('waiting_end')
    }
    return waitingTextMap[type] || this.t('waiting')
  }

  public resetNodes(): void {
    this.workflowData.items.forEach(node => {
      node.status = 'idle'
      node.result = this.getWaitingText(node.type)
      // 全新运行：清除迭代断点，避免误用旧的续跑进度
      delete node._iterResume
      this.callbacks.onNodeStatusUpdate?.(node.id, 'idle', node.result)
    })
    
    // 重置后将现有结果导入变量池（兼容旧数据）
    this.variablePool.importFromNodeResults(this.workflowData.items)
  }
  
  // 使用 GraphEngine 进行验证
  private validateWorkflow(): boolean {
    const result = this.graphEngine.validate()
    for (const e of result.errors) this.log(e, 'error')
    for (const w of result.warnings) this.log(w, 'warning')
    return result.valid
  }
  
  // 使用 GraphEngine 检测循环依赖
  private hasCycleWithDecisions(): boolean {
    return this.graphEngine.detectCycle()
  }
  
  private async executeNode(nodeId: number): Promise<boolean> {
    const node = this.workflowData.items.find(item => item.id === nodeId)
    if (!node) return false

    // 检查节点是否已经执行过
    if (this.executedNodes.has(nodeId)) {
      return node.status === 'success'
    }

    node.status = 'running'
    this.callbacks.onNodeStatusUpdate?.(node.id, 'running', node.result)
    this.callbacks.onNodeStart?.(node.id, node.name, node.type)

    try {
      const executor = this.executorRegistry.get(node.type)
      const ctx = this.createExecutionContext()
      const success = await executor.execute(node, ctx)
      if (success) this.syncResultToVariablePool(node)
      return success
    } catch (error: any) {
      node.status = 'error'
      node.result = JSON.stringify({
        error: error.message,
        type: node.type,
        timestamp: new Date().toISOString()
      })
      this.syncResultToVariablePool(node)
      this.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      this.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }
  }
  
  // 支持端口的节点上下文获取方法（支持内层子图：pool/wfData）
  private async getNodeContextWithPorts(
    nodeId: number,
    pool: VariablePool = this.variablePool,
    wfData: WorkflowData = this.workflowData
  ): Promise<string[]> {
    const sourceLinks = wfData.links.filter(link => link.target === nodeId)
    const contexts: string[] = []
    
    for (const link of sourceLinks) {
      const sourceNode = wfData.items.find(n => n.id === link.source)
      if (!sourceNode) continue
      
      // 关键修改：检查节点状态是否为成功，而不是检查 executedNodes
      if (sourceNode.status !== 'success') {
        continue
      }
      
      // 获取源节点的数据（考虑端口），传入目标节点ID
      const nodeData = this.getSourceNodeData(sourceNode.id, link.sourcePort, nodeId, pool, wfData)
      if (nodeData !== null && nodeData !== undefined) {
        contexts.push(String(nodeData))
      }
    }
    
    return contexts
  }
  
  private getSourceNodeData(
    sourceNodeId: number,
    sourcePort?: string,
    targetNodeId?: number,
    pool: VariablePool = this.variablePool,
    wfData: WorkflowData = this.workflowData
  ): any {
    // 优先从变量池获取数据
    const poolOutput = pool.getNodeOutputs(sourceNodeId)
    if (poolOutput) {
      // 本地文件节点且有端口连接
      const sourceNode = wfData.items.find(n => n.id === sourceNodeId)
      if (sourceNode?.type === 'local' && sourceNode.fileMode === 'template') {
        const portData = poolOutput[`port:${sourcePort}`]
        if (portData !== undefined && portData !== null && portData !== '') {
          return portData
        }
        if (poolOutput.slices && sourcePort && poolOutput.slices[sourcePort]) {
          return poolOutput.slices[sourcePort]
        }
      }
      
      // 决策节点 - 应用数据模板
      if (sourceNode?.type === 'decision') {
        let inputData = ''
        if (poolOutput.inputPreview) {
          inputData = poolOutput.inputPreview
        } else if (poolOutput.result) {
          inputData = typeof poolOutput.result === 'string' 
            ? poolOutput.result 
            : JSON.stringify(poolOutput.result)
        }
        const dataTemplate = this.decisionDataTemplates.get(sourceNodeId) || '{input}'
        const processedData = applyDataTemplate(dataTemplate, {
          input: inputData,
          branchId: this.decisionPaths.get(sourceNodeId) || '',
          branchName: poolOutput.selectedBranchName || '',
          result: poolOutput.result
        })
        return processedData
      }
      
      // 开始节点的端口
      if (sourceNode?.type === 'start' && poolOutput.outputByPort && sourcePort) {
        return poolOutput.outputByPort[sourcePort] ?? null
      }
      
      return poolOutput.result ?? JSON.stringify(poolOutput)
    }
    
    // 回退：从 node.result 解析（兼容旧数据）
    const sourceNode = wfData.items.find(n => n.id === sourceNodeId)
    if (!sourceNode || !sourceNode.result) {
      return null
    }
    
    try {
      const parsed = JSON.parse(sourceNode.result)
      
      // 特殊处理决策节点 - 应用数据模板
      if (sourceNode.type === 'decision') {
        let inputData = ''
        if (parsed.inputPreview) {
          inputData = parsed.inputPreview
        } else if (parsed.result) {
          inputData = typeof parsed.result === 'string' 
            ? parsed.result 
            : JSON.stringify(parsed.result)
        }
        const dataTemplate = this.decisionDataTemplates.get(sourceNodeId) || '{input}'
        let processedData = applyDataTemplate(dataTemplate, {
          input: inputData,
          branchId: this.decisionPaths.get(sourceNodeId) || '',
          branchName: parsed.selectedBranchName || '',
          result: parsed.result
        })
        return processedData
      }
      
      // 本地文件节点且有端口连接
      if (sourceNode.type === 'local' && sourceNode.fileMode === 'template') {
        if (parsed.outputByPort && sourcePort) {
          const portData = parsed.outputByPort[sourcePort]
          if (portData !== undefined && portData !== null && portData !== '') {
            return portData
          }
        }
        if (parsed.slices && sourcePort && parsed.slices[sourcePort]) {
          return parsed.slices[sourcePort]
        }
      }
      
      // 开始节点的特殊处理
      if (sourceNode.type === 'start' && parsed.outputByPort && sourcePort) {
        const portData = parsed.outputByPort[sourcePort]
        if (portData !== undefined && portData !== null) {
          return portData
        }
      }
      
      // 其他类型的节点或者没有端口信息，返回默认结果
      if (parsed.result !== undefined) {
        return parsed.result
      }
      
      return parsed
      
    } catch {
      return sourceNode.result
    }
  }

  // 应用数据模板的方法（支持内层子图）
  private getUpstreamDataWithPorts(
    nodeId: number,
    pool: VariablePool = this.variablePool,
    wfData: WorkflowData = this.workflowData
  ): any {
    const sourceLinks = wfData.links.filter(link => link.target === nodeId)
    
    if (sourceLinks.length === 0) {
      return null
    }
    
    const upstreamData: Record<string, any> = {}
    
    for (const link of sourceLinks) {
      const sourceNode = wfData.items.find(n => n.id === link.source)
      if (!sourceNode || !sourceNode.result) continue
      
      // 关键修改：检查节点状态是否为成功
      if (sourceNode.status !== 'success') {
        continue
      }
      
      const key = `node_${sourceNode.id}${link.sourcePort ? '_' + link.sourcePort : ''}`
      
      const nodeData = this.getSourceNodeData(sourceNode.id, link.sourcePort, nodeId, pool, wfData)
      if (nodeData !== null) {
        upstreamData[key] = nodeData
      }
    }
    
    return upstreamData
  }
  
  private getAllUpstreamQueryTextWithPorts(
    nodeId: number,
    pool: VariablePool = this.variablePool,
    wfData: WorkflowData = this.workflowData
  ): string {
    const sourceLinks = wfData.links.filter(link => link.target === nodeId)
    
    if (sourceLinks.length === 0) {
      return ''
    }
    
    const queryParts: string[] = []
    
    for (const link of sourceLinks) {
      const sourceNode = wfData.items.find(n => n.id === link.source)
      
      if (!sourceNode || !sourceNode.result) {
        continue
      }
      
      // 关键修改：检查节点状态是否为成功
      if (sourceNode.status !== 'success') {
        continue
      }
      
      const nodeData = this.getSourceNodeData(sourceNode.id, link.sourcePort, nodeId, pool, wfData)
      if (nodeData !== null) {
        if (typeof nodeData === 'string') {
          queryParts.push(nodeData)
        } else {
          queryParts.push(JSON.stringify(nodeData))
        }
      }
    }
    
    return queryParts.join('\n\n')
  }
  
  private async safeIpcInvoke(channel: string, ...args: any[]) {
    try {
      if (!window.ipcRenderer || typeof window.ipcRenderer.invoke !== 'function') {
        throw new Error('IPC通信不可用')
      }
      
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`IPC调用超时 (1小时) - ${channel}`)), 3600000)
      )
      
      const result = await Promise.race([
        window.ipcRenderer.invoke(channel, ...args),
        timeoutPromise
      ])
      
      return result
    } catch (error: any) {
      throw new Error(`IPC调用失败: ${error.message}`)
    }
  }
  
  // 清理所有MCP连接
  cleanupMcpConnections(): void {
    const mcpNodes = this.workflowData.items.filter(item => item.type === 'mcp')
    mcpNodes.forEach(node => {
      if (node.mcpConnected) {
        this.disconnectMcpNode(node.id).catch(console.error)
      }
    })
    mcpManager.cleanup()
  }
  
  // 工作流停止时清理资源
  cleanup(): void {
    this.cleanupMcpConnections()
    this.stop()
  }
}