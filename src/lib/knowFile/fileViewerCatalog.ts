/**
 * fileViewerCatalog.ts — 面向设置页 / 视图菜单的「格式 → 查看器」目录。
 *
 * 内置查看器由这个文件描述（只用于展示与默认项解析）；
 * 插件查看器来自运行时注册表 loadedFileViewers。两边合成同一张表，
 * 设置页据此标注「内置」/「插件 · 插件 id」。
 */
import { computed } from 'vue'
import { fileExtensionOf, type FileViewerSurface } from '@/shared/fileViewers'
import { loadedFileViewers } from '@/lib/plugin/fileViewers'
import { fileViewByKey } from '@/lib/knowFile/fileViews'

export interface FileViewerView {
  key: string
  titleZh: string
  titleEn: string
  icon: string
}

export interface FileViewerCatalogEntry {
  /** 全局唯一 id；插件 id 可能含点 */
  id: string
  source: 'builtin' | 'plugin'
  pluginId?: string
  extensions: string[]
  titleZh: string
  titleEn: string
  icon: string
  /** 内置查看器对应的文件窗口视图 key（兼容旧调用）；完整视图列表见 views */
  viewKey?: string
  /** 这张表展示的「可选择视图」；插件查看器只有它自己 */
  views?: FileViewerView[]
  priority: number
  write?: boolean
  surfaces: FileViewerSurface[]
}

/** 每个内置格式在文件窗口里真正可选的视图（顺序与标题栏一致） */
const BUILTIN_VIEW_KEYS: Record<string, string[]> = {
  'builtin.markdown': ['read', 'edit', 'blockedit', 'mindmap', 'presentation'],
  'builtin.code': ['edit'],
  'builtin.text': ['read', 'edit'],
  'builtin.html': ['read', 'edit'],
  'builtin.table': ['read', 'edit'],
  'builtin.word': ['office', 'read', 'mindmap'],
  'builtin.doc': ['read'],
  'builtin.excel': ['office', 'read'],
  'builtin.pptx': ['office'],
  'builtin.pdf': ['read'],
  'builtin.image': ['read'],
  'builtin.media': ['read'],
  'builtin.mermaid': ['read', 'edit'],
  'builtin.drawio': ['read'],
  'builtin.excalidraw': ['read'],
  'builtin.flow': ['read'],
  'builtin.data': ['read'],
  'builtin.task': ['read'],
  'builtin.kb': ['read'],
}

const viewOf = (key: string): FileViewerView | null => {
  const def = fileViewByKey(key)
  return def ? { key, titleZh: def.name, titleEn: def.labelEn, icon: def.icon } : null
}
const builtinViews = (id: string, fallback?: string): FileViewerView[] => {
  const keys = BUILTIN_VIEW_KEYS[id] || (fallback ? [fallback] : [])
  return keys.map(viewOf).filter((v): v is FileViewerView => !!v)
}

const ALL: FileViewerSurface[] = ['knowledge', 'dock', 'window']

/** 内置查看器：按「格式族」归组，和 FileWindow 的实际默认视图保持一致 */
export const BUILTIN_FILE_VIEWERS: FileViewerCatalogEntry[] = [
  { id: 'builtin.markdown', source: 'builtin', extensions: ['.md', '.markdown', '.mdown', '.mkd'], titleZh: 'Markdown 浏览', titleEn: 'Markdown', icon: 'fa-file-text-o', viewKey: 'read', priority: 50, surfaces: ALL },
  { id: 'builtin.code', source: 'builtin', extensions: ['.js', '.jsx', '.ts', '.tsx', '.vue', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.rb', '.sh', '.sql', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.xml', '.ini', '.conf', '.env', '.css', '.scss', '.less'], titleZh: '其他源码', titleEn: 'Other source', icon: 'fa-file-code-o', viewKey: 'edit', priority: 50, surfaces: ALL },
  { id: 'builtin.html', source: 'builtin', extensions: ['.html', '.htm'], titleZh: 'HTML 页面', titleEn: 'HTML', icon: 'fa-html5', viewKey: 'read', priority: 50, surfaces: ALL },
  { id: 'builtin.table', source: 'builtin', extensions: ['.csv', '.tsv'], titleZh: '表格文本', titleEn: 'Table', icon: 'fa-table', viewKey: 'read', priority: 50, surfaces: ALL },
  { id: 'builtin.text', source: 'builtin', extensions: ['.txt', '.log'], titleZh: '文本浏览', titleEn: 'Text', icon: 'fa-file-o', viewKey: 'read', priority: 50, surfaces: ALL },
  { id: 'builtin.word', source: 'builtin', extensions: ['.docx'], titleZh: 'Word 文档', titleEn: 'Word', icon: 'fa-file-word-o', viewKey: 'read', priority: 50, surfaces: ALL },
  { id: 'builtin.doc', source: 'builtin', extensions: ['.doc'], titleZh: 'Word 97-2003', titleEn: 'Word 97-2003', icon: 'fa-file-word-o', viewKey: 'read', priority: 50, surfaces: ALL },
  { id: 'builtin.excel', source: 'builtin', extensions: ['.xlsx', '.xlsm', '.xls'], titleZh: 'Excel 工作簿', titleEn: 'Excel', icon: 'fa-file-excel-o', viewKey: 'office', priority: 50, surfaces: ALL },
  { id: 'builtin.pptx', source: 'builtin', extensions: ['.pptx'], titleZh: 'PowerPoint 演示', titleEn: 'PowerPoint', icon: 'fa-file-powerpoint-o', viewKey: 'office', priority: 50, surfaces: ALL },
  { id: 'builtin.pdf', source: 'builtin', extensions: ['.pdf'], titleZh: 'PDF 预览', titleEn: 'PDF', icon: 'fa-file-pdf-o', viewKey: 'read', priority: 50, surfaces: ALL },
  { id: 'builtin.image', source: 'builtin', extensions: ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp', '.ico', '.tiff', '.tif'], titleZh: '图片预览', titleEn: 'Image', icon: 'fa-file-image-o', viewKey: 'read', priority: 50, surfaces: ALL },
  { id: 'builtin.media', source: 'builtin', extensions: ['.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv', '.m4v', '.3gp', '.mpg', '.mpeg', '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.opus', '.wma', '.ape', '.aiff'], titleZh: '音视频播放', titleEn: 'Media', icon: 'fa-file-video-o', viewKey: 'read', priority: 50, surfaces: ALL },
  { id: 'builtin.mermaid', source: 'builtin', extensions: ['.mmd', '.mermaid'], titleZh: 'Mermaid 图表', titleEn: 'Mermaid', icon: 'fa-share-alt', viewKey: 'read', priority: 50, surfaces: ALL },
  { id: 'builtin.drawio', source: 'builtin', extensions: ['.drawio', '.dio'], titleZh: 'draw.io 图表', titleEn: 'draw.io', icon: 'fa-project-diagram', viewKey: 'read', priority: 50, surfaces: ALL },
  { id: 'builtin.excalidraw', source: 'builtin', extensions: ['.excalidraw'], titleZh: 'Excalidraw 画布', titleEn: 'Excalidraw', icon: 'fa-pencil', viewKey: 'read', priority: 50, surfaces: ALL },
  { id: 'builtin.flow', source: 'builtin', extensions: ['.flow', '.workflow', '.flow.yml', '.flow.yaml'], titleZh: '工作流', titleEn: 'Workflow', icon: 'fa-sitemap', viewKey: 'read', priority: 50, surfaces: ALL },
  { id: 'builtin.data', source: 'builtin', extensions: ['.data'], titleZh: '数据画布', titleEn: 'Data canvas', icon: 'fa-table', viewKey: 'read', priority: 50, surfaces: ALL },
  { id: 'builtin.task', source: 'builtin', extensions: ['.task'], titleZh: 'Agent Scaffold', titleEn: 'Agent Scaffold', icon: 'fa-tasks', viewKey: 'read', priority: 50, surfaces: ALL },
  { id: 'builtin.kb', source: 'builtin', extensions: ['.kb'], titleZh: '知识库预览', titleEn: 'Knowledge base', icon: 'fa-database', viewKey: 'read', priority: 50, surfaces: ALL },
]

/** 合并内置 + 已加载插件（reactive） */
export const fileViewerCatalog = computed<FileViewerCatalogEntry[]>(() => {
  const builtins: FileViewerCatalogEntry[] = BUILTIN_FILE_VIEWERS.map((v) => ({
    ...v,
    views: builtinViews(v.id, v.viewKey),
  }))
  const plugins: FileViewerCatalogEntry[] = loadedFileViewers.map((v) => ({
    id: v.id,
    source: 'plugin',
    pluginId: v.pluginId,
    extensions: [...v.extensions],
    titleZh: v.titleZh,
    titleEn: v.titleEn,
    icon: v.icon || 'fa-file-o',
    views: [{
      key: `plugin:${v.id}`,
      titleZh: v.titleZh,
      titleEn: v.titleEn,
      icon: v.icon || 'fa-file-o',
    }],
    priority: Number(v.priority) || 100,
    write: v.write === true,
    surfaces: [...(v.surfaces || ALL)],
  }))
  return [...builtins, ...plugins]
})

/** 某个扩展名的全部候选（按优先级降序） */
export function catalogViewersForExtension(extRaw: string): FileViewerCatalogEntry[] {
  const ext = extRaw.startsWith('.') ? extRaw.toLowerCase() : `.${String(extRaw || '').toLowerCase()}`
  return fileViewerCatalog.value
    .filter((v) => v.extensions.includes(ext))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
}

/** 某个路径的全部候选 */
export function catalogViewersForPath(filePath: string): FileViewerCatalogEntry[] {
  return catalogViewersForExtension(fileExtensionOf(filePath))
}

/** 目录里的格式分组（按首次出现顺序；内置格式优先展示，插件专属格式追加） */
export const fileViewerFormatGroups = computed(() => {
  const map = new Map<string, FileViewerCatalogEntry[]>()
  for (const v of fileViewerCatalog.value) {
    for (const ext of v.extensions) {
      const arr = map.get(ext) || []
      arr.push(v)
      map.set(ext, arr)
    }
  }
  return [...map.entries()].map(([ext, viewers]) => ({ ext, viewers }))
})

export function viewerEntryById(id: string): FileViewerCatalogEntry | undefined {
  return fileViewerCatalog.value.find((v) => v.id === id)
}
