/**
 * plugin-browser-view.ts — 受控的内嵌浏览器服务（插件 API `ctx.browserView`）
 *
 * 设计对齐 DSH 的插件能力：
 * - Host 半边持有真实 WebContentsView，插件只拿受控句柄；
 * - 权限在清单声明（browser.embed / browser.observe），宿主二次校验；
 * - 视图生命周期挂在插件上，插件卸载 / 关闭时销毁；
 * - 每个插件最多一个视图，全局有上限；
 * - URL、证书、下载、弹窗、Node 能力都由宿主统一管控。
 */
import { BrowserWindow, WebContentsView, session, type WebContents } from 'electron'
import { IPCError } from '@/types/ipc'
import { registerIpc } from './ipc-registry'
import { pluginHost } from './plugin-host'

export interface PluginBrowserViewRect {
  x: number
  y: number
  width: number
  height: number
}

type ViewEventType =
  | 'did-start-loading'
  | 'did-stop-loading'
  | 'did-navigate'
  | 'did-navigate-in-page'
  | 'page-title-updated'
  | 'did-fail-load'
  | 'action'
  | 'destroyed'

interface Entry {
  id: string
  pluginId: string
  win: BrowserWindow
  view: WebContentsView
  allowedHosts: string[]
  visible: boolean
  occluded: boolean
  observing: boolean
  cleanup: Array<() => void>
}

const MAX_PER_PLUGIN = 1
const MAX_TOTAL = 4
const PRIVATE_HOST_RE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/

const isPrivateHost = (host: string): boolean => {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.lan')
    || h.endsWith('.internal') || PRIVATE_HOST_RE.test(h) || (!h.includes('.') && !/^\d+$/.test(h))
}

const normalizeUrl = (input: string): URL => {
  let u: URL
  try { u = new URL(String(input || '')) } catch { throw new IPCError('INVALID_ARGUMENT', 'URL 无效') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new IPCError('BROWSER_VIEW_URL_BLOCKED', '只允许 http / https 页面')
  }
  return u
}

const hostAllowed = (u: URL, allowed: string[]): boolean => {
  if (!allowed.length) return true
  const host = u.hostname.toLowerCase()
  return allowed.some((h) => {
    const x = String(h || '').toLowerCase().trim()
    return x && (host === x || host.endsWith('.' + x))
  })
}

const ACTION_PREFIX = '__AIKM_VIEW_ACTION__'
/** 页面内操作观察脚本：只记录语义动作，不记录密码 / 隐藏字段 / 文件选择 */
const OBSERVER_SCRIPT = `(function () {
  if (window.__AIKM_VIEW_OBSERVE__) return 'already';
  window.__AIKM_VIEW_OBSERVE__ = true;
  var PREFIX = '${ACTION_PREFIX}';
  function send(payload) { try { console.log(PREFIX + JSON.stringify(payload)); } catch (e) {} }
  function css(v) { return (window.CSS && CSS.escape) ? CSS.escape(String(v)) : String(v).replace(/["\\\\]/g, '\\\\$&'); }
  function unique(s) { try { return document.querySelectorAll(s).length === 1; } catch (e) { return false; } }
  function selectorOf(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) { var s = '#' + css(el.id); if (unique(s)) return s; }
    var attrs = ['data-testid', 'data-test', 'data-test-id', 'name', 'aria-label'];
    for (var i = 0; i < attrs.length; i += 1) {
      var v = el.getAttribute(attrs[i]);
      if (v) { var q = el.tagName.toLowerCase() + '[' + attrs[i] + '="' + String(v).replace(/"/g, '\\\\"') + '"]'; if (unique(q)) return q; }
    }
    var path = [], node = el;
    while (node && node.nodeType === 1 && path.length < 6) {
      var tag = node.tagName.toLowerCase();
      if (node.id) { path.unshift('#' + css(node.id)); break; }
      var parent = node.parentElement;
      if (!parent) break;
      var sibs = [];
      for (var j = 0; j < parent.children.length; j += 1) if (parent.children[j].tagName === node.tagName) sibs.push(parent.children[j]);
      if (sibs.length > 1) tag += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      path.unshift(tag);
      var full = path.join(' > ');
      if (unique(full)) return full;
      node = parent;
    }
    return path.join(' > ');
  }
  function sensitive(el) {
    if (!el || !el.tagName) return true;
    var type = String(el.getAttribute('type') || '').toLowerCase();
    if (type === 'password' || type === 'hidden' || type === 'file') return true;
    var name = (String(el.getAttribute('name') || '') + ' ' + String(el.id || '')).toLowerCase();
    return /pass(word)?|secret|token|api[_-]?key|credit|card/.test(name);
  }
  document.addEventListener('click', function (e) {
    if (!window.__AIKM_VIEW_OBSERVE__) return;
    var t = e.target instanceof Element ? e.target : null;
    var el = t && t.closest('a,button,[role="button"],[role="link"],[role="menuitem"],summary,input[type="checkbox"],input[type="radio"]');
    if (!el || sensitive(el)) return;
    send({ kind: 'click', selector: selectorOf(el), text: String(el.innerText || el.getAttribute('aria-label') || '').slice(0, 120) });
  }, true);
  document.addEventListener('change', function (e) {
    if (!window.__AIKM_VIEW_OBSERVE__) return;
    var el = e.target;
    if (!el || sensitive(el)) return;
    if (el.tagName === 'SELECT') {
      var opt = el.selectedOptions && el.selectedOptions[0];
      send({ kind: 'select', selector: selectorOf(el), value: String(el.value || ''), label: opt ? String(opt.label || '') : '' });
    } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) {
      send({ kind: 'fill', selector: selectorOf(el), value: String(el.isContentEditable ? el.innerText : el.value || '').slice(0, 4000) });
    }
  }, true);
  return 'observing';
})();`

class PluginBrowserViewService {
  private entries = new Map<string, Entry>()
  private seq = 1
  private getWindow: () => BrowserWindow | null = () => null

  setWindowProvider(fn: () => BrowserWindow | null): void { this.getWindow = fn }

  private entryOf(pluginId: string, viewId: string): Entry {
    const e = this.entries.get(String(viewId))
    if (!e || e.pluginId !== pluginId) throw new IPCError('BROWSER_VIEW_NOT_FOUND', '内嵌浏览器视图不存在')
    return e
  }

  private plugin(pluginId: string): void {
    const snap = pluginHost.get(pluginId)
    if (!snap) throw new IPCError('NOT_FOUND', '插件未装载')
    if (!(snap.permissions || []).includes('browser.embed')) {
      throw new IPCError('BROWSER_VIEW_PERMISSION_DENIED', '插件未声明 "browser.embed" 权限')
    }
  }

  private send(entry: Entry, type: ViewEventType, payload: Record<string, unknown> = {}): void {
    const win = entry.win
    if (!win || win.isDestroyed()) return
    try {
      win.webContents.send('plugin:browser-view:event', {
        pluginId: entry.pluginId,
        viewId: entry.id,
        type,
        ...payload,
      })
    } catch { /* 窗口关闭 */ }
  }

  private applyBounds(entry: Entry, rect: PluginBrowserViewRect): void {
    const win = entry.win
    if (!win || win.isDestroyed()) throw new IPCError('BROWSER_VIEW_UNAVAILABLE', '宿主窗口不可用')
    const zoom = Math.max(0.25, Math.min(4, Number(win.webContents.getZoomFactor()) || 1))
    const [cw, ch] = win.getContentSize()
    const x = Math.round(Number(rect?.x || 0) * zoom)
    const y = Math.round(Number(rect?.y || 0) * zoom)
    const width = Math.round(Number(rect?.width || 0) * zoom)
    const height = Math.round(Number(rect?.height || 0) * zoom)
    if (!(width > 0 && height > 0)) { entry.view.setVisible(false); return }
    entry.view.setBounds({
      x: Math.max(0, Math.min(cw - 1, x)),
      y: Math.max(0, Math.min(ch - 1, y)),
      width: Math.max(1, Math.min(cw, width)),
      height: Math.max(1, Math.min(ch, height)),
    })
    entry.view.setVisible(entry.visible && !entry.occluded)
  }

  private installObserver(entry: Entry): void {
    if (!entry.observing) return
    const wc = entry.view.webContents
    void wc.executeJavaScript(OBSERVER_SCRIPT, true).catch(() => { /* 页面未就绪 */ })
  }

  async create(pluginId: string, options: { url?: string; allowedHosts?: string[] } = {}, ownerWindow?: BrowserWindow | null): Promise<{ id: string; url: string }> {
    this.plugin(pluginId)
    const mine = [...this.entries.values()].filter((e) => e.pluginId === pluginId)
    if (mine.length >= MAX_PER_PLUGIN) throw new IPCError('BROWSER_VIEW_LIMIT', '每个插件最多一个内嵌浏览器视图')
    if (this.entries.size >= MAX_TOTAL) throw new IPCError('BROWSER_VIEW_LIMIT', '内嵌浏览器视图数量已达上限')
    const win = ownerWindow && !ownerWindow.isDestroyed() ? ownerWindow : this.getWindow()
    if (!win || win.isDestroyed()) throw new IPCError('BROWSER_VIEW_UNAVAILABLE', '宿主窗口不可用')
    const requestedUrl = String(options.url || '').trim()
    const url = !requestedUrl || requestedUrl === 'about:blank' ? 'about:blank' : normalizeUrl(requestedUrl).toString()
    const allowedHosts = Array.isArray(options.allowedHosts) ? options.allowedHosts.map((x) => String(x)) : []
    const partition = `persist:plugin-browser-${String(pluginId).replace(/[^a-z0-9._-]/gi, '_')}`
    try {
      const ses = session.fromPartition(partition)
      ses.setCertificateVerifyProc((request, callback) => {
        if (!request.errorCode) return callback(0)
        const host = String(request.hostname || '')
        return callback(isPrivateHost(host) ? 0 : -3)
      })
    } catch { /* 旧宿主 / 分区不可用 */ }
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        partition,
      },
    })
    const id = `pbv-${Date.now().toString(36)}-${this.seq++}`
    const entry: Entry = { id, pluginId, win, view, allowedHosts, visible: false, occluded: false, observing: false, cleanup: [] }
    this.entries.set(id, entry)
    win.contentView.addChildView(view)
    view.setVisible(false)
    const wc = view.webContents

    const onNavigate = (_e: any, target: string) => {
      try {
        const u = normalizeUrl(target)
        if (!hostAllowed(u, entry.allowedHosts)) {
          wc.stop()
          this.send(entry, 'did-fail-load', { code: -3, description: 'host-not-allowed', url: target })
          return
        }
        this.send(entry, 'did-navigate', { url: target, title: wc.getTitle() })
      } catch { /* 非 http 导航由 will-navigate 拦 */ }
    }
    const onNavInPage = (_e: any, target: string, isMainFrame?: boolean) => {
      if (isMainFrame === false) return
      this.send(entry, 'did-navigate-in-page', { url: target })
    }
    const onStart = () => this.send(entry, 'did-start-loading')
    const onStop = () => this.send(entry, 'did-stop-loading')
    const onTitle = (_e: any, title: string) => this.send(entry, 'page-title-updated', { title: String(title || '') })
    const onFail = (_e: any, code: number, desc: string, target: string) => this.send(entry, 'did-fail-load', { code, description: desc, url: target })
    const onLoad = () => this.installObserver(entry)
    const onConsole = (_e: any, _level: number, message: string) => {
      if (!entry.observing) return
      const text = String(message || '')
      const at = text.indexOf(ACTION_PREFIX)
      if (at < 0) return
      try {
        const action = JSON.parse(text.slice(at + ACTION_PREFIX.length))
        this.send(entry, 'action', { ...action, at: Date.now() })
      } catch { /* 忽略 */ }
    }
    wc.on('did-navigate', onNavigate)
    wc.on('did-navigate-in-page', onNavInPage)
    wc.on('did-start-loading', onStart)
    wc.on('did-stop-loading', onStop)
    wc.on('page-title-updated', onTitle)
    wc.on('did-fail-load', onFail)
    wc.on('did-finish-load', onLoad)
    wc.on('console-message', onConsole)
    wc.on('will-navigate', (e, target) => {
      try {
        const u = normalizeUrl(target)
        if (!hostAllowed(u, entry.allowedHosts)) { e.preventDefault(); this.send(entry, 'did-fail-load', { code: -3, description: 'host-not-allowed', url: target }) }
      } catch { e.preventDefault() }
    })
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    entry.cleanup.push(() => { for (const ev of ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading', 'page-title-updated', 'did-fail-load', 'did-finish-load', 'console-message'] as const) { try { wc.removeAllListeners(ev) } catch { /* 忽略 */ } } })
    if (url !== 'about:blank') void wc.loadURL(url).catch((e) => this.send(entry, 'did-fail-load', { code: -1, description: e?.message || String(e), url }))
    return { id, url }
  }

  async command(pluginId: string, viewId: string, action: string, args: any = {}): Promise<any> {
    const entry = this.entryOf(pluginId, viewId)
    const wc = entry.view.webContents
    switch (String(action)) {
      case 'navigate': {
        const u = normalizeUrl(String(args?.url || ''))
        if (!hostAllowed(u, entry.allowedHosts)) throw new IPCError('BROWSER_VIEW_URL_BLOCKED', '目标不在 allowedHosts 内')
        await wc.loadURL(u.toString())
        return { url: u.toString() }
      }
      case 'reload': wc.reload(); return { ok: true }
      case 'back': if (wc.canGoBack()) wc.goBack(); return { ok: true }
      case 'forward': if (wc.canGoForward()) wc.goForward(); return { ok: true }
      case 'stop': wc.stop(); return { ok: true }
      case 'bounds': this.applyBounds(entry, args?.rect || {}); return { ok: true }
      case 'visible':
        entry.visible = args?.visible === true
        entry.view.setVisible(entry.visible && !entry.occluded)
        return { ok: true }
      case 'occluded':
        entry.occluded = args?.occluded === true
        entry.view.setVisible(entry.visible && !entry.occluded)
        return { ok: true }
      case 'observe': {
        const snap = pluginHost.get(pluginId)
        if (!(snap?.permissions || []).includes('browser.observe')) {
          throw new IPCError('BROWSER_VIEW_PERMISSION_DENIED', '插件未声明 "browser.observe" 权限')
        }
        entry.observing = args?.enabled !== false
        if (entry.observing) this.installObserver(entry)
        else void wc.executeJavaScript('window.__AIKM_VIEW_OBSERVE__ = false;', true).catch(() => {})
        return { observing: entry.observing }
      }
      case 'capture': {
        const snap = pluginHost.get(pluginId)
        if (!(snap?.permissions || []).includes('browser.observe')) {
          throw new IPCError('BROWSER_VIEW_PERMISSION_DENIED', '截图需要 "browser.observe" 权限')
        }
        const image = await wc.capturePage()
        return { base64: image.toPNG().toString('base64') }
      }
      case 'destroy': this.destroy(pluginId, viewId); return { ok: true }
      case 'state': return {
        url: wc.getURL(),
        title: wc.getTitle(),
        canGoBack: wc.canGoBack(),
        canGoForward: wc.canGoForward(),
        loading: wc.isLoading(),
      }
      case 'url': return { url: wc.getURL(), title: wc.getTitle() }
      default: throw new IPCError('INVALID_ARGUMENT', `未知操作：${action}`)
    }
  }

  destroy(pluginId: string, viewId: string): void {
    const entry = this.entries.get(String(viewId))
    if (!entry || entry.pluginId !== pluginId) return
    this.entries.delete(entry.id)
    for (const off of entry.cleanup) { try { off() } catch { /* 忽略 */ } }
    try { if (entry.win && !entry.win.isDestroyed()) entry.win.contentView.removeChildView(entry.view) } catch { /* 忽略 */ }
    try { entry.view.webContents.close() } catch { /* 忽略 */ }
    this.send(entry, 'destroyed')
  }

  destroyForPlugin(pluginId: string): number {
    let n = 0
    for (const e of [...this.entries.values()]) if (e.pluginId === pluginId) { this.destroy(pluginId, e.id); n += 1 }
    return n
  }
}

export const pluginBrowserViewService = new PluginBrowserViewService()

export function registerPluginBrowserViewIpc(): void {
  registerIpc('plugin:browser-view:create', async (payload, event) => {
    const pluginId = String(payload?.pluginId || '')
    if (!pluginId) throw new IPCError('INVALID_ARGUMENT', '缺少 pluginId')
    const ownerWindow = event?.sender ? BrowserWindow.fromWebContents(event.sender) : null
    return pluginBrowserViewService.create(pluginId, {
      url: payload?.url ? String(payload.url) : undefined,
      allowedHosts: Array.isArray(payload?.allowedHosts) ? payload.allowedHosts.map((x: unknown) => String(x)) : undefined,
    }, ownerWindow)
  })
  registerIpc('plugin:browser-view:command', async (payload) => {
    const pluginId = String(payload?.pluginId || '')
    const viewId = String(payload?.viewId || '')
    if (!pluginId || !viewId) throw new IPCError('INVALID_ARGUMENT', '缺少 pluginId / viewId')
    return pluginBrowserViewService.command(pluginId, viewId, String(payload?.action || ''), payload?.args || {})
  })
  registerIpc('plugin:browser-view:destroy', async (payload) => {
    const pluginId = String(payload?.pluginId || '')
    const viewId = String(payload?.viewId || '')
    if (pluginId && viewId) pluginBrowserViewService.destroy(pluginId, viewId)
    return { ok: true }
  })
}
