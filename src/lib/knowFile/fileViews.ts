/**
 * fileViews.ts — 文件视图（浏览 / 源码编辑 / 可视编辑 / 思维导图 / 演示）的统一顺序与名称。
 *
 * ★ 想调整「视图顺序 / 名称」只改这个文件（以及下面列出的映射点）即可：
 *   - 顺序：数组顺序 = 主界面视图栏、视图下拉、新窗口打开菜单、文件窗口切换器的顺序
 *   - 中文名：`name`（同时是内部标识，见下）；英文名：`labelEn`
 *
 * ⚠ `name` 既是**内部标识**也是中文显示名（`store.viewList` / `store.view` / `store.isView` /
 *   `explorer.vue` 的组件 `v-if` / `panel.vue` 的视图管理，全都按它匹配），所以改名时：
 *   1. 同步改这些比较点（都从这里取常量，别写字面量）；
 *   2. 用 `normalizeViewName()` 归一化历史持久化数据（旧名：编辑 / 块编辑 / 导图）。
 *
 * 独立「文件窗口」（FileWindow / 主进程 open-file-window）用的是另一套 key：
 *   read / edit / blockedit / mindmap / presentation（见 key 字段），窗口标题映射在
 *   electron/main/index.ts 的 viewLabelMap（那边不能直接 import 本文件，改动时一起改）。
 */

export interface FileViewDef {
  /** 独立文件窗口 / 主进程用的 key（稳定不改） */
  key: 'read' | 'edit' | 'blockedit' | 'mindmap' | 'presentation'
  /** 视图标识 = 中文显示名（改名要同步所有比较点，见文件头注释） */
  name: string
  /** 英文显示名 */
  labelEn: string
  /** 视图栏图标（Font Awesome 4.7 或 iconfont） */
  icon: string
}

/** 文件视图定义（顺序即展示顺序） */
export const FILE_VIEWS: FileViewDef[] = [
  { key: 'read', name: '浏览', labelEn: 'Browse', icon: 'fa fa-book' },
  { key: 'edit', name: '源码编辑', labelEn: 'Source', icon: 'fa fa-code' },
  { key: 'blockedit', name: '可视编辑', labelEn: 'Visual', icon: 'fa fa-th-large' },
  { key: 'mindmap', name: '思维导图', labelEn: 'Mind Map', icon: 'fa fa-map-o' },
  { key: 'presentation', name: '演示', labelEn: 'Presentation', icon: 'fa fa-television' },
]

/** 文件视图标识列表（顺序同上） */
export const FILE_VIEW_NAMES: string[] = FILE_VIEWS.map((v) => v.name)
// 常用标识常量：代码里请在比较时用这些常量，不要再写字面量（改名时它们自动跟随）
export const VIEW_BROWSE = FILE_VIEWS[0].name
export const VIEW_SOURCE = FILE_VIEWS[1].name
export const VIEW_VISUAL = FILE_VIEWS[2].name
export const VIEW_MINDMAP = FILE_VIEWS[3].name
export const VIEW_PRESENTATION = FILE_VIEWS[4].name
/** 除「浏览」之外的文件视图（都需要有打开的文件，且远程只读预览下禁用） */
export const NON_BROWSE_FILE_VIEWS = FILE_VIEW_NAMES.filter((n) => n !== VIEW_BROWSE)
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
