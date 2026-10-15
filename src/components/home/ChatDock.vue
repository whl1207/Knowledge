<!-- src/components/home/ChatDock.vue
     主页聊天区右侧栏（DSH 同款 dock）：标签条（文件 / 终端 / 浏览器）+ 可拖动调宽 + 内容区。

     职责边界：本组件只管**展示与交互**，标签页数据（哪些标签、当前是哪个、宽度、开关）
     全部由父级（home.vue）按聊天读写并持久化 —— 与输入框草稿同一套「每个聊天各自一份」的做法。
     标签内容按类型渲染：
       - files    → ChatDockFiles.vue（工作区文件树）
       - terminal → ChatDockTerminal.vue（node-pty 真终端）
       - browser  → ChatDockBrowser.vue（主进程 WebContentsView 挂到主窗口） -->
<template>
  <aside
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
          <i class="fa dock-tab-icon" :class="kindIcon(tab.kind)"></i>
          <span class="dock-tab-text">{{ dockTabTitle(tab, tabs, zh) }}</span>
          <i
            class="fa fa-times dock-tab-close"
            :title="zh ? '关闭这个标签' : 'Close this tab'"
            @click.stop="emit('close-tab', tab.id)"
          ></i>
        </div>
      </div>

      <!-- 新建标签：文件 / 终端 / 浏览器（与 DSH 一致） -->
      <div class="dock-add-wrap">
        <button class="dock-tab-add" :title="zh ? '新建标签（文件 / 终端 / 浏览器）' : 'New tab (Files / Terminal / Browser)'" @click.stop="toggleAddMenu">
          <i class="fa fa-plus"></i>
        </button>
        <div v-if="addMenuOpen" class="dock-add-menu" @click.stop>
          <button v-for="kind in availableKinds" :key="kind" class="dock-add-item" @click="onAdd(kind)">
            <i class="fa" :class="kindIcon(kind)"></i>
            <span>{{ kindLabel(kind) }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 内容区：每个标签一个常驻面板（切标签只是 v-show，切回来不丢状态；首次激活才挂载） -->
    <div class="chat-dock-body">
      <!-- 空面板：和新标签页一样，先让用户选一种使用方式（终端 / 文件 / 浏览器） -->
      <div v-if="!tabs.length" class="dock-empty">
        <div class="dock-empty-title">{{ zh ? '选择右侧栏的使用方式' : 'Choose what to show here' }}</div>
        <div class="dock-empty-actions">
          <button
            v-for="kind in availableKinds"
            :key="kind"
            class="dock-empty-btn"
            :title="kindHint(kind)"
            @click="emit('add', kind)"
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
        <div v-if="everActive.has(tab.id)" v-show="tab.id === activeTabId" class="dock-pane">
          <ChatDockFiles
            v-if="tab.kind === 'files'"
            :active="tab.id === activeTabId"
            :root-path="chatWorkspace"
            @insert-text="(t: string) => emit('insert-text', t)"
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
        </div>
      </template>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ChatDockFiles from './ChatDockFiles.vue'
import ChatDockTerminal from './ChatDockTerminal.vue'
import ChatDockBrowser from './ChatDockBrowser.vue'
import {
  DOCK_TAB_KINDS,
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
  zh: boolean
}>()

const emit = defineEmits<{
  (e: 'update:width', width: number): void
  (e: 'resize-end'): void
  (e: 'activate', id: string): void
  (e: 'add', kind: ChatDockTabKind): void
  (e: 'close-tab', id: string): void
  (e: 'close'): void
  (e: 'insert-text', text: string): void
}>()

const zh = computed(() => props.zh)

function kindIcon(kind: ChatDockTabKind): string {
  if (kind === 'terminal') return 'fa-terminal'
  if (kind === 'browser') return 'fa-globe'
  return 'fa-folder-open-o'
}
function kindLabel(kind: ChatDockTabKind): string {
  if (kind === 'terminal') return props.zh ? '终端' : 'Terminal'
  if (kind === 'browser') return props.zh ? '浏览器' : 'Browser'
  return props.zh ? '文件' : 'Files'
}
/** 空面板里每个选项的一句话说明 */
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

// ===== 新建标签菜单 =====
/** 只列出当前环境真的能用的类型（安卓 / 纯网页没有 PTY，就不给「终端」入口） */
const availableKinds = computed(() => DOCK_TAB_KINDS.filter((k) => k !== 'terminal' || hasCapability('terminal')))
const addMenuOpen = ref(false)
const toggleAddMenu = () => { addMenuOpen.value = !addMenuOpen.value }
const onAdd = (kind: ChatDockTabKind) => {
  addMenuOpen.value = false
  emit('add', kind)
}
/** 点空白处关闭菜单（与 home.vue 里预设浮层同一套做法） */
const onDocMouseDown = (e: MouseEvent) => {
  if (!addMenuOpen.value) return
  const el = (e.target as HTMLElement)?.closest?.('.dock-add-wrap')
  if (!el) addMenuOpen.value = false
}
onMounted(() => document.addEventListener('mousedown', onDocMouseDown))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocMouseDown))

// ===== 拖动调宽（指针事件 + 左边缘 8px 热区；松手才落盘）=====
const resizing = ref(false)
let resizeState: { startX: number; startWidth: number } | null = null

const onResizeMove = (e: PointerEvent) => {
  if (!resizeState) return
  // 手柄在左边缘：向左拖 = 变宽
  emit('update:width', resizeState.startWidth + (resizeState.startX - e.clientX))
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
  resizeState = { startX: e.clientX, startWidth: props.width }
  resizing.value = true
  window.addEventListener('pointermove', onResizeMove)
  window.addEventListener('pointerup', onResizeUp)
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'col-resize'
}
onBeforeUnmount(() => {
  if (resizeState) onResizeUp()
})
</script>

<style scoped>
/* 右侧栏容器：与 .branch-panel 同一套「右侧面板」观感（左边框 + 主题背景） */
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

/* 新建标签菜单 */
.dock-add-wrap { position: relative; flex-shrink: 0; }
.dock-add-menu {
  position: absolute;
  right: 0;
  top: 24px;
  z-index: 30;
  min-width: 132px;
  padding: 4px;
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  background: var(--menuColor);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.dock-add-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--fontColor);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}
.dock-add-item:hover { background: var(--menuActiveColor); color: var(--fontActiveColor); }

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
