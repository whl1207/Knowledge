/**
 * clientEventBus.ts — 渲染层插件事件总线（宿主 → 插件半边 / 插件之间）
 *
 * 单独成模块（原先内联在 runtime.ts 里）的原因有两个：
 *  1. **可测**：`runtime.ts` 牵着 Vue / 平台桥一大串依赖，没法在 Node 下直接单测，于是
 *     "重载会不会多出一个监听器"这种问题只能靠人读代码；抽出来后
 *     `src/lib/plugin/clientEventBus.selftest.ts` 可以**行为级**验证不变式。
 *  2. **逼出正确的形状**：本类**没有**、也不该有"按插件 id 分桶"的概念。
 *
 * ## 两个不变式（泄漏之所以"按构造不会发生"，全靠它们）
 *
 * **I1（emit 不建条目）**：`emit` 只读 `listeners`，找不到就返回；只有 `on` 才创建 Set。
 *   ⇒ 插件用任意 topic 名 `emit` 都不会把注册表撑大（否则 `emit(\`${id}/${n}\`)` 里 n 递增就是内存泄漏）。
 *
 * **I2（on 的撤销是精确的）**：`on` 返回的闭包只删自己那一个 listener。
 *   ⇒ 只要调用方走 `ctx.on`（runtime.ts 里是 `track(bus.on(...))`），插件卸载/重载时按注册逆序
 *     dispose，监听器数必然复原：**重载 N 次不加一个监听器**。
 *
 * 反过来，如果哪天有人为了"按插件过滤"在这里加一张 `Map<pluginId, Set<topic>>`，I2 就不再是
 * 结构性质而变成需要人工维护的约定 —— 那正是要避免的写法。过滤应当发生在**事件名**上
 * （`emit(`${senderId}/${topic}`, payload)`），而不是发生在注册表的键上。
 */

export type ClientEventListener = (payload: unknown) => void

export class ClientEventBus {
  private listeners = new Map<string, Set<ClientEventListener>>()

  /** 订阅某类事件；返回**只移除这一个**监听器的撤销函数（幂等） */
  on(type: string, listener: ClientEventListener): () => void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
    let done = false
    return () => {
      if (done) return
      done = true
      set?.delete(listener)
      // 空桶顺手回收：否则「注册过又撤销」的 topic 会永远留一个空 Set
      if (set && set.size === 0 && this.listeners.get(type) === set) this.listeners.delete(type)
    }
  }

  /** 广播（同步）。单个监听器抛错只记日志，绝不打断其余监听器，也绝不冒泡给宿主。 */
  emit(type: string, payload: unknown): void {
    const set = this.listeners.get(type)
    if (!set) return // I1：不创建条目
    for (const listener of Array.from(set)) {
      try {
        listener(payload)
      } catch (e) {
        console.error(`[plugin-runtime] 事件监听器异常 (${type}):`, e)
      }
    }
  }

  /**
   * 存活监听器数（`type` 省略 = 全部）。
   * 只给自测与诊断用 —— 生产代码不该依赖它。
   */
  listenerCount(type?: string): number {
    if (type !== undefined) return this.listeners.get(type)?.size ?? 0
    let n = 0
    for (const set of this.listeners.values()) n += set.size
    return n
  }

  /** 存活 topic 桶数量（自测用：验证 I1 —— 空桶不该残留、emit 不该创建桶） */
  topicCount(): number {
    return this.listeners.size
  }
}
