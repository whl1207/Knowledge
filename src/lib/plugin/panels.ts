/**
 * panels.ts — 内置主面板注册（P1 自举：内置面板也走插件注册）
 *
 * P1 的目标之一是「内置功能先走一遍插件注册流程」，用真实的第一方功能验证槽位 API。
 * 因此内置的 4 个主面板不再是 App.vue 里的 `v-if` 链 + `MAIN_PANEL_KEYS` 硬编码，
 * 而是注册进 `panel.main` 槽位的普通条目：
 * - 一个条目同时提供「面板本体」与「导航按钮」（key / title / icon / order 同一份数据）；
 * - 插件用完全相同的 API 注册，因此插件面板的导航按钮样式与内置的完全一致。
 *
 * ⚠️ 本文件静态 import 各面板组件（vue + 重型模块），因此**不要**被 store 直接 import
 * （会形成 store → panels → home.vue → store 的循环，见 panelRegistry.ts 的说明）；
 * 只需要「面板清单 / 标题」这类查询时，请 import panelRegistry.ts。
 */

import { defineAsyncComponent, h, type Component } from 'vue'
import { coreSlot, declareCoreSlots } from './slots'
import { SLOT_META_CORE, SLOT_META_KEEP_ALIVE } from '@/shared/pluginSlots'
import { PANEL_MAIN_SLOT } from './coreSlots'
import home from '@/components/home.vue'

/** 异步面板加载占位（与迁移前 App.vue 的实现一致：背景取主题色，避免白缝） */
export const asyncPanelLoading = () =>
  h(
    'div',
    {
      style:
        'height:100%;width:100%;background:var(--backgroundColor,#ffffff);display:flex;align-items:center;justify-content:center;color:#888;',
    },
    [h('i', { class: 'fa fa-spinner fa-spin', style: 'font-size:16px;' })],
  )

/** 按需加载的面板组件（重型依赖只在打开对应面板时才加载） */
export function lazyPanel(loader: () => Promise<any>): Component {
  return defineAsyncComponent({ loader, loadingComponent: asyncPanelLoading as any })
}

interface BuiltinPanelSpec {
  key: string
  titleZh: string
  titleEn: string
  icon: string
  order: number
  component: Component
  /** KeepAlive include 名（切换主面板时不销毁，保留后台状态） */
  keepAlive?: string
}

const BUILTIN_PANELS: BuiltinPanelSpec[] = [
  {
    key: '主页',
    titleZh: '主页',
    titleEn: 'Home',
    icon: 'fa fa-home',
    order: 10,
    // 首屏主页保持静态加载（迁移前亦是静态 import，不额外拆包）
    component: home,
  },
  {
    key: '知识管理',
    titleZh: '知识管理',
    titleEn: 'Knowledge Management',
    icon: 'fa fa-book',
    order: 20,
    component: lazyPanel(() => import('@/components/knowFile/explorer.vue')),
  },
  {
    key: '知识处理',
    titleZh: '知识处理',
    titleEn: 'Knowledge Processing',
    icon: 'fa fa-stack-overflow',
    order: 30,
    component: lazyPanel(() => import('@/components/knowRAG/knowRAG.vue')),
    // 切换主面板时知识处理不销毁，切片/构建等后台任务继续
    keepAlive: 'Knowledge',
  },
  {
    key: '学习',
    titleZh: '学习',
    titleEn: 'Learning',
    icon: 'fa fa-graduation-cap',
    order: 40,
    component: lazyPanel(() => import('@/components/learning/learning.vue')),
    // 切换主面板时学习模块不销毁，练习/考试作答状态保留
    keepAlive: 'Learning',
  },
]

let builtinRegistered = false

/** 注册内置主面板（幂等；模块加载后调用一次） */
export function registerBuiltinPanels(): void {
  if (builtinRegistered) return
  const scope = coreSlot(PANEL_MAIN_SLOT)
  for (const spec of BUILTIN_PANELS) {
    scope.register({
      key: spec.key,
      titleZh: spec.titleZh,
      titleEn: spec.titleEn,
      icon: spec.icon,
      order: spec.order,
      component: spec.component,
      owner: 'core',
      meta: {
        [SLOT_META_CORE]: true,
        ...(spec.keepAlive ? { [SLOT_META_KEEP_ALIVE]: spec.keepAlive } : {}),
      },
    })
  }
  builtinRegistered = true
}

// 声明内置槽位 + 注册内置面板（模块加载即完成，早于任何插件 apply）
declareCoreSlots()
registerBuiltinPanels()
