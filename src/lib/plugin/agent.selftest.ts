/**
 * agent.selftest.ts — `ctx.agent` 适配器（界面半边插件真正面对的那一层）的自测
 *
 * 为什么需要：`plugin-smoke` 验的是 **IPC 通道**（主进程侧），`agentContract.selftest` 验的是
 * **契约层纯逻辑**；而插件代码调用的是 `createPluginAgentApi` 返回的对象 ——
 * 这层此前没有任何测试，正是"看起来都测了、其实最关键的一层没测"的典型。
 *
 * 它是 DI 纯函数（桥 / 预设解析器都是注入的），所以这里不需要 DOM、不需要 IPC、不需要模型。
 *
 * 用法：`node scripts/run-selftests.mjs pluginAgentApi`
 */

import { createPluginAgentApi, splitAgentRunOptions, type PluginAgentApiDeps, type PluginAgentOverrides, type ResolvedAgentPreset } from './agent'
import type { PluginBridgeApi } from './bridge'

export interface AgentApiCase {
  name: string
  ok: boolean
  detail?: string
}

const PRESET: ResolvedAgentPreset = {
  id: 'p1',
  name: '冒烟预设',
  maxSteps: 7,
  options: { systemPrompt: '你是助手', provider: 'stub', config: {}, llmConfig: {}, tools: ['ask_user'] },
}

/** 造一个"桥齐备"的假桥，并记录收到的 payload */
function fakeBridge(overrides: Partial<PluginBridgeApi> = {}) {
  const calls: any[] = []
  const bridge = {
    agentRun: async (args: any) => {
      calls.push(args)
      return { ok: true, termination: 'completed', output: '好的', turn: 1 }
    },
    agentCancel: async (args: any) => {
      calls.push({ cancel: args })
      return { cancelled: 2 }
    },
    ...overrides,
  } as unknown as PluginBridgeApi
  return { bridge, calls }
}

function makeDeps(over: Partial<PluginAgentApiDeps> = {}): PluginAgentApiDeps {
  const warns: string[] = []
  const infos: string[] = []
  return {
    pluginId: 'probe',
    permitted: true,
    log: { info: (...a: unknown[]) => infos.push(a.map(String).join(' ')), warn: (...a: unknown[]) => warns.push(a.map(String).join(' ')) },
    bridge: () => fakeBridge().bridge,
    resolvePreset: (id: string) => (id === PRESET.id ? PRESET : null),
    listPresets: () => [{ id: PRESET.id, name: PRESET.name, tools: ['ask_user'], maxSteps: 7 }],
    ...over,
  }
}

/** 记下 resolver 收到的覆盖参数，供断言 */
function recordingDeps(): { deps: PluginAgentApiDeps; seen: PluginAgentOverrides[] } {
  const seen: PluginAgentOverrides[] = []
  const deps = makeDeps({
    resolvePreset: (id: string, overrides: PluginAgentOverrides) => {
      seen.push(overrides)
      return id === PRESET.id ? PRESET : null
    },
  })
  return { deps, seen }
}

export function runPluginAgentApiSelfTest(): AgentApiCase[] {
  const cases: AgentApiCase[] = []

  // ---------------- 可用性判定的三个分支 ----------------
  {
    const api = createPluginAgentApi(makeDeps({ bridge: () => null, permitted: true }))
    cases.push({
      name: '没有桥（网页 / 移动端）→ available=false，reason 指向桌面端',
      ok: api.available === false && /桌面端/.test(api.reason ?? ''),
      detail: `available=${api.available} reason=${api.reason}`,
    })
  }
  {
    const api = createPluginAgentApi(makeDeps({ permitted: false }))
    cases.push({
      name: '有桥但未声明 agent.run → available=false，reason 指向权限（两种不可用要能区分）',
      ok: api.available === false && /agent\.run/.test(api.reason ?? ''),
      detail: `available=${api.available} reason=${api.reason}`,
    })
  }
  {
    const api = createPluginAgentApi(makeDeps())
    cases.push({
      name: 'meta：桥齐备 + 已声明权限 → available=true 且没有 reason（证明上面的判定不是恒 false）',
      ok: api.available === true && api.reason === undefined,
      detail: `available=${api.available} reason=${api.reason}`,
    })
  }
  {
    const api = createPluginAgentApi(makeDeps({ bridge: () => ({ files: {} } as unknown as PluginBridgeApi) }))
    cases.push({
      name: '桥在但**没有** agentRun 方法（例如旧版宿主）→ 同样判不可用，不是运行期才炸',
      ok: api.available === false && /桌面端/.test(api.reason ?? ''),
      detail: `available=${api.available} reason=${api.reason}`,
    })
  }

  // ---------------- run 的入参与错误可读性（异步用例见下面的 async 部分） ----------------

  return cases
}

/** 需要 await 的那些用例单独跑（保持同步部分可被 runner 直接比对） */
export async function runPluginAgentApiAsyncSelfTest(): Promise<AgentApiCase[]> {
  const cases: AgentApiCase[] = []

  /** 取一次调用的拒绝原因（`run` 是 async，必须 await 才能拿到抛错） */
  const rejectOf = async (fn: () => Promise<unknown>): Promise<string> => {
    try {
      await fn()
      return ''
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }

  {
    const api = createPluginAgentApi(makeDeps())
    const emptyPreset = await rejectOf(() => api.run('', '你好'))
    const blankInput = await rejectOf(() => api.run('p1', '   '))
    cases.push({
      name: '空 presetId / 空白 input → 立刻抛错（不发起调用），且错误带插件 id 便于定位',
      ok:
        emptyPreset.includes('presetId') && emptyPreset.includes('plugin:probe') &&
        blankInput.includes('input') && blankInput.includes('plugin:probe'),
      detail: [emptyPreset, blankInput].join(' ｜ '),
    })
  }
  {
    const { bridge, calls } = fakeBridge()
    const api = createPluginAgentApi(makeDeps({ bridge: () => bridge }))
    const msg = await rejectOf(() => api.run('不存在的预设', '你好'))
    cases.push({
      name: '未知预设 → 错误里**列出可用 id**（不给"未找到"这种没法行动的话），且没有过桥',
      ok: msg.includes('不存在的预设') && msg.includes(PRESET.id) && calls.length === 0,
      detail: `${msg}｜过桥次数=${calls.length}`,
    })
  }

  // ---------------- 插件自定义要素（系统提示词 / 工具 / MCP） ----------------
  {
    const { deps, seen } = recordingDeps()
    const api = createPluginAgentApi(deps)
    await api.run('p1', '你好', {
      timeoutMs: 30_000,
      systemPrompt: '你是分类器',
      tools: ['ask_user', 'read_file'],
      mcpServerIds: ['office', 'nope'],
    })
    const got = seen[0] ?? {}
    cases.push({
      name: '插件可自定义：系统提示词 / 工具 / MCP 服务 id 原样交给渲染层解析器',
      ok:
        seen.length === 1 &&
        got.systemPrompt === '你是分类器' &&
        JSON.stringify(got.tools) === JSON.stringify(['ask_user', 'read_file']) &&
        JSON.stringify(got.mcpServerIds) === JSON.stringify(['office', 'nope']),
      detail: JSON.stringify(got),
    })
  }
  {
    // 这是"模型由用户决定"这条规矩的可执行边界：JS 插件（没有类型检查）可以多传任何字段
    const { bridge, calls } = fakeBridge()
    const api = createPluginAgentApi(makeDeps({ bridge: () => bridge }))
    await api.run('p1', '你好', {
      timeoutMs: 20_000,
      // @ts-expect-error 故意的：模拟 JS 插件多传字段
      provider: 'evil-provider',
      model: 'evil-model',
      llmConfig: { api_key: 'sk-evil' },
      config: { base_url: 'https://evil.example' },
      label: 'hijack',
    })
    const sent = calls[0] ?? {}
    const leaked = ['provider', 'model', 'llmConfig', 'config', 'label'].filter((k) => k in (sent.budget ?? {}))
    cases.push({
      name: '**插件多传的 provider / model / llmConfig / config 不会搭车过桥**（模型只能来自用户配置）',
      ok: leaked.length === 0 && sent.budget?.timeoutMs === 20_000 && !('provider' in sent) && !('model' in sent),
      detail: leaked.length ? `泄漏到 budget：${leaked.join(', ')}` : `budget=${JSON.stringify(sent.budget)}｜payload 键=${Object.keys(sent).join(', ')}`,
    })
  }
  {
    const split = splitAgentRunOptions({ timeoutMs: 1000.5, maxSteps: 5, systemPrompt: ' x ', tools: ['a', '', 3 as unknown as string], provider: 'evil' } as never)
    cases.push({
      name: 'splitAgentRunOptions：白名单拆分（空白提示词与垃圾数组项被丢掉，未知字段被丢弃）',
      ok:
        split.budget.timeoutMs === 1000.5 &&
        split.budget.maxSteps === 5 &&
        split.overrides.systemPrompt === ' x ' &&
        JSON.stringify(split.overrides.tools) === JSON.stringify(['a']) &&
        !('provider' in (split.budget as Record<string, unknown>)) &&
        !('provider' in (split.overrides as Record<string, unknown>)),
      detail: JSON.stringify(split),
    })
  }

  // ---------------- 正常路径：过桥的 payload 形状 ----------------
  {
    const { bridge, calls } = fakeBridge()
    const api = createPluginAgentApi(makeDeps({ bridge: () => bridge }))
    const res = await api.run('p1', '帮我写一句话', { maxSteps: 3, timeoutMs: 60_000 })
    const sent = calls[0] ?? {}
    const shaped =
      sent.pluginId === 'probe' &&
      sent.presetId === 'p1' &&
      sent.presetName === PRESET.name &&
      sent.presetMaxSteps === 7 &&
      sent.input === '帮我写一句话' &&
      sent.budget?.maxSteps === 3 &&
      sent.budget?.timeoutMs === 60_000 &&
      // 过桥前会被折成纯 JSON 副本（`toIpcSafe`），所以这里比**深层等值**而不是同一引用：
      // 副本是刻意的（下游改动不会回写预设对象，也不会把响应式代理送进 IPC）
      JSON.stringify(sent.options) === JSON.stringify(PRESET.options)
    cases.push({
      name: '正常调用：pluginId / presetId / presetName / presetMaxSteps / budget / options 都如实过桥（options 为净化副本）',
      ok: shaped && res.ok === true && res.output === '好的',
      detail: JSON.stringify({ sent: { ...sent, options: '(预设 options 的副本)' }, res }),
    })
  }

  // ---------------- 结果**再归一**（这条是核心） ----------------
  {
    const { bridge } = fakeBridge({
      agentRun: async () => ({ ok: true, termination: 'timeout', output: '半截回答', turn: 2 }) as any,
    })
    const api = createPluginAgentApi(makeDeps({ bridge: () => bridge }))
    const res = await api.run('p1', '你好')
    cases.push({
      name: '**结果再归一一次**：桥谎报 ok:true + termination:timeout → 适配器仍判失败并保留部分输出',
      ok: res.ok === false && res.termination === 'timeout' && res.output === '半截回答',
      detail: `ok=${res.ok} termination=${res.termination} output="${res.output}"`,
    })
  }
  {
    const { bridge } = fakeBridge({ agentRun: async () => { throw new Error('PERMISSION_DENIED: 未声明') } })
    const api = createPluginAgentApi(makeDeps({ bridge: () => bridge }))
    let msg = ''
    try {
      await api.run('p1', '你好')
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e)
    }
    cases.push({
      name: '主进程抛错（权限 / 预算）原样透出，不被吞掉（作者要能看到可行动的原因）',
      ok: msg.includes('PERMISSION_DENIED'),
      detail: msg,
    })
  }

  // ---------------- cancelAll ----------------
  {
    const { bridge, calls } = fakeBridge()
    const api = createPluginAgentApi(makeDeps({ bridge: () => bridge }))
    const res = await api.cancelAll()
    cases.push({
      name: 'cancelAll 转发到桥并回传取消数量（插件面板「停止」按钮用）',
      ok: res.cancelled === 2 && calls[0]?.cancel?.pluginId === 'probe',
      detail: JSON.stringify({ res, sent: calls[0] }),
    })
  }
  {
    const api = createPluginAgentApi(makeDeps({ bridge: () => fakeBridge({ agentCancel: undefined }).bridge }))
    const res = await api.cancelAll()
    cases.push({
      name: '桥没有 agentCancel（旧版宿主）→ cancelAll 回 0，不抛错',
      ok: res.cancelled === 0,
      detail: JSON.stringify(res),
    })
  }
  {
    const { bridge } = fakeBridge({ agentCancel: async () => { throw new Error('boom') } })
    const api = createPluginAgentApi(makeDeps({ bridge: () => bridge }))
    const res = await api.cancelAll()
    cases.push({
      name: '取消失败不冒泡（面板上点「停止」不该把插件搞崩）',
      ok: res.cancelled === 0,
      detail: JSON.stringify(res),
    })
  }

  // ---------------- presets() 的健壮性 ----------------
  {
    const api = createPluginAgentApi(makeDeps({ listPresets: () => { throw new Error('store 爆炸') } }))
    const list = api.presets()
    cases.push({
      name: 'presets() 内部抛错 → 返回空数组（列预设失败不该让插件面板整块崩）',
      ok: Array.isArray(list) && list.length === 0,
      detail: JSON.stringify(list),
    })
  }

  return cases
}

/** 命令行入口 */
export async function logPluginAgentApiSelfTest(): Promise<boolean> {
  const cases = [...runPluginAgentApiSelfTest(), ...(await runPluginAgentApiAsyncSelfTest())]
  for (const c of cases) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`)
    if (c.detail) console.log(`      ${c.detail}`)
  }
  return cases.every((c) => c.ok)
}
