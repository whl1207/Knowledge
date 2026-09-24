/**
 * ids.ts — 品牌化 ID（branded ids）
 *
 * 借鉴 DeepSeek-Harness 的 `branded id` 类型纪律：用字符串字面量类型把
 * 语义不同的 ID 区分开，杜绝 `requestId` / `chatId` / `jobId` 混用。
 *
 * 用法：
 *   const id: ChatId = brand('chat-123')
 *   function getChat(id: ChatId) { ... }   // 传入普通 string 会编译报错
 *
 * 注意：brand 只是编译期标记，运行时就是普通字符串，可安全用于 Map 键、
 * JSON 序列化与 IPC 传输。
 */

/** 品牌化工具类型：`Brand<string, 'ChatId'>` 即"带 ChatId 标签的字符串" */
export type Brand<T, B extends string> = T & { readonly __brand: B }

/** 给字符串打上品牌标签（运行时无开销） */
export function brand<T extends string, B extends string>(value: T, _brand?: B): Brand<T, B> {
  return value as Brand<T, B>
}

// ---------------------------------------------------------------------------
// 会话 / 请求
// ---------------------------------------------------------------------------

/** AI 会话 id（对应 ai-service 的 requestId，一次模型请求的生命周期） */
export type RequestId = Brand<string, 'RequestId'>

/** 聊天窗口 id（一次连续对话的持久身份） */
export type ChatId = Brand<string, 'ChatId'>

/** 会话日志 id（事件溯源日志的归属 id） */
export type SessionLogId = Brand<string, 'SessionLogId'>

// ---------------------------------------------------------------------------
// 领域对象
// ---------------------------------------------------------------------------

/** 知识库文件（.kb）id */
export type KbId = Brand<string, 'KbId'>

/** 工作流（.flow）id */
export type WorkflowId = Brand<string, 'WorkflowId'>

/** 后台任务 id（`<kind>-N`，对齐 DSH ctx.jobs） */
export type JobId = Brand<string, 'JobId'>

// ---------------------------------------------------------------------------
// 注册表对象
// ---------------------------------------------------------------------------

/** 技能名（kebab-case，对齐 DSH Skills 注册表） */
export type SkillName = Brand<string, 'SkillName'>

/** 工具名（工具注册表唯一标识） */
export type ToolName = Brand<string, 'ToolName'>

/** Agent id（agent 循环的活跃实例标识） */
export type AgentId = Brand<string, 'AgentId'>

// ---------------------------------------------------------------------------
// 常用校验
// ---------------------------------------------------------------------------

/** 技能名必须为 kebab-case（`^[a-z0-9]+(?:-[a-z0-9]+)*$`） */
export function isValidSkillName(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
}

/** 工具名必须为 snake_case（`^[a-z][a-z0-9_]*$`） */
export function isValidToolName(name: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(name)
}
