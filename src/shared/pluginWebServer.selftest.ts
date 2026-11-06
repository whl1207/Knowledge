/**
 * pluginWebServer.selftest.ts — 插件独立 HTTP 服务的自测（真实监听 127.0.0.1:0）
 *
 * 只测"路由与生命周期"，不测 CORS / 鉴权（那属于 P5 的 fetch 桥与远程网关）。
 */

import * as http from 'node:http'
import { createPluginWebServer } from '../../electron/main/plugin-services/web-server'

export interface SelfTestResult {
  name: string
  ok: boolean
  detail?: string
}

const log: any = { debug() {}, info() {}, warn() {}, error() {} }

function request(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 2000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode || 0, body }))
    })
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('请求超时'))
    })
    req.on('error', reject)
  })
}

async function waitPort(server: { port: number }): Promise<number> {
  for (let i = 0; i < 100; i++) {
    if (server.port > 0) return server.port
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('服务没有在 2s 内监听')
}

export function runPluginWebServerSelfTest(): Promise<SelfTestResult[]> {
  const results: SelfTestResult[] = []
  const check = (name: string, fn: () => string | null | Promise<string | null>) =>
    Promise.resolve()
      .then(fn)
      .then((problem) => results.push({ name, ok: !problem, ...(problem ? { detail: problem } : {}) }))
      .catch((e) => results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) }))

  return (async () => {
    const server = createPluginWebServer('selftest', log)
    try {
      await check('精确路由 + prefix 路由 + 404', async () => {
        const offPing = server.register({
          kind: 'exact',
          path: '/ping',
          handler: (_req, res) => {
            res.statusCode = 200
            res.end('pong')
          },
        })
        const offApi = server.register({
          kind: 'prefix',
          path: '/api',
          handler: (_req, res) => {
            res.statusCode = 200
            res.end('api')
          },
        })
        const port = await waitPort(server)
        const ping = await request(port, '/ping')
        if (ping.status !== 200 || ping.body !== 'pong') return `精确路由不对：${JSON.stringify(ping)}`
        const api = await request(port, '/api/x')
        if (api.status !== 200 || api.body !== 'api') return `prefix 路由不对：${JSON.stringify(api)}`
        const missing = await request(port, '/nope')
        if (missing.status !== 404) return `未知路由应 404，实际 ${missing.status}`
        offPing()
        offApi()
        const after = await request(port, '/ping')
        if (after.status !== 404) return '撤销后仍命中旧路由'
        return null
      })

      await check('重复注册同一路由 → PLUGIN_CONFLICT', () => {
        const off = server.register({ kind: 'exact', path: '/dup', handler: (_q, s) => { s.end('1') } })
        try {
          server.register({ kind: 'exact', path: '/dup', handler: (_q, s) => { s.end('2') } })
          return '重复注册没抛错'
        } catch (e: any) {
          if (e?.code !== 'PLUGIN_CONFLICT') return `错误码不对：${e?.code}`
        } finally {
          off()
        }
        return null
      })

      await check('fallback 接住未命中的请求', async () => {
        const off = server.registerFallback((_req, res) => {
          res.statusCode = 200
          res.end('fallback')
        })
        const port = await waitPort(server)
        const got = await request(port, '/whatever')
        off()
        if (got.status !== 200 || got.body !== 'fallback') return `fallback 不对：${JSON.stringify(got)}`
        return null
      })

      await check('prefix 最长匹配优先', async () => {
        const offShort = server.register({ kind: 'prefix', path: '/a', handler: (_q, s) => { s.end('short') } })
        const offLong = server.register({ kind: 'prefix', path: '/a/b', handler: (_q, s) => { s.end('long') } })
        const port = await waitPort(server)
        const got = await request(port, '/a/b/c')
        offShort()
        offLong()
        if (got.body !== 'long') return `最长前缀没优先：${got.body}`
        return null
      })

      await check('dispose 可重复调用且释放端口', async () => {
        const port = await waitPort(server)
        server.dispose()
        server.dispose()
        await new Promise((r) => setTimeout(r, 50))
        try {
          await request(port, '/ping')
          return '关闭后仍能连接'
        } catch {
          /* 连接被拒 = 预期 */
        }
        return null
      })
    } finally {
      server.dispose()
    }
    return results
  })()
}
