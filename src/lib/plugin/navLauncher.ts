/**
 * navLauncher.ts — 导航栏「插件图标收纳」的判定层（vue-free，可在 Node 下单测）
 *
 * 需求：插件开得太多、导航栏放不下时，插件图标收纳成一个 `fa fa-th-large` 启动器图标，
 * 点开后主面板用网格（grid）列出插件与它的面板，点具体插件以子窗口形态打开。
 *
 * 语义要点：
 *  - **只收纳插件面板**：内置面板永远留在导航栏，不受窗口宽度影响；
 *  - **要么全显示、要么全收起**：宽度够 → 插件图标正常显示（点它切换主面板，行为与以前一致）；
 *    不够 → 一个插件图标都不显示，导航栏上只留 `fa fa-th-large`，插件全部经启动器进入；
 *  - 三种导航布局都要生效：顶栏（横排）/ 底部（横排）/ 左侧（竖排）。
 *
 * 判定只依赖 DOM 尺寸，与渲染解耦：Vue 侧（App.vue / PluginPanelWindow.vue）只读结果，
 * 靠 `launcherVisible` 决定「渲染插件图标行」还是「渲染启动器」。
 */

/** 导航布局（与 store.UI.navLayout 同义） */
export type NavLayout = 'top' | 'bottom' | 'left'

/** 收纳判定结果 */
export interface NavOverflowState {
  /** 被收纳（不再直接显示）的插件图标数量 */
  hiddenCount: number
  /** 是否收起插件图标、改显示启动器 */
  launcherVisible: boolean
  /** 直接在导航栏里显示的插件图标数量（收纳后为 0） */
  shownCount: number
  /** 插件图标行允许占用的宽度（px；收纳后为 0 表示不占位） */
  maxRowWidth: number
}

/** 导航按钮上标记插件面板 key 的 data 属性（判定与渲染共用，避免两边写错字符串） */
export const NAV_PLUGIN_KEY_ATTR = 'data-plugin-key'

/** 导航按钮上标记「这是个内置面板」的 data 属性（内置面板不参与收纳） */
export const NAV_CORE_KEY_ATTR = 'data-core-key'

/**
 * 顶部布局里「插件图标行」容器上的 data 属性（插件图标先聚在这一行里，放不下才整行收起）。
 *
 * 为什么判定层要认得它：算可用宽度时必须把这一行排除在「固定占位」之外——它就是被判定对象本身。
 */
export const NAV_PLUGIN_ROW_ATTR = 'data-plugin-row'

/**
 * 聚合图标（`fa fa-th-large` 启动器）的类名。
 *
 * 三种导航布局的聚合图标都带这个类；判定「要不要平铺」时**不能**把它算进固定占位：
 * 决定平铺的那一刻它本来就不该存在（否则收起后可用宽度少一格，临界点上会翻来覆去）。
 */
export const NAV_LAUNCHER_CLASS = 'nav-launcher'

const EMPTY: NavOverflowState = { hiddenCount: 0, launcherVisible: false, shownCount: 0, maxRowWidth: 0 }

/** 每个插件图标额外留的余量（缩放 / 字体渲染的小差异） */
const SLACK = 2

/**
 * 滞回余量（px）：**收起后**要再宽出这么多才把图标放回来。
 *
 * 为什么需要：临界点上 `available` 与 `natural` 只差几像素（顶栏导航行宽度受 flex 分配与
 * 子像素取整影响），拖动窗口边缘时判定会在「放得下 / 放不下」之间反复横跳 ——
 * 表现就是单个图标与聚合图标来回闪。给「从收起恢复」这一侧加余量后，进出阈值不再重合。
 */
const LAYOUT_SLACK = 8

/**
 * 判定结果（每次调用都重新量 DOM，不做缓存）：
 *
 * 语义：插件图标**要么全显示、要么全收起**（放不下时导航栏只留启动器一个图标）。
 *
 * @param nav          插件图标所在的容器（顶栏 = `.panel-nav`；左/下导航 = 整个导航栏）
 * @param layout       导航布局
 * @param pluginCount  当前可见的插件面板总数
 * @param wasCollapsed 上一次的结果是否已收起。只用于**滞回**：临界点上多留一点余量，
 *                     避免拖动窗口边缘时「单个图标 ↔ 聚合图标」来回闪（见 LAYOUT_SLACK 说明）。
 */
export function measureNavOverflow(
  nav: HTMLElement | null | undefined,
  layout: NavLayout,
  pluginCount: number,
  wasCollapsed = false,
): NavOverflowState {
  if (!nav || pluginCount <= 0) return { ...EMPTY }

  // 竖排导航（左侧栏）：按钮一列排下去，收纳判定只能看高度——内容超过可视高度就整体收起。
  // 内置面板占最上面几个位置且始终可见，启动器图标紧跟在它们后面，仍能被点到。
  if (layout === 'left') {
    const overflow = nav.scrollHeight > nav.clientHeight + 1
    return {
      hiddenCount: overflow ? pluginCount : 0,
      launcherVisible: overflow,
      shownCount: overflow ? 0 : pluginCount,
      maxRowWidth: 0,
    }
  }

  // 横排导航：单个图标的**步距**（图标宽 + 右间距）。
  //
  // ⚠️ 聚合状态下插件图标一个都不渲染（它们全在启动器里），拿不到 `[data-plugin-key]` 样例，
  //    所以退回内置图标当样例：两者是同一套 CSS（30×30 图标 + 5px 右间距），步距一致。
  //    少了这个退回，聚合后步距量到 0 → 被当成「放得下」→ 又展开 → 再收起，来回闪。
  const sample = nav.querySelector<HTMLElement>(`[${NAV_PLUGIN_KEY_ATTR}]`)
    ?? nav.querySelector<HTMLElement>(`[${NAV_CORE_KEY_ATTR}]`)
  if (!sample?.offsetWidth) return { ...EMPTY }
  const pitch = sample.offsetWidth + (parseFloat(getComputedStyle(sample).marginRight) || 0) + SLACK
  const natural = pitch * pluginCount

  // 可用宽度见 availableWidthForPlugins（**不能**用 nav.clientWidth 反推，原因写在那里）
  const available = availableWidthForPlugins(nav, layout)
  if (available <= 0) return { ...EMPTY }

  // 放得下 → 不出启动器，全部显示（与改动前的行为完全一致）。
  // 已收起时多要 LAYOUT_SLACK 才放回来：进出阈值不重合，拖动窗口边缘不会来回闪。
  const fitBudget = available - (wasCollapsed ? LAYOUT_SLACK : 0)
  if (natural <= fitBudget) {
    // 估算说放得下，但**实测**这一行真的在横向滚动（内容超出可视宽度）→ 以实测为准，整体收起。
    // 这是估算失准（插件图标比内置图标宽、缩放取整等）时的兜底：宁可收进启动器，也不能把图标裁掉。
    // 收起态量不到真实行宽（行是 display:none），所以只在「当前是平铺」时做这个实测。
    if (!wasCollapsed && nav.scrollWidth > nav.clientWidth + 1) {
      return { hiddenCount: pluginCount, launcherVisible: true, shownCount: 0, maxRowWidth: 0 }
    }
    return { hiddenCount: 0, launcherVisible: false, shownCount: pluginCount, maxRowWidth: 0 }
  }

  // 放不下 → **整体收纳**：插件图标一个都不显示，导航栏上只留 `fa fa-th-large`，
  // 插件全部从启动器面板 / 子窗口进入。
  //
  // 为什么不是「显示前 N 个、其余收起」（曾经就是这样）：用户看到的是一排被 `max-width`
  // 硬裁掉的图标 —— 右侧缺一角、还和启动器挤在一起，既像渲染坏了，又会让「点哪个图标切哪个面板」
  // 与「点启动器进子窗口」两套交互混在同一行里。整体收起后语义单一：要么都在，要么都在启动器里。
  // 判定也因此不再需要为「启动器占位」预留宽度，边界只由 natural vs available 决定，天然不抖。
  return { hiddenCount: pluginCount, launcherVisible: true, shownCount: 0, maxRowWidth: 0 }
}

/**
 * 「插件图标」这一组能占用的宽度（px）。
 *
 * ⚠️ **顶部布局绝不能用 `nav.clientWidth` 当可用宽度**：那一行的宽度本身就是判定的**结果**——
 * 聚合时它只剩内置图标那么宽（约 175px），平铺时又取决于行内塞了多少图标。拿它反推是自引用，
 * 后果是「收起之后再也不会自己展开」（收起态永远量到只够一个图标）以及「展开 ↔ 收起」来回闪。
 * 顶部布局因此从**顶栏**推算：顶栏内容宽 − 其它按流式固定占位的子元素 − 导航行里内置图标等占位。
 *
 * 底部导航是一整条（插件按钮就是它的直接子元素）且自身 `overflow-x: auto`，可用宽度直接量自己即可，
 * 但同样要扣掉内置图标 / 聚合图标 / 设置按钮这些固定占位，否则会误判成「放得下」。
 */
function availableWidthForPlugins(host: HTMLElement, layout: NavLayout): number {
  if (layout === 'top' && host.parentElement) {
    const header = host.parentElement
    let others = 0
    for (const child of Array.from(header.children) as HTMLElement[]) {
      if (child === host) continue
      const cs = getComputedStyle(child)
      // 居中标题是绝对定位（不占流式宽度）；弹性占位（flex-grow > 0）可以缩到 0，也不算固定占用
      if (cs.position === 'absolute' || cs.position === 'fixed') continue
      if ((parseFloat(cs.flexGrow) || 0) > 0) continue
      const w = child.getBoundingClientRect().width
      if (w <= 0) continue
      others += w + (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.marginRight) || 0)
    }
    return header.clientWidth - others - fixedWidthInsideNav(host)
  }

  const style = getComputedStyle(host)
  const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
  return host.clientWidth - padX - fixedWidthInsideNav(host)
}

/** 导航容器里「插件图标 / 插件图标行」以外、固定占位的宽度（内置图标、聚合图标、设置等附属按钮） */
function fixedWidthInsideNav(host: HTMLElement): number {
  let used = 0
  for (const child of Array.from(host.children ?? []) as HTMLElement[]) {
    if (child.hasAttribute(NAV_PLUGIN_KEY_ATTR)) continue // 插件图标本身（被判定对象）
    if (child.hasAttribute(NAV_PLUGIN_ROW_ATTR)) continue // 插件图标行（被判定对象）
    if (child.classList.contains(NAV_LAUNCHER_CLASS)) continue // 聚合图标（平铺时不存在）
    if (getComputedStyle(child).position === 'absolute') continue
    const w = child.getBoundingClientRect().width
    if (w <= 0) continue
    used += w + (parseFloat(getComputedStyle(child).marginRight) || 0)
  }
  return used
}
