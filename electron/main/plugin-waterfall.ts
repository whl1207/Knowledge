/**
 * plugin-waterfall.ts — 插件拦截链（对齐 DSH 的 `ctx.waterfall` / `approval/request`）
 *
 * ## 为什么需要它
 *
 * DSH 的审批与提问是 **waterfall**：每个回答者要么认领请求（返回结果），要么 `next()`
 * 让给下一个；最后一个回答者是宿主自己的 UI。这样"手机上的插件"可以替桌面回答，
 * 而桌面体验一行不变。
 *
 * AI-KM 原本只有"弹框"这一条路（`plugin-tool-approval` / `requestQuestions`），
 * 插件无法介入。本模块是那条可扩展的链：**后注册先跑**，卸载即撤销。
 *
 * ## 边界（写在这里防以后被放宽）
 *
 * - 只处理"需要人回答"的两类事件：`approval/request`、`user-questions/request`；
 * - handler 抛错向上抛（不静默跳过），因为吞掉审批错误会变成"默认放行"；
 * - `next()` 只能调用一次，重复调用直接 reject；
 * - 本模块**不做 I/O、不 import electron**，可被自测直接钉住。
 */

/** 一个回答者：返回结果 = 认领；调用 next() = 交给下一个（最后是宿主 fallback） */
export type PluginWaterfallHandler = (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>

interface WaterfallEntry {
  readonly pluginId: string
  readonly handler: PluginWaterfallHandler
}

/** event → 处理链（数组头部 = 最后注册 = 最先执行） */
const chains = new Map<string, WaterfallEntry[]>()

/** 注册一个回答者；返回撤销函数（插件卸载时也会被 `clearPluginWaterfalls` 清掉） */
export function registerPluginWaterfall(
  pluginId: string,
  event: string,
  handler: PluginWaterfallHandler,
): () => void {
  const id = String(pluginId || '').trim()
  const name = String(event || '').trim()
  if (!id) throw new Error('[plugin-waterfall] 缺少 pluginId')
  if (!name) throw new Error('[plugin-waterfall] 缺少事件名')
  if (typeof handler !== 'function') throw new Error('[plugin-waterfall] handler 必须是函数')
  const entry: WaterfallEntry = { pluginId: id, handler }
  const list = chains.get(name) ?? []
  list.unshift(entry)
  chains.set(name, list)
  let done = false
  return () => {
    if (done) return
    done = true
    const current = chains.get(name)
    if (!current) return
    const next = current.filter((e) => e !== entry)
    if (next.length) chains.set(name, next)
    else chains.delete(name)
  }
}

/** 插件卸载时清掉它的全部回答者（disposer 已覆盖；这里是兜底，防止泄漏） */
export function clearPluginWaterfalls(pluginId: string): void {
  const id = String(pluginId || '').trim()
  if (!id) return
  for (const [event, list] of Array.from(chains.entries())) {
    const next = list.filter((e) => e.pluginId !== id)
    if (next.length) chains.set(event, next)
    else chains.delete(event)
  }
}

/** 该事件有没有回答者（没有就走原有路径，避免无谓的 Promise 包装） */
export function hasPluginWaterfall(event: string): boolean {
  const list = chains.get(String(event || '').trim())
  return !!list && list.length > 0
}

/** 当前链长度（审计 / 诊断 / 自测） */
export function pluginWaterfallCount(event: string): number {
  return chains.get(String(event || '').trim())?.length ?? 0
}

/**
 * 跑一条链：命中第一个"认领"的 handler 就返回；全部 `next()` 后执行 `fallback`。
 *
 * `fallback` 是宿主自己的回答者（弹框 / 渲染层提问），**永远存在**；因此链为空时
 * 调用方也可以直接用本函数（等价于 fallback）。
 */
export function runPluginWaterfall<T>(
  event: string,
  payload: unknown,
  fallback: () => Promise<T>,
): Promise<T> {
  const list = chains.get(String(event || '').trim()) ?? []
  const dispatch = (index: number): Promise<unknown> => {
    if (index >= list.length) return fallback()
    const entry = list[index]
    let nextCalled = false
    const next = (): Promise<unknown> => {
      if (nextCalled) return Promise.reject(new Error('[plugin-waterfall] next() 只能调用一次'))
      nextCalled = true
      return dispatch(index + 1)
    }
    try {
      return Promise.resolve(entry.handler(payload, next))
    } catch (e) {
      return Promise.reject(e)
    }
  }
  return dispatch(0) as Promise<T>
}
