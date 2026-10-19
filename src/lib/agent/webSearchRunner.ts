/**
 * webSearchRunner.ts — 渲染层（无宿主）的联网搜索执行者
 *
 * 桌面版的搜索在主进程（`electron/main/tools.ts` 的 runWebSearch）：它除了 HTTP，
 * 还能开**隐藏浏览器窗口**渲染结果页（可过 Bing / 百度 的 JS 挑战与反爬）。
 * 手机 / 网页没有这个通道，因此本模块只实现 **HTTP 通道**：
 *
 * | 搜索源 | 渲染层可用性 |
 * | --- | --- |
 * | SearXNG / 自定义 JSON 源 | 可用（自建服务，同源或已开跨域时最稳） |
 * | Tavily / Brave / 博查 / 智谱 / Firecrawl / DeepSeek | 可用（HTTP API，需服务端允许跨域；被拦时给出提示） |
 * | Bing / 百度 / DuckDuckGo | 结果页不允许跨域读取，渲染层会失败并提示改用 API 源或连桌面主机 |
 *
 * 语义与主进程一致：`fallback`（按顺序逐个回退）/ `merge`（并行聚合去重）、结果条数上限、
 * 返回 `WebSearchRunResult` 形状（`provider` / `providers` / `via` / `results` / `attempts`）。
 */

import {
  findWebSearchCustomSource,
  normalizeWebSearchConfig,
  type WebSearchConfig,
  type WebSearchItem,
  type WebSearchRunResult,
} from '@/shared/webSearch'
import {
  buildFirecrawlSearchRequest,
  firecrawlErrorMessage,
  parseFirecrawlSearchResponse,
} from '@/shared/webSearchFirecrawl'
import { runDeepSeekSearchApi } from '@/shared/deepseekApi'

/** ProviderId 是联合类型，这里按字符串处理以避免与内置清单耦合 */
type ProviderId = string

/** 剥掉标签并压缩空白（摘要字段清洗） */
function stripTags(text: string): string {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const FETCH_TIMEOUT_MS = 20_000

/** 归一化自定义源地址（去尾斜杠；缺协议时补 http://，便于内网 IP:端口 直接填写） */
function normalizeCustomHost(raw: string): string {
  let s = String(raw || '').trim().replace(/\/+$/, '')
  if (!s) return ''
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`
  return s
}

/** 点号路径取值（`data.list` / `hits.hits`）；路径为空时返回原对象 */
function pickJsonPath(root: any, pathStr: string): any {
  const keys = String(pathStr || '').split('.').map((k) => k.trim()).filter(Boolean)
  let cur = root
  for (const k of keys) {
    if (cur == null) return undefined
    cur = cur[k]
  }
  return cur
}

const AUTO_ITEMS_PATHS = [
  'results', 'data.results', 'data.list', 'data.items', 'data.data', 'data',
  'items', 'list', 'hits.hits', 'webPages.value', 'search_result', 'documents', 'docs',
]

function resolveItemsArray(data: any, itemsPath: string): any[] {
  const explicit = pickJsonPath(data, itemsPath)
  if (Array.isArray(explicit)) return explicit
  for (const p of AUTO_ITEMS_PATHS) {
    const v = pickJsonPath(data, p)
    if (Array.isArray(v) && v.length) return v
  }
  return []
}

function pickItemField(item: any, field: string, fallbacks: string[]): string {
  if (field) {
    const v = pickJsonPath(item, field)
    if (v !== undefined && v !== null && String(v).trim()) return String(v).trim()
  }
  for (const key of fallbacks) {
    const v = item?.[key]
    if (v !== undefined && v !== null && String(v).trim()) return String(v).trim()
  }
  return ''
}

function resolveItemUrl(raw: string, base: string): string {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s)) return s
  try {
    return new URL(s, base || undefined).toString()
  } catch {
    return s
  }
}

function buildCustomHeaders(headersRaw: string, apiKey: string): Record<string, string> {
  const out: Record<string, string> = {}
  const lines = String(headersRaw || '').split(/\r?\n/)
  for (const line of lines) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim().replace(/\{key\}/g, apiKey || '')
    if (key) out[key] = value
  }
  if (apiKey && !Object.keys(out).some((k) => k.toLowerCase() === 'authorization')) {
    out.Authorization = `Bearer ${apiKey}`
  }
  return out
}

function buildCustomUrl(base: string, query: string, method: 'GET' | 'POST'): string {
  const tpl = String(base || '')
  if (tpl.includes('{query}')) return tpl.replace(/\{query\}/g, encodeURIComponent(query))
  const u = new URL(tpl)
  if (!u.searchParams.has('q')) u.searchParams.set('q', method === 'POST' ? query : query)
  return u.toString()
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetchWithTimeout(url, init)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

function cleanSearchItems(items: any[]): WebSearchItem[] {
  const out: WebSearchItem[] = []
  for (const it of items || []) {
    const title = String(it?.title || '').trim()
    const url = String(it?.url || '').trim()
    if (!title && !url) continue
    out.push({
      title,
      url,
      snippet: String(it?.snippet || it?.summary || '').trim(),
      ...(it?.summary ? { summary: String(it.summary).trim() } : {}),
      ...(typeof it?.content === 'string' && it.content.trim() ? { content: it.content.trim().slice(0, 4000) } : {}),
    })
  }
  return out
}

interface SearchOutcome {
  items: WebSearchItem[]
  via: string
}

/** 跨域提示：渲染层读不到结果页（HTML 抓取类搜索源都会走到这里） */
const CORS_HINT = '（手机 / 网页端只能读取允许跨域的接口；结果页 HTML 抓取需要桌面端或主机）'

async function searchCustomSource(cs: any, query: string, config: WebSearchConfig): Promise<SearchOutcome> {
  const base = normalizeCustomHost(cs.apiHost)
  if (!base) throw new Error(`自定义源「${cs.name}」未填写地址`)
  if (cs.kind === 'searxng') {
    const params = new URLSearchParams({ q: query, format: 'json' })
    if (cs.engines) params.set('engines', cs.engines)
    if (cs.language && cs.language !== 'auto') params.set('language', cs.language)
    const data = await fetchJson(`${base}/search?${params.toString()}`)
    const items = cleanSearchItems((data?.results || []).map((r: any) => ({
      title: r?.title, url: resolveItemUrl(r?.url, base), snippet: r?.content ?? r?.snippet,
    })))
    return { items, via: 'custom-searxng' }
  }

  const url = buildCustomUrl(base, query, cs.method)
  const init: RequestInit = { method: cs.method, headers: buildCustomHeaders(cs.headers, cs.apiKey) }
  if (cs.method === 'POST') {
    const tpl = String(cs.bodyTemplate || '').trim()
    ;(init.headers as Record<string, string>)['Content-Type'] = 'application/json'
    init.body = tpl
      ? tpl.replace(/\{query\}/g, query.replace(/\\/g, '\\\\').replace(/"/g, '\\"'))
      : JSON.stringify({ query, count: config.maxResults })
  }
  const data = await fetchJson(url, init)
  const arr = resolveItemsArray(data, String(cs.itemsPath || '').trim())
  if (!arr.length) throw new Error(`自定义源「${cs.name}」响应中未解析到结果数组（可在「结果路径」填 data.list 之类的字段路径）`)
  const items = cleanSearchItems(arr.slice(0, Math.max(config.maxResults, 20)).map((it: any) => ({
    title: pickItemField(it, cs.titleField, ['title', 'name', 'subject', 'heading', 'docTitle']),
    url: resolveItemUrl(pickItemField(it, cs.urlField, ['url', 'link', 'href', 'uri', 'path']), base),
    snippet: pickItemField(it, cs.snippetField, ['snippet', 'content', 'summary', 'description', 'text', 'abstract']),
  })))
  return { items, via: 'custom-json' }
}

async function searchSearxng(query: string, cfg: WebSearchConfig): Promise<SearchOutcome> {
  const host = normalizeCustomHost(String(cfg.searxng.apiHost || ''))
  if (!host) throw new Error('未配置 SearXNG 实例地址')
  const params = new URLSearchParams({ q: query, format: 'json' })
  if (cfg.searxng.engines) params.set('engines', cfg.searxng.engines)
  if (cfg.searxng.language && cfg.searxng.language !== 'auto') params.set('language', cfg.searxng.language)
  const data = await fetchJson(`${host}/search?${params.toString()}`)
  return {
    items: cleanSearchItems((data?.results || []).map((r: any) => ({
      title: r?.title, url: r?.url, snippet: r?.content ?? r?.snippet,
    }))),
    via: 'json',
  }
}

async function searchBocha(query: string, cfg: WebSearchConfig): Promise<SearchOutcome> {
  const host = normalizeCustomHost(cfg.bocha.apiHost || 'https://api.bochaai.com')
  const apiKey = String(cfg.bocha.apiKey || '').trim()
  if (!apiKey) throw new Error('未配置博查 API Key')
  const data = await fetchJson(`${host}/v1/web-search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, count: cfg.maxResults, summary: true }),
  })
  if (data?.code !== undefined && Number(data.code) !== 200) throw new Error(`博查返回错误：${data?.msg || data?.code}`)
  return {
    items: cleanSearchItems((data?.data?.webPages?.value || []).map((r: any) => ({
      title: r?.name, url: r?.url, snippet: r?.summary || r?.snippet,
    }))),
    via: 'api',
  }
}

async function searchZhipu(query: string, cfg: WebSearchConfig): Promise<SearchOutcome> {
  const host = normalizeCustomHost(cfg.zhipu.apiHost || 'https://open.bigmodel.cn/api/paas/v4')
  const apiKey = String(cfg.zhipu.apiKey || '').trim()
  if (!apiKey) throw new Error('未配置智谱 API Key')
  const data = await fetchJson(`${host}/web_search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ search_query: query, search_engine: cfg.zhipu.searchEngine || 'search_std', count: cfg.maxResults }),
  })
  return {
    items: cleanSearchItems((data?.search_result || []).map((r: any) => ({
      title: r?.title, url: r?.link || r?.url, snippet: stripTags(String(r?.content || '')),
    }))),
    via: 'api',
  }
}

async function searchTavily(query: string, cfg: WebSearchConfig): Promise<SearchOutcome> {
  const host = normalizeCustomHost(cfg.tavily.apiHost || 'https://api.tavily.com')
  const apiKey = String(cfg.tavily.apiKey || '').trim()
  if (!apiKey) throw new Error('未配置 Tavily API Key')
  const data = await fetchJson(`${host}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: cfg.maxResults }),
  })
  return {
    items: cleanSearchItems((data?.results || []).map((r: any) => ({ title: r?.title, url: r?.url, snippet: r?.content }))),
    via: 'api',
  }
}

/**
 * Firecrawl（免 Key 可用）：POST `<host>/v2/search`。
 *
 * 请求组装 / 响应解析 / 错误翻译与主进程**共用同一份纯函数**
 * （`@/shared/webSearchFirecrawl`），这里只负责发请求。接口已开跨域
 * （`Access-Control-Allow-Origin: *`，允许 `content-type, authorization`），
 * 因此手机 / 网页端同样可用——与 HTML 抓取类搜索源不同，不需要桌面端。
 */
async function searchFirecrawl(query: string, cfg: WebSearchConfig): Promise<SearchOutcome> {
  const apiKey = String(cfg.firecrawl.apiKey || '').trim()
  const req = buildFirecrawlSearchRequest({
    query,
    maxResults: cfg.maxResults,
    apiHost: cfg.firecrawl.apiHost,
    apiKey,
  })
  let data: any
  try {
    data = await fetchJson(req.url, { method: req.method, headers: req.headers, body: req.body })
    const items = parseFirecrawlSearchResponse(data, cfg.maxResults)
    if (!items.length) throw new Error('Firecrawl 未返回可用结果')
    return { items, via: 'api' }
  } catch (e: any) {
    throw new Error(firecrawlErrorMessage(e, !!apiKey))
  }
}

async function searchBrave(query: string, cfg: WebSearchConfig): Promise<SearchOutcome> {
  const host = normalizeCustomHost(cfg.brave.apiHost || 'https://api.search.brave.com')
  const apiKey = String(cfg.brave.apiKey || '').trim()
  if (!apiKey) throw new Error('未配置 Brave Search API Key')
  const params = new URLSearchParams({ q: query, count: String(cfg.maxResults) })
  const data = await fetchJson(`${host}/res/v1/web/search?${params.toString()}`, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
  })
  return {
    items: cleanSearchItems((data?.web?.results || []).map((r: any) => ({
      title: r?.title, url: r?.url, snippet: stripTags(String(r?.description || '')),
    }))),
    via: 'api',
  }
}

/**
 * DeepSeek 官方搜索（原生 Search API，`POST <base>/v1/tools/search`）。
 *
 * 与桌面端主进程共用 `@/shared/deepseekApi` 的请求组装 / 响应解析：纯 HTTP + Bearer，
 * 只要能跨域就能在手机 / 网页端直接跑（被拦时按普通跨域失败提示）。
 * `cfg.deepseek.apiKey` 由 store 的 `buildWebSearchPayload()` 解析后填入。
 */
async function searchDeepSeek(query: string, cfg: WebSearchConfig): Promise<SearchOutcome> {
  const ds: any = (cfg as any).deepseek || {}
  const apiKey = String(ds.apiKey || '').trim()
  if (!apiKey) throw new Error('未配置 DeepSeek API Key（可在「工具 → 搜索」填，或让对话使用 DeepSeek 以复用凭据）')
  const items = await runDeepSeekSearchApi({
    query,
    maxResults: cfg.maxResults,
    needContent: !!ds.needContent,
    apiHost: ds.apiHost,
    apiKey,
  })
  return { items: cleanSearchItems(items), via: 'deepseek-api' }
}

/** 解析结果页 HTML 的搜索源在渲染层无法使用（结果页不允许跨域读取） */
function htmlScrapingSource(provider: ProviderId): SearchOutcome {
  throw new Error(`搜索源「${provider}」在手机 / 网页端不可用${CORS_HINT}`)
}

async function runSingleSearch(provider: ProviderId, query: string, cfg: WebSearchConfig): Promise<SearchOutcome> {
  const custom = findWebSearchCustomSource(cfg, provider)
  if (custom) return await searchCustomSource(custom, query, cfg)
  switch (provider) {
    case 'searxng': return await searchSearxng(query, cfg)
    case 'bocha': return await searchBocha(query, cfg)
    case 'zhipu': return await searchZhipu(query, cfg)
    case 'tavily': return await searchTavily(query, cfg)
    case 'brave': return await searchBrave(query, cfg)
    case 'firecrawl': return await searchFirecrawl(query, cfg)
    // DeepSeek 官方 Search 接口是纯 HTTP + Bearer；能否在渲染层直接跑取决于跨域，失败时按普通错误提示
    case 'deepseek': return await searchDeepSeek(query, cfg)
    case 'bing':
    case 'baidu':
    case 'duckduckgo': return htmlScrapingSource(provider)
    default: throw new Error(`未知搜索源：${provider}`)
  }
}

function toSearchItems(items: WebSearchItem[], maxResults: number): WebSearchItem[] {
  return items.slice(0, maxResults).map((it) => ({
    title: it.title,
    url: it.url,
    snippet: it.snippet || '',
    summary: it.summary || it.snippet || '',
    ...(it.content ? { content: it.content } : {}),
  }))
}

function mergeSearchItems(groups: WebSearchItem[][], maxResults: number): WebSearchItem[] {
  const seen = new Set<string>()
  const out: WebSearchItem[] = []
  for (const group of groups) {
    for (const it of group) {
      const key = String(it.url || '').replace(/\/+$/, '').toLowerCase() || `${it.title}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(it)
      if (out.length >= maxResults) return out
    }
  }
  return out
}

/** 渲染层执行一次联网搜索（与主进程 runWebSearch 同语义，仅 HTTP 通道） */
export async function runRendererWebSearch(rawQuery: string, rawCfg: any): Promise<WebSearchRunResult> {
  const query = String(rawQuery ?? '').trim()
  if (!query) throw new Error('搜索关键词不能为空')
  const config = normalizeWebSearchConfig(rawCfg)
  const providers = config.providers
  const started = Date.now()

  if (config.strategy === 'merge') {
    const settled = await Promise.allSettled(providers.map((id) => runSingleSearch(id, query, config)))
    const groups: WebSearchItem[][] = []
    const attempts: Array<{ provider: any; ok: boolean; error?: string }> = []
    settled.forEach((s, i) => {
      const id = providers[i]
      if (s.status === 'fulfilled' && s.value.items.length) {
        groups.push(s.value.items)
        attempts.push({ provider: id, ok: true })
      } else {
        attempts.push({
          provider: id,
          ok: false,
          error: s.status === 'fulfilled' ? '未返回结果' : (s.reason?.message || String(s.reason)),
        })
      }
    })
    const results = mergeSearchItems(groups, config.maxResults)
    if (!results.length) {
      throw new Error(`全部搜索源均未返回结果 —— ${attempts.map((a) => `${a.provider}: ${a.error}`).join('；')}`)
    }
    return {
      query,
      provider: attempts.find((a) => a.ok)!.provider,
      providers,
      via: 'merge',
      results,
      elapsedMs: Date.now() - started,
      attempts,
    }
  }

  const attempts: Array<{ provider: any; ok: boolean; error?: string }> = []
  for (const id of providers) {
    try {
      const outcome = await runSingleSearch(id, query, config)
      if (outcome.items.length) {
        attempts.push({ provider: id, ok: true })
        return {
          query,
          provider: id,
          providers,
          via: outcome.via,
          results: toSearchItems(outcome.items, config.maxResults),
          elapsedMs: Date.now() - started,
          attempts,
        }
      }
      attempts.push({ provider: id, ok: false, error: '未返回结果' })
    } catch (e: any) {
      attempts.push({ provider: id, ok: false, error: e?.message || String(e) })
    }
  }
  throw new Error(`全部搜索源均失败 —— ${attempts.map((a) => `${a.provider}: ${a.error || '失败'}`).join('；')}`)
}
