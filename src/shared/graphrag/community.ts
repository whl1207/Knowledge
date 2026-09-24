// 自实现的 Louvain 社区检测算法
// 参考 Blondel et al. (2008) Fast unfolding of communities in large networks
// 无需外部图算法库，纯 TypeScript 实现

export interface CommunityResult {
  /** nodeId → communityId */
  assignments: Map<string, number>
  /** communityId → nodeId[] */
  communities: Map<number, string[]>
  /** 模块度 */
  modularity: number
  /** 社区数量 */
  count: number
}

/**
 * Louvain 社区检测算法
 *
 * @param nodeIds   - 节点ID列表（如实体ID）
 * @param edges     - 边列表 [sourceId, targetId, weight]
 * @param resolution- 分辨率参数（>1 产生更多小社区，<1 产生更少大社区）
 */
export function louvainCommunityDetection(
  nodeIds: string[],
  edges: Array<[string, string, number]>,
  resolution: number = 1.0
): CommunityResult {
  if (nodeIds.length === 0) {
    return { assignments: new Map(), communities: new Map(), modularity: 0, count: 0 }
  }

  // ---- 1. 构建索引 ----
  const nodeIndex = new Map<string, number>()
  nodeIds.forEach((id, i) => nodeIndex.set(id, i))
  const n = nodeIds.length

  // 邻接表：adj[i] = Array<[j, weight]>
  const adj: Array<Array<[number, number]>> = Array.from({ length: n }, () => [])
  // 节点总权重（度数之和的一半 = 总边权）
  let totalEdgeWeight = 0

  for (const [s, t, w] of edges) {
    const si = nodeIndex.get(s)
    const ti = nodeIndex.get(t)
    if (si === undefined || ti === undefined || si === ti) continue
    const weight = Math.max(w, 0.01) // 防止零权重
    adj[si].push([ti, weight])
    adj[ti].push([si, weight])
    totalEdgeWeight += weight
  }

  if (totalEdgeWeight === 0) {
    // 无边图：每个节点单独一个社区
    const assignments = new Map<string, number>()
    const communities = new Map<number, string[]>()
    nodeIds.forEach((id, i) => {
      assignments.set(id, i)
      communities.set(i, [id])
    })
    return { assignments, communities, modularity: 0, count: n }
  }

  const m2 = 2 * totalEdgeWeight // 2m

  // 各节点的度数（边权和）
  const degrees = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let d = 0
    for (const [, w] of adj[i]) d += w
    degrees[i] = d
  }

  // ---- 2. 初始化：每个节点自成一社区 ----
  const community = new Int32Array(n)      // community[i] = 节点i所属社区
  const comDegree = new Map<number, number>() // 社区总度数
  const comInternal = new Map<number, number>() // 社区内部边权×2

  for (let i = 0; i < n; i++) {
    community[i] = i
    comDegree.set(i, degrees[i])
    comInternal.set(i, 0)
  }

  // 初始化内部边权
  for (let i = 0; i < n; i++) {
    for (const [j, w] of adj[i]) {
      if (community[i] === community[j]) {
        comInternal.set(community[i], (comInternal.get(community[i]) || 0) + w)
      }
    }
  }

  // ---- 3. 迭代优化 ----
  let improved = true
  let iterations = 0
  const maxIterations = 20

  while (improved && iterations < maxIterations) {
    improved = false
    iterations++

    for (let i = 0; i < n; i++) {
      const curCom = community[i]
      const ki = degrees[i]

      // 计算当前节点 i 与各相邻社区的连接权重
      const neighComWeight = new Map<number, number>()
      for (const [j, w] of adj[i]) {
        const cj = community[j]
        neighComWeight.set(cj, (neighComWeight.get(cj) || 0) + w)
      }

      // 当前社区移除 i 后的内部边权
      const kiIn = neighComWeight.get(curCom) || 0 // i 与当前社区的连接
      const curSigmaTot = (comDegree.get(curCom) || 0) - ki
      const curInternal = (comInternal.get(curCom) || 0) - 2 * kiIn

      // 尝试将 i 移入相邻社区
      let bestCom = curCom
      let bestDelta = 0

      for (const [c, wToC] of neighComWeight) {
        if (c === curCom) continue
        const sigmaTot = comDegree.get(c) || 0

        // 模块度增益公式（含分辨率）：
        // ΔQ = [Σin + 2*ki_in] / 2m - [(Σtot + ki)/2m]²
        //     - [Σin/2m - (Σtot/2m)² - (ki/2m)²]
        // 化简后：
        const delta = (wToC / totalEdgeWeight)
          - resolution * (sigmaTot * ki) / (m2 * totalEdgeWeight)

        if (delta > bestDelta) {
          bestDelta = delta
          bestCom = c
        }
      }

      // 如果找到更好的社区，移动节点
      if (bestCom !== curCom && bestDelta > 1e-10) {
        improved = true
        community[i] = bestCom

        // 更新原社区
        comDegree.set(curCom, (comDegree.get(curCom) || 0) - ki)
        comInternal.set(curCom, curInternal)

        // 更新新社区
        comDegree.set(bestCom, (comDegree.get(bestCom) || 0) + ki)
        const newInternal = (comInternal.get(bestCom) || 0) + 2 * (neighComWeight.get(bestCom) || 0)
        comInternal.set(bestCom, newInternal)
      }
    }
  }

  // ---- 4. 压缩社区编号（去掉空号） ----
  const comMap = new Map<number, number>()
  let nextComId = 0
  for (let i = 0; i < n; i++) {
    const c = community[i]
    if (!comMap.has(c)) comMap.set(c, nextComId++)
  }
  for (let i = 0; i < n; i++) {
    community[i] = comMap.get(community[i])!
  }

  // ---- 5. 构建输出 ----
  const assignments = new Map<string, number>()
  const communities = new Map<number, string[]>()

  for (let i = 0; i < n; i++) {
    const nodeId = nodeIds[i]
    const comId = community[i]
    assignments.set(nodeId, comId)
    if (!communities.has(comId)) communities.set(comId, [])
    communities.get(comId)!.push(nodeId)
  }

  // 计算最终模块度
  let modularity = 0
  for (let i = 0; i < n; i++) {
    for (const [j, w] of adj[i]) {
      if (i < j) {
        const same = community[i] === community[j] ? 1 : 0
        modularity += (w / totalEdgeWeight - resolution * (degrees[i] * degrees[j]) / (m2 * totalEdgeWeight)) * same
      }
    }
  }

  return {
    assignments,
    communities,
    modularity: Math.max(0, modularity),
    count: communities.size,
  }
}

/**
 * 从实体和关系中检测社区
 * 适配现有 OntologyEntity / OntologyRelation 结构
 */
export function detectCommunitiesFromOntology(
  entities: Array<{ id: string; name: string }>,
  relations: Array<{ source: string; target: string; type?: string; description?: string }>,
  options: { resolution?: number; defaultWeight?: number } = {}
): CommunityResult {
  const { resolution = 1.0, defaultWeight = 1 } = options

  const nodeIds = entities.map(e => e.id)
  const edges: Array<[string, string, number]> = []

  for (const rel of relations) {
    // 忽略自环
    if (rel.source === rel.target) continue
    // 强度：基于关系描述长度和类型估算权重
    let weight = defaultWeight
    if (rel.description && rel.description.length > 20) weight += 0.5
    if (rel.description && rel.description.length > 50) weight += 0.5
    // 不同类型的关系赋予不同权重
    if (rel.type === 'is_a' || rel.type === 'part_of') weight += 0.5
    if (rel.type === 'depends_on' || rel.type === 'causes') weight += 0.3

    edges.push([rel.source, rel.target, weight])
  }

  return louvainCommunityDetection(nodeIds, edges, resolution)
}

/**
 * 收集社区关联的文本内容，用于生成社区报告
 */
export function collectCommunityContext(
  communityEntityIds: string[],
  entityToBlocksIndex: Map<string, Set<string>>,
  blocks: Array<{ id: string; A: string; label?: string }>
): string {
  const matchedBlockIds = new Set<string>()

  for (const eid of communityEntityIds) {
    const blockIds = entityToBlocksIndex.get(eid)
    if (blockIds) {
      for (const bid of blockIds) matchedBlockIds.add(bid)
    }
  }

  // 按关联实体数量排序，取最关键的前 N 个切片
  const blockRelevance = new Map<string, number>()
  for (const bid of matchedBlockIds) {
    let count = 0
    for (const eid of communityEntityIds) {
      const idx = entityToBlocksIndex.get(eid)
      if (idx?.has(bid)) count++
    }
    blockRelevance.set(bid, count)
  }

  const sortedBlocks = Array.from(blockRelevance.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)

  return sortedBlocks.map(([bid]) => {
    const block = blocks.find(b => b.id === bid)
    return block ? block.A : ''
  }).filter(Boolean).join('\n\n---\n\n')
}
