// excel.ts - Excel 导入工具（供数据表节点使用）
import * as XLSX from 'xlsx'

export interface ParsedTable {
  columns: string[]
  rows: Record<string, any>[]
}

/** 解析 Excel 文件为表格（取第一个工作表，首行为列名） */
export async function parseExcelFile(file: File): Promise<ParsedTable> {
  const sheets = await parseExcelSheets(file)
  return sheets[0] ? { columns: sheets[0].columns, rows: sheets[0].rows } : { columns: [], rows: [] }
}

export interface ParsedSheet {
  name: string
  columns: string[]
  rows: Record<string, any>[]
}

/** 解析 Excel 文件的所有工作表（每个 sheet 首行为列名） */
export async function parseExcelSheets(file: File): Promise<ParsedSheet[]> {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf)
  const out: ParsedSheet[] = []
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name]
    if (!ws) continue
    const json = XLSX.utils.sheet_to_json<Record<string, any>>(ws, { defval: '' })
    if (!json.length) continue
    out.push({ name, columns: Object.keys(json[0]), rows: json })
  }
  return out
}
