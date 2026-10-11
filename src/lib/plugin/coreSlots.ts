/**
 * coreSlots.ts — 槽位名常量（vue-free，供组件与插件共用）
 *
 * 槽位定义本身在 src/shared/pluginSlots.ts（主进程也会读）；这里只导出「组件里要写的常量」，
 * 避免组件到处手写字符串。
 */

export const PANEL_MAIN_SLOT = 'panel.main'
export const SETTINGS_TAB_SLOT = 'settings.tab'
export const SETTINGS_CARD_SLOT = 'settings.card'
export const SWARM_WORKBENCH_SLOT = 'swarm.workbench.tab'
export const CHAT_MESSAGE_ACTIONS_SLOT = 'chat.message.actions'
