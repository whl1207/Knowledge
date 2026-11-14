/**
 * agent-loop.ts — Agent 循环标准化（turn/step/inbox/cancel/steer/inject）
 *
 * 借鉴 DeepSeek-Harness core 子系统（docs/subsystems/core.md）：
 * - **step** = 一次模型请求 + 它调用的工具；**turn** = 零个或多个 step；
 * - 输入通过统一 **inbox** 到达驱动器：`send`/`followup` 唤醒驱动器并开新
 *   turn；`steer` 投递到最近 step 边界（运行中立即消费）；`inject` 只排队
 *   不唤醒（落到下一次 step 的上下文中）；
 * - `cancel(cause)` 中止当前 turn（首个 cause 生效），`keepInbox` 保留排队工作；
 * - `whenIdle()` 等待 agent 收敛；`dispose()` 终止并注销；
 * - **会话事件落盘**：turn/step/user/assistant/tool 全部写入 session-log
 *   （单一事实源），模型历史由 `deriveMessages` 从日志重建；
 * - 生命周期：`idle → running → stopping → disposed`，每次迁移广播
 *   `agent/status`。
 *
 * 运行在主进程：渲染进程切模块 / 关窗口后 agent 继续执行（对齐 ai-service
 * 的断线续传设计）。LLM 调用复用 `AIUtils`（与 ai-service 同一套 provider
 * 适配），工具执行走统一工具注册表（toolRegistry）。
 */

import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as fs from 'node:fs'
import { logInfo } from './log'
import { registerOwnedAgent, unregisterOwnedAgent } from './plugin-owned-agents'
import { hasPluginWaterfall, runPluginWaterfall } from './plugin-waterfall'
import { AIUtils } from '@/shared/ai-core'
import { toolRegistry } from '@/shared/toolRegistry'
import { boundToolResult, buildSpillPreview, shouldSpill } from '@/shared/toolResultBudget'
import { repairTextToolCalls, parseXmlToolArgs } from '@/shared/toolCallRepair'
import { sessionLog } from './session-log'
import { recordUsage } from './usage-log'
import { saveSpillText } from './tool-spill'
import { jobRegistry } from './job-registry'
import { cwdFor, forgetWorkingDir } from './working-directory'
import { clearReadCacheFor } from './read-cache'
import { TIME_CONTEXT_REFRESH_MS, formatTimeContext, isValidTimeZone } from '@/shared/timeContext'
import { browserAgentService } from './browser-agent'
import { mcpService } from './mcp-service'
import { credentialStore } from './credentials'
import type {
  AgentOptions,
  AgentStatus,
  AgentControl,
  AgentCancelCause,
  AgentEvent,
  AgentEventMap,
  AgentEventType,
  AgentStepUsage,
  AgentSummary,
  AgentStateView,
  TodoItem,
  AskUserQuestion,
  AskUserAnswer,
  RunReport,
} from '@/types/agent'
import type { DerivedMessage, DerivedEntry } from '@/types/session-log'
import type { ToolResult, ToolDefinition, ToolExecutionContext, ToolImage } from '@/types/tool'
import { brand, type ToolName, type AgentId } from '@/types/ids'
import { runCodeFunctionSchema } from './code-sdk'
import { askQuestionsDigest, coerceAskAnswers } from '@/shared/agentAsk'
import { PLAN_REVIEW_ID_PREFIX, parsePlanReviewReply, isPlanReviewId, type PlanReviewOutcome } from '@/shared/agentPlanReview'
import { DEFAULT_AGENT_MAX_STEPS } from '@/shared/agent-loop-rounds'
import { normalizeAgentRunResult, type AgentRunResult } from '@/lib/plugin/agentContract'
import { decideTruncationContinue } from '@/shared/truncation'
import { agentSessionSignature, canResumeSessionStart } from '@/shared/agentSession'
import { classifyLlmFailure, effectiveRetryDelayMs, parseHttpStatus } from '@/shared/llmRetry'
import { isImageUnsupportedError, modelSupportsVision } from '@/shared/visionSupport'
// 上下文预算与压缩（P0）：与渲染层共用同一口径（详见 src/shared/contextBudget.ts）
import {
  COMPACT_KEEP_TURNS,
  COMPACT_MIN_DROP,
  COMPACT_RETAIN_RATIO,
  COMPACT_RETRIES,
  COMPACT_SYSTEM_PROMPT,
  OVERFLOW_RETRY_LIMIT,
  PRUNE_KEEP_RECENT,
  buildCompactionPrompt,
  pruneToolResults,
  renderCompactedCheckpoint,
  compactionBasisTokens,
  compactThresholdTokens,
  estimateMessagesTokens,
  estimateTokens,
  estimateToolSchemaTokens,
  calibrateTokenScale,
  clampTokenScale,
  indexSummary,
  isContextOverflowError,
  pickCompactionRangeByTokens,
  planAgentBudget,
  type BudgetMessage,
  type ContextBudget,
  type TokenAccountingAnchor,
} from '@/shared/contextBudget'

// ---------------------------------------------------------------------------
// 广播
// ---------------------------------------------------------------------------

let broadcast: ((ev: AgentEvent) => void) | null = null

/** 附加订阅者（局域网访客 SSE 等）：与桌面广播并行接收同一事件流 */
const extraSubscribers = new Set<(ev: AgentEvent) => void>()

/** 设置 agent 事件广播（main/index.ts 在 app ready 时注入） */
export function setAgentBroadcast(fn: ((ev: AgentEvent) => void) | null): void {
  broadcast = fn
}

/**
 * 新建会话时的宿主钩子（插件宿主注入）。
 *
 * 为什么不用事件总线：`createAgent` 在 agent 注册前就该发 `session/created`，
 * 而 agent 事件广播带的是"已存在的 agent id"；用钩子避免 agent-loop → plugin-host 的循环依赖。
 */
let sessionCreatedListener: ((info: { sessionId: string; cwd?: string; agentPreset?: string }) => void) | null = null

export function setSessionCreatedListener(
  fn: ((info: { sessionId: string; cwd?: string; agentPreset?: string }) => void) | null,
): void {
  sessionCreatedListener = fn
}

/**
 * 订阅 agent 事件流（与广播同一份事件对象）。
 * 用途：局域网访客经 `/api/agent/events` 接收自己会话的事件。
 * 返回取消订阅函数（SSE 断开时必须调用，防监听器泄漏）。
 */
export function subscribeAgentEvents(fn: (ev: AgentEvent) => void): () => void {
  extraSubscribers.add(fn)
  return () => {
    extraSubscribers.delete(fn)
  }
}

/** 分发一条事件到广播与全部订阅者（订阅者异常不影响其它订阅者） */
function dispatchEvent(ev: AgentEvent): void {
  try {
    broadcast?.(ev)
  } catch (e) {
    console.error('[agent-loop] 广播监听器异常:', e)
  }
  for (const fn of Array.from(extraSubscribers)) {
    try {
      fn(ev)
    } catch (e) {
      console.error('[agent-loop] 事件订阅者异常:', e)
    }
  }
}

/** 向指定 agent 广播事件（供模块级函数使用，如 requestQuestions） */
function emitTo<K extends AgentEventType>(agentId: string, type: K, payload: AgentEventMap[K]): void {
  dispatchEvent({ agentId: agentId as any, type, payload } as AgentEvent)
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function stripTrailing(url: string | undefined): string {
  return (url || '').replace(/\/+$/, '')
}

function authHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  return headers
}

/** 把日志派生的消息转换为 OpenAI 风格消息（tool_calls / tool_call_id） */
function toOpenAIMessage(m: DerivedMessage): any {
  const out: any = { role: m.role, content: m.content }
  if (m.role === 'assistant' && m.toolCalls?.length) out.tool_calls = m.toolCalls
  if (m.role === 'tool') out.tool_call_id = m.toolCallId
  // 图片只随 user 消息进入请求（历史里的工具截图由 session-log 合成 synthetic user 消息）
  if (m.role === 'user' && m.images?.length) out.images = m.images
  return out
}

/** 工具图片落盘后的元信息（会话日志只存这个，不存 base64） */
type SavedToolImage = { mime: string; path: string; width?: number; height?: number }

/**
 * 工具返回的图片 → 临时文件。
 *
 * 为什么必须落盘再引用而不是把 base64 塞进 tool 消息：tool 消息是纯文本、会走工具结果预算，
 * base64 一旦被掐中段就既不是图片也不是合法数据（截图 90K 字符必被 32K 码点预算截断）。
 * 落盘后由 `session-log.deriveEntries` 在工具消息之后合成一条图片 user 消息，模型才真正"看得见"。
 */
function saveToolImage(sessionId: string, img: ToolImage): SavedToolImage | null {
  try {
    if (!img?.data) return null
    const mime = /^image\/(png|jpeg|webp|gif)$/.test(String(img.mime)) ? String(img.mime) : 'image/jpeg'
    const ext = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]
    const safeId = String(sessionId || 'agent').replace(/[^a-zA-Z0-9_-]/g, '_')
    const dir = join(tmpdir(), 'aikm-tool-images', safeId)
    fs.mkdirSync(dir, { recursive: true })
    const file = join(dir, `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
    fs.writeFileSync(file, Buffer.from(img.data, 'base64'))
    return {
      mime,
      path: file,
      ...(Number.isFinite(img.width) ? { width: Number(img.width) } : {}),
      ...(Number.isFinite(img.height) ? { height: Number(img.height) } : {}),
    }
  } catch {
    return null
  }
}

/**
 * 把工具返回值转成**一定可序列化**的文本。
 *
 * 工具（尤其插件工具）可能返回循环引用 / BigInt / 函数等 JSON 不友好的值；
 * 旧路径会在 `JSON.stringify` 处抛错并冒泡到 runTurn，把整个 turn 结束。
 * 这里用带循环检测的 replacer 兜底，最多保留 100K 字符。
 */
/** 校验 present 返回的交付文件（只接受非空绝对路径 + 可选说明）。 */
function presentedFilesOf(value: any): Array<{ path: string; description?: string }> {
  const raw = Array.isArray(value?.files) ? value.files : []
  const files: Array<{ path: string; description?: string }> = []
  for (const f of raw) {
    const p = String(f?.path ?? '').trim()
    if (!p) continue
    const description = String(f?.description ?? '').trim().slice(0, 200)
    files.push({ path: p, ...(description ? { description } : {}) })
  }
  return files
}

function safeToolValueText(value: any): string {
  const seen = new WeakSet<object>()
  try {
    const text = JSON.stringify(value, (_key, v) => {
      if (typeof v === 'bigint') return `${v}n`
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[Circular]'
        seen.add(v)
      }
      return v
    })
    const out = typeof text === 'string' ? text : String(value ?? '')
    return out.length > 100_000 ? out.slice(0, 100_000) + '…' : out
  } catch (e: any) {
    return `[工具结果无法序列化：${e?.message || String(e)}]`
  }
}

/** 稳定序列化工具参数（对象键排序），用于识别「同一工具 + 同一参数」的重复调用 */function canonicalToolArgs(value: any): string {
  const seen = new WeakSet<object>()
  const sort = (v: any): any => {
    if (v === null || typeof v !== 'object') return v
    if (seen.has(v)) return '[circular]'
    seen.add(v)
    if (Array.isArray(v)) return v.map(sort)
    const out: Record<string, any> = {}
    for (const k of Object.keys(v).sort()) out[k] = sort(v[k])
    return out
  }
  try {
    return JSON.stringify(sort(value ?? {}))
  } catch {
    return String(value)
  }
}

function parseToolArgs(raw: any): any {
  // 容错解析工具参数。部分后端/parser（如 GPUStack 的 qwen3_xml）会把 JSON 再包一层字符串
  // （arguments 形如 "\"{...}\"" 或带多余引号），单次 JSON.parse 会失败或得到字符串。
  let v: any = raw
  for (let i = 0; i < 4; i++) {
    if (typeof v !== 'string') break
    const t = v.trim()
    if (!t) { v = {}; break }
    try {
      const parsed = JSON.parse(t)
      // 解出一层：若仍是字符串（嵌套字符串化 JSON）则继续解包，直到得到对象/数组
      v = parsed
      if (typeof parsed !== 'string') break
    } catch {
      // 尝试去掉最外层多余引号后重试（qwen3_xml 偶发前后多余引号）
      const cleaned = t.replace(/^"+|"+$/g, '')
      if (cleaned !== t) { v = cleaned; continue }
      return { _raw: t }
    }
  }
  if (typeof v === 'string') {
    // 多次解包后仍是纯字符串（非 JSON 对象）：清理外围引号后尽力再解析一次
    const cleaned = v.trim().replace(/^"+|"+$/g, '')
    try { return JSON.parse(cleaned) } catch { return { _raw: v } }
  }
  return v && typeof v === 'object' ? v : {}
}

/**
 * 修复「字符串内部未转义的控制字符」再解析：模型 / 本地网关把多行代码直接塞进 JSON 字符串
 * （真实换行 / 制表符 / 回车）是最常见的坏参数来源。
 */
function escapeRawControlCharsInStrings(text: string): string {
  let out = ''
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (!inStr) {
      if (ch === '"') inStr = true
      out += ch
      continue
    }
    if (ch === '\\') { out += ch + (text[i + 1] ?? ''); i++; continue }
    if (ch === '"') { inStr = false; out += ch; continue }
    if (ch === '\n') { out += '\\n'; continue }
    if (ch === '\r') { out += '\\r'; continue }
    if (ch === '\t') { out += '\\t'; continue }
    const code = ch.charCodeAt(0)
    if (code < 0x20) { out += '\\u' + code.toString(16).padStart(4, '0'); continue }
    out += ch
  }
  return out
}

/** 解析是否真的拿到了参数对象（`_raw` 标记表示解析失败） */
function parseOk(parsed: any): boolean {
  return !!parsed && typeof parsed === 'object' && parsed._raw === undefined
}

/**
 * 参数原文是否明显「没写完」：没有收尾的 `}` / `]`，或最后一个字符串引号没闭合。
 *
 * 为什么要单独判断：模型一次输出整份大文件时，最常见的失败是输出撞到 max_tokens /
 * 网关输出上限，JSON 在半截字符串处硬生生断掉。此时 finish_reason 有时拿不到 `length`
 * （网关直接按 stop 收尾），旧文案只说「JSON 不合法」，会让人误以为是转义写错了。
 */
function looksIncompleteJson(raw: string): boolean {
  const t = String(raw || '').trim()
  if (!t) return true
  if (!/[}\]]$/.test(t)) return true
  let inStr = false
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (ch === '\\') { i++; continue }
    if (ch === '"') inStr = !inStr
  }
  return inStr
}

/**
 * 参数原文进历史时只保留预览。
 *
 * 为什么：解析失败时旧实现把**整段原文**塞进 `arguments: {"_raw": …}`，这条 assistant
 * 消息会随之后每一步重放给模型——一次截断（10 万字符的半截 content）就把上下文永久占满。
 * DSH 的做法更彻底：max-tokens 时直接把 tool-call 块丢掉（`dsh-llm` 的 BlockAssembler）。
 * 这里保留可诊断性（头 + 尾 + 真实长度），但不再把全文留在历史里。
 */
const RAW_ARGS_PREVIEW_CHARS = 2000

function previewRawArgs(raw: string): string {
  const text = String(raw || '')
  if (text.length <= RAW_ARGS_PREVIEW_CHARS) return text
  const headLen = 1600
  const tailLen = RAW_ARGS_PREVIEW_CHARS - headLen
  return `${text.slice(0, headLen)}\n…（此处省略 ${text.length - RAW_ARGS_PREVIEW_CHARS} 字符）…\n${text.slice(-tailLen)}`
}

/** 宽容解析：先按 parseToolArgs（含多层解包），失败再修复裸控制字符后重试 */
function parseToolArgsLenient(raw: any): any {
  const first = parseToolArgs(raw)
  if (parseOk(first)) return first
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const repaired = JSON.parse(escapeRawControlCharsInStrings(raw.trim()))
      if (repaired && typeof repaired === 'object') return repaired
    } catch { /* 仍然失败：保留原结果（_raw）供上层报错 */ }
  }
  return first
}

/**
 * 归一化 assistant 工具调用列表：把每个 call 的 arguments 解析并重新序列化为干净的单层 JSON 字符串。
 * 目的：GPUStack qwen3_xml 给出的 arguments 常是多层转义/带多余引号的畸形 JSON，若原样写入会话日志，
 * 下一轮会把畸形 arguments 回传给 vLLM，触发其模板解析失败（HTTP 400 Extra data）。
 *
 * `streamedFor`：按 callId 取本步「参数流式增量累积的原文」。部分本地网关（GPUStack / LM Studio 等）
 * 在最终 tool_calls 里丢掉或截断了 arguments，而参数增量已完整发出——用流式原文兜底可救回参数；
 * 否则工具会拿空参数执行（表现为 "code 参数必填" 这类误导报错，且模型会反复重试同样的调用）。
 *
 * 解析失败时**不再退化成 `{}`**（那会静默丢掉参数），而是把原文**预览**保留到 `_raw` 字段，
 * 并附 `_rawLength` / `_rawOmitted`：它仍是合法 JSON（不会被 vLLM 模板判为 Extra data），
 * 模型也能看出自己的参数被截断/畸形，但几十万字符的半截 content 不会跟着每一步重放。
 */
function normalizeToolCalls(
  calls: any[] | undefined,
  streamedFor?: (callId: string) => string | undefined,
): { calls: any[]; recovered: string[]; failed: string[] } {
  const recovered: string[] = []
  const failed: string[] = []
  if (!Array.isArray(calls)) return { calls: [], recovered, failed }
  const out = calls.map((c: any) => {
    const fn = c?.function
    if (!fn || typeof c !== 'object') return c
    let args = fn.arguments
    if (typeof args === 'string') {
      const callId = String(c?.id || '')
      const streamed = (streamedFor && callId ? String(streamedFor(callId) || '') : '').trim()
      const current = args.trim()
      if (!current && !streamed) {
        // 无参数（部分网关对无参工具给空字符串）：保持原行为，由工具自身校验必填参数
        args = '{}'
      } else {
        let parsed: any
        let chosen = ''
        let fromStream = false
        for (const cand of [current, streamed]) {
          if (!cand) continue
          const p = parseToolArgsLenient(cand)
          if (parseOk(p)) { parsed = p; chosen = cand; fromStream = cand === streamed; break }
        }
        if (parseOk(parsed)) {
          args = JSON.stringify(parsed)
          // 最终 payload 的参数不可用、靠流式原文救回：记一笔便于诊断
          if (fromStream && callId && !parseOk(parseToolArgs(current))) recovered.push(callId)
        } else {
          const raw = chosen || current
          if (callId) failed.push(callId)
          // 只留预览：整段原文进历史会在之后每一步重放时吃满上下文（见 previewRawArgs）
          args = JSON.stringify({
            _raw: previewRawArgs(raw),
            _rawLength: raw.length,
            ...(raw.length > RAW_ARGS_PREVIEW_CHARS ? { _rawOmitted: true } : {}),
          })
        }
      }
    }
    return { ...c, function: { ...fn, arguments: args } }
  })
  return { calls: out, recovered, failed }
}

// ---------------------------------------------------------------------------
// 同后端并发限流（远程自托管推理服务）：多并发流式请求打到远端 LM Studio /
// GPUStack 等单机推理服务时，拿不到生成 slot 的请求会被静默丢弃（200 空流）或
// 返回 500，因此对同一后端的在途请求数做信号量限制，让多线程排队而不是同时压上
// ---------------------------------------------------------------------------

/** 远程自托管后端在途请求上限的取值范围 */
const REMOTE_BACKEND_MAX_INFLIGHT_MIN = 1
const REMOTE_BACKEND_MAX_INFLIGHT_MAX = 500
/**
 * 全局基准上限（默认 2，本机 localhost 服务不受此限制）。
 * 来自「设置 → 大模型 → 通用参数」的 remoteMaxInflight，经 agent 选项 llmConfig 带主进程，
 * createAgent 时调用 setRemoteBackendMaxInflight 同步。
 */
let remoteBackendMaxInflight = 2
/** 可自托管的 OpenAI 兼容后端（本地/内网部署，受单机推理能力限制） */
const SELFHOSTED_PROVIDERS = new Set(['ollama', 'lmstudio', 'custom'])

/**
 * `finish_reason=length` 时最多自动续跑几次（复刻 DSH 把 finish=max-tokens 当"下一步继续"的信号）。
 *
 * 为什么需要上限：模型在续跑时如果每轮都撞 max_tokens，会变成"无限续跑"。
 * 取 3 是经验值：正常任务被截断后 1~2 轮内能收尾；连续 3 次说明单次输出根本装不下这个任务，
 * 此时应当明确告知用户（而不是继续烧 token 或静默结束）。
 */
const MAX_LENGTH_CONTINUES = 3

/**
 * `finish_reason=length` 时，**带工具调用**的一步最多重试几次。
 *
 * 为什么单独设上限：工具参数的 JSON 是流式拼出来的，被 max_tokens 截断时半截 JSON
 * 无法执行（也没有"续写半个 JSON"的可靠办法）。对齐 DSH 的语义：本步**一个工具都不派发**，
 * 只回灌"未执行、请分段"的结果，让模型下一 step 自己缩小提交量。连续多次仍撞上限，
 * 说明单次输出根本装不下，必须停下并明确告知（而不是让模型反复重试烧 token）。
 */
const MAX_TRUNCATED_TOOL_SKIPS = 3

/**
 * 并行安全工具：只读 / 无共享状态，多个调用可以同时跑。
 * 其余（写文件、执行代码、shell、ask_user、run_code、run_subagent、MCP、插件工具）
 * 一律独占，保持原有副作用顺序。
 */
const PARALLEL_SAFE_TOOLS = new Set([
  'read_file',
  'list_dir',
  'search_files',
  'kb_search',
  'web_search',
  'web_fetch',
  'browser_snapshot',
  'browser_extract_text',
  'browser_screenshot',
  'browser_list_tabs',
])

/** 同一 step 内并行工具的上限（有界滚动池，避免一次读几十个文件把 fd / 内存打满） */
const MAX_PARALLEL_TOOL_CALLS = 4

/** 参数可能很大 / 重复本身有正当理由的工具：不参与重复调用计数（避免序列化 1MB 正文） */
const REPEAT_TRACK_EXCLUDE = new Set([
  'write_file',
  'replace_in_file',
  'multi_replace',
  'run_code',
  'export_word',
  'update_todo',
  'update_plan',
  'job_output',
  'ask_user',
])

const backendInflight = new Map<string, number>()
/**
 * 各编排运行（AgentBatch / AgentSwarm …）声明的期望并发：scopeId → 并发数。
 * 生效上限 = max(全局基准, 活跃声明)，使「远端大模型并发」跟随编排自身设置的 agent 并发数。
 */
const concurrencyIntents = new Map<string, number>()

function clampInflight(n: number): number {
  if (!Number.isFinite(n)) return 2
  return Math.min(REMOTE_BACKEND_MAX_INFLIGHT_MAX, Math.max(REMOTE_BACKEND_MAX_INFLIGHT_MIN, Math.round(n)))
}

/** 更新全局基准上限（非法/缺省值忽略，不改变当前值） */
export function setRemoteBackendMaxInflight(value: unknown): void {
  const n = Number(value)
  if (!Number.isFinite(n)) return
  remoteBackendMaxInflight = clampInflight(n)
}

/** 编排运行时声明期望并发（幂等；结束/停止时应调用 revokeRemoteConcurrency 释放） */
export function declareRemoteConcurrency(scopeId: string, concurrency: number): void {
  if (!scopeId) return
  concurrencyIntents.set(scopeId, clampInflight(Number(concurrency) || 2))
}

/** 编排运行结束/停止：撤销并发声明（无该声明则忽略） */
export function revokeRemoteConcurrency(scopeId: string): void {
  if (!scopeId) return
  concurrencyIntents.delete(scopeId)
}

/** 当前生效上限 = max(全局基准, 所有活跃编排声明的并发) */
function effectiveRemoteMaxInflight(): number {
  let m = remoteBackendMaxInflight
  for (const n of concurrencyIntents.values()) if (n > m) m = n
  return m
}

/** URL 是否指向本机（本机推理服务并发通常能自持，不限流） */
function isLocalEndpoint(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return !host || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0'
  } catch {
    return false
  }
}

/** 生成后端限流键：provider + origin（同一服务的不同路径共享配额） */
function backendKey(provider: string, url: string): string {
  try {
    return `${provider}:${new URL(url).origin}`
  } catch {
    return `${provider}:${url}`
  }
}

/** 申请一个后端在途配额；超出上限时轮询等待空位（setTimeout 让步，不阻塞其它会话），返回释放函数 */
async function acquireBackendLease(key: string): Promise<() => void> {
  for (;;) {
    const cur = backendInflight.get(key) || 0
    if (cur < effectiveRemoteMaxInflight()) {
      backendInflight.set(key, cur + 1)
      return () => {
        const n = (backendInflight.get(key) || 1) - 1
        if (n <= 0) backendInflight.delete(key)
        else backendInflight.set(key, n)
      }
    }
    // 让出事件循环，避免忙等；释放方会递减计数，轮询自然感知空位
    await new Promise((r) => setTimeout(r, 80))
  }
}

// ---------------------------------------------------------------------------
// Agent 实现
// ---------------------------------------------------------------------------

type InboxItem = { kind: 'user' | 'steer' | 'inject'; content: string; source?: string; images?: string[] }

class AgentImpl implements AgentControl {
  readonly id: AgentId
  readonly options: AgentOptions
  private _status: AgentStatus = 'idle'
  private inbox: InboxItem[] = []
  private pendingWake: Array<() => void> = []
  private idleWaiters: Array<() => void> = []
  private turnController: AbortController | null = null
  private turnCount = 0
  /** 当前 turn 内的 step 编号（每次 turn 重新从 1 计数，turn+step 组合全局唯一） */
  private stepInTurn = 0
  private disposed = false
  private driverRunning = false
  // plan / todos（update_plan、update_todo 工具维护，随 agent/plan、agent/todos 事件广播）
  private _plan: string | null = null
  private _todos: TodoItem[] = []
  /** 最近一次运行状态上报（report_run 工具；整值替换，null = 清除） */
  private _runReport: RunReport | null = null
  private lastError: string | undefined
  /** 最近一次 assistant/message 的完整内容（供工作流智能体节点/agent:run 取最终结果） */
  private lastAssistantContent = ''
  /** 最近一步 LLM 的 finish_reason（length = 被 max_tokens/上下文截断；用于参数解析失败的诊断提示） */
  private lastFinishReason = ''
  /**
   * 本 step 工具参数流式增量累积（callId → JSON 原文）。
   * 仅用于最终 tool_calls 丢参/截断时兜底（见 normalizeToolCalls），每 step 开始前清空。
   */
  private streamedArgs = new Map<string, string>()
  /**
   * 本 step 各工具调用对应的 `tool/call` 事件 seq（callId → seq），每 step 开始前清空。
   * 落 `tool/result` 时写成 `sourceEventSeqs`，把"结果属于哪次调用"从位置推断变成事实引用
   * （复刻 DSH 的 sourceEventSeqs；崩溃恢复补写时同样用它）。
   */
  private currentCallSeq = new Map<string, number>()
  /**
   * 本 step 已算出、已落盘的工具结果（callId → 结果）。
   * step 中途抛错时由崩溃恢复逻辑补写（见 `runTurn` 的 catch：复刻 DSH 的 ToolCallRecovery）。
   * 每 step 开始时重置——只为"当前这一步"补写，避免把上一步早已落盘的结果重复写一遍。
   */
  private stepResults = new Map<string, { name: string; ok: boolean; value?: any; error?: string; code?: string; retryable?: boolean; preview?: any; images?: SavedToolImage[] }>()
  /** 最近一次请求预算里生效的上下文窗口（供工具结果预算按窗口缩放；见 `pushToolResult`） */
  private effectiveWindowTokens = 0
  /** 最近一次请求预算里的预留输出 token（供压缩基准扣减；见 `compactionBasisTokens`） */
  private lastBudgetReserve = 0
  /** 已经补写过的 callId（同一 turn 内不重复补写） */
  private recoveredResultIds = new Set<string>()
  /** 已经广播给 UI 的 tool/result callId（补写时只对"从未广播过"的结果补发事件，避免重复） */
  private emittedResultIds = new Set<string>()
  // 带图任务：user 消息序号（1 基）→ 图片 data URL 数组。
  // 图片只在内存里（会话日志只记数量），每次 buildMessages 按序号挂回对应消息；
  // 只保留最近 4 个带图任务，避免长会话/多次传图长期占内存。
  private taskImagesBySeq = new Map<number, string[]>()
  private optionImagesUsed = false
  /**
   * 本会话是否已确认「模型不支持图片输入」。
   *
   * 一旦服务端因图片 400，就把本会话后续请求里的图片全部省略（会话日志与界面不动），
   * 让 agent 用文本/路径继续任务，而不是整轮中止。只有真正被服务端拒绝时才置真；
   * 名称启发式判不出时不会预先拦（避免误伤自命名视觉模型）。
   */
  private imagesSuppressed = false
  /** 去图是「猜测」（400 但服务端没给图片相关正文）：若去图重放仍失败，要撤销抑制 */
  private imagesSuppressionGuessed = false
  /** 视觉能力缓存：undefined=未算过（三态里「不知道」也缓存成 null） */
  private visionSupportCache: { value: boolean | undefined } | null = null

  // 当前 turn 对应的后台任务（路线图 2.4；turn 结束/取消时完成或取消）
  private jobId: string | null = null
  // 已加载过的技能（防模型反复调用 skill 工具导致死循环）
  private loadedSkills = new Set<string>()
  /** 上下文压缩重入守卫（压缩本身是一次 LLM 调用，不能递归触发） */
  private compacting = false
  /**
   * 剪枝已启用（粘性）：一旦某一步因为压力把早期工具结果剪成"头+尾"，后续步骤沿用同一规则。
   * 不粘住会来回抖：剪完占用降到阈值下 → 下一步不剪 → 又越线 → 再剪……
   */
  private pruneActive = false
  /**
   * 自动压缩失败后的退避时间戳：摘要失败 / 摘要没变小都会让历史保持原样，
   * 而每推进一步又会重新触发——不设退避就会一步一次摘要请求（慢且烧钱）。
   */
  private compactFailedAt = 0
  /** 压缩成功但仍高于阈值时的节流：小窗口 / 系统提示+工具过大时不要每一步都再摘要一次 */
  private compactThrottleUntil = 0
  /** 「压缩救不了」的原因只警告一次（系统提示 + 工具 schema 已超过阈值） */
  private compactOverheadWarned = false
  /** 时间读数：上次注入时刻与「是否已从日志恢复过」（对齐 DSH 的最小间隔语义） */
  private lastTimeContextAt = 0
  private timeContextLoaded = false
  /** 本 turn 开始时刻：时间读数在 step 1 用「本轮之前」的消息做基线 */
  private turnStartedAt = 0
  /**
   * 真实用量锚点：上一步请求由 provider 自报的 promptTokens（含 system prompt 与工具 schema）
   * 及当时发出的派生条目数。后续预算 = 锚点 + 新增条目估算，避免纯字符启发式的系统性偏差
   * （本地后端尤其明显；见 contextBudget.calibrateTokenScale）。压缩重写历史后锚点失效 → 置空。
   */
  private tokenAnchor: TokenAccountingAnchor | null = null
  /** 估算校准系数（真实 / 估算；渲染层按「来源 + 模型」持久化后回传，跨会话复用） */
  private tokenScale: number
  /** 本次请求的纯估算值（不含系数，含工具 schema）与条目数：step 结束后用于校准与锚点 */
  private lastRequestEstimate = 0
  private lastRequestEntries = 0
  /** 本会话配置签名（跨轮复用时判断能否继续；旧会话可能没有） */
  private sessionSignature: string
  /**
   * assistant/chunk 落盘合并缓冲：流式分片仍逐条广播给 UI，但写进会话日志时
   * 合并成 ~1KB / 120ms 一条，避免一个长回答产生上千次 JSONL append。
   */
  private chunkBuffer = ''
  private chunkBufferStartedAt = 0
  /** 相同工具 + 相同参数的连续调用计数（循环卫生守卫；每 turn 重置） */
  private repeatKey = ''
  private repeatCount = 0
  /**
   * 本 turn 冻结的工具定义（P2）：turn 开始时解析一次，运行中注册 / 设置变化
   * 不会改变本 turn 模型可见 schema 与可执行集合；下个 turn 再重新解析。
   */
  private frozenToolDefs: ToolDefinition[] | null = null
  /** 上一 turn 记录进会话日志的模型可见工具名，用于产出 tools/change 的 added / removed */
  private lastToolSnapshot: string[] | null = null

  constructor(options: AgentOptions, init: { id?: string; resume?: boolean } = {}) {
    this.id = brand(init.id || `agent-${randomUUID()}`)
    this.options = { ...options, sessionId: this.id, resume: false }
    this.sessionSignature = agentSessionSignature(options)
    // 估算校准系数的初始值：渲染层按「来源 + 模型」记住上次实测值（本地后端 tokenizer 偏差可达 ±30%）
    this.tokenScale = clampTokenScale(options.tokenScale)
    if (init.resume) {
      // 跨轮 / 跨进程恢复：不重写 session/start，也不重复 seed 历史。
      // 计划与待办从同一份日志折叠（最后一条胜出），turn 编号接着已有记录走。
      const replay = sessionLog.projectAgentState(this.id)
      this._plan = replay.plan
      this._todos = replay.todos
      this.turnCount = sessionLog.countTurns(this.id)
      this.lastAssistantContent = sessionLog.lastAssistantContent(this.id)
      return
    }
    // 会话事件日志：创建即写 session/start（模型可见的 systemPrompt 落盘）
    sessionLog.append(this.id, 'session/start', {
      provider: options.provider,
      model: options.llmConfig?.model || options.config?.model,
      systemPrompt: options.systemPrompt,
      signature: this.sessionSignature,
      createdAt: Date.now(),
    })
    // 会话历史种子：聊天窗口的既有上下文写入本 agent 的日志（模型可见即已记录），
    // 使模型继承多轮对话上下文（deriveMessages 自动包含）
    for (const seed of options.seedHistory || []) {
      sessionLog.append(this.id, seed.role === 'assistant' ? 'assistant/message' : 'user/message', {
        content: seed.content,
        source: 'seed',
      })
    }
    // 计划 / 待办恢复（重开聊天时由渲染层从聊天存档带出）：
    // 走 setPlan/setTodos → 同样以 `plan/write` / `todo/write` 落盘，
    // 于是**本会话的日志自洽**（回放即得当前状态），不依赖上一段会话的日志。
    if (options.seedPlan) this.setPlan(String(options.seedPlan))
    if (Array.isArray(options.seedTodos) && options.seedTodos.length) this.setTodos(options.seedTodos)
    // 上一轮评审的裁决（进程重启后用户回答的那条）：作为一条**已记录**的用户可见消息
    // 注入本会话，使模型知道"那份计划已经批了 / 还要改"——否则裁决只是躺着不动。
    if (options.seedPlanDecision) this.seedPlanDecision(options.seedPlanDecision)
  }

  /** 把上次评审的裁决写成一条落盘的 user 消息（模型可见即已记录） */
  private seedPlanDecision(decision: { verdict: string; feedback?: string; plan?: string }): void {
    const planExcerpt = String(decision.plan || '').trim().slice(0, 2000)
    const planPart = planExcerpt ? `\n\n（上次提交的计划）\n${planExcerpt}` : ''
    const text = decision.verdict === 'approve'
      ? `【计划已获批】用户批准了你上一轮提交的执行计划，请按该计划继续执行；执行中用 update_todo 维护进度。${planPart}`
      : decision.verdict === 'keep'
        ? `【计划待完善】用户要求继续完善上一轮提交的计划，尚未批准${decision.feedback ? `。反馈：${decision.feedback}` : '（未留下文字反馈）'}。请据此修订后用 exit_plan_mode 重新提交，在此之前不要开始执行。${planPart}`
        : `【评审已关闭】用户关闭了上一轮的计划评审（既未批准也未反馈）：请先简要说明当前理解与待确认的问题，等用户指示后再继续。${planPart}`
    sessionLog.append(this.id, 'user/message', { content: text, source: 'plan-review' })
  }

  get status(): AgentStatus {
    return this._status
  }

  /** 最近一次 assistant 完整内容（工作流智能体节点取结果用） */
  get lastContent(): string {
    return this.lastAssistantContent
  }

  /** 已完成的 turn 数 */
  get currentTurn(): number {
    return this.turnCount
  }

  /** 当前配置能否继续复用这条日志（供 createAgent 判断是否新建会话） */
  canResumeWith(options: AgentOptions): boolean {
    return agentSessionSignature(options) === this.sessionSignature
  }

  /**
   * 复用同一会话时把「可原地更新」的运行参数换成最新值。
   * 不替换 provider/model/tools/systemPrompt——这些变化会走新会话（见 canResumeWith）。
   */
  applyResumeOptions(options: AgentOptions): void {
    Object.assign(this.options, options, { sessionId: this.id, resume: false })
    this.tokenScale = clampTokenScale(options.tokenScale ?? this.tokenScale)
  }

  /**
   * 流式正文写日志：合并相邻分片。
   * UI 仍逐条收 `assistant/chunk`；会话日志只用于回放，没必要一个 token 一行。
   */
  private queueAssistantChunk(chunk: string): void {
    if (!chunk) return
    if (!this.chunkBuffer) this.chunkBufferStartedAt = Date.now()
    this.chunkBuffer += chunk
    if (this.chunkBuffer.length >= 1024 || Date.now() - this.chunkBufferStartedAt >= 120) {
      this.flushAssistantChunks()
    }
  }

  /** 把合并缓冲写进会话日志（step 结束 / 取消 / turn 结束前调用） */
  private flushAssistantChunks(): void {
    if (!this.chunkBuffer) return
    const content = this.chunkBuffer
    this.chunkBuffer = ''
    this.chunkBufferStartedAt = 0
    sessionLog.append(this.id, 'assistant/chunk', { content })
  }

  // ---------------- inbox 语义 ----------------

  /**
   * 发送用户任务。`images`（data URL 数组）为多模态附图：
   * - 显式传入优先；
   * - 否则首次 send 时取 `options.taskImages`（agent:create 时带的图，供工作流节点等入口使用）；
   * 图片只在内存里保存（见 taskImageData），会话日志只记数量。
   */
  send(content: string, source?: string, images?: string[]): void {
    // 人回了话 = 上一条「在等你」的上报已得到响应：清掉它，
    // 避免「待我处理」面板挂着过期条目（语义同原型的 waitsForPerson：有新的人类输入就不再等人）。
    if (this._runReport) this.setRunReport(null)
    let imgs = Array.isArray(images) ? images.filter(Boolean) : []
    if (imgs.length === 0 && !this.optionImagesUsed && this.options.taskImages?.length) {
      imgs = this.options.taskImages.filter(Boolean)
      this.optionImagesUsed = true
    }
    this.inbox.push({ kind: 'user', content, source, images: imgs.length ? imgs : undefined })
    this.wake()
  }

  followup(content: string, source?: string, images?: string[]): void {
    this.send(content, source, images)
  }

  steer(content: string): void {
    this.inbox.push({ kind: 'steer', content })
    this.wake()
  }

  inject(content: string): void {
    // 只排队不唤醒：落到下一次 step 的上下文中
    this.inbox.push({ kind: 'inject', content })
    this.emit('agent/inbox', { pending: this.inbox.length })
  }

  cancel(cause: AgentCancelCause, opts?: { keepInbox?: boolean }): void {
    if (this._status === 'disposed') return
    if (!opts?.keepInbox) {
      // 清空排队与转向工作（注入上下文随取消丢弃，对齐 DSH 语义）
      this.inbox = []
      this.emit('agent/inbox', { pending: 0 })
    }
    this._status = 'stopping'
    this.emitStatus()
    // 中止 turn 的同时 reject 挂起的 ask_user 问题，防止驱动器卡在工具等待上
    rejectPendingQuestions(this.id, `执行已取消（${cause}）`)
    rejectPendingRendererTasks(this.id, `执行已取消（${cause}）`)
    this.turnController?.abort(cause)
  }

  whenIdle(): Promise<void> {
    return new Promise((resolve) => {
      if (this._status === 'idle' || this._status === 'disposed') {
        resolve()
        return
      }
      this.idleWaiters.push(resolve)
    })
  }

  /**
   * 旁路一次性调用：发送内容并在本轮 turn 结束后返回最终助手文本。
   *
   * 不能直接用 `whenIdle()`：`send()` 只是把输入投递到 inbox，驱动器还没来得及把状态切到
   * running，此时 `whenIdle()` 会**立即解析**（拿到的 lastContent 是空的）。
   * 这里先等状态离开 idle（有界等待），再等收敛。
   */
  async runOnce(content: string): Promise<string> {
    this.send(content)
    const deadline = Date.now() + 5 * 60_000
    while (!this.disposed && this._status === 'idle' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    await this.whenIdle()
    return this.lastAssistantContent
  }

  async dispose(): Promise<void> {
    if (this._status === 'disposed') return
    this.disposed = true
    this._status = 'disposed'
    this.emitStatus()
    this.inbox = []
    this.turnController?.abort('dispose')
    this.wake() // 让驱动器收敛退出
    // 等待驱动器退出（有界）
    const deadline = Date.now() + 5000
    while (this.driverRunning && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    agents.delete(this.id)
    // reject 全部挂起问题（防止 ask_user 的 Promise 悬挂）
    rejectPendingQuestions(this.id, 'agent 已销毁')
    rejectPendingRendererTasks(this.id, 'agent 已销毁')
    // 取消该 agent 的后台任务（路线图 2.4：owner 级联取消）
    if (this.jobId) {
      jobRegistry.cancel(this.jobId, 'agent 已销毁')
      this.jobId = null
    }
    jobRegistry.cancelForOwner(this.id, 'agent 已销毁')
    // 会话级工作目录只活在内存里：会话销毁即清空
    try { forgetWorkingDir(this.id) } catch { /* 忽略 */ }
    try { clearReadCacheFor(this.id) } catch { /* 忽略 */ }
    this.flushAssistantChunks()
    sessionLog.append(this.id, 'session/end', { status: 'disposed' })
    await sessionLog.flush(this.id)
    // 会话销毁：回收该会话仍遗留的浏览器 AI 标签
    try { browserAgentService.recycleOwnerTabs(this.id) } catch { /* 忽略 */ }
    this.notifyIdle()
  }

  // ---------------- 驱动器 ----------------

  /** 启动驱动器（createAgent 调用一次；内部循环直到 dispose） */
  drive(): void {
    void this.driveInternal()
  }

  private async driveInternal(): Promise<void> {
    this.driverRunning = true
    try {
      while (!this.disposed) {
        const item = await this.waitForWake()
        if (!item || this.disposed) break
        if (this._status === 'stopping') {
          // 取消后收敛：把未处理的输入归还 inbox，回到 idle 等待下次唤醒
          this.inbox.unshift(item)
          this._status = 'idle'
          this.emitStatus()
          this.notifyIdle()
          continue
        }
        this._status = 'running'
        this.emitStatus()
        await this.runTurn(item)
        if (this.disposed) break
        this._status = 'idle'
        this.emitStatus()
        // 浏览器会话标签按属主精确回收：本会话跑完（回到 idle）即回收它自己开的 AI 标签，
        // 10 个 agent 谁结束收谁的，不依赖全局 90s 静默 / cap（保留：当前激活 / 用户接管的标签）
        try { browserAgentService.recycleOwnerTabs(this.id) } catch { /* 忽略（窗口未开/已关等） */ }
        this.notifyIdle()
      }
    } finally {
      this.driverRunning = false
      this.notifyIdle()
    }
  }

  private waitForWake(): Promise<InboxItem | null> {
    return new Promise((resolve) => {
      const check = () => {
        const idx = this.inbox.findIndex((i) => i.kind !== 'inject')
        if (idx >= 0) {
          resolve(this.inbox.splice(idx, 1)[0])
        } else if (this.disposed) {
          resolve(null)
        } else {
          this.pendingWake.push(check)
        }
      }
      check()
    })
  }

  private wake(): void {
    this.emit('agent/inbox', { pending: this.inbox.length })
    while (this.pendingWake.length) this.pendingWake.shift()?.()
  }

  private notifyIdle(): void {
    while (this.idleWaiters.length) this.idleWaiters.shift()?.()
  }

  // ---------------- turn / step ----------------

  private async runTurn(firstItem: InboxItem): Promise<void> {
    const turn = ++this.turnCount
    // 错误是「本轮」的事实：上一轮失败后继续发任务时，不能把旧错误带进本轮
    // （否则本轮正常完成，job 仍会被 finally 标成 failed，UI 的 restore 也会读回旧错误）。
    this.lastError = undefined
    // 每个 turn（一次任务）的 step 从 1 重新编号：控制台执行时间线从 Step 1 开始，
    // 而不是沿用跨 turn 的全局递增序号（旧实现第二次任务从 Step 2 起）
    this.stepInTurn = 0
    this.repeatKey = ''
    this.repeatCount = 0
    // 时间读数的基线：本轮开始前的「上一条模型可见消息」——不含本轮刚提交的这条用户消息
    this.turnStartedAt = Date.now()
    // P2：先冻结本 turn 的工具定义，再写 turn/start；`tools/change` 记录的是
    // 「本 turn 实际下发给模型」的集合，而不是实时注册表（后者可能在本 turn 中途变化）。
    this.frozenToolDefs = this.visibleToolDefs()
    sessionLog.append(this.id, 'turn/start', { turn })
    this.logToolSetChange(turn)
    this.emit('agent/turn-start', { turn })
    // 清单的回合边界收口（对齐 DSH todo 投影的 turn/start 语义）：上一轮已全部收口的
    // 清单不带进新任务——旧清单留在界面上会被误读成本轮计划；仍有未完成项时保留
    // （用户可能正接着上一轮继续做）。
    this.settleTodosAtTurnStart()

    // 后台任务身份（路线图 2.4）：每个 turn 一个 job，owner = agent id
    const job = jobRegistry.start('agent', this.id, `Agent turn ${turn}`, { progress: 0, detail: '开始处理' })
    this.jobId = job.id

    this.turnController = new AbortController()
    let item: InboxItem | null = firstItem
    let owesWork = true
    let aborted = false
    let stepsInTurn = 0
    // 本步已算出的工具结果（供崩溃恢复补写：见 catch 块的 ToolCallRecovery 逻辑）。
    // 字段化是因为 `pushToolResult` 需要写入；每步开始时重置。
    this.stepResults = new Map()
    // 已补写过的 callId / 已广播给 UI 的结果：同一 turn 内的记账
    this.recoveredResultIds = new Set()
    this.emittedResultIds = new Set()
    // max_tokens 截断续跑计数（复刻 DSH 把 finish=max-tokens 当"下一步继续"的信号；见 MAX_LENGTH_CONTINUES）
    let lengthContinues = 0
    // 本 turn 因输出截断而跳过工具调用的次数（见 MAX_TRUNCATED_TOOL_SKIPS）
    let truncatedToolSkips = 0
    // 循环轮数：由渲染进程按唯一数据源（store.generalAgentMaxSteps / preset.maxSteps）注入；兜底同源默认值
    const maxSteps = this.options.maxSteps ?? DEFAULT_AGENT_MAX_STEPS

    try {
      while (owesWork && !this.disposed) {
        if (this.turnController.signal.aborted) break
        if (stepsInTurn >= maxSteps) {
          // 防死循环：达到单 turn step 上限（fail-loud，不静默截断）
          const message = stepLimitMessage(maxSteps)
          sessionLog.append(this.id, 'agent/status', { status: 'error' })
          this.emit('agent/error', { message })
          this.setError(message)
          jobRegistry.fail(this.jobId!, message)
          break
        }
        stepsInTurn++

        // 领取本 step 的注入上下文（inject 只排队不唤醒，在 step 边界消费）
        const injected = this.drainInjected()
        const step = ++this.stepInTurn
        sessionLog.append(this.id, 'step/start', { turn, step })
        this.emit('agent/step-start', { turn, step })
        // 任务进度（0..100；maxSteps 为上限，步骤完成即推进）
        jobRegistry.progress(this.jobId!, Math.min(95, Math.round((stepsInTurn / Math.max(1, maxSteps)) * 100)), `步骤 ${stepsInTurn}/${maxSteps}`)

        // 时间读数（对齐 DSH 的 time-context）在 buildMessages 里、用户输入落盘之后追加，
        // 这样模型看到的是「用户说了什么 → 现在几点」的正确顺序。
        // item 为 null 时（工具调用后续轮）消息仅由日志历史 + 注入上下文组成
        const messages = await this.buildMessages(item, injected, { turn, step })
        // 本 step 的工具参数流式累积清零（最终 payload 丢参时按 callId 兜底用）
        this.streamedArgs.clear()
        this.currentCallSeq.clear()
        // 本 step 的结果集合清零（崩溃恢复只补写当前 step 的结果）
        this.stepResults = new Map()
        // 持久化屏障：本 step 的输入（用户消息 / 注入上下文）先真正落盘，再发模型请求。
        // 日志是唯一事实源；崩溃后不应出现「模型已经看过、日志里却还没有」的输入。
        await sessionLog.flush(this.id)
        const result = await this.runStepWithOverflowRetry(messages)
        // 模型把工具调用写成 XML 正文时，先修复成结构化 tool_calls，避免本步没有工具可执行而结束循环
        this.rescueTextToolCalls(result)
        item = null // 本 step 的输入已消费

        // 真实用量校准：provider 自报的 promptTokens 就是**这份请求**的真实计数
        // （Ollama prompt_eval_count / OpenAI 兼容 usage.prompt_tokens），含 system prompt 与工具 schema。
        // 用它建立「锚点 + 新增内容估算」的口径，并更新估算系数（本地后端 tokenizer 偏差由此消除）。
        // lastRequestEntries < 0 表示本 step 内发生过压缩重放（条目序号已重排）→ 本轮不建锚点。
        const realPromptTokens = Number(result.usage?.promptTokens) || 0
        if (realPromptTokens > 0 && this.lastRequestEntries >= 0) {
          this.tokenAnchor = { entryCount: this.lastRequestEntries, promptTokens: realPromptTokens }
          if (this.lastRequestEstimate > 0) {
            this.tokenScale = calibrateTokenScale(this.tokenScale, this.lastRequestEstimate, realPromptTokens)
          }
        }

        if (this.turnController.signal.aborted) break
        // 归一化工具调用 arguments（GPUStack qwen3_xml 常给多层转义畸形 JSON），
        // 入日志/回传前解析为干净单层 JSON 字符串，避免下一轮回传 vLLM 时 400 Extra data；
        // 最终 payload 丢参/截断时用本步流式原文兜底（否则工具会拿空参数执行）
        const norm = normalizeToolCalls(result.toolCalls, (callId) => this.streamedArgs.get(callId))
        const cleanCalls = norm.calls
        this.lastFinishReason = result.finishReason || ''
        if (norm.recovered.length) {
          console.warn(`[agent] 工具参数已用流式原文兜底（callId=${norm.recovered.join(',')}）：最终 tool_calls 缺失/截断参数`)
        }
        // 先落盘尚未合并的流式正文，保证事件顺序：chunk → assistant/message
        this.flushAssistantChunks()
        sessionLog.append(this.id, 'assistant/message', {
          content: result.content,
          toolCalls: cleanCalls,
          reasoning: result.reasoning,
        })
        this.lastAssistantContent = result.content
        this.emit('assistant/message', { content: result.content, toolCalls: cleanCalls })

        let toolCallsCount = 0
        let truncatedGiveUp = false
        if (cleanCalls.length) {
          // 输出被 max_tokens 截断：**一个工具都不派发**（对齐 DSH 的 max-tokens 语义）。
          // 工具参数的 JSON 是流式拼出来的，截断后既不能执行、也没有可靠的"续写半个 JSON"办法；
          // 直接回灌「未执行 + 请缩小单次提交量」的合成结果，让模型下一步自己改小，避免
          // "半截参数被当成失败执行 / 界面上却像写成功了"的歧义。
          if (this.lastFinishReason === 'length') {
            truncatedToolSkips++
            truncatedGiveUp = truncatedToolSkips > MAX_TRUNCATED_TOOL_SKIPS
            const notice = truncatedGiveUp
              ? `输出连续 ${MAX_TRUNCATED_TOOL_SKIPS} 次被 max_tokens 截断，已停止派发工具调用。请拆分任务（大文件分段写入）或调高 max_tokens 后重试。`
              : `模型输出被 max_tokens 截断：本步 ${cleanCalls.length} 个工具调用均未执行，已提示模型缩小单次提交量。`
            this.emit('agent/notice', { kind: 'truncated-tool-calls', message: notice })
            if (truncatedGiveUp) {
              this.setError(notice)
              this.emit('agent/error', { message: notice })
            }
            for (const call of cleanCalls) {
              const callId = String(call?.id || `call-${step}-${Math.random().toString(36).slice(2, 8)}`)
              const name = String(call?.name || call?.function?.name || '')
              const raw = this.streamedArgs.get(callId)
                || (typeof call?.function?.arguments === 'string' ? call.function.arguments : '')
              this.rejectToolCall(callId, name, this.truncatedToolCallError(name, raw.length, truncatedGiveUp), step, raw.length)
            }
            toolCallsCount = cleanCalls.length
          } else {
            // 只读工具并行（有界池），写/执行类工具独占；结果按模型顺序提交
            await this.executeToolCalls(cleanCalls, step)
            toolCallsCount = cleanCalls.length
          }
        }

        sessionLog.append(this.id, 'step/end', { turn, step, toolCalls: toolCallsCount })
        this.emit('agent/step-end', { turn, step, toolCalls: toolCallsCount, usage: result.usage, tokenScale: this.tokenScale })

        // 工具调用欠一次请求（继续下一 step 携带工具结果），
        // 或运行期间收到了 steer（转向下一 step）→ 继续
        const pendingSteer = this.claimPendingSteer()

        // max_tokens 截断续跑（复刻 DSH：finish=max-tokens 时不结束 turn，而是再走一个 step）。
        // 为什么需要：输出被 max_tokens 截断时 `toolCalls` 往往是空的，旧逻辑据此判定 turn 结束，
        // 于是"任务做到一半被截断"被当成"任务做完了"——比报错更糟，因为没有任何信号。
        // 判定抽在 @/shared/truncation 里（纯函数、有自测覆盖）。
        const truncation = decideTruncationContinue({
          finishReason: this.lastFinishReason,
          contentChars: result.content.trim().length,
          toolCallCount: toolCallsCount,
          hasPendingSteer: !!pendingSteer,
          continuesSoFar: lengthContinues,
          maxContinues: MAX_LENGTH_CONTINUES,
        })
        if (truncation.shouldContinue) {
          lengthContinues++
          this.emit('agent/notice', {
            kind: 'truncated-continue',
            message: `模型输出被 max_tokens 截断，已自动续跑（第 ${lengthContinues}/${MAX_LENGTH_CONTINUES} 次）`,
          })
        } else if (truncation.gaveUp) {
          // 达到上限仍被截断：明确告知（不静默），让用户知道任务可能不完整
          const message = `模型输出连续 ${MAX_LENGTH_CONTINUES} 次被 max_tokens 截断，已停止续跑（任务可能未完成）。`
            + '建议：调高 max_tokens / 换上下文窗口更大的模型，或把任务拆小。'
          this.emit('agent/notice', { kind: 'truncated-giveup', message })
          console.warn(`[agent] ${this.id} ${message}`)
        }
        // 一旦这一步不再被截断，额度复位（后续新的截断重新享有完整额度）
        if (!truncation.truncated) lengthContinues = 0

        // 续跑时不给新的 user 内容：被截断的那半截内容已在历史里（assistant 消息），
        // 模型看到的历史本身就是"说到一半"，直接再请求即从断点继续。
        // 截断且给了工具调用时，跳过派发后仍要继续一步，把"未执行"的合成结果喂回模型；
        // 但连续多次仍撞上限（truncatedGiveUp）时不再继续，避免无意义地重试。
        owesWork = (!truncatedGiveUp && toolCallsCount > 0) || !!pendingSteer || truncation.shouldContinue
        item = pendingSteer
      }
    } catch (err: any) {
      aborted = this.turnController.signal.aborted
      // 崩溃恢复（复刻 DSH 的 ToolCallRecovery）：step 中途抛错时，把本步**已经算出**但还没落盘的工具结果
      // 补写进日志。为什么重要：日志是唯一事实源，`deriveEntries` 对"有 tool_call 没 tool_result"的
      // 配对会填 `ERROR: 工具结果缺失（日志不完整）`——**这行字会发给模型**。
      // 工具其实跑成功了、只是结果没来得及写盘，模型却被告知"结果缺失"，就会去重跑一遍有副作用的工具。
      // 补写用 `sourceEventSeqs` 显式指向对应的 tool/call，因此即便同一 callId 被写两次也能说清归属。
      try {
        // 一次快照，避免循环内反复解析整份日志
        const allEvents = sessionLog.readAll(this.id)
        const callSeqByCleanId = new Map<string, number>()
        for (const e of allEvents) {
          if (e.type === 'tool/call') callSeqByCleanId.set(e.callId, e.seq)
        }
        for (const [callId, rec] of this.stepResults) {
          if (this.recoveredResultIds.has(callId)) continue
          this.recoveredResultIds.add(callId)
          const callSeq = callSeqByCleanId.get(callId)
          sessionLog.append(this.id, 'tool/result', {
            callId,
            name: rec.name,
            ok: rec.ok,
            ...(rec.code ? { code: rec.code } : {}),
            ...(rec.retryable !== undefined ? { retryable: rec.retryable } : {}),
            value: rec.value,
            error: rec.error,
            preview: rec.preview,
            ...(rec.images?.length ? { images: rec.images } : {}),
            ...(callSeq !== undefined ? { sourceEventSeqs: [callSeq] } : {}),
          })
          // 只对"从未广播过"的结果补发 UI 事件（原始路径已广播过的不要重复）
          if (!this.emittedResultIds.has(callId)) {
            this.emittedResultIds.add(callId)
            this.emit('tool/result', { callId, name: rec.name, ok: rec.ok, value: rec.value, error: rec.error, preview: rec.preview })
          }
        }
      } catch (recoveryError) {
        console.error(`[agent] ${this.id} 工具结果补写失败（已放弃，历史可能出现悬空 tool_call）:`, recoveryError)
      }
      if (!aborted) {
        const raw = err?.message || String(err)
        // 上下文超限且压缩后仍失败：给可操作提示，而不是一句原始 400
        const message = isContextOverflowError(raw)
          ? `上下文超限（已尝试压缩仍无法继续）：${raw}\n建议：减少单次读取/搜索返回量、开启新会话，或改用上下文窗口更大的模型。`
          : raw
        this.setError(message)
        sessionLog.append(this.id, 'agent/status', { status: 'error' })
        this.emit('agent/error', { message })
      }
    } finally {
      // 中止可能是抛异常路径（catch 已置 aborted）或 step 之间检查到 signal.aborted
      const wasAborted = aborted || (this.turnController?.signal.aborted ?? false)
      // 流式正文还没合并落盘（取消 / 抛错 / 只在末尾产出）时补一条，避免回放缺正文
      this.flushAssistantChunks()
      const reason = wasAborted ? 'cancelled' : 'completed'
      sessionLog.append(this.id, 'turn/end', { turn, reason })
      this.emit('agent/turn-end', { turn, reason })
      // 后台任务收尾：取消/异常 → 标记取消或失败；正常 → 完成
      if (this.jobId) {
        if (wasAborted) {
          jobRegistry.cancel(this.jobId, this.lastError ? `已取消：${this.lastError}` : '用户取消')
        } else if (this.lastError) {
          jobRegistry.fail(this.jobId, this.lastError)
        } else {
          jobRegistry.complete(this.jobId)
        }
        this.jobId = null
      }
      // turn 边界屏障：把本轮的 chunk / tool / turn 事件真正落盘后再回到 idle
      await sessionLog.flush(this.id)
      this.frozenToolDefs = null
      this.turnController = null
    }
  }

  private drainInjected(): InboxItem[] {
    const injected = this.inbox.filter((i) => i.kind === 'inject')
    this.inbox = this.inbox.filter((i) => i.kind !== 'inject')
    if (injected.length) this.emit('agent/inbox', { pending: this.inbox.length })
    return injected
  }

  private claimPendingSteer(): InboxItem | null {
    const idx = this.inbox.findIndex((i) => i.kind === 'steer')
    if (idx < 0) return null
    const [item] = this.inbox.splice(idx, 1)
    return item
  }

  // ---------------- 时间读数（对齐 DSH 的 dsh-time-context） ----------------

  /**
   * 距上次读数 ≥ {@link TIME_CONTEXT_REFRESH_MS} 时，往持久历史追加一条 user 读数。
   *
   * 三行内容（模型可见）：带偏移与时区名的 ISO 时间戳、浏览器时区策略、距上一条模型可见消息
   * （或上一个读数）的时长。追加的是 `synthetic` 消息：参与模型上下文与预算，但不计入
   * "真实用户轮次"（否则会打乱附图序号与压缩的轮次口径）。
   */
  private maybeAppendTimeContext(turn: number, step: number): void {
    if (this.options.timeContext === false) return
    if (this.turnController?.signal.aborted) return
    const now = Date.now()

    // 恢复会话：日志里可能已有读数（含被压缩遮蔽的），用来延续最小间隔
    if (!this.timeContextLoaded) {
      this.timeContextLoaded = true
      try {
        for (const ev of sessionLog.readAll(this.id)) {
          if (ev.type !== 'user/message' || (ev as any).source !== 'time-context') continue
          const ts = Number(ev.ts) || 0
          if (ts > this.lastTimeContextAt) this.lastTimeContextAt = ts
        }
      } catch {
        /* 日志不可读：按首次处理 */
      }
    }
    if (this.lastTimeContextAt > 0 && now - this.lastTimeContextAt < TIME_CONTEXT_REFRESH_MS) return

    const requestZone = isValidTimeZone(this.options.timeZone) ? String(this.options.timeZone) : ''
    const zone = requestZone || this.processTimeZone()

    // 基线：第 1 步 = 上一条模型可见消息；后续步 = 上一条时间读数
    const sinceStepContext = step > 1 && this.lastTimeContextAt > 0
    let elapsedMs: number | null = null
    if (sinceStepContext) {
      elapsedMs = Math.max(0, now - this.lastTimeContextAt) // 挂钟倒退时钳到 0
    } else {
      // step 1：基线是本轮开始前的最后一条模型可见消息（不含本轮刚提交的用户消息）
      const prev = this.lastModelVisibleTs(now, this.turnStartedAt || now)
      if (prev > 0) elapsedMs = Math.max(0, now - prev)
    }

    const content = formatTimeContext({
      turn,
      step,
      now,
      zone,
      requestZone: requestZone || undefined,
      elapsedMs,
      sinceStepContext,
    })
    sessionLog.append(this.id, 'user/message', { content, source: 'time-context', synthetic: true })
    this.lastTimeContextAt = now
  }

  /** 宿主进程时区（浏览器时区缺失时的回退） */
  private processTimeZone(): string {
    try {
      const z = Intl.DateTimeFormat().resolvedOptions().timeZone
      return isValidTimeZone(z) ? z : 'UTC'
    } catch {
      return 'UTC'
    }
  }

  /** 最近一条「模型可见」消息的时间戳（排除时钟读数与合成消息；`beforeTs` 为上限，不含等于） */
  private lastModelVisibleTs(before: number, beforeTs?: number): number {
    const upper = Math.min(before, Number(beforeTs) > 0 ? Number(beforeTs) : before)
    let latest = 0
    try {
      for (const ev of sessionLog.readAll(this.id)) {
        if (ev.type !== 'user/message' && ev.type !== 'assistant/message') continue
        if ((ev as any).synthetic) continue
        const ts = Number(ev.ts) || 0
        if (ts > 0 && ts < upper && ts > latest) latest = ts
      }
    } catch {
      /* 忽略：没有基线就报告 unavailable */
    }
    return latest
  }

  /**
   * 构建本 step 的请求消息（async：可能在请求前触发上下文压缩）。
   * 顺序：先落盘本 step 输入 →（预算检查）必要时压缩旧轮次 → 从日志派生请求消息。
   */
  private async buildMessages(
    item: InboxItem | null,
    injected: InboxItem[],
    ctx: { turn: number; step: number },
  ): Promise<any[]> {
    // "模型可见即已记录"：本 step 的输入（用户消息 / 注入上下文）先落盘，
    // 再从日志派生历史——工具续轮时原始输入不会丢失，且可完整重建
    if (injected.length > 0) {
      const text = injected.map((i) => i.content).join('\n\n')
      sessionLog.append(this.id, 'user/message', {
        content: `<injected_context>\n${text}\n</injected_context>`,
        source: 'inject',
      })
    }
    if (item) {
      sessionLog.append(this.id, 'user/message', {
        content: item.content,
        source: item.source,
        images: item.images?.length || undefined,
      })
    }
    // 时间读数：本 step 的输入已落盘，追加一条「现在几点 / 什么时区 / 距上次多久」（按间隔节流）
    this.maybeAppendTimeContext(ctx.turn, ctx.step)
    // 模型历史从会话日志派生（单一事实源，而不是第二份消息状态）
    let entries = sessionLog.deriveEntries(this.id)
    // 附图任务：记住「第 N 条 user 消息带图」（图片本体不进日志，后续 step / 多轮都从这里复原）
    if (item?.images?.length) {
      const seq = this.userSeqOf(entries)
      this.taskImagesBySeq.set(seq, item.images)
      if (this.taskImagesBySeq.size > 4) {
        const oldest = this.taskImagesBySeq.keys().next().value
        if (typeof oldest === 'number') this.taskImagesBySeq.delete(oldest)
      }
    }
    // 上下文压缩（P0）：请求前预算检查，达到阈值即压缩旧轮次（写日志 → 重新派生）
    if (this.options.contextCompact !== false) {
      const budget = this.requestBudget(entries)
      if (budget.level === 'compact') {
        console.info(`[agent-compact] ${this.id} 占用约 ${(budget.ratio * 100).toFixed(0)}%（${budget.used}/${budget.limit} tokens，估算×${this.tokenScale.toFixed(2)}${this.tokenAnchor ? '，以真实用量为锚点' : ''}）→ 先剪枝，再决定是否摘要`)
        // ① 先剪枝（对齐 DSH 的 tool-result-pruner）：不调模型，常常能直接把占用拉回阈值内
        const pruned = pruneToolResults(this.toBudgetEntries(entries), { keepRecent: PRUNE_KEEP_RECENT })
        let handledByPrune = false
        if (pruned.pruned > 0) {
          // DSH 的修剪会持久改写会话表层；这里等价地把「之后的请求」也切到剪枝版本，
          // 否则只把剪枝结果用于测量，实际请求仍带着未剪枝的大工具结果（估算也会偏低）。
          this.pruneActive = true
          const after = planAgentBudget({
            limit: this.options.contextLimit,
            entries: pruned.items,
            schemaTokens: estimateToolSchemaTokens(this.visibleTools()),
            anchor: this.tokenAnchor,
            scale: this.tokenScale,
          })
          if (after.level !== 'compact') {
            handledByPrune = true
            console.info(`[agent-compact] ${this.id} 剪枝了 ${pruned.pruned} 条工具结果（省约 ${pruned.savedChars} 字符），占用降到 ${(after.ratio * 100).toFixed(0)}%，跳过摘要`)
          }
        }
        // ② 剪枝不够才真正摘要（一次额外的 LLM 调用）；刚失败过的 60 秒内不重试，避免一步一次摘要请求。
        //    DSH 的 compactionRetries 默认 1：压一次仍高于阈值时会再压一次，而不是等到下一步再重复。
        const backoff = Date.now() - this.compactFailedAt < 60_000
        const throttled = Date.now() < this.compactThrottleUntil
        // 小窗口保护：系统提示 + 工具 schema 是**不可压缩的固定开销**。若它们本身已达到阈值，
        // 摘要历史永远压不回阈值下——再压只会每步多花一次 LLM 调用（8K/32K 窗口尤其明显）。
        const thresholdTokens = compactThresholdTokens({ limit: budget.limit, reserve: budget.reserve })
        const fixedOverhead = estimateTokens(String(this.options.systemPrompt || ''))
          + estimateToolSchemaTokens(this.visibleTools())
        const overheadTooLarge = fixedOverhead >= thresholdTokens
        if (overheadTooLarge && !this.compactOverheadWarned) {
          this.compactOverheadWarned = true
          console.warn(`[agent-compact] ${this.id} 系统提示与工具 schema 约 ${fixedOverhead} tokens ≥ 压缩阈值 ${thresholdTokens}：压缩历史无法降到阈值以下，已跳过自动摘要（可减少启用的工具 / 技能，或换更大上下文窗口）`)
          this.compactThrottleUntil = Date.now() + 60_000
        }
        if (!handledByPrune && (backoff || throttled || overheadTooLarge)) {
          if (backoff) console.info(`[agent-compact] ${this.id} 上次压缩失败，60 秒内不自动重试（仍可使用手动压缩）`)
          else if (throttled) console.info(`[agent-compact] ${this.id} 压缩后仍高于阈值，60 秒内不重复摘要`)
        } else if (!handledByPrune) {
          for (let attempt = 0; attempt <= COMPACT_RETRIES; attempt++) {
            const ok = await this.compact('auto')
            if (!ok) break
            entries = sessionLog.deriveEntries(this.id)
            const next = this.requestBudget(entries)
            if (next.level !== 'compact') break
            if (attempt >= COMPACT_RETRIES) {
              console.warn(`[agent-compact] ${this.id} 已连续压缩 ${attempt + 1} 次仍高于阈值（估算 ${next.used}/${next.limit} tokens），60 秒内不再重复摘要`)
              this.compactThrottleUntil = Date.now() + 60_000
              break
            }
          }
        }
      }
    }
    // 记录「本次请求的纯估算值与条目数」：step 结束后用 provider 自报的真实计数校准系数 + 建立锚点
    this.lastRequestEntries = entries.length
    this.lastRequestEstimate = estimateMessagesTokens(this.toBudgetEntries(entries))
      + estimateToolSchemaTokens(this.visibleTools())
    return this.toRequestMessages(entries)
  }

  /** 日志派生条目 → 请求消息（附图按「真实 user 消息序号」挂回；压缩摘要不计入序号） */
  private toRequestMessages(entries: DerivedEntry[]): any[] {
    let userSeq = 0
    const msgs = entries.map(({ msg }) => {
      const out = toOpenAIMessage(msg)
      // 压缩检查点：模型看到的是「前导语 + <compacted-summary>」；界面里仍显示纯摘要
      if (msg.compacted && typeof out.content === 'string') {
        out.content = renderCompactedCheckpoint(out.content)
      }
      if (out.role === 'user' && !msg.compacted && !msg.synthetic) {
        userSeq++
        const imgs = this.taskImagesBySeq.get(userSeq)
        if (imgs?.length && !out.images) out.images = imgs
      }
      // 模型不支持图片（服务端已确认）：请求投影里去掉图片并留一句可执行说明。
      // ⚠️ 只改发出去的内容，会话日志与界面仍保留图片（换视觉模型后还能恢复）。
      if (this.imagesSuppressed && out.images) {
        delete out.images
        if (typeof out.content === 'string') {
          out.content += msg.synthetic
            ? '\n\n（图片已省略：当前模型不支持图片输入。请根据工具返回的文本/路径继续；需要看图时提示用户改用支持视觉的模型，不要重复调用读图/截图工具。）'
            : '\n\n（随消息附带的图片已省略：当前模型不支持图片输入。请只依据以上文本继续。）'
        }
      }
      return out
    })
    if (!this.pruneActive) return msgs
    // 剪枝只改发出去的内容，会话日志与界面仍是原文
    const items = msgs.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' }))
    const pruned = pruneToolResults(items, { keepRecent: PRUNE_KEEP_RECENT })
    return msgs.map((m, i) => (pruned.items[i] === items[i] ? m : { ...m, content: pruned.items[i].content }))
  }

  /** 真实 user 消息条数（压缩摘要/工具图片合成消息不计） */
  private userSeqOf(entries: DerivedEntry[]): number {
    return entries.reduce((n, e) => n + (e.msg.role === 'user' && !e.msg.compacted && !e.msg.synthetic ? 1 : 0), 0)
  }

  /**
   * 本次请求的预算（system prompt + 工具 schema + 全部历史）。
   *
   * 三条口径，都直接决定「压缩够不够及时」：
   *  1) **工具结果与工具参数全部计入**（read_file 返回的文件正文在 tool 消息里、
   *     write_file 的正文在 assistant 的 tool_calls 里，两者都随请求回发）；
   *  2) **附图按张数计入**（图片本体在内存里，但每次请求都会带上，占用真实存在）；
   *  3) **优先用 provider 自报的真实计数做锚点**（Ollama 的 prompt_eval_count、
   *     OpenAI 兼容的 usage.prompt_tokens），只对锚点之后新增的内容做估算并乘校准系数——
   *     本地后端 tokenizer 与字符启发式的系统性偏差（实测代码/JSON 类内容约 1.15~1.30 倍）
   *     由此被消除，而不是一路低估到溢出。
   */
  private requestBudget(entries: DerivedEntry[]): ContextBudget {
    const budget = this.toBudgetEntries(entries)
    const planned = planAgentBudget({
      limit: this.options.contextLimit,
      entries: budget,
      schemaTokens: estimateToolSchemaTokens(this.visibleTools()),
      anchor: this.tokenAnchor,
      scale: this.tokenScale,
    })
    // 记录生效窗口与预留输出：工具结果预算按窗口缩放，压缩基准按"窗口 − 预留 − schema"。
    this.effectiveWindowTokens = planned.limit
    this.lastBudgetReserve = planned.reserve
    return planned
  }

  /** 派生条目 → 预算条目（附图按「真实 user 消息序号」折算张数；与请求消息一一对应） */
  private toBudgetEntries(entries: DerivedEntry[]): BudgetMessage[] {
    let userSeq = 0
    const items = entries.map(({ msg }) => {
      const out: BudgetMessage = {
        role: msg.role,
        // 与 toRequestMessages 保持同口径：压缩检查点按"前导语 + 标签"估算
        content: msg.compacted ? renderCompactedCheckpoint(msg.content) : msg.content,
        toolCalls: msg.toolCalls,
      }
      if (msg.role === 'user' && !msg.compacted && !msg.synthetic) {
        userSeq++
        const imgs = this.taskImagesBySeq.get(userSeq)
        if (imgs?.length && !this.imagesSuppressed) out.images = imgs.length
      }
      // 工具截图合成的图片消息：图片本体参与预算（每条按张数计）；已去图时不占预算
      if (msg.role === 'user' && msg.images?.length && !this.imagesSuppressed) out.images = msg.images.length
      return out
    })
    if (!this.pruneActive) return items
    return pruneToolResults(items, { keepRecent: PRUNE_KEEP_RECENT }).items
  }

  /**
   * 上下文压缩：把旧轮次替换为一条结构化摘要
   * （以 context/compaction 事件落盘，deriveMessages 自动应用；支持多级压缩）。
   *
   * 边界口径（复刻 DSH 的 `selectCompactableRange`）：
   *  - **按 token 预算保留近期尾部**（`COMPACT_RETAIN_RATIO` × 窗口），不再用"保留 N 轮"：
   *    重工具链路（一次 read_file 就是几万 token）用轮次口径压不动；
   *  - 切点回退到**工具配对平衡**的位置，绝不把 assistant 的 tool_calls 与它的 tool 结果拆开；
   *  - `COMPACT_KEEP_TURNS` 降级为安全阀（最近几轮即使预算允许也逐字保留）。
   *
   * 摘要由当前模型生成（一次无工具的独立会话，可在「设置 → 日志」审计）；
   * 摘要失败时退化为**无 LLM 的关键信息索引**，保证"绝不因超限中断"。
   */
  private async compact(kind: 'auto' | 'overflow-retry' | 'manual'): Promise<boolean> {
    if (this.compacting) return false
    this.compacting = true
    try {
      const entries = sessionLog.deriveEntries(this.id)
      // 摘要前先剪枝（对齐 DSH：摘要器读到的转录本身也更短）；幂等，已剪过的不会再变
      const items = pruneToolResults(this.toBudgetEntries(entries), { keepRecent: PRUNE_KEEP_RECENT }).items
      // 溢出恢复要更狠：服务端已经明确说"超窗"了，还按常规保留 16% 尾部多半压不够，
      // 只会把重试次数耗完（对齐 DSH 的 overflow 路径：绕过常规策略、一次削掉最大的平衡头部）。
      const aggressive = kind === 'overflow-retry'
      const schemaTokens = estimateToolSchemaTokens(this.visibleTools())
      // DSH 的保留预算口径：(`窗口 − 预留输出`) × retainRatio，工具 schema 不参与保留基准
      // （schema 只影响触发阈值里的余量计算；见 compactThresholdTokens）。
      const retainBaseTokens = compactionBasisTokens({
        limit: this.options.contextLimit,
        reserve: this.lastBudgetReserve,
      })
      // 压缩**前**的整次请求规模（历史 + 工具 schema）：与 tokensAfter 同口径，
      // 卡片上「压缩前 → 压缩后」必须比这两个，不能拿"被替换的那几条"去比整次请求。
      const requestTokensBefore = estimateMessagesTokens(items) + schemaTokens
      const pickPlan = (retainRatio: number, keepTurns: number) => pickCompactionRangeByTokens(items, {
        retainRatio,
        contextWindow: retainBaseTokens,
        keepTurns,
      })
      let plan = pickPlan(aggressive ? Math.min(COMPACT_RETAIN_RATIO, 0.05) : COMPACT_RETAIN_RATIO, aggressive ? 1 : COMPACT_KEEP_TURNS)
      if (!plan) {
        console.warn(`[agent-compact] ${this.id} 可压缩内容不足（不足 ${COMPACT_MIN_DROP} 条或轮次太少），跳过压缩`)
        return false
      }
      let droppedTokens = estimateMessagesTokens(items.slice(plan.startIndex, plan.endIndex))
      /**
       * 「压了但几乎没减」保护：上下文的大头可能是系统提示 / 工具 schema / 刚保留的近期尾部
       * （尤其是一条巨大的工具结果），常规 16% 口径只会丢掉几百 tokens，于是每一轮都触发一次
       * 摘要（还多花一次 LLM 请求），看起来就是"压缩没效果"。
       * 这种情况下改用更激进的口径再选一次（保留 5% + 只保最近 1 轮），确实能多压才采用。
       */
      const minGain = Math.max(512, Math.round(requestTokensBefore * 0.1))
      if (!aggressive && droppedTokens < minGain) {
        const fallbackPlan = pickPlan(Math.min(COMPACT_RETAIN_RATIO, 0.05), 1)
        if (fallbackPlan) {
          const fallbackTokens = estimateMessagesTokens(items.slice(fallbackPlan.startIndex, fallbackPlan.endIndex))
          if (fallbackTokens > droppedTokens) {
            console.info(`[agent-compact] ${this.id} 常规口径只能压缩 ${droppedTokens} tokens（请求约 ${requestTokensBefore}）→ 改用激进口径，预计压缩 ${fallbackTokens} tokens`)
            plan = fallbackPlan
            droppedTokens = fallbackTokens
          }
        }
      }
      // 界面提示：摘要要额外发一次无工具 LLM 请求，不给提示时这一步看起来像卡住
      this.emit('agent/compaction', { phase: 'start', kind })
      const dropped = entries.slice(plan.startIndex, plan.endIndex)
      const droppedItems = items.slice(plan.startIndex, plan.endIndex)
      const tokensBefore = droppedTokens
      const summary = (await this.summarize(buildCompactionPrompt(droppedItems), kind)) || indexSummary(droppedItems)
      const replacement: BudgetMessage = { role: 'user', content: renderCompactedCheckpoint(summary) }
      const tokensAfter = estimateMessagesTokens([replacement])
      // 硬校验：替换必须**确实更小**（复刻 DSH 的 "summary is not smaller than the shadowed content"）。
      // 没有这条，一旦摘要器返回比原文还长的文本，"压缩"反而会把上下文推得更高，
      // 下一次请求立刻又触发压缩，形成越压越大的死循环。
      if (tokensAfter >= tokensBefore) {
        console.warn(`[agent-compact] ${this.id} 摘要未变小（${tokensBefore} → ${tokensAfter} tokens），放弃本次压缩`)
        this.compactFailedAt = Date.now()
        this.emit('agent/compaction', { phase: 'end', kind, ok: false })
        return false
      }
      const fromSeq = dropped[0]?.seq ?? entries[plan.startIndex].seq
      const toSeq = dropped[dropped.length - 1]?.seq ?? fromSeq
      // 压缩**后**的请求历史规模：摘要 + 被保留的近期尾部 + 工具 schema（界面圆环用它立即更新，
      // 不必等下一次真实 usage；也不要用上面那个"仅摘要"的 tokensAfter，那会严重低估）
      const keptItems = items.slice(plan.endIndex)
      const postCompactionTokens = estimateMessagesTokens([replacement, ...keptItems])
        + estimateToolSchemaTokens(this.visibleTools())
      sessionLog.append(this.id, 'context/compaction', {
        fromSeq,
        toSeq,
        summary,
        tokensBefore,
        tokensAfter,
        requestTokensBefore,
        requestTokensAfter: postCompactionTokens,
        droppedMessages: dropped.length,
        kind,
        model: String((this.options.llmConfig?.model || this.options.config?.model || '') || '') || undefined,
      })
      console.info(`[agent-compact] ${this.id} 已压缩 ${dropped.length} 条消息（约 ${tokensBefore} tokens → 摘要 ${summary.length} 字符，请求约 ${requestTokensBefore} → ${postCompactionTokens} tokens，kind=${kind}）`)
      // 历史被重写：真实用量锚点与「本次请求估算」都失效（条目序号对不上），由下一次请求重新建立
      this.tokenAnchor = null
      this.lastRequestEntries = -1
      this.lastRequestEstimate = 0
      this.emit('agent/compaction', { phase: 'end', kind, ok: true, droppedMessages: dropped.length, tokensBefore, requestTokensBefore, tokensAfter: postCompactionTokens })
      return true
    } catch (e: any) {
      console.warn(`[agent-compact] ${this.id} 压缩失败（保持原历史）:`, e?.message || e)
      this.compactFailedAt = Date.now()
      this.emit('agent/compaction', { phase: 'end', kind, ok: false })
      return false
    } finally {
      this.compacting = false
    }
  }

  /** 生成压缩摘要（复用当前 provider / 模型；失败返回空串由调用方兜底） */
  private async summarize(prompt: string, kind: 'auto' | 'overflow-retry' | 'manual' = 'auto'): Promise<string> {
    try {
      // 摘要是一次独立 LLM 调用、可能要几十秒：把流式字数节流转成进度事件，
      // 卡片上就能显示「正在压缩上下文…（已生成 N 字）」，而不是只有一个转圈。
      let lastEmit = 0
      const text = await runLlmOnce({
        prompt,
        systemPrompt: COMPACT_SYSTEM_PROMPT,
        provider: this.options.provider,
        config: this.options.config,
        llmConfig: this.options.llmConfig,
        label: '上下文压缩',
        onAssistantDelta: (chars) => {
          const now = Date.now()
          if (now - lastEmit < 300) return
          lastEmit = now
          this.emit('agent/compaction', { phase: 'progress', kind, chars })
        },
      })
      return String(text || '').trim()
    } catch (e: any) {
      console.warn('[agent-compact] 摘要生成失败，改用无 LLM 兜底摘要:', e?.message || e)
      return ''
    }
  }

  /**
   * 本会话生效的工具定义（**未做 PTC 坍缩**）：scope 层 + 白名单解析 + 跨层插件工具解析。
   *
   * 为什么单独抽成公开方法：`agent:tools`（「设置 → 工具 → 注册表」里选一个运行中的会话）
   * 展示的正是这份清单，必须与下发给模型的那份**同源** —— 否则面板会显示一个模型根本拿不到的
   * 集合，或反过来漏掉插件工具（历史实现两样都犯过，见 `listAgentTools`）。
   */
  visibleToolDefs(): ToolDefinition[] {
    const defs = toolRegistry.list(this.options.scope)
    const whitelist = this.options.tools
    /**
     * ⚠️ 关键：白名单里的工具**未必在本会话 scope 的可见集里**。
     *
     * `list(scope)` 返回「全局层 + 该 scope 层」，而**插件工具注册在 `plugin:<插件 id>` 这一层**
     * （见 electron/main/plugin-tools.ts）。`get(name, scope)` 同样只有两跳（该 scope 层 → 全局层），
     * 也够不到插件层。结果是：用户在预设/工具管理里勾了插件工具，白名单里有名字，
     * 但**一个都进不了发给模型的工具清单**，调用也只会得到「未知工具」——
     * 表现就是"勾了却完全用不上"，而且从界面上完全看不出原因。
     *
     * 因此白名单存在时，按名字做一次**跨层解析**（`getAnywhere`：全局 → 各 scope 层）。
     * 只做解析、不放宽判权：能不能执行仍由本会话白名单（下面的引擎守卫）与插件宿主决定。
     * 解析不到的（拼错 / 插件已卸载）保持"不存在"，依旧 fail-loud。
     */
    let selected: ToolDefinition[]
    // 只有**显式数组**才算白名单；null / undefined 都表示"不限制"（与 run_subagent 的
    // `tools: null` 语义、以及这里历史上对 null 的处理保持一致）
    if (!Array.isArray(whitelist)) {
      selected = defs
    } else {
      const byName = new Map<string, ToolDefinition>()
      for (const name of whitelist) {
        const n = String(name)
        const found = toolRegistry.get(n, this.options.scope) || toolRegistry.getAnywhere(n)
        if (found) byName.set(n, found)
      }
      selected = Array.from(byName.values())
    }
    // 联网搜索：DeepSeek Responses API 已移除服务端 web_search（官方兼容表：内置工具一律忽略），
    // 因此不再为 deepseek-responses 隐藏本地 web_search / web_fetch —— 所有后端的联网搜索
    // 统一由本地工具层提供（能力插槽仍通过 tools 白名单生效）
    // run_code 是 PTC（Code Mode）专属呈现工具：仅在 toolsPresentation==='code' 时可见，
    // native 模式一律隐藏（fail-closed），避免 tools=null（全部工具）时泄漏到普通智能体
    return selected.filter((d) => d.name !== 'run_code')
  }

  /** 本 turn 模型实际可见的工具名（PTC 坍缩后只有 run_code） */
  private modelVisibleToolNames(): string[] {
    if (this.options.toolsPresentation === 'code') return ['run_code']
    const defs = this.frozenToolDefs ?? this.visibleToolDefs()
    return defs.map((d) => d.name)
  }

  /**
   * 修复「模型把工具调用写成 XML 正文」的情况：部分本地/网关模型不按 function calling
   * 返回结构化 tool_calls，而是在 content 里写 <tool_call><function=...>。若直接把它当
   * 最终回答，循环会因为「没有工具调用」而结束。这里只在没有任何结构化调用时尝试修复，
   * 且工具名必须是本 turn 冻结集合里的真实工具，避免把普通正文误判成调用。
   */
  private rescueTextToolCalls(result: { content: string; toolCalls?: any[]; finishReason?: string }): void {
    if (this.options.toolsPresentation === 'code') return
    if (result.finishReason === 'length') return
    if (Array.isArray(result.toolCalls) && result.toolCalls.length) return
    const repaired = repairTextToolCalls(result.content, this.modelVisibleToolNames())
    if (!repaired) return
    result.content = repaired.cleaned
    result.toolCalls = repaired.calls.map((c) => ({
      id: `call-${randomUUID()}`,
      type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    }))
    this.emit('agent/notice', {
      kind: 'tool-call-recovered',
      message: `模型把工具调用写成了 XML 文本，已自动修复并继续执行：${repaired.calls.map((c) => c.name).join('、')}`,
    })
  }

  /**
   * 把本 turn 的工具集变化写入会话日志（P2）。
   * 这不是模型消息，而是审计 / 回放事实：设置 → 智能体 → 日志里可直接看到
   * 「第 N 轮启用了哪些工具、相对上一轮加了/减了什么」，包括 PTC 坍缩为 run_code。
   */
  private logToolSetChange(turn: number): void {
    const tools = this.modelVisibleToolNames()
    const previous = this.lastToolSnapshot
    const added = previous ? tools.filter((n) => !previous.includes(n)) : tools.slice()
    const removed = previous ? previous.filter((n) => !tools.includes(n)) : []
    const changed = previous === null || added.length > 0 || removed.length > 0
    this.lastToolSnapshot = tools
    if (!changed) return
    sessionLog.append(this.id, 'tools/change', {
      tools,
      added,
      removed,
      turn,
      presentation: this.options.toolsPresentation === 'code' ? 'code' : 'native',
      reason: previous === null ? 'initial' : 'turn-start',
    })
  }

  /** 无 LLM 兜底摘要：保留「谁说了什么 + 工具调用与关键参数」的可操作索引 */
  private visibleTools(): any[] {
    // PTC（Code Mode）：能力目录（options.tools）不变，但模型可见的工具
    // schema 坍缩为单个 run_code——模型写程序用 ctx SDK 组合多步操作
    if (this.options.toolsPresentation === 'code') {
      return [runCodeFunctionSchema() as any]
    }
    // P2：使用本 turn 冻结的定义，而不是每次重新读实时注册表。
    const defs = this.frozenToolDefs ?? this.visibleToolDefs()
    return defs.map((d) => ({
      type: 'function',
      function: {
        name: d.name,
        description: d.description,
        parameters: d.inputSchema || { type: 'object', properties: {} },
      },
    }))
  }

  // ---------------- LLM step ----------------

  /**
   * 带「溢出自愈」的 step 执行：provider 报上下文超限时先压缩旧轮次再重放本 step
   * （最多 OVERFLOW_RETRY_LIMIT 次）。把原本的“直接中断”变成自愈；
   * 压缩不可行（可压缩内容不足 / 摘要失败）时抛回原错误，不掩盖真实原因。
   */
  private async runStepWithOverflowRetry(messages: any[]): Promise<{ content: string; toolCalls: any[]; reasoning?: string; usage?: AgentStepUsage; finishReason?: string }> {
    let current = messages
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.runStep(current)
      } catch (err: any) {
        const msg = err?.message || String(err)
        const status = Number(err?.status) || parseHttpStatus(msg)
        const explicitImageError = isImageUnsupportedError(msg, status)
        const hasImages = current.some((m) => Array.isArray(m?.images) && m.images.length > 0)
        // 有些后端（如 Ollama）只回「HTTP error! status: 400」，正文丢失：
        // 请求里确实带图 + 400 时也按「图片可能不被支持」去图重放一次（猜测，失败会撤销抑制）。
        const guessedImageError = !explicitImageError && hasImages && status === 400 && !isContextOverflowError(msg)
        // 图片自愈（先于溢出自愈）：服务端明确说「不支持图片」时，去掉本会话的图片重放一次。
        // 为什么要重放而不是直接结束：read_image / 截图是辅助手段，图片看不了不代表任务做不了；
        // 直接把 400 抛给 runTurn 会让整个 turn 中止（现象正是「不是多模态模型而中止」）。
        if (!this.imagesSuppressed && (explicitImageError || guessedImageError)) {
          const imageCount = current.reduce((n, m) => n + (Array.isArray(m?.images) ? m.images.length : 0), 0)
          this.imagesSuppressed = true
          this.imagesSuppressionGuessed = !explicitImageError
          const notice = explicitImageError
            ? `当前模型不支持图片输入（已省略 ${imageCount || '全部'} 张图片继续执行）。可改用 read_file / 文本工具，或让用户切换到支持视觉的模型。`
            : `含图片的请求被服务端拒绝（已省略 ${imageCount || '全部'} 张图片重试一次）。若仍失败，请检查模型/接口配置。`
          console.warn(`[agent] ${this.id} 图片请求被拒（${msg.slice(0, 200)}）→ 去图重放本 step`)
          sessionLog.append(this.id, 'llm/retry', {
            attempt: attempt + 1,
            code: 'image_unsupported',
            delayMs: 0,
            provider: this.options.provider,
            error: msg.slice(0, 500),
          })
          try { this.emit('agent/notice', { kind: 'image-unsupported', message: notice }) } catch { /* 事件失败不影响重放 */ }
          // 请求投影层已经按 imagesSuppressed 去图并补了说明；这里只需重新派生历史
          current = this.toRequestMessages(sessionLog.deriveEntries(this.id))
          continue
        }
        // 「猜测式去图」重放后仍然失败，且错误仍与图片无关 → 撤销抑制，别让本会话以后都看不到图
        if (this.imagesSuppressed && this.imagesSuppressionGuessed && !explicitImageError) {
          this.imagesSuppressed = false
          this.imagesSuppressionGuessed = false
        }
        if (attempt >= OVERFLOW_RETRY_LIMIT || !isContextOverflowError(msg)) throw err
        console.warn(`[agent-compact] ${this.id} 上下文超限（第 ${attempt + 1} 次）→ 压缩后重放本 step：${msg}`)
        const ok = await this.compact('overflow-retry')
        if (!ok) throw err
        // 输入已落盘，压缩后重新派生历史即可重放
        current = this.toRequestMessages(sessionLog.deriveEntries(this.id))
      }
    }
  }

  /**
   * runStep 外层：对远程自托管后端做在途并发限流——
   * 多个 agent（批量多线程）同时压向同一远端 LM Studio 时排队请求，避免空回/500。
   */
  private async runStep(messages: any[]): Promise<{ content: string; toolCalls: any[]; reasoning?: string; usage?: AgentStepUsage; finishReason?: string }> {
    const provider = this.options.provider
    const cfg: any = this.options.config || {}
    // 自托管后端取实际服务地址（lmstudio/openai/... 用 base_url；ollama 用 model_url；custom 用 api_url/base_url）
    const inflightUrl =
      provider === 'ollama' ? (cfg.model_url || '')
      : provider === 'custom' ? (cfg.api_url || cfg.base_url || '')
      : (cfg.base_url || '')
    const limit = SELFHOSTED_PROVIDERS.has(provider) && !isLocalEndpoint(inflightUrl)
    const release = limit ? await acquireBackendLease(backendKey(provider, inflightUrl)) : null
    try {
      return await this.runStepInner(messages)
    } finally {
      release?.()
    }
  }

  private async runStepInner(messages: any[]): Promise<{ content: string; toolCalls: any[]; reasoning?: string; usage?: AgentStepUsage; finishReason?: string }> {
    const { provider, config } = this.options
    // Agent/批量工具循环强制关闭深度思考：thinking 模式下（尤其 GPUStack 畸形输出：缺 <think> 开标签、
    // 思考以正文流出）会把思考内容混入/挤掉正文，导致最终无正文结果。home 单轮问答仍由全局推理强度控制。
    const llmConfig = { ...(this.options.llmConfig || {}), think: 'none' }
    const signal = this.turnController?.signal
    const tools = this.visibleTools()
    let stepUsage: AgentStepUsage | undefined

    // 凭据接缝（路线图 2.3）：配置可只存 apiKeyRef（引用名），请求前由主进程
    // 从受保护的 credentials.json 解析明文；内联 api_key 保持向后兼容。
    const resolvedConfig = this.resolveConfigWithCredential(config)

    // 瞬态错误自动重试（429 限流 / 5xx / 超时 / 网络抖动 / 空流）：仅当失败前未产出任何
    // 内容时重试，避免把已写入会话日志的部分 chunk 重复进模型历史（"模型可见即已记录"）。
    // 分类与退避在 @/shared/llmRetry（纯函数），429 会尊重 provider 的 Retry-After。
    const MAX_LLM_RETRY = 5

    for (let attempt = 0; attempt < MAX_LLM_RETRY; attempt++) {
      // 每次尝试重置累积器（重试时不并入上一次残留内容）
      let content = ''
      // 上一次尝试的流式日志缓冲不能带进重试（否则日志里会出现"旧半截+新正文"的合并块）
      this.chunkBuffer = ''
      this.chunkBufferStartedAt = 0
      let toolCalls: any[] = []
      let reasoning: string | undefined
      // 结束原因（finish_reason）：length = 被 max_tokens / 模型上下文截断（“没推理完就结束”的典型原因）
      let finishReason = ''

      const callbacks: any = {
        signal,
        tools,
        toolChoice: 'auto',
        onStream: (chunk: string) => {
          content += chunk
          this.queueAssistantChunk(chunk)
          this.emit('assistant/chunk', { content: chunk })
          // 旁路请求（上下文压缩摘要）：把已生成字数报给调用方，界面据此显示「已生成 N 字」
          if (this.options.onAssistantDelta) {
            try { this.options.onAssistantDelta(content.length) } catch { /* 回调异常不影响流 */ }
          }
        },
        onReasoning: (text: string) => {
          reasoning = text
          logInfo('agent-reasoning', `id=${this.id} chars=${text.length}`)
          // 思维链流式：把全量累积文本广播给渲染进程（前端按 step 时间线插入思考单元）
          this.emit('assistant/reasoning', { text })
        },
        onToolCalls: (calls: any[]) => {
          toolCalls = calls || []
        },
        // 工具参数流式增量（function calling）：write_file 等长内容工具在模型生成参数期间
        // 实时透传渲染进程，前端立即显示 tool-box + 流式代码内容（不再等整段参数生成完）。
        // 同时在本进程累积原文：部分本地网关最终 tool_calls 会丢参/截断，用它兜底。
        onToolCallArgs: (callId: string, name: string, argsFragment: string) => {
          const id = String(callId || '')
          if (id) {
            const prev = this.streamedArgs.get(id) || ''
            const frag = String(argsFragment || '')
            // 与渲染层同一语义：新串是旧串的前缀扩展 → 覆盖（全量快照），否则拼接（增量片段）
            this.streamedArgs.set(id, frag.length > prev.length && frag.startsWith(prev) ? frag : prev + frag)
          }
          this.emit('agent/tool-args', { callId, name, argsFragment })
        },
        // 服务端联网搜索状态（deepseek-responses web_search_call）：透传给渲染进程展示
        // 「正在联网搜索…/搜到 N 条结果 + 来源链接」，与普通聊天的 message.webSearch 一致
        onSearchStatus: (info: any) => {
          sessionLog.append(this.id, 'assistant/search-status', {
            status: info?.status || '',
            query: info?.query,
            results: Array.isArray(info?.results) ? info.results : undefined,
            action: info?.action,
          })
          this.emit('agent/search-status', {
            status: info?.status || '',
            query: info?.query,
            results: Array.isArray(info?.results) ? info.results : undefined,
            action: info?.action,
          })
        },
        onComplete: (c: string, metadata?: any) => {
          if (c !== undefined && c !== null) content = c
          if (metadata) {
            if (metadata.finish_reason) finishReason = String(metadata.finish_reason)
            const pt = metadata?.prompt_tokens ?? metadata?.promptTokens
            const ct = metadata?.completion_tokens ?? metadata?.completionTokens
            if (typeof pt === 'number' || typeof ct === 'number') {
              stepUsage = {
                promptTokens: typeof pt === 'number' ? pt : 0,
                completionTokens: typeof ct === 'number' ? ct : 0,
                totalTokens: metadata?.total_tokens ?? metadata?.totalTokens ?? ((typeof pt === 'number' ? pt : 0) + (typeof ct === 'number' ? ct : 0)),
              }
              // 缓存命中（DeepSeek / OpenAI / Anthropic 的 usage 字段各异，ai-core 已归一）
              const cached = metadata?.cached_tokens ?? metadata?.cachedTokens
              if (typeof cached === 'number') {
                stepUsage.cachedTokens = cached
                stepUsage.cacheReported = metadata?.cache_reported === true || metadata?.cacheReported === true
              }
            }
            // 用量账本（只记后续）：智能体/集群/插件 agent 的每一步都记一行。
            // 重试时 StepUsage 会被下一次覆盖，但账本按「真发生过的请求」逐条记账，
            // 这正是它比聊天存档里的累计值更准的原因。
            recordUsage({
              provider: String(provider || ''),
              sourceId: provider === 'custom'
                ? (resolvedConfig?.id ?? config?.id ?? null)
                : undefined,
              model: String(resolvedConfig?.model || config?.model || llmConfig?.model || ''),
              prompt: pt,
              completion: ct,
            })
          }
        },
      }

      let p: Promise<any>
      switch (provider) {
        case 'ollama':
          p = AIUtils.sendToOllama(resolvedConfig, llmConfig, messages, callbacks)
          break
        case 'lmstudio':
          p = AIUtils.sendToLMStudio(resolvedConfig, llmConfig, messages, callbacks)
          break
        case 'openai':
        case 'custom': {
          const body: any = AIUtils.buildOpenAIRequest(resolvedConfig, llmConfig, messages)
          if (tools.length) {
            body.tools = tools
            body.tool_choice = 'auto'
          }
          // custom 配置用 api_url（完整聊天端点，如 GPUStack / 各类 OpenAI 兼容网关）；
          // openai 用 base_url + /chat/completions
          const endpoint = resolvedConfig?.api_url
            ? AIUtils.buildCustomChatEndpoint(resolvedConfig.api_url)
            : `${stripTrailing(resolvedConfig?.base_url)}/chat/completions`
          p = AIUtils.makeAPIRequest(
            endpoint,
            body,
            authHeaders(resolvedConfig?.api_key),
            callbacks,
          )
          break
        }
        // DeepSeek 单来源：接口样式决定用 Chat Completions 还是 Responses API
        // （'deepseek-responses' 为已合并的历史别名，仅作兜底）
        case 'deepseek-responses':
        case 'deepseek': {
          const isResponsesStyle = provider === 'deepseek-responses' || resolvedConfig?.api_style === 'responses'
          if (isResponsesStyle) {
            const body: any = AIUtils.buildDeepSeekResponsesRequest(resolvedConfig, llmConfig, messages, {
              tools,
              toolChoice: 'auto',
            })
            p = AIUtils.makeDeepSeekResponsesRequest(
              `${stripTrailing(resolvedConfig?.base_url)}/responses`,
              body,
              authHeaders(resolvedConfig?.api_key),
              callbacks,
            )
          } else {
            const body: any = AIUtils.buildOpenAIRequest(resolvedConfig, llmConfig, messages)
            if (tools.length) {
              body.tools = tools
              body.tool_choice = 'auto'
            }
            p = AIUtils.makeAPIRequest(
              `${stripTrailing(resolvedConfig?.base_url)}/chat/completions`,
              body,
              authHeaders(resolvedConfig?.api_key),
              callbacks,
            )
          }
          break
        }
        case 'azure': {
          const body: any = AIUtils.buildOpenAIRequest(resolvedConfig, llmConfig, messages)
          if (tools.length) {
            body.tools = tools
            body.tool_choice = 'auto'
          }
          const ep = `${stripTrailing(resolvedConfig?.endpoint)}/openai/deployments/${resolvedConfig?.deployment}/chat/completions?api-version=${resolvedConfig?.api_version || '2024-02-15-preview'}`
          p = AIUtils.makeAPIRequest(ep, body, authHeaders(resolvedConfig?.api_key), callbacks)
          break
        }
        case 'gpustack': {
          // GPUStack：OpenAI 兼容端点（裸地址自动补 /v1-openai/chat/completions）
          const body: any = AIUtils.buildOpenAIRequest(resolvedConfig, llmConfig, messages)
          if (tools.length) {
            body.tools = tools
            body.tool_choice = 'auto'
          }
          const endpoint = AIUtils.buildCustomChatEndpoint(resolvedConfig?.base_url || resolvedConfig?.api_url || '')
          p = AIUtils.makeAPIRequest(endpoint, body, authHeaders(resolvedConfig?.api_key), callbacks)
          break
        }
        default:
          throw new Error(`agent 循环暂不支持的 provider: ${provider}`)
      }

      try {
        await p
        // 空流重试：200 但整轮未产出任何内容/工具/推理——远程自托管服务在高并发下可能被
        // 静默丢弃直接返回空流；云端偶发也会这样。空响应没有计费/副作用风险，所有 provider 都可重试。
        if (!content && toolCalls.length === 0 && !reasoning && attempt < MAX_LLM_RETRY - 1) {
          const failure = classifyLlmFailure({ message: 'empty response', name: 'EmptyResponse' })
          const delay = effectiveRetryDelayMs(attempt, failure, { baseMs: 500, maxMs: 10_000 })
          sessionLog.append(this.id, 'llm/retry', {
            attempt: attempt + 1,
            code: 'empty_response',
            delayMs: delay,
            provider,
            error: '模型返回空流 / 空响应',
          })
          console.warn(`[agent] LLM 返回空流（${provider}，第 ${attempt + 1} 次，tools=${tools.length}），${delay}ms 后重试`)
          await new Promise((r) => setTimeout(r, delay))
          continue
        }
        // 诊断：每次 LLM 步骤结果摘要（便于定位“模型返回为空”是空流 / 只有工具 / 解析丢失）
        console.info(`[agent-result] ${this.id} provider=${provider} tools=${tools.length} attempt=${attempt} content=${(content || '').length} toolCalls=${toolCalls.length} reasoning=${(reasoning || '').length} finish=${finishReason || '-'} usage=${stepUsage ? (stepUsage.totalTokens ?? (stepUsage.promptTokens + stepUsage.completionTokens)) : '-'}`)
        if (finishReason === 'length') {
          // 被 max_tokens / 模型上下文截断：正文可能为空或不完整，明确告警而不是静默当作正常完成
          console.warn(`[agent] LLM 输出被截断（finish_reason=length，provider=${provider}，正文 ${(content || '').length} 字符）：请增大 max_tokens，或在本地推理服务中提高模型加载的上下文长度`)
        }
        return { content, toolCalls, reasoning, usage: stepUsage, finishReason }
      } catch (err: any) {
        const msg = err?.message || String(err)
        // 仅当失败前未产出任何内容（内容/工具/推理均为空）时重试——
        // 已产出内容说明已写入会话日志，重试会导致模型历史重复
        const clean = content === '' && toolCalls.length === 0 && !reasoning
        const failure = classifyLlmFailure({
          message: msg,
          status: Number(err?.status) || undefined,
          retryAfter: err?.retryAfter,
          name: String(err?.name || ''),
        })
        if (attempt < MAX_LLM_RETRY - 1 && failure.retryable && clean) {
          const delay = effectiveRetryDelayMs(attempt, failure, { baseMs: 500, maxMs: 10_000 })
          sessionLog.append(this.id, 'llm/retry', {
            attempt: attempt + 1,
            code: failure.code,
            delayMs: delay,
            provider,
            error: msg.slice(0, 500),
          })
          console.warn(`[agent] LLM 请求失败（第 ${attempt + 1} 次，${failure.code}），${delay}ms 后重试: ${msg}`)
          await new Promise((r) => setTimeout(r, delay))
          continue
        }
        // 已经流出一部分正文后失败/取消：把已交付内容收尾成 assistant/message。
        // 否则用户看到了半截回答，下一轮模型却完全不知道它说过什么（DSH 的取消语义）。
        if ((content || reasoning) && !isContextOverflowError(msg)) {
          this.flushAssistantChunks()
          sessionLog.append(this.id, 'assistant/message', { content, reasoning })
          this.lastAssistantContent = content
          this.emit('assistant/message', { content, toolCalls: [] })
        }
        throw err
      }
    }
    // 不可达（循环内必然 return 或 throw）
    throw new Error('LLM 请求失败')
  }

  // ---------------- 工具执行 ----------------

  /**
   * 拒绝一次工具调用（参数无法解析 / 输出被截断 / 其它"没有真正执行"的失败）：
   * 落 `tool/call`（无 args）+ `tool/result` 诊断，让模型和 UI 都看到这次调用**未执行**。
   *
   * 为什么集中收口：调用没执行时也必须成对写 call/result，否则会话日志会把它当成
   * "工具结果缺失"，下一轮模型会误以为工具跑过 / 需要重跑。
   */
  private rejectToolCall(
    callId: string,
    name: string,
    error: string,
    step: number,
    argsRawLen?: number,
    code = 'TRUNCATED_ARGS',
  ): void {
    const callSeq = sessionLog.append(this.id, 'tool/call', {
      callId,
      name,
      args: undefined,
      ...(argsRawLen !== undefined ? { argsRawLen } : {}),
      step,
    }).seq
    this.currentCallSeq.set(callId, callSeq)
    this.emit('tool/call', { callId, name, args: undefined, argsParseFailed: true })
    this.pushToolResult({ callId, name, ok: false, error, diagnostic: true, code })
  }

  /** 输出被 max_tokens 截断、整步工具调用不派发时的模型侧说明 */
  private truncatedToolCallError(name: string, rawLen: number, giveUp: boolean): string {
    const head = giveUp
      ? `本步输出被截断（finish_reason=length），且已连续 ${MAX_TRUNCATED_TOOL_SKIPS} 次因截断跳过工具调用：本次调用未执行。`
      : '本步输出被截断（finish_reason=length，max_tokens / 上下文长度不够），工具参数 JSON 不完整：本次调用未执行。'
    const advice = name === 'write_file'
      ? '如果 content 很大，请分段写入：先写文件骨架，再用 replace_in_file 逐段追加（不要一次提交整份大文件）。'
      : name === 'run_code'
        ? '请把程序拆成多次调用、每次只做少量步骤后重试。'
        : '请缩短单次提交的内容，拆成多次调用后重试。'
    return `${head}${rawLen ? `（收到 ${rawLen} 字符）` : ''}${advice}`
      + (giveUp ? '若反复出现，请调高 max_tokens 或改用输出上限更大的模型。' : '')
  }

  /**
   * 循环卫生：连续相同工具 + 相同参数时，在下一步注入一条提醒（不阻断、不改结果）。
   * 阈值对齐 DSH 的 3/5/8；轮询类工具排除，避免正常的 job_output 等待被误判。
   */
  private noteToolRepeat(name: string, args: any): void {
    if (!name || REPEAT_TRACK_EXCLUDE.has(name)) return
    const key = `${name}:${canonicalToolArgs(args)}`
    if (key === this.repeatKey) this.repeatCount++
    else {
      this.repeatKey = key
      this.repeatCount = 1
    }
    if (this.repeatCount !== 3 && this.repeatCount !== 5 && this.repeatCount !== 8) return
    const preview = key.length > 360 ? key.slice(0, 360) + '…' : key
    const text = this.repeatCount === 3
      ? `[循环提醒] 你正在用完全相同的参数重复调用工具 \`${name}\`。请先检查上一条工具结果，再决定是否换参数/换方法，不要原地打转。`
      : this.repeatCount === 5
        ? `[循环提醒] 已连续 5 次用相同参数调用 \`${name}\`，没有产生新进展。请换一个方法、换参数，或直接向用户说明卡点。\n参数：${preview}`
        : `[循环提醒] 已连续 8 次重复调用 \`${name}\`。继续重复不会产生新信息；请停止重复，总结当前证据与阻塞点，必要时询问用户。`
    this.inject(text)
  }

  /** 一次工具调用的执行结果（尚未落日志；由 pushToolOutcome 按模型顺序提交） */
  private async runToolCall(call: any, step: number): Promise<{
    callId: string
    name: string
    result: ToolResult
    diagnostic?: boolean
  }> {
    const callId = String(call?.id || `call-${step}-${Math.random().toString(36).slice(2, 8)}`)
    const rawArgs = call?.arguments ?? call?.function?.arguments
    let args = parseToolArgs(rawArgs)
    let name = String(call?.name || call?.function?.name || '')
    // 有的 provider 会把 XML 形态的参数原文塞进 arguments：能从 <parameter=...> 里
    // 提出真实参数时直接修复，不要因为 JSON 不合法就拒绝整个调用。
    if (args && typeof args === 'object' && typeof args._raw === 'string') {
      const xmlArgs = parseXmlToolArgs(String(args._raw), name)
      if (xmlArgs) {
        args = xmlArgs
        this.emit('agent/notice', {
          kind: 'tool-call-recovered',
          message: `工具 ${name} 的参数是 XML 文本，已自动提取参数并继续执行`,
        })
      }
    }
    // 模型直接点名 MCP 工具（如 Office 的 open_document）而不是 mcp_call 时：
    // 只要该工具在唯一已连接服务里，就自动改写成 mcp_call({serverId, tool, args})。
    // 这样不会因为“open_document 不在本 turn 冻结集合”被拒绝，也符合 mcp_call 的统一入口。
    const directMcpFrozenNames = this.frozenToolDefs?.map((d) => String(d.name))
    if (name !== 'mcp_call' && directMcpFrozenNames && !directMcpFrozenNames.includes(name)) {
      const hits = mcpService.findServersByTool(name)
      if (hits.length === 1) {
        if (!directMcpFrozenNames.includes('mcp_call')) {
          return {
            callId,
            name: 'mcp_call',
            diagnostic: true,
            result: {
              ok: false,
              error: `检测到 MCP 工具 ${name}，但本会话没有启用 mcp_call。请在「设置 → 工具 → 管理」启用 mcp_call 后重试。`,
              code: 'DENIED',
            },
          }
        }
        args = { serverId: hits[0].serverId, tool: name, args: args && typeof args === 'object' ? args : {} }
        this.emit('agent/notice', {
          kind: 'tool-call-recovered',
          message: `模型直接调用了 MCP 工具 ${name}，已自动转成 mcp_call（serverId=${hits[0].serverId}）`,
        })
        name = 'mcp_call'
      }
    }

    // 参数解析失败（normalizeToolCalls 已把畸形/截断的原文放进 `_raw`）：
    // 不再用空参数去执行工具——那会得到 "code 参数必填" 这类误导性报错（模型看不出参数是它自己
    // 输出被截断造成的，会反复重试同样的调用）。这里直接给出可诊断的失败说明。
    if (args && typeof args === 'object' && typeof args._raw === 'string') {
      const rawText = String(args._raw)
      // 预览模式下 `_raw` 只有头尾两段，真实长度与"是否被裁过"由这两个字段给出
      const rawLen = Number(args._rawLength) > 0 ? Number(args._rawLength) : rawText.length
      const omitted = args._rawOmitted === true
      const head = rawText.slice(0, 160)
      const tail = rawText.length > 320 ? rawText.slice(-160) : ''
      const incomplete = omitted || looksIncompleteJson(rawText)
      const truncatedByLength = this.lastFinishReason === 'length'
      const truncHint = truncatedByLength
        ? '本步输出被截断（finish_reason=length，max_tokens / 上下文长度不够）'
        : incomplete
          ? '参数 JSON 不完整（本步输出很可能在生成途中被截断：常见于单次内容太长、撞到 max_tokens 或网关输出上限）'
          : '参数 JSON 不合法（字符串内的换行 / 引号未正确转义）'
      const error = `工具参数无法解析（${truncHint}，收到 ${rawLen} 字符）：`
        + `原文开头「${head}」${tail ? `…结尾「${tail}」` : ''}${omitted ? '（中间部分已省略）' : ''}。`
        + '本次调用未执行（没有写入任何文件）。请缩短一次提交的内容后重试：大文件分段写入——先写骨架，再用 replace_in_file 在末尾逐段追加'
        + '（例如一次 run_code 只做少量步骤）；并确保 JSON 字符串内的换行/引号已正确转义。'
        + '若反复出现，请调高 max_tokens 或改用输出上限更大的模型。'
      const callSeq = sessionLog.append(this.id, 'tool/call', {
        callId,
        name,
        args: undefined,
        argsRawLen: rawLen,
        step,
      }).seq
      this.currentCallSeq.set(callId, callSeq)
      this.emit('tool/call', { callId, name, args: undefined, argsParseFailed: true })
      return {
        callId,
        name,
        diagnostic: true,
        // 稳定错误码：截断类（finish=length / JSON 明显没写完）与"真畸形 JSON"要能分开，
        // 前端据此给"调高 max_tokens"的提示（对齐 DSH 的 FS_* 错误码思路）
        result: { ok: false, error, code: truncatedByLength || incomplete ? 'TRUNCATED_ARGS' : 'INVALID_ARGS' },
      }
    }

    const callSeq = sessionLog.append(this.id, 'tool/call', { callId, name, args, step }).seq
    this.currentCallSeq.set(callId, callSeq)
    this.emit('tool/call', { callId, name, args })
    this.noteToolRepeat(name, args)

    // 引擎级白名单守卫：即使模型试图调用未启用工具，也直接返回失败而不是执行。
    // P2：本 turn 已冻结工具集时，以冻结集合为准（运行中新注册的工具本 turn 不可见，
    // 也不能通过幻觉名字绕过）。
    const frozenNames = this.frozenToolDefs?.map((d) => String(d.name))
    if (frozenNames && name !== 'run_code' && !frozenNames.includes(name)) {
      return {
        callId,
        name,
        diagnostic: true,
        result: { ok: false, error: `工具 ${name} 不在本 turn 冻结的工具集中（下个 turn 生效）`, code: 'DENIED' },
      }
    }
    const toolWhitelist = this.options.tools
    if (toolWhitelist !== null && Array.isArray(toolWhitelist) && !toolWhitelist.includes(name as any)) {
      return {
        callId,
        name,
        diagnostic: true,
        result: { ok: false, error: `工具 ${name} 未启用（不在当前工具白名单中）`, code: 'DENIED' },
      }
    }

    // PTC（Code Mode）呈现坍缩守卫：坍缩后模型可见的只有 run_code，
    // 直接点名其它工具（幻觉 / 从技能文档或历史里知道的名字）一律拒绝并指出正确写法。
    // 程序内的子调用走 SDK → toolRegistry.execute，不经过本函数，因此天然豁免
    // （对齐 DSH：model-direct 调用只能点名 run_code，子调用 bypass collapse）。
    if (this.options.toolsPresentation === 'code' && name !== 'run_code') {
      const error = `PTC（代码模式）下不能直接调用 ${name}：请把该调用写进 run_code 程序的 tools 里`
        + `（程序内 await tools.${name}({ ... })）`
      return {
        callId,
        name,
        diagnostic: true,
        result: { ok: false, error, code: 'DENIED' },
      }
    }
    // 反向守卫：native 模式没有 run_code 这个模型可见工具（visibleToolDefs 已滤掉），
    // 模型若凭历史 / 文档幻觉出该名字，直接拒绝，避免绕过能力目录直接执行代码。
    if (this.options.toolsPresentation !== 'code' && name === 'run_code') {
      return {
        callId,
        name,
        diagnostic: true,
        result: { ok: false, error: 'run_code 只在 PTC（代码模式）下可用；请按当前工具列表逐项调用', code: 'DENIED' },
      }
    }

    // 引擎级防死循环：同一技能重复加载 → 直接返回"继续执行"提示，不再执行加载
    let result: ToolResult
    if (name === 'skill') {
      const skillName = String(args?.name ?? '').trim()
      // 禁用技能：拒绝加载（技能管理开关关闭的）
      const disabledSkills = this.options.disabledSkills || []
      if (skillName && disabledSkills.includes(skillName)) {
        result = {
          ok: false,
          error: `技能「${skillName}」已禁用，禁止加载（可在技能管理中启用）`,
        }
      } else if (skillName && this.loadedSkills.has(skillName)) {
        result = {
          ok: true,
          value: `技能「${skillName}」已在之前的步骤中加载过。请立即按已获得的技能指令继续执行任务（生成代码用 run_code 执行），不要再次调用 skill 工具。`,
        }
      } else {
        result = await toolRegistry.execute(name, args, this.ctx())
        // 只有加载成功才记入「已加载」：失败（技能名不存在等）不能占用这个名字，
        // 否则模型按报错改正名字后重试时会被误判为「已加载过」而拿不到技能指令。
        if (skillName && result.ok) this.loadedSkills.add(skillName)
      }
    } else {
      try {
        result = await toolRegistry.execute(name, args, this.ctx())
      } catch (e: any) {
        // 注册表内部理论上已收口；这里再兜一层，保证 pre/post 钩子或注册表自身的异常
        // 不会冒泡成 turn 级错误。
        result = {
          ok: false,
          error: `工具 ${name} 执行异常：${e?.message || String(e)}`,
          code: 'TOOL_ERROR',
          retryable: false,
        }
      }
    }

    return { callId, name, result }
  }

  /** 把一次工具结果按模型给出的调用顺序提交（日志 / UI / 崩溃恢复记账的唯一入口） */
  private pushToolOutcome(outcome: { callId: string; name: string; result: ToolResult; diagnostic?: boolean }): void {
    const { callId, name, result, diagnostic } = outcome
    try {
      this.pushToolResult({
        callId,
        name,
        ok: result.ok,
        value: result.value,
        error: result.error,
        code: result.code,
        retryable: result.retryable,
        preview: result.preview,
        images: result.images,
        diagnostic,
      })
    } catch (e: any) {
      // 结果记账 / 序列化 / 落盘任何一步出错，都不能把 turn 打断：补一条最短的失败结果，
      // 保证 assistant.tool_calls 有对应的 tool 消息（否则下一轮模型会看到「结果缺失」）。
      const message = `工具 ${name || '(unknown)'} 的结果处理失败：${e?.message || String(e)}`
      console.error(`[agent] ${this.id} ${message}`)
      try {
        sessionLog.append(this.id, 'tool/result', {
          callId,
          name,
          ok: false,
          error: message,
          code: 'TOOL_RESULT_ERROR',
        })
      } catch { /* 日志也失败时只能放弃这一条，但仍然不能让 turn 停止 */ }
      try { this.emit('tool/result', { callId, name, ok: false, error: message }) } catch { /* 忽略 */ }
    }
  }

  /** 单个 shell 路径（保留给截断拒绝等同步收口；正常调度走 executeToolCalls） */
  private async executeToolCall(call: any, step: number): Promise<void> {
    try {
      this.pushToolOutcome(await this.runToolCall(call, step))
    } catch (e: any) {
      // 非并行路径也必须兜底：任何工具/记账异常都只能变成「本次调用失败」，
      // 不能冒泡到 runTurn 的 catch 把整个 turn 结束。
      const name = String(call?.name || call?.function?.name || '')
      this.pushToolOutcome({
        callId: String(call?.id || `call-${step}-error`),
        name,
        diagnostic: true,
        result: { ok: false, error: `工具 ${name || '(unknown)'} 执行异常：${e?.message || String(e)}`, code: 'TOOL_ERROR' },
      })
    }
  }

  /**
   * 工具调度：连续只读调用进有界并行池，独占调用是 barrier；
   * 结果严格按模型给出的顺序提交，保证 assistant.tool_calls 与 tool 消息配对。
   */
  private async executeToolCalls(calls: any[], step: number): Promise<void> {
    let i = 0
    while (i < calls.length) {
      const name = String(calls[i]?.name || calls[i]?.function?.name || '')
      if (!PARALLEL_SAFE_TOOLS.has(name)) {
        await this.executeToolCall(calls[i], step)
        i++
        continue
      }
      // 收集连续的只读调用，成一个并行组
      const group: any[] = []
      while (i < calls.length) {
        const n = String(calls[i]?.name || calls[i]?.function?.name || '')
        if (!PARALLEL_SAFE_TOOLS.has(n)) break
        group.push(calls[i])
        i++
      }
      const outcomes = new Array<{ callId: string; name: string; result: ToolResult; diagnostic?: boolean }>(group.length)
      let next = 0
      const worker = async (): Promise<void> => {
        while (true) {
          const idx = next++
          if (idx >= group.length) return
          try {
            outcomes[idx] = await this.runToolCall(group[idx], step)
          } catch (e: any) {
            outcomes[idx] = {
              callId: String(group[idx]?.id || `call-${step}-${idx}`),
              name: String(group[idx]?.name || group[idx]?.function?.name || ''),
              result: { ok: false, error: e?.message || String(e), code: 'TOOL_ERROR' },
              diagnostic: true,
            }
          }
        }
      }
      const workers = Array.from({ length: Math.min(MAX_PARALLEL_TOOL_CALLS, group.length) }, worker)
      await Promise.all(workers)
      // 严格按模型顺序提交，避免工具结果乱序导致下一轮历史错位
      for (const out of outcomes) if (out) this.pushToolOutcome(out)
    }
  }

  /**
   * 工具结果的**唯一收口**：有界化 →（必要时）落盘 → 落日志 + 广播事件。
   *
   * 复刻 DSH 的两层：`tool-result-pruner`（掐中段）+ `spill-policy`（超大结果落盘）。
   * - `value` 仍是**原文**（会话日志是唯一事实源，UI / 审计 / 回放都读它）；
   * - `modelValue` 是**模型可见的那一份**：
   *     · 超过 16K 码点 → 掐中段（head + tail + 标记 + 续读提示）；
   *     · 超过 200K 码点 → 完整原文写盘，模型只看头尾预览 + 落盘路径（可 read_file 回读）。
   *   `deriveEntries` 优先用 modelValue，因此只影响模型上下文，不动落盘原文。
   *
   * @param result.diagnostic 引擎自己构造的短诊断（参数解析失败 / 白名单拦截 / PTC 拒绝）：
   *   这类消息没有续读锚点，不套用工具专属提示（否则会指着一个不存在的 nextOffset）。
   */
  private pushToolResult(result: {
    callId: string
    name: string
    ok: boolean
    value?: any
    error?: string
    code?: string
    retryable?: boolean
    preview?: any
    images?: ToolImage[]
    diagnostic?: boolean
  }): void {
    const { callId, name, ok, value, error, preview, diagnostic, code, retryable } = result
    // 图片落盘（会话日志只存路径）；最多 4 张，避免一次工具调用把上下文撑爆
    const savedImages = (result.images || [])
      .slice(0, 4)
      .map((img) => saveToolImage(this.id, img))
      .filter((x): x is SavedToolImage => !!x)
    // 按**本会话窗口**缩放工具结果预算（小窗口的关键）：32K 下单条结果最多约 12% 窗口，
    // 而不是固定 16K 字符（那会占到 1/3 窗口）。取值来自本轮请求预算的生效窗口。
    // 取本轮请求预算的生效窗口；首步（预算尚未算过）回落到 options.contextLimit
    const windowTokens = this.effectiveWindowTokens > 0 ? this.effectiveWindowTokens : Number(this.options.contextLimit) || undefined
    // 工具返回值可能包含循环引用 / BigInt / 函数（插件工具尤其常见）：boundToolResult 内部会
    // JSON.stringify，一旦抛错就会冒泡到 runTurn、把整个 turn 结束。这里兜底成可序列化文本。
    let logValue: any = value
    let bounded: ReturnType<typeof boundToolResult>
    try {
      bounded = boundToolResult(name, ok, value, error, undefined, {
        skipContinuationHint: !!diagnostic,
        windowTokens,
      })
    } catch (e: any) {
      logValue = safeToolValueText(value)
      const modelText = logValue.length > 16_384 ? logValue.slice(0, 16_384) + '\n\n[... result truncated ...]' : logValue
      bounded = {
        raw: logValue,
        model: modelText,
        pruned: modelText.length !== logValue.length,
        originalChars: logValue.length,
      }
      console.warn(`[agent] ${this.id} 工具 ${name} 的结果无法正常序列化，已转为文本继续：${e?.message || String(e)}`)
    }
    let modelValue = bounded.model
    let spillPath: string | undefined
    if (bounded.pruned && shouldSpill(bounded.raw, windowTokens)) {
      const ref = saveSpillText(this.id, `${name}.txt`, bounded.raw)
      if (ref) {
        modelValue = buildSpillPreview(bounded.raw, { path: ref.path, bytes: ref.bytes }, windowTokens).text
        spillPath = ref.path
      }
      // ref 为 null（无临时目录 / 写盘失败）→ 保持第一层的有界结果，工具链不中断
    }
    // 显式记录"这条结果属于哪次调用"（复刻 DSH 的 sourceEventSeqs）：
    // 同一 callId 被写两次（崩溃后补写、将来并行执行的重放）时，只有引用能说清归属。
    const callSeq = this.currentCallSeq.get(callId)
    sessionLog.append(this.id, 'tool/result', {
      callId,
      name,
      ok,
      ...(code ? { code } : {}),
      ...(retryable !== undefined ? { retryable } : {}),
      value: logValue,
      error,
      preview,
      ...(callSeq !== undefined ? { sourceEventSeqs: [callSeq] } : {}),
      ...(bounded.pruned ? { modelValue, omittedChars: bounded.omitted?.count } : {}),
      ...(spillPath ? { spillPath } : {}),
      ...(savedImages.length ? { images: savedImages } : {}),
    })
    // 交付物：present 成功后才发布会话事件（失败 / 被阻止不产生交付）。
    // 与 DSH 的 tools/result → deliverables/presented 口径一致；UI 从工具结果投影卡片。
    if (ok && name === 'present') {
      const files = presentedFilesOf(value)
      if (files.length) {
        sessionLog.append(this.id, 'deliverables/presented', {
          turn: Number((value as any)?.turn) || this.turnCount,
          callId,
          files,
        })
      }
    }
    // PTC：present 是 run_code 程序内的子调用，不会单独经过本函数；从预览里收集交付文件
    if (ok && name === 'run_code' && (preview as any)?.kind === 'ptc-run') {
      const files = presentedFilesOf({ files: ((preview as any).toolCalls || []).flatMap((c: any) => c?.name === 'present' ? c.files || [] : []) })
      if (files.length) {
        sessionLog.append(this.id, 'deliverables/presented', {
          turn: this.turnCount,
          callId,
          files,
        })
      }
    }
    // 记入本步结果集合：step 中途抛错时由崩溃恢复逻辑补写（见 runTurn 的 catch 块）
    this.stepResults.set(callId, { name, ok, value: logValue, error, code, retryable, preview, images: savedImages.length ? savedImages : undefined })
    this.emit('tool/result', { callId, name, ok, value: logValue, error, preview })
    this.emittedResultIds.add(callId)
    // 工具调用/结果对是崩溃恢复的关键事实：不等到 50ms 批刷，立刻异步落盘
    void sessionLog.flush(this.id)
  }

  /**
   * 本会话模型的图片输入能力（三态）。只看「确定不支持」时才提前拦 read_image；
   * 不知道时仍交给请求层：真的 400 了再触发「去图重放」（见 runStepWithOverflowRetry）。
   */
  private modelVision(): boolean | undefined {
    if (this.visionSupportCache) return this.visionSupportCache.value
    const config: any = this.options.config || {}
    const model = String(config.model || this.options.llmConfig?.model || config.embed_model || '')
    const value = modelSupportsVision(this.options.provider, model, {
      supportsVision: (this.options as any).supportsVision,
    })
    this.visionSupportCache = { value }
    return value
  }

  private ctx(): ToolExecutionContext {
    return {
      agentId: this.id,
      sessionId: this.id,
      scope: this.options.scope,
      // 会话级「当前工作目录」：working_directory 工具可临时切换（仍限制在工作区内）
      cwd: cwdFor({ agentId: this.id, cwd: this.options.cwd }),
      // 原始工作区根：working_directory 用它做越界校验与"重置"
      workspaceRoot: this.options.cwd,
      // read_image / browser_screenshot 用它判断「图片发了也白发」：false 时直接返回文本说明。
      // undefined（不知道）按「可能支持」处理，请求层再做去图兜底。
      vision: this.imagesSuppressed ? false : (this.modelVision() !== false),
      // 当前 turn 序号：read_file 用它做"同轮重复读取"的短路（跨轮不复用，避免上下文已压缩）
      turn: this.turnCount,
      // 本会话生效窗口：读取类工具据此定单次返回量（避免读了又被裁掉，见 tools.ts defaultReadWindowChars）
      windowTokens: this.effectiveWindowTokens > 0 ? this.effectiveWindowTokens : Number(this.options.contextLimit) || undefined,
        // 当前 agent 的工具白名单（供 run_subagent 等工具继承父级配置）
        tools: this.options.tools,
        // 群成员注册表（swarm 注入；run_subagent(member) 以成员设定建子代理）
        swarmMembers: (this.options as any)?.swarmMembers,
        // 子代理嵌套深度与调用链（tools.ts runSubagent 递归守卫读取）
        swarmDepth: (this.options as any)?.swarmDepth,
        swarmChain: (this.options as any)?.swarmChain,
      signal: this.turnController?.signal,
      sandboxMode: (this.options as any).sandboxMode,
      // 技能管理中关闭的技能（skill 工具加载时校验）
      disabledSkills: this.options.disabledSkills || [],
      // 预设模式的知识库候选范围与召回数（kb_search 工具读取）
      kbPaths: this.options.kbPaths,
      kbTopK: this.options.kbTopK,
      // 检索参数（来源/嵌入兜底/策略）：kb_search 与 search_files(semantic) 读取，
      // 保证 agent 内的检索与主页问答用同一套来源配置
      retrieval: (this.options as any).retrieval,
        // MCP 配置（mcp_call 工具读取）
        mcpServerId: this.options.mcpServerId,
        mcpServerConfig: this.options.mcpServerConfig,
        mcpEquipmentIds: this.options.mcpEquipmentIds,
          mcpServerIds: this.options.mcpServerIds,
          mcpServerConfigs: this.options.mcpServerConfigs,
    }
  }

  // ---------------- 事件 ----------------

  private emit<K extends AgentEventType>(type: K, payload: AgentEventMap[K]): void {
    dispatchEvent({ agentId: this.id as any, type, payload } as AgentEvent)
  }

  private emitStatus(): void {
    this.emit('agent/status', { status: this._status })
  }

  toSummary(): AgentSummary {
    return {
      id: this.id as any,
      status: this._status,
      provider: this.options.provider,
      label: this.options.label,
      pendingInbox: this.inbox.length,
      // 工作目录一并给出：被委派的 agent 用它当相对路径围栏，排查"在哪读写"时要看得到
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
    }
  }

  toStateView(): AgentStateView {
    return {
      ...this.toSummary(),
      turn: this.turnCount,
      step: this.stepInTurn,
      plan: this._plan,
      todos: this._todos,
      runReport: this._runReport,
      lastError: this.lastError,
      lastAssistantContent: this.lastAssistantContent,
    }
  }

  // ---------------- plan / todos（update_plan、update_todo、exit_plan_mode 工具） ----------------

  /**
   * 设置执行计划。**唯一写入口**：先落盘（`plan/write`，整值替换、最后一条胜出），
   * 再广播给 UI——内存状态是日志投影的缓存，不是第二个事实源。
   */
  setPlan(plan: string | null): void {
    this._plan = plan
    sessionLog.append(this.id, 'plan/write', { plan })
    this.emit('agent/plan', { plan })
  }

  getTodos(): TodoItem[] {
    return this._todos
  }

  /**
   * 上报运行状态（report_run 工具）。**唯一写入口**：先落盘（`report/write`，
   * 整值替换、最后一条胜出），再广播给 UI——内存状态是日志投影的缓存。
   *
   * 参照原型的结构化 Report：面板只认这里写下的 state，不从自由文本猜。
   */
  setRunReport(report: RunReport | null): void {
    this._runReport = report
    sessionLog.append(this.id, 'report/write', { report })
    this.emit('agent/report', { report })
  }

  /** 设置待办清单（唯一写入口：落盘 `todo/write` → 广播）。 */
  setTodos(todos: TodoItem[]): void {
    this._todos = Array.isArray(todos) ? todos : []
    sessionLog.append(this.id, 'todo/write', { todos: this._todos })
    this.emit('agent/todos', { todos: this._todos })
  }

  /**
   * 回合开始时的清单收口：整张清单都已收口（done / cancelled）时清空并广播；
   * 仍有 pending / running 项则原样保留（跨轮继续的任务不该被抹掉）。
   */
  private settleTodosAtTurnStart(): void {
    if (!this._todos.length) return
    if (this._todos.some((t) => t.status === 'pending' || t.status === 'running')) return
    this.setTodos([])
  }

  setError(message: string): void {
    this.lastError = message
  }

  /**
   * 凭据接缝（路线图 2.3）：把配置中的 `apiKeyRef`（凭据名）解析为主进程
   * 受保护存储中的明文；内联 `api_key` 原样保留（向后兼容）。
   */
  private resolveConfigWithCredential(config: any): any {
    if (!config || typeof config !== 'object') return config
    const ref = config.apiKeyRef
    if (typeof ref === 'string' && ref.trim() && !config.api_key) {
      const value = credentialStore.resolveValue(ref.trim())
      if (value) return { ...config, api_key: value }
      console.warn(`[agent] 凭据 "${ref}" 不存在或为空，请求将不带 api_key`)
    }
    return config
  }
}

// ---------------------------------------------------------------------------
// Agent 管理器
// ---------------------------------------------------------------------------

const agents = new Map<string, AgentImpl>()

// 子代理接缝（路线图 2.6）：parentId → 活跃子代理 id 集合；父销毁时级联销毁
const childAgents = new Map<string, Set<string>>()

/**
 * 一次性 LLM 调用（无工具、单 step）：给上下文压缩等“旁路请求”复用 AgentImpl 的
 * provider 适配 / 凭据解析 / 重试逻辑，避免再写一套 provider 分发。
 * 用独立会话（可在「设置 → 日志」中审计），完成后立即销毁。
 */
async function runLlmOnce(opts: {
  prompt: string
  systemPrompt?: string
  provider: string
  config?: any
  llmConfig?: any
  label?: string
  /** 流式进度：已生成的正文总字符数（上下文压缩的摘要要用它显示进度） */
  onAssistantDelta?: (totalChars: number) => void
}): Promise<string> {
  const agent = new AgentImpl({
    systemPrompt: opts.systemPrompt,
    provider: opts.provider,
    config: opts.config,
    llmConfig: opts.llmConfig,
    tools: [],
    maxSteps: 2,
    label: opts.label,
    onAssistantDelta: opts.onAssistantDelta,
    // 旁路请求自身不参与上下文压缩（防递归）
    contextCompact: false,
  })
  agents.set(agent.id, agent)
  agent.drive()
  try {
    return await agent.runOnce(opts.prompt)
  } finally {
    await agent.dispose()
  }
}

/** 把 agent 放进注册表并启动驱动器（创建 / 恢复共用） */
function attachAgent(agent: AgentImpl, parentId?: string): void {
  agents.set(agent.id, agent)
  if (parentId) {
    let children = childAgents.get(parentId)
    if (!children) {
      children = new Set()
      childAgents.set(parentId, children)
    }
    children.add(agent.id)
  }
  agent.drive()
}

/** 创建 agent（异步驱动立即启动，返回控制句柄） */
export function createAgent(options: AgentOptions): AgentControl {
  // 远端自托管并发基准随 agent 的 llm 通用配置同步（未携带该字段则不改变当前值）
  setRemoteBackendMaxInflight(options?.llmConfig?.remoteMaxInflight)
  const requested = String(options.sessionId || '').trim()
  if (requested) {
    const live = agents.get(requested)
    if (live instanceof AgentImpl) {
      // 同一聊天重复发送：配置兼容就复用（历史、观察表、计划、工具证据都还在）
      if (live.canResumeWith(options)) {
        live.applyResumeOptions(options)
        return live
      }
      // 配置面变了（换模型 / 改系统提示 / 改工具集）：旧会话不能继续接收新历史
      void live.dispose()
    } else if (options.resume && sessionLog.exists(requested)) {
      const start = sessionLog.getStart(requested)
      if (canResumeSessionStart(start, options)) {
        const resumed = new AgentImpl(options, { id: requested, resume: true })
        attachAgent(resumed, options.parentId)
        return resumed
      }
    } else if (!options.resume && !sessionLog.exists(requested)) {
      /*
       * 调用方给了 id、又没有旧日志：**就用这个 id 新建**。
       *
       * 为什么必须这样：DSH 插件把微信会话 id 当稳定键（绑定、事件流、/list 全按它查）。
       * 旧行为会静默生成 `agent-<uuid>`，于是插件看到的 sessionId 与事件里的 agentId 对不上：
       * 消息能进 agent、推理也完成了，但流式事件因为没有匹配的绑定而被丢掉——微信那头就没回复。
       */
      const created = new AgentImpl(options, { id: requested })
      attachAgent(created, options.parentId)
      notifySessionCreated(created, options)
      return created
    }
  }
  // 新建会话：即使调用方传了 sessionId，也不能把新事件追加到旧日志（签名不兼容）
  const agent = new AgentImpl(options)
  attachAgent(agent, options.parentId)
  notifySessionCreated(agent, options)
  return agent
}

/** 新建会话后的宿主钩子（`session/created`）；异常不影响创建 */
function notifySessionCreated(agent: AgentControl, options: AgentOptions): void {
  try {
    sessionCreatedListener?.({
      sessionId: String(agent.id),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    })
  } catch (e) {
    console.error('[agent-loop] session/created 监听器异常:', e)
  }
}

/** 按 id 取 agent */
export function getAgent(id: string): AgentControl | undefined {
  return agents.get(id)
}

/** 列出全部活跃 agent */
export function listAgents(): AgentSummary[] {
  return Array.from(agents.values()).map((a) => a.toSummary())
}

/** 终止并注销 agent */
export async function disposeAgent(id: string): Promise<void> {
  const agent = agents.get(id)
  if (agent) {
    // 子代理接缝：先销毁子代理（含孙代理），再销毁父代理
    const children = childAgents.get(id)
    if (children && children.size > 0) {
      for (const childId of Array.from(children)) {
        await disposeAgent(childId)
      }
      childAgents.delete(id)
    }
    await agent.dispose()
  }
  // 清理父引用（若自身是子代理，从父的集合中移除）
  for (const [, children] of childAgents) {
    children.delete(id)
  }
}

/**
 * 某 agent 会话当前生效的工具清单（供 UI 展示：`agent:tools`，注册表面板「运行中的会话」用它）。
 *
 * 与 agent-loop 下发给模型的那份**同源**（`AgentImpl.visibleToolDefs`）：scope 层 + 白名单解析
 * （含跨层插件工具）+ 未配置白名单 = 不限制。历史实现有两处偏差，都会让界面说反话：
 *   1. 只认 `whitelist === null` 为"不限制"，而运行时用的是 `!Array.isArray`（undefined 同样宽松）
 *      → `tools` 为 undefined 的会话被过滤成**空清单**；
 *   2. 只在 `list(scope)` 里按名字找，插件工具（注册在 `plugin:<id>` 层）永远解析不到
 *      → 用户在预设 / 白名单里勾了插件工具，这里却显示"没有"。
 * agent 已销毁 / 不存在时退回该 scope 的可见集（scope 也不给则只有全局层）。
 */
export function listAgentTools(agentId: string, scope?: string): { name: ToolName; description: string }[] {
  const agent = agents.get(agentId)
  if (agent) return agent.visibleToolDefs().map((d) => ({ name: d.name, description: d.description }))
  return toolRegistry
    .list(scope)
    .filter((d) => d.name !== 'run_code')
    .map((d) => ({ name: d.name, description: d.description }))
}

// ---------------------------------------------------------------------------
// ask_user 问答接缝（对齐 DSH user-questions seam）
//
// 一次可以有多个问题（单选 / 多选 / 自由文本），回答按问题 id 回填：
// 渲染进程弹窗收集后经 agent:answer 回传 `answers`（DSH 的 answer batch）。
// ---------------------------------------------------------------------------

interface PendingQuestion {
  askId: string
  /** 纯文本摘要（日志 / 兼容旧界面） */
  question: string
  /** 结构化问题（DSH ask_user_question 契约） */
  questions: AskUserQuestion[]
  resolve: (answers: AskUserAnswer[]) => void
  reject: (reason?: any) => void
}

const pendingQuestions = new Map<string, Map<string, PendingQuestion>>()

/**
 * 请求用户回答（ask_user 工具调用）。返回的 Promise 挂起，直到渲染进程
 * 通过 agent:answer IPC 回复；agent dispose / 取消时 reject 全部挂起问题。
 *
 * @param agentId 归属会话
 * @param questions 结构化问题（≥1 题）
 * @param digest 纯文本摘要（事件载荷的 question 字段）
 */
export function requestQuestions(agentId: string, questions: AskUserQuestion[], digest?: string): Promise<AskUserAnswer[]> {
  // 有插件认领（微信 / 远程桥）就先走拦截链；没有就走原来的渲染层提问
  if (!hasPluginWaterfall('user-questions/request')) {
    return requestQuestionsDirect(agentId, questions, digest)
  }
  return runPluginWaterfall<AskUserAnswer[]>(
    'user-questions/request',
    { agentId, questions, ...(digest ? { digest } : {}) },
    () => requestQuestionsDirect(agentId, questions, digest),
  )
}

/**
 * 直接向渲染层提问（不经过插件拦截链）。
 *
 * 单独导出是为了让插件服务（`ctx.userQuestions.ask`）在 fallback 里调用它——
 * 若回调 `requestQuestions` 会再次进入拦截链，形成 "next() → 再拦截" 的递归。
 */
export function requestQuestionsDirect(agentId: string, questions: AskUserQuestion[], digest?: string): Promise<AskUserAnswer[]> {
  return new Promise<AskUserAnswer[]>((resolve, reject) => {
    const askId = `ask-${randomUUID()}`
    let map = pendingQuestions.get(agentId)
    if (!map) {
      map = new Map()
      pendingQuestions.set(agentId, map)
    }
    map.set(askId, { askId, question: digest || '', questions, resolve, reject })
    emitTo(agentId, 'agent/question', {
      askId,
      question: digest || askQuestionsDigest(questions),
      questions,
    })
  })
}

/** 渲染进程回复问题（agent:answer） */
export function resolveAnswer(agentId: string, askId: string, answer: string, answers?: AskUserAnswer[]): boolean {
  if (isPlanReviewId(askId)) {
    // 计划评审走同一条通道（id 前缀 review-）：message 是裁决，answers[0].custom 是反馈。
    // 会话还活着 → 交给挂起的工具；已经结束（进程重启后恢复的那条）→ 补记裁决进日志。
    return resolvePlanReview(agentId, askId, answer, answers)
      || recordPlanReviewForFinishedSession(agentId, askId, answer, answers)
  }
  const map = pendingQuestions.get(agentId)
  const p = map?.get(askId)
  if (!p) return false
  map!.delete(askId)
  // 优先用结构化回答；只有纯文本回答时，落到第一题的自定义回答上（旧界面 / 旧客户端）
  const batch = Array.isArray(answers) && answers.length
    ? coerceAskAnswers(answers, p.questions)
    : coerceAskAnswers([{ id: p.questions[0]?.id, selected: [], custom: answer }], p.questions)
  p.resolve(batch)
  return true
}

/** 销毁 / 取消时 reject 全部挂起问题（防止悬挂 Promise） */
function rejectPendingQuestions(agentId: string, reason: string): void {
  const map = pendingQuestions.get(agentId)
  if (map) {
    for (const p of map.values()) {
      p.reject(new Error(reason))
    }
    pendingQuestions.delete(agentId)
  }
  const reviews = pendingPlanReviews.get(agentId)
  if (reviews) {
    // 先落一条 cancelled 裁决（否则重启后那条评审会"复活"成永远待裁决），再 reject
    settlePlanReviews(agentId, 'cancelled')
    for (const r of reviews.values()) {
      r.reject(new Error(reason))
    }
    pendingPlanReviews.delete(agentId)
  }
}

// ---------------------------------------------------------------------------
// 计划评审接缝（对齐 DSH 计划模式的 exit_plan_mode）
//
// 与 ask_user 共用同一条回答通道（agent:answer）：`message` 携带裁决
// （'approve' / 'keep' / 'dismiss'），`answers[0].custom` 携带「继续完善」的反馈。
// 契约（取值与解析）在 @/shared/agentPlanReview，主进程与手机/网页端共用。
// ---------------------------------------------------------------------------

interface PendingPlanReview {
  reviewId: string
  plan: string
  resolve: (outcome: PlanReviewOutcome) => void
  reject: (reason?: any) => void
}

const pendingPlanReviews = new Map<string, Map<string, PendingPlanReview>>()

/**
 * 请用户评审一份计划（exit_plan_mode 工具调用）。
 * 返回的 Promise 挂起，直到渲染进程经 agent:answer 回复裁决；取消 / 销毁时 reject。
 *
 * **落盘**：开启与裁决各写一条事件（`plan/review` / `plan/review-result`），
 * 因此"待评审"是日志折叠出来的事实——进程重启后仍能被恢复，而不是凭空消失。
 */
export function requestPlanReview(agentId: string, plan: string): Promise<PlanReviewOutcome> {
  return new Promise<PlanReviewOutcome>((resolve, reject) => {
    const reviewId = `${PLAN_REVIEW_ID_PREFIX}${randomUUID()}`
    let map = pendingPlanReviews.get(agentId)
    if (!map) {
      map = new Map()
      pendingPlanReviews.set(agentId, map)
    }
    map.set(reviewId, { reviewId, plan, resolve, reject })
    sessionLog.append(agentId, 'plan/review', { reviewId, plan })
    emitTo(agentId, 'agent/plan-review', { reviewId, plan })
  })
}

/** 解析一条计划评审回复（agent:answer 上的 review-* id） */
function resolvePlanReview(agentId: string, reviewId: string, message: string, answers?: AskUserAnswer[]): boolean {
  const map = pendingPlanReviews.get(agentId)
  const p = map?.get(reviewId)
  if (!p) return false
  map!.delete(reviewId)
  const outcome = parsePlanReviewReply(message, answers)
  sessionLog.append(agentId, 'plan/review-result', {
    reviewId,
    verdict: outcome.verdict,
    ...(outcome.feedback ? { feedback: outcome.feedback } : {}),
  })
  p.resolve(outcome)
  return true
}

/**
 * 为**已经结束的会话**补记一条评审裁决（进程重启后，用户回答那条被恢复的待评审）。
 *
 * 为什么允许：原来的 turn 已经不存在了，但"用户批准 / 要求继续完善"仍是事实，
 * 必须落到日志，否则界面会永远展示一条没人管的待评审。裁决同时由渲染层记进聊天存档，
 * 在下一次开场时作为种子交给新会话（见 AgentOptions.seedPlanDecision）。
 *
 * @returns 是否记入了一条有效裁决（false = 该会话没挂着这条评审）
 */
function recordPlanReviewForFinishedSession(
  sessionId: string,
  reviewId: string,
  message: string,
  answers?: AskUserAnswer[],
): boolean {
  const state = sessionLog.projectAgentState(sessionId)
  if (!state.pendingReview || state.pendingReview.reviewId !== reviewId) return false
  const outcome = parsePlanReviewReply(message, answers)
  sessionLog.append(sessionId, 'plan/review-result', {
    reviewId,
    verdict: outcome.verdict,
    ...(outcome.feedback ? { feedback: outcome.feedback } : {}),
  })
  return true
}

/**
 * 会话取消 / 销毁时把挂起的评审收口（写 `cancelled` 裁决）。
 * 否则那条评审会永远停在"待评审"，重启后被当成未完成的决策重新弹出来。
 */
function settlePlanReviews(agentId: string, verdict: string): void {
  const map = pendingPlanReviews.get(agentId)
  if (!map || map.size === 0) return
  for (const r of map.values()) {
    sessionLog.append(agentId, 'plan/review-result', { reviewId: r.reviewId, verdict })
  }
}

// ---------------------------------------------------------------------------
// 渲染层任务接缝（主进程工具 → 渲染进程执行浏览器侧工作，如 Word 导出）
//
// 有些工具需要 DOM / MathJax / canvas 等只有渲染进程具备的能力（典型：把 Markdown
// 导出为 .docx）。主进程无法自行完成，故：广播 `agent/renderer-task` → 任一渲染窗口
// claim（先到先得，避免多窗口重复执行）→ 执行 → 经 `agent:renderer-result` 回传结果。
// ---------------------------------------------------------------------------

interface PendingRendererTask {
  taskId: string
  kind: string
  claimed: boolean
  resolve: (result: any) => void
  reject: (reason?: any) => void
  timer: NodeJS.Timeout
}

const pendingRendererTasks = new Map<string, Map<string, PendingRendererTask>>()

/**
 * 请求渲染进程执行一项任务，Promise 挂起到渲染层回传结果。
 * 无人 claim（窗口全部关闭 / 未初始化接缝）或超时 → reject（默认 3 分钟）。
 */
export function requestRendererTask(agentId: string, kind: string, payload: any, timeoutMs = 3 * 60 * 1000): Promise<any> {
  return new Promise<any>((resolve, reject) => {
    const taskId = `rtask-${randomUUID()}`
    let map = pendingRendererTasks.get(agentId)
    if (!map) {
      map = new Map()
      pendingRendererTasks.set(agentId, map)
    }
    const timer = setTimeout(() => {
      map!.delete(taskId)
      reject(new Error('渲染层未响应（可能所有窗口都不可执行该任务）'))
    }, timeoutMs)
    map.set(taskId, { taskId, kind, claimed: false, resolve, reject, timer })
    emitTo(agentId, 'agent/renderer-task', { taskId, kind, payload })
  })
}

/** 渲染进程抢占任务：第一个 claim 成功的窗口负责执行，其余窗口忽略（返回 false） */
export function claimRendererTask(agentId: string, taskId: string): boolean {
  const t = pendingRendererTasks.get(agentId)?.get(taskId)
  if (!t || t.claimed) return false
  t.claimed = true
  return true
}

/** 渲染进程回传任务结果：{ ok:false, error } 转为 reject，其余 resolve(value) */
export function resolveRendererTask(agentId: string, taskId: string, result: any): boolean {
  const map = pendingRendererTasks.get(agentId)
  const t = map?.get(taskId)
  if (!t) return false
  clearTimeout(t.timer)
  map!.delete(taskId)
  if (result && result.ok === false) t.reject(new Error(String(result.error || '渲染层任务执行失败')))
  else t.resolve(result?.value !== undefined ? result.value : result)
  return true
}

/** 销毁/取消 agent 时 reject 全部挂起任务（防止工具调用悬挂） */
function rejectPendingRendererTasks(agentId: string, reason: string): void {
  const map = pendingRendererTasks.get(agentId)
  if (!map) return
  for (const t of map.values()) {
    clearTimeout(t.timer)
    t.reject(new Error(reason))
  }
  pendingRendererTasks.delete(agentId)
}

// ---------------------------------------------------------------------------
// 管理器对外扩展（供 tools.ts 的工具实现调用）
// ---------------------------------------------------------------------------

/**
 * 读取 agent 完整状态（agent:state）。
 *
 * 会话还活着 → 内存状态；会话已销毁 → **从日志回放**计划与待办
 * （`plan/write` / `todo/write` 最后一条胜出）。这样"执行完毕的会话"在
 * 控制台 / 审计里仍能看到最终计划与清单，而不是一片空白。
 */
export function getAgentState(id: string): AgentStateView | undefined {
  const live = agents.get(id)?.toStateView()
  if (live) {
    // 活着时以内存里的挂起评审为准（日志里的 `plan/review` 与它一一对应）
    const review = pendingPlanReviews.get(id)?.values().next().value as PendingPlanReview | undefined
    if (review) live.pendingPlanReview = { reviewId: review.reviewId, plan: review.plan }
    // 挂起中的提问同理：渲染层重载 / 切窗口后要靠它把「正在等你的问题」恢复出来
    // （提问不落日志，只有内存这一份，所以必须在这里补）
    const ask = pendingQuestions.get(id)?.values().next().value as PendingQuestion | undefined
    if (ask) live.pendingQuestion = { askId: ask.askId, question: ask.question || askQuestionsDigest(ask.questions), questions: ask.questions }
    return live
  }
  const replay = sessionLog.projectAgentState(id)
  if (!replay.plan && !replay.todos.length && !replay.pendingReview && !replay.runReport) return undefined
  const state: AgentStateView = {
    id: id as AgentId,
    status: 'disposed',
    provider: '',
    pendingInbox: 0,
    turn: 0,
    step: 0,
    plan: replay.plan,
    todos: replay.todos,
    runReport: replay.runReport,
  }
  // 进程重启后仍挂着的评审：界面据此恢复那条未完成的决策
  if (replay.pendingReview) state.pendingPlanReview = { ...replay.pendingReview }
  return state
}

/** 读取 agent 最近一次 assistant 完整内容（工具/工作流取结果用：比从日志重建更可靠） */
export function getAgentLastContent(id: string): string {
  return agents.get(id)?.lastContent || ''
}

/**
 * 工作流智能体节点用：创建 agent → 发送输入 → 等待收敛 → 返回最后一次 assistant 内容。
 * 附超时（默认 10 分钟），超时自动取消并返回。无论成败都销毁该临时 agent。
 */
export async function runAgentAndAwait(
  options: AgentOptions,
  input: string,
  timeoutMs = 10 * 60 * 1000,
): Promise<{ content: string; error?: string; timedOut: boolean; turn: number }> {
  const agent = createAgent(options) as unknown as AgentImpl
  const before = agent.currentTurn
  agent.send(String(input ?? ''))
  const started = Date.now()
  try {
    while (Date.now() - started < timeoutMs) {
      const s = agent.status
      if (s === 'disposed') break
      // 任务已推进且收敛到 idle → 完成
      if (s === 'idle' && agent.currentTurn > before) break
      await new Promise((r) => setTimeout(r, 60))
    }
  } finally {
    if (agent.status !== 'idle' && agent.status !== 'disposed') {
      agent.cancel('timeout', { keepInbox: true })
    }
  }
  const timedOut = Date.now() - started >= timeoutMs
  const state = agent.toStateView()
  const content = agent.lastContent || ''
  await disposeAgent(agent.id)
  return { content, error: state.lastError, timedOut, turn: state.turn }
}

/** 子代理一次性执行的结果（中止时 output 是中止前的部分输出，不冒充成功） */
export interface AgentTurnOutcome {
  /** 是否正常收敛（无超时、无取消、无运行期错误） */
  ok: boolean
  /** 本轮最终助手文本（中止时是中止前的部分输出） */
  output: string
  /** 运行期错误（agent/error 记录的最后一条） */
  error?: string
  timedOut: boolean
  cancelled: boolean
  /** 本轮 turn 序号（0 = 从未开始） */
  turn: number
}

/**
 * 子代理一次性执行：投递 prompt → 等这一轮 turn 收敛 → 返回最终助手文本。
 *
 * 为什么不能直接 `send()` + `whenIdle()`：`send()` 只把输入投进 inbox，驱动器还没把状态
 * 切到 running，此刻 `whenIdle()` 会**立即解析**（拿到空的 lastContent）——这是
 * `runOnce()` 注释里记录的同一个坑。这里改用「turn 序号前进 + 回到 idle」判定收敛，
 * 并支持超时与父级取消（保留中止前的部分输出，供父 Agent 判断已完成了多少）。
 *
 * 不销毁会话：调用方自行决定 `disposeAgent`（后台任务由收集/取消时机决定）。
 */
export async function awaitAgentTurn(
  agentId: string,
  prompt: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; source?: string } = {},
): Promise<AgentTurnOutcome> {
  const agent = agents.get(agentId)
  if (!agent) {
    return { ok: false, output: '', error: '子代理会话不存在（可能已被销毁）', timedOut: false, cancelled: false, turn: 0 }
  }
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 10 * 60 * 1000)
  const before = agent.currentTurn
  agent.send(prompt, opts.source || 'subagent')

  // 1) 先等驱动器真正接手（状态离开 idle 或 turn 序号前进），最多 10s
  const startDeadline = Date.now() + 10_000
  while (agent.status !== 'disposed' && agent.status === 'idle' && agent.currentTurn <= before && Date.now() < startDeadline) {
    await new Promise((r) => setTimeout(r, 10))
  }

  // 2) 等本轮收敛；期间响应超时与父级取消
  let timedOut = false
  let cancelled = false
  const started = Date.now()
  while (agent.status !== 'disposed') {
    if (agent.currentTurn > before && agent.status === 'idle') break
    if (opts.signal?.aborted) {
      cancelled = true
      agent.cancel('parent-cancelled')
      break
    }
    if (Date.now() - started > timeoutMs) {
      timedOut = true
      agent.cancel('timeout')
      break
    }
    await new Promise((r) => setTimeout(r, 60))
  }

  // 3) 被中止时等它真正收口（有界），以便拿到中止前的部分输出
  if (timedOut || cancelled) {
    const settleDeadline = Date.now() + 5000
    while (agent.status !== 'disposed' && agent.status !== 'idle' && Date.now() < settleDeadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  const state = agent.toStateView()
  const output = agent.lastContent || ''
  const error = state.lastError
  return {
    ok: !timedOut && !cancelled && !error,
    output,
    error: error || (timedOut ? `子代理超时（${Math.round(timeoutMs / 1000)}s）` : cancelled ? '父级已取消，子代理被中止' : undefined),
    timedOut,
    cancelled,
    turn: state.turn,
  }
}

/**
 * 「撞到单个 turn 步数上限」的**唯一**文案构造器。
 *
 * 为什么抽出来：`ctx.agent.run` 要把这种终止归成 `termination: 'maxSteps'`（而不是笼统的 `error`），
 * 而循环里报的是文案。两边共用本函数就能做**精确比对**，不必去模糊匹配一句中文
 * （文案改了这里改一处，比对自动跟着变）。
 */
export function stepLimitMessage(maxSteps: number): string {
  return `达到单个 turn 的最大 step 数（${maxSteps}），已停止`
}

/**
 * 委派执行（`ctx.agent.run` 的主进程侧）：创建**独立会话** → 跑一轮 → **无论成败都在 finally 里销毁** →
 * 归一成插件可见的结果。
 *
 * 三条纪律：
 * 1. **只紧不松**：不论调用方在 options 里传了什么 `maxSteps`，一律用宿主裁定后的 `budget.maxSteps`；
 * 2. **返回前一定 dispose**（对齐 DSH「前台调用…在返回前总会等待 `run.dispose()`」）。
 *    注意 `runAgentAndAwait` 把 `disposeAgent` 放在 `try/finally` **之后**，轮询抛错就会漏掉 ——
 *    这里必须放 `finally` 里；
 * 3. **失败也要把中止前的部分输出带回**（`awaitAgentTurn` 已有 5s 收口等待），
 *    由 `normalizeAgentRunResult` 统一判定 `ok`，本函数不自己判。
 *
 * 不碰父会话：新建独立 agent（`label` 打上 `plugin:<id>` 便于用户辨认），不 resume 用户既有会话。
 */
export async function runDelegatedAgent(
  options: AgentOptions,
  input: string,
  budget: { timeoutMs: number; maxSteps: number },
  pluginId: string,
  signal?: AbortSignal,
): Promise<AgentRunResult> {
  const agent = createAgent({
    ...options,
    maxSteps: budget.maxSteps,
    label: options.label || `plugin:${pluginId}`,
    scope: options.scope || `plugin:${pluginId}`,
  })
  // 登记归属：插件事件转发据此把 agent 输出**只发给拥有这次 run 的插件**
  //（DSH 靠 Scoped<Agent> 做这件事；AI-KM 没有 isolate，所以显式记表）
  registerOwnedAgent(agent.id, pluginId)
  try {
    const outcome = await awaitAgentTurn(agent.id, input, {
      timeoutMs: budget.timeoutMs,
      source: `plugin:${pluginId}`,
      ...(signal ? { signal } : {}),
    })
    // 撞步数上限时循环报的是固定文案 → 精确比对一次，归成 maxSteps（比 'error' 对作者更有用）
    const isStepLimit = outcome.error === stepLimitMessage(budget.maxSteps)
    return normalizeAgentRunResult({
      output: outcome.output,
      error: outcome.error,
      timedOut: outcome.timedOut,
      cancelled: outcome.cancelled,
      turn: outcome.turn,
      ...(isStepLimit ? { termination: 'maxSteps' as const } : {}),
    })
  } finally {
    unregisterOwnedAgent(agent.id)
    try {
      await disposeAgent(agent.id)
    } catch (e) {
      console.warn(`[plugin-agent] dispose 失败（${pluginId}）:`, e)
    }
  }
}

/** `update_plan` 工具：设置执行计划并广播 */
export function setAgentPlan(agentId: string, plan: string | null): boolean {
  const agent = agents.get(agentId)
  if (!agent) return false
  agent.setPlan(plan)
  return true
}

/** update_todo 工具：设置待办清单并广播 */
export function setAgentTodos(agentId: string, todos: TodoItem[]): boolean {
  const agent = agents.get(agentId)
  if (!agent) return false
  agent.setTodos(todos)
  return true
}

/** `report_run` 工具：上报运行状态并广播（整值替换；null = 清除） */
export function setAgentRunReport(agentId: string, report: RunReport | null): boolean {
  const agent = agents.get(agentId)
  if (!agent) return false
  agent.setRunReport(report)
  return true
}

/** 读取 agent 当前待办清单（update_todo 校验/合并、工作流取状态时用） */
export function getAgentTodos(agentId: string): TodoItem[] {
  const agent = agents.get(agentId)
  return agent ? agent.getTodos() : []
}
