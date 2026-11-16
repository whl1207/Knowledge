/**
 * kb-vector-store.ts — 知识库向量库（P0：`.kbdb`，SQLite 单文件，零原生依赖）
 *
 * 为什么是它：
 * - 实测 `.kb` 内联向量在 4 万块附近撞 V8 字符串上限（512MB），10 万块根本读不进内存；
 *   SQLite 单文件可以在毫秒级打开、增量写入、按需读取（见 scripts/kb-bench/REPORT.md）。
 * - Electron 42 自带 Node 24 的 `node:sqlite`（`DatabaseSync`），不需要 better-sqlite3 /
 *   sqlite-vec 之类的原生依赖，也就没有 asarUnpack / 交叉编译问题。
 * - 向量按 float32 BLOB 存；查询在主进程用 Float32Array 做精确余弦（10 万块 ≈ 100ms 量级），
 *   渲染层只拿 top-K，不把整库向量搬进 UI 进程。
 *
 * 文件布局（与 `.kb` 同目录、同名前缀）：
 *   xxx.kb       manifest：切片文本 / 本体 / 社区 / 测试结果引用（3.1 起不再内联向量与测试结果）
 *   xxx.kbdb     本模块：chunks + vectors + meta（可 VACUUM INTO 导出成单文件拷贝给同事）
 *
 * ⚠️ 这是**存储层**，尚未接管现有检索路径（kbRetrieval 仍读 .kb 内联向量）：
 *    下一步在迁移完成后再把检索切到 `query()`，保留 .kb 内联向量作为回退。
 */

import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'

const requireNode = createRequire(import.meta.url)

/** node:sqlite 的 DatabaseSync（@types/node 20 尚无类型，这里按 any 用） */
type DatabaseSyncLike = {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: any[]): { changes?: number }
    get(...params: any[]): any
    all(...params: any[]): any[]
    iterate?(...params: any[]): Iterable<any>
  }
  close(): void
}

export interface KbVectorChunkInput {
  /** 稳定 id（建议用切片 id；同一 id 重复写入会覆盖） */
  id: string
  /** 原始文件路径（删除按文件批量删时用） */
  file: string
  label?: string
  /** 文件内顺序（可选，仅用于展示/排序） */
  ordinal?: number
  text: string
  /** 内容哈希：不变则跳过重写（增量 upsert） */
  hash?: string
  /** float 向量（长度必须与 meta.dim 一致） */
  vector: number[]
}

export interface KbVectorQueryHit {
  id: string
  score: number
}

export interface KbVectorStoreStats {
  chunks: number
  vectors: number
  dim: number
  model: string
  metric: string
  bytes: number
  /** 存储精度：float32（默认）/ int8（每向量一个 scale，体积约 1/4） */
  quant: string
  /** 首次创建 / 最近更新时间（ISO 字符串，取自 meta） */
  createdAt?: string
  updatedAt?: string
}

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS meta(
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chunks(
    id TEXT PRIMARY KEY,
    file TEXT NOT NULL,
    label TEXT,
    ordinal INTEGER,
    text TEXT NOT NULL,
    hash TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file);
  CREATE TABLE IF NOT EXISTS vectors(
    id TEXT PRIMARY KEY,
    dim INTEGER NOT NULL,
    vec BLOB NOT NULL
  );
  CREATE TABLE IF NOT EXISTS file_vectors(
    file TEXT PRIMARY KEY,
    dim INTEGER NOT NULL,
    vec BLOB NOT NULL,
    hash TEXT
  );
`

/**
 * 向量编码：
 * - float32：4 字节/维；
 * - int8：前 4 字节 float32 scale + 每维 1 字节有符号码（体积约 1/4）。
 * 都写进同一个 `vec` BLOB，靠 meta.quant 区分，老库无需迁移。
 */
function encodeVector(vec: number[], dim: number, quant: string): Buffer {
  if (quant !== 'int8') return Buffer.from(Float32Array.from(vec).buffer)
  let max = 0
  for (let i = 0; i < dim; i += 1) {
    const a = Math.abs(vec[i])
    if (a > max) max = a
  }
  const scale = max > 0 ? max / 127 : 1
  const out = Buffer.alloc(4 + dim)
  out.writeFloatLE(scale, 0)
  for (let i = 0; i < dim; i += 1) {
    out[4 + i] = Math.max(-127, Math.min(127, Math.round(vec[i] / scale)))
  }
  return out
}

/** 把 BLOB 解码到目标矩阵（int8 时按 scale 还原） */
function decodeVectorInto(buf: Buffer, dim: number, quant: string, target: Float32Array, offset: number): void {
  if (quant === 'int8' && buf.byteLength >= 4 + dim) {
    const scale = buf.readFloatLE(0)
    for (let i = 0; i < dim; i += 1) target[offset + i] = buf.readInt8(4 + i) * scale
    return
  }
  const view = new Float32Array(buf.buffer, buf.byteOffset, Math.min(dim, Math.floor(buf.byteLength / 4)))
  target.set(view, offset)
}

/** 探测当前运行时是否支持 node:sqlite（浏览器/LAN 虚拟环境不支持） */
export function isVectorStoreAvailable(): boolean {
  return vectorStoreAvailability().available
}

/**
 * 探测并**带回原因**：区分「运行时没有 node:sqlite」和「IPC 通道没注册（主进程没重启）」，
 * 这两种情况的处理方式完全不同，界面要能说清楚。
 */
export function vectorStoreAvailability(): { available: boolean; node?: string; error?: string } {
  try {
    requireNode('node:sqlite')
    return { available: true, node: process.versions.node }
  } catch (e: any) {
    return { available: false, node: process.versions.node, error: String(e?.message || e) }
  }
}

function loadSqlite(): { DatabaseSync: new (p: string) => DatabaseSyncLike } {
  const mod = requireNode('node:sqlite') as any
  if (!mod?.DatabaseSync) throw new Error('node:sqlite 不可用（当前运行时未内置 SQLite）')
  return { DatabaseSync: mod.DatabaseSync }
}

export class KbVectorStore {
  private db: DatabaseSyncLike
  private closed = false
  /** 查询缓存：id 顺序 + 连续 float32 矩阵（首次查询时从 BLOB 载入，写操作后失效） */
  private idCache: string[] | null = null
  private matrixCache: Float32Array | null = null
  /** int8 时的缓存：码值与每行 scale（避免查询时把整库解码成 float32） */
  private q8Cache: Int8Array | null = null
  private scaleCache: Float32Array | null = null
  private dimCache = 0

  private constructor(
    private readonly filePath: string,
    db: DatabaseSyncLike,
  ) {
    this.db = db
  }

  static open(kbdbPath: string): KbVectorStore {
    const { DatabaseSync } = loadSqlite()
    fs.mkdirSync(path.dirname(kbdbPath), { recursive: true })
    const db = new DatabaseSync(kbdbPath)
    db.exec(SCHEMA)
    // 老库迁移：file_vectors 补 hash 列（用于判断"摘要没变就跳过/变了就重算"）
    try {
      const cols = db.prepare('PRAGMA table_info(file_vectors)').all().map((r: any) => String(r.name))
      if (!cols.includes('hash')) db.exec('ALTER TABLE file_vectors ADD COLUMN hash TEXT')
    } catch { /* 忽略：表刚建或权限异常 */ }
    return new KbVectorStore(kbdbPath, db)
  }

  get path(): string {
    return this.filePath
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('向量库已关闭')
  }

  private invalidateCache(): void {
    this.idCache = null
    this.matrixCache = null
    this.q8Cache = null
    this.scaleCache = null
  }

  /** 写入/更新元信息（模型、维度、来源 .kb 等）；自动维护 created_at / updated_at */
  writeMeta(meta: Record<string, string | number>): void {
    this.assertOpen()
    const existing = this.getMeta()
    const now = new Date().toISOString()
    const rows: Record<string, string | number> = { ...meta, updated_at: now }
    if (!existing.created_at) rows.created_at = now
    const stmt = this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    this.db.exec('BEGIN')
    try {
      for (const [k, v] of Object.entries(rows)) stmt.run(String(k), String(v))
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  getMeta(): Record<string, string> {
    this.assertOpen()
    const out: Record<string, string> = {}
    for (const row of this.db.prepare('SELECT key, value FROM meta').all()) out[String(row.key)] = String(row.value)
    return out
  }

  /** 现有 chunk id → hash（增量更新时判断"内容没变就跳过"） */
  private existingHashes(): Map<string, string> {
    const map = new Map<string, string>()
    for (const row of this.db.prepare('SELECT id, hash FROM chunks').all()) {
      map.set(String(row.id), String(row.hash ?? ''))
    }
    return map
  }

  /**
   * 批量 upsert（事务）。返回 { written, skipped }：hash 未变的块跳过重写。
   * 向量长度必须一致（由调用方保证；这里校验并报错，避免混入不同嵌入模型的向量）。
   */
  upsertChunks(chunks: KbVectorChunkInput[], opts: { quant?: string } = {}): { written: number; skipped: number } {
    this.assertOpen()
    if (!chunks.length) return { written: 0, skipped: 0 }
    const dim = chunks[0].vector.length
    if (!dim) throw new Error('向量为空：dim=0')
    for (const c of chunks) {
      if (!c.vector || c.vector.length !== dim) {
        throw new Error(`向量维度不一致：期望 ${dim}，${c.id} 是 ${c.vector?.length ?? 0}`)
      }
    }
    // 精度：int8 时把每个向量编码成「float32 scale + int8 码」，体积约 1/4（vec 列仍是 BLOB，老库无需迁移）
    const quant = String(opts.quant || this.getMeta().quant || 'float32').toLowerCase() === 'int8' ? 'int8' : 'float32'
    if (quant === 'int8') this.writeMeta({ quant })
    const existing = this.existingHashes()
    const chunkStmt = this.db.prepare(
      `INSERT INTO chunks(id, file, label, ordinal, text, hash) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET file=excluded.file, label=excluded.label, ordinal=excluded.ordinal,
         text=excluded.text, hash=excluded.hash`,
    )
    const vecStmt = this.db.prepare(
      `INSERT INTO vectors(id, dim, vec) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET dim=excluded.dim, vec=excluded.vec`,
    )
    let written = 0
    let skipped = 0
    this.db.exec('BEGIN')
    try {
      for (const c of chunks) {
        if (c.hash && existing.get(c.id) === c.hash) {
          skipped += 1
          continue
        }
        chunkStmt.run(c.id, c.file, c.label ?? null, c.ordinal ?? null, c.text, c.hash ?? null)
        vecStmt.run(c.id, dim, encodeVector(c.vector, dim, quant))
        written += 1
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    if (written) this.invalidateCache()
    return { written, skipped }
  }

  /** 删除某个文件的所有切片（文件被删/改名时用） */
  deleteByFile(file: string): number {
    this.assertOpen()
    const before = this.db.prepare('SELECT COUNT(*) c FROM chunks WHERE file = ?').get(file)
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM vectors WHERE id IN (SELECT id FROM chunks WHERE file = ?)').run(file)
      this.db.prepare('DELETE FROM chunks WHERE file = ?').run(file)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    this.invalidateCache()
    return Number(before?.c) || 0
  }

  /** 把 BLOB 载入连续 Float32Array（一次全量；写操作后失效） */
  private ensureCache(): {
    ids: string[]; dim: number; matrix: Float32Array | null; q8: Int8Array | null; scales: Float32Array | null
  } {
    const dim = Number(this.getMeta().dim) || 0
    if (!dim) throw new Error('向量库缺少 dim：先 writeMeta({ dim })')
    const quant = this.getMeta().quant === 'int8' ? 'int8' : 'float32'
    if (this.idCache && this.dimCache === dim && (quant === 'int8' ? this.q8Cache && this.scaleCache : this.matrixCache)) {
      return {
        ids: this.idCache, dim,
        matrix: quant === 'int8' ? null : this.matrixCache,
        q8: quant === 'int8' ? this.q8Cache : null,
        scales: quant === 'int8' ? this.scaleCache : null,
      }
    }
    const count = Number(this.db.prepare('SELECT COUNT(*) c FROM vectors WHERE dim = ?').get(dim)?.c) || 0
    const ids: string[] = []
    let matrix: Float32Array | null = null
    let q8: Int8Array | null = null
    let scales: Float32Array | null = null
    if (quant === 'int8') {
      q8 = new Int8Array(count * dim)
      scales = new Float32Array(count)
    } else {
      matrix = new Float32Array(count * dim)
    }
    const rows = this.db.prepare('SELECT id, vec FROM vectors WHERE dim = ? ORDER BY rowid').all(dim)
    let i = 0
    for (const row of rows) {
      const buf = Buffer.isBuffer(row.vec) ? row.vec : Buffer.from(row.vec)
      if (quant === 'int8' && q8 && scales) {
        const scale = buf.readFloatLE(0)
        scales[i] = scale
        const base = i * dim
        for (let j = 0; j < dim; j += 1) q8[base + j] = buf.readInt8(4 + j)
      } else if (matrix) {
        decodeVectorInto(buf, dim, quant, matrix, i * dim)
      }
      ids.push(String(row.id))
      i += 1
    }
    this.idCache = ids
    this.matrixCache = matrix
    this.q8Cache = q8
    this.scaleCache = scales
    this.dimCache = dim
    return { ids, dim, matrix, q8, scales }
  }

  /**
   * 精确余弦 topK（主进程内，不把向量交给渲染层）。
   * `file` 可选：先按文件过滤 id 再算分（用于"只在这个文件里找"这类请求）。
   */
  query(vector: number[], topK = 10, filter?: { file?: string; minScore?: number }): KbVectorQueryHit[] {
    this.assertOpen()
    if (!vector?.length) return []
    const { ids, matrix, q8, scales, dim } = this.ensureCache()
    if (vector.length !== dim) throw new Error(`查询向量维度 ${vector.length} ≠ 库维度 ${dim}`)
    const q = Float32Array.from(vector)
    let qn = 0
    for (let i = 0; i < dim; i += 1) qn += q[i] * q[i]
    qn = Math.sqrt(qn) || 1

    let allowed: Set<string> | null = null
    if (filter?.file) {
      allowed = new Set(
        this.db.prepare('SELECT id FROM chunks WHERE file = ?').all(filter.file).map((r: any) => String(r.id)),
      )
    }
    const hits: KbVectorQueryHit[] = []
    for (let b = 0; b < ids.length; b += 1) {
      if (allowed && !allowed.has(ids[b])) continue
      const base = b * dim
      let dot = 0
      let norm = 0
      if (q8 && scales) {
        // int8：直接用码值 × 每行 scale 做点积，内存保持 1/4，不解码整库
        const s = scales[b] || 1
        for (let i = 0; i < dim; i += 1) {
          const x = q8[base + i] * s
          dot += x * q[i]
          norm += x * x
        }
      } else if (matrix) {
        for (let i = 0; i < dim; i += 1) {
          const x = matrix[base + i]
          dot += x * q[i]
          norm += x * x
        }
      }
      const score = dot / (Math.sqrt(norm) * qn || 1)
      if (filter?.minScore !== undefined && score < filter.minScore) continue
      hits.push({ id: ids[b], score })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, Math.max(1, topK))
  }

  /** 取若干切片正文（查询后由调用方按 id 回源） */
  getChunks(ids: string[]): Array<{ id: string; file: string; label: string; text: string }> {
    this.assertOpen()
    if (!ids.length) return []
    const out: Array<{ id: string; file: string; label: string; text: string }> = []
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db.prepare(`SELECT id, file, label, text FROM chunks WHERE id IN (${placeholders})`).all(...ids)
    const byId = new Map(rows.map((r: any) => [String(r.id), r]))
    for (const id of ids) {
      const r = byId.get(id)
      if (r) out.push({ id, file: String(r.file), label: String(r.label ?? ''), text: String(r.text) })
    }
    return out
  }

  /**
   * 按 id 取向量（float 数组）。用于检索：只把候选切片的向量取回渲染层，
   * 让旧的打分逻辑在"3.2 不再内联向量"的 .kb 上也能工作。
   */
  getVectors(ids: string[]): Map<string, number[]> {
    this.assertOpen()
    const out = new Map<string, number[]>()
    if (!ids.length) return out
    const dim = Number(this.getMeta().dim) || 0
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db.prepare(`SELECT id, vec FROM vectors WHERE id IN (${placeholders})`).all(...ids)
    const quant = this.getMeta().quant === 'int8' ? 'int8' : 'float32'
    for (const row of rows) {
      const buf = Buffer.isBuffer(row.vec) ? row.vec : Buffer.from(row.vec)
      const len = dim || (quant === 'int8' ? Math.max(0, buf.byteLength - 4) : Math.floor(buf.byteLength / 4))
      const decoded = new Float32Array(len)
      decodeVectorInto(buf, len, quant, decoded, 0)
      out.set(String(row.id), Array.from(decoded))
    }
    return out
  }

  /**
   * 写入文件级摘要向量（fileIndex 的 vector）。3.2 的 `.kb` 不再内联这些向量，
   * 检索时从这里取，避免每次会话都重新嵌入文件摘要。
   */
  upsertFileVectors(items: Array<{ file: string; vector: number[]; hash?: string }>, opts: { quant?: string } = {}): { written: number; skipped: number } {
    this.assertOpen()
    if (!items.length) return { written: 0, skipped: 0 }
    const dim = items[0].vector?.length || 0
    if (!dim) return { written: 0, skipped: 0 }
    const quant = String(opts.quant || this.getMeta().quant || 'float32').toLowerCase() === 'int8' ? 'int8' : 'float32'
    if (quant === 'int8') this.writeMeta({ quant })
    const existing = new Map<string, string>()
    for (const row of this.db.prepare('SELECT file, hash FROM file_vectors').all()) {
      existing.set(String(row.file), String(row.hash ?? ''))
    }
    const stmt = this.db.prepare(
      `INSERT INTO file_vectors(file, dim, vec, hash) VALUES (?, ?, ?, ?)
       ON CONFLICT(file) DO UPDATE SET dim=excluded.dim, vec=excluded.vec, hash=excluded.hash`,
    )
    let written = 0
    let skipped = 0
    this.db.exec('BEGIN')
    try {
      for (const it of items) {
        if (!it.vector || it.vector.length !== dim) continue
        // 内容 hash 未变：跳过重写（避免每次保存都重编码）
        if (it.hash && existing.get(it.file) === it.hash) {
          skipped += 1
          continue
        }
        stmt.run(it.file, dim, encodeVector(it.vector, dim, quant), it.hash ?? null)
        written += 1
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return { written, skipped }
  }

  /** 按文件路径取文件级摘要向量 + hash（hash 用于判断摘要是否过期） */
  getFileVectors(files: string[]): Map<string, { vector: number[]; hash: string }> {
    this.assertOpen()
    const out = new Map<string, { vector: number[]; hash: string }>()
    if (!files.length) return out
    const quant = this.getMeta().quant === 'int8' ? 'int8' : 'float32'
    const placeholders = files.map(() => '?').join(',')
    const rows = this.db.prepare(`SELECT file, dim, vec, hash FROM file_vectors WHERE file IN (${placeholders})`).all(...files)
    for (const row of rows) {
      const dim = Number(row.dim) || 0
      if (!dim) continue
      const buf = Buffer.isBuffer(row.vec) ? row.vec : Buffer.from(row.vec)
      const decoded = new Float32Array(dim)
      decodeVectorInto(buf, dim, quant, decoded, 0)
      out.set(String(row.file), { vector: Array.from(decoded), hash: String(row.hash ?? '') })
    }
    return out
  }

  /** 清理已不存在的切片/文件向量（chunks.vectors 按 block id，file_vectors 按文件路径） */
  reconcile(blockIds: string[], filePaths: string[]): { chunks: number; files: number } {
    this.assertOpen()
    const keepIds = new Set(blockIds.map(String))
    const keepFiles = new Set(filePaths.map(String))
    let removedChunks = 0
    let removedFiles = 0
    const staleIds = this.db.prepare('SELECT id FROM chunks').all()
      .map((r: any) => String(r.id)).filter((id) => !keepIds.has(id))
    const staleFiles = this.db.prepare('SELECT file FROM file_vectors').all()
      .map((r: any) => String(r.file)).filter((f) => !keepFiles.has(f))
    if (staleIds.length || staleFiles.length) {
      const delVec = this.db.prepare('DELETE FROM vectors WHERE id = ?')
      const delChunk = this.db.prepare('DELETE FROM chunks WHERE id = ?')
      const delFile = this.db.prepare('DELETE FROM file_vectors WHERE file = ?')
      this.db.exec('BEGIN')
      try {
        for (const id of staleIds) { delVec.run(id); delChunk.run(id); removedChunks += 1 }
        for (const f of staleFiles) { delFile.run(f); removedFiles += 1 }
        this.db.exec('COMMIT')
      } catch (e) {
        this.db.exec('ROLLBACK')
        throw e
      }
      if (removedChunks) this.invalidateCache()
    }
    return { chunks: removedChunks, files: removedFiles }
  }

  /** 文件级向量 topK（文件数通常很小，直接全量算） */
  queryFileVectors(vector: number[], topK = 10): Array<{ file: string; score: number }> {
    this.assertOpen()
    if (!vector?.length) return []
    const quant = this.getMeta().quant === 'int8' ? 'int8' : 'float32'
    const rows = this.db.prepare('SELECT file, dim, vec FROM file_vectors').all()
    const q = Float32Array.from(vector)
    let qn = 0
    for (let i = 0; i < q.length; i += 1) qn += q[i] * q[i]
    qn = Math.sqrt(qn) || 1
    const hits: Array<{ file: string; score: number }> = []
    for (const row of rows) {
      const dim = Number(row.dim) || 0
      if (dim !== vector.length) continue
      const buf = Buffer.isBuffer(row.vec) ? row.vec : Buffer.from(row.vec)
      const v = new Float32Array(dim)
      decodeVectorInto(buf, dim, quant, v, 0)
      let dot = 0
      let norm = 0
      for (let i = 0; i < dim; i += 1) {
        dot += v[i] * q[i]
        norm += v[i] * v[i]
      }
      hits.push({ file: String(row.file), score: dot / (Math.sqrt(norm) * qn || 1) })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, Math.max(1, topK))
  }

  stats(): KbVectorStoreStats {
    this.assertOpen()
    const meta = this.getMeta()
    const chunks = Number(this.db.prepare('SELECT COUNT(*) c FROM chunks').get()?.c) || 0
    const vectors = Number(this.db.prepare('SELECT COUNT(*) c FROM vectors').get()?.c) || 0    // WAL 模式下新写入的数据先在 -wal 里：体积要把两个文件都算上，
    // 否则刚写完的库会显示成"只有 4KB"。
    let bytes = 0
    for (const f of [this.filePath, `${this.filePath}-wal`]) {
      try { bytes += fs.statSync(f).size } catch { /* 文件还不存在 */ }
    }
    return {
      chunks,
      vectors,
      dim: Number(meta.dim) || 0,
      model: meta.model || '',
      metric: meta.metric || 'cosine',
      bytes,
      quant: meta.quant === 'int8' ? 'int8' : 'float32',
      createdAt: meta.created_at || '',
      updatedAt: meta.updated_at || '',
    }
  }

  /** 丢弃查询缓存（同一时刻只保留最近使用的那份矩阵，避免多库叠加大内存） */
  dropCache(): void {
    this.invalidateCache()
  }

  /** 导出干净单文件（不带 -wal/-shm），用于"拷给同事" */
  vacuumInto(targetPath: string): void {
    this.assertOpen()
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    const escaped = targetPath.replace(/'/g, "''")
    this.db.exec(`VACUUM INTO '${escaped}'`)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      // 关闭前把 WAL 落回主文件：否则"复制 .kbdb 到新版本"时刚写入的向量可能还在 -wal 里
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch { /* 只读/已关闭：忽略 */ }
    try {
      this.db.close()
    } catch { /* ignore */ }
  }
}

/** 便捷：按 .kb 路径推导默认 .kbdb 路径（同目录、同名前缀） */
export function kbdbPathFor(kbPath: string): string {
  return String(kbPath || '').replace(/\.kb$/i, '') + '.kbdb'
}

/**
 * 进程内打开缓存：主进程同一时刻只保留最近使用的 1–2 个库，
 * 并**只让最近使用的那个持有向量矩阵**（10 万块 float32 ≈ 293MB，多份叠加会吃满内存）。
 */
interface CachedStore {
  store: KbVectorStore
  mtimeMs: number
  size: number
}
const openedStores = new Map<string, CachedStore>()

function statStamp(p: string): { mtimeMs: number; size: number } {
  try {
    const st = fs.statSync(p)
    return { mtimeMs: st.mtimeMs, size: st.size }
  } catch {
    return { mtimeMs: 0, size: 0 }
  }
}

export function openCachedKbVectorStore(kbdbPath: string): KbVectorStore {
  const key = path.resolve(kbdbPath)
  const stamp = statStamp(key)
  const hit = openedStores.get(key)
  // 文件被外部替换/修改（或删掉后重建）：缓存里的句柄与矩阵都作废
  if (hit && hit.mtimeMs === stamp.mtimeMs && hit.size === stamp.size) {
    openedStores.delete(key)
    openedStores.set(key, hit)
    for (const [k, c] of openedStores) if (k !== key) c.store.dropCache()
    return hit.store
  }
  if (hit) {
    try { hit.store.close() } catch { /* ignore */ }
    openedStores.delete(key)
  }
  const store = KbVectorStore.open(key)
  const fresh = statStamp(key)
  openedStores.set(key, { store, mtimeMs: fresh.mtimeMs, size: fresh.size })
  while (openedStores.size > 2) {
    const oldest = openedStores.keys().next().value as string | undefined
    if (!oldest || oldest === key) break
    openedStores.get(oldest)?.store.close()
    openedStores.delete(oldest)
  }
  for (const [k, c] of openedStores) if (k !== key) c.store.dropCache()
  return store
}

/** 关闭所有缓存库（退出/重建索引前调用） */
export function closeAllCachedKbVectorStores(): void {
  for (const c of openedStores.values()) c.store.close()
  openedStores.clear()
}

/** 关闭并移出缓存里的某个库（删除 .kbdb 前调用，避免 Windows 上文件被占用） */
export function closeCachedKbVectorStore(kbdbPath: string): void {
  const key = path.resolve(kbdbPath)
  const cached = openedStores.get(key)
  if (!cached) return
  try { cached.store.close() } catch { /* ignore */ }
  openedStores.delete(key)
}
