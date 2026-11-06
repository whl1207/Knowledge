/**
 * pluginServices.ts — 插件「宿主服务面」契约 **v0.4**（P0/P1 部分已接线）
 *
 * 背景与目标见 `docs/plan/DSH插件在AI-KM运行-实施方案（逐文件）.md`。
 * 一句话：把现在挂在 `ctx.host.*` 上的能力，拆成 **DSH 同名的命名服务**，让
 * `dsh-wechat-plugin` / `dsh-jiuling-remote-desktop` 这类「深度宿主插件」能在
 * AI-KM 里按原样运行，同时让 AI-KM 原生插件也能用同一套服务写更复杂的东西。
 *
 * ## 这份文件现在是什么
 *
 * 只是**类型与常量**，没有实现、没有被任何运行时 import：
 * - 先让「服务名 / 方法形状 / 权限 / 半边」有一个可评审的单一事实源；
 * - P0 实施时，再把本文件的类型并入 `src/types/plugin.ts` 的 `PluginContext`、
 *   并把 `PLUGIN_SERVICES` 并入 `src/shared/pluginApiMembers.ts` 的成员表。
 *
 * ## 为什么放在 shared
 *
 * 主进程（宿主服务实现）与渲染层（客户端 shim、设置页诊断、文档自检）都要读同一份
 * 名字与形状。因此本文件**不做 I/O、不 import electron/vue**；`node:http` 只做
 * `import type`（编译期擦除，不产生运行时依赖）。
 *
 * ## 与 DSH 的关系
 *
 * - **服务名与方法形状**对齐 DSH（`sessionController` / `sessions` /
 *   `sessionProjections` / `agents` / `webServer` / `workspaceRegistry` /
 *   `approval` / `userQuestions` / `waterfall`），这样 DSH 插件不用改代码；
 * - **权限与半边**是 AI-KM 自己的加法：DSH 没有声明式权限，AI-KM 有，且这套
 *   声明式权限是跨宿主时唯一能"翻译"的东西（见现有《双向兼容》方案 §D10/D15）。
 *
 * ⚠️ 本文件**不是**对 DSH 的完整复刻：只收录这两个插件实测用到的成员。新增成员
 * 必须同时改 `PLUGIN_SERVICES`、`PluginServiceMap`、成员表与自测（见方案 §P0）。
 *
 * v0.2 修订：补 `PLUGIN_COMPAT_GET_SERVICES`（`homePaths` 这类只经 `ctx.get` 的兼容值），
 * 并写死「未注入 / 缺权限时是抛错桩，不是 undefined」（见方案 §4.0）。
 *
 * v0.3 修订：写清 `selectModel` 的实现口径（逻辑会话别名 + 下一轮重建 agent），
 * 与 `webServer` 独立、九灵不内置等已确认决策对齐。
 *
 * v0.4 修订（P0/P1 已落地）：`sessions / sessionController / sessionProjections / agents`
 * 四个服务已有实现（`electron/main/plugin-services/`），并已接进 `PluginContext` 与成员表；
 * 其余服务仍是草案。P1 的两条限制写在各接口注释里：跨来源换模型不支持、workspaceId 未接。
 */

import type { PluginPermission } from '@/types/plugin'
import type { ToolDefinition } from '@/types/tool'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

// ---------------------------------------------------------------------------
// 服务名与权限
// ---------------------------------------------------------------------------

/**
 * 宿主服务名（与 DSH 同名）。
 *
 * 顺序即文档顺序：会话 → 工具 → 装配 → 交互 → 资源 → 两半边通道。
 */
export const PLUGIN_SERVICE_NAMES = [
  'sessions',
  'sessionController',
  'sessionProjections',
  'agents',
  'tools',
  'webServer',
  'workspaceRegistry',
  'approval',
  'userQuestions',
  'waterfall',
  'process',
  'secrets',
  'schedule',
  'attachments',
  'rpc',
  'rpcHost',
] as const

export type PluginServiceName = (typeof PLUGIN_SERVICE_NAMES)[number]

/**
 * 只经 `ctx.get(name)` 提供的**兼容值**，不是一等服务（不参与 inject / 成员表 / 权限）。
 *
 * `homePaths`：DSH 插件（如微信）会写 `homedir()` 存状态；兼容层用它把写入引到
 * `userData/plugins-data/<id>`，避免污染用户主目录。
 */
export const PLUGIN_COMPAT_GET_SERVICES = ['homePaths'] as const

export type PluginCompatGetService = (typeof PLUGIN_COMPAT_GET_SERVICES)[number]

/**
 * 服务需要的权限。
 *
 * 前 7 个是现有 `PluginPermission`（`fs / shell / net / agent / agent.run / llm / image`），
 * 后面是本次新增——**新增权限是加法**：老插件不声明就永远拿不到新服务，行为不变。
 *
 * 语义边界（尤其别把前两个合并）：
 * - `agent`：只读会话摘要（现有语义），**不能**读正文、不能发消息；
 * - `agent.observe`：订阅**所有**会话的 agent 事件（含正文增量）——最高风险；
 * - `agent.control`：create / prompt / cancel / selectModel，能代替用户下指令。
 */
export type PluginServicePermission =
  | PluginPermission
  | 'agent.observe'
  | 'agent.control'
  | 'net.listen'
  | 'process.spawn'
  | 'secrets'
  | 'schedule'
  | 'attachments'

/** 服务对哪一半可见（`both` = 主进程与界面半边都有） */
export type PluginServiceHalf = 'main' | 'client' | 'both'

/** 一条服务的元数据（实现、成员表、设置页诊断共用） */
export interface PluginServiceSpec {
  readonly name: PluginServiceName
  /** `null` = 不需要权限（例如 `tools.register` 本身不授予任何宿主能力） */
  readonly permission: PluginServicePermission | null
  readonly half: PluginServiceHalf
  /**
   * 兼容装载器在插件**没有写 `inject`** 时是否默认注入。
   * 默认注入只给"低风险且几乎所有插件都要"的服务；高风险服务必须显式 inject。
   */
  readonly injectDefault: boolean
  /** 一句话说明（进作者文档与设置页诊断，不写实现细节） */
  readonly summary: string
}

/**
 * 服务清单（单一事实源）。
 *
 * 规则：`permission` 为 `null` 不等于"零风险"——`tools` 注册本身安全，但注册出的工具
 * 会进入模型上下文；真正的判权在工具执行时（`requiresApproval` / 沙箱策略）。
 */
export const PLUGIN_SERVICES: readonly PluginServiceSpec[] = [
  { name: 'sessions', permission: 'agent', half: 'main', injectDefault: true,
    summary: '会话只读视图：列表、头部、历史投影（不创建、不发消息）' },
  { name: 'sessionController', permission: 'agent.control', half: 'main', injectDefault: false,
    summary: '会话控制：创建/adopt、发消息、取消、模型目录与选择、投影' },
  { name: 'sessionProjections', permission: 'agent', half: 'main', injectDefault: false,
    summary: '会话投影缓存：不激活 agent 也能读到模型选择等投影值' },
  { name: 'agents', permission: 'agent.control', half: 'main', injectDefault: false,
    summary: 'agent 句柄：create / ensureSession / get' },
  { name: 'tools', permission: null, half: 'main', injectDefault: true,
    summary: '工具注册表：register 返回 disposer' },
  { name: 'webServer', permission: 'net.listen', half: 'main', injectDefault: false,
    summary: 'HTTP 路由注册（exact / prefix / upgrade / fallback），默认只绑回环' },
  { name: 'workspaceRegistry', permission: 'agent', half: 'main', injectDefault: false,
    summary: '工作区注册表：list / get / resolveByPath / create' },
  { name: 'approval', permission: 'agent.control', half: 'main', injectDefault: false,
    summary: '权限确认：把一次审批请求交给用户，返回 allowed-once / rejected / cancelled' },
  { name: 'userQuestions', permission: 'agent.control', half: 'main', injectDefault: false,
    summary: '结构化提问：问一组选项/自由回答，返回批量答案' },
  { name: 'waterfall', permission: 'agent.control', half: 'main', injectDefault: false,
    summary: '拦截链：认领审批/提问请求，或 next() 交给下一个回答者' },
  { name: 'process', permission: 'process.spawn', half: 'main', injectDefault: false,
    summary: '受控子进程：白名单二进制 + 参数数组，禁止 shell 字符串' },
  { name: 'secrets', permission: 'secrets', half: 'main', injectDefault: false,
    summary: '插件私有密钥：safeStorage 加密，按插件 id 隔离，界面半边读不到明文' },
  { name: 'schedule', permission: 'schedule', half: 'main', injectDefault: false,
    summary: '定时器：after / every / dailyAt，卸载即撤销' },
  { name: 'attachments', permission: 'attachments', half: 'main', injectDefault: false,
    summary: '附件存取：收发图片/文件，按插件隔离目录' },
  { name: 'rpc', permission: null, half: 'client', injectDefault: false,
    summary: '界面半边 → 本插件主进程半边的方法调用（带超时/取消）' },
  { name: 'rpcHost', permission: null, half: 'main', injectDefault: false,
    summary: '主进程半边注册可被自己界面半边调用的方法' },
] as const

/** 按名字查服务元数据（未知名返回 undefined，调用方自己决定报错还是忽略） */
export function pluginServiceSpec(name: string): PluginServiceSpec | undefined {
  return PLUGIN_SERVICES.find((s) => s.name === name)
}

/** 该服务在某个半边是否可用 */
export function pluginServiceVisibleOn(name: PluginServiceName, half: 'main' | 'client'): boolean {
  const spec = pluginServiceSpec(name)
  if (!spec) return false
  return spec.half === 'both' || spec.half === half
}

// ---------------------------------------------------------------------------
// 稳定错误码（插件按 code 分支，不解析文案）
// ---------------------------------------------------------------------------

export const PLUGIN_SERVICE_ERROR_CODES = [
  /** 清单没声明对应权限，或用户拒绝了本次授权 */
  'PLUGIN_PERMISSION_DENIED',
  /** 服务未注入（没写 inject / 插件处于 pending） */
  'PLUGIN_SERVICE_UNAVAILABLE',
  /** 该宿主没有实现这个服务（例如网页端没有 process） */
  'PLUGIN_UNSUPPORTED',
  /** 参数不合法 */
  'PLUGIN_INVALID_ARGUMENT',
  /** 目标不存在（会话 / 工作区 / 附件） */
  'PLUGIN_NOT_FOUND',
  /** 冲突（重复路由 / 端口占用 / 重复注册） */
  'PLUGIN_CONFLICT',
] as const

export type PluginServiceErrorCode = (typeof PLUGIN_SERVICE_ERROR_CODES)[number]

export function isPluginServiceErrorCode(value: unknown): value is PluginServiceErrorCode {
  return typeof value === 'string' && (PLUGIN_SERVICE_ERROR_CODES as readonly string[]).includes(value)
}

/** 抛给插件的结构化错误形状（实现里用带 code 的 Error 子类，形状对得上即可） */
export interface PluginServiceErrorShape {
  readonly code: PluginServiceErrorCode
  readonly message: string
  readonly service?: PluginServiceName
  /** 缺哪个权限（`PLUGIN_PERMISSION_DENIED` 时给，便于设置页直接跳授权） */
  readonly permission?: PluginServicePermission
}

/**
 * 服务实现统一抛这个错误（插件按 `code` 分支，不解析文案）。
 *
 * 为什么不用裸 `Error`：插件作者要能区分"没权限 / 服务没注入 / 宿主不支持 / 参数错"，
 * 这四类处置完全不同（去声明权限 / 去 inject / 换实现 / 改调用）。
 */
export class PluginServiceError extends Error implements PluginServiceErrorShape {
  readonly code: PluginServiceErrorCode
  readonly service?: PluginServiceName
  readonly permission?: PluginServicePermission

  constructor(
    code: PluginServiceErrorCode,
    message: string,
    extra: { service?: PluginServiceName; permission?: PluginServicePermission } = {},
  ) {
    super(message)
    this.name = 'PluginServiceError'
    this.code = code
    this.service = extra.service
    this.permission = extra.permission
  }
}

/** 判断某个异常是不是本模块的结构化错误（跨模块 / 序列化后也认） */
export function isPluginServiceError(value: unknown): value is PluginServiceError {
  return (
    value instanceof PluginServiceError ||
    (!!value && typeof value === 'object' && isPluginServiceErrorCode((value as { code?: unknown }).code))
  )
}

// ---------------------------------------------------------------------------
// 基础标识与模型
// ---------------------------------------------------------------------------

export type SessionId = string
export type Disposer = () => void

/** 会话列表里的一行（只读摘要） */
export interface SessionSummary {
  readonly sessionId: SessionId
  readonly title?: string
  readonly updatedAt: number
  readonly agentPreset?: string
}

/** 会话头部（DSH 用它判断 cwd / 预设，决定 adopt 是否合法） */
export interface SessionHeader {
  readonly cwd?: string
  readonly agentPreset?: string
}

/** 会话记录（`sessions.get` 的返回；不存在时 undefined） */
export interface SessionRecord {
  readonly header?: SessionHeader
}

/** 会话历史的一条（从 JSONL 事件日志投影而来，不是第二份消息状态） */
export interface TranscriptEntry {
  readonly role: 'user' | 'assistant' | 'tool' | 'system'
  readonly content: string
  readonly ts?: number
  readonly toolName?: string
  readonly toolCallId?: string
}

/** 一次模型选择（provider + model + 可选推理档） */
export interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface ModelReasoningEffort {
  readonly id: string
  readonly name: string
  readonly description?: string
}

export interface ModelCatalogModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly reasoning?: {
    readonly efforts: readonly ModelReasoningEffort[]
    readonly defaultEffort?: string
  }
}

export interface ModelProviderGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly ModelCatalogModel[]
}

export interface ModelCatalogFailure {
  readonly id: string
  readonly name: string
  readonly message: string
}

/**
 * 部署级模型目录（只读，宿主所有）。
 *
 * 边界：插件**只能在这个目录里选**，不能自带 provider / 密钥（与 `ctx.llm` 同一条红线）。
 * AI-KM 的目录来自渲染层的模型来源配置，需要主进程侧拿一份快照（LAN 共享已有同类做法）。
 */
export interface ModelCatalog {
  readonly default: ModelSelection
  readonly routableProviders: readonly string[]
  readonly groups: readonly ModelProviderGroup[]
  readonly failures: readonly ModelCatalogFailure[]
}

export interface ModelSelectionProjection {
  readonly lastUsed: ModelSelection | null
  readonly next: ModelSelection | null
}

/** 一个会话当前已注册的投影值（只收录本契约用到的部分） */
export interface SessionProjections {
  readonly modelSelection?: ModelSelectionProjection
}

export interface Workspace {
  readonly id: string
  readonly path: string
  readonly title: string
  setTitle(title: string): Promise<void>
}

// ---------------------------------------------------------------------------
// 服务接口
// ---------------------------------------------------------------------------

/** 会话只读视图（对应 DSH `sessions`） */
export interface PluginSessionsService {
  /** 取一个会话的头部；不存在 / 已归档时 undefined */
  get(id: SessionId): SessionRecord | undefined
  /** 最近会话，新的在前 */
  list(): readonly SessionSummary[]
  /**
   * 历史投影（从 JSONL 事件日志派生；不启动 agent）。
   *
   * 权限：`get/list` 只需要 `agent`（摘要）；**读正文要 `agent.observe`**，否则抛
   * `PLUGIN_PERMISSION_DENIED`。
   */
  transcript(id: SessionId, options?: { limit?: number }): Promise<readonly TranscriptEntry[]>
}

export interface SessionCreateRequest {
  /** 给了就按 id 幂等 adopt（DSH 的会话映射能跨重启活下来，靠的就是它） */
  readonly sessionId?: SessionId
  readonly cwd?: string
  /** 与 cwd 二选一（DSH 的约束：不能同时给） */
  readonly workspaceId?: string
  readonly agentPreset?: string
}

export interface SessionCreateResult {
  readonly sessionId: SessionId
  readonly agentPreset?: string
}

export interface PromptContent {
  readonly type: 'text'
  readonly text: string
}

export interface SessionPromptRequest {
  readonly requestId: string
  readonly sessionId: SessionId
  /** 已有 turn 在跑时：queue = 排队，steer = 打断 */
  readonly mode: 'queue' | 'steer'
  readonly content: readonly PromptContent[]
  readonly clientTimeZone?: string
}

/** 会话控制（对应 DSH `sessionController`） */
export interface PluginSessionControllerService {
  create(request: SessionCreateRequest): Promise<SessionCreateResult>
  prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<{ readonly accepted: true }>
  cancel(request: { readonly sessionId: SessionId }): Promise<void>
  list(request: object, signal: AbortSignal): Promise<{ readonly items: readonly SessionSummary[] }>
  modelCatalog(): Promise<ModelCatalog>
  /**
   * 一个会话的投影值（模型选择等）。
   *
   * 可选：实现不了就返回 null，调用方应回落到目录默认值，而不是让命令失败。
   */
  projections?(request: { readonly sessionId: SessionId }, signal?: AbortSignal): Promise<{ readonly values?: SessionProjections } | null>
  /**
   * 把某个会话指向一个模型（微信 `/model` 用）。
   *
   * AI-KM 的会话在创建时就固定了 provider/config（`canResumeWith` 把换模型视为新会话），
   * 因此实现按「逻辑会话 id + 物理 agent id」别名表落地：本方法只记 pending，下一次
   * `prompt` 用新模型重建 agent（历史经 `seedHistory` 带回），逻辑会话 id 保持不变。
   *
   * provider/model 不在目录内必须抛错；`reasoningEffort` 不支持时可忽略但要在文档写明。
   */
  selectModel(request: {
    readonly sessionId: SessionId
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }): Promise<{ readonly selected: ModelSelection }>
}

/** 投影缓存（对应 DSH `sessionProjections`） */
export interface PluginSessionProjectionsService {
  /** 不激活 agent 也能读；不存在时 undefined */
  cachedSnapshot(id: SessionId): SessionProjections | undefined
}

/** agent 句柄（对应 DSH `agents`） */
export interface AgentHandle {
  readonly sessionId: SessionId
  readonly agentPreset?: string
}

export interface PluginAgentsService {
  create(request: SessionCreateRequest): Promise<AgentHandle>
  /** 有则取、没有则建（DSH 语义：不重复激活） */
  ensureSession(request: { readonly sessionId?: SessionId; readonly cwd?: string; readonly agentPreset?: string }): Promise<AgentHandle>
  get(id: string): AgentHandle | undefined
}

/** 工具注册表（对应 DSH `tools`；与现有 `ctx.tool` 同一实现） */
export interface PluginToolsService {
  register(definition: ToolDefinition): Disposer
}

export type WebRouteKind = 'exact' | 'prefix'

export interface WebRouteHandler {
  (req: IncomingMessage, res: ServerResponse): void | Promise<void>
}

export interface WebUpgradeHandler {
  (req: IncomingMessage, socket: Duplex, head: Buffer): void | Promise<void>
}

export interface PluginWebRoute {
  readonly kind: WebRouteKind
  /** 绝对路径，无尾斜杠 */
  readonly path: string
  readonly handler: WebRouteHandler
}

export interface PluginWebUpgradeRoute {
  readonly path: string
  readonly handler: WebUpgradeHandler
}

/**
 * HTTP 路由服务（对应 DSH `webServer`）。
 *
 * 安全边界（实现必须遵守，写在这里防止以后被"顺手放宽"）：
 * - **每个插件一个独立 `http.Server`**（已确认）：端口 0 = OS 分配，不复用宿主 LAN 共享的 3345；
 *   不同插件的路由互不可见，插件卸载即关；
 * - 默认只绑 `127.0.0.1`；要对外必须走远程访问网关，插件不能自己开 `0.0.0.0`；
 * - 重复 `(kind, path)` 抛 `PLUGIN_CONFLICT`；
 * - 卸载时路由必须全部摘掉、server 必须关，端口释放。
 */
export interface PluginWebServerService {
  readonly port: number
  register(route: PluginWebRoute): Disposer
  registerUpgrade(route: PluginWebUpgradeRoute): Disposer
  /** 未被具名路由命中的请求（一个所有者；第二次注册抛错） */
  registerFallback(handler: WebRouteHandler): Disposer
}

/** 工作区注册表（对应 DSH `workspaceRegistry`） */
export interface PluginWorkspaceRegistryService {
  resolveByPath(path: string): Promise<Workspace | undefined>
  create(path: string): Promise<Workspace>
  get(id: string): Workspace | undefined
  list(): readonly Workspace[]
  /** 已归档会话（注册表全局一份；没有归档概念时省略） */
  readonly archivedSessionIds?: readonly string[]
}

/** 审批结果（与 DSH 的词表一致，插件按这个分支） */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled'

/**
 * 一次审批请求。
 *
 * 形状是宿主所有的，插件只读已知字段；其余字段原样透传（DSH 插件会把它整个渲染成
 * 手机上的提示）。所以这里留索引签名，而不是把 DSH 的内部结构抄死。
 */
export interface ApprovalRequest {
  readonly requestId: string
  readonly sessionId?: SessionId
  readonly toolName?: string
  readonly reason?: string
  readonly displayReason?: string
  readonly command?: string
  readonly [key: string]: unknown
}

export interface PluginApprovalService {
  request(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalOutcome>
}

export interface QuestionOption {
  readonly label: string
  readonly description?: string
}

export interface QuestionItem {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly QuestionOption[]
  readonly multiSelect?: boolean
}

export interface QuestionAnswer {
  readonly id: string
  readonly selected: string[]
  readonly custom?: string
}

export interface PluginUserQuestionsService {
  ask(
    questions: readonly QuestionItem[],
    options?: { readonly sessionId?: SessionId; readonly signal?: AbortSignal },
  ): Promise<readonly QuestionAnswer[]>
}

/** 可拦截的事件名（DSH 的 waterfall 只在这两类上有意义） */
export type PluginWaterfallEvent = 'approval/request' | 'user-questions/request' | (string & {})

/** `next()` = 交给下一个回答者；返回 outcome = 认领本次请求 */
export type WaterfallHandler<T = unknown> = (payload: T, next: () => Promise<T>) => Promise<T>

/**
 * 拦截链（对应 DSH `waterfall`）。
 *
 * 这就是"手机能回答桌面弹出的审批"的机制：插件认领自己绑定的会话，其余 `next()` 放行，
 * 桌面体验一行不变。
 */
export interface PluginWaterfallService {
  on<T = unknown>(event: PluginWaterfallEvent, handler: WaterfallHandler<T>): Disposer
}

export interface SpawnOptions {
  readonly cwd?: string
  readonly env?: Record<string, string>
  readonly signal?: AbortSignal
}

/**
 * 受控子进程句柄。
 *
 * 为什么不是 `runShell(command: string)`：字符串要过 shell 解析，等于把注入面重新打开。
 * 本服务只接受**二进制 + 参数数组**，且二进制必须在白名单里（`cloudflared` 等）。
 */
export interface SpawnedProcess {
  readonly pid: number | undefined
  onStdout(listener: (chunk: string) => void): Disposer
  onStderr(listener: (chunk: string) => void): Disposer
  onExit(listener: (code: number | null, signal: string | null) => void): Disposer
  kill(signal?: string): boolean
}

export interface PluginProcessService {
  spawn(bin: string, args?: readonly string[], options?: SpawnOptions): SpawnedProcess
}

/**
 * 插件私有密钥。
 *
 * 存储：`safeStorage` 加密后落 `userData/plugins-data/<id>/secrets.bin`；
 * 界面半边**永远拿不到明文**（要显示就显示掩码）。
 */
export interface PluginSecretsService {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<boolean>
  keys(): Promise<readonly string[]>
}

/** 定时器（卸载即撤销；进程退出前不保证触发） */
export interface PluginScheduleService {
  after(delayMs: number, fn: () => void | Promise<void>): Disposer
  every(intervalMs: number, fn: () => void | Promise<void>): Disposer
  /** 每天本地时间 hh:mm（用于"每天 9 点汇总"这类） */
  dailyAt(hour: number, minute: number, fn: () => void | Promise<void>): Disposer
}

export interface AttachmentInput {
  readonly name: string
  readonly mime?: string
  /** 二选一：内存字节，或本机已有文件路径（需在授权范围内） */
  readonly bytes?: Uint8Array
  readonly path?: string
}

export interface PluginAttachment {
  readonly id: string
  readonly name: string
  readonly mime: string
  readonly size: number
  /** 落盘路径（主进程半边可见；界面半边不要假设它可读） */
  readonly path?: string
}

export interface PluginAttachmentsService {
  save(input: AttachmentInput): Promise<PluginAttachment>
  read(id: string): Promise<Uint8Array>
  list(): Promise<readonly PluginAttachment[]>
  remove(id: string): Promise<boolean>
}

/** 界面半边 → 本插件主进程半边（不是任意宿主任意方法） */
export interface PluginRpcService {
  call<T = unknown>(
    method: string,
    args?: unknown,
    options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Promise<T>
}

/** 主进程半边注册可被自己界面半边调用的方法 */
export interface PluginRpcHostService {
  handle(method: string, handler: (args: unknown) => unknown | Promise<unknown>): Disposer
}

/** 服务名 → 服务类型（新增服务时这里必须同步，否则自测会红） */
export interface PluginServiceMap {
  sessions: PluginSessionsService
  sessionController: PluginSessionControllerService
  sessionProjections: PluginSessionProjectionsService
  agents: PluginAgentsService
  tools: PluginToolsService
  webServer: PluginWebServerService
  workspaceRegistry: PluginWorkspaceRegistryService
  approval: PluginApprovalService
  userQuestions: PluginUserQuestionsService
  waterfall: PluginWaterfallService
  process: PluginProcessService
  secrets: PluginSecretsService
  schedule: PluginScheduleService
  attachments: PluginAttachmentsService
  rpc: PluginRpcService
  rpcHost: PluginRpcHostService
}

/**
 * 注入后才存在：没写 `inject` 的插件拿不到对应成员。
 *
 * 运行期语义（别按 `undefined` 实现，见方案 §4.0）：
 * - 没 `inject` → 访问抛 `PLUGIN_SERVICE_UNAVAILABLE`；
 * - 清单缺对应权限 → 抛 `PLUGIN_PERMISSION_DENIED`；
 * - 宿主没有该服务 → 抛 `PLUGIN_UNSUPPORTED`。
 * 类型上保留可选，是为了让宿主侧可以"只提供已授权的服务"；插件侧拿到的是抛错桩，
 * 而不是 `undefined`（`undefined` 只会得到一句看不懂的 TypeError）。
 */
export type PluginServices = { readonly [N in keyof PluginServiceMap]?: PluginServiceMap[N] }

// ---------------------------------------------------------------------------
// 全局事件（与 DSH 同名；默认不广播，必须显式声明 global）
// ---------------------------------------------------------------------------

/**
 * 可全局订阅的事件（需要 `agent.observe`）。
 *
 * 为什么要单独列：默认的 `ctx.on` 是**按作用域**的（只收自己委派的 agent），这是隐私保护。
 * 全局观测会把**别人的会话正文**也推给插件，所以必须是显式声明 + 设置页明示。
 */
export const PLUGIN_GLOBAL_EVENTS = [
  'session/created',
  'agent/assistant-stream',
  'tools/result',
  'approval/request',
  'user-questions/request',
] as const

export type PluginGlobalEvent = (typeof PLUGIN_GLOBAL_EVENTS)[number]

/** 一帧 assistant 流（形状对齐 DSH；AI-KM 侧由 agent 事件适配） */
export interface AssistantStreamFrame {
  readonly revision?: number
  readonly type: 'start' | 'chunk' | 'end'
  readonly attemptId?: string
  readonly turn?: number
  readonly step?: number
  /** chunk 的内容（DSH 的模型块，文本在更下一层；适配层负责拍平） */
  readonly chunk?: unknown
}

export interface AssistantStreamPayload {
  readonly sessionId?: SessionId
  /** DSH 原生读法：`payload.agent.session.id`（插件按这个键过滤会话） */
  readonly agent?: { readonly session?: { readonly id?: SessionId } }
  readonly frame?: AssistantStreamFrame
}

export interface SessionCreatedEvent {
  readonly sessionId: SessionId
  readonly cwd?: string
  readonly agentPreset?: string
}

export interface ToolResultEvent {
  readonly sessionId?: SessionId
  readonly toolName?: string
  readonly ok?: boolean
  readonly error?: string
}

export interface PluginGlobalEventMap {
  'session/created': SessionCreatedEvent
  'agent/assistant-stream': AssistantStreamPayload
  'tools/result': ToolResultEvent
  'approval/request': ApprovalRequest
  'user-questions/request': readonly QuestionItem[]
}

// ---------------------------------------------------------------------------
// 半边可见性（给客户端 shim 与诊断用）
// ---------------------------------------------------------------------------

/** 界面半边**能**直接看到的服务（其余只能经 `rpc` 绕到主进程） */
export const PLUGIN_CLIENT_VISIBLE_SERVICES: readonly PluginServiceName[] = PLUGIN_SERVICES
  .filter((s) => s.half === 'both')
  .map((s) => s.name)

/**
 * 界面半边**不存在**的服务 → 正确做法。
 *
 * 与 `pluginApiMembers.ts` 的 `CLIENT_CTX_ABSENT` 同一纪律：写错时报"该去哪"，不返回
 * undefined 让作者以为"没装"。
 */
export const PLUGIN_CLIENT_ABSENT_SERVICES: Readonly<Record<string, string>> = {
  sessionController: '会话控制只在主进程半边：界面半边请经 ctx.rpc.call 转给自己插件的主进程半边',
  sessions: '会话只读视图只在主进程半边：界面半边请经 ctx.rpc.call 转给自己插件的主进程半边',
  sessionProjections: '投影只在主进程半边：界面半边请经 ctx.rpc.call 转给自己插件的主进程半边',
  agents: 'agent 句柄只在主进程半边：界面半边请经 ctx.rpc.call 转给自己插件的主进程半边',
  tools: '注册工具在主进程半边（index.mjs 的 ctx.tools.register）；界面半边没有',
  webServer: 'HTTP 路由只在主进程半边；界面半边没有（不要试图从渲染层开端口）',
  workspaceRegistry: '工作区注册表只在主进程半边；界面半边没有',
  approval: '审批只在主进程半边；界面半边没有',
  userQuestions: '结构化提问只在主进程半边；界面半边没有',
  waterfall: '拦截链只在主进程半边；界面半边没有',
  process: '子进程只在主进程半边，且需要 process.spawn 权限',
  secrets: '密钥只在主进程半边；界面半边读不到明文',
  schedule: '定时器只在主进程半边；界面半边用 setTimeout 并自己清理',
  attachments: '附件只在主进程半边；界面半边用 ctx.files 选文件后经 rpc 上传',
  rpcHost: '注册被调方法在主进程半边；界面半边用的是 ctx.rpc.call',
}
