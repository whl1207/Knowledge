<script setup lang="ts">
  import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, defineAsyncComponent } from 'vue'
  import { usestore } from '@/store'
  import * as pdfjsLib from 'pdfjs-dist'
  import { TextLayer } from 'pdfjs-dist'
  import { ElMessage } from 'element-plus'
  // 左侧目录：与浏览 / 源码编辑 / 块编辑共用同一个面板组件
  import DocTocPanel from '@/components/knowFile/view/DocTocPanel.vue'
  import { loadDocTocWidth, saveDocTocWidth, loadDocTocOpen, saveDocTocOpen, flattenTocTree, DOC_TOC_MIN_WIDTH, DOC_TOC_MAX_WIDTH, type TocFlatItem } from '@/lib/markdown/toc'
  import { loadDocChatWidth, saveDocChatWidth, DOC_CHAT_MIN_WIDTH, DOC_CHAT_MAX_WIDTH } from '@/lib/knowFile/panelWidths'
  import { ocrImage, ocrProviderLabel, rankOcrModels, hasVisionLikeModel, loadOcrModelPref, saveOcrModelPref, llmConfigByKey, loadOcrSourcePref, saveOcrSourcePref, OCR_SELECTABLE_SOURCES, OCR_MAX_IMAGE_SIDE } from '@/lib/knowFile/ocr'
  // 智能对话面板：与 md_read 共用同一个组件（避免两套对话逻辑漂移）
  const DocChatPanel = defineAsyncComponent(() => import('@/components/knowFile/view/DocChatPanel.vue'))

  // 全局只需设置一次 worker 路径（相对路径，兼容 dev server 和 Electron file://）
  pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs'

  const store = usestore()

  const props = defineProps<{
    path?: string
    /** 可选：直接提供 PDF 的 base64（不含 data: 前缀）。用于远程文件预览，跳过本地 IPC 读取 */
    base64?: string
  }>()

  const emit = defineEmits<{
    loaded: [pageCount: number]
    error: [message: string]
  }>()

  // === 状态 ===
  const loading = ref(false)
  const errorMsg = ref('')
  const pageCount = ref(0)
  const currentPage = ref(1)
  // 缩放：userScale 为用户缩放倍率（1 = 铺满容器），fitScale 为铺满容器所需的缩放
  const userScale = ref(1)
  const fitScale = ref(1)
  const pan = ref({ x: 0, y: 0 }) // 平移偏移
  const isDragging = ref(false)
  const dragStart = ref({ x: 0, y: 0 })
  const canvasRef = ref<HTMLCanvasElement | null>(null)
  const viewportRef = ref<HTMLDivElement | null>(null)
  // 单页模式：页面盒（画布 + 可选中文本层都放在盒内，保证同步缩放/平移）
  const pageBoxRef = ref<HTMLDivElement | null>(null)
  const textLayerRef = ref<HTMLDivElement | null>(null)
  let textLayerToken = 0
  // 连续滚动模式容器（多页顺序向下阅读）
  const scrollRef = ref<HTMLDivElement | null>(null)

  // === 深色阅读 ===
  // 思路：不去改 PDF 像素，而是对「渲染面」加 CSS filter（GPU 合成、零重渲染成本）：
  //   dark = invert(1) hue-rotate(180deg)：保色反色，黑字白底 → 白字黑底，彩色图表色相基本不变
  //   soft = invert(0.88) hue-rotate(180deg)：深灰底、对比更低
  // 文本层不加 filter（文字本身透明，选区高亮保持原色）；代价是 PDF 内嵌图片/扫描件也会被反色。
  type PdfDarkMode = 'off' | 'dark' | 'soft'
  function isDarkTheme(): boolean {
    try {
      const bg = String((store as any).UI?.backgroundColor || '#ffffff').replace('#', '')
      if (bg.length < 6) return false
      const r = parseInt(bg.slice(0, 2), 16)
      const g = parseInt(bg.slice(2, 4), 16)
      const b = parseInt(bg.slice(4, 6), 16)
      return r * 0.299 + g * 0.587 + b * 0.114 < 128
    } catch { return false }
  }
  const darkMode = ref<PdfDarkMode>('off')
  try {
    const savedDark = localStorage.getItem('pdf_dark_mode')
    if (savedDark === 'off' || savedDark === 'dark' || savedDark === 'soft') darkMode.value = savedDark
    // 首次使用：界面本身是深色主题时默认开启反色，避免白页刺眼（之后以用户选择为准）
    else if (isDarkTheme()) darkMode.value = 'dark'
  } catch { /* ignore */ }
  const darkClass = computed(() => (
    darkMode.value === 'off' ? '' : darkMode.value === 'dark' ? 'pdf-dark' : 'pdf-soft'
  ))
  const cycDarkMode = () => {
    darkMode.value = darkMode.value === 'off' ? 'dark' : darkMode.value === 'dark' ? 'soft' : 'off'
    try { localStorage.setItem('pdf_dark_mode', darkMode.value) } catch { /* ignore */ }
  }
  // 图标（Font Awesome 4.7 无 fa-moon，只有 fa-moon-o）：图标表示「当前状态」
  const darkModeIcon = computed(() => (
    darkMode.value === 'off' ? 'fa-sun-o' : darkMode.value === 'dark' ? 'fa-moon-o' : 'fa-adjust'
  ))
  const darkModeTitle = computed(() => {
    const zh = store.locales === 'zh'
    if (darkMode.value === 'off') return zh ? '深色阅读：反色显示 PDF（点击开启）' : 'Dark reading: invert PDF (click to on)'
    if (darkMode.value === 'dark') return zh ? '深色阅读：反色（黑底白字），点击切换柔和反色' : 'Dark reading: inverted, click for soft'
    return zh ? '深色阅读：柔和反色（深灰底），点击关闭' : 'Dark reading: soft, click to turn off'
  })

  // 滚轮模式：zoom = 单页缩放（铺满 + 滚轮缩放 / 拖拽平移）；scroll = 多页连续向下滚动阅读
  const wheelMode = ref<'zoom' | 'scroll'>('zoom')
  try {
    const savedMode = localStorage.getItem('pdf_wheel_mode')
    if (savedMode === 'zoom' || savedMode === 'scroll') wheelMode.value = savedMode
  } catch { /* ignore */ }
  const isScrollMode = computed(() => wheelMode.value === 'scroll')
  // 缩放下限：单页模式 0.2；连续模式最小 1（铺满宽度，两侧不留空白）
  const minUserScale = computed(() => (isScrollMode.value ? 1 : 0.2))
  const setUserScale = (v: number) => {
    userScale.value = Math.max(minUserScale.value, Math.min(8, v))
  }
  // 连续模式：每页原始尺寸（scale=1，模板用 CSS calc 乘缩放变量占位）
  const pageRawSizes = ref<{ w: number; h: number }[]>([])
  const scrollReady = ref(false)
  const pageEls = ref<(HTMLElement | null)[]>([])
  // 已渲染页 → 渲染时的缩放（缩放变化后需重渲染才清晰）
  const renderScaleOf = new Map<number, number>()
  let pageObserver: IntersectionObserver | null = null
  let scrollBaseWidth = 0
  let scrollRelayoutTimer: ReturnType<typeof setTimeout> | null = null
  let suppressScrollSync = false
  let suppressTimer: ReturnType<typeof setTimeout> | null = null
  let skipScaleRelayout = false

  let pdfDoc: any = null
  let renderTask: any = null
  let loadTimer: ReturnType<typeof setTimeout> | null = null
  let resizeObserver: ResizeObserver | null = null

  // === OCR 状态 ===
  const ocrModels = ref<string[]>([])
  const ocrSelectedModel = ref('')
  const ocrRunning = ref(false)
  const ocrCancelled = ref(false)
  const ocrCurrentPage = ref(0)
  const ocrProgress = ref('')
  // ocrResults: { page: number, text: string }[]
  const ocrResults = ref<{ page: number; text: string }[]>([])
  // 当前正在流式输出的页内容
  const ocrStreamText = ref('')
  const ocrActiveTab = ref(0) // 当前激活的 tab 索引


  // === 清理 ===
  const cleanup = () => {
    if (renderTask) { try { renderTask.cancel() } catch {} renderTask = null }
    if (pdfDoc) { try { pdfDoc.destroy() } catch {} pdfDoc = null }
    if (loadTimer) { clearTimeout(loadTimer); loadTimer = null }
    pdfDoc = null
    pageCount.value = 0
    currentPage.value = 1
    userScale.value = 1
    fitScale.value = 1
    pan.value = { x: 0, y: 0 }
    isDragging.value = false
    // 重新加载 / 卸载时清理右侧面板状态（对话面板由 DocChatPanel 自行按 docKey 清空）
    textExtractRunning.value = false
    textExtractCancelled.value = false
    textExtractResult.value = ''
    textExtractProgress.value = ''
    pdfFullTextCache = ''
    ocrResults.value = []
    ocrStreamText.value = ''
    ocrProgress.value = ''
    ocrRunning.value = false
    ocrCancelled.value = true
    ocrActiveTab.value = 0
    resetScrollMode()
    pageRawSizes.value = []
    textLayerToken++
    if (textLayerRef.value) textLayerRef.value.replaceChildren()
    tocItems.value = []
    activeTocId.value = -1
  }

  // === 渲染当前页（铺满容器，支持滚轮缩放 / 拖拽平移） ===
  const renderPage = async () => {
    if (!pdfDoc) return
    const canvas = canvasRef.value
    const container = viewportRef.value
    if (!canvas || !container) return

    if (renderTask) {
      try { renderTask.cancel() } catch {}
      renderTask = null
    }

    let page: any
    try {
      page = await pdfDoc.getPage(currentPage.value)
    } catch (err: any) {
      if (err?.name === 'RenderingCancelledException') return
      console.error('[PdfViewer] 获取页面失败:', err)
      return
    }

    // 计算铺满容器的缩放（同时考虑宽和高），随窗口缩放自动适配
    const baseViewport = page.getViewport({ scale: 1 })
    const pad = 12
    const containerW = Math.max(1, container.clientWidth - pad * 2)
    const containerH = Math.max(1, container.clientHeight - pad * 2)
    fitScale.value = Math.max(0.01, Math.min(containerW / baseViewport.width, containerH / baseViewport.height))

    const finalScale = fitScale.value * userScale.value
    const viewport = page.getViewport({ scale: finalScale })
    const dpr = window.devicePixelRatio || 1

    // 先同步更新页面盒尺寸与位置获得即时反馈，再异步渲染内容
    const box = pageBoxRef.value
    if (box) {
      box.style.width = viewport.width + 'px'
      box.style.height = viewport.height + 'px'
      box.style.cursor = userScale.value > 1 ? 'grab' : 'default'
    }
    canvas.width = viewport.width * dpr
    canvas.height = viewport.height * dpr
    canvas.style.width = viewport.width + 'px'
    canvas.style.height = viewport.height + 'px'
    clampPan()
    applyTransform()

    // 文本层：让 PDF 文字可框选复制（与画布渲染并行）
    const token = ++textLayerToken
    savedSelectionRanges = []
    renderTextLayer(page, viewport, token)

    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, viewport.width, viewport.height)

    const renderContext = { canvasContext: ctx, viewport }
    renderTask = page.render(renderContext)
    try {
      await renderTask.promise
    } catch (err: any) {
      if (err?.name === 'RenderingCancelledException') return
      console.error('[PdfViewer] 渲染失败:', err)
    } finally {
      renderTask = null
    }
  }

  // === 文本层（让 PDF 文字可框选复制） ===
  // pdf.js 的文本层：透明文字按原位置叠在画布上，支持原生框选 / 复制（含 Ctrl+C）
  const renderTextLayer = async (page: any, viewport: any, token: number) => {
    const container = textLayerRef.value
    if (!container) return
    container.replaceChildren()
    container.style.setProperty('--scale-factor', String(viewport.scale))
    try {
      const textContent = await page.getTextContent()
      if (token !== textLayerToken || textLayerRef.value !== container) return
      const layer = new TextLayer({ textContentSource: textContent, container, viewport })
      await layer.render()
    } catch (err) {
      console.error('[PdfViewer] 文本层渲染失败:', err)
    }
  }

  // 连续阅读模式：单页文本层（懒渲染；--scale-factor 由连续容器统一提供）
  const renderScrollTextLayer = async (page: any, viewport: any, el: HTMLElement) => {
    const container = el.querySelector('.pdf-text-layer') as HTMLElement | null
    if (!container) return
    savedSelectionRanges = []
    container.replaceChildren()
    try {
      const textContent = await page.getTextContent()
      const layer = new TextLayer({ textContentSource: textContent, container, viewport })
      await layer.render()
    } catch (err) {
      console.error('[PdfViewer] 文本层渲染失败:', err)
    }
  }

  // 事件是否落在文本层文字上（命中时不拦截，交给原生框选）
  const isOnTextSpan = (e: Event) => {
    const t = e.target as HTMLElement | null
    if (!t) return false
    if (t.tagName !== 'SPAN' && t.tagName !== 'BR') return false
    return !!t.closest('.pdf-text-layer')
  }

  // === 加载 PDF ===
  const load = async () => {
    cleanup()
    const filePath = props.path
    if (!filePath && !props.base64) return

    loading.value = true
    errorMsg.value = ''

    // 15s 超时
    loadTimer = setTimeout(() => {
      if (loading.value) {
        loading.value = false
        errorMsg.value = 'PDF加载超时（15s），请检查文件或控制台错误'
        console.error('[PdfViewer] 加载超时')
      }
    }, 15000)

    try {
      let base64 = props.base64 || ''
      if (!base64 && filePath) {
        const result = await window.ipcRenderer.invoke('readFileBase64', filePath)
        if (typeof result !== 'string' || !result.startsWith('data:')) {
          throw new Error(typeof result === 'string' ? result : '读取PDF文件失败')
        }
        base64 = result.split(',')[1]
      }
      if (!base64) {
        throw new Error('PDF数据为空')
      }

      const binaryStr = atob(base64)
      const bytes = new Uint8Array(binaryStr.length)
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i)
      }

      const loadingTask = pdfjsLib.getDocument({ data: bytes })
      const pdf = await loadingTask.promise
      pdfDoc = pdf
      pageCount.value = pdf.numPages
      loading.value = false
      errorMsg.value = ''
      if (loadTimer) { clearTimeout(loadTimer); loadTimer = null }

      // 读取 PDF 书签作为目录（无书签时不显示目录入口）
      await buildToc()

      emit('loaded', pdf.numPages)
      await nextTick()
      if (isScrollMode.value) await layoutScrollMode()
      else renderPage()
    } catch (err: any) {
      console.error('[PdfViewer] 加载失败:', err)
      errorMsg.value = err.message || 'PDF加载失败'
      loading.value = false
      emit('error', errorMsg.value)
    }
  }

  // === 控件 ===
  const prevPage = () => gotoPage(currentPage.value - 1)
  const nextPage = () => gotoPage(currentPage.value + 1)
  const goToPage = (e: Event) => {
    const input = e.target as HTMLInputElement
    let p = parseInt(input.value)
    if (isNaN(p) || p < 1) p = 1
    if (p > pageCount.value) p = pageCount.value
    gotoPage(p, false)
  }

  // === 目录（PDF 书签 Outline） ===
  // 层级线/展平走共享目录模块（lib/markdown/toc.ts 的 flattenTocTree），展示走共享面板 DocTocPanel；
  // 本组件只负责 PDF 特有的事：解析书签目标页码、按当前页高亮、点目录翻页
  interface PdfTocEntry extends TocFlatItem {
    page: number | null   // 目标页码（1 起）；null = 无法解析（如纯外链书签）
    url?: string          // 外链书签
  }
  const tocVisible = ref(loadDocTocOpen())
  /** 显式开合（状态栏按钮 / 面板关闭按钮）：写回共享状态，其它视图跟随 */
  const setTocOpen = (v: boolean) => { tocVisible.value = v; saveDocTocOpen(v) }
  const tocItems = ref<PdfTocEntry[]>([])
  const activeTocId = ref(-1)
  const hasToc = computed(() => tocItems.value.length > 0)

  /** 目录项 tooltip：带页码（与改造前的提示一致） */
  const pdfTocItemTitle = (item: TocFlatItem) => {
    const e = item as PdfTocEntry
    if (e.page == null) return e.text
    return `${e.text} · ${store.locales === 'zh' ? '第 ' + e.page + ' 页' : 'p.' + e.page}`
  }
  /** 既没有页码也没有外链 → 置灰（点了也没地方去） */
  const pdfTocItemDisabled = (item: TocFlatItem) => {
    const e = item as PdfTocEntry
    return e.page == null && !e.url
  }

  // 解析书签目标页码：dest 可能是命名目标字符串或显式目标数组
  const resolveDestPage = async (dest: any): Promise<number | null> => {
    if (!pdfDoc || dest == null) return null
    try {
      let explicit: any = dest
      if (typeof dest === 'string') explicit = await pdfDoc.getDestination(dest)
      if (!Array.isArray(explicit) || explicit.length === 0) return null
      const ref = explicit[0]
      if (ref == null) return null
      const pageIndex = typeof ref === 'number' ? ref : await pdfDoc.getPageIndex(ref)
      if (!Number.isFinite(pageIndex)) return null
      return pageIndex + 1
    } catch (err) {
      return null
    }
  }

  // 读取书签并用共享目录模块展平（层级线规则见 lib/markdown/toc.ts 的 flattenTocTree）
  const buildToc = async () => {
    tocItems.value = []
    activeTocId.value = -1
    if (!pdfDoc) return
    let outline: any[] | null = null
    try {
      outline = await pdfDoc.getOutline()
    } catch (err) {
      console.error('[PdfViewer] 读取目录失败:', err)
      return
    }
    if (!outline || outline.length === 0) return

    // PDF 书签特有的字段（目标页码 / 外链）挂在节点上，展平后按 id 回查
    interface PdfTocNode { text: string; page: number | null; url?: string; children: PdfTocNode[] }
    const walk = async (list: any[]): Promise<PdfTocNode[]> => {
      const nodes: PdfTocNode[] = []
      for (const it of list) {
        const node: PdfTocNode = {
          text: String(it.title ?? '').replace(/\s+/g, ' ').trim() || '—',
          page: await resolveDestPage(it.dest),
          url: it.url || undefined,
          children: [],
        }
        if (Array.isArray(it.items) && it.items.length > 0) node.children = await walk(it.items)
        nodes.push(node)
      }
      return nodes
    }
    const roots = await walk(outline)

    const nodeById = new Map<number, PdfTocNode>()
    const flat = flattenTocTree(roots, (node, id) => { nodeById.set(id, node); return { text: node.text } })
    tocItems.value = flat.map((it) => {
      const node = nodeById.get(it.id)
      return { ...it, page: node?.page ?? null, url: node?.url }
    })
    syncActiveToc()
  }

  // 根据当前页高亮目录项（取最后一个「起始页 ≤ 当前页」的条目）
  const syncActiveToc = () => {
    const items = tocItems.value
    if (items.length === 0) { activeTocId.value = -1; return }
    let current = -1
    for (const it of items) {
      if (it.page != null && it.page <= currentPage.value) current = it.id
    }
    activeTocId.value = current
  }

  // 点击目录项：跳到对应页（外链书签则打开链接）
  const goToTocItem = (item: PdfTocEntry) => {
    if (item.url) { window.open(item.url, '_blank'); return }
    if (item.page == null) return
    activeTocId.value = item.id
    gotoPage(item.page)
  }

  const toggleToc = () => {
    if (!hasToc.value) return
    setTocOpen(!tocVisible.value)
  }

  // 目录栏宽度（与其它视图共用同一个 key 与初始值，见 lib/markdown/toc.ts）
  // 拖动由共享面板内部处理，这里只负责把宽度变化持久化
  const tocNavWidth = ref(loadDocTocWidth())
  watch(tocNavWidth, (v) => saveDocTocWidth(v))

  /** 点击目录项：按 id 找回书签目标（面板只回传 id） */
  const onSelectTocItem = (id: number) => {
    const item = tocItems.value.find((it) => it.id === id)
    if (item) goToTocItem(item)
  }

  // === 缩放 / 平移 ===
  // 应用平移变换到页面盒（以容器中心为原点，translate(-50%,-50%) 实现居中）
  const applyTransform = () => {
    const box = pageBoxRef.value
    if (!box) return
    box.style.transform = `translate(calc(-50% + ${pan.value.x}px), calc(-50% + ${pan.value.y}px))`
  }

  // 限制平移范围，防止页面被拖出可视区
  const clampPan = () => {
    const box = pageBoxRef.value
    const container = viewportRef.value
    if (!box || !container) return
    const cw = container.clientWidth
    const ch = container.clientHeight
    const cw2 = parseFloat(box.style.width) || 0
    const ch2 = parseFloat(box.style.height) || 0
    const maxX = Math.max(0, (cw2 - cw) / 2)
    const maxY = Math.max(0, (ch2 - ch) / 2)
    pan.value.x = Math.max(-maxX, Math.min(maxX, pan.value.x))
    pan.value.y = Math.max(-maxY, Math.min(maxY, pan.value.y))
  }

  // 滚轮缩放（以鼠标位置为中心缩放）
  const handleWheel = (e: WheelEvent) => {
    if (!pdfDoc) return
    // 连续模式：滚轮交给浏览器原生滚动（Ctrl+滚轮才缩放）
    if (isScrollMode.value) return
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
    const newScale = Math.max(0.2, Math.min(8, userScale.value * factor))
    if (newScale === userScale.value) return

    const container = viewportRef.value
    if (container) {
      const rect = container.getBoundingClientRect()
      const mouseX = e.clientX - rect.left - rect.width / 2
      const mouseY = e.clientY - rect.top - rect.height / 2
      const ratio = newScale / userScale.value
      pan.value.x = mouseX - (mouseX - pan.value.x) * ratio
      pan.value.y = mouseY - (mouseY - pan.value.y) * ratio
    }
    userScale.value = newScale
  }

  // 拖拽平移（仅在放大时启用；在文字上按下则保留原生框选）
  const onViewportMouseDown = (e: MouseEvent) => {
    if (!pdfDoc || userScale.value <= 1 || e.button !== 0) return
    if (isOnTextSpan(e)) return
    isDragging.value = true
    dragStart.value = { x: e.clientX - pan.value.x, y: e.clientY - pan.value.y }
    if (pageBoxRef.value) pageBoxRef.value.style.cursor = 'grabbing'
    document.addEventListener('mousemove', onViewportMouseMove)
    document.addEventListener('mouseup', onViewportMouseUp)
    document.addEventListener('selectstart', preventSelect)
  }

  const onViewportMouseMove = (e: MouseEvent) => {
    if (!isDragging.value) return
    pan.value.x = e.clientX - dragStart.value.x
    pan.value.y = e.clientY - dragStart.value.y
    clampPan()
    applyTransform()
  }

  const onViewportMouseUp = () => {
    isDragging.value = false
    if (pageBoxRef.value) pageBoxRef.value.style.cursor = userScale.value > 1 ? 'grab' : 'default'
    document.removeEventListener('mousemove', onViewportMouseMove)
    document.removeEventListener('mouseup', onViewportMouseUp)
    document.removeEventListener('selectstart', preventSelect)
  }

  const preventSelect = (e: Event) => e.preventDefault()

  // 双击复位到铺满状态（双击文字时保留选词，不复位）
  const resetFit = () => {
    userScale.value = 1
    pan.value = { x: 0, y: 0 }
  }

  const onViewportDblClick = (e: MouseEvent) => {
    if (isOnTextSpan(e)) return
    resetFit()
  }

  // 按钮缩放（1.25 倍步进，与 Ctrl +/- 快捷键一致）
  const zoomBy = (dir: number) => {
    const factor = dir > 0 ? 1.25 : 1 / 1.25
    setUserScale(userScale.value * factor)
  }

  // 快捷键：Ctrl +/- 缩放、Ctrl+0 / ESC 复位、方向键 / PageUp / PageDown 翻页
  const handleKeyDown = (e: KeyboardEvent) => {
    // 输入框 / 富文本中不拦截方向键（避免影响编辑光标）
    const t = e.target as HTMLElement | null
    const tag = t?.tagName || ''
    const isEditing = tag === 'INPUT' || tag === 'TEXTAREA' || !!t?.isContentEditable
    if (e.ctrlKey) {
      if (e.key === '+' || e.key === '=') { e.preventDefault(); setUserScale(userScale.value * 1.25) }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); setUserScale(userScale.value / 1.25) }
      else if (e.key === '0') { e.preventDefault(); resetFit() }
      return
    }
    if (e.key === 'Escape') {
      resetFit()
      return
    }
    if (isEditing || !pdfDoc || pageCount.value === 0) return
    // 上下左右方向键 / PageUp / PageDown 翻页
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') {
      e.preventDefault()
      nextPage()
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
      e.preventDefault()
      prevPage()
    }
  }

  // === 连续滚动模式（多页顺序向下阅读） ===
  // 连续模式下的缩放：按容器宽度铺满（两侧不留空白），再乘用户缩放倍率
  const computeScrollScale = () => {
    const container = scrollRef.value
    if (!container || !scrollBaseWidth) return 1
    const w = Math.max(1, container.clientWidth)
    return Math.max(0.05, (w / scrollBaseWidth) * userScale.value)
  }

  // 断开观察器 / 清空连续模式运行态（保留 pageRawSizes，同一文档内可复用）
  const resetScrollMode = () => {
    if (pageObserver) { pageObserver.disconnect(); pageObserver = null }
    if (scrollRelayoutTimer) { clearTimeout(scrollRelayoutTimer); scrollRelayoutTimer = null }
    if (suppressTimer) { clearTimeout(suppressTimer); suppressTimer = null }
    suppressScrollSync = false
    renderScaleOf.clear()
    pageEls.value = []
    scrollReady.value = false
    scrollBaseWidth = 0
  }

  // 记录每页 DOM（并交给 IntersectionObserver 懒渲染）
  const setPageEl = (p: number, el: any) => {
    const node = (el || null) as HTMLElement | null
    pageEls.value[p - 1] = node
    if (node && pageObserver) pageObserver.observe(node)
  }

  // 预计算每页原始尺寸（scale=1）：只需算一次，之后缩放全靠 CSS calc，不再循环重算
  const preparePageRawSizes = async () => {
    if (!pdfDoc) return
    const sizes: { w: number; h: number }[] = []
    for (let p = 1; p <= pdfDoc.numPages; p++) {
      try {
        const page = await pdfDoc.getPage(p)
        const vp = page.getViewport({ scale: 1 })
        sizes.push({ w: vp.width, h: vp.height })
      } catch {
        sizes.push({ w: 0, h: 0 })
      }
    }
    pageRawSizes.value = sizes
  }

  // 渲染单页（懒渲染；已按当前缩放渲染过则跳过）
  const renderScrollPage = async (p: number) => {
    if (!pdfDoc) return
    const scale = computeScrollScale()
    if (renderScaleOf.get(p) === scale) return
    const el = pageEls.value[p - 1]
    if (!el) return
    const canvas = el.querySelector('canvas') as HTMLCanvasElement | null
    if (!canvas) return
    renderScaleOf.set(p, scale)
    try {
      const page = await pdfDoc.getPage(p)
      const viewport = page.getViewport({ scale })
      const dpr = window.devicePixelRatio || 1
      canvas.width = viewport.width * dpr
      canvas.height = viewport.height * dpr
      const ctx = canvas.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, viewport.width, viewport.height)
      // 文本层已生成则无需重建：span 的位置/字号全部基于 --scale-factor 计算，随缩放自动跟随
      const tlEl = el.querySelector('.pdf-text-layer') as HTMLElement | null
      const needTextLayer = !!tlEl && tlEl.childElementCount === 0
      await Promise.all([
        page.render({ canvasContext: ctx, viewport }).promise,
        needTextLayer ? renderScrollTextLayer(page, viewport, el) : Promise.resolve(),
      ])
    } catch (err) {
      renderScaleOf.delete(p)
      console.error('[PdfViewer] 连续模式渲染第', p, '页失败:', err)
    }
  }

  // 缩放只改 CSS 变量（O(1)，实测 ~2ms/次）：页盒尺寸由 calc(var(--pdf-scroll-scale)) 自动跟随，
  // 旧画布由 CSS 拉伸立即给出反馈；文本层 span 的重排（实测 ~30ms/次）放到手势结束后的 settle，
  // 避免每帧都做昂贵布局。手势停止后再重渲染可见页恢复清晰度。
  const applyScrollZoom = () => {
    const container = scrollRef.value
    if (!container || !scrollBaseWidth) return
    // 记录当前页相对视口的位置，缩放后恢复，避免阅读位置漂移
    const anchorEl = pageEls.value[currentPage.value - 1] || null
    const delta = anchorEl ? anchorEl.offsetTop - container.scrollTop : null
    const scale = computeScrollScale()
    container.style.setProperty('--pdf-scroll-scale', String(scale))
    if (anchorEl && delta !== null) container.scrollTop = anchorEl.offsetTop - delta
    if (scrollRelayoutTimer) clearTimeout(scrollRelayoutTimer)
    scrollRelayoutTimer = setTimeout(() => {
      if (!isScrollMode.value || !pageObserver) return
      // 手势结束后：同步文本层比例（此时文字与页盒重新对齐），并让可见页按新缩放重渲染
      container.style.setProperty('--scale-factor', String(computeScrollScale()))
      // 重新 observe 会触发一次当前交叉状态的回调 → 可见页按新缩放重渲染
      pageObserver.disconnect()
      pageEls.value.forEach((el) => { if (el && pageObserver) pageObserver.observe(el) })
    }, 140)
  }

  // 重建连续模式排版（保持当前阅读页不变）
  const layoutScrollMode = async () => {
    if (!pdfDoc || !isScrollMode.value) return
    const anchor = currentPage.value
    scrollReady.value = false
    if (pageObserver) { pageObserver.disconnect(); pageObserver = null }
    renderScaleOf.clear()
    pageEls.value = []
    await nextTick()
    const container = scrollRef.value
    if (!container) return
    if (pageRawSizes.value.length !== pdfDoc.numPages) await preparePageRawSizes()
    scrollBaseWidth = pageRawSizes.value[0]?.w || 0
    const scale = computeScrollScale()
    container.style.setProperty('--pdf-scroll-scale', String(scale))
    container.style.setProperty('--scale-factor', String(scale))
    scrollReady.value = true
    await nextTick()
    pageObserver = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue
        const p = Number((en.target as HTMLElement).dataset.page || 0)
        if (p > 0) renderScrollPage(p)
      }
    }, { root: container, rootMargin: '600px 0px' })
    pageEls.value.forEach((el) => { if (el && pageObserver) pageObserver.observe(el) })
    renderScrollPage(anchor)
    scrollToPageEl(anchor, false)
  }

  // 连续模式：滚动到指定页
  const scrollToPageEl = (p: number, smooth = true) => {
    const el = pageEls.value[p - 1]
    if (!el) return
    el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' })
  }

  // 连续模式：按滚动位置同步当前页（以视口顶部为基准，与 scrollIntoView(block:'start') 对齐）
  const syncPageFromScroll = () => {
    const container = scrollRef.value
    if (!container || pageEls.value.length === 0 || suppressScrollSync) return
    let cur = 1
    const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 4
    if (atBottom) {
      cur = pageEls.value.length
    } else {
      const probe = container.scrollTop + 2
      for (let i = 0; i < pageEls.value.length; i++) {
        const el = pageEls.value[i]
        if (!el) continue
        if (el.offsetTop <= probe) cur = i + 1
        else break
      }
    }
    if (cur !== currentPage.value) currentPage.value = cur
    else syncActiveToc()
  }

  const onScrollModeScroll = () => syncPageFromScroll()

  // 连续阅读模式：普通滚轮 = 原生向下滚动；Ctrl + 滚轮 = 缩放（下限 1，不会缩到两侧留白）
  // 缩放量为 O(1) 的 CSS 变量更新（见 applyScrollZoom），因此可以逐事件响应，手感平滑
  const onScrollWheel = (e: WheelEvent) => {
    if (!pdfDoc || !e.ctrlKey) return
    e.preventDefault()
    e.stopPropagation()
    // 按 delta 比例计算（触控板小步、鼠标滚轮大步都跟手），并限制单次幅度
    const factor = Math.min(1.25, Math.max(0.8, Math.pow(1.002, -e.deltaY)))
    setUserScale(userScale.value * factor)
  }

  // 统一跳页入口：单页模式切页；连续模式滚动定位（避免平滑滚动过程中页码抖动）
  const gotoPage = (p: number, smooth = true) => {
    if (pageCount.value === 0) return
    const target = Math.max(1, Math.min(pageCount.value, Math.round(p)))
    if (isScrollMode.value) {
      currentPage.value = target
      suppressScrollSync = true
      if (suppressTimer) clearTimeout(suppressTimer)
      suppressTimer = setTimeout(() => {
        suppressScrollSync = false
        syncPageFromScroll()
      }, smooth ? 700 : 60)
      scrollToPageEl(target, smooth)
      syncActiveToc()
      return
    }
    currentPage.value = target
  }

  // 滚轮模式切换（用户偏好记忆）
  const setWheelMode = (mode: 'zoom' | 'scroll') => {
    if (wheelMode.value === mode) return
    wheelMode.value = mode
    try { localStorage.setItem('pdf_wheel_mode', mode) } catch { /* ignore */ }
  }

  watch(wheelMode, async (mode) => {
    if (!pdfDoc) return
    if (mode === 'scroll') {
      // 切换瞬间 userScale 归位会触发缩放缓程，这里先屏蔽避免重复排版
      skipScaleRelayout = true
      userScale.value = 1
      pan.value = { x: 0, y: 0 }
      resetScrollMode()
      await nextTick()
      observeResizeTargets()
      await layoutScrollMode()
      skipScaleRelayout = false
    } else {
      resetScrollMode()
      await nextTick()
      observeResizeTargets()
      renderPage()
    }
  })

  // 连续模式下调整缩放（Ctrl+滚轮 / 按钮 / 快捷键）后走轻量路径：只改 CSS 变量，不再整页重排
  watch(userScale, () => {
    if (!isScrollMode.value || skipScaleRelayout) return
    applyScrollZoom()
  })

  // 尺寸变化的观察目标（单页容器 / 连续容器）
  const observeResizeTargets = () => {
    if (!resizeObserver) return
    if (viewportRef.value) resizeObserver.observe(viewportRef.value)
    if (scrollRef.value) resizeObserver.observe(scrollRef.value)
  }

  // === 右侧面板：转化 / 智能对话 两个独立面板（同一时刻只显示一个） ===
  const smartPanelOpen = ref(false)
  const smartMode = ref<'convert' | 'chat'>('convert') // 当前打开的面板
  const smartPanelWidth = ref(loadDocChatWidth())
  watch(smartPanelWidth, (v) => saveDocChatWidth(v))
  let panelResizeData: { startX: number; startWidth: number } | null = null

  const toggleSmartPanel = (mode: 'convert' | 'chat') => {
    if (smartPanelOpen.value && smartMode.value === mode) {
      smartPanelOpen.value = false
    } else {
      smartMode.value = mode
      smartPanelOpen.value = true
    }
  }
  const closeSmartPanel = () => { smartPanelOpen.value = false }

  // 点击状态栏上的进行中提示时，跳到转化面板对应方式
  const focusConvert = (mode: 'text' | 'ocr') => {
    smartMode.value = 'convert'
    convertMode.value = mode
    smartPanelOpen.value = true
  }

  // 拖动面板左边界调整宽度
  const startPanelResize = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const panel = (e.currentTarget as HTMLElement).closest('.pdf-panel') as HTMLElement
    if (!panel) return
    panelResizeData = { startX: e.clientX, startWidth: smartPanelWidth.value }
    document.body.style.cursor = 'ew-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onPanelResize, true)
    window.addEventListener('mouseup', stopPanelResize, true)
  }
  const onPanelResize = (e: MouseEvent) => {
    if (!panelResizeData) return
    const delta = e.clientX - panelResizeData.startX
    // 面板在右侧：向左拖（delta 为负）→ 宽度增大
    let newWidth = panelResizeData.startWidth - delta
    // 限幅与其它视图一致，但不超过窗口宽度的 60%（窗口很窄时别把正文挤没）
    const maxW = Math.max(DOC_CHAT_MIN_WIDTH, Math.min(DOC_CHAT_MAX_WIDTH, Math.floor(window.innerWidth * 0.6)))
    smartPanelWidth.value = Math.max(DOC_CHAT_MIN_WIDTH, Math.min(maxW, newWidth))
  }
  const stopPanelResize = () => {
    panelResizeData = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    window.removeEventListener('mousemove', onPanelResize, true)
    window.removeEventListener('mouseup', stopPanelResize, true)
  }

  // ---- 转化 tab：文字提取（默认）/ OCR 识别 ----
  const convertMode = ref<'text' | 'ocr'>('text')
  const switchConvertMode = (m: 'text' | 'ocr') => {
    convertMode.value = m
    if (m === 'ocr' && ocrModels.value.length === 0) fetchOcrModels()
  }

  // 文字提取（pdfjs 直接读内嵌文本，无需 OCR）
  const textExtractRunning = ref(false)
  const textExtractCancelled = ref(false)
  const textExtractProgress = ref('')
  const textExtractResult = ref('')

  const startTextExtract = async () => {
    if (!pdfDoc || textExtractRunning.value) return
    textExtractRunning.value = true
    textExtractCancelled.value = false
    textExtractResult.value = ''
    textExtractProgress.value = ''
    const total = pdfDoc.numPages
    const parts: string[] = []
    for (let p = 1; p <= total; p++) {
      if (textExtractCancelled.value) break
      textExtractProgress.value = store.locales === 'zh'
        ? `正在提取第 ${p}/${total} 页…`
        : `Extracting page ${p}/${total}…`
      try {
        const page = await pdfDoc.getPage(p)
        const content = await page.getTextContent()
        const strings = (content.items as any[]).map((it: any) => it.str)
        parts.push(strings.join(' '))
      } catch (err: any) {
        console.error('[PdfViewer] 提取第', p, '页失败:', err)
        parts.push('')
      }
      await nextTick()
    }
    const text = parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
    textExtractRunning.value = false
    if (textExtractCancelled.value) {
      textExtractProgress.value = store.locales === 'zh' ? '已取消' : 'Cancelled'
    } else if (!text) {
      textExtractProgress.value = store.locales === 'zh'
        ? '未提取到文字（可能是扫描件），请切换到「OCR 识别」'
        : 'No text found (scanned?), switch to OCR'
    } else {
      pdfFullTextCache = text
      textExtractResult.value = text
      textExtractProgress.value = store.locales === 'zh'
        ? `提取完成，共 ${text.length} 字符`
        : `Extracted ${text.length} chars`
    }
  }
  const cancelTextExtract = () => { textExtractCancelled.value = true }
  const copyTextExtract = () => {
    if (!textExtractResult.value) return
    navigator.clipboard.writeText(textExtractResult.value)
      .then(() => { textExtractProgress.value = store.locales === 'zh' ? '已复制' : 'Copied' })
      .catch(() => {})
  }
  const clearTextExtract = () => {
    textExtractResult.value = ''
    textExtractProgress.value = ''
  }

  // 文字提取结果保存为同名 .md（工作区根目录）
  const saveTextExtract = async () => {
    if (!textExtractResult.value || !store.root) return
    const base = (props.path || 'document').split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || 'document'
    const sep = store.root.includes('\\') ? '\\' : '/'
    const dir = store.root.replace(/[\\/]$/, '')
    const filePath = `${dir}${sep}${base}.md`
    try {
      const ok = await window.ipcRenderer.invoke('saveFile', filePath, textExtractResult.value)
      textExtractProgress.value = ok
        ? (store.locales === 'zh' ? '已保存：' + filePath : 'Saved: ' + filePath)
        : (store.locales === 'zh' ? '保存失败' : 'Save failed')
    } catch (err) {
      console.error('[PdfViewer] 保存文字提取结果失败:', err)
      textExtractProgress.value = store.locales === 'zh' ? '保存失败' : 'Save failed'
    }
  }

  // ---- 智能对话（复用共享组件 DocChatPanel）：可附「全文 / 当前页文字 / 当前页截图」 ----
  // 注：按钮顺序 = 数组顺序，「全文」固定放最左（与 md/Word 对话面板一致）；默认仍选中当前页文字
  const chatAttachOptions = computed(() => {
    const zh = store.locales === 'zh'
    const page = currentPage.value
    return [
      {
        key: 'fullText',
        label: zh ? '全文' : 'Full',
        icon: 'fa-align-left',
        title: zh ? '附带整份 PDF 文字' : 'Attach full PDF text',
        tag: zh ? 'PDF 全文' : 'Full PDF text',
        // 悬浮时统计字符数（复用 extractAllText 的缓存，首次会做一次全文提取）
        count: async () => (await extractAllText()).length,
      },
      {
        key: 'pageText',
        label: zh ? '当前页文字' : 'Page text',
        icon: 'fa-file-text-o',
        title: zh ? '附带当前页文字' : 'Attach current page text',
        tag: zh ? `当前页文字 · 第 ${page} 页` : `Page ${page} text`,
        default: true,
        count: async () => (await extractPageText(page)).length,
      },
      {
        key: 'selection',
        label: zh ? '选中文字' : 'Selection',
        icon: 'fa-i-cursor',
        title: zh ? '附带在 PDF 中框选的文字' : 'Attach the text you selected in the PDF',
        tag: zh ? '选中文字' : 'Selection',
        usesSelection: true,
        // 没有选区时返回 NaN（面板会忽略，不显示「0 字符」）
        count: () => { const t = pdfSelectionText(); return t ? t.length : NaN },
      },
      {
        key: 'pageImg',
        label: zh ? '截图' : 'Shot',
        icon: 'fa-picture-o',
        kind: 'image' as const,
        title: zh ? '附带当前页截图（需多模态模型）' : 'Attach current page screenshot',
        tag: zh ? `当前页截图 · 第 ${page} 页` : `Page ${page} screenshot`,
      },
    ]
  })

  // === 选中文字（文本层框选）跟踪 ===
  // 点右侧对话面板输入框会让 PDF 失焦、浏览器把选区高亮抹掉，导致看起来「选中丢了」。
  // 这里持续记录选区，并在焦点被面板抢走后把高亮重新应用（仅视觉，不影响输入框输入）。
  const isInsidePdfText = (node: Node | null | undefined): boolean => {
    if (!node) return false
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement
    return !!el?.closest('.pdf-text-layer')
  }

  const pdfSelectionText = (): string => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return ''
    if (!isInsidePdfText(sel.getRangeAt(0).commonAncestorContainer)) return ''
    return sel.toString().trim()
  }

  let savedSelectionRanges: Range[] = []
  let restoringSelection = false

  // 记录当前选区（仅在选区落在 PDF 文本层内时）
  const capturePdfSelection = () => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return
    if (!isInsidePdfText(sel.getRangeAt(0).commonAncestorContainer)) return
    savedSelectionRanges = []
    for (let i = 0; i < sel.rangeCount; i++) savedSelectionRanges.push(sel.getRangeAt(i).cloneRange())
    clearSelectionMarks()
  }

  const onDocSelectionChange = () => { if (!restoringSelection) capturePdfSelection() }

  // 选中高亮标记：焦点转到右侧面板后，浏览器不再绘制文档选区高亮，
  // 这里给命中的文本层 span 打上标记类，保持「选中状态」可见。
  const clearSelectionMarks = () => {
    document.querySelectorAll('.pdf-text-layer span.pdf-sel-hit').forEach((el) => el.classList.remove('pdf-sel-hit'))
  }

  const markSelectionSpans = () => {
    clearSelectionMarks()
    if (savedSelectionRanges.length === 0) return
    document.querySelectorAll<HTMLElement>('.pdf-text-layer span').forEach((span) => {
      for (const r of savedSelectionRanges) {
        if (r.intersectsNode(span)) { span.classList.add('pdf-sel-hit'); return }
      }
    })
  }

  // 焦点被右侧对话面板抢走（浏览器会清空选区并停止绘制高亮）→ 恢复选区 + 重新标记高亮
  const restorePdfSelection = () => {
    if (savedSelectionRanges.length === 0) return
    const sel = window.getSelection()
    if (!sel) return
    if (!(sel.rangeCount > 0 && !sel.isCollapsed)) {
      restoringSelection = true
      sel.removeAllRanges()
      for (const r of savedSelectionRanges) sel.addRange(r)
      restoringSelection = false
    }
    markSelectionSpans()
  }

  const onDocFocusIn = (e: FocusEvent) => {
    const t = e.target as HTMLElement | null
    if (t && t.closest('.pdf-panel-chat')) setTimeout(restorePdfSelection, 0)
  }

  // 点在其他地方（既不在文本层、也不在对话面板）→ 用户主动取消选择
  const onDocMouseDownClearSelection = (e: MouseEvent) => {
    const t = e.target as HTMLElement | null
    if (!t) return
    if (t.closest('.pdf-text-layer') || t.closest('.pdf-panel-chat')) return
    savedSelectionRanges = []
    clearSelectionMarks()
  }

  // 供 DocChatPanel 取上下文（异步：pdfjs 按需提取文字 / 渲染截图）
  const getChatContext = async (key: string, snapshot?: string): Promise<string> => {
    if (!pdfDoc) return ''
    if (key === 'selection') {
      // 优先取实时选区；点输入框后选区已消失 → 用面板固定下来的快照兜底
      return pdfSelectionText() || (snapshot || '').trim()
    }
    if (key === 'pageText') return await extractPageText(currentPage.value)
    if (key === 'fullText') return await extractAllText()
    if (key === 'pageImg') {
      try {
        return await renderPageToImage(currentPage.value)
      } catch (err) {
        console.error('[PdfViewer] 截取当前页失败:', err)
        return ''
      }
    }
    return ''
  }
  // PDF 全文缓存（整份提取一次后复用；加载新文件时在 cleanup 中清空）
  let pdfFullTextCache = ''

  // 提取当前页文字（作为对话上下文）
  const extractPageText = async (pageNum: number): Promise<string> => {
    if (!pdfDoc) return ''
    try {
      const page = await pdfDoc.getPage(pageNum)
      const content = await page.getTextContent()
      return (content.items as any[]).map((it: any) => it.str).join(' ').trim()
    } catch (err) {
      console.error('[PdfViewer] 读取第', pageNum, '页文字失败:', err)
      return ''
    }
  }
  // 提取整份 PDF 文字（带缓存）
  const extractAllText = async (): Promise<string> => {
    if (pdfFullTextCache) return pdfFullTextCache
    if (!pdfDoc) return ''
    const total = pdfDoc.numPages
    const parts: string[] = []
    for (let p = 1; p <= total; p++) {
      try {
        const page = await pdfDoc.getPage(p)
        const content = await page.getTextContent()
        parts.push((content.items as any[]).map((it: any) => it.str).join(' '))
      } catch (err) {
        console.error('[PdfViewer] 提取第', p, '页失败:', err)
      }
      await nextTick()
    }
    pdfFullTextCache = parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
    return pdfFullTextCache
  }

  // 智能对话的状态、流式/看门狗/IME 处理已全部收敛到共享组件 DocChatPanel.vue
  // （PDF 只需提供上方 chatAttachOptions + getChatContext）

  // === OCR ===
  // 来源可在面板里显式选择（记住到 localStorage，不动主来源设置）：
  // Ollama / LM Studio / DeepSeek / GPUStack / 自定义 / OpenAI … 选到视觉模型即可识别；
  // DeepSeek 的 deepseek-flash 支持图像理解（deepseek-v4-pro 不支持）
  const ocrProvider = ref(String(loadOcrSourcePref() || store.AIconfig?.llm?.type || 'ollama'))
  const ocrSourceLabel = computed(() => ocrProviderLabel(ocrProvider.value))
  const ocrSourceSelectTitle = computed(() => store.locales === 'zh' ? '选择 OCR 来源' : 'OCR source')
  const ocrSelectTitle = computed(() => store.locales === 'zh'
    ? `选择/输入 OCR 模型（来源：${ocrSourceLabel.value}）`
    : `OCR model (source: ${ocrSourceLabel.value})`
  )
  /** 来源下拉项：设置里已启用的来源 + 当前值（保证当前值一定在列表里） */
  const ocrSourceOptions = computed(() => {
    const enabled: string[] = (store.enabledLlmTypes as string[]) || []
    const keys = OCR_SELECTABLE_SOURCES.filter(k => enabled.includes(k))
    if (!keys.includes(ocrProvider.value)) keys.unshift(ocrProvider.value)
    return keys.map(k => ({ key: k, label: ocrProviderLabel(k) }))
  })

  /** 拉取某个来源的模型列表（默认当前来源）；能看出是视觉模型就自动选中它 */
  const fetchOcrModels = async (key: string = ocrProvider.value) => {
    ocrModels.value = []
    try {
      const r: any = await store.testLlmSource(key, false)
      const all: string[] = Array.isArray(r?.models) ? r.models : []
      ocrModels.value = rankOcrModels(all, key)
      const saved = loadOcrModelPref(key)
      if (saved && ocrModels.value.includes(saved)) {
        ocrSelectedModel.value = saved
      } else if (hasVisionLikeModel(all, key)) {
        ocrSelectedModel.value = ocrModels.value[0]
      } else {
        // 名字里看不出视觉能力（自命名模型 / 部分来源不提供列表）→ 不自动选，允许手输
        ocrSelectedModel.value = ''
      }
    } catch (err) {
      console.error('[OCR] 获取模型列表失败:', key, err)
    }
  }

  /** 切换来源：记住选择 + 重新拉模型 */
  const onOcrSourceChange = () => {
    saveOcrSourcePref(ocrProvider.value)
    ocrSelectedModel.value = ''
    fetchOcrModels(ocrProvider.value)
  }

  // 记住每个来源上次选中的模型
  watch(ocrSelectedModel, (v) => {
    if (v && ocrProvider.value) saveOcrModelPref(ocrProvider.value, v)
  })

  // 渲染页面到 canvas 并转为 base64 图片
  // maxSide > 0：按最长边等比限制尺寸（OCR 用；过大的图会让视觉模型更容易陷入复读，传输也慢）
  const renderPageToImage = async (pageNum: number, maxSide = 0): Promise<string> => {
    if (!pdfDoc) throw new Error('PDF 未加载')
    const page = await pdfDoc.getPage(pageNum)
    const base = page.getViewport({ scale: 1 })
    let scale = 2 // 2x 保证清晰度
    if (maxSide > 0) {
      const longSide = Math.max(base.width, base.height)
      if (longSide > 0) scale = Math.min(scale, maxSide / longSide)
    }
    const vp = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(vp.width))
    canvas.height = Math.max(1, Math.round(vp.height))
    const ctx = canvas.getContext('2d')!
    await page.render({ canvasContext: ctx, viewport: vp }).promise
    return canvas.toDataURL('image/jpeg', 0.85)
  }

  // 单页 OCR 识别（非流式请求，避免长连接被切断）
  // 重复抑制参数、逐级加强重试与失败文案统一收敛到 @/lib/knowFile/ocr
  const ocrSinglePage = async (pageNum: number, prompt: string): Promise<string> => {
    const imageData = await renderPageToImage(pageNum, OCR_MAX_IMAGE_SIDE)
    const base64Data = imageData.split(',')[1]
    const zh = store.locales === 'zh'

    const text = await ocrImage({
      provider: ocrProvider.value,
      config: llmConfigByKey(store.AIconfig?.llm, ocrProvider.value) || {},
      model: ocrSelectedModel.value,
      imageBase64: base64Data,
      prompt,
      zh,
      cancelled: () => ocrCancelled.value,
      onRetry: (attempt, total, reason) => {
        console.warn(`[OCR] 第 ${pageNum} 页识别失败 (尝试 ${attempt - 1}/${total}):`, reason)
        ocrProgress.value = zh
          ? `第 ${pageNum} 页重试 ${attempt - 1}/${total - 1}：${reason}`
          : `Page ${pageNum} retry ${attempt - 1}/${total - 1}: ${reason}`
      },
    })

    // 流式模拟：逐步显示文字，让用户有实时感
    ocrStreamText.value = ''
    for (let i = 0; i < text.length; i += 3) {
      if (ocrCancelled.value) break
      ocrStreamText.value = text.substring(0, Math.min(i + 3, text.length))
      await nextTick()
      await new Promise(r => setTimeout(r, 5))
    }
    if (!ocrCancelled.value) ocrStreamText.value = text

    return text
  }

  const startOcr = async () => {
    if (!pdfDoc || ocrRunning.value || !ocrSelectedModel.value) return

    ocrRunning.value = true
    ocrCancelled.value = false
    ocrResults.value = []
    ocrCurrentPage.value = 0
    ocrStreamText.value = ''
    ocrActiveTab.value = -1 // 默认显示流式页

    const totalPages = pdfDoc.numPages
    const ocrPrompt = store.locales === 'zh'
      ? '请识别这张图片中的所有文字，并整理为 Markdown 格式输出。只返回文字内容，不要添加额外说明。'
      : 'Extract all text from this image and format it as Markdown. Return only the text content without additional remarks.'

    for (let p = 1; p <= totalPages; p++) {
      if (ocrCancelled.value) break
      ocrCurrentPage.value = p
      ocrProgress.value = `${store.locales === 'zh' ? '正在识别第' : 'Processing page'} ${p}/${totalPages}`
      ocrStreamText.value = ''
      ocrActiveTab.value = -1 // 识别时立即切到正在识别的这一页（显示流式内容），而不是完成后才切换

      try {
        const pageText = await ocrSinglePage(p, ocrPrompt)
        if (ocrCancelled.value) break
        ocrResults.value.push({ page: p, text: pageText })
        ocrActiveTab.value = ocrResults.value.length - 1 // 自动切换到新完成的 tab
        ocrStreamText.value = ''
      } catch (err: any) {
        console.error(`[OCR] 第 ${p} 页识别最终失败:`, err.message || err)
        ocrResults.value.push({ page: p, text: `[OCR 失败: ${err.message || '未知错误'}]` })
      }
    }

    ocrRunning.value = false
    if (ocrCancelled.value) {
      ocrProgress.value = store.locales === 'zh' ? 'OCR 已取消' : 'OCR cancelled'
    } else {
      ocrProgress.value = store.locales === 'zh'
        ? `OCR 完成，共识别 ${ocrResults.value.length} 页`
        : `OCR complete, ${ocrResults.value.length} pages processed`
    }
  }

  const cancelOcr = () => {
    ocrCancelled.value = true
  }


  const clearOcrResults = () => {
    ocrResults.value = []
    ocrStreamText.value = ''
    ocrProgress.value = ''
    ocrActiveTab.value = 0
  }

  // 保存单页 OCR 结果
  const saveOcrPage = async (index: number) => {
    const result = ocrResults.value[index]
    if (!result) return
    const fileName = `${(props.path || 'pdf').split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || 'document'}_page${result.page}.md`
    const savePath = `${store.root}/${fileName}`
    try {
      await window.ipcRenderer.invoke('saveFile', savePath, result.text)
      ocrProgress.value = store.locales === 'zh'
        ? `第 ${result.page} 页已保存`
        : `Page ${result.page} saved`
    } catch (err) {
      console.error('[OCR] 保存失败:', err)
    }
  }

  // 当前激活页是否有可复制/保存的内容
  const ocrHasActiveText = computed(() => {
    const idx = ocrActiveTab.value
    if (idx === -1) return !!ocrStreamText.value
    const r = ocrResults.value[idx]
    return !!(r && r.text)
  })

  // 保存当前激活页
  const saveOcrActive = () => {
    const idx = ocrActiveTab.value
    if (idx >= 0 && ocrResults.value[idx]) saveOcrPage(idx)
  }

  // 复制当前激活页内容（含识别中的流式文本）
  const copyOcrActive = () => {
    const idx = ocrActiveTab.value
    const text = idx === -1 ? ocrStreamText.value : (ocrResults.value[idx]?.text || '')
    if (!text) return
    navigator.clipboard.writeText(text)
      .then(() => { ocrProgress.value = store.locales === 'zh' ? '已复制' : 'Copied' })
      .catch(() => {})
  }

  // 保存全部 OCR 结果
  const saveOcrAll = async () => {
    if (ocrResults.value.length === 0) return
    const fullText = ocrResults.value
      .map(r => `${r.text}`)
      .join('\n\n')
    const fileName = `${(props.path || 'pdf').split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || 'document'}.md`
    const savePath = `${store.root}/${fileName}`
    try {
      await window.ipcRenderer.invoke('saveFile', savePath, fullText)
      ocrProgress.value = store.locales === 'zh'
        ? `全部 ${ocrResults.value.length} 页已保存到 ${fileName}`
        : `All ${ocrResults.value.length} pages saved to ${fileName}`
    } catch (err) {
      console.error('[OCR] 保存失败:', err)
    }
  }

  // === 监听 ===
  watch([currentPage, userScale], () => { nextTick(() => renderPage()) })
  watch(currentPage, () => { pan.value = { x: 0, y: 0 }; syncActiveToc() })
  watch(() => props.path, () => { load() })
  // 远程 PDF：base64 变化时同样重载
  watch(() => props.base64, () => { if (props.base64) load() })

  onMounted(() => {
    load()
    // 监听容器尺寸变化：单页模式重新铺满，连续模式重新排版
    resizeObserver = new ResizeObserver(() => {
      if (!pdfDoc) return
      if (isScrollMode.value) {
        // 容器宽度变化 → 缩放基准变化：同样是廉价的 CSS 变量更新（内部会自行 settle）
        applyScrollZoom()
      } else {
        renderPage()
      }
    })
    observeResizeTargets()
    window.addEventListener('keydown', handleKeyDown)
    // 选区跟踪：及时记下 PDF 里框选的文字，避免点对话输入框后丢失
    document.addEventListener('selectionchange', onDocSelectionChange)
    document.addEventListener('focusin', onDocFocusIn)
    document.addEventListener('mousedown', onDocMouseDownClearSelection, true)
  })
  onBeforeUnmount(() => {
    cleanup()
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null }
    window.removeEventListener('keydown', handleKeyDown)
    document.removeEventListener('selectionchange', onDocSelectionChange)
    document.removeEventListener('focusin', onDocFocusIn)
    document.removeEventListener('mousedown', onDocMouseDownClearSelection, true)
    document.removeEventListener('mousemove', onViewportMouseMove)
    document.removeEventListener('mouseup', onViewportMouseUp)
    document.removeEventListener('selectstart', preventSelect)
    window.removeEventListener('mousemove', onPanelResize, true)
    window.removeEventListener('mouseup', stopPanelResize, true)
  })
</script>

<template>
  <div class="pdf-container" :class="darkClass">
    <!-- 顶部：PDF 阅读主区 + 右侧智能操作面板 -->
    <div class="pdf-body">
    <!-- 左侧目录（PDF 书签）：共用 DocTocPanel，结构与样式与其他视图完全一致 -->
    <DocTocPanel
      :open="tocVisible"
      @update:open="setTocOpen"
      v-model:width="tocNavWidth"
      :items="tocItems"
      :active-id="activeTocId > 0 ? activeTocId : null"
      :usable="hasToc"
      :min-width="DOC_TOC_MIN_WIDTH"
      :max-width="DOC_TOC_MAX_WIDTH"
      :item-title="pdfTocItemTitle"
      :item-disabled="pdfTocItemDisabled"
      @select="onSelectTocItem"
    />

    <div class="pdf-main">
    <!-- 内容区 A：单页模式（滚轮缩放 / 拖拽平移 / 双击复位） -->
    <div v-if="!isScrollMode" ref="viewportRef" class="pdf-viewport"
      @wheel.prevent.stop="handleWheel"
      @mousedown="onViewportMouseDown"
      @dblclick="onViewportDblClick">
      <div v-if="loading" class="pdf-loading">
        <i class="fa fa-spinner fa-spin"></i>
        <span>{{ store.locales === 'zh' ? '正在加载PDF...' : 'Loading PDF...' }}</span>
      </div>
      <div v-else-if="errorMsg" class="pdf-error">
        <i class="fa fa-exclamation-triangle"></i>
        <span>{{ errorMsg }}</span>
        <button class="pdf-retry-btn" @click="load">
          <i class="fa fa-refresh"></i> {{ store.locales === 'zh' ? '重试' : 'Retry' }}
        </button>
      </div>
      <div v-else class="pdf-pages">
        <!-- 页面盒：画布 + 可框选复制的文本层，统一缩放 / 平移 -->
        <div ref="pageBoxRef" class="pdf-page-box">
          <canvas ref="canvasRef" class="pdf-canvas"></canvas>
          <div ref="textLayerRef" class="textLayer pdf-text-layer"></div>
        </div>
      </div>
    </div>

    <!-- 内容区 B：连续阅读模式（滚轮向下顺序阅读多页，页面懒渲染） -->
    <div v-else ref="scrollRef" class="pdf-scroll scoll" @scroll.passive="onScrollModeScroll" @wheel="onScrollWheel">
      <div v-if="loading" class="pdf-loading">
        <i class="fa fa-spinner fa-spin"></i>
        <span>{{ store.locales === 'zh' ? '正在加载PDF...' : 'Loading PDF...' }}</span>
      </div>
      <div v-else-if="errorMsg" class="pdf-error">
        <i class="fa fa-exclamation-triangle"></i>
        <span>{{ errorMsg }}</span>
        <button class="pdf-retry-btn" @click="load">
          <i class="fa fa-refresh"></i> {{ store.locales === 'zh' ? '重试' : 'Retry' }}
        </button>
      </div>
      <div v-else-if="!scrollReady" class="pdf-loading">
        <i class="fa fa-spinner fa-spin"></i>
        <span>{{ store.locales === 'zh' ? '正在排版页面…' : 'Laying out pages…' }}</span>
      </div>
      <template v-else>
        <div
          v-for="(size, idx) in pageRawSizes"
          :key="idx"
          class="pdf-scroll-page"
          :ref="(el) => setPageEl(idx + 1, el)"
          :data-page="idx + 1"
          :style="{ '--pdf-page-w': size.w + 'px', '--pdf-page-h': size.h + 'px' }"
        >
          <canvas class="pdf-scroll-canvas"></canvas>
          <div class="textLayer pdf-text-layer"></div>
          <span class="pdf-scroll-num">{{ idx + 1 }}</span>
        </div>
      </template>
    </div>

    </div>
    <!-- /.pdf-main -->

    <!-- 右侧面板 A：转化（PDF → Markdown，无标题栏；经底部「转化」按钮开关） -->
    <aside v-if="smartPanelOpen && smartMode === 'convert'" class="pdf-panel pdf-panel-convert" :style="{ width: smartPanelWidth + 'px' }">
      <!-- 拖左边界调整宽度 -->
      <div class="pdf-panel-resizer" @mousedown.prevent="startPanelResize" :title="store.locales==='zh' ? '拖动调整宽度' : 'Drag to resize'"></div>
      <div class="pdf-panel-body">
        <div class="pdf-convert">
          <!-- 方式一：文字提取（快速读取内嵌文本） -->
          <div v-if="convertMode === 'text'" class="pdf-convert-pane">
            <div class="pdf-convert-result">
              <div v-if="textExtractResult" class="pdf-convert-result-toolbar">
                <button @click="saveTextExtract"><i class="fa fa-save"></i> {{ store.locales==='zh' ? '保存为 .md' : 'Save .md' }}</button>
                <button @click="copyTextExtract"><i class="fa fa-copy"></i> {{ store.locales==='zh' ? '复制' : 'Copy' }}</button>
                <button @click="clearTextExtract"><i class="fa fa-trash-o"></i> {{ store.locales==='zh' ? '清空' : 'Clear' }}</button>
                <span class="pdf-convert-len">{{ textExtractResult.length }} {{ store.locales==='zh' ? '字符' : 'chars' }}</span>
              </div>
              <pre v-if="textExtractResult" class="pdf-convert-pre scoll">{{ textExtractResult }}</pre>
              <div v-else-if="!textExtractRunning" class="pdf-convert-empty">
                <i class="fa fa-file-text-o"></i>
                <span>{{ store.locales==='zh' ? '点击「提取全部文本」开始转换' : 'Click "Extract text" to start' }}</span>
              </div>
            </div>
          </div>

          <!-- 方式二：OCR 识别（扫描件 / 图片型 PDF） -->
          <div v-else class="pdf-convert-pane pdf-ocr-pane">
            <!-- 识别结果：左侧识别内容（保存/复制） + 右侧页码导航 -->
            <div v-if="ocrResults.length > 0 || ocrRunning" class="pdf-ocr-main">
              <!-- 识别内容 -->
              <div class="pdf-ocr-content">
                <div class="pdf-ocr-content-bar">
                  <span class="pdf-ocr-content-page">
                    {{ ocrActiveTab === -1
                      ? (store.locales==='zh' ? '第 ' + ocrCurrentPage + ' 页（识别中）' : 'Page ' + ocrCurrentPage + ' (OCR…)')
                      : (ocrActiveTab < ocrResults.length
                        ? (store.locales==='zh' ? '第 ' + ocrResults[ocrActiveTab].page + ' 页' : 'Page ' + ocrResults[ocrActiveTab].page)
                        : '') }}
                  </span>
                  <span class="pdf-ocr-content-actions">
                    <button class="pdf-ocr-content-btn" :disabled="ocrActiveTab < 0 || !ocrHasActiveText" @click="saveOcrActive" :title="store.locales==='zh' ? '保存此页为 .md' : 'Save this page as .md'">
                      <i class="fa fa-save"></i> {{ store.locales==='zh' ? '保存' : 'Save' }}
                    </button>
                    <button class="pdf-ocr-content-btn" :disabled="!ocrHasActiveText" @click="copyOcrActive" :title="store.locales==='zh' ? '复制此页内容' : 'Copy this page'">
                      <i class="fa fa-copy"></i> {{ store.locales==='zh' ? '复制' : 'Copy' }}
                    </button>
                  </span>
                </div>
                <div class="pdf-ocr-content-body scoll">
                  <pre v-if="ocrActiveTab === -1 && ocrRunning" class="pdf-ocr-content-pre">{{ ocrStreamText || (store.locales==='zh' ? '正在识别第 ' + ocrCurrentPage + ' 页…' : 'Recognizing page ' + ocrCurrentPage + '…') }}<span v-if="ocrStreamText" class="ocr-cursor">|</span></pre>
                  <pre v-for="(r, idx) in ocrResults" :key="r.page" v-show="ocrActiveTab === idx" class="pdf-ocr-content-pre scoll">{{ r.text || (store.locales==='zh' ? '(无内容)' : '(empty)') }}</pre>
                </div>
              </div>
              <!-- 页码导航（按页序排列；“正在识别”页紧跟其后） -->
              <div class="pdf-ocr-nav scoll">
                <div v-for="(r, idx) in ocrResults" :key="r.page"
                  class="pdf-ocr-nav-item"
                  :class="{ active: ocrActiveTab === idx }"
                  :title="r.text ? '' : (store.locales==='zh' ? '无识别内容' : 'No content')"
                  @click="ocrActiveTab = idx">
                  <i class="fa" :class="r.text ? 'fa-check-circle' : 'fa-exclamation-circle'" :style="r.text ? 'color:#4CAF50;' : 'color:#F56C6C;'"></i>
                  <span>{{ store.locales==='zh' ? '第' : 'Pg' }}{{ r.page }}</span>
                </div>
                <div v-if="ocrRunning"
                  class="pdf-ocr-nav-item"
                  :class="{ active: ocrActiveTab === -1 }"
                  :title="store.locales==='zh' ? '正在识别中…' : 'Recognizing…'"
                  @click="ocrActiveTab = -1">
                  <i class="fa fa-spinner fa-spin" style="color:#FF9800;"></i>
                  <span>{{ store.locales==='zh' ? '第' : 'Pg' }}{{ ocrCurrentPage }}</span>
                </div>
              </div>
            </div>
            <!-- 无结果空态 -->
            <div v-if="ocrResults.length === 0 && !ocrRunning" class="pdf-convert-empty">
              <i class="fa fa-font"></i>
              <div>{{ store.locales==='zh' ? '选择 OCR 模型后点击「开始识别」' : 'Select an OCR model and click Start' }}</div>
            </div>
          </div>
          <!-- 底部操作条：模式切换 + 模型/开始（合并为一行，置于最下方） -->
          <div class="pdf-convert-bar">
            <!-- 模式切换 -->
            <span class="pdf-convert-bar-group">
              <button class="pdf-convert-mode-btn" :class="{ active: convertMode === 'text' }" @click="switchConvertMode('text')" :title="store.locales==='zh' ? '文字提取（读取 PDF 内嵌文字）' : 'Text extraction (embedded text)'">
                <i class="fa fa-bolt"></i>
              </button>
              <button class="pdf-convert-mode-btn" :class="{ active: convertMode === 'ocr' }" @click="switchConvertMode('ocr')" :title="store.locales==='zh' ? 'OCR 识别（适合扫描件 / 图片型 PDF）' : 'OCR (scanned pages)'">
                <i class="fa fa-font"></i>
              </button>
            </span>
            <!-- 文字提取操作 -->
            <template v-if="convertMode === 'text'">
              <button class="pdf-convert-run-btn" :disabled="textExtractRunning || !pdfDoc" @click="startTextExtract" :title="store.locales==='zh' ? '提取整份 PDF 的文字并转为 Markdown' : 'Extract all text to Markdown'">
                <i class="fa" :class="textExtractRunning ? 'fa-spinner fa-spin' : 'fa-magic'"></i>
                <span>{{ textExtractRunning ? (store.locales==='zh' ? '提取中' : '…') : (store.locales==='zh' ? '提取' : 'Extract') }}</span>
              </button>
              <button v-if="textExtractRunning" class="pdf-convert-mini-btn" @click="cancelTextExtract" :title="store.locales==='zh' ? '取消提取' : 'Stop extracting'">
                <i class="fa fa-stop"></i>
              </button>
            </template>
            <!-- OCR 识别操作 -->
            <template v-else>
              <!-- 识别来源（可手动切换，默认跟当前模型来源） -->
              <select v-model="ocrProvider" class="pdf-convert-model-select" style="width:104px" :disabled="ocrRunning" :title="ocrSourceSelectTitle" @change="onOcrSourceChange">
                <option v-for="s in ocrSourceOptions" :key="s.key" :value="s.key">{{ s.label }}</option>
              </select>
              <!-- 模型：列表来自该来源，也可直接手输（部分来源不提供模型列表） -->
              <input v-model="ocrSelectedModel" list="pdf-ocr-model-list" class="pdf-convert-model-select" :disabled="ocrRunning" :title="ocrSelectTitle" :placeholder="store.locales==='zh' ? '模型' : 'Model'" />
              <datalist id="pdf-ocr-model-list">
                <option v-for="m in ocrModels" :key="m" :value="m"></option>
              </datalist>
              <button class="pdf-convert-mini-btn" @click="fetchOcrModels()" :disabled="ocrRunning" :title="store.locales==='zh' ? '刷新模型列表' : 'Refresh models'">
                <i class="fa fa-refresh"></i>
              </button>
              <button class="pdf-convert-run-btn" :disabled="!ocrSelectedModel || ocrRunning" @click="startOcr" :title="store.locales==='zh' ? '开始 OCR 识别整份 PDF' : 'Start OCR'">
                <i class="fa fa-play"></i>
              </button>
              <button v-if="ocrRunning" class="pdf-convert-mini-btn" @click="cancelOcr" :title="store.locales==='zh' ? '停止识别' : 'Stop OCR'">
                <i class="fa fa-stop"></i>
              </button>
              <button v-if="!ocrRunning && ocrResults.length > 0" class="pdf-convert-mini-btn" @click="saveOcrAll" :title="store.locales==='zh' ? '全部页保存为同名 .md 文件' : 'Save all pages as .md'">
                <i class="fa fa-save"></i>
              </button>
              <button v-if="!ocrRunning && ocrResults.length > 0" class="pdf-convert-mini-btn" @click="clearOcrResults" :title="store.locales==='zh' ? '清空识别结果' : 'Clear results'">
                <i class="fa fa-trash"></i>
              </button>
            </template>
            <!-- 状态 / 进度：运行与完成提示均已显示在底部状态栏 -->
          </div>
        </div>
      </div>
    </aside>

    <!-- 右侧面板 B：智能对话（复用共享组件 DocChatPanel，与 md/Word 对话面板同款） -->
    <aside v-if="smartPanelOpen && smartMode === 'chat'" class="pdf-panel pdf-panel-chat" :style="{ width: smartPanelWidth + 'px' }">
      <!-- 拖左边界调整宽度 -->
      <div class="pdf-panel-resizer" @mousedown.prevent="startPanelResize" :title="store.locales==='zh' ? '拖动调整宽度' : 'Drag to resize'"></div>
      <div class="pdf-panel-body">
        <DocChatPanel
          :doc-key="props.path || ('remote-' + (props.base64 ? props.base64.length : 0))"
          :attach-options="chatAttachOptions"
          :get-context="getChatContext"
          :hint="store.locales==='zh' ? '对 PDF 提问，可附全文 / 当前页文字 / 选中文字 / 当前页截图' : 'Ask about the PDF (attach full text / page text / selection / screenshot)'"
        />
      </div>
    </aside>
    </div>
    <!-- /.pdf-body -->

    <!-- 底部状态栏（翻页 + 缩放 + 智能操作；样式与 Edit_Code 一致） -->
    <div class="pdf-statusbar" v-if="pageCount > 0 && !loading && !errorMsg">
      <!-- 目录：PDF 书签（仅含书签时显示；最左） -->
      <button v-if="hasToc" class="statusbar-btn" :class="{ active: tocVisible }" @click="toggleToc" :title="store.locales==='zh' ? (tocVisible ? '关闭目录' : '打开目录') : (tocVisible ? 'Close TOC' : 'Open TOC')">
        <i class="fa fa-bars"></i>
      </button>

      <!-- 滚轮模式切换（目录按钮右侧）：单页缩放 / 多页连续阅读 -->
      <span class="pdf-wheel-mode" :title="store.locales==='zh' ? '鼠标滚轮方式' : 'Mouse wheel mode'">
        <button class="statusbar-btn" :class="{ active: wheelMode === 'zoom' }" @click="setWheelMode('zoom')" :title="store.locales==='zh' ? '单页缩放：滚轮缩放当前页（拖拽平移 / 双击复位）' : 'Single page: wheel to zoom current page'">
          <i class="fa fa-search-plus"></i>
        </button>
        <button class="statusbar-btn" :class="{ active: wheelMode === 'scroll' }" @click="setWheelMode('scroll')" :title="store.locales==='zh' ? '连续阅读：滚轮向下顺序阅读多页' : 'Continuous: wheel to scroll through pages'">
          <i class="fa fa-arrows-v"></i>
        </button>
      </span>

      <!-- 深色阅读：原色 / 反色 / 柔和反色（三态循环，偏好记忆） -->
      <button class="statusbar-btn" :class="{ active: darkMode !== 'off' }" @click="cycDarkMode" :title="darkModeTitle">
        <i class="fa" :class="darkModeIcon"></i>
      </button>

      <span class="statusbar-sep"></span>

      <!-- 翻页 -->
      <button class="statusbar-btn" @click="prevPage" :disabled="currentPage <= 1" :title="store.locales==='zh' ? '上一页' : 'Previous'">
        <i class="fa fa-chevron-left"></i>
      </button>
      <span class="statusbar-item pdf-status-page" :title="store.locales==='zh' ? '跳转页码' : 'Jump to page'">
        <input class="pdf-status-input" type="number" :value="currentPage" @change="goToPage" min="1" :max="pageCount" />
        <span class="pdf-status-total">/ {{ pageCount }}</span>
      </span>
      <button class="statusbar-btn" @click="nextPage" :disabled="currentPage >= pageCount" :title="store.locales==='zh' ? '下一页' : 'Next'">
        <i class="fa fa-chevron-right"></i>
      </button>

      <span class="statusbar-sep"></span>

      <!-- 缩放 -->
      <button class="statusbar-btn" @click="zoomBy(-1)" :disabled="userScale <= minUserScale" :title="store.locales==='zh' ? '缩小 (Ctrl+-)' : 'Zoom out (Ctrl+-)'">
        <i class="fa fa-minus"></i>
      </button>
      <span class="statusbar-item pdf-status-zoom" @dblclick="resetFit" :title="store.locales==='zh' ? '当前缩放 · 双击复位' : 'Zoom · dblclick to reset'">{{ Math.round(userScale * 100) }}%</span>
      <button class="statusbar-btn" @click="zoomBy(1)" :title="store.locales==='zh' ? '放大 (Ctrl++)' : 'Zoom in (Ctrl++)'">
        <i class="fa fa-plus"></i>
      </button>
      <button class="statusbar-btn" @click="resetFit" :title="store.locales==='zh' ? '适应窗口 / 复位' : 'Fit / Reset'">
        <i class="fa fa-expand"></i>
      </button>
      <span v-if="userScale !== 1 || isScrollMode" class="pdf-statusbar-hint">{{ isScrollMode ? (store.locales==='zh' ? '滚轮连续阅读 / Ctrl+滚轮缩放' : 'Wheel to scroll / Ctrl+wheel to zoom') : (store.locales==='zh' ? '滚轮缩放 / 拖拽移动 / 双击复位' : 'Wheel / Drag / Dbl-click reset') }}</span>

      <!-- OCR / 文字提取 状态（进行中 / 完成提示；点击跳到转化面板） -->
      <span v-if="ocrRunning" class="statusbar-item pdf-status-progress" @click="focusConvert('ocr')" :title="store.locales==='zh' ? 'OCR 正在识别，点击查看' : 'OCR running, click to view'">
        <i class="fa fa-spinner fa-spin" style="color:#FF9800;"></i>
        <span>{{ store.locales==='zh' ? 'OCR 识别' : 'OCR' }} {{ ocrCurrentPage }}/{{ pageCount }}</span>
      </span>
      <span v-else-if="textExtractRunning" class="statusbar-item pdf-status-progress" @click="focusConvert('text')" :title="store.locales==='zh' ? '文字提取中，点击查看' : 'Extracting text, click to view'">
        <i class="fa fa-spinner fa-spin" style="color:#FF9800;"></i>
        <span>{{ store.locales==='zh' ? '文字提取中…' : 'Extracting…' }}</span>
      </span>
      <!-- 完成 / 结果提示（OCR 或文字提取结束后的信息） -->
      <span v-else-if="convertMode === 'ocr' && ocrProgress" class="statusbar-item pdf-status-progress" @click="focusConvert('ocr')" :title="store.locales==='zh' ? 'OCR 结果，点击查看' : 'OCR result, click to view'">
        <i class="fa fa-check-circle" style="color:#4CAF50;"></i>
        <span>{{ ocrProgress }}</span>
      </span>
      <span v-else-if="convertMode === 'text' && textExtractProgress" class="statusbar-item pdf-status-progress" @click="focusConvert('text')" :title="store.locales==='zh' ? '文字提取结果，点击查看' : 'Text extraction result, click to view'">
        <i class="fa fa-check-circle" style="color:#4CAF50;"></i>
        <span>{{ textExtractProgress }}</span>
      </span>

      <span class="statusbar-spacer"></span>

      <!-- 转化：PDF → Markdown（仅图标） -->
      <button class="statusbar-btn" :class="{ active: smartPanelOpen && smartMode === 'convert' }" @click="toggleSmartPanel('convert')" :title="store.locales==='zh' ? '转化：PDF 转 Markdown' : 'Convert: PDF → Markdown'">
        <i class="fa fa-file-text-o"></i>
      </button>
      <!-- 智能操作：对 PDF 智能对话（仅图标） -->
      <button class="statusbar-btn" :class="{ active: smartPanelOpen && smartMode === 'chat' }" @click="toggleSmartPanel('chat')" :title="store.locales==='zh' ? '智能操作：对 PDF 智能对话' : 'Smart: chat about PDF'">
        <i class="fa fa-magic"></i>
      </button>
    </div>
  </div>
</template>

<style scoped>
.pdf-container {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--backgroundColor);
  overflow: hidden;
}
.pdf-viewport {
  flex: 1;
  position: relative;
  overflow: hidden;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  cursor: default;
}

/* ==================== 连续阅读模式（多页顺序向下滚动） ==================== */
/* 缩放完全由 --pdf-scroll-scale 驱动：改一个变量即可整体缩放，无需 JS 重建 DOM */
.pdf-scroll {
  --pdf-scroll-scale: 1;
  flex: 1;
  min-height: 0;
  position: relative;
  overflow-y: auto;
  overflow-x: auto;
  background: var(--backgroundColor);
  padding: 12px 0;
  box-sizing: border-box;
  overscroll-behavior: contain;
}
.pdf-scroll-page {
  position: relative;
  width: calc(var(--pdf-scroll-scale) * var(--pdf-page-w, 0px));
  height: calc(var(--pdf-scroll-scale) * var(--pdf-page-h, 0px));
  margin: 0 auto 12px;
  background: #fff;
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.28);
  border-radius: 2px;
  overflow: hidden;
  flex: 0 0 auto;
}
.pdf-scroll-page:last-child {
  margin-bottom: 0;
}
/* 画布填满页盒：缩放过渡期间由 CSS 拉伸旧位图立即反馈，随后再精确重渲染 */
.pdf-scroll-canvas {
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.pdf-scroll-num {
  position: absolute;
  right: 6px;
  bottom: 4px;
  z-index: 5;
  font-size: 11px;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.28);
  color: #fff;
  opacity: 0.65;
  pointer-events: none;
}
/* 状态栏：滚轮模式切换（两个图标按钮并排） */
.pdf-wheel-mode {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  padding: 0 2px;
}
.pdf-float-controls {
  position: absolute;
  right: 10px;
  bottom: 10px;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 10px;
  background: var(--menuColor);
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.2);
  z-index: 20;
}
.pdf-float-group {
  display: flex;
  align-items: center;
  gap: 4px;
}
.pdf-float-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s ease;
}
.pdf-float-btn:hover:not(:disabled) {
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
  border-color: var(--fontActiveColor);
}
.pdf-float-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.pdf-page-info {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--fontColor);
}
.pdf-page-input {
  width: 50px;
  height: 26px;
  text-align: center;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 13px;
  padding: 0px;
  margin: 0px;
  -moz-appearance: textfield;
  appearance: textfield;
}
.pdf-page-input::-webkit-outer-spin-button,
.pdf-page-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.pdf-page-total {
  color: var(--fontColor);
  opacity: 0.7;
}
.pdf-zoom-hint {
  position: absolute;
  left: 16px;
  bottom: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  background: var(--menuColor);
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  color: var(--fontColor);
  font-size: 12px;
  z-index: 20;
  pointer-events: none;
  user-select: none;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.2);
}
.pdf-zoom-hint-sub {
  opacity: 0.6;
  font-size: 11px;
}
.pdf-loading,
.pdf-error {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--fontColor);
  padding: 40px;
  box-sizing: border-box;
}
.pdf-loading i,
.pdf-error i {
  font-size: 28px;
}
.pdf-error i {
  color: #ff6b6b;
}
.pdf-retry-btn {
  padding: 6px 14px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--menuColor);
  color: var(--fontColor);
  cursor: pointer;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 5px;
  transition: all 0.15s ease;
}
.pdf-retry-btn:hover {
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
  border-color: var(--fontActiveColor);
}
.pdf-pages {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

/* ==================== 深色阅读（反色） ==================== */
/* 只对渲染面（canvas）加 filter：GPU 合成、不动像素数据、也不影响文本层，
   因此选区高亮、框选几何、AI 截图（离屏 canvas）都保持原样。
   invert + hue-rotate(180deg) 为「保色反色」：黑字白底 → 白字黑底，彩色图表色相基本不变。
   代价：PDF 内嵌图片 / 扫描件同样会被反色（无法按内容区分），需要时切回原色即可。 */
.pdf-container.pdf-dark .pdf-canvas,
.pdf-container.pdf-dark .pdf-scroll-canvas {
  filter: invert(1) hue-rotate(180deg);
}
.pdf-container.pdf-soft .pdf-canvas,
.pdf-container.pdf-soft .pdf-scroll-canvas {
  filter: invert(0.88) hue-rotate(180deg);
}
/* 页盒与周边底色同步压暗：未渲染时的占位、透明度页面、单页模式四周背景都不再刺眼 */
.pdf-container.pdf-dark .pdf-page-box,
.pdf-container.pdf-dark .pdf-scroll-page {
  background: #101114;
}
.pdf-container.pdf-soft .pdf-page-box,
.pdf-container.pdf-soft .pdf-scroll-page {
  background: #1b1c20;
}
.pdf-container.pdf-dark .pdf-viewport,
.pdf-container.pdf-dark .pdf-scroll {
  background: #2a2c31;
}
.pdf-container.pdf-soft .pdf-viewport,
.pdf-container.pdf-soft .pdf-scroll {
  background: #33353a;
}
/* 页面盒：画布 + 文本层共用同一个定位与缩放变换 */
.pdf-page-box {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  background: #fff;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.18);
  border-radius: 2px;
  cursor: grab;
  will-change: transform;
}
.pdf-canvas {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 2px;
  pointer-events: none;
}

/* === OCR 模态框 === */
.ocr-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0,0,0,0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.ocr-modal-content {
  width: 80vw;
  max-width: 900px;
  height: 80vh;
  background: var(--backgroundColor);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0,0,0,0.3);
}
/* === OCR 模型选择栏 === */
.ocr-model-bar {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px;
  border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
  flex-shrink: 0;
  flex-wrap: wrap;
}
.ocr-model-select {
  flex: 1;
  min-width: 120px;
  height: 28px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 12px;
  padding: 0 6px;
  margin: 0px
}
.ocr-model-select:disabled {
  opacity: 0.5;
}
.ocr-model-refresh,
.ocr-model-start,
.ocr-model-clear {
  padding: 3px 10px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  cursor: pointer;
  font-size: 11px;
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  height: 28px;
}
.ocr-model-refresh:hover:not(:disabled),
.ocr-model-clear:hover:not(:disabled) {
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
}
.ocr-model-start {
  background: var(--menuColor);
  color: var(--fontActiveColor)
}
.ocr-model-start:hover:not(:disabled) {
  opacity: 0.85;
}
.ocr-model-refresh:disabled,
.ocr-model-start:disabled,
.ocr-model-clear:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.ocr-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--borderColor);
  flex-shrink: 0;
}
.ocr-modal-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--fontColor);
  display: flex;
  align-items: center;
  gap: 6px;
}
.ocr-modal-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ocr-progress-text {
  font-size: 11px;
  color: #FF9800;
  margin-right: 8px;
}
.ocr-modal-btn {
  padding: 4px 10px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--menuColor);
  color: var(--fontColor);
  cursor: pointer;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.ocr-modal-btn:hover {
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
  border-color: var(--fontActiveColor);
}
/* === OCR Tab 栏 === */
.ocr-tabs {
  display: flex;
  gap: 2px;
  padding: 4px 8px 0;
  border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
  flex-shrink: 0;
  overflow-x: auto;
  overflow-y: hidden;
  white-space: nowrap;
  scrollbar-width: thin;
}
.ocr-tabs::-webkit-scrollbar {
  height: 3px;
}
.ocr-tabs::-webkit-scrollbar-thumb {
  background: var(--borderColor);
  border-radius: 2px;
}
.ocr-tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  font-size: 11px;
  color: var(--fontColor);
  cursor: pointer;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 4px 4px 0 0;
  flex-shrink: 0;
  user-select: none;
}
.ocr-tab:hover {
  background: var(--backgroundColor);
  border-color: var(--borderColor);
}
.ocr-tab-active {
  background: var(--backgroundColor) !important;
  border-color: var(--borderColor) !important;
  color: var(--fontActiveColor);
  font-weight: 500;
}
.ocr-tab-save {
  background: none;
  border: none;
  color: var(--borderColor);
  cursor: pointer;
  padding: 0 2px;
  font-size: 10px;
  opacity: 0.6;
}
.ocr-tab-save:hover {
  opacity: 1;
  color: var(--fontActiveColor);
}
.ocr-modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 5px;
}
.ocr-page-result {
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  overflow: hidden;
}
.ocr-page-label {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: var(--menuColor);
  font-size: 12px;
  color: var(--fontColor);
  font-weight: 500;
  border-bottom: 1px solid var(--borderColor);
}
.ocr-save-btn {
  margin-left: auto;
  background: none;
  border: 1px solid var(--borderColor);
  border-radius: 3px;
  color: var(--fontColor);
  cursor: pointer;
  padding: 2px 6px;
  font-size: 10px;
  display: flex;
  align-items: center;
  gap: 3px;
}
.ocr-save-btn:hover {
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
}
.ocr-text {
  margin: 0;
  padding: 8px;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--fontColor);
  overflow-y: auto;
}
.ocr-cursor {
  animation: blink 1s steps(1) infinite;
  color: var(--fontActiveColor);
}
@keyframes blink {
  50% { opacity: 0; }
}
.scoll-x {
  overflow-x: auto;
  overflow-y: hidden;
  white-space: nowrap;
  scrollbar-width: thin;
}

/* ==================== 顶部阅读区 / 底部状态栏 ==================== */
.pdf-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: row;
  overflow: hidden;
}
.pdf-main {
  flex: 1;
  min-width: 0;
  position: relative;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ==================== 左侧目录（PDF 书签） ====================
   面板外壳与目录树样式已随目录面板搬到共享组件 DocTocPanel.vue */

/* 底部状态栏（样式与 Edit_Code 编辑器状态栏一致） */
.pdf-statusbar {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 24px;
  flex-shrink: 0;
  padding: 0 8px;
  font-size: 12px;
  color: var(--fontColor);
  background-color: var(--menuColor);
  border-top: 1px solid var(--borderColor);
  user-select: none;
  white-space: nowrap;
  overflow: hidden;
  box-sizing: border-box;
  position: relative;
  z-index: 30;
}
.pdf-statusbar .statusbar-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  opacity: 0.85;
}
.pdf-statusbar .statusbar-item i {
  font-size: 11px;
  opacity: 0.7;
}
.pdf-statusbar .statusbar-spacer {
  flex: 1;
}
.pdf-statusbar .statusbar-sep {
  width: 1px;
  height: 14px;
  background: var(--borderColor);
  margin: 0 6px;
  opacity: 0.6;
}
.pdf-statusbar .statusbar-btn {
  margin: 0;
  padding: 0 6px;
  height: 18px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--fontColor);
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  cursor: pointer;
  opacity: 0.85;
  transition: background-color 0.15s;
}
.pdf-statusbar .statusbar-btn:hover:not(:disabled) {
  background-color: var(--menuActiveColor);
  opacity: 1;
}
.pdf-statusbar .statusbar-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.pdf-statusbar .statusbar-btn.active {
  color: var(--fontActiveColor);
  opacity: 1;
}
.pdf-statusbar .pdf-status-progress {
  cursor: pointer;
  color: #FF9800;
  opacity: 1;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pdf-statusbar .pdf-status-progress:hover {
  background-color: var(--menuActiveColor);
  color: var(--fontColor);
  border-radius: 3px;
}
/* 页码输入 / 缩放状态 */
.pdf-status-input {
  width: 38px;
  height: 16px;
  text-align: center;
  border: 1px solid var(--borderColor);
  border-radius: 3px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 11px;
  padding: 0;
  margin: 0;
  -moz-appearance: textfield;
  appearance: textfield;
}
.pdf-status-input::-webkit-outer-spin-button,
.pdf-status-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.pdf-status-total {
  opacity: 0.7;
}
.pdf-status-zoom {
  min-width: 44px;
  text-align: center;
  cursor: default;
}
.pdf-statusbar-hint {
  font-size: 11px;
  opacity: 0.55;
  margin-left: 6px;
}

/* ==================== 右侧智能操作面板 ==================== */
.pdf-panel {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  min-width: 0;
  height: 100%;
  background: var(--backgroundColor);
  border-left: 1px solid var(--borderColor);
  box-shadow: -6px 0 20px rgba(0, 0, 0, 0.18);
  overflow: hidden;
  z-index: 40;
}
.pdf-panel-resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 5px;
  cursor: ew-resize;
  z-index: 60;
  background: transparent;
  transition: background-color 0.15s;
}
.pdf-panel-resizer:hover {
  background: var(--fontActiveColor);
  opacity: 0.5;
}
.pdf-panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
  flex-shrink: 0;
}
.pdf-panel-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--fontColor);
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  flex-shrink: 0;
}
.pdf-panel-tabs {
  display: flex;
  gap: 3px;
  flex: 1;
  min-width: 0;
}
.pdf-panel-tab {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 4px 6px;
  font-size: 12px;
  color: var(--fontColor);
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
}
.pdf-panel-tab:hover {
  background: var(--backgroundColor);
}
.pdf-panel-tab.active {
  background: var(--backgroundColor);
  border-color: var(--borderColor);
  color: var(--fontActiveColor);
  font-weight: 600;
}
.pdf-panel-close {
  border: none;
  background: transparent;
  color: var(--fontColor);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 2px 7px;
  border-radius: 4px;
  opacity: 0.7;
  flex-shrink: 0;
}
.pdf-panel-close:hover {
  opacity: 1;
  background: var(--backgroundColor);
}
.pdf-panel-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ---------- 转化 tab ---------- */
.pdf-convert {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.pdf-convert-mode {
  display: flex;
  gap: 4px;
  padding: 6px;
  border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
  flex-shrink: 0;
}
.pdf-convert-mode button {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 5px;
  font-size: 12px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
}
.pdf-convert-mode button:hover {
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
}
.pdf-convert-mode button.active {
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
  border-color: var(--fontActiveColor);
  font-weight: 600;
}
.pdf-convert-pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.pdf-convert-actions {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px;
  flex-shrink: 0;
  flex-wrap: wrap;
}
.pdf-convert-actions button,
.pdf-convert-result-toolbar button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  font-size: 12px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--menuColor);
  color: var(--fontColor);
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
}
.pdf-convert-actions button:hover:not(:disabled),
.pdf-convert-result-toolbar button:hover {
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
  border-color: var(--fontActiveColor);
}
.pdf-convert-actions button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.pdf-convert-progress {
  font-size: 11px;
  color: #FF9800;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pdf-convert-tip {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  font-size: 11px;
  color: var(--borderColor);
  padding: 2px 10px 6px;
  line-height: 1.5;
  flex-shrink: 0;
}
.pdf-convert-result {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--borderColor);
}
.pdf-convert-result-toolbar {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  flex-shrink: 0;
  flex-wrap: wrap;
}
.pdf-convert-len {
  font-size: 11px;
  color: var(--borderColor);
  margin-left: auto;
}
.pdf-convert-pre {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 8px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--fontColor);
  background: var(--backgroundColor);
}
.pdf-convert-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--borderColor);
  text-align: center;
  font-size: 12px;
  padding: 0 12px;
}
.pdf-convert-empty i {
  font-size: 26px;
  opacity: 0.5;
}

/* OCR 嵌入面板的适配 */
.pdf-ocr-pane .ocr-model-bar {
  padding: 6px;
  flex-wrap: wrap;
}
.pdf-ocr-status {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  flex-shrink: 0;
  flex-wrap: wrap;
  min-height: 28px;
  border-bottom: 1px solid var(--borderColor);
}
.pdf-ocr-status .ocr-progress-text {
  margin: 0;
}
.pdf-ocr-status button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  font-size: 11px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--menuColor);
  color: var(--fontColor);
  cursor: pointer;
}
.pdf-ocr-status button:hover {
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
}
.pdf-ocr-pane .ocr-tabs {
  padding: 4px 6px 0;
  flex-shrink: 0;
}
.pdf-ocr-pane .ocr-modal-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 5px;
}
.pdf-ocr-pane .ocr-modal-body .ocr-page-result {
  min-height: 100%;
}
.pdf-ocr-pane .ocr-text {
  min-height: 200px;
}

/* ---------- 智能对话 tab ---------- */
/* ===== 【已停用】旧内嵌智能对话样式 =====
   PDF 智能对话已改为复用共享组件 DocChatPanel（其样式为 .dchat-*，在该组件内 scoped），
   以下 .pdf-chat* / .pdf-typing 规则已无对应模板，保留仅供回溯，请勿在新代码中使用。 */
.pdf-chat {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.pdf-chat-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
  flex-shrink: 0;
  flex-wrap: wrap;
}
.pdf-chat-opt {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--fontColor);
  cursor: pointer;
  user-select: none;
}
.pdf-chat-opt input {
  margin: 0;
  accent-color: var(--fontActiveColor);
}
.pdf-chat-right {
  margin-left: auto;
  display: flex;
  gap: 4px;
}
.pdf-chat-toolbar button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  font-size: 11px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  cursor: pointer;
  transition: all 0.15s ease;
}
.pdf-chat-toolbar button:hover:not(:disabled) {
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
}
.pdf-chat-toolbar button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.pdf-chat-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pdf-chat-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--borderColor);
  text-align: center;
  font-size: 12px;
  padding: 0 12px;
}
.pdf-chat-empty i {
  font-size: 26px;
  opacity: 0.5;
}
/* ===== 消息行：参照集群对话（头像 + 头部条 + 右上 hover 复制按钮） ===== */
.pdf-chat-row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  width: 100%;
}
.pdf-chat-row-user {
  justify-content: flex-end;
}
.pdf-chat-bubble {
  min-width: 0;
  max-width: 85%;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  overflow: hidden;
  background: var(--menuColor);
  color: var(--fontColor);
  font-size: 12px;
  line-height: 1.6;
  word-break: break-word;
}
.pdf-chat-row-user .pdf-chat-bubble {
  background: transparent;
}
.pdf-chat-hdr {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  font-size: 10px;
  border-bottom: 1px dashed color-mix(in srgb, var(--borderColor) 55%, transparent);
  background: color-mix(in srgb, var(--borderColor) 4%, transparent);
}
.pdf-chat-row-user .pdf-chat-hdr {
  border-bottom-color: transparent;
  background: transparent;
  padding-bottom: 0;
}
.pdf-chat-hdr .user-ico {
  color: var(--fontActiveColor);
  font-size: 11px;
}
.pdf-chat-name {
  font-weight: 600;
  white-space: nowrap;
}
.pdf-chat-row-user .pdf-chat-name {
  color: var(--fontActiveColor);
}
.pdf-chat-attach {
  color: var(--borderColor);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pdf-chat-sp {
  flex: 1;
}
.pdf-chat-copy {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  background: none;
  color: var(--borderColor);
  cursor: pointer;
  font-size: 11px;
  border-radius: 3px;
  display: none;
  align-items: center;
  justify-content: center;
}
.pdf-chat-row:hover .pdf-chat-copy {
  display: inline-flex;
}
.pdf-chat-copy:hover {
  color: var(--fontActiveColor);
  background: var(--backgroundColor);
}
.pdf-chat-text {
  white-space: pre-wrap;
  padding: 5px 8px;
}
.pdf-chat-html {
  padding: 5px 8px;
  font-size: 13px;
}
.pdf-chat-html :deep(p) {
  margin: 4px 0;
}
.pdf-chat-html :deep(h1),
.pdf-chat-html :deep(h2),
.pdf-chat-html :deep(h3),
.pdf-chat-html :deep(h4),
.pdf-chat-html :deep(h5),
.pdf-chat-html :deep(h6) {
  font-size: 14px;
  font-weight: 600;
  margin: 6px 0 4px;
  line-height: 1.4;
  color: var(--fontColor);
}
.pdf-chat-html :deep(ul),
.pdf-chat-html :deep(ol) {
  margin: 4px 0;
  padding-left: 18px;
}
.pdf-chat-html :deep(li) {
  margin: 2px 0;
}
.pdf-chat-html :deep(a) {
  color: var(--fontActiveColor);
}
.pdf-chat-html :deep(blockquote) {
  margin: 4px 0;
  padding: 2px 10px;
  border-left: 3px solid var(--borderColor);
  color: var(--borderColor);
}
.pdf-chat-html :deep(pre),
.pdf-chat-html :deep(pre.hljs) {
  background: var(--inputColor);
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  padding: 6px 8px;
  overflow-x: auto;
  margin: 4px 0;
  color: var(--fontColor);
}
.pdf-chat-html :deep(code) {
  font-size: 12px;
}
.pdf-chat-html :deep(table) {
  border-collapse: collapse;
  margin: 4px 0;
  width: 100%;
}
.pdf-chat-html :deep(th),
.pdf-chat-html :deep(td) {
  border: 1px solid var(--borderColor);
  padding: 3px 6px;
  text-align: left;
}
.pdf-chat-html :deep(img) {
  max-width: 100%;
}
.pdf-chat-imgs {
  display: flex;
  gap: 4px;
  margin-top: 3px;
  padding: 0 8px 5px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.pdf-chat-img {
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  overflow: hidden;
  max-width: 130px;
}
.pdf-chat-img img {
  display: block;
  width: 100%;
  cursor: zoom-in;
}
.pdf-chat-img span {
  display: block;
  text-align: center;
  font-size: 10px;
  padding: 1px 0;
  background: var(--backgroundColor);
  color: var(--borderColor);
}
.pdf-typing {
  color: var(--borderColor);
  font-size: 11px;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
}
.pdf-chat-input {
  border-top: 1px solid var(--borderColor);
  padding: 6px;
  background: color-mix(in srgb, var(--backgroundColor) 97%, var(--borderColor));
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pdf-chat-input textarea {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  min-height: 44px;
  max-height: 120px;
  padding: 6px 8px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background: var(--inputColor);
  color: var(--fontColor);
  font-size: 12px;
  outline: none;
  font-family: inherit;
  line-height: 1.5;
}
.pdf-chat-input textarea:focus {
  border-color: var(--fontActiveColor);
}
.pdf-chat-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: nowrap;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.pdf-chat-actions::-webkit-scrollbar {
  display: none;
}
.pdf-chat-actions .pdf-chat-spacer {
  flex: 1;
  min-width: 6px;
}
.pdf-chat-actions .pdf-chat-attach,
.pdf-chat-actions .pdf-chat-mini,
.pdf-chat-actions .pdf-chat-send {
  flex-shrink: 0;
}
.pdf-chat-mini {
  height: 26px;
  padding: 0 8px;
}
.pdf-chat-tip {
  font-size: 10px;
  color: var(--borderColor);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pdf-chat-actions .pdf-chat-mini {
  height: 28px;
  padding: 0 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background: var(--menuColor);
  color: var(--fontColor);
  cursor: pointer;
  font-size: 12px;
  flex-shrink: 0;
  transition: all 0.15s ease;
}
.pdf-chat-actions .pdf-chat-mini:hover:not(:disabled) {
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
  border-color: var(--fontActiveColor);
}
.pdf-chat-actions .pdf-chat-mini:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.pdf-chat-actions .pdf-chat-send {
  width: 32px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background: var(--fontActiveColor);
  color: var(--menuColor);
  cursor: pointer;
  font-size: 13px;
  flex-shrink: 0;
}
.pdf-chat-actions .pdf-chat-send:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 附加上下文选择条（当前页文字 / PDF 全文 / 截图，三选一或都不选） */
.pdf-chat-attachbar {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.pdf-chat-attach {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  font-size: 11px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: transparent;
  color: var(--fontColor);
  cursor: pointer;
  opacity: 0.85;
  transition: all 0.15s ease;
  white-space: nowrap;
}
.pdf-chat-attach:hover {
  background: var(--menuColor);
  opacity: 1;
}
.pdf-chat-attach.active {
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
  border-color: var(--fontActiveColor);
  opacity: 1;
}
.pdf-chat-attach-hint {
  font-size: 10px;
  color: var(--borderColor);
  margin-left: 4px;
  white-space: nowrap;
}

/* OCR 识别结果：左侧页码导航 + 右侧内容（保存 / 复制） */
.pdf-ocr-main {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: row;
  border-top: 1px solid var(--borderColor);
  overflow: hidden;
}
.pdf-ocr-nav {
  flex: 0 0 auto;
  width: 78px;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  border-left: 1px solid var(--borderColor);
  padding: 4px 3px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--menuColor);
  box-sizing: border-box;
}
.pdf-ocr-nav-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  font-size: 11px;
  color: var(--fontColor);
  cursor: pointer;
  border: 1px solid transparent;
  border-radius: 4px;
  white-space: nowrap;
  user-select: none;
  flex-shrink: 0;
}
.pdf-ocr-nav-item:hover {
  background: var(--backgroundColor);
}
.pdf-ocr-nav-item.active {
  background: var(--backgroundColor);
  border-color: var(--borderColor);
  color: var(--fontActiveColor);
  font-weight: 600;
}
.pdf-ocr-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.pdf-ocr-content-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--borderColor);
  flex-shrink: 0;
}
.pdf-ocr-content-page {
  font-size: 12px;
  color: var(--fontColor);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pdf-ocr-content-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.pdf-ocr-content-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  font-size: 12px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--menuColor);
  color: var(--fontColor);
  cursor: pointer;
  transition: all 0.15s ease;
}
.pdf-ocr-content-btn:hover:not(:disabled) {
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
  border-color: var(--fontActiveColor);
}
.pdf-ocr-content-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.pdf-ocr-content-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.pdf-ocr-content-pre {
  margin: 0;
  padding: 8px;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--fontColor);
  overflow-y: auto;
  min-height: 100%;
  box-sizing: border-box;
}

/* 转化面板底部操作条（模式切换 + 模型/开始，单行） */
.pdf-convert-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 5px 6px;
  border-top: 1px solid var(--borderColor);
  background: color-mix(in srgb, var(--backgroundColor) 97%, var(--borderColor));
  flex-wrap: nowrap;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.pdf-convert-bar::-webkit-scrollbar {
  display: none;
}
.pdf-convert-bar-group {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.pdf-convert-mode-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  font-size: 12px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: transparent;
  color: var(--fontColor);
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: all 0.15s ease;
}
.pdf-convert-mode-btn:hover {
  background: var(--backgroundColor);
}
.pdf-convert-mode-btn.active {
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
  border-color: var(--fontActiveColor);
}
.pdf-convert-bar .pdf-convert-run-btn,
.pdf-convert-bar .pdf-convert-mini-btn,
.pdf-convert-bar .pdf-convert-model-select {
  flex-shrink: 0;
}
.pdf-convert-run-btn,
.pdf-convert-mini-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  font-size: 12px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--menuColor);
  color: var(--fontColor);
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
}
.pdf-convert-mini-btn:hover:not(:disabled),
.pdf-convert-run-btn:hover:not(:disabled) {
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
  border-color: var(--fontActiveColor);
}
.pdf-convert-run-btn {
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
  border-color: var(--menuActiveColor);
}
.pdf-convert-run-btn:disabled,
.pdf-convert-mini-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.pdf-convert-model-select {
  width: 140px;
  height: 26px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 11px;
  padding: 0 4px;
  margin: 0px
}
.pdf-convert-model-select:disabled {
  opacity: 0.5;
}
.pdf-convert-bar-status {
  margin-left: auto;
  font-size: 11px;
  color: #FF9800;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 1;
}

/* 面板内控件统一高度：避免两个面板中元素高度不统一 */
.pdf-convert-mode-btn,
.pdf-convert-run-btn,
.pdf-convert-mini-btn,
.pdf-convert-model-select,
.pdf-convert-result-toolbar button,
.pdf-ocr-content-btn,
.pdf-chat-actions .pdf-chat-attach,
.pdf-chat-actions .pdf-chat-mini,
.pdf-chat-actions .pdf-chat-send {
  height: 26px;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.pdf-chat-actions .pdf-chat-send {
  width: 32px;
  padding: 0;
}
.pdf-chat-actions .pdf-chat-attach,
.pdf-chat-actions .pdf-chat-mini {
  width: auto;
}
.pdf-ocr-content-btn {
  padding: 0 10px;
}
.pdf-convert-mode-btn,
.pdf-convert-run-btn,
.pdf-convert-mini-btn {
  padding: 0 10px;
}
</style>

<!--
  pdf.js 文本层样式（非 scoped）
  文本层内的 span 由 pdf.js 动态创建，不会带上 scoped 属性，因此这些规则必须全局声明。
  变量 --scale-factor：单页模式写在 .pdf-text-layer 自身；
  连续模式写在 .pdf-scroll 容器上由所有文本层继承（缩放时只需改这一个变量）。
  pdf.js 生成的 span 使用 calc(var(--scale-factor) * Npx) 定位与设置字号。
-->
<style>
.pdf-text-layer {
  position: absolute;
  inset: 0;
  overflow: clip;
  line-height: 1;
  text-align: initial;
  -webkit-text-size-adjust: none;
  text-size-adjust: none;
  forced-color-adjust: none;
  transform-origin: 0 0;
  caret-color: CanvasText;
  z-index: 2;
  cursor: text;
  user-select: text;
  -webkit-user-select: text;
}
.pdf-text-layer :is(span, br) {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0% 0%;
}
.pdf-text-layer > :not(.markedContent),
.pdf-text-layer .markedContent span:not(.markedContent) {
  z-index: 1;
}
.pdf-text-layer span.markedContent {
  top: 0;
  height: 0;
}
.pdf-text-layer span[role='img'] {
  user-select: none;
  -webkit-user-select: none;
  cursor: default;
}
.pdf-text-layer ::selection {
  background: rgba(0, 0, 255, 0.28);
}
.pdf-text-layer br::selection {
  background: transparent;
}
/* 焦点转到右侧对话面板后保持「选中」可见：由组件给命中的 span 打标记类 */
.pdf-text-layer span.pdf-sel-hit {
  background: rgba(0, 0, 255, 0.28);
}
</style>
