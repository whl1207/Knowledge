/**
 * scopedFetch.selftest.ts — DSH 界面半边 fetch 桥的自测（纯逻辑）
 *
 * 生产环境是 `file://`：相对路径必须重写到插件的回环 webServer，否则插件设置页
 * 所有 `/api/*` 请求都会打空。这里钉住"什么时候重写、什么时候原样放行"。
 */

import { createScopedFetch } from './scopedFetch'

export interface SelfTestResult {
  name: string
  ok: boolean
  detail?: string
}

export function runScopedFetchSelfTest(): Promise<SelfTestResult[]> {
  const results: SelfTestResult[] = []
  const check = (name: string, fn: () => string | null | Promise<string | null>) =>
    Promise.resolve()
      .then(fn)
      .then((problem) => results.push({ name, ok: !problem, ...(problem ? { detail: problem } : {}) }))
      .catch((e) => results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) }))

  return (async () => {
    await check('相对路径 → 基址 + 路径', async () => {
      const calls: any[] = []
      const fallback = (async (input: any) => {
        calls.push(input)
        return { ok: true } as any
      }) as unknown as typeof fetch
      const scoped = createScopedFetch('http://127.0.0.1:1234', fallback)
      await scoped('/api/status')
      if (calls[0] !== 'http://127.0.0.1:1234/api/status') return `实际：${String(calls[0])}`
      return null
    })

    await check('绝对 URL 原样放行', async () => {
      const calls: any[] = []
      const fallback = (async (input: any) => {
        calls.push(input)
        return {} as any
      }) as unknown as typeof fetch
      const scoped = createScopedFetch('http://127.0.0.1:1234', fallback)
      await scoped('https://example.com/x')
      if (calls[0] !== 'https://example.com/x') return `实际：${String(calls[0])}`
      return null
    })

    await check('基址滞后解析（装载时端口还没分配）', async () => {
      const calls: any[] = []
      const fallback = (async (input: any) => {
        calls.push(input)
        return {} as any
      }) as unknown as typeof fetch
      const scoped = createScopedFetch(undefined, fallback, async () => 'http://127.0.0.1:9999')
      await scoped('/api/pair')
      if (calls[0] !== 'http://127.0.0.1:9999/api/pair') return `实际：${String(calls[0])}`
      return null
    })

    await check('没有基址也没有解析器 → 原符号返回（不包一层）', () => {
      const fallback = (async () => ({})) as unknown as typeof fetch
      const scoped = createScopedFetch(undefined, fallback)
      if (scoped !== fallback) return '不应该包一层'
      return null
    })

    return results
  })()
}
