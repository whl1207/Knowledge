/**
 * deepseekSearch.ts — DeepSeek 官方搜索的请求组装与响应解析（**纯函数，不发起网络请求**）
 *
 * 来源：DeepSeek 的 **Anthropic 兼容 Messages 端点** + 服务端原生工具 `web_search_20250305`。
 * 与 `dsh-web-search-deepseek`（DSH 的实现）对齐，两处关键取舍照抄：
 *
 *  1. **摘要必须从 citations 里取，不在结果项里。**
 *     原生 `web_search_result` 项只有 `url` / `title` / `page_age`，**没有内联摘要**；
 *     真正的片段在 `text` 块的 `citations[].cited_text` 里，按 URL 关联（首次出现胜出）。
 *     只读结果项会得到一个"标题有、摘要全空"的列表——这是最容易踩的坑。
 *
 *  2. **拿不到 `web_search_tool_result` 块就直接报错，绝不从散文里猜搜索结果。**
 *     服务端可能返回 200 但没真正触发搜索；此时猜出来的"结果"无法可靠引用。
 *
 * 为什么单独成文件：请求形状与两层嵌套解析（结果块 → 结果项 → citations join）都是
 * 易错且**无需网络**就能验证的部分，抽成纯函数即可被自测覆盖
 * （见 `deepseekSearch.selftest.ts`）。网络调用留在 `electron/main/tools.ts`。
 */

/** Anthropic 原生联网搜索工具名（服务端工具，模型不直接调用） */
export const DEEPSEEK_SEARCH_TOOL_TYPE = 'web_search_20250305'

/** DeepSeek 的 Anthropic 兼容 Messages 端点（**与对话端点相互独立**） */
export const DEEPSEEK_SEARCH_DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1'

/** 默认 Anthropic 格式模型名 */
export const DEEPSEEK_SEARCH_DEFAULT_MODEL = 'deepseek-v4-flash'

/** 默认 `anthropic-version` 头 */
export const DEEPSEEK_SEARCH_DEFAULT_API_VERSION = '2023-06-01'

/** Messages 请求的生成 token 上限（这是"总结正文"的预算；工具结果块不占这个额度） */
export const DEEPSEEK_SEARCH_DEFAULT_MAX_TOKENS = 8192

/** 单次请求最多触发几次服务端搜索 */
export const DEEPSEEK_SEARCH_DEFAULT_MAX_USES = 5

/** 搜索结果项（与 `@/shared/webSearch` 的 `WebSearchItem` 同形） */
export interface DeepSeekSearchItem {
  title: string
  url: string
  snippet: string
}

/** 一次搜索的完整解析结果：**既有一轮总结，也有来源清单** */
export interface DeepSeekSearchParsed {
  /** 结果项（去重、按结果块内出现顺序） */
  items: DeepSeekSearchItem[]
  /**
   * 服务端那一轮生成的**总结正文**（所有 `text` 块拼接）。
   *
   * 为什么值得带出来：DeepSeek 的搜索是"服务端跑工具 + 模型作答"的一次完整模型调用，
   * `text` 块就是它基于搜索结果写下的总结。只取链接等于白付了这次调用的钱。
   * 没有 `text` 块时为空串（例如模型只调工具没作答）。
   */
  answer: string
}

/** 组装请求 URL：base 已含 `/v1`，这里只补 `/messages` */
export function buildDeepSeekSearchUrl(baseUrl?: string): string {
  const base = String(baseUrl || '').trim() || DEEPSEEK_SEARCH_DEFAULT_BASE_URL
  return `${base.replace(/\/+$/, '')}/messages`
}

export interface DeepSeekSearchRequestOptions {
  query: string
  model?: string
  maxTokens?: number
  maxUses?: number
}

/**
 * 组装 Messages 请求体。
 *
 * 注意：**必须带 `tools` 声明**——搜索能力完全由这个服务端工具提供，
 * 少了它请求照样 200，但不会产生任何搜索结果块（表现为"搜索没结果"而不是报错）。
 */
export function buildDeepSeekSearchRequest(opts: DeepSeekSearchRequestOptions): Record<string, unknown> {
  const query = String(opts?.query || '')
  return {
    model: String(opts?.model || '').trim() || DEEPSEEK_SEARCH_DEFAULT_MODEL,
    max_tokens: Math.max(1, Math.floor(Number(opts?.maxTokens) || DEEPSEEK_SEARCH_DEFAULT_MAX_TOKENS)),
    messages: [{ role: 'user', content: `Perform a web search for the query: ${query}` }],
    tools: [{
      type: DEEPSEEK_SEARCH_TOOL_TYPE,
      name: 'web_search',
      max_uses: Math.max(1, Math.floor(Number(opts?.maxUses) || DEEPSEEK_SEARCH_DEFAULT_MAX_USES)),
    }],
  }
}

/** 搜索源返回的错误（带可诊断的 code，便于上层区分"没触发搜索"与"网络失败"） */
export class DeepSeekSearchError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'DeepSeekSearchError'
    this.code = code
  }
}

/**
 * 从 `text` 块的 `citations[]` 建立 `url → cited_text` 映射（**摘要的唯一来源**）。
 * 同 URL 多次出现时**首次胜出**（与 DSH 一致：先引用到的那个片段最贴近原意）。
 */
export function collectCitationSnippets(blocks: unknown): Map<string, string> {
  const map = new Map<string, string>()
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const b = block as any
    if (b?.type !== 'text') continue
    for (const cite of Array.isArray(b?.citations) ? b.citations : []) {
      const url = String(cite?.url ?? '')
      const text = String(cite?.cited_text ?? '')
      if (url && text && !map.has(url)) map.set(url, text)
    }
  }
  return map
}

/**
 * 从响应的 `text` 块拼出总结正文（DeepSeek 那一轮基于搜索结果的作答）。
 * 只取 `text` 类型且非空的块，按出现顺序拼接；没有则返回空串。
 */
export function collectAnswerText(blocks: unknown): string {
  const parts: string[] = []
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const b = block as any
    if (b?.type !== 'text') continue
    const text = String(b?.text ?? '').trim()
    if (text) parts.push(text)
  }
  return parts.join('\n\n').trim()
}

/**
 * 解析 Anthropic 兼容 Messages 响应 → 总结 + 归一化结果列表。
 *
 * @param data 响应 JSON
 * @param maxResults 结果条数上限（截断在服务端已做过一轮，这里仍按本地上限收敛）
 * @returns `{ items, answer }`（`answer` 是服务端那轮的总结正文，可能为空串）
 * @throws {DeepSeekSearchError} 响应里一个 `web_search_tool_result` 块都没有时
 *   （code `WEB_PROVIDER_ERROR`）——服务端没真正触发搜索，这种情况必须显式失败
 */
export function parseDeepSeekSearchResponse(data: unknown, maxResults = 8): DeepSeekSearchParsed {
  const blocks = (data as any)?.content
  if (!Array.isArray(blocks)) {
    throw new DeepSeekSearchError('DeepSeek 搜索响应缺少 content 数组（响应形状不是 Anthropic Messages）', 'WEB_PROVIDER_ERROR')
  }

  const resultBlocks = blocks.filter((b: any) => b?.type === 'web_search_tool_result')
  if (resultBlocks.length === 0) {
    throw new DeepSeekSearchError(
      'DeepSeek 没有返回 web_search_tool_result 块：请求可能没有触发服务端联网搜索（换更明确的查询词重试，或确认该模型支持内置搜索）',
      'WEB_PROVIDER_ERROR',
    )
  }

  const snippets = collectCitationSnippets(blocks)
  const answer = collectAnswerText(blocks)
  const items: DeepSeekSearchItem[] = []
  const seen = new Set<string>()

  for (const block of resultBlocks) {
    // 工具级错误（如 max_uses 用尽）会以 error 字段出现，不是搜索结果
    const blockError = (block as any)?.error
    if (blockError && typeof blockError === 'object') {
      const msg = String((blockError as any)?.message || (blockError as any)?.type || '未知错误')
      throw new DeepSeekSearchError(`DeepSeek 联网搜索失败：${msg}`, 'WEB_PROVIDER_ERROR')
    }
    const rawItems = (block as any)?.content
    for (const raw of Array.isArray(rawItems) ? rawItems : []) {
      if (raw?.type !== 'web_search_result') continue
      const url = String(raw?.url ?? '').trim()
      if (!url || seen.has(url)) continue
      seen.add(url)
      items.push({
        title: String(raw?.title ?? '').trim(),
        url,
        // 摘要来自 citations（结果项本身没有），没有就留空而不是编一个
        snippet: String(snippets.get(String(raw?.url ?? '')) ?? '').trim(),
      })
      if (items.length >= Math.max(1, Math.floor(maxResults) || 8)) return { items, answer }
    }
  }

  if (items.length === 0) {
    throw new DeepSeekSearchError('DeepSeek 返回了搜索块但没有可用的 web_search_result 项', 'WEB_PROVIDER_ERROR')
  }
  return { items, answer }
}
