/**
 * pluginSlots.ts — 插件槽位契约（P1：槽位名 + kind 的单一事实源）
 *
 * 命名对齐 DSH 的 slot 概念（`ui-slots`）：父级**声明**槽位、贡献方**注册**条目。
 * 这里只放「有哪些槽位、各是什么 kind」——它被主进程（清单越界校验）、渲染层（注册表）
 * 与插件作者文档共用，因此不能依赖 vue / DOM。
 *
 * kind 语义：
 * - `keyed`：按 owner 的 key 分派，同一时刻只渲染匹配的那一个（主面板、设置页签）；
 * - `list`：渲染全部条目，按 order 排序（用于「追加」类扩展点）。
 */

export type PluginSlotKind = 'single' | 'list' | 'keyed' | 'chain'

export interface CorePluginSlotDef {
  name: string
  kind: PluginSlotKind
  /** 面向插件作者的一句话说明（进设置页诊断信息） */
  desc: string
  /** 该槽位条目需要提供的元数据字段（用于文档与诊断） */
  requires?: readonly string[]
}

/**
 * 内置槽位（P1 全部由外壳在启动时声明，插件可在任意时刻注册）。
 *
 * 注：P0 方案里曾规划 `panel.nav`；实现时发现「主面板的导航按钮」与面板本身是同一份注册
 * （同一个 key/title/icon），单独再开一个槽位会让插件重复注册，故合并进 `panel.main`。
 */
export const CORE_PLUGIN_SLOTS: readonly CorePluginSlotDef[] = [
  {
    name: 'panel.main',
    kind: 'keyed',
    desc: '主面板：一个条目 = 一个主面板 + 它的导航按钮（key 即 store.mainPanel 的值）',
    requires: ['titleZh', 'titleEn', 'icon'],
  },
  {
    name: 'settings.tab',
    kind: 'keyed',
    desc: '设置页签：一个条目 = 一个设置项（key 即 Set.vue 的 activeNav 值，meta.group 决定归属分组）',
    requires: ['titleZh', 'titleEn'],
  },
  {
    name: 'settings.card',
    kind: 'list',
    desc: '设置卡片：往**已有**设置页里插一块卡片（meta.target 指定设置页 id，如 "view" / "features"）',
    requires: ['component', 'meta.target'],
  },
  {
    name: 'swarm.workbench.tab',
    kind: 'list',
    desc: '集群工作台页签（在「消息 / 泳道 / 名册 / 任务 / 通信」之后追加）',
    requires: ['titleZh', 'titleEn'],
  },
  {
    name: 'chat.message.actions',
    kind: 'list',
    desc: '聊天消息级操作按钮（追加在消息操作区）',
  },
] as const

export const CORE_PLUGIN_SLOT_NAMES: readonly string[] = CORE_PLUGIN_SLOTS.map((s) => s.name)

/** 槽位是否已声明（P1 = 是否在内置清单内） */
export function isKnownPluginSlot(slot: string): boolean {
  return CORE_PLUGIN_SLOT_NAMES.includes(slot)
}

/** 内置槽位的 kind（未知槽位返回 undefined） */
export function pluginSlotKind(slot: string): PluginSlotKind | undefined {
  return CORE_PLUGIN_SLOTS.find((s) => s.name === slot)?.kind
}

/** 过滤出未知槽位（清单校验用；未知即拒绝，遵循 fail-loud） */
export function unknownPluginSlots(slots: unknown): string[] {
  if (!Array.isArray(slots)) return []
  return slots.filter((s): s is string => typeof s === 'string').filter((s) => !isKnownPluginSlot(s))
}

/** 每个槽位条目的元数据 key 常量（避免字符串散落） */
export const SLOT_META_GROUP = 'group'
export const SLOT_META_KEEP_ALIVE = 'keepAlive'
export const SLOT_META_PASS_OWNER = 'passOwner'
export const SLOT_META_CORE = 'core'
/**
 * list 槽位的「归属目标」：条目只在该值等于 owner 时参与渲染。
 * 用于 `settings.card` 这类「插到某个具体页面里」的扩展点（如 `meta.target = 'view'`）。
 */
export const SLOT_META_TARGET = 'target'

/**
 * 槽位 owner 的 provide/inject 键。
 * 组件内 `inject(SLOT_OWNER_KEY)` 即可读到当前槽位的 owner（如当前主面板 key），
 * 无需外壳把 owner 塞进每个组件的 props。
 */
export const SLOT_OWNER_KEY: unique symbol = Symbol('aikm-slot-owner')
