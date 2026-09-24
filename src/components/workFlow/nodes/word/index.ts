/**
 * word executor - Word 导出节点
 *
 * 复用 Markdown → .docx 统一导出管线：
 *   prepareMarkdownDocxHtml（渲染 + 模板/皮肤解析）→ buildDocxBlob（构包）→ saveDocxBlob（主进程写盘）
 * 因此导出效果与文件阅读/聊天导出的 Word 完全一致（公式 OMML、mermaid 转 PNG、表格列宽、加粗等）。
 * - 内容：wordConfig.content 模板优先；为空时取上游节点上下文
 * - 模板：wordConfig.template（'' = 跟随设置页）
 * - 位置：wordConfig.dirPath（目录，可模板）+ wordConfig.fileName（文件名，可模板）
 *   目录留空 → 主进程把「只有文件名」写到系统下载目录
 */
import type { NodeExecutor, ExecutionContext } from '@/components/workFlow/engine/NodeExecutor'
import type { NodeData } from '@/components/workFlow/engine/WorkflowRunner'
import type { WordExportConfig } from '@/components/workFlow/WorkflowTypes'
import { buildDocxBlob } from '@/lib/export/docx'
import { prepareMarkdownDocxHtml, saveDocxBlob } from '@/lib/export/md-to-docx'

/** 清理文件名中的非法字符（Windows 保留字符 + 空白折叠），并限制长度 */
function sanitizeFileName(name: string): string {
  return (name || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
}

/** 拼接目录与文件名（目录可带或不带尾部分隔符；目录为空则只返回文件名） */
function joinPath(dir: string, file: string): string {
  const d = (dir || '').replace(/[\\/]+$/, '')
  return d ? `${d}/${file}` : file
}

export const wordExecutor: NodeExecutor = {
  type: 'word',
  label: 'Word 导出节点',
  async execute(node: NodeData, ctx: ExecutionContext): Promise<boolean> {
    const cfg: WordExportConfig = node.wordConfig || {}

    const fail = (msg: string): boolean => {
      node.result = JSON.stringify({ result: msg, type: 'word', success: false, error: msg })
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }

    if (ctx.abortController?.signal.aborted) return fail(ctx.t('word_aborted'))

    // 1. 导出内容：配置模板优先，为空时取上游上下文
    let markdown = cfg.content ? ctx.resolveTemplate(cfg.content, node.id) : ''
    if (!markdown.trim()) {
      const upstream = await ctx.getNodeContextWithPorts(node.id, ctx.decisionPaths)
      markdown = upstream.filter(Boolean).join('\n\n')
    }
    if (!markdown.trim()) return fail(ctx.t('word_content_required'))

    try {
      // 2. 渲染 HTML + 解析导出模板/样式皮肤（复用统一导出管线）
      const prep = await prepareMarkdownDocxHtml(markdown, {
        template: cfg.template || undefined,
        stylePath: cfg.stylePath || undefined,
      })
      if (!prep) return fail(ctx.t('word_content_required'))

      // 3. 构建 .docx
      const blob = await buildDocxBlob(prep.html, prep.skin, prep.page)

      // 4. 保存位置：目录 + 文件名（均支持 {{节点.字段}} 模板）
      const rawName = cfg.fileName ? ctx.resolveTemplate(cfg.fileName, node.id) : ''
      const fileName = sanitizeFileName(rawName || node.name || '文档') || '文档'
      const dirPath = cfg.dirPath ? ctx.resolveTemplate(cfg.dirPath, node.id).trim() : ''
      const targetPath = joinPath(dirPath, /\.docx$/i.test(fileName) ? fileName : `${fileName}.docx`)

      // 5. 写盘（Electron 主进程 exportDocx；非 Electron 环境返回 not-electron）
      const res = await saveDocxBlob(blob, targetPath, cfg.overwrite === true)
      if (!res.ok || !res.path) {
        const err = res.error === 'not-electron' ? ctx.t('word_not_electron') : (res.error || 'unknown')
        return fail(`${ctx.t('word_export_error')}: ${err}`)
      }

      const sizeKb = Math.max(1, Math.round(blob.size / 1024))
      node.result = JSON.stringify({
        result: `${ctx.t('word_export_done')}：${res.path}`,
        type: 'word',
        success: true,
        path: res.path,
        template: prep.templateKey,
        size: blob.size,
        sizeKb,
        chars: markdown.length,
        timestamp: new Date().toISOString(),
      })
      node.status = 'success'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'success', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'success', node.result)
      ctx.log(`${ctx.t('word_node')}：${res.path}（${sizeKb} KB，模板 ${prep.templateKey}）`, 'info')
      return true
    } catch (e: any) {
      return fail(`${ctx.t('word_export_error')}: ${e?.message || e}`)
    }
  },
}
