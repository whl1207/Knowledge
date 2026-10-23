/**
 * system-dictation.ts — 系统级听写：把识别文本粘贴进「当前前台应用」。
 *
 * 为什么用剪贴板中转：
 *   Windows / Linux 上跨应用输入最兼容的方式就是「写剪贴板 + 模拟 Ctrl+V」。
 *   它不需要原生 Node 模块，中文、emoji、长文本都比逐字符 SendInput 稳。
 *   代价是短暂占用剪贴板；默认会在粘贴完成后恢复原内容（设置里可关）。
 *
 * 平台实现：
 *   · Windows：常驻一个隐藏的 PowerShell 进程，Add-Type 调 user32!SendInput。
 *     不用每次现编译（首次约 0.5~1s），也不会弹黑框。
 *   · Linux：优先 xdotool（X11），失败再试 wtype（wlroots / 部分 Wayland）。
 *     两者都没有时，文本会留在剪贴板并返回明确错误，用户可手动 Ctrl+V。
 *
 * 注意：本模块只负责「粘贴」。是否启用、是否恢复剪贴板由渲染层配置经 IPC 传入。
 */
import { clipboard } from 'electron'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** 模拟粘贴后等目标应用读走剪贴板，再恢复原内容（太早会粘出旧内容） */
const RESTORE_DELAY_MS = 600
/** 首次 PowerShell 调用要编译 Add-Type，给足时间；后续命令会快很多 */
const FIRST_PASTE_TIMEOUT_MS = 7000
const PASTE_TIMEOUT_MS = 3000

export interface InjectResult {
  success: boolean
  /** 失败时文本是否已留在剪贴板（用户可手动粘贴） */
  copied?: boolean
  error?: string
}

export interface SystemDictationStatus {
  supported: boolean
  platform: string
  backend?: string
  error?: string
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 在 PATH 里找一个可执行文件（Windows 额外试 .exe/.cmd/.bat） */
function findExecutable(name: string): string {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const dirs = String(process.env.PATH || '').split(delimiter).filter(Boolean)
  for (const rawDir of dirs) {
    const dir = rawDir.replace(/^"|"$/g, '')
    for (const ext of exts) {
      const full = join(dir, name + ext)
      try {
        if (existsSync(full)) return full
      } catch { /* 忽略无权限目录 */ }
    }
  }
  return ''
}

/** 读取剪贴板里常见的几种格式（恢复时一次性写回） */
function readClipboardSnapshot(): Electron.Data {
  const data: Electron.Data = {}
  try {
    const text = clipboard.readText()
    if (text) data.text = text
  } catch { /* 某些平台无此格式 */ }
  try {
    const html = clipboard.readHTML()
    if (html) data.html = html
  } catch { /* 忽略 */ }
  try {
    const rtf = clipboard.readRTF()
    if (rtf) data.rtf = rtf
  } catch { /* 忽略 */ }
  try {
    const image = clipboard.readImage()
    if (image && !image.isEmpty()) data.image = image
  } catch { /* 忽略 */ }
  try {
    const bookmark = clipboard.readBookmark()
    if (bookmark && (bookmark.url || bookmark.title)) data.bookmark = bookmark
  } catch { /* 忽略 */ }
  return data
}

function restoreClipboardSnapshot(data: Electron.Data): void {
  try {
    if (Object.keys(data).length) clipboard.write(data)
    else clipboard.clear()
  } catch { /* 恢复失败不影响已经粘贴出去的文字 */ }
}

// ==================== Windows：常驻 PowerShell + SendInput ====================

/**
 * PowerShell 脚本：编译一次 Win32 的 SendInput，然后从 stdin 逐行收 JSON 命令。
 * 用 -EncodedCommand 传脚本，避免命令行引号转义问题；窗口隐藏，不闪黑框。
 */
const WINDOWS_HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
# 让 JSON 结果按 UTF-8 输出：Windows PowerShell 5.1 默认用控制台代码页，
# 中文错误信息经 Node 按 UTF-8 解码会变乱码。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AikmInput {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint dwFlags;
    public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags;
    public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion U; }

  const uint INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_KEYUP = 2;

  static bool Key(ushort vk, bool up) {
    INPUT input = new INPUT();
    input.type = INPUT_KEYBOARD;
    input.U.ki.wVk = vk;
    input.U.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
    return SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))) == 1;
  }

  public static bool CtrlV() {
    // UIPI can block synthetic input for elevated target windows; SendInput returns 0.
    bool ok = Key(0x11, false); // Ctrl down
    ok = Key(0x56, false) && ok; // V down
    ok = Key(0x56, true) && ok;  // V up
    ok = Key(0x11, true) && ok;  // Ctrl up
    return ok;
  }

  public static bool ModifiersDown() {
    return (GetAsyncKeyState(0x11) & 0x8000) != 0
      || (GetAsyncKeyState(0x10) & 0x8000) != 0
      || (GetAsyncKeyState(0x12) & 0x8000) != 0
      || (GetAsyncKeyState(0x5B) & 0x8000) != 0
      || (GetAsyncKeyState(0x5C) & 0x8000) != 0;
  }
}
"@
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $out = @{ ok = $false; error = 'no result' }
  try {
    $msg = $line | ConvertFrom-Json
    if ($msg.op -eq 'paste') {
      # 用户可能还按着 Ctrl/Shift/Alt/Win（例如快捷键 Ctrl+Shift+F9）：
      # 等它们松开再发 Ctrl+V，否则会变成 Ctrl+Shift+V 之类的组合。
      $deadline = [DateTime]::UtcNow.AddMilliseconds(1000)
      while ([AikmInput]::ModifiersDown() -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 20
      }
      if ([AikmInput]::ModifiersDown()) {
        # 修饰键还按着：这时发 Ctrl+V 会变成 Ctrl+Shift+V 等组合，宁可失败也不要粘错
        $out = @{ ok = $false; error = '快捷键仍处于按下状态，请松开后重试' }
      } elseif ([AikmInput]::CtrlV()) {
        $out = @{ ok = $true }
      } else {
        $out = @{ ok = $false; error = 'SendInput 被系统拒绝（目标窗口可能以管理员权限运行）' }
      }
    } elseif ($msg.op -eq 'ping') {
      $out = @{ ok = $true }
    } else {
      $out = @{ ok = $false; error = 'unknown op' }
    }
  } catch {
    $out = @{ ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
`

class WindowsPasteHelper {
  private proc: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private stderr = ''
  private hasPastedOnce = false
  private pending: {
    resolve: (result: { ok: boolean; error?: string }) => void
    timer: NodeJS.Timeout
  } | null = null

  private ensureProc(): ChildProcessWithoutNullStreams | null {
    if (this.proc && !this.proc.killed) return this.proc
    const fallback = join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
    )
    const exe = findExecutable('powershell.exe') || (existsSync(fallback) ? fallback : '')
    if (!exe) return null
    try {
      const encoded = Buffer.from(WINDOWS_HELPER_SCRIPT, 'utf16le').toString('base64')
      const proc = spawn(exe, [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden',
        '-EncodedCommand', encoded,
      ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk: string) => this.onStdout(chunk))
      proc.stderr.setEncoding('utf8')
      proc.stderr.on('data', (chunk: string) => {
        this.stderr = String(chunk || '').slice(-800)
      })
      this.proc = proc
      proc.on('error', (err: Error) => {
        this.stderr = err?.message || String(err)
        this.failPending(this.stderr)
        if (this.proc === proc) this.proc = null
      })
      proc.on('exit', () => {
        if (this.proc === proc) this.proc = null
        this.failPending(this.stderr || 'PowerShell helper exited')
      })
      return proc
    } catch (e: any) {
      this.stderr = String(e?.message || e)
      return null
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '').trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line) as { ok?: boolean; error?: string }
        if (msg.ok) this.resolvePending({ ok: true })
        else this.resolvePending({ ok: false, error: msg.error || 'paste failed' })
      } catch {
        // Add-Type 的编译提示可能混进 stdout；不当作命令结果
      }
    }
  }

  private resolvePending(result: { ok: boolean; error?: string }): void {
    const pending = this.pending
    if (!pending) return
    this.pending = null
    if (result.ok) this.hasPastedOnce = true
    clearTimeout(pending.timer)
    pending.resolve(result)
  }

  private failPending(error: string): void {
    this.resolvePending({ ok: false, error })
  }

  async paste(): Promise<{ ok: boolean; error?: string }> {
    const proc = this.ensureProc()
    if (!proc) return { ok: false, error: this.stderr || '未找到 powershell.exe' }
    if (this.pending) return { ok: false, error: '上一条粘贴命令还在执行' }
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending = null
        resolve({ ok: false, error: '等待 Windows 粘贴助手超时' })
      }, this.hasPastedOnce ? PASTE_TIMEOUT_MS : FIRST_PASTE_TIMEOUT_MS)
      this.pending = { resolve, timer }
      try {
        proc.stdin.write(JSON.stringify({ op: 'paste' }) + '\n')
      } catch (e: any) {
        this.pending = null
        clearTimeout(timer)
        resolve({ ok: false, error: String(e?.message || e) })
      }
    })
  }

  /** 提前拉起并编译 Add-Type（设置页/首次状态查询时调用，避免第一次听写等 1 秒） */
  prewarm(): void {
    this.ensureProc()
  }

  dispose(): void {
    this.failPending('helper disposed')
    try { this.proc?.kill() } catch { /* 忽略 */ }
    this.proc = null
  }
}

// ==================== Linux：xdotool / wtype ====================

interface RunResult { code: number | string; stdout: string; stderr: string }

function runCommand(cmd: string, args: string[], timeout = 2500): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err: any, stdout, stderr) => {
      const code = err
        ? (typeof err.code === 'number' || typeof err.code === 'string' ? err.code : 1)
        : 0
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

/** 终端里 Ctrl+V 通常不是粘贴（而是字面量），要换成 Ctrl+Shift+V */
async function linuxPaste(): Promise<{ ok: boolean; error?: string }> {
  // 先问一下当前窗口类名，终端类应用换用 Ctrl+Shift+V
  let terminal = false
  const active = await runCommand('xdotool', ['getactivewindow', 'getwindowclassname'], 1200)
  if (active.code === 0) {
    terminal = /(term|konsole|xterm|alacritty|kitty|wezterm|tilix|terminator|guake|yakuake)/i
      .test(active.stdout)
  }

  const xdoKey = terminal ? 'ctrl+shift+v' : 'ctrl+v'
  const xdo = await runCommand('xdotool', ['key', '--clearmodifiers', xdoKey], 2200)
  if (xdo.code === 0) return { ok: true }

  // Wayland（wlroots 等）没有 xdotool 时试 wtype
  const wtypeArgs = terminal
    ? ['-M', 'ctrl', '-M', 'shift', '-k', 'v', '-m', 'shift', '-m', 'ctrl']
    : ['-M', 'ctrl', '-k', 'v', '-m', 'ctrl']
  const wtype = await runCommand('wtype', wtypeArgs, 2200)
  if (wtype.code === 0) return { ok: true }

  const err = [
    xdo.stderr && `xdotool: ${xdo.stderr.trim()}`,
    wtype.stderr && `wtype: ${wtype.stderr.trim()}`,
  ].filter(Boolean).join(' | ')
  return {
    ok: false,
    error: err || '无法模拟粘贴：请安装 xdotool（X11）或 wtype（Wayland）',
  }
}

// ==================== 对外接口 ====================

const winHelper = process.platform === 'win32' ? new WindowsPasteHelper() : null
let lastStatus: { at: number; value: SystemDictationStatus } | null = null

/** 系统级听写是否可用（结果缓存 30s，避免设置页/状态栏反复探测） */
export async function systemDictationStatus(): Promise<SystemDictationStatus> {
  const now = Date.now()
  if (lastStatus && now - lastStatus.at < 30_000) return lastStatus.value

  let value: SystemDictationStatus
  if (process.platform === 'win32') {
    const ok = !!findExecutable('powershell.exe')
    value = ok
      ? { supported: true, platform: 'win32', backend: 'powershell' }
      : { supported: false, platform: 'win32', error: '未找到 powershell.exe / powershell.exe not found' }
  } else if (process.platform === 'linux') {
    if (findExecutable('xdotool')) value = { supported: true, platform: 'linux', backend: 'xdotool' }
    else if (findExecutable('wtype')) value = { supported: true, platform: 'linux', backend: 'wtype' }
    else value = {
      supported: false,
      platform: 'linux',
      error: '未找到 xdotool（X11）或 wtype（Wayland）。安装其一后即可在其它应用里自动粘贴。 / Install xdotool (X11) or wtype (Wayland) to paste into other apps.',
    }
  } else {
    value = { supported: false, platform: process.platform, error: '仅支持 Windows / Linux' }
  }
  // 提前编译 Add-Type：第一次真正听写时就不用再等 PowerShell 启动
  if (value.supported && winHelper) winHelper.prewarm()
  lastStatus = { at: now, value }
  return value
}

/**
 * 把一段文本粘贴到当前前台应用。
 * @param text 识别结果
 * @param opts.restoreClipboard 粘贴后是否恢复剪贴板原内容（默认 true）
 */
async function injectOne(
  text: string,
  opts: { restoreClipboard?: boolean } = {},
): Promise<InjectResult> {
  const value = String(text ?? '')
  if (!value) return { success: false, error: '没有可输入的文字' }

  const snapshot = readClipboardSnapshot()
  try {
    clipboard.writeText(value)
  } catch (e: any) {
    return { success: false, error: `写入剪贴板失败：${e?.message || e}` }
  }

  let result: { ok: boolean; error?: string }
  try {
    if (process.platform === 'win32') {
      if (!winHelper) result = { ok: false, error: 'Windows 粘贴助手不可用' }
      else result = await winHelper.paste()
    } else if (process.platform === 'linux') {
      result = await linuxPaste()
    } else {
      result = { ok: false, error: '仅支持 Windows / Linux' }
    }
  } catch (e: any) {
    result = { ok: false, error: String(e?.message || e) }
  }

  if (!result.ok) {
    // 失败时不要把文字也一起恢复掉：留在剪贴板，用户至少能手动粘贴
    return { success: false, copied: true, error: result.error }
  }

  await sleep(RESTORE_DELAY_MS)
  if (opts.restoreClipboard !== false) {
    try {
      // 只有剪贴板仍是这次听写的文字时才恢复，避免覆盖用户在这期间复制的新内容。
      // Windows 剪贴板会把 \n 规范成 \r\n，比较前先统一换行。
      const now = clipboard.readText()
      const same = now === value
        || now.replace(/\r\n/g, '\n') === value.replace(/\r\n/g, '\n')
      if (same) restoreClipboardSnapshot(snapshot)
    } catch { /* 忽略 */ }
  }
  return { success: true }
}

// 流式引擎可能在一个会话里连续落定多句：串行执行，避免前一条还在等剪贴板时
// 后一条被 Windows 助手以「忙」拒绝（那样后一句就只能退回复制到剪贴板）。
let injectQueue: Promise<unknown> = Promise.resolve()

export function injectSystemText(
  text: string,
  opts: { restoreClipboard?: boolean } = {},
): Promise<InjectResult> {
  const run = () => injectOne(text, opts)
  const result = injectQueue.then(run, run)
  injectQueue = result.catch(() => undefined)
  return result
}

/** 应用退出时结束常驻 PowerShell 助手 */
export function disposeSystemDictation(): void {
  winHelper?.dispose()
}
