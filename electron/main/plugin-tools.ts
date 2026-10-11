/**
 * plugin-tools.ts — 把插件声明的工具接入统一工具注册表
 *
 * 插件工具一律注册到作用域 `plugin:<id>`（复用 toolRegistry 的作用域分层）：
 * - **不污染全局层**：只有显式带该 scope 的调用方（Agent 预设 / 会话）才看得到；
 * - **禁止与宿主工具重名**：作用域规则是「scope 层先命中」，允许重名会让插件静默遮蔽
 *   宿主工具（如 read_file）——那是 wiring 错误，必须 fail-loud；
 * - **handler 统一包裹**：抛异常与非对象返回值都转成 `{ ok: false }`
 *   （toolRegistry.execute 会把非对象返回值当成功，插件写错 `return` 不能变成"假装成功"）。
 *
 * 审批映射：声明了 `shell` / `fs` 权限的插件，其工具默认 `requiresApproval: true`
 * （`ToolDefinition.requiresApproval` 是既有审批 seam；插件可显式声明 false 覆盖，但设置页会展示权限）。
 */

import { toolRegistry } from '@/shared/toolRegistry'
import { isValidToolName } from '@/types/ids'
import type { PluginId } from '@/types/ids'
import type { PluginLogger, PluginPermission } from '@/types/plugin'
import type { ToolDefinition, ToolResult } from '@/types/tool'

/** 插件工具的注册作用域 */
export function pluginToolScope(id: PluginId | string): string {
  return `plugin:${id}`
}

export interface PluginToolRegistrarOptions {
  id: PluginId
  permissions: PluginPermission[]
  log: PluginLogger
}

/** 生成该插件的工具注册器（每次注册返回 disposer；卸载时工具随之消失） */
export function createPluginToolRegistrar(options: PluginToolRegistrarOptions): (def: ToolDefinition) => () => void {
  const scope = pluginToolScope(options.id)

  return (def: ToolDefinition) => {
    if (!def || typeof def !== 'object') {
      throw new Error('工具定义必须是对象（defineTool(...) 的产物）')
    }
    if (typeof def.name !== 'string' || !isValidToolName(def.name)) {
      throw new Error(`工具名非法（须 snake_case，如 hello_echo）：${String(def.name)}`)
    }
    if (typeof def.description !== 'string' || !def.description.trim()) {
      throw new Error(`工具 ${def.name} 缺少 description（模型靠它决定是否调用）`)
    }
    if (typeof def.handler !== 'function') {
      throw new Error(`工具 ${def.name} 缺少 handler`)
    }
    if (toolRegistry.get(def.name)) {
      throw new Error(`工具名与宿主已有工具重名：${def.name}（插件工具名必须自带前缀，如 ${sanitizePrefix(options.id)}_echo）`)
    }

    const innerHandler = def.handler
    const needsApproval = options.permissions.includes('shell') || options.permissions.includes('fs')

    const wrapped: ToolDefinition = {
      ...def,
      requiresApproval: def.requiresApproval ?? needsApproval,
      handler: async (input, ctx): Promise<ToolResult> => {
        try {
          const result = await innerHandler(input, ctx)
          if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
            return { ok: false, error: `工具 ${def.name} 返回值非法：必须返回 { ok, value?, error? }` }
          }
          return result
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
      },
    }

    const dispose = toolRegistry.register(wrapped, scope)
    options.log.info(`已注册工具 ${def.name}（scope=${scope}${wrapped.requiresApproval ? '，需审批' : ''}）`)

    return () => {
      dispose()
      options.log.info(`已撤销工具 ${def.name}`)
    }
  }
}

/** 由插件 id 推导工具名前缀（`hello-panel` → `hello_panel`） */
function sanitizePrefix(id: string): string {
  return id.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'plugin'
}
