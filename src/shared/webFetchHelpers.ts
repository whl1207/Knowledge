/**
 * webFetchHelpers.ts — 网页抓取辅助（渲染进程 + 主进程共享）
 *
 * 解决「目标站点返回反爬/人机验证页（HTTP 200 但内容是验证提示）」的场景：
 * - `isBotChallengePage()` 识别常见 WAF / Cloudflare / 人机验证特征；
 * - `extractDoiFromUrl()` 从 URL 提取 DOI（doi.org 或裸 DOI）；
 * - `fetchDoiViaCrossref()` 用 Crossref 公共 API 降级获取 DOI 元数据
 *   （标题/作者/期刊/年份/页码/摘要），绕过目标站点的验证墙。
 *
 * 注意：本模块供渲染进程（src/）与主进程（electron/main/）共用，
 * 因此禁止依赖 DOM / Node 专有 API，只使用标准 fetch / URL / 正则。
 */

/** 常见反爬验证页特征（命中任一即视为验证页） */
const CHALLENGE_PATTERNS: RegExp[] = [
  // 中文 WAF / 人机验证
  /人机识别检测/,
  /人机验证/,
  /人机身份验证/,
  /安全验证/,
  /验证码/,
  /请稍等片刻，即将为您加载/,
  /即将为您加载访问页面/,
  /访问请求进行人机识别/,
  /web\s*应用防火墙/i,
  // Cloudflare / 通用英文反爬
  /just a moment\.\.\./i,
  /checking your browser/i,
  /attention required/i,
  /verify you are human/i,
  /verify you are not a robot/i,
  /cloudflare.*captcha/i,
  /__cf_chl/i,
  /cf-chl-/i,
  /challenge-platform/i,
  /cf-challenge/i,
  /turnstile/i,
  /g-recaptcha/i,
  /access denied/i,
]

/** 判断抓取到的文本是否是一个反爬验证页（而非真实内容） */
export function isBotChallengePage(text: string): boolean {
  if (!text || text.trim().length === 0) return false
  // 验证页通常很短；但为稳妥仍以特征词为准
  return CHALLENGE_PATTERNS.some((re) => re.test(text))
}

/**
 * 从 URL / 字符串中提取 DOI（支持 doi.org、doi: 前缀、裸 DOI）。
 * 示例：
 *   https://doi.org/10.1177/13860291251313579 → 10.1177/13860291251313579
 *   https://dx.doi.org/10.1000/xyz → 10.1000/xyz
 *   doi:10.1000/xyz → 10.1000/xyz
 *   10.1000/xyz → 10.1000/xyz
 */
export function extractDoiFromUrl(url: string): string | null {
  if (!url) return null
  const m = url.match(/(?:doi\.org\/|dx\.doi\.org\/|doi:\s*|^)(10\.\d{4,9}\/[^\s?#<>"']+)/i)
  if (!m) return null
  try {
    return decodeURIComponent(m[1])
  } catch {
    return m[1]
  }
}

/** 剥掉 XML/JATS 标签并压缩空白 */
function stripTags(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 将 Crossref JSON 的 message 对象格式化为可读文本 */
function formatCrossrefMessage(m: any): string {
  const lines: string[] = []
  const title = Array.isArray(m?.title) ? m.title[0] : ''
  if (title) lines.push(`标题: ${title}`)
  const authors: string[] = []
  if (Array.isArray(m?.author)) {
    for (const a of m.author) {
      const name = `${a?.given || ''} ${a?.family || ''}`.trim()
      if (name) authors.push(name)
    }
  }
  if (authors.length) lines.push(`作者: ${authors.join('; ')}`)
  if (Array.isArray(m?.['container-title']) && m['container-title'][0]) lines.push(`期刊: ${m['container-title'][0]}`)
  const year = m?.issued?.['date-parts']?.[0]?.[0]
  if (year) lines.push(`年份: ${year}`)
  if (m?.volume) lines.push(`卷: ${m.volume}`)
  if (m?.issue) lines.push(`期: ${m.issue}`)
  if (m?.page) lines.push(`页码: ${m.page}`)
  if (m?.abstract) lines.push(`摘要: ${stripTags(m.abstract)}`)
  if (m?.DOI) lines.push(`DOI: ${m.DOI}`)
  return lines.join('\n')
}

/**
 * 通过 Crossref 公共 API 获取 DOI 的元数据（无需 API key）。
 * 优先用 JSON works 接口（结构化、稳定）；若拿不到再退回 transform 全文接口。
 * 成功返回格式化文本；失败返回空字符串。
 */
export async function fetchDoiViaCrossref(doi: string, signal?: AbortSignal): Promise<string> {
  const encoded = encodeURIComponent(doi)
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  }

  // 通道 1：works JSON 接口（含标题/作者/期刊/年份/摘要）
  try {
    const res = await fetch(`https://api.crossref.org/v1/works/${encoded}`, {
      headers: { ...headers, Accept: 'application/json' },
      signal,
    })
    if (res.ok) {
      const json: any = await res.json()
      const msg = json?.message
      if (msg && (Array.isArray(msg.title) ? msg.title[0] : msg.title)) {
        const formatted = formatCrossrefMessage(msg)
        if (formatted) return formatted
      }
    }
  } catch {
    /* 尝试下一通道 */
  }

  // 通道 2：transform 全文/记录接口（XML）
  try {
    const res = await fetch(`https://api.crossref.org/v1/works/${encoded}/transform`, {
      headers: { ...headers, Accept: 'application/vnd.crossref.unixref+xml' },
      signal,
    })
    if (res.ok) {
      const xml = await res.text()
      const text = stripTags(xml)
      if (text.length > 50) return text.slice(0, 20000)
    }
  } catch {
    /* 忽略 */
  }

  return ''
}
