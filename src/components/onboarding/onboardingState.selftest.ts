/**
 * onboardingState.selftest.ts — 「是否配过模型」判定的回归锁
 *
 * 真实缺陷：自定义来源指向本地 / 内网服务（LM Studio、vLLM、Ollama 网关）时**没有 api_key**，
 * 旧判定只认 key，于是「明明配了自定义模型」仍然提示「还没有可用的模型来源」。
 */

import { anyModelConfigured } from './onboardingState'

export interface SelfTestResult {
  name: string
  ok: boolean
  detail?: string
}

export function runOnboardingStateSelfTest(): SelfTestResult[] {
  const results: SelfTestResult[] = []
  const check = (name: string, fn: () => string | null) => {
    try {
      const problem = fn()
      results.push({ name, ok: !problem, ...(problem ? { detail: problem } : {}) })
    } catch (e) {
      results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) })
    }
  }

  check('空配置 → 未配置', () => {
    if (anyModelConfigured({})) return '空配置被判成已配置'
    return null
  })

  check('自定义来源只有模型名（无 api_key）→ 已配置', () => {
    const llm = { custom: { sources: [{ api_url: 'http://127.0.0.1:1234/v1', model: 'qwen2.5-14b' }] } }
    if (!anyModelConfigured(llm)) return '自定义本地模型没被算作可用'
    return null
  })

  check('自定义来源有 api_key → 已配置', () => {
    const llm = { custom: { sources: [{ api_url: 'https://x', model: 'm', api_key: 'k' }] } }
    if (!anyModelConfigured(llm)) return '带 key 的自定义来源没被算作可用'
    return null
  })

  check('本地 ollama 有模型名 → 已配置', () => {
    if (!anyModelConfigured({ ollama: { model: 'gemma4:latest' } })) return 'ollama 模型没被算作可用'
    return null
  })

  check('云端来源有 key → 已配置（即使没有模型名）', () => {
    if (!anyModelConfigured({ deepseek: { api_key: 'k' } })) return '云端 key 没被算作可用'
    return null
  })

  return results
}
