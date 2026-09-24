<!-- src/components/workFlow/WorkflowCanvas.vue -->
<template>
  <div 
    class="canvas-container"
    ref="containerRef"
    @dragover.prevent="onDragOver"
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
    @mousemove="onMouseMove"
    @click="onCanvasClick"
    @contextmenu.prevent="onContextMenu"
    :class="{ 'drag-over': dragOverCanvas }"
  >
    <svg
      class="canvas"
      ref="svgRef"
      :width="svgWidth"
      :height="svgHeight"
      :style="{ backgroundColor: 'var(--backgroundColor)' }"
    >
      <defs>
        <marker id="arrow-head" viewBox="0 0 10 10" refX="8" refY="5"
          markerWidth="6" markerHeight="6" orient="auto"
          fill="var(--fontActiveColor)">
          <path d="M0,0 L10,5 L0,10 Z" />
        </marker>
      </defs>
      
      <g ref="groupRef" :transform="`translate(${transform.x},${transform.y}) scale(${transform.k})`">
        <!-- 连接线 -->
        <g class="links">
          <path v-for="link in links" :key="getLinkKey(link)"
            :d="getLinkPath(link)"
            :class="['link', link.branch ? 'branch-link' : '',
              isLinkHighlighted(link) ? 'link-highlight' : 'link-dim']"
            fill="none"
            :stroke="getLinkColor(link)"
            stroke-width="2"
            @dblclick.stop="$emit('delete-link', link)"
            @mouseenter="$emit('update:hoveredNodeId', link.source)"
            style="cursor:pointer;transition:stroke-opacity 0.15s;"
          />
          <!-- 连线中点箭头 -->
          <g v-for="link in links" :key="`arrow-${getLinkKey(link)}`"
            :transform="`translate(${getLinkMidpoint(link).x},${getLinkMidpoint(link).y}) rotate(${getLinkAngle(link)})`"
            @dblclick.stop="$emit('delete-link', link)"
            @mouseenter="$emit('update:hoveredNodeId', link.source)"
            style="cursor:pointer">
            <path d="M-7,-5 L7,0 L-7,5 Z"
              :fill="isLinkHighlighted(link) ? 'var(--fontActiveColor)' : 'var(--fontColor)'"
              :opacity="isLinkHighlighted(link) ? 1 : 0.4"
              pointer-events="all" />
          </g>
        </g>

        <!-- 临时连线 -->
        <g v-if="linking" class="temp-link">
          <path :d="tempLinkPath"
            fill="none" stroke="var(--fontActiveColor)" stroke-width="2"
            stroke-dasharray="5,5" opacity="0.6" />
        </g>

        <!-- 节点 -->
        <g class="nodes">
          <g v-for="node in nodes" :key="node.id"
            class="node"
            :transform="`translate(${node.x},${node.y})`"
            @mousedown.stop="onNodeMouseDown(node.id, $event)"
            @contextmenu.stop="onNodeContextMenu(node.id, $event)"
            @mouseenter="$emit('update:hoveredNodeId', node.id)"
            @mouseleave="$emit('update:hoveredNodeId', null)"
            style="cursor:move"
          >
            <!-- 节点背景 -->
            <rect
              :width="node.width" :height="node.height"
              :fill="getNodeFill(node)"
              :stroke="getNodeStroke(node)"
              stroke-width="2"
              rx="6" ry="6"
            />
            
            <!-- 节点头部 -->
            <rect :width="node.width" height="22" :fill="getNodeHeaderColor(node)" rx="6" ry="6" />
            <rect :y="18" :width="node.width" height="4" :fill="getNodeHeaderColor(node)" />
            
            <!-- 节点图标和名称 -->
            <text :x="14" :y="15" text-anchor="middle" font-size="11" fill="white"
              font-family="FontAwesome">
              {{ getNodeIconChar(node) }}
            </text>
            
            <!-- ... simplified - will use foreignObject for rich rendering -->
            <foreignObject :x="25" :y="4" :width="node.width - 35" height="15">
              <div style="color:white;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:15px">
                {{ truncateText(node.name, 18) }}
              </div>
            </foreignObject>

            <!-- 删除按钮 -->
            <g class="delete-btn" :transform="`translate(${node.width - 12}, 11)`" @mousedown.stop @click.stop="$emit('delete-node', node.id)"
              style="cursor:pointer;opacity:0;">
              <circle cx="0" cy="0" r="7" fill="#f44336" />
              <text x="0" y="3" text-anchor="middle" font-size="10" fill="white">×</text>
            </g>

            <!-- 节点内容摘要（按节点实际宽高自然裁剪、铺满内容区，超出部分以省略号收尾） -->
            <foreignObject x="8" :y="24" :width="node.width - 16" :height="node.height - 36">
              <div
                class="node-summary"
                :style="{ WebkitLineClamp: getContentLineCount(node) }"
                v-html="getNodeDisplayText(node)"
              ></div>
            </foreignObject>

            <!-- 状态指示器 -->
            <circle 
              :cx="node.width - 8" :cy="node.height - 8" r="4"
              :fill="getStatusColor(node.status)" stroke="white" stroke-width="1"
            />

            <!-- ====== 通用端口系统（基于 HandleDef 配置） ====== -->

            <!-- 左侧输入端口 -->
            <template v-for="(handle, idx) in getInputHandles(node)" :key="handle.id">
              <g class="connector input-handle"
                :transform="getInputHandleTransform(node, idx)"
                @mousedown.stop
                @click.stop="$emit('connector-click', node.id, handle.id, $event)"
                :title="handle.label"
              >
                <circle cx="0" cy="0" r="7"
                  :fill="getHandleStyle('input', node.type).fill"
                  :stroke="getHandleStyle('input', node.type).stroke"
                  stroke-width="1.5" />
                <text x="0" y="3" text-anchor="middle" font-size="7" fill="#666">
                  ▶
                </text>
              </g>
            </template>

            <!-- 右侧输出端口 -->
            <template v-for="(handle, idx) in getOutputHandles(node)" :key="handle.id">
              <g class="connector output-handle"
                :transform="getOutputHandleTransform(node, idx, getOutputHandles(node).length)"
                @mousedown.stop
                @click.stop="onOutputHandleClick(node, handle, $event)"
                :title="handle.label"
                style="cursor:crosshair"
              >
                <circle cx="0" cy="0" r="7"
                  :fill="getHandleStyle('output', node.type).fill"
                  :stroke="getHandleStyle('output', node.type).stroke"
                  stroke-width="1.5" />
                <!-- 端口标签 -->
                <text x="14" y="3" text-anchor="start" font-size="8" fill="var(--fontColor)"
                  style="pointer-events:none;user-select:none;">
                  {{ handle.label }}
                </text>
              </g>
            </template>

            <!-- 右下角调整大小手柄 -->
            <g class="resize-handle" :transform="`translate(${node.width - 24}, ${node.height - 24})`"
              style="pointer-events: all; cursor: se-resize;"
              @mousedown.stop.prevent="onResizeHandleMouseDown(node.id, $event)">
              <rect x="0" y="0" width="24" height="24" fill="transparent" pointer-events="all"
                @mousedown.stop.prevent="onResizeHandleMouseDown(node.id, $event)" />
            </g>
          </g>
        </g>
      </g>
    </svg>

    <div class="canvas-status" v-if="linking">
      <div class="status-indicator">
        <i class="fa fa-link"></i>
        <span>{{ linkSourceId !== null ? t('select_target') : t('select_source') }}</span>
      </div>
    </div>
    
    <div v-if="dragOverCanvas" class="drop-indicator">
      <div class="drop-indicator-content">
        <i class="fa fa-plus-circle"></i>
        <span>{{ t('drag_to_add') }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import * as d3 from 'd3'
import type { NodeData, Link, ViewTransform, OperationMode, Position, NodeType, ConnectorPosition, HandleDef, HandleStyle } from '@/components/workFlow/WorkflowTypes'
import { getNodeColorByType, getNodeIconByType, getStatusColor } from '@/components/workFlow/WorkflowDefaults'
import { getInputHandles, getOutputHandles, getHandleStyle, TITLE_HEIGHT } from '@/components/workFlow/WorkflowTypes'

const props = defineProps<{
  t: (key: string) => string
  nodes: NodeData[]
  links: Link[]
  selectedNodeId: number | null
  hoveredNodeId: number | null
  linking: boolean
  linkSourceId: number | null
  linkSourcePort: string | null
  linkSourceBranch: string | null
  linkSourceStartPort: string | null
  operationMode: OperationMode
  transform: ViewTransform
  mousePos: Position
  scale: number
}>()

const emit = defineEmits<{
  'update:selectedNodeId': [id: number | null]
  'update:hoveredNodeId': [id: number | null]
  'update:linking': [v: boolean]
  'update:linkSourceId': [id: number | null]
  'update:linkSourcePort': [port: string | null]
  'update:linkSourceBranch': [branch: string | null]
  'update:linkSourceStartPort': [port: string | null]
  'update:operationMode': [mode: OperationMode]
  'update:mousePos': [pos: Position]
  'update:transform': [t: ViewTransform]
  'update:scale': [s: number]
  'connector-click': [nodeId: number, pos: ConnectorPosition, event: MouseEvent]
  'node-resize-start': [nodeId: number, event: MouseEvent]
  'branch-click': [nodeId: number, branchId: string, event: MouseEvent]
  'file-port-click': [nodeId: number, portId: string, event: MouseEvent]
  'start-port-click': [nodeId: number, portType: 'prompt', event: MouseEvent]
  'delete-node': [nodeId: number]
  'delete-link': [link: Link]
  'canvas-click': []
  'context-menu': [event: MouseEvent]
  'node-context-menu': [nodeId: number, event: MouseEvent]
  'node-drag-start': [nodeId: number, event: MouseEvent]
  'drag-over': []
  'drag-leave': []
  'drop-node': [type: string, event: DragEvent]
  'drop-files': [event: DragEvent]
  'zoom-change': [scale: number]
}>()

const containerRef = ref<HTMLElement>()
const svgRef = ref<SVGSVGElement>()
const svgWidth = ref(2000)
const svgHeight = ref(2000)
const dragOverCanvas = ref(false)
const dropPoint = ref<{ x: number; y: number } | null>(null)

let svg: d3.Selection<SVGSVGElement, unknown, null, undefined>
let zoom: d3.ZoomBehavior<SVGSVGElement, unknown>
// 标志位：区分变换来自 d3 内部（用户拖动/缩放）还是外部（autoFitCanvas 等）
let isInternalZoomUpdate = false

const tempLinkPath = computed(() => {
  if (!props.linkSourceId) return ''
  const source = props.nodes.find(n => n.id === props.linkSourceId)
  if (!source) return ''

  // 优先使用 linkSourceBranch 构造分支端口 ID，否则用 linkSourcePort（默认 'output'）
  const handleId = props.linkSourceBranch
    ? `branch_${props.linkSourceBranch}`
    : (props.linkSourcePort || 'output')
  const startPos = getHandlePosition(source, handleId, 'output')

  const endX = props.mousePos.x
  const endY = props.mousePos.y
  const { dx, dy } = getLinkControlOffset(startPos.x, startPos.y, endX, endY)

  return `M ${startPos.x},${startPos.y} C ${startPos.x + dx},${startPos.y + dy} ${endX - dx},${endY - dy} ${endX},${endY}`
})

onMounted(() => {
  if (!svgRef.value) return
  svg = d3.select(svgRef.value)
  zoom = d3.zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.1, 5])
    .on('zoom', (event) => {
      isInternalZoomUpdate = true
      const t = event.transform
      emit('update:transform', { x: t.x, y: t.y, k: t.k })
      emit('update:scale', t.k)
    })
  // Load saved view state
  try {
    const saved = localStorage.getItem('workflow_view')
    if (saved) {
      const vs = JSON.parse(saved)
      if (vs.transform) {
        const identity = d3.zoomIdentity.translate(vs.transform.x, vs.transform.y).scale(vs.transform.k)
        svg.call(zoom.transform, identity)
      }
    }
  } catch {}
  svg.call(zoom)
  window.addEventListener('resize', updateSize)
  nextTick(updateSize)
})

// 监听外部 transform 变化（如 autoFitCanvas），同步 d3 内部状态
watch(() => props.transform, (newTransform) => {
  if (isInternalZoomUpdate) {
    isInternalZoomUpdate = false
    return
  }
  if (svg && zoom) {
    const identity = d3.zoomIdentity.translate(newTransform.x, newTransform.y).scale(newTransform.k)
    svg.call(zoom.transform, identity)
  }
}, { deep: true })

onBeforeUnmount(() => {
  try {
    const state = { transform: props.transform, scale: props.scale, lastSaved: new Date().toISOString() }
    localStorage.setItem('workflow_view', JSON.stringify(state))
  } catch {}
  if (svg) svg.on('.zoom', null)
  window.removeEventListener('resize', updateSize)
})

const updateSize = () => {
  if (!containerRef.value) return
  const rect = containerRef.value.getBoundingClientRect()
  svgWidth.value = rect.width
  svgHeight.value = rect.height
}

const getDropCoordinates = (event: DragEvent) => {
  const transform = props.transform || { x: 0, y: 0, k: 1 }
  const rect = containerRef.value?.getBoundingClientRect()
  if (!rect) return { x: 200, y: 200 }
  const localX = dropPoint.value?.x ?? (event.clientX - rect.left)
  const localY = dropPoint.value?.y ?? (event.clientY - rect.top)
  return {
    x: (localX - transform.x) / transform.k,
    y: (localY - transform.y) / transform.k
  }
}

const onDrop = (event: DragEvent) => {
  dragOverCanvas.value = false
  const files = event.dataTransfer?.files
  
  // 直接使用 event 坐标计算
  const rect = containerRef.value?.getBoundingClientRect()
  if (!rect) return
  
  const mouseX = event.clientX - rect.left
  const mouseY = event.clientY - rect.top
  
  // 转换为画布坐标系（考虑缩放和偏移）
  const x = (mouseX - props.transform.x) / props.transform.k
  const y = (mouseY - props.transform.y) / props.transform.k
  
  if (files && files.length > 0) {
    emit('drop-files', event)
    return
  }
  const type = event.dataTransfer?.getData('text/plain')
  if (type) emit('drop-node', type, event)
}

const onCanvasClick = (event: MouseEvent) => {
  const target = event.target as Element
  const isSpecial = target.closest('.connector') || target.closest('.node') || 
    target.closest('.link') || target.closest('.delete-btn')
  if (!isSpecial) emit('canvas-click')
}

const onContextMenu = (event: MouseEvent) => emit('context-menu', event)

const onNodeMouseDown = (nodeId: number, event: MouseEvent) => {
  const target = event.target as Element
  if (target.closest('.connector') || target.closest('.delete-btn') || target.closest('.resize-handle')) {
    event.stopPropagation()
    return
  }
  if (props.operationMode === 'linking') { event.stopPropagation(); return }
  emit('update:selectedNodeId', nodeId)
  emit('node-drag-start', nodeId, event)
}

const onNodeContextMenu = (nodeId: number, event: MouseEvent) => {
  emit('node-context-menu', nodeId, event)
}

function onResizeHandleMouseDown(nodeId: number, event: MouseEvent) {
  if (props.operationMode === 'linking') { event.stopPropagation(); return }
  emit('node-resize-start', nodeId, event)
}

const onMouseMove = (event: MouseEvent) => {
  if (!props.linking || !props.linkSourceId) return
  const rect = containerRef.value?.getBoundingClientRect()
  if (!rect) return
  const x = (event.clientX - rect.left - props.transform.x) / props.transform.k
  const y = (event.clientY - rect.top - props.transform.y) / props.transform.k
  emit('update:mousePos', { x, y })
}

const onDragOver = (event: DragEvent) => {
  dragOverCanvas.value = true
  const rect = containerRef.value?.getBoundingClientRect()
  if (!rect) return
  dropPoint.value = {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  }
  emit('drag-over')
}

const onDragLeave = () => {
  dragOverCanvas.value = false
  dropPoint.value = null
  emit('drag-leave')
}

const getLinkKey = (link: Link) => `${link.source}-${link.target}${link.branch ? '-'+link.branch : ''}${link.sourcePort ? '-'+link.sourcePort : ''}`

/** 返回贝塞尔曲线控制点偏移向量（始终水平，适用于从左到右的工作流连线） */
function getLinkControlOffset(sx: number, sy: number, ex: number, ey: number): { dx: number; dy: number } {
  const dx = ex - sx, dy = ey - sy
  const absDx = Math.abs(dx), absDy = Math.abs(dy)
  // 始终水平贝塞尔：控制点在 X 方向延伸
  // 延伸量 = max(水平距离的一半, 垂直落差的 30%, 最小 30px)
  // 垂直落差越大，水平延伸越多，曲线越平滑（解决高节点连线难看的问题）
  const offsetX = Math.max(absDx * 0.5, absDy * 0.3, 30)
  return { dx: offsetX, dy: 0 }
}

const getLinkPath = (link: Link): string => {
  const source = props.nodes.find(n => n.id === link.source)
  const target = props.nodes.find(n => n.id === link.target)
  if (!source || !target) return ''

  const srcPos = getHandlePosition(source, link.sourcePort || 'output', 'output')
  const tgtPos = getHandlePosition(target, link.targetPort || 'input', 'input')

  const sx = srcPos.x, sy = srcPos.y
  const ex = tgtPos.x, ey = tgtPos.y
  const { dx, dy } = getLinkControlOffset(sx, sy, ex, ey)

  return `M ${sx},${sy} C ${sx + dx},${sy + dy} ${ex - dx},${ey - dy} ${ex},${ey}`
}

/** 获取指定端口在画布上的绝对坐标 */
const getHandlePosition = (node: NodeData, handleId: string, type: 'input' | 'output'): { x: number; y: number } => {
  const availH = node.height - TITLE_HEIGHT  // 扣除标题区域
  if (type === 'input') {
    const handles = getInputHandles(node)
    const idx = handles.findIndex(h => h.id === handleId)
    if (idx >= 0) {
      const count = handles.length
      const spacing = availH / (count + 1)
      return { x: node.x, y: node.y + TITLE_HEIGHT + (idx + 1) * spacing }
    }
    return { x: node.x + node.width / 2, y: node.y }
  }

  // output（统一右侧垂直排列）
  const handles = getOutputHandles(node)
  const idx = handles.findIndex(h => h.id === handleId)
  if (idx >= 0) {
    const count = handles.length
    const spacing = availH / (count + 1)
    return { x: node.x + node.width, y: node.y + TITLE_HEIGHT + (idx + 1) * spacing }
  }
  return { x: node.x + node.width / 2, y: node.y + node.height }
}

const getConnectorColor = (node: NodeData, type: 'bottom'): string => {
  if (props.linkSourceId === node.id) return 'var(--fontActiveColor)'
  if (props.hoveredNodeId === node.id) return 'var(--fontActiveColor)'
  if (props.operationMode === 'linking' && props.linkSourceId !== null) return 'rgba(var(--fontActiveColor-rgb,33,150,243),0.8)'
  return 'rgba(var(--fontActiveColor-rgb,33,150,243),0.3)'
}

/** 判断连线是否应高亮（悬停节点相关的连线） */
const isLinkHighlighted = (link: Link): boolean => {
  if (props.hoveredNodeId === null) return true // 无悬停时全部正常显示
  return link.source === props.hoveredNodeId || link.target === props.hoveredNodeId
}

/** 获取连线颜色（高亮时加亮） */
const getLinkColor = (link: Link): string => {
  if (props.hoveredNodeId === null) return 'var(--borderColor)'
  if (isLinkHighlighted(link)) return 'var(--fontActiveColor)'
  return 'var(--borderColor)'
}

const getNodeFill = (node: NodeData): string => {
  return node.status === 'running' ? 'rgba(33,150,243,0.08)' : 'var(--backgroundColor)'
}

const getNodeStroke = (node: NodeData): string => {
  if (props.selectedNodeId === node.id) return 'var(--fontActiveColor)'
  if (props.hoveredNodeId === node.id) return 'var(--fontActiveColor)'
  if (node.status === 'success') return '#4CAF50'
  if (node.status === 'error') return '#f44336'
  if (node.status === 'running') return '#2196F3'
  return 'var(--borderColor)'
}

const getNodeHeaderColor = (node: NodeData): string => getNodeColorByType(node.type)

const getNodeIconChar = (node: NodeData): string => {
  // FontAwesome unicode mappings - return actual character
  const map: Record<string, string> = {
    'fa-play-circle': '\u{f144}',
    'fa-flag-checkered': '\u{f11e}',
    'fa-tag': '\u{f02b}',
    'fa-file-text': '\u{f15c}',
    'fa-search': '\u{f002}',
    'fa-globe': '\u{f0ac}',
    'fa-microchip': '\u{f2db}',
    'fa-code-fork': '\u{f126}',
    'fa-code': '\u{f121}',
    'fa-database': '\u{f1c0}',
    'fa-table': '\u{f0ce}',
    'fa-plug': '\u{f1e6}',
    'fa-sitemap': '\u{f0e8}',
    'fa-repeat': '\u{f01e}',
    'fa-object-group': '\u{f247}',
    'fa-list': '\u{f03a}',
    'fa-file-excel-o': '\u{f1c3}',
    'fa-android': '\u{f17b}',
    'fa-file-word-o': '\u{f1c2}',
    'fa-circle': '\u{f111}'
  }
  return map[getNodeIconByType(node.type)] || '\u{f111}'
}

const truncateText = (text: string, max: number = 120): string => {
  if (!text || text.length <= max) return text
  return text.substring(0, max - 3) + '...'
}

/** 节点正文内容区顶部起始 y（标题栏 22px + 2px 间隔） */
const CONTENT_TOP = 24
/** 内容区底部为状态圆点/节点圆角预留的高度 */
const CONTENT_BOTTOM_PAD = 12
/** 内容行高：字号 10px × 行高 1.4（需与 .node-summary 的 CSS 保持一致） */
const CONTENT_LINE_H = 14

/** 根据节点高度计算内容区可完整显示的行数（与 CSS -webkit-line-clamp 同步） */
const getContentLineCount = (node: NodeData): number => {
  const avail = node.height - CONTENT_TOP - CONTENT_BOTTOM_PAD
  return Math.max(1, Math.floor(avail / CONTENT_LINE_H))
}

/** 根据节点宽高估算摘要文本上限：节点越大可容纳越多字符，
 *  既保证长文本能“铺满”大节点，又避免把超大文本全部塞进 DOM 造成渲染开销；
 *  实际可视裁剪由 CSS -webkit-line-clamp 精确完成 */
const getNodeTextCap = (node: NodeData): number => {
  const lines = getContentLineCount(node)
  // 按较窄的半角字符宽度(~5px)估算：宁可多给一些字符让 CSS 裁掉，
  // 也不因估算过宽导致大节点底部出现“可避免的”留白
  const charsPerLine = Math.max(20, Math.floor((node.width - 20) / 5))
  return Math.max(300, Math.min(30000, Math.ceil(lines * charsPerLine * 1.15) + 24))
}

/** 按节点尺寸截取文本（作为 DOM 安全上限，展示细节交给 CSS 省略号） */
const limitForNode = (text: string, node: NodeData): string => truncateText(text, getNodeTextCap(node))

const getNodeDisplayText = (node: NodeData): string => {
  if (!node.result) return ''
  try {
    const parsed = JSON.parse(node.result)
    if (parsed && typeof parsed === 'object') {
      if (node.type === 'local' && parsed.success) {
        return parsed.mode === 'template'
          ? `模板模式 | ${Object.keys(parsed.slices || {}).length} 个切片`
          : (parsed.content ? limitForNode(parsed.content, node) : '完整文件')
      }
      if (node.type === 'knowledge' && parsed.type === 'knowledge_retrieval' && parsed.success) {
        const blocks = parsed.relevantBlocks || []
        const preview = blocks.map((b: any) => b.content || '').join('\n---\n')
        return limitForNode(preview || `${blocks.length} 个片段`, node)
      }
      if (node.type === 'decision' && parsed.success) {
        const mode = parsed.mode === 'llm' ? 'LLM' : '规则'
        return `[${mode}] → ${parsed.selectedBranchName || parsed.selectedBranch}\n${parsed.reason ? limitForNode(parsed.reason, node) : ''}`
      }
      if (node.type === 'structured' && parsed.success) {
        const rc = node.structuredData?.length || 0
        const cc = node.structuredColumns?.length || 0
        return parsed.result ? limitForNode(parsed.result, node) : `${rc}行 × ${cc}列`
      }
      if (node.type === 'mcp' && parsed.success) {
        const content = typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result)
        return limitForNode(content, node)
      }
      if (node.type === 'start' && parsed.success) {
        return limitForNode(parsed.result || node.prompt, node)
      }
      if (node.type === 'end' && parsed.success) {
        const results = parsed.aggregated_results || {}
        const keys = Object.keys(results)
        return `汇总 ${keys.length} 个节点结果`
      }
      if (node.type === 'iteration' && parsed.success) {
        const out = parsed.output
        const n = Array.isArray(out) ? out.length : 0
        return `迭代完成：${parsed.count ?? 0} 项 / 成功 ${parsed.succeeded ?? 0} 项${n ? `\n输出 ${n} 项` : ''}`
      }
      if (node.type === 'aggregator' && parsed.success) {
        const n = parsed.count ?? 0
        return `聚合结果：${n} 项`
      }
      if (node.type === 'list' && parsed.success) {
        return `列表操作：${parsed.count ?? 0} 项${parsed.first !== undefined && parsed.first !== null ? `\n首项: ${limitForNode(String(parsed.first), node)}` : ''}`
      }
      if (node.type === 'data' && parsed.success) {
        const rowsN = Array.isArray(parsed.rows) ? parsed.rows.length : 0
        const loaded = rowsN < (parsed.total ?? 0) ? `（显示前 ${rowsN} 行）` : ''
        return `数据读取：共 ${parsed.total ?? 0} 行${parsed.headers?.length ? `（${parsed.headers.length} 列）` : ''}${loaded}`
      }
      if (node.type === 'agent' && parsed.success) {
        return limitForNode(parsed.output || parsed.result || '', node)
      }
      if (node.type === 'word' && parsed.success) {
        return `已导出：${parsed.path || ''}${parsed.sizeKb ? `（${parsed.sizeKb} KB）` : ''}`
      }
      if (parsed.result !== undefined) {
        const s = typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result)
        return limitForNode(s, node)
      }
      const displayable = ['data', 'text', 'output', 'message', 'content']
      for (const key of displayable) {
        if (parsed[key] !== undefined) {
          const s = typeof parsed[key] === 'string' ? parsed[key] : JSON.stringify(parsed[key])
          return limitForNode(s, node)
        }
      }
      return limitForNode(JSON.stringify(parsed, null, 2), node)
    }
  } catch {}
  return limitForNode(node.result, node)
}

// 计算贝塞尔曲线中点位置
const getLinkMidpoint = (link: Link): { x: number; y: number } => {
  const source = props.nodes.find(n => n.id === link.source)
  const target = props.nodes.find(n => n.id === link.target)
  if (!source || !target) return { x: 0, y: 0 }
  const srcPos = getHandlePosition(source, link.sourcePort || 'output', 'output')
  const tgtPos = getHandlePosition(target, link.targetPort || 'input', 'input')
  const sx = srcPos.x, sy = srcPos.y, ex = tgtPos.x, ey = tgtPos.y
  const { dx: cdx, dy: cdy } = getLinkControlOffset(sx, sy, ex, ey)

  const t = 0.5
  const cx1 = sx + cdx, cy1 = sy + cdy
  const cx2 = ex - cdx, cy2 = ey - cdy

  const x = Math.pow(1 - t, 3) * sx + 3 * Math.pow(1 - t, 2) * t * cx1 + 3 * (1 - t) * Math.pow(t, 2) * cx2 + Math.pow(t, 3) * ex
  const y = Math.pow(1 - t, 3) * sy + 3 * Math.pow(1 - t, 2) * t * cy1 + 3 * (1 - t) * Math.pow(t, 2) * cy2 + Math.pow(t, 3) * ey
  return { x, y }
}

// 计算贝塞尔曲线中点处的切线角度（度）
const getLinkAngle = (link: Link): number => {
  const source = props.nodes.find(n => n.id === link.source)
  const target = props.nodes.find(n => n.id === link.target)
  if (!source || !target) return 0
  const srcPos = getHandlePosition(source, link.sourcePort || 'output', 'output')
  const tgtPos = getHandlePosition(target, link.targetPort || 'input', 'input')
  const sx = srcPos.x, sy = srcPos.y, ex = tgtPos.x, ey = tgtPos.y
  const { dx: cdx, dy: cdy } = getLinkControlOffset(sx, sy, ex, ey)

  const t = 0.5
  const cx1 = sx + cdx, cy1 = sy + cdy
  const cx2 = ex - cdx, cy2 = ey - cdy

  const dx = 3 * Math.pow(1 - t, 2) * (cx1 - sx) + 6 * (1 - t) * t * (cx2 - cx1) + 3 * Math.pow(t, 2) * (ex - cx2)
  const dy = 3 * Math.pow(1 - t, 2) * (cy1 - sy) + 6 * (1 - t) * t * (cy2 - cy1) + 3 * Math.pow(t, 2) * (ey - cy2)
  return Math.atan2(dy, dx) * (180 / Math.PI)
}

// ── 基于 HandleDef 的端口辅助方法 ─────────────────────────

/** 计算输入端口在节点上的位置（左侧分布，扣除标题高度） */
const getInputHandleTransform = (node: NodeData, idx: number): string => {
  const handles = getInputHandles(node)
  const count = handles.length
  const availH = node.height - TITLE_HEIGHT
  const spacing = availH / (count + 1)
  return `translate(0, ${TITLE_HEIGHT + (idx + 1) * spacing})`
}

/** 计算输出端口在节点上的位置（右侧分布，扣除标题高度） */
const getOutputHandleTransform = (node: NodeData, idx: number, totalCount: number): string => {
  const availH = node.height - TITLE_HEIGHT
  const spacing = availH / (totalCount + 1)
  return `translate(${node.width}, ${TITLE_HEIGHT + (idx + 1) * spacing})`
}

/** 点击输出端口时的处理 */
const onOutputHandleClick = (node: NodeData, handle: HandleDef, event: MouseEvent) => {
  event.stopPropagation()
  // 转换为画布坐标系（与 onMouseMove 中的转换一致）
  const rect = containerRef.value?.getBoundingClientRect()
  const x = rect
    ? (event.clientX - rect.left - props.transform.x) / props.transform.k
    : event.clientX
  const y = rect
    ? (event.clientY - rect.top - props.transform.y) / props.transform.k
    : event.clientY
  const pos = { x, y }
  emit('update:mousePos', pos)

  if (props.operationMode === 'linking') {
    if (props.linkSourceId === null) {
      // 开始连线
      emit('update:linkSourceId', node.id)
      emit('update:linkSourcePort', handle.id)
      emit('update:linkSourceBranch', null)
      emit('update:linkSourceStartPort', null)
      emit('update:linking', true)
    } else if (props.linkSourceId !== node.id) {
      // 完成连线（点击目标节点的输入端口）
      emit('connector-click', node.id, handle.id, event)
    } else {
      // 点击同一个节点，取消
      emit('update:linkSourceId', null)
      emit('update:linking', false)
    }
  } else {
    emit('update:linkSourceId', node.id)
    emit('update:linkSourcePort', handle.id)
    emit('update:linking', true)
  }
}
</script>

<style scoped>
.canvas-container {
  flex: 1;
  overflow: hidden;
  position: relative;
  background-color: var(--backgroundColor);
  transition: background-color 0.2s;
  user-select: none;
  -webkit-user-select: none;
}
.canvas-container.drag-over {
  background-color: rgba(var(--fontActiveColor-rgb,33,150,243),0.05);
}
.canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: default;
}
.canvas-status {
  position: absolute;
  top: 5px;
  right: 5px;
  color: white;
  padding: 0px;
  font-size: 11px;
  z-index: 100;
}
.status-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  background-color: rgba(33,150,243,0.1);
  color: #2196F3;
}
.drop-indicator {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%,-50%);
  z-index: 10;
  pointer-events: none;
}
.drop-indicator-content {
  background-color: rgba(33,150,243,0.9);
  color: white;
  padding: 12px 24px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
  font-weight: 500;
}

.resize-handle {
  cursor: se-resize;
}

.link {
  pointer-events: visibleStroke;
  cursor: pointer;
  transition: stroke 0.2s, stroke-opacity 0.2s, stroke-width 0.2s;
}
.link:hover {
  stroke: var(--fontActiveColor) !important;
  stroke-width: 3;
}
.link-dim {
  stroke-opacity: 0.15;
}
.link-highlight {
  stroke-width: 3;
  filter: drop-shadow(0 0 4px rgba(var(--fontActiveColor-rgb,33,150,243),0.4));
}
.branch-link { stroke-dasharray: 5,5; stroke-linecap: round; }
.branch-link:hover { stroke-width: 3; stroke-dasharray: none; }

.connector circle { pointer-events: all; transition: fill 0.2s; }
.connector:hover circle { fill: var(--fontActiveColor) !important; }
.connector.branch circle, .connector.file-port circle, .connector.file-default circle { opacity: 0.7; }
.connector.branch:hover circle, .connector.file-port:hover circle, .connector.file-default:hover circle { opacity: 1; }

.node:hover .delete-btn { opacity: 1 !important; }
.delete-btn { transition: opacity 0.2s; }

/* 节点正文摘要：随节点尺寸自然换行铺满内容区，超出可用行数以省略号收尾 */
.node-summary {
  font-size: 10px;
  color: var(--fontColor);
  line-height: 14px;
  word-break: break-all;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
