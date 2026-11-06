/**
 * sessions.ts — `ctx.sessions` 的实现（只读视图，P1）
 *
 * 只回答三件事：会话头部、最近会话、历史投影。**不创建、不发消息、不启动 agent**——
 * 那些在 `sessionController` 里，权限也不同（`agent` vs `agent.control`）。
 *
 * 逻辑 id ↔ 物理 agent id 的换算在 `PluginSessionRegistry`；插件会话用逻辑 id，
 * 宿主自己的会话（桌面 / 网页）原样用物理 id。
 */

import { sessionLog } from '../session-log'
import { PluginServiceError } from '@/shared/pluginServices'
import type {
  PluginSessionsService,
  SessionId,
  SessionRecord,
  SessionSummary,
  TranscriptEntry,
} from '@/shared/pluginServices'
import type { PluginSessionRegistry } from '@/shared/pluginSessionRegistry'

export interface SessionsServiceOptions {
  /** 能否读正文：`agent` 只给摘要，正文要 `agent.observe`（与权限表一致） */
  readonly canReadTranscript: boolean
}

export function createSessionsService(
  registry: PluginSessionRegistry,
  options: SessionsServiceOptions,
): PluginSessionsService {
  const resolve = (id: SessionId) => registry.get(id) ?? registry.getByAgent(id)

  return {
    get(id: SessionId): SessionRecord | undefined {
      const rec = resolve(id)
      if (rec) {
        return {
          header: {
            ...(rec.cwd ? { cwd: rec.cwd } : {}),
            ...(rec.agentPreset ? { agentPreset: rec.agentPreset } : {}),
          },
        }
      }
      if (sessionLog.exists(id)) return { header: {} }
      return undefined
    },

    list(): readonly SessionSummary[] {
      return sessionLog
        .listSessions()
        .map((row) => {
          const rec = resolve(row.id)
          return {
            sessionId: rec?.id || row.id,
            updatedAt: row.lastTs,
            ...(rec?.agentPreset ? { agentPreset: rec.agentPreset } : {}),
          } satisfies SessionSummary
        })
        .sort((a, b) => b.updatedAt - a.updatedAt)
    },

    async transcript(id: SessionId, options2?: { limit?: number }): Promise<readonly TranscriptEntry[]> {
      if (!options.canReadTranscript) {
        throw new PluginServiceError(
          'PLUGIN_PERMISSION_DENIED',
          '读会话正文需要 agent.observe 权限（agent 只给摘要：list / get）',
          { service: 'sessions', permission: 'agent.observe' },
        )
      }
      const rec = resolve(id)
      const agentId = rec?.agentId || id
      if (!sessionLog.exists(agentId)) {
        throw new PluginServiceError('PLUGIN_NOT_FOUND', `会话不存在：${id}`, { service: 'sessions' })
      }
      const entries: TranscriptEntry[] = sessionLog.deriveMessages(agentId).map((m) => ({
        role: m.role,
        content: m.content || '',
        ...(m.name ? { toolName: m.name } : {}),
        ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
      }))
      const limit = Math.max(0, Math.round(Number(options2?.limit) || 0))
      return limit > 0 ? entries.slice(-limit) : entries
    },
  }
}
