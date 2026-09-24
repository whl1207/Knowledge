<script setup lang="ts">
import { usestore } from '@/store'
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { newDrawioXml } from '@/shared/drawioFile'

// 获取数据
const store = usestore()
const files = ref([]) as any

// 右键点击的文件
const selectFile = ref({}) as any

// 右键菜单的样式
const ifMenu = ref(false)
const menuPosition = reactive({
  x: 0,
  y: 0
})

// 显示模式：grid（图标）、list（列表）
const viewMode = ref('grid')

// 是否显示文件名
const showFileName = ref(true)

// 图片宽高比模式：'portrait'(2:3 竖屏), 'landscape'(3:2 横屏), 'square'(正方形)
const imageAspectRatio = ref('square')

// 图标尺寸（连续可调，单位 px；最小时为列表视图）
const iconScale = ref(80)

// ---- 导航历史（后退/前进） ----
const navStack = ref<string[]>([])
const navIndex = ref(-1)

// ---- 选中/聚焦（单选+多选） ----
const selectedPaths = ref<string[]>([])
const focusedIndex = ref(-1)
let lastClickedIndex = -1

// ---- 排序 ----
const sortKey = ref<'name' | 'mtime' | 'size'>('name')
const sortDir = ref<'asc' | 'desc'>('asc')

// ---- 应用内剪贴板（复制/剪切/粘贴） ----
const clipboardFiles = ref<{ paths: string[]; cut: boolean } | null>(null)

// ---- 搜索过滤 ----
const searchText = ref('')

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

// 文件变化监听定时器
let fileChangeTimer: NodeJS.Timeout | null = null

const getData = async function () {
  // 未打开文件时回退到根目录，方便直接浏览
  const dir = store.path || store.root
  if (!dir) return
  if (!(await window.ipcRenderer.invoke('isDirectory', dir))) {
    return
  }
  try {
    files.value = await window.ipcRenderer.invoke('getFiles', dir, 1)
  } catch (error) {
    console.error(error)
  }
}

// 获取图片地址（file:// URL）
// 路径含 # / ? / 空格 / 中文等需编码：# 会被当作 URL fragment、? 会被当作 query，导致 URL 截断加载失败
const getAddress = function (item: any) {
  const p = String(item.path || '').replace(/\\/g, '/')
  return 'file:///' + encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F')
}

// 是否为图片文件（仅真正的文件才按图片渲染；目录永不渲染图片，避免目录被误判为图片导致 file:// 加载失败）
const isImageFile = function (item: any) {
  return item.type === 'file' && item.extension && ['.jpeg', '.jpg', '.png', '.webp', '.gif', '.bmp', '.svg'].includes(item.extension.toLowerCase())
}

// 应用内无法预览/编辑的文件（可执行/压缩包等）：双击直接用系统默认应用打开
const SYSTEM_OPEN_EXTS = ['.exe', '.msi', '.dll', '.apk', '.dmg', '.deb', '.rpm', '.iso', '.appimage', '.run', '.bin', '.flatpak', '.snap', '.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.zst']
const isSystemOpenFile = function (item: any) {
  return SYSTEM_OPEN_EXTS.includes((item.extension || '').toLowerCase())
}

// 打开文件/文件夹（文件夹进入目录；文件按文件操作模式：新窗口 / 窗口内）
const open = async function (data: any) {
  if (data.type === 'folder') {
    enterDir(data.path)
    return
  }
  // 系统打开类文件 / Linux 可执行文件：直接用系统默认应用打开
  if (data.executable || isSystemOpenFile(data)) {
    window.ipcRenderer.invoke('openWithSystemApp', data.path)
    return
  }
  store.openFileByMode(data)
}

// ---- 导航（后退/前进/向上 + 面包屑） ----
const canBack = computed(() => navIndex.value > 0)
const canForward = computed(() => navIndex.value < navStack.value.length - 1)

// 跨平台取父目录（Windows 盘符根 / Linux 根正确归位，返回父目录或空串）
const parentPathOf = function (p: string): string {
  if (!p) return ''
  const sep = p.includes('\\') ? '\\' : '/'
  const trimmed = p.replace(/[\\/]+$/, '')
  if (!trimmed) return ''
  const i = trimmed.lastIndexOf(sep)
  if (i <= 0) {
    if (sep === '/' && trimmed.startsWith('/')) return '/'
    return ''
  }
  return trimmed.substring(0, i)
}

const canUp = computed(() => {
  const p = store.path || store.root
  if (!p) return false
  const parent = parentPathOf(p)
  return !!parent && parent !== p
})

// 进入目录（记录导航历史；栈当前位置始终等于 store.path，back/forward 即栈指针移动）
const enterDir = function (dir: string) {
  if (!dir || dir === store.path) return
  navStack.value = navStack.value.slice(0, navIndex.value + 1)
  navStack.value.push(dir)
  navIndex.value = navStack.value.length - 1
  store.path = dir
}

const goBack = function () {
  if (!canBack.value) return
  navIndex.value--
  store.path = navStack.value[navIndex.value]
}
const goForward = function () {
  if (!canForward.value) return
  navIndex.value++
  store.path = navStack.value[navIndex.value]
}
const goUp = function () {
  const p = store.path || store.root
  if (!p) return
  const parent = parentPathOf(p)
  if (parent && parent !== p) enterDir(parent)
}
const refresh = async function () { await getData() }

// 面包屑（按路径层级拆分，可点击跳转）
const crumbs = computed(() => {
  const p = store.path || store.root
  if (!p) return []
  const sep = p.includes('\\') ? '\\' : '/'
  const isRootAbs = p.startsWith('/')
  const parts = p.split(sep).filter(Boolean)
  const arr: { label: string; path: string }[] = []
  let acc = ''
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    acc = acc ? acc + sep + part : (isRootAbs ? '/' + part + sep : part + sep)
    arr.push({ label: part, path: acc })
  }
  return arr
})

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
  window.ipcRenderer.invoke('openInFolder', data.path)
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
    
    const result = await window.ipcRenderer.invoke('renameFile', data.path, trimmed)
    
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
      ? await window.ipcRenderer.invoke('deleteFolder', item.path)
      : await window.ipcRenderer.invoke('deleteFile', item.path)
    // deleteFolder 返回 { success }，deleteFile 返回 boolean
    const ok = isFolder ? !!(result && result.success) : !!result
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

const onItemClick = function (e: MouseEvent, item: any, index: number) {
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
}

// 双击打开：文件夹进入目录，文件按模式打开
const onItemDblClick = function (item: any) {
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
        ? await window.ipcRenderer.invoke('deleteFolder', p)
        : await window.ipcRenderer.invoke('deleteFile', p)
      const ok = isFolder ? !!(res && res.success) : !!res
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
const setSort = function (key: 'name' | 'mtime' | 'size') {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    sortDir.value = 'asc'
  }
}
const sortIcon = function (key: 'name' | 'mtime' | 'size') {
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
    } else {
      r = (a.size || 0) - (b.size || 0)
    }
    return r * dir
  })
  return arr
})

// ---- 搜索过滤（按文件名实时过滤 + 高亮） ----
const filteredFiles = computed(() => {
  const q = searchText.value.trim().toLowerCase()
  if (!q) return sortedFiles.value
  return sortedFiles.value.filter((f: any) => String(f.label).toLowerCase().includes(q))
})

const escapeHtml = function (s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// 文件名高亮（匹配段加 mark）
const highlightName = function (label: string) {
  const text = String(label)
  const q = searchText.value.trim()
  if (!q) return escapeHtml(text)
  const idx = text.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return escapeHtml(text)
  return escapeHtml(text.slice(0, idx)) +
    '<mark>' + escapeHtml(text.slice(idx, idx + q.length)) + '</mark>' +
    escapeHtml(text.slice(idx + q.length))
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
  clipboardFiles.value = { paths: [...selectedPaths.value], cut: false }
  ElMessage.success(store.locales == 'zh' ? `已复制 ${selectedPaths.value.length} 项` : `${selectedPaths.value.length} copied`)
}
const cutSelected = function () {
  if (!selectedPaths.value.length) {
    ElMessage.warning(store.locales == 'zh' ? '请先选择文件' : 'Select files first')
    return
  }
  clipboardFiles.value = { paths: [...selectedPaths.value], cut: true }
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
      ? await window.ipcRenderer.invoke('moveFile', p, targetDir)
      : await window.ipcRenderer.invoke('copyFile', p, targetDir)
    if (res && res.success) n++
    else failed.push(p)
  }
  // 剪切：仅保留失败项以便重试（成功移动的项已不存在）；复制：保留剪贴板以支持向多个目标重复粘贴
  if (cut) {
    clipboardFiles.value = failed.length ? { paths: failed, cut: true } : null
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
    const res = await window.ipcRenderer.invoke('moveFile', p, folder.path)
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
  for (const f of Array.from(files)) {
    const p = (f as any).path
    if (!p) continue
    const res = await window.ipcRenderer.invoke('copyFile', p, targetDir)
    if (res && res.success) n++
  }
  if (n) {
    await getData()
    ElMessage.success(store.locales == 'zh' ? `已导入 ${n} 项` : `Imported ${n}`)
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

// 处理文件系统变化
const handleFileSystemChange = async (event: any, data: any) => {
  // 防抖：延迟刷新，避免频繁刷新
  if (fileChangeTimer) {
    clearTimeout(fileChangeTimer)
  }
  fileChangeTimer = setTimeout(async () => {
    await getData()
    fileChangeTimer = null
  }, 500)
}

// 当前查看模式显示文本（状态栏提示；网格模式显示实际像素便于感知连续缩放）
const viewModeLabel = computed(() => {
  if (viewMode.value === 'list') return store.locales == 'zh' ? '列表' : 'List'
  return Math.round(iconScale.value) + 'px'
})

// 图片宽高比显示文本（状态栏）
const aspectRatioLabel = computed(() => {
  if (imageAspectRatio.value === 'landscape') return store.locales == 'zh' ? '横屏' : 'Landscape'
  if (imageAspectRatio.value === 'portrait') return store.locales == 'zh' ? '竖屏' : 'Portrait'
  return store.locales == 'zh' ? '方形' : 'Square'
})

// 循环切换宽高比（方形 → 横屏 → 竖屏）
const cycleAspectRatio = function () {
  const order = ['square', 'landscape', 'portrait']
  const i = order.indexOf(imageAspectRatio.value)
  imageAspectRatio.value = order[(i + 1) % order.length] as 'square' | 'landscape' | 'portrait'
}

// Ctrl+滚轮连续缩放图标大小：最小时为列表视图，向上滚动逐级放大（无级调节）
const ICON_SCALE_MIN = 56
const ICON_SCALE_MAX = 220
const onContainerWheel = function (e: WheelEvent) {
  if (!e.ctrlKey && !e.metaKey) return
  e.preventDefault()
  // 列表视为“略小于最小图标”，向上滚即可回到最小图标网格
  let s = viewMode.value === 'list' ? ICON_SCALE_MIN - 8 : iconScale.value
  // 每格滚轮约 deltaY=100，按比例换算像素步进（8px/格），保证顺滑
  s += -e.deltaY / 100 * 8
  if (s < ICON_SCALE_MIN) {
    viewMode.value = 'list'
  } else {
    viewMode.value = 'grid'
    iconScale.value = Math.max(ICON_SCALE_MIN, Math.min(ICON_SCALE_MAX, Math.round(s)))
  }
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
    const path = await window.ipcRenderer.invoke('createFolder', store.path || store.root, value.trim())
    if (path) { await getData() }
  } catch { /* 用户取消 */ }
}

// 新建 Markdown 文件
const createNewMd = async function () {
  try {
    const { value } = await ElMessageBox.prompt(store.locales == 'zh' ? '请输入文件名:' : 'Enter file name:', store.locales == 'zh' ? '新建 Markdown 文件' : 'New Markdown File', {
      confirmButtonText: store.locales == 'zh' ? '确定' : 'OK',
      cancelButtonText: store.locales == 'zh' ? '取消' : 'Cancel',
      inputPattern: /.+/,
      inputErrorMessage: store.locales == 'zh' ? '名称不能为空' : 'Name cannot be empty'
    })
    const path = await window.ipcRenderer.invoke('createFile', store.path || store.root, value.trim() + '.md')
    if (path) { await getData() }
  } catch { /* 用户取消 */ }
}

// 新建 Excalidraw 文件
const createNewExcalidraw = async function () {
  try {
    const { value } = await ElMessageBox.prompt(store.locales == 'zh' ? '请输入文件名:' : 'Enter file name:', store.locales == 'zh' ? '新建 Excalidraw 文件' : 'New Excalidraw File', {
      confirmButtonText: store.locales == 'zh' ? '确定' : 'OK',
      cancelButtonText: store.locales == 'zh' ? '取消' : 'Cancel',
      inputPattern: /.+/,
      inputErrorMessage: store.locales == 'zh' ? '名称不能为空' : 'Name cannot be empty'
    })
    const path = await window.ipcRenderer.invoke('createFile', store.path || store.root, value.trim() + '.excalidraw')
    if (path) { await getData() }
  } catch { /* 用户取消 */ }
}

// 新建 draw.io 图表文件
const createNewDrawio = async function () {
  try {
    const { value } = await ElMessageBox.prompt(store.locales == 'zh' ? '请输入文件名:' : 'Enter file name:', store.locales == 'zh' ? '新建 draw.io 图表' : 'New draw.io Diagram', {
      confirmButtonText: store.locales == 'zh' ? '确定' : 'OK',
      cancelButtonText: store.locales == 'zh' ? '取消' : 'Cancel',
      inputPattern: /.+/,
      inputErrorMessage: store.locales == 'zh' ? '名称不能为空' : 'Name cannot be empty'
    })
    const path = await window.ipcRenderer.invoke('createFile', store.path || store.root, value.trim() + '.drawio')
    // 写入空白图表框架，避免留下 0 字节文件
    if (path) {
      try { await window.ipcRenderer.invoke('saveFile', path, newDrawioXml()) } catch { /* ignore */ }
      await getData()
    }
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

// 外部修改路径（如打开文件后）时，导航历史重置到当前位置
watch(() => store.path, (nv) => {
  if (navStack.value[navIndex.value] !== nv) {
    navStack.value = [nv]
    navIndex.value = 0
  }
  getData()
})

onMounted(() => {
  getData()
  
  // 监听文件系统变化
  window.ipcRenderer.on('fileSystemChanged', handleFileSystemChange)
  
  // 点击其他地方关闭菜单
  document.addEventListener('click', handleDocumentClick)

  // 子菜单溢出检测
  document.addEventListener('mouseover', handleSubmenuOverflow)
})

onBeforeUnmount(() => {
  // 移除事件监听
  window.ipcRenderer.off('fileSystemChanged', handleFileSystemChange)
  document.removeEventListener('click', handleDocumentClick)
  document.removeEventListener('mouseover', handleSubmenuOverflow)
  
  // 清理定时器
  if (fileChangeTimer) {
    clearTimeout(fileChangeTimer)
    fileChangeTimer = null
  }
})
</script>

<template>
  <div class="file-viewer">
    <!-- 工具栏：后退/前进/向上/刷新 + 面包屑 -->
    <div class="file-toolbar">
      <div class="file-nav-btns">
        <button class="toolbar-btn" :disabled="!canBack" @click="goBack" :title="store.locales=='zh'?'后退 (Alt+←)':'Back (Alt+←)'"><i class="fa fa-arrow-left"></i></button>
        <button class="toolbar-btn" :disabled="!canForward" @click="goForward" :title="store.locales=='zh'?'前进 (Alt+→)':'Forward (Alt+→)'"><i class="fa fa-arrow-right"></i></button>
        <button class="toolbar-btn" :disabled="!canUp" @click="goUp" :title="store.locales=='zh'?'向上 (Backspace)':'Up (Backspace)'"><i class="fa fa-arrow-up"></i></button>
        <button class="toolbar-btn" @click="refresh" :title="store.locales=='zh'?'刷新 (Ctrl+R)':'Refresh (Ctrl+R)'"><i class="fa fa-refresh"></i></button>
      </div>
      <div class="file-breadcrumb" :title="store.path || store.root">
        <template v-for="(c, i) in crumbs" :key="c.path">
          <span class="crumb" :class="{ active: i === crumbs.length - 1 }" @click="enterDir(c.path)">{{ c.label }}</span>
          <i v-if="i < crumbs.length - 1" class="fa fa-chevron-right crumb-sep"></i>
        </template>
      </div>
      <div class="file-search" @click.stop :title="store.locales=='zh'?'搜索当前目录文件':'Search current folder'">
        <i class="fa fa-search"></i>
        <input v-model="searchText" class="file-search-input" :placeholder="store.locales=='zh'?'搜索文件…':'Search…'" @keydown.stop @keyup.esc="searchText=''" />
      </div>
    </div>

    <!-- 文件列表区域 -->
    <div class="files-container scoll" :class="[viewMode, imageAspectRatio]" tabindex="0" @mousedown="onContainerMouseDown" @dragover.prevent @drop="onContainerDrop" @contextmenu.prevent="showViewContextMenu" @keydown="containerKeydown" @click="focusContainer" @wheel="onContainerWheel">
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
            <i v-if="!isImageFile(item)" :class="item.executable ? 'fa fa-cogs' : store.icon(item.extension)" :style="{ 
              fontSize: getImageContainerStyle().iconFontSize 
            }"></i>
            <div v-if="isImageFile(item)" class="img">
              <img :src="getAddress(item)" loading="lazy" draggable="false" />
            </div>
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
            <i v-if="!isImageFile(item)" :class="item.executable ? 'fa fa-cogs' : store.icon(item.extension)"></i>
            <div v-if="isImageFile(item)" class="list-img">
              <img :src="getAddress(item)" loading="lazy" draggable="false" />
            </div>
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

    <!-- 状态栏：选中数 / 当前视图 / 文件名开关 / 宽高比 / 总文件数（右下角） -->
    <div class="file-statusbar">
      <span v-if="selectedPaths.length" class="status-selected">
        <i class="fa fa-check-square-o"></i> {{ store.locales=='zh' ? ('已选 ' + selectedPaths.length + ' 项') : (selectedPaths.length + ' selected') }}
      </span>
      <span class="statusbar-item statusbar-mode" :title="store.locales=='zh'?'当前视图，Ctrl+滚轮切换大小':'View mode, Ctrl+wheel to resize'"><i class="fa fa-th-large"></i> {{ viewModeLabel }}</span>
      <button class="statusbar-btn" :class="{ active: showFileName }" @click="toggleFileName" :title="store.locales=='zh'?'显示文件名':'Show file names'">
        <i class="fa fa-i-cursor"></i>&nbsp;{{ store.locales=='zh'?'文件名':'File Names' }}
      </button>
      <button class="statusbar-btn" @click="cycleAspectRatio" :title="store.locales=='zh'?'宽高比，点击切换':'Aspect ratio, click to switch'">
        <i class="fa fa-picture-o"></i>&nbsp;{{ aspectRatioLabel }}
      </button>
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
    </div>

    <div v-if="showViewMenu" class="context-menu" :style="{ left: viewMenuPos.x + 'px', top: viewMenuPos.y + 'px' }" @mouseleave="hideViewMenu">

      <!-- 粘贴（剪贴板有内容时显示，粘贴到当前目录） -->
      <div class="menu-item" v-if="clipboardFiles" @click="pasteFiles(); hideViewMenu()">
        <i class="fa fa-paste"></i> {{ store.locales=='zh'?'粘贴':'Paste' }}
      </div>
      <div class="menu-divider" v-if="clipboardFiles"></div>
      <!-- 新建（二级菜单）：文件夹 / Markdown / Excalidraw -->
      <div class="menu-item has-submenu">
        <i class="fa fa-plus-circle"></i>
        <span style="flex:1">{{ store.locales=='zh'?'新建':'New' }}</span>
        <ul class="submenu">
          <li @click="createNewFolder(); hideViewMenu()">
            <i class="fa fa-folder"></i> {{ store.locales=='zh'?'文件夹':'Folder' }}
          </li>
          <li @click="createNewMd(); hideViewMenu()">
            <i class="fa fa-file-text-o"></i> Markdown
          </li>
          <li @click="createNewExcalidraw(); hideViewMenu()">
            <i class="fa fa-paint-brush"></i> Excalidraw
          </li>
          <li @click="createNewDrawio(); hideViewMenu()">
            <i class="fa fa-object-group"></i> draw.io
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
  max-width: 60vw;
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

/* ---- 工具栏与面包屑 ---- */
.file-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
  flex-shrink: 0;
  user-select: none;
}
.file-nav-btns {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}
.toolbar-btn {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--fontColor);
  cursor: pointer;
  font-size: 13px;
  transition: background 0.15s;
}
.toolbar-btn:hover:not(:disabled) { background: var(--menuActiveColor); }
.toolbar-btn:disabled { opacity: 0.35; cursor: default; }
.file-breadcrumb {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  overflow-x: auto;
  white-space: nowrap;
  font-size: 12px;
  color: var(--fontColor);
  scrollbar-width: none;
}
.file-breadcrumb::-webkit-scrollbar { height: 0; }
.crumb {
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 3px;
  color: var(--fontColor);
  opacity: 0.85;
  flex-shrink: 0;
}
.crumb:hover { background: var(--menuActiveColor); opacity: 1; }
.crumb.active { opacity: 1; font-weight: 600; cursor: default; }
.crumb-sep { font-size: 9px; opacity: 0.5; margin: 0 1px; flex-shrink: 0; }

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

/* ---- 搜索框与匹配高亮 ---- */
.file-search {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 0 6px;
  height: 26px; /* 与 toolbar-btn 同高，不撑高工具栏 */
  box-sizing: border-box;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
}
.file-search i { font-size: 12px; opacity: 0.6; }
.file-search-input {
  width: 110px;
  height: 100%;
  border: none;
  outline: none;
  background: transparent;
  color: var(--fontColor);
  font-size: 12px;
  padding: 0;
}
.file-search-input::placeholder { color: var(--borderColor); }

/* 工具栏内搜索框：靠右显示 */
.file-toolbar .file-search {
  margin-left: 8px;
  background: var(--menuColor);
}
.file-toolbar .file-search .file-search-input { width: 140px; }
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
  gap: 12px;
  padding: 3px 8px;
  border-top: 1px solid var(--borderColor);
  background: var(--menuColor);
  font-size: 11px;
  color: var(--fontColor);
  flex-shrink: 0;
  user-select: none;
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