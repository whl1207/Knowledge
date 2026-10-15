// electron/main/terminal-service.ts
/**
 * terminal-service.ts — 主页右侧栏「终端」标签的后端：**真 PTY**（node-pty）
 *
 * 为什么必须是 PTY：终端要的是 TTY —— 颜色 / 光标 / 行编辑，以及 vim、top、交互式提问这类
 * 程序都要求「stdin 是一个终端」。child_process 的管道给不了（现有 shell-service 是缓冲式 exec），
 * 所以这里按 DSH 的做法用 node-pty（N-API 预编译，Windows 走 ConPTY）。
 *
 * 会话模型（与渲染层的「终端」标签一一对应）：
 *   renderer → terminal:create { id, cwd, cols, rows }               起一个 shell
 *   renderer → terminal:write  { id, data }                          键盘输入（含 Ctrl+C 等控制字符）
 *   renderer → terminal:resize { id, cols, rows }                    终端尺寸变化（PTY 才知道换行宽度）
 *   renderer → terminal:kill   { id }                                关闭该标签的 shell
 *   main     → terminal:data   { id, data }                          流式输出（原样 ANSI 字节）
 *   main     → terminal:exit   { id, exitCode, signal }              进程退出
 *
 * 安全：**不看安全策略** —— 终端是人自己敲命令的交互界面（命令由用户当场输入、当场看到结果），
 * 与智能体自动执行 Python/Shell 的「安全策略」是两码事，因此「完全访问」与否都直接放行。
 * 但环境门槛仍在：只有桌面（Electron 主进程）有 node-pty，安卓 / 纯网页 / 远端宿主按能力隐藏入口。
 *
 * 生命周期：会话归属发起它的 webContents；该窗口销毁时一并结束，避免留下孤儿 shell。
 */
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)

interface TerminalSession {
  id: string
  pty: any
  /** 发起会话的 webContents.id（窗口销毁时按它清理） */
  ownerId: number
  cwd: string
  /** 已退出（退出事件已发过，避免重复） */
  exited: boolean
}

const sessions = new Map<string, TerminalSession>()
/** 已经挂过 destroyed 监听的 webContents（只挂一次） */
const watchedOwners = new Set<number>()

// ---------- node-pty 懒加载（预编译二进制缺失时给一条能看懂的提示，而不是整机启动失败） ----------
let ptyModule: any = null
let ptyLoadError = ''
function loadPty(): any {
  if (ptyModule) return ptyModule
  if (ptyLoadError) throw new Error(ptyLoadError)
  try {
    ptyModule = require_('node-pty')
    return ptyModule
  } catch (err: any) {
    ptyLoadError = `终端后端不可用（node-pty 加载失败）：${err?.message || err}`
      + '。Windows / macOS 使用预编译包；Linux 需要本机编译工具链（build-essential + python3）后重装依赖。'
    throw new Error(ptyLoadError)
  }
}

/**
 * 默认 shell：Windows 用 PowerShell（比 cmd 好用得多，且 ConPTY 原生支持），
 * 其它平台用登录 shell（$SHELL 优先，保证用户自己的别名 / PATH 生效）。
 * 可用环境变量 AIKM_TERMINAL_SHELL 覆盖（排查问题用）。
 */
function defaultShell(): { file: string; args: string[] } {
  const override = String(process.env.AIKM_TERMINAL_SHELL || '').trim()
  if (override) return { file: override, args: process.platform === 'win32' ? ['-NoLogo'] : ['-l'] }
  if (process.platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] }
  return { file: String(process.env.SHELL || '/bin/bash'), args: ['-l'] }
}

function send(wc: WebContents | undefined, channel: string, payload: unknown): void {
  try {
    if (wc && !wc.isDestroyed()) wc.send(channel, payload)
  } catch { /* 窗口正在关闭：忽略 */ }
}

/** 该窗口销毁时结束它名下所有终端会话（不留孤儿 shell） */
function watchOwner(wc: WebContents): void {
  if (watchedOwners.has(wc.id)) return
  watchedOwners.add(wc.id)
  wc.once('destroyed', () => {
    watchedOwners.delete(wc.id)
    for (const [id, session] of Array.from(sessions.entries())) {
      if (session.ownerId !== wc.id) continue
      killSession(id)
    }
  })
}

function killSession(id: string): boolean {
  const session = sessions.get(id)
  if (!session) return false
  sessions.delete(id)
  try { session.pty?.kill() } catch { /* 已退出：忽略 */ }
  return true
}

function normalizeId(raw: unknown): string {
  const id = String(raw ?? '').trim()
  return id.slice(0, 120)
}

/** 注册终端 IPC（在主进程启动时调用一次） */
export function registerTerminalIpc(): void {
  ipcMain.handle('terminal:create', async (event: IpcMainInvokeEvent, params: any) => {
    try {
      const id = normalizeId(params?.id)
      if (!id) return { ok: false, error: '缺少终端 id' }

      // 安全策略不是终端的门槛：命令由用户自己在界面里敲，任何档位都放行
      const cwd = String(params?.cwd || '').trim() || process.cwd()

      // 同 id 重复创建（例如标签重挂载）：先把旧会话收掉，保证一个标签只有一个 shell
      killSession(id)

      const pty = loadPty()
      const { file, args } = defaultShell()
      const cols = Math.max(2, Math.min(1000, Math.floor(Number(params?.cols) || 80)))
      const rows = Math.max(2, Math.min(1000, Math.floor(Number(params?.rows) || 24)))

      const child = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      })

      const session: TerminalSession = { id, pty: child, ownerId: event.sender.id, cwd, exited: false }
      sessions.set(id, session)
      watchOwner(event.sender)

      const sender = event.sender
      child.onData((data: string) => send(sender, 'terminal:data', { id, data }))
      child.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
        session.exited = true
        sessions.delete(id)
        send(sender, 'terminal:exit', { id, exitCode, signal })
      })

      return { ok: true, id, shell: file, cwd }
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) }
    }
  })

  ipcMain.handle('terminal:write', async (_event, params: any) => {
    const id = normalizeId(params?.id)
    const session = sessions.get(id)
    if (!session) return { ok: false, error: '终端会话不存在' }
    try {
      session.pty.write(String(params?.data ?? ''))
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) }
    }
  })

  ipcMain.handle('terminal:resize', async (_event, params: any) => {
    const id = normalizeId(params?.id)
    const session = sessions.get(id)
    if (!session) return { ok: false, error: '终端会话不存在' }
    const cols = Math.max(2, Math.min(1000, Math.floor(Number(params?.cols) || 80)))
    const rows = Math.max(2, Math.min(1000, Math.floor(Number(params?.rows) || 24)))
    try {
      session.pty.resize(cols, rows)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) }
    }
  })

  ipcMain.handle('terminal:kill', async (_event, params: any) => {
    const id = normalizeId(params?.id)
    return { ok: killSession(id) }
  })
}

/** 应用退出前结束所有会话（避免残留 shell 进程） */
export function disposeAllTerminals(): void {
  for (const id of Array.from(sessions.keys())) killSession(id)
  watchedOwners.clear()
}
