/**
 * browserView.ts — 插件界面半边的受控内嵌浏览器（`ctx.browserView`）
 *
 * 只有桌面端主进程能创建 WebContentsView；这里只是代理：
 * - 插件必须声明 `browser.embed`（操作观察另需 `browser.observe`）；
 * - 每个插件最多一个视图，重载 / 卸载时由宿主销毁；
 * - 事件按 viewId 过滤，插件看不到别人的视图。
 */
import type { PluginBridgeApi } from './bridge'

export interface PluginBrowserViewRect { x: number; y: number; width: number; height: number }

export type PluginBrowserViewEventType =
  | 'did-start-loading'
  | 'did-stop-loading'
  | 'did-navigate'
  | 'did-navigate-in-page'
  | 'page-title-updated'
  | 'did-fail-load'
  | 'action'
  | 'destroyed'

export interface PluginBrowserViewHandle {
  readonly id: string
  navigate(url: string): Promise<{ url: string }>
  reload(): Promise<{ ok: boolean }>
  goBack(): Promise<{ ok: boolean }>
  goForward(): Promise<{ ok: boolean }>
  stop(): Promise<{ ok: boolean }>
  setBounds(rect: PluginBrowserViewRect): Promise<{ ok: boolean }>
  setVisible(visible: boolean): Promise<{ ok: boolean }>
  setOccluded(occluded: boolean): Promise<{ ok: boolean }>
  observe(enabled?: boolean): Promise<{ observing: boolean }>
  capture(): Promise<{ base64: string }>
  url(): Promise<{ url: string; title: string }>
  state(): Promise<{ url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean }>
  on(type: PluginBrowserViewEventType, listener: (payload: any) => void): () => void
  destroy(): Promise<void>
}

export interface PluginBrowserViewApi {
  readonly available: boolean
  readonly reason: string
  create(options?: { url?: string; allowedHosts?: string[] }): Promise<PluginBrowserViewHandle>
  /** 宿主插件卸载时统一销毁本插件全部视图 */
  destroyAll(): Promise<void>
}

interface Deps {
  pluginId: string
  permitted: boolean
  bridge: () => PluginBridgeApi | null
  log: { warn(...args: unknown[]): void }
}

export function createPluginBrowserViewApi(deps: Deps): PluginBrowserViewApi {
  const bridge = (): PluginBridgeApi | null => deps.bridge()
  const supported = () => {
    const b = bridge()
    return !!(b && typeof b.browserViewCreate === 'function' && typeof b.browserViewCommand === 'function')
  }
  const unavailable = (): string => {
    if (!deps.permitted) return '未声明 "browser.embed" 权限（package.json 的 aikm.permissions）'
    if (!supported()) return '当前运行方式不支持内嵌浏览器（需要桌面端主进程）'
    return ''
  }
  const handles = new Map<string, { destroyed: boolean; listeners: Map<string, Set<(p: any) => void>> }>()
  let offBridge: (() => void) | null = null

  const ensureEvents = () => {
    if (offBridge || !supported()) return
    const b = bridge()!
    offBridge = b.browserViewOnEvent?.((event: any) => {
      const h = handles.get(String(event?.viewId || ''))
      if (!h || h.destroyed) return
      const set = h.listeners.get(String(event?.type || ''))
      if (!set) return
      for (const fn of Array.from(set)) {
        try { fn(event) } catch (e) { deps.log.warn('[browserView] listener error', e) }
      }
    }) || null
  }

  const call = async (id: string, action: string, args?: unknown): Promise<any> => {
    const b = bridge()
    if (!b?.browserViewCommand) throw new Error(unavailable() || '内嵌浏览器不可用')
    const res = await b.browserViewCommand({ pluginId: deps.pluginId, viewId: id, action, args })
    return res
  }

  return {
    get available() { return !unavailable() },
    get reason() { return unavailable() },
    async create(options = {}) {
      if (unavailable()) throw new Error(unavailable())
      const b = bridge()
      if (!b?.browserViewCreate) throw new Error(unavailable())
      const res = await b.browserViewCreate({
        pluginId: deps.pluginId,
        ...(options.url ? { url: String(options.url) } : {}),
        ...(Array.isArray(options.allowedHosts) ? { allowedHosts: options.allowedHosts.map((x) => String(x)) } : {}),
      })
      const id = String(res?.id || '')
      if (!id) throw new Error('宿主没有返回浏览器视图 id')
      const state = { destroyed: false, listeners: new Map<string, Set<(p: any) => void>>() }
      handles.set(id, state)
      ensureEvents()
      const handle: PluginBrowserViewHandle = {
        id,
        async navigate(url) { return await call(id, 'navigate', { url: String(url) }) },
        async reload() { return await call(id, 'reload') },
        async goBack() { return await call(id, 'back') },
        async goForward() { return await call(id, 'forward') },
        async stop() { return await call(id, 'stop') },
        async setBounds(rect) { return await call(id, 'bounds', { rect }) },
        async setVisible(visible) { return await call(id, 'visible', { visible: !!visible }) },
        async setOccluded(occluded) { return await call(id, 'occluded', { occluded: !!occluded }) },
        async observe(enabled = true) { return await call(id, 'observe', { enabled: !!enabled }) },
        async capture() { return await call(id, 'capture') },
        async url() { return await call(id, 'url') },
        async state() { return await call(id, 'state') },
        on(type, listener) {
          const key = String(type)
          let set = state.listeners.get(key)
          if (!set) { set = new Set(); state.listeners.set(key, set) }
          set.add(listener)
          ensureEvents()
          return () => { set!.delete(listener) }
        },
        async destroy() {
          if (state.destroyed) return
          state.destroyed = true
          handles.delete(id)
          try { await b.browserViewDestroy?.({ pluginId: deps.pluginId, viewId: id }) } catch (e) { deps.log.warn('[browserView] destroy failed', e) }
        },
      }
      return handle
    },
    async destroyAll() {
      for (const id of [...handles.keys()]) {
        try { await bridge()?.browserViewDestroy?.({ pluginId: deps.pluginId, viewId: id }) } catch (e) { deps.log.warn('[browserView] cleanup failed', e) }
      }
      handles.clear()
      if (offBridge) { try { offBridge() } catch { /* 忽略 */ } offBridge = null }
    },
  }
}
