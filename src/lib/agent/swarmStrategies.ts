/**
 * swarmStrategies.ts — 集群执行策略注册表
 *
 * 模式即策略键：
 * - auto（默认，群聊协作）：发送任务时不带 @ 符号 → 把任务广播给群内所有成员并行作答，
 *   全部完成后由「群主」做最终总结（默认使用中立 LLM；若预案曾指定某 Agent 为群主则用其设定）；
 *   发送时带 @（发送层 runNamedTask 拦截）→ 只唤起被点名成员，单点不总结。
 * - task  原语模式：按 settings.taskMode 分派 graphflow / debate / broadcast / sequential
 *
 * 协作约定（无管理器 / 无结构化黑板与事件协议）：
 * - 成员想共享的信息直接写在正文里，通过「群聊历史注入」（historySection 跨任务前文）
 *   与任务内上下文累积（ctxText）自然传给后续成员/群主，由模型自行判断要不要共享。
 */

import type { SwarmAgent, SwarmAgentRunState, SwarmRunMode } from '@/types/swarm'
import { summonedMembers } from '@/store/swarmState'

// ---------------------------------------------------------------------------
// 运行时上下文（由 swarmRunner 注入）
// ---------------------------------------------------------------------------

export interface AgentRunOpts {
  round?: number
  stage?: string
  role?: 'manager' | 'worker'
  ragContext?: string
  /** 群主总结：使用默认 LLM + 中立 system prompt，不携带 Agent 的角色设定 */
  generic?: boolean
}

export interface SwarmRuntimeContext {
  task: string
  selectedIndices: number[]
  mode: SwarmRunMode
  debateRounds: number
  settings: Record<string, any>
  /** 参与 Agent 列表（按原始下标索引） */
  agentsOf: SwarmAgent[]
  /** 群聊历史（对话消息：当前任务的成员汇报与历史轮次，供参考前文；settings.injectHistory !== false 时注入） */
  historyMessages: any[]
  /** 跨任务群聊历史（已并入对话消息，保留字段兼容旧调用） */
  chatHistory: any[]
  /** 系统语言（'zh' | 'en'），提示词按语言注入 */
  locale: string
  /** 追加输出消息 */
  addOutput(agent: string, name: string, content: string): void
  /** 更新 Agent 运行状态 */
  setAgentState(idx: number, patch: Partial<SwarmAgentRunState>): void
  /** 执行单个 Agent（统一 agent 循环） */
  runAgent(idx: number, prompt: string, opts?: AgentRunOpts): Promise<string>
  /** 知识库检索 */
  retrieveKnowledge(agent: SwarmAgent, query: string, kbFilter?: string): Promise<string>
}

export interface SwarmStrategy {
  type: string
  label: string
  description: string
  run(ctx: SwarmRuntimeContext): Promise<void>
  onRoundStart?(ctx: SwarmRuntimeContext): Promise<void>
  onRoundEnd?(ctx: SwarmRuntimeContext): Promise<void>
  shouldContinue?(ctx: SwarmRuntimeContext): boolean
  conclude?(ctx: SwarmRuntimeContext): Promise<string>
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

const roleHint = (role?: string): string => {
  const r = (role || '').trim()
  return r ? `以你的角色（${r}）` : ''
}

function buildTaskContext(task: string): string {
  return `## 任务\n${task}\n`
}

function ctxAgentName(ctx: SwarmRuntimeContext, idx: number): string {
  return ctx.agentsOf?.[idx]?.name || `A${idx + 1}`
}
function ctxAgentRole(ctx: SwarmRuntimeContext, idx: number): string {
  return ctx.agentsOf?.[idx]?.role || ''
}

/** 群聊历史注入段（对话消息中的成员汇报，最近 N 条；settings.injectHistory=false 时关闭） */
function historySection(ctx: SwarmRuntimeContext, max = 10): string {
  if (ctx.settings?.injectHistory === false) return ''
  const zh = ctx.locale !== 'en'
  const pool = [...(ctx.chatHistory || []), ...(ctx.historyMessages || [])] as any[]
  const lines = pool
    // 只取成员汇报（assistant + swarmAgent.idx>=0）：用户消息与群主/系统消息不入前文
    .filter((m: any) => m && m.content && m.role === 'assistant' && (m.swarmAgent?.idx ?? -1) >= 0)
    .slice(-max)
    .map((m: any) => `- ${m.swarmAgent?.name || 'Agent'}：${String(m.content).replace(/\s+/g, ' ').trim().slice(0, 400)}`)
  return lines.length
    ? `${zh ? '## 群聊进展（此前群聊与成员汇报，供参考，避免重复劳动）' : '## Prior chat progress (for reference, avoid repeating work)'}\n${lines.join('\n')}\n`
    : ''
}

/** 拼接成员执行提示：尽量精简——以用户原话为主，只加少量中性引导（避免弱模型被“群聊规则”带偏成反问） */
function buildMemberPrompt(ctx: SwarmRuntimeContext, idx: number, taskBody: string, opts?: { noMention?: boolean; relay?: boolean }): string {
  const hist = historySection(ctx, 6)
  const a = ctx.agentsOf?.[idx]
  const others = ctx.agentsOf.map(x => (x.name || '').trim()).filter(n => n && n !== (a?.name || ''))
  const zh = ctx.locale !== 'en'
  const guide = zh
    ? '请直接处理上面内容。若用户在询问事实/数据（如数量、状态），请先用你的工具（如 MCP 查询真实状态）获取后如实回答。'
    : 'Handle the above directly. If the user asks for facts/data (counts, status…), query real data with your tools (e.g. MCP).'
  const relayNote = opts?.relay
    ? (zh ? '可参考前面成员的发言做补充或回应。' : 'You may build on or reply to earlier members.')
    : ''
  const mentionHint = !opts?.noMention && others.length
    ? (zh ? `需要某位同事时用 @成员名（如 @${others[0]}：…）。` : `Need a teammate? Use @member-name, e.g. @${others[0]}: …`)
    : ''
  return [hist, taskBody, guide, relayNote, roleHint(ctxAgentRole(ctx, idx)), mentionHint].filter(Boolean).join('\n')
}

// ---------------------------------------------------------------------------
// task 策略：按 settings.taskMode 分派
// ---------------------------------------------------------------------------

/** 图谱流程：按边拓扑排序，沿边传递上下文 */
/** 原「图谱流程 / 顺序执行」已随关系图谱一并移除（集群保留：全员响应 / 群主撮合 / 辩论） */

/**
 * 群主总结（原“通用管理器”去调度化后只保留的中立总结角色）：
 * - 默认 = 中立 LLM（通用 system prompt，不携带任何 Agent 角色设定）；
 * - 若预案中指定了某 Agent 为群主（settings.managerAgentIdx >= 0 且团队中存在），
 *   则用该 Agent 的完整设定（角色 / 系统提示 / 能力 / 模型 / 工具）来担任群主总结。
 */
async function runHost(ctx: SwarmRuntimeContext, prompt: string, stage = '总结'): Promise<string> {
  const managerIdx = Number(ctx.settings?.managerAgentIdx)
  const useAgentAsHost = Number.isInteger(managerIdx) && managerIdx >= 0 && managerIdx < ctx.agentsOf.length
  const idx = useAgentAsHost ? managerIdx : (ctx.selectedIndices[0] ?? 0)
  if (!ctx.agentsOf[idx]) return ''
  if (useAgentAsHost) {
    return ctx.runAgent(idx, prompt, { stage, role: 'manager' })
  }
  return ctx.runAgent(idx, `请以群主身份，公正、中立地总结（不要以特定角色发言）：\n\n${prompt}`, { stage, role: 'manager', generic: true })
}

/** 辩论模式 */
async function runDebate(ctx: SwarmRuntimeContext) {
  const rounds = ctx.debateRounds || 3
  let ctxText = buildTaskContext(ctx.task)
  const selIndices = ctx.selectedIndices
  for (let r = 1; r <= rounds; r++) {
    ctx.addOutput('system', `辩论 R${r}`, `--- 第 ${r} 轮 ---`)
    for (let i = 0; i < selIndices.length; i++) {
      const idx = selIndices[i]
      const p = r === 1 ? `${historySection(ctx)}## 任务\n${ctx.task}\n\n${roleHint(ctxAgentRole(ctx, idx))}分析。` : `${ctxText}\n\n根据讨论，以你的角色提出新见解。`
      const r2 = await ctx.runAgent(idx, p, { round: r, stage: `${r} 轮` })
      ctxText += `\n### ${ctxAgentName(ctx, idx)} (R${r})\n${r2}\n`
    }
  }
  // 群主中立总结
  ctx.addOutput('system', '总结', '⚖️ 正在以中立视角总结所有 Agent 的发言...')
  const sumPrompt = `请以公正、中立的评审视角，综合以下所有 Agent 的发言，输出最终总结：\n1. 各方主要观点\n2. 共识与分歧\n3. 综合评估与最终结论\n\n## 原始任务\n${ctx.task}\n\n## 全部发言记录（各 Agent 多轮辩论）\n${ctxText}`
  await runHost(ctx, sumPrompt, '总结')
  ctx.addOutput('system', '结论', '辩论结束。')
}

/** 宽松点名解析：成员回复中出现的 @成员名（行首或行内）都视为点名；
 *  请求取 @ 后紧跟的文本（@名：xxx 取冒号/逗号后；否则取到该段结束，最多 400 字）。 */
function parseMentions(text: string, agentsOf: SwarmAgent[], by?: string): Array<{ idx: number; task: string; by?: string }> {
  const out: Array<{ idx: number; task: string; by?: string }> = []
  if (!text) return out
  const names = agentsOf.map(a => (a.name || '').trim()).filter(Boolean).sort((a, b) => b.length - a.length)
  for (const name of names) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`@${esc}(?![\\w\\u4e00-\\u9fa5])`, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const idx = agentsOf.findIndex(x => (x.name || '').trim() === name)
      if (idx < 0) continue
      const after = text.slice(m.index + m[0].length).replace(/^\s*[:：,，、]\s*/, '')
      const task = after.split(/\n\s*\n/)[0].trim().slice(0, 400)
      if (task) out.push({ idx, task, by })
    }
  }
  return out
}

/** 自动 · 仅发言：每人就任务发言一轮，无点名、无二轮 */
async function runPlain(ctx: SwarmRuntimeContext) {
  ctx.selectedIndices.forEach(idx => ctx.setAgentState(idx, { status: 'pending', stage: '等待发言' }))
  for (const idx of ctx.selectedIndices) {
    await ctx.runAgent(idx, buildMemberPrompt(ctx, idx, `## 任务\n${ctx.task}\n`, { noMention: true }))
  }
}

/** 自动 · 点名 / 接力：第一轮全员依次作答（relay 时侧重参考前文、接力补充），
 *  第二轮补跑被 @ 的成员（宽松识别；同一人仅补一次） */
async function runMention(ctx: SwarmRuntimeContext, relay = false) {
  ctx.selectedIndices.forEach(idx => ctx.setAgentState(idx, { status: 'pending', stage: '等待发言' }))
  const mentionMap = new Map<number, { task: string; by: string }>()
  for (const idx of ctx.selectedIndices) {
    const out = await ctx.runAgent(idx, buildMemberPrompt(ctx, idx, `## 任务\n${ctx.task}\n`, { relay }))
    const me = ctxAgentName(ctx, idx)
    for (const m of parseMentions(out, ctx.agentsOf, me)) {
      mentionMap.set(m.idx, { task: m.task, by: m.by || me })
    }
  }
  for (const [idx, req] of mentionMap) {
    if (summonedMembers.value.includes(idx)) continue
    summonedMembers.value.push(idx)
    ctx.setAgentState(idx, { status: 'pending', stage: '回应点名' })
    const taskBody = `## 协作请求（由 ${req.by} 点名）\n${req.task}`
    await ctx.runAgent(idx, buildMemberPrompt(ctx, idx, taskBody, { noMention: true }))
  }
}

/** 汇总群聊中的成员汇报（assistant 消息且来自成员）为文本段 */
function memberPosts(ctx: SwarmRuntimeContext): string {
  return (ctx.historyMessages || [])
    .filter((m: any) => m && m.content && m.role === 'assistant' && (m.swarmAgent?.idx ?? -1) >= 0)
    .map((m: any) => `### ${m.swarmAgent?.name || 'Agent'}\n${m.content}`)
    .join('\n\n')
}

/** 自动 · 撮合：全员先发言一轮，随后由群主串场点名撮合（最多 HOST_MERGE_ROUNDS 轮），成员无需写 @ 也能被点名 */
async function runHostCollab(ctx: SwarmRuntimeContext) {
  const zh = ctx.locale !== 'en'
  ctx.selectedIndices.forEach(idx => ctx.setAgentState(idx, { status: 'pending', stage: '等待发言' }))
  for (const idx of ctx.selectedIndices) {
    await ctx.runAgent(idx, buildMemberPrompt(ctx, idx, `## 任务\n${ctx.task}\n`, { noMention: true }))
  }
  const HOST_MERGE_ROUNDS = 2
  for (let r = 1; r <= HOST_MERGE_ROUNDS; r++) {
    const hostPrompt = [
      `## 总体目标`,
      ctx.task,
      ``,
      `## 目前的群聊发言`,
      memberPosts(ctx) || (zh ? '（暂无成员发言）' : '(no posts yet)'),
      ``,
      zh
        ? '你是群主。请撮合讨论：若有成员的观点需要另一位成员直接回应、补充或反驳，请输出一行 @<成员名>：<希望它回应的问题>（只能 @ 已在群中的成员）；如果已经不需要补充，请直接输出：无需补充。'
        : 'You are the host. If a view needs another member to respond/elaborate/rebut, output a line like @<member>: <question> (only mention existing members); otherwise output: no more needed.',
    ].join('\n')
    const out = await runHost(ctx, hostPrompt, `撮合 ${r}`)
    const assigns = parseMentions(out, ctx.agentsOf, zh ? '群主' : 'Host')
    if (!assigns.length) break
    for (const m of assigns) {
      if (summonedMembers.value.includes(m.idx)) continue
      summonedMembers.value.push(m.idx)
      ctx.setAgentState(m.idx, { status: 'pending', stage: '回应撮合' })
      await ctx.runAgent(m.idx, buildMemberPrompt(ctx, m.idx, `## 群主撮合请求\n${m.task}`, { noMention: true }))
    }
  }
}

/** 群主收尾总结（auto 各档最后调用）。从群聊输出中取各成员最终汇报交群主综合。 */
async function runHostSummary(ctx: SwarmRuntimeContext) {
  const zh = ctx.locale !== 'en'
  const en = !zh
  const body = memberPosts(ctx) || (zh ? '（本轮无成员汇报内容）' : '（No member output this round）')
  const summaryPrompt = [
    `## 总体目标`,
    ctx.task,
    ``,
    `## 各成员汇报`,
    body,
    ``,
    en ? 'Please summarize this collaboration as the host: conclusions, outputs/deliverables, and open issues.' : '请作为群主，汇总本次全员协作的最终结果：结论、产出物与遗留问题。',
  ].join('\n')
  await runHost(ctx, summaryPrompt, '总结')
}

/** task 策略：原语模式（只剩辩论；全员响应/群主撮合由 auto 策略的档位表达） */
export const taskStrategy: SwarmStrategy = {
  type: 'task',
  label: '辩论',
  description: '多 Agent 多轮辩论，最后由群主中立总结',
  async run(ctx) {
    return runDebate(ctx)
  },
}

// ---------------------------------------------------------------------------
// auto 策略（默认，群聊协作）：内部按 settings.collabMode 分四档——
//   mention 点名（默认）/ relay 接力 / host 撮合 / plain 仅发言；收尾统一群主总结。
// 用户在输入框 @（runNamedTask）→ 只唤起被点名成员，单点执行不总结。
export const autoStrategy: SwarmStrategy = {
  type: 'auto',
  label: '自动',
  description: '群聊协作（默认）：按“点名/接力/撮合/仅发言”分档执行，结束由群主总结；输入框 @ 点名单点执行',
  async run(ctx) {
    const collab = ctx.settings?.collabMode
    if (collab === 'plain') await runPlain(ctx)
    else if (collab === 'relay') await runMention(ctx, true)
    else if (collab === 'host') await runHostCollab(ctx)
    else await runMention(ctx, false) // 默认：点名
    // 群主总结：默认关闭（settings.enableHostSummary === true 才开启）
    if (ctx.settings?.enableHostSummary === true) await runHostSummary(ctx)
  },
}

// ---------------------------------------------------------------------------
// 上下文辅助
// ---------------------------------------------------------------------------

export function getCtxAgent(ctx: SwarmRuntimeContext, idx: number): SwarmAgent | undefined {
  return ctx.agentsOf ? ctx.agentsOf[idx] : undefined
}

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

export const swarmStrategies: Record<string, SwarmStrategy> = {
  auto: autoStrategy,
  task: taskStrategy,
}

/** 解析当前应使用的策略（auto → 群聊协作；原语模式 → task 按 taskMode 分派） */
export function resolveSwarmStrategy(mode: SwarmRunMode): SwarmStrategy {
  if (mode === 'auto') return swarmStrategies.auto
  return swarmStrategies.task
}
