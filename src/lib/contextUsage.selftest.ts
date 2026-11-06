/**
 * contextUsage.selftest.ts — 窗口上限解析自测（纯计算，不联网）
 *
 * 重点盯住「DeepSeek 明明是 1M 上下文，九万就压缩」这一类回归：
 *  - DeepSeek 官方模型必须解析为 1M（模型名表 / 来源默认值都不能再落回 128K）；
 *  - 压缩阈值必须由 1M 算出（约 80 万），而不是 128K 算出的约 9.4 万；
 *  - 手填覆盖仍然优先（用户能强制指定更小的窗口）；
 *  - 其它来源（OpenAI / Gemini）不受影响。
 *
 * 用法：`npm run test:selftest contextUsage`
 */

import {
  contextWindowKey,
  defaultContextWindow,
  manualContextWindow,
  modelContextWindow,
  realContextWindowCacheKey,
  resolveContextLimit,
} from './contextUsage'
import { compactThresholdTokens } from '@/shared/contextBudget'

export interface ContextUsageCase {
  name: string
  ok: boolean
  detail?: string
}

/** 造一个只带窗口相关字段的最小 llm 配置 */
function llmConfig(extra: Record<string, any> = {}): any {
  return { contextWindowByProvider: {}, contextWindowProbed: {}, ...extra }
}

export function runContextUsageSelfTest(): ContextUsageCase[] {
  const cases: ContextUsageCase[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  // 1. DeepSeek 标称窗口：新模型与旧 API 名都按 1M（官方同一代大窗口模型）
  for (const model of ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner']) {
    add(`模型标称窗口：${model} = 1M`, modelContextWindow(model) === 1_000_000, String(modelContextWindow(model)))
  }

  // 2. 来源默认值也是 1M：模型名完全认不出时不能落回 128K
  add('来源默认值：deepseek 未知模型 = 1M',
    defaultContextWindow('deepseek', 'deepseek-some-new-model') === 1_000_000,
    String(defaultContextWindow('deepseek', 'deepseek-some-new-model')))

  // 3. 没有探测结果时：解析成 1M（source = model-name）
  {
    const r = resolveContextLimit({ provider: 'deepseek', model: 'deepseek-flash' })
    add('解析：deepseek-flash 无探测 → 1M / model-name', r.limit === 1_000_000 && r.source === 'model-name', `${r.limit} ${r.source}`)
  }

  // 4. 回归点：压缩阈值必须由 1M 算（约 80 万），不能是 128K 的约 9.4 万
  {
    const limit = resolveContextLimit({ provider: 'deepseek', model: 'deepseek-flash' }).limit
    const at = compactThresholdTokens({ limit })
    add('压缩阈值：1M 窗口 ≈ 80 万（不是九万）', at === 800_000, String(at))
  }

  // 5. 手填覆盖优先：用户明确填了较小窗口时按手填值（并提供该来源的覆盖读取）
  {
    const llm = llmConfig({ contextWindowByProvider: { deepseek: 131_072 } })
    const manual = manualContextWindow(llm, 'deepseek')
    const r = resolveContextLimit({ provider: 'deepseek', model: 'deepseek-flash', manual })
    add('手填覆盖优先：deepseek 131072 → manual', manual === 131_072 && r.limit === 131_072 && r.source === 'manual', `${r.limit} ${r.source}`)
  }

  // 6. 已加载实例的真实值优先于标称值（本地来源手动调小窗口的场景）
  {
    const r = resolveContextLimit({ provider: 'ollama', model: 'qwen3:8b', realLoaded: 65_536 })
    add('已加载真实值优先：ollama 65536 → real', r.limit === 65_536 && r.source === 'real', `${r.limit} ${r.source}`)
  }

  // 7. 其它来源不受这次改动影响
  add('OpenAI：gpt-4o 仍是 128K', defaultContextWindow('openai', 'gpt-4o') === 128_000, String(defaultContextWindow('openai', 'gpt-4o')))
  add('Google：gemini-2.5-pro 仍是 1M 量级', defaultContextWindow('google', 'gemini-2.5-pro') === 1_048_576, String(defaultContextWindow('google', 'gemini-2.5-pro')))
  add('GLM：glm-4.6 标称 200K', defaultContextWindow('glm', 'glm-4.6') === 200_000, String(defaultContextWindow('glm', 'glm-4.6')))
  add('Kimi：kimi-k2 标称 256K', defaultContextWindow('kimi', 'kimi-k2-0905-preview') === 262_144, String(defaultContextWindow('kimi', 'kimi-k2-0905-preview')))

  // 8. DeepSeek 历史别名归一：缓存键 / 覆盖键不能分裂成两份
  add('来源键归一：deepseek-responses → deepseek', contextWindowKey('deepseek-responses') === 'deepseek', contextWindowKey('deepseek-responses'))
  add('缓存键含模型：不同模型分桶', realContextWindowCacheKey('deepseek', 'deepseek-flash') !== realContextWindowCacheKey('deepseek', 'deepseek-v4-pro'))

  // 9. 历史别名 + 认不出的模型名：来源默认值也要按 DeepSeek 的 1M，不能落到未知 128K
  {
    const r = resolveContextLimit({ provider: 'deepseek-responses', model: 'proxy-model-x' })
    add('历史别名：deepseek-responses 未知模型 → 来源默认 1M', r.limit === 1_000_000 && r.source === 'provider-default', `${r.limit} ${r.source}`)
  }

  return cases
}
