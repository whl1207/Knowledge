/**
 * 属性面板的公共 props 约定
 *
 * 面板直接原地修改传入的 data 对象（该对象就是文档里节点的 data，已被 Vue 代理），
 * 编辑器用深度 watcher 捕获变化并标记未保存。数组字段（variables / outputs / prompt_template）
 * 必须原地增删，不能整体替换，否则会丢掉响应式引用。
 */

import type {
  BaseNodeData,
  ConversationVariable,
  DslEdge,
  DslNode,
  EnvironmentVariable,
} from '../dsl/types'

export interface NodePanelProps {
  /** 节点的 data（原地修改） */
  data: BaseNodeData
  /** 当前节点 id */
  nodeId: string
  /** 全图节点（变量选择器需要） */
  nodes: DslNode[]
  /** 全图连线（变量选择器需要） */
  edges: DslEdge[]
  environmentVariables: EnvironmentVariable[]
  conversationVariables: ConversationVariable[]
}
