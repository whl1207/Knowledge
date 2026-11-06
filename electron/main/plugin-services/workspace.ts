/**
 * workspace.ts — `ctx.workspaceRegistry`（P4 最小实现，支持插件自己的目录）
 *
 * AI-KM 没有 DSH 那种"跨项目工作区分组"。这里把**插件数据目录**当成工作区根：
 * - `resolveByPath(p)` / `create(p)` 接受根目录及其子目录，返回一个稳定的工作区句柄；
 * - 工作区 id 由路径哈希得到（同一路径永远同一个 id），标题可在内存里改；
 * - 根目录之外一律拒绝（不把任意宿主目录变成插件会话的 cwd）。
 *
 * 为什么不是只有一个固定工作区：微信插件把自己的工作区放在 `<home>/dsh_wechat`，
 * 与默认的 `<home>/workspace` 不同；早先只认 `workspace` 会让首条消息直接失败。
 */

import { createHash } from 'node:crypto'
import * as path from 'node:path'
import { PluginServiceError } from '@/shared/pluginServices'
import type { PluginWorkspaceRegistryService, Workspace } from '@/shared/pluginServices'

export function createWorkspaceRegistry(root: string): PluginWorkspaceRegistryService {
  const base = path.resolve(root)
  const byId = new Map<string, Workspace>()
  const byPath = new Map<string, Workspace>()

  const isInside = (abs: string): boolean => abs === base || abs.startsWith(`${base}${path.sep}`)

  const ensure = (target: string): Workspace | undefined => {
    const abs = path.resolve(String(target || ''))
    if (!isInside(abs)) return undefined
    const existing = byPath.get(abs)
    if (existing) return existing
    const id = `plugin-ws-${createHash('sha1').update(abs).digest('hex').slice(0, 10)}`
    let title = abs === base ? '插件工作区' : path.basename(abs)
    const workspace: Workspace = {
      id,
      path: abs,
      get title(): string {
        return title
      },
      async setTitle(next: string): Promise<void> {
        const text = String(next || '').trim()
        if (text) title = text
      },
    }
    byId.set(id, workspace)
    byPath.set(abs, workspace)
    return workspace
  }

  // 根工作区先建出来，`list()` 首帧就有东西
  ensure(base)

  return {
    list(): readonly Workspace[] {
      return Array.from(byPath.values())
    },
    get(id: string): Workspace | undefined {
      return byId.get(String(id || ''))
    },
    async resolveByPath(target: string): Promise<Workspace | undefined> {
      return ensure(target)
    },
    async create(target: string): Promise<Workspace> {
      const workspace = ensure(target)
      if (!workspace) {
        throw new PluginServiceError(
          'PLUGIN_UNSUPPORTED',
          `工作区必须在插件数据目录内：${base}（收到 ${String(target)}）`,
          { service: 'workspaceRegistry' },
        )
      }
      return workspace
    },
    archivedSessionIds: [],
  }
}
