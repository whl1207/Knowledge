/**
 * events.ts — 界面半边的**观测事件**订阅（对齐 DSH 的 `ctx.remote.$on` + 允许名单）
 *
 * 界面半边看不到宿主事件总线，只能订阅一份**被允许转发**的事件面：工具调用（`tool/call` /
 * `tool/result`）与 agent 输出（`assistant/chunk` 正文增量、`assistant/reasoning` 思维链增量、
 * `agent/tool-args` 工具参数增量、`agent/status` 状态…）。DSH 里这件事由
 * `ctx.remote.$on` + `API_REMOTE_FORWARDED_EVENTS`（"消费者能收到什么的唯一控制点"）完成，
 * 这里由主进程的订阅表 + 作用域过滤完成：**只会收到属于自己的事件**。
 *
 * 两条实现细节值得写下来：
 *
 * 1. **订阅是批量的**：`on()` 只把类型记进待办，微任务里合并成**一次** IPC 调用 ——
 *    否则一个面板注册 6 个事件就是 6 次往返。
 * 2. **一个窗口一份订阅**：宿主按 `webContents.id` 记账；窗口关掉自动退订（主进程侧挂的
 *    `destroyed`）。插件侧只需要管自己的 disposer。
 */

/** 允许订阅的事件类型（与主进程 `SCOPED_PLUGIN_EVENTS` 保持一致；写出常量便于文档与补全） */
export const PLUGIN_EVENT_TYPES = [
  // 工具管线
  'tool/registered',
  'tool/unregistered',
  'tool/pre-execute',
  'tool/post-execute',
  'tool/error',
  // agent 输出与状态
  'agent/status',
  'agent/turn-start',
  'agent/turn-end',
  'agent/step-start',
  'agent/step-end',
  'agent/inbox',
  'assistant/chunk',
  'assistant/reasoning',
  'assistant/message',
  'tool/call',
  'tool/result',
  'agent/tool-args',
  'agent/compaction',
  'agent/notice',
  'agent/error',
] as const

export interface PluginEventsApi {
  /** 是否可用（网页 / 移动端没有主进程转发 → false） */
  readonly available: boolean
  /** 不可用时的原因 */
  readonly reason: string
  /**
   * 订阅一个事件类型，返回退订函数（**注册即副作用、卸载即撤销**，与 ctx 其它注册一致）。
   *
   * 类型必须在允许名单内：不在名单里的类型会**抛错**（而不是静默不触发）——
   * 静默不触发是最难查的一类问题。
   */
  on(type: string, listener: (payload: any) => void): () => void
}

interface EventsApiDeps {
  pluginId: string
  log: { warn(...args: unknown[]): void; info(...args: unknown[]): void }
}

export function createPluginEventsApi(deps: EventsApiDeps): PluginEventsApi {
  const bridge = typeof window !== 'undefined' ? (window as any).aikmDsh?.plugin : null
  const supported =
    typeof bridge?.eventsSubscribe === 'function' && typeof bridge?.onScopedEvent === 'function'
  const reason = supported
    ? ''
    : '界面半边的事件订阅需要桌面端主进程转发（网页 / 移动端没有这条通道）'

  /** 类型 → 监听器集合 */
  const listeners = new Map<string, Set<(payload: any) => void>>()
  /** 已向宿主登记过的类型 */
  const registered = new Set<string>()
  /** 待登记的增量（微任务里合并一次 IPC） */
  let pending: string[] = []
  let flushScheduled = false
  let offPush: (() => void) | null = null
  let disposed = false

  const flush = (): void => {
    flushScheduled = false
    if (disposed || !pending.length) return
    const types = pending
    pending = []
    void bridge
      .eventsSubscribe({ pluginId: deps.pluginId, types })
      .then((res: { types?: string[] }) => {
        for (const t of res?.types ?? types) registered.add(t)
      })
      .catch((e: unknown) => {
        // 订阅失败要**说出来**：否则作者只会看到"事件永远不来"
        deps.log.warn(
          `[plugin:${deps.pluginId}] 订阅事件失败（${types.join(', ')}）：`,
          (e as { message?: string })?.message ?? e,
        )
      })
  }

  const schedule = (type: string): void => {
    if (registered.has(type)) return
    if (!pending.includes(type)) pending.push(type)
    if (!flushScheduled) {
      flushScheduled = true
      queueMicrotask(flush)
    }
  }

  const ensurePush = (): void => {
    if (offPush || !supported) return
    offPush = bridge.onScopedEvent((ev: { pluginId: string; type: string; payload: unknown }) => {
      // 只认自己的：宿主已按作用域过滤，这里再挡一次（多窗口下同一通道是所有插件共用的）
      if (!ev || ev.pluginId !== deps.pluginId) return
      const set = listeners.get(String(ev.type))
      if (!set) return
      for (const listener of Array.from(set)) {
        try {
          listener(ev.payload)
        } catch (e) {
          deps.log.warn(`[plugin:${deps.pluginId}] 事件监听器异常（${ev.type}）：`, e)
        }
      }
    })
  }

  return {
    get available() {
      return supported
    },
    get reason() {
      return reason
    },

    on(type, listener) {
      const t = String(type)
      if (!PLUGIN_EVENT_TYPES.includes(t as (typeof PLUGIN_EVENT_TYPES)[number])) {
        throw new Error(
          `不支持订阅事件 "${t}"。可订阅：${PLUGIN_EVENT_TYPES.join(', ')}`,
        )
      }
      if (!supported) throw new Error(reason)
      ensurePush()
      let set = listeners.get(t)
      if (!set) {
        set = new Set()
        listeners.set(t, set)
      }
      const wrapped = listener as (payload: any) => void
      set.add(wrapped)
      schedule(t)
      return () => {
        set?.delete(wrapped)
        if (!set?.size) listeners.delete(t)
        // 最后一个监听器撤了：告诉宿主退订，别让它继续推
        if (!listeners.has(t) && registered.has(t)) {
          registered.delete(t)
          void bridge?.eventsUnsubscribe?.({ pluginId: deps.pluginId, types: [t] })?.catch?.(() => undefined)
        }
      }
    },
  }
}
