/**
 * 示例插件（渲染层半边）——P1/P2 能力演示：
 *
 * 1. **主面板**（panel.main）：自动获得导航按钮 + 顶栏标题；
 * 2. **设置页签**（settings.tab）：在设置左侧「插件」分组里多一项；
 * 3. **设置卡片**（settings.card + meta.target）：插到**已有**设置页里（这里是「基础」）；
 * 4. **集群工作台页签**（swarm.workbench.tab）：追加在「通信」之后；
 * 5. **文案服务**（ctx.locale）：中英双语字典，切语言自动重渲染；
 * 6. **快捷键服务**（ctx.shortcuts）：注册全局快捷键（单一监听器，输入框内不抢键）；
 * 7. **用户提示**（ctx.notify）与生命周期清理（ctx.effect）。
 *
 * ⚠️ 客户端半边的硬规则（宿主用 Blob URL 动态 import 本文件）：
 * - **单文件 ESM，且不能有 import 语句**：Blob 模块解析不了裸模块名 / 相对路径；
 * - Vue 运行时由宿主注入：用 `ctx.vue.h` / `ctx.vue.defineComponent` / `ctx.vue.ref`；
 * - 需要更多依赖时请自行打包（把依赖内联进单文件）。
 */

export function apply(ctx) {
  const { h, defineComponent, ref } = ctx.vue

  // ---- 5) 文案：中英双语字典（pick 返回响应式整表，切语言自动更新）----
  const panelText = ctx.locale.pick({
    zh: {
      title: '示例插件面板',
      intro: '这个面板由插件注册进 panel.main 槽位；导航按钮与顶栏标题都是自动获得的。',
      counter: '点我 +1',
      tip: '按 Ctrl/Cmd+Shift+H 会弹出插件通知（快捷键由插件注册）。',
      scope: '计数只存在于本组件内：切走面板后会被重新挂载。',
    },
    en: {
      title: 'Hello Panel',
      intro: 'This panel is registered by a plugin into panel.main — the nav button and title bar come for free.',
      counter: 'Click me +1',
      tip: 'Press Ctrl/Cmd+Shift+H to see a plugin notification (shortcut registered by the plugin).',
      scope: 'The counter lives inside this component only; leaving the panel remounts it.',
    },
  })
  const settingsText = ctx.locale.pick({
    zh: { tabTitle: '示例插件设置', tabDesc: '这段内容完全由插件绘制，宿主只提供 settings.tab 这个位置。', configLabel: '当前插件配置：' },
    en: { tabTitle: 'Hello plugin settings', tabDesc: 'This content is drawn entirely by the plugin; the host only provides the settings.tab position.', configLabel: 'Plugin config:' },
  })
  const cardText = ctx.locale.pick({
    zh: { cardTitle: '示例插件卡片', cardDesc: 'settings.card 槽位可以把卡片插进任意已有设置页（这里插在「基础」页）。' },
    en: { cardTitle: 'Hello plugin card', cardDesc: 'The settings.card slot injects a card into any existing settings page (here: the Basic page).' },
  })

  ctx.log.info('界面扩展已装载')

  // ---- 1) 主面板 ----
  const Panel = defineComponent({
    name: 'HelloPanelView',
    setup() {
      const n = ref(1)
      return () =>
        h('div', { style: 'padding:16px;font-size:13px;line-height:1.8' }, [
          h('h3', { style: 'margin:0 0 8px' }, panelText.value.title),
          h('div', panelText.value.intro),
          h('div', { style: 'margin-top:8px' }, [
            h('button', { onClick: () => (n.value += 1), style: 'cursor:pointer' }, `${panelText.value.counter}（${n.value}）`),
          ]),
          h('div', { style: 'margin-top:8px;opacity:.7' }, panelText.value.tip),
          h('div', { style: 'margin-top:4px;opacity:.55' }, panelText.value.scope),
        ])
    },
  })
  ctx.slots.register('panel.main', {
    key: '示例插件',
    titleZh: '示例插件',
    titleEn: 'Hello Panel',
    icon: 'fa fa-puzzle-piece',
    order: 900,
    component: Panel,
  })

  // ---- 2) 设置页签（key 即设置导航 id；meta.group 决定归属分组）----
  const SettingsCard = defineComponent({
    name: 'HelloSettingsCard',
    setup() {
      return () =>
        h('div', { class: 'settings-group' }, [
          h('h3', {}, settingsText.value.tabTitle),
          h('p', { style: 'font-size:13px;line-height:1.8;margin:0' }, settingsText.value.tabDesc),
          h('p', { style: 'font-size:12px;opacity:.7;margin-top:8px' }, [
            settingsText.value.configLabel,
            h('code', {}, JSON.stringify(ctx.config ?? {})),
          ]),
        ])
    },
  })
  ctx.slots.register('settings.tab', {
    key: 'plugin-hello',
    titleZh: '示例插件',
    titleEn: 'Hello Plugin',
    icon: 'fa fa-puzzle-piece',
    order: 900,
    component: SettingsCard,
  })

  // ---- 3) 设置卡片：插到「基础」（view）设置页里（meta.target = 目标设置页 id）----
  const InlineCard = defineComponent({
    name: 'HelloInlineCard',
    setup() {
      return () =>
        h('div', { class: 'form-group' }, [
          h('label', {}, cardText.value.cardTitle),
          h('div', { style: 'font-size:12px;opacity:.75;line-height:1.7' }, cardText.value.cardDesc),
        ])
    },
  })
  ctx.slots.register('settings.card', {
    key: 'hello-inline-card',
    titleZh: '示例插件卡片',
    titleEn: 'Hello plugin card',
    order: 900,
    component: InlineCard,
    meta: { target: 'view' },
  })

  // ---- 4) 集群工作台页签 ----
  const WorkbenchTab = defineComponent({
    name: 'HelloWorkbenchTab',
    setup() {
      return () => h('div', { style: 'padding:8px 0;font-size:13px' }, '这是一个插件追加的集群工作台页签。')
    },
  })
  ctx.slots.register('swarm.workbench.tab', {
    key: 'hello-workbench',
    titleZh: '插件页签',
    titleEn: 'Plugin Tab',
    order: 900,
    component: WorkbenchTab,
  })

  // ---- 6) 快捷键：Ctrl/Cmd+Shift+H 弹通知（输入框内不抢键）----
  ctx.shortcuts.register('Mod+Shift+H', () => ctx.notify('插件快捷键生效：Mod+Shift+H'), {
    descriptionZh: '示例插件：弹出一条通知',
    descriptionEn: 'Hello plugin: show a notification',
  })

  // ---- 7) 生命周期：停用 / 重载时清理都会跑 ----
  ctx.effect(() => () => ctx.log.info('界面扩展已卸载（槽位条目与快捷键随之撤销）'))
}
