/**
 * ai-km-file（本地文件）执行器
 *
 * - full 模式：整份文件作为 `content` 输出
 * - template 模式：按每个模板的正则切片，切片内容从匹配处到下一个匹配处之前，
 *   分别输出到各自的 `output_name`（与旧版文件节点的切片语义一致）
 */
import { stringifyValue } from '../template'
import type { NodeExecutionContext, NodeExecutionResult, WorkflowNodeExecutor } from '../types'

interface FileTemplate {
  name?: string
  pattern?: string
  output_name?: string
}

export const localFileExecutor: WorkflowNodeExecutor = {
  type: 'ai-km-file',
  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const data = ctx.node as unknown as Record<string, unknown>
    const filePath = stringifyValue(data.file_path).trim()
    if (!filePath) throw new Error('请先选择文件')

    let content: string
    try {
      const raw = await ctx.invokeIpc('readFile', filePath)
      content = typeof raw === 'string' ? raw : stringifyValue(raw)
    } catch (error) {
      throw new Error(`读取文件失败：${(error as Error).message}`)
    }

    const mode = String(data.file_mode ?? 'full')
    if (mode !== 'template') {
      ctx.log('info', `完整文件模式，${content.length} 字符`)
      return { outputs: { content } }
    }

    const templates = Array.isArray(data.file_templates) ? (data.file_templates as FileTemplate[]) : []
    if (!templates.length) throw new Error('模板模式下至少需要一个模板')

    const outputs: Record<string, unknown> = { content }

    templates.forEach((template, index) => {
      const outputName = String(template.output_name || `output${index + 1}`)
      const pattern = String(template.pattern ?? '').trim()
      if (!pattern) {
        outputs[outputName] = ''
        ctx.log('warning', `模板「${template.name || index + 1}」缺少匹配模式，输出空字符串`)
        return
      }

      let regex: RegExp
      try {
        regex = new RegExp(pattern, 'g')
      } catch (error) {
        outputs[outputName] = ''
        ctx.log('warning', `模板「${template.name || index + 1}」的正则无效：${(error as Error).message}`)
        return
      }

      const matches: number[] = []
      let match: RegExpExecArray | null
      while ((match = regex.exec(content)) !== null) {
        matches.push(match.index)
        // 防御空匹配导致的死循环
        if (match.index === regex.lastIndex) regex.lastIndex++
      }
      if (!matches.length) {
        outputs[outputName] = ''
        ctx.log('warning', `模板「${template.name || index + 1}」未匹配到内容`)
        return
      }

      const pieces = matches.map((start, i) => {
        const end = i + 1 < matches.length ? matches[i + 1] : content.length
        return content.substring(start, end).trim()
      })
      outputs[outputName] = pieces.join('\n\n')
      ctx.log('info', `模板「${template.name || index + 1}」命中 ${matches.length} 段 → ${outputName}`)
    })

    return { outputs }
  },
}
