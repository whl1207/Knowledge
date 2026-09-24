// src/types/mcp.ts
// 渲染进程共享的 MCP 类型定义（设置页 / 工作流 / mcpManager 桥共用）

export type McpTransportType = 'stdio' | 'sse' | 'http'

// 设置中配置的 MCP 服务器（持久化到 localStorage）
export interface McpServerConfig {
  id: string
  name: string
  transport: McpTransportType
  command?: string
  args?: string[] | string
  env?: Record<string, string>
  serverUrl?: string
  headers?: Record<string, string>
  autoConnect?: boolean
  enabled?: boolean // 服务是否启用（设置页开关控制，默认 true；禁用后不在工作流/集群中可选）
  builtin?: boolean // 内置本地服务标记（如浏览器 Agent：进程内 InMemoryTransport 连接主进程 SDK Server）
  timeoutMs?: number // 单次工具调用超时（毫秒）；空 = 默认 60000（设置页以秒填写）
  createdAt?: number
  updatedAt?: number
}

// MCP 工具信息（主进程 listTools 结果）
export interface McpTool {
  name: string
  description: string
  inputSchema: any
  metadata?: {
    serverName?: string
    serverVersion?: string
  }
}

// 生成服务器唯一 ID
export function generateMcpServerId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    /* 降级处理 */
  }
  return `mcp-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
}

// 从服务器配置生成「工作流内联等效」配置（供 mcpManager / 主进程使用）
export function toRuntimeConfig(server: McpServerConfig): McpServerConfig {
  return { ...server, transport: server.transport || 'stdio' }
}
