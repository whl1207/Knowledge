/**
 * .docx → Markdown 转换（mammoth + turndown），主进程统一入口
 *
 * 供三处复用，避免各写一份、行为漂移：
 *  - `index.ts` 的 `readFile`（本地 .docx 预览 / 编辑取文）
 *  - `index.ts` 的 `docxToMarkdown` IPC（远程 .docx 预览）
 *  - `tools.ts` 的 `parseDocxFile`（工具读取 Word 正文）
 *
 * 关键点（勿轻易回退为 turndown 默认值）：
 * 1. `headingStyle: 'atx'`：turndown 默认是 setext（`===` / `---`），会让 Word 的
 *    「标题 1 / 标题 2」（mammoth → h1/h2）变成 setext 标题；
 *    而阅读器目录按 `#` 级别的 atx 标题解析 → 目录收不到这些标题、且索引错位。
 * 2. 自实现 GFM 表格规则：turndown 本体不支持 table，会把整个表格的单元格文本
 *    平铺成一串普通段落（用户反馈「Word 表格显示不正常」的根因）。
 *    这里直接把 `<table>` 渲染为 `| a | b |` 管道表格；Word 表格常常没有表头
 *    标记（无 `<thead>`），此时把首行提升为表头，保证 markdown-it 能解析成表格。
 * 3. 图片不再丢弃：mammoth 提取后写入缓存目录（`mediaDir`），Markdown 里只放 `file:///`
 *    短引用 —— 标签内容会持久化到 localStorage，内联 base64 会撑爆配额；
 *    EMF/WMF/TIFF 等浏览器无法显示的格式仍丢弃（预览里不会有破图）。
 * 4. 转换前调用 `restoreDocxHeadingNumbers` 把 Word 自动编号（含挂在标题样式上的
 *    多级编号）回填为标题文字前缀 —— 否则 mammoth 命中 h1..h6 映射后会丢掉编号；
 *    再调用 `restoreDocxMath` 把 OMML 公式转成 `$latex$`（mammoth 完全不支持公式）。
 */
import mammoth from 'mammoth'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import TurndownService from 'turndown'
import { restoreDocxHeadingNumbers } from './docx-numbering'
import { restoreDocxMath, applyMathPlaceholders } from './docx-math'
import { asUint8 } from '../buffer-view'

export interface DocxToMarkdownInput {
  /** 本地文件路径（与 buffer 二选一） */
  filePath?: string
  /** 文件内容（远程预览用，与 filePath 二选一） */
  buffer?: Buffer
  /**
   * 图片缓存目录（默认 `${os.tmpdir()}/ai-km-docx-media`）。
   * 主进程调用方应传 userData 下的持久目录：Word 标签内容会持久化到 localStorage，
   * 若把图片内联成 base64 会撑爆配额，所以图片落盘、Markdown 里只留 file:/// 短引用。
   */
  mediaDir?: string
  /** 是否提取图片（默认 true）；仅需纯文本的场景（如工具读取正文）可设为 false */
  extractImages?: boolean
}

/** 浏览器可显示的图片类型（EMF/WMF/TIFF 等 Word 常见格式无法在 Chromium 显示，直接丢弃） */
const WEB_IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/x-png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
}

/** 单张图片大小上限（超过则丢弃，避免超大图拖垮预览） */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
/** 图片缓存目录数量上限（超出按最旧淘汰） */
const MEDIA_MAX_DIRS = 200

/** 本地路径 → file:/// URL（中文/空格等做 URI 编码） */
function toFileUrl(p: string): string {
  const normalized = p.replace(/\\/g, '/')
  const withRoot = normalized.startsWith('/') ? normalized : '/' + normalized
  return 'file://' + encodeURI(withRoot).replace(/#/g, '%23')
}

/** 缓存目录按数量淘汰（老的先删），避免无限增长 */
function pruneMediaRoot(root: string): void {
  try {
    const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
    if (dirs.length <= MEDIA_MAX_DIRS) return
    const withTime = dirs.map((d) => {
      let t = 0
      try { t = fs.statSync(path.join(root, d.name)).mtimeMs } catch { /* ignore */ }
      return { name: d.name, t }
    })
    withTime.sort((a, b) => a.t - b.t)
    for (const d of withTime.slice(0, withTime.length - MEDIA_MAX_DIRS)) {
      fs.rmSync(path.join(root, d.name), { recursive: true, force: true })
    }
  } catch {
    /* 淘汰失败不影响转换 */
  }
}

/** 文档缓存键：路径 + 内容哈希（内容变了换目录，避免旧图串到新文档） */
function mediaDocKey(input: DocxToMarkdownInput, raw: Buffer): string {
  const h = crypto.createHash('sha1')
  if (input.filePath) h.update('path:' + path.resolve(input.filePath))
  h.update(asUint8(raw))
  return h.digest('hex').slice(0, 16)
}

/** mammoth 图片回调：把可显示图片写到缓存目录，返回 file:/// 引用；其余一律丢弃 */
function createImageHandler(mediaRoot: string, docKey: string) {
  const dir = path.join(mediaRoot, docKey)
  let index = 0
  return (mammoth.images as any).imgElement(async (image: any) => {
    try {
      const ext = WEB_IMAGE_EXT[String(image?.contentType || '').toLowerCase()]
      // 返回空 src 而不是 null：mammoth 生成 <img> 时对 null 属性会直接抛错
      if (!ext) return { src: '' }
      const base64 = await image.read('base64')
      const data = Buffer.from(String(base64 || ''), 'base64')
      if (!data.length || data.length > MAX_IMAGE_BYTES) return { src: '' }
      fs.mkdirSync(dir, { recursive: true })
      index++
      const file = path.join(dir, `image${index}.${ext}`)
      fs.writeFileSync(file, asUint8(data))
      return { src: toFileUrl(file) }
    } catch {
      return { src: '' }
    }
  })
}

function nodeName(node: any): string {
  return String(node?.nodeName || '').toUpperCase()
}

/** 单元格内容 → 单行 Markdown 文本（换行折叠、竖线转义） */
function cellToMarkdown(service: TurndownService, cell: any): string {
  let text = ''
  try {
    text = service.turndown(String(cell.innerHTML ?? ''))
  } catch {
    text = String(cell.textContent ?? '')
  }
  return text
    .replace(/\s*\n+\s*/g, ' ') // 单元格内换行 → 空格（管道表格不支持多行单元格）
    .replace(/\|/g, '\\|')       // 竖线转义，避免破坏表格结构
    .trim()
}

/**
 * `<table>` → GFM 管道表格
 * - 递归收集所有 tr（兼容 thead/tbody/tfoot 与直接子节点）
 * - 首行作为表头（Word 常无表头标记，首行提升为表头最稳）
 * - colspan：补空列占位，保证每行列数一致（Markdown 无合并单元格）
 */
function tableToMarkdown(table: any, service: TurndownService): string {
  const rows: any[] = []
  const collectRows = (el: any) => {
    for (const child of Array.from(el?.childNodes || []) as any[]) {
      const name = nodeName(child)
      if (name === 'TR') rows.push(child)
      else if (name === 'THEAD' || name === 'TBODY' || name === 'TFOOT') collectRows(child)
    }
  }
  collectRows(table)
  if (rows.length === 0) return ''

  const matrix: string[][] = rows.map((tr) => {
    const cells: string[] = []
    for (const cell of Array.from(tr?.childNodes || []) as any[]) {
      const name = nodeName(cell)
      if (name !== 'TD' && name !== 'TH') continue
      cells.push(cellToMarkdown(service, cell))
      const span = Math.max(1, parseInt(String(cell?.getAttribute?.('colspan') || '1'), 10) || 1)
      for (let i = 1; i < span; i++) cells.push('')
    }
    return cells
  })

  const cols = matrix.reduce((max, r) => Math.max(max, r.length), 0)
  if (cols === 0) return ''
  const pad = (r: string[]): string[] => {
    const out = r.slice(0, cols)
    while (out.length < cols) out.push('')
    return out
  }

  const header = pad(matrix[0])
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
  ]
  for (let i = 1; i < matrix.length; i++) lines.push(`| ${pad(matrix[i]).join(' | ')} |`)
  return `\n\n${lines.join('\n')}\n\n`
}

/** 创建统一配置的 turndown 实例（含 GFM 表格规则） */
export function createTurndownService(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',      // 标题必须为 `#` 形式（目录依赖）
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  })
  service.addRule('gfmTable', {
    filter: 'table',
    replacement: (_content: string, node: any) => tableToMarkdown(node, service),
  })
  return service
}

/**
 * 去掉标题行里多余的有序列表转义：
 * turndown 会把段首「2. 引用文档」转义成「2\. 引用文档」（防止被 Markdown 当成有序列表项），
 * 但 ATX 标题（`## 2. 引用文档`）本身不可能被解析成列表 —— 该转义只会在预览/导出/目录里
 * 露出反斜杠，故在标题行内还原。（正文段落中的转义必须保留）
 */
function unescapeHeadingListMarkers(markdown: string): string {
  return markdown.replace(/^(#{1,6}\s+)(\d+)\\\.\s/gm, '$1$2. ')
}

/** HTML → Markdown（统一用同一套 turndown 配置，并清理标题里多余的转义） */
export function htmlToMarkdown(html: string): string {
  return unescapeHeadingListMarkers(createTurndownService().turndown(html))
}

/** 表格内是否有「可见内容」：文本、图片、公式占位符都算（&nbsp; 等空白不算） */
function hasVisibleTableContent(tableHtml: string): boolean {
  if (/<img\b|<svg\b/i.test(tableHtml)) return true
  const text = tableHtml
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, 'x') // 其它实体（&amp; 等）视为有内容
    .replace(/\s+/g, '')
  return text.length > 0
}

/**
 * 丢弃「没有任何可见内容」的表格。
 *
 * 典型来源：Word 修订（tracked changes）里被整表删除、但修订还没接受的表格 ——
 * 单元格内容只存在于 `<w:delText>` 中，mammoth 按「接受修订」语义把删除内容全部丢弃，
 * 于是只剩一个带边框的空表格（用户反馈「一打开就有很多三行/五行的空白表格」的根因）。
 * Word 在「无标记 / 接受全部修订」视图下同样看不到这些表格，这里保持一致的观感。
 */
export function stripEmptyTables(html: string): string {
  const re = /<table(?=[\s>])|<\/table>/gi
  let out = ''
  let cursor = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    if (m[0][1] === '/') continue
    const start = m.index
    // 找配对的 </table>（按嵌套深度计数，避免误伤嵌套表格）
    let depth = 1
    let end = -1
    let mm: RegExpExecArray | null
    while ((mm = re.exec(html))) {
      if (mm[0][1] === '/') {
        depth--
        if (depth === 0) { end = mm.index + mm[0].length; break }
      } else depth++
    }
    if (end < 0) break
    if (!hasVisibleTableContent(html.slice(start, end))) {
      out += html.slice(cursor, start)
      cursor = end
    }
    re.lastIndex = end
  }
  return cursor === 0 ? html : out + html.slice(cursor)
}

/** .docx → Markdown（图片落盘引用、表格转管道表格、标题 atx + 编号回填 + 公式转 LaTeX） */
export async function docxToMarkdown(input: DocxToMarkdownInput): Promise<string> {
  const raw = input.buffer ?? (input.filePath ? fs.readFileSync(input.filePath) : Buffer.alloc(0))
  let buffer = raw
  let formulas: string[] = []
  if (raw.length) {
    // 1) Word 自动编号（尤其挂在标题样式上的多级编号）mammoth 读不出来，先回填进标题文字
    buffer = restoreDocxHeadingNumbers(buffer).buffer
    // 2) Word 公式（OMML）mammoth 完全不支持 → 先写占位符，Markdown 生成后再换回 $latex$
    //    （不能直接写 `$latex$`：turndown 会把 `\frac` 转义成 `\\frac` 破坏公式）
    const math = restoreDocxMath(buffer)
    buffer = math.buffer
    formulas = math.formulas
  }
  const wantImages = input.extractImages !== false
  const mediaRoot = input.mediaDir || path.join(os.tmpdir(), 'ai-km-docx-media')
  if (wantImages) pruneMediaRoot(mediaRoot)
  const convertImage = wantImages
    ? createImageHandler(mediaRoot, mediaDocKey(input, raw))
    : (mammoth.images as any).imgElement(() => ({ src: '' })) // 空 src 而非 null：mammoth 对 null 属性会抛错
  // 注意：convertImage 必须放在第二个参数（options）里 —— 写在 input 对象里会被 mammoth 忽略
  const { value: html } = await mammoth.convertToHtml({ buffer }, { convertImage } as any)
  // 丢弃没有有效 src 的 <img>（EMF/WMF/TIFF 等浏览器无法显示的格式）；
  // 预览场景给出提示，避免用户误以为内容丢失（工具取文本场景不加提示）
  const droppedNote = wantImages
    ? '<p><em>[图片未显示：EMF/WMF/TIFF 等矢量格式浏览器无法预览]</em></p>'
    : ''
  const cleanedHtml = String(html || '').replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\bsrc\s*=\s*"([^"]*)"/i.exec(tag)?.[1] || ''
    return src && src !== 'null' ? tag : droppedNote
  })
  // 丢弃完全空白的表格（多为「已删除但未接受修订」的表格，见 stripEmptyTables 注释）
  return applyMathPlaceholders(htmlToMarkdown(stripEmptyTables(cleanedHtml)), formulas)
}
