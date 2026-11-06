/**
 * pluginSchedule.selftest.ts — 定时器的自测（真实 timer，短延时）
 *
 * 只测"触发 / 撤销 / dispose 后不再触发"；dailyAt 的跨天计算用"不会立刻触发"来代表。
 */

import { createPluginSchedule } from '../../electron/main/plugin-services/schedule'

export interface SelfTestResult {
  name: string
  ok: boolean
  detail?: string
}

const log: any = { debug() {}, info() {}, warn() {}, error() {} }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function runPluginScheduleSelfTest(): Promise<SelfTestResult[]> {
  const results: SelfTestResult[] = []
  const check = (name: string, fn: () => string | null | Promise<string | null>) =>
    Promise.resolve()
      .then(fn)
      .then((problem) => results.push({ name, ok: !problem, ...(problem ? { detail: problem } : {}) }))
      .catch((e) => results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) }))

  return (async () => {
    const schedule = createPluginSchedule('selftest', log)
    try {
      await check('after 触发一次', async () => {
        let hits = 0
        schedule.after(10, () => {
          hits++
        })
        await sleep(40)
        if (hits !== 1) return `应触发 1 次，实际 ${hits}`
        return null
      })

      await check('after 的 disposer 能取消', async () => {
        let hits = 0
        const off = schedule.after(20, () => {
          hits++
        })
        off()
        await sleep(50)
        if (hits !== 0) return `取消后仍触发 ${hits} 次`
        return null
      })

      await check('every 重复触发，dispose 后停止', async () => {
        let hits = 0
        schedule.every(10, () => {
          hits++
        })
        await sleep(45)
        if (hits < 2) return `应重复触发，实际 ${hits}`
        schedule.dispose()
        const atDispose = hits
        await sleep(40)
        if (hits !== atDispose) return `dispose 后仍触发（${atDispose} → ${hits}）`
        return null
      })

      await check('dailyAt 不会立刻触发，返回 disposer', async () => {
        let hits = 0
        const off = schedule.dailyAt(3, 0, () => {
          hits++
        })
        await sleep(20)
        off()
        if (hits !== 0) return 'dailyAt 立刻触发了'
        return null
      })
    } finally {
      schedule.dispose()
    }
    return results
  })()
}
