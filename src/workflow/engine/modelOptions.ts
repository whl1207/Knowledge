/**
 * modelOptions.ts — 工作流节点的模型来源 / 模型选项（原旧引擎 executorHelpers 的等价实现）
 *
 * 节点的 `model: { provider, name }` 里 provider 用应用统一来源标识（`ollama` / `deepseek` /
 * `custom:<index>` 等），本文件负责把 store 里的来源配置翻译成下拉选项与模型列表，
 * 并提供「临时改写 store.AIconfig.llm」的应用函数（运行后必须还原）。
 */

import { deepSeekStyleOf, normalizeLlmType } from '@/shared/llmSources'

/** 可用的模型来源类型（过滤被禁用的；custom 仅在存在启用的自定义来源时显示） */
export function getModelTypes(store: any): string[] {
  const list = ['ollama', 'lmstudio', 'deepseek', 'gpustack', 'openai', 'anthropic', 'google', 'azure', 'custom']
  return list.filter(
    (type) => !store?.isLlmSourceDisabled?.(type) && (type !== 'custom' || !!store?.hasEnabledCustomSource?.()),
  )
}

/** 某来源当前可用的模型列表（type 可为 custom:<index>，指定具体自定义来源） */
export function getAvailableModels(store: any, type: string): string[] {
  const llm = store?.AIconfig?.llm
  if (!llm) return []
  type = normalizeLlmType(type)
  switch (type) {
    case 'ollama':
      return Array.isArray(llm.ollama?.available_models) ? llm.ollama.available_models : []
    case 'lmstudio':
      return Array.isArray(llm.lmstudio?.available_models) ? llm.lmstudio.available_models : []
    case 'openai':
      return Array.isArray(llm.openai?.available_models) ? llm.openai.available_models : []
    case 'deepseek': {
      // 单来源：模型列表取当前接口样式对应的配置块
      const cfg: any = llm.deepseek?.api_style === 'responses' ? llm.deepseekResponses : llm.deepseek
      return Array.isArray(cfg?.available_models) ? cfg.available_models : []
    }
    case 'gpustack':
      return llm.gpustack?.model
        ? [llm.gpustack.model]
        : Array.isArray(llm.gpustack?.available_models)
          ? llm.gpustack.available_models
          : []
    case 'anthropic':
      return llm.anthropic?.model
        ? [llm.anthropic.model]
        : ['claude-3-haiku-20240307', 'claude-3-sonnet-20240229', 'claude-3-opus-20240229']
    case 'google':
      return llm.google?.model ? [llm.google.model] : ['gemini-pro', 'gemini-pro-vision']
    case 'azure':
      return llm.azure?.deployment
        ? [llm.azure.deployment]
        : Array.isArray(llm.azure?.available_models)
          ? llm.azure.available_models
          : []
    default: {
      // 兼容 custom:<index>（指定来源）与裸 custom（激活来源）
      const c = llm.custom
      const sources = Array.isArray(c?.sources) ? c.sources : []
      let index = typeof c?.activeIndex === 'number' ? c.activeIndex : 0
      if (typeof type === 'string' && type.startsWith('custom:')) {
        const n = Number.parseInt(type.slice('custom:'.length), 10)
        if (!Number.isNaN(n) && n >= 0 && n < sources.length) index = n
      }
      const source = sources[index]
      if (source && Array.isArray(source.available_models) && source.available_models.length) {
        return source.available_models
      }
      return Array.isArray(c?.available_models) ? c.available_models : []
    }
  }
}

/** 来源下拉选项：内置来源 + 每个自定义来源独立一项（value 为 custom:<index>，label 用来源名） */
export function getModelOptions(store: any, t: (key: string) => string): Array<{ value: string; label: string }> {
  const typeLabel = (type: string): string => {
    const map: Record<string, string> = {
      ollama: t('ollama'),
      lmstudio: 'LM Studio',
      openai: t('openai'),
      deepseek: t('deepseek'),
      anthropic: t('anthropic'),
      google: t('google'),
      azure: t('azure'),
      custom: t('custom'),
    }
    return map[type] || type
  }

  const options: Array<{ value: string; label: string }> = []
  for (const type of getModelTypes(store)) {
    if (type !== 'custom') options.push({ value: type, label: typeLabel(type) })
  }
  const custom = store?.AIconfig?.llm?.custom
  const sources = Array.isArray(custom?.sources) ? custom.sources : []
  for (let i = 0; i < sources.length; i++) {
    if (store?.isLlmSourceDisabled?.('custom', sources[i]?.id)) continue
    const name = sources[i]?.name ? String(sources[i].name).trim() : ''
    options.push({ value: `custom:${i}`, label: name || typeLabel('custom') })
  }
  return options
}

export interface NodeModelTarget {
  modelType: string
  model?: string
  customSourceIndex?: number
}

/**
 * 把节点的模型配置临时写入 `store.AIconfig.llm`，返回改前的配置快照（务必还原）。
 * 与应用设置页的来源解析保持一致（含自定义来源按 index 切换）。
 */
export function applyModelConfig(store: any, target: NodeModelTarget): Record<string, any> {
  const original = JSON.parse(JSON.stringify(store?.AIconfig?.llm || {}))
  const llm = store?.AIconfig?.llm
  if (!llm) return original

  const modelType = normalizeLlmType(target.modelType)
  llm.type = modelType

  switch (modelType) {
    case 'ollama':
      if (target.model && llm.ollama) llm.ollama.model = target.model
      break
    case 'lmstudio':
      if (target.model && llm.lmstudio) llm.lmstudio.model = target.model
      break
    case 'openai':
      if (llm.openai) llm.openai.model = target.model || llm.openai.model
      break
    case 'deepseek': {
      const block: any = deepSeekStyleOf(target.modelType, llm.deepseek) === 'responses' ? llm.deepseekResponses : llm.deepseek
      if (block) block.model = target.model || block.model
      break
    }
    case 'gpustack':
      if (llm.gpustack) llm.gpustack.model = target.model || llm.gpustack.model
      break
    case 'anthropic':
      if (llm.anthropic) llm.anthropic.model = target.model || llm.anthropic.model
      break
    case 'google':
      if (llm.google) llm.google.model = target.model || llm.google.model
      break
    case 'azure':
      if (llm.azure) llm.azure.deployment = target.model || llm.azure.deployment
      break
    case 'custom': {
      if (llm.custom) {
        if (typeof target.customSourceIndex === 'number') store.applyCustomSourceIndex?.(target.customSourceIndex)
        llm.custom.model = target.model || llm.custom.model || ''
        const sources = Array.isArray(llm.custom.sources) ? llm.custom.sources : []
        const source = sources[typeof llm.custom.activeIndex === 'number' ? llm.custom.activeIndex : 0]
        if (source && target.model) source.model = target.model
      }
      break
    }
    default:
      break
  }
  return original
}
