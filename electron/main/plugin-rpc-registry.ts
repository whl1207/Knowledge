/**
 * plugin-rpc-registry.ts — 插件「界面半边 → 自己主进程半边」的方法表（P3）
 *
 * 只允许调**本插件自己**注册的方法：插件拿不到通用 IPC，也不能借这个通道调别人的服务。
 * 参数/返回值由 IPC 层做结构化克隆，这里只负责查找与调用。
 */

import { PluginServiceError } from '@/shared/pluginServices'

type RpcHandler = (args: unknown) => unknown | Promise<unknown>

const handlers = new Map<string, Map<string, RpcHandler>>()

export function registerPluginRpc(pluginId: string, method: string, handler: RpcHandler): () => void {
  const id = String(pluginId || '').trim()
  const name = String(method || '').trim()
  if (!id) throw new PluginServiceError('PLUGIN_INVALID_ARGUMENT', '缺少 pluginId', { service: 'rpcHost' })
  if (!name) throw new PluginServiceError('PLUGIN_INVALID_ARGUMENT', '缺少方法名', { service: 'rpcHost' })
  if (typeof handler !== 'function') {
    throw new PluginServiceError('PLUGIN_INVALID_ARGUMENT', 'handler 必须是函数', { service: 'rpcHost' })
  }
  let table = handlers.get(id)
  if (!table) {
    table = new Map()
    handlers.set(id, table)
  }
  if (table.has(name)) {
    throw new PluginServiceError('PLUGIN_CONFLICT', `方法已注册：${name}`, { service: 'rpcHost' })
  }
  table.set(name, handler)
  return () => {
    const current = handlers.get(id)
    if (!current) return
    if (current.get(name) === handler) current.delete(name)
    if (!current.size) handlers.delete(id)
  }
}

/** 插件卸载时清掉它的全部方法（disposer 已覆盖；这里是兜底） */
export function clearPluginRpcs(pluginId: string): void {
  handlers.delete(String(pluginId || '').trim())
}

export function pluginRpcMethods(pluginId: string): string[] {
  return Array.from(handlers.get(String(pluginId || '').trim())?.keys() ?? []).sort()
}

export async function callPluginRpc(pluginId: string, method: string, args?: unknown): Promise<unknown> {
  const id = String(pluginId || '').trim()
  const name = String(method || '').trim()
  const handler = handlers.get(id)?.get(name)
  if (!handler) {
    throw new PluginServiceError('PLUGIN_NOT_FOUND', `插件 ${id} 没有注册方法：${name}`, { service: 'rpc' })
  }
  return await handler(args)
}
