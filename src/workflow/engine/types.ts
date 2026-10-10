/**
 * 引擎类型定义与节点执行器接口
 *
 * 与 Dify 的运行时概念对应：
 * - 一个节点执行成功即产出若干「输出变量」（写入变量池）
 * - 分支节点通过 `selectedHandle` 决定后续走哪条边
 * - 错误策略与重试由调度器统一处理，节点执行器只负责“跑一次”
 */

import type { BaseNodeData } from '../dsl/types'
import type { VariablePool } from './variablePool'

/** 运行状态（画布与运行面板共用） */
export type RunStatus = 'idle' | 'running' | 'success' | 'error' | 'skipped'

export interface NodeRunRecord {
  nodeId: string
  nodeType: string
  title: string
  status: RunStatus
  /** 输出变量（成功后） */
  outputs?: Record<string, unknown>
  /** 失败原因 */
  error?: string
  /** 开始 / 结束时间戳（毫秒） */
  startedAt?: number
  finishedAt?: number
  /** 本次执行耗时（毫秒） */
  elapsedMs?: number
  /** 试跑次数（含重试） */
  attempts?: number
  /** 流式文本（LLM 边跑边看） */
  streamed?: string
}

/** 运行事件：驱动日志面板与节点状态 */
export type RunEvent =
  | { type: 'run-start'; runId: string; nodeCount: number }
  | { type: 'run-success'; outputs: Record<string, unknown>; elapsedMs: number }
  | { type: 'run-error'; error: string; elapsedMs: number }
  | { type: 'node-start'; nodeId: string; nodeType: string; title: string }
  | { type: 'node-stream'; nodeId: string; text: string }
  | { type: 'node-success'; nodeId: string; outputs: Record<string, unknown>; elapsedMs: number }
  | { type: 'node-error'; nodeId: string; error: string; elapsedMs: number }
  | { type: 'node-skip'; nodeId: string; reason: string }
  | { type: 'log'; level: 'info' | 'warning' | 'error'; message: string }

export interface RunOptions {
  /** 每次运行的输入（开始节点声明的变量） */
  inputs?: Record<string, unknown>
  /** 中止信号 */
  signal?: AbortSignal
  /** 事件回调 */
  onEvent?: (event: RunEvent) => void
  /** 只跑一次不重试（调试用） */
  noRetry?: boolean
}

export interface RunResult {
  status: 'success' | 'error' | 'aborted'
  /** 结束节点声明的输出（无 end 节点时为空） */
  outputs: Record<string, unknown>
  /** 每个节点的运行记录 */
  records: Map<string, NodeRunRecord>
  error?: string
  elapsedMs: number
}

/** 节点执行上下文 */
export interface NodeExecutionContext {
  node: BaseNodeData
  nodeId: string
  pool: VariablePool
  store: any
  signal: AbortSignal
  /** 本次运行的输入（开始节点用） */
  inputs: Record<string, unknown>
  t: (key: string) => string
  log: (level: 'info' | 'warning' | 'error', message: string) => void
  /** 流式输出（LLM 节点用；会写入运行面板） */
  emitStream: (text: string) => void
  /**
   * 运行容器子图（迭代 / 循环执行器用）。
   * seed 以 nodeId 预置输出（例如给入口节点写入 item / index），子图与父图共享变量池。
   */
  runSubgraph: (
    containerId: string,
    seed?: Record<string, Record<string, unknown>>,
  ) => Promise<{ outputs: Record<string, Record<string, unknown>>; success: boolean; error?: string }>
  /** 解析容器入口节点 id（容器执行器据此把 item / index 写进去） */
  resolveContainerEntry: (containerId: string) => string | undefined
  /** 调用主进程 IPC（代码执行 / 读文件等） */
  invokeIpc: (channel: string, payload?: unknown) => Promise<any>
  /** 按节点模型配置调用大模型 */
  requestAi: (
    messages: Array<{ role: string; content: string }>,
    options?: { temperature?: number; maxTokens?: number },
  ) => Promise<{ text: string; reasoning?: string }>
}

/** 单次执行结果 */
export interface NodeExecutionResult {
  /** 输出变量（写进变量池） */
  outputs?: Record<string, unknown>
  /** 分支节点选中的输出端口（默认 'source'） */
  selectedHandle?: string
  /** 会话变量写入（assigner / answer） */
  conversationUpdates?: Record<string, unknown>
}

export interface WorkflowNodeExecutor {
  type: string
  execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult>
}
