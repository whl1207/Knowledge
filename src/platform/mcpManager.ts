// src/platform/mcpManager.ts
// MCP 运行时桥：通过 IPC 委托给主进程 mcp-service（electron/main/mcp-service.ts）
// 配置在渲染进程持有（localStorage），主进程按 serverId 缓存连接。
// 对外 API 与旧版保持一致（connect/disconnect/refreshTools/getTools/callTool/testConnection/isConnected/cleanup），
// 使 WorkflowRunner 与 MCP 节点执行器无需大改即可使用。
import type { McpServerConfig, McpTool } from '@/types/mcp'

export type { McpTool }

// 工具调用结果（与主进程 normalizeCallResult 形状一致）
export interface McpCallResult {
  success: boolean
  data?: any
  error?: string
  details?: any
  raw?: any
}

// 深拷贝为纯 JSON：剥离 Vue 响应式 Proxy / 不可克隆对象
// Electron IPC（structured clone）无法克隆 Proxy，必须先转成普通对象
function toPlain(value: any): any {
  if (value === null || value === undefined || typeof value !== 'object') return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    // 遇到循环引用等无法序列化的场景，返回原始值（交由调用方处理）
    return value
  }
}

// 兼容 window.ipcRenderer 缺失（纯浏览器预览环境）
function invoke(channel: string, payload: any): Promise<any> {
  if (window.ipcRenderer && typeof window.ipcRenderer.invoke === 'function') {
    return window.ipcRenderer.invoke(channel, toPlain(payload))
  }
  return Promise.reject(new Error('IPC 不可用（请在 Electron 中运行）'))
}

export class MCPManager {
  // 键 = 解析后的连接 id：设置服务用 serverId，工作流节点内联用 inline-<nodeId>
  private toolsCache = new Map<string, McpTool[]>()
  private configs = new Map<string, McpServerConfig>()
  private statusCache = new Map<string, string>()

  /** 解析连接键：有 serverId 用 serverId，否则退化为 inline-<connKey> */
  private resolve(connKey: number | string, serverId?: string): string {
    return serverId || `inline-${connKey}`
  }

  private normalize(config: any): McpServerConfig {
    return { ...config, transport: config.transport || 'stdio' }
  }

  isConnected(connKey: number | string, serverId?: string): boolean {
    return this.statusCache.get(this.resolve(connKey, serverId)) === 'connected'
  }

  getStatus(connKey: number | string, serverId?: string): string {
    return this.statusCache.get(this.resolve(connKey, serverId)) || 'disconnected'
  }

  /** 连接（或复用主进程已建立的连接），成功后缓存工具列表与配置 */
  async connect(connKey: number | string, config: any, serverId?: string): Promise<boolean> {
    const sid = this.resolve(connKey, serverId)
    const normalized = this.normalize(config)
    try {
      const res = await invoke('mcp:connect', { serverId: sid, config: normalized })
      if (res?.success) {
        this.configs.set(sid, normalized)
        this.toolsCache.set(sid, (res.tools || []) as McpTool[])
        this.statusCache.set(sid, 'connected')
        return true
      }
      this.statusCache.set(sid, 'error')
      return false
    } catch (err) {
      console.error('[mcp] connect error', err)
      this.statusCache.set(sid, 'error')
      return false
    }
  }

  async disconnect(connKey: number | string, serverId?: string): Promise<void> {
    const sid = this.resolve(connKey, serverId)
    try {
      await invoke('mcp:disconnect', { serverId: sid })
    } catch (err) {
      console.warn('[mcp] disconnect error', err)
    }
    this.toolsCache.delete(sid)
    this.configs.delete(sid)
    this.statusCache.set(sid, 'disconnected')
  }

  /** 刷新工具列表；config 缺省时使用连接时缓存的配置 */
  async refreshTools(connKey: number | string, config?: any, serverId?: string): Promise<McpTool[]> {
    const sid = this.resolve(connKey, serverId)
    const cfg: McpServerConfig | undefined = config ? this.normalize(config) : this.configs.get(sid)
    if (!cfg) return []
    this.configs.set(sid, cfg)
    try {
      const res = await invoke('mcp:listTools', { serverId: sid, config: cfg })
      const tools = (res?.tools || []) as McpTool[]
      this.toolsCache.set(sid, tools)
      if (res?.success) this.statusCache.set(sid, 'connected')
      return tools
    } catch (err) {
      console.error('[mcp] refreshTools error', err)
      return this.toolsCache.get(sid) || []
    }
  }

  getTools(connKey: number | string, serverId?: string): McpTool[] {
    return this.toolsCache.get(this.resolve(connKey, serverId)) || []
  }

  /** 调用工具（需先连接）；返回与旧版一致的结果形状
   *  @param timeoutMs 可选超时（毫秒），>0 时用 Promise.race 兜底，防止 IPC 挂起导致无限等待 */
  async callTool(
    connKey: number | string,
    toolName: string,
    arguments_: Record<string, any> = {},
    serverId?: string,
    timeoutMs?: number
  ): Promise<McpCallResult> {
    const sid = this.resolve(connKey, serverId)
    const cfg = this.configs.get(sid)
    if (!cfg) {
      return { success: false, error: 'MCP 客户端未连接，请先连接' }
    }
    const doCall = invoke('mcp:callTool', { serverId: sid, config: cfg, toolName, args: arguments_ })
      .then((res) => res || { success: false, error: '空响应' })
      .catch((err: any) => ({ success: false, error: err?.message || '调用工具失败', details: err }))
    if (timeoutMs && timeoutMs > 0) {
      let timer: ReturnType<typeof setTimeout> | null = null
      const timeoutPromise = new Promise<McpCallResult>((resolve) => {
        timer = setTimeout(() => {
          resolve({ success: false, error: `调用超时（${Math.round(timeoutMs / 1000)}s）：MCP 服务未响应，请检查服务端后重试` })
        }, timeoutMs)
      })
      return Promise.race([doCall, timeoutPromise]).finally(() => {
        if (timer) clearTimeout(timer)
      })
    }
    return doCall
  }

  /** 测试连接（不缓存），返回 { success, tools?, error? } */
  async testConnection(config: any): Promise<{ success: boolean; error?: string; tools?: McpTool[] }> {
    try {
      const res = await invoke('mcp:test', { config: this.normalize(config) })
      return res || { success: false, error: '空响应' }
    } catch (err: any) {
      return { success: false, error: err?.message || '测试连接失败' }
    }
  }

  /** 查询主进程侧连接状态（设置页用，支持跨页面/重启后状态恢复） */
  async queryStatus(serverId: string): Promise<{ connected: boolean; status: string }> {
    try {
      const res = await invoke('mcp:getStatus', { serverId })
      this.statusCache.set(serverId, res?.status || 'disconnected')
      return res || { connected: false, status: 'disconnected' }
    } catch {
      return { connected: false, status: 'disconnected' }
    }
  }

  /** 清理全部连接（工作流卸载时调用） */
  async cleanup(): Promise<void> {
    try {
      await invoke('mcp:disconnectAll', {})
    } catch {
      /* 忽略 */
    }
    this.toolsCache.clear()
    this.configs.clear()
    this.statusCache.clear()
  }
}

export const mcpManager = new MCPManager()
