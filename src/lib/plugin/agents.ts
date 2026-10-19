/**
 * agents.ts — 界面半边的 `ctx.agents`（委派**句柄**层，能力收敛 P3）
 *
 * 与 `ctx.agent.run()` 的关系：`run()` 是"发起即等待"的一次性糖；`ctx.agents.create()` 返回**句柄**，
 * 让插件能：① 同时跑多个委派并**逐个**观察终态；② 拿到 `usage` / `result` 而不必自己闭包存变量；
 * ③ 幂等的 `dispose()`（卸载时宿主兜底）。`run()` 的入参语义与边界**完全不变**——
 * 模型不可选、预算由主进程裁定、工具按权限裁剪，这些一条没动。
 *
 * ## 有意不做的两件事（写清楚，别被当成 bug）
 *
 * 1. **`followup` / `steer` / `inject` 不支持**：它们要求主进程侧保留一个可继续投递的委派会话，
 *    而现有 `plugin:agent-run` 是"一次请求一次响应"（会话跑完即销毁）。做法是抛
 *    `AGENT_UNSUPPORTED` 并提示改用 `run()`，而不是返回一个假成功的 Promise。
 * 2. **`stream()` 只产出终态**：增量文本走按作用域的 `assistant/chunk` 事件通道，而
 *    `plugin:agent-run` 不返回 agentId，句柄无法把"某条 IPC"和"某条事件流"对上。
 *    要增量请订阅 `ctx.on('assistant/chunk', …)`（只收到自己的工具/委派）。
 *
 * ## 取消语义（传输层限制）
 *
 * 主进程的取消接口是**按插件**的（`plugin:agent-cancel`），因此 `handle.cancel()` 会取消本插件
 * 在飞的全部委派，再把本句柄标为取消。这一点在 `devGuide` 与设置页文案里都要说清。
 */

import { normalizeAgentRunResult, type AgentChunk, type AgentErrorCode, type AgentRunResult } from './agentContract'
import {
  splitAgentRunOptions,
  type PluginAgentApiDeps,
  type PluginAgentOverrides,
  type PluginAgentPreset,
  type PluginAgentRunOptions,
} from './agent'
import type { PluginBridgeApi } from './bridge'

export interface AgentCreateRequest {
  /** 用户配置好的智能体预设 id（模型由预设决定，插件不可选） */
  preset: string
  /** 首轮输入。**必填**（`followup` 尚不支持，空输入会让这次运行没有意义） */
  input?: string
  overrides?: PluginAgentOverrides
  budget?: { timeoutMs?: number; maxSteps?: number; maxTokens?: number }
  signal?: AbortSignal
}

export interface AgentUsageSummary {
  inputTokens: number
  outputTokens: number
  /** 本句柄发起过几次运行（句柄当前固定为 1） */
  calls: number
}

export interface AgentHandle {
  readonly id: string
  readonly presetId: string
  /**
   * 会话 id。**当前恒为 `null`**：`plugin:agent-run` 只回终态，不回会话 id。
   * 保留字段是为了以后主进程把 id 回传时不让插件改代码。
   */
  readonly sessionId: string | null

  /** 运行结束（无论成功失败）后兑现；重复调用返回同一个 Promise */
  whenIdle(): Promise<AgentRunResult>
  /** 已经结束时的结果（未结束返回 undefined） */
  result(): AgentRunResult | undefined
  /** 用量（运行结束后才有数字；未结束返回 0） */
  usage(): AgentUsageSummary

  /** 终态流：`status(running)` → `finish(result)`（见文件头第 2 条） */
  stream(): AsyncIterable<AgentChunk>

  followup(input: string | unknown): Promise<never>
  steer(input: string | unknown): Promise<never>
  inject(input: string | unknown): Promise<never>

  /** 取消本插件在飞的全部委派（传输层限制，见文件头） */
  cancel(cause?: string): Promise<void>
  /** 拆除：取消 + 标为已拆除；**幂等** */
  dispose(): Promise<void>
}

export interface PluginAgentsApi {
  readonly available: boolean
  readonly reason: string
  /** 可选预设（只读；与 `ctx.agent.presets()` 同源） */
  presets(): PluginAgentPreset[]
  create(request: AgentCreateRequest): Promise<AgentHandle>
  get(id: string): AgentHandle | undefined
  list(): AgentHandle[]
  cancelAll(): Promise<{ cancelled: number }>
}

function agentError(code: AgentErrorCode, message: string): Error {
  const err = new Error(message) as Error & { code?: AgentErrorCode }
  err.code = code
  return err
}

export type PluginAgentsApiDeps = PluginAgentApiDeps

export function createPluginAgentsApi(deps: PluginAgentsApiDeps): PluginAgentsApi {
  const handles = new Map<string, AgentHandle>()
  let seq = 0

  const bridge = (): PluginBridgeApi | null => deps.bridge()
  const unavailableReason = (): string | undefined => {
    const b = bridge()
    if (!b || typeof b.agentRun !== 'function') {
      return '当前运行方式不支持委派智能体（需要桌面端；网页 / 移动端的本地宿主没有主进程可执行预算）'
    }
    if (!deps.permitted) {
      return '未声明 "agent.run" 权限（在 package.json 的 aikm.permissions 里加上它，然后重载插件）'
    }
    return undefined
  }

  const makeHandle = (id: string, presetId: string, run: Promise<AgentRunResult>): AgentHandle => {
    let settled: AgentRunResult | undefined
    let disposed = false
    let cancelling = false
    const idle = run.then(
      (result) => {
        settled = result
        return result
      },
      (e) => {
        // 传输层抛异常也要归一成结果：句柄的 whenIdle 不该 reject（否则调用方要 try/catch 两套）
        settled = normalizeAgentRunResult({ termination: 'error', error: e instanceof Error ? e.message : String(e) })
        return settled
      },
    )

    const unsupported = (what: string): Promise<never> =>
      Promise.reject(
        agentError(
          'AGENT_UNSUPPORTED',
          `${what} 暂不支持：现有委派是"一次请求一次响应"，跑完会话即销毁。请改用 ctx.agent.run() 再发起一次，` +
            '或把这条需求提到宿主（需要主进程保留可继续投递的委派会话）。',
        ),
      )

    const handle: AgentHandle = {
      id,
      presetId,
      sessionId: null,

      whenIdle: () => idle,
      result: () => settled,
      usage() {
        const u = settled?.usage
        return {
          inputTokens: Number(u?.inputTokens) || 0,
          outputTokens: Number(u?.outputTokens) || 0,
          calls: settled ? 1 : 0,
        }
      },

      async *stream(): AsyncIterable<AgentChunk> {
        yield { type: 'status', phase: 'running', id }
        const result = await idle
        yield { type: 'finish', id, result }
        yield { type: 'status', phase: 'idle', id }
      },

      followup: (input) => unsupported('followup(input)'),
      steer: (input) => unsupported('steer(input)'),
      inject: (input) => unsupported('inject(input)'),

      async cancel(cause?: string) {
        if (disposed && settled) return
        const b = bridge()
        if (!b || typeof b.agentCancel !== 'function') return
        cancelling = true
        try {
          await b.agentCancel({ pluginId: deps.pluginId })
        } catch (e) {
          deps.log.warn(`取消委派失败：${e instanceof Error ? e.message : String(e)}`)
        } finally {
          cancelling = false
        }
        void cause
      },

      async dispose() {
        if (disposed) return
        disposed = true
        if (!settled) await handle.cancel('dispose')
        handles.delete(id)
      },
    }
    void cancelling
    handles.set(id, handle)
    return handle
  }

  return {
    get available() {
      return unavailableReason() === undefined
    },
    get reason() {
      return unavailableReason() ?? ''
    },

    presets() {
      try {
        return deps.listPresets() || []
      } catch {
        return []
      }
    },

    async create(request: AgentCreateRequest): Promise<AgentHandle> {
      const why = unavailableReason()
      if (why) throw agentError('AGENT_UNSUPPORTED', why)
      const presetId = String(request?.preset ?? '').trim()
      const input = String(request?.input ?? '').trim()
      if (!presetId) throw agentError('AGENT_BAD_REQUEST', 'create() 需要 preset（预设 id）')
      if (!input) {
        throw agentError(
          'AGENT_BAD_REQUEST',
          'create() 需要 input：followup 暂不支持，没有首轮输入的委派不会产出任何东西',
        )
      }

      const opts: PluginAgentRunOptions = {
        ...(request?.overrides ?? {}),
        ...(request?.budget ?? {}),
      }
      const split = splitAgentRunOptions(opts)
      const preset = deps.resolvePreset(presetId, split.overrides)
      if (!preset) throw agentError('AGENT_NOT_FOUND', `预设不存在或不可用：${presetId}`)

      const b = bridge()
      if (!b || typeof b.agentRun !== 'function') throw agentError('AGENT_UNSUPPORTED', unavailableReason() ?? '委派不可用')

      const id = `agent-${++seq}`
      const run = b
        .agentRun({
          pluginId: deps.pluginId,
          presetId,
          presetName: preset.name,
          presetMaxSteps: preset.maxSteps,
          input,
          budget: split.budget,
          options: preset.options,
        })
        .then((raw: unknown) => normalizeAgentRunResult(raw as Record<string, unknown>))

      return makeHandle(id, presetId, run)
    },

    get(id: string) {
      return handles.get(String(id ?? ''))
    },

    list() {
      return Array.from(handles.values())
    },

    async cancelAll(): Promise<{ cancelled: number }> {
      const b = bridge()
      if (!b || typeof b.agentCancel !== 'function') return { cancelled: 0 }
      try {
        return await b.agentCancel({ pluginId: deps.pluginId })
      } catch (e) {
        deps.log.warn(`cancelAll 失败：${e instanceof Error ? e.message : String(e)}`)
        return { cancelled: 0 }
      }
    },
  }
}
