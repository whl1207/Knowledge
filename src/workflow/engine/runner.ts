/**
 * 工作流运行入口
 *
 * 顶层职责：初始化变量池（sys / env / conversation）、驱动根级图执行、汇总最终输出。
 * 具体的调度语义在 graphRunner 里（顶层与容器子图共用同一份实现）。
 */

import type { DslDocument, DslEdge, DslNode } from '../dsl/types'
import { resolveContainerEntry } from '../dsl/container'
import { CONTAINER_ENTRY_TYPES, executeGraph, type SubgraphRunOutcome } from './graphRunner'
import { VariablePool } from './variablePool'
import type { NodeRunRecord, RunEvent, RunOptions, RunResult } from './types'

export interface RunnerDeps {
  store: any
  t: (key: string) => string
}

export class WorkflowRunner {
  private records = new Map<string, NodeRunRecord>()
  private abortController = new AbortController()
  private pool!: VariablePool
  private nodes: DslNode[] = []
  private edges: DslEdge[] = []

  constructor(private deps: RunnerDeps) {}

  /** 运行整张工作流图 */
  async run(document: DslDocument, options: RunOptions = {}): Promise<RunResult> {
    const startedAt = Date.now()
    const graph = document.workflow.graph
    const runId = `run_${startedAt}`
    const emit = (event: RunEvent): void => options.onEvent?.(event)

    this.records = new Map()
    this.abortController = new AbortController()
    if (options.signal) {
      if (options.signal.aborted) this.abortController.abort()
      else options.signal.addEventListener('abort', () => this.abortController.abort(), { once: true })
    }

    this.nodes = graph.nodes
    this.edges = graph.edges

    this.pool = new VariablePool({
      systemVariables: {
        workflow_run_id: runId,
        timestamp: startedAt,
        app_id: '',
        user_id: '',
        query: '',
      },
      environmentVariables: document.workflow.environment_variables,
      conversationVariables: document.workflow.conversation_variables,
    })

    emit({ type: 'run-start', runId, nodeCount: graph.nodes.length })

  // 顶层：容器子节点由对应的容器执行器驱动，先登记为「容器内部节点」，
  // 避免运行面板在容器跑起来之前把子节点显示成待运行。
  for (const node of graph.nodes) {
    if (node.parentId) {
      this.records.set(node.id, {
        nodeId: node.id,
        nodeType: String(node.data.type),
        title: node.data.title || String(node.data.type),
        status: 'skipped',
        error: '容器内部节点',
      })
    }
  }

    const { failure, aborted } = await executeGraph({
      nodes: this.nodes,
      edges: this.edges,
      pool: this.pool,
      deps: this.deps,
      emit,
      signal: this.abortController.signal,
      records: this.records,
      inputs: options.inputs ?? {},
      noRetry: options.noRetry,
      runSubgraph: (containerId, seed) => this.runSubgraph(containerId, seed, emit, options),
      resolveContainerEntry: (containerId) => {
        const container = this.nodes.find((n) => n.id === containerId)
        const explicit = (container?.data as unknown as Record<string, unknown>)?.start_node_id
        return resolveContainerEntry(this.nodes, containerId, explicit)?.id
      },
    })

    // 汇总最终输出：结束节点声明的 outputs，或直接回复的 answer
    const runOutputs: Record<string, unknown> = {}
    for (const record of this.records.values()) {
      if (record.status !== 'success') continue
      if (record.nodeType === 'end') Object.assign(runOutputs, record.outputs ?? {})
      if (record.nodeType === 'answer' && record.outputs?.answer !== undefined) {
        runOutputs.answer = record.outputs.answer
      }
    }

    const elapsedMs = Date.now() - startedAt
    if (failure && !aborted) {
      emit({ type: 'run-error', error: failure, elapsedMs })
      return { status: 'error', outputs: runOutputs, records: this.records, error: failure, elapsedMs }
    }
    if (aborted) {
      emit({ type: 'run-error', error: '已中止', elapsedMs })
      return { status: 'aborted', outputs: runOutputs, records: this.records, error: '已中止', elapsedMs }
    }

    emit({ type: 'run-success', outputs: runOutputs, elapsedMs })
    return { status: 'success', outputs: runOutputs, records: this.records, elapsedMs }
  }

  /** 取容器的直接子节点 */
  private childrenOf(containerId: string): DslNode[] {
    return this.nodes.filter((n) => n.parentId === containerId)
  }

  /**
   * 运行容器子图。
   * 子图与父图**共享变量池**：容器内部节点可以读上游变量，容器的 output_selector 也直接
   * 按内部节点 id 取值（与 Dify 一致）。每次迭代用 seed 覆盖入口节点的输出。
   */
  private async runSubgraph(
    containerId: string,
    seed: Record<string, Record<string, unknown>> | undefined,
    emit: (event: RunEvent) => void,
    options: RunOptions,
  ): Promise<SubgraphRunOutcome> {
    const children = this.childrenOf(containerId)
    if (!children.length) return { outputs: {}, success: false, error: '容器内没有任何节点' }

    for (const [nodeId, outputs] of Object.entries(seed ?? {})) {
      this.pool.setNodeOutputs(nodeId, outputs)
    }

    const scope = new Set(children.map((n) => n.id))
    const { failure } = await executeGraph({
      nodes: this.nodes,
      edges: this.edges,
      pool: this.pool,
      deps: this.deps,
      emit,
      signal: this.abortController.signal,
      records: this.records,
      inputs: options.inputs ?? {},
      noRetry: options.noRetry,
      scope,
      runSubgraph: (id, innerSeed) => this.runSubgraph(id, innerSeed, emit, options),
      resolveContainerEntry: (containerId) => {
        const container = this.nodes.find((n) => n.id === containerId)
        const explicit = (container?.data as unknown as Record<string, unknown>)?.start_node_id
        return resolveContainerEntry(this.nodes, containerId, explicit)?.id
      },
    })

    const outputs: Record<string, Record<string, unknown>> = {}
    for (const child of children) {
      const record = this.records.get(child.id)
      if (record?.status === 'success' && record.outputs) outputs[child.id] = record.outputs
    }
    return { outputs, success: !failure, error: failure }
  }
}
