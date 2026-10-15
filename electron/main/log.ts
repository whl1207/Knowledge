/**
 * log.ts — 主进程控制台日志（默认安静）
 *
 * 为什么要单独一层：
 * 1. 主进程有几十条**启动闲聊**（插件根目录、内置地图包、MCP 端点、访客策略、核心工具数…），
 *    平时对用户只是噪声，真出问题时反而不容易看见错误；
 * 2. Windows 控制台默认按 GBK 解码，UTF-8 的中文日志会变成乱码
 *    （如 `娓呯悊` = 「清理」）——所以这层统一用 ASCII 前缀 + 英文正文。
 *
 * 约定：
 * - `logInfo`  → 默认**不输出**；设 `AIKM_VERBOSE=1`（或启动参数 `--verbose`）才输出；
 * - `logWarn`  → 输出，一行；错误对象用 `shortError()` 压成「CODE: message」，**不打堆栈**；
 * - `logError` → 输出，保留完整错误（真正的异常才需要堆栈）。
 *
 * 需要看完整启动流程时：`AIKM_VERBOSE=1 npm run dev`。
 */

/** 是否输出 INFO 级日志（进程启动后固定，不必每次判断都读 env） */
let verboseCache: boolean | null = null

export function isVerbose(): boolean {
  if (verboseCache !== null) return verboseCache
  const env = String(process.env.AIKM_VERBOSE ?? '').trim().toLowerCase()
  const byEnv = env === '1' || env === 'true' || env === 'yes' || env === 'on'
  const byArgv = process.argv.some((a) => a === '--verbose' || a === '-V')
  verboseCache = byEnv || byArgv
  return verboseCache
}

const prefixOf = (scope: string): string => `[${scope}]`

/** 启动/流程类信息：默认静默（AIKM_VERBOSE=1 才输出） */
export function logInfo(scope: string, message: string, ...rest: unknown[]): void {
  if (!isVerbose()) return
  if (rest.length) console.log(prefixOf(scope), message, ...rest)
  else console.log(prefixOf(scope), message)
}

/** 可恢复的问题：一行输出，错误压成短描述（不打堆栈） */
export function logWarn(scope: string, message: string, err?: unknown, ...rest: unknown[]): void {
  const tail = err === undefined ? '' : ` — ${shortError(err)}`
  if (rest.length) console.warn(prefixOf(scope), message + tail, ...rest)
  else console.warn(prefixOf(scope), message + tail)
}

/** 真异常：保留堆栈，方便排查 */
export function logError(scope: string, message: string, err?: unknown): void {
  if (err === undefined) console.error(prefixOf(scope), message)
  else console.error(prefixOf(scope), message, err)
}

/**
 * 把任意错误压成一行「CODE: message」：
 * - Node 的 fs 错误（EPERM/ENOENT…）优先用 code；
 * - 顺带去掉 Windows `\\?\` 前缀，日志里更好读；
 * - 非 Error（字符串 / undefined）原样转字符串。
 */
export function shortError(err: unknown): string {
  if (err === undefined || err === null) return 'unknown error'
  if (typeof err === 'string') return err.replace(/\\\\\?\\/g, '')
  if (typeof err !== 'object') return String(err)
  const e = err as { code?: unknown; message?: unknown; syscall?: unknown; path?: unknown }
  const code = typeof e.code === 'string' && e.code ? e.code : ''
  const message = typeof e.message === 'string' ? e.message.replace(/\\\\\?\\/g, '') : ''
  if (code && message) return `${code}: ${message}`
  if (code) return code
  if (message) return message
  try { return JSON.stringify(err) } catch { return String(err) }
}
