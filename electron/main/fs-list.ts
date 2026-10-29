/**
 * fs-list.ts — 文件树的「按目录懒加载」底座（不依赖 electron，可独立跑自测）
 *
 * 背景：知识管理模块原先把整个工作区扫成一棵树再经 IPC 回传。选 D 盘这类工作区时
 * （本机实测 204,016 个目录 / 1,673,401 个文件）会构造上百万个节点、序列化数百 MB，
 * 主进程或渲染进程直接 OOM —— 用户看到的就是「闪退」。
 *
 * 这里把性能相关的判断收敛到一处：
 *  - `readDirPage`：只读**一层**目录，条目数有上限、只对当前页 stat、单条失败只丢该条，
 *    目录不可读返回 error 而不抛错；
 *  - `searchNamesWalk`：按文件名全树搜索，带结果数 / 深度 / 时间三重预算，
 *    并且可以被新请求（`isStale`）随时中止；
 *  - `boundedTreeScan`：兼容旧 `refreshMultiTree` 的整树快照，但有节点/深度硬预算。
 *
 * 目录不再汇总 size：那需要遍历整棵子树，正是要避免的开销。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { flowAwareExt } from './file-ext'

export interface FsListEntry {
  label: string
  path: string
  type: 'file' | 'folder'
  extension: string
  size?: number
  mtime?: number
}

export interface FsListPage {
  entries: FsListEntry[]
  total: number
  truncated: boolean
  error?: string
}

/** 列目录时跳过的系统保留项（盘符根常见：stat/readdir 会权限报错或没有展示价值） */
export const FS_LIST_SKIP = new Set([
  'system volume information', '$recycle.bin', 'dumpstack.log.tmp',
  'pagefile.sys', 'hiberfil.sys', 'swapfile.sys',
  '$windows.~bt', '$windows.~ws', '$winreagent',
  '.ds_store', 'thumbs.db',
])

/** 按文件名搜索时跳过的大目录（构建产物 / 依赖目录，进去只会拖慢且没有检索价值） */
export const FS_SEARCH_SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'dist-electron', 'build', 'release', 'out',
  'coverage', '.next', '.nuxt', '.cache', '.gradle', '.idea', '.vs', 'vendor', '__pycache__',
  '.venv', 'venv',
])

/** 单层读取的条目上限（分页用；一次返回 2000 条已足够覆盖正常目录） */
export const LIST_DIR_MAX_LIMIT = 2000

export interface ListDirLimits {
  offset: number
  limit: number
}

/** 归一化分页参数：负数/NaN 一律归零，limit 钳到 [1, LIST_DIR_MAX_LIMIT] */
export function normalizeListDirLimits(offsetRaw: unknown, limitRaw: unknown): ListDirLimits {
  const offset = Math.max(0, Number(offsetRaw) || 0)
  const limit = Math.min(LIST_DIR_MAX_LIMIT, Math.max(1, Number(limitRaw) || 1000))
  return { offset, limit }
}

// ---- 目录级 LRU：只缓存「一层」，按目录自身 mtime 失效（O(1) 次 stat，不遍历全盘目录做指纹） ----
const DIR_CACHE_MAX_DIRS = 128
const DIR_CACHE_MAX_ENTRIES = 40000
const dirCache = new Map<string, { mtimeMs: number; entries: FsListEntry[]; total: number }>()
let dirCacheEntryCount = 0

function dirCacheTouch(dir: string): { mtimeMs: number; entries: FsListEntry[]; total: number } | undefined {
  const hit = dirCache.get(dir)
  if (!hit) return undefined
  // Map 保持插入序：命中后移到末尾，实现 LRU
  dirCache.delete(dir)
  dirCache.set(dir, hit)
  return hit
}

function dirCachePut(dir: string, mtimeMs: number, entries: FsListEntry[], total: number): void {
  if (entries.length > 2000) return // 超大目录不缓存，避免单条缓存就把内存吃满
  const prev = dirCache.get(dir)
  if (prev) {
    dirCacheEntryCount -= prev.entries.length
    dirCache.delete(dir)
  }
  dirCache.set(dir, { mtimeMs, entries, total })
  dirCacheEntryCount += entries.length
  while (dirCache.size > DIR_CACHE_MAX_DIRS || dirCacheEntryCount > DIR_CACHE_MAX_ENTRIES) {
    const oldest = dirCache.keys().next()
    if (oldest.done) break
    const victim = dirCache.get(oldest.value as string)
    if (victim) dirCacheEntryCount -= victim.entries.length
    dirCache.delete(oldest.value as string)
  }
}

/** 让某目录（及其父目录）的缓存失效：文件系统事件与写操作后调用 */
export function invalidateDirCache(target: string): void {
  if (!target) return
  dirCache.delete(target)
  const parent = path.dirname(target)
  if (parent && parent !== target) dirCache.delete(parent)
}

/** 测试用：清空缓存 / 查看缓存规模 */
export function resetDirCache(): void {
  dirCache.clear()
  dirCacheEntryCount = 0
}
export function dirCacheSize(): number {
  return dirCache.size
}

/**
 * 读取**一层**目录。
 *
 * 约定（渲染层文件树直接依赖）：
 * - 永不抛出：目录不可读时返回 `{ entries: [], error }`；
 * - 只对当前页 stat：超大目录不会因为「先 stat 全部再分页」而卡死；
 * - 单条 stat 失败（权限 / 扫描期间被删）只丢该条的 size/mtime，名字照常显示；
 * - 不汇总目录 size。
 */
export async function readDirPage(dirRaw: string, offsetRaw?: unknown, limitRaw?: unknown): Promise<FsListPage> {
  const dir = String(dirRaw || '')
  if (!dir) return { entries: [], total: 0, truncated: false, error: '路径为空' }
  const { offset, limit } = normalizeListDirLimits(offsetRaw, limitRaw)

  let mtimeMs = 0
  try {
    const st = await fs.promises.stat(dir)
    if (!st.isDirectory()) return { entries: [], total: 0, truncated: false, error: '不是目录' }
    mtimeMs = Math.round(st.mtimeMs)
  } catch (e: any) {
    return { entries: [], total: 0, truncated: false, error: e?.code || String(e?.message || e) }
  }

  if (offset === 0) {
    const cached = dirCacheTouch(dir)
    if (cached && cached.mtimeMs === mtimeMs) {
      // 缓存里存的是**完整**一层列表（只有未截断时才缓存），这里按本次 limit 再切一次
      const all = cached.entries
      if (all.length <= limit) return { entries: all, total: cached.total, truncated: false }
      return { entries: all.slice(0, limit), total: cached.total, truncated: true }
    }
  }

  let dirents: fs.Dirent[]
  try {
    dirents = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch (e: any) {
    return { entries: [], total: 0, truncated: false, error: e?.code || String(e?.message || e) }
  }

  const visible = dirents.filter((d) => !FS_LIST_SKIP.has(d.name.toLowerCase()))
  // 分页需要稳定顺序：目录在前、名称按码点排序（渲染层还会按用户偏好再排一次）
  visible.sort((a, b) => {
    const ad = a.isDirectory() ? 0 : 1
    const bd = b.isDirectory() ? 0 : 1
    if (ad !== bd) return ad - bd
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })

  const page = visible.slice(offset, offset + limit)
  const entries = await mapLimit(page, 32, async (dirent): Promise<FsListEntry> => {
    const childPath = path.join(dir, dirent.name)
    let isDir = dirent.isDirectory()
    let size: number | undefined
    let childMtime: number | undefined
    try {
      const s = await fs.promises.stat(childPath)
      isDir = s.isDirectory()
      childMtime = s.mtimeMs
      if (!isDir) size = s.size
    } catch {
      /* 单条失败：只丢 size/mtime，名字照常显示 */
    }
    return {
      label: dirent.name,
      path: childPath,
      type: isDir ? 'folder' : 'file',
      extension: isDir ? 'folder' : flowAwareExt(childPath),
      size,
      mtime: childMtime,
    }
  })

  const total = visible.length
  const truncated = offset + entries.length < total
  if (offset === 0 && !truncated) dirCachePut(dir, mtimeMs, entries, total)
  return { entries, total, truncated }
}

/** 有界并发 map：按输入顺序输出结果，限制同时执行的异步任务数（避免大目录并发 stat 打开过多句柄） */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: (R | undefined)[] = new Array(items.length)
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = index++
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results as R[]
}

export interface NameSearchParams {
  roots: string[]
  keyword: string
  /** 最多返回多少条命中（默认 200） */
  maxResults?: number
  /** 最大递归深度（默认 12） */
  maxDepth?: number
  /** 时间预算（毫秒，默认 800） */
  budgetMs?: number
  /** 被新请求取代时返回 true：每 128 个条目检查一次，尽快退出 */
  isStale?: () => boolean
}

export interface NameSearchResult {
  results: FsListEntry[]
  truncated: boolean
  scanned: number
  elapsedMs: number
}

/** 归一化搜索预算（也供测试断言使用） */
export function normalizeNameSearchLimits(p: NameSearchParams): { maxResults: number; maxDepth: number; budgetMs: number } {
  return {
    maxResults: Math.min(1000, Math.max(1, Number(p.maxResults) || 200)),
    maxDepth: Math.min(12, Math.max(1, Number(p.maxDepth) || 12)),
    budgetMs: Math.min(5000, Math.max(100, Number(p.budgetMs) || 800)),
  }
}

/**
 * 按**文件名**全树搜索（只读目录项、不读文件内容）。
 *
 * 预算：结果数、深度、时间。任一超限即返回已完成的部分并置 `truncated`。
 * 取消：`isStale()` 为真时尽快返回（用户继续输入时旧请求自行退出，不会叠加成多个全盘扫描）。
 */
export async function searchNamesWalk(p: NameSearchParams): Promise<NameSearchResult> {
  const started = Date.now()
  const roots = (Array.isArray(p.roots) ? p.roots : []).map((r) => String(r || '')).filter(Boolean)
  const kw = String(p.keyword || '').toLowerCase().trim()
  const { maxResults, maxDepth, budgetMs } = normalizeNameSearchLimits(p)
  const results: FsListEntry[] = []
  let scanned = 0
  let truncated = false
  if (!kw || !roots.length) return { results, truncated, scanned, elapsedMs: 0 }

  const stack: Array<{ dir: string; depth: number }> = roots.map((dir) => ({ dir, depth: 0 }))
  while (stack.length) {
    if ((p.isStale && p.isStale()) || results.length >= maxResults || Date.now() - started > budgetMs) {
      truncated = true
      break
    }
    const { dir, depth } = stack.pop() as { dir: string; depth: number }
    let dirents: fs.Dirent[]
    try {
      dirents = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      continue // 单个目录不可读：跳过，不影响其它目录
    }
    for (const dirent of dirents) {
      scanned++
      if (scanned % 128 === 0 && p.isStale && p.isStale()) {
        return { results, truncated: true, scanned, elapsedMs: Date.now() - started }
      }
      const lower = dirent.name.toLowerCase()
      if (FS_LIST_SKIP.has(lower)) continue
      const childPath = path.join(dir, dirent.name)
      if (dirent.isDirectory()) {
        if (FS_SEARCH_SKIP_DIRS.has(lower)) continue
        if (depth + 1 < maxDepth) stack.push({ dir: childPath, depth: depth + 1 })
        continue
      }
      if (!lower.includes(kw)) continue
      let size: number | undefined
      let mtime: number | undefined
      try {
        const s = await fs.promises.stat(childPath)
        size = s.size
        mtime = s.mtimeMs
      } catch { /* 忽略 */ }
      results.push({
        label: dirent.name,
        path: childPath,
        type: 'file',
        extension: flowAwareExt(childPath),
        size,
        mtime,
      })
      if (results.length >= maxResults) {
        truncated = true
        break
      }
    }
  }
  return { results, truncated, scanned, elapsedMs: Date.now() - started }
}

/**
 * 兼容旧 `refreshMultiTree` 的整树快照（带硬预算）。
 * 文件树已不再使用它；保留是为了不让仍调用该通道的外部方把主进程拖进百万节点扫描。
 */
export async function boundedTreeScan(
  roots: string[],
  opts?: { maxNodes?: number; maxDepth?: number },
): Promise<{ tree: any[]; truncated: boolean; version: number }> {
  const state = {
    nodes: 0,
    maxNodes: Math.max(1, Number(opts?.maxNodes) || 8000),
    maxDepth: Math.max(1, Number(opts?.maxDepth) || 8),
    depth: 0,
    truncated: false,
  }
  const tree: any[] = []
  for (const root of roots) {
    if (state.truncated) break
    const node = await scanOne(root, state)
    if (node) tree.push(node)
  }
  return { tree, truncated: state.truncated, version: ++treeVersion }
}

let treeVersion = 0

interface BoundedTreeState { nodes: number; maxNodes: number; maxDepth: number; depth: number; truncated: boolean }

async function scanOne(directoryPath: string, state: BoundedTreeState): Promise<any> {
  const absolutePath = path.resolve(directoryPath)
  let stats: fs.Stats
  try {
    stats = await fs.promises.stat(directoryPath)
  } catch {
    return null
  }
  if (!stats.isDirectory()) {
    return {
      label: path.basename(directoryPath),
      type: 'file',
      path: absolutePath,
      extension: flowAwareExt(directoryPath),
      mtime: stats.mtimeMs,
      size: stats.size,
    }
  }
  if (state.nodes >= state.maxNodes || state.depth > state.maxDepth) {
    state.truncated = true
    return null
  }
  let dirents: fs.Dirent[] = []
  try {
    dirents = await fs.promises.readdir(directoryPath, { withFileTypes: true })
  } catch {
    return null
  }
  const children: any[] = []
  for (const dirent of dirents) {
    if (FS_LIST_SKIP.has(dirent.name.toLowerCase())) continue
    if (state.nodes >= state.maxNodes) {
      state.truncated = true
      break
    }
    const childPath = path.join(directoryPath, dirent.name)
    let child: any = null
    if (dirent.isDirectory()) {
      state.depth++
      child = await scanOne(childPath, state)
      state.depth--
    } else {
      try {
        const s = await fs.promises.stat(childPath)
        child = { label: dirent.name, type: 'file', path: childPath, extension: flowAwareExt(dirent.name), mtime: s.mtimeMs, size: s.size }
      } catch {
        continue
      }
    }
    if (!child) continue
    state.nodes++
    children.push(child)
  }
  return { label: path.basename(directoryPath), type: 'folder', path: absolutePath, children, extension: 'folder', mtime: stats.mtimeMs }
}
