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

/**
 * 调试运行接口（属性面板「试跑此节点 / 运行此节点及下游」用）：
 * 由编辑器 provide，属性面板 inject 后即可在任意节点上触发单节点试跑。
 */
export interface DebugRunActions {
  /** 该节点此刻能否试跑（只读 / 运行中 / 容器内部节点 / 开始结束等返回 false） */
  canRun: (nodeId: string) => boolean
  /** 是否正在运行（按钮禁用用；函数式读取以便模板保持响应式） */
  isRunning: () => boolean
  /** 试跑：downstream=true 时连同下游节点一起跑（复用变量检查器里缓存的上游值） */
  run: (nodeId: string, downstream: boolean) => void
}

export const DEBUG_RUN_KEY: InjectionKey<DebugRunActions> = Symbol('ai-km-debug-run')

// ---------------------------------------------------------------------------
// 变量检查器的纯逻辑（与 Vue 无关，便于单独核对）
// ---------------------------------------------------------------------------

/** 变量值 → 编辑框文本：字符串原样，其余按 JSON 展示 */
export function varTextOf(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/**
 * 编辑框文本 → 变量值：按**原值类型**还原（数字 / 布尔 / 对象数组），
 * 这样改一个数字不会变成字符串。对象类解析失败时抛错，由面板就地提示（不落值）。
 */
export function parseVarText(original: unknown, text: string): unknown {
  const trimmed = text.trim()
  if (typeof original === 'number') {
    const num = Number(trimmed)
    return Number.isFinite(num) ? num : text
  }
  if (typeof original === 'boolean') return trimmed === 'true'
  if (original !== null && typeof original === 'object') return JSON.parse(trimmed || 'null')
  return text
}

/** 变量检查器可见的变量：运行缓存 ∪ 手动编辑（编辑优先） */
export function mergeVarSnapshot(
  cache: Record<string, Record<string, unknown>>,
  edits: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const nodeId of new Set([...Object.keys(cache), ...Object.keys(edits)])) {
    out[nodeId] = { ...(cache[nodeId] ?? {}), ...(edits[nodeId] ?? {}) }
  }
  return out
}

/** 不参与单节点试跑的节点类型：开始 / 结束 / 直接回复 / 容器入口（与 Dify 一致） */
export const NON_DEBUG_TYPES = ['start', 'end', 'answer', 'iteration-start', 'loop-start', 'loop-end']

export function isDebuggableType(type: string): boolean {
  return !NON_DEBUG_TYPES.includes(type)
}

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
      state.logs = []
      state.outputs = {}
      state.error = undefined
      state.elapsedMs = undefined
      // records 不清空：每次运行只覆盖本次跑到的节点，其余节点保留「上次结果」
      // （与 Dify 一致；这是单节点试跑能用的前提——否则一跑就把整棵追踪树清掉）
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
        // 「默认值」策略兜底时带输出：照常展示本节点产出的变量
        outputs: event.outputs ?? state.records[event.nodeId]?.outputs,
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

/** 把运行记录写回节点的 `x-ai-km`（保存前调用，结果随文件持久化） */export function mergeRunStateIntoNodes(nodes: DslNode[], state: RunUiState): void {
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
