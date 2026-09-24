// electron/main/mcp-service.ts
// 主进程 MCP 运行时服务
// 管理 stdio / SSE / streamable HTTP（http）三种传输的 MCP 客户端连接，
// 按 serverId 缓存连接，供设置页与工作流共享复用。
// 配置由渲染进程持有（localStorage），每次调用时传入；本服务按 serverId 维护连接。
//
// 重要：MCP SDK 不能使用静态 import —— 否则 vite 打包主进程时会把 SDK 及其 zod 依赖
// 内联进 bundle，内联后的 zod v4 schema 结构损坏（CallToolRequestSchema 等缺失 _zod/safeParse），
// 触发 "v3Schema.safeParse is not a function" 导致 MCP 工具调用崩溃。
// 因此这里用「变量拼接 + @vite-ignore 的动态 import」在运行时从 node_modules 加载真实 SDK。
import { randomUUID } from 'node:crypto'
import { browserAgentService } from './browser-agent'
import { officeService } from './office/office-service'
import { drawioService } from './drawio/drawio-service'
import { literatureService } from './literature/literature-service'
import { postgresService } from './postgres/postgres-service'

/** 单次 MCP 工具调用默认超时（毫秒）；可由服务配置 timeoutMs 覆盖（设置页可改） */
const DEFAULT_CALL_TIMEOUT_MS = 60000

/**
 * 内置服务注册表：id → 本地 SDK Server 工厂（新增内置服务只需在此登记）。
 * 工厂可选接收该服务的 MCP 配置（builtin-postgres 从 config.env 读取数据库连接信息，
 * 其余内置服务不依赖配置）。
 */
const BUILTIN_SERVERS: Record<string, { createLocalServerPair: (config?: McpServerConfigInput) => Promise<any> }> = {
  'builtin-browser': browserAgentService,
  'builtin-office': officeService,
  'builtin-drawio': drawioService,
  'builtin-literature': literatureService,
  'builtin-postgres': postgresService,
}

/** 运行时懒加载的 MCP SDK 类集合 */
interface McpSdkBundle {
  Client: any
  StdioClientTransport: any
  SSEClientTransport: any
  StreamableHTTPClientTransport: any
}
let mcpSdkCache: McpSdkBundle | null = null

async function getMcpSdk(): Promise<McpSdkBundle> {
  if (mcpSdkCache) return mcpSdkCache
  const base = '@modelcontextprotocol/sdk/client/'
  const [core, stdio, sse, http] = await Promise.all([
    import(/* @vite-ignore */ `${base}index.js`),
    import(/* @vite-ignore */ `${base}stdio.js`),
    import(/* @vite-ignore */ `${base}sse.js`),
    import(/* @vite-ignore */ `${base}streamableHttp.js`),
  ])
  mcpSdkCache = {
    Client: (core as any).Client,
    StdioClientTransport: (stdio as any).StdioClientTransport,
    SSEClientTransport: (sse as any).SSEClientTransport,
    StreamableHTTPClientTransport: (http as any).StreamableHTTPClientTransport,
  }
  return mcpSdkCache
}

export type McpTransportType = 'stdio' | 'sse' | 'http'

// 渲染进程传入的服务器配置（与 src/types/mcp.ts 的 McpServerConfig 对应）
export interface McpServerConfigInput {
  id?: string
  name?: string
  transport: McpTransportType
  command?: string
  args?: string[] | string
  env?: Record<string, string>
  serverUrl?: string
  headers?: Record<string, string>
  autoConnect?: boolean
  /** 内置本地服务标记（如浏览器 Agent）：不走外部网络，用进程内 InMemoryTransport 连接主进程 SDK Server */
  builtin?: boolean
  /** 单次工具调用超时（毫秒）；空 = 默认 60000 */
  timeoutMs?: number
}

export interface McpToolInfo {
  name: string
  description: string
  inputSchema: any
}

export interface McpCallResult {
  success: boolean
  data?: any
  error?: string
  details?: any
  raw?: any
}

interface McpConnection {
  serverId: string
  serverName: string
  config: McpServerConfigInput
  client: any
  transport: any
  status: 'connecting' | 'connected' | 'disconnected' | 'error'
  error?: string
  tools?: McpToolInfo[]
}

export type McpStatusPayload = {
  serverId: string
  serverName?: string
  status: string
  tools?: McpToolInfo[]
  error?: string
}

class McpRuntimeService {
  private connections = new Map<string, McpConnection>()
  private pending = new Map<string, Promise<McpConnection>>()
  private broadcast: ((payload: McpStatusPayload) => void) | null = null
  private stopping = false

  /** 主进程窗口创建后由 index.ts 注入广播回调（向渲染进程推送状态） */
  setBroadcast(fn: (payload: McpStatusPayload) => void): void {
    this.broadcast = fn
  }

  private emit(payload: McpStatusPayload): void {
    try {
      this.broadcast?.(payload)
    } catch (err) {
      console.error('[mcp] broadcast error', err)
    }
  }

  private setStatus(
    serverId: string,
    status: McpConnection['status'],
    serverName?: string,
    tools?: McpToolInfo[],
    error?: string
  ): void {
    const conn = this.connections.get(serverId)
    if (conn) {
      conn.status = status
      if (error !== undefined) conn.error = error
      if (tools) conn.tools = tools
    }
    this.emit({ serverId, serverName: serverName || conn?.serverName, status, tools, error })
  }

  getStatus(serverId: string): { connected: boolean; status: string } {
    const conn = this.connections.get(serverId)
    return { connected: !!conn && conn.status === 'connected', status: conn?.status || 'disconnected' }
  }

  /** 在所有已连接服务中查找能提供指定工具的服务（供 mcp_call 未传 serverId 时兜底自动匹配） */
  findServersByTool(toolName: string): Array<{ serverId: string; serverName: string }> {
    const out: Array<{ serverId: string; serverName: string }> = []
    for (const [serverId, conn] of this.connections) {
      if (conn.status === 'connected' && Array.isArray(conn.tools) && conn.tools.some((t) => t.name === toolName)) {
        out.push({ serverId, serverName: conn.serverName })
      }
    }
    return out
  }

  /**
   * 取指定服务某个工具的入参 schema（供 mcp_call 做必填参数前置校验与提示）。
   * 服务未连接或工具不存在时返回 null（调用方应跳过校验，不做硬拦截）。
   */
  getToolSchema(serverId: string, toolName: string): any | null {
    const conn = this.connections.get(serverId)
    const tool = conn?.tools?.find((t) => t.name === toolName)
    return tool?.inputSchema || null
  }

  /** 兼容不同 SDK / 服务端返回格式，提取工具列表 */
  private normalizeTools(response: any): McpToolInfo[] {
    let toolsList: any[] = []
    if (Array.isArray(response)) toolsList = response
    else if (response && Array.isArray(response.tools)) toolsList = response.tools
    else if (response?.tools && Array.isArray(response.tools.tools)) toolsList = response.tools.tools
    return toolsList.map((tool: any) => ({
      name: tool.name || tool.toolName || '',
      description: tool.description || '',
      inputSchema: tool.inputSchema || tool.schema || {}
    }))
  }

  private async buildTransport(config: McpServerConfigInput, onStderr?: (msg: string) => void): Promise<any> {
    const { StdioClientTransport, SSEClientTransport, StreamableHTTPClientTransport } = await getMcpSdk()
    const type = config.transport || 'stdio'
    if (type === 'stdio') {
      const args = Array.isArray(config.args)
        ? config.args
        : config.args
          ? String(config.args).split(/\s+/).filter(Boolean)
          : []
      // env 可能是对象或 JSON 字符串（兼容工作流内联节点）
      let env: Record<string, string> = {}
      if (config.env && typeof config.env === 'object') env = config.env as Record<string, string>
      else if (typeof config.env === 'string') {
        try {
          env = JSON.parse(config.env)
        } catch {
          env = {}
        }
      }
      const transport = new StdioClientTransport({
        command: config.command!,
        args,
        env,
        stderr: 'pipe'
      })
      transport.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim()
        if (msg) {
          console.log(`[mcp:${config.name || 'stdio'}] stderr:`, msg)
          onStderr?.(msg)
        }
      })
      return transport
    }
    if (type === 'sse') {
      return new SSEClientTransport(new URL(config.serverUrl!))
    }
    // http -> streamableHttp
    return new StreamableHTTPClientTransport(new URL(config.serverUrl!), {
      requestInit: { headers: config.headers || {} }
    })
  }

  private async buildClient(config: McpServerConfigInput, serverId?: string): Promise<{ client: any; transport: any }> {
    const { Client } = await getMcpSdk()
    const client = new Client({ name: 'AI-KM MCP', version: '1.0.0' }, { capabilities: {} })
    let transport: any
    if (config.builtin) {
      // 内置本地服务（浏览器 Agent / Office / drawio 等）：进程内 InMemoryTransport，连接主进程本地 SDK Server
      const localId = config.id || serverId || ''
      const factory = BUILTIN_SERVERS[localId]
      if (!factory) throw new Error(`未知的内置 MCP 服务：${localId}`)
      // 把配置传入工厂：内置服务可据此读取自身参数（如 PostgreSQL 连接 env）
      const pair = await factory.createLocalServerPair(config)
      transport = pair.clientTransport
    } else {
      transport = await this.buildTransport(config)
    }
    await client.connect(transport)
    return { client, transport }
  }

  /** 连接（或复用已有健康连接），并拉取工具列表 */
  async connect(
    serverId: string,
    config: McpServerConfigInput
  ): Promise<{ success: boolean; tools?: McpToolInfo[]; error?: string }> {
    if (this.stopping) return { success: false, error: 'MCP 服务正在停止' }

    // 已有连接且健康 → 直接复用
    const existing = this.connections.get(serverId)
    if (existing && existing.status === 'connected') {
      try {
        await existing.client.ping({ timeout: 5000 })
        return { success: true, tools: existing.tools || [] }
      } catch {
        await this.disconnect(serverId)
      }
    }

    // 等待进行中的同名连接，避免重复建连
    if (this.pending.has(serverId)) {
      try {
        await this.pending.get(serverId)
      } catch {
        /* 交给下方重新尝试 */
      }
    }

    const name = config.name || serverId
    const p = (async (): Promise<McpConnection> => {
      const conn: McpConnection = {
        serverId,
        serverName: name,
        config,
        client: null as any,
        transport: null as any,
        status: 'connecting'
      }
      this.connections.set(serverId, conn)
      this.setStatus(serverId, 'connecting', name)
      try {
        const { client, transport } = await this.buildClient(config, serverId)
        conn.client = client
        conn.transport = transport
        conn.config = config
        conn.status = 'connected'
        let tools: McpToolInfo[] = []
        try {
          const resp = await client.listTools()
          tools = this.normalizeTools(resp)
        } catch (e) {
          console.warn(`[mcp] listTools failed for ${name}`, e)
        }
        conn.tools = tools
        this.setStatus(serverId, 'connected', name, tools)
        return conn
      } catch (err: any) {
        conn.status = 'error'
        conn.error = err?.message || String(err)
        this.setStatus(serverId, 'error', name, undefined, conn.error)
        throw err
      }
    })()

    this.pending.set(serverId, p)
    try {
      const conn = await p
      return { success: conn.status === 'connected', tools: conn.tools || [], error: conn.error }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    } finally {
      this.pending.delete(serverId)
    }
  }

  async disconnect(serverId: string): Promise<void> {
    const conn = this.connections.get(serverId)
    if (!conn) {
      this.setStatus(serverId, 'disconnected')
      return
    }
    try {
      await conn.client?.close()
    } catch {
      /* 忽略关闭错误 */
    }
    this.connections.delete(serverId)
    this.setStatus(serverId, 'disconnected', conn.serverName)
  }

  /** 获取工具列表；连接不存在或失效时自动用配置重建 */
  async listTools(
    serverId: string,
    config: McpServerConfigInput
  ): Promise<{ success: boolean; tools?: McpToolInfo[]; error?: string }> {
    const conn = this.connections.get(serverId)
    if (conn && conn.status === 'connected') {
      try {
        const resp = await conn.client.listTools()
        const tools = this.normalizeTools(resp)
        conn.tools = tools
        return { success: true, tools }
      } catch {
        /* 连接可能已失效，重建 */
      }
    }
    return await this.connect(serverId, config)
  }

  /** 调用工具；未连接时自动用配置连接 */
  async callTool(
    serverId: string,
    config: McpServerConfigInput,
    toolName: string,
    args: Record<string, any>
  ): Promise<McpCallResult> {
    let conn = this.connections.get(serverId)
    if (!conn || conn.status !== 'connected') {
      const res = await this.connect(serverId, config)
      if (!res.success) return { success: false, error: res.error || '连接失败' }
      conn = this.connections.get(serverId)
    }
    if (!conn) return { success: false, error: '连接不存在' }
    // 单次调用超时：优先服务自定义，否则默认值（避免 MCP 服务无响应时前端无限等待）
    const cfgTimeout = Number(config?.timeoutMs)
    const timeoutMs = Number.isFinite(cfgTimeout) && cfgTimeout > 0 ? Math.round(cfgTimeout) : DEFAULT_CALL_TIMEOUT_MS
    try {
      // 注意：SDK 的 callTool 签名是 callTool(params, resultSchema?, options?)
      //       第二个参数是 resultSchema（默认 CallToolResultSchema），第三个才是 options
      const result = await conn.client.callTool(
        { name: toolName, arguments: args || {} },
        undefined,
        { timeout: timeoutMs }
      )
      return this.normalizeCallResult(result)
    } catch (err: any) {
      const msg = err?.message || String(err)
      // 超时错误附加友好提示（带服务名与实际等待秒数）
      const friendly = msg.includes('timed out') || msg.includes('-32001')
        ? `${msg}（MCP 服务「${conn.serverName || serverId}」未在 ${Math.round(timeoutMs / 1000)} 秒内响应，可在「设置 → 工具 → MCP」调整该服务的调用超时后重试）`
        : msg
      return { success: false, error: friendly, details: err, raw: undefined }
    }
  }

  private normalizeCallResult(result: any): McpCallResult {
    try {
      if (result && result.content) {
        const content = result.content
        if (Array.isArray(content) && content.length > 0) {
          const first = content[0]
          if (first && typeof first === 'object') {
            if (first.type === 'text' && first.text) return { success: true, data: first.text, raw: result }
            if (first.type === 'resource' && first.resource) return { success: true, data: first.resource, raw: result }
            if (first.text) return { success: true, data: first.text, raw: result }
          }
        } else if (typeof content === 'string') {
          return { success: true, data: content, raw: result }
        } else if (content && typeof content === 'object') {
          const text = content.text || content.result || JSON.stringify(content, null, 2)
          return { success: true, data: text, raw: result }
        }
      }
      return { success: true, data: result, raw: result }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err), details: err, raw: result }
    }
  }

  /** 测试连接：用临时 serverId 连接 → 取工具 → 断开 */
  async testConnection(
    config: McpServerConfigInput
  ): Promise<{ success: boolean; tools?: McpToolInfo[]; error?: string }> {
    const tempId = `test-${randomUUID()}`
    const res = await this.connect(tempId, config)
    if (res.success) await this.disconnect(tempId)
    return res
  }

  /** 关闭全部连接（不停止服务，工作流/设置页可继续使用） */
  async disconnectAll(): Promise<void> {
    const ids = [...this.connections.keys()]
    for (const id of ids) await this.disconnect(id)
  }

  /** 应用退出前调用：标记停止并清理 */
  async shutdown(): Promise<void> {
    this.stopping = true
    await this.disconnectAll()
    this.connections.clear()
    this.pending.clear()
  }
}

export const mcpService = new McpRuntimeService()
