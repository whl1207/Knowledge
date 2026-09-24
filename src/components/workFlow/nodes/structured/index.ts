/**
 * structured executor - 结构化节点
 */
import type { NodeExecutor, ExecutionContext } from '@/components/workFlow/engine/NodeExecutor'
import type { NodeData } from '@/components/workFlow/engine/WorkflowRunner'

export const structuredExecutor: NodeExecutor = {
  type: 'structured',
  label: '结构化节点',
  async execute(node: NodeData, ctx: ExecutionContext): Promise<boolean> {
    if (!node.structuredData || node.structuredData.length === 0) {
      node.result = JSON.stringify({ result: ctx.t('empty_table'), type: 'structured', success: false, error: ctx.t('empty_table') })
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }
    try {
      const output = JSON.stringify(node.structuredData, null, 2)
      node.result = JSON.stringify({ type: 'structured', success: true, result: output, timestamp: new Date().toISOString() })
      node.status = 'success'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'success', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'success', node.result)
      return true
    } catch (error: any) {
      node.result = JSON.stringify({ result: `${ctx.t('structured_error')}: ${error.message}`, type: 'structured', success: false, error: error.message, timestamp: new Date().toISOString() })
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }
  }
}
