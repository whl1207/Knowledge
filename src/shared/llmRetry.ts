/**
 * llmRetry.ts — LLM 请求失败的分类、Retry-After 解析与退避计算（纯函数）
 *
 * 背景：agent 循环原先只把 5xx / 网络错误当瞬态，最常见的 429（限流）会直接失败；
 * 重试也只有固定指数退避、没有 jitter、没有把 Retry-After 透出。
 *
 * 本模块不依赖 electron / DOM，主进程与渲染层共用。分类结果只描述「该不该重试」，
 * 不负责实际等待或发请求。
 */

export type LlmFailureCode =
  | 'rate_limit'
  | 'server'
  | 'timeout'
  | 'transport'
  | 'empty_response'
  | 'context_overflow'
  | 'auth'
  | 'quota'
  | 'invalid_request'
  | 'not_found'
  | 'aborted'
  | 'unknown'

export interface LlmFailure {
  code: LlmFailureCode
  /** 是否值得在「本 step 尚未产生任何内容」时重试 */
  retryable: boolean
  /** provider 给出的 Retry-After（毫秒，已按当前时间折算） */
  retryAfterMs?: number
  /** 从错误对象/消息中解析出的 HTTP 状态码 */
  status?: number
}

export interface ClassifyLlmFailureInput {
  message?: string
  /** 调用方优先传 Error 上的 status；没有则从 message 解析 */
  status?: number
  /** Retry-After 原值：秒数字符串 / HTTP date / 毫秒数字 */
  retryAfter?: string | number
  name?: string
  /** 可注入当前时间，便于测试 */
  now?: number
}

/** 从 "状态码: 429" / "status: 429" / "HTTP error! status: 429" 中取状态码。 */
export function parseHttpStatus(message: string): number | undefined {
  const text = String(message || '')
  const patterns = [
    /状态码\s*[:：]\s*(\d{3})/,
    /status(?:\s*code)?\s*[:：=]?\s*(\d{3})/i,
    /HTTP(?:\s*error)?[^\d]{0,16}(\d{3})/i,
  ]
  for (const re of patterns) {
    const m = re.exec(text)
    if (m) {
      const n = Number(m[1])
      if (n >= 100 && n <= 599) return n
    }
  }
  return undefined
}

/**
 * 解析 Retry-After。
 * 支持 `120`（秒）、`120000`（毫秒，部分网关会这么给）、以及 HTTP date。
 * 无法解析 / 已过期返回 undefined，由调用方回退到本地退避。
 */
export function parseRetryAfter(value: string | number | undefined | null, now = Date.now()): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return undefined
    // 大于 24h 的秒数更可能是毫秒
    return Math.min(24 * 60 * 60 * 1000, value > 86_400 ? value : value * 1000)
  }
  const text = String(value).trim()
  if (!text) return undefined
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const n = Number(text)
    return n > 86_400 ? Math.min(24 * 60 * 60 * 1000, n) : Math.min(24 * 60 * 60 * 1000, n * 1000)
  }
  const at = Date.parse(text)
  if (!Number.isFinite(at)) return undefined
  const delta = at - now
  return delta > 0 ? Math.min(24 * 60 * 60 * 1000, delta) : undefined
}

/** 从消息文本里找 `Retry-After: 30`（部分网关把响应头拼进错误正文）。 */
function parseRetryAfterFromMessage(message: string): string | undefined {
  const m = /retry-after\s*[:=]\s*([^\s,;]+)/i.exec(String(message || ''))
  return m?.[1]
}

/**
 * 把一次 LLM 失败归类。
 * 只对「重试有意义且不会造成重复计费/重复副作用」的错误返回 retryable=true；
 * 401/403/404/400（非上下文）一律不重试，直接给用户可操作错误。
 */
export function classifyLlmFailure(input: ClassifyLlmFailureInput): LlmFailure {
  const message = String(input?.message || '')
  const status = Number(input?.status) || parseHttpStatus(message)
  const name = String(input?.name || '')
  const now = Number(input?.now) || Date.now()

  if (name === 'AbortError' || /aborted|aborterror|the operation was aborted/i.test(message)) {
    return { code: 'aborted', retryable: false, status }
  }
  if (/context[\s_-]*(length|window)|上下文(长度)?(超|过)限|超出(最大)?上下文|prompt is too long|too many tokens/i.test(message)) {
    return { code: 'context_overflow', retryable: false, status }
  }
  if (status === 429 || /rate[\s_-]*limit|too many requests|请求过于频繁|限流/i.test(message)) {
    const raw = input?.retryAfter ?? parseRetryAfterFromMessage(message)
    return { code: 'rate_limit', retryable: true, retryAfterMs: parseRetryAfter(raw, now), status }
  }
  if (status && status >= 500 && status <= 599) {
    return { code: 'server', retryable: true, status }
  }
  if (status === 408 || /ETIMEDOUT|timeout|timed out|请求超时/i.test(message)) {
    return { code: 'timeout', retryable: true, status }
  }
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network error|Load failed|connection (reset|refused)/i.test(message)) {
    return { code: 'transport', retryable: true, status }
  }
  if (status === 401 || status === 403 || /unauthorized|forbidden|invalid api key|认证|鉴权/i.test(message)) {
    return { code: 'auth', retryable: false, status }
  }
  if (status === 402 || /quota|insufficient[_ ]?quota|余额不足|额度/i.test(message)) {
    return { code: 'quota', retryable: false, status }
  }
  if (status === 404 || /model.*not found|no such model|模型不存在/i.test(message)) {
    return { code: 'not_found', retryable: false, status }
  }
  if (status === 400 || /invalid[_ ]request|bad request|参数(错误|不合法)/i.test(message)) {
    return { code: 'invalid_request', retryable: false, status }
  }
  return { code: 'unknown', retryable: false, status }
}

export interface BackoffOptions {
  /** 第一次重试的等待（毫秒） */
  baseMs?: number
  /** 单次等待上限（毫秒） */
  maxMs?: number
  /** 抖动比例（0.2 = ±20%） */
  jitterRatio?: number
}

/**
 * 指数退避 + jitter。`attempt` 从 0 开始。
 * 返回值始终 >= 0；调用方仍应受 `Retry-After` 与总预算约束。
 */
export function retryBackoffMs(
  attempt: number,
  opts: BackoffOptions = {},
  random: () => number = Math.random,
): number {
  const base = Math.max(1, Number(opts.baseMs) || 500)
  const max = Math.max(base, Number(opts.maxMs) || 10_000)
  const jitter = Math.max(0, Math.min(1, opts.jitterRatio ?? 0.2))
  const raw = Math.min(max, base * Math.pow(2, Math.max(0, Math.floor(attempt))))
  const delta = raw * jitter
  const value = raw - delta + random() * delta * 2
  return Math.max(0, Math.round(Math.min(max, value)))
}

/** 把 provider 的 Retry-After 与本地退避合并：优先 provider，但不超过 maxMs。 */
export function effectiveRetryDelayMs(
  attempt: number,
  failure: LlmFailure,
  opts: BackoffOptions & { maxRetryAfterMs?: number } = {},
  random: () => number = Math.random,
): number {
  const local = retryBackoffMs(attempt, opts, random)
  if (failure.retryAfterMs === undefined) return local
  const cap = Math.max(1, Number(opts.maxRetryAfterMs) || 60_000)
  return Math.min(cap, Math.max(0, Math.round(failure.retryAfterMs)))
}
