/**
 * aggregator executor - 变量聚合节点
 *
 * - collect（默认）：把每次执行的输入追加到累加器数组（跨迭代/多次执行累计，运行级共享）；
 *   典型场景：放在迭代内部流水线里，逐项收集结果。
 * - merge：把输入（数组的数组）扁平化合并为单个数组。
 */
import type { NodeExecutor, ExecutionContext } from '@/components/workFlow/engine/NodeExecutor'
import type { NodeData } from '@/components/workFlow/engine/WorkflowRunner'

export const aggregatorExecutor: NodeExecutor = {
  type: 'aggregator',
  label: '变量聚合节点',
  async execute(node: NodeData, ctx: ExecutionContext): Promise<boolean> {
    const cfg = node.aggregatorConfig || {}
    const mode = cfg.mode || 'collect'

    try {
      let input: any
      const raw = (cfg.inputVar || '').trim()
      if (raw) {
        input = ctx.resolveTemplate(raw, node.id)
      } else {
        const contexts = await ctx.getNodeContextWithPorts(node.id, ctx.decisionPaths)
        input = contexts[0] ?? ''
      }

      // 尝试把字符串解析为 JSON 值（数组/对象）
      let parsed: any = input
      if (typeof input === 'string' && input.trim()) {
        try { parsed = JSON.parse(input) } catch { parsed = input }
      }

      if (mode === 'merge') {
        const source = Array.isArray(parsed) ? parsed : [parsed]
        const flat = source.flat()
        node.result = JSON.stringify({
          type: 'aggregator', success: true, mode,
          result: `${ctx.t('aggregator_merge_done')}：${flat.length} 项`,
          output: flat, count: flat.length,
          timestamp: new Date().toISOString()
        })
      } else {
        const acc = ctx.getAccumulator(node.id) || []
        acc.push(parsed)
        ctx.setAccumulator(node.id, acc)
        node.result = JSON.stringify({
          type: 'aggregator', success: true, mode: 'collect',
          result: `${ctx.t('aggregator_collect_done')}：${acc.length} 项`,
          output: acc, count: acc.length,
          timestamp: new Date().toISOString()
        })
      }

      node.status = 'success'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'success', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'success', node.result)
      return true
    } catch (e: any) {
      node.result = JSON.stringify({
        result: `${ctx.t('aggregator_error')}: ${e?.message}`, type: 'aggregator',
        success: false, error: e?.message, timestamp: new Date().toISOString()
      })
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }
  }
}
