/**
 * bridge.ts — 渲染层访问插件宿主 IPC 的唯一入口
 *
 * 约定了「插件能力只有这些方法」：任何插件相关的 IPC 都从这里走，
 * 组件 / 插件代码不要直接摸 `window.dsh`（便于集中审计与将来换实现）。
 *
 * 非 Electron 环境（浏览器 dev、局域网网页端、文件独立窗口的极端情况）返回 null，
 * 调用方据此静默降级。
 */

import type { PluginDataFileStat, PluginEvent, PluginLogLine, PluginSnapshot } from '@/types/plugin'

/** 客户端插件 bundle（主进程读取后经 IPC 传入，渲染层用 Blob URL 动态 import） */
export interface PluginClientBundle {
  /** 相对插件目录的入口路径（诊断用） */
  entry: string
  /** 入口源码（ESM，单文件） */
  code: string
}

export interface PluginBridgeApi {
  list(): Promise<{ plugins: PluginSnapshot[]; rootDir: string; customRoot: boolean; services: string[] }>
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
  openDir(id?: string): Promise<{ path: string }>
  /** 插件在主进程侧的数据文件（userData/plugins-data/<id>/，见 pluginData.ts） */
  dataFiles(id: string): Promise<{ id: string; entries: PluginDataFileStat[] }>
  /** 一次拿到所有插件的主进程侧数据（列表页显示占用用） */
  dataFilesAll(): Promise<{ byId: Record<string, PluginDataFileStat[]> }>
  /** 删除插件数据目录里的一个文件 / 子目录（需 confirm：会真的删磁盘文件） */
  removeDataFile(id: string, name: string, confirm?: boolean): Promise<{ removed: boolean }>
  /** 删除插件整个主进程数据目录（需 confirm） */
  clearDataFiles(id: string, confirm?: boolean): Promise<{ removed: boolean }>
  clientBundle(id: string): Promise<PluginClientBundle>
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
  const api = (window as any).dsh?.plugin
  return api && typeof api.list === 'function' ? (api as PluginBridgeApi) : null
}
