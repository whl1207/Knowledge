/**
 * Office MCP —— Excel 服务（会话式：open_workbook 返回 workbookId）
 *
 * 与 office-service（Word）同构：工具定义 + 执行内核，由 office-service 挂到同一个 MCP Server。
 *
 * 读：SheetJS 解析「当前内存包」的字节 → 未保存的修改也能读到（与 save 前的状态一致）。
 * 写：xlsx-editor 直接改 OOXML 部件（保留样式 / 公式 / 图表 / 图片），保存走 .bak + 原子替换。
 * 只读格式：.xls（BIFF）/ .csv 可读可查，但不支持写回（会提示先另存为 .xlsx）。
 */
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { WorkBook } from 'xlsx'
import * as XR from './xlsx-reader'
import * as XE from './xlsx-editor'

const MAX_SESSIONS = 12 // 内存会话上限，超出淘汰最旧
const MAX_OUT_CHARS = 30000 // 单次工具输出上限（硬顶，可由 maxChars 参数下调）
/**
 * 各工具的默认输出预算（字符）。
 * 数据类工具默认远低于硬顶：一次调用吃掉整个上下文会让小窗口模型（如 32k）在 2~3 次调用后丢上下文，
 * 因此默认只够「看清楚结果」，需要更多再显式加 limit / maxChars。
 */
const OUT_BUDGET: Record<string, number> = {
  read_sheet: 12000,
  query_rows: 6000,
  aggregate: 6000,
  search_cells: 5000,
  list_sheets: 12000,
  open_workbook: 12000,
}

// ---------------- 会话 ----------------

interface WorkbookSession {
  workbookId: string
  path: string
  /** 可增量改写的 OOXML 包（仅 .xlsx / .xlsm；其它格式为 null = 只读） */
  pkg: XE.XlsxPackage | null
  /** 读缓存（revision 变化即失效） */
  cache: { revision: number; wb: WorkBook } | null
  openedAt: number
  lastUseAt: number
}

const sessions = new Map<string, WorkbookSession>()

function capSessions(): void {
  if (sessions.size <= MAX_SESSIONS) return
  const sorted = Array.from(sessions.values()).sort((a, b) => a.lastUseAt - b.lastUseAt)
  while (sessions.size > MAX_SESSIONS && sorted.length) {
    const old = sorted.shift()
    if (old) sessions.delete(old.workbookId)
  }
}

/** workbookId 的可用别名（兼容 LLM 命名方差） */
const WB_ID_KEYS = ['workbookId', 'workbook_id', 'bookId', 'book_id', 'wbId', 'wb_id', 'workbookid', 'wkId', 'wk_id']
/** 文件路径的可用别名 */
const WB_PATH_KEYS = ['path', 'filePath', 'file_path', 'filepath', 'file']
/**
 * 工作表名的可用别名。read_sheet / query_rows / aggregate / search_cells 共用；
 * 模型常误写作 query_sheet / worksheet，统一在此归一，避免因命名差异静默读到第一张表或报错。
 */
const SHEET_KEYS = ['sheet', 'sheetName', 'sheet_name', 'query_sheet', 'querySheet', 'worksheet', 'worksheetName', 'worksheet_name', 'tab', 'table']

/**
 * 参数别名归一：把别名键（query_sheet / workbook_id / file_path …）补成规范名，
 * 使下游 `arg(args, ['sheet', …])` 一律命中。
 * add_sheet 例外——它的 sheetName 指「新表名」，不是被选中的工作表。
 */
function normalizeArgs(name: string, raw: Record<string, any>): Record<string, any> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = { ...raw }
  const setIf = (target: string, keys: string[]): void => {
    const cur = out[target]
    if (cur !== undefined && cur !== null && cur !== '') return
    const v = arg(raw, keys)
    if (v !== undefined && v !== null && v !== '') out[target] = v
  }
  setIf('workbookId', WB_ID_KEYS)
  setIf('path', WB_PATH_KEYS)
  if (name !== 'add_sheet') setIf('sheet', SHEET_KEYS)
  return out
}

/**
 * 打开文件并建立会话（open_workbook 与「直接用 path 读取」共用）。
 * 失败返回可直接回给模型的错误文本；成功返回会话。
 */
function openSession(rawPath: any): WorkbookSession | string {
  const raw = normPath(String(rawPath || ''))
  if (!raw) return '参数缺失：请提供 Excel 文件的 path 或先 open_workbook 拿到 workbookId'
  const abs = path.isAbsolute(raw) ? raw : path.resolve(raw)
  if (!fs.existsSync(abs)) return `文件不存在: ${abs}`
  const ext = path.extname(abs).toLowerCase()
  if (!['.xlsx', '.xlsm', '.xls', '.csv', '.tsv', '.txt'].includes(ext)) return `仅支持 .xlsx / .xlsm / .xls / .csv：${abs}`
  let wb: WorkBook
  try { wb = XR.readWorkbookFrom({ filePath: abs }) } catch (e: any) { return `打开失败: ${e?.message || String(e)}` }
  let pkg: XE.XlsxPackage | null = null
  if (ext === '.xlsx' || ext === '.xlsm') {
    try { pkg = XE.loadXlsxPackage(abs) } catch { pkg = null }
  }
  const workbookId = randomUUID()
  const session: WorkbookSession = { workbookId, path: abs, pkg, cache: { revision: 0, wb }, openedAt: Date.now(), lastUseAt: Date.now() }
  sessions.set(workbookId, session)
  capSessions()
  return session
}

/**
 * 解析会话（返回错误文本表示失败）：优先用传入的 workbookId；**未传时**回退到「按 path 命中的会话」、
 * 「用 path 直接打开」或「唯一已打开的工作簿」。LLM 忘带会话 ID / 想一步出结果是高频现象，
 * 回退可让「给路径 → 直接统计」在**一次调用**内完成（32k 这类小上下文窗口尤其重要）。
 */
function sessionOf(args: Record<string, any>): WorkbookSession | string {
  const id = String(arg(args, WB_ID_KEYS) || '')
  if (id) {
    const s = sessions.get(id)
    if (s) s.lastUseAt = Date.now()
    return s || sessionError(args)
  }
  const wantPath = normPath(String(arg(args, WB_PATH_KEYS) || ''))
  const all = Array.from(sessions.values())
  if (wantPath) {
    const hit = all.find(s => s.path === wantPath || path.resolve(s.path) === path.resolve(wantPath))
    if (hit) { hit.lastUseAt = Date.now(); return hit }
    return openSession(wantPath)
  }
  if (all.length === 1) { all[0].lastUseAt = Date.now(); return all[0] }
  return sessionError(args)
}

/**
 * 会话失败原因：区分「压根没传 workbookId」与「ID 已失效」，
 * 并列出当前可用会话（旧版把两种情况合并成一句「无效或已关闭」，属于误报）。
 */
function sessionError(args: Record<string, any>): string {
  const id = String(arg(args, WB_ID_KEYS) || '')
  const open = Array.from(sessions.values()).sort((a, b) => b.lastUseAt - a.lastUseAt)
  const list = open.length
    ? `\n当前已打开的工作簿会话：\n${open.map(s => `- workbookId: ${s.workbookId}　路径: ${s.path}`).join('\n')}`
    : '\n当前没有任何已打开的工作簿会话。'
  if (!id) {
    return `缺少 workbookId 参数：可在本工具参数里直接给 path（会自动打开该文件），或先调用 open_workbook 获取 workbookId。${list}`
  }
  return `workbookId「${id}」已失效（主进程重启、已被 close_workbook 关闭，或同时打开的工作簿超过 ${MAX_SESSIONS} 个被淘汰）。请重新 open_workbook（或直接传 path）后再试。${list}`
}

/** 从参数里按多别名取第一个非空值（兼容 LLM 命名方差） */
function arg(args: Record<string, any>, keys: string[]): any {
  for (const k of keys) {
    const v = args?.[k]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

function normPath(p: string): string {
  return String(p || '').trim().replace(/^file:\/\/\//, '')
}

function colNum(v: any): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v)
  const s = String(v).trim()
  if (/^\d+$/.test(s)) return Number(s)
  const n = XE.colToNum(s)
  return n > 0 ? n : undefined
}

function rowNum(v: any): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n >= 1 ? n : undefined
}

/** 当前工作簿（含未保存的内存修改） */
function currentWorkbook(s: WorkbookSession): WorkBook {
  if (s.pkg && s.pkg.revision > 0) {
    const rev = s.pkg.revision
    if (s.cache && s.cache.revision === rev) return s.cache.wb
    const wb = XR.readWorkbookFrom({ buffer: XE.buildXlsxBuffer(s.pkg) })
    s.cache = { revision: rev, wb }
    return wb
  }
  if (s.cache && s.cache.revision === 0) return s.cache.wb
  const wb = XR.readWorkbookFrom({ filePath: s.path })
  s.cache = { revision: 0, wb }
  return wb
}

/** 解析工作表名（省略 → 第一个表；支持大小写不敏感匹配） */
function resolveSheet(s: WorkbookSession, wb: WorkBook, want?: any): string | null {
  const all = wb.SheetNames
  const raw = String(want ?? '').trim()
  if (!raw) return all[0] || null
  const hit = all.find(n => n === raw) || all.find(n => n.toLowerCase() === raw.toLowerCase())
  return hit || null
}

function sheetListText(s: WorkbookSession, wb: WorkBook): string {
  const refs = s.pkg ? XE.listSheetRefs(s.pkg) : []
  const hidden = new Set(refs.filter(r => r.state === 'hidden' || r.state === 'veryHidden').map(r => r.name))
  return wb.SheetNames.map(n => `${n}${hidden.has(n) ? '（隐藏）' : ''}`).join('、')
}

function notFoundSheet(s: WorkbookSession, wb: WorkBook, want: any): string {
  return `工作表「${want}」不存在。当前可用工作表：${sheetListText(s, wb)}`
}

function needWritable(s: WorkbookSession): string | null {
  if (!s.pkg) {
    return `该文件格式（${path.extname(s.path) || '未知'}）不支持直接写回（仅 .xlsx / .xlsm 可改）。请先在 Excel 里另存为 .xlsx，再用 open_workbook 打开。`
  }
  return null
}

function clip(text: string, maxChars = MAX_OUT_CHARS): string {
  const cap = Math.max(500, Math.min(MAX_OUT_CHARS, Math.floor(maxChars) || MAX_OUT_CHARS))
  return text.length > cap
    ? text.slice(0, cap) + `\n\n…（输出超长已截断，共 ${text.length} 字符；请用 limit / maxChars 缩小范围，或改用 aggregate 直接统计，避免占用上下文）`
    : text
}

/** 输出预算：优先取调用方传的 maxChars，否则用该工具默认值 */
function outBudget(name: string, args: Record<string, any>): number {
  const want = Number(arg(args, ['maxChars', 'max_chars', 'maxchars']))
  if (Number.isFinite(want) && want > 0) return want
  return OUT_BUDGET[name] || MAX_OUT_CHARS
}

/** 记录数组 → 紧凑制表符表格（字段名只出现一次，比逐行重复 key 的 JSON 少一半以上字符） */
function compactTable(rows: Record<string, any>[]): string {
  if (!rows.length) return '（无数据）'
  const keys: string[] = []
  for (const r of rows) for (const k of Object.keys(r || {})) if (!keys.includes(k)) keys.push(k)
  const cell = (v: any) => (v === null || v === undefined ? '' : String(v).replace(/[\t\r\n]+/g, ' '))
  return [keys.join('\t'), ...rows.map(r => keys.map(k => cell(r?.[k])).join('\t'))].join('\n')
}

/** 表头预览：结果自带列名，上下文被压缩/截断后模型也能自纠，不必再查一次 */
function headerHint(header: string[]): string {
  if (!header.length) return ''
  const shown = header.slice(0, 40).join('、')
  return `表头：${shown}${header.length > 40 ? `…（共 ${header.length} 列）` : ''}\n`
}

// ---------------- 工具定义 ----------------

export function toolDefinitions(): any[] {
  const wbId = {
    workbookId: { type: 'string', description: 'open_workbook 返回的会话 ID（workbookId / workbook_id / bookId 等价，任选其一）' },
    workbook_id: { type: 'string', description: 'workbookId 的别名，任选其一' },
    path: { type: 'string', description: 'Excel 文件绝对路径：**可代替 workbookId**（同一路径已有会话就直接用，没有就自动打开）——小上下文窗口下可省掉一次 open_workbook 调用；path / filePath / file_path 等价' },
  }
  const sheet = { sheet: { type: 'string', description: '工作表名（省略 = 第一个工作表；大小写不敏感）' } }
  const sheetName = { name: { type: 'string', description: '工作表名' } }
  return [
    {
      name: 'open_workbook',
      description: '打开本地 Excel 文件（.xlsx / .xlsm / .xls / .csv），返回 workbookId 与各工作表的规模、范围、表头预览（**表头已含在此结果里，一般无需再调 list_sheets**）。后续用 read_sheet / query_rows 读明细，用 aggregate 一步做统计（计数 / 求和 / 去重 / 频率，**别用 read_sheet 拉全量行再自己数**），用 set_cells / append_rows / add_sheet 等修改，save_workbook 写回。写回只替换改动过的部件（单元格样式、公式、图表、图片全部保留），保存前自动备份为 .bak。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Excel 文件绝对路径（.xlsx/.xlsm 可写；.xls/.csv 只读）。path / filePath / file_path 等价，任选其一' },
          filePath: { type: 'string', description: 'path 的别名，任选其一' },
        },
        required: ['path'],
      },
    },
    {
      name: 'list_sheets',
      description: '列出已打开工作簿（或按 path 直接打开的文件）的全部工作表：名称、是否隐藏、行列数、数据范围、表头与前几行预览。通常可省略——open_workbook 的结果已含表头。',
      inputSchema: { type: 'object', properties: { ...wbId }, required: [] },
    },
    {
      name: 'read_sheet',
      description: '读取工作表指定区域（行列均为 1-based；列可用列字母 A/AB 或序号）。默认输出 Markdown 表格（首行为表头），也可输出 JSON / CSV；支持只看公式（includeFormulas）。**明细很多时别用它拉全量（会占满上下文）**，统计类需求用 aggregate。',
      inputSchema: {
        type: 'object',
        properties: {
          ...wbId,
          ...sheet,
          startRow: { type: 'number', description: '起始行（1-based，默认 1）' },
          endRow: { type: 'number', description: '结束行（含，默认自动/上限）' },
          startCol: { type: 'string', description: '起始列（列字母 A/AB 或 1-based 序号，默认 A）' },
          endCol: { type: 'string', description: '结束列（含，同上）' },
          format: { type: 'string', enum: ['markdown', 'json', 'csv'], description: '输出格式，默认 markdown' },
          raw: { type: 'boolean', description: 'true = 原始值（数字/日期对象），false = Excel 显示文本（默认）' },
          includeFormulas: { type: 'boolean', description: 'true = 公式单元格输出 =公式 文本' },
          maxRows: { type: 'number', description: '最多返回行数（默认 200，最大 2000）' },
          maxChars: { type: 'number', description: '本次输出字符预算（默认 12000，最大 30000）' },
          header: { type: 'boolean', description: 'markdown 格式下是否把首行当表头（默认 true）' },
        },
        required: [],
      },
    },
    {
      name: 'search_cells',
      description: '在工作簿里检索文本（可正则），返回命中单元格地址、值与所在行上下文，用于快速定位数据位置。',
      inputSchema: {
        type: 'object',
        properties: {
          ...wbId,
          query: { type: 'string', description: '要查找的文本（或正则）' },
          query_text: { type: 'string', description: 'query 的别名，任选其一' },
          ...sheet,
          regex: { type: 'boolean', description: '是否按正则匹配（默认 false）' },
          ignoreCase: { type: 'boolean', description: '忽略大小写（默认 true）' },
          max: { type: 'number', description: '最多返回命中数（默认 50，最大 200）' },
          maxChars: { type: 'number', description: '本次输出字符预算（默认 5000，最大 30000）' },
        },
        required: ['query'],
      },
    },
    {
      name: 'query_rows',
      description: '按条件查询行（Excel 版筛选/排序）：where 支持多条件（eq/ne/gt/gte/lt/lte/contains/notcontains/startswith/endswith/empty/notempty/regex），可指定输出列、排序列、分页。返回紧凑制表符表格（首行字段名 + 行号列 __row；format=json 可要 JSON）。**只用来取明细**；统计 / 计数 / 去重数 / 频率请在一步里改用 aggregate（不要拉全量行自己数，会占满上下文）。',
      inputSchema: {
        type: 'object',
        properties: {
          ...wbId,
          ...sheet,
          where: {
            type: 'array',
            description: '筛选条件数组，如 [{"column":"金额","op":"gt","value":1000}]；column 可用表头名 / 列字母 / 列序号',
            items: {
              type: 'object',
              properties: {
                column: { type: 'string', description: '列（表头名 / 列字母 / 1-based 序号）' },
                op: { type: 'string', description: '比较符，默认 eq' },
                value: { description: '比较值（数字/字符串/布尔）' },
              },
              required: ['column'],
            },
          },
          match: { type: 'string', enum: ['all', 'any'], description: '多条件关系，默认 all' },
          columns: { type: 'array', items: { type: 'string' }, description: '只看这些列（省略 = 全部列）；只取需要的列可大幅省上下文' },
          sortBy: { type: 'string', description: '排序列（表头名 / 列字母 / 序号）' },
          sortDir: { type: 'string', enum: ['asc', 'desc'], description: '排序方向，默认 asc' },
          offset: { type: 'number', description: '跳过前 N 行（默认 0）' },
          limit: { type: 'number', description: '最多返回行数（默认 100，最大 1000）' },
          format: { type: 'string', enum: ['table', 'json'], description: '输出格式：table（默认，紧凑制表符表格）/ json' },
          maxChars: { type: 'number', description: '本次输出字符预算（默认 6000，最大 30000）' },
          raw: { type: 'boolean', description: 'true = 原始值，false = 显示文本（默认）' },
          headerRow: { type: 'number', description: '表头所在行（默认 1）' },
        },
        required: [],
      },
    },
    {
      name: 'aggregate',
      description: '分组统计（一步出结果、省上下文的首选；**冷启动可只传 path，无需先 open_workbook**）：按一列或多列分组（groupBy 可传数组做「某几个字段条件下」的统计），逐指标算 sum/avg/count/distinct/min/max/countblank；metrics 可省略 = 只统计每组「行数 + 占比(%)」即频次。每组固定输出 分组_列名、行数、占比(%)。'
        + '用法示例——①某条件下频率最高的值（单次调用即可回答）：{path:"D:/a.xlsx", groupBy:"城市", where:[{"column":"年份","op":"eq","value":2024}], sortBy:"行数", sortDir:"desc", limit:1}；'
        + '②多字段条件的频率表：{groupBy:["城市","渠道"], sortBy:"行数", sortDir:"desc", limit:20}；'
        + '③分组求和：{groupBy:"城市", metrics:[{"column":"金额","fn":"sum"}]}。'
        + '列名写错会在结果里附上可用列，sortBy 可写 行数 / count / 占比 等别名。',
      inputSchema: {
        type: 'object',
        properties: {
          ...wbId,
          ...sheet,
          groupBy: {
            type: 'array',
            items: { type: 'string' },
            description: '分组字段（数组）：单个字段写 ["城市"]，多个字段写 ["城市","渠道"]（也接受直接写字符串 "城市"）；省略 = 整表汇总',
          },
          metrics: {
            type: 'array',
            description: '指标数组，如 [{"column":"金额","fn":"sum","as":"总金额"}]；**省略 = 只输出每组行数与占比**（频次统计）',
            items: {
              type: 'object',
              properties: {
                column: { type: 'string', description: '统计列' },
                fn: { type: 'string', description: 'sum | avg | count | distinct | min | max | countblank' },
                as: { type: 'string', description: '输出字段名（默认 函数_列名）' },
              },
              required: ['column', 'fn'],
            },
          },
          where: { type: 'array', description: '统计前的筛选条件（同 query_rows）', items: { type: 'object' } },
          match: { type: 'string', enum: ['all', 'any'], description: '多条件关系，默认 all' },
          sortBy: { type: 'string', description: '按输出字段排序，如 行数 / count（频次最高在前）、占比、总金额' },
          sortDir: { type: 'string', enum: ['asc', 'desc'], description: '排序方向，默认 desc' },
          limit: { type: 'number', description: '最多返回分组数（默认 200，最大 500；只看 Top N 就传 N）' },
          format: { type: 'string', enum: ['table', 'json'], description: '输出格式：table（默认，紧凑制表符表格）/ json' },
          maxChars: { type: 'number', description: '本次输出字符预算（默认 6000，最大 30000）' },
          headerRow: { type: 'number', description: '表头所在行（默认 1）' },
        },
        required: [],
      },
    },
    {
      name: 'set_cells',
      description: '批量写单元格（可跨工作表）：就地替换/新建单元格，保留该单元格原有样式；字符串用 inlineStr 写入（不影响共享字符串表）。值为以 = 开头的字符串时按公式写入。改完需 save_workbook 才落盘。',
      inputSchema: {
        type: 'object',
        properties: {
          ...wbId,
          sheet: { type: 'string', description: '默认工作表（update 未指定 sheet 时使用）' },
          updates: {
            type: 'array',
            description: '修改项数组，如 [{"ref":"B2","value":100},{"ref":"C2","formula":"B2*2"},{"row":3,"col":"D","value":"备注"}]',
            items: {
              type: 'object',
              properties: {
                sheet: { type: 'string', description: '该修改所在工作表（省略 = 用参数 sheet）' },
                ref: { type: 'string', description: '单元格地址，如 B2（ref / cell / a1 等价）' },
                cell: { type: 'string', description: 'ref 的别名' },
                a1: { type: 'string', description: 'ref 的别名' },
                row: { type: 'number', description: '行号（1-based，与 col 搭配）' },
                col: { type: 'string', description: '列（列字母 B 或 1-based 序号，与 row 搭配）' },
                value: { description: '写入值（字符串 / 数字 / 布尔；= 开头 = 公式）' },
                formula: { type: 'string', description: '公式（如 SUM(B2:B10)，无需带 =）' },
                type: { type: 'string', enum: ['auto', 'string', 'number', 'boolean'], description: '强制类型（默认 auto）' },
                clear: { type: 'boolean', description: 'true = 清空该单元格（保留样式）' },
              },
            },
          },
        },
        required: ['workbookId', 'updates'],
      },
    },
    {
      name: 'append_rows',
      description: '在工作表末尾追加若干行（二维数组；每行的元素可为值或以 {formula:"..."} 表示的公式）。返回新增行区间。改完需 save_workbook 才落盘。',
      inputSchema: {
        type: 'object',
        properties: {
          ...wbId,
          ...sheet,
          rows: { type: 'array', description: '二维数组，行内容；元素可为值，可为 {formula:"SUM(B2:B3)"}', items: { type: 'array', items: {} } },
          startCol: { type: 'string', description: '从哪一列开始写（列字母或序号，默认 A）' },
        },
        required: ['workbookId', 'rows'],
      },
    },
    {
      name: 'add_sheet',
      description: '新增工作表（可带初始数据；index 指定插入位置，默认追加到最后）。改完需 save_workbook 才落盘。',
      inputSchema: {
        type: 'object',
        properties: { ...wbId, ...sheetName, rows: { type: 'array', description: '初始数据二维数组（可选）', items: { type: 'array', items: {} } }, index: { type: 'number', description: '插入位置（0-based，默认最后）' } },
        required: ['workbookId', 'name'],
      },
    },
    {
      name: 'rename_sheet',
      description: '重命名工作表（同步更新 workbook.xml；工作表名限制 31 字符、不含 : \\ / ? * [ ]）。改完需 save_workbook 才落盘。',
      inputSchema: {
        type: 'object',
        properties: { ...wbId, sheet: { type: 'string', description: '原工作表名' }, newName: { type: 'string', description: '新工作表名（newName / to / name 等价）' }, to: { type: 'string', description: 'newName 的别名' }, name: { type: 'string', description: 'newName 的别名' } },
        required: ['workbookId', 'sheet'],
      },
    },
    {
      name: 'delete_sheet',
      description: '删除工作表（同步清理 workbook.xml / rels / Content_Types 与部件本体；至少要保留一个可见工作表）。删除在 save_workbook 后生效，保存前会自动生成 .bak，可据此恢复。',
      inputSchema: { type: 'object', properties: { ...wbId, ...sheet }, required: ['workbookId', 'sheet'] },
    },
    {
      name: 'create_workbook',
      description: '新建 .xlsx 文件（可一次建多个工作表 + 初始数据），并自动打开为可编辑会话（返回 workbookId）。文件已存在时需传 overwrite=true。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '新建文件绝对路径（.xlsx）' },
          filePath: { type: 'string', description: 'path 的别名' },
          sheets: { type: 'array', description: '工作表数组，如 [{"name":"汇总","rows":[["姓名","金额"],["张三",100]]}]', items: { type: 'object' } },
          overwrite: { type: 'boolean', description: '文件已存在时是否覆盖（默认 false）' },
        },
        required: ['path'],
      },
    },
    {
      name: 'save_workbook',
      description: '把当前会话写回磁盘：仅替换改动过的部件（样式/公式/图表/图片原样保留），写回前自动备份为 <文件>.bak，原子覆盖。',
      inputSchema: { type: 'object', properties: { ...wbId, backup: { type: 'boolean', description: '是否备份（默认 true）' } }, required: ['workbookId'] },
    },
    {
      name: 'close_workbook',
      description: '关闭并释放工作簿会话（释放内存）。若有未保存修改需传 discard=true 才会丢弃关闭。',
      inputSchema: { type: 'object', properties: { ...wbId, discard: { type: 'boolean', description: '有未保存修改时强制丢弃关闭（默认 false）' } }, required: ['workbookId'] },
    },
  ]
}

export const XLSX_TOOL_NAMES = toolDefinitions().map((t: any) => t.name as string)

export function isXlsxTool(name: string): boolean {
  return XLSX_TOOL_NAMES.includes(name)
}

// ---------------- 执行内核 ----------------

export async function executeXlsxTool(name: string, rawArgs: Record<string, any> = {}): Promise<string> {
  // 入口先做参数别名归一（query_sheet → sheet、workbook_id → workbookId、file_path → path …）
  const args = normalizeArgs(name, rawArgs)
  switch (name) {
    case 'open_workbook': {
      const s = openSession(arg(args, ['path', 'filePath', 'file_path']))
      if (typeof s === 'string') return s
      const wb = currentWorkbook(s)
      const meta = XR.workbookMeta(wb, s.path)
      return clip(JSON.stringify({
        workbookId: s.workbookId,
        name: meta.name,
        path: s.path,
        sheetCount: meta.sheetCount,
        sheets: meta.sheets,
        writable: !!s.pkg,
        note: s.pkg ? undefined : '该格式只读（未保存写回能力）：如需修改请另存为 .xlsx',
      }, null, 2), outBudget('open_workbook', args))
    }

    case 'list_sheets': {
      const s = sessionOf(args)
      if (typeof s === 'string') return s
      const wb = currentWorkbook(s)
      const refs = s.pkg ? XE.listSheetRefs(s.pkg) : []
      const hidden = new Set(refs.filter(r => r.state === 'hidden' || r.state === 'veryHidden').map(r => r.name))
      const sheets = wb.SheetNames.map((n, i) => {
        const meta = XR.sheetMeta(wb, n, { previewRows: 3 })
        return { index: i, name: n, hidden: hidden.has(n) || undefined, rows: meta?.rowCount ?? 0, cols: meta?.colCount ?? 0, range: meta?.range || '', header: meta?.header, preview: meta?.preview }
      })
      return clip(JSON.stringify({ path: s.path, sheetCount: sheets.length, sheets, dirty: s.pkg ? s.pkg.modified : false }, null, 2), outBudget('list_sheets', args))
    }

    case 'read_sheet': {
      const s = sessionOf(args)
      if (typeof s === 'string') return s
      const wb = currentWorkbook(s)
      const sheetName = resolveSheet(s, wb, arg(args, ['sheet', 'sheetName', 'sheet_name']))
      if (!sheetName) return `工作簿没有工作表`
      const ws = wb.Sheets[sheetName]
      if (!ws) return notFoundSheet(s, wb, arg(args, ['sheet', 'sheetName']))
      const maxRows = Math.max(1, Math.min(2000, Math.floor(Number(arg(args, ['maxRows', 'max_rows', 'limit'])) || 200)))
      const startRow = rowNum(arg(args, ['startRow', 'start_row', 'from'])) || 1
      const endRowWant = rowNum(arg(args, ['endRow', 'end_row', 'to']))
      const startCol = colNum(arg(args, ['startCol', 'start_col', 'fromCol'])) || 1
      const endCol = colNum(arg(args, ['endCol', 'end_col', 'toCol']))
      const raw = arg(args, ['raw']) === true
      const formulas = arg(args, ['includeFormulas', 'include_formulas']) === true
      const format = String(arg(args, ['format']) || 'markdown').toLowerCase()
      // 本引擎写入的公式只有 <f> 无缓存值，SheetJS 会丢弃这些单元格 → 用原始 XML 的公式表补上
      const overlay = s.pkg ? XE.formulaCells(s.pkg, sheetName) : null

      const m = XR.cellMatrix(ws, { startRow, endRow: endRowWant, startCol, endCol, formulaOverlay: overlay || undefined, maxCells: Math.max(1, maxRows * (endCol && endCol >= startCol ? endCol - startCol + 1 : 40)) })
      let rows = XR.matrixRows(m, raw)
      // 公式模式：优先输出 =公式（含 SheetJS 丢弃的无缓存公式单元格）
      if (formulas) {
        const withF: any[][] = []
        for (let i = 0; i < m.raw.length; i++) {
          const r = m.rowNumbers[i]
          const width = m.raw[i]?.length || 0
          const line: any[] = []
          for (let k = 0; k < width; k++) {
            const ref = `${XE.numToCol(m.startCol + k)}${r}`
            const f = overlay?.get(ref) || XR.cellFormulaAt(ws, r, m.startCol + k)
            line.push(f ? '=' + f : (raw ? m.raw[i][k] : m.text[i][k]))
          }
          withF.push(line)
        }
        rows = withF
      }
      const capped = rows.slice(0, maxRows)
      const truncated = rows.length > capped.length || m.truncated
      const rangeText = `${XE.numToCol(m.startCol)}${m.startRow}`
      const budget = outBudget('read_sheet', args)
      if (format === 'json') {
        return clip(JSON.stringify({ sheet: sheetName, startRow: m.startRow, startCol: m.startCol, rows: capped, truncated, note: m.note }, null, 2), budget)
      }
      if (format === 'csv') {
        return clip(`# 工作表「${sheetName}」起始单元格 ${rangeText}（${capped.length} 行）\n` + XR.rowsToCsv(capped), budget)
      }
      const header = arg(args, ['header']) !== false && (startRow === 1 || arg(args, ['header']) === true)
      const md = XR.rowsToMarkdown(capped, { header, startCol: m.startCol })
      return clip(`工作表「${sheetName}」${rangeText} 起（返回 ${capped.length} 行 × ${capped[0]?.length ?? 0} 列${truncated ? '，已截断' : ''}）\n\n${md}${m.note ? `\n\n注：${m.note}` : ''}`, budget)
    }

    case 'search_cells': {
      const s = sessionOf(args)
      if (typeof s === 'string') return s
      const wb = currentWorkbook(s)
      const q = String(arg(args, ['query', 'query_text', 'text', 'find']) || '')
      if (!q) return '缺少 query 参数'
      const sheetWant = String(arg(args, ['sheet', 'sheetName']) || '').trim()
      const res = XR.searchCells(wb, q, {
        sheet: sheetWant ? (resolveSheet(s, wb, sheetWant) || undefined) : undefined,
        regex: arg(args, ['regex']) === true,
        ignoreCase: arg(args, ['ignoreCase', 'ignore_case']) !== false,
        max: Math.floor(Number(arg(args, ['max'])) || 50),
      })
      return clip(JSON.stringify({ query: q, total: res.total, returned: res.hits.length, truncated: res.truncated, hits: res.hits }), outBudget('search_cells', args))
    }

    case 'query_rows': {
      const s = sessionOf(args)
      if (typeof s === 'string') return s
      const wb = currentWorkbook(s)
      const sheetName = resolveSheet(s, wb, arg(args, ['sheet', 'sheetName', 'sheet_name']))
      if (!sheetName) return '工作簿没有工作表'
      if (!wb.Sheets[sheetName]) return notFoundSheet(s, wb, arg(args, ['sheet']))
      const res = XR.queryRows(wb, sheetName, {
        where: Array.isArray(args.where) ? args.where : undefined,
        match: args.match === 'any' ? 'any' : 'all',
        columns: Array.isArray(args.columns) ? args.columns : undefined,
        sortBy: arg(args, ['sortBy', 'sort_by', 'orderBy']),
        sortDir: String(arg(args, ['sortDir', 'sort_dir', 'order']) || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc',
        offset: Math.floor(Number(arg(args, ['offset', 'skip'])) || 0),
        limit: Math.floor(Number(arg(args, ['limit'])) || 100),
        raw: args.raw === true,
        headerRow: rowNum(arg(args, ['headerRow', 'header_row'])) || 1,
      })
      const budget = outBudget('query_rows', args)
      if (String(arg(args, ['format']) || 'table').toLowerCase() === 'json') return clip(JSON.stringify(res, null, 2), budget)
      const lead = `工作表「${sheetName}」匹配 ${res.matched} 行，返回 ${res.returned} 行（offset ${res.offset}${res.truncated ? '，已截断' : ''}）`
        + `｜workbookId=${s.workbookId}`
        + (res.note ? `｜注：${res.note}` : '')
      return clip(`${lead}\n${headerHint(res.header)}${compactTable(res.rows)}`, budget)
    }

    case 'aggregate': {
      const s = sessionOf(args)
      if (typeof s === 'string') return s
      const wb = currentWorkbook(s)
      const sheetName = resolveSheet(s, wb, arg(args, ['sheet', 'sheetName', 'sheet_name']))
      if (!sheetName) return '工作簿没有工作表'
      if (!wb.Sheets[sheetName]) return notFoundSheet(s, wb, arg(args, ['sheet']))
      const metrics = Array.isArray(args.metrics) ? args.metrics : []
      const groupBy = arg(args, ['groupBy', 'group_by', 'group', 'groupByColumns'])
      const res = XR.aggregateRows(wb, sheetName, {
        groupBy,
        metrics,
        where: Array.isArray(args.where) ? args.where : undefined,
        match: args.match === 'any' ? 'any' : 'all',
        sortBy: arg(args, ['sortBy', 'sort_by', 'orderBy']),
        sortDir: String(arg(args, ['sortDir', 'sort_dir', 'order']) || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc',
        limit: Math.floor(Number(arg(args, ['limit', 'topN', 'top_n', 'top'])) || 200),
        headerRow: rowNum(arg(args, ['headerRow', 'header_row'])) || 1,
      })
      const budget = outBudget('aggregate', args)
      if (String(arg(args, ['format']) || 'table').toLowerCase() === 'json') return clip(JSON.stringify(res, null, 2), budget)
      const lead = `工作表「${sheetName}」${groupBy !== undefined ? '分组统计' : '整表汇总'}：${res.groups.length} 组（统计 ${res.scanned} 行）`
        + `｜workbookId=${s.workbookId}`
        + (res.note ? `｜注：${res.note}` : '')
      return clip(`${lead}\n${headerHint(res.header)}${compactTable(res.groups)}`, budget)
    }

    case 'set_cells': {
      const s = sessionOf(args)
      if (typeof s === 'string') return s
      const ro = needWritable(s)
      if (ro) return ro
      const updates = Array.isArray(args.updates) ? args.updates : (Array.isArray(args.cells) ? args.cells : null)
      if (!updates || !updates.length) return '缺少 updates 参数（数组，如 [{"ref":"B2","value":100}]）'
      if (updates.length > 500) return `单次最多 500 个单元格修改（当前 ${updates.length}）`
      const res = XE.applyCellUpdates(s!.pkg!, updates, String(arg(args, ['sheet']) || ''))
      return JSON.stringify({
        applied: res.applied,
        errors: res.errors.length ? res.errors : undefined,
        modified: s!.pkg!.modified,
        note: res.applied.length ? '修改在内存中生效，请调用 save_workbook 写盘' : '未做任何修改',
      }, null, 2)
    }

    case 'append_rows': {
      const s = sessionOf(args)
      if (typeof s === 'string') return s
      const ro = needWritable(s)
      if (ro) return ro
      const wb = currentWorkbook(s)
      const sheetName = resolveSheet(s, wb, arg(args, ['sheet', 'sheetName']))
      if (!sheetName) return notFoundSheet(s, wb, arg(args, ['sheet']))
      const rows = Array.isArray(args.rows) ? args.rows : null
      if (!rows || !rows.length) return '缺少 rows 参数（二维数组）'
      if (rows.length > 5000) return `单次最多追加 5000 行（当前 ${rows.length}）`
      const res = XE.appendRowsToSheet(s!.pkg!, sheetName, rows, { startCol: colNum(arg(args, ['startCol', 'start_col'])) || 1 })
      if (!res.ok) return `追加失败: ${res.error}`
      return JSON.stringify({ sheet: res.sheet, startRow: res.startRow, endRow: res.endRow, added: res.added, note: '修改在内存中生效，请调用 save_workbook 写盘' }, null, 2)
    }

    case 'add_sheet': {
      const s = sessionOf(args)
      if (typeof s === 'string') return s
      const ro = needWritable(s)
      if (ro) return ro
      const sheetName = String(arg(args, ['name', 'sheetName', 'sheet_name']) || '').trim()
      if (!sheetName) return '缺少 name 参数'
      const res = XE.addSheet(s!.pkg!, sheetName, {
        rows: Array.isArray(args.rows) ? args.rows : undefined,
        index: arg(args, ['index']) !== undefined ? Number(arg(args, ['index'])) : undefined,
      })
      if (!res.ok) return `新增工作表失败: ${res.error}`
      return JSON.stringify({ ok: true, name: sheetName, part: res.part, note: `${res.note}；修改在内存中生效，请调用 save_workbook 写盘` }, null, 2)
    }

    case 'rename_sheet': {
      const s = sessionOf(args)
      if (typeof s === 'string') return s
      const ro = needWritable(s)
      if (ro) return ro
      const from = String(arg(args, ['sheet', 'sheetName', 'oldName', 'old_name']) || '').trim()
      const to = String(arg(args, ['newName', 'new_name', 'to', 'name']) || '').trim()
      if (!from || !to) return '需要提供 sheet（原名）与 newName（新名）'
      const res = XE.renameSheet(s!.pkg!, from, to)
      if (!res.ok) return `重命名失败: ${res.error}`
      return JSON.stringify({ ok: true, note: `${res.note}；修改在内存中生效，请调用 save_workbook 写盘` }, null, 2)
    }

    case 'delete_sheet': {
      const s = sessionOf(args)
      if (typeof s === 'string') return s
      const ro = needWritable(s)
      if (ro) return ro
      const sheetName = String(arg(args, ['sheet', 'sheetName', 'name']) || '').trim()
      if (!sheetName) return '缺少 sheet 参数'
      const res = XE.deleteSheet(s!.pkg!, sheetName)
      if (!res.ok) return `删除失败: ${res.error}`
      return JSON.stringify({ ok: true, note: `${res.note}；该删除在 save_workbook 后生效（保存前会生成 .bak 备份）` }, null, 2)
    }

    case 'create_workbook': {
      const raw = normPath(String(arg(args, ['path', 'filePath', 'file_path']) || ''))
      if (!raw) return '参数缺失：请提供新建文件的 path'
      const abs = path.isAbsolute(raw) ? raw : path.resolve(raw)
      const sheets = Array.isArray(args.sheets) ? args.sheets : (Array.isArray(args.data) ? [{ name: String(arg(args, ['sheetName', 'sheet_name']) || 'Sheet1'), rows: args.data }] : [{ name: 'Sheet1', rows: [] }])
      const res = XE.createWorkbookFile(abs, sheets, { overwrite: args.overwrite === true })
      if (!res.ok) return `新建失败: ${res.error}`
      // 自动打开为可编辑会话
      const s = openSession(abs)
      if (typeof s === 'string') return JSON.stringify({ created: true, path: abs, warning: `文件已创建，但打开会话失败：${s}` }, null, 2)
      return JSON.stringify({ created: true, path: abs, workbookId: s.workbookId, sheets: currentWorkbook(s).SheetNames, note: '已创建并打开为会话，可继续用 set_cells / append_rows 编辑' }, null, 2)
    }

    case 'save_workbook': {
      const s = sessionOf(args)
      if (typeof s === 'string') return s
      const ro = needWritable(s)
      if (ro) return ro
      if (!s!.pkg!.modified) return JSON.stringify({ saved: false, path: s!.path, note: '没有未保存的修改，未写盘' }, null, 2)
      const res = XE.saveXlsxPackage(s!.pkg!, { backup: arg(args, ['backup']) !== false })
      if (!res.ok) return `保存失败: ${res.error || '未知错误'}`
      s!.cache = null
      return JSON.stringify({ saved: true, path: res.path, backup: res.backup }, null, 2)
    }

    case 'close_workbook': {
      const s = sessionOf(args)
      if (typeof s === 'string') return s
      if (s.pkg && s.pkg.modified && arg(args, ['discard']) !== true) {
        return `工作簿有未保存的修改（${s.path}）。如需放弃修改请传 discard=true，或先调用 save_workbook。`
      }
      sessions.delete(s.workbookId)
      return `已关闭会话 ${s.workbookId}`
    }

    default:
      return `未知工具: ${name}`
  }
}

/** 断开内置连接时清理会话（可选调用） */
export function dispose(): void {
  sessions.clear()
}

export const xlsxService = {
  toolDefinitions,
  isXlsxTool,
  executeXlsxTool,
  dispose,
}
