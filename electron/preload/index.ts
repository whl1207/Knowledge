import { ipcRenderer, contextBridge, webUtils } from 'electron'
import type { AgentEvent, AgentOptions, AgentSummary, AgentControl } from '@/types/agent'
import type { SessionEvent, DerivedMessage, SessionLogIntegrity } from '@/types/session-log'
import type { ToolRegistrySnapshot, ToolResult, ToolExecutionContext } from '@/types/tool'
import type { WebSearchConfig, WebSearchTestResult } from '@/shared/webSearch'
import type { WebFetchConfig, WebFetchTestResult } from '@/shared/webFetch'
import type { JobInfo, JobEvent } from '../main/job-registry'

// --------- Expose some API to the Renderer process ---------
// on() 会把监听器包一层匿名函数，off() 必须用同一个包装函数才能真正移除；
// 否则每次 on 都会累积一个永不失效的监听——面板反复挂载会使 fileSystemChanged 监听持续累积，
// 事件触发时多个旧监听同时各发起一次全量树刷新，海量文件下内存暴涨甚至崩溃。
const ipcWrapperRegistry = new Map<string, Map<Function, (event: any, ...args: any[]) => void>>()

const api = {
  on(...args: Parameters<typeof ipcRenderer.on>) {
    const [channel, listener] = args
    let m = ipcWrapperRegistry.get(channel)
    if (!m) { m = new Map(); ipcWrapperRegistry.set(channel, m) }
    if (!m.has(listener)) {
      const wrapper = (event: any, ...inner: any[]) => listener(event, ...inner)
      m.set(listener, wrapper)
      ipcRenderer.on(channel, wrapper)
    }
    return ipcRenderer
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, listener] = args
    const m = ipcWrapperRegistry.get(channel)
    const wrapper = m?.get(listener)
    if (wrapper) {
      ipcRenderer.off(channel, wrapper)
      m!.delete(listener)
      if (!m!.size) ipcWrapperRegistry.delete(channel)
    }
    return ipcRenderer
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args
    return ipcRenderer.send(channel, ...omit)
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args
    return ipcRenderer.invoke(channel, ...omit)
  },
  /**
   * `removeListener` / `removeAllListeners`：`IpcRendererApi` 一直声明着这两个方法，
   * 但本对象此前没实现（调用即 TypeError）。on/off 走的是一张包装函数表，这两条按同一张表实现，
   * 保证「声明即事实」。
   */
  removeListener(...args: Parameters<typeof ipcRenderer.removeListener>) {
    const [channel, listener] = args
    const m = ipcWrapperRegistry.get(channel)
    const wrapper = m?.get(listener as Function)
    if (wrapper) {
      ipcRenderer.removeListener(channel, wrapper)
      m!.delete(listener as Function)
      if (!m!.size) ipcWrapperRegistry.delete(channel)
    }
    return ipcRenderer
  },
  removeAllListeners(channel: string) {
    const m = ipcWrapperRegistry.get(channel)
    if (m) {
      for (const wrapper of m.values()) ipcRenderer.removeListener(channel, wrapper)
      ipcWrapperRegistry.delete(channel)
    }
    return ipcRenderer
  },

  /**
   * 拖入窗口的 File 在磁盘上的真实路径（非磁盘来源返回空串）。
   *
   * 为什么必须由 preload 代取：Chromium 从 Electron 32 起移除了非标准的 `File.path`，
   * 渲染层再也拿不到拖入文件的路径（只剩文件名）。没有真路径就只能按文件名去读，
   * 主进程必然 ENOENT —— 这正是「Word / Excel / Markdown 拖进首页提示读取失败」的根因。
   * `webUtils.getPathForFile` 只能看到渲染层的 File 对象，所以必须放在 preload 这一侧。
   */
  getPathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      // 跨 realm 传参异常 / 非磁盘来源：返回空串，由调用方走「无路径」兜底
      return ''
    }
  },

  // You can expose other APTs you need here.
  // ...
}

// ---------------------------------------------------------------------------
// 命名空间 IPC（window.dsh）—— 阶段一/二新增的类型化通道
// 统一解包 { ok, data | error } 信封，失败抛出带 code 的 Error
// ---------------------------------------------------------------------------

/**
 * 把 payload 净化为纯 JSON（可 structured clone）。
 *
 * 为什么必要：渲染进程传参常来自 Pinia store（Vue reactive proxy）。
 * 即使外层做了 `{ ...config }` 展开，嵌套的数组/对象（如
 * available_models、custom.headers）仍是 Proxy，Electron IPC 的
 * structured clone 会抛 "An object could not be cloned"。
 * 这里在**唯一出口**统一 JSON 往返一次，所有命名空间通道的入参都保证
 * 是纯 JSON 数据（这些通道本来就只承载 JSON 语义）。
 */
function toPlain(payload: unknown, channel?: string): unknown {
  if (payload === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(payload))
  } catch (e) {
    // 兜底原样发送（保持既有行为：别的通道可能依赖它），但**必须点名通道**——
    // 否则这次序列化失败会在 ipcRenderer.invoke 那里变成一句
    // `An object could not be cloned.`，完全看不出是哪个通道、为什么（真实事故）。
    console.warn(
      `[preload] ${channel ? `通道 ${channel} 的` : ''}payload 无法 JSON 序列化，原样发送（Electron 可能会报 "could not be cloned"）:`,
      e instanceof Error ? `${e.name}: ${e.message}` : e,
    )
    return payload
  }
}

function invokeIpc<T = any>(channel: string, payload?: unknown): Promise<T> {
  return ipcRenderer.invoke(channel, toPlain(payload, channel)).then((res: any) => {
    if (res && typeof res === 'object' && 'ok' in res) {
      if (res.ok) return res.data as T
      const err: any = new Error(res.error?.message || 'IPC 调用失败')
      err.code = res.error?.code || 'INTERNAL'
      throw err
    }
    return res as T
  })
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: any, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const dsh = {
  /** 会话事件日志（单一事实源） */
  sessionLog: {
    list(): Promise<Array<{ id: string; events: number; lastTs: number }>> {
      return invokeIpc('sessionLog:list')
    },
    search(keyword: string): Promise<Array<{ id: string; snippet: string }>> {
      return invokeIpc('sessionLog:search', { keyword })
    },
    events(
      requestId: string,
      opts?: { limit?: number; beforeSeq?: number },
    ): Promise<SessionEvent[]> {
      return invokeIpc('sessionLog:events', { requestId, ...(opts || {}) })
    },
    derive(requestId: string): Promise<DerivedMessage[]> {
      return invokeIpc('sessionLog:derive', { requestId })
    },
    integrity(requestId: string): Promise<SessionLogIntegrity> {
      return invokeIpc('sessionLog:integrity', { requestId })
    },
    append(requestId: string, type: 'tool/result' | 'user/message', event: any): Promise<{ success: boolean }> {
      return invokeIpc('sessionLog:append', { requestId, type, event })
    },
    clearAll(): Promise<{ success: boolean }> {
      return invokeIpc('sessionLog:clearAll')
    },
    clearBefore(cutoffTs?: number): Promise<{ removed: number }> {
      return invokeIpc('sessionLog:clearBefore', { cutoffTs: cutoffTs ?? 0 })
    },
  },

  /** Agent 循环（turn/step/inbox/cancel/steer/inject） */
  agent: {
    create(options: AgentOptions): Promise<{ id: string }> {
      return invokeIpc('agent:create', { options })
    },
    send(id: string, content: string, source?: string, images?: string[]): Promise<{ success: boolean }> {
      return invokeIpc('agent:send', { id, content, source, images })
    },
    steer(id: string, content: string): Promise<{ success: boolean; reason?: string }> {
      return invokeIpc('agent:steer', { id, content })
    },
    inject(id: string, content: string): Promise<{ success: boolean }> {
      return invokeIpc('agent:inject', { id, content })
    },
    cancel(id: string, cause?: string, keepInbox?: boolean): Promise<{ success: boolean }> {
      return invokeIpc('agent:cancel', { id, cause, keepInbox })
    },
    list(): Promise<AgentSummary[]> {
      return invokeIpc('agent:list')
    },
    dispose(id: string): Promise<{ success: boolean }> {
      return invokeIpc('agent:dispose', { id })
    },
    tools(agentId?: string, scope?: string): Promise<{ name: string; description: string }[]> {
      return invokeIpc('agent:tools', { agentId, scope })
    },
    state(id: string): Promise<import('@/types/agent').AgentStateView> {
      return invokeIpc('agent:state', { id })
    },
    /**
     * 回答 agent 的 ask_user 问题（agent/question 事件附带 askId）。
     * answers = 结构化回答批（每题一条 `{ id, selected, custom? }`）；message 是旧式纯文本回答。
     */
    answer(id: string, askId: string, message?: string, answers?: any[]): Promise<{ success: boolean }> {
      return invokeIpc('agent:answer', { id, askId, message, answers })
    },
    /** 渲染层任务：抢占执行权（agent/renderer-task 事件；返回 true 表示本窗口负责执行） */
    claimRendererTask(id: string, taskId: string): Promise<{ claimed: boolean }> {
      return invokeIpc('agent:renderer-claim', { id, taskId })
    },
    /** 渲染层任务：回传执行结果 { ok, value?, error? } */
    rendererResult(id: string, taskId: string, result: { ok: boolean; value?: any; error?: string }): Promise<{ success: boolean }> {
      return invokeIpc('agent:renderer-result', { id, taskId, result })
    },
    /** 工作流智能体节点：创建 agent → 发送输入 → 等待收敛 → 返回最终 assistant 内容 */
    run(options: AgentOptions, input: string, timeoutMs?: number): Promise<{ content: string; error?: string; timedOut: boolean; turn: number }> {
      return invokeIpc('agent:run', { options, input, timeoutMs })
    },
    /** 声明/撤销编排级期望并发（AgentBatch 等运行期把远端大模型并发拉到自身并发数） */
    declareConcurrency(scopeId: string, concurrency: number): Promise<{ success: boolean }> {
      return invokeIpc('agent:concurrency:declare', { scopeId, concurrency })
    },
    revokeConcurrency(scopeId: string): Promise<{ success: boolean }> {
      return invokeIpc('agent:concurrency:revoke', { scopeId })
    },
    /** PTC（Code Mode）：获取模型可见的 SDK 声明文本（scope / 能力白名单可选） */
    sdkDocs(scope?: string, whitelist?: string[]): Promise<string> {
      return invokeIpc('agent:sdkDocs', { scope, whitelist })
    },
    /** 订阅 agent 事件流（返回取消订阅函数） */
    onEvent(cb: (ev: AgentEvent) => void): () => void {
      return subscribe<AgentEvent>('agent:event', cb)
    },
  },

  /** 技能多根发现 + 变更监听 */
  skills: {
    list(roots?: string[]): Promise<any[]> {
      return invokeIpc('skill:list', roots ? { roots } : undefined)
    },
    get(name: string): Promise<any> {
      return invokeIpc('skill:get', { name })
    },
    refresh(): Promise<{ success: boolean }> {
      return invokeIpc('skill:refresh')
    },
    onChange(cb: (info: { kind: 'added' | 'removed' | 'changed'; names: string[] }) => void): () => void {
      return subscribe('skill:change', cb)
    },
  },

  /** 统一工具注册表 */
  tools: {
    list(scope?: string): Promise<ToolRegistrySnapshot[]> {
      return invokeIpc('tools:list', scope ? { scope } : undefined)
    },
    execute(name: string, input: any, ctx?: ToolExecutionContext): Promise<ToolResult> {
      return invokeIpc('tools:execute', { name, input, ctx })
    },
  },

  /** 联网搜索源（设置页「工具 → 搜索」；web_search 工具按该配置分发搜索源） */
  webSearch: {
    getConfig(): Promise<WebSearchConfig> {
      return invokeIpc('webSearch:get-config')
    },
    setConfig(cfg: Partial<WebSearchConfig>): Promise<WebSearchConfig> {
      return invokeIpc('webSearch:set-config', cfg)
    },
    test(payload?: { query?: string; config?: Partial<WebSearchConfig>; provider?: string }): Promise<WebSearchTestResult> {
      return invokeIpc('webSearch:test', payload || {})
    },
  },

  /** 网页抓取通道（设置页「工具 → 抓取」；web_fetch 工具按该配置依次回退） */
  webFetch: {
    getConfig(): Promise<WebFetchConfig> {
      return invokeIpc('webFetch:get-config')
    },
    setConfig(cfg: Partial<WebFetchConfig>): Promise<WebFetchConfig> {
      return invokeIpc('webFetch:set-config', cfg)
    },
    test(payload?: { url?: string; config?: Partial<WebFetchConfig> }): Promise<WebFetchTestResult> {
      return invokeIpc('webFetch:test', payload || {})
    },
  },

  /** 后台任务运行时（路线图 2.4） */
  jobs: {
    list(): Promise<JobInfo[]> {
      return invokeIpc('jobs:list')
    },
    get(id: string): Promise<JobInfo | null> {
      return invokeIpc('jobs:get', { id })
    },
    cancel(id: string, cause?: string): Promise<{ success: boolean }> {
      return invokeIpc('jobs:cancel', { id, cause })
    },
    /** 渲染进程长任务注册（知识库构建、本体抽取等） */
    start(kind: string, owner: string, title: string): Promise<JobInfo> {
      return invokeIpc('jobs:start', { kind, owner, title })
    },
    progress(id: string, progress: number | null, detail?: string): Promise<{ success: boolean }> {
      return invokeIpc('jobs:progress', { id, progress, detail })
    },
    complete(id: string, result?: any): Promise<{ success: boolean }> {
      return invokeIpc('jobs:complete', { id, result })
    },
    fail(id: string, error: string): Promise<{ success: boolean }> {
      return invokeIpc('jobs:fail', { id, error })
    },
    /** 订阅任务事件流（job/start | job/progress | job/end；返回取消订阅函数） */
    onEvent(cb: (ev: JobEvent) => void): () => void {
      return subscribe<JobEvent>('job:event', cb)
    },
  },

  /** 凭据接缝（路线图 2.3）：明文只存主进程，UI 只见脱敏信息 */
  credentials: {
    list(): Promise<import('../main/credentials').CredentialInfo[]> {
      return invokeIpc('credentials:list')
    },
    set(name: string, value: string): Promise<import('../main/credentials').CredentialInfo> {
      return invokeIpc('credentials:set', { name, value })
    },
    delete(name: string): Promise<{ success: boolean }> {
      return invokeIpc('credentials:delete', { name })
    },
    /** 请求时按操作解析：apiKeyRef → 明文（仅用于构造 LLM 请求头，勿用于展示） */
    resolve(name: string): Promise<{ value: string | null }> {
      return invokeIpc('credentials:resolve', { name })
    },
  },
  /** 本地 ONNX TTS（Kokoro / Piper）—— 主进程 sherpa-onnx 服务 */
  tts: {
    status(): Promise<{ available: boolean; version: string; error: string | null }> {
      return invokeIpc('tts:status')
    },
    load(payload: { engine: string; modelDir: string; lang?: string }): Promise<import('../main/tts-service').TtsModelInfo> {
      return invokeIpc('tts:load', payload)
    },
    /** 合成语音，返回 WAV 字节（二进制安全，不走 JSON 信封） */
    synthesize(payload: { engine: string; modelDir: string; text: string; sid?: number; speed?: number; lang?: string }): Promise<Uint8Array> {
      return ipcRenderer.invoke('tts:synthesize', toPlain(payload))
    },
    dispose(): Promise<{ success: boolean }> {
      return invokeIpc('tts:dispose')
    },
  },

  /** 界面配置随软件分发（根目录 interface-config.json） */
  interfaceConfig: {
    save(config: Record<string, any>): Promise<{ success: boolean; path: string }> {
      return invokeIpc('interfaceConfig:save', { config })
    },
    load(): Promise<Record<string, any> | null> {
      return invokeIpc('interfaceConfig:load')
    },
    path(): Promise<string> {
      return invokeIpc('interfaceConfig:path')
    },
  },

  /** 局域网协同文件编辑（主进程 collab-service） */
  collab: {
    getStatus(): Promise<import('@/types/collab').CollabStatus> {
      return invokeIpc('collab:getStatus')
    },
    start(payload?: { port?: number; maxMembers?: number; permissionMode?: string; token?: string }): Promise<{ success: boolean; port?: number; error?: string }> {
      return invokeIpc('collab:start', payload)
    },
    stop(): Promise<{ success: boolean }> {
      return invokeIpc('collab:stop')
    },
    shareFile(
      filePath: string,
      content: string,
      options?: { token?: string; maxMembers?: number; permissionMode?: string; autoSaveSeconds?: number; kind?: import('@/types/collab').CollabKind },
    ): Promise<import('@/types/collab').CollabShareResult> {
      return invokeIpc('collab:shareFile', { filePath, content, options })
    },
    closeRoom(roomId: string): Promise<{ success: boolean }> {
      return invokeIpc('collab:closeRoom', { roomId })
    },
    saveRoom(roomId: string): Promise<{ ok: boolean; error?: string }> {
      return invokeIpc('collab:saveRoom', { roomId })
    },
    /** 订阅协同服务状态（collab:status） */
    onStatus(cb: (status: import('@/types/collab').CollabStatus) => void): () => void {
      return subscribe<import('@/types/collab').CollabStatus>('collab:status', cb)
    },
  },

  /** 局域网远程文件共享（主进程 remote-fs-service，HTTP 只读） */
  remoteFs: {
    /** 启动共享文件夹服务 */
    start(payload?: { port?: number; rootDir?: string; token?: string }): Promise<{ success: boolean; port?: number; token?: string; error?: string }> {
      return invokeIpc('remoteFs:start', payload)
    },
    stop(): Promise<{ success: boolean }> {
      return invokeIpc('remoteFs:stop')
    },
    getStatus(): Promise<{
      running: boolean
      port: number
      ips: string[]
      rootDir: string
      token: string
      name: string
    }> {
      return invokeIpc('remoteFs:getStatus')
    },
    /** 订阅远程文件共享服务状态 */
    onStatus(cb: (status: any) => void): () => void {
      return subscribe('remote-fs-status', cb)
    },
  },

  /** MBTiles 离线地图包（内置 + 用户挂载；设置 → 系统 管理） */
  mapTiles: {
    list(): Promise<import('../main/map-tiles').MapTileSource[]> {
      return invokeIpc('map-tiles:list')
    },
    /** 弹窗选择 .mbtiles 挂载；返回新增源或 null（用户取消） */
    add(): Promise<import('../main/map-tiles').MapTileSource | null> {
      return invokeIpc('map-tiles:add')
    },
    remove(id: string): Promise<boolean> {
      return invokeIpc('map-tiles:remove', { id })
    },
    /** 取一张瓦片（二进制通道，返回字节；无则 null） */
    tile(payload: { id: string; z: number; x: number; y: number }): Promise<Uint8Array | null> {
      return ipcRenderer.invoke('map-tiles:tile', toPlain(payload))
    },
    /** 订阅挂载列表变化（map-tiles:changed） */
    onChange(cb: (sources: import('../main/map-tiles').MapTileSource[]) => void): () => void {
      return subscribe('map-tiles:changed', cb)
    },
  },

  /**
   * 插件管理（P0：主进程插件宿主）。
   * 变更类操作（enable/disable/reload/uninstall/setConfig）必须传 confirm=true：
   * 插件与宿主同进程运行、不受工作区沙箱保护，UI 必须先展示权限并弹确认框。
   */
  plugin: {
    list(): Promise<{
      plugins: import('@/types/plugin').PluginSnapshot[]
      rootDir: string
      customRoot: boolean
      services: string[]
      /** 因目录名不能作为插件 id 而被跳过的目录（相对插件目录；有清单但名字非 ASCII 小写） */
      invalidNamedDirs?: string[]
    }> {
      return invokeIpc('plugin:list')
    },
    /** 重新扫描插件目录（可发现放进子文件夹的新插件；会装载插件代码 → 需 confirm） */
    rescan(confirm = false): Promise<{
      plugins: import('@/types/plugin').PluginSnapshot[]
      rootDir: string
      customRoot: boolean
      services: string[]
    }> {
      return invokeIpc('plugin:rescan', { confirm })
    },
    inspect(spec: string): Promise<{
      ok: boolean
      id: string | null
      name: string | null
      version: string | null
      apiVersion: string | null
      permissions: string[]
      problem: string | null
    }> {
      return invokeIpc('plugin:inspect', { spec })
    },
    enable(id: string, confirm = false): Promise<import('@/types/plugin').PluginSnapshot> {
      return invokeIpc('plugin:enable', { id, confirm })
    },
    disable(id: string, confirm = false): Promise<import('@/types/plugin').PluginSnapshot> {
      return invokeIpc('plugin:disable', { id, confirm })
    },
    reload(id: string, confirm = false): Promise<import('@/types/plugin').PluginSnapshot> {
      return invokeIpc('plugin:reload', { id, confirm })
    },
    uninstall(
      id: string,
      options?: { confirm?: boolean; deleteFiles?: boolean },
    ): Promise<{ removed: boolean; deletedDir: boolean }> {
      return invokeIpc('plugin:uninstall', { id, confirm: options?.confirm === true, deleteFiles: options?.deleteFiles === true })
    },
    getConfig(id: string): Promise<Record<string, unknown>> {
      return invokeIpc('plugin:get-config', { id })
    },
    setConfig(id: string, patch: Record<string, unknown>, confirm = false): Promise<Record<string, unknown>> {
      return invokeIpc('plugin:set-config', { id, patch, confirm })
    },
    logs(id: string): Promise<import('@/types/plugin').PluginLogLine[]> {
      return invokeIpc('plugin:logs', { id })
    },
    /** 渲染层半边的日志上报（界面扩展装载失败 / 插件 warn·error）→ 落进插件日志缓冲（不阻塞） */
    clientLog(id: string, level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
      void ipcRenderer.invoke('plugin:client-log', { id, level, message }).catch(() => {})
    },
    /** 渲染层半边的 bundle 源码（P1：渲染层用 Blob URL 动态 import） */
    clientBundle(id: string): Promise<{ entry: string; code: string }> {
      return invokeIpc('plugin:client-bundle', { id })
    },
    /**
     * 插件委派智能体（`ctx.agent.run` 的主进程侧）。
     * 判权 / 同意 / 预算 / D5 工具裁剪 / 步数裁定**全在主进程**；这里只是通道。
     */
    agentRun(args: {
      pluginId: string
      presetId: string
      presetName?: string
      presetMaxSteps?: number
      input: string
      budget?: { timeoutMs?: number; maxSteps?: number; maxTokens?: number }
      options: unknown
    }): Promise<import('@/lib/plugin/agentContract').AgentRunResult> {
      return invokeIpc('plugin:agent-run', args)
    },
    /** 各插件的委派用量快照（设置页展示；只读） */
    agentUsage(): Promise<Record<string, { inFlight: number; callsInWindow: number }>> {
      return invokeIpc('plugin:agent-usage')
    },
    /** 取消某插件全部在飞委派（插件面板的「停止」按钮） */
    agentCancel(args: { pluginId: string }): Promise<{ cancelled: number }> {
      return invokeIpc('plugin:agent-cancel', args)
    },
    /** 某插件的委派状态（同意 + 用量）；「插件 → 数据」用（只读，不需要审批） */
    agentStatus(args: { pluginId: string }): Promise<{ consent: 'allow' | 'ask' | 'deny'; inFlight: number; callsInWindow: number }> {
      return invokeIpc('plugin:agent:status', args)
    },
    /** 改写委派同意（需 confirm；撤销 = 'ask'，改为拒绝 = 'deny'，以后不再询问 = 'allow'） */
    setAgentConsent(args: {
      pluginId: string
      consent: 'allow' | 'ask' | 'deny'
      confirm?: boolean
    }): Promise<{ consent: 'allow' | 'ask' | 'deny' }> {
      return invokeIpc('plugin:agent:consent-set', args)
    },
    /** 重置某插件的委派用量（需 confirm；撞了每小时上限时不必干等窗口滑过） */
    resetAgentUsage(args: { pluginId: string; confirm?: boolean }): Promise<{ cleared: boolean }> {
      return invokeIpc('plugin:agent:reset-usage', args)
    },
    /** 「插件权限」页签的总览：每个已装插件一行（只读） */
    agentOverview(): Promise<{ rows: unknown[]; limits: unknown }> {
      return invokeIpc('plugin:agent:overview')
    },
    /** 写某插件的委派额度与 D5 放宽开关（需 confirm；这是唯一能放开文件 / MCP 工具的入口） */
    setAgentConfig(args: {
      pluginId: string
      limits?: { concurrency?: number; callsPerHour?: number }
      relax?: { fs?: boolean; mcp?: boolean }
      confirm?: boolean
    }): Promise<unknown> {
      return invokeIpc('plugin:agent:config-set', args)
    },
    /** 改写某插件的**工具审批**三态（需 confirm；声明了 fs / shell 的插件，其工具默认要用户确认） */
    setToolApproval(args: { pluginId: string; state: 'allow' | 'ask' | 'deny'; confirm?: boolean }): Promise<{ pluginId: string; state: 'allow' | 'ask' | 'deny' }> {
      return invokeIpc('plugin:tool-approval-set', args)
    },
    /**
     * 订阅**观测事件**（工具调用 / agent 输出与流式增量）。
     *
     * 对齐 DSH 的 `ctx.remote.$on` + 声明式允许名单：`types` 必须在允许名单内，
     * 未知类型会报错（不静默忽略）；而且只会收到**属于自己**的事件。
     */
    eventsSubscribe(args: { pluginId: string; types: string[] }): Promise<{ pluginId: string; types: string[] }> {
      return invokeIpc('plugin:events:subscribe', args)
    },
    /** 退订（不传 types = 全退） */
    eventsUnsubscribe(args: { pluginId: string; types?: string[] }): Promise<{ pluginId: string; types: string[] }> {
      return invokeIpc('plugin:events:unsubscribe', args)
    },
    /**
     * 接收推送的**观测事件**（载荷 `{ pluginId, type, payload }`；调用方按 pluginId 过滤）。
     * 与上面的 `onEvent`（插件生命周期通知）不是一回事，刻意分开命名。
     */
    onScopedEvent(cb: (ev: { pluginId: string; type: string; payload: unknown }) => void): () => void {
      return subscribe<{ pluginId: string; type: string; payload: unknown }>('plugin:event', cb)
    },
    /** 从本地文件夹安装插件（P2：主进程弹目录选择框）；replace=true 表示覆盖同名插件 */
    install(options?: { confirm?: boolean; replace?: boolean }): Promise<{
      cancelled: boolean
      snapshot: import('@/types/plugin').PluginSnapshot | null
    }> {
      return invokeIpc('plugin:install', {
        confirm: options?.confirm === true,
        replace: options?.replace === true,
      })
    },
    /**
     * 从商店安装插件：url 指向共享目录的 `/fs/bundle?path=…&token=…`（或任意返回
     * `{ files: [{ path, text | base64 }] }` 的 HTTP 商店）。下载与落盘都在主进程完成。
     */
    installFromStore(options: { url: string; id?: string; replace?: boolean; confirm?: boolean }): Promise<import('@/types/plugin').PluginSnapshot> {
      return invokeIpc('plugin:install-from-store', {
        url: options.url,
        id: options.id,
        confirm: options.confirm === true,
        replace: options.replace === true,
      })
    },
    /** 选择插件目录（P2：与技能目录同一交互）；不传 path 则由主进程弹目录选择框 */
    setRoot(options?: { confirm?: boolean; path?: string }): Promise<{ cancelled: boolean; rootDir: string }> {
      return invokeIpc('plugin:set-root', {
        confirm: options?.confirm === true,
        ...(options?.path ? { path: options.path } : {}),
      })
    },
    /** 恢复默认插件目录（userData/plugins） */
    resetRoot(options?: { confirm?: boolean }): Promise<{ cancelled: boolean; rootDir: string }> {
      return invokeIpc('plugin:reset-root', { confirm: options?.confirm === true })
    },
    openDir(id?: string): Promise<{ path: string }> {
      return invokeIpc('plugin:open-dir', id ? { id } : undefined)
    },
    /**
     * 插件在主进程侧的数据文件（`userData/plugins-data/<id>/`，如 `ctx.storage` 的 storage.json）。
     * 渲染层读不到这个目录，「插件管理 → 数据」用它补齐统计。
     */
    dataFiles(id: string): Promise<{ id: string; entries: import('@/types/plugin').PluginDataFileStat[] }> {
      return invokeIpc('plugin:data-files', { id })
    },
    /** 一次拿到所有插件的主进程侧数据（列表页显示占用用） */
    dataFilesAll(): Promise<{ byId: Record<string, import('@/types/plugin').PluginDataFileStat[]> }> {
      return invokeIpc('plugin:data-files-all')
    },
    /** 删除插件数据目录里的一个文件 / 子目录（删磁盘文件 → 需 confirm） */
    removeDataFile(id: string, name: string, confirm = false): Promise<{ removed: boolean }> {
      return invokeIpc('plugin:data-remove-file', { id, name, confirm })
    },
    /** 删除插件整个主进程数据目录（删磁盘文件 → 需 confirm） */
    clearDataFiles(id: string, confirm = false): Promise<{ removed: boolean }> {
      return invokeIpc('plugin:data-clear-files', { id, confirm })
    },
    /**
     * 插件文件能力（合同审核等需要"上传 + 预览 + 读法规"的插件）：
     * 主进程只放行"用户在该插件里亲自选过"的路径（capability allowlist），且要求 fs 权限。
     */
    files: {
      pick(options: { id: string; accept?: string; multiple?: boolean }): Promise<{
        cancelled: boolean
        files: Array<{ path: string; name: string; size: number }>
      }> {
        return ipcRenderer.invoke('plugin:files:pick', options)
      },
      pickDirectory(options: { id: string }): Promise<{
        cancelled: boolean
        dir: { path: string; name: string } | null
      }> {
        return ipcRenderer.invoke('plugin:files:pick-dir', options)
      },
      /** 选一个**可写**文件夹（写权限的唯一来源；授权模式 write，跨重启有效） */
      pickWritableDirectory(options: { id: string; title?: string }): Promise<{
        cancelled: boolean
        dir: { path: string; name: string; mode?: 'write' } | null
      }> {
        return ipcRenderer.invoke('plugin:files:pick-writable', options)
      },
      /** 写文本（只能落在**可写**授权目录内；父目录自动创建） */
      writeText(options: {
        id: string
        path: string
        text: string
        /** 乐观并发：给了就要求版本匹配（省略 = 无条件覆盖，老行为） */
        expectedVersion?: string
        presence?: 'any' | 'mustExist' | 'mustNotExist'
      }): Promise<{ path: string; bytes: number; version?: string | null }> {
        return ipcRenderer.invoke('plugin:files:write-text', options)
      },
      /** 删除文件 / 空目录（只认可写授权；不做递归删除） */
      remove(options: { id: string; path: string; expectedVersion?: string }): Promise<{ removed: boolean; missing?: boolean }> {
        return ipcRenderer.invoke('plugin:files:remove', options)
      },
      /** 取状态与版本（`ctx.fs.stat`；目标不存在时返回 `{ exists: false }` 而不是抛错） */
      stat(options: { id: string; path: string }): Promise<import('@/shared/fsContract').FsStat> {
        return ipcRenderer.invoke('plugin:fs:stat', options)
      },
      /** 字面量编辑（读 → 校验版本 → 替换 → 原子写回） */
      editText(options: {
        id: string
        path: string
        edits: import('@/shared/fsContract').FsEdit[]
        expectedVersion?: string
      }): Promise<import('@/shared/fsContract').FsEditResult> {
        return ipcRenderer.invoke('plugin:fs:edit-text', options)
      },
      /** 「先读后写」策略：是否开启 + 本会话已观察的文件数（设置页只读快照） */
      fsPolicyGet(options: { id: string }): Promise<{ id: string; enabled: boolean; observed: number }> {
        return ipcRenderer.invoke('plugin:fs:policy-get', options)
      },
      /** 开启 / 关闭「先读后写」策略（需 confirm） */
      fsPolicySet(options: { id: string; enabled: boolean; confirm?: boolean }): Promise<{ id: string; enabled: boolean }> {
        return ipcRenderer.invoke('plugin:fs:policy-set', options)
      },
      list(options: { id: string; path: string }): Promise<{
        dir: string
        entries: Array<{ name: string; path: string; isDir: boolean; size: number }>
      }> {
        return ipcRenderer.invoke('plugin:files:list', options)
      },
      readText(options: { id: string; path: string; maxBytes?: number }): Promise<{
        path: string
        text: string
        pages: number
        pdf: boolean
      }> {
        return ipcRenderer.invoke('plugin:files:read-text', options)
      },
      readBase64(options: { id: string; path: string; maxBytes?: number }): Promise<{
        path: string
        base64: string
        size: number
      }> {
        return ipcRenderer.invoke('plugin:files:read-base64', options)
      },
      readSheet(options: { id: string; path: string; maxRows?: number; maxSheets?: number }): Promise<{
        path: string
        sheetCount: number
        sheets: Array<{ name: string; headers: string[]; rows: unknown[][]; truncated: boolean }>
      }> {
        return ipcRenderer.invoke('plugin:files:read-sheet', options)
      },
      /** 该插件记住的路径（用户选过的文件 / 文件夹；跨重启有效，可在「插件 → 数据」里撤销） */
      grants(options: { id: string }): Promise<{
        id: string
        entries: Array<{ path: string; isDir: boolean; exists: boolean }>
      }> {
        return ipcRenderer.invoke('plugin:files:grants', options)
      },
      /** 撤销一条授权（撤销磁盘上的记忆 → 需 confirm） */
      revokeGrant(options: { id: string; path: string; confirm?: boolean }): Promise<{ removed: boolean }> {
        return ipcRenderer.invoke('plugin:files:revoke-grant', options)
      },
      /** 清掉某个插件的全部授权（需 confirm） */
      clearGrants(options: { id: string; confirm?: boolean }): Promise<{ removed: boolean }> {
        return ipcRenderer.invoke('plugin:files:clear-grants', options)
      },
    },
    /** 订阅插件事件（状态变更 / 日志 / 通知） */
    onEvent(cb: (ev: import('@/types/plugin').PluginEvent) => void): () => void {
      return subscribe('plugin:event', cb)
    },
  },
}

// ---------------------------------------------------------------------------
// IPC 桥的暴露方式：**一次性领取**，不再挂 `window.ipcRenderer` / `window.dsh`
// ---------------------------------------------------------------------------
//
// 为什么必须这样：插件的「界面半边」由宿主把源码包成 Blob URL、在渲染进程**同一个 realm**
// 里 import（src/lib/plugin/runtime.ts）。只要通用 IPC 桥挂在 window 上，任何界面半边插件
// ——哪怕 aikm.permissions 一个都没声明——都能 `window.ipcRenderer.invoke('tools:execute', …)`
// 拿到宿主全部工具（含 run_shell / 写文件），或 `window.dsh.credentials.resolve(…)` 读走凭据。
// 清单里的 permissions 因此对界面半边形同虚设。
//
// 改成「一次性领取」后，桥只存在于渲染层模块作用域（src/lib/aikmIpc.ts 的闭包变量），
// 插件代码既枚举不到全局名，也读不到别的模块的闭包 —— 领取入口在应用启动时即被焚掉。
//
// ⚠️ 不是沙箱：插件仍与宿主同进程、同文档。见 src/lib/aikmIpc.ts 的边界说明。
let bridgeClaimed = false

/** 一次性把桥交给渲染层；第二次调用起返回 null（插件装载发生在应用启动之后，拿不到） */
function claimIpcBridge(): { ipcRenderer: typeof api; dsh: typeof dsh } | null {
  if (bridgeClaimed) return null
  bridgeClaimed = true
  return { ipcRenderer: api, dsh }
}

// contextIsolation: true（主窗口默认）→ 走 contextBridge 暴露给主世界
try {
  contextBridge.exposeInMainWorld('__aikmClaimIpcBridge', claimIpcBridge)
} catch {
  // contextIsolation: false 时 contextBridge 不可用，下面的直接赋值生效
}

// 直接挂在 preload 自己的 window 上：contextIsolation: false 的独立窗口靠这一条。
// （contextIsolation: true 时这里写的是隔离世界的 window，主世界看不到，无副作用。）
// @ts-ignore
;(window as any).__aikmClaimIpcBridge = claimIpcBridge

// ---------------------------------------------------------------------------
// preload 就绪握手（宿主侧的自救依据，见 electron/main/preload-guard.ts）
// ---------------------------------------------------------------------------
// 这一句必须在**本脚本确实执行完**的前提下才会发出：主进程据此判断某个窗口这一份文档到底有没有
// 跑过 preload。没有它，「preload 被 Electron 静默跳过」就只能靠渲染层的报错反推（渲染层拿不到
// 桥时是静默降级成网页模式的，见 src/platform/index.ts）。
try {
  ipcRenderer.send('preload:loaded')
} catch {
  /* 极端情况下（IPC 不可用）握手失败即可，不影响 preload 本身 */
}

// --------- Preload scripts loading ---------
function domReady(condition: DocumentReadyState[] = ['complete', 'interactive']) {
  return new Promise((resolve) => {
    if (condition.includes(document.readyState)) {
      resolve(true)
    } else {
      document.addEventListener('readystatechange', () => {
        if (condition.includes(document.readyState)) {
          resolve(true)
        }
      })
    }
  })
}

const safeDOM = {
  append(parent: HTMLElement, child: HTMLElement) {
    if (!Array.from(parent.children).find(e => e === child)) {
      return parent.appendChild(child)
    }
  },
  remove(parent: HTMLElement, child: HTMLElement) {
    if (Array.from(parent.children).find(e => e === child)) {
      return parent.removeChild(child)
    }
  },
}

/**
 * https://tobiasahlin.com/spinkit
 * https://connoratherton.com/loaders
 * https://projects.lukehaas.me/css-loaders
 * https://matejkustec.github.io/SpinThatShit
 */
function useLoading() {
  const className = `loaders-css__square-spin`
  // 读取持久化主题：加载遮罩背景/转块颜色与应用主题一致，避免深色遮罩移除后突兀闪白
  let themeBg = '#ffffff'
  let themeAccent = '#03254d'
  try {
    const raw = localStorage.getItem('UI')
    if (raw) {
      const ui = JSON.parse(raw)
      if (typeof ui?.backgroundColor === 'string' && /^#([0-9a-fA-F]{3,8})$/.test(ui.backgroundColor)) themeBg = ui.backgroundColor
      if (typeof ui?.fontActiveColor === 'string' && /^#([0-9a-fA-F]{3,8})$/.test(ui.fontActiveColor)) themeAccent = ui.fontActiveColor
    }
  } catch { /* 读取失败则用默认值 */ }
  const styleContent = `
@keyframes square-spin {
  25% { transform: perspective(100px) rotateX(180deg) rotateY(0); }
  50% { transform: perspective(100px) rotateX(180deg) rotateY(180deg); }
  75% { transform: perspective(100px) rotateX(0) rotateY(180deg); }
  100% { transform: perspective(100px) rotateX(0) rotateY(0); }
}
.${className} > div {
  animation-fill-mode: both;
  width: 50px;
  height: 50px;
  background: ${themeAccent};
  animation: square-spin 3s 0s cubic-bezier(0.09, 0.57, 0.49, 0.9) infinite;
}
.app-loading-wrap {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: ${themeBg};
  z-index: 9;
  /* 淡出过渡：移除时平滑渐隐到应用，避免瞬间消失露出白屏 */
  transition: opacity 0.3s ease;
}
    `
  const oStyle = document.createElement('style')
  const oDiv = document.createElement('div')

  oStyle.id = 'app-loading-style'
  oStyle.innerHTML = styleContent
  oDiv.className = 'app-loading-wrap'
  oDiv.innerHTML = `<div class="${className}"><div></div></div>`

  return {
    appendLoading() {
      safeDOM.append(document.head, oStyle)
      safeDOM.append(document.body, oDiv)
    },
    removeLoading() {
      // 先淡出（opacity 0），过渡结束后再移除节点，避免加载层瞬间消失露出白屏
      if (oDiv.style.opacity !== '0') {
        oDiv.style.opacity = '0'
        setTimeout(() => {
          safeDOM.remove(document.head, oStyle)
          safeDOM.remove(document.body, oDiv)
        }, 320)
      }
    },
  }
}

// ----------------------------------------------------------------------

const { appendLoading, removeLoading } = useLoading()
domReady().then(appendLoading)

window.onmessage = (ev) => {
  ev.data.payload === 'removeLoading' && removeLoading()
}

setTimeout(removeLoading, 4999)
