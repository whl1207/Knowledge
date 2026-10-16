/**
 * 图执行内核（顶层运行与容器子图共用）
 *
 * 与 Dify 运行时一致的语义：
 * 1. 串行拓扑执行：入度全部解决后才调度；入口是无入边的节点
 * 2. 分支裁剪：节点返回 `selectedHandle` 之外的出边标记跳过，并向下游传播
 * 3. 汇合语义：所有入边都被解决（执行或跳过）后才调度；全部跳过则本节点跳过
 * 4. 错误策略：terminated 终止；continue-on-error / remove-abnormal-output 跳过下游继续；
 *    fail-branch 只走 sourceHandle 为 'fail-branch' 的出边
 */

import type { DslEdge, DslNode } from '../dsl/types'
import { getExecutor } from './nodes'
import type { NodeExecutionContext, NodeRunRecord, RunEvent, WorkflowNodeExecutor } from './types'
import type { VariablePool } from './variablePool'
import { getPlatform } from '@/platform'
import { aikmIpcOrNull } from '@/lib/aikmIpc'

/** 容器入口节点：由容器执行器驱动，不参与常规调度 */
export const CONTAINER_ENTRY_TYPES = ['iteration-start', 'loop-start', 'loop-end']

export interface GraphExecuteDeps {
  store: any
  t: (key: string) => string
}

export interface SubgraphRunOutcome {
  /** 子图内各节点的输出（按 nodeId） */
  outputs: Record<string, Record<string, unknown>>
  success: boolean
  error?: string
}

export interface GraphExecuteParams {
  nodes: DslNode[]
  edges: DslEdge[]
  pool: VariablePool
  deps: GraphExecuteDeps
  emit: (event: RunEvent) => void
  signal: AbortSignal
  records: Map<string, NodeRunRecord>
  /** 运行输入（仅顶层开始节点使用） */
  inputs: Record<string, unknown>
  noRetry?: boolean
  /** 需要调度的节点 id 集合；缺省用「无 parentId 的根级节点」 */
  scope?: Set<string>
  /** 跑容器子图（容器执行器用；由调用方注入） */
  runSubgraph: (
    containerId: string,
    seed?: Record<string, Record<string, unknown>>,
  ) => Promise<SubgraphRunOutcome>
  /** 解析容器入口节点 id */
  resolveContainerEntry: (containerId: string) => string | undefined
}

export interface GraphExecuteResult {
  failure?: string
  aborted: boolean
}

/** 执行一张图（或一张子图） */
export async function executeGraph(params: GraphExecuteParams): Promise<GraphExecuteResult> {
  const { nodes, edges, pool, deps, emit, signal, records, inputs, noRetry } = params

  const scope = params.scope ?? new Set(nodes.filter((n) => !n.parentId).map((n) => n.id))
  const scopedNodes = nodes.filter((n) => scope.has(n.id))
  const nodeById = new Map(nodes.map((n) => [n.id, n]))

  const incoming = new Map<string, DslEdge[]>()
  const outgoing = new Map<string, { edge: DslEdge; target: string }[]>()
  for (const node of scopedNodes) {
    incoming.set(node.id, [])
    outgoing.set(node.id, [])
  }
  for (const edge of edges) {
    if (!scope.has(edge.source) || !scope.has(edge.target)) continue
    incoming.get(edge.target)?.push(edge)
    outgoing.get(edge.source)?.push({ edge, target: edge.target })
  }

  const remaining = new Map<string, number>()
  const takenIn = new Map<string, number>()
  /** 容器入口节点：不参与调度，其输出由容器执行器注入 */
  const entryNodes: DslNode[] = []
  for (const node of scopedNodes) {
    remaining.set(node.id, incoming.get(node.id)?.length ?? 0)
    takenIn.set(node.id, 0)
    if (CONTAINER_ENTRY_TYPES.includes(String(node.data.type))) {
      entryNodes.push(node)
      continue
    }
    if (!records.has(node.id)) {
      records.set(node.id, {
        nodeId: node.id,
        nodeType: String(node.data.type),
        title: node.data.title || String(node.data.type),
        status: 'idle',
      })
    }
  }

  const queue = scopedNodes
    .filter((n) => !CONTAINER_ENTRY_TYPES.includes(String(n.data.type)))
    .filter((n) => (remaining.get(n.id) ?? 0) === 0)
    .map((n) => n.id)
  const enqueued = new Set(queue)
  let failure: string | undefined

  const resolveEdge = (edge: DslEdge, taken: boolean): void => {
    const target = edge.target
    const left = (remaining.get(target) ?? 0) - 1
    remaining.set(target, left)
    if (taken) takenIn.set(target, (takenIn.get(target) ?? 0) + 1)
    if (left <= 0 && !enqueued.has(target)) {
      enqueued.add(target)
      queue.push(target)
    }
  }

  const skipDownstream = (nodeId: string): void => {
    for (const edgeRef of outgoing.get(nodeId) ?? []) resolveEdge(edgeRef.edge, false)
  }

  // 入口节点的输出已由容器执行器 seed 进变量池：其出边一律视为「已选中」，直接放行后续节点
  for (const entry of entryNodes) {
    const record = records.get(entry.id) ?? {
      nodeId: entry.id,
      nodeType: String(entry.data.type),
      title: entry.data.title || String(entry.data.type),
      status: 'idle' as const,
    }
    record.status = 'success'
    record.outputs = pool.getNodeOutputs(entry.id) ?? {}
    record.startedAt = Date.now()
    record.finishedAt = record.startedAt
    records.set(entry.id, record)
    for (const edgeRef of outgoing.get(entry.id) ?? []) resolveEdge(edgeRef.edge, true)
  }

  /** 统一的节点失败处理；返回 true 表示整个（子）图应当终止 */
  const handleNodeFailure = (node: DslNode, record: NodeRunRecord, message: string): boolean => {
    record.status = 'error'
    record.error = message
    record.finishedAt = Date.now()

    const strategy = node.data.error_strategy ?? 'terminated'
    if (strategy === 'fail-branch') {
      emit({ type: 'log', level: 'warning', message: `${record.title} 失败，走异常分支：${message}` })
      for (const edgeRef of outgoing.get(node.id) ?? []) {
        resolveEdge(edgeRef.edge, (edgeRef.edge.sourceHandle || 'source') === 'fail-branch')
      }
      return false
    }
    if (strategy === 'default-value') {
      // 默认值兜底（对齐 Dify）：把 default_value 当作本节点输出写进变量池，按正常连线继续往下跑
      const fallback = (node.data as Record<string, unknown>).default_value
      const outputs = fallback && typeof fallback === 'object' && !Array.isArray(fallback)
        ? { ...(fallback as Record<string, unknown>) }
        : {}
      record.outputs = outputs
      pool.setNodeOutputs(node.id, outputs)
      const names = Object.keys(outputs)
      emit({
        type: 'log',
        level: 'warning',
        message: names.length
          ? `${record.title} 失败（${message}），已使用默认值继续：${names.join('、')}`
          : `${record.title} 失败（${message}），已按空默认值继续（节点未配置默认值）`,
      })
      for (const edgeRef of outgoing.get(node.id) ?? []) {
        resolveEdge(edgeRef.edge, (edgeRef.edge.sourceHandle || 'source') === 'source')
      }
      return false
    }
    if (strategy === 'continue-on-error' || strategy === 'remove-abnormal-output') {
      emit({ type: 'log', level: 'warning', message: `${record.title} 失败但继续执行：${message}` })
      skipDownstream(node.id)
      return false
    }
    emit({ type: 'log', level: 'error', message: `${record.title} 执行失败：${message}` })
    return true
  }

  /** 组装节点执行上下文 */
  const makeContext = (node: DslNode): NodeExecutionContext => ({
    node: node.data,
    nodeId: node.id,
    pool,
    store: deps.store,
    signal,
    inputs,
    t: deps.t,
    log: (level, message) => emit({ type: 'log', level, message: `[${node.data.title || node.data.type}] ${message}` }),
    emitStream: (text) => {
      const record = records.get(node.id)
      if (record) record.streamed = text
      emit({ type: 'node-stream', nodeId: node.id, text })
    },
    requestAi: async (messages, aiParams) => {
      if (!deps.store?.sendToAI) throw new Error('AI 未就绪（store.sendToAI 不存在）')
      let text = ''
      let reasoning = ''
      await deps.store.sendToAI(messages, {
        onStream: (chunk: string) => {
          text += chunk
          emit({ type: 'node-stream', nodeId: node.id, text })
        },
        onReasoning: (chunk: string) => {
          reasoning += chunk
        },
        temperature: aiParams?.temperature,
        max_tokens: aiParams?.maxTokens,
        signal,
      })
      return { text, reasoning: reasoning || undefined }
    },
    runSubgraph: (containerId, seed) => params.runSubgraph(containerId, seed),
    resolveContainerEntry: (containerId) => params.resolveContainerEntry(containerId),
    invokeIpc: (channel, payload) => {
      const ipc = deps.store?.ipcRenderer ?? aikmIpcOrNull() ?? (globalThis as any).aikmIpcOrNull()
      if (!ipc?.invoke) throw new Error('IPC 不可用（当前环境没有 ipcRenderer）')
      return ipc.invoke(channel, payload)
    },
    readTextFile: (path) => getPlatform().fs.readText(path),
  })

  /** 单节点执行（含重试） */
  const executeWithRetry = async (
    node: DslNode,
    executor: WorkflowNodeExecutor,
  ): Promise<Awaited<ReturnType<WorkflowNodeExecutor['execute']>>> => {
    const retry = node.data.retry_config
    const retries = noRetry || !retry?.enabled ? 0 : Math.max(0, Number(retry.max_retries ?? 3))
    const baseInterval = Math.max(0, Number(retry?.retry_interval ?? 1000))
    const backoff = retry?.exponential_backoff
    const record = records.get(node.id) as NodeRunRecord

    let lastError: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (signal.aborted) throw new Error('已中止')
      record.attempts = attempt + 1
      try {
        return await executor.execute(makeContext(node))
      } catch (error) {
        lastError = error
        if (attempt >= retries) break
        let interval = baseInterval
        if (backoff?.enabled) {
          const multiplier = Number(backoff.multiplier ?? 2)
          const maxInterval = Number(backoff.max_interval ?? 10000)
          interval = Math.min(baseInterval * Math.pow(multiplier, attempt), maxInterval)
        }
        emit({
          type: 'log',
          level: 'warning',
          message: `${record.title} 第 ${attempt + 1} 次执行失败，${interval}ms 后重试：${(error as Error)?.message}`,
        })
        await new Promise((resolve) => setTimeout(resolve, interval))
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  while (queue.length) {
    if (signal.aborted) break
    const nodeId = queue.shift() as string
    const node = nodeById.get(nodeId)
    if (!node) continue
    const record = records.get(nodeId) as NodeRunRecord

    // 所有入边都被跳过 → 本节点跳过
    if ((takenIn.get(nodeId) ?? 0) === 0 && (incoming.get(nodeId)?.length ?? 0) > 0) {
      record.status = 'skipped'
      emit({ type: 'node-skip', nodeId, reason: '上游分支未选中' })
      skipDownstream(nodeId)
      continue
    }

    const executor = getExecutor(String(node.data.type))
    if (!executor) {
      const message = `节点类型「${node.data.title || node.data.type}」暂不支持执行`
      const terminate = handleNodeFailure(node, record, message)
      emit({ type: 'node-error', nodeId, error: message, elapsedMs: 0, outputs: record.outputs })
      if (terminate) {
        failure = message
        break
      }
      continue
    }

    emit({ type: 'node-start', nodeId, nodeType: String(node.data.type), title: record.title })
    record.status = 'running'
    record.startedAt = Date.now()

    try {
      const result = await executeWithRetry(node, executor)
      record.status = 'success'
      record.outputs = result.outputs ?? {}
      record.finishedAt = Date.now()
      if (result.outputs) pool.setNodeOutputs(nodeId, result.outputs)
      for (const [name, value] of Object.entries(result.conversationUpdates ?? {})) {
        pool.setConversation(name, value)
      }

      const takenHandle = result.selectedHandle ?? 'source'
      for (const edgeRef of outgoing.get(nodeId) ?? []) {
        resolveEdge(edgeRef.edge, (edgeRef.edge.sourceHandle || 'source') === takenHandle)
      }

      emit({
        type: 'node-success',
        nodeId,
        outputs: result.outputs ?? {},
        elapsedMs: record.finishedAt - (record.startedAt ?? Date.now()),
      })
    } catch (error) {
      const message = (error as Error)?.message || String(error)
      const elapsedMs = Date.now() - (record.startedAt ?? Date.now())
      const terminate = handleNodeFailure(node, record, message)
      // 失败事件放在错误策略处理之后：默认值兜底时 record.outputs 已填好，面板照常能看到变量
      emit({ type: 'node-error', nodeId, error: message, elapsedMs, outputs: record.outputs })
      if (terminate) {
        failure = message
        break
      }
    }
  }

  // 未跑到的节点统一标记为跳过
  for (const node of scopedNodes) {
    if (CONTAINER_ENTRY_TYPES.includes(String(node.data.type))) continue
    const record = records.get(node.id)
    if (!record) continue
    if (record.status === 'idle' || record.status === 'running') {
      record.status = 'skipped'
      record.error = record.error ?? (failure ? '上游失败，未执行' : '未执行')
    }
  }

  return { failure, aborted: signal.aborted }
}
