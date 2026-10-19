/**
 * toolRegistryView.ts — 「设置 → 工具 → 注册表」的**查看作用域**与**启用判定**（纯逻辑）
 *
 * 为什么抽出这一层：注册表面板原先只有一种口径 —— 按「设置 → 工具管理」的**全局白名单**判
 * 「已禁用」。但真正决定模型能用什么的是**每个入口各自的白名单**：
 *   - 通用智能体 / 技能触发 / 批量：`store.agentTools`（未配置回退 `SKILL_AGENT_DEFAULT_TOOLS`）；
 *   - Agent 预设：预设自己的能力槽（`toolsFromCapabilities`）；
 *   - 工作流节点 / 集群 / 子代理：各自的作用域与白名单；
 *   - 局域网访客：主机白名单 ∩ 访客权限白名单。
 * 于是同一条工具在不同入口下的状态不同，而面板只有一个口径时**只能表达「全局默认」**，
 * 用户看到「已禁用」就以为工具不可用（实测反馈）。
 *
 * 现在面板多了一个下拉，四种口径都收敛到这里（组件只做渲染与取数）：
 *   - `none`   → 返回 `null`：**不判状态**（默认；只看注册表事实：名字 / schema / 作用域）；
 *   - `global` → 「设置 → 工具管理」的全局白名单（与 Agent 循环同源）；
 *   - `preset` → 该预设能力槽产出的工具（与预设运行时同源）；
 *   - `agent`  → 主进程 `agent:tools` 返回的**该会话实际下发清单**（已解析 scope 与跨层插件工具）。
 *
 * 判定一律按**工具名**（注册表快照本身按名去重，同名跨层只保留先出现的那层）。
 *
 * 用法：`node scripts/run-selftests.mjs toolRegistryView`
 */

import { toolsFromCapabilities } from './capabilities'

// ---------------------------------------------------------------------------
// 作用域：select 的值 ↔ 结构化作用域
// ---------------------------------------------------------------------------

export type RegistryScopeKind = 'none' | 'global' | 'preset' | 'agent'

export interface RegistryScope {
  kind: RegistryScopeKind
  /** `preset` / `agent` 的目标 id；`none` / `global` 为空串 */
  id: string
  /** 原始 select 值：`''` | `'global'` | `preset:<id>` | `agent:<id>` */
  value: string
}

/** 默认作用域（不显示启用状态） */
export const REGISTRY_SCOPE_NONE = ''
/** 全局口径（「设置 → 工具管理」的白名单） */
export const REGISTRY_SCOPE_GLOBAL = 'global'

/** 结构化作用域 → select 值 */
export function scopeValueOf(kind: RegistryScopeKind, id = ''): string {
  if (kind === 'global') return REGISTRY_SCOPE_GLOBAL
  if (kind === 'agent' && id) return `agent:${id}`
  if (kind === 'preset' && id) return `preset:${id}`
  return REGISTRY_SCOPE_NONE
}

/**
 * select 值 → 结构化作用域。**容错**：空值 / 未知前缀 / 缺 id（如 `agent:`）一律回落到
 * `none` —— 宁可退回"不判状态"，也不要拿一个空名单把整页工具标成未启用。
 */
export function parseRegistryScope(value: unknown): RegistryScope {
  const v = String(value ?? '').trim()
  if (v === REGISTRY_SCOPE_GLOBAL) return { kind: 'global', id: '', value: REGISTRY_SCOPE_GLOBAL }
  const m = /^(preset|agent):(.+)$/.exec(v)
  if (m) {
    const kind = m[1] as 'preset' | 'agent'
    const id = m[2]
    return { kind, id, value: `${kind}:${id}` }
  }
  return { kind: 'none', id: '', value: REGISTRY_SCOPE_NONE }
}

/** 选中的目标是否还在（预设被删 / 会话已结束 → 面板据此回落，避免停在一个永远空的名单上） */
export function scopeTargetAlive(
  scope: RegistryScope,
  targets: { presets?: ReadonlyArray<{ id: string }>; agents?: ReadonlyArray<{ id: string }> },
): boolean {
  if (scope.kind === 'none' || scope.kind === 'global') return true
  const list = scope.kind === 'preset' ? targets.presets : targets.agents
  return !!list && list.some((t) => String(t.id) === scope.id)
}

// ---------------------------------------------------------------------------
// select 选项（分组：全局 / 智能体预设 / 运行中的会话）
// ---------------------------------------------------------------------------

export interface ScopePresetInput { id: string; name?: string }
export interface ScopeAgentInput { id: string; label?: string; status?: string }

export interface RegistryScopeOption { value: string; label: string }
export interface RegistryScopeGroups { preset: RegistryScopeOption[]; agent: RegistryScopeOption[] }

/** 会话状态文案（与 AgentStatus 对齐；未知值原样回显，不隐藏信息） */
export function agentStatusText(status: unknown, zh: boolean): string {
  switch (String(status ?? '')) {
    case 'running': return zh ? '运行中' : 'running'
    case 'idle': return zh ? '空闲' : 'idle'
    case 'stopping': return zh ? '停止中' : 'stopping'
    case 'disposed': return zh ? '已结束' : 'ended'
    default: return String(status ?? '')
  }
}

/**
 * 会话可读名：主进程里 label 是「入口 + 标识」（`agent-loop` / `skill:x` / `preset:x`…），
 * 直接铺在 select 里看不出是什么入口，这里翻译成人话并附短 id（同名多个会话能区分开）。
 */
export function agentLabel(agent: ScopeAgentInput, zh: boolean): string {
  const raw = String(agent.label ?? '').trim()
  const shortId = String(agent.id ?? '').slice(0, 8)
  const cut = (s: string) => (s.length > 22 ? s.slice(0, 21) + '…' : s)
  const [head, ...rest] = raw.split(':')
  const tail = rest.join(':')
  const named = (zhText: string, enText: string, name: string) =>
    `${cut(zh ? zhText : enText)}${name ? ' ' + cut(name) : ''}`
  switch (head) {
    case 'agent-loop': return named('通用智能体', 'General agent', '')
    case 'lan-guest': return named('局域网访客', 'LAN guest', '')
    case 'skill': return named('技能', 'Skill', tail)
    case 'swarm': return named('集群', 'Swarm', tail)
    case 'workflow': return named('工作流', 'Workflow', tail)
    case 'batch': return named('批量', 'Batch', tail)
    case 'subagent': return named('子代理', 'Subagent', tail)
    default: {
      if (!raw) return `${zh ? '会话' : 'Session'} ${shortId}`
      return cut(raw)
    }
  }
}

/**
 * 下拉选项：预设全量列出（含未使用的），会话按当前活跃列表列出。
 * 同名预设 / 同入口多会话都能共存，因为 value 带 id。
 */
export function registryScopeOptions(input: {
  presets?: ReadonlyArray<ScopePresetInput>
  agents?: ReadonlyArray<ScopeAgentInput>
  zh: boolean
}): RegistryScopeGroups {
  const zh = !!input.zh
  const preset = (input.presets || [])
    .filter((p) => !!p && !!p.id)
    .map((p) => ({
      value: scopeValueOf('preset', String(p.id)),
      label: String(p.name || p.id),
    }))
  const agent = (input.agents || [])
    .filter((a) => !!a && !!a.id && String(a.status ?? '') !== 'disposed')
    .map((a) => ({
      value: scopeValueOf('agent', String(a.id)),
      label: `${agentLabel(a, zh)}${a.status ? ` · ${agentStatusText(a.status, zh)}` : ''}`,
    }))
  return { preset, agent }
}

// ---------------------------------------------------------------------------
// 启用集：三种口径
// ---------------------------------------------------------------------------

/**
 * 全局口径（与 Agent 循环运行时同源，见 `useAgentRun` 的组装）：
 *   - `store.agentTools` 是数组 → **原样**就是白名单（不再按静态表过滤：数组里的
 *     `browser_*` 这类不在静态表里的工具，运行时确实可用，过滤掉会显示成"未启用"）；
 *   - 未配置（null / undefined / 脏值）→ 回退 `globalDefaultTools`（`SKILL_AGENT_DEFAULT_TOOLS`）。
 * 末尾合并 `alwaysOn`（`AGENT_TOOL_REGISTRY` 里恒开的引擎工具；当前为空集）。
 */
export function globalEnabledNames(
  stored: unknown,
  opts: { defaultTools?: readonly string[]; alwaysOn?: readonly string[] } = {},
): Set<string> {
  const base = Array.isArray(stored)
    ? stored.filter((n): n is string => typeof n === 'string')
    : Array.from(opts.defaultTools || [])
  const set = new Set<string>(base)
  for (const n of opts.alwaysOn || []) set.add(String(n))
  return set
}

/** 预设口径：能力槽 → 工具名（逐工具模式 `enabledTools` 优先；含插件工具"仍存在"净化） */
export function presetEnabledNames(capabilities: unknown): Set<string> {
  return new Set<string>(toolsFromCapabilities(capabilities as any))
}

/** 会话口径：主进程 `agent:tools` 返回的该会话实际下发清单（未取到 → null = 不判状态） */
export function agentEnabledNames(names: readonly string[] | null | undefined): Set<string> | null {
  if (!Array.isArray(names)) return null
  return new Set<string>(names.map((n) => String(n)))
}

export interface EnabledNamesInput {
  scope: RegistryScope
  /** 全局口径：`store.agentTools` */
  globalStored?: unknown
  /** 全局口径的回退默认集（`SKILL_AGENT_DEFAULT_TOOLS`） */
  globalDefaultTools?: readonly string[]
  /** 全局口径恒开的工具（`AGENT_TOOL_REGISTRY.filter(t => t.alwaysOn)`） */
  globalAlwaysOn?: readonly string[]
  /** 预设表（按 id 找 capabilities） */
  presets?: ReadonlyArray<{ id: string; capabilities?: unknown }>
  /** 会话口径：`agent:tools` 的返回；`null` / `undefined` = 还没取到 */
  agentToolNames?: readonly string[] | null
}

/**
 * 作用域 → 启用集。**`null` = 不显示启用状态**（默认口径、目标已消失、会话清单还没取到）。
 *
 * ⚠️ 目标不存在时也返回 `null` 而不是空集：空集会把整页工具标成"未启用"，
 * 那是"名单缺失"被当成"全部关闭"——最坏的一种撒谎方式。
 */
export function enabledNamesForScope(input: EnabledNamesInput): Set<string> | null {
  switch (input.scope.kind) {
    case 'none':
      return null
    case 'global':
      return globalEnabledNames(input.globalStored, {
        defaultTools: input.globalDefaultTools,
        alwaysOn: input.globalAlwaysOn,
      })
    case 'preset': {
      const preset = (input.presets || []).find((p) => String(p.id) === input.scope.id)
      return preset ? presetEnabledNames(preset.capabilities) : null
    }
    case 'agent':
      return agentEnabledNames(input.agentToolNames)
    default:
      return null
  }
}

/** 注册表里有、但不在启用集里的名字（不判状态时为空集） */
export function disabledNamesOf(
  registered: readonly string[],
  enabled: ReadonlySet<string> | null,
): Set<string> {
  if (!enabled) return new Set<string>()
  return new Set(registered.filter((n) => !enabled.has(String(n))))
}

/**
 * 启用集里有、但注册表里没有的名字 —— 诊断用（插件被停用 / 卸载，或该工具在渲染层实现）。
 * 只在预设口径下有意义（会话口径的清单本来就来自注册表）。
 */
export function missingNamesOf(
  enabled: ReadonlySet<string> | null,
  registered: readonly string[],
): string[] {
  if (!enabled) return []
  const have = new Set(registered.map((n) => String(n)))
  return Array.from(enabled).filter((n) => !have.has(n)).sort()
}
