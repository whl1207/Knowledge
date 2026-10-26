/**
 * bridge.ts — 渲染层访问插件宿主 IPC 的唯一入口
 *
 * 约定了「插件能力只有这些方法」：任何插件相关的 IPC 都从这里走，
 * 组件 / 插件代码不要直接摸 IPC 桥（便于集中审计与将来换实现）。
 *
 * 注意：宿主 IPC 桥（`aikmDsh`）本身也只存在于 `src/lib/aikmIpc.ts` 的模块作用域里 ——
 * preload 只暴露一次性的 `window.__aikmClaimIpcBridge()`，应用启动时领走即焚。
 * 这是为了让**界面半边插件**拿不到通用 IPC 通道（它与宿主渲染进程同 realm，
 * 否则一个零权限插件就能 `invoke('tools:execute', …)`）。不要在本模块之外重新把它挂回 window。
 *
 * 非 Electron 环境（浏览器 dev、局域网网页端、文件独立窗口的极端情况）返回 null，
 * 调用方据此静默降级。
 */

import type { PluginDataFileStat, PluginEvent, PluginLogLine, PluginSnapshot } from '@/types/plugin'
import type { AgentRunResult } from '@/lib/plugin/agentContract'
import { createLocalPluginHost, localPluginHostAvailable } from '@/platform/pluginHost'
import { hostRuntime } from '@/platform/host'
import { aikmDsh } from '@/lib/aikmIpc'

/** 客户端插件 bundle（主进程读取后经 IPC 传入，渲染层用 Blob URL 动态 import） */
export interface PluginClientBundle {
  /** 相对插件目录的入口路径（诊断用） */
  entry: string
  /** 入口源码（ESM，单文件） */
  code: string
}

export interface PluginBridgeApi {
  list(): Promise<{
    plugins: PluginSnapshot[]
    rootDir: string
    customRoot: boolean
    services: string[]
    /**
     * 扫描时被跳过的目录（相对插件根目录）：有清单但目录名不能作为插件 id
     * （中文 / 大写 / 空格）→ 宿主只能整目录跳过，列表里不会出现。缺省视为空数组。
     */
    invalidNamedDirs?: string[]
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
  enable(id: string, confirm?: boolean): Promise<PluginSnapshot>
  disable(id: string, confirm?: boolean): Promise<PluginSnapshot>
  reload(id: string, confirm?: boolean): Promise<PluginSnapshot>
  uninstall(id: string, options?: { confirm?: boolean; deleteFiles?: boolean }): Promise<{ removed: boolean; deletedDir: boolean }>
  getConfig(id: string): Promise<Record<string, unknown>>
  setConfig(id: string, patch: Record<string, unknown>, confirm?: boolean): Promise<Record<string, unknown>>
  logs(id: string): Promise<PluginLogLine[]>
  /** 渲染层半边的日志上报（界面扩展装载失败 / 插件 warn·error）→ 落进插件日志缓冲（不阻塞） */
  clientLog(id: string, level: 'debug' | 'info' | 'warn' | 'error', message: string): void
  openDir(id?: string): Promise<{ path: string; opened?: boolean }>
  /** 插件在主进程侧的数据文件（userData/plugins-data/<id>/，见 pluginData.ts） */
  dataFiles(id: string): Promise<{ id: string; entries: PluginDataFileStat[] }>
  /** 一次拿到所有插件的主进程侧数据（列表页显示占用用） */
  dataFilesAll(): Promise<{ byId: Record<string, PluginDataFileStat[]> }>
  /** 删除插件数据目录里的一个文件 / 子目录（需 confirm：会真的删磁盘文件） */
  removeDataFile(id: string, name: string, confirm?: boolean): Promise<{ removed: boolean }>
  /** 删除插件整个主进程数据目录（需 confirm） */
  clearDataFiles(id: string, confirm?: boolean): Promise<{ removed: boolean }>
  /**
   * 插件记住的文件授权（用户在插件里选过的文件 / 文件夹，跨重启有效）。
   * 「设置 → 插件 → 数据」里展示与撤销，落盘实现见 electron/main/plugin-grants.ts。
   */
  files: {
    grants(options: { id: string }): Promise<{ id: string; entries: Array<{ path: string; mode: 'read' | 'write'; isDir: boolean; exists: boolean }> }>
    /** 撤销一条授权（需 confirm） */
    revokeGrant(options: { id: string; path: string; confirm?: boolean }): Promise<{ removed: boolean }>
    /** 清掉某个插件的全部授权（需 confirm） */
    clearGrants(options: { id: string; confirm?: boolean }): Promise<{ removed: boolean }>
    /**
     * 为用户选一个**可写**文件夹（授权模式 write）。设置页用它代插件发起 ——
     * 与插件自己调 `ctx.files.pickWritableDirectory()` 是同一条通道，选谁是用户在对话框里亲手点的。
     */
    pickWritableDirectory(options: { id: string; title?: string }): Promise<{
      cancelled: boolean
      dir: { path: string; name: string; mode?: 'write' } | null
    }>
  }
  clientBundle(id: string): Promise<PluginClientBundle>
  /**
   * 插件委派智能体（`ctx.agent.run` 的主进程侧）。
   *
   * **可选能力**：只有 Electron 桌面端的宿主提供。安卓 / 局域网网页端用的是渲染层本地宿主
   * （`src/platform/pluginHost.ts`），那里没有主进程可执行预算，所以故意不实现它 ——
   * `ctx.agent.available` 在这些平台为 `false`。
   * 宁可"不可用"，也不要"可用但预算无人执行"（见设计 §8.5 的 N3）。
   */
  agentRun?(args: {
    pluginId: string
    presetId: string
    presetName?: string
    presetMaxSteps?: number
    input: string
    budget?: { timeoutMs?: number; maxSteps?: number; maxTokens?: number }
    options: unknown
  }): Promise<AgentRunResult>
  /** 各插件的委派用量快照（设置页展示；只读；同为桌面端可选能力） */
  agentUsage?(): Promise<Record<string, { inFlight: number; callsInWindow: number }>>
  /** 取消某插件全部在飞委派（插件面板的「停止」按钮；同为桌面端可选能力） */
  agentCancel?(args: { pluginId: string }): Promise<{ cancelled: number }>
  /** 某插件的委派状态（同意 + 用量）；设置页「插件 → 数据」用（只读） */
  agentStatus?(args: { pluginId: string }): Promise<{ consent: 'allow' | 'ask' | 'deny'; inFlight: number; callsInWindow: number }>
  /** 改写委派同意（需 confirm；撤销 = 'ask'，改为拒绝 = 'deny'） */
  setAgentConsent?(args: {
    pluginId: string
    consent: 'allow' | 'ask' | 'deny'
    confirm?: boolean
  }): Promise<{ consent: 'allow' | 'ask' | 'deny' }>
  /** 重置某插件的委派用量（需 confirm） */
  resetAgentUsage?(args: { pluginId: string; confirm?: boolean }): Promise<{ cleared: boolean }>
  /** 「插件权限」页签的总览（每插件一行；只读） */
  agentOverview?(): Promise<{ rows: unknown[]; limits: unknown }>
  /** 写某插件的委派额度与 D5 放宽开关（需 confirm） */
  setAgentConfig?(args: {
    pluginId: string
    limits?: { concurrency?: number; callsPerHour?: number }
    relax?: { fs?: boolean; mcp?: boolean }
    /** 工作目录（必须落在该插件的可写文件授权内；'' = 回到默认的知识库根） */
    cwd?: string
    confirm?: boolean
  }): Promise<unknown>
  /** 改写某插件的**工具审批**三态（需 confirm） */
  setToolApproval?(args: {
    pluginId: string
    state: 'allow' | 'ask' | 'deny'
    confirm?: boolean
  }): Promise<{ pluginId: string; state: 'allow' | 'ask' | 'deny' }>
  /** 重新扫描插件目录（可选能力：渲染层宿主用它刷新列表） */
  rescan?(confirm?: boolean): Promise<{
    plugins: PluginSnapshot[]
    rootDir: string
    customRoot: boolean
    services: string[]
    invalidNamedDirs?: string[]
  }>
  /** 从本地文件夹安装插件（P2：主进程弹目录选择框） */
  install(options?: { confirm?: boolean; replace?: boolean }): Promise<{
    cancelled: boolean
    snapshot: PluginSnapshot | null
  }>
  /** 选择插件目录（P2：与技能目录同一交互）；不传 path 则由主进程弹目录选择框 */
  setRoot(options?: { confirm?: boolean; path?: string }): Promise<{ cancelled: boolean; rootDir: string }>
  /** 恢复默认插件目录（userData/plugins） */
  resetRoot(options?: { confirm?: boolean }): Promise<{ cancelled: boolean; rootDir: string }>
  onEvent(cb: (ev: PluginEvent) => void): () => void
}

// ---------------------------------------------------------------------------
// 局域网访客：主机共享的插件（只读浏览面）
// ---------------------------------------------------------------------------

/** 主机 HTTP 插件接口：只提供清单 / 客户端 bundle；管理与文件类操作在访客端一律不可用 */
async function hostPluginApi<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const j = await res.json()
      if (j?.error) msg = j.error
    } catch { /* ignore */ }
    throw new Error(msg)
  }
  return res.json()
}

/**
 * 局域网访客用的插件桥。
 * 只实现插件运行时真正会调用的 list / clientBundle / clientLog / onEvent；
 * 其余方法（启停、安装、文件）在网页端没有意义，统一拒绝。
 */
function createHostGuestPluginBridge(): PluginBridgeApi {
  const unsupported = async (): Promise<never> => {
    throw new Error('局域网访客不能管理主机插件')
  }
  const bridge = {
    list: () => hostPluginApi<{
      plugins: PluginSnapshot[]
      rootDir: string
      customRoot: boolean
      services: string[]
    }>('/api/plugins/list'),
    clientBundle: (id: string) =>
      hostPluginApi<PluginClientBundle>(`/api/plugins/bundle?id=${encodeURIComponent(id)}`),
    clientLog: () => {},
    onEvent: (_cb: (ev: PluginEvent) => void) => () => {},
    // 以下都是桌面端管理 / 数据能力；访客端明确拒绝（插件界面若调用会收到可读错误）
    inspect: unsupported,
    enable: unsupported,
    disable: unsupported,
    reload: unsupported,
    uninstall: unsupported,
    getConfig: unsupported,
    setConfig: unsupported,
    logs: unsupported,
    openDir: unsupported,
    dataFiles: unsupported,
    dataFilesAll: unsupported,
    removeDataFile: unsupported,
    clearDataFiles: unsupported,
    files: {
      grants: unsupported,
      revokeGrant: unsupported,
      clearGrants: unsupported,
      pickWritableDirectory: unsupported,
    },
    rescan: unsupported,
    install: unsupported,
    setRoot: unsupported,
    resetRoot: unsupported,
  }
  return bridge as unknown as PluginBridgeApi
}

/** 取插件桥（不可用时返回 null） */
export function getPluginBridge(): PluginBridgeApi | null {
  if (typeof window === 'undefined') return null
  const api = aikmDsh?.plugin
  if (api && typeof api.list === 'function') return api as PluginBridgeApi
  // 局域网访客页：主机通过 /api/plugins/* 共享清单与客户端 bundle（按主机勾选的插件过滤）
  if (hostRuntime()) {
    cachedGuestHost ||= createHostGuestPluginBridge()
    return cachedGuestHost
  }
  // 非 Electron 平台（安卓）：用渲染层插件宿主（扫插件目录 + 装载界面半边）
  try {
    if (localPluginHostAvailable()) {
      cachedLocalHost ||= createLocalPluginHost()
      return cachedLocalHost
    }
  } catch {
    /* 平台未就绪：按不可用处理 */
  }
  return null
}

let cachedLocalHost: PluginBridgeApi | null = null
let cachedGuestHost: PluginBridgeApi | null = null

/** 当前用的是渲染层宿主（非 Electron）：界面据此调整文案（无插件工具 / 无主进程半边） */
export function isLocalPluginHost(): boolean {
  if (typeof window === 'undefined') return false
  if (hostRuntime()) return false // 局域网访客：插件来自主机，不是本机渲染层宿主
  return !aikmDsh?.plugin && localPluginHostAvailable()
}
