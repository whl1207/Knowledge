/**
 * fileSort.ts — 文件排序方式的共用定义（文件树 panel.vue 与「文件」视图 view_file.vue 共用）。
 *
 * `FileSortKey` 同时用于两处的排序菜单；`fileTypeKey()` 提供「按类型排序」的比较键，
 * 保证两处对「类型」的定义一致（扩展名小写，含点）。
 */

export type FileSortKey = 'name' | 'mtime' | 'size' | 'type'

/** 排序方式的显示名（中 / 英），顺序即菜单项顺序 */
export const FILE_SORT_ITEMS: { key: FileSortKey; labelZh: string; labelEn: string }[] = [
  { key: 'name', labelZh: '名称', labelEn: 'Name' },
  { key: 'mtime', labelZh: '修改时间', labelEn: 'Modified' },
  { key: 'size', labelZh: '大小', labelEn: 'Size' },
  { key: 'type', labelZh: '类型', labelEn: 'Type' },
]

/**
 * 「按类型排序」的比较键：文件取扩展名（小写、含点；取名字而非完整路径），
 * 无扩展名（如 README）返回空串，排在同类最前。文件夹在各自调用处已单独置顶。
 */
export function fileTypeKey(name?: string | null): string {
  const base = String(name ?? '').replace(/\\/g, '/').split('/').pop() || ''
  const i = base.lastIndexOf('.')
  return i > 0 ? base.substring(i).toLowerCase() : ''
}
