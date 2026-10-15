/**
 * agent.ts — Agent 循环类型（turn/step/inbox/cancel/steer/inject）
 *
 * 借鉴 DeepSeek-Harness core 子系统（docs/subsystems/core.md）：
 * - **step** = 一次模型请求 + 它调用的工具；**turn** = 零个或多个 step；
 * - 输入通过统一 **inbox** 到达驱动器：普通消息唤醒驱动器；`inject` 只排队
 *   不唤醒（注入上下文落到下一次获准的请求）；
 * - `cancel(cause)` 中止当前 turn（首个 cause 生效），`keepInbox` 保留排队工作；
 * - `whenIdle()` 等待整个 agent 收敛（无活跃驱动器/维护任务）；
 * - 生命周期状态：`idle → running → stopping → disposed`，每次迁移发
 *   `agent/status` 事件。
 *
 * 实现见 `electron/main/agent-loop.ts`（主进程，UI 切换后继续运行）。
 */

import type { AgentId } from '@/types/ids'

// ---------------------------------------------------------------------------
// 状态与选项
// ---------------------------------------------------------------------------

export type AgentStatus = 'idle' | 'running' | 'stopping' | 'disposed'

/** 取消原因：首个 cause 生效（user / timeout / dispose / error / 自定义） */
export type AgentCancelCause = 'user' | 'timeout' | 'dispose' | 'error' | (string & {})

/** Agent 创建选项（渲染进程从 store.AIconfig 组装后经 IPC 传入） */
export interface AgentOptions {
  /** 系统提示词（模型可见，写入 session/start 事件） */
  systemPrompt?: string
  /** LLM provider（对齐 ai-service：ollama/lmstudio/openai/deepseek/...） */
  provider: string
  /** provider 配置（ollama 的 model_url 等） */
  config?: any
  /** 通用 LLM 配置（temperature/max_tokens/...） */
  llmConfig?: any
  /** 工具白名单：null=全部，[]=全部关闭，其他=仅列表内的工具 */
  tools?: string[] | null
  /**
   * 工具呈现形态（对齐 DSH 的 per-agent tool presentation）：
   * - `native`（默认）：逐个工具 schema 暴露给模型；
   * - `code`（PTC / Code Mode）：能力目录（tools）不变，但模型可见的工具
   *   坍缩为单个 `run_code`——模型编写 TypeScript 程序，用注入的 ctx SDK
   *   组合多步操作。注意：`run_code` 必须同时出现在 `tools` 白名单中，
   *   否则引擎级白名单守卫会拒绝调用。
   */
  toolsPresentation?: 'native' | 'code'
  /** 作用域键（agent id / preset 名），决定工具注册表读取哪一层 */
  scope?: string
  /** 工作区根目录（传给工具执行上下文） */
  cwd?: string
  /** 会话标签（展示用） */
  label?: string
  /**
   * 单个 turn 的最大 step 数（循环轮数；防死循环）。
   * 唯一数据源 = store.generalAgentMaxSteps（默认 500），唯一例外 = 智能体预设的 preset.maxSteps；
   * 见 src/shared/agent-loop-rounds.ts，勿在此层再引入其它默认值。
   */
  maxSteps?: number
  /**
   * 会话历史种子：创建时写入本 agent 的会话日志（user/assistant 事件），
   * 使模型能继承聊天窗口的既有上下文（"模型可见即已记录"——种子是模型可见的，
   * 因此也落盘）。每条消息对应一条事件，按序追加在 session/start 之后。
   */
  seedHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
  /**
   * 执行计划 / 待办清单的恢复种子（重开聊天时由渲染层从聊天存档带出）。
   * 会经 setPlan / setTodos 写入本会话日志（`plan/write` / `todo/write`），
   * 因此恢复后的会话依旧「只记日志、回放即得状态」。
   */
  seedPlan?: string | null
  seedTodos?: TodoItem[]
  /**
   * 上一轮计划评审的裁决（进程重启后用户回答那条被恢复的评审时产生）。
   * 会作为一条**已记录**的 user 消息注入新会话：批准 → 按计划执行；
   * 继续完善 → 按反馈修订后重新提交；关闭 → 先说明现状等指示。
   */
  seedPlanDecision?: { verdict: 'approve' | 'keep' | 'dismiss' | 'cancelled' | (string & {}); feedback?: string; plan?: string }
  /**
   * 任务附图（初始任务要一起交给模型的多模态图片）。
   * **必须是 JSON 可序列化的字符串**（data URL 或裸 base64）——`agentBridge.sanitizeOptions`
   * 会 `JSON.parse(JSON.stringify(options))`，Uint8Array / ArrayBuffer 会被破坏成普通对象。
   * 主进程只在内存里持有，并在每次请求时挂回「带图的那条 user 消息」上；
   * 会话日志只记图片数量（不存 base64），避免 JSONL 膨胀。
   */
  taskImages?: string[]
  /** 预设模式的知识库文件列表（kb_search 工具的候选检索范围） */
  kbPaths?: string[]
  /** kb_search 每次检索召回切片数（预设配置，默认 5） */
  kbTopK?: number
  /**
   * 知识库检索参数（kb_search 读取）。
   * 传入后 agent 内的检索会走「当前模型来源 + 嵌入兜底」的同一套配置，
   * 而不是主进程默认的 ollama（否则 LM Studio 等来源下会因缺嵌入模型而检索为空）。
   */
  retrieval?: {
    llmType?: string
    providerConfig?: any
    embedModel?: string
    chatModel?: string
    processModel?: string
    strategy?: string
    embedFallbackType?: string
    embedFallbackProviderConfig?: any
    embedFallbackModel?: string
  }
  /**
   * 沙箱模式（'safe' | 'workspace' | 'trusted'）：传给工具执行上下文，
   * 由统一策略解析（sandbox-policy）决定 run_python/shell 的放行级别；
   * 缺省视为 'safe'（fail-closed）。
   */
  sandboxMode?: 'safe' | 'workspace' | 'trusted'
  /**
   * 本次会话生效的上下文窗口上限（tokens）：由渲染层用 `resolveLimitFor()`
   * （与主页圆环同源：手填 > 已加载实例探测值 > 记住值 > 模型上限 > 来源默认）解析后传入。
   * 主进程据此做请求前预算检查与主动压缩；缺省时回退 FALLBACK_CONTEXT_WINDOW(128K)。
   */
  contextLimit?: number
  /**
   * 是否启用上下文自动压缩（默认 true）：占用 ≥ 80% 时压缩旧轮次，
   * provider 报上下文超限时压缩后重放本 step。旁路会话（如摘要器）应传 false 防递归。
   */
  contextCompact?: boolean
  /**
   * 估算校准系数（真实 token 计数 / 字符启发式估算）：渲染层按「来源 + 模型」记住上次实测值
   * 后回传，主进程用它修正请求前预算（本地后端 Ollama / LM Studio 的 tokenizer 与估算口径
   * 差异可达 ±30%，不校准会系统性低估 → 压缩触发太晚）。缺省 1；运行时主进程还会继续自校准。
   */
  tokenScale?: number
  /** 禁用的技能名（技能管理开关关闭的；skill 工具加载时校验拒绝） */
  disabledSkills?: string[]
  /** 父 agent id（子代理接缝：父销毁时级联销毁子代理） */
  parentId?: string
    /** MCP 服务 ID（Agent 预设开启 MCP 控制时使用；mcp_call 工具读取） */
    mcpServerId?: string
    /** MCP 服务配置（渲染进程从 store.mcpServers 带出；mcp_call 工具读取） */
    mcpServerConfig?: any
    /** 预设限定可管理的 MCP 装备 ID 列表（可选） */
    mcpEquipmentIds?: string[]
      /** MCP 服务 ID 列表（多选；mcp_call 工具读取） */
      mcpServerIds?: string[]
      /** MCP 服务配置列表（与 mcpServerIds 对应） */
      mcpServerConfigs?: any[]
  /** 群成员注册表（AgentSwarm）：供 run_subagent(member=…) 以成员设定创建子代理（群成员化） */
  swarmMembers?: Record<string, SwarmMemberProfile>
  /** 子代理嵌套深度（根=0；run_subagent 逐层 +1，超限拒绝，防死循环） */
  swarmDepth?: number
  /** 本次协作已召唤的群成员名调用链（防环：同一成员不重复召唤） */
  swarmChain?: string[]
  /**
   * 【仅网页端访客】界面语言：主机据此生成中文 / 英文的访客系统提示
   * （局域网共享下 agent 循环跑在主机，系统提示由主机组装，本端不参与）。
   */
  guestLocale?: 'zh' | 'en'
  /**
   * 【仅网页端访客】选用的智能体（主机「协作 → 权限」开放的那些）：
   * 'general'（或留空）= 通用智能体；其余为主机 Agent 预设 id。
   */
  guestAgentId?: string
}

/** 群成员子代理设定（AgentSwarm 注入；供 run_subagent 以成员身份执行） */
export interface SwarmMemberProfile {
  /** 成员的完整系统提示（含能力/知识库/技能引导） */
  systemPrompt?: string
  provider: string
  config?: any
  llmConfig?: any
  tools?: string[] | null
  cwd?: string
  scope?: string
  kbPaths?: string[]
  mcpServerIds?: string[]
  mcpServerConfigs?: any[]
  mcpEquipmentIds?: string[]
  sandboxMode?: 'safe' | 'workspace' | 'trusted'
  maxSteps?: number
}

// ---------------------------------------------------------------------------
// Agent 句柄（IPC 可见契约）
// ---------------------------------------------------------------------------

/** 面向调用方（UI/编排器）的 Agent 控制面 */
export interface AgentControl {
  readonly id: AgentId
  readonly status: AgentStatus
  /** 立即唤醒并开一轮新 turn */
  send(content: string, source?: string, images?: string[]): void
  /** followup = send 的别名语义（排队普通轮次并唤醒） */
  followup(content: string, source?: string): void
  /** 投递到最近 step 边界的转向输入；空闲时开一轮 turn */
  steer(content: string): void
  /** 排队模型可见上下文，不唤醒；下一次 step 边界被领取 */
  inject(content: string): void
  /** 中止当前 turn；keepInbox=true 时保留排队工作 */
  cancel(cause: AgentCancelCause, opts?: { keepInbox?: boolean }): void
  /** 等待整个 agent 收敛（无活跃 turn） */
  whenIdle(): Promise<void>
  /** 终止 agent（取消 + 等待退出 + 注销） */
  dispose(): Promise<void>
}

// ---------------------------------------------------------------------------
// 事件（主进程 → 渲染进程广播）
// ---------------------------------------------------------------------------

export type AgentEventType =
  | 'agent/status'
  | 'agent/turn-start'
  | 'agent/turn-end'
  | 'agent/step-start'
  | 'agent/step-end'
  | 'agent/inbox'
  | 'assistant/chunk'
  | 'assistant/reasoning' // 思维链流式增量（reasoning_text.delta，全量累积文本）
  | 'assistant/message'
  | 'tool/call'
  | 'tool/result'
  | 'agent/tool-args' // 工具参数流式增量（function calling：write_file 等长内容工具实时展示）
  | 'agent/question' // 等待用户回答（ask_user 工具；用 agent:answer 回复）
  | 'agent/renderer-task' // 主进程工具请求渲染层执行浏览器侧任务（如 Word 导出：claim 抢占 → result 回传）
  | 'agent/plan' // 执行计划更新（update_plan 工具）
  | 'agent/plan-review' // 计划评审请求（exit_plan_mode 工具；用 agent:answer 回裁决）
  | 'agent/todos' // 待办清单更新（update_todo 工具）
  | 'agent/search-status' // 服务端联网搜索状态（deepseek-responses web_search_call）
  | 'agent/compaction' // 上下文压缩（旧轮次摘要）：start 事件 → 界面显示「正在压缩上下文…」
  | 'agent/notice' // 非致命的运行期提示（如 max_tokens 截断后自动续跑 / 放弃续跑）
  | 'agent/error'

/** 上下文压缩触发方式：自动（占用达阈值）/ 后端报超限后重试 / 手动 */
export type AgentCompactionKind = 'auto' | 'overflow-retry' | 'manual'

/** 单步 LLM 的 token 用量（真实 usage，用于上下文占用圆环与累计消耗展示） */
export interface AgentStepUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface AgentEventMap {
  'agent/status': { status: AgentStatus }
  'agent/turn-start': { turn: number }
  'agent/turn-end': { turn: number; reason: string }
  'agent/step-start': { turn: number; step: number }
  'agent/step-end': { turn: number; step: number; toolCalls: number; usage?: AgentStepUsage; /** 估算校准系数（真实/估算，渲染层按来源+模型持久化后回传复用） */ tokenScale?: number }
  'agent/inbox': { pending: number }
  'assistant/chunk': { content: string }
  'assistant/reasoning': { text: string }
  'assistant/message': { content: string; toolCalls?: Array<{ id: string; name: string; arguments: any }> }
  'tool/call': { callId: string; name: string; args: any; /** 参数解析失败（畸形/被截断）：已回退到错误提示，不再执行工具 */ argsParseFailed?: boolean }
  /** preview：UI 专用差异预览（不进模型上下文，见 ToolResult.preview） */
  'tool/result': { callId: string; name: string; ok: boolean; value?: any; error?: string; preview?: any }
  'agent/tool-args': { callId: string; name: string; argsFragment: string }
  'agent/question': {
    askId: string
    /**
     * 纯文本摘要（结构化问题拼成的一段话）：日志 / 兼容旧界面用。
     *
     * 语义注意：这是**挂起等待回答**，不结束本 turn —— 收到它就回答（`agent:answer`），
     * 回答会作为工具结果回到同一个 turn 继续执行；不要当作回合结束信号。
     */
    question: string
    /** 结构化问题（DSH ask_user_question 契约）；老式纯文本提问时为空 */
    questions?: AskUserQuestion[]
  }
  /** 渲染层任务：taskId 由主进程生成；kind 决定渲染层处理器（如 export_word）；payload 为任务参数 */
  'agent/renderer-task': { taskId: string; kind: string; payload: any }
  'agent/plan': { plan: string | null }
  /**
   * 计划评审请求（exit_plan_mode）：**挂起等待用户裁决，不结束本 turn**。
   * 用 `agent:answer` 回复：`message` = 'approve' | 'keep' | 'dismiss'，
   * `answers[0].custom` = 「继续完善」时的反馈文本。
   */
  'agent/plan-review': { reviewId: string; plan: string }
  'agent/todos': { todos: TodoItem[] }
  'agent/search-status': { status: string; query?: string; results?: Array<{ title?: string; url?: string }>; action?: any }
  /** phase='start' 表示开始生成摘要；phase='end' 表示结束（ok=false 表示压缩未生效，保持原历史） */
  'agent/compaction': {
    phase: 'start' | 'end'
    kind: AgentCompactionKind
    ok?: boolean
    /** 被摘要替换掉的旧消息条数 */
    droppedMessages?: number
    /** 这些旧消息压缩前的估算 token */
    tokensBefore?: number
  }
  /**
   * 运行期提示（非致命，不打断 turn）。
   * - `truncated-continue`：模型输出被 max_tokens 截断，已自动续跑；
   * - `truncated-giveup`：连续截断达到上限，停止续跑（任务可能未完成，需要用户干预）。
   */
  'agent/notice': { kind: 'truncated-continue' | 'truncated-giveup'; message: string }
  'agent/error': { message: string }
}

/** 广播给渲染进程的 agent 事件（相关联合：payload 随 type 收窄） */
export type AgentEvent = {
  [K in AgentEventType]: {
    agentId: AgentId
    type: K
    payload: AgentEventMap[K]
  }
}[AgentEventType]

/** 活跃 agent 摘要（agent:list 返回值） */
export interface AgentSummary {
  id: AgentId
  status: AgentStatus
  provider: string
  label?: string
  pendingInbox: number
}

// ---------------------------------------------------------------------------
// 执行计划 / 待办 / 状态视图（ask_user 与 plan/todo 工具的 UI 投影）
// ---------------------------------------------------------------------------

export type TodoStatus = 'pending' | 'running' | 'done' | 'cancelled'

/** 待办项（update_todo 工具维护，对齐技能框架的 TodoItem） */
export interface TodoItem {
  id: string
  title: string
  detail?: string
  status: TodoStatus
}

/**
 * ask_user 的一个选项（对齐 DSH ask_user_question 的 options 项）。
 * 若推荐某项，请把它放在第一位并在 label 末尾加 "(Recommended)"。
 */
export interface AskUserOption {
  /** 面向用户的简短标签 */
  label: string
  /** 一句话说明取舍或影响 */
  description?: string
}

/**
 * ask_user 的一个问题（对齐 DSH ask_user_question 的 questions 项）。
 * - `options` 缺省 = 纯文本提问（用户自由填写）；
 * - `header` 是短标题（如「确认」「选择模式」），用于界面分组；
 * - `multiSelect` = true 时用户可多选（默认单选）。
 */
export interface AskUserQuestion {
  /** 稳定 id：回答会按 id 回填，模型据此对号入座 */
  id: string
  /** 具体问题 */
  question: string
  /** 可选短标题（界面展示） */
  header?: string
  /** 可选选项清单 */
  options?: AskUserOption[]
  /** 是否多选（默认 false） */
  multiSelect?: boolean
}

/**
 * ask_user 的单题回答（对齐 DSH 的回答载荷）。
 * `selected` 为空且无 `custom` = 用户显式跳过该题（不是「未回答」）。
 */
export interface AskUserAnswer {
  /** 对应的问题 id */
  id: string
  /** 选中的选项 label 列表 */
  selected: string[]
  /** 自定义回答（自由文本；跳过的题没有它） */
  custom?: string
}

/** 执行计划（update_plan 工具维护的文本计划） */
export interface PlanState {
  plan: string | null
}

/** agent 完整状态快照（agent:state 返回值，供 UI 恢复） */
export interface AgentStateView extends AgentSummary {
  turn: number
  step: number
  plan: string | null
  todos: TodoItem[]
  /**
   * 仍待用户裁决的计划评审（exit_plan_mode）。
   * 会话已销毁时由**日志折叠**得出（进程重启后仍在）——界面据此恢复那条未完成的决策。
   */
  pendingPlanReview?: { reviewId: string; plan: string } | null
  lastError?: string
  /** 最近一次 assistant 完整内容（供工作流智能体节点取最终结果） */
  lastAssistantContent?: string
}
