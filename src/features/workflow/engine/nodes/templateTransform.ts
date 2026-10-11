/**
 * template-transform（模板转换）执行器
 *
 * Dify 用 Jinja2 模板 + variables 绑定。这里实现**占位符替换**子集：
 * `{{ 变量名 }}` 会被替换为绑定取值，其余原样输出。
 * 变量名与绑定名一一对应（面板里逐条编辑）。
 */
import { resolveSelector, stringifyValue } from '../template'
import type { NodeExecutionContext, NodeExecutionResult, WorkflowNodeExecutor } from '../types'

export const templateTransformExecutor: WorkflowNodeExecutor = {
  type: 'template-transform',
  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const data = ctx.node as unknown as Record<string, unknown>
    const template = String(data.template ?? '')
    if (!template.trim()) throw new Error('请先填写模板内容')

    const variables = Array.isArray(data.variables)
      ? (data.variables as Array<{ variable?: string; value_selector?: string[] }>)
      : []

    // 按变量名长度倒序替换，避免 name 是 name2 的前缀时误替换
    const bindings = variables
      .filter((item) => item.variable)
      .map((item) => ({
        name: String(item.variable),
        value: stringifyValue(resolveSelector(item.value_selector, ctx.pool)),
      }))
      .sort((a, b) => b.name.length - a.name.length)

    let output = template
    for (const binding of bindings) {
      const pattern = new RegExp(`\\{\\{\\s*${escapeRegExp(binding.name)}\\s*\\}\\}`, 'g')
      output = output.replace(pattern, binding.value)
    }

    const unresolved = output.match(/\{\{\s*[^}]+?\s*\}\}/g)
    if (unresolved?.length) {
      ctx.log('warning', `模板里还有 ${unresolved.length} 处未绑定的占位符：${unresolved.slice(0, 3).join('、')}`)
    }

    return { outputs: { output } }
  },
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
