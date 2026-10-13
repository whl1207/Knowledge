<script setup lang="ts">
  import * as d3 from 'd3';
  import { onMounted,onBeforeUnmount,ref, computed, nextTick,watch } from 'vue'
  import { usestore } from '@/store'
  import { onFileSystemChanged, acquireFileWatch, releaseFileWatch } from '@/lib/knowFile/fileWatch'
  import { ElMessage, ElMessageBox } from 'element-plus'
  import { parseSearchQuery, matchSearchTerms } from '@/lib/knowFile/itemSearch'
import { getPlatform, hasCapability } from '@/platform'
  const store=usestore()
  const graphContainer = ref<HTMLElement | null>(null);

  let width = ref(600)
  let height = ref(400)
  let deep = ref(1)
  let simulation = null as any
  let data = ref({
    nodes:[],
    links:[]
  }) as any
  let linkSVG=ref(null) as any //svg中的边
  let nodeSVG=ref(null) as any //svg中的节点
  let labelSVG=ref(null) as any //svg中的标签
  let zoomLayer=ref(null) as any //承载缩放/平移的图层：节点/边/标签都在其中（拖动与点击坐标因此天然在图数据坐标系里）
  const zoom = d3.zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.1, 10])
    .on('zoom', (event: any) => {
      // 只变换这一个图层：逐个元素设 transform 时，每次缩放要写 N×3 个属性（大图卡顿、跟手差）
      zoomLayer.value?.attr('transform', event.transform);
    });
  const  svg = d3.select(graphContainer.value).append('svg')
    .attr('width', width.value)
    .attr('height', height.value)
    .call(zoom);
  
  let layoutType = ref("force") //布局类型
  let panelType = ref("")
  
  // 双向链接显示
  let showBidirectionalLinks = ref(false)
  // 文件夹层级结构显示
  let showHierarchy = ref(true)
  // 文件引用关系（由 computeFileReferences 生成）
  let fileReferenceLinks = ref<any[]>([])
  
  // 点击节点高亮其关联节点
  const selectedNodeId = ref<any>(null) // 当前高亮节点（null = 未选中）
  let selectedKey: string | null = null // 选中节点的稳定标识（数据重载后 id 会重建，用它续上）
  let renderedLinks: any[] = [] // 当前已绘制的边（含层级/属性/引用边），用于计算邻居
  
  // 右键菜单
  const contextMenu = ref({
    visible: false,
    x: 0,
    y: 0,
    upward: false // 是否向上弹出
  })
  const hideContextMenu = () => {
    contextMenu.value.visible = false
    nodeCtxMenu.value.visible = false
  }
  
  // 节点右键菜单
  const nodeCtxMenu = ref({
    visible: false,
    x: 0,
    y: 0,
    upward: false, // 是否向上弹出
    nodeData: null as any
  })
  const showNodeContextMenu = function(event: MouseEvent, d: any) {
    if (d.type !== 'file' && d.type !== 'folder') return
    event.preventDefault()
    event.stopPropagation()
    contextMenu.value.visible = false
    // 估算菜单高度（4 项 × 36px），底部空间不足时初始向上放置，减少闪烁
    const estimatedHeight = 4 * 36 + 20
    const spaceBelow = window.innerHeight - event.clientY
    nodeCtxMenu.value.upward = estimatedHeight > spaceBelow
    nodeCtxMenu.value.x = event.clientX
    nodeCtxMenu.value.y = nodeCtxMenu.value.upward ? Math.max(4, event.clientY - estimatedHeight) : event.clientY
    nodeCtxMenu.value.nodeData = d
    nodeCtxMenu.value.visible = true
    adjustContextMenuPosition()
  }

  // 右键菜单渲染后按实际尺寸四边夹紧，确保完全显示（不依赖 transform，直接测量宽高后对上下左右取 clamp）
  const adjustContextMenuPosition = function() {
    const menu = contextMenu.value.visible ? contextMenu : (nodeCtxMenu.value.visible ? nodeCtxMenu : null)
    if (!menu) return
    nextTick(() => {
      const el = document.querySelector('.graph .context-menu') as HTMLElement | null
      if (!el) return
      const margin = 4
      const w = el.offsetWidth
      const h = el.offsetHeight
      const vw = window.innerWidth
      const vh = window.innerHeight
      let top = menu.value.y
      let left = menu.value.x
      // 底部溢出 → 上移
      top = Math.min(top, vh - margin - h)
      // 顶部溢出 → 下移（菜单比视口还高时固定在顶部，最多显示顶部区域）
      top = Math.max(margin, top)
      // 右侧溢出 → 左移
      left = Math.min(left, vw - margin - w)
      // 左侧溢出 → 右移
      left = Math.max(margin, left)
      // 应用最终坐标
      menu.value.x = left
      menu.value.y = top
      menu.value.upward = false
    })
  }

  // 子菜单溢出检测：二级/三级菜单超出视口时自动翻转展开方向（向左/向上）
  // 记录当前激活的子菜单项，避免在子菜单内部移动时反复翻转造成闪烁
  let activeSubmenuItem: HTMLElement | null = null
  const handleSubmenuOverflow = (e: MouseEvent) => {
    // 仅处理本模块（.graph）内的子菜单，避免影响其他模块
    const target = (e.target as HTMLElement).closest('.graph .has-submenu') as HTMLElement | null
    if (!target) {
      // 移出所有子菜单项时重置，便于下次进入重新计算
      activeSubmenuItem = null
      return
    }
    // 仅在首次进入某个子菜单项时计算，避免在子菜单内部移动时反复翻转（闪烁）
    if (activeSubmenuItem === target) return
    activeSubmenuItem = target

    const submenu = target.querySelector(':scope > .submenu') as HTMLElement | null
    if (!submenu) return

    requestAnimationFrame(() => {
      submenu.classList.remove('submenu-up', 'submenu-left')

      const rect = submenu.getBoundingClientRect()
      const viewportW = window.innerWidth
      const viewportH = window.innerHeight

      // 底部溢出 → 向上展开
      if (rect.bottom > viewportH) {
        submenu.classList.add('submenu-up')
      }
      // 右侧溢出 → 向左展开
      if (rect.right > viewportW) {
        submenu.classList.add('submenu-left')
      }
    })
  }
  
  // 打开节点（文件/文件夹）：与文件树面板（panel.vue）双击一致，
  // 文件统一交给 store.openFileByMode 调度——按「设置 → 文件操作」的打开方式打开，
  // 并统一处理特殊类型（.kb → 知识处理、.task → Agent脚手架、.html → 内置浏览器、
  // .flow / .data / .excalidraw / .drawio 走各自的文件视图、可执行与压缩包交系统应用），
  // 不再按扩展名分流到系统默认应用。
  const openNode = function(d: any) {
    if (!d.path) return
    // 文件夹没有对应的应用内视图：交系统文件管理器打开（与表格视图一致）
    if (d.type === 'folder') {
      store.openByApp(d.path)
    } else {
      const ext = d.extension || d.path.substring(d.path.lastIndexOf('.')) || ''
      store.openFileByMode({ path: d.path, label: d.label, type: d.type, extension: ext })
    }
    hideContextMenu()
  }
  
  // 重命名节点
  const renameNode = async function(d: any) {
    if (!d.path) return
    hideContextMenu()
    try {
      const { value: newName } = await ElMessageBox.prompt('请输入新名称:', '重命名', {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        inputValue: d.label,
        inputPattern: /.+/,
        inputErrorMessage: '名称不能为空'
      })
      const trimmed = newName.trim()
      if (trimmed === d.label) return
      const result = await getPlatform().fs.renameFile(d.path, trimmed)
      if (result.success) {
        await init(true)
        ElMessage.success('重命名成功')
      } else {
        ElMessage.error(`重命名失败: ${result.error}`)
      }
    } catch { /* 用户取消 */ }
  }
  
  // 删除节点
  const deleteNode = async function(d: any) {
    if (!d.path) return
    try {
      await ElMessageBox.confirm(
        `确定要删除文件 "${d.label}" 吗？`,
        '确认删除',
        {
          confirmButtonText: '确定',
          cancelButtonText: '取消',
          type: 'warning',
        }
      )
      const result = await getPlatform().fs.deleteFile(d.path)
      if (result) {
        hideContextMenu()
        await init(true)
        ElMessage.success('删除成功')
      }
    } catch (error) {
      if (error !== 'cancel') {
        ElMessage.error('删除失败')
      }
      hideContextMenu()
    }
  }
  
  // 在系统位置打开
  const openNodeInFolder = function(d: any) {
    if (!d.path) return
    getPlatform().shell.revealInFolder(d.path)
    hideContextMenu()
  }
  
  const resize=function(){
    if (graphContainer.value) {
      width.value = graphContainer.value.offsetWidth
      height.value = graphContainer.value.offsetHeight
      const svg = d3.select(graphContainer.value).select('svg')
      if (svg.empty()) {
        // 如果不存在SVG元素，则创建一个新的
        const newSvg = d3.select(graphContainer.value).append('svg').attr('width', width.value).attr('height', height.value)
        // 重新绑定事件处理程序
        newSvg.on('resize', resize);
      } else {
        // 如果SVG元素已经存在，则更新它的宽度和高度
        svg.attr('width', width.value).attr('height', height.value)
        simulation.force('center', d3.forceCenter(width.value / 2, height.value / 2))
      }
    }
  }
  
  const resetView=async function(){
    if (graphContainer.value) {
      await nextTick()
      width.value = graphContainer.value.offsetWidth
      height.value = graphContainer.value.offsetHeight
    }
    const nodes = data.value.nodes
    if (!nodes || nodes.length === 0) return

    const padding = 60 // 边距
    const minX = Number(d3.min(nodes, (d:any) => d.x)) || 0
    const maxX = Number(d3.max(nodes, (d:any) => d.x)) || 0
    const minY = Number(d3.min(nodes, (d:any) => d.y)) || 0
    const maxY = Number(d3.max(nodes, (d:any) => d.y)) || 0
    
    const graphWidth = maxX - minX || 1
    const graphHeight = maxY - minY || 1
    
    // 计算缩放比例（考虑边距）
    const xScale = (width.value - padding * 2) / graphWidth
    const yScale = (height.value - padding * 2) / graphHeight
    const scale = Math.min(xScale, yScale, 2) // 限制最大缩放 2x

    // 计算平移量，使图谱居中
    const offsetX = width.value / 2 - (minX + maxX) / 2 * scale
    const offsetY = height.value / 2 - (minY + maxY) / 2 * scale

    // 应用缩放和平移变换
    const container = graphContainer.value
    if (!container) return
    const currentSvg = d3.select(container).select('svg')
    if (!currentSvg.empty()) {
      const transform = d3.zoomIdentity.translate(offsetX, offsetY).scale(scale)
      ;(currentSvg as unknown as d3.Selection<SVGSVGElement, unknown, any, any>).call(zoom.transform, transform)
    }
  }
  
  // 点击图形区域关闭设置面板和右键菜单
  const closePanel = function(e?: MouseEvent) {
    if (panelType.value !== '') {
      panelType.value = ''
    }
    if (contextMenu.value.visible) {
      contextMenu.value.visible = false
    }
  }
  
  const init = async function(refreshReferences = false){
    if (graphContainer.value) {
      await nextTick()
      if (!graphContainer.value) return // 等待期间视图已卸载/隐藏
      width.value = graphContainer.value.offsetWidth
      height.value = graphContainer.value.offsetHeight
      try {
        await loadFile()
        // 引用关系按节点 id 关联，数据重新载入后 id 全部重建：不重算会连到错误节点
        // （节点数变少时甚至会因 id 缺失让 forceLink 直接报错）
        if (refreshReferences && showBidirectionalLinks.value) {
          fileReferenceLinks.value = await computeFileReferences()
        }
        // 异步读取期间视图可能已卸载/隐藏：此时重绘会留下无法停止的力导向模拟
        if (!graphContainer.value) return
        renderGraph()
        resize()
        getAttributes()
      } catch (error) {
        console.error(error);
      }
    }
  }
  // 图谱搜索：按名称过滤节点并裁剪其关联边，随后重绘
  // 搜索词来自顶部工具栏（explorer 里统一渲染，各全局视图共用一份）
  const graphQuery = computed(() => store.knowQuery)
  let graphSearchTimer: any = null
  const fullGraphNodes: any[] = []
  const fullGraphLinks: any[] = []
  const syncGraphView = function () {
    const terms = parseSearchQuery(graphQuery.value)
    if (!terms.length) {
      data.value.nodes = fullGraphNodes
      data.value.links = fullGraphLinks
      return
    }
    // 与其它视图同一套搜索语法（文件名 / 路径 / 属性值）
    const nodes = fullGraphNodes.filter((n: any) =>
      matchSearchTerms({ label: n.label ?? n.name, path: n.path, attributes: n.attributes }, terms)
    )
    const kept = new Set<any>(nodes.map((n: any) => n.id))
    data.value.nodes = nodes
    data.value.links = fullGraphLinks.filter((l: any) => {
      const s = l.source?.id ?? l.source
      const t = l.target?.id ?? l.target
      return kept.has(s) && kept.has(t)
    })
  }
  const applyGraphSearch = function () {
    syncGraphView()
    renderGraph()
  }
  watch(graphQuery, () => {
    clearTimeout(graphSearchTimer)
    graphSearchTimer = setTimeout(applyGraphSearch, 200)
  })

  const loadFile=async function(){
    let { fileList, relationList } = await window.ipcRenderer.invoke("getFilesRelation", store.dataDir, deep.value);
    fileList=fileList.map((obj: any,index:number)  => {
      return proxyToRegular({ ...obj  });
    })
    fullGraphNodes.length = 0
    fullGraphNodes.push(...fileList)
    fullGraphLinks.length = 0
    fullGraphLinks.push(...(relationList || []))
    syncGraphView()
  }

  // ---- 层级布局辅助：从图数据构建树（父子层级 + 属性子节点） ----
  const buildLayoutHierarchy = function() {
    if (!data.value.nodes.length) return null
    const nodeById = new Map<any, any>()
    data.value.nodes.forEach((n: any) => nodeById.set(n.id, n))

    const childrenMap = new Map<any, any[]>()
    const parentMap = new Map<any, any>()
    const isReal = (n: any) => n && (n.type === 'file' || n.type === 'folder')

    // 1. 文件/文件夹父子关系（无 type 的边为层级边，source=父 target=子）
    data.value.links.forEach((l: any) => {
      if (l.type) return
      const s = l.source?.id ?? l.source
      const t = l.target?.id ?? l.target
      if (!isReal(nodeById.get(s)) || !isReal(nodeById.get(t))) return
      if (!childrenMap.has(s)) childrenMap.set(s, [])
      childrenMap.get(s)!.push(t)
      parentMap.set(t, s)
    })

    // 2. 属性节点（type 非 file/folder）挂到其关联的文件/文件夹节点下
    data.value.links.forEach((l: any) => {
      if (!l.type) return
      const s = l.source?.id ?? l.source
      const t = l.target?.id ?? l.target
      const sn = nodeById.get(s)
      const tn = nodeById.get(t)
      if (!sn || !tn) return
      let attrId: any = null
      let hostId: any = null
      if (!isReal(sn)) { attrId = s; hostId = t }
      else if (!isReal(tn)) { attrId = t; hostId = s }
      if (attrId != null && hostId != null && !parentMap.has(attrId)) {
        if (!childrenMap.has(hostId)) childrenMap.set(hostId, [])
        childrenMap.get(hostId)!.push(attrId)
        parentMap.set(attrId, hostId)
      }
    })

    // 3. 构建 d3 层级
    const roots = data.value.nodes.filter((n: any) => !parentMap.has(n.id))
    const build = (id: any): any => {
      const node = nodeById.get(id)
      const children = (childrenMap.get(id) || []).map(build)
      return { id, data: node, children }
    }
    // 注意：roots 元素是节点对象，必须传 r.id 给 build（直接 map(build) 会把节点对象当作 id，导致 data 为 undefined）
    const treeData = { id: 'root', data: null, children: roots.map((r: any) => build(r.id)) }
    return d3.hierarchy(treeData)
  }

  // 树状布局（自上而下，父子层级展开）
  const layoutTree = function() {
    const root = buildLayoutHierarchy()
    if (!root) return
    // 横向加宽（容纳文件名），纵向缩短
    const tree = d3.tree<any>().size([(width.value - 40) * 1.4, (height.value - 40) * 0.75])
    const treeRoot = tree(root)
    treeRoot.descendants().forEach((d: any) => {
      if (d.data.id === 'root') return
      const node = d.data.data
      node.x = d.x + 20
      node.y = d.y + 20
      node.fx = node.x
      node.fy = node.y
    })
  }

  // 同心圆布局（按深度分层，同层节点均分圆周）
  const layoutConcentric = function() {
    const root = buildLayoutHierarchy()
    if (!root) return
    const depthMap = new Map<any, number>()
    const assignDepth = (node: any, depth: number) => {
      if (node.data.id === 'root') {
        ;(node.children || []).forEach((c: any) => assignDepth(c, 0))
        return
      }
      depthMap.set(node.data.id, depth)
      ;(node.children || []).forEach((c: any) => assignDepth(c, depth + 1))
    }
    assignDepth(root, 0)

    let maxDepth = 0
    depthMap.forEach(d => { if (d > maxDepth) maxDepth = d })

    const layers: any[][] = []
    data.value.nodes.forEach((n: any) => {
      const d = depthMap.get(n.id) ?? 0
      if (!layers[d]) layers[d] = []
      layers[d].push(n)
    })

    const cx = width.value / 2
    const cy = height.value / 2
    const spacing = Math.min(width.value, height.value) / 2 / (maxDepth + 1)
    layers.forEach((layer, depth) => {
      const r = spacing * (depth + 0.6)
      const count = layer.length
      layer.forEach((node, i) => {
        const angle = count === 1 ? -Math.PI / 2 : (2 * Math.PI * i) / count - Math.PI / 2
        node.x = cx + r * Math.cos(angle)
        node.y = cy + r * Math.sin(angle)
        node.fx = node.x
        node.fy = node.y
      })
    })
  }

  // 网格布局（节点按顺序排成矩阵）
  const layoutGrid = function() {
    const count = data.value.nodes.length
    if (!count) return
    const cols = Math.ceil(Math.sqrt(count))
    const rows = Math.ceil(count / cols)
    const cellW = width.value / cols
    const cellH = height.value / rows
    data.value.nodes.forEach((node: any, i: number) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      node.x = cellW * col + cellW / 2
      node.y = cellH * row + cellH / 2
      node.fx = node.x
      node.fy = node.y
    })
  }

  // ---- 节点样式与「点击高亮关联节点」 ----
  const HIGHLIGHT_COLOR = '#ff9800'
  const nodeBaseR = (d: any) => d.type === 'folder' ? 7 : d.type === 'file' ? 6 : 4
  const nodeBaseFill = (d: any) => d.type === 'folder' ? '#50c878' : d.type === 'file' ? '#4a9eff' : '#ff9a4a'
  const nodeBaseStroke = (d: any) => d.type === 'folder' ? '#3a9e5e' : d.type === 'file' ? '#2a7ed6' : '#d47a2a'
  // 稳定标识：文件夹/文件用路径，属性节点用「类型 + 名称」
  const nodeKey = (n: any) => n.path ? 'p:' + n.path : 'a:' + n.type + ':' + n.label
  const linkEndIds = (l: any) => [l.source?.id ?? l.source, l.target?.id ?? l.target]

  // 按当前选中节点重刷高亮：关联节点/相连边保持高亮，其余淡出；未选中时全部还原
  const applyHighlight = function(){
    const nodes = nodeSVG.value
    if (!nodes) return
    const links = linkSVG.value
    const labels = labelSVG.value
    const selId = selectedNodeId.value

    nodes.attr('r', nodeBaseR).attr('fill', nodeBaseFill).attr('stroke', nodeBaseStroke)
      .attr('stroke-width', 1.5).attr('opacity', 1)
    labels?.attr('opacity', 1)
    links?.attr('stroke-opacity', (l: any) => l.type === 'reference' ? 0.7 : 0.6)
      .attr('stroke-width', (l: any) => l.type === 'reference' ? 1.5 : Math.sqrt(l.value || 1))
    if (selId == null) return

    const related = new Set<any>([selId])
    renderedLinks.forEach((l: any) => {
      const [s, t] = linkEndIds(l)
      if (s === selId) related.add(t)
      else if (t === selId) related.add(s)
    })

    nodes.attr('opacity', (d: any) => related.has(d.id) ? 1 : 0.15)
      .attr('r', (d: any) => d.id === selId ? nodeBaseR(d) + 3 : nodeBaseR(d))
      .attr('stroke', (d: any) => related.has(d.id) ? HIGHLIGHT_COLOR : nodeBaseStroke(d))
      .attr('stroke-width', (d: any) => d.id === selId ? 3 : related.has(d.id) ? 2.5 : 1.5)
    labels?.attr('opacity', (d: any) => related.has(d.id) ? 1 : 0.15)
    links?.attr('stroke-opacity', (l: any) => {
      const [s, t] = linkEndIds(l)
      return (s === selId || t === selId) ? 1 : 0.08
    }).attr('stroke-width', (l: any) => {
      const [s, t] = linkEndIds(l)
      const base = l.type === 'reference' ? 1.5 : Math.sqrt(l.value || 1)
      return (s === selId || t === selId) ? base + 1 : base
    })
  }

  // 点击节点：再次点击同一节点或点击空白处取消
  const toggleNodeSelection = function(d: any){
    const key = nodeKey(d)
    if (selectedKey === key) {
      selectedKey = null
      selectedNodeId.value = null
    } else {
      selectedKey = key
      selectedNodeId.value = d.id
    }
    applyHighlight()
  }

  const clearNodeSelection = function(){
    if (selectedKey === null) return
    selectedKey = null
    selectedNodeId.value = null
    applyHighlight()
  }

  const renderGraph=function(){
      const existingSvg = d3.select(graphContainer.value).select("svg");
      if (existingSvg) {
        existingSvg.remove();
      }
      const svg = d3.select(graphContainer.value)
                    .append('svg')
                    .attr('width', width.value)
                    .attr('height', height.value)
                    .call(zoom); // 调用拖动事件
      
      // 所有图元放在同一个图层里：缩放/平移只改这一层，拖动与点击坐标天然等于图数据坐标
      const rootG = svg.append('g');
      zoomLayer.value = rootG;
      // 只有点在空白画布上才取消高亮（点在节点 / 边 / 标签上不处理）
      svg.on('click', (event: MouseEvent) => {
        if ((event.target as Element)?.tagName !== 'svg') return;
        clearNodeSelection();
      });
      
      if (simulation) simulation.stop();
      
      // 合并参考链接到数据中
      let allLinks = showHierarchy.value
        ? [...data.value.links]
        : data.value.links.filter((l: any) => l.type) // 关闭层级时只保留属性边
      if (showBidirectionalLinks.value && fileReferenceLinks.value.length > 0) {
        allLinks = [...allLinks, ...fileReferenceLinks.value]
      }
      renderedLinks = allLinks

      if (layoutType.value === "force") {
        simulation = d3.forceSimulation<any, any>(data.value.nodes)
                        .force('link', d3.forceLink(allLinks).id((d: any) => d.id))
                        .force('charge', d3.forceManyBody().strength(-250))
                        .force('center', d3.forceCenter(width.value / 2, height.value / 2))
                        .force('x', d3.forceX(width.value).strength(0.1)) // 添加水平位置限制
                        .force('y', d3.forceY(height.value).strength(0.1)); // 添加垂直位置限制
      } else if (layoutType.value === "circle") {
        // 圆形布局初始化
        const radius = Math.min(width.value, height.value) / 2 - 50; // 定义圆的半径
        const angle = (2 * Math.PI) / data.value.nodes.length; // 计算每个节点之间的角度

        data.value.nodes.forEach((node : any, index : number) => {
          node.x = width.value / 2 + radius * Math.cos(angle * index);
          node.y = height.value / 2 + radius * Math.sin(angle * index);
        });
      } else if (layoutType.value === "tree") {
        layoutTree()
      } else if (layoutType.value === "concentric") {
        layoutConcentric()
      } else if (layoutType.value === "grid") {
        layoutGrid()
      }
      //定义箭头
      svg.append("defs").selectAll("marker")
        .data(["end"])      // Different link/path types can be defined here
        .enter().append("marker")    // This section adds in the arrows
        .attr("id", String)
        .attr("viewBox", "0 -5 10 10")
        .attr("refX", 15)
        .attr("refY", 0)
        .attr("markerWidth", 6)
        .attr("markerHeight", 6)
        .attr("orient", "auto")
        .append("path")
        .attr("d", "M0,-5L10,0L0,5")
        .attr("fill", "#999")
      //定义线条     
      linkSVG.value = rootG.selectAll('line')
                      .data(allLinks)
                      .enter().append('line')
                      .attr('stroke', (d: any) => d.style?.stroke || '#999')
                      .attr('stroke-opacity', (d: any) => d.type === 'reference' ? 0.7 : 0.6)
                      .attr('stroke-width', (d: any) => d.type === 'reference' ? 1.5 : Math.sqrt(d.value || 1))
                      .attr('stroke-dasharray', (d: any) => d.type === 'reference' ? '4,3' : '')
                      .attr("marker-end", (d: any) => d.type === 'reference' ? '' : "url(#end)")
                      // 初始坐标（圆形布局直接生效，力导向布局由后续 tick 覆盖）
                      .attr('x1', (d: any) => {
                        const n = data.value.nodes.find((n: any) => n.id === (d.source?.id ?? d.source))
                        return n ? n.x : 0
                      })
                      .attr('y1', (d: any) => {
                        const n = data.value.nodes.find((n: any) => n.id === (d.source?.id ?? d.source))
                        return n ? n.y : 0
                      })
                      .attr('x2', (d: any) => {
                        const n = data.value.nodes.find((n: any) => n.id === (d.target?.id ?? d.target))
                        return n ? n.x : 0
                      })
                      .attr('y2', (d: any) => {
                        const n = data.value.nodes.find((n: any) => n.id === (d.target?.id ?? d.target))
                        return n ? n.y : 0
                      })

      const drag = d3.drag<SVGCircleElement, any, any>()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended);

      if(layoutType.value === "force"){
        nodeSVG.value = rootG.selectAll<SVGCircleElement, any>('circle')
                      .data(data.value.nodes)
                      .enter().append('circle')
                      .attr('r', nodeBaseR)
                      .attr('fill', nodeBaseFill)
                      .attr('stroke', nodeBaseStroke)
                      .attr('stroke-width', 1.5)
                      .style('cursor', 'pointer')
                      .call(drag as d3.ValueFn<SVGCircleElement, any, any> ,0, [])
                      .on('click', (_event: MouseEvent, d: any) => toggleNodeSelection(d))
                      .on('dblclick', nodeDblClick)
                      .on('contextmenu', (event: MouseEvent, d: any) => showNodeContextMenu(event, d))
                      .on('mouseover', (event: MouseEvent, d: any) => showTooltip(event, d))
                      .on('mousemove', (event: MouseEvent) => updateTooltipPos(event))
                      .on('mouseleave', hideTooltip)
      }else{ // 静态布局：圆形/树状/同心圆/网格
        nodeSVG.value = rootG.selectAll<SVGCircleElement, any>('circle')
                      .data(data.value.nodes)
                      .enter().append('circle')
                      .attr('r', nodeBaseR)
                      .attr('fill', nodeBaseFill)
                      .attr('stroke', nodeBaseStroke)
                      .attr('stroke-width', 1.5)
                      .style('cursor', 'pointer')
                      .attr('cx', (d: any) => d.x) // 使用固定的x位置
                      .attr('cy', (d: any) => d.y) // 使用固定的y位置
                      .on('click', (_event: MouseEvent, d: any) => toggleNodeSelection(d))
                      .on('dblclick', nodeDblClick)
                      .on('contextmenu', (event: MouseEvent, d: any) => showNodeContextMenu(event, d))
                      .on('mouseover', (event: MouseEvent, d: any) => showTooltip(event, d))
                      .on('mousemove', (event: MouseEvent) => updateTooltipPos(event))
                      .on('mouseleave', hideTooltip);
      }
      // 添加节点标签
      labelSVG.value = rootG.selectAll('.label')
        .data(data.value.nodes)
        .enter().append('text')
        .attr('class', 'label')
        .text((d: any) => d.label)
        .attr('x', (d: any) => d.x)
        .attr('y', (d: any) => d.y)
        .attr('dy', 20) // 垂直偏移量，使标签位于节点之上
        .attr('text-anchor', 'middle') // 文本锚点在中间
        .attr('font-size', '6px') // 设置文字大小
        .attr('fill', 'var(--fontColor)') // 设置文字颜色
        .on('mouseover', (event: MouseEvent, d: any) => showTooltip(event, d))
        .on('mousemove', (event: MouseEvent) => updateTooltipPos(event))
        .on('mouseleave', hideTooltip);

      if (simulation) {
        simulation.on('tick', () => {
          linkSVG.value.attr('x1', (d: any) => d.source.x)
              .attr('y1', (d: any) => d.source.y)
              .attr('x2', (d: any) => d.target.x)
              .attr('y2', (d: any) => d.target.y);

          nodeSVG.value.attr('cx', (d: any) => d.x)
              .attr('cy', (d: any) => d.y);
          labelSVG.value.attr('x', (d: any) => d.x)
               .attr('y', (d: any) => d.y);
        });
      }

      // 数据重载后 id 会重建：按稳定标识重新定位选中节点（找不到说明该节点已消失）
      if (selectedKey) {
        const hit = data.value.nodes.find((n: any) => nodeKey(n) === selectedKey)
        selectedNodeId.value = hit ? hit.id : null
        if (!hit) selectedKey = null
      }
      applyHighlight()
        
      function dragstarted(event: any) {
        if (!event.active) simulation.alphaTarget(0.1).restart();
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
      }

      function dragged(event: any) {
        if (!event.subject) return;
        // event.x/y = 图数据坐标，且已包含「按下时鼠标 → 节点中心」的偏移（d3-drag 内置），直接赋值即精确跟手；
        // 旧实现按缩放做逆变换，把已经换算过的坐标又换算了一次 → 缩放/平移后越拖越偏
        event.subject.fx = event.x;
        event.subject.fy = event.y;
      }

      function dragended(event: any) {
        if (!event.active) simulation.alphaTarget(0);
        // 松手后保持固定在该位置：力导向不再把节点拉回原位（重新读取数据或换布局时自动复位）
      }
  }
  
  //获取节点属性
  let attributes = ref([]) as any
  const getAttributes = function(){
    // 获取所有属性
    let allProps = [] as any
    data.value.nodes.forEach((obj: { attributes: any }) => {
      const props = Object.keys(obj.attributes)
      for(let i = 0;i<props.length;i++){
        if(!/^[A-Za-z]+$/.test(props[i])){
          let t = {
            name:props[i],
            state:0,
            color:'rgba(170, 170, 170, 0.4)'
          } as any
          allProps.push(t)
        }
      }
    })
    // 去除重复属性
    let result = allProps.filter((obj:any, index:any, self:any) => {
      // 检查当前对象是否在之前的对象中出现过
      return (
        index ===
        self.findIndex((o:any) => {
          return JSON.stringify(o) === JSON.stringify(obj)
        })
      )
    })
    attributes.value = result
  }
  //展开所有节点的某一类属性
const expandAttribute=async function(indexParam:string|number,state:number){
  // 将参数转换为 number 类型
  const index = Number(indexParam)
  
  if (isNaN(index)) {
    console.error('Invalid index:', indexParam)
    return
  }
  
  // 确保 index 在有效范围内
  if (index < 0 || index >= attributes.value.length) {
    console.error('Index out of range:', index)
    return
  }
  
  attributes.value[index].state=state
  let attribute = attributes.value[index].name //需要展开的属性
    if(state==1||state==-1){ //如果是创建属性节点
      //循环遍历节点，并根据属性创建新节点
      for(let i = 0;i<data.value.nodes.length;i++){
        //如果该节点有这个属性
        if(data.value.nodes[i].attributes!=undefined){
          if(data.value.nodes[i].attributes[attribute]!=undefined){
            let items =[]
            //切分属性，根据;和；进行切分
            if(data.value.nodes[i].attributes[attribute] instanceof Date){
              items =[store.StampToDate(data.value.nodes[i].attributes[attribute])]
            }else{
              items = data.value.nodes[i].attributes[attribute].split(/[;；]/)
            }
            //遍历所有items
            for (const item of items) {
              //判断节点是否存在
              let nodeindex=null as number|unknown //是否有重复边，序号
              //判断属性内容是否是原有节点
              for (let index = 0;index<data.value.nodes.length;index++) {
                if(data.value.nodes[index].label==item){
                  //添加边
                  nodeindex=index
                }
              }
              if(nodeindex==null){
                nodeindex=data.value.nodes.length
                //添加节点
                data.value.nodes.push({
                  id:data.value.nodes.length,
                  label:item,
                  path:'',
                  type:attribute,
                  x:0,
                  y:0,
                  vx:0,
                  vy:0
                })
              }
              //边数据
              let linkData={
                id:data.value.links.length,
                index:data.value.links.length,
                source:(state==1)?(data.value.nodes[i].id):(nodeindex),
                target:(state==1)?(nodeindex):(data.value.nodes[i].id),
                type:attribute,
                style:{
                  fill:attributes.value[index].color,
                  stroke:attributes.value[index].color,
                },
              }
              let edgeState=false //是否有重复边
              for (const link of data.value.links) {
                if(link.source==linkData.source && link.target==linkData.target && link.type==linkData.type){
                  //添加边
                  edgeState=true
                }
              }
              if(edgeState==false) data.value.links.push(linkData)
            }
          }
        }
      }
    }else{
      //如果是删除行为
      let filteredNodes = data.value.nodes.filter((node:any) => node.type !== attribute);
      data.value.nodes = filteredNodes;

      //过滤边，属性有变化会产生bug
      let filteredEdges = data.value.links.filter((link:any) => link.type !== attribute);
      data.value.links = filteredEdges;
    }
    renderGraph()
  }

  // 批量展开/收起所有属性
  const expandAllAttributes = async function() {
    for (let i = 0; i < attributes.value.length; i++) {
      if (attributes.value[i].state === 0 || attributes.value[i].state === -1) {
        await expandAttribute(i, 1)
      }
    }
  }
  const collapseAllAttributes = async function() {
    // 从后往前遍历，避免索引偏移
    for (let i = attributes.value.length - 1; i >= 0; i--) {
      if (attributes.value[i].state === 1 || attributes.value[i].state === -1) {
        await expandAttribute(i, 0)
      }
    }
  }

  function proxyToRegular(obj:any) {
    return JSON.parse(JSON.stringify(obj));
  }

  // 扫描所有 .md 文件，提取引用关系
  const computeFileReferences = async function(): Promise<any[]> {
    const refLinks: any[] = []
    const fileNodes = data.value.nodes.filter((n: any) => n.type === 'file' && n.path && n.extension === '.md')
    
    for (const sourceNode of fileNodes) {
      try {
        const content = await getPlatform().fs.readText(sourceNode.path)
        if (!content || typeof content !== 'string') continue
        
        // 匹配 Markdown 链接 [text](path) 以及图片 ![text](path)
        const linkRegex = /\[([^\]]*)\]\(([^)]*)\)/g
        let match
        while ((match = linkRegex.exec(content)) !== null) {
          const href = match[2].trim()
          // 跳过外部链接
          if (/^(https?:|data:|file:\/\/)/i.test(href)) continue
          // 跳过 < 包裹的链接（剥离 <>）
          let cleanHref = href.replace(/^<|>$/g, '')
          if (!cleanHref) continue
          
          // 解析相对路径为绝对路径
          const sourceDir = sourceNode.path.substring(0, sourceNode.path.lastIndexOf('\\'))
          const resolvedPath = await getPlatform().fs.resolveRelativePath(sourceNode.path, cleanHref)
          if (!resolvedPath) continue
          
          // 查找目标节点
          const targetNode = data.value.nodes.find((n: any) => n.path === resolvedPath)
          if (!targetNode) continue
          
          // 避免自引用和重复
          if (targetNode.id === sourceNode.id) continue
          const isDuplicate = refLinks.some((l: any) => l.source === sourceNode.id && l.target === targetNode.id)
          if (isDuplicate) continue
          
          refLinks.push({
            source: sourceNode.id,
            target: targetNode.id,
            type: 'reference',
            value: 1,
            style: { fill: '#69b34c', stroke: '#69b34c' }
          })
        }
      } catch (e) {
        // 跳过无法读取的文件
      }
    }
    return refLinks
  }

  // 切换双向链接显示
  const toggleBidirectionalLinks = async function() {
    showBidirectionalLinks.value = !showBidirectionalLinks.value
    if (showBidirectionalLinks.value) {
      fileReferenceLinks.value = await computeFileReferences()
    } else {
      fileReferenceLinks.value = []
    }
    renderGraph()
  }

  // 切换文件夹层级结构显示
  const toggleHierarchy = function() {
    showHierarchy.value = !showHierarchy.value
    renderGraph()
  }

  // ---- 悬浮提示（跟随鼠标显示节点信息） ----
  /** 格式化文件大小（字节 → B/KB/MB/GB） */
  const formatSize = (size?: number) => {
    if (size == null || size < 0) return ''
    if (size < 1024) return size + ' B'
    const units = ['KB', 'MB', 'GB', 'TB']
    let value = size / 1024
    let i = 0
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024
      i++
    }
    return value.toFixed(1) + ' ' + units[i]
  }

  /** 格式化修改时间（时间戳 → yyyy-MM-dd HH:mm） */
  const formatTime = (mtime?: number) => {
    if (!mtime) return ''
    const d = new Date(mtime)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  const tooltipVisible = ref(false)
  const tooltipPos = ref({ x: 0, y: 0 })
  const tooltipData = ref<any>(null)
  let tipSize = { w: 0, h: 0 }

  /** 鼠标移入节点时显示提示（首次显示时测量尺寸以决定防溢出方向） */
  const showTooltip = (e: MouseEvent, data: any) => {
    tooltipData.value = data
    if (!tooltipVisible.value) {
      tooltipVisible.value = true
      nextTick(() => {
        const el = document.querySelector('.graph-tooltip') as HTMLElement | null
        if (el) tipSize = { w: el.offsetWidth, h: el.offsetHeight }
        // 测量完成后重新定位，避免首次显示时位置跳动
        updateTooltipPos(e)
      })
    }
    updateTooltipPos(e)
  }

  /** 鼠标移动时更新提示位置：默认悬浮框在鼠标右上方（鼠标位于悬浮框左下角），超出视口时翻转方向 */
  const updateTooltipPos = (e: MouseEvent) => {
    if (!tooltipVisible.value) return
    // 默认：悬浮框左上角位于 (clientX, clientY - 高度)，即鼠标位于悬浮框左下角
    let x = e.clientX
    let y = e.clientY - tipSize.h
    // 右侧溢出 → 移到鼠标左侧（鼠标位于悬浮框右下角）
    if (tipSize.w && x + tipSize.w > window.innerWidth - 4) x = e.clientX - tipSize.w
    // 顶部溢出 → 移到鼠标下方（鼠标位于悬浮框左上角）
    if (tipSize.h && y < 4) y = e.clientY
    tooltipPos.value = { x: Math.max(4, x), y: Math.max(4, y) }
  }

  // 提示内容变化时（如不同长度文件名）重新测量尺寸，确保防溢出方向正确
  watch(tooltipData, () => {
    if (tooltipVisible.value && tooltipData.value) {
      nextTick(() => {
        const el = document.querySelector('.graph-tooltip') as HTMLElement | null
        if (el) tipSize = { w: el.offsetWidth, h: el.offsetHeight }
      })
    }
  })

  /** 鼠标移出节点时隐藏提示 */
  const hideTooltip = () => {
    tooltipVisible.value = false
    tooltipData.value = null
  }

  // 双击文件节点打开文件：与右键「打开」走同一条路径，一律在独立窗口打开
  const nodeDblClick = function(_event: any, d: any) {
    if (d.type !== 'file' && d.type !== 'folder') return
    openNode(d)
  }

  // 计算文件树的最大深度
  const getMaxDepth = function(tree: any[], currentDepth: number = 1): number {
    let max = currentDepth
    for (const node of tree) {
      if (node.children && node.children.length > 0) {
        const childDepth = getMaxDepth(node.children, currentDepth + 1)
        if (childDepth > max) max = childDepth
      }
    }
    return max
  }
  const maxDepth = ref(5)
  watch(() => store.tree, (val) => {
    if (val && val.length > 0) {
      maxDepth.value = Math.max(getMaxDepth(val), 1)
    }
  }, { immediate: true })

  // ---- 文件系统变更 → 自动刷新图谱 ----
  // 图谱数据由主进程实时读取目录（含 .md 的 frontmatter 属性与引用关系），
  // 外部新增/删除/改名以及文件内容（属性、链接）变化都需要重读；主进程与 fileWatch
  // 已各自去抖，这里再合并一次，避免连续写文件（如知识处理批量产出）时反复全量重绘。
  const GRAPH_REFRESH_DEBOUNCE_MS = 600
  let disposeFileWatch: (() => void) | null = null
  let watchAcquired = false
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let refreshing = false
  let refreshPending = false

  const scheduleGraphRefresh = function(){
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      void refreshGraph()
    }, GRAPH_REFRESH_DEBOUNCE_MS)
  }

  // 重读数据并重绘；上一次重绘未结束时再次触发，合并为结束后的最后一次
  const refreshGraph = async function(){
    if (refreshing) {
      refreshPending = true
      return
    }
    refreshing = true
    try {
      await init(true)
    } finally {
      refreshing = false
      if (refreshPending) {
        refreshPending = false
        scheduleGraphRefresh()
      }
    }
  }

  watch([()=>store.root, ()=>store.path], (newValue, oldValue) => {
    init(true)
  })
  // 顶部工具栏的「刷新」：重新拉取当前目录并重建图谱
  watch(() => store.knowRefreshTick, () => { init(true) })
  onMounted(() => {
    init()
    // 订阅文件系统变更：目录内容或文件内容变化时自动刷新图谱（与其它视图共享同一监听与去抖）
    disposeFileWatch = onFileSystemChanged(() => { scheduleGraphRefresh() })
    // 按租约参与目录监听：左侧面板收起（panel.vue 卸载）或图谱单列显示时仍能收到变更
    if (store.roots?.length) {
      watchAcquired = true
      void acquireFileWatch([...store.roots])
    }
    window.addEventListener('resize', resize)
    document.addEventListener('click', hideContextMenu)
    // 子菜单溢出检测
    document.addEventListener('mouseover', handleSubmenuOverflow)
  });
  onBeforeUnmount(() => {
    disposeFileWatch?.()
    disposeFileWatch = null
    if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }
    if (watchAcquired) {
      watchAcquired = false
      releaseFileWatch()
    }
    window.removeEventListener('resize', resize)
    document.removeEventListener('click', hideContextMenu)
    document.removeEventListener('mouseover', handleSubmenuOverflow)
    // 停止力导向模拟
    if (simulation) {
      simulation.stop()
      simulation = null
    }
    // 移除 SVG 以清理 zoom 事件绑定
    if (graphContainer.value) {
      d3.select(graphContainer.value).select('svg').remove()
    }
  })
</script>

<template >
  <div class="graph">
    <!-- 顶部工具栏（路径面包屑 + 搜索）由 explorer.vue 统一渲染一条 -->
    <!-- 节点右键菜单 -->
    <div v-if="nodeCtxMenu.visible" class="context-menu" 
         :style="{ left: nodeCtxMenu.x + 'px', top: nodeCtxMenu.y + 'px' }">
      <div class="menu-item" @click="openNode(nodeCtxMenu.nodeData)">
        <i class="fa fa-file-text-o"></i> {{store.locales=='zh'?'打开':'Open'}}
      </div>
      <div class="menu-item" @click="renameNode(nodeCtxMenu.nodeData)">
        <i class="fa fa-pencil"></i> {{store.locales=='zh'?'重命名':'Rename'}}
      </div>
      <div class="menu-item" @click="deleteNode(nodeCtxMenu.nodeData)">
        <i class="fa fa-trash-o"></i> {{store.locales=='zh'?'删除':'Delete'}}
      </div>
      <div class="menu-item" @click="openNodeInFolder(nodeCtxMenu.nodeData)">
        <i class="fa fa-folder"></i> {{store.locales=='zh'?'系统位置':'Show in Folder'}}
      </div>
    </div>
    
    <!-- 右侧设置面板 -->
    <div class="panel scoll" v-if="panelType!=''" style="width:230px">
      <!-- 全部字段开启/关闭（从右键菜单移入） -->
      <div class="panel-actions">
        <button class="panel-action-btn" @click="expandAllAttributes()">
          <i class="fa fa-toggle-on"></i> {{store.locales=='zh'?'全部开启':'All On'}}
        </button>
        <button class="panel-action-btn" @click="collapseAllAttributes()">
          <i class="fa fa-toggle-off"></i> {{store.locales=='zh'?'全部关闭':'All Off'}}
        </button>
      </div>
      
      <div v-if="panelType=='设置'">
        <table>
          <tr v-for="(item,index) in attributes" :key="index" style="text-align: center;">
            <td><i class="fa fa-file-text"></i></td>
            <td style="max-width:100px;text-overflow: ellipsis;" :title="item.name">{{item.name}}</td>
            <td @click="expandAttribute(index,-1)" v-if="item.state==0||item.state==1"><i class="fa fa-toggle-off" /></td>
            <td @click="expandAttribute(index,0)" v-if="item.state==-1"><i class="fa fa-toggle-on" /></td>
            <td @click="expandAttribute(index,1)" v-if="item.state==0||item.state==-1"><i class="fa fa-toggle-off" /></td>
            <td @click="expandAttribute(index,0)" v-if="item.state==1"><i class="fa fa-toggle-on" /></td>
          </tr>
        </table>
      </div>
    </div>
    
    <!-- 悬浮提示（跟随鼠标显示节点信息） -->
    <div v-if="tooltipVisible && tooltipData" class="graph-tooltip" :style="{ left: tooltipPos.x + 'px', top: tooltipPos.y + 'px' }">
      <div class="tooltip-name">{{ tooltipData.label }}</div>
      <div v-if="tooltipData.type !== 'folder' && tooltipData.size != null">{{ store.locales=='zh'?'大小':'Size' }}: {{ formatSize(tooltipData.size) }}</div>
      <div v-if="tooltipData.mtime">{{ store.locales=='zh'?'修改时间':'Modified' }}: {{ formatTime(tooltipData.mtime) }}</div>
    </div>

    <!-- 图形容器 -->
    <div ref="graphContainer" id="graphContainer" @click="closePanel"></div>

    <!-- 底部状态栏：布局/深度/开关/字段设置 + 节点统计（路径与搜索在顶部工具栏） -->
    <div class="graph-statusbar">
      <span v-if="store.folderName" class="statusbar-item status-folder" :title="store.dataDir" style="max-width:220px"><i class="fa fa-folder-open-o"></i><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ store.folderName }}</span></span>
      <span v-if="store.folderName" class="statusbar-sep"></span>
      <button class="statusbar-btn" @click="resetView()" :title="store.locales=='zh'?'聚焦视图':'Reset view'"><i class="fa fa-arrows-alt"></i></button>
      <span class="statusbar-sep"></span>
      <span class="statusbar-item"><i class="fa fa-share-alt"></i> {{ store.locales=='zh'?'布局':'Layout' }}</span>
      <select class="statusbar-select" v-model="layoutType" @change="renderGraph()" :title="store.locales=='zh'?'布局方式':'Layout mode'">
        <option value="force">{{ store.locales=='zh'?'力导向':'Force' }}</option>
        <option value="circle">{{ store.locales=='zh'?'圆形':'Circle' }}</option>
        <option value="tree">{{ store.locales=='zh'?'树状':'Tree' }}</option>
        <option value="concentric">{{ store.locales=='zh'?'同心圆':'Concentric' }}</option>
        <option value="grid">{{ store.locales=='zh'?'网格':'Grid' }}</option>
      </select>
      <span class="statusbar-item"><i class="fa fa-sitemap"></i> {{ store.locales=='zh'?'深度':'Depth' }}</span>
      <select class="statusbar-select" v-model.number="deep" @change="init(true)" :title="store.locales=='zh'?'读取深度':'Read depth'">
        <option v-for="d in maxDepth" :key="d" :value="d">{{ d }}</option>
      </select>
      <button class="statusbar-btn" :class="{ active: showHierarchy }" @click="toggleHierarchy()"
              :title="store.locales=='zh'?'文件结构':'Folder hierarchy'"><i class="fa fa-folder-open-o"></i></button>
      <button class="statusbar-btn" :class="{ active: showBidirectionalLinks }" @click="toggleBidirectionalLinks()"
              :title="store.locales=='zh'?'引用关系':'References'"><i class="fa fa-link"></i></button>
      <button class="statusbar-btn" :class="{ active: panelType==='设置' }" @click="panelType = panelType==='设置' ? '' : '设置'"
              :title="store.locales=='zh'?'字段设置':'Field settings'"><i class="fa fa-cogs"></i></button>
      <span class="statusbar-spacer"></span>
      <span class="statusbar-item" :title="store.locales=='zh'?'文件':'Files'"><i class="fa fa-file" style="color:#4a9eff"></i> {{ (data?.nodes||[]).filter((n:any) => n.type === 'file').length }}</span>
      <span class="statusbar-item" :title="store.locales=='zh'?'文件夹':'Folders'"><i class="fa fa-folder" style="color:#50c878"></i> {{ (data?.nodes||[]).filter((n:any) => n.type === 'folder').length }}</span>
      <span class="statusbar-item" :title="store.locales=='zh'?'其他':'Others'"><i class="fa fa-tag" style="color:#ff9a4a"></i> {{ (data?.nodes||[]).filter((n:any) => n.type !== 'file' && n.type !== 'folder').length }}</span>
    </div>
  </div>
</template>

<style scoped>
  .graph{
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--backgroundColor);
    overflow: hidden;
    border-right: 1px solid var(--borderColor);
    box-sizing: border-box;
    position: relative;
  }
  
  #graphContainer{
    width:100%;
    position: relative;
    flex: 1;
    min-height: 0;
    cursor: default;
  }
  
  /* 右侧面板样式 */
  .panel{
    position: absolute;
    right: 0;
    top: 0;
    bottom: 24px; /* 底部为状态栏让位 */
    width: 230px;
    background-color: var(--backgroundColor);
    border-left:1px solid var(--borderColor) ;
    overflow-y: auto;
    z-index: 10;
    opacity: 0.95;
    user-select: none;
  }
  
  .panel .scoll {
    padding: 10px;
  }
  
  /* 面板顶部操作按钮（全部字段开启/关闭） */
  .panel-actions {
    display: flex;
    flex-direction: row;
    gap: 5px;
    padding: 5px;
    border-bottom: 1px solid var(--borderColor);
  }
  .panel-action-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 10px;
    font-size: 12px;
    color: var(--fontColor);
    background: var(--menuColor);
    border: 1px solid var(--borderColor);
    border-radius: 4px;
    cursor: pointer;
    user-select: none;
    transition: background 0.2s;
    text-align: center;
  }
  .panel-action-btn:hover {
    background: var(--menuActiveColor);
  }
  
  table {
    width: 100%;
    border-collapse: collapse;
  }
  
  td{
    font-size: 12px;
    padding: 4px 2px;
    border-bottom: 1px solid var(--borderColor);
  }
  
  /* 右键菜单样式统一在 style.css（.context-menu + 知识管理紧凑变体）中定义 */
  
  /* 右下角节点统计 */
  .node-stats {
    position: absolute;
    bottom: 8px;
    right: 8px;
    display: flex;
    gap: 12px;
    background: var(--backgroundColor);
    border: 1px solid var(--borderColor);
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 12px;
    opacity: 0.85;
    user-select: none;
    pointer-events: none;
    z-index: 5;
  }
  
  .stat-item {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--fontColor);
  }
  
  .stat-file i { color: #4a9eff; }
  .stat-folder i { color: #50c878; }
  .stat-meta i { color: #ff9a4a; }

  /* 悬浮提示（跟随鼠标显示节点信息） */
  .graph-tooltip {
    position: fixed;
    z-index: 99999;
    background: var(--menuColor);
    color: var(--fontColor);
    font-size: 12px;
    line-height: 1.8;
    white-space: nowrap;
    padding: 6px 10px;
    border-radius: 4px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, .25);
    pointer-events: none;
    max-width: 60vw;
  }

  /* 节点名：过长时换行显示，避免超出视口 */
  .tooltip-name {
    white-space: normal;
    word-break: break-all;
    font-weight: bold;
    color: var(--fontColor);
  }

  /* ===== 底部状态栏（与代码编辑/阅读视图一致观感） ===== */
  .graph-statusbar{
    display:flex; align-items:center; gap:8px; flex-shrink:0;
    height:24px; box-sizing:border-box; padding:0 8px;
    font-size:12px; color:var(--fontColor);
    background-color:var(--menuColor);
    border-top:1px solid var(--borderColor);
    user-select:none; white-space:nowrap; overflow:hidden;
  }
  .graph-statusbar .statusbar-item{ display:inline-flex; align-items:center; gap:4px; opacity:.85; }
  .graph-statusbar .statusbar-item i{ font-size:11px; opacity:.7; }
  .graph-statusbar .statusbar-spacer{ flex:1; }
  .graph-statusbar .statusbar-btn{
    margin:0; padding:0 6px; height:18px; border:none; border-radius:3px; background:transparent;
    color:var(--fontColor); font-size:12px; display:inline-flex; align-items:center; justify-content:center;
    cursor:pointer; opacity:.85; transition:background-color .15s; flex-shrink:0;
  }
  .graph-statusbar .statusbar-btn:hover{ background:var(--menuActiveColor); opacity:1; }
  .graph-statusbar .statusbar-btn.active{ color:var(--fontActiveColor); opacity:1; }
  .graph-statusbar .statusbar-sep{ width:1px; height:14px; background:var(--borderColor); flex-shrink:0; }
  .graph-statusbar .statusbar-select{
    height:18px; border:1px solid var(--borderColor); border-radius:3px;
    background: var(--backgroundColor); color:var(--fontColor); font-size:11px; padding:0 4px;
    width:auto; max-width:110px; outline:none; cursor:pointer; flex-shrink:0;
  }
  .graph-statusbar .statusbar-select option{
    background: var(--backgroundColor); color: var(--fontColor);
  }
</style>