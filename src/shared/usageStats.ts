/**
 * usageStats.ts — 用量账本的纯计算层（无 Electron / 无 I/O，可自测）
 *
 * 与 `electron/main/usage-log.ts` 的分工：
 * - 本文件：一行一个 `UsageRecord` 的解析、按「来源 × 本地日期」累积、合并与出汇总；
 * - 主进程那份：按月 JSONL 的读写、文件级缓存、IPC 出口。
 *
 * 这样切开的理由很实际：口径（哪些算、怎么切日、来源怎么归一）是最容易写错、
 * 也最需要被自测盯住的部分，它不该依赖 `app.getPath()` 才能跑。
 *
 * 口径约定（与产品一致）：
 * - 只统计 provider 自报的用量，`prompt + completion`；不估算、不补齐；
 * - 一次请求 = 一条记录，重试也是各算一次（真的发生过）；
 * - 按**本地时区**切日（跟用户看到的"今天"一致）；
 * - 来源键与设置页来源列表对齐：内置 provider key，自定义 `custom:<id>`。
 */

/** 账本里的一行：一次模型请求的用量 */
export interface UsageRecord {
  /** 请求完成时间（毫秒时间戳，本地日期按它切桶） */
  t: number
  /** 来源类型：ollama / lmstudio / deepseek / gpustack / openai / anthropic / google / azure / custom */
  provider: string
  /** 自定义来源的 id（provider === 'custom' 时有效，用于把多个自定义来源分开统计） */
  sourceId?: number | string | null
  /** 实际请求的模型名（当前只用于账本留存，界面不展示） */
  model?: string
  /** 输入 token（provider 自报，含上下文重发部分） */
  prompt: number
  /** 输出 token */
  completion: number
}

/** 单日桶（图表按天堆叠用） */
export interface UsageDayBucket {
  /** 输入 */
  i: number
  /** 输出 */
  o: number
}

/** 单个来源的汇总 */
export interface UsageSourceSummary {
  /** 统计键：内置来源为 provider key，自定义来源为 `custom:<id>` */
  key: string
  prompt: number
  completion: number
  total: number
  requests: number
  /** 今日合计（本地日期） */
  today: number
  /** 'YYYY-MM-DD' → { i, o } */
  days: Record<string, UsageDayBucket>
}

/** 账本汇总（`usage:summary` 的返回值） */
export interface UsageSummary {
  /** 本次聚合时间 */
  generatedAt: number
  /** 最早 / 最晚一条记录的时间戳；空账本为 null */
  firstTs: number | null
  lastTs: number | null
  /** 记录条数（一次请求 = 一条） */
  records: number
  /** 各来源汇总（按 total 降序） */
  sources: UsageSourceSummary[]
  /** 全部来源合计 */
  grand: { prompt: number; completion: number; total: number; requests: number; today: number; days: Record<string, UsageDayBucket> }
}

/** 累积器里的可变来源状态（Map 便于增量累加，出汇总时才转成普通对象） */
export interface UsageSourceState {
  prompt: number
  completion: number
  requests: number
  days: Map<string, UsageDayBucket>
}

/** 累积器：可以增量 addRecord，也可以整体 merge（主进程按月份文件缓存用的就是它） */
export interface UsageAccumulator {
  firstTs: number | null
  lastTs: number | null
  records: number
  sources: Map<string, UsageSourceState>
}

/** 新建空累积器 */
export function createUsageAccumulator(): UsageAccumulator {
  return { firstTs: null, lastTs: null, records: 0, sources: new Map() }
}

/** 本地日期键（'YYYY-MM-DD'）：跟随系统时区，跨时区/夏令时也按用户看到的"今天"切 */
export function localDayKey(ts: number): string {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/**
 * 来源统计键：与设置页左侧来源列表一一对应。
 * 自定义来源必须按 id 分开（`custom:<id>`），否则多个自定义来源会挤成一行。
 */
export function usageSourceKey(provider: string, sourceId?: number | string | null): string {
  const p = String(provider || '').trim()
  if (p === 'custom') {
    const id = sourceId === undefined || sourceId === null || sourceId === '' ? '' : String(sourceId)
    return id ? `custom:${id}` : 'custom'
  }
  // 历史别名聚合：DeepSeek 收敛为单来源后不应出现第二个桶
  if (p === 'deepseek-responses') return 'deepseek'
  return p || 'unknown'
}

/** 把任意值收敛成非负整数 token 数（NaN / 负数 / 非数字 → 0） */
function tokens(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

/** 解析一行账本；不合法（非 JSON / 缺时间 / 两个 token 都为 0）返回 null */
export function parseUsageRecord(line: string): UsageRecord | null {
  const text = String(line || '').trim()
  if (!text) return null
  let raw: any
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const t = Number(raw.t)
  if (!Number.isFinite(t) || t <= 0) return null
  const prompt = tokens(raw.prompt)
  const completion = tokens(raw.completion)
  if (prompt <= 0 && completion <= 0) return null
  const provider = String(raw.provider || '').trim()
  const rec: UsageRecord = { t, provider: provider || 'unknown', prompt, completion }
  if (raw.sourceId !== undefined && raw.sourceId !== null && raw.sourceId !== '') rec.sourceId = raw.sourceId
  if (raw.model) rec.model = String(raw.model)
  return rec
}

/** 把一条记录累加进累积器；非法记录直接忽略（返回是否计入） */
export function addUsageRecord(acc: UsageAccumulator, rec: UsageRecord | null | undefined): boolean {
  if (!rec) return false
  const t = Number(rec.t)
  if (!Number.isFinite(t) || t <= 0) return false
  const prompt = tokens(rec.prompt)
  const completion = tokens(rec.completion)
  if (prompt <= 0 && completion <= 0) return false

  const key = usageSourceKey(rec.provider, rec.sourceId)
  const day = localDayKey(t)
  let src = acc.sources.get(key)
  if (!src) {
    src = { prompt: 0, completion: 0, requests: 0, days: new Map() }
    acc.sources.set(key, src)
  }
  src.prompt += prompt
  src.completion += completion
  src.requests += 1
  const bucket = src.days.get(day) || { i: 0, o: 0 }
  bucket.i += prompt
  bucket.o += completion
  src.days.set(day, bucket)

  acc.records += 1
  if (acc.firstTs === null || t < acc.firstTs) acc.firstTs = t
  if (acc.lastTs === null || t > acc.lastTs) acc.lastTs = t
  return true
}

/** 合并另一个累积器（不修改入参） */
export function mergeUsageAccumulator(into: UsageAccumulator, from: UsageAccumulator): UsageAccumulator {
  if (from.firstTs !== null && (into.firstTs === null || from.firstTs < into.firstTs)) into.firstTs = from.firstTs
  if (from.lastTs !== null && (into.lastTs === null || from.lastTs > into.lastTs)) into.lastTs = from.lastTs
  into.records += from.records
  for (const [key, src] of from.sources) {
    let dst = into.sources.get(key)
    if (!dst) {
      dst = { prompt: 0, completion: 0, requests: 0, days: new Map() }
      into.sources.set(key, dst)
    }
    dst.prompt += src.prompt
    dst.completion += src.completion
    dst.requests += src.requests
    for (const [day, b] of src.days) {
      const cur = dst.days.get(day) || { i: 0, o: 0 }
      cur.i += b.i
      cur.o += b.o
      dst.days.set(day, cur)
    }
  }
  return into
}

/**
 * 出汇总：来源按 total 降序（设置页列表要的正是这个顺序），并补上「今日」与全局合计。
 * `now` 可注入，便于自测固定"今天"。
 */export function summarizeUsage(acc: UsageAccumulator, options?: { now?: number; generatedAt?: number }): UsageSummary {
  const now = Number.isFinite(Number(options?.now)) ? Number(options?.now) : Date.now()
  const generatedAt = Number.isFinite(Number(options?.generatedAt)) ? Number(options?.generatedAt) : now
  const today = localDayKey(now)

  const sources: UsageSourceSummary[] = [...acc.sources.entries()]
    .map(([key, src]) => {
      const days: Record<string, UsageDayBucket> = {}
      for (const [day, b] of src.days) days[day] = { i: b.i, o: b.o }
      return {
        key,
        prompt: src.prompt,
        completion: src.completion,
        total: src.prompt + src.completion,
        requests: src.requests,
        today: days[today] ? days[today].i + days[today].o : 0,
        days,
      }
    })
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key))

  const grandDays: Record<string, UsageDayBucket> = {}
  let grandPrompt = 0
  let grandCompletion = 0
  let grandRequests = 0
  for (const s of sources) {
    grandPrompt += s.prompt
    grandCompletion += s.completion
    grandRequests += s.requests
    for (const [day, b] of Object.entries(s.days)) {
      const cur = grandDays[day] || { i: 0, o: 0 }
      cur.i += b.i
      cur.o += b.o
      grandDays[day] = cur
    }
  }

  return {
    generatedAt,
    firstTs: acc.firstTs,
    lastTs: acc.lastTs,
    records: acc.records,
    sources,
    grand: {
      prompt: grandPrompt,
      completion: grandCompletion,
      total: grandPrompt + grandCompletion,
      requests: grandRequests,
      today: grandDays[today] ? grandDays[today].i + grandDays[today].o : 0,
      days: grandDays,
    },
  }
}

/** 图表的一天：范围内无数据的日子也会补 0，保证柱图节奏连续 */
export interface UsageDayPoint {
  date: string
  i: number
  o: number
  total: number
}

/**
 * 把「日期 → 桶」摊平成按天连续的序列（图表直接用）。
 *
 * - `range` 为 7/30/90 等正数：从「今天往前 range-1 天」到今天，缺日补 0；
 * - `range` 为 0（全部）：从有数据的第一天开始，最多回看 `maxDays` 天（默认 366），
 *   避免账本很长时柱子挤成一条；
 * - 未来日期的记录不纳入（只画到今天）。
 * `now` 可注入，便于自测固定"今天"。
 */
export function buildUsageDaySeries(
  days: Record<string, UsageDayBucket> | null | undefined,
  range: number,
  options?: { now?: number; maxDays?: number },
): UsageDayPoint[] {
  const map = days || {}
  const keys = Object.keys(map).sort()
  const now = Number.isFinite(Number(options?.now)) ? new Date(Number(options?.now)) : new Date()
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)

  let start: Date
  if (range > 0) {
    start = new Date(today)
    start.setDate(start.getDate() - (range - 1))
  } else if (keys.length) {
    const [y, m, d] = keys[0].split('-').map(Number)
    start = new Date(y, (m || 1) - 1, d || 1)
    const maxDays = Number.isFinite(Number(options?.maxDays)) && Number(options?.maxDays) > 0 ? Number(options?.maxDays) : 366
    const floor = new Date(today)
    floor.setDate(floor.getDate() - (maxDays - 1))
    if (start < floor) start = floor
  } else {
    return []
  }

  const out: UsageDayPoint[] = []
  for (const cur = new Date(start); cur <= today; cur.setDate(cur.getDate() + 1)) {
    const key = localDayKey(cur.getTime())
    const b = map[key]
    const i = b?.i || 0
    const o = b?.o || 0
    out.push({ date: key, i, o, total: i + o })
  }
  return out
}

/** token 数缩写（K/M/B）：界面上的数字一律走它，保证两处口径一致 */
export function formatTokenCount(n: number): string {
  const v = Math.max(0, Math.round(Number(n) || 0))
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`
  return String(v)
}

/** 精确值（千分位）：悬停提示与需要逐位核对的地方用 */
export function formatTokenCountExact(n: number): string {
  return Math.max(0, Math.round(Number(n) || 0)).toLocaleString()
}

/** 只显示时:分（卡片底部的「更新于」）；日期由页面自己交代 */
export function formatUsageClock(ts: number): string {
  if (!Number.isFinite(Number(ts)) || Number(ts) <= 0) return ''
  const d = new Date(Number(ts))
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
