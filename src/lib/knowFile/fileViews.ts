/**
 * fileViews.ts — 文件视图（浏览 / 源码编辑 / 可视编辑 / 思维导图 / 演示）的统一顺序与名称。
 *
 * ⚠ 这些视图**只属于独立文件窗口**（文件一律在新窗口打开，可用视图按文件类型决定，见
 *   FileWindow.vue 的 availableViews）；主窗口不再列出它们 —— 它一次只显示一个全局视图
 *   （见 store/index.ts 的 GLOBAL_VIEW_KEYS），仅在预览远程文件时自动切到「浏览」。
 *
 * ★ 想调整「视图顺序 / 名称」只改这个文件（以及下面列出的映射点）即可：
 *   - 顺序：数组顺序 = 文件窗口切换器、「打开」子菜单（文件树 / 表格 / 新建文件）的顺序
 *   - 中文名：`name`（同时是内部标识，见下）；英文名：`labelEn`
 *
 * ⚠ `name` 既是**内部标识**也是中文显示名（独立窗口的组件 `v-if`、主窗口预览远程文件用的
 *   `VIEW_BROWSE`、`panel.vue` / `view_table.vue` 的「打开」子菜单都按它匹配），所以改名时：
 *   1. 同步改这些比较点（都从这里取常量，别写字面量）；
 *   2. 用 `normalizeViewName()` 归一化历史持久化数据（旧名：编辑 / 块编辑 / 导图）。
 *
 * 独立「文件窗口」（FileWindow / 主进程 open-file-window）用的是另一套 key：
 *   read / office / edit / blockedit / mindmap / presentation（见 key 字段），窗口标题映射在
 *   electron/main/index.ts 的 viewLabelMap（那边不能直接 import 本文件，改动时一起改）。
 */

export interface FileViewDef {
  /** 独立文件窗口 / 主进程用的 key（稳定不改） */
  key: 'read' | 'office' | 'edit' | 'blockedit' | 'mindmap' | 'presentation'
  /** 视图标识 = 中文显示名（改名要同步所有比较点，见文件头注释） */
  name: string
  /** 英文显示名 */
  labelEn: string
  /** 视图栏图标（Font Awesome 4.7 或 iconfont） */
  icon: string
}

/**
 * 文件视图定义（顺序即展示顺序）。
 *
 * 注意：`office`（内嵌 Office 编辑器）排在最前 —— 对 .docx / .xlsx / .pptx 它是默认视图
 * （内核已构建时由主进程的 pickDefaultView 直接指定），也是切换器里的第一项。
 * 其余类型（Markdown / 代码 / 图片…）不会出现该视图，见 FileWindow 的 availableViews。
 */
export const FILE_VIEWS: FileViewDef[] = [
  { key: 'office', name: 'Office 编辑', labelEn: 'Office', icon: 'fa fa-file-word-o' },
  { key: 'read', name: '浏览', labelEn: 'Browse', icon: 'fa fa-book' },
  { key: 'edit', name: '源码编辑', labelEn: 'Source', icon: 'fa fa-code' },
  { key: 'blockedit', name: '可视编辑', labelEn: 'Visual', icon: 'fa fa-th-large' },
  { key: 'mindmap', name: '思维导图', labelEn: 'Mind Map', icon: 'fa fa-map-o' },
  { key: 'presentation', name: '演示', labelEn: 'Presentation', icon: 'fa fa-television' },
]

/** 文件视图标识列表（顺序同上） */
export const FILE_VIEW_NAMES: string[] = FILE_VIEWS.map((v) => v.name)

// 常用标识常量：**按 key 取**而不是按下标取，这样调整 FILE_VIEWS 顺序不会让常量错位
const nameOfKey = (key: FileViewDef['key']): string => {
  const def = FILE_VIEWS.find((v) => v.key === key)
  if (!def) throw new Error(`未知的文件视图 key：${key}`)
  return def.name
}

export const VIEW_OFFICE = nameOfKey('office')
export const VIEW_BROWSE = nameOfKey('read')
export const VIEW_SOURCE = nameOfKey('edit')
export const VIEW_VISUAL = nameOfKey('blockedit')
export const VIEW_MINDMAP = nameOfKey('mindmap')
export const VIEW_PRESENTATION = nameOfKey('presentation')

/** 「Office 编辑」视图的 key（对 .docx / .xlsx / .pptx 生效；PDF 不在此列，继续用 PdfViewer） */
export const OFFICE_VIEW_KEY = 'office' as const
/** 「Office 编辑」适用的扩展名（与 platform/office.ts 的 EXT_TO_TYPE 一致，改动时一起改） */
const OFFICE_VIEW_EXTS = ['.docx', '.xlsx', '.xlsm', '.pptx']
/**
 * 该路径是否适用「Office 编辑」视图。
 * 视图切换器、「打开」子菜单都据此过滤：Office 编辑器只服务真实的 Word / Excel / PPT 文件，
 * 其它格式（Markdown / 代码 / 图片 / PDF / 画布…）的选项里不应出现它。
 */
export function supportsOfficeView(filePath: string | null | undefined): boolean {
  const p = String(filePath || '').toLowerCase()
  const dot = p.lastIndexOf('.')
  return dot >= 0 && OFFICE_VIEW_EXTS.includes(p.substring(dot))
}
/** 旧标识 → 新标识（历史 localStorage 里的旧视图名与旧默认值） */
const FILE_VIEW_ALIASES: Record<string, string> = {
  编辑: '源码编辑',
  块编辑: '可视编辑',
  导图: '思维导图',
}

/** 归一化视图标识（用于读取历史持久化数据 / 旧菜单项） */
export function normalizeViewName(v: string): string {
  return FILE_VIEW_ALIASES[v] || v
}

/** 是否为文件视图标识 */
export function isFileViewName(v: string): boolean {
  return FILE_VIEW_NAMES.includes(normalizeViewName(v))
}

/** 按视图标识取定义（用于图标 / 英文名） */
export function fileViewByName(name: string): FileViewDef | undefined {
  const n = normalizeViewName(name)
  return FILE_VIEWS.find((v) => v.name === n)
}

/** 按独立文件窗口的 key 取定义 */
export function fileViewByKey(key: string): FileViewDef | undefined {
  return FILE_VIEWS.find((v) => v.key === key)
}

/** 视图标识 → 显示名（zh / en） */
export function fileViewLabel(name: string, zh: boolean): string {
  const def = fileViewByName(name)
  if (!def) return name
  return zh ? def.name : def.labelEn
}
