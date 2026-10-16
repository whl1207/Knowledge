/**
 * agentPresetOptions.ts — 把「智能体预设」解析成 `AgentOptions`（供 `ctx.agent.run` 委派用）
 *
 * 这一步只能发生在渲染层：预设（`store.agentPresets`）与模型配置（`store.AIconfig`）都住在这里。
 * 主进程拿到的是**已经组装好**的 options，它只负责裁定预算、裁剪工具、执行。
 *
 * ## 与「聊天里的智能体会话」的差异（有意为之，v1）
 *
 * 聊天/编排路径走的是 `assemble*` 那套（注入技能指令、知识库上下文、工作区解析、MCP 配置、
 * 计划/待办种子）。委派**不走**那套：
 * - 技能指令与 MCP 配置不注入 —— 委派出去的 agent 本来就拿不到 `mcp_call` / `skill`（D5 拒绝），
 *   注入了反而会让系统提示词描述一堆它没有的工具；
 * - 不带 `seedHistory` / `parentId` —— 委派是独立会话，"一次运行绝不变更父会话"（对齐 DSH）；
 * - `label` / `scope` 由主进程赋值（`plugin:<id>`），不从预设来。
 *
 * 保留的是：**预设自己的系统提示词**、按能力槽推导的工具白名单、该预设的模型与温度、
 * 预设的步数上限、以及工作区根目录。
 */

import { usestore } from '@/store'
import { toolsFromCapabilities } from '@/lib/agent/capabilities'
import { resolveAgentMaxSteps } from '@/shared/agent-loop-rounds'
import { resolveLlmSource, resolvePresetLlmType, resolvePresetModel } from '@/shared/llmSources'
import { pickLlmConfig, toIpcSafe } from './agentContract'
import type { PluginAgentOverrides, PluginAgentPreset, ResolvedAgentPreset } from './agent'

function presetList(): any[] {
  const store = usestore() as any
  return Array.isArray(store?.agentPresets) ? store.agentPresets : []
}

/** 预设摘要清单（给插件选预设用） */
export function listPluginAgentPresets(): PluginAgentPreset[] {
  return presetList()
    .map((p): PluginAgentPreset | null => {
      const id = String(p?.id ?? '').trim()
      if (!id) return null
      const maxSteps = Number(p?.maxSteps)
      return {
        id,
        name: String(p?.name ?? '').trim() || id,
        tools: toolsFromCapabilities(p?.capabilities || {}),
        ...(Number.isFinite(maxSteps) && maxSteps > 0 ? { maxSteps } : {}),
      }
    })
    .filter((p): p is PluginAgentPreset => p !== null)
}

/**
 * 插件按 id 指定的 MCP 服务 → 从**用户已配置**的服务清单里取那几条。
 *
 * 三条边界（都在这里收口）：
 * 1. 插件只能按 id 引用，**不能自带服务定义**（自带 = 允许插件任意起进程，与整套权限模型冲突）；
 * 2. 只认用户清单里**存在且启用**的服务 —— 用户关掉的服务不会因为插件点名就复活；
 * 3. `transport === 'inmemory'` 的内置服务不给（与聊天链路的 `activeMcpServers` 同一口径）。
 */
function resolvePluginMcpSelection(ids: string[] | undefined): {
  mcpServerIds?: string[]
  mcpServerConfigs?: unknown[]
} {
  if (!Array.isArray(ids) || !ids.length) return {}
  const store = usestore() as any
  const all: any[] = Array.isArray(store?.mcpServers) ? store.mcpServers : []
  const picked = all.filter(
    (s) => s && ids.includes(String(s.id)) && s.enabled !== false && s.transport !== 'inmemory',
  )
  if (!picked.length) return {}
  return { mcpServerIds: picked.map((s) => String(s.id)), mcpServerConfigs: picked }
}

/**
 * 解析一个预设为 `AgentOptions`（找不到返回 null，由适配器抛出可读错误）。
 *
 * `maxSteps` 取**解析后**的有效值（预设没配就用「设置 → 智能体」的通用值）：
 * 这样"预设显式配了很小的步数"会被主进程如实取 min，而用户给自家智能体配的大值
 * 也不会把插件的默认额度撑大（主进程另有自己的默认与上限）。
 *
 * `overrides` 来自插件（见 `PluginAgentOverrides`）：只能改 系统提示词 / 工具 / MCP 服务 id，
 * **改不了模型与密钥** —— provider / config / llmConfig 全部由本函数按用户配置生成。
 */
export function resolvePluginAgentPreset(
  presetId: string,
  overrides: PluginAgentOverrides = {},
): ResolvedAgentPreset | null {
  const store = usestore() as any
  const id = String(presetId ?? '').trim()
  if (!id) return null
  const preset = presetList().find((p) => String(p?.id ?? '') === id)
  if (!preset) return null

  const llm = (store?.AIconfig?.llm || {}) as Record<string, unknown>
  // 预设「跟随默认」时读全局当前来源与模型（换来源 / 换环境无需重配预设）
  const llmType = resolvePresetLlmType(preset, store) || String(llm.type || '') || 'ollama'
  const { type, config } = resolveLlmSource(llm, llmType)
  const model = resolvePresetModel(preset)
  const llmConfig = pickLlmConfig(llm, type)
  if (typeof preset.temperature === 'number') llmConfig.temperature = preset.temperature

  // custom 分支的 config 是 `{ ...llm.custom, ...激活来源 }`，**带着整个 sources 数组**。
  // 主进程不需要它（激活来源的字段已经并进来了），而它正是自引用的高发地带（见 pickLlmConfig 注释）。
  const { sources: _omittedSources, ...configSafe } = (config || {}) as Record<string, unknown>

  const effectiveMaxSteps = resolveAgentMaxSteps(preset.maxSteps, store.generalAgentMaxSteps)

  return {
    id,
    name: String(preset.name ?? '').trim() || id,
    maxSteps: effectiveMaxSteps,
    // 最后再过一道：真折不动就点名，而不是让 Electron 抛"An object could not be cloned."
    options: toIpcSafe(
      {
        // 预设给基线；插件给了 systemPrompt 就覆盖（"预设定义角色，插件定义这次任务"）
        systemPrompt: overrides.systemPrompt ?? String(preset.systemPrompt ?? ''),
        provider: type,
        // 预设自己的模型覆盖来源配置里的默认模型（与 useAgentRun 的聊天级覆盖同一手法）
        // ⚠️ 插件**无法**干预 provider / config.model —— 这两个字段只从上两行来。
        config: { ...configSafe, ...(model ? { model } : {}) },
        llmConfig,
        // 工具：插件给了就**替换**（不是合并）—— "我给了就是我的"，语义可预测；
        // 没给则用预设的。两种情况下主进程都会再按权限裁一次。
        tools: overrides.tools ?? toolsFromCapabilities(preset.capabilities || {}),
        cwd: String(store?.root ?? ''),
        ...resolvePluginMcpSelection(overrides.mcpServerIds),
      },
      `智能体预设「${id}」的 options`,
    ),
  }
}
