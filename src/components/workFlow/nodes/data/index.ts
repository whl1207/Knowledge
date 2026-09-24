/**
 * data executor - 数据(CSV)节点
 *
 * 通过主进程 readDataFile 流式读取本地 CSV / TSV / TXT / JSON，避免大数据整文件读入内存卡死。
 * - hasHeader：首行为表头（默认 true），行输出为 { 列名: 值 }
 * - loadMode：auto（默认，有 maxRows/batchSize 则全量收集否则仅统计+预览）/ stats（仅统计）/
 *   preview（统计+前 previewRows 行）/ full（全量，受 maxRows 限制）
 * - maxRows：>0 时仅加载前 N 行
 * - batchSize：>0 且全量收集时额外输出 batches（分批数组），便于配合迭代节点分批处理
 */
import type { NodeExecutor, ExecutionContext } from '@/components/workFlow/engine/NodeExecutor'
import type { NodeData } from '@/components/workFlow/engine/WorkflowRunner'

function extractPath(text: string): string | null {
  const m = text.match(/([A-Za-z]:[\\/][^"\n]*|file:\/\/[^\s"']+|\/[^"\n]*\.(?:csv|tsv|txt|json))/i)
  return m ? m[0].trim() : null
}

export const dataExecutor: NodeExecutor = {
  type: 'data',
  label: '数据(CSV)节点',
  async execute(node: NodeData, ctx: ExecutionContext): Promise<boolean> {
    const cfg = node.dataConfig || {}
    let filePath = (cfg.filePath || node.prompt || '').trim()
    if (!filePath) {
      const contexts = await ctx.getNodeContextWithPorts(node.id, ctx.decisionPaths)
      for (const c of contexts) {
        const p = extractPath(c)
        if (p) { filePath = p; break }
      }
    }
    if (!filePath) {
      node.result = JSON.stringify({ result: ctx.t('data_file_required'), type: 'data', success: false, error: ctx.t('data_file_required') })
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }

    try {
      const ext = filePath.split('.').pop()?.toLowerCase() || 'txt'
      const delimiter = cfg.delimiter || (ext === 'tsv' ? '\t' : ',')
      const hasHeader = cfg.hasHeader !== false
      const maxRows = Math.max(0, cfg.maxRows || 0)
      const batchSize = Math.max(0, cfg.batchSize || 0)
      const previewRows = Math.max(1, cfg.previewRows || 100)
      const loadMode = cfg.loadMode || 'auto'

      // 决定 IPC 参数：是否收集全部行、收集上限、预览行数
      // auto / full 默认全量收集（受 maxRows 限制）；stats / preview 仅统计 + 预览
      let collectAll = false
      let effectiveMax = 0
      if (loadMode === 'stats' || loadMode === 'preview') { collectAll = false }
      else { collectAll = true; effectiveMax = maxRows }
      const preview = loadMode === 'stats' ? 0 : previewRows

      const res = await ctx.safeIpcInvoke('readDataFile', {
        filePath, delimiter, hasHeader,
        maxRows: effectiveMax, previewRows: preview, collectAll
      })

      if (!res || res.ok === false) {
        throw new Error(res?.error || ctx.t('data_read_error'))
      }

      const rows = Array.isArray(res.rows) ? res.rows : []
      const headers = Array.isArray(res.headers) ? res.headers : []
      const total = typeof res.total === 'number' && res.total >= 0 ? res.total : rows.length
      const tooLarge = !!res.tooLarge

      // 全量模式：构建分批并写入运行期缓存（供迭代/列表直接取全量 rows/batches）
      const batches: any[][] = []
      if (collectAll && batchSize > 0) {
        for (let i = 0; i < rows.length; i += batchSize) {
          batches.push(rows.slice(i, i + batchSize))
        }
      }
      if (collectAll && !tooLarge && ctx.setDataCache) {
        ctx.setDataCache(node.id, { rows, batches, headers, total })
      }

      // node.result 只保留预览行（轻量，避免大 JSON 卡顿 / 撑大 .flow 文件）
      const previewArr = rows.slice(0, preview)

      const isPreview = !collectAll && !tooLarge
      const summaryParts: string[] = []
      if (tooLarge) summaryParts.push('文件过大，仅统计')
      else if (total >= 0) summaryParts.push(`共 ${total} 行`)
      if (isPreview) summaryParts.push(`预览 ${previewArr.length} 行`)
      else if (rows.length !== total) summaryParts.push(`加载 ${rows.length} 行`)
      if (batches.length > 0) summaryParts.push(`分为 ${batches.length} 批`)

      node.result = JSON.stringify({
        type: 'data', success: true, filePath, headers,
        total, rows: previewArr,
        batchCount: batches.length,
        preview: isPreview, tooLarge, truncated: !!res.truncated, size: res.size || 0,
        result: `${ctx.t('data_read_done')}：${summaryParts.join('，') || '—'}`,
        timestamp: new Date().toISOString()
      })
      node.status = 'success'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'success', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'success', node.result)
      ctx.log(`${ctx.t('data_node')} 读取：共 ${total} 行${isPreview ? `（预览 ${previewArr.length} 行）` : '（全量，已缓存）'}`, 'info')
      return true
    } catch (e: any) {
      node.result = JSON.stringify({ result: `${ctx.t('data_read_error')}: ${e?.message}`, type: 'data', success: false, error: e?.message, filePath, timestamp: new Date().toISOString() })
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }
  }
}
