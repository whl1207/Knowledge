/**
 * chatDock.ts — 主页右侧栏（DSH 同款 dock）的纯逻辑：标签页集合 / 当前标签 / 宽度
 *
 * 为什么抽出来：右侧栏的状态**每个聊天各一份**（与输入框草稿同一套做法，见 chatDraft.ts），
 * 并且会被反复读写（开关、拖宽、加/关标签、切标签）。这些规则不依赖 Vue / DOM，
 * 抽成纯函数后可以直接跑自测（见 chatDock.selftest.ts），避免存档脏数据把界面搞坏。
 *
 * 工具页与 DSH 一致：文件 / 终端 / 浏览器；`branch` 承载分支对话视图（不再单独占一列）；
 * `new` 是点「+」先加的空白新标签页（在页内选类型，不弹菜单）；
 * `file` 承载「具体文件」标签（点文件树里的文件后生成，内容复用文件窗口的多视图选择）。
 */

/**
 * 标签类型：
 *  - files / terminal / browser：右侧栏的「工具页」（DSH 同款）；
 *  - branch：分支对话视图（与工具页一样放在右侧栏里，不再单独占一列）；
 *  - new：**空白新标签页**（点「+」先建它，再在面板里选具体类型）；
 *  - file：**具体文件**（点文件树里的文件后生成，标签标题 = 文件名，内容自带多视图切换）。
 * new / file 不能从类型选择器直接创建（file 由打开文件产生，new 由「+」产生）。
 */
export type ChatDockTabKind = 'files' | 'terminal' | 'browser' | 'branch' | 'todos' | 'plan' | 'trajectory' | 'jobs' | 'new' | 'file'

export interface ChatDockTab {
  /** 标签唯一 id（同类型可以开多个，如两个终端） */
  id: string
  kind: ChatDockTabKind
  /** 自定义显示名（留空 = 按类型 + 序号自动命名；file 标签按文件名） */
  title?: string
  /** file 标签：要显示的文件路径（绝对路径 / 远程虚拟路径） */
  path?: string
  /** file 标签：当前视图（浏览 / 源码编辑 / 可视编辑 / 思维导图 / 演示 / Office 编辑） */
  view?: string
}

export interface ChatDockState {
  /** 右侧栏是否展开（默认收起，用户点了头部图标才开） */
  open: boolean
  /** 宽度（px） */
  width: number
  /** 当前显示的标签 id（失效时回落到第一个标签） */
  activeTabId?: string
  /** 标签页集合（顺序 = 标签栏顺序） */
  tabs: ChatDockTab[]
}

/** 默认宽度（DSH 的右侧栏也在 320~380 一带） */
export const DOCK_DEFAULT_WIDTH = 360
export const DOCK_MIN_WIDTH = 260
export const DOCK_MAX_WIDTH = 900
/**
 * 右侧栏最多只能占到「聊天区 + 右侧栏总宽 - 这个值」：
 * 保证把分隔条一路拖到最左边时，中间聊天区仍然可见、右侧栏内容不会被容器裁掉。
 */
export const DOCK_MIN_CHAT_WIDTH = 320

/** 新标签页里可选的类型（顺序 = 选项顺序；new / file 不在此列） */
export const DOCK_TAB_KINDS: readonly ChatDockTabKind[] = ['files', 'terminal', 'browser', 'branch', 'todos', 'plan', 'trajectory', 'jobs']

/** 旧版本自动预置的三标签（用于识别并清掉旧存档，与当前可选项无关） */
const LEGACY_SEEDED_KINDS: readonly ChatDockTabKind[] = ['files', 'terminal', 'browser']

const KIND_LABELS: Record<ChatDockTabKind, { zh: string; en: string }> = {
  files: { zh: '工作区', en: 'Workspace' },
  terminal: { zh: '终端', en: 'Terminal' },
  browser: { zh: '浏览器', en: 'Browser' },
  branch: { zh: '分支', en: 'Branches' },
  todos: { zh: '待办清单', en: 'Todos' },
  plan: { zh: '计划', en: 'Plan' },
  trajectory: { zh: '会话轨迹', en: 'Trajectory' },
  jobs: { zh: '后台任务', en: 'Jobs' },
  new: { zh: '新标签页', en: 'New tab' },
  file: { zh: '文件', en: 'File' },
}

/** 同一类型只能有一个标签页（分支 / 待办清单 / 计划 / 会话轨迹） */
export const SINGLETON_DOCK_KINDS: readonly ChatDockTabKind[] = ['branch', 'todos', 'plan', 'trajectory', 'jobs']
export function isSingletonDockKind(kind: ChatDockTabKind): boolean {
  return SINGLETON_DOCK_KINDS.includes(kind)
}

/** 类型是否合法（存档里出现未知类型时按非法处理） */
export function isDockTabKind(value: unknown): value is ChatDockTabKind {
  return value === 'files' || value === 'terminal' || value === 'browser'
    || value === 'branch' || value === 'todos' || value === 'plan' || value === 'trajectory'
    || value === 'jobs' || value === 'new' || value === 'file'
}

/** 路径最后一段（file 标签的默认标题） */
export function dockFileNameOf(path: unknown): string {
  const parts = String(path || '').replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : String(path || '')
}

/** 宽度夹取：NaN / 越界 / 存档脏值一律落回合法区间 */
export function clampDockWidth(width: unknown): number {
  const n = Math.round(Number(width))
  if (!Number.isFinite(n)) return DOCK_DEFAULT_WIDTH
  return Math.max(DOCK_MIN_WIDTH, Math.min(DOCK_MAX_WIDTH, n))
}

/**
 * 按「聊天区 + 右侧栏的可用总宽」夹取右侧栏宽度。
 *
 * 固定上限 900 只在超宽窗口下才够用：普通窗口里把分隔条拖到最左边时，
 * 右侧栏会先被撑到 900，超过容器后内容就被裁掉（表现为「面板显示不全」）。
 * 这里在固定上限之外再留出 `DOCK_MIN_CHAT_WIDTH` 给中间聊天区。
 *
 * @param width 目标宽度
 * @param roomWidth 聊天区 + 右侧栏可用总宽（不含左侧聊天列表）；非正数时只做固定夹取
 */
export function clampDockWidthInRoom(width: unknown, roomWidth: unknown): number {
  const base = clampDockWidth(width)
  const room = Number(roomWidth)
  if (!Number.isFinite(room) || room <= 0) return base
  // 窗口太窄时「给聊天区留 320」可能与「右侧栏最小 260」冲突：此时以右侧栏最小宽度为准，
  // 至少保证它自身是完整可用的（再窄就由窄屏整屏模式接管）。
  const max = Math.max(DOCK_MIN_WIDTH, Math.min(DOCK_MAX_WIDTH, Math.floor(room - DOCK_MIN_CHAT_WIDTH)))
  return Math.max(DOCK_MIN_WIDTH, Math.min(max, base))
}

/** 新建一个标签（同类型可多个，id 保证不与已有标签冲突） */
export function createDockTab(kind: ChatDockTabKind, existing: readonly ChatDockTab[] = [], seed = Date.now()): ChatDockTab {
  const base = `${kind}-${seed}`
  const used = new Set((existing || []).map((t) => t?.id))
  if (!used.has(base)) return { id: base, kind }
  let n = 2
  while (used.has(`${base}-${n}`)) n++
  return { id: `${base}-${n}`, kind }
}

/** 默认状态：**空的**（与新标签页一样）+ 收起 —— 用户开右侧栏后自己选 终端 / 文件 / 浏览器 */
export function defaultDockState(): ChatDockState {
  return { open: false, width: DOCK_DEFAULT_WIDTH, activeTabId: undefined, tabs: [] }
}

/**
 * 旧版本（首次实现 dock 时）会给每个聊天「预置」文件/终端/浏览器三个标签。
 * 现在默认是**空面板**（与新标签页一样），所以这里把那种自动预置的痕迹认出来并清掉，
 * 否则老存档打开侧栏仍然会看到三个标签，与新行为不一致。
 *
 * 判定很保守：恰好三个标签、类型与顺序完全一致、都没有自定义名字、id 都是自动生成的
 * `${kind}-<数字>` 形式。用户手动建的同名标签理论上可能被命中，但概率极低且只是回到空面板。
 */
function isLegacySeededTabs(tabs: readonly ChatDockTab[]): boolean {
  if (tabs.length !== LEGACY_SEEDED_KINDS.length) return false
  const kinds = tabs.map((t) => t.kind).join(',')
  if (kinds !== LEGACY_SEEDED_KINDS.join(',')) return false
  return tabs.every((t) => !t.title?.trim() && /^(files|terminal|browser)-\d+(-\d+)?$/.test(String(t.id || '')))
}

/** 归一化存档里的右侧栏状态：
 * - 非对象 / 缺字段 → 用默认值补齐（兼容旧存档：那时还没有 dock 字段）；
 * - 未知标签类型、重复 id、空 id 一律丢掉；
 * - **允许空标签集合**：空面板就是「还没选使用方式」，不兜底成文件面板；
 * - 清掉旧版本自动预置的三标签（见 isLegacySeededTabs）；
 * - 当前标签失效 → 回落到第一个标签（没有标签时就是没有）。
 */
export function normalizeDockState(raw: unknown): ChatDockState {
  const fallback = defaultDockState()
  if (!raw || typeof raw !== 'object') return fallback
  const src = raw as Partial<ChatDockState>

  const parsed: ChatDockTab[] = []
  const seen = new Set<string>()
  const seenFilePaths = new Set<string>()
  const seenSingleton = new Set<ChatDockTabKind>()
  for (const t of Array.isArray(src.tabs) ? src.tabs : []) {
    if (!t || typeof t !== 'object') continue
    const kind = (t as ChatDockTab).kind
    const id = String((t as ChatDockTab).id ?? '')
    if (!isDockTabKind(kind) || !id || seen.has(id)) continue
    const path = typeof (t as ChatDockTab).path === 'string' ? (t as ChatDockTab).path!.trim() : ''
    // file 标签必须带路径；同一路径不重复占两个标签
    if (kind === 'file') {
      if (!path || seenFilePaths.has(path)) continue
      seenFilePaths.add(path)
    }
    // 分支 / 待办 / 计划只有一份（旧存档/重复操作产生多个时只保留第一个）
    if (isSingletonDockKind(kind)) {
      if (seenSingleton.has(kind)) continue
      seenSingleton.add(kind)
    }
    seen.add(id)
    const title = typeof (t as ChatDockTab).title === 'string' && (t as ChatDockTab).title!.trim()
      ? (t as ChatDockTab).title!.trim()
      : undefined
    const view = typeof (t as ChatDockTab).view === 'string' && (t as ChatDockTab).view!.trim()
      ? (t as ChatDockTab).view!.trim()
      : undefined
    parsed.push({
      id,
      kind,
      ...(title ? { title } : {}),
      ...(kind === 'file' ? { path, ...(view ? { view } : {}) } : {}),
    })
  }
  const tabs = isLegacySeededTabs(parsed) ? [] : parsed

  const active = String(src.activeTabId ?? '')
  return {
    open: src.open === true,
    width: clampDockWidth(src.width),
    activeTabId: tabs.some((t) => t.id === active) ? active : tabs[0]?.id,
    tabs,
  }
}

/** 取标签显示名：自定义名优先，否则「类型名」+（同类型多于一个时）序号 */
export function dockTabTitle(tab: ChatDockTab, tabs: readonly ChatDockTab[] = [], zh = true): string {
  const custom = tab?.title?.trim()
  if (custom) return custom
  const kind: ChatDockTabKind = isDockTabKind(tab?.kind) ? tab.kind : 'files'
  // file 标签：标题永远是文件名（同类型多开也无需序号）
  if (kind === 'file') return dockFileNameOf(tab?.path) || (zh ? '文件' : 'File')
  const label = zh ? KIND_LABELS[kind].zh : KIND_LABELS[kind].en
  const sameKind = (tabs || []).filter((t) => t?.kind === kind)
  if (sameKind.length <= 1) return label
  const index = sameKind.findIndex((t) => t.id === tab.id)
  return `${label} ${index + 1}`
}

/** 追加一个标签并切到它（返回新状态，不原地改）；分支 / 待办 / 计划这类单例标签已有就切过去 */
export function addDockTab(state: ChatDockState, kind: ChatDockTabKind, seed = Date.now()): ChatDockState {
  if (!isDockTabKind(kind)) return state
  if (isSingletonDockKind(kind)) {
    const existing = state.tabs.find((t) => t.kind === kind)
    if (existing) return { ...state, open: true, activeTabId: existing.id }
  }
  const tab = createDockTab(kind, state.tabs, seed)
  return { ...state, open: true, tabs: [...state.tabs, tab], activeTabId: tab.id }
}

/**
 * 点「+」新建一个**空白新标签页**（kind='new'）：不再弹出类型菜单，
 * 先出现标签页，由用户在该页里选 文件 / 终端 / 浏览器 / 分支。
 */
export function addDockPlaceholder(state: ChatDockState, seed = Date.now()): ChatDockState {
  const tab = createDockTab('new', state.tabs, seed)
  return { ...state, open: true, tabs: [...state.tabs, tab], activeTabId: tab.id }
}

/**
 * 在空白新标签页里选定类型（把 'new' 转成目标类型）。
 *
 * - 分支视图只有一份：目标类型是 branch 且已存在分支标签时，移除这张空白页并切到已有的；
 * - 只替换 kind，清掉空白页上可能残留的 title/path/view；
 * - 返回新状态（不改原对象）。
 */
export function configureDockTab(
  state: ChatDockState,
  id: string,
  kind: ChatDockTabKind,
): ChatDockState {
  if (!id || !isDockTabKind(kind) || kind === 'new' || kind === 'file') return state
  const index = state.tabs.findIndex((t) => t.id === id)
  if (index < 0) return state
  const tab = state.tabs[index]
  if (tab.kind === kind) return state

  if (isSingletonDockKind(kind)) {
    const existing = state.tabs.find((t, i) => i !== index && t.kind === kind)
    if (existing) {
      const tabs = state.tabs.filter((_, i) => i !== index)
      return { ...state, open: true, tabs, activeTabId: existing.id }
    }
  }

  const next: ChatDockTab = { id: tab.id, kind }
  const tabs = state.tabs.slice()
  tabs[index] = next
  return { ...state, open: true, tabs, activeTabId: next.id }
}

/**
 * 打开分支视图：已有分支标签就切过去，否则新建一个（分支视图全局只有一份）。
 * 分支树与文件/终端一样放在右侧栏的标签页里。
 */
export function openBranchDockTab(state: ChatDockState, seed = Date.now()): ChatDockState {
  const existing = state.tabs.find((t) => t.kind === 'branch')
  if (existing) return { ...state, open: true, activeTabId: existing.id }
  const tab = createDockTab('branch', state.tabs, seed)
  return { ...state, open: true, tabs: [...state.tabs, { id: tab.id, kind: 'branch' }], activeTabId: tab.id }
}

/**
 * 在右侧栏打开一个文件：已有同路径的文件标签就切过去（并更新视图），否则新建一个 file 标签。
 * 与新标签页里选文件同一套状态：自动展开右侧栏、自动切到新标签。
 */
export function openFileDockTab(
  state: ChatDockState,
  path: string,
  view?: string,
  seed = Date.now(),
): ChatDockState {
  const clean = String(path || '').trim()
  if (!clean) return state
  const existing = state.tabs.find((t) => t.kind === 'file' && t.path === clean)
  if (existing) {
    const tabs = state.tabs.map((t) => (t.id === existing.id && view ? { ...t, view } : t))
    return { ...state, open: true, tabs, activeTabId: existing.id }
  }
  const tab = createDockTab('file', state.tabs, seed)
  const next: ChatDockTab = { id: tab.id, kind: 'file', path: clean, ...(view ? { view } : {}) }
  return { ...state, open: true, tabs: [...state.tabs, next], activeTabId: next.id }
}

/** 记住某个 file 标签当前选择的视图（切换视图时由宿主写回） */
export function setDockTabView(state: ChatDockState, id: string, view: string): ChatDockState {
  if (!id || !view) return state
  const index = state.tabs.findIndex((t) => t.id === id)
  if (index < 0) return state
  const tab = state.tabs[index]
  if (tab.view === view) return state
  const tabs = state.tabs.slice()
  tabs[index] = { ...tab, view }
  return { ...state, tabs }
}

/**
 * 关闭一个标签（返回新状态）。
 * 关掉当前标签时切到相邻标签（右侧优先，没有则左侧）；关光了就是**空面板**
 * （与新标签页一样，由用户再选 终端 / 文件 / 浏览器，不兜底成某个面板）。
 */
export function closeDockTab(state: ChatDockState, id: string): ChatDockState {
  const index = state.tabs.findIndex((t) => t.id === id)
  if (index < 0) return state
  const tabs = state.tabs.filter((t) => t.id !== id)
  if (!tabs.length) return { ...state, tabs: [], activeTabId: undefined }
  const activeTabId = state.activeTabId === id
    ? (tabs[index]?.id ?? tabs[tabs.length - 1].id)
    : state.activeTabId
  return { ...state, tabs, activeTabId }
}

/** 切换当前标签（id 不存在时原样返回） */
export function activateDockTab(state: ChatDockState, id: string): ChatDockState {
  if (!state.tabs.some((t) => t.id === id)) return state
  return state.activeTabId === id ? state : { ...state, activeTabId: id }
}

/** 当前标签（没有标签 / id 失效时返回 undefined） */
export function activeDockTab(state: ChatDockState): ChatDockTab | undefined {
  return state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0]
}

/** 开关右侧栏（返回新状态） */
export function setDockOpen(state: ChatDockState, open: boolean): ChatDockState {
  return state.open === !!open ? state : { ...state, open: !!open }
}

/** 调整宽度（自动夹取；返回新状态） */
export function setDockWidth(state: ChatDockState, width: unknown): ChatDockState {
  const w = clampDockWidth(width)
  return state.width === w ? state : { ...state, width: w }
}
