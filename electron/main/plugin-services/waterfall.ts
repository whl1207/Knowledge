/**
 * waterfall.ts — `ctx.waterfall` 的实现（P2）
 *
 * 只做一件事：把这个插件的回答者登记进全局拦截链；卸载时由宿主统一清掉
 * （`clearPluginWaterfalls`），所以插件作者不需要自己记 disposer。
 */

import type { PluginWaterfallService } from '@/shared/pluginServices'
import {
  registerPluginWaterfall,
  type PluginWaterfallHandler,
} from '../plugin-waterfall'

export function createWaterfallService(pluginId: string): PluginWaterfallService {
  return {
    on<T = unknown>(event: string, handler: (payload: T, next: () => Promise<T>) => Promise<T>): () => void {
      return registerPluginWaterfall(pluginId, event, handler as unknown as PluginWaterfallHandler)
    },
  }
}
