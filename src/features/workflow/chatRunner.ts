/**
 * chatRunner.ts — 主页「工作流」对话模式的运行适配层
 *
 * 主页的对话 UI 需要「逐节点一条消息 + 进度 + 日志 + 结束汇总」这套回调，
 * 与编辑器里的运行面板需求不同，因此这里把新引擎（engine/runner）包装成对话侧要用的形状：
 * 运行的是 Dify DSL 文档（`.flow.yml`），开始节点的输入变量由用户在输入框里给出的文本填充。
 *
 * 约定：回调里的 nodeId 是 DSL 节点 id（字符串），与旧引擎的数字 id 不同。
 */

import type { DslDocument, DslNode, ValueSelector } from './dsl/types'
import { WorkflowRunner } from './engine/runner'
import type { NodeRunRecord, RunEvent } from './engine/types'

export interface ChatWorkflowCallbacks {
  /** 节点开始执行 */
  onNodeStart?: (nodeId: string, nodeName: string, nodeType: string) => void
  /** 节点执行结束（status 用对话侧的四种状态；已跳过的节点不回调） */
  onNodeComplete?: (
    nodeId: string,
    nodeName: string,
    nodeType: string,
    status: 'pending' | 'running' | 'success' | 'error',
    result: unknown,
  ) => void
  /** 代码节点执行出错（带 traceback 时一并给出） */
  onPythonError?: (nodeId: string, nodeName: string, error: string, traceback?: string) => void
  /** 分支节点选中了哪条分支 */
  onDecisionBranchSelected?: (nodeId: string, nodeName: string, branchId: string, branchName: string, reason?: string) => void
  /** 进度 */
  onProgress?: (completed: number, total: number, currentNode?: string) => void
  /** 整体结束 */
  onComplete?: (success: boolean, finalResult: string, aggregatedResults?: Record<string, any>) => void
  /** 日志 */
  onLog?: (message: string, level: 'info' | 'warning' | 'error') => void
  /** 节点流式输出（对话框实时更新用，accumulated 为累计文本） */
  onNodeStream?: (nodeId: string, chunk: string, accumulated: string) => void
  /** 节点状态变化 */
  onNodeStatusUpdate?: (nodeId: string, status: string, result?: string) => void
}

export interface ChatRunnerDeps {
  store: any
  t: (key: string) => string
  document?: DslDocument | null
  callbacks?: ChatWorkflowCallbacks
}

/** 顶层会被调度的节点数（容器内部节点由容器驱动，不计入进度总数） */
function scheduledNodeCount(document: DslDocument | null): number {
  if (!document) return 0
  return document.workflow.graph.nodes.filter((node) => !node.parentId).length
}

export class WorkflowChatRunner {
  callbacks: ChatWorkflowCallbacks
  isRunning = false

  private document: DslDocument | null
  private deps: { store: any; t: (key: string) => string }
  private inputs: Record<string, unknown> = {}
  private controller: AbortController | null = null
  private runner: WorkflowRunner

  constructor(deps: ChatRunnerDeps) {
    this.deps = { store: deps.store, t: deps.t }
    this.document = deps.document ?? null
    this.callbacks = deps.callbacks ?? {}
    this.runner = new WorkflowRunner(this.deps)
  }

  /** 进度用的节点总数 */
  get nodeCount(): number {
    return scheduledNodeCount(this.document)
  }

  /** 切换运行的工作流文档（对话里改绑文件时调用） */
  setDocument(document: DslDocument | null): void {
    this.document = document
    this.runner = new WorkflowRunner(this.deps)
  }

  /**
   * 把输入框里的文本喂给开始节点声明的输入变量。
   * 只有一个变量时直接写入；多个变量时写入第一个并提示其余留空；
   * 没有 start 节点或文档未加载时返回 false（调用方据此报错）。
   */
  setStartNodeInput(text: string): boolean {
    const start = this.startNode()
    if (!this.document || !start) return false

    const variables = Array.isArray((start.data as Record<string, unknown>).variables)
      ? ((start.data as Record<string, unknown>).variables as Array<Record<string, unknown>>)
      : []
    const names = variables.map((v) => String(v.variable || '')).filter(Boolean)
    this.inputs = {}

    if (!names.length) {
      this.callbacks.onLog?.(this.deps.t('chat.wf.noInputVars'), 'warning')
      return true
    }

    this.inputs[names[0]] = text
    if (names.length > 1) {
      this.callbacks.onLog?.(
        this.deps.t('chat.wf.extraInputVars').replace('{names}', names.slice(1).join('、')),
        'warning',
      )
    }
    return true
  }

  /** 中止本次运行 */
  stop(): void {
    this.controller?.abort()
    this.isRunning = false
  }

  /** 运行整个工作流 */
  async run(): Promise<void> {
    if (!this.document) throw new Error(this.deps.t('chat.wf.noDocument'))
    this.isRunning = true
    this.controller = new AbortController()

    const total = this.nodeCount
    const records = new Map<string, NodeRunRecord>()
    const startedAt = Date.now()
    let completed = 0
    const errors: Array<{ id: string; name: string; error: string }> = []

    const onEvent = (event: RunEvent): void => {
      switch (event.type) {
        case 'node-start': {
          this.callbacks.onNodeStart?.(event.nodeId, event.title, event.nodeType)
          this.callbacks.onNodeStatusUpdate?.(event.nodeId, 'running')
          this.callbacks.onProgress?.(completed, total, event.title)
          break
        }
        case 'node-stream': {
          // 引擎给的是累计文本，对话侧只需要 accumulated
          this.callbacks.onNodeStream?.(event.nodeId, event.text, event.text)
          break
        }
        case 'node-success': {
          completed++
          const title = this.titleOf(event.nodeId)
          this.callbacks.onNodeComplete?.(
            event.nodeId,
            title,
            this.typeOf(event.nodeId),
            'success',
            this.resultPayload(event.nodeId, event.outputs),
          )
          this.callbacks.onProgress?.(completed, total)
          break
        }
        case 'node-error': {
          completed++
          const title = this.titleOf(event.nodeId)
          const type = this.typeOf(event.nodeId)
          this.callbacks.onNodeComplete?.(event.nodeId, title, type, 'error', event.error)
          if (type === 'code') this.callbacks.onPythonError?.(event.nodeId, title, event.error)
          errors.push({ id: event.nodeId, name: title, error: event.error })
          this.callbacks.onProgress?.(completed, total)
          break
        }
        case 'node-skip': {
          // 分支未命中 / 上游跳过：只记日志，不生成执行单元（对话里不该出现一行「待运行」的死行）
          this.callbacks.onLog?.(`${this.titleOf(event.nodeId)}: ${event.reason}`, 'info')
          this.callbacks.onNodeStatusUpdate?.(event.nodeId, 'skipped')
          break
        }
        case 'log': {
          this.callbacks.onLog?.(event.message, event.level)
          break
        }
        default:
          break
      }
    }

    try {
      const result = await this.runner.run(this.document, {
        inputs: this.inputs,
        signal: this.controller.signal,
        onEvent,
      })
      for (const [id, record] of result.records) records.set(id, record)

      const success = result.status === 'success'
      const aggregated = {
        outputs: result.outputs,
        executionStats: {
          totalNodes: total,
          completedNodes: this.countSuccess(records),
          failedNodes: errors.length,
          executionTime: result.elapsedMs,
          errors,
        },
      }
      this.callbacks.onComplete?.(
        success,
        success ? this.composeReply(result.outputs, records) : result.error || this.deps.t('chat.wf.failed'),
        aggregated,
      )
    } catch (error: any) {
      const message = String(error?.message || error)
      this.callbacks.onLog?.(message, 'error')
      this.callbacks.onComplete?.(false, message, {
        executionStats: {
          totalNodes: total,
          completedNodes: this.countSuccess(records),
          failedNodes: errors.length + 1,
          executionTime: Date.now() - startedAt,
          errors,
        },
      })
    } finally {
      this.isRunning = false
      this.controller = null
    }
  }

  /** 运行完成为止成功的节点数 */
  private countSuccess(records: Map<string, NodeRunRecord>): number {
    let count = 0
    for (const record of records.values()) if (record.status === 'success') count++
    return count
  }

  private startNode(): DslNode | undefined {
    return this.document?.workflow.graph.nodes.find((node) => String(node.data.type) === 'start')
  }

  private findNode(nodeId: string): DslNode | undefined {
    return this.document?.workflow.graph.nodes.find((node) => node.id === nodeId)
  }

  private titleOf(nodeId: string): string {
    const node = this.findNode(nodeId)
    return String(node?.data.title || nodeId)
  }

  private typeOf(nodeId: string): string {
    return String(this.findNode(nodeId)?.data.type || '')
  }

  /**
   * 节点结果 → 对话侧展示用载荷。
   * 兼容旧对话 UI 的读法：`result` 是主输出，知识检索节点补 `relevantBlocks` / `kbPath`。
   */
  private resultPayload(nodeId: string, outputs: Record<string, unknown> | undefined): string {
    const payload: Record<string, unknown> = { ...(outputs ?? {}) }
    payload.result = pickPrimary(payload)

    const type = this.typeOf(nodeId)
    if ((type === 'knowledge-retrieval' || type === 'ai-km-knowledge') && Array.isArray(outputs?.result)) {
      const node = this.findNode(nodeId)
      payload.kbPath = String((node?.data as Record<string, unknown>)?.kb_path || '')
      payload.relevantBlocks = (outputs.result as Array<Record<string, unknown>>).map((block) => ({
        text: String(block.content ?? block.text ?? ''),
        similarity: Number(block.score ?? 0),
        metadata: { source: String(block.title ?? block.source ?? '') },
      }))
    }
    return JSON.stringify(payload)
  }

  /**
   * 对话侧最终回复。
   * 优先「直接回复」节点的正文（对话型应用：结束节点往往没声明输出、或其上游分支被跳过），
   * 其次结束节点的主要输出，再退到最后一个成功节点的主要输出，最后兜底 JSON。
   */
  private composeReply(outputs: Record<string, unknown> | undefined, records: Map<string, NodeRunRecord>): string {
    const answers: string[] = []
    for (const [id, record] of records) {
      if (record.status !== 'success') continue
      if (this.typeOf(id) !== 'answer') continue
      const text = String((record.outputs as Record<string, unknown> | undefined)?.answer ?? '').trim()
      if (text) answers.push(text)
    }
    if (answers.length) return answers.join('\n\n')

    const primary = pickPrimary(outputs ?? {})
    if (typeof primary === 'string' && primary.trim()) return primary
    if (primary !== undefined && primary !== null && typeof primary !== 'object') return String(primary)

    // 结束节点没给出可用文本（例如上游分支被跳过）：退到最后一个成功节点的输出
    for (const [, record] of [...records.entries()].reverse()) {
      if (record.status !== 'success' || !record.outputs) continue
      const last = pickPrimary(record.outputs as Record<string, unknown>)
      if (typeof last === 'string' && last.trim()) return last
      if (last !== undefined && last !== null && typeof last !== 'object') return String(last)
      break
    }
    return this.finalText(outputs ?? {})
  }

  /** 结束节点输出 → 展示文本（有 answer 就直接显示，否则给出格式化 JSON） */
  private finalText(outputs: Record<string, unknown>): string {
    const answer = outputs.answer ?? outputs.text ?? outputs.output
    if (typeof answer === 'string' && answer.trim()) return answer
    if (answer !== undefined && answer !== null && answer !== '') return JSON.stringify(answer, null, 2)
    return JSON.stringify(outputs, null, 2)
  }
}

/** 从输出里挑一个「主输出」用于对话展示（空字符串视为没有） */
function pickPrimary(outputs: Record<string, unknown>): unknown {
  for (const key of ['answer', 'text', 'output', 'result']) {
    const value = outputs[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && !value.trim()) continue
    // 知识检索的 result 是数组，交给 relevantBlocks 展示，这里跳过避免整段 JSON
    if (Array.isArray(value)) continue
    return value
  }
  const first = Object.values(outputs).find(
    (value) => value !== undefined && value !== null && !Array.isArray(value) && !(typeof value === 'string' && !value.trim()),
  )
  // 没有可用值就返回 undefined（调用方自己兜底）——注意不要返回整个 outputs，
  // 否则 resultPayload 会写出 payload.result = payload 的循环引用
  return first
}

/** 供宿主（对话）判断某个变量选择器是否属于开始节点 */
export function isStartVariable(selector: ValueSelector, document: DslDocument | null): boolean {
  const start = document?.workflow.graph.nodes.find((node) => String(node.data.type) === 'start')
  return !!start && Array.isArray(selector) && selector[0] === start.id
}
