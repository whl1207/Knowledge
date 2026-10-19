/**
 * plugin-events.ts — 插件观测事件的**界面半边通道**
 *
 * ## 对齐 DSH 的哪一块
 *
 * DSH 的客户端半边拿不到宿主事件总线，只能用**声明式**的转发面：
 * `ctx.remote.$on` 配一份允许名单（`API_REMOTE_FORWARDED_EVENTS`，被描述为"消费者能收到什么的唯一控制点"）。
 * 这里做同一件事：客户端只能订阅**允许名单内**的类型（`SCOPED_PLUGIN_EVENTS`），
 * 而且只会收到**属于自己**的事件（作用域判定在主进程的转发点已经做了，这里再按订阅表过滤一次）。
 *
 * ## 三条纪律（照抄文件授权通道的做法）
 *
 * 1. **订阅要显式声明类型**：未知类型直接报错，不静默忽略 —— 否则作者会以为订阅上了。
 * 2. **payload 必须能过结构化克隆**：推送前统一 `toPlainJson`，坏数据只丢这一条、不炸通道。
 * 3. **撤销是几件都要做的**：客户端退订、插件卸载、窗口销毁 —— 任何一条都要能断干净。
 */

import { BrowserWindow, type WebContents } from 'electron'

import { IPCError } from '@/types/ipc'
import { SCOPED_PLUGIN_EVENTS } from '@/shared/pluginContext'
import { registerIpc, toPlainPayload } from './ipc-registry'
import { logInfo } from './log'
import { pluginHost } from './plugin-host'

/** 推送给渲染层的通道名（preload 的 `plugin.onEvent` 订的就是它） */
export const PLUGIN_EVENT_CHANNEL = 'plugin:event'

/** pluginId → webContentsId → 订阅的事件类型集合 */
const subs = new Map<string, Map<number, Set<string>>>()

/** 该插件在某窗口上订阅的类型（供转发时快速判断） */
function typesFor(pluginId: string, wcId: number): Set<string> | undefined {
  return subs.get(pluginId)?.get(wcId)
}

/**
 * 把一条**已按作用域判定过归属**的观测事件推给订阅了它的窗口。
 *
 * 由 `plugin-host` 的 scoped 观察钩子调用（工具事件与 agent 事件都走这里）。
 */
export function forwardPluginEvent(pluginId: string, type: string, payload: unknown): void {
  const byWindow = subs.get(pluginId)
  if (!byWindow || !byWindow.size) return
  if (!SCOPED_PLUGIN_EVENTS.includes(type)) return
  // 插件已经卸载：订阅一并作废。
  // 这里**懒清理**是刻意的：让卸载路径反向 import 本模块会与 plugin-host 成环。
  if (!pluginHost.get(pluginId)) {
    subs.delete(pluginId)
    return
  }
  let plain: unknown
  try {
    plain = toPlainPayload(payload)
  } catch {
    return // 折不动就丢这一条：观测面不该因为一条坏载荷把通道打断
  }
  for (const [wcId, types] of byWindow) {
    if (!types.has(type)) continue
    const wc: WebContents | undefined = BrowserWindow.getAllWindows()
      .map((w) => w.webContents)
      .find((c) => c.id === wcId && !c.isDestroyed())
    if (!wc) {
      byWindow.delete(wcId)
      continue
    }
    try {
      wc.send(PLUGIN_EVENT_CHANNEL, { pluginId, type, payload: plain })
    } catch (e) {
      console.warn(`[plugin-events] 推送失败（${pluginId} / ${type}）:`, e)
    }
  }
  if (!byWindow.size) subs.delete(pluginId)
}

/** 插件卸载时清掉它的全部订阅（否则重装会继承上一份代码的订阅） */
export function clearPluginEventSubs(pluginId: string): boolean {
  return subs.delete(String(pluginId || '').trim())
}

/** 测试 / 审计用：当前订阅总数 */
export function pluginEventSubCount(): number {
  let n = 0
  for (const byWindow of subs.values()) for (const types of byWindow.values()) n += types.size
  return n
}

export function registerPluginEventsIpc(): void {
  /**
   * 订阅观测事件。`types` 必须落在允许名单内 —— 未知类型**报错**而不是静默忽略：
   * 静默忽略会让作者以为"订阅成功了但事件没发生"，那是最难查的一类问题。
   */
  registerIpc('plugin:events:subscribe', (payload, event) => {
    const pluginId = String(payload?.pluginId ?? '').trim()
    if (!pluginId) throw new IPCError('INVALID_ARGUMENT', '缺少 pluginId')
    if (!pluginHost.get(pluginId)) throw new IPCError('NOT_FOUND', `插件未装载：${pluginId}`)
    const raw = Array.isArray(payload?.types) ? payload.types.map((t: unknown) => String(t)) : []
    if (!raw.length) throw new IPCError('INVALID_ARGUMENT', 'types 不能为空')
    const unknown = raw.filter((t: string) => !SCOPED_PLUGIN_EVENTS.includes(t))
    if (unknown.length) {
      throw new IPCError(
        'INVALID_ARGUMENT',
        `不支持订阅这些事件类型：${unknown.join(', ')}（可订阅：${SCOPED_PLUGIN_EVENTS.join(', ')}）`,
      )
    }
    const wcId = event?.sender?.id
    if (typeof wcId !== 'number') throw new IPCError('INVALID_ARGUMENT', '缺少窗口上下文')
    let byWindow = subs.get(pluginId)
    if (!byWindow) {
      byWindow = new Map()
      subs.set(pluginId, byWindow)
    }
    let types = byWindow.get(wcId)
    if (!types) {
      types = new Set()
      byWindow.set(wcId, types)
      // 窗口关了就自动退订：否则会把事件推给一个已销毁的 webContents
      event.sender.once('destroyed', () => {
        const m = subs.get(pluginId)
        m?.delete(wcId)
        if (m && !m.size) subs.delete(pluginId)
      })
    }
    for (const t of raw) types.add(t)
    logInfo('main', `[plugin-events] [audit] ${pluginId} 订阅 ${Array.from(types).join(', ')}`)
    return { pluginId, types: Array.from(types) }
  })

  /** 退订（不传 types = 全退）。客户端卸载半边时会调。 */
  registerIpc('plugin:events:unsubscribe', (payload, event) => {
    const pluginId = String(payload?.pluginId ?? '').trim()
    if (!pluginId) throw new IPCError('INVALID_ARGUMENT', '缺少 pluginId')
    const wcId = event?.sender?.id
    const byWindow = subs.get(pluginId)
    if (!byWindow || typeof wcId !== 'number') return { pluginId, types: [] as string[] }
    const types = byWindow.get(wcId)
    if (!types) return { pluginId, types: [] as string[] }
    const raw = Array.isArray(payload?.types) ? payload.types.map((t: unknown) => String(t)) : []
    if (raw.length) for (const t of raw) types.delete(t)
    else types.clear()
    if (!types.size) byWindow.delete(wcId)
    if (!byWindow.size) subs.delete(pluginId)
    return { pluginId, types: Array.from(types) }
  })
}

/**
 * 把 plugin-host 的 scoped 事件接到界面半边通道上。
 * 应用启动时调用一次（与 `setAgentBroadcast` 的接线并列）。
 */
export function attachPluginEventForwarding(): void {
  pluginHost.observeScopedEvents((pluginId, type, payload) => {
    forwardPluginEvent(pluginId, type, payload)
  })
}

/** 由卸载路径或测试调用（`forwardPluginEvent` 已做懒清理；这里是显式入口） */
export function clearPluginEventSubsFor(pluginId: string): boolean {
  return clearPluginEventSubs(pluginId)
}

/** 供 `typesFor` 的单测使用 */
export function subscribedTypes(pluginId: string, wcId: number): string[] {
  return Array.from(typesFor(pluginId, wcId) ?? [])
}
