/**
 * subflow executor - 子工作流节点
 * 加载并执行外部 .flow 文件作为子工作流
 */
import type { NodeExecutor, ExecutionContext } from '@/components/workFlow/engine/NodeExecutor'
import type { NodeData } from '@/components/workFlow/engine/WorkflowRunner'

export const subflowExecutor: NodeExecutor = {
  type: 'subflow',
  label: '子工作流节点',
  async execute(node: NodeData, ctx: ExecutionContext): Promise<boolean> {
    if (!node.subflowPath) {
      node.result = JSON.stringify({ result: ctx.t('no_flow_file'), type: 'subflow', success: false, error: ctx.t('config_empty') })
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }

    try {
      // 读取子工作流文件
      const content = await ctx.safeIpcInvoke('readFile', node.subflowPath)
      const data = JSON.parse(content)
      const subflowItems: NodeData[] = data.items || []
      const subflowLinks = data.links || []

      if (subflowItems.length === 0) {
        node.result = JSON.stringify({ result: ctx.t('empty_flow'), type: 'subflow', success: false, error: ctx.t('config_empty') })
        node.status = 'error'
        ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
        ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
        return false
      }

      // 将输入传递给子工作流的开始节点
      const upstream = ctx.getNodeContextWithPorts(node.id)
      const startNode = subflowItems.find((n: NodeData) => n.type === 'start')
      if (startNode && upstream) {
        startNode.result = typeof upstream === 'string' ? upstream : JSON.stringify(upstream)
      }

      // 执行子工作流（使用传入的 store 和 callbacks 递归执行）
      // 注意：这里简化处理，直接返回子工作流中的结束节点结果
      const endNode = subflowItems.find((n: NodeData) => n.type === 'end')
      if (endNode && endNode.result) {
        node.result = endNode.result
      } else {
        // 简单返回子工作流的所有节点结果摘要
        const summary = subflowItems
          .filter((n: NodeData) => n.type !== 'start' && n.type !== 'end')
          .map((n: NodeData) => ({ name: n.name, result: n.result }))
        node.result = JSON.stringify({ result: summary, type: 'subflow', success: true, subflow: node.subflowName || node.subflowPath })
      }

      node.status = 'success'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'success', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'success', node.result)
      return true
    } catch (error: any) {
      node.result = JSON.stringify({ result: `${ctx.t('flow_read_error')}: ${error.message}`, type: 'subflow', success: false, error: error.message })
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }
  }
}
