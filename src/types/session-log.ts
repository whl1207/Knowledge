/**
 * session-log.ts — 会话事件类型（事件溯源日志的共享词汇表）
 *
 * 借鉴 DeepSeek-Harness 的会话日志设计（docs/subsystems/session.md）：
 * - 会话日志是**只追加**（append-only）的事件流，是会话的**单一事实源**；
 * - 原则：**"模型可见即已记录"（Model-visible means logged）**——凡是发给
 *   模型的内容都必须能从日志重建，因此新增模型可见输入就必须新增事件；
 * - fork / 恢复 / transcript / 遥测 / UI 渲染都应从事件流派生，而不是
 *   维护第二份"消息状态"。
 *
 * 本文件只声明类型（主进程与渲染进程共用），实现见
 * `electron/main/session-log.ts`。
 */

import type { TodoItem } from '@/types/agent'

// ---------------------------------------------------------------------------
// 事件目录
// ---------------------------------------------------------------------------

/** 会话事件类型目录：新增事件类型必须同时扩展 `SessionEventMap` */
export type SessionEventType =
  | 'session/start' // 会话创建（携带 provider/model 等元数据）
  | 'session/end' // 会话结束（completed / error / aborted / disposed）
  | 'turn/start' // 轮次开始（turn = 零个或多个 step）
  | 'turn/end' // 轮次结束
  | 'step/start' // 步骤开始（step = 一次模型请求 + 它调用的工具）
  | 'step/end' // 步骤结束
  | 'user/message' // 用户消息（模型可见）
  | 'assistant/chunk' // 助手流式增量（仅 UI 保真，不参与 deriveMessages）
  | 'assistant/message' // 助手完整消息（模型可见）
  | 'tool/call' // 模型发起的工具调用（模型可见）
  | 'tool/result' // 工具执行结果（模型可见）
  | 'assistant/search-status' // 服务端联网搜索状态（deepseek-responses web_search_call，仅 UI 保真）
  | 'context/compaction' // 上下文压缩（旧轮次摘要；deriveMessages 据此替换被覆盖区间）
  | 'agent/status' // agent 生命周期状态（idle/running/stopping/disposed）
  | 'plan/write' // 执行计划整值写入（update_plan / exit_plan_mode；最后一条胜出）
  | 'todo/write' // 待办清单整值写入（update_todo；最后一条胜出）
  | 'plan/review' // 计划评审开启（exit_plan_mode 提交，等待用户裁决）
  | 'plan/review-result' // 计划评审裁决（批准 / 继续完善 / 关闭 / 取消）

/** 每个事件的载荷 */
export interface SessionEventMap {
  'session/start': {
    provider?: string
    model?: string
    systemPrompt?: string // 模型可见的 system prompt（"模型可见即已记录"）
    createdAt: number
  }
  'session/end': {
    status: 'completed' | 'error' | 'aborted' | 'disposed'
    error?: string
  }
  'turn/start': { turn: number }
  'turn/end': { turn: number; reason: 'completed' | 'cancelled' | 'error' }
  'step/start': { turn: number; step: number }
  'step/end': { turn: number; step: number; toolCalls: number }
  'user/message': {
    content: string
    source?: string
    /**
     * 附图数量（只记数量，不落 base64）：图片本体存在 AgentSession 内存里，
     * 请求时按「第几条 user 消息带图」挂回去。写日志只为回放/审计能看到「这条带了图」。
     */
    images?: number
  }
  'assistant/chunk': { content: string }
  'assistant/message': {
    content: string
    toolCalls?: Array<{ id: string; name: string; arguments: any }>
    reasoning?: string
  }
  'tool/call': { callId: string; name: string; args: any; step?: number; /** 参数无法解析时：原文长度（便于诊断截断/畸形） */ argsRawLen?: number }
  'tool/result': {
    callId: string
    name: string
    ok: boolean
    /** 工具返回的**原文**（唯一事实源：UI / 审计 / 回放都读它） */
    value?: any
    error?: string
    /** UI 专用差异预览（不进模型上下文：deriveMessages 只序列化 value） */
    preview?: any
    /**
     * 模型可见的那一份文本（复刻 DSH 的 tool-result pruner）。
     * 只有当原文超出预算、中段被掐掉时才存在：
     * `deriveEntries` 优先用它，因此**超预算结果的模型上下文是裁剪版，落盘原文不变**。
     * 它是 `value + error` 的纯函数（`@/shared/toolResultBudget` 的 `boundToolResult`），
     * 确定性可重算，所以不需要为了"可重建"而放弃裁剪。
     */
    modelValue?: string
    /** `modelValue` 相对原文丢弃的码点数（审计 / UI 展示；与 modelValue 同生共死） */
    omittedChars?: number
    /**
     * 完整原文落盘的绝对路径（复刻 DSH 的 spill-policy）。
     * 只有原文超过 `TOOL_RESULT_SPILL_THRESHOLD_CHARS` 时才存在：
     * 此时 `modelValue` 是"头 + 尾 + 定位提示"，模型可用 `read_file` 打开该路径回读全文。
     * 落在系统临时目录（缓存语义），文件可能被系统清理——此时 read_file 会给出明确的
     * "文件不存在"，模型重跑一次工具即可，不影响正确性。
     */
    spillPath?: string
    /**
     * 本条结果对应的 `tool/call` 事件的 seq（复刻 DSH 的 `sourceEventSeqs`）。
     *
     * 为什么需要它：按 `callId` 做"最后一条结果胜出"的关联在单次执行下没问题，
     * 但一旦同一个 `callId` 被写两次（崩溃后补写结果、将来并行执行时的重放），
     * 谁对应哪次调用就说不清了。显式引用把关联从"位置推断"变成"事实引用"，
     * 也为重放/幂等留出空间。旧日志没有这个字段，`deriveEntries` 会退回落到 callId 关联。
     */
    sourceEventSeqs?: number[]
  }
  'assistant/search-status': {
    status: string
    query?: string
    results?: Array<{ title?: string; url?: string }>
    action?: any
  }
  /**
   * 上下文压缩：把 [fromSeq, toSeq] 事件区间内的模型可见消息替换为一条结构化摘要。
   * 事件本身追加在区间之后（压缩那一刻写入），deriveMessages 会把它搬回区间起点，
   * 从而得到「system → 摘要 → 最近若干轮原文」的历史。
   */
  'context/compaction': {
    fromSeq: number
    toSeq: number
    summary: string
    /** 压缩前 / 后的大致 token（估算，用于日志与 UI 展示） */
    tokensBefore: number
    tokensAfter: number
    /** 被替换掉的消息条数 */
    droppedMessages: number
    /** 触发方式：主动阈值 / 溢出重试 / 用户手动 */
    kind: 'auto' | 'overflow-retry' | 'manual'
    /** 生成摘要的模型（审计用） */
    model?: string
  }
  'agent/status': { status: string }
  /**
   * 执行计划写入（整值替换，最后一条胜出）。`plan=null` = 清除计划。
   * 单一写入口：`AgentImpl.setPlan()`（update_plan / exit_plan_mode 工具都经过它）。
   */
  'plan/write': { plan: string | null }
  /**
   * 待办清单写入（整值替换，最后一条胜出）。`todos=[]` = 清单已清空。
   * 单一写入口：`AgentImpl.setTodos()`（update_todo 工具）。
   */
  'todo/write': { todos: TodoItem[] }
  /**
   * 计划评审开启（exit_plan_mode 提交）。落盘的意义：进程重启后「待评审」仍然是
   * 日志折叠出来的事实（`pendingReview`），界面据此恢复那条未完成的决策，
   * 而不是当成"从没提过评审"。
   */
  'plan/review': { reviewId: string; plan: string }
  /**
   * 计划评审裁决。`verdict`：approve（批准）/ keep（继续完善）/ dismiss（用户接手）/
   * cancelled（turn 被取消或会话销毁时收口）。`feedback` 仅 keep 时有。
   */
  'plan/review-result': { reviewId: string; verdict: string; feedback?: string }
}

/** 事件基础字段：顺序号 + 时间戳 + 归属会话 */
export interface SessionEventBase {
  seq: number
  ts: number
  sessionId: string
}

/** 完整会话事件（按 type 收窄的派生联合） */
export type SessionEvent = {
  [K in SessionEventType]: SessionEventBase & { type: K } & SessionEventMap[K]
}[SessionEventType]

/** 事件类型 → 载荷的查表（供校验/收窄使用） */
export type SessionEventPayload<K extends SessionEventType> = SessionEventMap[K]

// ---------------------------------------------------------------------------
// 派生视图
// ---------------------------------------------------------------------------

/** 从事件日志派生出的模型历史消息（对齐 DSH deriveMessages()） */
export interface DerivedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** assistant 消息携带的工具调用（OpenAI 格式） */
  toolCalls?: Array<{ id: string; name: string; arguments: any }>
  /** tool 消息对应的调用 id */
  toolCallId?: string
  /** tool 消息的工具名 */
  name?: string
  /** 该消息由上下文压缩摘要合成（不是真实用户输入：不计入轮次/附图序号） */
  compacted?: boolean
}

/** 派生消息 + 它来源于哪条事件（供上下文压缩确定事件区间） */
export interface DerivedEntry {
  /** 来源事件 seq；压缩摘要合成为虚拟值（区间起点之前的半整数） */
  seq: number
  msg: DerivedMessage
}

// ---------------------------------------------------------------------------
// 运行时不变量的断言结果
// ---------------------------------------------------------------------------

/** 会话日志完整性校验结果 */
export interface SessionLogIntegrity {
  ok: boolean
  /** 当前日志长度 */
  seq: number
  /** 不变量违规说明（ok 为 false 时有值） */
  violation?: string
}
