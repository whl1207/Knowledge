/**
 * ai-km-csv（本地数据表）执行器
 *
 * 走主进程 readDataFile（CSV / TSV / Excel 统一入口），
 * 输出 rows / headers / total / batches，与旧版数据节点行为一致。
 */
import { stringifyValue } from '../template'
import type { NodeExecutionContext, NodeExecutionResult, WorkflowNodeExecutor } from '../types'

export const csvExecutor: WorkflowNodeExecutor = {
  type: 'ai-km-csv',
  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const data = ctx.node as unknown as Record<string, unknown>
    const filePath = stringifyValue(data.file_path).trim()
    if (!filePath) throw new Error('请先选择数据文件')

    const extension = filePath.split('.').pop()?.toLowerCase() || 'csv'
    const delimiter = String(data.delimiter || (extension === 'tsv' ? '\t' : ','))
    const hasHeader = data.has_header !== false
    const loadMode = String(data.load_mode ?? 'preview')
    const previewRows = Math.max(1, Number(data.preview_rows ?? 20))
    const maxRows = Math.max(0, Number(data.max_rows ?? 0))
    const batchSize = Math.max(0, Number(data.batch_size ?? 0))

    // stats / preview 只统计 + 预览；auto / full 全量收集（受 max_rows 限制）
    const collectAll = loadMode !== 'stats' && loadMode !== 'preview'
    const result = await ctx.invokeIpc('readDataFile', {
      filePath,
      delimiter,
      hasHeader,
      maxRows: collectAll ? maxRows : 0,
      previewRows: loadMode === 'stats' ? 0 : previewRows,
      collectAll,
    })

    if (!result || result.ok === false) throw new Error(String(result?.error || '文件读取失败'))

    const rows = Array.isArray(result.rows) ? result.rows : []
    const headers = Array.isArray(result.headers) ? result.headers : []
    const total = typeof result.total === 'number' && result.total >= 0 ? result.total : rows.length

    ctx.log('info', `读取 ${total} 行${result.tooLarge ? '（数据过大，只保留预览）' : ''}`)

    const outputs: Record<string, unknown> = { rows, headers, total }
    if (batchSize > 0 && rows.length) {
      const batches: unknown[][] = []
      for (let i = 0; i < rows.length; i += batchSize) batches.push(rows.slice(i, i + batchSize))
      outputs.batches = batches
      ctx.log('info', `已分批 ${batches.length} 批（每批 ${batchSize} 行）`)
    }
    return { outputs }
  },
}
