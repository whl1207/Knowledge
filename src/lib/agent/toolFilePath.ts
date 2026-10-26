/**
 * toolFilePath.ts — 工具结果中的路径 → 可打开的绝对路径（纯逻辑）
 *
 * 工具模型给的通常是相对路径（`demo_page.html`），执行时锚定的是**那个聊天自己的工作区**
 * （`readChatWorkspace(chat, store.root)`）。打开按钮往往在之后才点击：全局工作区可能
 * 已经切到别的目录（例如技能目录），若仍拿 `workspaceRoot(store)` 去拼，就会打开
 * `D:\Project\1 Knowledge\scripts\kb\demo_page.html` 这类不存在的路径（ENOENT）。
 *
 * 新工具结果会带 `preview.files[].absPath`（执行当时的绝对路径），优先用它；
 * 本函数是旧数据 / 没有 absPath 时的兜底：优先当前聊天工作区，其次全局工作区。
 * 不依赖 Vue / DOM，可直接自测（见 toolFilePath.selftest.ts）。
 */

export interface ToolFilePathRoots {
  /** 该聊天自己的工作区（最高优先级） */
  chatWorkspace?: string | null
  /** 全局默认工作区（兜底） */
  globalRoot?: string | null
  /** 其余候选根（如 store.roots，按顺序） */
  fallbackRoots?: Array<string | null | undefined>
}

/** 是否已经是绝对路径（Windows 驱动器 / POSIX / UNC） */
export function isAbsoluteToolPath(p: string): boolean {
  const s = String(p ?? '')
  return /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('/') || s.startsWith('\\\\')
}

/**
 * 把工具写入 / 改写的文件路径补成绝对路径。
 * 已是绝对路径则原样返回；否则按「聊天工作区 → 全局工作区 → fallbackRoots」第一个非空根拼接。
 */
export function resolveToolFilePath(path: string, roots: ToolFilePathRoots = {}): string {
  const p = String(path ?? '')
  if (!p) return ''
  if (isAbsoluteToolPath(p)) return p

  const candidates = [roots.chatWorkspace, roots.globalRoot, ...(roots.fallbackRoots || [])]
  const root = candidates
    .map((r) => String(r ?? '').trim())
    .find((r) => r.length > 0) || ''
  if (!root) return p
  // Windows 根目录用反斜杠拼出来，和资源管理器/错误信息里的路径写法一致；
  // POSIX 根仍用正斜杠。相对路径里的另一种分隔符一并归一。
  const sep = /^[a-zA-Z]:/.test(root) || root.includes('\\') ? '\\' : '/'
  const rootNorm = root
    .replace(/[\\/]+$/, '')
    .replace(sep === '\\' ? /\//g : /\\/g, sep)
  const rel = p.replace(/^[\\/]+/, '').replace(/[\\/]+/g, sep)
  return `${rootNorm}${sep}${rel}`
}
