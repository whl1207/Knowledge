<!-- src/components/home/ChatDock.vue
     主页聊天区右侧栏（DSH 同款 dock）：标签条（文件 / 终端 / 浏览器）+ 可拖动调宽 + 内容区。

     职责边界：本组件只管**展示与交互**，标签页数据（哪些标签、当前是哪个、宽度、开关）
     全部由父级（home.vue）按聊天读写并持久化 —— 与输入框草稿同一套「每个聊天各自一份」的做法。
     标签内容按类型渲染：
       - files    → ChatDockFiles.vue（工作区文件树）
       - terminal → ChatDockTerminal.vue（node-pty 真终端）
       - browser  → ChatDockBrowser.vue（主进程 WebContentsView 挂到主窗口）
       - branch   → 父级通过 #branch 插槽传入（分支对话树，与工具页共用右侧栏）
       - new      → 空白新标签页：在页内选类型（不弹图标下菜单） -->
<template>
  <aside
    ref="rootEl"
    class="chat-dock"
    :class="{ narrow, resizing }"
    :style="narrow ? undefined : { width: width + 'px' }"
  >
    <!-- 拖动调宽（窄屏是整屏二级界面，不需要调宽） -->
    <div
      v-if="!narrow"
      class="chat-dock-resize"
      :title="zh ? '拖动调整右侧栏宽度' : 'Drag to resize'"
      @pointerdown.stop="onResizeDown"
    ></div>

    <!-- 标签条 -->
    <div class="chat-dock-tabs">
      <button
        v-if="narrow"
        class="dock-tab-back"
        :title="zh ? '返回对话' : 'Back to chat'"
        @click="emit('close')"
      >
        <i class="fa fa-arrow-left"></i>
      </button>

      <div class="dock-tab-strip scoll-x">
        <div
          v-for="tab in tabs"
          :key="tab.id"
          class="dock-tab"
          :class="{ active: tab.id === activeTabId }"
          :title="dockTabTitle(tab, tabs, zh)"
          @click="emit('activate', tab.id)"
        >
          <i
            class="fa dock-tab-icon"
            :class="[kindIcon(tab.kind), { 'dock-tab-icon-action': tab.kind === 'file' }]"
            :title="tab.kind === 'file' ? (zh ? '点击图标选择视图' : 'Click the icon to choose a view') : ''"
            @click.stop="openTabMenu(tab, $event)"
          ></i>
          <span class="dock-tab-text">{{ dockTabTitle(tab, tabs, zh) }}</span>
          <i
            class="fa fa-times dock-tab-close"
            :title="zh ? '关闭这个标签' : 'Close this tab'"
            @click.stop="emit('close-tab', tab.id)"
          ></i>
        </div>
      </div>

      <!-- 新建标签：与 DSH 一致，先加一张空白标签页，再在页面里选类型（不弹菜单） -->
      <button class="dock-tab-add" :title="zh ? '新建标签页' : 'New tab'" @click.stop="emit('add')">
        <i class="fa fa-plus"></i>
      </button>
    </div>

    <!-- 内容区：每个标签一个常驻面板（切标签只是 v-show，切回来不丢状态；首次激活才挂载） -->
    <div class="chat-dock-body">
      <!-- 空面板：和新标签页一样，先让用户选一种使用方式（终端 / 文件 / 浏览器 / 分支） -->
      <div v-if="!tabs.length" class="dock-empty">
        <div class="dock-empty-title">{{ zh ? '选择右侧栏的使用方式' : 'Choose what to show here' }}</div>
        <div class="dock-empty-actions">
          <button
            v-for="kind in availableKinds"
            :key="kind"
            class="dock-empty-btn"
            :title="kindHint(kind)"
            @click="chooseKind(kind)"
          >
            <i class="fa" :class="kindIcon(kind)"></i>
            <span>{{ kindLabel(kind) }}</span>
          </button>
        </div>
        <div class="dock-empty-hint">
          {{ zh ? '可以放多个标签：同一个类型也能开多个' : 'You can keep several tabs, including several of the same kind' }}
        </div>
      </div>

      <template v-for="tab in tabs" :key="tab.id">
        <!-- ⚠️ 文件标签只在**当前激活**时挂载：编辑器视图读的是全局「当前文件」
             （store.data[store.index]），同时挂载两个文件会把内容互相覆盖。
             工具页（文件树 / 终端 / 浏览器 / 分支）仍用 everActive + v-show，切回来不丢状态。 -->
        <div
          v-if="tab.kind === 'file' ? tab.id === activeTabId : everActive.has(tab.id)"
          v-show="tab.id === activeTabId"
          class="dock-pane"
        >
          <!-- 空白新标签页：先让用户选类型（与 DSH 一致：+ 直接加一页，不在图标下弹菜单） -->
          <div v-if="tab.kind === 'new'" class="dock-empty">
            <div class="dock-empty-title">{{ zh ? '选择这个标签页的使用方式' : 'Choose what this tab shows' }}</div>
            <div class="dock-empty-actions">
              <button
                v-for="kind in availableKinds"
                :key="kind"
                class="dock-empty-btn"
                :title="kindHint(kind)"
                @click="emit('configure', tab.id, kind)"
              >
                <i class="fa" :class="kindIcon(kind)"></i>
                <span>{{ kindLabel(kind) }}</span>
              </button>
            </div>
            <div class="dock-empty-hint">
              {{ zh ? '选定后这张标签页就会变成对应工具；可以再点「+」加更多' : 'Pick one to turn this tab into that tool; use + to add more' }}
            </div>
          </div>
          <slot v-else-if="tab.kind === 'branch'" name="branch" />
          <ChatDockFiles
            v-else-if="tab.kind === 'files'"
            :active="tab.id === activeTabId"
            :root-path="chatWorkspace"
            @insert-text="(t: string) => emit('insert-text', t)"
            @open-file="(p: any) => emit('open-file', p)"
          />
          <ChatDockTerminal
            v-else-if="tab.kind === 'terminal'"
            :tab-id="tab.id"
            :active="tab.id === activeTabId"
            :cwd="chatWorkspace"
          />
          <ChatDockBrowser
            v-else-if="tab.kind === 'browser'"
            :tab-id="tab.id"
            :active="tab.id === activeTabId"
            :occluded="occluded"
          />
          <!-- 文件标签：复用文件窗口（含多视图选择），见 ChatDockFile.vue -->
          <ChatDockFile
            v-else-if="tab.kind === 'file'"
            :ref="setFilePaneRef"
            :path="tab.path || ''"
            :view="tab.view"
            @update:view="(v: string) => emit('tab-view-change', tab.id, v)"
          />
        </div>
      </template>
    </div>

    <!-- 文件标签的视图选择（md：浏览 / 源码编辑 / 可视编辑 / 思维导图 / 演示 …）：点标签图标弹出 -->
    <div
      v-if="viewMenu"
      class="dock-view-menu"
      :style="{ left: viewMenu.x + 'px', top: viewMenu.y + 'px' }"
      @click.stop
    >
      <button
        v-for="a in viewMenu.views"
        :key="a.value"
        class="dock-view-item"
        :class="{ active: a.active }"
        :title="a.label"
        @click="chooseView(a.value)"
      >
        <i :class="a.icon"></i>
        <span>{{ a.label }}</span>
      </button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ChatDockFiles from './ChatDockFiles.vue'
import ChatDockTerminal from './ChatDockTerminal.vue'
import ChatDockBrowser from './ChatDockBrowser.vue'
import ChatDockFile from './ChatDockFile.vue'
import { fileViewByKey } from '@/lib/knowFile/fileViews'
import {
  DOCK_TAB_KINDS,
  clampDockWidthInRoom,
  dockTabTitle,
  type ChatDockTab,
  type ChatDockTabKind,
} from '@/shared/chatDock'
import { hasCapability } from '@/platform'

const props = defineProps<{
  tabs: ChatDockTab[]
  activeTabId?: string
  width: number
  /** 窄屏（安卓竖屏 / 小窗）：整屏二级界面，与「对话 ⇄ 聊天列表」同一套交互 */
  narrow?: boolean
  /** 宿主窗口里有浮层（设置 / 文件窗口 / 聊天弹窗）盖住侧栏：浏览器标签要把原生网页视图藏起来 */
  occluded?: boolean
  /** 当前聊天的工作区：文件标签的根目录、终端的工作目录都用它（空 = 跟随全局默认） */
  chatWorkspace?: string
  /** 当前聊天家族是否有分支：决定新标签页里是否出现「分支」选项 */
  branchAvailable?: boolean
  zh: boolean
}>()

const emit = defineEmits<{
  (e: 'update:width', width: number): void
  (e: 'resize-end'): void
  (e: 'activate', id: string): void
  /** 点「+」→ 不带 kind，宿主加一张空白新标签页；空面板里选类型 → 带 kind 直接建对应标签 */
  (e: 'add', kind?: ChatDockTabKind): void
  /** 空白新标签页里选定类型：宿主把该标签从 'new' 转成目标类型 */
  (e: 'configure', id: string, kind: ChatDockTabKind): void
  (e: 'close-tab', id: string): void
  (e: 'close'): void
  (e: 'insert-text', text: string): void
  /** 文件树里点了某个文件：宿主把它作为 file 标签打开 */
  (e: 'open-file', payload: { path: string; view?: string; label?: string }): void
  /** 文件标签里切换了视图：宿主写回该标签的 view */
  (e: 'tab-view-change', id: string, view: string): void
}>()

const zh = computed(() => props.zh)

function kindIcon(kind: ChatDockTabKind): string {
  if (kind === 'terminal') return 'fa-terminal'
  if (kind === 'browser') return 'fa-globe'
  if (kind === 'branch') return 'fa-sitemap'
  if (kind === 'new') return 'fa-plus'
  if (kind === 'file') return 'fa-file-text-o'
  return 'fa-folder-open-o'
}
function kindLabel(kind: ChatDockTabKind): string {
  if (kind === 'terminal') return props.zh ? '终端' : 'Terminal'
  if (kind === 'browser') return props.zh ? '浏览器' : 'Browser'
  if (kind === 'branch') return props.zh ? '分支' : 'Branch'
  if (kind === 'new') return props.zh ? '新标签页' : 'New tab'
  return props.zh ? '文件' : 'Files'
}
/** 空面板 / 新标签页里每个选项的一句话说明 */
function kindHint(kind: ChatDockTabKind): string {
  if (kind === 'terminal') {
    return props.zh
      ? '终端：在本机 shell 里执行命令（真 PTY，命令由你自己输入）'
      : 'Terminal: run commands in a local shell (real PTY, you type the commands)'
  }
  if (kind === 'browser') {
    return props.zh
      ? '浏览器：在侧栏里直接浏览网页（地址栏 / 多标签 / 收藏都在这里）'
      : 'Browser: browse right inside the panel (address bar, tabs and bookmarks included)'
  }
  if (kind === 'branch') {
    return props.zh
      ? '分支：查看当前对话的分支树，点击节点切换、右键管理'
      : 'Branch: view this conversation branch tree; click a node to switch, right-click to manage'
  }
  return props.zh
    ? '文件：浏览当前工作区的文件，可打开或把路径插入输入框'
    : 'Files: browse the current workspace, open files or insert their paths into the input box'
}

// ===== 首次激活才挂载：避免一上来就把终端全都创建出来（每个终端 = 一个真实 shell 进程） =====
const everActive = ref<Set<string>>(new Set())
watch(
  () => [props.activeTabId, props.tabs] as const,
  () => {
    const id = props.activeTabId
    if (id && !everActive.value.has(id)) everActive.value = new Set([...everActive.value, id])
  },
  { immediate: true },
)

// ===== 新标签页的类型选择 =====
/** 只列出当前环境真的能用的类型（安卓 / 纯网页没有 PTY，就不给「终端」入口；没有分支就不给「分支」） */
const availableKinds = computed(() => DOCK_TAB_KINDS.filter((k) => {
  if (k === 'terminal' && !hasCapability('terminal')) return false
  if (k === 'branch' && !props.branchAvailable) return false
  return true
}))
/** 空面板（没有标签时）直接建标签；空白新标签页则把当前页转成目标类型 */
function chooseKind(kind: ChatDockTabKind) {
  const active = props.tabs.find((t) => t.id === props.activeTabId)
  if (active?.kind === 'new') emit('configure', active.id, kind)
  else emit('add', kind)
}

// ===== 拖动调宽（指针事件 + 左边缘 8px 热区；松手才落盘）=====
const resizing = ref(false)
/** 组件根节点：求「聊天区 + 右侧栏」可用总宽用（父容器里 .chat-main 与它并排） */
const rootEl = ref<HTMLElement | null>(null)
/** 观察中间聊天区尺寸（左侧列表展开 / 收起、窗口缩放）以便及时收敛宽度 */
let mainObserver: ResizeObserver | null = null
let resizeState: { startX: number; startWidth: number; roomWidth: number } | null = null

/**
 * 聊天区 + 右侧栏的可用总宽（不含左侧聊天列表）。
 * 拖动开始时量一次并缓存：拖宽过程中两者此消彼长，实时相加会互相反馈。
 */
function measureRoomWidth(): number {
  const el = rootEl.value
  if (!el) return 0
  const parent = el.parentElement
  const main = parent?.querySelector(':scope > .chat-main') as HTMLElement | null
  const mainWidth = main?.getBoundingClientRect().width || 0
  const dockWidth = el.getBoundingClientRect().width || props.width || 0
  return mainWidth + dockWidth
}

/**
 * 窗口变窄 / 存档里宽度过大：收敛到「给聊天区留够空间」的上限。
 * 固定上限 900 在普通窗口里不够用，拖到最左边会把右侧栏撑出容器、内容被裁掉。
 */
const enforceDockWidthLimit = () => {
  if (props.narrow) return
  const allowed = clampDockWidthInRoom(props.width, measureRoomWidth())
  if (allowed !== props.width) {
    emit('update:width', allowed)
    // 收敛结果也落盘，下次打开不会又宽出容器
    emit('resize-end')
  }
}
onMounted(() => {
  enforceDockWidthLimit()
  window.addEventListener('resize', enforceDockWidthLimit)
  // 左侧聊天列表展开 / 收起也会改变聊天区可用宽度（窗口本身没 resize）：观察中间区尺寸再收敛
  const main = rootEl.value?.parentElement?.querySelector(':scope > .chat-main') as HTMLElement | null
  if (main && typeof ResizeObserver !== 'undefined') {
    mainObserver = new ResizeObserver(() => enforceDockWidthLimit())
    mainObserver.observe(main)
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', enforceDockWidthLimit)
  if (mainObserver) {
    mainObserver.disconnect()
    mainObserver = null
  }
})

const onResizeMove = (e: PointerEvent) => {
  if (!resizeState) return
  // 手柄在左边缘：向左拖 = 变宽；上限给中间聊天区留出最小宽度
  const raw = resizeState.startWidth + (resizeState.startX - e.clientX)
  emit('update:width', clampDockWidthInRoom(raw, resizeState.roomWidth))
}
const onResizeUp = () => {
  if (!resizeState) return
  resizeState = null
  resizing.value = false
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', onResizeUp)
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
  emit('resize-end')
}
const onResizeDown = (e: PointerEvent) => {
  e.preventDefault()
  resizeState = { startX: e.clientX, startWidth: props.width, roomWidth: measureRoomWidth() }
  resizing.value = true
  window.addEventListener('pointermove', onResizeMove)
  window.addEventListener('pointerup', onResizeUp)
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'col-resize'
}
onBeforeUnmount(() => {
  if (resizeState) onResizeUp()
})

// ===== 文件标签的未保存守卫 =====
// 同一时刻只会挂载一个文件标签（见模板注释），所以只留最近一次挂载的实例即可。
// 用函数 ref 而不是 v-for 的数组 ref：卸载旧实例时传 null，这里忽略，避免把新实例覆盖掉。
let activeFilePane: any = null
function setFilePaneRef(el: any) {
  if (el) activeFilePane = el
}
/**
 * 宿主（home.vue）在切标签 / 关标签 / 收起侧栏前调用：
 * 当前是文件标签时，让文件视图处理未保存内容（保存 / 不保存 / 取消）；
 * 返回 false 表示用户取消，宿主应放弃本次切换。
 */
async function confirmLeaveActive(): Promise<boolean> {
  const active = props.tabs.find((t) => t.id === props.activeTabId)
  if (!active || active.kind !== 'file') return true
  if (!activeFilePane) return true
  const ok = await activeFilePane.confirmLeave?.()
  return ok !== false
}

// ===== 文件标签的视图选择（点标签栏图标弹出）=====
interface DockMenuAction { value: string; label: string; icon: string; active: boolean }
interface DockMenuState { id: string; x: number; y: number; views: DockMenuAction[] }
const viewMenu = ref<DockMenuState | null>(null)
const viewNameOf = (key: string): string => {
  const def = fileViewByKey(key)
  return def ? (props.zh ? def.name : def.labelEn) : key
}
const viewIconOf = (key: string): string => fileViewByKey(key)?.icon || 'fa fa-eye'

/**
 * 点文件标签的图标：弹出这个文件能选的视图（md 就是 浏览 / 源码编辑 / 可视编辑 / 思维导图 / 演示 …）。
 *
 * 列表来自 FileWindow 的 `availableViews`（ChatDockFile 负责转发）；切换走 `setView`，
 * 并回写标签的 `view`，下次激活该标签仍是这个视图。
 *
 * 为什么以前"点了没反应"：ChatDockFile 只暴露了 confirmLeave，宿主拿到的
 * availableViews 永远是 undefined，菜单于是永远没有条目。
 */
async function openTabMenu(tab: ChatDockTab, e: MouseEvent) {
  if (!tab || tab.kind !== 'file') return
  e.stopPropagation()
  const rect = (e.currentTarget as HTMLElement | null)?.getBoundingClientRect()

  if (tab.id !== props.activeTabId) {
    if (!(await confirmLeaveActive())) return
    emit('activate', tab.id)
    await nextTick()
    await nextTick()
    // 等宿主把 activeTabId 切过去、FileWindow 挂载完成，避免拿到上一个文件的视图表
    for (let i = 0; i < 8; i++) {
      if (props.activeTabId === tab.id && String(activeFilePane?.filePath || '') === String(tab.path || '') && activeFilePane?.availableViews?.length) break
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  const list: string[] = Array.isArray(activeFilePane?.availableViews) ? activeFilePane.availableViews.slice() : []
  if (!list.length) return
  const current = String(activeFilePane?.viewType || tab.view || list[0] || '')
  const views: DockMenuAction[] = list.map((v) => ({
    value: v,
    label: viewNameOf(v),
    icon: viewIconOf(v),
    active: v === current,
  }))
  const x = Math.max(6, Math.min((rect?.left || 12), window.innerWidth - 186))
  const y = Math.max(6, Math.min((rect?.bottom || 40) + 4, window.innerHeight - 240))
  viewMenu.value = { id: tab.id, x, y, views }
}
function chooseView(v: string) {
  const menu = viewMenu.value
  viewMenu.value = null
  if (!menu) return
  if (typeof activeFilePane?.setView === 'function') activeFilePane.setView(v)
  emit('tab-view-change', menu.id, v)
}
const onViewMenuOutside = (e: Event) => {
  if (!viewMenu.value) return
  if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') return
  // 点在菜单内部时不能先关菜单，否则 click 还没派发元素就被移除了
  if (e.type !== 'keydown' && (e.target as HTMLElement)?.closest?.('.dock-view-menu')) return
  viewMenu.value = null
}
onMounted(() => {
  document.addEventListener('mousedown', onViewMenuOutside)
  document.addEventListener('keydown', onViewMenuOutside)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onViewMenuOutside)
  document.removeEventListener('keydown', onViewMenuOutside)
})

defineExpose({ confirmLeaveActive })
</script>

<style scoped>
/* 右侧栏容器：与聊天区同一套「右侧面板」观感（左边框 + 主题背景） */
.chat-dock {
  position: relative;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
  height: 100%;
  border-left: 1px solid var(--borderColor);
  background-color: var(--backgroundColor);
  overflow: hidden;
}
.chat-dock.resizing { transition: none; }

/* 左边缘拖动热区（8px，悬停才显形） */
.chat-dock-resize {
  position: absolute;
  left: -3px;
  top: 0;
  bottom: 0;
  width: 8px;
  cursor: col-resize;
  z-index: 5;
  background: transparent;
}
.chat-dock-resize:hover { background: color-mix(in srgb, var(--fontActiveColor) 25%, transparent); }

/* 标签条：与聊天头部 / 侧栏工具栏同一行高（--topbar-h 由 home.vue 的 .ai-chat-container 定义） */
.chat-dock-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  box-sizing: border-box;
  height: var(--topbar-h, 40px);
  flex-shrink: 0;
  padding: 0 4px;
  border-bottom: 1px solid var(--borderColor);
  background-color: var(--menuColor);
}
.dock-tab-strip {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
}
.dock-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 6px;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
  font-size: 12px;
  color: var(--fontColor);
  opacity: 0.72;
  max-width: 160px;
}
.dock-tab:hover { background: color-mix(in srgb, var(--fontColor) 8%, transparent); opacity: 0.95; }
.dock-tab.active {
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
  opacity: 1;
}
.dock-tab-icon { font-size: 11px; }
/* 文件标签的图标 = 视图选择入口 */
.dock-tab-icon-action {
  padding: 2px;
  margin: -2px;
  border-radius: 3px;
  cursor: pointer;
}
.dock-tab-icon-action:hover { background: color-mix(in srgb, var(--fontColor) 14%, transparent); }
/* 视图选择菜单（fixed，避免被标签条的横向滚动裁掉） */
.dock-view-menu {
  position: fixed;
  z-index: 3200;
  min-width: 168px;
  max-height: 60vh;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  background: var(--backgroundColor);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
}
.dock-view-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 9px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--fontColor);
  font-size: 12px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.dock-view-item i { width: 14px; text-align: center; opacity: 0.8; }
.dock-view-item:hover { background: var(--menuActiveColor); color: var(--fontActiveColor); }
.dock-view-item.active { color: var(--fontActiveColor); font-weight: 600; }
.dock-tab-text { overflow: hidden; text-overflow: ellipsis; }
.dock-tab-close {
  font-size: 10px;
  opacity: 0;
  padding: 1px;
  border-radius: 50%;
}
.dock-tab:hover .dock-tab-close { opacity: 0.6; }
.dock-tab-close:hover { opacity: 1; color: #e81123; }
.dock-tab-back,
.dock-tab-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--fontColor);
  cursor: pointer;
  opacity: 0.75;
}
.dock-tab-back { margin-right: 2px; }
.dock-tab-add:hover,
.dock-tab-back:hover { opacity: 1; color: var(--fontActiveColor); background: color-mix(in srgb, var(--fontColor) 8%, transparent); }

/* 内容区 */
.chat-dock-body {
  flex: 1;
  min-height: 0;
  position: relative;
}
.dock-pane {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* 空面板（未选使用方式）：与「新标签页」同一套语气——先选一个，再往里放内容 */
.dock-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 18px;
  text-align: center;
  color: var(--fontColor);
}
.dock-empty-title { font-size: 12px; opacity: 0.75; }
.dock-empty-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.dock-empty-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  background: var(--menuColor);
  color: var(--fontColor);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.12s ease;
}
.dock-empty-btn:hover {
  border-color: var(--fontActiveColor);
  color: var(--fontActiveColor);
  background: color-mix(in srgb, var(--fontActiveColor) 8%, var(--menuColor));
}
.dock-empty-btn > i { font-size: 13px; }
.dock-empty-hint { font-size: 11px; opacity: 0.5; line-height: 1.5; max-width: 260px; }

/* 窄屏：整个右侧栏变成整屏二级界面（盖住聊天列表与对话区） */
.chat-dock.narrow {
  position: fixed;
  inset: 0;
  width: 100% !important;
  height: 100%;
  z-index: 1200;
  border-left: none;
  animation: dockNarrowIn 0.18s ease;
}
@keyframes dockNarrowIn {
  from { transform: translateX(12px); opacity: 0.6; }
  to { transform: translateX(0); opacity: 1; }
}
</style>
