/**
 * 向量库端到端自测（Node，不依赖 Electron）：
 * 写入 → int8 编码 → 查询 top1 → 取回向量 → file_vectors hash → reconcile 清理。
 * 对应「保存 → 瘦身 → 检索」链路的核心数据层。
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { KbVectorStore } from './kb-vector-store'

export function runKbVectorStoreSelfTest(): Array<{ name: string; ok: boolean }> {
  const out: Array<{ name: string; ok: boolean }> = []
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbvec-selftest-'))
  const dbPath = path.join(dir, 't.kbdb')
  try {
    const store = KbVectorStore.open(dbPath)
    store.writeMeta({ dim: 4, model: 'm' })
    const vecs = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0.6, 0.8, 0, 0],
    ]
    const res = store.upsertChunks(vecs.map((v, i) => ({
      id: `c${i}`, file: 'f.md', label: 'l', ordinal: i, text: `t${i}`, hash: `h${i}`, vector: v,
    })), { quant: 'int8' })
    out.push({ name: 'upsert writes all chunks', ok: res.written === 3 && res.skipped === 0 })

    const stats = store.stats()
    out.push({ name: 'stats: quant/dim/vectors', ok: stats.quant === 'int8' && stats.dim === 4 && stats.vectors === 3 })
    out.push({ name: 'stats: created/updated timestamps', ok: !!stats.createdAt && !!stats.updatedAt })

    const self = store.query(vecs[0], 1)
    out.push({ name: 'int8 query top1 is self', ok: self[0]?.id === 'c0' && self[0].score > 0.99 })

    const got = store.getVectors(['c0']).get('c0') || []
    out.push({ name: 'getVectors decodes int8', ok: got.length === 4 && Math.abs(got[0] - 1) < 0.02 })

    // 增量：hash 未变跳过
    const again = store.upsertChunks(vecs.map((v, i) => ({
      id: `c${i}`, file: 'f.md', label: 'l', ordinal: i, text: `t${i}`, hash: `h${i}`, vector: v,
    })), { quant: 'int8' })
    out.push({ name: 'upsert skips unchanged hashes', ok: again.written === 0 && again.skipped === 3 })

    // 文件向量 hash 往返 + 变更检测
    store.upsertFileVectors([{ file: 'f.md', vector: [1, 0, 0, 0], hash: 'file-h1' }], { quant: 'int8' })
    const fv = store.getFileVectors(['f.md']).get('f.md')
    out.push({ name: 'file_vectors hash roundtrip', ok: !!fv && fv.hash === 'file-h1' && fv.vector.length === 4 })
    const fvSkip = store.upsertFileVectors([{ file: 'f.md', vector: [1, 0, 0, 0], hash: 'file-h1' }], { quant: 'int8' })
    out.push({ name: 'file_vectors skips same hash', ok: fvSkip.written === 0 && fvSkip.skipped === 1 })

    // reconcile：删掉不在当前集合里的切片/文件
    const rec = store.reconcile(['c0', 'c1'], ['f.md'])
    out.push({ name: 'reconcile removes stale chunk', ok: rec.chunks === 1 && store.stats().vectors === 2 })
    out.push({ name: 'reconcile keeps current files', ok: rec.files === 0 })

    store.close()

    // 重新打开：数据持久化
    const reopened = KbVectorStore.open(dbPath)
    out.push({ name: 'reopen keeps vectors', ok: reopened.stats().vectors === 2 })
    reopened.close()
  } catch (e: any) {
    out.push({ name: `unexpected error: ${e?.message || e}`, ok: false })
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 上可能仍被占用 */ }
  }
  return out
}
