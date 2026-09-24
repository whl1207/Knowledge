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
import { ElMessageBox } from 'element-plus'
import { usestore } from '@/store'
import { agentBridge, type AgentSessionView } from '@/platform/agentBridge'
import { assembleAgentSystemPrompt, buildMcpServersContext, ensureAgentSkills, workspaceRoot } from '@/lib/agent/promptContext'
import { renderQuestionMarkdown, escapeHtml } from '@/lib/markdown/render'
import { toolsFromCapabilities } from '@/lib/agent/capabilities'
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
} from '@/store/swarmState'
import { getSkillPrompt } from '@/composables/swarm/useSwarmAgents'
// 消息写入对话（与普通/智能体模式同一套消息与渲染）
import { pushMemberMessage, pushUserTaskMessage, pushSystemMessage, finishMemberMessage, swarmRunChat } from '@/composables/swarm/useSwarmChat'
// 会话视图 → 消息投影（与 useAgentRun 共用同一实现，工具调用/思考样式天然一致）
import { projectStepsToUnits, projectKbInfo, projectUsage, projectTodos } from '@/lib/agent/projection'
import type { ChatMessage } from '@/types/chat'
import { resolveSwarmStrategy, type SwarmRuntimeContext, type AgentRunOpts } from '@/lib/agent/swarmStrategies'

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
    /** 已收集来源的 kb_search 调用 */
    const processedKb = new Set<string>()
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
      if (alive() && chat) projectTodos(chat, v)
      // 状态投影（工具调用中 / 思考中）
      const st = alive() ? agentRunStates.value[agentIdx] : undefined
      if (st && v.status === 'running') {
        const lastStep = v.steps[v.steps.length - 1]
        const runningTool = lastStep?.toolCalls.find(tc => tc.status === 'running')
        if (runningTool) { st.status = 'tool'; st.detail = `调用工具: ${runningTool.name}` }
        else { st.status = 'thinking'; st.detail = '' }
      }
      // ask_user 提问：弹窗收集回答（对齐预设行为；按 askId 去重）
      if (alive() && v.pendingQuestion && !handledAsks.has(v.pendingQuestion.askId)) {
        handledAsks.add(v.pendingQuestion.askId)
        if (st) { st.status = 'tool'; st.detail = '等待用户回答' }
        const name = agents.value[agentIdx]?.name || `Agent ${agentIdx + 1}`
        const questionHtml =
          `<div class="agent-question-markdown"><strong>${escapeHtml(name)}</strong>：${renderQuestionMarkdown(v.pendingQuestion.question)}</div>`
        ElMessageBox.prompt(questionHtml, store.locales === 'en' ? 'Agent asks' : 'Agent 提问', {
          dangerouslyUseHTMLString: true,
          customClass: 'agent-question-box',
          confirmButtonText: store.locales === 'en' ? 'Send' : '发送',
          cancelButtonText: store.locales === 'en' ? 'Cancel' : '取消',
          inputPlaceholder: store.locales === 'en' ? 'Type your answer...' : '请输入你的回答...',
        })
          .then(({ value }) => agentBridge.answer(view.id, v.pendingQuestion!.askId, value || ''))
          .catch(() => agentBridge.cancel(view.id, 'user'))
      }
      if (v.status === 'idle' && sawRunning && !v.pendingQuestion) {
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
  if (window.dsh?.jobs?.progress && activeSwarmJobId) {
    try {
      const total = agents.value.length
      const done = allAgentIndices().filter(i => {
        const s = agentRunStates.value[i]?.status
        return s === 'done' || s === 'error'
      }).length
      window.dsh.jobs.progress(activeSwarmJobId, total > 0 ? Math.round((done / total) * 100) : null, `${done}/${total} ${store.locales === 'zh' ? 'Agent 完成' : 'agents done'}`)
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

  // 兜底路径（无桌面 agent 循环）
  if (!window.dsh?.agent || !agentBridge.available) {
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
    const tools = isGeneric ? [] : buildSwarmTools(a)
    const mcp = isGeneric ? null : agentMcpConfig(a)
    const options: AgentOptions = {
      systemPrompt: sysContent,
      provider,
      config,
      llmConfig: {
        ...llmConfig,
        temperature: isGeneric ? llmConfig.temperature : (typeof a.temperature === 'number' ? a.temperature : llmConfig.temperature),
      },
      tools,
      cwd: workspaceRoot(store) || undefined,
      label: `swarm:${displayName}`,
      kbPaths: isGeneric ? undefined : (a.capabilities.accessKnowledgeBase ? a.capabilities.knowledgeBaseFiles : undefined),
      kbTopK: 5,
      // MCP：优先自身配置，历史预案回退关联预设（Agent 网格可编辑）
      mcpServerIds: mcp?.ids,
      mcpServerConfigs: mcp?.configs,
      mcpEquipmentIds: mcp?.equipmentIds,
      sandboxMode: store.pythonSandbox || (store.TrustedPython ? 'trusted' : 'safe'),
      scope: `swarm-${displayName}`,
      // 循环轮数：预设自带轮数为唯一例外，其余（含通用/自定义成员）一律用唯一数据源（不再写死 20）
      maxSteps: resolveAgentMaxSteps(
        (store.agentPresets || []).find((c: any) => c.id === (a as any).presetId)?.maxSteps,
        store.generalAgentMaxSteps,
      ),
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
        const text = await window.ipcRenderer.invoke('readFile', kbPath)
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
// 运行入口：策略注册表分派
// ---------------------------------------------------------------------------

/**
 * 发起一次集群运行。
 * @param rawTask 任务文本（由调用方从对话输入框捕获，集群不维护自己的输入状态）
 * @param modeOverride 本次临时覆盖的运行方式（缺省用集群默认模式）
 */
export const runSwarm = async (rawTask: string, modeOverride?: SwarmRunMode) => {
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
    if (window.dsh?.jobs?.start) {
      const j = await window.dsh.jobs.start('swarm', 'swarm', `${store.locales === 'zh' ? '集群执行' : 'Swarm run'}: ${taskText.slice(0, 40)}`)
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
    await strategy.run(gctx)
  } catch (err: any) {
    if (runEpoch.value === myEpoch) {
      addOutput('system', '错误', `${err?.message || err}`)
      if (swarmJob && window.dsh?.jobs?.fail) {
        try { window.dsh.jobs.fail(swarmJob, `${err?.message || err}`) } catch { /* 忽略 */ }
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
    if (swarmJob && window.dsh?.jobs?.complete) {
      try { window.dsh.jobs.complete(swarmJob, { mode: swarmMode.value }) } catch { /* 忽略 */ }
    }
    setActiveSwarmJobId(null)
  }
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
    if (window.dsh?.jobs?.start) {
      const names = targets.map(i => agents.value[i]?.name || `Agent ${i + 1}`).join('、')
      const j = await window.dsh.jobs.start('swarm', 'swarm', `${en ? '@named' : '@点名'}: ${names}: ${prompt.slice(0, 40)}`)
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
      if (swarmJob && window.dsh?.jobs?.fail) {
        try { window.dsh.jobs.fail(swarmJob, `${err?.message || err}`) } catch { /* 忽略 */ }
      }
    }
  } finally {
    stopElapsedTimer()
    await agentBridge.revokeConcurrency(scopeId).catch(() => {})
    if (runEpoch.value !== myEpoch) return
    running.value = false
    scrollToBottom()
    if (swarmJob && window.dsh?.jobs?.complete) {
      try { window.dsh.jobs.complete(swarmJob, { mode: 'named' }) } catch { /* 忽略 */ }
    }
    setActiveSwarmJobId(null)
  }
}
