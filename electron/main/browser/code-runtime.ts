/**
 * code-runtime.ts — `browser_run` 脚本运行时（一轮脚本做多步，对应 ego-lite 的 "code round"）
 *
 * 模型写一段 JS，脚本里的 `browser.*` 直接同步/异步调用浏览器动作，最后返回/打印结果。
 * 与逐个工具调用相比，多步任务只产生一次模型往返。
 *
 * 安全边界：
 * - 用 `node:vm` 上下文 + `codeGeneration.strings=false`（禁掉脚本内 eval / new Function），
 *   不注入 require / process / fs；但与《run_code》相同属"信任模型代码"级别，
 *   不是强沙箱。真正的强隔离应放 utilityProcess（P3）。
 * - 超时只覆盖 await 点（脚本里的死循环无法中断，和所有 VM 方案一样）；每个 browser.* 调用前检查取消。
 */
import vm from 'node:vm'

export interface BrowserCodeRunResult {
  result: any
  logs: string[]
  timedOut: boolean
}

export type BrowserCodeApi = Record<string, (...args: any[]) => Promise<any>>

export async function runBrowserCode(
  code: string,
  api: BrowserCodeApi,
  opts: { timeoutMs?: number; signal?: AbortSignal; onTimeout?: () => void } = {},
): Promise<BrowserCodeRunResult> {
  const source = String(code || '').trim()
  if (!source) throw new Error('缺少 code 参数（脚本内容）')
  const logs: string[] = []
  const timeoutMs = Math.max(1_000, Math.min(120_000, Number(opts.timeoutMs) || 60_000))
  let aborted = false
  const abort = () => {
    aborted = true
    try { opts.onTimeout?.() } catch { /* 忽略 */ }
  }
  if (opts.signal) {
    if (opts.signal.aborted) abort()
    else opts.signal.addEventListener('abort', abort, { once: true })
  }
  const timer = setTimeout(abort, timeoutMs)

  const pushLog = (...args: any[]) => {
    if (logs.length >= 200) return
    const line = args.map(format).join(' ')
    logs.push(line.length > 2000 ? `${line.slice(0, 2000)}…` : line)
  }

  // 每个 API 方法执行前检查取消（脚本里长任务会在下一个 await 处停下）
  const guarded: BrowserCodeApi = {}
  for (const [name, fn] of Object.entries(api)) {
    guarded[name] = async (...args: any[]) => {
      if (aborted) throw new Error('脚本已超时/取消')
      const out = await fn(...args)
      if (aborted) throw new Error('脚本已超时/取消')
      return out
    }
  }

  const sandbox: Record<string, any> = {
    browser: guarded,
    console: { log: pushLog, info: pushLog, warn: pushLog, error: pushLog },
    sleep: async (ms: number) => {
      const wait = Math.max(0, Math.min(60_000, Number(ms) || 0))
      const end = Date.now() + wait
      while (Date.now() < end) {
        if (aborted) throw new Error('脚本已超时/取消')
        await new Promise((r) => setTimeout(r, Math.min(100, end - Date.now())))
      }
    },
    JSON, Math, Date, Promise, Array, Object, String, Number, Boolean, RegExp, Map, Set, Error,
  }
  const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } })
  const wrapped = `(async () => {\n${source}\n})()`
  const script = new vm.Script(wrapped, { filename: 'browser_run.js' })
  let result: any
  let timedOut = false
  try {
    const value = script.runInContext(ctx, { timeout: Math.min(timeoutMs, 10_000) })
    result = await Promise.race([
      value,
      new Promise((_, reject) => {
        const check = setInterval(() => {
          if (!aborted) return
          clearInterval(check)
          reject(new Error('脚本超时/取消'))
        }, 100)
        value.finally(() => clearInterval(check)).catch(() => clearInterval(check))
      }),
    ])
  } catch (err: any) {
    if (aborted) {
      timedOut = true
      throw new Error(`脚本执行超时/取消（${Math.round(timeoutMs / 1000)}s）`)
    }
    throw err
  } finally {
    clearTimeout(timer)
    try { opts.signal?.removeEventListener('abort', abort) } catch { /* 忽略 */ }
  }
  return { result: toPlain(result), logs, timedOut }
}

function format(v: any): string {
  if (typeof v === 'string') return v
  try { return JSON.stringify(v) } catch { return String(v) }
}

/** 脚本返回值必须是可序列化数据（避免把 DOM/对象代理带出 VM） */
function toPlain(v: any): any {
  if (v === undefined || v === null) return v
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
}
