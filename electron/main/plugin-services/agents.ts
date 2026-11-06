/**
 * agents.ts — `ctx.agents` 的实现（P1）
 *
 * 薄壳：DSH 的 `agents.create / ensureSession / get` 与本地的逻辑会话一一对应。
 * 真正的会话创建在 `session-controller.ts`，这里只做形状转换与 id 解析。
 */

import type { PluginAgentsService, PluginSessionControllerService } from '@/shared/pluginServices'
import type { PluginSessionRegistry } from '@/shared/pluginSessionRegistry'

export function createAgentsService(
  controller: PluginSessionControllerService,
  registry: PluginSessionRegistry,
): PluginAgentsService {
  const handle = (id: string) => {
    const rec = registry.get(id) ?? registry.getByAgent(id)
    if (!rec) return undefined
    return {
      sessionId: rec.id,
      ...(rec.agentPreset ? { agentPreset: rec.agentPreset } : {}),
    }
  }

  return {
    async create(request) {
      const created = await controller.create(request)
      const found = handle(created.sessionId)
      if (!found) throw new Error(`[plugin-agents] 会话创建后找不到记录：${created.sessionId}`)
      return found
    },

    async ensureSession(request) {
      const created = await controller.create({
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(request.agentPreset ? { agentPreset: request.agentPreset } : {}),
      })
      const found = handle(created.sessionId)
      if (!found) throw new Error(`[plugin-agents] 会话创建后找不到记录：${created.sessionId}`)
      return found
    },

    get(id: string) {
      return handle(String(id || '').trim())
    },
  }
}
