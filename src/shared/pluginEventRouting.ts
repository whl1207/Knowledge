/**
 * pluginEventRouting.ts — 插件观测面的**作用域判定**（纯函数）
 *
 * ## 为什么需要它
 *
 * DSH 的 `agent/*` / `tools/*` 事件天然带着作用域：Cordis 的 `Scoped<Agent>` + isolate 让
 * *"agent-scoped listeners receive only that agent"*。AI-KM 是**单进程、单事件总线、没有 isolate**，
 * 所以"这条事件该发给哪些插件"必须自己算 —— 而且这是**安全判定**：算错一步，
 * 某个插件就会读到你**在别的会话里**的对话内容（`assistant/chunk`）或工具调用参数。
 *
 * 判定规则（收得比 DSH 紧，因为 AI-KM 的插件不受信任）：
 * - **自己的工具**：不管谁调用（宿主智能体、别的插件、它自己），它都该知道 —— 那是它的工具；
 * - **自己发起的调用**：调用方 scope 是 `plugin:<自己>`（它委派出去的 run 用的就是这个 scope）；
 * - **其它一切**（宿主工具 + 宿主会话发起的调用）**不发**给任何插件。
 *
 * 与宿主生命周期事件（`plugin/loaded` 这类）不同：那些对所有插件广播，不经过这里。
 */

export interface ToolEventRoutingInput {
  /** 工具事件名（`tool/pre-execute` 等） */
  type: string
  /** 事件里的工具名 */
  name?: string
  /** `tool/registered|unregistered` 带的是**被注册的** scope；调用类事件没有这个字段 */
  scope?: string
  /** `tool/pre-execute|post-execute` 里 `ctx.scope`：**调用方**作用域 */
  callerScope?: string
  /** 工具名 → 拥有它的插件 id（宿主侧用插件记录的 tools 名单查表） */
  ownerOfTool: (toolName: string) => string | null
  /** 当前已装载的插件 id 集合（过滤掉"已卸载但事件还在飞"的情况） */
  knownPlugins: readonly string[]
}

/** `plugin:<id>` → `<id>`；其它作用域（`agent`、空、自定义）→ 空串 */
export function pluginIdOfScope(scope: unknown): string {
  const s = String(scope ?? '')
  return s.startsWith('plugin:') ? s.slice('plugin:'.length) : ''
}

/**
 * 这条工具事件该发给哪些插件（去重后的 id 列表；空数组 = 谁也不发）。
 *
 * 纯函数：所有外部事实（工具归属、已装插件）都由调用方注入，所以它能被自测钉住。
 */
export function toolEventTargets(input: ToolEventRoutingInput): string[] {
  const known = new Set(input.knownPlugins)
  const targets = new Set<string>()
  const owner = input.ownerOfTool(String(input.name ?? ''))
  if (owner && known.has(owner)) targets.add(owner)
  const byScope = pluginIdOfScope(input.scope ?? input.callerScope)
  if (byScope && known.has(byScope)) targets.add(byScope)
  return Array.from(targets)
}

/**
 * 这条 agent 事件该发给哪个插件（`null` = 不是插件委派的 run，谁也不发）。
 *
 * 归属来自"创建点登记"（`agent-loop.runDelegatedAgent` 的 register/unregister），
 * **不是**扫 `label` —— label 可以被调用方覆盖，扫出来的结论不可靠。
 */
export function agentEventTarget(input: {
  agentId?: string
  ownerOfAgent: (agentId: string) => string | null
  knownPlugins: readonly string[]
}): string | null {
  const id = String(input.agentId ?? '').trim()
  if (!id) return null
  const owner = input.ownerOfAgent(id)
  if (!owner) return null
  return input.knownPlugins.includes(owner) ? owner : null
}
