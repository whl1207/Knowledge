/**
 * Office MCP 服务（内置 builtin-office）
 *
 * 与 browser-agent 同构：主进程内 SDK Server over InMemoryTransport，
 * 由 mcp-service 以「内置服务（builtin-office）」方式接入 → 设置页可见、
 * Agent / 工作流可通过 mcp_call 调用。
 *
 * 工具集（会话式：open 后返回 docId / workbookId，操作内存模型）：
 *  - Word（.docx，本文件）：open_document / list_blocks / read_text / find_text / document_info /
 *    export_markdown / find_and_replace_text / replace_paragraph / insert_paragraph / insert_table /
 *    insert_markdown / set_paragraph_style / delete_block / save_document / close_document
 *  - Excel（.xlsx/.xls/.csv，见 xlsx-service）：open_workbook / list_sheets / read_sheet / search_cells /
 *    query_rows / aggregate / set_cells / append_rows / add_sheet / rename_sheet / delete_sheet /
 *    create_workbook / save_workbook / close_workbook
 *
 * 仅依赖 Node + docx-reader / docx-editor / docx-to-markdown / docx-blocks / xlsx-*（均不 import electron），
 * 内核可复用于未来独立 stdio CLI。
 */
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseDocumentXml, type DocxReadResult, type DocxOutline, type OfficeBlock } from './docx-reader'
import { loadDocxPackage, applyFindReplace, saveDocxPackage, buildDocxBuffer, type DocxPackage } from './docx-editor'
// 注意：docx-to-markdown 只依赖 Node + mammoth/turndown（不 import electron），不破坏本模块的“可独立复用”约定
import { docxToMarkdown } from './docx-to-markdown'
// 块级编辑（M1.2）：replace / insert / delete / 样式 / Markdown 导入
import { findTextInBlocks, styleCatalog, replaceParagraphText, insertParagraph, insertTable, insertMarkdown, setParagraphStyle, deleteBlock } from './docx-blocks'
// Excel 服务（会话式读写 .xlsx；工具定义与执行器都在 xlsx-service）
import { xlsxService } from './xlsx-service'

// ---------------- 运行时懒加载 MCP Server SDK ----------------
// 主进程被打包时不能静态内联 MCP SDK（zod v4 内联损坏），一律 @vite-ignore 运行时加载。
interface ServerSdkBundle {
  Server: any
  InMemoryTransport: any
  ListToolsRequestSchema: any
  CallToolRequestSchema: any
}
let serverSdkCache: ServerSdkBundle | null = null
async function getServerSdk(): Promise<ServerSdkBundle> {
  if (serverSdkCache) return serverSdkCache
  const [serverMod, inMemoryMod, typesMod] = await Promise.all([
    import(/* @vite-ignore */ '@modelcontextprotocol/sdk/server/index.js'),
    import(/* @vite-ignore */ '@modelcontextprotocol/sdk/inMemory.js'),
    import(/* @vite-ignore */ '@modelcontextprotocol/sdk/types.js'),
  ])
  serverSdkCache = {
    Server: (serverMod as any).Server ?? (serverMod as any).McpServer,
    InMemoryTransport: (inMemoryMod as any).InMemoryTransport,
    ListToolsRequestSchema: (typesMod as any).ListToolsRequestSchema,
    CallToolRequestSchema: (typesMod as any).CallToolRequestSchema,
  }
  return serverSdkCache
}

// ---------------- 会话 ----------------
export const OFFICE_MCP_ID = 'builtin-office'
export const OFFICE_MCP_NAME = 'office-docx'

const MAX_SESSIONS = 20 // 内存会话上限，超出淘汰最旧
const MAX_BLOCK_TEXT = 2000 // 单块返回文本截断（避免超长 block 刷爆上下文）
const MAX_LIST_BLOCKS = 200 // 单次 list_blocks 上限

interface OfficeSession {
  docId: string
  pkg: DocxPackage
  read: DocxReadResult
  openedAt: number
  lastUseAt: number
}

const sessions = new Map<string, OfficeSession>()

function capSessions(): void {
  if (sessions.size <= MAX_SESSIONS) return
  const sorted = Array.from(sessions.values()).sort((a, b) => a.lastUseAt - b.lastUseAt)
  while (sessions.size > MAX_SESSIONS && sorted.length) {
    const old = sorted.shift()
    if (old) sessions.delete(old.docId)
  }
}

function findSession(docId: string): OfficeSession | null {
  const s = sessions.get(docId)
  if (!s) return null
  s.lastUseAt = Date.now()
  return s
}

/** 编辑后同步块模型（list_blocks / read_text / document_info 立即反映修改） */
function refreshRead(s: OfficeSession): void {
  s.read = parseDocumentXml(s.pkg.documentXml, s.pkg.path, s.pkg.name)
  enrichHeadingsByStyle(s)
}

/**
 * 标题级别补全：docx-reader 只能从 pStyle 名字里识别 Heading1/标题1 这类样式 ID，
 * 而中文版 Word（以及 WPS）常用 w:styleId="1" ~ "9" 表示「标题 1」~「标题 9」，
 * 此时需要按 styles.xml 的样式名回填 headingLevel，否则标题大纲为空。
 */
function enrichHeadingsByStyle(s: OfficeSession): void {
  const cat = styleCatalog(s.pkg)
  if (!cat.length) return
  const levelOf = new Map<string, number>()
  for (const st of cat) {
    if (st.headingLevel !== undefined && !levelOf.has(st.id)) levelOf.set(st.id, st.headingLevel)
  }
  if (!levelOf.size) return
  const headings: DocxOutline[] = []
  for (const b of s.read.blocks) {
    if (b.kind !== 'paragraph') continue
    if (b.headingLevel === undefined && b.style && levelOf.has(b.style)) {
      b.headingLevel = levelOf.get(b.style)
    }
    if (b.headingLevel !== undefined && b.text) headings.push({ index: b.index, level: b.headingLevel, text: b.text })
  }
  s.read.headings = headings
}

/** 取块当前样式（用于工具回执展示） */
function styleOfBlock(s: OfficeSession, index: number): string | undefined {
  const b = s.read.blocks.find(x => x.index === index)
  if (!b) return undefined
  return b.style || (b.headingLevel !== undefined ? `标题 ${b.headingLevel}` : undefined)
}

/** 从参数里按多别名取第一个非空值（兼容 LLM 命名方差：path/filePath、docId/doc_id 等） */
function arg(args: Record<string, any>, keys: string[]): any {
  for (const k of keys) {
    const v = args?.[k]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

/** docId 的可用别名（兼容 LLM 命名方差） */
const DOC_ID_KEYS = ['docId', 'doc_id', 'documentId', 'document_id', 'docid']
/** 文件路径的可用别名 */
const DOC_PATH_KEYS = ['path', 'filePath', 'file_path', 'filepath', 'file']

/**
 * 按别名解析会话（docId / doc_id / documentId …）：
 * 未传 docId 时回退到「按 path 命中的会话」或「唯一已打开的文档」，避免模型忘带会话 ID 就直接失败。
 */
function sessionOf(args: Record<string, any>): OfficeSession | null {
  const id = String(arg(args, DOC_ID_KEYS) || '')
  if (id) return findSession(id)
  const wantPath = normPath(String(arg(args, DOC_PATH_KEYS) || ''))
  const all = Array.from(sessions.values())
  const fallback = wantPath ? all.find(s => s.pkg.path === wantPath) : (all.length === 1 ? all[0] : null)
  if (fallback) fallback.lastUseAt = Date.now()
  return fallback || null
}

/**
 * 会话失败原因：区分「压根没传 docId」与「ID 已失效」，
 * 并列出当前可用会话（旧版把两种情形合并成一句「无效或已关闭」，属于误报）。
 */
function sessionError(args: Record<string, any>): string {
  const id = String(arg(args, DOC_ID_KEYS) || '')
  const open = Array.from(sessions.values()).sort((a, b) => b.lastUseAt - a.lastUseAt)
  const list = open.length
    ? `\n当前已打开的文档会话：\n${open.map(s => `- docId: ${s.docId}　路径: ${s.pkg.path}`).join('\n')}`
    : '\n当前没有任何已打开的文档会话。'
  if (!id) {
    return `缺少 docId 参数：请先调用 open_document 获取 docId，并在后续调用中把它原样放进 args 传入。${list}`
  }
  return `docId「${id}」已失效（主进程重启、已被 close_document 关闭，或同时打开的文档超过 ${MAX_SESSIONS} 个被淘汰）。请重新 open_document 后再试。${list}`
}

/** 资源路径清理：去掉 ./ 段，只用于显示，不用于路径穿越 */
function normPath(p: string): string {
  return String(p || '').trim().replace(/^file:\/\/\//, '')
}

// ---------------- 工具定义（schema 与渲染端 mcp 保持一致：object 结构） ----------------
/**
 * 全部工具 = Word 基础（打开/阅读/替换/保存） + Word 块级编辑（M1.2） + Excel（读写查询，见 xlsx-service）
 */
export function toolDefinitions(): any[] {
  return [
    ...docxToolDefinitions(),
    ...docxEditToolDefinitions(),
    ...xlsxService.toolDefinitions(),
  ]
}

/** Word 基础工具 */
function docxToolDefinitions(): any[] {
  return [
    {
      name: 'open_document',
      description: '打开本地 .docx 文件：解析为段落/表格块模型，返回 docId、字数、段落数、标题大纲。支持文本替换（find_and_replace_text）与保存（save_document）。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '.docx 文件的绝对路径（.doc 旧格式不支持）。path / filePath / file_path 三者等价，任选其一' },
          filePath: { type: 'string', description: 'path 的别名，任选其一' },
        },
        required: ['path'],
      },
    },
    {
      name: 'list_blocks',
      description: '列出已打开文档的块清单（段落/表格），每块含序号、类型、标题级别与文本预览，便于定位内容。参数 docId（或 doc_id）为 open_document 返回值。',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string', description: 'open_document 返回的会话 ID（docId / doc_id 等价）' },
          doc_id: { type: 'string', description: 'docId 的别名，任选其一' },
          start: { type: 'number', description: '起始块序号（1 起，默认 1）' },
          limit: { type: 'number', description: '返回块数上限（默认 100，最大 200）' },
        },
        required: ['docId'],
      },
    },
    {
      name: 'read_text',
      description: '读取文档文本：不带块序号返回全文；带 index（或 block_index）只返回该块的完整文本（format=markdown 时表格块输出 Markdown 表格）。',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string', description: 'open_document 返回的会话 ID（docId / doc_id 等价）' },
          doc_id: { type: 'string', description: 'docId 的别名，任选其一' },
          index: { type: 'number', description: '可选：块序号（1 起），省略返回全文' },
          block_index: { type: 'number', description: 'index 的别名，任选其一' },
          format: { type: 'string', enum: ['text', 'markdown'], description: 'text（默认）纯文本；markdown 让表格块输出 Markdown 表格' },
        },
        required: ['docId'],
      },
    },
    {
      name: 'export_markdown',
      description: '把当前文档导出为 Markdown 文本（与预览完全一致：标题 # 层级、Word 自动编号回填、表格管道行、公式转 LaTeX、忽略空白表格；图片不导出），供转述/另存/改写。未保存的 find_and_replace_text 修改也会体现在导出结果里。',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string', description: 'open_document 返回的会话 ID（docId / doc_id 等价）' },
          doc_id: { type: 'string', description: 'docId 的别名，任选其一' },
        },
        required: ['docId'],
      },
    },
    {
      name: 'find_and_replace_text',
      description: 'L1 文本替换：把 find（或 find_text）替换为 replace（或 replacement；默认全部；scope=first 只替换第一处；ignoreCase 忽略大小写）。匹配完整落在同一 w:t 内时原地替换、完整保留该段格式；跨 run 的匹配会整段归一重建（保留段落样式 pStyle 与段首格式，段内其它局部格式可能归一）。替换后需 save_document 写盘。',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string', description: 'open_document 返回的会话 ID（docId / doc_id 等价）' },
          doc_id: { type: 'string', description: 'docId 的别名，任选其一' },
          find: { type: 'string', description: '要查找的文本' },
          find_text: { type: 'string', description: 'find 的别名，任选其一' },
          replace: { type: 'string', description: '替换为的文本（可含换行）' },
          replace_text: { type: 'string', description: 'replace 的别名，任选其一' },
          scope: { type: 'string', enum: ['all', 'first'], description: '默认 all 全部；first 只替换第一处' },
          ignoreCase: { type: 'boolean', description: '是否忽略大小写（默认 false）' },
        },
        required: ['docId', 'find', 'replace'],
      },
    },
    {
      name: 'save_document',
      description: '把当前文档写回磁盘：仅替换正文（word/document.xml），其余部件（styles/主题/页眉页脚/图片等）原样保留；写回前自动备份为 <文件>.bak，原子覆盖保存。返回保存路径与备份路径。',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string', description: 'open_document 返回的会话 ID（docId / doc_id 等价）' },
          doc_id: { type: 'string', description: 'docId 的别名，任选其一' },
          backup: { type: 'boolean', description: '写回前是否备份原文件（默认 true）' },
        },
        required: ['docId'],
      },
    },
    {
      name: 'close_document',
      description: '关闭并释放文档会话（释放内存）。若有未保存修改需传 discard=true 才会丢弃并关闭。',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string', description: 'open_document 返回的会话 ID（docId / doc_id 等价）' },
          doc_id: { type: 'string', description: 'docId 的别名，任选其一' },
          discard: { type: 'boolean', description: '存在未保存修改时传 true 强制丢弃关闭（默认 false）' },
        },
        required: ['docId'],
      },
    },
  ]
}

/** Word 块级编辑与检索工具（M1.2）：定位 → 改块 → 存盘 */
function docxEditToolDefinitions(): any[] {
  const docId = { docId: { type: 'string', description: 'open_document 返回的会话 ID（docId / doc_id 等价）' } }
  const docIdAlias = { doc_id: { type: 'string', description: 'docId 的别名，任选其一' } }
  const index = { index: { type: 'number', description: '块序号（1 起，见 list_blocks / find_text）' }, block_index: { type: 'number', description: 'index 的别名，任选其一' } }
  const position = { position: { type: 'string', enum: ['before', 'after', 'end'], description: '插入位置：before/after 相对 index 块；end（或省略 index）= 追加到正文末尾' } }
  return [
    {
      name: 'find_text',
      description: '在已打开的 Word 文档中查找文本（支持正则与忽略大小写），返回命中块序号、命中次数与上下文片段。用于先定位再修改（配合 replace_paragraph / set_paragraph_style / insert_paragraph）。',
      inputSchema: {
        type: 'object',
        properties: {
          ...docId,
          ...docIdAlias,
          find: { type: 'string', description: '要查找的文本（或用正则）' },
          find_text: { type: 'string', description: 'find 的别名，任选其一' },
          regex: { type: 'boolean', description: '按正则匹配（默认 false）' },
          ignoreCase: { type: 'boolean', description: '忽略大小写（默认 false）' },
          max: { type: 'number', description: '最多返回命中块数（默认 50，最大 200）' },
          context: { type: 'number', description: '片段上下文长度（默认 40 字符）' },
        },
        required: ['docId', 'find'],
      },
    },
    {
      name: 'document_info',
      description: '文档总览：字数、段落数、表格数、图片数、标题大纲（层级 + 块序号）与可用样式列表（供 set_paragraph_style 指定 style 用）。',
      inputSchema: { type: 'object', properties: { ...docId, ...docIdAlias }, required: ['docId'] },
    },
    {
      name: 'replace_paragraph',
      description: '整段重写：用新文本替换指定块的段落内容，保留该段原有段落样式与段首字符格式（不改变标题级别）。',
      inputSchema: {
        type: 'object',
        properties: { ...docId, ...docIdAlias, ...index, text: { type: 'string', description: '新的段落文本（可含换行）' }, content: { type: 'string', description: 'text 的别名' } },
        required: ['docId', 'index', 'text'],
      },
    },
    {
      name: 'insert_paragraph',
      description: '插入段落：默认在 index 块之后（position=before 则之前；省略 index 或 position=end 则追加到正文末尾），可同时设为标题（headingLevel=1-6）或指定样式；新段会继承邻段的字符格式。',
      inputSchema: {
        type: 'object',
        properties: {
          ...docId,
          ...docIdAlias,
          ...index,
          ...position,
          text: { type: 'string', description: '段落文本（可含换行）' },
          headingLevel: { type: 'number', description: '设为标题级别 1-6（可选）' },
          style: { type: 'string', description: '段落样式名或 styleId（可选，如 “标题 1”/Heading1）' },
        },
        required: ['docId', 'text'],
      },
    },
    {
      name: 'insert_table',
      description: '插入表格：rows 为二维数组（首行默认加粗作表头），位置语义同 insert_paragraph（贴在正文末尾时会自动补一个空段落）。表格带显式边框，任何文档里都能正常显示。',
      inputSchema: {
        type: 'object',
        properties: {
          ...docId,
          ...docIdAlias,
          ...index,
          ...position,
          rows: { type: 'array', description: '二维数组，如 [["姓名","金额"],["张三","100"]]', items: { type: 'array', items: {} } },
          header: { type: 'boolean', description: '首行是否作为表头加粗（默认 true）' },
        },
        required: ['docId', 'rows'],
      },
    },
    {
      name: 'insert_markdown',
      description: '把 Markdown 片段转换成 Word 块插入：支持 # 标题（1-6 级按文档现有标题样式）、普通段落、- / 1. 列表（转为符号文本）、> 引用、管道表格（首行加粗为表头）；行内 **粗体**/`代码`/链接标记会降级为纯文本。适合把 AI 生成的内容成段写入文档。',
      inputSchema: {
        type: 'object',
        properties: {
          ...docId,
          ...docIdAlias,
          ...index,
          ...position,
          markdown: { type: 'string', description: 'Markdown 文本' },
          text: { type: 'string', description: 'markdown 的别名，任选其一' },
        },
        required: ['docId', 'markdown'],
      },
    },
    {
      name: 'set_paragraph_style',
      description: '设置段落样式 / 标题级别：style 传样式名或 styleId（先 document_info 查可用样式；传空串 = 清除样式），或 headingLevel=1-6 套用文档现成的标题样式（自动解析 styles.xml 中的真实 styleId）。',
      inputSchema: {
        type: 'object',
        properties: {
          ...docId,
          ...docIdAlias,
          ...index,
          style: { type: 'string', description: '段落样式名 / styleId（如 “标题 1”、“Heading1”、空串=清除）' },
          headingLevel: { type: 'number', description: '标题级别 1-6（与 style 二选一）' },
        },
        required: ['docId', 'index'],
      },
    },
    {
      name: 'delete_block',
      description: '删除指定块（段落或表格）。删除后后续块序号会前移，需重新 list_blocks 确认。',
      inputSchema: { type: 'object', properties: { ...docId, ...docIdAlias, ...index }, required: ['docId', 'index'] },
    },
  ]
}

// ---------------- 工具执行内核 ----------------
/** 回退实现：用 docx-reader 的块模型拼 Markdown（无编号回填 / 无公式 / 不剔空表，仅在转换管线异常时用） */
function markdownFromBlocks(s: OfficeSession): string {
  const out: string[] = []
  for (const b of s.read.blocks) {
    if (b.kind === 'table') {
      if (b.table) {
        for (const row of b.table) {
          out.push('| ' + row.map(c => c.replace(/\|/g, '\\|')).join(' | ') + ' |')
        }
      }
      out.push('')
      continue
    }
    if (b.headingLevel !== undefined && b.headingLevel > 0) {
      out.push('#'.repeat(b.headingLevel) + ' ' + b.text)
    } else {
      out.push(b.text)
    }
    out.push('')
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

async function executeTool(name: string, args: Record<string, any> = {}): Promise<string> {
  // Excel 工具由 xlsx-service 提供（会话式 workbookId）
  if (xlsxService.isXlsxTool(name)) return xlsxService.executeXlsxTool(name, args)
  switch (name) {
    case 'open_document': {
      const raw = normPath(String(arg(args, ['path', 'filePath', 'file_path']) || ''))
      if (!raw) return '参数缺失：请提供 .docx 文件的 path'
      const p = raw.replace(/\\/g, path.sep === '\\' ? '\\' : '/')
      const abs = path.isAbsolute(p) ? p : path.resolve(p)
      if (!fs.existsSync(abs)) return `文件不存在: ${abs}`
      const ext = path.extname(abs).toLowerCase()
      if (ext === '.doc') return '不支持旧版 .doc 二进制格式，请先在 Word 中另存为 .docx'
      if (ext !== '.docx') return `仅支持 .docx：${abs}`
      let pkg: DocxPackage
      try { pkg = loadDocxPackage(abs) } catch (e: any) { return `打开失败: ${e?.message || String(e)}` }
      const read = parseDocumentXml(pkg.documentXml, abs, pkg.name)
      if (read.error || !pkg.documentXml) return `打开失败: ${read.error || '缺少 word/document.xml'}`
      const docId = randomUUID()
      sessions.set(docId, { docId, pkg, read, openedAt: Date.now(), lastUseAt: Date.now() })
      capSessions()
      enrichHeadingsByStyle(sessions.get(docId)!)
      return JSON.stringify({
        docId,
        name: read.name,
        path: abs,
        wordCount: read.wordCount,
        paragraphCount: read.blocks.length,
        tableCount: read.blocks.filter(b => b.kind === 'table').length,
        headings: read.headings.slice(0, 100).map(h => ({ index: h.index, level: h.level, text: h.text.slice(0, 80) })),
      }, null, 2)
    }
    case 'list_blocks': {
      const s = sessionOf(args)
      if (!s) return sessionError(args)
      const start = Math.max(1, Number(arg(args, ['start', 'from']) || 1) || 1)
      const limit = Math.min(MAX_LIST_BLOCKS, Math.max(1, Number(args.limit) || 100))
      const list = s.read.blocks.slice(start - 1, start - 1 + limit).map(b => {
        const line: any = { index: b.index, kind: b.kind }
        if (b.headingLevel !== undefined) line.headingLevel = b.headingLevel
        if (b.style) line.style = b.style
        line.text = (b.text || '').slice(0, MAX_BLOCK_TEXT)
        line.charCount = (b.text || '').length
        return line
      })
      return JSON.stringify({
        total: s.read.blocks.length,
        returned: list.length,
        blocks: list,
      }, null, 2)
    }
    case 'read_text': {
      const s = sessionOf(args)
      if (!s) return sessionError(args)
      const wantMd = String(arg(args, ['format']) || 'text').toLowerCase() === 'markdown'
      const hasIdx = arg(args, ['index', 'block_index']) !== undefined
      const idx = Number(arg(args, ['index', 'block_index']))
      const render = (b: OfficeBlock): string => {
        if (b.kind === 'table' && wantMd && b.table) {
          const rows = b.table
          const head = rows[0] || []
          const width = Math.max(1, ...rows.map(r => r.length))
          const pad = (r: string[]) => Array.from({ length: width }, (_, i) => String(r[i] ?? '').replace(/\|/g, '\\|'))
          const out = ['| ' + pad(head).join(' | ') + ' |', '| ' + Array.from({ length: width }, () => '---').join(' | ') + ' |']
          for (let i = 1; i < rows.length; i++) out.push('| ' + pad(rows[i]).join(' | ') + ' |')
          return out.join('\n')
        }
        return b.text
      }
      if (!hasIdx) {
        return s.read.blocks.map(render).join('\n')
      }
      const blk = s.read.blocks.find(b => b.index === idx)
      if (!blk) return `块序号 ${idx} 不存在（范围 1..${s.read.blocks.length}）`
      return render(blk) || '（空块）'
    }
    case 'find_text': {
      const s = sessionOf(args)
      if (!s) return sessionError(args)
      const find = String(arg(args, ['find', 'find_text', 'text', 'query']) ?? '')
      if (!find) return '缺少 find 参数'
      const r = findTextInBlocks(s.pkg.documentXml, find, {
        ignoreCase: arg(args, ['ignoreCase', 'ignore_case']) === true,
        regex: arg(args, ['regex']) === true,
        max: Number(arg(args, ['max'])) || 50,
        context: arg(args, ['context']) !== undefined ? Number(arg(args, ['context'])) : 40,
      })
      return JSON.stringify({
        find,
        total: r.total,
        matchedBlocks: r.matches.length,
        truncated: r.truncated || undefined,
        matches: r.matches,
        note: 'matches[].index 可直接用于 read_text / replace_paragraph / set_paragraph_style / insert_paragraph / delete_block',
      }, null, 2)
    }
    case 'document_info': {
      const s = sessionOf(args)
      if (!s) return sessionError(args)
      const blocks = s.read.blocks
      const styles = styleCatalog(s.pkg)
        .filter(st => st.type !== 'character')
        .slice(0, 80)
        .map(st => ({ id: st.id, name: st.name, ...(st.headingLevel !== undefined ? { headingLevel: st.headingLevel } : {}) }))
      return JSON.stringify({
        name: s.read.name,
        path: s.pkg.path,
        wordCount: s.read.wordCount,
        paragraphCount: blocks.length,
        tableCount: blocks.filter(b => b.kind === 'table').length,
        imageCount: s.pkg.entries.filter(e => /^word\/media\//.test(e.name)).length,
        headingCount: s.read.headings.length,
        headings: s.read.headings.slice(0, 150).map(h => ({ index: h.index, level: h.level, text: h.text.slice(0, 80) })),
        styles,
        modified: s.pkg.modified,
      }, null, 2)
    }
    case 'replace_paragraph': {
      const s = sessionOf(args)
      if (!s) return sessionError(args)
      const idx = Number(arg(args, ['index', 'block_index', 'paragraphIndex']))
      if (!Number.isFinite(idx)) return '缺少 index（块序号，见 list_blocks / find_text）'
      const text = String(arg(args, ['text', 'content', 'newText']) ?? '')
      const r = replaceParagraphText(s.pkg, idx, text)
      if (!r.ok) return r.error || '替换失败'
      refreshRead(s)
      return JSON.stringify({ ok: true, index: r.index, detail: r.detail, modified: s.pkg.modified, note: '修改在内存中生效，请调用 save_document 写盘' }, null, 2)
    }
    case 'insert_paragraph': {
      const s = sessionOf(args)
      if (!s) return sessionError(args)
      const text = String(arg(args, ['text', 'content']) ?? '')
      if (!text) return '缺少 text 参数'
      const idxRaw = arg(args, ['index', 'block_index', 'afterIndex'])
      const r = insertParagraph(s.pkg, {
        index: idxRaw !== undefined ? Number(idxRaw) : undefined,
        position: arg(args, ['position', 'where']) ? String(arg(args, ['position', 'where'])).toLowerCase() : undefined,
        text,
        style: arg(args, ['style', 'styleId']) !== undefined ? String(arg(args, ['style', 'styleId'])) : undefined,
        headingLevel: arg(args, ['headingLevel', 'heading_level', 'level']) !== undefined ? Number(arg(args, ['headingLevel', 'heading_level', 'level'])) : undefined,
      })
      if (!r.ok) return r.error || '插入失败'
      refreshRead(s)
      return JSON.stringify({ ok: true, newIndex: r.index, detail: r.detail, modified: s.pkg.modified, note: '修改在内存中生效，请调用 save_document 写盘' }, null, 2)
    }
    case 'insert_table': {
      const s = sessionOf(args)
      if (!s) return sessionError(args)
      const rows = Array.isArray(args.rows) ? args.rows : null
      if (!rows || !rows.length) return '缺少 rows 参数（二维数组，如 [["姓名","金额"],["张三","100"]]）'
      const idxRaw = arg(args, ['index', 'block_index'])
      const r = insertTable(s.pkg, {
        index: idxRaw !== undefined ? Number(idxRaw) : undefined,
        position: arg(args, ['position', 'where']) ? String(arg(args, ['position', 'where'])).toLowerCase() : undefined,
        rows: rows.map((row: any) => (Array.isArray(row) ? row.map((c: any) => String(c ?? '')) : [String(row ?? '')])),
        header: arg(args, ['header']) !== false,
      })
      if (!r.ok) return r.error || '插入表格失败'
      refreshRead(s)
      return JSON.stringify({ ok: true, newIndex: r.index, detail: r.detail, modified: s.pkg.modified, note: '修改在内存中生效，请调用 save_document 写盘' }, null, 2)
    }
    case 'insert_markdown': {
      const s = sessionOf(args)
      if (!s) return sessionError(args)
      const md = String(arg(args, ['markdown', 'text', 'content']) ?? '')
      if (!md.trim()) return '缺少 markdown 参数'
      const idxRaw = arg(args, ['index', 'block_index'])
      const r = insertMarkdown(s.pkg, md, {
        index: idxRaw !== undefined ? Number(idxRaw) : undefined,
        position: arg(args, ['position', 'where']) ? String(arg(args, ['position', 'where'])).toLowerCase() : undefined,
      })
      if (!r.ok) return r.error || '插入失败'
      refreshRead(s)
      return JSON.stringify({ ok: true, newIndex: r.index, blocks: r.blocks, detail: r.detail, modified: s.pkg.modified, note: '支持 # 标题 / 段落 / 列表 / 管道表格；行内强调标记会降级为纯文本。修改在内存中生效，请调用 save_document 写盘' }, null, 2)
    }
    case 'set_paragraph_style': {
      const s = sessionOf(args)
      if (!s) return sessionError(args)
      const idx = Number(arg(args, ['index', 'block_index']))
      if (!Number.isFinite(idx)) return '缺少 index（块序号）'
      const styleRaw = arg(args, ['style', 'styleId', 'style_id'])
      const levelRaw = arg(args, ['headingLevel', 'heading_level', 'level'])
      if (styleRaw === undefined && levelRaw === undefined) return '需提供 style（样式名/ID，如 “标题 1”/Heading1，空串 = 清除样式）或 headingLevel（1-6）'
      const r = setParagraphStyle(s.pkg, idx, {
        style: styleRaw !== undefined ? String(styleRaw) : undefined,
        headingLevel: levelRaw !== undefined ? Number(levelRaw) : undefined,
      })
      if (!r.ok) return r.error || '设置样式失败'
      refreshRead(s)
      return JSON.stringify({ ok: true, index: r.index, detail: r.detail, style: styleOfBlock(s, idx), modified: s.pkg.modified, note: '修改在内存中生效，请调用 save_document 写盘' }, null, 2)
    }
    case 'delete_block': {
      const s = sessionOf(args)
      if (!s) return sessionError(args)
      const idx = Number(arg(args, ['index', 'block_index']))
      if (!Number.isFinite(idx)) return '缺少 index（块序号）'
      const r = deleteBlock(s.pkg, idx)
      if (!r.ok) return r.error || '删除失败'
      refreshRead(s)
      return JSON.stringify({ ok: true, detail: r.detail, totalBlocks: s.read.blocks.length, modified: s.pkg.modified, note: '删除后后续块序号会前移，请重新 list_blocks；修改在内存中生效，请调用 save_document 写盘' }, null, 2)
    }
    case 'export_markdown': {
      const s = sessionOf(args)
      if (!s) return sessionError(args)
      // 统一走 mammoth 转换管线（与预览 / 聊天附件 / 知识库 / Agent read_file 完全同一套实现）：
      // atx 标题、Word 自动编号回填、管道表格、OMML 公式转 LaTeX、丢弃空白表格。
      // 传内存包而不是 pkg.path：find_and_replace_text 的修改可能还没 save_document，导出要跟当前内容走。
      try {
        const md = await docxToMarkdown({ buffer: buildDocxBuffer(s.pkg), extractImages: false })
        if (md && md.trim()) return md
      } catch (e) {
        console.warn('[office] export_markdown 走 docxToMarkdown 失败，回退块模型拼装:', e)
      }
      return markdownFromBlocks(s)
    }
    case 'find_and_replace_text': {
      const s = sessionOf(args)
      if (!s) return sessionError(args)
      const find = String(arg(args, ['find', 'find_text']) ?? '')
      if (!find) return '缺少 find 参数'
      const replace = String(arg(args, ['replace', 'replace_text', 'replacement']) ?? '')
      const r = applyFindReplace(s.pkg, find, replace, {
        scope: args.scope === 'first' ? 'first' : 'all',
        ignoreCase: !!args.ignoreCase,
      })
      if (r.replaced > 0) {
        s.read = parseDocumentXml(s.pkg.documentXml, s.pkg.path, s.pkg.name)
      }
      return JSON.stringify({
        replaced: r.replaced,
        paragraphs: r.paragraphs,
        modified: s.pkg.modified,
        note: r.replaced === 0
          ? '未找到匹配文本，未做任何修改'
          : (s.pkg.modified ? '已修改内存文档，调用 save_document 写盘' : ''),
      }, null, 2)
    }
    case 'save_document': {
      const s = sessionOf(args)
      if (!s) return sessionError(args)
      const res = saveDocxPackage(s.pkg, { backup: arg(args, ['backup']) !== false })
      if (!res.ok) return `保存失败: ${res.error || '未知错误'}`
      return JSON.stringify({ saved: true, path: res.path, backup: res.backup }, null, 2)
    }
    case 'close_document': {
      const s = sessionOf(args)
      if (!s) return sessionError(args)
      if (s.pkg.modified && arg(args, ['discard']) !== true) {
        return `文档有未保存的修改（${s.pkg.path}）。如需放弃修改请传 discard=true，或先调用 save_document。`
      }
      const docId = s.docId
      sessions.delete(docId)
      return `已关闭会话 ${docId}`
    }
    default:
      return `未知工具: ${name}`
  }
}

// ---------------- 共享单例 Server（内置连接与对外暴露共用，可同时 connect 多个 transport） ----------------
let sharedServer: any = null
let sharedServerReady: Promise<any> | null = null

async function ensureServer(): Promise<any> {
  if (sharedServer) return sharedServer
  if (!sharedServerReady) {
    sharedServerReady = (async () => {
      const sdk = await getServerSdk()
      const server = new sdk.Server(
        { name: 'AI-KM Office (Word / Excel 读写)', version: '0.3.0' },
        { capabilities: { tools: {} } }
      )
      const tools = toolDefinitions()
      server.setRequestHandler(sdk.ListToolsRequestSchema, async () => ({ tools }))
      server.setRequestHandler(sdk.CallToolRequestSchema, async (req: any) => {
        const toolName = String(req?.params?.name || '')
        const args = (req?.params?.arguments && typeof req.params.arguments === 'object') ? req.params.arguments : {}
        try {
          const text = await executeTool(toolName, args)
          return { content: [{ type: 'text', text }] }
        } catch (err: any) {
          return { isError: true, content: [{ type: 'text', text: `错误: ${err?.message || String(err)}` }] }
        }
      })
      sharedServer = server
      return server
    })()
  }
  return sharedServerReady
}

/** 供 mcp-service：内置连接每次创建一对 InMemory transport 并挂到共享 Server（断开即回收） */
export async function createLocalServerPair(): Promise<{ server: any; clientTransport: any }> {
  const sdk = await getServerSdk()
  const server = await ensureServer()
  const [clientTransport, serverTransport] = sdk.InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  return { server, clientTransport }
}

/** 供对外 HTTP 暴露层：把外部 transport 挂到同一共享 Server */
export async function connectTransport(transport: any): Promise<void> {
  const server = await ensureServer()
  await server.connect(transport)
}

/** 供 mcp-service 断开时清理会话（可选调用） */
export function dispose(): void {
  sessions.clear()
  xlsxService.dispose()
}

export const officeService = {
  createLocalServerPair,
  connectTransport,
  toolDefinitions,
  listToolNames: () => toolDefinitions().map((t: any) => t.name),
  /** 直接执行某个工具（调试 / 自动化测试 / 未来 IPC 直连用，跳过 MCP 传输层） */
  executeTool,
  dispose,
}
