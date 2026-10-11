/**
 * ai-km-word（导出 Word）执行器
 *
 * 复用统一导出管线：prepareMarkdownDocxHtml → buildDocxBlob → saveDocxBlob，
 * 导出效果与软件内其它 Word 导出完全一致（公式 OMML、mermaid 转图、模板皮肤）。
 */
import { buildDocxBlob } from '@/lib/export/docx'
import { prepareMarkdownDocxHtml, saveDocxBlob } from '@/lib/export/md-to-docx'
import { resolveSelectorText, resolveText } from '../template'
import type { NodeExecutionContext, NodeExecutionResult, WorkflowNodeExecutor } from '../types'

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

export const wordExecutor: WorkflowNodeExecutor = {
  type: 'ai-km-word',
  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const data = ctx.node as unknown as Record<string, unknown>

    // 1. 内容：变量引用优先，其次字面量模板
    let markdown = resolveSelectorText(data.content_variable_selector as string[], ctx.pool)
    if (!markdown.trim()) {
      markdown = resolveText(String(data.content ?? ''), ctx.pool).value
    }
    if (!markdown.trim()) throw new Error('导出内容为空，请选择内容变量或填写内容模板')

    // 2. 渲染 HTML + 解析导出模板/样式皮肤
    const template = String(data.template ?? '')
    const prep = await prepareMarkdownDocxHtml(markdown, {
      template: template && template !== 'custom' ? template : undefined,
      stylePath: String(data.style_path ?? '') || undefined,
    })
    if (!prep) throw new Error('导出内容无法渲染')

    // 3. 构包
    const blob = await buildDocxBlob(prep.html, prep.skin, prep.page)

    // 4. 保存位置：目录 + 文件名（均支持 {{#节点.变量#}} 模板）
    const rawName = String(data.file_name ?? '') ? resolveText(String(data.file_name), ctx.pool).value : ''
    const fileName = sanitizeFileName(rawName || ctx.node.title || '文档') || '文档'
    const dirPath = String(data.dir_path ?? '') ? resolveText(String(data.dir_path), ctx.pool).value.trim() : ''
    const targetPath = joinPath(dirPath, /\.docx$/i.test(fileName) ? fileName : `${fileName}.docx`)

    // 5. 写盘
    const res = await saveDocxBlob(blob, targetPath, data.overwrite === true)
    if (!res.ok || !res.path) {
      const reason = res.error === 'not-electron' ? '当前环境不支持写盘' : (res.error || '未知错误')
      throw new Error(`Word 导出失败：${reason}`)
    }

    const sizeKb = Math.max(1, Math.round(blob.size / 1024))
    ctx.log('info', `已导出 ${res.path}（${sizeKb} KB，模板 ${prep.templateKey}）`)
    return {
      outputs: {
        file_path: res.path,
        file_name: res.path.split(/[\\/]/).pop() || fileName,
      },
    }
  },
}
