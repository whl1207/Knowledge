<!-- KnowledgeGraphViewer.vue - 知识图谱可视化 -->
<template>
  <div class="graph-viewer" ref="containerRef">
    <svg ref="svgRef" class="graph-svg" @click="onGraphClick"></svg>
    
    <!-- 节点详情浮窗 -->
    <div class="node-tooltip" v-show="tooltipVisible" :style="tooltipStyle">
      <div class="tooltip-title">
        <span class="tooltip-dot" :class="tooltipNode?.color"></span>
        {{ tooltipNode?.label }}
      </div>
      <div class="tooltip-type">{{ getNodeTypeText(tooltipNode?.type) }}</div>
      <div class="tooltip-url" v-if="tooltipNode?.url">
        <span class="field-key">{{ isEn ? 'Source' : '来源' }}:</span>
        <span class="field-value">{{ tooltipNode.url }}</span>
      </div>
      <div class="tooltip-desc" v-if="tooltipNode?.data">
        <div v-for="(value, key) in tooltipNode.data" :key="key" class="tooltip-field">
          <span class="field-key">{{ key }}:</span>
          <span class="field-value">{{ value }}</span>
        </div>
      </div>
    </div>
    
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick, computed } from 'vue'
import * as d3 from 'd3'
import { usestore } from '@/store'

interface GraphNode {
  id: string
  label: string
  type: 'source' | 'file' | 'data' | 'agent' | 'mcp'
  color: 'green' | 'blue' | 'orange' | 'red' | 'gray' | 'purple'
  data?: any
  sourceId?: string
  source?: any
  url?: string
  x?: number
  y?: number
}

interface GraphEdge {
  id: string
  source: string
  target: string
  type: string
  label: string
}

const props = defineProps<{
  graphData: { nodes: GraphNode[]; edges: GraphEdge[] }
}>()

const emit = defineEmits<{
  (e: 'node-click', node: GraphNode): void
}>()

const containerRef = ref<HTMLElement | null>(null)
const svgRef = ref<SVGSVGElement | null>(null)
const tooltipVisible = ref(false)
const tooltipNode = ref<GraphNode | null>(null)
const tooltipStyle = ref({})

// 图谱是共用组件：tooltip 文案（字段名 / 节点类型名）跟随界面语言
const store = usestore()
const isEn = computed(() => store.locales === 'en')

const nodes = ref<GraphNode[]>([])
const edges = ref<GraphEdge[]>([])

let svg: d3.Selection<SVGSVGElement, unknown, null, undefined> | null = null
let g: d3.Selection<SVGGElement, unknown, null, undefined> | null = null
let zoom: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null
let simulation: d3.Simulation<d3.SimulationNodeDatum, undefined> | null = null
let edgesG: d3.Selection<SVGGElement, unknown, null, undefined> | null = null
let nodesG: d3.Selection<SVGGElement, unknown, null, undefined> | null = null
let labelsG: d3.Selection<SVGGElement, unknown, null, undefined> | null = null
let width = 0
let height = 0
let isLargeGraph = false    // 节点数超过阈值时启用大图优化模式
let tickRafId: number | null = null  // RAF 手柄
let pendingTick = false              // 是否有待执行的 tick 更新

// ==================== 自动适配视图（包含所有节点 + 居中） ====================
// 需求：布局完成后把整张图框进可视区，避免节点跑到标签页外面看不到。
// 规则：
//   ● 「允许自动适配」默认开启；用户自己缩放 / 平移 / 拖动节点后关闭（不跟用户抢视图）；
//   ● 首图渲染、结构变化（新增节点）、大图模式切换、容器尺寸变化（含面板从隐藏变可见）时重新开启；
//   ● **只在布局收敛（simulation end，alpha < alphaMin）后适配一次**，
//     不在布局过程中反复框视图 —— 那样每框一次都会中断观看（曾出现过抖动）。
let autoFitArmed = true
let autoFitTimer: ReturnType<typeof setTimeout> | null = null
// 上一次观测到的容器尺寸：用于识别「面板从隐藏变可见」与「真尺寸变化」
let lastW = 0
let lastH = 0
let resizeObserver: ResizeObserver | null = null

// ==================== 增量数据（复用同一批节点/边对象，避免整图重新初始化） ====================
// 每次 props 变化都把数据“重建”一遍会让整张图重排（不断闪烁）：
// 这里把节点/边对象长期保留——新节点直接 push 进来、消失的节点移除，已有的坐标/速度不动；
// 布局只在“结构发生变化”时小幅加热（新节点滑入），仅属性变化（颜色/标签/计数）不重启仿真。
let simNodes: any[] = []
let simLinks: any[] = []
const nodeIndex = new Map<string, any>()
const simLinkIndex = new Map<string, any>()

// ==================== 颜色映射 ====================
const getNodeColor = (color: string): string => {
  const colors: Record<string, string> = {
    green: '#4CAF50',
    blue: '#2196F3',
    orange: '#FF9800',
    red: '#E53935',
    gray: '#9E9E9E',
    purple: '#9C27B0'
  }
  return colors[color] || '#999'
}

const getNodeTypeText = (type?: string): string => {
  const zh = !isEn.value
  const types: Record<string, string> = zh
    ? { source: '网页信源', file: '原始文件', data: '数据实体', agent: '智能体', mcp: 'MCP 服务' }
    : { source: 'Web source', file: 'Source file', data: 'Data entity', agent: 'Agent', mcp: 'MCP service' }
  return type ? types[type] || type : (zh ? '未知' : 'Unknown')
}

// ==================== 位置更新函数（大图模式下用 RAF 节流） ====================
const applyPositions = () => {
  if (!g) return
  // 大图模式下用 class 选择器 + 单次批量更新
  const edgeLines = g.selectAll<SVGLineElement, any>('.edges line')
    .attr('x1', (d: any) => d.source.x)
    .attr('y1', (d: any) => d.source.y)
    .attr('x2', (d: any) => d.target.x)
    .attr('y2', (d: any) => d.target.y)
  
  const circles = g.selectAll<SVGCircleElement, any>('.nodes circle')
    .attr('cx', (d: any) => d.x)
    .attr('cy', (d: any) => d.y)
  
  // 非大图才更新标签（大图模式跳过标签减少 DOM 操作）
  if (!isLargeGraph) {
    g.selectAll<SVGTextElement, any>('.labels text')
      .attr('x', (d: any) => d.x)
      .attr('y', (d: any) => d.y)
  }
}

const updatePositions = () => {
  if (!g) return
  if (isLargeGraph) {
    // 大图模式：RAF 节流，每帧最多执行一次 DOM 更新
    if (pendingTick) return
    pendingTick = true
    if (tickRafId === null) {
      tickRafId = requestAnimationFrame(() => {
        pendingTick = false
        tickRafId = null
        applyPositions()
      })
    }
  } else {
    applyPositions()
  }
}

// ==================== 自适应缩放 ====================
const fitToScreen = (duration = 0) => {
  if (!svg || !g || !zoom) return
  const bounds = (g.node() as SVGGElement)?.getBBox()
  if (!bounds || bounds.width === 0 || bounds.height === 0) return
  const container = containerRef.value
  if (!container) return
  const cw = container.clientWidth
  const ch = container.clientHeight
  // 容器还没有尺寸（面板未切到图谱 / 窗口极小）→ 跳过：否则 scale 会算成 0，把整张图缩没
  if (!cw || !ch) return
  // 留 40px 边距（节点半径 + 标签），上限 2 倍（节点很少时也不至于糊成一团）
  const scale = Math.min(cw / (bounds.width + 40), ch / (bounds.height + 40), 2)
  if (!Number.isFinite(scale) || scale <= 0) return
  const tx = cw / 2 - (bounds.x + bounds.width / 2) * scale
  const ty = ch / 2 - (bounds.y + bounds.height / 2) * scale
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) return
  const target = d3.zoomIdentity.translate(tx, ty).scale(scale)
  // duration > 0 才走过渡；立即适配（布局过程中的分阶段适配 / 尺寸变化）直接赋值：
  // 连续调用 transition 会打断上一次过渡，插值中间态容易出错（曾出现 translate(NaN,NaN)）
  if (duration > 0) svg.transition().duration(duration).call(zoom.transform, target)
  else { svg.interrupt(); svg.call(zoom.transform, target) }
}

/** 重新开启自动适配（数据 / 尺寸变化时调用；用户手动操作后会被关闭） */
const armAutoFit = () => { autoFitArmed = true }
/** 每节点占的布局尺度（粗估用：约等于常见链距 × 散开程度） */
const NODE_SPAN_UNIT = 300
/**
 * 初始视角：按节点数粗估布局外扩尺寸，先给一个较广的视角。
 * 布局展开过程中不会那么快把节点甩出视口，收敛后的正式适配只需要小幅微调。
 * 仅在「还没动过视图」（identity）时生效，不覆盖用户当前的缩放 / 平移。
 */
const applyInitialWideView = (totalNodes: number) => {
  if (!svg || !zoom) return
  const c = containerRef.value
  if (!c) return
  const cw = c.clientWidth
  const ch = c.clientHeight
  if (!cw || !ch) return
  const cur = d3.zoomTransform(svg.node() as any)
  if (cur.k !== 1 || cur.x !== 0 || cur.y !== 0) return
  const minSide = Math.min(cw, ch)
  const estSpan = Math.max(minSide, Math.sqrt(Math.max(1, totalNodes)) * NODE_SPAN_UNIT)
  const k = Math.max(0.02, Math.min(1, minSide / estSpan))
  if (!Number.isFinite(k) || k >= 1) return
  const tx = cw / 2 - (width / 2) * k
  const ty = ch / 2 - (height / 2) * k
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) return
  svg.interrupt()
  svg.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(k))
}
/**
 * 自动适配：把全部节点框进可视区并居中。
 * 容器暂时无尺寸（例如刚切到图谱页、面板还在布局）时会隔 150ms 重试，最多 20 次。
 */
const runAutoFit = (duration = 300, tries = 0) => {
  if (!autoFitArmed) return
  const c = containerRef.value
  const b = g ? (g.node() as SVGGElement)?.getBBox() : null
  if (c && c.clientWidth > 0 && c.clientHeight > 0 && b && b.width > 0 && b.height > 0) {
    if (autoFitTimer) { clearTimeout(autoFitTimer); autoFitTimer = null }
    fitToScreen(duration)
    return
  }
  if (tries >= 20) return
  if (autoFitTimer) clearTimeout(autoFitTimer)
  autoFitTimer = setTimeout(() => runAutoFit(duration, tries + 1), 150)
}

// ==================== D3 初始化（仅执行一次） ====================
const initGraph = () => {
  if (!svgRef.value || !containerRef.value) return
  if (svg) return   // 已初始化（容器尺寸变化回调也会尝试初始化，这里防重复）
  
  const container = containerRef.value
  width = container.clientWidth || 400
  height = container.clientHeight || 400
  if (width === 0 || height === 0) return
  lastW = width
  lastH = height
  
  svg = d3.select(svgRef.value)
    .attr('viewBox', `0 0 ${width} ${height}`)
    .style('background', 'var(--backgroundColor)')
  
  // 定义箭头标记（颜色必须覆盖调色板全部取值 + '#999' 兜底，否则对应颜色的边会缺箭头）
  const defs = svg.append('defs')
  const markerColors = ['#4CAF50', '#2196F3', '#FF9800', '#E53935', '#9E9E9E', '#9C27B0', '#999']
  markerColors.forEach(color => {
    defs.append('marker')
      .attr('id', `arrow-${color.replace('#', '')}`)
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 15).attr('refY', 0)
      .attr('markerWidth', 8).attr('markerHeight', 8)
      .attr('orient', 'auto')
      .append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', color)
  })
  
  g = svg.append('g')
  edgesG = g.append('g').attr('class', 'edges')
  nodesG = g.append('g').attr('class', 'nodes')
  labelsG = g.append('g').attr('class', 'labels')
  
  // 缩放 — 只初始化一次，保留用户缩放状态
  zoom = d3.zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.02, 5])
    .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
      if (g) g.attr('transform', event.transform.toString())
      // 用户自己缩放 / 平移（sourceEvent 非空；程序调用的 transform 为空）→ 不再自动适配
      if (event.sourceEvent) autoFitArmed = false
    })
  svg.call(zoom)
  
  // 力导向仿真 — 只创建一次，后续只更新数据
  simulation = d3.forceSimulation()
    .force('link', d3.forceLink().id((d: any) => d.id).distance(150).strength(0.3))
    .force('charge', d3.forceManyBody()
      .strength((d: any) => d.type === 'data' ? -500 : -300)
      .theta(0.9))  // Barnes-Hut 近似，默认 0.9
    .force('center', d3.forceCenter(width / 2, height / 2))
    .on('tick', updatePositions)
    // 布局收敛（alpha < alphaMin）后才适配：此时包围盒才是最终尺寸，
    // 中间过程不插手动视图 —— 否则每框一次都打断观看（曾出现过抖动）
    .on('end', () => { if (autoFitArmed && simNodes.length) runAutoFit(500) })
  // collision force 按需在 updateGraph 中动态添加/移除
  
  // 首次数据渲染
  updateGraph()
}

// ==================== 大图模式阈值 ====================
const LARGE_GRAPH_THRESHOLD = 500  // 超过此数启用大图优化
/** 大图模式滞回：进入 500 后要降到 400 以下才退出，避免节点数在阈值附近抖动导致渲染反复切换（闪） */
const LARGE_GRAPH_EXIT_THRESHOLD = 400

/** 按节点数决定是否启用大图模式（带滞回），返回是否发生变化 */
const applyLargeMode = (totalNodes: number): boolean => {
  const was = isLargeGraph
  isLargeGraph = isLargeGraph ? totalNodes > LARGE_GRAPH_EXIT_THRESHOLD : totalNodes > LARGE_GRAPH_THRESHOLD
  return was !== isLargeGraph
}

// ==================== 增量更新图谱（数据变更时调用） ====================
const updateGraph = () => {
  if (!svg || !g || !edgesG || !nodesG || !labelsG || !simulation) return
  
  const nodeData = props.graphData.nodes || []
  const edgeData = props.graphData.edges || []
  const totalNodes = nodeData.length
  
  // 判断是否需要启用大图模式（带滞回，避免在阈值附近反复切换）
  const wasLarge = isLargeGraph
  applyLargeMode(totalNodes)
  
  const container = containerRef.value
  if (container) {
    width = container.clientWidth || width
    height = container.clientHeight || height
  }
  
  // 更新 center force
  simulation.force('center', d3.forceCenter(width / 2, height / 2))
  
  // 大图模式：移除碰撞力，限制电荷力范围，防止节点飞散
  if (isLargeGraph) {
    simulation.force('collision', null as any)
    // 移除旧的 forceX/forceY 避免叠加
    simulation.force('x', null as any).force('y', null as any)
    
    // 快速收敛参数：高初始能量 + 快衰减 + 早停
    simulation.alphaDecay(0.06).alphaMin(0.01)
    
    // 电荷力：弱排斥，关联网页结构清晰不需要强力散开
    const charge = simulation.force('charge') as d3.ForceManyBody<any>
    if (charge) charge.strength(-40).theta(1.0)
    
    // 链接力：短距 + 高强度驱动布局
    const lf = simulation.force('link') as d3.ForceLink<any, any>
    if (lf) lf.distance(40).strength(0.8)
    
    // forceX/forceY：温和向心
    simulation.force('x', d3.forceX(width / 2).strength(0.08))
    simulation.force('y', d3.forceY(height / 2).strength(0.08))
  } else {
    // 移除大图模式加入的 forceX/forceY
    simulation.force('x', null as any).force('y', null as any)
    if (!simulation.force('collision')) {
      simulation.force('collision', d3.forceCollide().radius((d: any) => (d.type === 'data' ? 20 : 16)))
    }
    simulation.alphaDecay(0.02).alphaMin(0.001)
    const charge = simulation.force('charge') as d3.ForceManyBody<any>
    if (charge) charge.theta(0.9)
    // 恢复默认链接距离
    const lf = simulation.force('link') as d3.ForceLink<any, any>
    if (lf) lf.distance(150).strength(0.3)
  }
  
  const linkForce = simulation.force('link') as d3.ForceLink<any, any>
  // ---- 增量同步节点：复用对象（x/y/vx/vy 保留），只补新节点 / 移除消失的节点 ----
  // 数据变化不再让整张图「重新初始化」：新节点直接加进去，已有节点原地不动
  const wasEmptyBefore = simNodes.length === 0
  const wantIds = new Set((nodeData as any[]).map((n: any) => n.id))
  let removedNodes = 0
  for (let i = simNodes.length - 1; i >= 0; i--) {
    if (!wantIds.has(simNodes[i].id)) {
      nodeIndex.delete(simNodes[i].id)
      simNodes.splice(i, 1)
      removedNodes++
    }
  }
  const nodeMap = new Map<string, any>(simNodes.map((n: any) => [n.id, n]))
  const newNodes: any[] = []
  for (const n of nodeData as any[]) {
    const exist = nodeIndex.get(n.id)
    if (exist) {
      // 复用：只同步展示字段，绝不动坐标 / 速度（否则会晃）
      exist.label = n.label
      exist.type = n.type
      exist.color = n.color
      exist.url = n.url
      exist.data = n.data
      nodeMap.set(n.id, exist)
    } else {
      const fresh: any = { id: n.id, label: n.label, type: n.type, color: n.color, url: n.url, data: n.data, x: null, y: null, vx: 0, vy: 0 }
      nodeIndex.set(n.id, fresh)
      simNodes.push(fresh)
      nodeMap.set(n.id, fresh)
      newNodes.push(fresh)
    }
  }
  
  // ---- 节点大小（大图用小半径） ----
  const nodeRadius = (d: any) => {
    if (isLargeGraph) return d.type === 'data' ? 5 : 4
    return d.type === 'data' ? 16 : 12
  }
  
  // ---- 边数据 ----
  // ---- 增量同步边：按 key 复用对象（保留 d3 解析后的 source/target 引用，布局不被打断） ----
  const sideId = (v: any) => (v && typeof v === 'object' ? v.id : v)
  const wantEdge = new Map<string, any>()
  for (const e of edgeData as any[]) {
    const sid = sideId(e.source)
    const tid = sideId(e.target)
    if (!nodeMap.has(sid) || !nodeMap.has(tid)) continue
    const key = `${sid}>${tid}`
    const exist = simLinkIndex.get(key)
    if (exist) {
      exist.type = e.type
      exist.label = e.label
      wantEdge.set(key, exist)
    } else {
      const fresh: any = { source: sid, target: tid, type: e.type, label: e.label }
      simLinkIndex.set(key, fresh)
      wantEdge.set(key, fresh)
    }
  }
  const removedEdges = simLinks.length - wantEdge.size
  simLinks = [...wantEdge.values()]
  for (const k of [...simLinkIndex.keys()]) if (!wantEdge.has(k)) simLinkIndex.delete(k)
  const linksData = simLinks
  
  const edgeKey = (d: any) => `${sideId(d.source)}>${sideId(d.target)}`
  
  const edgeJoin = edgesG
    .selectAll<SVGLineElement, any>('line')
    .data(linksData, edgeKey)
  
  edgeJoin.exit().remove()
  
  // 大图模式边略细但保持可见，无箭头
  const edgeStrokeWidth = isLargeGraph ? 1.0 : 1.5
  const edgeOpacity = isLargeGraph ? 0.5 : 0.6
  
  const edgeEnter = edgeJoin.enter().append('line')
    .attr('stroke', '#999')
    .attr('stroke-width', edgeStrokeWidth)
    .attr('stroke-opacity', edgeOpacity)
    .style('opacity', 0)  // 用 CSS opacity 淡入：不会与下方统一设置的 stroke-opacity 相互打断（否则新边会“闪”一下）

  // 新边箭头（仅小图；大图无箭头，由下方统一块置空）
  if (!isLargeGraph) {
    edgeEnter.attr('marker-end', (d: any) => {
      const srcNode = nodeMap.get(sideId(d.source))
      const color = srcNode?.color ? getNodeColor(srcNode.color) : '#999'
      return `url(#arrow-${color.replace('#', '')})`
    })
    edgeEnter.attr('x1', width / 2).attr('y1', height / 2)
      .attr('x2', width / 2).attr('y2', height / 2)
  }
  edgeEnter.transition().duration(300).style('opacity', 1)
  
  // 统一更新边粗细；小图重设箭头颜色（注意：d3 的 .attr(name, undefined) 会「删除」属性，
  // 不能用来表达“保持不变”——否则会把上面刚设好的箭头全部清掉）
  edgesG.selectAll<SVGLineElement, any>('line')
    .attr('stroke-width', edgeStrokeWidth)
    .attr('stroke-opacity', edgeOpacity)
    .attr('marker-end', isLargeGraph ? null : ((d: any) => {
      const sid = d.source && typeof d.source === 'object' ? d.source.id : d.source
      const srcNode = nodeMap.get(sid)
      const color = srcNode?.color ? getNodeColor(srcNode.color) : '#999'
      return `url(#arrow-${color.replace('#', '')})`
    }))
  
  // ---- 节点 ----
  const nodeJoin = nodesG
    .selectAll<SVGCircleElement, any>('circle')
    .data(simNodes, (d: any) => d.id)

  nodeJoin.exit().remove()

  const nodeEnter = nodeJoin.enter().append('circle')
    .attr('fill', (d: any) => getNodeColor(d.color))
    .attr('stroke', '#fff')
    .attr('stroke-width', isLargeGraph ? 0.5 : 2)
    .attr('cursor', 'pointer')
    .on('click', (event: MouseEvent, d: any) => {
      event.stopPropagation()
      emit('node-click', d)
      highlightNode(d.id)
      tooltipVisible.value = false
    })
    .on('mouseover', (event: MouseEvent, d: any) => {
      tooltipNode.value = d
      tooltipStyle.value = { left: `${event.pageX + 10}px`, top: `${event.pageY - 10}px` }
      tooltipVisible.value = true
      highlightConnectedNodes(d.id)
    })
    .on('mouseout', () => { tooltipVisible.value = false; resetHighlight() })
    .call(d3.drag<any, any>()
      .on('start', (event, d: any) => {
        if (!event.active && simulation) simulation.alphaTarget(0.3).restart()
        d.fx = d.x; d.fy = d.y
        // 用户开始手动搭布局：不再自动适配（否则会把他拖好的图又框回去）
        autoFitArmed = false
      })
      .on('drag', (event, d: any) => { d.fx = event.x; d.fy = event.y; applyPositions() })
      .on('end', (event, d: any) => {
        if (!event.active && simulation) simulation.alphaTarget(0)
        d.fx = d.x; d.fy = d.y; applyPositions()
      })
    )
  
  // 新节点初始位置：从当前视口之外滑入（外侧 → 力导向把它们拉进布局），已有节点坐标保持不动
  const initRadius = Math.min(width, height) * 0.38
  const baseAngle = (Date.now() / 600) % (2 * Math.PI)
  const zt = svg ? d3.zoomTransform(svg.node() as any) : d3.zoomIdentity
  const zk = zt && zt.k ? zt.k : 1
  // 当前视口中心（换成 g 坐标系），新旧节点都围绕它计算起点
  const viewCx = (width / 2 - (zt?.x || 0)) / zk
  const viewCy = (height / 2 - (zt?.y || 0)) / zk
  // 从「视口半径的 1.6 倍」处出发：起点在可视范围之外，视觉上从外侧移入
  const outerRadius = (Math.max(width, height) / zk) * 0.8
  newNodes.forEach((d: any, i: number) => {
    const angle = baseAngle + (2 * Math.PI * i) / Math.max(newNodes.length, 1)
    const r = wasEmptyBefore ? initRadius : outerRadius
    const cx0 = wasEmptyBefore ? width / 2 : viewCx
    const cy0 = wasEmptyBefore ? height / 2 : viewCy
    d.x = cx0 + r * Math.cos(angle)
    d.y = cy0 + r * Math.sin(angle)
  })
  nodeEnter.attr('cx', (d: any) => (d.x == null ? width / 2 : d.x))
    .attr('cy', (d: any) => (d.y == null ? height / 2 : d.y))
  
  // 所有新节点初始透明，然后淡入
  const fadeDuration = isLargeGraph ? 300 : 600
  nodeEnter.attr('opacity', 0)
  
  if (isLargeGraph) {
    // 大图：无半径动画，仅透明度淡入
    nodeEnter.attr('r', nodeRadius)
    nodeEnter.transition().duration(fadeDuration).attr('opacity', 1)
    nodesG.selectAll<SVGCircleElement, any>('circle')
      .attr('fill', (d: any) => getNodeColor(d.color))
      .attr('r', nodeRadius)
  } else {
    // 小图：半径展开 + 透明度淡入
    nodeEnter.attr('r', 0)
    nodeEnter.transition().duration(fadeDuration)
      .attr('r', nodeRadius)
      .attr('opacity', 1)
    nodesG.selectAll<SVGCircleElement, any>('circle')
      .attr('fill', (d: any) => getNodeColor(d.color))
      .attr('r', nodeRadius)
  }
  
  // ---- 标签（大图模式跳过，减少 DOM 节点数） ----
  if (isLargeGraph) {
    // 清除所有标签（只在刚切到大图时清一次，避免每帧重建）
    if (!wasLarge) labelsG.selectAll('*').remove()
  } else {
    const labelJoin = labelsG
      .selectAll<SVGTextElement, any>('text')
      .data(simNodes, (d: any) => d.id)
    
    labelJoin.exit().remove()
    
    const labelEnter = labelJoin.enter().append('text')
      .attr('font-size', (d: any) => d.type === 'data' ? '8px' : '9px')
      .attr('fill', 'var(--fontColor)')
      .attr('text-anchor', 'middle')
      .attr('dy', (d: any) => -(d.type === 'data' ? 22 : 18))
      .attr('opacity', 0)
    
    labelsG.selectAll<SVGTextElement, any>('text')
      .text((d: any) => {
        let label = d.label || d.id
        // 智能体节点通常是「行号 + 标题」，允许多显示几个字
        const limit = d.type === 'agent' ? 20 : 12
        if (label.length > limit) label = label.slice(0, limit - 2) + '...'
        return label
      })
    
    labelEnter.transition().duration(300).attr('opacity', 1)
  }
  
  // ---- 更新仿真数据（同一批节点 / 边对象：不会整图重置） ----
  simulation.nodes(simNodes as any)
  linkForce.links(simLinks as any)
  // 只在「结构变化」（新增 / 移除节点或边）时温启动布局：新节点滑入现有布局，已有节点几乎不动；
  // 仅属性变化（颜色 / 标签 / 计数）时完全不重启仿真 —— 这是之前图谱不断重排（闪烁）的根源
  const structureChanged = newNodes.length > 0 || removedNodes > 0 || removedEdges !== 0
  if (structureChanged) {
    if (wasEmptyBefore) {
      // 空白 → 首图：给足能量完成一次初始布局
      if (isLargeGraph) simulation.alpha(0.6).velocityDecay(0.5)
      else simulation.alpha(1.0).velocityDecay(0.4)
    } else {
      // 增量添加：小幅加热，新节点滑入，已有节点保持原位
      const ratio = newNodes.length / Math.max(1, simNodes.length)
      simulation.alpha(isLargeGraph ? Math.min(0.35, 0.12 + ratio * 0.5) : Math.min(0.5, 0.15 + ratio * 0.6))
        .velocityDecay(isLargeGraph ? 0.5 : 0.4)
    }
    simulation.restart()
  }
  
  // ---- 首图 / 新增节点 / 大图模式切换：只重新允许自动适配；真正的居中等布局收敛（simulation end）后做 ----
  const shouldFitLater = wasEmptyBefore || newNodes.length > 0 || wasLarge !== isLargeGraph
  if (shouldFitLater && totalNodes > 0) armAutoFit()
  // 首图（空白 → 有节点）：先给一个较广的初始视角，布局展开时才不会马上看不到节点
  if (wasEmptyBefore && totalNodes > 0) applyInitialWideView(totalNodes)
}

// ==================== 高亮功能 ====================
const highlightNode = (nodeId: string) => {
  if (!g) return
  
  g.selectAll('.nodes circle')
    .attr('stroke-width', (d: any) => d.id === nodeId ? 4 : 2)
    .attr('stroke', (d: any) => d.id === nodeId ? '#FF5722' : '#fff')
}

const highlightConnectedNodes = (nodeId: string) => {
  if (!g) return
  
  // 获取关联节点ID
  const connectedIds = new Set<string>()
  for (const edge of props.graphData.edges) {
    if (edge.source === nodeId) connectedIds.add(edge.target)
    if (edge.target === nodeId) connectedIds.add(edge.source)
  }
  connectedIds.add(nodeId)
  
  g.selectAll('.nodes circle')
    .attr('opacity', (d: any) => connectedIds.has(d.id) ? 1 : 0.2)
    .attr('stroke-width', (d: any) => d.id === nodeId ? 4 : 2)
    .attr('stroke', (d: any) => d.id === nodeId ? '#FF5722' : '#fff')
  
  g.selectAll('.edges line')
    .attr('stroke-opacity', (d: any) => {
      const sourceId = d.source.id || d.source
      const targetId = d.target.id || d.target
      return (sourceId === nodeId || targetId === nodeId) ? 1 : 0.1
    })
  
  g.selectAll('.labels text')
    .attr('opacity', (d: any) => connectedIds.has(d.id) ? 1 : 0.2)
}

const resetHighlight = () => {
  if (!g) return
  
  g.selectAll('.nodes circle')
    .attr('opacity', 1)
    .attr('stroke-width', 2)
    .attr('stroke', '#fff')
  
  g.selectAll('.edges line')
    .attr('stroke-opacity', 0.6)
  
  g.selectAll('.labels text')
    .attr('opacity', 1)
}

// ==================== 事件处理 ====================
const onGraphClick = () => {
  tooltipVisible.value = false
  resetHighlight()
}

// ==================== 容器尺寸自适应 ====================
// 用 ResizeObserver 而不是 window.resize：面板 / 标签页切换导致的尺寸变化 window 事件收不到
const handleResize = () => {
  const c = containerRef.value
  if (!c) return
  const w = c.clientWidth
  const h = c.clientHeight
  // 面板隐藏（尺寸为 0）→ 记 0，等重新可见时再适配
  if (!w || !h) { lastW = 0; lastH = 0; return }
  const wasHidden = !lastW || !lastH
  if (!wasHidden && Math.abs(w - lastW) <= 1 && Math.abs(h - lastH) <= 1) return
  lastW = w
  lastH = h
  width = w
  height = h
  // 首次挂载时容器可能还是 0 → 等真正有尺寸再初始化
  if (!svg) { initGraph(); return }
  // viewBox 必须跟着容器尺寸走：否则 SVG 会按旧坐标系等比缩放，
  // zoom 变换与可视区对不上 —— 这正是「节点跑到标签页外」的另一个原因
  svg.attr('viewBox', `0 0 ${width} ${height}`)
  if (simulation) {
    // 更新中心力锚点，不清除/重置 zoom
    simulation.force('center', d3.forceCenter(width / 2, height / 2))
    simulation.alpha(0.15).restart()
  }
  // 从隐藏变为可见 → 强制重新适配（平滑过渡）；仅是尺寸变化 → 立即适配且沿用自动适配开关
  // （尺寸变化可能是拖动窗口/面板，一路用过渡会互相打断）
  if (wasHidden) { armAutoFit(); runAutoFit(300) }
  else if (autoFitArmed) runAutoFit(0)
}

// ==================== 监听 ====================
// 数据变化 → 合并同一轮内的多次变更后更新一次；
// 不使用 requestAnimationFrame 合并：窗口隐藏 / 最小化时 rAF 会被挂起，图谱就完全不再更新
let updateScheduled = false
const scheduleUpdate = () => {
  if (updateScheduled) return
  updateScheduled = true
  Promise.resolve().then(() => {
    updateScheduled = false
    updateGraph()
  })
}
// 不再 deep:true：大图深遍历很贵，而结构 / 属性的增量同步由 updateGraph 内部完成（只更新变化的节点）
watch(() => [props.graphData.nodes, props.graphData.edges], () => {
  nodes.value = props.graphData.nodes
  edges.value = props.graphData.edges
  nextTick(scheduleUpdate)
})

// ==================== 生命周期 ====================
onMounted(() => {
  nextTick(() => {
    initGraph()
    // 容器尺寸变化（切标签页 / 拖面板 / 窗口缩放）→ 重算 viewBox 并重新适配
    if (containerRef.value && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => handleResize())
      resizeObserver.observe(containerRef.value)
    } else {
      window.addEventListener('resize', handleResize)
    }
  })
})

onBeforeUnmount(() => {
  if (simulation) simulation.stop()
  if (tickRafId !== null) cancelAnimationFrame(tickRafId)
  if (autoFitTimer) { clearTimeout(autoFitTimer); autoFitTimer = null }
  resizeObserver?.disconnect()
  resizeObserver = null
  window.removeEventListener('resize', handleResize)
})
</script>

<style scoped>
.graph-viewer {
  width: 100%;
  height: 100%;
  position: relative;
  background: var(--backgroundColor);
}

.graph-svg {
  width: 100%;
  height: 100%;
  display: block;
}

/* 节点工具提示 */
.node-tooltip {
  position: fixed;
  background: var(--menuColor);
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 11px;
  pointer-events: none;
  z-index: 1000;
  max-width: 280px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
}

.tooltip-title {
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
}

.tooltip-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}

.tooltip-dot.green { background: #4CAF50; }
.tooltip-dot.blue { background: #2196F3; }
.tooltip-dot.orange { background: #FF9800; }
.tooltip-dot.red { background: #E53935; }
.tooltip-dot.gray { background: #9E9E9E; }
.tooltip-dot.purple { background: #9C27B0; }

.tooltip-type {
  font-size: 9px;
  color: var(--borderColor);
  margin-bottom: 4px;
}
.tooltip-url {
  font-size: 10px;
  color: var(--borderColor);
  margin-bottom: 4px;
  word-break: break-all;
  line-height: 1.4;
}

.tooltip-url .field-key {
  color: var(--borderColor);
}

.tooltip-url .field-value {
  color: #2196F3;
}
.tooltip-desc {
  font-size: 10px;
  color: var(--fontColor);
}

.tooltip-field {
  display: flex;
  gap: 4px;
  padding: 1px 0;
  border-bottom: 1px solid rgba(128, 128, 128, 0.1);
}

.field-key {
  font-weight: 500;
  color: var(--borderColor);
  min-width: 50px;
}

.field-value {
  flex: 1;
  word-break: break-word;
}

/* 空状态 */
.graph-empty {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  text-align: center;
  color: var(--borderColor);
}

.empty-icon {
  font-size: 40px;
  margin-bottom: 8px;
}

.empty-hint {
  font-size: 10px;
  margin-top: 4px;
  opacity: 0.7;
}
</style>