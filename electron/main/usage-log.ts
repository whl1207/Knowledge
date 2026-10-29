/**
 * usage-log.ts — 模型用量账本的读写层（只记后续，不做历史回填）
 *
 * 借鉴 DeepSeek-Harness 的「按次记账」思路：每完成一次模型请求就追加一行，
 * 统计永远读账本，而不是去扫聊天存档。后者在 AI-KM 里问题很具体：
 * - 智能体/集群模式把 `tokenStats.totalTokens` 写成**会话累计值**（见 lib/agent/projection.ts
 *   的 projectUsage），普通聊天写的是**单次请求值**——两者直接求和会重复计；
 * - 后端不回报 usage 时会退化成字符估算，历史里真假混在一起；
 * - 来源归属只在 `chat.config.llmType` 上，同一聊天换过来源就归错了。
 *
 * 代价是「以前的不算」：从本模块落地那天起，每次请求一行，精确到来源、模型、
 * 输入/输出与本地日期。这也是产品上的选择——不做历史回填。
 *
 * 分工：口径与聚合在 `@/shared/usageStats`（纯函数、有自测）；本文件只负责
 * `<userData>/usage/usage-YYYY-MM.jsonl` 的追加、按文件（mtime+size）缓存解析、
 * 以及给 IPC 用的 `summarize()`。
 *
 * 失败策略：记账是旁路，任何 I/O 或格式错误都只 warn，绝不打断模型请求。
 */

import { app } from 'electron'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import {
  addUsageRecord,
  createUsageAccumulator,
  mergeUsageAccumulator,
  parseUsageRecord,
  summarizeUsage,
  type UsageAccumulator,
  type UsageRecord,
  type UsageSummary,
} from '@/shared/usageStats'

export type { UsageDayBucket, UsageRecord, UsageSourceSummary, UsageSummary } from '@/shared/usageStats'

/** 账本目录：`<userData>/usage` */
export function usageDir(): string {
  return join(app.getPath('userData'), 'usage')
}

/** 月份文件名（按记录时间，而不是写入时间——补记/跨零点都不会进错月） */
function monthFile(ts: number): string {
  const d = new Date(ts)
  return `usage-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`
}

/** 追加队列：串行化写入，避免并发 appendFile 交错 */
let appendChain: Promise<void> = Promise.resolve()
let dirEnsured = false

async function ensureDir(): Promise<void> {
  if (dirEnsured) return
  await fsp.mkdir(usageDir(), { recursive: true })
  dirEnsured = true
}

/**
 * 记一次用量（fire-and-forget）。
 *
 * 调用方不需要 await；内部串行追加，失败只 warn。`prompt`/`completion` 都为 0
 * 或非有限数时直接丢弃——账本只记 provider 真报过的数，绝不用估算填充。
 */
export function recordUsage(input: {
  t?: number
  provider: string
  sourceId?: number | string | null
  model?: string
  prompt?: number
  completion?: number
}): void {
  const prompt = Number(input.prompt)
  const completion = Number(input.completion)
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return
  if (prompt <= 0 && completion <= 0) return

  const t = Number.isFinite(Number(input.t)) && Number(input.t) > 0 ? Number(input.t) : Date.now()
  const rec: UsageRecord = {
    t,
    provider: String(input.provider || 'unknown'),
    ...(input.sourceId === undefined || input.sourceId === null || input.sourceId === ''
      ? {}
      : { sourceId: input.sourceId }),
    ...(input.model ? { model: String(input.model) } : {}),
    prompt: Math.max(0, Math.round(prompt)),
    completion: Math.max(0, Math.round(completion)),
  }

  const file = join(usageDir(), monthFile(t))
  const line = `${JSON.stringify(rec)}\n`
  appendChain = appendChain
    .then(async () => {
      await ensureDir()
      await fsp.appendFile(file, line, 'utf8')
    })
    .catch((e) => {
      console.warn('[usage-log] 记录用量失败：', e instanceof Error ? e.message : e)
    })
}

/** 每个月份文件的解析缓存：键 = 文件绝对路径，值 = 文件签名 + 聚合 */
const fileCache = new Map<string, { sig: string; acc: UsageAccumulator }>()

/**
 * 汇总账本。
 *
 * 只重算签名（mtime + size）变过的月份文件；文件被删除则丢掉缓存。
 * 返回结构是纯 JSON（IPC 会再净化一次）。
 */
export async function summarize(): Promise<UsageSummary> {
  const dir = usageDir()
  let names: string[] = []
  try {
    names = (await fsp.readdir(dir)).filter((n) => /^usage-\d{4}-\d{2}\.jsonl$/.test(n))
  } catch {
    // 目录还不存在 = 账本为空（第一次用这个功能），不是错误
  }

  const live = new Set<string>()
  for (const name of names) {
    const path = join(dir, name)
    live.add(path)
    let stat
    try {
      stat = await fsp.stat(path)
    } catch {
      continue
    }
    const sig = `${stat.size}:${stat.mtimeMs}`
    const cached = fileCache.get(path)
    if (cached && cached.sig === sig) continue
    try {
      const text = await fsp.readFile(path, 'utf8')
      const acc = createUsageAccumulator()
      for (const line of text.split('\n')) {
        addUsageRecord(acc, parseUsageRecord(line))
      }
      fileCache.set(path, { sig, acc })
    } catch (e) {
      console.warn('[usage-log] 读取账本失败：', path, e instanceof Error ? e.message : e)
    }
  }
  // 已删除的月份文件不再参与聚合
  for (const path of [...fileCache.keys()]) {
    if (!live.has(path)) fileCache.delete(path)
  }

  const merged = createUsageAccumulator()
  for (const [, cached] of [...fileCache.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    mergeUsageAccumulator(merged, cached.acc)
  }
  return summarizeUsage(merged)
}
