/**
 * 内置 MCP 服务对外 HTTP 暴露（builtin-office / builtin-browser / builtin-drawio / builtin-literature / builtin-postgres）
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
 *   /mcp/builtin-postgres   PostgreSQL 只读查询（pg_status / pg_list_schemas / pg_list_tables / pg_describe_table / pg_sample_rows / pg_query）
 * 工具实际在主进程内执行（office / drawio）或经本应用渲染端 RPC 执行（browser），
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
import { literatureService } from './literature/literature-service'
import { postgresService } from './postgres/postgres-service'

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
    console.log(`[mcp-expose] MCP listening on http://127.0.0.1:${port}${MCP_EXPOSE_ENDPOINTS.map(e => e.path).join(' ')}`)
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

    // CORS（供基于浏览器的客户端 / 其他 Electron 渲染进程连接）
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
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
