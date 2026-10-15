/**
 * webSearchFirecrawl.ts — Firecrawl 搜索源的**请求组装 / 响应解析 / 错误翻译**（纯逻辑，
 * 主进程与渲染层共用，可被自测覆盖）
 *
 * 为什么单独成文件：这两半逻辑要在**两处**跑（桌面走主进程 `electron/main/tools.ts`，
 * 手机 / 网页走渲染层 `src/lib/agent/webSearchRunner.ts`）。抄两份的话，改一处忘一处就会
 * 出现"桌面能搜、手机搜不到"这类只有特定端才复现的问题；而且混在含 Electron 依赖的模块里
 * 根本没法自测。范式同 `src/lib/agent/deepseekSearch.ts`：纯函数 + 自测。
 *
 * 与其它搜索源最关键的差别：**apiKey 可以留空**。留空时**绝不能**发 `Authorization` 头，
 * 否则 Firecrawl 会把无鉴权请求当成"无效 Key"拒掉，免 Key 通道直接失效。
 */

import type { WebSearchItem } from './webSearch'

/** Firecrawl 官方默认地址（免 Key 通道就在这里） */
export const FIRECRAWL_DEFAULT_HOST = 'https://api.firecrawl.dev'

/**
 * 请求体里的 `timeout` 是**服务端**搜索超时（官方契约 1000~300000 ms）。
 * 取 20s 略小于本地 HTTP 超时（25s），让"服务端先放弃"表现为一条可读错误而不是本地超时。
 */
export const FIRECRAWL_SERVER_TIMEOUT_MS = 20_000

/** 单次搜索最多要几条（AI-KM 设置页上限 20，这里再兜一层） */
export const FIRECRAWL_MAX_LIMIT = 20

/** 归一化接口地址：去尾斜杠；缺协议时补 https（Firecrawl 是公网服务，不是内网 IP） */
function normalizeFirecrawlHost(raw: string): string {
  let s = String(raw || '').trim().replace(/\/+$/, '')
  if (!s) return FIRECRAWL_DEFAULT_HOST
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`
  return s
}

/** 请求条数收敛到 1~20（配置本身已收敛，这里防调用方直接传值） */
function clampLimit(raw: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 10
  return Math.min(FIRECRAWL_MAX_LIMIT, Math.max(1, Math.round(n)))
}

/** 组装好的请求（调用方直接喂给 fetch） */
export interface FirecrawlRequest {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
}

/**
 * 组装 Firecrawl 搜索请求。
 * `apiKey` 留空 = 免 Key 模式：**不加** Authorization 头（见文件头说明）。
 */
export function buildFirecrawlSearchRequest(opts: {
  query: string
  maxResults?: number
  apiHost?: string
  apiKey?: string
}): FirecrawlRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const apiKey = String(opts.apiKey || '').trim()
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  return {
    url: `${normalizeFirecrawlHost(String(opts.apiHost || ''))}/v2/search`,
    method: 'POST',
    headers,
    body: JSON.stringify({
      query: String(opts.query ?? ''),
      limit: clampLimit(Number(opts.maxResults)),
      sources: ['web'],
      timeout: FIRECRAWL_SERVER_TIMEOUT_MS,
    }),
  }
}

/**
 * 解析 Firecrawl 搜索响应 → 统一结果形状。
 *
 * 形状：`{ success, data: { web: [{ title, description, url }] }, creditsUsed }`
 *
 * 两处刻意的宽容：
 * - `success === false` 直接抛错（而不是当成"0 条结果"）——否则模型会以为"网上没有"；
 * - 标题为空时用 URL 兜底：Firecrawl 偶尔只给链接不要标题，直接丢掉等于白花额度。
 */
export function parseFirecrawlSearchResponse(data: any, maxResults = 10): WebSearchItem[] {
  if (data?.success === false) {
    throw new Error(`Firecrawl 返回失败：${data?.error || data?.message || '未知原因'}`)
  }
  const web = Array.isArray(data?.data?.web) ? data.data.web : []
  const limit = clampLimit(maxResults)
  const out: WebSearchItem[] = []
  for (const r of web) {
    const url = String(r?.url || '').trim()
    if (!/^https?:\/\//i.test(url)) continue
    const title = String(r?.title || '').trim() || url
    out.push({ title, url, snippet: String(r?.description || '').trim() })
    if (out.length >= limit) break
  }
  return out
}

/**
 * Firecrawl 错误的人话版本。
 *
 * 免 Key 模式最容易踩的是**额度 / 限流**（keyless 免费额度按 IP 计量），
 * 但 HTTP 层只会给出一个裸的 `HTTP 402/429`。这里把它翻成"下一步该做什么"，
 * 否则用户只会看到"搜索失败"而不知道去申请免费 Key。
 * 自己填了 Key 的请求不追加这句——那是用户自己的额度问题，不是共享 IP 的问题。
 */
export function firecrawlErrorMessage(e: any, hasKey: boolean): string {
  const msg = String(e?.message || e)
  const status = Number((msg.match(/HTTP (\d{3})/) || [])[1] || 0)
  if (!hasKey && (status === 401 || status === 403 || status === 402 || status === 429)) {
    return `${msg} —— 免 Key 额度可能已用尽或被限流（按 IP 计量，约 1000 credits/月）：`
      + '可稍后重试，或到 https://firecrawl.dev 申请免费 Key 填到本搜索源'
  }
  return msg
}
