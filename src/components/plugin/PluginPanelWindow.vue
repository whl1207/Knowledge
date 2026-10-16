<!--
  PluginPanelWindow.vue — 插件主面板的「子窗口壳」

  用途（两处共用，保证桌面与网页端观感一致）：
  1) 桌面：主进程开的真独立子窗口（`#/plugin-panel?id=...`），App.vue 直接渲染本组件；
  2) 浏览器 / 安卓（无窗口壳）：主窗口内的浮层（`store.pluginPanelOverlay`），
     传 `:overlay="true"` —— 此时不渲染最小化 / 最大化 / 关闭窗口按钮，改由外层浮层的关闭按钮收起。

  壳里有什么：
  - 顶栏：**本插件的那个图标**（静态标识，不参与切换）+ 居中标题 + 窗口按钮；
  - 内容区：当前插件面板（`PluginSlot` 渲染 `panel.main` 的插件条目）；
  - 插件界面半边还没装载完时显示装载态；**装载失败**时把失败原因摊出来（见 failedLoads）。

  ⚠️ 每个渲染进程各自持有一份槽位注册表：本窗口的插件条目由本进程的插件运行时注册
  （见 src/main.ts → initPluginRuntime），因此这里不需要主窗口传任何组件，只传一个 key。

  这意味着**每开一个插件窗口，都要在本窗口重新装载一遍插件界面半边**（清单 → 取各插件
  client 入口源码 → Blob URL import → apply → 注册 panel.main）。窗口多、插件多时这需要时间，
  所以新窗口会先显示「正在载入插件…」——这是「每窗口一份注册表」的必然代价，不是主窗口的数据没共用；
  反过来，如果某个插件的界面半边装载失败，它会一直停在这里（失败不会自愈），
  因此下面要把 clientPluginLoadStates() 里的失败原因显示出来，而不是让人对着「正在载入」干等。
-->
<template>
  <div class="plugin-panel-window" :class="{ overlay }">
    <!-- 顶栏：拖动区 + 本插件图标 + 标题 + 窗口按钮 -->
    <div v-show="!chromeHidden" class="ppw-header">
      <!-- 左上角只放**本插件的那个图标**（静态标识，不参与切换）：
           一个窗口 = 一个插件，换插件请回主窗口的「全部插件」里点 -->
      <div class="ppw-plugin-icon" :title="activeTitle"><i :class="activeIcon"></i></div>

      <div class="ppw-title" :title="activeTitle">{{ activeTitle }}</div>

      <!-- 弹性占位：把三个窗口按钮顶到顶栏最右（与主窗口顶栏同一做法）。
           标题是绝对定位居中的，不参与流式布局，所以这个占位才是把按钮推到右边的那一项。 -->
      <div class="ppw-header-spacer" style="flex:1;min-width:0;"></div>

      <template v-if="!overlay">
        <div v-if="hasCapability('window.chrome')" class="ppw-btn" @click="minimizeWindow" :title="zh ? '最小化' : 'Minimize'"><i class="fa fa-minus"></i></div>
        <div v-if="hasCapability('window.chrome')" class="ppw-btn" @click="maximizeWindow" :title="zh ? '最大化/还原' : 'Maximize / Restore'"><i class="fa" :class="maximized ? 'fa-compress' : 'fa-window-maximize'"></i></div>
        <div v-if="hasCapability('window.chrome')" class="ppw-btn ppw-close" @click="closeWindow" :title="zh ? '关闭' : 'Close'"><i class="fa fa-times"></i></div>
      </template>
    </div>

    <!-- 内容区：本插件的主面板（注册表还没就绪时给载入提示，注册完自动出现） -->
    <div class="ppw-body">
      <PluginSlot v-if="panelReady" :name="PANEL_MAIN_SLOT" :owner="activeKey" />
      <div v-else class="ppw-empty">
        <i class="fa fa-puzzle-piece ppw-empty-icon"></i>
        <div class="ppw-empty-title">{{ zh ? '正在载入插件…' : 'Loading plugins…' }}</div>
        <div class="ppw-empty-text">
          {{ zh
            ? '插件界面扩展还在装载中，装载完成后这里会自动显示该插件面板。'
            : 'The plugin UI is still loading; this panel will appear automatically once it is ready.' }}
        </div>
        <!-- 每个插件窗口都要在本窗口重新装载一遍插件界面半边（本进程自己一份槽位注册表），
             所以新窗口看到这句是正常的；一直停在这里才需要排查 → 给出排查方向 -->
        <div class="ppw-empty-hint">
          {{ zh
            ? '每个插件窗口都会在本窗口独立装载一次插件界面扩展，插件多时需要几秒。若一直停在这里：请在「插件 → 管理」确认该插件已启用、清单里声明了 client 半边，并查看装载失败原因。'
            : 'Each plugin window loads the plugin UIs itself, which can take a few seconds. If it never finishes: check under Plugins → Manage that the plugin is enabled, that its manifest declares a client half, and read the failure reason below.' }}
        </div>
        <!-- 装载失败**不会**自己变好：把原因摊出来，否则只剩一句「正在载入」让人一直等 -->
        <div v-if="failedLoads.length" class="ppw-failed">
          <div class="ppw-failed-title">
            {{ zh ? '有插件的界面扩展装载失败（不会自行恢复）' : 'Some plugin UIs failed to load (they will not recover by themselves)' }}
          </div>
          <div v-for="f in failedLoads" :key="f.id" class="ppw-failed-row">
            <b>{{ f.name }}</b><span v-if="f.message">：{{ f.message }}</span>
          </div>
        </div>
        <div class="ppw-empty-actions">
          <div class="ppw-action" @click="store.openSettings('plugins')"><i class="fa fa-cogs"></i> {{ zh ? '打开插件管理' : 'Plugin manager' }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { usestore } from '@/store'
import { getPlatform, hasCapability } from '@/platform'
import { PANEL_MAIN_SLOT } from '@/lib/plugin/coreSlots'
import { useAllSlotEntries, useSlotVersion } from '@/lib/plugin/useSlots'
import { panelTitleOf, isBuiltinPanel } from '@/lib/plugin/panelRegistry'
import { panelChromeHidden } from '@/lib/plugin/panelChrome'
import { applyPluginOrder } from '@/lib/plugin/navOrder'
import { clientPluginLoadStates, pluginDisplayName } from '@/lib/plugin/runtime'
import PluginSlot from '@/components/plugin/PluginSlot.vue'
import { ref } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 本窗口要显示的插件面板 key（空串 = 插件还没注册完，显示载入态） */
    pluginKey?: string
    /** 主窗口内浮层形态：不渲染窗口按钮（由外层浮层提供关闭） */
    overlay?: boolean
  }>(),
  { pluginKey: '', overlay: false },
)

const store = usestore()
const zh = computed(() => store.locales !== 'en')

/**
 * 本窗口只显示「一个插件」——所以顶栏左上角只放**它自己的一个图标**，不做插件间切换。
 * 想换插件请回主窗口的「全部插件」里点（那是唯一的插件入口），本窗口保持单一职责：
 * 一个插件、一个窗口、关掉即结束。
 */
const slotEntries = useAllSlotEntries(PANEL_MAIN_SLOT)
/** 槽位版本号：注册表（插件启停 / 重载）或用户自定义顺序变化时自增（failedLoads 也靠它刷新） */
const slotVersion = useSlotVersion()

/** 本窗口的插件面板条目（只列插件面板：内置面板属于主窗口，本窗口不渲染） */
const pluginEntries = computed(() =>
  // applyPluginOrder 内部读响应式版本号（useSlotVersion 已把它算进依赖），
  // 因此用户在插件管理里拖动排序后，这里取到的仍是同一份顺序。
  applyPluginOrder(slotEntries.value)
    .filter((def) => !isBuiltinPanel(def.key))
    .map((def) => ({
      key: def.key,
      icon: def.icon || 'fa fa-puzzle-piece',
      title: (zh.value ? def.titleZh : def.titleEn) || def.titleZh || def.key,
      owner: def.owner,
    })),
)

/**
 * 当前插件面板 key：**始终等于传进来的那个 key**（窗口来自 hash，浮层来自 store）。
 *
 * ⚠️ 不要在插件注册表变化时去「写」视图状态来决定显示什么。窗口是按 key 建的，而插件面板要等
 * 本窗口的插件运行时把插件 client 半边异步装载完才注册出来 —— 首帧注册表是空的，
 * 任何「列表里没有 → 改成别的视图」的写回都会把窗口永久钉在那个视图上（踩过：
 * 标题一直是「全部插件」、内容一直是网格，而不是用户点开的那个插件）。
 * 但也**不能**像早先那样把它存成 `ref`（只认第一次的 props.pluginKey）：应用内浮层是同一个组件实例
 * 复用（App.vue 只在 `store.pluginPanelOverlay` 非空时渲染它），换插件时 props 变了而 ref 不变，
 * 于是永远是第一个插件的面板 / 永远停在装载态。这里用 computed 直接跟随 props，读写都只有一个来源。
 */
const activeKey = computed(() => props.pluginKey || '')

/** 当前插件面板是否已注册好 */
const panelReady = computed(() => !!activeKey.value && pluginEntries.value.some((e) => e.key === activeKey.value))
/** 顶栏左上角那个图标 = 当前插件的图标 */
const activeIcon = computed(() => pluginEntries.value.find((e) => e.key === activeKey.value)?.icon || 'fa fa-puzzle-piece')
const chromeHidden = panelChromeHidden
const maximized = ref(false)

/**
 * 界面半边**装载失败**的插件：这些永远不会「装载完成」，必须把原因摊给用户看，
 * 否则页面上只剩一句「正在载入插件…」让人一直等（而它永远不会好）。
 * 装载结果不是响应式的 Map，因此连同槽位版本号一起读：注册表每次变化都重新取一次最新结果。
 */
const failedLoads = computed(() => {
  void slotVersion.value
  return Object.entries(clientPluginLoadStates())
    .filter(([, state]) => !state.ok)
    .map(([id, state]) => ({ id, name: pluginDisplayName(id), message: state.message }))
})

const activeTitle = computed(() => {
  if (panelReady.value) return panelTitleOf(activeKey.value, zh.value)
  return zh.value ? '正在载入插件…' : 'Loading plugins…'
})

// 窗口标题跟随当前插件面板（主进程建窗时给的初始标题只是兜底）
watch(
  () => activeTitle.value,
  (t) => {
    if (typeof document !== 'undefined' && t) document.title = t
  },
  { immediate: true },
)

function minimizeWindow() { void getPlatform().window.minimize() }
function maximizeWindow() {
  maximized.value = !maximized.value
  void getPlatform().window.toggleMaximize()
}
function closeWindow() { void getPlatform().window.close() }
</script>

<style scoped>
.plugin-panel-window {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  background-color: var(--backgroundColor);
  color: var(--fontColor);
  overflow: hidden;
}
/* 浮层形态：由主窗口里的容器决定尺寸与圆角，这里铺满容器即可 */
.plugin-panel-window.overlay .ppw-header {
  -webkit-app-region: no-drag;
}

.ppw-header {
  height: 39px;
  flex: 0 0 39px;
  display: flex;
  align-items: center;
  gap: 0;
  padding: 0 4px 0 5px;
  background-color: var(--menuColor);
  border-bottom: 1px solid var(--borderColor);
  position: relative;
  user-select: none;
  /* 顶栏即拖动区（与主窗口 / 文件窗口一致的无边框方案） */
  -webkit-app-region: drag;
  cursor: move;
}

/* 左上角：本插件的图标（静态标识，不是按钮 —— 本窗口不切换插件）。
   它 no-drag，其余顶栏空白仍是窗口拖动区（拖动条 = 顶栏）。 */
.ppw-plugin-icon {
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  line-height: 30px;
  margin-right: 6px;
  text-align: center;
  border-radius: 5px;
  font-size: 16px;
  color: var(--fontActiveColor);
  -webkit-app-region: no-drag;
}

.ppw-title {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  max-width: 40%;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  opacity: 0.9;
}

.ppw-btn {
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  line-height: 30px;
  margin-right: 6px;
  text-align: center;
  border-radius: 5px;
  font-size: 16px;
  cursor: pointer;
  -webkit-app-region: no-drag;
  transition: all 0.25s ease;
}
.ppw-btn:hover,
.ppw-btn.active {
  color: var(--fontActiveColor);
  background-color: var(--menuActiveColor);
}
.ppw-close {
  font-size: 16px;
}

.ppw-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: auto;
}

.ppw-empty {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 20px;
  text-align: center;
}
.ppw-empty-icon { font-size: 34px; opacity: 0.35; }
.ppw-empty-title { font-size: 15px; font-weight: 600; color: var(--fontActiveColor); }
.ppw-empty-text { max-width: 460px; font-size: 12px; line-height: 1.6; opacity: 0.8; }
.ppw-empty-hint { max-width: 520px; font-size: 11px; line-height: 1.6; opacity: 0.6; }
/* 装载失败清单：与「还在装载」区分开（失败是终态，别让用户干等） */
.ppw-failed {
  max-width: 560px;
  margin-top: 2px;
  padding: 8px 10px;
  border: 1px solid var(--borderColor);
  border-left: 3px solid #e6a23c;
  border-radius: 5px;
  background-color: var(--menuColor);
  text-align: left;
  font-size: 12px;
  line-height: 1.6;
}
.ppw-failed-title { font-weight: 600; color: #e6a23c; margin-bottom: 2px; }
.ppw-failed-row { opacity: 0.85; word-break: break-word; }
.ppw-failed-row + .ppw-failed-row { margin-top: 2px; }
.ppw-empty-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin-top: 4px; }
.ppw-action {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--menuColor);
  font-size: 13px;
  cursor: pointer;
}
.ppw-action:hover {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}
</style>
