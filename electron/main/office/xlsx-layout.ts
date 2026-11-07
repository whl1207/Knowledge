/**
 * xlsx-layout.ts — Excel 结构 / 版式操作（行列增删、列宽行高、冻结、合并、数据验证）
 *
 * 只做 worksheet XML 的安全增删与属性修改，不重建整张表；样式 / 公式 / 图表原样保留。
 * 已知限制：
 * - 移动行列时不会自动改写公式引用与合并区域（调用方应重新检查）；
 * - 数据验证只支持 list / whole / decimal / date / textLength 的简单形式。
 */
import { parseA1, colToNum, numToCol, readPart, writePart, sheetPartOf, type XlsxPackage } from './xlsx-editor'

export interface LayoutResult {
  ok: boolean
  error?: string
  detail?: string
  revision?: number
}

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function mapCellRefs(xml: string, fn: (col: number, row: number) => { col: number; row: number } | null): string {
  return xml
    .replace(/(<c\b[^>]*\br=")([A-Za-z]+)(\d+)(")/g, (_m, pre: string, c: string, r: string, post: string) => {
      const p = parseA1(`${c}${r}`)
      if (!p) return `${pre}${c}${r}${post}`
      const n = fn(p.col, p.row)
      return n ? `${pre}${numToCol(n.col)}${n.row}${post}` : `${pre}${c}${r}${post}`
    })
    .replace(/(<row\b[^>]*\br=")(\d+)(")/g, (_m, pre: string, r: string, post: string) => {
      const n = fn(1, Number(r))
      return `${pre}${n ? n.row : r}${post}`
    })
}

function shiftRows(xml: string, at: number, delta: number): string {
  return mapCellRefs(xml, (c, r) => r >= at ? { col: c, row: Math.max(1, r + delta) } : { col: c, row: r })
}

function shiftCols(xml: string, at: number, delta: number): string {
  return mapCellRefs(xml, (c, r) => c >= at ? { col: Math.max(1, c + delta), row: r } : { col: c, row: r })
}

function sheetXml(pkg: XlsxPackage, name: string): { part: string; xml: string } | null {
  const part = sheetPartOf(pkg, name)
  if (!part) return null
  return { part, xml: readPart(pkg, part) }
}

export function insertRows(pkg: XlsxPackage, sheet: string, at: number, count = 1): LayoutResult {
  const s = sheetXml(pkg, sheet)
  if (!s) return { ok: false, error: `工作表不存在: ${sheet}` }
  if (!Number.isInteger(at) || at < 1) return { ok: false, error: 'at 必须是从 1 开始的行号' }
  const n = Math.max(1, Math.floor(count || 1))
  writePart(pkg, s.part, shiftRows(s.xml, at, n))
  return { ok: true, detail: `已在 ${sheet} 第 ${at} 行前插入 ${n} 行`, revision: pkg.revision }
}

export function deleteRows(pkg: XlsxPackage, sheet: string, at: number, count = 1): LayoutResult {
  const s = sheetXml(pkg, sheet)
  if (!s) return { ok: false, error: `工作表不存在: ${sheet}` }
  if (!Number.isInteger(at) || at < 1) return { ok: false, error: 'at 必须是从 1 开始的行号' }
  const n = Math.max(1, Math.floor(count || 1))
  let xml = s.xml
  // 先删区间内的行，再把后面的行上移
  for (let r = at; r < at + n; r++) {
    xml = xml.replace(new RegExp(`<row\\b[^>]*\\br="${r}"[^>]*>[\\s\\S]*?<\\/row>`, 'g'), '')
    xml = xml.replace(new RegExp(`<row\\b[^>]*\\br="${r}"[^>]*\\/>`, 'g'), '')
  }
  xml = mapCellRefs(xml, (c, r) => {
    if (r >= at && r < at + n) return null
    return r >= at + n ? { col: c, row: r - n } : { col: c, row: r }
  })
  writePart(pkg, s.part, xml)
  return { ok: true, detail: `已删除 ${sheet} 第 ${at} 行起的 ${n} 行`, revision: pkg.revision }
}

export function insertColumns(pkg: XlsxPackage, sheet: string, at: number, count = 1): LayoutResult {
  const s = sheetXml(pkg, sheet)
  if (!s) return { ok: false, error: `工作表不存在: ${sheet}` }
  if (!Number.isInteger(at) || at < 1) return { ok: false, error: 'at 必须是从 1 开始的列号' }
  const n = Math.max(1, Math.floor(count || 1))
  writePart(pkg, s.part, shiftCols(s.xml, at, n))
  return { ok: true, detail: `已在 ${sheet} 第 ${numToCol(at)} 列前插入 ${n} 列`, revision: pkg.revision }
}

export function deleteColumns(pkg: XlsxPackage, sheet: string, at: number, count = 1): LayoutResult {
  const s = sheetXml(pkg, sheet)
  if (!s) return { ok: false, error: `工作表不存在: ${sheet}` }
  if (!Number.isInteger(at) || at < 1) return { ok: false, error: 'at 必须是从 1 开始的列号' }
  const n = Math.max(1, Math.floor(count || 1))
  const xml = mapCellRefs(s.xml, (c, r) => {
    if (c >= at && c < at + n) return null
    return c >= at + n ? { col: c - n, row: r } : { col: c, row: r }
  })
  writePart(pkg, s.part, xml)
  return { ok: true, detail: `已删除 ${sheet} 第 ${numToCol(at)} 列起的 ${n} 列`, revision: pkg.revision }
}

export function setColumnWidth(pkg: XlsxPackage, sheet: string, at: number, count: number, width: number): LayoutResult {
  const s = sheetXml(pkg, sheet)
  if (!s) return { ok: false, error: `工作表不存在: ${sheet}` }
  const n = Math.max(1, Math.floor(count || 1))
  const cols = Array.from({ length: n }, (_, i) => `<col min="${at + i}" max="${at + i}" width="${Number(width)}" customWidth="1"/>`).join('')
  let xml = s.xml
  // 移除与新范围重叠的旧 col 定义，避免 Excel 采用旧宽度
  xml = xml.replace(/<col\b[^>]*\/>/g, (m) => {
    const min = Number(/\bmin="(\d+)"/.exec(m)?.[1] || 0)
    const max = Number(/\bmax="(\d+)"/.exec(m)?.[1] || min)
    return (min <= at + n - 1 && max >= at) ? '' : m
  })
  if (/<cols\b[\s\S]*?<\/cols>/.test(xml)) {
    xml = xml.replace(/<cols\b[\s\S]*?<\/cols>/, (m) => m.replace('</cols>', `${cols}</cols>`))
  } else {
    xml = xml.replace(/(<sheetData\b)/, `<cols>${cols}</cols>$1`)
  }
  writePart(pkg, s.part, xml)
  return { ok: true, detail: `已设置 ${sheet} 列宽 ${at}..${at + n - 1} = ${width}`, revision: pkg.revision }
}

export function setRowHeight(pkg: XlsxPackage, sheet: string, at: number, height: number): LayoutResult {
  const s = sheetXml(pkg, sheet)
  if (!s) return { ok: false, error: `工作表不存在: ${sheet}` }
  let xml = s.xml
  const rowRe = new RegExp(`<row\\b([^>]*\\br="${at}"[^>]*)>`)
  if (rowRe.test(xml)) {
    xml = xml.replace(rowRe, (_m, attrs: string) => {
      let a = attrs
      if (/\bht="[^"]*"/.test(a)) a = a.replace(/\bht="[^"]*"/, `ht="${height}"`)
      else a += ` ht="${height}"`
      if (!/\bcustomHeight="[^"]*"/.test(a)) a += ' customHeight="1"'
      return `<row${a}>`
    })
  } else {
    xml = xml.replace('</sheetData>', `<row r="${at}" ht="${height}" customHeight="1"></row></sheetData>`)
  }
  writePart(pkg, s.part, xml)
  return { ok: true, detail: `已设置 ${sheet} 第 ${at} 行高度 ${height}`, revision: pkg.revision }
}

export function freezePanes(pkg: XlsxPackage, sheet: string, row: number, col: number): LayoutResult {
  const s = sheetXml(pkg, sheet)
  if (!s) return { ok: false, error: `工作表不存在: ${sheet}` }
  const topLeft = `${numToCol(Math.max(1, col))}${Math.max(1, row)}`
  const pane = `<pane xSplit="${Math.max(0, col - 1)}" ySplit="${Math.max(0, row - 1)}" topLeftCell="${topLeft}" activePane="bottomRight" state="frozen"/>`
  let xml = s.xml
  const viewRe = /<sheetView\b[^>]*>([\s\S]*?)<\/sheetView>/
  if (viewRe.test(xml)) {
    xml = xml.replace(viewRe, (_m, inner: string) => `<sheetView workbookViewId="0">${pane}${inner.replace(/<pane\b[^>]*\/>/g, '')}</sheetView>`)
  } else {
    xml = xml.replace(/(<sheetViews\b[^>]*>)/, `$1<sheetView workbookViewId="0">${pane}</sheetView>`)
  }
  writePart(pkg, s.part, xml)
  return { ok: true, detail: `已冻结 ${sheet} 的 ${topLeft} 左上区域`, revision: pkg.revision }
}

export function mergeCells(pkg: XlsxPackage, sheet: string, ranges: string[]): LayoutResult {
  const s = sheetXml(pkg, sheet)
  if (!s) return { ok: false, error: `工作表不存在: ${sheet}` }
  const valid = ranges.map(r => String(r).trim()).filter(Boolean)
  if (!valid.length) return { ok: false, error: 'ranges 不能为空' }
  let xml = s.xml.replace(/<mergeCells\b[\s\S]*?<\/mergeCells>/g, '')
  const inner = valid.map(r => `<mergeCell ref="${esc(r)}"/>`).join('')
  xml = xml.replace('</sheetData>', `</sheetData><mergeCells count="${valid.length}">${inner}</mergeCells>`)
  writePart(pkg, s.part, xml)
  return { ok: true, detail: `已合并 ${valid.length} 个区域`, revision: pkg.revision }
}

export function unmergeCells(pkg: XlsxPackage, sheet: string, ranges?: string[]): LayoutResult {
  const s = sheetXml(pkg, sheet)
  if (!s) return { ok: false, error: `工作表不存在: ${sheet}` }
  let xml = s.xml
  if (!ranges || !ranges.length) {
    xml = xml.replace(/<mergeCells\b[\s\S]*?<\/mergeCells>/g, '')
  } else {
    for (const r of ranges) {
      xml = xml.replace(new RegExp(`<mergeCell\\b[^>]*\\bref="${esc(r)}"[^>]*\\/>`, 'g'), '')
    }
    xml = xml.replace(/<mergeCells count="\d+">/, () => `<mergeCells count="${(xml.match(/<mergeCell\b/g) || []).length}">`)
  }
  writePart(pkg, s.part, xml)
  return { ok: true, detail: '已取消合并', revision: pkg.revision }
}

export function addDataValidation(pkg: XlsxPackage, sheet: string, range: string, opts: { type: string; formula1: string; allowBlank?: boolean; prompt?: string }): LayoutResult {
  const s = sheetXml(pkg, sheet)
  if (!s) return { ok: false, error: `工作表不存在: ${sheet}` }
  const type = String(opts.type || 'list')
  const f1 = String(opts.formula1 || '')
  const attrs = [
    `type="${esc(type)}"`,
    `allowBlank="${opts.allowBlank === false ? 0 : 1}"`,
    'showInputMessage="1"',
    'showErrorMessage="1"',
    opts.prompt ? `prompt="${esc(opts.prompt)}"` : '',
  ].filter(Boolean).join(' ')
  const val = `<dataValidation ${attrs} sqref="${esc(range)}"><formula1>${esc(f1)}</formula1></dataValidation>`
  let xml = s.xml
  if (/<dataValidations\b[\s\S]*?<\/dataValidations>/.test(xml)) {
    xml = xml.replace(/<\/dataValidations>/, `${val}</dataValidations>`)
  } else {
    xml = xml.replace('</sheetData>', `</sheetData><dataValidations count="1">${val}</dataValidations>`)
  }
  writePart(pkg, s.part, xml)
  return { ok: true, detail: `已为 ${range} 添加 ${type} 数据验证`, revision: pkg.revision }
}
