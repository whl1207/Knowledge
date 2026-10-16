/**
 * toolWhitelist.ts — 全局工具白名单（「设置 → 工具 → 管理」）的**纯逻辑**
 *
 * 为什么抽出来：这段逻辑以前内联在 `ToolSettings.vue` 里，只认静态表 `AGENT_TOOL_REGISTRY`。
 * 于是插件工具**既不显示、还会被当成非法名过滤掉** —— 在方案 B（插件工具显式勾选才生效）下，
 * 没有选任何预设的**通用智能体**就永远用不上插件工具，而用户在这个界面里也看不到任何线索。
 *
 * 抽成纯函数之后：组件只负责渲染与写 store，规则本身可被自测直接覆盖
 * （见 `src/lib/agent/toolWhitelist.selftest.ts`）。
 */

import { AGENT_TOOL_REGISTRY, type AgentToolInfo } from '@/services/agentSkills'
import { getPluginToolNames } from '@/lib/agent/capabilities'
import { pluginDisplayName, pluginToolScopes } from '@/lib/plugin/runtime'

/** 工具行：静态注册表项，或插件提供的工具（后者带来源标签） */
export type WhitelistToolRow = AgentToolInfo & { srcKind?: 'plugin'; srcLabel?: string }

/** `plugin:math-proof-graph` → `math-proof-graph`；非插件 scope 返回空串 */
export function pluginNameOfScope(scope: unknown): string {
  const s = String(scope || '')
  return s.startsWith('plugin:') ? (s.slice('plugin:'.length).split('/')[0] || '') : ''
}

/** 插件工具行（名字与来源来自渲染层同步的名单；插件工具没有静态展示元数据） */
export function pluginToolRows(
  names: readonly string[],
  scopes: Record<string, string>,
): WhitelistToolRow[] {
  return names.map((name) => {
    const pid = pluginNameOfScope(scopes[name])
    return {
      // 插件工具没有静态元数据：标签留空，界面直接显示工具名本身
      name: String(name),
      labelZh: '',
      labelEn: '',
      icon: 'fa-puzzle-piece',
      description: '',
      sandboxPreference: 'none',
      approvalRequirement: 'on-request',
      defaultEnabled: false,
      srcKind: 'plugin' as const,
      srcLabel: pluginDisplayName(pid),
    }
  })
}

/** 内置行 + 插件行的合并列表（界面按这个渲染，启用判定也按它） */
export function whitelistToolRows(): WhitelistToolRow[] {
  return [
    ...(AGENT_TOOL_REGISTRY as WhitelistToolRow[]),
    ...pluginToolRows(getPluginToolNames(), pluginToolScopes.value),
  ]
}

/**
 * 由 `store.agentTools` 计算当前启用集。
 *
 * - `null` / 非数组 = **未配置**：内置按 `defaultEnabled`，**插件工具默认关闭**
 *   （方案 B：插件工具必须显式勾选才生效）；
 * - 数组 = 显式白名单：只保留其中**仍然存在**的工具名（含插件工具），并合并 `alwaysOn`。
 *
 * ⚠️ 关键点：合法性判定必须拿"内置 + 插件"的合并列表。以前只拿内置表判，
 * 插件工具会被静默丢掉 —— 用户勾了、重启后就没了。
 */
export function computeEnabledTools(
  stored: unknown,
  rows: readonly WhitelistToolRow[] = whitelistToolRows(),
): Set<string> {
  if (!Array.isArray(stored)) {
    return new Set(rows.filter((t) => !t.srcKind && (t.defaultEnabled || t.alwaysOn)).map((t) => t.name))
  }
  const valid = (stored as unknown[]).filter((n): n is string => typeof n === 'string').filter((n) => rows.some((t) => t.name === n))
  const alwaysOn = rows.filter((t) => t.alwaysOn).map((t) => t.name)
  return new Set([...valid, ...alwaysOn])
}

/**
 * 由启用集算出要落盘的工具名列表。
 *
 * `alwaysOn` 不落盘（运行时恒包含）；插件工具**要落盘**，否则重启即丢。
 */
export function persistableToolNames(
  enabled: ReadonlySet<string>,
  rows: readonly WhitelistToolRow[] = whitelistToolRows(),
): string[] {
  return rows.filter((t) => !t.alwaysOn && enabled.has(t.name)).map((t) => t.name)
}
