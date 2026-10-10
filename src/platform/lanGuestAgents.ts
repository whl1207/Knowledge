/**
 * lanGuestAgents.ts — 主机侧「访客可用智能体」档案组装（渲染层）
 *
 * 网页端的智能体模式由**主机主进程**执行，但「Agent 预设」的定义、提示词组装、
 * 技能库与 MCP 清单都只存在于渲染层（localStorage / 内存）。因此这里在主机渲染层把
 * 允许的智能体预先组装成 AgentOptions 形状的纯 JSON 档案，随权限策略一起下发给主进程：
 *
 *   CollabSettings → buildGuestAgentProfiles() → lan:setGuest → electron/main/lan-guest.ts
 *
 * 关键原则（访客侧行为必须与客户端完全一致）：
 * - 系统提示词**就是客户端同一套组装结果**（`assembleAgentSystemPrompt`，与首页
 *   「通用智能体」与「Agent 预设」两个分支同源）；主进程不再另行拼接访客前言，
 *   否则人格 / 工作方式会与客户端不同；
 * - 下发给访客的**工具** = 客户端工具集 ∩ 访客白名单（先取交集再组装提示词，
 *   使提示词里列出的工具就是访客真正能调的）；
 * - 主进程仍会在最后再取一次交集（防御纵深），并强制覆盖沙箱 / 工作区围栏 / 步数上限。
 */

import { toolsFromCapabilities } from '@/lib/agent/capabilities'
import {
  assembleAgentSystemPrompt,
  buildMcpServersContext,
  ensureAgentSkills,
} from '@/lib/agent/promptContext'
import { SKILL_AGENT_DEFAULT_TOOLS } from '@/lib/agent/skill'
import { LAN_GUEST_GENERAL_AGENT, type LanGuestAgentProfile } from '@/shared/lanGuest'

/** 预设 → 访客档案需要的字段（provider/config/cwd/sandbox 由主进程按策略覆盖） */
export interface GuestAgentProfileDeps {
  /** 技能管理器（技能勾选解析；与首页智能体共用同一份） */
  skillManager?: {
    getSkills(): Array<{ name?: string; description?: string; path?: string; body?: string; content?: string }>
    getSkill(name: string): { name?: string; description?: string; path?: string; body?: string; content?: string } | undefined
  }
  /** 访客工具白名单（策略 tools；用于先取交集再组装提示词，缺省不裁剪） */
  guestTools?: string[] | null
}

/** 纯 JSON 净化：payload 会经 ipcRenderer.invoke 下发（含 store 响应式对象，直接传会抛
 *  “An object could not be cloned.”） */
function purge(list: LanGuestAgentProfile[]): LanGuestAgentProfile[] {
  try {
    return JSON.parse(JSON.stringify(list))
  } catch {
    return list
  }
}

/**
 * 组装下发给访客的智能体档案（首位固定为「通用智能体」，与客户端行为一致）。
 * @param store      Pinia store（读取预设、MCP、技能目录、全局工具白名单等）
 * @param presetIds  允许的预设 id（来自访客策略 presetIds；空数组 = 只下发通用智能体）
 * @param deps       技能管理器 + 访客工具白名单
 */
export async function buildGuestAgentProfiles(
  store: any,
  presetIds: string[],
  deps: GuestAgentProfileDeps = {},
): Promise<LanGuestAgentProfile[]> {
  const out: LanGuestAgentProfile[] = []
  // 访客工具白名单（策略集）：先裁剪再组装，保证提示词里的工具清单 = 访客真实可用工具
  const allowedSet = Array.isArray(deps.guestTools) && deps.guestTools.length
    ? new Set(deps.guestTools.map(String))
    : null
  const clip = (list: readonly string[]): string[] =>
    allowedSet ? list.filter((t) => allowedSet.has(String(t))) : [...list]

  let enabledSkills: any[] = []
  try {
    enabledSkills = await ensureAgentSkills(store)
  } catch (e) {
    console.warn('[lan-guest] 技能库加载失败（提示词将不含技能清单）:', e)
  }
  const activeMcpServers = (store?.mcpServers || []).filter((s: any) => s && s.enabled !== false && s.transport !== 'inmemory')
  const skillManager = deps.skillManager

  // ---------------- ① 通用智能体（与首页 handleAgentLoopMode 的自主规划分支同源） ----------------
  try {
    const desktopTools = store?.agentTools === null ? [...SKILL_AGENT_DEFAULT_TOOLS] : [...(store?.agentTools || [])]
    const tools = clip(desktopTools)
    const mcpCtx = (tools.includes('mcp_call') && activeMcpServers.length > 0)
      ? await buildMcpServersContext(activeMcpServers, store?.locales)
      : ''
    const assembled = assembleAgentSystemPrompt({ store, tools, enabledSkills, mcpContext: mcpCtx })
    out.push({
      id: LAN_GUEST_GENERAL_AGENT,
      name: '通用智能体',
      desc: '与客户端「通用智能体」同一提示词与工具集（按访客白名单裁剪）',
      options: {
        systemPrompt: assembled.systemPrompt,
        tools: clip(assembled.tools),
        kbPaths: [],
        mcpServerIds: activeMcpServers.map((s: any) => s.id),
        mcpServerConfigs: activeMcpServers,
        label: '通用智能体',
      },
    })
  } catch (e) {
    console.warn('[lan-guest] 组装「通用智能体」档案失败:', e)
  }

  // ---------------- ② 允许的预设 ----------------
  const ids = Array.isArray(presetIds) ? presetIds.filter((x) => typeof x === 'string' && x) : []
  if (!ids.length) return purge(out)
  const presets: any[] = Array.isArray(store?.agentPresets) ? store.agentPresets : []
  for (const id of ids) {
    const preset = presets.find((p) => p && p.id === id)
    if (!preset) continue
    try {
      const tools = clip(toolsFromCapabilities(preset.capabilities || {}))
      // MCP：预设启用了 MCP 且选了服务时才注入服务/工具说明（含 serverId）
      const mcpIds: string[] = preset.capabilities?.mcpServerIds
        || (preset.capabilities?.mcpServerId ? [preset.capabilities.mcpServerId] : [])
      const mcpServers = (store?.mcpServers || []).filter((s: any) => s && mcpIds.includes(s.id))
      const mcpCtx = (preset.capabilities?.mcpAccess && mcpServers.length)
        ? await buildMcpServersContext(mcpServers, store?.locales)
        : ''
      const assembled = assembleAgentSystemPrompt({
        store,
        preset,
        tools,
        enabledSkills,
        resolveSkill: (key: string) => {
          const s: any = skillManager?.getSkills?.().find((x) => x.path === key)
            ?? skillManager?.getSkill?.(key)
          return s
            ? { name: String(s.name || key), description: s.description, path: s.path, body: s.body, content: s.content }
            : null
        },
        disabledSkills: store?.disabledSkills || [],
        mcpContext: mcpCtx,
      })
      const firstLine = String(preset.systemPrompt || '').split(/\r?\n/).map((s: string) => s.trim()).find((s: string) => s) || ''
      const desc = [Array.isArray(preset.tags) ? preset.tags.join(' · ') : '', firstLine]
        .filter(Boolean).join(' — ').slice(0, 160)
      out.push({
        id: preset.id,
        name: String(preset.name || preset.id),
        desc,
        options: {
          systemPrompt: assembled.systemPrompt,
          tools: clip(assembled.tools),
          kbPaths: Array.isArray(preset.capabilities?.knowledgeBaseFiles) ? preset.capabilities.knowledgeBaseFiles : [],
          kbTopK: typeof preset.kbTopK === 'number' ? preset.kbTopK : 5,
          mcpServerIds: mcpIds,
          mcpServerConfigs: mcpServers,
          mcpEquipmentIds: preset.capabilities?.mcpEquipmentIds || undefined,
          maxSteps: typeof preset.maxSteps === 'number' ? preset.maxSteps : undefined,
          label: String(preset.name || preset.id),
        },
      })
    } catch (e) {
      console.warn(`[lan-guest] 组装访客智能体档案失败（预设 ${id}）:`, e)
    }
  }
  return purge(out)
}
