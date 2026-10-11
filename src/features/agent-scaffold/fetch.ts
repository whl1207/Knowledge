/**
 * fetch.ts — urls 源的网页抓取工具（Step 3，移植自 CollectWeb/collectWebAgent.ts）
 *
 * 职责：只做“把 URL 变成可分析内容”的纯工具，不持有任何状态：
 *   fetchPage            抓取（超时 / User-Agent / 跟随重定向）
 *   filterHtmlToText     HTML → 清洗正文（去脚本样式标签、实体、短碎片）
 *   extractLinksFromHtml 解析 <a> 卡片（锚文本 + 绝对 URL；含裸域名补协议修复）
 *   normalizeUrl         去 hash 与跟踪参数（visited 去重键；与旧实现一致）
 *   extractPageTitle     提取 <title>
 *
 * 设计说明（与「链接即字段」模型配套）：
 *   一页 = 一个任务行；页面里发现的链接 = 该行的 `links` 字段（URL 逐行存放）。
 *   抓取阶段同时产出：title → 行字段；links → 行字段 + 行元数据 discoveredLinks（供 runner 扩展 frontier）。
 */

/** 页面链接字段名（“链接即字段”：每行一条 URL，\n 分隔） */
export const PIPELINE_LINKS_FIELD = 'links'
/** 页面标题字段名 */
export const PIPELINE_TITLE_FIELD = 'title'
/**
 * 网页地址字段名（默认值）：文本源默认字段为 text、链接采集预设为 url；
 * 实际字段名由 config.textFieldName / contentField 决定（见 types.resolveContentField）。
 */
export const PIPELINE_URL_FIELD = 'url'

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export interface FetchPageResult {
  ok: boolean
  /** 原始响应文本（JSON 会格式化） */
  raw?: string
  error?: string
}

/** 抓取网页（渲染层 fetch；主窗口已关闭 webSecurity，跨域可用） */
export async function fetchPage(url: string, opts?: { timeoutSec?: number; userAgent?: string }): Promise<FetchPageResult> {
  const timeoutSec = Math.max(5, Number(opts?.timeoutSec) || 30)
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutSec * 1000)
    const response = await fetch(url, {
      headers: {
        'User-Agent': opts?.userAgent || DEFAULT_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
      credentials: 'include',
      redirect: 'follow',
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status} ${response.statusText}` }
    }
    const contentType = response.headers.get('content-type') || ''
    let content: string
    if (contentType.includes('application/json')) {
      const json = await response.json()
      content = JSON.stringify(json, null, 2)
    } else {
      content = await response.text()
    }
    return { ok: true, raw: content }
  } catch (error: any) {
    const msg = error?.name === 'AbortError' ? `超时（>${timeoutSec}s）` : (error?.message || String(error))
    return { ok: false, error: msg }
  }
}

/** HTML → 清洗正文（移植自 CollectWeb.filterContent，行为逐位一致） */
export function filterHtmlToText(html: string): string {
  if (!html) return ''
  let content = html
  // 移除 script / style
  content = content.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
  content = content.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
  // 移除 HTML 标签
  content = content.replace(/<[^>]*>/g, ' ')
  // 处理 HTML 实体
  content = content.replace(/&nbsp;/g, ' ')
  content = content.replace(/&lt;/g, '<')
  content = content.replace(/&gt;/g, '>')
  content = content.replace(/&amp;/g, '&')
  content = content.replace(/&quot;/g, '"')
  content = content.replace(/&#39;/g, "'")
  content = content.replace(/&[a-z]+;/g, ' ')
  // 压缩空格
  content = content.replace(/\s+/g, ' ').trim()
  // 保护邮件地址不被后续按句切分破坏
  const emailMap: string[] = []
  content = content.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, (m) => {
    emailMap.push(m)
    return `__EMAIL${emailMap.length}__`
  })
  // 按句切分，丢弃 ≤10 字符的碎片（导航残留等噪音）
  const sentences = content.split(/([。！？!?])/g)
  const meaningful: string[] = []
  for (let i = 0; i < sentences.length; i++) {
    let sentence = sentences[i].trim()
    sentence = sentence.replace(/__EMAIL(\d+)__/g, (_, id) => emailMap[parseInt(id) - 1] || '')
    if (sentence.length > 10) meaningful.push(sentence)
  }
  return meaningful.join(' ')
}

export interface PageLink {
  url: string
  text: string
}

/**
 * 解析页面链接（移植自 CollectWeb.extractLinks）：
 * - 锚文本去标签、截断 100 字符；空锚文本记 '(无文字)'
 * - 跳过 # / javascript: / mailto:
 * - 裸域名（www.x.com / x.com/y）自动补 https:，避免被当成相对路径
 * - 按关键词（可选）相关度排序，重要链接在前
 */
export function extractLinksFromHtml(html: string, baseUrl: string, keywords = ''): PageLink[] {
  const links: PageLink[] = []
  const seen = new Set<string>()
  const linkRegex = /<a\s+([^>]*?)href=["']([^"']*)["']([^>]*?)>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[2]
    let linkText = match[4].replace(/<[^>]*>/g, '').trim().substring(0, 100)
    if (!linkText) linkText = '(无文字)'
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) continue
    try {
      let resolvedHref = href
      if (/^www\./i.test(href)) {
        resolvedHref = 'https://' + href
      } else if (!/^[./]/.test(href) && /^[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,}(?:\/|$)/.test(href)) {
        resolvedHref = 'https://' + href
      }
      const fullUrl = new URL(resolvedHref, baseUrl).href
      if (fullUrl.startsWith('http://') || fullUrl.startsWith('https://')) {
        if (!seen.has(fullUrl)) {
          seen.add(fullUrl)
          links.push({ url: fullUrl, text: linkText })
        }
      }
    } catch { /* 忽略无效 URL */ }
  }
  const kws = String(keywords || '').split(',').map(k => k.trim()).filter(Boolean)
  if (kws.length) {
    links.sort((a, b) => {
      let sa = 0, sb = 0
      for (const kw of kws) {
        if (a.text.includes(kw) || a.url.includes(encodeURIComponent(kw))) sa++
        if (b.text.includes(kw) || b.url.includes(encodeURIComponent(kw))) sb++
      }
      return sb - sa
    })
  }
  return links
}

/** 去 hash 与跟踪参数（去重键；移植自 CollectWeb.normalizeUrl，行为逐位一致） */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    const trackParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'source']
    for (const param of trackParams) {
      parsed.searchParams.delete(param)
    }
    return parsed.toString()
  } catch {
    return url
  }
}

/** 主机名（用于同域跟随策略） */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}

/** 提取 <title>（移植自 CollectWeb.extractTitle） */
export function extractPageTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return match ? match[1].trim().substring(0, 80) : ''
}

/** 链接字段值（\n 分隔的 URL 文本）→ 数组 */
export function parseLinksField(value: any): string[] {
  return String(value ?? '').split(/\r?\n/).map(s => s.trim()).filter(s => /^https?:\/\//i.test(s))
}

/** 链接清单展示文本（urlBody='links' 模式与提示用；含锚文本） */
export function formatLinkList(links: PageLink[]): string {
  return links.map((l, i) => `${i + 1}. ${l.text || '(无文字)'} | ${l.url}`).join('\n')
}
