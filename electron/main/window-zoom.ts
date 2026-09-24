/**
 * 全局窗口缩放（zoomFactor）
 * ---------------------------------------------------------------------------
 * 软件内**所有**窗口（主窗口 / 设置独立窗口 / 文件窗口 / 浏览器 Agent 窗口 …）共用同一个缩放比例：
 *  · 单一事实源在本模块，比例持久化到 userData/window-zoom.json；
 *  · 任一窗口调整（设置页输入、Ctrl +/-、Ctrl+滚轮）都会立即同步到全部窗口，
 *    并广播 `window:zoom-changed` 让各窗口的 store.UI.windowZoom 保持一致；
 *  · 新创建的窗口默认自动跟随（app 'browser-window-created' 钩子），隐藏的内部窗口
 *    （网页抓取 / PDF 导出渲染）由创建方调用 excludeFromAppZoom() 排除。
 *
 * ⚠️ 时机（Electron 30 实测）：
 *  · 窗口「加载完成之前」设置 zoomFactor 不生效（导航提交后会回到 100%），因此统一在
 *    dom-ready（早于首帧，避免先闪一下 100%）与 did-finish-load（首帧 / 后续导航）里套用；
 *  · 页面已加载后再设置则立即生效 —— 这是「改一处、所有窗口同步」的路径；
 *  · Chromium 会把同源（file:// 全部视为同一源）缩放持久化到 profile，内部窗口即使不主动
 *    设置也可能被同源继承，因此 excludeFromAppZoom() 会把它们显式压回 100%。
 */
import { app, BrowserWindow } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'

const ZOOM_MIN = 0.5
const ZOOM_MAX = 2.0

/** 缩放比例持久化文件 */
function zoomFilePath(): string {
  return path.join(app.getPath('userData'), 'window-zoom.json')
}

/** 不参与全局缩放的内部窗口（隐藏抓取 / 导出渲染等） */
const noAppZoomWindows = new WeakSet<BrowserWindow>()

/**
 * 当前全局缩放（1 = 100%）。
 * ⚠️ 不能在模块顶层直接读文件：本模块会被 index.ts 导入，而 ESM 的导入求值早于 index.ts 模块体里
 * 那句 dev 专用的 `app.setPath('userData', …-dev)`，彼时读盘会读到「非 dev」目录。故延迟到首次使用。
 */
let zoomFactor: number | null = null

function currentZoom(): number {
  if (zoomFactor === null) zoomFactor = loadSavedZoom()
  return zoomFactor
}

export function clampZoom(factor: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(factor * 100) / 100))
}

function loadSavedZoom(): number {
  try {
    const file = zoomFilePath()
    if (fs.existsSync(file)) {
      const z = JSON.parse(fs.readFileSync(file, { encoding: 'utf8' })).zoom
      if (typeof z === 'number' && isFinite(z)) return clampZoom(z)
    }
  } catch { /* ignore */ }
  return 1
}

function saveZoom(factor: number) {
  try {
    fs.writeFileSync(zoomFilePath(), JSON.stringify({ zoom: clampZoom(factor) }), 'utf8')
  } catch (err) {
    console.warn('[zoom] 保存缩放失败:', err)
  }
}

/** 把当前全局缩放套用到某个窗口 */
function applyZoomToWindow(target: BrowserWindow | null | undefined): void {
  if (!target || target.isDestroyed() || noAppZoomWindows.has(target)) return
  const wc = target.webContents
  if (!wc || wc.isDestroyed()) return
  const z = currentZoom()
  if (wc.zoomFactor !== z) wc.zoomFactor = z
}

/**
 * 内部窗口：不参与全局缩放（并显式压回 100%，抵消同源继承）。
 * 用于隐藏的网页抓取窗口、PDF 导出渲染窗口等 —— 缩放会改变其布局，影响抓取/导出结果。
 * ⚠️ 若该窗口加载的是 file:// 资源（与应用窗口同源），必须给它单独的 webPreferences.partition，
 * 否则「压回 100%」会写到共享的同源缩放表里，把应用窗口的缩放一起拉回 100%（实测）。
 */
export function excludeFromAppZoom(target: BrowserWindow | null | undefined): void {
  if (!target || target.isDestroyed()) return
  noAppZoomWindows.add(target)
  const wc = target.webContents
  if (!wc || wc.isDestroyed()) return
  const reset = () => {
    if (target.isDestroyed() || wc.isDestroyed()) return
    if (wc.zoomFactor !== 1) wc.zoomFactor = 1
  }
  reset()
  wc.on('dom-ready', reset)
  wc.on('did-finish-load', reset)
}

/** 让窗口跟随全局缩放：加载时套用 + 把 Ctrl+滚轮/捏合造成的「局部」缩放收敛为全局比例 */
function registerZoomWindow(target: BrowserWindow): void {
  const wc = target.webContents
  if (!wc || wc.isDestroyed()) return
  const sync = () => applyZoomToWindow(target)
  wc.on('dom-ready', sync)
  wc.on('did-finish-load', sync)
  let timer: NodeJS.Timeout | null = null
  wc.on('zoom-changed', () => {
    if (noAppZoomWindows.has(target)) return
    if (timer) clearTimeout(timer)
    // 等本次局部缩放生效后再读取，作为新的全局比例同步给所有窗口
    timer = setTimeout(() => {
      timer = null
      if (target.isDestroyed() || wc.isDestroyed()) return
      const f = Math.round(wc.zoomFactor * 100) / 100
      if (f === currentZoom()) { applyZoomToWindow(target); return }
      setGlobalZoom(f)
    }, 120)
  })
}

/** 当前全局缩放（1 = 100%） */
export function getGlobalZoom(): number {
  return currentZoom()
}

/** 「全局缩放已变化」回调：供需要按 zoom 换算布局的模块使用（如浏览器 Agent 的原生视图区） */
const zoomAppliedCallbacks = new Set<() => void>()

/** 注册「全局缩放已变化」回调（返回取消注册函数） */
export function onGlobalZoomApplied(cb: () => void): () => void {
  zoomAppliedCallbacks.add(cb)
  return () => { zoomAppliedCallbacks.delete(cb) }
}

/** 设置全局缩放并同步到所有窗口（设置页输入 / Ctrl+± / Ctrl+滚轮 共用入口） */
export function setGlobalZoom(factor: number): number {
  const z = clampZoom(factor)
  zoomFactor = z
  saveZoom(z)
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || noAppZoomWindows.has(w)) continue
    try {
      const wc = w.webContents
      if (!wc || wc.isDestroyed()) continue
      if (wc.zoomFactor !== z) wc.zoomFactor = z
      wc.send('window:zoom-changed', { factor: z })
    } catch { /* 窗口可能正在销毁 */ }
  }
  for (const cb of zoomAppliedCallbacks) {
    try { cb() } catch (err) { console.warn('[zoom] 缩放回调失败:', err) }
  }
  return z
}

/** 在当前全局缩放上步进（Ctrl + = / Ctrl + -） */
export function stepZoom(delta: number): number {
  return setGlobalZoom(currentZoom() + delta)
}

// 所有新窗口默认跟随全局缩放（主窗口 / 设置窗口 / 文件窗口 / 浏览器 Agent 窗口 …），
// 隐藏的内部窗口由创建方调用 excludeFromAppZoom() 排除
app.on('browser-window-created', (_event, newWin) => {
  if (noAppZoomWindows.has(newWin)) return
  registerZoomWindow(newWin)
})
