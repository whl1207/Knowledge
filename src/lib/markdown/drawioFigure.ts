/**
 * drawioFigure.ts — Markdown 内嵌 draw.io 图表（`![说明](图.drawio)`）的统一渲染（渲染进程共用）
 *
 * 图表渲染本体在 @/shared/drawioRender（单例离屏 iframe + 串行队列 + 内容哈希缓存），本模块只解决
 * 「图表怎么进到各视图的正文里」：浏览（md_read）/ 演示（md_ppt）/ 可视编辑（BlockEditor）/
 * 导图（md_mind）共用这一套，避免四处各写一遍。
 *
 * 三个落点：
 *  1. **占位 + 回填**（浏览 / 演示 / 可视编辑）：`installDrawioImageRule` 把图表图片引用渲染成
 *     `.md-drawio-figure` 占位卡片（样式见 drawio-figure.css），正文挂上 DOM 后由
 *     `renderDrawioFigures` 把 SVG 填进占位 —— 多页图表逐页一张图并标注「第 i / N 页」；
 *  2. **直接内联图片**（导图）：markmap 节点里只有真图片能显示，所以用 `inlineDrawioRefsAsImages`
 *     先把图表渲染成 SVG data URL 再进节点；
 *  3. 可视编辑的渲染态 HTML 由整块 Markdown 渲染而来（此刻图表还是个 `<img>`），
 *     先用 `swapDrawioImages` 把它换成占位卡片，再走第 1 条。
 */
import type MarkdownIt from 'markdown-it'
import { isDrawioPath } from '@/shared/drawioFile'
import {
  MAX_DIAGRAM_PAGES,
  parseDiagramRef,
  readDiagramFile,
  renderDiagramPages,
  renderDiagramSvg,
  resolveDiagramPath,
} from '@/shared/drawioRender'
import { ensureSvgExplicitSize, parseSvgSize } from '@/lib/markdown/mermaid'
import '@/lib/markdown/drawio-figure.css'

/** 占位卡片 / 渲染结果的外层 class（样式见 drawio-figure.css） */
export const DRAWIO_FIGURE_CLASS = 'md-drawio-figure'

/** 只处理本地图表：`http(s):` / `data:` / `blob:` 引用读不了盘，也不能当本地图表打开 */
function isLocalDiagramRef(src: string): boolean {
  return !/^(https?:|data:|blob:)/i.test(String(src || '').trim())
}

/** 图表引用（Markdown 图片 / `<img>`）指向的本地图表文件；不是则返回 null */
function diagramRefOf(src: string): { path: string; page: string } | null {
  const ref = parseDiagramRef(src)
  if (!ref.path || !isDrawioPath(ref.path) || !isLocalDiagramRef(ref.path)) return null
  return ref
}

// ==================== 图表尺寸估算（排版选布局用，不渲染） ====================

/** drawio 压缩页：内容为 base64(deflate-raw(URI 编码 XML))，这里解回 XML 文本 */
async function inflateDiagramText(b64: string): Promise<string> {
  const bin = atob(b64.trim())
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const text = await new Response(stream).text()
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** 一页的图形范围（把所有顶点的 mxGeometry 取并集）→ 该页的估算尺寸 */
function pageBox(inner: string): { w: number; h: number } | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const cellRe = /<mxCell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mxCell>)/gi
  let m: RegExpExecArray | null
  while ((m = cellRe.exec(inner))) {
    const attrs = m[1] || ''
    if (!/\bvertex\s*=\s*"1"/i.test(attrs)) continue
    const geo = /<mxGeometry\b([^>]*?)\/?>/i.exec(m[2] || '')
    if (!geo) continue
    const g = geo[1]
    const num = (name: string) => {
      const r = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(g)
      const v = r ? parseFloat(r[1]) : NaN
      return Number.isFinite(v) ? v : 0
    }
    const x = num('x')
    const y = num('y')
    const w = num('width')
    const h = num('height')
    // 连线 / 相对定位的小标签不参与（宽高缺失或过小）
    if (w < 4 || h < 4) continue
    // 相对定位（relative="1"）的坐标是 0..1 的比例，不参与包围盒
    if (/\brelative\s*=\s*"1"/i.test(g)) continue
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x + w)
    maxY = Math.max(maxY, y + h)
  }
  if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return null
  // drawio 取图默认带 8px 边距
  return { w: Math.round(maxX - minX) + 16, h: Math.round(maxY - minY) + 16 }
}

/**
 * 估算图表每一页的尺寸（宽高，px）—— **不渲染**，只把 mxGeometry 取并集。
 *
 * 演示视图要按图片长宽选布局，如果为此把每张图都先离屏渲染一遍，打开文档就要等十几秒；
 * 图形范围足够判断「竖图 / 方图 / 宽图」，所以这里直接解析 XML（压缩页先解压）。
 */
export async function estimateDiagramSizes(
  xml: string,
): Promise<Array<{ id: string; name: string; w: number; h: number }>> {
  if (!xml) return []
  const out: Array<{ id: string; name: string; w: number; h: number }> = []
  const diagramRe = /<diagram\b([^>]*)>([\s\S]*?)<\/diagram>/gi
  let m: RegExpExecArray | null
  while ((m = diagramRe.exec(xml))) {
    const attrs = m[1] || ''
    const inner = m[2] || ''
    const attr = (name: string) => {
      const r = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs)
      return r ? r[1] : ''
    }
    let body = inner
    if (!/<mxGraphModel[\s>]/.test(inner)) {
      try {
        body = await inflateDiagramText(inner)
      } catch {
        continue
      }
    } else {
      // 未压缩：整个文件可能有多个 <diagram>，逐个处理即可
      body = inner
    }
    const box = pageBox(body)
    if (box) out.push({ id: attr('id'), name: attr('name'), w: box.w, h: box.h })
  }
  return out
}

/** 按页定位（1 起的序号 / 页名 / 页 id）取该页的估算尺寸；定位无效时取第一页 */
export function pickDiagramSize(
  pages: Array<{ id: string; name: string; w: number; h: number }>,
  pageSpec = '',
): { w: number; h: number } | null {
  if (!pages.length) return null
  const spec = String(pageSpec || '').trim()
  if (spec) {
    if (/^\d+$/.test(spec)) {
      const i = Number(spec) - 1
      if (i >= 0 && i < pages.length) return { w: pages[i].w, h: pages[i].h }
    } else {
      const lower = spec.toLowerCase()
      const hit = pages.find((p) => p.name.trim().toLowerCase() === lower || p.id.toLowerCase() === lower)
      if (hit) return { w: hit.w, h: hit.h }
    }
  }
  return { w: pages[0].w, h: pages[0].h }
}

// ==================== 占位 + 回填（浏览 / 演示 / 可视编辑） ====================

export interface DrawioFigureHtmlOptions {
  /** 图表文件路径（应已按文档目录解析成绝对路径） */
  path: string
  /** 页定位（`#page=` 的取值：1 起的序号 / 页名 / 页 id），空 = 渲染全部页 */
  page?: string
  /** 图注（Markdown 图片的 alt 文本） */
  alt?: string
  /** 中文界面（占位文案） */
  zh?: boolean
  /** 悬停提示；传 `null` 表示不加提示（如可视编辑里点击是进编辑态，不是打开图表） */
  title?: string | null
}

/** 生成图表占位卡片（`data-drawio-state="pending"`，由 renderDrawioFigures 填 SVG） */
export function drawioFigureHtml(escapeHtml: (s: string) => string, o: DrawioFigureHtmlOptions): string {
  const zh = o.zh !== false
  const pageAttr = o.page ? ` data-drawio-page="${escapeHtml(o.page)}"` : ''
  const title =
    o.title === null
      ? ''
      : ` title="${escapeHtml(o.title || (zh ? '点击打开图表' : 'Click to open diagram'))}"`
  const caption = o.alt ? `<figcaption class="md-image-caption">${escapeHtml(o.alt)}</figcaption>` : ''
  return (
    `<figure class="${DRAWIO_FIGURE_CLASS}" data-drawio-path="${escapeHtml(o.path)}"${pageAttr}${title}>` +
    `<div class="md-drawio-body" data-drawio-state="pending"><span class="md-drawio-hint">${
      zh ? '正在渲染图表…' : 'Rendering diagram…'
    }</span></div>` +
    `${caption}</figure>`
  )
}

export interface DrawioImageRuleOptions {
  /** 当前文档所在目录（含结尾 `/`）：把 `../输出/图.drawio` 这类相对路径解析成绝对路径 */
  getBasePath: () => string
  /** 是否中文界面 */
  isZh?: () => boolean
}

/**
 * 给 markdown-it 实例装上「图表图片 → 占位卡片」规则。
 *
 * 包住宿主**已有**的 image 规则（相对路径拼接 / 图片描述等一律保留），只在目标确实是本地
 * `.drawio` 图表时接管 —— 图表路径要额外折叠 `..` 并还原百分号编码（md 里常写
 * `../输出/图.drawio`，中文目录会被编码成 `%E8%BE%93…`），不能走 `<img>` 那套拼接。
 */
export function installDrawioImageRule(md: MarkdownIt, opts: DrawioImageRuleOptions): void {
  const prev =
    md.renderer.rules.image || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const srcIndex = token.attrIndex('src')
    if (srcIndex >= 0) {
      const ref = diagramRefOf(token.attrs![srcIndex][1])
      if (ref) {
        return drawioFigureHtml(md.utils.escapeHtml, {
          path: resolveDiagramPath(ref.path, opts.getBasePath()),
          page: ref.page,
          alt: (token.content || '').trim(),
          zh: opts.isZh ? opts.isZh() : true,
        })
      }
    }
    return prev(tokens, idx, options, env, self)
  }
}

export interface RenderDrawioOptions {
  /** 中文界面（页码 / 失败提示文案） */
  zh?: boolean
  /** 单张图表最多渲染多少页（默认与浏览视图一致：前 10 页） */
  maxPages?: number
  /** 读取图表失败时的原因说明（如「远程模式不支持内嵌图表」），仅用于日志与兜底提示 */
  emptyMessage?: string
}

/**
 * 把 root 里待渲染的图表占位卡片填成 SVG。
 *
 * 所有图表共用同一个离屏渲染器（见 @/shared/drawioRender），调用方**不必 await**：
 * 让视图先可交互，图表渲染完自己填进去。多页图表按页各出一张图并标注「第 i / N 页」
 * （超过上限只渲染前 N 页并提示）；失败的图表降级成「点击打开图表」的提示卡片。
 */
export async function renderDrawioFigures(
  root: HTMLElement | null | undefined,
  opts: RenderDrawioOptions = {},
): Promise<void> {
  if (!root) return
  const zh = opts.zh !== false
  const figures = Array.from(root.querySelectorAll<HTMLElement>(`.${DRAWIO_FIGURE_CLASS}`))
  for (const fig of figures) {
    const body = fig.querySelector<HTMLElement>('.md-drawio-body')
    if (!body || body.dataset.drawioState !== 'pending') continue
    const path = fig.getAttribute('data-drawio-path') || ''
    const pageSpec = fig.getAttribute('data-drawio-page') || ''
    try {
      const xml = await readDiagramFile(path)
      if (!xml) throw new Error(opts.emptyMessage || '读取图表失败')
      const pages = await renderDiagramPages(xml, { page: pageSpec, maxPages: opts.maxPages ?? MAX_DIAGRAM_PAGES })
      if (!pages.length) throw new Error('图表没有可渲染的页')
      // 渲染期间内容可能已被替换（切文件 / 重新渲染）：只在仍是同一份占位时写入
      if (body.dataset.drawioState !== 'pending') continue
      body.innerHTML = ''
      for (const page of pages) {
        const canvas = document.createElement('div')
        canvas.className = 'md-drawio-canvas'
        // 记下这一页的页码（1 起）：点击该图时编辑器直接定位到这一页
        canvas.dataset.drawioPage = String(page.index + 1)
        canvas.innerHTML = page.svg
        body.appendChild(canvas)
      }
      const total = pages[0].total
      if (pages.length > 1 && total > pages.length) {
        const note = document.createElement('div')
        note.className = 'md-drawio-hint'
        note.textContent = zh
          ? `共 ${total} 页，仅显示前 ${pages.length} 页（点击图表打开编辑器查看其余页）`
          : `${total} pages in total, showing the first ${pages.length} (click the diagram to open the editor)`
        body.appendChild(note)
      }
      body.dataset.drawioState = 'ready'
    } catch (e) {
      console.warn('[drawioFigure] 内嵌图表渲染失败:', path, e)
      body.dataset.drawioState = 'failed'
      body.innerHTML = `<span class="md-drawio-hint">${
        zh ? '无法内嵌预览，点击打开图表' : 'Inline preview unavailable, click to open'
      }</span>`
    }
  }
}

/**
 * 可视编辑（块编辑器）专用：把渲染态里的图表图片换成占位卡片。
 *
 * 块里的 HTML 由 Markdown 渲染而来（`![](图.drawio)` 先是个 `<img>`，此刻 src 还是相对路径），
 * 所以替换时一并按 basePath 解析成绝对路径。返回被换上的占位卡片，调用方随后走
 * `renderDrawioFigures` 即可（同一份 HTML 里已有的占位卡片不会被重复处理）。
 */
export function swapDrawioImages(
  root: HTMLElement,
  opts: { basePath?: string; zh?: boolean; title?: string | null } = {},
): HTMLElement[] {
  if (!root) return []
  const zh = opts.zh !== false
  const made: HTMLElement[] = []
  root.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
    const ref = diagramRefOf(img.getAttribute('src') || '')
    if (!ref) return
    const fig = document.createElement('figure')
    fig.className = DRAWIO_FIGURE_CLASS
    fig.setAttribute('data-drawio-path', resolveDiagramPath(ref.path, opts.basePath || ''))
    if (ref.page) fig.setAttribute('data-drawio-page', ref.page)
    if (opts.title !== null) {
      fig.title = opts.title || (zh ? '点击打开图表' : 'Click to open diagram')
    }
    const body = document.createElement('div')
    body.className = 'md-drawio-body'
    body.dataset.drawioState = 'pending'
    const hint = document.createElement('span')
    hint.className = 'md-drawio-hint'
    hint.textContent = zh ? '正在渲染图表…' : 'Rendering diagram…'
    body.appendChild(hint)
    fig.appendChild(body)
    const alt = (img.getAttribute('alt') || '').trim()
    if (alt) {
      const caption = document.createElement('figcaption')
      caption.className = 'md-image-caption'
      caption.textContent = alt
      fig.appendChild(caption)
    }
    img.replaceWith(fig)
    made.push(fig)
  })
  return made
}

// ==================== 直接内联图片（导图 / markmap） ====================

/** SVG → data URL（走 base64：图表里常有中文标签，拼字面量会被 URL 规范化改坏） */
function svgDataUrl(svg: string): string {
  const size = parseSvgSize(svg)
  // 固定 width/height：只有 viewBox 的 SVG 作为 <img> 时按 300×150 渲染（字体被压扁）
  const sized = size ? ensureSvgExplicitSize(svg, size.w, size.h) : svg
  try {
    return `data:image/svg+xml;base64,${window.btoa(unescape(encodeURIComponent(sized)))}`
  } catch (e) {
    console.warn('[drawioFigure] 图表 SVG 转 data URL 失败:', e)
    return ''
  }
}

/**
 * 放行 `data:image/svg+xml` 图片。
 *
 * 导图内联图表用的就是这种 data URL，而 markdown-it 默认只放行 gif/png/jpeg/webp 的 data URL
 * （其余按「不可信协议」一律拒绝）→ 图片语法不成立，正文里会原样显示成 `![图注](data:…)` 文本。
 * 这里按「只补图片类型」的原则放开 svg，`javascript:` / `vbscript:` 仍然拒绝。
 */
export function allowSvgDataUrlImages(md: { validateLink: (url: string) => boolean }): void {
  const prev = md.validateLink
  md.validateLink = (url: string) => {
    if (/^data:image\/svg\+xml/i.test(String(url || '').trim())) return true
    return prev.call(md, url)
  }
}

/**
 * 导图（markmap）专用：把 Markdown 里的图表图片引用换成内联的 SVG data URL。
 *
 * markmap 的节点只认真图片（`<img>`），且节点内容在测量时按节点宽度限宽，所以这里直接把图表
 * 渲染成 SVG 内联进去。多页图表只取第一页（或 `#page=` 指定的那页）—— 一个节点放不下多张图，
 * 其余页请点开图表查看。
 */
export async function inlineDrawioRefsAsImages(markdown: string, baseDir = ''): Promise<string> {
  if (!markdown || !/\.drawio/i.test(markdown)) return markdown
  const targets: Array<{ full: string; alt: string; src: string; kind: 'md' | 'html' }> = []
  let m: RegExpExecArray | null
  const mdRe = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g
  while ((m = mdRe.exec(markdown))) targets.push({ full: m[0], alt: m[1], src: m[2], kind: 'md' })
  const htmlRe = /<img([^>]*?)\ssrc="([^"]+)"([^>]*?)>/gi
  while ((m = htmlRe.exec(markdown))) targets.push({ full: m[0], alt: '', src: m[2], kind: 'html' })
  if (!targets.length) return markdown

  let out = markdown
  for (const t of targets) {
    const ref = diagramRefOf(t.src)
    if (!ref) continue
    try {
      const xml = await readDiagramFile(resolveDiagramPath(ref.path, baseDir))
      if (!xml) continue
      const url = svgDataUrl(await renderDiagramSvg(xml, { page: ref.page }))
      if (!url) continue
      out = out.replace(t.full, (whole) =>
        // 内联 HTML 写法保留原有属性，只把 src 换掉
        t.kind === 'html' ? whole.replace(t.src, () => url) : t.alt ? `![${t.alt}](${url})` : `![](${url})`,
      )
    } catch (e) {
      console.warn('[drawioFigure] 导图内嵌图表失败:', t.src, e)
    }
  }
  return out
}
