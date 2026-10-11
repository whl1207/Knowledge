/**
 * presentation.ts — 「工具呈现方式」落地为 AgentOptions（渲染进程唯一实现）
 *
 * 对齐 DeepSeek-Harness：呈现方式按 agent（预设）声明一次，native 与 PTC 共享同一份
 * 能力目录，差别只在模型看到的形态——PTC 只暴露 `run_code` 与生成的 `tools:sdk` 段。
 *
 * 所有走 agent 循环的入口（聊天预设 / 工作流节点 / 集群成员 / 批量）
 * 都调用本模块，避免各处各拼一套「补 run_code + 叠 SDK 段」而漏改。
 */

import { agentBridge } from '@/platform/agentBridge'
import {
  RUN_CODE_TOOL,
  buildPtcSystemPrompt,
  presentationToEngine,
  withPresentationTools,
  type AgentToolPresentation,
} from './ptc'

export { RUN_CODE_TOOL }

export interface AppliedToolPresentation {
  /** 最终 system prompt（PTC = 基础提示 + `tools:sdk` 段） */
  systemPrompt: string
  /** 最终工具白名单（PTC 已补 run_code——引擎守卫要求它在白名单内） */
  tools: string[]
  /** 直接赋给 AgentOptions.toolsPresentation */
  toolsPresentation: 'native' | 'code'
}

/**
 * 把「基础提示词 + 能力目录 + 呈现方式」组装为 AgentOptions 需要的三项。
 *
 * @param basePrompt assembleAgentSystemPrompt 的输出（PTC 时在其后叠加 SDK 段）
 * @param catalog 能力目录（PTC 的 SDK 声明 = 该目录本身，不含 run_code）
 * @param scope 工具注册表作用域（与 agent 会话一致，SDK 声明才含该作用域注册的工具）
 */
export async function applyToolPresentation(input: {
  basePrompt: string
  catalog: readonly string[]
  presentation: AgentToolPresentation
  scope?: string
}): Promise<AppliedToolPresentation> {
  const { basePrompt, catalog, presentation, scope } = input
  if (presentation !== 'ptc') {
    return { systemPrompt: basePrompt, tools: [...catalog], toolsPresentation: 'native' }
  }
  // SDK 段由主进程按注册表生成；网页端 / 旧构建取不到时静默降级为「基础提示 + run_code」
  let sdkDocs = ''
  try {
    sdkDocs = await agentBridge.getSdkDocs(scope, [...catalog])
  } catch { /* 无桌面 agent：不影响执行，SDK 段留空 */ }
  return {
    systemPrompt: buildPtcSystemPrompt({ basePrompt, sdkDocs }),
    tools: withPresentationTools(catalog, presentation),
    toolsPresentation: presentationToEngine(presentation),
  }
}
