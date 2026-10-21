<!-- src/components/browser/BrowserAgentShell.vue
     浏览器 Agent 独立窗口（M0/M1 + 多标签）——无边框 Vue 壳（浏览器模块，独立于 knowFile）。
     布局：顶部多标签栏（36px）+ 其下地址/导航栏（42px）；
           下方内容区左侧为网页（主进程按标签创建的 WebContentsView 承载），
           右侧可展开「设置」停靠栏（收起时网页占满整宽；展开时主进程让出右栏宽度，DOM 侧栏与原生网页并排不遮挡）。
     壳通过 browser-agent:* IPC 与主进程 browser-agent.ts 交互（标签增删/切换、导航、状态、停靠栏）。 -->
<template>
  <div ref="shellRef" class="browser-agent-shell" :class="{ embedded: !!embedded, 'embedded-hidden': !!embedded && !paneVisible }">
    <!-- ====== ① 标签栏（36px，与主进程 TAB_BAR_H 一致；无边框窗口拖动区） ====== -->
    <div class="ba-tabbar">
      <div
        v-for="t in state.tabs"
        :key="t.id"
        class="ba-tab"
        draggable="true"
        :class="{
          active: t.id === state.activeTabId && !settingsTabActive,
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
      <!-- 设置标签页（内部页，不在主进程标签集合里）：像 ego-lite 一样以标签形式打开 -->
      <div v-if="settingsTabOpen" class="ba-tab ba-tab-settings" :class="{ active: settingsTabActive }" :title="settingsTabActive ? (zh ? '设置（正在显示）' : 'Settings (active)') : (zh ? '切换到设置标签' : 'Switch to settings tab')" @click="toggleSettingsTab">
        <i class="fa ba-tab-favicon fa-cog"></i>
        <span class="ba-tab-title">{{ zh ? '设置' : 'Settings' }}</span>
        <i class="fa fa-times ba-tab-close" :title="zh ? '关闭设置' : 'Close settings'" @click.stop="closeSettingsTab"></i>
      </div>
      <button class="ba-tab-add" :title="zh ? '新建标签页' : 'New tab'" @click="addTab()">
        <i class="fa fa-plus"></i>
      </button>
      <div class="ba-flex"></div>

      <!-- 自绘窗口控制（无边框，仿主应用风格）；停靠在主页右侧栏时没有窗口，整块隐藏 -->
      <div v-if="!embedded" class="ba-win-btns">
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

      <!-- 地址栏（搜索栏已并入地址栏：网址直接打开，关键词用所选引擎搜索） -->
      <div class="ba-addr" :class="{ searching: addrIsSearch }" :title="addrTitle">
        <i class="fa ba-addr-icon" :class="addrIsSearch ? 'fa-search' : (isSecure ? 'fa-lock' : 'fa-globe')"></i>
        <input
          ref="addrInput"
          v-model="urlInput"
          class="ba-addr-input"
          spellcheck="false"
          :placeholder="addrPlaceholder"
          @keydown.enter="navigate()"
        />
        <span v-if="addrIsSearch" class="ba-addr-badge">{{ engineLabel }}</span>
        <span v-if="state.loading" class="ba-addr-loading"><i class="fa fa-spinner fa-spin"></i></span>
      </div>

      <!-- AI 控制：暂停 / 接管（仅在最近有 AI 操作时出现） -->
      <button v-if="state.agentOwner" class="ba-btn" :class="{ on: state.agentPaused }"
        :title="state.agentPaused ? (zh ? '继续 AI 操作' : 'Resume AI') : (zh ? '暂停 AI 操作（不动你正在看的页面）' : 'Pause AI')"
        @click="toggleAgentPaused">
        <i class="fa" :class="state.agentPaused ? 'fa-play' : 'fa-pause'"></i>
      </button>
      <button v-if="state.agentOwner && !state.agentPaused" class="ba-btn"
        :title="zh ? '接管：把 AI 标签转为普通标签并暂停该会话' : 'Take over: turn AI tabs into normal tabs and pause the session'"
        @click="handoffAgent">
        <i class="fa fa-unlock"></i>
      </button>

      <!-- 顶部右侧：⭐ 收藏当前页 / 🏷️ 收藏夹（打开侧栏树状管理）/ ⚙ 设置。其余页面操作折叠进侧栏 -->
      <button class="ba-btn ba-star-btn" :class="{ on: isBookmarked }" :disabled="!state.url"
        :title="isBookmarked ? (zh ? '取消收藏（书签）' : 'Remove bookmark') : (zh ? '收藏当前页（书签）' : 'Bookmark current page') "
        @click="toggleBookmark">
        <i class="fa" :class="isBookmarked ? 'fa-star' : 'fa-star-o'"></i>
      </button>
      <button v-if="showBookmarksIcon" class="ba-btn ba-fav-btn" :class="{ on: railOpen && railView === 'bookmarks' }"
        :title="railOpen && railView === 'bookmarks' ? (zh ? '关闭收藏夹' : 'Close bookmarks') : (zh ? '收藏夹（树状管理，可拖拽整理）' : 'Bookmarks (tree manager, drag to organize)') "
        @click="toggleBookmarks">
        <i class="fa fa-tag"></i>
      </button>
      <button v-if="showHistoryIcon" class="ba-btn" :class="{ on: railOpen && railView === 'history' }"
        :title="railOpen && railView === 'history' ? (zh ? '关闭历史' : 'Close history') : (zh ? '历史与最近关闭' : 'History & recently closed')"
        @click="toggleHistory">
        <i class="fa fa-history"></i>
      </button>
      <button v-if="showDownloadsIcon" class="ba-btn ba-dl-btn" :class="{ on: railOpen && railView === 'downloads' }"
        :title="(railOpen && railView === 'downloads' ? (zh ? '关闭下载列表' : 'Close downloads') : (zh ? '下载列表' : 'Downloads')) + (downloadingCount > 0 ? (zh ? `（${downloadingCount} 个下载进行中）` : ` (${downloadingCount} downloading)`) : '')"
        @click="toggleDownloads">
        <i class="fa fa-download"></i>
        <span v-if="downloadingCount > 0" class="ba-dl-dot" :aria-label="zh ? '有下载进行中' : 'Download in progress'"></span>
      </button>
      <button class="ba-btn ba-settings-btn" :class="{ on: settingsTabActive }"
        :title="settingsTabActive ? (zh ? '设置（正在显示；点标签 × 关闭）' : 'Settings (active; close with ×)') : (settingsTabOpen ? (zh ? '切换到设置标签' : 'Switch to settings tab') : (zh ? '设置（打开独立标签页）' : 'Settings (open as a tab)'))"
        @click="toggleSettingsTab">
        <i class="fa fa-cog"></i>
        <i v-if="!settingsTabActive && agentBusyDot" class="fa fa-circle ba-settings-busy" :title="zh ? 'AI 正在此标签操作…' : 'AI is operating this tab…'"></i>
      </button>
    </div>

    <!-- ====== ③ 内容区：左侧网页/页面占位 + 右侧「设置」停靠栏（DOM）。原生网页视图仅覆盖左侧；展开停靠栏时主进程让出右栏宽度 → 二者并排互不遮挡 ====== -->
    <div class="ba-body">
      <!-- 左侧：页面内容（新标签搜索首页等 DOM 在原生视图隐藏/空白时露出；有 URL 时由原生视图承载） -->
      <div ref="mainRef" class="ba-main">
        <div class="ba-page">
          <!-- 设置标签页（内部页）：盖住网页区，隐藏原生视图（主进程 set-overlay） -->
          <BrowserSettingsPage v-if="settingsTabActive" />
          <!-- 新标签页（收藏夹网格）：整页就是收藏夹 grid——全部平铺、不折叠；搜索已并入顶部地址栏，页内不再放任何搜索/提示条 -->
          <div v-else-if="activeTab && !state.url && newTabIsBookmarks" class="ba-home">
            <!-- 收藏夹快捷入口：文件夹形式（顶层 → 点击进入下一级文件夹/书签）；全部展示，超高时本区滚动
                 头部仅保留「返回上一级 / 当前文件夹」；显示方式由 Ctrl+滚轮决定（缩小到下限即列表，往上滚回网格） -->
            <div class="ba-home-bookmarks scoll" @wheel="onHomeWheel">
              <div v-if="homePath.length" class="ba-home-bm-nav">
                <span class="ba-home-bm-back" @click="homeUp"><i class="fa fa-arrow-left"></i>{{ zh ? ' 返回' : ' Back' }}</span>
                <span class="ba-home-bm-crumb" :title="currentDirRel"><i class="fa fa-folder-open-o"></i>{{ currentDirName }}</span>
              </div>
              <!-- 空收藏：不再用整段提示，改成一个列表/网格里的占位项 -->
              <div v-if="!homeBookmarks.length" class="ba-home-bm-placeholder" :class="{ list: homeViewMode === 'list' }">
                <i class="fa fa-star-o"></i>
                <span>{{ homePath.length ? (zh ? '该文件夹为空' : 'This folder is empty') : (zh ? '暂无收藏' : 'No bookmarks') }}</span>
              </div>
              <div v-else-if="homeViewMode === 'list'" class="ba-home-bm-list">
                <div
                  v-for="b in homeBookmarks"
                  :key="b.rel"
                  class="ba-home-bm-row"
                  :class="{ dir: b.kind === 'dir' }"
                  :title="b.kind === 'dir' ? `${b.title}（${zh ? '文件夹，点击进入' : 'folder, click to open'}）` : `${b.title}\n${b.url}`"
                  @click="homeTileClick(b)"
                  @contextmenu.prevent.stop="openItemCtx(b)"
                >
                  <span class="ba-home-row-icon ba-home-iconbox" :style="iconBoxStyle">
                    <i v-if="b.kind === 'dir'" class="fa fa-folder ba-home-bm-folder"></i>
                    <img
                      v-else-if="favImgSrc(b)"
                      class="ba-home-bm-img"
                      :src="favImgSrc(b)"
                      draggable="false"
                      alt=""
                      @error="onHomeFavError(b)"
                    />
                    <span v-else class="ba-home-bm-avatar" :style="{ color: avatarColor(b.host, b.title) }">{{ avatarLetter(b) }}</span>
                  </span>
                  <span class="ba-home-row-name" :title="b.title">{{ b.title }}</span>
                  <span class="ba-home-row-host">{{ b.kind === 'dir' ? (zh ? '文件夹' : 'Folder') : b.host }}</span>
                  <!-- 列表行右侧：文件夹 → 删除；普通书签 → 编辑；离线整页快照 → 删除 -->
                  <span class="ba-home-row-actions">
                    <template v-if="b.kind === 'dir'">
                      <button
                        class="ba-home-row-btn"
                        :title="zh ? '删除该文件夹（含内部书签）' : 'Delete this folder (with its bookmarks)'"
                        @click.stop="deleteHomeDir(b)"
                      ><i class="fa fa-trash-o"></i></button>
                    </template>
                    <template v-else-if="b.kind === 'file'">
                      <button
                        v-if="!isSnapshotBm(b)"
                        class="ba-home-row-btn edit"
                        :title="zh ? '编辑标题/地址' : 'Edit title / URL'"
                        @click.stop="editHomeBm(b)"
                      ><i class="fa fa-pencil"></i></button>
                      <button
                        v-else
                        class="ba-home-row-btn"
                        :title="zh ? '删除该离线快照' : 'Delete this snapshot'"
                        @click.stop="deleteHomeBm(b)"
                      ><i class="fa fa-trash-o"></i></button>
                    </template>
                  </span>
                </div>
              </div>
              <div v-else class="ba-home-bm-grid" :style="gridStyle">
                <div
                  v-for="b in homeBookmarks"
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
                  <span v-if="b.kind === 'dir'" class="ba-home-bm-icon ba-home-iconbox" :style="iconBoxStyle">
                    <i class="fa fa-folder ba-home-bm-folder"></i>
                  </span>
                  <!-- 普通书签：有真实 favicon 显示图标；没有则用 **标题首字** 居中占位（代替图标），完整标题仍在图标下方 -->
                  <span v-else class="ba-home-bm-icon ba-home-iconbox" :style="iconBoxStyle">
                    <img
                      v-if="favImgSrc(b)"
                      class="ba-home-bm-img"
                      :src="favImgSrc(b)"
                      draggable="false"
                      alt=""
                      @error="onHomeFavError(b)"
                    />
                    <span v-else class="ba-home-bm-avatar" :style="{ color: avatarColor(b.host, b.title) }">{{ avatarLetter(b) }}</span>
                  </span>
                  <span class="ba-home-bm-name" :style="{ fontSize: fileNameFontSize }" :title="b.title">{{ b.title }}</span>
                </div>
              </div>
            </div>
          </div>
          <!-- 新标签页（空白页）：设置里选「空白页」时什么都不显示（搜索用顶部地址栏） -->
          <div v-else-if="activeTab && !state.url" class="ba-home ba-home-blank"></div>
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

      <!-- 右侧停靠栏（收藏夹 / 下载 / 历史；设置已改为独立标签页） -->
      <aside class="ba-rail" :class="{ open: railOpen }">
        <!-- 收起时（宽 0）连同 inert 禁用内部控件聚焦，避免键盘 Tab 落入隐藏栏 -->
        <div class="ba-rail-inner" :inert="!railOpen">
          <!-- 无头部/关闭按钮（工具栏图标即可开/关侧栏）：内容区直接从顶部开始滚动 -->
          <div class="ba-rail-body">
            <!-- 收藏夹面板（独立模块：BrowserBookmarksPanel） -->
            <template v-if="railView === 'bookmarks'">
              <BrowserBookmarksPanel :dir="browserBaseDir()" :items="bmItems" :active="railOpen && railView === 'bookmarks'" @changed="refreshBookmarks" />
            </template>
            <!-- 下载 / 历史（P1：从顶部工具栏图标进入，面板复用同一停靠栏） -->
            <template v-else-if="railView === 'downloads'">
              <BrowserExtrasPanel mode="downloads" :active="railOpen && railView === 'downloads'" :on-open-tab="openTabByUrl" />
            </template>
            <template v-else-if="railView === 'history'">
              <BrowserExtrasPanel mode="history" :active="railOpen && railView === 'history'" :on-open-tab="openTabByUrl" />
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
import BrowserExtrasPanel from '@/components/browser/BrowserExtrasPanel.vue'
import BrowserSettingsPage from '@/components/browser/BrowserSettingsPage.vue'
import BrowserBookmarksPanel from '@/components/browser/BrowserBookmarksPanel.vue'
import { getPlatform } from '@/platform'
import { BROWSER_SEARCH_ENGINES, browserSearchEngine, browserSearchEngineLabel, buildBrowserSearchUrl } from '@/shared/browserSearch'

const store = usestore()
const zh = computed(() => store.locales === 'zh')

/**
 * 停靠模式（主页右侧栏「浏览器」标签）：
 * - 不再整窗铺满（CSS .embedded 改为填满侧栏）；
 * - 没有窗口控制按钮 / 拖动区；
 * - 网页区位置改由本组件把 .ba-main 的矩形上报给主进程（原生 WebContentsView 挂在**主窗口**上）；
 * - 切标签 / 关侧栏 / 有浮层盖住时必须把原生视图藏起来（它永远画在 DOM 之上）。
 */
const props = withDefaults(defineProps<{
  /** 停靠在主页右侧栏中渲染（而非独立窗口） */
  embedded?: boolean
  /** 本标签在侧栏里是否可见（切走的标签要把原生视图藏起来） */
  paneActive?: boolean
  /** 主窗口里有浮层（设置 / 文件窗口 / 聊天弹窗）盖住侧栏 → 也要藏起来 */
  occluded?: boolean
}>(), { embedded: false, paneActive: true, occluded: false })

/** 原生网页视图当前是否应当可见：侧栏标签在前台 + 没有浮层遮盖 */
const paneVisible = computed(() => !props.embedded || (!!props.paneActive && !props.occluded))
/**
 * 本壳实例 id：主页右侧栏与单窗口浏览器页可能先后挂载同一个 WebContentsView，
 * 旧壳卸载时的 detach 必须被主进程忽略，否则会拆掉新壳的视图。
 */
const dockOwner = `ba-${Math.random().toString(36).slice(2, 10)}`

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
  agentOwner: string | null
  agentPaused: boolean
}>({
  tabs: [], activeTabId: null, url: '', title: '', loading: false,
  canGoBack: false, canGoForward: false, agentActive: false, agentBusyTabId: null, agentTool: '', allowEval: false,
  agentOwner: null, agentPaused: false,
})

const activeTab = computed(() => state.tabs.find(t => t.id === state.activeTabId) || null)
const isSecure = computed(() => /^https:/.test(state.url))
// 当前标签是否为 AI 会话标签（决定 chip 显示 AI 状态还是普通浏览状态）
const curIsAgentTab = computed(() => !!(activeTab.value as any)?.agent)
// agent 状态 chip：跟随当前激活标签
const agentChip = computed(() => {
  if (state.agentPaused) {
    return {
      cls: 'plain',
      icon: 'fa-pause',
      text: zh.value ? '已暂停' : 'Paused',
      title: zh.value ? 'AI 操作已暂停：点顶部 ▶ 继续，或直接操作当前标签接管' : 'AI paused: press ▶ to resume, or interact with the tab to take over',
    }
  }
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
const railView = ref<'bookmarks' | 'downloads' | 'history'>('bookmarks')
/** 设置页（像 ego-lite 一样作为独立标签页）：open=标签存在于标签栏；active=当前正在显示 */
const settingsTabOpen = ref(false)
const settingsTabActive = ref(false)

/** 激活设置标签：标签存在 + 盖住网页区（隐藏原生视图） */
const activateSettingsTab = async () => {
  settingsTabOpen.value = true
  settingsTabActive.value = true
  await invoke('browser-agent:set-overlay', { visible: true }).catch(() => {})
}
/** 切到其它标签：只取消激活，设置标签仍保留在标签栏（只能手动关闭） */
const deactivateSettingsTab = () => {
  if (!settingsTabActive.value) return
  settingsTabActive.value = false
  void invoke('browser-agent:set-overlay', { visible: false }).catch(() => {})
}
/** 手动关闭（标签上的 ×）：移除标签并恢复网页视图 */
const closeSettingsTab = () => {
  const wasActive = settingsTabActive.value
  settingsTabOpen.value = false
  settingsTabActive.value = false
  if (wasActive) void invoke('browser-agent:set-overlay', { visible: false }).catch(() => {})
}
/** 工具栏 ⚙ / 设置标签点击：打开或重新激活；不会自动关闭（关闭只能点 ×） */
const toggleSettingsTab = () => {
  if (settingsTabActive.value) return
  void activateSettingsTab()
}
/** 顶部工具栏图标可见性（设置 → 浏览器 → 图标；旧配置默认全部显示） */
const showBookmarksIcon = computed(() => store.UI.browserShowBookmarks !== false)
const showDownloadsIcon = computed(() => store.UI.browserShowDownloads !== false)
const showHistoryIcon = computed(() => store.UI.browserShowHistory !== false)
/** 正在下载/暂停中的数量：>0 时下载图标显示小圆点（不静默） */
const downloadingCount = ref(0)
const applyDownloadRows = (rows: any) => {
  if (!Array.isArray(rows)) return
  downloadingCount.value = rows.filter((d) => d?.state === 'progressing' || d?.state === 'paused').length
}
// 当前标签正被 AI 操作：停靠栏收起时在设置按钮上显示小红点（展开后侧栏内有完整状态行）
const agentBusyDot = computed(() =>
  !!state.agentActive && !!state.agentBusyTabId && state.activeTabId === state.agentBusyTabId
)

const syncRail = async () => {
  // 停靠模式：网页区位置由 .ba-main 的矩形上报决定（侧栏宽度天然被排除），不需要再通知主进程
  if (props.embedded) return
  await invoke('browser-agent:set-rail', { open: railOpen.value, width: SIDE_RAIL_W }).catch(() => {})
}

/** 打开指定侧栏视图；同视图再次点击则收起；切换视图保持展开 */
const openRail = async (view: 'bookmarks' | 'downloads' | 'history') => {
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
const toggleBookmarks = () => openRail('bookmarks')
const toggleDownloads = () => openRail('downloads')
const toggleHistory = () => openRail('history')

// 从主窗口最近写入的 localStorage 同步浏览器偏好（主页/新标签页/搜索/收藏夹/剪藏/AI 开关），
// 避免主窗口「设置 → 其他 → 浏览器」改动后本独立窗口仍读到旧值
const syncBrowserPrefs = () => {
  try {
    const raw = localStorage.getItem('UI')
    if (raw) {
      const ui = JSON.parse(raw)
      if (ui && typeof ui === 'object') {
        if (typeof ui.browserHomeUrl === 'string') store.UI.browserHomeUrl = ui.browserHomeUrl
        if (typeof ui.browserSaveDir === 'string') store.UI.browserSaveDir = ui.browserSaveDir
        if (ui.browserNewTab === 'bookmarks' || ui.browserNewTab === 'blank') store.UI.browserNewTab = ui.browserNewTab
        if (typeof ui.browserSearchEngine === 'string' && BROWSER_SEARCH_ENGINES.some(e => e.id === ui.browserSearchEngine)) {
          store.UI.browserSearchEngine = ui.browserSearchEngine
        }
        if (typeof ui.browserSearchTemplate === 'string') store.UI.browserSearchTemplate = ui.browserSearchTemplate
        if (typeof ui.browserGridCols === 'number' && isFinite(ui.browserGridCols)) store.UI.browserGridCols = ui.browserGridCols
        if (typeof ui.browserAllowEval === 'boolean') store.UI.browserAllowEval = ui.browserAllowEval
        if (typeof ui.browserClipDir === 'string') store.UI.browserClipDir = ui.browserClipDir
        if (typeof ui.browserClipFrontMatter === 'boolean') store.UI.browserClipFrontMatter = ui.browserClipFrontMatter
        if (typeof ui.browserShowBookmarks === 'boolean') store.UI.browserShowBookmarks = ui.browserShowBookmarks
        if (typeof ui.browserShowDownloads === 'boolean') store.UI.browserShowDownloads = ui.browserShowDownloads
        if (typeof ui.browserShowHistory === 'boolean') store.UI.browserShowHistory = ui.browserShowHistory
      }
    }
  } catch { /* 忽略 */ }
  // AI 执行 JS 开关的真实状态在主进程：同步配置后按配置文件重置（浏览器窗口可能先于设置页启动）
  void syncAllowEvalToMain()
}

// 浏览器 Agent 是桌面专属子系统（独立窗口 + 主进程 WebContentsView）；
// 经平台端口调用，其它环境 reject，调用方既有 .catch 会静默降级。
const invoke = (method: string, payload?: any) =>
  getPlatform().browserAgent.call(method.replace(/^browser-agent:/, '') as any, payload)

// ===== 紧凑模式：窗口过小时隐藏地址/工具条，仅保留标签栏（宽度或高度低于阈值即触发；与主进程 browser-agent:set-compact 联动） =====
const COMPACT_W = 760 // 窄窗口阈值（px）
const COMPACT_H = 520 // 矮窗口阈值（px）
const compactNav = ref(false)
const measureCompact = () => {
  // 停靠模式：按侧栏自身的尺寸判断（窗口尺寸没意义）
  const rect = props.embedded ? shellRef.value?.getBoundingClientRect() : null
  const w = rect ? rect.width : (window.innerWidth || 0)
  const h = rect ? rect.height : (window.innerHeight || 0)
  compactNav.value = (w > 0 && w < COMPACT_W) || (h > 0 && h < COMPACT_H)
}
const onWinResize = () => { measureCompact() }
// 紧凑状态变化 → 通知主进程调整网页视图顶部高度（停靠模式下位置完全由矩形上报决定，不需要通知）
watch(compactNav, (c) => {
  if (props.embedded) return
  void invoke('browser-agent:set-compact', { compact: c }).catch(() => {})
})

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
  state.agentOwner = s.agentOwner || null
  state.agentPaused = !!s.agentPaused
}

const onEvent = (payload: any) => applyState(payload)

// 主题广播：主窗口切换主题后应用（更新 store.UI + 重设 CSS 变量），本窗口跟随
const onThemeChanged = (ui: any) => {
  store.applyThemeFromBroadcast(ui)
  sendBrowserTheme()
}
// 把当前主题色同步给主进程，用于内嵌网页内容滚动条等按主题着色
const sendBrowserTheme = () => {
  const u = store.UI
  getPlatform().browserAgent.call('set-theme', {
    ui: {
      fontColor: u?.fontColor || '#888888',
      fontActiveColor: u?.fontActiveColor || '#409eff',
      backgroundColor: u?.backgroundColor || '#ffffff',
      menuColor: u?.menuColor || '#f6f8fa',
      borderColor: u?.borderColor || '#d0d7de',
    },
  }).catch(() => {})
}

// 激活标签变化时同步地址栏文本（新标签页无搜索框：地址栏即搜索入口，聚焦地址栏）
watch(() => state.activeTabId, async () => {
  const tab = activeTab.value
  urlInput.value = tab?.url || ''
  if (tab && !tab.url && !tab.loading) {
    await nextTick()
    addrInput.value?.focus()
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

const addTab = async (u?: string) => { deactivateSettingsTab(); await invoke('browser-agent:add-tab', u ? { url: u } : {}).catch(() => {}) }
const openTabByUrl = (u?: string) => { if (u) { deactivateSettingsTab(); void invoke('browser-agent:add-tab', { url: u }).catch(() => {}) } }
const switchTab = async (id: string) => { deactivateSettingsTab(); await invoke('browser-agent:switch-tab', { id }).catch(() => {}) }
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
// AI 控制：暂停 / 继续 / 接管（停靠栏与工具栏共用同一组主进程状态）
const toggleAgentPaused = async () => {
  const method = state.agentPaused ? 'browser-agent:resume-agent' : 'browser-agent:pause-agent'
  const s = await invoke(method, { owner: state.agentOwner }).catch(() => null)
  if (s) applyState(s)
  showToast(state.agentPaused
    ? (zh.value ? '已暂停 AI 操作：该会话的浏览器工具会被拒绝' : 'AI paused: this session\'s browser tools are rejected')
    : (zh.value ? '已继续 AI 操作' : 'AI resumed'))
}
const handoffAgent = async () => {
  const s = await invoke('browser-agent:handoff-agent', { owner: state.agentOwner }).catch(() => null)
  if (s) applyState(s)
  showToast(zh.value ? '已接管：AI 标签已转为普通标签并暂停该会话' : 'Taken over: AI tabs are now normal tabs and the session is paused')
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
// 否则视为搜索词 → 用「设置 → 浏览器 → 搜索」里选定的引擎搜索
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
// ===== 地址栏即搜索栏：关键词 → 所选引擎；网址 → 直接打开 =====
const engineLabel = computed(() => browserSearchEngineLabel(store.UI?.browserSearchEngine, zh.value))
/** 地址栏当前输入看起来是关键词（非网址）→ 显示搜索图标 + 引擎徽标，提示将走搜索 */
const addrIsSearch = computed(() => !!urlInput.value.trim() && !isLikelyUrl(urlInput.value))
const addrPlaceholder = computed(() => zh.value
  ? `输入网址打开，或输入关键词用 ${engineLabel.value} 搜索`
  : `Enter a URL, or keywords to search with ${engineLabel.value}`)
const addrTitle = computed(() => zh.value
  ? `地址栏：网址直接打开；关键词用「${engineLabel.value}」搜索（可在右侧 ⚙ → 浏览器设置中更换引擎）`
  : `Address bar: URLs open directly; keywords search with ${engineLabel.value} (change it in ⚙ → Browser settings)`)

const navigate = async () => {
  const u0 = urlInput.value.trim()
  if (!u0) return
  deactivateSettingsTab()
  // 非标准链接格式（纯关键词 / 句子）→ 交给所选搜索引擎
  const u = isLikelyUrl(u0)
    ? u0
    : buildBrowserSearchUrl(u0, store.UI?.browserSearchEngine, store.UI?.browserSearchTemplate)
  await invoke('browser-agent:navigate', { url: u }).catch(() => {})
}
const action = async (a: string) => {
  deactivateSettingsTab()
  await invoke('browser-agent:action', { action: a }).catch(() => {})
}
/** 把「允许 AI 执行 JS」持久化设置下发给主进程（browser_eval 开关由主进程持有，重启后需重新同步） */
const syncAllowEvalToMain = async () => {
  const v = store.UI?.browserAllowEval === true
  state.allowEval = v
  await invoke('browser-agent:set-eval', { enabled: v }).catch(() => {})
}
const openExternal = async () => {
  if (state.url && window.open) window.open(state.url, '_blank')
}
// 自绘窗口控制（无边框窗口；IPC 按发送方窗口定位）
const minimizeWindow = async () => { await getPlatform().window.minimize().catch(() => {}) }
const maximizeWindow = async () => {
  isMaximized.value = !isMaximized.value
  await getPlatform().window.toggleMaximize().catch(() => {})
}
const closeWindow = async () => {
  store.saveConfig()
  await getPlatform().window.close().catch(() => {})
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
const onToastEvent = (payload: any) => {
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
  if (!dir) { showToast(zh.value ? '请先添加工作区，或在「浏览器设置 → 收藏夹」里选择文件夹' : 'Add a workspace folder or pick one under “Browser settings → Folder”', 'err'); return }
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
const homeUp = () => { homePath.value = homePath.value.slice(0, -1) }
// 点击格子：文件夹 → 进入下一级；书签 → 新标签页打开
const homeTileClick = (b: HomeBm) => {
  if (b.kind === 'dir') homePath.value = b.rel.split('/')
  else openBookmark(b)
}
// 目录被删除 / 收藏位置切换后，若当前所在文件夹已不存在 → 回到顶层
watch(() => bmItems.value, () => {
  const rel = currentDirRel.value
  if (rel && !(bmItems.value || []).some(i => i.kind === 'dir' && i.rel === rel)) homePath.value = []
})

// 站点首字母（无则用标题首字符）：无 favicon 时在图标位居中显示 **只有这一个字**
const avatarLetter = (b: HomeBm) => {
  const c = (b.host || b.title || '').trim().charAt(0)
  return (c || '★').toUpperCase()
}
const BM_PALETTE = ['#d97757', '#4a90c4', '#56a35f', '#a35fc0', '#c48a3f', '#4fa8a0', '#c46086', '#7a8ab5', '#5b8db8', '#b8724f']
// 按域名哈希取稳定配色（无域名时按标题取，避免出现无色块）
const avatarColor = (host: string, title = '') => {
  const key = host || title
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
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

// ===== 新标签页：整页收藏夹 grid（全部平铺、不折叠） =====
/** 新标签页内容模式（设置 → 浏览器 → 新标签页）：bookmarks=收藏夹网格 / blank=空白页 */
const newTabIsBookmarks = computed(() => String(store.UI?.browserNewTab ?? 'bookmarks') !== 'blank')
/** 每行书签数（0=自动，交给 CSS auto-fill 按窗口宽度铺满） */
const gridColsPref = computed(() => {
  const n = Math.floor(Number(store.UI?.browserGridCols) || 0)
  return n >= 3 && n <= 12 ? n : 0
})

// ===== 新标签页显示方式：网格 / 列表 + 图标尺寸（与「文件视图」同一套交互：Ctrl+滚轮无级调整） =====
// 尺寸为连续 px 值；小于下限即等同列表视图（与 view_file.vue 的 ICON_SCALE_MIN/MAX 一致）
const HOME_SCALE_MIN = 56
const HOME_SCALE_MAX = 220
const HOME_MODE_KEY = 'browserhome-mode'
const HOME_SCALE_KEY = 'browserhome-scale'
let savedHomeMode = ''
let savedHomeScale = NaN
try {
  savedHomeMode = localStorage.getItem(HOME_MODE_KEY) || ''
  savedHomeScale = Number(localStorage.getItem(HOME_SCALE_KEY))
} catch { /* localStorage 不可用时用默认值 */ }
// 新标签页默认「列表」（紧凑）；只有 Ctrl+滚轮往上滚放大过才会记成 grid
const homeViewMode = ref<'grid' | 'list'>(savedHomeMode === 'grid' ? 'grid' : 'list')
const homeIconScale = ref(
  Number.isFinite(savedHomeScale) && savedHomeScale > 0
    ? Math.max(HOME_SCALE_MIN, Math.min(HOME_SCALE_MAX, Math.round(savedHomeScale)))
    : 92
)
// 列表模式下也把尺寸归一到下限以内：保证「Ctrl+滚轮往上滚一点就能回到网格」的手感一致
if (homeViewMode.value === 'list' && homeIconScale.value > HOME_SCALE_MIN) homeIconScale.value = HOME_SCALE_MIN
watch(homeViewMode, (v) => { try { localStorage.setItem(HOME_MODE_KEY, v) } catch { /* 忽略 */ } })
watch(homeIconScale, (v) => { try { localStorage.setItem(HOME_SCALE_KEY, String(v)) } catch { /* 忽略 */ } })
/**
 * Ctrl+滚轮无级调整图标大小（与文件视图 `onContainerWheel` 同算法）：
 * 每格滚轮 deltaY≈100 → 8px；缩到下限以下自动切列表，往上滚回网格。
 * 普通滚轮不拦截（交给收藏区自身滚动）。
 */
const onHomeWheel = (e: WheelEvent) => {
  if (!e.ctrlKey && !e.metaKey) return
  e.preventDefault()
  let s = homeViewMode.value === 'list' ? HOME_SCALE_MIN - 8 : homeIconScale.value
  s += -e.deltaY / 100 * 8
  if (s < HOME_SCALE_MIN) {
    homeViewMode.value = 'list'
  } else {
    homeViewMode.value = 'grid'
    homeIconScale.value = Math.max(HOME_SCALE_MIN, Math.min(HOME_SCALE_MAX, Math.round(s)))
  }
}
/** 图标盒子（网格格子 / 列表行共用）：正方形，圆角随尺寸等比缩放 */
const iconBoxStyle = computed(() => {
  const s = Math.max(HOME_SCALE_MIN, Math.min(HOME_SCALE_MAX, Math.round(homeIconScale.value)))
  return {
    width: `${s}px`,
    height: `${s}px`,
    borderRadius: `${Math.max(4, Math.round(s * 0.18))}px`,
    '--ba-icon-size': `${s}px`,
  } as Record<string, string>
})
/** 文件名/书签名文字大小（小图标 9px → 大图标 13px，与文件视图同一区间） */
const fileNameFontSize = computed(() => {
  const s = homeIconScale.value
  if (s <= 64) return '9px'
  if (s >= 160) return '13px'
  return '11px'
})
/** 网格：固定「每行 N 个」优先（用户设置），否则按图标尺寸 auto-fill（未设置时与旧版 104px 视觉一致） */
const gridStyle = computed(() => {
  const cols = gridColsPref.value
  if (cols) return { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: '8px' }
  const tile = Math.round(homeIconScale.value)
  return {
    gridTemplateColumns: `repeat(auto-fill, minmax(${Math.max(96, tile + 8)}px, 1fr))`,
    gap: homeIconScale.value >= 160 ? '8px' : '6px',
  }
})
watch(homeVisible, async (v) => {
  if (!v) return
  // 每次切到新标签页都回到收藏夹顶层并刷新：避免停在某个子文件夹里，
  // 导致刚收藏的“顶层页面”在新标签页下方看不到（像没识别到）。
  homePath.value = []
  void refreshBookmarks()
  await nextTick()
}, { immediate: true })

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

/**
 * 页面操作「保存 Markdown 到知识库」：主进程净化正文 → turndown 转 Markdown，
 * 落到「知识库根目录 / 剪藏子目录（设置可改）」；返回相对路径并提示，便于在知识管理里找到。
 */
const saveMarkdown = async () => {
  if (!state.url) return
  const root = browserBaseDir()
  if (!root) {
    showToast(zh.value ? '请先添加工作区，或在「浏览器设置 → 收藏夹」里选择文件夹' : 'Add a workspace or pick a folder under “Browser settings → Folder”', 'err')
    return
  }
  const subdir = String(store.UI?.browserClipDir ?? '').trim()
  const frontMatter = store.UI?.browserClipFrontMatter !== false
  const res = await invoke('browser-agent:save-markdown', { root, subdir, frontMatter }).catch(() => null)
  if (res?.ok) {
    showToast(zh.value ? `已保存到知识库：${res.rel || res.path}` : `Saved to knowledge base: ${res.rel || res.path}`)
  } else {
    showToast(res?.error || (zh.value ? '保存失败' : 'Save failed'), 'err')
  }
}

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

/** 宿主事件退订句柄（挂载时登记，卸载时统一释放） */
const unsubBrowserEvents: Array<() => void> = []

// ===================== 停靠模式：位置上报 / 可见性 / 浮层遮挡 =====================
const shellRef = ref<HTMLElement | null>(null)
const mainRef = ref<HTMLElement | null>(null)
let dockObserver: ResizeObserver | null = null
let dockRaf = 0
let bodyObserver: MutationObserver | null = null
/** 主窗口里是否有盖住侧栏的 Element Plus 浮层（对话框 / 消息框） */
const externalOverlayOpen = ref(false)

/** 把网页区（.ba-main）的矩形报给主进程：原生 WebContentsView 要正好铺在这里 */
const pushDockRect = () => {
  if (!props.embedded) return
  if (dockRaf) return
  dockRaf = requestAnimationFrame(() => {
    dockRaf = 0
    const el = mainRef.value
    if (!el) { void invoke('browser-agent:set-dock-rect', { rect: null, owner: dockOwner }).catch(() => {}); return }
    const r = el.getBoundingClientRect()
    void invoke('browser-agent:set-dock-rect', {
      // 主进程会再乘窗口缩放（CSS px × zoom = DIP）
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      owner: dockOwner,
    }).catch(() => {})
  })
}

/** 页面可见性交回主进程：不可见时它必须 setVisible(false)，否则原生视图会盖住界面 */
const pushDockVisible = () => {
  if (!props.embedded) return
  void invoke('browser-agent:set-dock-visible', {
    visible: paneVisible.value && !externalOverlayOpen.value,
    owner: dockOwner,
  }).catch(() => {})
  pushDockRect()
}

/** 盯着 body 子节点：Element Plus 的 .el-overlay / 消息框是挂在 body 上的（不常变，代价很低） */
const watchBodyOverlays = () => {
  if (typeof document === 'undefined') return
  const sync = () => {
    const next = !!document.querySelector('.el-overlay, .el-message-box__wrapper, .el-dialog__wrapper')
    if (next === externalOverlayOpen.value) return
    externalOverlayOpen.value = next
    pushDockVisible()
  }
  sync()
  bodyObserver = new MutationObserver(sync)
  bodyObserver.observe(document.body, { childList: true })
}

watch(paneVisible, () => pushDockVisible())
watch(() => props.occluded, () => pushDockVisible())

onMounted(async () => {
  unsubBrowserEvents.push(getPlatform().events.on('browser-agent:event', onEvent))
  unsubBrowserEvents.push(getPlatform().events.on('theme-changed', onThemeChanged))
  unsubBrowserEvents.push(getPlatform().events.on('browser-agent:toast', onToastEvent))
  // 下载进度：图标上的小圆点（面板自身也订阅同一事件）
  unsubBrowserEvents.push(getPlatform().events.on('browser-agent:downloads', (rows: any) => applyDownloadRows(rows)))
  void invoke('browser-agent:downloads-list').then((rows: any) => {
    applyDownloadRows(Array.isArray(rows) ? rows : rows?.data)
  }).catch(() => {})
  // 网页右键菜单里「保存整页 / 保存 Markdown」需要渲染层的工作区目录与对话框，主进程只发动作
  unsubBrowserEvents.push(getPlatform().events.on('browser-agent:menu-action', (payload: any) => {
    const action = String(payload?.action || '')
    if (action === 'save-page-full') void savePage('full')
    else if (action === 'save-markdown') void saveMarkdown()
  }))
  window.addEventListener('resize', onWinResize)
  window.addEventListener('resize', pushDockRect)
  measureCompact()
  sendBrowserTheme()
  // 独立窗口启动即同步可能已配置好的浏览器偏好，并确保右侧停靠栏为收起初始态
  syncBrowserPrefs()
  // 下发设置页里的浏览器行为配置（页面预算/默认快照/下载目录）
  void invoke('browser-agent:set-config', {
    pageBudget: store.UI?.browserPageBudget || 8,
    snapshotInteractiveOnly: !!store.UI?.browserSnapshotInteractiveOnly,
    downloadDir: store.UI?.browserDownloadDir || '',
  }).catch(() => {})

  if (props.embedded) {
    // 停靠：把（可能已存在的）标签视图挂到主窗口，并把矩形交回主进程
    await invoke('browser-agent:attach-dock', { owner: dockOwner }).catch(() => {})
    if (mainRef.value && typeof ResizeObserver !== 'undefined') {
      dockObserver = new ResizeObserver(() => { measureCompact(); pushDockRect() })
      dockObserver.observe(mainRef.value)
    }
    watchBodyOverlays()
    pushDockVisible()
  } else {
    void invoke('browser-agent:set-rail', { open: false }).catch(() => {})
  }

  void refreshBookmarks()
  try {
    const res = await invoke('browser-agent:state')
    if (res?.ok) applyState(res.data)
  } catch { /* 忽略 */ }
})
onBeforeUnmount(() => {
  for (const off of unsubBrowserEvents.splice(0)) { try { off() } catch { /* 忽略 */ } }
  window.removeEventListener('resize', onWinResize)
  window.removeEventListener('resize', pushDockRect)
  if (bmAutoTimer) { clearInterval(bmAutoTimer); bmAutoTimer = null }
  dockObserver?.disconnect(); dockObserver = null
  bodyObserver?.disconnect(); bodyObserver = null
  if (dockRaf) { cancelAnimationFrame(dockRaf); dockRaf = 0 }
  // 离开时恢复被设置页隐藏的原生网页视图
  if (settingsTabActive.value) void invoke('browser-agent:set-overlay', { visible: false }).catch(() => {})
  // 离开侧栏：把原生视图从主窗口摘下来（标签与会话保留，下次停靠直接接着用）
  if (props.embedded) void invoke('browser-agent:detach-dock', { owner: dockOwner }).catch(() => {})
})
</script>

<style scoped>
.browser-agent-shell {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--backgroundColor, #ffffff);
  color: var(--fontColor);  overflow: hidden;
}

/* ====== 停靠模式（主页右侧栏「浏览器」标签）：填满侧栏，不铺满窗口 ====== */
.browser-agent-shell.embedded {
  position: relative;
  inset: auto;
  width: 100%;
  height: 100%;
}
/* 原生网页视图在 DOM 之上：本面板被切走 / 被浮层盖住时整块让位（避免遮住别的界面） */
.browser-agent-shell.embedded.embedded-hidden { visibility: hidden; }
/* 侧栏里没有系统窗口：标签栏不再是拖动区 */
.browser-agent-shell.embedded .ba-tabbar { -webkit-app-region: no-drag; }
/* 窄侧栏（默认 360px 左右）下按紧凑模式排版：只留标签栏 + 地址栏，工具按钮换行交给 .ba-navbar 自身滚动 */
.browser-agent-shell.embedded .ba-navbar { padding: 0 4px; gap: 4px; }
.browser-agent-shell.embedded .ba-tab { flex: 0 1 120px; max-width: 150px; }
/* 设置标签页（内部页） */
.ba-tab-settings { flex: 0 0 auto; max-width: 130px; }
.ba-tab-settings .ba-tab-favicon { color: var(--fontActiveColor); }
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
  position: relative;
}
/* 下载进行中：图标右上角琥珀色小圆点（带动画，避免静默） */
.ba-dl-dot {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #e6a23c;
  box-shadow: 0 0 0 1.5px var(--backgroundColor), 0 0 5px rgba(230, 162, 60, .8);
  animation: ba-dl-pulse 1.4s ease-in-out infinite;
  pointer-events: none;
}
@keyframes ba-dl-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: .55; transform: scale(.82); }
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
/* 输入内容看起来是关键词（将走搜索）时：图标切为放大镜 + 右侧显示当前引擎名 */
.ba-addr.searching { border-color: color-mix(in srgb, var(--fontActiveColor) 45%, var(--borderColor)); }
.ba-addr-icon { flex-shrink: 0; font-size: 11px; color: var(--fontColor); opacity: .6; }
.ba-addr.searching .ba-addr-icon { color: var(--fontActiveColor); opacity: .9; }
.ba-addr-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--fontColor);
  font-size: 12px;
}
.ba-addr-badge {
  flex-shrink: 0;
  max-width: 96px;
  padding: 1px 6px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--fontActiveColor) 12%, transparent);
  color: var(--fontActiveColor);
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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

/* ====== 新标签页：整页收藏夹 grid（无搜索框、无提示条，搜索并入地址栏；不折叠，全部平铺） ====== */
.ba-home {
  flex: 1;
  min-height: 0;
  overflow: hidden; /* 滚动交给下方书签区 */
  padding: 0px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
}
/* 空白页模式：什么都不显示 */
.ba-home-blank {
  align-items: center;
  justify-content: center;
}
/* 收藏夹 grid：占满剩余高度，超出时本区滚动（不再限量、不再“展开全部”） */
.ba-home-bookmarks {
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  overflow-y: auto;
  overflow-x: hidden;
}
/* 空收藏占位：一个列表/网格里的占位块（不再用整段操作提示） */
.ba-home-bm-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 84px;
  margin-bottom: 8px;
  border: 1px dashed color-mix(in srgb, var(--fontColor) 18%, transparent);
  border-radius: 8px;
  color: var(--fontColor);
  opacity: .45;
  font-size: 12px;
}
.ba-home-bm-placeholder.list { min-height: 34px; justify-content: flex-start; padding: 0 10px; }
.ba-home-bm-placeholder i { color: var(--fontActiveColor); }
/* 新标签页工具条样式已随「网格/列表切换开关」一并移除；显示方式由 Ctrl+滚轮决定 */
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
/* 加载完成前先用旧版 46px 兜底（:style 里的内联宽高会覆盖它） */
.ba-home-iconbox {
  --ba-icon-size: 46px;
  position: relative;
  width: var(--ba-icon-size);
  height: var(--ba-icon-size);
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.ba-home-bm-img {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  border-radius: max(6px, calc(var(--ba-icon-size) * .18));
  padding: 2px;
  background: color-mix(in srgb, var(--menuColor) 80%, #fff);
  object-fit: contain;
}
/* 无 favicon 时的「标题首字」占位：单个字居中在图标位，字号取盒子 44%（与图标同量级） */
.ba-home-bm-avatar {
  width: 100%;
  height: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: calc(var(--ba-icon-size) * .44);
  font-weight: 600;
  line-height: 1;
  user-select: none;
}
/* 文件夹图标与 favicon 视觉量级对齐：取盒子尺寸 62%（原来固定较小倍率，显得过小） */
.ba-home-bm-folder {
  font-size: calc(var(--ba-icon-size) * .62);
  line-height: 1;
  color: #f0b429;
  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .18));
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

/* ====== 新标签页·列表视图（紧凑单行：小图标 + 名称 + 域名 + 悬浮操作） ====== */
.ba-home-bm-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  overflow: hidden;
}
/* 列表行图标固定 18px 小图标（列表模式不受 Ctrl+滚轮尺寸影响，保证行高紧凑稳定） */
.ba-home-row-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px !important;
  height: 18px !important;
  flex-shrink: 0;
  overflow: hidden;
}
/* 列表行图标固定 18px 小图标（列表模式不受 Ctrl+滚轮尺寸影响，保证行高紧凑稳定） */
.ba-home-row-icon > .ba-home-bm-img {
  width: 18px;
  height: 18px;
  border-radius: 5px;
  padding: 1px;
}
.ba-home-row-icon > .ba-home-bm-avatar {
  font-size: 12px;
  font-weight: 600;
}
.ba-home-row-icon > .ba-home-bm-folder {
  font-size: 13px;
}
.ba-home-bm-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 26px;
  padding: 2px 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--borderColor) 45%, transparent);
  cursor: pointer;
  color: var(--fontColor);
  font-size: 12px;
  line-height: 1.3;
  transition: background .12s;
  min-width: 0;
}
.ba-home-bm-row:last-child { border-bottom: none; }
.ba-home-bm-row:hover { background: color-mix(in srgb, var(--fontActiveColor) 8%, transparent); }
.ba-home-row-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ba-home-row-host {
  flex: 0 1 30%;
  min-width: 0;
  text-align: right;
  font-size: 10px;
  opacity: .45;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ba-home-row-actions {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  width: 17px;
  justify-content: flex-end;
}
.ba-home-row-btn {
  width: 16px;
  height: 16px;
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
  transition: background .12s;
}
.ba-home-bm-row:hover .ba-home-row-btn { display: inline-flex; }
.ba-home-row-btn:hover { background: #e81123; }
.ba-home-row-btn.edit:hover { background: #1971c2; }

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
  max-width: calc(92vw / var(--ui-zoom, 1));
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
.ba-star-btn.on { color: #f0b429; }

/* ====== 自适应布局：窗口变窄时标签 / 导航栏 / 新标签页提示缩小；小窗书签去图标只显名称 ====== */
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
  .ba-addr-badge { display: none; } /* 窄窗：引擎徽标让位给输入内容（placeholder 已写明引擎） */
  .ba-home { padding: 12px 12px 14px; }
  /* 小窗：网格模式去图标 → 纯名称（更紧凑，更多可排一行）；列表模式仍保留图标（列表本就窄） */
  .ba-home-bm-grid .ba-home-bm-icon { display: none; }
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
  .ba-home-row-host { display: none; } /* 窄窗列表：域名让位给名称 */
}
@media (max-width: 520px) {
  .ba-tab { flex-basis: 84px; }
  .ba-home-bm-grid { grid-template-columns: repeat(auto-fill, minmax(68px, 1fr)); }
  .ba-home-bm-item { padding: 5px 6px; }
  .ba-home-bm-name { font-size: 10px; }
}
</style>
