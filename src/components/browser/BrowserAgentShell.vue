<!-- src/components/browser/BrowserAgentShell.vue
     浏览器 Agent 独立窗口（M0/M1 + 多标签）——无边框 Vue 壳（浏览器模块，独立于 knowFile）。
     布局：顶部多标签栏（36px）+ 其下地址/导航栏（42px）；
           下方内容区左侧为网页（主进程按标签创建的 WebContentsView 承载），
           右侧可展开「设置」停靠栏（收起时网页占满整宽；展开时主进程让出右栏宽度，DOM 侧栏与原生网页并排不遮挡）。
     壳通过 browser-agent:* IPC 与主进程 browser-agent.ts 交互（标签增删/切换、导航、状态、停靠栏）。 -->
<template>
  <div class="browser-agent-shell">
    <!-- ====== ① 标签栏（36px，与主进程 TAB_BAR_H 一致；无边框窗口拖动区） ====== -->
    <div class="ba-tabbar">
      <div
        v-for="t in state.tabs"
        :key="t.id"
        class="ba-tab"
        draggable="true"
        :class="{
          active: t.id === state.activeTabId,
          'ba-tab-drop-before': dropHint && dropHint.id === t.id && dropHint.pos === 'before',
          'ba-tab-drop-after': dropHint && dropHint.id === t.id && dropHint.pos === 'after',
        }"
        @click="switchTab(t.id)"
        @dragstart="tabDragStart(t.id, $event)"
        @dragover.prevent="tabDragOver(t.id, $event)"
        @dragleave="tabDragLeave"
        @drop.prevent="tabDrop(t.id, $event)"
        @dragend="tabDragEnd"
        :title="t.url || (zh ? '新标签页' : 'New Tab') "
      >
        <i v-if="t.loading" class="fa ba-tab-favicon fa-spinner fa-spin"></i>
        <img v-else-if="t.favicon" class="ba-tab-favicon-img" :src="t.favicon" alt="" draggable="false" />
        <i v-else class="fa ba-tab-favicon fa-globe"></i>
        <span class="ba-tab-title">
          <i v-if="(t as any).agent" class="fa fa-android ba-tab-agent" :title="zh ? 'AI 会话标签 · 空闲后自动回收；点击即接管保留' : 'AI session tab · auto-recycled when idle; click to keep'" @click.stop="switchTab(t.id)"></i>
          {{ t.title || (zh ? '新标签页' : 'New Tab') }}
        </span>
        <i class="fa fa-times ba-tab-close" :title="zh ? '关闭标签页' : 'Close tab'" @click.stop="closeTab(t.id)"></i>
      </div>
      <button class="ba-tab-add" :title="zh ? '新建标签页' : 'New tab'" @click="addTab()">
        <i class="fa fa-plus"></i>
      </button>
      <div class="ba-flex"></div>

      <!-- 自绘窗口控制（无边框，仿主应用风格） -->
      <div class="ba-win-btns">
        <button class="ba-win-btn" :title="zh ? '最小化' : 'Minimize'" @click="minimizeWindow">
          <i class="fa fa-window-minimize"></i>
        </button>
        <button class="ba-win-btn" :title="isMaximized ? (zh ? '还原' : 'Restore') : (zh ? '最大化' : 'Maximize')" @click="maximizeWindow">
          <i class="fa" :class="isMaximized ? 'fa-window-restore' : 'fa-window-maximize'"></i>
        </button>
        <button class="ba-win-btn ba-win-close" :title="zh ? '关闭' : 'Close'" @click="closeWindow">
          <i class="fa fa-times"></i>
        </button>
      </div>
    </div>

    <!-- ====== ② 地址 / 导航栏（42px，与主进程 NAV_BAR_H 一致）；窗口过小时隐藏，仅保留标签栏 ====== -->
    <div v-show="!compactNav" class="ba-navbar">
      <button class="ba-btn" :disabled="!state.canGoBack" :title="zh ? '后退' : 'Back'" @click="action('back')">
        <i class="fa fa-arrow-left"></i>
      </button>
      <button class="ba-btn" :disabled="!state.canGoForward" :title="zh ? '前进' : 'Forward'" @click="action('forward')">
        <i class="fa fa-arrow-right"></i>
      </button>
      <button class="ba-btn" :title="state.loading ? (zh ? '停止加载' : 'Stop') : (zh ? '刷新' : 'Refresh')" @click="state.loading ? action('stop') : action('reload')">
        <i class="fa" :class="state.loading ? 'fa-times' : 'fa-refresh'"></i>
      </button>

      <!-- 地址栏 -->
      <div class="ba-addr">
        <i class="fa ba-addr-icon" :class="isSecure ? 'fa-lock' : 'fa-globe'"></i>
        <input
          ref="addrInput"
          v-model="urlInput"
          class="ba-addr-input"
          spellcheck="false"
          :placeholder="zh ? '输入网址，回车打开（支持 https:// 或裸域名）' : 'Enter URL and press Enter'"
          @keydown.enter="navigate()"
        />
        <span v-if="state.loading" class="ba-addr-loading"><i class="fa fa-spinner fa-spin"></i></span>
      </div>

      <!-- 顶部右侧：⭐ 收藏当前页 / 🏷️ 收藏夹（打开侧栏树状管理）/ ⚙ 设置。其余页面操作折叠进侧栏 -->
      <button class="ba-btn ba-star-btn" :class="{ on: isBookmarked }" :disabled="!state.url"
        :title="isBookmarked ? (zh ? '取消收藏（书签）' : 'Remove bookmark') : (zh ? '收藏当前页（书签）' : 'Bookmark current page') "
        @click="toggleBookmark">
        <i class="fa" :class="isBookmarked ? 'fa-star' : 'fa-star-o'"></i>
      </button>
      <button class="ba-btn ba-fav-btn" :class="{ on: railOpen && railView === 'bookmarks' }"
        :title="railOpen && railView === 'bookmarks' ? (zh ? '关闭收藏夹' : 'Close bookmarks') : (zh ? '收藏夹（树状管理，可拖拽整理）' : 'Bookmarks (tree manager, drag to organize)') "
        @click="toggleBookmarks">
        <i class="fa fa-tag"></i>
      </button>
      <button class="ba-btn ba-settings-btn" :class="{ on: railOpen && railView === 'settings' }"
        :title="railOpen && railView === 'settings' ? (zh ? '关闭右侧设置栏' : 'Close settings panel') : (zh ? '设置（打开右侧栏）' : 'Settings (open side panel)') "
        @click="toggleSettings">
        <i class="fa" :class="railOpen && railView === 'settings' ? 'fa-times' : 'fa-cog'"></i>
        <i v-if="!railOpen && agentBusyDot" class="fa fa-circle ba-settings-busy" :title="zh ? 'AI 正在此标签操作…' : 'AI is operating this tab…'"></i>
      </button>
    </div>

    <!-- ====== ③ 内容区：左侧网页/页面占位 + 右侧「设置」停靠栏（DOM）。原生网页视图仅覆盖左侧；展开停靠栏时主进程让出右栏宽度 → 二者并排互不遮挡 ====== -->
    <div class="ba-body">
      <!-- 左侧：页面内容（新标签搜索首页等 DOM 在原生视图隐藏/空白时露出；有 URL 时由原生视图承载） -->
      <div class="ba-main">
        <div class="ba-page">
          <!-- 新标签搜索首页：搜索框固定顶部 + 下方收藏夹 grid（随窗口大小限量 / 可展开全部） -->
          <div v-if="activeTab && !state.url" ref="homeEl" class="ba-home">
            <div class="ba-search-home">
              <div class="ba-search-box">
                <i class="fa fa-search ba-search-ic"></i>
                <input
                  ref="homeSearchInput"
                  v-model="homeQuery"
                  class="ba-search-input"
                  spellcheck="false"
                  :placeholder="zh ? '在 Bing 中搜索，或输入网址直接打开' : 'Search Bing, or type a URL to open'"
                  @keydown.enter="searchHome()"
                />
              </div>
            </div>
            <!-- 收藏夹快捷入口：文件夹形式（顶层 → 点击进入下一级文件夹/书签）；超出可在底部展开全部 -->
            <div ref="bmBoxEl" class="ba-home-bookmarks scoll">
              <!-- 当前所在文件夹导航（根目录不显示；空文件夹时也要能返回） -->
              <div v-if="homePath.length" class="ba-home-bm-nav">
                <span class="ba-home-bm-back" @click="homeUp"><i class="fa fa-arrow-left"></i>{{ zh ? ' 返回' : ' Back' }}</span>
                <span class="ba-home-bm-crumb" :title="currentDirRel"><i class="fa fa-folder-open-o"></i>{{ currentDirName }}</span>
              </div>
              <div v-if="!homeBookmarks.length" class="ba-home-bm-empty">
                <template v-if="homePath.length"><i class="fa fa-folder-open-o"></i>&nbsp;{{ zh ? '该文件夹为空' : 'This folder is empty' }}</template>
                <template v-else>{{ zh ? '暂无收藏：在任意网页点顶部 ⭐ 即可收藏，之后会显示在这里' : 'No bookmarks yet: click the ⭐ on any page, they will show up here' }}</template>
              </div>
              <template v-else>
                <div class="ba-home-bm-grid">
                  <div
                    v-for="b in visibleHomeBookmarks"
                    :key="b.rel"
                    class="ba-home-bm-item"
                    :class="{ dir: b.kind === 'dir' }"
                    :title="b.kind === 'dir' ? `${b.title}（${zh ? '文件夹，点击进入' : 'folder, click to open'}）` : `${b.title}\n${b.url}`"
                    @click="homeTileClick(b)"
                    @contextmenu.prevent.stop="openItemCtx(b)"
                  >
                    <!-- 悬浮右上角：文件夹 → 删除；普通书签 → 编辑；离线整页快照 → 删除 -->
                    <template v-if="b.kind === 'dir'">
                      <button
                        class="ba-home-bm-del"
                        :title="zh ? '删除该文件夹（含内部书签）' : 'Delete this folder (with its bookmarks)'"
                        @click.stop="deleteHomeDir(b)"
                      ><i class="fa fa-trash-o"></i></button>
                    </template>
                    <template v-else-if="b.kind === 'file'">
                      <button
                        v-if="!isSnapshotBm(b)"
                        class="ba-home-bm-del edit"
                        :title="zh ? '编辑标题/地址' : 'Edit title / URL'"
                        @click.stop="editHomeBm(b)"
                      ><i class="fa fa-pencil"></i></button>
                      <button
                        v-else
                        class="ba-home-bm-del"
                        :title="zh ? '删除该离线快照' : 'Delete this snapshot'"
                        @click.stop="deleteHomeBm(b)"
                      ><i class="fa fa-trash-o"></i></button>
                    </template>
                    <span class="ba-home-bm-icon">
                      <i v-if="b.kind === 'dir'" class="fa fa-folder ba-home-bm-folder"></i>
                      <template v-else>
                        <img
                          v-if="favImgSrc(b)"
                          class="ba-home-bm-img"
                          :src="favImgSrc(b)"
                          draggable="false"
                          alt=""
                          @error="onHomeFavError(b)"
                        />
                        <span v-else class="ba-home-bm-avatar" :style="{ backgroundColor: avatarColor(b.host) }">{{ avatarLetter(b) }}</span>
                      </template>
                    </span>
                    <span class="ba-home-bm-name">{{ b.title }}</span>
                  </div>
                </div>
                <div v-if="moreHomeBmCount > 0" class="ba-home-bm-more" @click="homeBmExpanded = !homeBmExpanded">
                  <i class="fa" :class="homeBmExpanded ? 'fa-angle-up' : 'fa-angle-down'"></i>
                  <span>{{ homeBmExpanded ? (zh ? '收起' : 'Collapse') : (zh ? `展开全部（还有 ${moreHomeBmCount} 个）` : `Show all (${moreHomeBmCount} more)`) }}</span>
                </div>
              </template>
            </div>
          </div>
        <!-- 无任何标签时的空态（极少见） -->
        <div v-else-if="!state.url" class="ba-empty">
          <i class="fa fa-globe" style="font-size: 34px;"></i>
          <p>{{ zh ? '浏览器 Agent' : 'Browser Agent' }}</p>
          <p class="ba-empty-sub">
            {{ zh
              ? '在上方地址栏输入网址回车，点 + 可新建标签页；或直接让通用智能体调用 browser_navigate / browser_extract_text / browser_screenshot 控制此窗口。'
              : 'Type a URL in the address bar, press + for a new tab; or ask the agent to call browser_navigate / browser_extract_text / browser_screenshot.' }}
          </p>
        </div>
        <div v-else class="ba-mini-status">
          <i class="fa" :class="state.agentActive ? 'fa-android' : 'fa-file-text-o'"></i>
          <span class="ba-mini-title">{{ state.title || state.url }}</span>
        </div>
        </div>
      </div>

      <!-- 右侧停靠栏（设置 / 收藏夹 双视图，独立模块组件承载；收起时宽 0，展开时网页让出右栏） -->
      <aside class="ba-rail" :class="{ open: railOpen }">
        <!-- 收起时（宽 0）连同 inert 禁用内部控件聚焦，避免键盘 Tab 落入隐藏栏 -->
        <div class="ba-rail-inner" :inert="!railOpen">
          <!-- 无头部/关闭按钮（工具栏 ⚙ / 📁 即可开/关侧栏）：内容区直接从顶部开始滚动 -->
          <div class="ba-rail-body">
            <!-- 设置面板（独立模块：BrowserRailSettings） -->
            <template v-if="railView === 'settings'">
              <BrowserRailSettings
                :chip="agentChip"
                :url="state.url"
                :allow-eval="state.allowEval"
                :active="railOpen && railView === 'settings'"
                :on-open-external="openExternal"
                :on-save-page="savePage"
                :on-recycle="recycleAgentTabs"
                :on-devtools="openDevtools"
                :on-toggle-eval="toggleEval"
              />
            </template>
            <!-- 收藏夹面板（独立模块：BrowserBookmarksPanel） -->
            <template v-else-if="railView === 'bookmarks'">
              <BrowserBookmarksPanel :dir="browserBaseDir()" :items="bmItems" :active="railOpen && railView === 'bookmarks'" @changed="refreshBookmarks" />
            </template>
          </div>
        </div>
      </aside>
    </div>

    <!-- 轻提示（显示在标签/地址栏区域；网页视图区域为原生层无法被覆盖） -->
    <transition name="ba-toast-fade">
      <div v-if="toastMsg" class="ba-toast" :class="{ err: toastKind === 'err' }">{{ toastMsg }}</div>
    </transition>

    <!-- 编辑书签模态框：修改标题 / 网址 -->
    <div v-if="bmEditVisible" class="ba-bm-edit-overlay" @click.self="closeEditBm">
      <div class="ba-bm-edit-modal">
        <div class="ba-bm-edit-head">
          <span><i class="fa fa-pencil"></i> {{ zh ? '编辑' : 'Edit' }}</span>
          <button class="ba-bm-edit-x" :title="zh ? '关闭' : 'Close'" @click="closeEditBm"><i class="fa fa-times"></i></button>
        </div>
        <div class="ba-bm-edit-row">
          <label>{{ zh ? '标题' : 'Title' }}</label>
          <input v-model="bmEditTitle" class="ba-bm-edit-input" spellcheck="false" :placeholder="zh ? '收藏显示的名称' : 'Bookmark title'" @keydown.enter="saveEditBm" />
        </div>
        <div class="ba-bm-edit-row">
          <label>{{ zh ? '地址' : 'URL' }}</label>
          <input v-model="bmEditUrl" class="ba-bm-edit-input" spellcheck="false" placeholder="https://..." @keydown.enter="saveEditBm" />
        </div>
        <div v-if="bmEditError" class="ba-bm-edit-err">{{ bmEditError }}</div>
        <div class="ba-bm-edit-foot">
          <button class="ba-bm-edit-btn" :disabled="bmEditSaving" @click="openEditingInTab"><i class="fa fa-external-link"></i> {{ zh ? '打开' : 'Open' }}</button>
          <button class="ba-bm-edit-btn" :disabled="bmEditSaving" @click="copyEditingUrl"><i class="fa fa-copy"></i> {{ zh ? '复制地址' : 'Copy URL' }}</button>
          <button class="ba-bm-edit-btn danger" :disabled="bmEditSaving" @click="deleteEditingBm"><i class="fa fa-trash-o"></i> {{ zh ? '删除' : 'Delete' }}</button>
          <div style="flex:1"></div>
          <button class="ba-bm-edit-btn" @click="closeEditBm">{{ zh ? '取消' : 'Cancel' }}</button>
          <button class="ba-bm-edit-btn primary" :disabled="bmEditSaving" @click="saveEditBm"><i class="fa fa-check"></i> {{ zh ? '保存' : 'Save' }}</button>
        </div>
      </div>
    </div>

    <!-- 文件夹右键设置模态框（进入 / 复制路径 / 删除） -->
    <div v-if="fldCtxVisible" class="ba-bm-edit-overlay" @click.self="closeFldCtx">
      <div class="ba-bm-edit-modal">
        <div class="ba-bm-edit-head">
          <span><i class="fa fa-folder-open-o"></i> {{ zh ? '文件夹设置' : 'Folder settings' }}</span>
          <button class="ba-bm-edit-x" :title="zh ? '关闭' : 'Close'" @click="closeFldCtx"><i class="fa fa-times"></i></button>
        </div>
        <div class="ba-bm-edit-row">
          <label>{{ zh ? '名称' : 'Name' }}</label>
          <div class="ba-bm-fld-name" :title="fldCtxPath">{{ fldCtxTitle }}</div>
        </div>
        <div v-if="fldCtxErr" class="ba-bm-edit-err">{{ fldCtxErr }}</div>
        <div class="ba-bm-edit-foot">
          <button class="ba-bm-edit-btn" :disabled="fldDeleting" @click="enterFldCtx"><i class="fa fa-folder-open-o"></i> {{ zh ? '进入' : 'Open' }}</button>
          <button class="ba-bm-edit-btn" :disabled="fldDeleting" @click="copyFldCtxPath"><i class="fa fa-copy"></i> {{ zh ? '复制路径' : 'Copy path' }}</button>
          <button class="ba-bm-edit-btn danger" :disabled="fldDeleting" @click="delFldCtx"><i class="fa fa-trash-o"></i> {{ zh ? '删除' : 'Delete' }}</button>
          <div style="flex:1"></div>
          <button class="ba-bm-edit-btn" @click="closeFldCtx">{{ zh ? '关闭' : 'Close' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { usestore } from '@/store'
import { ElMessageBox } from 'element-plus'
import BrowserRailSettings from '@/components/browser/BrowserRailSettings.vue'
import BrowserBookmarksPanel from '@/components/browser/BrowserBookmarksPanel.vue'

const store = usestore()
const zh = computed(() => store.locales === 'zh')

interface TabMeta {
  id: string
  title: string
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** 网站图标（主进程抓取的真实 favicon dataURL） */
  favicon?: string
  agent?: boolean
}

const urlInput = ref('')
const isMaximized = ref(false)

const state = reactive<{
  tabs: TabMeta[]
  activeTabId: string | null
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  agentActive: boolean
  agentBusyTabId: string | null
  agentTool: string
  allowEval: boolean
}>({
  tabs: [], activeTabId: null, url: '', title: '', loading: false,
  canGoBack: false, canGoForward: false, agentActive: false, agentBusyTabId: null, agentTool: '', allowEval: false,
})

const activeTab = computed(() => state.tabs.find(t => t.id === state.activeTabId) || null)
const isSecure = computed(() => /^https:/.test(state.url))
// 当前标签是否为 AI 会话标签（决定 chip 显示 AI 状态还是普通浏览状态）
const curIsAgentTab = computed(() => !!(activeTab.value as any)?.agent)
// agent 状态 chip：跟随当前激活标签
const agentChip = computed(() => {
  // AI 正在操作这个标签（当前标签是 AI 忙碌目标标签）才显示高亮忙碌
  const busy = state.agentActive && !!state.agentBusyTabId && state.activeTabId === state.agentBusyTabId
  if (busy) {
    return {
      cls: 'active',
      icon: 'fa-spinner fa-spin',
      text: state.agentTool || (zh.value ? '操作中' : 'Busy'),
      title: zh.value ? `AI 正在此标签操作（${state.agentTool}）…` : `AI is operating this tab (${state.agentTool})…`,
    }
  }
  if (curIsAgentTab.value) {
    return {
      cls: 'agent',
      icon: 'fa-android',
      text: 'AI',
      title: zh.value ? 'AI 会话标签：空闲时可由通用智能体调用 browser_* 工具在此标签操作' : 'AI session tab: agents can call browser_* tools here',
    }
  }
  return {
    cls: 'plain',
    icon: 'fa-globe',
    text: zh.value ? '浏览' : 'Web',
    title: zh.value ? '普通标签页（手动浏览）' : 'Normal tab (manual browsing)',
  }
})

// ===== 右侧停靠栏（设置 / 收藏夹 双视图共用同一栏位）：展开时网页让出右侧宽度（与主进程 browser-agent:set-rail 联动） =====
const SIDE_RAIL_W = 320 // 与 .ba-rail.open 的宽度一致，须同步主进程让位宽度
const railOpen = ref(false)
const railView = ref<'settings' | 'bookmarks'>('settings')
// 当前标签正被 AI 操作：停靠栏收起时在设置按钮上显示小红点（展开后侧栏内有完整状态行）
const agentBusyDot = computed(() =>
  !!state.agentActive && !!state.agentBusyTabId && state.activeTabId === state.agentBusyTabId
)

const syncRail = async () => {
  await invoke('browser-agent:set-rail', { open: railOpen.value, width: SIDE_RAIL_W }).catch(() => {})
}

/** 打开指定侧栏视图；同视图再次点击则收起；切换视图保持展开 */
const openRail = async (view: 'settings' | 'bookmarks') => {
  if (!railOpen.value) {
    // 展开前先同步可能已在主窗口修改的浏览器偏好，并刷新收藏状态
    syncBrowserPrefs()
    void refreshBookmarks()
  }
  if (railOpen.value && railView.value === view) {
    railOpen.value = false
  } else {
    railOpen.value = true
    railView.value = view
  }
  await syncRail()
}
const toggleSettings = () => openRail('settings')
const toggleBookmarks = () => openRail('bookmarks')

// 从主窗口最近写入的 localStorage 同步浏览器偏好（默认页/保存文件夹），
// 避免主窗口「设置 → 基础 → 浏览器」改动后本独立窗口仍读到旧值
const syncBrowserPrefs = () => {
  try {
    const raw = localStorage.getItem('UI')
    if (raw) {
      const ui = JSON.parse(raw)
      if (ui && typeof ui === 'object') {
        if (typeof ui.browserHomeUrl === 'string') store.UI.browserHomeUrl = ui.browserHomeUrl
        if (typeof ui.browserSaveDir === 'string') store.UI.browserSaveDir = ui.browserSaveDir
      }
    }
  } catch { /* 忽略 */ }
}

const invoke = (channel: string, payload?: any) =>
  window.ipcRenderer?.invoke ? window.ipcRenderer.invoke(channel, payload) : Promise.reject(new Error('IPC 不可用'))

// ===== 紧凑模式：窗口过小时隐藏地址/工具条，仅保留标签栏（宽度或高度低于阈值即触发；与主进程 browser-agent:set-compact 联动） =====
const COMPACT_W = 760 // 窄窗口阈值（px）
const COMPACT_H = 520 // 矮窗口阈值（px）
const compactNav = ref(false)
const measureCompact = () => {
  const w = window.innerWidth || 0
  const h = window.innerHeight || 0
  compactNav.value = (w > 0 && w < COMPACT_W) || (h > 0 && h < COMPACT_H)
}
const onWinResize = () => { measureCompact() }
// 紧凑状态变化 → 通知主进程调整网页视图顶部高度
watch(compactNav, (c) => { void invoke('browser-agent:set-compact', { compact: c }).catch(() => {}) })

const applyState = (s: any) => {
  if (!s) return
  state.tabs = Array.isArray(s.tabs) ? s.tabs.map((t: any) => ({ ...t })) : []
  state.activeTabId = s.activeTabId || null
  state.url = s.url || ''
  state.title = s.title || ''
  state.loading = !!s.loading
  state.canGoBack = !!s.canGoBack
  state.canGoForward = !!s.canGoForward
  state.agentActive = !!s.agentActive
  state.agentBusyTabId = s.agentBusyTabId || null
  state.agentTool = s.agentTool || ''
  state.allowEval = !!s.allowEval
}

const onEvent = (_e: any, payload: any) => applyState(payload)

// 主题广播：主窗口切换主题后应用（更新 store.UI + 重设 CSS 变量），本窗口跟随
const onThemeChanged = (_event: any, ui: any) => {
  store.applyThemeFromBroadcast(ui)
  sendBrowserTheme()
}
// 把当前主题色同步给主进程，用于内嵌网页内容滚动条等按主题着色
const sendBrowserTheme = () => {
  const u = store.UI
  window.ipcRenderer?.invoke('browser-agent:set-theme', {
    ui: {
      fontColor: u?.fontColor || '#888888',
      fontActiveColor: u?.fontActiveColor || '#409eff',
      backgroundColor: u?.backgroundColor || '#ffffff',
      menuColor: u?.menuColor || '#f6f8fa',
      borderColor: u?.borderColor || '#d0d7de',
    },
  }).catch(() => {})
}

// 激活标签变化时同步地址栏文本；切到空白（新）标签 → 自动聚焦首页搜索框
watch(() => state.activeTabId, async () => {
  const tab = activeTab.value
  urlInput.value = tab?.url || ''
  if (tab && !tab.url && !tab.loading) {
    await nextTick()
    homeSearchInput.value?.focus()
  }
})

// 当前标签 URL 变化（AI navigate / 页面跳转 / 前进后退）→ 实时同步地址栏；
// 用户在地址栏编辑（聚焦）时不覆盖输入内容，失焦/回车后以最后一次状态为准。
const addrInput = ref<HTMLInputElement | null>(null)
watch(() => state.url, () => {
  const el = addrInput.value
  if (el && document.activeElement === el) return
  urlInput.value = state.url || ''
})

const addTab = async (u?: string) => { await invoke('browser-agent:add-tab', u ? { url: u } : {}).catch(() => {}) }
const switchTab = async (id: string) => { await invoke('browser-agent:switch-tab', { id }).catch(() => {}) }
const closeTab = async (id: string) => { await invoke('browser-agent:close-tab', { id }).catch(() => {}) }
// ===== 标签拖拽排序（可视即时重排 + 同步主进程顺序） =====
const dropHint = ref<{ id: string; pos: 'before' | 'after' } | null>(null)
const dragTabId = ref('')
const tabDragStart = (id: string, e: DragEvent) => {
  dragTabId.value = id
  dropHint.value = null
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
  }
}
const tabDragOver = (id: string, e: DragEvent) => {
  if (!dragTabId.value || dragTabId.value === id) return
  const el = e.currentTarget as HTMLElement
  const r = el.getBoundingClientRect()
  dropHint.value = { id, pos: e.clientX < r.left + r.width / 2 ? 'before' : 'after' }
}
const tabDragLeave = () => { if (!dragTabId.value) dropHint.value = null }
const tabDragEnd = () => { dragTabId.value = ''; dropHint.value = null }
const tabDrop = (id: string, _e: DragEvent) => {
  const srcId = dragTabId.value
  const hint = dropHint.value
  tabDragEnd()
  if (!srcId || srcId === id || !hint) return
  const arr = state.tabs
  const from = arr.findIndex(t => t.id === srcId)
  const j = arr.findIndex(t => t.id === id)
  if (from < 0 || j < 0 || from === j) return
  let final = hint.pos === 'after' ? j + 1 : j
  if (from < final) final -= 1 // 移除靠前元素后目标下标前移一位
  final = Math.max(0, Math.min(arr.length - 1, final))
  const next = [...arr]
  const [tab] = next.splice(from, 1)
  next.splice(final, 0, tab)
  state.tabs = next
  void invoke('browser-agent:move-tab', { id: srcId, toIndex: final }).catch(() => {})
}
// 回收 AI 会话标签页（保留正在查看的标签）：带数量反馈
const recycleAgentTabs = async () => {
  const res = await invoke('browser-agent:recycle-agent-tabs').catch(() => null)
  if (res?.ok) {
    const n = Number(res.closed) || 0
    showToast(n > 0
      ? (zh.value ? `已回收 ${n} 个 AI 会话标签` : `Recycled ${n} AI session tabs`)
      : (zh.value ? '没有可回收的 AI 会话标签' : 'No AI session tabs to recycle'))
  } else {
    showToast(res?.error || (zh.value ? '回收失败' : 'Recycle failed'), 'err')
  }
}

// 判定是否像“标准链接”：含 scheme / file / localhost-IP / 点分域名（含端口/路径）。
// 否则视为搜索词 → Bing 搜索
const isLikelyUrl = (raw: string): boolean => {
  const v = raw.trim()
  if (!v) return false
  if (/\s/.test(v)) return false
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(v)) return true
  if (v.startsWith('file:')) return true
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])([:/]|$)/i.test(v)) return true
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(v)) return true
  return false
}
const navigate = async () => {
  let u = urlInput.value.trim()
  if (!u) return
  // 非标准链接格式（纯关键词 / 句子）→ 交给 Bing 搜索
  if (!isLikelyUrl(u)) {
    u = `https://www.bing.com/search?q=${encodeURIComponent(u)}`
  }
  await invoke('browser-agent:navigate', { url: u }).catch(() => {})
}
// 首页搜索框：URL 直接打开；其他内容默认用 Bing 搜索
const homeQuery = ref('')
const homeSearchInput = ref<HTMLInputElement | null>(null)
const searchHome = async () => {
  let q = homeQuery.value.trim()
  if (!q) return
  if (!isLikelyUrl(q)) q = `https://www.bing.com/search?q=${encodeURIComponent(q)}`
  homeQuery.value = ''
  await invoke('browser-agent:navigate', { url: q }).catch(() => {})
}
const action = async (a: string) => {
  await invoke('browser-agent:action', { action: a }).catch(() => {})
}
const toggleEval = async (v: boolean) => {
  state.allowEval = v
  await invoke('browser-agent:set-eval', { enabled: v }).catch(() => {})
}
const openExternal = async () => {
  if (state.url && window.open) window.open(state.url, '_blank')
}
// 自绘窗口控制（无边框窗口；IPC 按发送方窗口定位）
const minimizeWindow = async () => { await window.ipcRenderer?.invoke('minimize-window').catch(() => {}) }
const maximizeWindow = async () => {
  isMaximized.value = !isMaximized.value
  await window.ipcRenderer?.invoke('maximize-window').catch(() => {})
}
const closeWindow = async () => {
  store.saveConfig()
  await window.ipcRenderer?.invoke('close-window').catch(() => {})
}

// ===== 轻提示（toast） =====
const toastMsg = ref('')
const toastKind = ref<'ok' | 'err'>('ok')
let toastTimer: ReturnType<typeof setTimeout> | null = null
const showToast = (msg: string, kind: 'ok' | 'err' = 'ok') => {
  toastMsg.value = msg
  toastKind.value = kind
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastMsg.value = '' }, 3000)
}
const onToastEvent = (_e: any, payload: any) => {
  if (payload?.message) showToast(payload.message, 'err')
}

// ===== 浏览器落盘目录：优先「浏览器设置 → 保存文件夹」；未设置则回退当前工作区根目录 =====
// （收藏书签与离线保存整页共用该目录；留空时收藏仍写入工作区根，可被文件结构管理）
const browserBaseDir = () => {
  const saveDir = (store.UI?.browserSaveDir || '').trim()
  return saveDir || store.root || ''
}

// ===== 收藏（保存为 *.html 跳转页文件，落在 browserBaseDir；主进程 list-bookmarks 原始条目含目录/文件/顺序） =====
interface BookmarkEntry { kind: 'dir' | 'file'; rel: string; name: string; title: string; path: string; url: string; icon: string; order: number | null }
const bmItems = ref<BookmarkEntry[]>([])
// 收藏目录 / 条目指纹：外部文件变化、收藏夹打开轮询时据此判断是否需要真正更新 DOM（避免无谓重渲染）
let lastBmDir = ''
let lastBmSig = ''
const refreshBookmarks = async () => {
  const dir = browserBaseDir()
  if (!dir) { bmItems.value = []; lastBmDir = ''; lastBmSig = ''; return }
  // 收藏位置变化 → 强制刷新（不同目录指纹不具可比性）
  if (dir !== lastBmDir) { lastBmDir = dir; lastBmSig = '' }
  const res = await invoke('browser-agent:list-bookmarks', { root: dir }).catch(() => null)
  const items = (res?.ok ? res.items : []) || []
  const sig = items.map((it: any) =>
    `${it?.kind === 'dir' ? 'd' : 'f'}|${it?.rel || ''}|${it?.name || ''}|${it?.title || ''}|${it?.url || ''}|${it?.path || ''}|${it?.order ?? ''}`).join('~')
  if (sig === lastBmSig) return
  lastBmSig = sig
  bmItems.value = items.map((it: any) => ({
    kind: it?.kind === 'dir' ? 'dir' as const : 'file' as const,
    rel: it?.rel || '', name: it?.name || '', title: it?.title || it?.name || '书签',
    path: it?.path || '', url: it?.url || '', icon: it?.icon || '', order: typeof it?.order === 'number' ? it.order : null,
  }))
}
const isBookmarked = computed(() => !!state.url && bmItems.value.some(b => b.kind === 'file' && b.url === state.url))
const toggleBookmark = async () => {
  if (!state.url) return
  const dir = browserBaseDir()
  if (!dir) { showToast(zh.value ? '请先添加工作区或设置「浏览器保存文件夹」' : 'Add a workspace folder or set a browser save folder', 'err'); return }
  const hit = bmItems.value.find(b => b.kind === 'file' && b.url === state.url)
  if (hit) {
    const r = await invoke('browser-agent:remove-bookmark', { root: dir, path: hit.path }).catch(() => null)
    if (r?.ok) showToast(zh.value ? '已取消收藏' : 'Bookmark removed')
    else showToast(r?.error || (zh.value ? '移除失败' : 'Remove failed'), 'err')
  } else {
    const r = await invoke('browser-agent:save-bookmark', { root: dir, url: state.url, title: state.title || state.url }).catch(() => null)
    if (r?.ok) showToast(zh.value ? `已收藏：${r.path}` : `Saved: ${r.path}`)
    else showToast(r?.error || (zh.value ? '收藏失败' : 'Save failed'), 'err')
  }
  await refreshBookmarks()
}

// ===== 新标签页「收藏夹」快捷入口（文件夹形式：顶层 → 点击进入下一级文件夹/书签） =====
interface HomeBm { kind: 'dir' | 'file'; rel: string; title: string; url: string; host: string; icon: string; path: string }
// 当前所在文件夹的 rel 路径段（[] = 顶层/根）
const homePath = ref<string[]>([])
const relParent = (rel: string) => { const i = rel.lastIndexOf('/'); return i >= 0 ? rel.slice(0, i) : '' }
const currentDirRel = computed(() => homePath.value.join('/'))
// 当前文件夹下的直接子项（顺序与收藏树一致）：文件夹 → 点击进入下一级；书签 → 新标签打开
const homeBookmarks = computed<HomeBm[]>(() => {
  const cur = currentDirRel.value
  const out: HomeBm[] = []
  for (const i of (bmItems.value || [])) {
    const rel = i.rel || ''
    if (relParent(rel) !== cur) continue
    if (i.kind === 'dir') {
      out.push({ kind: 'dir', rel, title: i.name || i.title || '文件夹', url: '', host: '', icon: '', path: i.path || '' })
    } else if (i.kind === 'file' && i.url) {
      let host = ''
      try { host = new URL(i.url).host.replace(/^www\./, '') || '' } catch { host = '' }
      out.push({ kind: 'file', rel, title: i.title || i.name || host || '书签', url: i.url, host, icon: i.icon || '', path: i.path || '' })
    }
  }
  return out
})
const currentDirName = computed(() => {
  const rel = currentDirRel.value
  if (!rel) return ''
  const item = (bmItems.value || []).find(i => i.kind === 'dir' && i.rel === rel)
  return (item && (item.title || item.name)) || homePath.value[homePath.value.length - 1] || ''
})
const homeUp = () => { homePath.value = homePath.value.slice(0, -1); homeBmExpanded.value = false }
// 点击格子：文件夹 → 进入下一级；书签 → 新标签页打开
const homeTileClick = (b: HomeBm) => {
  if (b.kind === 'dir') { homePath.value = b.rel.split('/'); homeBmExpanded.value = false }
  else openBookmark(b)
}
// 目录被删除 / 收藏位置切换后，若当前所在文件夹已不存在 → 回到顶层
watch(() => bmItems.value, () => {
  const rel = currentDirRel.value
  if (rel && !(bmItems.value || []).some(i => i.kind === 'dir' && i.rel === rel)) homePath.value = []
})

// 站点首字母（无则用标题首字符）作为图标字母
const avatarLetter = (b: HomeBm) => {
  const c = (b.host || b.title || '').trim().charAt(0)
  return (c || '★').toUpperCase()
}
const BM_PALETTE = ['#d97757', '#4a90c4', '#56a35f', '#a35fc0', '#c48a3f', '#4fa8a0', '#c46086', '#7a8ab5', '#5b8db8', '#b8724f']
// 按域名哈希取稳定配色
const avatarColor = (host: string) => {
  let h = 0
  for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) >>> 0
  return BM_PALETTE[h % BM_PALETTE.length]
}
// 点击收藏 → 新标签页打开
const openBookmark = (b: HomeBm) => {
  if (b.url) void invoke('browser-agent:add-tab', { url: b.url }).catch(() => {})
}
// 悬浮删除：右上角垃圾桶点击直接删除该收藏（仅书签/文件）
const deleteHomeBm = async (b: HomeBm) => {
  if (b.kind !== 'file' || !b.path) return
  const dir = browserBaseDir()
  if (!dir) { showToast(zh.value ? '未设置收藏位置' : 'No bookmark folder', 'err'); return }
  const r = await invoke('browser-agent:remove-bookmark', { root: dir, path: b.path }).catch(() => null)
  if (r?.ok) {
    showToast(zh.value ? '已删除该收藏' : 'Bookmark removed')
    void refreshBookmarks()
  } else {
    showToast(r?.error || (zh.value ? '删除失败' : 'Delete failed'), 'err')
  }
}
// 悬浮删除文件夹（含内部书签与子目录；带确认；主进程另有“仅书签目录才可整删”安全校验）
const deleteHomeDir = async (b: HomeBm) => {
  if (b.kind !== 'dir' || !b.path) return
  const dir = browserBaseDir()
  if (!dir) return
  try {
    await ElMessageBox.confirm(
      zh.value ? `确定删除文件夹「${b.title}」及其中的全部书签吗？此操作不可恢复。` : `Delete folder "${b.title}" and all its bookmarks? This cannot be undone.`,
      zh.value ? '删除文件夹' : 'Delete folder',
      { confirmButtonText: zh.value ? '删除' : 'Delete', cancelButtonText: zh.value ? '取消' : 'Cancel', type: 'warning' }
    )
  } catch { return }
  const r = await invoke('browser-agent:remove-bookmark-folder', { root: dir, path: b.path }).catch(() => null)
  if (r?.ok) {
    showToast(zh.value ? '已删除该文件夹' : 'Folder removed')
    void refreshBookmarks()
  } else {
    showToast(r?.error || (zh.value ? '删除失败' : 'Delete failed'), 'err')
  }
}
// 悬浮编辑：普通书签（http 等）→ 弹窗改标题/网址；离线整页快照(file:) → 用删除
const isSnapshotBm = (b: HomeBm) => b.kind === 'file' && String(b.url || '').startsWith('file:')
const bmEditVisible = ref(false)
const bmEditSaving = ref(false)
const bmEditPath = ref('')
const bmEditTitle = ref('')
const bmEditUrl = ref('')
const bmEditOrigUrl = ref('')
const bmEditError = ref('')
const editHomeBm = (b: HomeBm) => {
  if (b.kind !== 'file' || !b.path || isSnapshotBm(b)) return
  bmEditPath.value = b.path
  bmEditTitle.value = b.title || ''
  bmEditUrl.value = b.url || ''
  bmEditOrigUrl.value = b.url || ''
  bmEditError.value = ''
  bmEditVisible.value = true
}
const closeEditBm = () => { bmEditVisible.value = false; bmEditError.value = '' }
const saveEditBm = async () => {
  if (bmEditSaving.value) return
  const url = bmEditUrl.value.trim()
  if (!url) { bmEditError.value = zh.value ? '请输入网址' : 'URL is required'; return }
  const title = bmEditTitle.value.trim()
  const dir = browserBaseDir()
  if (!dir) return
  bmEditSaving.value = true
  try {
    const r = await invoke('browser-agent:update-bookmark', { root: dir, path: bmEditPath.value, title, url }).catch(() => null)
    if (r?.ok) {
      closeEditBm()
      showToast(zh.value ? '已保存修改' : 'Bookmark updated')
      void refreshBookmarks()
    } else {
      bmEditError.value = r?.error || (zh.value ? '保存失败' : 'Update failed')
    }
  } finally { bmEditSaving.value = false }
}
// 模态框内删除当前编辑的书签（带确认）
const deleteEditingBm = async () => {
  if (bmEditSaving.value || !bmEditPath.value) return
  const dir = browserBaseDir()
  if (!dir) return
  try {
    await ElMessageBox.confirm(
      zh.value ? '确定删除这个收藏吗？此操作不可恢复。' : 'Delete this bookmark? This cannot be undone.',
      zh.value ? '删除收藏' : 'Delete bookmark',
      { confirmButtonText: zh.value ? '删除' : 'Delete', cancelButtonText: zh.value ? '取消' : 'Cancel', type: 'warning' }
    )
  } catch { return }
  const r = await invoke('browser-agent:remove-bookmark', { root: dir, path: bmEditPath.value }).catch(() => null)
  if (r?.ok) {
    closeEditBm()
    showToast(zh.value ? '已删除该收藏' : 'Bookmark removed')
    void refreshBookmarks()
  } else {
    bmEditError.value = r?.error || (zh.value ? '删除失败' : 'Delete failed')
  }
}
// ===== 右键“设置”入口：书签 → 编辑框（标题/地址/打开/复制/删除）；文件夹 → 文件夹设置框 =====
const openItemCtx = (b: HomeBm) => {
  if (b.kind === 'dir') openFldCtx(b)
  else if (b.kind === 'file' && !isSnapshotBm(b)) editHomeBm(b)
}
// 编辑框内“打开 / 复制地址”（用输入框当前值，空/非法时回退原地址）
const editingTargetUrl = () => {
  const u = bmEditUrl.value.trim()
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u) ? u : bmEditOrigUrl.value
}
const openEditingInTab = () => {
  const u = editingTargetUrl()
  if (u) { closeEditBm(); void invoke('browser-agent:add-tab', { url: u }).catch(() => {}) }
}
const copyEditingUrl = async () => {
  try { await navigator.clipboard.writeText(editingTargetUrl()); showToast(zh.value ? '已复制地址' : 'URL copied') }
  catch { showToast(zh.value ? '复制失败' : 'Copy failed', 'err') }
}
// 文件夹右键设置
const fldCtxVisible = ref(false)
const fldCtxTitle = ref('')
const fldCtxPath = ref('')
const fldCtxRel = ref('')
const fldCtxErr = ref('')
const fldDeleting = ref(false)
const openFldCtx = (b: HomeBm) => {
  fldCtxTitle.value = b.title || ''
  fldCtxPath.value = b.path || ''
  fldCtxRel.value = b.rel || ''
  fldCtxErr.value = ''
  fldCtxVisible.value = true
}
const closeFldCtx = () => { fldCtxVisible.value = false; fldCtxErr.value = '' }
const enterFldCtx = () => {
  if (!fldCtxRel.value) return
  homePath.value = fldCtxRel.value.split('/')
  homeBmExpanded.value = false
  closeFldCtx()
}
const copyFldCtxPath = async () => {
  try { await navigator.clipboard.writeText(fldCtxPath.value); showToast(zh.value ? '已复制路径' : 'Path copied') }
  catch { showToast(zh.value ? '复制失败' : 'Copy failed', 'err') }
}
const delFldCtx = async () => {
  if (fldDeleting.value || !fldCtxPath.value) return
  const dir = browserBaseDir()
  if (!dir) return
  try {
    await ElMessageBox.confirm(
      zh.value ? `确定删除文件夹「${fldCtxTitle.value}」及其中的全部书签吗？此操作不可恢复。` : `Delete folder "${fldCtxTitle.value}" and all its bookmarks? This cannot be undone.`,
      zh.value ? '删除文件夹' : 'Delete folder',
      { confirmButtonText: zh.value ? '删除' : 'Delete', cancelButtonText: zh.value ? '取消' : 'Cancel', type: 'warning' }
    )
  } catch { return }
  fldDeleting.value = true
  try {
    const r = await invoke('browser-agent:remove-bookmark-folder', { root: dir, path: fldCtxPath.value }).catch(() => null)
    if (r?.ok) {
      closeFldCtx()
      showToast(zh.value ? '已删除该文件夹' : 'Folder removed')
      void refreshBookmarks()
    } else {
      fldCtxErr.value = r?.error || (zh.value ? '删除失败' : 'Delete failed')
    }
  } finally { fldDeleting.value = false }
}

// ===== 新标签页收藏图标：内嵌图标(收藏时写入) → 主进程 favicon 缓存（首拉后落盘复用） → 字母回退 =====
const hostFav = reactive<Record<string, string>>({}) // host -> 缓存的 dataURL
const favImgSrc = (b: HomeBm) => b.icon || (b.host && hostFav[b.host]) || ''
const onHomeFavError = (b: HomeBm) => {
  if (b.host && hostFav[b.host]) delete hostFav[b.host] // 坏图回退字母，避免死循环
}
const homeVisible = computed(() => !!(activeTab.value && !state.url))
// 新标签页可见、进入的文件夹或收藏变化时，为“没有内嵌图标”的主机批量拉取 favicon（主进程有内存+磁盘缓存，不会每次联网）
const ensureHomeFavs = async () => {
  const hosts = [...new Set(homeBookmarks.value.filter(b => b.kind === 'file' && !b.icon && b.host).map(b => b.host))].filter(h => !hostFav[h])
  if (!hosts.length) return
  const res = await invoke('browser-agent:favicon-batch', { hosts }).catch(() => null)
  const map = (res && typeof res === 'object' && res.map) ? res.map : {}
  for (const h of Object.keys(map)) { const d = map[h]; if (d) hostFav[h] = d }
}
watch([homeVisible, homePath, homeBookmarks], () => { if (homeVisible.value) void ensureHomeFavs() }, { immediate: true })

// ===== 新标签页书签按可用空间限量展示（窗口过小时搜索框不被挤出；可展开全部） =====
const homeEl = ref<HTMLElement | null>(null)
const bmBoxEl = ref<HTMLElement | null>(null)
const homeW = ref(0)
const homeH = ref(0)
const bmBoxH = ref(0)
const bmW = ref(0)
const homeBmExpanded = ref(false)
// 列数直接读取 CSS 网格实际列数（随窗口与媒体查询变化），保证与 auto-fill 一致、不会多算而换行
const homeCols = ref(1)
const fallbackCols = () => Math.max(1, Math.floor(((bmW.value || homeW.value || 600) + 8) / 112))
const measureGridCols = () => {
  const grid = bmBoxEl.value?.querySelector<HTMLElement>('.ba-home-bm-grid')
  if (!grid) { homeCols.value = fallbackCols(); return }
  const tpl = getComputedStyle(grid).gridTemplateColumns || ''
  if (!tpl || tpl === 'none') { homeCols.value = fallbackCols(); return }
  const cols = tpl.split(' ').filter(s => s.trim()).length
  if (cols > 0) homeCols.value = cols
}
const homeColumns = computed(() => homeCols.value)
// 窗口较小时只显示一行（按整页高度判定），第 N+1 个收进「展开全部」
const homeSmall = computed(() => {
  const h = homeH.value || (typeof window !== 'undefined' ? window.innerHeight : 0) || 800
  return h < 560
})
const homeMaxRows = computed(() => {
  if (homeSmall.value) return 1
  const h = homeH.value || (typeof window !== 'undefined' ? Math.max(0, window.innerHeight - 160) : 0) || 400
  // 用整页高度估可用行数（书签区会收缩为内容高度，clientHeight 不代表可用空间）
  const avail = Math.max(bmBoxH.value || 0, Math.max(0, h - 150))
  return Math.max(1, Math.min(8, Math.floor(avail / 112))) // 每行约 112px；最多 8 行
})
const homeBmLimit = computed(() => homeColumns.value * homeMaxRows.value)
const moreHomeBmCount = computed(() => Math.max(0, homeBookmarks.value.length - homeBmLimit.value))
const visibleHomeBookmarks = computed(() => {
  const all = homeBookmarks.value
  if (homeBmExpanded.value || homeBmLimit.value <= 0) return all
  return all.slice(0, homeBmLimit.value)
})
// 测量新标签页容器尺寸（ResizeObserver 随窗口缩放自动更新）
const measureHome = () => {
  const home = homeEl.value
  if (home) { homeW.value = home.clientWidth; homeH.value = home.clientHeight }
  const bm = bmBoxEl.value
  if (bm) { bmW.value = bm.clientWidth; bmBoxH.value = bm.clientHeight }
  measureGridCols()
}
let homeObs: ResizeObserver | null = null
watch(homeVisible, async (v) => {
  if (v) {
    // 每次切到新标签页都回到收藏夹顶层并刷新：避免停在某个子文件夹里，
    // 导致刚收藏的“顶层页面”在新标签页下方看不到（像没识别到）。
    homePath.value = []
    homeBmExpanded.value = false
    void refreshBookmarks()
    await nextTick()
    measureHome()
    if (!homeObs && homeEl.value) {
      homeObs = new ResizeObserver(() => measureHome())
      homeObs.observe(homeEl.value)
    }
  } else {
    if (homeObs) { homeObs.disconnect(); homeObs = null }
  }
}, { immediate: true })
// 收藏增删后（grid 出现/变化）重新测量列数
watch(() => bmItems.value.length, async () => {
  if (homeVisible.value) { await nextTick(); measureHome() }
})

// 保存当前页（整体离线 HTML）到浏览器落盘目录；无可用目录时由主进程弹保存对话框
const savePage = async (mode: 'link' | 'full') => {
  if (!state.url) return
  const dir = browserBaseDir()
  const res = await invoke('browser-agent:save-page', { mode, root: dir || undefined }).catch(() => null)
  if (res?.ok) {
    showToast(zh.value ? `已保存：${res.path}` : `Saved: ${res.path}`)
    // 保存结果落盘到收藏目录后即时刷新，让收藏夹/新标签页显示这个“已保存页面”
    void refreshBookmarks()
  } else {
    showToast(res?.error || (zh.value ? '保存失败' : 'Save failed'), 'err')
  }
}
const openDevtools = async () => { await invoke('browser-agent:devtools').catch(() => {}) }

// ===== 收藏夹自动刷新：停靠栏「收藏夹」打开期间定时拉取，文件夹内文件变化时及时更新 =====
let bmAutoTimer: ReturnType<typeof setInterval> | null = null
const syncBmAutoTimer = () => {
  const active = railOpen.value && railView.value === 'bookmarks'
  if (active && !bmAutoTimer) {
    bmAutoTimer = setInterval(() => { void refreshBookmarks() }, 1500)
  } else if (!active && bmAutoTimer) {
    clearInterval(bmAutoTimer)
    bmAutoTimer = null
  }
}
watch([railOpen, railView], () => syncBmAutoTimer(), { immediate: true })
// 书签保存位置变化（本窗口或主窗口设置改动）→ 立即刷新一次
watch(() => (store.UI?.browserSaveDir || '').trim(), () => { void refreshBookmarks() })

onMounted(async () => {
  window.ipcRenderer?.on('browser-agent:event', onEvent)
  window.ipcRenderer?.on('theme-changed', onThemeChanged)
  window.ipcRenderer?.on('browser-agent:toast', onToastEvent)
  window.addEventListener('resize', onWinResize)
  measureCompact()
  sendBrowserTheme()
  // 独立窗口启动即同步可能已配置好的浏览器偏好，并确保右侧停靠栏为收起初始态
  syncBrowserPrefs()
  void invoke('browser-agent:set-rail', { open: false }).catch(() => {})
  void refreshBookmarks()
  try {
    const res = await invoke('browser-agent:state')
    if (res?.ok) applyState(res.data)
  } catch { /* 忽略 */ }
})
onBeforeUnmount(() => {
  window.ipcRenderer?.off('browser-agent:event', onEvent)
  window.ipcRenderer?.off('theme-changed', onThemeChanged)
  window.ipcRenderer?.off('browser-agent:toast', onToastEvent)
  window.removeEventListener('resize', onWinResize)
  if (bmAutoTimer) { clearInterval(bmAutoTimer); bmAutoTimer = null }
})
</script>

<style scoped>
.browser-agent-shell {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--backgroundColor, #ffffff);
  color: var(--fontColor);
  overflow: hidden;
}
/* ====== ① 标签栏：36px，与主进程 TAB_BAR_H 一致 ====== */
.ba-tabbar {
  height: 36px;
  flex: 0 0 36px;
  display: flex;
  align-items: stretch;
  background: color-mix(in srgb, var(--menuColor) 85%, var(--backgroundColor));
  border-bottom: 1px solid var(--borderColor);
  -webkit-app-region: drag;
  user-select: none;
  min-width: 0;
}
.ba-tab {
  flex: 0 1 180px;
  min-width: 0;
  max-width: 220px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 0 10px;
  cursor: pointer;
  color: var(--fontColor);
  opacity: .75;
  border-right: 1px solid color-mix(in srgb, var(--borderColor) 55%, transparent);
  background: transparent;
  -webkit-app-region: no-drag;
  transition: background .12s, opacity .12s;
}
.ba-tab:hover { background: color-mix(in srgb, var(--fontColor) 5%, transparent); opacity: 1; }
.ba-tab.active {
  opacity: 1;
  background: var(--backgroundColor);
  box-shadow: inset 0 -2px 0 var(--fontActiveColor);
}
/* 标签拖拽排序：抓取光标 + 插入位置指示线 */
.ba-tab { cursor: grab; }
.ba-tab:active { cursor: grabbing; }
.ba-tab-drop-before { box-shadow: inset 3px 0 0 0 var(--fontActiveColor); }
.ba-tab-drop-after { box-shadow: inset -3px 0 0 0 var(--fontActiveColor); }
.ba-tab-favicon { flex-shrink: 0; font-size: 11px; color: var(--fontActiveColor); }
.ba-tab-favicon-img {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  border-radius: 3px;
  object-fit: contain;
  background: color-mix(in srgb, var(--backgroundColor) 70%, transparent);
}
.ba-tab-agent { flex-shrink: 0; font-size: 10px; color: var(--fontActiveColor); margin-right: 2px; }
.ba-tab-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.ba-tab-close {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  font-size: 10px;
  color: var(--fontColor);
  opacity: 0;
  transition: opacity .12s, background .12s;
}
.ba-tab:hover .ba-tab-close { opacity: .7; }
.ba-tab-close:hover { opacity: 1 !important; background: color-mix(in srgb, var(--fontColor) 12%, transparent); }
.ba-tab-add {
  flex-shrink: 0;
  width: 30px;
  border: none;
  background: transparent;
  color: var(--fontColor);
  cursor: pointer;
  font-size: 12px;
  opacity: .75;
  -webkit-app-region: no-drag;
}
.ba-tab-add:hover { opacity: 1; background: color-mix(in srgb, var(--fontColor) 8%, transparent); }
.ba-flex { flex: 1; }
/* 自绘窗口控制按钮 */
.ba-win-btns {
  display: flex;
  align-items: stretch;
  align-self: stretch;
  -webkit-app-region: no-drag;
}
.ba-win-btn {
  width: 40px;
  height: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--fontColor);
  cursor: pointer;
  font-size: 11px;
  transition: background .12s;
}
.ba-win-btn:hover { background: color-mix(in srgb, var(--fontColor) 12%, transparent); }
.ba-win-btn.ba-win-close:hover { background: #e81123; color: #fff; }

/* ====== ② 地址 / 导航栏：42px，与主进程 NAV_BAR_H 一致 ====== */
.ba-navbar {
  height: 42px;
  flex: 0 0 42px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  background: var(--menuColor);
  border-bottom: 1px solid var(--borderColor);
  -webkit-app-region: drag;
  user-select: none;
  min-width: 0;
}
.ba-btn {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--fontColor);
  cursor: pointer;
  font-size: 12px;
  transition: all .12s;
  -webkit-app-region: no-drag;
}
.ba-btn:hover { background: color-mix(in srgb, var(--fontColor) 8%, transparent); }
.ba-btn:disabled { opacity: .35; cursor: default; }
/* 地址栏 */
.ba-addr {
  flex: 1;
  min-width: 0;
  height: 28px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border: 1px solid var(--borderColor);
  border-radius: 14px;
  background: var(--backgroundColor);
  -webkit-app-region: no-drag;
}
.ba-addr:focus-within { border-color: var(--fontActiveColor); }
.ba-addr-icon { flex-shrink: 0; font-size: 11px; color: var(--fontColor); opacity: .6; }
.ba-addr-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--fontColor);
  font-size: 12px;
}
.ba-addr-loading { flex-shrink: 0; font-size: 11px; color: var(--fontActiveColor); }
/* 设置按钮（顶部常驻）：开启时强调色高亮；AI 忙碌时右上角小红点提示（侧栏内有完整状态行） */
.ba-settings-btn { position: relative; }
.ba-settings-btn.on {
  background: color-mix(in srgb, var(--fontActiveColor) 14%, transparent);
}
.ba-settings-btn.on i { color: var(--fontActiveColor); }
.ba-settings-btn:hover i { color: var(--fontActiveColor); }
.ba-settings-btn .ba-settings-busy {
  position: absolute;
  top: 2px;
  right: 2px;
  font-size: 7px;
  color: #e81123;
  filter: drop-shadow(0 0 2px rgba(232, 17, 35, .6));
}
/* 收藏夹按钮（顶部常驻）：开启时强调色高亮 */
.ba-fav-btn { position: relative; }
.ba-fav-btn.on {
  background: color-mix(in srgb, var(--fontActiveColor) 14%, transparent);
}
.ba-fav-btn.on i { color: var(--fontActiveColor); }
.ba-fav-btn:hover i { color: var(--fontActiveColor); }

/* ====== ③ 内容区：左侧网页占位 + 右侧「设置」停靠栏（DOM 侧栏与原生网页并排，互不遮挡） ====== */
.ba-body {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: stretch;
  min-width: 0;
}
.ba-main {
  flex: 1;
  min-width: 0;
  position: relative;
  display: flex;
  flex-direction: column;
  background: var(--backgroundColor);
}
.ba-page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
}
/* 右侧停靠栏：收起时宽 0；展开时 320px（须与脚本 SIDE_RAIL_W 一致，主进程网页让出同宽） */
.ba-rail {
  flex: 0 0 0;
  width: 0;
  overflow: hidden;
  background: var(--menuColor);
  border-left: 1px solid var(--borderColor);
  /* 不用宽度过渡：原生网页视图由主进程瞬时让位，DOM 侧栏需同步展开避免闪缝 */
}
.ba-rail.open {
  flex-basis: 320px;
  width: 320px;
}
.ba-rail-inner {
  width: 320px;
  height: 100%;
  display: flex;
  flex-direction: column;
}
.ba-rail-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 6px;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--fontColor) 25%, transparent) transparent;
}
/* 侧栏滚动区细滚动条（随主题；工具栏 ⚙ 下方的内容区即此滚动体） */
.ba-rail-body::-webkit-scrollbar { width: 8px; }
.ba-rail-body::-webkit-scrollbar-track { background: transparent; }
.ba-rail-body::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--fontColor) 18%, transparent);
  border-radius: 8px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
.ba-rail-body::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--fontActiveColor) 55%, transparent);
  border-radius: 8px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
/* 侧栏内容区样式已随模块拆分迁移至 BrowserRailSettings.vue / BrowserBookmarksPanel.vue，此处仅保留滚动容器 */
.ba-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: var(--fontColor);
  opacity: .6;
  text-align: center;
  max-width: 560px;
  padding: 16px;
}
.ba-empty p { margin: 0; font-size: 14px; }
.ba-empty-sub { font-size: 12px; line-height: 1.7; }
.ba-empty { margin: auto; }
.ba-mini-status {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 80%;
  overflow: hidden;
  color: var(--fontColor);
  opacity: .55;
  font-size: 12px;
}
.ba-mini-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 轻提示（位于标签/地址栏区域，网页原生视图无法被覆盖） */
.ba-toast {
  position: fixed;
  top: 42px;
  left: 50%;
  transform: translateX(-50%);
  max-width: 70%;
  padding: 4px 12px;
  border: 1px solid var(--borderColor);
  border-radius: 12px;
  background: var(--menuColor);
  color: var(--fontColor);
  font-size: 12px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, .18);
  pointer-events: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  z-index: 100;
}
.ba-toast.err { border-color: #e81123; color: #e81123; }
.ba-toast-fade-enter-active, .ba-toast-fade-leave-active { transition: opacity .18s; }
.ba-toast-fade-enter-from, .ba-toast-fade-leave-to { opacity: 0; }

/* ====== 收藏按钮 ====== */
.ba-star-btn.on i { color: #f0b429; }
.ba-star-btn:hover i { color: #f0b429; }

/* ====== 新标签搜索首页（默认 Bing）：搜索框 + 书签整体垂直居中 ====== */
.ba-home {
  flex: 1;
  min-height: 0;
  overflow: hidden; /* 滚动交给书签区 */
  padding: 18px 28px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center; /* 大窗/小窗都垂直居中 */
}
.ba-search-home {
  flex: 0 0 auto; /* 固定顶部，不被下方书签挤走 */
  width: 100%;
  max-width: 620px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
}
.ba-search-box {
  width: 100%;
  height: 44px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
  border: 1px solid var(--borderColor);
  border-radius: 22px;
  background: var(--menuColor);
  transition: border-color .15s, box-shadow .15s;
}
.ba-search-box:focus-within {
  border-color: var(--fontActiveColor);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--fontActiveColor) 16%, transparent);
}
.ba-search-ic { flex-shrink: 0; font-size: 13px; color: var(--fontColor); opacity: .5; }
.ba-search-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: none;
  outline: none;
  background: transparent;
  color: var(--fontColor);
  font-size: 14px;
}
/* 收藏夹 grid 快捷入口：随内容收缩，超高才在内部滚动（整体垂直居中不被挤出） */
.ba-home-bookmarks {
  flex: 0 1 auto;
  min-height: 0;
  width: 100%;
  max-width: calc(97%);
  margin-top: 8px;
  max-height: calc(100% - 80px);
  overflow-y: auto;
  overflow-x: hidden;
}
.ba-home-bm-empty {
  font-size: 12px;
  color: var(--fontColor);
  opacity: .5;
  text-align: center;
  padding: 14px 0;
}
.ba-home-bm-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: 8px;
}
.ba-home-bm-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 12px 6px 10px;
  border: 1px solid transparent;
  border-radius: 10px;
  cursor: pointer;
  color: var(--fontColor);
  transition: background .12s, border-color .12s;
  min-width: 0;
}
.ba-home-bm-item:hover {
  background: color-mix(in srgb, var(--fontColor) 5%, transparent);
  border-color: var(--borderColor);
}
.ba-home-bm-icon {
  position: relative;
  width: 46px;
  height: 46px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.ba-home-bm-img {
  width: 46px;
  height: 46px;
  box-sizing: border-box;
  border-radius: 12px;
  padding: 4px;
  background: color-mix(in srgb, var(--menuColor) 80%, #fff);
  object-fit: contain;
}
.ba-home-bm-avatar {
  width: 46px;
  height: 46px;
  border-radius: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 19px;
  font-weight: 600;
  color: #fff;
  user-select: none;
  flex-shrink: 0;
}
.ba-home-bm-name {
  font-size: 11px;
  text-align: center;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 悬浮右上角删除书签 */
.ba-home-bm-item { position: relative; }
.ba-home-bm-del {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 18px;
  height: 18px;
  display: none;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(40, 40, 40, .55);
  color: #fff;
  font-size: 10px;
  cursor: pointer;
  opacity: .9;
  z-index: 3;
  transition: background .12s;
}
.ba-home-bm-item:hover .ba-home-bm-del { display: inline-flex; }
.ba-home-bm-del:hover { background: #e81123; color: #fff; }
.ba-home-bm-del.edit:hover { background: #1971c2; color: #fff; }

/* 编辑书签模态框 */
.ba-bm-edit-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, .45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1200;
}
.ba-bm-edit-modal {
  width: 420px;
  max-width: 92vw;
  box-sizing: border-box;
  background: var(--backgroundColor, #fff);
  border: 1px solid var(--borderColor);
  border-radius: 10px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, .22);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ba-bm-edit-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  color: var(--fontColor);
  gap: 8px;
  padding-bottom: 5px;
  border-bottom: 1px solid var(--borderColor);
}
.ba-bm-edit-x {
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--fontColor);
  cursor: pointer;
  font-size: 14px;
  border-radius: 4px;
}
.ba-bm-edit-x:hover { background: color-mix(in srgb, var(--fontColor) 10%, transparent); }
.ba-bm-edit-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ba-bm-edit-row label {
  flex: 0 0 42px;
  font-size: 12px;
  color: var(--fontColor);
  opacity: .8;
  padding: 0px
}
.ba-bm-edit-input {
  flex: 1;
  min-width: 0;
  height: 28px;
  box-sizing: border-box;
  padding: 0 8px;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  background: var(--menuColor);
  color: var(--fontColor);
  font-size: 12px;
  outline: none;
  margin: 0px;
}
.ba-bm-edit-input:focus { border-color: var(--fontActiveColor); }
.ba-bm-edit-err { font-size: 11px; color: #e81123; }
.ba-bm-edit-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.ba-bm-edit-btn {
  min-width: 56px;
  height: 28px;
  box-sizing: border-box;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 12px;
  cursor: pointer;
  padding: 0 12px;
}
.ba-bm-edit-btn:hover { border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
.ba-bm-edit-btn.primary { background: #1971c2; color: #fff; border-color: #1971c2; }
.ba-bm-edit-btn.primary:hover { opacity: .9; color: #fff; }
.ba-bm-edit-btn.danger { color: #e81123; }
.ba-bm-edit-btn.danger:hover { border-color: #e81123; color: #e81123; background: color-mix(in srgb, #e81123 8%, transparent); }
.ba-bm-edit-btn:disabled { opacity: .5; cursor: default; }
.ba-bm-fld-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--fontColor);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 展开/收起更多收藏 */
.ba-home-bm-more {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin: 6px auto 2px;
  padding: 4px 14px;
  border: 1px solid var(--borderColor);
  border-radius: 14px;
  font-size: 11px;
  color: var(--fontColor);
  opacity: .7;
  cursor: pointer;
  width: max-content;
  transition: all .15s;
}
.ba-home-bm-more:hover {
  color: var(--fontActiveColor);
  border-color: var(--fontActiveColor);
  opacity: 1;
  background: color-mix(in srgb, var(--fontActiveColor) 8%, transparent);
}
/* 文件夹内导航（返回上一级 / 当前文件夹名） */
.ba-home-bm-nav {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  min-width: 0;
}
.ba-home-bm-back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  border: 1px solid var(--borderColor);
  border-radius: 13px;
  font-size: 11px;
  color: var(--fontActiveColor);
  cursor: pointer;
  user-select: none;
  flex-shrink: 0;
  transition: all .15s;
}
.ba-home-bm-back:hover { background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent); border-color: var(--fontActiveColor); }
.ba-home-bm-crumb {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--fontColor);
  opacity: .85;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ba-home-bm-folder {
  font-size: 30px;
  color: #f0b429;
  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .18));
}
.ba-star-btn.on { color: #f0b429; }

/* ====== 自适应布局：窗口变窄时标签 / 导航 / 新标签搜索框缩小；小窗书签去图标只显名称 ====== */
@media (max-width: 900px) {
  .ba-tab { flex: 0 1 132px; padding: 0 5px 0 7px; font-size: 11px; }
  .ba-tab-close { width: 13px; height: 13px; }
  .ba-tab-favicon { font-size: 10px; }
  .ba-tab-favicon-img { width: 11px; height: 11px; }
  .ba-navbar { gap: 3px; padding: 0 6px; }
}
@media (max-width: 760px) {
  .ba-tab { flex-basis: 106px; max-width: 150px; font-size: 10px; }
  .ba-btn { width: 25px; height: 25px; font-size: 11px; }
  .ba-addr { height: 25px; padding: 0 8px; }
  .ba-addr-input { font-size: 11px; }
  .ba-home { padding: 12px 12px 18px; }
  .ba-search-home { max-width: 480px; gap: 12px; }
  .ba-search-box { height: 30px; border-radius: 15px; padding: 0 12px; width:calc(100% - 80px) }
  .ba-search-input { font-size: 12px; }
  .ba-search-ic { font-size: 11px; }
  /* 小窗：书签去图标 → 纯名称 grid（更紧凑，更多可排一行） */
  .ba-home-bm-icon { display: none; }
  .ba-home-bm-grid { grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); gap: 6px; }
  /* 名称标签用背景框框住（胶囊/标签感） */
  .ba-home-bm-item {
    padding: 6px 10px;
    border: 1px solid var(--borderColor);
    border-radius: 14px;
    background: color-mix(in srgb, var(--menuColor) 80%, var(--backgroundColor));
    gap: 0;
  }
  .ba-home-bm-item:hover {
    border-color: var(--fontActiveColor);
    color: var(--fontActiveColor);
    background: color-mix(in srgb, var(--fontActiveColor) 10%, var(--menuColor));
  }
  .ba-home-bm-name { font-size: 11px; }
}
@media (max-width: 520px) {
  .ba-tab { flex-basis: 84px; }
  .ba-search-home { max-width: 360px; }
  .ba-search-box { height: 28px; border-radius: 14px; }
  .ba-home-bm-grid { grid-template-columns: repeat(auto-fill, minmax(68px, 1fr)); }
  .ba-home-bm-item { padding: 5px 6px; }
  .ba-home-bm-name { font-size: 10px; }
}
</style>
