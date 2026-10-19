/**
 * webFetch.ts — web_fetch 工具「抓取通道」共享定义（主进程 / preload / 渲染进程共用）
 *
 * 背景：`web_fetch` 以前固定是「直接 fetch → 隐藏浏览器兜底」两条硬编码通道，
 * 既不能关闭，也不能插入别的抓取方式。现在三条通道各自可开关、可排序，按顺序依次回退：
 *
 * - `direct`  ：内置 HTTP 客户端直接请求（带浏览器请求头；HTML 正文提取 + PDF 解析）；
 * - `deepseek`：DeepSeek 官方 Fetch 接口（`POST /v1/tools/fetch`，服务端渲染后返回 Markdown）；
 * - `browser` ：隐藏的 Chromium 窗口加载页面（可执行 JS，过反爬 / 人机验证挑战；仅桌面端）。
 *
 * 默认保持旧行为：`direct` + `browser` 开启、`deepseek` 关闭；`order` 里 DeepSeek 排在
 * direct 之后、browser 之前，因此用户一打开 DeepSeek 抓取，它就自动成为「直接访问失败后的
 * 第一层回退」，无需再调顺序。
 *
 * 配置持久化于 localStorage `webFetchConfig`，经 IPC（webFetch:set-config）下发给主进程。
 */

import { DEEPSEEK_API_DEFAULT_HOST, normalizeDeepSeekApiHost } from './deepseekApi'

/** 内置抓取通道 id（顺序即设置页默认展示 / 默认尝试顺序） */
export const WEB_FETCH_CHANNEL_IDS = ['direct', 'deepseek', 'browser'] as const

/** 单个抓取通道 id */
export type WebFetchChannelId = (typeof WEB_FETCH_CHANNEL_IDS)[number]

/** 各通道开关 */
export type WebFetchChannelFlags = Record<WebFetchChannelId, boolean>

/** 判断是否为合法通道 id */
export function isWebFetchChannelId(id: unknown): id is WebFetchChannelId {
  return typeof id === 'string' && (WEB_FETCH_CHANNEL_IDS as readonly string[]).includes(id)
}

/** DeepSeek 官方 Fetch 的配置（apiHost / Key 与对话配置相互独立） */
export interface DeepSeekFetchConfig {
  /** 单独的 API Key（留空时按 `reuseChatKey` 复用其它 DeepSeek 凭据） */
  apiKey?: string
  /** 接口 base（默认 https://api.deepseek.com；旧版 /anthropic 段会被自动剥掉） */
  apiHost?: string
  /** 凭据引用（主进程凭据库里的名字；优先于内联 apiKey） */
  apiKeyRef?: string
  /** 自己的 Key 为空时，是否复用「工具 → 搜索」或对话的 DeepSeek 凭据（默认 true） */
  reuseChatKey?: boolean
}

/** web_fetch 完整配置（持久化于 localStorage `webFetchConfig`） */
export interface WebFetchConfig {
  /** 通道尝试顺序（只影响已开启通道的相对顺序） */
  order: WebFetchChannelId[]
  /** 各通道开关（至少一个开启；归一化会兜底打开 direct） */
  channels: WebFetchChannelFlags
  /** DeepSeek 官方 Fetch 配置 */
  deepseek: DeepSeekFetchConfig
}

/** 出厂默认：与旧行为一致（direct → browser），DeepSeek 抓取默认关闭 */
export const DEFAULT_WEB_FETCH_CONFIG: WebFetchConfig = {
  order: [...WEB_FETCH_CHANNEL_IDS],
  channels: { direct: true, deepseek: false, browser: true },
  deepseek: {
    apiKey: '',
    apiHost: DEEPSEEK_API_DEFAULT_HOST,
    apiKeyRef: '',
    reuseChatKey: true,
  },
}

/** 抓取通道展示元信息（设置页说明用；中英双语） */
export interface WebFetchChannelMeta {
  id: WebFetchChannelId
  label: string
  labelEn: string
  zh: string
  en: string
  /** 仅桌面端可用（手机 / 网页端没有隐藏浏览器） */
  desktopOnly?: boolean
  /** 需要 API Key 才能用（DeepSeek） */
  needsKey?: boolean
  /** 申请 Key / 文档地址 */
  docs?: string
}

export const WEB_FETCH_CHANNELS: WebFetchChannelMeta[] = [
  {
    id: 'direct',
    label: '直接访问',
    labelEn: 'Direct fetch',
    zh: '用内置 HTTP 客户端直接请求页面（带浏览器请求头）：HTML 转纯文本、识别并解析 PDF，速度最快。'
      + '遇到 403 / 人机验证页 / 空内容即算失败，交给下一通道。',
    en: 'Request the page directly with the built-in HTTP client (browser headers): HTML is converted to text and PDFs are parsed. Fastest. '
      + 'A 403 / bot-challenge page / empty body counts as a failure and falls through to the next channel.',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek Fetch（官方接口）',
    labelEn: 'DeepSeek Fetch (official API)',
    needsKey: true,
    zh: '调用 DeepSeek 官方 Fetch 接口，由服务端抓取并返回 Markdown 正文，能处理一部分直接访问被拦的页面；'
      + '需 API Key，按成功请求次数计费（约 5 元 / 1000 次），QPS 5。',
    en: 'Calls the official DeepSeek Fetch API: the server fetches the page and returns Markdown, handling some pages that block direct access. '
      + 'Requires an API key, billed per successful request (about ¥5 / 1,000 requests), 5 QPS.',
    docs: 'https://api-docs.deepseek.com/zh-cn/guides/search',
  },
  {
    id: 'browser',
    label: '虚拟浏览器',
    labelEn: 'Virtual browser',
    desktopOnly: true,
    zh: '用隐藏的 Chromium 窗口加载页面（真实执行 JS，可通过部分反爬 / 人机验证挑战），再提取正文；'
      + '速度较慢、占用一个窗口，仅桌面端可用。',
    en: 'Loads the page in a hidden Chromium window (runs JavaScript, gets past some bot challenges) and extracts the text. '
      + 'Slower, uses a window, desktop only.',
  },
]

/** 取通道展示元信息（未知 id 回退直接访问） */
export function webFetchChannelMeta(id: string): WebFetchChannelMeta {
  return WEB_FETCH_CHANNELS.find((c) => c.id === id) || WEB_FETCH_CHANNELS[0]
}

/** 归一化 DeepSeek Fetch 配置（缺字段回退默认；旧版 Anthropic base 自动迁移） */
export function normalizeDeepSeekFetchConfig(raw: any): DeepSeekFetchConfig {
  const base = DEFAULT_WEB_FETCH_CONFIG.deepseek
  const patch = raw && typeof raw === 'object' ? raw : {}
  const out: DeepSeekFetchConfig = { ...base }
  for (const key of ['apiKey', 'apiKeyRef'] as const) {
    if (typeof patch[key] === 'string') out[key] = patch[key]
  }
  out.apiHost = normalizeDeepSeekApiHost(
    typeof patch.apiHost === 'string' && patch.apiHost.trim() ? patch.apiHost : base.apiHost,
  )
  if (typeof patch.reuseChatKey === 'boolean') out.reuseChatKey = patch.reuseChatKey
  return out
}

/**
 * 归一化配置：
 * - `order` 只保留合法 id 并去重，缺失的通道补到末尾（不打断用户已排好的顺序）；
 * - `channels` 缺字段取默认；**全部关闭时强制打开 direct**（否则 web_fetch 无通道可用，
 *   而工具本身仍然存在，模型只会拿到一句“没有可用通道”的报错）；
 * - DeepSeek 配置走 `normalizeDeepSeekFetchConfig`。
 */
export function normalizeWebFetchConfig(raw: any): WebFetchConfig {
  const src = raw && typeof raw === 'object' ? raw : {}
  const order: WebFetchChannelId[] = []
  for (const id of Array.isArray(src.order) ? src.order : []) {
    if (isWebFetchChannelId(id) && !order.includes(id)) order.push(id)
  }
  for (const id of WEB_FETCH_CHANNEL_IDS) if (!order.includes(id)) order.push(id)

  const rawChannels = src.channels && typeof src.channels === 'object' ? src.channels : {}
  const channels: WebFetchChannelFlags = {
    direct: typeof rawChannels.direct === 'boolean' ? rawChannels.direct : DEFAULT_WEB_FETCH_CONFIG.channels.direct,
    deepseek: typeof rawChannels.deepseek === 'boolean' ? rawChannels.deepseek : DEFAULT_WEB_FETCH_CONFIG.channels.deepseek,
    browser: typeof rawChannels.browser === 'boolean' ? rawChannels.browser : DEFAULT_WEB_FETCH_CONFIG.channels.browser,
  }
  if (!channels.direct && !channels.deepseek && !channels.browser) channels.direct = true

  return { order, channels, deepseek: normalizeDeepSeekFetchConfig(src.deepseek) }
}

/** 按配置顺序取出**已开启**的通道（主进程 / 渲染层执行者共用同一顺序） */
export function enabledWebFetchChannels(config: WebFetchConfig): WebFetchChannelId[] {
  const norm = normalizeWebFetchConfig(config)
  return norm.order.filter((id) => norm.channels[id])
}

/** 设置页「测试抓取」的返回（IPC webFetch:test；success 而非 ok，避免被 IPC 信封解包） */
export interface WebFetchTestResult {
  success: boolean
  url?: string
  /** 实际成功的通道（direct / deepseek / browser） */
  via?: string
  elapsedMs: number
  /** 正文长度（字符） */
  chars?: number
  /** 正文开头（用于人工确认抓到的是不是要的内容） */
  preview?: string
  error?: string
}
