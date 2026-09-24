/**
 * VariablePool - 变量池
 * 
 * 负责工作流执行中节点间数据的存储和传递。
 * 每个节点执行后将其输出注册到变量池，下游节点从变量池读取上游数据。
 * 与 NodeData.result 解耦，NodeData.result 仅作为 UI 显示的"快照"。
 */

import type { NodeData, Link } from '@/components/workFlow/engine/WorkflowRunner'

export interface NodeOutput {
  [key: string]: any
  /** 默认输出字段（兼容旧版 result） */
  result?: string
}

/**
 * 上游上下文条目
 */
export interface UpstreamContext {
  nodeId: number
  nodeName: string
  nodeType: string
  data: any
  port?: string
}

export class VariablePool {
  /** 内部存储: nodeId -> (key -> value) */
  private store = new Map<number, Map<string, any>>()

  /**
   * 设置节点的输出变量
   * @param nodeId 节点ID
   * @param key 变量名（默认 'result'）
   * @param value 变量值
   */
  set(nodeId: number, key: string = 'result', value: any): void {
    if (!this.store.has(nodeId)) {
      this.store.set(nodeId, new Map())
    }
    this.store.get(nodeId)!.set(key, value)
  }

  /**
   * 批量设置节点的输出
   */
  setAll(nodeId: number, outputs: Record<string, any>): void {
    const nodeStore = this.store.get(nodeId) || new Map()
    for (const [key, value] of Object.entries(outputs)) {
      nodeStore.set(key, value)
    }
    this.store.set(nodeId, nodeStore)
  }

  /**
   * 获取节点的变量
   * @param nodeId 节点ID
   * @param key 可选，变量名。不传则返回包含 result 的简单对象
   */
  get(nodeId: number, key?: string): any {
    const nodeStore = this.store.get(nodeId)
    if (!nodeStore) return undefined
    if (key !== undefined) return nodeStore.get(key)
    // 返回 { result, ... } 的简单对象
    return Object.fromEntries(nodeStore.entries())
  }

  /**
   * 获取节点的完整输出映射
   */
  getNodeOutputs(nodeId: number): Record<string, any> | undefined {
    const nodeStore = this.store.get(nodeId)
    if (!nodeStore) return undefined
    return Object.fromEntries(nodeStore.entries())
  }

  /**
   * 检查节点是否有输出
   */
  has(nodeId: number): boolean {
    return this.store.has(nodeId)
  }

  /**
   * 清空所有变量
   */
  clear(): void {
    this.store.clear()
  }

  /**
   * 删除指定节点的变量
   */
  delete(nodeId: number): void {
    this.store.delete(nodeId)
  }

  /**
   * 获取上游节点的上下文数据（合并文本用于 LLM 提示词构建）
   * 
   * @param nodeId 当前节点ID
   * @param items 所有节点
   * @param links 所有连接
   * @param decisionPaths 可选，决策路径映射
   * @returns 上游上下文列表
   */
  getUpstreamContext(
    nodeId: number,
    items: NodeData[],
    links: Link[],
    decisionPaths?: Map<number, string>
  ): UpstreamContext[] {
    const incomingLinks = links.filter(l => l.target === nodeId)
    const results: UpstreamContext[] = []

    for (const link of incomingLinks) {
      const sourceNode = items.find(n => n.id === link.source)
      if (!sourceNode) continue

      // 决策分支过滤
      if (link.branch && sourceNode.type === 'decision') {
        const selected = decisionPaths?.get(sourceNode.id)
        if (selected !== link.branch) continue
      }

      // 从变量池获取数据
      const nodeStore = this.store.get(sourceNode.id)
      if (!nodeStore) continue

      // 如果明确指定了 sourcePort，优先使用端口数据
      if (link.sourcePort) {
        const portData = nodeStore.get(`port:${link.sourcePort}`)
        if (portData !== undefined) {
          results.push({
            nodeId: sourceNode.id,
            nodeName: sourceNode.name,
            nodeType: sourceNode.type,
            data: portData,
            port: link.sourcePort
          })
          continue
        }
      }

      // 默认取 result 字段
      const data = nodeStore.get('result')
      if (data !== undefined) {
        results.push({
          nodeId: sourceNode.id,
          nodeName: sourceNode.name,
          nodeType: sourceNode.type,
          data
        })
      }
    }

    return results
  }

  /**
   * 获取上游上下文的纯文本拼接（用于 LLM 提示词）
   */
  getUpstreamText(
    nodeId: number,
    items: NodeData[],
    links: Link[],
    decisionPaths?: Map<number, string>
  ): string[] {
    const contexts = this.getUpstreamContext(nodeId, items, links, decisionPaths)
    return contexts.map(ctx => {
      const data = typeof ctx.data === 'string' ? ctx.data : JSON.stringify(ctx.data)
      return data
    })
  }

  /**
   * 收集结束节点的汇总结果
   */
  collectEndNodeResults(
    endNodeId: number,
    items: NodeData[],
    links: Link[],
    decisionPaths?: Map<number, string>
  ): Record<string, any> {
    const results: Record<string, any> = {}
    const incomingLinks = links.filter(l => l.target === endNodeId)

    for (const link of incomingLinks) {
      const sourceNode = items.find(n => n.id === link.source)
      if (!sourceNode) continue

      if (link.branch && sourceNode.type === 'decision') {
        const selected = decisionPaths?.get(sourceNode.id)
        if (selected !== link.branch) continue
      }

      const output = this.getNodeOutputs(sourceNode.id)
      if (output !== undefined) {
        results[`node_${sourceNode.id}`] = output.result ?? output
      }
    }

    return results
  }

  /**
   * 从 NodeData.result（JSON字符串）导入到变量池
   * 用于兼容旧版存储数据
   */
  importFromNodeResults(items: NodeData[]): void {
    for (const node of items) {
      if (!node.result || node.result === '') continue
      try {
        const parsed = JSON.parse(node.result)
        if (typeof parsed === 'object' && parsed !== null) {
          this.setAll(node.id, parsed)
        } else {
          this.set(node.id, 'result', node.result)
        }
      } catch {
        this.set(node.id, 'result', node.result)
      }
    }
  }

  /**
   * 将变量池中的数据同步回 NodeData.result（UI 显示用）
   */
  exportToNodeResult(node: NodeData): void {
    const output = this.getNodeOutputs(node.id)
    if (!output) return
    // 如果有 result 字段就用它，否则序列化整个输出
    node.result = output.result ?? JSON.stringify(output)
  }
}
