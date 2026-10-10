<script setup lang="ts">
/**
 * ViewToolbar.vue — 知识管理全局视图的顶部工具栏
 *
 * 文件 / 看板 / 图谱 / 表格 / 地图 / 日历 共用同一份工具栏：最左侧的「显示 / 隐藏左侧面板」开关
 * （收起 / 展开动画由宿主 explorer.vue 负责）、「视图选择」+ 后退 / 前进 / 向上 / 刷新 + 可点击的面包屑，
 * 右侧是当前目录的搜索框（各视图只负责自己的筛选逻辑，输入框样式与位置在这里统一）。
 *
 * - 导航历史存在 store.knowNavStack（各视图共享一份，切视图不会丢后退能力），
 *   外部改 path（点文件树 / 打开文件）时由本组件调用 store.knowSyncNav() 重置。
 * - 「刷新」只发事件，由各视图重新拉取自己的数据（各视图数据源不同）。
 */
import { computed, watch, onMounted } from 'vue'
import { usestore } from '@/store'
import { FILE_VIEWS as FILE_VIEWS_DEFS, FILE_VIEW_NAMES } from '@/lib/knowFile/fileViews'

const store = usestore()
const zh = (): boolean => store.locales === 'zh'

const props = withDefaults(
  defineProps<{
    /** 搜索框内容（v-model:search） */
    search?: string
    /** 是否显示搜索框 */
    searchable?: boolean
    /** 搜索框占位提示（不传则用通用的「搜索…」） */
    placeholder?: string
    /** 搜索框悬停提示 */
    searchTitle?: string
    /** 左侧文件树面板是否展开（决定开关按钮的图标与提示） */
    panelOpen?: boolean
  }>(),
  { search: '', searchable: true, placeholder: '', searchTitle: '', panelOpen: true }
)
const emit = defineEmits<{
  (e: 'update:search', value: string): void
  (e: 'refresh'): void
  (e: 'toggle-panel'): void
}>()

const onInput = (e: Event) => emit('update:search', (e.target as HTMLInputElement).value)

// ============ 视图选择 ============
// 主窗口没有顶部标签栏，视图选择原先放在文件树面板顶部；现移到这里，紧挨折叠图标右侧，
// 这样文件树面板顶部只剩「搜索框 + 4 个按钮」一行。
/** 视图本地化显示名：store.view / viewList 的内部标识恒为中文（isView / 组件 v-if 都依赖），仅下拉展示随语言切换 */
const VIEW_NAME_EN: Record<string, string> = {
  '文件': 'Files', '图谱': 'Graph', '看板': 'Kanban', '日历': 'Year',
  '地图': 'Map', '表格': 'Table',
  // 文件视图的英文名统一取自 fileViews.ts（与 empty.vue 欢迎页的视图网格一致）
  ...Object.fromEntries(FILE_VIEWS_DEFS.map((v) => [v.name, v.labelEn])),
}
const viewName = (v: string) => (store.locales === 'zh' ? v : (VIEW_NAME_EN[v] || v))

/** 是否显示视图选择：打开工作区即可用（文件一律在独立窗口打开，这份下拉管主窗口的全局视图） */
const showViewSelect = computed(() => store.root !== '')
/** 可切换的视图清单：只列全局视图（文件 / 图谱 / 看板 / 日历 / 地图 / 表格） */
const viewsForGrid = computed(() =>
  showViewSelect.value ? store.viewList.filter((v: string) => !FILE_VIEW_NAMES.includes(v)) : []
)
/** 当前激活的全局视图（多个开启时取第一个） */
const activeGlobalView = computed(() => viewsForGrid.value.find((v: string) => store.isView(v)) || '')
/** 切换视图：互斥单选（开启选中的、关掉清单里其它视图；清单外的视图开关不受影响） */
const onGlobalViewChange = (e: Event) => {
  const v = (e.target as HTMLSelectElement).value
  if (!v || !viewsForGrid.value.includes(v)) return
  const keep = store.view.filter((x: string) => !viewsForGrid.value.includes(x))
  if (!keep.includes(v)) keep.push(v)
  store.view = keep
  store.saveConfig()
}

// path 被外部改动时同步导航历史（历史栈内当前项始终等于 path）
watch(() => [store.path, store.root], () => store.knowSyncNav())
onMounted(() => store.knowSyncNav())
</script>

<template>
  <div class="file-toolbar">
    <button class="toolbar-btn panel-toggle" :class="{ active: props.panelOpen }" @click="emit('toggle-panel')"
      :title="props.panelOpen ? (zh() ? '隐藏左侧面板' : 'Hide left panel') : (zh() ? '显示左侧面板' : 'Show left panel')">
      <i class="fa" :class="props.panelOpen ? 'fa-outdent' : 'fa-indent'"></i>
    </button>
    
    <span class="toolbar-sep sep-nav"></span>
    <div class="file-nav-btns">
      <button class="toolbar-btn" :disabled="!store.knowCanBack" @click="store.knowBack()" :title="zh() ? '后退 (Alt+←)' : 'Back (Alt+←)'"><i class="fa fa-arrow-left"></i></button>
      <button class="toolbar-btn" :disabled="!store.knowCanForward" @click="store.knowForward()" :title="zh() ? '前进 (Alt+→)' : 'Forward (Alt+→)'"><i class="fa fa-arrow-right"></i></button>
      <button class="toolbar-btn" :disabled="!store.knowCanUp" @click="store.knowUp()" :title="zh() ? '向上 (Backspace)' : 'Up (Backspace)'"><i class="fa fa-arrow-up"></i></button>
      <button class="toolbar-btn" @click="emit('refresh')" :title="zh() ? '刷新' : 'Refresh'"><i class="fa fa-refresh"></i></button>
    </div>
    <div class="file-breadcrumb" :title="store.dataDir">
      <template v-for="(c, i) in store.knowCrumbs" :key="c.path">
        <span class="crumb" :class="{ active: i === store.knowCrumbs.length - 1 }" @click="store.knowEnterDir(c.path)">{{ c.label }}</span>
        <i v-if="i < store.knowCrumbs.length - 1" class="fa fa-chevron-right crumb-sep"></i>
      </template>
    </div>
    <!-- 视图选择：紧挨折叠图标右侧 -->
    <select
      v-if="showViewSelect"
      class="toolbar-view-select"
      :value="activeGlobalView"
      :title="zh() ? '选择视图' : 'Select view'"
      @change="onGlobalViewChange"
    >
      <option v-for="v in viewsForGrid" :key="v" :value="v">{{ viewName(v) }}</option>
    </select>
    <div v-if="props.searchable" class="file-search" @click.stop :title="props.searchTitle || (zh() ? '搜索当前目录' : 'Search current folder')">
      <i class="fa fa-search"></i>
      <input class="file-search-input" :value="props.search" :placeholder="props.placeholder || (zh() ? '搜索…' : 'Search…')" @input="onInput" @keydown.stop @keyup.esc="emit('update:search', '')" />
      <i v-if="props.search" class="fa fa-times file-search-clear" :title="zh() ? '清除' : 'Clear'" @click="emit('update:search', '')"></i>
    </div>
  </div>
</template>

<style scoped>
/* ---- 工具栏与面包屑（与文件视图同一套观感） ---- */
.file-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
  flex-shrink: 0;
  user-select: none;
  /* 容器：搜索框按工具栏自身宽度收窄（分屏 / 面板展开导致内容区变窄时也生效） */
  container-type: inline-size;
}
.file-nav-btns {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}
.toolbar-btn {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--fontColor);
  cursor: pointer;
  font-size: 13px;
  transition: background 0.15s;
}
.toolbar-btn:hover:not(:disabled) { background: var(--menuActiveColor); }
.toolbar-btn:disabled { opacity: 0.35; cursor: default; }
/* 最左侧的「显示 / 隐藏左侧面板」开关：展开时点亮，与导航按钮之间用竖线分隔 */
.panel-toggle.active { color: var(--fontActiveColor); }
/* 视图选择：与工具栏其它控件同高 */
.toolbar-view-select {
  flex-shrink: 0;
  height: 26px;
  max-width: 120px;
  padding: 0 4px;
  box-sizing: border-box;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 12px;
  outline: none;
  cursor: pointer;
  margin: 0px;
}
.toolbar-view-select option {
  background-color: var(--menuColor);
  color: var(--fontColor);
}
.toolbar-sep {
  width: 1px;
  height: 14px;
  flex-shrink: 0;
  margin: 0 3px;
  background: var(--borderColor);
}
.file-breadcrumb {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  overflow-x: auto;
  white-space: nowrap;
  font-size: 12px;
  color: var(--fontColor);
  scrollbar-width: none;
}
.file-breadcrumb::-webkit-scrollbar { height: 0; }
.crumb {
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 3px;
  color: var(--fontColor);
  opacity: 0.85;
  flex-shrink: 0;
}
.crumb:hover { background: var(--menuActiveColor); opacity: 1; }
.crumb.active { opacity: 1; font-weight: 600; cursor: default; }
.crumb-sep { font-size: 9px; opacity: 0.5; margin: 0 1px; flex-shrink: 0; }

/* ---- 搜索框（工具栏右上角） ---- */
.file-search {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 0 6px;
  height: 26px; /* 与 toolbar-btn 同高，不撑高工具栏 */
  box-sizing: border-box;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
}
.file-search i { font-size: 12px; opacity: 0.6; }
.file-search-input {
  /* 宽度随工具栏宽度收缩（宽面板 140px、窄面板收到 80px），把空间留给路径面包屑 */
  width: clamp(80px, 24cqw, 140px);
  height: 100%;
  margin: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--fontColor);
  font-size: 12px;
  padding: 0;
}
.file-search-input::placeholder { color: var(--borderColor); }
.file-search-clear { cursor: pointer; }
.file-search-clear:hover { opacity: 1; color: var(--fontActiveColor); }

/* 工具栏过窄（窗口很窄 / 左侧面板占位 / 与其它视图并排）时，收起导航按钮与路径面包屑，
   把宽度留给视图选择与搜索框；后退 / 前进 / 向上 仍可用快捷键（Alt+← / Alt+→ / Backspace）
   与双击文件树文件夹、点面包屑同一套导航 */
@container (max-width: 460px) {
  .file-nav-btns,
  .file-breadcrumb,
  .sep-nav {
    display: none;
  }
  /* 没有面包屑需要让位了：搜索框占满剩余位置（去掉与左侧控件之间的间隔） */
  .file-search {
    flex: 1 1 auto;
    min-width: 0;
    margin-left: 0;
  }
  .file-search-input {
    flex: 1 1 0%;
    width: auto;
    min-width: 0;
  }
}
</style>
