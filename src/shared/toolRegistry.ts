/**
 * toolRegistry.ts — 统一工具注册表 + pre/execute/post 执行管线
 *
 * 借鉴 DeepSeek-Harness 工具子系统（docs/subsystems/tools.md）：
 * - **作用域化注册**：`register(def, scope?)` 按 scope 分层（host 层 + 每
 *   agent/preset 层）；读取时合并全局层与调用方作用域，最近层同名条目胜出；
 *   注册返回 disposer（对齐"注册即副作用、卸载即撤销"）；
 * - **把关的执行管线**：`pre-execute → execute → post-execute`。pre 钩子可
 *   改写入参、短路跳过 handler；post 钩子可改写结果；handler 抛异常统一转
 *   成 `{ ok: false }`，绝不把异常当成功；
 * - **事件**：`tool/pre-execute` / `tool/post-execute` / `tool/error` 携带
 *   快照，供审计、审批与 UI 使用；
 * - 主进程与渲染进程共用本文件（无 DOM 依赖）；主进程在
 *   `electron/main/tools.ts` 注册核心工具。
 *
 * 统一执行入口：`execute(name, input, ctx)` —— 所有技能步骤 / 工作流节点 /
 * agent 循环的工具调用都应汇聚到这里，消灭"每处一套执行逻辑"。
 */

import { brand, isValidToolName, type ToolName } from '@/types/ids'
import {
  type ToolDefinition,
  type ToolResult,
  type ToolExecutionContext,
  type ToolPreHook,
  type ToolPostHook,
  type ToolRegistryEvent,
  type ToolRegistryEventMap,
  type ToolRegistrySnapshot,
} from '@/types/tool'

// ---------------------------------------------------------------------------
// 最小类型化事件发射器
// ---------------------------------------------------------------------------

type Listener<E> = (event: E) => void

class TinyEmitter {
  private listeners = new Map<string, Set<(event: ToolRegistryEvent) => void>>()

  on(type: keyof ToolRegistryEventMap | string, listener: (event: ToolRegistryEvent) => void): () => void {
    let set = this.listeners.get(type as string)
    if (!set) {
      set = new Set()
      this.listeners.set(type as string, set)
    }
    set.add(listener)
    return () => set.delete(listener)
  }

  emit(event: ToolRegistryEvent): void {
    const set = this.listeners.get(event.type as string)
    if (!set) return
    for (const listener of Array.from(set)) {
      try {
        listener(event)
      } catch (e) {
        console.error(`[toolRegistry] 事件监听器异常 (${String(event.type)}):`, e)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 工具注册表
// ---------------------------------------------------------------------------

const GLOBAL_SCOPE = '__global__'

export class ToolRegistry {
  private global = new Map<ToolName, ToolDefinition>()
  private scoped = new Map<string, Map<ToolName, ToolDefinition>>()
  private preHooks: ToolPreHook[] = []
  private postHooks: ToolPostHook[] = []
  private emitter = new TinyEmitter()

  // ---------------- 注册 ----------------

  /**
   * 注册工具（可带作用域）。返回 disposer：注销该工具并撤销其副作用。
   * 作用域规则：无 scope → 全局层；有 scope → 该 agent/preset 的层。
   */
  register(def: ToolDefinition, scope?: string): () => void {
    if (!def?.name) throw new Error('[toolRegistry] 工具缺少 name')
    if (!isValidToolName(def.name)) {
      throw new Error(`[toolRegistry] 非法工具名（须 snake_case）: ${def.name}`)
    }
    const layer = scope ? this.layer(scope) : this.global
    if (layer.has(def.name)) {
      throw new Error(`[toolRegistry] 工具已注册: ${def.name}${scope ? ` (scope=${scope})` : ''}`)
    }
    layer.set(def.name, def)
    this.emitter.emit({ type: 'tool/registered', name: def.name, scope })
    return () => {
      layer.delete(def.name)
      this.emitter.emit({ type: 'tool/unregistered', name: def.name, scope })
    }
  }

  /** 注销工具（等价于调用 register 返回的 disposer） */
  unregister(name: string, scope?: string): void {
    const layer = scope ? this.scoped.get(scope) : this.global
    layer?.delete(name as ToolName)
  }

  // ---------------- 查询 ----------------

  /**
   * 读取工具：先查调用方作用域层（含链上最近层），再回退全局层。
   * 同名字段在同一层内禁止重复注册（register 时即拒绝）。
   */
  get(name: string, scope?: string): ToolDefinition | undefined {
    const n = name as ToolName
    if (scope) {
      const scopedDef = this.scoped.get(scope)?.get(n)
      if (scopedDef) return scopedDef
    }
    return this.global.get(n)
  }

  /** 列出可见工具（合并作用域层 + 全局层，按名排序） */
  list(scope?: string): ToolDefinition[] {
    const byName = new Map<ToolName, ToolDefinition>()
    if (scope) {
      for (const [name, def] of this.scoped.get(scope) ?? []) {
        byName.set(name, def)
      }
    }
    for (const [name, def] of this.global) {
      if (!byName.has(name)) byName.set(name, def)
    }
    return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 只读快照（供 IPC 序列化与 UI） */
  snapshot(scope?: string): ToolRegistrySnapshot[] {
    return this.list(scope).map((d) => ({
      name: d.name,
      description: d.description,
      scope,
      hasInputSchema: !!d.inputSchema,
    }))
  }

  // ---------------- 管线钩子 ----------------

  /** 注册 pre-execute 钩子（可改写 input / 短路 / 拒绝）；返回 disposer */
  addPreHook(hook: ToolPreHook): () => void {
    this.preHooks.push(hook)
    return () => {
      this.preHooks = this.preHooks.filter((h) => h !== hook)
    }
  }

  /** 注册 post-execute 钩子（可改写结果）；返回 disposer */
  addPostHook(hook: ToolPostHook): () => void {
    this.postHooks.push(hook)
    return () => {
      this.postHooks = this.postHooks.filter((h) => h !== hook)
    }
  }

  // ---------------- 事件 ----------------

  on<K extends keyof ToolRegistryEventMap>(
    type: K,
    listener: (event: ToolRegistryEvent & { type: K }) => void,
  ): () => void {
    return this.emitter.on(type, listener as (event: ToolRegistryEvent) => void)
  }

  // ---------------- 执行管线 ----------------

  /**
   * 统一执行入口：
   *   pre-execute 钩子（按注册序，可短路）→ handler → post-execute 钩子。
   * - 工具不存在 → `{ ok: false, error: 'UNKNOWN_TOOL' }`（fail-loud）；
   * - handler 抛异常 → 捕获并转为 `{ ok: false }`（绝不冒充成功）；
   * - 支持 AbortSignal（ctx.signal），handler 自行响应取消。
   */
  async execute(name: string, input: any, ctx: ToolExecutionContext = {}): Promise<ToolResult> {
    const def = this.get(name, ctx.scope)
    if (!def) {
      const result: ToolResult = { ok: false, error: `未知工具: ${name}` }
      this.emitter.emit({ type: 'tool/error', name: name as ToolName, error: result.error! })
      return result
    }

    // ---- pre-execute 阶段 ----
    let currentInput = input
    for (const hook of this.preHooks) {
      const out = await hook({ name: def.name, input: currentInput, ctx })
      if (out && typeof out === 'object') {
        if ('skip' in out && out.skip) {
          const shortCircuit: ToolResult = out.result ?? { ok: true, value: null }
          this.emitter.emit({
            type: 'tool/pre-execute',
            name: def.name,
            input: currentInput,
            ctx: { ...ctx },
          })
          this.emitter.emit({
            type: 'tool/post-execute',
            name: def.name,
            input: currentInput,
            ctx: { ...ctx },
            result: shortCircuit,
          })
          return shortCircuit
        }
        if ('input' in out && out.input !== undefined) currentInput = out.input
      }
    }
    this.emitter.emit({ type: 'tool/pre-execute', name: def.name, input: currentInput, ctx: { ...ctx } })

    // ---- execute 阶段 ----
    let result: ToolResult
    try {
      result = await def.handler(currentInput, ctx)
    } catch (err: any) {
      result = {
        ok: false,
        error: err?.message || String(err),
      }
    }
    if (!result || typeof result !== 'object') {
      result = { ok: true, value: result }
    }
    if (result.ok === undefined) result = { ...result, ok: true }

    // ---- post-execute 阶段 ----
    for (const hook of this.postHooks) {
      const out = await hook({ name: def.name, input: currentInput, ctx, result })
      if (out && typeof out === 'object') result = out
    }
    this.emitter.emit({
      type: 'tool/post-execute',
      name: def.name,
      input: currentInput,
      ctx: { ...ctx },
      result: { ...result },
    })
    if (!result.ok) {
      this.emitter.emit({ type: 'tool/error', name: def.name, error: result.error || '工具执行失败' })
    }
    return result
  }

  // ---------------- 内部 ----------------

  private layer(scope: string): Map<ToolName, ToolDefinition> {
    let m = this.scoped.get(scope)
    if (!m) {
      m = new Map()
      this.scoped.set(scope, m)
    }
    return m
  }
}

/** 全局单例（主进程与渲染进程共享同一注册表语义；进程内各自实例） */
export const toolRegistry = new ToolRegistry()

/** 便捷构造工具定义（省去手写 handler 签名） */
export function defineTool(
  name: string,
  description: string,
  handler: ToolDefinition['handler'],
  extra: Partial<Omit<ToolDefinition, 'name' | 'description' | 'handler'>> = {},
): ToolDefinition {
  return { name: brand(name), description, handler, ...extra }
}
