/**
 * if-else 执行器
 *
 * 按顺序判定 cases，命中即把该 case 的 case_id 作为 `selectedHandle`；
 * 全不命中走 `false`（Dify 的 ELSE 分支）。
 */
import { evaluateCase, type ConditionCase } from '../conditions'
import type { NodeExecutionContext, NodeExecutionResult, WorkflowNodeExecutor } from '../types'

export const ifElseExecutor: WorkflowNodeExecutor = {
  type: 'if-else',
  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const data = ctx.node as unknown as Record<string, unknown>
    const cases = Array.isArray(data.cases) ? (data.cases as ConditionCase[]) : []

    for (const item of cases) {
      if (evaluateCase(item, ctx.pool)) {
        const handle = String(item.case_id || 'true')
        ctx.log('info', `命中分支 ${handle}`)
        return { selectedHandle: handle }
      }
    }

    ctx.log('info', '没有条件命中，走 ELSE 分支')
    return { selectedHandle: 'false' }
  },
}
