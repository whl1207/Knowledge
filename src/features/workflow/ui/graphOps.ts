/**
 * 画布图操作：增删节点、连线（含环检测）、复制、自动布局
 *
 * 全部操作只改 Vue Flow 的 nodes/edges（内存），由编辑器的保存流程落成 Dify DSL。
 */

import type { Edge } from '@vue-flow/core'
import type { InjectionKey } from 'vue'
import type { DslEdge, DslNode, NodeWrapperType, XYPosition } from '../dsl/types'
import { nodeWrapperType } from '../dsl/validator'
import { createNodeId } from '../dsl/defaults'
import { getNodeDefaults, SINGLETON_TYPES } from '../nodes/registry'
import { makeEdgeId } from '../dsl/validator'
import { FLOW_NODE_TYPE, toFlowEdge, toFlowNode, type DifyFlowNode } from './flowAdapter'
import { containerEntryId, isContainerType } from '../dsl/container'
import { layoutGraph } from './autoLayout'

const DEFAULT_WIDTH = 244
const DEFAULT_HEIGHT = 90
/** 容器默认尺寸（创建时） */
export const CONTAINER_WIDTH = 520
export const CONTAINER_HEIGHT = 280
/** 容器入口节点尺寸 */
export const CONTAINER_ENTRY_WIDTH = 150
export const CONTAINER_ENTRY_HEIGHT = 46
/** 容器内边距（自适应大小时用） */
const CONTAINER_PADDING = 24
const CONTAINER_HEADER = 44

export interface GraphOpsContext {
  nodes: DifyFlowNode[]
  edges: Edge[]
  /** 节点名称解析（按类型取本地化名） */
  nodeTitle: (type: string) => string
  /** 是否只读 */
  readonly?: boolean
}

/** 生成一个新节点（不插入） */
export function createDifyNode(
  type: string,
  position: { x: number; y: number },
  title: string,
  existing: DifyFlowNode[] = [],
): DifyFlowNode {
  const id = createNodeId(existing.map((n) => n.id))
  const isContainer = isContainerType(type)
  const data = {
    type,
    title,
    desc: '',
    version: '1',
    'x-ai-km': { origin: 'native' },
    ...getNodeDefaults(type),
  }
  const dslNode: DslNode = {
    type: nodeWrapperType(type) as NodeWrapperType,
    id,
    position,
    positionAbsolute: position,
    width: isContainer ? CONTAINER_WIDTH : DEFAULT_WIDTH,
    height: isContainer ? CONTAINER_HEIGHT : DEFAULT_HEIGHT,
    data: data as DslNode['data'],
  }
  return toFlowNode(dslNode)
}

/**
 * 生成容器的入口节点（`<容器id>start`）。
 * 它不参与画布常规操作（不可拖拽 / 不可选中），由容器执行器驱动写入 item / index。
 */
export function createContainerEntry(container: DifyFlowNode): DifyFlowNode | null {
  const containerType = String(container.data?.dsl?.type ?? '')
  if (!isContainerType(containerType)) return null
  const entryType = containerType === 'iteration' ? 'iteration-start' : 'loop-start'
  const id = containerEntryId(container.id)
  const dslNode: DslNode = {
    type: containerType === 'iteration' ? 'custom-iteration-start' : 'custom-loop-start',
    id,
    position: { x: CONTAINER_PADDING, y: CONTAINER_HEADER },
    positionAbsolute: { x: container.position.x + CONTAINER_PADDING, y: container.position.y + CONTAINER_HEADER },
    width: CONTAINER_ENTRY_WIDTH,
    height: CONTAINER_ENTRY_HEIGHT,
    parentId: container.id,
    draggable: false,
    selectable: false,
    data: { type: entryType, title: entryType === 'iteration-start' ? '迭代入口' : '循环入口', desc: '', version: '1' } as DslNode['data'],
  }
  const flow = toFlowNode(dslNode)
  flow.draggable = false
  flow.selectable = false
  flow.zIndex = 1
  return flow
}

/** Vue Flow 要求父节点排在子节点之前 */
export function sortNodesByParent(nodes: DifyFlowNode[]): DifyFlowNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const visited = new Set<string>()
  const result: DifyFlowNode[] = []
  const visit = (node: DifyFlowNode): void => {
    if (visited.has(node.id)) return
    const parent = node.parentNode ? byId.get(node.parentNode) : undefined
    if (parent) visit(parent)
    visited.add(node.id)
    result.push(node)
  }
  for (const node of nodes) visit(node)
  return result
}

/** 节点当前宽度（样式里的 px 优先） */
function widthOf(node: DifyFlowNode): number {
  const style = node.style
  const raw = style && typeof style === 'object' ? (style as { width?: string | number }).width : undefined
  const parsed = Number.parseFloat(String(raw ?? ''))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WIDTH
}

/** 节点当前高度 */
function heightOf(node: DifyFlowNode): number {
  const style = node.style
  const raw = style && typeof style === 'object' ? (style as { height?: string | number }).height : undefined
  const parsed = Number.parseFloat(String(raw ?? ''))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HEIGHT
}

/** 节点当前尺寸（无显式尺寸时给默认值），供拖拽缩放手柄使用 */
export function nodeSize(node: DifyFlowNode): { width: number; height: number } {
  return { width: widthOf(node), height: heightOf(node) }
}

/**
 * 容器节点（迭代 / 循环）手动缩放的注入契约：
 * 卡片渲染右下角手柄，按下时交回编辑器接管拖拽（编辑器才知道当前缩放比例）。
 */
export const CONTAINER_RESIZE_KEY: InjectionKey<{ start: (nodeId: string, event: PointerEvent) => void }> =
  Symbol('ai-km-container-resize')

/** 容器手动缩放下限 */
export const CONTAINER_MIN_WIDTH = 220
export const CONTAINER_MIN_HEIGHT = 140

/** 设置节点尺寸（同时写入 style，保证画布与导出都用同一份尺寸） */
export function resizeNode(node: DifyFlowNode, width: number, height: number): DifyFlowNode {
  return {
    ...node,
    style: { ...(typeof node.style === 'object' ? node.style : {}), width: `${Math.round(width)}px`, height: `${Math.round(height)}px` },
  }
}

/** 容器内边距（子节点与容器边界的留白，对齐 Dify 的 NODE_LAYOUT_*_PADDING） */
const CONTAINER_CONTENT_PADDING = 60

/**
 * 依据子节点重新计算容器尺寸：只增不减——以容器当前尺寸为下限，
 * 保证手动拖动调整过的容器不会被自动布局缩小。
 */
export function fitContainers(nodes: DifyFlowNode[]): DifyFlowNode[] {
  const childrenByParent = new Map<string, DifyFlowNode[]>()
  for (const node of nodes) {
    if (!node.parentNode) continue
    const list = childrenByParent.get(node.parentNode)
    if (list) list.push(node)
    else childrenByParent.set(node.parentNode, [node])
  }

  return nodes.map((node) => {
    if (!isContainerType(String(node.data?.dsl?.type ?? ''))) return node
    const children = childrenByParent.get(node.id) ?? []
    let maxRight = CONTAINER_ENTRY_WIDTH + CONTAINER_CONTENT_PADDING + CONTAINER_PADDING
    let maxBottom = CONTAINER_HEADER + CONTAINER_ENTRY_HEIGHT + CONTAINER_CONTENT_PADDING
    for (const child of children) {
      maxRight = Math.max(maxRight, child.position.x + widthOf(child) + CONTAINER_CONTENT_PADDING)
      maxBottom = Math.max(maxBottom, child.position.y + heightOf(child) + CONTAINER_CONTENT_PADDING)
    }
    const width = Math.max(CONTAINER_WIDTH, maxRight, widthOf(node))
    const height = Math.max(CONTAINER_HEIGHT, maxBottom, heightOf(node))
    if (width === widthOf(node) && height === heightOf(node)) return node
    return resizeNode(node, width, height)
  })
}

/**
 * 根据位置把根级节点收进容器 / 把子节点移出容器。
 * 仅处理「中心点落在容器矩形内」这一条规则，避免拖拽时反复抖动。
 */
export function applyContainment(nodes: DifyFlowNode[]): DifyFlowNode[] {
  const containers = nodes.filter((n) => isContainerType(String(n.data?.dsl?.type ?? '')))
  if (!containers.length) return nodes

  const containerById = new Map(containers.map((n) => [n.id, n]))
  return nodes.map((node) => {
    if (isContainerType(String(node.data?.dsl?.type ?? ''))) return node
    // 容器入口节点永远留在容器内
    if (node.parentNode && node.id.endsWith('start') && containerById.has(node.parentNode)) return node

    const width = widthOf(node)
    const height = heightOf(node)
    const parent = node.parentNode ? containerById.get(node.parentNode) : undefined
    const absoluteX = (parent?.position.x ?? 0) + node.position.x
    const absoluteY = (parent?.position.y ?? 0) + node.position.y
    const centerX = absoluteX + width / 2
    const centerY = absoluteY + height / 2

    const target = containers.find((container) => {
      if (container.id === node.id) return false
      const cw = widthOf(container)
      const ch = heightOf(container)
      return centerX >= container.position.x && centerX <= container.position.x + cw
        && centerY >= container.position.y && centerY <= container.position.y + ch
    })

    if (target && node.parentNode !== target.id) {
      return {
        ...node,
        parentNode: target.id,
        position: { x: absoluteX - target.position.x, y: absoluteY - target.position.y },
      }
    }
    if (!target && node.parentNode) {
      const current = containerById.get(node.parentNode)
      return {
        ...node,
        parentNode: undefined,
        position: { x: current ? current.position.x + node.position.x : absoluteX, y: current ? current.position.y + node.position.y : absoluteY },
      }
    }
    return node
  })
}

/** 该类型是否还能再添加（开始 / 结束唯一） */
export function canAddType(type: string, nodes: DifyFlowNode[]): boolean {
  if (!SINGLETON_TYPES.includes(type)) return true
  const types = nodes.map((n) => String(n.data?.dsl?.type ?? ''))
  if (type === 'start') return !types.includes('start') && !types.includes('start-placeholder')
  return !types.includes('end')
}

/** 建立连线（含自环 / 重复 / 成环校验） */
export function buildEdge(
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
  nodes: DifyFlowNode[],
  edges: Edge[],
): Edge | null {
  if (!source || !target || source === target) return null
  if (edges.some((e) => e.source === source && e.target === target && e.sourceHandle === sourceHandle)) return null
  if (createsCycle(source, target, edges)) return null

  const sourceNode = nodes.find((n) => n.id === source)
  const targetNode = nodes.find((n) => n.id === target)
  const dslEdge: DslEdge = {
    id: makeEdgeId(source, sourceHandle || 'source', target, targetHandle || 'target'),
    source,
    target,
    sourceHandle: sourceHandle || 'source',
    targetHandle: targetHandle || 'target',
    type: 'custom',
    zIndex: 0,
    data: {
      sourceType: String(sourceNode?.data?.dsl?.type ?? ''),
      targetType: String(targetNode?.data?.dsl?.type ?? ''),
      isInIteration: false,
      iteration_id: null,
      isInLoop: false,
      loop_id: null,
    },
  }
  const edge = toFlowEdge(dslEdge)
  // 落在容器内部时补容器归属，与校验器的归一化保持一致
  const containerId = sourceNode?.parentNode ?? targetNode?.parentNode
  if (containerId) {
    const container = nodes.find((n) => n.id === containerId)
    const inLoop = container?.data?.dsl?.type === 'loop'
    edge.data = {
      ...dslEdge.data,
      isInIteration: !inLoop,
      iteration_id: inLoop ? null : containerId,
      isInLoop: inLoop,
      loop_id: inLoop ? containerId : null,
    }
  }
  return edge
}

/** 新增一条 source → target 是否会成环 */
function createsCycle(source: string, target: string, edges: Edge[]): boolean {
  // 从 target 出发能否回到 source
  const outgoing = new Map<string, string[]>()
  for (const edge of edges) {
    const list = outgoing.get(edge.source)
    if (list) list.push(edge.target)
    else outgoing.set(edge.source, [edge.target])
  }
  const stack = [target]
  const visited = new Set<string>()
  while (stack.length) {
    const id = stack.pop() as string
    if (id === source) return true
    if (visited.has(id)) continue
    visited.add(id)
    for (const next of outgoing.get(id) ?? []) stack.push(next)
  }
  return false
}

/** 节点当前宽度（样式里的 px 值优先，回落默认宽度） */
function nodeWidth(node: DifyFlowNode): number {
  return widthOf(node)
}

/** 节点当前高度（样式 height 优先，其次 Vue Flow 实测尺寸） */
function nodeHeight(node: DifyFlowNode): number {
  const style = node.style
  const raw = style && typeof style === 'object' ? (style as { height?: string | number }).height : undefined
  const parsed = Number.parseFloat(String(raw ?? ''))
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  const dimensions = (node as unknown as { dimensions?: { height?: number } }).dimensions
  const measured = Number(dimensions?.height)
  return Number.isFinite(measured) && measured > 0 ? measured : DEFAULT_HEIGHT
}

/**
 * 应用自动布局，返回新的节点数组（不改原数组）。
 *
 * 与 Dify 一致地分三步（对应 getLayoutForChildNodes → getContainerSizeChanges → getLayoutByELK）：
 *  1. 先排每个容器的子节点（坐标相对容器），据此把容器放大到能装下子节点；
 *  2. 根层用「放大后的容器尺寸」参与排布，容器内部的边不参与；
 *  3. 组装：根级节点用绝对坐标，容器子节点用相对坐标。
 */
export function applyAutoLayout(nodes: DifyFlowNode[], edges: Edge[]): DifyFlowNode[] {
  if (!nodes.length) return nodes

  const toDslNode = (node: DifyFlowNode): DslNode => ({
    type: nodeWrapperType(String(node.data?.dsl?.type ?? '')) as NodeWrapperType,
    id: node.id,
    position: node.position,
    width: widthOf(node),
    height: heightOf(node),
    data: (node.data?.dsl ?? { type: 'unknown', title: '' }) as DslNode['data'],
    ...(node.parentNode ? { parentId: node.parentNode } : {}),
  })
  const dslEdges: DslEdge[] = edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? 'source',
    targetHandle: edge.targetHandle ?? 'target',
    type: 'custom',
    data: (edge.data ?? { sourceType: '', targetType: '' }) as DslEdge['data'],
  }))
  const internalEdges = (ids: Set<string>): DslEdge[] => dslEdges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))

  // 1. 子层布局：得到子节点相对坐标 + 容器需要的尺寸（只增不减）
  const childLayouts = new Map<string, Map<string, XYPosition>>()
  const sized = nodes.map((node) => {
    if (node.parentNode || !isContainerType(String(node.data?.dsl?.type ?? ''))) return node
    const children = nodes.filter((child) => child.parentNode === node.id)
    if (!children.length) return node
    const childIds = new Set(children.map((child) => child.id))
    const positions = layoutGraph(children.map(toDslNode), internalEdges(childIds), {
      gapX: 100,
      gapY: 40,
      paddingX: CONTAINER_CONTENT_PADDING,
      paddingY: CONTAINER_CONTENT_PADDING,
    })
    childLayouts.set(node.id, positions)

    let maxRight = 0
    let maxBottom = 0
    for (const child of children) {
      const position = positions.get(child.id)
      if (!position) continue
      maxRight = Math.max(maxRight, position.x + widthOf(child))
      maxBottom = Math.max(maxBottom, position.y + heightOf(child))
    }
    const width = Math.max(CONTAINER_WIDTH, widthOf(node), maxRight + CONTAINER_CONTENT_PADDING)
    const height = Math.max(CONTAINER_HEIGHT, heightOf(node), maxBottom + CONTAINER_CONTENT_PADDING)
    return width === widthOf(node) && height === heightOf(node) ? node : resizeNode(node, width, height)
  })

  // 2. 根层布局：容器按放大后的尺寸参与，容器内部连线不参与
  const rootNodes = sized.filter((node) => !node.parentNode)
  const rootIds = new Set(rootNodes.map((node) => node.id))
  const rootPositions = layoutGraph(rootNodes.map(toDslNode), internalEdges(rootIds), { gapX: 140, gapY: 44 })

  // 3. 组装
  return sized.map((node) => {
    if (node.parentNode) {
      const position = childLayouts.get(node.parentNode)?.get(node.id)
      return position ? { ...node, position } : node
    }
    const position = rootPositions.get(node.id)
    return position ? { ...node, position } : node
  })
}

export { FLOW_NODE_TYPE }
