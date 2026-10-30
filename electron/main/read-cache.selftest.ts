/**
 * read-cache.selftest.ts — `read_file` 同轮重复读取短路的缓存层
 *
 * 只测纯逻辑：键的存取、LRU 淘汰、按会话清理。命中条件（同 turn / 同版本 / 同窗口）
 * 的判定在 tools.ts 的 readFile 里，依赖 fs 与 agent 上下文，不在这里覆盖。
 */

import { READ_CACHE_MAX, clearReadCacheFor, getReadCache, setReadCache } from './read-cache'

export interface SelfTestCase {
  name: string
  ok: boolean
  detail?: string
}

const entry = (turn: number, version = 'v1') => ({
  turn,
  version,
  offset: 1,
  limit: 200,
  startLine: 1,
  endLine: 100,
  totalLines: 100,
})

export function runReadCacheSelfTest(): SelfTestCase[] {
  const cases: SelfTestCase[] = []
  const check = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  clearReadCacheFor('a')
  clearReadCacheFor('b')

  check('未写入时取不到', getReadCache('a|/x') === undefined)

  setReadCache('a|/x', entry(1))
  check('写入后可取回', getReadCache('a|/x')?.version === 'v1')

  setReadCache('a|/x', entry(2, 'v2'))
  check('同键覆盖（不重复占位）', getReadCache('a|/x')?.version === 'v2' && getReadCache('a|/x')?.turn === 2)

  setReadCache('b|/x', entry(1))
  clearReadCacheFor('a')
  check('按会话清理只清该前缀', getReadCache('a|/x') === undefined && getReadCache('b|/x') !== undefined)

  // LRU：写满后最早那条被淘汰
  clearReadCacheFor('c')
  for (let i = 0; i < READ_CACHE_MAX + 5; i++) setReadCache(`c|/f${i}`, entry(1))
  check('超出上限淘汰最旧的', getReadCache('c|/f0') === undefined && getReadCache(`c|/f${READ_CACHE_MAX + 4}`) !== undefined)

  // 清理不误伤其它前缀（键前缀按 `owner|` 精确匹配；f1 已被 LRU 淘汰，故查 f5）
  clearReadCacheFor('cc')
  check('前缀不误伤', getReadCache('c|/f5') !== undefined)

  return cases
}
