/**
 * voice-overlay.ts — 系统级听写的悬浮提示窗。
 *
 * 为什么必须是**独立窗口**：系统级听写时主窗口通常在后台 / 托盘里，应用内的
 * VoiceInputOverlay 根本不可见。这里开一个无边框、透明、置顶、不抢焦点的小窗，
 * 加载同一个渲染入口的 #/voice-overlay 分支，复用应用内浮层的 Visual 样式。
 *
 * 关键约束：
 *   · 只能 showInactive()，绝不能 show()/focus()：一旦抢走前台，粘贴就会粘到我们自己窗口里；
 *   · setIgnoreMouseEvents(true)：整窗鼠标穿透，既不挡下面应用的操作，也不会因为点击而获得焦点；
 *   · focusable:false + skipTaskbar:true：不出现在任务栏，不参与 Alt+Tab。
 */
import { BrowserWindow, screen } from 'electron'
import { DEV_SERVER_URL, INDEX_HTML, resolvePreload } from './run-mode'

let overlayWin: BrowserWindow | null = null
let overlayVisible = false
let lastState: any = null

function overlayHash(): string {
  return '/voice-overlay'
}

/** 把窗口摆到鼠标所在屏幕的底部居中（多显示器时跟随鼠标） */
function positionOverlay(w: BrowserWindow): void {
  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const area = display.workArea
    const width = Math.min(600, Math.max(320, area.width - 32))
    const height = 180
    const x = Math.round(area.x + (area.width - width) / 2)
    const y = Math.round(area.y + area.height - height - 24)
    w.setBounds({ x, y, width, height })
  } catch { /* 屏幕信息拿不到时沿用默认位置 */ }
}

/** 惰性创建；窗口只创建一次，后续 show/hide 复用 */
export function ensureVoiceOverlayWindow(): BrowserWindow | null {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin
  try {
    const w = new BrowserWindow({
      width: 600,
      height: 180,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      show: false,
      hasShadow: false,
      webPreferences: {
        preload: resolvePreload(),
        webSecurity: false,
        backgroundThrottling: false,
      },
    })
    overlayWin = w
    // 置顶到屏保级：普通置顶可能被其它 alwaysOnTop 窗口压住
    try { w.setAlwaysOnTop(true, 'screen-saver') } catch { /* Linux 可能不支持该 level */ }
    try { w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) } catch { /* 忽略 */ }
    try { w.setFocusable(false) } catch { /* 忽略 */ }
    try { w.setSkipTaskbar(true) } catch { /* 忽略 */ }
    // 整窗穿透：不挡鼠标、不因点击抢焦点
    try { w.setIgnoreMouseEvents(true, { forward: true }) } catch { try { w.setIgnoreMouseEvents(true) } catch { /* 忽略 */ } }

    w.on('closed', () => {
      if (overlayWin === w) {
        overlayWin = null
        overlayVisible = false
      }
    })
    w.webContents.on('did-finish-load', () => {
      if (lastState) {
        try { w.webContents.send('voice:overlay-state', lastState) } catch { /* 忽略 */ }
      }
      if (overlayVisible && !w.isDestroyed()) {
        try { w.showInactive() } catch { /* 忽略 */ }
      }
    })

    const hash = overlayHash()
    if (DEV_SERVER_URL) w.loadURL(`${DEV_SERVER_URL}#${hash}`)
    else w.loadFile(INDEX_HTML, { hash })
    return w
  } catch (e) {
    console.error('[voice-overlay] create failed:', e)
    return null
  }
}

/** 主进程收到渲染层的语音状态后调用：决定显示 / 隐藏 / 转发 */
export function updateVoiceOverlay(state: any): void {
  lastState = state || null
  const phase = String(state?.phase || 'idle')
  const show = state?.mode === 'system' && (phase !== 'idle' || !!state?.notice)
  if (!show) {
    if (overlayWin && !overlayWin.isDestroyed() && overlayVisible) {
      try { overlayWin.hide() } catch { /* 忽略 */ }
      overlayVisible = false
    }
    return
  }

  const w = ensureVoiceOverlayWindow()
  if (!w || w.isDestroyed()) return
  positionOverlay(w)
  const send = () => {
    try { w.webContents.send('voice:overlay-state', state) } catch { /* 窗口可能正在销毁 */ }
  }
  if (w.webContents.isLoading()) {
    w.webContents.once('did-finish-load', () => {
      if (w.isDestroyed()) return
      // 加载期间会话可能已经结束（开始后立刻取消）：以**当前**状态为准，别把已过期的面板弹出来
      if (!lastState || lastState.mode !== 'system') return
      if (lastState.phase === 'idle' && !lastState.notice) return
      send()
      if (!w.isDestroyed()) {
        try { w.showInactive(); overlayVisible = true } catch { /* 忽略 */ }
      }
    })
  } else {
    send()
    if (!overlayVisible || !w.isVisible()) {
      try { w.showInactive(); overlayVisible = true } catch { /* 忽略 */ }
    }
  }
}

/** 供主进程判断「当前聚焦窗口是不是我们的悬浮窗」 */
export function isVoiceOverlayWindow(win: BrowserWindow | null | undefined): boolean {
  return !!win && !!overlayWin && !overlayWin.isDestroyed() && win === overlayWin
}

export function disposeVoiceOverlay(): void {
  if (overlayWin && !overlayWin.isDestroyed()) {
    try { overlayWin.destroy() } catch { /* 忽略 */ }
  }
  overlayWin = null
  overlayVisible = false
  lastState = null
}
