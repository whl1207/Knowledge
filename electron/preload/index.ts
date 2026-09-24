import { ipcRenderer, contextBridge } from 'electron'
import type { AgentEvent, AgentOptions, AgentSummary, AgentControl } from '@/types/agent'
import type { SessionEvent, DerivedMessage, SessionLogIntegrity } from '@/types/session-log'
import type { ToolRegistrySnapshot, ToolResult, ToolExecutionContext } from '@/types/tool'
import type { WebSearchConfig, WebSearchTestResult } from '@/shared/webSearch'
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
function toPlain(payload: unknown): unknown {
  if (payload === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(payload))
  } catch (e) {
    console.warn('[preload] payload 无法 JSON 序列化，原样发送:', e)
    return payload
  }
}

function invokeIpc<T = any>(channel: string, payload?: unknown): Promise<T> {
  return ipcRenderer.invoke(channel, toPlain(payload)).then((res: any) => {
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
    /** 回答 agent 的 ask_user 问题（agent/question 事件附带 askId） */
    answer(id: string, askId: string, message: string): Promise<{ success: boolean }> {
      return invokeIpc('agent:answer', { id, askId, message })
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
}

// 使用 contextBridge 暴露（contextIsolation: true 时生效）
try {
  contextBridge.exposeInMainWorld('ipcRenderer', api)
  contextBridge.exposeInMainWorld('dsh', dsh)
} catch {
  // contextIsolation: false 时 contextBridge 不可用，直接挂到 window
}

// 直接暴露到 window（contextIsolation: false 时生效，兼容独立窗口）
// @ts-ignore
if (!window.ipcRenderer) { (window as any).ipcRenderer = api }
// @ts-ignore
if (!window.dsh) { (window as any).dsh = dsh }

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
