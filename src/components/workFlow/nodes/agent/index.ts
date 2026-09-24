/**
 * agent executor - 智能体节点
 *
 * 可选择「通用智能体」或「预设智能体」（store.agentPresets）。
 * 属性只需一个「任务提示词」模板（支持 {{节点.字段}} 引用上游节点输出），
 * 与上游节点共同构造任务后接入主进程 agent-loop（IPC agent:run）执行。
 * - 预设智能体：systemPrompt/工具白名单/模型/知识库/MCP 均来自预设配置
 * - 通用智能体：自主规划 prompt + 全局工具白名单（设置 → 工具管理）
 */
import type { NodeExecutor, ExecutionContext } from '@/components/workFlow/engine/NodeExecutor'
import type { NodeData } from '@/components/workFlow/engine/WorkflowRunner'
import type { AgentOptions } from '@/types/agent'
import { SKILL_AGENT_DEFAULT_TOOLS } from '@/lib/agent/skill'
import { assembleAgentSystemPrompt, buildMcpServersContext, ensureAgentSkills, workspaceRoot } from '@/lib/agent/promptContext'
import { toolsFromCapabilities } from '@/lib/agent/capabilities'
import { normalizeAgentMaxSteps, resolveAgentMaxSteps } from '@/shared/agent-loop-rounds'
import { resolveLlmSource } from '@/shared/llmSources'

/** 预设能力槽 → 工具白名单（统一数据源：src/lib/agent/capabilities.ts） */
function presetTools(caps: any): string[] {
  return toolsFromCapabilities(caps)
}

/** 从 store.AIconfig 组装 provider 配置（对齐 useAgentRun.buildAgentProviderConfig） */
function buildProvider(store: any, llmType?: string): { provider: string; config: any; llmConfig: any } {
  const llm = store?.AIconfig?.llm || {}
  // 单来源解析：DeepSeek 只有一个来源（deepseek），接口样式随 config.api_style 下发；历史别名在此归一
  const { type, config } = resolveLlmSource(llm, llmType || llm.type || 'ollama')
  return { provider: type, config, llmConfig: { ...llm, type, stream: true, temperature: llm.temperature, max_tokens: llm.max_tokens } }
}

/** 已启用的 MCP 服务（设置 → MCP 服务中 enabled !== false 的） */
function activeMcpServers(store: any): any[] {
  return (store?.mcpServers || []).filter((s: any) => s && s.enabled !== false && s.transport !== 'inmemory')
}

/** 根据 presetId 组装 agent 选项；presetId 为空则走「通用智能体」 */
async function buildAgentOptions(node: NodeData, ctx: ExecutionContext): Promise<AgentOptions> {
  const cfg = node.agentConfig || {}
  const store: any = ctx.store
  const preset = cfg.presetId
    ? (store?.agentPresets || []).find((p: any) => p.id === cfg.presetId)
    : undefined
  // 技能库引导：与聊天/批量/集群同一逻辑（按当前 store.skillsPath 加载，含主进程 skillService 根目录）
  const enabledSkills = await ensureAgentSkills(store)
  const sandboxMode: any = store?.pythonSandbox || (store?.TrustedPython ? 'trusted' : 'safe')
  const mcpServers = activeMcpServers(store)
  const base: any = {
    toolsPresentation: 'native',
    scope: 'workflow',
    label: node.name || 'workflow-agent',
    // 循环轮数：唯一数据源 = 「智能体预设 → 通用智能体」的 store.generalAgentMaxSteps（预设分支再覆盖）
    maxSteps: normalizeAgentMaxSteps(store?.generalAgentMaxSteps),
    sandboxMode,
    disabledSkills: store?.disabledSkills || [],
    cwd: workspaceRoot(store) || undefined,
  }

  // ---- 预设智能体：能力/模型/知识库/MCP 均来自预设 ----
  if (preset) {
    const caps = preset.capabilities || {}
    const tools = presetTools(caps)
    const ids: string[] = caps.mcpServerIds || (caps.mcpServerId ? [caps.mcpServerId] : [])
    // MCP 工具清单（含 serverId）：模型据此调用 mcp_call
    const mcpCtx = (caps.mcpAccess && ids.length > 0)
      ? await buildMcpServersContext(mcpServers.filter((s: any) => ids.includes(s.id)), store.locales)
      : ''
    // system prompt 统一由共享组装函数生成（指令段 / 知识库 / 所选技能 / MCP / 工作区）
    const assembled = assembleAgentSystemPrompt({
      store, preset, tools, enabledSkills,
      disabledSkills: store?.disabledSkills || [],
      mcpContext: mcpCtx,
      provider: preset.llmType || store?.AIconfig?.llm?.type,
    })
    return {
      ...base,
      cwd: assembled.cwd,
      systemPrompt: assembled.systemPrompt,
      tools: assembled.tools,
      ...buildProvider(store, preset.llmType),
      kbPaths: caps.knowledgeBaseFiles || [],
      kbTopK: typeof preset.kbTopK === 'number' ? preset.kbTopK : 5,
      mcpServerIds: caps.mcpAccess ? ids : undefined,
      mcpServerConfigs: caps.mcpAccess ? mcpServers.filter((s: any) => ids.includes(s.id)) : undefined,
      mcpEquipmentIds: caps.mcpEquipmentIds || undefined,
      // 循环轮数：预设自带轮数为唯一例外，未配置时回退全局唯一数据源（不再读节点自身 cfg）
      maxSteps: resolveAgentMaxSteps(preset.maxSteps, store?.generalAgentMaxSteps),
    }
  }

  // ---- 通用智能体：自主规划 prompt + 全局工具白名单 ----
  const tools = store?.agentTools === null || store?.agentTools === undefined
    ? [...SKILL_AGENT_DEFAULT_TOOLS]
    : [...store.agentTools]
  const mcpCtx = tools.includes('mcp_call')
    ? await buildMcpServersContext(mcpServers, store.locales)
    : ''
  const assembled = assembleAgentSystemPrompt({ store, tools, enabledSkills, mcpContext: mcpCtx })
  return {
    ...base,
    cwd: assembled.cwd,
    systemPrompt: assembled.systemPrompt,
    tools: assembled.tools,
    ...buildProvider(store),
    mcpServerIds: mcpServers.map((s: any) => s.id),
    mcpServerConfigs: mcpServers,
  }
}

export const agentExecutor: NodeExecutor = {
  type: 'agent',
  label: '智能体节点',
  async execute(node: NodeData, ctx: ExecutionContext): Promise<boolean> {
    const cfg = node.agentConfig || {}

    // 输入：任务提示词模板（支持 {{节点.字段}} 引用上游）；为空则取上游上下文
    let input = ''
    const prompt = (cfg.prompt || '').trim()
    if (prompt) {
      input = ctx.resolveTemplate(prompt, node.id)
    } else {
      const contexts = await ctx.getNodeContextWithPorts(node.id, ctx.decisionPaths)
      input = contexts.join('\n\n')
    }
    if (!input.trim()) input = ctx.t('agent_empty_input')

    const options = await buildAgentOptions(node, ctx)
    const timeoutMs = Math.max(5000, cfg.timeoutMs || 600000)

    try {
      ctx.log(`${ctx.t('agent_node')} 运行中…`, 'info')
      const res = await ctx.safeIpcInvoke('agent:run', { options, input, timeoutMs })
      const data = (res && typeof res === 'object' && 'data' in res) ? res.data : res
      const content = data?.content || ''
      const timedOut = !!data?.timedOut
      const err = data?.error
      const ok = !err && !timedOut

      node.result = JSON.stringify({
        type: 'agent', success: ok, input,
        result: content, output: content,
        timedOut, error: err,
        timestamp: new Date().toISOString()
      })
      node.status = ok ? 'success' : 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, node.status, node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, node.status, node.result)
      if (!ok) ctx.log(`${ctx.t('agent_error')}${timedOut ? '（超时）' : ''}: ${err || ''}`, 'error')
      return ok
    } catch (e: any) {
      node.result = JSON.stringify({ result: `${ctx.t('agent_error')}: ${e?.message}`, type: 'agent', success: false, error: e?.message, timestamp: new Date().toISOString() })
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      ctx.log(`${ctx.t('agent_error')}: ${e?.message}`, 'error')
      return false
    }
  }
}
