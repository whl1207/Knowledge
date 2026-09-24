/**
 * webSearch.ts — web_search 工具「搜索源」共享定义（主进程 / preload / 渲染进程共用）
 *
 * 背景：内置联网搜索（web_search / web_fetch）默认走无 Key 的 Bing 网页渲染；
 * 设置页「工具 → 搜索」可切换为其它搜索源，配置经 IPC（webSearch:set-config）注入主进程。
 *
 * 搜索源分类：
 * - 免 Key（本地渲染/公开接口）：bing（默认）/ baidu / duckduckgo
 * - 自建实例：searxng（需实例地址）
 * - API Key：tavily（国际）/ bocha 博查（国内）/ brave（国际）/ zhipu 智谱（国内）
 * - 自定义源（`config.customs`，源 id 形如 `cs:<自定义 id>`）：内网 SearXNG 兼容实例、
 *   通用 HTTP JSON 接口（内网 wiki / 搜索服务，字段可映射），用于局域网内网源。
 */

/** 内置搜索源 id（顺序即设置页默认列表顺序） */
export const WEB_SEARCH_PROVIDER_IDS = [
  'bing',
  'baidu',
  'duckduckgo',
  'searxng',
  'bocha',
  'zhipu',
  'tavily',
  'brave',
] as const

/** 内置搜索源 id 联合类型 */
export type WebSearchBuiltinId = (typeof WEB_SEARCH_PROVIDER_IDS)[number]

/** 自定义源的搜索源 id 前缀（列表 / 启用集合 / order / 测试 provider 参数统一用该编码） */
export const CUSTOM_PROVIDER_PREFIX = 'cs:'

/** 编码自定义源 id 为搜索源 id（`c1` → `cs:c1`） */
export function toCustomProviderId(id: string): string {
  return `${CUSTOM_PROVIDER_PREFIX}${id}`
}

/** 判断是否为自定义源 id */
export function isCustomProviderId(providerId: string): boolean {
  return String(providerId || '').startsWith(CUSTOM_PROVIDER_PREFIX)
}

/** 由搜索源 id 取自定义源 id（非自定义源返回空串） */
export function fromCustomProviderId(providerId: string): string {
  const s = String(providerId || '')
  return isCustomProviderId(s) ? s.slice(CUSTOM_PROVIDER_PREFIX.length) : ''
}

/** 判断是否为内置搜索源 id */
export function isBuiltinProviderId(providerId: string): boolean {
  return (WEB_SEARCH_PROVIDER_IDS as readonly string[]).includes(String(providerId || ''))
}

/**
 * 搜索源 id：内置 id（`WebSearchBuiltinId`）或自定义源编码 `cs:<自定义 id>`。
 * 自定义源在内网部署时允许任意数量，因此这里是宽类型。
 */
export type WebSearchProviderId = string

/** 单个搜索源的端点配置（不同源使用的字段不同，多余的字段被忽略） */
export interface WebSearchProviderConfig {
  /** API Key（tavily / bocha / brave / zhipu 必填） */
  apiKey?: string
  /** 接口地址（可留空用默认值；自建实例必填） */
  apiHost?: string
  /** 智谱搜索等级：search_std（基础）/ search_pro（高阶） */
  searchEngine?: string
  /** SearXNG 启用引擎（逗号分隔，如 google,bing；留空用实例默认） */
  engines?: string
  /** SearXNG 语言（auto / zh-CN / en） */
  language?: string
}

/** 单次搜索的调用策略 */
export type WebSearchStrategy = 'fallback' | 'merge'

/**
 * 自定义搜索源类型：
 * - `searxng`：内网 SearXNG 兼容实例（GET `<apiHost>/search?q=&format=json`）
 * - `json`：通用 HTTP JSON 接口（自定义 URL 模板 + 结果字段映射，适配内网 wiki / 搜索服务）
 */
export type WebSearchCustomKind = 'searxng' | 'json'

/** 一个自定义（内网）搜索源的配置 */
export interface WebSearchCustomSource {
  /** 源内部 id（稳定不变，用于 `cs:<id>` 编码） */
  id: string
  /** 显示名称（列表与测试结果展示） */
  name: string
  /** 类型：searxng / json */
  kind: WebSearchCustomKind
  /** 请求地址：searxng 填实例根地址；json 填完整 URL（可用 `{query}` 占位，缺省自动追加 q 参数） */
  apiHost: string
  /** json 类型的请求方法（GET / POST） */
  method: 'GET' | 'POST'
  /** json 类型 POST 请求体模板（可用 `{query}` 占位；JSON 模板请自行加引号） */
  bodyTemplate: string
  /** 额外请求头（每行 `Key: Value`，值可用 `{key}` 占位为 API Key） */
  headers: string
  /** API Key（未自定义 Authorization 头时自动作为 `Bearer` 发送） */
  apiKey: string
  /** 结果数组所在的点号路径（如 `data.list` / `hits.hits`；留空自动识别常见字段） */
  itemsPath: string
  /** 标题字段（点号路径，留空取 title） */
  titleField: string
  /** 链接字段（点号路径，留空取 url/link） */
  urlField: string
  /** 摘要字段（点号路径，留空取 snippet/content/summary/description） */
  snippetField: string
  /** searxng 类型：启用引擎（逗号分隔，留空用实例默认） */
  engines: string
  /** searxng 类型：语言（auto / zh-CN / en） */
  language: string
}

/** 新建自定义源的默认值（id 由调用方生成或自动生成） */
export function newWebSearchCustomSource(name?: string, kind: WebSearchCustomKind = 'json'): WebSearchCustomSource {
  const rand = Math.random().toString(36).slice(2, 8)
  return {
    id: `c${Date.now().toString(36)}${rand}`,
    name: String(name || '').trim() || '内网搜索源',
    kind,
    apiHost: '',
    method: 'GET',
    bodyTemplate: '',
    headers: '',
    apiKey: '',
    itemsPath: '',
    titleField: '',
    urlField: '',
    snippetField: '',
    engines: '',
    language: 'auto',
  }
}

/** 归一化单个自定义源（缺字段回退默认；id/名称非法时返回 null） */
export function normalizeCustomSearchSource(raw: any): WebSearchCustomSource | null {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.id || '').trim()
  if (!id) return null
  const str = (v: any, fb = '') => (typeof v === 'string' ? v : fb)
  return {
    id,
    name: String(raw.name || '').trim() || '内网搜索源',
    kind: raw.kind === 'searxng' ? 'searxng' : 'json',
    apiHost: str(raw.apiHost),
    method: raw.method === 'POST' ? 'POST' : 'GET',
    bodyTemplate: str(raw.bodyTemplate),
    headers: str(raw.headers),
    apiKey: str(raw.apiKey),
    itemsPath: str(raw.itemsPath),
    titleField: str(raw.titleField),
    urlField: str(raw.urlField),
    snippetField: str(raw.snippetField),
    engines: str(raw.engines),
    language: str(raw.language, 'auto') || 'auto',
  }
}

/** 按搜索源 id 取自定义源配置（非自定义源 / 已删除返回 undefined） */
export function findWebSearchCustomSource(
  config: WebSearchConfig | null | undefined,
  providerId: string,
): WebSearchCustomSource | undefined {
  const cid = fromCustomProviderId(providerId)
  if (!cid) return undefined
  const list = Array.isArray(config?.customs) ? config!.customs : []
  return list.find((s) => s && s.id === cid)
}

/**
 * web_search 完整配置（持久化于 localStorage `webSearchConfig`）
 *
 * 多源语义：`providers` 为**已启用**的搜索源（数组顺序 = 尝试顺序），可同时开启多个；
 * `strategy` 决定多个源如何协同：`fallback` 依次回退 / `merge` 并行聚合去重。
 * 自定义源与内置源共用 `providers` / `order`（自定义源 id 形如 `cs:<自定义 id>`）。
 */
export interface WebSearchConfig {
  /** 已启用的搜索源（有序；至少 1 个；顺序同 `order` 中的相对位置） */
  providers: WebSearchProviderId[]
  /** 列表展示顺序（全部搜索源，= 用户拖动后的顺序；回退/聚合按其中已启用项的顺序执行） */
  order: WebSearchProviderId[]
  /** 多源策略：fallback=按顺序逐个回退（默认）/ merge=全部并行后合并去重 */
  strategy: WebSearchStrategy
  /** 返回结果条数（1~20） */
  maxResults: number
  /** Bing：中文长句查询改写（规避 Bing 对长中文句的拆词/实体识别问题） */
  rewriteZhQuery: boolean
  /** 自定义（内网）搜索源列表 */
  customs: WebSearchCustomSource[]
  searxng: WebSearchProviderConfig
  tavily: WebSearchProviderConfig
  bocha: WebSearchProviderConfig
  brave: WebSearchProviderConfig
  zhipu: WebSearchProviderConfig
}

/** 单条搜索结果（web_search 工具返回值 / 设置页测试结果共用） */
export interface WebSearchItem {
  title: string
  url: string
  snippet: string
  summary?: string
}

/** 一次搜索的执行结果（工具内 / 设置页测试共用） */
export interface WebSearchRunResult {
  query: string
  /** 实际产出结果的搜索源（聚合模式下为首个源） */
  provider: WebSearchProviderId
  /** 本次参与搜索的源（顺序与配置一致） */
  providers: WebSearchProviderId[]
  /** 实际通道：browser / html-fallback / html / json / api / merge */
  via: string
  results: WebSearchItem[]
  elapsedMs: number
  /** 未命中或失败的源及其原因（回退模式下排查用） */
  attempts?: Array<{ provider: WebSearchProviderId; ok: boolean; error?: string }>
}

/** 设置页测试搜索的返回（IPC webSearch:test；success 而非 ok，避免被 IPC 信封解包） */
export interface WebSearchTestResult {
  success: boolean
  query?: string
  provider?: WebSearchProviderId
  providers?: WebSearchProviderId[]
  via?: string
  elapsedMs: number
  results?: WebSearchItem[]
  error?: string
}

/** 搜索源展示元信息（设置页下拉与说明用；中英双语） */
export interface WebSearchProviderMeta {
  id: WebSearchProviderId
  label: string
  labelEn: string
  /** 是否需要 API Key */
  needsKey: boolean
  /** 是否需要自建实例地址 */
  needsHost: boolean
  zh: string
  en: string
  /** 申请 Key / 文档地址 */
  docs?: string
  /** 是否为用户自定义（内网）搜索源 */
  custom?: boolean
}

export const WEB_SEARCH_PROVIDERS: WebSearchProviderMeta[] = [
  {
    id: 'bing',
    label: 'Bing 网页（免 Key）',
    labelEn: 'Bing (keyless)',
    needsKey: false,
    needsHost: false,
    zh: '默认源：隐藏浏览器渲染 cn.bing.com 并解析结果，失败时退化为 HTML 解析；中文长句会自动改写关键词。',
    en: 'Default: renders cn.bing.com in a hidden browser and parses results, with HTML parsing as fallback; long Chinese queries are rewritten automatically.',
  },
  {
    id: 'baidu',
    label: '百度网页（免 Key）',
    labelEn: 'Baidu (keyless)',
    needsKey: false,
    needsHost: false,
    zh: '国内网络直连可用；渲染百度搜索结果页解析标题/摘要，失败时退化为 HTML 解析。',
    en: 'Works on mainland networks; renders the Baidu result page to extract titles/snippets, with HTML parsing as fallback.',
  },
  {
    id: 'duckduckgo',
    label: 'DuckDuckGo（免 Key）',
    labelEn: 'DuckDuckGo (keyless)',
    needsKey: false,
    needsHost: false,
    zh: '隐私友好、无需 Key；先走 HTML 接口，失败后在隐藏浏览器中渲染（部分网络环境可能被拦截）。',
    en: 'Privacy-friendly and keyless; tries the HTML endpoint first and falls back to a hidden browser (may be blocked on some networks).',
  },
  {
    id: 'searxng',
    label: 'SearXNG（自建实例）',
    labelEn: 'SearXNG (self-hosted)',
    needsKey: false,
    needsHost: true,
    zh: '自建元搜索实例，聚合 Google/Bing 等引擎；需填写实例地址（且实例需开启 JSON 输出）。',
    en: 'Self-hosted metasearch over Google/Bing etc.; requires the instance URL and JSON output enabled.',
    docs: 'https://docs.searxng.org',
  },
  {
    id: 'bocha',
    label: '博查 Bocha（国内 API）',
    labelEn: 'Bocha (API)',
    needsKey: true,
    needsHost: false,
    zh: '国内搜索 API，中文资料与时效性内容覆盖好；需 API Key。',
    en: 'China-based search API with strong Chinese coverage; requires an API key.',
    docs: 'https://open.bochaai.com',
  },
  {
    id: 'zhipu',
    label: '智谱 Web Search（国内 API）',
    labelEn: 'Zhipu Web Search (API)',
    needsKey: true,
    needsHost: false,
    zh: '智谱开放平台 web_search 接口；需 API Key，可选基础/高阶搜索。',
    en: 'Zhipu BigModel web_search endpoint; requires an API key and supports basic/advanced search.',
    docs: 'https://docs.bigmodel.cn/cn/guide/tools/web-search',
  },
  {
    id: 'tavily',
    label: 'Tavily（国际 API）',
    labelEn: 'Tavily (API)',
    needsKey: true,
    needsHost: false,
    zh: '面向 AI 应用的搜索 API（含摘要），国际网络使用；需 API Key。',
    en: 'Search API built for AI apps (with summaries); requires an API key.',
    docs: 'https://app.tavily.com/home',
  },
  {
    id: 'brave',
    label: 'Brave Search（国际 API）',
    labelEn: 'Brave Search (API)',
    needsKey: true,
    needsHost: false,
    zh: '独立索引的搜索 API；需 API Key（免费额度较少）。',
    en: 'Independent-index search API; requires an API key.',
    docs: 'https://brave.com/search/api/',
  },
]

/** 出厂默认配置（Bing 免 Key，保持旧行为不变） */
export const DEFAULT_WEB_SEARCH_CONFIG: WebSearchConfig = {
  providers: ['bing'],
  order: [...WEB_SEARCH_PROVIDER_IDS],
  strategy: 'fallback',
  maxResults: 8,
  rewriteZhQuery: true,
  customs: [],
  searxng: { apiHost: 'http://localhost:8080', engines: '', language: 'auto' },
  tavily: { apiKey: '', apiHost: 'https://api.tavily.com' },
  bocha: { apiKey: '', apiHost: 'https://api.bochaai.com' },
  brave: { apiKey: '', apiHost: 'https://api.search.brave.com' },
  zhipu: { apiKey: '', apiHost: 'https://open.bigmodel.cn/api/paas/v4', searchEngine: 'search_std' },
}

/** 搜索源图标（Font Awesome 4 类名，设置页左列表用） */
const WEB_SEARCH_PROVIDER_ICONS: Record<string, string> = {
  bing: 'fa-windows',
  baidu: 'fa-paw',
  duckduckgo: 'fa-user-secret',
  searxng: 'fa-server',
  bocha: 'fa-cubes',
  zhipu: 'fa-magic',
  tavily: 'fa-bullseye',
  brave: 'fa-shield',
}

/** 自定义源图标（内网源统一用插头图标） */
export const CUSTOM_SEARCH_ICON = 'fa-plug'

/** 取搜索源图标类名（自定义源 / 未知 id 有各自回退） */
export function webSearchProviderIcon(id: string): string {
  if (isCustomProviderId(id)) return CUSTOM_SEARCH_ICON
  return WEB_SEARCH_PROVIDER_ICONS[id] || 'fa-search'
}

/**
 * 归一化配置（缺字段回退默认；未知 provider 剔除；maxResults 收敛到 1~20）。
 * 兼容旧存档：旧版单源字段 `provider: 'bing'` 会迁移为 `providers: ['bing']`。
 * 至少要有一个启用源（全关时回退为默认 Bing），避免搜索工具无源可用。
 * 自定义源：`customs` 逐项归一化（去重、非法项剔除），其 `cs:<id>` 编码同步进 `order`。
 */
export function normalizeWebSearchConfig(raw: any): WebSearchConfig {
  const src = raw && typeof raw === 'object' ? raw : {}
  // 自定义（内网）搜索源：逐项归一化并去重（id 重复只保留第一个）
  const customs: WebSearchCustomSource[] = []
  const customSeen = new Set<string>()
  for (const item of Array.isArray(src.customs) ? src.customs : []) {
    const cs = normalizeCustomSearchSource(item)
    if (!cs || customSeen.has(cs.id)) continue
    customSeen.add(cs.id)
    customs.push(cs)
  }
  const customIds = customs.map((s) => toCustomProviderId(s.id))
  const pick = (id: keyof WebSearchConfig) => {
    const base = DEFAULT_WEB_SEARCH_CONFIG[id] as WebSearchProviderConfig
    const patch = src[id]
    const out: WebSearchProviderConfig = { ...base }
    if (patch && typeof patch === 'object') {
      for (const key of ['apiKey', 'apiHost', 'searchEngine', 'engines', 'language'] as const) {
        if (typeof patch[key] === 'string') out[key] = patch[key]
      }
    }
    return out
  }
  const valid = (v: any): v is WebSearchProviderId =>
    typeof v === 'string' && (isBuiltinProviderId(v) || customIds.includes(v))
  let enabledSrc: WebSearchProviderId[]
  if (Array.isArray(src.providers)) {
    enabledSrc = Array.from(new Set(src.providers.filter(valid))) as WebSearchProviderId[]
  } else if (valid(src.provider)) {
    // 旧版单源配置迁移
    enabledSrc = [src.provider]
  } else {
    enabledSrc = [...DEFAULT_WEB_SEARCH_CONFIG.providers]
  }
  // 列表顺序：优先用存档的 order（拖动排序的结果），否则用旧配置的启用顺序 + 其余源
  const order: WebSearchProviderId[] = []
  if (Array.isArray(src.order)) {
    for (const v of src.order) {
      if (valid(v) && !order.includes(v)) order.push(v)
    }
  }
  for (const id of enabledSrc) if (!order.includes(id)) order.push(id)
  for (const id of WEB_SEARCH_PROVIDER_IDS) if (!order.includes(id)) order.push(id)
  // 新增的自定义源默认排在末尾（已存档顺序不被打乱）
  for (const id of customIds) if (!order.includes(id)) order.push(id)
  // 已启用集合按 order 重排（保证两者一致）；至少要有一个启用源
  let providers = order.filter((id) => enabledSrc.includes(id))
  if (!providers.length) providers = [order[0] || DEFAULT_WEB_SEARCH_CONFIG.providers[0]]
  const maxRaw = Number(src.maxResults)
  const maxResults = Number.isFinite(maxRaw)
    ? Math.min(20, Math.max(1, Math.round(maxRaw)))
    : DEFAULT_WEB_SEARCH_CONFIG.maxResults
  return {
    providers,
    order,
    strategy: src.strategy === 'merge' ? 'merge' : 'fallback',
    maxResults,
    rewriteZhQuery: typeof src.rewriteZhQuery === 'boolean' ? src.rewriteZhQuery : DEFAULT_WEB_SEARCH_CONFIG.rewriteZhQuery,
    customs,
    searxng: pick('searxng'),
    tavily: pick('tavily'),
    bocha: pick('bocha'),
    brave: pick('brave'),
    zhipu: pick('zhipu'),
  }
}

/** 自定义源 → 展示元信息（名称来自用户配置，说明按类型区分） */
export function customSearchSourceMeta(cs: WebSearchCustomSource): WebSearchProviderMeta {
  const isSearx = cs.kind === 'searxng'
  return {
    id: toCustomProviderId(cs.id),
    label: cs.name,
    labelEn: cs.name,
    needsKey: !!(cs.apiKey || '').trim() || !!(cs.headers || '').trim(),
    needsHost: true,
    custom: true,
    zh: isSearx
      ? '自定义源（内网 SearXNG 兼容实例）：填实例地址即可，实例需开启 JSON 输出。'
      : '自定义源（内网 HTTP JSON 接口）：填请求地址与结果字段映射，可加请求头 / Token。',
    en: isSearx
      ? 'Custom source (LAN SearXNG-compatible instance): just set the instance URL; JSON output must be enabled.'
      : 'Custom source (LAN HTTP JSON API): set the request URL and result field mapping, optional headers / token.',
  }
}

/**
 * 取搜索源展示元信息：内置源 → 内置表；自定义源（`cs:<id>`）→ 由传入配置解析出名称与类型；
 * 未知 id 回退第一个内置源。
 */
export function webSearchProviderMeta(id: string, config?: WebSearchConfig | null): WebSearchProviderMeta {
  const builtin = WEB_SEARCH_PROVIDERS.find((p) => p.id === id)
  if (builtin) return builtin
  const cs = findWebSearchCustomSource(config, id)
  if (cs) return customSearchSourceMeta(cs)
  return {
    id,
    label: '自定义搜索源',
    labelEn: 'Custom source',
    needsKey: true,
    needsHost: true,
    custom: true,
    zh: '自定义源：配置不存在（可能已被删除）。',
    en: 'Custom source: configuration not found (it may have been deleted).',
  }
}
