/**
 * presetOptions.ts — 「智能体预设 / 能力槽」→ AgentOptions 的统一组装（渲染进程）
 *
 * 与 `useAgentRun` / `swarmRunner` / 批量共用同一套数据源：
 * 提示词交给 `lib/agent/promptContext`，工具白名单交给 `lib/agent/capabilities`，
 * 模型来源交给 `shared/llmSources`，循环轮数交给 `shared/agent-loop-rounds`。
 *
 * 新入口（如工作流智能体节点）只应调用本函数，不要再自己拼一套「能力槽 → 工具 / 提示词」，
 * 否则会重演 capabilities.ts 顶部记录过的「新增工具时各调用点漏改」问题。
 */

import type { AgentOptions } from '@/types/agent'
import { toolsFromCapabilities } from '@/lib/agent/capabilities'
import { applyToolPresentation } from '@/lib/agent/presentation'
import { presetPresentation } from '@/lib/agent/ptc'
import {
  assembleAgentSystemPrompt,
  buildMcpServersContext,
  ensureAgentSkills,
  workspaceRoot,
  type PromptSkillBrief,
} from '@/lib/agent/promptContext'
import { SKILL_AGENT_DEFAULT_TOOLS } from '@/lib/agent/skill'
import { getSkillManager } from '@/services/agentSkills'
import { resolveAgentMaxSteps } from '@/shared/agent-loop-rounds'
import { normalizeLlmType, resolveLlmSource } from '@/shared/llmSources'

/** 调用方（节点 / 任务）级的模型覆盖；`provider` 为空 = 跟随预设，其次跟随全局 */
export interface AgentModelOverride {
  provider?: string
  name?: string
  /** 推理参数（与大语言模型节点同一形状：temperature / max_tokens） */
  completion_params?: Record<string, unknown>
}

export interface PresetAgentOptionsInput {
  store: any
  /** 智能体预设（store.agentPresets 项）；null = 通用智能体（自主规划） */
  preset?: any | null
  /** 无预设时的能力配置（自持 capabilities 的调用方） */
  capabilities?: any
  /** 无预设时的自定义提示词 */
  customPrompt?: string
  /** 工具白名单覆盖；空 = 跟随预设（无预设时用技能模式默认工具集） */
  toolsOverride?: readonly string[] | null
  /** 模型覆盖；provider 为空 = 跟随预设（其次全局） */
  model?: AgentModelOverride | null
  /** 循环轮数覆盖；缺省 = 预设自带轮数（其次全局唯一数据源） */
  maxSteps?: number
  /** 会话标签（展示用） */
  label: string
  /** 工具注册表作用域（按入口隔离，如 `workflow-<nodeId>`） */
  scope?: string
  /** 追加到 system prompt 末尾的段落（调用方特有要求） */
  extraAppend?: string
  /** 运行期是否有人应答；false 时剔除 ask_user（工作流 / 批量默认无人应答） */
  interactive?: boolean
}

export interface PresetAgentOptionsResult {
  options: AgentOptions
  systemPrompt: string
  tools: string[]
  cwd: string | undefined
}

/** `custom:0` → 来源类型 + 自定义来源下标（与 engine/modelBridge 的 splitProvider 同一约定） */
function splitProvider(provider: string): { type: string; customIndex?: number } {
  if (provider.startsWith('custom:')) {
    const index = Number.parseInt(provider.slice('custom:'.length), 10)
    return { type: 'custom', customIndex: Number.isNaN(index) ? 0 : index }
  }
  return { type: normalizeLlmType(provider) }
}

/**
 * 组装预设（或能力槽）驱动的 AgentOptions。
 * 调用方负责 `systemPrompt` / `tools` 之外的会话编排（create / send / 等待 / dispose）。
 */
export async function buildPresetAgentOptions(input: PresetAgentOptionsInput): Promise<PresetAgentOptionsResult> {
  const store: any = input.store || {}
  const llm: any = store.AIconfig?.llm || {}
  const preset: any = input.preset || null
  const caps: any = preset?.capabilities || input.capabilities || {}

  // —— 工具白名单：显式覆盖 > 预设能力槽 > 技能模式默认工具集 ——
  let tools: string[] = Array.isArray(input.toolsOverride) && input.toolsOverride.length
    ? [...input.toolsOverride]
    : (preset ? toolsFromCapabilities(caps) : [...SKILL_AGENT_DEFAULT_TOOLS])
  // 无人应答的运行剔除 ask_user，避免 agent 卡在提问上（与批量同一策略）
  if (input.interactive === false) tools = tools.filter((tool) => tool !== 'ask_user')

  // —— 生效模型：节点覆盖 > 预设 > 全局 ——
  const overrideProvider = String(input.model?.provider || '').trim()
  const overrideModel = String(input.model?.name || '').trim()
  const effProvider = overrideProvider || String(preset?.llmType || '').trim() || String(llm.type || '')
  const effModel = overrideModel || (overrideProvider ? '' : String(preset?.model || '').trim())
  const nodeParams: Record<string, unknown> = input.model?.completion_params || {}
  const temperature = typeof nodeParams.temperature === 'number'
    ? nodeParams.temperature
    : (typeof preset?.temperature === 'number' ? preset.temperature : llm.temperature)
  const maxTokens = typeof nodeParams.max_tokens === 'number' ? nodeParams.max_tokens : llm.max_tokens

  // —— 技能库：所有 agent 入口的共同前置（不 await 则技能清单与勾选技能注入不进提示词）——
  const enabledSkills: PromptSkillBrief[] = await ensureAgentSkills(store)
  const skillManager = getSkillManager(store)
  const disabledSkills: string[] = store.disabledSkills || []

  // —— MCP：预设开着 mcp_call 才把绑定服务的工具清单注入提示词 ——
  const mcpIds: string[] = Array.isArray(caps.mcpServerIds)
    ? caps.mcpServerIds
    : (caps.mcpServerId ? [caps.mcpServerId] : [])
  const mcpServers: any[] = caps.mcpAccess
    ? (store.mcpServers || []).filter((server: any) => mcpIds.includes(server.id))
    : []
  const mcpContext = caps.mcpAccess && mcpServers.length
    ? await buildMcpServersContext(mcpServers, store.locales)
    : ''

  const { type: providerType, customIndex } = splitProvider(effProvider)
  const assembled = assembleAgentSystemPrompt({
    store,
    preset,
    capabilities: input.capabilities,
    customPrompt: input.customPrompt,
    tools,
    enabledSkills,
    resolveSkill: (key: string) => {
      const skill: any = skillManager.getSkills().find((s: any) => s.path === key) ?? skillManager.getSkill(key)
      return skill
        ? { name: String(skill.name || key), description: skill.description, path: skill.path, body: skill.body, content: skill.content }
        : null
    },
    disabledSkills,
    mcpContext,
    extraAppend: input.extraAppend,
    model: effModel || undefined,
    provider: providerType || undefined,
  })

  const { type, config } = resolveLlmSource(llm, providerType, customIndex)
  if (effModel) config.model = effModel

  // 呈现方式（预设声明）：'ptc' → 只暴露 run_code + 叠加 tools:sdk 段；无预设 = native（继承部署默认）
  const presented = await applyToolPresentation({
    basePrompt: assembled.systemPrompt,
    catalog: assembled.tools,
    presentation: presetPresentation(preset),
    scope: input.scope,
  })

  const options: AgentOptions = {
    systemPrompt: presented.systemPrompt,
    provider: type,
    config,
    llmConfig: { ...llm, type, stream: true, temperature, max_tokens: maxTokens },
    tools: presented.tools,
    toolsPresentation: presented.toolsPresentation,
    cwd: assembled.cwd ?? (workspaceRoot(store) || undefined),
    label: input.label,
    scope: input.scope,
    kbPaths: Array.isArray(caps.knowledgeBaseFiles) ? caps.knowledgeBaseFiles : [],
    kbTopK: typeof preset?.kbTopK === 'number' ? preset.kbTopK : 5,
    mcpServerIds: mcpIds,
    mcpServerConfigs: mcpServers,
    mcpEquipmentIds: caps.mcpEquipmentIds || undefined,
    sandboxMode: store.pythonSandbox || (store.TrustedPython ? 'trusted' : 'safe'),
    disabledSkills,
    maxSteps: resolveAgentMaxSteps(input.maxSteps ?? preset?.maxSteps, store.generalAgentMaxSteps),
    // 单次运行（工作流节点 / 批量）没有聊天上下文可继承，因此不传 seedHistory
  }

  return { options, systemPrompt: presented.systemPrompt, tools: presented.tools, cwd: options.cwd }
}
