/**
 * scheduleTime.ts — 自动化任务的时间规则（纯计算，主进程与渲染层共用）
 *
 * 复刻 DSH `dsh-util-time` + `dsh-schedule` 的时间语义，但只保留 AI-KM 需要的子集：
 *
 * | kind    | 含义 | 必要字段 |
 * |---------|------|----------|
 * | at      | 一次性 | `at`（ISO UTC 字符串） |
 * | every   | 固定间隔（≥60s） | `everySeconds` |
 * | daily   | 每天某时刻 | `time`（HH:mm）+ `timeZone` |
 * | weekly  | 每周某几天某时刻 | `time` + `timeZone` + `weekdays`（1=周一 … 7=周日） |
 * | cron    | 五段 Vixie Cron | `expression` + `timeZone` |
 * | rrule   | RFC 5545 子集（DTSTART + RRULE） | `rrule`（两行文本） |
 *
 * 为什么自己写而不引库：宿主没有 cron/rrule 依赖，而这两类规则在 AI-KM 里只需要
 * 「下一次触发时刻」与「人类可读描述」；本模块用 `Intl` 的 IANA 时区数据做墙钟↔UTC
 * 换算（不依赖 Temporal），并**限制搜索范围**（默认 5 年）保证永不卡死。
 *
 * 约定：
 * - 所有对外返回的时刻都是 **UTC 毫秒**；任务里持久化的 `scheduledAt` 用 ISO 字符串；
 * - 「已提交的发生时刻」由调用方保存并在触发后推进，本模块只负责算「下一次」；
 * - DST：墙钟按目标时区解释，夏令时缺口/重复按该时区的实际偏移换算（不做特殊裁剪）。
 */

export type ScheduleTiming =
  | { kind: 'at'; at: string }
  | { kind: 'every'; everySeconds: number }
  | { kind: 'daily'; time: string; timeZone: string }
  | { kind: 'weekly'; time: string; timeZone: string; weekdays: number[] }
  | { kind: 'cron'; expression: string; timeZone: string }
  | { kind: 'rrule'; rrule: string }

export const MIN_EVERY_SECONDS = 60
/** 搜索上限：超过这么多天还没找到就不再有下一次（避免坏规则把主进程卡死） */
const MAX_SEARCH_DAYS = 366 * 5

// ---------------------------------------------------------------------------
// 时区换算（Intl）
// ---------------------------------------------------------------------------

const fmtCache = new Map<string, Intl.DateTimeFormat>()

function formatter(tz: string): Intl.DateTimeFormat {
  const key = tz || 'UTC'
  let f = fmtCache.get(key)
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-CA', {
        timeZone: key,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    } catch {
      // 非法时区名：退回 UTC（保存时已校验，这里只是兜底）
      f = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'UTC',
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    }
    fmtCache.set(key, f)
  }
  return f
}

export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  /** 1=周一 … 7=周日（ISO） */
  weekday: number
}

/** UTC 毫秒 → 指定时区的墙钟分量 */
export function zonedParts(ms: number, timeZone = 'UTC'): ZonedParts {
  const parts = formatter(timeZone).formatToParts(new Date(ms))
  const get = (type: string): number => {
    const found = parts.find((p) => p.type === type)
    return found ? Number(found.value) : 0
  }
  const year = get('year')
  const month = get('month')
  const day = get('day')
  // Intl 的 hour 在不足两位时可能给 '24'（旧实现），归一到 0
  const hour = get('hour') % 24
  const minute = get('minute')
  const second = get('second')
  const utcWeekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() // 0=周日
  return { year, month, day, hour, minute, second, weekday: utcWeekday === 0 ? 7 : utcWeekday }
}

/** 某时刻在指定时区的偏移（毫秒；东八区 = +8h） */
function tzOffsetMs(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(ms / 1000) * 1000
}

/** 指定时区的墙钟 → UTC 毫秒（两次校正覆盖 DST 切换） */
export function wallToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second)
  const off1 = tzOffsetMs(guess, timeZone)
  let t = guess - off1
  const off2 = tzOffsetMs(t, timeZone)
  if (off2 !== off1) t = guess - off2
  return t
}

/** 时区名是否合法（保存前校验） */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date())
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 基础解析
// ---------------------------------------------------------------------------

/** `HH:mm` → { hour, minute }；非法返回 null */
export function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim())
  if (!m) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (!(hour >= 0 && hour <= 23) || !(minute >= 0 && minute <= 59)) return null
  return { hour, minute }
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 数值集合 → 排好序的去重数组 */
function uniqueSorted(list: number[]): number[] {
  return Array.from(new Set(list)).sort((a, b) => a - b)
}

/** 解析一个 cron 字段：`*` / `a` / `a-b` / 星号加步长 / 区间加步长 / 逗号列表 */
function parseCronField(raw: string, min: number, max: number): number[] | null {
  const text = String(raw || '').trim()
  if (!text) return null
  const out: number[] = []
  for (const part of text.split(',')) {
    const seg = part.trim()
    if (!seg) return null
    const stepMatch = /^(.+?)\/(\d+)$/.exec(seg)
    const step = stepMatch ? Number(stepMatch[2]) : 1
    if (!(step >= 1)) return null
    const body = stepMatch ? stepMatch[1] : seg
    let from: number
    let to: number
    if (body === '*') {
      from = min
      to = max
    } else if (/^\d+$/.test(body)) {
      from = Number(body)
      to = stepMatch ? max : from
    } else {
      const range = /^(\d+)-(\d+)$/.exec(body)
      if (!range) return null
      from = Number(range[1])
      to = Number(range[2])
    }
    if (from < min || to > max || from > to) return null
    for (let v = from; v <= to; v += step) out.push(v)
  }
  return out.length ? uniqueSorted(out) : null
}

export interface CronSpec {
  minutes: number[]
  hours: number[]
  daysOfMonth: number[]
  months: number[]
  /** 1=周一 … 7=周日（cron 的 0 与 7 都表示周日） */
  weekdays: number[]
  /** 日与星期是否都受限（Vixie：都受限时取并集） */
  domRestricted: boolean
  dowRestricted: boolean
}

/** 解析五段 cron（分 时 日 月 周） */
export function parseCron(expression: string): CronSpec | null {
  const fields = String(expression || '').trim().split(/\s+/)
  if (fields.length !== 5) return null
  const minutes = parseCronField(fields[0], 0, 59)
  const hours = parseCronField(fields[1], 0, 23)
  const dom = parseCronField(fields[2], 1, 31)
  const months = parseCronField(fields[3], 1, 12)
  const rawDow = parseCronField(fields[4], 0, 7)
  if (!minutes || !hours || !dom || !months || !rawDow) return null
  // cron: 0 与 7 都是周日；内部统一 1..7
  const weekdays = uniqueSorted(rawDow.map((d) => (d === 0 ? 7 : d)))
  return {
    minutes,
    hours,
    daysOfMonth: dom,
    months,
    weekdays,
    domRestricted: fields[2].trim() !== '*',
    dowRestricted: fields[4].trim() !== '*',
  }
}

// ---------------------------------------------------------------------------
// RRULE（子集）
// ---------------------------------------------------------------------------

export interface RruleSpec {
  timeZone: string
  /** DTSTART 的墙钟（首次候选） */
  start: { year: number; month: number; day: number; hour: number; minute: number }
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY'
  interval: number
  byDay: Array<{ weekday: number; ordinal?: number }>
  byMonthDay: number[]
  byHour: number[] | null
  byMinute: number[] | null
  count: number | null
  untilMs: number | null
}

/** 星期缩写 → ISO 星期 */
const WEEKDAY_BY_NAME: Record<string, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 }

/**
 * 解析两行文本：`DTSTART;TZID=Asia/Shanghai:20261101T090000` + `RRULE:FREQ=DAILY;INTERVAL=1…`
 * 也接受 `DTSTART:20261101T010000Z`（UTC）。
 */
export function parseRrule(text: string): RruleSpec | null {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const dtLine = lines.find((l) => /^DTSTART/i.test(l))
  const rrLine = lines.find((l) => /^RRULE:/i.test(l))
  if (!dtLine || !rrLine) return null

  const dtMatch = /^DTSTART(?:;TZID=([^:;]+))?:(\d{8})T(\d{6})Z?$/i.exec(dtLine)
  if (!dtMatch) return null
  const timeZone = dtMatch[1] || 'UTC'
  if (!isValidTimeZone(timeZone)) return null
  const date = dtMatch[2]
  const time = dtMatch[3]
  const start = {
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(4, 6)),
    day: Number(date.slice(6, 8)),
    hour: Number(time.slice(0, 2)),
    minute: Number(time.slice(2, 4)),
  }
  if (!(start.hour <= 23 && start.minute <= 59)) return null

  const body = rrLine.replace(/^RRULE:/i, '')
  const parts = new Map<string, string>()
  for (const seg of body.split(';')) {
    const eq = seg.indexOf('=')
    if (eq <= 0) continue
    parts.set(seg.slice(0, eq).toUpperCase(), seg.slice(eq + 1))
  }
  const freq = String(parts.get('FREQ') || '').toUpperCase()
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') return null
  const interval = Math.max(1, Number(parts.get('INTERVAL') || 1) || 1)

  const byDay: Array<{ weekday: number; ordinal?: number }> = []
  const byDayRaw = parts.get('BYDAY')
  if (byDayRaw) {
    for (const item of byDayRaw.split(',')) {
      const m = /^([+-]?\d{1,2})?([A-Z]{2})$/.exec(item.trim().toUpperCase())
      if (!m) return null
      const weekday = WEEKDAY_BY_NAME[m[2]]
      if (!weekday) return null
      const ordinal = m[1] ? Number(m[1]) : undefined
      byDay.push(ordinal === undefined ? { weekday } : { weekday, ordinal })
    }
  }

  const byMonthDayRaw = parts.get('BYMONTHDAY')
  const byMonthDay = byMonthDayRaw
    ? uniqueSorted(byMonthDayRaw.split(',').map((v) => Number(v)).filter((n) => Number.isFinite(n) && n !== 0))
    : []
  const byHourRaw = parts.get('BYHOUR')
  const byHour = byHourRaw ? parseCronField(byHourRaw, 0, 23) : null
  const byMinuteRaw = parts.get('BYMINUTE')
  const byMinute = byMinuteRaw ? parseCronField(byMinuteRaw, 0, 59) : null
  if (byHourRaw && !byHour) return null
  if (byMinuteRaw && !byMinute) return null

  const count = parts.has('COUNT') ? Math.max(1, Number(parts.get('COUNT')) || 1) : null
  const untilRaw = parts.get('UNTIL')
  const untilMs = untilRaw ? parseRruleUntil(untilRaw) : null

  return { timeZone, start, freq, interval, byDay, byMonthDay, byHour, byMinute, count, untilMs }
}

function parseRruleUntil(raw: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(String(raw).trim())
  if (!m) return null
  const [, y, mo, d, h = '23', mi = '59', s = '59'] = m
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
}

// ---------------------------------------------------------------------------
// 下一次发生时刻
// ---------------------------------------------------------------------------

interface DayScanOptions {
  timeZone: string
  afterMs: number
  /** 该日是否命中（按墙钟日期判断） */
  matchDay: (date: { year: number; month: number; day: number; weekday: number }) => boolean
  /** 当天允许的小时/分钟（null = 全部） */
  hours: number[] | null
  minutes: number[] | null
  /** 额外的候选时间（例如 every/at 不需要按天扫） */
  deadlineMs?: number
}

/** 按「天」推进扫描，返回 afterMs 之后最近的一个命中的墙钟时刻（UTC 毫秒） */
function scanDays(opts: DayScanOptions): number | null {
  const tz = opts.timeZone || 'UTC'
  const startParts = zonedParts(opts.afterMs, tz)
  const hours = opts.hours && opts.hours.length ? opts.hours : null
  const minutes = opts.minutes && opts.minutes.length ? opts.minutes : null
  let y = startParts.year
  let mo = startParts.month
  let d = startParts.day
  for (let i = 0; i < MAX_SEARCH_DAYS; i++) {
    const parts = zonedParts(wallToUtc(tz, y, mo, d, 12, 0, 0), tz) // 以当天正午取日期分量，避开 DST 边界
    if (opts.matchDay({ year: parts.year, month: parts.month, day: parts.day, weekday: parts.weekday })) {
      const hourList = hours || [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]
      const minuteList = minutes || [0, 15, 30, 45]
      for (const h of hourList) {
        for (const mi of minuteList) {
          const candidate = wallToUtc(tz, parts.year, parts.month, parts.day, h, mi, 0)
          if (candidate > opts.afterMs) return candidate
        }
      }
    }
    // 推进一天（墙钟 +1 天，交给 Date 处理月末）
    const next = new Date(Date.UTC(y, mo - 1, d + 1))
    y = next.getUTCFullYear()
    mo = next.getUTCMonth() + 1
    d = next.getUTCDate()
  }
  return null
}

/** 计算「下一次发生时刻」（UTC 毫秒）；没有下一次返回 null */
export function nextOccurrence(timing: ScheduleTiming, afterMs: number): number | null {
  const after = Number.isFinite(afterMs) ? afterMs : Date.now()
  switch (timing.kind) {
    case 'at': {
      const t = Date.parse(timing.at)
      return Number.isFinite(t) && t > after ? t : null
    }
    case 'every': {
      const step = Math.max(MIN_EVERY_SECONDS, Number(timing.everySeconds) || 0) * 1000
      // 固定间隔：从「现在」向后取整到下一个整间隔（避免重启后立刻补一堆）
      return Math.floor(after / step) * step + step
    }
    case 'daily': {
      const tod = parseTimeOfDay(timing.time)
      if (!tod) return null
      return scanDays({
        timeZone: timing.timeZone || 'UTC',
        afterMs: after,
        matchDay: () => true,
        hours: [tod.hour],
        minutes: [tod.minute],
      })
    }
    case 'weekly': {
      const tod = parseTimeOfDay(timing.time)
      if (!tod || !Array.isArray(timing.weekdays) || !timing.weekdays.length) return null
      const set = new Set(timing.weekdays)
      return scanDays({
        timeZone: timing.timeZone || 'UTC',
        afterMs: after,
        matchDay: (date) => set.has(date.weekday),
        hours: [tod.hour],
        minutes: [tod.minute],
      })
    }
    case 'cron': {
      const cron = parseCron(timing.expression)
      if (!cron) return null
      return scanDays({
        timeZone: timing.timeZone || 'UTC',
        afterMs: after,
        matchDay: (date) => {
          const monthOk = cron.months.includes(date.month)
          const domOk = cron.daysOfMonth.includes(date.day)
          const dowOk = cron.weekdays.includes(date.weekday)
          if (cron.domRestricted && cron.dowRestricted) return monthOk && (domOk || dowOk)
          return monthOk && (cron.domRestricted ? domOk : (cron.dowRestricted ? dowOk : true))
        },
        hours: cron.hours,
        minutes: cron.minutes,
      })
    }
    case 'rrule': {
      const rule = parseRrule(timing.rrule)
      if (!rule) return null
      return nextRrule(rule, after)
    }
    default:
      return null
  }
}

function nextRrule(rule: RruleSpec, afterMs: number): number | null {
  const tz = rule.timeZone
  const startMs = wallToUtc(tz, rule.start.year, rule.start.month, rule.start.day, rule.start.hour, rule.start.minute, 0)
  if (startMs > afterMs) {
    // 首次发生还没到：直接返回 DTSTART（COUNT/UNTIL 允许）
    if (rule.untilMs !== null && startMs > rule.untilMs) return null
    return startMs
  }
  // 以 DTSTART 所在日为第 0 天，按 interval 推进
  const startDate = new Date(Date.UTC(rule.start.year, rule.start.month - 1, rule.start.day))
  const startWeekday = startDate.getUTCDay() === 0 ? 7 : startDate.getUTCDay()
  const dayDiff = (a: Date, b: Date): number => Math.round((a.getTime() - b.getTime()) / 86_400_000)

  const byHours = rule.byHour && rule.byHour.length ? rule.byHour : [rule.start.hour]
  const byMinutes = rule.byMinute && rule.byMinute.length ? rule.byMinute : [rule.start.minute]
  const byDay = rule.byDay

  let countSoFar = 0
  const cursor = new Date(startDate.getTime())
  for (let i = 0; i < MAX_SEARCH_DAYS; i++) {
    const weekday = cursor.getUTCDay() === 0 ? 7 : cursor.getUTCDay()
    const month = cursor.getUTCMonth() + 1
    const day = cursor.getUTCDate()
    const diff = dayDiff(cursor, startDate)
    let dayOk = false
    if (rule.freq === 'DAILY') {
      dayOk = diff % rule.interval === 0 && matchRruleDay(rule, cursor, weekday, month, day, byDay)
    } else if (rule.freq === 'WEEKLY') {
      const weeks = Math.floor(((diff % 7) + 7) % 7 === 0 ? diff / 7 : (diff - (((diff % 7) + 7) % 7)) / 7)
      const weekDiff = Math.round((cursor.getTime() - startDate.getTime()) / (7 * 86_400_000))
      dayOk = weekDiff % rule.interval === 0 && matchRruleDay(rule, cursor, weekday, month, day, byDay, startWeekday)
      void weeks
    } else {
      // MONTHLY：按「第几个月」推进
      const monthsDiff = (cursor.getUTCFullYear() - startDate.getUTCFullYear()) * 12 + (month - (startDate.getUTCMonth() + 1))
      dayOk = monthsDiff >= 0 && monthsDiff % rule.interval === 0 && matchRruleDay(rule, cursor, weekday, month, day, byDay)
    }
    if (dayOk) {
      for (const h of byHours) {
        for (const mi of byMinutes) {
          const candidate = wallToUtc(tz, cursor.getUTCFullYear(), month, day, h, mi, 0)
          if (rule.untilMs !== null && candidate > rule.untilMs) return null
          if (rule.count !== null) {
            countSoFar += 1
            if (countSoFar > rule.count) return null
          }
          if (candidate > afterMs) return candidate
        }
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return null
}

/** RRULE 的日级匹配（DAILY 只看 BYDAY/BYMONTHDAY；WEEKLY 看 BYDAY；MONTHLY 看 BYMONTHDAY 或带序号的 BYDAY） */
function matchRruleDay(
  rule: RruleSpec,
  date: Date,
  weekday: number,
  month: number,
  day: number,
  byDay: Array<{ weekday: number; ordinal?: number }>,
  startWeekday = weekday,
): boolean {
  void month
  if (rule.byMonthDay.length && !rule.byMonthDay.includes(day)) {
    // MONTHLY 的负序号：-1 = 当月最后一天
    const daysInMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
    const negOk = rule.byMonthDay.some((d) => d < 0 && daysInMonth + d + 1 === day)
    if (!negOk) return false
  }
  if (byDay.length) {
    const hit = byDay.some((item) => {
      if (item.weekday !== weekday) return false
      if (item.ordinal === undefined) return true
      const dayOfMonth = date.getUTCDate()
      if (item.ordinal > 0) return Math.floor((dayOfMonth - 1) / 7) + 1 === item.ordinal
      const daysInMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
      return Math.floor((daysInMonth - dayOfMonth) / 7) + 1 === -item.ordinal
    })
    if (!hit) return false
  } else if (rule.freq === 'WEEKLY') {
    // 没写 BYDAY 的 WEEKLY：按 DTSTART 的星期几
    if (weekday !== startWeekday) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// 校验 + 描述
// ---------------------------------------------------------------------------

export interface TimingCheck {
  ok: boolean
  /** 规范化后的 timing（去掉无关字段 / 去重 / 排序） */
  timing?: ScheduleTiming
  message?: string
}

/** 规范化 + 校验（保存入口统一调用；不合法时给出可读原因） */
export function normalizeTiming(input: any): TimingCheck {
  const kind = String(input?.kind || '').trim()
  if (kind === 'at') {
    const at = String(input?.at || '').trim()
    const ms = Date.parse(at)
    if (!Number.isFinite(ms)) return { ok: false, message: '时间不合法（需要 ISO 时间，如 2026-11-20T09:00:00.000Z）' }
    return { ok: true, timing: { kind: 'at', at: new Date(ms).toISOString() } }
  }
  if (kind === 'every') {
    const seconds = Math.floor(Number(input?.everySeconds))
    if (!Number.isFinite(seconds) || seconds < MIN_EVERY_SECONDS) {
      return { ok: false, message: `间隔至少 ${MIN_EVERY_SECONDS} 秒` }
    }
    if (seconds * 1000 > Number.MAX_SAFE_INTEGER) return { ok: false, message: '间隔过大' }
    return { ok: true, timing: { kind: 'every', everySeconds: seconds } }
  }
  if (kind === 'daily' || kind === 'weekly') {
    const tod = parseTimeOfDay(String(input?.time || ''))
    if (!tod) return { ok: false, message: '时间不合法（需要 HH:mm）' }
    const timeZone = String(input?.timeZone || '').trim() || 'UTC'
    if (!isValidTimeZone(timeZone)) return { ok: false, message: `未知时区：${timeZone}` }
    const time = `${pad2(tod.hour)}:${pad2(tod.minute)}`
    if (kind === 'daily') return { ok: true, timing: { kind: 'daily', time, timeZone } }
    const weekdays = Array.isArray(input?.weekdays)
      ? uniqueSorted(input.weekdays.map((d: any) => Number(d)).filter((d: number) => d >= 1 && d <= 7))
      : []
    if (!weekdays.length) return { ok: false, message: '至少选一个星期几' }
    return { ok: true, timing: { kind: 'weekly', time, timeZone, weekdays } }
  }
  if (kind === 'cron') {
    const expression = String(input?.expression || '').trim().replace(/\s+/g, ' ')
    if (!parseCron(expression)) return { ok: false, message: 'Cron 不合法（需要五段：分 时 日 月 周）' }
    const timeZone = String(input?.timeZone || '').trim() || 'UTC'
    if (!isValidTimeZone(timeZone)) return { ok: false, message: `未知时区：${timeZone}` }
    return { ok: true, timing: { kind: 'cron', expression, timeZone } }
  }
  if (kind === 'rrule') {
    const rrule = String(input?.rrule || '').trim()
    if (!parseRrule(rrule)) {
      return {
        ok: false,
        message: 'RRULE 不合法（需要一行 DTSTART 与一行 RRULE；FREQ 支持 DAILY/WEEKLY/MONTHLY）',
      }
    }
    return { ok: true, timing: { kind: 'rrule', rrule } }
  }
  return { ok: false, message: '缺少时间规则（kind）' }
}

/** 人类可读描述（界面 / 工具结果共用） */
export function describeTiming(timing: ScheduleTiming, zh = true): string {
  const week = zh
    ? ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']
    : ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  switch (timing.kind) {
    case 'at': {
      const d = new Date(timing.at)
      return `${d.toLocaleString('zh-CN', { hour12: false })}（一次性）`
    }
    case 'every':
      return zh ? `每 ${timing.everySeconds} 秒` : `every ${timing.everySeconds}s`
    case 'daily':
      return zh ? `每天 ${timing.time}（${timing.timeZone}）` : `daily at ${timing.time} (${timing.timeZone})`
    case 'weekly': {
      const days = timing.weekdays.map((d) => week[d] || d).join(zh ? '、' : ' ')
      return zh ? `每 ${days} ${timing.time}（${timing.timeZone}）` : `${days} at ${timing.time} (${timing.timeZone})`
    }
    case 'cron':
      return `Cron ${timing.expression}（${timing.timeZone}）`
    case 'rrule': {
      const rule = parseRrule(timing.rrule)
      if (!rule) return timing.rrule.replace(/\n/g, ' ')
      const freq = rule.freq === 'DAILY' ? (zh ? '每天' : 'daily') : rule.freq === 'WEEKLY' ? (zh ? '每周' : 'weekly') : (zh ? '每月' : 'monthly')
      const every = rule.interval > 1 ? (zh ? `每 ${rule.interval} 个` : `every ${rule.interval} `) : ''
      return `${every}${freq}（${rule.timeZone} ${pad2(rule.start.hour)}:${pad2(rule.start.minute)}）`
    }
    default:
      return ''
  }
}
