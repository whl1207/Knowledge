<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, watch, defineAsyncComponent } from 'vue'
import { usestore } from '@/store'
import { ElMessage } from 'element-plus'
import { fetchFsRead, downloadRemoteFile } from '@/platform/remoteFs'
import md_read from '@/components/knowFile/view/md_read.vue'
import Edit_Code from '@/components/knowFile/view/Edit_Code.vue'
import Edit_Block from '@/components/knowFile/view/Edit_Block.vue'
import md_mind from '@/components/knowFile/view/md_mind.vue'
import md_ppt from '@/components/knowFile/view/md_ppt.vue'
import { FILE_VIEWS, fileViewByKey } from '@/lib/knowFile/fileViews'
// 专属文件的判别与编辑器入口统一取自 fileEditors.ts（.drawio / .excalidraw / .flow.yml / .data / .task）
import { detectEditorKind, FILE_EDITORS } from '@/components/knowFile/fileEditors'

// 五类专属文件的编辑器（懒加载；组件路径集中在 fileEditors.ts）
const Excalidraw = defineAsyncComponent(FILE_EDITORS.excalidraw.load)
const Drawio = defineAsyncComponent(FILE_EDITORS.drawio.load)
const WorkflowEditor = defineAsyncComponent(FILE_EDITORS.flow.load)
const DataCanvasModule = defineAsyncComponent(FILE_EDITORS.data.load)
// 脚手架任务固定用它打开：单文件视图，无实例栏
const PipelineScaffold = defineAsyncComponent(FILE_EDITORS.task.load)

const store = usestore()

const filePath = ref('')
const fileContent = ref('')
const fileName = ref('')
// 内容读取中（大文件读盘/远程拉取）：浏览视图据此显示「正在渲染」，而不是误报“文件无内容和数据”
const contentLoading = ref(true)

// ---- 远程只读文件（rid/rel 参数存在时；内容走 HTTP 拉取，不读本地磁盘） ----
const isRemoteFile = ref(false)
const remoteRootId = ref('')
const remoteRel = ref('')
const remoteBase64 = ref('') // 图片/PDF 的裸 base64（无 data: 前缀）
const remoteText = ref('')   // 远程 Word 转换好的 Markdown
const remoteLoadError = ref('')
// draw.io 图表要定位到的页（1 起的序号 / 页名）：来自 URL 的 page 参数，或主进程的换页通知
const drawioPage = ref('')

// 独立窗口支持的视图类型（浏览/源码编辑/思维导图/演示/块编辑）
// 视图 key 顺序 / 显示名统一取自 fileViews.ts（顺序：浏览 / 源码编辑 / 可视编辑 / 思维导图 / 演示）
const VIEW_TYPES = FILE_VIEWS.map((v) => v.key)
type ViewType = (typeof FILE_VIEWS)[number]['key']
const viewType = ref<ViewType>('read')
const isMaximized = ref(false)

const titleText = computed(() => fileName.value)

/**
 * Markdown 正文是否为空（忽略 YAML frontmatter）。
 * 只有 `---\n…\n---` 头的文件同样没有可读正文（看板新建的卡片就是这样），
 * 浏览视图只会显示空内容提示，因此这类文件也应优先落到源码编辑视图。
 */
function mdBodyIsEmpty(text: string): boolean {
  const s = String(text || '').replace(/^\uFEFF/, '')
  const fm = s.match(/^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/)
  return !(fm ? s.slice(fm[0].length) : s).trim()
}

// 当前文件的专属编辑器类型（.excalidraw / .drawio / .flow.yml / .data / .task；其余为 null 走通用视图）
const editorKind = computed(() => detectEditorKind({ path: filePath.value, content: fileContent.value }))
const isExcalidraw = computed(() => editorKind.value === 'excalidraw')
const isDrawio = computed(() => editorKind.value === 'drawio')
const isFlowDsl = computed(() => editorKind.value === 'flow')
const isDataCanvas = computed(() => editorKind.value === 'data')
const isTask = computed(() => editorKind.value === 'task')

// 代码类文件：新窗口仅提供源码编辑视图（默认），不显示视图切换器
const CODE_FILE_EXTS = ['.js', '.ts', '.py', '.json', '.css', '.kb', '.task', '.txt']
// 纯文本表格数据（csv/tsv）：只需要浏览与源码编辑两个视图
const TEXT_TABLE_EXTS = ['.csv', '.tsv']
// Excel（xlsx/xls）：磁盘上是二进制、浏览视图看到的是主进程转好的 Markdown 表格，只给浏览
const EXCEL_EXTS = ['.xlsx', '.xls']
// 图片类文件：固定单一浏览视图，不显示视图切换器
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp', '.ico', '.tiff', '.tif']
// 音视频类文件：固定单一浏览视图（播放器），不显示视图切换器
const AUDIO_VIDEO_EXTS = ['.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv', '.m4v', '.3gp', '.mpg', '.mpeg', '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.opus', '.wma', '.ape', '.aiff']

const fileExt = computed(() => {
  const i = filePath.value.lastIndexOf('.')
  return i >= 0 ? filePath.value.substring(i).toLowerCase() : ''
})
const isCodeFile = computed(() => CODE_FILE_EXTS.includes(fileExt.value))
// html：提供浏览（默认）与源码编辑两个视图
const isHtmlFile = computed(() => fileExt.value === '.html')
const isMediaFile = computed(() => IMAGE_EXTS.includes(fileExt.value) || AUDIO_VIDEO_EXTS.includes(fileExt.value))
// pdf：固定单一浏览视图，不显示视图切换器
const isPdfFile = computed(() => fileExt.value === '.pdf')
// Word 文档（.docx/.doc）：预览为转换后的 Markdown，只提供浏览 / 思维导图两个只读视图
const isWordFile = computed(() => fileExt.value === '.docx' || fileExt.value === '.doc')
// 远程文本/Markdown 类（.md / .docx 转换后）才支持 导图/演示 等高级只读视图
const isRemoteAdvanced = computed(() => {
  if (!isRemoteFile.value) return false
  return fileExt.value === '.md' || fileExt.value === '.docx'
})
// 是否显示视图切换器（代码/图片/音视频/pdf/excalidraw/工作流/数据画布等固定单一视图不显示；远程只有单一视图时也不显示）
const showViewSwitcher = computed(() => {
  if (isRemoteFile.value) return availableViews.value.length > 1
  return !isExcalidraw.value && !isDrawio.value && !isFlowDsl.value && !isDataCanvas.value && !isTask.value && !isCodeFile.value && !isMediaFile.value && !isPdfFile.value && !EXCEL_EXTS.includes(fileExt.value)
})
// 可切换的视图选项（按文件类型过滤：html 仅浏览/源码编辑；Word 仅浏览/思维导图；csv/tsv 仅浏览/源码编辑）
const availableViews = computed<ViewType[]>(() => {
  // Word：只读浏览 + 思维导图（不提供编辑/快编辑/演示）
  if (isWordFile.value) return ['read', 'mindmap']
  // 工作流：新窗口固定工作流编辑器（YAML 文本请在知识管理的「源码编辑」里改）
  if (isFlowDsl.value) return ['read']
  // 数据画布：新窗口固定画布（同工作流；JSON 在知识管理里改）
  if (isDataCanvas.value) return ['read']
  // 脚手架任务：新窗口固定「脚手架」视图（单文件，无实例栏）
  if (isTask.value) return ['read']
  // Excel：只有浏览（表格是主进程转换出的 Markdown，源码编辑会把 Markdown 写回二进制文件）
  if (EXCEL_EXTS.includes(fileExt.value)) return ['read']
  // csv/tsv：浏览（表格/Markdown）+ 源码编辑（原始文本）
  if (TEXT_TABLE_EXTS.includes(fileExt.value)) return ['read', 'edit']
  // 远程只读：不支持 编辑/块编辑；固定浏览视图；Markdown 额外支持 导图/演示
  if (isRemoteFile.value) {
    return isRemoteAdvanced.value ? ['read', 'mindmap', 'presentation'] : ['read']
  }
  if (isHtmlFile.value) return ['read', 'edit']
  return [...VIEW_TYPES]
})
// 视图选项显示名
const viewLabel = (v: ViewType): string => {
  const def = fileViewByKey(v)
  if (def) return store.locales == 'zh' ? def.name : def.labelEn
  return v
}

// 系统菜单（任务栏 / Alt+Tab）标题：文件名 - 视图名。
// index.html 的 <title>AI-KM</title> 会覆盖主进程创建窗口时设置的标题，
// 因此在渲染进程重新设置 document.title（Electron 会自动同步到系统窗口标题/任务栏）。
const windowTitle = computed(() => {
  if (!fileName.value) return 'AI-KM'
  // .task 是文件专属的「脚手架」视图（不是通用浏览），标题直接写视图名更直观
  const viewName = isTask.value ? (store.locales === 'zh' ? '脚手架' : 'Scaffold') : viewLabel(viewType.value)
  return `${fileName.value} - ${viewName}`
})
// 视图切换、媒体切歌等文件名/视图变化时同步系统窗口标题
watch(windowTitle, (t) => { document.title = t }, { immediate: true })

function minimizeWindow() {
  window.ipcRenderer.invoke('minimize-window')
}

function maximizeWindow() {
  isMaximized.value = !isMaximized.value
  window.ipcRenderer.invoke('maximize-window')
}

function closeWindow() {
  store.saveConfig()
  window.ipcRenderer.invoke('close-window')
}

// Media 组件切歌（上一首/下一首）时更新窗口标题
function onMediaPathChange(path: string) {
  if (!path) return
  filePath.value = path
  fileName.value = path.replace(/\\/g, '/').split('/').pop() || '文件'
}

// ---- 远程只读文件加载 / 下载（与 panel.vue clickRemoteNode 的逻辑保持一致） ----

/** 从相对路径取小写扩展名 */
function extFromRel(rel: string): string {
  const i = rel.lastIndexOf('.')
  return i >= 0 ? rel.substring(i).toLowerCase() : ''
}

/**
 * 拉取远程文件内容并建立标签：
 *  - 图片 / PDF：读 base64，供 md_read 图片/PDF 预览
 *  - .docx：主进程 mammoth 转 Markdown 文本
 *  - 其余文本类：直接读文本
 *  - 二进制（视频等无法内联预览）：标记错误，提示下载
 */
async function loadRemoteFile(root: any, rel: string) {
  const ext = extFromRel(rel)
  const IMG_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']
  // 明确无法内联预览的二进制类型（音视频/压缩包/可执行等）：直接提示下载，避免拉取完整 base64
  const NO_PREVIEW_EXTS = [
    '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv', '.m4v', '.3gp', '.ts', '.mpg', '.mpeg',
    '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.opus', '.wma', '.ape', '.aiff',
    '.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.zst',
    '.exe', '.msi', '.dll', '.apk', '.dmg', '.deb', '.rpm', '.iso', '.bin', '.run', '.flatpak', '.snap',
  ]
  const tab: any = {
    path: filePath.value,
    label: fileName.value,
    type: 'file',
    extension: ext,
    isRemote: true,
    remoteRootId: root.id,
    remoteRel: rel,
    content: '',
    remoteBase64: '',
    remoteText: '',
  }
  try {
    if (NO_PREVIEW_EXTS.includes(ext)) {
      throw new Error(store.locales === 'zh' ? '该类型无法直接预览，请下载到本地' : 'This type cannot be previewed, please download')
    }
    if (IMG_EXTS.includes(ext) || ext === '.pdf') {
      const c = await fetchFsRead(root, rel)
      if (!c?.base64 && !c?.text) throw new Error(store.locales === 'zh' ? '无可用内容' : 'No content')
      remoteBase64.value = c.base64 || ''
      remoteText.value = c.text || ''
      tab.remoteBase64 = remoteBase64.value
      tab.remoteText = remoteText.value
    } else if (ext === '.docx') {
      const c = await fetchFsRead(root, rel)
      if (!c?.base64) throw new Error(store.locales === 'zh' ? '无可用内容' : 'No content')
      const md: any = await window.ipcRenderer.invoke('docxToMarkdown', { base64: c.base64 })
      const text = typeof md === 'string' ? md : ''
      if (!text) throw new Error(store.locales === 'zh' ? 'Word 文档转换失败' : 'Word conversion failed')
      fileContent.value = text
      remoteText.value = text
      tab.content = text
      tab.remoteText = text
    } else {
      const c = await fetchFsRead(root, rel)
      if (c?.text == null) {
        throw new Error(store.locales === 'zh' ? '该文件为二进制，无法直接预览，请下载到本地' : 'Binary file cannot be previewed, please download')
      }
      const text = c.text ?? ''
      fileContent.value = text
      tab.content = text
    }
  } catch (e: any) {
    remoteLoadError.value = e?.message || (store.locales === 'zh' ? '读取远程文件失败' : 'Remote read failed')
    fileContent.value = ''
  }
  // 无论成功与否都建立标签：失败时窗口仍展示只读条 + 错误提示 + 下载入口
  await store.addTab(tab)
  const cur = store.data[store.index]
  if (cur && cur.path === filePath.value) {
    cur.content = fileContent.value
    cur.attributes = {}
    cur.remoteBase64 = remoteBase64.value
    cur.remoteText = remoteText.value
  }
}

/** 远程只读条上的「下载到本地」：目标目录取当前本地工作区，未设置则弹文件夹选择 */
async function downloadActiveRemote() {
  if (!isRemoteFile.value) return
  const root = store.remoteRoots.find((r: any) => r.id === remoteRootId.value)
  if (!root) {
    ElMessage.warning(store.locales === 'zh' ? '远程工作区不存在或已删除' : 'Remote workspace not found')
    return
  }
  if (!remoteRel.value) return
  let dir = store.root
  if (!dir) dir = (await window.ipcRenderer.invoke('openFolderDialog')) as string
  if (!dir) return
  try {
    const localPath = await downloadRemoteFile(root, remoteRel.value, dir)
    ElMessage.success(store.locales === 'zh' ? ('已下载到: ' + localPath) : ('Downloaded: ' + localPath))
  } catch (e: any) {
    ElMessage.error(store.locales === 'zh' ? ('下载失败: ' + (e?.message || '')) : ('Download failed: ' + (e?.message || '')))
  }
}

// 独立窗口左上角切换视图类型（浏览/源码编辑/块编辑/导图/演示），标题自动跟随。
// 用自绘下拉（见模板）：原生 <select> 的面板在标题栏拖动区里会被窗口拖动流程关掉。
const viewSwitcherRef = ref<HTMLElement | null>(null)
const viewMenuOpen = ref(false)

function toggleViewMenu() {
  viewMenuOpen.value = !viewMenuOpen.value
}

function selectView(v: ViewType) {
  viewMenuOpen.value = false
  if (VIEW_TYPES.includes(v) && availableViews.value.includes(v)) viewType.value = v
}

/** 点到切换器之外 / 按 Esc 就收起下拉面板 */
function closeViewMenuOnOutside(e: Event) {
  if (!viewMenuOpen.value) return
  if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') return
  const el = viewSwitcherRef.value
  const target = e.target
  if (e.type !== 'keydown' && el && target instanceof Node && el.contains(target)) return
  viewMenuOpen.value = false
}

// 切换文件时收起面板，避免残留
// （注意：不能同时监听 availableViews —— 它是 computed，文件加载过程中任何相关状态变化
//  都会让它重新求值，回调里就会把刚打开的下拉又关掉）
watch(() => filePath.value, () => { viewMenuOpen.value = false })

/** 数据画布保存成功：同步内存里的文件内容，并刷新标题栏（画布自己写的盘，无需再读文件） */
const onDataCanvasSaved = (_path: string, content?: string) => {
  if (typeof content === 'string') fileContent.value = content
}

// 通道 B：其他窗口保存文件后广播，此处刷新预览
const onFileContentChanged = (_event: any, payload: { path?: string; content?: string }) => {
  if (!payload?.path || payload.path !== filePath.value) return
  const content = payload.content ?? ''
  // 更新 props 内容（浏览/预览视图 watch props.content 自动刷新）
  fileContent.value = content
  // 同步 store 中的文件内容（导图/演示/块编辑等从 store 读取的视图）。
  // 正在本窗口以 编辑/块编辑 编辑该文件时跳过覆盖 store：编辑器有未保存修改时不受其他窗口保存影响
  //（本窗口编辑器的保存已自行把内容写入 store，后续保存仍以编辑器为准）。
  if (store.data[store.index] && store.data[store.index].path === filePath.value) {
    if (viewType.value !== 'edit' && viewType.value !== 'blockedit') {
      store.data[store.index].content = content
    }
  }
}

// 主题广播：主窗口切换主题后应用（更新 store.UI + 重设 CSS 变量），本窗口跟随
const onThemeChanged = (_event: any, ui: any) => {
  store.applyThemeFromBroadcast(ui)
}

onMounted(async () => {
  // 监听其他窗口的文件内容变更广播
  window.ipcRenderer.on('file-content-changed', onFileContentChanged)
  // 视图切换下拉：点到外面 / 按 Esc 收起
  document.addEventListener('mousedown', closeViewMenuOnOutside)
  document.addEventListener('keydown', closeViewMenuOnOutside)
  // 监听主题广播（主窗口切换主题后本窗口跟随）
  window.ipcRenderer.on('theme-changed', onThemeChanged)
  // 主进程发现「该图表窗口已开着」时发来目标页：本窗口直接切页，不再重开窗口
  window.ipcRenderer.on('file-window-set-page', (_e: any, payload: any) => {
    const p = payload && payload.page != null ? String(payload.page) : ''
    if (p) drawioPage.value = p
  })

  // 独立窗口使用独立 store：打开时从 localStorage 同步最新模型来源配置，
  // 避免自定义推理等使用主窗口修改前保存的旧来源（导致请求 URL 无效）
  store.refreshAIconfigFromStorage()

  // 独立窗口不持久化标签：避免把新窗口打开的标签写进共享 localStorage，
  // 导致主窗口重启后恢复出这些标签（标签栏只属于独立文件窗口）
  store.setPersistTabs(false)

  const hash = window.location.hash
  const params = new URLSearchParams(hash.replace(/^#\/file-view\?/, ''))
  const requestedView = params.get('view') as ViewType | null
  filePath.value = decodeURIComponent(params.get('path') || '')
  // 远程只读文件：主进程透传 rid（remoteRootId）与 rel（共享内相对路径），据此走 HTTP 拉取内容
  const rid = decodeURIComponent(params.get('rid') || '')
  const rel = decodeURIComponent(params.get('rel') || '')
  const remoteLabel = decodeURIComponent(params.get('label') || '') || null
  // draw.io 图表：从 Markdown 内嵌图表点进来时要定位到的页（1 起的序号 / 页名）
  drawioPage.value = params.get('page') || ''
  isRemoteFile.value = !!(rid && rel)
  remoteRootId.value = rid
  remoteRel.value = rel
  fileName.value = remoteLabel
    || filePath.value.replace(/\\/g, '/').split('/').pop()
    || '文件'
  // 远程只读：默认浏览视图；代码类文件：默认（且仅）代码编辑视图，忽略 URL 传入的其他视图；其余默认浏览
  viewType.value = isRemoteFile.value
    ? 'read'
    : isCodeFile.value
      ? 'edit'
      : (requestedView && VIEW_TYPES.includes(requestedView) ? requestedView : 'read')
  // 受限类型（如 Word 只有 浏览/思维导图）收到不支持的视图请求（编辑/快编辑/演示）时回退到浏览
  if (!availableViews.value.includes(viewType.value)) viewType.value = 'read'

  // ★ 根因修复：文件独立窗口只承载「当前这一个文件」。
  // App.vue 的 loadConfig 会把 localStorage 里主窗口持久化的历史标签恢复进本窗口的 store，
  // 这些标签的 content 可能是空/旧内容；随后 addTab 若命中「已存在」分支就不会重新读盘，
  // 导致编辑视图(读 store.data[index].content)拿到空内容而浏览视图(读 fileContent)正常。
  // 这里清空继承来的标签，让下方 addTab 始终走「新建」分支从磁盘/远端读取内容。
  store.data = []
  store.index = 0

  if (!filePath.value) return

  // 远程文件：内容走 HTTP 拉取，不读本地磁盘
  if (isRemoteFile.value) {
    contentLoading.value = true
    try {
      // 独立窗口是异步挂载的子组件：正常情况下 App.onMounted 的 loadConfig 已加载 remoteRoots；
      // 兜底再调一次，防止极端时序下配置尚未就绪。
      let root = store.remoteRoots.find((r: any) => r.id === rid)
      if (!root) {
        store.loadConfig()
        root = store.remoteRoots.find((r: any) => r.id === rid)
      }
      if (root) {
        await loadRemoteFile(root, rel)
      } else {
        remoteLoadError.value = store.locales === 'zh'
          ? '远程工作区不存在或已删除，请回到主窗口重新连接后重试'
          : 'Remote workspace not found. Reconnect from the main window.'
        await store.addTab({
          path: filePath.value,
          label: fileName.value,
          type: 'file',
          extension: fileExt.value,
          isRemote: true,
          remoteRootId: rid,
          remoteRel: rel,
          content: '',
        })
      }
    } catch (e) {
      console.error('读取远程文件失败:', e)
    }
    contentLoading.value = false
    return
  }

  // 脚手架任务(.task)：固定「脚手架」视图，任务状态由 PipelineScaffold 按需自己读取
  //（任务文件含整张结果表，可能上百 MB，避免这里再整体读一遍到渲染层）
  if (isTask.value) {
    contentLoading.value = false
    return
  }

  // 本地文件：从磁盘读取
  contentLoading.value = true
  try {
    fileContent.value = await window.ipcRenderer.invoke('readFile', filePath.value)
    // 空 .md（正文为空 / 仅空白，或**只有 YAML 头**）默认跳到源码编辑视图：
    // 浏览视图对这类文件无内容可读，只会先闪一下「正在渲染」再落到空内容提示；
    // 新建 / 待填写的文档直接用编辑视图才符合预期（用户显式选了其它视图时不干预）。
    if (fileExt.value === '.md' && viewType.value === 'read' && mdBodyIsEmpty(fileContent.value)) {
      viewType.value = 'edit'
    }
    const ext = filePath.value.substring(filePath.value.lastIndexOf('.'))
    // addTab 新建当前文件标签（清空历史后必然走新建分支，内部会从磁盘读 content）
    await store.addTab({ path: filePath.value, label: fileName.value, type: 'file', extension: ext })
    const attributes = await window.ipcRenderer.invoke('getConfig', filePath.value)
    if (store.data[store.index] && store.data[store.index].path === filePath.value) {
      store.data[store.index].attributes = attributes
      // 兜底：无论 addTab 走哪个分支，都确保当前 tab 内容与浏览视图(磁盘读取)一致
      store.data[store.index].content = fileContent.value
    }
  } catch (e) {
    console.error('读取文件失败:', e)
  } finally {
    contentLoading.value = false
  }
})

onBeforeUnmount(() => {
  window.ipcRenderer.off('file-content-changed', onFileContentChanged)
  window.ipcRenderer.off('theme-changed', onThemeChanged)
  document.removeEventListener('mousedown', closeViewMenuOnOutside)
  document.removeEventListener('keydown', closeViewMenuOnOutside)
})
</script>

<template>
  <div class="file-window knowfile-menu">
    <div class="file-titlebar">
      <!-- 视图类型切换（按文件类型过滤；.excalidraw/代码/图片等固定单一视图，不显示）
           用自绘下拉而不是原生 <select>：标题栏是窗口拖动区，原生下拉面板在 Electron 里
           容易一移动鼠标就被系统拖动流程关掉（选项"一闪就没"），自绘面板不受此影响 -->
      <div v-if="showViewSwitcher" ref="viewSwitcherRef" class="file-view-switcher">
        <button
          type="button"
          class="file-view-switcher-btn"
          :class="{ open: viewMenuOpen }"
          :title="store.locales=='zh'?'切换视图类型':'Switch view type'"
          @pointerdown.stop
          @click.stop="toggleViewMenu"
        >
          <span class="file-view-switcher-label">{{ viewLabel(viewType) }}</span>
          <i class="fa fa-angle-down"></i>
        </button>
        <div v-if="viewMenuOpen" class="file-view-switcher-menu scoll" @pointerdown.stop>
          <div
            v-for="v in availableViews"
            :key="v"
            class="file-view-switcher-item"
            :class="{ active: v === viewType }"
            @click.stop="selectView(v)"
          >{{ viewLabel(v) }}</div>
        </div>
      </div>
      <div class="file-titlebar-title" :title="filePath">{{ titleText }}</div>
      <div class="file-titlebar-actions">
        <div @click="minimizeWindow" :title="store.locales=='zh'?'最小化':'Minimize'">
          <i class="fa fa-minus"></i>
        </div>
        <div @click="maximizeWindow" :title="store.locales=='zh'?'最大化/还原':'Maximize/Restore'">
          <i class="fa" :class="isMaximized ? 'fa-compress' : 'fa-window-maximize'"></i>
        </div>
        <div @click="closeWindow" class="file-close-btn" :title="store.locales=='zh'?'关闭':'Close'">
          <i class="fa fa-times"></i>
        </div>
      </div>
    </div>
    <!-- 远程只读提示条（可下载到本地） -->
    <div v-if="isRemoteFile" class="remote-readonly-bar">
      <i class="fa fa-cloud" style="color:#42b883"></i>
      <span>{{ store.locales=='zh'?'远程文件为只读预览':'Remote file (read-only preview)' }}</span>
      <span class="remote-readonly-spacer"></span>
      <span v-if="remoteLoadError" class="remote-readonly-error" :title="remoteLoadError">{{ remoteLoadError }}</span>
      <span class="remote-download-btn" @click="downloadActiveRemote" :title="store.locales=='zh'?'下载到本地':'Download to local'">
        <i class="fa fa-download"></i> {{ store.locales=='zh'?'下载到本地':'Download' }}
      </span>
    </div>
    <!-- draw.io 图表：与 Excalidraw 同样接管全部视图类型（read 分支的 md_read 内部也会渲染 drawio，
         因此这里必须串成 else-if，否则会同时出现两份绘图界面） -->
    <div v-if="isDrawio" class="file-view">
      <Drawio :path="filePath" :content="fileContent" :readonly="isRemoteFile" :page="drawioPage" />
    </div>
    <div v-else-if="isExcalidraw" class="file-view">
      <Excalidraw :path="filePath" :content="fileContent" />
    </div>
    <!-- 工作流（Dify DSL，.flow.yml/.flow.yaml）：工作流编辑器 -->
    <div v-else-if="isFlowDsl" class="file-view">
      <WorkflowEditor :path="filePath" :content="fileContent" :readonly="isRemoteFile" />
    </div>
    <!-- 数据画布（.data）：固定画布模块视图 -->
    <div v-else-if="isDataCanvas && !isRemoteFile" class="file-view">
      <DataCanvasModule :task-file-path="filePath" mode="full" @file-saved="onDataCanvasSaved" />
    </div>
    <!-- 脚手架任务（.task）：固定「脚手架」视图（单文件隔离在一个窗口里，无实例栏；状态由画布自行读写该文件）；
         远程只读 .task 不走这里（沿用文本预览） -->
    <div v-else-if="isTask && !isRemoteFile" class="file-view">
      <PipelineScaffold :task-file-path="filePath" />
    </div>
    <div v-else-if="viewType === 'read'" class="file-view">
      <md_read :path="filePath" :content="fileContent" :loading="contentLoading" :is-remote="isRemoteFile" :remote-base64="remoteBase64" :remote-text="remoteText" @update:path="onMediaPathChange" />
    </div>
    <div v-else-if="viewType === 'edit'" class="file-view">
      <Edit_Code />
    </div>
    <div v-else-if="viewType === 'blockedit'" class="file-view">
      <Edit_Block />
    </div>
    <div v-else-if="viewType === 'mindmap'" class="file-view">
      <md_mind />
    </div>
    <div v-else-if="viewType === 'presentation'" class="file-view">
      <md_ppt />
    </div>
  </div>
</template>

<style scoped>
.file-window {
  width: 100%;
  height: 100vh;
  overflow: hidden;
  background: var(--backgroundColor);
  display: flex;
  flex-direction: column;
}

.file-titlebar {
  display: flex;
  align-items: center;
  height: 36px;
  padding: 2px 8px;
  background: color-mix(in srgb, var(--menuColor) 96%, var(--borderColor));
  border-bottom: 1px solid var(--borderColor);
  user-select: none;
  cursor: move;
  -webkit-app-region: drag;
}
.file-titlebar-title {
  flex: 1;
  font-size: 14px;
  color: var(--fontColor);
  opacity: 0.8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 文件名不单独设 no-drag：整条标题栏（含文件名）都是窗口拖动区。
   代价是 Electron 下该区域鼠标事件由系统接管，文件名悬停不再弹完整路径提示
   （浏览器 / 局域网模式没有拖动区，提示照常显示）。 */
/* 视图类型切换器（位于标题文本左侧；标题栏为 drag 区，切换器需 no-drag 才能点击） */
.file-view-switcher {
  position: relative;
  flex-shrink: 0;
  margin-right: 8px;
  -webkit-app-region: no-drag;
}
.file-view-switcher-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  max-width: 130px;
  padding: 0 6px;
  border: none;
  border-radius: 4px;
  background-color: transparent; /* 与标题栏背景融为一体 */
  color: var(--fontColor);
  font-size: 12px;
  font-family: inherit;
  outline: none;
  cursor: pointer;
  transition: background-color 0.15s;
}
.file-view-switcher-btn:hover {
  background-color: color-mix(in srgb, var(--menuActiveColor) 40%, transparent);
}
.file-view-switcher-btn.open {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}
.file-view-switcher-btn > i {
  font-size: 11px;
  opacity: 0.7;
}
.file-view-switcher-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 下拉面板：自绘（原生 <select> 的面板会被标题栏拖动区关掉），样式跟随主题 */
.file-view-switcher-menu {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  z-index: 3000;
  min-width: 120px;
  max-height: 60vh;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  background: var(--backgroundColor);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
}
.file-view-switcher-item {
  padding: 5px 10px;
  border-radius: 4px;
  font-size: 12px;
  color: var(--fontColor);
  cursor: pointer;
  white-space: nowrap;
}
.file-view-switcher-item:hover {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}
.file-view-switcher-item.active {
  color: var(--fontActiveColor);
  font-weight: 600;
}
.file-titlebar-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  -webkit-app-region: no-drag;
}
.file-titlebar-actions div {
  width: 30px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  color: var(--fontColor);
  transition: background 0.15s;
}
.file-titlebar-actions div:hover {
    color: var(--fontActiveColor);
    background-color: var(--menuActiveColor);
}

.file-titlebar-actions .file-close-btn:hover {
  background: #e74c3c;
  color: #fff;
}

/* 远程只读提示条（样式与主窗口 explorer 保持一致） */
.remote-readonly-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  font-size: 11px;
  color: var(--fontColor);
  background: color-mix(in srgb, #42b883 10%, var(--menuColor));
  border-bottom: 1px solid color-mix(in srgb, #42b883 30%, var(--borderColor));
  user-select: none;
  flex-shrink: 0;
}
.remote-readonly-spacer {
  flex: 1;
}
.remote-readonly-error {
  color: #e6a23c;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.remote-download-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  color: #42b883;
  font-weight: 600;
  flex-shrink: 0;
}
.remote-download-btn:hover {
  text-decoration: underline;
}

.file-view {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  position: relative; /* 为 Excalidraw 等绝对定位子组件提供定位参考 */
}
</style>
