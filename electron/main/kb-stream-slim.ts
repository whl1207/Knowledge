/**
 * 超大 `.kb`（>512MB，内联向量导致 V8 字符串上限）流式迁移：
 * 边读边把 blocks 的向量写进 `.kbdb`，并把 `.kb` 重写成 3.2 瘦身版（不含 A_vector / testData）。
 *
 * 只依赖 Node 流 + 字符级 JSON 扫描，不把整个文件读成字符串。
 * 输出顺序无关；config 延迟到最后写（需要注入 vectorStore/testDataFile）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { KbVectorStore, kbdbPathFor } from './kb-vector-store'

class CharCursor {
  private readonly it: AsyncIterator<string>
  private buf = ''
  private i = 0
  private done = false

  constructor(stream: fs.ReadStream) {
    this.it = (stream as any)[Symbol.asyncIterator]()
  }

  private async fill(): Promise<boolean> {
    if (this.done) return false
    const r = await this.it.next()
    if (r.done) {
      this.done = true
      return false
    }
    this.buf = this.buf.slice(this.i) + String(r.value)
    this.i = 0
    return true
  }

  async peek(): Promise<string> {
    while (this.i >= this.buf.length) {
      if (!(await this.fill())) return ''
    }
    return this.buf[this.i]
  }

  async next(): Promise<string> {
    const c = await this.peek()
    if (c) this.i += 1
    return c
  }

  back(): void {
    if (this.i > 0) this.i -= 1
  }
}

async function skipWs(c: CharCursor): Promise<void> {
  while (true) {
    const ch = await c.peek()
    if (!ch || !/\s/.test(ch)) return
    await c.next()
  }
}

async function expect(c: CharCursor, want: string): Promise<void> {
  const got = await c.next()
  if (got !== want) throw new Error(`JSON 解析失败：期望 ${want}，实际 ${JSON.stringify(got)}`)
}

/** 读一个完整 JSON 字符串（含引号）的原始文本 */
async function readStringRaw(c: CharCursor): Promise<string> {
  await skipWs(c)
  await expect(c, '"')
  let out = '"'
  while (true) {
    const ch = await c.next()
    if (!ch) throw new Error('JSON 解析失败：字符串未结束')
    out += ch
    if (ch === '\\') {
      out += await c.next()
      continue
    }
    if (ch === '"') return out
  }
}

/** 读一个 JSON 值：返回原始文本；onChunk 存在时分片回调（不累积大字符串） */
async function readValueRaw(c: CharCursor, onChunk?: (s: string) => void | Promise<void>): Promise<string> {
  await skipWs(c)
  const first = await c.peek()
  let acc = ''
  const emit = async (s: string) => {
    if (onChunk) await onChunk(s)
    else acc += s
  }
  if (first === '"') {
    await emit(await readStringRaw(c))
    return acc
  }
  if (first !== '{' && first !== '[') {
    // 标量：读到分隔符
    while (true) {
      const ch = await c.peek()
      if (!ch || ch === ',' || ch === '}' || ch === ']' || /\s/.test(ch)) break
      await emit(await c.next())
    }
    return acc
  }
  // 对象/数组：深度 + 字符串状态
  let depth = 0
  let inStr = false
  let esc = false
  while (true) {
    const ch = await c.next()
    if (!ch) throw new Error('JSON 解析失败：值未结束')
    await emit(ch)
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{' || ch === '[') depth += 1
    else if (ch === '}' || ch === ']') {
      depth -= 1
      if (depth === 0) return acc
    }
  }
}

export interface StreamSlimResult {
  ok: boolean
  kbPath: string
  backupPath?: string
  dbPath?: string
  blocks: number
  vectors: number
  beforeBytes: number
  afterBytes: number
  testDataFile?: string
  error?: string
}

/**
 * 流式瘦身一个超大 `.kb`。
 * - 原文件改名为 `.legacy.bak`（成功后才改名，失败保持原样）；
 * - 向量写入同目录 `<stem>.kbdb`；
 * - testData 流式写到 `<stem>.testdata.json`。
 */
export async function streamSlimLegacyKb(kbPath: string): Promise<StreamSlimResult> {
  const beforeBytes = fs.statSync(kbPath).size
  const stem = kbPath.replace(/\.kb$/i, '')
  const tmpPath = `${kbPath}.slim.tmp`
  const backupPath = `${kbPath}.legacy.bak`
  const dbPath = kbdbPathFor(kbPath)
  const sidecarPath = `${stem}.testdata.json`
  const stream = fs.createReadStream(kbPath, { encoding: 'utf8', highWaterMark: 1 << 20 })
  const c = new CharCursor(stream)
  const out = fs.createWriteStream(tmpPath, { encoding: 'utf8' })

  let blocks = 0
  let vectors = 0
  let dim = 0
  let model = ''
  let wroteMember = false
  let configRaw = ''
  let config: any = {}
  let testDataFile = ''
  // 用 any 而不是 KbVectorStore|null：赋值发生在闭包里，TS 的控制流收窄会把后续判断误判成 never
  let store: any = null
  let pending: Array<{ id: string; file: string; label: string; ordinal: number; text: string; hash: string; vector: number[] }> = []
  const fileItems: Array<{ file: string; vector: number[]; hash: string }> = []
  let sidecarStream: fs.WriteStream | null = null

  const writeOut = (s: string): Promise<void> => new Promise((resolve) => {
    if (out.write(s)) resolve()
    else out.once('drain', resolve)
  })
  const writeSide = (s: string): Promise<void> => new Promise((resolve) => {
    if (!sidecarStream) return resolve()
    if (sidecarStream.write(s)) resolve()
    else sidecarStream.once('drain', resolve)
  })
  out.setMaxListeners(0)
  out.on('error', () => { /* 写入错误在收尾 stat/rename 时暴露 */ })

  const openDb = (): KbVectorStore => {
    if (!store) {
      if (fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true })
      store = KbVectorStore.open(dbPath)
    }
    return store
  }
  const flushVectors = async (): Promise<void> => {
    if (!pending.length) return
    const s = openDb()
    s.upsertChunks(pending, { quant: 'float32' })
    vectors += pending.length
    pending = []
  }

  try {
    await writeOut('{')
    await skipWs(c)
    await expect(c, '{')

    while (true) {
      await skipWs(c)
      if ((await c.peek()) === '}') {
        await c.next()
        break
      }
      const keyRaw = await readStringRaw(c)
      const key = JSON.parse(keyRaw) as string
      await skipWs(c)
      await expect(c, ':')
      await skipWs(c)

      if (key === 'config') {
        configRaw = await readValueRaw(c)
        try { config = JSON.parse(configRaw) } catch { config = {} }
        model = String(config?.embedModel || config?.model || '')
      } else if (key === 'testData') {
        // 流式写到侧车文件（不保留在 .kb 里）
        sidecarStream = fs.createWriteStream(sidecarPath, { encoding: 'utf8' })
        sidecarStream.setMaxListeners(0)
        sidecarStream.on('error', () => { /* 侧车写失败由外层 catch 处理 */ })
        testDataFile = path.basename(sidecarPath)
        await writeSide(`{"version":1,"savedAt":${JSON.stringify(new Date().toISOString())},"kb":${JSON.stringify(path.basename(kbPath))},"data":`)
        await readValueRaw(c, (chunk) => { void writeSide(chunk) })
        await writeSide('}')
        await new Promise<void>((resolve) => sidecarStream!.end(resolve))
        sidecarStream = null
      } else if (key === 'blocks') {
        if (wroteMember) await writeOut(',')
        await writeOut('"blocks":[')
        wroteMember = true
        await skipWs(c)
        await expect(c, '[')
        let firstBlock = true
        while (true) {
          await skipWs(c)
          if ((await c.peek()) === ']') {
            await c.next()
            break
          }
          const raw = await readValueRaw(c)
          let block: any
          try { block = JSON.parse(raw) } catch { throw new Error('block 解析失败') }
          const vec: number[] | undefined = Array.isArray(block?.A_vector) ? block.A_vector : undefined
          const id = String(block?.id ?? `b-${blocks}`)
          const file = String(block?.filePath || block?.path || '')
          const text = String(block?.A || '')
          if (vec && vec.length) {
            dim = dim || vec.length
            pending.push({
              id, file, label: String(block?.label || ''), ordinal: blocks, text,
              hash: String(block?.contentHash || `i-${blocks}`), vector: vec,
            })
            if (pending.length >= 400) await flushVectors()
            vectors += 0
          }
          delete block.A_vector
          if (!firstBlock) await writeOut(',')
          firstBlock = false
          await writeOut(JSON.stringify(block))
          blocks += 1
          await skipWs(c)
          if ((await c.peek()) === ',') { await c.next(); continue }
          if ((await c.peek()) === ']') { await c.next(); break }
          throw new Error('blocks 数组格式异常')
        }
        await writeOut(']')
      } else {
        let raw = await readValueRaw(c)
        // 文件级摘要向量：从 .kb 里剥掉，转存 file_vectors（避免瘦身后 .kb 仍带大数组）
        if (key === 'fileIndex' || key === 'fileSummaries') {
          try {
            const parsed = JSON.parse(raw)
            for (const [f, entry] of Object.entries(parsed || {})) {
              const v = (entry as any)?.vector
              if (Array.isArray(v) && v.length) {
                fileItems.push({ file: String(f), vector: v as number[], hash: String((entry as any)?.contentHash || '') })
                delete (entry as any).vector
              }
            }
            raw = JSON.stringify(parsed)
          } catch { /* 解析失败就原样保留 */ }
        }
        if (wroteMember) await writeOut(',')
        await writeOut(`${JSON.stringify(key)}:${raw}`)
        wroteMember = true
      }

      await skipWs(c)
      if ((await c.peek()) === ',') { await c.next(); continue }
      if ((await c.peek()) === '}') { await c.next(); break }
      throw new Error('顶层对象格式异常')
    }

    await flushVectors()
    if (store && fileItems.length) {
      store.upsertFileVectors(fileItems, { quant: 'float32' })
    }
    if (store) {
      store.writeMeta({ kb_path: kbPath, model, dim, metric: 'cosine', quant: 'float32' })
      store.close()
      store = null
    }

    const newConfig = {
      ...(config || {}),
      version: '3.2',
      saveVectors: false,
      autoVectorDb: true,
      ...(testDataFile ? { testDataFile } : {}),
      vectorStore: { kind: 'kbdb', file: path.basename(dbPath), dim, model, metric: 'cosine', quant: 'float32', vectors },
    }
    if (wroteMember) await writeOut(',')
    await writeOut(`"config":${JSON.stringify(newConfig)}`)
    await writeOut('}')
    await new Promise<void>((resolve) => out.end(resolve))

    const afterBytes = fs.statSync(tmpPath).size
    // 先把原文件改名备份，再把瘦身版换上去；失败可回滚
    if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { force: true })
    fs.renameSync(kbPath, backupPath)
    try {
      fs.renameSync(tmpPath, kbPath)
    } catch (e) {
      fs.renameSync(backupPath, kbPath)
      throw e
    }
    return {
      ok: true, kbPath, backupPath, dbPath, blocks, vectors,
      beforeBytes, afterBytes, testDataFile: testDataFile || undefined,
    }
  } catch (error: any) {
    try { out.destroy() } catch { /* ignore */ }
    try { sidecarStream?.destroy() } catch { /* ignore */ }
    try { store?.close() } catch { /* ignore */ }
    try { if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true }) } catch { /* ignore */ }
    return {
      ok: false, kbPath, blocks, vectors, beforeBytes, afterBytes: 0,
      error: String(error?.message || error),
    }
  }
}
