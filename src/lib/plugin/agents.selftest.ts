/**
 * pluginAgentsApi.selftest.ts — `ctx.agents`（委派句柄层）的适配器自测
 *
 * 这一层是插件真正调用的一面，且**只有它**能把"句柄语义"（幂等 dispose / whenIdle 不 reject /
 * 不支持的能力明确抛 AGENT_UNSUPPORTED / cancelAll 落到桥）与真实传输层解耦地验证一遍。
 *
 * 用 DI 纯函数（桥与预设解析器都是注入的）：不需要 DOM / IPC / 模型。
 * 用法：`node scripts/run-selftests.mjs pluginAgentsApi`
 */

import { createPluginAgentsApi, type PluginAgentsApiDeps } from './agents'
import type { PluginBridgeApi } from './bridge'
import type { ResolvedAgentPreset } from './agent'

export interface AgentHandleCase {
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

interface FakeBridgeOptions {
  result?: Record<string, unknown>
  reject?: Error
  cancel?: { cancelled: number }
}

function fakeBridge(opts: FakeBridgeOptions = {}) {
  const calls: any[] = []
  const bridge = {
    agentRun: async (args: any) => {
      calls.push({ run: args })
      if (opts.reject) throw opts.reject
      return opts.result ?? { termination: 'completed', output: '好的', turn: 1, usage: { inputTokens: 5, outputTokens: 7 } }
    },
    agentCancel: async (args: any) => {
      calls.push({ cancel: args })
      return opts.cancel ?? { cancelled: 1 }
    },
  } as unknown as PluginBridgeApi
  return { bridge, calls }
}

function makeDeps(bridge: PluginBridgeApi | null, overrides: Partial<PluginAgentsApiDeps> = {}): PluginAgentsApiDeps {
  const logs: string[] = []
  return {
    pluginId: 'probe',
    permitted: true,
    log: {
      info: (...a: unknown[]) => logs.push(`info:${a.join(' ')}`),
      warn: (...a: unknown[]) => logs.push(`warn:${a.join(' ')}`),
    },
    bridge: () => bridge,
    resolvePreset: (id) => (id === 'p1' ? PRESET : null),
    listPresets: () => [{ id: 'p1', name: '冒烟预设', tools: ['ask_user'], maxSteps: 7 }],
    ...overrides,
  }
}

export async function runPluginAgentsApiSelfTest(): Promise<AgentHandleCase[]> {
  const cases: AgentHandleCase[] = []
  const check = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })
  const codeOf = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p
      return ''
    } catch (e: any) {
      return String(e?.code ?? e?.message ?? e)
    }
  }

  // ---- 不可用 / 参数校验 ----
  {
    const api = createPluginAgentsApi(makeDeps(null))
    check('桥不可用 → available=false 且 reason 非空', api.available === false && api.reason.length > 0, api.reason)
    check('桥不可用 → create 抛 AGENT_UNSUPPORTED', (await codeOf(api.create({ preset: 'p1', input: 'hi' }))) === 'AGENT_UNSUPPORTED')
  }
  {
    const { bridge } = fakeBridge()
    const api = createPluginAgentsApi(makeDeps(bridge, { permitted: false }))
    check('未声明 agent.run → create 抛 AGENT_UNSUPPORTED', (await codeOf(api.create({ preset: 'p1', input: 'hi' }))) === 'AGENT_UNSUPPORTED')
  }
  {
    const { bridge } = fakeBridge()
    const api = createPluginAgentsApi(makeDeps(bridge))
    check('缺 preset → AGENT_BAD_REQUEST', (await codeOf(api.create({ input: 'hi' } as any))) === 'AGENT_BAD_REQUEST')
    check('缺 input → AGENT_BAD_REQUEST（followup 不支持，空输入没意义）', (await codeOf(api.create({ preset: 'p1' }))) === 'AGENT_BAD_REQUEST')
    check('未知预设 → AGENT_NOT_FOUND', (await codeOf(api.create({ preset: 'nope', input: 'hi' }))) === 'AGENT_NOT_FOUND')
  }

  // ---- 正常路径 ----
  {
    const { bridge, calls } = fakeBridge()
    const api = createPluginAgentsApi(makeDeps(bridge))
    const handle = await api.create({ preset: 'p1', input: '帮我看下', budget: { maxSteps: 3, timeoutMs: 5000 } })
    check('create 返回句柄并进 list', api.get(handle.id) === handle && api.list().length === 1, handle.id)
    check('sessionId 目前恒为 null（主进程不回传）', handle.sessionId === null)

    const result = await handle.whenIdle()
    check('whenIdle 返回归一结果', result.ok === true && result.termination === 'completed' && result.output === '好的', JSON.stringify(result))
    check('result() 在结束后可取', handle.result()?.termination === 'completed')
    check('usage() 汇总 token 与调用数', handle.usage().inputTokens === 5 && handle.usage().outputTokens === 7 && handle.usage().calls === 1, JSON.stringify(handle.usage()))

    const runCall = calls.find((c) => c.run)?.run
    check('预算原样进桥（maxSteps/timeoutMs）', runCall?.budget?.maxSteps === 3 && runCall?.budget?.timeoutMs === 5000, JSON.stringify(runCall?.budget))
    check('预设 options 原样进桥（模型由预设决定，插件无法覆盖）', runCall?.options?.provider === 'stub', JSON.stringify(runCall?.options))
    check('pluginId 随调用上报（预算/审计归账用）', runCall?.pluginId === 'probe')

    const chunks: any[] = []
    for await (const c of handle.stream()) chunks.push(c)
    check(
      'stream 产出 status → finish → status（终态可观测）',
      chunks[0]?.type === 'status' && chunks[0]?.phase === 'running' && chunks[1]?.type === 'finish' && chunks[2]?.phase === 'idle',
      JSON.stringify(chunks.map((c) => c.type + ':' + (c.phase ?? c.result?.termination))),
    )
  }

  // ---- 不支持的能力：明确抛错而不是假成功 ----
  {
    const { bridge } = fakeBridge()
    const api = createPluginAgentsApi(makeDeps(bridge))
    const handle = await api.create({ preset: 'p1', input: 'hi' })
    await handle.whenIdle()
    check('followup → AGENT_UNSUPPORTED', (await codeOf(handle.followup('再来一轮'))) === 'AGENT_UNSUPPORTED')
    check('steer → AGENT_UNSUPPORTED', (await codeOf(handle.steer('改方向'))) === 'AGENT_UNSUPPORTED')
    check('inject → AGENT_UNSUPPORTED', (await codeOf(handle.inject('补充上下文'))) === 'AGENT_UNSUPPORTED')
  }

  // ---- 失败不 reject：归一成 termination=error ----
  {
    const { bridge } = fakeBridge({ reject: new Error('传输层炸了') })
    const api = createPluginAgentsApi(makeDeps(bridge))
    const handle = await api.create({ preset: 'p1', input: 'hi' })
    const result = await handle.whenIdle()
    check('桥抛异常 → whenIdle 仍兑现，termination=error', result.ok === false && result.termination === 'error', JSON.stringify(result))
    check('错误文案保留下来（不吞）', String(result.error || '').includes('传输层炸了'), result.error)
  }

  // ---- dispose / cancel ----
  {
    const { bridge, calls } = fakeBridge()
    const api = createPluginAgentsApi(makeDeps(bridge))
    const handle = await api.create({ preset: 'p1', input: 'hi' })
    await handle.dispose()
    await handle.dispose()
    check('dispose 幂等', true)
    check('dispose 后从 list 移除', api.list().length === 0)
    check('未结束的句柄 dispose 会调桥取消（否则插件没了钱还在烧）', calls.some((c) => c.cancel))
  }
  {
    const { bridge } = fakeBridge({ cancel: { cancelled: 3 } })
    const api = createPluginAgentsApi(makeDeps(bridge))
    const res = await api.cancelAll()
    check('cancelAll 透传桥的计数', res.cancelled === 3, JSON.stringify(res))
  }
  {
    // 结束后 dispose 不该再触发取消（避免误伤同插件的其它在飞委派）
    const { bridge, calls } = fakeBridge()
    const api = createPluginAgentsApi(makeDeps(bridge))
    const handle = await api.create({ preset: 'p1', input: 'hi' })
    await handle.whenIdle()
    await handle.dispose()
    check('已结束的句柄 dispose 不再调取消', !calls.some((c) => c.cancel))
  }

  return cases
}
