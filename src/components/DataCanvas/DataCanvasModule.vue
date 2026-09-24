<!-- DataCanvasModule.vue - 数据画布模块主入口
     作为 agent 脚手架的子模块，提供数据建模 / 数据录入 / 主页（看板）能力。
     接口：
       Props  : mode / config / data
       Events : save / load / change / chart-click / error
       Expose : getModel / getModels / importData / exportData / reset / refresh -->
<template>
  <div class="dc-module" :class="`dc-theme-${store.config.theme}`">
    <!-- ====== 顶部：标题 + 标签页（外部控制时不渲染，避免与宿主顶栏/画布工具栏重复） ====== -->
    <div v-if="!externalTab" class="dc-module-head">

      <!-- 全模式：三个标签页（顺序：主页 / 数据 / 画布） -->
      <div v-if="mode === 'full'" class="dc-module-tabs">
        <button class="dc-module-tab" :class="{ active: activeTab === 'dashboard' }" @click="setTab('dashboard')">
          <i class="fa fa-home"></i> {{ t('主页') }}
        </button>
        <button class="dc-module-tab" :class="{ active: activeTab === 'entry' }" @click="setTab('entry')">
          <i class="fa fa-edit"></i> {{ t('数据') }}
        </button>
        <button class="dc-module-tab" :class="{ active: activeTab === 'canvas' }" @click="setTab('canvas')">
          <i class="fa fa-object-group"></i> {{ t('画布') }}
        </button>
        <button class="dc-module-tab" :class="{ active: activeTab === 'help' }" @click="setTab('help')">
          <i class="fa fa-book"></i> {{ t('帮助') }}
        </button>
      </div>

      <!-- 画布标签：工具栏提升到标签栏右侧（面包屑/保存/连线/缩放/计算/导入导出） -->
      <div v-if="activeTab === 'canvas'" class="dc-module-canvas-toolbar">
        <div class="dc-toolbar-left">
          <div class="dc-breadcrumb">
            <span class="dc-crumb" @click="canvasGoRoot()"><i class="fa fa-home"></i> {{ t('根画布') }}</span>
            <template v-for="(p, idx) in canvasCrumbs.slice(1)" :key="p.id">
              <span class="dc-crumb-sep"><i class="fa fa-angle-right"></i></span>
              <span class="dc-crumb" :class="{ active: idx === canvasCrumbs.length - 2 }" @click="canvasGoTo(p.id)">
                <i class="fa fa-cubes"></i> {{ p.name }}
              </span>
            </template>
          </div>
        </div>
        <div class="dc-toolbar-right">
          <div class="dc-seg">
            <button class="dc-btn" :class="{ active: !canvasConnectMode }" @click="canvasConnectMode = false" :title="t('选择/拖拽模式')"><i class="fa fa-arrows"></i></button>
            <button class="dc-btn" :class="{ active: canvasConnectMode }" @click="canvasToggleConnect()" :title="t('连线模式')"><i class="fa fa-share-alt"></i></button>
          </div>
          <select v-model="canvasEdgeType" class="dc-select dc-inline" :title="t('连线类型')">
            <option v-for="et in EDGE_TYPES" :key="et" :value="et">{{ EDGE_TYPE_META[et].label }}</option>
          </select>
          <button class="dc-btn" :class="{ active: canvasSnap }" @click="canvasSnap = !canvasSnap" :title="t('吸附网格')"><i class="fa fa-magnet"></i></button>
          <div class="dc-seg">
            <button class="dc-btn" @click="canvasZoomBy(1.2)" :title="t('放大')"><i class="fa fa-search-plus"></i></button>
            <button class="dc-btn" @click="canvasZoomBy(1 / 1.2)" :title="t('缩小')"><i class="fa fa-search-minus"></i></button>
            <button class="dc-btn" @click="canvasResetView()" :title="t('重置视图')"><i class="fa fa-home"></i></button>
            <span class="dc-zoom-label">{{ canvasZoom }}%</span>
          </div>
          <button class="dc-btn dc-btn-primary" @click="canvasRun()" :title="t('重新计算')"><i class="fa fa-play"></i></button>
          <button class="dc-btn" @click="saveToTaskFile()" :title="linkedFileTitle"><i class="fa fa-save"></i></button>
          <template v-if="canvasShowIE">
            <button class="dc-btn" @click="canvasExport()" :title="t('导出')"><i class="fa fa-download"></i></button>
            <button class="dc-btn" @click="canvasImport()" :title="t('导入')"><i class="fa fa-folder-open"></i></button>
          </template>
        </div>
      </div>
      <!-- 主页模式下：模式切换按钮（仅图标，位于标签页右侧；文字由 title 提示） -->
      <div v-if="activeTab === 'dashboard'" class="dc-module-dash-actions">
        <button class="dc-btn dc-icon-btn" :class="{ active: dashMode === 'flow' }" :title="t('顺序排列')" @click="callDashMode('flow')">
          <i class="fa fa-th-large"></i>
        </button>
        <button class="dc-btn dc-icon-btn" :class="{ active: dashMode === 'free' }" :title="t('自定义拖放')" @click="callDashMode('free')">
          <i class="fa fa-arrows-alt"></i>
        </button>
        <button v-if="dashMode === 'free'" class="dc-btn dc-icon-btn" :title="t('恢复布局')" @click="callResetLayout">
          <i class="fa fa-refresh"></i>
        </button>
        <button
          v-if="dashMode === 'free'"
          class="dc-btn dc-icon-btn"
          :class="{ active: dashLocked }"
          :title="dashLocked ? t('解锁') : t('锁定')"
          @click="callToggleLock"
        >
          <i class="fa" :class="dashLocked ? 'fa-lock' : 'fa-unlock'"></i>
        </button>
      </div>

      <!-- 主页/数据标签：导入/导出（数据编辑已实时自动持久化，无需手动保存） -->
      <div v-if="activeTab !== 'canvas' && activeTab !== 'help'" class="dc-module-actions">
        <span v-if="store.activeModel.value" class="dc-model-badge">{{ store.activeModel.value.name }}</span>
        <button v-if="store.config.showImportExport" class="dc-btn" :title="t('导入')" @click="moduleImportInput?.click()"><i class="fa fa-folder-open"></i></button>
        <button v-if="store.config.showImportExport" class="dc-btn" :title="t('导出全部')" @click="handleExport"><i class="fa fa-download"></i></button>
      </div>
    </div>

    <!-- ====== 视图区 ====== -->
    <div class="dc-module-body">
      <CanvasView v-if="showCanvas" ref="canvasRef" class="dc-view" :hide-toolbar="true" @save="handleSave" />
      <EntryView v-else-if="showEntry" class="dc-view" />
      <DashboardView v-else-if="showDashboard" ref="dashRef" class="dc-view" :hide-toolbar="true" @chart-click="onChartClick" @update:dashMode="onDashModeChange" @update:dashLocked="onDashLockedChange" />
      <!-- ====== 帮助页（与其它脚手架一致，最右侧页签） ====== -->
      <div v-else-if="activeTab === 'help'" class="dc-module-help">
        <div class="dc-help-body scoll">
          <h3>{{ t('数据画布') }}</h3>
          <h4>{{ isEn ? 'Use Cases' : '使用场景' }}</h4>
          <p>{{ isEn ? scenarioEn : scenarioZh }}</p>
          <p>{{ isEn ? 'Steps:' : '使用步骤：' }}</p>
          <ol>
            <li v-for="(s, i) in (isEn ? helpEn : helpZh)" :key="i">{{ s }}</li>
          </ol>
          <h4>{{ isEn ? 'Notes' : '说明' }}</h4>
          <ul>
            <li v-for="(s, i) in (isEn ? noteEn : noteZh)" :key="i">{{ s }}</li>
          </ul>
        </div>
      </div>
    </div>

    <!-- 数据包导入 input（主页/数据页使用） -->
    <input ref="moduleImportInput" type="file" accept=".data,.json" style="display:none" @change="handleModuleImport" />
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'DataCanvasModule' })
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import { useDataCanvas } from '@/components/DataCanvas/store'
import { usestore } from '@/store'
import { useInstanceTaskFile } from '@/composables/useInstanceTaskFile'
import CanvasView from '@/components/DataCanvas/CanvasView.vue'
import EntryView from '@/components/DataCanvas/EntryView.vue'
import DashboardView from '@/components/DataCanvas/DashboardView.vue'
import type { ViewMode, DcConfig, DcSaveEvent, DcChartClick, Model } from '@/components/DataCanvas/types'
import { EDGE_TYPES, EDGE_TYPE_META } from '@/components/DataCanvas/types'

// ==================== Props ====================
const props = withDefaults(defineProps<{
  mode?: ViewMode
  config?: DcConfig
  data?: { models?: Model[]; activeModelId?: string }
  externalTab?: 'canvas' | 'entry' | 'dashboard'
  /** 实例上下文（由 AgentScaffold 传入；独立使用时为空） */
  instanceId?: string
  taskFilePath?: string
}>(), {
  mode: 'full',
  config: () => ({}),
  data: () => ({}),
})

// ==================== Events ====================
const emit = defineEmits<{
  (e: 'save', data: DcSaveEvent): void
  (e: 'load', data: { modelId: string }): void
  (e: 'change', data: { type: 'node' | 'edge' | 'data' | 'model'; payload: any }): void
  (e: 'chart-click', data: DcChartClick): void
  (e: 'error', data: { code: string; message: string }): void
  (e: 'update:externalTab', tab: 'canvas' | 'entry' | 'dashboard'): void
  /** 脚手架内部对话框选中文件后回传路径，供宿主写入实例 meta */
  (e: 'link-file', path: string): void
  /** 关联任务文件不可用（被移动/删除） */
  (e: 'file-missing', path: string): void
  /** 已保存到关联文件 */
  (e: 'file-saved', path: string): void
}>()

// ==================== Store ====================
const store = useDataCanvas()
const hostStore = usestore()
const isEn = computed(() => hostStore.locales === 'en')
// 少量文案双语翻译表（其余内部文案默认返回中文原文）
const L: Record<string, string> = {
  '数据画布': 'Canvas',
  '主页': 'Home',
  '数据': 'Data',
  '画布': 'Canvas',
  '保存': 'Save',
  '智能录入': 'Smart Entry',
  '顺序排列': 'Flow',
  '自定义拖放': 'Free Layout',
  '恢复布局': 'Reset Layout',
  '锁定': 'Lock',
  '解锁': 'Unlock',
  '帮助': 'Help',
}
function t(zh: string): string { return isEn.value ? (L[zh] || zh) : zh }

// ====== 帮助文案（避免 {{}} 与 Vue 模板冲突，放脚本里） ======
const helpZh = [
  '在「画布」页新建节点（数据表 / 参数 / SQL / 变量 / 子画布），把来自不同表的数据编排成数据流模型。',
  '连线：从节点右侧输出端口拖到另一节点左侧输入端口；选择「连线类型」——数据流（参与计算）/ 表关联 / 暴露。',
  '选中节点可在右侧属性面板编辑：数据表维护列与数据，SQL 节点可写 SQL 或让模型按自然语言生成，变量用公式引用上游输出。',
  '点顶部「▶ 重新计算」按连线顺序自动求值；子画布用于组织大模型，把子画布内节点「暴露到外部」即可在父级生成输出端口。',
  '「数据」页集中录入各参数 / 表格节点的值，「主页」看板自动展示所有图表节点。',
]
const helpEn = [
  'Create nodes in the Canvas tab (data table / parameter / SQL / variable / sub-canvas) and arrange them into a dataflow model.',
  'Connect: drag from an output port (right) to an input port (left); pick the edge type — dataflow (computed) / relation / expose.',
  'Select a node to edit it in the inspector: tables manage columns and data, SQL nodes accept SQL or natural-language generation, variables reference upstream outputs by formula.',
  'Click Run (top right) to recompute in topology order; use sub-canvases to organize big models and expose inner nodes to get ports in the parent.',
  'The Data tab centralizes value entry for parameters/table nodes; the Home dashboard shows every chart node automatically.',
]
const noteZh = [
  '只有通过数据流连线连接的节点才参与计算；relation / expose 属于说明性连线。',
  '数据表可导入 Excel，也支持把 .data / .xlsx 直接拖入画布（多 sheet 会逐个建表）。',
  '主页看板支持 Flow（自动排列）与 Free（自由拖放 + 锁定布局）两种模式。',
  '画布内容实时自动持久化；可导出 .data 数据包以复用。',
]
const noteEn = [
  'Only nodes connected by dataflow edges are computed; relation and expose edges are descriptive.',
  'Tables can import Excel; drag .data / .xlsx onto the canvas to import (multi-sheet files create one table per sheet).',
  'The dashboard supports Flow (auto layout) and Free (drag & lock) modes.',
  'Canvas content persists automatically; export a .data package to reuse elsewhere.',
]
// 使用场景（采集 → 汇总 → 分析 → 可视化）
const scenarioZh = '把采集 / 汇总来的多张原始表继续做建模与分析：对来自不同单位、不同系统的表进行关联、清洗与二次计算（SQL / 变量 / 公式），用数据流与子画布组织复杂汇总口径，并自动产出图表看板——支撑从「采集 → 汇总 → 分析 → 可视化」的完整数据工作流。'
const scenarioEn = 'Model and analyze the tables aggregated from collection: relate, clean and recompute heterogeneous tables from different units or systems (SQL / variables / formulas), organize complex metrics with dataflows and sub-canvases, and auto-build chart dashboards — powering an end-to-end collect, aggregate, analyze and visualize workflow.'

// ==================== 标签页控制（外部优先） ====================
const activeTab = computed<'canvas' | 'entry' | 'dashboard' | 'help'>(
  () => props.externalTab ?? store.internalTab.value,
)

function setTab(tab: 'canvas' | 'entry' | 'dashboard' | 'help') {
  if (props.externalTab) {
    // help 仅在内部模式（无外部控制）可选，外部只接受三种主视图
    emit('update:externalTab', tab as 'canvas' | 'entry' | 'dashboard')
  } else {
    store.internalTab.value = tab
  }
}

// ==================== 主页模式按钮（渲染在标签栏右侧，通过 ref 调用 DashboardView） ====================
const dashRef = ref<InstanceType<typeof DashboardView> | null>(null)
const dashMode = ref<'flow' | 'free'>('flow')
const dashLocked = ref(false)

// ==================== 画布工具栏（提升到标签栏右侧，通过 canvasRef 操作 CanvasView） ====================
const canvasRef = ref<InstanceType<typeof CanvasView> | null>(null)
const canvasConnectMode = computed({
  get: () => canvasRef.value?.connectMode ?? false,
  set: (v: boolean) => { if (canvasRef.value) canvasRef.value.connectMode = v },
})
const canvasEdgeType = computed({
  get: () => canvasRef.value?.pendingEdgeType ?? 'dataflow',
  set: (v: string) => { if (canvasRef.value) canvasRef.value.pendingEdgeType = v as any },
})
const canvasSnap = computed({
  get: () => canvasRef.value?.snapToGrid ?? false,
  set: (v: boolean) => { if (canvasRef.value) canvasRef.value.snapToGrid = v },
})
const canvasZoom = computed(() => Math.round((canvasRef.value?.view?.k ?? 1) * 100))
const canvasCrumbs = computed(() => canvasRef.value?.crumbPath ?? [])
const canvasShowIE = computed(() => !!store.config.showImportExport)
function canvasRun() { canvasRef.value?.run() }
function canvasZoomBy(f: number) { canvasRef.value?.zoomBy(f) }
function canvasResetView() { canvasRef.value?.resetView() }
function canvasToggleConnect() { canvasRef.value?.toggleConnect() }
function canvasExport() { canvasRef.value?.exportModel() }
function canvasImport() { canvasRef.value?.triggerImport() }
function canvasGoRoot() { canvasRef.value?.navigateRoot() }
function canvasGoTo(id: string) { canvasRef.value?.goTo(id) }
function onDashModeChange(m: 'flow' | 'free') { dashMode.value = m }
function onDashLockedChange(v: boolean) { dashLocked.value = v }
function callDashMode(mode: 'flow' | 'free') {
  if (activeTab.value !== 'dashboard') setTab('dashboard')
  nextTick(() => dashRef.value?.setDashboardMode(mode))
}
function callResetLayout() {
  if (activeTab.value !== 'dashboard') setTab('dashboard')
  nextTick(() => dashRef.value?.resetFreeLayout())
}
function callToggleLock() {
  if (activeTab.value !== 'dashboard') setTab('dashboard')
  nextTick(() => dashRef.value?.toggleDashboardLock())
}

// ==================== 显示逻辑 ====================
const showCanvas = computed(() =>
  props.mode === 'canvas' || activeTab.value === 'canvas',
)
const showEntry = computed(() =>
  props.mode === 'entry' || activeTab.value === 'entry',
)
const showDashboard = computed(() =>
  props.mode === 'dashboard' || activeTab.value === 'dashboard',
)

// ==================== 宿主通知转发 ====================
let offChange: (() => void) | null = null

// ==================== 实例关联任务文件（.task 即画布存储格式） ====================
const { saveTaskState: saveTaskStateToFile, saveToFile, loadFromFile } = useInstanceTaskFile({
  scaffold: 'canvas',
  filePath: () => props.taskFilePath || '',
  instanceId: () => props.instanceId || 'canvas',
  // 画布没有长耗时任务：内容自动保存，无需“运行中不加载”保护
  isBusy: () => false,
  collect: () => ({ models: JSON.parse(JSON.stringify(store.models.value)), activeModelId: store.activeModelId.value }),
  apply: async (state: any) => {
    await store.importData({ models: state.models || [], activeModelId: state.activeModelId || '' })
  },
  log: (level, message) => {
    if (level === 'error') ElMessage.error(message)
    else if (level === 'warning') ElMessage.warning(message)
  },
  onFileMissing: (path) => emit('file-missing', path),
  onSaved: (path) => emit('file-saved', path),
})

/** 工具栏保存按钮的 title（显示关联文件路径） */
const linkedFileTitle = computed(() => props.taskFilePath
  ? (isEn.value ? 'Save to task file: ' : '保存到任务文件：') + props.taskFilePath
  : (isEn.value ? 'Save (no linked task file yet)' : '保存（尚未关联任务文件）'))

/** 手动保存到关联文件（工具栏按钮） */
const saveToTaskFile = async () => {
  const ok = await saveTaskStateToFile()
  if (ok) ElMessage.success(isEn.value ? 'Canvas saved to task file' : '画布已保存到任务文件')
}

/** 画布变更 → 防抖自动保存到关联文件（对齐现有实时持久化体验） */
let taskFileSaveTimer: ReturnType<typeof setTimeout> | null = null
const scheduleTaskFileSave = () => {
  if (!props.taskFilePath) return
  if (taskFileSaveTimer) clearTimeout(taskFileSaveTimer)
  taskFileSaveTimer = setTimeout(() => { void saveTaskStateToFile() }, 1500)
}

function onStoreChange(e: { type: 'node' | 'edge' | 'data' | 'model'; payload: any }) {
  emit('change', e)
  scheduleTaskFileSave()
}

// ==================== 事件处理 ====================
function handleSave() {
  emit('save', { model: store.activeModel.value, models: store.models.value })
  store.persist()
  if (store.activeModelId.value) emit('load', { modelId: store.activeModelId.value })
}

function handleExport() {
  const blob = new Blob([JSON.stringify({ models: store.models.value, activeModelId: store.activeModelId.value }, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `data-canvas-export.data`
  a.click()
  URL.revokeObjectURL(url)
}

// ==================== 数据包导入（主页/数据页） ====================
const moduleImportInput = ref<HTMLInputElement | null>(null)
async function handleModuleImport(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const text = await file.text()
    const data = JSON.parse(text)
    await store.importData(data)
    ElMessage.success('数据包已导入')
  } catch (err: any) {
    ElMessage.error('导入失败: ' + (err?.message || String(err)))
  }
}

function onChartClick(data: DcChartClick) {
  emit('chart-click', data)
}

// ==================== Expose ====================
function getModel(): Model | null {
  return store.activeModel.value
}
function getModels(): Model[] {
  return store.models.value
}
async function importData(data: any): Promise<void> {
  await store.importData(data)
}
async function exportData(): Promise<any> {
  return store.exportData()
}
function reset(): void {
  store.resetAll()
}
function refresh(): void {
  store.refresh()
}

defineExpose({
  getModel,
  getModels,
  importData,
  exportData,
  reset,
  refresh,
  /** 导航栏「保存全部」：静默覆盖写关联任务文件（画布平时也会防抖自动保存） */
  saveTaskState: () => saveToFile(),
  /** 「数据画布」面板：打开 .task 时显式加载（宿主消费 store.canvasPathToOpen 后调用） */
  loadFromFile: (path: string) => loadFromFile(path),
  /** 关闭实例时的清理（宿主导航栏调用）：清掉待执行的自动保存定时器 */
  dispose: () => { if (taskFileSaveTimer) { clearTimeout(taskFileSaveTimer); taskFileSaveTimer = null } },
})

// ==================== 生命周期 ====================
onMounted(async () => {
  try {
    store.setConfig(props.config)
    store.viewMode.value = props.mode
    // 外部传入数据优先于本地存储
    const initial = props.data?.models?.length
      ? { models: props.data.models, activeModelId: props.data.activeModelId }
      : (props.config?.initialData ?? undefined)
    await store.init(initial)
    offChange = store.onChange(onStoreChange)
    if (store.activeModelId.value) emit('load', { modelId: store.activeModelId.value })
  } catch (err: any) {
    emit('error', { code: 'INIT_FAILED', message: err?.message || String(err) })
  }
})

onBeforeUnmount(() => {
  offChange?.()
})
</script>

<style scoped>
/* ====== 数据画布模块（dc- 前缀，样式隔离，参照主系统 CSS 变量） ====== */
.dc-module {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 12px;
  overflow: hidden;
}
.dc-theme-light { color-scheme: light; }
.dc-theme-dark { color-scheme: dark; }

.dc-module-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-right: 5px;
  border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
  flex-shrink: 0;
}
.dc-module-tabs { display: flex; flex-shrink: 0; gap: 2px; }
.dc-module-tab {
  padding: 8px 16px;
  border: none;
  background: none;
  color: var(--fontColor);
  cursor: pointer;
  font-size: 12px;
  border-bottom: 2px solid transparent;
  display: flex;
  align-items: center;
  gap: 5px;
  transition: all 0.2s;
}
.dc-module-tab:hover { background: var(--backgroundColor); }
.dc-module-tab.active { border-bottom-color: var(--fontActiveColor); color: var(--fontActiveColor); background: var(--backgroundColor); }
.dc-module-dash-actions { display: flex; align-items: center; gap: 4px; padding: 0 6px; }
/* 纯图标按钮（保存/导出/模式切换共用） */
.dc-icon-btn { width: 26px; padding: 3px 0; justify-content: center; }
.dc-module-dash-actions .dc-btn.active { background: var(--fontActiveColor); color: var(--backgroundColor); border-color: var(--fontActiveColor); }
.dc-module-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.dc-model-badge { font-size: 10px; color: var(--borderColor); border: 1px solid var(--borderColor); padding: 1px 6px; border-radius: 8px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ====== 画布工具栏（提升到标签栏右侧） ====== */
.dc-module-canvas-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; flex: 1; min-width: 0; overflow: hidden; }
.dc-module-canvas-toolbar .dc-toolbar-left,
.dc-module-canvas-toolbar .dc-toolbar-right { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; flex-shrink: 1; min-width: 0; }
.dc-module-canvas-toolbar .dc-breadcrumb { display: flex; align-items: center; gap: 2px; font-size: 11px; }
.dc-module-canvas-toolbar .dc-crumb { cursor: pointer; padding: 2px 6px; border-radius: 4px; }
.dc-module-canvas-toolbar .dc-crumb:hover { background: var(--backgroundColor); }
.dc-module-canvas-toolbar .dc-crumb.active { color: var(--fontActiveColor); }
.dc-module-canvas-toolbar .dc-crumb-sep { color: var(--fontColor); }
.dc-module-canvas-toolbar .dc-seg { display: flex; gap: 0; border: 1px solid var(--borderColor); border-radius: 4px; overflow: hidden; }
.dc-module-canvas-toolbar .dc-seg .dc-btn { border: none; border-radius: 0; }
.dc-module-canvas-toolbar .dc-select { height: 26px; font-size: 11px; margin: 0; width: auto; }
.dc-module-canvas-toolbar .dc-zoom-label { display: inline-flex; align-items: center; padding: 0 6px; font-size: 10px; color: var(--fontColor); min-width: 40px; justify-content: center; }
/* 顶部栏所有按钮与连线类型选项框高度一致（26px） */
.dc-module-head .dc-btn { height: 26px; box-sizing: border-box; }

.dc-btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 3px 9px; border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--backgroundColor); color: var(--fontColor); font-size: 11px; cursor: pointer;
}
.dc-btn:hover { background: var(--menuColor); }

.dc-module-body { flex: 1; min-height: 0; display: flex; }
.dc-view { flex: 1; min-width: 0; }

/* ====== 帮助页（与其它脚手架一致） ====== */
.dc-module-help { flex: 1; min-width: 0; overflow: hidden; }
.dc-help-body { height: 100%; overflow: auto; padding: 10px 14px; color: var(--fontColor); font-size: 13px; line-height: 1.7; }
.dc-help-body h3 { margin: 0 0 8px; }
.dc-help-body h4 { margin: 14px 0 6px; }
.dc-help-body code { background: var(--menuColor); padding: 1px 4px; border-radius: 3px; }
.dc-help-body ol, .dc-help-body ul { margin: 6px 0; padding-left: 22px; }
</style>
