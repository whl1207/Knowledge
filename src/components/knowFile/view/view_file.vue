<script setup lang="ts">
import { usestore } from '@/store'
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { NEW_FILE_TYPES, newFileType, writeNewFileSkeleton, type NewFileTypeKey } from '@/lib/knowFile/newFileTypes'
import { FILE_SORT_ITEMS, fileTypeKey, type FileSortKey } from '@/lib/knowFile/fileSort'
import { parseSearchQuery, matchSearchTerms, searchTextTerms } from '@/lib/knowFile/itemSearch'
// 音视频扩展名判定 + ID3 封面解析（与播放器 MediaAudio.vue 共用）
import { isAudioExt, isVideoExt, extractAlbumArt } from '@/lib/knowFile/mediaMeta'
// 文件系统变更：全局单例订阅 + 目录监听租约（见 lib/knowFile/fileWatch.ts）
import { onFileSystemChanged, acquireFileWatch, releaseFileWatch } from '@/lib/knowFile/fileWatch'
import { getPlatform, hasCapability, getRuntimeKind } from '@/platform'
import { droppedFilePath } from '@/platform/droppedFile'

// 获取数据
const store = usestore()
const files = ref([]) as any
/**
 * 图片缩略图的真实地址（path → URL）。
 * 安卓上 `saf:` / 相对路径不能拼 `file:///`，要经平台 `fs.urlOf` 换成
 * Capacitor 本地服务器地址；桌面不填，继续用 file:///。
 */
const imageUrls = ref<Record<string, string>>({})

// 右键点击的文件
const selectFile = ref({}) as any

// 右键菜单的样式
const ifMenu = ref(false)
const menuPosition = reactive({
  x: 0,
  y: 0
})

// ---- 显示偏好持久化（视图模式 / 图标尺寸 / 文件名 / 宽高比；本机记住上次设置） ----
const MODE_KEY = 'fileview-mode'
const SHOW_NAME_KEY = 'fileview-show-name'
const ASPECT_KEY = 'fileview-aspect'
const SCALE_KEY = 'fileview-icon-scale'
// 图标尺寸范围（连续可调，单位 px；小于最小值即为列表视图）
const ICON_SCALE_MIN = 56
const ICON_SCALE_MAX = 220

// 显示模式：grid（图标）、list（列表）
const viewMode = ref(localStorage.getItem(MODE_KEY) === 'list' ? 'list' : 'grid')

// 是否显示文件名（默认显示；只有显式存过 '0' 才隐藏）
const showFileName = ref(localStorage.getItem(SHOW_NAME_KEY) !== '0')

// 图片宽高比模式：'portrait'(2:3 竖屏), 'landscape'(3:2 横屏), 'square'(正方形)
const savedAspect = localStorage.getItem(ASPECT_KEY)
const imageAspectRatio = ref<'square' | 'landscape' | 'portrait'>(
  savedAspect === 'landscape' || savedAspect === 'portrait' ? savedAspect : 'square'
)

// 图标尺寸（连续可调，单位 px）；读取历史值时做一次范围限制，避免脏数据导致布局异常
const savedScale = Number(localStorage.getItem(SCALE_KEY))
const iconScale = ref(
  Number.isFinite(savedScale) && savedScale > 0
    ? Math.max(ICON_SCALE_MIN, Math.min(ICON_SCALE_MAX, Math.round(savedScale)))
    : 80
)
watch(viewMode, (v) => localStorage.setItem(MODE_KEY, v))
watch(showFileName, (v) => localStorage.setItem(SHOW_NAME_KEY, v ? '1' : '0'))
watch(imageAspectRatio, (v) => localStorage.setItem(ASPECT_KEY, v))
watch(iconScale, (v) => localStorage.setItem(SCALE_KEY, String(v)))

// ---- 导航历史（后退/前进）已移到 store，供知识管理各视图共用 ----

// ---- 选中/聚焦（单选+多选） ----
const selectedPaths = ref<string[]>([])
const focusedIndex = ref(-1)
let lastClickedIndex = -1

// ---- 排序 ----
const sortKey = ref<FileSortKey>('name')
const sortDir = ref<'asc' | 'desc'>('asc')

// ---- 应用内剪贴板（复制/剪切/粘贴）：与左侧文件树 panel.vue 共用 store.fileClipboard ----
const clipboardFiles = computed(() => store.fileClipboard)

// ---- 搜索过滤 ----
// 搜索词来自顶部工具栏（explorer 里统一渲染，各全局视图共用一份）
const searchText = computed(() => store.knowQuery)

// ---- 拖放（内部移动到文件夹 / 外部文件导入） ----
const dragPaths = ref<string[]>([])
const dragOverPath = ref('')

// ---- 鼠标框选（拖动矩形选中） ----
const marqueeVisible = ref(false)
const marqueeRect = ref({ left: 0, top: 0, width: 0, height: 0 })
let marqueeStart: { x: number; y: number } | null = null
let marqueeAdditive = false
let marqueeRaf = 0
let marqueeItemRects: { path: string; rect: DOMRect }[] = []

const getData = async function () {
  // 未打开文件时回退到根目录，方便直接浏览
  const dir = store.path || store.root
  if (!dir) return
  if (!(await getPlatform().fs.isDirectory(dir))) {
    return
  }
  try {
    files.value = await getPlatform().fs.listTree(dir, 1)
  } catch (error) {
    console.error(error)
  }
}

// 获取图片地址（file:// URL）
// 路径含 # / ? / 空格 / 中文等需编码：# 会被当作 URL fragment、? 会被当作 query，导致 URL 截断加载失败
const getAddress = function (item: any) {
  const cached = imageUrls.value[item.path]
  if (cached) return cached
  const p = String(item.path || '').replace(/\\/g, '/')
  return 'file:///' + encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F')
}

/** 缩略图按 file:/// 加载失败时，按需经平台 urlOf 再解析一次（覆盖预解析上限之外的图片） */
async function resolveImageUrl(item: any) {
  if (!item?.path || imageUrls.value[item.path]) return
  if (typeof getPlatform().fs.urlOf !== 'function') return
  try {
    const url = await getPlatform().fs.urlOf?.(item.path)
    if (url) imageUrls.value = { ...imageUrls.value, [item.path]: url }
  } catch {
    /* 解析失败保留占位图标 */
  }
}

// 是否为图片文件（仅真正的文件才按图片渲染；目录永不渲染图片，避免目录被误判为图片导致 file:// 加载失败）
const isImageFile = function (item: any) {
  return item.type === 'file' && item.extension && ['.jpeg', '.jpg', '.png', '.webp', '.gif', '.bmp', '.svg'].includes(item.extension.toLowerCase())
}

// 图片缩略图地址解析：只在平台提供 urlOf（安卓）时异步换成本地服务器 URL。
// 桌面没有该能力，保持 file:///，不增加额外桥调用。
watch(files, async (list: any[]) => {
  if (typeof getPlatform().fs.urlOf !== 'function') {
    imageUrls.value = {}
    return
  }
  const images = (Array.isArray(list) ? list : []).filter((it) => isImageFile(it)).slice(0, 120)
  if (!images.length) {
    imageUrls.value = {}
    return
  }
  const next: Record<string, string> = {}
  await Promise.all(images.map(async (it: any) => {
    try {
      const url = await getPlatform().fs.urlOf?.(it.path)
      if (url) next[it.path] = url
    } catch {
      /* 单个失败不影响其它缩略图 */
    }
  }))
  imageUrls.value = next
}, { immediate: true })

// 应用内无法预览/编辑的文件（可执行/压缩包等）：双击直接用系统默认应用打开
const SYSTEM_OPEN_EXTS = ['.exe', '.msi', '.dll', '.apk', '.dmg', '.deb', '.rpm', '.iso', '.appimage', '.run', '.bin', '.flatpak', '.snap', '.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.zst']
const isSystemOpenFile = function (item: any) {
  return SYSTEM_OPEN_EXTS.includes((item.extension || '').toLowerCase())
}

// 是否为音频 / 视频文件（列表里显示封面；扩展名清单与播放器共用）
const isAudioFile = function (item: any) {
  return item.type === 'file' && isAudioExt(item.extension)
}
const isVideoFile = function (item: any) {
  return item.type === 'file' && isVideoExt(item.extension)
}
const isMediaFile = function (item: any) {
  return isAudioFile(item) || isVideoFile(item)
}

// ---- 媒体封面（音频 ID3 封面 / 视频首帧）----
// 缩略图生成（读文件、解码音频标签、解码视频帧）都比较重，因此：
//   1. 只有滚动到可见的条目才登记（IntersectionObserver）；
//   2. 并发上限 2，逐个排队生成，不阻塞首屏渲染；
//   3. 结果按路径缓存，翻页回来不再重复解析。
const mediaCovers = reactive<Record<string, string>>({}) // path -> blob URL（'' = 已尝试但无封面）
const coverObjectUrls = new Set<string>() // 需要 revoke 的 blob URL
const coverInFlight = new Set<string>()
const coverQueue: string[] = []
let coverRunning = 0
const COVER_MAX_CONCURRENT = 2
let coverObserver: IntersectionObserver | null = null
const filesContainerRef = ref<HTMLElement | null>(null)

// 从视频中截取一帧作为封面（当前窗口 webSecurity:false，可绘制 file:// 视频；
// 若解码/绘制失败——如不支持的编码或跨域受限——返回空串，列表回退到文件图标）
async function captureVideoPoster(item: any): Promise<string> {
  // 安卓 SAF 路径要换成 WebView 能加载的本地服务器 URL（getAddress 的 file:/// 只适用桌面）
  let playable = ''
  try { playable = (await getPlatform().fs.urlOf?.(item.path)) || '' } catch { playable = '' }
  const videoSrc = playable || getAddress(item)
  return new Promise((resolve) => {
    const video = document.createElement('video')
    let settled = false
    const finish = (url: string) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      video.onloadeddata = null
      video.onseeked = null
      video.onerror = null
      video.removeAttribute('src')
      video.load()
      resolve(url)
    }
    const timer = window.setTimeout(() => finish(''), 8000)
    const draw = () => {
      try {
        const w = video.videoWidth
        const h = video.videoHeight
        if (!w || !h) return finish('')
        const scale = Math.min(1, 480 / Math.max(w, h))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(w * scale))
        canvas.height = Math.max(1, Math.round(h * scale))
        const ctx = canvas.getContext('2d')
        if (!ctx) return finish('')
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        canvas.toBlob((blob) => finish(blob ? URL.createObjectURL(blob) : ''), 'image/jpeg', 0.82)
      } catch {
        finish('')
      }
    }
    video.onloadeddata = () => {
      const d = video.duration
      const t = Number.isFinite(d) && d > 0 ? Math.min(1, d / 2) : 0
      if (t > 0) {
        try {
          video.currentTime = t
          return
        } catch { /* 落到直接绘制 */ }
      }
      draw()
    }
    video.onseeked = draw
    video.onerror = () => finish('')
    video.muted = true
    video.preload = 'metadata'
    video.src = videoSrc
  })
}

// 生成单条封面（音频读 ID3 APIC；视频截首帧），失败或无封面返回 ''
async function buildMediaCover(item: any): Promise<string> {
  try {
    if (isAudioFile(item)) {
      const bytes: Uint8Array | null = await getPlatform().fs.readBinary(item.path)
      if (!bytes || !bytes.length) return ''
      return extractAlbumArt(bytes) || ''
    }
    if (isVideoFile(item)) return await captureVideoPoster(item)
  } catch { /* 读取/解析失败：回退到文件图标 */ }
  return ''
}

// 队列泵：并发受限地逐个生成封面
function pumpCoverQueue() {
  while (coverRunning < COVER_MAX_CONCURRENT && coverQueue.length) {
    const path = coverQueue.shift() as string
    if (mediaCovers[path] !== undefined || coverInFlight.has(path)) continue
    const item = files.value.find((f: any) => f.path === path)
    if (!item) continue
    coverInFlight.add(path)
    coverRunning++
    buildMediaCover(item)
      .then((url) => {
        mediaCovers[path] = url
        if (url) coverObjectUrls.add(url)
      })
      .catch(() => { mediaCovers[path] = '' })
      .finally(() => {
        coverInFlight.delete(path)
        coverRunning--
        pumpCoverQueue()
      })
  }
}

// 懒加载观察器：条目进入可视区（含 150px 预取边距）才排队生成封面
function ensureCoverObserver(): IntersectionObserver {
  if (coverObserver) return coverObserver
  coverObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const el = entry.target as HTMLElement
      coverObserver?.unobserve(el)
      const path = el.dataset.coverPath || ''
      if (!path || mediaCovers[path] !== undefined || coverInFlight.has(path) || coverQueue.includes(path)) continue
      coverQueue.push(path)
    }
    pumpCoverQueue()
  }, { root: filesContainerRef.value, rootMargin: '150px 0px' })
  return coverObserver
}

// 列表变化（换目录 / 搜索 / 切换网格列表）后重新登记待生成封面的条目
function refreshMediaCovers() {
  const container = filesContainerRef.value
  if (!container) return
  const observer = ensureCoverObserver()
  observer.disconnect()
  coverQueue.length = 0
  container.querySelectorAll<HTMLElement>('.media-thumb[data-cover-path]').forEach((el) => {
    const path = el.dataset.coverPath || ''
    if (!path || mediaCovers[path] !== undefined || coverInFlight.has(path)) return
    observer.observe(el)
  })
  pumpCoverQueue()
}

// 打开文件/文件夹（文件夹进入目录；文件按文件操作模式：新窗口 / 窗口内）
const open = async function (data: any) {
  if (data.type === 'folder') {
    store.knowEnterDir(data.path)
    return
  }
  // 系统打开类文件 / Linux 可执行文件：直接用系统默认应用打开
  if (data.executable || isSystemOpenFile(data)) {
    getPlatform().shell.openWithSystemApp(data.path)
    return
  }
  store.openFileByMode(data)
}

// ---- 导航（后退/前进/向上 + 面包屑）：导航状态与历史统一存在 store，工具栏见 ViewToolbar.vue ----
const goUp = function () { store.knowUp() }
const refresh = async function () { await getData() }

// 右键菜单溢出视口时自动调整位置，保证完全显示（参照 panel.vue）
const adjustContextMenuPosition = function (pos: { x: number; y: number }) {
  nextTick(() => {
    const menu = document.querySelector('.file-viewer .context-menu')
    if (!menu) return
    const rect = menu.getBoundingClientRect()
    const margin = 4
    let left = rect.left
    let top = rect.top
    // 底部溢出 → 向上移动
    if (rect.bottom > window.innerHeight - margin) {
      top = Math.max(margin, top - (rect.bottom - (window.innerHeight - margin)))
    }
    // 右侧溢出 → 向左移动
    if (rect.right > window.innerWidth - margin) {
      left = Math.max(margin, left - (rect.right - (window.innerWidth - margin)))
    }
    pos.x = left
    pos.y = top
  })
}

// 子菜单溢出检测：当子菜单超出视口时自动翻转展开方向（参照 md_read.vue）
// 记录当前激活的二级菜单项，避免在子菜单内部移动时反复翻转造成闪烁
let activeSubmenuItem: HTMLElement | null = null
const handleSubmenuOverflow = (e: MouseEvent) => {
  // 仅处理本模块（.file-viewer）内的二级菜单，避免影响其他模块
  const target = (e.target as HTMLElement).closest('.file-viewer .has-submenu') as HTMLElement | null
  if (!target) {
    // 移出所有二级菜单项时重置，便于下次进入重新计算
    activeSubmenuItem = null
    return
  }
  // 仅在首次进入某个二级菜单项时计算，避免在子菜单内部移动时反复翻转（闪烁）
  if (activeSubmenuItem === target) return
  activeSubmenuItem = target

  const submenu = target.querySelector(':scope > .submenu') as HTMLElement | null
  if (!submenu) return

  requestAnimationFrame(() => {
    submenu.classList.remove('submenu-up', 'submenu-left')

    const rect = submenu.getBoundingClientRect()
    const viewportW = window.innerWidth
    const viewportH = window.innerHeight

    // 底部溢出 → 向上展开：子菜单下边界与父菜单项下边界对齐（submenu-up 使用 bottom 定位）
    if (rect.bottom > viewportH) {
      submenu.classList.add('submenu-up')
    }
    // 右侧溢出 → 向左展开
    if (rect.right > viewportW) {
      submenu.classList.add('submenu-left')
    }
  })
}

// 右键菜单
const nodeContextmenu = function (event: any, item: any) {
  event.preventDefault()
  event.stopPropagation()
  // 右键未选中的项时先单选它（多选中已选中的项保持选中）
  if (!selectedPaths.value.includes(item.path)) {
    selectedPaths.value = [item.path]
    focusedIndex.value = files.value.findIndex((f: any) => f.path === item.path)
  }
  // 关闭视图菜单
  showViewMenu.value = false
  selectFile.value = item
  ifMenu.value = true
  menuPosition.x = event.clientX - 10
  menuPosition.y = event.clientY - 17
  adjustContextMenuPosition(menuPosition)
}

// 打开位置
const openInFolder = async function (data: any) {
  getPlatform().shell.revealInFolder(data.path)
}

// 获取颜色
const color = function (item: any) {
  if (item.attributes && item.attributes['颜色']) {
    return item.attributes['颜色']
  }
  return 'var(--borderColor)'
}

// 开始重命名
const startRename = async function (data: any) {
  ifMenu.value = false
  try {
    const { value: newName } = await ElMessageBox.prompt(store.locales == 'zh' ? '请输入新名称:' : 'Enter a new name:', store.locales == 'zh' ? '重命名' : 'Rename', {
      confirmButtonText: store.locales == 'zh' ? '确定' : 'OK',
      cancelButtonText: store.locales == 'zh' ? '取消' : 'Cancel',
      inputValue: data.label,
      inputPattern: /.+/,
      inputErrorMessage: store.locales == 'zh' ? '名称不能为空' : 'Name cannot be empty'
    })
    
    const trimmed = newName.trim()
    if (trimmed === data.label) return
    
    const result = await getPlatform().fs.renameFile(data.path, trimmed)
    
    if (result.success) {
      await getData()
      ElMessage.success(store.locales == 'zh' ? '重命名成功' : 'Renamed')
    } else {
      ElMessage.error((store.locales == 'zh' ? '重命名失败: ' : 'Rename failed: ') + result.error)
    }
  } catch { /* 用户取消 */ }
}

// 删除（单选/右键）：文件夹走 deleteFolder、文件走 deleteFile，并同步关闭已打开的标签页
const deleteFile = async function () {
  const item = selectFile.value
  if (!item || !item.path) return

  try {
    const isFolder = item.type === 'folder'
    await ElMessageBox.confirm(
      store.locales == 'zh'
        ? `确定要删除${isFolder ? '文件夹' : '文件'} "${item.label}" 吗？`
        : `Delete ${isFolder ? 'folder' : 'file'} "${item.label}"?`,
      store.locales == 'zh' ? '确认删除' : 'Confirm Delete',
      {
        confirmButtonText: store.locales == 'zh' ? '确定' : 'OK',
        cancelButtonText: store.locales == 'zh' ? '取消' : 'Cancel',
        type: 'warning',
      }
    )

    const result = isFolder
      ? await getPlatform().fs.deleteFolder(item.path)
      : await getPlatform().fs.deleteFile(item.path)
    // deleteFolder 返回 { success }，deleteFile 返回 boolean
    const ok = isFolder ? !!(result as { success?: boolean })?.success : !!result
    if (ok) {
      if (!isFolder) store.closeTabByPath(item.path)
      await getData()
      ElMessage.success(store.locales == 'zh' ? '删除成功' : 'Deleted')
    } else {
      ElMessage.error(store.locales == 'zh' ? '删除失败' : 'Delete failed')
    }
    ifMenu.value = false
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error(store.locales == 'zh' ? '删除失败' : 'Delete failed')
    }
    ifMenu.value = false
  }
}

// ---- 选中（单击选中、Ctrl/Shift 多选） ----
const isSelected = function (path: string) {
  return selectedPaths.value.includes(path)
}

// 安卓（触摸屏）：单击即打开文件 / 进入文件夹（与 panel.vue 文件树同一约定）
const tapOpensDirectly = getRuntimeKind() === 'android'

const onItemClick = function (e: MouseEvent, item: any, index: number) {
  // 双指缩放刚结束：浏览器随后补发的 click 不应被当成「点开文件」
  if (Date.now() < suppressClickUntil) {
    e.preventDefault()
    return
  }
  if (e.ctrlKey || e.metaKey) {
    // Ctrl：切换选中
    const i = selectedPaths.value.indexOf(item.path)
    if (i >= 0) selectedPaths.value.splice(i, 1)
    else selectedPaths.value.push(item.path)
    focusedIndex.value = index
  } else if (e.shiftKey && lastClickedIndex >= 0) {
    // Shift：范围选中
    const list = filteredFiles.value
    const a = Math.min(lastClickedIndex, index)
    const b = Math.max(lastClickedIndex, index)
    selectedPaths.value = list.slice(a, b + 1).map((x: any) => x.path)
    focusedIndex.value = index
  } else {
    selectedPaths.value = [item.path]
    focusedIndex.value = index
  }
  lastClickedIndex = index
  // 聚焦容器以启用键盘导航
  ;(e.currentTarget as HTMLElement).closest<HTMLElement>('.files-container')?.focus?.()
  // 安卓（触摸屏）：单击即打开文件 / 进入文件夹——移动端没有鼠标，双击既别扭又会被浏览器
  // 当成缩放（单击被吞），表现为「点了没反应」（见 panel.vue 同名字段）
  if (tapOpensDirectly && !e.ctrlKey && !e.metaKey && !e.shiftKey) open(item)
}

// 双击打开：文件夹进入目录，文件按模式打开
const onItemDblClick = function (item: any) {
  if (Date.now() < suppressClickUntil) return
  open(item)
}

// 点击空白处聚焦容器（启用键盘导航）
const focusContainer = function (e: MouseEvent) {
  const t = e.target as HTMLElement
  if (t.closest('.file-item') || t.closest('.list-item')) return
  if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return
  ;(e.currentTarget as HTMLElement).focus?.()
}

// 滚动聚焦项到可见
const scrollFocusedIntoView = function (index: number) {
  nextTick(() => {
    const el = document.querySelector<HTMLElement>(`[data-findex="${index}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  })
}

// 键盘导航（↑↓←→ 移动、Enter 打开、F2 重命名、Delete 删除、Backspace 上级、Ctrl+R 刷新、Ctrl+A 全选）
const containerKeydown = function (e: KeyboardEvent) {
  const t = e.target as HTMLElement
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
  if (ifMenu.value || showViewMenu.value) return
  const list = filteredFiles.value
  if (!list.length) return
  const key = e.key
  const move = (delta: number) => {
    e.preventDefault()
    let i = focusedIndex.value
    i = i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + delta))
    focusedIndex.value = i
    selectedPaths.value = [list[i].path]
    lastClickedIndex = i
    scrollFocusedIntoView(i)
  }
  if (key === 'ArrowDown' || key === 'ArrowRight') {
    move(1)
  } else if (key === 'ArrowUp' || key === 'ArrowLeft') {
    move(-1)
  } else if (key === 'Enter') {
    e.preventDefault()
    const item = list[focusedIndex.value >= 0 ? focusedIndex.value : 0]
    if (item) open(item)
  } else if (key === 'F2') {
    e.preventDefault()
    const item = list[focusedIndex.value >= 0 ? focusedIndex.value : 0]
    if (item) startRename(item)
  } else if (key === 'Delete') {
    e.preventDefault()
    deleteSelected()
  } else if (key === 'Backspace') {
    e.preventDefault()
    goUp()
  } else if ((e.ctrlKey || e.metaKey) && (key === 'c' || key === 'C')) {
    e.preventDefault()
    copySelected()
  } else if ((e.ctrlKey || e.metaKey) && (key === 'x' || key === 'X')) {
    e.preventDefault()
    cutSelected()
  } else if ((e.ctrlKey || e.metaKey) && (key === 'v' || key === 'V')) {
    e.preventDefault()
    pasteFiles()
  } else if ((e.ctrlKey || e.metaKey) && (key === 'r' || key === 'R')) {
    e.preventDefault()
    refresh()
  } else if ((e.ctrlKey || e.metaKey) && (key === 'a' || key === 'A')) {
    e.preventDefault()
    selectedPaths.value = list.map((x: any) => x.path)
  }
}

// 批量删除选中的项（键盘 Delete / 右键菜单多选删除共用）
const deleteSelected = async function () {
  if (!selectedPaths.value.length) return
  const count = selectedPaths.value.length
  try {
    await ElMessageBox.confirm(
      store.locales == 'zh' ? `确定要删除选中的 ${count} 项吗？` : `Delete ${count} selected item(s)?`,
      store.locales == 'zh' ? '确认删除' : 'Confirm Delete',
      { confirmButtonText: store.locales == 'zh' ? '确定' : 'OK', cancelButtonText: store.locales == 'zh' ? '取消' : 'Cancel', type: 'warning' }
    )
  } catch { return }
  let n = 0
  const failed: string[] = []
  for (const p of selectedPaths.value) {
    try {
      const item = files.value.find((f: any) => f.path === p)
      const isFolder = item?.type === 'folder'
      // deleteFolder 返回 { success }，deleteFile 返回 boolean
      const res = isFolder
        ? await getPlatform().fs.deleteFolder(p)
        : await getPlatform().fs.deleteFile(p)
      const ok = isFolder ? !!(res as { success?: boolean })?.success : !!res
      if (!ok) { failed.push(p); continue }
      n++
      // 删除文件时同步关闭已打开的标签页
      if (!isFolder) store.closeTabByPath(p)
    } catch (err) {
      console.error('批量删除失败:', p, err)
      failed.push(p)
    }
  }
  selectedPaths.value = []
  lastClickedIndex = -1
  focusedIndex.value = -1
  await getData()
  if (failed.length) {
    ElMessage.warning(
      store.locales == 'zh' ? `已删除 ${n} 项，${failed.length} 项失败` : `${n} deleted, ${failed.length} failed`
    )
  } else if (n) {
    ElMessage.success(store.locales == 'zh' ? '删除成功' : 'Deleted')
  }
}

// 右键菜单“删除”：多选（选中多项）时删除全部选中项；单选时删除当前项
// （右键逻辑已保证 selectFile 必属于选中集：右键未选中项时会先单选该项）
const deleteByMenu = async function () {
  if (selectedPaths.value.length > 1) {
    await deleteSelected()
  } else {
    await deleteFile()
  }
  ifMenu.value = false
}

// ---- 排序（列表列头点击） ----
const setSort = function (key: FileSortKey) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    sortDir.value = 'asc'
  }
}
const sortIcon = function (key: FileSortKey) {
  if (sortKey.value !== key) return 'fa fa-sort'
  return sortDir.value === 'asc' ? 'fa fa-sort-asc' : 'fa fa-sort-desc'
}

const sortedFiles = computed(() => {
  const arr = [...files.value]
  const dir = sortDir.value === 'asc' ? 1 : -1
  arr.sort((a: any, b: any) => {
    // 文件夹始终置顶
    const af = a.type === 'folder' ? 0 : 1
    const bf = b.type === 'folder' ? 0 : 1
    if (af !== bf) return af - bf
    let r = 0
    if (sortKey.value === 'name') {
      r = String(a.label).localeCompare(String(b.label), undefined, { numeric: true, sensitivity: 'base' })
    } else if (sortKey.value === 'mtime') {
      r = (a.mtime || 0) - (b.mtime || 0)
    } else if (sortKey.value === 'type') {
      // 按类型（扩展名）排序，同类型再按名称，避免同类型文件之间顺序随扫描结果变化
      r = fileTypeKey(a.label).localeCompare(fileTypeKey(b.label))
        || String(a.label).localeCompare(String(b.label), undefined, { numeric: true, sensitivity: 'base' })
    } else {
      r = (a.size || 0) - (b.size || 0)
    }
    return r * dir
  })
  return arr
})

// ---- YAML 属性筛选（状态等任意属性；状态栏下拉选择） ----
const ATTR_FILTER_KEY = 'fileview-attr-key'
const ATTR_FILTER_VALUE = 'fileview-attr-value'
/** 属性值未设置时使用的占位值 */
const NONE_VALUE = '__none__'
const attrFilterKey = ref(localStorage.getItem(ATTR_FILTER_KEY) || '')
const attrFilterValue = ref(localStorage.getItem(ATTR_FILTER_VALUE) || '')
watch(attrFilterKey, (v) => localStorage.setItem(ATTR_FILTER_KEY, v))
watch(attrFilterValue, (v) => localStorage.setItem(ATTR_FILTER_VALUE, v))

/** 当前目录下出现过的所有 YAML 属性名（按出现次数降序） */
const attributeKeys = computed(() => {
  const map = new Map<string, number>()
  for (const f of files.value as any[]) {
    const attrs = f?.attributes
    if (!attrs || typeof attrs !== 'object') continue
    for (const k of Object.keys(attrs)) map.set(k, (map.get(k) || 0) + 1)
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(e => e[0])
})

/** 选定属性下出现过的所有取值 */
const attributeValues = computed(() => {
  const key = attrFilterKey.value
  if (!key) return [] as string[]
  const set = new Set<string>()
  for (const f of files.value as any[]) {
    const attrs = f?.attributes
    if (!attrs || typeof attrs !== 'object') continue
    const v = attrs[key]
    if (v === undefined || v === null || v === '') continue
    set.add(String(v))
  }
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
})

/** 取某文件在选中属性下的值（未设置为 NONE_VALUE） */
const attrOf = function (f: any): string | null {
  const key = attrFilterKey.value
  if (!key) return null
  const attrs = f?.attributes
  const v = attrs && typeof attrs === 'object' ? attrs[key] : undefined
  if (v === undefined || v === null || v === '') return NONE_VALUE
  return String(v)
}

const clearAttrFilter = function () {
  attrFilterKey.value = ''
  attrFilterValue.value = ''
}

// 切换目录后属性/取值已不存在时自动清除筛选，避免看到空列表
watch([attributeKeys, attributeValues], ([keys, vals]) => {
  if (!files.value.length) return
  if (attrFilterKey.value && !keys.includes(attrFilterKey.value)) {
    clearAttrFilter()
    return
  }
  if (attrFilterValue.value && !vals.includes(attrFilterValue.value) && attrFilterValue.value !== NONE_VALUE) {
    attrFilterValue.value = ''
  }
})

// ---- 搜索过滤（文件夹内条目：文件名 / 路径 / 属性值，语法见 lib/knowFile/itemSearch.ts）与属性筛选（二者叠加） ----
const searchTerms = computed(() => parseSearchQuery(searchText.value))
const filteredFiles = computed(() => {
  let arr = sortedFiles.value
  // 属性筛选：选中属性 + 选中值时才生效
  if (attrFilterKey.value && attrFilterValue.value) {
    arr = arr.filter((f: any) => attrOf(f) === attrFilterValue.value)
  }
  const terms = searchTerms.value
  if (!terms.length) return arr
  return arr.filter((f: any) => matchSearchTerms(f, terms))
})

const escapeHtml = function (s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// 文件名高亮（匹配段加 mark；属性命中时不加亮，由搜索结果列表本身体现）
const highlightName = function (label: string) {
  const text = String(label)
  const terms = searchTextTerms(searchTerms.value)
  if (!terms.length) return escapeHtml(text)
  const lower = text.toLowerCase()
  let hit = ''
  for (const t of terms) {
    if (t && lower.includes(t.toLowerCase())) {
      hit = t
      break
    }
  }
  if (!hit) return escapeHtml(text)
  const idx = lower.indexOf(hit.toLowerCase())
  return escapeHtml(text.slice(0, idx)) +
    '<mark>' + escapeHtml(text.slice(idx, idx + hit.length)) + '</mark>' +
    escapeHtml(text.slice(idx + hit.length))
}

// ---- 复制 / 剪切 / 粘贴（应用内剪贴板，复用主进程 copyFile/moveFile） ----
const pathDirOf = function (p: string) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i >= 0 ? p.substring(0, i) : ''
}

const copySelected = function () {
  if (!selectedPaths.value.length) {
    ElMessage.warning(store.locales == 'zh' ? '请先选择文件' : 'Select files first')
    return
  }
  store.fileClipboard = { paths: [...selectedPaths.value], cut: false }
  ElMessage.success(store.locales == 'zh' ? `已复制 ${selectedPaths.value.length} 项` : `${selectedPaths.value.length} copied`)
}
const cutSelected = function () {
  if (!selectedPaths.value.length) {
    ElMessage.warning(store.locales == 'zh' ? '请先选择文件' : 'Select files first')
    return
  }
  store.fileClipboard = { paths: [...selectedPaths.value], cut: true }
  ElMessage.success(store.locales == 'zh' ? `已剪切 ${selectedPaths.value.length} 项` : `${selectedPaths.value.length} cut`)
}
const pasteFiles = async function () {
  if (!clipboardFiles.value) return
  const targetDir = store.path || store.root
  const { paths, cut } = clipboardFiles.value
  const sep = targetDir.includes('\\') ? '\\' : '/'
  const failed: string[] = []
  let n = 0
  for (const p of paths) {
    // 剪切到同目录无意义；复制到同目录由主进程自动加“_副本”
    if (cut && pathDirOf(p) === targetDir) continue
    // 防止把文件夹复制/移动到其自身或子目录内（会无限递归或改名失败）
    if (targetDir === p || targetDir.startsWith(p + sep)) {
      failed.push(p)
      continue
    }
    const res = cut
      ? await getPlatform().fs.moveFile(p, targetDir)
      : await getPlatform().fs.copyFile(p, targetDir)
    if (res && res.success) n++
    else failed.push(p)
  }
  // 剪切：仅保留失败项以便重试（成功移动的项已不存在）；复制：保留剪贴板以支持向多个目标重复粘贴
  if (cut) {
    store.fileClipboard = failed.length ? { paths: failed, cut: true } : null
  }
  await getData()
  if (failed.length) {
    ElMessage.warning(
      store.locales == 'zh'
        ? `已${cut ? '移动' : '复制'} ${n} 项，${failed.length} 项失败`
        : `${cut ? 'Moved' : 'Copied'} ${n}, ${failed.length} failed`
    )
  } else {
    ElMessage.success(cut
      ? (store.locales == 'zh' ? `已移动 ${n} 项` : `Moved ${n}`)
      : (store.locales == 'zh' ? `已复制 ${n} 项` : `Copied ${n}`))
  }
}

// ---- 拖放（拖到文件夹 → 移动；外部文件拖入 → 复制导入） ----
const onItemDragStart = function (e: DragEvent, item: any) {
  dragPaths.value = [item.path]
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    try { e.dataTransfer.setData('text/plain', item.path) } catch { /* ignore */ }
    // 拖到 Markdown 编辑器时用它插入 ![]() / []()（编辑器不认 el-tree 的内部拖拽数据）
    try { e.dataTransfer.setData('application/x-aikm-path', item.path) } catch { /* ignore */ }
  }
}
const onFolderDragOver = function (e: DragEvent, folder: any) {
  e.preventDefault()
  e.stopPropagation()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dragOverPath.value = folder.path
}
const onFolderDrop = async function (e: DragEvent, folder: any) {
  e.preventDefault()
  e.stopPropagation()
  dragOverPath.value = ''
  const srcs = [...dragPaths.value]
  dragPaths.value = []
  if (!srcs.length) return
  let n = 0
  for (const p of srcs) {
    if (p === folder.path) continue
    const res = await getPlatform().fs.moveFile(p, folder.path)
    if (res && res.success) n++
  }
  await getData()
  if (n) ElMessage.success(store.locales == 'zh' ? `已移动 ${n} 项到 ${folder.label}` : `Moved ${n} to ${folder.label}`)
}
const onContainerDrop = async function (e: DragEvent) {
  e.preventDefault()
  // 内部拖动（拖到空白）不处理
  if (dragPaths.value.length) {
    dragPaths.value = []
    return
  }
  // 外部文件拖入：复制到当前目录
  const files = e.dataTransfer?.files
  if (!files || !files.length) return
  const targetDir = store.path || store.root
  let n = 0
  let unreadable = 0
  for (const f of Array.from(files)) {
    // Electron 32 起没有 File.path：必须经 preload 的 webUtils 取真实路径
    const p = droppedFilePath(f)
    if (!p) { unreadable++; continue }
    const res = await getPlatform().fs.copyFile(p, targetDir)
    if (res && res.success) n++
  }
  if (n) {
    await getData()
    ElMessage.success(store.locales == 'zh' ? `已导入 ${n} 项` : `Imported ${n}`)
  }
  if (unreadable) {
    ElMessage.warning(store.locales == 'zh'
      ? `${unreadable} 个文件取不到磁盘路径（网页 / 虚拟文件来源），未导入`
      : `${unreadable} file(s) had no disk path (web / virtual source) and were skipped`)
  }
}
const onDragEnd = function () {
  dragPaths.value = []
  dragOverPath.value = ''
}

// ---- 鼠标框选（拖动矩形选中） ----
const boxesIntersect = function (
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number }
) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

const onContainerMouseDown = function (e: MouseEvent) {
  if (e.button !== 0) return
  const t = e.target as HTMLElement
  const container = e.currentTarget as HTMLElement
  // 文件项/列表头/空态上不启动框选（分别走点击选中 / 排序）
  if (t.closest('.file-item') || t.closest('.list-item') || t.closest('.list-header') || t.closest('.empty-folder')) return
  // 排除垂直滚动条区域（offsetX 超出内容区即落在滚动条上）
  if (t === container && e.offsetX > container.clientWidth) return

  marqueeAdditive = e.ctrlKey || e.metaKey
  marqueeStart = { x: e.clientX, y: e.clientY }
  marqueeVisible.value = true
  marqueeRect.value = { left: e.clientX, top: e.clientY, width: 0, height: 0 }

  // 预取当前所有可见文件项的位置（含索引对应路径），mousemove 时只做相交判断
  const items = container.querySelectorAll<HTMLElement>('.file-item, .list-item')
  const list = filteredFiles.value
  marqueeItemRects = Array.from(items).map(el => {
    const idx = Number(el.getAttribute('data-findex'))
    return { path: list[idx] ? list[idx].path : '', rect: el.getBoundingClientRect() }
  })

  // 非追加模式：先清空选中（点空白取消选中）
  if (!marqueeAdditive) {
    selectedPaths.value = []
    lastClickedIndex = -1
  }
  ;(e.currentTarget as HTMLElement).focus?.()

  window.addEventListener('mousemove', onMarqueeMove)
  window.addEventListener('mouseup', onMarqueeUp)
  e.preventDefault()
}

const onMarqueeMove = function (e: MouseEvent) {
  if (!marqueeStart) return
  const left = Math.min(marqueeStart.x, e.clientX)
  const top = Math.min(marqueeStart.y, e.clientY)
  const width = Math.abs(e.clientX - marqueeStart.x)
  const height = Math.abs(e.clientY - marqueeStart.y)
  marqueeRect.value = { left, top, width, height }
  if (marqueeRaf) cancelAnimationFrame(marqueeRaf)
  marqueeRaf = requestAnimationFrame(updateMarqueeSelection)
}

const updateMarqueeSelection = function () {
  marqueeRaf = 0
  const r = marqueeRect.value
  if (r.width < 3 && r.height < 3) return // 拖动过小忽略
  const box = { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height }
  const hit: string[] = []
  for (const it of marqueeItemRects) {
    if (!it.path) continue
    const rc = it.rect
    if (boxesIntersect(box, { left: rc.left, top: rc.top, right: rc.right, bottom: rc.bottom })) {
      hit.push(it.path)
    }
  }
  if (marqueeAdditive) {
    // Ctrl：追加到已有选中
    const merged = new Set(selectedPaths.value)
    for (const p of hit) merged.add(p)
    selectedPaths.value = Array.from(merged)
  } else {
    selectedPaths.value = hit
  }
}

const onMarqueeUp = function () {
  window.removeEventListener('mousemove', onMarqueeMove)
  window.removeEventListener('mouseup', onMarqueeUp)
  marqueeVisible.value = false
  marqueeStart = null
  marqueeItemRects = []
  if (marqueeRaf) { cancelAnimationFrame(marqueeRaf); marqueeRaf = 0 }
}

// 当前查看模式显示文本（状态栏提示；不显示缩放像素值，像素仅供 Ctrl+滚轮内部换算）
const viewModeLabel = computed(() => {
  if (viewMode.value === 'list') return store.locales == 'zh' ? '列表' : 'List'
  return store.locales == 'zh' ? '网格' : 'Grid'
})

// 图片宽高比显示文本（右键菜单「显示 → 宽高比」里作为当前值提示）
const aspectRatioLabel = computed(() => {
  if (imageAspectRatio.value === 'landscape') return store.locales == 'zh' ? '横屏' : 'Landscape'
  if (imageAspectRatio.value === 'portrait') return store.locales == 'zh' ? '竖屏' : 'Portrait'
  return store.locales == 'zh' ? '方形' : 'Square'
})

// 设置宽高比（右键菜单「显示 → 宽高比」：方形 / 横屏 / 竖屏）
const setAspectRatio = function (value: 'square' | 'landscape' | 'portrait') {
  imageAspectRatio.value = value
}

// Ctrl+滚轮连续缩放图标大小：最小时为列表视图，向上滚动逐级放大（无级调节）
const applyIconScale = function (next: number) {
  if (next < ICON_SCALE_MIN) {
    viewMode.value = 'list'
  } else {
    viewMode.value = 'grid'
    iconScale.value = Math.max(ICON_SCALE_MIN, Math.min(ICON_SCALE_MAX, Math.round(next)))
  }
}

const onContainerWheel = function (e: WheelEvent) {
  if (!e.ctrlKey && !e.metaKey) return
  e.preventDefault()
  // 列表视为“略小于最小图标”，向上滚即可回到最小图标网格
  const base = viewMode.value === 'list' ? ICON_SCALE_MIN - 8 : iconScale.value
  // 每格滚轮约 deltaY=100，按比例换算像素步进（8px/格），保证顺滑
  applyIconScale(base + (-e.deltaY / 100) * 8)
}

// ---- 安卓：双指缩放图标（与 Ctrl+滚轮同一套规则：低于最小值进列表，向上放大回网格） ----
let pinchActive = false
let pinchStartDist = 0
let pinchStartScale = 0
/** 双指缩放结束后短暂屏蔽 click，避免松手时顺手把文件打开 / 选中 */
let suppressClickUntil = 0

function touchDistance(touches: TouchList): number {
  if (touches.length < 2) return 0
  const a = touches[0]
  const b = touches[1]
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

function onContainerTouchStart(e: TouchEvent) {
  if (e.touches.length !== 2) return
  pinchActive = true
  pinchStartDist = touchDistance(e.touches)
  pinchStartScale = viewMode.value === 'list' ? ICON_SCALE_MIN : iconScale.value
  suppressClickUntil = Date.now() + 800
}

function onContainerTouchMove(e: TouchEvent) {
  if (!pinchActive || e.touches.length !== 2) return
  e.preventDefault()
  const dist = touchDistance(e.touches)
  if (!pinchStartDist || !dist) return
  applyIconScale(pinchStartScale * (dist / pinchStartDist))
  suppressClickUntil = Date.now() + 800
}

function onContainerTouchEnd(e: TouchEvent) {
  if (e.touches.length < 2) pinchActive = false
}

// 切换文件名显示
const toggleFileName = function () {
  showFileName.value = !showFileName.value
}

// 获取当前图片容器的样式
const getImageContainerStyle = function () {
  const baseSize = iconScale.value
  
  switch (imageAspectRatio.value) {
    case 'landscape':
      return {
        containerWidth: Math.round(baseSize * 1.5) + 'px',
        containerHeight: baseSize + 'px',
        iconFontSize: Math.round(baseSize * 0.5) + 'px'
      }
    case 'portrait':
      return {
        containerWidth: baseSize + 'px',
        containerHeight: Math.round(baseSize * 1.5) + 'px',
        iconFontSize: Math.round(baseSize * 0.5) + 'px'
      }
    default:
      return {
        containerWidth: baseSize + 'px',
        containerHeight: baseSize + 'px',
        iconFontSize: Math.round(baseSize * 0.5) + 'px'
      }
  }
}

// 获取网格的列宽
const getGridTemplateColumns = function () {
  const style = getImageContainerStyle()
  const containerWidth = parseInt(style.containerWidth)
  return `repeat(auto-fill, minmax(${containerWidth}px, 1fr))`
}

// 获取网格间距
const getGridGap = function () {
  if (iconScale.value <= 64) return '4px'
  if (iconScale.value >= 160) return '8px'
  return '5px'
}

// 获取文件名字体大小
const getFileNameFontSize = function () {
  if (iconScale.value <= 64) return '9px'
  if (iconScale.value >= 160) return '13px'
  return '10px'
}

// 获取文件名最大高度
const getFileNameMaxHeight = function () {
  if (iconScale.value <= 64) return '16px'
  if (iconScale.value >= 160) return '22px'
  return '18px'
}

// 格式化文件大小
const formatSize = function (bytes: number): string {
  if (bytes === 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let size = bytes
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++ }
  return size.toFixed(i === 0 ? 0 : 1) + ' ' + units[i]
}

// 格式化时间
const formatTime = function (ms: number): string {
  if (!ms) return '-'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ---- 悬浮提示（跟随鼠标显示文件信息） ----
const tooltipVisible = ref(false)
const tooltipPos = ref({ x: 0, y: 0 })
const tooltipData = ref<any>(null)
let tipSize = { w: 0, h: 0 }

/** 鼠标悬浮时显示提示（首次显示时测量尺寸以决定防溢出方向） */
const showTooltip = (e: MouseEvent, data: any) => {
  tooltipData.value = data
  if (!tooltipVisible.value) {
    tooltipVisible.value = true
    nextTick(() => {
      const el = document.querySelector('.file-tooltip') as HTMLElement | null
      if (el) tipSize = { w: el.offsetWidth, h: el.offsetHeight }
    })
  }
  // 跟随鼠标，超出视口时翻转方向
  let x = e.clientX + 12
  let y = e.clientY + 12
  if (tipSize.w && x + tipSize.w > window.innerWidth - 4) x = e.clientX - tipSize.w - 12
  if (tipSize.h && y + tipSize.h > window.innerHeight - 4) y = e.clientY - tipSize.h - 12
  tooltipPos.value = { x: Math.max(4, x), y: Math.max(4, y) }
}

// 提示内容变化时（如不同长度文件名）重新测量尺寸，确保防溢出方向正确
watch(tooltipData, () => {
  if (tooltipVisible.value && tooltipData.value) {
    nextTick(() => {
      const el = document.querySelector('.file-tooltip') as HTMLElement | null
      if (el) tipSize = { w: el.offsetWidth, h: el.offsetHeight }
    })
  }
})

/** 隐藏提示 */
const hideTooltip = () => {
  tooltipVisible.value = false
  tooltipData.value = null
}

// 新建文件夹
const createNewFolder = async function () {
  try {
    const { value } = await ElMessageBox.prompt(store.locales == 'zh' ? '请输入文件夹名称:' : 'Enter folder name:', store.locales == 'zh' ? '新建文件夹' : 'New Folder', {
      confirmButtonText: store.locales == 'zh' ? '确定' : 'OK',
      cancelButtonText: store.locales == 'zh' ? '取消' : 'Cancel',
      inputPattern: /.+/,
      inputErrorMessage: store.locales == 'zh' ? '名称不能为空' : 'Name cannot be empty'
    })
    const path = await getPlatform().fs.createFolder(store.path || store.root, value.trim())
    if (path) { await getData() }
  } catch { /* 用户取消 */ }
}

// 新建文件（类型见 lib/knowFile/newFileTypes.ts，与文件树右键「新建」同一份列表）
const createNewFile = async function (key: NewFileTypeKey) {
  const def = newFileType(key) || NEW_FILE_TYPES[0]
  const zh = store.locales == 'zh'
  try {
    const { value } = await ElMessageBox.prompt(zh ? '请输入文件名:' : 'Enter file name:', zh ? `新建 ${def.labelZh}` : `New ${def.labelEn}`, {
      confirmButtonText: zh ? '确定' : 'OK',
      cancelButtonText: zh ? '取消' : 'Cancel',
      inputPattern: /.+/,
      inputErrorMessage: zh ? '名称不能为空' : 'Name cannot be empty'
    })
    const path = await getPlatform().fs.createFile(store.path || store.root, value.trim() + def.ext)
    if (!path) return
    // 需要初始内容的类型先写入（draw.io 空白图表框架 / 脚手架空任务骨架 / Office 空白文档），避免留下 0 字节文件
    await writeNewFileSkeleton(path, def)
    await getData()
    // 脚手架任务：建好就进独立窗口的「脚手架」视图（与文件树右键「新建」一致，一步到位）
    if (key === 'task') store.openFileByMode({ path, type: 'file', extension: def.ext })
  } catch { /* 用户取消 */ }
}

// 视图切换右键菜单
const showViewMenu = ref(false)
const viewMenuPos = reactive({ x: 0, y: 0 })
const showViewContextMenu = function (e: MouseEvent) {
  // 如果点击的是文件项，不触发视图菜单
  const target = e.target as HTMLElement
  if (target.closest('.file-item') || target.closest('.list-item')) return
  e.preventDefault()
  // 关闭文件菜单
  ifMenu.value = false
  showViewMenu.value = true
  viewMenuPos.x = e.clientX
  viewMenuPos.y = e.clientY
  adjustContextMenuPosition(viewMenuPos)
}
const hideViewMenu = () => { showViewMenu.value = false }

// 点击其他地方关闭所有菜单
const handleDocumentClick = function () {
  ifMenu.value = false
  showViewMenu.value = false
}

watch(() => store.root, () => {
  getData()
})

// 外部修改路径（如打开文件后）时刷新列表；导航历史由工具栏同步（store.knowSyncNav）
watch(() => store.path, () => {
  getData()
})

// 顶部工具栏的「刷新」：重新拉取当前目录
watch(() => store.knowRefreshTick, () => {
  void getData()
})

// 列表内容 / 视图模式变化后，重新登记需要生成封面的音视频条目（懒加载）
watch([filteredFiles, viewMode], () => {
  nextTick(refreshMediaCovers)
})

// 文件系统变更订阅的解绑函数（全局单例：ipcRenderer 上永远只有 1 个监听）
let disposeFileWatch: (() => void) | null = null
let watchAcquired = false

onMounted(() => {
  getData()

  // 监听文件系统变化（去抖由 fileWatch 统一处理）
  disposeFileWatch = onFileSystemChanged(() => { void getData() })
  // 目录监听按租约参与：与左侧文件树共享，任一文件界面可见就保持监听
  if (store.roots?.length) {
    watchAcquired = true
    void acquireFileWatch([...store.roots])
  }

  // 点击其他地方关闭菜单
  document.addEventListener('click', handleDocumentClick)

  // 子菜单溢出检测
  document.addEventListener('mouseover', handleSubmenuOverflow)
})

onBeforeUnmount(() => {
  // 取消订阅（唯一监听本身不解绑）
  disposeFileWatch?.()
  disposeFileWatch = null
  document.removeEventListener('click', handleDocumentClick)
  document.removeEventListener('mouseover', handleSubmenuOverflow)
  // 释放目录监听租约（最后一个消费者释放后宽限 3s 才真正 stopWatching）
  if (watchAcquired) {
    watchAcquired = false
    releaseFileWatch()
  }
  // 停止封面懒加载并释放 blob URL
  coverObserver?.disconnect()
  coverObserver = null
  coverQueue.length = 0
  for (const url of coverObjectUrls) URL.revokeObjectURL(url)
  coverObjectUrls.clear()
})
</script>

<template>
  <div class="file-viewer">
    <!-- 顶部工具栏（路径面包屑 + 搜索）由 explorer.vue 统一渲染一条，见 ViewToolbar.vue -->

    <!-- 文件列表区域 -->
    <div ref="filesContainerRef" class="files-container scoll" :class="[viewMode, imageAspectRatio]" tabindex="0" @mousedown="onContainerMouseDown" @dragover.prevent @drop="onContainerDrop" @contextmenu.prevent="showViewContextMenu" @keydown="containerKeydown" @click="focusContainer" @wheel="onContainerWheel" @touchstart="onContainerTouchStart" @touchmove="onContainerTouchMove" @touchend="onContainerTouchEnd" @touchcancel="onContainerTouchEnd">
      <!-- 鼠标框选矩形（视口定位，不拦截事件） -->
      <div v-if="marqueeVisible" class="marquee-select" :style="{ left: marqueeRect.left + 'px', top: marqueeRect.top + 'px', width: marqueeRect.width + 'px', height: marqueeRect.height + 'px' }"></div>
      <!-- 网格视图 -->
      <div v-if="viewMode === 'grid'" class="files-grid" 
           :style="{ 
             gridTemplateColumns: getGridTemplateColumns(),
             gap: getGridGap() 
           }">
        <div v-for="(item, index) in filteredFiles" :key="item.path" class="file-item" :data-findex="index"
             :class="{ selected: isSelected(item.path), 'drag-over': item.type==='folder' && dragOverPath === item.path }"
             draggable="true" @dragstart="onItemDragStart($event, item)" @dragend="onDragEnd"
             @dragover="item.type==='folder' && onFolderDragOver($event, item)" @drop="item.type==='folder' && onFolderDrop($event, item)"
             @click="onItemClick($event, item, index)" @dblclick="onItemDblClick(item)" @contextmenu="nodeContextmenu($event, item)" 
             @mousemove="showTooltip($event, item)" @mouseleave="hideTooltip">
          <div class="file-content" :style="{ 
            width: getImageContainerStyle().containerWidth,
            height: getImageContainerStyle().containerHeight,
            borderColor: color(item),

          }">
            <!-- 音视频：滚动到可见时才生成封面（音频 ID3 / 视频首帧），生成前/无封面时回退文件图标 -->
            <div v-if="isMediaFile(item)" class="img media-thumb" :data-cover-path="item.path">
              <img v-if="mediaCovers[item.path]" :src="mediaCovers[item.path]" draggable="false" />
              <i v-else :class="store.icon(item.extension)" :style="{ fontSize: getImageContainerStyle().iconFontSize }"></i>
            </div>
            <template v-else>
              <i v-if="!isImageFile(item)" :class="item.executable ? 'fa fa-cogs' : store.icon(item.extension)" :style="{ 
                fontSize: getImageContainerStyle().iconFontSize 
              }"></i>
              <div v-if="isImageFile(item)" class="img">
                <img :src="getAddress(item)" loading="lazy" draggable="false" @error="resolveImageUrl(item)" />
              </div>
            </template>
          </div>
          <!-- 文件名显示 -->
          <div v-if="showFileName" class="file-title" :style="{
            fontSize: getFileNameFontSize(),
            maxHeight: getFileNameMaxHeight()
          }" v-html="highlightName(item.label)">
          </div>
        </div>
      </div>

      <!-- 列表视图 -->
      <div v-if="viewMode === 'list'" class="files-list">
        <div class="list-header">
          <span class="list-col-name" @click="setSort('name')">{{ store.locales=='zh'?'名称':'Name' }} <i :class="sortIcon('name')"></i></span>
          <span class="list-col-time" @click="setSort('mtime')">{{ store.locales=='zh'?'修改时间':'Modified' }} <i :class="sortIcon('mtime')"></i></span>
          <span class="list-col-size" @click="setSort('size')">{{ store.locales=='zh'?'大小':'Size' }} <i :class="sortIcon('size')"></i></span>
        </div>
        <div v-for="(item, index) in filteredFiles" :key="item.path" class="list-item" :data-findex="index"
             :class="{ selected: isSelected(item.path), 'drag-over': item.type==='folder' && dragOverPath === item.path }"
             draggable="true" @dragstart="onItemDragStart($event, item)" @dragend="onDragEnd"
             @dragover="item.type==='folder' && onFolderDragOver($event, item)" @drop="item.type==='folder' && onFolderDrop($event, item)"
             @click="onItemClick($event, item, index)" @dblclick="onItemDblClick(item)" @contextmenu="nodeContextmenu($event, item)" 
             @mousemove="showTooltip($event, item)" @mouseleave="hideTooltip">
          <div class="list-icon" :style="{ color: color(item) }">
            <div v-if="isMediaFile(item)" class="list-img media-thumb" :data-cover-path="item.path">
              <img v-if="mediaCovers[item.path]" :src="mediaCovers[item.path]" draggable="false" />
              <i v-else :class="store.icon(item.extension)"></i>
            </div>
            <template v-else>
              <i v-if="!isImageFile(item)" :class="item.executable ? 'fa fa-cogs' : store.icon(item.extension)"></i>
              <div v-if="isImageFile(item)" class="list-img">
                <img :src="getAddress(item)" loading="lazy" draggable="false" @error="resolveImageUrl(item)" />
              </div>
            </template>
          </div>
          <span class="list-col-name" v-html="highlightName(item.label)"></span>
          <span class="list-col-time">{{ formatTime(item.mtime) }}</span>
          <span class="list-col-size">{{ item.type === 'folder' ? '-' : formatSize(item.size) }}</span>
        </div>
      </div>

      <!-- 空文件夹提示 -->
      <div v-if="files && files.length === 0" class="empty-folder">
        <i class="fa fa-folder-open"></i>
        <p>{{ store.locales=='zh'?'文件夹为空':'Empty folder' }}</p>
      </div>
    </div>

    <!-- 状态栏：选中数 / 当前视图 / 属性筛选 / 总文件数（右下角）；文件名与宽高比在右键菜单的「显示」里 -->
    <div class="file-statusbar">
      <span v-if="selectedPaths.length" class="status-selected">
        <i class="fa fa-check-square-o"></i> {{ store.locales=='zh' ? ('已选 ' + selectedPaths.length + ' 项') : (selectedPaths.length + ' selected') }}
      </span>
      <span class="statusbar-item statusbar-mode" :title="store.locales=='zh'?'当前视图，Ctrl+滚轮切换大小':'View mode, Ctrl+wheel to resize'"><i class="fa fa-th-large"></i> {{ viewModeLabel }}</span>
      <span class="statusbar-sep"></span>
      <span class="statusbar-item" :title="store.locales=='zh'?'按 YAML 属性筛选（如状态）':'Filter by YAML attribute'"><i class="fa fa-filter"></i> {{ store.locales=='zh'?'筛选':'Filter' }}</span>
      <select class="statusbar-select" v-model="attrFilterKey" :title="store.locales=='zh'?'属性名（含状态）':'Attribute (incl. status)'">
        <option value="">{{ store.locales=='zh'?'全部属性':'All attributes' }}</option>
        <option v-for="k in attributeKeys" :key="k" :value="k">{{ k }}</option>
      </select>
      <select v-if="attrFilterKey" class="statusbar-select" v-model="attrFilterValue" :title="store.locales=='zh'?'属性值':'Attribute value'">
        <option value="">{{ store.locales=='zh'?'全部值':'All values' }}</option>
        <option v-for="v in attributeValues" :key="v" :value="v">{{ v }}</option>
        <option :value="NONE_VALUE">{{ store.locales=='zh'?'（未设置）':'(unset)' }}</option>
      </select>
      <button v-if="attrFilterKey" class="statusbar-btn" @click="clearAttrFilter" :title="store.locales=='zh'?'清除筛选':'Clear filter'"><i class="fa fa-times"></i></button>
      <span class="statusbar-item statusbar-count" :title="store.locales=='zh'?'当前目录文件数':'File count'"><i class="fa fa-file-o"></i> {{ filteredFiles.length }} {{ store.locales=='zh'?'项':'items' }}</span>
    </div>

    <!-- 悬浮提示（跟随鼠标显示文件信息） -->
    <div v-if="tooltipVisible && tooltipData" class="file-tooltip" :style="{ left: tooltipPos.x + 'px', top: tooltipPos.y + 'px' }">
      <div class="tooltip-name">{{ tooltipData.label }}</div>
      <div v-if="tooltipData.type !== 'folder' && tooltipData.size != null">{{ store.locales=='zh'?'大小':'Size' }}: {{ formatSize(tooltipData.size) }}</div>
      <div v-if="tooltipData.mtime"> {{ store.locales=='zh'?'修改时间':'Modified' }}: {{ formatTime(tooltipData.mtime) }}</div>
    </div>

    <!-- 文件右键菜单 -->
    <div v-if="ifMenu" class="context-menu" :style="{ left: menuPosition.x + 'px', top: menuPosition.y + 'px' }" @mouseleave="ifMenu = false" @click.stop>
      <div class="menu-item" @click="open(selectFile); ifMenu = false">
        <i class="fa fa-file-text-o"></i> {{ store.locales=='zh'?'打开':'Open' }}
      </div>
      <div class="menu-item" @click.stop="startRename(selectFile)">
        <i class="fa fa-pencil"></i> {{ store.locales=='zh'?'重命名':'Rename' }}
      </div>
      <div class="menu-item" @click="deleteByMenu">
        <i class="fa fa-trash-o"></i> {{ store.locales=='zh'?'删除':'Delete' }}
      </div>
      <div class="menu-item" @click="openInFolder(selectFile); ifMenu = false">
        <i class="fa fa-folder"></i> {{ store.locales=='zh'?'系统位置':'Reveal in Folder' }}
      </div>
      <div class="menu-divider"></div>
      <div class="menu-item" @click="copySelected(); ifMenu = false">
        <i class="fa fa-copy"></i> {{ store.locales=='zh'?'复制':'Copy' }}
      </div>
      <div class="menu-item" @click="cutSelected(); ifMenu = false">
        <i class="fa fa-scissors"></i> {{ store.locales=='zh'?'剪切':'Cut' }}
      </div>
      <div class="menu-item" v-if="clipboardFiles" @click="pasteFiles(); ifMenu = false">
        <i class="fa fa-paste"></i> {{ store.locales=='zh'?'粘贴':'Paste' }}
      </div>
      <!-- 排序（二级菜单，与左侧文件树 panel.vue 一致：再次点击同一项切换升降序） -->
      <div class="menu-divider"></div>
      <div class="menu-item has-submenu">
        <i class="fa fa-sort"></i>
        <span style="flex:1">{{ store.locales=='zh'?'排序':'Sort' }}</span>
        <ul class="submenu">
          <li v-for="s in FILE_SORT_ITEMS" :key="s.key" @click="setSort(s.key); ifMenu = false">
            <i :class="sortKey==s.key ? 'fa fa-check-square-o' : 'fa fa-square-o'" style="color:var(--primaryColor)"></i>
            <span style="flex:1">{{ store.locales=='zh' ? s.labelZh : s.labelEn }}</span>
            <i v-if="sortKey==s.key" :class="sortDir=='asc' ? 'fa fa-sort-amount-asc' : 'fa fa-sort-amount-desc'" style="font-size:10px;width:auto"></i>
          </li>
        </ul>
      </div>
      <!-- 显示（二级菜单）：文件名开关 / 宽高比 -->
      <div class="menu-item has-submenu">
        <i class="fa fa-eye"></i>
        <span style="flex:1">{{ store.locales=='zh'?'显示':'Display' }}</span>
        <ul class="submenu">
          <li @click="toggleFileName(); ifMenu = false">
            <i :class="showFileName ? 'fa fa-check-square-o' : 'fa fa-square-o'" style="color:var(--primaryColor)"></i>
            <span style="flex:1">{{ store.locales=='zh'?'文件名':'File Names' }}</span>
          </li>
          <li class="has-submenu">
            <i class="fa fa-picture-o"></i>
            <span style="flex:1">{{ store.locales=='zh'?'宽高比':'Aspect Ratio' }}</span>
            <span style="opacity:.6;font-size:10px">{{ aspectRatioLabel }}</span>
            <ul class="submenu">
              <li @click="setAspectRatio('square'); ifMenu = false">
                <i :class="imageAspectRatio=='square' ? 'fa fa-check-square-o' : 'fa fa-square-o'" style="color:var(--primaryColor)"></i>
                <span style="flex:1">{{ store.locales=='zh'?'方形':'Square' }}</span>
              </li>
              <li @click="setAspectRatio('landscape'); ifMenu = false">
                <i :class="imageAspectRatio=='landscape' ? 'fa fa-check-square-o' : 'fa fa-square-o'" style="color:var(--primaryColor)"></i>
                <span style="flex:1">{{ store.locales=='zh'?'横屏':'Landscape' }}</span>
              </li>
              <li @click="setAspectRatio('portrait'); ifMenu = false">
                <i :class="imageAspectRatio=='portrait' ? 'fa fa-check-square-o' : 'fa fa-square-o'" style="color:var(--primaryColor)"></i>
                <span style="flex:1">{{ store.locales=='zh'?'竖屏':'Portrait' }}</span>
              </li>
            </ul>
          </li>
        </ul>
      </div>
    </div>

    <div v-if="showViewMenu" class="context-menu" :style="{ left: viewMenuPos.x + 'px', top: viewMenuPos.y + 'px' }" @mouseleave="hideViewMenu">

      <!-- 粘贴（剪贴板有内容时显示，粘贴到当前目录） -->
      <div class="menu-item" v-if="clipboardFiles" @click="pasteFiles(); hideViewMenu()">
        <i class="fa fa-paste"></i> {{ store.locales=='zh'?'粘贴':'Paste' }}
      </div>
      <div class="menu-divider" v-if="clipboardFiles"></div>
      <!-- 新建（二级菜单）：文件夹 / Markdown / Excalidraw / 工作流 -->
      <div class="menu-item has-submenu">
        <i class="fa fa-plus-circle"></i>
        <span style="flex:1">{{ store.locales=='zh'?'新建':'New' }}</span>
        <ul class="submenu">
          <li @click="createNewFolder(); hideViewMenu()">
            <i class="fa fa-folder"></i> {{ store.locales=='zh'?'文件夹':'Folder' }}
          </li>
          <li v-for="t in NEW_FILE_TYPES" :key="t.key" @click="createNewFile(t.key); hideViewMenu()">
            <i :class="t.icon"></i> {{ store.locales=='zh' ? t.labelZh : t.labelEn }}
          </li>
        </ul>
      </div>
      <div class="menu-divider"></div>
      <!-- 排序（二级菜单，与左侧文件树 panel.vue 一致：再次点击同一项切换升降序） -->
      <div class="menu-item has-submenu">
        <i class="fa fa-sort"></i>
        <span style="flex:1">{{ store.locales=='zh'?'排序':'Sort' }}</span>
        <ul class="submenu">
          <li v-for="s in FILE_SORT_ITEMS" :key="s.key" @click="setSort(s.key); hideViewMenu()">
            <i :class="sortKey==s.key ? 'fa fa-check-square-o' : 'fa fa-square-o'" style="color:var(--primaryColor)"></i>
            <span style="flex:1">{{ store.locales=='zh' ? s.labelZh : s.labelEn }}</span>
            <i v-if="sortKey==s.key" :class="sortDir=='asc' ? 'fa fa-sort-amount-asc' : 'fa fa-sort-amount-desc'" style="font-size:10px;width:auto"></i>
          </li>
        </ul>
      </div>
      <!-- 显示（二级菜单）：文件名开关 / 宽高比 -->
      <div class="menu-item has-submenu">
        <i class="fa fa-eye"></i>
        <span style="flex:1">{{ store.locales=='zh'?'显示':'Display' }}</span>
        <ul class="submenu">
          <li @click="toggleFileName(); hideViewMenu()">
            <i :class="showFileName ? 'fa fa-check-square-o' : 'fa fa-square-o'" style="color:var(--primaryColor)"></i>
            <span style="flex:1">{{ store.locales=='zh'?'文件名':'File Names' }}</span>
          </li>
          <li class="has-submenu">
            <i class="fa fa-picture-o"></i>
            <span style="flex:1">{{ store.locales=='zh'?'宽高比':'Aspect Ratio' }}</span>
            <span style="opacity:.6;font-size:10px">{{ aspectRatioLabel }}</span>
            <ul class="submenu">
              <li @click="setAspectRatio('square'); hideViewMenu()">
                <i :class="imageAspectRatio=='square' ? 'fa fa-check-square-o' : 'fa fa-square-o'" style="color:var(--primaryColor)"></i>
                <span style="flex:1">{{ store.locales=='zh'?'方形':'Square' }}</span>
              </li>
              <li @click="setAspectRatio('landscape'); hideViewMenu()">
                <i :class="imageAspectRatio=='landscape' ? 'fa fa-check-square-o' : 'fa fa-square-o'" style="color:var(--primaryColor)"></i>
                <span style="flex:1">{{ store.locales=='zh'?'横屏':'Landscape' }}</span>
              </li>
              <li @click="setAspectRatio('portrait'); hideViewMenu()">
                <i :class="imageAspectRatio=='portrait' ? 'fa fa-check-square-o' : 'fa fa-square-o'" style="color:var(--primaryColor)"></i>
                <span style="flex:1">{{ store.locales=='zh'?'竖屏':'Portrait' }}</span>
              </li>
            </ul>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.file-viewer {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--backgroundColor);
  overflow: hidden;
  border-right: 1px solid var(--borderColor);
}

/* 文件容器 */
.files-container {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 2px;
  background: var(--backgroundColor);
  /* 双指缩放交给 JS（与 Ctrl+滚轮同一套图标缩放）；只保留单指纵向滚动，
     同时禁掉浏览器自己的页面缩放 / 双击放大 */
  touch-action: pan-y;
}

/* 网格视图 */
.files-grid {
  display: grid;
  align-items: start;
  justify-items: center;
  width: 100%;
}

/* 通用文件项样式 */
.files-grid .file-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  cursor: pointer;
  transition: transform 0.2s;
  width: 100%;
  box-sizing: border-box;
  padding: 1px;
}

.files-grid .file-item:hover {
  transform: translateY(-1px);
}

.files-grid .file-content {
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--menuColor);
  overflow: hidden;
  transition: border-color 0.2s;
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

.files-grid .img {
  width: 100%;
  height: 100%;
}

/* 媒体封面（音频/视频）：回退图标在容器内居中 */
.files-grid .img.media-thumb {
  display: flex;
  align-items: center;
  justify-content: center;
}

.files-grid .img img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.files-container.landscape .img img,
.files-container.portrait .img img {
  object-fit: cover;
}

/* 文件名样式 */
.files-grid .file-title {
  width: 100%;
  text-align: center;
  color: var(--fontColor);
  margin-top: 2px;
  box-sizing: border-box;
  line-height: 1.2;
  padding: 0 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 列表视图 */
.files-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 0;
}

.list-header {
  display: flex;
  align-items: center;
  padding: 4px 6px;
  gap: 10px;
  font-size: 11px;
  color: var(--borderColor);
  border-bottom: 1px solid var(--borderColor);
  user-select: none;
}

.list-col-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.list-col-time { width: 150px; flex-shrink: 0; text-align: left; }
.list-col-size { width: 80px; flex-shrink: 0; text-align: right; }

.files-list .list-item {
  display: flex;
  align-items: center;
  padding: 4px 6px;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s;
  gap: 10px;
}

.files-list .list-item:hover {
  background: var(--menuActiveColor);
}

.files-list .list-icon {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.files-list .list-icon i {
  font-size: 16px;
}

.files-list .list-img {
  width: 28px;
  height: 28px;
}

/* 媒体封面（音频/视频）：回退图标在容器内居中 */
.files-list .list-img.media-thumb {
  display: flex;
  align-items: center;
  justify-content: center;
}

.files-list .list-img img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

/* 空文件夹提示 */
.empty-folder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--fontSecondaryColor);
  gap: 8px;
}

.empty-folder i {
  font-size: 36px;
  opacity: 0.5;
}

.empty-folder p {
  font-size: 12px;
  opacity: 0.7;
}

/* 悬浮提示（跟随鼠标显示文件信息） */
.file-tooltip {
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
  max-width: calc(60vw / var(--ui-zoom, 1));
}

/* 文件名：过长时换行显示，避免超出视口 */
.tooltip-name {
  white-space: normal;
  word-break: break-all;
  font-weight: bold;
  color: var(--fontColor);
}

/* 二级菜单内的分隔线 */
.submenu li.menu-divider {
  display: block;
  height: 1px;
  background: var(--borderColor);
  margin: 4px 8px;
  padding: 0;
  flex: none;
}

/* ---- 工具栏与面包屑：见 ViewToolbar.vue（各全局视图共用，样式只维护一份） ---- */

/* ---- 选中态 ---- */
.files-grid .file-item.selected .file-content {
  border-color: var(--fontActiveColor);
  box-shadow: 0 0 0 1px var(--fontActiveColor);
}
.files-grid .file-item.selected .file-title { color: var(--fontActiveColor); }
.files-list .list-item.selected {
  background: color-mix(in srgb, var(--menuActiveColor) 60%, transparent);
  border-color: var(--fontActiveColor);
}
.files-container:focus { outline: none; }

/* ---- 搜索匹配高亮（搜索框本身在 ViewToolbar.vue） ---- */
.file-title mark,
.list-col-name mark {
  background: color-mix(in srgb, var(--fontActiveColor) 45%, transparent);
  color: var(--fontColor);
  border-radius: 2px;
}

/* ---- 拖放目标高亮 ---- */
.file-item.drag-over .file-content,
.list-item.drag-over {
  border-color: var(--fontActiveColor);
  box-shadow: 0 0 0 1px var(--fontActiveColor);
}

/* ---- 状态栏 ---- */
.file-statusbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 8px;
  border-top: 1px solid var(--borderColor);
  background: var(--menuColor);
  font-size: 11px;
  color: var(--fontColor);
  flex-shrink: 0;
  user-select: none;
  overflow: hidden;
}
.file-statusbar .statusbar-sep {
  width: 1px;
  height: 14px;
  background: var(--borderColor);
  flex-shrink: 0;
}
.file-statusbar .statusbar-select {
  height: 18px;
  border: 1px solid var(--borderColor);
  border-radius: 3px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 11px;
  padding: 0 4px;
  width: auto;
  min-width: 64px;
  max-width: 130px;
  outline: none;
  cursor: pointer;
  flex-shrink: 0;
  margin: 0px;
}
.file-statusbar .statusbar-select option {
  background: var(--menuColor);
  color: var(--fontColor);
}
.file-statusbar i { font-size: 11px; }
.file-statusbar .statusbar-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  opacity: 0.85;
}
.file-statusbar .statusbar-btn {
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
  cursor: pointer;
  opacity: 0.85;
  transition: background-color 0.15s;
  flex-shrink: 0;
}
.file-statusbar .statusbar-btn:hover {
  background-color: var(--menuActiveColor);
  opacity: 1;
}
.file-statusbar .statusbar-btn.active {
  color: var(--fontActiveColor);
  opacity: 1;
}
.file-statusbar .status-selected { color: var(--fontActiveColor); }
.file-statusbar .statusbar-count {
  margin-left: auto;
  opacity: 0.7;
  flex-shrink: 0;
}

/* ---- 鼠标框选矩形 ---- */
.marquee-select {
  position: fixed;
  z-index: 9999;
  background: color-mix(in srgb, var(--fontActiveColor) 15%, transparent);
  border: 1px solid var(--fontActiveColor);
  pointer-events: none;
}

</style>