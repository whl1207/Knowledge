<script setup lang="ts">
  import { ref, onMounted, onBeforeUnmount, computed, nextTick, watch } from 'vue'
  import { usestore } from '@/store'
  import { ocrImage, ocrProviderLabel, rankOcrModels, hasVisionLikeModel, loadOcrModelPref, saveOcrModelPref, llmConfigByKey, loadOcrSourcePref, saveOcrSourcePref, prepareOcrImage, OCR_SELECTABLE_SOURCES } from '@/lib/knowFile/ocr'

  const store = usestore()

  const props = defineProps<{
    path: string;
    /** 可选：图片 data URL（远程文件预览用，提供时优先于 path） */
    src?: string;
    enableDragging?: boolean; // 是否启用拖拽
    minScale?: number;        // 最小缩放比例
    maxScale?: number;        // 最大缩放比例
    wheelStep?: number;       // 滚轮缩放步长
    showControls?: boolean;   // 是否显示控制按钮
  }>()

  // 图片地址：优先使用 src（远程 data URL），否则本地 path 转 file:// URL
  // 本地路径需编码特殊字符（#、?、空格、中文），避免 #/？被当作 URL fragment/query 截断导致加载失败
  // 本地展示基于 innerPath（组件内部可用方向键在同目录图片间切换）
  const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg']
  // 是否具备本地 IPC 能力（浏览器/LAN 共享模式无 ipcRenderer，无法扫描目录，禁用导航）
  const hasIpc = typeof window !== 'undefined' && !!(window as any).ipcRenderer
  // 当前实际显示的本地图片路径（组件内部可切换）
  const innerPath = ref(props.path || '')
  // 当前图片同目录下的全部图片（按文件名自然排序，含字节大小），供浏览上一张/下一张
  const folderImages = ref<{ path: string; size?: number }[]>([])
  // 当前图片在 folderImages 中的下标（-1 表示未匹配到）
  const currentIndex = ref(-1)
  // 图片像素尺寸（img 加载后从 naturalWidth/Height 读取，状态栏展示用）
  const naturalSize = ref({ w: 0, h: 0 })
  // 当前文件字节数（本地同目录扫描可得；null 表示不可知 → 状态栏隐藏大小项）
  const currentFileSize = ref<number | null>(null)
  // 是否允许同目录导航：本地文件 + 非远程 data URL + 具备 IPC
  const canNavigate = computed(() => !!props.path && !props.src && hasIpc)
  // 路径标准化（统一分隔符 + 小写），用于 Windows 大小写不敏感比较
  const normPath = (p: string) => String(p || '').replace(/\\/g, '/').toLowerCase()

  const imageSrc = computed(() => {
    if (props.src) return props.src
    const p = String(innerPath.value || props.path || '').replace(/\\/g, '/')
    return 'file:///' + encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F')
  })

  // 默认值
  const enableDragging = props.enableDragging ?? true
  const minScale = props.minScale ?? 0.1
  const maxScale = props.maxScale ?? 5
  const wheelStep = props.wheelStep ?? 0.1
  const showControls = props.showControls ?? true

  // === 底部状态栏（信息 / 按钮状态） ===
  // 缩放边界控制（状态栏按钮到边界时置灰）
  const canZoomIn = computed(() => imgScale.value < maxScale)
  const canZoomOut = computed(() => imgScale.value > minScale)
  // 格式化文件大小
  const formatSize = (bytes: number) => {
    if (!bytes || bytes <= 0) return ''
    const units = ['B', 'KB', 'MB', 'GB']
    let i = 0
    let v = bytes
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
    return (i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i]
  }

  // 图片缩放相关变量
  const imgScale = ref(1) // 缩放比例
  const imgPosition = ref({ x: 0, y: 0 }) // 图片位置
  const isDragging = ref(false) // 是否正在拖拽
  const dragStart = ref({ x: 0, y: 0 }) // 拖拽开始位置
  const imgElement = ref<HTMLImageElement | null>(null) // 图片元素引用
  const containerElement = ref<HTMLDivElement | null>(null) // 容器元素引用
  
  // 边界检查变量
  const boundaries = ref({
    minX: 0,
    maxX: 0,
    minY: 0,
    maxY: 0
  })

  // 发射事件
  const emit = defineEmits<{
    reset: [];
    scaleChange: [scale: number];
    positionChange: [position: { x: number, y: number }];
    /** 图片切换（同目录上一张/下一张）时通知父组件，父组件可据此同步标题/文件名 */
    'update:path': [path: string];
  }>()

  // 计算可拖拽边界
  const calculateBoundaries = () => {
    if (!imgElement.value || !containerElement.value) return
    
    const containerRect = containerElement.value.getBoundingClientRect()
    const imgRect = imgElement.value.getBoundingClientRect()
    
    // 计算可拖拽的边界范围
    const scaledWidth = imgRect.width * imgScale.value
    const scaledHeight = imgRect.height * imgScale.value
    
    // 只有当图片尺寸大于容器时才允许拖拽
    if (scaledWidth > containerRect.width) {
      boundaries.value.minX = -(scaledWidth - containerRect.width) / 2
      boundaries.value.maxX = (scaledWidth - containerRect.width) / 2
    } else {
      boundaries.value.minX = boundaries.value.maxX = 0
    }
    
    if (scaledHeight > containerRect.height) {
      boundaries.value.minY = -(scaledHeight - containerRect.height) / 2
      boundaries.value.maxY = (scaledHeight - containerRect.height) / 2
    } else {
      boundaries.value.minY = boundaries.value.maxY = 0
    }
    
    // 限制当前位置在边界内
    imgPosition.value.x = Math.max(boundaries.value.minX, Math.min(boundaries.value.maxX, imgPosition.value.x))
    imgPosition.value.y = Math.max(boundaries.value.minY, Math.min(boundaries.value.maxY, imgPosition.value.y))
  }

  // 初始化图片缩放功能
  const setupImageZoom = () => {
    if (!imgElement.value) return
    
    // 重置样式
    imgElement.value.style.transform = `scale(${imgScale.value}) translate(${imgPosition.value.x}px, ${imgPosition.value.y}px)`
    imgElement.value.style.transformOrigin = 'center center'
    imgElement.value.style.transition = 'transform 0.1s ease'
    imgElement.value.style.cursor = imgScale.value > 1 && enableDragging ? 'grab' : 'default'
    
    // 计算边界
    calculateBoundaries()
  }
  
  // 处理滚轮缩放
  const handleWheel = (e: WheelEvent) => {
    if (!imgElement.value || !containerElement.value) return
    
    e.preventDefault()
    e.stopPropagation()
    
    const delta = e.deltaY > 0 ? -wheelStep : wheelStep
    const newScale = Math.max(minScale, Math.min(maxScale, imgScale.value + delta))
    
    // 计算缩放中心点
    const rect = containerElement.value.getBoundingClientRect()
    const mouseX = e.clientX - rect.left - rect.width / 2
    const mouseY = e.clientY - rect.top - rect.height / 2
    
    // 调整位置以保持缩放中心
    const scaleRatio = newScale / imgScale.value
    const newX = imgPosition.value.x * scaleRatio + mouseX * (scaleRatio - 1)
    const newY = imgPosition.value.y * scaleRatio + mouseY * (scaleRatio - 1)
    
    imgScale.value = newScale
    imgPosition.value = { x: newX, y: newY }
    
    updateImageTransform()
    calculateBoundaries()
    emit('scaleChange', imgScale.value)
    emit('positionChange', imgPosition.value)
    
    // 更新光标样式
    if (imgElement.value) {
      imgElement.value.style.cursor = imgScale.value > 1 && enableDragging ? 'grab' : 'default'
    }
  }
  
  // 开始拖拽
  const startDrag = (e: MouseEvent) => {
    if (!imgElement.value || !containerElement.value || !enableDragging || imgScale.value <= 1) return
    
    e.preventDefault()
    e.stopPropagation()
    
    isDragging.value = true
    dragStart.value = { x: e.clientX - imgPosition.value.x, y: e.clientY - imgPosition.value.y }
    
    if (imgElement.value) {
      imgElement.value.style.cursor = 'grabbing'
      imgElement.value.style.transition = 'none'
    }
    
    // 添加全局拖拽监听
    document.addEventListener('mousemove', onDrag)
    document.addEventListener('mouseup', stopDrag)
    // 防止选中文本
    document.addEventListener('selectstart', preventSelection)
  }
  
  // 拖拽中
  const onDrag = (e: MouseEvent) => {
    if (!isDragging.value || !imgElement.value || !containerElement.value) return
    
    e.preventDefault()
    
    // 计算新位置
    let newX = e.clientX - dragStart.value.x
    let newY = e.clientY - dragStart.value.y
    
    // 限制在边界内
    newX = Math.max(boundaries.value.minX, Math.min(boundaries.value.maxX, newX))
    newY = Math.max(boundaries.value.minY, Math.min(boundaries.value.maxY, newY))
    
    imgPosition.value = { x: newX, y: newY }
    
    updateImageTransform()
  }
  
  // 停止拖拽
  const stopDrag = (e?: MouseEvent) => {
    if (e) {
      e.preventDefault()
      e.stopPropagation()
    }
    
    isDragging.value = false
    if (imgElement.value) {
      imgElement.value.style.cursor = imgScale.value > 1 && enableDragging ? 'grab' : 'default'
      imgElement.value.style.transition = 'transform 0.1s ease'
    }
    
    // 清理事件监听
    document.removeEventListener('mousemove', onDrag)
    document.removeEventListener('mouseup', stopDrag)
    document.removeEventListener('selectstart', preventSelection)
    
    // 如果拖拽结束，触发位置变化事件
    if (e) {
      emit('positionChange', imgPosition.value)
    }
  }
  
  // 防止选中文本
  const preventSelection = (e: Event) => {
    e.preventDefault()
  }
  
  // 更新图片变换
  const updateImageTransform = () => {
    if (!imgElement.value) return
    
    imgElement.value.style.transform = `scale(${imgScale.value}) translate(${imgPosition.value.x}px, ${imgPosition.value.y}px)`
  }
  
  // 重置图片缩放
  const resetImageZoom = () => {
    imgScale.value = 1
    imgPosition.value = { x: 0, y: 0 }
    if (imgElement.value) {
      imgElement.value.style.transform = 'scale(1) translate(0px, 0px)'
      imgElement.value.style.cursor = 'default'
    }
    calculateBoundaries()
    emit('reset')
    emit('scaleChange', 1)
    emit('positionChange', imgPosition.value)
  }
  
  // 放大
  const zoomIn = () => {
    if (!imgElement.value || !containerElement.value) return
    
    const newScale = Math.min(maxScale, imgScale.value + 0.2)
    const scaleRatio = newScale / imgScale.value
    
    // 计算基于中心的缩放
    const newX = imgPosition.value.x * scaleRatio
    const newY = imgPosition.value.y * scaleRatio
    
    imgScale.value = newScale
    imgPosition.value = { x: newX, y: newY }
    
    updateImageTransform()
    calculateBoundaries()
    emit('scaleChange', imgScale.value)
    emit('positionChange', imgPosition.value)
    
    if (imgElement.value) {
      imgElement.value.style.cursor = imgScale.value > 1 && enableDragging ? 'grab' : 'default'
    }
  }
  
  // 缩小
  const zoomOut = () => {
    if (!imgElement.value || !containerElement.value) return
    
    const newScale = Math.max(minScale, imgScale.value - 0.2)
    const scaleRatio = newScale / imgScale.value
    
    // 计算基于中心的缩放
    const newX = imgPosition.value.x * scaleRatio
    const newY = imgPosition.value.y * scaleRatio
    
    imgScale.value = newScale
    imgPosition.value = { x: newX, y: newY }
    
    updateImageTransform()
    calculateBoundaries()
    emit('scaleChange', imgScale.value)
    emit('positionChange', imgPosition.value)
    
    if (imgElement.value && imgScale.value <= 1) {
      imgElement.value.style.cursor = 'default'
    }
  }
  
  // 在图片加载完成后设置缩放功能，并记录像素尺寸供状态栏展示
  const onImageLoad = async (el: HTMLImageElement) => {
    imgElement.value = el
    naturalSize.value = { w: el.naturalWidth || 0, h: el.naturalHeight || 0 }
    await nextTick()
    setupImageZoom()
  }
  
  // 双击重置
  const handleDoubleClick = () => {
    resetImageZoom()
  }
  
  // 处理容器鼠标按下事件（防止拖拽时移出图片）
  const handleContainerMouseDown = (e: MouseEvent) => {
    // 只有在图片上点击时才启动拖拽
    if (!imgElement.value || e.target !== imgElement.value) {
      return
    }
    startDrag(e)
  }
  
  // 监听键盘快捷键
  const handleKeyDown = (e: KeyboardEvent) => {
    // OCR 对话框打开时不响应（避免方向键/输入被吞掉）
    if (ocrVisible.value) return
    // 输入类元素聚焦时不抢占方向键
    const tag = (e.target as HTMLElement)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

    // Ctrl + 滚轮或 Ctrl + +/- 缩放
    if (e.ctrlKey) {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === '+' || e.key === '=') {
        zoomIn()
      } else if (e.key === '-' || e.key === '_') {
        zoomOut()
      } else if (e.key === '0') {
        resetImageZoom()
      }
    }
    // ESC 键重置
    else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      resetImageZoom()
    }
    // 方向键切换同目录图片：→/↓ 下一张，←/↑ 上一张（到底/到顶自动循环）
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault()
      e.stopPropagation()
      stepImage(1)
    }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      stepImage(-1)
    }
  }
  
  // 处理容器鼠标离开
  const handleContainerMouseLeave = (e: MouseEvent) => {
    // 如果正在拖拽且鼠标离开容器，停止拖拽
    if (isDragging.value) {
      stopDrag(e)
    }
  }
  
  // === OCR ===
  // 来源可在对话框里显式选择（记住到 localStorage，不动主来源设置）：
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
  const ocrVisible = ref(false)
  const ocrModels = ref<string[]>([])
  const ocrSelectedModel = ref('')
  const ocrRunning = ref(false)
  const ocrCancelled = ref(false)
  const ocrResult = ref('')
  const ocrStreamText = ref('')
  const ocrProgress = ref('')

  const openOcr = () => {
    ocrVisible.value = true
    ocrResult.value = ''
    ocrStreamText.value = ''
    ocrProgress.value = ''
    if (ocrModels.value.length === 0) fetchOcrModels()
  }

  const closeOcr = () => {
    if (ocrRunning.value) return
    ocrVisible.value = false
  }

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

  // 记住每个来源上次选中的 OCR 模型
  watch(ocrSelectedModel, (v) => {
    if (v && ocrProvider.value) saveOcrModelPref(ocrProvider.value, v)
  })

  const readImageDataUrl = async (filePath: string): Promise<string> => {
    // 远程图片：直接复用已注入的 src data URL
    if (props.src && /^data:/i.test(props.src)) return props.src
    const result = await window.ipcRenderer.invoke('readFileBase64', filePath)
    if (typeof result !== 'string' || !result.startsWith('data:')) {
      throw new Error(typeof result === 'string' ? result : '读取图片失败')
    }
    return result
  }

  const startOcr = async () => {
    if ((!props.path && !props.src) || ocrRunning.value || !ocrSelectedModel.value) return

    ocrRunning.value = true
    ocrCancelled.value = false
    ocrResult.value = ''
    ocrStreamText.value = ''
    const zh = store.locales === 'zh'
    ocrProgress.value = zh ? '正在识别...' : 'Processing...'

    const prompt = zh
      ? '请识别这张图片中的所有文字，并整理为 Markdown 格式输出。只返回文字内容，不要添加额外说明。'
      : 'Extract all text from this image and format it as Markdown. Return only the text content without additional remarks.'

    try {
      const dataUrl = await readImageDataUrl(props.path)
      // 统一预处理：长边限幅 + 转 JPEG（白底）—— OpenAI 兼容后端按 image/jpeg 声明图片
      const prepared = await prepareOcrImage(dataUrl)
      const base64Data = prepared.split(',')[1]
      // 重复抑制参数 / 逐级加强重试 / 失败文案统一收敛到 @/lib/knowFile/ocr
      const text = await ocrImage({
        provider: ocrProvider.value,
        config: llmConfigByKey(store.AIconfig?.llm, ocrProvider.value) || {},
        model: ocrSelectedModel.value,
        imageBase64: base64Data,
        prompt,
        zh,
        cancelled: () => ocrCancelled.value,
        onRetry: (attempt, total, reason) => {
          console.warn(`[OCR] 识别失败 (尝试 ${attempt - 1}/${total}):`, reason)
          ocrProgress.value = zh
            ? `识别失败，重试 ${attempt - 1}/${total - 1}：${reason}`
            : `Failed, retry ${attempt - 1}/${total - 1}: ${reason}`
        },
      })

      // 逐字渐显
      ocrStreamText.value = ''
      for (let i = 0; i < text.length; i += 3) {
        if (ocrCancelled.value) break
        ocrStreamText.value = text.substring(0, Math.min(i + 3, text.length))
        await nextTick()
        await new Promise(r => setTimeout(r, 5))
      }
      if (!ocrCancelled.value) ocrStreamText.value = text
      ocrResult.value = text
      ocrProgress.value = zh ? '识别完成' : 'Complete'
    } catch (err: any) {
      console.error('[OCR] 识别失败:', err)
      ocrProgress.value = zh ? '识别失败' : 'Failed'
      ocrResult.value = `[OCR 失败: ${err?.message || (zh ? '未知错误' : 'Unknown error')}]`
      ocrStreamText.value = ocrResult.value
    }
    ocrRunning.value = false
  }

  const cancelOcr = () => { ocrCancelled.value = true }

  const saveOcr = async () => {
    const text = ocrResult.value
    if (!text) return
    const fileName = `${props.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || 'image'}.md`
    const savePath = `${store.root}/${fileName}`
    try {
      await window.ipcRenderer.invoke('saveFile', savePath, text)
      ocrProgress.value = store.locales === 'zh' ? `已保存到 ${fileName}` : `Saved to ${fileName}`
    } catch (err) {
      console.error('[OCR] 保存失败:', err)
    }
  }

  // === 同目录图片浏览（方向键 / 状态栏按钮切换上一张/下一张）===
  // 扫描当前图片所在目录的所有图片（按文件名自然排序），并定位当前图片下标
  const loadSiblingImages = async () => {
    folderImages.value = []
    currentIndex.value = -1
    currentFileSize.value = null
    if (!canNavigate.value) return
    const path = innerPath.value || props.path || ''
    const folder = path.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
    if (!folder) return
    try {
      const files: any[] = (await window.ipcRenderer.invoke('getFiles', folder, 0)) || []
      folderImages.value = files
        .filter((f: any) => f && f.type === 'file' && IMAGE_EXTS.includes(String(f.extension || '').toLowerCase()))
        .sort((a: any, b: any) => String(a.label || a.name || '').localeCompare(String(b.label || b.name || ''), undefined, { numeric: true }))
        .map((f: any) => ({ path: String(f.path || ''), size: typeof f.size === 'number' ? f.size : undefined }))
      const target = normPath(path)
      currentIndex.value = folderImages.value.findIndex(p => normPath(p.path) === target)
      if (currentIndex.value >= 0) currentFileSize.value = folderImages.value[currentIndex.value].size ?? null
    } catch {
      folderImages.value = []
    }
  }

  // 应用 folderImages[currentIndex] 为当前显示图片（更新内部路径/大小并通知父组件）
  const applyCurrentImage = () => {
    const item = folderImages.value[currentIndex.value]
    if (!item) return
    currentFileSize.value = item.size ?? null
    const next = item.path
    if (!next || normPath(next) === normPath(innerPath.value || props.path || '')) return
    innerPath.value = next
    // 通知父组件（md_read / FileWindow 等）当前显示的图片已切换，便于同步标题/文件名
    emit('update:path', next)
  }

  // 切换上一张/下一张（dir=1 下一张，dir=-1 上一张；到边界自动循环）
  const stepImage = (dir: number) => {
    if (!canNavigate.value || folderImages.value.length <= 1) return
    // 正在拖拽则先结束拖拽
    if (isDragging.value) stopDrag()
    // 已缩放则先复位，避免带着旧缩放/偏移看新图
    if (imgScale.value > 1) resetImageZoom()

    const total = folderImages.value.length
    let idx = currentIndex.value
    if (idx < 0 || idx >= total) {
      // 当前图未匹配到列表（目录刷新等异常场景）：从对应边界开始
      idx = dir > 0 ? -1 : total
    }
    currentIndex.value = (idx + dir + total) % total
    applyCurrentImage()
  }

  // 跳转到指定下标的同目录图片（供状态栏序号点击回到第 1 张）
  const jumpToImage = (target: number) => {
    if (!canNavigate.value || folderImages.value.length === 0) return
    const total = folderImages.value.length
    const idx = ((Math.trunc(target) % total) + total) % total
    if (idx === currentIndex.value) return
    if (isDragging.value) stopDrag()
    if (imgScale.value > 1) resetImageZoom()
    currentIndex.value = idx
    applyCurrentImage()
  }

  // 父组件传入 path 变化时：同步内部显示路径并重新扫描同目录图片
  watch(() => props.path, (p) => {
    if (p) innerPath.value = p
    if (!props.src) loadSiblingImages()
  }, { immediate: true })

  onMounted(() => {
    // 添加键盘事件监听
    window.addEventListener('keydown', handleKeyDown)
  })

  onBeforeUnmount(() => {
    // 清理事件监听
    stopDrag()
    window.removeEventListener('keydown', handleKeyDown)
  })
</script>

<template>
  <div class="viewer-root">
    <!-- 图片显示区 -->
    <div class="image-container"
         ref="containerElement"
         @dblclick="handleDoubleClick"
         @wheel="handleWheel"
         @mousedown="handleContainerMouseDown"
         @mouseleave="handleContainerMouseLeave">
      <!-- 图片元素 -->
      <img
        ref="imgElement"
        class="image-main"
        :src="imageSrc"
        @load="onImageLoad($event.target as HTMLImageElement)"
        @mousedown="startDrag"
        draggable="false"
        alt=""
      />
    </div>

    <!-- 底部状态栏（样式与 md_read / Edit_Code 一致：左按钮 + 右信息） -->
    <div class="view-statusbar">
      <!-- 操作按钮（左） -->
      <template v-if="showControls">
        <!-- 同目录翻页 -->
        <template v-if="canNavigate && folderImages.length > 1">
          <button class="statusbar-btn" @click="stepImage(-1)" :title="store.locales==='zh' ? '上一张 (←/↑)' : 'Previous (←/↑)'"><i class="fa fa-chevron-left"></i></button>
          <button class="statusbar-btn" @click="stepImage(1)" :title="store.locales==='zh' ? '下一张 (→/↓)' : 'Next (→/↓)'"><i class="fa fa-chevron-right"></i></button>
        </template>
        <!-- 缩放 -->
        <button class="statusbar-btn" @click="zoomIn" :disabled="!canZoomIn" :title="store.locales==='zh' ? '放大 (Ctrl + +)' : 'Zoom in (Ctrl + +)'"><i class="fa fa-search-plus"></i></button>
        <button class="statusbar-btn" @click="zoomOut" :disabled="!canZoomOut" :title="store.locales==='zh' ? '缩小 (Ctrl + -)' : 'Zoom out (Ctrl + -)'"><i class="fa fa-search-minus"></i></button>
        <button class="statusbar-btn" @click="resetImageZoom" :title="store.locales==='zh' ? '适应窗口 (双击 / ESC)' : 'Fit window (double-click / ESC)'"><i class="fa fa-expand"></i></button>
      </template>
      <!-- OCR -->
      <button class="statusbar-btn" @click="openOcr" :title="store.locales==='zh' ? 'OCR 识别' : 'OCR'"><i class="fa fa-font"></i></button>

      <span class="statusbar-spacer"></span>
      <span class="statusbar-sep"></span>

      <!-- 状态信息（右） -->
      <span v-if="canNavigate && folderImages.length > 1" class="statusbar-item statusbar-page" @click="jumpToImage(0)"
            :title="store.locales==='zh' ? ('共 ' + folderImages.length + ' 张 · 点击回到第 1 张') : (folderImages.length + ' images · click for 1st')">
        <i class="fa fa-picture-o"></i>{{ (currentIndex < 0 ? 1 : currentIndex + 1) }} / {{ folderImages.length }}
      </span>
      <span class="statusbar-item statusbar-scale" @click="resetImageZoom"
            :title="store.locales==='zh' ? '缩放比例 · 点击恢复 100%' : 'Zoom level · click to reset 100%'">
        <i class="fa fa-percent"></i>{{ Math.round(imgScale * 100) }}%
      </span>
      <span v-if="naturalSize.w && naturalSize.h" class="statusbar-item"
            :title="store.locales==='zh' ? '图片像素尺寸' : 'Pixel dimensions'">
        <i class="fa fa-arrows-alt"></i>{{ naturalSize.w }} × {{ naturalSize.h }}
      </span>
      <span v-if="currentFileSize != null" class="statusbar-item"
            :title="store.locales==='zh' ? '文件大小' : 'File size'">
        <i class="fa fa-file-o"></i>{{ formatSize(currentFileSize) }}
      </span>
    </div>
  </div>

  <!-- OCR 对话框 -->
  <div v-if="ocrVisible" class="ocr-overlay" @click.self="closeOcr">
    <div class="ocr-dialog" @click.stop>
      <div class="ocr-header">
        <span class="ocr-title"><i class="fa fa-font"></i> {{ store.locales==='zh' ? 'OCR 识别' : 'OCR' }}</span>
        <div class="ocr-toolbar">
          <span v-if="ocrProgress" class="ocr-progress">{{ ocrProgress }}</span>
          <button v-if="ocrRunning" class="ocr-btn-sm" @click="cancelOcr"><i class="fa fa-stop"></i></button>
          <button v-if="!ocrRunning && ocrResult" class="ocr-btn-sm" @click="saveOcr"><i class="fa fa-save"></i> {{ store.locales==='zh'?'保存':'Save' }}</button>
          <button class="ocr-btn-sm" @click="closeOcr"><i class="fa fa-times"></i></button>
        </div>
      </div>
      <div class="ocr-model-row">
        <!-- 识别来源（可手动切换，默认跟当前模型来源） -->
        <select v-model="ocrProvider" class="ocr-select" style="flex:0 0 auto;width:110px" :disabled="ocrRunning" :title="ocrSourceSelectTitle" @change="onOcrSourceChange">
          <option v-for="s in ocrSourceOptions" :key="s.key" :value="s.key">{{ s.label }}</option>
        </select>
        <!-- 模型：列表来自该来源，也可直接手输 -->
        <input v-model="ocrSelectedModel" list="ocr-image-model-list" class="ocr-select" :disabled="ocrRunning" :title="ocrSelectTitle" :placeholder="store.locales==='zh' ? '选择/输入模型' : 'Model'" />
        <datalist id="ocr-image-model-list">
          <option v-for="m in ocrModels" :key="m" :value="m"></option>
        </datalist>
        <button class="ocr-btn-sm" @click="fetchOcrModels()" :disabled="ocrRunning"><i class="fa fa-refresh"></i></button>
        <button class="ocr-btn-start" :disabled="!ocrSelectedModel || ocrRunning" @click="startOcr">
          <i class="fa fa-play"></i> {{ store.locales==='zh' ? '开始识别' : 'Start' }}
        </button>
      </div>
      <div class="ocr-body scoll">
        <div v-if="ocrStreamText" class="ocr-result-box">
          <pre class="ocr-text">{{ ocrStreamText }}<span v-if="ocrRunning" class="ocr-cursor">|</span></pre>
        </div>
        <div v-else style="text-align:center;padding:40px;color:var(--borderColor);">
          <i class="fa fa-font" style="font-size:36px;display:block;margin-bottom:12px;opacity:0.4;"></i>
          <div>{{ store.locales==='zh' ? '选择模型后点击「开始识别」' : 'Select a model and click Start' }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
  .viewer-root {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .image-container {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    touch-action: none; /* 防止移动端默认手势 */
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
    user-select: none;
  }
  .image-container img.image-main {
    width: 100%;
    height: 100%;
    object-fit: contain;
    transition: transform 0.1s ease;
    will-change: transform; /* 优化性能 */
    -webkit-user-drag: none;
    -khtml-user-drag: none;
    -moz-user-drag: none;
    -o-user-drag: none;
    user-drag: none;
  }

  /* === 底部状态栏（样式与 md_read / Edit_Code 一致） === */
  .view-statusbar {
    flex-shrink: 0;
    height: 24px;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 8px;
    font-size: 12px;
    color: var(--fontColor);
    background-color: var(--menuColor);
    border-top: 1px solid var(--borderColor);
    box-sizing: border-box;
    user-select: none;
    white-space: nowrap;
    overflow: hidden;
    z-index: 60;
  }
  .view-statusbar .statusbar-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    opacity: 0.85;
    flex-shrink: 0;
  }
  .view-statusbar .statusbar-item i {
    font-size: 11px;
    opacity: 0.7;
  }
  /* 覆盖全局 button{width:100%}，避免状态栏按钮被撑满整行 */
  .view-statusbar button {
    width: auto;
  }
  .view-statusbar .statusbar-btn {
    margin: 0;
    padding: 0 6px;
    width: auto;
    height: 18px;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--fontColor);
    font-size: 12px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    cursor: pointer;
    opacity: 0.85;
    transition: background-color 0.15s;
    flex-shrink: 0;
  }
  .view-statusbar .statusbar-btn:hover:not(:disabled) {
    background-color: var(--menuActiveColor);
    opacity: 1;
  }
  .view-statusbar .statusbar-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .view-statusbar .statusbar-spacer {
    flex: 1;
  }
  .view-statusbar .statusbar-sep {
    width: 1px;
    height: 14px;
    background: var(--borderColor);
    margin: 0 4px;
    opacity: 0.6;
    flex-shrink: 0;
  }
  /* 序号 / 缩放比例：可点击项 */
  .view-statusbar .statusbar-page,
  .view-statusbar .statusbar-scale {
    cursor: pointer;
    min-width: 46px;
    justify-content: center;
  }
  .view-statusbar .statusbar-page:hover,
  .view-statusbar .statusbar-scale:hover {
    background-color: var(--menuActiveColor);
    border-radius: 3px;
  }


  /* === OCR 对话框 === */
  .ocr-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }
  .ocr-dialog {
    width: 70vw;
    max-width: 800px;
    height: 70vh;
    background: var(--backgroundColor);
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 8px 32px rgba(0,0,0,0.3);
  }
  .ocr-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--borderColor);
    flex-shrink: 0;
  }
  .ocr-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--fontColor);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .ocr-toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .ocr-progress {
    font-size: 11px;
    color: #FF9800;
  }
  .ocr-btn-sm {
    padding: 4px 8px;
    border: 1px solid var(--borderColor);
    border-radius: 4px;
    background: var(--menuColor);
    color: var(--fontColor);
    cursor: pointer;
    font-size: 11px;
    display: flex;
    align-items: center;
    gap: 3px;
    white-space: nowrap;
  }
  .ocr-btn-sm:hover:not(:disabled) {
    background: var(--menuActiveColor);
    color: var(--fontActiveColor);
  }
  .ocr-btn-sm:disabled { opacity: 0.4; cursor: not-allowed; }
  .ocr-model-row {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 5px;
    border-bottom: 1px solid var(--borderColor);
    background: var(--menuColor);
    flex-shrink: 0;
  }
  .ocr-select {
    flex: 1;
    height: 28px;
    border: 1px solid var(--borderColor);
    border-radius: 4px;
    background: var(--backgroundColor);
    color: var(--fontColor);
    font-size: 12px;
    padding: 0 6px;
    margin:0px
  }
  .ocr-btn-start {
    padding: 3px 12px;
    border: 1px solid var(--fontActiveColor);
    border-radius: 4px;
    background: var(--menuColor);
    color: var(--fontActiveColor);
    cursor: pointer;
    font-size: 11px;
    display: flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
    height: 28px;
  }
  .ocr-btn-start:hover:not(:disabled) { opacity: 0.85; }
  .ocr-btn-start:disabled { opacity: 0.4; cursor: not-allowed; }
  .ocr-body {
    flex: 1;
    overflow-y: auto;
    padding: 5px;
  }
  .ocr-result-box {
    border: 1px solid var(--borderColor);
    border-radius: 6px;
    overflow: hidden;
  }
  .ocr-text {
    margin: 0;
    padding: 5px;
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--fontColor);
    overflow-y: auto;
  }
  .ocr-cursor {
    animation: ocr-blink 1s steps(1) infinite;
    color: var(--fontActiveColor);
  }
  @keyframes ocr-blink {
    50% { opacity: 0; }
  }
  
</style>