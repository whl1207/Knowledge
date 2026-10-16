/**
 * swarmRunner.ts — 集群运行器（统一 agent 循环 + 策略调度 + 会话日志）
 *
 * 每个 Agent 通过 agentBridge 跑在主进程 agent-loop 上，
 * 获得统一的 turn/step 事件流、会话日志（sessionLog）、取消/恢复能力；
 * 执行模式经 swarmStrategies 注册表分派（auto / 原语模式）。
 *
 * ⚠️ 本模块主体是**模块级单例**（runSwarm / stopSwarm / 各状态 ref 与 computed），
 * 由使用方按名 import，不是按调用实例化的 composable。
 * 历史文件名 useSwarmRunner.ts 具有误导性，2026-09 更名为 swarmRunner.ts。
 *
 * 外部实际只依赖 3 个导出：runSwarm / runNamedTask / stopSwarm（唯一消费方 home.vue）。
 * 2026-09 已删除：useSwarmRunner() 聚合器（零调用方），以及只服务已移除 AgentSwarm
 * 组件的状态条辅助：modeDescriptions / statusTotal / statusDone / statusPct /
 * statusIcon / agentStatusText / chipStatusTitle / elapsedText / formatMs / clearOutput。
 * 需要它们时请从 git 历史或 .backup-planA-20260912/ 取回，不要凭印象重加。
 */

import { computed } from 'vue'
import { usestore } from '@/store'
import { agentBridge, type AgentSessionView } from '@/platform/agentBridge'
import { assembleAgentSystemPrompt, buildMcpServersContext, ensureAgentSkills, workspaceRoot } from '@/lib/agent/promptContext'
// ask_user 结构化问答：弹窗排队在 store/askUser（渲染由全局 AskUserHost 承担）
import { requestUserAnswers, questionsOf, dismissAsk } from '@/store/askUser'
// exit_plan_mode 计划评审：弹窗排队在 store/planReview（渲染由全局 PlanReviewHost 承担）
import { requestPlanReview, dismissPlanReview } from '@/store/planReview'
import { toolsFromCapabilities } from '@/lib/agent/capabilities'
import { applyToolPresentation } from '@/lib/agent/presentation'
import { presetPresentation } from '@/lib/agent/ptc'
import { resolveAgentMaxSteps } from '@/shared/agent-loop-rounds'
import { resolveLlmSource } from '@/shared/llmSources'

import type { AgentOptions } from '@/types/agent'
import type { SwarmAgent, SwarmAgentRunState, SwarmRunMode } from '@/types/swarm'
import {
  store, agents, running,
  agentRunStates, elapsedMs, currentRound, outputContainer,
  swarmMode, debateRounds,
  activeSwarmJobId, setActiveSwarmJobId,
  settings, executionOrder, agentStepViews, selectedStepKey, stepFollowUserPicked,
  agentStepSeq, agentViewSeq, attachedSwarmViews, invocationRunStates, summonedMembers,
  runEpoch,
  swarmRunChatId,
  setSwarmRunChatId,
} from '@/store/swarmState'
import { aikmDsh } from '@/lib/aikmIpc'
import { getSkillPrompt } from '@/composables/swarm/useSwarmAgents'
import { ensureRoom, buildMembers, startEpisode, endEpisode, roomOf, setMemberSession, setMemberStatus, noteMemberTool, noteMemberTokens, pushMessage, addArtifact } from '@/store/swarmRoom'
import { readyTaskIds, tasksSettled, describeBoard } from '@/lib/agent/teamProtocol'
import type { SwarmRoom } from '@/types/swarmRoom'
// 消息写入对话（与普通/智能体模式同一套消息与渲染）
import { pushMemberMessage, pushUserTaskMessage, pushSystemMessage, pushSwarmMessage, finishMemberMessage, swarmRunChat } from '@/composables/swarm/useSwarmChat'
// 会话视图 → 消息投影（与 useAgentRun 共用同一实现，工具调用/思考样式天然一致）
import { projectStepsToUnits, projectKbInfo, projectUsage, projectTodos, projectPlan, projectPlanReview } from '@/lib/agent/projection'
import type { ChatMessage } from '@/types/chat'
import { resolveSwarmStrategy, type SwarmRuntimeContext, type AgentRunOpts } from '@/lib/agent/swarmStrategies'
import { getPlatform } from '@/platform'

// ---------------------------------------------------------------------------
// 运行状态
// ---------------------------------------------------------------------------

/** 是否可发起运行（任务文本由调用方传入，这里只校验运行态与成员）。仅模块内部（runSwarm）使用 */
const canRun = computed(() => !running.value && agents.value.length > 0)

// ---------------------------------------------------------------------------
// 输出消息
// ---------------------------------------------------------------------------

/** 仅模块内部使用（写入对话消息）；策略经 runtime ctx 回调调用 */
const addOutput = (agent: string, name: string, content: string, invKey?: string) => {
  // 用户任务 → 普通 user 消息；成员汇报 → assistant 消息
  // （工具调用/思考/来源由投影写入 executionUnits / kbInfo，与智能体模式同渲染）
  if (agent === 'user') { pushUserTaskMessage(content); return }
  if (agent === 'system') {
    // 过程性提示不写入对话（避免污染聊天记录）；错误/失败仍以 system 消息展示
    if (/错误|失败|error/i.test(name) || /错误|失败|error/i.test(content)) pushSystemMessage(content)
    return
  }
  const idx = Number(String(agent).replace(/^a/, ''))
  pushMemberMessage(Number.isFinite(idx) ? idx : -1, name)
}

/** 仅模块内部使用（把输出容器滚到底） */
const scrollToBottom = () => {
  requestAnimationFrame(() => {
    if (outputContainer.value) outputContainer.value.scrollTop = outputContainer.value.scrollHeight
  })
}

// ---------------------------------------------------------------------------
// Agent 运行状态
// ---------------------------------------------------------------------------

/** 仅模块内部使用；策略经 runtime ctx 回调调用 */
const setAgentState = (agentIdx: number, patch: Partial<SwarmAgentRunState>) => {
  const cur = agentRunStates.value[agentIdx] || { agentIdx, status: 'pending' as const, round: 1, stage: '', role: undefined, detail: '', startTime: 0 }
  agentRunStates.value[agentIdx] = { ...cur, ...patch }
}

const elapsedTimer = { id: null as ReturnType<typeof setInterval> | null, start: 0 }
const startElapsedTimer = () => {
  elapsedTimer.start = Date.now()
  elapsedMs.value = 0
  stopElapsedTimer()
  elapsedTimer.id = setInterval(() => { elapsedMs.value = Date.now() - elapsedTimer.start }, 1000)
}
const stopElapsedTimer = () => { if (elapsedTimer.id) { clearInterval(elapsedTimer.id); elapsedTimer.id = null } }

/** 集群中全部 Agent 参与执行（不再单独配置参与 Agent）。仅模块内部（stopSwarm / runSwarm）使用 */
const allAgentIndices = (): number[] => agents.value.map((_, i) => i)

// ---------------------------------------------------------------------------
// Provider 配置（对齐 useAgentRun.buildAgentProviderConfig，无聊天级覆盖）
// ---------------------------------------------------------------------------

function buildProviderConfig(llmType: string, model?: string) {
  const llm = store.AIconfig.llm
  // 单来源解析：DeepSeek 只有一个来源（deepseek），接口样式随 config.api_style 下发；历史别名在此归一
  const { type, config } = resolveLlmSource(llm, llmType)
  if (model) config.model = model
  const llmConfig: any = {
    ...llm,
    type,
    stream: true,
    temperature: llm.temperature,
    max_tokens: llm.max_tokens,
  }
  return { provider: type, config, llmConfig }
}

// ---------------------------------------------------------------------------
// System prompt 构建（对齐 Agent 预设：buildAutonomousSystemPrompt + buildToolUsageContext）
// ---------------------------------------------------------------------------

/** 按能力构建工具白名单（与预设 buildPresetTools 共用统一数据源 agentCapabilities.ts） */
function buildSwarmTools(agent: SwarmAgent): string[] {
  // mcp_call 由 agentMcpConfig 单独判定（自身配置 / 关联预设回退），故基础列表不并入
  const out = toolsFromCapabilities(agent.capabilities, { includeMcp: false })
  // MCP：优先使用 Agent 自身（可编辑）的配置；旧预案未定义时回退到关联预设
  if (agentMcpConfig(agent)) out.push('mcp_call')
  return out
}

/** 全局已启用的 MCP 服务（设置 → MCP 服务中 enabled !== false 且非 inmemory；对齐 home 通用智能体） */
const activeGlobalMcpServers = (): any[] =>
  (store.mcpServers || []).filter((s: any) => s && s.enabled !== false && s.transport !== 'inmemory')

/**
 * 读取 Agent 的 MCP 配置：
 * - 通用/自定义成员（未关联预设）：已绑定服务用自身的；否则自动携带「设置 → MCP」中全局已启用的服务（对齐 home 通用智能体）；
 * - 预设成员：自身 capabilities 优先（Agent 网格可编辑），自身未定义 mcpAccess（历史预案）时回退关联预设。
 */
function agentMcpConfig(agent: SwarmAgent): { ids: string[]; configs: any[]; equipmentIds?: string[] } | null {
  const build = (ids: string[], equipmentIds?: string[]) =>
    ids.length
      ? {
          ids,
          configs: (store.mcpServers || []).filter((s: any) => ids.includes(s.id)),
          equipmentIds,
        }
      : null
  const caps = agent.capabilities as any
  // —— 通用 / 自定义成员（未关联预设）——
  if (!agent.presetId) {
    const own = typeof caps.mcpAccess === 'boolean' && caps.mcpAccess
      ? build(caps.mcpServerIds || [], caps.mcpEquipmentIds || undefined)
      : null
    if (own) return own
    const globals = activeGlobalMcpServers()
    if (globals.length) return build(globals.map((s: any) => s.id))
    return null
  }
  // —— 预设成员：自身配置优先 ——
  if (typeof caps.mcpAccess === 'boolean') {
    if (!caps.mcpAccess) return null
    return build(caps.mcpServerIds || [], caps.mcpEquipmentIds || undefined)
  }
  // 回退：关联预设的 MCP 配置（历史预案自身未定义 mcpAccess）
  const preset = (store.agentPresets || []).find((c: any) => c.id === agent.presetId)
  const pcaps = preset?.capabilities
  if (!pcaps?.mcpAccess) return null
  return build(pcaps.mcpServerIds || [], pcaps.mcpEquipmentIds || undefined)
}

/**
 * 构建 Agent 的完整 system prompt。
 * 统一交给 @/lib/agent/promptContext（与聊天预设、批量智能体、工作流节点同一实现）：
 * 自定义提示 + 工具说明 / 自主规划 / 知识库 / 技能库清单 / 工作区 / MCP 工具清单。
 * 集群特有其上的「skillMode 嵌入 SKILL.md」作为 extraAppend 追加。
 */
async function buildSwarmSystemPrompt(agent: SwarmAgent): Promise<string> {
  const tools = buildSwarmTools(agent)

  // MCP 能力上下文（与聊天智能体对齐）：列出绑定服务的真实工具清单，引导按需 mcp_call
  const mcpCfg = agentMcpConfig(agent)
  const mcpContext = mcpCfg && mcpCfg.ids.length
    ? await buildMcpServersContext(mcpCfg.configs, store.locales)
    : ''

  // 技能：skillMode all/select 时嵌入 SKILL.md 内容（Swarm 扩展）；skills 能力由 skill 工具按需加载
  const skillPrompt = await getSkillPrompt(agent)
  // 技能库清单来自共享引导（与聊天/批量/工作流同一份技能表，含主进程 skillService 根目录）
  const installedSkills = await ensureAgentSkills(store)

  const assembled = assembleAgentSystemPrompt({
    store,
    // 集群 Agent 自持 systemPrompt / capabilities（无预设对象）
    capabilities: agent.capabilities,
    customPrompt: agent.systemPrompt,
    tools,
    enabledSkills: installedSkills,
    mcpContext,
    extraAppend: skillPrompt,
  })
  return assembled.systemPrompt
}

/** 通用管理器（中立 system prompt，不携带角色设定与工具；具体 Agent 才走 buildSwarmSystemPrompt） */
function buildGenericManagerPrompt(): string {
  return assembleAgentSystemPrompt({ store, tools: [], includeWorkspaceHint: false }).systemPrompt
}

// ---------------------------------------------------------------------------
// 活跃会话管理（停止时级联取消）
// ---------------------------------------------------------------------------

const activeAgentSessions = new Set<string>()

/** 停止整个 Swarm 运行：级联取消所有子 Agent */
export const stopSwarm = async () => {
  if (!running.value) return
  running.value = false
  for (const id of activeAgentSessions) {
    try { await agentBridge.cancel(id, 'user') } catch { /* 忽略 */ }
  }
  activeAgentSessions.clear()
  stopElapsedTimer()
  addOutput('system', '停止', store.locales === 'en' ? 'Swarm stopped by user' : '集群运行已停止')
}

// ---------------------------------------------------------------------------
// 执行单个 Agent（agentBridge 统一 agent 循环）
// ---------------------------------------------------------------------------

/** 等待 agent 收敛（running → idle），返回最终内容。
 *  myEpoch 为本次运行的代际：切换预案（resetSwarmDefinition 递增 runEpoch）后，
 *  会话仍在主进程后台跑完（Promise 正常 resolve），但其 UI 写入（输出/步骤/状态）
 *  一律跳过，避免污染新集群的执行面板。 */
function waitForBridgeCompletion(
  view: AgentSessionView,
  agentIdx: number,
  msg: ChatMessage | null,
  prompt: string,
  timeoutMs: number,
  myEpoch: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let sawRunning = false
    let settled = false
    const handledAsks = new Set<string>()
    let openAskId: string | null = null
    const handledReviews = new Set<string>()
    let openReviewId: string | null = null
    /** 已收集来源的 kb_search 调用 */
    const processedKb = new Set<string>()
    /** 项目组：已计入活动的工具调用 id（防重复计数） */
    const recordedTools = new Set<string>()
    /** 项目组：该会话已计入的累计 token（取增量） */
    let usageSeen = 0
    /** 运行代际是否仍有效（未切换对话/集群） */
    const alive = () => runEpoch.value === myEpoch
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsub()
      activeAgentSessions.delete(view.id)
      fn()
    }
    const unsub = agentBridge.on((v) => {
      if (v.id !== view.id) return
      // 归属对话（工具调用快照 / 待办清单写入目标）；代际失效时不再写 UI
      const chat = alive() ? swarmRunChat() : null
      if (v.status === 'running') sawRunning = true
      // 流式输出投影
      if (msg && v.currentStream) msg.content = v.currentStream
      if (v.lastAssistantContent && msg) msg.content = v.lastAssistantContent
      // 工具调用 / 思考 / 正文 → 消息的 executionUnits（与智能体模式同一实现）
      if (alive() && msg && Array.isArray(v.steps) && v.steps.length > 0) {
        const { lastTool } = projectStepsToUnits(msg, v)
        if (lastTool && chat) {
          chat.agentLastTool = {
            name: lastTool.description,
            status: lastTool.status,
            summary: typeof lastTool.result === 'string'
              ? lastTool.result.slice(0, 80)
              : lastTool.result && typeof lastTool.result === 'object'
                ? JSON.stringify(lastTool.result).slice(0, 80)
                : lastTool.error || '',
          }
        }
      }
      // 知识库来源 / token 统计 / 待办清单（与智能体模式同一实现）
      if (alive() && msg) {
        projectKbInfo(msg, v, processedKb)
        projectUsage(msg, v)
      }
      if (alive() && chat) { projectTodos(chat, v); projectPlan(chat, v); projectPlanReview(chat, v) }
      // 项目组工作台活动指标：工具次数 / 累计 token（对齐 cc-haha 活动面板）
      if (alive() && settings.value?.collabMode === 'team') {
        const r = roomOf(swarmRunChatId.value || '')
        if (r) {
          const step = v.steps[v.steps.length - 1]
          const tc = step?.toolCalls?.[step.toolCalls.length - 1]
          if (tc && tc.status !== 'running' && tc.callId && !recordedTools.has(tc.callId)) {
            recordedTools.add(tc.callId)
            noteMemberTool(r, agentIdx, tc.name)
            // 产出物：登记到房间 + 任务，并在群聊里放一张产物卡片（正文不进上下文）
            if (tc.name === 'post_artifact') {
              const raw: any = tc.result
              const v: any = (raw && typeof raw === 'object' && raw.value) ? raw.value : raw
              if (v && typeof v === 'object' && v.path) {
                const art = addArtifact(r, {
                  name: String(v.name || ''),
                  path: String(v.path),
                  bytes: Number(v.bytes) || 0,
                  taskId: r.members[agentIdx]?.currentTaskId,
                  agentIdx,
                })
                pushSwarmMessage({
                  role: 'system',
                  content: '',
                  timestamp: Date.now(),
                  swarmArtifact: { name: art.name, path: art.path, bytes: art.bytes },
                })
              }
            }
          }
          if (typeof v.usageTotal === 'number' && v.usageTotal > usageSeen) {
            noteMemberTokens(r, agentIdx, v.usageTotal - usageSeen)
            usageSeen = v.usageTotal
          }
        }
      }
      // 状态投影（工具调用中 / 思考中）
      const st = alive() ? agentRunStates.value[agentIdx] : undefined
      if (st && v.status === 'running') {
        const lastStep = v.steps[v.steps.length - 1]
        const runningTool = lastStep?.toolCalls.find(tc => tc.status === 'running')
        if (runningTool) { st.status = 'tool'; st.detail = `调用工具: ${runningTool.name}` }
        else { st.status = 'thinking'; st.detail = '' }
      }
      // ask_user 提问：结构化弹窗收集回答（全局 AskUserHost；按 askId 去重）
      if (alive() && v.pendingQuestion && !handledAsks.has(v.pendingQuestion.askId)) {
        handledAsks.add(v.pendingQuestion.askId)
        if (st) { st.status = 'tool'; st.detail = '等待用户回答' }
        const name = agents.value[agentIdx]?.name || `Agent ${agentIdx + 1}`
        const askId = v.pendingQuestion.askId
        openAskId = askId
        requestUserAnswers({
          askId,
          source: name,
          questions: questionsOf(v.pendingQuestion),
          onCancel: () => { void agentBridge.cancel(view.id, 'user') },
        })
          .then((answers) => agentBridge.answer(view.id, askId, '', answers))
          .catch(() => { /* 已在 onCancel 里收口（中止 turn） */ })
          .finally(() => { if (openAskId === askId) openAskId = null })
      }
      // agent 侧已收口（turn 被中止 / 别处已回答）：清理仍挂着的弹窗
      if (openAskId && !v.pendingQuestion) { dismissAsk(openAskId); openAskId = null }
      // exit_plan_mode 计划评审：弹窗等裁决（Approve / 继续完善 / 关闭）
      if (alive() && v.pendingPlanReview && !handledReviews.has(v.pendingPlanReview.reviewId)) {
        handledReviews.add(v.pendingPlanReview.reviewId)
        const r = v.pendingPlanReview
        const name = agents.value[agentIdx]?.name || `Agent ${agentIdx + 1}`
        openReviewId = r.reviewId
        requestPlanReview({ reviewId: r.reviewId, source: name, plan: r.plan })
          .then(({ verdict, feedback }) =>
            agentBridge.answer(view.id, r.reviewId, verdict, feedback ? [{ id: 'feedback', selected: [], custom: feedback }] : undefined))
          .catch(() => { /* 评审已失效 */ })
          .finally(() => { if (openReviewId === r.reviewId) openReviewId = null })
      }
      if (openReviewId && !v.pendingPlanReview) { dismissPlanReview(openReviewId); openReviewId = null }
      if (v.status === 'idle' && sawRunning && !v.pendingQuestion && !v.pendingPlanReview) {
        finish(() => {
          const final = v.lastAssistantContent || (msg ? msg.content : '')
          if (alive()) {
            const st2 = agentRunStates.value[agentIdx]
            if (st2) { st2.status = 'done'; st2.detail = '' }
            finishMemberMessage(msg, 'done')
            reportProgress()
          }
          resolve(final)
        })
      }
      if (v.lastError) {
        finish(() => {
          if (alive()) {
            const st2 = agentRunStates.value[agentIdx]
            if (st2) { st2.status = 'error'; st2.detail = v.lastError || '执行失败' }
            finishMemberMessage(msg, 'error')
            reportProgress()
          }
          reject(new Error(v.lastError || 'agent 执行失败'))
        })
      }
    })
    const timer = setTimeout(() => {
      finish(() => {
        if (alive()) {
          const st2 = agentRunStates.value[agentIdx]
          if (st2) { st2.status = 'done'; st2.detail = '' }
          finishMemberMessage(msg, 'done')
          reportProgress()
        }
        resolve(agentBridge.get(view.id)?.lastAssistantContent || (msg ? msg.content : '') || '')
      })
    }, timeoutMs)
    agentBridge.send(view.id, prompt, 'swarm').catch((e) => finish(() => reject(e)))
  })
}

/** 后台任务进度上报 */
function reportProgress() {
  if (aikmDsh?.jobs?.progress && activeSwarmJobId) {
    try {
      const total = agents.value.length
      const done = allAgentIndices().filter(i => {
        const s = agentRunStates.value[i]?.status
        return s === 'done' || s === 'error'
      }).length
      aikmDsh.jobs.progress(activeSwarmJobId, total > 0 ? Math.round((done / total) * 100) : null, `${done}/${total} ${store.locales === 'zh' ? 'Agent 完成' : 'agents done'}`)
    } catch { /* 忽略 */ }
  }
}

/** 兜底：agentBridge 不可用（浏览器模式）时退化为普通流式 LLM 调用 */
async function callLLMFallback(agent: SwarmAgent, prompt: string, ragContext?: string, onStream?: (chunk: string) => void, generic = false): Promise<string> {
  const finalPrompt = ragContext
    ? `以下是与任务相关的知识库资料：\n${ragContext}\n---\n请基于上述资料回答：\n${prompt}`
    : prompt
  // 通用管理器：中立 system prompt，不携带 Agent 角色设定
  const sysContent = generic
    ? buildGenericManagerPrompt()
    : await buildSwarmSystemPrompt(agent)
  const messages = sysContent
    ? [{ role: 'system' as const, content: sysContent }, { role: 'user' as const, content: finalPrompt }]
    : [{ role: 'user' as const, content: finalPrompt }]
  const origType = store.AIconfig.llm.type
  if (!generic) store.AIconfig.llm.type = agent.llmType || origType
  try {
    const result = await store.sendToAI(messages, {
      onStream,
    })
    return typeof result === 'string' ? result : (result as any)?.text || (result as any)?.content || ''
  } finally {
    store.AIconfig.llm.type = origType
  }
}

/** 统一执行入口：占位消息 → agentBridge 会话 → 流式输出 → 完成/失败。仅模块内部使用 */
async function executeAgent(agentIdx: number, prompt: string, opts: AgentRunOpts = {}): Promise<string> {
  const a = agents.value[agentIdx]
  if (!a) return ''
  // 本次调用所属运行代际：切换预案后（runEpoch 递增）不再启动新会话，旧会话继续后台完成
  const myEpoch = runEpoch.value
  const prev = agentRunStates.value[agentIdx]
  // 群主（中立总结者）：默认 LLM + 中立 system prompt，不携带该 Agent 的角色设定
  const isGeneric = !!opts.generic
  const displayName = isGeneric
    ? (store.locales === 'zh' ? '群主' : 'Host')
    : (a.name || `A${agentIdx + 1}`)
  // 会话序号（该 Agent 第几次调用）：先分配，供执行时间线与步骤关联
  const seq = (agentStepSeq.value[agentIdx] || 0) + 1
  agentStepSeq.value[agentIdx] = seq
  // 记录执行顺序（左侧执行顺序面板 = 时间线，每条一次调用）
  executionOrder.value.push({ agentIdx, stage: opts.stage, round: opts.round, seq, generic: isGeneric, time: Date.now() })
  invocationRunStates.value[`${agentIdx}|${seq}`] = 'running'
  setAgentState(agentIdx, {
    status: 'retrieving',
    round: opts.round || prev?.round || 1,
    stage: opts.stage || prev?.stage || '',
    role: opts.role || prev?.role,
    detail: '',
    startTime: Date.now(),
  })
  // 成员汇报消息（唯一写入点；后续流式/工具调用直接更新这条消息，与其它模式同渲染）
  const msg = pushMemberMessage(isGeneric ? -1 : agentIdx, displayName, seq)
  const st = agentRunStates.value[agentIdx]
  if (st && st.status === 'retrieving') st.status = 'thinking'

  // 兜底路径（本环境没有任何智能体循环：桌面 IPC / 主机桥 / 渲染层循环都不可用）
  if (!agentBridge.available) {
    try {
      const onStream = (chunk: string) => {
        if (msg) msg.content += chunk
      }
      const r = await callLLMFallback(a, prompt, opts.ragContext, onStream, isGeneric)
      if (msg) msg.content = r
      finishMemberMessage(msg, 'done')
      const st2 = agentRunStates.value[agentIdx]
      if (st2) { st2.status = 'done'; st2.detail = '' }
      reportProgress()
      return r
    } catch (err: any) {
      const st3 = agentRunStates.value[agentIdx]
      if (st3) { st3.status = 'error'; st3.detail = err?.message || '执行失败' }
      finishMemberMessage(msg, 'error')
      reportProgress()
      throw err
    }
  }

  // agentBridge 主进程 agent 循环
  let view: AgentSessionView
  try {
    const sysContent = isGeneric
      ? buildGenericManagerPrompt()
      : await buildSwarmSystemPrompt(a)
    const { provider, config, llmConfig } = isGeneric
      ? buildProviderConfig(store.AIconfig.llm.type)
      : buildProviderConfig(a.llmType, a.model)
    const tools = isGeneric ? [] : [...buildSwarmTools(a), ...(opts.extraTools || [])]
    const mcp = isGeneric ? null : agentMcpConfig(a)
    // 成员关联的预设：呈现方式（PTC）与循环轮数都跟随它（成员自身不声明呈现）
    const memberPreset = (store.agentPresets || []).find((c: any) => c.id === (a as any).presetId)
    const scope = `swarm-${displayName}`
    const presented = isGeneric
      ? { systemPrompt: sysContent, tools, toolsPresentation: 'native' as const }
      : await applyToolPresentation({
          basePrompt: sysContent,
          catalog: tools,
          presentation: presetPresentation(memberPreset),
          scope,
        })
    const options: AgentOptions = {
      systemPrompt: presented.systemPrompt,
      provider,
      config,
      llmConfig: {
        ...llmConfig,
        temperature: isGeneric ? llmConfig.temperature : (typeof a.temperature === 'number' ? a.temperature : llmConfig.temperature),
      },
      tools: presented.tools,
      toolsPresentation: presented.toolsPresentation,
      cwd: workspaceRoot(store) || undefined,
      label: `swarm:${displayName}`,
      kbPaths: isGeneric ? undefined : (a.capabilities.accessKnowledgeBase ? a.capabilities.knowledgeBaseFiles : undefined),
      kbTopK: 5,
      // MCP：优先自身配置，历史预案回退关联预设（Agent 网格可编辑）
      mcpServerIds: mcp?.ids,
      mcpServerConfigs: mcp?.configs,
      mcpEquipmentIds: mcp?.equipmentIds,
      sandboxMode: store.pythonSandbox || (store.TrustedPython ? 'trusted' : 'safe'),
      scope,
      // 循环轮数：预设自带轮数为唯一例外，其余（含通用/自定义成员）一律用唯一数据源（不再写死 20）
      maxSteps: resolveAgentMaxSteps(memberPreset?.maxSteps, store.generalAgentMaxSteps),
    }
    view = await agentBridge.create(options)
  } catch (err: any) {
    const st3 = agentRunStates.value[agentIdx]
    if (st3) { st3.status = 'error'; st3.detail = err?.message || '启动失败' }
    finishMemberMessage(msg, 'error')
    reportProgress()
    throw err
  }
  setAgentState(agentIdx, { agentId: view.id })
  activeAgentSessions.add(view.id)
  attachedSwarmViews.add(view.id)
  // 项目组（Agent Teams）：登记成员会话（协议工具 send_message 据此投递）
  if (settings.value?.collabMode === 'team') {
    const r = roomOf(swarmRunChatId.value || '')
    if (r) setMemberSession(r, agentIdx, view.id)
  }
  // 会话序号已在入口分配（与执行时间线条目 seq 对应），这里建立 view → 调用 的映射
  agentViewSeq.value[view.id] = { agentIdx, seq }

  const content = await waitForBridgeCompletion(view, agentIdx, msg, prompt, 30 * 60 * 1000, myEpoch)
  return content
}

// ---------------------------------------------------------------------------
// 知识库检索（策略预检索）
// ---------------------------------------------------------------------------

/** 仅模块内部使用（由 executeAgent 与策略回调调用） */
const retrieveKnowledgeForAgent = async (agent: SwarmAgent, query: string, kbFilter?: string): Promise<string> => {
  if (!agent.capabilities.accessKnowledgeBase || agent.capabilities.knowledgeBaseFiles.length === 0) return ''
  const { retrieveKnowledge } = await import('@/shared/kbRetrieval')
  const ollamaHost = store.AIconfig.llm.ollama?.model_url || 'http://127.0.0.1:11434'
  let ragContext = ''
  for (const kbPath of agent.capabilities.knowledgeBaseFiles) {
    const kbName = kbPath.split(/[\\/]/).pop() || kbPath
    if (kbFilter && kbName !== kbFilter && kbPath !== kbFilter) continue
    const isKb = kbPath.toLowerCase().endsWith('.kb')
    if (!isKb) {
      try {
        const text = await getPlatform().fs.readText(kbPath)
        if (text && typeof text === 'string' && !text.startsWith('Error')) {
          ragContext += `### ${kbName}\n${text}\n`
          addOutput('system', `📄 ${agent.name} - 参考文件`, `已读取参考文件：${kbName}`)
        }
      } catch { /* 忽略 */ }
      continue
    }
    try {
      const result = await retrieveKnowledge(query, kbPath, {
        topK: 3, ollamaHost, missingModelStrategy: 'fallback',
      })
      if (result.context) {
        ragContext += result.context + '\n'
        const blockLabels = result.relevantBlocks.map((b: any) => b.label).join('、')
        addOutput('system', `📖 ${agent.name} - 知识库检索`,
          `在「${kbName}」中检索到 ${result.relevantBlocks.length} 个相关片段：\n${blockLabels}\n（使用模型: ${result.usedEmbedModel}）`)
      }
    } catch { /* 忽略 */ }
  }
  return ragContext
}

// ---------------------------------------------------------------------------
// 项目组（Agent Teams）：Lead 编排 + 共享任务板
// 设计见 docs/plan/群聊-AgentTeams-实施设计（逐文件）.md
// ---------------------------------------------------------------------------

/** Lead 专属协议工具 */
const TEAM_LEAD_TOOLS = [
  'team_spawn', 'team_task_create', 'team_task_list', 'team_task_update', 'team_task_delete', 'team_shutdown', 'team_delete', 'post_artifact',
]
/** 成员协议工具 */
const TEAM_MEMBER_TOOLS = ['send_message', 'team_task_list', 'team_task_update', 'team_task_claim', 'post_artifact']

/** 执行一个任务：派给其负责人，回写任务板 */
async function runTeamTask(ctx: SwarmRuntimeContext, room: SwarmRoom, taskId: string): Promise<void> {
  const t = room.tasks.find((x) => x.id === taskId)
  if (!t || t.status === 'done') return
  if (t.assignee === undefined) {
    // 未指派：轮流分给「非 Lead」成员，避免所有任务都压到 Lead 身上
    const leadIdx = room.episode?.leadIdx ?? 0
    const pool = room.members.filter((m) => m.idx !== leadIdx)
    const list = pool.length ? pool : room.members
    if (!list.length) return
    t.assignee = list[room.tasks.filter((x) => x.assignee !== undefined).length % list.length].idx
  }
  t.status = 'running'
  t.startedAt = Date.now()
  setMemberStatus(room, t.assignee, 'running', { currentTaskId: t.id })
  const upstream = t.deps
    .map((d) => room.tasks.find((x) => x.id === d))
    .filter(Boolean)
    .map((d: any) => `【${d.id} ${d.title}】\n${d.output || '（无产出）'}`)
    .join('\n\n')
  const prompt = [
    `## 团队任务 ${t.id}：${t.title}`,
    t.prompt,
    upstream ? `\n## 上游任务产出（依赖已完成）\n${upstream}` : '',
    `\n完成后请调用 team_task_update(id="${t.id}", status="done", output="<简要结论>") 回写任务板；长产出（报告/代码/数据）请用 post_artifact 落成文件、output 只写摘要；需要同事配合时用 send_message。`,
  ].filter(Boolean).join('\n')
  try {
    const out = await ctx.runAgent(t.assignee, prompt, { role: 'worker', stage: `任务 ${t.id}`, extraTools: TEAM_MEMBER_TOOLS })
    if ((t.status as string) !== 'done') { t.output = String(out || '').slice(0, 2000); t.status = 'done' }
    t.endedAt = Date.now()
  } catch (e: any) {
    t.status = 'error'
    t.error = e?.message || String(e)
    t.endedAt = Date.now()
  } finally {
    setMemberStatus(room, t.assignee, 'idle', { currentTaskId: undefined })
  }
  // 后台任务完成 → 通知 Lead（进通信流与群聊），让 Lead 知道可以继续推进
  if (t.background) {
    pushMessage(room, {
      from: t.assignee ?? -1,
      to: 'lead',
      kind: 'inform',
      summary: `后台任务 ${t.id}·${t.title} ${t.status === 'done' ? '已完成' : '失败'}`,
    })
  }
}

/**
 * 项目组回合（Agent Teams）：
 *   Lead 拆解（team_task_create）→ 调度 ready 任务（并发闸门内）→ Lead 交付。
 * 终止由 teamProtocol 程序化判定（任务板收敛 + 无 in-flight），不依赖 LLM 自称完成。
 */
async function runEpisode(ctx: SwarmRuntimeContext, opts: { resume?: boolean } = {}): Promise<void> {
  const zh = ctx.locale !== 'en'
  const chatId = swarmRunChatId.value || ''
  const room = ensureRoom(chatId, buildMembers(ctx.agentsOf.map((a) => ({ name: a.name, role: a.role, model: a.model }))))
  const leadIdx = (() => {
    const n = Number(ctx.settings?.managerAgentIdx)
    return Number.isInteger(n) && n >= 0 && n < ctx.agentsOf.length ? n : 0
  })()
  const roster = ctx.agentsOf
    .map((a, i) => `${i}. ${a.name}${a.role ? `（${a.role}）` : ''}${i === leadIdx ? ' ← Lead' : ''}`)
    .join('\n')

  if (opts.resume) {
    // 断点续跑：不重新规划，把中断/失败的任务复位为可执行，直接进调度循环
    for (const t of room.tasks) if (t.status === 'running' || t.status === 'error') t.status = 'ready'
    if (room.episode) room.episode.status = 'running'
    else startEpisode(room, ctx.task, leadIdx)
  } else {
    startEpisode(room, ctx.task, leadIdx)
    // 1) Lead 拆解
    ctx.setAgentState(leadIdx, { status: 'thinking', stage: zh ? '编排' : 'Plan' })
    await ctx.runAgent(leadIdx, [
    `## 用户目标`, ctx.task, '',
    `## 团队成员（下标. 名称）`, roster, '',
    `## 当前任务板`, describeBoard(room.tasks), '',
    zh
      ? '你是本回合的 Team Lead。若目标较复杂，请用 team_task_create 拆成有依赖的子任务（assignee 填**成员名**，deps 填任务 id）；请把任务分给最合适的成员，不要都留给自己。简单目标直接回答即可。成员完成后会更新任务板。'
      : 'You are the Team Lead. For complex goals, split work with team_task_create (assignee = the member NAME, deps = task ids); assign each task to the most suitable member rather than keeping them all. For simple goals, just answer.',
  ].join('\n'), { role: 'manager', stage: zh ? '编排' : 'Plan', extraTools: TEAM_LEAD_TOOLS })

    // 1b) 兜底：Lead 未拆解任何任务（简单任务 / 弱模型）→ 全员各自作答，再由 Lead 交付
    if (!room.tasks.length) {
      for (const idx of ctx.selectedIndices) {
        if (idx === leadIdx) continue
        await ctx.runAgent(idx, `## 任务\n${ctx.task}\n\n请直接处理上面内容并给出你的结论。`, {
          role: 'worker', stage: zh ? '协作' : 'Work', extraTools: TEAM_MEMBER_TOOLS,
        })
      }
    }
  }

  // 2) 调度循环（并发闸门 + 后台任务）
  const MAX_LOOPS = 24
  let prevSig = ''
  let stalled = 0
  /** 在飞的后台任务：taskId → Promise（不阻塞主流程，但计入收尾判定） */
  const bg = new Map<string, Promise<void>>()
  const isBg = (id: string) => !!room.tasks.find((t) => t.id === id)?.background
  for (let loop = 0; loop < MAX_LOOPS; loop++) {
    const ready = readyTaskIds(room.tasks)
    const fg = ready.filter((id) => !isBg(id))
    const bgReady = ready.filter((id) => isBg(id))

    // 后台任务：启动即返回（不 await），由调度器在收尾时统一等待
    for (const id of bgReady) {
      if (bg.has(id)) continue
      bg.set(id, runTeamTask(ctx, room, id).finally(() => bg.delete(id)))
    }

    if (fg.length) {
      await Promise.all(fg.slice(0, Math.max(1, room.maxInflight)).map((id) => runTeamTask(ctx, room, id)))
    } else if (bg.size) {
      // 只剩后台任务在跑：等一个先完成，避免空转
      await Promise.race([...bg.values()])
    }

    if (!fg.length && !bg.size && !ready.length) {
      if (tasksSettled(room.tasks)) break
      // 有未完成但无 ready（依赖未满足/成环）：请 Lead 调整一次后退出
      await ctx.runAgent(leadIdx, [
        `## 任务板（存在卡住的任务，请检查依赖或改派）`, describeBoard(room.tasks), '',
        zh ? '请调整依赖/负责人，或直接给出结论。' : 'Adjust deps/assignee, or conclude.',
      ].join('\n'), { role: 'manager', stage: zh ? '调整' : 'Adjust', extraTools: TEAM_LEAD_TOOLS })
      break
    }

    const sig = room.tasks.map((t) => `${t.id}:${t.status}`).join('|')
    if (sig === prevSig) { if (++stalled >= 3) break } else { stalled = 0; prevSig = sig }
  }
  // 收尾：等剩余后台任务跑完（完成时已各自通知 Lead）
  if (bg.size) await Promise.all([...bg.values()])

  // 3) Lead 交付
  ctx.setAgentState(leadIdx, { status: 'thinking', stage: zh ? '交付' : 'Deliver' })
  await ctx.runAgent(leadIdx, [
    `## 用户目标`, ctx.task, '',
    `## 任务板`, describeBoard(room.tasks), '',
    zh ? '请作为 Team Lead 汇总最终交付：结论、产出与遗留问题。' : 'As Team Lead, summarize the final deliverable: conclusions, outputs, open issues.',
  ].join('\n'), { role: 'manager', stage: zh ? '交付' : 'Deliver', extraTools: TEAM_LEAD_TOOLS })

  // Episode 结束：回收成员会话（决策：Episode 结束 dispose，释放资源）
  for (const m of room.members) {
    if (!m.sessionId) continue
    try { await agentBridge.dispose(m.sessionId) } catch { /* 忽略 */ }
    activeAgentSessions.delete(m.sessionId)
    m.sessionId = undefined
  }
  endEpisode(room, 'done')
}

// ---------------------------------------------------------------------------
// 运行入口：策略注册表分派
// ---------------------------------------------------------------------------

/**
 * 发起一次集群运行。
 * @param rawTask 任务文本（由调用方从对话输入框捕获，集群不维护自己的输入状态）
 * @param modeOverride 本次临时覆盖的运行方式（缺省用集群默认模式）
 */
export const runSwarm = async (rawTask: string, modeOverride?: SwarmRunMode, opts: { resume?: boolean } = {}) => {
  const taskText = String(rawTask || '').trim()
  if (!taskText || !canRun.value) return
  // 本次运行所使用的模式：modeOverride 为本次临时覆盖（发送框），否则用默认模式
  const runMode = modeOverride ?? swarmMode.value
  // 本次运行所属代际：切换预案（runEpoch 递增）后，旧运行不再写当前集群 UI
  const myEpoch = runEpoch.value
  running.value = true
  currentRound.value = 0
  summonedMembers.value = []
  executionOrder.value = []
  invocationRunStates.value = {}
  agentStepViews.value = {}
  selectedStepKey.value = null
  stepFollowUserPicked.value = false

  // 后台任务（swarm job）
  let swarmJob: string | null = null
  try {
    if (aikmDsh?.jobs?.start) {
      const j = await aikmDsh.jobs.start('swarm', 'swarm', `${store.locales === 'zh' ? '集群执行' : 'Swarm run'}: ${taskText.slice(0, 40)}`)
      swarmJob = j.id
      setActiveSwarmJobId(j.id)
    }
  } catch { /* 无桌面环境时忽略 */ }

  const allIndices = allAgentIndices()
  agentRunStates.value = {}
  allIndices.forEach(idx => {
    agentRunStates.value[idx] = { agentIdx: idx, status: 'pending', round: 1, stage: '', role: undefined, detail: '', startTime: 0 }
  })
  startElapsedTimer()

  // 编排并发意图：以「集群 agent 数」作为远端大模型并发上限（远程自托管后端限流据此放开），
  // 使集群自身的并行度不被 agent-loop 的默认上限压住；结束/停止/切换预案时在 finally 撤销
  const swarmScopeId = `agent-swarm:${Date.now()}:${myEpoch}`
  await agentBridge.declareConcurrency(swarmScopeId, Math.max(1, allIndices.length)).catch(() => {})
  // 用户任务作为群聊“我”消息加入消息流（随运行历史持久化，任务不再“执行完就消失”）
  addOutput('user', store.locales === 'en' ? 'You' : '我', taskText)

  // 组装策略运行时上下文
  const ctx: SwarmRuntimeContext = {
    task: taskText,
    selectedIndices: allIndices,
    mode: runMode,
    debateRounds: debateRounds.value,
    settings: {
      ...settings.value,
      taskMode: runMode,
      autoReact: runMode === 'auto',
    },
    agentsOf: agents.value,
    // 前文注入直接取对话消息（跨任务历史天然包含；不再需要单独的群聊缓冲）
    historyMessages: ((swarmRunChat()?.messages || []) as any),
    chatHistory: [],
    locale: store.locales,
    addOutput,
    setAgentState,
    runAgent: executeAgent,
    retrieveKnowledge: retrieveKnowledgeForAgent,
  }

  try {
    const useTeam = settings.value?.collabMode === 'team'
    const strategy = resolveSwarmStrategy(swarmMode.value)
    // 运行代际守卫：切换预案（runEpoch 递增）后，本次运行的策略不再向当前集群 UI 写入、
    // 也不再启动新 Agent 会话；已创建的主进程会话继续在后台完成（结果不污染新集群）。
    const alive = () => runEpoch.value === myEpoch
    const gctx: SwarmRuntimeContext = {
      ...ctx,
      addOutput: (a, n, c) => { if (alive()) ctx.addOutput(a, n, c) },
      setAgentState: (i, p) => { if (alive()) ctx.setAgentState(i, p) },
      runAgent: (i, p, o) => (alive() ? ctx.runAgent(i, p, o) : Promise.resolve('')),
      retrieveKnowledge: (ag, q, f) => (alive() ? ctx.retrieveKnowledge(ag, q, f) : Promise.resolve('')),
    }
    if (useTeam) await runEpisode(gctx, opts)
    else await strategy.run(gctx)
  } catch (err: any) {
    if (runEpoch.value === myEpoch) {
      addOutput('system', '错误', `${err?.message || err}`)
      if (swarmJob && aikmDsh?.jobs?.fail) {
        try { aikmDsh.jobs.fail(swarmJob, `${err?.message || err}`) } catch { /* 忽略 */ }
      }
    }
  } finally {
    // 计时器无条件清理（防 interval 泄漏）；其余收尾仅在仍属当前运行时执行
    // （切换预案后 running 已由 resetSwarmDefinition 复位，旧运行不写文件/不完成 job）
    stopElapsedTimer()
    // 撤销本次 Swarm 声明的远端并发上限（完成/停止/切换预案都释放，避免残留抬高全局并发）
    await agentBridge.revokeConcurrency(swarmScopeId).catch(() => {})
    if (runEpoch.value !== myEpoch) return
    running.value = false
    scrollToBottom()
    if (swarmJob && aikmDsh?.jobs?.complete) {
      try { aikmDsh.jobs.complete(swarmJob, { mode: swarmMode.value }) } catch { /* 忽略 */ }
    }
    setActiveSwarmJobId(null)
  }
}

// ---------------------------------------------------------------------------
// 断点续跑（项目组）：保留的任务板继续跑未完成任务
// ---------------------------------------------------------------------------

export const resumeSwarm = async (chatId?: string): Promise<void> => {
  if (running.value) return
  if (chatId) setSwarmRunChatId(chatId)
  const chat = swarmRunChat()
  const msgs = ((chat?.messages || []) as any[])
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user' && m.content)
  const goal = roomOf(chatId || swarmRunChatId.value || '')?.episode?.goal
  const task = String(lastUser?.content || goal || '').trim()
  if (!task) return
  await runSwarm(task, undefined, { resume: true })
}

// ---------------------------------------------------------------------------
// 点名执行（@成员 → 直接唤起，不经管理器/策略；并行对点名人各自执行并汇报）
// ---------------------------------------------------------------------------

export const runNamedTask = async (indices: number[], prompt: string): Promise<void> => {
  const targets = [...new Set(indices)].filter(i => i >= 0 && i < agents.value.length)
  if (!prompt.trim() || running.value || targets.length === 0) return
  const en = store.locales === 'en'
  // 本次点名所属运行代际：切换预案后不写当前集群 UI
  const myEpoch = runEpoch.value
  running.value = true
  currentRound.value = 0
  summonedMembers.value = []
  executionOrder.value = []
  invocationRunStates.value = {}
  agentStepViews.value = {}
  agentStepSeq.value = {}
  agentViewSeq.value = {}
  attachedSwarmViews.clear()
  selectedStepKey.value = null
  stepFollowUserPicked.value = false
  agentRunStates.value = {}
  targets.forEach(idx => {
    agentRunStates.value[idx] = { agentIdx: idx, status: 'pending', round: 1, stage: '点名', role: 'worker', detail: '', startTime: 0 }
  })
  startElapsedTimer()

  let swarmJob: string | null = null
  try {
    if (aikmDsh?.jobs?.start) {
      const names = targets.map(i => agents.value[i]?.name || `Agent ${i + 1}`).join('、')
      const j = await aikmDsh.jobs.start('swarm', 'swarm', `${en ? '@named' : '@点名'}: ${names}: ${prompt.slice(0, 40)}`)
      swarmJob = j.id
      setActiveSwarmJobId(j.id)
    }
  } catch { /* 无桌面环境时忽略 */ }

  const scopeId = `agent-swarm:${Date.now()}:${myEpoch}`
  await agentBridge.declareConcurrency(scopeId, Math.max(1, targets.length)).catch(() => {})
  // 点名任务同样作为群聊“我”消息置顶
  addOutput('user', store.locales === 'en' ? 'You' : '我', prompt)

  try {
    await Promise.all(targets.map(idx => executeAgent(idx, prompt, { stage: en ? 'Named' : '点名', role: 'worker' })))
  } catch (err: any) {
    if (runEpoch.value === myEpoch) {
      addOutput('system', '错误', `${err?.message || err}`)
      if (swarmJob && aikmDsh?.jobs?.fail) {
        try { aikmDsh.jobs.fail(swarmJob, `${err?.message || err}`) } catch { /* 忽略 */ }
      }
    }
  } finally {
    stopElapsedTimer()
    await agentBridge.revokeConcurrency(scopeId).catch(() => {})
    if (runEpoch.value !== myEpoch) return
    running.value = false
    scrollToBottom()
    if (swarmJob && aikmDsh?.jobs?.complete) {
      try { aikmDsh.jobs.complete(swarmJob, { mode: 'named' }) } catch { /* 忽略 */ }
    }
    setActiveSwarmJobId(null)
  }
}
