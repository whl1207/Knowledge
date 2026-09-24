// GraphRAG 风格的多跳检索工具
// 参考 GraphRAG Local Search 的实体图扩展 (hop expansion)

export interface HopNode {
  id: string
  name: string
  hop: number          // 0=种子, 1=1跳邻居, 2=2跳邻居...
  path: string[]       // 从种子到该节点的推理路径（实体名）
  viaRelation: string  // 到达该节点经过的关系类型
}

export interface MultiHopExpandOptions {
  seedEntities: Array<{ id: string; name: string }>
  entities: Array<{ id: string; name: string }>
  relations: Array<{ source: string; target: string; type: string }>
  maxHops: number
  maxPerHop: number
}

export interface MultiHopExpandResult {
  /** hop → 该跳的实体列表 */
  hops: Map<number, HopNode[]>
  /** 去重后的所有关联实体（含种子） */
  allNodes: HopNode[]
  /** 推理路径描述（用于 prompt） */
  paths: string[]
}

/**
 * 在实体图上做 BFS 多跳扩展
 *
 * hop 0: 种子实体
 * hop 1: 与种子直接相连的实体
 * hop 2: 与 hop1 相连的实体（且未访问过）
 * ...
 */
export function multiHopExpand(options: MultiHopExpandOptions): MultiHopExpandResult {
  const { seedEntities, entities, relations, maxHops = 2, maxPerHop = 5 } = options

  // 实体 id → name
  const nameById = new Map(entities.map(e => [e.id, e.name]))
  // 关系邻接表：entityId → [{ neighborId, type }]
  const adjacency = new Map<string, Array<{ neighborId: string; type: string }>>()
  for (const rel of relations) {
    if (!adjacency.has(rel.source)) adjacency.set(rel.source, [])
    if (!adjacency.has(rel.target)) adjacency.set(rel.target, [])
    adjacency.get(rel.source)!.push({ neighborId: rel.target, type: rel.type || 'related_to' })
    adjacency.get(rel.target)!.push({ neighborId: rel.source, type: rel.type || 'related_to' })
  }

  const visited = new Set<string>()
  const hops = new Map<number, HopNode[]>()
  const allNodes: HopNode[] = []
  const paths: string[] = []

  // ---- hop 0: 种子实体 ----
  const seedNodes: HopNode[] = []
  for (const seed of seedEntities) {
    if (visited.has(seed.id)) continue
    visited.add(seed.id)
    const node: HopNode = {
      id: seed.id,
      name: seed.name,
      hop: 0,
      path: [seed.name],
      viaRelation: 'seed'
    }
    seedNodes.push(node)
  }
  hops.set(0, seedNodes)
  allNodes.push(...seedNodes)

  // ---- 逐跳扩展 ----
  let frontier = seedNodes
  for (let hop = 1; hop <= maxHops; hop++) {
    const nextNodes: HopNode[] = []
    const seenThisHop = new Set<string>()

    for (const node of frontier) {
      const neighbors = adjacency.get(node.id) || []
      for (const { neighborId, type } of neighbors) {
        if (visited.has(neighborId)) continue
        if (seenThisHop.has(neighborId)) continue
        if (nextNodes.length >= maxPerHop) break

        visited.add(neighborId)
        seenThisHop.add(neighborId)

        const neighborName = nameById.get(neighborId) || neighborId
        const hopNode: HopNode = {
          id: neighborId,
          name: neighborName,
          hop,
          path: [...node.path, neighborName],
          viaRelation: type
        }
        nextNodes.push(hopNode)

        // 记录推理路径
        paths.push(`${node.path.join(' → ')} --${type}--> ${neighborName}`)
      }
    }

    if (nextNodes.length === 0) break
    hops.set(hop, nextNodes)
    allNodes.push(...nextNodes)
    frontier = nextNodes
  }

  return { hops, allNodes, paths }
}

/**
 * 构建多跳感知的切片提升回调
 * 与 GraphRAG Local Search 一致：跳数越近权重越高
 *
 * hop0 种子实体: 1.0 × boostWeight
 * hop1 直接邻居: 0.6 × boostWeight
 * hop2 邻居邻居: 0.3 × boostWeight
 */
export function createMultiHopBoostCallback(params: {
  allNodes: HopNode[]
  entityToBlocksIndex: Map<string, Set<string>>
  blocks: Array<{ id: string }>
  boostWeight: number
  onStats?: (boostedCount: number, hopStats: string) => void
}): (scores: Map<number, number>) => Map<number, number> {
  const { allNodes, entityToBlocksIndex, blocks, boostWeight, onStats } = params

  const HOP_WEIGHTS = [1.0, 0.6, 0.3, 0.15]
  const blockBoost = new Map<string, number>() // blockId → weight

  for (const node of allNodes) {
    const key = node.name.toLowerCase()
    const blockIds = entityToBlocksIndex.get(key)
    if (!blockIds) continue
    const w = (HOP_WEIGHTS[node.hop] ?? 0.1) * boostWeight
    for (const bid of blockIds) {
      blockBoost.set(bid, Math.max(blockBoost.get(bid) || 0, w))
    }
  }

  const blockIndexMap = new Map(blocks.map((b, i) => [b.id, i]))

  return (scores: Map<number, number>): Map<number, number> => {
    const boosted = new Map<number, number>()
    let boostedCount = 0

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]
      const weight = blockBoost.get(block.id)
      if (weight !== undefined && weight > 1.0) {
        boosted.set(i, (scores.get(i) || 0) * weight)
        boostedCount++
      } else {
        boosted.set(i, scores.get(i) || 0)
      }
    }

    if (onStats) {
      onStats(boostedCount, Array.from(blockBoost.values()).map(v => v.toFixed(2)).join(','))
    }

    return boosted
  }
}
