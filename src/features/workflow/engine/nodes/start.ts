/** 开始节点执行器：把运行输入写入变量池 */
import { stringifyValue } from '../template'
import type { NodeExecutionContext, NodeExecutionResult, WorkflowNodeExecutor } from '../types'
import type { StartVariable } from '@/features/workflow/dsl/types'

export const startExecutor: WorkflowNodeExecutor = {
  type: 'start',
  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const data = ctx.node as unknown as Record<string, unknown>
    const variables = Array.isArray(data.variables) ? (data.variables as StartVariable[]) : []
    const outputs: Record<string, unknown> = {}

    for (const variable of variables) {
      const name = String(variable.variable || '').trim()
      if (!name) continue
      const provided = ctx.inputs[name]
      if (provided !== undefined && provided !== null && provided !== '') {
        outputs[name] = provided
        continue
      }
      if (variable.default !== undefined) {
        outputs[name] = variable.default
        continue
      }
      if (variable.required) throw new Error(`缺少必填输入变量：${variable.label || name}`)
      outputs[name] = ''
    }

    const summary = Object.entries(outputs)
      .map(([name, value]) => `${name}=${stringifyValue(value).slice(0, 60)}`)
      .join(', ')
    ctx.log('info', summary ? `输入：${summary}` : '无输入变量')

    return { outputs }
  },
}
