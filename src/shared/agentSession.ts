/**
 * agentSession.ts — 跨轮 Agent 会话的身份与兼容判定（主进程 / 渲染进程共用）
 *
 * 背景：聊天早期实现是「每次发送新建一个 agent，把聊天记录当 seedHistory 重新落盘」。
 * 这会让长对话的会话日志呈 O(n²) 增长，并丢失上一轮的工具证据 / 图片 / 先读后写观察记录。
 * 现在改为「每个聊天复用一个会话日志」，但配置（模型 / 系统提示 / 工具集）变化时
 * 必须切新会话，否则旧历史会在错误的模型或工具面上继续。
 *
 * 本模块只做纯计算：根据影响「模型请求面」的字段生成稳定签名。
 * 不把 apiKey / 端点等易变或敏感字段算进去；它们变化不影响历史可复用性。
 */

import type { AgentOptions } from '@/types/agent'

/** 生成签名的算法版本：改变参与字段时必须递增，避免旧签名误判为兼容。 */
export const AGENT_SESSION_SIGNATURE_VERSION = 1

/** 32 位 FNV-1a：足够短、稳定、无依赖；碰撞概率对「同一用户本机聊天」可忽略。 */
function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** 取本次请求实际使用的模型名（config.model 优先，其次 llmConfig.model）。 */
export function agentSessionModel(options: Pick<AgentOptions, 'config' | 'llmConfig'>): string {
  return String(options?.config?.model ?? options?.llmConfig?.model ?? '').trim()
}

function sortedStrings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.map((v) => String(v)).sort()
}

/**
 * 影响「会话历史能否继续复用」的签名。
 *
 * 参与字段：
 * - provider / model（换模型后旧 assistant/tool 历史可能不兼容）
 * - systemPrompt（角色 / 工作区 / MCP 工具清单都在里面）
 * - tools / toolsPresentation（模型看到的工具面）
 * - cwd / scope / kbPaths / mcpServerIds（工具行为与检索面）
 *
 * 不参与：maxSteps、temperature、max_tokens、contextLimit、tokenScale、sandboxMode、
 * 窗口尺寸等「可原地更新」的运行参数。
 */
export function agentSessionSignature(options: AgentOptions): string {
  const tools = Array.isArray(options.tools)
    ? sortedStrings(options.tools)
    : 'all'
  const payload = {
    v: AGENT_SESSION_SIGNATURE_VERSION,
    provider: String(options.provider || ''),
    model: agentSessionModel(options),
    systemPrompt: String(options.systemPrompt || ''),
    tools,
    toolsPresentation: options.toolsPresentation || 'native',
    cwd: String(options.cwd || ''),
    scope: String(options.scope || ''),
    kbPaths: sortedStrings(options.kbPaths) || [],
    mcpServerIds: sortedStrings(options.mcpServerIds) || [],
  }
  return `v${AGENT_SESSION_SIGNATURE_VERSION}-${fnv1a(JSON.stringify(payload))}`
}

/**
 * 判断一个已存在的 `session/start` 是否还能被当前 options 续用。
 *
 * 只认显式签名：旧日志（没有 signature）不再自动接管——需要保留旧历史时，
 * 用户在「设置 → 通用 → 数据」里显式导入原始 JSON，再重新开始会话。
 */
export function canResumeSessionStart(
  start: { provider?: string; model?: string; signature?: string } | null | undefined,
  options: AgentOptions,
): boolean {
  if (!start?.signature) return false
  return start.signature === agentSessionSignature(options)
}
