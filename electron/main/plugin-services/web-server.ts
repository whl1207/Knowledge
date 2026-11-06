/**
 * web-server.ts — `ctx.webServer`（P3）
 *
 * 每个插件一个**独立的** `http.Server`：默认 `127.0.0.1:0`（OS 分配），不挂 LAN 共享、
 * 不与其他插件共享路由表。理由见方案 §D7：
 * - 生命周期干净：插件卸载即关，不会把路由留在宿主网页上；
 * - 隔离：A 插件的路径不会与 B 插件撞车；
 * - 安全：只绑回环；要对外必须走远程访问网关，插件不能自己开 0.0.0.0。
 *
 * ⚠️ 诚实的边界：插件在进程内，仍可自己 `import('node:http')` 开端口。本服务是**便利 +
 * 一致性**，不是沙箱（与 DSH 的 webServer 同一定位）。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { PluginServiceError } from '@/shared/pluginServices'
import type {
  PluginWebRoute,
  PluginWebServerService,
  PluginWebUpgradeRoute,
  WebRouteHandler,
  WebUpgradeHandler,
} from '@/shared/pluginServices'
import type { PluginLogger } from '@/types/plugin'

interface RouteEntry {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: WebRouteHandler
}

export interface PluginWebServerHandle extends PluginWebServerService {
  dispose(): void
}

export function createPluginWebServer(pluginId: string, log: PluginLogger): PluginWebServerHandle {
  const exact = new Map<string, RouteEntry>()
  const prefix = new Map<string, RouteEntry>()
  const upgrades = new Map<string, WebUpgradeHandler>()
  const upgradedSockets = new Set<Duplex>()
  let fallback: WebRouteHandler | null = null
  let server: Server | null = null
  let disposed = false

  const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(body))
  }

  const setCors = (res: ServerResponse): void => {
    // 只绑回环；渲染层是 file://（Origin: null），插件设置页要能直接 fetch。
    // 与 DSH 的 webServer 一致：不做认证，URL 本身是能力边界（P5 的 fetch 桥会带插件 id）。
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-AIKM-Token')
    // Chromium 的 Private Network Access：从 file:// / 公网页面访问 127.0.0.1 时，
    // 预检会要求这个头；缺了它，插件设置页的 fetch 会被直接拦掉（看起来像"没数据"）。
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
    res.setHeader('Cache-Control', 'no-store')
  }

  const pathnameOf = (req: IncomingMessage): string => {
    try {
      const parsed = new URL(req.url || '/', 'http://127.0.0.1')
      return parsed.pathname
    } catch {
      return '/'
    }
  }

  /** 最长前缀命中（`/api` 命中 `/api/x`，但 `/api2` 不命中 `/api`） */
  const matchPrefix = (pathname: string): RouteEntry | undefined => {
    let best: RouteEntry | undefined
    for (const entry of prefix.values()) {
      if (pathname === entry.path || pathname.startsWith(`${entry.path}/`)) {
        if (!best || entry.path.length > best.path.length) best = entry
      }
    }
    return best
  }

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    setCors(res)
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }
    const pathname = pathnameOf(req)
    const entry = exact.get(pathname) ?? matchPrefix(pathname)
    const handler = entry?.handler ?? fallback
    if (!handler) {
      sendJson(res, 404, { ok: false, error: `插件 ${pluginId} 没有注册这个路由：${pathname}` })
      return
    }
    try {
      await handler(req, res)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      log.warn(`[webServer] ${req.method} ${pathname} 处理失败: ${message}`)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: message })
      else {
        try {
          res.destroy()
        } catch {
          /* 已断开 */
        }
      }
    }
  }

  const ensureServer = (): Server => {
    if (server) return server
    if (disposed) throw new PluginServiceError('PLUGIN_UNSUPPORTED', '插件已卸载，无法再开服务', { service: 'webServer' })
    const created = createServer((req, res) => {
      void handleRequest(req, res)
    })
    created.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const pathname = pathnameOf(req)
      const handler = upgrades.get(pathname)
      if (!handler) {
        try {
          socket.destroy()
        } catch {
          /* 已断开 */
        }
        return
      }
      upgradedSockets.add(socket)
      socket.once('close', () => upgradedSockets.delete(socket))
      try {
        void Promise.resolve(handler(req, socket, head)).catch((e) => {
          log.warn(`[webServer] upgrade ${pathname} 失败: ${e instanceof Error ? e.message : String(e)}`)
          try {
            socket.destroy()
          } catch {
            /* 已断开 */
          }
        })
      } catch (e) {
        log.warn(`[webServer] upgrade ${pathname} 异常: ${e instanceof Error ? e.message : String(e)}`)
        try {
          socket.destroy()
        } catch {
          /* 已断开 */
        }
      }
    })
    created.on('error', (e) => {
      log.error(`[webServer] 监听失败: ${e instanceof Error ? e.message : String(e)}`)
    })
    created.listen(0, '127.0.0.1', () => {
      const address = created.address() as AddressInfo | null
      log.info(`[webServer] ${pluginId} 监听 127.0.0.1:${address?.port ?? 0}`)
    })
    server = created
    return created
  }

  // 启动即监听：插件设置页可能在 apply 里就拼 URL。端口在 listening 后才有值。
  ensureServer()

  return {
    get port(): number {
      if (!server) return 0
      const address = server.address() as AddressInfo | null
      return address?.port ?? 0
    },

    register(route: PluginWebRoute): () => void {
      if (!route || typeof route.path !== 'string' || !route.path.startsWith('/')) {
        throw new PluginServiceError('PLUGIN_INVALID_ARGUMENT', '路由 path 必须是以 / 开头的绝对路径', { service: 'webServer' })
      }
      if (typeof route.handler !== 'function') {
        throw new PluginServiceError('PLUGIN_INVALID_ARGUMENT', '路由 handler 必须是函数', { service: 'webServer' })
      }
      const path = route.path.replace(/\/+$/, '') || '/'
      const table = route.kind === 'prefix' ? prefix : exact
      if (table.has(path)) {
        throw new PluginServiceError('PLUGIN_CONFLICT', `路由已注册：${route.kind} ${path}`, { service: 'webServer' })
      }
      const entry: RouteEntry = { kind: route.kind, path, handler: route.handler }
      table.set(path, entry)
      ensureServer()
      return () => {
        if (table.get(path) === entry) table.delete(path)
      }
    },

    registerUpgrade(route: PluginWebUpgradeRoute): () => void {
      if (!route || !route.path.startsWith('/') || typeof route.handler !== 'function') {
        throw new PluginServiceError('PLUGIN_INVALID_ARGUMENT', 'upgrade 路由需要绝对 path 与 handler', { service: 'webServer' })
      }
      const path = route.path.replace(/\/+$/, '') || '/'
      if (upgrades.has(path)) {
        throw new PluginServiceError('PLUGIN_CONFLICT', `upgrade 路由已注册：${path}`, { service: 'webServer' })
      }
      upgrades.set(path, route.handler)
      ensureServer()
      return () => {
        if (upgrades.get(path) === route.handler) upgrades.delete(path)
      }
    },

    registerFallback(handler: WebRouteHandler): () => void {
      if (typeof handler !== 'function') {
        throw new PluginServiceError('PLUGIN_INVALID_ARGUMENT', 'fallback 必须是函数', { service: 'webServer' })
      }
      if (fallback) {
        throw new PluginServiceError('PLUGIN_CONFLICT', 'fallback 已有所有者（一个插件只能注册一次）', { service: 'webServer' })
      }
      fallback = handler
      ensureServer()
      return () => {
        if (fallback === handler) fallback = null
      }
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      exact.clear()
      prefix.clear()
      upgrades.clear()
      fallback = null
      for (const socket of Array.from(upgradedSockets)) {
        try {
          socket.destroy()
        } catch {
          /* 已断开 */
        }
      }
      upgradedSockets.clear()
      if (server) {
        try {
          server.close()
          server.closeAllConnections?.()
        } catch {
          /* 已关闭 */
        }
        server = null
      }
    },
  }
}
