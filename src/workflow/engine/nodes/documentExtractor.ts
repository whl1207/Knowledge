/**
 * document-extractor（文档提取器）执行器
 *
 * 取一个文件变量（本地路径），读成文本。主进程 readFile 已内置 .docx → Markdown 转换，
 * 因此 word 文档也能直接读取；不支持的二进制格式会给出明确提示。
 */
import { resolveSelector, stringifyValue } from '../template'
import type { NodeExecutionContext, NodeExecutionResult, WorkflowNodeExecutor } from '../types'

const TEXT_EXTENSIONS = [
  '.md', '.txt', '.json', '.csv', '.tsv', '.yml', '.yaml', '.xml', '.html', '.htm',
  '.log', '.ini', '.toml', '.js', '.ts', '.py', '.css', '.sql',
]

export const documentExtractorExecutor: WorkflowNodeExecutor = {
  type: 'document-extractor',
  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const data = ctx.node as unknown as Record<string, unknown>
    const raw = resolveSelector(data.variable_selector as string[], ctx.pool)
    const path = stringifyValue(raw).trim()
    if (!path) throw new Error('请先选择文件变量（内容应为文件路径）')

    const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
    const readable = ['.docx', '.doc'].includes(extension) || TEXT_EXTENSIONS.includes(extension)
    if (!readable) {
      throw new Error(`暂不支持读取 ${extension || '该'} 格式，请改用文本 / Markdown / Word / CSV 文件`)
    }

    ctx.log('info', `读取文件 ${path}`)
    try {
      const text = await ctx.invokeIpc('readFile', path)
      const content = typeof text === 'string' ? text : stringifyValue(text)
      ctx.log('info', `已读取 ${content.length} 字符`)
      return { outputs: { text: content } }
    } catch (error) {
      throw new Error(`读取文件失败：${(error as Error).message}`)
    }
  },
}
