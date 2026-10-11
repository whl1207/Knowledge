// types.ts - 数据画布模块核心类型定义
// 遵循"数据隔离"原则：本模块拥有独立的类型体系，不依赖宿主系统数据模型

// ==================== 节点 ====================
export type NodeType = 'parameter' | 'table' | 'subcanvas' | 'sql' | 'variable' | 'chart'

export interface DcNode {
  id: string
  type: NodeType
  name: string
  x: number
  y: number
  width: number
  height: number
  data: Record<string, any> // 按节点类型存放特定数据
}

// ==================== 连线 ====================
export type EdgeType = 'dataflow' | 'relation'

export interface DcEdge {
  id: string
  type: EdgeType
  source: string
  target: string
  label?: string
}

// ==================== 模型 ====================
export interface BasicParam {
  key: string
  value: any
  type: 'string' | 'number' | 'boolean' | 'date'
  remark?: string
}

export interface FormField {
  id: string
  label: string
  type: 'text' | 'number' | 'date' | 'select' | 'textarea' | 'boolean'
  options?: string[]
  // 编辑用：下拉选项（逗号分隔文本）
  optionsText?: string
  required?: boolean
}

// 主页（数据看板）自由布局停靠锚点
// 四角：tl=左上  tr=右上  bl=左下  br=右下（两个方向都贴边）
// 四边：l=左  r=右  t=上  b=下（单边贴边，另一方向自由）
// 卡片尺寸固定（px）；位置为“停靠锚点 + 距锚点的偏移”，偏移为**固定像素**（缩放窗口时
// 距最近边界的像素距离保持不变；right/bottom 锚定在窗口缩放时自动保持贴边）
// z 为层级（越大越靠上，用于“底图+悬浮”）。旧版归一化坐标（x/y/w/h 0~1）在加载时自动迁移

export type DashboardAnchor = 'tl' | 'tr' | 'bl' | 'br' | 'l' | 'r' | 't' | 'b'

export interface DashboardLayoutItem {
  chartId: string
  anchor: DashboardAnchor
  // 距锚点的偏移（px，固定像素，不随窗口缩放）
  offsetX: number
  offsetY: number
  width: number
  height: number
  z: number
}

export type DashboardMode = 'flow' | 'free'

export interface ModelMeta {
  // 基础参数
  params: BasicParam[]
  // 表单字段定义
  formFields: FormField[]
  // 表单数据记录
  formRecords: Record<string, any>[]
  // 数据录入页标签顺序（节点 id 列表，可选）
  entryTabOrder?: string[]
  // 主页（数据看板）显示模式：flow=顺序排列，free=自定义拖放（可选）
  dashboardMode?: DashboardMode
  // 主页自由拖放布局（可选，随数据包导入导出）
  dashboardLayout?: DashboardLayoutItem[]
  // 主页当前全屏图表 id（可选，切换标签页后恢复）
  dashboardFullscreenId?: string
  // 主页自由模式是否锁定（锁定后图表不可移动/编辑，可选）
  dashboardLocked?: boolean
}

export interface Model {
  id: string
  name: string
  description?: string
  nodes: DcNode[]
  edges: DcEdge[]
  hierarchy: { parentId?: string; depth: number }
  meta?: ModelMeta
  updatedAt: number
}

// ==================== Props / 配置 ====================
export type ViewMode = 'full' | 'canvas' | 'entry' | 'dashboard'

export interface DcConfig {
  showImportExport?: boolean
  allowSubCanvas?: boolean
  maxDepth?: number
  initialData?: any
  theme?: 'light' | 'dark'
}

export interface DcChangeEvent {
  type: 'node' | 'edge' | 'data' | 'model'
  payload: any
}

export interface DcSaveEvent {
  model: Model | null
  models: Model[]
}

export interface DcChartClick {
  chartId: string
  series: string
  value: any
}

// ==================== 元数据（类型/连线展示配置） ====================
export const NODE_TYPE_META: Record<NodeType, { label: string; icon: string; color: string; width: number; height: number }> = {
  parameter: { label: '参数节点', icon: 'fa-cog', color: '#2196F3', width: 165, height: 100 },
  table: { label: '数据表', icon: 'fa-table', color: '#4CAF50', width: 200, height: 120 },
  subcanvas: { label: '子画布', icon: 'fa-cubes', color: '#9C27B0', width: 180, height: 104 },
  sql: { label: 'SQL节点', icon: 'fa-code', color: '#FF9800', width: 200, height: 50 },
  variable: { label: '变量节点', icon: 'fa-refresh', color: '#00BCD4', width: 180, height: 50 },
  chart: { label: '图表节点', icon: 'fa-line-chart', color: '#E91E63', width: 200, height: 120 },
}

export const EDGE_TYPE_META: Record<EdgeType, { label: string; color: string; dash: string }> = {
  dataflow: { label: '数据流', color: '#2196F3', dash: '' },
  relation: { label: '表关联', color: '#FF9800', dash: '6 4' },
}

export const NODE_TYPES: NodeType[] = ['parameter', 'table', 'subcanvas', 'sql', 'variable', 'chart']
export const EDGE_TYPES: EdgeType[] = ['dataflow', 'relation']

// 列录入方式（表单录入模式用）：数据表节点每一列的录入控件类型
export const COLUMN_INPUT_TYPES: { value: string; label: string }[] = [
  { value: 'text', label: '文本框' },
  { value: 'textarea', label: '多行文本' },
  { value: 'number', label: '数字' },
  { value: 'date', label: '日期' },
  { value: 'select', label: '选项' },
  { value: 'boolean', label: '布尔' },
]

// ==================== 工具 ====================
export function uid(prefix = 'n'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function createNode(type: NodeType, x: number, y: number, name?: string): DcNode {
  const meta = NODE_TYPE_META[type]
  const node: DcNode = {
    id: uid('node'),
    type,
    name: name || `${meta.label}-${Math.floor(Math.random() * 900 + 100)}`,
    x,
    y,
    width: meta.width,
    height: meta.height,
    data: {},
  }
  switch (type) {
    case 'parameter':
      node.data.params = []
      node.data.description = '' // 参数组使用说明（显示在数据录入界面参数组下方）
      break
    case 'table':
      node.data.columns = []
      node.data.rows = []
      node.data.columnTypes = {}
      // 表单录入模式相关
      node.data.formEntry = false // 是否启用表单录入模式
      node.data.titleField = '' // 数据标题字段（列名，互斥单选）
      node.data.columnInputs = {} // 每列录入方式：{ [列名]: { type, options, optionsText } }
      node.data.columnUnits = {} // 每列单位：{ [列名]: '单位' }（图表中数值显示单位）
      node.data.description = '' // 数据表使用说明（显示在数据录入界面数据面板上方）
      break
    case 'subcanvas':
      node.data.modelId = uid('m')
      node.data.exposed = [] // [{ nodeId, name }]
      break
    case 'sql':
      node.data.sql = 'SELECT * FROM 输入'
      node.data.sourceTables = []
      break
    case 'variable':
      node.data.formula = ''
      node.data.showInDashboard = false // 是否在主页（看板）中显示该变量的数值卡片
      node.data.unit = '' // 变量单位（主页数值卡片显示在数值后）
      break
    case 'chart':
      node.data.chartType = 'bar'
      node.data.title = '图表'
      node.data.xField = ''
      node.data.yField = ''
      node.data.labelField = ''
      node.data.valueField = ''
      // 是否在主页（看板）中显示该图表
      node.data.showInDashboard = true
      // 地图显示样式（GeoJSON 颜色 / 数据点样式与颜色）
      node.data.mapPointStyle = 'circle'
      node.data.mapPointColor = '#2196F3'
      node.data.geojsonFill = '#2196F3'
      node.data.geojsonStroke = '#4FC3F7'
      // 透明度（0~1）：GeoJSON 填充/边界、数据点
      node.data.geojsonFillOpacity = 0.45
      node.data.geojsonStrokeOpacity = 1
      break
  }
  return node
}
