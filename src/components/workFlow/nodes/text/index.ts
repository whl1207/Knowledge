/**
 * text executor - 文本节点
 */
import type { NodeExecutor, ExecutionContext } from '@/components/workFlow/engine/NodeExecutor'
import type { NodeData } from '@/components/workFlow/engine/WorkflowRunner'

export const textExecutor: NodeExecutor = {
  type: 'text',
  label: '文本节点',
  async execute(node: NodeData, ctx: ExecutionContext): Promise<boolean> {
    if (!node.prompt || node.prompt.trim() === '') {
      node.result = JSON.stringify({ result: ctx.t('enter_text'), status: 'error' })
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }
    const resolved = ctx.resolveTemplate(node.prompt, node.id)
    node.result = JSON.stringify({ result: resolved, type: 'text' })
    node.status = 'success'
    ctx.callbacks.onNodeStatusUpdate?.(node.id, 'success', node.result)
    ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'success', node.result)
    return true
  }
}
