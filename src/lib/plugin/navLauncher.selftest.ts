/**
 * navLauncher.selftest.ts — 导航栏插件图标收纳判定自测
 *
 * 断言的是「什么时候该把插件图标整体收进 fa fa-th-large 启动器」这条边界：
 * - 宽度够 → 全部显示，**不出**启动器（行为必须与改动前完全一致，这是最要紧的一条）；
 * - 宽度不够 → **一个插件图标都不显示**，只出启动器（要么全显示、要么全收起，不能裁一半）；
 * - 临界点有滞回：已收起时要再宽出一点才放回来，避免拖动窗口边缘时来回闪；
 * - 左侧竖排导航 → 按高度判定，内容超过可视高度即整体收起；
 * - 没有插件面板 / 拿不到容器尺寸 → 不出启动器（绝不能因为量不到就把导航栏清空）；
 * - **顶部布局的可用宽度必须从顶栏推算**，不能拿导航行自己的 clientWidth 反推（那是自引用：
 *   收起后它只剩内置图标那么宽，于是永远量不出「其实放得下」）；聚合态量不到插件图标时
 *   退回内置图标量步距，否则会「量不到 → 当作放得下 → 又展开 → 再收起」来回闪。
 *
 * 因为没有真实 DOM，这里用替身对象喂 `measureNavOverflow`：它只读 clientWidth / className /
 * querySelector / parentElement / children / getBoundingClientRect / scrollWidth 这些属性，
 * 替身够用且能把边界写得很细（替身元素带 `_style` 时由替身 getComputedStyle 原样返回）。
 *
 * 用法：`node scripts/run-selftests.mjs navLauncher`
 */

import { measureNavOverflow } from './navLauncher'

export interface NavLauncherCase {
  name: string
  ok: boolean
  detail?: string
}

interface FakeNavOptions {
  /** 容器可视宽度（顶栏 = .panel-nav，含内置按钮 + 插件按钮 + 启动器） */
  clientWidth: number
  /** 单个插件图标的宽度（布局步距 = 宽度 + 右间距 5） */
  iconWidth?: number
  /** 容器自身左右 padding 之和（横排导航要扣掉；顶栏 .panel-nav 为 0） */
  padX?: number
  /** 是否顶栏的 .panel-nav（自带 overflow-x: auto） */
  scrollHost?: boolean
  /** 竖排导航用：内容高度与可视高度 */
  scrollHeight?: number
  clientHeight?: number
  /** 拿不到插件图标样例（返回 null）时的替身 */
  noSample?: boolean
}

function makeNav(opts: FakeNavOptions): any {
  return {
    clientWidth: opts.clientWidth,
    clientHeight: opts.clientHeight ?? 0,
    scrollHeight: opts.scrollHeight ?? 0,
    classList: { contains: (c: string) => c === 'panel-nav' && !!opts.scrollHost },
    // 替身样例必须也带 classList：测试用的 getComputedStyle 靠它区分「容器」与「图标」
    querySelector: () => (opts.noSample ? null : { offsetWidth: opts.iconWidth ?? 30, classList: { contains: () => false } }),
  }
}

/**
 * 替身 getComputedStyle：
 *  - 带 `_style` 的替身 → 原样返回它（用来声明 position / flexGrow / margin 等）；
 *  - 容器（带 clientWidth）→ 返回左右 padding，用于底部导航的可用宽度计算；
 *  - 图标样例（只有 offsetWidth）→ 返回 margin-right（真实样式里导航按钮为 5px）。
 */
function installComputedStyle(padX: number): void {
  ;(globalThis as any).getComputedStyle = (el: any) => {
    if (el && el._style) return { paddingLeft: '', paddingRight: '', marginRight: '', ...el._style }
    if (el && typeof el.clientWidth === 'number') {
      return { paddingLeft: String(padX / 2), paddingRight: String(padX / 2), marginRight: '' }
    }
    return { paddingLeft: '', paddingRight: '', marginRight: '5' }
  }
}

interface FakeTopNavOptions {
  /** 顶栏内容宽（.panel-header.clientWidth） */
  headerWidth: number
  /** 顶栏里除导航行以外的固定占位宽度之和（右侧窗口按钮等；居中标题与弹性占位不算） */
  otherWidth?: number
  /** 导航行自身的**可视**宽：聚合时只剩内置图标那么宽，平铺时由 flex 分配 */
  navClientWidth: number
  /** 导航行内容宽（给得比 navClientWidth 大 = 模拟「实测真的在横向滚动」） */
  navScrollWidth?: number
  /** 平铺态才会渲染插件图标；聚合态为 false（判定必须退回内置图标量步距） */
  pluginIconRendered?: boolean
  /** 导航行里的内置图标个数 */
  coreCount?: number
}

/**
 * 顶栏替身：导航行 + 父元素顶栏（含弹性占位、绝对定位的居中标题、右侧窗口按钮）+ 行内内置图标。
 * 用来验证「可用宽度从顶栏推算」，而**不是**用导航行自己的 clientWidth。
 */
function makeTopNav(o: FakeTopNavOptions): any {
  const icon = (attrs: string[]) => ({
    offsetWidth: 30,
    hasAttribute: (a: string) => attrs.includes(a),
    classList: { contains: () => false },
    getBoundingClientRect: () => ({ width: 30 }),
  })
  const coreIcons = Array.from({ length: o.coreCount ?? 4 }, () => icon(['data-core-key']))
  const row = {
    offsetWidth: 0,
    hasAttribute: (a: string) => a === 'data-plugin-row',
    classList: { contains: () => false },
    getBoundingClientRect: () => ({ width: 0 }),
  }
  const nav: any = {
    clientWidth: o.navClientWidth,
    clientHeight: 0,
    scrollWidth: o.navScrollWidth ?? o.navClientWidth,
    scrollHeight: 0,
    _style: { position: 'static' },
    classList: { contains: (c: string) => c === 'panel-nav' },
    children: [...coreIcons, row],
    querySelector: (sel: string) => {
      if (String(sel).includes('data-plugin-key')) return o.pluginIconRendered ? icon(['data-plugin-key']) : null
      if (String(sel).includes('data-core-key')) return icon(['data-core-key'])
      return null
    },
  }
  nav.parentElement = {
    clientWidth: o.headerWidth,
    _style: { position: 'relative' },
    children: [
      nav,
      // 弹性占位（flex: 1）：可缩到 0，不算固定占位
      { _style: { flexGrow: '1' }, getBoundingClientRect: () => ({ width: 0 }) },
      // 居中标题：绝对定位，不占流式宽度
      { _style: { position: 'absolute' }, getBoundingClientRect: () => ({ width: 24 }) },
      // 右侧窗口按钮等：固定占位
      { _style: { position: 'static', marginRight: '0' }, getBoundingClientRect: () => ({ width: o.otherWidth ?? 0 }) },
    ],
  }
  return nav
}

export function runNavLauncherSelfTest(): NavLauncherCase[] {
  const cases: NavLauncherCase[] = []
  const push = (name: string, got: unknown, want: unknown) =>
    cases.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), detail: `got=${JSON.stringify(got)} want=${JSON.stringify(want)}` })

  // ---------- 横排（顶栏 / 底部导航）----------
  installComputedStyle(0)

  // 4 个插件 × 37px = 148 ≤ 200：放得下 → 不出启动器，全部显示
  push(
    '宽度够：全部显示、不出启动器',
    pick(measureNavOverflow(makeNav({ clientWidth: 200, scrollHost: true }), 'top', 4)),
    { hiddenCount: 0, launcherVisible: false, shownCount: 4, maxRowWidth: 0 },
  )

  // 15 个插件 × 37px = 555 > 300：放不下 → **整体收纳**，一个插件图标都不显示
  push(
    '宽度不够：插件图标整体收起，只留启动器',
    pick(measureNavOverflow(makeNav({ clientWidth: 300, scrollHost: true }), 'top', 15)),
    { hiddenCount: 15, launcherVisible: true, shownCount: 0, maxRowWidth: 0 },
  )

  // 极窄：同样整体收起（与「差一点」是同一种结果，不存在「显示前 N 个」）
  push(
    '极窄窗口：插件全部收起，只留启动器',
    pick(measureNavOverflow(makeNav({ clientWidth: 30, scrollHost: true }), 'top', 6)),
    { hiddenCount: 6, launcherVisible: true, shownCount: 0, maxRowWidth: 0 },
  )

  // 边界：15 × 37 = 555。正好放得下 → 不收纳
  push(
    '正好放得下：不收纳',
    pick(measureNavOverflow(makeNav({ clientWidth: 555, scrollHost: true }), 'top', 15)),
    { hiddenCount: 0, launcherVisible: false, shownCount: 15, maxRowWidth: 0 },
  )
  // 差 1px（554）→ 整体收纳
  push(
    '差 1px：整体收纳（且不显示任何插件图标）',
    pick(measureNavOverflow(makeNav({ clientWidth: 554, scrollHost: true }), 'top', 15)),
    { hiddenCount: 15, launcherVisible: true, shownCount: 0, maxRowWidth: 0 },
  )

  // 滞回：natural = 15 × 37 = 555。已收起时，宽度到 562 还不放回来（要宽出 8px 余量）
  push(
    '滞回：已收起时 555~562 不放回来（防拖动窗口时闪）',
    pick(measureNavOverflow(makeNav({ clientWidth: 560, scrollHost: true }), 'top', 15, true)),
    { hiddenCount: 15, launcherVisible: true, shownCount: 0, maxRowWidth: 0 },
  )
  push(
    '滞回：已收起时宽到 563 以上才放回来',
    pick(measureNavOverflow(makeNav({ clientWidth: 570, scrollHost: true }), 'top', 15, true)),
    { hiddenCount: 0, launcherVisible: false, shownCount: 15, maxRowWidth: 0 },
  )
  // 未收起时阈值更低：562 就够（进/出阈值不重合）
  push(
    '滞回：未收起时 562 即可继续显示',
    pick(measureNavOverflow(makeNav({ clientWidth: 562, scrollHost: true }), 'top', 15, false)),
    { hiddenCount: 0, launcherVisible: false, shownCount: 15, maxRowWidth: 0 },
  )

  // 底部导航有左右 padding：可用宽度要扣掉（clientWidth 200 - pad 40 = 160 < 185 → 收纳）
  installComputedStyle(40)
  push(
    '底部导航：可用宽度扣掉左右 padding',
    pick(measureNavOverflow(makeNav({ clientWidth: 200, padX: 40 }), 'bottom', 5)),
    { hiddenCount: 5, launcherVisible: true, shownCount: 0, maxRowWidth: 0 },
  )
  installComputedStyle(0)

  // ---------- 顶部布局：可用宽度必须从顶栏推算（不能用导航行自己的 clientWidth 反推）----------
  // 15 个插件 × 37px = 555；4 个内置图标固定占 4 × 35 = 140
  // 顶栏 900 - 右侧按钮 105 - 内置 140 = 655 可用
  push(
    '顶栏：已收起但窗口够宽 → 必须自己展开（收起态的 nav.clientWidth 只有 175，反推就永远展不开）',
    pick(measureNavOverflow(makeTopNav({ headerWidth: 900, otherWidth: 105, navClientWidth: 175 }), 'top', 15, true)),
    { hiddenCount: 0, launcherVisible: false, shownCount: 15, maxRowWidth: 0 },
  )
  // 顶栏 500 - 105 - 140 = 255 < 555：收起态且确实放不下 → 保持收起（不能因为量不到插件图标就展开）
  push(
    '顶栏：已收起且确实放不下 → 保持收起，不再来回闪',
    pick(measureNavOverflow(makeTopNav({ headerWidth: 500, otherWidth: 105, navClientWidth: 175 }), 'top', 15, true)),
    { hiddenCount: 15, launcherVisible: true, shownCount: 0, maxRowWidth: 0 },
  )
  // 平铺态：估算是「放得下」(655 ≥ 555)，但实测这一行在横向滚动（700 > 655）→ 以实测为准，整体收起
  push(
    '顶栏：估算放得下但实测溢出 → 以实测为准收起（绝不裁图标）',
    pick(measureNavOverflow(
      makeTopNav({ headerWidth: 900, otherWidth: 105, navClientWidth: 655, navScrollWidth: 700, pluginIconRendered: true }),
      'top',
      15,
    )),
    { hiddenCount: 15, launcherVisible: true, shownCount: 0, maxRowWidth: 0 },
  )
  // 平铺态 + 够宽 + 实测没溢出 → 维持平铺
  push(
    '顶栏：放得下且实测没溢出 → 平铺（不出启动器）',
    pick(measureNavOverflow(
      makeTopNav({ headerWidth: 900, otherWidth: 105, navClientWidth: 660, navScrollWidth: 660, pluginIconRendered: true }),
      'top',
      15,
    )),
    { hiddenCount: 0, launcherVisible: false, shownCount: 15, maxRowWidth: 0 },
  )

  // 没有插件面板 / 量不到尺寸：不收纳、不出启动器（不能把导航栏搞空）
  push('没有插件面板：不出启动器', pick(measureNavOverflow(makeNav({ clientWidth: 300, scrollHost: true }), 'top', 0)), pick({ hiddenCount: 0, launcherVisible: false, shownCount: 0, maxRowWidth: 0 }))
  push('拿不到容器：不出启动器', pick(measureNavOverflow(null, 'top', 5)), pick({ hiddenCount: 0, launcherVisible: false, shownCount: 0, maxRowWidth: 0 }))
  push('拿不到图标样例：不出启动器', pick(measureNavOverflow(makeNav({ clientWidth: 300, scrollHost: true, noSample: true }), 'top', 5)), pick({ hiddenCount: 0, launcherVisible: false, shownCount: 0, maxRowWidth: 0 }))
  push('宽度为 0（尚未布局）：不出启动器', pick(measureNavOverflow(makeNav({ clientWidth: 0, scrollHost: true }), 'top', 5)), pick({ hiddenCount: 0, launcherVisible: false, shownCount: 0, maxRowWidth: 0 }))

  // ---------- 左侧竖排（按高度判定）----------
  push(
    '左侧导航：高度够 → 全部显示',
    pick(measureNavOverflow(makeNav({ clientWidth: 44, scrollHeight: 300, clientHeight: 300 }), 'left', 6)),
    { hiddenCount: 0, launcherVisible: false, shownCount: 6, maxRowWidth: 0 },
  )
  push(
    '左侧导航：高度不够 → 插件整体收起',
    pick(measureNavOverflow(makeNav({ clientWidth: 44, scrollHeight: 420, clientHeight: 300 }), 'left', 6)),
    { hiddenCount: 6, launcherVisible: true, shownCount: 0, maxRowWidth: 0 },
  )

  return cases
}

/** 只取判定结果的四个字段（避免替身多带的属性影响比较） */
function pick(s: { hiddenCount: number; launcherVisible: boolean; shownCount: number; maxRowWidth: number }) {
  return { hiddenCount: s.hiddenCount, launcherVisible: s.launcherVisible, shownCount: s.shownCount, maxRowWidth: s.maxRowWidth }
}
