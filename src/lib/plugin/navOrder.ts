/**
 * navOrder.ts — 用户自定义的「插件顺序」（vue-free，可在 Node 下单测）
 *
 * 需求：插件管理页里能**拖动插件排序**，导航栏的插件图标顺序 / 插件面板顺序
 * （含 `fa fa-th-large` 启动器网格里的卡片、插件子窗口图标栏）都以这份顺序为准。
 *
 * 为什么按「插件」而不是按「面板」排序：
 *  - 插件管理里列出的是**插件**，所以顺序以插件为粒度存；
 *  - 槽位条目的 `owner` 就是 `plugin:<id>`（id 是 ASCII 目录名），据此把插件顺序映射到面板条目上。
 *
 * 存储：localStorage 单键 `pluginOrder`（JSON 字符串数组，元素是插件 id）。
 *  - 顺序会**归一化成全量**：拖动一次之后，列表里没有的插件按当前显示顺序追加在后面，
 *    因此「用户拖出来的相对顺序」稳定，新装插件不会插到前面去；
 *  - 读取时过滤掉已卸载的 id。
 */

import { computed, ref, type ComputedRef } from 'vue'
import type { SlotDefinition } from './slots'
import { pluginIdOfOwner } from './runtime'

/** localStorage 键：用户拖出来的插件顺序（JSON 数组） */
export const PLUGIN_ORDER_LS_KEY = 'pluginOrder'

/** 顺序发生变化时自增：Vue 侧据此重新计算导航按钮 / 启动器网格 */
export const pluginOrderVersion = ref(0)

let cachedRaw = ''
let cachedOrder: string[] = []

/** 宽松取 localStorage（Node 自测 / 极端环境下没有它） */
function ls(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

/** 读取用户自定义顺序（去重；解析失败按空处理，绝不抛出） */
export function pluginOrder(): string[] {
  const raw = ls()?.getItem(PLUGIN_ORDER_LS_KEY) || ''
  if (raw === cachedRaw) return cachedOrder
  cachedRaw = raw
  cachedOrder = parsePluginOrder(raw)
  return cachedOrder
}

/** 解析一份 JSON 顺序（去重、丢掉非字符串 / 空串；不做缓存，供测试与读取共用） */export function parsePluginOrder(raw: string | null | undefined): string[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of parsed) {
    const id = typeof item === 'string' ? item.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** 写入并落盘；返回是否真的变化（没变就不写盘、不通知，避免拖动结束时无谓刷新） */
export function setPluginOrder(ids: string[]): boolean {
  const next = parsePluginOrder(JSON.stringify(ids))
  const prev = pluginOrder()
  if (next.length === prev.length && next.every((id, i) => id === prev[i])) return false
  cachedRaw = JSON.stringify(next)
  cachedOrder = next
  try {
    ls()?.setItem(PLUGIN_ORDER_LS_KEY, cachedRaw)
  } catch {
    /* 写盘失败（隐私模式 / 配额）不影响本次会话内的顺序 */
  }
  pluginOrderVersion.value++
  return true
}

/** 仅供测试：清掉模块内缓存，强制下次从 localStorage 重新读 */
export function resetPluginOrderCache(): void {
  cachedRaw = ''
  cachedOrder = []
}

/**
 * 响应式的用户顺序（组件里用它，而不是直接调 `pluginOrder()`）：
 * 后者是普通函数，读 localStorage 不算依赖 —— 落盘后组件不会重渲染，提示与「恢复默认」按钮也就不刷新。
 */
export function usePluginOrder(): ComputedRef<string[]> {
  return computed(() => {
    void pluginOrderVersion.value
    return pluginOrder()
  })
}

/**
 * 把一份**全量插件 id 顺序**落盘：调用方给出「想要的完整顺序」，
 * 这里负责过滤掉不存在的 id、补上缺失的 id（按 `allIds` 的顺序追加）。
 *
 * ⚠️ `desired = []`（或 `allIds = []`）语义是**恢复默认**：清空自定义顺序，
 * 而不是「把 allIds 全量写进去当顺序」（那会让每个插件都被钉死在当前位置，以后新增的插件再也排不进去）。
 */
export function commitPluginOrder(desired: string[], allIds: string[]): boolean {
  if (!desired.length || !allIds.length) return setPluginOrder([])
  const present = new Set(allIds)
  const out: string[] = []
  const seen = new Set<string>()
  const push = (id: string) => {
    if (!id || !present.has(id) || seen.has(id)) return
    seen.add(id)
    out.push(id)
  }
  for (const id of desired) push(id)
  for (const id of allIds) push(id)
  return setPluginOrder(out)
}

/**
 * 拖动重排：把 `sourceId` 放到 `targetId` 的**前面**；`after = true` 放到它后面。
 * `targetId` 为空 = 放到最后。
 *
 * `allIds` 传「当前列表顺序（全量）」：用户顺序尚未覆盖到的插件按它补在后面，
 * 这样在搜索过滤后拖动（列表只显示一部分）也不会把未显示的插件甩到错误位置。
 *
 * ⚠️ 用 id 而不是下标：列表下标是「过滤后」的位置，直接拿去重排全量列表必然错位。
 */
export function reorderPluginIds(
  sourceId: string,
  targetId: string,
  after: boolean,
  allIds: string[],
): string[] {
  const base = mergeWithAll(pluginOrder(), allIds)
  const from = base.indexOf(sourceId)
  if (from !== -1) base.splice(from, 1)
  if (!targetId) {
    base.push(sourceId)
    return base
  }
  const at = base.indexOf(targetId)
  if (at === -1) base.push(sourceId)
  else base.splice(after ? at + 1 : at, 0, sourceId)
  return base
}

/** 用户顺序 + 当前全量列表 → 完整顺序（未覆盖的按 allIds 原顺序追加） */
export function mergeWithAll(order: string[], allIds: string[]): string[] {
  const present = new Set(allIds)
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of order) {
    if (!present.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  for (const id of allIds) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** 按用户顺序排一份插件 id 列表（稳定：未排序的保持原位置） */
export function sortPluginsByOrder<T extends { id: string }>(items: T[]): T[] {
  const order = pluginOrder()
  if (!order.length || items.length < 2) return items
  const rank = new Map<string, number>()
  order.forEach((id, i) => rank.set(id, i))
  return items
    .map((item, index) => ({ item, index, rank: rank.has(item.id) ? rank.get(item.id)! : Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((x) => x.item)
}

/**
 * 把用户顺序应用到一组**已按注册表 order 排好序**的主面板条目上。
 *
 * 排序规则（三档，保证「内置永远在最前、用户拖过的排在中间、没拖过的照旧」）：
 *  0) 内置面板（owner = core / 空）：永远在最前，不参与重排；
 *  1) 用户拖过的插件：按用户顺序；
 *  2) 没拖过的插件：排在它们后面，保持注册表 order 的相对顺序（新装插件因此不会插到前面去）。
 * 同一插件的多个条目保持它们之间的相对顺序。
 *
 * 内置面板不能用本函数过滤（本模块不依赖 panelRegistry，避免循环 import）：
 * 调用方拿到结果后自行 `isBuiltinPanel(def.key)` 过滤。
 */
export function applyPluginOrder(entries: SlotDefinition[]): SlotDefinition[] {
  const order = pluginOrder()
  if (!order.length || entries.length < 2) return entries
  const rank = new Map<string, number>()
  order.forEach((id, i) => rank.set(id, i + 1))
  return entries
    .map((def, index) => {
      const id = pluginIdOfOwner(def.owner)
      // 内置面板（owner 不是 plugin:xxx）：档位 0
      if (!id) return { def, index, rank: 0 }
      const r = rank.get(id)
      return { def, index, rank: r === undefined ? Number.MAX_SAFE_INTEGER : r }
    })
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((x) => x.def)
}
