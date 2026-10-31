/**
 * timeContext.ts — 给模型的一只钟（对齐 DSH 的 `dsh-time-context`）
 *
 * DSH 的做法：在每个「准备进入 step」的时点，往持久历史里追加一条 **user 角色** 的读数，
 * 三行内容——带偏移与时区名的 ISO 时间戳、本次请求的浏览器时区策略、距上一条模型可见消息
 * （或上一个 time-context）的时长。默认 10 分钟最小间隔，避免每个 step 都加一条。
 *
 * 为什么需要：模型不知道"今天是几号""用户在哪时区"，遇到"这周五之前""上个月"只能猜。
 * 注入读数后它可以按用户时区解释未限定时间；时区来源不明时要主动问，而不是默认一个。
 *
 * 本模块只负责**文本与时间格式化**（纯函数、可单测）；注入时机与持久化在 agent-loop 里。
 */

/** 两次注入之间的最小间隔（毫秒）；DSH 默认 10 分钟 */
export const TIME_CONTEXT_REFRESH_MS = 600_000

export interface TimeContextInput {
  turn: number
  step: number
  /** 采样时刻（epoch ms） */
  now: number
  /** 用于格式化时间戳的时区（浏览器时区或回退时区） */
  zone: string
  /** 本次请求的浏览器时区；缺省表示来源不可用（要提示模型先问） */
  requestZone?: string
  /** 距基线经过的毫秒；null = 没有基线（报告 unavailable） */
  elapsedMs: number | null
  /** 基线是「上一个 time-context」还是「上一条模型可见消息」 */
  sinceStepContext: boolean
}

/** 校验 IANA 时区名（非法值会让 Intl 抛错） */
export function isValidTimeZone(zone: unknown): boolean {
  const z = String(zone || '').trim()
  if (!z) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z })
    return true
  } catch {
    return false
  }
}

/** 某时区在某一时刻的 UTC 偏移（如 `+08:00`；UTC 返回 `+00:00`） */
export function zoneOffset(ts: number, zone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(new Date(ts))
    const name = parts.find((p) => p.type === 'timeZoneName')?.value || ''
    const m = /GMT([+-]\d{2}:\d{2})/.exec(name)
    if (m) return m[1]
    if (/GMT/.test(name)) return '+00:00'
  } catch {
    /* 时区非法：退回 UTC 偏移 */
  }
  return '+00:00'
}

/** 形如 `2026-10-31T21:56:35+08:00` 的本地时间戳（带偏移，精确到秒） */
export function formatIsoWithZone(ts: number, zone: string): string {
  const d = new Date(ts)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value || ''
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${zoneOffset(ts, zone)}`
}

/** 紧凑整秒时长：`42s` / `3m5s` / `2h7m`（负数钳到 0） */
export function formatCompactDuration(ms: number): string {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds ? `${minutes}m${seconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h${rest}m` : `${hours}h`
}

/** 渲染三行读数（模型可见文本；与 DSH 的措辞保持一致） */
export function formatTimeContext(input: TimeContextInput): string {
  const turn = Math.max(0, Math.floor(Number(input.turn) || 0))
  const step = Math.max(0, Math.floor(Number(input.step) || 0))
  const stamp = `${formatIsoWithZone(input.now, input.zone)} ${input.zone}`
  const elapsedLabel = input.sinceStepContext
    ? 'Elapsed since the preceding step context'
    : 'Elapsed since the preceding model-visible message'
  const elapsed = input.elapsedMs === null || input.elapsedMs === undefined
    ? 'unavailable'
    : formatCompactDuration(input.elapsedMs)
  // 浏览器时区权威 → 直接告诉模型；缺失 → 说明只是宿主回退值，并要求先问用户
  const zoneLine = isValidTimeZone(input.requestZone)
    ? `Browser time zone for this request: ${input.requestZone}.`
    : `Browser time zone for this request: unavailable (using ${input.zone} as the host fallback) — ask the user before interpreting unqualified dates or times.`
  return [
    `Time sampled while preparing turn ${turn}, step ${step}: ${stamp}`,
    zoneLine,
    `${elapsedLabel}: ${elapsed}.`,
  ].join('\n')
}
