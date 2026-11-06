/**
 * pluginRpcRegistry.selftest.ts — 插件 RPC 方法表的自测（纯逻辑）
 *
 * 这条通道只允许"本插件界面半边 → 本插件主进程半边"；测的是隔离与冲突，
 * 不是 IPC 序列化（那由 Electron 负责）。
 */

import {
  callPluginRpc,
  clearPluginRpcs,
  pluginRpcMethods,
  registerPluginRpc,
} from '../../electron/main/plugin-rpc-registry'

export interface SelfTestResult {
  name: string
  ok: boolean
  detail?: string
}

export function runPluginRpcRegistrySelfTest(): Promise<SelfTestResult[]> {
  const results: SelfTestResult[] = []
  const check = (name: string, fn: () => string | null | Promise<string | null>) =>
    Promise.resolve()
      .then(fn)
      .then((problem) => results.push({ name, ok: !problem, ...(problem ? { detail: problem } : {}) }))
      .catch((e) => results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) }))

  return (async () => {
    await check('注册 → 调用 → 撤销', async () => {
      const off = registerPluginRpc('p1', 'echo', async (args) => ({ echo: args }))
      const got = await callPluginRpc('p1', 'echo', 'hi')
      if (JSON.stringify(got) !== JSON.stringify({ echo: 'hi' })) return '返回值不对'
      off()
      try {
        await callPluginRpc('p1', 'echo')
        return '撤销后仍能调用'
      } catch (e: any) {
        if (e?.code !== 'PLUGIN_NOT_FOUND') return `错误码不对：${e?.code}`
      }
      return null
    })

    await check('方法名冲突 fail-loud', async () => {
      const off = registerPluginRpc('p2', 'dup', async () => 1)
      try {
        registerPluginRpc('p2', 'dup', async () => 2)
        return '重复注册没抛错'
      } catch (e: any) {
        if (e?.code !== 'PLUGIN_CONFLICT') return `错误码不对：${e?.code}`
      } finally {
        off()
      }
      return null
    })

    await check('插件隔离：A 调不到 B 的方法', async () => {
      const off = registerPluginRpc('pb', 'secret', async () => 'b')
      try {
        await callPluginRpc('pa', 'secret')
        return '跨插件调用成功了'
      } catch (e: any) {
        if (e?.code !== 'PLUGIN_NOT_FOUND') return `错误码不对：${e?.code}`
      } finally {
        off()
      }
      return null
    })

    await check('clearPluginRpcs 清空该插件全部方法', async () => {
      registerPluginRpc('pc', 'a', async () => 1)
      registerPluginRpc('pc', 'b', async () => 2)
      if (pluginRpcMethods('pc').join(',') !== 'a,b') return '方法表不对'
      clearPluginRpcs('pc')
      if (pluginRpcMethods('pc').length !== 0) return '清理后仍有方法'
      return null
    })

    await check('handler 抛错向上抛（不吞）', async () => {
      const off = registerPluginRpc('pd', 'boom', async () => {
        throw new Error('boom')
      })
      try {
        await callPluginRpc('pd', 'boom')
        return '异常被吞了'
      } catch (e) {
        if (!/boom/.test(e instanceof Error ? e.message : String(e))) return '异常信息不对'
      } finally {
        off()
      }
      return null
    })

    return results
  })()
}
