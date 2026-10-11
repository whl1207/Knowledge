/**
 * pluginContext.ts — 插件上下文容器（对齐 Cordis 的 ctx 语义，但不引入 Cordis）
 *
 * 只保留两条语义：
 * 1. **注册即副作用、卸载即撤销**：`ctx.tool / ctx.service / ctx.on / ctx.effect` 全部登记到
 *    同一份 disposer 列表，`dispose()` 时**按注册顺序逆序**执行（Cordis fiber 的 dispose 语义）；
 * 2. **服务依赖**：`PluginServiceRegistry` 提供命名服务，宿主用 onChange 通知「服务集合变化」，
 *    让停在 pending 的插件有机会装载（依赖驱动加载）。
 *
 * 主进程与渲染进程共用（无 node/DOM 依赖，宿主能力通过 deps 注入）。
 */

import type { PluginId } from '@/types/ids'
import type { ToolDefinition } from '@/types/tool'
import type {
  HostEventMap,
  PluginContext,
  PluginHostApi,
  PluginLogger,
  PluginStorage,
} from '@/types/plugin'

// ---------------------------------------------------------------------------
// 服务注册表
// ---------------------------------------------------------------------------

/**
 * 命名服务注册表。
 * 宿主内置服务（tools / sessionLog / jobs …）与插件提供的服务共用一张表；
 * 服务名重复直接抛错（fail-loud，避免「后注册者静默覆盖」）。
 */
export class PluginServiceRegistry {
  private services = new Map<string, unknown>()
  private listeners = new Set<() => void>()

  constructor(initial?: Record<string, unknown>) {
    if (initial) {
      for (const [name, impl] of Object.entries(initial)) this.services.set(name, impl)
    }
  }

  /** 注册服务；返回注销函数。重复注册抛错。 */
  provide<T = unknown>(name: string, impl: T): () => void {
    if (!name || typeof name !== 'string') throw new Error('[plugin] 服务名必填')
    if (this.services.has(name)) throw new Error(`[plugin] 服务已注册: ${name}`)
    this.services.set(name, impl)
    this.notify()
    return () => {
      if (this.services.delete(name)) this.notify()
    }
  }

  get<T = unknown>(name: string): T | undefined {
    return this.services.get(name) as T | undefined
  }

  has(name: string): boolean {
    return this.services.has(name)
  }

  /** 当前已提供的服务名（排序后，供设置页与 pending 派发） */
  list(): string[] {
    return Array.from(this.services.keys()).sort()
  }

  /** 服务集合变化订阅（宿主据此重试 pending 插件） */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener()
      } catch (e) {
        console.error('[plugin] 服务变化监听器异常:', e)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 宿主事件总线
// ---------------------------------------------------------------------------

/**
 * 最小类型化事件总线（宿主侧）。
 * 单个监听器抛异常只记日志，绝不让异常穿透——插件的一个错误监听器不得影响宿主与其他插件。
 */
export class PluginEventBus {
  private listeners = new Map<string, Set<(ev: unknown) => void>>()

  on<T extends keyof HostEventMap>(type: T, listener: (ev: HostEventMap[T]) => void): () => void {
    const key = String(type)
    let set = this.listeners.get(key)
    if (!set) {
      set = new Set()
      this.listeners.set(key, set)
    }
    const wrapped = listener as (ev: unknown) => void
    set.add(wrapped)
    return () => {
      set?.delete(wrapped)
    }
  }

  emit<T extends keyof HostEventMap>(type: T, ev: HostEventMap[T]): void {
    const set = this.listeners.get(String(type))
    if (!set) return
    for (const listener of Array.from(set)) {
      try {
        listener(ev)
      } catch (e) {
        console.error(`[plugin] 事件监听器异常 (${String(type)}):`, e)
      }
    }
  }

  /** 卸载某插件时清理其全部监听（disposer 已覆盖；此处用于兜底统计） */
  listenerCount(): number {
    let n = 0
    for (const set of this.listeners.values()) n += set.size
    return n
  }
}

// ---------------------------------------------------------------------------
// 上下文工厂
// ---------------------------------------------------------------------------

/**
 * 上下文只依赖「提供/读取服务」两项能力（不绑定具体注册表实现），
 * 便于宿主注入按插件记账的包装层（记录该插件提供了哪些服务）。
 */
export interface PluginServiceAccess {
  provide<T = unknown>(name: string, impl: T): () => void
  get<T = unknown>(name: string): T | undefined
}

export interface PluginContextDeps {
  id: PluginId
  name: string
  version: string
  dir: string
  /** 用户配置（宿主持久化；只读视图） */
  config: Record<string, unknown>
  services: PluginServiceAccess
  /** 由 plugin-tools 提供的注册器（含作用域与审批映射） */
  registerTool: (def: ToolDefinition) => () => void
  /** 宿主事件订阅（由 PluginEventBus 提供） */
  subscribeHostEvent: <T extends keyof HostEventMap>(
    type: T,
    listener: (ev: HostEventMap[T]) => void,
  ) => () => void
  host: PluginHostApi
  storage: PluginStorage
  log: PluginLogger
}

export interface PluginContextHandle {
  ctx: PluginContext
  /** 逆序撤销该插件的全部注册（幂等；错误只记日志，不中断卸载流程） */
  dispose: () => Promise<void>
}

export function createPluginContext(deps: PluginContextDeps): PluginContextHandle {
  const disposers: Array<() => void | Promise<void>> = []
  let disposed = false

  const track = (disposer: () => void | Promise<void>): (() => void) => {
    if (disposed) {
      // ctx 已失效：立即撤销，避免卸载后才注册的副作用泄漏
      void safeRun(disposer, deps)
      return () => {}
    }
    disposers.push(disposer)
    return () => {
      const index = disposers.indexOf(disposer)
      if (index !== -1) disposers.splice(index, 1)
      void safeRun(disposer, deps)
    }
  }

  const ctx: PluginContext = {
    plugin: { id: deps.id, name: deps.name, version: deps.version, dir: deps.dir },
    config: deps.config,

    tool(def: ToolDefinition) {
      return track(deps.registerTool(def))
    },

    service<T = unknown>(name: string, impl: T) {
      return track(deps.services.provide(name, impl))
    },

    getService<T = unknown>(name: string) {
      return deps.services.get<T>(name)
    },

    on<T extends keyof HostEventMap>(type: T, listener: (ev: HostEventMap[T]) => void) {
      return track(deps.subscribeHostEvent(type, listener))
    },

    effect(fn: () => void | (() => void | Promise<void>)) {
      const cleanup = fn()
      if (typeof cleanup !== 'function') return () => {}
      let done = false
      return track(async () => {
        if (done) return
        done = true
        await cleanup()
      })
    },

    host: deps.host,
    storage: deps.storage,
    log: deps.log,
  }

  const dispose = async (): Promise<void> => {
    disposed = true
    // 逆序撤销：后注册的先撤销（对齐 Cordis dispose 顺序）
    for (const disposer of disposers.splice(0).reverse()) {
      await safeRun(disposer, deps)
    }
  }

  return { ctx, dispose }
}

/** 执行 disposer 并吞掉异常（卸载流程必须走完；单个清理失败不影响其余注册的撤销） */
async function safeRun(disposer: () => void | Promise<void>, deps: PluginContextDeps): Promise<void> {
  try {
    await disposer()
  } catch (e) {
    deps.log.error(`撤销注册失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}
