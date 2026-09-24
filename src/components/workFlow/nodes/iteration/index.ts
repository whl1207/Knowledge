/**
 * iteration executor - 迭代节点
 *
 * 输入：一个数组（模板 {{节点.字段}} / JSON 数组 / 上游数据）。
 * 对每个元素执行内部线性流水线（innerItems），并把元素作为 {{迭代节点.item}}（及 item.index、
 * 元素自身字段）注入内层作用域。收集指定内部节点的输出（outputNodeId/outputKey，默认内部
 * 最后一个节点 result）。支持并行（concurrency）与错误处理模式：
 * - terminated            出错立即终止
 * - continue_with_error   跳过出错项继续
 * - remove_abnormal_output 同上，且从输出中剔除失败项
 */
import type { NodeExecutor, ExecutionContext } from '@/components/workFlow/engine/NodeExecutor'
import type { NodeData, Link } from '@/components/workFlow/engine/WorkflowRunner'
import { resolveArrayInput } from '@/components/workFlow/engine/executorHelpers'

/** 内部节点类型（迷你流水线，运行期通过统一执行器注册表调度） */
interface InnerNodeLike {
  id: number
  type: string
  name: string
  prompt?: string
  model_type?: string
  model?: string
}

/** 由迭代节点 id 派生内部节点 id，避免与外层节点 id 冲突 */
const INNER_ID_BASE = 1000000

function buildInnerPipeline(node: NodeData, ctx: ExecutionContext): { items: NodeData[]; links: Link[]; lastId: number } {
  const inners: InnerNodeLike[] = node.iterationConfig?.innerItems || []
  if (inners.length === 0) {
    throw new Error(ctx.t('iteration_no_inner'))
  }
  const base = node.id * INNER_ID_BASE
  const items: NodeData[] = inners.map((n, i) => {
    const id = base + i
    return {
      id,
      name: n.name || `${ctx.t('inner_step')} ${i + 1}`,
      type: n.type as any,
      model_type: n.model_type || '',
      model: n.model || '',
      prompt: n.prompt || '',
      result: '',
      x: 0, y: 0, width: 250, height: 80, status: 'idle'
    }
  })
  const links: Link[] = []
  for (let i = 0; i < items.length - 1; i++) {
    links.push({ source: items[i].id, target: items[i + 1].id })
  }
  return { items, links, lastId: items[items.length - 1].id }
}

export const iterationExecutor: NodeExecutor = {
  type: 'iteration',
  label: '迭代节点',
  async execute(node: NodeData, ctx: ExecutionContext): Promise<boolean> {
    const cfg = node.iterationConfig || {}
    const errorMode = cfg.errorMode || 'terminated'
    const concurrency = Math.max(1, cfg.concurrency || 1)
    const maxIterations = Math.max(1, cfg.maxIterations || 1000000)

    let arr: any[]
    try {
      arr = await resolveArrayInput(cfg.inputArray, ctx, node.id, ctx.t)
    } catch (e: any) {
      node.result = JSON.stringify({ result: `${ctx.t('iteration_input_error')}: ${e?.message}`, type: 'iteration', success: false, error: e?.message, timestamp: new Date().toISOString() })
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }

    if (arr.length === 0) {
      node.result = JSON.stringify({ result: ctx.t('iteration_empty'), type: 'iteration', success: true, count: 0, succeeded: 0, failed: 0, output: [] })
      node.status = 'success'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'success', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'success', node.result)
      return true
    }

    let inner: { items: NodeData[]; links: Link[]; lastId: number }
    try {
      inner = buildInnerPipeline(node, ctx)
    } catch (e: any) {
      node.result = JSON.stringify({ result: e?.message, type: 'iteration', success: false, error: e?.message, timestamp: new Date().toISOString() })
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }

    const total = Math.min(arr.length, maxIterations)
    const results: any[] = new Array(total).fill(null)
    const errors: Array<{ index: number; error: string }> = []
    let failedCount = 0
    let itemsWithInnerErrors = 0
    let terminated = false
    let firstError: any = null
    let nextIndex = 0
    let progress = 0
    let lastResultPreview = ''

    // ===== 断点续跑：恢复上次中断时已完成的项，仅执行剩余项 =====
    if (node._iterResume) {
      const rs = node._iterResume
      if (rs.total === total && Array.isArray(rs.done)) {
        const doneSet = new Set<number>()
        for (const d of rs.done) {
          if (d && d.index !== undefined && d.index >= 0 && d.index < total && d.value !== null && d.value !== undefined) {
            results[d.index] = d.value
            doneSet.add(d.index)
          }
        }
        for (const f of rs.failed || []) {
          if (f && f.index !== undefined && f.index >= 0 && f.index < total) {
            errors.push({ index: f.index, error: f.error })
            doneSet.add(f.index)
          }
        }
        failedCount = rs.failed?.length || 0
        while (doneSet.has(nextIndex)) nextIndex++
        if (nextIndex > 0) ctx.log(`${node.name} 续跑：跳过已完成的 ${nextIndex} 项`, 'info')
      }
      // 本次运行结束后会按需重新生成断点，这里先清除旧断点
      delete node._iterResume
      progress = nextIndex
    }
    // 流式预览：保留最近 N 项结果（含序号），限频推送，避免每次更新拖慢 UI
    const STREAM_WINDOW = 100
    const STREAM_INTERVAL = 250
    let lastStreamAt = 0
    const streamBuffer: Array<{ index: number; text: string }> = []
    const pushStream = (index: number, text: string) => {
      streamBuffer.push({ index: index + 1, text })
      if (streamBuffer.length > STREAM_WINDOW) streamBuffer.shift()
    }

    const runOne = async (item: any, index: number): Promise<any> => {
      const seed: Record<number, Record<string, any>> = {}
      const itemObj = (typeof item === 'object' && item !== null) ? item : { value: item }
      seed[node.id] = { item, index, ...itemObj }
      const innerRes = await ctx.runInnerGraph(inner.items, inner.links, seed, { extraNodes: [node], errorMode })
      if (!innerRes.success) {
        const why = innerRes.failedNodeName ? `（${innerRes.failedNodeName}）` : ''
        const detail = innerRes.error ? `: ${innerRes.error}` : ''
        throw new Error(`${ctx.t('iteration_inner_failed')}${why}${detail}`)
      }
      // 统计内层存在错误的项（注入模式：错误已交给下游大模型总结）
      if ((innerRes.failedCount || 0) > 0) itemsWithInnerErrors++
      let outId = cfg.outputNodeId
      if (outId === undefined || outId === null || innerRes.outputs[outId] === undefined) {
        // 默认取最后一个非 end 节点（如内部流水线末端的处理/推理节点），
        // 避免取到 end 节点的拼接文本（end 会给每个上游输出加 "## 节点名" 标题）
        const nonEnd = [...inner.items].reverse().find(n => n.type !== 'end')
        outId = nonEnd ? nonEnd.id : inner.lastId
      }
      const outs = innerRes.outputs[outId] || {}
      const key = cfg.outputKey || 'result'
      const value = outs[key] !== undefined ? outs[key] : (outs.result ?? null)
      // row 模式：把原行字段与结果合并为对象，便于下游列表按字段提取/过滤/排序
      if (cfg.outputMode === 'row') {
        const base = (typeof item === 'object' && item !== null) ? { ...item } : { value: item }
        return { ...base, index, result: value }
      }
      return value
    }

    const worker = async () => {
      while (!terminated && nextIndex < total) {
        if (ctx.abortController?.signal.aborted) { terminated = true; break }
        const index = nextIndex++
        const item = arr[index]
        try {
          const value = await runOne(item, index)
          results[index] = value
          // 预览优先取 result 字段（row 模式每项是 {原行字段..., result}，只显示结果而非整行 JSON）
          const previewVal = (value && typeof value === 'object' && 'result' in value) ? value.result : value
          const s = typeof previewVal === 'string' ? previewVal : (previewVal === null || previewVal === undefined ? '' : JSON.stringify(previewVal))
          lastResultPreview = s.slice(0, 300)
          pushStream(index, lastResultPreview)
          ctx.log(`${node.name} 第 ${index + 1} 项完成: ${lastResultPreview}`, 'info')
        } catch (e: any) {
          if (errorMode === 'terminated') { terminated = true; firstError = e; break }
          failedCount++
          errors.push({ index, error: String(e?.message || e) })
          results[index] = null
          pushStream(index, `[${ctx.t('node_failed')}] ${String(e?.message || e).slice(0, 200)}`)
          ctx.log(`${node.name} 第 ${index + 1} 项失败: ${String(e?.message || e)}`, 'error')
        } finally {
          progress++
          const now = Date.now()
          if (now - lastStreamAt >= STREAM_INTERVAL || progress === total || terminated) {
            lastStreamAt = now
            ctx.callbacks.onNodeStatusUpdate?.(node.id, 'running', JSON.stringify({
              type: 'iteration', streaming: true, progress, total,
              lastItem: lastResultPreview,
              recentResults: streamBuffer,
              result: `${ctx.t('iterating')} ${progress}/${total}`
            }))
          }
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()))

    // 被中止（未完成）→ 保存断点，供「继续执行」从上次位置续跑
    if (terminated && !firstError && progress < total) {
      node._iterResume = {
        total,
        done: results
          .map((v, idx) => (v !== null && v !== undefined ? { index: idx, value: v } : null))
          .filter((x): x is { index: number; value: any } => x !== null),
        failed: errors,
        errorMode,
        outputNodeId: cfg.outputNodeId ?? inner.lastId,
        outputKey: cfg.outputKey || 'result',
      }
      node.result = JSON.stringify({
        result: `${ctx.t('iteration_interrupted')}：完成 ${progress}/${total} 项`,
        type: 'iteration', success: false, interrupted: true,
        count: total, progress,
        timestamp: new Date().toISOString()
      })
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      ctx.log(`${node.name} 中断：完成 ${progress}/${total} 项，已保存断点可继续`, 'error')
      return false
    }

    if (terminated && firstError) {
      const summary = {
        result: `${ctx.t('iteration_terminated')}: ${String(firstError?.message || firstError)}`,
        type: 'iteration', success: false, count: total, progress,
        failed: failedCount + 1, error: String(firstError?.message || firstError),
        timestamp: new Date().toISOString()
      }
      node.result = JSON.stringify(summary)
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }

    const output = results.filter(r => r !== null && r !== undefined)
    // 全量结果进运行期缓存（node.result 只留预览，避免 10 万级数据撑大 .flow/内存）
    ctx.setArrayCache?.(node.id, output)
    const PREVIEW_N = 20
    const summary = {
      result: `${ctx.t('iteration_done')}：${total} 项，成功 ${output.length} 项${failedCount ? `，失败 ${failedCount} 项` : ''}${itemsWithInnerErrors ? `，${itemsWithInnerErrors} 项存在内层错误（已交给大模型总结）` : ''}`,
      type: 'iteration', success: true, count: total,
      succeeded: output.length, failed: failedCount,
      innerErrors: itemsWithInnerErrors,
      output: output.slice(0, PREVIEW_N),
      outputCached: true, outputCount: output.length,
      errors,
      errorMode,
      outputNodeId: inner.lastId,
      outputKey: cfg.outputKey || 'result',
      timestamp: new Date().toISOString()
    }
    node.result = JSON.stringify(summary)
    node.status = 'success'
    ctx.callbacks.onNodeStatusUpdate?.(node.id, 'success', node.result)
    ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'success', node.result)
    ctx.log(`${ctx.t('iteration_node')} 完成：${total} 项，成功 ${output.length}`, 'info')
    return true
  }
}
