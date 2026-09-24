/**
 * docx 块级编辑（M1.2，纯 Node / 零第三方依赖）
 *
 * 在 docx-editor 的「L1 文本替换」之上提供结构化编辑能力：
 *  - replaceParagraphText   整段重写（保留 pPr 与段首 run 格式）
 *  - setParagraphStyle      改段落样式 / 标题级别（按 styles.xml 解析真实 styleId）
 *  - insertParagraph        在指定块前/后插入段落（可带标题级别，克隆邻段格式）
 *  - insertTable            插入表格（显式边框，首行可加粗）
 *  - insertMarkdown         把 Markdown 片段转成段块插入（标题 / 段落 / 列表 / 管道表格）
 *  - deleteBlock            删除指定块（段落或表格）
 *
 * 所有操作直接改 pkg.documentXml，成功后置 pkg.modified = true（由 save_document 写盘）。
 * 块序号与 docx-reader 的 list_blocks / read_text 完全一致（1-based，sectPr 不计数）。
 */
import { bodyLayout, paragraphText, tableRows, type BodyLayout, type LocatedBlock } from './docx-reader'
import type { DocxPackage } from './docx-editor'

// ==================== XML 小工具 ====================

export function encodeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 首个 <w:rPr>…</w:rPr>（段内主要格式）；无则空串 */
export function firstRpr(xml: string): string {
  const m = /<w:rPr\b[\s\S]*?<\/w:rPr>/.exec(xml)
  return m ? m[0] : ''
}

/** 纯文本 → runs（\n → w:br，\t → w:tab） */
export function plainToRuns(text: string, rPr = ''): string {
  let runs = ''
  let buf = ''
  const flush = () => {
    if (buf) {
      runs += `<w:r>${rPr}<w:t xml:space="preserve">${encodeXml(buf)}</w:t></w:r>`
      buf = ''
    }
  }
  for (const ch of text) {
    if (ch === '\n') { flush(); runs += `<w:r>${rPr}<w:br/></w:r>` }
    else if (ch === '\t') { flush(); runs += `<w:r>${rPr}<w:tab/></w:r>` }
    else buf += ch
  }
  flush()
  return runs
}

/** 拆段落 xml → { openTag, pPr, rest }（rest 为去掉 pPr 后的段内内容） */
function splitParagraph(pXml: string): { openTag: string; pPr: string; rest: string } {
  let openTag = ''
  let inner = ''
  if (/^<w:p\b[^>]*\/>\s*$/.test(pXml)) {
    openTag = pXml.replace(/\/>\s*$/, '>')
  } else {
    const openEnd = pXml.indexOf('>') + 1
    openTag = pXml.slice(0, openEnd)
    const close = pXml.lastIndexOf('</w:p>')
    inner = pXml.slice(openEnd, close < 0 ? pXml.length : close)
  }
  let pPr = ''
  let rest = inner
  const ppStart = inner.search(/<w:pPr\b/)
  if (ppStart >= 0) {
    const ppClose = inner.indexOf('</w:pPr>', ppStart)
    if (ppClose >= 0) {
      const end = ppClose + '</w:pPr>'.length
      pPr = inner.slice(ppStart, end)
      rest = inner.slice(0, ppStart) + inner.slice(end)
    }
  }
  return { openTag, pPr, rest }
}

// ==================== 样式目录（styles.xml） ====================

export interface DocxStyleInfo {
  id: string
  type: string
  name: string
  /** 由 w:outlineLvl 或样式名推导的标题级别（1..9），非标题样式为 undefined */
  headingLevel?: number
}

let styleCatalogCache: { key: string; list: DocxStyleInfo[] } | null = null

/** 解析 styles.xml，得到可用样式清单（带进程内缓存，键为 styles.xml 文本长度+样式数近似） */
export function styleCatalog(pkg: DocxPackage): DocxStyleInfo[] {
  const xml = pkg.entries.find(e => e.name === 'word/styles.xml')?.data.toString('utf8') || ''
  const cacheKey = `${pkg.path}|${xml.length}`
  if (styleCatalogCache && styleCatalogCache.key === cacheKey) return styleCatalogCache.list
  const list: DocxStyleInfo[] = []
  const re = /<w:style\b[^>]*>[\s\S]*?<\/w:style>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const seg = m[0]
    const id = /w:styleId="([^"]*)"/.exec(seg)?.[1]
    if (!id) continue
    const type = /w:type="([^"]*)"/.exec(seg)?.[1] || 'paragraph'
    const name = /<w:name\b[^>]*w:val="([^"]*)"/.exec(seg)?.[1] || id
    let level: number | undefined
    const fromName = /^(?:heading|标题)\s*(\d+)$/i.exec(name.trim())
    const fromId = /^heading\s*(\d+)$/i.exec(id.trim())
    const outline = /<w:outlineLvl\b[^>]*w:val="(\d+)"/.exec(seg)?.[1]
    if (fromName) level = Number(fromName[1])
    else if (fromId) level = Number(fromId[1])
    else if (outline !== undefined) level = Number(outline) + 1
    if (level !== undefined && (level < 1 || level > 9)) level = Math.min(9, Math.max(1, level))
    // Title 样式（标题页大标题）单独识别为 level 0
    if (!level && /^(title|标题)$/i.test(name.trim())) level = 0
    list.push({ id, type, name, ...(level !== undefined ? { headingLevel: level } : {}) })
  }
  styleCatalogCache = { key: cacheKey, list }
  return list
}

/** 标题级别 → 真实 styleId（styles.xml 里按名字/outlineLvl 检出；查不到回退 Word 内置 Heading{N}） */
export function headingStyleId(pkg: DocxPackage, level: number): string {
  const hit = styleCatalog(pkg).find(s => s.headingLevel === level && s.type !== 'character')
  return hit ? hit.id : `Heading${level}`
}

/** 用户输入的样式名 → styleId（支持 styleId 精确匹配、样式显示名、'标题 1'/'Heading 1'/'title'） */
export function resolveStyleId(pkg: DocxPackage, input: string): string | undefined {
  const raw = String(input || '').trim()
  if (!raw) return undefined
  const list = styleCatalog(pkg)
  const byId = list.find(s => s.id === raw)
  if (byId) return byId.id
  const lower = raw.toLowerCase()
  const byName = list.find(s => s.name.trim().toLowerCase() === lower)
  if (byName) return byName.id
  const h = /^(?:heading|标题)\s*(\d+)$/i.exec(raw)
  if (h) return headingStyleId(pkg, Number(h[1]))
  if (/^(title|标题|文档标题)$/i.test(raw)) {
    const t = list.find(s => /^(title|标题|文档标题)$/i.test(s.name.trim()))
    return t ? t.id : 'Title'
  }
  const byIdNum = list.find(s => s.id.toLowerCase() === lower)
  return byIdNum ? byIdNum.id : undefined
}

// ==================== 段落 / 表格构造 ====================

/** 用给定文本 + pPr 重建段落 xml */
function buildParagraph(text: string, pPr: string, rPr: string): string {
  return `<w:p>${pPr}${plainToRuns(text, rPr)}</w:p>`
}

/** 段落 xml → 追加/替换 pStyle（styleId 为空则删除 w:pStyle） */
function withParagraphStyle(pXml: string, styleId: string | null): string {
  const { openTag, pPr, rest } = splitParagraph(pXml)
  let newPPr = pPr
  const strip = (s: string) => s.replace(/<w:pStyle\b[^>]*\/>/g, '')
  if (styleId === null) {
    newPPr = strip(pPr)
  } else {
    const tag = `<w:pStyle w:val="${encodeXml(styleId)}"/>`
    if (/<w:pStyle\b[^>]*\/>/.test(pPr)) newPPr = pPr.replace(/<w:pStyle\b[^>]*\/>/, tag)
    else {
      const inner = pPr ? pPr.replace(/^<w:pPr\b[^>]*>/, '').replace(/<\/w:pPr>$/, '') : ''
      newPPr = `<w:pPr>${tag}${inner}</w:pPr>`
    }
  }
  return `${openTag}${newPPr}${rest}</w:p>`
}

/** 表格 xml（显式边框，保证任何文档里都能看到表格线；header=true 时首行加粗） */
function buildTableXml(rows: string[][], opts: { header?: boolean; widths?: number[] } = {}): string {
  const cols = Math.max(1, ...rows.map(r => r.length))
  const grid = Array.from({ length: cols }, (_, i) => `<w:gridCol w:w="${opts.widths?.[i] || 2400}"/>`).join('')
  const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`
  const tblPr =
    `<w:tblPr><w:tblW w:w="0" w:type="auto"/>` +
    `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders>` +
    `<w:tblLook w:val="04A0" w:firstRow="${opts.header ? 1 : 0}" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>`
  const trs = rows.map((row, ri) => {
    const bold = opts.header && ri === 0 ? '<w:rPr><w:b/></w:rPr>' : ''
    const tcs = Array.from({ length: cols }, (_, ci) => {
      const text = String(row[ci] ?? '')
      return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p>${plainToRuns(text, bold)}</w:p></w:tc>`
    }).join('')
    return `<w:tr>${tcs}</w:tr>`
  }).join('')
  return `<w:tbl>${tblPr}<w:tblGrid>${grid}</w:tblGrid>${trs}</w:tbl>`
}

// ==================== 编辑操作 ====================

export interface EditResult {
  ok: boolean
  error?: string
  /** 受影响/新增块的序号（插入时为新块序号） */
  index?: number
  /** 操作说明，供工具回执 */
  detail?: string
}

function markModified(pkg: DocxPackage): void {
  pkg.modified = true
}

function splice(pkg: DocxPackage, start: number, end: number, insert: string): void {
  pkg.documentXml = pkg.documentXml.slice(0, start) + insert + pkg.documentXml.slice(end)
}

function blockOf(layout: BodyLayout, index: number): LocatedBlock | undefined {
  return layout.blocks.find(b => b.index === index)
}

function maxIndex(layout: BodyLayout): number {
  return layout.blocks.reduce((m, b) => (b.index !== undefined && b.index > m ? b.index : m), 0)
}

/** 取参考段落（用于克隆 rPr）：优先指定块，其次文档首个段落 */
function refParagraph(layout: BodyLayout, index?: number): string {
  if (index !== undefined) {
    const b = blockOf(layout, index)
    if (b && b.kind === 'paragraph') return b.xml
  }
  const first = layout.blocks.find(b => b.kind === 'paragraph')
  return first ? first.xml : ''
}

/** 计算插入偏移：position=before/after 以 index 为锚点；end 或无 index 时追加到正文末尾（sectPr 之前） */
function anchorOffset(layout: BodyLayout, index: number | undefined, position: string | undefined): { at: number } | { error: string } {
  const pos = position || (index === undefined ? 'end' : 'after')
  if (pos === 'end' || index === undefined || index === 0) return { at: layout.appendAt }
  const b = blockOf(layout, index)
  if (!b) return { error: `块序号 ${index} 不存在（当前共 ${maxIndex(layout)} 块）` }
  return { at: pos === 'before' ? b.start : b.end }
}

function requireLayout(pkg: DocxPackage): { layout: BodyLayout } | { error: string } {
  const layout = bodyLayout(pkg.documentXml)
  if (!layout) return { error: '无法定位文档正文（w:body），文件可能已损坏' }
  return { layout }
}

/** 整段重写：保留段落样式（pPr）与段内首个 run 的格式（rPr） */
export function replaceParagraphText(pkg: DocxPackage, index: number, text: string): EditResult {
  const r = requireLayout(pkg)
  if ('error' in r) return { ok: false, error: r.error }
  const blk = blockOf(r.layout, index)
  if (!blk) return { ok: false, error: `块序号 ${index} 不存在（当前共 ${maxIndex(r.layout)} 块）` }
  if (blk.kind !== 'paragraph') return { ok: false, error: `块 ${index} 是表格，不能用 replace_paragraph 重写；表格请用 insert_table / delete_block` }
  const { pPr, rest } = splitParagraph(blk.xml)
  const newXml = buildParagraph(text, pPr, firstRpr(rest))
  splice(pkg, blk.start, blk.end, newXml)
  markModified(pkg)
  return { ok: true, index, detail: `块 ${index} 已重写为 ${text.length} 字（保留原段落样式与段首格式）` }
}

/** 设置段落样式 / 标题级别（style 与 headingLevel 二选一；style 传空串表示清除样式） */
export function setParagraphStyle(pkg: DocxPackage, index: number, opts: { style?: string; headingLevel?: number }): EditResult {
  const r = requireLayout(pkg)
  if ('error' in r) return { ok: false, error: r.error }
  const blk = blockOf(r.layout, index)
  if (!blk) return { ok: false, error: `块序号 ${index} 不存在（当前共 ${maxIndex(r.layout)} 块）` }
  if (blk.kind !== 'paragraph') return { ok: false, error: `块 ${index} 是表格，不能设置段落样式` }
  let styleId: string | null
  if (opts.headingLevel !== undefined) {
    const lv = Math.max(0, Math.min(9, Number(opts.headingLevel)))
    styleId = lv === 0 ? resolveStyleId(pkg, 'Title') || 'Title' : headingStyleId(pkg, lv)
  } else if (opts.style === undefined) {
    return { ok: false, error: '需提供 style（样式名/ID）或 headingLevel（1-6）' }
  } else if (String(opts.style).trim() === '') {
    styleId = null
  } else {
    const resolved = resolveStyleId(pkg, String(opts.style))
    if (!resolved) {
      const names = styleCatalog(pkg).filter(s => s.type !== 'character').slice(0, 30).map(s => s.name || s.id).join('、')
      return { ok: false, error: `未找到样式「${opts.style}」。文档可用样式（部分）：${names}` }
    }
    styleId = resolved
  }
  splice(pkg, blk.start, blk.end, withParagraphStyle(blk.xml, styleId))
  markModified(pkg)
  return { ok: true, index, detail: styleId === null ? `已清除块 ${index} 的段落样式` : `块 ${index} 样式已设为 ${styleId}` }
}

/** 插入段落（position: before/after/end，默认 after；index 省略或 0 表示追加到正文末尾） */
export function insertParagraph(pkg: DocxPackage, opts: { index?: number; position?: string; text: string; style?: string; headingLevel?: number }): EditResult {
  const r = requireLayout(pkg)
  if ('error' in r) return { ok: false, error: r.error }
  const layout = r.layout
  const off = anchorOffset(layout, opts.index, opts.position)
  if ('error' in off) return { ok: false, error: off.error }
  const ref = refParagraph(layout, opts.index)
  const { pPr, rest } = splitParagraph(ref)
  let targetPPr = pPr
  if (opts.headingLevel !== undefined || opts.style !== undefined) {
    let styleId: string | null | undefined
    if (opts.headingLevel !== undefined) {
      const lv = Math.max(0, Math.min(9, Number(opts.headingLevel)))
      styleId = lv === 0 ? resolveStyleId(pkg, 'Title') || 'Title' : headingStyleId(pkg, lv)
    } else if (String(opts.style).trim() === '') {
      styleId = null
    } else {
      styleId = resolveStyleId(pkg, String(opts.style))
      if (!styleId) return { ok: false, error: `未找到样式「${opts.style}」` }
    }
    targetPPr = withParagraphStyle(`<w:p>${pPr}</w:p>`, styleId).replace(/^<w:p>/, '').replace(/<\/w:p>$/, '')
  }
  const xml = buildParagraph(opts.text, targetPPr, firstRpr(rest))
  splice(pkg, off.at, off.at, xml)
  markModified(pkg)
  const anchored = opts.index !== undefined && opts.index > 0 && opts.position !== 'end' && !!blockOf(layout, opts.index)
  const newIndex = anchored ? (opts.position === 'before' ? opts.index! : opts.index! + 1) : maxIndex(layout) + 1
  return { ok: true, index: newIndex, detail: `已在${anchored ? `块 ${opts.index} ${opts.position === 'before' ? '前' : '后'}` : '正文末尾'}插入段落` }
}

/** 删除块（段落或表格） */
export function deleteBlock(pkg: DocxPackage, index: number): EditResult {
  const r = requireLayout(pkg)
  if ('error' in r) return { ok: false, error: r.error }
  const blk = blockOf(r.layout, index)
  if (!blk) return { ok: false, error: `块序号 ${index} 不存在（当前共 ${maxIndex(r.layout)} 块）` }
  splice(pkg, blk.start, blk.end, '')
  markModified(pkg)
  return { ok: true, index, detail: `已删除块 ${index}（${blk.kind === 'table' ? '表格' : (paragraphText(blk.xml).trim().slice(0, 30) || '空段落')}）` }
}

/** 插入表格（rows 为二维文本；header=true 首行加粗） */
export function insertTable(pkg: DocxPackage, opts: { index?: number; position?: string; rows: string[][]; header?: boolean }): EditResult {
  const r = requireLayout(pkg)
  if ('error' in r) return { ok: false, error: r.error }
  const layout = r.layout
  const rows = (opts.rows || []).map(row => (row || []).map(c => String(c ?? '')))
  if (!rows.length || !rows.some(r0 => r0.some(c => c !== ''))) return { ok: false, error: '表格内容为空（rows 需为二维数组，至少一行）' }
  const off = anchorOffset(layout, opts.index, opts.position)
  if ('error' in off) return { ok: false, error: off.error }
  const cols = Math.max(...rows.map(r0 => r0.length))
  const atEnd = off.at === layout.appendAt
  // 表格贴在正文末尾时补一个空段落，避免 Word 里无法在表后继续输入
  const xml = buildTableXml(rows, { header: opts.header }) + (atEnd ? '<w:p/>' : '')
  splice(pkg, off.at, off.at, xml)
  markModified(pkg)
  const anchored = opts.index !== undefined && opts.index > 0 && opts.position !== 'end' && !!blockOf(layout, opts.index)
  const newIndex = anchored ? (opts.position === 'before' ? opts.index! : opts.index! + 1) : maxIndex(layout) + 1
  return { ok: true, index: newIndex, detail: `已插入 ${rows.length} 行 × ${cols} 列表格` }
}

// ==================== Markdown → 块 ====================

export type MdBlock =
  | { kind: 'paragraph'; text: string; headingLevel?: number }
  | { kind: 'table'; rows: string[][] }

/** 行内 Markdown 降级为纯文本（去强调/行内代码标记，链接保留文字+URL） */
export function inlineToPlain(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '$1')       // 图片 → alt
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_, t, u) => (u ? `${t} (${u})` : t))
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1$2')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1')
}

/** 解析 Markdown 片段为块序列（支持 # 标题 / 段落 / 列表 / > 引用 / 管道表格；代码围栏内的行按原文段落处理） */
export function markdownToBlocks(md: string): MdBlock[] {
  const out: MdBlock[] = []
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n')
  let inFence = false
  let para: string[] = []
  const flush = () => {
    if (para.length) {
      out.push({ kind: 'paragraph', text: para.join('\n') })
      para = []
    }
  }
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence) { para.push(line); continue }
    if (!line.trim()) { flush(); continue }

    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) { flush(); out.push({ kind: 'paragraph', headingLevel: h[1].length, text: inlineToPlain(h[2]).trim() }); continue }

    if (/^\s*(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) { flush(); continue } // 分隔线

    if (line.includes('|') && /^\s*\|/.test(line)) {
      // 收集连续表格行
      const raw: string[] = []
      let j = i
      while (j < lines.length && lines[j].includes('|') && /^\s*\|/.test(lines[j])) { raw.push(lines[j]); j++ }
      const rows = raw
        .filter(l0 => !/^\s*\|?[\s:|-]+\|?\s*$/.test(l0))
        .map(l0 => l0.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => inlineToPlain(c).trim()))
        .filter(r0 => r0.length > 0)
      i = j - 1
      if (rows.length) { flush(); out.push({ kind: 'table', rows }) }
      continue
    }

    const li = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (li) {
      flush()
      const indent = '  '.repeat(Math.min(3, Math.floor(li[1].length / 2)))
      const ordered = /^\d+[.)]$/.test(line.trim().split(/\s+/)[0])
      const marker = ordered ? line.trim().split(/\s+/)[0] + ' ' : '• '
      out.push({ kind: 'paragraph', text: indent + marker + inlineToPlain(li[2]).trim() })
      continue
    }

    const bq = /^>\s?(.*)$/.exec(line)
    if (bq) { flush(); out.push({ kind: 'paragraph', text: inlineToPlain(bq[1]).trim() }); continue }

    para.push(inlineToPlain(line).trimEnd())
  }
  flush()
  return out
}

/** 把 Markdown 片段转为块并插入（index/position 语义同 insert_paragraph） */
export function insertMarkdown(pkg: DocxPackage, markdown: string, opts: { index?: number; position?: string } = {}): EditResult & { blocks?: number } {
  const r = requireLayout(pkg)
  if ('error' in r) return { ok: false, error: r.error }
  const blocks = markdownToBlocks(markdown)
  if (!blocks.length) return { ok: false, error: 'Markdown 内容为空或无法识别出任何块' }
  const layout = r.layout
  const off = anchorOffset(layout, opts.index, opts.position)
  if ('error' in off) return { ok: false, error: off.error }
  const ref = refParagraph(layout, opts.index)
  const { pPr, rest } = splitParagraph(ref)
  const rPr = firstRpr(rest)
  let xml = ''
  for (const b of blocks) {
    if (b.kind === 'table') {
      xml += buildTableXml(b.rows, { header: true })
      continue
    }
    let blockPPr = pPr
    if (b.headingLevel !== undefined) {
      const styleId = b.headingLevel > 0 ? headingStyleId(pkg, b.headingLevel) : (resolveStyleId(pkg, 'Title') || 'Title')
      blockPPr = withParagraphStyle(`<w:p>${pPr}</w:p>`, styleId).replace(/^<w:p>/, '').replace(/<\/w:p>$/, '')
    }
    xml += buildParagraph(b.text, blockPPr, rPr)
  }
  const atEnd = off.at === layout.appendAt
  if (atEnd && /<\/w:tbl>$/.test(xml)) xml += '<w:p/>'
  splice(pkg, off.at, off.at, xml)
  markModified(pkg)
  const anchored = opts.index !== undefined && opts.index > 0 && opts.position !== 'end' && !!blockOf(layout, opts.index)
  const newIndex = anchored ? (opts.position === 'before' ? opts.index! : opts.index! + 1) : maxIndex(layout) + 1
  return { ok: true, index: newIndex, blocks: blocks.length, detail: `已插入 ${blocks.length} 个块（${blocks.filter(b => b.kind === 'table').length} 个表格）` }
}

// ==================== 文本检索（只读） ====================

export interface TextMatch {
  index: number
  kind: 'paragraph' | 'table'
  count: number
  snippet: string
}

export interface FindTextResult {
  total: number
  matches: TextMatch[]
  truncated: boolean
}

/** 在块文本里查找（字面量或正则），返回命中块 + 上下文片段 */
export function findTextInBlocks(
  documentXml: string,
  find: string,
  opts: { ignoreCase?: boolean; regex?: boolean; max?: number; context?: number } = {}
): FindTextResult {
  const res: FindTextResult = { total: 0, matches: [], truncated: false }
  if (!find) return res
  const layout = bodyLayout(documentXml)
  if (!layout) return res
  const max = Math.max(1, Math.min(200, Number(opts.max) || 50))
  const ctx = Math.max(0, Math.min(200, Number(opts.context) ?? 40))
  let re: RegExp | null = null
  if (opts.regex) {
    try { re = new RegExp(find, opts.ignoreCase ? 'gi' : 'g') } catch { return res }
  }
  for (const b of layout.blocks) {
    if (b.index === undefined) continue
    const text = paragraphText(b.xml)
    if (!text) continue
    const hay = opts.regex ? text : (opts.ignoreCase ? text.toLowerCase() : text)
    const needle = opts.regex ? find : (opts.ignoreCase ? find.toLowerCase() : find)
    let count = 0
    const snippets: string[] = []
    if (re) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        if (m[0] === '') { re.lastIndex++; continue }
        count++
        if (snippets.length < 5) {
          snippets.push(text.slice(Math.max(0, m.index - ctx), m.index + m[0].length + ctx).replace(/\n/g, ' '))
        }
      }
    } else {
      let from = 0
      while (snippets.length < 5) {
        const idx = hay.indexOf(needle, from)
        if (idx < 0) break
        count++
        snippets.push(text.slice(Math.max(0, idx - ctx), idx + needle.length + ctx).replace(/\n/g, ' '))
        from = idx + needle.length
      }
    }
    if (count > 0) {
      res.total += count
      if (res.matches.length < max) {
        res.matches.push({
          index: b.index,
          kind: b.kind === 'table' ? 'table' : 'paragraph',
          count,
          snippet: snippets.join(' … '),
        })
      } else {
        res.truncated = true
      }
    }
  }
  return res
}
