// store.ts - 数据画布模块状态管理（组合式单例 + IndexedDB 独立存储）
// 数据隔离：使用独立的 localforage 实例，不与宿主系统数据耦合

import { reactive, ref, computed } from 'vue'
import localforage from 'localforage'
import type {
  Model, DcNode, DcEdge, DcConfig, DcChangeEvent,
  BasicParam, FormField, ViewMode,
} from '@/components/DataCanvas/types'
import { uid } from '@/components/DataCanvas/types'

// ==================== 独立存储（IndexedDB） ====================
const db = localforage.createInstance({
  name: 'aikm-data-canvas',
  storeName: 'dc-models',
  description: 'Data Canvas 独立数据存储（数据隔离）',
})

const DEFAULT_CONFIG: Required<DcConfig> = {
  showImportExport: true,
  allowSubCanvas: true,
  maxDepth: 5,
  initialData: null,
  theme: 'dark',
}

// ==================== 状态 ====================
const config = reactive<Required<DcConfig>>({ ...DEFAULT_CONFIG })
const models = ref<Model[]>([])
const activeModelId = ref<string | null>(null)
// 子画布导航路径（面包屑），元素为模型id，最后一个即当前所在模型
const modelPath = ref<string[]>([])
const viewMode = ref<ViewMode>('full')
// 默认进入主页（dashboard，即原看板）视图
const internalTab = ref<'canvas' | 'entry' | 'dashboard' | 'help'>('dashboard')

// 当前所在模型id（子画布导航栈顶）
const currentModelId = computed<string | null>(() => {
  const top = modelPath.value[modelPath.value.length - 1]
  return top ?? activeModelId.value
})

// 是否处于根画布
const isRoot = computed(() => modelPath.value.length <= 1)

// ==================== 变化通知（供宿主监听） ====================
type ChangeListener = (e: DcChangeEvent) => void
const changeListeners: ChangeListener[] = []

function notify(type: DcChangeEvent['type'], payload: any) {
  const e: DcChangeEvent = { type, payload }
  changeListeners.forEach((fn) => fn(e))
}

function onChange(fn: ChangeListener): () => void {
  changeListeners.push(fn)
  return () => {
    const i = changeListeners.indexOf(fn)
    if (i >= 0) changeListeners.splice(i, 1)
  }
}

// ==================== 持久化 ====================
// IndexedDB 结构化克隆不支持 Vue 响应式 Proxy，持久化前必须深拷贝为普通数据
function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

async function persist() {
  const m = activeModel.value
  if (m) m.updatedAt = Date.now()
  try {
    await db.setItem('models', toPlain(models.value))
    if (activeModelId.value) await db.setItem('activeModelId', activeModelId.value)
  } catch (e) {
    console.warn('[DataCanvas] 持久化失败', e)
  }
}

// ==================== 查询 ====================
function getModelById(id: string | null): Model | null {
  if (!id) return null
  return models.value.find((m) => m.id === id) ?? null
}

const activeModel = computed<Model | null>(() => getModelById(currentModelId.value))

// ==================== 配置 ====================
function setConfig(c?: DcConfig) {
  Object.assign(config, DEFAULT_CONFIG, c || {})
}

// ==================== 模型操作 ====================
function createModel(name = '未命名模型'): Model {
  const m: Model = {
    id: uid('m'),
    name,
    nodes: [],
    edges: [],
    hierarchy: { depth: 0 },
    meta: { params: [], formFields: [], formRecords: [] },
    updatedAt: Date.now(),
  }
  models.value.push(m)
  persist()
  return m
}

function setActiveModel(id: string | null) {
  activeModelId.value = id
  modelPath.value = id ? [id] : []
  persist()
  notify('model', { action: 'activate', id })
}

function updateModel(id: string, patch: Partial<Model>) {
  const m = getModelById(id)
  if (!m) return
  Object.assign(m, patch, { updatedAt: Date.now() })
  persist()
  notify('model', { id, patch })
}

function renameModel(id: string, name: string) {
  updateModel(id, { name })
}

function deleteModel(id: string) {
  // 删除时也删除其子画布模型（递归）
  const m = getModelById(id)
  if (m) {
    for (const n of m.nodes) {
      if (n.type === 'subcanvas' && n.data.modelId) deleteModel(n.data.modelId)
    }
  }
  models.value = models.value.filter((x) => x.id !== id)
  if (activeModelId.value === id) {
    activeModelId.value = null
    modelPath.value = []
  }
  persist()
  notify('model', { action: 'delete', id })
}

// ==================== 子画布 ====================
function ensureSubModel(node: DcNode): Model {
  let sub = getModelById(node.data.modelId)
  if (!sub) {
    const parent = activeModel.value
    sub = {
      id: node.data.modelId || uid('m'),
      name: node.name,
      nodes: [],
      edges: [],
      hierarchy: { parentId: parent?.id, depth: (parent?.hierarchy.depth ?? 0) + 1 },
      meta: { params: [], formFields: [], formRecords: [] },
      updatedAt: Date.now(),
    }
    node.data.modelId = sub.id
    models.value.push(sub)
    persist()
  }
  return sub
}

function getSubModel(node: DcNode): Model | null {
  return node.type === 'subcanvas' ? getModelById(node.data.modelId) : null
}

// 查找指向当前所在模型的子画布节点（当前模型为子画布时，供“暴露到外部”使用）
function getParentSubCanvasNode(): DcNode | null {
  const cur = currentModelId.value
  if (!cur) return null
  for (const m of models.value) {
    for (const n of m.nodes) {
      if (n.type === 'subcanvas' && n.data.modelId === cur) return n
    }
  }
  return null
}

// 导航
function navigateTo(modelId: string) {
  modelPath.value = [...modelPath.value, modelId]
  notify('model', { action: 'navigate', path: [...modelPath.value] })
}

function navigateBack() {
  // 至少保留根模型（第一项），避免路径丢失根模型导致面包屑层级错乱
  modelPath.value = modelPath.value.length > 1
    ? modelPath.value.slice(0, -1)
    : (activeModelId.value ? [activeModelId.value] : [])
  notify('model', { action: 'navigate', path: [...modelPath.value] })
}

function navigateRoot() {
  // 回到根画布：保留根模型作为第一项（与 crumbPath.slice(1) 的约定一致）
  modelPath.value = activeModelId.value ? [activeModelId.value] : []
  notify('model', { action: 'navigate', path: [...modelPath.value] })
}

// 面包屑显示名称
function pathNames(): { id: string; name: string }[] {
  const arr: { id: string; name: string }[] = []
  for (const id of modelPath.value) {
    const m = getModelById(id)
    if (m) arr.push({ id, name: m.name })
  }
  return arr
}

// 计算从根到指定模型id的导航路径（供工程树跳转）
function pathToModel(modelId: string): string[] {
  const path: string[] = []
  let cur: string | null = modelId
  let guard = 0
  while (cur && guard < 50) {
    path.unshift(cur)
    const m = getModelById(cur)
    if (!m?.hierarchy.parentId) break
    cur = m.hierarchy.parentId
    guard++
  }
  return path
}

// ==================== 节点操作（作用于当前模型） ====================
function addNode(node: DcNode) {
  const m = activeModel.value
  if (!m) return
  if (node.type === 'subcanvas' && config.allowSubCanvas) ensureSubModel(node)
  m.nodes.push(node)
  persist()
  notify('node', { action: 'add', node })
}

function updateNode(id: string, patch: Partial<DcNode>) {
  const m = activeModel.value
  if (!m) return
  const n = m.nodes.find((x) => x.id === id)
  if (!n) return
  Object.assign(n, patch)
  persist()
  notify('node', { action: 'update', id, patch })
}

function removeNode(id: string) {
  const m = activeModel.value
  if (!m) return
  m.nodes = m.nodes.filter((x) => x.id !== id)
  m.edges = m.edges.filter((e) => e.source.split(':')[0] !== id && e.target.split(':')[0] !== id)
  persist()
  notify('node', { action: 'remove', id })
}

// ==================== 连线操作 ====================
function addEdge(edge: DcEdge) {
  const m = activeModel.value
  if (!m) return
  // 去重
  const dup = m.edges.find((e) => e.source === edge.source && e.target === edge.target && e.type === edge.type)
  if (dup) return
  m.edges.push(edge)
  persist()
  notify('edge', { action: 'add', edge })
}

function removeEdge(id: string) {
  const m = activeModel.value
  if (!m) return
  m.edges = m.edges.filter((e) => e.id !== id)
  persist()
  notify('edge', { action: 'remove', id })
}

function updateEdge(id: string, patch: Partial<DcEdge>) {
  const m = activeModel.value
  if (!m) return
  const e = m.edges.find((x) => x.id === id)
  if (!e) return
  Object.assign(e, patch)
  persist()
  notify('edge', { action: 'update', id, patch })
}

// ==================== 元数据（录入数据） ====================
function updateMeta(patch: Partial<NonNullable<Model['meta']>>) {
  const m = activeModel.value
  if (!m) return
  m.meta = { params: [], formFields: [], formRecords: [], ...(m.meta || {}), ...patch }
  persist()
  notify('data', { action: 'meta', id: m.id, patch })
}

// ==================== 导入 / 导出 / 重置 ====================
async function importData(data: any): Promise<void> {
  if (!data) return
  if (Array.isArray(data.models)) {
    models.value = data.models
  } else if (data.model) {
    models.value = [data.model]
  }
  if (data.activeModelId) {
    activeModelId.value = data.activeModelId
    modelPath.value = [data.activeModelId]
  }
  await persist()
  notify('model', { action: 'import' })
}

async function exportData(): Promise<any> {
  return {
    models: toPlain(models.value),
    activeModelId: activeModelId.value,
    version: 1,
  }
}

function resetAll() {
  models.value = []
  activeModelId.value = null
  modelPath.value = []
  internalTab.value = 'dashboard'
  persist()
  notify('model', { action: 'reset' })
}

// ==================== 初始化 / 加载 ====================
let initialized = false

async function init(initialData?: any) {
  if (initialized) return
  initialized = true
  try {
    const saved = (await db.getItem('models')) as Model[] | null
    const savedActive = (await db.getItem('activeModelId')) as string | null
    if (Array.isArray(saved) && saved.length > 0) {
      models.value = saved
      const target = savedActive && saved.find((m) => m.id === savedActive)
        ? savedActive
        : saved[0].id
      activeModelId.value = target
      modelPath.value = [target]
      return
    }
  } catch (e) {
    console.warn('[DataCanvas] 读取存储失败', e)
  }
  // 无存储数据：使用外部 initialData 或创建默认模型
  if (initialData) {
    await importData(initialData)
  } else {
    const m = createModel('默认模型')
    setActiveModel(m.id)
  }
}

function refresh() {
  // 强制触发一次 change，供宿主刷新
  notify('model', { action: 'refresh' })
}

// ==================== 导出单例 API ====================
export function useDataCanvas() {
  return {
    // 状态
    config,
    models,
    activeModelId,
    modelPath,
    viewMode,
    internalTab,
    currentModelId,
    activeModel,
    isRoot,
    // 生命周期
    init,
    setConfig,
    refresh,
    // 模型
    getModelById,
    createModel,
    setActiveModel,
    updateModel,
    renameModel,
    deleteModel,
    // 子画布
    ensureSubModel,
    getSubModel,
    getParentSubCanvasNode,
    navigateTo,
    navigateBack,
    navigateRoot,
    pathNames,
    pathToModel,
    // 节点/连线
    addNode,
    updateNode,
    removeNode,
    addEdge,
    removeEdge,
    updateEdge,
    // 元数据
    updateMeta,
    // 导入导出
    importData,
    exportData,
    resetAll,
    // 宿主通知
    onChange,
    persist,
  }
}
