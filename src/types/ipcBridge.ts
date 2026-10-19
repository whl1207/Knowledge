/**
 * ipcBridge.ts — 渲染层 IPC 桥（preload 的 api / dsh 两个对象）的类型形状
 *
 * 为什么单独成模块（而不是留在 globals.d.ts / vite-env.d.ts 里当全局声明）：
 * `src/lib/aikmIpc.ts` 是这两个形状的唯一消费者，而它属于 `src/`；主进程/预加载的
 * tsconfig（tsconfig.node.json）只 include `electron/`，引用不到渲染层的全局声明，
 * 于是 `tsc -p tsconfig.node.json` 报 "Cannot find name 'AikmDshApi'"。
 * 类型放进真模块后，两条 tsconfig 都能按需 import，也不再有「编译单元决定类型是否可见」的坑。
 *
 * ⚠️ 这两个接口描述的是 preload 暴露的形状；桥本身**不再挂在 window 上**
 * （见 electron/preload/index.ts 的一次性领取与 src/lib/aikmIpc.ts 的模块作用域持有）。
 */

/** 通用 IPC 桥（preload 的 `api`） */
export interface IpcRendererApi {
  on(channel: string, listener: (event: any, ...args: any[]) => void): void
  off(channel: string, ...omit: any[]): void
  removeListener(channel: string, listener: (event: any, ...args: any[]) => void): void
  removeAllListeners(channel: string): void
  send(channel: string, ...args: any[]): void
  invoke(channel: string, ...args: any[]): Promise<any>
  /**
   * 拖入窗口的 File 的磁盘真实路径（非磁盘来源返回空串）。
   * Electron 32 起 `File.path` 已被移除，只能经 preload 的 webUtils 取回。
   */
  getPathForFile(file: File): string
}

/** 命名空间 IPC（preload 的 `dsh` 对象） */
export interface AikmDshApi {
  sessionLog: {
    list(): Promise<Array<{ id: string; events: number; lastTs: number }>>
    search(keyword: string): Promise<Array<{ id: string; snippet: string }>>
    events(requestId: string, opts?: { limit?: number; beforeSeq?: number }): Promise<import('@/types/session-log').SessionEvent[]>
    derive(requestId: string): Promise<import('@/types/session-log').DerivedMessage[]>
    integrity(requestId: string): Promise<import('@/types/session-log').SessionLogIntegrity>
    append(requestId: string, type: 'tool/result' | 'user/message', event: any): Promise<{ success: boolean }>
    clearAll(): Promise<{ success: boolean }>
    clearBefore(cutoffTs?: number): Promise<{ removed: number }>
  }
  agent: {
    create(options: import('@/types/agent').AgentOptions): Promise<{ id: string }>
    send(id: string, content: string, source?: string, images?: string[]): Promise<{ success: boolean }>
    /** 转向/引导：仅当该会话正在执行 turn 时受理；未受理时 reason='not-running' */
    steer(id: string, content: string): Promise<{ success: boolean; reason?: string }>
    inject(id: string, content: string): Promise<{ success: boolean }>
    cancel(id: string, cause?: string, keepInbox?: boolean): Promise<{ success: boolean }>
    list(): Promise<import('@/types/agent').AgentSummary[]>
    dispose(id: string): Promise<{ success: boolean }>
    tools(agentId?: string, scope?: string): Promise<{ name: string; description: string }[]>
    state(id: string): Promise<import('@/types/agent').AgentStateView>
    /**
    * 回答 agent 的 ask_user 问题。
    * answers = 结构化回答批（每题 `{ id, selected: string[], custom? }`）；message = 旧式纯文本回答。
    */
    answer(id: string, askId: string, message?: string, answers?: import('@/types/agent').AskUserAnswer[]): Promise<{ success: boolean }>
    /** 渲染层任务接缝：抢占执行权（agent/renderer-task 事件；agentId + taskId） */
    claimRendererTask(id: string, taskId: string): Promise<{ claimed: boolean }>
    /** 渲染层任务接缝：回传执行结果 */
    rendererResult(id: string, taskId: string, result: { ok: boolean; value?: any; error?: string }): Promise<{ success: boolean }>
    declareConcurrency(scopeId: string, concurrency: number): Promise<{ success: boolean }>
    revokeConcurrency(scopeId: string): Promise<{ success: boolean }>
    sdkDocs(scope?: string, whitelist?: string[]): Promise<string>
    onEvent(cb: (ev: import('@/types/agent').AgentEvent) => void): () => void
  }
  skills: {
    list(roots?: string[]): Promise<any[]>
    get(name: string): Promise<any>
    refresh(): Promise<{ success: boolean }>
    onChange(cb: (info: { kind: 'added' | 'removed' | 'changed'; names: string[] }) => void): () => void
  }
  tools: {
    list(scope?: string): Promise<import('@/types/tool').ToolRegistrySnapshot[]>
    execute(name: string, input: any, ctx?: import('@/types/tool').ToolExecutionContext): Promise<import('@/types/tool').ToolResult>
  }
  jobs: {
    list(): Promise<import('../../electron/main/job-registry').JobInfo[]>
    get(id: string): Promise<import('../../electron/main/job-registry').JobInfo | null>
    cancel(id: string, cause?: string): Promise<{ success: boolean }>
    start(kind: string, owner: string, title: string): Promise<import('../../electron/main/job-registry').JobInfo>
    progress(id: string, progress: number | null, detail?: string): Promise<{ success: boolean }>
    complete(id: string, result?: any): Promise<{ success: boolean }>
    fail(id: string, error: string): Promise<{ success: boolean }>
    onEvent(cb: (ev: import('../../electron/main/job-registry').JobEvent) => void): () => void
  }
  credentials: {
    list(): Promise<import('../../electron/main/credentials').CredentialInfo[]>
    set(name: string, value: string): Promise<import('../../electron/main/credentials').CredentialInfo>
    delete(name: string): Promise<{ success: boolean }>
    resolve(name: string): Promise<{ value: string | null }>
  }
  tts: {
    status(): Promise<{ available: boolean; version: string; error: string | null }>
    load(payload: { engine: string; modelDir: string; lang?: string }): Promise<import('../../electron/main/tts-service').TtsModelInfo>
    synthesize(payload: { engine: string; modelDir: string; text: string; sid?: number; speed?: number; lang?: string }): Promise<Uint8Array>
    dispose(): Promise<{ success: boolean }>
  }
  /** 联网搜索源（设置页「工具 → 搜索」；web_search 工具按该配置分发搜索源） */
  webSearch: {
    getConfig(): Promise<import('@/shared/webSearch').WebSearchConfig>
    setConfig(cfg: Partial<import('@/shared/webSearch').WebSearchConfig>): Promise<import('@/shared/webSearch').WebSearchConfig>
    test(payload?: { query?: string; config?: Partial<import('@/shared/webSearch').WebSearchConfig>; provider?: string }): Promise<import('@/shared/webSearch').WebSearchTestResult>
  }
  /** 网页抓取通道（设置页「工具 → 抓取」；web_fetch 工具按该配置依次回退） */
  webFetch: {
    getConfig(): Promise<import('@/shared/webFetch').WebFetchConfig>
    setConfig(cfg: Partial<import('@/shared/webFetch').WebFetchConfig>): Promise<import('@/shared/webFetch').WebFetchConfig>
    test(payload?: { url?: string; config?: Partial<import('@/shared/webFetch').WebFetchConfig> }): Promise<import('@/shared/webFetch').WebFetchTestResult>
  }
  interfaceConfig: {
    save(config: Record<string, any>): Promise<{ success: boolean; path: string }>
    load(): Promise<Record<string, any> | null>
    path(): Promise<string>
  }
  collab: {
    getStatus(): Promise<import('@/types/collab').CollabStatus>
    start(payload?: { port?: number; maxMembers?: number; permissionMode?: string; token?: string }): Promise<{ success: boolean; port?: number; error?: string }>
    stop(): Promise<{ success: boolean }>
    shareFile(
      filePath: string,
      content: string,
      options?: { token?: string; maxMembers?: number; permissionMode?: string; autoSaveSeconds?: number; kind?: import('@/types/collab').CollabKind },
    ): Promise<import('@/types/collab').CollabShareResult>
    closeRoom(roomId: string): Promise<{ success: boolean }>
    saveRoom(roomId: string): Promise<{ ok: boolean; error?: string }>
    onStatus(cb: (status: import('@/types/collab').CollabStatus) => void): () => void
  }
  remoteFs: {
    start(payload?: { port?: number; rootDir?: string; token?: string }): Promise<{ success: boolean; port?: number; token?: string; error?: string }>
    stop(): Promise<{ success: boolean }>
    getStatus(): Promise<{ running: boolean; port: number; ips: string[]; rootDir: string; token: string; name: string }>
    onStatus(cb: (status: { running: boolean; port: number; ips: string[]; rootDir: string; token: string; name: string }) => void): () => void
  }
  mapTiles: {
    list(): Promise<import('../../electron/main/map-tiles').MapTileSource[]>
    add(): Promise<import('../../electron/main/map-tiles').MapTileSource | null>
    remove(id: string): Promise<boolean>
    tile(payload: { id: string; z: number; x: number; y: number }): Promise<Uint8Array | null>
    onChange(cb: (sources: import('../../electron/main/map-tiles').MapTileSource[]) => void): () => void
  }
  /**
  * 插件管理（P0 主进程插件宿主）。
  * 变更类操作（enable/disable/reload/uninstall/setConfig）须传 confirm=true，
  * 否则主进程返回 PERMISSION_DENIED 且不改变状态。
  */
  plugin: {
    list(): Promise<{
      plugins: import('@/types/plugin').PluginSnapshot[]
      rootDir: string
      customRoot: boolean
      services: string[]
    }>
    inspect(spec: string): Promise<{
      ok: boolean
      id: string | null
      name: string | null
      version: string | null
      apiVersion: string | null
      permissions: string[]
      problem: string | null
    }>
    enable(id: string, confirm?: boolean): Promise<import('@/types/plugin').PluginSnapshot>
    /** 重新扫描插件目录（可发现放进子文件夹的新插件；会装载插件代码 → 需 confirm） */
    rescan(confirm?: boolean): Promise<{
      plugins: import('@/types/plugin').PluginSnapshot[]
      rootDir: string
      customRoot: boolean
      services: string[]
    }>
    disable(id: string, confirm?: boolean): Promise<import('@/types/plugin').PluginSnapshot>
    reload(id: string, confirm?: boolean): Promise<import('@/types/plugin').PluginSnapshot>
    uninstall(id: string, options?: { confirm?: boolean; deleteFiles?: boolean }): Promise<{ removed: boolean; deletedDir: boolean }>
    getConfig(id: string): Promise<Record<string, unknown>>
    setConfig(id: string, patch: Record<string, unknown>, confirm?: boolean): Promise<Record<string, unknown>>
    logs(id: string): Promise<import('@/types/plugin').PluginLogLine[]>
    /**
     * 插件委派智能体（`ctx.agent.run` 的主进程侧）。
     * 判权 / 首次同意 / 预算 / D5 工具裁剪 / 步数裁定全在主进程；渲染层只是通道。
     */
    agentRun(args: {
      pluginId: string
      presetId: string
      presetName?: string
      presetMaxSteps?: number
      input: string
      budget?: { timeoutMs?: number; maxSteps?: number; maxTokens?: number }
      options: unknown
    }): Promise<import('@/lib/plugin/agentContract').AgentRunResult>
    /** 各插件的委派用量快照（设置页展示；只读） */
    agentUsage(): Promise<Record<string, { inFlight: number; callsInWindow: number }>>
    /** 取消某插件全部在飞委派（插件面板的「停止」按钮） */
    agentCancel(args: { pluginId: string }): Promise<{ cancelled: number }>
    /** 某插件的委派状态（同意 + 用量）；只读 */
    agentStatus(args: { pluginId: string }): Promise<{ consent: 'allow' | 'ask' | 'deny'; inFlight: number; callsInWindow: number }>
    /** 改写委派同意（需 confirm） */
    setAgentConsent(args: {
      pluginId: string
      consent: 'allow' | 'ask' | 'deny'
      confirm?: boolean
    }): Promise<{ consent: 'allow' | 'ask' | 'deny' }>
    /** 重置某插件的委派用量（需 confirm） */
    resetAgentUsage(args: { pluginId: string; confirm?: boolean }): Promise<{ cleared: boolean }>
    /** 「插件权限」页签的总览（每插件一行；只读） */
    agentOverview(): Promise<{ rows: unknown[]; limits: unknown }>
    /** 写某插件的委派额度与 D5 放宽开关（需 confirm） */
    setAgentConfig(args: {
      pluginId: string
      limits?: { concurrency?: number; callsPerHour?: number }
      relax?: { fs?: boolean; mcp?: boolean }
      /** 工作目录（必须落在该插件的可写文件授权内；'' = 回到默认的知识库根） */
      cwd?: string
      confirm?: boolean
    }): Promise<unknown>
    /** 改写某插件的**工具审批**三态（需 confirm） */
    setToolApproval(args: {
      pluginId: string
      state: 'allow' | 'ask' | 'deny'
      confirm?: boolean
    }): Promise<{ pluginId: string; state: 'allow' | 'ask' | 'deny' }>
    /** 订阅观测事件（types 必须在允许名单内；未知类型报错） */
    eventsSubscribe(args: { pluginId: string; types: string[] }): Promise<{ pluginId: string; types: string[] }>
    /** 退订观测事件（不传 types = 全退） */
    eventsUnsubscribe(args: { pluginId: string; types?: string[] }): Promise<{ pluginId: string; types: string[] }>
    /** 接收推送的观测事件（载荷 `{ pluginId, type, payload }`）；与上面的 `onEvent`（生命周期通知）分开 */
    onScopedEvent(cb: (ev: { pluginId: string; type: string; payload: unknown }) => void): () => void
    /**
    * 渲染层半边的日志上报（界面扩展装载失败 / 插件 warn·error）→ 落进插件日志缓冲。
    * 与 preload 的 `dsh.plugin.clientLog` 一致；只读语义的追加，不需要审批。
    */
    clientLog(id: string, level: 'debug' | 'info' | 'warn' | 'error', message: string): void
    /**
    * 插件在主进程侧的数据文件（`userData/plugins-data/<id>/`）。
    * 这几项此前漏在本声明之外（只有 `any` 才编译得过）；补齐后声明与 preload 一一对应。
    */
    dataFiles(id: string): Promise<{
      id: string
      entries: import('@/types/plugin').PluginDataFileStat[]
    }>
    dataFilesAll(): Promise<{ byId: Record<string, import('@/types/plugin').PluginDataFileStat[]> }>
    removeDataFile(id: string, name: string, confirm?: boolean): Promise<{ removed: boolean }>
    clearDataFiles(id: string, confirm?: boolean): Promise<{ removed: boolean }>
    /** 插件文件授权（用户在插件里选过的路径；跨重启有效）的查看与撤销 */
    files: {
      grants(options: { id: string }): Promise<{
        id: string
        entries: Array<{ path: string; mode: 'read' | 'write'; isDir: boolean; exists: boolean }>
      }>
      revokeGrant(options: { id: string; path: string; confirm?: boolean }): Promise<{ removed: boolean }>
      clearGrants(options: { id: string; confirm?: boolean }): Promise<{ removed: boolean }>
      /** 「先读后写」策略：只读快照（是否开启 + 本会话已观察文件数） */
      fsPolicyGet(options: { id: string }): Promise<{ id: string; enabled: boolean; observed: number }>
      /** 开启 / 关闭「先读后写」策略（需 confirm） */
      fsPolicySet(options: { id: string; enabled: boolean; confirm?: boolean }): Promise<{ id: string; enabled: boolean }>
      /** 为用户选一个**可写**文件夹（写权限的唯一来源；授权模式 write） */
      pickWritableDirectory(options: { id: string; title?: string }): Promise<{
        cancelled: boolean
        dir: { path: string; name: string; mode?: 'write' } | null
      }>
    }
    /** 渲染层半边的 bundle 源码（P1：渲染层用 Blob URL 动态 import） */
    clientBundle(id: string): Promise<{ entry: string; code: string }>
    /** 从本地文件夹安装插件（主进程弹目录选择框）；replace=true 表示覆盖同名插件 */
    install(options?: { confirm?: boolean; replace?: boolean }): Promise<{
      cancelled: boolean
      snapshot: import('@/types/plugin').PluginSnapshot | null
    }>
    /**
    * 从商店安装插件：url 指向共享目录的 `/fs/bundle?path=…&token=…`
    * （或任意返回 `{ files: [{ path, text | base64 }] }` 的 HTTP 商店）。
    */
    installFromStore(options: { url: string; id?: string; replace?: boolean; confirm?: boolean }): Promise<import('@/types/plugin').PluginSnapshot>
    /** 选择插件目录（与技能目录同一交互）；不传 path 则由主进程弹目录选择框 */
    setRoot(options?: { confirm?: boolean; path?: string }): Promise<{ cancelled: boolean; rootDir: string }>
    /** 恢复默认插件目录（userData/plugins） */
    resetRoot(options?: { confirm?: boolean }): Promise<{ cancelled: boolean; rootDir: string }>
    openDir(id?: string): Promise<{ path: string }>
    onEvent(cb: (ev: import('@/types/plugin').PluginEvent) => void): () => void
  }
}
