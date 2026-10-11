/**
 * http-request（HTTP 请求）执行器
 *
 * 渲染进程直接 fetch；输出对齐 Dify：body / status_code / headers / files。
 * 支持 api-key 与 bearer 两种鉴权、json / form-data / raw 三种请求体、超时。
 */
import { resolveSelector, resolveText, stringifyValue } from '../template'
import type { NodeExecutionContext, NodeExecutionResult, WorkflowNodeExecutor } from '../types'

interface HeaderRow {
  key?: string
  value?: string
}

interface BodyRow {
  id?: string
  key?: string
  type?: 'text' | 'file'
  value?: string
  file?: string
}

export const httpRequestExecutor: WorkflowNodeExecutor = {
  type: 'http-request',
  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const data = ctx.node as unknown as Record<string, unknown>

    /** 字段求值：支持 {{#节点.变量#}} 模板与 [节点, 变量] 数组引用，其余按字面量 */
    const resolveField = (value: unknown): string => {
      if (Array.isArray(value) && value.length >= 2 && typeof value[0] === 'string') {
        return stringifyValue(resolveSelector(value as string[], ctx.pool))
      }
      const text = stringifyValue(value)
      if (!text.includes('{{#')) return text
      const { value: resolved, warnings } = resolveText(text, ctx.pool)
      for (const warning of warnings) {
        ctx.log('warning', `变量 ${warning.selector.join('.')} 没有数据，已留空`)
      }
      return resolved
    }

    const url = resolveField(data.url).trim()
    if (!url) throw new Error('请先填写请求地址')

    const method = String(data.method ?? 'get').toUpperCase()
    const headers = new Headers()

    for (const row of toRows<HeaderRow>(data.headers)) {
      if (!row.key) continue
      headers.set(resolveField(row.key), resolveField(row.value))
    }

    // 鉴权（Dify 的 authorization.type: no-auth | api-key）
    const auth = data.authorization as { type?: string; config?: { type?: string; api_key?: string; header?: string } } | undefined
    if (auth?.type === 'api-key' && auth.config?.api_key) {
      const key = resolveField(auth.config.api_key)
      if (auth.config.type === 'bearer') headers.set('Authorization', `Bearer ${key}`)
      else headers.set(resolveField(auth.config.header) || 'X-API-Key', key)
    }

    // 查询参数直接拼在 URL 上
    const query = toRows<HeaderRow>(data.params).filter((row) => row.key)
    const target = new URL(url)
    for (const row of query) target.searchParams.set(resolveField(row.key), resolveField(row.value))

    const bodyConfig = data.body as { type?: string; data?: unknown } | undefined
    let body: BodyInit | undefined
    if (method !== 'GET' && method !== 'HEAD' && bodyConfig?.type && bodyConfig.type !== 'none') {
      if (bodyConfig.type === 'json') {
        const payload: Record<string, unknown> = {}
        for (const row of toRows<BodyRow>(bodyConfig.data)) {
          if (row.key) payload[resolveField(row.key)] = resolveField(row.value)
        }
        headers.set('Content-Type', 'application/json')
        body = JSON.stringify(payload)
      } else if (bodyConfig.type === 'form-data') {
        const form = new FormData()
        for (const row of toRows<BodyRow>(bodyConfig.data)) {
          if (row.key) form.append(resolveField(row.key), resolveField(row.value))
        }
        body = form
      } else if (bodyConfig.type === 'raw-text') {
        body = resolveField(bodyConfig.data)
        if (!headers.has('Content-Type')) headers.set('Content-Type', 'text/plain')
      }
    }

    const timeout = data.timeout as { connect?: number; read?: number; write?: number } | undefined
    const timeoutMs = Math.max(1000, Number(timeout?.read ?? 30000))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    ctx.signal.addEventListener('abort', () => controller.abort(), { once: true })

    ctx.log('info', `${method} ${target.toString()}`)
    try {
      const response = await fetch(target.toString(), { method, headers, body, signal: controller.signal })
      const text = await response.text()
      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, key) => { responseHeaders[key] = value })

      ctx.log('info', `响应 ${response.status}（${text.length} 字符）`)
      if (!response.ok) {
        ctx.log('warning', `HTTP 状态码 ${response.status}`)
      }
      return {
        outputs: {
          body: text,
          status_code: response.status,
          headers: responseHeaders,
          files: [],
        },
      }
    } catch (error) {
      const message = (error as Error)?.name === 'AbortError' ? `请求超时（${timeoutMs}ms）` : (error as Error).message
      throw new Error(`请求失败：${message}`)
    } finally {
      clearTimeout(timer)
    }
  },
}

/** Dify 的 headers/params/body 可能是数组（新版）或「Key: Value」多行文本（旧版），统一成行数组 */
function toRows<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[]
  if (typeof raw === 'string' && raw.trim()) {
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf(':')
        if (index < 0) return { key: line, value: '' } as T
        return { key: line.slice(0, index).trim(), value: line.slice(index + 1).trim() } as T
      })
  }
  return []
}
