/**
 * timeContext.selftest.ts — 时间读数格式化的纯逻辑自测
 *
 * 覆盖：ISO+偏移渲染（固定时区，避免依赖运行机器）、紧凑时长、时区校验、
 * 以及三行读数的两种形态（浏览器时区可用 / 不可用要求澄清）。
 */

import {
  formatCompactDuration,
  formatIsoWithZone,
  formatTimeContext,
  isValidTimeZone,
  zoneOffset,
} from './timeContext'

export interface TimeContextCase {
  name: string
  ok: boolean
  detail?: string
}

export function runTimeContextSelfTest(): TimeContextCase[] {
  const cases: TimeContextCase[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  add('UTC 偏移', zoneOffset(Date.UTC(2026, 0, 1), 'UTC') === '+00:00')
  add('上海偏移 +08:00', zoneOffset(Date.UTC(2026, 0, 1), 'Asia/Shanghai') === '+08:00')
  add('纽约冬令时 -05:00', zoneOffset(Date.UTC(2026, 0, 15), 'America/New_York') === '-05:00')

  // 2026-10-31T13:56:35Z = 上海 21:56:35
  const ts = Date.UTC(2026, 9, 31, 13, 56, 35)
  add('ISO 渲染（上海）', formatIsoWithZone(ts, 'Asia/Shanghai') === '2026-10-31T21:56:35+08:00', formatIsoWithZone(ts, 'Asia/Shanghai'))
  add('ISO 渲染（UTC）', formatIsoWithZone(ts, 'UTC') === '2026-10-31T13:56:35+00:00', formatIsoWithZone(ts, 'UTC'))

  add('时长：秒', formatCompactDuration(42_000) === '42s')
  add('时长：分+秒', formatCompactDuration(185_000) === '3m5s')
  add('时长：整分', formatCompactDuration(180_000) === '3m')
  add('时长：时+分', formatCompactDuration(7_620_000) === '2h7m')
  add('时长：负数钳零', formatCompactDuration(-5) === '0s')

  add('时区校验：合法', isValidTimeZone('Asia/Shanghai'))
  add('时区校验：非法', !isValidTimeZone('Mars/Olympus'))
  add('时区校验：空', !isValidTimeZone(''))

  const base = { turn: 3, step: 1, now: ts, zone: 'Asia/Shanghai' }

  const withZone = formatTimeContext({ ...base, requestZone: 'Asia/Shanghai', elapsedMs: 42_000, sinceStepContext: false })
  add('三行读数：时间戳带偏移与时区名', withZone.includes('Time sampled while preparing turn 3, step 1: 2026-10-31T21:56:35+08:00 Asia/Shanghai'))
  add('三行读数：浏览器时区可用', withZone.includes('Browser time zone for this request: Asia/Shanghai.'))
  add('三行读数：第 1 步用「上一条模型可见消息」', withZone.includes('Elapsed since the preceding model-visible message: 42s.'))

  const subsequent = formatTimeContext({ ...base, step: 2, requestZone: 'Asia/Shanghai', elapsedMs: 12_000, sinceStepContext: true })
  add('三行读数：后续步用「上一个 step 读数」', subsequent.includes('Elapsed since the preceding step context: 12s.'))
  add('三行读数：step 编号正确', subsequent.includes('step 2:'))

  const fallback = formatTimeContext({ ...base, requestZone: undefined, elapsedMs: null, sinceStepContext: false })
  add('三行读数：无浏览器时区 → 提示先问用户', fallback.includes('unavailable') && fallback.includes('ask the user'))
  add('三行读数：无基线 → unavailable', fallback.includes('Elapsed since the preceding model-visible message: unavailable.'))

  return cases
}
