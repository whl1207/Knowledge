/**
 * fileViewers.ts — 已加载插件的文件查看器注册表（渲染层）
 *
 * 插件在 `apply(ctx)` 里先调用 `ctx.fileViewers.register(def)` 声明元数据，
 * 再把正文注册到 keyed slot `file.viewer`（key = def.id）。
 * 插件卸载时两个注册都由宿主自动撤销，registry 随之回落到内置查看器。
 */
import { reactive, computed } from 'vue'
import {
  fileExtensionOf,
  normalizeFileViewerDecl,
  viewerSurfacesOf,
  type FileViewerDecl,
  type FileViewerSurface,
} from '@/shared/fileViewers'

export interface LoadedFileViewer extends FileViewerDecl {
  pluginId: string
}

/** 已加载插件声明的查看器（reactive：插件热卸载后视图会立即重算） */
export const loadedFileViewers = reactive<LoadedFileViewer[]>([])

const dedupeId = (id: string): string => String(id || '').trim()

/**
 * 注册一个插件查看器。
 * 注意：这里只登记元数据；正文组件必须另行注册到 `file.viewer` 槽位。
 */
export function registerPluginFileViewer(pluginId: string, input: unknown): () => void {
  const checked = normalizeFileViewerDecl(input, pluginId)
  if (checked.ok === false) throw new Error(checked.error)
  const id = dedupeId(checked.def.id)
  if (loadedFileViewers.some((v) => v.id === id)) throw new Error(`文件查看器 id 重复：${id}`)
  const entry: LoadedFileViewer = { ...checked.def, pluginId }
  loadedFileViewers.push(entry)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    const i = loadedFileViewers.findIndex((v) => v.id === id)
    if (i !== -1) loadedFileViewers.splice(i, 1)
  }
}

/** 某插件已注册的查看器（插件卸载时由 disposer 清理） */
export function pluginFileViewersOf(pluginId: string): LoadedFileViewer[] {
  return loadedFileViewers.filter((v) => v.pluginId === pluginId)
}

/** 当前所有可用查看器（诊断 / 设置页） */
export function listLoadedFileViewers(): LoadedFileViewer[] {
  return [...loadedFileViewers]
}

/** 按路径与入口解析候选查看器：priority 降序，其次注册顺序；扩展名精确匹配 */
export function resolvePluginFileViewers(filePath: string, surface: FileViewerSurface = 'knowledge'): LoadedFileViewer[] {
  const ext = fileExtensionOf(filePath)
  if (!ext) return []
  const seen = new Set<string>()
  return loadedFileViewers
    .filter((v) => !!v.id && !seen.has(v.id) && v.extensions.includes(ext) && viewerSurfacesOf(v).includes(surface))
    .filter((v) => {
      // 同一 id 只保留第一条（防止极端重复注册）
      if (seen.has(v.id)) return false
      seen.add(v.id)
      return true
    })
    .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0))
}

export function hasPluginFileViewer(filePath: string, surface: FileViewerSurface = 'knowledge'): boolean {
  return resolvePluginFileViewers(filePath, surface).length > 0
}

/** 给 Vue 组件用的响应式候选列表（注册表变化时自动重算） */
export function usePluginFileViewers(filePath: () => string, surface: FileViewerSurface = 'knowledge') {
  return computed(() => resolvePluginFileViewers(filePath(), surface))
}

export type { FileViewerDecl, FileViewerSurface }
