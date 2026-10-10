/**
 * 运行态（画布状态 / 运行面板）
 *
 * 运行期数据只在内存里流转（不污染节点语义字段），保存时再合并进 `x-ai-km`
 * —— 这样一次运行不会立刻把文件标记成「有未保存修改」，但用户保存后运行结果仍在。
 */

import type { ComputedRef, InjectionKey, Ref } from 'vue'
import type { NodeRunRecord, RunEvent, RunStatus } from '../engine/types'
import type { DslDocument, DslNode } from '../dsl/types'

export interface RunLogEntry {
  id: number
  level: 'info' | 'warning' | 'error'
  message: string
  at: number
}

export interface RunUiState {
  status: 'idle' | 'running' | 'success' | 'error' | 'aborted'
  running: boolean
  records: Record<string, NodeRunRecord>
  logs: RunLogEntry[]
  outputs: Record<string, unknown>
  error?: string
  elapsedMs?: number
}

/** 运行历史（内存保留最近若干次，便于对比；不落盘） */
export interface RunHistoryEntry {
  id: string
  at: number
  status: RunUiState['status']
  running: boolean
  records: Record<string, NodeRunRecord>
  logs: RunLogEntry[]
  outputs: Record<string, unknown>
  error?: string
  elapsedMs?: number
}

/** 把当前运行态快照成历史条目 */
export function snapshotRun(state: RunUiState): RunHistoryEntry {
  return {
    id: `run-${Date.now()}`,
    at: Date.now(),
    status: state.status,
    running: false,
    records: JSON.parse(JSON.stringify(state.records ?? {})),
    logs: [...(state.logs ?? [])],
    outputs: JSON.parse(JSON.stringify(state.outputs ?? {})),
    error: state.error,
    elapsedMs: state.elapsedMs,
  }
}

/** 追踪树的一行：容器子节点缩进显示 */
export interface TraceRow {
  record: NodeRunRecord
  depth: number
}

export function createRunUiState(): RunUiState {
  return { status: 'idle', running: false, records: {}, logs: [], outputs: {} }
}

export const RUN_STATE_KEY: InjectionKey<Ref<RunUiState>> = Symbol('ai-km-run-state')

/** 画布是否不可编辑（readonly 或已锁定）：节点卡片据此隐藏交互手柄 */
export const EDITOR_LOCK_KEY: InjectionKey<ComputedRef<boolean>> = Symbol('ai-km-editor-locked')

export interface RunEventLogUpdate {
  state: RunUiState
  nextLogId: number
}

/** 把运行事件折叠进 UI 状态（原地修改，保持响应式） */
export function applyRunEvent(update: RunEventLogUpdate, event: RunEvent): void {
  const { state } = update
  switch (event.type) {
    case 'run-start':
      state.status = 'running'
      state.running = true
      state.records = {}
      state.logs = []
      state.outputs = {}
      state.error = undefined
      state.elapsedMs = undefined
      pushLog(update, 'info', `开始运行，共 ${event.nodeCount} 个节点`)
      break
    case 'run-success':
      state.status = 'success'
      state.running = false
      state.outputs = event.outputs
      state.elapsedMs = event.elapsedMs
      pushLog(update, 'info', `运行成功，用时 ${event.elapsedMs}ms`)
      break
    case 'run-error':
      state.status = 'error'
      state.running = false
      state.error = event.error
      state.elapsedMs = event.elapsedMs
      pushLog(update, 'error', `运行失败：${event.error}`)
      break
    case 'node-start':
      setRecord(state, event.nodeId, { nodeId: event.nodeId, nodeType: event.nodeType, title: event.title, status: 'running', startedAt: Date.now() })
      break
    case 'node-stream': {
      const record = state.records[event.nodeId]
      if (record) record.streamed = event.text
      break
    }
    case 'node-success': {
      setRecord(state, event.nodeId, {
        ...(state.records[event.nodeId] ?? { nodeId: event.nodeId, nodeType: '', title: '' }),
        status: 'success',
        outputs: event.outputs,
        finishedAt: Date.now(),
        elapsedMs: event.elapsedMs,
        error: undefined,
      })
      pushLog(update, 'info', `${state.records[event.nodeId]?.title ?? event.nodeId} 完成（${event.elapsedMs}ms）`)
      break
    }
    case 'node-error': {
      setRecord(state, event.nodeId, {
        ...(state.records[event.nodeId] ?? { nodeId: event.nodeId, nodeType: '', title: '' }),
        status: 'error',
        error: event.error,
        finishedAt: Date.now(),
        elapsedMs: event.elapsedMs,
      })
      break
    }
    case 'node-skip':
      setRecord(state, event.nodeId, {
        ...(state.records[event.nodeId] ?? { nodeId: event.nodeId, nodeType: '', title: '' }),
        status: 'skipped',
        error: event.reason,
      })
      break
    case 'log':
      pushLog(update, event.level, event.message)
      break
  }
}

function pushLog(update: RunEventLogUpdate, level: RunLogEntry['level'], message: string): void {
  update.state.logs.push({ id: update.nextLogId++, level, message, at: Date.now() })
}

function setRecord(state: RunUiState, nodeId: string, record: NodeRunRecord): void {
  state.records[nodeId] = record
}

/** 取某个节点的运行状态（画布角标用） */
export function recordStatus(state: RunUiState, nodeId: string): RunStatus {
  return state.records[nodeId]?.status ?? 'idle'
}

/**
 * 按文档顺序组装追踪树：容器（迭代/循环）在前，其子节点紧随其后并缩进。
 */
export function buildTraceRows(document: DslDocument | null, records: Record<string, NodeRunRecord>): TraceRow[] {
  if (!document) {
    return Object.values(records).map((record) => ({ record, depth: 0 }))
  }
  const nodes = document.workflow.graph.nodes
  const rows: TraceRow[] = []
  const seen = new Set<string>()

  const push = (nodeId: string, depth: number): void => {
    const record = records[nodeId]
    if (!record || seen.has(nodeId)) return
    seen.add(nodeId)
    rows.push({ record, depth })
  }

  for (const node of nodes) {
    if (node.parentId) continue
    push(node.id, 0)
    if (node.data && ['iteration', 'loop'].includes(String(node.data.type))) {
      for (const child of nodes) {
        if (child.parentId === node.id) push(child.id, 1)
      }
    }
  }
  // 文档里没有但记录里有的（理论不该出现）：兜底追加
  for (const nodeId of Object.keys(records)) push(nodeId, 0)
  return rows
}

/** 把运行记录写回节点的 `x-ai-km`（保存前调用，结果随文件持久化） */
export function mergeRunStateIntoNodes(nodes: DslNode[], state: RunUiState): void {
  for (const node of nodes) {
    const record = state.records[node.id]
    if (!record) continue
    const data = node.data as unknown as Record<string, unknown>
    const extras = (data['x-ai-km'] as Record<string, unknown>) ?? {}
    extras.status = record.status
    if (record.error) extras.error = record.error
    else delete extras.error
    if (record.outputs) extras.result = JSON.stringify(record.outputs)
    data['x-ai-km'] = extras
  }
}

/** 打开文件时把上次保存的运行状态读回画布（只用于展示） */
export function readRunStateFromNodes(nodes: DslNode[]): Record<string, NodeRunRecord> {
  const records: Record<string, NodeRunRecord> = {}
  for (const node of nodes) {
    const extras = (node.data as unknown as Record<string, unknown>)['x-ai-km'] as Record<string, unknown> | undefined
    const status = extras?.status as RunStatus | undefined
    if (!status || status === 'running') continue
    records[node.id] = {
      nodeId: node.id,
      nodeType: String(node.data.type),
      title: node.data.title || String(node.data.type),
      status,
      error: typeof extras?.error === 'string' ? extras.error : undefined,
    }
  }
  return records
}
