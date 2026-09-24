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
   * 沙箱模式（'safe' | 'workspace' | 'trusted'）：传给工具执行上下文，
   * 由统一策略解析（sandbox-policy）决定 run_python/shell 的放行级别；
   * 缺省视为 'safe'（fail-closed）。
   */
  sandboxMode?: 'safe' | 'workspace' | 'trusted'
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
  | 'agent/todos' // 待办清单更新（update_todo 工具）
  | 'agent/search-status' // 服务端联网搜索状态（deepseek-responses web_search_call）
  | 'agent/error'

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
  'agent/step-end': { turn: number; step: number; toolCalls: number; usage?: AgentStepUsage }
  'agent/inbox': { pending: number }
  'assistant/chunk': { content: string }
  'assistant/reasoning': { text: string }
  'assistant/message': { content: string; toolCalls?: Array<{ id: string; name: string; arguments: any }> }
  'tool/call': { callId: string; name: string; args: any; /** 参数解析失败（畸形/被截断）：已回退到错误提示，不再执行工具 */ argsParseFailed?: boolean }
  /** preview：UI 专用差异预览（不进模型上下文，见 ToolResult.preview） */
  'tool/result': { callId: string; name: string; ok: boolean; value?: any; error?: string; preview?: any }
  'agent/tool-args': { callId: string; name: string; argsFragment: string }
  'agent/question': { askId: string; question: string }
  /** 渲染层任务：taskId 由主进程生成；kind 决定渲染层处理器（如 export_word）；payload 为任务参数 */
  'agent/renderer-task': { taskId: string; kind: string; payload: any }
  'agent/plan': { plan: string | null }
  'agent/todos': { todos: TodoItem[] }
  'agent/search-status': { status: string; query?: string; results?: Array<{ title?: string; url?: string }>; action?: any }
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
  lastError?: string
  /** 最近一次 assistant 完整内容（供工作流智能体节点取最终结果） */
  lastAssistantContent?: string
}
