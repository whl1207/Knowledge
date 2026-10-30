/**
 * outputTokens.ts — 每次请求的输出 token 上限（max_tokens）：夹取 + 400 降级
 *
 * 为什么需要它：
 *  - `max_tokens` 是「本次最多生成多少 token」的**硬上限**。太小 → 频繁撞截断
 *    （智能体里表现为工具参数 JSON 半截、整步工具调用作废并触发续跑）；
 *    太大 → 严格的服务端直接 400（例如 gpt-4o 最多 16384、claude-3-haiku 只有 4096）。
 *  - ai-km 的「设置 → 模型 → 最大令牌数」是**全局单值**，原样透传给所有来源
 *    （OpenAI / Azure / Anthropic / Google / 本地 / 自定义）。所以既不能一味调大，
 *    也不该逼用户为每个来源手填：这里按来源/模型把用户值**夹取**到已知上限内；
 *    万一仍被服务端拒绝（400 且报文指向 max_tokens），再自动降一档重试，用户配置不动。
 *
 * 口径（宁可不夹，也不要误伤）：
 *  - 只收录**确定会拒绝超额值**的云端官模（OpenAI / Azure 的 4o/4/3.5 小上限家族、
 *    Anthropic 的 claude-3 家族）；未知模型一律不夹取；
 *  - 本地 Ollama / LM Studio / GPUStack / 自定义网关的可输出量取决于加载的上下文，
 *    写死只会误伤，因此不夹取；
 *  - DeepSeek 官方（1M 上下文、输出上限很高，DSH 默认按 256k 发）不夹取。
 */

import { normalizeLlmType } from './llmSources'

/** 「最大令牌数」的默认值（设置 → 模型；新建聊天会快照这个值） */
export const DEFAULT_MAX_TOKENS = 32_768

/**
 * 设置页允许填写的最大值（不是硬性技术上限，只是防止手滑填出天文数字）。
 * OpenAI 官方 GPT-5 / o 系列、DeepSeek 新模型都在这个量级以内。
 */
export const MAX_TOKENS_SETTING_MAX = 262_144

/** 降级重试的下限：低于这个值就没有降级的必要了（再小必然截断） */
export const MIN_MAX_TOKENS = 4_096

/** 降级重试最多尝试次数（4096 为下限，通常 1~2 次就够） */
export const MAX_TOKENS_RETRY_LIMIT = 3

/**
 * 已知的「模型输出上限」小表（只收小上限、会 400 的家族）。
 * 匹配规则：模型名**忽略大小写前缀匹配**，因此 `gpt-4o-mini` 会命中 `gpt-4o`。
 * 顺序敏感：更具体的写在前面（先 4o 再 4，先 3.5-16k 再 3.5）。
 */
const OUTPUT_LIMIT_RULES: Record<string, Array<[string, number]>> = {
  // OpenAI / Azure（Azure 的 deployment 名通常与模型同名，同一套规则适用）
  openai: [
    ['gpt-4o', 16_384],
    ['chatgpt-4o', 16_384],
    ['gpt-4.1', 32_768],
    ['gpt-4-32k', 32_768],
    ['gpt-4-turbo', 4_096],
    ['gpt-4', 8_192],
    ['gpt-3.5-turbo-16k', 16_384],
    ['gpt-3.5-turbo', 4_096],
  ],
  // Anthropic 官方模型（max_tokens 超限会直接 400）
  anthropic: [
    ['claude-3-5-haiku', 8_192],
    ['claude-3.5-haiku', 8_192],
    ['claude-3-haiku', 4_096],
    ['claude-3-5-sonnet', 8_192],
    ['claude-3.5-sonnet', 8_192],
    ['claude-3-sonnet', 4_096],
    ['claude-3-opus', 4_096],
  ],
}

/**
 * 某个来源/模型的已知输出上限；未知返回 `undefined`（= 不夹取）。
 * `provider` 用应用统一来源标识（`openai` / `azure` / `anthropic` …）。
 */
export function knownMaxOutputTokens(provider: string, model?: string): number | undefined {
  const type = normalizeLlmType(provider)
  const rules = OUTPUT_LIMIT_RULES[type]
  const name = String(model || '').trim().toLowerCase()
  if (!rules || !name) return undefined
  for (const [prefix, limit] of rules) {
    if (name.startsWith(prefix)) return limit
  }
  return undefined
}

/** 归一用户填写的上限：非有限数 / ≤0 → 默认值；超过设置上限 → 设置上限 */
export function normalizeRequestedMaxTokens(value: unknown, fallback = DEFAULT_MAX_TOKENS): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(n, MAX_TOKENS_SETTING_MAX)
}

/** 把用户值夹到该模型的已知上限内（未知模型原样返回） */
export function clampMaxTokens(requested: unknown, provider: string, model?: string): number {
  const value = normalizeRequestedMaxTokens(requested)
  const limit = knownMaxOutputTokens(provider, model)
  return limit && value > limit ? limit : value
}

// ---------------------------------------------------------------------------
// 请求体里的输出上限字段（各协议字段名不同）
// ---------------------------------------------------------------------------

export interface MaxTokensField {
  get(): number | undefined
  set(value: number): void
}

/**
 * 找出请求体里的「输出上限」字段：OpenAI chat（max_tokens / max_completion_tokens）、
 * OpenAI Responses（max_output_tokens）、Anthropic（max_tokens / max_tokens_to_sample）、
 * Google（generationConfig.maxOutputTokens）、Ollama（options.num_predict）。
 * 找不到返回 null（= 这个请求不受本模块管）。
 */
export function bodyMaxTokensField(body: any): MaxTokensField | null {
  if (!body || typeof body !== 'object') return null
  const pick = (holder: any, key: string): MaxTokensField | null => {
    if (!holder || typeof holder !== 'object' || !(key in holder)) return null
    return {
      get: () => {
        const v = holder[key]
        return typeof v === 'number' && Number.isFinite(v) ? v : undefined
      },
      set: (value: number) => { holder[key] = value },
    }
  }
  const direct = pick(body, 'max_tokens')
    || pick(body, 'max_tokens_to_sample')
    || pick(body, 'max_completion_tokens')
    || pick(body, 'max_output_tokens')
    || pick(body?.generationConfig, 'maxOutputTokens')
    || pick(body?.options, 'num_predict')
  return direct
}

/**
 * 请求前夹取：把 body 里的输出上限夹到该模型已知上限内。
 * 返回 `{ from, to }`（发生过夹取）或 null（无需 / 无法夹取）。
 */
export function clampBodyMaxTokens(body: any, provider: string, model?: string): { from: number; to: number } | null {
  const field = bodyMaxTokensField(body)
  if (!field) return null
  const current = field.get()
  if (typeof current !== 'number' || !(current > 0)) return null
  const limit = knownMaxOutputTokens(provider, model)
  if (!limit || current <= limit) return null
  field.set(limit)
  return { from: current, to: limit }
}

/**
 * 服务端因 max_tokens 过大拒绝后，把 body 里的上限降一档（减半，下限 MIN_MAX_TOKENS）。
 * 返回新值；已到下限 / 没有该字段 → null（不再重试）。
 */
export function downgradeBodyMaxTokens(body: any): number | null {
  const field = bodyMaxTokensField(body)
  if (!field) return null
  const current = field.get()
  if (typeof current !== 'number' || !(current > MIN_MAX_TOKENS)) return null
  const next = Math.max(MIN_MAX_TOKENS, Math.floor(current / 2))
  if (next >= current) return null
  field.set(next)
  return next
}

/**
 * 判断错误报文是否是「max_tokens 太大」这一类（只在 400 响应上调用）。
 * 覆盖 OpenAI（"max_tokens is too large: 32768. This model supports at most 16384"）、
 * Anthropic（"max_tokens: 32768 > 4096, which is the maximum allowed number of output tokens"）、
 * Azure 同款措辞，以及各家兼容网关的 "invalid max_output_tokens" 之类。
 */
export function isMaxTokensTooLargeError(text: string): boolean {
  const s = String(text || '')
  if (!s) return false
  const mentionsField = /max[_ -]?(tokens|completion[_ ]?tokens|output[_ ]?tokens)|max_tokens_to_sample|maxoutputtokens|num_predict|最大令牌/i.test(s)
  if (!mentionsField) return false
  return /too (large|long|high|big)|exceed|greater than|more than|at most|not support|out of range|invalid|must be (less|smaller|<=?)|上限|超出|过大/i.test(s)
}

/**
 * 从端点 / 请求头推断来源标识（只用于查上面的小表）：
 * Anthropic 看 `anthropic-version` 头；OpenAI / Azure 看域名；其余返回空串（= 不夹取）。
 */
export function inferLimitProvider(endpoint: string, headers?: any): string {
  const url = String(endpoint || '')
  const headerText = (() => {
    try { return JSON.stringify(headers || {}) } catch { return '' }
  })()
  if (/api\.anthropic\.com|anthropic-version/i.test(`${url} ${headerText}`)) return 'anthropic'
  if (/api\.openai\.com|openai\.azure\.com|cognitiveservices\.azure\.com|azurefd\.net|azure\.cn/i.test(url)) return 'openai'
  return ''
}

/**
 * 从请求体 / 端点推断模型名（用于查上限表）：
 * 优先 `body.model`；Azure 取 URL 里的 `/deployments/<name>`；Google 取 `/models/<name>`。都没有则空串。
 */
export function inferLimitModel(endpoint: string, body: any): string {
  const direct = typeof body?.model === 'string' ? body.model.trim() : ''
  if (direct) return direct
  const url = String(endpoint || '')
  const deployment = url.match(/\/deployments\/([^/?#]+)/i)
  if (deployment) return decodeURIComponent(deployment[1])
  const model = url.match(/\/models\/([^:?#/]+)/i)
  if (model) return decodeURIComponent(model[1])
  return ''
}
