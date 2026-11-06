/**
 * pluginWaterfall.selftest.ts — 拦截链的自测（纯逻辑）
 *
 * 盯住三条契约：后注册先跑、next() 只走一次、全部放行才轮到宿主 fallback。
 * 这三条错了会变成"审批被跳过"或"弹两次框"，都是安全事故。
 */

import {
  clearPluginWaterfalls,
  hasPluginWaterfall,
  pluginWaterfallCount,
  registerPluginWaterfall,
  runPluginWaterfall,
} from '../../electron/main/plugin-waterfall'

export interface SelfTestResult {
  name: string
  ok: boolean
  detail?: string
}

export function runPluginWaterfallSelfTest(): Promise<SelfTestResult[]> {
  const results: SelfTestResult[] = []
  const check = (name: string, fn: () => string | null | Promise<string | null>) => {
    return Promise.resolve()
      .then(fn)
      .then((problem) => results.push({ name, ok: !problem, ...(problem ? { detail: problem } : {}) }))
      .catch((e) => results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) }))
  }

  return (async () => {
    await check('后注册先跑；认领后不再往下', async () => {
      const order: string[] = []
      const offA = registerPluginWaterfall('pa', 'test/order', async () => {
        order.push('a')
        return 'A'
      })
      const offB = registerPluginWaterfall('pb', 'test/order', async () => {
        order.push('b')
        return 'B'
      })
      const got = await runPluginWaterfall('test/order', null, async () => 'fallback')
      offA()
      offB()
      if (order.join(',') !== 'b') return `执行顺序不对：${order.join(',')}`
      if (got !== 'B') return `认领结果不对：${got}`
      return null
    })

    await check('next() 放行给下一个；全部放行才走 fallback', async () => {
      const order: string[] = []
      const offA = registerPluginWaterfall('pa', 'test/next', async (_p, next) => {
        order.push('a')
        return next()
      })
      const offB = registerPluginWaterfall('pb', 'test/next', async (_p, next) => {
        order.push('b')
        return next()
      })
      const got = await runPluginWaterfall('test/next', null, async () => {
        order.push('fallback')
        return 'F'
      })
      offA()
      offB()
      if (order.join(',') !== 'b,a,fallback') return `顺序不对：${order.join(',')}`
      if (got !== 'F') return `fallback 结果不对：${got}`
      return null
    })

    await check('next() 只能调用一次', async () => {
      const off = registerPluginWaterfall('pa', 'test/twice', async (_p, next) => {
        await next()
        return next()
      })
      try {
        await runPluginWaterfall('test/twice', null, async () => 'F')
        return '重复 next 没抛错'
      } catch (e) {
        if (!/只能调用一次/.test(e instanceof Error ? e.message : String(e))) return '错误信息不对'
      } finally {
        off()
      }
      return null
    })

    await check('撤销 / 按插件清理 / 计数', async () => {
      const offA = registerPluginWaterfall('pa', 'test/clean', async () => 'A')
      const offB = registerPluginWaterfall('pb', 'test/clean', async () => 'B')
      if (pluginWaterfallCount('test/clean') !== 2) return '计数应为 2'
      if (!hasPluginWaterfall('test/clean')) return 'has 应为 true'
      offA()
      if (pluginWaterfallCount('test/clean') !== 1) return '撤销后计数应为 1'
      clearPluginWaterfalls('pb')
      if (pluginWaterfallCount('test/clean') !== 0) return '清理后计数应为 0'
      if (hasPluginWaterfall('test/clean')) return 'has 应为 false'
      offB()
      return null
    })

    await check('空链直接走 fallback', async () => {
      const got = await runPluginWaterfall('test/empty', null, async () => 'F')
      if (got !== 'F') return `结果不对：${got}`
      if (hasPluginWaterfall('test/empty')) return 'has 应为 false'
      return null
    })

    await check('handler 抛错向上抛（不静默放行）', async () => {
      const off = registerPluginWaterfall('pa', 'test/throw', async () => {
        throw new Error('boom')
      })
      try {
        await runPluginWaterfall('test/throw', null, async () => 'F')
        return '抛错被吞了'
      } catch (e) {
        if (!/boom/.test(e instanceof Error ? e.message : String(e))) return '错误没向上抛'
      } finally {
        off()
      }
      return null
    })

    return results
  })()
}
