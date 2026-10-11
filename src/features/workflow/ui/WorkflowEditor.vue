<!-- src/features/workflow/ui/WorkflowEditor.vue -->
<!--
  Dify 风格工作流编辑器
  与宿主的契约沿用旧编辑器：path / content / readonly 进，dirty / saved 出；
  文件内容就是 Dify DSL YAML，编辑器不扫盘、不开对话框。
-->
<template>
  <div ref="rootRef" class="wf-editor">
    <div v-if="loadError" class="wf-banner wf-banner--error">{{ loadError }}</div>

    <div v-if="issues.length" class="wf-banner" :class="{ 'wf-banner--error': hasErrors }">
      <div class="wf-banner__head" @click="issuesOpen = !issuesOpen">
        <span>{{ t('flow.issues') }} ({{ issues.length }})</span>
        <span class="wf-banner__toggle">{{ issuesOpen ? '−' : '+' }}</span>
      </div>
      <ul v-if="issuesOpen" class="wf-banner__list">
        <li v-for="(issue, index) in issues" :key="index" :class="`is-${issue.level}`">
          <span class="wf-banner__level">{{ issue.level === 'error' ? t('flow.issueError') : t('flow.issueWarning') }}</span>
          <span>{{ issue.message }}</span>
        </li>
      </ul>
    </div>

    <div class="wf-main">
      <div class="wf-canvas">
        <VueFlow
          v-if="doc"
          :id="flowId"
          v-model:nodes="flowNodes"
          v-model:edges="flowEdges"
          :node-types="nodeTypes"
          :min-zoom="0.2"
          :max-zoom="4"
          :nodes-draggable="!readonly && !locked"
          :nodes-connectable="!readonly && !locked"
          :elements-selectable="!locked"
          :delete-key-code="null"
          :default-viewport="doc.workflow.graph.viewport ?? { x: 0, y: 0, zoom: 0.8 }"
          fit-view-on-init
          @connect="onConnect"
          @node-click="onNodeClick"
          @edge-click="onEdgeClick"
          @pane-click="onPaneClick"
          @node-drag-stop="onNodeDragStop"
          @node-context-menu="onNodeContextMenu"
          @pane-context-menu="onPaneContextMenu"
        >
          <Background :gap="16" />
          <MiniMap v-if="showMinimap" pannable zoomable :width="150" :height="100" />
        </VueFlow>
        <div v-else class="wf-canvas__empty">{{ t('flow.empty') }}</div>
      </div>

      <!-- 右侧面板：选中节点才显示属性面板（画布占满），点工具栏「运行」才切到运行面板 -->
      <PropertiesPanel
        v-if="panelMode === 'props' && selectedNode"
        :data="selectedNode?.data?.dsl"
        :node-id="selectedNodeId ?? ''"
        :nodes="dslNodes"
        :edges="dslEdges"
        :environment-variables="doc?.workflow.environment_variables ?? []"
        :conversation-variables="doc?.workflow.conversation_variables ?? []"
        :readonly="!!readonly"
      />
      <RunPanel
        v-else-if="panelMode === 'run'"
        :document="doc"
        :state="runState"
        :history="runHistory"
        :var-cache="debugCache"
        :var-edits="debugEdits"
        :readonly="!!readonly"
        @run="runWorkflow"
        @stop="stopRun"
        @close="panelMode = 'props'"
        @debug-run="onDebugRun"
        @edit-var="onEditVar"
        @reset-var="onResetVar"
        @reset-vars="debugEdits = {}"
      />
      <AiPanel
        v-else-if="panelMode === 'ai'"
        :document="doc"
        :selected-title="selectedNode ? String(selectedNode.data?.dsl?.title ?? '') : ''"
        :readonly="!!readonly"
        :can-undo="aiHistory.length > 0"
        @apply="applyAiDocument"
        @undo="undoAiDocument"
        @close="panelMode = 'props'"
      />
    </div>

    <ContextMenu
      :open="ctx.open"
      :x="ctx.x"
      :y="ctx.y"
      :items="ctxItems"
      @pick="onContextPick"
      @close="ctx.open = false"
    >
      <template #sub>
        <NodePicker :disabled="unavailableTypes" @pick="addFromContext" />
      </template>
    </ContextMenu>

    <AppSettingsDialog v-model="showAppSettings" :document="doc" />

    <!-- 底部状态栏：左侧放操作按钮，右侧放统计 / 缩放 / 锁定（原来的顶部工具栏） -->
    <footer class="wf-statusbar">
      <div class="wf-statusbar__group">
        <el-popover v-if="!readonly" placement="top-start" :width="288" trigger="click">
          <template #reference>
            <button class="wf-btn wf-btn--icon" :title="t('flow.addNode')" :aria-label="t('flow.addNode')">
              <i class="fa fa-plus"></i>
            </button>
          </template>
          <NodePicker :disabled="unavailableTypes" @pick="addNodeAtCenter" />
        </el-popover>
        <button class="wf-btn wf-btn--icon" :disabled="!doc" :title="t('flow.autoLayout')" :aria-label="t('flow.autoLayout')" @click="doAutoLayout">
          <i class="fa fa-sitemap"></i>
        </button>
        <button class="wf-btn wf-btn--icon" :disabled="!doc" :title="t('run.open')" :aria-label="t('run.open')" @click="openRunPanel">
          <i class="fa fa-play"></i>
        </button>
        <button class="wf-btn wf-btn--icon" :disabled="!doc" :title="t('app.open')" :aria-label="t('app.open')" @click="showAppSettings = true">
          <i class="fa fa-cog"></i>
        </button>
        <button
          class="wf-btn wf-btn--icon"
          :class="{ 'is-active': panelMode === 'ai' }"
          :disabled="!doc || !!readonly"
          :title="t('ai.open')"
          :aria-label="t('ai.open')"
          @click="openAiPanel"
        >
          <i class="fa fa-magic"></i>
        </button>
        <button class="wf-btn wf-btn--icon" :disabled="readonly || !hasSelection" :title="t('flow.deleteSelected')" :aria-label="t('flow.deleteSelected')" @click="deleteSelection">
          <i class="fa fa-trash-o"></i>
        </button>
        <button
          v-if="!readonly"
          class="wf-btn wf-btn--icon wf-btn--primary"
          :disabled="!canSave"
          :title="t('flow.save')"
          :aria-label="t('flow.save')"
          @click="save"
        >
          <i class="fa fa-save"></i>
        </button>
        <span v-if="isDirty" class="wf-statusbar__dirty" :title="t('flow.unsaved')">●</span>
        <span v-if="readonly" class="wf-statusbar__tag">{{ t('flow.readonly') }}</span>
      </div>

      <div class="wf-statusbar__group wf-statusbar__group--right">
        <span class="wf-statusbar__stat">
          {{ t('flow.nodes') }} {{ nodeCount }} · {{ t('flow.edges') }} {{ edgeCount }}
        </span>
        <span class="wf-statusbar__sep" />
        <button class="wf-statusbar__zoom" :title="t('flow.zoomReset')" @click="zoomTo(1, { duration: 150 })">{{ zoomPercent }}</button>
        <button class="wf-btn wf-btn--icon" :disabled="!doc" :title="t('flow.zoomOut')" :aria-label="t('flow.zoomOut')" @click="zoomOut({ duration: 120 })">
          <i class="fa fa-search-minus"></i>
        </button>
        <button class="wf-btn wf-btn--icon" :disabled="!doc" :title="t('flow.zoomIn')" :aria-label="t('flow.zoomIn')" @click="zoomIn({ duration: 120 })">
          <i class="fa fa-search-plus"></i>
        </button>
        <button class="wf-btn wf-btn--icon" :disabled="!doc" :title="t('flow.fitView')" :aria-label="t('flow.fitView')" @click="fitView({ padding: 0.2 })">
          <i class="fa fa-crosshairs"></i>
        </button>
        <button
          class="wf-btn wf-btn--icon"
          :class="{ 'is-active': locked }"
          :disabled="!doc"
          :title="locked ? t('flow.unlock') : t('flow.lock')"
          :aria-label="locked ? t('flow.unlock') : t('flow.lock')"
          @click="toggleLock"
        >
          <i class="fa" :class="locked ? 'fa-lock' : 'fa-unlock'"></i>
        </button>
        <button
          class="wf-btn wf-btn--icon"
          :class="{ 'is-active': showMinimap }"
          :disabled="!doc"
          :title="t('flow.minimap')"
          :aria-label="t('flow.minimap')"
          @click="toggleMinimap"
        >
          <i class="fa fa-map-o"></i>
        </button>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { Background } from '@vue-flow/background'
import { MiniMap } from '@vue-flow/minimap'
import { useVueFlow, VueFlow, type Connection, type Edge, type NodeMouseEvent, type NodeTypesObject } from '@vue-flow/core'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/minimap/dist/style.css'
// 工作流 UI 主题层（映射 APP 主题变量 + 覆盖 Vue Flow 自带浅色）
import './theme.css'
import { ElMessage, ElPopover } from 'element-plus'
import { usestore } from '@/store'
import { type DslDocument, type DslNode } from '@/features/workflow/dsl/types'
import { DslError, parseDslYaml, serializeDslYaml } from '@/features/workflow/dsl/codec'
import { validateAndNormalizeDsl, type DslIssue } from '@/features/workflow/dsl/validator'
import { createNewDocument } from '@/features/workflow/dsl/defaults'
import { getNodePresentation } from '@/features/workflow/nodes/presentation'
import {
  applyAutoLayout,
  applyContainment,
  buildEdge,
  canAddType,
  CONTAINER_MIN_HEIGHT,
  CONTAINER_MIN_WIDTH,
  CONTAINER_RESIZE_KEY,
  createContainerEntry,
  createDifyNode,
  fitContainers,
  nodeSize,
  resizeNode,
  sortNodesByParent,
} from './graphOps'
import { containerEntryId, isContainerType } from '@/features/workflow/dsl/container'
import { FLOW_NODE_TYPE, toDslGraph, toFlowGraph, type DifyFlowNode } from './flowAdapter'
import DifyNodeCard from './DifyNodeCard.vue'
import NodePicker from './NodePicker.vue'
import ContextMenu from './ContextMenu.vue'
import type { ContextMenuItem } from './contextMenuTypes'
import PropertiesPanel from './PropertiesPanel.vue'
import RunPanel from './RunPanel.vue'
import AiPanel from './AiPanel.vue'
import AppSettingsDialog from './AppSettingsDialog.vue'
import { WorkflowRunner } from '@/features/workflow/engine/runner'
import {
  DEBUG_RUN_KEY,
  EDITOR_LOCK_KEY,
  RUN_STATE_KEY,
  applyRunEvent,
  createRunUiState,
  isDebuggableType,
  mergeRunStateIntoNodes,
  mergeVarSnapshot,
  readRunStateFromNodes,
  snapshotRun,
  type DebugRunActions,
  type RunHistoryEntry,
  type RunUiState,
} from './runState'
import { createFlowT } from './locales'

const props = defineProps<{
  /** 当前工作流文件路径（宿主持有；空 = 未打开） */
  path?: string
  /** 宿主直接提供的内容；为空则按 path 读盘 */
  content?: string
  readonly?: boolean
}>()

const emit = defineEmits<{
  (e: 'dirty', value: boolean): void
  (e: 'saved', path: string, content: string): void
}>()

const store = usestore()
const t = createFlowT(store.locales || 'zh')

const flowId = 'ai-km-workflow'
const nodeTypes = markRaw({ [FLOW_NODE_TYPE]: DifyNodeCard } as NodeTypesObject)

const { screenToFlowCoordinate, fitView, getSelectedNodes, getSelectedEdges, zoomIn, zoomOut, zoomTo, viewport } = useVueFlow(flowId)

const rootRef = ref<HTMLElement | null>(null)
const doc = ref<DslDocument | null>(null)
const flowNodes = ref<DifyFlowNode[]>([])
const flowEdges = ref<Edge[]>([])
const issues = ref<DslIssue[]>([])
const issuesOpen = ref(true)
const loadError = ref('')
const isDirty = ref(false)
const selectedNodeId = ref<string | null>(null)
const selectionVersion = ref(0)
/**
 * 变量检查器：上次运行产出的变量（自动刷新）与手动改过的值（edits 优先）。
 * 试跑节点时用两者合并的结果预置变量池 —— 上游不必重跑。
 */
const debugCache = ref<Record<string, Record<string, unknown>>>({})
const debugEdits = ref<Record<string, Record<string, unknown>>>({})
let loading = false
/**
 * 已落盘（或刚载入）的内容签名：脏标记与它比较。
 * 只用「草稿签名 ≠ 基线」判定未保存，避免刚打开文件就因为载入本身被标记成未保存。
 */
let cleanSignature = ''

const ctx = ref<{ open: boolean; x: number; y: number; target: 'pane' | 'node'; nodeId: string }>({
  open: false,
  x: 0,
  y: 0,
  target: 'pane',
  nodeId: '',
})
let ctxPosition = { x: 0, y: 0 }

// ── 运行态 ────────────────────────────────────────────────
const runState = ref<RunUiState>(createRunUiState())
provide(RUN_STATE_KEY, runState)
const panelMode = ref<'props' | 'run' | 'ai'>('props')
const showAppSettings = ref(false)
/** 右下角小地图开关（记住用户选择，默认显示） */
const showMinimap = ref(localStorage.getItem('wf-show-minimap') !== '0')
/** 画布锁定：临时禁止拖动 / 连线 / 选中（查看大图时防误改） */
const locked = ref(false)
const zoomPercent = computed(() => `${Math.round((viewport.value?.zoom ?? 1) * 100)}%`)
/** AI 编排的撤销快照（最近 10 份文档的 YAML） */
const aiHistory = ref<string[]>([])
const runHistory = ref<RunHistoryEntry[]>([])
let runAbort: AbortController | null = null
let logSeq = 0

const nodeCount = computed(() => flowNodes.value.length)
const edgeCount = computed(() => flowEdges.value.length)
const hasErrors = computed(() => issues.value.some((i) => i.level === 'error'))
const canSave = computed(() => !!props.path && !!doc.value && !props.readonly)
const displayName = computed(() => {
  if (!doc.value) return t('flow.untitled')
  return doc.value.app.name || t('flow.untitled')
})

const selectedNode = computed(() => flowNodes.value.find((n) => n.id === selectedNodeId.value) ?? null)

/** 属性面板与变量选择器用的 DSL 视图（data 与画布节点共享同一对象引用） */
const graphView = computed(() => toDslGraph(flowNodes.value, flowEdges.value, doc.value?.workflow.graph))
const dslNodes = computed<DslNode[]>(() => graphView.value.nodes)
const dslEdges = computed(() => graphView.value.edges)

const hasSelection = computed(() => {
  selectionVersion.value
  return getSelectedNodes.value.length > 0 || getSelectedEdges.value.length > 0 || !!selectedNodeId.value
})

/** 已存在的单例节点类型（开始 / 结束）在添加菜单里禁用 */
const unavailableTypes = computed(() => {
  const types = flowNodes.value.map((n) => String(n.data?.dsl?.type ?? ''))
  const result: string[] = []
  if (types.includes('start') || types.includes('start-placeholder')) result.push('start')
  if (types.includes('end')) result.push('end')
  return result
})

const ctxItems = computed<ContextMenuItem[]>(() => {
  if (props.readonly) return []
  if (ctx.value.target === 'node') {
    return [
      { key: 'next', label: t('flow.addNext'), children: true },
      { key: 'duplicate', label: t('flow.duplicateNode') },
      { key: 'divider', label: '', divider: true },
      { key: 'delete', label: t('flow.deleteNode'), danger: true },
    ]
  }
  return [
    { key: 'add', label: t('flow.addNode'), children: true },
    { key: 'layout', label: t('flow.autoLayout') },
    { key: 'fit', label: t('flow.fitView') },
  ]
})

/** 去掉 .flow.yml 后缀，作为新文档默认名 */
function baseName(path?: string): string {
  const file = (path || '').split(/[\\/]/).pop() || ''
  return file.replace(/\.flow\.ya?ml$/i, '').replace(/\.ya?ml$/i, '')
}

function titleFor(type: string): string {
  const presentation = getNodePresentation(type)
  return presentation.labelKey ? t(presentation.labelKey) : type
}

/** 小地图开关（记住选择） */
function toggleMinimap(): void {
  showMinimap.value = !showMinimap.value
  localStorage.setItem('wf-show-minimap', showMinimap.value ? '1' : '0')
}

/** 锁定 / 解锁画布（只影响交互，不改文档） */
function toggleLock(): void {
  locked.value = !locked.value
  if (locked.value) panelMode.value = 'props'
}

function openAiPanel(): void {
  if (props.readonly) return
  panelMode.value = 'ai'
  selectedNodeId.value = null
}

/** 应用 AI 编排结果：先存一份快照用于撤销 */
function applyAiDocument(next: DslDocument): void {
  const current = doc.value
  if (current) {
    aiHistory.value = [...aiHistory.value.slice(-9), serializeDslYaml(current)]
  }
  doc.value = next
  setGraph(next)
  selectedNodeId.value = null
  issues.value = []
  markDirty()
  ElMessage.success(t('ai.applied'))
}

/** 撤销 AI 编排（回到上一个快照） */
function undoAiDocument(): void {
  const snapshot = aiHistory.value[aiHistory.value.length - 1]
  if (!snapshot) return
  aiHistory.value = aiHistory.value.slice(0, -1)
  loadFromContent(snapshot)
  panelMode.value = 'ai'
  markDirty()
  ElMessage.info(t('ai.undone'))
}

function markDirty(): void {
  if (loading || props.readonly) return
  if (!isDirty.value) {
    isDirty.value = true
    emit('dirty', true)
  }
}

/** 把当前内容作为「已保存」基线（载入完成 / 保存成功后调用），清除脏标记 */
function markClean(): void {
  cleanSignature = graphSignature()
  if (isDirty.value) {
    isDirty.value = false
    emit('dirty', false)
  }
}

/**
 * 容器节点（迭代 / 循环）手动缩放：手柄按下后由编辑器接管指针，
 * 屏幕位移要除以当前缩放才等于画布坐标位移。
 */
function startContainerResize(nodeId: string, event: PointerEvent): void {
  if (props.readonly || locked.value) return
  const node = flowNodes.value.find((n) => n.id === nodeId)
  if (!node) return
  event.preventDefault()
  event.stopPropagation()

  const zoom = viewport.value?.zoom || 1
  const originX = event.clientX
  const originY = event.clientY
  const start = nodeSize(node)

  const onMove = (move: PointerEvent): void => {
    const width = Math.max(CONTAINER_MIN_WIDTH, start.width + (move.clientX - originX) / zoom)
    const height = Math.max(CONTAINER_MIN_HEIGHT, start.height + (move.clientY - originY) / zoom)
    const index = flowNodes.value.findIndex((n) => n.id === nodeId)
    if (index < 0) return
    // Vue Flow 只监听数组引用，必须整体替换数组才能同步到画布
    const next = flowNodes.value.slice()
    next[index] = resizeNode(next[index], width, height)
    flowNodes.value = next
  }
  const onUp = (): void => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    markDirty()
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

provide(CONTAINER_RESIZE_KEY, { start: startContainerResize })
provide(
  EDITOR_LOCK_KEY,
  computed(() => !!(props.readonly || locked.value)),
)

function setGraph(source: DslDocument): void {
  const graph = toFlowGraph(source)
  flowNodes.value = ensureContainerEntries(graph.nodes)
  flowEdges.value = graph.edges
  // 打开文件时把上次保存的运行状态读回画布（只用于展示，不会立刻变脏）
  const records = readRunStateFromNodes(toDslGraph(flowNodes.value, graph.edges).nodes)
  runState.value = { ...createRunUiState(), records }
}

/**
 * 保证每个容器都有入口节点：Dify 文件里本来就有；本地新建或用户手工删掉时补齐，
 * 否则容器内部节点读不到 item / index。
 */function ensureContainerEntries(nodes: DifyFlowNode[]): DifyFlowNode[] {
  const missing = nodes.filter(
    (n) => isContainerType(String(n.data?.dsl?.type ?? '')) && !nodes.some((c) => c.id === containerEntryId(n.id)),
  )
  if (!missing.length) return nodes
  const created = missing.map((container) => createContainerEntry(container)).filter((n): n is DifyFlowNode => !!n)
  return sortNodesByParent([...nodes, ...created])
}

function loadFromContent(content: string): void {  loading = true
  loadError.value = ''
  issues.value = []
  selectedNodeId.value = null
  try {
    if (!content || !content.trim()) {
      doc.value = createNewDocument({
        name: baseName(props.path) || t('flow.untitled'),
        startTitle: t('node.start'),
        endTitle: t('node.end'),
      })
      setGraph(doc.value)
    } else {
      const raw = parseDslYaml(content)
      const result = validateAndNormalizeDsl(raw)
      issues.value = result.issues
      if (!result.ok || !result.document) {
        doc.value = null
        flowNodes.value = []
        flowEdges.value = []
        loadError.value = result.issues.find((i) => i.level === 'error')?.message || t('flow.load_failed')
        return
      }
      doc.value = result.document
      setGraph(result.document)
    }
    markClean()
  } catch (error) {
    doc.value = null
    flowNodes.value = []
    flowEdges.value = []
    loadError.value = error instanceof DslError ? error.message : t('flow.load_failed')
  } finally {
    loading = false
  }
}

async function loadFromPath(): Promise<void> {
  if (!props.path) {
    loadFromContent('')
    return
  }
  try {
    const content: string = await window.ipcRenderer.invoke('readFile', props.path)
    loadFromContent(content)
  } catch (error) {
    loadError.value = `${t('flow.load_failed')}：${(error as Error).message}`
  }
}

async function load(): Promise<void> {
  if (props.content !== undefined) {
    loadFromContent(props.content)
    return
  }
  await loadFromPath()
}

async function save(): Promise<void> {  const current = doc.value
  if (!current || !props.path || props.readonly) return
  // 深拷贝后再合并运行态：避免把 x-ai-km 写进画布节点的 data（否则刚保存完又立刻变脏）
  const graph = JSON.parse(JSON.stringify(toDslGraph(flowNodes.value, flowEdges.value, current.workflow.graph)))
  mergeRunStateIntoNodes(graph.nodes, runState.value)
  current.workflow.graph = graph
  const content = serializeDslYaml(current)
  try {
    const ok = await window.ipcRenderer.invoke('saveFile', props.path, content)
    if (!ok) throw new Error('saveFile 返回失败')
    markClean()
    emit('saved', props.path, content)
    void window.ipcRenderer.invoke('notify-file-changed', { path: props.path, content }).catch(() => {})
    ElMessage.success(t('flow.saved'))
  } catch (error) {
    ElMessage.error(`${t('flow.save_failed')}：${(error as Error).message}`)
  }
}

// ── 节点增删 ─────────────────────────────────────────────

/** 在视口中心新增节点 */
function addNodeAtCenter(type: string): void {
  if (props.readonly || !canAddType(type, flowNodes.value)) return
  const center = screenToFlowCoordinate({
    x: (rootRef.value?.clientWidth ?? 900) / 2,
    y: (rootRef.value?.clientHeight ?? 600) / 2,
  })
  const node = createDifyNode(type, { x: Math.round(center.x), y: Math.round(center.y) }, titleFor(type), flowNodes.value)
  const additions = [node]
  if (isContainerType(type)) {
    const entry = createContainerEntry(node)
    if (entry) additions.push(entry)
  }
  flowNodes.value = sortNodesByParent([...flowNodes.value, ...additions])
  selectedNodeId.value = node.id
  markDirty()
}

/** 右键新增：画布右键在点击位置添加；节点右键加在其右侧并自动连线 */
function addFromContext(type: string): void {
  if (props.readonly || !canAddType(type, flowNodes.value)) return
  if (ctx.value.target === 'node') {
    const source = flowNodes.value.find((n) => n.id === ctx.value.nodeId)
    const node = createDifyNode(
      type,
      source ? { x: Math.round(source.position.x + 380), y: Math.round(source.position.y) } : ctxPosition,
      titleFor(type),
      flowNodes.value,
    )
    const additions = [node]
    if (isContainerType(type)) {
      const entry = createContainerEntry(node)
      if (entry) additions.push(entry)
    }
    flowNodes.value = sortNodesByParent([...flowNodes.value, ...additions])
    if (source) {
      const edge = buildEdge(source.id, 'source', node.id, 'target', flowNodes.value, flowEdges.value)
      if (edge) flowEdges.value = [...flowEdges.value, edge]
    }
    selectedNodeId.value = node.id
  } else {
    const node = createDifyNode(type, { x: Math.round(ctxPosition.x), y: Math.round(ctxPosition.y) }, titleFor(type), flowNodes.value)
    const additions = [node]
    if (isContainerType(type)) {
      const entry = createContainerEntry(node)
      if (entry) additions.push(entry)
    }
    flowNodes.value = sortNodesByParent([...flowNodes.value, ...additions])
    selectedNodeId.value = node.id
  }
  ctx.value.open = false
  markDirty()
}

/** 拖拽结束：把节点收进 / 移出容器，并让容器尺寸自适应 */
function onNodeDragStop(): void {
  if (props.readonly) return
  const withParent = sortNodesByParent(applyContainment(flowNodes.value))
  const fitted = fitContainers(withParent)
  flowNodes.value = fitted
  markDirty()
}

function removeNodes(ids: string[]): void {
  if (!ids.length) return
  const removing = new Set(ids)
  // 容器被删时连同其子节点一起删除，避免留下无归属的孤儿子图
  let changed = true
  while (changed) {
    changed = false
    for (const node of flowNodes.value) {
      if (node.parentNode && removing.has(node.parentNode) && !removing.has(node.id)) {
        removing.add(node.id)
        changed = true
      }
    }
  }
  flowNodes.value = flowNodes.value.filter((n) => !removing.has(n.id))
  flowEdges.value = flowEdges.value.filter((e) => !removing.has(e.source) && !removing.has(e.target))
  if (selectedNodeId.value && removing.has(selectedNodeId.value)) selectedNodeId.value = null
  markDirty()
}

function duplicateNode(id: string): void {
  const source = flowNodes.value.find((n) => n.id === id)
  if (!source) return
  const template = createDifyNode(String(source.data?.dsl?.type ?? ''), { x: 0, y: 0 }, '', flowNodes.value)
  const data = JSON.parse(JSON.stringify(source.data ?? { dsl: {} })) as NonNullable<DifyFlowNode['data']>
  data.dsl = { ...data.dsl, title: `${source.data?.dsl?.title ?? ''} ${t('flow.copySuffix')}` }
  const node: DifyFlowNode = {
    ...template,
    data,
    position: { x: Math.round(source.position.x + 40), y: Math.round(source.position.y + 60) },
  }
  if (source.parentNode) node.parentNode = source.parentNode
  flowNodes.value = [...flowNodes.value, node]
  selectedNodeId.value = node.id
  markDirty()
}

function deleteSelection(): void {
  if (props.readonly) return
  selectionVersion.value
  const edgeIds = new Set(getSelectedEdges.value.map((e) => e.id))
  if (edgeIds.size) flowEdges.value = flowEdges.value.filter((e) => !edgeIds.has(e.id))

  const ids = getSelectedNodes.value.map((n) => n.id)
  if (selectedNodeId.value && !ids.includes(selectedNodeId.value)) ids.push(selectedNodeId.value)
  if (ids.length) removeNodes(ids)
  else if (edgeIds.size) markDirty()
}

function doAutoLayout(): void {
  if (props.readonly) return
  flowNodes.value = sortNodesByParent(fitContainers(applyAutoLayout(flowNodes.value, flowEdges.value)))
  markDirty()
  requestAnimationFrame(() => fitView({ padding: 0.2 }))
}

// ── 运行 ─────────────────────────────────────────────────

function openRunPanel(): void {
  panelMode.value = 'run'
}

function stopRun(): void {
  runAbort?.abort()
  runAbort = null
  runState.value.running = false
}

// ── 变量检查器 / 单节点试跑 ──────────────────────────────

/** 检查器可见的变量：上次运行产出 ∪ 手动改过的值（edits 优先） */
const variableSnapshot = computed(() => mergeVarSnapshot(debugCache.value, debugEdits.value))

/** 运行结束后刷新缓存：把本次跑到的节点输出收进变量检查器 */
function refreshDebugCache(): void {
  const next = { ...debugCache.value }
  for (const [nodeId, record] of Object.entries(runState.value.records)) {
    if (!record.outputs) continue
    if (record.status !== 'success' && record.status !== 'error') continue
    try {
      next[nodeId] = JSON.parse(JSON.stringify(record.outputs))
    } catch {
      next[nodeId] = { ...record.outputs }
    }
  }
  debugCache.value = next
}

function onEditVar(payload: { nodeId: string; name: string; value: unknown }): void {
  const nodeEdits = { ...(debugEdits.value[payload.nodeId] ?? {}) }
  nodeEdits[payload.name] = payload.value
  debugEdits.value = { ...debugEdits.value, [payload.nodeId]: nodeEdits }
}

function onResetVar(payload: { nodeId: string; name: string }): void {
  const nodeEdits = { ...(debugEdits.value[payload.nodeId] ?? {}) }
  delete nodeEdits[payload.name]
  const next = { ...debugEdits.value }
  if (Object.keys(nodeEdits).length) next[payload.nodeId] = nodeEdits
  else delete next[payload.nodeId]
  debugEdits.value = next
}

/** 不参与试跑的节点：开始 / 结束 / 直接回复（与 Dify 一致），容器内部节点由容器驱动 */
function canDebugRun(nodeId: string): boolean {
  if (props.readonly || runState.value.running || !doc.value) return false
  const node = flowNodes.value.find((n) => n.id === nodeId)
  if (!node || node.parentNode) return false
  return isDebuggableType(String(node.data?.dsl?.type ?? ''))
}

/** 某节点的下游节点集（顺连线广度优先；容器内部节点由容器驱动，不在此展开） */
function downstreamOf(nodeId: string): string[] {
  const out: string[] = []
  const seen = new Set([nodeId])
  const queue = [nodeId]
  while (queue.length) {
    const current = queue.shift() as string
    for (const edge of flowEdges.value) {
      if (edge.source !== current || seen.has(edge.target)) continue
      seen.add(edge.target)
      out.push(edge.target)
      queue.push(edge.target)
    }
  }
  return out
}

/** 试跑：只跑该节点（或连同下游），变量池用检查器缓存的上游值 */
function onDebugRun(payload: { nodeId: string; downstream: boolean }): void {
  if (!canDebugRun(payload.nodeId)) return
  const ids = [payload.nodeId, ...(payload.downstream ? downstreamOf(payload.nodeId) : [])]
  panelMode.value = 'run'
  void executeRun({ scope: ids, recordHistory: false })
}

/** 属性面板里的「试跑此节点 / 运行此节点及下游」入口 */
provide(DEBUG_RUN_KEY, {
  canRun: (nodeId: string) => canDebugRun(nodeId),
  isRunning: () => runState.value.running,
  run: (nodeId: string, downstream: boolean) => onDebugRun({ nodeId, downstream }),
} satisfies DebugRunActions)

/** 运行工作流：先把画布状态同步进文档，保证跑的就是所见内容 */
async function runWorkflow(inputs: Record<string, unknown>): Promise<void> {
  await executeRun({ inputs, recordHistory: true })
}

/**
 * 统一的执行入口。
 * - 整图运行：`scope` 省略，输入来自开始节点表单，结果进运行历史；
 * - 试跑（单节点 / 运行区段）：`scope` 指定节点集，变量池用变量检查器的缓存预置，
 *   不重跑上游、不进运行历史（历史里的条目始终是「整图运行」的快照）。
 */
async function executeRun(options: {
  inputs?: Record<string, unknown>
  scope?: string[]
  recordHistory?: boolean
}): Promise<void> {
  if (props.readonly) return
  const current = doc.value
  if (!current) return

  current.workflow.graph = toDslGraph(flowNodes.value, flowEdges.value, current.workflow.graph)
  const controller = new AbortController()
  runAbort = controller
  const update = { state: runState.value, nextLogId: logSeq }

  const runner = new WorkflowRunner({ store, t })
  try {
    await runner.run(current, {
      inputs: options.inputs ?? {},
      scope: options.scope,
      initialVariables: options.scope ? variableSnapshot.value : undefined,
      signal: controller.signal,
      onEvent: (event) => {
        applyRunEvent(update, event)
        logSeq = update.nextLogId
      },
    })
  } catch (error) {
    applyRunEvent(update, {
      type: 'run-error',
      error: (error as Error)?.message ?? String(error),
      elapsedMs: 0,
    })
    logSeq = update.nextLogId
  } finally {
    if (runAbort === controller) runAbort = null
    refreshDebugCache()
    // 保留最近 5 次运行，便于对比（仅内存）
    if (options.recordHistory !== false && runState.value.status !== 'running') {
      runHistory.value = [snapshotRun(runState.value), ...runHistory.value].slice(0, 5)
    }
  }
}

// ── 画布事件 ─────────────────────────────────────────────

function onConnect(connection: Connection): void {
  if (props.readonly) return
  const edge = buildEdge(
    connection.source,
    connection.sourceHandle ?? 'source',
    connection.target,
    connection.targetHandle ?? 'target',
    flowNodes.value,
    flowEdges.value,
  )
  if (!edge) {
    ElMessage.warning(t('flow.invalidConnection'))
    return
  }
  flowEdges.value = [...flowEdges.value, edge]
  markDirty()
}

function onNodeClick(event: NodeMouseEvent): void {
  selectedNodeId.value = event.node.id
  selectionVersion.value++
  // 选中节点即回到属性面板（与点「运行」互斥：同一位置只显示一个面板）
  panelMode.value = 'props'
}

/** 选中连线时关闭节点属性面板，避免「删连线」把之前选中的节点一起删掉 */
function onEdgeClick(): void {
  selectedNodeId.value = null
  selectionVersion.value++
}

function onPaneClick(): void {
  selectedNodeId.value = null
  selectionVersion.value++
  ctx.value.open = false
}

function onNodeContextMenu(payload: NodeMouseEvent): void {
  if (props.readonly) return
  const mouse = payload.event as MouseEvent
  selectedNodeId.value = payload.node.id
  ctx.value = { open: true, x: mouse.clientX, y: mouse.clientY, target: 'node', nodeId: payload.node.id }
}

function onPaneContextMenu(mouse: MouseEvent): void {
  if (props.readonly) return
  ctxPosition = screenToFlowCoordinate({ x: mouse.clientX, y: mouse.clientY })
  ctx.value = { open: true, x: mouse.clientX, y: mouse.clientY, target: 'pane', nodeId: '' }
}

function onContextPick(key: string): void {
  const nodeId = ctx.value.nodeId
  if (key === 'layout') {
    ctx.value.open = false
    doAutoLayout()
  } else if (key === 'fit') {
    ctx.value.open = false
    fitView({ padding: 0.2 })
  } else if (key === 'duplicate') {
    ctx.value.open = false
    duplicateNode(nodeId)
  } else if (key === 'delete') {
    ctx.value.open = false
    removeNodes([nodeId])
  }
}

// ── 键盘 ─────────────────────────────────────────────────

function onKeydown(event: KeyboardEvent): void {
  if (!rootRef.value?.isConnected) return
  const target = event.target as HTMLElement | null
  const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    void save()
    return
  }
  if (props.readonly || typing) return

  const withModifier = event.ctrlKey || event.metaKey
  if (withModifier && event.key.toLowerCase() === 'd') {
    event.preventDefault()
    if (selectedNodeId.value) duplicateNode(selectedNodeId.value)
    return
  }
  if (withModifier && event.key.toLowerCase() === 'a') {
    event.preventDefault()
    flowNodes.value = flowNodes.value.map((n) => ({ ...n, selected: true }))
    selectionVersion.value++
    return
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    deleteSelection()
  }
}

onMounted(() => {
  void load()
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})

watch(() => props.content, (value) => {
  if (value !== undefined) loadFromContent(value)
})

watch(() => props.path, (value, oldValue) => {
  if (value === oldValue) return
  void load()
})

/**
 * 脏标记：用「将要写入文件的内容」的签名做比较。
 * 直接 deep watch 画布节点会被 Vue Flow 的内部写入（实测尺寸 / 计算位置等）误触发，
 * 导致刚保存完又变成未保存。
 */
function graphSignature(): string {
  try {
    return JSON.stringify(toDslGraph(flowNodes.value, flowEdges.value, doc.value?.workflow.graph))
  } catch {
    return ''
  }
}

watch(
  () => graphSignature(),
  (signature) => {
    if (loading) return
    // 与「已载入 / 已保存」的内容一致（刚打开文件、撤销回原样）→ 不算未保存
    if (signature === cleanSignature) {
      if (isDirty.value) {
        isDirty.value = false
        emit('dirty', false)
      }
      return
    }
    markDirty()
  },
)
</script>

<style scoped>
/* 配色一律取自 theme.css 的 --wf-* 变量（跟随 APP 18 套主题，含深色），此处只写布局与尺寸 */
.wf-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--wf-bg);
  color: var(--wf-text);
}

.wf-statusbar {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border-top: 1px solid var(--wf-border);
  background: var(--wf-surface);
  font-size: 12px;
}

.wf-statusbar__group {
  display: flex;
  align-items: center;
  gap: 5px;
}

.wf-statusbar__group--right {
  margin-left: auto;
}

.wf-statusbar__sep {
  width: 1px;
  height: 16px;
  background: var(--wf-border);
}

.wf-statusbar__stat {
  color: var(--wf-text-dim);
  font-size: 12px;
  white-space: nowrap;
}

.wf-statusbar__zoom {
  min-width: 42px;
  padding: 2px 4px;
  border: none;
  background: transparent;
  color: var(--wf-text-soft);
  font-size: 12px;
  cursor: pointer;
}

.wf-statusbar__zoom:hover {
  color: var(--wf-accent-text);
}

.wf-statusbar__tag {
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--wf-info-bg);
  color: var(--wf-accent-text);
  font-size: 11px;
}

.wf-statusbar__dirty {
  color: var(--wf-warning);
  font-size: 10px;
}

/* 按钮样式统一放在 panel.css（全局），此处只保留状态栏专属样式 */

.wf-banner {
  padding: 6px 12px;
  border-bottom: 1px solid var(--wf-border);
  background: var(--wf-warning-bg);
  color: var(--wf-warning);
  font-size: 12px;
}

.wf-banner--error {
  background: var(--wf-danger-bg);
  color: var(--wf-danger);
}

.wf-banner__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  font-weight: 600;
}

.wf-banner__toggle {
  font-size: 14px;
  line-height: 1;
}

.wf-banner__list {
  margin: 6px 0 0;
  padding-left: 18px;
}

.wf-banner__list li.is-error {
  color: var(--wf-danger);
}

.wf-banner__level {
  margin-right: 6px;
  opacity: 0.7;
}

.wf-main {
  display: flex;
  flex: 1;
  min-height: 240px;
  overflow: hidden;
}

.wf-canvas {
  position: relative;
  flex: 1;
  min-width: 0;
  background: var(--wf-bg);
}

.wf-canvas__empty {
  padding: 24px;
  color: var(--wf-text-dim);
  font-size: 13px;
}
</style>
