/**
 * docx 只读内核（Node 端，零第三方依赖）
 *
 * 从 .docx 中读取 word/document.xml（自实现 ZIP 中央目录解析 + zlib inflate），
 * 解析为「顶层块序列」（段落 / 表格），供 Office MCP 服务的
 * open_document / list_blocks / read_text / export_markdown 使用。
 *
 * 仅含纯 Node 逻辑，不 import electron —— 便于以后抽成独立 stdio CLI 复用。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { readZipEntryText } from './docx-zip'

export interface OfficeBlock {
  /** 1-based 段落/块序号（在文档中的绝对位置） */
  index: number
  kind: 'paragraph' | 'table'
  /** 该块的纯文本（表格为全部单元格文本按行拼接） */
  text: string
  /** 标题级别 1..6（Title 记 0，正文无该字段） */
  headingLevel?: number
  /** 段落样式 styleId（如 Normal / Heading1 / 标题 1），用于后续 L2 保真编辑 */
  style?: string
  /** kind=table 时：二维单元格文本（行 → 列） */
  table?: string[][]
}

export interface DocxOutline {
  index: number
  level: number
  text: string
}

export interface DocxReadResult {
  path: string
  name: string
  blocks: OfficeBlock[]
  headings: DocxOutline[]
  wordCount: number
  error?: string
}

// ZIP 原语（解包/打包）见 ./docx-zip.ts

// ==================== XML 轻量解析 ====================

export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&') // 最后替换 &，避免二次转义
}

/** 找到与 '<' 配对的 '>'（跳过属性引号内的字符） */
export function tagEnd(s: string, from: number): number {
  let quote = ''
  for (let i = from; i < s.length; i++) {
    const c = s[i]
    if (quote) { if (c === quote) quote = ''; continue }
    if (c === '\'' || c === '"') quote = c
    else if (c === '>') return i
  }
  return -1
}

/** 顶层元素片段（start/end 为相对 content 的偏移区间） */
export interface TopLevelEl {
  tag: string
  start: number
  end: number
  xml: string
}

/** 从 w:body 内容中切出顶层元素片段 [{tag, start, end, xml}] */
export function topLevelEls(content: string): TopLevelEl[] {
  const els: TopLevelEl[] = [];
  const n = content.length
  let i = 0
  while (i < n) {
    const lt = content.indexOf('<', i)
    if (lt < 0) break
    if (content.startsWith('<!--', lt)) {
      const ce = content.indexOf('-->', lt + 4)
      i = ce < 0 ? n : ce + 3
      continue
    }
    const gt = tagEnd(content, lt + 1)
    if (gt < 0) break
    const raw = content.slice(lt + 1, gt)
    const close = raw.startsWith('/')
    const selfClose = raw.endsWith('/')
    let name = raw.replace(/^\//, '').replace(/\/$/, '').trim()
    name = name.split(/[\s/>]/)[0]
    if (name === '' || name.startsWith('?') || name.startsWith('!')) { i = gt + 1; continue }
    if (close) { i = gt + 1; continue }
    if (selfClose) { i = gt + 1; continue }
    // 开始标签 → 找配平结束标签
    const tagName = name
    const target = `</${tagName}>`
    let depth = 1
    let scan = gt + 1
    let fragEnd = -1
    while (scan < n && depth > 0) {
      const lt2 = content.indexOf('<', scan)
      if (lt2 < 0) break
      if (content.startsWith(target, lt2)) { depth--; scan = lt2 + target.length; if (depth === 0) fragEnd = scan; continue }
      const gt2 = tagEnd(content, lt2 + 1)
      if (gt2 < 0) break
      const r2 = content.slice(lt2 + 1, gt2)
      const isClose = r2.startsWith('/')
      const isSelf = r2.endsWith('/')
      let nm = r2.replace(/^\//, '').replace(/\/$/, '').trim().split(/[\s/>]/)[0]
      if (nm && !nm.startsWith('?') && !nm.startsWith('!')) {
        if (isClose) { depth--; if (depth === 0) fragEnd = gt2 + 1 }
        else if (!isSelf) depth++
      }
      scan = gt2 + 1
    }
    if (fragEnd < 0) fragEnd = gt + 1
    els.push({ tag: tagName, start: lt, end: fragEnd, xml: content.slice(lt, fragEnd) })
    i = fragEnd
  }
  return els
}

/** 从段落 xml 提取纯文本（按 w:t / w:br / w:tab 出现顺序拼接） */
export function paragraphText(xml: string): string {
  let s = xml
    .replace(/<w:br\b[^>]*\/?>/gi, '\n')
    .replace(/<w:tab\b[^>]*\/?>/gi, '\t')
  let out = ''
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    out += decodeXmlEntities(m[1])
  }
  return out.replace(/\u200B/g, '') // 去掉零宽空格等不可见字符
}

/** 从段落 xml 提取标题级别（1..6；Title → 0；无 → undefined） */
export function headingLevelOf(xml: string): number | undefined {
  const st = /<w:pStyle\b[^>]*w:val="([^"]*)"/.exec(xml)?.[1] || ''
  if (/title/i.test(st)) return 0
  const m = /heading\s*(\d)/i.exec(st) || /^Heading\s*(\d)$/i.exec(st)
  return m ? Math.min(6, Math.max(1, Number(m[1]))) : undefined
}

export function styleOf(xml: string): string | undefined {
  const st = /<w:pStyle\b[^>]*w:val="([^"]*)"/.exec(xml)?.[1]
  return st || undefined
}

/** 解析 w:tbl xml → 二维单元格文本 */
export function tableRows(xml: string): string[][] {
  const rows: string[][] = []
  const trRe = /<w:tr\b[\s\S]*?<\/w:tr>/g
  let trm: RegExpExecArray | null
  while ((trm = trRe.exec(xml)) !== null) {
    const trXml = trm[0]
    const cells: string[] = []
    const tcRe = /<w:tc\b[\s\S]*?<\/w:tc>/g
    let tcm: RegExpExecArray | null
    while ((tcm = tcRe.exec(trXml)) !== null) {
      cells.push(paragraphText(tcm[0]).trim().replace(/\n+/g, ' '))
    }
    rows.push(cells)
  }
  return rows.filter(r => r.length > 0)
}

// ==================== 块级定位（供块级编辑：replace / insert / delete） ====================

/** 顶层块定位信息 */
export interface LocatedBlock {
  /** 1-based 块序号（与 list_blocks / read_text 的序号一致）；跳过元素（w:sectPr / 空表格）为 undefined */
  index?: number
  kind: 'paragraph' | 'table' | 'other'
  tag: string
  /** 相对 documentXml 的绝对区间 [start, end) */
  start: number
  end: number
  xml: string
}

export interface BodyLayout {
  /** w:body 内容区（不含 <w:body> 标签本身）在 documentXml 中的区间 */
  contentStart: number
  contentEnd: number
  /** 追加内容应插入的位置：顶层 sectPr 之前（sectPr 必须保持为最后元素）；无 sectPr 时为内容区末尾 */
  appendAt: number
  blocks: LocatedBlock[]
}

/**
 * 定位 w:body 及其顶层块（带绝对偏移）—— 块级编辑的统一入口。
 * 序号规则与 parseDocumentXml 完全一致：w:p 一律计数；w:tbl 仅在有行时计数。
 */
export function bodyLayout(documentXml: string): BodyLayout | null {
  const bodyStart = documentXml.search(/<w:body\b/)
  if (bodyStart < 0) return null
  const gt0 = tagEnd(documentXml, bodyStart + 1)
  if (gt0 < 0) return null
  const bodyEndTag = documentXml.indexOf('</w:body>', bodyStart)
  const selfClose = documentXml.slice(bodyStart, gt0 + 1).trimEnd().endsWith('/>')
  const contentEnd = bodyEndTag >= 0 ? bodyEndTag : documentXml.length
  const contentStart = selfClose ? contentEnd : gt0 + 1
  const layout: BodyLayout = { contentStart, contentEnd, appendAt: contentEnd, blocks: [] }
  if (contentStart >= contentEnd) return layout

  const els = topLevelEls(documentXml.slice(contentStart, contentEnd))
  let index = 0
  for (const el of els) {
    const tag = el.tag.toLowerCase()
    const start = contentStart + el.start
    const end = contentStart + el.end
    if (tag === 'w:sectpr') {
      layout.blocks.push({ kind: 'other', tag: el.tag, start, end, xml: el.xml })
    } else if (tag === 'w:p') {
      index++
      layout.blocks.push({ index, kind: 'paragraph', tag: el.tag, start, end, xml: el.xml })
    } else if (tag === 'w:tbl') {
      if (!tableRows(el.xml).length) {
        layout.blocks.push({ kind: 'other', tag: el.tag, start, end, xml: el.xml })
      } else {
        index++
        layout.blocks.push({ index, kind: 'table', tag: el.tag, start, end, xml: el.xml })
      }
    } else {
      // 其它顶层（altChunk / bookmarkStart / w:sdt 等）不计数
      layout.blocks.push({ kind: 'other', tag: el.tag, start, end, xml: el.xml })
    }
  }
  const last = layout.blocks[layout.blocks.length - 1]
  layout.appendAt = last && last.tag.toLowerCase() === 'w:sectpr' ? last.start : contentEnd
  return layout
}

// ==================== 主入口 ====================

/** 从已解出的 word/document.xml 解析为块模型（读入口与编辑后同步共用） */
export function parseDocumentXml(documentXml: string, filePath: string, name: string): DocxReadResult {
  const result: DocxReadResult = { path: filePath, name: name || path.basename(filePath), blocks: [], headings: [], wordCount: 0 }
  try {
    if (!documentXml) {
      result.error = '无法解析该 .docx（缺少 word/document.xml 或文件已损坏）'
      return result
    }
    const layout = bodyLayout(documentXml)
    if (!layout) {
      result.error = '无法定位文档正文（w:body）'
      return result
    }
    const blocks: OfficeBlock[] = []
    const headings: DocxOutline[] = []
    for (const b of layout.blocks) {
      if (b.index === undefined) continue
      if (b.kind === 'paragraph') {
        const text = paragraphText(b.xml).trim()
        const style = styleOf(b.xml)
        const level = headingLevelOf(b.xml)
        const blk: OfficeBlock = { index: b.index, kind: 'paragraph', text, ...(style !== undefined ? { style } : {}), ...(level !== undefined ? { headingLevel: level } : {}) }
        blocks.push(blk)
        if (level !== undefined && text) headings.push({ index: b.index, level, text })
      } else if (b.kind === 'table') {
        const rows = tableRows(b.xml)
        const flat = rows.map(r => r.join(' | ')).join('\n')
        blocks.push({ index: b.index, kind: 'table', text: flat, table: rows })
      }
    }
    result.blocks = blocks
    result.headings = headings
    result.wordCount = blocks.reduce((s, b) => s + b.text.replace(/\s+/g, '').length, 0)
  } catch (e: any) {
    result.error = e?.message || String(e)
  }
  return result
}

/** 读取 .docx 并解析为块模型（便捷入口：读文件 → 解包 → parseDocumentXml） */
export function readDocx(filePath: string): DocxReadResult {
  const name = path.basename(filePath)
  let documentXml = ''
  let fsError = ''
  try {
    const buf = fs.readFileSync(filePath)
    documentXml = readZipEntryText(buf, 'word/document.xml') || ''
  } catch (e: any) {
    fsError = e?.message || String(e)
  }
  const res = parseDocumentXml(documentXml, filePath, name)
  if (fsError && !res.error) res.error = fsError
  return res
}
