/**
 * agentContract.ts — 插件委派智能体（`ctx.agent.run`）的**契约层**：预算钳制、工具分层、结果归一
 *
 * 纯逻辑、零依赖（只引 `@/lib/agent/capabilities` 那张既有的能力槽表），因此
 * **主进程与渲染层引同一份实现** —— 设计里要求 D5 的工具裁剪"在主进程再执行一次"，
 * 而两边共用同一函数才叫"再执行一次"，不是"各写一份"。
 *
 * 三条与安全直接相关的规矩（都在这里收口，别在调用点重复实现）：
 *
 * 1. **`ok` 由 `termination` 决定，不由调用方给**（`normalizeAgentRunResult`）：
 *    对齐 DSH「只有 completed 会返回规范值…被截断的回答不会被报告为成功，也绝不会被悄悄丢弃」。
 *    失败时 `output` 必须保留中止前的部分文本。
 *
 * 2. **预算只紧不松**（`resolveAgentRunBudget`）：插件申请的每一项都与预设值和宿主上限取 min，
 *    并把"被削掉的项"显式回给插件 —— 不静默降级。
 *
 * 3. **工具面 fail-closed**（`delegableToolFilter`）：以能力槽为单位分三层
 *    （safe / gated / denied），**没登记分层的槽位一律拒绝**。
 *    这一条是刻意的、与 DSH 不同的取舍：DSH 明确写 `toolFilter`「不是从父级派生的权限上限」
 *    并把 agent 作用域的安全列为非目标；AI-KM 是声明式权限的模型，若照抄就会出现
 *    「零权限插件 → 委派一个带 read_file 的预设 → 拿回任意文件内容」这条真实提权链。
 */

import { CAPABILITY_TOOL_SLOTS } from '@/lib/agent/capabilities'
import { checkGrantAccess } from '@/shared/pluginGrantPaths'
import type { PluginPermission } from '@/types/plugin'

// ---------------------------------------------------------------------------
// 预算上限
// ---------------------------------------------------------------------------

/**
 * 各档默认值与硬上限。
 *
 * `maxDepth` 默认 **1**（DSH 是 3）：我们只有进程内一种载体，且被委派的 agent 无法再委派
 * （插件工具在主进程、拿不到界面半边的能力），递归面本就极小；设成 1 是"声明真实语义"。
 *
 * `maxTokens` 在 v1 **不执行**（`enforced: false`）：主进程当前不解析 LLM 用量
 * （见设计 §3 D4 的证据），所以只能事后报告。把它登记在这里是为了让上限有唯一出处，
 * 等 P1.5 落了用量计数再打开 `enforced`，不必改调用点。
 */
export const AGENT_RUN_LIMITS = {
  timeoutMs: { default: 10 * 60_000, min: 5_000, max: 30 * 60_000 },
  maxSteps: { default: 20, min: 1, max: 60 },
  maxTokens: { default: 30_000, min: 1_000, max: 200_000, enforced: false as boolean },
  maxDepth: { default: 1, min: 0, max: 2 },
  /** 每个插件同时在飞的委派数 */
  concurrency: { default: 1, max: 3 },
  /** 每个插件每小时可发起的委派数（本窗口内计数） */
  callsPerHour: { default: 20, max: 200 },
  windowMs: 60 * 60_000,
} as const

/** 插件可以申请的那几档（其余由宿主裁定，插件看不到也改不了） */
export interface AgentRunRequest {
  timeoutMs?: number
  maxSteps?: number
  maxTokens?: number
}

export interface ResolvedAgentRunBudget {
  timeoutMs: number
  maxSteps: number
  /** v1 仅记录；`AGENT_RUN_LIMITS.maxTokens.enforced === false` 时不作为硬上限 */
  maxTokens: number
  /**
   * 被削掉的项（回给插件用，不静默降级）。
   * `source` 区分"被插件自己的申请值/上限削掉"（`request`）与"被预设的步数上限压低"（`preset`）——
   * 两者对插件是同一个结果，但排查时原因完全不同，混在一个数字里会误导。
   */
  clamped: Array<{
    field: 'timeoutMs' | 'maxSteps' | 'maxTokens'
    requested: number
    applied: number
    source: 'request' | 'preset'
  }>
}

function clampNumber(raw: unknown, spec: { default: number; min: number; max: number }): { value: number; requested?: number } {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return { value: spec.default }
  const value = Math.max(spec.min, Math.min(spec.max, Math.floor(n)))
  return { value, requested: Math.floor(n) }
}

/**
 * 把「插件申请」与「预设上限」钳到宿主允许的区间。
 * 只紧不松：任何一项都不可能被放大到默认值以上；已生效的步数取**申请与预设的 min**。
 */
export function resolveAgentRunBudget(
  request: AgentRunRequest | undefined,
  presetMaxSteps?: unknown,
): ResolvedAgentRunBudget {
  const clamped: ResolvedAgentRunBudget['clamped'] = []

  const pick = (
    field: 'timeoutMs' | 'maxSteps' | 'maxTokens',
    spec: { default: number; min: number; max: number },
    raw: unknown,
  ) => {
    const { value, requested } = clampNumber(raw, spec)
    // requested 只在校验通过（正数）时才有值 → 非正数/非法视为"没申请"，回落默认且不记为被削
    if (requested !== undefined && requested !== value) {
      clamped.push({ field, requested, applied: value, source: 'request' })
    }
    return value
  }

  const timeoutMs = pick('timeoutMs', AGENT_RUN_LIMITS.timeoutMs, request?.timeoutMs)
  const maxTokens = pick('maxTokens', AGENT_RUN_LIMITS.maxTokens, request?.maxTokens)
  let maxSteps = pick('maxSteps', AGENT_RUN_LIMITS.maxSteps, request?.maxSteps)

  // 预设自己也可能有步数上限（唯一数据源见 src/shared/agent-loop-rounds.ts）——取 min，只紧不松
  const preset = clampNumber(presetMaxSteps, AGENT_RUN_LIMITS.maxSteps)
  const presetPositive = Number.isFinite(Number(presetMaxSteps)) && Number(presetMaxSteps) > 0
  if (presetPositive && preset.value < maxSteps) {
    clamped.push({ field: 'maxSteps', requested: maxSteps, applied: preset.value, source: 'preset' })
    maxSteps = preset.value
  }

  return { timeoutMs, maxSteps, maxTokens, clamped }
}

/** v1 的 token 上限是否真的会被执行（写在导出里，免得调用点各自判断） */
export function isTokenBudgetEnforced(): boolean {
  return AGENT_RUN_LIMITS.maxTokens.enforced === true
}

// ---------------------------------------------------------------------------
// 每个插件可被用户独立调整的额度（「设置 → 插件 → 插件权限」页签）
// ---------------------------------------------------------------------------

/**
 * 面板里真正可调的只有这两项 —— 它们决定"这个插件能并发跑几个、每小时能跑几次"。
 * 其余（墙钟 / 步数 / token）由**插件申请 + 预设值 + 宿主硬上限**三者取 min 决定，面板不放开：
 * 放开等于让用户替插件放宽"模型能跑多久"，而这类误设很难被发现。
 */
export interface PluginAgentLimits {
  concurrency: number
  callsPerHour: number
}

/** 默认值 = 面板出现之前的历史行为（1 / 20）：已装插件的行为**不因引入面板而改变** */
export const DEFAULT_PLUGIN_AGENT_LIMITS: Readonly<PluginAgentLimits> = Object.freeze({
  concurrency: AGENT_RUN_LIMITS.concurrency.default,
  callsPerHour: AGENT_RUN_LIMITS.callsPerHour.default,
})

/**
 * 把面板 / 存档里读到的额度钳到合法区间。非法或非正数**回落默认值**（不是回落最小值）：
 * 坏存档不该把插件悄悄锁成 1 次/小时。天花板见 `AGENT_RUN_LIMITS`。
 */
export function normalizePluginAgentLimits(raw: unknown): PluginAgentLimits {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const clamp = (v: unknown, max: number, dflt: number) => {
    const n = Math.floor(Number(v))
    if (!Number.isFinite(n) || n <= 0) return dflt
    return Math.max(1, Math.min(max, n))
  }
  return {
    concurrency: clamp(src.concurrency, AGENT_RUN_LIMITS.concurrency.max, DEFAULT_PLUGIN_AGENT_LIMITS.concurrency),
    callsPerHour: clamp(src.callsPerHour, AGENT_RUN_LIMITS.callsPerHour.max, DEFAULT_PLUGIN_AGENT_LIMITS.callsPerHour),
  }
}

/**
 * **主进程实际会读**的 `llmConfig` 字段白名单。
 *
 * 来源：`grep 'llmConfig\.<字段>'` 覆盖 `src/shared` + `electron/main`（流式开关、采样参数、
 * 远端并发基准等）。**新增消费点时把它加到这里**，并补一条自测。
 */
export const LLM_CONFIG_KEYS = [
  'type', 'stream', 'think', 'temperature', 'top_p', 'max_tokens', 'model', 'tools',
  'frequency_penalty', 'presence_penalty', 'options', 'keep_alive',
  'logprobs', 'top_logprobs', 'remoteMaxInflight', 'format',
] as const

/**
 * 从用户的 `llm` 配置里只挑出运行需要的标量，**绝不 `{ ...llm }`**。
 *
 * 这条白名单是一起真实事故的直接修复：原先委派请求里带的是 `{ ...llm }`，即整个模型配置块
 * ——里面装着**全部来源**（deepseek / openai / anthropic / google / 自定义…）以及
 * `custom.sources` 整个数组。两个后果：
 *
 * 1. **把别的来源的 `api_key` 一起送过 IPC**（同机同进程也毫无理由）；
 * 2. `custom.sources` 是自引用的高发地带（`resolveLlmSource` 的 custom 分支做的是
 *    `{ ...llm.custom, ...激活来源 }` 这种浅合并）。一旦出现自引用，渲染层的
 *    `JSON.stringify` 就 RangeError → preload 的 `toPlain` 兜底**原样发送** →
 *    Electron 报 `An object could not be cloned.`，插件作者完全无从下手。
 */
export function pickLlmConfig(llm: Record<string, unknown> | undefined, type: string): Record<string, unknown> {
  const out: Record<string, unknown> = { type, stream: true }
  for (const key of LLM_CONFIG_KEYS) {
    if (key === 'type' || key === 'stream') continue
    const v = llm?.[key]
    if (v !== undefined) out[key] = v
  }
  return out
}

/**
 * 把要过 IPC 的对象**当场**折成纯 JSON 数据；折不动就抛一个**点名到字段**的错误。
 *
 * 为什么需要：Electron 的结构化克隆失败时只会说 `An object could not be cloned.` ——
 * 插件作者（甚至宿主开发者）完全无从下手。而这条链上确实有会折不动的东西：
 * 预设置从 Vue 响应式 store 里读出来，`llmConfig` 曾经是 `{ ...llm }`（把整个模型配置块、
 * 含全部来源与 `custom.sources` 一起带上），只要其中出现自引用，`JSON.stringify` 就
 * RangeError，而 preload 的 `toPlain` 兜底会**原样发送**，于是报错变成那句没法行动的话。
 *
 * 所以：① 请求里不再携带深层 store 数据（见 `agentPresetOptions.ts` 的白名单）；
 * ② 真折不动就在这里点名，而不是让 Electron 抛那句通用错误。
 */
export function toIpcSafe<T>(value: T, label: string): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    throw new Error(`${label} 无法序列化成 IPC 数据（应只含字符串 / 数字 / 布尔 / 数组 / 普通对象）：${why}`)
  }
}

// ---------------------------------------------------------------------------
// 工具分层（D5）
// ---------------------------------------------------------------------------

export type DelegationTier = 'safe' | 'gated' | 'denied'

/** 可以由**用户在面板里按插件放宽**的两类（其余 category 永不放宽） */
export type DelegationRelax = 'fs' | 'mcp'

/** 用户按插件给出的放宽开关（落在主进程，见 electron/main/plugin-agent-config.ts） */
export interface DelegationRelaxFlags {
  fs?: boolean
  mcp?: boolean
}

/**
 * 能力槽 → 委派分层。**建在 `CAPABILITY_TOOL_SLOTS` 这张既有权威表上**，不另编工具名清单
 * （否则新增工具时两处必然漂移——这个项目已经吃过这种亏）。
 *
 * - `safe`：与用户数据/环境无关，直接放行（交互与元信息类）
 * - `gated`：需要插件**自己**先声明对应权限（`needs`）才放行
 * - `denied`：默认不放行；带 `relaxable` 的可以由用户按插件放宽（见下）
 *
 * ### `relaxable` 的边界（重要）
 *
 * `fs` / `mcp` 两档**默认拒绝**，但用户在「设置 → 插件 → 插件权限」里可以按插件放开：
 * - `fs` 还需插件**自己声明了 `fs` 权限**（双条件：用户信任它的文件能力 + 明确开了委派文件工具）。
 *   只声明了 `agent.run` 的插件不该经由委派获得文件能力。
 * - `mcp` 只需用户开关 —— 因为 MCP 服务本身是**用户配置的**，插件只能按 id 引用，不能自定义服务。
 *
 * **永不放宽**的四个：`executeCode` / `runShell` / `skills` / `runSubagent`。理由：
 * 命令执行与代码执行插件想干就自己声明 `shell` 走 `ctx.host.runShell`（那条有独立审批），
 * 不该从委派这条侧门进来；递归委派则与 `maxDepth=1` 的结构性事实冲突。
 */
export const DELEGATION_SLOT_TIERS: Record<
  string,
  { tier: DelegationTier; needs?: PluginPermission; relaxable?: DelegationRelax }
> = {
  // 交互与元信息：不碰用户数据、不碰环境
  askUser: { tier: 'safe' },
  updatePlan: { tier: 'safe' },
  updateTodo: { tier: 'safe' },
  // 受权限门控（不可放宽：门槛就是插件自己的权限声明）
  webSearch: { tier: 'gated', needs: 'net' },
  browseWebsites: { tier: 'gated', needs: 'net' },
  accessKnowledgeBase: { tier: 'gated', needs: 'fs' },
  // 默认拒绝、可由用户按插件放宽
  readFiles: { tier: 'denied', relaxable: 'fs' },
  listDirs: { tier: 'denied', relaxable: 'fs' },
  writeFiles: { tier: 'denied', relaxable: 'fs' },
  mcpAccess: { tier: 'denied', relaxable: 'mcp' },
  // 永不放宽
  executeCode: { tier: 'denied' },
  runShell: { tier: 'denied' },
  skills: { tier: 'denied' },
  runSubagent: { tier: 'denied' },
}

/** 未登记分层的槽位被发现的清单（自测断言它为空；调用侧按 fail-closed 处理） */
export function untieredSlots(): string[] {
  return CAPABILITY_TOOL_SLOTS.map((s) => s.key).filter((k) => !(k in DELEGATION_SLOT_TIERS))
}

/** 永不放宽的槽位（自测拿它断言"开关全开也进不来"） */
export function neverRelaxableSlots(): string[] {
  return Object.entries(DELEGATION_SLOT_TIERS)
    .filter(([, r]) => r.tier === 'denied' && !r.relaxable)
    .map(([k]) => k)
}

/**
 * 由能力槽表推导出"允许委派"的工具名集合（fail-closed：未登记槽位的工具**不在**集合里）。
 *
 * @param relax 用户按插件给出的放宽开关；缺省即全关（= 面板出现之前的行为）
 */
export function delegableToolSet(
  permissions: readonly PluginPermission[],
  relax?: DelegationRelaxFlags,
): Set<string> {
  const allowed = new Set<string>()
  const has = (p: PluginPermission) => permissions.includes(p)
  for (const slot of CAPABILITY_TOOL_SLOTS) {
    const rule = DELEGATION_SLOT_TIERS[slot.key]
    if (!rule) continue // 未登记 → 不放行
    if (rule.tier === 'denied') {
      if (!rule.relaxable) continue
      // fs 档是**双条件**：用户开了开关，且插件自己声明过 fs 权限
      if (rule.relaxable === 'fs' && !(relax?.fs === true && has('fs'))) continue
      if (rule.relaxable === 'mcp' && relax?.mcp !== true) continue
    }
    if (rule.tier === 'gated' && rule.needs && !has(rule.needs)) continue
    for (const t of slot.tools) allowed.add(t)
  }
  return allowed
}

export interface DelegableToolFilterResult {
  /** 实际交给被委派 agent 的工具白名单（`null` 表示"不限制"——本函数**永不**返回 null） */
  allowed: string[]
  /** 被裁掉的工具（供日志/告知，避免"静默降级"） */
  denied: string[]
}

/**
 * 计算被委派 agent 的工具白名单（**权限天花板在这一层**）。
 *
 * @param requestedTools 这次委派**声明想要**的工具：预设的白名单，或插件自己申请的那一份
 *   （插件可自定义工具面 —— 它只是"申请"，仍然要过这里）。`null` = 没声明（退化为"能力槽允许集"）。
 * @param pluginOwnTools 该插件自己注册的工具名（属于它的既有能力，但仍需出现在 `requestedTools` 里）
 * @param relax 用户在面板里按插件给出的放宽开关（见 `DELEGATION_SLOT_TIERS` 的说明）
 */
export function delegableToolFilter(input: {
  requestedTools: string[] | null
  pluginPermissions: readonly PluginPermission[]
  pluginOwnTools?: readonly string[]
  relax?: DelegationRelaxFlags
}): DelegableToolFilterResult {
  const allowedBySlot = delegableToolSet(input.pluginPermissions, input.relax)
  for (const t of input.pluginOwnTools ?? []) allowedBySlot.add(t)

  // 没声明想要哪些（null/undefined）→ 退化为能力槽允许集（**不是**"全放行"）。fail-closed。
  if (!Array.isArray(input.requestedTools)) {
    return { allowed: [...allowedBySlot].sort(), denied: [] }
  }

  const allowed: string[] = []
  const denied: string[] = []
  for (const t of input.requestedTools) {
    if (allowedBySlot.has(t)) allowed.push(t)
    else denied.push(t)
  }
  return { allowed, denied }
}

// ---------------------------------------------------------------------------
// 结果归一
// ---------------------------------------------------------------------------

/**
 * 终止原因。`completed` 是**唯一**返回规范值的终态 —— 其余一律算失败（对齐 DSH 的结果纪律）。
 * `budget` / `consent-denied` 是宿主在起跑前就拒掉的情况。
 */
export type AgentRunTermination =
  | 'completed'
  | 'timeout'
  | 'cancelled'
  | 'maxSteps'
  | 'maxTokens'
  | 'budget'
  | 'consent-denied'
  | 'error'

export interface AgentRunResult {
  /** **由 termination 决定**（`=== 'completed'`），调用方给的 ok 会被忽略 */
  ok: boolean
  termination: AgentRunTermination
  /** 失败时 = 中止前的部分输出（不冒充成功、不丢弃） */
  output: string
  error?: string
  turn: number
  /** v1：事后报告（主进程尚不做硬性 token 拦截，见 AGENT_RUN_LIMITS.maxTokens.enforced） */
  usage?: { inputTokens: number; outputTokens: number }
}

const TERMINATIONS: readonly AgentRunTermination[] = [
  'completed', 'timeout', 'cancelled', 'maxSteps', 'maxTokens', 'budget', 'consent-denied', 'error',
]

export function isAgentRunTermination(v: unknown): v is AgentRunTermination {
  return typeof v === 'string' && (TERMINATIONS as readonly string[]).includes(v)
}

// ---------------------------------------------------------------------------
// 句柄层（`ctx.agents`）：能力收敛 P3
// ---------------------------------------------------------------------------

/**
 * 句柄层的稳定错误码。
 *
 * 与 `termination` 的分工：`termination` 描述**一次运行怎么结束的**（结果里给），
 * 这里描述**调用姿势不对**（抛错）。两者别混：拿句柄做不支持的事抛 `AGENT_UNSUPPORTED`，
 * 而运行本身失败仍然是 `result.termination`。
 */
export const AGENT_ERROR_CODES = [
  'AGENT_UNSUPPORTED',
  'AGENT_DISPOSED',
  'AGENT_NOT_FOUND',
  'AGENT_BAD_REQUEST',
] as const

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number]

export function isAgentErrorCode(v: unknown): v is AgentErrorCode {
  return typeof v === 'string' && (AGENT_ERROR_CODES as readonly string[]).includes(v)
}

/**
 * 句柄流的终态分片。
 *
 * 为什么只有 `finish` 而没有 `text-delta`：委派运行跑在**主进程**，而增量文本走的是按作用域的
 * 事件通道（`assistant/chunk`）。句柄拿不到「这条 IPC 对应哪个 agentId」的映射（`plugin:agent-run`
 * 只返回终态），因此句柄**不假装能流式**——要增量请订阅 `ctx.on('assistant/chunk', …)`。
 * 这条写清楚比给一个"看起来在流"的空壳诚实。
 */
export type AgentChunk =
  | { type: 'status'; phase: 'running' | 'idle'; id: string }
  | { type: 'finish'; id: string; result: AgentRunResult }

/**
 * 把上游（agent-loop / 预算 / 同意）的原始结果归一成对插件可见的形状。
 * **`ok` 一律由 `termination` 决定**，不采信调用方传的 `ok` —— 这条统一在这里收口，
 * 免得某个调用点忘了把 "timeout 但 output 有内容" 标成失败。
 */
export function normalizeAgentRunResult(raw: {
  termination?: unknown
  ok?: unknown
  output?: unknown
  error?: unknown
  timedOut?: unknown
  cancelled?: unknown
  turn?: unknown
  usage?: unknown
}): AgentRunResult {
  let termination: AgentRunTermination
  if (isAgentRunTermination(raw.termination)) {
    termination = raw.termination
  } else if (raw.timedOut === true) {
    termination = 'timeout'
  } else if (raw.cancelled === true) {
    termination = 'cancelled'
  } else if (typeof raw.error === 'string' && raw.error.trim() !== '') {
    termination = 'error'
  } else {
    termination = 'completed'
  }

  const output = typeof raw.output === 'string' ? raw.output : ''
  const result: AgentRunResult = {
    ok: termination === 'completed',
    termination,
    output,
    turn: Number.isFinite(Number(raw.turn)) ? Math.max(0, Math.floor(Number(raw.turn))) : 0,
  }
  if (typeof raw.error === 'string' && raw.error.trim() !== '') result.error = raw.error
  const usage = raw.usage as { inputTokens?: unknown; outputTokens?: unknown } | undefined
  if (usage && Number.isFinite(Number(usage.inputTokens)) && Number.isFinite(Number(usage.outputTokens))) {
    result.usage = { inputTokens: Number(usage.inputTokens), outputTokens: Number(usage.outputTokens) }
  }
  return result
}

// ---------------------------------------------------------------------------
// 调用窗口的纯记账（状态本身落主进程；这里只做可单测的判定）
// ---------------------------------------------------------------------------

/** 丢掉窗口外的时间戳（纯函数，返回新数组） */
export function pruneCallWindow(
  timestamps: readonly number[],
  now: number,
  windowMs: number = AGENT_RUN_LIMITS.windowMs,
): number[] {
  const from = now - windowMs
  return timestamps.filter((t) => Number.isFinite(t) && t > from)
}

/** 本窗口内还能不能再发起一次（返回裁剪后的时间戳，调用方负责存回） */
export function canStartCall(
  timestamps: readonly number[],
  now: number,
  limit: number = AGENT_RUN_LIMITS.callsPerHour.default,
  windowMs: number = AGENT_RUN_LIMITS.windowMs,
): { ok: boolean; used: number; limit: number; timestamps: number[] } {
  const kept = pruneCallWindow(timestamps, now, windowMs)
  return { ok: kept.length < limit, used: kept.length, limit, timestamps: kept }
}

// ---------------------------------------------------------------------------
// 工作目录（被委派 agent 的 cwd）—— 「插件 → 权限」里用户为该插件选的根
// ---------------------------------------------------------------------------

export interface WorkRootInput {
  /** 用户为该插件选的根（空 = 没选，用调用方给的默认） */
  configured?: string
  /** 调用方（渲染层）给的值：知识库根。没配根时原样透传 —— 与面板出现之前逐字节一致 */
  incoming?: string
  /** 该插件的**可写**文件授权根（只有落在这些根里才允许当工作目录） */
  writableRoots: readonly string[]
  caseInsensitive?: boolean
}

export interface WorkRootResolution {
  /** 生效的 cwd（空串 = 没有可用值；`error` 有值时它是拒绝原因，而不是"用默认"） */
  cwd: string
  source: 'default' | 'configured'
  /** 配了但不可用时的可读原因（调用方应当 fail-loud，而不是悄悄退回默认） */
  error?: string
}

/**
 * 决定被委派 agent 的工作目录。
 *
 * 与文件授权**同一套判定**（`checkGrantAccess` 的 `write` 语义），因为这个目录就是相对路径的围栏：
 * `read_file` / `write_file` / `list_dir` 全按它解析（见 `rendererTools.ts` 的 `resolvePath(input.path, ctx.cwd)`）。
 *
 * 两条不许省：
 * - **没配置 → 原样透传调用方给的默认**（不能因为"没配"就把 cwd 清空，那会改掉历史行为）；
 * - **配置了但已不在可写授权内**（用户撤销了那个文件夹）→ 返回 `error`，**不要**退回默认：
 *   悄悄换目录会让 agent 在用户没有预期的位置读写。
 */
export function resolveWorkRoot(input: WorkRootInput): WorkRootResolution {
  const incoming = typeof input.incoming === 'string' ? input.incoming.trim() : ''
  const configured = typeof input.configured === 'string' ? input.configured.trim() : ''
  if (!configured) return { cwd: incoming, source: 'default' }
  const access = checkGrantAccess(
    configured,
    input.writableRoots.map((root) => ({ path: root, mode: 'write' as const })),
    'write',
    input.caseInsensitive === true,
  )
  if (!access.ok) {
    return {
      cwd: '',
      source: 'configured',
      error:
        `该插件的工作目录不可用：${configured}（${access.reason}）—— `
        + '请到「设置 → 插件 → 权限」重新选一个，或先在文件授权里「允许写入某文件夹」',
    }
  }
  return { cwd: configured, source: 'configured' }
}

/**
 * 把生效的工作目录写进系统提示。
 *
 * 为什么必须写：`AgentOptions.cwd` **只做工具路径围栏，模型看不到**（`promptContext.ts:51` 的原话），
 * 于是模型不知道自己在哪、只能猜相对路径 —— DSH 那边 cwd 是提示词变量，这里对齐它。
 *
 * 由**宿主**追加（不让插件或预设自己拼），所以插件没法用一段自造提示把它盖掉；而且写在最后，
 * 预设里若也提了目录，以这里为准。
 */
export function withWorkRootHint(systemPrompt: string | undefined, cwd: string): string {
  const base = typeof systemPrompt === 'string' ? systemPrompt.trimEnd() : ''
  if (!cwd) return base
  const hint = [
    `[工作目录 / Working directory] ${cwd}`,
    '相对路径按这个目录解析；不要在这个目录之外创建或修改文件。',
    'Relative paths resolve against this directory; do not create or modify files outside it.',
  ].join('\n')
  return base ? `${base}\n\n${hint}` : hint
}

