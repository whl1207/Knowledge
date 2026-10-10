/**
 * parameter-extractor（参数提取器）执行器
 *
 * 让模型把自然语言抽成结构化参数：要求返回 JSON 对象，键与参数名一致。
 * 输出对齐 Dify：每个参数一个变量 + `__is_success` / `__reason`。
 */
import { resolveSelectorText, stringifyValue } from '../template'
import { applyNodeModel, readModelParams, type NodeModelRef } from '../modelBridge'
import type { NodeExecutionContext, NodeExecutionResult, WorkflowNodeExecutor } from '../types'

interface ParameterSpec {
  name?: string
  type?: string
  description?: string
  required?: boolean
}

export const parameterExtractorExecutor: WorkflowNodeExecutor = {
  type: 'parameter-extractor',
  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const data = ctx.node as unknown as Record<string, unknown>
    const parameters = Array.isArray(data.parameters) ? (data.parameters as ParameterSpec[]) : []
    if (!parameters.length) throw new Error('请先定义要提取的参数')

    const model = data.model as NodeModelRef | undefined
    if (!model?.provider || !model?.name) throw new Error('请先配置模型来源与模型')

    const query = resolveSelectorText(data.query as string[], ctx.pool).trim()
    if (!query) throw new Error('提取内容为空，请检查输入变量')

    const catalog = parameters
      .map((item) => `- ${item.name}（${item.type ?? 'string'}${item.required ? '，必填' : ''}）：${item.description ?? ''}`)
      .join('\n')
    const prompt = [
      '请从下面的内容中提取结构化参数，并以 JSON 对象输出。',
      '',
      `参数列表：\n${catalog}`,
      '',
      `内容：\n${query}`,
      '',
      '要求：只输出 JSON 对象，键必须是上面列出的参数名；无法确定的参数给出 null。不要输出解释或代码块标记。',
    ].join('\n')

    const restore = applyNodeModel(ctx.store, model)
    try {
      const { text } = await ctx.requestAi([{ role: 'user', content: prompt }], readModelParams(model))
      const parsed = parseJsonObject(text)
      if (!parsed) {
        return { outputs: { __is_success: 0, __reason: `模型输出无法解析为 JSON：${text.slice(0, 120)}` } }
      }

      const outputs: Record<string, unknown> = { __is_success: 1, __reason: '' }
      for (const item of parameters) {
        const name = String(item.name || '').trim()
        if (!name) continue
        outputs[name] = parsed[name] ?? null
      }
      ctx.log('info', `已提取 ${Object.keys(parsed).length} 个参数`)
      return { outputs }
    } finally {
      restore()
    }
  },
}

/** 宽容地取出 JSON 对象：容忍 ```json 代码块与前后说明文字 */
function parseJsonObject(text: string): Record<string, unknown> | null {
  const raw = String(text ?? '')
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = (fenced ? fenced[1] : raw).trim()
  try {
    const parsed = JSON.parse(candidate)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    const brace = candidate.match(/\{[\s\S]*\}/)
    if (brace) {
      try {
        const parsed = JSON.parse(brace[0])
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
      } catch {
        return null
      }
    }
  }
  return null
}

void stringifyValue
