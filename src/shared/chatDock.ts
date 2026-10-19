/**
 * chatDock.ts — 主页右侧栏（DSH 同款 dock）的纯逻辑：标签页集合 / 当前标签 / 宽度
 *
 * 为什么抽出来：右侧栏的状态**每个聊天各一份**（与输入框草稿同一套做法，见 chatDraft.ts），
 * 并且会被反复读写（开关、拖宽、加/关标签、切标签）。这些规则不依赖 Vue / DOM，
 * 抽成纯函数后可以直接跑自测（见 chatDock.selftest.ts），避免存档脏数据把界面搞坏。
 *
 * 工具页与 DSH 一致：文件 / 终端 / 浏览器；另外新增 `file` 类型承载「具体文件」标签
 * （点右侧栏文件树里的文件后生成，内容复用文件窗口的多视图选择）。
 */

/**
 * 标签类型：
 *  - files / terminal / browser：右侧栏的「工具页」（DSH 同款）；
 *  - file：**具体文件**（点文件树里的文件后生成，标签标题 = 文件名，内容自带多视图切换）。
 * 后三种是用户从「+」菜单手动新建的；file 只能由打开文件产生（见 openFileDockTab）。
 */
export type ChatDockTabKind = 'files' | 'terminal' | 'browser' | 'file'

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

/** 「+」菜单可新建的标签类型（顺序 = 菜单顺序；file 标签只能由打开文件产生，不在此列） */
export const DOCK_TAB_KINDS: readonly ChatDockTabKind[] = ['files', 'terminal', 'browser']

const KIND_LABELS: Record<ChatDockTabKind, { zh: string; en: string }> = {
  files: { zh: '文件', en: 'Files' },
  terminal: { zh: '终端', en: 'Terminal' },
  browser: { zh: '浏览器', en: 'Browser' },
  file: { zh: '文件', en: 'File' },
}

/** 类型是否合法（存档里出现未知类型时按非法处理） */
export function isDockTabKind(value: unknown): value is ChatDockTabKind {
  return value === 'files' || value === 'terminal' || value === 'browser' || value === 'file'
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
  if (tabs.length !== 3) return false
  const kinds = tabs.map((t) => t.kind).join(',')
  if (kinds !== DOCK_TAB_KINDS.join(',')) return false
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

/** 追加一个标签并切到它（返回新状态，不原地改） */
export function addDockTab(state: ChatDockState, kind: ChatDockTabKind, seed = Date.now()): ChatDockState {
  if (!isDockTabKind(kind)) return state
  const tab = createDockTab(kind, state.tabs, seed)
  return { ...state, open: true, tabs: [...state.tabs, tab], activeTabId: tab.id }
}

/**
 * 在右侧栏打开一个文件：已有同路径的文件标签就切过去（并更新视图），否则新建一个 file 标签。
 * 与「+」菜单新建工具页同一套状态：自动展开右侧栏、自动切到新标签。
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
