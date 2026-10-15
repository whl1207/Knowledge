/**
 * panelRegistry.selftest.ts — 主面板兜底（fallbackPanelFor）自测
 *
 * 断言的是「当前面板该不该被换掉、换到哪」这条边界：
 * - 当前面板仍注册且**可见** → 不换（返回 null）；
 * - 当前面板被功能开关关掉 → 换到注册表里第一个可见面板；
 * - 当前面板所属插件尚未注册完（不在注册表里）→ 换到第一个可见面板；
 * - **没有任何可见面板** → 返回 null（保持不动，等插件注册完或由空导航提醒兜底），
 *   绝不能回退到被关掉的内置「主页」——这正是「全部功能关闭、只留一个插件面板时一直停在主页」的成因。
 *
 * 用法：`node scripts/run-selftests.mjs panelRegistry`
 */

import { declareCoreSlots, coreSlot } from './slots'
import { PANEL_MAIN_SLOT } from './coreSlots'
import { BUILTIN_PANEL_KEYS, fallbackPanelFor, panelKeys } from './panelRegistry'

export interface PanelRegistryCase {
  name: string
  ok: boolean
  detail?: string
}

const PLUGIN_PANEL = '示例插件面板'

/** 注册四个内置面板 + 一个插件面板（与运行时同一套注册路径） */
function installPanels(): { dispose: () => void; removePluginPanel: () => void } {
  declareCoreSlots()
  const scope = coreSlot(PANEL_MAIN_SLOT)
  const disposers = [
    ...BUILTIN_PANEL_KEYS.map((key, i) =>
      scope.register({ key, titleZh: key, titleEn: key, icon: 'fa fa-square', order: 10 * (i + 1), component: {}, owner: 'core' }),
    ),
  ]
  const disposePlugin = scope.register({
    key: PLUGIN_PANEL,
    titleZh: PLUGIN_PANEL,
    titleEn: 'Sample plugin panel',
    icon: 'fa fa-puzzle-piece',
    order: 100,
    component: {},
    owner: 'plugin:sample',
  })
  return { dispose: () => disposers.forEach((d) => d()), removePluginPanel: disposePlugin }
}

export async function runPanelRegistrySelfTest(): Promise<PanelRegistryCase[]> {
  const cases: PanelRegistryCase[] = []
  const panels = installPanels()

  /** 可见性替身：hidden = 被功能开关关掉的面板 key */
  const visibleWith = (hidden: string[]) => (key: string) => hidden.indexOf(key) === -1
  const push = (name: string, got: string | null, want: string | null) =>
    cases.push({ name, ok: got === want, detail: `got=${String(got)} want=${String(want)}` })

  try {
    cases.push({
      name: '注册表含内置面板 + 插件面板',
      ok: panelKeys().length === BUILTIN_PANEL_KEYS.length + 1,
      detail: panelKeys().join(' / '),
    })

    push('当前面板可见 → 不切换', fallbackPanelFor('知识管理', visibleWith([])), null)
    push('当前面板被关掉 → 换到第一个可见面板', fallbackPanelFor('知识管理', visibleWith(['知识管理'])), '主页')
    push('插件面板被卸载 → 换到第一个可见面板', fallbackPanelFor('已卸载的插件面板', visibleWith([])), '主页')

    // 核心回归：内置四项全部关闭、只剩一个插件面板
    const onlyPlugin = visibleWith([...BUILTIN_PANEL_KEYS])
    push('只剩插件面板：当前停在已隐藏的主页 → 换到插件面板', fallbackPanelFor('主页', onlyPlugin), PLUGIN_PANEL)
    push('只剩插件面板：当前已是插件面板 → 不切换', fallbackPanelFor(PLUGIN_PANEL, onlyPlugin), null)
    push('全部关闭且没有插件面板 → 保持不动（由空导航提醒兜底）', fallbackPanelFor('主页', visibleWith([...BUILTIN_PANEL_KEYS, PLUGIN_PANEL])), null)

    // 启动早期：插件还没注册完（槽位条目尚未出现），内置四项又都被关掉。
    // 这时**不能**把当前面板换成被关掉的「主页」，否则插件注册完后「主页在注册表里」
    // 会让后续校验直接放过，界面就永远停在主页（历史 bug）。
    panels.removePluginPanel()
    push('只剩插件面板（插件尚未注册）→ 保持不动而不是跳到主页', fallbackPanelFor('某插件面板', onlyPlugin), null)
    push('插件尚未注册时，注册表里只剩内置面板', panelKeys().join('/'), BUILTIN_PANEL_KEYS.join('/'))
  } finally {
    panels.dispose()
  }

  return cases
}
