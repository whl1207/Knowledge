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
  /** 列目录（一层） */
  list(dir: string): Promise<{ dir: string; entries: PluginDirEntry[] }>
  /** 读文本（.pdf 自动走 PDF 文本提取，返回 pages） */
  readText(path: string, options?: { maxBytes?: number }): Promise<PluginReadTextResult>
  /** 读二进制（base64；图片 / 压缩包等自定义解析用，上限 40MB） */
  readBase64(path: string, options?: { maxBytes?: number }): Promise<{ path: string; base64: string; size: number }>
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
  const api = typeof window !== 'undefined' ? (window as any).dsh?.plugin?.files : null
  if (!api) throw new Error('插件文件能力不可用（仅桌面版提供）')
  return api
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
  const reason = deps.permitted
    ? ''
    : `插件 ${deps.pluginId} 未声明 "fs" 权限（package.json 的 aikm.permissions 加 "fs"，然后在插件页重载）`

  const guard = (): void => {
    if (!deps.permitted) throw new Error(reason)
  }

  const loadPdf = async (path: string): Promise<{ data: Uint8Array; doc: any }> => {
    const key = `${deps.pluginId}\u0000${path}`
    const cached = pdfCache.get(key)
    if (cached) return cached
    const task = (async () => {
      const res = await ipc().readBase64({ id: deps.pluginId, path })
      const base64 = String(res?.base64 ?? '')
      if (!base64) throw new Error('读取 PDF 失败：主进程返回空内容（文件可能过大或已被移动/删除）')
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
      return deps.permitted
    },
    get reason() {
      return reason
    },

    async pickFiles(options) {
      guard()
      return ipc().pick({ id: deps.pluginId, accept: options?.accept ?? 'any', multiple: options?.multiple === true })
    },

    async pickDirectory() {
      guard()
      return ipc().pickDirectory({ id: deps.pluginId })
    },

    async list(dir) {
      guard()
      return ipc().list({ id: deps.pluginId, path: dir })
    },

    async readText(filePath, options) {
      guard()
      return ipc().readText({ id: deps.pluginId, path: filePath, maxBytes: options?.maxBytes })
    },

    async readBase64(filePath, options) {
      guard()
      return ipc().readBase64({ id: deps.pluginId, path: filePath, maxBytes: options?.maxBytes })
    },

    async readSheet(filePath, options) {
      guard()
      return ipc().readSheet({
        id: deps.pluginId,
        path: filePath,
        maxRows: options?.maxRows,
        maxSheets: options?.maxSheets,
      })
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
      const invoke = (window as any).ipcRenderer?.invoke
      if (typeof invoke !== 'function') throw new Error('仅桌面版支持在应用内置查看器中打开文件')
      await invoke('open-file-window', { path: filePath, view: view || 'read' })
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
