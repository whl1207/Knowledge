/**
 * blockeditor/table.ts — Markdown 表格数据模型
 *
 * 表格块在编辑器里是「单元格网格」而不是整段源码，所以需要把 `| a | b |` 这类
 * 行数组解析成结构化数据，编辑后再规范化写回。
 *
 * 列数以表头为准：所有行都会被补齐/截断到同一列数，序列化时再补齐分隔行。
 */

/** 一行单元格 */
export type TableRow = string[]

export interface TableData {
  /** 表头（第一行） */
  header: TableRow
  /** 数据行 */
  rows: TableRow[]
  /** 分隔行原文（保留 `:---:` 等对齐标记），长度与列数一致 */
  aligns: TableRow
}

const DEFAULT_ALIGN = '---'

/** 是否是分隔行（`| --- | :--: |`） */
export function isDelimiterRow(line: string): boolean {
  const t = line.trim()
  if (!t.includes('-')) return false
  return /^[|\s:-]+$/.test(t)
}

/** 拆一行单元格（支持 `\|` 转义） */
export function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)

  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|'
      i += 1
      continue
    }
    if (ch === '|') {
      cells.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  cells.push(cur.trim())
  return cells
}

/** 单元格内容 → 安全的 Markdown 单元格文本 */
function cellOut(v: string): string {
  return (v ?? '').replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|')
}

/** 拼一行 */
export function joinRow(cells: TableRow): string {
  return '| ' + cells.map(cellOut).join(' | ') + ' |'
}

/** 把各行补齐/截断到 colCount 列 */
function normalizeRow(row: TableRow, colCount: number): TableRow {
  const out = row.slice(0, colCount)
  while (out.length < colCount) out.push('')
  return out
}

/** 解析表格块的行数组 */
export function parseTable(lines: string[]): TableData {
  const header = splitRow(lines[0] ?? '')
  const colCount = Math.max(1, header.length)
  // 第 2 行是分隔行才跳过；没有分隔行时第 2 行本身就是数据行
  const hasDelimiter = isDelimiterRow(lines[1] ?? '')
  const aligns = hasDelimiter ? splitRow(lines[1]) : []
  const rows: TableRow[] = []

  for (let i = hasDelimiter ? 2 : 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue
    rows.push(splitRow(lines[i]))
  }

  const data: TableData = {
    header: normalizeRow(header, colCount),
    rows: rows.map((r) => normalizeRow(r, colCount)),
    aligns: normalizeRow(aligns, colCount).map((a) => (a.includes('-') ? a : DEFAULT_ALIGN)),
  }
  if (!data.rows.length) data.rows = [normalizeRow([], colCount)]
  return data
}

/** 序列化为表格块的行数组（首行表头 + 分隔行 + 数据行） */
export function serializeTable(data: TableData): string[] {
  const colCount = Math.max(1, data.header.length)
  const out = [
    joinRow(normalizeRow(data.header, colCount)),
    joinRow(normalizeRow(data.aligns, colCount).map((a) => (a.includes('-') ? a : DEFAULT_ALIGN))),
  ]
  for (const r of data.rows) out.push(joinRow(normalizeRow(r, colCount)))
  return out
}

/** 写入单元格。row < 0 表示表头行 */
export function setCell(data: TableData, row: number, col: number, value: string): void {
  const target = row < 0 ? data.header : data.rows[row]
  if (!target || col < 0 || col >= target.length) return
  target[col] = value
}

/** 在 col 位置插入一列（表头/对齐/所有数据行同步插入） */
export function insertCol(data: TableData, col: number): void {
  const at = Math.max(0, Math.min(col, data.header.length))
  data.header.splice(at, 0, '')
  data.aligns.splice(at, 0, DEFAULT_ALIGN)
  for (const r of data.rows) r.splice(at, 0, '')
}

/** 删除一列（至少保留 1 列） */
export function deleteCol(data: TableData, col: number): void {
  if (data.header.length <= 1) return
  data.header.splice(col, 1)
  data.aligns.splice(col, 1)
  for (const r of data.rows) r.splice(col, 1)
}

/** 移动列 */
export function moveCol(data: TableData, from: number, to: number): void {
  const n = data.header.length
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return
  const pick = (arr: TableRow) => {
    const [v] = arr.splice(from, 1)
    arr.splice(to, 0, v)
  }
  pick(data.header)
  pick(data.aligns)
  for (const r of data.rows) pick(r)
}

/** 在 at 位置插入数据行（row < 0 表示插到最前） */
export function insertRow(data: TableData, at: number): void {
  const idx = Math.max(0, Math.min(at, data.rows.length))
  data.rows.splice(idx, 0, new Array(data.header.length).fill(''))
}

/** 删除数据行 */
export function deleteRow(data: TableData, at: number): void {
  if (data.rows.length <= 1) {
    data.rows[0] = new Array(data.header.length).fill('')
    return
  }
  data.rows.splice(at, 1)
}

/** 移动数据行 */
export function moveRow(data: TableData, from: number, to: number): void {
  const n = data.rows.length
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return
  const [row] = data.rows.splice(from, 1)
  data.rows.splice(to, 0, row)
}

// ---------------------------------------------------------------------------
// 自测
// ---------------------------------------------------------------------------

/** 表格往返 + 行列操作自测 */
export function runTableSelfTest(): Array<{ name: string; ok: boolean; expected: string; actual: string }> {
  const cases: Array<{ name: string; src: string[]; run?: (d: TableData) => void; expect: string[] }> = [
    {
      name: '解析并原样序列化',
      src: ['| a | b |', '| --- | --- |', '| 1 | 2 |'],
      expect: ['| a | b |', '| --- | --- |', '| 1 | 2 |'],
    },
    {
      name: '保留对齐标记',
      src: ['| a | b |', '| :-- | --: |', '| 1 | 2 |'],
      expect: ['| a | b |', '| :-- | --: |', '| 1 | 2 |'],
    },
    {
      name: '无首尾竖线也能解析',
      src: ['a | b', '--- | ---', '1 | 2'],
      expect: ['| a | b |', '| --- | --- |', '| 1 | 2 |'],
    },
    {
      name: '单元格里的竖线转义',
      src: ['| a | b |', '| --- | --- |', '| x \\| y | z |'],
      expect: ['| a | b |', '| --- | --- |', '| x \\| y | z |'],
    },
    {
      name: '列数不齐会被补齐',
      src: ['| a | b |', '| --- | --- |', '| 1 |'],
      expect: ['| a | b |', '| --- | --- |', '| 1 |  |'],
    },
    {
      name: '缺少分隔行时补一列分隔',
      src: ['| a | b |', '| 1 | 2 |'],
      expect: ['| a | b |', '| --- | --- |', '| 1 | 2 |'],
    },
    {
      name: '插入列',
      src: ['| a | b |', '| --- | --- |', '| 1 | 2 |'],
      run: (d) => insertCol(d, 1),
      expect: ['| a |  | b |', '| --- | --- | --- |', '| 1 |  | 2 |'],
    },
    {
      name: '删除列',
      src: ['| a | b |', '| --- | --- |', '| 1 | 2 |'],
      run: (d) => deleteCol(d, 0),
      expect: ['| b |', '| --- |', '| 2 |'],
    },
    {
      name: '最后一列不可删',
      src: ['| a |', '| --- |', '| 1 |'],
      run: (d) => deleteCol(d, 0),
      expect: ['| a |', '| --- |', '| 1 |'],
    },
    {
      name: '移动列',
      src: ['| a | b | c |', '| --- | --- | --- |', '| 1 | 2 | 3 |'],
      run: (d) => moveCol(d, 0, 2),
      expect: ['| b | c | a |', '| --- | --- | --- |', '| 2 | 3 | 1 |'],
    },
    {
      name: '插入行',
      src: ['| a | b |', '| --- | --- |', '| 1 | 2 |'],
      run: (d) => insertRow(d, 0),
      expect: ['| a | b |', '| --- | --- |', '|  |  |', '| 1 | 2 |'],
    },
    {
      name: '删除行',
      src: ['| a | b |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |'],
      run: (d) => deleteRow(d, 0),
      expect: ['| a | b |', '| --- | --- |', '| 3 | 4 |'],
    },
    {
      name: '最后一行不可删空（清空保留结构）',
      src: ['| a | b |', '| --- | --- |', '| 1 | 2 |'],
      run: (d) => deleteRow(d, 0),
      expect: ['| a | b |', '| --- | --- |', '|  |  |'],
    },
    {
      name: '移动行',
      src: ['| a | b |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |'],
      run: (d) => moveRow(d, 1, 0),
      expect: ['| a | b |', '| --- | --- |', '| 3 | 4 |', '| 1 | 2 |'],
    },
    {
      name: '写单元格（含表头）',
      src: ['| a | b |', '| --- | --- |', '| 1 | 2 |'],
      run: (d) => {
        setCell(d, -1, 0, 'X')
        setCell(d, 0, 1, 'Y')
      },
      expect: ['| X | b |', '| --- | --- |', '| 1 | Y |'],
    },
  ]

  return cases.map((c) => {
    const data = parseTable(c.src)
    if (c.run) c.run(data)
    const actual = serializeTable(data)
    return {
      name: c.name,
      ok: actual.join('\n') === c.expect.join('\n'),
      expected: c.expect.join('\n'),
      actual: actual.join('\n'),
    }
  })
}
