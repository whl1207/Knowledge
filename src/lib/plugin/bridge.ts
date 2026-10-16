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
import { createLocalPluginHost, localPluginHostAvailable } from '@/platform/pluginHost'
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
    grants(options: { id: string }): Promise<{ id: string; entries: Array<{ path: string; isDir: boolean; exists: boolean }> }>
    /** 撤销一条授权（需 confirm） */
    revokeGrant(options: { id: string; path: string; confirm?: boolean }): Promise<{ removed: boolean }>
    /** 清掉某个插件的全部授权（需 confirm） */
    clearGrants(options: { id: string; confirm?: boolean }): Promise<{ removed: boolean }>
  }
  clientBundle(id: string): Promise<PluginClientBundle>
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

/** 取插件桥（不可用时返回 null） */
export function getPluginBridge(): PluginBridgeApi | null {
  if (typeof window === 'undefined') return null
  const api = aikmDsh?.plugin
  if (api && typeof api.list === 'function') return api as PluginBridgeApi
  // 非 Electron 平台（安卓 / 局域网网页端）：用渲染层插件宿主（扫插件目录 + 装载界面半边）
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

/** 当前用的是渲染层宿主（非 Electron）：界面据此调整文案（无插件工具 / 无主进程半边） */
export function isLocalPluginHost(): boolean {
  if (typeof window === 'undefined') return false
  return !aikmDsh?.plugin && localPluginHostAvailable()
}
