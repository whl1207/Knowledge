/**
 * useAgentRun.ts — 智能体模式（agent2，含技能自动识别）/ 技能 / Agent 预设执行
 *
 * 依赖注入（避免循环初始化）：
 *   store、getCurrentChat、saveChats、scrollToBottom、scheduleAutoScroll、
 *   buildUserMessageFromUploads、inputText/currentUploads/autoScrollEnabled（ref）、
 *   skillManager、onSkillList/onSkillHelp。
 *
 * 说明：技能模式与智能体模式已合并（parseSkillIntent 自动识别 $技能名 / 列表 / help）；
 * Agent 预设模式（handleAgentPresetMode）与智能体模式共用同一 agent 循环 +
 * 统一工具注册表；PTC（程序化工具调用 / Code Mode）由**预设的呈现方式**声明
 * （presentation='ptc'，仅改变 run_code 呈现与系统提示叠加的 tools:sdk 段）。
 */

import { ref, type Ref } from 'vue'
import { usestore } from '@/store'
import { ElMessage, ElMessageBox } from 'element-plus'
import { agentBridge } from '@/platform/agentBridge'
import { isHostGuestRuntime } from '@/platform'
import { chatsRef } from '@/store/chats'
// 运行中「引导」：集群成员（发言中的 agent 会话）也接受 steer，其会话 id 记在 swarmState
import { agentRunStates, running as swarmRunning, swarmRunChatId } from '@/store/swarmState'
import { toolsFromCapabilities } from '@/lib/agent/capabilities'
// ask_user 结构化问答：弹窗排队在 store/askUser（渲染由全局 AskUserHost 承担）
import { requestUserAnswers, questionsOf, dismissAsk } from '@/store/askUser'
// exit_plan_mode 计划评审：弹窗排队在 store/planReview（渲染由全局 PlanReviewHost 承担）
import { requestPlanReview, dismissPlanReview, hasPlanReview } from '@/store/planReview'
// 会话视图 → 消息投影（与集群模式共用同一实现，保证工具调用/思考/来源样式一致）
import { projectStepsToUnits, projectKbInfo, projectUsage, projectTodos, projectPlan, projectPlanReview } from '@/lib/agent/projection'
import { estimateAgentSeedTokens, resolveLimitFor, getTokenScale, rememberTokenScale, tokenScaleKey } from '@/lib/contextUsage'
import {
  buildSkillAgentOptions,

  buildAutonomousSystemPrompt,
  SKILL_AGENT_DEFAULT_TOOLS,
  parseSkillIntent,
} from '@/lib/agent/skill'
import { assembleAgentSystemPrompt, buildMcpServersContext, ensureAgentSkills } from '@/lib/agent/promptContext'
// 每个聊天自己的激活工作区（智能体 cwd / 提示词里的当前工作目录都用它；未选过回落到 store.root）
import { readChatWorkspace } from '@/shared/chatWorkspace'
// 工具呈现方式：PTC = 补 run_code 白名单 + 系统提示叠加 tools:sdk 段（统一实现在 lib/agent/presentation）
import { applyToolPresentation } from '@/lib/agent/presentation'
import { presetPresentation } from '@/lib/agent/ptc'
import type { Chat, ChatMessage, UploadItem } from '@/types/chat'
import type { AgentOptions } from '@/types/agent'
import { normalizeAgentMaxSteps, resolveAgentMaxSteps } from '@/shared/agent-loop-rounds'
import { buildAgentAttachmentContext } from '@/shared/fileAttachmentContext'
import { normalizeLlmType, resolveLlmSource, resolvePresetLlmType, resolvePresetModel } from '@/shared/llmSources'
import { AIUtils } from '@/shared/ai-core'
import { prepareImageDataUrl } from '@/lib/image/prepareImage'

export interface AgentRunDeps {
  getCurrentChat: () => Chat
  saveChats: () => void
  scrollToBottom: () => void
  scheduleAutoScroll: () => void
  /** 组装用户消息（上传文件内容 + 文本） */
  buildUserMessageFromUploads: (message: string) => {
    content: string
    images?: Array<string | Uint8Array | ArrayBuffer>
    fileAttachments?: ChatMessage['fileAttachments']
  }
  inputText: Ref<string>
  currentUploads: Ref<UploadItem[]>
  autoScrollEnabled: Ref<boolean>
  /** 技能管理器（取技能定义 / 列表 / $mention 解析） */
  skillManager: {
    getSkill(name: string): { name?: string; body?: string; content?: string; files?: string[]; description?: string; path?: string; baseDir?: string; fileCount?: number } | undefined
    getSkills(): Array<{ name: string; description?: string; path?: string; body?: string; content?: string }>
    parseSkillMention(input: string): { skillName: string; rest: string } | null
  }
  /** 技能列表请求渲染（智能体模式识别到「技能列表」类输入时回调） */
  onSkillList: () => Promise<void> | void
  /** 技能帮助请求渲染（智能体模式识别到「help 技能名」时回调） */
  onSkillHelp: (skillName: string) => Promise<void> | void
  /** 第一轮对话完成后的标题提取回调（传给 home 的 generateChatTitle；chat 为该会话实际所属聊天） */
  generateChatTitle?: (firstResponse: string, chat?: any) => Promise<void> | void
  /** 智能体会话结束后的步骤指示器清理（home 传入，清空 step-success 等残留） */
  clearStepIndicator?: () => void
}

export function useAgentRun(deps: AgentRunDeps) {
  const store = usestore()
  const { getCurrentChat, saveChats, scrollToBottom, scheduleAutoScroll, buildUserMessageFromUploads, inputText, currentUploads, autoScrollEnabled, skillManager, onSkillList, onSkillHelp, generateChatTitle, clearStepIndicator } = deps

  /** 当前 agent 会话 id（供设置页控制台/日志引用；智能体与技能新路径会设置） */
  const agentSessionId = ref<string | null>(null)
  /**
   * 各 agent 会话的消息流订阅（viewId → 退订函数）。
   * 多对话可同时在后台推理：每个会话独立注册监听器，互不退订，
   * 使 A 推理时切到 B 启动新会话，A 的流式更新仍持续投影到 A 的 assistantMsg。
   */
  const agentChatUnsubs = new Map<string, () => void>()
  /**
   * 已恢复到弹窗的「补答评审」（reviewId）。进程重启后聊天存档里仍挂着的那条评审
   * 只需要被重新摆出来一次：用户裁决后写日志 + 记进 planDecision，就不该再弹。
   */
  const restoredReviewIds = new Set<string>()
  /** 组件卸载时统一退订（由 home.vue 调用） */
  const disposeAgentRun = () => {
    for (const unsub of agentChatUnsubs.values()) unsub()
    agentChatUnsubs.clear()
  }

  /** 从 store + 聊天配置组装 agent 循环需要的 provider 配置 */
  const buildAgentProviderConfig = (llmType: string) => {
    const llm = store.AIconfig.llm
    const chat = getCurrentChat()
    let config: any = {}
    // 自定义来源：执行跟随聊天右上角绑定的来源索引（切到某自定义来源后，本聊天用该来源跑）。
    // 仅在读取的同步区间内临时 apply 该来源，用后立即恢复设置页当前激活来源，不污染全局状态。
    let customSwap: number | null = null
    if (llmType === 'custom') {
      const idx = chat.config?.customSourceIndex
      const sources = Array.isArray(llm.custom?.sources) ? llm.custom.sources : []
      const orig = llm.custom?.activeIndex
      if (typeof idx === 'number' && idx >= 0 && idx < sources.length && idx !== orig) {
        store.applyCustomSourceIndex(idx)
        customSwap = orig
      }
    }
    try {
      // 单来源解析：DeepSeek 只有一个来源（deepseek），接口样式随 config.api_style 下发；历史别名在此归一
      config = resolveLlmSource(llm, llmType).config
    } finally {
      if (customSwap !== null) store.applyCustomSourceIndex(customSwap)
    }
    // 聊天级模型覆盖（每个聊天可单独选模型：右上角选择的模型优先于预设默认）
    if (chat.config.model) config.model = chat.config.model
    const type = normalizeLlmType(llmType)
    const llmConfig: any = {
      ...llm,
      type,
      stream: true,
      temperature: llm.temperature,
      max_tokens: llm.max_tokens,
    }
    // 聊天级温度覆盖（Agent 预设选中时由 selectAgentPreset 写入）
    if (typeof chat.config.temperature === 'number') llmConfig.temperature = chat.config.temperature
    return { provider: type, config, llmConfig }
  }

  /** 把 agent 会话的流式输出接入聊天消息（复用桥接层的状态投影） */
  const attachAgentToChat = (viewId: string, assistantMsg: ChatMessage, chatRef?: Chat) => {
    // 本会话已有的订阅先退订（防止重复注册同一 viewId 的监听器）
    const existing = agentChatUnsubs.get(viewId)
    if (existing) { existing(); agentChatUnsubs.delete(viewId) }
    let sawRunning = false // 是否进入过 running（防止 send 前初始 idle 误判结束）
    const processedKb = new Set<string>() // 已收集来源的 kb_search 调用
    const handledAsks = new Set<string>() // 已弹窗的 ask_user 提问（按 askId 去重）
    let openAskId: string | null = null // 当前弹窗对应的 askId（agent 收口后据此清理弹窗）
    const handledReviews = new Set<string>() // 已弹窗的计划评审（按 reviewId 去重）
    let openReviewId: string | null = null // 当前计划评审弹窗对应的 reviewId
    // 服务端搜索事件队列消费（按返回时间推进 UI，事件到达即处理，天然流式、不丢）：
    let consumedSearchEvents = 0 // 已消费的事件数
    let openReasoningId: string | null = null // 当前 running 的思考段单元 id
    let openReasoningStart = 0 // 当前思考段在全量推理文本中的起始偏移
    let lastReasoningLen = 0 // 已消费的推理文本长度
    let searchActive = false // 服务端搜索是否已激活（首个事件时初始化）
    let tlSeq = 0 // 单元序号（保证时间顺序稳定）
    let notifiedCompactSeq = 0 // 已提示过的上下文压缩序号（每次压缩只弹一次完成提示）
    // 思考/工具时间线投影：与集群模式共用同一实现（见 src/lib/agent/projection）
    const projectSteps = (v: any) => {
      const { lastTool } = projectStepsToUnits(assistantMsg, v)
      // 输入区右侧的最新工具调用快照（仅统计工具单元，跳过思考单元）
      if (lastTool) {
        const ownerChat = chatRef ?? getCurrentChat()
        ownerChat.agentLastTool = {
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
    const unsub = agentBridge.on((v) => {
      if (v.id !== viewId) return
      // 是否已进入 running：agentBridge.send() 在发送前会先 notify 一次（status 仍为初始 idle），
      // 必须等到真正 running 后再出现的 idle 才算会话结束，否则一发送就误判完成。
      if (v.status === 'running') sawRunning = true
      projectKbInfo(assistantMsg, v, processedKb)
      projectUsage(assistantMsg, v)
      // 校准系数回传：主进程实测的「真实/估算」比值按来源 + 模型记住（聊天模式的预算与圆环复用）
      if (typeof (v as any).tokenScale === 'number' && assistantMsg.ctxScaleKey) {
        const [p, m] = String(assistantMsg.ctxScaleKey).split('::')
        rememberTokenScale(p, m, (v as any).tokenScale)
      }
      // 思考/工具调用 → executionUnits 时间线 + 输入区快照
      projectSteps(v)
      // 上下文压缩完成提示（时间线里的卡片由投影生成，这里再给一次可见提示，与普通聊天同口径）
      const compaction: any = v.compaction
      if (compaction && compaction.phase === 'done' && compaction.seq > notifiedCompactSeq) {
        notifiedCompactSeq = compaction.seq
        ElMessage.info(compaction.kind === 'overflow-retry'
          ? (store.locales == 'zh'
            ? '上下文超限，已自动压缩较早的对话并重试'
            : 'Context limit exceeded — earlier turns were summarized and the request retried.')
          : (store.locales == 'zh'
            ? '上下文占用较高，已自动压缩较早的对话（原消息仍保留）'
            : 'Context was getting long — earlier turns were summarized (original messages are kept).'))
      }
      // ask_user 提问：结构化弹窗收集回答（全局唯一宿主 AskUserHost；按 askId 去重）。
      // 主进程 ask_user 工具会挂起等待 agent:answer 回复，若不弹窗该工具永远不返回，
      // 会话结束时其 tool/result 缺失 → 日志显示「工具结果缺失」。
      // 支持单选 / 多选 / 多题 / 自定义回答（见 components/agent/AskUserDialog.vue）。
      if (v.pendingQuestion && !handledAsks.has(v.pendingQuestion.askId)) {
        handledAsks.add(v.pendingQuestion.askId)
        const q = v.pendingQuestion
        const name = assistantMsg.model ? '' : (store.locales == 'zh' ? '智能体' : 'Agent')
        openAskId = q.askId
        requestUserAnswers({
          askId: q.askId,
          source: name,
          questions: questionsOf(q),
          onCancel: () => { void agentBridge.cancel(viewId, 'user') },
        })
          .then((answers) => agentBridge.answer(viewId, q.askId, '', answers))
          .catch(() => { /* 已在 onCancel 里收口（中止 turn） */ })
          .finally(() => { if (openAskId === q.askId) openAskId = null })
      }
      projectTodos(chatRef ?? getCurrentChat(), v)
      projectPlan(chatRef ?? getCurrentChat(), v)      // 服务端联网搜索（deepseek-responses）→ 消费 searchEvents 事件队列（按返回时间推进 UI）：
      // reasoning 更新思考段，search/open/done 封口思考段并插入搜索/访问/结果单元，严格交错
      // （事件队列独立于 searchStatus：搜索前的推理事件也在此消费）
      if (v.searchEvents && v.searchEvents.length > consumedSearchEvents) {
        assistantMsg.webSearch = assistantMsg.webSearch || { status: 'idle', results: [] }
        const events = v.searchEvents
        const step = (v.steps || []).find((s: any) => s.reasoning) || (v.steps || [])[0]
        const fullReasoning = step?.reasoning || ''
        // 首次激活：若 projectSteps 已生成聚合思考单元（搜索前推理），封口它并跳过对应推理长度
        if (!searchActive) {
          searchActive = true
          const cur = assistantMsg.executionUnits || []
          const reasoningIdx = cur.findIndex((u: any) => u.stepType === 'reasoning' && String(u.id).startsWith('reasoning-') && !String(u.id).includes('tl-'))
          if (reasoningIdx >= 0) {
            cur[reasoningIdx] = { ...cur[reasoningIdx], status: 'success', endTime: Date.now() }
            assistantMsg.executionUnits = [...cur]
            // 聚合思考单元已显示搜索前推理：推理游标跳到当前全长，避免事件队列重复切分
            lastReasoningLen = fullReasoning.length
          }
        }
        // upsert 执行单元（每次从最新 executionUnits 读取，避免快照过期）
        const up = (id: string, patch: any) => {
          const cur = assistantMsg.executionUnits || []
          const idx = cur.findIndex((u: any) => u.id === id)
          if (idx >= 0) {
            cur[idx] = { ...cur[idx], ...patch }
            assistantMsg.executionUnits = [...cur]
          } else {
            assistantMsg.executionUnits = [...cur, { ...patch, id }]
          }
        }
        // 封口当前思考段（搜索/访问/完成事件打断时）
        const closeReasoning = () => {
          if (openReasoningId) {
            const cur = assistantMsg.executionUnits || []
            const idx = cur.findIndex((u: any) => u.id === openReasoningId)
            if (idx >= 0) {
              cur[idx] = { ...cur[idx], status: 'success', endTime: Date.now() }
              assistantMsg.executionUnits = [...cur]
            }
            openReasoningId = null
          }
        }

        // 消费事件队列（从上次位置起，每个事件按到达顺序处理）
        for (let i = consumedSearchEvents; i < events.length; i++) {
          const ev = events[i]
          if (ev.kind === 'reasoning') {
            // 推理推进：全量文本增长 → 更新/新建当前思考段（每段只显示本段新增，流式）。
            // 注意：推理文本在 step / 续接轮次边界会重置（从空重新累积），并非单调递增。
            // 因此一旦长度变小，视为新的一段思考——封口旧段并把游标归零，从 0 重新切分，
            // 否则新段开头会因「长度未超过上一段」而被跳过（截断）。
            const evText = ev.text || ''
            if (evText.length < lastReasoningLen) {
              closeReasoning()
              lastReasoningLen = 0
              openReasoningStart = 0
            }
            if (evText.length > lastReasoningLen) {
              if (!openReasoningId) {
                tlSeq++
                openReasoningId = `reasoning-tl-${tlSeq}`
                openReasoningStart = lastReasoningLen
                up(openReasoningId, {
                  status: 'running', stepType: 'reasoning', description: 'reasoning',
                  args: undefined, result: evText.slice(openReasoningStart), error: undefined,
                  startTime: ev.at || Date.now(),
                })
              } else {
                up(openReasoningId, { result: evText.slice(openReasoningStart) })
              }
              lastReasoningLen = evText.length
            }
          } else if (ev.kind === 'search') {
            // 搜索：封口思考段 + 新建/更新「服务端搜索」单元（查询词作为入参，等待结果）。
            // 与 done 事件共用同一个单元 id（按查询词），完成后在同一张 tool-box 里补结果。
            closeReasoning()
            assistantMsg.webSearch.status = 'searching'
            if (ev.query) assistantMsg.webSearch.query = ev.query
            tlSeq++
            const qKey = String(ev.query || '').trim() || `q-${tlSeq}`
            up(`server-search-${qKey}`, {
              status: 'running', stepType: 'tool', description: 'server-search',
              args: { query: ev.query || '' }, error: undefined,
              startTime: ev.at || Date.now(),
            })
          } else if (ev.kind === 'open') {
            // 访问网页：封口思考段 + 独立「访问网站」单元（与搜索单元动作不同，分开展示）
            closeReasoning()
            tlSeq++
            up(`server-search-open-${tlSeq}`, {
              status: 'success', stepType: 'tool', description: 'server-search-visit',
              args: undefined, result: `- ${ev.url || ''}`, error: undefined,
              startTime: ev.at || Date.now(), endTime: ev.at || Date.now(),
            })
          } else if (ev.kind === 'done') {
            // 结果：封口思考段 + 联网状态完成 + 在同一张「服务端搜索」卡片上补结果
            closeReasoning()
            assistantMsg.webSearch.status = 'completed'
            if (ev.query) assistantMsg.webSearch.query = ev.query
            const results = ev.results || []
            if (results.length > 0) {
              const existing = assistantMsg.webSearch.results || []
              const seen = new Set(existing.map((r: any) => r?.url))
              const merged = [...existing]
              results.forEach((r: any) => {
                if (r?.url) {
                  if (!seen.has(r.url)) { seen.add(r.url); merged.push(r) }
                } else if (!existing.includes(r)) {
                  merged.push(r)
                }
              })
              assistantMsg.webSearch.results = merged
              tlSeq++
              // 单元 id 与 search 事件一致（按查询词），同一张卡片：参数区显示查询词，
              // 结果区显示标题/链接的纯文本列表（不做 markdown 渲染、不加摘要行）。
              const qKey = String(ev.query || '').trim() || `done-${tlSeq}`
              const patch: any = {
                status: 'success', stepType: 'tool', description: 'server-search',
                error: undefined,
                result: merged.map((r: any, i: number) => {
                  const title = String(r?.title || '').trim()
                  const url = String(r?.url || '').trim()
                  // title 为空或与 url 相同：只显示一行 url，避免重复
                  return title && title !== url ? `${i + 1}. ${title}\n   ${url}` : `${i + 1}. ${url}`
                }).join('\n'),
                endTime: ev.at || Date.now(),
              }
              if (ev.query) patch.args = { query: ev.query }
              up(`server-search-${qKey}`, patch)
            }
          }
        }
        consumedSearchEvents = events.length
        // 收尾：若全部事件消费完但推理仍在流式（无后续事件），保留当前思考段 running
      }
      if (v.currentStream) {
        assistantMsg.content = v.currentStream
        assistantMsg.streaming = true
        scheduleAutoScroll()
      } else if (v.lastAssistantContent) {
        assistantMsg.content = v.lastAssistantContent
        assistantMsg.streaming = false
      }
      // exit_plan_mode 计划评审：弹窗等用户裁决（Approve / 继续完善 / 关闭），
      // 裁决经同一条 agent:answer 通道回传（message = 裁决，answers[0].custom = 反馈）。
      projectPlanReview(chatRef ?? getCurrentChat(), v)
      if (v.pendingPlanReview && !handledReviews.has(v.pendingPlanReview.reviewId)) {
        handledReviews.add(v.pendingPlanReview.reviewId)
        const r = v.pendingPlanReview
        const who = assistantMsg.model ? '' : (store.locales == 'zh' ? '智能体' : 'Agent')
        openReviewId = r.reviewId
        requestPlanReview({ reviewId: r.reviewId, source: who, plan: r.plan })
          .then(({ verdict, feedback }) =>
            agentBridge.answer(viewId, r.reviewId, verdict, feedback ? [{ id: 'feedback', selected: [], custom: feedback }] : undefined))
          .catch(() => { /* 评审已失效（turn 被中止 / 别处已裁决） */ })
          .finally(() => { if (openReviewId === r.reviewId) openReviewId = null })
      }
      if (openReviewId && !v.pendingPlanReview) {
        dismissPlanReview(openReviewId)
        openReviewId = null
      }
      // agent 侧已收口（turn 被中止 / 别处已回答）：丢掉还没人提交的弹窗，避免它一直挂着
      if (openAskId && !v.pendingQuestion) {
        dismissAsk(openAskId)
        openAskId = null
      }
      // 结束判定：只要“已开始运行 + 进入 idle + 无挂起提问 + 消息仍标记执行中”即视为结束。
      // 不再要求“至少一条真实输出/工具时间线”——若智能体启动即报错/超时且无任何产出，
      // 也必须立即清理转圈并解锁聊天，否则该聊天会因 isExecuting/isGenerating 残留而永久卡死。
      const finalReplyDone = v.status === 'idle' && sawRunning && !v.pendingQuestion && !v.pendingPlanReview && assistantMsg.isExecuting
      if (finalReplyDone) {
        assistantMsg.isExecuting = false
        assistantMsg.streaming = false
        assistantMsg.executionTime = Date.now() - assistantMsg.timestamp
        // 结束却无任何产出（如启动即报错/无输出）：补一条可见提示，避免空白幽灵气泡；
        // 该标记同时用于跳过“用错误文本生成聊天标题”
        const noRealOutput = !Boolean(
          assistantMsg.content ||
          (Array.isArray(assistantMsg.executionUnits) && assistantMsg.executionUnits.length > 0)
        )
        if (noRealOutput) {
          assistantMsg.content = v.lastError
            ? (store.locales == 'zh' ? `（执行出错：${v.lastError}）` : `(Execution error: ${v.lastError})`)
            : (store.locales == 'zh' ? '（本次执行未产生内容）' : '(No output produced this run)')
        }
        // 最终输出由消息区（message-content）显示：移除时间线里所有「内容与最终输出完全相同」的
        // reasoning/content 单元——该正文可能经 reasoning 通道或 content 通道各出现一次，
        // 避免最终输出在 tool-box（思考过程）与消息区重复显示；中间的思考/方案单元（内容不同）保留。
        if (assistantMsg.content) {
          const finalText = String(assistantMsg.content || '').trim()
          const units = assistantMsg.executionUnits || []
          if (finalText) {
            const filtered = units.filter((u: any) => !(
              u && (u.stepType === 'content' || u.stepType === 'reasoning') &&
              String(u.result || '').trim() === finalText
            ))
            if (filtered.length !== units.length) assistantMsg.executionUnits = filtered
          }
        }
        // 结束状态写到「本会话所属的聊天」，而不是 getCurrentChat()：
        // 用户可能在执行期间切到其它对话（并已开始新的推理），不能误清其它聊天的 isGenerating。
        // 仅当本会话的 assistantMsg 仍在该聊天中时清除该聊天的 isGenerating
        // （agent 单会话结束即代表该聊天本轮的生成完成）。
        const ownerChat = chatRef ?? getCurrentChat()
        if (ownerChat && ownerChat.isGenerating && ownerChat.messages.includes(assistantMsg)) {
          ownerChat.isGenerating = false
        }
        // 智能体运行结束：清除步骤指示器残留（step-success 等），避免运行成功后仍显示
        clearStepIndicator?.()
        if (v.lastError) {
          ElMessage.error(store.locales == 'zh' ? `执行出错：${v.lastError}` : `Execution error: ${v.lastError}`)
        }
        saveChats()
        // 第一轮对话完成后提取标题（对齐普通对话：标题为空且已有首条 assistant 回复；
        // 传 ownerChat 以定位实际所属聊天，用户切走时仍命名正确聊天）
        const finalContent = assistantMsg.content || v.lastAssistantContent || ''
        if (generateChatTitle && ownerChat && !ownerChat.title && finalContent && !noRealOutput) {
          generateChatTitle(finalContent, ownerChat)
        }
        // 会话已结束，退订本会话监听（多对话并行时不影响其它会话）
        const done = agentChatUnsubs.get(viewId)
        if (done) { done(); agentChatUnsubs.delete(viewId) }
      }
    })
    agentChatUnsubs.set(viewId, unsub)
  }

  /**
   * 恢复「进程结束后仍在等待裁决」的计划评审（exit_plan_mode）。
   *
   * 主进程的挂起评审随进程消失，但两处事实还在：聊天存档的 `pendingPlanReview`
   * 与会话日志里缺失裁决的 `plan/review`。于是把弹窗重新摆给用户：
   *  - 会话还活着 → 常规 agent:answer，工具当场拿到裁决继续跑；
   *  - 会话已结束 → 主进程把裁决**补记**进日志（resolveAnswer 的兜底分支），
   *    同时把决策存进聊天存档，由下一次开场作为种子交给新会话
   *    （AgentOptions.seedPlanDecision，写成一条已记录的 user 消息）。
   *
   * 由 reconcileAgentRuns 在启动 / 周期对账时调用，只对**当前聊天**生效：
   * 别的聊天里的待评审不会突然抢占界面，等用户切过去再问。
   */
  const restorePendingPlanReview = async () => {
    const chat = getCurrentChat() as any
    const pending = chat?.pendingPlanReview
    if (!pending?.reviewId || !pending.sessionId) return
    if (restoredReviewIds.has(pending.reviewId) || hasPlanReview(pending.reviewId)) return
    restoredReviewIds.add(pending.reviewId)
    // 先与会话事实对账（日志折叠的待评审才是权威）：已裁决过就把存档标记清掉，不再打扰用户
    try {
      const authoritative = await agentBridge.fetchState(pending.sessionId)
      if (authoritative && !authoritative.pendingPlanReview) {
        if (chat.pendingPlanReview?.reviewId === pending.reviewId) chat.pendingPlanReview = null
        saveChats?.()
        return
      }
    } catch {
      // 会话日志不可用（已清理 / 非桌面端）：退回聊天存档，照常问
    }
    const who = store.locales == 'zh' ? '智能体' : 'Agent'
    requestPlanReview({ reviewId: pending.reviewId, source: who, plan: pending.plan })
      .then(async ({ verdict, feedback }) => {
        const answers = feedback ? [{ id: 'feedback', selected: [], custom: feedback }] : undefined
        const live = agentBridge.get(pending.sessionId)
        const sessionAlive = !!live && live.status !== 'disposed'
        try {
          await agentBridge.answer(pending.sessionId, pending.reviewId, verdict, answers)
        } catch {
          // 会话已不在（补记也失败）：不影响把决策留给下一轮
        }
        if (!sessionAlive) {
          chat.planDecision = { verdict, feedback: feedback || undefined, plan: pending.plan }
        }
        if (chat.pendingPlanReview?.reviewId === pending.reviewId) chat.pendingPlanReview = null
        saveChats?.()
      })
      .catch(() => { /* 界面被别处收起：保留存档，下次再问 */ })
  }

  /**
   * 智能体运行状态对账（兜底清理 + 切模块重进恢复）：
   * 逐个检查仍标记「执行中」的智能体 assistant 消息（executionType='skill' 且有 agentViewId），
   * 与主进程 agent 会话真实状态核对：
   *  - 会话已结束（idle/disposed）或已不存在（主进程清理）→ 立即恢复完成态：清转圈、解锁聊天；
   *  - 会话仍在 running/stopping，但本组件此前退订（切模块后台运行后重进）→ 重新挂接监听，
   *    恢复实时投影与结束清理；
   *  - 无 agentViewId 的孤儿消息：无法恢复也永远不会收到收尾事件 → 直接清执行态解锁。
   * 保持「执行中不能发送」规则：非手动停止时，只要主进程会话确实还在跑，就不会解锁。
   * @param force       手动停止（用户点「停止」）后强制收尾：即使主进程仍在停止中，
   *                    也立即取消残留会话、清转圈、解锁聊天（已生成内容/时间线保留）。
   * @param onlyChatId  仅对账该聊天（手动停止时作用在当前聊天，避免误停其它聊天的后台智能体）。
   * home.vue 在挂载时 / 周期定时器 / 停止兜底里调用。
   */
  const reconcileAgentRuns = (force = false, onlyChatId?: string) => {
    let changed = false
    for (const chat of (chatsRef.value || []) as any[]) {
      if (!chat || !Array.isArray(chat.messages)) continue
      if (onlyChatId && chat.id !== onlyChatId) continue
      for (const msg of chat.messages as any[]) {
        if (!msg || msg.role !== 'assistant') continue
        // 集群成员消息（swarmAgent）不参与智能体会话对账：其运行态由集群自身管理
        if (msg.swarmAgent || msg.executionType !== 'skill' || msg.isExecuting !== true) continue
        const viewId = msg.agentViewId as string | undefined
        const view = viewId ? agentBridge.get(viewId) : undefined
        const alive = !!view && (view.status === 'running' || view.status === 'stopping')
        // 非手动停止且主进程会话仍存活：维持「执行中」（不解锁），只补挂监听等 idle 收尾
        if (!force && viewId && alive) {
          // 主进程仍在执行：若监听因切模块丢失，重新挂接（其结束清理会自动接管收尾）
          if (!agentChatUnsubs.has(viewId)) attachAgentToChat(viewId, msg, chat)
          continue
        }
        // 收尾分支：
        //  - force：用户手动停止 → 取消残留会话 + 立即清转圈解锁（保留已产出记录）；
        //  - 会话已结束/已消失：回补内容后清执行态解锁；
        //  - 无 agentViewId 的孤儿消息：无法恢复也永远等不到收尾事件 → 直接清执行态解锁。
        changed = true
        if (viewId) {
          const done = agentChatUnsubs.get(viewId)
          if (done) { done(); agentChatUnsubs.delete(viewId) }
          // 手动停止 / 对账发现会话已不在：确认性取消残留会话（尽力而为，幂等）
          if (force || !alive) agentBridge.cancel(viewId, 'user').catch(() => {})
          // 结束时若消息内容缺失（切模块期间收尾事件被退订漏接），从主进程视图回补最终内容
          if (!msg.content && view) {
            const stepTexts = (view.steps || [])
              .map((s: any) => s?.content || s?.stream || '')
              .filter(Boolean)
            const backfill = view.lastAssistantContent || stepTexts[stepTexts.length - 1] || ''
            if (backfill) msg.content = backfill
          }
        }
        msg.isExecuting = false
        msg.streaming = false
        if (!msg.executionTime) msg.executionTime = Date.now() - (msg.timestamp || Date.now())
        // 结束却无任何产出：补提示，避免空白幽灵气泡（手动停止 / 有 lastError / 中断各给提示）
        const hadOutput = Boolean(
          msg.content ||
          (Array.isArray(msg.executionUnits) && msg.executionUnits.length > 0) ||
          (view && (view.lastAssistantContent ||
            (Array.isArray(view.steps) && view.steps.some((s: any) =>
              s?.content || s?.reasoning || (Array.isArray(s.toolCalls) && s.toolCalls.length > 0)
            ))))
        )
        if (!hadOutput) {
          const err = view?.lastError
          // 还挂着计划评审（等用户裁决）时别说成"被中断"：它是在等人，不是在出错
          const awaitingReview = Boolean((chat as any).pendingPlanReview)
          msg.content = awaitingReview
            ? (store.locales == 'zh' ? '（等待计划评审）' : '(Awaiting plan review)')
            : force && !err
            ? (store.locales == 'zh' ? '（已手动停止）' : '(Stopped by user)')
            : err
              ? (store.locales == 'zh' ? `（执行出错：${err}）` : `(Execution error: ${err})`)
              : (store.locales == 'zh' ? '（本次执行未产生内容，可能已被中断）' : '(No output produced this run, may have been interrupted)')
        }
        if (chat.isGenerating && Array.isArray(chat.messages) && chat.messages.includes(msg)) {
          chat.isGenerating = false
        }
      }
    }
    // 仅在确有状态改动时持久化（对账 3s 一次，避免每次全量序列化大聊天）
    if (changed) {
      saveChats()
      clearStepIndicator?.()
    }
    // 兜底：把「进程结束后仍在等裁决」的计划评审重新摆出来（当前聊天，只弹一次）
    void restorePendingPlanReview()
  }

  /** 手动停止某聊天里所有执行中的智能体会话：
   *  立即取消主进程会话并退订监听、清转圈/解锁，但**保留**已生成的内容与工具时间线记录
   *  （未运行完的任务片段原样留在聊天里，供后续智能体继续读取上下文）。
   *  返回是否确有被停止的会话（有则调用方应再触发一次强制对账兜底）。 */
  const stopAgentsInChat = (chat: any): boolean => {
    if (!chat || !Array.isArray(chat.messages)) return false
    const targets = new Set<string>()
    let cleared = false
    for (const m of chat.messages as any[]) {
      if (!m || m.role !== 'assistant' || m.executionType !== 'skill' || m.isExecuting !== true) continue
      if (m.agentViewId) targets.add(m.agentViewId)
      cleared = true
    }
    for (const vid of targets) {
      // 取消主进程会话（异步；保留消息记录，不写“已停止”覆盖正文）
      agentBridge.cancel(vid, 'user').catch(() => {})
      const unsub = agentChatUnsubs.get(vid)
      if (unsub) { unsub(); agentChatUnsubs.delete(vid) }
    }
    if (!cleared) return false
    for (const m of chat.messages as any[]) {
      if (!m || m.role !== 'assistant' || m.executionType !== 'skill' || m.isExecuting !== true) continue
      m.isExecuting = false
      m.streaming = false
      // 未产出任何内容/时间线：补「已停止」提示，避免空白幽灵气泡；有产出则原样保留
      const hadOutput = Boolean(m.content || (Array.isArray(m.executionUnits) && m.executionUnits.length > 0))
      if (!hadOutput && !m.content) {
        m.content = store.locales == 'zh' ? '（已手动停止）' : '(Stopped by user)'
      }
      // 与正常结束一致：移除与最终正文完全相同的内容/思考单元，避免停止后时间线与消息区重复展示
      if (m.content && Array.isArray(m.executionUnits)) {
        const finalText = String(m.content).trim()
        if (finalText) {
          const filtered = m.executionUnits.filter((u: any) => !(
            u && (u.stepType === 'content' || u.stepType === 'reasoning') &&
            String(u.result || '').trim() === finalText
          ))
          if (filtered.length !== m.executionUnits.length) m.executionUnits = filtered
        }
      }
    }
    if (chat.isGenerating) chat.isGenerating = false
    clearStepIndicator?.()
    saveChats()
    return true
  }

  /**
   * 上传图片 → 任务附图（data URL 字符串数组）。
   * - `AIUtils.imageDataUrl`：把 base64 / data URL / Uint8Array / ArrayBuffer 统一成 data URL（保留 mime）；
   * - `prepareImageDataUrl`：长边限幅 + 转 JPEG —— agent 循环每个 step 都会重发历史里的图片，图越小越快越省；
   * - 必须是字符串：options 经 `agentBridge.sanitizeOptions` 做 JSON 序列化，typed array 会被破坏。
   */
  const toTaskImages = async (images?: Array<string | Uint8Array | ArrayBuffer>): Promise<string[]> => {
    const out: string[] = []
    for (const img of images || []) {
      const dataUrl = AIUtils.imageDataUrl(img)
      if (!dataUrl) continue
      out.push(await prepareImageDataUrl(dataUrl))
    }
    return out
  }

  /**
   * 附件 → 任务前缀：智能体模式**只注入附件路径**（正文由模型用文件工具按需读取），
   * 不再把 Word / Excel / Markdown 全文塞进 prompt（省 token，也避免同一内容读两遍）。
   * 仅进模型上下文，不写进聊天气泡正文（气泡另有附件 chips）。
   */
  const withFileAttachments = (message: string, fileAttachments?: ChatMessage['fileAttachments']): string => {
    if (!fileAttachments || fileAttachments.length === 0) return message
    const fileContext = buildAgentAttachmentContext(fileAttachments)
    return message ? `${fileContext}\n\n${message}` : fileContext
  }

  /**
   * 是否「局域网访客网页」（智能体循环跑在主机，能力由主机白名单决定）。
   * 与「无 ipcRenderer」不等价：安卓壳也没有 ipcRenderer，但它在页面里跑本地智能体循环。
   */
  const isLanGuest = isHostGuestRuntime()

  /** 创建 agent 会话并接入聊天（公共流程：创建 → 占位消息 → 订阅 → 发送） */
  const startAgentSessionInChat = async (
    options: AgentOptions,
    userInput: string,
    images?: Array<string | Uint8Array | ArrayBuffer>,
  ) => {
    if (!agentBridge.available) {
      ElMessage.error(store.locales == 'zh' ? '智能体当前不可用（环境缺少执行智能体循环的能力）' : 'Agent Loop is unavailable in this environment')
      return null
    }
    const chat = getCurrentChat()
    try {
      // 多模态附图（上传的图片）：转成 data URL 字符串塞进 options（JSON 安全），
      // 主进程只在内存里持有，并在每次请求时挂回「带图的那条 user 消息」
      const taskImages = await toTaskImages(images)
      // 上下文窗口上限：与主页圆环同源解析（手填 > 已加载实例探测 > 记住值 > 模型上限 > 来源默认），
      // 交给主进程做请求前预算检查与主动压缩（P0 上下文压缩）
      const contextLimit = resolveLimitFor(store.AIconfig.llm, {
        provider: options.provider,
        model: options.llmConfig?.model || options.config?.model,
        customSourceIndex: store.AIconfig.llm.custom?.activeIndex,
      }).limit
      // 估算校准系数：按「来源 + 模型」复用上次实测的「真实 / 估算」比值（本地后端 tokenizer 与
      // 字符启发式差异可达 ±30%），主进程据此修正请求前预算，并在运行中继续自校准
      const providerKey = String(options.provider || '')
      const modelKey = String(options.llmConfig?.model || options.config?.model || '')
      const tokenScale = getTokenScale(providerKey, modelKey)
      const view = await agentBridge.create({
        ...options,
        contextLimit,
        tokenScale,
        ...(taskImages.length ? { taskImages } : {}),
      })
      // 上一轮「进程重启后补答」的评审裁决已经写进新会话日志，聊天存档里的待交付标记可以清了
      if ((chat as any).planDecision) (chat as any).planDecision = undefined
      agentSessionId.value = view.id
      const assistantMsg: ChatMessage = {
        role: 'assistant', content: '', timestamp: Date.now(),
        executionType: 'skill' as any, isExecuting: true, streaming: true,
        model: chat.config.model,
        // 记录主进程 agent 会话 id：供运行状态对账 / 切模块重进恢复 / 停止映射
        agentViewId: view.id,
        // 上下文圆环的回退估算：system prompt / 工具 schema / 种子历史都不落在消息正文上，
        // 若后端不回传 usage，圆环只能靠这个估算值（见 @/lib/contextUsage）。
        ctxSeedTokens: estimateAgentSeedTokens({
          systemPrompt: options.systemPrompt,
          tools: options.tools,
          seedHistory: options.seedHistory,
        }),
        // 校准系数的记忆键：主进程实测的「真实/估算」比值会回传（agent/step-end.tokenScale），
        // 这里按「来源 + 模型」记住，供后续会话与普通聊天复用（见 lib/contextUsage）
        ctxScaleKey: tokenScaleKey(providerKey, modelKey),
      }
      chat.messages.push(assistantMsg)
      chat.isGenerating = true
      scrollToBottom()
      // 关键：chat.messages 内是 Vue reactive proxy；必须用数组中的响应式元素更新，
      // 否则 attachAgentToChat 里直接改 push 前的原始对象不触发依赖通知（token 计数/圆环
      // 需重开对话才刷新）。取出 push 后数组末尾的 proxy 作为更新目标。
      const reactiveAssistantMsg = chat.messages[chat.messages.length - 1] as ChatMessage
      attachAgentToChat(view.id, reactiveAssistantMsg, chat)
      await agentBridge.send(view.id, userInput)
      return view
    } catch (e: any) {
      chat.isGenerating = false
      // 启动/发送失败兜底：占位消息若仍为空，补写错误原因（isExecuting 交由结束清理/对账复位）
      const ghost = chat.messages[chat.messages.length - 1]
      if (ghost && ghost.role === 'assistant' && ghost.isExecuting && !ghost.content) {
        ghost.content = store.locales == 'zh'
          ? `启动智能体失败：${e?.message || e}`
          : `Failed to start agent: ${e?.message || e}`
        ghost.streaming = false
      }
      ElMessage.error(store.locales == 'zh' ? `启动智能体失败：${e?.message || e}` : `Failed to start agent: ${e?.message || e}`)
      return null
    }
  }

  /**
   * 网页端（局域网共享）智能体模式：**循环跑在主机**，本端只下发任务 + 渲染事件流。
   *
   * 与桌面端的差别（有意为之）：
   * - tools / cwd / sandbox / maxSteps / provider / config 本端一律不下发——
   *   主机按「设置 → 协作 → 权限」的访客白名单自行决定（下发也会被忽略）；
   * - 系统提示由主机组装（含主机技能库清单、共享知识库、可用工具清单）；
   * - 技能已并入智能体：输入 `$技能名 任务` 时由主机解析技能并注入指令（需主机开放 skill 工具）；
   * - 会话逐轮独立（与桌面一致）：每轮新建主机会话，用本端聊天记录作为种子历史衔接上下文。
   */
  const handleBrowserAgentMode = async (message: string) => {
    const { content, images, fileAttachments } = buildUserMessageFromUploads(message)
    const chat = getCurrentChat()
    const userMessage: ChatMessage = { role: 'user', content, timestamp: Date.now(), images, fileAttachments }
    chat.messages.push(userMessage)
    chat.isGenerating = true
    inputText.value = ''
    currentUploads.value = []
    autoScrollEnabled.value = true
    scrollToBottom()
    saveChats()

    const options: AgentOptions = {
      provider: 'lan-host',
      config: {},
      llmConfig: {},
      label: 'lan-guest',
      guestLocale: store.locales == 'zh' ? 'zh' : 'en',
      // 访客选用的智能体（主机「协作 → 权限」开放的预设；默认通用智能体）
      guestAgentId: chat.config.guestAgentId || 'general',
      seedHistory: buildSeedHistory(chat),
      ...planTodoSeed(chat),
    }
    await startAgentSessionInChat(options, withFileAttachments(content, fileAttachments), images)
  }

  /**
   * 智能体模式（agent2，统一入口）：技能模式已并入本模式。
   * 输入意图解析（parseSkillIntent）：
   *   - 「技能列表 / 有哪些技能…」→ onSkillList 渲染技能目录；
   *   - 「help 技能名 / 帮助 技能名…」→ onSkillHelp 渲染技能帮助；
   *   - 「$技能名 任务…」→ 加载该技能指令作为 system prompt 执行；
   *   - 其余 → 自主规划（通用 system prompt）。
   * 统一走 Agent 循环 + 统一工具注册表。
   */
  const handleAgentLoopMode = async (message: string) => {
    // 先创建用户消息（确保用户输入出现在聊天中；与 handleSkillMode/handleAgentMode 一致）
    const { content: msgContent, images, fileAttachments } = buildUserMessageFromUploads(message)
    const userMessage: ChatMessage = { role: 'user', content: msgContent, timestamp: Date.now(), images, fileAttachments }
    const chat = getCurrentChat()
    chat.messages.push(userMessage)
    chat.isGenerating = true
    inputText.value = ''
    currentUploads.value = []
    autoScrollEnabled.value = true
    scrollToBottom()
    saveChats()

    // 技能库引导：确保按当前 store.skillsPath 加载（含主进程 skillService 根目录），
    // 与批量/工作流/集群同一逻辑；技能目录变更后自动重载
    await ensureAgentSkills(store)
    // 只加载启用的技能：禁用技能不参与意图解析、不注入、不可被 skill 工具加载
    const skills = getEnabledSkills()
    const intent = parseSkillIntent(message, skills, skillManager.parseSkillMention)

    // 技能列表 / 帮助请求：直接渲染回复，不启动 agent
    if (intent.kind === 'list') {
      chat.isGenerating = false
      await onSkillList()
      return
    }
    if (intent.kind === 'help') {
      chat.isGenerating = false
      await onSkillHelp(intent.skillName)
      return
    }

    const skill = intent.kind === 'skill' ? skillManager.getSkill(intent.skillName) : undefined
    // 禁用技能不可显式触发（$mention 已由 enabled 列表过滤，此处双保险）
    if (skill && intent.kind === 'skill') {
      const skillNameForCheck = skill.name || intent.skillName
      if ((store.disabledSkills || []).includes(skillNameForCheck)) {
        ElMessage.warning(store.locales == 'zh' ? `技能「${skillNameForCheck}」已禁用，请在技能管理中启用` : `Skill "${skillNameForCheck}" is disabled, enable it in Skill Management`)
        chat.isGenerating = false
        return
      }
    }
    const userInput = intent.kind === 'skill' && intent.rest ? intent.rest : message
    const llmType = chat.config.llmType || store.AIconfig.llm.type
    const { provider, config, llmConfig } = buildAgentProviderConfig(llmType)

    // 已启用的 MCP 服务（设置 → MCP 服务中 enabled !== false 的）→ mcp_call 工具上下文（serverId + 配置）
    const activeMcpServers = getActiveMcpServers()

    let options: AgentOptions
    if (skill) {
      // 技能触发：技能指令作为 system prompt，cwd 指向技能目录/工作区根
      options = {
        ...buildSkillAgentOptions({
          skillName: intent.kind === 'skill' ? intent.skillName : 'autonomous',
          skillDescription: skill.description || (store.locales == 'zh' ? '技能执行' : 'Skill execution'),
          skillContent: skill.body || skill.content || '',
          skillFiles: skill.files || [],
          skillFileCount: skill.fileCount,
          skillBaseDir: skill.path || skill.baseDir,
          // 工具 cwd 恒为用户工作区（技能自带资源用 read_file/list_dir/search_files 的 skill 参数寻址，
          // 不再把 cwd 切到技能库——否则「工作区有哪些文件」会答成技能目录）
          // 工作区是**每个聊天自己的**（chat.workspace；没选过就跟随全局默认 store.root）
          cwd: readChatWorkspace(chat, store.root) || undefined,
          provider,
          config,
          llmConfig,
          userInput,
          tools: store.agentTools === null ? undefined : store.agentTools,
          seedHistory: buildSeedHistory(chat),
          ...planTodoSeed(chat),
          sandboxMode: store.pythonSandbox || (store.TrustedPython ? 'trusted' : 'safe'),
        }),
        // 循环轮数：唯一数据源 = 「智能体预设 → 通用智能体」的 store.generalAgentMaxSteps
        maxSteps: normalizeAgentMaxSteps(store.generalAgentMaxSteps),
        disabledSkills: store.disabledSkills || [],
        // MCP 配置（mcp_call 工具读取）：智能体模式自动携带已启用的 MCP 服务
        mcpServerIds: activeMcpServers.map((s: any) => s.id),
        mcpServerConfigs: activeMcpServers,
      }
    } else {
      // 自主规划：与其它入口共用同一套 system prompt 组装（技能库清单 + MCP 工具清单 + 工作区）
      // 工具集：优先「设置 → 工具管理」的全局白名单（store.agentTools），未配置时用默认全集
      const installedSkills = await ensureAgentSkills(store)
      const toolsForMcp = store.agentTools === null ? [...SKILL_AGENT_DEFAULT_TOOLS] : [...store.agentTools]
      // 已启用 mcp_call 且有 MCP 服务时，注入服务/工具说明（含 serverId，模型据此调用 mcp_call）
      const mcpCtx = (toolsForMcp.includes('mcp_call') && activeMcpServers.length > 0)
        ? await buildMcpServersContext(activeMcpServers, store.locales)
        : ''
      const assembled = assembleAgentSystemPrompt({
        store,
        tools: toolsForMcp,
        enabledSkills: installedSkills,
        mcpContext: mcpCtx,
        // 每个聊天自己的激活工作区（没选过 → 组装函数回落到 store.root）
        workspace: readChatWorkspace(chat, ''),
      })
      options = {
        systemPrompt: assembled.systemPrompt,
        provider,
        config,
        llmConfig,
        tools: assembled.tools,
        cwd: assembled.cwd,
        label: 'agent-loop',
        // 循环轮数：唯一数据源 = 「智能体预设 → 通用智能体」的 store.generalAgentMaxSteps
        maxSteps: normalizeAgentMaxSteps(store.generalAgentMaxSteps),
        seedHistory: buildSeedHistory(chat),
        ...planTodoSeed(chat),
        sandboxMode: store.pythonSandbox || (store.TrustedPython ? 'trusted' : 'safe'),
        disabledSkills: store.disabledSkills || [],
        // MCP 配置（mcp_call 工具读取）：智能体模式自动携带已启用的 MCP 服务
        mcpServerIds: activeMcpServers.map((s: any) => s.id),
        mcpServerConfigs: activeMcpServers,
      }
    }
    await startAgentSessionInChat(options, withFileAttachments(userInput, fileAttachments), images)
  }

  /** 技能模式（新路径）：技能指令组装为 systemPrompt，由 agent 循环驱动 */
  const handleSkillAgentLoop = async (userInput: string, skillName: string | null) => {
    const skill = skillName ? skillManager.getSkill(skillName) : undefined
    const skillContent = skill
      ? (skill.body || skill.content || '')
      : buildAutonomousSystemPrompt()
    const skillFiles = skill ? (skill.files || []) : undefined

    const chat = getCurrentChat()
    const llmType = chat.config.llmType || store.AIconfig.llm.type
    const { provider, config, llmConfig } = buildAgentProviderConfig(llmType)

    const options: AgentOptions = {
      ...buildSkillAgentOptions({
        skillName: skillName || 'autonomous',
        skillDescription: skill?.description || (store.locales == 'zh' ? '自主规划任务' : 'Autonomous task'),
        skillContent,
        skillFiles,
        skillFileCount: skill?.fileCount,
        skillBaseDir: skill?.path || skill?.baseDir,
        // 同上：cwd 恒为用户工作区（每个聊天自己的，未选过则全局默认），技能资源靠 skill 参数
        cwd: readChatWorkspace(chat, store.root) || undefined,
        provider,
        config,
        llmConfig,
        userInput,
        tools: store.agentTools === null ? undefined : store.agentTools,
        sandboxMode: store.pythonSandbox || (store.TrustedPython ? 'trusted' : 'safe'),
        // 循环轮数：技能模式同样只用唯一数据源（不再落回写死的 20）
        maxSteps: normalizeAgentMaxSteps(store.generalAgentMaxSteps),
      }),
      // MCP 配置（mcp_call 工具读取）：技能模式自动携带已启用的 MCP 服务
      mcpServerIds: getActiveMcpServers().map((s: any) => s.id),
      mcpServerConfigs: getActiveMcpServers(),
    }
    await startAgentSessionInChat(options, userInput)
  }

  // ---------------- Agent 预设模式（已迁移到 agent 循环 + 统一工具注册表） ----------------

  /** 聊天窗口既有上下文 → 种子历史（排除刚推送的当前用户消息） */
  const buildSeedHistory = (chat: Chat) =>
    chat.messages
      .slice(0, -1)
      .filter((m): m is ChatMessage & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }))

  /**
   * 计划 / 待办的恢复种子（来自聊天存档这份「跨会话事实源」）。
   *
   * 会话内的事实源是会话日志（plan/write、todo/write，最后一条胜出）；
   * 聊天存档负责把它们带过进程与聊天切换。新会话收到种子后用
   * setPlan / setTodos 写入自己的日志，于是「回放日志即得当前状态」始终成立。
   */
  const planTodoSeed = (chat: Chat) => ({
    ...(typeof chat.agentPlan === 'string' && chat.agentPlan.trim() ? { seedPlan: chat.agentPlan } : {}),
    ...(Array.isArray(chat.agentTodos) && chat.agentTodos.length ? { seedTodos: chat.agentTodos } : {}),
    // 进程结束后用户补答的那条评审裁决：交给新会话（写成一条已记录的 user 消息）
    ...(chat.planDecision ? { seedPlanDecision: chat.planDecision } : {}),
  })

  /** 已启用的技能（排除技能管理中关闭的；按需注入智能体） */
  const getEnabledSkills = () => {
    const disabled = new Set(store.disabledSkills || [])
    return skillManager.getSkills().filter((s) => !disabled.has(s.name))
  }

  /** 预设能力槽 → 工具白名单（统一数据源：src/lib/agent/capabilities.ts，与预设工具标签页同步） */
  const buildPresetTools = (caps: any): string[] => toolsFromCapabilities(caps)


  /** 已启用的 MCP 服务（设置 → MCP 服务中 enabled !== false 的）→ mcp_call 工具上下文 */
  const getActiveMcpServers = (): any[] =>
    (store.mcpServers || []).filter((s: any) => s && s.enabled !== false && s.transport !== 'inmemory')

  /**
   * Agent 预设模式发送：systemPrompt = 预设提示（角色 + 知识库能力说明），
   * 能力槽映射为工具白名单，kbPaths = 预设关联知识库，走 agent 循环执行
   * （替代原渲染进程 5 轮 ReAct 循环；工具执行在统一注册表 + 主进程）。
   */
  const handleAgentPresetMode = async (message: string, preset: any) => {
    const { content: msgContent, images, fileAttachments } = buildUserMessageFromUploads(message)
    const userMessage: ChatMessage = { role: 'user', content: msgContent, timestamp: Date.now(), images, fileAttachments }
    const chat = getCurrentChat()
    chat.messages.push(userMessage)
    chat.isGenerating = true
    inputText.value = ''
    currentUploads.value = []
    autoScrollEnabled.value = true
    scrollToBottom()
    saveChats()

    // system prompt 组装：统一交给 @/lib/agent/promptContext（与批量/集群/工作流节点同一实现）
    // 覆盖：自定义提示 + 工具说明 / 通用自主规划 / 指令段模式（{{cwd}} 等）/ 知识库能力 / 所选技能 / 工作区
    const baseTools = buildPresetTools(preset.capabilities || {})
    const mcpIds: string[] = preset.capabilities?.mcpServerIds || (preset.capabilities?.mcpServerId ? [preset.capabilities.mcpServerId] : [])
    // 预设启用的 MCP 服务及其真实工具清单（含 serverId，模型据此调用 mcp_call）
    const mcpCtx = (preset.capabilities?.mcpAccess && mcpIds.length > 0)
      ? await buildMcpServersContext((store.mcpServers || []).filter((s: any) => mcpIds.includes(s.id)), store.locales)
      : ''
    const assembled = assembleAgentSystemPrompt({
      store,
      preset,
      tools: baseTools,
      enabledSkills: await ensureAgentSkills(store),
      // 命中任意技能（含已禁用）：已禁用的在组装函数里跳过并给出提示
      resolveSkill: (key: string) => {
        const s: any = skillManager.getSkills().find((x) => x.path === key) ?? skillManager.getSkill(key)
        return s ? { name: String(s.name || key), description: s.description, path: s.path, body: s.body, content: s.content } : null
      },
      disabledSkills: store.disabledSkills || [],
      mcpContext: mcpCtx,
      // 指令段内 {{model}}/{{provider}} 用实际生效值（右上角改过则跟随右上角），而非预设存档值。
      // 预设「跟随默认」时 llmType / model 为空 → 直接落到全局当前来源与模型。
      model: chat.config.model || resolvePresetModel(preset) || undefined,
      provider: resolvePresetLlmType(preset, store) || chat.config.llmType || undefined,
      // 每个聊天自己的激活工作区（没选过 → 组装函数回落到 store.root）
      workspace: readChatWorkspace(chat, ''),
    })
    const systemPrompt = assembled.systemPrompt
    const tools = assembled.tools
    const cwd = assembled.cwd

    // 呈现方式（预设声明）：'ptc' → 只暴露 run_code + 叠加 tools:sdk 段；缺省 native 原样透传
    const presented = await applyToolPresentation({
      basePrompt: systemPrompt,
      catalog: tools,
      presentation: presetPresentation(preset),
    })

    // 执行跟随聊天右上角选择的模型来源/种类：选中预设时已把预设模型写入聊天配置，
    // 此后右上角再改动即改聊天配置，智能体执行使用变化后的来源/模型（预设字段仅作回退）。
    // 预设「跟随默认」时聊天配置里没有具体值 → 直接读全局当前来源与模型（换来源后自动跟上）。
    const llmType = chat.config.llmType || resolvePresetLlmType(preset, store) || store.AIconfig.llm.type
    const { provider, config, llmConfig } = buildAgentProviderConfig(llmType)
    // 模型：非跟随档用预设自己的模型；跟随档留空（由该来源配置里的模型兜底）
    const presetModel = resolvePresetModel(preset)
    if (presetModel) config.model = presetModel

    const options: AgentOptions = {
      systemPrompt: presented.systemPrompt,
      provider,
      config,
      llmConfig,
      tools: presented.tools,
      cwd,
      toolsPresentation: presented.toolsPresentation,
      label: preset.name || 'agent-preset',
      kbPaths: preset.capabilities?.knowledgeBaseFiles || [],
      kbTopK: typeof preset.kbTopK === 'number' ? preset.kbTopK : 5,
      mcpServerIds: preset.capabilities?.mcpServerIds || (preset.capabilities?.mcpServerId ? [preset.capabilities.mcpServerId] : []),
      mcpServerConfigs: (store.mcpServers || []).filter((s: any) => (preset.capabilities?.mcpServerIds || (preset.capabilities?.mcpServerId ? [preset.capabilities.mcpServerId] : [])).includes(s.id)),
      mcpEquipmentIds: preset.capabilities?.mcpEquipmentIds || undefined,
      // 循环轮数：预设自带轮数为唯一例外，未配置时回退全局唯一数据源（不写死 20）
      maxSteps: resolveAgentMaxSteps(preset.maxSteps, store.generalAgentMaxSteps),
      // 预设默认继承聊天上下文；可在预设配置中关闭
      seedHistory: preset.seedHistory !== false ? buildSeedHistory(chat) : undefined,
      ...planTodoSeed(chat),
      sandboxMode: store.pythonSandbox || (store.TrustedPython ? 'trusted' : 'safe'),
      disabledSkills: store.disabledSkills || [],
    }
    await startAgentSessionInChat(options, withFileAttachments(msgContent, fileAttachments), images)
  }

  /**
   * 收集当前聊天里「正在执行」的 agent 会话 id（供运行中引导 steer 使用）：
   *  - 单智能体会话（智能体 / 预设 / PTC / 技能）：assistant 消息带 agentViewId 且仍标记执行中；
   *  - 集群成员会话：本次集群运行中正在发言的成员（成员消息不带 executionType，
   *    其会话 id 由 swarmRunner 记在 swarmState.agentRunStates）。
   *  只保留主进程状态为 running 的会话——idle/stopping 时 steer 会另起一轮或无处投递。
   */
  const collectRunningAgentSessions = (chat: any): string[] => {
    const ids = new Set<string>()
    for (const m of ((chat?.messages || []) as any[])) {
      if (!m || m.role !== 'assistant' || m.executionType !== 'skill' || m.isExecuting !== true) continue
      if (m.agentViewId) ids.add(String(m.agentViewId))
    }
    if (chat?.mode === 'swarm' && swarmRunning.value && swarmRunChatId.value === chat.id) {
      for (const st of Object.values(agentRunStates.value || {}) as any[]) {
        if (st?.agentId) ids.add(String(st.agentId))
      }
    }
    return Array.from(ids).filter((id) => agentBridge.get(id)?.status === 'running')
  }

  /**
   * 运行中「引导」（steer）：把用户输入投递给正在执行的 agent 会话，在**下一个 step 边界**生效，
   * 不打断当前执行（对齐主流 agent 客户端「边跑边补充要求」）。
   * 返回实际受理的会话数；0 表示当前没有可接收引导的运行中会话
   * （本轮刚好结束 / 正在停止）——调用方应回退为按「新任务」正常发送。
   */
  const steerRunningAgents = async (chat: any, content: string): Promise<number> => {
    const text = String(content || '').trim()
    if (!text) return 0
    let delivered = 0
    for (const id of collectRunningAgentSessions(chat)) {
      try {
        if (await agentBridge.steer(id, text)) delivered++
      } catch (e) {
        console.warn('[agent] 运行中引导投递失败:', e)
      }
    }
    return delivered
  }

  return {
    agentSessionId,
    buildAgentProviderConfig,
    attachAgentToChat,
    startAgentSessionInChat,
    handleAgentLoopMode,
    /** 网页端（局域网共享）智能体模式：主机侧执行，本端只下发任务 + 渲染事件 */
    handleBrowserAgentMode,
    /** 是否网页端（无 ipcRenderer）：供 home 决定发送前检查项 */
    isLanGuest,
    handleAgentPresetMode,
    /** 收集当前聊天里正在执行的 agent 会话 id（单智能体 + 集群发言中成员） */
    collectRunningAgentSessions,
    /** 运行中「引导」：把输入作为 steer 投递给运行中的会话（下一个 step 生效），返回受理数 */
    steerRunningAgents,
    /** 智能体运行状态对账（兜底清理 + 手动停止强制收尾；home 挂载/周期定时/停止兜底调用） */
    reconcileAgentRuns,
    /** 手动停止某聊天里所有执行中的智能体会话（保留记录、立即解锁；home「停止」调用） */
    stopAgentsInChat,
    /** 卸载时退订全部 agent 会话的流式订阅（home.vue onUnmounted 调用） */
    disposeAgentRun,
  }
}
