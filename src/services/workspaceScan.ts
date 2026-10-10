/**
 * 工作区文件扫描（学习模块的 .kb、工作流的 .flow.yml 等共用）
 *
 * 约定（与「知识处理」文件视图一致）：
 * - 扫描**全部工作区**（`store.roots`，由调用方通过 workspaceRoots 传入）及其子目录，
 *   深度见 WORKSPACE_SCAN_DEPTH；
 * - 按路径去重（嵌套工作区会重复扫到同一文件）；
 * - 同名文件补标父目录名，避免列表里无法分辨。
 */

/** 扫描深度：工作区根目录下最多 3 层（含顶层） */
export const WORKSPACE_SCAN_DEPTH = 3

export interface WorkspaceFile {
  /** 完整路径 */
  path: string
  /** 文件名（含扩展名） */
  name: string
  /** 列表显示名：同名文件补「（父目录）」 */
  label: string
  mtime: number
  size: number
}

/**
 * 扫描范围：全部工作区，并兜底当前工作区（保序、去空）。
 * 字段名对齐 store，便于直接传 `store.roots` / `store.root`。
 */
export function workspaceRoots(roots: string[], activeRoot = ''): string[] {
  const list = (roots || []).filter(Boolean)
  if (activeRoot && !list.includes(activeRoot)) list.unshift(activeRoot)
  return list
}

/** 扫描各工作区（含子目录）中扩展名匹配的文件；exts 形如 ['.kb']，大小写不敏感 */
export async function listWorkspaceFiles(roots: string[], exts: string[]): Promise<WorkspaceFile[]> {
  const dirs = workspaceRoots(roots)
  const wanted = (exts || []).map((e) => String(e).toLowerCase()).filter(Boolean)
  if (!dirs.length || !wanted.length) return []

  const seen = new Set<string>()
  const found: WorkspaceFile[] = []
  for (const dir of dirs) {
    try {
      const result = await window.ipcRenderer.invoke('getFilesRelation', dir, WORKSPACE_SCAN_DEPTH)
      for (const f of ((result && result.fileList) || []) as any[]) {
        const p = typeof f?.path === 'string' ? f.path : ''
        if (!p) continue
        const lower = p.toLowerCase()
        if (!wanted.some((ext) => lower.endsWith(ext))) continue
        if (seen.has(lower)) continue // 嵌套工作区会重复扫到同一文件
        seen.add(lower)
        const name = f.label || p.split(/[\\/]/).pop() || p
        found.push({ path: p, name, label: name, mtime: f.mtime || 0, size: f.size || 0 })
      }
    } catch (e) {
      console.error('[workspaceScan] 扫描失败:', dir, e)
    }
  }

  const counts = new Map<string, number>()
  for (const f of found) counts.set(f.name, (counts.get(f.name) || 0) + 1)
  for (const f of found) {
    if ((counts.get(f.name) || 0) < 2) continue
    const parent = f.path.split(/[\\/]/).filter(Boolean).slice(-2, -1)[0]
    if (parent) f.label = `${f.name}（${parent}）`
  }
  return found
}
