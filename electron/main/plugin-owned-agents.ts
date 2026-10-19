/**
 * plugin-owned-agents.ts — 「这个 agent 是哪个插件委派出去的」这张表
 *
 * ## 为什么需要它
 *
 * DSH 让"agent 作用域的监听器只收到那个 agent"的事件，靠的是 Cordis 的 `Scoped<Agent>` 与
 * isolate（见 `dsh-agent` 事件目录里那句 *"Scope-filtered dispatch: agent-scoped listeners
 * receive only that agent"*）。AI-KM 是单进程、单事件总线、没有 isolate，所以只能**显式记一张表**，
 * 才能把 `assistant/chunk` / `tool/result` 这类事件只发给拥有那个 run 的插件。
 *
 * ## 为什么按创建点维护，而不是扫描 `label`
 *
 * `label` 是可以被调用方覆盖的（`options.label`），扫描不可靠；而 agent 的创建与销毁点只有一个
 * （`agent-loop.runDelegatedAgent` 的 try/finally），在那里登记/注销是权威且 O(1) 的。
 *
 * 本模块**不依赖任何其它模块**（避免把 plugin-host ↔ agent-loop 连成环）。
 */

/** agentId → pluginId */
const owned = new Map<string, string>()

/** 登记：某插件的委派 run 创建了一个 agent */
export function registerOwnedAgent(agentId: string, pluginId: string): void {
  const a = String(agentId || '').trim()
  const p = String(pluginId || '').trim()
  if (!a || !p) return
  owned.set(a, p)
}

/** 注销：那个 run 结束（成功 / 失败 / 取消 / 超时都要走到） */
export function unregisterOwnedAgent(agentId: string): void {
  owned.delete(String(agentId || '').trim())
}

/** 该 agent 属于哪个插件（没登记 → null，表示"不是插件委派的 run"） */
export function ownerOfAgent(agentId: string): string | null {
  const a = String(agentId || '').trim()
  if (!a) return null
  return owned.get(a) ?? null
}

/** 当前在跑的委派 run 数（审计 / 测试用） */
export function ownedAgentCount(): number {
  return owned.size
}
