/**
 * read-cache.ts — `read_file` 的「同轮重复读取」短路缓存
 *
 * 为什么单独一个模块：缓存既被工具（tools.ts）写，也要在会话销毁时由 agent 循环清理；
 * 放在两边的任一侧都会形成 tools ⇄ agent-loop 的循环 import。
 *
 * 语义（见 tools.ts 的 readFile）：
 * - 键 = `<owner>|<规范化路径>`；
 * - 命中条件：同一 turn、同一版本（size:mtime:ctime）、同一 offset/limit；
 * - 只缓存"成功且带行窗口元数据"的读取；跨轮不复用（上一轮可能已被上下文压缩掉）。
 */

export interface ReadCacheEntry {
  /** 写入时的 turn 序号 */
  turn: number
  /** 文件版本（size:mtime:ctime） */
  version: string
  /** 请求的起始行（1-based） */
  offset: number
  /** 请求的最大行数 */
  limit: number
  /** 实际返回的起止行与总行数 */
  startLine: number
  endLine: number
  totalLines: number
}

/** 最多保留多少条（超出按最早写入淘汰） */
export const READ_CACHE_MAX = 200

const cache = new Map<string, ReadCacheEntry>()

export function getReadCache(key: string): ReadCacheEntry | undefined {
  return cache.get(key)
}

export function setReadCache(key: string, entry: ReadCacheEntry): void {
  // 先删再插：让 Map 的插入顺序当作 LRU 的"最近使用"
  cache.delete(key)
  cache.set(key, entry)
  while (cache.size > READ_CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/** 清掉某个会话的全部缓存（agent 销毁时调用） */
export function clearReadCacheFor(owner: string): void {
  const prefix = `${String(owner || '')}|`
  for (const key of Array.from(cache.keys())) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
}
