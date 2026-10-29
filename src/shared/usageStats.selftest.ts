/**
 * usageStats.selftest.ts — 用量账本的书签口径
 *
 * 这些断言盯的是「统计会算错」的具体路径，而不是覆盖率：
 * 1. 来源键：多个自定义来源必须分开、DeepSeek 历史别名不能分裂成两行；
 * 2. 记账：坏行/零用量必须被丢掉（账本只记 provider 真报过的数）；
 * 3. 切日：按本地时区切，跨零点不串天；「今日」按给定时钟算；
 * 4. 合并：主进程按月份文件缓存后会合并，合并不许丢天或重复计；
 * 5. 汇总：来源按 total 降序，全局合计等于各来源之和。
 */

import {
  addUsageRecord,
  buildUsageDaySeries,
  createUsageAccumulator,
  formatTokenCount,
  formatUsageClock,
  localDayKey,
  mergeUsageAccumulator,
  parseUsageRecord,
  summarizeUsage,
  usageSourceKey,
} from './usageStats'

export interface UsageStatsCase { name: string; ok: boolean; detail?: string }

export function runUsageStatsSelfTest(): UsageStatsCase[] {
  const cases: UsageStatsCase[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  // ---- 来源键 ----
  add('内置来源：键即 provider', usageSourceKey('deepseek') === 'deepseek')
  add('自定义来源按 id 分开', usageSourceKey('custom', 3) === 'custom:3' && usageSourceKey('custom', 7) === 'custom:7')
  add('自定义来源缺 id：退回 custom 桶', usageSourceKey('custom', null) === 'custom')
  add('DeepSeek 历史别名归一', usageSourceKey('deepseek-responses') === 'deepseek')
  add('空 provider：落 unknown 桶', usageSourceKey('') === 'unknown')

  // ---- 解析 ----
  add('坏 JSON → null', parseUsageRecord('{not json') === null)
  add('缺时间 → null', parseUsageRecord(JSON.stringify({ provider: 'ollama', prompt: 1, completion: 1 })) === null)
  add('两个 token 都为 0 → null', parseUsageRecord(JSON.stringify({ t: 1, provider: 'ollama', prompt: 0, completion: 0 })) === null)
  const ok1 = parseUsageRecord(JSON.stringify({ t: 1700000000000, provider: 'deepseek', model: 'x', prompt: 12.6, completion: 3.2 }))
  add('合法行：token 取整、模型留存', !!ok1 && ok1.prompt === 13 && ok1.completion === 3 && ok1.model === 'x')

  // ---- 记账与切日（本地时区）----
  const acc = createUsageAccumulator()
  const T0 = new Date(2026, 9, 27, 10, 0, 0).getTime() // 本地 2026-10-27 10:00
  addUsageRecord(acc, { t: T0, provider: 'deepseek', prompt: 100, completion: 20 })
  addUsageRecord(acc, { t: T0 + 60_000, provider: 'deepseek', prompt: 50, completion: 10 })
  addUsageRecord(acc, { t: T0, provider: 'ollama', prompt: 7, completion: 3 })
  addUsageRecord(acc, { t: T0, provider: 'custom', sourceId: 2, prompt: 5, completion: 5 })

  add('两条同来源记录累加', acc.sources.get('deepseek')?.prompt === 150 && acc.sources.get('deepseek')?.completion === 30)
  add('请求数按条计', acc.records === 4)
  add('最早/最晚时间戳正确', acc.firstTs === T0 && acc.lastTs === T0 + 60_000)
  add('自定义来源独立成桶', acc.sources.has('custom:2'))
  add('零用量被忽略', addUsageRecord(acc, { t: T0, provider: 'deepseek', prompt: 0, completion: 0 }) === false)
  add('非法时间被忽略', addUsageRecord(acc, { t: Number.NaN, provider: 'deepseek', prompt: 1, completion: 1 }) === false)

  const dayKey = localDayKey(T0)
  add('本地日期键格式', /^\d{4}-\d{2}-\d{2}$/.test(dayKey), dayKey)

  // 跨零点：同一天 23:59 与次日 00:01 必须落在两个桶
  const lateNight = new Date(2026, 9, 27, 23, 59, 0).getTime()
  const nextDay = new Date(2026, 9, 28, 0, 1, 0).getTime()
  const acc2 = createUsageAccumulator()
  addUsageRecord(acc2, { t: lateNight, provider: 'deepseek', prompt: 1, completion: 0 })
  addUsageRecord(acc2, { t: nextDay, provider: 'deepseek', prompt: 2, completion: 0 })
  const days2 = acc2.sources.get('deepseek')!.days
  add('跨零点切成两天', days2.size === 2 && days2.has(localDayKey(lateNight)) && days2.has(localDayKey(nextDay)))

  // ---- 合并（主进程按月份文件缓存后合并）----
  const left = createUsageAccumulator()
  addUsageRecord(left, { t: T0, provider: 'deepseek', prompt: 10, completion: 1 })
  addUsageRecord(left, { t: T0, provider: 'deepseek', prompt: 10, completion: 1 })
  const right = createUsageAccumulator()
  addUsageRecord(right, { t: nextDay, provider: 'deepseek', prompt: 20, completion: 2 })
  mergeUsageAccumulator(left, right)
  add('合并后请求数相加', left.records === 3)
  add('合并后同日同名来源不重复建桶', left.sources.get('deepseek')?.days.size === 2)
  add('合并后总量正确', left.sources.get('deepseek')?.prompt === 40)

  // ---- 汇总 ----
  const summary = summarizeUsage(acc, { now: T0 + 3_600_000, generatedAt: T0 + 3_600_000 })
  add('汇总只含有记录的来源', summary.sources.length === 3)
  add('汇总按 total 降序', summary.sources[0].key === 'deepseek' && summary.sources[0].total === 180)
  add('今日合计 = 该来源当天全部用量', summary.sources.find(s => s.key === 'deepseek')?.today === 180)
  const sumTotal = summary.sources.reduce((n, s) => n + s.total, 0)
  add('全局合计 = 各来源之和', summary.grand.total === sumTotal && summary.grand.requests === 4,
    `${summary.grand.total} / ${sumTotal}`)
  add('全局合计的日桶 = 当天所有来源之和',
    (summary.grand.days[dayKey]?.i || 0) + (summary.grand.days[dayKey]?.o || 0) === sumTotal,
    `${(summary.grand.days[dayKey]?.i || 0) + (summary.grand.days[dayKey]?.o || 0)} / ${sumTotal}`)

  // 空账本：不抛错，返回零值结构
  const empty = summarizeUsage(createUsageAccumulator(), { now: T0 })
  add('空账本：records=0 / sources 空 / grand.total=0',
    empty.records === 0 && empty.sources.length === 0 && empty.grand.total === 0 && empty.firstTs === null)

  // 次日看「今日」应为 0（口径跟随本地日期，而不是「最近一天」）
  const nextDaySummary = summarizeUsage(acc, { now: nextDay })
  add('次日：今日归零，总量不变',
    (nextDaySummary.sources.find(s => s.key === 'deepseek')?.today || 0) === 0 &&
    (nextDaySummary.sources.find(s => s.key === 'deepseek')?.total || 0) === 180)

  // ---- 图表序列（范围内补 0 / 全部范围 / 只看今天及以前）----
  const chartNow = new Date(2026, 9, 27, 12, 0, 0).getTime()
  const dayOffset = (n: number) => {
    const d = new Date(chartNow)
    d.setDate(d.getDate() - n)
    return localDayKey(d.getTime())
  }

  const onlyToday = buildUsageDaySeries({ [dayOffset(0)]: { i: 10, o: 5 } }, 7, { now: chartNow })
  add('7 天范围：缺日补 0，长度 7', onlyToday.length === 7 && onlyToday[6].total === 15 && onlyToday[0].total === 0,
    `${onlyToday.length} 天`)
  const allRange = buildUsageDaySeries({ [dayOffset(5)]: { i: 1, o: 1 }, [dayOffset(0)]: { i: 2, o: 2 } }, 0, { now: chartNow })
  add('全部范围：从最早一天到今天的连续序列', allRange.length === 6 && allRange[0].date === dayOffset(5),
    `${allRange.length} 天`)
  const clamped = buildUsageDaySeries({ [dayOffset(400)]: { i: 1, o: 0 } }, 0, { now: chartNow, maxDays: 30 })
  add('全部范围：超出 maxDays 时夹紧', clamped.length === 30, `${clamped.length} 天`)
  const futureIgnored = buildUsageDaySeries({ [dayOffset(-3)]: { i: 9, o: 9 } }, 0, { now: chartNow })
  add('未来日期不画进序列', futureIgnored.length === 0, `${futureIgnored.length} 天`)

  // ---- 数字格式（两处界面共用同一套口径）----
  add('formatTokenCount：千 / 百万 / 十亿',
    formatTokenCount(999) === '999' && formatTokenCount(1500) === '1.5K' &&
    formatTokenCount(2_500_000) === '2.5M' && formatTokenCount(1_200_000_000) === '1.20B')
  add('formatTokenCount：负数与 NaN 归零', formatTokenCount(-5) === '0' && formatTokenCount(Number.NaN) === '0')
  add('formatUsageClock：空值返回空串', formatUsageClock(0) === '' && formatUsageClock(Number.NaN) === '')

  return cases
}
