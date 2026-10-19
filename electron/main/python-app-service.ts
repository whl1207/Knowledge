/**
 * python-app-service.ts — 「按安装目录拉起本地 Python 应用」的通用进程管理
 *
 * 背景：这套应用要接两个**独立安装的 Python 服务**，它们原本都只能手动双击各自的 bat：
 *   • qwen3tts  ：Qwen3-TTS-AllinOne（Gradio 7862 + FastAPI 直连接口 9880，app.py）
 *   • qwenImage ：Qwen-Image-Edit-2511（Gradio 7861 + 内置 ComfyUI 8187，app.py）
 * 这里把「校验目录 → 复刻 bat 的环境变量 → spawn python -s app.py → 收日志 → 退出时收进程」
 * 抽成一份实现，按 id 各管一个进程；设置页只填「安装目录」并点启动。
 *
 * 只启动/停止**本应用**拉起的进程：目录里已在跑的服务（手动开的 bat、别的程序开的）不接管、不杀。
 *
 * IPC（同一组通道，用 id 区分服务）：
 *   python-app:check  { id, dir } → { ok, python?, appPy?, error? }
 *   python-app:start  { id, dir } → { ok, pid?, alreadyRunning?, external?, error? }
 *   python-app:stop   { id }      → { ok, error? }
 *   python-app:status { id }      → { running, pid?, dir?, startedAt?, logTail?, lastExit? }
 */

import { ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection } from 'node:net'
import { existsSync } from 'node:fs'
import { join, delimiter, sep } from 'node:path'

export type PythonAppId = 'qwen3tts' | 'qwenImage'

interface AppSpec {
  id: PythonAppId
  /** 展示名（错误信息里用） */
  label: string
  /** 根目录的典型样子（错误提示里给例子） */
  example: string
  /** 这些端口任一在监听 = 已有服务在跑（不重复拉起） */
  ports: number[]
  /** 额外的环境变量（相对安装目录解析） */
  extraEnv: Record<string, string>
  /** 额外日志提示（启动较慢的服务给一句预期） */
  hint?: string
}

const SPECS: Record<PythonAppId, AppSpec> = {
  qwen3tts: {
    id: 'qwen3tts',
    label: 'Qwen3-TTS',
    example: 'D:\\AI\\Qwen3-TTS-AllinOne',
    ports: [7862, 9880],
    extraEnv: {},
    hint: '首次启动要加载模型，约 20~60 秒',
  },
  qwenImage: {
    id: 'qwenImage',
    label: 'Qwen-Image-Edit',
    example: 'D:\\AI\\Qwen-Image-Edit-2511',
    // 7861 = Gradio 页面，8187 = 它内置的 ComfyUI
    ports: [7861, 8187],
    extraEnv: {
      MODELSCOPE_CACHE: 'ms_download',
      SOX_PATH: 'py312\\sox-14-4-2',
    },
    hint: '要先等内置 ComfyUI 起来，首次启动可能要 1~3 分钟',
  },
}

/** 日志环形缓冲行数（只保留最近输出，用于设置页展示失败原因） */
const LOG_LINES = 160

interface AppState {
  child: ChildProcess | null
  dir: string
  startedAt: number
  lastExit: { code: number | null; at: number } | null
  log: string[]
}

const states: Record<PythonAppId, AppState> = {
  qwen3tts: { child: null, dir: '', startedAt: 0, lastExit: null, log: [] },
  qwenImage: { child: null, dir: '', startedAt: 0, lastExit: null, log: [] },
}

function stateOf(id: PythonAppId): AppState {
  return states[id] || (states[id] = { child: null, dir: '', startedAt: 0, lastExit: null, log: [] })
}

function pushLog(st: AppState, line: string): void {
  const text = String(line || '').replace(/\r$/, '')
  if (!text.trim()) return
  st.log.push(text.length > 500 ? `${text.slice(0, 500)}…` : text)
  if (st.log.length > LOG_LINES) st.log.splice(0, st.log.length - LOG_LINES)
}

function logTail(st: AppState, lines = 40): string {
  return st.log.slice(-lines).join('\n')
}

function isRunning(st: AppState): boolean {
  return !!st.child && st.child.exitCode === null && !st.child.killed
}

/** 目录校验：找 app.py 与 python.exe */
export function checkPythonAppDir(id: PythonAppId, dirRaw: string): { ok: boolean; python?: string; appPy?: string; error?: string } {
  const spec = SPECS[id] || SPECS.qwen3tts
  const dir = String(dirRaw || '').trim()
  if (!dir) return { ok: false, error: `未设置安装目录（例如 ${spec.example}）` }
  if (!existsSync(dir)) return { ok: false, error: `目录不存在：${dir}` }
  const appPy = join(dir, 'app.py')
  if (!existsSync(appPy)) {
    return { ok: false, error: `${dir} 里没有 app.py —— 请选择 ${spec.label} 的根目录（含 py312 与 app.py）` }
  }
  const pythonCandidates = [
    join(dir, 'py312', 'python.exe'),
    join(dir, 'python.exe'),
    join(dir, '.venv', 'Scripts', 'python.exe'),
  ]
  const python = pythonCandidates.find(p => existsSync(p))
  if (!python) {
    return {
      ok: false,
      error: `${dir} 里没找到 python.exe（应有 py312\\python.exe）；可直接双击目录里的启动 bat 手动启动`,
      appPy,
    }
  }
  return { ok: true, python, appPy }
}

/** 端口是否已在监听（用来判断「已有服务在跑」） */
function isPortOpen(port: number, host = '127.0.0.1', timeoutMs = 800): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const done = (v: boolean) => {
      if (settled) return
      settled = true
      try { sock.destroy() } catch { /* ignore */ }
      resolve(v)
    }
    const sock = createConnection({ port, host })
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

/** 复刻各自启动 bat 里的环境变量（共用部分 + 该服务的 extraEnv） */
function buildEnv(dir: string, spec: AppSpec): NodeJS.ProcessEnv {
  const py = join(dir, 'py312')
  const env: NodeJS.ProcessEnv = { ...process.env }
  env.PYTHONHOME = ''
  env.PYTHONPATH = ''
  env.PYTHONIOENCODING = 'utf-8'
  env.GRADIO_TEMP_DIR = join(dir, 'tmp') + sep
  env.FFMPEG_PATH = join(py, 'ffmpeg', 'bin')
  env.TORCH_HOME = join(dir, 'cache')
  env.HF_ENDPOINT = 'https://hf-mirror.com'
  env.HF_HOME = join(dir, 'hf_download')
  env.CUDA_HOME = join(py, 'Library')
  for (const [key, rel] of Object.entries(spec.extraEnv || {})) {
    env[key] = join(dir, rel)
  }
  const pathParts = [py, join(py, 'Scripts'), env.FFMPEG_PATH, env.SOX_PATH, env.PATH || '']
  env.PATH = pathParts.filter(Boolean).join(delimiter)
  return env
}

export async function startPythonApp(id: PythonAppId, dirRaw: string): Promise<{
  ok: boolean
  pid?: number
  alreadyRunning?: boolean
  external?: boolean
  error?: string
}> {
  const spec = SPECS[id]
  const st = stateOf(id)
  const dir = String(dirRaw || '').trim()
  if (isRunning(st)) return { ok: true, pid: st.child?.pid, alreadyRunning: true }

  const check = checkPythonAppDir(id, dir)
  if (!check.ok || !check.python) return { ok: false, error: check.error }

  // 已经有服务在监听（多半是手动开的 bat / 上一次外部启动）：不重复拉起
  for (const port of spec.ports) {
    if (await isPortOpen(port)) {
      return { ok: true, alreadyRunning: true, external: true }
    }
  }

  st.log.length = 0
  pushLog(st, `[启动] ${check.python} -s app.py  (cwd=${dir})`)
  if (spec.hint) pushLog(st, `[提示] ${spec.hint}`)
  let proc: ChildProcess
  try {
    proc = spawn(check.python, ['-s', 'app.py'], {
      cwd: dir,
      env: buildEnv(dir, spec),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err: any) {
    return { ok: false, error: `启动失败：${err?.message || err}` }
  }

  st.child = proc
  st.dir = dir
  st.startedAt = Date.now()
  st.lastExit = null

  const bind = (stream: NodeJS.ReadableStream | null, tag: string) => {
    if (!stream) return
    stream.setEncoding('utf8')
    let buf = ''
    stream.on('data', (chunk: string) => {
      buf += chunk
      let idx = buf.indexOf('\n')
      while (idx >= 0) {
        pushLog(st, `${tag} ${buf.slice(0, idx)}`)
        buf = buf.slice(idx + 1)
        idx = buf.indexOf('\n')
      }
      if (buf.length > 4000) {
        pushLog(st, `${tag} ${buf}`)
        buf = ''
      }
    })
  }
  bind(proc.stdout, '[out]')
  bind(proc.stderr, '[err]')

  proc.on('error', (err) => {
    pushLog(st, `[error] ${err?.message || err}`)
  })
  proc.on('exit', (code, signal) => {
    st.lastExit = { code, at: Date.now() }
    pushLog(st, `[退出] code=${code ?? 'null'} signal=${signal ?? 'null'}`)
    if (st.child === proc) {
      st.child = null
      st.startedAt = 0
    }
  })

  return { ok: true, pid: proc.pid }
}

export async function stopPythonApp(id: PythonAppId): Promise<{ ok: boolean; error?: string }> {
  const st = stateOf(id)
  const proc = st.child
  if (!proc || proc.exitCode !== null) {
    st.child = null
    st.startedAt = 0
    return { ok: true }
  }
  const pid = proc.pid
  try {
    if (process.platform === 'win32' && pid) {
      // python 会拉起子进程（ComfyUI / ffmpeg），按进程树杀掉
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.on('exit', () => resolve())
        killer.on('error', () => resolve())
      })
    } else {
      proc.kill('SIGTERM')
    }
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) }
  }
  // 等最多 8s 让进程真正退出（ComfyUI 子进程收得慢一些）
  const deadline = Date.now() + 8000
  while (Date.now() < deadline && st.child && st.child.exitCode === null) {
    await new Promise(r => setTimeout(r, 150))
  }
  const stillRunning = !!st.child && st.child.exitCode === null
  if (!stillRunning) {
    st.child = null
    st.startedAt = 0
  }
  return stillRunning ? { ok: false, error: '进程没有退出（可能仍有生成任务在跑），稍后再试' } : { ok: true }
}

export function pythonAppStatus(id: PythonAppId): {
  running: boolean
  pid?: number
  dir?: string
  startedAt?: number
  logTail?: string
  lastExit?: { code: number | null; at: number } | null
} {
  const st = stateOf(id)
  return {
    running: isRunning(st),
    pid: st.child?.pid,
    dir: st.dir || undefined,
    startedAt: st.startedAt || undefined,
    logTail: logTail(st),
    lastExit: st.lastExit,
  }
}

function normalizeId(v: any): PythonAppId {
  return v === 'qwenImage' ? 'qwenImage' : 'qwen3tts'
}

export function registerPythonAppIpc(): void {
  ipcMain.handle('python-app:check', async (_e, payload: { id: string; dir: string }) =>
    checkPythonAppDir(normalizeId(payload?.id), payload?.dir))
  ipcMain.handle('python-app:start', async (_e, payload: { id: string; dir: string }) =>
    startPythonApp(normalizeId(payload?.id), payload?.dir))
  ipcMain.handle('python-app:stop', async (_e, payload: { id: string }) =>
    stopPythonApp(normalizeId(payload?.id)))
  ipcMain.handle('python-app:status', async (_e, payload: { id: string }) =>
    pythonAppStatus(normalizeId(payload?.id)))
}

/** 应用退出：只收本应用拉起的进程 */
export function disposePythonApps(): void {
  for (const id of Object.keys(states) as PythonAppId[]) {
    const st = states[id]
    const proc = st.child
    if (!proc || proc.exitCode !== null) continue
    try {
      if (process.platform === 'win32' && proc.pid) {
        spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        proc.kill('SIGTERM')
      }
    } catch { /* ignore */ }
    st.child = null
    st.startedAt = 0
  }
}
