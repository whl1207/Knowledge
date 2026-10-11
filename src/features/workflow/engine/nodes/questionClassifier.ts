/**
 * question-classifier 执行器
 *
 * 把问题与候选分类交给大模型，命中的分类 id 作为 `selectedHandle`（与 Dify 一致：
 * 边的 sourceHandle 就是 class 的 id）。
 */
import { resolveSelectorText } from '../template'
import { applyNodeModel, readModelParams, type NodeModelRef } from '../modelBridge'
import type { NodeExecutionContext, NodeExecutionResult, WorkflowNodeExecutor } from '../types'

interface ClassItem {
  id?: string
  name?: string
  label?: string
}

export const questionClassifierExecutor: WorkflowNodeExecutor = {
  type: 'question-classifier',
  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const data = ctx.node as unknown as Record<string, unknown>
    const classes = Array.isArray(data.classes) ? (data.classes as ClassItem[]) : []
    if (!classes.length) throw new Error('请先配置问题分类')

    const model = data.model as NodeModelRef | undefined
    if (!model?.provider || !model?.name) throw new Error('请先配置模型来源与模型')

    const query = resolveSelectorText(data.query_variable_selector as string[], ctx.pool)
    if (!query) throw new Error('分类输入为空，请检查查询变量')

    const catalog = classes
      .map((item) => `- id: ${item.id}\n  name: ${item.label || item.name || ''}`)
      .join('\n')
    const prompt = [
      '你是一个问题分类器。请判断下面的输入属于哪一个分类。',
      '',
      `分类列表：\n${catalog}`,
      '',
      `输入：\n${query}`,
      '',
      '只输出分类的 id，不要输出任何解释、引号或多余字符。',
    ].join('\n')

    const restore = applyNodeModel(ctx.store, model)
    try {
      const { text } = await ctx.requestAi([{ role: 'user', content: prompt }], readModelParams(model))
      const normalized = text.trim().replace(/^["'\s]+|["'\s]+$/g, '')
      const hit = classes.find((item) => String(item.id) === normalized)
        ?? classes.find((item) => normalized.includes(String(item.id)))
        ?? classes.find((item) => item.name && normalized.includes(String(item.name)))
        ?? classes.find((item) => item.label && normalized.includes(String(item.label)))
      if (!hit?.id) throw new Error(`无法从模型输出判断分类：${text.slice(0, 80)}`)

      ctx.log('info', `分类结果：${hit.label || hit.name || hit.id}（模型输出：${normalized.slice(0, 40)}）`)
      return { selectedHandle: String(hit.id), outputs: { class_name: String(hit.id), class_label: hit.label || hit.name || '' } }
    } finally {
      restore()
    }
  },
}
