/**
 * 变量池
 *
 * 以 `[nodeId, variableName]` 为键存放运行期数据，另外承载 sys / env / conversation 命名空间。
 * 与 Dify 一致：写入方是节点执行结果，读取方只通过 value_selector（或 {{#..#}} 模板）。
 */

import {
  CONVERSATION_VARIABLE_NODE_ID,
  ENVIRONMENT_VARIABLE_NODE_ID,
  SYSTEM_VARIABLE_NODE_ID,
  type ConversationVariable,
  type EnvironmentVariable,
  type ValueSelector,
} from '../dsl/types'
import { selectorKey } from '../dsl/variable'

/** 节点输出集合：变量名 → 值 */
export type NodeOutputs = Record<string, unknown>

export interface VariablePoolInit {
  environmentVariables?: EnvironmentVariable[]
  conversationVariables?: ConversationVariable[]
  /** 系统变量（sys.*） */
  systemVariables?: Record<string, unknown>
}

export class VariablePool {
  /** 节点 id → 输出变量表 */
  private nodeOutputs = new Map<string, NodeOutputs>()
  private system = new Map<string, unknown>()
  private environment = new Map<string, unknown>()
  private conversation = new Map<string, unknown>()

  constructor(init: VariablePoolInit = {}) {
    for (const [name, value] of Object.entries(init.systemVariables ?? {})) {
      this.system.set(name, value)
    }
    for (const item of init.environmentVariables ?? []) {
      this.environment.set(item.name, item.value)
    }
    for (const item of init.conversationVariables ?? []) {
      this.conversation.set(item.name, item.value)
    }
  }

  /** 写入节点输出（同名字段合并，便于流式增量更新） */
  setNodeOutputs(nodeId: string, outputs: NodeOutputs, merge = false): void {
    if (!merge) {
      this.nodeOutputs.set(nodeId, { ...outputs })
      return
    }
    const current = this.nodeOutputs.get(nodeId) ?? {}
    this.nodeOutputs.set(nodeId, { ...current, ...outputs })
  }

  getNodeOutputs(nodeId: string): NodeOutputs | undefined {
    return this.nodeOutputs.get(nodeId)
  }

  /** 按 selector 取值；支持命名空间与嵌套路径（`['node','a.b']`） */
  get(selector: ValueSelector | undefined | null): unknown {
    if (!selector || selector.length < 2) return undefined
    const [scope, ...path] = selector

    if (scope === SYSTEM_VARIABLE_NODE_ID) return readPath(this.system.get(path[0]), path.slice(1))
    if (scope === ENVIRONMENT_VARIABLE_NODE_ID) return readPath(this.environment.get(path[0]), path.slice(1))
    if (scope === CONVERSATION_VARIABLE_NODE_ID) return readPath(this.conversation.get(path[0]), path.slice(1))

    const outputs = this.nodeOutputs.get(scope)
    if (!outputs) return undefined
    // Dify 允许把整条路径塞进第二段（如 ['node','obj.key']），这里同时兼容两种写法
    const head = path[0]
    if (outputs[head] !== undefined) return readPath(outputs[head], path.slice(1))
    const dotted = path.join('.')
    if (outputs[dotted] !== undefined) return outputs[dotted]
    const segments = dotted.split('.')
    if (segments.length > 1) return readPath(outputs[segments[0]], segments.slice(1))
    return undefined
  }

  has(selector: ValueSelector | undefined | null): boolean {
    return this.get(selector) !== undefined
  }

  /** 写入会话变量（assigner / answer 等运行时修改） */
  setConversation(name: string, value: unknown): void {
    this.conversation.set(name, value)
  }

  /** 会话变量的最终快照（用于回写文档） */
  conversationSnapshot(): Record<string, unknown> {
    return Object.fromEntries(this.conversation.entries())
  }

  /** 某节点是否已有输出（判断上游是否跑过） */
  hasNode(nodeId: string): boolean {
    return this.nodeOutputs.has(nodeId)
  }

  /** 全量快照（调试 / 运行面板展示） */
  snapshot(): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {}
    for (const [nodeId, outputs] of this.nodeOutputs.entries()) result[nodeId] = outputs
    result[SYSTEM_VARIABLE_NODE_ID] = Object.fromEntries(this.system.entries())
    result[ENVIRONMENT_VARIABLE_NODE_ID] = Object.fromEntries(this.environment.entries())
    result[CONVERSATION_VARIABLE_NODE_ID] = Object.fromEntries(this.conversation.entries())
    return result
  }

  /** 只读视图：按 `nodeId.var` 键列出（供运行面板与模板错误提示） */
  flat(): Record<string, unknown> {
    const flat: Record<string, unknown> = {}
    for (const [nodeId, outputs] of this.nodeOutputs.entries()) {
      for (const [name, value] of Object.entries(outputs)) flat[selectorKey([nodeId, name])] = value
    }
    for (const [name, value] of this.system.entries()) flat[selectorKey([SYSTEM_VARIABLE_NODE_ID, name])] = value
    for (const [name, value] of this.environment.entries()) flat[selectorKey([ENVIRONMENT_VARIABLE_NODE_ID, name])] = value
    for (const [name, value] of this.conversation.entries()) flat[selectorKey([CONVERSATION_VARIABLE_NODE_ID, name])] = value
    return flat
  }
}

/** 沿路径取值（`a.b` 形式或数组索引） */
function readPath(value: unknown, path: string[]): unknown {
  let current = value
  for (const segment of path) {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current)) {
      const index = Number(segment)
      current = Number.isInteger(index) ? current[index] : undefined
      continue
    }
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment]
      continue
    }
    return undefined
  }
  return current
}
