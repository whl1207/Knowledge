/**
 * 内置 MCP 服务对外 HTTP 暴露（builtin-office / builtin-browser / builtin-drawio / builtin-literature / builtin-postgres / builtin-plugin-dev）
 *
 * 把进程内内置服务通过「Streamable HTTP」暴露到本机端口（127.0.0.1），
 * 供其他软件（Claude Desktop / Claude Code / Cursor 等支持 MCP 的客户端，
 * 或另一台 App 实例）作为远程 MCP 服务连接使用。
 *
 * 每个内置服务一个独立端点：
 *   /mcp/builtin-office     Office Word 读写（open_document / find_and_replace_text / …）
 *   /mcp/builtin-browser    浏览器 Agent（browser_navigate / browser_screenshot / …）
 *   /mcp/builtin-drawio     drawio 图表（drawio_create / drawio_add_node / drawio_auto_layout / …）
 *   /mcp/builtin-literature 学术文献检索（search_crossref / search_openalex / search_arxiv / search_pubmed / get_by_doi）
 *   /mcp/builtin-postgres   PostgreSQL 只读查询（pg_status / pg_list_schemas / … / pg_query）
 *   /mcp/builtin-plugin-dev 插件开发参考（plugin_dev_guide：约束 / 清单 / 槽位 / 宿主 API / 示例 / 常见问题）
 * 工具实际在主进程内执行（office / drawio / plugin-dev）或经本应用渲染端 RPC 执行（browser），
 * 因此「使用方连接时，本软件必须处于运行状态」。
 *
 * 与 2 SwarmPlanner 的 swarm-http-server 同构：共享单例 Server + 每会话一个
 * StreamableHTTPServerTransport。
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { officeService } from './office/office-service'
import { browserAgentService } from './browser-agent'
import { drawioService } from './drawio/drawio-service'
import { logInfo } from './log'
import { literatureService } from './literature/literature-service'
import { postgresService } from './postgres/postgres-service'
import { pluginDevService } from './plugin-dev/plugin-dev-service'

export const MCP_EXPOSE_PORT = 43112

interface ExposeEndpoint {
  id: string
  path: string
  name: string
  /** 把外部 transport 挂到该服务的共享 Server */
  connect: (transport: any) => Promise<void>
  /** 工具名列表（/health 展示） */
  tools: () => string[]
}

export const MCP_EXPOSE_ENDPOINTS: ExposeEndpoint[] = [
  {
    id: 'builtin-office',
    path: '/mcp/builtin-office',
    name: 'Office Word 读写',
    connect: (t) => officeService.connectTransport(t),
    tools: () => officeService.listToolNames(),
  },
  {
    id: 'builtin-browser',
    path: '/mcp/builtin-browser',
    name: '浏览器 Agent',
    connect: (t) => browserAgentService.connectTransport(t),
    tools: () => (browserAgentService.toolDefinitions() as any[]).map((t) => t.name),
  },
  {
    id: 'builtin-drawio',
    path: '/mcp/builtin-drawio',
    name: 'drawio 图表',
    connect: (t) => drawioService.connectTransport(t),
    tools: () => drawioService.listToolNames(),
  },
  {
    id: 'builtin-literature',
    path: '/mcp/builtin-literature',
    name: '学术文献检索',
    connect: (t) => literatureService.connectTransport(t),
    tools: () => literatureService.listToolNames(),
  },
  {
    id: 'builtin-postgres',
    path: '/mcp/builtin-postgres',
    name: 'PostgreSQL 只读查询',
    connect: (t) => postgresService.connectTransport(t),
    tools: () => postgresService.listToolNames(),
  },
  {
    id: 'builtin-plugin-dev',
    path: '/mcp/builtin-plugin-dev',
    name: '插件开发参考',
    connect: (t) => pluginDevService.connectTransport(t),
    tools: () => pluginDevService.listToolNames(),
  },
]

export interface McpExposeEndpointState {
  id: string
  name: string
  url: string
  tools: string[]
  enabled: boolean
}

export interface McpExposeInfo {
  running: boolean
  port: number
  endpoints: McpExposeEndpointState[]
}

function jsonOut(res: http.ServerResponse, status: number, obj: unknown): void {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.writeHead(status)
  res.end(JSON.stringify(obj))
}

class McpExposeService {
  private httpServer: http.Server | null = null
  private sessions = new Map<string, { transport: any; endpointId: string }>()
  private started = false
  private port = MCP_EXPOSE_PORT
  /** 按端点 id 记录「已关闭」状态（默认全部开启，可经 setEnabled 单独开关） */
  private disabledEndpoints = new Map<string, boolean>()
  /**
   * 可选访问令牌（环境变量 AIKM_MCP_TOKEN）。
   *
   * 本服务监听 127.0.0.1 且默认开启，浏览器里的任意网页都能对 localhost 发请求；
   * 有 Origin 的跨源请求一律拒绝（见 handleRequest），令牌则用于挡住本机其它进程的
   * 未授权调用。不设令牌时保持旧行为（本地 MCP 客户端零配置可连），但本机进程仍可调用 ——
   * 需要强隔离时请设置 AIKM_MCP_TOKEN，并让客户端带 `Authorization: Bearer <token>`。
   */
  private readonly token = String(process.env.AIKM_MCP_TOKEN || '').trim()

  /** 启动 HTTP MCP 服务（默认 127.0.0.1:43112，可用环境变量 MCP_EXPOSE_PORT 覆盖） */
  async start(port: number = MCP_EXPOSE_PORT): Promise<void> {
    if (this.started) return
    this.port = port
    this.httpServer = http.createServer((req, res) => this.handleRequest(req, res))
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once('error', reject)
      this.httpServer!.listen(port, '127.0.0.1', () => resolve())
    })
    this.started = true
    logInfo('mcp-expose', `MCP listening on http://127.0.0.1:${port}${MCP_EXPOSE_ENDPOINTS.map(e => e.path).join(' ')}`)
  }

  /** 只允许本机页面的跨源请求（127.0.0.1 / localhost / ::1），其余 Origin 一律拒绝 */
  private isAllowedOrigin(origin: string): boolean {
    try {
      const u = new URL(origin)
      return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1' || u.hostname === '[::1]'
    } catch {
      return false
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://127.0.0.1')

    if (url.pathname === '/' || url.pathname === '/health') {
      this.sendStatus(res)
      return
    }
    const ep = MCP_EXPOSE_ENDPOINTS.find(e => e.path === url.pathname)
    if (!ep) {
      res.writeHead(404)
      res.end('Not Found')
      return
    }
    if (this.disabledEndpoints.get(ep.id)) {
      jsonOut(res, 503, { jsonrpc: '2.0', error: { code: -32000, message: 'Endpoint disabled' }, id: null })
      return
    }

    // 安全边界（P0）：
    // 1) 带 Origin 的请求只允许本机页面（http://127.0.0.1 / http://localhost）。浏览器里
    //    任意网页对 localhost 的 fetch 都带自己的 Origin，这里直接 403，堵住"网页驱动用户
    //    登录态浏览器"的路径；非浏览器 MCP 客户端不发 Origin，不受影响。
    const origin = String(req.headers.origin || '').trim()
    if (origin && !this.isAllowedOrigin(origin)) {
      jsonOut(res, 403, { jsonrpc: '2.0', error: { code: -32001, message: 'Forbidden origin' }, id: null })
      return
    }
    // CORS：只回显被允许的本机 Origin，不再使用 `*`
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id')
    // 预检请求不带 Authorization，必须在令牌校验之前放行（否则浏览器客户端永远连不上）
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // 2) 配置了 AIKM_MCP_TOKEN 时，所有实际请求都必须带 `Authorization: Bearer <token>`。
    if (this.token) {
      const auth = String(req.headers.authorization || '').trim()
      if (auth !== `Bearer ${this.token}`) {
        jsonOut(res, 401, { jsonrpc: '2.0', error: { code: -32002, message: 'Unauthorized: missing or invalid bearer token' }, id: null })
        return
      }
    }

    // 非 MCP 客户端（如普通浏览器直接访问端点）：返回友好提示而非协议错误
    const accept = req.headers['accept'] || ''
    if (!accept.includes('text/event-stream')) {
      this.sendStatus(res)
      return
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined
    let transport: any
    if (sessionId) {
      const sess = this.sessions.get(sessionId)
      if (!sess) {
        jsonOut(res, 404, { jsonrpc: '2.0', error: { code: -32000, message: 'Invalid session ID' }, id: null })
        return
      }
      if (sess.endpointId !== ep.id) {
        jsonOut(res, 404, { jsonrpc: '2.0', error: { code: -32000, message: 'Session belongs to another endpoint' }, id: null })
        return
      }
      transport = sess.transport
    } else {
      // 新会话：创建 transport 并挂到该服务的共享 Server（与内置 in-memory 连接并存）
      const { StreamableHTTPServerTransport } = await import(/* @vite-ignore */ '@modelcontextprotocol/sdk/server/streamableHttp.js')
      const newTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          if (sid) {
            this.sessions.set(sid, { transport: newTransport, endpointId: ep.id })
            newTransport.onclose = () => this.sessions.delete(sid)
          }
        },
      })
      transport = newTransport
      try {
        await ep.connect(newTransport)
      } catch (err) {
        console.error(`[mcp-expose] connect error @ ${ep.path}`, err)
        if (!res.headersSent) jsonOut(res, 500, { jsonrpc: '2.0', error: { code: -32000, message: 'connect failed' }, id: null })
        return
      }
    }

    try {
      await transport.handleRequest(req, res)
    } catch (err) {
      console.error('[mcp-expose] handleRequest error', err)
      if (!res.headersSent) {
        res.writeHead(500)
        res.end('Internal Server Error')
      }
    }
  }

  /** 返回服务状态 JSON（浏览器可直接查看，也是外部接入说明的来源） */
  private sendStatus(res: http.ServerResponse): void {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.writeHead(200)
    res.end(JSON.stringify({
      service: 'AI-KM builtin MCP expose',
      status: this.started ? 'running' : 'stopped',
      base: `http://127.0.0.1:${this.port}`,
      authRequired: !!this.token,
      cors: '仅允许本机 Origin（127.0.0.1 / localhost）；带其它 Origin 的请求返回 403',
      endpoints: MCP_EXPOSE_ENDPOINTS.map(e => ({
        id: e.id,
        name: e.name,
        url: `http://127.0.0.1:${this.port}${e.path}`,
        tools: this.started ? e.tools() : [],
        enabled: !this.disabledEndpoints.get(e.id),
      })),
      message: 'MCP Streamable HTTP 服务运行正常。浏览器无法直接交互；请使用支持 MCP Streamable HTTP 的客户端（如 Claude Desktop / Claude Code / Cursor）连接上面的 url，本软件需保持运行。',
    }, null, 2))
  }

  /** 端点对外暴露开关状态 */
  isEndpointEnabled(id: string): boolean {
    return !this.disabledEndpoints.get(id)
  }

  /** 按端点开关对外暴露：关闭时断开该端点已有的外部会话；返回最新状态 */
  async setEnabled(id: string, enabled: boolean): Promise<McpExposeInfo> {
    const ep = MCP_EXPOSE_ENDPOINTS.find(e => e.id === id)
    if (!ep) return this.info()
    this.disabledEndpoints.set(id, !enabled)
    if (!enabled) {
      for (const [sid, s] of Array.from(this.sessions)) {
        if (s.endpointId === id) {
          try { await s.transport.close() } catch { /* 忽略 */ }
          this.sessions.delete(sid)
        }
      }
    }
    return this.info()
  }

  /** 供设置页「说明」区查询（IPC mcp-expose-info / mcp-expose-set） */
  info(): McpExposeInfo {
    return {
      running: this.started,
      port: this.port,
      endpoints: MCP_EXPOSE_ENDPOINTS.map(e => ({
        id: e.id,
        name: e.name,
        url: `http://127.0.0.1:${this.port}${e.path}`,
        tools: this.started ? e.tools() : [],
        enabled: !this.disabledEndpoints.get(e.id),
      })),
    }
  }

  isStarted(): boolean {
    return this.started
  }

  async close(): Promise<void> {
    for (const s of this.sessions.values()) {
      try { await s.transport.close() } catch { /* 忽略 */ }
    }
    this.sessions.clear()
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()))
      this.httpServer = null
    }
    this.started = false
  }
}

export const mcpExposeServer = new McpExposeService()
