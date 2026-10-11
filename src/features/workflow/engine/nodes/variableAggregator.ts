/**
 * variable-aggregator（变量聚合器）执行器
 *
 * 取第一个「有值」的变量作为输出（对齐 Dify 的聚合语义：多路择一，空值跳过）。
 */
import { resolveSelector } from '../template'
import type { NodeExecutionContext, NodeExecutionResult, WorkflowNodeExecutor } from '../types'

export const variableAggregatorExecutor: WorkflowNodeExecutor = {
  type: 'variable-aggregator',
  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const data = ctx.node as unknown as Record<string, unknown>
    const variables = Array.isArray(data.variables)
      ? (data.variables as Array<{ value_selector?: string[]; variable?: string }>)
      : []
    if (!variables.length) throw new Error('请至少配置一个待聚合的变量')

    for (const item of variables) {
      const value = resolveSelector(item.value_selector, ctx.pool)
      if (isEmpty(value)) continue
      ctx.log('info', `选中 ${(item.value_selector ?? []).join('.')}`)
      return { outputs: { output: value } }
    }

    ctx.log('warning', '所有候选变量都是空值，输出空字符串')
    return { outputs: { output: '' } }
  },
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value as object).length === 0
  return false
}
