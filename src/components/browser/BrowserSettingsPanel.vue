<!-- src/components/browser/BrowserSettingsPanel.vue
     浏览器模块「设置」面板（自包含样式，可在主应用「设置 → 其他 → 浏览器」页面
     与浏览器独立窗口右侧设置栏两处复用）：
       - 主页 browserHomeUrl（仅手动打开浏览器时首个标签加载；AI 调用不受影响）
       - 新标签页 browserNewTab（bookmarks=收藏夹网格 / blank=空白页）
       - 地址栏搜索引擎 browserSearchEngine + 自定义模板 browserSearchTemplate
         （新标签页不再自带搜索框，搜索并入地址栏）
       - 收藏夹文件夹 browserSaveDir（离线保存整页 + 收藏书签落盘目录；留空=当前工作区根目录）
       - 新标签页每行书签数 browserGridCols（0=按窗口宽度自动）
       - Markdown 剪藏目录 browserClipDir + 是否附带 YAML front matter browserClipFrontMatter
       - 允许 AI 执行 JS browserAllowEval（默认关闭，改后即刻下发主进程 browser_eval 开关）
     数据直接读写 store.UI 并持久化（store.saveConfig），无需外部 props。 -->
<template>
  <div class="browser-settings-panel" :class="{ compact }">
    <!-- 浏览器主页 -->
    <div class="bs-row">
      <label class="bs-label" :title="zh ? '主页' : 'Home'">{{ zh ? '主页' : 'Home' }}</label>
      <div class="bs-control">
        <input
          v-model="store.UI.browserHomeUrl"
          class="bs-input"
          type="text"
          spellcheck="false"
          :placeholder="zh ? '留空 = 空白页；可填 https://example.com' : 'Empty = blank page; e.g. https://example.com'"
          :title="zh ? '手动打开浏览器时首先加载该页面（AI 调用不受影响）' : 'Loaded first when opening the browser manually (AI calls unaffected)'"
          @change="save()"
          @keydown.enter.prevent="save()"
        />
      </div>
    </div>

    <!-- 新标签页内容 -->
    <div class="bs-row">
      <label class="bs-label" :title="zh ? '新标签页' : 'New tab'">{{ zh ? '新标签' : 'New tab' }}</label>
      <div class="bs-control">
        <select
          v-model="store.UI.browserNewTab"
          class="bs-select"
          :title="zh ? '新建标签页时显示的内容：收藏夹网格（默认）或空白页' : 'What a new tab shows: bookmark grid (default) or a blank page'"
          @change="save()"
        >
          <option value="bookmarks">{{ zh ? '收藏夹网格（推荐）' : 'Bookmark grid (recommended)' }}</option>
          <option value="blank">{{ zh ? '空白页' : 'Blank page' }}</option>
        </select>
      </div>
    </div>

    <!-- 地址栏搜索引擎（搜索栏已并入地址栏） -->
    <div class="bs-row">
      <label class="bs-label" :title="zh ? '搜索引擎' : 'Search engine'">{{ zh ? '搜索' : 'Search' }}</label>
      <div class="bs-control">
        <select
          v-model="store.UI.browserSearchEngine"
          class="bs-select"
          :title="zh ? '地址栏输入关键词时使用的搜索引擎（输入网址仍直接打开）' : 'Engine used when the address bar gets keywords (URLs still open directly)'"
          @change="save()"
        >
          <option v-for="e in searchEngines" :key="e.id" :value="e.id">{{ zh ? e.labelZh : e.labelEn }}</option>
        </select>
      </div>
    </div>

    <!-- 自定义搜索模板（仅自定义引擎） -->
    <div v-if="store.UI.browserSearchEngine === 'custom'" class="bs-row">
      <label class="bs-label" :title="zh ? '自定义模板' : 'Custom template'">{{ zh ? '模板' : 'Template' }}</label>
      <div class="bs-control">
        <input
          v-model="store.UI.browserSearchTemplate"
          class="bs-input"
          type="text"
          spellcheck="false"
          placeholder="https://example.com/search?q={q}"
          :title="zh ? '自定义搜索地址，用 {q} 占位关键词；留空或非法则回退必应' : 'Custom search URL with {q} as the query placeholder; invalid/empty falls back to Bing'"
          @change="save()"
          @keydown.enter.prevent="save()"
        />
      </div>
    </div>

    <!-- 收藏夹 / 保存文件夹（离线保存整页 + 收藏书签；留空回退当前工作区根目录） -->
    <div class="bs-row">
      <label class="bs-label" :title="zh ? '收藏夹文件夹' : 'Bookmark folder'">{{ zh ? '收藏夹' : 'Folder' }}</label>
      <div class="bs-control bs-btn-group">
        <input
          class="bs-input bs-path"
          type="text"
          readonly
          :value="pathLabel"
          :title="saveDir ? saveDir : (zh ? '未单独设置，保存到当前工作区根目录' : 'Not set; save to active workspace root')"
          :placeholder="zh ? '未设置（使用当前工作区）' : 'Not set (use active workspace)'"
        />
        <button
          class="bs-btn"
          :title="zh ? '选择保存文件夹（离线保存整页与收藏书签都存到这里）' : 'Choose save folder (offline pages & bookmarks go here)'"
          @click="pickSaveDir"
        >
          <i class="fa fa-folder-open"></i>
        </button>
        <button
          v-if="saveDir"
          class="bs-btn"
          :title="zh ? '恢复默认：保存到当前工作区根目录' : 'Reset: save to active workspace root'"
          @click="clearSaveDir"
        >
          <i class="fa fa-eraser"></i>
        </button>
      </div>
    </div>

    <!-- 新标签页每行书签数 -->
    <div class="bs-row">
      <label class="bs-label" :title="zh ? '每行书签数' : 'Bookmarks per row'">{{ zh ? '每行' : 'Per row' }}</label>
      <div class="bs-control">
        <select
          v-model.number="store.UI.browserGridCols"
          class="bs-select"
          :title="zh ? '新标签页收藏夹网格每行显示几个（自动=按窗口宽度铺满）' : 'Bookmarks per row on the new tab grid (Auto = fill by window width)'"
          @change="save()"
        >
          <option :value="0">{{ zh ? '自动' : 'Auto' }}</option>
          <option v-for="n in gridColOptions" :key="n" :value="n">{{ n }}</option>
        </select>
      </div>
    </div>

    <!-- Markdown 剪藏：落点子目录（相对知识库根目录） -->
    <div class="bs-row">
      <label class="bs-label" :title="zh ? 'Markdown 剪藏目录（知识库根目录下的子文件夹）' : 'Markdown clip folder (subfolder of the knowledge base root)'">{{ zh ? '剪藏' : 'Clip to' }}</label>
      <div class="bs-control">
        <input
          v-model="store.UI.browserClipDir"
          class="bs-input"
          type="text"
          spellcheck="false"
          :placeholder="zh ? '网页剪藏（留空=知识库根目录）' : 'web-clips (empty = knowledge base root)'"
          :title="zh ? '「页面操作 → 保存 Markdown 到知识库」的落点：知识库根目录下的子文件夹名；留空则直接存到根目录' : 'Target of “Page actions → Save Markdown to knowledge base”: a subfolder of the knowledge base root; empty = root itself'"
          @change="save()"
          @keydown.enter.prevent="save()"
        />
      </div>
    </div>

    <!-- 剪藏文件是否附带 YAML front matter -->
    <div class="bs-row">
      <label class="bs-label" :title="zh ? 'YAML front matter（标题/来源/时间）' : 'YAML front matter (title / source / time)'">{{ zh ? '元数据' : 'Meta' }}</label>
      <div class="bs-control bs-switch-row">
        <span v-if="!compact" class="bs-switch-desc">{{ zh ? '剪藏文件带 YAML 头（标题 / 来源 / 剪藏时间），便于知识库视图与检索识别' : 'Add a YAML header (title / source / clipped time) for views and retrieval' }}</span>
        <span class="bs-switch" :class="{ on: store.UI.browserClipFrontMatter !== false }" role="switch"
          :aria-checked="store.UI.browserClipFrontMatter !== false"
          :title="zh ? (store.UI.browserClipFrontMatter !== false ? '已开启：剪藏 Markdown 带 YAML 头（点击关闭）' : '已关闭：剪藏 Markdown 只有正文（点击开启）') : (store.UI.browserClipFrontMatter !== false ? 'On: clipped Markdown gets a YAML header (click to disable)' : 'Off: body only (click to enable)')"
          @click="toggleFrontMatter">
          <span class="bs-switch-knob"></span>
        </span>
      </div>
    </div>

    <!-- AI 控制：允许 browser_eval 执行任意 JS（持久化设置；默认关闭） -->
    <div class="bs-row">
      <label class="bs-label" :title="zh ? '允许 AI 执行 JavaScript' : 'Allow AI JavaScript'">{{ zh ? '脚本' : 'Run JS' }}</label>
      <div class="bs-control bs-switch-row">
        <span v-if="!compact" class="bs-switch-desc">{{ zh ? '允许 AI 调用 browser_eval 在页面中执行任意 JavaScript（默认关闭，有风险）' : 'Allow the AI to run arbitrary JavaScript via browser_eval (off by default, risky)' }}</span>
        <span class="bs-switch" :class="{ on: allowEval }" role="switch" :aria-checked="allowEval"
          :title="zh ? (allowEval ? '已允许 AI 执行 JS（点击关闭）' : '允许 AI 调用 browser_eval 执行任意 JS（默认关闭，点击开启）') : (allowEval ? 'AI JavaScript allowed (click to disable)' : 'Allow AI to run browser_eval JavaScript (click to enable)')"
          @click="toggleAllowEval">
          <span class="bs-switch-knob"></span>
        </span>
      </div>
    </div>

    <!-- 顶部工具栏图标开关：收藏夹 / 下载 / 历史 -->
    <div class="bs-row">
      <label class="bs-label" :title="zh ? '顶部图标' : 'Toolbar icons'">{{ zh ? '图标' : 'Icons' }}</label>
      <div class="bs-control bs-switch-row bs-icons-row">
        <button class="bs-icon-toggle" :class="{ on: store.UI.browserShowBookmarks !== false }"
          :title="zh ? '显示/隐藏「收藏夹」图标' : 'Show/hide the bookmarks icon'"
          @click="toggleIcon('browserShowBookmarks')">
          <i class="fa fa-tag"></i><span>{{ zh ? '收藏夹' : 'Bookmarks' }}</span>
        </button>
        <button class="bs-icon-toggle" :class="{ on: store.UI.browserShowDownloads !== false }"
          :title="zh ? '显示/隐藏「下载」图标' : 'Show/hide the downloads icon'"
          @click="toggleIcon('browserShowDownloads')">
          <i class="fa fa-download"></i><span>{{ zh ? '下载' : 'Downloads' }}</span>
        </button>
        <button class="bs-icon-toggle" :class="{ on: store.UI.browserShowHistory !== false }"
          :title="zh ? '显示/隐藏「历史」图标' : 'Show/hide the history icon'"
          @click="toggleIcon('browserShowHistory')">
          <i class="fa fa-history"></i><span>{{ zh ? '历史' : 'History' }}</span>
        </button>
      </div>
    </div>

    <!-- 说明仅在宽版（主应用设置页）显示；紧凑侧栏改为 title 悬浮提示 -->
    <div v-if="!compact" class="bs-hint">
      <i class="fa fa-info-circle"></i>
      <span>{{ hint }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { usestore } from '@/store'
import { getPlatform, hasCapability } from '@/platform'
import { BROWSER_SEARCH_ENGINES } from '@/shared/browserSearch'

const store = usestore()
const zh = computed(() => store.locales === 'zh')

// compact=true：紧凑布局（供浏览器右侧 320px 停靠栏使用：单行、隐藏整段说明）
const props = withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })

const searchEngines = BROWSER_SEARCH_ENGINES
const gridColOptions = [4, 5, 6, 7, 8, 10]

const saveDir = computed(() => (store.UI.browserSaveDir || '').trim())

const save = () => { store.saveConfig() }

/** 短路径显示：仅在紧凑侧栏(compact)把长路径截为「…/末两级」便于窄栏识别；宽版显示完整路径，完整路径始终放 title */
const pathLabel = computed(() => {
  const p = saveDir.value
  if (!p) return ''
  if (!props.compact) return p
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  if (parts.length <= 2) return p
  return '…/' + parts.slice(-2).join('/')
})

const allowEval = computed(() => store.UI.browserAllowEval === true)

/** 顶部工具栏图标开关（纯渲染层设置，浏览器窗口下次渲染/重开即生效） */
const toggleIcon = (key: 'browserShowBookmarks' | 'browserShowDownloads' | 'browserShowHistory') => {
  store.UI[key] = store.UI[key] === false
  store.saveConfig()
}

/** 剪藏 YAML 头开关（纯渲染层设置，下次剪藏生效） */
const toggleFrontMatter = () => {
  store.UI.browserClipFrontMatter = store.UI.browserClipFrontMatter === false
  store.saveConfig()
}

/** 允许 AI 执行 JS：持久化到 store.UI，并立即下发主进程（browser_eval 开关的唯一事实源在主进程） */
const toggleAllowEval = async () => {
  store.UI.browserAllowEval = !allowEval.value
  store.saveConfig()
  await getPlatform().browserAgent.call('set-eval', { enabled: store.UI.browserAllowEval }).catch(() => {})
}

const hint = computed(() => zh.value
  ? '主页仅「手动打开浏览器」时生效；收藏夹文件夹用于「离线保存整页」与「收藏书签」，留空则用当前工作区。搜索栏已并入地址栏：输入网址直接打开，输入关键词用所选引擎搜索。'
  : 'Home page applies only when opening the browser manually. The bookmark folder is used by "Save full page" and bookmarks; empty falls back to the active workspace. Search lives in the address bar: URLs open directly, keywords use the selected engine.')

// 选择保存文件夹（目录选择对话框；纯浏览器/LAN 模式无 IPC 时忽略）
const pickSaveDir = async () => {
  if (!hasCapability('dialog.native')) return
  const dir = await getPlatform().dialog.pickDirectory()
  if (dir && typeof dir === 'string') {
    store.UI.browserSaveDir = dir
    store.saveConfig()
  }
}

// 恢复默认：使用当前工作区根目录
const clearSaveDir = () => {
  store.UI.browserSaveDir = ''
  store.saveConfig()
}
</script>

<style scoped>
.browser-settings-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bs-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.bs-label {
  flex: 0 0 60px;
  width: 60px;
  min-width: 60px;
  color: var(--fontColor);
  font-size: 14px;
  line-height: 1;
  user-select: none;
}
.bs-control {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: stretch;
  gap: 5px;
}
.bs-input,
.bs-select {
  flex: 1;
  min-width: 0;
  height: 30px;
  box-sizing: border-box;
  padding: 2px 6px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--menuColor);
  color: var(--fontColor);
  font-size: 13px;
  transition: border-color .2s ease;
  margin: 0px
}
.bs-select { cursor: pointer; }
.bs-input:focus,
.bs-select:focus {
  outline: none;
  border-color: var(--fontActiveColor);
}
.bs-path {
  cursor: default;
  margin: 0px
}
.bs-btn {
  flex: 0 0 auto;
  min-width: 30px;
  height: 30px;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 8px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--menuColor);
  color: var(--fontColor);
  font-size: 13px;
  cursor: pointer;
  transition: all .15s;
}
.bs-btn:hover {
  color: var(--fontActiveColor);
  border-color: var(--fontActiveColor);
  background-color: color-mix(in srgb, var(--fontActiveColor) 8%, var(--menuColor));
}
/* 开关行（元数据 / 允许执行 JS）：说明文字占左侧，开关固定右侧 */
.bs-switch-row {
  align-items: center;
  justify-content: space-between;
}
.bs-switch-desc {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--fontColor);
  opacity: .7;
}
.bs-switch {
  flex: 0 0 auto;
  width: 34px;
  height: 18px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--fontColor) 22%, transparent);
  position: relative;
  cursor: pointer;
  transition: background .15s;
}
.bs-switch.on { background: var(--fontActiveColor); }
.bs-switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  transition: left .15s;
  box-shadow: 0 1px 3px rgba(0, 0, 0, .25);
}
.bs-switch.on .bs-switch-knob { left: 18px; }
/* 工具栏图标开关（收藏夹/下载/历史） */
.bs-icons-row {
  justify-content: flex-start;
  flex-wrap: wrap;
  gap: 4px;
}
.bs-icon-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--borderColor);
  border-radius: 12px;
  background: transparent;
  color: var(--fontColor);
  font-size: 11px;
  cursor: pointer;
  opacity: .55;
  transition: all .15s;
}
.bs-icon-toggle i { font-size: 11px; }
.bs-icon-toggle.on {
  opacity: 1;
  color: var(--fontActiveColor);
  border-color: color-mix(in srgb, var(--fontActiveColor) 45%, transparent);
  background: color-mix(in srgb, var(--fontActiveColor) 8%, transparent);
}
.browser-settings-panel.compact .bs-icons-row { justify-content: flex-start; }

.bs-hint {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  margin: 0 2px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--fontColor);
  opacity: .65;
}
.bs-hint i {
  margin-top: 2px;
}

/* 窄栏（浏览器右侧停靠栏 ~320px）：单行紧凑（短标签 + 控件同行） */
.browser-settings-panel.compact .bs-row {
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
.browser-settings-panel.compact .bs-label {
  flex: 0 0 52px;
  width: 52px;
  min-width: 52px;
  font-size: 12px;
  opacity: .9;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.browser-settings-panel.compact .bs-input,
.browser-settings-panel.compact .bs-select,
.browser-settings-panel.compact .bs-btn {
  height: 26px;
  font-size: 12px;
}
.browser-settings-panel.compact .bs-btn { min-width: 26px; padding: 0 6px; }
.browser-settings-panel.compact .bs-btn-group {
  align-items: center;
}
.browser-settings-panel.compact .bs-switch-row { justify-content: flex-end; }
.browser-settings-panel.compact .bs-hint {
  display: none;
}
</style>
