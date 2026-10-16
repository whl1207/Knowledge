/**
 * panelRegistry.ts — 主面板的「查询层」（vue-free）
 *
 * 为什么与 panels.ts 分开：`store/index.ts` 需要「第一个可见主面板」这类查询，
 * 而 panels.ts 要静态 import 各面板组件（vue + 重型模块）。若 store 直接 import panels.ts，
 * 就会形成 **store → panels → home.vue → store** 的循环依赖，触发
 * `Cannot access 'usestore' before initialization`（真实踩过）。
 * 因此查询层只依赖纯逻辑的 slots.ts，组件与注册留在 panels.ts。
 *
 * 主面板 key 保持历史字符串（'主页' / '知识管理' / …），localStorage、
 * 分发的 interface-config.json 与 store.migrateNavKeys 都依赖它们。
 */

import { slotRegistry, type SlotDefinition } from './slots'
import { PANEL_MAIN_SLOT } from './coreSlots'
import { applyPluginOrder } from './navOrder'

/** 内置主面板 key（顺序即默认导航顺序；勿改字符串） */
export const BUILTIN_PANEL_KEYS = ['主页', '知识管理', '知识处理', '学习'] as const

/**
 * 内置主面板的历史标题文案（与迁移前 App.vue 的 switch 完全一致，
 * 含英文小写 'home' 这类既有文案）——保证内置面板零行为变化。
 */
const LEGACY_TITLE_TEXT: Record<string, { zh: string; en: string }> = {
  主页: { zh: '主页', en: 'home' },
  知识管理: { zh: '知识管理', en: 'Knowledge Management' },
  知识处理: { zh: '知识处理', en: 'Knowledge Processing' },
  学习: { zh: '学习', en: 'Learning' },
}

/**
 * 全部主面板条目（含插件贡献）。
 *
 * 顺序 = 注册表 order（内置 10/20/30/40、插件各自声明）**再套一层用户在插件管理里拖出来的
 * 插件顺序**（见 navOrder.ts）：用户拖过的插件按用户顺序排，没拖过的保持原位置。
 * 导航按钮、启动器网格、插件子窗口的图标栏都走这里，因此三处顺序天然一致。
 */
export function panelEntries(): SlotDefinition[] {
  return applyPluginOrder(slotRegistry.entriesAll(PANEL_MAIN_SLOT))
}

/**
 * 全部主面板 key。
 * 注册表尚未就绪（模块加载顺序）时回退内置 key，避免调用方拿到空列表。
 */
export function panelKeys(): string[] {
  const registered = panelEntries().map((e) => e.key)
  return registered.length ? registered : [...BUILTIN_PANEL_KEYS]
}

/** 取单个主面板条目 */
export function getPanel(key: string): SlotDefinition | undefined {
  return panelEntries().find((e) => e.key === key)
}

/** 某面板是否内置（内置面板可在功能开关里隐藏，但不随插件卸载消失） */
export function isBuiltinPanel(key: string): boolean {
  return (BUILTIN_PANEL_KEYS as readonly string[]).includes(key)
}

/** 面板标题（导航按钮与顶栏标题共用；缺省回退 key） */
export function panelTitleOf(key: string, zh: boolean): string {
  const def = getPanel(key)
  if (!def) return key
  return (zh ? def.titleZh : def.titleEn) || def.titleZh || key
}

/** 顶栏标题文本（内置用历史文案，插件面板回退到注册表标题） */
export function panelHeaderText(key: string, zh: boolean): string {
  const legacy = LEGACY_TITLE_TEXT[key]
  if (legacy) return zh ? legacy.zh : legacy.en
  return panelTitleOf(key, zh)
}

/**
 * 当前面板不可用时，返回应切换到的面板；无需切换（或压根没有可用面板）返回 null。
 *
 * 「不可用」= 不在注册表里（所属插件被停用 / 卸载 / 尚未注册完）**或被功能开关关掉**。
 * ⚠️ 兜底只认「可见」的面板：没有任何可见面板时返回 null（保持当前面板不动），
 * 由 App.vue 的空导航提醒兜底。历史 bug：这里曾无条件回退到内置「主页」，
 * 于是「所有功能都关掉、只留一个插件面板」时，启动早期插件尚未注册，兜底先把面板设成
 * 被关掉的「主页」，插件注册完后「主页在注册表里」又让本函数返回 null，就再也纠正不回来了
 * （现象：一直停在主页，而不是切到唯一的插件面板）。
 */
export function fallbackPanelFor(current: string, isVisible: (key: string) => boolean): string | null {
  const keys = panelKeys()
  if (keys.includes(current) && isVisible(current)) return null
  return keys.find((k) => k !== current && isVisible(k)) ?? null
}
