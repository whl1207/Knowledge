/**
 * fileViewers.ts — 文件查看器契约（插件与宿主共用）
 *
 * 一个查看器只声明「我能打开哪些扩展名」，不直接拿文件系统权限：
 * 宿主解析出查看器后，通过 FileViewerHost 读取当前文件，再把受限上下文交给插件组件。
 *
 * 与 `knowFile/fileViews.ts` 的区别：
 *  - fileViews 是同一个文件窗口里的「浏览 / 编辑 / 导图」等视图模式；
 *  - fileViewers 是「这个扩展名交给谁打开」，可以来自内置，也可以来自插件。
 */

export type FileViewerSurface = 'knowledge' | 'dock' | 'window'
export type FileViewerLoading = 'text' | 'bytes'

/** 清单里声明的查看器元数据（不含 component；component 由 file.viewer 槽位提供） */
export interface FileViewerDecl {
  /** 全局唯一 id，建议 `<plugin-id>.<name>` */
  id: string
  /** 小写扩展名，如 ['.foo'] */
  extensions: string[]
  titleZh: string
  titleEn: string
  icon?: string
  /** 出现在哪些入口；缺省 = 三个入口都可用 */
  surfaces?: FileViewerSurface[]
  /** 越大越优先；缺省 100 */
  priority?: number
  /** 读取方式；缺省 text */
  loading?: FileViewerLoading
  /** 是否允许保存（默认 false，只读） */
  write?: boolean
}

export const FILE_VIEWER_SURFACES: readonly FileViewerSurface[] = ['knowledge', 'dock', 'window']

export function isFileViewerSurface(v: unknown): v is FileViewerSurface {
  return v === 'knowledge' || v === 'dock' || v === 'window'
}

/** 规范化扩展名：去空白、转小写、补前导点 */
export function normalizeViewerExtension(v: unknown): string {
  const s = String(v || '').trim().toLowerCase()
  if (!s) return ''
  return s.startsWith('.') ? s : `.${s}`
}

/** 取文件路径的小写扩展名（不含点后的 query/hash） */
export function fileExtensionOf(filePath: unknown): string {
  const p = String(filePath || '').split(/[?#]/)[0].replace(/\\/g, '/')
  const base = p.split('/').pop() || ''
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(dot).toLowerCase() : ''
}

export function viewerSurfacesOf(def: FileViewerDecl): FileViewerSurface[] {
  const list = Array.isArray(def.surfaces) ? def.surfaces.filter(isFileViewerSurface) : []
  return list.length ? list : [...FILE_VIEWER_SURFACES]
}

/** 校验并规范化清单里的查看器声明；失败返回带可读问题的结果 */
export function normalizeFileViewerDecl(input: unknown, pluginId: string): { ok: true; def: FileViewerDecl } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'fileViewers 条目必须是对象' }
  const raw = input as Record<string, unknown>
  const rawId = String(raw.id || '').trim()
  if (!rawId) return { ok: false, error: 'fileViewers[].id 必填' }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(rawId)) return { ok: false, error: `fileViewers[].id 非法：${rawId}` }
  const id = rawId.includes('.') ? rawId : `${pluginId}.${rawId}`
  const extensions = Array.isArray(raw.extensions)
    ? [...new Set(raw.extensions.map(normalizeViewerExtension).filter(Boolean))]
    : []
  if (!extensions.length) return { ok: false, error: `查看器 ${id} 至少需要一个扩展名` }
  const titleZh = String(raw.titleZh || raw.title || '').trim()
  const titleEn = String(raw.titleEn || raw.title || titleZh).trim()
  if (!titleZh && !titleEn) return { ok: false, error: `查看器 ${id} 缺少标题` }
  const surfaces = Array.isArray(raw.surfaces)
    ? [...new Set(raw.surfaces.filter(isFileViewerSurface))]
    : []
  if (Array.isArray(raw.surfaces) && raw.surfaces.length && !surfaces.length) {
    return { ok: false, error: `查看器 ${id} 的 surfaces 不合法` }
  }
  const loading = raw.loading === 'bytes' ? 'bytes' : 'text'
  const priority = Number(raw.priority)
  return {
    ok: true,
    def: {
      id,
      extensions,
      titleZh: titleZh || titleEn,
      titleEn: titleEn || titleZh,
      icon: String(raw.icon || 'fa-file-o'),
      surfaces: surfaces.length ? surfaces : [...FILE_VIEWER_SURFACES],
      priority: Number.isFinite(priority) ? Math.round(priority) : 100,
      loading,
      write: raw.write === true,
    },
  }
}
