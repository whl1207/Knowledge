/** 结束节点执行器：按 outputs 声明从变量池取值，作为工作流最终输出 */
import { resolveSelector } from '../template'
import type { NodeExecutionContext, NodeExecutionResult, WorkflowNodeExecutor } from '../types'
import type { EndOutput } from '@/features/workflow/dsl/types'

export const endExecutor: WorkflowNodeExecutor = {
  type: 'end',
  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const data = ctx.node as unknown as Record<string, unknown>
    const specs = Array.isArray(data.outputs) ? (data.outputs as EndOutput[]) : []
    const outputs: Record<string, unknown> = {}

    for (const spec of specs) {
      const name = String(spec.variable || '').trim()
      if (!name) continue
      const value = resolveSelector(spec.value_selector, ctx.pool)
      if (value === undefined) ctx.log('warning', `输出变量「${name}」的取值来源没有数据`)
      outputs[name] = value ?? ''
    }

    if (!specs.length) ctx.log('warning', '结束节点没有声明输出变量')
    return { outputs }
  },
}
