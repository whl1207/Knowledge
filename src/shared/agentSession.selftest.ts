/**
 * agentSession.selftest.ts — 跨轮会话签名与旧日志兼容判定
 *
 * 这些断言保护两类回归：
 * 1. 工具顺序不同不应切会话（白名单来自不同入口时顺序可能不同）；
 * 2. 旧日志没有 signature 时，只能按 provider/model 宽松接管，不能无条件复用。
 */

import { agentSessionSignature, canResumeSessionStart } from './agentSession'
import type { AgentOptions } from '@/types/agent'

export interface AgentSessionCase { name: string; ok: boolean; detail?: string }

function base(over: Partial<AgentOptions> = {}): AgentOptions {
  return {
    provider: 'deepseek',
    config: { model: 'deepseek-chat' },
    llmConfig: { model: 'deepseek-chat' },
    systemPrompt: 'SYS',
    tools: ['read_file', 'search_files'],
    ...over,
  }
}

export function runAgentSessionSelfTest(): AgentSessionCase[] {
  const cases: AgentSessionCase[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  const a = agentSessionSignature(base())
  const b = agentSessionSignature(base())
  add('签名稳定：同配置同签名', a === b, `${a} / ${b}`)

  const reordered = agentSessionSignature(base({ tools: ['search_files', 'read_file'] }))
  add('工具顺序不影响签名（排序后比较）', a === reordered)

  const toolsChanged = agentSessionSignature(base({ tools: ['read_file'] }))
  add('工具集变化 → 新签名', a !== toolsChanged)

  const modelChanged = agentSessionSignature(base({
    config: { model: 'deepseek-reasoner' },
    llmConfig: { model: 'deepseek-reasoner' },
  }))
  add('换模型 → 新签名', a !== modelChanged)

  const promptChanged = agentSessionSignature(base({ systemPrompt: 'SYS2' }))
  add('系统提示变化 → 新签名', a !== promptChanged)

  const ctxOnly = agentSessionSignature(base({ maxSteps: 12, contextLimit: 32000, tokenScale: 1.2, temperature: 0.1 } as any))
  add('运行参数不影响签名（可原地更新）', a === ctxOnly)

  add('新日志 signature 相同 → 可恢复', canResumeSessionStart({ provider: 'deepseek', model: 'deepseek-chat', signature: a }, base()))
  add('新日志 signature 不同 → 不可恢复', !canResumeSessionStart({ provider: 'deepseek', model: 'deepseek-chat', signature: 'v1-deadbeef' }, base()))
  add('旧日志无 signature：不自动接管（需显式导入）', !canResumeSessionStart({ provider: 'deepseek', model: 'deepseek-chat' }, base()))
  add('null start → 拒绝', !canResumeSessionStart(null, base()))

  return cases
}
