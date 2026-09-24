/**
 * NodeExecutor - 节点执行器接口与注册表
 *
 * 消除 switch/case 硬编码分发，使新节点类型只需新增一个文件 + 注册一行。
 */

import type { NodeData, NodeType, ExecutionCallback, WorkflowData, Link, DecisionBranch } from '@/components/workFlow/engine/WorkflowRunner'
import { VariablePool } from '@/components/workFlow/engine/VariablePool'

// ── 执行上下文（Executor 可访问的所有依赖） ──────────────────────

export interface ExecutionContext {
  store: any
  variablePool: VariablePool
  workflowData: WorkflowData
  callbacks: ExecutionCallback
  abortController: AbortController | null
  decisionPaths: Map<number, string>
  decisionDataTemplates: Map<number, string>
  t: (key: string) => string

  /** 日志 */
  log(message: string, level: 'info' | 'warning' | 'error'): void

  /** 获取上游节点上下文（含端口/决策分支） */
  getNodeContextWithPorts(nodeId: number, decisionPaths?: Map<number, string>): Promise<string[]>

  /** 获取源节点数据（考虑端口、决策模板） */
  getSourceNodeData(
    sourceNodeId: number,
    sourcePort?: string,
    targetNodeId?: number,
    decisionPaths?: Map<number, string>,
    decisionDataTemplates?: Map<number, string>
  ): any

  /** 获取上游数据（含端口，返回对象） */
  getUpstreamDataWithPorts?(nodeId: number): any

  /** 获取上游文本查询（含端口） */
  getAllUpstreamQueryTextWithPorts?(nodeId: number): string

  /** 安全 IPC 调用 */
  safeIpcInvoke(channel: string, ...args: any[]): Promise<any>

  /** 连接 MCP 节点 */
  connectMcpNode(nodeId: number): Promise<boolean>

  /** 验证模型配置 */
  validateModelConfig(node: NodeData): { valid: boolean; message: string }

  /** 将节点 result 同步到 VariablePool */
  syncResultToVariablePool(node: NodeData): void

  /** 发送到 AI */
  sendToAI(messages: any[], options: any): Promise<any>

  /** IPC 读文件 */
  readFile(filePath: string): Promise<string>

  /** 解析 {{nodeName.key}} 模板变量 */
  resolveTemplate(template: string, currentNodeId?: number): string

  /** 获取累加器（变量聚合节点跨迭代累计；nodeId -> 数组） */
  getAccumulator(nodeId: number): any[] | undefined

  /** 设置累加器 */
  setAccumulator(nodeId: number, value: any[]): void

  /** 解析模板并返回原始值（不做字符串化；数据节点 rows/batches 会返回运行期全量缓存） */
  resolveTemplateRaw?(template: string, currentNodeId?: number): any

  /** 数据节点全量数据缓存（run 级；供迭代/列表直接取全量行/批次） */
  setDataCache?(nodeId: number, data: { rows: any[]; batches?: any[][]; headers: string[]; total: number }): void
  getDataCache?(nodeId: number): { rows: any[]; batches?: any[][]; headers: string[]; total: number } | undefined

  /** 数组节点全量输出缓存（run 级；迭代/列表节点 output 走缓存，node.result 只存预览，避免 .flow 膨胀） */
  setArrayCache?(nodeId: number, arr: any[]): void
  getArrayCache?(nodeId: number): any[] | undefined

  /** 解析模板并把所有 {{表达式}} 按 JSON 字面量嵌入（代码场景专用；数组字段优先返回全量缓存） */
  resolveTemplateForCode?(template: string, currentNodeId?: number): string

  /**
   * 运行内部子图（迭代/循环容器内部流水线）。
   * seed 以 nodeId 预置变量（如迭代 item/index）；每次运行内部节点会被克隆（并发安全）。
   */
  runInnerGraph(
    innerItems: NodeData[],
    innerLinks: Link[],
    seed?: Record<number, Record<string, any>>,
    opts?: {
      startNodeId?: number
      extraNodes?: Array<{ id: number; name: string; type: string }>
      errorMode?: 'terminated' | 'continue_with_error' | 'continue_with_error_inject' | 'remove_abnormal_output'
    }
  ): Promise<{
    success: boolean
    outputs: Record<number, Record<string, any>>
    order: number[]
    failedNodeId?: number
    failedNodeName?: string
    error?: string
    failedCount: number
    failedNodes: Array<{ nodeId: number; nodeName: string; error: string }>
  }>
}

// ── 节点执行器接口 ─────────────────────────────────────────

export interface NodeExecutor {
  readonly type: NodeType
  readonly label: string
  execute(node: NodeData, ctx: ExecutionContext): Promise<boolean>
}

// ── 注册表 ────────────────────────────────────────────────

export class NodeExecutorRegistry {
  private executors = new Map<NodeType, NodeExecutor>()

  register(executor: NodeExecutor): void {
    if (this.executors.has(executor.type)) {
      console.warn(`[NodeExecutorRegistry] 覆盖已注册的执行器: ${executor.type}`)
    }
    this.executors.set(executor.type, executor)
  }

  get(type: NodeType): NodeExecutor {
    const exec = this.executors.get(type)
    if (!exec) throw new Error(`未知节点类型: ${type}，请先注册执行器`)
    return exec
  }

  has(type: NodeType): boolean {
    return this.executors.has(type)
  }

  get allTypes(): NodeType[] {
    return Array.from(this.executors.keys())
  }

  get count(): number {
    return this.executors.size
  }
}
