/**
 * 真实 .docx 导出工具（免第三方依赖）
 *
 * 将已渲染的 HTML（含 data: 图片，如 mermaid 转出的 PNG）转换为 OOXML 文档，
 * 再用自实现的 ZIP 写入器（Chromium CompressionStream deflate + CRC32）打包为
 * 标准 .docx。Word 打开即可显示文字、标题、表格、代码块与内嵌图片。
 *
 * 数学公式：优先转换为 Word 原生公式对象（OMML，可在 Word 中继续编辑）；
 * 若某条公式拿不到 MathML 或转换失败，则回退为内嵌 PNG 图片（仅观感，不可编辑）。
 */
import { svgToPngDataUrl, parseSvgSize } from '@/lib/markdown/mermaid'
import { mathmlToOmml, mathmlPlainText } from '@/lib/export/mathml-to-omml'

/** 一张待嵌入的图片 */
interface DocxImage {
  src: string
  data: Uint8Array
  ext: string
  w: number
  h: number
}

/** 图片在文档中的引用信息（公式等带目标显示尺寸时 emuW/emuH 存在） */
interface DocxRidInfo {
  rid: string
  idx: number
  w: number
  h: number
  /** 公式等指定了目标显示尺寸（EMU）时存在，绘制直接采用 */
  emuW?: number
  emuH?: number
}

/** 已转成 Word 原生公式（OMML）的片段：key 为占位元素的 data-omml-id */
interface DocxOmmlItem {
  /** `<m:oMath>` 的内容（不含 oMath 标签本身） */
  xml: string
  /** 是否为独立成行的展示公式（$$…$$） */
  display: boolean
}

type DocxOmmlStore = Map<string, DocxOmmlItem>

// MathJax SVG 的 viewBox 单位为「设计单位」，1em = 1000 单位；字号换算即像素/单位 = 字号/1000
const MATH_UNITS_PER_EM = 1000
const EMU_PER_PT = 12700
/** 公式在 Word 中的显示字号（与公文正文 3 号=16pt 一致，公式字形按此缩放） */
const MATH_FONT_PT = 16

// GB/T 9704-2012 公文版心（A4 210×297mm）：上 37 / 下 35 / 左 28 / 右 26mm → 内容宽 156mm=8844tw、内容高 225mm=12756tw
const DOC_CONTENT_W_TW = 8844
const DOC_CONTENT_H_TW = 12756

// ===== Word 导出模板（页面版式 + 样式），key 存入 store.UI.wordExportTemplate =====
/** 页面版式（twip；A4 页 11906×16838） */
export interface DocxPageProfile {
  topTw: number
  rightTw: number
  bottomTw: number
  leftTw: number
  contentWTw: number
  contentHTw: number
  /** 行内公式字号（pt）；缺省 16 */
  mathFontPt?: number
}

/** 导出模板预设 */
export interface DocxTemplatePreset {
  key: string
  labelZh: string
  labelEn: string
  /** 内置样式 XML；'custom' 为 null（改用外部 .docx 皮肤） */
  stylesXml: string | null
  page: DocxPageProfile
}

const INCH_TW = 1440 // 1 英寸
/** 公文版式（上37/下35/左28/右26mm） */
const GONGWEN_PAGE: DocxPageProfile = {
  topTw: 2098, rightTw: 1475, bottomTw: 1984, leftTw: 1587,
  contentWTw: DOC_CONTENT_W_TW, contentHTw: DOC_CONTENT_H_TW,
}
/** 通用 1 英寸页边距（中文/英文论文，正文约 12pt） */
const INCH_PAGE: DocxPageProfile = {
  topTw: INCH_TW, rightTw: INCH_TW, bottomTw: INCH_TW, leftTw: INCH_TW,
  contentWTw: 11906 - INCH_TW * 2, contentHTw: 16838 - INCH_TW * 2,
  mathFontPt: 12,
}

/**
 * 文档皮肤（可选）：来自用户模板 .docx 的样式部件。
 *  - stylesXml：模板 word/styles.xml（决定正文/标题等段落样式观感）
 *  - themeXml：模板 word/theme/theme1.xml（模板标题若用主题字体 majorHAnsi 等，需随包才能正确解析）
 * 未提供时用内置默认皮肤（DEFAULT_STYLES_XML）。
 */
export interface DocxSkin {
  stylesXml?: string
  themeXml?: string
}

/** 构建 .docx 文件 Blob */
export async function buildDocxBlob(renderedHtml: string, skin?: DocxSkin, page?: DocxPageProfile): Promise<Blob> {
  const doc = new DOMParser().parseFromString(renderedHtml, 'text/html')
  // 中文标点规整：把正文成对 ASCII 直引号 "…" 替换为中文弯引号 “…”
  smartCjkQuotes(doc)
  // 数学公式：先尝试转成 Word 原生公式（OMML，可编辑）
  const omml = convertFormulasToOmml(doc)
  // 剩下的（无 MathML / 转换失败）仍回退为 PNG 内嵌图片
  await convertFormulasToImages(doc, page)
  const images = await collectImages(doc)

  const themeXml = skin?.themeXml
  // 有主题部件时占用 rId2（rId1 为 styles）；图片从 rId3 起分配
  const themeRid = themeXml ? 'rId2' : undefined
  const { documentXml, rels } = buildOoxml(doc, images, themeRid, page, omml)
  const encoder = new TextEncoder()

  const files: { name: string; data: Uint8Array }[] = [
    { name: '[Content_Types].xml', data: encoder.encode(buildContentTypes(images, !!themeXml)) },
    { name: '_rels/.rels', data: encoder.encode(ROOT_RELS) },
    { name: 'word/document.xml', data: encoder.encode(documentXml) },
    { name: 'word/_rels/document.xml.rels', data: encoder.encode(rels) },
    { name: 'word/styles.xml', data: encoder.encode(skin?.stylesXml || DEFAULT_STYLES_XML) },
    ...(themeXml ? [{ name: 'word/theme/theme1.xml', data: encoder.encode(themeXml) }] : []),
    ...images.map((im, i) => ({ name: `word/media/image${i + 1}.${im.ext}`, data: im.data })),
  ]

  return buildZip(files)
}

/**
 * 收集 HTML 中的图片并解码，兼容三种来源：
 *  - data: 直接嵌入；
 *  - http(s):/:// 远程图片：抓取后内嵌（离线/失败则跳过）；
 *  - 本地绝对路径 / file:///：走 IPC readFileBase64 读取。
 * 同时把 <img src> 统一替换为 data URL，便于后续构建引用。
 */
async function collectImages(doc: Document): Promise<DocxImage[]> {
  const images: DocxImage[] = []
  const seen = new Map<string, number>()
  const imgs = Array.from(doc.querySelectorAll('img'))
  await Promise.all(imgs.map(async (img) => {
    let src = img.getAttribute('src') || ''
    if (!src) return
    let dataUrl = ''

    if (/^data:image\//i.test(src)) {
      dataUrl = src
    } else if (/^(https?:|\/\/)/i.test(src)) {
      try {
        const absUrl = /^\/\//i.test(src) ? (location.protocol + src) : src
        const resp = await fetch(absUrl)
        if (!resp.ok) return
        const buf = await resp.arrayBuffer()
        const type = resp.headers.get('content-type') || guessMimeFromUrl(absUrl)
        if (!type || !type.startsWith('image/')) return
        dataUrl = `data:${type};base64,${uint8ToBase64(new Uint8Array(buf))}`
      } catch {
        return
      }
    } else {
      // 本地路径 / file:///（自动尝试解码百分号编码，兼容中文文件名图片）
      let filePath = src
      if (/^file:\/\//i.test(filePath)) {
        filePath = filePath.replace(/^file:\/\/\/?/i, '')
      }
      dataUrl = await readImageAsDataUrl(filePath)
    }

    if (!dataUrl || seen.has(dataUrl)) return
    let mime = (dataUrl.match(/^data:([^;,]+)/i) || [])[1] || 'image/png'
    let ext = mimeToExt(mime)

    // Word 兼容性：非 png/jpg 统一转成 PNG（SVG 用 svgToPngDataUrl，其它位图用 canvas 栅格化）
    if (ext !== 'png' && ext !== 'jpg' && ext !== 'jpeg') {
      try {
        if (mime.startsWith('image/svg')) {
          const png = await svgToPngDataUrl(dataUrl)
          if (png) { dataUrl = png; mime = 'image/png'; ext = 'png' }
        } else {
          const png = await rasterizeToPng(dataUrl)
          if (png) { dataUrl = png; mime = 'image/png'; ext = 'png' }
        }
      } catch (e) {
        console.warn('[export-docx] 图片转 PNG 失败:', src, e)
      }
    }

    const b64 = (dataUrl.match(/^data:[^;]+;base64,(.*)$/s) || [])[1] || ''
    if (!b64) return
    let data: Uint8Array
    try {
      data = base64ToUint8(b64)
    } catch {
      return
    }
    const { w, h } = await loadImageSize(dataUrl)
    seen.set(dataUrl, images.length)
    img.setAttribute('src', dataUrl)
    images.push({ src: dataUrl, data, ext, w, h })
    console.info(`[export-docx] 图片[${seen.size}] ext=${ext} ${w}x${h} src=${src.slice(0, 80)}`)
  }))
  // 文档里没有 <img> 时不打印，避免纯文字文档（公式已走 OMML）刷无意义日志
  if (imgs.length) console.info(`[export-docx] 共收集 ${images.length} 张图片（文档内 <img> ${imgs.length} 个）`)
  return images
}

/**
 * 读取本地图片为 data URL。
 * 兼容常见问题：
 *  - 路径含百分号编码（如中文文件名被编码为 %E8%A3%85...），先解码再读；
 *  - 路径含 ./ 段，先清理；
 *  - 读取失败自动回退下一个候选路径。
 */
export async function readImageAsDataUrl(filePath: string): Promise<string> {
  if (!filePath || typeof window === 'undefined' || !(window as any).ipcRenderer) return ''
  const candidates = new Set<string>()
  candidates.add(filePath)
  if (/%[0-9a-fA-F]{2}/.test(filePath)) {
    try { candidates.add(decodeURIComponent(filePath)) } catch { /* 忽略 */ }
  }
  const cleaned = filePath.replace(/\/\.\//g, '/').replace(/^\.\//, '')
  if (cleaned !== filePath) candidates.add(cleaned)
  for (const cand of candidates) {
    try {
      const res = await (window as any).ipcRenderer.invoke('readFileBase64', cand)
      if (typeof res === 'string' && res.startsWith('data:')) return res
    } catch { /* 尝试下一个候选 */ }
  }
  return ''
}

/** 将位图 data URL（webp/bmp/gif/tiff 等）栅格化为 PNG（canvas 绘制，非 SVG 不会污染） */
function rasterizeToPng(dataUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image()
    const timer = setTimeout(() => { img.src = ''; resolve(null) }, 5000)
    img.onload = () => {
      clearTimeout(timer)
      try {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth || 400
        canvas.height = img.naturalHeight || 300
        const ctx = canvas.getContext('2d')
        if (!ctx) { resolve(null); return }
        ctx.drawImage(img, 0, 0)
        resolve(canvas.toDataURL('image/png'))
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => { clearTimeout(timer); resolve(null) }
    img.src = dataUrl
  })
}

// ===== 公式一：MathML → OMML（Word 原生可编辑公式）=====

/** 占位元素上保留的公式纯文本长度上限（供表格列宽估算，不需要很精确） */
const OMML_TEXT_MAX = 120

/** OMML 片段命名空间（校验用；正式输出在 document.xml 根节点声明 m 前缀） */
const OMML_NS_DECL = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

/**
 * 把文档中的 MathJax 公式转成 OMML：源为 `<mjx-container>` 内自带的 assistive MathML
 * （`<mjx-assistive-mml><math>…</math>`），转换后容器换成带 data-omml-id 的空 `<span>`，
 * 由 buildOoxml 输出 `<m:oMath>` / `<m:oMathPara>`。
 * 无 MathML 源或结果不合法时保持原样，交给 convertFormulasToImages 退化为图片。
 */
function convertFormulasToOmml(doc: Document): DocxOmmlStore {
  const store: DocxOmmlStore = new Map()
  const containers = Array.from(doc.body.querySelectorAll('mjx-container'))
  if (!containers.length) return store
  let seq = 0
  for (const c of containers) {
    const math = c.querySelector('mjx-assistive-mml math') || c.querySelector('math')
    if (!math) continue
    const xml = mathmlToOmml(math)
    if (!xml || !isWellFormedOmml(xml)) continue
    const display = c.getAttribute('display') === 'true' || math.getAttribute('display') === 'block'
    const key = `omml${++seq}`
    store.set(key, { xml, display })
    const span = doc.createElement('span')
    span.setAttribute('data-omml-id', key)
    span.setAttribute('data-omml-display', display ? '1' : '0')
    span.setAttribute('data-omml-text', mathmlPlainText(math).slice(0, OMML_TEXT_MAX))
    // 行内公式：去掉其与中文/全角字符紧邻的空格（与图片回退路径保持一致）
    if (c.getAttribute('display') !== 'true') {
      trimFormulaWs(c.previousSibling, true)
      trimFormulaWs(c.nextSibling, false)
    }
    c.replaceWith(span)
  }
  if (store.size) console.info(`[export-docx] 公式转为 Word 原生公式(OMML)：${store.size} 条`)
  return store
}

/** 校验 OMML 片段是否为结构完好的 XML（不合法则退回图片，避免 Word 报“内容有问题”） */
function isWellFormedOmml(xml: string): boolean {
  try {
    const probe = `<r ${OMML_NS_DECL}>${xml}</r>`
    const parsed = new DOMParser().parseFromString(probe, 'application/xml')
    if (parsed.getElementsByTagName('parsererror').length > 0) return false
    return !!parsed.documentElement.firstElementChild
  } catch {
    return false
  }
}

// ===== 公式二（回退）：MathJax SVG → 内嵌 PNG 图片 =====

/**
 * 把文档中 MathJax 输出的 <mjx-container> 公式替换为内嵌 PNG <img>（带目标 EMU 尺寸）。
 * MathJax SVG 的 viewBox 单位为「设计单位」，1em = 1000 单位；公式按 Word 正文字号缩放。
 */
async function convertFormulasToImages(doc: Document, page?: DocxPageProfile): Promise<void> {
  const containers = Array.from(doc.body.querySelectorAll('mjx-container'))
  if (!containers.length) return
  await Promise.all(containers.map(async (c) => {
    const svg = c.querySelector('svg')
    if (!svg) return
    try {
      const info = await renderFormulaImage(svg.outerHTML, page)
      if (!info) return
      const img = doc.createElement('img')
      img.setAttribute('src', info.dataUrl)
      img.setAttribute('alt', '')
      img.setAttribute('data-math', '1')
      img.setAttribute('data-emu-w', String(info.emuW))
      img.setAttribute('data-emu-h', String(info.emuH))
      // 行内公式：去掉其与中文/全角字符紧邻的空格，避免 Word 里公式左右出现空隙
      if (c.getAttribute('display') !== 'true') {
        trimFormulaWs(c.previousSibling, true)
        trimFormulaWs(c.nextSibling, false)
      }
      c.replaceWith(img)
    } catch (e) {
      console.warn('[export-docx] 公式内嵌失败:', e)
    }
  }))
}

/** 行内公式清理：删除其与中文/全角字符之间紧邻的空白（保留英文单词间的必要空格） */
const CJK_LETTER_RE = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uff60\uf900-\ufaff\uac00-\ud7af\u3040-\u30ff]/
const FORMULA_WS = '[ \\t\\u00A0\\u200B\\u3000]'

function trimFormulaWs(node: Node | null, before: boolean): void {
  if (!node || node.nodeType !== 3) return
  const t = node.textContent || ''
  if (before) {
    const m = new RegExp('(' + FORMULA_WS + '+)$').exec(t)
    if (!m) return
    const keep = t.length - m[0].length
    if (keep > 0 && CJK_LETTER_RE.test(t[keep - 1])) node.textContent = t.slice(0, keep)
  } else {
    const m = new RegExp('^(' + FORMULA_WS + '+)').exec(t)
    if (!m) return
    const cut = m[0].length
    if (cut < t.length && CJK_LETTER_RE.test(t[cut])) node.textContent = t.slice(cut)
  }
}

/**
 * 中文标点规整：把正文里成对的 ASCII 直引号（"…"）替换为中文弯引号（“…”）。
 * 仅处理文本节点：跳过代码块/行内代码/公式等（其内容中的引号须保持原样）；
 * 引号以“段落块”为单位成对开合，避免跨段错位。
 */
function smartCjkQuotes(doc: Document): void {
  const SKIP_TAGS = new Set(['pre', 'code', 'kbd', 'samp', 'script', 'style', 'mjx-container', 'mjx-math', 'math', 'svg'])
  const RESET_BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'dt', 'dd', 'figcaption', 'blockquote'])
  let open = true
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const t = child.textContent || ''
        if (t.includes('"')) {
          let out = ''
          for (const ch of t) {
            if (ch === '"') { out += open ? '“' : '”'; open = !open } else out += ch
          }
          child.textContent = out
        }
        continue
      }
      if (child.nodeType !== 1) continue
      const tag = (child as Element).tagName.toLowerCase()
      if (SKIP_TAGS.has(tag)) continue
      if (RESET_BLOCKS.has(tag)) open = true
      walk(child)
    }
  }
  if (doc.body) walk(doc.body)
}

/** 单个公式 SVG → PNG dataURL + 目标显示尺寸（EMU） */
async function renderFormulaImage(svgString: string, page?: DocxPageProfile): Promise<{ dataUrl: string; emuW: number; emuH: number } | null> {
  const size = parseSvgSize(svgString)
  if (!size || !(size.w > 0) || !(size.h > 0)) return null
  const vbW = size.w
  const vbH = size.h
  // 按字号换算目标显示尺寸：像素宽 = viewBoxW * 字号(pt→EMU) / 1000
  const fontPt = page?.mathFontPt || MATH_FONT_PT
  const emuPerUnit = (fontPt * EMU_PER_PT) / MATH_UNITS_PER_EM
  let emuW = Math.max(1, Math.round(vbW * emuPerUnit))
  let emuH = Math.max(1, Math.round(vbH * emuPerUnit))
  // 超出版心宽时等比缩小，防止长公式溢出页面
  const CONTENT_W = (page?.contentWTw || DOC_CONTENT_W_TW) * 635
  if (emuW > CONTENT_W) {
    const s = CONTENT_W / emuW
    emuW = Math.round(emuW * s)
    emuH = Math.round(emuH * s)
  }
  // 栅格化分辨率：约为显示尺寸的 3 倍（保证打印清晰），限制上下限避免超大/过小图
  const displayPxW = emuW / 9525
  const scale = Math.max(0.03, Math.min(1, (3 * displayPxW) / vbW))
  let dataUrl = ''
  try {
    dataUrl = await svgToPngDataUrl(svgString, scale)
  } catch (e) {
    console.warn('[export-docx] 公式转 PNG 失败:', e)
    return null
  }
  if (!dataUrl) return null
  return { dataUrl, emuW, emuH }
}

/** 构建 document.xml 与 document.xml.rels */
function buildOoxml(doc: Document, images: DocxImage[], themeRid?: string, page?: DocxPageProfile, ommlStore?: DocxOmmlStore) {
  // 当前导出模板页式（未传则用公文版式兜底）
  const PAGE = page || GONGWEN_PAGE
  const ridToInfo = new Map<string, DocxRidInfo>()
  const srcToIdx = new Map<string, number>()
  images.forEach((im, i) => srcToIdx.set(im.src, i))

  // 按出现顺序为 data: 图片分配 rId（rId1 已给 styles.xml；有主题时 rId2 给 theme）
  let rid = themeRid ? 3 : 2
  for (const img of Array.from(doc.body.querySelectorAll('img'))) {
    const src = img.getAttribute('src') || ''
    const idx = srcToIdx.get(src)
    if (idx === undefined) continue
    const r = `rId${rid++}`
    img.setAttribute('data-rid', r)
    // 公式图片带目标 EMU 尺寸（data-emu-w/h）；普通图片无 → 绘制走像素自适应
    const emuW = parseFloat(img.getAttribute('data-emu-w') || '')
    const emuH = parseFloat(img.getAttribute('data-emu-h') || '')
    ridToInfo.set(r, {
      rid: r, idx, w: images[idx].w, h: images[idx].h,
      emuW: emuW > 0 ? emuW : undefined,
      emuH: emuH > 0 ? emuH : undefined,
    })
  }

  // ===== 行内构建（返回 <w:r> 序列） =====
  const BLOCK_TAGS = new Set([
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'table',
    'pre', 'blockquote', 'figure', 'div', 'section', 'article', 'hr',
  ])

  function drawingXml(info: DocxRidInfo): string {
    // 页面内容区尺寸（与 sectPr 一致，按模板页边距换算）；1 twip = 635 EMU
    const CONTENT_W = PAGE.contentWTw * 635
    const CONTENT_H = PAGE.contentHTw * 635
    let cx: number
    let cy: number
    if (info.emuW && info.emuH) {
      // 公式等带目标显示尺寸（EMU）：直接采用，仅做内容区防溢出
      cx = Math.round(info.emuW)
      cy = Math.round(info.emuH)
      if (cx > CONTENT_W) {
        const s = CONTENT_W / cx
        cx = Math.round(cx * s)
        cy = Math.round(cy * s)
      }
    } else {
      cx = Math.round(info.w * 9525)
      cy = Math.round(info.h * 9525)
      // 等比缩放，同时限制在内容区宽高内，保证不溢出、不被页面裁剪
      const scale = Math.min(1, CONTENT_W / cx, CONTENT_H / cy)
      cx = Math.round(cx * scale)
      cy = Math.round(cy * scale)
    }
    const id = info.idx + 1
    return `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
      `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}"/>` +
      `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${info.rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
      `</a:graphicData></a:graphic></wp:inline></w:drawing>`
  }

  function drawingFor(el: Element): string {
    const rid = el.getAttribute('data-rid')
    if (!rid) return ''
    const info = ridToInfo.get(rid)
    return info ? drawingXml(info) : ''
  }

  /** 元素若为已转 OMML 的公式占位 → 返回 `<m:oMath>` 片段（行内用，直接置于 w:p 内） */
  function ommlOf(el: Element): string {
    const id = el.getAttribute('data-omml-id')
    if (!id || !ommlStore) return ''
    const item = ommlStore.get(id)
    return item ? `<m:oMath>${item.xml}</m:oMath>` : ''
  }

  /** 独立成行的展示公式（$$…$$）：整段居中，输出 Word 公式区 oMathPara */
  function displayMathParagraph(om: string): string {
    return `<w:p><w:pPr><w:ind w:firstLineChars="0" w:firstLine="0"/></w:pPr>` +
      `<m:oMathPara><m:oMathParaPr><m:jc m:val="center"/></m:oMathParaPr>${om}</m:oMathPara></w:p>`
  }

  function buildInline(node: Node, inherited: RprFlags): string {
    let out = ''
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const t = child.textContent || ''
        if (t) out += `<w:r>${rprXml(inherited)}<w:t xml:space="preserve">${escapeXml(t)}</w:t></w:r>`
        continue
      }
      if (child.nodeType !== 1) continue
      const el = child as Element
      const tag = el.tagName.toLowerCase()
      // 原生公式（OMML）直接作为 w:p 的数学区输出，不能再包 <w:r>
      const om = ommlOf(el)
      if (om) { out += om; continue }
      if (tag === 'br') { out += `<w:r>${rprXml(inherited)}<w:br/></w:r>`; continue }
      if (tag === 'img') { const d = drawingFor(el); if (d) out += `<w:r>${rprXml(inherited)}${d}</w:r>`; continue }
      if (BLOCK_TAGS.has(tag)) continue
      // 行内格式继承（md → Word）：加粗/斜体/删除线/高亮/行内代码/链接
      const rpr: RprFlags = { ...inherited }
      if (tag === 'strong' || tag === 'b') rpr.b = true
      if (tag === 'em' || tag === 'i') rpr.i = true
      if (tag === 'del' || tag === 's' || tag === 'strike') rpr.strike = true
      if (tag === 'mark') rpr.highlight = 'yellow'
      if (tag === 'code') { rpr.mono = true; rpr.shd = 'F2F2F2'; rpr.sz = 20 }
      if (tag === 'a') { rpr.color = '0563C1'; rpr.u = true }
      if (tag === 'mjx-container' || tag === 'mjx-math' || tag === 'math') {
        const txt = (el.textContent || '').trim()
        if (txt) out += `<w:r>${rprXml(rpr)}<w:t xml:space="preserve">${escapeXml(txt)}</w:t></w:r>`
        continue
      }
      out += buildInline(child, rpr)
    }
    return out
  }

  // ===== 块级构建 =====
  function paragraph(runs: string): string {
    return `<w:p>${runs}</w:p>`
  }

  function codeBlock(el: Element): string {
    const codeEl = el.querySelector('code') || el
    const text = codeEl.textContent || ''
    const lines = text.split('\n')
    const runs = lines.map((l, i) => {
      const r = `<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t xml:space="preserve">${escapeXml(l)}</w:t></w:r>`
      return i < lines.length - 1 ? r + '<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:br/></w:r>' : r
    }).join('')
    return `<w:p><w:pPr><w:shd w:val="clear" w:fill="F5F5F5"/><w:ind w:left="113" w:right="113" w:firstLineChars="0" w:firstLine="0"/></w:pPr>${runs}</w:p>`
  }

  /**
   * 把容器内容按“块”拆成 Word 段落 XML。
   * 兼容 markdown-it 的两类列表项结构：
   *  - 紧凑：<li>纯行内内容…</li>
   *  - 宽松/多段：<li><p>段1</p><p>段2</p><ul>…</ul></li>
   * 旧实现只用 buildInline(li) 提取行内内容，遇到 <p> 等块级子元素会整体跳过 → 文字丢失。
   */
  function looseChildrenXml(node: Node, o: {
    rpr?: RprFlags        // 行内基础格式（如引用斜体 <w:i/>）
    left?: number         // 首段左缩进（tw）
    laterLeft?: number    // 后续段落左缩进（默认=left，用于对齐标记后的文字）
    marker?: string       // 首段前置标记文本（如 "- " / "1. "）
    paraRpr?: string      // 每段 pPr 追加 XML（如 blockquote 的 shd）
    nestedStart?: number  // 嵌套列表起始深度
    plain?: boolean       // 按普通正文段落输出：不写缩进 pPr → 继承 Normal 首行缩进2字、续行靠左
  }): string {
    const left = o.left ?? 0
    const laterLeft = o.laterLeft ?? left
    const nestedStart = o.nestedStart ?? 0
    const baseRpr: RprFlags = o.rpr || {}
    const paras: string[] = []
    let firstDone = false
    let acc: string[] = []

    const visibleRuns = (runs: string): boolean =>
      /<w:drawing/.test(runs) || /<m:oMath/.test(runs) || /<w:br\s*\/?>/.test(runs) || /<w:t[^>]*>[^<\s]/.test(runs)

    const emit = () => {
      const runs = acc.join('')
      acc = []
      if (!visibleRuns(runs)) return
      const isFirst = !firstDone
      firstDone = true
      const marker = (isFirst && o.marker)
        ? `<w:r>${rprXml(baseRpr)}<w:t xml:space="preserve">${o.marker}</w:t></w:r>`
        : ''
      if (o.plain) {
        // 当普通正文段落：不输出缩进 pPr → 继承 Normal 首行缩进2字、续行靠左
        paras.push(`<w:p>${marker}${runs}</w:p>`)
        return
      }
      const ind = isFirst ? left : laterLeft
      const ppr = `<w:ind w:left="${ind}" w:firstLineChars="0" w:firstLine="0"/>${o.paraRpr || ''}`
      paras.push(`<w:p><w:pPr>${ppr}</w:pPr>${marker}${runs}</w:p>`)
    }

    const handle = (child: Node) => {
      if (child.nodeType === 3) {
        const t = child.textContent || ''
        if (t) acc.push(`<w:r>${rprXml(baseRpr)}<w:t xml:space="preserve">${escapeXml(t)}</w:t></w:r>`)
        return
      }
      if (child.nodeType !== 1) return
      const el = child as Element
      const tag = el.tagName.toLowerCase()
      // 原生公式（OMML）：段落内直接输出数学区（单元格/列表项里也用行内式，
      // oMathPara 在表格内不宜使用）
      const om = ommlOf(el)
      if (om) { acc.push(om); return }
      switch (tag) {
        case 'p': emit(); acc.push(buildInline(el, baseRpr)); return
        case 'ul': emit(); paras.push(listBlock(el, 'bullet', nestedStart)); return
        case 'ol': emit(); paras.push(listBlock(el, 'number', nestedStart)); return
        case 'blockquote': emit(); paras.push(blockquoteXml(el)); return
        case 'pre': emit(); paras.push(codeBlock(el)); return
        case 'table': emit(); paras.push(tableBlock(el)); return
        case 'hr':
          // 用户不需要导出分隔横线：仅作为段落边界断开，不输出线条
          emit()
          return
        case 'div': case 'section': case 'article':
          for (const c of Array.from(el.childNodes)) handle(c)
          return
        case 'img': {
          // 叶子元素：buildInline 只处理其子节点，直接传 <img> 会返回空 → 图被丢（显示成空格）
          const d = drawingFor(el)
          if (d) acc.push(`<w:r>${rprXml(baseRpr)}${d}</w:r>`)
          return
        }
        case 'br':
          acc.push(`<w:r>${rprXml(baseRpr)}<w:br/></w:r>`)
          return
        default:
          // 带子节点的行内元素（strong/em/code/a/span/mjx…）：buildInline 处理其子节点并应用样式
          acc.push(buildInline(el, baseRpr))
      }
    }

    for (const c of Array.from(node.childNodes)) handle(c)
    emit()
    return paras.join('')
  }

  /** 无序/有序列表：按普通正文段落输出，标记文字（"- " / "1. "）保留在首行，续行靠左 */
  function listBlock(el: Element, kind: 'bullet' | 'number', depth: number): string {
    let out = ''
    let counter = 1
    for (const li of Array.from(el.children)) {
      if (li.tagName.toLowerCase() !== 'li') continue
      const prefix = kind === 'bullet' ? '- ' : `${counter}. `
      out += looseChildrenXml(li, { plain: true, marker: prefix })
      counter++
    }
    return out
  }

  /** 引用块：按普通正文段落处理（继承首行缩进，去掉整块左缩进/底纹/斜体） */
  function blockquoteXml(el: Element): string {
    return looseChildrenXml(el, { plain: true })
  }

  // ===== 表格：按内容布局宽度分配列宽（不做平均分配） =====
  const MEASURE_TAGS = new Set(['p', 'div', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'blockquote', 'pre', 'section', 'article', 'table', 'tr', 'td', 'th', 'figure', 'hr'])

  let measureCtx: CanvasRenderingContext2D | null = null
  function getMeasureFont(): string {
    try {
      const f = getComputedStyle(document.body).font
      if (f && f !== 'normal') return f
    } catch { /* ignore */ }
    return '14px "Microsoft YaHei", "Segoe UI", Arial, sans-serif'
  }
  function textFallbackPx(t: string): number {
    // canvas 不可用时的字符宽度估算（CJK/全角≈2，ASCII≈1）
    let units = 0
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i)
      units += ((c > 0x2e7f && c < 0xa000) || (c >= 0xff00 && c <= 0xff60) || (c >= 0x3000 && c <= 0x303f)) ? 2 : 1
    }
    return units * 7
  }
  function measureTextPx(t: string): number {
    if (!t) return 0
    try {
      if (!measureCtx) {
        const cv = document.createElement('canvas')
        measureCtx = cv.getContext('2d')
      }
      if (measureCtx) {
        measureCtx.font = getMeasureFont()
        const w = measureCtx.measureText(t).width
        if (w > 0) return w
      }
    } catch { /* fallback */ }
    return textFallbackPx(t)
  }
  function imgCellWidthPx(img: Element): number {
    // 公式图按目标显示宽折算（限宽），普通图取固定估算
    const emuW = parseFloat(img.getAttribute('data-emu-w') || '')
    if (emuW > 0) return Math.min(emuW / 9525, 900)
    return 150
  }
  /** 估算单元格内容在单行下的最大像素宽度（决定该列占比） */
  function estimateCellWeight(cell: Element): number {
    let best = 0
    let cur = 0
    const flush = () => { if (cur > best) best = cur; cur = 0 }
    const addText = (t: string) => { if (t) cur += measureTextPx(t) }
    const walk = (node: Node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) { addText(child.textContent || ''); continue }
        if (child.nodeType !== 1) continue
        const el = child as Element
        const tag = el.tagName.toLowerCase()
        if (tag === 'br') { flush(); continue }
        if (tag === 'img') { cur += imgCellWidthPx(el); continue }
        // 原生公式：用其纯文本近似宽度（Word 侧数学区间距会再宽松一些）
        if (el.hasAttribute('data-omml-id')) {
          cur += measureTextPx(el.getAttribute('data-omml-text') || '') * 1.15 + 16
          continue
        }
        if (tag === 'mjx-container' || tag === 'mjx-math' || tag === 'math' || tag === 'svg') { cur += 80; continue }
        if (MEASURE_TAGS.has(tag)) { flush(); walk(el); flush(); continue }
        walk(el)
      }
    }
    walk(cell)
    flush()
    return best
  }
  /**
   * 按内容分配列宽：每列至少保留内容所需宽度，多余宽度再均分。
   * （旧版把总宽按权重等比分配，短列会被超长列挤压成细条，如 P1/【待补充】列）
   */
  function distributeColWidths(colCount: number, weights: number[], avail?: number): number[] {
    const AVAIL = avail ?? PAGE.contentWTw // 版心宽（按模板）
    const PX_TO_TW = 16 // 1 屏幕像素≈16 twip（略留余量，避免 Word 处换行）
    const CELL_PAD = 216 // 单元格左右边距(108×2)，保证文字不被裁切
    // 每列“内容自然宽”：实测像素×16 + 单元格左右边距
    const natural = weights.map((w) => (w > 0 ? Math.round(w * PX_TO_TW) + CELL_PAD : 0))
    const total = natural.reduce((a, b) => a + b, 0)
    if (!(total > 0)) {
      // 全空内容才退回平均
      const base = Math.floor(AVAIL / colCount)
      return natural.map((_, i) => (i === colCount - 1 ? AVAIL - base * (colCount - 1) : base))
    }
    const out: number[] = []
    if (total >= AVAIL) {
      // 内容总宽超出一页：按比例缩到内容区内，避免表格溢出页面
      let acc = 0
      for (let i = 0; i < colCount; i++) {
        if (i === colCount - 1) {
          out.push(Math.max(0, AVAIL - acc))
          break
        }
        const v = Math.max(1, Math.round((AVAIL * natural[i]) / total))
        out.push(v)
        acc += v
      }
      return out
    }
    // 常规：每列先占内容宽，再把剩余宽度均分（首/末短列不会被挤压成细条）
    const extra = AVAIL - total
    const per = Math.floor(extra / colCount)
    let rem = extra - per * colCount
    let acc = 0
    for (let i = 0; i < colCount; i++) {
      if (i === colCount - 1) {
        out.push(Math.max(0, AVAIL - acc))
        break
      }
      let v = natural[i] + per
      if (rem > 0) {
        v += 1
        rem -= 1
      }
      out.push(v)
      acc += v
    }
    return out
  }

  function tableBlock(el: Element): string {
    const rows = Array.from(el.querySelectorAll('tr'))
    if (!rows.length) return ''
    const rowsCells = rows.map((tr) => Array.from(tr.children))
    const colCount = Math.max(1, ...rowsCells.map((cs) => cs.length))
    // 1) 统计每列内容权重：取该列最宽单元格的估算宽度，避免平均分列
    const weights = new Array<number>(colCount).fill(0)
    rowsCells.forEach((cells) => cells.forEach((cell, ci) => {
      if (ci >= colCount) return
      const w = estimateCellWeight(cell)
      if (w > weights[ci]) weights[ci] = w
    }))
    // 2) 按权重把内容区宽度分配给各列
    const colW = distributeColWidths(colCount, weights, PAGE.contentWTw)
    const tableW = colW.reduce((a, b) => a + b, 0)
    const borders = `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="AAAAAA"/>`).join('')}</w:tblBorders>`
    // 单元格边距近似 HTML 的 padding（6px 纵 / 10px 横），观感接近预览
    const cellMar = '<w:tblCellMar><w:top w:w="57" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="57" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar>'
    const rowsXml = rowsCells.map((cells) => {
      let cellXml = ''
      cells.forEach((cell, ci) => {
        const isHeader = cell.tagName.toLowerCase() === 'th'
        const fill = isHeader ? 'EFEFEF' : 'auto'
        // 单元格常用 looseChildrenXml：行内文本 + 行内公式图合成为一个段落，
        // 不再像 buildBlocks 那样把每个文本节点/公式图拆成独立（居中）段落导致文字频繁换行
        const cellContent = looseChildrenXml(cell, {})
        const w = colW[Math.min(ci, colW.length - 1)]
        cellXml += `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/><w:shd w:val="clear" w:fill="${fill}"/></w:tcPr>${cellContent || '<w:p/>'}</w:tc>`
      })
      return `<w:tr>${cellXml}</w:tr>`
    }).join('')
    const grid = colW.map((w) => `<w:gridCol w:w="${w}"/>`).join('')
    // fixed 布局 + 显式列宽：各查看器都按内容占比显示，而非平均分配
    return `<w:tbl><w:tblPr><w:tblW w:w="${tableW}" w:type="dxa"/><w:tblLayout w:type="fixed"/>${cellMar}${borders}</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rowsXml}</w:tbl>`
  }

  function buildBlocks(node: Node, depth: number): string {
    let out = ''
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const t = (child.textContent || '').trim()
        // 文本节点直接输出 run（不能走 buildInline，文本节点无子节点会返回空）
        if (t) out += paragraph(`<w:r><w:t xml:space="preserve">${escapeXml(t)}</w:t></w:r>`)
        continue
      }
      if (child.nodeType !== 1) continue
      const el = child as Element
      const tag = el.tagName.toLowerCase()
      // 原生公式（OMML）：展示公式单独成段居中，行内公式按普通段落输出
      const om = ommlOf(el)
      if (om) {
        out += el.getAttribute('data-omml-display') === '1' ? displayMathParagraph(om) : paragraph(om)
        continue
      }
      switch (tag) {
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
          const level = tag[1]
          out += `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr>${buildInline(el, {})}</w:p>`
          break
        }
        case 'p': out += paragraph(buildInline(el, {})); break
        case 'blockquote': out += blockquoteXml(el); break
        case 'pre': out += codeBlock(el); break
        case 'ul': out += listBlock(el, 'bullet', 0); break
        case 'ol': out += listBlock(el, 'number', 0); break
        case 'table': out += tableBlock(el); break
        case 'hr':
          // 用户不需要导出分隔横线，直接跳过
          break
        case 'figure': {
          const img = el.querySelector('img')
          const cap = el.querySelector('figcaption')
          const d = img ? drawingFor(img) : ''
          if (d) out += `<w:p><w:pPr><w:jc w:val="center"/><w:ind w:firstLineChars="0" w:firstLine="0"/></w:pPr><w:r>${d}</w:r></w:p>`
          if (cap && cap.textContent?.trim()) {
            out += `<w:p><w:pPr><w:jc w:val="center"/><w:ind w:firstLineChars="0" w:firstLine="0"/></w:pPr><w:r><w:rPr><w:color w:val="808080"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${escapeXml(cap.textContent.trim())}</w:t></w:r></w:p>`
          }
          break
        }
        case 'img': {
          const d = drawingFor(el)
          if (d) out += `<w:p><w:pPr><w:jc w:val="center"/><w:ind w:firstLineChars="0" w:firstLine="0"/></w:pPr><w:r>${d}</w:r></w:p>`
          break
        }
        case 'div': case 'section': case 'article': case 'main': case 'header': case 'footer':
          out += buildBlocks(child, depth)
          break
        default:
          out += paragraph(buildInline(el, {}))
      }
    }
    return out
  }

  const bodyXml = buildBlocks(doc.body, 0)

  // ===== 关系文件 =====
  const relsEntries = [
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
  ]
  if (themeRid) {
    relsEntries.unshift(
      `<Relationship Id="${themeRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>`
    )
  }
  for (const [, info] of ridToInfo) {
    const im = images[info.idx]
    relsEntries.push(
      `<Relationship Id="${info.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${info.idx + 1}.${im.ext}"/>`
    )
  }
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relsEntries.join('')}</Relationships>`

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>${bodyXml}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="${PAGE.topTw}" w:right="${PAGE.rightTw}" w:bottom="${PAGE.bottomTw}" w:left="${PAGE.leftTw}" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
</w:body>
</w:document>`

  return { documentXml, rels }
}

// ===== 常量 XML =====

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`

const DEFAULT_STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="仿宋"/><w:sz w:val="32"/><w:color w:val="000000"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:line="580" w:lineRule="atLeast"/><w:ind w:firstLineChars="200" w:firstLine="640"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:ind w:firstLineChars="0" w:firstLine="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="方正小标宋简体"/><w:sz w:val="44"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:ind w:firstLineChars="0" w:firstLine="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="黑体"/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:ind w:firstLineChars="0" w:firstLine="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="楷体"/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:ind w:firstLineChars="0" w:firstLine="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="仿宋"/><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:ind w:firstLineChars="0" w:firstLine="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="仿宋"/><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading6"><w:name w:val="heading 6"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:ind w:firstLineChars="0" w:firstLine="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="仿宋"/><w:b/><w:sz w:val="24"/></w:rPr></w:style>
</w:styles>`

// 向后兼容别名（旧代码引用）
const STYLES_XML = DEFAULT_STYLES_XML

// ===== 中文论文样式（参考国标/期刊：正文小四宋体、1.5倍行距、首行缩进2字符） =====
const CN_STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="24"/><w:color w:val="000000"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:line="360" w:lineRule="auto"/><w:ind w:firstLineChars="200" w:firstLine="480"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:ind w:firstLineChars="0" w:firstLine="0"/><w:spacing w:before="240" w:after="240" w:line="360" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="黑体"/><w:sz w:val="44"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:ind w:firstLineChars="0" w:firstLine="0"/><w:spacing w:before="120" w:after="120" w:line="360" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="黑体"/><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:ind w:firstLineChars="0" w:firstLine="0"/><w:spacing w:line="360" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="楷体"/><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:ind w:firstLineChars="0" w:firstLine="0"/><w:spacing w:line="360" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:ind w:firstLineChars="0" w:firstLine="0"/><w:spacing w:line="360" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/><w:b/><w:sz w:val="21"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading6"><w:name w:val="heading 6"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:ind w:firstLineChars="0" w:firstLine="0"/><w:spacing w:line="360" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/><w:b/><w:sz w:val="21"/></w:rPr></w:style>
</w:styles>`

// ===== 英文论文样式（APA 7th：Times New Roman 12pt、双倍行距、段落首行 0.5in） =====
const EN_STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="24"/><w:color w:val="000000"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:line="480" w:lineRule="auto"/><w:ind w:firstLine="720"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:line="480" w:lineRule="auto"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:ind w:firstLine="0"/><w:spacing w:line="480" w:lineRule="auto"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:ind w:firstLine="0"/><w:spacing w:line="480" w:lineRule="auto"/></w:pPr><w:rPr><w:b/><w:i/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:ind w:firstLine="0"/><w:spacing w:line="480" w:lineRule="auto"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:ind w:firstLine="0"/><w:spacing w:line="480" w:lineRule="auto"/></w:pPr><w:rPr><w:i/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading6"><w:name w:val="heading 6"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:ind w:firstLine="0"/><w:spacing w:line="480" w:lineRule="auto"/></w:pPr><w:rPr><w:i/><w:sz w:val="24"/></w:rPr></w:style>
</w:styles>`

// ===== 模板注册表（设置页可选；公文为默认） =====
export const WORD_EXPORT_TEMPLATES: DocxTemplatePreset[] = [
  { key: 'gongwen', labelZh: '公文（GB/T 9704-2012）', labelEn: 'Official (GB/T 9704-2012)', stylesXml: DEFAULT_STYLES_XML, page: GONGWEN_PAGE },
  { key: 'cn', labelZh: '中文论文', labelEn: 'Chinese Paper', stylesXml: CN_STYLES_XML, page: INCH_PAGE },
  { key: 'en', labelZh: '英文论文（APA 7th）', labelEn: 'English Paper (APA 7th)', stylesXml: EN_STYLES_XML, page: INCH_PAGE },
  { key: 'custom', labelZh: '自定义 Word 模板', labelEn: 'Custom Word Template', stylesXml: null, page: GONGWEN_PAGE },
]

/** 按 key 取模板预设；未匹配回退公文模板 */
export function getDocxTemplatePreset(key?: string | null): DocxTemplatePreset {
  return WORD_EXPORT_TEMPLATES.find((t) => t.key === key) || WORD_EXPORT_TEMPLATES[0]
}

function buildContentTypes(images: DocxImage[], hasTheme: boolean): string {
  const exts = new Set(images.map(im => im.ext))
  let defaults = '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
  for (const e of exts) {
    const ct = extContentType(e)
    if (ct) defaults += `<Default Extension="${e}" ContentType="${ct}"/>`
  }
  const themeOverride = hasTheme ? '<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' : ''
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults}${themeOverride}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`
}

// ===== 工具函数 =====

/**
 * 行内字符格式标记（对应 `<strong>`/`<em>`/`<code>`/`<a>`/`<mark>`/`<del>` 等）。
 * 用对象累积而非字符串拼接：OOXML 的 `CT_RPr` 对子元素顺序敏感
 * （rFonts → b → i → strike → color → sz → highlight → u → shd），
 * 乱序会让 Word 报“内容有问题”，也会导致加粗等格式被忽略。
 */
interface RprFlags {
  /** 加粗（md `**…**`） */
  b?: boolean
  /** 斜体（md `*…*`） */
  i?: boolean
  /** 删除线（md `~~…~~`） */
  strike?: boolean
  /** 字体颜色（十六进制，不带 #，如 0563C1） */
  color?: string
  /** 半磅字号（如 20 = 10pt；Word 正文默认 24 = 12pt） */
  sz?: number
  /** 高亮底色（w:highlight，如 yellow；md `==…==`） */
  highlight?: string
  /** 下划线（链接） */
  u?: boolean
  /** 字符底纹填充色（行内代码） */
  shd?: string
  /** 等宽字体（行内代码） */
  mono?: boolean
}

/** 把字符格式序列化为 `<w:rPr>…</w:rPr>`；无格式时返回空串（不生成空 rPr 元素） */
function rprXml(f: RprFlags): string {
  const parts: string[] = []
  if (f.mono) parts.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>')
  if (f.b) parts.push('<w:b/>')
  if (f.i) parts.push('<w:i/>')
  if (f.strike) parts.push('<w:strike/>')
  if (f.color) parts.push(`<w:color w:val="${f.color}"/>`)
  if (f.sz) parts.push(`<w:sz w:val="${f.sz}"/>`)
  if (f.highlight) parts.push(`<w:highlight w:val="${f.highlight}"/>`)
  if (f.u) parts.push('<w:u w:val="single"/>')
  if (f.shd) parts.push(`<w:shd w:val="clear" w:fill="${f.shd}"/>`)
  return parts.length ? `<w:rPr>${parts.join('')}</w:rPr>` : ''
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/** 根据 URL 扩展名猜测图片 MIME 类型 */
function guessMimeFromUrl(url: string): string {
  const m = /\.(png|jpe?g|gif|webp|bmp|svg|tiff?)$/i.exec(url.split('?')[0] || '')
  if (!m) return ''
  const ext = m[1].toLowerCase().replace('jpeg', 'jpg')
  return extContentType(ext)
}

function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/tiff': 'tiff',
  }
  return map[mime] || 'png'
}

function extContentType(ext: string): string {
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', tiff: 'image/tiff',
  }
  return map[ext] || ''
}

function loadImageSize(dataUrl: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    const done = (w: number, h: number) => resolve({ w, h })
    const timer = setTimeout(() => { img.src = ''; done(400, 300) }, 3000)
    img.onload = () => { clearTimeout(timer); done(img.naturalWidth || 400, img.naturalHeight || 300) }
    img.onerror = () => { clearTimeout(timer); done(400, 300) }
    img.src = dataUrl
  })
}

// ===== ZIP 写入器 =====

let crcTable: Uint32Array | null = null
function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable
  crcTable = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  return crcTable
}

function crc32(data: Uint8Array): number {
  const table = getCrcTable()
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

async function deflateRaw(data: Uint8Array): Promise<{ data: Uint8Array; method: number }> {
  const CS = (globalThis as any).CompressionStream
  if (typeof CS !== 'undefined') {
    try {
      const cs = new CS('deflate-raw')
      const writer = cs.writable.getWriter()
      writer.write(data)
      writer.close()
      const buf = await new Response(cs.readable).arrayBuffer()
      return { data: new Uint8Array(buf), method: 8 }
    } catch {
      // 回退到不压缩
    }
  }
  return { data, method: 0 }
}

async function buildZip(files: { name: string; data: Uint8Array }[]): Promise<Blob> {
  const encoder = new TextEncoder()
  const now = new Date()
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff

  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0

  for (const f of files) {
    const nameBytes = encoder.encode(f.name)
    const { data: compData, method } = await deflateRaw(f.data)
    const crc = crc32(f.data)

    const local = new Uint8Array(30 + nameBytes.length + compData.length)
    const dv = new DataView(local.buffer)
    dv.setUint32(0, 0x04034b50, true)
    dv.setUint16(4, 20, true)
    dv.setUint16(6, 0, true)
    dv.setUint16(8, method, true)
    dv.setUint16(10, dosTime, true)
    dv.setUint16(12, dosDate, true)
    dv.setUint32(14, crc, true)
    dv.setUint32(18, compData.length, true)
    dv.setUint32(22, f.data.length, true)
    dv.setUint16(26, nameBytes.length, true)
    dv.setUint16(28, 0, true)
    local.set(nameBytes, 30)
    local.set(compData, 30 + nameBytes.length)

    const central = new Uint8Array(46 + nameBytes.length)
    const cdv = new DataView(central.buffer)
    cdv.setUint32(0, 0x02014b50, true)
    cdv.setUint16(4, 20, true)
    cdv.setUint16(6, 20, true)
    cdv.setUint16(8, 0, true)
    cdv.setUint16(10, method, true)
    cdv.setUint16(12, dosTime, true)
    cdv.setUint16(14, dosDate, true)
    cdv.setUint32(16, crc, true)
    cdv.setUint32(20, compData.length, true)
    cdv.setUint32(24, f.data.length, true)
    cdv.setUint16(28, nameBytes.length, true)
    cdv.setUint16(30, 0, true)
    cdv.setUint16(32, 0, true)
    cdv.setUint16(34, 0, true)
    cdv.setUint16(36, 0, true)
    cdv.setUint32(38, 0, true)
    cdv.setUint32(42, offset, true)
    central.set(nameBytes, 46)

    localParts.push(local)
    centralParts.push(central)
    offset += local.length
  }

  const cdSize = centralParts.reduce((s, p) => s + p.length, 0)
  const eocd = new Uint8Array(22)
  const edv = new DataView(eocd.buffer)
  edv.setUint32(0, 0x06054b50, true)
  edv.setUint16(4, 0, true)
  edv.setUint16(6, 0, true)
  edv.setUint16(8, files.length, true)
  edv.setUint16(10, files.length, true)
  edv.setUint32(12, cdSize, true)
  edv.setUint32(16, offset, true)
  edv.setUint16(20, 0, true)

  const allParts: BlobPart[] = []
  // 注：不同 TS 版本对 Uint8Array 泛型（ArrayBufferLike/ArrayBuffer）处理不一致，
  // 用 as unknown as 断言保证旧版（非泛型 Uint8Array）与新版的 BlobPart 检查都能通过
  for (const p of localParts) allParts.push(p as unknown as BlobPart)
  for (const p of centralParts) allParts.push(p as unknown as BlobPart)
  allParts.push(eocd as unknown as BlobPart)
  return new Blob(allParts, {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
}
