// electron/main/shell-service.ts
// Shell 命令执行服务（对齐 DSH 的 `bash` / `pwsh` 执行器语义）。
//
// 与旧实现（`child_process.exec`）的区别：
// - **非零退出不是错误**：拿到退出码就返回结果，由调用方 / 模型解读；
// - **输出有上限**：单流超过 INLINE_MAX_BYTES 就边跑边落盘，内存里只留尾部窗口；
// - **超时 / 取消会杀进程树**（Windows 用 taskkill /T，POSIX 用进程组）；
// - **支持后台运行**：`startShell` 返回可观察的句柄，前台超时可以被"转成后台任务"
//   （DSH 的 promoteOnTimeout），而不是直接杀掉；
// - **可选方言**：Windows 上 cmd / powershell，POSIX 上 sh / bash。
//
// 安全门槛不在这里：调用方（tools.ts / plugin-host / IPC）先解析沙箱策略。
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { TextDecoder } from 'node:util'
import { asUint8 } from './buffer-view'
import { createSpillSink, type SpillSink } from './tool-spill'

/** 默认超时 */
export const SHELL_DEFAULT_TIMEOUT_MS = 120_000
/** 单次前台调用的超时上限 */
export const SHELL_MAX_TIMEOUT_MS = 600_000
/** 单流内联上限：超过就落盘，模型只看尾部 */
const INLINE_MAX_BYTES = 256 * 1024
/** 落盘后模型可见的尾部窗口 */
const TAIL_MAX_BYTES = 64 * 1024

/** 支持的 shell 方言 */
export type ShellKind = 'cmd' | 'powershell' | 'sh' | 'bash'

// 智能解码：优先 UTF-8（现代程序/PowerShell），失败回退 GBK（Windows cmd 本地化消息），最后 latin1
// 解决 Windows 下 cmd 内建命令（如 dir、ls 不存在时的错误消息）输出 GBK 导致乱码的问题
function decodeOutput(buf: Buffer | undefined | null): string {
  if (!buf || buf.length === 0) return ''
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(asUint8(buf))
  } catch {
    try {
      return new TextDecoder('gbk').decode(asUint8(buf))
    } catch {
      return buf.toString('latin1')
    }
  }
}

/** 一条流的采集器：内存里只留尾部；超限后把**完整内容**边产生边写进 spill 文件 */
class StreamCapture {
  private chunks: Buffer[] = []
  private bytes = 0
  private tail: Buffer[] = []
  private tailBytes = 0
  private sink: SpillSink | null = null
  private spillTried = false
  private spillFailed = false

  constructor(
    private readonly sessionId: string,
    private readonly fileName: string,
  ) {}

  push(chunk: Buffer): void {
    this.bytes += chunk.length
    this.pushTail(chunk)

    if (!this.spillTried && this.bytes > INLINE_MAX_BYTES) {
      this.spillTried = true
      this.sink = createSpillSink(this.sessionId, this.fileName)
      if (this.sink) {
        for (const c of this.chunks) this.sink.write(c)
        this.chunks = []
      } else {
        // 落盘不可用：只保留尾部，明确告知完整输出拿不到（绝不谎称已保存）
        this.spillFailed = true
        this.chunks = []
      }
    }
    if (this.sink) this.sink.write(chunk)
    else if (!this.spillFailed) this.chunks.push(chunk)
  }

  private pushTail(chunk: Buffer): void {
    this.tail.push(chunk)
    this.tailBytes += chunk.length
    while (this.tailBytes > TAIL_MAX_BYTES && this.tail.length > 1) {
      const dropped = this.tail.shift()!
      this.tailBytes -= dropped.length
    }
    if (this.tail.length === 1 && this.tailBytes > TAIL_MAX_BYTES) {
      const only = this.tail[0]
      this.tail[0] = only.subarray(only.length - TAIL_MAX_BYTES)
      this.tailBytes = this.tail[0].length
    }
  }

  finish(): { text: string; truncated: boolean; path?: string } {
    const truncated = !!this.sink || this.spillFailed
    if (this.sink) {
      const saved = this.sink.close()
      this.sink = null
      return { text: decodeOutput(Buffer.concat(this.tail)), truncated: true, path: saved?.path }
    }
    if (this.spillFailed) return { text: decodeOutput(Buffer.concat(this.tail)), truncated: true }
    return { text: decodeOutput(Buffer.concat(this.chunks)), truncated, path: undefined }
  }
}

/** 杀掉整棵进程树（Windows 的 cmd 会拉起子进程，只 kill shell 会留孤儿） */
function killProcessTree(child: ChildProcess | null | undefined): void {
  if (!child || !child.pid) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
  } catch {
    /* 进程已经退出：忽略 */
  }
}

export interface ShellExecutionResult {
  /** 是否拿到了正常的结果（**不代表退出码为 0**）；spawn 失败时 error 有值 */
  success: boolean
  stdout: string
  stderr: string
  exitCode?: number
  /** 被信号终止时的信号名 */
  signal?: string
  timedOut: boolean
  aborted: boolean
  /** 输出超过内联上限、完整内容已落盘 */
  truncated: boolean
  /** 完整输出的落盘路径（stdout / stderr 各一个） */
  truncatedPaths: string[]
  /** 运行目录 */
  cwd: string
  /** 实际使用的 shell */
  shell: ShellKind
  executionTime: number
  error?: string
}

export interface ShellExecutionOptions {
  /** 工作目录（调用方已解析成绝对路径） */
  cwd?: string
  /** 前台超时毫秒（默认 120s，上限 10 分钟）；后台运行不设执行超时 */
  timeoutMs?: number
  /** 协作取消（turn 取消 / 工具超时） */
  signal?: AbortSignal
  /** 归属会话（决定 spill 子目录） */
  sessionId?: string
  /** 方言：Windows 默认 cmd，POSIX 默认 sh */
  shellKind?: ShellKind
}

/** 解析方言参数（不合法时给出可选值） */
export function resolveShellKind(
  raw: unknown,
  platform: NodeJS.Platform = process.platform,
): { ok: true; kind: ShellKind } | { ok: false; error: string } {
  const isWin = platform === 'win32'
  const allowed: ShellKind[] = isWin ? ['cmd', 'powershell'] : ['sh', 'bash']
  const text = String(raw ?? '').trim().toLowerCase()
  if (!text) return { ok: true, kind: isWin ? 'cmd' : 'sh' }
  if (!allowed.includes(text as ShellKind)) {
    return { ok: false, error: `shell 参数只支持 ${allowed.join(' / ')}（当前平台 ${platform}）；收到 ${text}` }
  }
  return { ok: true, kind: text as ShellKind }
}

function buildSpawnArgs(kind: ShellKind, command: string): { file: string; args: string[] } {
  switch (kind) {
    case 'powershell':
      return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] }
    case 'bash':
      return { file: '/bin/bash', args: ['-c', command] }
    case 'cmd':
      return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
    case 'sh':
    default:
      return { file: '/bin/sh', args: ['-c', command] }
  }
}

/** 一个正在运行的命令：可观察输出、等待退出、杀进程树 */
export interface ShellRun {
  readonly pid?: number
  readonly kind: ShellKind
  /** 进程是否已退出 */
  readonly exited: boolean
  /** 订阅输出（解码后的文本；订阅前产生的输出不会补发） */
  onOutput(cb: (stream: 'stdout' | 'stderr', text: string) => void): void
  /** 等待退出（可多次调用，返回同一个 promise） */
  waitExit(): Promise<ShellExecutionResult>
  /** 杀掉整棵进程树 */
  killTree(): void
}

/**
 * 起一条命令，立即返回句柄（**不设超时**；超时策略由调用方决定：杀掉或转后台）。
 */
export function startShell(command: string, opts: ShellExecutionOptions = {}): ShellRun {
  const started = Date.now()
  const cwd = opts.cwd || process.cwd()
  const kind = opts.shellKind || (process.platform === 'win32' ? 'cmd' : 'sh')
  const sessionId = String(opts.sessionId || 'shell')

  const captureOut = new StreamCapture(sessionId, 'shell-stdout.txt')
  const captureErr = new StreamCapture(sessionId, 'shell-stderr.txt')
  const listeners: Array<(stream: 'stdout' | 'stderr', text: string) => void> = []
  let exited = false
  let spawnError = ''
  let settled: (r: ShellExecutionResult) => void = () => { /* 占位：下面 Promise 构造时替换 */ }
  const done = new Promise<ShellExecutionResult>((resolve) => { settled = resolve })

  const { file, args } = buildSpawnArgs(kind, command)
  const child = spawn(file, args, {
    cwd,
    env: process.env,
    windowsHide: true,
    // POSIX 上建独立进程组，超时才能整组杀掉
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const emit = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
    if (!listeners.length) return
    const text = decodeOutput(chunk)
    for (const cb of listeners) {
      try { cb(stream, text) } catch { /* 订阅方异常不影响进程 */ }
    }
  }

  child.stdout?.on('data', (chunk: Buffer) => { captureOut.push(chunk); emit('stdout', chunk) })
  child.stderr?.on('data', (chunk: Buffer) => { captureErr.push(chunk); emit('stderr', chunk) })

  const finish = (exitCode?: number, signal?: string) => {
    if (exited) return
    exited = true
    const out = captureOut.finish()
    const err = captureErr.finish()
    const result: ShellExecutionResult = {
      success: !spawnError,
      stdout: out.text,
      stderr: err.text,
      exitCode,
      signal,
      timedOut: false,
      aborted: false,
      truncated: out.truncated || err.truncated,
      truncatedPaths: [out.path, err.path].filter((p): p is string => !!p),
      cwd,
      shell: kind,
      executionTime: Date.now() - started,
      ...(spawnError ? { error: spawnError } : {}),
    }
    ;(settled)(result)
  }

  child.on('error', (err: Error) => {
    spawnError = err?.message || String(err)
    finish(undefined, undefined)
  })
  child.on('close', (code, signal) => {
    finish(typeof code === 'number' ? code : undefined, signal || undefined)
  })

  return {
    get pid() { return child.pid },
    kind,
    get exited() { return exited },
    onOutput(cb) { listeners.push(cb) },
    waitExit() { return done },
    killTree() { killProcessTree(child) },
  }
}

/**
 * 前台执行（带超时与取消）：超时 / 取消都会杀掉整棵进程树并返回已有输出。
 *
 * 需要"超时后继续跑"（DSH 的 promoteOnTimeout）请直接用 `startShell` + 自己的计时器。
 */
export async function executeCommand(
  command: string,
  opts: ShellExecutionOptions = {},
): Promise<ShellExecutionResult> {
  const timeoutMs = Math.min(
    SHELL_MAX_TIMEOUT_MS,
    Math.max(1000, Math.floor(Number(opts.timeoutMs) || SHELL_DEFAULT_TIMEOUT_MS)),
  )
  const run = startShell(command, opts)
  let timedOut = false
  let aborted = false

  const timer = setTimeout(() => {
    if (run.exited) return
    timedOut = true
    run.killTree()
  }, timeoutMs)
  if (typeof (timer as any).unref === 'function') (timer as any).unref()

  const onAbort = () => {
    if (run.exited) return
    aborted = true
    run.killTree()
  }
  if (opts.signal?.aborted) {
    aborted = true
    run.killTree()
  } else {
    opts.signal?.addEventListener('abort', onAbort, { once: true })
  }

  const result = await run.waitExit()
  clearTimeout(timer)
  try { opts.signal?.removeEventListener('abort', onAbort) } catch { /* 忽略 */ }
  return { ...result, timedOut, aborted }
}

export class ShellService {
  executeCommand(command: string, opts: ShellExecutionOptions = {}): Promise<ShellExecutionResult> {
    return executeCommand(command, opts)
  }
}

export const shellService = new ShellService()
