<script setup lang="ts">
import { aikmDsh, aikmIpcAvailable } from '@/lib/aikmIpc'
  import {ref, onMounted, onUnmounted, computed, watch, nextTick, h, defineAsyncComponent} from 'vue'
  import {usestore} from '@/store'
  import { ElMessage } from 'element-plus'
  // 后台运行态（均为模块级 ref，跨组件卸载存活）：
  //  - globalExecutionState/chats：聊天智能体、工作流、流式生成
  //  - swarmRunning：智能体集群
  //  - runningTaskNames：各脚手架自行登记（见 store/runningTasks.ts）
  import { globalExecutionStateRef, chatsRef } from '@/store/chats'
  import { runningTaskNames, runningTaskList } from '@/store/runningTasks'
  import { formatTaskProgressDetail } from '@/utils/taskProgress'
  import { running as swarmRunning } from '@/store/swarmState'
  // 局域网访客权限默认策略（启动时下发给主进程；见 syncLanGuestPolicyAtStartup）
  import { defaultLanGuestPolicy } from '@/shared/lanGuest'
  const store=usestore()

  // 主面板与槽位：内置面板也走 plugin.main 槽位注册（见 lib/plugin/panels.ts）；
  // 面板本体渲染在下方模板的 <PluginSlot name="panel.main">，导航按钮由同一条目派生。
  // ⚠️ 查询走 vue-free 的 panelRegistry；panels.ts 负责注册内置面板（含静态组件 import）
  import { PANEL_MAIN_SLOT } from '@/lib/plugin/coreSlots'
  import { fallbackPanelFor, panelHeaderText, isBuiltinPanel } from '@/lib/plugin/panelRegistry'
  import { lazyPanel as makeLazyPanel } from '@/lib/plugin/panels'
  import { useAllSlotEntries } from '@/lib/plugin/useSlots'
  import PluginSlot from '@/components/plugin/PluginSlot.vue'
  // 导航栏插件图标收纳（放不下就收成 fa fa-th-large 启动器）与启动器网格 / 插件子窗口壳
  import { measureNavOverflow, type NavOverflowState } from '@/lib/plugin/navLauncher'
  import {
    pluginDescription,
    pluginDisplayName,
    pluginEnabledCount,
    pluginIdOfOwner,
    pluginTotalCount,
  } from '@/lib/plugin/runtime'
  import PluginLauncherGrid from '@/components/plugin/PluginLauncherGrid.vue'
  // ask_user 结构化问答弹窗宿主（全局唯一：所有入口都经 store/askUser 排队）
  import AskUserHost from '@/components/agent/AskUserHost.vue'
  // exit_plan_mode 计划评审弹窗宿主（全局唯一：所有入口都经 store/planReview 排队）
  import PlanReviewHost from '@/components/agent/PlanReviewHost.vue'
  // 全局语音输入：**唯一**的视觉提示（状态与识别全在 services/asr/globalVoice.ts）；
  // 这里只负责挂载一次 + 初始化，各模块不需要接任何东西
  import VoiceInputOverlay from '@/components/voice/VoiceInputOverlay.vue'
  import { initGlobalVoice, disposeGlobalVoice } from '@/services/asr/globalVoice'
  // 插件面板全屏时请求隐藏宿主外壳（顶栏 / 左侧导航 / 底部导航）：见 lib/plugin/panelChrome.ts
  import { panelChromeHidden, resetPanelChrome } from '@/lib/plugin/panelChrome'
import { getPlatform, hasCapability, isHostGuestRuntime } from '@/platform'
import { runTopBackLayer, registerBackLayer, BACK_ORDER } from '@/platform/backLayers'
import { useTallLayout } from '@/composables/useTallLayout'

  const lazyPanel = makeLazyPanel
  // ⚠️ 变量名不能叫 Set：会遮蔽全局 Set 构造函数，导致下方 collectRunningTasks 里的 `new Set(...)`
  // 抛 “Set is not a constructor”（关闭窗口时才触发，不易发现）
  const SetPanel = lazyPanel(() => import('@/components/set/Set.vue'))
  const FileWindow = lazyPanel(() => import('@/components/knowFile/FileWindow.vue'))
  // 浏览器模块独立于 knowFile：网页浏览、AI 会话、收藏/离线保存等均在独立窗口内完成
  const BrowserAgentShell = lazyPanel(() => import('@/components/browser/BrowserAgentShell.vue'))
  // 插件面板子窗口壳（导航栏收纳后的启动器打开的窗口；网页/安卓端复用为应用内浮层）
  const PluginPanelWindow = lazyPanel(() => import('@/components/plugin/PluginPanelWindow.vue'))
  // 设置浮层显隐由 store.settingsOpen 控制（浏览器/LAN 模式回退用），便于 AgentSwarm 等模块跳转
  // 桌面版设置走独立子窗口：其开合状态单独记录（settingsWindowOpen），仅用于导航按钮高亮——
  // 不能复用 store.settingsOpen，否则「窗口已打开」会同时点亮主窗口内的设置浮层
  const settingsWindowOpen = ref(false)
  const isMaximized = ref(false); // 窗口是否最大化状态
  // 独立窗口标记在 setup 同步阶段按 location.hash 初始化：首帧即渲染对应壳（FileWindow/BrowserAgentShell），
  // 避免先渲染一次完整主界面再切换（独立窗口瞬间闪现整个软件界面）
  const isFileWindow = ref(typeof window !== 'undefined' && window.location.hash.startsWith('#/file-view'))
  const isBrowserAgentWindow = ref(typeof window !== 'undefined' && window.location.hash.startsWith('#/browser-agent'))
  const isSettingsWindow = ref(typeof window !== 'undefined' && window.location.hash.startsWith('#/settings-window'))
  // 插件面板子窗口（导航栏收纳后的启动器打开的窗口）：hash = #/plugin-panel?id=<面板 key>
  // 同样在 setup 同步阶段判定：首帧即渲染插件壳，避免先闪一帧完整主界面
  const isPluginPanelWindow = ref(typeof window !== 'undefined' && window.location.hash.startsWith('#/plugin-panel'))
  /** 插件面板子窗口要显示的插件面板 key 与兜底标题（从 hash 解析，URL 解码） */
  const pluginPanelWindowParams = (() => {
    const hash = typeof window !== 'undefined' ? window.location.hash : ''
    const q = hash.indexOf('?')
    const out = { key: '', title: '' }
    if (q < 0) return out
    try {
      const sp = new URLSearchParams(hash.substring(q + 1))
      out.key = sp.get('id') || ''
      out.title = sp.get('title') || ''
    } catch { /* hash 异常时按空处理（壳里会提示没有可显示的插件面板） */ }
    return out
  })()
  // 设置独立窗口的初始导航分类：主进程以 #/settings-window?nav=xxx 传入（如从 AgentSwarm 跳「预设」）
  const settingsWindowNav = (() => {
    const h = typeof window !== 'undefined' ? window.location.hash : ''
    const q = h.indexOf('?')
    if (q < 0) return ''
    try { return new URLSearchParams(h.substring(q + 1)).get('nav') || '' } catch { return '' }
  })()
  const isBrowser = isHostGuestRuntime() // 局域网访客网页（主机投递；安卓壳不算）
  // 安卓（Capacitor 壳）：没有窗口壳概念，设置改为整页展示（手机屏幕小，浮层对话框太挤）
  const isAndroid = getPlatform().kind === 'android'
  // 细长窗口（高宽比 > 16:9，如手机竖屏）：与主页 / 知识管理同一套整屏做法（见 useTallLayout）
  const isTallLayout = useTallLayout()
  store.setTheme()

  /**
   * 局域网共享：把「访客权限策略 + 主机模型」下发给主进程（P3/P4 的主机侧据此校验令牌、
   * 限并发、并给访客智能体会话兑上模型与工具白名单）。
   *
   * 为什么放在启动时同步、而不是只靠设置页：
   * 策略存在渲染层 localStorage，而主进程每次启动都回到默认值（只开普通 + 知识库）。
   * 如果只在打开「协作」设置页时推送，那么「勾选了智能体 → 重启应用 → 直接用手机打开共享地址」
   * 的路径下，网页端拿到的是默认策略 → 看不到「智能体」模式（表现为「配置已经开了却没有」）。
   */
  const syncLanGuestPolicyAtStartup = async () => {
    if (!aikmIpcAvailable()) return
    try {
      const guest = store.lan?.guest || defaultLanGuestPolicy()
      // 单一入口：策略 + 主机模型 + 可用智能体档案一起下发
      // （漏带 agents 会清空主机的智能体清单 → 网页端只剩「通用智能体」）
      const { pushLanGuestPolicy } = await import('@/platform/lanGuestSync')
      await pushLanGuestPolicy(store)
    } catch (e) {
      console.warn('[lan-guest] 同步访客权限失败:', e)
    }
  }

  // 计算标题文本（内置面板沿用历史文案，插件面板回退到注册表标题；见 lib/plugin/panels.ts）
  const panelTitle = computed(() => {
    // 自定义标题：界面设置中定义后固定不变，不再随当前面板变化
    if (store.customTitle && store.customTitle.trim()) {
      return store.customTitle
    }
    return panelHeaderText(store.mainPanel, store.locales !== 'en')
  })

  // 导航栏布局：left=左侧导航 / bottom=下方导航（默认 top=顶部导航）
  const isLeftNav = computed(() => store.UI.navLayout === 'left')
  const isBottomNav = computed(() => store.UI.navLayout === 'bottom')
  // 左侧/下方布局下，顶栏只保留标题 + 4 个窗口按钮
  const isCompactTop = computed(() => isLeftNav.value || isBottomNav.value)

  // 主面板导航按钮（来源 = panel.main 槽位注册表：内置面板与插件面板同一份数据；
  // 功能开关：被隐藏的按钮不显示，见设置页「界面-功能开关」）
  const panelSlotEntries = useAllSlotEntries(PANEL_MAIN_SLOT)

  /**
   * 可见的主面板按钮。`core` 标记内置面板：内置 4 个永远留在导航栏，
   * 插件面板才会在放不下时被收进 `fa fa-th-large` 启动器。
   * owner 只用于给启动器卡片标出「这是哪个插件的面板」（见 pluginDisplayName）。
   */
  const navButtonDefs = computed(() => {
    const zh = store.locales === 'zh'
    return panelSlotEntries.value
      .filter((def) => store.isNavVisible(def.key))
      .map((def) => ({
        key: def.key,
        core: isBuiltinPanel(def.key),
        icon: def.icon || 'fa fa-puzzle-piece',
        title: (zh ? def.titleZh : def.titleEn) || def.titleZh || def.key,
        pluginId: pluginIdOfOwner(def.owner),
      }))
  })

  /** 全部可见按钮（内置 + 插件），导航栏按此渲染 */
  const navButtons = computed(() => navButtonDefs.value)
  /** 内置面板按钮（始终显示） */
  const coreNavButtons = computed(() => navButtonDefs.value.filter((b) => b.core))
  /** 插件面板按钮（可被整体收纳） */
  const pluginNavButtons = computed(() => navButtonDefs.value.filter((b) => !b.core))
  /** 启动器网格的卡片：一个插件面板一张卡（含所属插件名与描述） */
  const launcherEntries = computed(() =>
    pluginNavButtons.value.map((b) => ({
      key: b.key,
      icon: b.icon,
      title: b.title,
      pluginName: pluginDisplayName(b.pluginId),
      // 卡片副标题：插件描述（面板名通常就等于插件名，副标题再用插件名等于写两遍同一句话）
      description: pluginDescription(b.pluginId),
    })),
  )

  /**
   * 当前主面板不可用 → 切到第一个「可见」面板。三类触发场景：
   * 1) 存档里的 mainPanel 指向的面板已不存在（插件被卸载后重启）；
   * 2) 使用中插件被停用 / 重载（槽位条目被撤销）；
   * 3) 功能开关把当前面板（或其它面板）关掉——含在设置独立窗口里改的情况（主窗口经
   *    settings-config-changed 重载 hiddenNavs，但 mainPanel 是主窗口自身的运行态、不会被带走，
   *    所以必须把可见性也纳入监听，否则会停在一个已经隐藏的面板上）。
   * 没有任何可见面板时 fallbackPanelFor 返回 null：保持当前面板不动，由下方空导航提醒兜底
   * （插件可能只是还没注册完，等它注册好本监听会再跑一次）。
   */
  const panelVisibilitySignature = computed(
    () =>
      `${panelSlotEntries.value.map((d) => d.key).join('\u0000')}\u0001${store.hiddenNavs.join('\u0000')}\u0001${store.mainPanel}`,
  )
  watch(
    panelVisibilitySignature,
    () => {
      const next = fallbackPanelFor(store.mainPanel, (key) => store.isNavVisible(key))
      if (next && next !== store.mainPanel) store.mainPanel = next
    },
    { immediate: true },
  )

  /**
   * 空导航：所有主面板都被关掉（插件面板也没有）→ 主界面没有任何可用页面。
   * 显示提醒（含「恢复默认导航」与「打开设置」），可用设置 → 通用 → 基础 → 空导航提醒 关掉。
   */
  const showEmptyNavNotice = computed(() => !navButtons.value.length && store.UI.emptyNavNotice !== false)

  /** 一键恢复：把内置模块与其它入口全部重新打开，并回到主页 */
  const restoreDefaultNavs = () => {
    store.hiddenNavs = []
    store.hiddenExtras = []
    store.mainPanel = '主页'
    store.saveConfig()
  }

  // ============ 顶栏标题自动隐藏（插件面板多了顶到标题时） ============
  // 顶栏是「导航按钮行 + 绝对定位的居中标题」并排：插件贡献的面板按钮一多，按钮行右边缘
  // 就会越过标题左边缘，图标压在标题文字上。这里按实际宽度判断——放不下就隐藏标题。
  const mainPanelRef = ref<HTMLElement | null>(null)
  const panelNavRef = ref<HTMLElement | null>(null)
  const panelTitleRef = ref<HTMLElement | null>(null)
  /** 标题放不下（被插件按钮顶到）→ 隐藏标题文字，只留图标 */
  const titleHidden = ref(false)
  let titleResizeObserver: ResizeObserver | null = null

  /**
   * 重新判断标题是否放得下。标题是 `left:50%` 居中的绝对定位元素（包含块 = `.panel-header`），两侧都要让得开：
   * - 左侧：导航按钮行的自然右边缘 = `offsetLeft + scrollWidth`（scrollWidth 不受收缩与横向滚动影响）；
   * - 右侧：窗口控制按钮组的最左边缘（跳过导航行 / 占位区 / 标题自己；display:none 的按钮不参与，否则 offsetLeft 为 0 会误判）；
   * - 标题用 `visibility` 隐藏而不是 `display:none`，隐藏后仍能测出宽度，窗口变宽 / 插件停用会自动恢复。
   * 所有比较对象都相对同一个 offsetParent `.panel-header`（它 position:relative、无边框无内边距），
   * 坐标全部用布局像素（offsetLeft / offsetWidth / clientWidth），不混用 getBoundingClientRect，
   * 以免窗口缩放（Ctrl +/-）下两套单位不一致。
   */
  function syncTitleVisibility() {
    // 注意：按钮行、标题、右侧按钮都是 .panel-header 的子元素（.mainPanel 只有 .panel-header 一个子节点），
    // 而且 .panel-header 有 position:relative，是它们的 offsetParent。所以基准必须是 .panel-header，
    // 否则 controlLeft 会把 .panel-header 自己（offsetLeft = 自己的 margin-left）当成最右侧按钮导致永远隐藏。
    const header = mainPanelRef.value?.querySelector<HTMLElement>('.panel-header') ?? null
    const nav = panelNavRef.value
    const title = panelTitleRef.value
    if (!header || !nav || !title) {
      titleHidden.value = false
      return
    }
    // 标题是 `left:50%` + `translate(-50%)`：offsetLeft 是「未加 transform 的左边缘」，
    // 而 transform 不参与 offsetLeft/offsetWidth，所以视觉左右边缘要各自再让开自身的半个宽度。
    const titleLeft = title.offsetLeft - title.offsetWidth / 2
    const titleRight = title.offsetLeft + title.offsetWidth / 2
    const navRight = nav.offsetLeft + nav.scrollWidth
    let controlLeft = header.clientWidth
    for (const el of Array.from(header.children) as HTMLElement[]) {
      if (el.classList.contains('panel-nav') || el.classList.contains('panel-title-spacer') || el.classList.contains('compact-title')) continue
      if (!el.offsetWidth) continue
      controlLeft = Math.min(controlLeft, el.offsetLeft)
    }
    titleHidden.value = navRight + 6 > titleLeft || titleRight + 6 > controlLeft
  }

  // 按钮数量（插件启停 / 功能开关）/ 标题文字（含自定义标题、语言）/ 导航布局 / 全屏隐藏外壳
  watch(
    () => [
      navButtons.value.map((b) => b.key).join('|'),
      panelTitle.value,
      store.UI.navLayout,
      panelChromeHidden.value,
    ],
    () => nextTick(syncTitleVisibility),
  )

  // ============ 导航栏插件图标收纳（fa fa-th-large 启动器） ============
  /**
   * 插件图标一多，导航栏就放不下（顶栏会盖住标题、底部 / 左侧栏会丢按钮）。
   * 这里的规则：
   *  - 内置 4 个面板永远留在导航栏（不参与收纳）；
   *  - 插件图标按**实际可用宽度**判定：放得下 → 照旧直接显示（点它切主面板，行为不变）；
   *    放不下 → **一个都不显示**，只在导航栏留一个 `fa fa-th-large` 图标，点开在主面板用 grid
   *    列出插件，再点具体插件以**子窗口**形态打开（见 store.openPluginPanel）。
   * 判定逻辑在 lib/plugin/navLauncher.ts（vue-free，可单测），这里只负责量 DOM 与联动。
   */
  const sideNavRef = ref<HTMLElement | null>(null)
  const bottomNavRef = ref<HTMLElement | null>(null)
  const navOverflow = ref<NavOverflowState>({ hiddenCount: 0, launcherVisible: false, shownCount: 0, maxRowWidth: 0 })
  let navResizeObserver: ResizeObserver | null = null

  /**
   * 真正渲染在导航栏里的插件按钮：**要么全显示、要么全不显示**。
   *
   * 收纳后一个都不渲染（导航栏上只留 `fa fa-th-large` 启动器）。用「过滤后的列表」而不是
   * 在 `v-for` 上加 `v-if`：Vue 3 里同一元素上的 `v-if` 优先级高于 `v-for`，拿不到循环变量。
   */
  const visiblePluginNavButtons = computed(() =>
    navOverflow.value.launcherVisible ? [] : pluginNavButtons.value,
  )

  /** 当前布局下「插件图标」所在的容器：顶栏 = .panel-nav；左/下导航 = 整个导航栏 */
  function navOverflowHost(): HTMLElement | null {
    if (isLeftNav.value) return sideNavRef.value
    if (isBottomNav.value) return bottomNavRef.value
    return panelNavRef.value
  }

  /**
   * 重新量一次并写回判定结果。
   *
   * ⚠️ 两条「绝不能破」的约束（踩过一次，表现为**白屏 / 加载层不消失 / CPU 占满一个核**）：
   *
   * 1) **本函数写回的 `navOverflow` 不允许出现在任何 watch 的依赖里**。曾经把
   *    `navOverflow.value.launcherVisible` 加进下面的 watch 源做「启动器出现后重量一次」，
   *    于是形成闭环：write → watch 触发 → `nextTick(syncNavOverflow)` → write → …。
   *    因为每一步都跨了一个微任务（`nextTick`），Vue 的「Maximum recursive updates」上限**拦不住**它，
   *    主线程被无限刷新的刷新任务占满 —— 页面永远画不出首帧，外部连 DevTools 都进不去（求值一律超时）。
   *    现在启动器出现后所需的那次重量由渲染后的 ResizeObserver 自然覆盖，不需要自己 watch 自己。
   *
   * 2) **值没变就不写**。判定结果变化会改变导航栏渲染（图标行 ↔ 聚合图标互换），
   *    而 ResizeObserver 观察到容器尺寸变化又会进来量一次。结果稳定时必须提前返回，
   *    否则「量 → 写 → 重排 → 再量」会一直循环下去，同样卡死主线程。
   *
   * 3) 判定所需的宽度**全部由 measureNavOverflow 自己量**，这里不碰 DOM、也不临时改样式。
   *    曾经为了量到聚合状态下的图标行而「先临时 display:flex 再关掉」——那条路既依赖判定结果
   *    又反过来影响结果（自引用），收起后就再也量不出「其实放得下」。现在聚合态改用内置图标当
   *    步距样例、可用宽度从顶栏推算，见 lib/plugin/navLauncher.ts 的 availableWidthForPlugins。
   */
  function syncNavOverflow() {
    const prev = navOverflow.value
    const layout = isLeftNav.value ? 'left' : isBottomNav.value ? 'bottom' : 'top'
    const next = measureNavOverflow(navOverflowHost(), layout, pluginNavButtons.value.length, prev.launcherVisible)
    if (
      prev.hiddenCount === next.hiddenCount
      && prev.launcherVisible === next.launcherVisible
      && prev.shownCount === next.shownCount
      && prev.maxRowWidth === next.maxRowWidth
    ) return
    navOverflow.value = next
  }

  /**
   * 拖动窗口边缘时防抖：ResizeObserver 在拖动过程中会连续触发，而导航栏在「图标行 ↔ 启动器」
   * 之间切换又会反过来改变布局 —— 叠加起来就是拖动时图标不停闪。尺寸停稳后再量，只切一次。
   */
  let navResizeTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleSyncNavOverflow() {
    if (navResizeTimer) clearTimeout(navResizeTimer)
    navResizeTimer = setTimeout(() => { navResizeTimer = null; syncNavOverflow() }, 140)
  }

  /**
   * 点启动器：在主面板位置显示插件网格（不切换 mainPanel，关掉后仍在原面板）。
   * 点网格里的插件 → 以子窗口形态打开（桌面）/ 应用内浮层（浏览器、安卓）。
   * 关闭网格由「点任一主面板导航按钮」（见 selectPanel）或再点一次启动器完成。
   */
  function togglePluginLauncher() {
    store.pluginLauncherOpen = !store.pluginLauncherOpen
    nextTick(syncNavOverflow)
  }

  /**
   * 点导航按钮切主面板（顶栏 / 左侧 / 底部三处导航共用同一个入口）。
   *
   * ⚠️ 模板里不能直接写 `store.mainPanel = btn.key`：收起「插件网格」挂在
   * `watch(() => store.mainPanel)` 上，而 watch **只在值真的变化时**才触发。
   * 已经在某个面板上再点它一次（最常见：点开插件启动器后点「主页」想回主页）值时没变，
   * 网格就不会收 —— 表现为「按钮悬浮有样式、点了没反应」（网格只是导航栏的入口页，
   * 它并不改 mainPanel，所以「当前面板」和「看到的页面」会一直对不上）。
   * 因此把「切面板」和「收网格」绑在同一个入口上，值没变时也照样收网格。
   */
  async function selectPanel(key: string) {
    // 切换主面板会卸载当前面板（主页右侧栏 / 知识管理的文件标签）：先让它们处理未保存内容，
    // 用户取消就留在原面板（见 store.registerLeaveGuard / runLeaveGuards）
    if (store.mainPanel !== key && !(await store.runLeaveGuards())) return
    // 先收网格再切面板：两处都在同一个 tick 内完成，不会先渲染网格再切走
    if (store.pluginLauncherOpen) store.pluginLauncherOpen = false
    store.mainPanel = key
  }

  /**
   * 点启动器网格里的插件 → 以子窗口形态打开（桌面）/ 应用内浮层（浏览器、安卓）。
   *
   * ⚠️ 这里**不关闭**启动器面板：用户是从网格里挑插件的，开一个还会继续开下一个
   * （对比「切主面板」才应该收起网格，见 watch(() => store.mainPanel)）。
   * 子窗口是独立窗口，主窗口的网格留在原地正好当「插件入口页」用。
   */
  function openPluginPanel(key: string) {
    const btn = pluginNavButtons.value.find((b) => b.key === key)
    void store.openPluginPanel({ key, pluginId: btn?.pluginId, title: btn?.title, icon: btn?.icon })
  }

  // 输入变化 → 重新判定。⚠️ 这里**只放输入**（按钮数量 / 布局 / 语言 / 启动器开关 / 外壳显隐），
  // 绝不能放判定结果本身（`navOverflow`）—— 否则就是「自己 watch 自己」的无限闭环，
  // 见 syncNavOverflow 上方注释（真实的卡死原因）。
  watch(
    () => [
      navButtons.value.map((b) => `${b.key}:${b.core ? 'c' : 'p'}`).join('|'),
      store.UI.navLayout,
      store.locales,
      store.pluginLauncherOpen,
      panelChromeHidden.value,
    ],
    () => nextTick(syncNavOverflow),
  )

  /**
   * 当前面板切换时把它的按钮滚进可视区：
   * 插件多到按钮行横向滚动时，否则会出现「切到了某个面板，却看不到高亮的按钮」。
   * 只改按钮行自己的 scrollLeft，不用 scrollIntoView（后者会连带滚动祖先容器）。
   */
  watch(
    () => store.mainPanel,
    () => nextTick(() => {
      const nav = panelNavRef.value
      const btn = nav?.querySelector<HTMLElement>('.active')
      if (!nav || !btn) return
      const gap = 5
      const left = btn.offsetLeft - nav.offsetLeft
      const right = left + btn.offsetWidth
      if (left - gap < nav.scrollLeft) nav.scrollLeft = Math.max(left - gap, 0)
      else if (right + gap > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = right + gap - nav.clientWidth
    }),
  )

  onMounted(async () => {
    // 检测是否在文件独立窗口中
    isFileWindow.value = window.location.hash.startsWith('#/file-view')
    // 检测是否在浏览器 Agent 独立窗口中
    isBrowserAgentWindow.value = window.location.hash.startsWith('#/browser-agent')
    // 检测是否在设置独立窗口中
    isSettingsWindow.value = window.location.hash.startsWith('#/settings-window')
    // 检测是否在插件面板子窗口中
    isPluginPanelWindow.value = window.location.hash.startsWith('#/plugin-panel')

    // 独立窗口也需要加载配置（主题等；loadConfig 为同步动作，返回后 store.lan 已就绪）
    store.loadConfig()
    // Qwen3-TTS 本地服务：勾了「随软件启动」且填了安装目录时，启动即静默拉起（不用再手动开 cmd）
    void store.ensureQwen3ServiceReady()
    // 生图服务（Qwen-Image-Edit-2511）：同上
    void store.ensurePythonAppReady('qwenImage')
    // 全局语音输入（唯一入口：热键 + 唯一 ASR 实例 + 唯一浮层状态；见 services/asr/globalVoice.ts）。
    // 每个窗口都初始化：主进程会把热键投递给**当前聚焦的那个窗口**，于是在设置窗口里也能直接说话输入。
    initGlobalVoice(store)
    // 局域网共享：启动即把「访客权限策略 + 主机模型」下发给主进程（见函数注释）
    void syncLanGuestPolicyAtStartup()
    // 主进程主动来拉（它每次重启都回到默认策略，而本窗口不会再挂载一次）→ 收到就重新下发
    getPlatform().events.on('lan:request-guest-policy', () => { void syncLanGuestPolicyAtStartup() })
    // 网页端（局域网访客）：向主机对齐模型来源（来源开关 / 地址 / 模型）——
    // 否则网页端用自己那份默认配置，会出现「主机能刷出的模型网页端刷不出来」「关掉的来源还在」
    if (!aikmIpcAvailable()) {
      void import('@/platform/lanHostLlm')
        .then((m) => m.syncHostLlmSources(store, true))
        .catch(() => { /* 主机不可达时保持默认配置 */ })
    }
    // 界面配置随软件分发：开启时以根目录 interface-config.json 覆盖界面配置（独立窗口同样生效）
    await store.loadRemoteInterfaceConfig()

    // 窗口缩放：桌面由主进程在窗口创建时按存档应用；安卓/网页没有主进程，启动时把存档比例落到根元素
    if (!hasCapability('window.chrome')) {
      getPlatform().window.setZoom((store.UI.windowZoom || 100) / 100).catch(() => { /* 缩放失败不影响使用 */ })
    }

    // 安卓系统返回手势 / 返回键：交给渲染层的界面栈处理（见 handleAndroidBack）
    if (isAndroid) {
      unregisterBack = getPlatform().app.onBackPressed(handleAndroidBack)
      // App 自己的两个浮层也登记为界面层（优先级见 BACK_ORDER）：设置浮层要盖住主面板里的
      // 模块内导航（否则设置打开时按返回会先去动背后的聊天列表），但排在设置内部导航之后。
      unregisterAppLayers.push(
        registerBackLayer({
          id: 'app:fileWindow',
          order: BACK_ORDER.fileWindow,
          canGoBack: () => !!store.fileWindowOverlay,
          goBack: () => store.closeFileWindowOverlay(),
        }),
        registerBackLayer({
          id: 'app:settings',
          order: BACK_ORDER.settingsOverlay,
          canGoBack: () => !!store.settingsOpen,
          goBack: () => closeSetPanel(),
        }),
      )
    }

    // 窗口缩放广播全局监听（Ctrl+Plus/Minus / 设置页调整），同步 store.UI.windowZoom
    // 注：只在根组件注册一次；平台层已用同一包装函数登记，退订可精确移除
    getPlatform().events.on('window:zoom-changed', (payload: any) => {
      if (payload && typeof payload.factor === 'number') {
        store.UI.windowZoom = Math.round(payload.factor * 100)
      }
    })

    // 「设置」独立窗口开合状态广播：桌面版设置不再走窗口内浮层，导航按钮高亮改由此驱动
    // 注意：只更新 settingsWindowOpen，绝不动 store.settingsOpen（那是主窗口内浮层的开关）
    getPlatform().events.on('settings-window-state', (payload: any) => {
      settingsWindowOpen.value = !!(payload && payload.open)
    })

    // 设置独立窗口写盘 → 其它窗口从 localStorage 重新同步配置。
    // ⚠️ 必须注册在下面「独立窗口提前 return」**之前**：子窗口（独立文件窗口/浏览器窗口）
    // 也需要跟着更新配置，否则设置里开了「协作」（collab.enabled 跟随服务运行状态），
    // 子窗口的协同按钮因 store 陈旧而始终不出现。
    if (!isSettingsWindow.value) {
      getPlatform().events.on('settings-config-changed', (payload: any) => {
        store.syncConfigFromPeers(payload?.ui, payload?.locales)
      })
    }

    // 托盘（托管区）任务上报：**独立窗口也要上报**（子窗口里跑的脚手架任务要能出现在托盘的
    // 后台任务列表里，托盘右键点它即可唤回该窗口；主进程按窗口分组，见 electron/main/tray-service.ts）
    watch(trayTasks, () => scheduleTrayPush(), { deep: true, immediate: true })

    if (isFileWindow.value || isBrowserAgentWindow.value || isSettingsWindow.value || isPluginPanelWindow.value) return // 独立窗口无需加载主界面数据

    // ============ 导航栏插件图标收纳：量一次 + 尺寸变化时重算 ============
    // 挂载后先判定一次（此时插件条目可能还没注册完，插件运行时同步完成后上面的 watch 会再触发）；
    // 之后用 ResizeObserver 盯住导航栏与顶栏（窗口缩放 / 拖动改宽 / 设置页改布局都会改变可用宽度）。
    nextTick(() => {
      syncNavOverflow()
      if (typeof ResizeObserver === 'undefined') return
      // 观察本身要防抖：拖动窗口边缘时观察者连续触发，而导航栏切换「图标行 ↔ 启动器」又会反过来
      // 改变布局，两边叠加就是拖动时图标不停闪（见 scheduleSyncNavOverflow）。
      navResizeObserver = new ResizeObserver(() => scheduleSyncNavOverflow())
      // 观察三种布局下各自的容器：布局切换后没被观察的那个会重新挂载 —— 所以三个都观察
      // （未挂载的 ref 为 null，直接跳过）。
      for (const el of [sideNavRef.value, bottomNavRef.value, panelNavRef.value, mainPanelRef.value?.querySelector<HTMLElement>('.panel-header') ?? null]) {
        if (el) navResizeObserver.observe(el)
      }
    })

    // ============ 文件类型关联（双击文件 / 系统「打开方式」） ============
    // 主进程把「需在主窗口内处理的文件请求」投递到这里（如 .kb 知识库 → 跳转「知识处理」）；
    // 其余文件按统一调度打开（现在一律开独立窗口，见 store.openFileByMode）；
    // 同时回报「渲染层已就绪」，主进程据此在挂载完成后投递排队中的请求（消息早于监听器注册会丢失）
    getPlatform().events.on('open-file-request', (payload: any) => {
      const p = typeof payload?.path === 'string' ? payload.path : ''
      if (!p) return
      if (p.toLowerCase().endsWith('.kb')) { store.openKbFile(p); return }
      const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
      const label = slash >= 0 ? p.substring(slash + 1) : p
      const dot = label.lastIndexOf('.')
      store.openFileByMode({ path: p, label, type: 'file', extension: dot >= 0 ? label.substring(dot).toLowerCase() : '' })
    })
    getPlatform().app.notifyUiReady().catch(() => {})

    // 关闭按钮行为以主进程配置为准（userData/app-behavior.json；设置页改动经 IPC 立即下发）
    getPlatform().app.getBehavior().then((res: any) => {
      if (res && typeof res.closeToTray === 'boolean') store.UI.closeToTray = res.closeToTray
    }).catch(() => {})

    // 托盘（托管区）任务提示：订阅后台作业事件（带进度）+ 首次拉取运行中的作业
    if (aikmDsh?.jobs) {
      aikmDsh.jobs.onEvent((ev: any) => applyJobEvent(ev?.job))
      aikmDsh.jobs.list().then((list: any[]) => {
        runningJobs.value = []
        for (const j of list || []) applyJobEvent(j)
      }).catch(() => {})
    }
    // 任务增减 / 进度变化即上报给主进程（节流见 scheduleTrayPush；已在上面注册，含独立窗口）

    // 初始状态：渲染进程重载（HMR/刷新）时设置窗口可能已经开着，主动查一次以免高亮丢失
    getPlatform().app.isSettingsWindowOpen().then((res: any) => {
      settingsWindowOpen.value = !!(res && res.open)
    }).catch(() => {})

    // 启动时自动检测AI连接状态，避免每次都要打开设置页面才能加载模型配置
    store.getAIconfig()
    // 顶栏标题自动隐藏：顶栏宽度变化（窗口缩放 / 侧栏开合 / 全屏外壳收起）都要重新判断，
    // 用 ResizeObserver 盯住顶栏本身（比监听 window.resize 更全，且不受窗口壳差异影响）
    if (mainPanelRef.value && typeof ResizeObserver !== 'undefined') {
      titleResizeObserver = new ResizeObserver(() => syncTitleVisibility())
      titleResizeObserver.observe(mainPanelRef.value)
    }
    syncTitleVisibility()
    // 注：文件树不再在启动时预加载，store.tree 仅在打开「知识管理」模块时由 panel.vue 加载，
    // 避免大工作区启动即全量扫描拖慢启动（view_graph/view_map 与该模块同渲染，数据就绪后 watch 自动更新）
  })

  onUnmounted(() => {
    unregisterBack?.()
    unregisterBack = null
    for (const off of unregisterAppLayers.splice(0)) off()
    titleResizeObserver?.disconnect()
    titleResizeObserver = null
    navResizeObserver?.disconnect()
    navResizeObserver = null
    if (navResizeTimer) { clearTimeout(navResizeTimer); navResizeTimer = null }
    // 释放全局语音输入：注销快捷键、拆监听、销毁麦克风采集图
    disposeGlobalVoice()
  })

  // 主面板切换即落盘（mainPanel 只在主窗口有意义）：
  // 否则共享 localStorage 里会长期残留旧值，任何一次 loadConfig（例如设置窗口保存后主窗口同步配置）
  // 或下次启动都会把导航拉回那个旧面板（现象：关掉设置子窗口后从「主页」跳回「学习」）。
  // 只写这一个键，避免整份 saveConfig（写 20+ 键、可能还落盘 interface-config.json）的开销。
  watch(() => store.mainPanel, (panel) => {
    // 换面板一定把外壳放回来：插件全屏时藏起了顶栏/导航栏，切走后不能让用户连导航都没有
    resetPanelChrome()
    // 切主面板时收起「插件网格」：网格是导航栏收纳后的入口页，不是主面板本身
    store.pluginLauncherOpen = false
    if (isSettingsWindow.value || isFileWindow.value || isBrowserAgentWindow.value || isPluginPanelWindow.value) return
    try { localStorage.setItem('mainPanel', JSON.stringify(panel)) } catch { /* 写盘失败不影响使用 */ }
  })

  function minimizeWindow() {
    getPlatform().window.minimize();
  }

  function maximizeWindow() {
    isMaximized.value=!isMaximized.value
    getPlatform().window.toggleMaximize();
  }

  // ============ 关闭保护：后台仍有任务在运行时先提醒 ============
  // 后台任务（脚手架采集/批量推理、聊天智能体、工作流、集群）在切换面板后仍继续执行，
  // 直接关窗会静默杀掉它们，因此点击关闭按钮时先提醒并阻止一次。
  // 收集「仍在运行」的任务名（去重）
  function collectRunningTasks(): string[] {
    const zh = store.locales === 'zh'
    const names = runningTaskNames(store.locales)
    if (globalExecutionStateRef.value.isExecuting) {
      const type = globalExecutionStateRef.value.executionType
      names.push(zh
        ? (type === 'workflow' ? '工作流执行' : '智能体会话')
        : (type === 'workflow' ? 'Workflow run' : 'Agent session'))
    }
    for (const chat of chatsRef.value || []) {
      if (chat?.isGenerating === true) { names.push(zh ? '对话生成' : 'Chat generation'); break }
    }
    for (const chat of chatsRef.value || []) {
      if ((chat?.messages || []).some((m: any) => m?.isExecuting === true)) {
        names.push(zh ? '智能体回答' : 'Agent reply')
        break
      }
    }
    if (swarmRunning.value) names.push(zh ? '智能体集群' : 'Agent swarm')
    return Array.from(new Set(names.filter(Boolean)))
  }

  // ============ 托盘（托管区）后台任务摘要 ============
  // 关闭行为设为「折叠到托管区」后，托盘图标悬停提示要展示后台任务数与进度。
  // 渲染层是任务状态的唯一汇总方（脚手架登记 / 执行状态 / 会话 / 集群 / 后台作业），
  // 因此在此汇总后经 `tray:status` 上报，主进程只负责展示（见 electron/main/tray-service.ts）。

  // 后台作业（job-registry：Agent turn / 知识库构建 / 集群执行…）带百分比进度；
  // 用 jobs:event 增量维护运行中的作业，避免频繁 jobs:list 往返
  const runningJobs = ref<{ id: string; title: string; progress: number | null; detail?: string }[]>([])
  function applyJobEvent(job: any) {
    if (!job || typeof job.id !== 'string') return
    const rest = runningJobs.value.filter(j => j.id !== job.id)
    if (job.status === 'running') {
      rest.push({
        id: job.id,
        title: String(job.title || job.kind || 'job'),
        progress: typeof job.progress === 'number' ? job.progress : null,
        detail: job.detail,
      })
    }
    runningJobs.value = rest
  }

  /** 托盘提示用的后台任务列表（名称 + 进度描述） */
  const trayTasks = computed<{ name: string; detail: string }[]>(() => {
    const zh = store.locales === 'zh'
    const out: { name: string; detail: string }[] = []
    const seen: string[] = []
    const push = (name: string, detail = '') => {
      if (!name || seen.indexOf(name) >= 0) return
      seen.push(name)
      out.push({ name, detail })
    }
    // 1) 后台作业（优先：带百分比进度）
    for (const j of runningJobs.value) {
      push(j.title, j.progress != null ? `${Math.round(j.progress)}%` : (j.detail || ''))
    }
    // 2) 脚手架任务（批量运行 / 文件采集 / 表格推理…）：带进度与预计剩余时间
    //    （脚手架计时器每秒上报 done/total/etaMs → 托盘悬停即可看到「12/50 · 剩 3分20秒」）
    //    多个窗口同时跑时由主进程按窗口分组（见 electron/main/tray-service.ts 的 buildMenu）
    for (const t of runningTaskList.value) {
      push(zh ? t.labelZh : t.labelEn, formatTaskProgressDetail(t.progress, zh))
    }
    // 3) 工作流 / 技能执行：currentStep 即当前进度描述
    const exec = globalExecutionStateRef.value
    if (exec.isExecuting) {
      push(zh
        ? (exec.executionType === 'workflow' ? '工作流执行' : '智能体执行')
        : (exec.executionType === 'workflow' ? 'Workflow run' : 'Agent run'),
        exec.currentStep || '')
    }
    // 4) 会话生成 / 智能体回答（按条数合并显示）
    let generating = 0
    let replying = 0
    for (const chat of chatsRef.value || []) {
      if (chat?.isGenerating === true) generating++
      if ((chat?.messages || []).some((m: any) => m?.isExecuting === true)) replying++
    }
    if (generating) push(zh ? `对话生成 ×${generating}` : `Chat generation ×${generating}`)
    if (replying) push(zh ? `智能体回答 ×${replying}` : `Agent reply ×${replying}`)
    // 5) 智能体集群
    if (swarmRunning.value) push(zh ? '智能体集群' : 'Agent swarm')
    return out
  })

  // 上报节流：任务进度可能高频变化，800ms 一次足够（空列表也上报，清掉托盘里的旧任务）
  let trayPushTimer: ReturnType<typeof setTimeout> | null = null
  function pushTrayStatus() {
    try {
      getPlatform().events.emit('tray:status', { items: trayTasks.value, locale: store.locales })
    } catch (e) { /* 无事件总线环境忽略 */ }
  }
  function scheduleTrayPush() {
    if (trayPushTimer) return
    trayPushTimer = setTimeout(() => { trayPushTimer = null; pushTrayStatus() }, 800)
  }

  // 提醒有效期（毫秒）：有效期内再次点击关闭按钮才真正退出
  // （既防误关闭，又不强迫用户先停掉任务再关软件）
  const CLOSE_WARN_MS = 6000
  let closeWarnUntil = 0
  let closeWarnTimer: ReturnType<typeof setTimeout> | null = null

  async function closeWindow() {
    // 关闭行为 = 折叠到托管区：窗口只是隐藏、后台任务继续运行，因此无需「任务运行中」二次确认
    if (!store.UI.closeToTray) {
      const running = collectRunningTasks()
      if (running.length > 0 && Date.now() >= closeWarnUntil) {
        const zh = store.locales === 'zh'
        const seconds = CLOSE_WARN_MS / 1000
        closeWarnUntil = Date.now() + CLOSE_WARN_MS
        if (closeWarnTimer) clearTimeout(closeWarnTimer)
        closeWarnTimer = setTimeout(() => { closeWarnUntil = 0 }, CLOSE_WARN_MS)
        ElMessage({
          type: 'warning',
          duration: CLOSE_WARN_MS,
          showClose: true,
          customClass: 'close-warn-message',
          message: zh
            ? `后台仍有任务在运行：${running.join('、')}。已阻止本次关闭；若确认退出，请在 ${seconds} 秒内再次点击关闭按钮。若希望关闭不中断任务，可在「设置 → 基础 → 关闭按钮行为」中选择「折叠到托管区」。`
            : `Background tasks are still running: ${running.join(', ')}. Close was blocked; click again within ${seconds}s to quit anyway. To keep tasks running on close, choose “Collapse to tray” under Settings → Basic → Close Button.`,
        })
        return
      }
    }
    // 文件标签里可能还有未保存内容：关窗前先让用户处理（保存 / 不保存 / 取消）
    if (!(await store.runLeaveGuards())) return
    store.saveConfig()
    getPlatform().window.close()
  }
  function closeSetPanel() {
    store.settingsOpen = false
  }

  /**
   * 安卓系统返回手势 / 返回键（渲染层界面栈，系统与 WebView 都不知道）。
   * 处理顺序（从内到外）：
   *
   * 1. 顶层 Element Plus 弹窗（确认框 / 抽屉，盖在所有内容之上）；
   * 2. 各模块登记的界面层（`platform/backLayers`）：应用内文件窗口 → 设置内子面板 →
   *    设置「分类列表 ⇄ 内容」→ 关闭设置 → 模块内导航（主页「聊天列表 ⇄ 对话」、
   *    知识管理「文件树抽屉 ⇄ 视图」…），由各模块自己声明，见 composables/useBackLayer；
   * 3. 主面板不是主页 → 回主页（安卓底部导航不一定常驻，返回手势是主要回退方式）；
   * 4. 已在主页根 → 连按两次退出应用。
   *
   * 返回 true 表示已处理（不退出应用）；false 表示交回系统默认（结束应用）。
   */
  const BACK_EXIT_MS = 2000
  let backExitUntil = 0
  /** 返回手势退订函数（安卓；组件卸载时解绑） */
  let unregisterBack: (() => void) | null = null
  /** App 自己登记的界面层退订函数（见 onMounted 里的 app:fileWindow / app:settings） */
  const unregisterAppLayers: Array<() => void> = []

  /** 关闭当前最上层的 Element Plus 弹窗（有的话）：返回是否真的点了关闭 */
  function closeTopDialog(): boolean {
    const overlays = Array.from(document.querySelectorAll('.el-overlay'))
    for (let i = overlays.length - 1; i >= 0; i--) {
      const el = overlays[i] as HTMLElement
      if (el.offsetParent === null && el.getClientRects().length === 0) continue
      const btn = el.querySelector<HTMLElement>('.el-message-box__close, .el-dialog__headerbtn, .el-drawer__close-btn')
      if (btn) {
        btn.click()
        return true
      }
    }
    return false
  }

  /**
   * 返回手势 / 返回键的「根面板」：主页可见时就是主页（原有行为）；
   * 主页被功能开关关掉时改用第一个可见面板，否则「先回主页」会把用户卡在看不见的主页上，
   * 连按两次退出的判定也永远不成立。
   */
  function backRootPanel(): string {
    if (store.isNavVisible('主页')) return '主页'
    return navButtons.value[0]?.key || '主页'
  }

  function handleAndroidBack(): boolean {
    if (closeTopDialog()) return true
    // 各模块登记的界面层 + App 自己的两个浮层（谁的层更靠内谁先处理）
    if (runTopBackLayer()) return true
    // 主面板不是根面板：先回根面板
    const root = backRootPanel()
    if (store.mainPanel !== root) {
      // 回主页同样要先处理文件标签的未保存内容（selectPanel 内部会跑守卫）
      void selectPanel(root)
      return true
    }
    // 已在主页根：连按两次才退出（与系统习惯一致，避免误退出）
    const now = Date.now()
    if (now < backExitUntil) return false
    backExitUntil = now + BACK_EXIT_MS
    const zh = store.locales === 'zh'
    ElMessage({
      type: 'info',
      duration: BACK_EXIT_MS,
      message: zh ? '再按一次返回退出应用' : 'Press back again to exit',
    })
    return true
  }

  // 应用内文件窗口（安卓 / 网页端）的重建键：只在**换文件 / 换视图**时重建（重新读盘、视图复位），
  // 同一文件再次打开（如文档里指向另一页的图表链接）只更新 page，由 FileWindow 自己换页。
  const fileWindowOverlayKey = computed(() => {
    const p: any = store.fileWindowOverlay
    return p ? `${p.path}|${p.view || ''}` : 'none'
  })

  // 打开「浏览器 Agent」独立窗口（多标签 + AI 可控制）；携带「浏览器默认页面」作为首个标签（仅手动打开生效）
  function openBrowserAgent() {
    const home = (store.UI?.browserHomeUrl || '').trim()
    getPlatform().browserAgent.call('open', { url: home }).catch(() => {})
  }
</script>

<template>
  <!-- 文件独立窗口模式 -->
  <FileWindow v-if="isFileWindow" style="position:fixed;top:0;left:0;right:0;bottom:0;width:100%;height:100%;" />

  <!-- 浏览器 Agent 独立窗口模式（地址栏/导航壳；网页内容由主进程 WebContentsView 承载于下方区域） -->
  <BrowserAgentShell v-else-if="isBrowserAgentWindow" style="position:fixed;top:0;left:0;right:0;bottom:0;width:100%;height:100%;" />

  <!-- 设置独立窗口模式：Set 自身顶栏即拖动区（standalone 模式附带最小化/最大化/关闭窗口按钮） -->
  <SetPanel v-else-if="isSettingsWindow" standalone :initial-nav="settingsWindowNav" style="position:fixed;top:0;left:0;right:0;bottom:0;width:100%;height:100%;" />

  <!-- 插件面板子窗口模式（导航栏收纳后的启动器打开的窗口；每个插件面板一个真窗口） -->
  <PluginPanelWindow
    v-else-if="isPluginPanelWindow"
    :plugin-key="pluginPanelWindowParams.key"
    style="position:fixed;top:0;left:0;right:0;bottom:0;width:100%;height:100%;"
  />

  <!-- 主界面（仅当既不是文件窗口也不是浏览器 Agent 窗口时显示） -->
  <div v-else class="container" :class="{ 'side-nav-mode': isLeftNav, 'web-mode': isBrowser, 'android-mode': isAndroid, 'tall-mode': isTallLayout, 'single-window-mode': store.singleWindowMode, 'chrome-hidden': panelChromeHidden }">
    <!-- 左侧导航栏（左侧布局模式显示：全部主面板按钮 + 设置；网页模式同样显示） -->
    <div v-if="isLeftNav" class="side-nav" ref="sideNavRef">
      <!-- 内置面板：始终显示（不参与收纳） -->
      <div
        v-for="btn in coreNavButtons"
        :key="btn.key"
        class="side-nav-item"
        :class="{ active: store.mainPanel == btn.key }"
        :data-core-key="btn.key"
        @click="selectPanel(btn.key)"
        :title="btn.title"
      >
        <i :class="btn.icon"></i>
      </div>

      <!-- 插件面板：放不下时**整体**收纳成下面的启动器（判定见 syncNavOverflow） -->
      <div
        v-for="btn in visiblePluginNavButtons"
        :key="btn.key"
        class="side-nav-item"
        :class="{ active: store.mainPanel == btn.key }"
        :data-plugin-key="btn.key"
        @click="selectPanel(btn.key)"
        :title="btn.title"
      >
        <i :class="btn.icon"></i>
      </div>

      <!-- 收纳后的启动器：fa fa-th-large，点开在主面板用 grid 列出插件 -->
      <div
        v-if="navOverflow.launcherVisible"
        class="side-nav-item nav-launcher"
        :class="{ active: store.pluginLauncherOpen }"
        @click="togglePluginLauncher"
        :title="store.locales === 'en' ? 'All plugins' : '全部插件'"
      >
        <i class="fa fa-th-large"></i>
      </div>

      <!-- 浏览器 Agent 独立窗口入口（非主面板，不切换 mainPanel；置于设置按钮左侧；可在「功能 → 导航与模块」里关掉） -->
      <div v-if="store.isExtraVisible('agent')" class="side-nav-item" @click="openBrowserAgent" :title="store.locales === 'en' ? 'Browser Agent' : '浏览器 Agent'">
        <i class="fa fa-globe"></i>
      </div>
      <div
        class="side-nav-item"
        :class="{ active: store.settingsOpen || settingsWindowOpen }"
        @click="store.openSettings()"
        :title="store.locales === 'en' ? 'Settings' : '设置'"
      >
        <i class="fa fa-cogs"></i>
      </div>
    </div>

    <!-- 右侧内容区：顶栏 + 主内容 -->
    <div class="main-column">
      <!-- 上方面板（顶栏）：网页模式同样显示，仅窗口控制按钮与浏览器 Agent 入口按能力隐藏 -->
      <div class="mainPanel" ref="mainPanelRef">
        <div class="panel-header" :class="{ 'panel-header-compact': isCompactTop }">
          <template v-if="!isCompactTop">
            <!-- 顶部导航布局（默认）：导航按钮 + 标题 + 右侧按钮
                 按钮来源 = panel.main 槽位注册表（内置 4 个 + 插件贡献），顺序由 order 决定；
                 插件按钮多到放不下时收纳成 fa fa-th-large 启动器（见 syncNavOverflow），
                 内置 4 个永远显示；标题被顶到时自动隐藏（见 syncTitleVisibility） -->
            <div class="panel-nav" ref="panelNavRef">
              <!-- 内置面板：不参与收纳 -->
              <div
                v-for="btn in coreNavButtons"
                :key="btn.key"
                :class="{ active: store.mainPanel == btn.key && !store.pluginLauncherOpen }"
                :data-core-key="btn.key"
                @click="selectPanel(btn.key)"
                :title="btn.title"
              ><i :class="btn.icon"></i></div>

              <!-- 插件面板：插件少时平铺在这里；放不下时整行隐藏，只留下面的聚合图标。
                   ⚠️ 用 v-show（不是 v-if）：聚合时这一行只是 display:none，行容器与判定用的
                   内置图标都还在，重量时不必临时改样式（判定全程只读 DOM，见 syncNavOverflow 第 3 条）。
                   行上的 data-plugin-row 是给判定层认「这一行就是被判定对象」用的。 -->
              <div v-show="!navOverflow.launcherVisible" class="panel-nav-plugins" data-plugin-row>
                <div
                  v-for="btn in visiblePluginNavButtons"
                  :key="btn.key"
                  :class="{ active: store.mainPanel == btn.key && !store.pluginLauncherOpen }"
                  :data-plugin-key="btn.key"
                  @click="selectPanel(btn.key)"
                  :title="btn.title"
                ><i :class="btn.icon"></i></div>
              </div>

              <!-- 聚合图标：只在插件图标放不下时出现（此时上面那行整行收起）。
                   nav-launcher 这个类名是给判定层排除「聚合图标」用的（决定平铺时它并不存在） -->
              <div
                v-if="navOverflow.launcherVisible"
                class="nav-launcher"
                :class="{ active: store.pluginLauncherOpen }"
                @click="togglePluginLauncher"
                :title="store.locales === 'en' ? 'All plugins' : '全部插件'"
              ><i class="fa fa-th-large"></i></div>
            </div>
            <!-- 弹性占位：将右侧按钮推到右端，同时作为顶栏可拖拽空白 -->
            <div class="panel-title-spacer" style="flex:1;"></div>
            <!-- 标题水平居中（各面板一致：仅文本，无图标）；放不下（被插件图标顶到）时隐藏 -->
            <div class="compact-title" :class="{ 'title-hidden': titleHidden }" ref="panelTitleRef"
                 style="font-size: 12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{{ panelTitle }}</div>

            <!-- 浏览器 Agent 入口：需要独立窗口 + 主进程 WebContentsView，网页模式不可用 -->
            <div v-if="store.isExtraVisible('agent') && hasCapability('window.chrome')" class="nav-narrow-hide" @click="openBrowserAgent" :title="store.locales === 'en' ? 'Browser Agent (AI-controllable browser window)' : '浏览器 Agent（AI 可控制的独立浏览器窗口）'"><i class="fa fa-globe"></i></div>
            <div :class="{active:store.settingsOpen || settingsWindowOpen}" @click="store.openSettings()" :title="store.locales === 'en' ? 'Settings' : '设置'"><i class="fa fa-cogs"></i></div>
            <div v-if="hasCapability('window.chrome')" class="nav-narrow-hide" @click="minimizeWindow" title="最小化">
              <i class="fa fa-minus"></i>
            </div>
            <div v-if="hasCapability('window.chrome')" class="nav-narrow-hide" @click="maximizeWindow" title="最大化/还原">
              <i class="fa" :class="isMaximized ? 'fa-compress' : 'fa-window-maximize'"></i>
            </div>
            <div v-if="hasCapability('window.chrome')" @click="closeWindow" :title="store.locales === 'en' ? 'Close' : '关闭'" style="font-size:16px;margin-top: 6px;margin-right: 6px;"><i class="fa fa-times"></i></div>
          </template>
          <template v-else>
            <!-- 左侧/下方导航布局：顶栏只保留标题 + 3 个窗口按钮（其余按钮在对应导航栏）；标题水平居中 -->
            <div class="compact-title" style="-webkit-app-region: drag;font-size: 12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{{ panelTitle }}</div>

            <!-- 窗口过窄时：标题收起，右侧只留 设置 + 关闭（设置按钮只在窄窗口出现，宽窗口仍用导航栏里的那个） -->
            <div class="nav-narrow-only" :class="{active:store.settingsOpen || settingsWindowOpen}" @click="store.openSettings()" :title="store.locales === 'en' ? 'Settings' : '设置'"><i class="fa fa-cogs"></i></div>
            <div v-if="hasCapability('window.chrome')" class="nav-narrow-hide" @click="minimizeWindow" title="最小化">
              <i class="fa fa-minus"></i>
            </div>
            <div v-if="hasCapability('window.chrome')" class="nav-narrow-hide" @click="maximizeWindow" title="最大化/还原">
              <i class="fa" :class="isMaximized ? 'fa-compress' : 'fa-window-maximize'"></i>
            </div>
            <div v-if="hasCapability('window.chrome')" @click="closeWindow" :title="store.locales === 'en' ? 'Close' : '关闭'" style="font-size:16px;margin-top: 6px;margin-right: 6px;"><i class="fa fa-times"></i></div>
          </template>
        </div>
      </div>
      
      <!-- 中间内容区域：面板由 panel.main 槽位解析（内置面板与插件面板走同一条路径） -->
      <div class="main">
        <!-- 插件收纳启动器：点开后主面板位置换成插件网格（grid 列出插件，点一张卡以子窗口打开） -->
        <PluginLauncherGrid
          v-if="store.pluginLauncherOpen"
          :entries="launcherEntries"
          :zh="store.locales !== 'en'"
          :highlight="store.mainPanel"
          :total-count="pluginTotalCount"
          :enabled-count="pluginEnabledCount"
          @select="openPluginPanel"
        />
        <!-- 空导航（所有功能关闭且没有插件面板）：给明确提醒 + 一键恢复 / 前往设置，而不是一片空白 -->
        <div v-else-if="showEmptyNavNotice" class="empty-nav-notice">
          <i class="fa fa-compass empty-nav-icon"></i>
          <div class="empty-nav-title">{{ store.locales === 'en' ? 'No page available' : '没有可用的页面' }}</div>
          <div class="empty-nav-text">
            {{ store.locales === 'en'
              ? 'All main-panel features are turned off and no plugin panel is enabled, so the main window has nothing to show. Turn a module back on under Settings → General → Basic → Navigation & Modules, or enable a plugin under Plugins → Manage.'
              : '所有主界面功能都已关闭，且没有启用的插件面板，主界面没有可显示的页面。请在「设置 → 通用 → 基础 → 导航与模块」中重新开启一个模块，或在「插件 → 管理」中启用插件。' }}
          </div>
          <div class="empty-nav-actions">
            <div class="button" @click="restoreDefaultNavs" :title="store.locales === 'en' ? 'Re-enable Home / Knowledge / Knowledge Processing / Learning and the Browser Agent entry' : '重新开启 主页 / 知识管理 / 知识处理 / 学习 与浏览器 Agent 入口'">
              <i class="fa fa-undo"></i> {{ store.locales === 'en' ? 'Restore default nav' : '恢复默认导航' }}
            </div>
            <div class="button" @click="store.openSettings()" :title="store.locales === 'en' ? 'Open settings' : '打开设置'">
              <i class="fa fa-cogs"></i> {{ store.locales === 'en' ? 'Open settings' : '打开设置' }}
            </div>
          </div>
          <div class="empty-nav-hint">
            {{ store.locales === 'en'
              ? 'This notice can be turned off under Settings → General → Basic → Empty Navbar Notice.'
              : '该提醒可在「设置 → 通用 → 基础 → 空导航提醒」中关闭。' }}
          </div>
        </div>
        <PluginSlot v-else :name="PANEL_MAIN_SLOT" :owner="store.mainPanel" />
      </div>
    </div>

    <!-- 底部导航栏（底部布局模式显示：全部主面板按钮 + 设置；网页模式同样显示） -->
    <div v-if="isBottomNav" class="bottom-nav" ref="bottomNavRef">
      <!-- 内置面板：始终显示（不参与收纳） -->
      <div
        v-for="btn in coreNavButtons"
        :key="btn.key"
        class="bottom-nav-item"
        :class="{ active: store.mainPanel == btn.key }"
        :data-core-key="btn.key"
        @click="selectPanel(btn.key)"
        :title="btn.title"
      >
        <i :class="btn.icon"></i>
      </div>

      <!-- 插件面板：插件少时平铺；放不下时整行收起成下面的聚合图标 -->
      <div
        v-for="btn in visiblePluginNavButtons"
        :key="btn.key"
        class="bottom-nav-item"
        :class="{ active: store.mainPanel == btn.key }"
        :data-plugin-key="btn.key"
        @click="selectPanel(btn.key)"
        :title="btn.title"
      >
        <i :class="btn.icon"></i>
      </div>

      <!-- 收纳后的启动器 -->
      <div
        v-if="navOverflow.launcherVisible"
        class="bottom-nav-item nav-launcher"
        :class="{ active: store.pluginLauncherOpen }"
        @click="togglePluginLauncher"
        :title="store.locales === 'en' ? 'All plugins' : '全部插件'"
      >
        <i class="fa fa-th-large"></i>
      </div>

      <!-- 浏览器 Agent 独立窗口入口（非主面板；置于设置按钮左侧；可在「功能 → 导航与模块」里关掉） -->
      <div v-if="store.isExtraVisible('agent')" class="bottom-nav-item" @click="openBrowserAgent" :title="store.locales === 'en' ? 'Browser Agent' : '浏览器 Agent'">
        <i class="fa fa-globe"></i>
      </div>
      <div
        class="bottom-nav-item"
        :class="{ active: store.settingsOpen || settingsWindowOpen }"
        @click="store.openSettings()"
        :title="store.locales === 'en' ? 'Settings' : '设置'"
      >
        <i class="fa fa-cogs"></i>
      </div>
    </div>
    
    <!-- 设置面板 -->
    <div v-if="store.settingsOpen" class="set-overlay" @click="closeSetPanel">
      <div class="settings-panel" @click.stop>
        <SetPanel/>
      </div>
    </div>
  </div> <!-- /.container (v-else) -->

  <!-- 应用内文件窗口（安卓 / 网页端等没有窗口壳的环境）：与设置浮层同样盖在主界面上方，
       使「打开文件」在这些平台上有可见反馈（原先独立窗口调用是空操作 → 点了没反应）。 -->
  <div v-if="store.fileWindowOverlay" class="file-window-overlay">
    <FileWindow
      :key="fileWindowOverlayKey"
      overlay
      :path="store.fileWindowOverlay.path"
      :view="store.fileWindowOverlay.view"
      :page="store.fileWindowOverlay.page"
      :remote-root-id="store.fileWindowOverlay.remoteRootId"
      :remote-rel="store.fileWindowOverlay.remoteRel"
      :label="store.fileWindowOverlay.label"
    />
  </div>

  <!-- 应用内插件面板浮层（浏览器 / 安卓等没有窗口壳的环境）：与文件窗口浮层同一做法，
       保证「点插件 → 以子窗口形态打开」在这些平台上也有可见反馈（独立窗口调用是空操作）。 -->
  <div v-if="store.pluginPanelOverlay" class="plugin-panel-overlay" :class="{ 'single-window': store.singleWindowMode }" @click="store.closePluginPanelOverlay()">
    <div class="plugin-panel-dialog" @click.stop>
      <div class="plugin-panel-dialog-close" @click="store.closePluginPanelOverlay()"
           :title="store.locales === 'en' ? 'Close' : '关闭'"><i class="fa fa-times"></i></div>
      <PluginPanelWindow :plugin-key="store.pluginPanelOverlay.key" overlay />
    </div>
  </div>

  <!-- ask_user 结构化问答弹窗（全局唯一宿主：聊天 / 集群 / 控制台 / 工作流共用） -->
  <AskUserHost />
  <!-- exit_plan_mode 计划评审弹窗（全局唯一宿主：Approve / 继续完善 / 关闭） -->
  <PlanReviewHost />
  <!-- 全局语音输入提示（唯一的视觉元素：录音波形 / 实时文字 / 落点 / 结束与取消）。
       放在所有窗口模式之外：主界面、文件窗口、浏览器 Agent 窗口、设置独立窗口共用同一个浮层 -->
  <VoiceInputOverlay />
</template>

<style scoped>
  /* 应用内文件窗口浮层（单窗口环境）：铺满主界面，叠在设置浮层之下（设置 1500）、
     Element Plus 弹窗（2000+）之上——文件窗口里的确认框 / 提示仍需可见。 */
  .file-window-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 1400;
    background: var(--backgroundColor);
  }

  .set-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    /* 高于普通右键菜单/子面板（1000~1002），但低于 Element Plus 弹窗（nextZIndex 从 2000 递增，
       如消息框/确认框默认 2001+），否则设置页里的确认弹窗 / 消息提示会被本设置层盖住。
       注意：ElMessageBox 等命令式弹窗不会继承 el-config-provider 的 zIndex（appContext 为 null），
       因此只能靠压低本层 z-index 使其低于 2000 来露出弹窗。 */
    z-index: 1500;
    display: flex;
    align-items: center;
    justify-content: center;
    /* 半透明遮罩：让设置面板呈"对话框"观感，点击空白处关闭 */
    background-color: rgba(0, 0, 0, 0.35);
  }

  .settings-panel {
    /* 更像对话框：居中、限宽限高、四周留白、圆角 */
    width: min(1280px, calc(100% - 96px));
    height: min(720px, calc(100% - 96px));
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
  }

  /* 应用内插件面板浮层（浏览器 / 安卓）：铺满主界面、居中一个「子窗口」形状的对话框，
     视觉上与桌面版真正的独立子窗口一致（顶栏 + 插件内容 + 右上关闭） */
  .plugin-panel-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 1450;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: rgba(0, 0, 0, 0.35);
  }
  .plugin-panel-dialog {
    position: relative;
    width: min(1100px, calc(100% - 40px));
    height: min(760px, calc(100% - 40px));
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
  }
  /* 浮层里的「关闭」：叠在壳顶栏右上角（壳自己不带窗口按钮）。
     浮层形态下壳顶栏**不渲染**启动器图标，所以这里不会和它抢位置。 */
  .plugin-panel-dialog-close {
    position: absolute;
    top: 5px;
    right: 6px;
    z-index: 2;
    width: 30px;
    height: 30px;
    line-height: 30px;
    text-align: center;
    border-radius: 5px;
    font-size: 16px;
    cursor: pointer;
    color: var(--fontColor);
  }
  .plugin-panel-dialog-close:hover {
    color: var(--fontActiveColor);
    background-color: var(--menuActiveColor);
  }
  /* 安卓 / 细长窗口：浮层里的插件面板整页铺满（与设置浮层同一处理） */
  .container.android-mode .plugin-panel-dialog,
  .container.tall-mode .plugin-panel-dialog {
    width: 100%;
    height: 100%;
    border-radius: 0;
  }

  /* 安卓 / 细长窗口（高宽比 > 16:9，如手机竖屏）：设置整页铺满（手机上浮层对话框太挤，
     设置内部再按「分类列表 ⇄ 设置内容」整屏切换，见 Set.vue 的 .tall）；顶部的窗口按钮也不适用 */
  .container.android-mode .set-overlay,
  .container.tall-mode .set-overlay,
  /* 单窗口模式：设置也是一页（桌面同样如此），不再用居中对话框 */
  .container.single-window-mode .set-overlay {
    background-color: transparent;
  }
  .container.android-mode .settings-panel,
  .container.tall-mode .settings-panel,
  .container.single-window-mode .settings-panel {
    width: 100%;
    height: 100%;
    border-radius: 0;
    box-shadow: none;
  }
  /* 单窗口模式：插件面板浮层同样整页铺满（与安卓 / 细长窗口一致）。
     注意插件浮层挂在 .container 之外，所以类名挂在浮层自己身上。 */
  .plugin-panel-overlay.single-window .plugin-panel-dialog {
    width: 100%;
    height: 100%;
    border-radius: 0;
  }
    
  /* 插件请求全屏（ctx.app.setChromeHidden(true)）时：顶栏 / 左侧导航 / 底部导航整块收起来，
     画面拿到整个窗口。用 display:none 真隐藏（不是被盖住）——层叠、缩放、WebView 差异都不影响。 */
  .container.chrome-hidden .mainPanel,
  .container.chrome-hidden .side-nav,
  .container.chrome-hidden .bottom-nav {
    display: none;
  }

  /* 网页模式（LAN 共享）：顶栏不再是窗口拖动区（-webkit-app-region 在浏览器里无效），
     去掉移动光标；窗口控制按钮已按 window.chrome 能力隐藏 */
  .container.web-mode .panel-header {
    cursor: default;
  }

  /* 左侧主面板 */
  .mainPanel {
    width: fit-content;
    min-width: 100%;
    height: 39px;
    background-color: var(--menuColor);
    border-right: 1px solid var(--borderColor);
    transition: width 0.1s ease;
    display: flex;
    position: relative;
    z-index: 10;
    border: var(--borderColor) 1px solid;
  }

  /* 隐藏状态 */
  .mainPanel.panel-hide {
    width: 0;
    min-width: 0;
    opacity: 0;
    border-right: none;
  }

  /* 拖拽条 */
  .mainPanel .panel-draggable {
    position: absolute;
    right: 0;
    top: 0;
    width: 5px;
    height: 100%;
    cursor: ew-resize;
    z-index: 11;
  }

  .mainPanel .panel-draggable:hover {
    background-color: var(--menuActiveColor);
    opacity: 0.5;
  }

  /* 面板头部（图标栏） */
  .panel-header {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: row;
    align-items: center;
    padding: 0;
    user-select: none;
    margin-left: 5px;
    /* 整个顶栏（含空白区域）均可拖动窗口 */
    position: relative;
    -webkit-app-region: drag;
    cursor: move;
  }

  /* 顶栏图标按钮（导航按钮 / 右侧按钮）：除导航按钮行容器、插件图标行、居中标题与弹性占位区外统一 30×30。
     不能只写 :not(.panel-nav)：`:not()` 会把 .panel-nav 的类选择器权重算进来（0,2,1），
     高于 .panel-header .compact-title（0,2,0），于是 width:30px 会盖掉标题的 width:auto，
     标题被压成 30px 宽（12px 字号下只能看到两个字）。同理 hover 背景也会糊到标题和空白拖拽区上。
     ⚠️ `.panel-nav-plugins`（插件图标行）也必须排除：它是**容器**不是图标，被这条钉成 30px 宽后
     行内十几个插件图标只剩最左边一个可见（其余被 overflow:hidden 裁掉）—— 表现为「后面的插件图标被遮住」。
     该排除还顺带避免了 hover 背景糊到整行上。这一条的权重是 (0,4,1)，比下面
     `.panel-header .panel-nav > .panel-nav-plugins`(0,3,0) 高，所以只能靠排除、不能靠覆盖。 */
  .panel-header div:not(.panel-nav):not(.panel-nav-plugins):not(.compact-title):not(.panel-title-spacer) {
    width: 30px;
    height: 30px;
    line-height: 30px;
    margin: 0px 5px 0px 0px;
    text-align: center;
    border-radius: 5px;
    font-size: 16px;
    color: var(--fontColor);
    cursor: pointer;
    transition: all 0.25s ease;
  }

  .panel-header div:not(.panel-nav):not(.panel-nav-plugins):not(.compact-title):not(.panel-title-spacer):hover {
    color: var(--fontActiveColor);
    background-color: var(--menuActiveColor);
  }

  .panel-header div:not(.panel-nav):not(.panel-nav-plugins):not(.compact-title):not(.panel-title-spacer).active {
    color: var(--fontActiveColor);
    background-color: var(--menuActiveColor);
  }

  /* 拖拽区域（左侧/下方布局里声明了 app-region: drag 的拖拽条）：
     居中标题也带 drag（它就是拖动区），但它不是拖拽条，不能跟着变半透明，因此排除掉 */
  .panel-header div[style*="drag"]:not(.compact-title) {
    cursor: move;
    opacity: 0.3;
  }

  .panel-header div[style*="drag"]:not(.compact-title):hover {
    background-color: transparent;
  }

  /* 设置按钮（只认顶栏的直接子元素：导航按钮行里的最后一个按钮不算） */
  .panel-header > div:last-child {
    margin-top: auto;
    margin-bottom: 5px;
  }

  /* 顶栏按钮保持可点击（标题、占位拖拽区与导航按钮行除外），且固定尺寸不被压缩 */
  .panel-header > div:not(.compact-title):not(.panel-title-spacer):not(.panel-nav) {
    -webkit-app-region: no-drag;
    flex: 0 0 auto;
  }

  /* 导航按钮行（内置模块 + 插件面板）：插件多时本行横向滚动而不撑破顶栏
     （滚动条隐藏；鼠标滚轮 / 触控板横向滚动即可看到后面的按钮），
     同时由 syncTitleVisibility() 判断标题放不下就隐藏（见 .title-hidden） */
  .panel-header .panel-nav {
    display: flex;
    flex-direction: row;
    align-items: center;
    height: 100%;
    flex: 0 1 auto;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    -ms-overflow-style: none;
    /* 按钮行必须声明为可交互区：否则整块继承顶栏的 app-region: drag，点击被系统拖拽吞掉 */
    -webkit-app-region: no-drag;
  }
  .panel-header .panel-nav::-webkit-scrollbar {
    width: 0;
    height: 0;
    display: none;
  }
  /* 导航按钮固定 30px 宽、不参与压缩：空间不够时由上面的容器横向滚动（而不是把图标挤扁）。
     注：这条也会命中插件图标行（它也是 .panel-nav 的直接 div 子元素），但下面
     `.panel-nav > .panel-nav-plugins`（权重更高）会把 flex 改回「按内容取宽、不收缩」。 */
  .panel-header .panel-nav > div {
    flex: 0 0 30px;
  }
  /* 插件按钮行：与内置按钮同一行、同一间距。
     插件少时**平铺**在导航栏里（一行排开）；放不下时整行收起，导航栏只留聚合图标。
     ⚠️ 行容器是**容器**：宽度必须是内容宽（`width:auto` + 不收缩 `0 0 auto`）。
     它曾被上面那条通用规则（`.panel-header div:not(...)`，权重 0,4,1）钉成 30px 宽，
     于是十几个插件图标全被压在 30px 里裁掉 —— 已把该行从那条规则里排除（见上文注释），
     这里再显式写死 `width:auto` 兜底：容器一旦被压窄，判定与渲染都会跟着错。 */
  .panel-header .panel-nav > .panel-nav-plugins {
    display: flex;
    flex-direction: row;
    align-items: center;
    width: auto;
    overflow: hidden;
    flex: 0 0 auto;
  }
  /* 行内的插件图标：固定 30px、不参与压缩。
     ⚠️ 必须单独写：上面 `.panel-nav > div` 只命中 `.panel-nav` 的**直接**子元素，
     行内图标是孙子节点，少了这条它们会被 flex 压扁、叠在一起。 */
  .panel-header .panel-nav > .panel-nav-plugins > div {
    flex: 0 0 30px;
  }
  /* 行内最后一个图标不留右间距：判定按「图标宽 + 右间距」算总宽，末位不留才不会多算一格 */
  .panel-header .panel-nav > .panel-nav-plugins > div:last-child {
    margin-right: 0;
  }
  /* 标题水平居中（顶部/左侧/下方布局通用，避免右侧按钮占位导致标题偏左） */
  .panel-header .compact-title {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: auto;
    max-width: 60%;
    margin: 0;
    text-align: center;
  }
  /* 标题/脚手架选择器 hover 不显示 menuActiveColor 背景，保持与标题栏一致 */
  .panel-header .compact-title:hover {
    background-color: transparent;
    color: var(--fontColor);
  }
  /* 标题放不下（被插件图标顶到）时只隐藏文字：保留宽度测量，窗口变宽 / 插件停用后自动恢复 */
  .panel-header .compact-title.title-hidden {
    visibility: hidden;
  }
  /* 左侧/下方布局：右侧窗口按钮靠右 */
  .panel-header-compact {
    justify-content: flex-end;
  }

  /* 窗口过窄（< 600px）：顶栏右侧只留「设置 + 关闭」（标题、浏览器 Agent 入口、最小化 / 最大化收起），
     避免图标挤在一起；设置按钮在左侧/下方导航布局里本就常驻导航栏，这里只在窄窗口补一个 */
  .panel-header .nav-narrow-only {
    display: none;
  }
  @media (max-width: 600px) {
    .panel-header .compact-title { display: none; }
    .panel-header .nav-narrow-hide { display: none; }
    .panel-header .nav-narrow-only { display: block; }
  }

  /* ============ 左侧导航布局 ============ */
  /* 左侧导航模式：容器改为横向排列（左侧栏 + 右侧内容区） */
  .container.side-nav-mode {
    flex-direction: row;
  }

  /* 左侧导航栏：**从上到下**按文档顺序排列（主页 → 知识管理 → … → 设置）。
     ⚠️ 这里曾经用 `column-reverse` + `justify-content: flex-end` 想把整块内容贴底，
     但 column-reverse 会连同**条目顺序**一起翻转（第一个条目跑到最下面），看起来就是导航栏反了。
     现在改为正常 `column` + 贴顶排列：顺序与文档一致；插件放不下时仍由收纳逻辑
     （fa fa-th-large 启动器）接管，不会把设置按钮挤出可视区。 */
  .side-nav {
    width: 44px;
    flex-shrink: 0;
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    align-items: center;
    padding: 4px 2px;
    gap: 2px;
    overflow: hidden;
    background-color: var(--menuColor);
    border-right: 1px solid var(--borderColor);
    user-select: none;
    /* 空白区域可拖动窗口 */
    -webkit-app-region: drag;
    cursor: move;
  }

  .side-nav-item {
    width: 38px;
    height: 36px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    cursor: pointer;
    color: var(--fontColor);
    font-size: 15px;
    transition: all 0.25s ease;
    /* 按钮本身保持可点击 */
    -webkit-app-region: no-drag;
  }
  .side-nav-item:hover,
  .side-nav-item.active {
    color: var(--fontActiveColor);
    background-color: var(--menuActiveColor);
  }
  /* ============ 下方导航布局 ============ */
  /* 底部导航栏 */
  .bottom-nav {
    flex-shrink: 0;
    height: 44px;
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: center;
    gap: 2px;
    padding: 0 8px;
    overflow-x: auto;
    overflow-y: hidden;
    background-color: var(--menuColor);
    border-top: 1px solid var(--borderColor);
    user-select: none;
    /* 空白区域可拖动窗口 */
    -webkit-app-region: drag;
    cursor: move;
  }

  .bottom-nav-item {
    width: 38px;
    height: 36px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    cursor: pointer;
    color: var(--fontColor);
    font-size: 15px;
    transition: all 0.25s ease;
    /* 按钮本身保持可点击 */
    -webkit-app-region: no-drag;
  }
  .bottom-nav-item:hover,
  .bottom-nav-item.active {
    color: var(--fontActiveColor);
    background-color: var(--menuActiveColor);
  }

  /* 插件收纳启动器（fa fa-th-large）：与普通导航按钮同样式，只是**不参与收缩 / 不被裁掉**——
     布局放不下时它是被收纳插件的唯一入口，必须留在可视区 */
  .side-nav > .side-nav-item.nav-launcher,
  .bottom-nav > .bottom-nav-item.nav-launcher {
    flex-shrink: 0;
  }
  /* 右侧内容区（顶栏 + 主内容纵向排列） */
  .main-column {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  /* 面板容器：显式给出高度与溢出策略，让「插件面板」这类外部内容也能内部滚动
     （否则超过视口高度的内容会被直接裁掉、看不到滚动条） */
  .main {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  /* ====== 空导航提醒（所有功能关闭且没有插件面板时） ====== */
  .empty-nav-notice {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 20px;
    text-align: center;
    color: var(--fontColor);
    background-color: var(--backgroundColor);
    overflow: auto;
  }
  .empty-nav-notice .empty-nav-icon {
    font-size: 34px;
    opacity: 0.35;
    margin-bottom: 2px;
  }
  .empty-nav-notice .empty-nav-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--fontActiveColor);
  }
  .empty-nav-notice .empty-nav-text {
    max-width: 460px;
    font-size: 12px;
    line-height: 1.6;
    opacity: 0.8;
  }
  .empty-nav-notice .empty-nav-actions {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 4px;
  }
  .empty-nav-notice .empty-nav-actions .button {
    width: auto;
    padding: 6px 12px;
    border: 1px solid var(--borderColor);
    border-radius: 5px;
    background-color: var(--menuColor);
    color: var(--fontColor);
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 13px;
    transition: all 0.2s ease;
  }
  .empty-nav-notice .empty-nav-actions .button:hover {
    background-color: var(--menuActiveColor);
    color: var(--fontActiveColor);
  }
  .empty-nav-notice .empty-nav-hint {
    font-size: 10px;
    opacity: 0.55;
    margin-top: 2px;
  }
</style>

<!-- 全局（非 scoped）样式：Element Plus 的 ElMessage 挂载在 body 上，scoped 样式命中不到 -->
<style>
  /* 关闭前提醒：任务名可能较长/较多，允许换行并限宽，避免文案被截断或撑出屏幕 */
  .el-message.close-warn-message {
    max-width: min(560px, calc(92vw / var(--ui-zoom, 1)));
    height: auto;
    padding: 10px 14px;
    align-items: flex-start;
  }
  .el-message.close-warn-message .el-message__content {
    white-space: normal;
    line-height: 1.5;
    word-break: break-word;
    /* 让出右侧关闭按钮的位置（EP 关闭按钮绝对定位在 right:15px） */
    padding-right: 18px;
  }
</style>