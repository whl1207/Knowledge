/**
 * loop（循环）执行器
 *
 * 对齐 Dify 的语义：
 * - `loop_count` 为最大轮数
 * - `loop_variables` 是容器自身的变量（容器内部通过 `[容器id, 变量名]` 引用）
 * - `break_conditions` 命中即提前结束（每轮结束后判定）
 * - 容器入口节点（`<容器id>start`）暴露 `index`（当前轮次）
 *
 * 循环变量的更新依赖容器内部的「变量赋值」节点（assigner）；本执行器每轮开始前把
 * 当前值写回变量池，因此内部赋值后下一轮能读到新值。
 */
import { evaluateCase, type ConditionCase } from '../conditions'
import type { NodeExecutionContext, NodeExecutionResult, WorkflowNodeExecutor } from '../types'

const MAX_LOOP_COUNT = 200

interface LoopVariable {
  id?: string
  label?: string
  value?: unknown
  value_type?: string
  var_type?: string
}

export const loopExecutor: WorkflowNodeExecutor = {
  type: 'loop',
  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const data = ctx.node as unknown as Record<string, unknown>
    const declared = Array.isArray(data.loop_variables) ? (data.loop_variables as LoopVariable[]) : []
    const requested = Number(data.loop_count ?? 10)
    const maxCount = Number.isFinite(requested) && requested > 0 ? Math.min(Math.trunc(requested), MAX_LOOP_COUNT) : 10
    if (requested > MAX_LOOP_COUNT) ctx.log('warning', `循环次数超过上限，按 ${MAX_LOOP_COUNT} 轮执行`)

    const entryId = ctx.resolveContainerEntry(ctx.nodeId)
    if (!entryId) ctx.log('warning', '容器内没有入口节点，内部节点无法读取 index')

    // 容器变量：初始值写进变量池，内部用 [容器id, 变量名] 引用
    const variables: Record<string, unknown> = {}
    for (const item of declared) {
      const name = String(item.id || item.label || '')
      if (!name) continue
      variables[name] = item.value ?? ''
    }
    if (Object.keys(variables).length) ctx.pool.setNodeOutputs(ctx.nodeId, variables)

    const breaks = Array.isArray(data.break_conditions) ? (data.break_conditions as ConditionCase[]) : []
    const errorMode = String(data.error_handle_mode ?? 'terminated')

    let rounds = 0
    let lastOutputs: Record<string, unknown> = {}
    for (let index = 0; index < maxCount; index++) {
      if (ctx.signal.aborted) throw new Error('已中止')
      rounds++
      ctx.log('info', `第 ${index + 1}/${maxCount} 轮`)

      // 每轮把当前变量值交给入口节点，便于内部节点引用
      const seed = entryId ? { [entryId]: { index, ...variables } } : {}
      const outcome = await ctx.runSubgraph(ctx.nodeId, seed)

      if (!outcome.success) {
        const message = outcome.error || '循环内部执行失败'
        if (errorMode === 'terminated') throw new Error(`第 ${index + 1} 轮失败：${message}`)
        ctx.log('warning', `第 ${index + 1} 轮出错但继续：${message}`)
        continue
      }

      // 内部赋值节点可能改写了容器变量，取回最新值
      const current = ctx.pool.getNodeOutputs(ctx.nodeId) ?? {}
      Object.assign(variables, current)
      lastOutputs = Object.values(outcome.outputs).at(-1) ?? {}

      if (breaks.length) {
        const hit = breaks.find((item) => evaluateCase(item, ctx.pool))
        if (hit) {
          ctx.log('info', `命中结束条件（${hit.case_id || 'break'}），循环提前结束`)
          break
        }
      }
    }

    return { outputs: { ...variables, output: lastOutputs, rounds } }
  },
}
