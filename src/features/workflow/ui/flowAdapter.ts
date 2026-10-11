/**
 * Dify DSL ↔ Vue Flow 的图形适配
 *
 * 两者都是 ReactFlow 谱系，差异只有三处，全部在此收敛：
 * 1. 容器归属：Dify 用 `parentId`，Vue Flow 用 `parentNode`
 * 2. 端口位置：Dify 存 `sourcePosition/targetPosition` 字符串，Vue Flow 用 `Position` 枚举
 * 3. 边类型：Dify 写死 `type: custom`，画布渲染用 Vue Flow 的贝塞尔边
 */

import { Position, type Edge, type Node } from '@vue-flow/core'
import type { BaseNodeData, DslEdge, DslGraph, DslNode } from '../dsl/types'
import { isContainerType } from '../dsl/container'
import { nodeWrapperType } from '../dsl/validator'

/** 容器（迭代 / 循环）卡片的 z-index：压在连线层之下，保证容器内部连线可见 */
const CONTAINER_Z_INDEX = -1

/** 画布上所有 Dify 节点共用一个组件，节点差异由 data.type 决定 */
export const FLOW_NODE_TYPE = 'dify'

const DEFAULT_WIDTH = 244
const DEFAULT_HEIGHT = 90

export interface DifyFlowNodeData {
  /** Dify 节点的 data 原样持有，不做字段搬移 */
  dsl: BaseNodeData
}

export type DifyFlowNode = Node<DifyFlowNodeData>

/** 文档 → 画布 */
export function toFlowGraph(document: { workflow: { graph: DslGraph } }): { nodes: DifyFlowNode[]; edges: Edge[] } {
  const graph = document.workflow.graph
  return {
    nodes: graph.nodes.map(toFlowNode),
    edges: graph.edges.map(toFlowEdge),
  }
}

export function toFlowNode(node: DslNode): DifyFlowNode {
  const flow: DifyFlowNode = {
    id: node.id,
    type: FLOW_NODE_TYPE,
    position: { ...node.position },
    data: { dsl: node.data },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
  }
  if (node.parentId) flow.parentNode = node.parentId
  if (isContainerType(String(node.data.type))) {
    // 容器卡片压到连线层之下，否则容器内部的连线会被卡片挡住看不见
    flow.zIndex = CONTAINER_Z_INDEX
  } else if (node.zIndex !== undefined) {
    flow.zIndex = node.zIndex
  }
  if (node.draggable === false) flow.draggable = false
  if (node.selectable === false) flow.selectable = false
  flow.style = {
    width: `${node.width ?? DEFAULT_WIDTH}px`,
    ...(node.height ? { height: `${node.height}px` } : {}),
  }
  return flow
}

export function toFlowEdge(edge: DslEdge): Edge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    zIndex: edge.zIndex ?? 0,
    data: { ...edge.data },
  }
}

/**
 * 画布 → 文档。
 * previous 用来保留 wrapper 上的非几何字段（zIndex / draggable / selectable / 尺寸 / 视口），
 * 否则每次保存都会把 Dify 原有信息抹平。
 */
/** 从画布节点的 style 读尺寸（保存时用，保证容器尺寸不丢；不读 Vue Flow 的实测尺寸以免脏标记抖动） */
function sizeOf(flow: DifyFlowNode): { width: number; height: number } {
  const style = flow.style
  const raw = style && typeof style === 'object' ? (style as { width?: string | number; height?: string | number }) : {}
  const width = Number.parseFloat(String(raw.width ?? ''))
  const height = Number.parseFloat(String(raw.height ?? ''))
  return {
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : DEFAULT_WIDTH,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : DEFAULT_HEIGHT,
  }
}

export function toDslGraph(
  flowNodes: DifyFlowNode[],
  flowEdges: Edge[],
  previous?: DslGraph,
): DslGraph {
  const prevNodes = new Map((previous?.nodes ?? []).map((n) => [n.id, n]))
  const prevEdges = new Map((previous?.edges ?? []).map((e) => [e.id, e]))

  const nodes: DslNode[] = flowNodes.map((flow) => {
    const prev = prevNodes.get(flow.id)
    const data: BaseNodeData = flow.data?.dsl ?? { type: 'unknown', title: '' }
    const position = { x: Math.round(flow.position.x), y: Math.round(flow.position.y) }
    const parentId = flow.parentNode ?? prev?.parentId
    const size = sizeOf(flow)
    const node: DslNode = {
      type: nodeWrapperType(data.type),
      id: flow.id,
      position,
      positionAbsolute: position,
      width: size.width || prev?.width || DEFAULT_WIDTH,
      height: size.height || prev?.height || DEFAULT_HEIGHT,
      sourcePosition: 'right',
      targetPosition: 'left',
      selected: false,
      data,
    }
    if (parentId) node.parentId = parentId
    if (prev?.zIndex !== undefined) node.zIndex = prev.zIndex
    // 画布上的不可拖拽 / 不可选中标记优先（容器入口节点由画布决定，不依赖上一次的图）
    if (flow.draggable === false || prev?.draggable === false) node.draggable = false
    if (flow.selectable === false || prev?.selectable === false) node.selectable = false
    return node
  })

  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const edges: DslEdge[] = flowEdges.map((flow) => {
    const prev = prevEdges.get(flow.id)
    const sourceNode = nodeById.get(flow.source)
    const targetNode = nodeById.get(flow.target)
    const container = nodeById.get(sourceNode?.parentId ?? targetNode?.parentId ?? '')
    const inLoop = container?.data.type === 'loop'
    return {
      id: flow.id,
      source: flow.source,
      target: flow.target,
      sourceHandle: flow.sourceHandle ?? prev?.sourceHandle ?? 'source',
      targetHandle: flow.targetHandle ?? prev?.targetHandle ?? 'target',
      type: 'custom',
      zIndex: prev?.zIndex ?? 0,
      data: {
        sourceType: String(sourceNode?.data.type ?? prev?.data.sourceType ?? ''),
        targetType: String(targetNode?.data.type ?? prev?.data.targetType ?? ''),
        isInIteration: container ? !inLoop : (prev?.data.isInIteration ?? false),
        iteration_id: container && !inLoop ? container.id : (prev?.data.iteration_id ?? null),
        isInLoop: container ? inLoop : (prev?.data.isInLoop ?? false),
        loop_id: container && inLoop ? container.id : (prev?.data.loop_id ?? null),
      },
    }
  })

  const graph: DslGraph = { nodes, edges }
  if (previous?.viewport) graph.viewport = { ...previous.viewport }
  return graph
}
