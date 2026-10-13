/**
 * lan-guest.ts — 局域网访客（网页端）主机侧执行层（P3 令牌/并发 + P4 智能体桥）
 *
 * 背景：局域网共享（`http://<ip>:3345`）把网页版暴露给局域网。网页端没有
 * ipcRenderer，因此**所有能力都必须由主机侧执行并逐项授权**：
 *
 * - **策略来源**：唯一事实源是渲染进程推来的 `LanGuestPolicy`
 *   （设置页「协作 → 权限」维护，见 src/shared/lanGuest.ts）。本模块只读、不改。
 * - **令牌（P3）**：`requireToken` 打开时，静态站用 Cookie（首次 `?token=` 换取），
 *   接口用 `Authorization: Bearer` / `X-AIKM-Token` / `?token=` / Cookie 任一；
 *   默认关闭（局域网内直接可访问）。
 * - **并发（P3）**：模型相关请求（/__proxy 聊天、/api/kb/search 向量检索、
 *   访客智能体运行）共用同一个信号量，上限 = `policy.maxConcurrent`，
 *   保护主机 GPU / 模型（排队等待，超时 429）。
 * - **智能体桥（P4）**：访客的「智能体」模式不是网页端自己跑循环，而是
 *   `/api/agent/create` 让**主机**用 agent-loop 建会话（工具白名单 / 沙箱 /
 *   轮数上限 / 工作区围栏全部由主机决定），`/api/agent/events` 用 SSE 把
 *   agent 事件流原样转发给网页端——网页端只是渲染器，拿不到任何额外权限。
 *
 * 安全要点（勿改）：
 * - `effectiveGuestTools()` 把策略里的 `tools: null` 回落为**只读默认集**
 *   （AgentOptions.tools = null 语义是「全部工具」，误传即失守）；
 * - 文件工具的工作区根 = 主机共享目录（未设时退到 userData 下的访客沙箱目录），
 *   工具内部的 `resolveWithinCwd` 会拒绝越界路径；
 * - 会话归属按来源 IP 校验，访客不能操作别人的会话。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'
import {
  LAN_GUEST_COOKIE,
  LAN_GUEST_GENERAL_AGENT,
  LAN_GUEST_TOKEN_HEADER,
  effectiveGuestTools,
  lanGuestModeAllowed,
  normalizeLanGuestPolicy,
  type LanGuestAgentProfile,
  type LanGuestMode,
  type LanGuestPolicy,
} from '@/shared/lanGuest'
import * as agentLoop from './agent-loop'
import { skillService } from './skill-service'
import { toolRegistry } from '@/shared/toolRegistry'
import { AIUtils } from '@/shared/ai-core'
import type { AgentEvent, AgentOptions } from '@/types/agent'

// ---------------------------------------------------------------------------
// 配置（由渲染进程推送；见 main/index.ts 的 lan:setGuest* 通道）
// ---------------------------------------------------------------------------

/** 主机用于访客会话的 LLM 配置（访客默认用主机模型，无需自带 Key） */
export interface LanGuestHostLlm {
  provider: string
  config?: any
  llmConfig?: any
  /** 主机侧解析出的上下文窗口上限（tokens）：主进程据此做预算检查与主动压缩 */
  contextLimit?: number
}

let policy: LanGuestPolicy = normalizeLanGuestPolicy(null)
let hostLlm: LanGuestHostLlm | null = null
/** 主机可用的模型来源快照（渲染层下发；网页端据此对齐来源开关 / 地址 / 模型） */
let modelSources: { llm: any; disabled: string[] } | null = null
/** 主机共享目录（= store.lan.kbDir）；访客智能体的文件围栏根 */
let shareDir = ''
/** 允许访客使用的智能体预设档案（渲染层组装后推送；id=general 为通用智能体，不在列表里） */
let hostAgents: LanGuestAgentProfile[] = []

export function setLanGuestPolicy(raw: unknown): LanGuestPolicy {
  policy = normalizeLanGuestPolicy(raw)
  return policy
}

/** 接收访客可用智能体档案（只保留名称/选项均合法的项） */
export function setLanGuestAgents(raw: unknown): void {
  hostAgents = Array.isArray(raw)
    ? raw
        .filter((a: any) => a && typeof a.id === 'string' && a.id && a.options && typeof a.options === 'object')
        .map((a: any) => ({ id: String(a.id), name: String(a.name || a.id), desc: typeof a.desc === 'string' ? a.desc : '', options: a.options as Record<string, any> }))
    : []
  lastAgentsPushAt = Date.now()
  // 唤醒正在等待“最新策略”的访客请求（见 refreshPolicyFromRenderer）
  pendingPolicyRefresh?.resolve()
}

// ---------------------------------------------------------------------------
// 向渲染层拉取最新策略（主进程自己组不出档案：预设提示词/工具/MCP 都在渲染层）
// ---------------------------------------------------------------------------

/** 请求渲染层重新下发访客策略（由 main/index.ts 注入，避免与它循环依赖） */
let policyRequester: (() => void) | null = null
let lastAgentsPushAt = 0
let pendingPolicyRefresh: { resolve: () => void } | null = null

export function setLanPolicyRequester(fn: (() => void) | null): void {
  policyRequester = fn
}

/**
 * 请渲染层重新下发一次策略，并等待其到达（超时则用现有数据继续）。
 * 用途：网页端请求 `/api/agent/info`、`/api/llm/sources` 时保证拿到**主机当前最新的**
 * 智能体清单与模型来源（否则主机改了「可用智能体」/ 来源地址而没重开权限页时，网页端只能看到旧数据）。
 * 节流：距上次下发 < 2s 则跳过，避免密集请求反复组装档案。
 */
export async function refreshPolicyFromRenderer(timeoutMs = 1500): Promise<void> {
  if (!policyRequester) return
  if (pendingPolicyRefresh) return
  if (Date.now() - lastAgentsPushAt < 2000) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      pendingPolicyRefresh = null
      resolve()
    }, timeoutMs)
    pendingPolicyRefresh = {
      resolve: () => {
        clearTimeout(timer)
        pendingPolicyRefresh = null
        resolve()
      },
    }
    try {
      policyRequester?.()
    } catch {
      clearTimeout(timer)
      pendingPolicyRefresh = null
      resolve()
    }
  })
}

export function getLanGuestPolicy(): LanGuestPolicy {
  return policy
}

export function setLanGuestLlm(raw: unknown): void {
  const cfg = raw as any
  if (!cfg || typeof cfg.provider !== 'string' || !cfg.provider) {
    hostLlm = null
    return
  }
  const limit = Number(cfg.contextLimit)
  hostLlm = {
    provider: cfg.provider,
    config: cfg.config,
    llmConfig: cfg.llmConfig,
    ...(Number.isFinite(limit) && limit > 0 ? { contextLimit: Math.round(limit) } : {}),
  }
}

export function setLanShareDir(dir: unknown): void {
  shareDir = typeof dir === 'string' ? dir : ''
}

/** 接收渲染层下发的「主机可用的模型来源」快照（不含密钥；见 platform/lanKb.buildLanModelSourcesPayload） */
export function setLanModelSources(raw: unknown): void {
  const cfg = raw as any
  modelSources = cfg && typeof cfg === 'object' && cfg.llm && typeof cfg.llm === 'object'
    ? { llm: cfg.llm, disabled: Array.isArray(cfg.disabled) ? cfg.disabled.filter((x: any) => typeof x === 'string') : [] }
    : null
}

/**
 * 现场探测各来源的模型列表（网页端刷新 / 首次加载时调用）。
 *
 * 关键：探测**在主机用主机自己的配置**执行（与桌面端同一套 ai-core），
 * 所以「桌面端能刷出来的，网页端也能刷出来」——不再依赖网页端自己的默认地址。
 * 只探本地 / 自托管来源（ollama / lmstudio / 自定义）：云端来源需要密钥，不代网页端探测。
 * 每个来源单独限时，避免某个不可达服务把整次请求拖死。
 */
export async function probeLanModelSources(timeoutMs = 3500): Promise<{ llm: any; disabled: string[] }> {
  const data = modelSources
  if (!data?.llm) return { llm: null, disabled: data?.disabled || [] }
  const llm = JSON.parse(JSON.stringify(data.llm))
  const within = async <T>(p: Promise<T>): Promise<T | null> => {
    try {
      return await Promise.race([
        p,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ])
    } catch {
      return null
    }
  }
  const jobs: Array<Promise<void>> = []
  if (llm.ollama?.model_url) {
    jobs.push((async () => {
      const r: any = await within(AIUtils.checkOllamaConnection({ model_url: llm.ollama.model_url, model: llm.ollama.model || '' }))
      if (r?.online && Array.isArray(r.available_models)) llm.ollama.available_models = r.available_models
    })())
  }
  if (llm.lmstudio?.base_url) {
    jobs.push((async () => {
      const r: any = await within(AIUtils.checkLMStudioConnection({ base_url: llm.lmstudio.base_url, model: llm.lmstudio.model || '' }))
      if (r?.online && Array.isArray(r.available_models)) llm.lmstudio.available_models = r.available_models
    })())
  }
  for (const src of (Array.isArray(llm.custom?.sources) ? llm.custom.sources : [])) {
    if (!src?.api_url) continue
    jobs.push((async () => {
      const r: any = await within(AIUtils.checkCustomConnection({ api_url: src.api_url, model: src.model || '' }))
      if (r?.online && Array.isArray(r.available_models)) src.available_models = r.available_models
    })())
  }
  await Promise.all(jobs)
  return { llm, disabled: data.disabled || [] }
}

/** 最近一次由渲染层下发的模型来源快照（不触发探测） */
export function getLanModelSources(): { llm: any; disabled: string[] } {
  return modelSources ? { llm: modelSources.llm, disabled: modelSources.disabled } : { llm: null, disabled: [] }
}

// ---------------------------------------------------------------------------
// 令牌（P3）
// ---------------------------------------------------------------------------

/** 访客令牌（不需要令牌时返回空串） */
export function lanGuestToken(): string {
  return policy.requireToken ? policy.token : ''
}

export function lanGuestTokenRequired(): boolean {
  return policy.requireToken
}

/** 手动拆分查询串（与 index.ts 的 parseLanQuery 同一口径） */
function queryOf(rawUrl: string, key: string): string {
  const qIdx = rawUrl.indexOf('?')
  if (qIdx === -1) return ''
  for (const part of rawUrl.substring(qIdx + 1).split('&')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.substring(0, eq) !== key) continue
    try { return decodeURIComponent(part.substring(eq + 1)) } catch { return '' }
  }
  return ''
}

/** 读取请求携带的访客令牌：自定义头 → Bearer → 查询串 → Cookie */
export function readLanGuestToken(req: IncomingMessage): string {
  const header = req.headers[LAN_GUEST_TOKEN_HEADER]
  if (typeof header === 'string' && header) return header
  const auth = req.headers['authorization']
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim()
  const q = queryOf(req.url || '', 'token')
  if (q) return q
  const cookie = req.headers['cookie']
  if (typeof cookie === 'string') {
    for (const part of cookie.split(';')) {
      const eq = part.indexOf('=')
      if (eq === -1) continue
      if (part.substring(0, eq).trim() === LAN_GUEST_COOKIE) {
        try { return decodeURIComponent(part.substring(eq + 1).trim()) } catch { return part.substring(eq + 1).trim() }
      }
    }
  }
  return ''
}

/** 接口访问校验：返回 null = 放行，否则返回错误体（401） */
export function lanGuestDenied(req: IncomingMessage): { status: number; body: any } | null {
  const token = lanGuestToken()
  if (!token) return null
  if (readLanGuestToken(req) === token) return null
  return {
    status: 401,
    body: {
      ok: false,
      code: 'TOKEN_REQUIRED',
      error: '需要访问令牌（主机已开启「访问令牌」；请在共享链接中带上 ?token=…）',
      errorEn: 'Access token required (the host enabled “Access token”; open the shared link with ?token=…)',
    },
  }
}

/** 静态站未授权时返回的解锁页（用 ?token= 换 Cookie，之后静态资源即可正常加载） */
export function lanUnlockPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>需要访问令牌 · AI-KM</title>
<style>
  body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
         font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
         background:#1e1e1e; color:#ddd; }
  form { background:#252526; border:1px solid #3a3a3a; border-radius:8px; padding:22px 24px; width:320px; }
  h1 { font-size:15px; margin:0 0 6px; }
  p { font-size:12px; opacity:.65; margin:0 0 14px; }
  input { width:100%; box-sizing:border-box; padding:8px 10px; border-radius:6px;
          border:1px solid #3a3a3a; background:#1b1b1b; color:#eee; font-size:13px; }
  button { margin-top:12px; width:100%; padding:8px 10px; border:0; border-radius:6px;
           background:#0e639c; color:#fff; font-size:13px; cursor:pointer; }
  button:hover { background:#1177bb; }
</style>
</head>
<body>
  <form method="get">
    <h1>需要访问令牌</h1>
    <p>Host requires an access token to open shared web app.</p>
    <input name="token" placeholder="访问令牌 / Access token" autofocus autocomplete="off" />
    <button type="submit">进入 / Enter</button>
  </form>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// 并发闸门（P3）：模型相关请求共用一个信号量
// ---------------------------------------------------------------------------

let maxConcurrent = 1
let activeSlots = 0
const waitQueue: Array<{ resolve: (release: () => void) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = []

/** 并发上限随策略更新（只影响后续申请） */
export function setLanMaxConcurrent(n: unknown): void {
  const v = Math.round(Number(n))
  maxConcurrent = Number.isFinite(v) && v > 0 ? Math.min(20, v) : 1
}

/**
 * 申请一个并发额度（模型相关请求）。等待超过 60s 抛错（调用方回 429）。
 * 返回释放函数；**必须**在请求结束/流结束/异常时调用（建议 try/finally）。
 */
export function acquireLanSlot(waitMs = 60_000): Promise<() => void> {
  if (activeSlots < maxConcurrent) {
    activeSlots += 1
    return Promise.resolve(makeRelease())
  }
  return new Promise<() => void>((resolve, reject) => {
    const entry = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const idx = waitQueue.indexOf(entry)
        if (idx >= 0) waitQueue.splice(idx, 1)
        reject(new Error('主机访客并发已满，请稍后再试'))
      }, waitMs),
    }
    waitQueue.push(entry)
  })
}

function makeRelease(): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    const next = waitQueue.shift()
    if (next) {
      clearTimeout(next.timer)
      // 额度直接转交（不经过 activeSlots 归零，避免竞态）
      next.resolve(makeRelease())
      return
    }
    activeSlots = Math.max(0, activeSlots - 1)
  }
}

/** 当前并发占用（设置页/诊断展示用） */
export function lanSlotInfo(): { active: number; waiting: number; max: number } {
  return { active: activeSlots, waiting: waitQueue.length, max: maxConcurrent }
}

// ---------------------------------------------------------------------------
// 访客智能体会话（P4）
// ---------------------------------------------------------------------------

const PENDING_EVENT_CAP = 4000
const IDLE_DISPOSE_MS = 30 * 60 * 1000
const SESSION_CAP_PER_IP = 6
const MAX_BODY_BYTES = 24 * 1024 * 1024

interface GuestAgentSession {
  id: string
  remote: string
  /** 会话语言（host 侧提示词语言 + 技能指令语言） */
  locale: 'zh' | 'en'
  createdAt: number
  lastActive: number
  /** 已挂上的 SSE 响应（同一会话可多端订阅，如刷新页面后的新连接） */
  sse: Set<ServerResponse>
  /** 尚无 SSE 消费方时的事件缓冲（避免 create → events 之间的流式内容丢失） */
  pending: AgentEvent[]
  releaseSlot: (() => void) | null
}

const sessions = new Map<string, GuestAgentSession>()

function remoteOf(req: IncomingMessage): string {
  return String((req.socket as any)?.remoteAddress || '')
}

/** 访客工作区根：优先主机共享目录；未设时退到 userData 下的访客沙箱目录 */
function guestWorkspaceRoot(): string {
  if (shareDir && fs.existsSync(shareDir)) return shareDir
  const dir = path.join(app.getPath('userData'), 'lan-guest-workspace')
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* 创建失败则退到 userData */ }
  return dir
}

/** 共享目录里的知识库（供访客 kb_search 使用；上限 20 个） */
function sharedKbPaths(): string[] {
  if (!shareDir || !fs.existsSync(shareDir)) return []
  try {
    return fs.readdirSync(shareDir)
      .filter((n) => n.toLowerCase().endsWith('.kb'))
      .slice(0, 20)
      .map((n) => path.join(shareDir, n))
  } catch {
    return []
  }
}

/** 访客会话的生效工具清单（策略白名单 ∩ 注册表实际存在的工具） */
function guestToolDefs(): Array<{ name: string; description: string }> {
  const allow = new Set(effectiveGuestTools(policy))
  return toolRegistry.list()
    .filter((d) => allow.has(String(d.name)))
    .map((d) => ({ name: String(d.name), description: d.description }))
}

/** 主机可对访客开放的技能（仅当 skill 工具在白名单里） */
function guestSkills(): Array<{ name: string; description: string }> {
  if (!effectiveGuestTools(policy).includes('skill')) return []
  try {
    return skillService.list().map((c) => ({ name: c.name, description: c.description }))
  } catch {
    return []
  }
}

/** 组装访客智能体的系统提示（主机侧生成，访客无法注入自己的系统提示） */
function buildGuestSystemPrompt(opts: {
  locale: string
  tools: Array<{ name: string; description: string }>
  cwd: string
  kbPaths: string[]
  skill?: { name: string; description: string; content: string; dir: string } | null
}): string {
  const zh = opts.locale !== 'en'
  const toolLines = opts.tools.map((t) => `- \`${t.name}\`：${t.description}`).join('\n')
  const kbNames = opts.kbPaths.map((p) => path.basename(p)).join(zh ? '、' : ', ')
  const head = zh
    ? [
        '你是运行在主机 AI-KM 桌面端上的「局域网访客助手」，通过网页为局域网内的用户提供服务。',
        '',
        '## 运行环境',
        `- 工作区根目录：${opts.cwd}（工具的相对路径以此为准，越界路径会被拒绝）`,
        `- 共享知识库：${kbNames || '无'}`,
        `- 回答语言：中文`,
        '',
        '## 可用工具（仅这些，其它工具一律不可用，调用会被拒绝）',
        toolLines || '- （本次未开放任何工具，请直接依据自身知识作答）',
        '',
        '## 工作方式',
        '1. 需要事实依据时先调用工具（文件内容用 read_file / list_dir / search_files，资料用 kb_search / web_search / web_fetch），不要臆测。',
        '2. 每次工具调用后依据结果继续，直到足以给出完整答案；不要重复调用没有带来新信息的工具。',
        '3. 最终给出结论式回答，必要时说明依据（文件名或链接）。',
        '4. 若工具未开放或执行失败，如实说明限制，改用现有能力作答。',
      ].join('\n')
    : [
        'You are the LAN guest assistant running inside the host AI-KM desktop app, serving LAN users over the web.',
        '',
        '## Environment',
        `- Workspace root: ${opts.cwd} (tool relative paths resolve here; escaping paths are rejected)`,
        `- Shared knowledge bases: ${kbNames || 'none'}`,
        `- Answer language: English`,
        '',
        '## Available tools (only these; anything else is rejected)',
        toolLines || '- (No tools granted; answer from your own knowledge)',
        '',
        '## How to work',
        '1. Call tools before guessing (read_file / list_dir / search_files for files; kb_search / web_search / web_fetch for facts).',
        '2. Continue after each call until you can answer fully; do not repeat calls that bring no new information.',
        '3. Finish with a conclusive answer and cite the evidence (file name or link).',
        '4. If a tool is not granted or fails, state the limitation and answer with what you have.',
      ].join('\n')
  if (!opts.skill) return head
  return head + '\n' + skillBlockText(opts.skill, zh)
}

/** 技能指令块（系统提示内联 / 运行中经 inject 注入，两种入口共用同一格式） */
function skillBlockText(
  s: { name: string; description: string; content: string; dir: string },
  zh: boolean,
): string {
  return zh
    ? [
        '## 本次任务使用技能',
        `- 技能名：${s.name}`,
        `- 技能说明：${s.description}`,
        `- 技能资源目录：${s.dir}`,
        '',
        '### 技能指令（必须严格遵循）',
        s.content,
      ].join('\n')
    : [
        '## Skill in use',
        `- Name: ${s.name}`,
        `- Description: ${s.description}`,
        `- Skill resources dir: ${s.dir}`,
        '',
        '### Skill instructions (follow strictly)',
        s.content,
      ].join('\n')
}

/** 从 `$技能名 任务…` 提取技能名（与桌面端 parseSkillIntent 的写法一致） */
function parseSkillTrigger(text: string): { name: string; rest: string } | null {
  const m = /^\s*\$\s*([^\s$]{1,64})\s*([\s\S]*)$/.exec(String(text || ''))
  if (!m) return null
  return { name: m[1], rest: (m[2] || '').trim() }
}

/** 会话种子历史（访客自己的聊天记录，用于多轮衔接；限长防滥用） */
function normalizeSeed(raw: unknown): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const m of raw.slice(-40)) {
    const role = (m as any)?.role
    const content = String((m as any)?.content ?? '')
    if ((role === 'user' || role === 'assistant') && content) {
      out.push({ role, content: content.slice(0, 8000) })
    }
  }
  return out
}

/** 解析技能候选为可内联的提示块（技能已并入智能体：$技能名 或首轮指定） */
function resolveGuestSkill(name: unknown): { name: string; description: string; content: string; dir: string } | null {
  const key = String(name || '').trim()
  if (!key) return null
  const cand = skillService.get(key)
  if (!cand) return null
  return {
    name: cand.name,
    description: cand.description || '',
    content: cand.preview?.content || '',
    dir: path.dirname(cand.path),
  }
}

/**
 * 创建访客智能体会话（**先建空会话、不发送任务**）。
 * 发送由 `/api/agent/send` 触发，与桌面端 agentBridge 的 create → send 流程一致；
 * 系统提示 / 工具白名单 / 工作区 / 轮数上限 / 沙箱全部由主机在此决定。
 */
function createGuestSession(opts: {
  req: IncomingMessage
  locale: 'zh' | 'en'
  images: string[]
  seedHistory?: unknown
  /** 访客选择的智能体（'general'/空 = 通用智能体；其余需在已推送的档案中） */
  agentId?: string
}): GuestAgentSession {
  if (!hostLlm) throw new Error('主机尚未配置用于访客的模型（请在设置 → 协作 → 权限打开本页一次即可同步）')
  const remote = remoteOf(opts.req)
  // 同一设备的旧会话（已结束且无订阅）先清掉，避免累积
  for (const s of Array.from(sessions.values())) {
    if (s.remote !== remote) continue
    if (s.sse.size === 0 && agentLoop.getAgent(s.id)?.status !== 'running') closeGuestSession(s, 'superseded')
  }
  const mine = Array.from(sessions.values()).filter((s) => s.remote === remote)
  if (mine.length >= SESSION_CAP_PER_IP) {
    throw new Error('同一设备的会话数已达上限，请先结束旧会话')
  }

  // 访客选定的智能体档案（'general'/空 = 通用智能体；两者都用渲染层下发的档案）
  const agentKey = String(opts.agentId || '').trim()
  const wantedId = agentKey && agentKey !== LAN_GUEST_GENERAL_AGENT ? agentKey : LAN_GUEST_GENERAL_AGENT
  const profile = hostAgents.find((a) => a.id === wantedId)
  if (agentKey && agentKey !== LAN_GUEST_GENERAL_AGENT && !profile) {
    throw new Error('该智能体未对访客开放（请在主机「协作 → 权限」中勾选）')
  }

  const allDefs = guestToolDefs()
  const guestTools = allDefs.map((d) => d.name)
  // 工具：档案工具 ∩ 访客白名单（档案已在渲染层取过一次交集，这里再兜一层——防御纵深）
  const profileTools = Array.isArray(profile?.options?.tools) ? (profile!.options.tools as string[]) : []
  const tools = profile ? profileTools.filter((t) => guestTools.includes(t)) : guestTools
  // 知识库：档案关联的 .kb（主机已授权该智能体）+ 共享目录里的 .kb
  const presetKb = Array.isArray(profile?.options?.kbPaths) ? (profile!.options.kbPaths as string[]) : []
  const kbPaths = Array.from(new Set([...presetKb, ...sharedKbPaths()]))
  const cwd = guestWorkspaceRoot()
  /**
   * 系统提示词：**直接使用主机下发的档案提示词**（与客户端同一套 `assembleAgentSystemPrompt`
   * 组装结果），不再另行拼接访客前言——否则人格 / 工作方式与客户端不一致（用户可见差异）。
   * 仅在档案缺失（旧推送 / 尚未同步）时回退到主机构造的通用提示，保证仍可用。
   */
  const systemPrompt = String(profile?.options?.systemPrompt || '').trim()
    || buildGuestSystemPrompt({
      locale: opts.locale,
      tools: tools.map((name) => ({ name, description: allDefs.find((d) => d.name === name)?.description || '' })),
      cwd,
      kbPaths,
      skill: null,
    })
  // 步数：使用该智能体自身的循环轮数（与客户端一致）；通用智能体取权限页配置
  const maxSteps = profile && typeof profile.options.maxSteps === 'number'
    ? Math.max(1, Math.round(profile.options.maxSteps))
    : policy.maxSteps

  const options: AgentOptions = {
    systemPrompt,
    provider: hostLlm.provider,
    config: hostLlm.config,
    llmConfig: { ...(hostLlm.llmConfig || {}), stream: true },
    // 只读默认集 / 主机勾选的白名单（**绝不是 null**：null = 全部工具）
    tools,
    cwd,
    kbPaths,
    ...(typeof profile?.options?.kbTopK === 'number' ? { kbTopK: profile.options.kbTopK } : {}),
    // MCP：预设选中的服务（mcp_call 工具读取）；服务配置来自主机，不外泄给网页端
    ...(Array.isArray(profile?.options?.mcpServerIds) ? { mcpServerIds: profile!.options.mcpServerIds as string[] } : {}),
    ...(Array.isArray(profile?.options?.mcpServerConfigs) ? { mcpServerConfigs: profile!.options.mcpServerConfigs } : {}),
    ...(profile?.options?.mcpEquipmentIds ? { mcpEquipmentIds: profile.options.mcpEquipmentIds } : {}),
    label: profile ? `lan-guest ${profile.name}` : `lan-guest ${remote}`,
    // 轮数上限与沙箱由主机策略决定（访客无法放宽）
    maxSteps,
    sandboxMode: policy.sandbox,
    // 上下文窗口上限：由主机渲染层解析后随策略推来（缺省时 agent-loop 回退 128K）
    ...(hostLlm.contextLimit ? { contextLimit: hostLlm.contextLimit } : {}),
    // 上下文自动压缩始终开启（访客无法关闭；长会话不因超限中断）
    contextCompact: true,
    ...(opts.images.length ? { taskImages: opts.images.slice(0, 4) } : {}),
    ...(() => {
      const seed = normalizeSeed(opts.seedHistory)
      return seed.length ? { seedHistory: seed } : {}
    })(),
  }

  const agent = agentLoop.createAgent(options)
  const id = String(agent.id)
  const session: GuestAgentSession = {
    id,
    remote,
    locale: opts.locale,
    createdAt: Date.now(),
    lastActive: Date.now(),
    sse: new Set(),
    pending: [],
    releaseSlot: null,
  }
  sessions.set(id, session)
  return session
}

/** 关闭会话：释放并发额度 + 断开 SSE + 销毁主机 agent */
function closeGuestSession(session: GuestAgentSession, cause: string): void {
  releaseSessionSlot(session)
  for (const res of session.sse) {
    try { res.end() } catch { /* 已断开 */ }
  }
  session.sse.clear()
  sessions.delete(session.id)
  void agentLoop.disposeAgent(session.id).catch(() => {})
  void cause
}

function releaseSessionSlot(session: GuestAgentSession): void {
  if (session.releaseSlot) {
    session.releaseSlot()
    session.releaseSlot = null
  }
}

/** 申请并发额度并挂到会话上（同一会话同时只持有一个额度） */
async function holdSessionSlot(session: GuestAgentSession, waitMs = 60_000): Promise<void> {
  if (session.releaseSlot) return
  session.releaseSlot = await acquireLanSlot(waitMs)
}

// 事件分发：把该会话的事件转发给 SSE 订阅者（未连接时缓冲）
agentLoop.subscribeAgentEvents((ev) => {
  const session = sessions.get(String(ev.agentId))
  if (!session) return
  session.lastActive = Date.now()
  if (ev.type === 'agent/status') {
    const status = (ev.payload as { status?: string }).status
    // 收敛即释放并发额度（额度 = 同时正在跑的访客任务数；异常状态一并释放，防额度被卡死）
    if (status === 'idle' || status === 'disposed' || status === 'error') releaseSessionSlot(session)
  }
  if (session.sse.size === 0) {
    if (session.pending.length < PENDING_EVENT_CAP) session.pending.push(ev)
    return
  }
  for (const res of session.sse) writeSse(res, ev)
})

/** 写一条 SSE 事件（失败即忽略：客户端可能已断开） */
function writeSse(res: ServerResponse, ev: AgentEvent | { type: string; payload?: any }): void {
  try {
    res.write(`data: ${JSON.stringify(ev)}\n\n`)
  } catch {
    /* 连接已断开，由 close 事件清理 */
  }
}

// 心跳 + 空闲回收（全局定时器，随服务器生命周期存在）
const heartbeatTimer = setInterval(() => {
  for (const session of sessions.values()) {
    for (const res of session.sse) {
      try { res.write(': ping\n\n') } catch { /* ignore */ }
    }
  }
}, 15_000)
heartbeatTimer.unref?.()

const reapTimer = setInterval(() => {
  const now = Date.now()
  for (const session of Array.from(sessions.values())) {
    if (session.sse.size > 0) continue
    if (now - session.lastActive < IDLE_DISPOSE_MS) continue
    closeGuestSession(session, 'idle-timeout')
  }
}, 60_000)
reapTimer.unref?.()

/** 停止共享服务时销毁全部访客会话（防悬空 agent / 挂起 SSE） */
export function disposeAllLanGuestSessions(): void {
  for (const session of Array.from(sessions.values())) closeGuestSession(session, 'server-stop')
}

/** 访客接口能力概览（网页端据此渲染可用性提示） */
export function lanGuestInfo() {
  const tools = guestToolDefs()
  return {
    ok: true,
    agent: lanGuestModeAllowed(policy, 'agent'),
    modes: policy.modes,
    tools,
    skills: guestSkills(),
    maxSteps: policy.maxSteps,
    sandbox: policy.sandbox,
    /** 访客对主机共享目录的文件访问档位（off / read / write） */
    fs: policy.guestFs,
    shareKb: sharedKbPaths().map((p) => path.basename(p)),
    // 访客可选的智能体：以渲染层下发的档案为准（含 general），
    // 档案里没有 general 时才补一个内置通用智能体；按 id 去重（历史曾重复列出两个「通用智能体」）
    agents: (() => {
      const seen = new Set<string>()
      const list: Array<{ id: string; name: string; desc: string }> = []
      const hasGeneral = hostAgents.some((a) => a.id === LAN_GUEST_GENERAL_AGENT)
      if (!hasGeneral) list.push({ id: LAN_GUEST_GENERAL_AGENT, name: '通用智能体', desc: '自主规划，工具按访客白名单' })
      for (const a of hostAgents) {
        if (seen.has(a.id)) continue
        seen.add(a.id)
        list.push({ id: a.id, name: a.name, desc: a.desc || '' })
      }
      return list
    })(),
    concurrency: lanSlotInfo(),
    tokenRequired: policy.requireToken,
    // 主机实际兑给访客会话的模型（设置页用来确认配置已生效）
    provider: hostLlm?.provider || '',
    model: String(hostLlm?.config?.model || ''),
  }
}

// ---------------------------------------------------------------------------
// HTTP 端点（由 main/index.ts 的 LAN 服务器路由进来）
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: any): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  // 访客端每次都取最新（策略/智能体清单随时可能被主机改动，不能让浏览器缓存旧结果）
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const buf = await readBody(req)
  if (!buf.length) return {}
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/** 取会话并校验归属（防越权操作他人会话） */
function ownSession(id: string, remote: string): GuestAgentSession | null {
  const session = sessions.get(String(id || ''))
  if (!session) return null
  if (session.remote !== remote) return null
  session.lastActive = Date.now()
  return session
}

/**
 * 处理 `/api/agent/*`。返回 true = 已处理（调用方不要再走静态站回退）。
 * 路由：
 *   GET  /api/agent/info                  能力概览（工具/技能/上限）
 *   POST /api/agent/create                { content, images?, locale? } → { id }
 *   POST /api/agent/send|steer|inject     { id, content }
 *   POST /api/agent/cancel|dispose        { id, cause? }
 *   POST /api/agent/answer                { id, askId, message }
 *   GET  /api/agent/events?id=            SSE（agent 事件流，原样转发）
 *   GET  /api/agent/state?id= / /api/agent/list
 */
export async function handleLanAgentApi(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
): Promise<boolean> {
  const prefix = '/api/agent'
  if (!urlPath.startsWith(prefix)) return false
  // ⚠️ urlPath 可能带查询串（/api/agent/events?id=…）：先剥掉再匹配路由，
  // 否则 `/events?id=…` 匹配不上 `/events`，会落到 404 兜底（网页端事件流连不上）。
  const pathOnly = urlPath.includes('?') ? urlPath.substring(0, urlPath.indexOf('?')) : urlPath
  const route = pathOnly.substring(prefix.length).replace(/\/+$/, '') || '/'

  const denied = lanGuestDenied(req)
  if (denied) {
    sendJson(res, denied.status, denied.body)
    return true
  }

  const remote = remoteOf(req)
  const json = (status: number, body: any) => sendJson(res, status, body)
  const fail = (status: number, message: string) => json(status, { ok: false, error: message })

  try {
    // ---------------- 能力概览 ----------------
    if (route === '/info' || route === '') {
      // 先向渲染层拉一次最新策略（主机刚改过「可用智能体 / 模式 / 模型」时，
      // 网页端点开列表就能看到最新清单，无需刷新页面）
      await refreshPolicyFromRenderer()
      json(200, lanGuestInfo())
      return true
    }

    // ---------------- 创建会话（空会话，任务由 /send 下发） ----------------
    if (route === '/create') {
      if (req.method !== 'POST') { fail(405, '仅支持 POST'); return true }
      if (!lanGuestModeAllowed(policy, 'agent')) {
        fail(403, '主机未开放「智能体」模式（设置 → 协作 → 权限）')
        return true
      }
      const body = await readJsonBody(req)
      const images = Array.isArray(body?.images)
        ? body.images.filter((x: any) => typeof x === 'string' && x.startsWith('data:')).slice(0, 4)
        : []
      try {
        const session = createGuestSession({
          req,
          locale: body?.locale === 'en' ? 'en' : 'zh',
          images,
          seedHistory: body?.seedHistory,
          agentId: body?.agentId,
        })
        json(200, { ok: true, id: session.id })
      } catch (e: any) {
        fail(400, e?.message || '创建会话失败')
      }
      return true
    }

    // ---------------- 事件流（SSE） ----------------
    if (route === '/events') {
      const id = queryOf(req.url || '', 'id')
      const session = ownSession(id, remote)
      if (!session) { fail(404, '会话不存在或不属于本设备'); return true }
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache, no-transform')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
      res.write('retry: 3000\n\n')
      // 先补发连接建立前缓冲的事件（避免 create 之后的首段流式内容丢失）
      if (session.pending.length) {
        for (const ev of session.pending) writeSse(res, ev)
        session.pending = []
      }
      // 告知网页端会话当前状态（网页端刷新后据此恢复运行中标记）
      const agent = agentLoop.getAgent(session.id)
      writeSse(res, { type: 'lan/session', payload: { id: session.id, status: agent?.status || 'disposed' } })
      session.sse.add(res)
      const cleanup = () => { session.sse.delete(res) }
      req.on('close', cleanup)
      req.on('error', cleanup)
      return true
    }

    // ---------------- 其余接口（POST：控制；GET：查询） ----------------
    if (req.method === 'POST') {
      const body = await readJsonBody(req)
      const session = ownSession(body?.id, remote)
      if (!session) { fail(404, '会话不存在或不属于本设备'); return true }
      const agent = agentLoop.getAgent(session.id)
      if (!agent) { fail(404, '会话已结束'); return true }
      if (route === '/send') {
        let content = String(body?.content || '').trim()
        if (!content) { fail(400, '缺少 content'); return true }
        // 技能触发（技能已并入智能体）：$技能名 → 把技能指令注入到下一步模型上下文
        const trigger = effectiveGuestTools(policy).includes('skill') ? parseSkillTrigger(content) : null
        const skill = trigger ? resolveGuestSkill(trigger.name) : null
        if (skill) {
          agent.inject(skillBlockText(skill, session.locale === 'en' ? false : true))
          if (trigger?.rest) content = trigger.rest
        }
        try {
          await holdSessionSlot(session, 15_000)
        } catch (e: any) {
          fail(429, e?.message || '主机并发已满')
          return true
        }
        agent.send(content.slice(0, 32_000), 'lan-guest')
        json(200, { ok: true, skill: skill?.name || '' })
        return true
      }
      if (route === '/steer') {
        const content = String(body?.content || '').trim()
        if (!content) { fail(400, '缺少 content'); return true }
        if (agent.status !== 'running') { json(200, { ok: true, accepted: false }); return true }
        agent.steer(content.slice(0, 32_000))
        json(200, { ok: true, accepted: true })
        return true
      }
      if (route === '/inject') {
        agent.inject(String(body?.content || '').slice(0, 32_000))
        json(200, { ok: true })
        return true
      }
      if (route === '/cancel') {
        agent.cancel(String(body?.cause || 'user'), { keepInbox: !!body?.keepInbox })
        json(200, { ok: true })
        return true
      }
      if (route === '/answer') {
        const askId = String(body?.askId || '')
        if (!askId) { fail(400, '缺少 askId'); return true }
        const ok = agentLoop.resolveAnswer(session.id, askId, String(body?.message ?? ''))
        if (!ok) { fail(404, '未找到待回答的问题'); return true }
        json(200, { ok: true })
        return true
      }
      if (route === '/dispose') {
        closeGuestSession(session, 'user')
        json(200, { ok: true })
        return true
      }
      fail(404, `未知接口: ${route}`)
      return true
    }

    if (route === '/state') {
      const id = queryOf(req.url || '', 'id')
      const session = ownSession(id, remote)
      if (!session) { fail(404, '会话不存在或不属于本设备'); return true }
      const state = agentLoop.getAgentState(session.id)
      if (!state) { fail(404, '会话已结束'); return true }
      json(200, { ok: true, state })
      return true
    }
    if (route === '/list') {
      const list = Array.from(sessions.values())
        .filter((s) => s.remote === remote)
        .map((s) => ({
          id: s.id,
          status: agentLoop.getAgent(s.id)?.status || 'disposed',
          label: `lan-guest ${s.remote}`,
          pendingInbox: 0,
        }))
      json(200, { ok: true, list })
      return true
    }

    fail(404, `未知接口: ${route}`)
    return true
  } catch (e: any) {
    console.error('[lan-guest] 接口异常:', e?.message || e)
    if (!res.headersSent) fail(500, e?.message || '服务器内部错误')
    else { try { res.end() } catch { /* ignore */ } }
    return true
  }
}
