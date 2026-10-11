/**
 * MCP 工具调用（`tool` 与 `ai-km-mcp` 共用）
 *
 * 参数值支持三种写法：字面量、`[节点, 变量]` 数组引用、`{{#节点.变量#}}` 模板串。
 */
import { mcpManager } from '@/platform/mcpManager'
import { resolveSelector, stringifyValue } from '../../template'
import type { NodeExecutionContext } from '../../types'

export interface McpServerConfigLike {
  mode?: 'inline' | 'server'
  server_id?: string
  transport?: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string | string[]
  env?: Record<string, string> | string
  server_url?: string
}

/** 解析参数对象里的变量引用 */
export function resolveToolParameters(
  ctx: NodeExecutionContext,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const parameters: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value) && value.length >= 2 && typeof value[0] === 'string') {
      parameters[key] = resolveSelector(value as string[], ctx.pool)
      continue
    }
    if (typeof value === 'string' && value.trim().startsWith('{{#')) {
      const match = value.trim().match(/^\{\{#([^#{}]+)#\}\}$/)
      const segments = match ? match[1].split('.') : []
      parameters[key] = segments.length >= 2 ? resolveSelector(segments, ctx.pool) : value
      continue
    }
    parameters[key] = value
  }
  return parameters
}

export interface McpCallParams {
  serverConfig: McpServerConfigLike
  serverId?: string
  toolName: string
  parameters: Record<string, unknown>
  timeoutMs?: number
}

/** 连接 → 调用 → 断开；返回文本与可能的 JSON 结果 */
export async function callMcpTool(
  ctx: NodeExecutionContext,
  params: McpCallParams,
): Promise<{ text: string; json?: unknown }> {
  const connKey = `wf-mcp-${ctx.nodeId}`
  const serverId = params.serverId || params.serverConfig.server_id || undefined

  ctx.log('info', `连接 MCP 服务${serverId ? `（${serverId}）` : ''}`)
  const connected = await mcpManager.connect(connKey, params.serverConfig ?? {}, serverId)
  if (!connected) throw new Error('MCP 服务连接失败，请检查服务配置')

  try {
    ctx.log('info', `调用工具 ${params.toolName}，参数 ${JSON.stringify(params.parameters).slice(0, 200)}`)
    const result = await mcpManager.callTool(connKey, params.toolName, params.parameters, serverId, params.timeoutMs ?? 120000)
    if (!result?.success) throw new Error(String(result?.error || '工具调用失败'))
    const payload = result.data ?? ''
    return {
      text: stringifyValue(payload),
      json: typeof payload === 'object' && payload !== null ? payload : undefined,
    }
  } finally {
    await mcpManager.disconnect(connKey, serverId).catch(() => {})
  }
}
