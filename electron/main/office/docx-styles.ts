/**
 * docx 样式定义与字符格式编辑（M1.3，纯 Node / 零第三方依赖）
 *
 * 在 docx-blocks 的「块级编辑」之上补齐样式能力：
 *  - listStyles     读取 styles.xml 全部样式（格式摘要 + 正文引用次数）
 *  - createStyle    新建段落 / 字符样式（基于样式、字体字号、段距缩进、大纲级别…）
 *  - updateStyle    修改已有样式定义（改完正文中所有引用该样式的段落立即变样）
 *  - deleteStyle    删除样式（默认拒绝删除仍被正文引用的样式）
 *  - setTextFormat  给某段（或其中被查找命中的文字）加字符格式（粗体 / 字号 / 字体 / 颜色…）
 *
 * styles.xml 改动直接写回 pkg.entries —— docx-editor 的 buildDocxBuffer / saveDocxPackage
 * 整包重打包会带上，无需改保存流程。
 */
import { readPackageEntryText, writePackageEntryText, type DocxPackage } from './docx-editor'
import { encodeXml, splitParagraph, styleCatalog } from './docx-blocks'
import { bodyLayout, decodeXmlEntities, tagEnd, type LocatedBlock } from './docx-reader'

// ==================== OOXML 子元素顺序（必须守序，否则 Word 可能忽略） ====================

const STYLE_ORDER = [
  'w:name', 'w:aliases', 'w:basedOn', 'w:next', 'w:link', 'w:autoRedefine', 'w:hidden', 'w:uiPriority',
  'w:semiHidden', 'w:unhideWhenUsed', 'w:qFormat', 'w:locked', 'w:personal', 'w:personalCompose',
  'w:personalReply', 'w:rsid', 'w:pPr', 'w:rPr', 'w:tblPr', 'w:trPr', 'w:tcPr', 'w:tblStylePr',
]

const RPR_ORDER = [
  'w:rStyle', 'w:rFonts', 'w:b', 'w:bCs', 'w:i', 'w:iCs', 'w:caps', 'w:smallCaps', 'w:strike', 'w:dstrike',
  'w:outline', 'w:shadow', 'w:emboss', 'w:imprint', 'w:noProof', 'w:snapToGrid', 'w:vanish', 'w:webHidden',
  'w:color', 'w:spacing', 'w:w', 'w:kern', 'w:position', 'w:sz', 'w:szCs', 'w:highlight', 'w:u', 'w:effect',
  'w:bdr', 'w:shd', 'w:fitText', 'w:vertAlign', 'w:rtl', 'w:cs', 'w:em', 'w:lang', 'w:eastAsianLayout',
  'w:specVanish', 'w:oMath',
]

const PPR_ORDER = [
  'w:pStyle', 'w:keepNext', 'w:keepLines', 'w:pageBreakBefore', 'w:framePr', 'w:widowControl', 'w:numPr',
  'w:suppressLineNumbers', 'w:pBdr', 'w:shd', 'w:tabs', 'w:suppressAutoHyphens', 'w:kinsoku', 'w:wordWrap',
  'w:overflowPunct', 'w:topLinePunct', 'w:autoSpaceDE', 'w:autoSpaceDN', 'w:bidi', 'w:adjustRightInd',
  'w:snapToGrid', 'w:spacing', 'w:ind', 'w:contextualSpacing', 'w:mirrorIndents', 'w:suppressOverlap',
  'w:jc', 'w:textDirection', 'w:textAlignment', 'w:textboxTightWrap', 'w:outlineLvl', 'w:divId',
  'w:cnfStyle', 'w:rPr', 'w:sectPr', 'w:pPrChange',
]

// ==================== XML 小工具 ====================

/** 去掉容器内某标签的全部出现（自闭合或成对） */
function stripTag(inner: string, tag: string): string {
  const one = `<${tag}\\b[^>]*/>`, pair = `<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`
  return inner.replace(new RegExp(`${one}|${pair}`, 'g'), '')
}

/** 按 OOXML 顺序把自闭合子元素插到容器内合适位置 */
function insertInOrder(inner: string, tag: string, xml: string, order: string[]): string {
  const myIdx = order.indexOf(tag)
  const re = /<([A-Za-z0-9:]+)\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(inner)) !== null) {
    const i = order.indexOf(m[1])
    if (i >= 0 && myIdx >= 0 && i > myIdx) return inner.slice(0, m.index) + xml + inner.slice(m.index)
  }
  return inner + xml
}

/** 容器内 upsert 若干自闭合子元素（先全删后按序插入） */
function upsert(inner: string, entries: Array<{ tag: string; xml: string }>, order: string[]): string {
  let out = inner
  for (const e of entries) out = stripTag(out, e.tag)
  for (const e of entries) out = insertInOrder(out, e.tag, e.xml, order)
  return out
}

/** 取容器（如 w:rPr / w:pPr）内层 xml；不存在返回 null */
function containerInner(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml)
  return m ? m[1] : null
}

/** 设置容器内容（content 为 null / 空 → 删除容器） */
function setContainer(inner: string, tag: string, content: string | null, order: string[]): string {
  let out = stripTag(inner, tag)
  if (content) out = insertInOrder(out, tag, `<${tag}>${content}</${tag}>`, order)
  return out
}

const HIGHLIGHTS = ['yellow', 'green', 'cyan', 'magenta', 'blue', 'red', 'darkblue', 'darkcyan', 'darkgreen',
  'darkmagenta', 'darkred', 'darkyellow', 'darkgray', 'lightgray', 'black', 'white', 'none']
const UNDERLINES = ['none', 'single', 'double', 'thick', 'dotted', 'dottedheavy', 'dash', 'dashedheavy',
  'dotdash', 'dotdashheavy', 'dotdotdash', 'dotdotdashheavy', 'wave', 'wavyheavy', 'wavydouble']

function normColor(v: unknown): string | undefined {
  const s = String(v ?? '').trim().replace(/^#/, '').toUpperCase()
  return /^[0-9A-F]{6}$/.test(s) ? s : undefined
}

function normHighlight(v: unknown): string | undefined {
  const s = String(v ?? '').trim().replace(/[\s_-]/g, '').toLowerCase()
  return s && HIGHLIGHTS.includes(s) ? s : undefined
}

function normUnderline(v: unknown): string | undefined {
  if (v === true) return 'single'
  if (v === false) return 'none'
  const s = String(v ?? '').trim().replace(/[\s_-]/g, '').toLowerCase()
  return s && UNDERLINES.includes(s) ? s : undefined
}

/** 对齐方式归一（justify → both） */
function normAlign(v: unknown): string | undefined {
  const s = String(v ?? '').trim().toLowerCase()
  if (s === 'justify' || s === 'justified') return 'both'
  return ['left', 'center', 'right', 'both', 'distribute'].includes(s) ? s : undefined
}

// ==================== 格式描述 → OOXML ====================

/** 字符级格式（段落样式与 run 级共用） */
export interface RunFormat {
  /** 中文字体（eastAsia）；只给 font 时西文也用同一字体 */
  font?: string
  /** 西文字体（ascii / hAnsi） */
  fontAscii?: string
  fontHAnsi?: string
  /** 字号（磅，如 16 = 三号） */
  fontSize?: number
  bold?: boolean
  italic?: boolean
  strike?: boolean
  underline?: boolean | string
  /** 字体颜色，如 "1F4E79" / "#FF0000" */
  color?: string
  /** 底纹高亮，如 yellow / green / none */
  highlight?: string
}

/** 样式定义可用的全部格式（= 字符格式 + 段落格式 + 样式元信息） */
export interface StyleFormat extends RunFormat {
  name?: string
  type?: 'paragraph' | 'character'
  /** 基于哪个样式（如 "Normal" / "正文"） */
  basedOn?: string
  /** 该样式段落结束后，下一段套用的样式 */
  next?: string
  /** 是否加入样式库快捷列表（默认 true） */
  quickFormat?: boolean
  /** 对齐：left / center / right / both（居中、两端对齐…） */
  align?: string
  /** 行距倍数（如 1.5），与 lineSpacingExact 二选一 */
  lineSpacing?: number
  /** 固定行距（磅） */
  lineSpacingExact?: number
  /** 段前间距（磅） */
  spaceBefore?: number
  /** 段后间距（磅） */
  spaceAfter?: number
  /** 首行缩进（字符数，正文常用 2） */
  firstLineIndent?: number
  /** 左缩进（字符数） */
  leftIndent?: number
  /** 右缩进（字符数） */
  rightIndent?: number
  /** 大纲级别 1-9（决定是否进导航窗格；1 级=标题 1 级别） */
  outlineLevel?: number
  keepNext?: boolean
  keepLines?: boolean
  pageBreakBefore?: boolean
}

function rFontsXml(f: StyleFormat): string | null {
  const ea = f.font === undefined ? '' : String(f.font).trim()
  const ascii = String(f.fontAscii ?? ea).trim()
  const hAnsi = String(f.fontHAnsi ?? f.fontAscii ?? ea).trim()
  if (!ea && !ascii && !hAnsi) return null
  const a: string[] = []
  if (ascii) a.push(`w:ascii="${encodeXml(ascii)}"`)
  if (hAnsi) a.push(`w:hAnsi="${encodeXml(hAnsi)}"`)
  if (ea) a.push(`w:eastAsia="${encodeXml(ea)}"`)
  if (ascii) a.push(`w:cs="${encodeXml(ascii)}"`)
  return `<w:rFonts ${a.join(' ')}/>`
}

/** 字符格式 → rPr 子元素（按 RPR_ORDER 顺序） */
function rprEntries(f: StyleFormat, warn?: (m: string) => void): Array<{ tag: string; xml: string }> {
  const out: Array<{ tag: string; xml: string }> = []
  const rf = rFontsXml(f)
  if (rf) out.push({ tag: 'w:rFonts', xml: rf })
  if (f.bold !== undefined) out.push({ tag: 'w:b', xml: f.bold ? '<w:b/>' : '<w:b w:val="0"/>' })
  if (f.italic !== undefined) out.push({ tag: 'w:i', xml: f.italic ? '<w:i/>' : '<w:i w:val="0"/>' })
  if (f.strike !== undefined) out.push({ tag: 'w:strike', xml: f.strike ? '<w:strike/>' : '<w:strike w:val="0"/>' })
  if (f.color !== undefined) {
    const c = normColor(f.color)
    if (c) out.push({ tag: 'w:color', xml: `<w:color w:val="${c}"/>` })
    else warn?.(`颜色「${f.color}」不是 6 位十六进制（如 1F4E79 / #FF0000），已忽略`)
  }
  if (f.fontSize !== undefined) {
    const pt = Number(f.fontSize)
    if (Number.isFinite(pt) && pt > 0) {
      const sz = Math.max(2, Math.round(pt * 2))
      out.push({ tag: 'w:sz', xml: `<w:sz w:val="${sz}"/>` })
      out.push({ tag: 'w:szCs', xml: `<w:szCs w:val="${sz}"/>` })
    } else warn?.(`字号「${f.fontSize}」无效（应为磅值，如 16），已忽略`)
  }
  if (f.highlight !== undefined) {
    const hl = normHighlight(f.highlight)
    if (hl) out.push({ tag: 'w:highlight', xml: `<w:highlight w:val="${hl}"/>` })
    else warn?.(`高亮色「${f.highlight}」不支持（可用 yellow/green/cyan/red/blue… 或 none），已忽略`)
  }
  if (f.underline !== undefined) {
    const u = normUnderline(f.underline)
    if (u) out.push({ tag: 'w:u', xml: `<w:u w:val="${u}"/>` })
    else warn?.(`下划线「${f.underline}」不支持（true/false 或 single/double/dotted…），已忽略`)
  }
  return out
}

/** 段落格式 → pPr 子元素（按 PPR_ORDER 顺序） */
function pprEntries(f: StyleFormat, warn?: (m: string) => void): Array<{ tag: string; xml: string }> {
  const out: Array<{ tag: string; xml: string }> = []
  if (f.keepNext !== undefined) out.push({ tag: 'w:keepNext', xml: f.keepNext ? '<w:keepNext/>' : '<w:keepNext w:val="0"/>' })
  if (f.keepLines !== undefined) out.push({ tag: 'w:keepLines', xml: f.keepLines ? '<w:keepLines/>' : '<w:keepLines w:val="0"/>' })
  if (f.pageBreakBefore !== undefined) out.push({ tag: 'w:pageBreakBefore', xml: f.pageBreakBefore ? '<w:pageBreakBefore/>' : '<w:pageBreakBefore w:val="0"/>' })

  const sp: string[] = []
  if (f.spaceBefore !== undefined) sp.push(`w:before="${Math.max(0, Math.round(Number(f.spaceBefore) * 20))}"`)
  if (f.spaceAfter !== undefined) sp.push(`w:after="${Math.max(0, Math.round(Number(f.spaceAfter) * 20))}"`)
  if (f.lineSpacing !== undefined && f.lineSpacingExact === undefined) {
    sp.push(`w:line="${Math.max(1, Math.round(Number(f.lineSpacing) * 240))}"`, 'w:lineRule="auto"')
  } else if (f.lineSpacingExact !== undefined) {
    sp.push(`w:line="${Math.max(1, Math.round(Number(f.lineSpacingExact) * 20))}"`, 'w:lineRule="exact"')
  }
  if (sp.length) out.push({ tag: 'w:spacing', xml: `<w:spacing ${sp.join(' ')}/>` })

  const ind: string[] = []
  const perChar = (f.fontSize && Number(f.fontSize) > 0 ? Number(f.fontSize) : 10.5) * 20
  if (f.firstLineIndent !== undefined) {
    const n = Number(f.firstLineIndent)
    ind.push(`w:firstLineChars="${Math.round(n * 100)}"`, `w:firstLine="${Math.round(n * perChar)}"`)
  }
  if (f.leftIndent !== undefined) {
    const n = Number(f.leftIndent)
    ind.push(`w:leftChars="${Math.round(n * 100)}"`, `w:left="${Math.round(n * perChar)}"`)
  }
  if (f.rightIndent !== undefined) {
    const n = Number(f.rightIndent)
    ind.push(`w:rightChars="${Math.round(n * 100)}"`, `w:right="${Math.round(n * perChar)}"`)
  }
  if (ind.length) out.push({ tag: 'w:ind', xml: `<w:ind ${ind.join(' ')}/>` })

  if (f.align !== undefined) {
    const jc = normAlign(f.align)
    if (jc) out.push({ tag: 'w:jc', xml: `<w:jc w:val="${jc}"/>` })
    else warn?.(`对齐「${f.align}」不支持（left/center/right/both），已忽略`)
  }
  if (f.outlineLevel !== undefined) {
    const lv = Math.round(Number(f.outlineLevel))
    if (lv >= 1 && lv <= 9) out.push({ tag: 'w:outlineLvl', xml: `<w:outlineLvl w:val="${lv - 1}"/>` })
    else if (lv === 0) out.push({ tag: 'w:outlineLvl', xml: '<w:outlineLvl w:val="9"/>' })
    else warn?.(`大纲级别「${f.outlineLevel}」超出 1-9，已忽略`)
  }
  return out
}

export function buildRprXml(f: StyleFormat, warn?: (m: string) => void): string {
  return rprEntries(f, warn).map(e => e.xml).join('')
}

export function buildPprXml(f: StyleFormat, warn?: (m: string) => void): string {
  return pprEntries(f, warn).map(e => e.xml).join('')
}

// ==================== styles.xml 部件 ====================

const STYLES_SKELETON =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" ' +
  'w:eastAsia="宋体" w:cs="Times New Roman"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault/></w:docDefaults></w:styles>'

/** 读 styles.xml；缺失时补建（含 Content_Types / rels 关系） */
function ensureStylesXml(pkg: DocxPackage): string | null {
  const exist = readPackageEntryText(pkg, 'word/styles.xml')
  if (exist) return exist
  const ct = readPackageEntryText(pkg, '[Content_Types].xml')
  if (ct && !/PartName="\/word\/styles\.xml"/.test(ct)) {
    writePackageEntryText(pkg, '[Content_Types].xml', ct.replace(
      '</Types>',
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'
    ))
  }
  const rels = readPackageEntryText(pkg, 'word/_rels/document.xml.rels')
  if (rels && !/Target="styles\.xml"/.test(rels)) {
    writePackageEntryText(pkg, 'word/_rels/document.xml.rels', rels.replace(
      '</Relationships>',
      '<Relationship Id="rIdStylesAIKM" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'
    ))
  }
  writePackageEntryText(pkg, 'word/styles.xml', STYLES_SKELETON)
  return STYLES_SKELETON
}

function writeStylesXml(pkg: DocxPackage, xml: string): void {
  writePackageEntryText(pkg, 'word/styles.xml', xml)
}

/** 样式定义片段（含原文，便于增量改写） */
interface StyleSeg { id: string; type: string; name: string; xml: string; start: number }

function styleSegments(stylesXml: string): StyleSeg[] {
  const out: StyleSeg[] = []
  const re = /<w:style\b[^>]*>[\s\S]*?<\/w:style>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(stylesXml)) !== null) {
    const xml = m[0]
    const id = /w:styleId="([^"]*)"/.exec(xml)?.[1]
    if (!id) continue
    out.push({
      id,
      type: /w:type="([^"]*)"/.exec(xml)?.[1] || 'paragraph',
      name: /<w:name\b[^>]*w:val="([^"]*)"/.exec(xml)?.[1] || id,
      xml,
      start: m.index,
    })
  }
  return out
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 按 ID / 显示名（忽略大小写与空格）解析样式，返回定义片段 */
function findStyleSeg(stylesXml: string, input: string): StyleSeg | undefined {
  const raw = String(input || '').trim()
  if (!raw) return undefined
  const segs = styleSegments(stylesXml)
  const byId = segs.find(s => s.id === raw)
  if (byId) return byId
  const lower = raw.toLowerCase()
  const byName = segs.find(s => s.name.trim().toLowerCase() === lower)
  if (byName) return byName
  const packed = lower.replace(/\s+/g, '')
  const byLoose = segs.find(s => s.name.trim().toLowerCase().replace(/\s+/g, '') === packed)
  return byLoose
}

/** 正文中引用某样式的次数（段落 / 字符 / 表格样式） */
function styleUsage(documentXml: string, id: string): number {
  const re = new RegExp(`w:(?:pStyle|rStyle|tblStyle)\\s+w:val="${escapeRe(id)}"`, 'g')
  return (documentXml.match(re) || []).length
}

/** 由样式名生成合法 styleId（保留中英文与数字，去空格标点） */
function makeStyleId(stylesXml: string, name: string): string {
  const ids = new Set(styleSegments(stylesXml).map(s => s.id))
  let base = String(name).trim().replace(/[^\w\u4e00-\u9fa5-]/g, '')
  if (!base) base = 'AIKMStyle'
  let id = base
  let n = 1
  while (ids.has(id)) id = `${base}${++n}`
  return id
}

// ==================== 样式格式摘要 ====================

function attrOf(xml: string, tag: string, attr: string): string | undefined {
  const seg = new RegExp(`<${tag}\\b[^>]*/>|<${tag}\\b[^>]*>`).exec(xml)?.[0]
  if (!seg) return undefined
  return new RegExp(`w:${attr}="([^"]*)"`).exec(seg)?.[1]
}

/** 从样式定义片段提取可读格式摘要 */
function summarizeStyle(segXml: string): Record<string, any> {
  const rpr = containerInner(segXml, 'w:rPr') || ''
  const ppr = containerInner(segXml, 'w:pPr') || ''
  const out: Record<string, any> = {}
  const rf = /<w:rFonts\b[^>]*\/>/.exec(rpr)?.[0] || ''
  const ea = /w:eastAsia="([^"]*)"/.exec(rf)?.[1]
  const ascii = /w:ascii="([^"]*)"/.exec(rf)?.[1]
  if (ea || ascii) out.font = ea || ascii
  if (ascii && ea && ascii !== ea) out.fontAscii = ascii
  const sz = attrOf(rpr, 'w:sz', 'val')
  if (sz) out.fontSize = Number(sz) / 2
  const flag = (tag: string) => {
    const seg = new RegExp(`<${tag}\\b[^>]*/>|<${tag}\\b[^>]*>`).exec(rpr)?.[0]
    if (!seg) return undefined
    return !/w:val="(?:0|false|none)"/.test(seg)
  }
  const b = flag('w:b'); if (b !== undefined) out.bold = b
  const i = flag('w:i'); if (i !== undefined) out.italic = i
  const st = flag('w:strike'); if (st !== undefined) out.strike = st
  const col = attrOf(rpr, 'w:color', 'val'); if (col && col !== 'auto') out.color = col
  const hl = attrOf(rpr, 'w:highlight', 'val'); if (hl && hl !== 'none') out.highlight = hl
  const jc = attrOf(ppr, 'w:jc', 'val'); if (jc) out.align = jc
  const spSeg = /<w:spacing\b[^>]*\/>/.exec(ppr)?.[0]
  if (spSeg) {
    const before = /w:before="(-?\d+)"/.exec(spSeg)?.[1]
    const after = /w:after="(-?\d+)"/.exec(spSeg)?.[1]
    const line = /w:line="(\d+)"/.exec(spSeg)?.[1]
    const rule = /w:lineRule="([^"]*)"/.exec(spSeg)?.[1]
    if (before !== undefined) out.spaceBefore = Number(before) / 20
    if (after !== undefined) out.spaceAfter = Number(after) / 20
    if (line !== undefined) {
      if (rule === 'exact' || rule === 'atLeast') out.lineSpacingExact = Number(line) / 20
      else out.lineSpacing = Math.round((Number(line) / 240) * 100) / 100
    }
  }
  const indSeg = /<w:ind\b[^>]*\/>/.exec(ppr)?.[0]
  if (indSeg) {
    const fc = /w:firstLineChars="(-?\d+)"/.exec(indSeg)?.[1]
    const lc = /w:leftChars="(-?\d+)"/.exec(indSeg)?.[1]
    if (fc !== undefined) out.firstLineIndent = Number(fc) / 100
    if (lc !== undefined) out.leftIndent = Number(lc) / 100
  }
  const ol = attrOf(ppr, 'w:outlineLvl', 'val')
  if (ol !== undefined && ol !== '9') out.outlineLevel = Number(ol) + 1
  return out
}

export interface StyleInfo {
  id: string
  name: string
  type: string
  builtin: boolean
  basedOn?: string
  next?: string
  headingLevel?: number
  usage: number
  format: Record<string, any>
  pPr?: string
  rPr?: string
}

/** 样式清单（含格式摘要与正文引用次数） */
export function listStyles(pkg: DocxPackage, opts: { detail?: boolean; type?: string } = {}): StyleInfo[] {
  const xml = readPackageEntryText(pkg, 'word/styles.xml') || ''
  const info = new Map(styleCatalog(pkg).map(s => [s.id, s]))
  const out: StyleInfo[] = []
  for (const seg of styleSegments(xml)) {
    if (opts.type && seg.type !== opts.type) continue
    const meta = info.get(seg.id)
    out.push({
      id: seg.id,
      name: seg.name,
      type: seg.type,
      builtin: !/w:customStyle="1"/.test(seg.xml),
      ...(/<w:basedOn\b[^>]*w:val="([^"]*)"/.exec(seg.xml) ? { basedOn: /<w:basedOn\b[^>]*w:val="([^"]*)"/.exec(seg.xml)![1] } : {}),
      ...(/<w:next\b[^>]*w:val="([^"]*)"/.exec(seg.xml) ? { next: /<w:next\b[^>]*w:val="([^"]*)"/.exec(seg.xml)![1] } : {}),
      ...(meta?.headingLevel !== undefined ? { headingLevel: meta.headingLevel } : {}),
      usage: styleUsage(pkg.documentXml, seg.id),
      format: summarizeStyle(seg.xml),
      ...(opts.detail !== false ? {
        ...(containerInner(seg.xml, 'w:pPr') ? { pPr: containerInner(seg.xml, 'w:pPr')! } : {}),
        ...(containerInner(seg.xml, 'w:rPr') ? { rPr: containerInner(seg.xml, 'w:rPr')! } : {}),
      } : {}),
    })
  }
  return out
}

// ==================== 样式增改删 ====================

export interface StyleResult {
  ok: boolean
  error?: string
  styleId?: string
  detail?: string
  warnings?: string[]
}

function buildStyleXml(spec: StyleFormat & { styleId: string; name: string }, warn?: (m: string) => void): string {
  const type = spec.type === 'character' ? 'character' : 'paragraph'
  const rpr = buildRprXml(spec, warn)
  const ppr = type === 'paragraph' ? buildPprXml(spec, warn) : ''
  const parts = [`<w:name w:val="${encodeXml(spec.name)}"/>`]
  if (spec.basedOn) parts.push(`<w:basedOn w:val="${encodeXml(String(spec.basedOn))}"/>`)
  if (spec.next) parts.push(`<w:next w:val="${encodeXml(String(spec.next))}"/>`)
  if (spec.quickFormat !== false) parts.push('<w:qFormat/>')
  if (ppr) parts.push(`<w:pPr>${ppr}</w:pPr>`)
  if (rpr) parts.push(`<w:rPr>${rpr}</w:rPr>`)
  return `<w:style w:type="${type}" w:customStyle="1" w:styleId="${encodeXml(spec.styleId)}">${parts.join('')}</w:style>`
}

/** 新建样式（默认段落样式） */
export function createStyle(pkg: DocxPackage, spec: StyleFormat & { styleId?: string }): StyleResult {
  const name = String(spec.name ?? '').trim()
  if (!name) return { ok: false, error: '缺少 name（样式显示名，如「本文小标题」）' }
  const warnings: string[] = []
  const warn = (m: string) => warnings.push(m)
  const xml = ensureStylesXml(pkg)
  if (!xml) return { ok: false, error: '无法读取或创建 word/styles.xml' }
  const close = xml.lastIndexOf('</w:styles>')
  if (close < 0) return { ok: false, error: 'styles.xml 结构异常（缺少 </w:styles>）' }

  const wantId = String(spec.styleId ?? '').trim()
  const segs = styleSegments(xml)
  if (wantId && segs.some(s => s.id === wantId)) {
    return { ok: false, error: `styleId「${wantId}」已存在，请改用 update_style 或换一个 ID` }
  }
  if (!wantId && segs.some(s => s.name.trim() === name)) {
    return { ok: false, error: `已存在同名样式「${name}」，请改用 update_style 修改它` }
  }
  const id = wantId || makeStyleId(xml, name)
  const styleXml = buildStyleXml({ ...spec, styleId: id, name }, warn)
  if (!containerInner(styleXml, 'w:rPr') && !containerInner(styleXml, 'w:pPr')) {
    return {
      ok: false,
      error: warnings.length
        ? `未生成任何有效格式：${warnings.join('；')}`
        : '未提供任何格式（字体 / 字号 / 加粗 / 对齐 / 段距 / 缩进…），新建的样式会是空的',
    }
  }
  writeStylesXml(pkg, xml.slice(0, close) + styleXml + xml.slice(close))
  return {
    ok: true,
    styleId: id,
    detail: `已新建${spec.type === 'character' ? '字符' : '段落'}样式「${name}」（styleId: ${id}）`,
    ...(warnings.length ? { warnings } : {}),
  }
}

/** 修改已有样式定义 */
export function updateStyle(pkg: DocxPackage, input: string, patch: StyleFormat & { newName?: string }): StyleResult {
  const xml = readPackageEntryText(pkg, 'word/styles.xml')
  if (!xml) return { ok: false, error: '该文档没有 styles.xml（可先用 create_style 新建样式）' }
  const seg = findStyleSeg(xml, input)
  if (!seg) {
    const names = styleSegments(xml).filter(s => s.type !== 'character').slice(0, 30).map(s => s.name).join('、')
    return { ok: false, error: `未找到样式「${input}」。文档现有样式（部分）：${names}` }
  }
  const warnings: string[] = []
  const warn = (m: string) => warnings.push(m)
  const changed: string[] = []
  let inner = seg.xml.slice(seg.xml.indexOf('>') + 1, seg.xml.lastIndexOf('</w:style>'))

  const newName = String(patch.newName ?? patch.name ?? '').trim()
  if (newName && newName !== seg.name) {
    inner = upsert(inner, [{ tag: 'w:name', xml: `<w:name w:val="${encodeXml(newName)}"/>` }], STYLE_ORDER)
    changed.push(`名称 → ${newName}`)
  }
  if (patch.basedOn !== undefined) {
    const base = String(patch.basedOn).trim()
    inner = base
      ? upsert(inner, [{ tag: 'w:basedOn', xml: `<w:basedOn w:val="${encodeXml(base)}"/>` }], STYLE_ORDER)
      : stripTag(inner, 'w:basedOn')
    changed.push(base ? `基于 → ${base}` : '清除「基于」')
  }
  if (patch.next !== undefined) {
    const nx = String(patch.next).trim()
    inner = nx
      ? upsert(inner, [{ tag: 'w:next', xml: `<w:next w:val="${encodeXml(nx)}"/>` }], STYLE_ORDER)
      : stripTag(inner, 'w:next')
    changed.push(nx ? `后续段落样式 → ${nx}` : '清除「后续段落样式」')
  }
  if (patch.quickFormat === true) {
    if (!/<w:qFormat\b/.test(inner)) inner = insertInOrder(inner, 'w:qFormat', '<w:qFormat/>', STYLE_ORDER)
    changed.push('加入样式库快捷列表')
  } else if (patch.quickFormat === false) {
    inner = stripTag(inner, 'w:qFormat')
    changed.push('移出样式库快捷列表')
  }

  const rEntries = rprEntries(patch, warn)
  if (rEntries.length) {
    const cur = containerInner(inner, 'w:rPr')
    inner = setContainer(inner, 'w:rPr', upsert(cur || '', rEntries, RPR_ORDER), STYLE_ORDER)
    changed.push(`字符格式（${rEntries.map(e => e.tag.replace('w:', '')).join('/')}）`)
  }
  if (seg.type !== 'character') {
    const pEntries = pprEntries(patch, warn)
    if (pEntries.length) {
      const cur = containerInner(inner, 'w:pPr')
      inner = setContainer(inner, 'w:pPr', upsert(cur || '', pEntries, PPR_ORDER), STYLE_ORDER)
      changed.push(`段落格式（${pEntries.map(e => e.tag.replace('w:', '')).join('/')}）`)
    }
  } else if (pprEntries(patch, () => { /* 字符样式无段落格式，静默忽略 */ }).length) {
    warnings.push('字符样式不支持段落格式（对齐 / 行距 / 缩进），已忽略')
  }

  if (!changed.length) {
    return {
      ok: false,
      error: warnings.length
        ? `没有有效的修改字段：${warnings.join('；')}`
        : '没有提供任何要修改的字段（name / font / fontSize / bold / align / lineSpacing…）',
    }
  }

  const styleXml = `<w:style${seg.xml.slice(seg.xml.indexOf('<w:style') + '<w:style'.length, seg.xml.indexOf('>'))}>${inner}</w:style>`
  const head = xml.slice(0, seg.start)
  const tail = xml.slice(seg.start + seg.xml.length)
  writeStylesXml(pkg, head + styleXml + tail)
  const usage = styleUsage(pkg.documentXml, seg.id)
  return {
    ok: true,
    styleId: seg.id,
    detail: `已修改样式「${seg.name}」（styleId: ${seg.id}）：${changed.join('、')}${usage ? `；正文中 ${usage} 处引用同步生效` : ''}`,
    ...(warnings.length ? { warnings } : {}),
  }
}

/** 删除样式（仍被正文引用时需 force=true） */
export function deleteStyle(pkg: DocxPackage, input: string, force = false): StyleResult {
  const xml = readPackageEntryText(pkg, 'word/styles.xml')
  if (!xml) return { ok: false, error: '该文档没有 styles.xml' }
  const seg = findStyleSeg(xml, input)
  if (!seg) return { ok: false, error: `未找到样式「${input}」` }
  const usage = styleUsage(pkg.documentXml, seg.id)
  if (usage > 0 && !force) {
    return {
      ok: false,
      error: `样式「${seg.name}」仍被正文引用（${usage} 处），删除后这些段落会退回默认格式。确认要删除请传 force=true。`,
    }
  }
  writeStylesXml(pkg, xml.slice(0, seg.start) + xml.slice(seg.start + seg.xml.length))
  return {
    ok: true,
    styleId: seg.id,
    detail: `已删除样式「${seg.name}」（styleId: ${seg.id}）${usage ? `，正文中 ${usage} 处引用将退回默认格式` : ''}`,
  }
}

// ==================== 字符格式（run 级） ====================

/** run 内的子元素（w:t 记文本，br/tab 记 1 字符，其余记 0 字符） */
interface RunChild { tag: string; xml: string; text?: string; chars: number }

function childChars(tag: string): number {
  return tag === 'w:br' || tag === 'w:cr' || tag === 'w:tab' ? 1 : 0
}

/** 扫描 run 内层，按文档顺序切出子元素 */
function scanRunChildren(inner: string): RunChild[] {
  const out: RunChild[] = []
  let i = 0
  const n = inner.length
  while (i < n) {
    const lt = inner.indexOf('<', i)
    if (lt < 0) break
    const gt = tagEnd(inner, lt + 1)
    if (gt < 0) break
    const raw = inner.slice(lt + 1, gt).trim()
    if (raw.startsWith('/') || raw.startsWith('?') || raw.startsWith('!')) { i = gt + 1; continue }
    const selfClose = raw.endsWith('/')
    const tag = raw.replace(/\/$/, '').split(/[\s/>]/)[0]
    if (selfClose) {
      out.push({ tag, xml: inner.slice(lt, gt + 1), chars: childChars(tag) })
      i = gt + 1
      continue
    }
    const close = `</${tag}>`
    const ce = inner.indexOf(close, gt + 1)
    const end = ce < 0 ? gt + 1 : ce + close.length
    const xml = inner.slice(lt, end)
    if (tag === 'w:t') {
      out.push({ tag, xml, text: decodeXmlEntities(xml.replace(/^<w:t[^>]*>/, '').replace(/<\/w:t>$/, '')), chars: 0 })
    } else {
      out.push({ tag, xml, chars: childChars(tag) })
    }
    i = end
  }
  return out
}

/** run 内层 → { rpr 内层, 其余 }（rPr 必须是 run 首个子元素） */
function extractRpr(inner: string): { rpr: string; rest: string } {
  const m = /^\s*<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>/.exec(inner)
  if (!m) return { rpr: '', rest: inner }
  const xml = m[0].trim()
  return { rpr: xml.slice(xml.indexOf('>') + 1, xml.lastIndexOf('</')), rest: inner.slice(m[0].length) }
}

/** 给 run 合并字符格式（保留原有 rPr 其它属性） */
function withRunFormat(runXml: string, entries: Array<{ tag: string; xml: string }>): string {
  const open = /^<w:r\b[^>]*>/.exec(runXml)?.[0] || '<w:r>'
  const inner = runXml.slice(open.length).replace(/<\/w:r>\s*$/, '')
  const { rpr, rest } = extractRpr(inner)
  const merged = upsert(rpr, entries, RPR_ORDER)
  return `${open}<w:rPr>${merged}</w:rPr>${rest}</w:r>`
}

const RUN_RE = /<w:r\b[^>]*\/>|<w:r\b[^>]*>[\s\S]*?<\/w:r>/g

export interface TextFormatResult {
  ok: boolean
  error?: string
  detail?: string
  warnings?: string[]
  /** 被套用格式的 run 数 */
  runs?: number
  /** 命中片段数 */
  ranges?: number
}

/**
 * 给指定段落施加字符格式。
 * - 不传 find：作用于整段所有 run；
 * - 传 find：先在该段的可见文本（br→\n、tab→\t）里定位，只给命中片段套格式，
 *   命中跨越多个 run 时按字符边界切分 run（保证只影响命中文字）。
 */
export function setTextFormat(
  pkg: DocxPackage,
  index: number,
  opts: RunFormat & { find?: string; scope?: 'all' | 'first'; ignoreCase?: boolean }
): TextFormatResult {
  const layout = bodyLayout(pkg.documentXml)
  if (!layout) return { ok: false, error: '无法定位文档正文（w:body），文件可能已损坏' }
  const blk: LocatedBlock | undefined = layout.blocks.find(b => b.index === index)
  if (!blk) return { ok: false, error: `块序号 ${index} 不存在` }
  if (blk.kind !== 'paragraph') return { ok: false, error: `块 ${index} 是表格，不能直接设置字符格式（可先取出文本另建段落）` }

  const warnings: string[] = []
  const entries = rprEntries(opts, m => warnings.push(m))
  if (!entries.length) return { ok: false, error: '未提供任何字符格式（font / fontSize / bold / italic / color / highlight / underline / strike）' }

  const { pPr, rest } = splitParagraph(blk.xml)

  // 1) 找出所有 run 及其字符区间
  const runs: Array<{ start: number; end: number; xml: string }> = []
  const flatParts: string[] = []
  let pos = 0
  RUN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = RUN_RE.exec(rest)) !== null) {
    const runXml = m[0]
    const open = /^<w:r\b[^>]*>/.exec(runXml)?.[0] || ''
    if (!open) continue
    const inner = runXml.slice(open.length).replace(/<\/w:r>\s*$/, '')
    const children = scanRunChildren(inner)
    for (const c of children) {
      if (c.tag === 'w:t') flatParts.push(c.text || '')
      else if (c.chars === 1) flatParts.push(c.tag === 'w:tab' ? '\t' : '\n')
    }
    const len = children.reduce((s, c) => s + (c.tag === 'w:t' ? (c.text || '').length : c.chars), 0)
    runs.push({ start: pos, end: pos + len, xml: runXml })
    pos += len
  }
  const flat = flatParts.join('')
  if (!runs.length || !flat) return { ok: false, error: `块 ${index} 是空段落，没有可格式化的文字` }

  // 2) 计算目标区间
  const targets: Array<[number, number]> = []
  const findRaw = opts.find === undefined ? '' : String(opts.find)
  if (findRaw) {
    const scope = opts.scope === 'first' ? 'first' : 'all'
    const hay = opts.ignoreCase ? flat.toLowerCase() : flat
    const needle = opts.ignoreCase ? findRaw.toLowerCase() : findRaw
    let from = 0
    while (from <= hay.length) {
      const at = hay.indexOf(needle, from)
      if (at < 0) break
      targets.push([at, at + needle.length])
      if (scope === 'first') break
      from = at + Math.max(1, needle.length)
    }
    if (!targets.length) return { ok: false, error: `块 ${index} 中未找到「${findRaw}」` }
  } else {
    targets.push([0, flat.length])
  }
  const cuts = Array.from(new Set(targets.flatMap(([a, b]) => [a, b]))).sort((a, b) => a - b)

  // 3) 按切点重建 run 序列（只给命中片段套格式）
  let out = ''
  let cursor = 0
  let runCount = 0
  for (const run of runs) {
    const at = rest.indexOf(run.xml, cursor)
    out += rest.slice(cursor, at)
    cursor = at + run.xml.length
    const open = /^<w:r\b[^>]*>/.exec(run.xml)?.[0] || '<w:r>'
    const inner = run.xml.slice(open.length).replace(/<\/w:r>\s*$/, '')
    const children = scanRunChildren(inner)
    const pieces = splitRunPieces(open, children, run.start, cuts.filter(c => c > run.start && c < run.end))
    for (const pc of pieces) {
      const hit = targets.some(([a, b]) => pc.end > a && pc.start < b)
      out += hit ? withRunFormat(pc.xml, entries) : pc.xml
      if (hit) runCount++
    }
  }
  out += rest.slice(cursor)

  const newXml = `<w:p${blk.xml.slice(blk.xml.indexOf('<w:p') + 4, blk.xml.indexOf('>'))}>${pPr}${out}</w:p>`
  pkg.documentXml = pkg.documentXml.slice(0, blk.start) + newXml + pkg.documentXml.slice(blk.end)
  pkg.modified = true
  return {
    ok: true,
    runs: runCount,
    ranges: targets.length,
    detail: `已给块 ${index} 的 ${findRaw ? `${targets.length} 处「${findRaw}」` : '整段'} 施加字符格式（${runCount} 个 run）：${entries.map(e => e.tag.replace('w:', '')).join('/')}`,
    ...(warnings.length ? { warnings } : {}),
  }
}

/** 按字符切点把 run 拆成若干片段（切点只落在文字内部，或 br/tab 之后） */
function splitRunPieces(
  open: string,
  children: RunChild[],
  runStart: number,
  cuts: number[]
): Array<{ xml: string; start: number; end: number }> {
  const cutSet = new Set(cuts)
  const pieces: Array<{ parts: string[]; start: number; end: number }> = []
  let parts: string[] = []
  let pieceStart = runStart
  let pos = runStart
  let textBuf = ''
  const flushText = () => {
    if (textBuf) {
      parts.push(`<w:t xml:space="preserve">${encodeXml(textBuf)}</w:t>`)
      textBuf = ''
    }
  }
  const closePiece = () => {
    flushText()
    if (parts.length) pieces.push({ parts, start: pieceStart, end: pos })
    parts = []
    pieceStart = pos
  }
  for (const ch of children) {
    if (ch.tag === 'w:t' && ch.text !== undefined) {
      for (const c of ch.text) {
        textBuf += c
        pos += 1
        if (cutSet.has(pos)) closePiece()
      }
    } else if (ch.chars === 1) {
      flushText()
      parts.push(ch.xml)
      pos += 1
      if (cutSet.has(pos)) closePiece()
    } else {
      flushText()
      parts.push(ch.xml)
    }
  }
  closePiece()
  return pieces.map(p => ({ xml: `${open}${p.parts.join('')}</w:r>`, start: p.start, end: p.end }))
}
