/**
 * Excel 读取 / 查询内核（Node 端，依赖 SheetJS）
 *
 * 只读：打开工作簿 → 工作表元信息 → 区域取数 → 检索 / 筛选 / 分组聚合。
 * 写入走 xlsx-editor（直接改 OOXML 部件，保留样式/公式/图表），二者互不依赖：
 * 读取时统一从「当前内存包」的字节做解析（见 office-service），因此未保存的修改也能读到。
 *
 * 约定：
 *  - 行列对外一律 **1-based**（与 Excel 界面一致），列可用列字母 'A'、序号 1 或表头名；
 *  - `text`（显示文本）优先用单元格格式化结果 cell.w，`raw` 用原始值 cell.v；
 *  - 单元格取值一律经过 capCells 限制，避免把整张巨表塞进模型上下文。
 */
import xlsx from 'xlsx'
import * as fs from 'node:fs'

export type Row = any[]

export interface CellMatrix {
  /** 原始值矩阵（raw: cell.v） */
  raw: Row[]
  /** 显示文本矩阵（cell.w 优先） */
  text: string[][]
  /** 每行在工作表中的行号（1-based），与 rows 一一对应 */
  rowNumbers: number[]
  startRow: number
  startCol: number
  truncated: boolean
  note?: string
}

export interface MatrixOptions {
  startRow?: number
  endRow?: number
  startCol?: number
  endCol?: number
  /** 单元格上限（默认 20000），超出按行截断 */
  maxCells?: number
  /** 扫描行数上限（默认 20000，防超巨型表拖垮主进程） */
  maxScanRows?: number
  /**
   * 公式覆盖表（A1 → 公式文本）：
   * 只有 <f> 没有缓存 <v> 的公式单元格会被 SheetJS 丢弃，用此表补上（显示为 =公式）。
   */
  formulaOverlay?: Map<string, string>
}

/** 文本类表格（csv/txt/tsv）按文本读入：UTF-8 优先，出现替换符时回退 GBK */
function decodeTableText(buf: Buffer): string {
  let s = buf.toString('utf8')
  if (s.includes('\uFFFD')) {
    try { s = new TextDecoder('gbk').decode(buf) } catch { /* 保留 UTF-8 结果 */ }
  }
  return s.replace(/^\uFEFF/, '')
}

/** 打开工作簿：从文件或内存字节（cellFormula 保留公式文本，cellDates 让日期成为 Date） */
export function readWorkbookFrom(source: { buffer?: Buffer; filePath?: string }): xlsx.WorkBook {
  const opts: xlsx.ParsingOptions = { cellFormula: true, cellDates: true, cellText: true, dense: false }
  if (source.buffer) return xlsx.read(source.buffer, { type: 'buffer', ...opts })
  const p = String(source.filePath || '')
  if (/\.(csv|tsv|txt)$/i.test(p)) {
    return xlsx.read(decodeTableText(fs.readFileSync(p)), { type: 'string', ...opts })
  }
  return xlsx.readFile(p, opts)
}

function rangeOf(ws: xlsx.WorkSheet): xlsx.Range | null {
  const ref = (ws as any)['!ref'] as string | undefined
  if (!ref) return null
  try { return xlsx.utils.decode_range(ref) } catch { return null }
}

export function colLetter(index1: number): string {
  return xlsx.utils.encode_col(Math.max(0, index1 - 1))
}

export function colIndex(letter: string): number {
  try { return xlsx.utils.decode_col(String(letter).toUpperCase()) + 1 } catch { return 1 }
}

/** 取单元格显示文本（w 优先；数字/布尔转字符串；空 → ''） */
function displayText(cell: xlsx.CellObject | undefined): string {
  if (!cell) return ''
  if (cell.w !== undefined && cell.w !== null) return String(cell.w)
  const v = cell.v
  if (v === undefined || v === null) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v)
}

/**
 * 取区域矩阵（同时给出原始值与显示文本，一遍扫描）。
 * 行列均为 1-based；不传区域时取整张表的 !ref 范围。
 */
export function cellMatrix(ws: xlsx.WorkSheet, opts: MatrixOptions = {}): CellMatrix {
  const range = rangeOf(ws)
  const sheetFirstRow = range ? range.s.r + 1 : 1
  let sheetLastRow = range ? range.e.r + 1 : 0
  const sheetFirstCol = range ? range.s.c + 1 : 1
  let sheetLastCol = range ? range.e.c + 1 : 1
  // 公式覆盖表可能超出 !ref：只有 <f> 没有缓存值的单元格会被 SheetJS 丢弃（outsider 写库很常见），
  // 这里按公式表把范围下界/右界补齐，否则这些行/列会被当作不存在。
  if (opts.formulaOverlay?.size) {
    for (const ref of opts.formulaOverlay.keys()) {
      const p = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(String(ref))
      if (!p) continue
      const c = colIndex(p[1])
      const r = Number(p[2])
      if (Number.isFinite(r) && r > sheetLastRow) sheetLastRow = r
      if (Number.isFinite(c) && c > sheetLastCol) sheetLastCol = c
    }
  }

  const startRow = Math.max(sheetFirstRow, Math.floor(Number(opts.startRow) || sheetFirstRow))
  const startCol = Math.max(sheetFirstCol, Math.floor(Number(opts.startCol) || sheetFirstCol))
  let endRow = Math.min(sheetLastRow, Math.floor(Number(opts.endRow) || sheetLastRow))
  const endCol = Math.min(sheetLastCol, Math.floor(Number(opts.endCol) || sheetLastCol))

  const maxCells = Math.max(1, Math.floor(Number(opts.maxCells) || 20000))
  const maxScanRows = Math.max(1, Math.floor(Number(opts.maxScanRows) || 20000))
  let truncated = false
  let note: string | undefined

  if (endRow > startRow + maxScanRows - 1) {
    endRow = startRow + maxScanRows - 1
    truncated = true
    note = `行数超过扫描上限 ${maxScanRows}，仅扫描前 ${maxScanRows} 行（可用 startRow/endRow 分段读取）`
  }
  const cols = endRow >= startRow ? endCol - startCol + 1 : 0
  if (cols > 0 && (endRow - startRow + 1) * cols > maxCells) {
    const keep = Math.floor(maxCells / cols)
    endRow = startRow + Math.max(0, keep - 1)
    truncated = true
    note = `单元格数超过上限 ${maxCells}，仅返回前 ${endRow - startRow + 1} 行（可用 startRow/endRow 分段读取）`
  }

  const raw: Row[] = []
  const text: string[][] = []
  const rowNumbers: number[] = []
  for (let r = startRow; r <= endRow; r++) {
    const rawRow: Row = []
    const textRow: string[] = []
    for (let c = startCol; c <= endCol; c++) {
      const cell = ws[xlsx.utils.encode_cell({ r: r - 1, c: c - 1 })] as xlsx.CellObject | undefined
      let rv: any = cell ? (cell.v ?? null) : null
      let tv = displayText(cell)
      if (opts.formulaOverlay && (rv === null || rv === undefined) && tv === '') {
        const f = opts.formulaOverlay.get(`${colLetter(c)}${r}`)
        if (f) { rv = '=' + f; tv = '=' + f }
      }
      rawRow.push(rv)
      textRow.push(tv)
    }
    raw.push(rawRow)
    text.push(textRow)
    rowNumbers.push(r)
  }
  return { raw, text, rowNumbers, startRow, startCol, truncated, note }
}

/** 取单元格公式文本（无公式 → null）；行列均 1-based */
export function cellFormulaAt(ws: xlsx.WorkSheet, r: number, c: number): string | null {
  const cell = ws[xlsx.utils.encode_cell({ r: r - 1, c: c - 1 })] as xlsx.CellObject | undefined
  return cell && cell.f ? String(cell.f) : null
}

/** 由 matrix 取「按 raw / 显示文本」的二维输出 */
export function matrixRows(m: CellMatrix, raw = false): Row[] {
  return raw ? m.raw : m.text
}

// ==================== 表格输出 ====================

function cellText(v: any): string {
  if (v === null || v === undefined) return ''
  return String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
}

/** 二维数据 → Markdown 表格；header=false 时用列字母作表头（首行视为数据） */
export function rowsToMarkdown(rows: Row[], opts: { header?: boolean; startCol?: number } = {}): string {
  if (!rows.length) return '（空表）'
  const width = Math.max(1, ...rows.map(r => (Array.isArray(r) ? r.length : 0)))
  const startCol = Math.max(1, opts.startCol || 1)
  const header = opts.header === false
    ? Array.from({ length: width }, (_, i) => colLetter(startCol + i))
    : (rows[0] || []).map(cellText)
  const pad = (r: Row) => Array.from({ length: width }, (_, i) => cellText(Array.isArray(r) ? r[i] : ''))
  const out: string[] = []
  out.push('| ' + header.join(' | ') + ' |')
  out.push('| ' + header.map(() => '---').join(' | ') + ' |')
  const bodyStart = opts.header === false ? 0 : 1
  for (let i = bodyStart; i < rows.length; i++) out.push('| ' + pad(rows[i]).join(' | ') + ' |')
  return out.join('\n')
}

/** 二维数据 → CSV（RFC4180 风格引号转义） */
export function rowsToCsv(rows: Row[]): string {
  const esc = (v: any) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  return rows.map(r => (Array.isArray(r) ? r.map(esc).join(',') : '')).join('\n')
}

// ==================== 工作表元信息 ====================

export interface SheetMeta {
  name: string
  index: number
  hidden?: boolean
  range: string
  rowCount: number
  colCount: number
  /** 首行（默认表头行）内容 */
  header?: string[]
  /** 前几行预览（显示文本） */
  preview?: string[][]
}

export interface WorkbookMeta {
  path?: string
  name: string
  sheetCount: number
  sheets: SheetMeta[]
}

export function sheetMeta(wb: xlsx.WorkBook, name: string, opts: { previewRows?: number } = {}): SheetMeta | null {
  const ws = wb.Sheets[name]
  if (!ws) return null
  const range = rangeOf(ws)
  const meta: SheetMeta = {
    name,
    index: wb.SheetNames.indexOf(name),
    range: (ws as any)['!ref'] || '',
    rowCount: range ? range.e.r + 1 : 0,
    colCount: range ? range.e.c + 1 : 0,
  }
  const previewRows = Math.max(0, Math.min(10, Number(opts.previewRows ?? 3)))
  if (previewRows > 0 && meta.rowCount > 0) {
    const m = cellMatrix(ws, { startRow: 1, endRow: previewRows, maxCells: 400 })
    meta.preview = m.text.filter(r => r.some(c => c !== ''))
    meta.header = m.text[0] || []
  }
  return meta
}

export function workbookMeta(wb: xlsx.WorkBook, filePath?: string): WorkbookMeta {
  return {
    path: filePath,
    name: filePath ? filePath.replace(/^.*[\\/]/, '') : '(内存工作簿)',
    sheetCount: wb.SheetNames.length,
    sheets: wb.SheetNames.map(n => sheetMeta(wb, n, { previewRows: 2 })).filter(Boolean) as SheetMeta[],
  }
}

// ==================== 列解析 ====================

export interface ColumnRef {
  /** 1-based 列号 */
  index: number
  letter: string
  title: string
}

function headerNames(ws: xlsx.WorkSheet, headerRow: number): string[] {
  const m = cellMatrix(ws, { startRow: headerRow, endRow: headerRow, maxCells: 2000 })
  return (m.text[0] || []).map(s => String(s || '').trim())
}

/**
 * 把用户给的列标识解析为列号：支持表头名（默认按第 1 行）、列字母（A/AB）、1-based 列号。
 * 解析顺序：数字 → 表头名精确匹配（忽略大小写）→ 列字母。
 */
export function resolveColumn(ws: xlsx.WorkSheet, col: string | number, headerRow = 1): ColumnRef | null {
  const range = rangeOf(ws)
  const maxCol = range ? range.e.c + 1 : 0
  const mk = (i: number): ColumnRef => ({ index: i, letter: colLetter(i), title: '' })
  if (typeof col === 'number' && Number.isFinite(col)) {
    const i = Math.floor(col)
    return i >= 1 && (!maxCol || i <= maxCol) ? mk(i) : null
  }
  const raw = String(col ?? '').trim()
  if (!raw) return null
  if (/^\d+$/.test(raw)) {
    const i = Number(raw)
    return i >= 1 && (!maxCol || i <= maxCol) ? mk(i) : null
  }
  const letters = /^[A-Za-z]{1,3}$/.test(raw)
  if (letters) {
    const headers = headerNames(ws, headerRow)
    const hit = headers.findIndex(h => h.toLowerCase() === raw.toLowerCase())
    if (hit >= 0) return { index: hit + 1, letter: colLetter(hit + 1), title: headers[hit] }
    const i = colIndex(raw)
    if (!maxCol || i <= maxCol) return mk(i)
    return null
  }
  const headers = headerNames(ws, headerRow)
  const hit = headers.findIndex(h => h.toLowerCase() === raw.toLowerCase())
  if (hit >= 0) return { index: hit + 1, letter: colLetter(hit + 1), title: headers[hit] }
  return null
}

// ==================== 检索 / 筛选 / 聚合 ====================

export interface CellHit {
  sheet: string
  cell: string
  row: number
  col: number
  colLetter: string
  value: string
  /** 所在行的显示文本（截断） */
  rowText: string
}

export interface SearchOptions {
  /** 目标工作表（省略 = 全部） */
  sheet?: string
  regex?: boolean
  ignoreCase?: boolean
  /** 只看显示文本（默认）或也匹配原始值 */
  max?: number
  /** 扫描单元格上限（默认 200000） */
  maxCells?: number
}

/** 在工作簿中查找文本：返回命中单元格 + 所在行上下文 */
export function searchCells(wb: xlsx.WorkBook, query: string, opts: SearchOptions = {}): { total: number; hits: CellHit[]; truncated: boolean; scanned: number } {
  const out: CellHit[] = []
  const max = Math.max(1, Math.min(200, Number(opts.max) || 50))
  const maxCells = Math.max(1, Math.floor(Number(opts.maxCells) || 200000))
  let total = 0
  let scanned = 0
  let truncated = false
  const names = opts.sheet ? (wb.Sheets[opts.sheet] ? [opts.sheet] : []) : wb.SheetNames
  let re: RegExp | null = null
  if (opts.regex) {
    try { re = new RegExp(query, opts.ignoreCase === false ? 'g' : 'gi') } catch { return { total: 0, hits: [], truncated: false, scanned: 0 } }
  }
  for (const name of names) {
    const ws = wb.Sheets[name]
    const range = ws ? rangeOf(ws) : null
    if (!ws || !range) continue
    for (let r = range.s.r + 1; r <= range.e.r + 1; r++) {
      if (scanned >= maxCells) { truncated = true; break }
      const rowTextCells: string[] = []
      for (let c = range.s.c + 1; c <= range.e.c + 1; c++) {
        scanned++
        const cell = ws[xlsx.utils.encode_cell({ r: r - 1, c: c - 1 })] as xlsx.CellObject | undefined
        if (!cell) { rowTextCells.push(''); continue }
        const text = displayText(cell)
        rowTextCells.push(text)
        let hit = false
        if (re) { re.lastIndex = 0; hit = re.test(text) }
        else if (opts.ignoreCase === false) hit = text.includes(query)
        else hit = text.toLowerCase().includes(query.toLowerCase())
        if (hit) {
          total++
          if (out.length < max) {
            out.push({
              sheet: name,
              cell: `${colLetter(c)}${r}`,
              row: r,
              col: c,
              colLetter: colLetter(c),
              value: text.length > 200 ? text.slice(0, 200) + '…' : text,
              rowText: rowTextCells.join(' | ').slice(0, 300),
            })
          } else {
            truncated = true
          }
        }
      }
      if (truncated && out.length >= max) break
    }
    if (truncated && out.length >= max) break
  }
  return { total, hits: out, truncated, scanned }
}

export type WhereOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'notcontains' | 'startswith' | 'endswith' | 'empty' | 'notempty' | 'regex'

export interface WhereCond {
  column: string | number
  op?: WhereOp
  value?: any
}

/** 文本/数值混合比较：两边都能转成数字时按数字比，否则按字符串比 */
function toNumber(v: any): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v === null || v === undefined) return null
  const s = String(v).replace(/[,\s￥¥$%]/g, '').trim()
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function testCond(rawVal: any, textVal: string, cond: WhereCond): boolean {
  const op = (cond.op || 'eq') as WhereOp
  const want = cond.value
  const rv = rawVal === undefined ? null : rawVal
  const tv = textVal ?? ''
  const isEmpty = rv === null || rv === undefined || String(tv).trim() === ''
  switch (op) {
    case 'empty': return isEmpty
    case 'notempty': return !isEmpty
    case 'contains': return tv.toLowerCase().includes(String(want ?? '').toLowerCase())
    case 'notcontains': return !tv.toLowerCase().includes(String(want ?? '').toLowerCase())
    case 'startswith': return tv.toLowerCase().startsWith(String(want ?? '').toLowerCase())
    case 'endswith': return tv.toLowerCase().endsWith(String(want ?? '').toLowerCase())
    case 'regex': {
      try { return new RegExp(String(want ?? ''), 'i').test(tv) } catch { return false }
    }
    case 'eq': case 'ne': case 'gt': case 'gte': case 'lt': case 'lte': {
      const a = toNumber(rv), b = toNumber(want)
      let cmp: number
      if (a !== null && b !== null) cmp = a === b ? 0 : (a < b ? -1 : 1)
      else {
        const sa = String(tv).toLowerCase(), sb = String(want ?? '').toLowerCase()
        cmp = sa === sb ? 0 : (sa < sb ? -1 : 1)
      }
      if (op === 'eq') return cmp === 0
      if (op === 'ne') return cmp !== 0
      if (op === 'gt') return cmp > 0
      if (op === 'gte') return cmp >= 0
      if (op === 'lt') return cmp < 0
      return cmp <= 0
    }
    default: return false
  }
}

export interface QueryOptions {
  where?: WhereCond[]
  /** 'all'（默认）全部条件满足；'any' 任一满足 */
  match?: 'all' | 'any'
  /** 输出列（列名/字母/序号）；省略 = 全部列 */
  columns?: (string | number)[]
  sortBy?: string | number
  sortDir?: 'asc' | 'desc'
  offset?: number
  limit?: number
  /** 表头所在行（默认 1） */
  headerRow?: number
  /** 是否输出原始值（默认 false = 显示文本） */
  raw?: boolean
  maxScanRows?: number
}

export interface QueryResult {
  sheet: string
  header: string[]
  rows: Record<string, any>[]
  /** 过滤后命中的总行数（未分页） */
  matched: number
  returned: number
  offset: number
  truncated: boolean
  note?: string
}

/** 按条件筛选行：支持多条件（all/any）、列投影、排序、分页；输出为「表头名 → 值」对象 */
export function queryRows(wb: xlsx.WorkBook, sheetName: string, opts: QueryOptions = {}): QueryResult {
  const empty: QueryResult = { sheet: sheetName, header: [], rows: [], matched: 0, returned: 0, offset: 0, truncated: false }
  const ws = wb.Sheets[sheetName]
  if (!ws) return { ...empty, note: `工作表「${sheetName}」不存在` }
  const headerRow = Math.max(1, Math.floor(Number(opts.headerRow) || 1))
  const range = rangeOf(ws)
  const lastRow = range ? range.e.r + 1 : 0
  if (lastRow <= headerRow) return { ...empty, note: '工作表没有数据行（除表头外为空）' }

  const headerM = cellMatrix(ws, { startRow: headerRow, endRow: headerRow, maxCells: 2000 })
  const headers = (headerM.text[0] || []).map((h, i) => String(h || '').trim() || colLetter(headerM.startCol + i))

  const m = cellMatrix(ws, { startRow: headerRow + 1, maxScanRows: opts.maxScanRows ?? 20000 })
  const startCol = m.startCol
  const colOf = (c: string | number): number => {
    const ref = resolveColumn(ws, c, headerRow)
    return ref ? ref.index : -1
  }
  const conds = (opts.where || []).map(w => ({ ...w, idx: colOf(w.column) })).filter(c => c.idx > 0)
  const invalid = (opts.where || []).filter(w => colOf(w.column) <= 0).map(w => String(w.column))
  const wantAll = (opts.match || 'all') !== 'any'

  const sortIdx = opts.sortBy !== undefined ? colOf(opts.sortBy) : -1
  const projIdx = opts.columns && opts.columns.length ? opts.columns.map(colOf).filter(i => i > 0) : null
  const projNames = projIdx ? projIdx.map(i => headers[i - startCol] || colLetter(i)) : headers

  const picked: { row: number; raw: any[]; text: string[] }[] = []
  for (let i = 0; i < m.raw.length; i++) {
    const rawRow = m.raw[i]
    const textRow = m.text[i]
    let ok = true
    if (conds.length) {
      const results = conds.map(c => testCond(rawRow[c.idx - startCol], textRow[c.idx - startCol], c))
      ok = wantAll ? results.every(Boolean) : results.some(Boolean)
    }
    if (ok) picked.push({ row: m.rowNumbers[i], raw: rawRow, text: textRow })
  }

  if (sortIdx > 0) {
    const dir = (opts.sortDir || 'asc') === 'desc' ? -1 : 1
    picked.sort((a, b) => {
      const ra = a.raw[sortIdx - startCol], rb = b.raw[sortIdx - startCol]
      const na = toNumber(ra), nb = toNumber(rb)
      let cmp: number
      if (na !== null && nb !== null) cmp = na === nb ? 0 : (na < nb ? -1 : 1)
      else {
        const sa = String(a.text[sortIdx - startCol] ?? ''), sb = String(b.text[sortIdx - startCol] ?? '')
        cmp = sa === sb ? 0 : (sa < sb ? -1 : 1)
      }
      return cmp * dir
    })
  }

  const offset = Math.max(0, Math.floor(Number(opts.offset) || 0))
  const limit = Math.max(1, Math.min(1000, Math.floor(Number(opts.limit) || 200)))
  const page = picked.slice(offset, offset + limit)
  const data = page.map(p => {
    const o: Record<string, any> = { __row: p.row }
    if (projIdx) projIdx.forEach(i => { o[headers[i - startCol] || colLetter(i)] = opts.raw ? p.raw[i - startCol] : p.text[i - startCol] })
    else headers.forEach((h, i) => { o[h] = opts.raw ? p.raw[i] : p.text[i] })
    return o
  })

  const notes: string[] = []
  if (invalid.length) notes.push(`以下列未找到，已忽略：${invalid.join('、')}`)
  if (m.truncated && m.note) notes.push(m.note)
  return {
    sheet: sheetName,
    header: projNames,
    rows: data,
    matched: picked.length,
    returned: data.length,
    offset,
    truncated: m.truncated || picked.length > offset + data.length,
    note: notes.length ? notes.join('；') : undefined,
  }
}

export type AggFn = 'sum' | 'avg' | 'count' | 'distinct' | 'min' | 'max' | 'countblank'

export interface MetricSpec {
  column: string | number
  fn: AggFn
  /** 输出字段名（默认 `${fn}_${列名}`） */
  as?: string
}

export interface AggregateOptions {
  where?: WhereCond[]
  match?: 'all' | 'any'
  groupBy?: string | number
  metrics: MetricSpec[]
  headerRow?: number
  sortBy?: string
  sortDir?: 'asc' | 'desc'
  limit?: number
  maxScanRows?: number
}

/** 分组聚合：按列分组（省略则整体一行），逐指标计算 sum/avg/count/distinct/min/max/countblank */
export function aggregateRows(wb: xlsx.WorkBook, sheetName: string, opts: AggregateOptions): { sheet: string; groups: Record<string, any>[]; scanned: number; note?: string } {
  const ws = wb.Sheets[sheetName]
  const metrics = (opts.metrics || []).filter(m => m && m.fn)
  if (!ws) return { sheet: sheetName, groups: [], scanned: 0, note: `工作表「${sheetName}」不存在` }
  if (!metrics.length) return { sheet: sheetName, groups: [], scanned: 0, note: 'metrics 不能为空（如 [{column:"金额",fn:"sum"}]）' }
  const headerRow = Math.max(1, Math.floor(Number(opts.headerRow) || 1))
  const headerM = cellMatrix(ws, { startRow: headerRow, endRow: headerRow, maxCells: 2000 })
  const headers = (headerM.text[0] || []).map((h, i) => String(h || '').trim() || colLetter(headerM.startCol + i))
  const colOf = (c: string | number): number => {
    const ref = resolveColumn(ws, c, headerRow)
    return ref ? ref.index : -1
  }
  const groupIdx = opts.groupBy !== undefined ? colOf(opts.groupBy) : -1
  if (opts.groupBy !== undefined && groupIdx <= 0) {
    return { sheet: sheetName, groups: [], scanned: 0, note: `分组列「${opts.groupBy}」未找到` }
  }
  const prepared = metrics.map(m => ({ spec: m, idx: colOf(m.column), name: m.as || `${m.fn}_${typeof m.column === 'number' ? colLetter(m.column) : m.column}` }))
  const badCols = prepared.filter(p => p.idx <= 0).map(p => String(p.spec.column))
  if (badCols.length) return { sheet: sheetName, groups: [], scanned: 0, note: `指标列未找到：${badCols.join('、')}` }

  const m = cellMatrix(ws, { startRow: headerRow + 1, maxScanRows: opts.maxScanRows ?? 20000 })
  const startCol = m.startCol
  const conds = (opts.where || []).map(w => ({ ...w, idx: colOf(w.column) })).filter(c => c.idx > 0)
  const wantAll = (opts.match || 'all') !== 'any'

  interface Acc { key: string; count: number; nums: Map<number, number>; distinct: Map<number, Set<string>>; blanks: Map<number, number>; sum: Map<number, number>; min: Map<number, number>; max: Map<number, number> }
  const groups = new Map<string, Acc>()
  const ensure = (key: string): Acc => {
    let g = groups.get(key)
    if (!g) {
      g = { key, count: 0, nums: new Map(), distinct: new Map(), blanks: new Map(), sum: new Map(), min: new Map(), max: new Map() }
      prepared.forEach((_, i) => g!.distinct.set(i, new Set()))
      groups.set(key, g)
    }
    return g
  }

  let scanned = 0
  for (let i = 0; i < m.raw.length; i++) {
    const rawRow = m.raw[i]
    const textRow = m.text[i]
    if (conds.length) {
      const ok = wantAll
        ? conds.every(c => testCond(rawRow[c.idx - startCol], textRow[c.idx - startCol], c))
        : conds.some(c => testCond(rawRow[c.idx - startCol], textRow[c.idx - startCol], c))
      if (!ok) continue
    }
    // 全空行不计入统计
    if (rawRow.every(v => v === null || v === undefined || String(v).trim() === '')) continue
    scanned++
    const key = groupIdx > 0 ? (textRow[groupIdx - startCol] || '(空)') : '(全部)'
    const g = ensure(key)
    g.count++
    prepared.forEach((p, pi) => {
      const rv = rawRow[p.idx - startCol]
      const tv = textRow[p.idx - startCol]
      if (rv === null || rv === undefined || String(tv).trim() === '') g.blanks.set(pi, (g.blanks.get(pi) || 0) + 1)
      g.distinct.get(pi)!.add(String(tv))
      const n = toNumber(rv)
      if (n !== null) {
        g.sum.set(pi, (g.sum.get(pi) || 0) + n)
        g.nums.set(pi, (g.nums.get(pi) || 0) + 1)
        const cur = g.min.get(pi)
        g.min.set(pi, cur === undefined ? n : Math.min(cur, n))
        const curMax = g.max.get(pi)
        g.max.set(pi, curMax === undefined ? n : Math.max(curMax, n))
      }
    })
  }

  const round = (n: number) => Math.round(n * 1e6) / 1e6
  const out = Array.from(groups.values()).map(g => {
    const o: Record<string, any> = {}
    if (groupIdx > 0) o[`分组_${headers[groupIdx - startCol] || colLetter(groupIdx)}`] = g.key
    o['行数'] = g.count
    prepared.forEach((p, pi) => {
      const nums = g.nums.get(pi) || 0
      switch (p.spec.fn) {
        case 'sum': o[p.name] = round(g.sum.get(pi) || 0); break
        case 'avg': o[p.name] = nums ? round((g.sum.get(pi) || 0) / nums) : null; break
        case 'count': o[p.name] = nums; break
        case 'distinct': o[p.name] = g.distinct.get(pi)!.size; break
        case 'min': o[p.name] = g.min.get(pi) ?? null; break
        case 'max': o[p.name] = g.max.get(pi) ?? null; break
        case 'countblank': o[p.name] = g.blanks.get(pi) || 0; break
      }
    })
    return o
  })

  if (opts.sortBy) {
    const dir = (opts.sortDir || 'desc') === 'asc' ? 1 : -1
    const key = opts.sortBy
    out.sort((a, b) => {
      const na = toNumber(a[key]), nb = toNumber(b[key])
      if (na !== null && nb !== null) return (na - nb) * dir
      const sa = String(a[key] ?? ''), sb = String(b[key] ?? '')
      return (sa === sb ? 0 : sa < sb ? -1 : 1) * dir
    })
  } else if (groupIdx > 0) {
    out.sort((a, b) => String(Object.values(a)[0]).localeCompare(String(Object.values(b)[0])))
  }
  const limit = Math.max(1, Math.min(500, Math.floor(Number(opts.limit) || 200)))
  const trimmed = out.slice(0, limit)
  const notes: string[] = []
  if (opts.groupBy === undefined) notes.push('未指定 groupBy，为整表汇总')
  if (m.truncated && m.note) notes.push(m.note)
  if (out.length > trimmed.length) notes.push(`分组数 ${out.length} 超过上限 ${limit}，仅返回前 ${limit} 组`)
  return { sheet: sheetName, groups: trimmed, scanned, note: notes.length ? notes.join('；') : undefined }
}
