/**
 * 节点模型配置 → 应用 AI 配置的桥接
 *
 * 节点的 `model: { provider, name }` 用的是本应用的来源标识（如 `ollama`、`deepseek`、`custom:0`），
 * 而应用侧统一入口 `store.sendToAI` 读的是 `store.AIconfig.llm`。
 * 因此运行前把节点配置临时写进去，运行后还原。
 */

import { applyModelConfig } from './modelOptions'

export interface NodeModelRef {
  provider?: string
  name?: string
  completion_params?: Record<string, unknown>
}

/** 把 `custom:0` 拆成来源类型与来源下标 */
function splitProvider(provider: string): { modelType: string; customSourceIndex?: number } {
  if (provider.startsWith('custom:')) {
    const index = Number.parseInt(provider.slice('custom:'.length), 10)
    return { modelType: 'custom', customSourceIndex: Number.isNaN(index) ? 0 : index }
  }
  return { modelType: provider }
}

/**
 * 应用节点模型配置，返回「还原函数」（务必在 finally 里调用）。
 */
export function applyNodeModel(store: any, model: NodeModelRef | undefined): () => void {
  const provider = String(model?.provider || '')
  const name = String(model?.name || '')
  if (!provider || !store?.AIconfig?.llm) return () => {}

  const { modelType, customSourceIndex } = splitProvider(provider)
  const original = applyModelConfig(store, { modelType, model: name, customSourceIndex })

  return () => {
    if (store.AIconfig?.llm) store.AIconfig.llm = original
  }
}

/** 读取节点的推理参数（温度 / 最大长度） */
export function readModelParams(model: NodeModelRef | undefined): { temperature?: number; maxTokens?: number } {
  const params = model?.completion_params ?? {}
  const temperature = Number(params.temperature)
  const maxTokens = Number(params.max_tokens)
  return {
    temperature: Number.isFinite(temperature) ? temperature : undefined,
    maxTokens: Number.isFinite(maxTokens) ? maxTokens : undefined,
  }
}
