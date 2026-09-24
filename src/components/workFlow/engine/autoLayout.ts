/**
 * autoLayout - 工作流自动布局引擎
 *
 * 纯 TS 实现的分层布局算法，参考 Dify 的 ELK 布局思路但无需外部依赖。
 *
 * 算法：
 * 1. 最长路径分层（Longest-path layering）—— 每个节点离 Start 的最远距离为层号
 * 2. 决策分支分配独立车道（lane），同一分支的节点在垂直方向上对齐
 * 3. 层内垂直居中，避免重叠
 *
 * 输出：更新 items 中每个节点的 x/y 坐标
 */

import type { NodeData, Link } from '@/components/workFlow/engine/WorkflowRunner'
import { ensureMinNodeHeight } from '@/components/workFlow/WorkflowTypes'

// ── 间距配置（由 autoLayout 根据节点实际尺寸动态计算） ──

interface LayoutSpacing {
  layerGap: number      // 水平层间距
  nodeGap: number       // 垂直节点间距（同车道内）

  paddingX: number      // 左侧起始留白
  paddingY: number      // 顶部起始留白
  defW: number          // 节点默认宽度
  defH: number          // 节点默认高度
}

/** 根据节点集合计算动态间距（使用最大尺寸保证不重叠） */
function computeSpacing(items: NodeData[]): LayoutSpacing {
  // 先确保每个节点都有有效尺寸，且高度满足端口数要求
  let maxW = 250, maxH = 80
  for (const n of items) {
    ensureMinNodeHeight(n)                              // 端口数 → 最小高度
    const w = (n.width && n.width > 0) ? n.width : 250
    const h = (n.height && n.height > 0) ? n.height : 80
    n.width = w; n.height = h                           // 修复无效值
    if (w > maxW) maxW = w
    if (h > maxH) maxH = h
  }

  const gapBetweenLayers = Math.max(maxW * 0.35, 80)   // 层间净间隔
  const gapBetweenNodes = 24                           // 节点间净间隔（固定值，不受节点高度影响）

  return {
    layerGap: maxW + gapBetweenLayers,                 // 每层 X 步进 = 节点宽 + 层间隔
    nodeGap: maxH + gapBetweenNodes,                   // 每节点 Y 步进 = 节点高 + 节点间隔
    paddingX: Math.max(maxW * 0.25, 30),               // 左侧留白
    paddingY: Math.max(maxH * 0.6, 40),                // 顶部留白
    defW: maxW,
    defH: maxH,
  }
}

// ── 内部类型 ─────────────────────────────────────────────

interface LayoutNode {
  id: number
  width: number
  height: number
  layer: number      // 层号（从 0 开始）
  lane: number       // 车道号（同一层内垂直位置）
  branchRoot: number // 所属分支根节点 ID（决策节点自身或其后继）
}

// ── 主入口 ───────────────────────────────────────────────

export interface LayoutResult {
  items: NodeData[]
  message?: string
}

/**
 * 对工作流节点执行自动布局
 */
export function autoLayout(items: NodeData[], links: Link[]): LayoutResult {
  if (items.length === 0) return { items }

  const startNode = items.find(n => n.type === 'start')
  if (!startNode) return { items, message: '缺少开始节点' }

  // 根据节点实际尺寸计算间距
  const spacing = computeSpacing(items)

  // 1. 构建邻接表
  const successors = new Map<number, number[]>()
  const predecessors = new Map<number, number[]>()
  for (const n of items) {
    successors.set(n.id, [])
    predecessors.set(n.id, [])
  }
  for (const l of links) {
    successors.get(l.source)?.push(l.target)
    predecessors.get(l.target)?.push(l.source)
  }

  // 2. 最长路径分层（拓扑顺序保证 DAG）
  const layers = computeLayers(items, links, successors, startNode.id)

  // 3. 为决策分支分配车道
  const laneMap = assignLanes(items, links, successors, layers)

  // 4. 计算每个节点的具体坐标
  const positions = computePositions(items, layers, laneMap, spacing)

  // 5. 更新节点位置
  for (const node of items) {
    const pos = positions.get(node.id)
    if (pos) {
      node.x = pos.x
      node.y = pos.y
    }
  }

  return { items }
}

// ── 步骤 2：最长路径分层 ─────────────────────────────────

function computeLayers(
  items: NodeData[],
  links: Link[],
  successors: Map<number, number[]>,
  startId: number,
): Map<number, number> {
  const layers = new Map<number, number>()

  // 拓扑排序（Kahn 算法）
  const inDegree = new Map<number, number>()
  for (const n of items) inDegree.set(n.id, 0)
  for (const l of links) {
    inDegree.set(l.target, (inDegree.get(l.target) || 0) + 1)
  }

  const queue: number[] = []
  const topoOrder: number[] = []

  // 入度为 0 的节点入队（可能有多个孤立节点）
  for (const n of items) {
    if ((inDegree.get(n.id) || 0) === 0) queue.push(n.id)
  }

  while (queue.length > 0) {
    const id = queue.shift()!
    topoOrder.push(id)
    for (const next of successors.get(id) || []) {
      const deg = (inDegree.get(next) || 1) - 1
      inDegree.set(next, deg)
      if (deg === 0) queue.push(next)
    }
  }

  // 不在拓扑序中的节点（环内或有问题的）追加到末尾
  for (const n of items) {
    if (!topoOrder.includes(n.id)) topoOrder.push(n.id)
  }

  // 最长路径计算层号
  layers.set(startId, 0)
  for (const id of topoOrder) {
    const currentLayer = layers.get(id) ?? 0
    for (const next of successors.get(id) || []) {
      const nextLayer = Math.max(layers.get(next) ?? 0, currentLayer + 1)
      layers.set(next, nextLayer)
    }
  }

  return layers
}

// ── 步骤 3：分配车道 ─────────────────────────────────────

function assignLanes(
  items: NodeData[],
  links: Link[],
  successors: Map<number, number[]>,
  layers: Map<number, number>,
): Map<number, number> {
  const laneMap = new Map<number, number>()
  const visited = new Set<number>()

  function getOutEdges(nodeId: number) {
    return links.filter(l => l.source === nodeId)
  }

  function dfs(nodeId: number, suggestedLane: number) {
    if (visited.has(nodeId)) {
      // 汇聚节点：取更大的车道（避免与分支重叠）
      const current = laneMap.get(nodeId) ?? 0
      if (suggestedLane > current) laneMap.set(nodeId, suggestedLane)
      return
    }
    visited.add(nodeId)

    const node = items.find(n => n.id === nodeId)
    if (!node) return

    // 汇聚节点（入度 > 1）：取所有前驱的最大车道
    const inEdges = links.filter(l => l.target === nodeId)
    let finalLane = suggestedLane
    if (inEdges.length > 1) {
      const predLanes = inEdges.map(e => laneMap.get(e.source) ?? 0)
      finalLane = Math.max(...predLanes, suggestedLane)
    } else if (inEdges.length === 1) {
      // 单前驱：使用建议车道（已包含上级节点的分支分配）
      finalLane = suggestedLane
    }

    laneMap.set(nodeId, finalLane)

    const outEdges = getOutEdges(nodeId)
    if (outEdges.length === 0) return

    if (node.type === 'decision') {
      // 决策节点：每个分支一条独立车道
      const branches = node.decisionBranches || []
      const sorted = [...outEdges].sort((a, b) => {
        const ia = branches.findIndex(br => br.id === a.branch)
        const ib = branches.findIndex(br => br.id === b.branch)
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
      })
      for (let i = 0; i < sorted.length; i++) {
        dfs(sorted[i].target, finalLane + i + 1)
      }
    } else if (outEdges.length > 1) {
      // 平行多路径：每个后继分配不同车道
      for (let i = 0; i < outEdges.length; i++) {
        dfs(outEdges[i].target, finalLane + i + 1)
      }
    } else {
      // 单后继：继承车道
      dfs(outEdges[0].target, finalLane)
    }
  }

  const startNode = items.find(n => n.type === 'start')
  if (startNode) dfs(startNode.id, 0)

  // 孤立节点
  let fallback = 0
  for (const n of items) {
    if (!laneMap.has(n.id)) laneMap.set(n.id, fallback++)
  }

  return laneMap
}

// ── 步骤 4：计算坐标 ─────────────────────────────────────

function computePositions(
  items: NodeData[],
  layers: Map<number, number>,
  laneMap: Map<number, number>,
  sp: LayoutSpacing,
): Map<number, { x: number; y: number }> {
  // 按层、车道分组：layer_lane → [nodes]
  const layerLanes = new Map<string, NodeData[]>()
  for (const node of items) {
    const layer = layers.get(node.id) ?? 0
    const lane = laneMap.get(node.id) ?? 0
    const key = `${layer}_${lane}`
    if (!layerLanes.has(key)) layerLanes.set(key, [])
    layerLanes.get(key)!.push(node)
  }

  // 1. 固定节点间净间距（与节点高度无关）
  const gapBetween = sp.nodeGap - sp.defH    // = 24（固定值）

  // 2. 【核心改动】：直接计算每一层内所有节点的 Y 坐标
  // 我们放弃复杂的“车道堆叠”逻辑，改为提取每一层内所有节点的最大高度，然后等距排列
  const layerMaxY = new Map<number, number>()
  const positions = new Map<number, { x: number; y: number }>()

  // 先把所有节点粗略分配 X 坐标
  for (const node of items) {
    const layer = layers.get(node.id) ?? 0
    const x = sp.paddingX + layer * sp.layerGap
    // 暂时存一个未对齐的 Y，稍后统一微调
    positions.set(node.id, { x, y: 0 })
  }

  // 3. 【核心改动】：按“车道”和“父子关系”计算 Y 坐标，且不提前占据空间
  // 遍历所有节点，根据它们所在的层级计算 Y
  // 对每一层，我们只需保证节点上下不重叠即可，不再受“前面车道”的影响
  
  // 第一步：按层收集所有的节点 ID
  const nodesByLayer = new Map<number, number[]>()
  for (const node of items) {
    const layer = layers.get(node.id) ?? 0
    if (!nodesByLayer.has(layer)) nodesByLayer.set(layer, [])
    nodesByLayer.get(layer)!.push(node.id)
  }

  // 第二步：按层从上到下计算
  let globalY = sp.paddingY
  // 找出最大层数
  const maxLayer = Math.max(...Array.from(layers.values()))

  for (let layer = 0; layer <= maxLayer; layer++) {
    const nodeIds = nodesByLayer.get(layer) || []
    if (nodeIds.length === 0) continue

    // 获取当前层所有节点的实际高度，找出最高的一列，作为当前层的基础高度
    let layerMaxNodeHeight = 0
    const layerNodes: NodeData[] = []
    for (const id of nodeIds) {
      const node = items.find(n => n.id === id)!
      layerNodes.push(node)
      const h = node.height || sp.defH
      if (h > layerMaxNodeHeight) layerMaxNodeHeight = h
    }

    // 为了最大程度垂直紧凑，我们将这一层内的所有节点进行垂直堆叠，
    // 但为了让“第三列”不出现断层，我们按照它们所属的“车道(lane)”顺序垂直排列。
    // 注意：这里的“车道”仅用于同一层内节点之间的相对顺序。
    layerNodes.sort((a, b) => (laneMap.get(a.id) || 0) - (laneMap.get(b.id) || 0))

    let currentY = globalY
    for (const node of layerNodes) {
      const pos = positions.get(node.id)!
      pos.y = currentY
      // 步进 = 当前节点高度 + 固定间距
      currentY += (node.height || sp.defH) + gapBetween
    }

    // 这一层的总高度计算完毕，更新全局 Y，准备处理下一层
    // 注意：这里使用了当前层的最大高度来确定下一层的起始位，保证层与层之间不重叠
    globalY = currentY 
  }

  // 4. 返回最终的坐标
  return positions
}
