/**
 * start executor - 开始节点
 */
import type { NodeExecutor, ExecutionContext } from '@/components/workFlow/engine/NodeExecutor'
import type { NodeData } from '@/components/workFlow/engine/WorkflowRunner'

export const startExecutor: NodeExecutor = {
  type: 'start',
  label: '开始节点',
  async execute(node: NodeData, ctx: ExecutionContext): Promise<boolean> {
    const text = (node.prompt || '').trim()

    if (!text) {
      node.result = JSON.stringify({ result: ctx.t('input_text_required'), type: 'start', success: false, error: ctx.t('input_text_empty'), outputByPort: { default: '' } })
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }

    node.result = JSON.stringify({
      type: 'start', success: true, result: text,
      outputByPort: { default: text },
      timestamp: new Date().toISOString()
    })
    node.status = 'success'
    ctx.callbacks.onNodeStatusUpdate?.(node.id, 'success', node.result)
    ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'success', node.result)
    return true
  }
}
