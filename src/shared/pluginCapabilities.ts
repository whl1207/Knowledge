/**
 * pluginCapabilities.ts — 插件能力的**单一事实源**（能力名 / ctx 成员 / 权限 / 半边 / 错误码前缀）
 *
 * 为什么要这张表：改造前同一件事被抄了四遍——`inject` 校验、`available` 判定、`devGuide` 事实表、
 * 成员表自测。四份各写一遍的直接后果是漂移（`pluginApiMembers.ts` 头部注释记录的那次事故：
 * 文档说 `ctx.shell`、真实 API 是 `ctx.host.runShell`）。
 *
 * 现在：新表驱动上面四件事；`pluginCapabilities.selftest.ts` 断言"表里的每个能力都在成员表里、
 * 都有错误码前缀、都被文档提到"，加一个能力却漏了某处 → 测试变红。
 *
 * 设计见 `docs/plan/插件能力面向DSH风格收敛-设计方案（逐文件）.md` §三 C1。
 */

import type { PluginPermission } from '@/types/plugin'

export type PluginCapabilityName = 'fs' | 'llm' | 'agents' | 'image'
export type PluginHalf = 'main' | 'client'
export type PluginErrorPrefix = 'FS' | 'LLM' | 'AGENT' | 'IMAGE'

export interface PluginCapabilityDef {
  /** `ctx` 上的成员名（与 `inject` 的服务名一致：一个能力一个名字，不再两套） */
  readonly ctxMember: PluginCapabilityName
  /** 宿主服务名（`inject: ['fs']` 等；与 ctxMember 相同是刻意的） */
  readonly service: string
  /** 需要清单声明哪个权限 */
  readonly permission: PluginPermission
  /** 哪半边提供 */
  readonly halves: readonly PluginHalf[]
  /** 是否产出流（`AsyncIterable` + 终止帧） */
  readonly streaming: boolean
  /** 错误码前缀（`FS_*` / `LLM_*` / `AGENT_*`） */
  readonly errorPrefix: PluginErrorPrefix
  /** 一句话说明（文档与诊断复用） */
  readonly summary: string
}

export const PLUGIN_CAPABILITIES: Readonly<Record<PluginCapabilityName, PluginCapabilityDef>> = {
  fs: {
    ctxMember: 'fs',
    service: 'fs',
    permission: 'fs',
    halves: ['main', 'client'],
    streaming: false,
    errorPrefix: 'FS',
    summary: '文件读写：目标身份 / 版本 / 字面量编辑 / 目录 / 表格（插件自己的目录 + 用户授权过的路径）',
  },
  llm: {
    ctxMember: 'llm',
    service: 'llm',
    permission: 'llm',
    halves: ['client'],
    streaming: true,
    errorPrefix: 'LLM',
    summary: '调用用户已配置的模型：一次对话 / 模型清单（密钥与来源连接由用户配置，插件拿不到）',
  },
  agents: {
    ctxMember: 'agents',
    service: 'agents',
    permission: 'agent.run',
    halves: ['client'],
    streaming: true,
    errorPrefix: 'AGENT',
    summary: '委派一个独立会话的智能体：句柄 / 终态流 / 预算（模型由用户预设决定，插件不可选）',
  },
  image: {
    ctxMember: 'image',
    service: 'image',
    permission: 'image',
    halves: ['client'],
    streaming: false,
    errorPrefix: 'IMAGE',
    summary: '生图：文生图 / 参考图生图（服务地址与 token 由用户配置，插件拿不到，也决定不了用哪个服务）',
  },
}

export const PLUGIN_CAPABILITY_NAMES: readonly PluginCapabilityName[] = Object.keys(PLUGIN_CAPABILITIES) as PluginCapabilityName[]

export function pluginCapability(name: unknown): PluginCapabilityDef | undefined {
  return PLUGIN_CAPABILITY_NAMES.includes(name as PluginCapabilityName)
    ? PLUGIN_CAPABILITIES[name as PluginCapabilityName]
    : undefined
}

/** 某能力要求的权限（未知名 → null） */
export function capabilityPermission(name: unknown): PluginPermission | null {
  return pluginCapability(name)?.permission ?? null
}

/** 某半边可用的能力（装载时据此判断 inject 是否可能就绪） */
export function capabilitiesForHalf(half: PluginHalf): PluginCapabilityDef[] {
  return PLUGIN_CAPABILITY_NAMES.map((n) => PLUGIN_CAPABILITIES[n]).filter((def) => def.halves.includes(half))
}

/** 某能力是否由该半边提供 */
export function capabilityOnHalf(name: unknown, half: PluginHalf): boolean {
  const def = pluginCapability(name)
  return !!def && def.halves.includes(half)
}

/** 某错误码属于哪个能力（按前缀；未知名 → null）。用于诊断与文档归组。 */
export function capabilityOfErrorCode(code: unknown): PluginCapabilityName | null {
  const text = String(code ?? '')
  for (const name of PLUGIN_CAPABILITY_NAMES) {
    if (text.startsWith(`${PLUGIN_CAPABILITIES[name].errorPrefix}_`)) return name
  }
  return null
}
