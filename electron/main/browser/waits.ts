/**
 * waits.ts — 等待原语（替代盲等 sleep）
 *
 * 支持：selector（attached/visible/hidden）、text、url、loadState、
 * function（页面表达式）、networkIdle（Electron isLoading 连续 500ms 静默）。
 * 统一 deadline + 取消信号，超时错误带当前 url/title/readyState，方便模型判断下一步。
 */
import type { WebContents } from 'electron'
import type { CdpSession } from './cdp'

export type WaitKind = 'selector' | 'text' | 'url' | 'loadState' | 'function' | 'networkIdle'

export interface WaitSpec {
  kind: WaitKind
  value?: string
  state?: 'attached' | 'visible' | 'hidden'
  timeoutMs?: number
}

export interface WaitOutcome {
  matched: boolean
  kind: WaitKind
  elapsedMs: number
  url: string
  title: string
}

export class WaitTimeoutError extends Error {
  code = 'WAIT_TIMEOUT' as const
  constructor(message: string) {
    super(message)
    this.name = 'WaitTimeoutError'
  }
}

export async function waitFor(
  cdp: CdpSession,
  wc: WebContents,
  spec: WaitSpec,
  signal?: AbortSignal,
): Promise<WaitOutcome> {
  const timeoutMs = clamp(spec.timeoutMs, 500, 30_000, 10_000)
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  const kind = spec.kind

  const check = async (): Promise<boolean> => {
    if (signal?.aborted) throw new Error('等待已取消')
    if (kind === 'networkIdle') return false // 单独循环
    if (kind === 'loadState') {
      const r = await evaluate(cdp, 'document.readyState')
      const want = String(spec.value || 'complete')
      if (want === 'domcontentloaded') return r === 'interactive' || r === 'complete'
      return r === 'complete'
    }
    if (kind === 'selector') {
      const sel = String(spec.value || '')
      if (!sel) throw new Error('wait_for(selector) 缺少 value（CSS 选择器）')
      const state = spec.state || 'visible'
      const expr = `(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return false;
        if (${JSON.stringify(state)} === 'attached') return true;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const visible = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
        return ${JSON.stringify(state)} === 'hidden' ? !visible : visible;
      })()`
      return (await evaluate(cdp, expr)) === true
    }
    if (kind === 'text') {
      const want = String(spec.value || '')
      if (!want) throw new Error('wait_for(text) 缺少 value')
      return (await evaluate(cdp, `(() => (document.body ? document.body.innerText : '').includes(${JSON.stringify(want)}))()`)) === true
    }
    if (kind === 'url') {
      const want = String(spec.value || '')
      if (!want) throw new Error('wait_for(url) 缺少 value')
      const href = String(await evaluate(cdp, 'location.href') || '')
      if (want.includes('*')) {
        const re = new RegExp(`^${want.split('*').map(escapeRegExp).join('.*')}$`)
        return re.test(href)
      }
      return href.includes(want)
    }
    if (kind === 'function') {
      const expr = String(spec.value || '')
      if (!expr) throw new Error('wait_for(function) 缺少 value（页面表达式）')
      return (await evaluate(cdp, `Boolean(${expr})`)) === true
    }
    return false
  }

  if (kind === 'networkIdle') {
    let quietSince = 0
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('等待已取消')
      if (wc.isDestroyed()) throw new Error('标签已关闭')
      if (wc.isLoading()) quietSince = 0
      else if (!quietSince) quietSince = Date.now()
      else if (Date.now() - quietSince >= 500) {
        return { matched: true, kind, elapsedMs: Date.now() - startedAt, ...(await pageInfo(cdp)) }
      }
      await sleep(100)
    }
  } else {
    while (Date.now() < deadline) {
      try {
        if (await check()) {
          return { matched: true, kind, elapsedMs: Date.now() - startedAt, ...(await pageInfo(cdp)) }
        }
      } catch (err: any) {
        // 导航中 evaluate 失败：继续等（除了取消）
        if (err?.message === '等待已取消') throw err
      }
      await sleep(100)
    }
  }

  const info = await pageInfo(cdp)
  throw new WaitTimeoutError(
    `等待超时（${timeoutMs}ms）：${describe(spec)}。当前页面：${info.url || '(未知)'}${info.title ? ` / ${info.title}` : ''}。`
    + '可换用 browser_snapshot / browser_extract_text 检查页面实际状态，或调大 timeoutMs。'
  )
}

async function evaluate(cdp: CdpSession, expression: string): Promise<any> {
  const r = await cdp.send<any>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, 8_000)
  if (r?.exceptionDetails) {
    throw new Error(`页面表达式执行失败：${r.exceptionDetails.text || 'unknown'}`)
  }
  return r?.result?.value
}

async function pageInfo(cdp: CdpSession): Promise<{ url: string; title: string }> {
  try {
    const v = await evaluate(cdp, '({url: location.href, title: document.title})')
    return { url: String(v?.url || ''), title: String(v?.title || '') }
  } catch {
    return { url: '', title: '' }
  }
}

function describe(spec: WaitSpec): string {
  switch (spec.kind) {
    case 'selector': return `selector ${spec.value}（${spec.state || 'visible'}）`
    case 'text': return `页面文本包含「${spec.value}」`
    case 'url': return `URL 匹配 ${spec.value}`
    case 'loadState': return `页面加载状态 ${spec.value || 'complete'}`
    case 'function': return `页面表达式为真：${spec.value}`
    case 'networkIdle': return '网络空闲 500ms'
    default: return spec.kind
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function clamp(v: unknown, min: number, max: number, def: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, Math.round(n)))
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
