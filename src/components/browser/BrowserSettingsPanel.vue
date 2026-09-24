<!-- src/components/browser/BrowserSettingsPanel.vue
     浏览器模块「设置」子组件（自包含样式，可在主应用「设置 → 通用 → 基础」页面
     与浏览器独立窗口右侧设置栏两处复用）：
       - 浏览器默认页面  browserHomeUrl（仅手动打开浏览器时首个标签加载；AI 调用不受影响）
       - 浏览器保存文件夹 browserSaveDir（离线保存整页 + 收藏书签落盘目录；留空=当前工作区根目录）
     数据直接读写 store.UI 并持久化（store.saveConfig），无需外部 props。 -->
<template>
  <div class="browser-settings-panel" :class="{ compact }">
    <!-- 浏览器默认页面 -->
    <div class="bs-row">
      <label class="bs-label">{{ zh ? '主页' : 'Home' }}</label>
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

    <!-- 浏览器保存文件夹（离线保存网页 + 收藏书签；留空回退当前工作区根目录） -->
    <div class="bs-row">
      <label class="bs-label">{{ zh ? '书签' : 'Bookmarks' }}</label>
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

const store = usestore()
const zh = computed(() => store.locales === 'zh')

// compact=true：紧凑布局（供浏览器右侧 300px 停靠栏使用：单行、隐藏整段说明）
const props = withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })

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

const hint = computed(() => zh.value
  ? '默认页面仅「手动打开浏览器」时生效；保存文件夹用于「离线保存整页」与「收藏书签」，留空则使用当前工作区。'
  : 'Home page applies only when opening the browser manually. Save folder is used by "Save full page" and bookmarks; empty falls back to the active workspace.')

// 选择保存文件夹（目录选择对话框；纯浏览器/LAN 模式无 IPC 时忽略）
const pickSaveDir = async () => {
  if (!window.ipcRenderer) return
  const dir = await window.ipcRenderer.invoke('openFolderDialog')
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
.bs-input {
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
.bs-input:focus {
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

/* 窄栏（浏览器右侧停靠栏 ~300px）：单行紧凑（短标签 + 控件同行） */
.browser-settings-panel.compact .bs-row {
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
.browser-settings-panel.compact .bs-label {
  flex: 0 0 40px;
  width: 40px;
  min-width: 40px;
  font-size: 12px;
  opacity: .9;
}
.browser-settings-panel.compact .bs-btn-group {
  align-items: center;
}
.browser-settings-panel.compact .bs-hint {
  display: none;
}
</style>
