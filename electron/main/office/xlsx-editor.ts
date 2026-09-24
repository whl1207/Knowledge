/**
 * xlsx 编辑引擎（直改 OOXML 部件，最大程度保真）
 *
 * 设计取舍：**不用 SheetJS 写回**（CE 版写回会丢掉单元格样式 / 图表 / 图片 / 数据透视），
 * 而是像 docx-editor 一样做「增量改包」：
 *  - 载入 .xlsx 全部部件到内存（loadXlsxPackage），只改 word 之外的对应 XML 部件；
 *  - 写单元格 = 在 xl/worksheets/sheetN.xml 里就地替换/插入 <c>（保留该单元格原有 s 样式索引）；
 *  - 字符串用 inlineStr 写入（不动 sharedStrings.xml，避免计数错乱）；
 *  - 公式写入 <f> 且不带缓存值，保存时在 workbook.xml 里置 fullCalcOnLoad=1，Excel 打开即重算；
 *  - 增删工作表同步维护 workbook.xml / rels / [Content_Types].xml 三处引用；
 *  - 保存 = 仅替换改动过的部件后重打包，写回前 .bak 备份 + tmp 原子改名。
 *
 * 纯 Node、零第三方依赖（ZIP 原语复用 ./docx-zip）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { unzipEntries, packZip, type ZipEntryData } from './docx-zip'
import { asUint8 } from '../buffer-view'

// ==================== 基础工具 ====================

function tagEnd(s: string, from: number): number {
  let quote = ''
  for (let i = from; i < s.length; i++) {
    const c = s[i]
    if (quote) { if (c === quote) quote = ''; continue }
    if (c === '\'' || c === '"') quote = c
    else if (c === '>') return i
  }
  return -1
}

function escapeXml(s: string): string {
  return String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function colToNum(letters: string): number {
  let n = 0
  for (const ch of String(letters).toUpperCase()) {
    const c = ch.charCodeAt(0)
    if (c < 65 || c > 90) return 0
    n = n * 26 + (c - 64)
  }
  return n
}

export function numToCol(n: number): string {
  let s = ''
  let x = Math.max(1, Math.floor(n))
  while (x > 0) {
    const rem = (x - 1) % 26
    s = String.fromCharCode(65 + rem) + s
    x = Math.floor((x - 1) / 26)
  }
  return s
}

/** 'B12' → { col: 2, row: 12 } */
export function parseA1(ref: string): { col: number; row: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(String(ref ?? '').trim())
  if (!m) return null
  const col = colToNum(m[1])
  const row = Number(m[2])
  return col > 0 && row > 0 ? { col, row } : null
}

/** xl/workbook.xml 的 rels Target（相对 xl/）→ 包内部件名 */
function resolveRelTarget(target: string): string {
  if (String(target).startsWith('/')) return String(target).slice(1)
  const base = ['xl']
  for (const p of String(target).split('/')) {
    if (p === '..') base.pop()
    else if (p !== '.' && p !== '') base.push(p)
  }
  return base.join('/')
}

// ==================== 内存包 ====================

export interface XlsxPackage {
  path: string
  name: string
  entries: ZipEntryData[]
  /** 已改动部件（部件名 → 新 XML 文本） */
  dirty: Map<string, string>
  /** 已删除部件 */
  removed: Set<string>
  modified: boolean
  /** 改动计数（读取侧缓存据此失效） */
  revision: number
  /** 写入过公式 → 保存时置 fullCalcOnLoad */
  formulaTouched: boolean
}

export function loadXlsxPackage(filePath: string): XlsxPackage {
  const buf = fs.readFileSync(filePath)
  const entries = unzipEntries(buf)
  return {
    path: filePath,
    name: path.basename(filePath),
    entries,
    dirty: new Map(),
    removed: new Set(),
    modified: false,
    revision: 0,
    formulaTouched: false,
  }
}

export function readPart(pkg: XlsxPackage, part: string): string {
  const d = pkg.dirty.get(part)
  if (d !== undefined) return d
  const e = pkg.entries.find(x => x.name === part)
  return e ? e.data.toString('utf8') : ''
}

export function writePart(pkg: XlsxPackage, part: string, xml: string): void {
  pkg.dirty.set(part, xml)
  pkg.removed.delete(part)
  pkg.modified = true
  pkg.revision++
}

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

export interface SheetRef {
  name: string
  sheetId: string
  rid: string
  /** 部件名，如 xl/worksheets/sheet1.xml */
  part: string
  state?: string
  /** 在 workbook.xml 中该 <sheet> 元素的位置（用于按序插入新表） */
  order: number
}

interface SheetEl {
  start: number
  end: number
  name: string
  sheetId: string
  rid: string
  state?: string
  order: number
}

/** 定位 workbook.xml 中全部 <sheet> 元素（自闭合与非自闭合都支持） */
function sheetElements(wbXml: string): SheetEl[] {
  const out: SheetEl[] = []
  const re = /<([\w]+:)?sheet\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(wbXml)) !== null) {
    const start = m.index
    const gt = tagEnd(wbXml, start + 1)
    if (gt < 0) break
    const open = wbXml.slice(start, gt + 1)
    let end = gt + 1
    if (!/\/\s*$/.test(open)) {
      const close = `</${m[1] || ''}sheet>`
      const ci = wbXml.indexOf(close, gt + 1)
      if (ci >= 0) end = ci + close.length
    }
    out.push({
      start,
      end,
      name: attrOf(open, 'name'),
      sheetId: attrOf(open, 'sheetId'),
      rid: attrOf(open, 'r:id'),
      state: attrOf(open, 'state') || undefined,
      order: out.length,
    })
    re.lastIndex = end
  }
  return out
}

/** 列出工作表（名称 / rId / 部件路径），读 workbook.xml + rels */
export function listSheetRefs(pkg: XlsxPackage): SheetRef[] {
  const wbXml = readPart(pkg, 'xl/workbook.xml')
  const relsXml = readPart(pkg, 'xl/_rels/workbook.xml.rels')
  const relMap = new Map<string, string>()
  const relRe = /<Relationship\b[^>]*\/>/g
  let rm: RegExpExecArray | null
  while ((rm = relRe.exec(relsXml)) !== null) {
    const id = /\bId="([^"]*)"/.exec(rm[0])?.[1]
    const target = /\bTarget="([^"]*)"/.exec(rm[0])?.[1]
    if (id && target) relMap.set(id, resolveRelTarget(target))
  }
  return sheetElements(wbXml).map(el => ({
    name: el.name,
    sheetId: el.sheetId,
    rid: el.rid,
    part: relMap.get(el.rid) || '',
    state: el.state,
    order: el.order,
  }))
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
}

export function sheetPartOf(pkg: XlsxPackage, sheetName: string): string | null {
  const hit = listSheetRefs(pkg).find(s => s.name === sheetName)
  return hit && hit.part ? hit.part : null
}

/** 内存包 → .xlsx Buffer（不落盘、不改动 pkg） */
export function buildXlsxBuffer(pkg: XlsxPackage): Buffer {
  const merged: ZipEntryData[] = []
  const seen = new Set<string>()
  for (const e of pkg.entries) {
    if (pkg.removed.has(e.name)) continue
    const d = pkg.dirty.get(e.name)
    merged.push(d !== undefined ? { name: e.name, data: Buffer.from(d, 'utf8') } : e)
    seen.add(e.name)
  }
  for (const [name, xml] of pkg.dirty) {
    if (!seen.has(name) && !pkg.removed.has(name)) merged.push({ name, data: Buffer.from(xml, 'utf8') })
  }
  return packZip(merged)
}

export interface SaveResult { ok: boolean; path: string; backup?: string; error?: string }

/** 保存：仅改动过的部件会被替换；写回前 .bak 备份 + tmp 原子改名 */
export function saveXlsxPackage(pkg: XlsxPackage, opts: { backup?: boolean } = {}): SaveResult {
  try {
    if (pkg.formulaTouched) ensureFullCalc(pkg)
    const packed = buildXlsxBuffer(pkg)
    const backupPath = pkg.path + '.bak'
    if (opts.backup !== false && fs.existsSync(pkg.path)) {
      try { fs.copyFileSync(pkg.path, backupPath) } catch { /* 备份失败不阻断保存 */ }
    }
    const tmp = pkg.path + '.__office_tmp'
    fs.writeFileSync(tmp, asUint8(packed))
    fs.renameSync(tmp, pkg.path)
    pkg.modified = false
    return { ok: true, path: pkg.path, backup: opts.backup !== false ? backupPath : undefined }
  } catch (e: any) {
    return { ok: false, path: pkg.path, error: e?.message || String(e) }
  }
}

/** 写入过公式 → 让 Excel/WPS 打开时强制重算（<calcPr fullCalcOnLoad="1"/>） */
function ensureFullCalc(pkg: XlsxPackage): void {
  const part = 'xl/workbook.xml'
  let xml = readPart(pkg, part)
  if (!xml) return
  if (/<calcPr\b[^>]*>/.test(xml)) {
    xml = xml.replace(/<calcPr\b[^>]*\/>/, (m0) => {
      let tag = m0.replace(/\s*\/>\s*$/, '')
      tag = /\bfullCalcOnLoad=/.test(tag) ? tag.replace(/\bfullCalcOnLoad="[^"]*"/, 'fullCalcOnLoad="1"') : tag + ' fullCalcOnLoad="1"'
      if (!/\bcalcId=/.test(tag)) tag += ' calcId="0"'
      return tag + '/>'
    })
  } else {
    xml = xml.replace(/<\/workbook>/, '<calcPr calcId="0" fullCalcOnLoad="1"/></workbook>')
  }
  pkg.dirty.set(part, xml)
}

// ==================== sheetN.xml 解析 ====================

interface ElementSpan {
  start: number
  end: number
  innerStart: number
  innerEnd: number
  selfClosing: boolean
  tagName: string
}

interface CellSpan {
  ref: string
  col: number
  row: number
  start: number
  end: number
}

interface RowSpan {
  r: number
  start: number
  end: number
  innerStart: number
  innerEnd: number
  selfClosing: boolean
  cells: CellSpan[]
}

interface SheetParse {
  prefix: string
  sheetData: ElementSpan | null
  rows: RowSpan[]
}

/** 定位元素（含内部区间）；自动识别命名空间前缀 */
function elementSpan(xml: string, name: string, from = 0): ElementSpan | null {
  const re = new RegExp(`<([\\w]+:)?${name}\\b`, 'g')
  re.lastIndex = from
  const m = re.exec(xml)
  if (!m) return null
  const prefix = m[1] || ''
  const start = m.index
  const gt = tagEnd(xml, start + 1)
  if (gt < 0) return null
  const tagName = prefix + name
  if (/\/\s*$/.test(xml.slice(start, gt + 1))) {
    return { start, end: gt + 1, innerStart: gt + 1, innerEnd: gt + 1, selfClosing: true, tagName }
  }
  const closeTag = `</${tagName}>`
  const close = xml.indexOf(closeTag, gt + 1)
  if (close < 0) return { start, end: gt + 1, innerStart: gt + 1, innerEnd: gt + 1, selfClosing: false, tagName }
  return { start, end: close + closeTag.length, innerStart: gt + 1, innerEnd: close, selfClosing: false, tagName }
}

function attrOf(openTag: string, name: string): string {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(openTag)
  return m ? decodeXmlEntities(m[1]) : ''
}

/** 解析工作表：sheetData 区间 + 每行/每单元格的绝对偏移 */
export function parseSheet(xml: string): SheetParse {
  const rootM = /<([\w]+:)?worksheet\b/.exec(xml)
  const prefix = rootM && rootM[1] ? rootM[1] : ''
  const sheetData = elementSpan(xml, 'sheetData')
  const rows: RowSpan[] = []
  if (sheetData && !sheetData.selfClosing) {
    const inner = xml.slice(sheetData.innerStart, sheetData.innerEnd)
    const re = /<([\w]+:)?row\b/g
    let m: RegExpExecArray | null
    let prevRow = 0
    while ((m = re.exec(inner)) !== null) {
      const relStart = m.index
      const absStart = sheetData.innerStart + relStart
      const gt = tagEnd(xml, absStart + 1)
      if (gt < 0) continue
      const openTag = xml.slice(absStart, gt + 1)
      const selfClosing = /\/\s*$/.test(openTag)
      let innerStart = gt + 1
      let innerEnd = gt + 1
      let end = gt + 1
      if (!selfClosing) {
        const closeTag = `</${m[1] || ''}row>`
        const close = xml.indexOf(closeTag, gt + 1)
        if (close >= 0) { innerEnd = close; end = close + closeTag.length }
      }
      const rAttr = Number(attrOf(openTag, 'r'))
      const r = Number.isFinite(rAttr) && rAttr > 0 ? rAttr : prevRow + 1
      prevRow = r
      const rowSpan: RowSpan = { r, start: absStart, end, innerStart, innerEnd, selfClosing, cells: [] }
      if (!selfClosing && innerEnd > innerStart) {
        const cellInner = xml.slice(innerStart, innerEnd)
        const cre = /<([\w]+:)?c\b/g
        let cm: RegExpExecArray | null
        let prevCol = 0
        while ((cm = cre.exec(cellInner)) !== null) {
          const cAbsStart = innerStart + cm.index
          const cGt = tagEnd(xml, cAbsStart + 1)
          if (cGt < 0) continue
          const cOpen = xml.slice(cAbsStart, cGt + 1)
          const cSelf = /\/\s*$/.test(cOpen)
          let cEnd = cGt + 1
          if (!cSelf) {
            const cClose = `</${cm[1] || ''}c>`
            const ci = xml.indexOf(cClose, cGt + 1)
            if (ci >= 0) cEnd = ci + cClose.length
          }
          const ref = attrOf(cOpen, 'r')
          const parsed = ref ? parseA1(ref) : null
          const col = parsed ? parsed.col : prevCol + 1
          prevCol = col
          rowSpan.cells.push({ ref: parsed ? `${numToCol(col)}${r}` : '', col, row: r, start: cAbsStart, end: cEnd })
          cre.lastIndex = cm.index + (cEnd - cAbsStart)
        }
      }
      rows.push(rowSpan)
      re.lastIndex = relStart + (end - absStart)
    }
  }
  return { prefix, sheetData, rows }
}

// ==================== 单元格写入 ====================

export interface CellUpdate {
  /** 目标工作表（省略时用工具级默认 sheet） */
  sheet?: string
  /** 单元格位置：ref / cell / a1 任一（如 'B12'），或 row + col（col 可为列字母或 1-based 序号） */
  ref?: string
  cell?: string
  a1?: string
  row?: number
  col?: string | number
  /** 值（字符串 / 数字 / 布尔；以 = 开头的字符串按公式处理） */
  value?: any
  /** 公式（等价 value='=公式'，推荐写法） */
  formula?: string
  /** 强制类型：auto（默认推断） */
  type?: 'auto' | 'string' | 'number' | 'boolean'
  /** 清空单元格（保留样式） */
  clear?: boolean
}

export interface CellChange { sheet: string; ref: string; note: string }

export interface ApplyResult {
  ok: boolean
  applied: CellChange[]
  errors: string[]
  error?: string
}

function cellStyleAttr(cellXml: string): string {
  const gt = cellXml.indexOf('>')
  const open = gt >= 0 ? cellXml.slice(0, gt + 1) : cellXml
  const m = /\bs="([^"]*)"/.exec(open)
  return m ? ` s="${m[1]}"` : ''
}

function buildCellXml(prefix: string, ref: string, styleAttr: string, u: CellUpdate): string {
  const p = prefix
  const head = `<${p}c r="${ref}"${styleAttr}`
  const hasValue = u.value !== undefined && u.value !== null && !(typeof u.value === 'string' && u.value === '')
  if (u.clear === true || (!hasValue && !u.formula)) return `${head}/>`
  if (u.formula) {
    const f = String(u.formula).replace(/^=/, '')
    return `${head}><${p}f>${escapeXml(f)}</${p}f></${p}c>`
  }
  const v = u.value
  if (u.type === 'boolean' || typeof v === 'boolean') {
    return `${head} t="b"><${p}v>${v === true || v === 'true' || v === 1 ? 1 : 0}</${p}v></${p}c>`
  }
  const asNumber = u.type === 'number' ? Number(v) : (typeof v === 'number' ? v : NaN)
  if (Number.isFinite(asNumber)) return `${head}><${p}v>${asNumber}</${p}v></${p}c>`
  const s = String(v)
  if (u.type !== 'string' && s.startsWith('=')) {
    return `${head}><${p}f>${escapeXml(s.slice(1))}</${p}f></${p}c>`
  }
  return `${head} t="inlineStr"><${p}is><${p}t xml:space="preserve">${escapeXml(s)}</${p}t></${p}is></${p}c>`
}

function buildRowXml(prefix: string, r: number, cellsXml: string[]): string {
  const p = prefix
  return `<${p}row r="${r}">${cellsXml.join('')}</${p}row>`
}

/** 计算新行插入偏移（保持行号升序） */
function rowInsertOffset(parse: SheetParse, r: number): number {
  const next = parse.rows.find(row => row.r > r)
  return next ? next.start : (parse.sheetData ? parse.sheetData.innerEnd : 0)
}

/** 计算新单元格插入偏移（保持列号升序） */
function cellInsertOffset(row: RowSpan, col: number): number {
  const next = row.cells.find(c => c.col > col)
  return next ? next.start : row.innerEnd
}

/** 重算 dimension（Excel 对 dimension 不精确也能打开，但更新后滚动/选区更准） */
function updateDimension(xml: string): string {
  const parse = parseSheet(xml)
  let maxRow = 0
  let maxCol = 0
  let count = 0
  for (const row of parse.rows) {
    for (const c of row.cells) {
      count++
      maxRow = Math.max(maxRow, row.r)
      maxCol = Math.max(maxCol, c.col)
    }
  }
  const ref = count === 0 ? 'A1' : (maxRow === 1 && maxCol === 1 ? 'A1' : `A1:${numToCol(maxCol)}${maxRow}`)
  const dim = elementSpan(xml, 'dimension')
  if (dim) {
    const gt = xml.indexOf('>', dim.start)
    const open = xml.slice(dim.start, gt + 1)
    const newOpen = /\bref="/.test(open) ? open.replace(/\bref="[^"]*"/, `ref="${ref}"`) : open.replace(/\/>$/, ` ref="${ref}"/>`)
    return xml.slice(0, dim.start) + newOpen + xml.slice(gt + 1)
  }
  const root = elementSpan(xml, 'worksheet')
  const at = root ? root.innerStart : 0
  const p = parse.prefix
  return xml.slice(0, at) + `<${p}dimension ref="${ref}"/>` + xml.slice(at)
}

function normalizeUpdates(updates: CellUpdate[], defaultSheet?: string): { list: { sheet: string; col: number; row: number; upd: CellUpdate }[]; errors: string[] } {
  const errors: string[] = []
  const list: { sheet: string; col: number; row: number; upd: CellUpdate }[] = []
  for (const u of updates || []) {
    if (!u || typeof u !== 'object') { errors.push('update 项必须是对象'); continue }
    const sheet = String(u.sheet || defaultSheet || '').trim()
    if (!sheet) { errors.push('未指定工作表（update.sheet 或参数 sheet）'); continue }
    let col = 0
    let row = 0
    const refStr = u.ref || u.cell || u.a1
    if (refStr) {
      const parsed = parseA1(String(refStr))
      if (parsed) { col = parsed.col; row = parsed.row }
    }
    if ((!col || !row) && u.row !== undefined && u.col !== undefined) {
      row = Math.floor(Number(u.row))
      col = typeof u.col === 'number' ? Math.floor(u.col) : (/^\d+$/.test(String(u.col)) ? Number(u.col) : colToNum(String(u.col)))
    }
    if (!col || !row || !Number.isFinite(col) || !Number.isFinite(row) || col < 1 || row < 1 || col > 16384 || row > 1048576) {
      errors.push(`无法解析单元格位置：${JSON.stringify({ ref: refStr, row: u.row, col: u.col })}`)
      continue
    }
    list.push({ sheet, col, row, upd: u })
  }
  return { list, errors }
}

/** 批量写单元格（同一工作表一次解析、按偏移倒序应用，避免位置漂移） */
export function applyCellUpdates(pkg: XlsxPackage, updates: CellUpdate[], defaultSheet?: string): ApplyResult {
  const { list, errors } = normalizeUpdates(updates, defaultSheet)
  const applied: CellChange[] = []
  if (!list.length) return { ok: false, applied, errors, error: '没有可应用的单元格修改' }

  const bySheet = new Map<string, { col: number; row: number; upd: CellUpdate }[]>()
  for (const item of list) {
    const arr = bySheet.get(item.sheet) || []
    arr.push(item)
    bySheet.set(item.sheet, arr)
  }

  const sheets = listSheetRefs(pkg)
  for (const [sheetName, items] of bySheet) {
    const part = sheets.find(s => s.name === sheetName)?.part
    if (!part) {
      errors.push(`工作表「${sheetName}」不存在（可用：${sheets.map(s => s.name).join('、')}）`)
      continue
    }
    let xml = readPart(pkg, part)
    if (!xml) { errors.push(`工作表「${sheetName}」部件缺失（${part}）`); continue }
    const parse = parseSheet(xml)

    // 同一单元格多次修改：后者胜
    const dedup = new Map<string, { col: number; row: number; upd: CellUpdate }>()
    for (const it of items) dedup.set(`${numToCol(it.col)}${it.row}`, it)
    const items2 = Array.from(dedup.values())

    const byRow = new Map<number, { col: number; row: number; upd: CellUpdate }[]>()
    for (const it of items2) {
      const arr = byRow.get(it.row) || []
      arr.push(it)
      byRow.set(it.row, arr)
    }

    interface Edit { start: number; end: number; text: string }
    const edits: Edit[] = []
    const rowMap = new Map<number, RowSpan>()
    parse.rows.forEach(r => rowMap.set(r.r, r))

    if (parse.sheetData && parse.sheetData.selfClosing && byRow.size) {
      // 空表：整块重建 sheetData
      const rowsXml: string[] = []
      for (const [r, cells] of Array.from(byRow.entries()).sort((a, b) => a[0] - b[0])) {
        const cellXmls = cells.slice().sort((a, b) => a.col - b.col)
          .map(c => buildCellXml(parse.prefix, `${numToCol(c.col)}${r}`, '', c.upd))
        rowsXml.push(buildRowXml(parse.prefix, r, cellXmls))
      }
      edits.push({ start: parse.sheetData.start, end: parse.sheetData.end, text: `<${parse.prefix}sheetData>${rowsXml.join('')}</${parse.prefix}sheetData>` })
      for (const [r, cells] of byRow) for (const c of cells) applied.push({ sheet: sheetName, ref: `${numToCol(c.col)}${r}`, note: '已写入（新建空表行）' })
    } else {
      for (const [r, cells] of byRow) {
        const rowSpan = rowMap.get(r)
        if (!rowSpan) {
          const cellXmls = cells.slice().sort((a, b) => a.col - b.col)
            .map(c => buildCellXml(parse.prefix, `${numToCol(c.col)}${r}`, '', c.upd))
          const at = rowInsertOffset(parse, r)
          edits.push({ start: at, end: at, text: buildRowXml(parse.prefix, r, cellXmls) })
          for (const c of cells) applied.push({ sheet: sheetName, ref: `${numToCol(c.col)}${r}`, note: '已写入（新建第 ' + r + ' 行）' })
          continue
        }
        if (rowSpan.selfClosing) {
          const cellXmls = cells.slice().sort((a, b) => a.col - b.col)
            .map(c => buildCellXml(parse.prefix, `${numToCol(c.col)}${r}`, '', c.upd))
          edits.push({ start: rowSpan.start, end: rowSpan.end, text: buildRowXml(parse.prefix, r, cellXmls) })
          for (const c of cells) applied.push({ sheet: sheetName, ref: `${numToCol(c.col)}${r}`, note: '已写入（展开空行）' })
          continue
        }
        // 行内：按列号倒序应用
        for (const c of cells.slice().sort((a, b) => b.col - a.col)) {
          const ref = `${numToCol(c.col)}${r}`
          const existing = rowSpan.cells.find(x => x.ref === ref || (x.col === c.col && !x.ref))
          const styleAttr = existing ? cellStyleAttr(xml.slice(existing.start, existing.end)) : ''
          const text = buildCellXml(parse.prefix, ref, styleAttr, c.upd)
          if (existing) {
            edits.push({ start: existing.start, end: existing.end, text })
            applied.push({ sheet: sheetName, ref, note: c.upd.formula ? '公式已更新' : (c.upd.clear ? '已清空（保留样式）' : '值已更新（保留样式）') })
          } else {
            const at = cellInsertOffset(rowSpan, c.col)
            edits.push({ start: at, end: at, text })
            applied.push({ sheet: sheetName, ref, note: '已写入（新建单元格）' })
          }
        }
      }
    }

    edits.sort((a, b) => b.start - a.start)
    for (const e of edits) xml = xml.slice(0, e.start) + e.text + xml.slice(e.end)
    xml = updateDimension(xml)
    if (items2.some(i => i.upd.formula || (typeof i.upd.value === 'string' && i.upd.value.startsWith('=')))) pkg.formulaTouched = true
    writePart(pkg, part, xml)
  }

  return { ok: applied.length > 0 && errors.length === 0, applied, errors }
}

// ==================== 行追加 / 工作表管理 ====================

export interface RowAppendResult { ok: boolean; sheet: string; startRow?: number; endRow?: number; added?: number; error?: string }

/** 追加若干行（从表末开始，列从 startCol 起） */
export function appendRowsToSheet(pkg: XlsxPackage, sheetName: string, rows: any[][], opts: { startCol?: number } = {}): RowAppendResult {
  const sheets = listSheetRefs(pkg)
  const part = sheets.find(s => s.name === sheetName)?.part
  if (!part) return { ok: false, sheet: sheetName, error: `工作表「${sheetName}」不存在（可用：${sheets.map(s => s.name).join('、')}）` }
  if (!rows || !rows.length) return { ok: false, sheet: sheetName, error: 'rows 为空（需二维数组）' }
  let xml = readPart(pkg, part)
  const parse = parseSheet(xml)
  const startCol = Math.max(1, Math.floor(Number(opts.startCol) || 1))
  const maxRow = parse.rows.reduce((m, r) => Math.max(m, r.r), 0)
  const startRow = maxRow + 1
  const built = rows.map((row, i) => {
    const r = startRow + i
    const cellXmls = (row || []).map((v, ci) => {
      const ref = `${numToCol(startCol + ci)}${r}`
      const u: CellUpdate = typeof v === 'object' && v !== null && ('formula' in v)
        ? { formula: String((v as any).formula) }
        : { value: v }
      if (typeof v === 'object' && v !== null && ('value' in v)) u.value = (v as any).value
      if (typeof v === 'object' && v !== null && ('type' in v)) u.type = (v as any).type
      return buildCellXml(parse.prefix, ref, '', u)
    }).filter(s => s !== '')
    return buildRowXml(parse.prefix, r, cellXmls)
  }).join('')

  if (parse.sheetData && !parse.sheetData.selfClosing) {
    xml = xml.slice(0, parse.sheetData.innerEnd) + built + xml.slice(parse.sheetData.innerEnd)
  } else if (parse.sheetData) {
    xml = xml.slice(0, parse.sheetData.start) + `<${parse.prefix}sheetData>${built}</${parse.prefix}sheetData>` + xml.slice(parse.sheetData.end)
  } else {
    return { ok: false, sheet: sheetName, error: '工作表缺少 sheetData 节点，无法追加行' }
  }
  xml = updateDimension(xml)
  if (rows.some(r => (r || []).some(v => typeof v === 'string' && v.startsWith('=')))) pkg.formulaTouched = true
  writePart(pkg, part, xml)
  return { ok: true, sheet: sheetName, startRow, endRow: startRow + rows.length - 1, added: rows.length }
}

const SHEET_NAME_BAD = /[:\\/?*\[\]]/

function validateSheetName(name: string, existing: string[]): string | null {
  const n = String(name || '').trim()
  if (!n) return '工作表名不能为空'
  if (n.length > 31) return '工作表名最长 31 个字符'
  if (SHEET_NAME_BAD.test(n)) return '工作表名不能包含 : \\ / ? * [ ] 等字符'
  if (existing.some(e => e.toLowerCase() === n.toLowerCase())) return `工作表「${n}」已存在`
  return null
}

function nextSheetPartAndIds(pkg: XlsxPackage): { part: string; sheetId: string; rid: string } {
  let maxIdx = 0
  const names = new Set<string>()
  for (const e of pkg.entries) names.add(e.name)
  for (const k of pkg.dirty.keys()) names.add(k)
  for (const n of names) {
    const m = /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(n)
    if (m) maxIdx = Math.max(maxIdx, Number(m[1]))
  }
  const wbXml = readPart(pkg, 'xl/workbook.xml')
  const relsXml = readPart(pkg, 'xl/_rels/workbook.xml.rels')
  let maxSheetId = 0
  const idRe = /\bsheetId="(\d+)"/g
  let im: RegExpExecArray | null
  while ((im = idRe.exec(wbXml)) !== null) maxSheetId = Math.max(maxSheetId, Number(im[1]))
  let maxRid = 0
  const ridRe = /\bId="rId(\d+)"/g
  let rm: RegExpExecArray | null
  while ((rm = ridRe.exec(relsXml)) !== null) maxRid = Math.max(maxRid, Number(rm[1]))
  return { part: `xl/worksheets/sheet${maxIdx + 1}.xml`, sheetId: String(maxSheetId + 1), rid: `rId${maxRid + 1}` }
}

function sheetXmlFromRows(rows: any[][]): { xml: string; hasFormula: boolean } {
  const built = (rows || []).map((row, ri) => {
    const r = ri + 1
    const cellXmls = (row || []).map((v, ci) => buildCellXml('', `${numToCol(ci + 1)}${r}`, '', { value: v })).filter(s => s !== '')
    return cellXmls.length ? buildRowXml('', r, cellXmls) : ''
  }).join('')
  const lastRow = (rows || []).length
  const lastCol = Math.max(1, ...(rows || []).map(r => (r || []).length))
  const ref = lastRow === 0 ? 'A1' : (lastRow === 1 && lastCol === 1 ? 'A1' : `A1:${numToCol(lastCol)}${lastRow}`)
  const hasFormula = (rows || []).some(r => (r || []).some(v => typeof v === 'string' && v.startsWith('=')))
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL_NS}"><dimension ref="${ref}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>${built}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`
  return { xml, hasFormula }
}

function contentTypesWithSheet(xml: string, part: string): string {
  const override = `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  if (xml.includes(`PartName="/${part}"`)) return xml
  return xml.replace(/<\/Types>/, `${override}</Types>`)
}

function relsWithSheet(xml: string, rid: string, part: string): string {
  const rel = `<Relationship Id="${rid}" Type="${REL_NS}/worksheet" Target="${part.replace(/^xl\//, '')}"/>`
  if (new RegExp(`Id="${rid}"`).test(xml)) return xml
  return xml.replace(/<\/Relationships>/, `${rel}</Relationships>`)
}

export interface SheetOpResult { ok: boolean; error?: string; part?: string; note?: string }

/** 新增工作表（可带初始数据；index 指定插入位置，默认追加到最后） */
export function addSheet(pkg: XlsxPackage, name: string, opts: { rows?: any[][]; index?: number } = {}): SheetOpResult {
  const refs = listSheetRefs(pkg)
  const bad = validateSheetName(name, refs.map(s => s.name))
  if (bad) return { ok: false, error: bad }
  const { part, sheetId, rid } = nextSheetPartAndIds(pkg)
  const built = sheetXmlFromRows(opts.rows || [])

  // workbook.xml：插入 <sheet>
  // 注意：Excel/openpyxl 生成的 <sheet> 会在元素上自带 xmlns:r 声明（不靠根元素继承），
  // 新元素必须同样声明 r 前缀，否则整份 workbook.xml 非法（openpyxl 直接报 Namespace prefix r not defined）。
  let wbXml = readPart(pkg, 'xl/workbook.xml')
  const sheetEl = `<sheet xmlns:r="${REL_NS}" name="${escapeXml(name)}" sheetId="${sheetId}" r:id="${rid}"/>`
  const sheetsEl = elementSpan(wbXml, 'sheets')
  if (!sheetsEl) return { ok: false, error: 'workbook.xml 缺少 <sheets> 节点' }
  if (sheetsEl.selfClosing) {
    wbXml = wbXml.slice(0, sheetsEl.start) + `<sheets>${sheetEl}</sheets>` + wbXml.slice(sheetsEl.end)
  } else {
    const idx = opts.index !== undefined ? Math.max(0, Math.min(refs.length, Math.floor(Number(opts.index)))) : refs.length
    const els = sheetElements(wbXml)
    const at = idx < els.length ? els[idx].start : sheetsEl.innerEnd
    wbXml = wbXml.slice(0, at) + sheetEl + wbXml.slice(at)
  }
  pkg.dirty.set('xl/workbook.xml', wbXml)

  const relsPart = 'xl/_rels/workbook.xml.rels'
  pkg.dirty.set(relsPart, relsWithSheet(readPart(pkg, relsPart), rid, part))
  const ctPart = '[Content_Types].xml'
  pkg.dirty.set(ctPart, contentTypesWithSheet(readPart(pkg, ctPart), part))
  pkg.dirty.set(part, built.xml)
  pkg.modified = true
  pkg.revision++
  if (built.hasFormula) pkg.formulaTouched = true
  return { ok: true, part, note: `已新增工作表「${name}」（${(opts.rows || []).length} 行）` }
}

/** 重命名工作表 */
export function renameSheet(pkg: XlsxPackage, from: string, to: string): SheetOpResult {
  const refs = listSheetRefs(pkg)
  const target = refs.find(s => s.name === from)
  if (!target) return { ok: false, error: `工作表「${from}」不存在（可用：${refs.map(s => s.name).join('、')}）` }
  const bad = validateSheetName(to, refs.filter(s => s !== target).map(s => s.name))
  if (bad) return { ok: false, error: bad }
  let wbXml = readPart(pkg, 'xl/workbook.xml')
  const els = sheetElements(wbXml)
  const el = els.find(e => e.order === target.order)
  if (!el) return { ok: false, error: '未能在 workbook.xml 中定位该工作表节点' }
  const openTag = wbXml.slice(el.start, wbXml.indexOf('>', el.start) + 1)
  const newOpen = /\bname="/.test(openTag)
    ? openTag.replace(/\bname="[^"]*"/, `name="${escapeXml(String(to).trim())}"`)
    : openTag.replace(/\s*\/?>$/, ` name="${escapeXml(String(to).trim())}"/>`)
  wbXml = wbXml.slice(0, el.start) + newOpen + wbXml.slice(wbXml.indexOf('>', el.start) + 1)
  writePart(pkg, 'xl/workbook.xml', wbXml)
  return { ok: true, note: `工作表「${from}」已改名为「${String(to).trim()}」` }
}

/** 删除工作表（同步清理 workbook.xml / rels / Content_Types / 部件本体） */
export function deleteSheet(pkg: XlsxPackage, name: string): SheetOpResult {
  const refs = listSheetRefs(pkg)
  const target = refs.find(s => s.name === name)
  if (!target) return { ok: false, error: `工作表「${name}」不存在（可用：${refs.map(s => s.name).join('、')}）` }
  if (refs.length <= 1) return { ok: false, error: '至少要保留一个工作表' }
  const visible = refs.filter(s => s.state !== 'hidden' && s.state !== 'veryHidden')
  if (visible.length <= 1 && target.state !== 'hidden' && target.state !== 'veryHidden') {
    return { ok: false, error: '至少要保留一个可见工作表' }
  }
  // workbook.xml 移除 <sheet>
  const wbXml = readPart(pkg, 'xl/workbook.xml')
  const els = sheetElements(wbXml)
  const el = els.find(e => e.order === target.order)
  if (!el) return { ok: false, error: '未能在 workbook.xml 中定位该工作表节点' }
  writePart(pkg, 'xl/workbook.xml', wbXml.slice(0, el.start) + wbXml.slice(el.end))
  // rels 移除关系
  const relsPart = 'xl/_rels/workbook.xml.rels'
  const rels = readPart(pkg, relsPart)
  writePart(pkg, relsPart, rels.replace(new RegExp(`<Relationship\\b[^>]*Id="${target.rid}"[^>]*/>`), ''))
  // Content_Types 移除 Override
  if (target.part) {
    const ctPart = '[Content_Types].xml'
    const ct = readPart(pkg, ctPart)
    writePart(pkg, ctPart, ct.replace(new RegExp(`<Override\\b[^>]*PartName="/${target.part}"[^>]*/>`), ''))
    pkg.dirty.delete(target.part)
    pkg.removed.add(target.part)
    const sheetRels = target.part.replace(/([^/]+)$/, '_rels/$1.rels')
    if (pkg.entries.some(e => e.name === sheetRels) || pkg.dirty.has(sheetRels)) {
      pkg.dirty.delete(sheetRels)
      pkg.removed.add(sheetRels)
    }
  }
  pkg.modified = true
  pkg.revision++
  return { ok: true, note: `已删除工作表「${name}」` }
}

// ==================== 公式读取 ====================

/**
 * 取某工作表的公式表：A1 → 公式文本。
 * 用途：本引擎（与 openpyxl 等写库）写入的公式单元格只有 <f> 无缓存 <v>，
 * SheetJS 会直接丢弃这类单元格 → 读取侧用它把公式显示出来（如 =SUM(B2:B4)）。
 */
export function formulaCells(pkg: XlsxPackage, sheetName: string): Map<string, string> {
  const map = new Map<string, string>()
  const part = sheetPartOf(pkg, sheetName)
  if (!part) return map
  const xml = readPart(pkg, part)
  if (!xml) return map
  const parse = parseSheet(xml)
  for (const row of parse.rows) {
    for (const c of row.cells) {
      if (!c.ref) continue
      const cellXml = xml.slice(c.start, c.end)
      const m = /<(?:[\w]+:)?f(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w]+:)?f>/.exec(cellXml)
      if (!m || !m[1]) continue
      map.set(c.ref, decodeXmlEntities(m[1]))
    }
  }
  return map
}

// ==================== 新建工作簿 ====================

export interface NewSheetInput { name: string; rows?: any[][] }

/** 新建 .xlsx（不覆盖已存在文件，除非 overwrite=true） */
export function createWorkbookFile(filePath: string, sheets: NewSheetInput[], opts: { overwrite?: boolean } = {}): SaveResult {
  const abs = path.resolve(String(filePath || ''))
  if (!abs) return { ok: false, path: '', error: '缺少文件路径' }
  if (fs.existsSync(abs) && !opts.overwrite) return { ok: false, path: abs, error: `文件已存在：${abs}（如需覆盖请传 overwrite=true）` }
  const list = (sheets && sheets.length ? sheets : [{ name: 'Sheet1', rows: [] as any[][] }]).map((s, i) => ({
    name: String(s.name || `Sheet${i + 1}`).trim().slice(0, 31) || `Sheet${i + 1}`,
    rows: s.rows || [],
  }))
  const entries: ZipEntryData[] = []
  const sheetTags = list.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
  const rels = list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rId${list.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/>`
  const overrides = list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
  const xmlHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  entries.push({ name: '[Content_Types].xml', data: Buffer.from(xmlHeader +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`, 'utf8') })
  entries.push({ name: '_rels/.rels', data: Buffer.from(xmlHeader +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`, 'utf8') })
  entries.push({ name: 'xl/workbook.xml', data: Buffer.from(xmlHeader +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL_NS}"><sheets>${sheetTags}</sheets><calcPr calcId="0" fullCalcOnLoad="1"/></workbook>`, 'utf8') })
  entries.push({ name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(xmlHeader +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`, 'utf8') })
  entries.push({ name: 'xl/styles.xml', data: Buffer.from(xmlHeader +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>', 'utf8') })
  let hasFormula = false
  list.forEach((s, i) => {
    const built = sheetXmlFromRows(s.rows)
    if (built.hasFormula) hasFormula = true
    entries.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(built.xml, 'utf8') })
  })

  const pkg: XlsxPackage = {
    path: abs,
    name: path.basename(abs),
    entries,
    dirty: new Map(),
    removed: new Set(),
    modified: true,
    revision: 1,
    formulaTouched: hasFormula,
  }
  const res = saveXlsxPackage(pkg, { backup: false })
  if (res.ok) res.backup = undefined
  return res
}
