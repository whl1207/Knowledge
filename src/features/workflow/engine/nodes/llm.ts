/**
 * 大语言模型节点执行器
 *
 * 提示词消息按角色展开并求值变量；启用了上下文时把上下文作为额外的系统消息注入
 * （对齐 Dify：上下文不写进提示词文本，而是单独作为 context 参数下发）。
 */
import { resolveSelectorText, resolveText } from '../template'
import { applyNodeModel, readModelParams, type NodeModelRef } from '../modelBridge'
import type { NodeExecutionContext, NodeExecutionResult, WorkflowNodeExecutor } from '../types'
import type { PromptMessage } from '@/features/workflow/dsl/types'

export const llmExecutor: WorkflowNodeExecutor = {
  type: 'llm',
  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const data = ctx.node as unknown as Record<string, unknown>
    const model = data.model as NodeModelRef | undefined
    if (!model?.provider || !model?.name) throw new Error('请先配置模型来源与模型')

    const prompt = Array.isArray(data.prompt_template) ? (data.prompt_template as PromptMessage[]) : []
    if (!prompt.length) throw new Error('请至少添加一条提示词消息')

    const messages: Array<{ role: string; content: string }> = []
    for (const message of prompt) {
      const { value, warnings } = resolveText(String(message.text ?? ''), ctx.pool)
      for (const warning of warnings) {
        ctx.log('warning', `提示词引用 ${warning.selector.join('.')} 没有数据，已留空`)
      }
      messages.push({ role: message.role || 'user', content: value })
    }

    const context = data.context as { enabled?: boolean; variable_selector?: string[] } | undefined
    if (context?.enabled) {
      const text = resolveSelectorText(context.variable_selector, ctx.pool)
      if (text) {
        messages.unshift({ role: 'system', content: `上下文：\n${text}` })
        ctx.log('info', `已注入上下文（${text.length} 字）`)
      } else {
        ctx.log('warning', '启用了上下文但没有取到内容')
      }
    }

    if ((data.memory as { window?: { enabled?: boolean } } | undefined)?.window?.enabled) {
      ctx.log('warning', '多轮记忆暂未支持，本次忽略该配置')
    }
    if ((data.vision as { enabled?: boolean } | undefined)?.enabled) {
      ctx.log('warning', '视觉输入暂未支持，本次忽略该配置')
    }
    if ((data.structured_output as { enabled?: boolean } | undefined)?.enabled) {
      ctx.log('warning', '结构化输出暂未支持，本次忽略该配置')
    }

    const params = readModelParams(model)
    const restore = applyNodeModel(ctx.store, model)
    try {
      const result = await ctx.requestAi(messages, params)
      if (!result.text) throw new Error('模型没有返回内容')

      const outputs: Record<string, unknown> = { text: result.text }
      if (result.reasoning) outputs.reasoning_content = result.reasoning
      return { outputs }
    } finally {
      restore()
    }
  },
}
