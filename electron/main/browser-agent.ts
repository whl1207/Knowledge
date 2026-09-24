// electron/main/browser-agent.ts
// 浏览器 Agent 服务（M0/M1 + 多标签）
//  - 内核：独立 BrowserWindow（Vue 壳 #/browser-agent，无边框）+ 顶部多标签栏 / 地址导航栏，
//    网页区由多个 WebContentsView（每标签一个，真实 Chromium，独立 partition）承载
//  - 进程内 MCP server：SDK Server over InMemoryTransport，暴露
//    browser_navigate / browser_extract_text / browser_screenshot / browser_eval（开关控制）
//    —— 作用于「当前激活标签页」
//  - mcp-service 以「内置服务（builtin-browser）」方式接入（设置页可见、Agent/工作流可用）
//  - 壳 UI 通过 browser-agent:* IPC 控制（标签增删/切换 + 地址栏/前进后退/刷新/加载态/AI 指示灯）
import { BrowserWindow, WebContentsView, shell, dialog, app, session, net, type WebContents } from 'electron'
import TurndownService from 'turndown'
import { join, dirname, basename, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as fs from 'node:fs'
import { onGlobalZoomApplied } from './window-zoom'

// ---------------- 打包路径（与 electron/main/index.ts 保持同构） ----------------
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const distElectron = join(__dirname, '..')
const distDir = join(distElectron, '../dist')
const publicDir = process.env.VITE_DEV_SERVER_URL ? join(distElectron, '../public') : distDir
const IS_DEV = !!process.env.VITE_DEV_SERVER_URL
const url: string = process.env.VITE_DEV_SERVER_URL || ''
const indexHtml = join(distDir, 'index.html')
const icon = join(publicDir, 'favicon.ico')

// preload 构建产物可能是 index.mjs（ESM）或 index.cjs（CJS），按实际存在选择
const preloadMjs = join(__dirname, '../preload/index.mjs')
const preloadCjs = join(__dirname, '../preload/index.cjs')
const preload = fs.existsSync(preloadMjs) ? preloadMjs : (fs.existsSync(preloadCjs) ? preloadCjs : undefined)

// Vue 壳顶部两栏高度：标签栏 + 地址/导航栏；WebContentsView 从该高度之下布局
export const TAB_BAR_H = 36
export const NAV_BAR_H = 42
export const VIEW_TOP = TAB_BAR_H + NAV_BAR_H

/** 单次返回给模型的正文/HTML 默认上限（可经 MCP 工具 schema 的 maxChars 参数覆盖；不传时默认 30000 字符） */
const DEFAULT_MAX_TEXT = 30000
/** 截图 dataUrl 上限字符 */
const MAX_SCREENSHOT = 4_000_000
/** AI 标签自动回收（窗口内建能力）：最后一次 AI 工具调用后空闲多久开始回收 AI 标签（ms） */
const AGENT_RECYCLE_DELAY = 90_000
/** 用户最近查看过的标签保留窗口：即便带 AI 标记，只要在此时间内被用户看过/操作过就不回收（ms） */
const USER_KEEP_WINDOW = 120_000
/** AI 会话标签数量上限：单窗口最多保留的 AI 标签数；超过时在每次工具调用结束后自动回收最旧的（大批量 agent 脚手架运行期防堆积） */
const AGENT_TAB_CAP = 12
/** AI 标签被“溢出回收”前须距最近一次被 AI 使用超过的时长（避免误删仍会被当前/其它会话复用的标签） */
const AGENT_USE_KEEP = 120_000

/** 解析调用方传入的 maxChars：正整数取原值；未传/非法 → 默认 DEFAULT_MAX_TEXT（30000） */
const resolveMaxChars = (v: unknown, def: number = DEFAULT_MAX_TEXT): number => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n > 0 ? n : def
}

// ---------------- 运行时懒加载 MCP Server SDK ----------------
// 与 mcp-service 同理：主进程被 vite 打包时不能静态内联 MCP SDK（zod v4 内联损坏），
// 一律 @vite-ignore 在运行时从 node_modules 加载 ESM 真实模块。
interface ServerSdkBundle {
  Server: any
  InMemoryTransport: any
  ListToolsRequestSchema: any
  CallToolRequestSchema: any
}
let serverSdkCache: ServerSdkBundle | null = null
async function getServerSdk(): Promise<ServerSdkBundle> {
  if (serverSdkCache) return serverSdkCache
  const [serverMod, inMemoryMod, typesMod] = await Promise.all([
    import(/* @vite-ignore */ '@modelcontextprotocol/sdk/server/index.js'),
    import(/* @vite-ignore */ '@modelcontextprotocol/sdk/inMemory.js'),
    import(/* @vite-ignore */ '@modelcontextprotocol/sdk/types.js'),
  ])
  serverSdkCache = {
    Server: (serverMod as any).Server ?? (serverMod as any).McpServer,
    InMemoryTransport: (inMemoryMod as any).InMemoryTransport,
    ListToolsRequestSchema: (typesMod as any).ListToolsRequestSchema,
    CallToolRequestSchema: (typesMod as any).CallToolRequestSchema,
  }
  return serverSdkCache
}

// ---------------- 状态类型 ----------------
export interface BrowserTabMeta {
  id: string
  title: string
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** 网站图标（网页真实 favicon 的 dataURL；顶部标签左侧展示） */
  favicon?: string
  /** 是否为 AI 会话产生的标签（空闲时自动回收；用户主动切到后转为普通标签不再回收） */
  agent?: boolean
  /** 用户最近一次查看/操作该标签的时间戳（用于回收判定：近期看过的标签保留） */
  lastUserAt?: number
  /** 最近一次被 AI 工具使用的时间戳（用于“溢出回收”判定：近期被 AI 用过的标签不优先剪除） */
  lastAgentAt?: number
  /** 属主：创建/使用该标签的 agent 会话 id（viewId / agentId / 批次行 id）。会话 idle/结束时可精确回收自己的标签 */
  owner?: string
}
export interface BrowserAgentState {
  tabs: BrowserTabMeta[]
  activeTabId: string | null
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  agentActive: boolean
  /** AI 正在操作的标签 id（null=无；chip 忙碌态据此跟随标签页显示） */
  agentBusyTabId: string | null
  agentTool: string
  allowEval: boolean
}

/** 规范化导航 URL（补 https://） */
function normalizeUrl(raw: string): string {
  const v = String(raw || '').trim()
  if (!v) return 'about:blank'
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) return v
  return `https://${v}`
}

/** 浏览器书签树节点（Netscape 书签 HTML 解析 / 导出用） */
interface NetBmNode {
  kind: 'dir' | 'file'
  title: string
  url?: string
  icon?: string
  path?: string
  children?: NetBmNode[]
}

class BrowserAgentService {
  private win: BrowserWindow | null = null
  private tabs: BrowserTabMeta[] = []
  private views = new Map<string, WebContentsView>()
  private activeTabId: string | null = null
  private allowEval = false
  private agentActive = false
  private agentBusyTabId: string | null = null
  private agentTool = ''
  private seq = 0
  private themeUi: Record<string, string> | null = null
  /** 壳窗口右侧「设置」停靠栏展开占用的宽度（px；0=收起）。展开时网页视图让出该宽度，与 DOM 侧栏并排互不遮挡 */
  private sideRailW = 0
  /** 紧凑模式（壳隐藏地址/工具条、仅保留标签栏）时地址栏高度按 0 处理，网页区从标签栏下直接开始 */
  private navHidden = false
  /** 是否已注册「全局缩放变化」回调（窗口重建时不重复注册） */
  private zoomLayoutHooked = false
  /** webContents.id -> 已注入的滚动条 CSS key（导航后需重新注入） */
  private themeKeys = new Map<number, string>()
  /** AI 标签空闲回收计时器（无新 AI 调用后触发；随每次工具调用重置） */
  private recycleTimer: ReturnType<typeof setTimeout> | null = null
  /** 本次 AI 工具调用所属的 agent 会话 id（executeTool 时由 ctx.agentId/sessionId 注入；用于给新标签打属主） */
  private agentOwner: string | null = null
  /** 共享 MCP Server（内置连接 + 对外 HTTP 暴露共用；可同时 connect 多个 transport） */
  private mcpServer: any = null
  /** favicon 缓存：host -> dataURL（内存缓存；首拉后写入 userData/browser-favicons 落盘，跨会话复用） */
  private faviconCache = new Map<string, string>()

  // ===================== 窗口 =====================
  /** 确保壳窗口 + 标签页存在（惰性创建；已存在则聚焦）。homeUrl 仅手动打开时传入（默认首页，仅作用于新建窗口的首个标签） */
  ensureWindow(homeUrl = ''): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) {
      if (!this.win.isVisible()) this.win.show()
      this.win.focus()
      return this.win
    }

    const win = new BrowserWindow({
      title: '浏览器 Agent',
      // 默认尺寸与主窗口一致
      width: 900,
      height: 600,
      // 最小尺寸与主窗口一致
      minWidth: 550,
      minHeight: 350,
      icon,
      show: false,
      backgroundColor: '#f6f8fa',
      // 与主应用一致的自定义标题栏：无系统边框/标题栏，拖动与窗口按钮由 Vue 壳顶栏提供
      ...(process.platform === 'linux' ? { frame: false } : { titleBarStyle: 'hidden' }),
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: false,
      },
    })
    this.win = win

    // 全局窗口缩放变化时重排原生视图（壳被缩放后，栏高/侧栏宽的 CSS px 需按 zoom 换算成 DIP）
    if (!this.zoomLayoutHooked) {
      this.zoomLayoutHooked = true
      onGlobalZoomApplied(() => this.layout())
    }
    if (IS_DEV) {
      win.loadURL(`${url}#/browser-agent`)
    } else {
      win.loadFile(indexHtml, { hash: '/browser-agent' })
    }

    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show()
    })

    // 壳窗口自身（Vue UI）内的 window.open（如顶栏「在系统浏览器打开当前页」）：
    // 无拦截时 Electron 会默认新开一个 Electron 窗口加载 URL，看起来仍是 Electron 打开。
    // 这里统一拒绝并交给系统默认应用（http/https/file → 系统浏览器，其余按系统协议处理）。
    win.webContents.setWindowOpenHandler(({ url: target }) => {
      if (target) {
        try { shell.openExternal(target) } catch { /* 忽略非法协议 */ }
      }
      return { action: 'deny' }
    })

    win.webContents.on('did-finish-load', () => {
      if (!win.isDestroyed() && !win.isVisible()) win.show()
      this.layout()
      this.pushState()
    })
    win.on('resize', () => this.layout())
    win.on('close', () => {
      this.sideRailW = 0
      for (const [, view] of this.views) {
        try { view.webContents.stop() } catch { /* ignore */ }
      }
      this.views.clear()
      this.tabs = []
      this.activeTabId = null
      this.win = null
    })

    // 首个标签页：手动打开带默认页面，否则空白页（AI navigate 会自行导航到目标 URL）
    void this.addTab(homeUrl || undefined)
    return win
  }

  /** 创建并挂载一个标签视图 */
  private createTabView(): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        partition: 'persist:browser-agent',
        allowRunningInsecureContent: false,
      },
    })
    this.win?.contentView.addChildView(view)
    // 事件 → 更新该标签 meta 并广播；导航完成后重新注入主题化滚动条（导航会清除旧注入）
    const wc = view.webContents
    // 伪装为纯净桌面 Chrome：去掉 UA 里的应用名(dev=knowledge / 打包=AI-KM)与 Electron 私有标识。
    // 否则 bilibili 等站点会把 UA 识别成“非标准/低版本”浏览器而弹出「浏览器版本过低 / 不受支持」。
    // 修正后形如：Mozilla/5.0 (...) Chrome/124.0.0.0 Safari/537.36
    try {
      wc.setUserAgent(
        wc.getUserAgent()
          .replace(/\s+(knowledge|AI-KM)\/[\w.\-]+/i, '')
          .replace(/\s+Electron\/[\w.\-]+/i, '')
          .trim()
      )
    } catch { /* 极早阶段取不到 UA 时忽略 */ }
    const onNavDone = () => { void this.applyThemeToWc(wc); this.touchActiveMeta(wc) }
    wc.on('did-start-loading', () => this.touchActiveMeta(wc))
    wc.on('did-stop-loading', onNavDone)
    wc.on('did-navigate', onNavDone)
    wc.on('did-navigate-in-page', onNavDone)
    wc.on('page-title-updated', () => this.touchActiveMeta(wc))
    // 网站图标更新（真实网页图标；转 dataURL 后随状态推送，供顶部标签左侧显示）
    wc.on('page-favicon-updated', () => {
      const tab = this.tabs.find(t => this.views.get(t.id)?.webContents === wc)
      if (tab) {
        tab.favicon = this.captureFaviconDataUrl(wc)
        this.pushState()
      }
    })
    wc.on('did-fail-load', (_e: any, code: number, desc: string, validatedURL: string) => {
      this.touchActiveMeta(wc)
      this.toast(`加载失败 (${code}): ${desc}\n${validatedURL}`)
    })
    wc.setWindowOpenHandler(({ url: target }: { url: string }) => {
      // 网页内新开链接（target=_blank / window.open）→ 本浏览器窗口内新建标签页打开
      if (target && (target.startsWith('http:') || target.startsWith('https:') || target.startsWith('file:'))) {
        // AI 会话（agentActive）期间新开的页面标签标记为 agent，并带上当前属主（会话 idle 时可精确回收）
        void this.addTab(target, { agent: this.agentActive, owner: this.agentOwner || undefined })
        return { action: 'deny' }
      }
      // 非网页协议（mailto 等）交给系统
      if (target) shell.openExternal(target)
      return { action: 'deny' }
    })
    return view
  }

  /** 壳右侧「设置」停靠栏展开/收起：让网页视图让出右侧宽度，使 DOM 侧栏（Vue 壳渲染）与原生网页并排显示 */
  setSideRail(open: boolean, width?: number) {
    const w = Number(width)
    this.sideRailW = open ? (Number.isFinite(w) && w > 0 ? Math.round(w) : 320) : 0
    this.layout()
  }

  /** 主题更新：记住配色并重应用到所有标签页 */
  setTheme(ui: any) {
    this.themeUi = (ui && typeof ui === 'object') ? ui : null
    for (const tab of this.tabs) {
      const view = this.views.get(tab.id)
      if (view) void this.applyThemeToWc(view.webContents)
    }
  }

  /** 向一个 webContents 注入主题化滚动条 CSS（先移除旧注入，避免累积） */
  private async applyThemeToWc(wc: WebContents) {
    if (!this.themeUi || !wc || wc.isDestroyed()) return
    const old = this.themeKeys.get(wc.id)
    if (old) {
      try { wc.removeInsertedCSS(old) } catch { /* 忽略 */ }
      this.themeKeys.delete(wc.id)
    }
    try {
      const key = await wc.insertCSS(this.buildScrollbarCss())
      this.themeKeys.set(wc.id, key)
    } catch { /* 页面尚未可注入时忽略（导航完成后会重试） */ }
  }

  /** 生成与主题适配的细圆角滚动条样式（webContents 页面无应用 CSS 变量，按主题色直接插值） */
  private buildScrollbarCss(): string {
    const fg = this.themeUi?.fontColor || '#888888'
    const accent = this.themeUi?.fontActiveColor || '#409eff'
    return [
      '::-webkit-scrollbar{width:10px;height:10px}',
      '::-webkit-scrollbar-track{background:transparent}',
      `::-webkit-scrollbar-thumb{background:color-mix(in srgb, ${fg} 18%, transparent);border-radius:8px;border:2px solid transparent;background-clip:padding-box}`,
      `::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb, ${accent} 60%, transparent);border-radius:8px;border:2px solid transparent;background-clip:padding-box}`,
      '::-webkit-scrollbar-corner{background:transparent}',
    ].join('\n')
  }

  /** 根据 webContents 归属的标签刷新 meta（标题/URL/加载态/历史） */
  private touchActiveMeta(wc: WebContents) {
    const tab = this.tabs.find(t => this.views.get(t.id)?.webContents === wc)
    if (!tab) return
    tab.loading = wc.isLoading()
    tab.canGoBack = wc.canGoBack()
    tab.canGoForward = wc.canGoForward()
    const u = wc.getURL()
    if (u && u !== 'about:blank') tab.url = u
    const t = wc.getTitle()
    if (t) tab.title = t
    // 尽力同步网站图标（若 Chromium 已缓存；页签 favicon 事件也会再补一次）
    tab.favicon = this.captureFaviconDataUrl(wc)
    // 同步视图可见性（空白标签隐藏 → 真实导航开始时立即显示）
    this.layout()
    this.pushState()
  }

  /** 布局所有标签视图：同一内容区，仅激活可见；空白（未导航）标签隐藏原生视图 → 露出壳的书签首页
   *  右侧设置栏展开时（sideRailW>0）网页区宽度让出侧栏宽度，供壳的 DOM 侧栏与原生网页并排 */
  private layout() {
    if (!this.win || this.win.isDestroyed()) return
    const [w, h] = this.win.getContentSize()
    // ⚠️ 全局窗口缩放（window-zoom.ts）只作用于壳页面：壳里的 CSS px × zoom = 窗口 DIP。
    // 侧栏宽（壳上报的 CSS px）与栏高常量都必须按 zoom 换算后再 setBounds，
    // 否则缩放≠100% 时原生网页视图会与壳的栏/侧栏错位（实测）。
    const z = this.shellZoom()
    const availW = Math.max(0, w - Math.round((this.sideRailW || 0) * z))
    // 紧凑模式（壳隐藏地址/工具条）下网页区从标签栏下直接开始，顶栏高度仅剩标签栏
    const top = Math.round((TAB_BAR_H + (this.navHidden ? 0 : NAV_BAR_H)) * z)
    for (const tab of this.tabs) {
      const view = this.views.get(tab.id)
      if (!view) continue
      view.setBounds({ x: 0, y: top, width: availW, height: Math.max(0, h - top) })
      const isBare = !tab.url && !tab.loading // 空白标签（书签首页）
      view.setVisible(tab.id === this.activeTabId && !isBare)
    }
  }

  /** 壳页面的当前 zoomFactor（1 = 100%）；用于把壳的 CSS px 尺寸换算成窗口 DIP */
  private shellZoom(): number {
    const wc = this.win?.webContents
    const z = wc && !wc.isDestroyed() ? wc.zoomFactor : 1
    return Number.isFinite(z) && z > 0 ? z : 1
  }

  /** 紧凑模式：壳窗口过小时隐藏地址/工具条（仅保留标签栏），网页区上移从标签栏下开始占满 */
  setCompact(compact: boolean) {
    const next = !!compact
    if (this.navHidden === next) return
    this.navHidden = next
    this.layout()
  }

  close() {
    this.cancelAgentRecycle()
    this.sideRailW = 0
    if (this.win && !this.win.isDestroyed()) this.win.close()
    this.views.clear()
    this.tabs = []
    this.activeTabId = null
    this.win = null
  }

  dispose() { this.close() }

  // ===================== AI 标签自动回收（窗口内建优化，无需模型显式清理 / 不改主循环） =====================
  /** 取消待执行的回收计时器 */
  private cancelAgentRecycle() {
    if (this.recycleTimer) {
      clearTimeout(this.recycleTimer)
      this.recycleTimer = null
    }
  }

  /** 安排一次空闲回收：AI 最后一次工具调用后，若一段时间内无新调用（会话结束）则回收 AI 产生的标签 */
  private scheduleAgentRecycle() {
    this.cancelAgentRecycle()
    this.recycleTimer = setTimeout(() => {
      this.recycleTimer = null
      this.recycleAgentTabs()
    }, AGENT_RECYCLE_DELAY)
  }

  /**
   * 回收 AI 会话产生的标签页（窗口手动入口 与 空闲自动回收共用）：
   *  - 只关闭标记为 agent（AI 会话中 window.open / 新开页面等产生）的标签；
   *  - 当前激活标签（用户正在看的页面）一律保留；
   *  - 用户在 USER_KEEP_WINDOW 内查看/操作过的标签保留；
   *  - 用户手动点击切换标签（switchTab）会清除 agent 标记，因此这些标签永不被回收。
   * @returns 实际关闭的标签数
   */
  recycleAgentTabs(): number {
    if (this.agentActive || !this.win || this.win.isDestroyed()) return 0
    const now = Date.now()
    const doomed: string[] = []
    for (const t of this.tabs) {
      if (!t.agent) continue
      if (t.id === this.activeTabId) continue // 用户正在看
      if (t.lastUserAt && now - t.lastUserAt < USER_KEEP_WINDOW) continue // 用户最近看过
      doomed.push(t.id)
    }
    if (!doomed.length) return 0
    for (const id of doomed) this.closeTab(id)
    this.pushState()
    return doomed.length
  }

  /**
   * 精确回收「某个属主（agent 会话 / 批次行）」名下的 AI 标签：
   * 会话 idle / dispose 时调用——谁结束就收谁的，互不影响（不依赖全局 90s 静默 / cap）。
   * 保留：当前激活标签（用户正看）、被用户点过接管的标签（agent 已被置 false）。
   * @param owner agent 会话 id（与标签 meta.owner 一致）
   * @returns 实际关闭的标签数
   */
  recycleOwnerTabs(owner: string): number {
    if (!owner || !this.win || this.win.isDestroyed()) return 0
    const doomed = this.tabs
      .filter((t) => t.agent && t.owner === owner && t.id !== this.activeTabId)
      .map((t) => t.id)
    if (!doomed.length) return 0
    for (const id of doomed) this.closeTab(id)
    this.pushState()
    return doomed.length
  }

  /**
   * 溢出自动回收（大批量 agent 脚手架运行期防堆积）：
   * 每次 AI 工具调用结束后执行一次——当 AI 会话标签数超过 AGENT_TAB_CAP 时，
   * 自动回收最旧的 AI 标签（保留：当前激活标签、用户近期查看、近期被 AI 使用的标签）。
   * 与「空闲回收（recycleAgentTabs）」互补：空闲回收要等整窗静默 90s 才触发，
   * 而批量/并发脚手架运行中浏览器会被持续调用，空闲计时器不断重置 → 本方法保证
   * 窗口里 AI 标签数量有界，无需等大批量跑完。
   * @returns 实际关闭的标签数
   */
  private recycleOverflowAgentTabs(): number {
    if (!this.win || this.win.isDestroyed()) return 0
    const agentCount = this.tabs.filter(t => t.agent).length
    if (agentCount <= AGENT_TAB_CAP) return 0
    const now = Date.now()
    const surplus = agentCount - AGENT_TAB_CAP
    // 候选：AI 标签 且 非激活 且 用户近期未查看 且 近期未被 AI 使用
    const candidates = this.tabs
      .map((t, i) => ({ t, i }))
      .filter(({ t }) =>
        t.agent &&
        t.id !== this.activeTabId &&
        !(t.lastUserAt && now - t.lastUserAt < USER_KEEP_WINDOW) &&
        !(t.lastAgentAt && now - t.lastAgentAt < AGENT_USE_KEEP)
      )
      // 最久未被 AI 使用的优先回收；其次标签位置靠前
      .sort((a, b) => (a.t.lastAgentAt || 0) - (b.t.lastAgentAt || 0) || a.i - b.i)
    let closed = 0
    for (const { t } of candidates) {
      if (closed >= surplus) break
      this.closeTab(t.id)
      closed++
    }
    if (closed) this.pushState()
    return closed
  }

  private toast(msg: string) {
    this.sendToShell('browser-agent:toast', { message: String(msg).slice(0, 2000) })
  }
  private sendToShell(channel: string, payload: unknown) {
    if (this.win && !this.win.isDestroyed() && !this.win.webContents.isDestroyed()) {
      this.win.webContents.send(channel, payload)
    }
  }

  /** 新增标签页（可带初始 URL）；新建后自动激活。opts.agent=true 表示由 AI 会话创建；opts.owner=创建它的会话 id */
  async addTab(rawUrl?: string, opts?: { agent?: boolean; owner?: string }) {
    if (!this.win || this.win.isDestroyed()) return
    const view = this.createTabView()
    const id = `tab-${Date.now()}-${this.seq++}`
    this.views.set(id, view)
    const agent = !!opts?.agent
    const owner = agent ? (opts?.owner || this.agentOwner || undefined) : undefined
    this.tabs.push({
      id, title: '', url: '', loading: false, canGoBack: false, canGoForward: false,
      agent,
      owner,
      lastUserAt: agent ? undefined : Date.now(),
      lastAgentAt: agent ? Date.now() : undefined,
    })
    this.activeTabId = id
    this.layout()
    this.pushState()
    if (rawUrl) {
      await this.navigate(rawUrl)
    } else {
      // 空白标签：不加载任何页面（原生视图保持隐藏，壳显示「搜索」新标签首页）
      this.layout()
    }
  }

  /**
   * 切换激活标签。
   * @param byUser  true=用户点击接管（壳 UI / IPC）：清除 AI 标记并记录最近查看时间 → 永不被自动回收；
   *                false=AI 工具（browser_switch_tab）：保留 agent 标记（仍可被空闲/溢出回收），仅刷新最近 AI 使用时间。
   */
  switchTab(id: string, byUser = true) {
    if (!this.tabs.some(t => t.id === id)) return
    this.activeTabId = id
    const tab = this.tabs.find(t => t.id === id)
    if (tab) {
      if (byUser) {
        tab.agent = false
        tab.lastUserAt = Date.now()
      } else {
        // AI 切过去的标签仍属 AI 会话产物：只刷新 lastAgentAt，不解除 agent 标记
        tab.lastAgentAt = Date.now()
      }
    }
    this.layout()
    this.pushState()
  }

  /** 关闭标签；关到空时自动新建空白标签 */
  closeTab(id: string) {
    const idx = this.tabs.findIndex(t => t.id === id)
    if (idx < 0) return
    const view = this.views.get(id)
    if (view) {
      try {
        if (this.win && !this.win.isDestroyed()) this.win.contentView.removeChildView(view)
        view.webContents.stop()
        view.webContents.close()
      } catch { /* ignore */ }
    }
    this.views.delete(id)
    this.tabs.splice(idx, 1)
    if (this.activeTabId === id) {
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)]
      this.activeTabId = next ? next.id : null
    }
    if (this.tabs.length === 0) {
      // 保留窗口：自动补一个空白标签
      void this.addTab()
      return
    }
    this.layout()
    this.pushState()
  }

  /** 拖拽调整标签顺序：把 id 标签移动到目标下标（0 基，指移动后的最终位置） */
  moveTab(id: string, toIndex: number) {
    if (!this.tabs.length) return
    const from = this.tabs.findIndex(t => t.id === id)
    if (from < 0) return
    let to = Number.isFinite(Number(toIndex)) ? Math.round(Number(toIndex)) : this.tabs.length - 1
    to = Math.max(0, Math.min(this.tabs.length - 1, to))
    if (from === to) return
    const [tab] = this.tabs.splice(from, 1)
    if (from < to) to -= 1 // 移除靠前元素后目标下标前移一位
    this.tabs.splice(to, 0, tab)
    this.layout()
    this.pushState()
  }

  private activeTab(): BrowserTabMeta | undefined {
    return this.tabs.find(t => t.id === this.activeTabId)
  }
  /** 从工具参数解析标签：优先 id，其次 index（0 基）/ title 模糊 */
  private resolveTabRef(args: Record<string, any>): string | undefined {
    if (!this.tabs.length) return undefined
    const id = String(args?.id || '').trim()
    if (id) {
      const byId = this.tabs.find(t => t.id === id || t.url === id)
      if (byId) return byId.id
    }
    const index = Number(args?.index)
    if (Number.isFinite(index) && this.tabs[index]) return this.tabs[index].id
    const q = String(args?.title || args?.url || '').trim().toLowerCase()
    if (q) {
      const byQ = this.tabs.find(t => (t.title || '').toLowerCase().includes(q) || (t.url || '').toLowerCase().includes(q))
      if (byQ) return byQ.id
    }
    return undefined
  }
  private activeView(): WebContentsView | undefined {
    const id = this.activeTabId
    return id ? this.views.get(id) : undefined
  }
  private ensureWc(): WebContents {
    const wc = this.activeView()?.webContents
    if (!wc || wc.isDestroyed()) throw new Error('浏览器视图不可用（请先打开标签页）')
    return wc
  }

  // ===================== 网页控制（作用于激活标签） =====================
  /** 用浏览器打开本地 html 文件（file:// URL；含空格/中文自动编码） */
  async openFile(filePath: string): Promise<void> {
    if (!filePath) throw new Error('缺少文件路径')
    const fileUrl = pathToFileURL(filePath).href
    if (this.win && !this.win.isDestroyed()) {
      // 已有浏览器窗口：聚焦并在当前窗口新建标签页加载该文件
      this.ensureWindow()
      await this.addTab(fileUrl)
    } else {
      // 尚无窗口：直接创建，首标签即加载该文件（避免先出现一个空白 about:blank 标签）
      this.ensureWindow(fileUrl)
    }
  }

  /**
   * 用内置浏览器打开外部 URL（设置页文档链接等；替代系统浏览器）。
   * 已有窗口 → 新标签页打开（不夺走当前页面）；尚无窗口 → 首标签直接加载该页（不留空白标签）。
   */
  async openUrl(rawUrl: string): Promise<void> {
    const url = normalizeUrl(rawUrl)
    if (!url || url === 'about:blank') throw new Error('缺少 URL')
    if (this.win && !this.win.isDestroyed()) {
      this.ensureWindow()
      await this.addTab(url)
    } else {
      this.ensureWindow(url)
    }
  }

  async navigate(raw: string): Promise<void> {
    const target = normalizeUrl(raw)
    // 导航前先把目标 URL 写入标签 meta 并推送，让壳地址栏即时跟随（真实加载完成后再由事件修正标题等）
    const tab = this.activeTab()
    if (tab) {
      tab.url = target
      tab.loading = true
    }
    this.layout()
    this.pushState()
    const wc = this.ensureWc()
    try {
      await wc.loadURL(target)
    } finally {
      this.touchActiveMeta(wc)
    }
  }
  goBack() { this.ensureWc().goBack() }
  goForward() { this.ensureWc().goForward() }
  reload() { this.ensureWc().reload() }
  stop() { this.ensureWc().stop() }

  /** 提取可读正文（innerText 截断；maxChars 可选，不传默认 DEFAULT_MAX_TEXT=30000） */
  async extractText(maxChars?: number): Promise<{ url: string; title: string; text: string; length: number }> {
    const wc = this.ensureWc()
    const res: any = await wc.executeJavaScript(
      `(async () => {
        const pick = (sel) => { try { const el = document.querySelector(sel); return el ? el.innerText : '' } catch { return '' } }
        const body = (document.body && document.body.innerText) || ''
        const article = pick('article') || pick('main') || pick('[role="main"]')
        const text = (article || body).replace(/\\n{3,}/g, '\\n\\n').trim()
        return { title: document.title || '', url: location.href, text, length: text.length }
      })()`
    )
    const text = String(res?.text || '')
    const cap = resolveMaxChars(maxChars)
    const limited = text.length > cap ? text.slice(0, cap) + `\n…[内容过长已截断，共 ${text.length} 字符]` : text
    return {
      url: String(res?.url || ''),
      title: String(res?.title || ''),
      text: limited,
      length: limited.length,
    }
  }

  /**
   * 提取正文 → 干净的 Markdown（只保留文字与链接）。
   * 在页面内克隆 article/main 正文区，剔除脚本/样式/导航/头部/页脚/侧栏/表单等噪音节点，
   * 保留标题层级、段落、列表与 `<a>` 链接（并补全相对 URL），序列化为净化 HTML 后回传主进程，
   * 再用 turndown 转换为标准 Markdown（链接形如 [文字](https://…)），便于智能体阅读与溯源。
   */
  async extractMarkdown(maxChars?: number): Promise<{ url: string; title: string; markdown: string; length: number }> {
    const wc = this.ensureWc()
    const res: any = await wc.executeJavaScript(`(() => {
      const clean = (el) => {
        if (!el) return null
        const clone = el.cloneNode(true)
        // 噪音节点：脚本/样式/内联 / 导航栏 / 页头页脚 / 侧栏 / 广告 / 表单控件 / 隐藏元素
        clone.querySelectorAll('script,style,link,meta,noscript,iframe,svg,nav,header,footer,aside,form,button,input,select,textarea,[hidden],[aria-hidden="true"],[class*="ad"],[class*="banner"],[class*="menu"],[class*="cookie"]').forEach(n => n.remove())
        return clone
      }
      const pick = (sel) => { try { const el = document.querySelector(sel); return clean(el) } catch { return null } }
      let root = pick('article') || pick('main') || pick('[role="main"]') || pick('.post') || pick('.entry-content') || pick('.content')
      if (!root) { const b = document.body; root = b ? clean(b) : null }
      if (!root) return { html: '', title: '', url: '' }
      // 绝对化链接（保留 <a href>；去掉无意义的 javascript:/# 空链）
      root.querySelectorAll('a').forEach(a => {
        const href = (a.getAttribute('href') || '').trim()
        if (!href || /^javascript:/i.test(href) || href === '#') { a.replaceWith(document.createTextNode(a.textContent || '')); return }
        try { a.setAttribute('href', new URL(href, location.href).href) } catch { /* 忽略非法 */ }
      })
      // 图片替换为 alt 文字（正文只保留文字与链接，图片本身不承载阅读信息）
      root.querySelectorAll('img').forEach(img => {
        const alt = (img.getAttribute('alt') || '').trim()
        if (alt) img.replaceWith(document.createTextNode('[图] ' + alt))
        else img.remove()
      })
      // 压缩空白并截取上限，避免超大页面占用 IPC
      const MAX_HTML = 400_000
      let html = (root.outerHTML || '').replace(/\\s{2,}/g, ' ')
      if (html.length > MAX_HTML) html = html.slice(0, MAX_HTML) + '…'
      return { html, title: document.title || '', url: location.href }
    })()`)
    const html = String(res?.html || '').trim()
    if (!html) throw new Error('未提取到正文 HTML（页面可能为空或尚未加载完成）')
    const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' })
    // 空链接文字不应残留（turndown 默认会输出 [text]() 之类）
    let md = turndown.turndown(html)
      .replace(/\[([^\]]*)\]\(\)/g, '$1') // [text]() → text
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    const cap = resolveMaxChars(maxChars)
    const limited = md.length > cap ? md.slice(0, cap) + `\n…[Markdown 过长已截断，共 ${md.length} 字符]` : md
    return {
      url: String(res?.url || ''),
      title: String(res?.title || ''),
      markdown: limited,
      length: limited.length,
    }
  }

  /** 截图 → PNG dataUrl */
  async screenshot(): Promise<{ dataUrl: string; width: number; height: number }> {
    const img = await this.ensureWc().capturePage()
    const buf = img.toPNG()
    let dataUrl = `data:image/png;base64,${buf.toString('base64')}`
    if (dataUrl.length > MAX_SCREENSHOT) dataUrl = dataUrl.slice(0, MAX_SCREENSHOT) + '…[截图过大已截断]'
    const size = img.getSize()
    return { dataUrl, width: size.width, height: size.height }
  }

  /** 执行任意 JS（受 allowEval 开关约束） */
  async evalJs(code: string): Promise<string> {
    if (!this.allowEval) throw new Error('browser_eval 未开启：请在浏览器 Agent 窗口勾选“允许 eval”')
    if (!code || typeof code !== 'string') throw new Error('缺少 code 参数')
    const raw: unknown = await this.ensureWc().executeJavaScript(code, true)
    if (typeof raw === 'string') return raw
    try { return JSON.stringify(raw, null, 2) } catch { return String(raw) }
  }

  // ===================== 工具执行（toolRegistry 直通 与 进程内 MCP server 共用） =====================
  /**
   * @param opts.owner 发起本次调用的 agent 会话 id（由 tools.ts 从 ToolExecutionContext.agentId/sessionId 注入）：
   *                   该会话新建的 AI 标签会打上 owner，会话 idle/结束时可精确回收。
   */
  async executeTool(toolName: string, args: Record<string, any>, opts?: { owner?: string }): Promise<string> {
    // AI 首次调用而窗口尚未创建 → 自动创建（M0：浏览器 Agent 独立窗口）
    if (!this.win || this.win.isDestroyed()) this.ensureWindow()
    const owner = typeof opts?.owner === 'string' && opts.owner.trim() ? opts.owner.trim() : null
    this.agentOwner = owner
    this.agentActive = true
    // 记录本次 AI 操作所作用的标签（通常即当前激活标签；后续切标签不影响此标记，chip 忙碌态只在该标签激活时显示）
    this.agentBusyTabId = this.activeTabId
    this.agentTool = toolName
    // 刷新该标签最近被 AI 使用的时间（溢出回收的保留依据）；若它是无主的 AI 标签，则归本会话所有
    const opTab = this.activeTab()
    if (opTab) {
      opTab.lastAgentAt = Date.now()
      if (opTab.agent && !opTab.owner && owner) opTab.owner = owner
    }
    this.pushState()
    try {
      switch (toolName) {
        case 'browser_navigate': {
          const u = String(args?.url || '')
          if (!u) throw new Error('缺少 url 参数')
          await this.navigate(u)
          return `已导航至 ${normalizeUrl(u)}`
        }
        case 'browser_extract_text': {
          const r = await this.extractText(resolveMaxChars(args?.maxChars))
          return `页面标题：${r.title}\n页面地址：${r.url}\n正文长度：${r.length} 字符\n\n${r.text}`
        }
        case 'browser_extract_markdown': {
          const r = await this.extractMarkdown(resolveMaxChars(args?.maxChars))
          return `页面标题：${r.title}\n页面地址：${r.url}\nMarkdown 长度：${r.length} 字符\n\n${r.markdown}`
        }
        case 'browser_screenshot': {
          const s = await this.screenshot()
          return JSON.stringify({ mime: 'image/png', width: s.width, height: s.height, length: s.dataUrl.length, data: s.dataUrl })
        }
        case 'browser_eval':
          return await this.evalJs(String(args?.code || ''))
        case 'browser_list_tabs': {
          if (!this.win || this.win.isDestroyed()) return '浏览器窗口未打开'
          if (!this.tabs.length) return '暂无标签页'
          return this.tabs.map((t, i) => {
            const flag = t.id === this.activeTabId ? '●' : '○'
            const tag = t.agent ? ' [AI]' : ''
            return `${i}. ${flag}${tag} ${t.title || '(无标题)'} — ${t.url || '(空白)'}`
          }).join('\n')
        }
        case 'browser_new_tab': {
          // AI 主动新开标签：标记为 agent 会话标签，空闲后自动回收
          await this.addTab(String(args?.url || ''), { agent: true })
          return args?.url ? `已在 AI 标签打开 ${normalizeUrl(String(args.url))}` : '已新建空白标签页（AI 会话标签）'
        }
        case 'browser_switch_tab': {
          const id = this.resolveTabRef(args)
          if (!id) throw new Error('找不到该标签')
          // AI 切换：保留 agent 标记（仍可被空闲/溢出回收），仅刷新最近 AI 使用时间；用户点击接管走 byUser=true 路径
          this.switchTab(id, false)
          const t = this.tabs.find(x => x.id === id)
          return `已切换到：${t?.title || '(无标题)'} — ${t?.url || ''}`
        }
        case 'browser_close_tab': {
          const id = this.resolveTabRef(args)
          if (!id) throw new Error('找不到该标签')
          this.closeTab(id)
          return '已关闭该标签页'
        }
        case 'browser_get_html': {
          const wc = this.ensureWc()
          const maxChars = resolveMaxChars(args?.maxChars)
          const res: any = await wc.executeJavaScript(
            `(() => { const h = document.documentElement ? document.documentElement.outerHTML : ''; return { len: h.length, html: h.slice(0, ${maxChars}) } })()`
          )
          const html = String(res?.html || '')
          return `页面 HTML 共 ${res?.len ?? 0} 字符，返回前 ${html.length} 字符：\n\n${html}`
        }
        case 'browser_wait': {
          const ms = Math.max(0, Math.min(30000, Number(args?.ms) || 1000))
          await new Promise(r => setTimeout(r, ms))
          return `已等待 ${ms}ms`
        }
        case 'browser_click': {
          const sel = String(args?.selector || '')
          if (!sel) throw new Error('缺少 selector 参数（CSS 选择器）')
          const idx = Math.max(0, Number(args?.index) || 0)
          const wc = this.ensureWc()
          const res: any = await wc.executeJavaScript(
            `(() => { const els = document.querySelectorAll(${JSON.stringify(sel)}); const el = els[${idx}] || els[0]; if (!el) return { ok: false, error: '未找到元素: ' + ${JSON.stringify(sel)} }; el.scrollIntoView({ block: 'center' }); el.click(); return { ok: true, tag: el.tagName, text: (el.innerText || '').slice(0, 200) } })()`
          )
          if (!res?.ok) throw new Error(res?.error || '点击失败')
          return `已点击 <${res.tag}>${res.text ? '：' + res.text : ''}`
        }
        case 'browser_type': {
          const sel = String(args?.selector || '')
          const text = String(args?.text ?? '')
          if (!sel) throw new Error('缺少 selector 参数（CSS 选择器）')
          const wc = this.ensureWc()
          const res: any = await wc.executeJavaScript(
            `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return { ok: false, error: '未找到元素: ' + ${JSON.stringify(sel)} }; el.focus(); const setV = (v) => { const proto = (el.tagName === 'TEXTAREA') ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(proto, 'value'); if (setter && setter.set) setter.set.call(el, v); else el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }; if (el.isContentEditable) { document.execCommand('selectAll'); document.execCommand('insertText', false, ${JSON.stringify(text)}); } else { setV(${JSON.stringify(text)}); } return { ok: true, tag: el.tagName, value: (el.value || '').slice(0, 200) }; })()`
          )
          if (!res?.ok) throw new Error(res?.error || '输入失败')
          return `已向 <${res.tag}> 输入${res.value !== undefined ? '，当前值：' + res.value : ''}`
        }
        case 'browser_scroll': {
          const wc = this.ensureWc()
          const dir = String(args?.direction || 'down')
          const px = Number(args?.px) || 600
          const res: any = await wc.executeJavaScript(
            `(() => { const d = ${JSON.stringify(dir)}; const p = ${px}; let y = window.scrollY; if (d === 'top') { window.scrollTo({ top: 0 }); y = 0; } else if (d === 'bottom') { window.scrollTo({ top: document.body.scrollHeight }); y = window.scrollY; } else { const dy = (d === 'up' ? -p : p); window.scrollBy({ top: dy }); y = window.scrollY; } return { y }; })()`
          )
          return `已滚动（${dir}），当前 scrollY = ${res?.y ?? 0}`
        }
        default:
          throw new Error(`未知工具: ${toolName}`)
      }
    } finally {
      this.agentActive = false
      this.agentBusyTabId = null
      this.agentTool = ''
      this.agentOwner = null
      this.pushState()
      // 溢出回收（每次工具调用结束即把 AI 标签压回上限内，防大批量脚手架运行期无限堆积）
      this.recycleOverflowAgentTabs()
      // 空闲兜底（保留原全局 90s 静默回收，覆盖无主/遗留标签；带属主的会话已由 agent-loop 在
      // idle/dispose 时精确回收自己的标签，此处兜底不影响其及时性）
      this.scheduleAgentRecycle()
    }
  }

  /** 浏览器工具目录（进程内 MCP server 与 toolRegistry 共用同一份，避免 schema 漂移） */
  toolDefinitions(): Array<{ name: string; description: string; inputSchema: any }> {
    const base = {
      navigate: {
        type: 'object',
        properties: { url: { type: 'string', description: '要打开的网址（可省略协议，自动补 https://）' } },
        required: ['url'],
      },
      extract: { type: 'object', properties: {}, additionalProperties: false },
      screenshot: { type: 'object', properties: {}, additionalProperties: false },
    } as const
    return [
      {
        name: 'browser_navigate',
        description: '在「浏览器 Agent」窗口的当前标签页打开指定 URL（真实 Chromium 页面，可处理登录态 / JS 渲染 / 交互）。',
        inputSchema: base.navigate,
      },
      {
        name: 'browser_extract_text',
        description: '提取当前标签页正文（可读文本，默认最多 30000 字符，可用 maxChars 参数调整），用于分析网页内容。',
        inputSchema: {
          type: 'object',
          properties: {
            maxChars: { type: 'number', description: '返回字符上限（可选；不传默认 30000）' },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'browser_extract_markdown',
        description: '提取当前标签页正文并转换为干净的 Markdown（默认最多 30000 字符，可用 maxChars 参数调整）：剔除导航/页眉页脚/广告/表单等噪音，保留标题层级、段落、列表与链接（链接为 [文字](完整URL) 格式，便于溯源）。比纯文本更利于智能体理解结构与引用出处。',
        inputSchema: {
          type: 'object',
          properties: {
            maxChars: { type: 'number', description: '返回字符上限（可选；不传默认 30000）' },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'browser_screenshot',
        description: '对当前标签页截图，返回 PNG base64 dataUrl（模型可直接查看图片理解页面）。',
        inputSchema: base.screenshot,
      },
      {
        name: 'browser_eval',
        description: '在页面上下文执行任意 JavaScript（需在浏览器 Agent 窗口开启“允许 eval”后才可用）。',
        inputSchema: {
          type: 'object',
          properties: { code: { type: 'string', description: '要执行的 JS 代码' } },
          required: ['code'],
        },
      },
      {
        name: 'browser_list_tabs',
        description: '列出浏览器 Agent 窗口中所有标签页（序号 / 标题 / 网址 / 是否激活 / 是否 AI 标签）。',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'browser_new_tab',
        description: '在浏览器 Agent 窗口中新建一个 AI 会话标签页（带 URL 则直接导航）；该标签为 AI 产生，会话空闲后自动回收。',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string', description: '要打开的网址（可省略协议）' } },
        },
      },
      {
        name: 'browser_switch_tab',
        description: '切换到指定标签页（参数支持 id / index / title 关键词）。',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '标签 id 或完整 url' },
            index: { type: 'number', description: '标签序号（从 0 开始）' },
            title: { type: 'string', description: '标题关键词' },
          },
        },
      },
      {
        name: 'browser_close_tab',
        description: '关闭指定标签页（参数支持 id / index / title 关键词）。',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '标签 id 或完整 url' },
            index: { type: 'number', description: '标签序号（从 0 开始）' },
            title: { type: 'string', description: '标题关键词' },
          },
        },
      },
      {
        name: 'browser_get_html',
        description: '获取当前标签页的 HTML（外层 HTML，按 maxChars 截断，默认 30000 字符），用于分析页面结构与表单。',
        inputSchema: {
          type: 'object',
          properties: { maxChars: { type: 'number', description: '返回字符上限（可选；不传默认 30000）' } },
        },
      },
      {
        name: 'browser_click',
        description: '按 CSS 选择器点击当前页面元素（支持 index 选择第 N 个匹配，默认第 0 个），可触发按钮/链接/交互。',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS 选择器，如 #login-btn / form button[type=submit]' },
            index: { type: 'number', description: '匹配元素下标（从 0 开始）' },
          },
          required: ['selector'],
        },
      },
      {
        name: 'browser_type',
        description: '向指定 input/textarea/contenteditable 元素输入文本（支持 CSS 选择器）。',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS 选择器，如 #q / input[name=username]' },
            text: { type: 'string', description: '要输入的文本' },
          },
          required: ['selector', 'text'],
        },
      },
      {
        name: 'browser_scroll',
        description: '滚动当前页面（direction: top/bottom/up/down；px 为每次滚动像素，默认 600）。',
        inputSchema: {
          type: 'object',
          properties: {
            direction: { type: 'string', description: 'top / bottom / up / down' },
            px: { type: 'number', description: '滚动像素' },
          },
        },
      },
    ]
  }

  /** 供 mcp-service：内置连接每次创建一对 InMemory transport 并挂到共享 Server */
  async createLocalServerPair(): Promise<{ server: any; clientTransport: any }> {
    const sdk = await getServerSdk()
    const server = await this.ensureMcpServer()
    const [clientTransport, serverTransport] = sdk.InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    return { server, clientTransport }
  }

  /** 供对外 HTTP 暴露层：把外部 transport 挂到同一共享 Server */
  async connectTransport(transport: any): Promise<void> {
    const server = await this.ensureMcpServer()
    await server.connect(transport)
  }

  /** 惰性构建共享 MCP Server（浏览器状态机为单例，Server 也共享） */
  private async ensureMcpServer(): Promise<any> {
    if (this.mcpServer) return this.mcpServer
    const sdk = await getServerSdk()
    const server = new sdk.Server(
      { name: 'AI-KM Browser Agent', version: '1.0.0' },
      { capabilities: { tools: {} } }
    )
    const tools = this.toolDefinitions()
    server.setRequestHandler(sdk.ListToolsRequestSchema, async () => ({ tools }))
    server.setRequestHandler(sdk.CallToolRequestSchema, async (req: any) => {
      const name = String(req?.params?.name || '')
      const args = (req?.params?.arguments && typeof req.params.arguments === 'object') ? req.params.arguments : {}
      try {
        const text = await this.executeTool(name, args)
        return { content: [{ type: 'text', text }] }
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `错误: ${err?.message || String(err)}` }] }
      }
    })
    this.mcpServer = server
    return server
  }

  // ===================== 保存页面 / 开发者工具 =====================
  /** 把激活标签保存为 html：link=仅当前页面 HTML（HTMLOnly）；full=整体含资源离线保存（HTMLComplete）。
   *  baseDir 传入则自动保存到该目录（工作区根）；否则弹保存对话框让用户选择。 */
  async saveActivePage(mode: 'link' | 'full', baseDir?: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    const wc = this.ensureWc()
    const fileBase = this.defaultSaveName()
    let savePath = ''
    if (baseDir && typeof baseDir === 'string') {
      try { fs.mkdirSync(baseDir, { recursive: true }) } catch { /* ignore */ }
      savePath = join(baseDir, `${fileBase}.html`)
      let n = 1
      while (fs.existsSync(savePath) && n < 1000) savePath = join(baseDir, `${fileBase}-${n++}.html`)
    } else {
      if (!this.win || this.win.isDestroyed()) return { ok: false, error: '窗口不可用' }
      const res = await dialog.showSaveDialog(this.win, {
        title: mode === 'full' ? 'Save full HTML' : 'Save HTML',
        defaultPath: `${fileBase}.html`,
        filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
      })
      if (res.canceled || !res.filePath) return { ok: false, error: 'Canceled' }
      savePath = res.filePath
    }
    try {
      await wc.savePage(savePath, mode === 'full' ? 'HTMLComplete' : 'HTMLOnly')
      // 保存到收藏根目录（浏览器保存文件夹）时：给离线快照打上收藏标记 + 本地 file:// 地址，
      // 使其像书签一样显示在收藏夹/新标签页，点击可在本浏览器里打开这份离线文件。
      if (baseDir && typeof baseDir === 'string') {
        try {
          const st = fs.statSync(savePath)
          if (st.size > 0 && st.size < 32 * 1024 * 1024) {
            let htmlText = fs.readFileSync(savePath, 'utf8')
            if (htmlText && !htmlText.includes('name="aikm-bookmark"')) {
              const snapshotUrl = pathToFileURL(savePath).href
              const marker = '\n    <meta name="aikm-bookmark" content="1">\n    <meta name="aikm-snapshot" content="1">\n    <meta name="aikm-href" content="' + this.attrSafe(snapshotUrl) + '">'
              htmlText = htmlText.replace(/<head[^>]*>/i, (mm) => mm + marker)
              if (htmlText.length) fs.writeFileSync(savePath, htmlText, 'utf8')
            }
          }
        } catch { /* 登记失败不影响已保存文件本身 */ }
      }
      return { ok: true, path: savePath }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  }

  /** 打开激活标签的开发者工具（独立窗口模式） */
  openDevTools() {
    const wc = this.activeView()?.webContents
    if (wc && !wc.isDestroyed()) {
      if (wc.isDevToolsOpened()) wc.closeDevTools()
      wc.openDevTools({ mode: 'detach' })
    }
  }

  /** 抓取网页 favicon 为 dataURL（默认激活标签；可传指定 wc）。供标签显示/收藏内嵌，无则返回 '' */
  private captureFaviconDataUrl(wc?: WebContents): string {
    try {
      const w = wc || this.activeView()?.webContents
      if (!w || w.isDestroyed()) return ''
      const anyWc = w as any
      const fav: any = typeof anyWc.getFavicon === 'function' ? anyWc.getFavicon() : null
      if (fav && typeof fav.isEmpty === 'function' && !fav.isEmpty() && typeof fav.toDataURL === 'function') {
        const d = fav.toDataURL()
        return d ? String(d) : ''
      }
    } catch { /* 忽略 */ }
    return ''
  }

  // ===================== favicon 拉取缓存（新标签页收藏夹等场景，避免每次联网加载） =====================
  private faviconCacheDir(): string {
    return join(app.getPath('userData'), 'browser-favicons')
  }
  private faviconSafeName(host: string): string {
    return host.replace(/[^a-z0-9.-]+/gi, '_').replace(/^\.+|\.+$/g, '') || 'host'
  }
  /** 批量取 favicon dataURL（缓存优先：内存 → 磁盘 → 联网下载后写盘） */
  async faviconBatch(hosts: string[]): Promise<{ ok: boolean; map: Record<string, string> }> {
    const out: Record<string, string> = {}
    for (const h of hosts || []) {
      if (!h || typeof h !== 'string') continue
      const key = h.toLowerCase()
      const d = await this.fetchFaviconData(key)
      if (d) out[key] = d
    }
    return { ok: true, map: out }
  }
  /** 单个 host 的 favicon dataURL（带 内存→磁盘→网络 三级缓存） */
  private async fetchFaviconData(host: string): Promise<string> {
    if (this.faviconCache.has(host)) return this.faviconCache.get(host)!
    const dir = this.faviconCacheDir()
    const safe = this.faviconSafeName(host)
    // 磁盘缓存：按扩展名尝试（png/ico/jpg/webp）
    const extMime: Array<[string, string]> = [['png', 'image/png'], ['ico', 'image/x-icon'], ['jpg', 'image/jpeg'], ['webp', 'image/webp']]
    try {
      for (const [ext, mime] of extMime) {
        const f = join(dir, `${safe}.${ext}`)
        if (fs.existsSync(f)) {
          const buf = fs.readFileSync(f)
          const d = `data:${mime};base64,${buf.toString('base64')}`
          this.faviconCache.set(host, d)
          return d
        }
      }
    } catch { /* 忽略 */ }
    // 联网拉取：DDG 图标服务 → 站点根 /favicon.ico
    const urls = [`https://icons.duckduckgo.com/ip3/${host}.ico`, `https://${host}/favicon.ico`]
    for (const u of urls) {
      try {
        const res = await net.fetch(u, { method: 'GET' })
        if (!res || !res.ok) continue
        const buf = Buffer.from(await res.arrayBuffer())
        if (!buf || !buf.length) continue
        const ct = ((res.headers.get('content-type') || 'image/x-icon').split(';')[0] || '').trim().toLowerCase()
        const mime = ct || 'image/x-icon'
        const d = `data:${mime};base64,${buf.toString('base64')}`
        this.faviconCache.set(host, d)
        // 落盘（用与 MIME 匹配的扩展名）
        try {
          fs.mkdirSync(dir, { recursive: true })
          const ext = mime.includes('jpeg') ? 'jpg' : (mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'ico')
          // Buffer 与 Node 期望的 ArrayBufferView 泛型不一致（运行时等价，纯类型误报）→ 显式断言
          fs.writeFileSync(join(dir, `${safe}.${ext}`), buf as unknown as NodeJS.ArrayBufferView)
        } catch { /* 忽略 */ }
        return d
      } catch { /* 尝试下一个源 */ }
    }
    return ''
  }

  /** 默认保存名：标题/URL 清洗 + 时间戳 */
  private defaultSaveName(): string {
    const wc = this.activeView()?.webContents
    const base = (wc && !wc.isDestroyed() ? (wc.getTitle() || wc.getURL()) : 'page') || 'page'
    const slug = base.replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'page'
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return `${slug}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  }

  // ===================== 文件化书签（复用工作区：保存为 书签/*.html 跳转页，可用文件结构管理） =====================
  private bookmarkDir(root: string): string {
    // 书签直接保存在工作区根目录（无需「书签」子文件夹）
    return root
  }
  private escHtml(s: unknown): string {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
  private attrSafe(s: unknown): string {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }
  private safeSlug(s: string): string {
    const slug = String(s || '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
    return (slug || 'bookmark').slice(0, 60)
  }
  /** 只读文件前 n 字节的 utf8 前缀（避免对含大图标 / 大整页快照的书签文件整读） */
  private headOf(p: string, n: number): string {
    try {
      const fd = fs.openSync(p, 'r')
      try {
        const buf = Buffer.alloc(n)
        const bytes = fs.readSync(fd, buf as unknown as NodeJS.ArrayBufferView, 0, n, 0)
        return bytes > 0 ? buf.toString('utf8', 0, bytes) : ''
      } finally { try { fs.closeSync(fd) } catch { /* ignore */ } }
    } catch { return '' }
  }
  /** 书签/收藏文件头部判定窗口：内嵌图标 dataURL 可能把标记挤到文件较后，须读足够大窗口（32KB，图标内嵌一般远小于此；新文件标记已前置） */
  private static HEAD_READ = 32 * 1024
  private urlOfBookmarkHead(p: string): string {
    try {
      const head = this.headOf(p, BrowserAgentService.HEAD_READ)
      // 离线整页快照：优先读保存时写入的本地 file:// 地址（其内 <a href> 均为原站链接，不能当目标）
      const h = head.match(/<meta\s+name=["']aikm-href["'][^>]*content=["']([^"']+)["']/i)
      if (h?.[1]) return decodeURIComponent(h[1])
      const m = head.match(/<meta\s+http-equiv=["']?refresh["']?[^>]*?url=(["']?)([^"'>\s]+)\1/i)
      if (m?.[2]) return decodeURIComponent(m[2])
      const a = head.match(/<a[^>]+href=["']([^"']+)["']/i)
      if (a?.[1]) return a[1]
    } catch { /* 忽略 */ }
    return ''
  }
  /** 读取书签文件 <title>（首页展示用真实标题，与文件名解耦；重命名文件不影响展示） */
  private titleOfBookmarkHead(p: string): string {
    try {
      const m = this.headOf(p, BrowserAgentService.HEAD_READ).match(/<title>([^<]*)<\/title>/i)
      if (m?.[1]) return m[1].trim()
    } catch { /* 忽略 */ }
    return ''
  }
  /** 读取书签文件内嵌的网站图标（收藏时写入的 dataURL / 外链；无则空） */
  private iconOfBookmarkHead(p: string): string {
    try {
      const head = this.headOf(p, BrowserAgentService.HEAD_READ)
      const m = head.match(/<link[^>]*rel=["']icon["'][^>]*href=["']([^"']+)["']/i)
        || head.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']icon["']/i)
      return m?.[1] || ''
    } catch { /* 忽略 */ }
    return ''
  }
  /** 是否为书签文件（头部含 aikm-bookmark 标记，避免误把普通 html 当书签） */
  private isBookmarkFile(p: string): boolean {
    try {
      return this.headOf(p, BrowserAgentService.HEAD_READ).includes('<meta name="aikm-bookmark" content="1">')
    } catch { return false }
  }

  /** 读取书签顺序标记（同目录内排序用；无标记返回 null） */
  private bookmarkOrderOf(p: string): number | null {
    try {
      const m = this.headOf(p, BrowserAgentService.HEAD_READ).match(/<meta\s+name=["']aikm-bookmark-order["']\s+content=["'](\d+)["']/i)
      if (m?.[1]) { const n = Number(m[1]); return Number.isFinite(n) ? n : null }
    } catch { /* 忽略 */ }
    return null
  }

  /** 写入/更新书签文件的顺序标记（在 aikm-bookmark 标记行后插入或原位替换） */
  private writeBookmarkOrder(p: string, order: number): boolean {
    try {
      let html = fs.readFileSync(p, 'utf8')
      const meta = `<meta name="aikm-bookmark-order" content="${order}">`
      const re = /<meta\s+name=["']aikm-bookmark-order["'][^>]*\/?>/i
      if (re.test(html)) {
        html = html.replace(re, meta)
      } else {
        const bm = html.match(/<meta\s+name=["']aikm-bookmark["'][^>]*\/?>/i)
        if (bm && bm.index !== undefined) {
          const i = bm.index + bm[0].length
          html = html.slice(0, i) + '\n      ' + meta + html.slice(i)
        } else {
          html = html.replace(/<head[^>]*>/i, (m) => m + '\n      ' + meta)
        }
      }
      fs.writeFileSync(p, html, 'utf8')
      return true
    } catch { return false }
  }

  /** 目标路径是否安全落在书签根目录内（防穿越） */
  private safeWithinDir(dir: string, p: string): boolean {
    const rel = relative(dir, p)
    return !isAbsolute(rel) && !rel.startsWith('..')
  }

  /** 把当前页收藏为工作区书签文件（书签/目录下自动建目录、命名避冲突；同 URL 幂等） */
  async saveBookmark(root: string, url: string, title: string): Promise<{ ok: boolean; path?: string; exists?: boolean; error?: string }> {
    if (!root || typeof root !== 'string' || !url) return { ok: false, error: !root ? '未设置工作区' : '缺少 URL' }
    const dir = this.bookmarkDir(root)
    try { fs.mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
    // 幂等：已存在同 URL 的书签则返回其路径
    const existing = await this.listBookmarks(root)
    const dup = existing.items?.find(b => b.kind === 'file' && b.url === url)
    if (dup) return { ok: true, path: dup.path, exists: true }
    // 顺序：新书签默认追加到根目录同类末尾（取当前最大 order + 1）
    let nextOrder = 0
    for (const it of existing.items || []) {
      if (it.kind === 'file' && typeof it.order === 'number' && it.order >= nextOrder) nextOrder = it.order + 1
    }
    let hostSlug = ''
    try { hostSlug = this.safeSlug(new URL(url).host.replace(/^www\./, '') || '') } catch { hostSlug = '' }
    const rawBase = this.safeSlug(title) || this.safeSlug(url)
    // 同名兜底优化：不同站点同名时自动附加域名（如 首页-bing.com.html）；再冲突才用序号
    let file = join(dir, `${rawBase}.html`)
    if (fs.existsSync(file)) {
      file = hostSlug ? join(dir, `${rawBase}-${hostSlug}.html`) : join(dir, `${rawBase}-2.html`)
    }
    let n = 2
    while (fs.existsSync(file) && n < 1000) {
      file = hostSlug
        ? join(dir, `${rawBase}-${hostSlug}-${n}.html`)
        : join(dir, `${rawBase}-${n}.html`)
      n++
    }
    // 收藏时抓取当前标签页的网站图标，内嵌进书签文件（离线/无网络也能显示）。
    // 链路：① 当前标签实时 favicon → ② 按 host 的内存/磁盘/联网缓存（DDG 图标服务 / 站点 favicon.ico）。
    // 仅靠 getFavicon() 常因图标尚未触发加载而拿空，导致收藏无图标；加兜底保证绝大多数站点有图。
    let favData = this.captureFaviconDataUrl()
    if (!favData) {
      let host = ''
      try { host = new URL(url).host.replace(/^www\./, '') || '' } catch { host = '' }
      if (host) {
        try { favData = await this.fetchFaviconData(host) } catch { favData = '' }
      }
    }
    const html = [
      '<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">',
      // 标记前置：避免大图标 dataURL 把标记挤到文件较后被判定漏过
      '<meta name="aikm-bookmark" content="1">',
      `<meta name="aikm-bookmark-order" content="${nextOrder}">`,
      `<meta http-equiv="refresh" content="0; url=${this.attrSafe(url)}">`,
      (favData ? `<link rel="icon" type="image/png" href="${this.attrSafe(favData)}">` : ''),
      `<title>${this.attrSafe(title)}</title>`,
      '<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;font:14px/1.7 system-ui,sans-serif;background:#f7f8fa}main{text-align:center;max-width:80%}a{color:#1971c2;word-break:break-all}</style>',
      '</head><body><main><p>正在打开…</p><a href="' + this.attrSafe(url) + '">' + this.escHtml(title) + '</a></main></body></html>',
    ].join('\n')
    try {
      fs.writeFileSync(file, html, 'utf8')
      return { ok: true, path: file }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  }

  /** 编辑书签：更新标题与目标网址（保留图标/顺序/标记；离线整页快照不允许改地址） */
  async updateBookmark(root: string, filePath: string, title: string, url: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    if (!root || typeof root !== 'string' || !filePath || typeof filePath !== 'string') return { ok: false, error: '参数不完整' }
    const cleanUrl = String(url ?? '').trim()
    if (!cleanUrl || !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(cleanUrl) || /\s/.test(cleanUrl)) return { ok: false, error: '目标网址无效' }
    const dir = this.bookmarkDir(root)
    if (!this.safeWithinDir(dir, filePath)) return { ok: false, error: '越界路径，已拒绝' }
    if (!this.isBookmarkFile(filePath)) return { ok: false, error: '非书签文件，已拒绝编辑' }
    if (this.headOf(filePath, BrowserAgentService.HEAD_READ).includes('aikm-snapshot')) return { ok: false, error: '离线整页快照不支持编辑网址，请删除后重新保存' }
    const t = String(title ?? '').trim() || cleanUrl
    let html = ''
    try { html = fs.readFileSync(filePath, 'utf8') } catch (err: any) { return { ok: false, error: '读取失败：' + (err?.message || String(err)) } }
    const href = this.attrSafe(cleanUrl)
    // 标题
    html = html.replace(/<title>([\s\S]*?)<\/title>/i, () => `<title>${this.attrSafe(t)}</title>`)
    // 跳转 meta（refresh 目标地址）
    html = html.replace(/<meta\s+http-equiv=["']?refresh["']?[^>]*\/?>/i, () => `<meta http-equiv="refresh" content="0; url=${href}">`)
    // 正文“正在打开…”链接
    html = html.replace(/<a\s+[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/i, () => `<a href="${href}">${this.escHtml(t)}</a>`)
    // 文件名跟随新标题（同目录内唯一；基名无变化则保留原名不重命名）
    const destDir = dirname(filePath)
    const oldBase = basename(filePath)
    let base = this.safeSlug(t) || this.safeSlug(cleanUrl) || 'bookmark'
    let newName = `${base}.html`
    let suffix = 2
    while (fs.existsSync(join(destDir, newName)) && newName.toLowerCase() !== oldBase.toLowerCase() && suffix < 1000) newName = `${base}-${suffix++}.html`
    let target = filePath
    if (newName !== oldBase) {
      target = join(destDir, newName)
      try { fs.renameSync(filePath, target) } catch (err: any) { return { ok: false, error: '重命名失败：' + (err?.message || String(err)) } }
    }
    try { fs.writeFileSync(target, html, 'utf8') } catch (err: any) { return { ok: false, error: err?.message || String(err) } }
    return { ok: true, path: target }
  }

  /** 列出工作区中的书签（目录树信息：kind=dir/file、顺序标记 order），供收藏夹树状管理 */
  async listBookmarks(root: string): Promise<{ ok: boolean; items?: Array<{ kind: 'dir' | 'file'; rel: string; name: string; title: string; path: string; url: string; icon: string; order: number | null }>; error?: string }> {
    if (!root || typeof root !== 'string') return { ok: false, error: '未设置工作区' }
    const dir = this.bookmarkDir(root)
    const items: Array<{ kind: 'dir' | 'file'; rel: string; name: string; title: string; path: string; url: string; icon: string; order: number | null }> = []
    const walk = (d: string, prefix: string) => {
      let ents: fs.Dirent[] = []
      try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
      // 子目录：按名排序、先建目录节点再递归（空文件夹也展示）
      const dirs = ents.filter(e => e.isDirectory()).map(e => e.name).sort((a, b) => a.localeCompare(b))
      for (const dn of dirs) {
        const sub = join(d, dn)
        const rel = prefix ? `${prefix}/${dn}` : dn
        items.push({ kind: 'dir', rel, name: dn, title: dn, path: sub, url: '', icon: '', order: null })
        walk(sub, rel)
      }
      // 书签文件：按顺序标记升序（无标记排后按名）
      const files = ents
        .filter(e => e.isFile() && /\.html?$/i.test(e.name))
        .map(e => { const p = join(d, e.name); return { e, p, order: this.bookmarkOrderOf(p) } })
        .sort((a, b) =>
          (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
          a.e.name.localeCompare(b.e.name)
        )
      for (const { p, e } of files) {
        if (!this.isBookmarkFile(p)) continue
        const rel = prefix ? `${prefix}/${e.name}` : e.name
        items.push({
          kind: 'file', rel, name: e.name.replace(/\.html?$/i, ''),
          title: this.titleOfBookmarkHead(p), path: p, url: this.urlOfBookmarkHead(p),
          icon: this.iconOfBookmarkHead(p), order: this.bookmarkOrderOf(p),
        })
      }
    }
    walk(dir, '')
    return { ok: true, items }
  }

  /** 移除工作区书签文件（仅允许删除 书签/ 目录内，防穿越） */
  async removeBookmark(root: string, filePath: string): Promise<{ ok: boolean; error?: string }> {
    if (!root || typeof root !== 'string' || !filePath || typeof filePath !== 'string') return { ok: false, error: '参数不完整' }
    const dir = this.bookmarkDir(root)
    const rel = relative(dir, filePath)
    if (isAbsolute(rel) || rel.startsWith('..')) return { ok: false, error: '越界路径，已拒绝' }
    if (!this.isBookmarkFile(filePath)) return { ok: false, error: '非书签文件，已拒绝删除' }
    try { fs.unlinkSync(filePath) } catch (err: any) { return { ok: false, error: err?.message || String(err) } }
    return { ok: true }
  }

  /** 移动书签文件到其它目录（跨目录整理；目标目录不存在则创建；移动后置于目标末尾） */
  async moveBookmark(root: string, srcPath: string, dstDirRel: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    if (!root || typeof root !== 'string' || !srcPath || typeof srcPath !== 'string') return { ok: false, error: '参数不完整' }
    const dir = this.bookmarkDir(root)
    if (!this.safeWithinDir(dir, srcPath)) return { ok: false, error: '越界路径，已拒绝' }
    if (!this.isBookmarkFile(srcPath)) return { ok: false, error: '非书签文件，已拒绝移动' }
    const dstRel = String(dstDirRel || '').trim().replace(/^\/+|\/+$/g, '')
    const dstDir = dstRel ? join(dir, ...dstRel.split(/[\\/]+/)) : dir
    if (!this.safeWithinDir(dir, dstDir)) return { ok: false, error: '目标目录越界，已拒绝' }
    // 移到自身所在目录 = 无操作
    if (dirname(srcPath) === dstDir) return { ok: true, path: srcPath }
    try { fs.mkdirSync(dstDir, { recursive: true }) } catch { /* ignore */ }
    const base = basename(srcPath)
    let dest = join(dstDir, base)
    if (fs.existsSync(dest)) {
      const dot = base.lastIndexOf('.')
      const stem = dot > 0 ? base.slice(0, dot) : base
      const ext = dot > 0 ? base.slice(dot) : ''
      let n = 2
      while (fs.existsSync(dest) && n < 1000) dest = join(dstDir, `${stem}-${n++}${ext}`)
    }
    try {
      fs.renameSync(srcPath, dest)
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
    // 目标目录末尾顺序
    let maxOrder = -1
    for (const it of (await this.listBookmarks(dstDir)).items || []) {
      if (it.kind === 'file' && typeof it.order === 'number' && it.order > maxOrder) maxOrder = it.order
    }
    this.writeBookmarkOrder(dest, maxOrder + 1)
    return { ok: true, path: dest }
  }

  /** 重排同一目录内书签的显示顺序（orderedPaths=该目录内书签绝对路径的有序数组，按序写顺序标记） */
  async reorderBookmarks(root: string, orderedPaths: string[]): Promise<{ ok: boolean; error?: string }> {
    if (!root || typeof root !== 'string' || !Array.isArray(orderedPaths)) return { ok: false, error: '参数不完整' }
    const dir = this.bookmarkDir(root)
    let okAll = true
    for (let i = 0; i < orderedPaths.length; i++) {
      const p = orderedPaths[i]
      if (typeof p !== 'string' || !this.safeWithinDir(dir, p) || !this.isBookmarkFile(p)) { okAll = false; continue }
      if (!this.writeBookmarkOrder(p, i)) okAll = false
    }
    return okAll ? { ok: true } : { ok: false, error: '部分书签顺序写入失败' }
  }

  /** 在书签根目录下新建文件夹（仅单层，用于给书签分组） */
  async createBookmarkFolder(root: string, name: string): Promise<{ ok: boolean; path?: string; rel?: string; error?: string }> {
    if (!root || typeof root !== 'string' || !name) return { ok: false, error: '参数不完整' }
    const clean = String(name).trim().replace(/[\\/:*?"<>|]+/g, '-')
    if (!clean) return { ok: false, error: '文件夹名无效' }
    const dir = this.bookmarkDir(root)
    const p = join(dir, clean)
    try {
      fs.mkdirSync(p, { recursive: true })
      return { ok: true, path: p, rel: clean }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  }

  /** 重命名收藏夹文件夹（目录改名，内部书签/子目录随目录移动）。安全：仅允许“全部由书签组成”的目录，防误改真实项目目录 */
  async renameBookmarkFolder(root: string, folderPath: string, name: string): Promise<{ ok: boolean; path?: string; rel?: string; error?: string }> {
    if (!root || typeof root !== 'string' || !folderPath || typeof folderPath !== 'string' || !name) return { ok: false, error: '参数不完整' }
    const clean = String(name).trim().replace(/[\\/:*?"<>|]+/g, '-')
    if (!clean) return { ok: false, error: '文件夹名无效' }
    const dir = this.bookmarkDir(root)
    if (!this.safeWithinDir(dir, folderPath)) return { ok: false, error: '越界路径，已拒绝' }
    const rel = relative(dir, folderPath)
    if (!rel || rel === '.') return { ok: false, error: '不能重命名收藏根目录' }
    try {
      if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) return { ok: false, error: '目录不存在' }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
    if (this.bookmarksOnlyInfo(folderPath) < 0) return { ok: false, error: '该目录内含非书签文件，可能不是收藏夹目录，已取消重命名' }
    const parent = dirname(folderPath)
    const oldBase = basename(folderPath)
    if (clean === oldBase) return { ok: true, path: folderPath, rel }
    let target = join(parent, clean)
    let n = 2
    while (fs.existsSync(target) && n < 1000) target = join(parent, `${clean}-${n++}`)
    try {
      fs.renameSync(folderPath, target)
    } catch (err: any) {
      return { ok: false, error: '重命名失败：' + (err?.message || String(err)) }
    }
    return { ok: true, path: target, rel: relative(dir, target).split('\\').join('/') }
  }

  // ===================== 书签删除/清空（文件夹整体删除 / 文件夹内清空 / 全库清空；防误删工作区真实文件） =====================
  /** 目录是否“全部由书签组成”（可整目录删除）：递归检查，含任一非书签文件即返回 -1；否则返回其内书签数 */
  private bookmarksOnlyInfo(p: string): number {
    let count = 0
    let ents: fs.Dirent[] = []
    try { ents = fs.readdirSync(p, { withFileTypes: true }) } catch { return -1 }
    for (const e of ents) {
      const full = join(p, e.name)
      if (e.isDirectory()) {
        const c = this.bookmarksOnlyInfo(full)
        if (c < 0) return -1
        count += c
      } else if (e.isFile()) {
        if (!/\.html?$/i.test(e.name) || !this.isBookmarkFile(full)) return -1
        count++
      } else {
        return -1
      }
    }
    return count
  }

  /** 删除收藏夹里的一个文件夹（递归，含内部书签与子目录）。安全：仅允许删除“全部由书签组成”的目录，防误删真实项目目录 */
  async removeBookmarkFolder(root: string, folderPath: string): Promise<{ ok: boolean; removed?: number; error?: string }> {
    if (!root || typeof root !== 'string' || !folderPath || typeof folderPath !== 'string') return { ok: false, error: '参数不完整' }
    const dir = this.bookmarkDir(root)
    if (!this.safeWithinDir(dir, folderPath)) return { ok: false, error: '越界路径，已拒绝' }
    const rel = relative(dir, folderPath)
    if (!rel || rel === '.') return { ok: false, error: '不能删除收藏根目录' }
    if (!fs.existsSync(folderPath)) return { ok: false, error: '目录不存在' }
    const cnt = this.bookmarksOnlyInfo(folderPath)
    if (cnt < 0) return { ok: false, error: '该目录内含非书签文件，可能不是收藏夹目录，已取消删除（避免误删工作区文件）' }
    try { fs.rmSync(folderPath, { recursive: true, force: true }) } catch (err: any) { return { ok: false, error: err?.message || String(err) } }
    return { ok: true, removed: cnt }
  }

  /** 清空某个收藏夹文件夹内的全部书签（保留文件夹本身；其下“全部由书签组成”的子目录一并删除） */
  async clearBookmarkFolderContents(root: string, folderPath: string): Promise<{ ok: boolean; removed?: number; error?: string }> {
    if (!root || typeof root !== 'string' || !folderPath || typeof folderPath !== 'string') return { ok: false, error: '参数不完整' }
    const dir = this.bookmarkDir(root)
    if (!this.safeWithinDir(dir, folderPath)) return { ok: false, error: '越界路径，已拒绝' }
    const rel = relative(dir, folderPath)
    if (!rel || rel === '.') return this.clearBookmarks(root) // 目标是收藏根 → 等同清空全部
    if (!fs.existsSync(folderPath)) return { ok: false, error: '目录不存在' }
    let removed = 0
    const walk = (d: string, removeSubDirs: boolean) => {
      let ents: fs.Dirent[] = []
      try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
      const subs: string[] = []
      for (const e of ents) {
        const full = join(d, e.name)
        if (e.isDirectory()) subs.push(full)
        else if (e.isFile() && /\.html?$/i.test(e.name) && this.isBookmarkFile(full)) {
          try { fs.unlinkSync(full); removed++ } catch { /* 单个失败忽略 */ }
        }
      }
      for (const sub of subs) {
        const c = this.bookmarksOnlyInfo(sub)
        if (removeSubDirs && c >= 0) { try { fs.rmSync(sub, { recursive: true, force: true }); removed += c } catch { /* ignore */ } }
        else walk(sub, true)
      }
    }
    walk(folderPath, true)
    return { ok: true, removed }
  }

  /** 清空整个收藏：删除收藏根下全部书签文件；“全部由书签组成”的文件夹（导入/分组）一并删除；含真实文件的目录仅清理其内书签并保留 */
  async clearBookmarks(root: string): Promise<{ ok: boolean; removed?: number; error?: string }> {
    if (!root || typeof root !== 'string') return { ok: false, error: '未设置工作区' }
    const dir = this.bookmarkDir(root)
    let removed = 0
    const walk = (d: string, removeSubDirs: boolean) => {
      let ents: fs.Dirent[] = []
      try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
      const subs: string[] = []
      for (const e of ents) {
        const full = join(d, e.name)
        if (e.isDirectory()) subs.push(full)
        else if (e.isFile() && /\.html?$/i.test(e.name) && this.isBookmarkFile(full)) {
          try { fs.unlinkSync(full); removed++ } catch { /* ignore */ }
        }
      }
      for (const sub of subs) {
        const c = this.bookmarksOnlyInfo(sub)
        if (removeSubDirs && c >= 0) { try { fs.rmSync(sub, { recursive: true, force: true }); removed += c } catch { /* ignore */ } }
        else walk(sub, true)
      }
    }
    walk(dir, true)
    return { ok: true, removed }
  }

  // ===================== 书签导入/导出（兼容浏览器导出的 Netscape 书签 HTML，如 favorites_*.html） =====================
  /** 解码 Netscape 书签 HTML 里的文本（去标签 / 解码实体 / 折叠空白） */
  private cleanBmText(s: string): string {
    return String(s ?? '')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&apos;/gi, "'")
      .replace(/\s+/g, ' ')
      .trim()
  }
  /** 定位标签真正的结束符 >（跳过属性引号内的 >） */
  private findTagEnd(src: string, lt: number): number {
    const len = src.length
    let i = lt + 1
    let q = ''
    while (i < len) {
      const c = src[i]
      if (q) { if (c === q) q = ''; i++; continue }
      if (c === '"' || c === "'") { q = c; i++; continue }
      if (c === '>') return i
      i++
    }
    return -1
  }
  /** 解析标签字符串里的属性（形如 A HREF="..." ADD_DATE="..." ICON="..."），键统一小写 */
  private parseTagAttrs(tag: string): Record<string, string> {
    const attrs: Record<string, string> = {}
    const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g
    let m: RegExpExecArray | null
    while ((m = re.exec(tag))) attrs[(m[1] || '').toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? ''
    return attrs
  }
  /** 解析 Netscape 书签 HTML → 树节点（返回根 <H1> 标题 + 顶层 <DL> 条目） */
  private parseNetscapeBookmarks(html: string): { rootTitle: string; nodes: NetBmNode[] } {
    let s = String(html || '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
    let rootTitle = 'Bookmarks'
    const h1 = s.match(/<H1[^>]*>([\s\S]*?)<\/H1>/i)
    if (h1?.[1]) rootTitle = this.cleanBmText(h1[1]) || rootTitle
    const nodes: NetBmNode[] = []
    const start = s.search(/<DL[\s>]/i)
    if (start >= 0) {
      const src = s.slice(start)
      const pos = { i: 0 }
      this.parseDlList(src, pos, nodes)
    }
    return { rootTitle, nodes }
  }
  /** 解析一个 <DL> 内的条目序列（pos 位于该 <DL> 标签之后；读到 </DL> 即返回） */
  private parseDlList(src: string, pos: { i: number }, out: NetBmNode[]): void {
    const len = src.length
    while (pos.i < len) {
      const lt = src.indexOf('<', pos.i)
      if (lt < 0) return
      const gt = this.findTagEnd(src, lt)
      if (gt < 0) return
      let tag = src.slice(lt + 1, gt).trim()
      const closing = tag.charAt(0) === '/'
      if (closing) tag = tag.slice(1).trim()
      const tagName = (tag.split(/\s/, 1)[0] || '').toLowerCase()
      pos.i = gt + 1
      if (closing) { if (tagName === 'dl') return; continue }
      if (tagName === 'dt' || tagName === 'p' || tagName === 'br' || tagName === 'hr') continue
      if (tagName === 'dl') { this.parseDlList(src, pos, out); continue }
      if (tagName === 'a') {
        const attrs = this.parseTagAttrs(tag)
        const cm = /<\/a>/i.exec(src.slice(pos.i))
        const end = cm ? pos.i + cm.index : len
        const title = this.cleanBmText(src.slice(pos.i, end))
        pos.i = cm ? end + cm[0].length : end
        out.push({ kind: 'file', title, url: attrs.href || '', icon: /^(data:|https?:)/i.test(attrs.icon || '') ? attrs.icon : '' })
        continue
      }
      if (tagName === 'h3') {
        const attrs = this.parseTagAttrs(tag)
        const cm = /<\/h3>/i.exec(src.slice(pos.i))
        const end = cm ? pos.i + cm.index : len
        const title = this.cleanBmText(src.slice(pos.i, end))
        pos.i = cm ? end + cm[0].length : end
        const node: NetBmNode = { kind: 'dir', title, children: [] }
        out.push(node)
        // 文件夹标题后一般紧跟嵌套 <DL>（中间可能夹空白 / <p>），读到则递归解析其子项
        const nl = src.indexOf('<', pos.i)
        if (nl >= 0) {
          const ng = this.findTagEnd(src, nl)
          if (ng >= 0 && (src.slice(nl + 1, ng).trim().split(/\s/, 1)[0] || '').toLowerCase() === 'dl') {
            pos.i = ng + 1
            this.parseDlList(src, pos, node.children as NetBmNode[])
          }
        }
        continue
      }
      // 其它标签：跳过
    }
  }
  /** 目录/文件夹名清洗（去非法字符与路径穿越风险） */
  private safeFolderName(name: string): string {
    const s = String(name ?? '')
      .replace(/[\\\/:*?"<>|\r\n\t]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-. ]+|[-. ]+$/g, '')
      .trim()
    return (s || 'bookmarks').slice(0, 60)
  }
  /** 生成一个书签跳转页 html（与「收藏当前页」保存的文件同构：aikm-bookmark 标记 / 顺序 / 图标） */
  private bookmarkFileHtml(title: string, url: string, icon: string, order: number): string {
    const href = this.attrSafe(url)
    return [
      '<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">',
      // 标记前置：避免大图标 dataURL 把标记挤到文件较后被判定漏过
      '<meta name="aikm-bookmark" content="1">',
      `<meta name="aikm-bookmark-order" content="${order}">`,
      `<meta http-equiv="refresh" content="0; url=${href}">`,
      (icon ? `<link rel="icon" type="image/png" href="${this.attrSafe(icon)}">` : ''),
      `<title>${this.attrSafe(title)}</title>`,
      '<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;font:14px/1.7 system-ui,sans-serif;background:#f7f8fa}main{text-align:center;max-width:80%}a{color:#1971c2;word-break:break-all}</style>',
      '</head><body><main><p>正在打开…</p><a href="' + href + '">' + this.escHtml(title) + '</a></main></body></html>',
    ].join('\n')
  }
  /** 递归写入导入的树节点（目录→文件夹；书签→跳转页文件；顺序标记按 HTML 内顺序） */
  private async writeImportedNodes(parentDir: string, nodes: NetBmNode[], stat: { files: number; dirs: number }): Promise<void> {
    let order = 0
    for (const nd of nodes || []) {
      if (nd.kind === 'dir') {
        const base = this.safeFolderName(nd.title)
        let sub = join(parentDir, base)
        let n = 2
        while (fs.existsSync(sub) && n < 1000) sub = join(parentDir, `${base}-${n++}`)
        try { fs.mkdirSync(sub, { recursive: true }); stat.dirs++ } catch { /* 单个目录失败忽略 */ }
        await this.writeImportedNodes(sub, nd.children || [], stat)
        continue
      }
      let title = String(nd.title || '').trim()
      if (!title && nd.url) { try { title = new URL(nd.url).host } catch { title = '' } }
      if (!title) title = 'bookmark'
      const stem = this.safeSlug(title)
      let file = join(parentDir, `${stem}.html`)
      let n = 2
      while (fs.existsSync(file) && n < 1000) file = join(parentDir, `${stem}-${n++}.html`)
      try { fs.writeFileSync(file, this.bookmarkFileHtml(title, nd.url || '', nd.icon || '', order), 'utf8'); stat.files++ } catch { /* 单个文件失败忽略 */ }
      order++
    }
  }
  /** 导入浏览器书签 HTML（Netscape 格式，兼容 favorites_*.html）：整体导入到收藏根下新建文件夹 */
  async importBookmarksFile(root: string, srcPath: string): Promise<{ ok: boolean; imported?: number; folder?: string; error?: string }> {
    if (!root || typeof root !== 'string') return { ok: false, error: '未设置工作区' }
    if (!srcPath || typeof srcPath !== 'string') return { ok: false, error: '缺少书签文件路径' }
    let html = ''
    try { html = fs.readFileSync(srcPath, 'utf8') } catch (err: any) { return { ok: false, error: '读取书签文件失败：' + (err?.message || String(err)) } }
    if (!/<DL[\s>]/i.test(html)) return { ok: false, error: '不是有效的浏览器书签 HTML（缺少 <DL> 列表）' }
    const { rootTitle, nodes } = this.parseNetscapeBookmarks(html)
    const dir = this.bookmarkDir(root)
    const stem = basename(srcPath).replace(/\.html?$/i, '').trim() || 'bookmarks'
    const titleOk = rootTitle && rootTitle.toLowerCase() !== 'bookmarks'
    const base = this.safeFolderName(titleOk ? rootTitle : stem)
    let folderName = base
    let folder = join(dir, folderName)
    let n = 2
    while (fs.existsSync(folder) && n < 1000) { folderName = `${base}-${n++}`; folder = join(dir, folderName) }
    try { fs.mkdirSync(folder, { recursive: true }) } catch (err: any) { return { ok: false, error: '创建导入目录失败：' + (err?.message || String(err)) } }
    const stat = { files: 0, dirs: 0 }
    await this.writeImportedNodes(folder, nodes, stat)
    return { ok: true, imported: stat.files, folder: folderName }
  }
  /** 导出收藏为浏览器书签 HTML（Netscape 格式，兼容 favorites_*.html） */
  async exportBookmarksFile(root: string, dstPath: string): Promise<{ ok: boolean; count?: number; path?: string; error?: string }> {
    if (!root || typeof root !== 'string') return { ok: false, error: '未设置工作区' }
    if (!dstPath || typeof dstPath !== 'string') return { ok: false, error: '缺少导出路径' }
    const res = await this.listBookmarks(root)
    if (!res.ok || !res.items) return { ok: false, error: res.error || '读取收藏失败' }
    const parentOf = (rel: string) => { const i = rel.lastIndexOf('/'); return i >= 0 ? rel.slice(0, i) : '' }
    const byParent = new Map<string, NetBmNode[]>()
    const roots: NetBmNode[] = []
    for (const it of res.items) {
      const p = parentOf(it.rel)
      const plist = p ? (byParent.get(p) || null) : roots
      if (!plist) continue
      if (it.kind === 'dir') {
        const node: NetBmNode = { kind: 'dir', title: it.name, path: it.path, children: [] }
        plist.push(node)
        byParent.set(it.rel, node.children as NetBmNode[])
      } else {
        plist.push({ kind: 'file', title: it.title || it.name || '书签', url: it.url || '', icon: it.icon || '', path: it.path })
      }
    }
    // 读回文件时间戳作为近似收藏时间（ADD_DATE）；HTML 实体还原后再转义，避免二次转义
    const den = (v: string) => String(v || '').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    const addDateOf = (p?: string) => { if (!p) return 0; try { const s = fs.statSync(p); return s.isFile() || s.isDirectory() ? Math.max(1, Math.floor(s.mtimeMs / 1000)) : 0 } catch { return 0 } }
    const pad = (n: number) => '    '.repeat(n)
    const lines: string[] = []
    lines.push('<!DOCTYPE NETSCAPE-Bookmark-file-1>')
    lines.push('<!-- This is an automatically generated file.')
    lines.push('     It will be read and overwritten.')
    lines.push('     DO NOT EDIT! -->')
    lines.push('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">')
    lines.push('<TITLE>Bookmarks</TITLE>')
    lines.push('<H1>Bookmarks</H1>')
    const writeNodes = (nodes: NetBmNode[], depth: number) => {
      lines.push(`${pad(depth)}<DL><p>`)
      for (const nd of nodes) {
        if (nd.kind === 'dir') {
          const ad = addDateOf(nd.path)
          lines.push(`${pad(depth + 1)}<DT><H3${ad > 0 ? ` ADD_DATE="${ad}"` : ''}>${this.escHtml(nd.title || 'folder')}</H3>`)
          writeNodes(nd.children || [], depth + 1)
        } else {
          const ad = addDateOf(nd.path)
          const icon = nd.icon ? ` ICON="${this.attrSafe(den(nd.icon))}"` : ''
          lines.push(`${pad(depth + 1)}<DT><A HREF="${this.attrSafe(den(nd.url || ''))}"${ad > 0 ? ` ADD_DATE="${ad}"` : ''}${icon}>${this.escHtml(nd.title || '书签')}</A>`)
        }
      }
      lines.push(`${pad(depth)}</DL><p>`)
    }
    writeNodes(roots, 0)
    try {
      fs.writeFileSync(dstPath, lines.join('\n') + '\n', 'utf8')
    } catch (err: any) {
      return { ok: false, error: '写入导出文件失败：' + (err?.message || String(err)) }
    }
    let count = 0
    const countOf = (nodes: NetBmNode[]) => { for (const nd of nodes) { if (nd.kind === 'file') count++; else countOf(nd.children || []) } }
    countOf(roots)
    return { ok: true, count, path: dstPath }
  }

  // ===================== 缓存管理（浏览器专用 partition） =====================
  /** 浏览器分区目录（userData/Partitions/persist:browser-agent）：缓存与站点数据都在此 */
  private browserPartitionDir(): string {
    return join(app.getPath('userData'), 'Partitions', 'persist:browser-agent')
  }
  /** 递归计算目录占用字节数 */
  private dirSizeBytes(p: string): number {
    let total = 0
    let ents: fs.Dirent[] = []
    try { ents = fs.readdirSync(p, { withFileTypes: true }) } catch { return 0 }
    for (const e of ents) {
      try {
        const full = join(p, e.name)
        if (e.isDirectory()) total += this.dirSizeBytes(full)
        else if (e.isFile()) total += fs.statSync(full).size
      } catch { /* 忽略 */ }
    }
    return total
  }
  /** 查询浏览器缓存大小（分区目录总占用，含缓存与站点数据） */
  async cacheInfo(): Promise<{ ok: boolean; size: number; path: string }> {
    return { ok: true, size: this.dirSizeBytes(this.browserPartitionDir()), path: this.browserPartitionDir() }
  }
  /** 清理浏览器缓存：会话 clearCache + 删除分区内 Chromium 缓存子目录（保留登录态/收藏等站点数据） */
  async clearCache(): Promise<{ ok: boolean; size: number; error?: string }> {
    try {
      const s = session.fromPartition('persist:browser-agent')
      if (s) await s.clearCache()
    } catch { /* 分区尚未创建等忽略 */ }
    const p = this.browserPartitionDir()
    const cacheDirs = [
      'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'ShaderCache',
      'CacheStorage', 'ScriptCache', 'Service Worker', 'Shared Dictionary', 'Dictionaries',
    ]
    for (const d of cacheDirs) {
      try { fs.rmSync(join(p, d), { recursive: true, force: true }) } catch { /* 占用中的缓存目录可能删不动，忽略 */ }
    }
    return { ok: true, size: this.dirSizeBytes(p) }
  }

  // ===================== 外部控制 / 状态 =====================
  setAllowEval(v: boolean) {
    this.allowEval = !!v
    this.pushState()
  }

  private pushState() {
    const active = this.activeTab()
    const state: BrowserAgentState = {
      tabs: this.tabs.map(t => ({ ...t })),
      activeTabId: this.activeTabId,
      url: active?.url || '',
      title: active?.title || '',
      loading: !!active?.loading,
      canGoBack: !!active?.canGoBack,
      canGoForward: !!active?.canGoForward,
      agentActive: this.agentActive,
      agentBusyTabId: this.agentBusyTabId,
      agentTool: this.agentTool,
      allowEval: this.allowEval,
    }
    this.sendToShell('browser-agent:event', state)
  }

  get stateSnapshot(): BrowserAgentState {
    const active = this.activeTab()
    return {
      tabs: this.tabs.map(t => ({ ...t })),
      activeTabId: this.activeTabId,
      url: active?.url || '',
      title: active?.title || '',
      loading: !!active?.loading,
      canGoBack: !!active?.canGoBack,
      canGoForward: !!active?.canGoForward,
      agentActive: this.agentActive,
      agentBusyTabId: this.agentBusyTabId,
      agentTool: this.agentTool,
      allowEval: this.allowEval,
    }
  }
}

export const browserAgentService = new BrowserAgentService()
