/**
 * tool.ts — 统一工具注册表类型（工具定义 / 执行上下文 / 结果 / 管线）
 *
 * 借鉴 DeepSeek-Harness 的工具注册表与执行管线设计（docs/subsystems/tools.md）：
 * - **作用域化注册**：工具按 scope 分层注册（host 层 + 每 agent/preset 层），
 *   读取时合并全局层与调用方作用域链，最近层同名条目胜出；
 * - **把关的执行管线**：`pre-execute → execute → post-execute` 三段均可拦截，
 *   所有工具结果统一 `ToolResult` 形状（含 isError），杜绝"部分输出冒充成功"；
 * - 事件：`tool/pre-execute` / `tool/post-execute` 携带快照，供审计与 UI。
 *
 * 实现见 `src/shared/toolRegistry.ts`（主进程与渲染进程共用）。
 */

import type { ToolName } from '@/types/ids'
import type { EditDiffPreview } from '@/shared/editDiff'

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

/** 工具执行上下文：一次调用的环境信息 */
export interface ToolExecutionContext {
  /** 发起调用的 agent id */
  agentId?: string
  /** 归属会话 id */
  sessionId?: string
  /** 作用域键（agent id / preset 名），决定读取哪一层注册 */
  scope?: string
  /** 工作区根目录（读写类工具用于路径围栏） */
  cwd?: string
  /** 取消信号 */
  signal?: AbortSignal
  /** 额外上下文 */
  [key: string]: unknown
}

/**
 * PTC（run_code）UI 专用预览载荷：程序内每次子调用的完整入参。
 *
 * 与 `EditDiffPreview` 同理：只随 `tool/result` 事件发给渲染进程（模型不可见）——
 * run_code 回给模型的值里只保留子调用的名字/成败（避免把程序内所有入参回灌上下文）。
 */
export interface PtcRunPreview {
  kind: 'ptc-run'
  toolCalls: Array<{ name: string; input?: any; ok: boolean; error?: string }>
}

/** 统一工具结果：ok 为 false 即失败（isError 语义） */
export interface ToolResult {
  ok: boolean
  value?: unknown
  error?: string
  /**
   * UI 专用预览载荷（如编辑类工具的差异行）。
   *
   * ⚠️ 与 `value` 的区别：`value` 会被 `JSON.stringify` 成 tool 消息进入模型上下文，
   * `preview` 只随 `tool/result` 事件发给渲染进程，模型不可见（差异可能很大，不能进上下文）。
   */
  preview?: EditDiffPreview | PtcRunPreview
}

/** 工具定义：name 全局唯一（作用域内）；handler 执行真实逻辑 */
export interface ToolDefinition {
  /** 工具名（snake_case，品牌化 ToolName） */
  name: ToolName
  /** 面向模型的描述（进入 system prompt 的工具 schema） */
  description: string
  /** JSON Schema（OpenAI 风格 parameters），可省略 */
  inputSchema?: Record<string, unknown>
  /** 执行是否需要用户审批（预留 approval seam） */
  requiresApproval?: boolean
  /** 真正执行工具 */
  handler: (input: any, ctx: ToolExecutionContext) => Promise<ToolResult> | ToolResult
}

// ---------------------------------------------------------------------------
// 执行管线
// ---------------------------------------------------------------------------

/** pre 钩子的返回：可改写入参，或短路跳过 handler 直接给结果 */
export interface PreHookResult {
  input?: any
  skip?: boolean
  result?: ToolResult
}

/** pre-execute 钩子：在 handler 之前运行，可改写 input / 短路 / 拒绝 */
export type ToolPreHook = (
  info: { name: ToolName; input: any; ctx: ToolExecutionContext },
) => Promise<PreHookResult | void> | PreHookResult | void

/** post-execute 钩子：在 handler 之后运行，可改写结果 */
export type ToolPostHook = (
  info: { name: ToolName; input: any; ctx: ToolExecutionContext; result: ToolResult },
) => Promise<ToolResult | void> | ToolResult | void

/** 管线阶段 */
export type ToolPipelinePhase = 'pre' | 'post'

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

/** 注册表事件目录 */
export interface ToolRegistryEventMap {
  /** 工具注册/注销 */
  'tool/registered': { name: ToolName; scope?: string }
  'tool/unregistered': { name: ToolName; scope?: string }
  /** 管线事件（快照，只读语义） */
  'tool/pre-execute': { name: ToolName; input: any; ctx: ToolExecutionContext }
  'tool/post-execute': { name: ToolName; input: any; ctx: ToolExecutionContext; result: ToolResult }
  /** 执行失败（handler 抛异常时） */
  'tool/error': { name: ToolName; error: string }
}

export type ToolRegistryEvent = {
  [K in keyof ToolRegistryEventMap]: { type: K } & ToolRegistryEventMap[K]
}[keyof ToolRegistryEventMap]

/** 注册表只读快照（供 IPC 序列化与 UI 展示） */
export interface ToolRegistrySnapshot {
  name: ToolName
  description: string
  scope?: string
  hasInputSchema: boolean
}
