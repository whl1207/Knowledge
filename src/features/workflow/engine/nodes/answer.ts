/** 直接回复节点执行器：渲染正文模板，作为回复内容 */
import { resolveText } from '../template'
import type { NodeExecutionContext, NodeExecutionResult, WorkflowNodeExecutor } from '../types'

export const answerExecutor: WorkflowNodeExecutor = {
  type: 'answer',
  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const data = ctx.node as unknown as Record<string, unknown>
    const template = String(data.answer ?? '')
    if (!template.trim()) throw new Error('回复内容为空')

    const { value, warnings } = resolveText(template, ctx.pool)
    for (const warning of warnings) {
      ctx.log('warning', `变量 ${warning.selector.join('.')} 没有数据，已留空`)
    }
    return { outputs: { answer: value } }
  },
}
