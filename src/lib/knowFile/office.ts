/**
 * office.ts — Office 编辑器（内嵌 GenOffice 内核）的渲染层封装
 *
 * 与主进程 electron/main/office-host.ts 的通道约定：
 *   office:available → { editors: { docs, sheets, slides, pdf }, root }
 *   office:open      ← { path, rect }   → { ok, viewId, type }
 *   office:set-bounds← { viewId, rect }
 *   office:autosave  ← { viewId }
 *   office:close     ← { viewId }       → { ok, saved }（ok=false 表示用户取消了保存确认）
 *   office:refresh   ← { viewId }
 *   office:event     → { viewId, type, event: 'saved' | 'crashed', filePath }
 *
 * 渲染层只负责「占位元素的矩形」；编辑器是原生 WebContentsView，盖在占位区之上。
 */
import { isElectronRuntime } from '@/platform/electron'
import { aikmIpcOrNull } from '@/lib/aikmIpc'

export type OfficeEditorType = 'docs' | 'sheets' | 'slides'

/** 扩展名 → 编辑器类型（与主进程 office-host.ts 的 EXT_TO_TYPE 保持一致）
 *  PDF 不启用内嵌编辑器：继续使用 AI-KM 自己的 PdfViewer。 */
const EXT_TO_TYPE: Record<string, OfficeEditorType> = {
  '.docx': 'docs',
  '.xlsx': 'sheets',
  '.xlsm': 'sheets',
  '.pptx': 'slides',
}

/** 该路径是否可用内嵌 Office 编辑器；返回其编辑器类型 */
export function officeTypeForPath(filePath: string | null | undefined): OfficeEditorType | null {
  if (!filePath) return null
  const m = /(\.[^./\\]+)$/.exec(String(filePath).toLowerCase())
  return m ? EXT_TO_TYPE[m[1]] || null : null
}

export interface OfficeRect {
  x: number
  y: number
  width: number
  height: number
}

/** 取占位元素的矩形（CSS 像素，相对窗口内容区；主进程按缩放换算为 DIP） */
export function officeRectOf(el: HTMLElement | null): OfficeRect | null {
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (!r || r.width <= 0 || r.height <= 0) return null
  return { x: r.x, y: r.y, width: r.width, height: r.height }
}

export interface OfficeAvailability {
  editors: Record<OfficeEditorType, boolean>
  /** 已构建但缺运行依赖的原因（当前只有 Excel 的原生引擎 xlsx-sidecar） */
  issues?: Partial<Record<OfficeEditorType, string>>
  root?: string
  error?: string
}

let availabilityCache: Promise<OfficeAvailability> | null = null

/** 查询各类型编辑器是否已构建（进程内缓存；force 时重新查询） */
export function loadOfficeAvailability(force = false): Promise<OfficeAvailability> {
  const api = ipc()
  if (!api) return Promise.resolve({ editors: emptyAvailability(), error: 'not-electron' })
  if (!force && availabilityCache) return availabilityCache
  const pending = api
    .invoke('office:available')
    .then((res: any) => (res && res.editors ? (res as OfficeAvailability) : { editors: emptyAvailability() }))
    .catch((e: any) => ({ editors: emptyAvailability(), error: String(e?.message || e) }))
  availabilityCache = pending
  return pending
}

function emptyAvailability(): Record<OfficeEditorType, boolean> {
  return { docs: false, sheets: false, slides: false }
}

export interface OfficeOpenResult {
  ok: boolean
  viewId?: string
  type?: OfficeEditorType
  filePath?: string
  error?: string
}

export async function officeOpen(filePath: string, rect: OfficeRect | null): Promise<OfficeOpenResult> {
  const api = ipc()
  if (!api) return { ok: false, error: '当前环境不支持内嵌 Office 编辑器' }
  try {
    return (await api.invoke('office:open', { path: filePath, rect })) as OfficeOpenResult
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
}

export async function officeSetBounds(viewId: string, rect: OfficeRect | null): Promise<void> {
  const api = ipc()
  if (!api || !viewId || !rect) return
  try {
    await api.invoke('office:set-bounds', { viewId, rect })
  } catch {
    /* 视图可能已关闭 */
  }
}

/** 关闭前保存（不销毁视图） */
export async function officeAutosave(viewId: string): Promise<{ ok: boolean; saved: boolean }> {
  const api = ipc()
  if (!api || !viewId) return { ok: true, saved: false }
  try {
    return await api.invoke('office:autosave', { viewId })
  } catch {
    return { ok: false, saved: false }
  }
}

/** 关闭视图（脏则触发编辑器自己的保存/放弃/取消确认） */
export async function officeClose(viewId: string): Promise<{ ok: boolean; saved: boolean }> {
  const api = ipc()
  if (!api || !viewId) return { ok: true, saved: false }
  try {
    return await api.invoke('office:close', { viewId })
  } catch {
    return { ok: false, saved: false }
  }
}

/** 重新摆放/显示视图（视图切换回来、窗口尺寸变化后） */
export async function officeRefresh(viewId: string): Promise<void> {
  const api = ipc()
  if (!api || !viewId) return
  try {
    await api.invoke('office:refresh', { viewId })
  } catch {
    /* 视图可能已关闭 */
  }
}

/**
 * 临时隐藏/恢复编辑器视图。
 * 原生 WebContentsView 永远绘制在 DOM 之上，所以任何要覆盖到编辑器区域的浮层
 * （如文件窗口的「视图切换」下拉）都必须在打开时先隐藏视图，否则会被挡住。
 */
export async function officeSetVisible(viewId: string, visible: boolean): Promise<void> {
  const api = ipc()
  if (!api || !viewId) return
  try {
    await api.invoke('office:set-visible', { viewId, visible })
  } catch {
    /* 视图可能已关闭 */
  }
}

export interface OfficeEvent {
  viewId: string
  type: OfficeEditorType
  event: 'saved' | 'crashed' | string
  filePath?: string
}

/** 订阅编辑器事件；返回取消订阅函数 */
export function onOfficeEvent(handler: (e: OfficeEvent) => void): () => void {
  const api = ipc()
  if (!api || typeof api.on !== 'function') return () => {}
  const listener = (_e: unknown, payload: OfficeEvent) => {
    if (payload && payload.viewId) handler(payload)
  }
  api.on('office:event', listener)
  return () => {
    try {
      api.off?.('office:event', listener)
    } catch {
      /* 忽略 */
    }
  }
}

function ipc(): any {
  return typeof window !== 'undefined' ? aikmIpcOrNull() : undefined
}

export function isOfficeRuntime(): boolean {
  return isElectronRuntime()
}
