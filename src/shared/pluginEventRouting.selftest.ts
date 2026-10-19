/**
 * pluginEventRouting.selftest.ts — 「这条事件该发给哪些插件」的自测
 *
 * 这是**安全判定**：算错一步，某个插件就会读到你在别的会话里的对话内容或工具调用参数。
 * 所以规则要一条条钉住，尤其是"宿主工具 + 宿主会话发起的调用 → 谁也不发"。
 *
 * 用法：`node scripts/run-selftests.mjs pluginEventRouting`
 */

import { agentEventTarget, pluginIdOfScope, toolEventTargets } from './pluginEventRouting'

export interface RoutingCase {
  name: string
  ok: boolean
  detail?: string
}

const PLUGINS = ['plug-a', 'plug-b']
/** 测试用的工具归属表：只有 a_ping 属于 plug-a，b_ping 属于 plug-b */
const ownerOfTool = (name: string) => (name === 'a_ping' ? 'plug-a' : name === 'b_ping' ? 'plug-b' : null)

const targets = (input: Partial<Parameters<typeof toolEventTargets>[0]> = {}) =>
  toolEventTargets({
    type: 'tool/pre-execute',
    ownerOfTool,
    knownPlugins: PLUGINS,
    ...input,
  })

export function runPluginEventRoutingSelfTest(): RoutingCase[] {
  const cases: RoutingCase[] = []

  {
    const got = targets({ name: 'a_ping', callerScope: 'agent' })
    cases.push({
      name: '**自己的工具被宿主智能体调用 → 发给自己**（那是它的工具，它该知道）',
      ok: got.length === 1 && got[0] === 'plug-a',
      detail: JSON.stringify(got),
    })
  }
  {
    const got = targets({ name: 'a_ping', callerScope: 'plugin:plug-a' })
    cases.push({
      name: '自己的工具被自己调用 → 只发一条（去重，不重复通知）',
      ok: got.length === 1 && got[0] === 'plug-a',
      detail: JSON.stringify(got),
    })
  }
  {
    const got = targets({ name: 'b_ping', callerScope: 'plugin:plug-a' })
    cases.push({
      name: '调用了**别人的**工具 → 自己（发起方）与工具主人都收到（各自都该知道）',
      ok: got.length === 2 && got.includes('plug-a') && got.includes('plug-b'),
      detail: JSON.stringify(got),
    })
  }
  {
    const got = targets({ name: 'host_tool', callerScope: 'plugin:plug-a' })
    cases.push({
      name: '自己发起的**宿主工具**调用 → 发给自己（这是它那次 run 的工具调用，要能显示进度）',
      ok: got.length === 1 && got[0] === 'plug-a',
      detail: JSON.stringify(got),
    })
  }
  {
    const got = targets({ name: 'host_tool', callerScope: 'agent' })
    const gotEmpty = targets({ name: 'host_tool' })
    cases.push({
      name: '**宿主工具 + 宿主会话发起的调用 → 谁也不发**（否则插件能窥探你在别的会话里做了什么）',
      ok: got.length === 0 && gotEmpty.length === 0,
      detail: JSON.stringify({ got, gotEmpty }),
    })
  }
  {
    const got = targets({ name: 'ghost_ping', callerScope: 'plugin:ghost' })
    cases.push({
      name: '工具没人认领 + 发起方是**未装载**的插件 → 谁也收不到（防"已卸载但事件还在飞"）',
      ok: got.length === 0,
      detail: JSON.stringify(got),
    })
  }
  {
    const reg = targets({ type: 'tool/registered', name: 'a_ping', scope: 'plugin:plug-a' })
    const unreg = targets({ type: 'tool/unregistered', name: 'a_ping' })
    cases.push({
      name: '注册 / 注销事件：带 scope 的按 scope 发；不带 scope 的按工具归属发',
      ok: reg.length === 1 && reg[0] === 'plug-a' && unreg.length === 1 && unreg[0] === 'plug-a',
      detail: JSON.stringify({ reg, unreg }),
    })
  }
  {
    const cases2 = ['plugin:plug-a', 'plugin:', '', 'agent', 'preset:1', undefined]
    const mapped = cases2.map((s) => pluginIdOfScope(s))
    cases.push({
      name: 'scope 解析：只认 `plugin:<id>`，其余（含空 id）一律空串',
      ok:
        mapped[0] === 'plug-a' && mapped[1] === '' && mapped[2] === '' && mapped[3] === '' &&
        mapped[4] === '' && mapped[5] === '',
      detail: JSON.stringify(mapped),
    })
  }
  {
    const ownerOfAgent = (id: string) => (id === 'a1' ? 'plug-a' : id === 'b1' ? 'plug-b' : null)
    const mine = agentEventTarget({ agentId: 'a1', ownerOfAgent, knownPlugins: PLUGINS })
    const unowned = agentEventTarget({ agentId: 'chat-1', ownerOfAgent, knownPlugins: PLUGINS })
    const gone = agentEventTarget({ agentId: 'b1', ownerOfAgent, knownPlugins: ['plug-a'] })
    const noId = agentEventTarget({ agentId: '', ownerOfAgent, knownPlugins: PLUGINS })
    cases.push({
      name: 'agent 事件归属：**按创建点登记的归属**发给那一个插件；宿主会话的 agent / 已卸载的插件 / 空 id → 不发',
      ok: mine === 'plug-a' && unowned === null && gone === null && noId === null,
      detail: JSON.stringify({ mine, unowned, gone, noId }),
    })
  }

  return cases
}

/** 命令行入口 */
export function logPluginEventRoutingSelfTest(): boolean {
  const cases = runPluginEventRoutingSelfTest()
  for (const c of cases) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`)
    if (c.detail) console.log(`      ${c.detail}`)
  }
  return cases.every((c) => c.ok)
}
