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
  | 'agent/status' // agent 生命周期状态（idle/running/stopping/disposed）

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
    value?: any
    error?: string
    /** UI 专用差异预览（不进模型上下文：deriveMessages 只序列化 value） */
    preview?: any
  }
  'assistant/search-status': {
    status: string
    query?: string
    results?: Array<{ title?: string; url?: string }>
    action?: any
  }
  'agent/status': { status: string }
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
