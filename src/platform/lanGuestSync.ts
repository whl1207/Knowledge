/**
 * lanGuestSync.ts — 把「访客权限策略 + 主机模型 + 可用智能体档案」下发给主进程（单一入口）
 *
 * 为什么必须唯一入口：主进程的访客智能体清单**完全来自这条下发**。任何一个下发点漏带
 * `agents`，主机的清单就会被清空（现象：网页端刷新后只剩「通用智能体」）。
 * 因此所有下发点（App.vue 启动同步、设置页「协作 → 权限」改动、主进程主动来拉）都调这里。
 */

import { buildLanEmbedPayload, buildLanLlmPayload, buildLanModelSourcesPayload } from '@/platform/lanKb'
import { buildGuestAgentProfiles } from '@/platform/lanGuestAgents'
import { getSkillManager } from '@/services/agentSkills'
import { defaultLanGuestPolicy, effectiveGuestTools } from '@/shared/lanGuest'
import { getPlatform, hasCapability } from '@/platform'

/** 下发一次完整策略（无宿主能力的环境直接返回 false，不抛错） */
export async function pushLanGuestPolicy(store: any): Promise<boolean> {
  if (typeof window === 'undefined') return false
  if (!hasCapability('host.lanShare')) return false
  const guest = store?.lan?.guest || defaultLanGuestPolicy()
  // 共享目录（知识库 / 访客智能体的文件围栏根）与主机嵌入配置一并同步
  try {
    await getPlatform().host.lan.setKbDir(store?.lan?.kbDir || '')
    await getPlatform().host.lan.setEmbed(JSON.parse(JSON.stringify(buildLanEmbedPayload(store))))
  } catch (e) {
    console.warn('[lan-guest] 同步共享目录 / 嵌入配置失败:', e)
  }
  // payload 必须整体 JSON 净化：policy/llm/agents 都含 store 响应式对象，
  // 直接 invoke 会抛 “An object could not be cloned.”
  const payload = JSON.parse(JSON.stringify({
    policy: guest,
    llm: buildLanLlmPayload(store, guest),
    // 主机可用的模型来源（网页端据此对齐来源开关 / 地址 / 模型；见 buildLanModelSourcesPayload）
    modelSources: buildLanModelSourcesPayload(store),
    // 可用智能体档案（预设提示词/工具/知识库/MCP 只有渲染层拿得到）
    agents: await buildGuestAgentProfiles(store, guest.presetIds || [], {
      skillManager: getSkillManager(store),
      guestTools: effectiveGuestTools(guest),
    }),
  }))
  await getPlatform().host.lan.setGuest(payload)
  return true
}
