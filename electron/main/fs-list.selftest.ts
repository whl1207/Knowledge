/**
 * fs-list.selftest.ts — 文件树懒加载底座（纯 Node，临时目录，不依赖 electron）
 *
 * 这些断言守的是「选 D 盘不再闪退」背后的硬约束：
 *  - readDirPage 只读一层、不汇总目录大小、目录不可读不抛错、分页可续；
 *  - 目录缓存按目录自身 mtime 失效（新增文件后能刷新）；
 *  - searchNamesWalk 只比文件名、带三重预算、可被新请求取消；
 *  - boundedTreeScan 有节点预算，超限截断而不是无限递归。
 */

import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  boundedTreeScan,
  normalizeListDirLimits,
  normalizeNameSearchLimits,
  readDirPage,
  resetDirCache,
  searchNamesWalk,
} from './fs-list'

export interface FsListCase { name: string; ok: boolean; detail?: string }

export async function runFsListSelfTest(): Promise<FsListCase[]> {
  const cases: FsListCase[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  const root = fs.mkdtempSync(join(tmpdir(), 'aikm-fs-list-'))
  try {
    fs.mkdirSync(join(root, 'docs', 'deep'), { recursive: true })
    fs.mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    fs.writeFileSync(join(root, 'a.md'), '# alpha\n')
    fs.writeFileSync(join(root, 'docs', 'b.md'), '# beta\n')
    fs.writeFileSync(join(root, 'docs', 'deep', 'gamma.md'), '# gamma\n')
    fs.writeFileSync(join(root, 'node_modules', 'pkg', 'gamma.js'), 'module.exports = 1\n')
    // 系统保留项：列目录时应被跳过
    fs.writeFileSync(join(root, 'thumbs.db'), 'x')
    fs.writeFileSync(join(root, 'pagefile.sys'), 'x')
    resetDirCache()

    // ---- 1. 只读一层 ----
    const page = await readDirPage(root)
    const byName = new Map(page.entries.map((e) => [e.label, e]))
    add('单层读取：返回根层条目', page.entries.length > 0 && byName.has('docs') && byName.has('a.md'), JSON.stringify(page.entries.map((e) => e.label)))
    add('单层读取：不展开子目录（docs 下没有 b.md）', !byName.has('b.md'))
    add('单层读取：跳过系统保留项（thumbs.db / pagefile.sys）', !byName.has('thumbs.db') && !byName.has('pagefile.sys'))
    add('文件夹不汇总大小（size 为空）', byName.get('docs')?.size === undefined, String(byName.get('docs')?.size))
    add('文件带 size / mtime', (byName.get('a.md')?.size || 0) > 0 && typeof byName.get('a.md')?.mtime === 'number')
    add('目录排在文件前面', page.entries[0]?.type === 'folder', String(page.entries[0]?.type))
    add('total 不含被跳过的系统保留项', page.total === page.entries.length, `total=${page.total} entries=${page.entries.length}`)

    // ---- 2. 分页 ----
    const p1 = await readDirPage(root, 0, 1)
    const p2 = await readDirPage(root, 1, 1)
    add('分页：limit=1 且 truncated=true', p1.entries.length === 1 && p1.truncated === true, `len=${p1.entries.length} truncated=${p1.truncated}`)
    add('分页：offset 前进一位', p2.entries.length === 1 && p2.entries[0].path !== p1.entries[0].path)
    add('分页参数钳制：负数归零 / 超大 limit 有上限', normalizeListDirLimits(-5, 999999).offset === 0 && normalizeListDirLimits(-5, 999999).limit === 2000)

    // ---- 3. 不可读目录不抛错 ----
    const missing = await readDirPage(join(root, 'not-exists'))
    add('目录不存在：返回 error 而不是抛错', missing.entries.length === 0 && !!missing.error, missing.error)
    add('空路径：返回 error 而不是抛错', (await readDirPage('')).error === '路径为空')
    const asFile = await readDirPage(join(root, 'a.md'))
    add('路径是文件：返回 error（不是目录）', asFile.error === '不是目录', asFile.error)

    // ---- 4. 缓存按目录 mtime 失效 ----
    const cached = await readDirPage(root)
    add('缓存命中：同样条数', cached.entries.length === page.entries.length)
    fs.writeFileSync(join(root, 'fresh.md'), '# fresh\n')
    // 目录 mtime 可能同秒：显式推进后再读，避免文件系统时间精度导致的假失败
    const bumped = Date.now() / 1000 + 2
    try { fs.utimesSync(root, bumped, bumped) } catch { /* 忽略 */ }
    const afterWrite = await readDirPage(root)
    add('新增文件后缓存失效（能看到 fresh.md）', afterWrite.entries.some((e) => e.label === 'fresh.md'), JSON.stringify(afterWrite.entries.map((e) => e.label)))

    // ---- 5. 按文件名全树搜索 ----
    const hit = await searchNamesWalk({ roots: [root], keyword: 'gamma' })
    add('搜索命中深层文件（跨层）', hit.results.some((r) => r.path.endsWith('gamma.md')), JSON.stringify(hit.results.map((r) => r.path)))
    add('搜索跳过 node_modules', !hit.results.some((r) => r.path.includes('node_modules')))
    add('搜索只比文件名（不读内容）', !hit.results.some((r) => r.label === 'a.md'))
    add('搜索结果只有一个文件命中', hit.results.length === 1, String(hit.results.length))

    const capped = await searchNamesWalk({ roots: [root], keyword: 'm', maxResults: 1 })
    add('结果上限：maxResults=1 时 truncated=true', capped.results.length === 1 && capped.truncated === true)

    let calls = 0
    const cancelled = await searchNamesWalk({
      roots: [root],
      keyword: 'm',
      maxResults: 1000,
      isStale: () => ++calls > 0,
    })
    add('取消：isStale 为真时尽快返回并标记 truncated', cancelled.truncated === true && cancelled.results.length === 0, JSON.stringify(cancelled))

    const emptyKeyword = await searchNamesWalk({ roots: [root], keyword: '  ' })
    add('空关键字：直接返回空（不扫盘）', emptyKeyword.results.length === 0 && emptyKeyword.scanned === 0)

    const depthLimited = await searchNamesWalk({ roots: [root], keyword: 'gamma', maxDepth: 2 })
    add('深度上限：maxDepth=2 时不进 docs/deep', depthLimited.results.length === 0, JSON.stringify(depthLimited.results.map((r) => r.path)))

    const limits = normalizeNameSearchLimits({ roots: [root], keyword: 'x', maxResults: 1e9, maxDepth: 99, budgetMs: 1 })
    add('搜索预算钳制（结果 ≤1000 / 深度 ≤12 / 时间 ≥100ms）', limits.maxResults === 1000 && limits.maxDepth === 12 && limits.budgetMs === 100)

    // ---- 6. 整树快照有预算 ----
    const full = await boundedTreeScan([root], { maxNodes: 500, maxDepth: 8 })
    add('整树快照：正常规模不截断', full.truncated === false && full.tree.length === 1)
    const tiny = await boundedTreeScan([root], { maxNodes: 2, maxDepth: 8 })
    add('整树快照：超预算时截断而不是无限递归', tiny.truncated === true, `truncated=${tiny.truncated}`)
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  return cases
}
