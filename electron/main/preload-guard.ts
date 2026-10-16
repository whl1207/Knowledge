/**
 * preload-guard.ts — 「这个窗口的首份文档到底跑没跑 preload」的握手 + 自助恢复
 *
 * 背景（2026-10 实测，Electron 42.11.12）：
 * 只要**首个文档提交之前**有脚本上下文落到该帧的「初始空文档」上，Electron ≤42 就会在那份空文档上
 * 把沙箱化 preload bundle 用掉，并把这一帧记成「已注入」——于是**真正提交的文档永远不会执行 preload**。
 * 它不报错、不触发 `preload-error`，渲染层只是拿不到 `window.__aikmClaimIpcBridge`：
 * 界面静默退化成网页模式（没有窗口壳、没有桌面能力），**重新加载一次就恢复正常**。
 * 触发条件很日常，而且都是「开发态才会做的事」：
 *  · `win.loadURL()` 之后紧接着 `openDevTools()` —— DevTools 的 `Runtime.enable` 会碰这份空文档；
 *  · 任何在首帧提交前连上来的 CDP 客户端（`--remote-debugging-port`、自动化脚本、爬虫式探针）。
 * 上游修复：https://github.com/electron/electron/pull/54155（dev 里我们没法保证用户不提早开 DevTools，
 * 所以这里做一层兜底；窗口创建处也顺手把 openDevTools 推迟到 did-navigate，见 index.ts）。
 *
 * 做法：
 *  1. `registerPreloadHandshake()` 收 preload 末尾发来的 `preload:loaded`（见 electron/preload/index.ts）；
 *  2. `guardPreload(win)` 在**每次主框架导航开始**时清掉该窗口的握手记录，`did-finish-load` 时若仍没收到
 *     就重载一次；第二次仍没有只报错、不再重载（避免死循环）。
 *
 * ⚠️ 握手记录按 `webContents.id` 存：窗口销毁后 id 不会被复用（Electron 单调递增）。
 */
import { ipcMain, type BrowserWindow } from 'electron'
import { logError, logWarn } from './log'

/** 已经收到过 preload 就绪握手的 webContents id（按导航粒度清理，见 guardPreload） */
const readyWebContents = new Set<number>()

let registered = false

/** 注册握手接收端（幂等；连接 app ready 之前调用即可，模块导入时自动调用一次） */
export function registerPreloadHandshake(): void {
  if (registered) return
  registered = true
  ipcMain.on('preload:loaded', (event) => {
    readyWebContents.add(event.sender.id)
  })
}

/**
 * 给窗口挂上「首份文档必须跑过 preload」的兜底（窗口创建后立即调用）。
 * 只有 preload 真的执行完才会发握手，所以「没收到」等价于「这份文档的 preload 没跑」。
 */
export function guardPreload(target: BrowserWindow): void {
  registerPreloadHandshake()
  const wcId = target.webContents.id
  let retried = false

  // 每次主框架导航（含 reload）开始都先清掉，避免上一份文档的握手让这一份蒙混过关
  target.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) readyWebContents.delete(wcId)
  })

  target.webContents.on('did-finish-load', () => {
    if (target.isDestroyed() || readyWebContents.has(wcId)) return
    if (retried) {
      logError('preload', 'still no preload handshake after one reload — the renderer will run in web mode. '
        + 'Check that dist-electron/preload/index.cjs exists and that the preload itself does not throw.')
      return
    }
    retried = true
    logWarn('preload', 'this document finished loading without running the preload '
      + '(Electron <=42 consumes the preload on the initial empty document when DevTools/CDP touches it '
      + 'before the first commit) — reloading once')
    target.webContents.reload()
  })
}
