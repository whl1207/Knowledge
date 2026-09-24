/**
 * GraphEngine - 图引擎
 * 
 * 负责工作流 DAG 的拓扑排序、可达节点分析、循环依赖检测。
 * 将拓扑排序和依赖解析从 WorkflowRunner 中提取为独立引擎，
 * 使 Runner 更加清晰。
 */

import type { NodeData, Link } from '@/components/workFlow/engine/WorkflowRunner'

/**
 * 执行计划
 */
export interface ExecutionPlan {
  /** 拓扑排序后的执行顺序（节点ID列表） */
  order: number[]
  /** 所有需要执行的节点ID */
  reachableNodeIds: number[]
  /** 是否存在循环依赖 */
  hasCycle: boolean
  /** 警告信息 */
  warnings: string[]
}

/**
 * 图验证结果
 */
export interface GraphValidation {
  valid: boolean
  errors: string[]
  warnings: string[]
}

export class GraphEngine {
  constructor(
    private items: NodeData[],
    private links: Link[]
  ) {}

  /**
   * 制定执行计划
   * @param startNodeId 起始节点ID
   * @param decisionPaths 可选的决策路径映射
   */
  planExecution(startNodeId: number, decisionPaths?: Map<number, string>): ExecutionPlan {
    const warnings: string[] = []

    // 1. 检测循环依赖
    const hasCycle = this.detectCycle()
    if (hasCycle) {
      warnings.push('检测到循环依赖')
    }

    // 2. 获取所有可达节点
    const reachableNodeIds = this.getReachableNodes(startNodeId, decisionPaths)
    if (reachableNodeIds.length === 0) {
      warnings.push('没有找到需要执行的节点')
      return { order: [], reachableNodeIds: [], hasCycle, warnings }
    }

    // 3. 拓扑排序
    const order = this.topologicalSort(reachableNodeIds, decisionPaths)
    if (order.length === 0) {
      warnings.push('无法确定执行顺序')
      return { order: [], reachableNodeIds, hasCycle, warnings }
    }

    if (order.length !== reachableNodeIds.length) {
      warnings.push('部分节点无法排序（可能存在决策分支过滤或循环依赖）')
    }

    return { order, reachableNodeIds, hasCycle, warnings }
  }

  /**
   * BFS 获取从 startNodeId 出发的所有可达节点
   * @param startNodeId 起始节点
   * @param decisionPaths 可选决策路径，指定后只走选中分支
   */
  getReachableNodes(startNodeId: number, decisionPaths?: Map<number, string>): number[] {
    const visited = new Set<number>()
    const queue: number[] = [startNodeId]

    while (queue.length > 0) {
      const nodeId = queue.shift()!
      if (visited.has(nodeId)) continue
      visited.add(nodeId)

      const outgoingLinks = this.links.filter(l => l.source === nodeId)
      const sourceNode = this.items.find(n => n.id === nodeId)

      for (const link of outgoingLinks) {
        // 决策分支过滤
        if (sourceNode?.type === 'decision' && link.branch) {
          const selected = decisionPaths?.get(nodeId)
          // 如果决策结果已知，只走被选中的分支
          if (selected !== undefined && selected !== link.branch) continue
        }
        if (!visited.has(link.target)) {
          queue.push(link.target)
        }
      }
    }

    return Array.from(visited)
  }

  /**
   * Kahn 算法拓扑排序
   * @param nodeIds 待排序的节点ID集合
   * @param decisionPaths 可选决策路径
   */
  topologicalSort(nodeIds: number[], decisionPaths?: Map<number, string>): number[] {
    if (nodeIds.length === 0) return []

    const nodeSet = new Set(nodeIds)
    const indegree = new Map<number, number>()
    const adjacency = new Map<number, number[]>()

    // 初始化
    for (const id of nodeIds) {
      indegree.set(id, 0)
      adjacency.set(id, [])
    }

    // 构建邻接表（考虑决策分支）
    for (const link of this.links) {
      if (!nodeSet.has(link.source) || !nodeSet.has(link.target)) continue

      const sourceNode = this.items.find(n => n.id === link.source)

      // 决策分支过滤
      if (sourceNode?.type === 'decision' && link.branch) {
        const selected = decisionPaths?.get(link.source)
        // 决策结果未知时包含所有分支，已知时只包含选中分支
        if (selected !== undefined && selected !== link.branch) continue
      }

      adjacency.get(link.source)!.push(link.target)
      indegree.set(link.target, (indegree.get(link.target) || 0) + 1)
    }

    // 找到入度为0的节点
    const queue: number[] = []
    for (const id of nodeIds) {
      if (indegree.get(id) === 0) queue.push(id)
    }

    const result: number[] = []
    while (queue.length > 0) {
      const nodeId = queue.shift()!
      result.push(nodeId)

      for (const neighbor of adjacency.get(nodeId) || []) {
        const newDegree = indegree.get(neighbor)! - 1
        indegree.set(neighbor, newDegree)
        if (newDegree === 0) queue.push(neighbor)
      }
    }

    return result
  }

  /**
   * DFS 检测循环依赖
   */
  detectCycle(): boolean {
    const visited = new Set<number>()
    const recStack = new Set<number>()
    const adjacency = new Map<number, number[]>()

    for (const node of this.items) {
      adjacency.set(node.id, [])
    }
    for (const link of this.links) {
      adjacency.get(link.source)?.push(link.target)
    }

    const dfs = (nodeId: number): boolean => {
      if (recStack.has(nodeId)) return true
      if (visited.has(nodeId)) return false

      visited.add(nodeId)
      recStack.add(nodeId)

      for (const neighbor of adjacency.get(nodeId) || []) {
        if (dfs(neighbor)) return true
      }

      recStack.delete(nodeId)
      return false
    }

    for (const node of this.items) {
      if (dfs(node.id)) return true
    }
    return false
  }

  /**
   * 验证图的合法性
   */
  validate(): GraphValidation {
    const errors: string[] = []
    const warnings: string[] = []

    const startNodes = this.items.filter(n => n.type === 'start')
    const endNodes = this.items.filter(n => n.type === 'end')

    if (startNodes.length === 0) errors.push('缺少开始节点')
    else if (startNodes.length > 1) errors.push(`开始节点数量不正确: ${startNodes.length} (需要1个)`)

    if (endNodes.length === 0) errors.push('缺少结束节点')
    else if (endNodes.length > 1) errors.push(`结束节点数量不正确: ${endNodes.length} (需要1个)`)

    // 验证决策节点分支
    for (const node of this.items) {
      if (node.type === 'decision') {
        const branches = node.decisionBranches
        if (!branches || branches.length < 2) {
          errors.push(`决策节点 "${node.name}" 分支数量不足 (${branches?.length || 0})，至少需要2个`)
        } else if (branches.length > 10) {
          errors.push(`决策节点 "${node.name}" 分支数量过多 (${branches.length})，最多10个`)
        }
      }

      // 验证 MCP 节点
      if (node.type === 'mcp' && node.mcpConfig) {
        const cfg = node.mcpConfig
        if (!cfg.transport) {
          errors.push(`MCP节点 "${node.name}" 缺少传输类型配置`)
        } else if (cfg.transport === 'stdio' && !cfg.command) {
          errors.push(`MCP节点 "${node.name}" (stdio) 缺少命令配置`)
        } else if ((cfg.transport === 'sse' || cfg.transport === 'http') && !cfg.serverUrl) {
          errors.push(`MCP节点 "${node.name}" (${cfg.transport}) 缺少服务器URL`)
        }
      }
    }

    // 检查循环依赖
    if (this.detectCycle()) {
      errors.push('工作流图中存在循环依赖')
    }

    return { valid: errors.length === 0, errors, warnings }
  }

  /**
   * 更新图数据（当 items/links 变化时调用）
   */
  update(items: NodeData[], links: Link[]): void {
    this.items = items
    this.links = links
  }

  /**
   * 获取指定节点的所有前置依赖节点ID
   */
  getPredecessors(nodeId: number, decisionPaths?: Map<number, string>): number[] {
    const predecessors: number[] = []
    const incomingLinks = this.links.filter(l => l.target === nodeId)

    for (const link of incomingLinks) {
      const sourceNode = this.items.find(n => n.id === link.source)
      if (!sourceNode) continue

      if (link.branch && sourceNode.type === 'decision') {
        const selected = decisionPaths?.get(link.source)
        if (selected !== undefined && selected !== link.branch) continue
      }

      predecessors.push(link.source)
    }

    return predecessors
  }

  /**
   * 获取指定节点的所有后继节点ID
   */
  getSuccessors(nodeId: number, decisionPaths?: Map<number, string>): number[] {
    const successors: number[] = []
    const outgoingLinks = this.links.filter(l => l.source === nodeId)
    const sourceNode = this.items.find(n => n.id === nodeId)

    for (const link of outgoingLinks) {
      if (sourceNode?.type === 'decision' && link.branch) {
        const selected = decisionPaths?.get(nodeId)
        if (selected !== undefined && selected !== link.branch) continue
      }
      successors.push(link.target)
    }

    return successors
  }
}
