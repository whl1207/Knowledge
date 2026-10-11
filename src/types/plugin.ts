/**
 * plugin.ts — 插件系统类型契约（P0：主进程插件宿主）
 *
 * 借鉴 DeepSeek-Harness 的「一切皆插件」骨架，但只保留两条真正带来收益的语义：
 * - **注册即副作用、卸载即撤销**：`ctx.tool` / `ctx.service` / `ctx.on` / `ctx.effect`
 *   全部返回 disposer，卸载时按注册顺序**逆序**执行（对齐 Cordis 的 fiber dispose）；
 * - **依赖驱动加载**：清单 `inject` 声明的宿主服务未就绪时插件停在 `pending`，
 *   服务出现后自动装载（对齐 Cordis 的 inject 等待）。
 *
 * 有意简化（理由见 docs/plan/插件与工作台-实施方案（逐文件）.md §〇）：
 * 不做 profile / bundle / patch 分层装配，不做插件间服务热替换，不做远程安装。
 *
 * 本文件被主进程与渲染进程共用（无 node/DOM 运行时依赖）。
 */

import type { PluginId } from '@/types/ids'
import type { ToolDefinition, ToolRegistryEventMap } from '@/types/tool'

/**
 * 宿主 API 主版本。
 * 插件清单的 `apiVersion` 必须匹配本版本，否则「可安装但保持禁用并给出原因」
 * （对齐 dsh 的 `listBundles` 携带 error、`enabled` 只表示保存的选择）。
 */
export const PLUGIN_HOST_API_VERSION = 1

/** 插件权限类别：声明即向用户公开，未声明则对应宿主能力直接拒绝 */
export type PluginPermission = 'fs' | 'shell' | 'net' | 'agent' | 'llm'

/**
 * 插件运行态（对齐 Cordis fiber 状态机的可见投影）。
 * `invalid` = 清单/入口校验未通过；`pending` = 依赖服务未就绪；`disabled` = 用户关闭。
 */
export type PluginStatus =
  | 'discovered'
  | 'invalid'
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'disabled'

/** 渲染层半边声明（P0 只做校验与展示，真正加载在 P1） */
export interface PluginClientDecl {
  /** 相对插件目录的入口文件（ESM） */
  entry: string
  /** 依赖的渲染层插件（按 id） */
  inject?: string[]
}

/** 插件清单：写在插件包 `package.json` 的 `aikm` 字段（对齐 dsh 的 `dsh` 字段做法） */
export interface AikmPluginManifest {
  /** 唯一 id（小写 kebab-case 风格，必须与目录名一致；工具 scope = `plugin:<id>`） */
  id: string
  /** 展示名 */
  name: string
  /** 语义化版本 */
  version: string
  /** 要求宿主 API 版本区间，如 `^1` / `>=1 <2` / `1`；`*` 表示任意 */
  apiVersion: string
  /** 主进程入口（相对插件目录），省略表示纯 UI 插件 */
  main?: string
  /** 渲染层半边 */
  client?: PluginClientDecl
  /** 依赖的宿主服务名（由 ctx.service 提供），未就绪时插件停在 pending */
  inject?: string[]
  /** 权限申请（见 PluginHostApi 各项的判权规则） */
  permissions?: PluginPermission[]
  description?: string
  /** 声明式清单（设置页展示与越界预检用；真实注册仍以运行时代码为准） */
  declares?: {
    tools?: string[]
    slots?: string[]
  }
}

export type PluginLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 插件日志行（进 plugin/log 事件，供设置页查看） */
export interface PluginLogLine {
  ts: number
  level: PluginLogLevel
  message: string
}

/** 插件只读快照（IPC 序列化与设置页展示的唯一形状） */
export interface PluginSnapshot {
  id: PluginId
  name: string
  version: string
  apiVersion: string
  description: string
  /** 插件目录绝对路径 */
  dir: string
  status: PluginStatus
  /** 用户选择（持久化）：false = 已禁用 */
  enabled: boolean
  permissions: PluginPermission[]
  inject: string[]
  /** 已注册工具名（scope = `plugin:<id>`） */
  tools: string[]
  /** 已提供的服务名 */
  services: string[]
  hasMain: boolean
  hasClient: boolean
  /** 渲染层半边入口（相对插件目录；无 client 半边为 null） */
  clientEntry: string | null
  /** 插件配置（用户在设置页「插件 → 配置」里保存的 JSON；渲染层半边可读） */
  config: Record<string, unknown>
  /** 清单声明的槽位（P1 才真正渲染） */
  declaredSlots: string[]
  /** 失效原因（status = invalid / failed 时非空） */
  error: string | null
  loadedAt: number | null
}

/** 插件插件事件（主 → 渲染广播；`plugin/changed` 后应重新拉取 list） */
export type PluginEvent =
  | { type: 'plugin/changed'; id: PluginId; snapshot: PluginSnapshot | null }
  | { type: 'plugin/log'; id: PluginId; line: PluginLogLine }
  | { type: 'plugin/notify'; id: PluginId; message: string }

/** 插件私有键值存储（落在 userData/plugins-data/<id>/storage.json） */
export interface PluginStorage {
  get<T = unknown>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  keys(): Promise<string[]>
}

/** 插件日志器：同时写文件与控制台，并经 plugin/log 事件推给设置页 */
export interface PluginLogger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** shell 执行结果（对齐 shell-service 的字段，去掉 success 由调用方判断） */
export interface PluginShellResult {
  code: number
  stdout: string
  stderr: string
  error?: string
}

/**
 * 受权限约束的宿主能力。
 *
 * ⚠️ 权限是**透明化与误操作防护**，不是真正的沙箱：
 * 插件代码与宿主同进程（对齐 dsh「已安装的宿主代码在宿主进程内运行，不受工作区沙箱约束」），
 * 因此设置页必须在启用前把声明权限展示给用户。
 */
export interface PluginHostApi {
  /** 读插件目录内文件（相对路径）；越界抛错 */
  readFile(relPath: string): Promise<string>
  /** 写插件目录内文件（相对路径）；越界抛错 */
  writeFile(relPath: string, content: string): Promise<void>
  /** 列目录（默认插件目录根） */
  listDir(relPath?: string): Promise<string[]>
  /**
   * 执行 shell：需声明 `shell` 权限，且沙箱策略必须放行（默认 fail-closed 为 safe）。
   * `opts.policy` 由调用方显式传 'trusted' 才放行——与 `run_shell` 工具同一策略模型。
   */
  runShell(command: string, opts?: { policy?: string; cwd?: string }): Promise<PluginShellResult>
  /** 网络请求：需声明 `net` 权限 */
  fetch(url: string, init?: RequestInit): Promise<Response>
  /** 会话日志只读视图：需声明 `agent` 权限 */
  sessions: {
    list(): Promise<Array<{ id: string; events: number; lastTs: number }>>
  }
  /** 向用户提示（广播到渲染层，主窗口弹出提示） */
  notify(message: string): void
}

/** 宿主事件目录：工具注册表事件 + 插件生命周期事件 */
export interface HostEventMap extends ToolRegistryEventMap {
  'plugin/loaded': { id: PluginId; tools: string[]; services: string[] }
  'plugin/unloaded': { id: PluginId; reason: string }
  'plugin/error': { id: PluginId; error: string }
}

/** 插件上下文：所有注册方法返回 disposer，卸载时逆序执行 */
export interface PluginContext {
  readonly plugin: {
    id: PluginId
    name: string
    version: string
    /** 插件目录绝对路径 */
    dir: string
  }
  /** 过滤后的用户配置（宿主负责持久化，见 plugin:setConfig） */
  readonly config: Readonly<Record<string, unknown>>

  /** 注册工具 → `toolRegistry.register(def, 'plugin:<id>')` */
  tool(def: ToolDefinition): () => void
  /** 提供服务供其它插件 inject */
  service<T = unknown>(name: string, impl: T): () => void
  /** 读取服务（未就绪返回 undefined；配合 inject 一般不会遇到） */
  getService<T = unknown>(name: string): T | undefined
  /** 订阅宿主事件 */
  on<T extends keyof HostEventMap>(type: T, listener: (ev: HostEventMap[T]) => void): () => void
  /** 注册副作用：`fn` 立即执行，其返回的清理函数在卸载时调用；返回值可提前撤销本效果 */
  effect(fn: () => void | (() => void | Promise<void>)): () => void

  readonly host: PluginHostApi
  readonly storage: PluginStorage
  readonly log: PluginLogger
}

/** 插件模块的期望导出形状（默认导出或具名 `apply` 皆可） */
export interface AikmPluginModule {
  inject?: string[]
  apply(ctx: PluginContext): void | Promise<void>
}
