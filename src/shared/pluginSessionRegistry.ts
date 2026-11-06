/**
 * pluginSessionRegistry.ts — 插件「逻辑会话」登记表（纯逻辑，主进程与自测共用）
 *
 * 为什么需要它：DSH 的 `sessionController` 承诺「同一 sessionId 幂等 adopt」，而 AI-KM 的
 * agent 在创建时固定 provider/config、换模型会走**新物理会话**（见 agent-loop 的
 * `canResumeWith`）。于是给插件看的「逻辑 sessionId」与内核的「物理 agentId」必须分开：
 *
 * - 插件看到的永远是逻辑 id（它用它做会话映射、绑微信聊天）；
 * - 换模型时重建 agent，只换物理 id，逻辑 id 不变；
 * - `previousAgentIds` 保留历史物理 id，供 transcript 合并（P1 只记，不合并）。
 *
 * 本文件**不做 I/O、不 import electron**：它是可被自测直接钉住的那一半。
 */

import type { ModelSelection } from './pluginServices'

/** 一条逻辑会话（对插件可见的是 `id`，`agentId` 是内核当前实例） */
export interface PluginSessionRecordState {
  readonly id: string
  /** 当前物理 agent id（重建后更新） */
  agentId: string
  /** 历史上用过的物理 agent id（重建产生；新的在前） */
  previousAgentIds: string[]
  readonly cwd?: string
  readonly agentPreset?: string
  readonly createdAt: number
  updatedAt: number
  /** 最近一次实际使用的模型（没有则由宿主默认决定） */
  model: ModelSelection | null
  /** `selectModel` 记下、等下一轮 `prompt` 生效的模型 */
  pendingModel: ModelSelection | null
  /** 已处理过的 `prompt.requestId`（幂等；有上限，防长会话吃掉内存） */
  readonly requests: string[]
}

/** 每个会话最多记多少个 requestId（幂等窗口） */
export const PLUGIN_SESSION_REQUEST_LIMIT = 64
/** 最多保留多少个历史物理 id（transcript 合并用） */
export const PLUGIN_SESSION_PREVIOUS_LIMIT = 8

export interface PluginSessionUpsertInput {
  readonly id: string
  readonly agentId: string
  readonly cwd?: string
  readonly agentPreset?: string
  readonly model?: ModelSelection | null
  readonly now?: number
}

export class PluginSessionRegistry {
  private byId = new Map<string, PluginSessionRecordState>()
  private byAgent = new Map<string, string>()

  /** 按逻辑 id 取 */
  get(id: string): PluginSessionRecordState | undefined {
    return this.byId.get(String(id || '').trim())
  }

  /** 按物理 agent id 反查（事件归属 / adopt 用） */
  getByAgent(agentId: string): PluginSessionRecordState | undefined {
    const id = this.byAgent.get(String(agentId || '').trim())
    return id ? this.byId.get(id) : undefined
  }

  /** 新建或更新一条记录（同 id 幂等；更新时保留 createdAt / requests） */
  upsert(input: PluginSessionUpsertInput): PluginSessionRecordState {
    const id = String(input.id || '').trim()
    const agentId = String(input.agentId || '').trim()
    if (!id) throw new Error('[plugin-session] 缺少逻辑 sessionId')
    if (!agentId) throw new Error('[plugin-session] 缺少物理 agentId')
    const now = input.now ?? Date.now()
    const existing = this.byId.get(id)
    if (existing) {
      this.byAgent.delete(existing.agentId)
      existing.agentId = agentId
      existing.updatedAt = now
      if (input.model) existing.model = input.model
      this.byAgent.set(agentId, id)
      return existing
    }
    const record: PluginSessionRecordState = {
      id,
      agentId,
      previousAgentIds: [],
      cwd: input.cwd,
      agentPreset: input.agentPreset,
      createdAt: now,
      updatedAt: now,
      model: input.model ?? null,
      pendingModel: null,
      requests: [],
    }
    this.byId.set(id, record)
    this.byAgent.set(agentId, id)
    return record
  }

  /** 换物理 agent（重建后调用）：旧 id 进 previousAgentIds，逻辑 id 不变 */
  setAgent(id: string, agentId: string, now = Date.now()): PluginSessionRecordState | undefined {
    const record = this.get(id)
    const next = String(agentId || '').trim()
    if (!record || !next) return undefined
    if (record.agentId === next) return record
    this.byAgent.delete(record.agentId)
    record.previousAgentIds.unshift(record.agentId)
    if (record.previousAgentIds.length > PLUGIN_SESSION_PREVIOUS_LIMIT) {
      record.previousAgentIds.length = PLUGIN_SESSION_PREVIOUS_LIMIT
    }
    record.agentId = next
    record.updatedAt = now
    this.byAgent.set(next, record.id)
    return record
  }

  /** 记录一次已处理的 requestId；返回 false = 重复请求（调用方应直接回 accepted） */
  rememberRequest(id: string, requestId: string, now = Date.now()): boolean {
    const record = this.get(id)
    const req = String(requestId || '').trim()
    if (!record || !req) return true
    if (record.requests.includes(req)) return false
    record.requests.push(req)
    if (record.requests.length > PLUGIN_SESSION_REQUEST_LIMIT) record.requests.shift()
    record.updatedAt = now
    return true
  }

  setModel(id: string, model: ModelSelection | null): void {
    const record = this.get(id)
    if (!record) return
    record.model = model
    record.pendingModel = null
    record.updatedAt = Date.now()
  }

  setPendingModel(id: string, model: ModelSelection | null): void {
    const record = this.get(id)
    if (!record) return
    record.pendingModel = model
    record.updatedAt = Date.now()
  }

  /** 全部会话（按最近活跃排序） */
  list(): PluginSessionRecordState[] {
    return Array.from(this.byId.values()).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  remove(id: string): void {
    const record = this.get(id)
    if (!record) return
    this.byAgent.delete(record.agentId)
    for (const old of record.previousAgentIds) this.byAgent.delete(old)
    this.byId.delete(record.id)
  }

  clear(): void {
    this.byId.clear()
    this.byAgent.clear()
  }

  get size(): number {
    return this.byId.size
  }
}
