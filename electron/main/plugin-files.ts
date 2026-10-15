/**
 * plugin-files.ts — 插件文件能力 IPC（`plugin:files:*`）
 *
 * 为什么需要它：插件渲染层半边是 Blob URL 加载的单文件 ESM，**拿不到应用的文件读写链路**
 * （也不能 import 应用的 pdfjs）。合同审核这类"上传 → 预览 → 交给模型"的插件必须由宿主
 * 提供「选文件 / 选文件夹 / 列目录 / 读文本 / 提取 PDF 文本 / 读二进制」这几件事。
 *
 * 安全模型（两层）：
 * 1. **权限**：只有清单声明了 `fs` 权限、且插件当前处于激活态的插件才能调用；
 * 2. **授权范围（capability allowlist）**：只允许访问"用户在该插件里亲自选过"的文件
 *    与文件夹（及其子项）。插件不能凭一个路径字符串读到任意位置——即使它拿到了路径。
 *    这份清单会**落盘**（见 plugin-grants.ts），所以「上次选的游戏目录 / 法规库目录」
 *    重启后照样能用；用户可在「设置 → 插件 → 数据」里逐条撤销，卸载插件会全部清掉。
 *
 * PDF 文本提取用 pdfjs-dist（与 electron/main/index.ts 的 readPdf 同一套做法），
 * 视觉预览由**渲染层**用应用自带的 pdfjs 渲染成 PNG（见 src/lib/plugin/files.ts）。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { BrowserWindow, dialog, ipcMain } from 'electron'
// 主进程是 Node 环境：pdfjs 必须用 legacy 构建（现代构建会在导入时警告并要求换 legacy）
import * as PDFJS from 'pdfjs-dist/legacy/build/pdf.mjs'
import xlsx from 'xlsx'
import { IPCError } from '@/types/ipc'
import { pluginHost } from './plugin-host'
import { requirePluginApproval } from './plugin-approval'
import { addGrant, clearGrants, grantPaths, listGrants, revokeGrant } from './plugin-grants'

/** 读表格的上限（避免大表把主进程内存打满；插件侧据此也能判断是否被截断） */
const SHEET_MAX_BYTES = 32 * 1024 * 1024
const SHEET_MAX_ROWS = 20000
const SHEET_MAX_SHEETS = 20
const SHEET_MAX_COLS = 200

/** 插件是否声明了 fs 权限（未声明一律拒绝） */
function requireFsPermission(pluginId: string): void {
  const snapshot = pluginHost.list().find((p) => p.id === pluginId)
  if (!snapshot) throw new IPCError('PLUGIN_NOT_FOUND', `插件不存在：${pluginId}`)
  // 停用期间不接受任何调用；但「记住的路径」不清（授权是用户点过的，撤销走「插件 → 数据」）
  if (!snapshot.enabled) throw new IPCError('PERMISSION_DENIED', `插件未启用：${pluginId}`)
  if (!snapshot.permissions.includes('fs')) {
    throw new IPCError('PERMISSION_DENIED', `插件 ${pluginId} 未声明 fs 权限（package.json 的 aikm.permissions）`)
  }
}

function readPluginId(payload: unknown): string {
  const id = String((payload as { id?: unknown })?.id ?? '').trim()
  if (!id) throw new IPCError('INVALID_INPUT', '缺少插件 id')
  return id
}

/** 路径是否落在该插件被授权的范围内（自身或某授权文件夹的子项） */
function assertAllowed(pluginId: string, target: string): void {
  const resolved = path.resolve(target)
  for (const root of grantPaths(pluginId)) {
    if (resolved === root) return
    const prefix = root.endsWith(path.sep) ? root : root + path.sep
    if (resolved.startsWith(prefix)) return
  }
  throw new IPCError(
    'PERMISSION_DENIED',
    `未授权访问：${resolved}（只能访问你在该插件里选择过的文件 / 文件夹）`,
  )
}

function asIpcError(error: unknown): IPCError {
  if (error instanceof IPCError) return error
  return new IPCError('PLUGIN_FILES_FAILED', error instanceof Error ? error.message : String(error))
}

async function readPdfText(buffer: Buffer): Promise<{ text: string; pages: number }> {
  const task = PDFJS.getDocument({ data: new Uint8Array(buffer) })
  const doc = await task.promise
  try {
    const parts: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      const line = (content.items as Array<{ str?: string }>).map((it) => String(it?.str ?? '')).join('')
      parts.push(line)
    }
    return { text: parts.join('\n\n'), pages: doc.numPages }
  } finally {
    await doc.destroy().catch(() => undefined)
  }
}

/** 取发起请求的窗口（用于对话框的父窗口） */
function windowOf(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

export function registerPluginFilesIpc(): void {
  /** 选文件（返回绝对路径；同时把该文件加入该插件的授权范围） */
  ipcMain.handle('plugin:files:pick', async (event, payload: { id?: string; accept?: string; multiple?: boolean } = {}) => {
    try {
      const pluginId = readPluginId(payload)
      requireFsPermission(pluginId)
      const accept = String(payload?.accept ?? 'any')
      const filters =
        accept === 'pdf'
          ? [{ name: 'PDF', extensions: ['pdf'] }]
          : accept === 'text'
            ? [{ name: 'Text', extensions: ['txt', 'md', 'json', 'csv'] }]
            : [{ name: 'All Files', extensions: ['*'] }]
      const parent = windowOf(event)
      const result = parent
        ? await dialog.showOpenDialog(parent, { properties: payload?.multiple ? ['openFile', 'multiSelections'] : ['openFile'], filters })
        : await dialog.showOpenDialog({ properties: payload?.multiple ? ['openFile', 'multiSelections'] : ['openFile'], filters })
      if (result.canceled || !result.filePaths.length) return { cancelled: true, files: [] as Array<{ path: string; name: string; size: number }> }
      const files = []
      for (const filePath of result.filePaths) {
        addGrant(pluginId, filePath)
        const stat = await fs.stat(filePath).catch(() => null)
        files.push({ path: filePath, name: path.basename(filePath), size: stat ? stat.size : 0 })
      }
      return { cancelled: false, files }
    } catch (error) {
      throw asIpcError(error)
    }
  })

  /** 选文件夹（返回绝对路径；该文件夹及其子项进入授权范围） */
  ipcMain.handle('plugin:files:pick-dir', async (event, payload: { id?: string } = {}) => {
    try {
      const pluginId = readPluginId(payload)
      requireFsPermission(pluginId)
      const parent = windowOf(event)
      const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] }
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths.length) return { cancelled: true, dir: null }
      const dir = result.filePaths[0]
      addGrant(pluginId, dir)
      return { cancelled: false, dir: { path: dir, name: path.basename(dir) } }
    } catch (error) {
      throw asIpcError(error)
    }
  })

  /** 列目录（只列一层；需在授权范围内） */
  ipcMain.handle('plugin:files:list', async (_event, payload: { id?: string; path?: string } = {}) => {
    try {
      const pluginId = readPluginId(payload)
      requireFsPermission(pluginId)
      const dir = String(payload?.path ?? '').trim()
      if (!dir) throw new IPCError('INVALID_INPUT', '缺少目录路径')
      assertAllowed(pluginId, dir)
      const entries = await fs.readdir(dir, { withFileTypes: true })
      const rows = []
      for (const entry of entries.slice(0, 500)) {
        const full = path.join(dir, entry.name)
        const stat = await fs.stat(full).catch(() => null)
        rows.push({ name: entry.name, path: full, isDir: entry.isDirectory(), size: stat ? stat.size : 0 })
      }
      rows.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
      return { dir, entries: rows }
    } catch (error) {
      throw asIpcError(error)
    }
  })

  /** 读文本（PDF 会自动走文本提取） */
  ipcMain.handle('plugin:files:read-text', async (_event, payload: { id?: string; path?: string; maxBytes?: number } = {}) => {
    try {
      const pluginId = readPluginId(payload)
      requireFsPermission(pluginId)
      const filePath = String(payload?.path ?? '').trim()
      if (!filePath) throw new IPCError('INVALID_INPUT', '缺少文件路径')
      assertAllowed(pluginId, filePath)
      const buffer = await fs.readFile(filePath)
      if (/\.pdf$/i.test(filePath)) {
        const parsed = await readPdfText(buffer)
        return { path: filePath, text: parsed.text, pages: parsed.pages, pdf: true }
      }
      const max = Math.max(1024, Math.min(Number(payload?.maxBytes) || 200_000, 2_000_000))
      return { path: filePath, text: buffer.subarray(0, max).toString('utf8'), pages: 0, pdf: false }
    } catch (error) {
      throw asIpcError(error)
    }
  })

  /** 读二进制（base64，给渲染层的 pdfjs 渲染页面用） */
  ipcMain.handle('plugin:files:read-base64', async (_event, payload: { id?: string; path?: string; maxBytes?: number } = {}) => {
    try {
      const pluginId = readPluginId(payload)
      requireFsPermission(pluginId)
      const filePath = String(payload?.path ?? '').trim()
      if (!filePath) throw new IPCError('INVALID_INPUT', '缺少文件路径')
      assertAllowed(pluginId, filePath)
      const stat = await fs.stat(filePath)
      const max = Math.max(1024, Math.min(Number(payload?.maxBytes) || 40 * 1024 * 1024, 80 * 1024 * 1024))
      if (stat.size > max) throw new IPCError('PLUGIN_FILES_TOO_LARGE', `文件过大：${Math.round(stat.size / 1024 / 1024)}MB（上限 ${Math.round(max / 1024 / 1024)}MB）`)
      const buffer = await fs.readFile(filePath)
      return { path: filePath, base64: buffer.toString('base64'), size: stat.size }
    } catch (error) {
      throw asIpcError(error)
    }
  })

  /**
   * 读表格（.xlsx / .xls / .csv → 每个工作表的表头 + 数据行）。
   *
   * 为什么需要它：插件界面半边是单文件 ESM、不能 import SheetJS，`readText` 对 xlsx 只会返回
   * 二进制乱码；于是「读 Excel 画图」这类插件只能靠臆造 API（`ctx.files.readFile` / 调 office MCP）
   * 而必然失败。这里复用主进程既有的 SheetJS（`read_file` 提取 Excel 用的同一套），
   * 让「读表格」成为一条正经能力；权限与授权范围仍走 fs 权限 + 用户亲自选过的路径。
   */
  ipcMain.handle('plugin:files:read-sheet', async (_event, payload: { id?: string; path?: string; maxRows?: number; maxSheets?: number } = {}) => {
    try {
      const pluginId = readPluginId(payload)
      requireFsPermission(pluginId)
      const filePath = String(payload?.path ?? '').trim()
      if (!filePath) throw new IPCError('INVALID_INPUT', '缺少文件路径')
      assertAllowed(pluginId, filePath)
      if (!/\.(xlsx|xls|csv)$/i.test(filePath)) {
        throw new IPCError('INVALID_INPUT', '仅支持 .xlsx / .xls / .csv（其它格式请用 readText）')
      }
      const stat = await fs.stat(filePath)
      if (stat.size > SHEET_MAX_BYTES) {
        throw new IPCError('PLUGIN_FILES_TOO_LARGE', `表格过大：${Math.round(stat.size / 1024 / 1024)}MB（上限 ${Math.round(SHEET_MAX_BYTES / 1024 / 1024)}MB）`)
      }
      const maxRows = Math.max(10, Math.min(Number(payload?.maxRows) || SHEET_MAX_ROWS, SHEET_MAX_ROWS))
      const maxSheets = Math.max(1, Math.min(Number(payload?.maxSheets) || SHEET_MAX_SHEETS, SHEET_MAX_SHEETS))
      const workbook = xlsx.read(await fs.readFile(filePath), { type: 'buffer' })
      const names = workbook.SheetNames.slice(0, maxSheets)
      const sheets = names.map((name) => {
        const worksheet = workbook.Sheets[name]
        const grid = worksheet ? (xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: '', blankrows: false }) as unknown[][]) : []
        const header = (Array.isArray(grid[0]) ? grid[0] : []).slice(0, SHEET_MAX_COLS).map((v) => String(v ?? '').trim())
        const body = grid
          .slice(1, maxRows + 1)
          .map((row) => (Array.isArray(row) ? row.slice(0, SHEET_MAX_COLS) : []))
        return { name, headers: header, rows: body, truncated: grid.length - 1 > maxRows }
      })
      return { path: filePath, sheets, sheetCount: workbook.SheetNames.length }
    } catch (error) {
      throw asIpcError(error)
    }
  })

  /**
   * 列出某个插件记住的文件授权（设置 → 插件 → 数据 里显示）。
   * 只读，不需要 fs 权限（停用的插件也要能看到并撤销它记住的路径）。
   */
  ipcMain.handle('plugin:files:grants', (_event, payload: { id?: string } = {}) => {
    const pluginId = readPluginId(payload)
    if (!pluginHost.list().some((p) => p.id === pluginId)) {
      throw new IPCError('PLUGIN_NOT_FOUND', `插件不存在：${pluginId}`)
    }
    return { id: pluginId, entries: listGrants(pluginId) }
  })

  /** 撤销一条授权（撤销是「收回权限」，但仍要求用户确认，避免插件偷偷改别人的授权） */
  ipcMain.handle('plugin:files:revoke-grant', (_event, payload: { id?: string; path?: string; confirm?: boolean } = {}) => {
    const pluginId = readPluginId(payload)
    const target = String(payload?.path ?? '').trim()
    if (!target) throw new IPCError('INVALID_INPUT', '缺少路径')
    requirePluginApproval(payload, `撤销插件 ${pluginId} 的文件授权`)
    return { removed: revokeGrant(pluginId, target) }
  })

  /** 清掉某个插件的全部授权（用户确认后） */
  ipcMain.handle('plugin:files:clear-grants', (_event, payload: { id?: string; confirm?: boolean } = {}) => {
    const pluginId = readPluginId(payload)
    requirePluginApproval(payload, `清除插件 ${pluginId} 的全部文件授权`)
    return { removed: clearGrants(pluginId) }
  })
}
