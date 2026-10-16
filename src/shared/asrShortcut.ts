/**
 * asrShortcut.ts — 语音输入（按住说话）快捷键的**唯一来源**
 *
 * 为什么单独放一份：
 *  - 默认值出现在三个地方（store 的初值、设置页「恢复默认」、globalVoice 的备选组合），
 *    写死三处必然走偏；
 *  - 快捷键**很容易与别的软件撞车**，而注册失败时的行为（自动退到备选 + 弹提示）需要说清楚，
 *    否则用户看到的是「已临时改用某某」而实际两组都失败（见 globalVoice.syncShortcut）。
 *
 * 关于默认值的选择（踩过两次）：
 *  1) `Ctrl+Shift+Space` —— 中文输入法 / 其它软件很常占用，实测注册必失败；
 *  2) `Ctrl+Alt+*` —— **Windows 上不要用**：Ctrl+Alt 等同于 AltGr，中文输入法（尤其微软拼音）
 *     会把它当自己的组合，注册同样失败；
 *  所以默认改成带功能键的 `Ctrl+Shift+F9`：功能键很少被其它软件抢，也不与输入法冲突。
 *  依然失败时用户可以自己在设置里改，或点「清空」不用系统级快捷键。
 *
 * 迁移：`MIGRATE_FROM` 里的旧默认值如果是用户**没改过**的（即还等于旧默认），
 * 启动时换成新默认；用户自己改过的组合不动（见 store 的 loadConfig）。
 */

/** 当前默认快捷键：`Ctrl+Shift+F9`（功能键少被占用，且不与输入法冲突） */
export const DEFAULT_ASR_SHORTCUT = 'Ctrl+Shift+F9'

/** 旧默认值：还等于它的存档会被迁移到新默认（用户改过的值不在此列） */
export const LEGACY_ASR_SHORTCUTS = ['Ctrl+Shift+Space', 'Ctrl+Alt+M']

/**
 * 主快捷键被别的软件占用时的备选组合（按顺序尝试，第一个可用的生效）。
 * 只用功能键组合：`Ctrl+Alt+*` 在 Windows 上与输入法（AltGr）冲突，不作为备选。
 */
export const ASR_SHORTCUT_FALLBACKS = ['Ctrl+Shift+F10', 'Ctrl+Alt+F9']

/** 是否还是「旧默认值」（需要迁移成新默认） */
export function needsShortcutMigration(shortcut: unknown): boolean {
  const s = String(shortcut ?? '').trim()
  return !!s && LEGACY_ASR_SHORTCUTS.includes(s)
}
