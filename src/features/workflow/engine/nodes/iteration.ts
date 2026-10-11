/**
 * iteration（迭代）执行器
 *
 * 结构对齐 Dify：容器内子节点通过 `parentId` 归属本节点，容器入口节点
 * （id 约定为 `<容器id>start`，类型 `iteration-start`）暴露 `item` / `index` 供内部节点引用。
 *
 * 说明：`is_parallel` 目前按串行执行并给出提示——内部节点共享同一个变量池，
 * 并行会让同 id 的输出互相覆盖，串行结果才可复现。
 */
import { resolveSelector } from '../template'
import type { NodeExecutionContext, NodeExecutionResult, WorkflowNodeExecutor } from '../types'

const MAX_ITERATIONS = 500

export const iterationExecutor: WorkflowNodeExecutor = {
  type: 'iteration',
  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const data = ctx.node as unknown as Record<string, unknown>
    const raw = resolveSelector(data.iterator_selector as string[], ctx.pool)

    let items: unknown[]
    if (Array.isArray(raw)) items = raw
    else if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) throw new Error('不是数组')
        items = parsed
      } catch {
        throw new Error('迭代输入不是数组（可填 JSON 数组字符串）')
      }
    } else {
      throw new Error('迭代输入为空，请检查数组来源')
    }

    if (!items.length) {
      ctx.log('warning', '迭代输入是空数组，直接返回空结果')
      return { outputs: { output: [] } }
    }
    if (items.length > MAX_ITERATIONS) {
      ctx.log('warning', `迭代项数 ${items.length} 超过上限 ${MAX_ITERATIONS}，只处理前 ${MAX_ITERATIONS} 项`)
      items = items.slice(0, MAX_ITERATIONS)
    }
    if (data.is_parallel) ctx.log('warning', '并行迭代暂按串行执行（内部节点共享变量池）')

    const entryId = ctx.resolveContainerEntry(ctx.nodeId)
    if (!entryId) ctx.log('warning', '容器内没有入口节点，内部节点无法读取 item / index')
    const outputSelector = data.output_selector as string[] | undefined
    const errorMode = String(data.error_handle_mode ?? 'terminated')

    const collected: unknown[] = []
    const failures: Array<{ index: number; error: string }> = []

    for (let index = 0; index < items.length; index++) {
      if (ctx.signal.aborted) throw new Error('已中止')
      ctx.log('info', `第 ${index + 1}/${items.length} 项`)

      const seed = entryId ? { [entryId]: { item: items[index], index } } : {}
      const outcome = await ctx.runSubgraph(ctx.nodeId, seed)

      if (!outcome.success) {
        const message = outcome.error || '迭代内部执行失败'
        if (errorMode === 'terminated') throw new Error(`第 ${index + 1} 项失败：${message}`)
        failures.push({ index, error: message })
        if (errorMode === 'remove_abnormal_output') continue
        // continue_with_error / continue_with_error_inject：把错误作为该项输出继续
        collected.push(`[第 ${index + 1} 项出错] ${message}`)
        continue
      }

      const value = resolveSelector(outputSelector, ctx.pool)
      collected.push(value === undefined ? null : value)
    }

    if (failures.length) ctx.log('warning', `共 ${failures.length} 项出错（错误模式：${errorMode}）`)
    return { outputs: { output: collected } }
  },
}
