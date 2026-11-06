/**
 * session-controller.ts — `ctx.sessionController` 的实现（P1）
 *
 * 语义对齐 DSH：`create` 幂等 adopt、`prompt` 的 queue/steer、`cancel`、`list`、
 * `modelCatalog`、`projections`、`selectModel`。
 *
 * AI-KM 的差异（有意）：
 * - **物理会话与逻辑会话分离**：换模型会重建 agent（`canResumeWith` 把换模型视为新会话），
 *   逻辑 id 由 `PluginSessionRegistry` 保持不变；
 * - **工具面按插件权限裁剪**：插件只声明 `agent.control` 时，会话只拿只读工具；
 *   声明 `fs` / `shell` 才放开对应写入 / 执行工具（见 `index.ts` 的 `buildAgentOptions`）；
 * - **`selectModel` 暂只支持同来源内换模型**：跨来源需要渲染层把该来源的配置（含密钥）
 *   下发给主进程，P1 不做——遇到跨来源抛 `PLUGIN_UNSUPPORTED` 并说明原因。
 *
 * 本文件依赖 agent-loop / session-log，属于主进程实现；纯逻辑（别名 / 幂等）在
 * `src/shared/pluginSessionRegistry.ts`，可被自测钉住。
 */

import { randomUUID } from 'node:crypto'
import { createAgent, disposeAgent, getAgent } from '../agent-loop'
import { sessionLog } from '../session-log'
import { ownerOfAgent, registerOwnedAgent, unregisterOwnedAgent } from '../plugin-owned-agents'
import { normalizeLlmType } from '@/shared/llmSources'
import { PluginServiceError } from '@/shared/pluginServices'
import type { AgentOptions } from '@/types/agent'
import type {
  ModelCatalog,
  ModelSelection,
  PluginSessionControllerService,
  PluginSessionProjectionsService,
  SessionCreateRequest,
  SessionCreateResult,
  SessionId,
  SessionProjections,
  SessionPromptRequest,
  SessionSummary,
} from '@/shared/pluginServices'
import type { PluginLogger } from '@/types/plugin'
import {
  PluginSessionRegistry,
  type PluginSessionRecordState,
} from '@/shared/pluginSessionRegistry'
import { buildModelCatalog, catalogHasModel } from './model-catalog'

/** 由 `index.ts` 注入的「用哪套模型 / 工具 / 工作目录建会话」 */
export interface AgentOptionsFactory {
  (input: {
    readonly sessionId: string
    readonly cwd?: string
    readonly agentPreset?: string
    readonly model?: ModelSelection | null
    readonly resume?: boolean
    readonly seedHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
    readonly seedPlan?: string | null
    readonly seedTodos?: any[]
  }): { options: AgentOptions; model: ModelSelection | null }
}

export interface SessionControllerDeps {
  readonly pluginId: string
  readonly log: PluginLogger
  readonly registry: PluginSessionRegistry
  readonly buildOptions: AgentOptionsFactory
  /** `create({ workspaceId })` 的解析器（P4：单工作区） */
  readonly resolveWorkspace?: (workspaceId: string) => string | undefined
  /** 新物理 agent 建好后的宿主钩子（例如写 DSH 兼容会话索引） */
  readonly onAgentCreated?: (sessionId: string, cwd: string) => void
}

function sameModel(a: ModelSelection | null, b: ModelSelection | null): boolean {
  if (!a || !b) return a === b
  return a.provider === b.provider && a.model === b.model && (a.reasoningEffort || '') === (b.reasoningEffort || '')
}

/** 把逻辑会话当前物理 agent 的日志投影成 seedHistory（只保留 user / assistant） */
function historyOf(agentId: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const m of sessionLog.deriveMessages(agentId)) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    if (!m.content) continue
    out.push({ role: m.role, content: m.content })
  }
  return out
}

export function createSessionController(deps: SessionControllerDeps): PluginSessionControllerService {
  const { pluginId, registry, log } = deps

  /** 用当前（或指定）模型新建一个物理 agent；调用方负责登记 */
  function spawn(rec: PluginSessionRecordState, model: ModelSelection | null, seed?: {
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
    plan?: string | null
    todos?: any[]
  }) {
    const built = deps.buildOptions({
      sessionId: rec.id,
      cwd: rec.cwd,
      agentPreset: rec.agentPreset,
      model,
      seedHistory: seed?.history,
      seedPlan: seed?.plan,
      seedTodos: seed?.todos,
    })
    const agent = createAgent(built.options)
    registerOwnedAgent(agent.id, pluginId)
    try {
      deps.onAgentCreated?.(String(agent.id), String(built.options.cwd || ''))
    } catch {
      /* 兼容索引失败不影响会话 */
    }
    return { agent, model: built.model }
  }

  /** 重建：换模型 / agent 丢了 / 插件重启后恢复。逻辑 id 不变，物理 id 变。 */
  async function rebuild(rec: PluginSessionRecordState, model: ModelSelection | null): Promise<ReturnType<typeof spawn>['agent']> {
    const oldId = rec.agentId
    const history = sessionLog.exists(oldId) ? historyOf(oldId) : []
    const state = sessionLog.exists(oldId) ? sessionLog.projectAgentState(oldId) : { plan: null, todos: [] }
    unregisterOwnedAgent(oldId)
    try {
      await disposeAgent(oldId)
    } catch (e) {
      log.warn(`[sessionController] 旧 agent 释放失败（继续重建）: ${e instanceof Error ? e.message : String(e)}`)
    }
    const next = spawn(rec, model, { history, plan: state.plan, todos: state.todos })
    registry.setAgent(rec.id, next.agent.id)
    registry.setModel(rec.id, next.model)
    return next.agent
  }

  function ensureLive(rec: PluginSessionRecordState) {
    const live = getAgent(rec.agentId)
    if (live) return live
    // agent 丢了（进程重启 / 被外部释放）：从日志恢复历史与计划，别让上下文凭空消失
    const history = sessionLog.exists(rec.agentId) ? historyOf(rec.agentId) : []
    const state = sessionLog.exists(rec.agentId) ? sessionLog.projectAgentState(rec.agentId) : { plan: null, todos: [] }
    const next = spawn(rec, rec.model, { history, plan: state.plan, todos: state.todos })
    registry.setAgent(rec.id, next.agent.id)
    registry.setModel(rec.id, next.model)
    return next.agent
  }

  const create = async (request: SessionCreateRequest): Promise<SessionCreateResult> => {
    const requested = String(request.sessionId || '').trim()
    if (requested) {
      const existing = registry.get(requested)
      if (existing) return { sessionId: existing.id, agentPreset: existing.agentPreset }
    }
    if (request.cwd && request.workspaceId) {
      throw new PluginServiceError('PLUGIN_INVALID_ARGUMENT', 'create 的 cwd 与 workspaceId 只能二选一', { service: 'sessionController' })
    }
    let cwd = request.cwd
    if (request.workspaceId) {
      const resolved = deps.resolveWorkspace?.(request.workspaceId)
      if (!resolved) {
        throw new PluginServiceError('PLUGIN_NOT_FOUND', `工作区不存在：${request.workspaceId}（先看 workspaceRegistry.list）`, {
          service: 'sessionController',
        })
      }
      cwd = resolved
    }
    const logicalId = requested || `plugin-${pluginId}-${randomUUID()}`
    const resume = sessionLog.exists(logicalId)
    if (resume) {
      // 另一个插件正在用的会话不能被抢（运行期归属表；进程重启后的历史会话暂无法判定）
      const holder = ownerOfAgent(logicalId)
      if (holder && holder !== pluginId) {
        throw new PluginServiceError(
          'PLUGIN_CONFLICT',
          `会话 ${logicalId} 正被另一个插件使用（${holder}）`,
          { service: 'sessionController' },
        )
      }
    }
    const rec = registry.upsert({
      id: logicalId,
      agentId: logicalId, // 占位：下面立刻用真实物理 id 覆盖
      cwd,
      agentPreset: request.agentPreset,
    })
    try {
      const built = deps.buildOptions({
        sessionId: logicalId,
        cwd,
        agentPreset: request.agentPreset,
        resume,
        // resume 成功时 seedHistory 会被忽略；失败回退成新会话时它就是上下文
        ...(resume ? { seedHistory: historyOf(logicalId) } : {}),
      })
      // resume 且签名兼容时 createAgent 会复用同一个 id；否则生成新 id（逻辑 id 已登记）
      const agent = createAgent(built.options)
      registerOwnedAgent(agent.id, pluginId)
      registry.setAgent(rec.id, agent.id)
      registry.setModel(rec.id, built.model)
      try {
        deps.onAgentCreated?.(String(agent.id), String(built.options.cwd || ''))
      } catch {
        /* 兼容索引失败不影响会话 */
      }
      return { sessionId: rec.id, agentPreset: rec.agentPreset }
    } catch (e) {
      // 建不起来（没模型配置 / 参数错）：别留下"有登记、没 agent"的僵尸会话
      registry.remove(rec.id)
      throw e
    }
  }

  const prompt = async (request: SessionPromptRequest, signal: AbortSignal): Promise<{ accepted: true }> => {
    if (signal.aborted) {
      throw new PluginServiceError('PLUGIN_INVALID_ARGUMENT', 'prompt 已被取消', { service: 'sessionController' })
    }
    const rec = registry.get(request.sessionId)
    if (!rec) {
      throw new PluginServiceError('PLUGIN_NOT_FOUND', `会话不存在：${request.sessionId}`, { service: 'sessionController' })
    }
    if (rec.requests.includes(request.requestId)) return { accepted: true }
    const text = request.content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
      .trim()
    if (!text) {
      throw new PluginServiceError('PLUGIN_INVALID_ARGUMENT', 'prompt 的 content 里没有文本', { service: 'sessionController' })
    }
    let agent = getAgent(rec.agentId)
    if (rec.pendingModel && !sameModel(rec.pendingModel, rec.model)) {
      // 换模型要重建 agent；正在跑时重建会丢当前轮输出，先拒绝，让调用方稍后重试
      if (agent && agent.status === 'running') {
        throw new PluginServiceError(
          'PLUGIN_CONFLICT',
          '会话仍在运行：等这一轮结束再让 selectModel 生效（下一条 prompt 会重建）',
          { service: 'sessionController' },
        )
      }
      agent = await rebuild(rec, rec.pendingModel)
    } else if (!agent) {
      agent = ensureLive(rec)
    }
    if (request.mode === 'steer') agent.steer(text)
    else agent.send(text, `plugin:${pluginId}`)
    registry.rememberRequest(rec.id, request.requestId)
    return { accepted: true }
  }

  const cancel = async (request: { sessionId: SessionId }): Promise<void> => {
    const rec = registry.get(request.sessionId)
    if (!rec) {
      throw new PluginServiceError('PLUGIN_NOT_FOUND', `会话不存在：${request.sessionId}`, { service: 'sessionController' })
    }
    getAgent(rec.agentId)?.cancel('user')
  }

  const list = async (): Promise<{ items: readonly SessionSummary[] }> => {
    const rows = sessionLog.listSessions()
    const items: SessionSummary[] = rows
      .map((row) => {
        const rec = registry.getByAgent(row.id) ?? registry.get(row.id)
        return {
          sessionId: rec?.id || row.id,
          updatedAt: row.lastTs,
          ...(rec?.agentPreset ? { agentPreset: rec.agentPreset } : {}),
        } satisfies SessionSummary
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
    return { items }
  }

  const modelCatalog = async (): Promise<ModelCatalog> => buildModelCatalog()

  const projections = async (request: { sessionId: SessionId }): Promise<{ values?: SessionProjections } | null> => {
    const rec = registry.get(request.sessionId)
    if (!rec) return null
    return {
      values: {
        modelSelection: {
          lastUsed: rec.model,
          next: rec.pendingModel ?? rec.model,
        },
      },
    }
  }

  const selectModel = async (request: {
    sessionId: SessionId
    provider: string
    model: string
    reasoningEffort?: string
  }): Promise<{ selected: ModelSelection }> => {
    const rec = registry.get(request.sessionId)
    if (!rec) {
      throw new PluginServiceError('PLUGIN_NOT_FOUND', `会话不存在：${request.sessionId}`, { service: 'sessionController' })
    }
    const catalog = buildModelCatalog()
    if (!catalogHasModel(catalog, request.provider, request.model)) {
      throw new PluginServiceError(
        'PLUGIN_INVALID_ARGUMENT',
        `模型不在主机目录里：${request.provider} / ${request.model}（先看 modelCatalog）`,
        { service: 'sessionController' },
      )
    }
    const host = catalog.default
    if (request.provider && host.provider && normalizeLlmType(request.provider) !== normalizeLlmType(host.provider)) {
      throw new PluginServiceError(
        'PLUGIN_UNSUPPORTED',
        `暂不支持跨来源换模型（主机当前来源 ${host.provider}）：跨来源需要该来源的配置下发给主进程，P1 未做`,
        { service: 'sessionController' },
      )
    }
    const selected: ModelSelection = {
      provider: request.provider,
      model: request.model,
      ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
    }
    registry.setPendingModel(rec.id, selected)
    return { selected }
  }

  return {
    create,
    prompt,
    cancel,
    list,
    modelCatalog,
    projections,
    selectModel,
  }
}

/** `ctx.sessionProjections`：只读缓存视图（读同一份 registry） */
export function createSessionProjections(registry: PluginSessionRegistry): PluginSessionProjectionsService {
  return {
    cachedSnapshot(id: SessionId): SessionProjections | undefined {
      const rec = registry.get(id)
      if (!rec) return undefined
      return {
        modelSelection: {
          lastUsed: rec.model,
          next: rec.pendingModel ?? rec.model,
        },
      }
    },
  }
}
