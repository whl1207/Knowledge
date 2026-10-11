/**
 * slots.ts — 槽位注册表（P1 工作台内核）
 *
 * 语义照搬 DSH 的 `dsh-client-ui-slots`，只保留在 Vue 产品里真正有用的部分：
 * - **声明即认领**：只有先 `declare(slot)` 之后，才能向该槽位注册条目；
 * - **加载期即报错**：注册未声明的槽位、同槽位重复 key、kind 不匹配、`chain` 缺 `select`
 *   一律抛错（不做静默降级——这类问题是接线错误，不是用户错误）；
 * - **生命周期成对**：`declare` 返回句柄，句柄的 `dispose()` 会递归移除
 *   它声明的子槽位与注册进去的条目（对齐「注册即副作用、卸载即撤销」）；
 * - **纯逻辑无框架依赖**：本文件不 import vue / DOM，便于在 Node 下直接单测
 *   （见 scripts/plugin-smoke）与将来复用到其他载体；Vue 响应式桥接在 useSlots.ts。
 */

import { CORE_PLUGIN_SLOTS, SLOT_META_TARGET, type PluginSlotKind } from '@/shared/pluginSlots'

/** 槽位条目：一个可渲染的扩展点贡献 */
export interface SlotDefinition {
  /** 槽位内唯一 key（重复注册直接抛错） */
  key: string
  /** 必须与所属槽位声明的 kind 一致（声明处是唯一事实源） */
  kind?: PluginSlotKind
  /** 展示名（keyed 槽位必填，用于导航 / 页签） */
  titleZh?: string
  titleEn?: string
  /** 图标类名（如 `fa fa-puzzle-piece`） */
  icon?: string
  /** 排序：list 按此升序；未提供视为 0 */
  order?: number
  /** chain 用：优先级升序，第一个 select 命中者胜出 */
  priority?: number
  /** 渲染组件（keyed/list/single 必填；纯声明型条目可省略） */
  component?: unknown
  /** chain 用：是否认领当前 owner（返回 true 即渲染本条目） */
  select?: (owner: unknown) => boolean
  /** 条件显示：返回 false 则本轮不参与（owner 相关时可用） */
  when?: (owner: unknown) => boolean
  /** 贡献者标识：`core` 或 `plugin:<id>`（诊断与卸载用） */
  owner?: string
  /** 扩展元数据（keepAlive / group / passOwner …，键名常量见 shared/pluginSlots.ts） */
  meta?: Record<string, unknown>
}

/** 只读槽位快照（设置页诊断用） */
export interface SlotSnapshot {
  slot: string
  kind: PluginSlotKind
  entries: Array<{ key: string; owner: string; hasComponent: boolean; title?: string }>
}

interface EntryRecord {
  def: SlotDefinition
  /** 注册顺序（同 order/priority 时保持稳定排序） */
  seq: number
  /** 该条目声明的子槽位（递归撤销） */
  childScopes: SlotHandleImpl[]
}

interface ScopeRecord {
  name: string
  kind: PluginSlotKind
  entries: EntryRecord[]
  childScopes: SlotHandleImpl[]
  parent: SlotHandleImpl | null
  disposed: boolean
}

let seqCounter = 0

/** `declare` 返回的句柄：注册条目 / 声明子槽位 / 一次性撤销 */
export class SlotHandleImpl {
  constructor(private readonly scope: ScopeRecord) {}

  get name(): string {
    return this.scope.name
  }

  get kind(): PluginSlotKind {
    return this.scope.kind
  }

  get disposed(): boolean {
    return this.scope.disposed
  }

  /** 向本槽位注册条目；返回 disposer（只移除该条目） */
  register(def: SlotDefinition): () => void {
    if (this.scope.disposed) {
      throw new Error(`[slots] 槽位 ${this.scope.name} 已撤销，不能再注册条目（${String(def?.key)}）`)
    }
    validateEntry(this.scope, def)
    const record: EntryRecord = { def: { ...def }, seq: seqCounter++, childScopes: [] }
    this.scope.entries.push(record)
    slotRegistry.notify()
    return () => {
      const index = this.scope.entries.indexOf(record)
      if (index === -1) return
      this.scope.entries.splice(index, 1)
      // 条目下的子槽位随条目一起撤销（递归）
      for (const child of record.childScopes.splice(0)) child.dispose()
      slotRegistry.notify()
    }
  }

  /** 声明子槽位（该条目要渲染的扩展点）；父句柄撤销时递归撤销 */
  declare(childName: string, kind?: PluginSlotKind): SlotHandleImpl {
    if (this.scope.disposed) {
      throw new Error(`[slots] 槽位 ${this.scope.name} 已撤销，不能再声明子槽位（${childName}）`)
    }
    const child = slotRegistry.declare(childName, kind ?? 'list', this)
    this.scope.childScopes.push(child)
    return child
  }

  /** 撤销本槽位：条目、子槽位与其注册内容一并递归移除 */
  dispose(): void {
    if (this.scope.disposed) return
    this.scope.disposed = true
    for (const child of this.scope.childScopes.splice(0)) child.dispose()
    for (const entry of this.scope.entries.splice(0)) {
      for (const child of entry.childScopes.splice(0)) child.dispose()
    }
    slotRegistry.removeScope(this.scope.name)
    slotRegistry.notify()
  }
}

function validateEntry(scope: ScopeRecord, def: SlotDefinition): void {
  if (!def || typeof def !== 'object') throw new Error(`[slots] 条目必须是对象（槽位 ${scope.name}）`)
  if (typeof def.key !== 'string' || !def.key.trim()) throw new Error(`[slots] 条目缺少 key（槽位 ${scope.name}）`)
  if (def.kind && def.kind !== scope.kind) {
    throw new Error(`[slots] 槽位 ${scope.name} 的 kind 是 ${scope.kind}，条目 ${def.key} 却声明 ${def.kind}`)
  }
  if (scope.entries.some((e) => maybeKey(e.def) === def.key)) {
    throw new Error(`[slots] 槽位 ${scope.name} 中 key 重复：${def.key}`)
  }
  if (scope.kind === 'chain' && typeof def.select !== 'function') {
    throw new Error(`[slots] 槽位 ${scope.name} 是 chain，条目 ${def.key} 必须提供 select(owner)`)
  }
  if (def.select !== undefined && typeof def.select !== 'function') {
    throw new Error(`[slots] 条目 ${def.key} 的 select 必须是函数`)
  }
  if (def.when !== undefined && typeof def.when !== 'function') {
    throw new Error(`[slots] 条目 ${def.key} 的 when 必须是函数`)
  }
  if (scope.kind !== 'chain' && def.select !== undefined) {
    throw new Error(`[slots] 只有 chain 槽位的条目可以提供 select（${scope.name}/${def.key}）`)
  }
}

function maybeKey(def: SlotDefinition): string {
  return String(def?.key ?? '')
}

class SlotRegistry {
  /** slot 名 → 作用域（同一槽位只允许一个活跃声明，重复声明抛错） */
  private scopes = new Map<string, ScopeRecord>()
  private listeners = new Set<() => void>()

  /** 声明一个槽位（父句柄可空 = 根作用域）；重复声明抛错 */
  declare(name: string, kind: PluginSlotKind = 'list', parent: SlotHandleImpl | null = null): SlotHandleImpl {
    if (!name || typeof name !== 'string') throw new Error('[slots] 槽位名必填')
    if (this.scopes.has(name)) throw new Error(`[slots] 槽位已声明：${name}`)
    const scope: ScopeRecord = { name, kind, entries: [], childScopes: [], parent, disposed: false }
    this.scopes.set(name, scope)
    this.notify()
    return new SlotHandleImpl(scope)
  }

  isDeclared(name: string): boolean {
    return this.scopes.has(name)
  }

  /** 内部：句柄撤销时移除作用域 */
  removeScope(name: string): void {
    this.scopes.delete(name)
  }

  /** 槽位的 kind（未声明返回 undefined） */
  kindOf(name: string): PluginSlotKind | undefined {
    return this.scopes.get(name)?.kind
  }

  /**
   * 槽位的全部条目（不按 keyed 分派过滤）。
   * 用于「列清单」场景：导航按钮、设置分组、诊断快照——这些需要拿到所有 key。
   */
  entriesAll(name: string, owner?: unknown): SlotDefinition[] {
    const scope = this.scopes.get(name)
    if (!scope) return []
    return this.sortedEntries(scope)
      .filter((e) => passes(e.def.when, owner))
      .map((e) => e.def)
  }

  /** 解析某槽位的条目列表（keyed 按 owner 分派；list 按 when 与 meta.target 过滤，已排序） */
  entries(name: string, owner?: unknown): SlotDefinition[] {
    const scope = this.scopes.get(name)
    if (!scope) return []
    const sorted = this.sortedEntries(scope)

    if (scope.kind === 'keyed') {
      if (owner === undefined) return []
      const hit = sorted.filter((e) => maybeKey(e.def) === String(owner))
      return hit.map((e) => e.def)
    }
    return sorted
      .filter((e) => passes(e.def.when, owner))
      .filter((e) => targetMatches(e.def, owner))
      .map((e) => e.def)
  }

  private sortedEntries(scope: ScopeRecord): EntryRecord[] {
    return scope.entries
      .slice()
      .sort((a, b) => numberOr(a.def.order) - numberOr(b.def.order) || a.seq - b.seq)
  }

  /** 解析「唯一胜出」的条目：keyed 取 key 匹配、single 取首个、chain 取首个 select 命中 */
  resolve(name: string, owner?: unknown): SlotDefinition | undefined {
    const scope = this.scopes.get(name)
    if (!scope) return undefined
    if (scope.kind === 'keyed' || scope.kind === 'single') return this.entries(name, owner)[0]
    // chain：priority 升序（未提供 priority 视为 0），同优先级按注册顺序
    const candidates = scope.entries
      .filter((e) => passes(e.def.when, owner))
      .slice()
      .sort((a, b) => numberOr(a.def.priority) - numberOr(b.def.priority) || a.seq - b.seq)
    for (const entry of candidates) {
      const select = entry.def.select
      if (!select) continue
      try {
        if (select(owner)) return entry.def
      } catch (err) {
        console.warn(`[slots] ${name}/${entry.def.key} 的 select 抛错（按不命中处理）:`, err)
      }
    }
    return undefined
  }

  /** 全部已声明槽位的只读快照（设置页诊断） */
  snapshot(): SlotSnapshot[] {
    return Array.from(this.scopes.values())
      .filter((s) => !s.disposed)
      .map((s) => ({
        slot: s.name,
        kind: s.kind,
        entries: s.entries.map((e) => ({
          key: maybeKey(e.def),
          owner: String(e.def.owner ?? 'unknown'),
          hasComponent: !!e.def.component,
          ...(e.def.titleZh ? { title: e.def.titleZh } : {}),
        })),
      }))
      .sort((a, b) => a.slot.localeCompare(b.slot))
  }

  /** 订阅注册表变化（Vue 侧据此刷新；纯逻辑层只暴露回调） */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 仅用于测试/热更新：清空全部槽位 */
  reset(): void {
    this.scopes.clear()
    this.notify()
  }

  notify(): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener()
      } catch (err) {
        console.error('[slots] 变化监听器异常:', err)
      }
    }
  }
}

function numberOr(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 评估 when：抛错按「不显示」处理（单个条目不得影响整块渲染） */
function passes(when: SlotDefinition['when'], owner: unknown): boolean {
  if (!when) return true
  try {
    return !!when(owner)
  } catch (err) {
    console.warn('[slots] when 抛错（按不显示处理）:', err)
    return false
  }
}

/**
 * list 条目的「归属目标」过滤：声明了 `meta.target` 的条目只在 owner 等于该值时渲染。
 * 用于 `settings.card` 这类「插到某个具体页面」的扩展点；未声明 target 的条目始终渲染。
 */
function targetMatches(def: SlotDefinition, owner: unknown): boolean {
  const target = def.meta?.[SLOT_META_TARGET]
  if (target === undefined) return true
  const value = Array.isArray(target) ? target : [target]
  return value.some((t) => String(t) === String(owner))
}

export const slotRegistry = new SlotRegistry()

/** 内置槽位的根句柄（外壳在启动时声明；插件随后即可注册） */
let coreScopes: SlotHandleImpl[] = []

/**
 * 声明全部内置槽位（幂等：重复调用不会重复声明）。
 * 由外壳在启动时调用（src/main.ts → initPluginRuntime），
 * 早于任何插件加载，因此插件可以在 apply() 里直接注册。
 */
export function declareCoreSlots(): void {
  if (coreScopes.length) return
  coreScopes = CORE_PLUGIN_SLOTS.map((def) => slotRegistry.declare(def.name, def.kind))
}

/** 内置槽位的根句柄（供扩展调试；正常扩展请走 ctx.slots.register） */
export function coreSlotScope(name: string): SlotHandleImpl | undefined {
  return coreScopes.find((h) => h.name === name)
}

/** 取内置槽位根句柄（未声明即抛错；外壳注册内置面板时使用） */
export function coreSlot(name: string): SlotHandleImpl {
  const handle = coreSlotScope(name)
  if (!handle) throw new Error(`[slots] 内置槽位未声明：${name}（应先调用 declareCoreSlots()）`)
  return handle
}
