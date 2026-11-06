/**
 * htmlToMarkdown.ts — HTML → Markdown 正文转换（web_fetch 的两条本地通道共用）
 *
 * 背景：`web_fetch` 以前在本地通道里用正则剥标签取纯文本（`<[^>]+>` → 空格），
 * `<a href>` 连同 URL 一起丢掉 —— 模型拿到的是「看得见文字、看不见链接」的正文，
 * 想顺着页面里的链接再抓一步就没有地址可用。
 *
 * 现在参照 DSH 的 `@deepseek-ai/dsh-tool-web`：turndown 把 HTML 转成 Markdown，
 * 链接保留为 `[文字](URL)`、图片保留为 `![alt](src)`，标题 / 列表 / 引用 / 代码块 / 表格
 * 都带结构。转换规则与 DSH 对齐的点：
 * - `headingStyle: atx` / `codeBlockStyle: fenced` / `bulletListMarker: '-'`；
 * - 整块丢弃不可见与活动内容（script/style/noscript/template/iframe/object/embed、
 *   `hidden`、`aria-hidden="true"`、`display:none` / `visibility:hidden`）；
 * - 表格按 GFM 管道表格输出（含表头分隔行与对齐标记）；
 * - 嵌套过深（默认 512 层）时放弃转换 —— turndown 对超深 DOM 是超线性的，
 *   同步转换会卡住主进程事件循环。
 *
 * 与 DSH 的两处有意差异（都是 ai-km 自己的既有约定，见 `electron/main/browser-agent.ts`
 * 的 extractMarkdown）：
 * - 相对 URL 按 `baseUrl`（页面最终地址 / `<base href>`）绝对化 —— ai-km 的 web_fetch
 *   只接受 http(s) 绝对地址，把 `/domains` 原样交给模型等于给了一个必然失败的下一次调用；
 * - `javascript:` / `data:` / 纯 `#` 锚点降级为纯文字，避免死链和超长 data URI。
 *
 * 转换失败（超深嵌套 / turndown 抛错）时回退到旧的纯文本剥离，绝不把原始 HTML 交给模型。
 */

import TurndownService from 'turndown'

export interface HtmlToMarkdownOptions {
  /** 页面地址：相对 href/src 按它绝对化（省略时保持原样） */
  baseUrl?: string
  /** 转换前的源字符上限（默认 200k，与 DSH 的 fetchMaxOutputChars 同量级） */
  maxHtmlChars?: number
  /** 嵌套深度上限（默认 512 层） */
  maxDepth?: number
}

const DEFAULT_MAX_HTML_CHARS = 200_000
const DEFAULT_MAX_DEPTH = 512

/** 整块丢弃：不可见或会执行/嵌入外部内容 */
const REMOVED_TAG_NAMES = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED'])

/** 没有闭合标签的元素（深度统计时不算一层） */
const VOID_TAG_NAMES = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img',
  'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/** 文本节点里的空白压缩成单个空格（链接文字里绝不能留换行，否则 Markdown 结构会断） */
function collapse(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 相对地址 → 绝对地址。
 * 返回空串表示「这个地址没有引用价值」：`javascript:` / `data:` / 纯锚点，
 * 以及无法解析的地址（调用方据此把链接降级为纯文字）。
 */
function absoluteUrl(raw: string, baseUrl: string): string {
  const value = String(raw ?? '').trim()
  if (!value) return ''
  if (/^(?:javascript|vbscript|data|file):/i.test(value)) return ''
  if (value.startsWith('#')) return ''
  if (!baseUrl) return value
  try {
    return new URL(value, baseUrl).href
  } catch {
    return ''
  }
}

/** 页面里的 `<base href>` 优先于传入的 baseUrl（浏览器就是这么解析的） */
function resolveBase(html: string, baseUrl: string): string {
  const match = /<base\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(html)
  const declared = (match?.[1] || match?.[2] || match?.[3] || '').trim()
  if (!declared) return baseUrl
  if (!baseUrl) return declared
  try {
    return new URL(declared, baseUrl).href
  } catch {
    return baseUrl
  }
}

/**
 * 保守地判断 HTML 是否嵌套过深。
 *
 * 只做「安全网」用途：注释与 raw-text 元素（script/style/noscript/template）先剔除，
 * 再按标签名压栈计数。畸形 HTML 会多算而不是少算 —— 宁可退回纯文本，也不让
 * 主进程在一次同步转换里卡住几秒。
 */
function exceedsDepth(html: string, maxDepth: number): boolean {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
  const tagRe = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g
  let depth = 0
  let match: RegExpExecArray | null
  while ((match = tagRe.exec(stripped)) !== null) {
    if (match[1] === '/') {
      depth = Math.max(0, depth - 1)
      continue
    }
    const name = match[2].toLowerCase()
    const attrs = match[3] || ''
    if (VOID_TAG_NAMES.has(name) || /\/\s*$/.test(attrs)) continue
    depth += 1
    if (depth > maxDepth) return true
  }
  return false
}

/** 单元格在行里的列号（domino 的 th/td 不一定带 cellIndex，故按行的 cells 集合反查） */
function cellIndexOf(node: any): number {
  const parent = node?.parentNode
  const cells = parent?.cells
  if (cells) {
    const index = Array.prototype.indexOf.call(cells, node)
    if (index >= 0) return index
  }
  let index = 0
  let prev = node?.previousElementSibling
  while (prev) {
    index += 1
    prev = prev.previousElementSibling
  }
  return index
}

/** 一个 GFM 表格单元格：转义竖线、换行压成 `<br>`（GFM 单元格内不能有真换行） */
function renderTableCell(content: string, index: number): string {
  const text = collapse(String(content ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')) || ' '
  return `${index === 0 ? '| ' : ' '}${text} |`
}

/** 单元格对齐 → GFM 分隔行标记 */
function tableBorder(cell: any): string {
  const align = String(cell?.getAttribute?.('align') || cell?.style?.textAlign || '').toLowerCase()
  if (align === 'left') return ':---'
  if (align === 'right') return '---:'
  if (align === 'center') return ':---:'
  return '---'
}

/** 构造一个绑定了 baseUrl 的转换器（每次调用新建，规则闭包着 baseUrl，天然并发安全） */
function createService(baseUrl: string): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  })

  // 不可见 / 会执行的元素：整块丢掉（turndown 默认会保留它们的文字）
  service.addRule('removeNonVisibleContent', {
    filter(node: any) {
      if (REMOVED_TAG_NAMES.has(node.nodeName)) return true
      if (node.hasAttribute?.('hidden')) return true
      if (String(node.getAttribute?.('aria-hidden') || '').toLowerCase() === 'true') return true
      if (node.nodeName === 'INPUT' && String(node.getAttribute?.('type') || '').toLowerCase() === 'hidden') return true
      const style = String(node.getAttribute?.('style') || '')
      return style.split(';').some((declaration) => {
        const separator = declaration.indexOf(':')
        if (separator === -1) return false
        const property = declaration.slice(0, separator).trim().toLowerCase()
        const value = declaration.slice(separator + 1).trim().toLowerCase().replace(/\s*!important\s*$/, '')
        return (property === 'display' && value === 'none')
          || (property === 'visibility' && (value === 'hidden' || value === 'collapse'))
      })
    },
    replacement() {
      return ''
    },
  })

  // 链接：绝对化 + 死链降级为纯文字（不给模型一个必然 404 的下一次调用）
  service.addRule('linkWithAbsoluteHref', {
    filter(node: any) {
      return node.nodeName === 'A' && !!node.getAttribute?.('href')
    },
    replacement(content: string, node: any) {
      const href = absoluteUrl(node.getAttribute('href'), baseUrl)
      const text = collapse(content)
      if (!href) return text
      if (!text) return href // 纯图标链接：文字为空，只留地址
      return `[${text}](${href})`
    },
  })

  // 图片：同样绝对化；alt 保留（模型靠它判断这张图值不值得再看）
  service.addRule('imageWithAbsoluteSrc', {
    filter(node: any) {
      return node.nodeName === 'IMG'
    },
    replacement(_content: string, node: any) {
      const src = absoluteUrl(node.getAttribute?.('src') || node.getAttribute?.('data-src'), baseUrl)
      if (!src) return ''
      const alt = collapse(node.getAttribute?.('alt') || '')
      return `![${alt}](${src})`
    },
  })

  // 表格：GFM 管道表格（turndown 默认没有表格规则，会把单元格压成一行行文字）
  service.addRule('gfmTableCell', {
    filter: ['th', 'td'],
    replacement(content: string, node: any) {
      return renderTableCell(content, cellIndexOf(node))
    },
  })

  service.addRule('gfmTableRow', {
    filter: 'tr',
    replacement(content: string, node: any) {
      const cells: any[] = Array.from(node.cells || [])
      if (!cells.length) return ''
      const section = node.parentElement
      const table = section?.parentElement
      const heading = (section?.nodeName === 'THEAD' || (table?.rows && table.rows[0] === node))
        && cells.every((cell: any) => cell.nodeName === 'TH')
      const border = heading ? cells.map((cell: any, index: number) => renderTableCell(tableBorder(cell), index)).join('') : ''
      return `\n${content}${border ? `\n${border}` : ''}`
    },
  })

  return service
}

/** 转换失败时的兜底：旧的正则剥标签（宁可没有链接，也不能没有正文） */
function plainTextFallback(html: string): string {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 收尾：去掉行尾空白与多余空行（Markdown 里连续空行没有意义，只会浪费 token） */
function tidy(markdown: string): string {
  return String(markdown ?? '')
    .replace(/[ \t]+\n/g, '\n')
    // 表格行之间不能有空行：GFM 里空行会把表头和表体切成两张表（表体就没有表头了）
    .replace(/\|\n{2,}\|/g, '|\n|')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 把一段 HTML 转成给模型看的 Markdown 正文。
 *
 * @param html 原始 HTML（可以是不完整的片段；turndown 自带容错解析）
 * @param options baseUrl / 源字符上限 / 嵌套深度上限
 * @returns Markdown 正文；输入为空时返回空串
 */
export function htmlToMarkdown(html: string, options: HtmlToMarkdownOptions = {}): string {
  const raw = String(html ?? '')
  if (!raw.trim()) return ''

  const maxChars = Number(options.maxHtmlChars) > 0 ? Number(options.maxHtmlChars) : DEFAULT_MAX_HTML_CHARS
  const source = raw.length > maxChars ? raw.slice(0, maxChars) : raw
  const maxDepth = Number(options.maxDepth) > 0 ? Number(options.maxDepth) : DEFAULT_MAX_DEPTH

  // 超深嵌套不转换：同步转换会阻塞事件循环（DSH 实测 20k 层约 5 秒）
  if (exceedsDepth(source, maxDepth)) return plainTextFallback(source)

  try {
    return tidy(createService(resolveBase(source, String(options.baseUrl || '').trim())).turndown(source))
  } catch {
    return plainTextFallback(source)
  }
}
