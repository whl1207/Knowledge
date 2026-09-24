/**
 * LM Studio CLI（lms）桥 —— 加载 / 卸载本地模型。
 *
 * 为什么走命令行：LM Studio 的 REST API 只提供推理与模型清单
 * （`GET /api/v0/models` 有 type / state / loaded_context_length），**不提供加载 / 卸载**
 * （`POST /api/v0/models/load` 会返回 "Unexpected endpoint or method"），
 * 官方给出的方式就是随 LM Studio 一起安装的 `lms` 命令
 * （`lms load <model>` / `lms unload <identifier>`，也正是「No models loaded」报错里提示的 `lms load`）。
 *
 * 本模块只依赖 Node（不 import electron），可独立测试；超时、隐藏黑窗、错误文案都在这里收口。
 */
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** 单次命令默认超时：加载大模型（几十 GB）可能要好几分钟 */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

export interface LmsRunResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
  /** ok=false 时的可读原因（找不到命令 / 超时 / CLI 输出） */
  error?: string
  lmsPath: string
}

/** 已加载实例（lms ps --json 的裁剪结果） */
export interface LmsLoadedModel {
  /** 卸载时用的标识（与 /api/v0/models 的 id 一致） */
  identifier: string
  modelKey: string
  type: string
  /** idle / processingPrompt … */
  status: string
  /** LM Studio 里设置的、当前实际生效的上下文长度 */
  contextLength: number
  maxContextLength: number
  ttlMs: number | null
  parallel: number | null
}

/**
 * 定位 lms 可执行文件：LMS_PATH 环境变量 > 各平台常见安装路径；
 * 都找不到时返回 null，由调用方交给 PATH 解析（可能仍可用）。
 */
export function resolveLmsPath(): string | null {
  const home = os.homedir()
  const candidates: string[] = [
    String(process.env.LMS_PATH || ''),
    process.platform === 'win32'
      ? path.join(home, '.lmstudio', 'bin', 'lms.exe')
      : path.join(home, '.lmstudio', 'bin', 'lms'),
    path.join(home, '.cache', 'lm-studio', 'bin', 'lms'),
  ].filter(Boolean)
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch { /* 访问受限：继续尝试下一个候选路径 */ }
  }
  return null
}

/** 执行一条 lms 子命令（windowsHide 避免弹黑窗；超时自动终止进程） */
export function runLms(args: string[], timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<LmsRunResult> {
  const lmsPath = resolveLmsPath() || (process.platform === 'win32' ? 'lms.exe' : 'lms')
  return new Promise((resolve) => {
    execFile(
      lmsPath,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: process.env },
      (err: any, stdout: any, stderr: any) => {
        const out = String(stdout || '')
        const errOut = String(stderr || '')
        if (!err) {
          resolve({ ok: true, stdout: out, stderr: errOut, code: 0, lmsPath })
          return
        }
        const code = typeof err.code === 'number' ? err.code : null
        const notFound = err.code === 'ENOENT' || /not recognized|不是内部或外部命令|command not found/i.test(String(err.message || ''))
        const error = notFound
          ? `未找到 LM Studio 命令行（lms）。请在 LM Studio 的 Developer 页安装 CLI，或手动执行：lms ${args.join(' ')}`
          : (err.killed
            ? `命令超时（${Math.round(timeoutMs / 1000)} 秒）：lms ${args.join(' ')}`
            : (errOut.trim() || out.trim() || String(err.message || err)))
        resolve({ ok: false, stdout: out, stderr: errOut, code, error, lmsPath })
      }
    )
  })
}

/**
 * CLI 有时以退出码 0 结束、但输出里写着失败（实测：`lms unload <不存在的标识>`
 * 返回 0 且打印 “Model Not Found / Cannot find a model …”）→ 必须看输出判定。
 */
function detectFailure(text: string): string | null {
  const t = String(text || '')
  if (!t) return null
  if (!/Model Not Found|Cannot find a model|(^|\n)\s*Error[:\s]/i.test(t)) return null
  return t.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 3).join(' ')
}

/** 从 CLI 输出里抠出 JSON 数组（输出可能夹带日志行） */
function parseJsonArray(text: string): any[] {
  const s = String(text || '')
  const start = s.indexOf('[')
  const end = s.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const arr = JSON.parse(s.slice(start, end + 1))
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

/** 已加载实例清单（lms ps --json）：contextLength 即 LM Studio 里设置并生效的上下文长度 */
export async function listLoadedModels(): Promise<{
  ok: boolean
  /** lms 命令是否可用（false = 没装 CLI，加载/卸载按钮应禁用并提示） */
  available: boolean
  lmsPath?: string
  models: LmsLoadedModel[]
  error?: string
}> {
  const res = await runLms(['ps', '--json'], 60000)
  if (!res.ok) {
    const available = !/未找到 LM Studio 命令行/.test(res.error || '')
    return { ok: false, available, lmsPath: res.lmsPath, models: [], error: res.error }
  }
  const models: LmsLoadedModel[] = parseJsonArray(res.stdout)
    .map((m: any): LmsLoadedModel => ({
      identifier: String(m?.identifier || m?.indexedModelIdentifier || m?.modelKey || ''),
      modelKey: String(m?.modelKey || m?.identifier || ''),
      type: String(m?.type || ''),
      status: String(m?.status || ''),
      contextLength: Number(m?.contextLength || 0),
      maxContextLength: Number(m?.maxContextLength || 0),
      ttlMs: m?.ttlMs ?? null,
      parallel: m?.parallel ?? null,
    }))
    .filter((m: LmsLoadedModel) => !!m.identifier)
  return { ok: true, available: true, lmsPath: res.lmsPath, models }
}

export interface LmsActionResult {
  ok: boolean
  action: 'load' | 'unload' | 'unloadAll'
  model?: string
  contextLength?: number
  /** CLI 的完整输出（成功/失败都给，便于排错） */
  output: string
  error?: string
}

/** 加载模型：contextLength > 0 时用 `-c` 指定（对应 LM Studio 加载时的「上下文长度」） */
export async function loadModel(payload: { model?: string; contextLength?: number }): Promise<LmsActionResult> {
  const model = String(payload?.model || '').trim()
  if (!model) return { ok: false, action: 'load', output: '', error: '缺少 model（模型 key）' }
  const ctx = Math.floor(Number(payload?.contextLength || 0))
  const args = ['load', model, '-y']
  if (Number.isFinite(ctx) && ctx > 0) args.push('-c', String(ctx))
  const res = await runLms(args)
  const output = `${res.stdout}${res.stderr}`.trim()
  const fail = detectFailure(output)
  return {
    ok: res.ok && !fail,
    action: 'load',
    model,
    contextLength: ctx > 0 ? ctx : undefined,
    output,
    error: res.error || fail || undefined,
  }
}

/** 卸载模型：identifier 用 /api/v0/models 的 id（与 lms ps 的 identifier 一致）；all=true 卸载全部 */
export async function unloadModel(payload: { model?: string; all?: boolean }): Promise<LmsActionResult> {
  const all = payload?.all === true
  const model = String(payload?.model || '').trim()
  if (!all && !model) return { ok: false, action: 'unload', output: '', error: '缺少 model（要卸载的模型）' }
  const res = await runLms(all ? ['unload', '-a'] : ['unload', model], 3 * 60 * 1000)
  const output = `${res.stdout}${res.stderr}`.trim()
  const fail = detectFailure(output)
  return { ok: res.ok && !fail, action: all ? 'unloadAll' : 'unload', model, output, error: res.error || fail || undefined }
}

/** 统一入口（供 IPC 调用） */
export async function lmStudioCli(payload: { action?: string; model?: string; contextLength?: number; all?: boolean }): Promise<any> {
  switch (String(payload?.action || '')) {
    case 'ps':
      return await listLoadedModels()
    case 'load':
      return await loadModel(payload)
    case 'unload':
      return await unloadModel(payload)
    default:
      return { ok: false, action: payload?.action, output: '', error: `未知操作: ${payload?.action}` }
  }
}
