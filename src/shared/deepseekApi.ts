/**
 * deepseekApi.ts — DeepSeek 官方 Search / Fetch 接口（请求组装 / 响应解析 / 错误翻译 / 网络调用）
 *
 * 文档：https://api-docs.deepseek.com/zh-cn/guides/search
 *
 * - Search：`POST <host>/v1/tools/search` → `{ results: [...] }`
 *   一次请求直接拿到结构化结果（标题 / 链接 / 短摘要 / 长摘要 / 可选正文），**不是模型调用**，
 *   延迟与费用都按「请求次数」计（每 1000 次成功请求 5 元）。
 * - Fetch ：`POST <host>/v1/tools/fetch` → `{ title, content }`（服务端渲染后的 Markdown 正文）。
 *
 * 两者共用 Bearer 鉴权，错误体是 OpenAI 兼容的 `{ error: { message, type, param, code } }`；
 * QPS 各 5（按账号计），408 / 429 / 5xx 可等待后重试。
 *
 * 为什么单独成文件：搜索要在**两处**跑（桌面主进程 `electron/main/tools.ts`、手机 / 网页
 * `src/lib/agent/webSearchRunner.ts`），抓取也要在两处跑（主进程、`rendererTools.ts`）。
 * 请求体 / 响应形状 / 错误翻译抄四份必然改一处忘三处，因此纯逻辑与最薄的网络封装都放这里，
 * 自测见 `deepseekApi.selftest.ts`（不联网）。
 *
 * ⚠️ 历史包袱：旧版 DeepSeek 搜索走的是 **Anthropic 兼容 Messages 端点** + 服务端
 * `web_search_20250305` 工具，apiHost 默认 `https://api.deepseek.com/anthropic/v1`。
 * Search / Fetch 是独立的原生 JSON 端点，**不能用那个 base**；`normalizeDeepSeekApiHost`
 * 会把旧配置里的 `/anthropic` 段剥掉，避免升级后请求打到不存在的路径。
 */

import type { WebSearchItem } from './webSearch'

/** DeepSeek API 默认 base（Search / Fetch 都挂在它下面） */
export const DEEPSEEK_API_DEFAULT_HOST = 'https://api.deepseek.com'

/** Search 端点路径（拼在 base 之后） */
export const DEEPSEEK_SEARCH_PATH = '/v1/tools/search'

/** Fetch 端点路径（拼在 base 之后） */
export const DEEPSEEK_FETCH_PATH = '/v1/tools/fetch'

/** 单次搜索可返回的条数上限（官方 1~50） */
export const DEEPSEEK_SEARCH_MAX_COUNT = 50

/** 本地 HTTP 超时（官方 504 是下游超时；这里比它略长，让服务端的错误先回来） */
export const DEEPSEEK_API_TIMEOUT_MS = 30_000

/**
 * 归一化接口 base：缺协议补 https、去尾斜杠、剥掉旧版的 `/anthropic(/v1)` 段，
 * 并去掉用户可能多填的 `/v1`（路径里已经带了，否则会拼出 `/v1/v1/...`）。
 */
export function normalizeDeepSeekApiHost(raw?: string): string {
  let s = String(raw || '').trim()
  if (!s) return DEEPSEEK_API_DEFAULT_HOST
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`
  s = s.replace(/\/+$/, '')
  // 旧版搜索配置指向 Anthropic 兼容端点，不能拿来拼 Search / Fetch 路径
  s = s.replace(/\/anthropic(?:\/v1)?$/i, '')
  // 用户直接粘贴完整端点（文档里的 URL）：剥掉已知路径，避免拼成 /v1/tools/search/v1/tools/search
  s = s.replace(/\/v1\/tools\/(?:search|fetch)$/i, '')
  // 用户填到 /v1：路径已含，去掉避免重复
  s = s.replace(/\/v1$/i, '')
  return s || DEEPSEEK_API_DEFAULT_HOST
}

/** 搜索取条数收敛到 1~50（配置层上限 20，这里再兜一层） */
export function clampDeepSeekSearchCount(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 10
  return Math.min(DEEPSEEK_SEARCH_MAX_COUNT, Math.max(1, Math.round(n)))
}

/** 搜索接口的请求参数 */
export interface DeepSeekSearchRequestOptions {
  query: string
  /** 返回条数（1~50；默认 10） */
  maxResults?: number
  /** 是否让服务端在 `content` 里返回网页正文（默认 false，正文体积大） */
  needContent?: boolean
  /** 触发搜索的用户原始问题（可选，帮助理解搜索意图） */
  oriQuestion?: string
  /** 用于优先返回本地化结果的 IP（可选） */
  localization?: string
  /** API base（留空用官方地址） */
  apiHost?: string
  /** API Key（必填；调用方负责从凭据 / 对话配置解析） */
  apiKey?: string
  /** 覆盖默认超时（毫秒） */
  timeoutMs?: number
}

/** 组装好的请求（调用方 / 自测共用） */
export interface DeepSeekApiRequest {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
}

/** DeepSeek 接口错误（带可诊断 code；HTTP 状态与网络错误分开） */
export class DeepSeekApiError extends Error {
  /** 诊断码：`HTTP_401` / `NETWORK` / `BAD_RESPONSE` / `EMPTY_CONTENT` … */
  readonly code: string
  /** HTTP 状态码（网络错误为 0） */
  readonly status: number
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'DeepSeekApiError'
    this.code = opts.code || 'DEEPSEEK_API_ERROR'
    this.status = Number(opts.status) || 0
  }
}

/** 从错误响应体里抠出可读原因（OpenAI 兼容错误格式；非 JSON 时截断原文） */
export function extractDeepSeekErrorDetail(bodyText: string): string {
  const raw = String(bodyText || '').trim()
  if (!raw) return ''
  try {
    const json = JSON.parse(raw)
    const message = json?.error?.message ?? json?.message ?? json?.error
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 300)
  } catch {
    /* 不是 JSON：按纯文本处理 */
  }
  return raw.slice(0, 300)
}

/** HTTP 状态 → 下一步该做什么（与官方错误表一致） */
const DEEPSEEK_HTTP_HINTS: Record<number, string> = {
  400: '请求头或请求体不合法（检查 query / count 等字段）',
  401: 'API Key 缺失或无效',
  402: '账号余额不足，请先充值',
  403: 'Fetch 请求被目标站点的安全策略拒绝',
  404: 'Fetch 未能获取可用网页内容（URL 不可用 / 被拦截 / 没有可提取的正文）',
  408: '读取请求体超时，可稍后重试',
  413: '请求体超过大小限制',
  429: '超过 QPS 限制（Search / Fetch 各 5 次/秒），请稍后重试',
  500: '服务端内部错误，可稍后重试',
  504: '下游请求超时，可稍后重试',
}

/** 把 HTTP 状态与响应体翻成一句人话（调用方直接拼进搜索 / 抓取错误里） */
export function deepseekApiErrorMessage(status: number, bodyText = ''): string {
  const code = Number(status) || 0
  const hint = DEEPSEEK_HTTP_HINTS[code] || (code >= 500 ? '服务端暂时不可用，可稍后重试' : '')
  const detail = extractDeepSeekErrorDetail(bodyText)
  const head = code ? `DeepSeek 接口 HTTP ${code}` : 'DeepSeek 接口请求失败'
  return `${head}${hint ? `（${hint}）` : ''}${detail ? `：${detail}` : ''}`
}

/** 发送一次 POST JSON 请求（内部使用：带超时、非 2xx 抛 DeepSeekApiError） */
async function postDeepSeekJson(opts: {
  url: string
  apiKey: string
  body: unknown
  timeoutMs?: number
}): Promise<any> {
  const apiKey = String(opts.apiKey || '').trim()
  if (!apiKey) throw new DeepSeekApiError('未配置 DeepSeek API Key', { code: 'NO_API_KEY' })
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || DEEPSEEK_API_TIMEOUT_MS)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  let text = ''
  try {
    res = await fetch(opts.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(opts.body),
    })
    text = await res.text()
  } catch (e: any) {
    const aborted = e?.name === 'AbortError'
    throw new DeepSeekApiError(
      aborted
        ? `DeepSeek 接口请求超时（${Math.round(timeoutMs / 1000)} 秒）`
        : `DeepSeek 接口请求失败：${e?.message || String(e)}`,
      { code: aborted ? 'TIMEOUT' : 'NETWORK' },
    )
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    throw new DeepSeekApiError(deepseekApiErrorMessage(res.status, text), {
      code: `HTTP_${res.status}`,
      status: res.status,
    })
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new DeepSeekApiError('DeepSeek 接口响应不是有效 JSON', { code: 'BAD_JSON' })
  }
}

/** 组装 Search 请求体（纯函数；可选字段只在真有值时出现） */
export function buildDeepSeekSearchBody(opts: DeepSeekSearchRequestOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: String(opts?.query ?? '').trim(),
    count: clampDeepSeekSearchCount(opts?.maxResults),
  }
  if (opts?.needContent) body.need_content = true
  const ori = String(opts?.oriQuestion || '').trim()
  if (ori) body.ori_question = ori
  const localization = String(opts?.localization || '').trim()
  if (localization) body.localization = localization
  return body
}

/** 组装 Search 请求（纯函数：URL / 头 / 体；不发网络） */
export function buildDeepSeekSearchRequest(opts: DeepSeekSearchRequestOptions): DeepSeekApiRequest {
  const apiKey = String(opts?.apiKey || '').trim()
  return {
    url: `${normalizeDeepSeekApiHost(opts?.apiHost)}${DEEPSEEK_SEARCH_PATH}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(buildDeepSeekSearchBody(opts)),
  }
}

/** DeepSeek 搜索的一条结果（比通用 `WebSearchItem` 多带官方排序 / 权威性信息） */
export interface DeepSeekSearchItem extends WebSearchItem {
  /** 排序分数 0~3（≥1.5 为优质） */
  rerankScore?: number
  /** 网页权威性 0~4（-1 未知；≥3 极权威） */
  authority?: number
  /** 站点名（缺失为 undefined） */
  siteName?: string
  /** 发布时间（RFC 3339，UTC） */
  date?: string
}

/** 去掉 HTML 标签并压缩空白（正文兜底为摘要时用） */
function stripTags(text: string): string {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 单条结果附带的正文最多保留多少字符（need_content=true 时正文可能整页，防撑爆上下文） */
export const DEEPSEEK_SEARCH_CONTENT_MAX_CHARS = 4000

/**
 * 解析 Search 响应 → 统一结果列表。
 *
 * - `results: []` 是**合法**的“没有匹配结果”，返回空数组（不是错误）；
 * - 响应缺 `results` 数组 → 抛错（端点不对 / 被网关改写，不能当成"网上没有"）；
 * - 短摘要优先 `snippet`，缺失时退 `summary` / 正文开头；长摘要放 `summary` 供模型阅读；
 * - `need_content` 拿到的正文放 `content`（按每条 4000 字符截断，避免 10 条结果撑爆上下文）。
 */
export function parseDeepSeekSearchResponse(data: unknown, maxResults = 10): DeepSeekSearchItem[] {
  const results = (data as any)?.results
  if (!Array.isArray(results)) {
    throw new DeepSeekApiError(
      'DeepSeek 搜索响应缺少 results 数组（端点可能不是 Search API）',
      { code: 'BAD_RESPONSE' },
    )
  }
  const limit = clampDeepSeekSearchCount(maxResults)
  const out: DeepSeekSearchItem[] = []
  const seen = new Set<string>()
  for (const r of results) {
    const url = String(r?.url || '').trim()
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
    seen.add(url)
    const snippet = String(r?.snippet || '').trim()
    const summary = String(r?.summary || '').trim()
    const content = String(r?.content || '').trim()
    const item: DeepSeekSearchItem = {
      title: String(r?.title || '').trim() || url,
      url,
      snippet: snippet || summary || stripTags(content).slice(0, 300),
    }
    if (summary) item.summary = summary
    if (content) item.content = content.slice(0, DEEPSEEK_SEARCH_CONTENT_MAX_CHARS)
    const score = Number(r?.rerank_score)
    if (Number.isFinite(score)) item.rerankScore = score
    const authority = Number(r?.authority)
    if (Number.isFinite(authority)) item.authority = authority
    const siteName = String(r?.site_name || '').trim()
    if (siteName) item.siteName = siteName
    const date = String(r?.date || '').trim()
    if (date) item.date = date
    out.push(item)
    if (out.length >= limit) break
  }
  return out
}

/** 组装 Fetch 请求（纯函数） */
export function buildDeepSeekFetchRequest(opts: {
  url: string
  apiHost?: string
  apiKey?: string
}): DeepSeekApiRequest {
  const apiKey = String(opts?.apiKey || '').trim()
  return {
    url: `${normalizeDeepSeekApiHost(opts?.apiHost)}${DEEPSEEK_FETCH_PATH}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ url: String(opts?.url ?? '').trim() }),
  }
}

/** 解析 Fetch 响应 → `{ title, content }`（正文为空视为失败，交给下一通道） */
export function parseDeepSeekFetchResponse(data: unknown): { title: string; content: string } {
  const content = String((data as any)?.content || '').trim()
  if (!content) {
    throw new DeepSeekApiError('DeepSeek Fetch 未返回可用的网页正文', { code: 'EMPTY_CONTENT' })
  }
  return { title: String((data as any)?.title || '').trim(), content }
}

/**
 * 执行一次 DeepSeek 搜索（网络封装：组装 → POST → 解析）。
 * 失败抛 `DeepSeekApiError`，消息已是可直接展示的中文。
 */
export async function runDeepSeekSearchApi(opts: DeepSeekSearchRequestOptions): Promise<DeepSeekSearchItem[]> {
  const query = String(opts?.query ?? '').trim()
  if (!query) throw new DeepSeekApiError('搜索关键词不能为空', { code: 'BAD_REQUEST' })
  const data = await postDeepSeekJson({
    url: `${normalizeDeepSeekApiHost(opts?.apiHost)}${DEEPSEEK_SEARCH_PATH}`,
    apiKey: String(opts?.apiKey || ''),
    timeoutMs: opts?.timeoutMs,
    body: buildDeepSeekSearchBody(opts),
  })
  return parseDeepSeekSearchResponse(data, opts?.maxResults ?? 10)
}

/**
 * 执行一次 DeepSeek 网页抓取（网络封装：组装 → POST → 解析）。
 * 失败抛 `DeepSeekApiError`（404 / 403 等已在消息里说明原因）。
 */
export async function runDeepSeekFetchApi(opts: {
  url: string
  apiKey: string
  apiHost?: string
  timeoutMs?: number
}): Promise<{ title: string; content: string }> {
  const pageUrl = String(opts?.url ?? '').trim()
  if (!/^https?:\/\//i.test(pageUrl)) {
    throw new DeepSeekApiError('抓取地址必须是 http/https URL', { code: 'BAD_REQUEST' })
  }
  const data = await postDeepSeekJson({
    url: `${normalizeDeepSeekApiHost(opts?.apiHost)}${DEEPSEEK_FETCH_PATH}`,
    apiKey: String(opts?.apiKey || ''),
    timeoutMs: opts?.timeoutMs,
    body: { url: pageUrl },
  })
  return parseDeepSeekFetchResponse(data)
}
