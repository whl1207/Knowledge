/**
 * llmRetry.selftest.ts — LLM 失败分类 / Retry-After / 退避
 *
 * 重点保护 429：旧实现只认 5xx，限流会被当成永久失败。
 */

import {
  classifyLlmFailure,
  parseHttpStatus,
  parseRetryAfter,
  retryBackoffMs,
  effectiveRetryDelayMs,
} from './llmRetry'

export interface LlmRetryCase { name: string; ok: boolean; detail?: string }

export function runLlmRetrySelfTest(): LlmRetryCase[] {
  const cases: LlmRetryCase[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  add('状态码：中文「状态码: 429」', parseHttpStatus('HTTP错误! 状态码: 429') === 429)
  add('状态码：英文「status: 503」', parseHttpStatus('HTTP error! status: 503') === 503)
  add('状态码：无关文本返回 undefined', parseHttpStatus('模型输出为空') === undefined)

  const rate = classifyLlmFailure({ message: 'HTTP错误! 状态码: 429', retryAfter: '2' })
  add('429 → rate_limit 且可重试', rate.code === 'rate_limit' && rate.retryable)
  add('429 解析 Retry-After=2s', rate.retryAfterMs === 2000, String(rate.retryAfterMs))
  add('429 正文里带 Retry-After 也能解析',
    classifyLlmFailure({ message: 'rate limit, Retry-After: 3' }).retryAfterMs === 3000)

  add('500 → server 可重试', classifyLlmFailure({ message: 'status: 500' }).retryable)
  add('401 → auth 不可重试', !classifyLlmFailure({ message: 'status: 401' }).retryable)
  add('403 → auth 不可重试', !classifyLlmFailure({ message: 'status: 403' }).retryable)
  add('400 invalid_request 不可重试', !classifyLlmFailure({ message: 'status: 400 invalid_request_error' }).retryable)
  add('上下文超限 → context_overflow 不可重试',
    classifyLlmFailure({ message: 'context_length_exceeded' }).code === 'context_overflow')
  add('网络错误 → transport 可重试', classifyLlmFailure({ message: 'fetch failed' }).retryable)
  add('超时 → timeout 可重试', classifyLlmFailure({ message: 'request timed out' }).retryable)
  add('AbortError → aborted 不重试', classifyLlmFailure({ message: 'The operation was aborted', name: 'AbortError' }).code === 'aborted')

  const d1 = parseRetryAfter('2', 1_000_000)
  add('Retry-After 秒 → 毫秒', d1 === 2000)
  add('Retry-After HTTP date → 相对毫秒', parseRetryAfter('Thu, 01 Jan 1970 00:16:50 GMT', 1_000_000) === 10_000)
  add('Retry-After 非法 → undefined', parseRetryAfter('later') === undefined)

  const b0 = retryBackoffMs(0, { baseMs: 500, jitterRatio: 0 }, () => 0.5)
  const b1 = retryBackoffMs(1, { baseMs: 500, jitterRatio: 0 }, () => 0.5)
  add('指数退避：第 0 次 500ms', b0 === 500, String(b0))
  add('指数退避：第 1 次 1000ms', b1 === 1000, String(b1))
  add('退避不超过上限', retryBackoffMs(20, { baseMs: 500, maxMs: 10_000 }, () => 0.5) === 10_000)
  add('jitter 不越界', (() => {
    for (let i = 0; i < 20; i++) {
      const v = retryBackoffMs(3, { baseMs: 500, maxMs: 10_000, jitterRatio: 0.2 })
      if (v < 0 || v > 10_000) return false
    }
    return true
  })())
  add('provider Retry-After 优先于本地退避',
    effectiveRetryDelayMs(5, { code: 'rate_limit', retryable: true, retryAfterMs: 7000 }, { baseMs: 500 }) === 7000)

  return cases
}
