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
 * 统一工具注册表；PTC（程序化工具调用 / Code Mode）为 handlePtcMode，
 * 仅改变「工具呈现」（run_code）与系统提示（叠加 tools:sdk 段）。
 */

import { ref, type Ref } from 'vue'
import { usestore } from '@/store'
import { ElMessage, ElMessageBox } from 'element-plus'
import { agentBridge } from '@/platform/agentBridge'
import { chatsRef } from '@/store/chats'
// 运行中「引导」：集群成员（发言中的 agent 会话）也接受 steer，其会话 id 记在 swarmState
import { agentRunStates, running as swarmRunning, swarmRunChatId } from '@/store/swarmState'
import { toolsFromCapabilities } from '@/lib/agent/capabilities'
import { renderQuestionMarkdown, escapeHtml } from '@/lib/markdown/render'
// 会话视图 → 消息投影（与集群模式共用同一实现，保证工具调用/思考/来源样式一致）
import { projectStepsToUnits, projectKbInfo, projectUsage, projectTodos } from '@/lib/agent/projection'
import { estimateAgentSeedTokens } from '@/lib/contextUsage'
import {
  buildSkillAgentOptions,

  buildAutonomousSystemPrompt,
  SKILL_AGENT_DEFAULT_TOOLS,
  parseSkillIntent,
} from '@/lib/agent/skill'
import { assembleAgentSystemPrompt, buildMcpServersContext, ensureAgentSkills } from '@/lib/agent/promptContext'
// PTC（Code Mode）：系统提示叠加 tools:sdk 段（SDK 声明由主进程生成）
import { buildPtcSystemPrompt } from '@/lib/agent/ptc'
import type { Chat, ChatMessage, UploadItem } from '@/types/chat'
import type { AgentOptions } from '@/types/agent'
import { normalizeAgentMaxSteps, resolveAgentMaxSteps } from '@/shared/agent-loop-rounds'
import { normalizeLlmType, resolveLlmSource } from '@/shared/llmSources'
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
    // 服务端搜索事件队列消费（按返回时间推进 UI，事件到达即处理，天然流式、不丢）：
    let consumedSearchEvents = 0 // 已消费的事件数
    let openReasoningId: string | null = null // 当前 running 的思考段单元 id
    let openReasoningStart = 0 // 当前思考段在全量推理文本中的起始偏移
    let lastReasoningLen = 0 // 已消费的推理文本长度
    let searchActive = false // 服务端搜索是否已激活（首个事件时初始化）
    let tlSeq = 0 // 单元序号（保证时间顺序稳定）
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
      // 思考/工具调用 → executionUnits 时间线 + 输入区快照
      projectSteps(v)
      // ask_user 提问：弹窗收集回答（对齐 Swarm 预设行为；按 askId 去重）。
      // 主进程 ask_user 工具会挂起等待 agent:answer 回复，若不弹窗该工具永远不返回，
      // 会话结束时其 tool/result 缺失 → 日志显示「工具结果缺失」。
      // 问题内容做 markdown 渲染（dangerouslyUseHTMLString + 自定义样式类）。
      if (v.pendingQuestion && !handledAsks.has(v.pendingQuestion.askId)) {
        handledAsks.add(v.pendingQuestion.askId)
        const q = v.pendingQuestion
        const name = assistantMsg.model ? '' : (store.locales == 'zh' ? '智能体' : 'Agent')
        const questionHtml =
          `<div class="agent-question-markdown">${name ? `<strong>${escapeHtml(name)}</strong>：` : ''}${renderQuestionMarkdown(q.question)}</div>`
        ElMessageBox.prompt(questionHtml, store.locales == 'zh' ? '智能体提问' : 'Agent asks', {
          dangerouslyUseHTMLString: true,
          customClass: 'agent-question-box',
          confirmButtonText: store.locales == 'zh' ? '发送' : 'Send',
          cancelButtonText: store.locales == 'zh' ? '取消' : 'Cancel',
          inputPlaceholder: store.locales == 'zh' ? '请输入你的回答...' : 'Type your answer...',
        })
          .then(({ value }) => agentBridge.answer(viewId, q.askId, value || ''))
          .catch(() => agentBridge.cancel(viewId, 'user'))
      }
      projectTodos(chatRef ?? getCurrentChat(), v)
      // 服务端联网搜索（deepseek-responses）→ 消费 searchEvents 事件队列（按返回时间推进 UI）：
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
      // 结束判定：只要“已开始运行 + 进入 idle + 无挂起提问 + 消息仍标记执行中”即视为结束。
      // 不再要求“至少一条真实输出/工具时间线”——若智能体启动即报错/超时且无任何产出，
      // 也必须立即清理转圈并解锁聊天，否则该聊天会因 isExecuting/isGenerating 残留而永久卡死。
      const finalReplyDone = v.status === 'idle' && sawRunning && !v.pendingQuestion && assistantMsg.isExecuting
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
          msg.content = force && !err
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
   * 上传的文本附件 → 任务前缀（与普通聊天 home.vue 同一格式）。
   * 仅进模型上下文，不写进聊天气泡正文（气泡另有附件 chips）。
   */
  const withFileAttachments = (message: string, fileAttachments?: ChatMessage['fileAttachments']): string => {
    if (!fileAttachments || fileAttachments.length === 0) return message
    const fileBlocks = fileAttachments.map((f: any) =>
      `[文件: ${f.name} (${f.charCount}字)]\n\`\`\`\n${f.content}\n\`\`\``
    )
    const fileContext = fileBlocks.join('\n\n')
    return message ? `${fileContext}\n\n${message}` : fileContext
  }

  /** 创建 agent 会话并接入聊天（公共流程：创建 → 占位消息 → 订阅 → 发送） */
  const startAgentSessionInChat = async (
    options: AgentOptions,
    userInput: string,
    images?: Array<string | Uint8Array | ArrayBuffer>,
  ) => {
    if (!window.dsh?.agent) {
      ElMessage.error(store.locales == 'zh' ? '智能体功能需要桌面版支持' : 'Agent Loop requires the desktop app')
      return null
    }
    const chat = getCurrentChat()
    try {
      // 多模态附图（上传的图片）：转成 data URL 字符串塞进 options（JSON 安全），
      // 主进程只在内存里持有，并在每次请求时挂回「带图的那条 user 消息」
      const taskImages = await toTaskImages(images)
      const view = await agentBridge.create(taskImages.length ? { ...options, taskImages } : options)
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
          cwd: store.root || undefined,
          provider,
          config,
          llmConfig,
          userInput,
          tools: store.agentTools === null ? undefined : store.agentTools,
          seedHistory: buildSeedHistory(chat),
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
        sandboxMode: store.pythonSandbox || (store.TrustedPython ? 'trusted' : 'safe'),
        disabledSkills: store.disabledSkills || [],
        // MCP 配置（mcp_call 工具读取）：智能体模式自动携带已启用的 MCP 服务
        mcpServerIds: activeMcpServers.map((s: any) => s.id),
        mcpServerConfigs: activeMcpServers,
      }
    }
    await startAgentSessionInChat(options, withFileAttachments(userInput, fileAttachments), images)
  }

  /**
   * PTC 模式（程序化工具调用 / Code Mode）：与自主规划同一套基础提示词与能力目录，
   * 差别只在「工具呈现」：坍缩为单个 run_code（toolsPresentation='code' + 系统提示叠加 tools:sdk 段）。
   * 由本模式直接负责：能力目录 = 全局工具白名单；SDK 声明按同一白名单生成（不含 run_code 自身）。
   * 步数沿用唯一数据源（设置 → 智能体预设 → 通用智能体的循环轮数），不再自成一套。
   */
  const handlePtcMode = async (message: string) => {
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

    const llmType = chat.config.llmType || store.AIconfig.llm.type
    const { provider, config, llmConfig } = buildAgentProviderConfig(llmType)
    const activeMcpServers = getActiveMcpServers()
    // 能力目录（SDK 暴露的工具 = 该白名单）：未配置全局白名单时用默认标准工具集
    const catalog = store.agentTools === null ? [...SKILL_AGENT_DEFAULT_TOOLS] : [...store.agentTools]
    // run_code 是呈现工具，必须进 tools（引擎白名单守卫会校验），但不写进 SDK 声明
    const toolsWithPtc = catalog.includes('run_code') ? catalog : [...catalog, 'run_code']
    const mcpCtx = (catalog.includes('mcp_call') && activeMcpServers.length > 0)
      ? await buildMcpServersContext(activeMcpServers, store.locales)
      : ''
    const assembled = assembleAgentSystemPrompt({
      store,
      tools: toolsWithPtc,
      enabledSkills: await ensureAgentSkills(store),
      mcpContext: mcpCtx,
    })
    // tools:sdk 段（主进程生成；非桌面版返回空，静默降级为普通智能体提示词）
    let sdkDocs = ''
    try {
      sdkDocs = await agentBridge.getSdkDocs(undefined, catalog)
    } catch { /* SDK 不可用不影响执行 */ }
    const options: AgentOptions = {
      systemPrompt: buildPtcSystemPrompt({ basePrompt: assembled.systemPrompt, sdkDocs }),
      provider,
      config,
      llmConfig,
      tools: assembled.tools,
      cwd: assembled.cwd,
      label: 'agent-ptc',
      toolsPresentation: 'code',
      // 步数：唯一数据源 = 「智能体预设 → 通用智能体」的循环轮数
      maxSteps: normalizeAgentMaxSteps(store.generalAgentMaxSteps),
      seedHistory: buildSeedHistory(chat),
      sandboxMode: store.pythonSandbox || (store.TrustedPython ? 'trusted' : 'safe'),
      disabledSkills: store.disabledSkills || [],
      mcpServerIds: activeMcpServers.map((s: any) => s.id),
      mcpServerConfigs: activeMcpServers,
    }
    await startAgentSessionInChat(options, withFileAttachments(message, fileAttachments), images)
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
        // 同上：cwd 恒为用户工作区，技能资源靠 skill 参数
        cwd: store.root || undefined,
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
      // 指令段内 {{model}}/{{provider}} 用实际生效值（右上角改过则跟随右上角），而非预设存档值
      model: chat.config.model || preset.model,
      provider: chat.config.llmType || preset.llmType || store.AIconfig.llm.type,
    })
    const systemPrompt = assembled.systemPrompt
    const tools = assembled.tools
    const cwd = assembled.cwd

    // 执行跟随聊天右上角选择的模型来源/种类：选中预设时已把预设模型写入聊天配置，
    // 此后右上角再改动即改聊天配置，智能体执行使用变化后的来源/模型（预设字段仅作回退）。
    const llmType = chat.config.llmType || preset.llmType || store.AIconfig.llm.type
    const { provider, config, llmConfig } = buildAgentProviderConfig(llmType)

    const options: AgentOptions = {
      systemPrompt,
      provider,
      config,
      llmConfig,
      tools,
      cwd,
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
    handleAgentPresetMode,
    /** PTC 模式（程序化工具调用）：同一 agent 循环 + run_code 呈现 */
    handlePtcMode,
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
