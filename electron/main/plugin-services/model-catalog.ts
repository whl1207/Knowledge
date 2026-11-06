/**
 * model-catalog.ts — 把「主机已配置的模型来源」投影成 DSH 形状的 `ModelCatalog`
 *
 * 数据来源：渲染层在启动 / 改设置时下发的来源快照（`lan-guest.ts` 的 `modelSources`）
 * 与当前主机模型（`hostLlm`）。**不探测、不读密钥**——目录只回答"有哪些 provider / model"，
 * 选中的模型在 `selectModel` 里校验，真正调用仍走主机自己的配置。
 *
 * 为什么复用 LAN 访客那两份快照：它们本来就在应用启动时下发（`pushLanGuestPolicy`），
 * 且已经做过"剥离密钥"的处理，不需要为插件再开一条渲染层 → 主进程的通道。
 */

import {
  LLM_SOURCE_KEYS,
  LLM_SOURCE_LABELS,
  llmSourceLabel,
  normalizeLlmType,
} from '@/shared/llmSources'
import type {
  ModelCatalog,
  ModelCatalogModel,
  ModelProviderGroup,
  ModelSelection,
} from '@/shared/pluginServices'
import { getLanGuestHostLlm, getLanModelSources } from '../lan-guest'

/** 从一个来源配置里收集模型名（已探测列表优先，其次当前模型） */
function modelsOf(config: any): string[] {
  const out = new Set<string>()
  const available = Array.isArray(config?.available_models) ? config.available_models : []
  for (const m of available) {
    if (typeof m === 'string' && m.trim()) out.add(m.trim())
  }
  const current = typeof config?.model === 'string' ? config.model.trim() : ''
  if (current) out.add(current)
  return Array.from(out)
}

function groupOf(id: string, name: string, models: string[]): ModelProviderGroup | null {
  if (!models.length) return null
  const list: ModelCatalogModel[] = models.map((model) => ({ id: model, name: model }))
  return { id, name, models: list }
}

/**
 * 构建目录。
 *
 * 约定：
 * - 只列"有模型名"的来源（没探测到的空来源不占位，否则 `/model` 列表全是空组）；
 * - `disabled` 里的来源不列；
 * - 自定义来源按条目展开成 `custom:<索引>`，名称用条目的 `name`；
 * - `default` 取主机当前模型；主机没下发模型配置时退到第一个可路由模型（可能为空）。
 */
export function buildModelCatalog(): ModelCatalog {
  const { llm, disabled } = getLanModelSources()
  const host = getLanGuestHostLlm()
  const hidden = new Set((disabled || []).map((x) => normalizeLlmType(x)))
  const groups: ModelProviderGroup[] = []

  const source = llm || {}
  // 来源开关：`types` 是渲染层里勾选的来源清单；为空 = 不限制（旧配置）
  const enabled =
    Array.isArray(source.types) && source.types.length
      ? new Set(source.types.map((t: string) => normalizeLlmType(t)))
      : null
  for (const key of LLM_SOURCE_KEYS) {
    if (key === 'custom') continue
    if (enabled && !enabled.has(key)) continue
    if (hidden.has(key)) continue
    const config = source[key]
    if (!config || typeof config !== 'object') continue
    const group = groupOf(key, LLM_SOURCE_LABELS[key] || llmSourceLabel(key), modelsOf(config))
    if (group) groups.push(group)
  }

  const customSources = Array.isArray(source.custom?.sources) ? source.custom.sources : []
  customSources.forEach((cfg: any, index: number) => {
    const id = `custom:${index}`
    if (enabled && !enabled.has('custom')) return
    if (hidden.has(id)) return
    const name = String(cfg?.name || '').trim() || `${LLM_SOURCE_LABELS.custom} ${index + 1}`
    const group = groupOf(id, name, modelsOf(cfg))
    if (group) groups.push(group)
  })

  const defaultSelection: ModelSelection = (() => {
    if (host) {
      const model = String(host.config?.model || host.llmConfig?.model || '').trim()
      return { provider: normalizeLlmType(host.provider), model }
    }
    const first = groups[0]
    return { provider: first?.id || '', model: first?.models[0]?.id || '' }
  })()

  return {
    default: defaultSelection,
    routableProviders: groups.map((g) => g.id),
    groups,
    failures: [],
  }
}

/** 目录里是否存在这个 provider + model（`selectModel` 的校验点） */
export function catalogHasModel(catalog: ModelCatalog, provider: string, model: string): boolean {
  const group = catalog.groups.find((g) => g.id === provider)
  if (!group) return false
  return group.models.some((m) => m.id === model)
}
