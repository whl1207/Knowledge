/**
 * contextUsage.ts — 主页右上角「上下文占用圆环」的两个输入：已用 token（估算）与窗口上限
 *
 * 历史问题（本模块集中修复）：
 *  1) 上限写死 1M → DeepSeek(128K) / OpenAI(128K) / Anthropic(200K) 的占用率被低估几十倍；
 *  2) Ollama 只认模型上限（还写死了 `llama.context_length`），而手动调小的上下文长度不可见；
 *  3) 回退估算只累加消息正文，漏掉知识库召回片段 / 工具调用结果 / system prompt / 工具 schema / 图片；
 *  4) 手填的「窗口上限」是全局单值，切换来源后仍然生效（分母变成别的来源的值）。
 *
 * ⚠️ 关于 Ollama「手动设置的上下文长度」（实测 Ollama 0.34.1，2026-09）：
 *   桌面端设置里的 context_length 会以 `OLLAMA_CONTEXT_LENGTH` 环境变量下发给服务进程，
 *   不放进 Modelfile（`/api/show` 的 parameters 里没有 num_ctx），也**没有任何公开 HTTP 接口**能读到
 *   （已逐个探测：app 的 UI 服务 `/api/v1/settings` 对外部请求返回 403）。它对外的**唯一可见形式**
 *   就是已加载实例的 `/api/ps` → `models[].context_length`。因此：
 *     · 模型已加载时：/api/ps 给出真正生效的值（含手动设置）；
 *     · 模型未加载时：读不到，只能回退——本模块用「上次读到的值」持久化（contextWindowProbed）
 *       把它记住，避免每次启动都错回退到模型上限。
 *
 * 上限来源优先级（resolveContextLimit）：
 *   手动覆盖（来源级） > 后端探测到的真实值 > 模型名关键字 > 来源默认值 > 未知兜底
 */

import { normalizeLlmType } from '@/shared/llmSources'
// token 估算与压缩预算口径统一放在 @/shared/contextBudget（主进程 agent-loop 共用同一实现）
import {
  estimateTokens,
  CONTEXT_WARN_RATIO,
  CONTEXT_COMPACT_RATIO,
  FALLBACK_CONTEXT_WINDOW,
  IMAGE_TOKEN_ESTIMATE,
  TOOL_SCHEMA_TOKEN_ESTIMATE,
  clampTokenScale,
  estimateMessagesTokens,
  type BudgetMessage,
} from '@/shared/contextBudget'

export {
  estimateTokens,
  estimateMessagesTokens,
  CONTEXT_WARN_RATIO,
  CONTEXT_COMPACT_RATIO,
  IMAGE_TOKEN_ESTIMATE,
  TOOL_SCHEMA_TOKEN_ESTIMATE,
}

/** 完全无法判定窗口时的兜底分母（主流云端模型常见档位；tooltip 会显式标注「未知」） */
export const UNKNOWN_CONTEXT_WINDOW = FALLBACK_CONTEXT_WINDOW

/** 来源默认窗口（tokens）：仅在模型名关键字未命中时使用 */
const PROVIDER_CONTEXT_WINDOW: Record<string, number> = {
  openai: 128_000,
  deepseek: 128_000,
  anthropic: 200_000,
  google: 1_048_576,
  azure: 128_000,
  // 本地自托管：仅在 /api/show 等都读不到时的最后兜底。
  // 注意 Ollama 未手动设置时默认按模型自身的 context_length 加载（/api/show 通常能读到，会盖住这里）；
  // 手动调小时则以 /api/ps 的已加载实例窗口为准。
  ollama: 8_192,
  lmstudio: 32_768,
  gpustack: 32_768,
  custom: UNKNOWN_CONTEXT_WINDOW,
}

/** 模型名关键字 → 窗口（按数组顺序优先匹配，越具体越靠前） */
const MODEL_CONTEXT_WINDOW: Array<[RegExp, number]> = [
  [/gpt-3\.5/i, 16_385],
  [/gpt-4\.1|gpt-4o|gpt-4-turbo|chatgpt-4o/i, 128_000],
  [/gpt-5|o1-|o3-|o4-/i, 200_000],
  [/claude/i, 200_000],
  [/gemini/i, 1_048_576],
  [/deepseek/i, 128_000],
]

/** 来源键：自定义来源按「激活来源索引」分别计（不同来源窗口可能完全不同） */
export function contextWindowKey(provider: string, customSourceIndex?: number | null): string {
  // 单来源：历史别名 'deepseek-responses' 归一到 'deepseek'（避免同一来源两份缓存）
  const p = normalizeLlmType(String(provider || '').trim()) || 'unknown'
  if (p !== 'custom') return p
  const idx = typeof customSourceIndex === 'number' && customSourceIndex >= 0 ? customSourceIndex : 0
  return `custom:${idx}`
}

/** 模型名关键字命中的窗口；未命中返回 null */
export function modelContextWindow(model?: string | null): number | null {
  const m = String(model || '')
  if (!m) return null
  for (const [re, v] of MODEL_CONTEXT_WINDOW) if (re.test(m)) return v
  return null
}

/** 后端未提供真实值时的默认窗口：先模型关键字，再来源默认，最后未知兜底 */
export function defaultContextWindow(provider: string, model?: string | null): number {
  return modelContextWindow(model)
    ?? PROVIDER_CONTEXT_WINDOW[normalizeLlmType(String(provider || ''))]
    ?? UNKNOWN_CONTEXT_WINDOW
}

export type ContextLimitSource = 'manual' | 'real' | 'probed' | 'model-default' | 'model-name' | 'provider-default' | 'unknown'

export interface ContextLimit {
  limit: number
  source: ContextLimitSource
}

/** 解析最终上限（优先级见文件头注释） */
export function resolveContextLimit(opts: {
  manual?: number
  /** 已加载实例真正生效的值（本次探测，最可信） */
  realLoaded?: number
  /** 本次探测到的其它值（模型上限 / Modelfile 写死的 num_ctx） */
  real?: number
  /** 上次实际读到的已加载窗口（持久化），见 probedContextWindow */
  probed?: number
  provider: string
  model?: string | null
}): ContextLimit {
  const manual = Number(opts.manual || 0)
  if (manual > 0) return { limit: manual, source: 'manual' }
  // 已加载实例的值最可信（Ollama 手动设置的上下文长度也只有它能反映）
  const realLoaded = Number(opts.realLoaded || 0)
  if (realLoaded > 0) return { limit: realLoaded, source: 'real' }
  // 未加载时：上次读到的实际值 > 本次探测到的模型上限
  // （固定环境下手动设置不会变，记住的值比「模型上限」更接近实际生效值）
  const probed = Number(opts.probed || 0)
  if (probed > 0) return { limit: probed, source: 'probed' }
  const real = Number(opts.real || 0)
  if (real > 0) return { limit: real, source: 'model-default' }
  const byModel = modelContextWindow(opts.model)
  if (byModel) return { limit: byModel, source: 'model-name' }
  const byProvider = PROVIDER_CONTEXT_WINDOW[String(opts.provider || '')]
  if (byProvider) return { limit: byProvider, source: 'provider-default' }
  return { limit: UNKNOWN_CONTEXT_WINDOW, source: 'unknown' }
}

// ---------------------------------------------------------------------------
// 真实窗口探测结果缓存（内存级；按「来源+模型」分桶，避免不同模型互相污染）
// ---------------------------------------------------------------------------
// 带时间戳：本地后端（Ollama / LM Studio）的「已加载窗口」会随用户手动调整而变化，
// 请求完成后可凭 contextWindowCacheAt 判断是否值得重探（见 home.vue loadContextWindowReal）。

interface RealCacheEntry {
  value: number
  at: number
  /** 是否来自「已加载实例真正生效的值」（/api/ps、LM Studio loaded_context_length） */
  loaded: boolean
}

const realCache = new Map<string, RealCacheEntry>()

export function realContextWindowCacheKey(provider: string, model: string, customSourceIndex?: number | null): string {
  return `${contextWindowKey(provider, customSourceIndex)}/${String(model || '')}`
}

/** 本次探测到的窗口（任意来源，含模型上限 / Modelfile num_ctx） */
export function getCachedRealContextWindow(key: string): number | undefined {
  const entry = realCache.get(key)
  return entry && entry.value > 0 ? entry.value : undefined
}

/** 只取「已加载实例真正生效」的值：可信度最高，优先级高于持久化的记住值 */
export function getCachedLoadedContextWindow(key: string): number | undefined {
  const entry = realCache.get(key)
  return entry && entry.loaded && entry.value > 0 ? entry.value : undefined
}

/** 是否已探测过（含「读不到」的否定缓存）：用于节流，避免对不可能变的来源重复发请求 */
export function hasProbedRealContextWindow(key: string): boolean {
  return realCache.has(key)
}

/** 缓存写入时间（毫秒时间戳）；无缓存返回 0 */
export function contextWindowCacheAt(key: string): number {
  return realCache.get(key)?.at || 0
}

/** 写入探测结果；value<=0 记为否定缓存（保留时间戳），不当作可用值 */
export function setCachedRealContextWindow(key: string, value: number, loaded = false): void {
  realCache.set(key, { value: Math.max(0, Number(value) || 0), at: Date.now(), loaded: !!loaded && value > 0 })
}

// ---------------------------------------------------------------------------
// 「上次读到的已加载窗口」持久化（跨会话）
// ---------------------------------------------------------------------------
// 用途：Ollama 手动设置的上下文长度只体现在 /api/ps 的已加载实例上，模型卸载后就再也读不到。
// 把它按「来源/模型」记在配置里，下次启动（尚未加载任何模型时）也能用对分母。

/** 读取上次记住的窗口（键用 realContextWindowCacheKey）；无记录返回 0 */
export function probedContextWindow(llm: any, key: string): number {
  const m = llm?.contextWindowProbed
  if (!m || typeof m !== 'object') return 0
  return Number(m[key] || 0)
}

/** 记住某模型实际生效的窗口；值未变化返回 false（调用方据此决定是否落盘） */
export function rememberProbedContextWindow(llm: any, key: string, value: number): boolean {
  if (!llm || !(Number(value) > 0)) return false
  const m: Record<string, number> = (llm.contextWindowProbed && typeof llm.contextWindowProbed === 'object')
    ? { ...llm.contextWindowProbed }
    : {}
  if (Number(m[key] || 0) === Number(value)) return false
  m[key] = Number(value)
  // 只保留最近 50 条，避免配置无限增长
  const keys = Object.keys(m)
  if (keys.length > 50) for (const k of keys.slice(0, keys.length - 50)) delete m[k]
  llm.contextWindowProbed = m
  return true
}

/**
 * 一次性迁移：把历史「全局窗口上限」按迁移时的激活来源下沉为来源级覆盖值并清零全局值。
 * 返回是否发生了迁移（调用方据此决定是否落盘）。
 */
export function migrateLegacyContextWindow(llm: any): boolean {
  if (!llm) return false
  const legacy = Number(llm.contextWindow || 0)
  if (!(legacy > 0)) return false
  const byProvider: Record<string, number> = (llm.contextWindowByProvider && typeof llm.contextWindowByProvider === 'object')
    ? { ...llm.contextWindowByProvider }
    : {}
  const key = contextWindowKey(llm.type, llm.custom?.activeIndex)
  if (!(Number(byProvider[key]) > 0)) byProvider[key] = legacy
  llm.contextWindowByProvider = byProvider
  llm.contextWindow = 0
  return true
}

/** 读取某来源的手填覆盖值（0 = 自动） */
export function manualContextWindow(llm: any, provider: string, customSourceIndex?: number | null): number {
  const byProvider = llm?.contextWindowByProvider
  if (!byProvider || typeof byProvider !== 'object') return 0
  return Number(byProvider[contextWindowKey(provider, customSourceIndex)] || 0)
}

// ---------------------------------------------------------------------------
// token 估算（仅在后端未回传 usage 时作为圆环回退值）
// ---------------------------------------------------------------------------

/**
 * 解析某来源 / 模型「实际生效」的窗口上限（渲染层唯一入口）。
 * 与 home.vue 圆环的分母同源：手填 > 已加载实例探测值 > 记住的探测值 > 模型上限 > 模型名 > 来源默认。
 * 供上下文压缩预算取用（智能体创建时把结果带进主进程）。
 */
export function resolveLimitFor(
  llm: any,
  opts: { provider: string; model?: string | null; customSourceIndex?: number | null },
): ContextLimit {
  const key = realContextWindowCacheKey(opts.provider, String(opts.model || ''), opts.customSourceIndex)
  return resolveContextLimit({
    manual: manualContextWindow(llm, opts.provider, opts.customSourceIndex),
    realLoaded: getCachedLoadedContextWindow(key),
    probed: probedContextWindow(llm, key),
    real: getCachedRealContextWindow(key),
    provider: opts.provider,
    model: opts.model,
  })
}

/** 安全 JSON 序列化（循环引用/超大对象兜底为空串） */
function safeJson(value: any): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// 估算校准系数（真实 token 计数 / 字符启发式估算，按「来源 + 模型」记忆）
//
// 为什么需要：字符启发式天然落后于各家 tokenizer，且**系统性**偏向低估代码 / JSON 类内容
// （实测 Ollama gemma4：代码与工具结果 JSON 的真实计数是估算的 1.30 倍，qwen3.8 约 1.15 倍）。
// 而 read_file 的结果、write_file 的参数正是这两类内容 —— 不校准就会一路低估到溢出，
// 压缩也就来不及生效。这里把主进程实测到的比值落在本机（localStorage，独立键，不进设置文件），
// 供下一次预算 / 圆环回退直接复用。
// ---------------------------------------------------------------------------

const TOKEN_SCALE_STORAGE_KEY = 'aikm.tokenScaleByModel'

/** 估算校准系数按「来源::模型」记忆（模型决定 tokenizer，来源决定默认模型选择） */
export function tokenScaleKey(provider?: string | null, model?: string | null): string {
  const p = String(provider || '').trim() || 'unknown'
  const m = String(model || '').trim() || 'default'
  return `${p}::${m}`
}

let tokenScaleMap: Record<string, number> | null = null

function loadTokenScaleMap(): Record<string, number> {
  if (tokenScaleMap) return tokenScaleMap
  const out: Record<string, number> = {}
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(TOKEN_SCALE_STORAGE_KEY) : null
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          const n = Number(v)
          if (n > 0) out[k] = clampTokenScale(n)
        }
      }
    }
  } catch { /* 读取失败按空表处理（不影响功能，只是回到未校准） */ }
  tokenScaleMap = out
  return out
}

/** 取某来源 + 模型的估算校准系数（无记录返回 1） */
export function getTokenScale(provider?: string | null, model?: string | null): number {
  const key = tokenScaleKey(provider, model)
  const v = loadTokenScaleMap()[key]
  return v > 0 ? clampTokenScale(v) : 1
}

/**
 * 记住一次实测的校准系数（EWMA，新样本权重 0.3；与主进程同一算法）。
 * 只有偏离足够明显时才写入，避免频繁写 localStorage。
 */
export function rememberTokenScale(provider?: string | null, model?: string | null, scale?: number | null): boolean {
  const next = clampTokenScale(scale)
  if (!(Number(scale) > 0)) return false
  const key = tokenScaleKey(provider, model)
  const map = loadTokenScaleMap()
  const prev = map[key] > 0 ? map[key] : 1
  const merged = clampTokenScale(prev * 0.7 + next * 0.3)
  if (Math.abs(merged - prev) < 0.005) return false
  map[key] = merged
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(TOKEN_SCALE_STORAGE_KEY, JSON.stringify(map))
  } catch { /* 写失败仅影响下次复用 */ }
  return true
}

/** 聊天对象 → 校准系数（键取聊天的来源 + 模型） */
function chatTokenScale(chat: any): number {
  return getTokenScale(chat?.config?.llmType, chat?.config?.model)
}

/** 单个工具调用单元（参数 + 结果）计入上下文的 token 估算 */
export function estimateUnitTokens(unit: any): number {
  if (!unit) return 0
  // args / result 是真正回传给模型的部分；streamContent 是 args 的流式快照，
  // resultPreview / preview 是给 UI 看的截断版（不进模型上下文），都不能重复计入。
  let t = estimateTokens(safeJson(unit.args))
  t += estimateTokens(safeJson(unit.result))
  if (typeof unit.error === 'string') t += estimateTokens(unit.error)
  return t
}

/**
 * 智能体会话启动时注入的固定上下文估算：system prompt + 工具 schema + 种子历史。
 * 这三者都不落在消息正文上（主进程持有），因此由会话启动处算好记到助手消息的
 * `ctxSeedTokens`（见 useAgentRun.startAgentSessionInChat）。
 */
export function estimateAgentSeedTokens(opts: {
  systemPrompt?: string
  tools?: readonly string[] | null
  seedHistory?: Array<{ content?: string }> | null
}): number {
  let t = estimateTokens(opts.systemPrompt || '')
  t += (opts.tools?.length || 0) * TOOL_SCHEMA_TOKEN_ESTIMATE
  for (const m of opts.seedHistory || []) t += estimateTokens(m?.content || '')
  return t
}

/**
 * 估算「一次请求」的输入 token（圆环回退值）。
 *
 * 口径必须与实际请求构建保持一致（见 home.vue buildMessagesWithFunction /
 * buildMultimodalMessages、useAgentRun.buildSeedHistory、主进程 agent-loop）：
 *  1) 历史消息只发 content → 历史轮次的知识库召回片段、历史图片、历史文件附件都不计入；
 *  2) 当前轮的知识库召回片段挂在最后一条助手消息的 kbInfo 上 → 只在最后一条计；
 *  3) 智能体的工具调用结果（executionUnits）只在「本轮」保留（下一轮只播种 content）
 *     且都挂在最后一条助手消息上 → 只在最后一条计；
 *  4) 智能体的 system prompt + 工具 schema + 种子历史不落在消息上 → 读 ctxSeedTokens；
 *  5) 当前轮图片与文件附件（PDF/文本解析结果）挂在最后一条用户消息上 → 只在最后一条计。
 *
 * 结果再乘「估算校准系数」（按来源 + 模型记忆的实测比值，见 getTokenScale）：字符启发式对
 * 代码 / JSON 类内容系统性低估（本地后端实测 1.15~1.30 倍），不校准会让压缩触发太晚。
 */
export function estimateChatContextTokens(chat: any): number {
  const msgs: any[] = (chat && chat.messages) || []
  if (!msgs.length) return 0

  // 上下文压缩（P0）：前 coveredCount 条消息已不再随请求发出，改由压缩摘要替代
  const cp = chat?.compaction
  const covered = cp && Number(cp.coveredCount) > 0 ? Math.min(Number(cp.coveredCount), msgs.length) : 0

  let total = 0
  if (covered > 0 && cp?.summary) total += estimateTokens(String(cp.summary)) + 16
  for (let i = covered; i < msgs.length; i++) {
    const m = msgs[i]
    if (typeof m?.content === 'string') total += estimateTokens(m.content)
  }

  const lastAssistantIdx = msgs.reduce((acc, m, i) => (m?.role === 'assistant' ? i : acc), -1)
  const lastUserIdx = msgs.reduce((acc, m, i) => (m?.role === 'user' ? i : acc), -1)
  const lastAssistant = lastAssistantIdx >= 0 ? msgs[lastAssistantIdx] : undefined
  const lastUser = lastUserIdx >= 0 ? msgs[lastUserIdx] : undefined

  if (lastAssistant && lastAssistantIdx >= covered) {
    if (typeof lastAssistant.ctxSeedTokens === 'number') total += lastAssistant.ctxSeedTokens
    const blocks = lastAssistant.kbInfo?.relevantBlocks
    if (Array.isArray(blocks)) {
      for (const b of blocks) total += estimateTokens(b?.content || '')
    }
    if (Array.isArray(lastAssistant.executionUnits)) {
      for (const u of lastAssistant.executionUnits) total += estimateUnitTokens(u)
    }
  }

  if (lastUser && lastUserIdx >= covered) {
    if (Array.isArray(lastUser.images)) total += lastUser.images.length * IMAGE_TOKEN_ESTIMATE
    // 文件附件正文经 retrievedContext 前置进请求，但不在 m.content 里
    if (Array.isArray(lastUser.fileAttachments)) {
      for (const f of lastUser.fileAttachments) total += estimateTokens(f?.content || '')
    }
  }

  return Math.round(total * chatTokenScale(chat))
}

/** 供压缩/预算使用的消息投影（只取模型可见部分） */
export function toBudgetMessages(msgs: readonly any[] | null | undefined): BudgetMessage[] {
  return (msgs || []).map((m) => ({
    role: m?.role,
    content: typeof m?.content === 'string' ? m.content : '',
    toolCalls: m?.toolCalls,
    images: Array.isArray(m?.images) ? m.images.length : undefined,
  }))
}
