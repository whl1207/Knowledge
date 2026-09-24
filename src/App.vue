<script setup lang="ts">
  import {ref, onMounted, onUnmounted, computed, watch, h, defineAsyncComponent} from 'vue'
  import {usestore} from '@/store'
  import { ElMessage } from 'element-plus'
  // 后台运行态（均为模块级 ref，跨组件卸载存活）：
  //  - globalExecutionState/chats：聊天智能体、工作流、流式生成
  //  - swarmRunning：智能体集群
  //  - runningTaskNames：各脚手架自行登记（见 store/runningTasks.ts）
  import { globalExecutionStateRef, chatsRef } from '@/store/chats'
  import { runningTaskNames, runningTaskList, runningTaskInstanceId } from '@/store/runningTasks'
  import { formatTaskProgressDetail } from '@/utils/taskProgress'
  import { running as swarmRunning } from '@/store/swarmState'
  const store=usestore()

  // 首屏主页保持静态加载；其余主面板改为按需异步加载（defineAsyncComponent）：
  // 大幅缩减首屏 JS 体积——Monaco/图谱/地图/PPT/Excalidraw 等重型依赖只在对应模块打开时才加载
  import home from '@/components/home.vue'
  // 异步面板加载中的占位（加载超过 delay 才显示，正常本地加载不会闪现）；
  // 背景取应用主题色，使「预载遮罩 → 占位 → 内容」无缝衔接，避免白缝
  const asyncLoading = () => h('div', {
    style: 'height:100%;width:100%;background:var(--backgroundColor,#ffffff);display:flex;align-items:center;justify-content:center;color:#888;'
  }, [h('i', { class: 'fa fa-spinner fa-spin', style: 'font-size:16px;' })])
  const lazyPanel = (loader: () => Promise<any>) =>
    defineAsyncComponent({ loader, loadingComponent: asyncLoading })
  const explorer = lazyPanel(() => import('@/components/knowFile/explorer.vue'))
  const knowledge = lazyPanel(() => import('@/components/knowRAG/knowRAG.vue'))
  const learning = lazyPanel(() => import('@/components/learning/learning.vue'))
  const flow = lazyPanel(() => import('@/components/workFlow/workFlow.vue'))
  const ToDo = lazyPanel(() => import('@/components/todos/ToDo.vue'))
  const AgentScaffoldPanel = lazyPanel(() => import('@/components/AgentScaffold/AgentScaffold.vue'))
  // 「数据画布」独立主面板（原 Agent脚手架模块之一，已独立为顶层导航）
  const CanvasPanel = lazyPanel(() => import('@/components/DataCanvas/CanvasPanel.vue'))
  // ⚠️ 变量名不能叫 Set：会遮蔽全局 Set 构造函数，导致下方 collectRunningTasks 里的 `new Set(...)`
  // 抛 “Set is not a constructor”（关闭窗口时才触发，不易发现）
  const SetPanel = lazyPanel(() => import('@/components/set/Set.vue'))
  const FileWindow = lazyPanel(() => import('@/components/knowFile/FileWindow.vue'))
  // 浏览器模块独立于 knowFile：网页浏览、AI 会话、收藏/离线保存等均在独立窗口内完成
  const BrowserAgentShell = lazyPanel(() => import('@/components/browser/BrowserAgentShell.vue'))
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
  // 设置独立窗口的初始导航分类：主进程以 #/settings-window?nav=xxx 传入（如从 AgentSwarm 跳「预设」）
  const settingsWindowNav = (() => {
    const h = typeof window !== 'undefined' ? window.location.hash : ''
    const q = h.indexOf('?')
    if (q < 0) return ''
    try { return new URLSearchParams(h.substring(q + 1)).get('nav') || '' } catch { return '' }
  })()
  const isBrowser = typeof window !== 'undefined' && !(window as any).ipcRenderer // 浏览器模式（LAN 共享）
  store.setTheme()

  // 计算标题文本
  const panelTitle = computed(() => {
    // 自定义标题：界面设置中定义后固定不变，不再随当前面板变化
    if (store.customTitle && store.customTitle.trim()) {
      return store.customTitle
    }
    if (store.locales === 'en') {
      switch(store.mainPanel) {
        case '主页': return 'home';
        case '知识管理': return 'Knowledge Management';
        case '知识处理': return 'Knowledge Processing';
        case '学习': return 'Learning';
        case '工作流管理': return 'Workflow';
        case '数据画布': return 'Data Canvas';
        case '待办管理': return 'Todo Management';
        default: return store.mainPanel;
      }
    }
    return store.mainPanel; // 默认使用中文
  })

  // 导航栏布局：left=左侧导航 / bottom=下方导航（默认 top=顶部导航）
  const isLeftNav = computed(() => store.UI.navLayout === 'left')
  const isBottomNav = computed(() => store.UI.navLayout === 'bottom')
  // 左侧/下方布局下，顶栏只保留标题 + 4 个窗口按钮
  const isCompactTop = computed(() => isLeftNav.value || isBottomNav.value)

  // 主面板导航按钮（左侧/下方布局模式下全部集中显示在对应导航栏；顶部模式下按钮仍保持在顶栏原位置）
  const navButtons = computed(() => {
    const zh = store.locales === 'zh'
    return [
      { key: '主页', icon: 'fa fa-home', title: zh ? '主页' : 'Home' },
      { key: '知识管理', icon: 'fa fa-book', title: zh ? '知识管理' : 'Knowledge Management' },
      { key: '知识处理', icon: 'fa fa-stack-overflow', title: zh ? '知识处理' : 'Knowledge Processing' },
      { key: '学习', icon: 'fa fa-graduation-cap', title: zh ? '学习' : 'Learning' },
      { key: '工作流管理', icon: 'fa fa-stumbleupon', title: zh ? '工作流管理' : 'Workflow' },
      { key: '数据画布', icon: 'fa fa-object-group', title: zh ? '数据画布' : 'Data Canvas' },
      { key: 'Agent脚手架', icon: 'fa fa-deviantart', title: zh ? 'Agent脚手架' : 'Agent Scaffold' },
      { key: '待办管理', icon: 'fa fa-lightbulb-o', title: zh ? '待办管理' : 'Todo Management' },
      // 功能开关：被隐藏的按钮不显示（设置页「界面-功能开关」）
    ].filter(btn => store.isNavVisible(btn.key))
  })

  onMounted(async () => {
    // 检测是否在文件独立窗口中
    isFileWindow.value = window.location.hash.startsWith('#/file-view')
    // 检测是否在浏览器 Agent 独立窗口中
    isBrowserAgentWindow.value = window.location.hash.startsWith('#/browser-agent')
    // 检测是否在设置独立窗口中
    isSettingsWindow.value = window.location.hash.startsWith('#/settings-window')

    // 独立窗口也需要加载配置（主题等）
    store.loadConfig()
    // 界面配置随软件分发：开启时以根目录 interface-config.json 覆盖界面配置（独立窗口同样生效）
    await store.loadRemoteInterfaceConfig()

    // 窗口缩放广播全局监听（Ctrl+Plus/Minus / 设置页调整），同步 store.UI.windowZoom
    // 注：preload 的 on() 会包一层匿名 wrapper，off() 无法按原引用移除，故只在根组件注册一次
    window.ipcRenderer?.on('window:zoom-changed', (_e: any, payload: any) => {
      if (payload && typeof payload.factor === 'number') {
        store.UI.windowZoom = Math.round(payload.factor * 100)
      }
    })

    // 「设置」独立窗口开合状态广播：桌面版设置不再走窗口内浮层，导航按钮高亮改由此驱动
    // 注意：只更新 settingsWindowOpen，绝不动 store.settingsOpen（那是主窗口内浮层的开关）
    window.ipcRenderer?.on('settings-window-state', (_e: any, payload: any) => {
      settingsWindowOpen.value = !!(payload && payload.open)
    })

    // 设置独立窗口写盘 → 其它窗口从 localStorage 重新同步配置。
    // ⚠️ 必须注册在下面「独立窗口提前 return」**之前**：子窗口（独立文件窗口/浏览器窗口）
    // 也需要跟着更新配置，否则设置里开了「协作」（collab.enabled 跟随服务运行状态），
    // 子窗口的协同按钮因 store 陈旧而始终不出现。
    if (!isSettingsWindow.value) {
      window.ipcRenderer?.on('settings-config-changed', (_e: any, payload: any) => {
        store.syncConfigFromPeers(payload?.ui, payload?.locales)
      })
    }

    if (isFileWindow.value || isBrowserAgentWindow.value || isSettingsWindow.value) return // 独立窗口无需加载主界面数据

    // ============ 文件类型关联（双击文件 / 系统「打开方式」） ============
    // 主进程把「需在主窗口内打开」的文件请求投递到这里（如 .kb 知识库 → 跳转「知识处理」）；
    // 同时回报「渲染层已就绪」，主进程据此在挂载完成后投递排队中的请求（消息早于监听器注册会丢失）
    window.ipcRenderer?.on('open-file-request', (_e: any, payload: any) => {
      const p = typeof payload?.path === 'string' ? payload.path : ''
      if (!p) return
      if (p.toLowerCase().endsWith('.kb')) { store.openKbFile(p); return }
      const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
      const label = slash >= 0 ? p.substring(slash + 1) : p
      const dot = label.lastIndexOf('.')
      store.openInApp({ path: p, label, type: 'file', extension: dot >= 0 ? label.substring(dot).toLowerCase() : '' })
    })
    window.ipcRenderer?.invoke('main-window-ui-ready').catch(() => {})

    // 关闭按钮行为以主进程配置为准（userData/app-behavior.json；设置页改动经 IPC 立即下发）
    window.ipcRenderer?.invoke('app-behavior:get').then((res: any) => {
      if (res && typeof res.closeToTray === 'boolean') store.UI.closeToTray = res.closeToTray
    }).catch(() => {})

    // 托盘（托管区）任务提示：订阅后台作业事件（带进度）+ 首次拉取运行中的作业
    if (window.dsh?.jobs) {
      window.dsh.jobs.onEvent((ev: any) => applyJobEvent(ev?.job))
      window.dsh.jobs.list().then((list: any[]) => {
        runningJobs.value = []
        for (const j of list || []) applyJobEvent(j)
      }).catch(() => {})
    }
    // 任务增减 / 进度变化即上报给主进程（节流见 scheduleTrayPush）
    watch(trayTasks, () => scheduleTrayPush(), { deep: true, immediate: true })

    // 初始状态：渲染进程重载（HMR/刷新）时设置窗口可能已经开着，主动查一次以免高亮丢失
    window.ipcRenderer?.invoke('get-settings-window-state').then((res: any) => {
      settingsWindowOpen.value = !!(res && res.open)
    }).catch(() => {})

    // 启动时自动检测AI连接状态，避免每次都要打开设置页面才能加载模型配置
    store.getAIconfig()
    // 注：文件树不再在启动时预加载，store.tree 仅在打开「知识管理」模块时由 panel.vue 加载，
    // 避免大工作区启动即全量扫描拖慢启动（view_graph/view_map 与该模块同渲染，数据就绪后 watch 自动更新）
  })

  onUnmounted(() => {
  })

  // 主面板切换即落盘（mainPanel 只在主窗口有意义）：
  // 否则共享 localStorage 里会长期残留旧值，任何一次 loadConfig（例如设置窗口保存后主窗口同步配置）
  // 或下次启动都会把导航拉回那个旧面板（现象：关掉设置子窗口后从「主页」跳回「工作流管理」）。
  // 只写这一个键，避免整份 saveConfig（写 20+ 键、可能还落盘 interface-config.json）的开销。
  watch(() => store.mainPanel, (panel) => {
    if (isSettingsWindow.value || isFileWindow.value || isBrowserAgentWindow.value) return
    try { localStorage.setItem('mainPanel', JSON.stringify(panel)) } catch { /* 写盘失败不影响使用 */ }
  })

  function minimizeWindow() {
    window.ipcRenderer.invoke('minimize-window');
  }

  function maximizeWindow() {
    isMaximized.value=!isMaximized.value
    window.ipcRenderer.invoke('maximize-window');
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
    //    ⚠ 按**实例**而不是按类型展示：同一类型多开时，以前用类型名做去重键会把它们并成一行，
    //      于是托盘只显示「每一个类型的剩余时间」；这里改用实例标题做名字（去重键=名字）。
    for (const t of runningTaskList.value) {
      const instId = runningTaskInstanceId(t)
      const meta = instId ? store.scaffoldInstances.find(i => i.id === instId) : undefined
      const title = String(meta?.title || '').trim()
      push(title || (zh ? t.labelZh : t.labelEn), formatTaskProgressDetail(t.progress, zh))
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
      window.ipcRenderer?.send('tray:status', { items: trayTasks.value, locale: store.locales })
    } catch (e) { /* 非 Electron 环境忽略 */ }
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

  function closeWindow() {
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
    store.saveConfig()
    window.ipcRenderer.invoke('close-window')
  }
  function closeSetPanel() {
    store.settingsOpen = false
  }
  // 打开「浏览器 Agent」独立窗口（多标签 + AI 可控制）；携带「浏览器默认页面」作为首个标签（仅手动打开生效）
  function openBrowserAgent() {
    const home = (store.UI?.browserHomeUrl || '').trim()
    window.ipcRenderer?.invoke('browser-agent:open', { url: home }).catch(() => {})
  }
</script>

<template>
  <!-- 文件独立窗口模式 -->
  <FileWindow v-if="isFileWindow" style="position:fixed;top:0;left:0;right:0;bottom:0;width:100%;height:100%;" />

  <!-- 浏览器 Agent 独立窗口模式（地址栏/导航壳；网页内容由主进程 WebContentsView 承载于下方区域） -->
  <BrowserAgentShell v-else-if="isBrowserAgentWindow" style="position:fixed;top:0;left:0;right:0;bottom:0;width:100%;height:100%;" />

  <!-- 设置独立窗口模式：Set 自身顶栏即拖动区（standalone 模式附带最小化/最大化/关闭窗口按钮） -->
  <SetPanel v-else-if="isSettingsWindow" standalone :initial-nav="settingsWindowNav" style="position:fixed;top:0;left:0;right:0;bottom:0;width:100%;height:100%;" />

  <!-- 主界面（仅当既不是文件窗口也不是浏览器 Agent 窗口时显示） -->
  <div v-else class="container" :class="{ 'side-nav-mode': isLeftNav }">
    <!-- 左侧导航栏（仅左侧布局模式显示：全部主面板按钮 + 设置） -->
    <div v-if="!isBrowser && isLeftNav" class="side-nav">
      <div
        v-for="btn in navButtons"
        :key="btn.key"
        class="side-nav-item"
        :class="{ active: store.mainPanel == btn.key }"
        @click="store.mainPanel = btn.key"
        :title="btn.title"
      >
        <i :class="btn.icon"></i>
      </div>
      <!-- 浏览器 Agent 独立窗口入口（非主面板，不切换 mainPanel；置于设置按钮左侧） -->
      <div class="side-nav-item" @click="openBrowserAgent" :title="store.locales === 'en' ? 'Browser Agent' : '浏览器 Agent'">
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
      <!-- 上方面板 -->
      <div class="mainPanel" v-if="!isBrowser">
        <div class="panel-header" :class="{ 'panel-header-compact': isCompactTop }">
          <template v-if="!isCompactTop">
            <!-- 顶部导航布局（默认）：导航按钮 + 标题 + 右侧按钮 -->
            <div v-if="store.isNavVisible('主页')" :class="{active:store.mainPanel=='主页'}" @click="store.mainPanel='主页';" :title="store.locales === 'en' ? 'Home' : '主页'"><i class="fa fa-home"></i></div>
            <div v-if="store.isNavVisible('知识管理')" :class="{active:store.mainPanel=='知识管理'}" @click="store.mainPanel='知识管理';"  :title="store.locales === 'en' ? 'Knowledge Management' : '知识管理'"><i class="fa fa-book"></i></div>
            <div v-if="store.isNavVisible('知识处理')" :class="{active:store.mainPanel=='知识处理'}" @click="store.mainPanel='知识处理';" :title="store.locales === 'en' ? 'Knowledge Processing' : '知识处理'"><i class="fa fa-stack-overflow"></i></div>            <div v-if="store.isNavVisible('学习')" :class="{active:store.mainPanel=='学习'}" @click="store.mainPanel='学习';" :title="store.locales === 'en' ? 'Learning' : '学习'"><i class="fa fa-graduation-cap"></i></div>            <div v-if="store.isNavVisible('工作流管理')" :class="{active:store.mainPanel=='工作流管理'}" @click="store.mainPanel='工作流管理'"  :title="store.locales === 'en' ? 'Workflow' : '工作流管理'"><i class="fa fa-stumbleupon"></i></div>
            <div v-if="store.isNavVisible('数据画布')" :class="{active:store.mainPanel=='数据画布'}" @click="store.mainPanel='数据画布'"  :title="store.locales === 'en' ? 'Data Canvas' : '数据画布'"><i class="fa fa-object-group"></i></div>
            <div v-if="store.isNavVisible('Agent脚手架')" :class="{active:store.mainPanel=='Agent脚手架'}" @click="store.mainPanel='Agent脚手架'"  :title="store.locales === 'en' ? 'Agent Scaffold' : 'Agent脚手架'"><i class="fa fa-deviantart"></i></div>
            <!-- 弹性占位：将右侧按钮推到右端，同时作为顶栏可拖拽空白 -->
            <div class="panel-title-spacer" style="flex:1;"></div>
            <!-- 标题水平居中（各面板一致：仅文本，无图标） -->
            <div class="compact-title" style="font-size: 12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{{ panelTitle }}</div>

            <!-- 浏览器 Agent 独立窗口入口（非主面板；置于「待办」左侧，紧邻右侧设置/窗口按钮组） -->
            <div @click="openBrowserAgent" :title="store.locales === 'en' ? 'Browser Agent (AI-controllable browser window)' : '浏览器 Agent（AI 可控制的独立浏览器窗口）'"><i class="fa fa-globe"></i></div>
            <div v-if="store.isNavVisible('待办管理')" :class="{active:store.mainPanel=='待办管理'}" @click="store.mainPanel='待办管理';"  :title="store.locales === 'en' ? 'Todo Management' : '待办管理'"><i class="fa fa-lightbulb-o"></i></div>
            <div :class="{active:store.settingsOpen || settingsWindowOpen}" @click="store.openSettings()"><i class="fa fa-cogs"></i></div>
            <div @click="minimizeWindow" title="最小化">
              <i class="fa fa-minus"></i>
            </div>
            <div @click="maximizeWindow" title="最大化/还原">
              <i class="fa" :class="isMaximized ? 'fa-compress' : 'fa-window-maximize'"></i>
            </div>
            <div @click="closeWindow" style="font-size:16px;margin-top: 6px;margin-right: 6px;"><i class="fa fa-times"></i></div>
          </template>
          <template v-else>
            <!-- 左侧/下方导航布局：顶栏只保留标题 + 3 个窗口按钮（其余按钮在对应导航栏）；标题水平居中 -->
            <div class="compact-title" style="-webkit-app-region: drag;font-size: 12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{{ panelTitle }}</div>

            <div @click="minimizeWindow" title="最小化">
              <i class="fa fa-minus"></i>
            </div>
            <div @click="maximizeWindow" title="最大化/还原">
              <i class="fa" :class="isMaximized ? 'fa-compress' : 'fa-window-maximize'"></i>
            </div>
            <div @click="closeWindow" style="font-size:16px;margin-top: 6px;margin-right: 6px;"><i class="fa fa-times"></i></div>
          </template>
        </div>
      </div>
      
      <!-- 中间内容区域 -->
      <div class="main">
      <home v-if="store.mainPanel=='主页'"/>
      <explorer v-if="store.mainPanel=='知识管理'"/>
      <!-- KeepAlive 缓存 knowledge：切换主面板时知识处理不销毁，切片/构建等后台任务继续 -->
      <KeepAlive include="Knowledge">
        <knowledge v-if="store.mainPanel=='知识处理'"/>
      </KeepAlive>
      <!-- KeepAlive 缓存 Learning：切换主面板时学习模块不销毁，练习/考试作答状态保留 -->
      <KeepAlive include="Learning">
        <learning v-if="store.mainPanel=='学习'"/>
      </KeepAlive>
      <!-- KeepAlive 缓存 flow：切换主面板时工作流不销毁，运行中的工作流后台继续 -->
      <KeepAlive include="Workflow">
        <flow v-if="store.mainPanel=='工作流管理'"/>
      </KeepAlive>      <!-- KeepAlive 缓存 CanvasPanel：「数据画布」独立面板，切换主面板时画布编辑状态保留 -->
      <KeepAlive include="CanvasPanel">
        <CanvasPanel v-if="store.mainPanel=='数据画布'"/>
      </KeepAlive>      <ToDo v-if="store.mainPanel=='待办管理'"/>
      <!-- KeepAlive 缓存 Harness：切换主面板时脚手架不销毁，采集/执行任务后台继续 -->
      <KeepAlive include="Harness">
        <AgentScaffoldPanel v-if="store.mainPanel=='Agent脚手架'"/>
      </KeepAlive>
      </div>
    </div>

    <!-- 底部导航栏（仅底部布局模式显示：全部主面板按钮 + 设置） -->
    <div v-if="!isBrowser && isBottomNav" class="bottom-nav">
      <div
        v-for="btn in navButtons"
        :key="btn.key"
        class="bottom-nav-item"
        :class="{ active: store.mainPanel == btn.key }"
        @click="store.mainPanel = btn.key"
        :title="btn.title"
      >
        <i :class="btn.icon"></i>
      </div>
      <!-- 浏览器 Agent 独立窗口入口（非主面板；置于设置按钮左侧） -->
      <div class="bottom-nav-item" @click="openBrowserAgent" :title="store.locales === 'en' ? 'Browser Agent' : '浏览器 Agent'">
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
</template>

<style scoped>
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

  .panel-header div {
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

  .panel-header div:hover {
    color: var(--fontActiveColor);
    background-color: var(--menuActiveColor);
  }

  .panel-header div.active {
    color: var(--fontActiveColor);
    background-color: var(--menuActiveColor);
  }

  /* 拖拽区域 */
  .panel-header div[style*="drag"] {
    cursor: move;
    opacity: 0.3;
  }

  .panel-header div[style*="drag"]:hover {
    background-color: transparent;
  }

  /* 设置按钮 */
  .panel-header div:last-child {
    margin-top: auto;
    margin-bottom: 5px;
  }

  /* 顶栏按钮保持可点击（标题与占位拖拽区除外） */
  .panel-header > div:not(.compact-title):not(.panel-title-spacer) {
    -webkit-app-region: no-drag;
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
  /* 左侧/下方布局：右侧窗口按钮靠右 */
  .panel-header-compact {
    justify-content: flex-end;
  }

  /* ============ 左侧导航布局 ============ */
  /* 左侧导航模式：容器改为横向排列（左侧栏 + 右侧内容区） */
  .container.side-nav-mode {
    flex-direction: row;
  }

  /* 左侧导航栏 */
  .side-nav {
    width: 44px;
    flex-shrink: 0;
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 4px 2px;
    gap: 2px;
    overflow-y: auto;
    overflow-x: hidden;
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

  /* 右侧内容区（顶栏 + 主内容纵向排列） */
  .main-column {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
</style>

<!-- 全局（非 scoped）样式：Element Plus 的 ElMessage 挂载在 body 上，scoped 样式命中不到 -->
<style>
  /* 关闭前提醒：任务名可能较长/较多，允许换行并限宽，避免文案被截断或撑出屏幕 */
  .el-message.close-warn-message {
    max-width: min(560px, 92vw);
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