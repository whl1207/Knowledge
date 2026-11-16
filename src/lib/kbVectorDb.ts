/**
 * kbVectorDb.ts — 知识库向量库（`.kbdb`）的渲染层薄封装
 *
 * 真正的读写都在主进程（`electron/main/kb-vector-store.ts`，SQLite + float32 BLOB），
 * 这里只负责：拼路径、批量搬运、把进度回给调用方。渲染层**不持有整库向量**。
 *
 * 约定：
 * - `.kbdb` 与 `.kb` 同目录同名前缀（`xxx.kb` → `xxx.kbdb`），可直接拷给同事；
 * - 迁移/增量都按 `contentHash` 做跳过（同内容不重写）；
 * - 没有 `node:sqlite` 的运行时（浏览器/安卓）会返回 `available:false`，调用方自行降级。
 */

import { aikmIpc } from '@/lib/aikmIpc'

export interface KbVectorDbStats {
  chunks: number
  vectors: number
  dim: number
  model: string
  metric: string
  bytes: number
  /** float32 / int8 */
  quant?: string
  createdAt?: string
  updatedAt?: string
}

export interface KbVectorDbInfo {
  exists: boolean
  path: string
  stats: KbVectorDbStats
  /** true = 当前用的是 xxx.portable.kbdb（正式 .kbdb 不存在时的回退） */
  portable?: boolean
}

/** `.kb` → 同目录同名 `.kbdb` */
export function kbdbPathOf(kbPath: string): string {
  return String(kbPath || '').replace(/\.kb$/i, '') + '.kbdb'
}

function ipcReady(): boolean {
  return typeof aikmIpc?.invoke === 'function'
}

export interface KbVectorAvailability {
  available: boolean
  /** 主进程 Node 版本（探测成功/失败都有） */
  node?: string
  electron?: string
  /** 失败原因：node:sqlite 缺失 / 通道未注册（主进程没重启）等 */
  error?: string
  channel?: string
}

/**
 * 调用 `registerIpc` 注册的命名空间通道。
 *
 * ⚠️ `aikmIpc.invoke` 走的是 preload 的**原始** `ipcRenderer.invoke`，拿到的是
 * `{ ok, data } | { ok:false, error }` 信封（不是解包后的数据）。以前这里直接当数据用，
 * 于是 `probe.available` 是 undefined → 界面误报"当前环境不支持向量库"。
 * 这里统一解包，并在通道不存在（主进程没重启）时把原始错误抛给调用方。
 */
async function invokeData<T>(channel: string, payload?: unknown): Promise<T> {
  if (!ipcReady()) throw new Error('IPC 不可用（请在 Electron 中运行）')
  const res: any = await aikmIpc.invoke(channel, payload)
  if (res && typeof res === 'object' && 'ok' in res) {
    if (res.ok) return res.data as T
    const err: any = new Error(res.error?.message || 'IPC 调用失败')
    err.code = res.error?.code
    throw err
  }
  return res as T
}

/**
 * 当前运行环境是否支持 .kbdb（Electron 主进程内置 node:sqlite）。
 * 失败时带回原因，界面可据此区分「主进程没重启」与「运行时真的没有 sqlite」。
 */
export async function isVectorDbAvailable(): Promise<KbVectorAvailability> {
  if (!ipcReady()) return { available: false, error: 'IPC 不可用（请在 Electron 中运行）' }
  try {
    return await invokeData<KbVectorAvailability>('kb:vector:available')
  } catch (e: any) {
    return { available: false, error: String(e?.message || e || '未知错误') }
  }
}

/** 读取 `.kbdb` 状态（文件不存在时返回 exists:false，不会顺手建库） */
export async function getVectorDbInfo(kbPath: string): Promise<KbVectorDbInfo | null> {
  if (!ipcReady() || !kbPath) return null
  return await invokeData<KbVectorDbInfo>('kb:vector:stats', { kbPath })
}

/** 知识库切片（只取迁移需要的字段；`A_vector` 是 `.kb` 里的内联向量） */
export interface KbVectorBlockLike {
  id?: string
  filePath?: string
  path?: string
  label?: string
  A?: string
  contentHash?: string
  A_vector?: number[]
}

export interface KbVectorChunkPayload {
  id: string
  file: string
  label: string
  ordinal: number
  text: string
  hash: string
  vector: number[]
}

/** 把 `.kb` 的 blocks 转成向量库写入载荷；没有向量的块跳过（精简模式） */
export function buildVectorChunks(blocks: KbVectorBlockLike[]): {
  chunks: KbVectorChunkPayload[]
  total: number
  skippedNoVector: number
  dim: number
} {
  const chunks: KbVectorChunkPayload[] = []
  let skippedNoVector = 0
  let dim = 0
  ;(blocks || []).forEach((b, i) => {
    const vec = b?.A_vector
    if (!Array.isArray(vec) || !vec.length) {
      skippedNoVector += 1
      return
    }
    if (!dim) dim = vec.length
    if (vec.length !== dim) return // 混入不同维度：跳过，避免污染索引
    const file = String(b.filePath || b.path || '')
    const text = String(b.A || '')
    chunks.push({
      id: String(b.id || `${file}#${i}`),
      file,
      label: String(b.label || ''),
      ordinal: i,
      text,
      // contentHash 是首选；没有时用长度兜底（至少能识别"明显没变"）
      hash: String(b.contentHash || `len:${text.length}:${vec.length}`),
      vector: vec,
    })
  })
  return { chunks, total: chunks.length, skippedNoVector, dim }
}

/** 批量写入（单批默认 400 条，避免一次 IPC 载荷过大） */
export async function upsertVectorChunks(
  kbPath: string,
  chunks: KbVectorChunkPayload[],
  opts: { model?: string; dim?: number; batchSize?: number; quant?: string; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ written: number; skipped: number }> {
  if (!ipcReady()) throw new Error('IPC 不可用（请在 Electron 中运行）')
  if (!chunks.length) return { written: 0, skipped: 0 }
  const batchSize = Math.max(1, Math.min(1000, opts.batchSize || 400))
  let written = 0
  let skipped = 0
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize)
    const res = await invokeData<{ written?: number; skipped?: number }>('kb:vector:upsert', {
      kbPath,
      model: opts.model || '',
      dim: opts.dim || batch[0]?.vector?.length,
      quant: opts.quant || '',
      chunks: batch,
    })
    written += Number(res?.written) || 0
    skipped += Number(res?.skipped) || 0
    opts.onProgress?.(Math.min(chunks.length, i + batch.length), chunks.length)
  }
  return { written, skipped }
}

/**
 * 首次迁移/重建：把 `.kb` 里已有的向量批量搬进 `.kbdb`。
 * `onProgress(done, total)` 按批回调（调用方用它写状态栏）。
 */
export async function migrateKbToVectorDb(
  kbPath: string,
  blocks: KbVectorBlockLike[],
  opts: { model?: string; batchSize?: number; quant?: string; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ total: number; written: number; skipped: number; skippedNoVector: number; dim: number }> {
  const { chunks, total, skippedNoVector, dim } = buildVectorChunks(blocks)
  if (!total) return { total: 0, written: 0, skipped: 0, skippedNoVector, dim: 0 }
  const batchSize = Math.max(1, Math.min(1000, opts.batchSize || 400))
  let written = 0
  let skipped = 0
  let done = 0
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize)
    const res = await invokeData<{ written?: number; skipped?: number }>('kb:vector:upsert', {
      kbPath,
      model: opts.model || '',
      dim,
      quant: opts.quant || '',
      chunks: batch,
    })
    written += Number(res?.written) || 0
    skipped += Number(res?.skipped) || 0
    done += batch.length
    opts.onProgress?.(done, total)
  }
  return { total, written, skipped, skippedNoVector, dim }
}

/**
 * 保存 `.kb` 之后调用：**只有 `.kbdb` 已存在时**才增量同步（内容未变的块由 hash 跳过）。
 * 返回 null 表示这个库还没启用向量库（用户没迁移过），调用方无需提示。
 */
export async function syncVectorDbAfterSave(
  kbPath: string,
  blocks: KbVectorBlockLike[],
  model?: string,
): Promise<{ total: number; written: number; skipped: number } | null> {
  try {
    const info = await getVectorDbInfo(kbPath)
    if (!info?.exists) return null
    const { chunks, total } = buildVectorChunks(blocks)
    if (!total) return null
    const { written, skipped } = await upsertVectorChunks(kbPath, chunks, { model, batchSize: 400 })
    return { total, written, skipped }
  } catch (e) {
    console.warn('[kbVectorDb] 保存后增量同步失败（不影响 .kb）:', e)
    return null
  }
}

/** 按 id 取向量（只取候选切片，避免整库搬运） */
export async function getVectorDbVectors(kbPath: string, ids: string[]): Promise<Map<string, number[]>> {  if (!ipcReady() || !ids.length) return new Map()
  const res = await invokeData<{ vectors: Array<{ id: string; vector: number[] }> }>('kb:vector:vectors', { kbPath, ids })
  const map = new Map<string, number[]>()
  for (const item of res?.vectors || []) {
    if (item?.id && Array.isArray(item.vector)) map.set(String(item.id), item.vector)
  }
  return map
}

/** 文件级摘要向量：写入 `.kbdb`（3.2 下不内联到 .kb）；带 hash，摘要未变时库内跳过重写 */
export async function upsertFileVectorsToDb(
  kbPath: string,
  items: Array<{ file: string; vector: number[]; hash?: string }>,
  quant?: string,
): Promise<{ written: number; skipped: number }> {
  if (!ipcReady() || !items.length) return { written: 0, skipped: 0 }
  const res = await invokeData<{ written?: number; skipped?: number }>('kb:vector:file-upsert', { kbPath, items, quant: quant || '' })
  return { written: Number(res?.written) || 0, skipped: Number(res?.skipped) || 0 }
}

/** 文件级摘要向量：从 `.kbdb` 取回（含 hash，调用方据此判断摘要是否过期） */
export async function getFileVectorsFromDb(
  kbPath: string,
  files: string[],
): Promise<Map<string, { vector: number[]; hash: string }>> {
  if (!ipcReady() || !files.length) return new Map()
  const res = await invokeData<{ vectors: Array<{ file: string; vector: number[]; hash?: string }> }>('kb:vector:file-vectors', { kbPath, files })
  const map = new Map<string, { vector: number[]; hash: string }>()
  for (const it of res?.vectors || []) {
    if (it?.file && Array.isArray(it.vector)) map.set(String(it.file), { vector: it.vector, hash: String(it.hash || '') })
  }
  return map
}

/** 清理已删除文件/切片的向量 */
export async function reconcileVectorDb(
  kbPath: string,
  blockIds: string[],
  files: string[],
): Promise<{ chunks: number; files: number }> {
  if (!ipcReady()) return { chunks: 0, files: 0 }
  const res = await invokeData<{ chunks?: number; files?: number }>('kb:vector:reconcile', { kbPath, blockIds, files })
  return { chunks: Number(res?.chunks) || 0, files: Number(res?.files) || 0 }
}

/** 用临时库原子替换目标库（重建向量库用） */
export async function replaceVectorDb(targetKbPath: string, tempKbPath: string): Promise<void> {
  if (!ipcReady()) throw new Error('IPC 不可用（请在 Electron 中运行）')
  await invokeData('kb:vector:replace', { targetKbPath, tempKbPath })
}

/** topK 查询（渲染层用：只拿 id + 分数，正文/向量按需再取） */
export async function queryVectorDb(
  kbPath: string,
  vector: number[],
  topK: number,
): Promise<Array<{ id: string; score: number }>> {
  if (!ipcReady() || !vector?.length) return []
  const res = await invokeData<{ hits: Array<{ id: string; score: number }> }>('kb:vector:query', {
    kbPath,
    vector,
    topK,
    hydrate: false,
  })
  return Array.isArray(res?.hits) ? res.hits : []
}

/**
 * 把查询向量对应的 topN 候选切片的向量从 `.kbdb` 取回，写进 blocks[].A_vector。
 * 用于 KB 模块内部的策略检索路径（`runStrategy` 直接读内存向量，不走 retrieveKnowledge）：
 * 3.2 的 `.kb` 没有内联向量，不补这一步 dense_score 会全为 0。
 */
export async function hydrateBlockVectorsFromDb(
  kbPath: string,
  queryVector: number[],
  blocks: any[],
  topN = 300,
): Promise<number> {
  if (!ipcReady() || !kbPath || !queryVector?.length || !blocks?.length) return 0
  try {
    const info = await getVectorDbInfo(kbPath)
    if (!info?.exists || !info.stats.vectors) return 0
    const hits = await queryVectorDb(kbPath, queryVector, topN)
    if (!hits.length) return 0
    const vecs = await getVectorDbVectors(kbPath, hits.map((h) => String(h.id)))
    if (!vecs.size) return 0
    const byId = new Map<string, any>()
    for (const b of blocks) byId.set(String(b?.id ?? ''), b)
    let n = 0
    for (const [id, v] of vecs) {
      const b = byId.get(id)
      if (b && Array.isArray(v) && v.length) {
        b.A_vector = v
        n += 1
      }
    }
    return n
  } catch (e) {
    console.warn('[kbVectorDb] 从 .kbdb 补候选向量失败:', e)
    return 0
  }
}

/** 超大 .kb 流式迁移（主进程边读边写库 + 瘦身），返回摘要 */
export async function slimLegacyKb(kbPath: string): Promise<{
  ok: boolean
  blocks?: number
  vectors?: number
  beforeBytes?: number
  afterBytes?: number
  backupPath?: string
  dbPath?: string
  testDataFile?: string
  error?: string
}> {
  if (!ipcReady()) throw new Error('IPC 不可用（请在 Electron 中运行）')
  return await invokeData('kb:vector:slim-large', { kbPath })
}

/** 导出干净单文件（`xxx.portable.kbdb`，不带 -wal/-shm），用于拷给同事 */
export async function exportVectorDbPortable(kbPath: string): Promise<{ target: string; bytes: number }> {
  if (!ipcReady()) throw new Error('IPC 不可用（请在 Electron 中运行）')
  const target = kbdbPathOf(kbPath).replace(/\.kbdb$/i, '') + '.portable.kbdb'
  return await invokeData<{ target: string; bytes: number }>('kb:vector:vacuum', { kbPath, target })
}

/** 删除 `.kbdb`（含 -wal/-shm），并释放主进程里的句柄 */
export async function deleteVectorDb(kbPath: string): Promise<{ removed: number }> {
  if (!ipcReady()) throw new Error('IPC 不可用（请在 Electron 中运行）')
  return await invokeData<{ removed: number }>('kb:vector:delete', { kbPath })
}

/** 只关句柄不删文件（移动知识库目录前用，避免 Windows 文件占用） */
export async function closeVectorDbHandle(kbPath: string): Promise<void> {
  if (!ipcReady()) return
  try {
    await invokeData('kb:vector:close', { kbPath })
  } catch { /* 忽略：没有缓存句柄时也正常 */ }
}

/** 人类可读体积 */
export function formatVectorBytes(bytes: number): string {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
