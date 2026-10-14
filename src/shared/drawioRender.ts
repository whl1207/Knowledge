/**
 * drawioRender.ts — 把 .drawio（mxfile XML）离屏渲染成 SVG / PNG（渲染进程专用）
 *
 * 用途：Markdown 里 `![](diagram.drawio)` 的内嵌预览、导出 Word 时把图表变成图片。
 *
 * 做法与编辑器里的「复制为图片」一致：复用随包发布的 drawio webapp（embed + JSON 协议），
 * 让 drawio 自己把 XML 画成 SVG —— 形状 / 字体 / 富文本标签 / 正交连线的保真度都按编辑器所见；
 * 不用自写解析器渲染（忽略正交路由、容器泳道、图片与多页，只能"看着像"）。
 *
 * 三条硬约束决定了这里的实现形态：
 *  1) **单例 + 串行队列**：drawio 应用本体近 10 MB，每个图表各起一个 iframe 不可接受 →
 *     整个应用只养一个离屏 iframe，渲染请求排队执行；
 *  2) **按内容哈希缓存**：同一份图表（重渲染 / 导出 / 多个 md 引用同一文件）只渲染一次；
 *  3) **统一白底浅色**：`graph.getSvg` 拿浅色主题 + 白底，这样内嵌预览与 Word/PDF 导出一致，
 *     深色主题下也只是一张白底卡片，不会出现"深底黑字看不见"。
 *
 * 渲染来源有两级兜底：优先 `__aimDrawioImageApi.svgForCopy`（graph.getSvg，与复制为图片同路径），
 * 拿不到编辑器实例时退回内嵌协议 `{action:'export', format:'svg'}`。
 */
import { DRAWIO_ASSET_DIR } from '@/shared/drawioFile'
import { installDrawioExportBridge, type DrawioExportHost } from '@/shared/drawioExportBridge'
import { clampScale, decodeSvgText, drawioSvgToPngDataUrl, svgLogicalSize } from '@/shared/drawioImage'
import { getPlatform, hasCapability } from '@/platform'

/** 首次渲染要加载 drawio 应用本体，给足时间；之后单次渲染只等一次 load 事件 */
const BOOT_TIMEOUT = 30_000
const RENDER_TIMEOUT = 12_000
/** SVG 缓存条数上限（超出淘汰最早写入的） */
const CACHE_LIMIT = 32

/** readFile IPC 读取失败时主进程返回的"错误文本"前缀（见 electron/main/index.ts） */
const READ_ERROR_PREFIXES = ['Error reading file:', '不支持的文件格式', 'Error reading ']

/** 离屏 iframe 的标记属性（也用于识别「焦点被离屏渲染器拿走」） */
const OFFSCREEN_ATTR = 'data-drawio-offscreen'

/** 单份图表最多内嵌渲染的页数（超过只渲染前 N 页并提示，其余请在编辑器里看） */
export const MAX_DIAGRAM_PAGES = 10
/** 切换页后等 graph 重排的兜底上限 */
const PAGE_SWITCH_TIMEOUT = 2000

const svgCache = new Map<string, string>()

export interface DiagramPng {
  dataUrl: string
  /** 逻辑尺寸（px，即 drawio 里 100% 缩放时的大小） */
  w: number
  h: number
}

/** 单页渲染结果 */
export interface DiagramPageSvg {
  /** 页序号（0 起） */
  index: number
  /** 总页数 */
  total: number
  name: string
  svg: string
}

/** 内容哈希（缓存键）：同一份 XML 只渲染一次 */
export function diagramHash(xml: string): string {
  const text = String(xml || '').trim()
  let h1 = 0
  let h2 = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = (h1 * 31 + c) | 0
    h2 = (h2 * 37 + c) | 0
  }
  return `dh_${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}_${text.length.toString(36)}`
}

/** 缓存键：同一份图表 + 同一页只渲染一次 */
function diagramKey(xml: string, page: number): string {
  return `${diagramHash(xml)}@${page}`
}

/** 取缓存的 SVG（page 为 0 起的页序号）；没有则返回 undefined */
export function getCachedDiagramSvg(xml: string, page = 0): string | undefined {
  return svgCache.get(diagramKey(xml, page))
}

function cacheSvg(xml: string, page: number, svg: string): void {
  const key = diagramKey(xml, page)
  svgCache.delete(key)
  svgCache.set(key, svg)
  while (svgCache.size > CACHE_LIMIT) {
    const oldest = svgCache.keys().next().value
    if (oldest === undefined) break
    svgCache.delete(oldest)
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

// ==================== 离屏 iframe ====================

interface PendingLoad {
  xml: string
  resolve: () => void
  timer: number
}
interface ExportWaiter {
  format: string
  done: (data: string) => void
}

let frame: HTMLIFrameElement | null = null
let framePromise: Promise<void> | null = null
let listenerInstalled = false
let bridgeInstalled = false
let pendingLoad: PendingLoad | null = null
let exportWaiter: ExportWaiter | null = null
/**
 * drawio 的 `init` 事件是"可以喂内容了"的信号：它的消息处理器在应用脚本求值时就开始工作，
 * 早于 iframe 的 load 事件，所以只能**等到 init 之后再发 load** —— 提前发的会被丢弃。
 */
let initSeen = false
let initWaiters: Array<() => void> = []
/** 渲染队列尾：所有渲染串行执行（drawio 一次只画一张图） */
let queueTail: Promise<unknown> = Promise.resolve()

/** 离屏渲染专用：导出 / 打印一律不落地（图表本身没有"另存为"语义） */
const noopHost: DrawioExportHost = {
  save: async () => ({ canceled: true }),
  pick: async () => null,
  write: async () => false,
  pdf: () => {},
  print: () => {},
}

function log(...args: unknown[]): void {
  console.warn('[drawioRender]', ...args)
}

/**
 * 兜底：把被离屏 iframe 抢走的键盘焦点交还宿主。
 *
 * 离屏渲染器只是个"画图工具"，绝不能拿走宿主的键盘焦点：drawio 载入内容时会自己调
 * `window.focus()`（开关是 EditorUi.noAutoFocus，见 onMessage 的 configure 分支），焦点一旦落进
 * 这个视口外的 iframe，宿主的 window / document 就收不到 keydown 了 —— 演示视图（md_ppt）的
 * 左右键翻页会直接"按不动"，搜索框等输入也会突然没反应。
 *
 * 正常路径下 noAutoFocus 已经关掉了这个行为，这里再加一道保险（drawio 版本差异 / 别的聚焦路径）。
 * 只处理「焦点确实在离屏 iframe 上」的情况，不动用户自己的焦点；也不要调宿主 window.focus()
 * （那会把应用窗口拉到前台，反而抢走用户正在用的其它窗口）。
 */
export function releaseStolenFocus(): void {
  if (typeof document === 'undefined') return
  const active = document.activeElement
  if (!(active instanceof HTMLIFrameElement) || !active.hasAttribute(OFFSCREEN_ATTR)) return
  try {
    active.blur()
    // 个别版本里 blur 元素不足以把焦点交回顶层文档，再对帧窗口要一次
    active.contentWindow?.blur?.()
  } catch {
    /* 跨源取 contentWindow 会抛错：忽略即可 */
  }
}

function buildSrc(): string {
  const url = new URL(DRAWIO_ASSET_DIR + 'index.html', document.baseURI)
  url.search = new URLSearchParams({
    embed: '1',
    proto: 'json',
    configure: '1',
    // 离屏渲染不需要界面元素：不加载形状库、不显示 spin / 保存 / 退出按钮
    spin: '0',
    libraries: '0',
    noSaveBtn: '1',
    noExitBtn: '1',
    saveAndExit: '0',
    modified: '0',
    // 离线优先：db=0 关掉 Dropbox 集成（否则启动时会去拉外部脚本、无网络时长时间超时）
    db: '0',
    browser: '0',
    ui: 'kennedy',
  }).toString()
  return url.href
}

/**
 * 当前离屏窗口。**必须现取 `frame.contentWindow`**：iframe 在 src 生效前就已经有 contentWindow
 * （about:blank 的 WindowProxy），而 `message` 事件里的 `ev.source` 与之**不相等**（实测：捕获值
 * 比较恒为 false）—— 用创建时捕获的窗口做来源过滤会把 configure / init 全部丢掉，表现为渲染永不返回。
 */
function currentWindow(): Window | null {
  return frame ? frame.contentWindow : null
}

function send(payload: Record<string, unknown>): void {
  const win = currentWindow()
  if (!win) return
  try {
    win.postMessage(JSON.stringify(payload), '*')
  } catch (e) {
    log('postMessage 失败:', e)
  }
}

function sendLoad(xml: string): void {
  send({
    action: 'load',
    xml,
    // 只读渲染：不要 drawio 回传任何变更
    autosave: 0,
    title: 'preview',
    border: 8,
    fit: 1,
    maxFitScale: 1,
  })
}

function onMessage(ev: MessageEvent): void {
  const win = currentWindow()
  if (!win || ev.source !== win) return
  let msg: any
  try {
    msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data
  } catch {
    return
  }
  if (!msg || typeof msg.event !== 'string') return

  // drawio 应用脚本启动后 EditorUi 才存在：桥装载成功一次即可（它顺带挂出取图接口）
  if (!bridgeInstalled) {
    try {
      bridgeInstalled = installDrawioExportBridge(win, noopHost, log) > 0
    } catch (e) {
      log('装载取图桥失败:', e)
    }
  }

  switch (msg.event) {
    case 'configure':
      send({
        action: 'configure',
        config: {
          useInternalClipboard: true,
          suppressNewWindows: true,
          // 关掉 drawio 的「载入后自动聚焦」：它每次喂进内容都会执行
          // `window.self===window.top || this.noAutoFocus || window.focus()`（fileLoaded /
          // initializeEmbedMode），而我们是 iframe，于是它把键盘焦点从宿主文档抢到这个视口外的
          // 离屏 iframe 里 —— 焦点一旦落进来，宿主的 window keydown 就再也收不到，
          // 表现为演示视图（md_ppt）的左右键翻页「按不动」，直到用户重新点一下页面。
          noAutoFocus: true,
        },
      })
      break
    case 'init':
      initSeen = true
      for (const w of initWaiters) w()
      initWaiters = []
      break
    case 'load':
      if (pendingLoad) {
        const p = pendingLoad
        pendingLoad = null
        window.clearTimeout(p.timer)
        // 内容载入的同时 drawio 可能刚刚抢过焦点（见 releaseStolenFocus），这里立刻交还
        releaseStolenFocus()
        p.resolve()
      }
      break
    case 'export':
      if (exportWaiter && String(msg.format || '') === exportWaiter.format) {
        const w = exportWaiter
        exportWaiter = null
        w.done(String(msg.data || ''))
      }
      break
    default:
      // autosave / save / exit：只读渲染不关心
      break
  }
}

function createFrame(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const el = document.createElement('iframe')
    el.setAttribute('aria-hidden', 'true')
    el.setAttribute(OFFSCREEN_ATTR, '1')
    el.tabIndex = -1
    // 放在视口外但保留真实尺寸：drawio 需要一个有布局尺寸的容器才能正常初始化
    el.style.cssText = 'position:fixed;left:-20000px;top:0;width:1280px;height:900px;border:0;pointer-events:none;'
    // 先挂上元素再等 load：消息处理器必须在 drawio 发出 configure 之前装好
    frame = el
    const timer = window.setTimeout(() => {
      framePromise = null
      resetFrame()
      reject(new Error('drawio 渲染器加载超时'))
    }, BOOT_TIMEOUT)
    el.addEventListener('load', () => {
      window.clearTimeout(timer)
      resolve()
    })
    if (!listenerInstalled) {
      window.addEventListener('message', onMessage)
      listenerInstalled = true
    }
    el.src = buildSrc()
    document.body.appendChild(el)
  })
}

/** 等 drawio 的 init 握手（超时后仍放行：内容相同，多喂一次也无害） */
function waitInit(timeout: number): Promise<void> {
  if (initSeen) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = window.setTimeout(() => {
      initWaiters = initWaiters.filter((w) => w !== done)
      log('未收到 drawio init 握手，仍尝试发送 load')
      resolve()
    }, timeout)
    const done = () => {
      window.clearTimeout(timer)
      resolve()
    }
    initWaiters.push(done)
  })
}

function ensureFrame(): Promise<void> {
  if (frame) return Promise.resolve()
  if (!framePromise) {
    framePromise = createFrame().catch((e) => {
      framePromise = null
      throw e
    })
  }
  return framePromise
}

/** 丢弃离屏 iframe（渲染卡死 / 超时后重建，避免后续请求全部陪葬） */
function resetFrame(): void {
  if (pendingLoad) {
    window.clearTimeout(pendingLoad.timer)
    pendingLoad = null
  }
  if (exportWaiter) exportWaiter = null
  try {
    frame?.remove()
  } catch {
    /* ignore */
  }
  frame = null
  framePromise = null
  bridgeInstalled = false
  initSeen = false
}

/** 内嵌协议取图（`svgForCopy` 拿不到时的兜底） */
function requestExport(format: string, opts: Record<string, unknown>, timeout: number): Promise<string> {
  return new Promise<string>((resolve) => {
    const timer = window.setTimeout(() => {
      if (exportWaiter && exportWaiter.format === format) exportWaiter = null
      resolve('')
    }, timeout)
    exportWaiter = {
      format,
      done: (data) => {
        window.clearTimeout(timer)
        resolve(data)
      },
    }
    send({ action: 'export', format, ...opts })
  })
}

/** 取当前页 SVG（走 drawio 自己的 graph.getSvg）；拿不到返回空串 */
function currentPageSvg(): string {
  const api: any = (currentWindow() as any)?.__aimDrawioImageApi
  if (!api?.ready?.()) return ''
  try {
    const svg = api.svgForCopy({ scale: 1, border: 8, background: '#ffffff', theme: 'light', selectionOnly: false })
    return svg ? String(svg) : ''
  } catch (e) {
    log('取画布 SVG 失败:', e)
    return ''
  }
}

/** 切到指定页并等 graph 重排完成（切换是异步的，立刻取图会拿到上一页） */
async function selectPageAndSettle(index: number): Promise<boolean> {
  const api: any = (currentWindow() as any)?.__aimDrawioImageApi
  if (!api?.selectPage || !api?.currentPage) return false
  if (api.currentPage()?.index === index) return true
  if (!api.selectPage(index)) return false
  const deadline = Date.now() + PAGE_SWITCH_TIMEOUT
  while (Date.now() < deadline) {
    await delay(80)
    if (api.currentPage()?.index === index) {
      await delay(120)
      return true
    }
  }
  log('切页未生效:', index)
  return false
}

/** 页定位语法：`#page=2`（1 起的序号）/ `#page=页名` / `#page=页id`，也接受简写 `#2` */
const PAGE_FRAGMENT_RE = /^page=(.+)$/i

/**
 * 拆出「文件路径 + 页定位」。片段的其它用途（如锚点）不参与解析，路径仍取 `#` 之前的部分。
 * 本应用自己定义 `#page=` 语法（Markdown 图片语法没法带页参数，只能借片段）。
 */
export function parseDiagramRef(src: string): { path: string; page: string } {
  const raw = String(src || '')
  const hash = raw.indexOf('#')
  if (hash < 0) return { path: raw, page: '' }
  const path = raw.slice(0, hash)
  const frag = raw.slice(hash + 1).trim()
  const m = PAGE_FRAGMENT_RE.exec(frag)
  const spec = m ? m[1].trim() : /^\d+$/.test(frag) ? frag : ''
  if (!spec) return { path, page: '' }
  try {
    return { path, page: decodeURIComponent(spec) }
  } catch {
    return { path, page: spec }
  }
}

/** 页定位 → 页序号（0 起）；解析不出来返回 -1（调用方回退为"渲染全部页"） */
function resolvePageIndex(spec: string, pages: Array<{ id: string; name: string }>, total: number): number {
  const s = String(spec || '').trim()
  if (!s) return -1
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    if (n >= 1 && n <= total) return n - 1
    log(`页定位超出范围（共 ${total} 页），改为渲染全部页:`, s)
    return -1
  }
  const lower = s.toLowerCase()
  const hit = pages.find((p) => p.name.trim().toLowerCase() === lower || p.id.toLowerCase() === lower)
  if (!hit) log('找不到指定的页，改为渲染全部页:', s)
  return hit ? pages.indexOf(hit) : -1
}

/** 载入内容 → 交给 task 取图（同一份图表只喂一次） */
async function runExclusive<T>(xml: string, task: () => Promise<T>, timeout: number): Promise<T> {
  await ensureFrame()
  // 握手完成后再喂内容：drawio 会丢弃 init 之前收到的 load
  await waitInit(timeout)
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      if (pendingLoad && pendingLoad.xml === xml) pendingLoad = null
      const err: any = new Error('drawio 图表渲染超时')
      err.code = 'timeout'
      reject(err)
    }, timeout)
    pendingLoad = { xml, resolve, timer }
    sendLoad(xml)
  })
  return task()
}

/** 编辑器实例还没就绪时的兜底：走内嵌协议的 export 动作（只能取当前页） */
async function svgViaProtocol(timeout: number): Promise<string> {
  const data = await requestExport(
    'svg',
    { scale: 1, border: 8, background: '#ffffff', theme: 'light', asText: true },
    timeout,
  )
  return decodeSvgText(data)
}

/**
 * 图表 XML → 页 SVG 列表（串行队列 + 按页缓存）。
 *
 * - `opts.page` 给出页定位（1 起的序号 / 页名 / 页 id）时**只渲染该页**；
 * - 未给出（或定位无效）时渲染**全部页**，最多 `opts.maxPages` 页；
 * - 多页文件在 drawio 里是"一次只显示一页"，因此逐页 `selectPage` 后各取一张 SVG。
 */
export function renderDiagramPages(
  xml: string,
  opts: { page?: string; maxPages?: number; timeout?: number } = {},
): Promise<DiagramPageSvg[]> {
  const maxPages = Math.max(1, opts.maxPages ?? MAX_DIAGRAM_PAGES)
  const timeout = opts.timeout || (frame ? RENDER_TIMEOUT : BOOT_TIMEOUT)
  const task = () =>
    runExclusive(
      xml,
      async () => {
        const api: any = (currentWindow() as any)?.__aimDrawioImageApi
        const pages: Array<{ index: number; id: string; name: string }> = api?.pages?.() || []
        const total = pages.length || 1
        const nameOf = (i: number) => pages[i]?.name || ''

        const wantIndex = resolvePageIndex(opts.page || '', pages, total)
        if (wantIndex >= 0) {
          let svg = svgCache.get(diagramKey(xml, wantIndex))
          if (!svg) {
            await selectPageAndSettle(wantIndex)
            svg = currentPageSvg() || (await svgViaProtocol(timeout))
            if (!svg) throw new Error('未能获取图表 SVG')
            cacheSvg(xml, wantIndex, svg)
          }
          return [{ index: wantIndex, total, name: nameOf(wantIndex), svg }]
        }

        const limit = Math.min(total, maxPages)
        const out: DiagramPageSvg[] = []
        for (let i = 0; i < limit; i++) {
          let svg = svgCache.get(diagramKey(xml, i))
          if (!svg) {
            // 逐页切换再取图；已在目标页时 selectPageAndSettle 直接返回，不额外等待
            if (!(await selectPageAndSettle(i))) break
            svg = currentPageSvg() || (await svgViaProtocol(timeout))
            if (!svg) break
            cacheSvg(xml, i, svg)
          }
          out.push({ index: i, total, name: nameOf(i), svg })
        }
        if (!out.length) throw new Error('未能获取图表 SVG')
        return out
      },
      timeout,
    )

  // 前一个任务失败不阻断后续（队列尾永远吞掉结果）
  const run = queueTail.then(task, task)
  queueTail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
    .then((pages) => {
      // 渲染期间 drawio 可能又把焦点抢进离屏 iframe（见 releaseStolenFocus）→ 交还宿主
      releaseStolenFocus()
      return pages
    })
    .catch((e) => {
      // 只有超时才可能是渲染器卡死（XML 内容问题不该拖垮后续渲染）
      if (e && (e as any).code === 'timeout') resetFrame()
      throw e
    })
}

/** 图表 XML → 单张 SVG（带缓存；不指定 page 时取第 1 页） */
export async function renderDiagramSvg(xml: string, opts: { page?: string; timeout?: number } = {}): Promise<string> {
  const pages = await renderDiagramPages(xml, { page: opts.page, timeout: opts.timeout, maxPages: 1 })
  if (!pages.length) throw new Error('图表没有可渲染的页')
  return pages[0].svg
}

/** SVG → PNG data URL */
async function svgToPng(svg: string, scale = 2): Promise<DiagramPng> {
  const size = svgLogicalSize(svg)
  if (!size) throw new Error('无法识别图表尺寸')
  const n = clampScale(scale, size.w, size.h)
  return { dataUrl: await drawioSvgToPngDataUrl(svg, n, size), w: size.w, h: size.h }
}

/** 图表 XML → PNG data URL（Word 导出 / 图级导出用） */
export async function renderDiagramPng(xml: string, opts: { scale?: number; page?: string } = {}): Promise<DiagramPng> {
  return svgToPng(await renderDiagramSvg(xml, { page: opts.page }), opts.scale ?? 2)
}

// ==================== 文件读取 / 路径解析 ====================

/**
 * 读取本地图表文件文本。
 * `.drawio` 经平台层按 UTF-8 文本读回（落在「其他扩展名」分支）；
 * 中文 / 空格文件名可能是百分号编码，逐个候选路径尝试（与 readImageAsDataUrl 同策略）。
 */
export async function readDiagramFile(path: string): Promise<string> {
  const raw = String(path || '')
  if (!raw || !hasCapability('fs.pathRead')) return ''
  // 中文 / 空格文件名可能是百分号编码：原样与还原后各试一次
  const candidates = new Set<string>([raw, decodeDiagramPath(raw)])
  for (const cand of candidates) {
    try {
      const r: any = await getPlatform().fs.readText(cand)
      const text =
        typeof r === 'string' ? r : r && typeof r === 'object' && r.success !== false ? String(r.content ?? '') : ''
      if (!text) continue
      if (READ_ERROR_PREFIXES.some((p) => text.startsWith(p))) continue
      return text
    } catch {
      /* 尝试下一个候选 */
    }
  }
  return ''
}

/**
 * 折叠路径里的 `.` / `..`（保留盘符 / UNC / 前导斜杠结构）。
 *
 * 必须做的原因：md 里常写 `../输出/图.drawio`，直接与文件目录拼接会得到
 * `…/报告/../输出/图.drawio` 这种"能读盘但匹配不上"的路径 —— 渲染能读到文件，
 * 点击时 `getInf` 校验却会报「目标文件不存在」（Windows 的 fs 会自行解析 `..`，
 * 但路径字符串比较 / 远程根目录映射不会）。
 */
function collapseDots(p: string): string {
  if (!p || !/(^|\/)\.\.?(\/|$)/.test(p)) return p
  let head = ''
  let rest = p
  if (/^\/\//.test(p)) {
    head = '//'
    rest = p.slice(2)
  } else if (/^[a-zA-Z]:\//.test(p)) {
    head = p.slice(0, 3)
    rest = p.slice(3)
  } else if (p.startsWith('/')) {
    head = '/'
    rest = p.slice(1)
  }
  const out: string[] = []
  for (const part of rest.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else out.push(part)
      continue
    }
    out.push(part)
  }
  return head + out.join('/')
}

/** 相对路径 → 绝对路径（与 inlineLocalImagesAsDataUrls 同一套规则，额外折叠 `.` / `..`） */
export function resolveDiagramPath(src: string, baseDir = ''): string {
  const p = String(src || '').replace(/\\/g, '/')
  if (!p) return ''
  if (/^file:\/\//i.test(p)) return collapseDots(p.replace(/^file:\/\/\/?/i, ''))
  if (/^(?:[a-zA-Z]:[\/]|\/\/|\/)/.test(p)) return collapseDots(p)
  if (!baseDir) return collapseDots(p)
  return collapseDots(baseDir.replace(/\\/g, '/') + p.replace(/^\.\/+/, ''))
}

/**
 * 还原路径里的百分号编码（中文 / 空格 → `%E8%BE%93` / `%20`）。
 * markdown-it 会对链接与图片地址做 URL 规范化，还原后才能用于读取与 `getInf` 校验
 *（与 mdLinkOpen 的 decodePath 同一策略：先 decodeURI，失败再 decodeURIComponent）。
 */
export function decodeDiagramPath(p: string): string {
  const s = String(p || '')
  if (!/%[0-9a-fA-F]{2}/.test(s)) return s
  try {
    return decodeURI(s)
  } catch {
    try {
      return decodeURIComponent(s)
    } catch {
      return s
    }
  }
}

/**
 * 把已渲染 HTML 里的 `.md-drawio-figure`（内嵌图表占位）换成 PNG 图片。
 *
 * 供 Word 导出使用：Word 里存 SVG（尤其带 foreignObject 富文本标签的 drawio SVG）兼容性差，
 * 统一转成 PNG 内嵌 —— 与 mermaid 代码块走同一条思路（见 md-to-docx 的 renderMermaidToImages）。
 * 多页图表按页各出一张图（图注带「第 i / N 页」），与正文里的内嵌策略保持一致；
 * 渲染失败的图表只保留图注，不阻断整篇导出。
 */
export async function replaceDiagramFiguresWithImages(html: string, baseDir = ''): Promise<string> {
  if (!html || typeof document === 'undefined') return html
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return html
  }
  const figures = Array.from(doc.querySelectorAll<HTMLElement>('.md-drawio-figure'))
  if (!figures.length) return html
  for (const fig of figures) {
    const src = fig.getAttribute('data-drawio-path') || ''
    const pageSpec = fig.getAttribute('data-drawio-page') || ''
    const body = fig.querySelector<HTMLElement>('.md-drawio-body')
    try {
      const path = resolveDiagramPath(parseDiagramRef(src).path, baseDir)
      if (!path) throw new Error('图表路径为空')
      const xml = await readDiagramFile(path)
      if (!xml) throw new Error('读取图表失败')
      const pages = await renderDiagramPages(xml, { page: pageSpec, maxPages: MAX_DIAGRAM_PAGES })
      if (!pages.length) throw new Error('图表没有可渲染的页')

      const altText = (fig.querySelector('figcaption')?.textContent || '').trim()
      const makeImg = (p: DiagramPng) => {
        const img = doc.createElement('img')
        img.setAttribute('src', p.dataUrl)
        img.setAttribute('alt', '')
        img.setAttribute('width', String(p.w))
        img.setAttribute('height', String(p.h))
        return img
      }

      if (pages.length === 1) {
        // 单页（或显式指定了页）：保持一个 figure，占位容器换成图片
        const png = await svgToPng(pages[0].svg, 2)
        const caption = fig.querySelector<HTMLElement>('figcaption')
        const img = makeImg(png)
        if (body) body.replaceWith(img)
        else if (caption) fig.insertBefore(img, caption)
        else fig.appendChild(img)
        continue
      }

      // 多页：每页一张图 + 页码图注
      const wraps = doc.createElement('div')
      wraps.className = 'md-drawio-pages'
      for (const [i, page] of pages.entries()) {
        const pageFig = doc.createElement('figure')
        pageFig.className = 'md-drawio-figure'
        pageFig.appendChild(makeImg(await svgToPng(page.svg, 2)))
        const cap = doc.createElement('figcaption')
        const label = `第 ${page.index + 1} / ${page.total} 页`
        cap.textContent = i === 0 && altText ? `${altText} · ${label}` : label
        pageFig.appendChild(cap)
        wraps.appendChild(pageFig)
      }
      if (pages.length < (pages[0]?.total || pages.length)) {
        const note = doc.createElement('p')
        note.textContent = `（共 ${pages[0].total} 页，其余页请在图表编辑器中查看）`
        wraps.appendChild(note)
      }
      fig.replaceWith(wraps)
    } catch (e) {
      console.warn('[drawioRender] 图表导出为图片失败:', src, e)
      body?.remove()
    }
  }
  return doc.body ? doc.body.innerHTML : html
}

/** 释放离屏 iframe（测试 / 热重载用；正常使用无需调用） */
export function disposeDiagramRenderer(): void {
  resetFrame()
  initWaiters = []
  svgCache.clear()
}
