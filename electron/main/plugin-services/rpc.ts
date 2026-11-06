/**
 * rpc.ts — `ctx.rpcHost`（主进程半边，P3）
 *
 * 注册一个可被**本插件界面半边**调用的方法。界面半边的 `ctx.rpc.call` 经
 * `plugin:rpc:call` 进 `plugin-rpc-registry`，只能命中自己插件的方法。
 */

import type { PluginRpcHostService } from '@/shared/pluginServices'
import { registerPluginRpc } from '../plugin-rpc-registry'

export function createRpcHostService(pluginId: string): PluginRpcHostService {
  return {
    handle(method: string, handler: (args: unknown) => unknown | Promise<unknown>): () => void {
      return registerPluginRpc(pluginId, method, handler)
    },
  }
}
