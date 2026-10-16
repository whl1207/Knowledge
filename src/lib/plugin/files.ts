/**
 * files.ts — 渲染层「插件文件服务」（插件上下文里的 `ctx.files`）
 *
 * 拆两层：
 * - **主进程**（electron/main/plugin-files.ts）负责对话框、目录列举、读文本、PDF 文本提取；
 * - **本层**负责把 PDF **渲染成图片**（用应用自带的 pdfjs + canvas），这样插件面板里能直接
 *   显示合同页面预览——不需要 Chromium 内置 PDF 查看器（Electron 主窗口未开 plugins:true）。
 *
 * 权限：清单声明 `fs` 才能用；主进程另有「只能访问用户在该插件里选过的路径」的授权范围校验，
 * 而且这份授权会落盘（选一次就记住，重启后仍然有效；用户可在「插件 → 数据」里撤销）。
 */

import * as pdfjsLib from 'pdfjs-dist'
import { PDFJS_RUNTIME_OPTIONS } from '@/lib/pdfjs'
import { getPlatform, hasCapability } from '@/platform'
import { aikmDsh } from '@/lib/aikmIpc'

export interface PluginPickedFile {
  path: string
  name: string
  size: number
}

export interface PluginDirEntry {
  name: string
  path: string
  isDir: boolean
  size: number
}

export interface PluginPickedDir {
  path: string
  name: string
}

export interface PluginReadTextResult {
  path: string
  text: string
  pages: number
  pdf: boolean
}

export interface PluginPdfPageResult {
  page: number
  pageCount: number
  width: number
  height: number
  /** PNG data URL，可直接塞进 <img> */
  dataUrl: string
}

export interface PluginSheetResult {
  path: string
  /** 文件里实际有几个工作表（可能多于返回的 sheets，见 maxSheets） */
  sheetCount: number
  sheets: Array<{ name: string; headers: string[]; rows: unknown[][]; truncated: boolean }>
}

export interface PluginFilesApi {
  readonly available: boolean
  readonly reason: string
  /** 打开系统文件选择框（返回绝对路径；文件名/大小一并给出） */
  pickFiles(options?: { accept?: 'pdf' | 'text' | 'any'; multiple?: boolean }): Promise<{ cancelled: boolean; files: PluginPickedFile[] }>
  /** 打开文件夹选择框（法规库这类用途） */
  pickDirectory(): Promise<{ cancelled: boolean; dir: PluginPickedDir | null }>
  /**
   * 选一个**可写**文件夹 —— 这是"能写文件"的**唯一来源**。
   *
   * 用户亲手点（对话框标题与按钮都写明这是允许写入），授权落在主进程、跨重启有效，
   * 可在「设置 → 插件 → 数据」里看到模式并撤销。同一个目录先以只读选过、再这样选一次
   * 会**升级为可写**（反之不会降级 —— 要降级就先撤销再选）。
   *
   * 仅桌面端：网页 / 移动端没有主进程授权存储，调用会抛错（不会假装"用户取消了"）。
   */
  pickWritableDirectory(options?: { title?: string }): Promise<{ cancelled: boolean; dir: PluginPickedDir | null }>
  /**
   * 写文本（覆盖式；父目录会自动创建）。**只能在"可写"授权目录内**。
   *
   * - 只读授权下写入会被拒绝，错误里会说明"该路径是以只读方式授权的"；
   * - 授权范围之外（含兄弟目录、写死的绝对路径）一律拒绝；
   * - 返回实际写入的绝对路径与字节数。
   */
  writeText(path: string, text: string): Promise<{ path: string; bytes: number }>
  /**
   * 删除文件 / **空**目录（只认可写授权）。
   *
   * 刻意**不做递归删除**：要清掉一棵子树请逐层删 —— 一句调用带走用户整个授权目录太危险。
   * 目录非空时会抛错。
   */
  remove(path: string): Promise<{ removed: boolean; missing?: boolean }>
  /** 列目录（一层） */
  list(dir: string): Promise<{ dir: string; entries: PluginDirEntry[] }>
  /** 读文本（.pdf 自动走 PDF 文本提取，返回 pages） */
  readText(path: string, options?: { maxBytes?: number }): Promise<PluginReadTextResult>
  /** 读二进制（base64；图片 / 压缩包等自定义解析用，上限 40MB） */
  readBase64(path: string, options?: { maxBytes?: number }): Promise<{ path: string; base64: string; size: number }>
  /**
   * 读二进制（**直接给字节**，不经过 base64）。
   *
   * 大文件（几十 MB 的 ROM / 模型）用它在手机上快得多：base64 会把体积撑大 1/3，
   * 而且要在 JS 里编码 + 解码各跑一遍（33MB → 44MB 字符串 → 再解回 33MB，既慢又吃内存）。
   * 上限与 readBase64 相同（默认 40MB）。
   */
  readBytes(path: string, options?: { maxBytes?: number }): Promise<{ path: string; bytes: Uint8Array; size: number }>
  /**
   * 读表格（.xlsx / .xls / .csv → 每个工作表的表头 + 数据行；上限 32MB / 2 万行 / 20 个工作表）。
   * 界面半边拿不到 SheetJS，读表格请用它，不要自己解析二进制。
   */
  readSheet(path: string, options?: { maxRows?: number; maxSheets?: number }): Promise<PluginSheetResult>
  /** 把 PDF 的某一页渲染成 PNG data URL（视觉预览） */
  renderPdfPage(path: string, options?: { page?: number; scale?: number; maxWidth?: number }): Promise<PluginPdfPageResult>
  /** 用应用内置查看器打开文件（独立窗口；Markdown / PDF 等走各自视图） */
  openInApp(path: string, view?: string): Promise<void>
}

interface FilesApiDeps {
  pluginId: string
  permitted: boolean
  log: { warn(...args: unknown[]): void; info(...args: unknown[]): void }
}

/** 每个 PDF 只取一次字节流（渲染多页时复用），用 WeakMap 关联「插件 + 路径」 */
const pdfCache = new Map<string, Promise<{ data: Uint8Array; doc: any }>>()

function ipc(): any {
  const api = typeof window !== 'undefined' ? aikmDsh?.plugin?.files : null
  if (!api) throw new Error('插件文件能力不可用（仅桌面版提供）')
  return api
}

/**
 * 平台后端（非 Electron）：用平台能力层直接读写手机 / 网页端能访问的文件。
 * - 选择文件：安卓走系统选择器（DocPicker，返回 content:// uri）；有原生对话框的平台走 dialog.pickFiles
 * - 选择目录：dialog.pickDirectory（安卓 = SAF 目录授权，返回 `saf:<名字>`）
 * - 列目录 / 读文本 / 读二进制：平台 fs（SAF 授权目录与沙箱都支持）
 * - 读表格：暂不支持（需要桌面版的 SheetJS 解析）
 */
function platformAvailable(): boolean {
  try {
    return getPlatform().kind !== 'browser'
  } catch {
    return false
  }
}

/** 桌面（Electron）由主进程提供插件文件服务；其它平台走渲染层平台实现 */
function hasHostFiles(): boolean {
  return typeof window !== 'undefined' && !!aikmDsh?.plugin?.files
}

function acceptToMime(accept: string): string {
  if (accept === 'pdf') return 'application/pdf'
  if (accept === 'text') return 'text/*'
  return '*/*'
}

function base64FromBytes(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function bytesFromBase64(base64: string): Uint8Array {
  const bin = atob(base64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function platformPickFiles(payload: { accept: string; multiple: boolean }) {
  const platform = getPlatform()
  if (platform.kind === 'android') {
    const { createDocumentsAdapter } = await import('@/platform/android/documents')
    const docs = createDocumentsAdapter()
    const files = await docs.pickFiles({ multiple: payload.multiple, mime: acceptToMime(payload.accept) })
    return {
      cancelled: files.length === 0,
      files: files.map((f) => ({ path: f.uri, name: f.name, size: Number(f.size) || 0 })),
    }
  }
  if (hasCapability('dialog.native')) {
    const picked = payload.multiple ? await platform.dialog.pickFiles() : [await platform.dialog.pickFile()]
    const files = picked.filter(Boolean).map((p: any) => ({ path: String(p.path || p), name: String(p.name || ''), size: Number(p.size) || 0 }))
    return { cancelled: files.length === 0, files }
  }
  throw new Error('当前平台不支持选择文件（可在「打开文件夹」授权目录后读取其中的文件）')
}

async function platformReadBase64(path: string, maxBytes?: number): Promise<{ path: string; base64: string; size: number }> {
  if (/^content:\/\//i.test(path)) {
    const { createDocumentsAdapter } = await import('@/platform/android/documents')
    const r = await createDocumentsAdapter().readBase64(path, maxBytes)
    return { path, base64: r.base64, size: r.size }
  }
  const bytes = await getPlatform().fs.readBinary(path)
  if (!bytes) throw new Error(`读取失败：${path}`)
  const limited = maxBytes && maxBytes > 0 && bytes.length > maxBytes ? bytes.subarray(0, maxBytes) : bytes
  return { path, base64: base64FromBytes(limited), size: limited.length }
}

async function platformReadText(path: string, maxBytes?: number): Promise<{ path: string; text: string; pages: number; pdf: boolean }> {
  if (/^content:\/\//i.test(path)) {
    const { createDocumentsAdapter } = await import('@/platform/android/documents')
    const docs = createDocumentsAdapter()
    const info = await docs.stat(path)
    const isPdf = /pdf/i.test(info?.mime || '') || /\.pdf$/i.test(info?.name || '')
    if (isPdf) {
      const r = await docs.readBase64(path, maxBytes)
      const parsed = await extractPdfText(bytesFromBase64(r.base64))
      return { path, text: parsed.text, pages: parsed.pages, pdf: true }
    }
    const text = await docs.readText(path, maxBytes)
    return { path, text, pages: 1, pdf: false }
  }
  const raw = await readTextRaw(path)
  if (/\.pdf$/i.test(path)) {
    const bytes = await getPlatform().fs.readBinary(path)
    if (!bytes) throw new Error(`读取失败：${path}`)
    const parsed = await extractPdfText(bytes)
    return { path, text: parsed.text, pages: parsed.pages, pdf: true }
  }
  return { path, text: raw, pages: 1, pdf: false }
}

/** 平台 fs 读文本（不走主进度前缀约定：插件侧统一用异常表达失败） */
async function readTextRaw(path: string): Promise<string> {
  const text = await getPlatform().fs.readText(path)
  if (typeof text !== 'string' || text.startsWith('Error reading file')) throw new Error(`读取失败：${path}`)
  return text
}

/** 用应用自带的 pdf.js 抽取 PDF 文本（平台后端用；与主进程实现口径一致：按页拼接） */
async function extractPdfText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  let doc: any
  try {
    doc = await pdfjsLib.getDocument({ data: bytes, ...PDFJS_RUNTIME_OPTIONS }).promise
  } catch (e) {
    throw new Error(`解析 PDF 失败：${describeError(e)}`)
  }
  const pages = Number(doc?.numPages) || 0
  const parts: string[] = []
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    parts.push((content?.items || []).map((it: any) => String(it?.str ?? '')).join(' '))
  }
  return { text: parts.join('\n'), pages }
}

/** 把任意异常转成可读文本（pdf.js / DOMException / Electron IPC 错误形状各异） */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (error && typeof error === 'object') {
    const shaped = error as { name?: unknown; message?: unknown; reason?: unknown }
    const parts = [shaped.name, shaped.message].filter((v) => typeof v === 'string' && v)
    if (parts.length) return parts.join(': ')
    try {
      const json = JSON.stringify(error)
      if (json && json !== '{}') return json
    } catch {
      /* 忽略 */
    }
    return String(error)
  }
  return String(error)
}

export function createPluginFilesApi(deps: FilesApiDeps): PluginFilesApi {
  const hostFiles = hasHostFiles()
  const platformOk = !hostFiles && platformAvailable()
  const reason = !deps.permitted
    ? `插件 ${deps.pluginId} 未声明 "fs" 权限（package.json 的 aikm.permissions 加 "fs"，然后在插件页重载）`
    : !hostFiles && !platformOk
      ? '当前环境不提供文件读取能力（手机版请用系统选择器授权后再读）'
      : ''

  const guard = (): void => {
    if (!deps.permitted) throw new Error(`插件 ${deps.pluginId} 未声明 "fs" 权限（package.json 的 aikm.permissions 加 "fs"，然后在插件页重载）`)
    if (!hostFiles && !platformOk) throw new Error('当前环境不提供文件读取能力')
  }

  const loadPdf = async (path: string): Promise<{ data: Uint8Array; doc: any }> => {
    const key = `${deps.pluginId}\u0000${path}`
    const cached = pdfCache.get(key)
    if (cached) return cached
    const task = (async () => {
      const res = hasHostFiles()
        ? await ipc().readBase64({ id: deps.pluginId, path })
        : await platformReadBase64(path)
      const base64 = String(res?.base64 ?? '')
      if (!base64) throw new Error('读取 PDF 失败：返回空内容（文件可能过大或已被移动/删除）')
      const binary = atob(base64)
      const data = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i)
      // pdf.js 的报错有时是普通对象（无 message），这里统一转成人能看懂的一句话
      let doc: any
      try {
        doc = await pdfjsLib.getDocument({ data, ...PDFJS_RUNTIME_OPTIONS }).promise
      } catch (e) {
        throw new Error(`解析 PDF 失败：${describeError(e)}`)
      }
      if (!doc || !doc.numPages) throw new Error('解析 PDF 失败：文档没有页面')
      return { data, doc }
    })()
    pdfCache.set(key, task)
    task.catch(() => pdfCache.delete(key))
    return task
  }

  return {
    get available() {
      return deps.permitted && (hostFiles || platformOk)
    },
    get reason() {
      return reason
    },

    async pickFiles(options) {
      guard()
      const accept = options?.accept ?? 'any'
      const multiple = options?.multiple === true
      if (typeof window !== 'undefined' && aikmDsh?.plugin?.files) {
        return ipc().pick({ id: deps.pluginId, accept, multiple })
      }
      return platformPickFiles({ accept, multiple })
    },

    async pickDirectory() {
      guard()
      if (typeof window !== 'undefined' && aikmDsh?.plugin?.files) {
        return ipc().pickDirectory({ id: deps.pluginId })
      }
      const dir = await getPlatform().dialog.pickDirectory()
      if (!dir) return { cancelled: true, dir: null }
      const name = String(dir).replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean).pop() || String(dir)
      return { cancelled: false, dir: { path: dir, name } }
    },

    async pickWritableDirectory(options) {
      guard()
      if (!(typeof window !== 'undefined' && aikmDsh?.plugin?.files)) {
        throw new Error('当前平台不支持可写文件夹授权（授权由桌面端主进程保存；安卓 / 网页端请改用 OPFS 或平台文件能力）')
      }
      return ipc().pickWritableDirectory({ id: deps.pluginId, ...(options?.title ? { title: options.title } : {}) })
    },

    async writeText(path, text) {
      guard()
      if (!(typeof window !== 'undefined' && aikmDsh?.plugin?.files)) {
        throw new Error('当前平台不支持写文件（需要桌面端）')
      }
      if (typeof text !== 'string') throw new Error('ctx.files.writeText(path, text) 的 text 必须是字符串')
      return ipc().writeText({ id: deps.pluginId, path, text })
    },

    async remove(path) {
      guard()
      if (!(typeof window !== 'undefined' && aikmDsh?.plugin?.files)) {
        throw new Error('当前平台不支持删除文件（需要桌面端）')
      }
      return ipc().remove({ id: deps.pluginId, path })
    },

    async list(dir) {
      guard()
      if (typeof window !== 'undefined' && aikmDsh?.plugin?.files) {
        return ipc().list({ id: deps.pluginId, path: dir })
      }
      const nodes = await getPlatform().fs.listTree(dir, 1)
      const entries: PluginDirEntry[] = (nodes || []).map((n: any) => ({
        name: String(n.label || n.path || '').replace(/\\/g, '/').split('/').pop() || '',
        path: String(n.path || ''),
        isDir: n.type === 'folder',
        size: Number(n.size) || 0,
      }))
      return { dir, entries }
    },

    async readText(filePath, options) {
      guard()
      if (typeof window !== 'undefined' && aikmDsh?.plugin?.files) {
        return ipc().readText({ id: deps.pluginId, path: filePath, maxBytes: options?.maxBytes })
      }
      return platformReadText(filePath, options?.maxBytes)
    },

    async readBase64(filePath, options) {
      guard()
      if (typeof window !== 'undefined' && aikmDsh?.plugin?.files) {
        return ipc().readBase64({ id: deps.pluginId, path: filePath, maxBytes: options?.maxBytes })
      }
      return platformReadBase64(filePath, options?.maxBytes)
    },

    async readBytes(filePath, options) {
      guard()
      const maxBytes = options?.maxBytes ?? 40 * 1024 * 1024
      if (typeof window !== 'undefined' && aikmDsh?.plugin?.files) {
        // 桌面：主进程给的仍是 base64（IPC 形状不变），这里就地解成字节
        const res = await ipc().readBase64({ id: deps.pluginId, path: filePath, maxBytes: options?.maxBytes })
        const b64 = String(res?.base64 ?? '')
        return { path: String(res?.path ?? filePath), bytes: bytesFromBase64(b64), size: Number(res?.size) || 0 }
      }
      // 安卓 / 网页：平台层直接给字节（安卓走本地服务器 fetch，不经过 base64）
      const bytes = await getPlatform().fs.readBinary(filePath)
      if (!bytes) throw new Error(`读取失败：${filePath}`)
      const limited = bytes.length > maxBytes ? bytes.subarray(0, maxBytes) : bytes
      return { path: filePath, bytes: limited, size: limited.length }
    },

    async readSheet(filePath, options) {
      guard()
      void options
      if (typeof window !== 'undefined' && aikmDsh?.plugin?.files) {
        return ipc().readSheet({
          id: deps.pluginId,
          path: filePath,
          maxRows: options?.maxRows,
          maxSheets: options?.maxSheets,
        })
      }
      throw new Error('当前平台暂不支持读取表格（Excel / CSV 解析需要桌面版）')
    },

    async renderPdfPage(filePath, options) {
      guard()
      try {
        const { doc } = await loadPdf(filePath)
        const pageCount = Number(doc.numPages) || 0
        const pageNumber = Math.min(Math.max(1, Math.round(Number(options?.page) || 1)), Math.max(1, pageCount))
        const page = await doc.getPage(pageNumber)
        let scale = Math.max(0.2, Math.min(Number(options?.scale) || 1.1, 3))
        let viewport = page.getViewport({ scale })
        const maxWidth = Math.max(240, Math.min(Number(options?.maxWidth) || 900, 2400))
        if (viewport.width > maxWidth) {
          scale = scale * (maxWidth / viewport.width)
          viewport = page.getViewport({ scale })
        }
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.floor(viewport.width))
        canvas.height = Math.max(1, Math.floor(viewport.height))
        const context = canvas.getContext('2d')
        if (!context) throw new Error('无法创建画布上下文（PDF 预览失败）')
        await page.render({ canvasContext: context, viewport }).promise
        return {
          page: pageNumber,
          pageCount,
          width: canvas.width,
          height: canvas.height,
          dataUrl: canvas.toDataURL('image/png'),
        }
      } catch (e) {
        deps.log.warn(`渲染 PDF 页面失败：${describeError(e)}`)
        throw new Error(`渲染 PDF 页面失败：${describeError(e)}`)
      }
    },

    async openInApp(filePath, view) {
      guard()
      // 桌面 = 独立窗口；安卓 / 网页端 = 应用内浮层（FileWindow overlay），由 store 决定
      if (getPlatform().kind === 'browser') throw new Error('当前环境不支持在应用内置查看器中打开文件')
      await getPlatform().window.openFileWindow({ path: filePath, view: view || 'read' })
    },
  }
}

/** 释放某插件的 PDF 缓存（插件卸载时由 runtime 调用） */
export function releasePluginPdfCache(pluginId: string): void {
  const prefix = `${pluginId}\u0000`
  for (const key of Array.from(pdfCache.keys())) {
    if (!key.startsWith(prefix)) continue
    const task = pdfCache.get(key)
    pdfCache.delete(key)
    void task?.then((entry) => entry?.doc?.destroy?.()).catch(() => undefined)
  }
}
