/**
 * 变量选择器的数据来源：把「图 + 全局变量」整理成分组可选项
 *
 * 分组：
 * - 上游节点：沿入边回溯得到的祖先节点，逐个列出其输出变量（避免选择形成环）
 * - 系统变量：sys.* 命名空间
 * - 环境变量 / 会话变量：来自文档的 environment_variables / conversation_variables
 */

import type {
  BaseNodeData,
  ConversationVariable,
  DslEdge,
  DslNode,
  EnvironmentVariable,
  ValueSelector,
  VarType,
} from '../dsl/types'
import { CONVERSATION_VARIABLE_NODE_ID, ENVIRONMENT_VARIABLE_NODE_ID, SYSTEM_VARIABLE_NODE_ID } from '../dsl/types'
import { getNodeOutputs } from '../nodes/registry'

export interface VariableOption {
  selector: ValueSelector
  /** 输出变量名 */
  name: string
  type: VarType
}

export interface VariableGroup {
  key: string
  /** 分组标题（节点标题或命名空间名） */
  label: string
  /** 节点类型，用于图标（系统分组为命名空间名） */
  type: string
  options: VariableOption[]
}

export interface VariableGroupSource {
  nodes: DslNode[]
  edges: DslEdge[]
  /** 当前正在编辑的节点 id（自身与下游不可选） */
  currentNodeId?: string
  environmentVariables?: EnvironmentVariable[]
  conversationVariables?: ConversationVariable[]
}

/** Dify 的 sys 变量（api/core/workflow/system_variables.py） */
const SYSTEM_VARIABLES: Array<{ name: string; type: VarType }> = [
  { name: 'query', type: 'string' },
  { name: 'files', type: 'array[file]' },
  { name: 'conversation_id', type: 'string' },
  { name: 'user_id', type: 'string' },
  { name: 'dialogue_count', type: 'number' },
  { name: 'app_id', type: 'string' },
  { name: 'workflow_id', type: 'string' },
  { name: 'workflow_run_id', type: 'string' },
  { name: 'timestamp', type: 'number' },
  { name: 'document_id', type: 'string' },
  { name: 'original_document_id', type: 'string' },
  { name: 'batch', type: 'string' },
  { name: 'dataset_id', type: 'string' },
  { name: 'datasource_type', type: 'string' },
  { name: 'datasource_info', type: 'object' },
  { name: 'invoke_from', type: 'string' },
]

/** 沿入边回溯（含多层）得到所有祖先节点 id */
export function collectUpstreamNodeIds(
  edges: DslEdge[],
  currentNodeId?: string,
): Set<string> {
  const incoming = new Map<string, string[]>()
  for (const edge of edges) {
    const list = incoming.get(edge.target)
    if (list) list.push(edge.source)
    else incoming.set(edge.target, [edge.source])
  }

  const result = new Set<string>()
  // 没有当前节点时（如全局变量面板）视为「全部节点可选」
  if (!currentNodeId) {
    for (const edge of edges) result.add(edge.source)
    return result
  }

  const stack = [...(incoming.get(currentNodeId) ?? [])]
  while (stack.length) {
    const id = stack.pop() as string
    if (result.has(id) || id === currentNodeId) continue
    result.add(id)
    for (const parent of incoming.get(id) ?? []) stack.push(parent)
  }
  return result
}

/** 组装分组可选项；空分组会被过滤掉 */
export function buildVariableGroups(source: VariableGroupSource): VariableGroup[] {
  const { nodes, edges, currentNodeId, environmentVariables, conversationVariables } = source
  const upstream = collectUpstreamNodeIds(edges, currentNodeId)
  const groups: VariableGroup[] = []

  for (const node of nodes) {
    if (node.id === currentNodeId) continue
    if (currentNodeId && !upstream.has(node.id)) continue
    const outputs = getNodeOutputs(node.data as BaseNodeData)
    if (!outputs.length) continue
    groups.push({
      key: node.id,
      label: node.data.title || String(node.data.type),
      type: String(node.data.type),
      options: outputs.map((output) => ({
        selector: [node.id, output.name],
        name: output.name,
        type: output.type,
      })),
    })
  }

  groups.push({
    key: SYSTEM_VARIABLE_NODE_ID,
    label: 'system',
    type: SYSTEM_VARIABLE_NODE_ID,
    options: SYSTEM_VARIABLES.map((v) => ({
      selector: [SYSTEM_VARIABLE_NODE_ID, v.name],
      name: v.name,
      type: v.type,
    })),
  })

  if (environmentVariables?.length) {
    groups.push({
      key: ENVIRONMENT_VARIABLE_NODE_ID,
      label: 'environment',
      type: ENVIRONMENT_VARIABLE_NODE_ID,
      options: environmentVariables.map((v) => ({
        selector: [ENVIRONMENT_VARIABLE_NODE_ID, v.name],
        name: v.name,
        type: v.value_type,
      })),
    })
  }

  if (conversationVariables?.length) {
    groups.push({
      key: CONVERSATION_VARIABLE_NODE_ID,
      label: 'conversation',
      type: CONVERSATION_VARIABLE_NODE_ID,
      options: conversationVariables.map((v) => ({
        selector: [CONVERSATION_VARIABLE_NODE_ID, v.name],
        name: v.name,
        type: v.value_type,
      })),
    })
  }

  return groups
}

/** 把 selector 显示成「节点标题 · 输出名」；找不到时回落到原始 id */
export function describeSelector(
  selector: ValueSelector | undefined,
  nodes: DslNode[],
  namespaceLabels: Record<string, string> = {},
): string {
  if (!selector || selector.length < 2) return ''
  const [nodeId, ...rest] = selector
  const namespaceLabel = namespaceLabels[nodeId]
  if (namespaceLabel) return `${namespaceLabel} · ${rest.join('.')}`
  const node = nodes.find((n) => n.id === nodeId)
  const nodeLabel = node ? (node.data.title || String(node.data.type)) : nodeId
  return `${nodeLabel} · ${rest.join('.')}`
}
