/**
 * Office 编辑器宿主（主进程）
 *
 * 把 GenOffice 的编辑器内核（vendor/genoffice，见 scripts/office-vendor.lock.json）
 * 以 WebContentsView 形式挂到**发起请求的那个文件窗口**上，实现「Word / Excel / PPT / PDF
 * 四种类型共用一个宿主模块 + 一张类型描述表」。
 *
 * 目录契约（由 scripts/build-office.mjs 产出，改动需同步）：
 *   resources/office/<type>/main/index.cjs     宿主 API 模块（自包含 CJS）
 *   resources/office/<type>/preload/index.js   ← 编辑器约定 __dirname/../preload/index.js
 *   resources/office/<type>/renderer/index.html← 编辑器约定 __dirname/../renderer/index.html
 *
 * 设计要点（与浏览器 Agent 的 WebContentsView 多视图做法一致）：
 * 1. 视图表按 viewId 管理，一个窗口内可并存多个编辑器视图（当前 UI 一次只显示一个）；
 * 2. 渲染层只提供「占位元素的矩形」，由本模块负责摆放（编辑器视图盖在占位区之上）；
 * 3. 关闭前必须走「保存 + 脏检查轮询」，否则用户改动会丢（各类型保存通道不同，见 ADAPTERS）；
 * 4. 类型差异全部集中在 ADAPTERS 表，宿主逻辑与类型无关。
 */
import { app, ipcMain, protocol, net, BrowserWindow, WebContentsView, type WebContents } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)

export type EditorType = 'docs' | 'sheets' | 'slides'

const EDITOR_TYPES: EditorType[] = ['docs', 'sheets', 'slides']

/** 扩展名 → 编辑器类型（与 src/lib/knowFile/office.ts 保持一致）
 *
 * 说明：PDF **不启用**内嵌编辑器 —— AI-KM 已有自己的 PdfViewer（pdfjs + OCR + 翻译 + 与文档对话），
 * 内嵌的 PDF 编辑器（pdfium + 签名/表单）与其定位重叠且更重，按方案结论保持现状。
 */
const EXT_TO_TYPE: Record<string, EditorType> = {
  '.docx': 'docs',
  '.xlsx': 'sheets',
  '.xlsm': 'sheets',
  '.pptx': 'slides',
}

export function resolveEditorType(filePath: string): EditorType | null {
  if (!filePath) return null
  return EXT_TO_TYPE[path.extname(filePath).toLowerCase()] || null
}

// ==================== 类型描述表 ====================

/**
 * 每种编辑器要用的宿主 API。上游四个编辑器导出的函数名同形但不同名
 * （docsQueryDirty / sheetsPendingEditCount / slidesIsDirty / pdfIsDirty …），
 * 这里把差异收敛成一张「函数名 + 入参 + 钩子」的表，宿主其余部分对类型无感。
 */
interface EditorAdapter {
  label: string
  /** 该类型必需的上游导出（缺任一即视为该类型不可用） */
  required: string[]
  /** 配置运行时的函数名 */
  configure: string
  /** 配置运行时的入参：键名各类型不同（Word / Excel 用 rendererFile，PPT 用 rendererFilePath），
   *  传错键时上游不报错、只会静默回落到它自己的默认值；Excel 还额外要求 sidecarPath（见下）。 */
  configureArgs: (paths: { preloadPath: string; rendererFile: string }) => Record<string, unknown>
  /** 注册上游 IPC 的函数名 */
  registerIpc: string
  /** 创建视图的函数名 */
  createView: string
  /** 创建视图的入参（三种类型签名不同：Word 收路径，Excel / PPT 收选项对象） */
  createViewArgs: (filePath: string) => unknown[]
  /** 创建视图后把文件排入打开队列（Excel 专有：createSheetsView 不接受路径） */
  afterView?: (mod: any, entry: { view: WebContentsView; filePath: string }) => void
  /** 已构建但缺少**运行依赖**时的原因（如 Excel 的原生引擎未提供）；就绪时返回 null */
  runtimeIssue?: () => string | null
  /** 查询脏状态：返回 true 表示有未保存改动 */
  isDirty: string
  /** 触发保存：向编辑器 webContents 发送它认识的菜单命令 */
  requestSave: (wc: WebContents) => void
  /** 关闭确认（弹出保存/放弃/取消）；返回是否允许关闭 */
  requestClose: string
  /** 释放渲染层资源（仅 Word 提供；其余类型直接关闭 webContents 即可） */
  teardown?: string
  /** 宿主窗口钩子：WebContentsView 的 wc 没有属主窗口，必须由宿主告知 */
  hostWindowHook: string
  /** 「当前活动视图」解析器：接一个**返回 wc 的函数**（Word 用这种形状） */
  activeResolver?: string
  /** 「当前活动视图」直接 setter：接 **wc 本身**（Excel / PPT 用这种形状，与 resolver 不同） */
  activeSetter?: string
  /** 声明宿主窗口（另存为 / 消息框的父窗口） */
  setShellWindow?: string
  /** 文件已保存 / 已打开钩子 */
  fileSavedHook?: string
  fileOpenedHook?: string
  /**
   * 创建视图后要执行的「界面精简脚本」（在编辑器渲染层里跑一次）。
   * 用途：隐藏上游自带、与 AI-KM 重复或不需要的 UI（如 Ribbon 上的 Genspark 品牌入口）。
   * 只做「隐藏/改名」，不改功能，因此上游升级时脚本失效也只是恢复原样，不会报错。
   */
  hideUiScript?: string
}

/**
 * 上游内置的品牌入口清理脚本（在编辑器渲染层里跑一次）：
 * Genspark 是 GenOffice 的品牌，fork 必须替换（见 scripts/office-vendor.lock.json 的 licenseNotice）。
 * 只做「隐藏图标 + 改中性文案」，不动功能 —— 图标本身零功能所以直接隐藏；文字入口改名后仍可点击，
 * 否则折叠态的左侧竖条（PPT / Word 的 .ai-rail）会变成唯一入口却看不见、AI 面板再也打不开。
 *
 * 选择器都取自上游 DOM（实测）：品牌图标是 svg.genspark-mark（PPT 有类名，Word / Excel 无类名，
 * 三者共用 viewBox="0 0 130 130.025"）；文字入口是 Ribbon 左侧入口、分组标题、舞台工具条与 AI 面板标题。
 *
 * React 每次切 Ribbon 页签都会重建这些节点，所以装一个 MutationObserver 常驻重放（自身改动会收敛：
 * 已隐藏/已改名的节点下次不再命中，不会自激循环）。
 */
const BRAND_CLEANUP_SCRIPT = `(() => {
  const lang = (document.documentElement.lang || '').toLowerCase()
  const neutral = !lang || lang.startsWith('zh') ? 'AI 助手' : 'AI Assistant'
  // 品牌图标：PPT 的折叠竖条有 genspark-mark 类名，Word / Excel 没有类名但三者共用同一 viewBox；
  // Excel 的 AI 面板标题另有一枚 genspark-badge
  const MARKS = 'svg.genspark-mark, svg[viewBox="0 0 130 130.025"], .genspark-badge'
  // 整块隐藏：上游把「品牌徽标 + 品牌名」放在 AI 面板标题块里（看上去就是账号头像 + 名字），
  // 另外「登录 Genspark」按钮 —— AI-KM 不提供 Genspark 账号，出现即整块隐藏
  const BLOCKS = '.ai-panel-title, .ai-login-btn'
  const isBrandText = (text) => /^genspark(\\s*ai)?$/i.test(text.trim())
  // 只有图标的入口（PPT 折叠态 .ai-rail、Excel 折叠态 .expand-copilot）：图标藏掉后补个中性文字，
  // 否则左侧只剩一条空白条，AI 面板再也点不开
  const ICON_HOSTS = 'button, [role="button"], .ai-rail, .expand-copilot'
  const hiddenSelfOrAncestor = (el) => {
    let cur = el
    while (cur && cur.nodeType === 1) {
      if (getComputedStyle(cur).display === 'none') return true
      cur = cur.parentElement
    }
    return false
  }
  const cleanup = () => {
    const hits = []
    for (const block of document.querySelectorAll(BLOCKS)) {
      if (block.style.display === 'none') continue
      block.style.display = 'none'
      hits.push('block')
    }
    const marks = Array.from(document.querySelectorAll(MARKS))
    for (const mark of marks) {
      if (mark.style.display === 'none') continue
      mark.style.display = 'none'
      hits.push('mark')
    }
    // 按**文本节点**改名（整文档遍历，代价远低于 querySelectorAll + textContent 逐元素取文本）：
    // 品牌字样所在容器各版本不同，且常常与图标同级（如 Excel 的 .ai-panel-title = [svg, 'Genspark']），
    // 直接改容器 textContent 会把图标一起删掉
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!isBrandText(node.nodeValue || '')) continue
      node.nodeValue = neutral
      hits.push('label')
    }
    for (const mark of marks) {
      const host = mark.closest(ICON_HOSTS) || mark.parentElement
      if (!host || host.querySelector('.aikm-brand-fallback, .ai-rail-text')) continue
      if (hiddenSelfOrAncestor(host)) continue
      if ((host.innerText || '').trim() !== '') continue
      const span = document.createElement('span')
      if (host.classList.contains('ai-rail')) {
        span.className = 'ai-rail-text'
        span.textContent = 'AI'
      } else {
        span.className = 'aikm-brand-fallback'
        span.textContent = 'AI'
        span.style.cssText = 'font-size:12px;font-weight:600;line-height:1;color:inherit'
      }
      host.appendChild(span)
      hits.push('fallback')
    }
    return hits
  }
  window.__aikmBrandObserver?.disconnect()
  let timer = null
  const run = () => {
    timer = null
    try {
      cleanup()
    } catch {
      /* DOM 正中间态，下一轮再试 */
    }
  }
  const observer = new MutationObserver(() => {
    if (timer !== null) return
    timer = setTimeout(run, 300)
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })
  window.__aikmBrandObserver = observer
  return cleanup().join(',') || 'none'
})()`

// ==================== Excel 原生引擎（xlsx-sidecar）====================

/**
 * Excel 的打开 / 保存全部走 Rust 侧车 `xlsx-sidecar`（上游 apps/sheets/native/xlsx-engine）。
 * 它在 shell 里是 extraResources（`<resources>/native/xlsx-sidecar.exe`），开发态取 cargo 的
 * target 目录；**缺这一项时上游不会退化成 JS 引擎，而是 workbook:select 直接以
 * `spawn … ENOENT` 失败** —— 界面上就是「打开 xlsx 是一张空表」。
 */
const XLSX_SIDECAR_EXE = process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar'

/** 侧车可执行文件的搜索顺序：环境变量覆盖 → 项目自备产物 → vendor 里 cargo 的构建产物 */
export function resolveXlsxSidecarPath(): string {
  if (process.env.XLSX_SIDECAR_PATH) return process.env.XLSX_SIDECAR_PATH
  const appRoot = app.getAppPath()
  if (app.isPackaged) return path.join(process.resourcesPath, 'native', XLSX_SIDECAR_EXE)
  const staged = path.join(appRoot, 'resources', 'native', XLSX_SIDECAR_EXE)
  if (fs.existsSync(staged)) return staged
  return path.join(
    appRoot,
    'vendor',
    'genoffice',
    'apps',
    'sheets',
    'native',
    'xlsx-engine',
    'target',
    'release',
    XLSX_SIDECAR_EXE,
  )
}

/** 侧车缺失时给用户看的说明（含可执行的下一步），就绪时返回 null */
function xlsxSidecarIssue(): string | null {
  const binary = resolveXlsxSidecarPath()
  if (fs.existsSync(binary)) return null
  return (
    `Excel 编辑器缺少原生引擎 xlsx-sidecar，无法打开工作簿。\n` +
    `期望位置：${binary}\n` +
    `构建：在项目根目录执行 npm run office:build:native（需要 Rust 工具链）；` +
    `若已有该可执行文件，用环境变量 XLSX_SIDECAR_PATH 指向它即可。`
  )
}

const ADAPTERS: Record<EditorType, EditorAdapter> = {
  docs: {
    label: 'Word',
    required: [
      'createDocsView',
      'configureDocsRuntime',
      'registerDocsIpc',
      'setDocsHostWindowHook',
      'docsQueryDirty',
      'requestDocsClose',
    ],
    configure: 'configureDocsRuntime',
    configureArgs: ({ preloadPath, rendererFile }) => ({ preloadPath, rendererFile }),
    registerIpc: 'registerDocsIpc',
    createView: 'createDocsView',
    createViewArgs: (filePath) => [filePath],
    isDirty: 'docsQueryDirty',
    requestSave: (wc) => wc.send('menu:command', 'save'),
    requestClose: 'requestDocsClose',
    teardown: 'teardownDocsRenderer',
    hostWindowHook: 'setDocsHostWindowHook',
    activeResolver: 'setActiveDocsResolver',
    setShellWindow: 'setDocsShellWindow',
    fileSavedHook: 'setDocsFileSavedHook',
    fileOpenedHook: 'setDocsFileOpenedHook',
    hideUiScript: BRAND_CLEANUP_SCRIPT,
  },
  sheets: {
    label: 'Excel',
    required: [
      'createSheetsView',
      'configureSheetsRuntime',
      'registerSheetsIpc',
      'setSheetsHostWindowHook',
      'sheetsPendingEditCount',
      'requestSheetsClose',
    ],
    configure: 'configureSheetsRuntime',
    // Excel 的 configureSheetsRuntime 会**整体替换** runtime 配置对象，漏传 sidecarPath 就等于
    // 让原生引擎回落到 `app.getAppPath()/native/...`（不存在）—— 打开工作簿必失败
    configureArgs: ({ preloadPath, rendererFile }) => ({
      preloadPath,
      rendererFile,
      sidecarPath: resolveXlsxSidecarPath(),
    }),
    registerIpc: 'registerSheetsIpc',
    createView: 'createSheetsView',
    // openingWorkbook 让渲染层先摆出「正在打开工作簿」占位（与上游 openSheetsTab 一致）
    createViewArgs: () => [{ includeAiHandlers: false, openingWorkbook: true }],
    // Excel 的 createSheetsView 不接受文件路径：先声明它为「活动视图」，再把工作簿排入
    // 打开队列，然后按上游节奏 nudge（见下）
    afterView: (mod, entry) => {
      const wc = entry.view.webContents
      mod.setActiveSheetsWebContents?.(wc)
      mod.queueWorkbookForView(wc, entry.filePath)
      // 上游 shell 的 startQueuedWorkbookNudge：立刻发一次 'open'，之后每 700ms 重发，
      // 直到队列被消费（说明渲染层已挂载并取走路径）或超过 30s。渲染层在 Univer 挂载完
      // 之前不订阅菜单动作，单发一次会落空 —— 这正是「打开 xlsx 是空表」的老症状。
      const deadline = Date.now() + 30_000
      let timer: ReturnType<typeof setInterval> | null = null
      const stop = () => {
        if (timer) clearInterval(timer)
        timer = null
      }
      const nudge = () => {
        if (wc.isDestroyed() || Date.now() > deadline) return stop()
        try {
          if (!mod.hasActiveQueuedWorkbook?.()) return stop()
          mod.setActiveSheetsWebContents?.(wc)
          mod.nudgeQueuedWorkbook?.(wc)
        } catch {
          stop()
        }
      }
      mod.nudgeQueuedWorkbook?.(wc)
      timer = setInterval(nudge, 700)
    },
    runtimeIssue: xlsxSidecarIssue,
    isDirty: 'sheetsPendingEditCount',
    requestSave: (wc) => wc.send('menu:action', 'save'),
    requestClose: 'requestSheetsClose',
    hostWindowHook: 'setSheetsHostWindowHook',
    activeSetter: 'setActiveSheetsWebContents',
    hideUiScript: BRAND_CLEANUP_SCRIPT,
    setShellWindow: 'setSheetsShellWindow',
    fileOpenedHook: 'setSheetsWorkbookOpenedHook',
  },
  slides: {
    label: 'PPT',
    required: [
      'createSlidesView',
      'configureSlidesRuntime',
      'registerSlidesIpc',
      'setSlidesHostWindowHook',
      'slidesIsDirty',
      'requestSlidesClose',
    ],
    configure: 'configureSlidesRuntime',
    // PPT 的键名是 rendererFilePath（不是 rendererFile），传错会让它把默认值覆盖成 undefined
    configureArgs: ({ preloadPath, rendererFile }) => ({ preloadPath, rendererFilePath: rendererFile }),
    registerIpc: 'registerSlidesIpc',
    createView: 'createSlidesView',
    createViewArgs: (filePath) => [filePath],
    isDirty: 'slidesIsDirty',
    requestSave: (wc) => wc.send('slides:menu', 'save'),
    requestClose: 'requestSlidesClose',
    hostWindowHook: 'setSlidesHostWindowHook',
    activeSetter: 'setActiveSlidesWebContents',
    // 实测（genoffice-app://slides/index.html?mode=tab）品牌入口共三处，都是「图标 + Genspark AI」：
    //   · Ribbon 左侧 button.rb-big.ai-entry（rect 16,47，同组还有 AI 美化 / 事实核查 / 配图，保留）
    //   · 折叠态左侧竖条 button.ai-rail（rect 0,119,34,781 满高，内容只有 svg.genspark-mark）
    //   · 舞台顶部 button.stage-ai-btn（rect 278,137）
    // BRAND_CLEANUP_SCRIPT 按图标 + 文本统一处理，三处入口改名后仍可点击（hide 会把 AI 面板锁死）
    hideUiScript: BRAND_CLEANUP_SCRIPT,
    setShellWindow: 'setSlidesShellWindow',
    fileOpenedHook: 'setSlidesOpenedHook',
  },
}

// ==================== 状态 ====================

interface ViewEntry {
  viewId: string
  type: EditorType
  view: WebContentsView
  /** 宿主窗口（发起打开的文件窗口） */
  hostWindow: BrowserWindow
  filePath: string
  /** 渲染层占位区矩形（窗口内容区坐标，DIP） */
  bounds?: Rect
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const state = {
  /** 已加载并初始化过的类型 → 上游模块 */
  bundles: new Map<EditorType, any>(),
  views: new Map<string, ViewEntry>(),
  seq: 0,
  /** 上游「宿主窗口」是单例 setter，多窗口下在每次交互前指向对应窗口 */
  initialized: false,
}

/** Office 资源根目录：开发态取项目内 resources/office，打包后取 <app>/resources/office */
function officeRoot(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'office')
  return path.join(app.getAppPath(), 'resources', 'office')
}

// ==================== 渲染层自定义协议 ====================
/**
 * 上游编辑器 renderer 通过自定义协议加载（`genoffice-app://docs/index.html`），
 * 而不是 file://（Chromium 只为 http(s) 与特权 scheme 持久化 V8 code cache）。
 *
 * 这段逻辑等价于 @genoffice/electron-utils 的 registerRendererScheme / installRendererProtocol。
 * 之所以复制而不是 import：那是 vendor 里的 workspace 包（AI-KM 主进程的依赖解析不到它），
 * 为它引入 file: 依赖会让 npm install 依赖 vendor 目录，得不偿失。
 * 若上游改了 scheme 名或特权，这里必须同步（见 scripts/office-vendor.lock.json 的升级提示）。
 */
const RENDERER_SCHEME = 'genoffice-app'
const DOCX_MEDIA_SCHEME = 'genoffice-docx-media'

/** 必须在 app ready **之前**调用（registerSchemesAsPrivileged 每进程只能生效一次） */
export function registerOfficeSchemes() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: RENDERER_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
    },
    {
      // Word 的懒加载图片（docs 内核内部提供 handler，这里只登记特权）
      scheme: DOCX_MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ])
}

/** scheme 主机名 → 该编辑器的 renderer 目录 */
const rendererRoots = new Map<string, string>()
let rendererProtocolInstalled = false

/** 注册 renderer 请求处理（app ready 之后、创建视图之前调用，幂等） */
function installRendererProtocol() {
  if (rendererProtocolInstalled) return
  rendererProtocolInstalled = true
  protocol.handle(RENDERER_SCHEME, async (request) => {
    const file = resolveRendererFile(request.url)
    if (!file) return new Response(null, { status: 404 })
    try {
      return await net.fetch(pathToFileURL(file).toString())
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}

/** 把 scheme 请求映射到 renderer 目录内的文件（拒绝越界路径） */
function resolveRendererFile(requestUrl: string): string | null {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }
  const root = rendererRoots.get(url.hostname)
  if (!root) return null
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (pathname.length > 4096 || pathname.includes('\0')) return null
  // %5c 解码出的反斜杠在 Windows 上是分隔符，统一按 '/' 处理
  const relative = pathname.replace(/\\/g, '/').replace(/^\/+/, '')
  const base = path.resolve(root)
  const file = path.resolve(base, relative)
  if (file === base) return null
  return file.startsWith(base + path.sep) ? file : null
}

/** 该类型的产物是否已构建（未构建时 UI 应提示而不是崩溃） */
export function isEditorAvailable(type: EditorType): boolean {
  const base = path.join(officeRoot(), type)
  return (
    fs.existsSync(path.join(base, 'main', 'index.cjs')) &&
    fs.existsSync(path.join(base, 'renderer', 'index.html'))
  )
}

export function availableEditors(): Record<EditorType, boolean> {
  const out = {} as Record<EditorType, boolean>
  for (const t of EDITOR_TYPES) out[t] = isEditorAvailable(t)
  return out
}

/**
 * 各类型「已构建但缺运行依赖」的原因（当前只有 Excel 的原生引擎）。
 * 渲染层凭它把「空表」换成一句可执行的提示，而不是让用户对着空表格猜。
 */
export function editorIssues(): Partial<Record<EditorType, string>> {
  const out: Partial<Record<EditorType, string>> = {}
  for (const t of EDITOR_TYPES) {
    if (!isEditorAvailable(t)) continue
    const issue = ADAPTERS[t].runtimeIssue?.()
    if (issue) out[t] = issue
  }
  return out
}

/** 加载并初始化某类型的宿主 API 模块（幂等） */
function ensureBundle(type: EditorType): any {
  const cached = state.bundles.get(type)
  if (cached) return cached

  const base = path.join(officeRoot(), type)
  const entry = path.join(base, 'main', 'index.cjs')
  if (!fs.existsSync(entry)) {
    throw new Error(`Office 编辑器未构建：${path.relative(app.getAppPath(), entry)}（执行 npm run office:build）`)
  }
  const adapter = ADAPTERS[type]
  const mod = require_(entry)

  const missing = adapter.required.filter((name) => typeof mod[name] !== 'function')
  if (missing.length) {
    throw new Error(
      `${adapter.label} 编辑器 API 不匹配，缺少 ${missing.join(', ')}（上游升级后需同步 office-host.ts 的适配表）`,
    )
  }

  // 运行时路径：preload / renderer 与 main 同级的固定约定（见文件头）
  const rendererDir = path.join(base, 'renderer')
  mod[adapter.configure](
    adapter.configureArgs({
      preloadPath: path.join(base, 'preload', 'index.js'),
      rendererFile: path.join(rendererDir, 'index.html'),
    }),
  )
  mod[adapter.registerIpc]()

  // renderer 经自定义协议加载：登记该类型的目录并（首次）安装协议处理
  rendererRoots.set(type, rendererDir)
  installRendererProtocol()

  // WebContentsView 的 webContents 没有属主窗口，必须由宿主告知
  if (typeof mod[adapter.hostWindowHook] === 'function') {
    mod[adapter.hostWindowHook]((wc: WebContents) => entryOfWebContents(wc)?.hostWindow ?? null)
  }
  // 活动视图：Word 是 resolver（接函数），Excel / PPT 是直接 setter（接 wc），两者形状不同
  if (adapter.activeResolver && typeof mod[adapter.activeResolver] === 'function') {
    mod[adapter.activeResolver](() => {
      const ofType = [...state.views.values()].filter((e) => e.type === type)
      const focused = ofType.find((e) => !e.view.webContents.isDestroyed() && e.view.webContents.isFocused())
      const fallback = ofType.find((e) => !e.view.webContents.isDestroyed())
      return focused?.view.webContents ?? fallback?.view.webContents ?? null
    })
  }
  if (adapter.fileSavedHook && typeof mod[adapter.fileSavedHook] === 'function') {
    mod[adapter.fileSavedHook]((wcArg: any, filePath: string) => {
      const entry = entryOfWebContents(typeof wcArg === 'number' ? wcArg : wcArg)
      if (entry && filePath) entry.filePath = filePath
      notifyHost(entry, 'saved', filePath)
    })
  }
  if (adapter.fileOpenedHook && typeof mod[adapter.fileOpenedHook] === 'function') {
    mod[adapter.fileOpenedHook]((wcArg: any, filePath: string) => {
      const entry = entryOfWebContents(wcArg)
      if (entry && filePath) entry.filePath = filePath
    })
  }

  state.bundles.set(type, mod)
  console.log(`[office] ${type} 编辑器内核已就绪（${adapter.label}）`)
  return mod
}

// ==================== 查找与通知 ====================

function entryOfWebContents(arg: WebContents | number): ViewEntry | null {
  for (const entry of state.views.values()) {
    const wc = entry.view.webContents
    if (wc === arg || wc.id === arg) return entry
  }
  return null
}

/** 按编辑器 webContents 查出该视图的信息（AI/知识库桥需要知道「当前文档是谁、宿主窗口是谁」） */
export function viewInfoOfWebContents(
  wc: WebContents,
): { filePath: string; hostWindow: BrowserWindow; type: EditorType } | null {
  const entry = entryOfWebContents(wc)
  if (!entry) return null
  return { filePath: entry.filePath, hostWindow: entry.hostWindow, type: entry.type }
}

/** 通知渲染层（宿主 Vue 侧）某视图状态变化 */
function notifyHost(entry: ViewEntry | null | undefined, event: string, filePath?: string) {
  if (!entry) return
  const { hostWindow, viewId, type } = entry
  if (hostWindow.isDestroyed()) return
  hostWindow.webContents.send('office:event', { viewId, type, event, filePath: filePath || entry.filePath })
}

/** 把视图放在宿主窗口的最上层并占满占位区 */
function applyBounds(entry: ViewEntry) {
  if (entry.view.webContents.isDestroyed()) return
  const b = entry.bounds
  if (!b) return
  entry.view.setBounds({
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.max(0, Math.round(b.width)),
    height: Math.max(0, Math.round(b.height)),
  })
}

function showView(entry: ViewEntry) {
  for (const other of state.views.values()) {
    if (other === entry) continue
    if (other.hostWindow === entry.hostWindow && !other.view.webContents.isDestroyed()) {
      other.view.setVisible(false)
    }
  }
  // 上游按「当前活动视图」取上下文（Excel / PPT 是直接 setter）
  const adapter = ADAPTERS[entry.type]
  const mod = state.bundles.get(entry.type)
  if (mod && adapter.activeSetter && typeof mod[adapter.activeSetter] === 'function') {
    try {
      mod[adapter.activeSetter](entry.view.webContents)
    } catch {
      /* 忽略 */
    }
  }
  applyBounds(entry)
  entry.view.setVisible(true)
}

function attachView(entry: ViewEntry) {
  entry.hostWindow.contentView.addChildView(entry.view)
  entry.view.setVisible(false)
  applyBounds(entry)
  state.views.set(entry.viewId, entry)

  // 界面精简：编辑器加载完成后跑一次（如隐藏 Ribbon 上的 Genspark 品牌入口）
  const adapterForView = ADAPTERS[entry.type]
  if (adapterForView.hideUiScript) {
    entry.view.webContents.once('did-finish-load', () => {
      if (entry.view.webContents.isDestroyed()) return
      entry.view.webContents
        .executeJavaScript(adapterForView.hideUiScript!, true)
        .catch((e) => console.warn(`[office] ${entry.viewId} 界面精简脚本失败:`, e?.message || e))
    })
  }

  // 诊断：把内嵌编辑器渲染层的 console 与加载失败转发到主进程终端
  // （Excel「打开是空表」这类问题只能从渲染层日志看出来；稳定后可移除）
  entry.view.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2 || /error|fail|empty|workbook|queued/i.test(message)) {
      console.log(`[office:${entry.viewId}] ${message} (${String(source).split('/').pop()}:${line})`)
    }
  })
  entry.view.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.warn(`[office:${entry.viewId}] 加载失败 code=${code} ${desc} ${url}`)
  })

  // 编辑器内 HTML5 全屏（如 PPT 放映）→ 跟随窗口全屏
  entry.view.webContents.on('enter-html-full-screen', () => {
    if (!entry.hostWindow.isFullScreen()) entry.hostWindow.setFullScreen(true)
  })
  entry.view.webContents.on('leave-html-full-screen', () => {
    if (entry.hostWindow.isFullScreen()) entry.hostWindow.setFullScreen(false)
  })
  entry.view.webContents.once('render-process-gone', () => {
    console.error(`[office] ${entry.viewId} 渲染进程崩溃`)
    destroyView(entry, false)
    notifyHost(entry, 'crashed')
  })
}

function destroyView(entry: ViewEntry, teardown = true) {
  if (teardown) {
    const mod = state.bundles.get(entry.type)
    const adapter = ADAPTERS[entry.type]
    try {
      // 仅 Word 提供了 teardown API；其余类型直接关闭 webContents 即可
      if (
        adapter.teardown &&
        mod &&
        typeof mod[adapter.teardown] === 'function' &&
        !entry.view.webContents.isDestroyed()
      ) {
        mod[adapter.teardown](entry.view.webContents)
      }
    } catch (e) {
      console.warn(`[office] teardown ${entry.viewId} 失败:`, (e as Error)?.message)
    }
  }
  try {
    entry.hostWindow.contentView.removeChildView(entry.view)
  } catch {
    /* 窗口已销毁时忽略 */
  }
  state.views.delete(entry.viewId)
  if (!entry.view.webContents.isDestroyed()) {
    try {
      entry.view.webContents.close()
    } catch {
      /* 已关闭 */
    }
  }
}

// ==================== 保存与关闭 ====================

/** 查询是否脏（各类型 API 形态不同） */
async function queryDirty(entry: ViewEntry): Promise<boolean> {
  const mod = state.bundles.get(entry.type)
  const adapter = ADAPTERS[entry.type]
  if (!mod || entry.view.webContents.isDestroyed()) return false
  try {
    const fn = mod[adapter.isDirty]
    const res = fn(entry.view.webContents.id ?? entry.view.webContents)
    return res instanceof Promise ? Boolean(await res) : Number(res) > 0 || res === true
  } catch (e) {
    console.warn(`[office] ${entry.viewId} 脏检查失败:`, (e as Error)?.message)
    return false
  }
}

/**
 * 关闭前保存：触发编辑器保存命令并轮询脏标记直到落盘。
 * 未保存过的新文档会由编辑器自己弹「另存为」，因此超时上限取 120s（与上游一致）。
 */
export async function autoSaveView(viewId: string, timeoutMs = 120000): Promise<{ ok: boolean; saved: boolean }> {
  const entry = state.views.get(viewId)
  if (!entry || entry.view.webContents.isDestroyed()) return { ok: true, saved: false }
  const mod = state.bundles.get(entry.type)
  const adapter = ADAPTERS[entry.type]
  if (!mod) return { ok: true, saved: false }

  if (!(await queryDirty(entry))) return { ok: true, saved: false }

  // 上游的另存为/确认框需要宿主窗口
  const shellApi = adapter.setShellWindow ? mod[adapter.setShellWindow] : null
  if (typeof shellApi === 'function') shellApi(entry.hostWindow)

  adapter.requestSave(entry.view.webContents)

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (entry.view.webContents.isDestroyed()) return { ok: true, saved: true }
    if (!(await queryDirty(entry))) {
      notifyHost(entry, 'saved')
      return { ok: true, saved: true }
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  return { ok: false, saved: false }
}

/** 关闭视图：脏则先保存（含上游的保存/放弃/取消确认），不允许关闭时保留视图 */
export async function closeView(viewId: string): Promise<{ ok: boolean; saved: boolean }> {
  const entry = state.views.get(viewId)
  if (!entry) return { ok: true, saved: false }
  const mod = state.bundles.get(entry.type)
  const adapter = ADAPTERS[entry.type]

  if (mod && !entry.view.webContents.isDestroyed() && (await queryDirty(entry))) {
    const shellApi = adapter.setShellWindow ? mod[adapter.setShellWindow] : null
    if (typeof shellApi === 'function') shellApi(entry.hostWindow)
    try {
      const proceed = await mod[adapter.requestClose](entry.view.webContents, entry.hostWindow)
      if (proceed === false) return { ok: false, saved: false }
    } catch (e) {
      console.warn(`[office] ${viewId} 关闭确认失败:`, (e as Error)?.message)
    }
  }
  destroyView(entry)
  return { ok: true, saved: true }
}

/** 宿主窗口销毁时回收其全部视图 */
export function disposeWindowViews(hostWindow: BrowserWindow) {
  for (const entry of [...state.views.values()]) {
    if (entry.hostWindow === hostWindow) destroyView(entry, false)
  }
}

/** 应用退出时回收 */
export function disposeAll() {
  for (const entry of [...state.views.values()]) destroyView(entry, false)
  state.views.clear()
}

// ==================== 打开视图 ====================

export interface OpenResult {
  ok: boolean
  viewId?: string
  type?: EditorType
  filePath?: string
  error?: string
}

/** 打开文件到指定宿主窗口（同一文件已打开则复用并激活） */
export async function openInWindow(hostWindow: BrowserWindow, filePath: string): Promise<OpenResult> {
  const type = resolveEditorType(filePath)
  if (!type) return { ok: false, error: `不支持的文件类型：${path.extname(filePath)}` }
  if (!fs.existsSync(filePath)) return { ok: false, error: `文件不存在：${filePath}` }

  // 同窗口同文件 → 复用
  for (const entry of state.views.values()) {
    if (entry.hostWindow === hostWindow && entry.type === type && entry.filePath === filePath) {
      showView(entry)
      return { ok: true, viewId: entry.viewId, type, filePath }
    }
  }

  let mod: any
  try {
    mod = ensureBundle(type)
  } catch (e) {
    return { ok: false, error: (e as Error)?.message }
  }

  const adapter = ADAPTERS[type]
  // 运行依赖先行检查：Excel 的原生引擎没就位时，上游会在 workbook:select 里报
  // `spawn … ENOENT`，界面表现为「空表 + 一行看不懂的报错」。这里直接给出可执行的提示。
  const issue = adapter.runtimeIssue?.()
  if (issue) return { ok: false, error: issue }

  let view: WebContentsView
  try {
    // 各类型 createView 签名不同（见 ADAPTERS.createViewArgs）；宿主自备 AI 桥，
    // 故 Excel 传 includeAiHandlers:false —— AI 通道由 office-ai.ts 统一接管
    view = mod[adapter.createView](...adapter.createViewArgs(filePath))
  } catch (e) {
    return { ok: false, error: `${adapter.label} 视图创建失败：${(e as Error)?.message}` }
  }

  const entry: ViewEntry = {
    viewId: `${type}-${++state.seq}`,
    type,
    view,
    hostWindow,
    filePath,
  }
  // Excel：声明活动视图 + 排队工作簿 + 轮询 nudge（必须在 attachView 之前排队）
  try {
    adapter.afterView?.(mod, entry)
  } catch (e) {
    console.warn(`[office] ${entry.viewId} 打开排队失败:`, (e as Error)?.message)
  }
  attachView(entry)
  showView(entry)
  console.log(`[office] 打开 ${entry.viewId} → ${filePath}`)
  return { ok: true, viewId: entry.viewId, type, filePath }
}

// ==================== IPC ====================

function windowFromEvent(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

/** 注册渲染层可调用的 IPC（主窗口与文件窗口共用） */
export function registerOfficeHostIpc() {
  if (state.initialized) return
  state.initialized = true

  ipcMain.handle('office:available', () => {
    const editors = availableEditors()
    const issues = editorIssues()
    // 诊断用：渲染层每次探测（每个文件窗口一次）都会打印，方便确认「视图为何没出现」
    console.log(
      '[office] availability →',
      JSON.stringify(editors),
      Object.keys(issues).length ? `issues=${JSON.stringify(issues)}` : '',
      'root =',
      officeRoot(),
    )
    return { editors, issues, root: officeRoot() }
  })

  ipcMain.handle('office:open', async (event, payload: { path?: string; rect?: Rect }) => {
    const hostWindow = windowFromEvent(event)
    if (!hostWindow) return { ok: false, error: '找不到宿主窗口' }
    const filePath = String(payload?.path || '')
    const res = await openInWindow(hostWindow, filePath)
    if (res.ok && res.viewId && payload?.rect) {
      setViewBounds(res.viewId, payload.rect, event.sender.getZoomFactor())
    }
    return res
  })

  ipcMain.handle(
    'office:set-bounds',
    (event, payload: { viewId?: string; rect?: Rect }) => {
      const viewId = String(payload?.viewId || '')
      if (payload?.rect) setViewBounds(viewId, payload.rect, event.sender.getZoomFactor())
      return { ok: true }
    },
  )

  ipcMain.handle('office:autosave', async (_e, payload: { viewId?: string }) =>
    autoSaveView(String(payload?.viewId || '')),
  )

  ipcMain.handle('office:close', async (_e, payload: { viewId?: string }) =>
    closeView(String(payload?.viewId || '')),
  )

  ipcMain.handle('office:state', async (_e, payload: { viewId?: string }) => {
    const entry = state.views.get(String(payload?.viewId || ''))
    if (!entry) return { ok: false }
    return { ok: true, dirty: await queryDirty(entry), filePath: entry.filePath, type: entry.type }
  })

  /** 视图数不变但需要重排时（窗口尺寸变化、视图切换回来）由渲染层调用 */
  ipcMain.handle('office:refresh', (_e, payload: { viewId?: string }) => {
    const entry = state.views.get(String(payload?.viewId || ''))
    if (entry) showView(entry)
    return { ok: true }
  })

  /**
   * 临时隐藏/恢复视图：原生视图绘制在 DOM 之上，渲染层的浮层（视图切换下拉等）
   * 需要先隐藏视图才能显示完整。
   */
  ipcMain.handle('office:set-visible', (_e, payload: { viewId?: string; visible?: boolean }) => {
    const entry = state.views.get(String(payload?.viewId || ''))
    if (entry && !entry.view.webContents.isDestroyed()) {
      entry.view.setVisible(payload?.visible !== false)
    }
    return { ok: true }
  })
}

/**
 * 设置视图矩形。渲染层给的是 CSS 像素（相对窗口内容区的占位元素 rect），
 * 需按窗口缩放换算成 DIP —— 否则缩放 ≠ 100% 时编辑器会错位。
 */
function setViewBounds(viewId: string, rect: Rect, zoom: number) {
  const entry = state.views.get(viewId)
  if (!entry) return
  const z = zoom && Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  entry.bounds = {
    x: rect.x * z,
    y: rect.y * z,
    width: rect.width * z,
    height: rect.height * z,
  }
  applyBounds(entry)
}
