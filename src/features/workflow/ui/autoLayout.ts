/**
 * 自动布局（分层）
 *
 * 复刻 Dify 的做法（web/app/components/workflow/utils/elk-layout.ts +
 * use-workflow-organize.helpers.ts 的两遍布局）：
 *  1. 根层：只排没有 parentId 的节点，容器内部的边不参与，容器本身当作一个节点；
 *  2. 子层：每个容器单独排自己的子节点（含容器入口节点），坐标相对容器左上角。
 * 只算坐标，不改动节点本身。
 */

import type { DslEdge, DslNode, XYPosition } from '../dsl/types'

const DEFAULT_WIDTH = 244
const DEFAULT_HEIGHT = 90
const GAP_X = 130
const GAP_Y = 40
const PADDING_X = 80
const PADDING_Y = 80

export interface LayoutOptions {
  gapX?: number
  gapY?: number
  paddingX?: number
  paddingY?: number
}

/** 计算每个节点的层号：层号 = 从根节点出发的最长路径长度 */
function computeLayers(nodes: DslNode[], edges: DslEdge[]): Map<string, number> {
  const indegree = new Map<string, number>()
  const successors = new Map<string, string[]>()
  for (const node of nodes) {
    indegree.set(node.id, 0)
    successors.set(node.id, [])
  }
  for (const edge of edges) {
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) continue
    successors.get(edge.source)?.push(edge.target)
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
  }

  const layer = new Map<string, number>()
  const processed = new Set<string>()
  const queue: string[] = []
  for (const node of nodes) {
    if ((indegree.get(node.id) ?? 0) === 0) {
      queue.push(node.id)
      layer.set(node.id, 0)
    }
  }

  // 无根（纯环图）时给所有节点兜底层号 0，保证不会漏排
  if (!queue.length) {
    for (const node of nodes) layer.set(node.id, 0)
    return layer
  }

  while (queue.length) {
    const id = queue.shift() as string
    if (processed.has(id)) continue
    processed.add(id)
    const current = layer.get(id) ?? 0
    for (const next of successors.get(id) ?? []) {
      layer.set(next, Math.max(layer.get(next) ?? 0, current + 1))
      indegree.set(next, (indegree.get(next) ?? 0) - 1)
      if ((indegree.get(next) ?? 0) <= 0) queue.push(next)
    }
  }

  // 环上残留的节点按已有前驱 +1，保证排在后面而不是覆盖到第 0 层
  for (const node of nodes) {
    if (!layer.has(node.id)) {
      const preds = edges.filter((e) => e.target === node.id).map((e) => layer.get(e.source) ?? 0)
      layer.set(node.id, preds.length ? Math.max(...preds) + 1 : 0)
    }
  }
  return layer
}

/**
 * 层内排序：按 DFS（跟随出边顺序）确定稳定顺序。
 * 出边顺序对分支节点（条件分支 / 问题分类器）按 case / class 声明顺序排，
 * 与 Dify「端口顺序 → 模型顺序」的做法一致，保证同一分支的子图聚在一起。
 */
function orderByDfs(nodes: DslNode[], edges: DslEdge[]): Map<string, number> {
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const outgoing = new Map<string, DslEdge[]>()
  for (const edge of edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue
    const list = outgoing.get(edge.source)
    if (list) list.push(edge)
    else outgoing.set(edge.source, [edge])
  }
  for (const [id, list] of outgoing) outgoing.set(id, orderOutEdges(nodeById.get(id), list))

  const visited = new Set<string>()
  const order: string[] = []
  const dfs = (id: string): void => {
    if (visited.has(id) || !nodeById.has(id)) return
    visited.add(id)
    order.push(id)
    for (const edge of outgoing.get(id) ?? []) dfs(edge.target)
  }
  for (const node of nodes) {
    if (!edges.some((e) => e.target === node.id)) dfs(node.id)
  }
  for (const node of nodes) dfs(node.id)
  return new Map(order.map((id, index) => [id, index]))
}

/** 分支节点的出边按 case / class 声明顺序排序（非分支节点保持原顺序） */
function orderOutEdges(node: DslNode | undefined, list: DslEdge[]): DslEdge[] {
  const data = (node?.data ?? {}) as Record<string, unknown>
  const cases = Array.isArray(data.cases) ? (data.cases as Array<{ case_id?: string }>) : []
  const classes = Array.isArray(data.classes) ? (data.classes as Array<{ id?: string }>) : []
  if (!cases.length && !classes.length) return list
  const rank = (handle: string | undefined): number => {
    const key = String(handle ?? '')
    const caseIndex = cases.findIndex((item) => item.case_id === key)
    if (caseIndex >= 0) return caseIndex
    const classIndex = classes.findIndex((item) => item.id === key)
    if (classIndex >= 0) return classIndex
    return key === 'false' ? 900 : 1000
  }
  return [...list].sort((a, b) => rank(a.sourceHandle) - rank(b.sourceHandle))
}

/** 计算布局坐标（不改动传入节点） */
export function layoutGraph(nodes: DslNode[], edges: DslEdge[], options: LayoutOptions = {}): Map<string, XYPosition> {
  const result = new Map<string, XYPosition>()
  if (!nodes.length) return result

  const gapX = options.gapX ?? GAP_X
  const gapY = options.gapY ?? GAP_Y
  const paddingX = options.paddingX ?? PADDING_X
  const paddingY = options.paddingY ?? PADDING_Y

  const layers = computeLayers(nodes, edges)
  const orderIndex = orderByDfs(nodes, edges)

  const groups = new Map<number, DslNode[]>()
  for (const node of nodes) {
    const layer = layers.get(node.id) ?? 0
    const list = groups.get(layer)
    if (list) list.push(node)
    else groups.set(layer, [node])
  }
  for (const list of groups.values()) {
    list.sort((a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0))
  }

  const layerKeys = Array.from(groups.keys()).sort((a, b) => a - b)
  const widthOfNode = (node: DslNode): number => (node.width && node.width > 0 ? node.width : DEFAULT_WIDTH)
  const heightOfNode = (node: DslNode): number => (node.height && node.height > 0 ? node.height : DEFAULT_HEIGHT)

  // 层宽取层内最宽的节点，层内按各节点自身高度纵向堆叠
  const layerX = new Map<number, number>()
  const bandHeight = new Map<number, number>()
  let cursorX = paddingX
  for (const key of layerKeys) {
    const list = groups.get(key) as DslNode[]
    layerX.set(key, cursorX)
    cursorX += Math.max(...list.map(widthOfNode)) + gapX
    bandHeight.set(key, list.reduce((sum, node, index) => sum + heightOfNode(node) + (index > 0 ? gapY : 0), 0))
  }

  // 各层在竖直方向整体居中（对齐 Dify 的层内居中）
  const maxBand = Math.max(...bandHeight.values())
  for (const key of layerKeys) {
    const list = groups.get(key) as DslNode[]
    let cursorY = paddingY + (maxBand - (bandHeight.get(key) as number)) / 2
    for (const node of list) {
      result.set(node.id, { x: Math.round(layerX.get(key) as number), y: Math.round(cursorY) })
      cursorY += heightOfNode(node) + gapY
    }
  }

  return result
}
