<script setup lang="ts">
import { usestore, THEMES } from '@/store'
import { onMounted, onBeforeUnmount, computed } from 'vue'
import { FILE_VIEWS as FILE_VIEWS_DEFS, FILE_VIEW_NAMES } from '@/lib/knowFile/fileViews'

const store = usestore()

// 国际化文本
// 是否有文件已选中
const hasFileSelected = computed(() => store.data.length > 0 && store.index != null)

const t = {
  // 工具栏
  openFolder: computed(() => store.locales === 'en' ? 'Open Folder' : '打开文件夹'),
  selectLanguage: computed(() => store.locales === 'en' ? 'Select Language' : '选择语言'),
  selectTheme: computed(() => store.locales === 'en' ? 'Select Theme' : '选择主题'),
  
  // 欢迎信息
  welcome: computed(() => store.locales === 'en' ? 'Welcome' : '欢迎使用'),
  selectFolderPrompt: computed(() => store.locales === 'en' 
    ? 'Select a folder to start your work' 
    : '选择一个文件夹开始您的工作'),
  selectViewPrompt: computed(() => store.locales === 'en'
    ? 'Please select a view to display the file'
    : '请选择视图来展示文件'),
  fileViewHint: computed(() => store.locales === 'en'
    ? 'Tip: use the Files view to open files'
    : '提示：建议使用「文件」视图打开文件'),
  
  // 视图名称
  views: {
    file: computed(() => store.locales === 'en' ? 'Files' : '文件'),
    gantt: computed(() => store.locales === 'en' ? 'Gantt' : '甘特'),
    kanban: computed(() => store.locales === 'en' ? 'Kanban' : '看板'),
    graph: computed(() => store.locales === 'en' ? 'Graph' : '图谱'),
    month: computed(() => store.locales === 'en' ? 'Month' : '月历'),
    year: computed(() => store.locales === 'en' ? 'Year' : '日历'),
    map: computed(() => store.locales === 'en' ? 'Map' : '地图'),
    table: computed(() => store.locales === 'en' ? 'Table' : '表格'),
    browser: computed(() => store.locales === 'en' ? 'Browse' : '浏览'),
    mindmap: computed(() => store.locales === 'en' ? 'Mind Map' : '思维导图'),
    presentation: computed(() => store.locales === 'en' ? 'Presentation' : '演示'),
    editor: computed(() => store.locales === 'en' ? 'Source' : '源码编辑'),
    blockEditor: computed(() => store.locales === 'en' ? 'Visual' : '可视编辑')
  }
}

onMounted(() => {})
onBeforeUnmount(() => {})

// 主题下拉选项：由 THEMES 映射表生成（追加「自定义」项，新增主题时下拉自动同步）
const themeOptions = computed(() => [...Object.keys(THEMES), '自定义'])
// 主题显示名（中文直接用主题名；英文用 THEMES 内置 labelEn，「自定义」为补充项）
const themeLabel = (th: string) => {
  if (store.locales === 'zh') return th
  return THEMES[th]?.labelEn || (th === '自定义' ? 'Custom' : th)
}

// 视图图标映射 — 支持 fa 和 iconfont 两种类型（文件视图图标取自 fileViews.ts）
interface ViewIcon { cls: string; content?: string }
const viewIconMap: Record<string, ViewIcon> = {
    '文件': { cls: 'fa fa-folder' },
    '图谱': { cls: 'iconfont', content: '\uE662' },
    '看板': { cls: 'fa fa-list-ul' },
    '甘特': { cls: 'iconfont', content: '\uE672' },
    '日历': { cls: 'fa fa-calendar' },
    '地图': { cls: 'iconfont', content: '\uE884' },
    '表格': { cls: 'fa fa-table' },
    ...Object.fromEntries(FILE_VIEWS_DEFS.map((v) => [v.name, { cls: v.icon }])),
}
const viewIcon = (name: string) => viewIconMap[name] || { cls: 'fa fa-eye' }
const viewIconContent = (name: string) => viewIcon(name).content || ''

// 视图标签映射（文件视图的中/英文名统一来自 fileViews.ts，其余复用 t.views）
const viewLabel = (name: string) => {
    const def = FILE_VIEWS_DEFS.find((v) => v.name === name)
    if (def) return store.locales === 'en' ? def.labelEn : def.name
    const keyMap: Record<string, keyof typeof t.views> = {
        '文件': 'file',
        '甘特': 'gantt',
        '看板': 'kanban',
        '图谱': 'graph',
        '日历': 'year',
        '地图': 'map',
        '表格': 'table',
    }
    const key = keyMap[name]
    return key ? t.views[key].value : name
}

// 视图分行
const viewRow1 = ['文件', '图谱', '看板', '甘特', '日历', '地图', '表格']
const viewRow2 = FILE_VIEW_NAMES

// 文件形式视图（随文件在标签/新窗口中打开，与全局视图分开管理）
const FILE_VIEWS = FILE_VIEW_NAMES
// 欢迎页视图按钮：新窗口打开模式下只显示 7 个全局视图（文件形式视图由独立窗口承担）；窗口内模式显示全部 12 个
const visibleViews = computed(() => {
  const all = [...viewRow1, ...viewRow2]
  if (store.UI.fileOpenMode === 'window') return all.filter(v => !FILE_VIEWS.includes(v))
  return all
})
</script>

<template>
  <div class="App_empty">
    <div class="panels-container">
      <!-- 主视图区域 -->
      <div class="main-panel">
        <div class="welcome-message">
          <template v-if="hasFileSelected && store.root">
            <i class="fa fa-th-large welcome-icon"></i>
            <h2>{{ t.welcome.value }}</h2>
            <p>{{ t.selectViewPrompt.value }}</p>
          </template>
          <template v-else>
            <i class="fa fa-folder-open welcome-icon"></i>
            <h2>{{ t.welcome.value }}</h2>
            <p>{{ t.selectFolderPrompt.value }}</p>
          </template>
          <!-- 建议使用文件视图打开（已选文件夹且欢迎页显示时直接提示，不依赖是否打开文件） -->
          <p v-if="store.root" class="file-view-hint">
            <i class="fa fa-folder-open-o"></i> {{ t.fileViewHint.value }}
          </p>
        </div>

        <!-- 视图按钮（新窗口打开模式下仅显示 7 个全局视图） -->
        <div class="views-container">
          <div class="views scoll">
            <template v-for="v in visibleViews" :key="v">
              <div class="view" @click="store.toggleView(v)" :class="{active:store.isView(v)}">
                <i :class="viewIcon(v).cls">{{ viewIconContent(v) }}</i>
                <span>{{ viewLabel(v) }}</span>
              </div>
            </template>
          </div>
        </div>

        <!-- 语言和主题设置 -->
        <div class="settings-row">
          <label>{{ t.selectLanguage.value }} <select v-model="store.locales" :title="t.selectLanguage.value">
            <option value="zh">中文</option>
            <option value="en">ENGLISH</option>
          </select></label>
          <label>{{ t.selectTheme.value }} <select v-model="store.UI.theme" @change="store.changeTheme()" :title="t.selectTheme.value">
            <!-- 主题选项由 THEMES 映射表生成（追加「自定义」），新增主题时下拉自动同步 -->
            <option v-for="th in themeOptions" :key="th" :value="th">
              {{ themeLabel(th) }}
            </option>
          </select></label>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.App_empty {
  flex: 1;
  width: 100%;
  height: 100%;
  background-color: var(--backgroundColor);
  overflow: hidden;
  user-select: none;
  display: flex;
  flex-direction: column;
}

/* 主面板 */
.panels-container {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.main-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 5px;
  gap: 5px;
}

.welcome-message {
  text-align: center;
  padding: 10px;
  border-radius: 12px;
  background: rgba(var(--menuColor), 0.05);
  border: 1px solid rgba(var(--borderColor), 0.3);
  max-width: 500px;
  width: 100%;
}

.welcome-icon {
  font-size: 48px;
  color: var(--accentColor);
  margin-bottom: 16px;
}

.welcome-message h2 {
  margin: 0 0 8px 0;
  color: var(--textColor);
  font-size: 24px;
}

.welcome-message p {
  margin: 0;
  color: var(--textSecondary);
  font-size: 14px;
  opacity: 0.8;
}

/* 建议使用文件视图打开 */
.file-view-hint {
  margin: 10px 0 0 0;
  color: var(--fontActiveColor);
  font-size: 13px;
  font-weight: 500;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  opacity: 0.95;
}
.file-view-hint i {
  font-size: 14px;
}

/* 视图容器 */
.views-container {
  width: 100%;
  max-width: 800px;
  margin: 0 auto;
}

.views {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
  padding: 5px;
  background: rgba(var(--menuColor), 0.05);
  border-radius: 12px;
}

.view {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 6px;
  border-radius: 5px;
  cursor: pointer;
  transition: all 0.2s ease;
  border: 1px solid transparent;
  background: rgba(var(--menuColor), 0.1);
  min-width: 50px
}

.view:hover {
  background-color: var(--menuColor);
  transform: translateY(-2px);
  border-color: var(--borderColor);
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
}

.view.active {
  background-color: var(--menuColor);
  color: var(--fontColor);
  border-color: var(--borderColor);
  box-shadow: 0 4px 12px rgba(var(--borderColor), 0.2);
}

.view.active:hover {
  background-color: var(--menuActiveColor);
}

.view i {
  font-size: 20px;
  margin-bottom: 6px;
}

.view i.iconfont {
  font-size: 18px;
}

.view span {
  font-size: 12px;
  font-weight: 500;
}

/* 设置行 - 居中显示 */
.settings-row {
  display: flex;
  gap: 16px;
  justify-content: center;
  align-items: center;
}

.settings-row label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--fontColor);
  white-space: nowrap;
}

.settings-row select {
  background-color: var(--backgroundColor);
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  padding: 4px 8px;
  color: var(--fontColor);
  font-size: 13px;
  cursor: pointer;
}

select{
  background-color: var(--backgroundColor);
}
/* 响应式调整 */
@media (max-width: 768px) {
  .views {
    grid-template-columns: repeat(4, 1fr);
    gap: 5px;
  }
  
  .main-panel {
    gap: 5px;
  }
}

</style>