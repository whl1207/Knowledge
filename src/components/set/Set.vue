<!-- src/components/set/set.vue -->
<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { usestore, THEMES } from '@/store'
import { deepSeekApiStyle } from '@/shared/llmSources'
import Help from '@/components/set/Help.vue'
import McpSettings from '@/components/set/McpSettings.vue'
import SkillManagement from '@/components/set/SkillManagement.vue'
import SkillStore from '@/components/set/SkillStore.vue'
import AgentPreset from '@/components/set/AgentPreset.vue'
import LlmSettings from '@/components/set/LlmSettings.vue'
import ToolSettings from '@/components/set/ToolSettings.vue'
import SearchSettings from '@/components/set/SearchSettings.vue'
import TtsSettings from '@/components/set/TtsSettings.vue'
import AsrSettings from '@/components/set/AsrSettings.vue'
import ToolRegistryPanel from '@/components/set/ToolRegistryPanel.vue'
import BrowserSettingsPanel from '@/components/browser/BrowserSettingsPanel.vue'
import AgentConsole from '@/components/set/AgentConsole.vue'
import SessionLogPanel from '@/components/set/SessionLogPanel.vue'
import CredentialsPanel from '@/components/set/CredentialsPanel.vue'
import CollabSettings from '@/components/set/CollabSettings.vue'
import FileAssocSettings from '@/components/set/FileAssocSettings.vue'
import { chatsRef, currentChatIndexRef } from '@/store/chats'
import { FILE_VIEWS } from '@/lib/knowFile/fileViews'
import { ElMessage, ElMessageBox } from 'element-plus'

const store = usestore()

// standalone：本组件作为「设置」独立子窗口的根组件渲染（窗口无系统标题栏，顶栏即拖动区）
// initialNav：独立窗口首次打开时要定位的设置分类（主进程经 #/settings-window?nav=xxx 传入）
const props = defineProps<{ standalone?: boolean; initialNav?: string }>()

// 定义导航分类（支持一级分组 + 二级子项）
interface NavItem {
  id: string
  icon?: string
  title_zh: string
  title_en: string
  children?: NavItem[]
}

const navTree = ref<NavItem[]>([
  {
    id: 'base-group',
    icon: 'fa fa-cog',
    title_zh: '通用',
    title_en: 'General',
    children: [
      { id: 'view', icon: 'fa fa-eye', title_zh: '基础', title_en: 'Basic' },
      { id: 'collab', icon: 'fa fa-users', title_zh: '协作', title_en: 'Collaboration' },
      { id: 'llm', icon: 'fa fa-comments', title_zh: '模型', title_en: 'LLM' },
      { id: 'credentials', icon: 'fa fa-key', title_zh: '凭据', title_en: 'Credentials' },
      { id: 'fileassoc', icon: 'fa fa-link', title_zh: '关联', title_en: 'Associations' },
      { id: 'other', icon: 'fa fa-ellipsis-h', title_zh: '其他', title_en: 'Other' },
    ]
  },
  {
    id: 'ai-group',
    icon: 'fa fa-volume-up',
    title_zh: '语音',
    title_en: 'Speech',
    children: [
      { id: 'tts', icon: 'fa fa-volume-up', title_zh: '合成', title_en: 'TTS' },
      { id: 'asr', icon: 'fa fa-microphone', title_zh: '输入', title_en: 'ASR' }
    ]
  },
  {
    id: 'service-group',
    icon: 'fa fa-server',
    title_zh: '工具',
    title_en: 'Tools',
    children: [
      { id: 'tools', icon: 'fa fa-wrench', title_zh: '管理', title_en: 'Tools' },
      { id: 'search', icon: 'fa fa-search', title_zh: '搜索', title_en: 'Search' },
      { id: 'mcp', icon: 'fa fa-plug', title_zh: 'MCP', title_en: 'MCP' },
      { id: 'toolregistry', icon: 'fa fa-list-ul', title_zh: '注册表', title_en: 'Registry' }
    ]
  },
  {
    id: 'skill-group',
    icon: 'fa fa-superpowers',
    title_zh: '技能',
    title_en: 'Skills',
    children: [
      { id: 'agentskill', icon: 'fa fa-drupal', title_zh: '管理', title_en: 'Management' },
      { id: 'agentskill-store', icon: 'fa fa-shopping-cart', title_zh: '商店', title_en: 'Store' }
    ]
  },
  {
    id: 'agent-group',
    icon: 'fa fa-android',
    title_zh: '智能体',
    title_en: 'Agent',
    children: [
      { id: 'agentpreset', icon: 'fa fa-address-book-o', title_zh: '预设', title_en: 'Presets' },
      { id: 'agentconsole', icon: 'fa fa-cogs', title_zh: '控制台', title_en: 'Console' },
      { id: 'sessionlog', icon: 'fa fa-list-alt', title_zh: '日志', title_en: 'Session Log' }
    ]
  },
  { id: 'help', icon: 'fa fa-question-circle', title_zh: '帮助', title_en: 'Help' }
])

// 当前激活的导航项（叶子 id；默认进入界面设置）
const activeNav = ref('view')

// 已展开的一级分组（默认只展开激活项所在分组，避免导航栏过长）
const expandedGroups = ref<Set<string>>(new Set(['base-group']))

// 根据二级子项 id 找到其所属的一级分组 id
const findGroupByChild = (childId: string): string | undefined => {
  return navTree.value.find(g => g.children?.some(c => c.id === childId))?.id
}

// 支持从 AgentSwarm 等模块跳转到指定设置模块
// 注意：findGroupByChild / expandedGroups 必须先于本 watch 声明（immediate 回调同步执行，否则 TDZ 报错）
// 应用导航定位（供 store.settingsNav 跳转 / 独立窗口首次定位 / 独立窗口再次跳转共用）
const applyNav = (nav: string) => {
  if (!nav) return
  activeNav.value = nav
  // 跳转后只展开目标项所属分组
  const groupId = findGroupByChild(nav)
  expandedGroups.value = groupId ? new Set([groupId]) : new Set()
}

watch(() => store.settingsNav, (nav) => {
  if (nav) {
    applyNav(nav)
    store.settingsNav = ''
  }
}, { immediate: true })

// 手风琴式折叠/展开一级分组：点击哪个就只展开哪个，其他全部折叠
const toggleGroup = (id: string) => {
  const set = new Set(expandedGroups.value)
  if (set.has(id)) {
    // 已展开则整体折叠（收起当前分组）
    set.clear()
  } else {
    // 只展开当前分组，折叠其他所有分组
    set.clear()
    set.add(id)
  }
  expandedGroups.value = set
}

// 选中二级子项：只展开其所属分组，折叠其他所有分组
const selectNav = (id: string) => {
  activeNav.value = id
  const groupId = findGroupByChild(id)
  expandedGroups.value = groupId ? new Set([groupId]) : new Set()
}

// ================ 版本信息 ================
// 编译期由 vite define 注入（见 vite.config.ts），运行期不可变
const appVersion: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''
const buildTimeRaw: string = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : ''
// 将 ISO 构建时间格式化为本地时间 YYYY-MM-DD HH:mm:ss
const buildTimeText = computed(() => {
  if (!buildTimeRaw) return ''
  const d = new Date(buildTimeRaw)
  if (isNaN(d.getTime())) return buildTimeRaw
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
})

const openConsole = function() {
  window.ipcRenderer.send('dev',{})
}
let serveState = ref(false)

if(window.ipcRenderer!=undefined){
  window.ipcRenderer.on('server-status', (event, status) => {
    console.log(status)
    serveState.value = status
  })  
}

// 协作设置（局域网共享/协同文件编辑/远程文件共享 + 知识库共享目录）已抽离为独立模块
// CollabSettings.vue，由模板 <CollabSettings /> 承载。

// 工作区列表管理（支持多个工作区）
const newWorkspacePath = ref('')
const addWorkspaceFromInput = () => {
  const p = newWorkspacePath.value.trim()
  if (!p) return
  const isNew = store.addRoot(p)
  newWorkspacePath.value = ''
  if (isNew) {
    ElMessage.success(store.locales === 'zh' ? '已添加工作区' : 'Workspace added')
  } else {
    ElMessage.warning(store.locales === 'zh' ? '该路径已在工作区列表中' : 'This path is already in the workspace list')
  }
}
const activateWorkspace = (path: string) => {
  store.setActiveRoot(path)
}
const removeWorkspace = (path: string) => {
  ElMessageBox.confirm(
    store.locales === 'zh' ? `确定要从工作区列表中移除 "${path}" 吗？（不会删除磁盘文件）` : `Remove workspace "${path}"? (files on disk are not deleted)`,
    store.locales === 'zh' ? '移除工作区' : 'Remove Workspace',
    { confirmButtonText: store.locales === 'zh' ? '确定' : 'OK', cancelButtonText: store.locales === 'zh' ? '取消' : 'Cancel', type: 'warning' }
  ).then(() => {
    store.removeRoot(path)
    ElMessage.success(store.locales === 'zh' ? '已移除工作区' : 'Workspace removed')
  }).catch(() => {})
}

const openFolder = async function() {
  let path = await window.ipcRenderer.invoke('openFolderDialog')
  if(path!=null){
    // 添加为新的工作区并设为当前工作区（重复路径仅切换当前工作区，返回 false）
    const isNew = store.addRoot(path)
    newWorkspacePath.value = ''
    if (isNew) {
      ElMessage.success(store.locales === 'zh' ? '已添加工作区' : 'Workspace added')
    } else {
      ElMessage.warning(store.locales === 'zh' ? '该路径已在工作区列表中' : 'This path is already in the workspace list')
    }
  }
}
const openWorkflowFolder = async function() {
  let path = await window.ipcRenderer.invoke('openFolderDialog')
  if(path!=null){
    store.workflowPath = path
  }
}
// 计算属性：根据当前语言获取标题
const getTitle = (item:any) => {
  return store.locales === 'zh' ? item.title_zh : item.title_en
}

// 计算属性：获取视图按钮数据（由 store.viewList 派生，顺序/命名随 store 同步；
// id 恒为运行时视图标识，供 store.isView / toggleView 使用）
// 文件视图（浏览/源码编辑/可视编辑/思维导图/演示）的名称与图标统一来自 fileViews.ts
const VIEW_ICONS: Record<string, string> = {
  ...Object.fromEntries(FILE_VIEWS.map((v) => [v.name, v.icon])),
  '文件': 'fa fa-folder', '表格': 'fa fa-table', '图谱': 'fa fa-xing',
  '看板': 'fa fa-list-ul', '地图': 'fa fa-location-arrow', '日历': 'fa fa-calendar-o', '甘特': 'fa fa-list-alt',
}
const VIEW_TITLE_EN: Record<string, string> = {
  ...Object.fromEntries(FILE_VIEWS.map((v) => [v.name, v.labelEn])),
  '文件': 'Files', '表格': 'Table', '图谱': 'Graph',
  '看板': 'Kanban', '地图': 'Map', '日历': 'Year Calendar', '甘特': 'Gantt',
}
// 中文显示名覆盖：甘特对外展示为「日程」
const VIEW_TITLE_ZH: Record<string, string> = { '甘特': '日程' }
const viewButtons = computed(() => store.viewList.map((v: string) => ({
  id: v,
  icon: VIEW_ICONS[v] || 'fa fa-file-o',
  title_zh: VIEW_TITLE_ZH[v] || v,
  title_en: VIEW_TITLE_EN[v] || v,
})))

// 功能开关：控制 App.vue 导航栏主面板按钮的显示/隐藏（与 store 的 MAIN_PANEL_KEYS 对齐）
const navSwitches = computed(() => {
  const zh = store.locales === 'zh'
  return [
    { key: '主页', icon: 'fa fa-home', label: zh ? '主页' : 'Home' },
    { key: '知识管理', icon: 'fa fa-book', label: zh ? '知识管理' : 'Knowledge Management' },
    { key: '知识处理', icon: 'fa fa-stack-overflow', label: zh ? '知识处理' : 'Knowledge Processing' },
    { key: '学习', icon: 'fa fa-graduation-cap', label: zh ? '学习' : 'Learning' },
    { key: '工作流管理', icon: 'fa fa-stumbleupon', label: zh ? '工作流管理' : 'Workflow' },
    { key: '数据画布', icon: 'fa fa-object-group', label: zh ? '数据画布' : 'Data Canvas' },
    { key: 'Agent脚手架', icon: 'fa fa-deviantart', label: zh ? 'Agent脚手架' : 'Agent Scaffold' },
    { key: 'Agent Swarm', icon: 'fa fa-cubes', label: 'Agent Swarm' },
    { key: '待办管理', icon: 'fa fa-lightbulb-o', label: zh ? '待办管理' : 'Todo Management' }
  ]
})

// 自定义主题色配置（设置页「自定义」主题色卡：色块 + 名称 + 十六进制值）
// UIColorKey 限定为 store.UI 中可编辑的 6 个颜色键，保证 store.UI[key] 索引类型安全
type UIColorKey = 'backgroundColor' | 'borderColor' | 'menuColor' | 'menuActiveColor' | 'fontColor' | 'fontActiveColor'

const customColors = computed<{ key: UIColorKey; label: string }[]>(() => [
  { key: 'backgroundColor', label: store.locales === 'zh' ? '背景颜色' : 'Background Color' },
  { key: 'menuColor', label: store.locales === 'zh' ? '菜单颜色' : 'Menu Color' },
  { key: 'menuActiveColor', label: store.locales === 'zh' ? '菜单激活色' : 'Active Menu Color' },
  { key: 'fontColor', label: store.locales === 'zh' ? '字体颜色' : 'Text Color' },
  { key: 'fontActiveColor', label: store.locales === 'zh' ? '激活字体色' : 'Active Text Color' },
  { key: 'borderColor', label: store.locales === 'zh' ? '边框颜色' : 'Border Color' }
])

// 主题下拉选项：由 THEMES 映射表生成（追加「自定义」项，新增主题时下拉自动同步）
const themeOptions = computed(() => [...Object.keys(THEMES), '自定义'])
// 主题显示名（中文直接用主题名；英文用 THEMES 内置 labelEn，「自定义」为补充项）
const themeLabel = (t: string) => {
  if (store.locales === 'zh') return t
  return THEMES[t]?.labelEn || (t === '自定义' ? 'Custom' : t)
}

// 监听模型类型变化，重置连接状态
watch(() => store.AIconfig.llm.type, (newType, oldType) => {
  store.AIconfig.llm.online = false
  // 只有在真正切换类型时才清空，而不是在初始化时
  if (oldType && oldType !== newType) {
    switch(newType) {
      case 'ollama':
        // 不要清空模型，只清空可用列表
        store.AIconfig.llm.ollama.available_models = []
        break
      case 'openai':
        store.AIconfig.llm.openai.available_models = []
        break
      case 'deepseek': {
        // 单来源：清空当前接口样式对应配置块的模型列表
        const dsTarget = deepSeekApiStyle(store.AIconfig.llm) === 'responses'
          ? store.AIconfig.llm.deepseekResponses
          : store.AIconfig.llm.deepseek
        dsTarget.available_models = []
        break
      }
      case 'gpustack':
        store.AIconfig.llm.gpustack.available_models = []
        break
    }
  }
})

// ================ Python环境设置相关代码 ================

// Python安装状态
const pythonInstallation = ref({
  installed: false,
  version: null,
  command: null
})

// 检查Python安装状态
const checkPythonInstallation = async () => {
  try {
    const result = await window.ipcRenderer.invoke('checkPythonInstallation')
    pythonInstallation.value = result
    return result
  } catch (error) {
    console.error('检查Python安装失败:', error)
    return {
      installed: false,
      version: null,
      command: null
    }
  }
}

// 环境切换（Codex sandbox_mode 三态：safe=只读 / workspace=工作区写入 / trusted=完全访问）
const handleEnvironmentChange = async (envType: 'safe' | 'workspace' | 'trusted') => {
  store.pythonSandbox = envType
}

// 权限策略仅展示：由执行环境决定（完全访问=直接放行不询问，只读/工作区写入=执行前询问）
const approvalPolicyLabel = computed(() => {
  const zh = store.locales === 'zh'
  if ((store.pythonSandbox || 'workspace') === 'trusted') return zh ? '直接放行' : 'No Ask'
  return zh ? '请求时询问' : 'On Request'
})

// 权限策略说明（随执行环境实时变化，各环境有不同介绍）
const approvalPolicyDescription = computed(() => {
  const zh = store.locales === 'zh'
  const env = store.pythonSandbox || 'workspace'
  if (env === 'trusted') {
    return zh
      ? '完全访问：执行 Python/Shell/联网不弹确认框，直接放行。'
      : 'Full access: Python/Shell/Web run without confirmation.'
  }
  if (env === 'workspace') {
    return zh
      ? '工作区写入：执行 Python/Shell/联网前会弹出确认框，需您批准。'
      : 'Workspace: Python/Shell/Web require confirmation before running.'
  }
  return zh
    ? '只读安全：执行 Python/Shell/联网前会弹出确认框，需您批准。'
    : 'Read-only: Python/Shell/Web require confirmation before running.'
})

// 环境能力介绍（随执行环境实时变化，各环境有不同介绍）
const environmentCapabilitySummary = computed(() => {
  const zh = store.locales === 'zh'
  const env = store.pythonSandbox || 'workspace'
  if (env === 'trusted') {
    return zh
      ? '环境能力：无限制，可执行系统级操作（shell/os 等）。'
      : 'Capabilities: unrestricted, incl. system-level operations (shell/os).'
  }
  if (env === 'workspace') {
    return zh
      ? '环境能力：可读写文件与联网，仍禁止系统级操作（os/subprocess 等）。'
      : 'Capabilities: file I/O & network allowed, system-level ops still blocked.'
  }
  return zh
    ? '环境能力：仅纯计算（numpy/pulp 等），不能读写文件与联网。'
    : 'Capabilities: compute only (numpy/pulp etc.), no file I/O or network.'
})
// ================ localStorage 占用统计（初始化按钮中显示） ================
// 浏览器 localStorage 配额按 UTF-16 码元计（key + value 每字符 2 字节），Electron 上限约 100MB
const LOCAL_STORAGE_LIMIT = 100 * 1024 * 1024 // 100MB
// 容量上限的可读文本（进度条/占用文本共用；随 LOCAL_STORAGE_LIMIT 自动变化）
const localStorageLimitText = `${LOCAL_STORAGE_LIMIT / (1024 * 1024)} MB`
const localStorageBytes = ref(0)

// 统计当前 localStorage 全部键值对占用（字节）
const refreshLocalStorageUsage = () => {
  let total = 0
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key == null) continue
      const value = localStorage.getItem(key) || ''
      total += (key.length + value.length) * 2
    }
  } catch (e) {
    console.error('统计 localStorage 占用失败:', e)
  }
  localStorageBytes.value = total
}

// 格式化字节数为可读大小（KB/MB）
const formatBytes = (b: number) => {
  if (b >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(2) + ' MB'
  return (b / 1024).toFixed(1) + ' KB'
}

// 按钮中的占用文本，如 "24.5 KB / 100 MB · 0.02%"
const localStorageUsageText = computed(() => {
  const pct = (localStorageBytes.value / LOCAL_STORAGE_LIMIT) * 100
  return `${formatBytes(localStorageBytes.value)} / ${localStorageLimitText} · ${pct < 0.01 ? '<0.01' : pct.toFixed(1)}%`
})

// 进度条宽度百分比（0~100）
const localStoragePct = computed(() => {
  return Math.min((localStorageBytes.value / LOCAL_STORAGE_LIMIT) * 100, 100)
})

// ================ userData 缓存占用（清理缓存按钮用） ================
// 仅统计可安全清理的 Chromium 缓存目录，不含配置/会话等数据
const userDataCacheBytes = ref(0)
const userDataCacheText = computed(() => formatBytes(userDataCacheBytes.value))

// 查询可清理缓存(Cache/Code Cache/GPUCache 等)总占用（主进程统计 userData 下缓存目录）
const refreshUserDataCache = async () => {
  if (!window.ipcRenderer) return
  try {
    const res = await window.ipcRenderer.invoke('userdata-cache-info')
    userDataCacheBytes.value = res?.bytes || 0
  } catch (e) {
    console.error('查询缓存占用失败:', e)
  }
}

// 清理 userData 缓存：只删缓存/临时文件，绝不动配置、聊天记录、会话日志、账号数据
const handleCleanUserDataCache = async () => {
  await refreshUserDataCache()
  const size = userDataCacheBytes.value
  if (size <= 0) {
    ElMessage.info(store.locales === 'zh' ? '当前没有可清理的缓存' : 'No cache to clean right now')
    return
  }
  try {
    await ElMessageBox.confirm(
      store.locales === 'zh'
        ? `确定清理缓存文件吗（当前约 ${formatBytes(size)}）？只清理浏览器缓存/临时文件（Cache、Code Cache、GPUCache 等）与 Word 预览图片缓存（docx-media，重开 Word 文件会自动重新提取），不会删除任何配置、聊天记录、会话日志或账号数据。`
        : `Clean cache files now (about ${formatBytes(size)})? Only Chromium cache/temp files (Cache, Code Cache, GPUCache, etc.) and the Word preview image cache (docx-media, re-extracted on next open) will be removed. Config, chats, session logs and credentials are NOT affected.`,
      store.locales === 'zh' ? '提示' : 'Confirm',
      {
        confirmButtonText: store.locales === 'zh' ? '清理' : 'Clean',
        cancelButtonText: store.locales === 'zh' ? '取消' : 'Cancel',
        type: 'warning',
      }
    )
    const res = await window.ipcRenderer.invoke('clean-userdata-cache')
    if (res?.ok) {
      ElMessage.success(
        store.locales === 'zh'
          ? `已清理缓存 ${formatBytes(res.freed || 0)}`
          : `Cache cleaned: ${formatBytes(res.freed || 0)}`
      )
      if (res.failed && res.failed.length) {
        ElMessage.warning(
          store.locales === 'zh'
            ? `部分缓存正在被占用，已标记为下次启动时自动补清：${res.failed.join('、')}`
            : `Some cache is in use and is scheduled to be fully cleared on next startup: ${res.failed.join(', ')}`
        )
      }
    } else {
      ElMessage.error(
        store.locales === 'zh'
          ? '清理失败：' + (res?.error || '未知错误')
          : 'Clean failed: ' + (res?.error || 'unknown error')
      )
    }
    refreshUserDataCache()
  } catch {
    // 用户取消操作，不做处理
  }
}

// 切换到「系统」页时刷新占用统计
watch(activeNav, (nav) => {
  if (nav === 'system') {
    refreshLocalStorageUsage()
    refreshUserDataCache()
  }
})

// 初始化确认
const handleInitConfig = async () => {
  refreshLocalStorageUsage()
  try {
    await ElMessageBox.confirm(
      store.locales === 'zh'
        ? '确定要初始化吗？所有配置将被清除，应用将自动重启。'
        : 'Are you sure to initialize? All configurations will be cleared and the app will restart.',
      store.locales === 'zh' ? '提示' : 'Confirm',
      {
        confirmButtonText: store.locales === 'zh' ? '确定' : 'OK',
        cancelButtonText: store.locales === 'zh' ? '取消' : 'Cancel',
        type: 'warning',
      }
    )
    store.initConfig()
  } catch {
    // 用户取消操作，不做处理
  }
}

// 清空全部聊天记录
const handleClearChats = async () => {
  try {
    await ElMessageBox.confirm(
      store.locales === 'zh'
        ? '确定清空全部聊天记录吗？所有聊天与对话内容将被永久删除（不可恢复）。'
        : 'Clear all chat history? All chats and messages will be permanently deleted.',
      store.locales === 'zh' ? '提示' : 'Confirm',
      {
        confirmButtonText: store.locales === 'zh' ? '确定' : 'OK',
        cancelButtonText: store.locales === 'zh' ? '取消' : 'Cancel',
        type: 'warning',
      }
    )
    store.clearAllChats()
    ElMessage.success(store.locales === 'zh' ? '已清空全部聊天记录' : 'All chat history cleared')
    refreshLocalStorageUsage()
  } catch {
    // 用户取消操作，不做处理
  }
}

// ================ 聊天记录导入 / 导出（备份与恢复） ================
// 主窗口与设置窗口共享同一份 localStorage 存档（ai-chats）：
//   读：优先内存（主窗口已挂载时最新），否则 localStorage；
//   写：写入 localStorage，主窗口内存也在同一渲染器时就一并同步，并广播通知其它窗口重载。

/** 当前聊天列表（优先内存，回退 localStorage） */
const readStoredChats = (): any[] => {
  if (Array.isArray(chatsRef.value) && chatsRef.value.length) return chatsRef.value
  try {
    const saved = localStorage.getItem('ai-chats')
    const list = saved ? JSON.parse(saved) : []
    return Array.isArray(list) ? list : []
  } catch { return [] }
}

/** 写回聊天存档；不动 ai-chats-index（主窗口加载时会自行 clamp） */
const writeStoredChats = (list: any[]) => {
  localStorage.setItem('ai-chats', JSON.stringify(list))
  if (Array.isArray(chatsRef.value) && chatsRef.value.length) chatsRef.value = list
  window.dispatchEvent(new CustomEvent('ai-chats-changed'))
  // 独立设置窗口场景：通知其它窗口（主窗口）重新加载，否则主窗口下次 saveChats 会把导入结果覆盖掉
  try { (window as any).ipcRenderer?.send?.('chats-changed') } catch { /* 忽略 */ }
  refreshLocalStorageUsage()
}

/** 时间戳后缀：YYYYMMDD-HHmmss（导出文件名用） */
const stampText = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 导出文件名：ai-chats-YYYYMMDD-HHmmss.json */
const chatsFileName = () => `ai-chats-${stampText()}.json`

/** 另存为对话框的文件类型过滤（导出聊天 / 备份 / Markdown 共用） */
const JSON_FILTERS = [{ name: 'JSON', extensions: ['json'] }, { name: 'All Files', extensions: ['*'] }]
const MD_FILTERS = [{ name: 'Markdown', extensions: ['md'] }, { name: 'All Files', extensions: ['*'] }]

/** 保存文本文件：桌面版走原生「另存为」，浏览器/LAN 模式走浏览器下载。
 *  返回保存路径（浏览器模式为空串）；用户取消返回 null；写入失败抛错。 */
const saveTextFile = async (
  defaultName: string,
  content: string,
  mime: string,
  filters: { name: string; extensions: string[] }[],
): Promise<string | null> => {
  const ipc: any = (window as any).ipcRenderer
  if (ipc?.invoke) {
    const target = await ipc.invoke('saveFileDialog', { defaultPath: defaultName, filters })
    if (!target) return null
    const ok = await ipc.invoke('saveFile', target, content)
    if (!ok) throw new Error(store.locales === 'zh' ? '无法写入文件' : 'cannot write file')
    return target
  }
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = defaultName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
  return ''
}

/** 导出全部聊天记录（含分支 / 知识库来源 / 工具调用时间线等完整字段）为 JSON 备份文件 */
const handleExportChats = async () => {
  const list = readStoredChats()
  if (!list.length) {
    ElMessage.warning(store.locales === 'zh' ? '当前没有聊天记录可导出' : 'No chat history to export')
    return
  }
  const payload = { app: 'ai-km', kind: 'chats', version: 1, exportedAt: new Date().toISOString(), chats: list }
  const json = JSON.stringify(payload, null, 2)
  try {
    const target = await saveTextFile(chatsFileName(), json, 'application/json', JSON_FILTERS)
    if (target === null) return
    ElMessage.success(store.locales === 'zh'
      ? `已导出 ${list.length} 个聊天${target ? ` → ${target}` : ''}`
      : `Exported ${list.length} chats${target ? ` → ${target}` : ''}`)
  } catch (e: any) {
    ElMessage.error((store.locales === 'zh' ? '导出失败：' : 'Export failed: ') + (e?.message || String(e)))
  }
}

/** 解析导入文件内容（兼容「完整导出包」与「裸数组」两种格式） */
const parseChatsFile = (text: string): any[] => {
  const data = JSON.parse(text)
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.chats) ? data.chats : null)
  if (!list) throw new Error(store.locales === 'zh' ? '不是有效的聊天导出文件' : 'not a valid chats export file')
  return list.filter((c: any) => c && typeof c === 'object' && (Array.isArray(c.messages) || c.config))
}

/** 浏览器 / LAN 模式选文件（无 ipcRenderer 时用 <input type=file>） */
const pickTextFileInBrowser = (): Promise<string> => new Promise((resolve) => {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'application/json,.json'
  input.onchange = () => {
    const f = input.files && input.files[0]
    if (!f) { resolve(''); return }
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => resolve('')
    reader.readAsText(f)
  }
  input.click()
})

/** 导入聊天记录（JSON）：与现有记录合并，同 id 跳过（可重复导入而不产生重复） */
const handleImportChats = async () => {
  try {
    let text = ''
    const ipc: any = (window as any).ipcRenderer
    if (ipc?.invoke) {
      const res = await ipc.invoke('openFile') // → { content, filePath }
      if (!res || res.content == null) return
      text = String(res.content)
    } else {
      text = await pickTextFileInBrowser()
      if (!text) return
    }
    const incoming = parseChatsFile(text)
    if (!incoming.length) {
      ElMessage.warning(store.locales === 'zh' ? '文件中没有可导入的聊天记录' : 'No chats found in the file')
      return
    }
    const existing = readStoredChats()
    const ids = new Set(existing.map((c: any) => String(c?.id ?? '')))
    const added = incoming.filter((c: any) => !ids.has(String(c?.id ?? '')))
    const skipped = incoming.length - added.length
    if (!added.length) {
      ElMessage.info(store.locales === 'zh' ? `未发现新聊天（${skipped} 个已存在）` : `Nothing new (${skipped} already exist)`)
      return
    }
    writeStoredChats([...existing, ...added])
    ElMessage.success(store.locales === 'zh'
      ? `已导入 ${added.length} 个聊天${skipped ? `（跳过 ${skipped} 个已存在）` : ''}`
      : `Imported ${added.length} chats${skipped ? ` (${skipped} skipped)` : ''}`)
  } catch (e: any) {
    ElMessage.error((store.locales === 'zh' ? '导入失败：' : 'Import failed: ') + (e?.message || String(e)))
  }
}

// ================ 导出为 Markdown（人类可读归档；完整字段备份请用「导出聊天」） ================

/** 本地时间文本：YYYY-MM-DD HH:mm:ss */
const fmtDateTime = (ts?: number) => {
  const n = Number(ts)
  if (!n || !isFinite(n)) return ''
  const d = new Date(n)
  const p = (v: number) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 会话模式显示名 */
const CHAT_MODE_LABEL: Record<string, string> = {
  normal: '对话', retrieval: '知识库', workflow: '工作流', skill: '技能', agent: '智能体', agent2: '智能体', swarm: '集群',
}

/** 单个会话 → Markdown 片段（图片附件与工具入参不写入，避免体积失控；完整备份请用「导出聊天」） */
const chatToMarkdown = (chat: any, parentTitle = ''): string => {
  const zh = store.locales === 'zh'
  const lines: string[] = []
  lines.push(`## ${String(chat?.title || '').trim() || (zh ? '(未命名会话)' : '(untitled)')}`, '')
  const msgs: any[] = Array.isArray(chat?.messages) ? chat.messages : []
  const meta: string[] = []
  if (chat?.mode) meta.push(`${zh ? '模式' : 'Mode'}：${CHAT_MODE_LABEL[String(chat.mode)] || chat.mode}`)
  if (chat?.createdAt) meta.push(`${zh ? '创建' : 'Created'}：${fmtDateTime(chat.createdAt)}`)
  if (parentTitle) meta.push(`${zh ? '分支自' : 'Branch of'}：${parentTitle}`)
  meta.push(`${zh ? '消息' : 'Messages'}：${msgs.length}`)
  lines.push(`> ${meta.join(' · ')}`, '')
  for (const m of msgs) {
    const role = m?.role === 'user' ? (zh ? '用户' : 'User') : (m?.role === 'assistant' ? (zh ? '助手' : 'Assistant') : (zh ? '系统' : 'System'))
    const head = [fmtDateTime(m?.timestamp), m?.model].filter(Boolean).join(' · ')
    lines.push(`### ${role}${head ? `  <sub>${head}</sub>` : ''}`, '')
    const content = String(m?.content ?? '').trim()
    if (content) lines.push(content, '')
    const atts: any[] = Array.isArray(m?.fileAttachments) ? m.fileAttachments : []
    if (atts.length) {
      lines.push(zh ? '附件：' : 'Attachments:')
      for (const f of atts) lines.push(`- ${f?.name || (zh ? '未命名' : 'unnamed')}${f?.charCount ? `（${f.charCount} ${zh ? '字' : 'chars'}）` : ''}`)
      lines.push('')
    }
    if (Array.isArray(m?.images) && m.images.length) {
      lines.push(`> ${zh ? `含图片 ${m.images.length} 张（未写入 Markdown，完整备份请用「导出聊天」）` : `${m.images.length} image(s) omitted; use "Export Chats" for a full backup`}`, '')
    }
    if (m?.kbInfo?.kbPath) {
      const hits = Array.isArray(m.kbInfo.relevantBlocks) ? m.kbInfo.relevantBlocks.length : 0
      lines.push(`> ${zh ? '知识库' : 'Knowledge base'}：${m.kbInfo.kbPath}${hits ? `（${zh ? '命中' : 'hits'} ${hits}）` : ''}`, '')
    }
    const units: any[] = Array.isArray(m?.executionUnits) ? m.executionUnits : []
    if (units.length) {
      const ok = units.filter((u: any) => u?.status === 'success').length
      lines.push(`> ${zh ? '执行单元' : 'Execution units'}：${units.length}（${zh ? '成功' : 'ok'} ${ok}）`)
      for (const u of units) {
        const name = String(u?.name || u?.description || u?.stepType || u?.id || (zh ? '步骤' : 'step'))
        const st = u?.status === 'success' ? (zh ? '成功' : 'ok') : (u?.status === 'error' ? (zh ? '失败' : 'failed') : (zh ? '未完成' : 'pending'))
        lines.push(`> - ${name}：${st}${u?.error ? ` — ${String(u.error).slice(0, 120)}` : ''}`)
      }
      lines.push('')
    }
    const tk = m?.tokenStats
    if (tk?.totalTokens) {
      lines.push(`> tokens：${zh ? '输入' : 'in'} ${tk.promptTokens} / ${zh ? '输出' : 'out'} ${tk.completionTokens} / ${zh ? '合计' : 'total'} ${tk.totalTokens}`, '')
    }
  }
  return lines.join('\n')
}

/** 导出全部聊天记录为 Markdown：一个文件汇总所有会话，按创建时间排序并标注分支来源 */
const handleExportChatsMarkdown = async () => {
  const zh = store.locales === 'zh'
  const list = readStoredChats()
  if (!list.length) {
    ElMessage.warning(zh ? '当前没有聊天记录可导出' : 'No chat history to export')
    return
  }
  const titleOf = (id: string) => {
    const p = list.find((c: any) => String(c?.id ?? '') === id)
    return p ? (String(p.title || '').trim() || (zh ? '(未命名会话)' : '(untitled)')) : ''
  }
  const sorted = [...list].sort((a: any, b: any) => Number(a?.createdAt || 0) - Number(b?.createdAt || 0))
  const head = [
    `# ${zh ? '聊天记录导出' : 'Chat History Export'}`,
    '',
    `> ${zh ? '导出时间' : 'Exported'}：${fmtDateTime(Date.now())} · ${zh ? '会话' : 'Chats'}：${sorted.length}`,
    '',
    '',
  ].join('\n')
  const body = sorted.map((c: any) => {
    const pid = c?.parentId != null ? String(c.parentId) : ''
    return chatToMarkdown(c, pid ? titleOf(pid) : '')
  }).join('\n---\n\n')
  try {
    const target = await saveTextFile(`ai-chats-${stampText()}.md`, head + body + '\n', 'text/markdown', MD_FILTERS)
    if (target === null) return
    ElMessage.success(zh ? `已导出 ${sorted.length} 个聊天为 Markdown${target ? ` → ${target}` : ''}` : `Exported ${sorted.length} chats as Markdown${target ? ` → ${target}` : ''}`)
  } catch (e: any) {
    ElMessage.error((zh ? '导出失败：' : 'Export failed: ') + (e?.message || String(e)))
  }
}

// ================ 全部数据备份（界面 + AI 配置 + 预设；不含聊天记录） ================

/** 备份覆盖的存档键（聊天记录体积大，由「导出聊天」单独备份，这里不重复） */
const BACKUP_KEYS = [
  'AIconfig', 'UI', 'customLlmSources', 'llmSourceStatus', 'llmDisabledSources', 'llmCustomSourceStatus',
  'agentPresets', 'generalAgentMaxSteps', 'mcpServers', 'disabledSkills', 'skillStoreSources', 'agentTools',
  'webSearchConfig',
  'enabledScaffolds', 'hiddenNavs', 'customTitle', 'interfaceConfigMode', 'collab', 'remoteFs', 'lan',
  'remoteRoots', 'mapConfig', 'locales', 'roots', 'root', 'path', 'skillsPath', 'workflowPath', 'treeSort',
  'view', 'mainPanel', 'canvasTaskPath',
]

/** 备份全部配置与预设为一个 JSON 文件（初始化/换机前留底） */
const handleBackupAllData = async () => {
  const zh = store.locales === 'zh'
  const data: Record<string, any> = {}
  let count = 0
  for (const k of BACKUP_KEYS) {
    const raw = localStorage.getItem(k)
    if (raw === null) continue
    try { data[k] = JSON.parse(raw) } catch { data[k] = raw }
    count++
  }
  if (!count) {
    ElMessage.warning(zh ? '当前没有可备份的配置' : 'Nothing to back up')
    return
  }
  const payload = {
    app: 'ai-km', kind: 'backup', version: 1,
    exportedAt: new Date().toISOString(),
    appVersion: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '',
    keys: count, data,
  }
  try {
    const target = await saveTextFile(`ai-km-backup-${stampText()}.json`, JSON.stringify(payload, null, 2), 'application/json', JSON_FILTERS)
    if (target === null) return
    ElMessage.success(zh ? `已备份 ${count} 项配置与预设${target ? ` → ${target}` : ''}` : `Backed up ${count} config entries${target ? ` → ${target}` : ''}`)
  } catch (e: any) {
    ElMessage.error((zh ? '备份失败：' : 'Backup failed: ') + (e?.message || String(e)))
  }
}

/** 打开本机数据目录（userData：配置、缓存、会话日志等；仅桌面版） */
const handleOpenDataDir = async () => {
  const zh = store.locales === 'zh'
  const ipc: any = (window as any).ipcRenderer
  if (!ipc?.invoke) {
    ElMessage.warning(zh ? '浏览器模式下无法打开本机目录' : 'Not available in browser mode')
    return
  }
  try {
    const res = await ipc.invoke('open-data-dir')
    if (res?.success) ElMessage.success(zh ? `已打开数据目录：${res.path}` : `Opened data folder: ${res.path}`)
    else ElMessage.error((zh ? '打开失败：' : 'Failed: ') + (res?.error || ''))
  } catch (e: any) {
    ElMessage.error((zh ? '打开失败：' : 'Failed: ') + (e?.message || String(e)))
  }
}

/** 清空全部会话日志（智能体/会话的原始事件记录，仅桌面版） */
const handleClearSessionLog = async () => {
  const zh = store.locales === 'zh'
  if (!window.dsh?.sessionLog) {
    ElMessage.warning(zh ? '浏览器模式下无法清空会话日志' : 'Not available in browser mode')
    return
  }
  try {
    await ElMessageBox.confirm(
      zh
        ? '确定清空全部会话日志吗？该日志是智能体/会话的原始事件记录（用于「设置 → 日志」检视），清空后不可恢复。正在运行的智能体任务请先停止。'
        : 'Clear all session logs? These are the raw event records shown in Settings → Session Log and cannot be recovered.',
      zh ? '提示' : 'Confirm',
      {
        confirmButtonText: zh ? '确定' : 'OK',
        cancelButtonText: zh ? '取消' : 'Cancel',
        type: 'warning',
      }
    )
    const res = await window.dsh.sessionLog.clearAll()
    if (res?.success === false) throw new Error(zh ? '清空失败' : 'clear failed')
    ElMessage.success(zh ? '已清空全部会话日志' : 'All session logs cleared')
  } catch {
    // 用户取消 / 清空失败：取消不做处理
  }
}

/** 在系统文件管理器中打开某个工作区文件夹（工作区行右侧按钮；仅桌面版） */
const openWorkspaceFolder = async (p: string) => {
  const zh = store.locales === 'zh'
  const ipc: any = (window as any).ipcRenderer
  if (!ipc?.invoke) {
    ElMessage.warning(zh ? '浏览器模式下无法打开本机文件夹' : 'Not available in browser mode')
    return
  }
  try {
    const res = await ipc.invoke('openWithSystemApp', p)
    if (res && res.success === false) ElMessage.error((zh ? '打开失败：' : 'Failed: ') + (res.error || ''))
  } catch (e: any) {
    ElMessage.error((zh ? '打开失败：' : 'Failed: ') + (e?.message || String(e)))
  }
}

// 恢复默认 AI 配置
const handleResetAIconfig = async () => {
  try {
    await ElMessageBox.confirm(
      store.locales === 'zh'
        ? '确定恢复默认 AI 配置吗？所有模型来源、API 密钥与参数设置将被重置为出厂默认值。'
        : 'Reset AI config to defaults? All model sources, API keys and parameters will be reset.',
      store.locales === 'zh' ? '提示' : 'Confirm',
      {
        confirmButtonText: store.locales === 'zh' ? '确定' : 'OK',
        cancelButtonText: store.locales === 'zh' ? '取消' : 'Cancel',
        type: 'warning',
      }
    )
    store.resetAIconfig()
    ElMessage.success(store.locales === 'zh' ? '已恢复默认 AI 配置' : 'AI config reset to defaults')
  } catch {
    // 用户取消操作，不做处理
  }
}

// 关闭设置：独立窗口模式关闭窗口；主窗口浮层模式隐藏浮层
const closeSettings = () => {
  if (props.standalone) {
    store.saveConfig()
    window.ipcRenderer?.invoke('close-window').catch(() => {})
    return
  }
  store.settingsOpen = false
}

// ================ 独立窗口按钮（standalone 模式下显示在顶栏右侧） ================
const isMaximized = ref(false)
const minimizeWindow = () => {
  window.ipcRenderer?.invoke('minimize-window').catch(() => {})
}
const maximizeWindow = () => {
  isMaximized.value = !isMaximized.value
  window.ipcRenderer?.invoke('maximize-window').catch(() => {})
}

// 独立窗口的系统菜单/任务栏标题（index.html 的 <title>AI-KM</title> 会覆盖主进程设置的标题）
const syncWindowTitle = () => {
  if (!props.standalone) return
  document.title = store.locales === 'zh' ? '设置' : 'Settings'
}
watch(() => store.locales, syncWindowTitle)

// 全屏切换（桌面版：通过主进程切换窗口全屏；顶栏已无全屏按钮，统一在此操作）
const isFullscreen = ref(false)
const toggleFullscreen = async () => {
  if (!window.ipcRenderer) return
  isFullscreen.value = await window.ipcRenderer.invoke('toggle-fullscreen')
}

// Esc 键关闭设置面板（浮层模式；独立窗口下设置内的弹窗本身用 Esc 取消，故不响应关窗）
const onSettingsKeydown = (e: KeyboardEvent) => {
  if (props.standalone) return
  if (e.key === 'Escape') closeSettings()
}

// ================ 窗口缩放 ================
// 缩放值以百分比存储（store.UI.windowZoom，默认 100 = 100%）
const ZOOM_PCT_MIN = 50
const ZOOM_PCT_MAX = 200

// 同步主进程当前的缩放因子到输入框
const syncWindowZoom = async () => {
  if (!window.ipcRenderer) return
  try {
    const res = await window.ipcRenderer.invoke('window:zoomGet')
    if (res && typeof res.factor === 'number') {
      store.UI.windowZoom = Math.round(res.factor * 100)
    }
  } catch (e) {
    console.error('获取窗口缩放失败:', e)
  }
}

// 应用缩放（百分比 → 主进程 zoomFactor）
const applyWindowZoom = (pct: number) => {
  const clamped = Math.min(ZOOM_PCT_MAX, Math.max(ZOOM_PCT_MIN, Math.round(pct)))
  store.UI.windowZoom = clamped
  if (!window.ipcRenderer) return
  window.ipcRenderer.invoke('window:zoomSet', { factor: clamped / 100 }).catch((e: any) => {
    console.error('设置窗口缩放失败:', e)
  })
}

// 输入框直接输入缩放百分比（change 时应用）
const onZoomInput = () => {
  applyWindowZoom(store.UI.windowZoom || 100)
}

// 步进调整（±10%）
const zoomStep = (step: number) => {
  applyWindowZoom((store.UI.windowZoom || 100) + step)
}

// 重置为 100%
const resetZoom = () => {
  applyWindowZoom(100)
}

// ================ 关闭按钮行为（直接退出 / 折叠到托管区） ================
// 主进程是唯一事实源（userData/app-behavior.json）：设置页只负责读写它，
// 并把生效值回写到 store.UI.closeToTray（主窗口据此决定“有任务时是否二次确认”）。
const syncCloseBehavior = async () => {
  if (!window.ipcRenderer) return
  try {
    const res = await window.ipcRenderer.invoke('app-behavior:get')
    if (res && typeof res.closeToTray === 'boolean') store.UI.closeToTray = res.closeToTray
  } catch (e) {
    console.error('获取关闭按钮行为失败:', e)
  }
}

const applyCloseBehavior = async () => {
  const zh = store.locales === 'zh'
  const want = !!store.UI.closeToTray
  if (!window.ipcRenderer) {
    store.UI.closeToTray = false
    ElMessage.warning(zh ? '浏览器模式下无法折叠到托管区' : 'Not available in browser mode')
    return
  }
  try {
    const res = await window.ipcRenderer.invoke('app-behavior:set', { closeToTray: want })
    const actual = !!(res && res.closeToTray)
    store.UI.closeToTray = actual
    store.saveConfig()
    if (want && !actual) {
      ElMessage.error(zh
        ? '当前系统环境不支持托盘，已保持“直接退出”'
        : 'Tray is unavailable on this system; kept “Quit directly”')
    } else {
      ElMessage.success(actual
        ? (zh ? '已开启：点击关闭按钮将折叠到托管区，后台任务继续运行' : 'Enabled: the close button now collapses to the tray')
        : (zh ? '已关闭：点击关闭按钮将直接退出软件' : 'Disabled: the close button now quits the app'))
    }
  } catch (e: any) {
    store.UI.closeToTray = !want
    ElMessage.error((zh ? '设置失败：' : 'Failed: ') + (e?.message || e))
  }
}

// 界面配置随软件分发开关：开启后界面配置保存到软件根目录 interface-config.json，便于整机分发
const toggleInterfaceConfig = async () => {
  const on = !store.interfaceConfigMode
  if (on) {
    try {
      const res = await store.setInterfaceConfigMode(true)
      ElMessage.success(
        store.locales === 'zh'
          ? '已开启：界面配置将保存到软件根目录\n' + res.path
          : 'Enabled: interface config will be saved to\n' + res.path
      )
    } catch (e: any) {
      ElMessage.error(store.locales === 'zh' ? '开启失败：' + (e?.message || e) : 'Failed: ' + (e?.message || e))
    }
  } else {
    await store.setInterfaceConfigMode(false)
    ElMessage.success(store.locales === 'zh' ? '已关闭：界面配置回到本机保存' : 'Disabled: interface config saved locally')
  }
}

// ================ Word 导出模板（公文/中文论文/英文论文/自定义 .docx，控制三处「导出为 Word」） ================
const wordExportTemplates = [
  { key: 'gongwen', labelZh: '公文（GB/T 9704-2012）', labelEn: 'Official (GB/T 9704-2012)' },
  { key: 'cn', labelZh: '中文论文（GB/T 7713.2-2022 参考）', labelEn: 'Chinese Paper' },
  { key: 'en', labelZh: '英文论文（APA 7th）', labelEn: 'English Paper (APA 7th)' },
  { key: 'custom', labelZh: '自定义 Word 模板', labelEn: 'Custom Word Template' },
]
const chooseWordExportStyle = async () => {
  if (!window.ipcRenderer) return
  const path = await window.ipcRenderer.invoke('selectFile', {
    filters: [{ name: 'Word 样式模板', extensions: ['docx'] }],
    properties: ['openFile'],
  })
  if (path) {
    store.UI.wordExportStylePath = path
    store.saveConfig()
    ElMessage.success(store.locales === 'zh' ? '已选择 Word 导出样式' : 'Word export style set')
  }
}
const clearWordExportStyle = () => {
  store.UI.wordExportStylePath = ''
  store.saveConfig()
  ElMessage.success(store.locales === 'zh' ? '已恢复默认样式' : 'Back to default style')
}

// ================ 离线地图包（MBTiles）管理 ================
let mbSources = ref([]) as any
let mbUnsub: (() => void) | null = null
const fmtMbSize = (b: number) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB')
const refreshMapTiles = async () => {
  try {
    mbSources.value = (await window.dsh?.mapTiles?.list?.()) || []
  } catch (e) {
    mbSources.value = []
  }
}
const mountMapTile = async () => {
  try {
    const added = await window.dsh?.mapTiles?.add?.()
    if (added) {
      await refreshMapTiles()
      ElMessage.success(store.locales === 'zh' ? `已挂载地图包：${added.name}` : `Mounted: ${added.name}`)
    }
  } catch (e: any) {
    ElMessage.error(store.locales === 'zh' ? '挂载失败：' + (e?.message || e) : 'Mount failed: ' + (e?.message || e))
  }
}
const unmountMapTile = async (id: string, name: string) => {
  try {
    await ElMessageBox.confirm(
      store.locales === 'zh' ? `确定移除地图包「${name}」？对应文件将被删除。` : `Remove map "${name}"? The file will be deleted.`,
      store.locales === 'zh' ? '移除地图包' : 'Remove map',
      { type: 'warning' }
    )
  } catch {
    return
  }
  try {
    await window.dsh?.mapTiles?.remove?.(id)
    await refreshMapTiles()
    ElMessage.success(store.locales === 'zh' ? '已移除' : 'Removed')
  } catch (e: any) {
    ElMessage.error(store.locales === 'zh' ? '移除失败：' + (e?.message || e) : 'Remove failed: ' + (e?.message || e))
  }
}

// 其它窗口广播主题/语言时跟随（载荷 { ui, locales }；applyThemeFromBroadcast 内含抑制标志，不会回环广播）
const onPeerThemeChanged = (_e: any, payload: any) => {
  store.applyThemeFromBroadcast(payload)
}

// 组件挂载时初始化
onMounted(async () => {
    // Esc 键关闭设置面板
    window.addEventListener('keydown', onSettingsKeydown)

    if (props.standalone) {
      // 独立窗口：顶栏即拖动区，窗口标题显示「设置」
      syncWindowTitle()
      // 独立窗口不持久化标签栏：避免关闭设置窗口时把主窗口的标签写回共享 localStorage
      store.setPersistTabs(false)
      // 同理不持久化主面板导航 mainPanel：否则关闭设置窗口会把主窗口导航覆盖回旧值
      store.setPersistMainPanel(false)
      // 本窗口为「设置写盘方」：每次保存后广播配置变更，主窗口据此重新同步（模型/工具/MCP/预设等）
      store.setSettingsConfigWriter(true)
      // 首次定位（主进程 hash 传入，如从 AgentSwarm 跳「预设」）
      applyNav(props.initialNav || '')
      // 设置窗口已存在时再次被要求跳转（主窗口再次点「设置 → 工具/MCP/技能」等）
      window.ipcRenderer?.on('settings:navigate', (_e: any, nav: string) => applyNav(nav))
      // 其它窗口（主窗口内的设置页）改主题/语言时本窗口跟随（广播载荷 { ui, locales }）
      window.ipcRenderer?.on('theme-changed', onPeerThemeChanged)
    }

    // 同步窗口缩放比例（主进程缩放广播在 App.vue 全局监听，避免重复注册）
    syncWindowZoom()

    // 同步关闭按钮行为（主进程配置为准）
    syncCloseBehavior()

    // 刷新 localStorage 占用统计
    refreshLocalStorageUsage()

    // 检查Python安装状态
    await checkPythonInstallation()
    
    if (store.AIconfig.llm.type === 'ollama') {
      // 先尝试从 localStorage 直接读取保存的模型
      try {
        const savedConfig = localStorage.getItem('AIconfig')
        if (savedConfig) {
          const parsed = JSON.parse(savedConfig)
          if (parsed.llm?.type === 'ollama' && parsed.llm.ollama?.model) {
              const savedModel = parsed.llm.ollama.model
              // 直接设置到 store
              store.AIconfig.llm.ollama.model = savedModel
          }
        }
      } catch (e) {
        console.error('恢复模型失败:', e)
      }
    }

    // 局域网共享/协同/远程文件共享状态已在 CollabSettings 子组件内自行刷新
    // 刷新离线 MBTiles 地图包列表 + 订阅变化
    await refreshMapTiles()
    if (window.dsh?.mapTiles?.onChange) {
      mbUnsub = window.dsh.mapTiles.onChange((list: any) => { mbSources.value = list || [] })
    }
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onSettingsKeydown)
  window.ipcRenderer?.off('theme-changed', onPeerThemeChanged)
  mbUnsub?.()
  mbUnsub = null
  store.saveConfig()
})
</script>

<template>
  <div class="settings-wrap" :class="{ standalone }">
    <!-- 顶部标题栏：标题 + 版本 + 关闭/窗口按钮（独立窗口中整条即为窗口拖动区） -->
    <div class="settings-header" :class="{ 'settings-header-drag': standalone }">
      <span class="settings-header-title">
        <i class="fa fa-cogs"></i>
        {{ store.locales === 'zh' ? '设置' : 'Settings' }}
      </span>
      <!-- 版本信息（弱化显示：默认仅版本号，悬停 title 显示构建时间） -->
      <span class="settings-header-version" :title="buildTimeText ? ((store.locales=='zh' ? '构建时间：' : 'Built: ') + buildTimeText) : ''">
        {{ appVersion }}
      </span>
      <!-- 独立窗口：最小化 / 最大化还原 / 关闭窗口 -->
      <template v-if="standalone">
        <div class="settings-winbtn" @click="minimizeWindow" :title="store.locales === 'zh' ? '最小化' : 'Minimize'">
          <i class="fa fa-minus"></i>
        </div>
        <div class="settings-winbtn" @click="maximizeWindow" :title="isMaximized ? (store.locales === 'zh' ? '向下还原' : 'Restore') : (store.locales === 'zh' ? '最大化' : 'Maximize')">
          <i class="fa" :class="isMaximized ? 'fa-compress' : 'fa-window-maximize'"></i>
        </div>
        <div class="settings-winbtn settings-winbtn-close" @click="closeSettings" :title="store.locales === 'zh' ? '关闭设置' : 'Close settings'">
          <i class="fa fa-times"></i>
        </div>
      </template>
      <div v-else class="settings-close" @click="closeSettings" :title="store.locales === 'zh' ? '关闭设置 (Esc)' : 'Close settings (Esc)'">
        <i class="fa fa-times"></i>
      </div>
    </div>
    <!-- 左侧导航栏 -->
    <div class="settings-container">
    <div class="settings-nav scoll">
      <template v-for="item in navTree" :key="item.id">
        <!-- 一级分组（可折叠，含二级子项） -->
        <div v-if="item.children && item.children.length" class="nav-group">
          <div class="nav-group-header" @click="toggleGroup(item.id)" :title="getTitle(item)">
            <i :class="item.icon || 'fa fa-folder-open-o'"></i>
            <span>{{ getTitle(item) }}</span>
            <i class="fa nav-group-arrow" :class="expandedGroups.has(item.id) ? 'fa-chevron-down' : 'fa-chevron-right'"></i>
          </div>
          <div v-show="expandedGroups.has(item.id)" class="nav-group-children">
            <div
              v-for="child in item.children"
              :key="child.id"
              class="nav-item nav-item-sub"
              :class="{ active: activeNav === child.id }"
              @click="selectNav(child.id)"
              :title="getTitle(child)"
            >
              <i :class="child.icon || 'fa fa-angle-right'"></i>
              <span>{{ getTitle(child) }}</span>
            </div>
          </div>
        </div>
        <!-- 一级叶子项 -->
        <div
          v-else
          class="nav-item"
          :class="{ active: activeNav === item.id }"
          @click="activeNav = item.id"
          :title="getTitle(item)"
        >
          <i :class="item.icon"></i>
          <span>{{ getTitle(item) }}</span>
        </div>
      </template>
    </div>

    <!-- 右侧设置内容 -->
    <div class="settings-content scoll">
      <!-- 系统状态（原「系统配置」改名：Python / 安全策略 / 本地存储等运行状态；随「其他」分区显示） -->
      <div v-if="activeNav === 'other'" class="settings-section">
        <div class="settings-group">
          <h3>{{ store.locales=='zh'?'系统状态' : 'System Status' }}</h3>

          <!-- Python 安装状态 -->
          <div class="form-group">
            <label>{{ store.locales=='zh'?'Python状态' : 'Python Status' }}</label>
            <div class="python-status" :class="{ installed: pythonInstallation.installed, 'not-installed': !pythonInstallation.installed }">
              <i :class="pythonInstallation.installed ? 'fa fa-check-circle' : 'fa fa-times-circle'"></i>
              <span>
                {{ pythonInstallation.installed ? 
                  (store.locales=='zh' ? `已安装 (${pythonInstallation.version})` : `Installed (${pythonInstallation.version})`) : 
                  (store.locales=='zh' ? '未安装' : 'Not installed')
                }}
              </span>
            </div>
          </div>

          <!-- 安全策略（原执行环境） -->
          <div class="form-group">
            <label>{{ store.locales=='zh'?'安全策略' : 'Security Policy' }}</label>
            <div class="environment-selector">
              <div 
                class="environment-option"
                :class="{ active: (store.pythonSandbox || 'workspace') === 'safe' }"
                @click="handleEnvironmentChange('safe')"
                :title="store.locales=='zh' ? '只读沙箱：禁止文件写入、网络请求与子进程，有代码安全检查' : 'Read-only sandbox: blocks file writes, network, and subprocess; with code safety checks'"
              >
                <i class="fa fa-shield"></i>
                <span>{{ store.locales=='zh' ? '只读安全' : 'Read-only' }}</span>
              </div>
              <div 
                class="environment-option"
                :class="{ active: store.pythonSandbox === 'workspace' }"
                @click="handleEnvironmentChange('workspace')"
                :title="store.locales=='zh' ? '工作区沙箱：放行文件读写与网络请求，仍禁止系统级操作（类似 Codex workspace-write）' : 'Workspace sandbox: allows file I/O and network requests, still blocks system-level operations (like Codex workspace-write)'"
              >
                <i class="fa fa-pencil-square-o"></i>
                <span>{{ store.locales=='zh' ? '工作区写入' : 'Workspace' }}</span>
              </div>
              <div 
                class="environment-option"
                :class="{ active: store.pythonSandbox === 'trusted' }"
                @click="handleEnvironmentChange('trusted')"
                :title="store.locales=='zh' ? '完全访问：无限制直接运行，请确保代码来源可信（类似 Codex danger-full-access）' : 'Full access: unrestricted direct execution, ensure code is from trusted sources (like Codex danger-full-access)'"
              >
                <i class="fa fa-unlock"></i>
                <span>{{ store.locales=='zh' ? '完全访问' : 'Full Access' }}</span>
              </div>
            </div>
          </div>

          <!-- 策略描述（原权限策略，由执行环境决定） -->
          <div class="form-group">
            <label>{{ store.locales=='zh'?'策略描述' : 'Policy Description' }}</label>
            <div class="config-description" style="margin-left:0;line-height:1.5;">
              <div v-if="store.pythonSandbox === 'trusted'" class="environment-warning">
                <i class="fa fa-exclamation-triangle"></i>
                <span>{{ store.locales=='zh' ? '警告：此环境无安全限制，请确保代码来源可信' : 'Warning: This environment has no safety restrictions, ensure code is from trusted sources' }}</span>
              </div>
              {{ approvalPolicyLabel }}：{{ approvalPolicyDescription }}
              <br />
              {{ environmentCapabilitySummary }}
            </div>
          </div>

          <!-- 本地存储占用（进度条 + 大小/容量文本） -->
          <div class="form-group">
            <label>{{ store.locales=='zh'?'本地存储' : 'Local Storage' }}</label>
            <div class="storage-usage">
              <div class="storage-bar" :title="localStorageUsageText">
                <div class="storage-bar-fill" :style="{ width: localStoragePct + '%' }"
                     :class="{ warn: localStoragePct > 70, danger: localStoragePct > 90 }"></div>
              </div>
              <span class="storage-text">{{ localStorageUsageText }}</span>
            </div>
          </div>
        </div>

      </div>

      <!-- 协作设置（局域网共享 + 协同文件编辑 + 共享文件夹 + 知识库共享） —— 独立模块 -->
      <CollabSettings v-if="activeNav === 'collab'" :store="store" />

      <!-- 界面设置 -->
      <div v-if="activeNav === 'view'" class="settings-section">
        <div class="settings-group">
          <h3>{{ store.locales=='zh'?'界面' : 'UI' }}</h3>
          <div class="form-group">
            <label>{{ store.locales=='zh'?'语言/Language' : 'Language/语言' }}</label>
            <select v-model="store.locales" @change="store.setLocale(store.locales)">
              <option value="zh">{{ store.locales=='zh'?'中文' : 'Chinese' }}</option>
              <option value="en">{{ store.locales=='zh'?'英文' : 'English' }}</option>
            </select>
          </div>
          <!-- 自定义软件标题：定义后顶部标题固定不变，不再随当前面板变化 -->
          <div class="form-group">
            <label>{{ store.locales=='zh'?'软件标题' : 'Custom Title' }}</label>
            <input v-model="store.customTitle" @change="store.saveConfig()"
                   :placeholder="store.locales=='zh' ? '留空则显示当前面板名称' : 'Leave empty to show current panel name'"/>
          </div>
          <div class="form-group">
            <label>{{ store.locales=='zh'?'导航栏布局' : 'Navbar Layout' }}</label>
            <select v-model="store.UI.navLayout" class="layout-select" @change="store.saveConfig()">
              <option value="top">{{ store.locales=='zh'?'顶部' : 'Top' }}</option>
              <option value="left">{{ store.locales=='zh'?'左侧' : 'Left' }}</option>
              <option value="bottom">{{ store.locales=='zh'?'下方' : 'Bottom' }}</option>
            </select>
            <div class="button fullscreen-btn" @click="toggleFullscreen" :title="store.locales=='zh'?'切换窗口全屏' : 'Toggle window fullscreen'">
              <i class="fa" :class="isFullscreen ? 'fa-compress' : 'fa-expand'"></i>
            </div>
          </div>
          <div class="form-group">
            <label>{{ store.locales=='zh'?'主题' : 'Theme' }}</label>
            <!-- 主题选项由 THEMES 映射表生成（追加「自定义」），新增主题时下拉自动同步 -->
            <select v-model="store.UI.theme" @change="store.changeTheme()">
              <option v-for="t in themeOptions" :key="t" :value="t">
                {{ themeLabel(t) }}
              </option>
            </select>
          </div>
          <!-- 自定义主题色卡（仅「自定义」主题显示；已从系统页移至界面页） -->
          <div v-if="store.UI.theme=='自定义'" class="color-settings">
            <div class="color-grid">
              <div
                v-for="color in customColors"
                :key="color.key"
                class="color-card"
                :title="store.locales=='zh' ? '点击修改' + color.label : 'Click to change ' + color.label"
              >
                <div class="color-card-swatch" :style="{ backgroundColor: store.UI[color.key] }">
                  <input
                    type="color"
                    v-model="store.UI[color.key]"
                    @change="store.changeTheme"
                    :aria-label="color.label"
                  />
                  <i class="fa fa-pencil"></i>
                </div>
                <div class="color-card-info">
                  <span class="color-card-name">{{ color.label }}</span>
                  <span class="color-card-value">{{ store.UI[color.key] }}</span>
                </div>
              </div>
            </div>
          </div>
          <div class="form-group">
            <label>{{ store.locales=='zh'?'窗口缩放' : 'Zoom' }}</label>
            <div class="zoom-control">
              <input type="number" v-model.number="store.UI.windowZoom" min="50" max="200" step="5"
                     @change="onZoomInput"
                     :title="store.locales=='zh'?'缩放比例（50% ~ 200%）' : 'Zoom ratio (50% ~ 200%)'"/>
              <span class="range-value">%</span>
              <div class="button zoom-btn" @click="zoomStep(-10)" :title="store.locales=='zh'?'缩小' : 'Zoom out'">
                <i class="fa fa-search-minus"></i>
              </div>
              <div class="button zoom-btn" @click="zoomStep(10)" :title="store.locales=='zh'?'放大' : 'Zoom in'">
                <i class="fa fa-search-plus"></i>
              </div>
              <div class="button zoom-btn" @click="resetZoom" :title="store.locales=='zh'?'重置为 100%' : 'Reset to 100%'">
                <i class="fa fa-undo"></i>
              </div>
            </div>
          </div>
          <!-- 文件打开方式（自「知识管理」迁入）：新窗口 / 窗口内打开 -->
          <div class="form-group">
            <label>{{ store.locales=='zh' ? '文件打开方式' : 'File Opening' }}</label>
            <select v-model="store.UI.fileOpenMode" class="layout-select" @change="store.saveConfig()">
              <option value="window">{{ store.locales=='zh'?'新窗口打开' : 'New Window' }}</option>
              <option value="inner">{{ store.locales=='zh'?'窗口内打开' : 'Open Inside' }}</option>
            </select>
          </div>
          <!-- 关闭按钮行为：直接退出 / 折叠到托管区（托盘）
               —— 折叠后窗口只是隐藏，后台任务继续运行；鼠标悬停托盘图标可看任务数与进度 -->
          <div class="form-group">
            <label>{{ store.locales=='zh' ? '关闭按钮行为' : 'Close Button' }}</label>
            <select v-model="store.UI.closeToTray" class="layout-select" @change="applyCloseBehavior">
              <option :value="false">{{ store.locales=='zh' ? '直接退出软件' : 'Quit directly' }}</option>
              <option :value="true">{{ store.locales=='zh' ? '折叠到托管区（后台继续运行）' : 'Collapse to tray (keep running)' }}</option>
            </select>
          </div>
          <div class="form-hint">
            {{ store.locales=='zh'
              ? '选择「折叠到托管区」后，点关闭只隐藏窗口、后台任务继续运行；鼠标悬停在托管区图标上可查看运行中的任务数与进度（含每个实例的已完成/总数与预计剩余时间），右键可退出。'
              : 'With “Collapse to tray”, closing only hides the window while background tasks keep running. Hover the tray icon to see running tasks and progress; right-click to quit.' }}
          </div>
          <!-- 路径设置（自「系统」迁入）：工作区 / 工作流 -->
          <div class="settings-group">
            <h3>{{ store.locales=='zh'?'路径设置' : 'Path Settings' }}</h3>
            <div class="form-group workspace-form">
              <label>{{ store.locales=='zh'?'工作区' : 'Workspace' }}</label>
              <!-- 工作区列表 + 添加入口：上下排列 -->
              <div class="workspace-stack">
                <div class="workspace-list" v-if="store.roots.length">
                  <div
                    v-for="root in store.roots"
                    :key="root"
                    class="workspace-item"
                    :class="{ active: root === store.root }"
                    :title="root"
                  >
                    <span class="workspace-path">{{ root }}</span>
                    <div class="workspace-actions">
                      <div class="button workspace-action activate" style="width:20px;" @click="activateWorkspace(root)"
                           :title="store.locales=='zh'?'设为当前工作区' : 'Set as active workspace'">
                        <i class="fa" :class="root === store.root ? 'fa-check-circle' : 'fa-circle-o'"></i>
                      </div>
                      <div class="button workspace-action" style="width:20px;" @click="openWorkspaceFolder(root)"
                           :title="store.locales=='zh'?'在系统文件管理器中打开该工作区文件夹' : 'Open this workspace folder in the file manager'">
                        <i class="fa fa-external-link"></i>
                      </div>
                      <div class="button workspace-action" style="width:20px;" @click="removeWorkspace(root)"
                           :title="store.locales=='zh'?'移除工作区' : 'Remove workspace'">
                        <i class="fa fa-times"></i>
                      </div>
                    </div>
                  </div>
                </div>
                <!-- 添加工作区 -->
                <div class="input-with-button">
                  <input v-model="newWorkspacePath" @keyup.enter="addWorkspaceFromInput"
                         :placeholder="store.locales=='zh'?'输入工作区路径或选择文件夹' : 'Enter path or select folder'"/>
                  <div class="button" style="width:20px;" @click="openFolder" :title="store.locales=='zh'?'选择文件夹并添加' : 'Select folder and add'">
                    <i class="fa fa-folder-open"></i>
                  </div>
                </div>
              </div>
            </div>
            <div class="form-group">
              <label>{{ store.locales=='zh'?'工作流' : 'Workflow' }}</label>
              <div class="input-with-button">
                <input v-model="store.workflowPath" :placeholder="store.locales=='zh'?'请输入工作流文件路径' : 'Enter workflow file path'"/>
                <div class="button" style="width:20px;" @click="openWorkflowFolder" :title="store.locales=='zh'?'选择文件夹' : 'Select Folder'">
                  <i class="fa fa-folder-open"></i>
                </div>
              </div>
            </div>
          </div>
          <!-- 常用操作（自「系统」迁入）：置于路径设置下方；无 label，按钮行占满整行宽度 -->
          <div class="settings-group">
            <h3>{{ store.locales=='zh'?'常用操作' : 'Common Actions' }}</h3>
            <div class="form-group">
              <div class="action-grid">
                <div class="button" @click="openConsole()" :title="store.locales=='zh'?'开发者工具' : 'Developer Tools'">
                  <i class="fa fa-terminal"></i> {{ store.locales=='zh'?'控制台' : 'Console' }}
                </div>
                <div class="button" @click="handleInitConfig" :title="store.locales=='zh'?'初始化（将清除全部配置并重启）\n当前占用：' + localStorageUsageText : 'initialization (clears all config and restarts)\nUsage: ' + localStorageUsageText">
                  <i class="fa fa-refresh"></i> {{ store.locales=='zh'?'初始化' : 'initialization' }}
                </div>
                <div class="button" @click="handleClearChats" :title="store.locales=='zh'?'清空全部聊天记录' : 'Clear all chat history'">
                  <i class="fa fa-trash"></i> {{ store.locales=='zh'?'清空聊天' : 'Clear Chats' }}
                </div>
                <div class="button" @click="handleExportChats" :title="store.locales=='zh'?'导出全部聊天记录为 JSON 备份文件（含分支、消息、知识库来源与工具调用记录）' : 'Export all chats as a JSON backup (branches, messages, KB sources and tool calls included)'">
                  <i class="fa fa-download"></i> {{ store.locales=='zh'?'导出聊天' : 'Export Chats' }}
                </div>
                <div class="button" @click="handleImportChats" :title="store.locales=='zh'?'从 JSON 备份文件导入聊天记录：与现有记录合并，相同 ID 跳过（可重复导入不产生重复）' : 'Import chats from a JSON backup: merged into existing records, same ID skipped (safe to re-import)'">
                  <i class="fa fa-upload"></i> {{ store.locales=='zh'?'导入聊天' : 'Import Chats' }}
                </div>
                <div class="button" @click="handleExportChatsMarkdown" :title="store.locales=='zh'?'导出全部聊天记录为 Markdown（一个文件汇总所有会话，人类可读；图片附件与工具入参不写入，完整备份请用「导出聊天」）' : 'Export all chats as one human-readable Markdown file (image attachments and tool arguments are omitted; use \'Export Chats\' for a full backup)'">
                  <i class="fa fa-file-text-o"></i> {{ store.locales=='zh'?'导出Markdown' : 'Export MD' }}
                </div>
                <div class="button" @click="handleBackupAllData" :title="store.locales=='zh'?'备份全部界面与 AI 配置、Agent 预设、MCP 服务等为一个 JSON 文件（不含聊天记录，聊天请用「导出聊天」）；初始化/换机前建议先备份' : 'Back up all UI & AI config, agent presets and MCP servers into one JSON file (chats excluded, use \'Export Chats\' for those)'">
                  <i class="fa fa-archive"></i> {{ store.locales=='zh'?'备份数据' : 'Backup' }}
                </div>
                <div class="button" @click="handleOpenDataDir" :title="store.locales=='zh'?'在系统文件管理器中打开本机数据目录（配置、缓存、会话日志所在位置）' : 'Open the local data folder (config, cache and session logs) in the file manager'">
                  <i class="fa fa-folder-open-o"></i> {{ store.locales=='zh'?'打开数据目录' : 'Data Folder' }}
                </div>
                <div class="button" @click="handleClearSessionLog" :title="store.locales=='zh'?'清空全部会话日志（智能体/会话的原始事件记录，即「日志」页面的数据源）' : 'Clear all session logs (raw event records shown in the Session Log page)'">
                  <i class="fa fa-list-alt"></i> {{ store.locales=='zh'?'清空会话日志' : 'Clear Logs' }}
                </div>
                <div class="button" @click="handleResetAIconfig" :title="store.locales=='zh'?'恢复默认 AI 配置' : 'Reset AI config to defaults'">
                  <i class="fa fa-undo"></i> {{ store.locales=='zh'?'恢复AI配置' : 'Reset AI' }}
                </div>
                <div class="button" @click="handleCleanUserDataCache" :title="(store.locales=='zh'?'清理本机缓存文件（Cache/Code Cache/GPUCache、Word 预览图片缓存 docx-media 等），只删缓存不动数据/配置。\n当前可清理：':'Clean local cache files (Cache/Code Cache/GPUCache, Word preview images docx-media, etc.). Removes cache only, keeps data & config.\nCleanable: ')+userDataCacheText">
                  <i class="fa fa-eraser"></i> {{ store.locales=='zh'?'清理缓存' : 'Clean Cache' }}
                </div>
              </div>
            </div>
          </div>
          <!-- ① 导航与模块：主界面顶层入口（始终显示）；与界面其它分组一致（标题+说明+配置） -->
          <div class="settings-group">
            <h3>{{ store.locales=='zh' ? '导航与模块' : 'Navigation & Modules' }}</h3>
            <div class="config-description" style="margin:0 0 8px 2px;">{{ store.locales=='zh'
              ? '主界面导航栏显示的顶层模块（主页、知识管理、Agent脚手架等）。关闭某模块即从导航栏隐藏；下方依赖它的子开关（知识管理视图等）也会随之不可用。'
              : 'Top-level modules shown in the navbar (Home, Knowledge, Agent Scaffold…). Hiding a module removes its entry, and its dependent sub-switches below become unavailable too.' }}</div>
            <div class="nav-switch-list">
              <div
                v-for="sw in navSwitches"
                :key="sw.key"
                class="nav-switch-item"
                :class="{ disabled: !store.isNavVisible(sw.key) }"
              >
                <div class="nav-switch-icon" :class="{ muted: !store.isNavVisible(sw.key) }">
                  <i :class="sw.icon"></i>
                </div>
                <div class="nav-switch-info">
                  <span class="nav-switch-name">{{ sw.label }}</span>
                </div>
                <div
                  class="nav-switch-toggle"
                  :class="{ on: store.isNavVisible(sw.key) }"
                  :title="store.isNavVisible(sw.key) ? (store.locales=='zh' ? '点击隐藏' : 'Click to hide') : (store.locales=='zh' ? '点击显示' : 'Click to show')"
                  @click="store.toggleNav(sw.key)"
                >
                  <span class="nav-switch-knob"></span>
                </div>
              </div>
            </div>
          </div>
          <!-- ② 知识管理视图与布局：仅知识管理模块开启时显示（12 项视图 + 布局下拉同属该模块） -->
          <div v-if="store.isNavVisible('知识管理')" class="settings-group">
            <h3>{{ store.locales=='zh' ? '知识管理' : 'Knowledge Management' }}</h3>
            <div class="config-description" style="margin:0 0 8px 2px;">{{ store.locales=='zh'
              ? '知识管理模块的界面配置：可用的视图方式（浏览/编辑/导图/演示等）与视图排布方向（仅「窗口内打开」时生效，打开方式见上方「界面」）。需先在上方「导航与模块」开启「知识管理」。浏览器相关设置（默认页面 / 保存文件夹）请见下方「浏览器」模块。'
              : 'UI configuration of the Knowledge Management module: available view modes (Browse/Edit/Mindmap…) and the layout direction (effective only when files open inside the window; the opening mode lives in "UI" above). Requires Knowledge Management enabled in the block above. Browser-related settings (home page / save folder) live in the Browser module below.' }}</div>
            <!-- 视图布局：置于视图列表上方，样式与界面其它行一致（不加额外边框） -->
            <!-- 视图布局仅「窗口内打开」生效：新窗口打开时 explorer 不再渲染左右/上下分栏，布局无意义 -->
            <div v-if="store.UI.fileOpenMode === 'inner'" class="form-group">
              <label>{{ store.locales=='zh' ? '视图布局' : 'View Layout' }}</label>
              <select v-model="store.UI.layout" class="layout-select">
                <option value="horizontal">{{ store.locales=='zh'?'横向' : 'Horizontal' }}</option>
                <option value="vertical">{{ store.locales=='zh'?'纵向' : 'Vertical' }}</option>
              </select>
            </div>
            <div class="nav-switch-list">
              <div
                v-for="view in viewButtons"
                :key="view.id"
                class="nav-switch-item"
                :class="{ disabled: !store.isView(view.id) }"
              >
                <div class="nav-switch-icon" :class="{ muted: !store.isView(view.id) }">
                  <i :class="view.icon"></i>
                </div>
                <div class="nav-switch-info">
                  <span class="nav-switch-name">{{ store.locales=='zh' ? view.title_zh : view.title_en }}</span>
                </div>
                <div
                  class="nav-switch-toggle"
                  :class="{ on: store.isView(view.id) }"
                  :title="store.isView(view.id) ? (store.locales=='zh' ? '点击关闭' : 'Click to disable') : (store.locales=='zh' ? '点击开启' : 'Click to enable')"
                  @click="store.toggleView(view.id)"
                >
                  <span class="nav-switch-knob"></span>
                </div>
              </div>
            </div>
          </div>
          <!-- 界面配置随软件分发：开启后保存到软件根目录 interface-config.json，便于整机分发 -->
          <div class="form-group">
            <label>{{ store.locales=='zh'?'配置随软件分发' : 'Portable Config' }}</label>
            <div class="portable-config">
              <div
                class="nav-switch-toggle"
                :class="{ on: store.interfaceConfigMode }"
                :title="store.interfaceConfigMode ? (store.locales=='zh' ? '点击关闭' : 'Click to disable') : (store.locales=='zh' ? '点击开启' : 'Click to enable')"
                @click="toggleInterfaceConfig"
              >
                <span class="nav-switch-knob"></span>
              </div>
              <span class="config-description" style="margin-left:6px;">
                {{ store.locales=='zh'
                  ? '开启后界面配置保存到软件根目录 interface-config.json，软件拷贝到其他电脑仍按该配置显示；关闭则仅保存在本机。'
                  : 'When enabled, interface config is saved as interface-config.json next to the app, so it follows the software to other machines; when disabled, it is saved locally only.' }}
              </span>
            </div>
          </div>
          <div class="form-group">
            <label></label>
            <div class="config-description" style="margin-left:0; line-height:1.5;">
              {{ store.locales=='zh'
                ? '使用 Ctrl + / Ctrl - 可随时调整窗口缩放（50% ~ 200%），也可在上方直接输入比例。'
                : 'Use Ctrl + / Ctrl - to adjust window zoom (50% ~ 200%), or type a ratio above.' }}
            </div>
          </div>
        </div>
      </div>

      <!-- 其他（通用/其他）：浏览器 / Word 导出 / 离线地图（MBTiles） -->
      <div v-if="activeNav === 'other'" class="settings-section">
        <!-- ① 浏览器 -->
        <div class="settings-group">
          <h3>{{ store.locales=='zh' ? '浏览器' : 'Browser' }}</h3>
          <div class="config-description" style="margin:0 0 8px 2px;">{{ store.locales=='zh'
            ? '浏览器 Agent 模块设置：「浏览器默认页面」仅从知识管理面板手动打开浏览器时作为首个标签加载（AI 调用不受影响）；「保存文件夹」用于离线保存整页与收藏书签，留空则使用当前工作区根目录。浏览器的页面操作 / AI 控制等选项折叠在浏览器窗口顶部 ⚙ 的右侧设置栏中。'
            : 'Browser Agent module settings: the home page loads as the first tab only when the browser is opened manually from Knowledge Management (AI calls are unaffected); the save folder is used by “Save full page” and bookmarks, falling back to the active workspace root when empty. More page/AI options are folded into the ⚙ side panel inside the browser window.' }}</div>
          <BrowserSettingsPanel />
        </div>
        <!-- ② Word 导出 -->
        <div class="settings-group">
          <h3>{{ store.locales=='zh' ? 'Word 导出' : 'Word Export' }}</h3>
          <div class="config-description" style="margin:0 0 8px 2px;">{{ store.locales=='zh'
            ? '所有「导出为 Word」（知识库文件 / 主页聊天 / Agent Swarm 输出）共用所选模板：公文（GB/T 9704-2012，默认）、中文论文、英文论文（APA 7th）。选择「自定义 Word 模板」后可导入任意 .docx，其正文/标题 1-6 段落样式（字体、字号、颜色、行距）会应用到导出文档；未选择文件时回退公文默认样式。'
            : 'Every "Export to Word" (knowledge files / home chat / Agent Swarm output) shares the selected template: Official (GB/T 9704-2012, default), Chinese Paper, or English Paper (APA 7th). Choose "Custom Word Template" to import any .docx whose body/heading paragraph styles (font, size, color, spacing) are applied to exported documents; if none is picked it falls back to the official style.' }}</div>
          <div class="form-group">
            <label>{{ store.locales=='zh' ? '模板' : 'Template' }}</label>
            <select v-model="store.UI.wordExportTemplate" class="layout-select" @change="store.saveConfig()">
              <option v-for="t in wordExportTemplates" :key="t.key" :value="t.key">
                {{ store.locales=='zh' ? t.labelZh : t.labelEn }}
              </option>
            </select>
          </div>
          <!-- 仅「自定义」模板才需要选择外部 .docx 作为样式来源 -->
          <div v-if="store.UI.wordExportTemplate === 'custom'" class="form-group">
            <label>{{ store.locales=='zh' ? '自定义样式文件' : 'Custom Style File' }}</label>
            <div class="input-with-button">
              <input :value="store.UI.wordExportStylePath" readonly
                     :placeholder="store.locales=='zh' ? '未选择（导出使用公文默认样式）' : 'None (fall back to official style)'"
                     :title="store.UI.wordExportStylePath || (store.locales=='zh' ? '选择 .docx 作为 Word 导出样式' : 'Pick a .docx as Word export style')"/>
              <div class="button" style="width:auto;padding:0 10px;" @click="chooseWordExportStyle"
                   :title="store.locales=='zh' ? '选择 .docx' : 'Pick .docx'">
                <i class="fa fa-folder-open"></i>
              </div>
              <div v-if="store.UI.wordExportStylePath" class="button" style="width:auto;padding:0 10px;" @click="clearWordExportStyle"
                   :title="store.locales=='zh' ? '清除自定义样式' : 'Reset'">
                <i class="fa fa-eraser"></i>
              </div>
            </div>
          </div>
        </div>
        <!-- ③ 离线地图（MBTiles） -->
        <div class="settings-group">
          <h3>{{ store.locales=='zh'?'离线地图（MBTiles）':'Offline Maps (MBTiles)' }}</h3>
          <div class="form-group" v-if="mbSources.length">
            <label>{{ store.locales=='zh'?'已挂载地图包':'Mounted Maps' }}</label>
            <div class="mb-list">
              <div class="mb-item" v-for="src in mbSources" :key="src.id">
                <i class="fa" :class="src.kind==='builtin' ? 'fa-archive' : 'fa-file-archive-o'"
                   :title="src.kind==='builtin' ? (store.locales=='zh'?'内置':'Built-in') : (store.locales=='zh'?'用户挂载':'User')"></i>
                <span class="mb-name" :title="src.name">
                  <span class="mb-text">{{ src.name }}</span>
                  <span class="mb-tag" v-if="src.kind==='builtin'">{{ store.locales=='zh'?'内置':'Built-in' }}</span>
                </span>
                <span class="mb-meta">z{{ src.minZoom }}~{{ src.maxZoom }} · {{ fmtMbSize(src.size) }} · {{ (src.format || '').toUpperCase() }}</span>
                <div class="button mb-remove" v-if="src.kind==='user'" @click="unmountMapTile(src.id, src.name)"
                     :title="store.locales=='zh'?'移除':'Remove'"><i class="fa fa-times"></i></div>
              </div>
            </div>
          </div>
          <div class="form-group">
            <label>{{ store.locales=='zh'?'操作':'Actions' }}</label>
            <div class="button-group">
              <div class="button" @click="mountMapTile"
                   :title="store.locales=='zh'?'选择一个 .mbtiles 文件挂载为离线地图':'Pick a .mbtiles file to mount as offline map'">
                <i class="fa fa-plus"></i> {{ store.locales=='zh'?'挂载新地图':'Mount Map' }}
              </div>
              <div class="button" @click="refreshMapTiles" :title="store.locales=='zh'?'刷新列表':'Refresh list'">
                <i class="fa fa-refresh"></i> {{ store.locales=='zh'?'刷新':'Refresh' }}
              </div>
            </div>
          </div>
          <div class="form-group" v-if="!mbSources.length">
            <div class="config-description" style="margin-left:0">
              {{ store.locales=='zh'
                ? '暂无离线地图包。点击「挂载新地图」选择 .mbtiles 文件即可离线使用（范围/层级取自包内 metadata）。内置地图包随软件分发，无需挂载。'
                : 'No offline map mounted. Click "Mount Map" and pick a .mbtiles file. The built-in map ships with the app.' }}
            </div>
          </div>
          <div class="form-group">
            <div class="config-description" style="margin-left:0">
              {{ store.locales=='zh'
                ? '支持标准 MBTiles（SQLite）格式。挂载后在「地图」视图右键 → 图源 → 离线地图包 中选择使用；文件会复制到应用数据目录。'
                : 'Standard MBTiles (SQLite) supported. Use it in Map view → right-click → Source → Offline Maps. Files are copied to the app data folder.' }}
            </div>
          </div>
        </div>
      </div>

      <!-- 文件关联（默认打开方式）：独立导航分类（通用 → 关联） -->
      <div v-if="activeNav === 'fileassoc'" class="settings-section">
        <FileAssocSettings />
      </div>

      <!-- 大模型设置（独立模块：左右布局，来源列表 + 配置） -->
      <div v-if="activeNav === 'llm'" class="settings-section llm-section">
        <LlmSettings />
      </div>

      <!-- 语音设置（独立组件 TtsSettings.vue） -->
      <div v-if="activeNav === 'tts'" class="settings-section">
        <TtsSettings />
      </div>

      <!-- 语音输入设置（独立组件 AsrSettings.vue） -->
      <div v-if="activeNav === 'asr'" class="settings-section">
        <AsrSettings />
      </div>

      <!-- 帮助 -->
      <div v-if="activeNav === 'help'" class="settings-section">
        <div class="settings-group">
          <div class="form-group">
            <Help />
          </div>
        </div>
      </div>

      <!-- 技能管理 -->
      <div v-if="activeNav === 'agentskill'" class="settings-section skill-section">
        <SkillManagement />
        </div>

        <!-- 技能商店 -->
        <div v-if="activeNav === 'agentskill-store'" class="settings-section skill-section">
          <SkillStore />
      </div>

      <!-- 预设 -->
      <div v-if="activeNav === 'agentpreset'" class="settings-section skill-section">
        <AgentPreset />
      </div>

      <!-- 工具管理 -->
      <div v-if="activeNav === 'tools'" class="settings-section tool-section">
        <ToolSettings />
      </div>

      <!-- 联网搜索源（web_search 工具使用的搜索源配置；多源开关 + 策略，布局同「模型」页） -->
      <div v-if="activeNav === 'search'" class="settings-section llm-section">
        <SearchSettings :store="store" />
      </div>

      <!-- 工具注册表（主进程统一注册表只读视图） -->
      <div v-if="activeNav === 'toolregistry'" class="settings-section tool-section">
        <ToolRegistryPanel />
      </div>

      <!-- MCP 服务管理 -->
      <div v-if="activeNav === 'mcp'" class="settings-section skill-section">
        <McpSettings />
      </div>

      <!-- 智能体控制台（Agent 循环实时执行面板，含后台任务 / 会话事件日志 tab） -->
      <div v-if="activeNav === 'agentconsole'" class="settings-section agent-section">
        <AgentConsole />
      </div>

      <!-- 日志（独立二级菜单，自带头部与清空按钮） -->
      <div v-if="activeNav === 'sessionlog'" class="settings-section agent-section">
        <SessionLogPanel />
      </div>

      <!-- 凭据管理（路线图 2.3：凭据接缝，明文只存主进程） -->
      <div v-if="activeNav === 'credentials'" class="settings-section">
        <CredentialsPanel />
      </div>
    </div>
    </div>
  </div>
</template>

<style scoped>
/* 设置面板整体：标题栏 + 设置内容 */
.settings-wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* 顶部标题栏：标题 + 关闭按钮 */
.settings-header {
  flex-shrink: 0;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding: 0 8px 0 12px;
  background-color: var(--menuColor);
  border: 1px solid var(--borderColor);
  /* 与面板圆角一致，让上边框沿圆角走，避免圆角处被直线切掉 */
  border-top-left-radius: 10px;
  border-top-right-radius: 10px;
  user-select: none;
}

.settings-header-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--fontColor);
}

.settings-header-title i {
  color: var(--fontActiveColor);
}

/* 版本信息（弱化显示：小号、半透明、靠右，位于关闭按钮左侧；默认仅版本号，悬停 title 显示构建时间） */
.settings-header-version {
  margin-left: auto;
  font-size: 11px;
  color: var(--fontColor);
  opacity: 0.55;
  white-space: nowrap;
  user-select: none;
  cursor: default;
}

.settings-close {
  width: 26px;
  height: 26px;
  border-radius: 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--fontColor);
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 14px;
}

/* ====== 独立窗口模式（standalone） ====== */
/* 顶栏即窗口拖动区：整条 -webkit-app-region: drag，交互元素需 no-drag 才能点击 */
.settings-header-drag {
  -webkit-app-region: drag;
  cursor: move;
}

/* 独立窗口按钮（最小化 / 最大化还原 / 关闭） */
.settings-winbtn {
  width: 30px;
  height: 24px;
  margin-left: 2px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--fontColor);
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 12px;
  -webkit-app-region: no-drag;
}

.settings-winbtn:hover {
  color: var(--fontActiveColor);
  background-color: var(--menuActiveColor);
}

.settings-winbtn-close:hover {
  background-color: #e81123;
  color: #fff;
}

/* 独立窗口铺满整个无边框窗口：去掉浮层的圆角与四周描边 */
.settings-wrap.standalone .settings-header {
  border-radius: 0;
  border-left: none;
  border-right: none;
  border-top: none;
}

.settings-wrap.standalone .settings-container {
  border-radius: 0;
  border-left: none;
  border-right: none;
  border-bottom: none;
}

.settings-wrap.standalone .settings-nav {
  border-bottom-left-radius: 0;
}

.settings-container {
  flex: 1;
  min-height: 0;
  display: flex;
  background-color: var(--backgroundColor);
  border: 1px solid var(--borderColor);
  border-top: none; /* 标题栏已有下边框，去掉重复上边框 */
  /* 与面板圆角一致，让下边框沿圆角走 */
  border-bottom-left-radius: 10px;
  border-bottom-right-radius: 10px;
}

.settings-nav {
  width: 170px;
  height: calc(100% - 10px);
  background-color: var(--menuColor);
  border-right: 1px solid var(--borderColor);
  display: flex;
  flex-direction: column;
  padding: 5px 5px;
  user-select: none;
  overflow-y: auto;
  /* 与容器/面板圆角一致，避免左下角直角露出 */
  border-bottom-left-radius: 10px;
}

/* ====== 一级分组（可折叠） ====== */
.nav-group {
  display: flex;
  flex-direction: column;
}
.nav-group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px 6px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: var(--fontColor);
  cursor: pointer;
  user-select: none;
  opacity: 0.8;
  transition: opacity 0.2s;
}
.nav-group-header:hover {
  opacity: 1;
}
.nav-group-header i {
  font-size: 14px;
  width: 20px;
  text-align: center;
}
.nav-group-header span {
  flex: 1;
  white-space: nowrap;
}
.nav-group-arrow {
  flex: 0 0 auto;
  width: auto !important;
  font-size: 12px !important;
  transition: transform 0.2s;
}
.nav-group-children {
  display: flex;
  flex-direction: column;
  margin: 0 0 4px 14px;
  padding-left: 6px;
  border-left: 1px solid var(--borderColor);
}

.nav-item {
  display: flex;
  align-items: center;
  padding: 8px 10px;
  margin-bottom: 5px;
  color: var(--fontColor);
  cursor: pointer;
  border-radius: 5px;
  transition: all 0.2s ease;
  gap: 10px;
}

.nav-item:hover {
  background-color: var(--menuActiveColor);
}

.nav-item.active {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}

.nav-item i {
  font-size: 12px;
  width: 16px;
  text-align: center;
}

.nav-item span {
  font-size: 13px;
  white-space: nowrap;
}

/* ====== 二级子项 ====== */
.nav-item-sub {
  padding: 7px 10px;
  margin-bottom: 3px;
  position: relative;
}
.nav-item-sub i {
  font-size: 12px;
  width: 16px;
}
.nav-item-sub span {
  font-size: 13px;
}
.nav-item-sub.active::before {
  content: '';
  position: absolute;
  left: -2px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 16px;
  border-radius: 2px;
  background: var(--fontActiveColor);
}

.settings-content {
  flex: 1;
  overflow-x: hidden;
  overflow-y: auto;
  height: calc(100% - 0px);
  /* 与容器/面板圆角一致，避免右下角直角露出 */
  border-bottom-right-radius: 10px;
}

.settings-group {
  margin-bottom: 5px;
  padding: 8px;
}

.settings-group:last-child {
  margin-bottom: 0;
}

.settings-group h3 {
  position: relative;
  color: var(--fontActiveColor);
  margin: 0 0 10px 0;
  padding: 0 0 8px 10px;
  border-bottom: 1px solid var(--borderColor);
  font-size: 14px;
  font-weight: 600;
}

.settings-group h3::before {
  content: '';
  position: absolute;
  left: 0;
  top: 3px;
  bottom: 9px;
  width: 3px;
  border-radius: 2px;
  background: var(--fontActiveColor);
}

/* 嵌套分组（路径设置 / 常用操作 / 导航与模块等）不再二次内缩：
   否则行宽会比父级「界面」各行窄 16px，输入框看起来不一致 */
.settings-group .settings-group {
  padding-left: 0;
  padding-right: 0;
}

/* 大语言模型设置（独立模块）：占满设置内容区 */
.llm-section {
  height: 100%;
  min-height: 0;
}
.llm-section :deep(.llm-settings),
.llm-section :deep(.ws-settings) {
  height: 100%;
  min-height: 0;
}

/* Agent 技能/预设管理：占满设置内容区 */
.skill-section {
  height: 100%;
  min-height: 0;
}
.skill-section :deep(.agent-skill),
.skill-section :deep(.agent-preset),
.skill-section :deep(.mcp-settings) {
  height: 100%;
  min-height: 0;
}

/* 工具管理 / 工具注册表：占满设置内容区（列表内部滚动） */
.tool-section {
  height: 100%;
  min-height: 0;
}
.tool-section :deep(.tool-settings),
.tool-section :deep(.tool-registry-panel) {
  height: 100%;
  min-height: 0;
}

/* 智能体控制台 / 会话事件日志：占满设置内容区 */
.agent-section {
  height: 100%;
  min-height: 0;
}
.agent-section :deep(.agent-console),
.agent-section :deep(.session-log-panel) {
  height: 100%;
  min-height: 0;
}

/* 表单组样式 */
.form-group {
  display: flex;
  align-items: center;
  margin-bottom: 5px;
}

/* 统一清零 form-group 内元素的 margin（防止全局样式污染导致行高超出） */
.form-group > * {
  margin: 0;
}

.form-group:last-child {
  margin-bottom: 0;
}

.form-group label {
  width: 120px;
  min-width: 120px;
  color: var(--fontColor);
  font-size: 14px;
  user-select: none;
  line-height: 1;
  flex-shrink: 0;
}

/* 设置项下方的补充说明（如「关闭按钮行为」的效果说明）：左对齐到输入框起点 */
.form-hint {
  padding-left: 120px;
  margin: -2px 0 6px 0;
  font-size: 11px;
  line-height: 1.5;
  color: #8a8f98;
  user-select: none;
}

.form-group input,
.form-group textarea {
  flex: 1;
  padding: 2px 4px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--menuColor);
  color: var(--fontColor);
  font-size: 14px;
  transition: border-color 0.2s ease;
  margin: 0px
}
/* 下拉框用正常背景色（不用菜单底色） */
.form-group select {
  background-color: var(--backgroundColor);
}
/* 统一输入框/下拉框高度（border-box 33px），与常用操作按钮、安全策略选项一致 */
.form-group input,
.form-group select {
  height: 33px;
  box-sizing: border-box;
}
/* 还原滑块自身高度，避免被上方统一高度破坏（checkbox 已有 16px 规则覆盖） */
.form-group input[type="range"] {
  height: auto;
}

.form-group input:focus,
.form-group select:focus,
.form-group textarea:focus {
  outline: none;
  border-color: var(--fontActiveColor);
}

.form-group input[type="range"] {
  flex: 1;
  margin-right: 10px;
}

.form-group input[type="checkbox"] {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin-right: 10px;
}

.form-group input[type="password"] {
  letter-spacing: 1px;
}

/* 带按钮的输入框 */
.input-with-button {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: stretch;
  gap: 5px;
}
/* input-with-button 内部：输入框占满剩余空间，按钮不溢出、与控件等高 */
.input-with-button > input,
.input-with-button > select {
  flex: 1;
  min-width: 0;
  margin: 0;
}
.input-with-button > .button {
  flex-shrink: 0;
  height: auto;
  align-self: stretch;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  padding: 0 6px;
  margin: 0;
  width: auto; /* 覆盖 .button 的 width: calc(100% - 20px) */
}

/* 工作区：label 左侧，列表与添加入口上下排列，样式与下方标准 input-with-button 统一 */
.workspace-form {
  align-items: flex-start;
}
.workspace-stack {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.workspace-stack .workspace-list {
  flex: none;
  width: 100%;
}
/* 添加入口行：与下方（工作流/集群路径）标准样式一致 —— input 自带边框，外层容器不包裹 */
.workspace-stack .input-with-button {
  flex: none;
  width: 100%;
}

/* 工作区列表（多工作区管理） */
.workspace-list {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
/* 工作区项：仿 input-with-button —— 内容（路径）仿输入框边框 + 右侧按钮，外层无边框 */
.workspace-item {
  display: flex;
  align-items: stretch;
  gap: 5px;
}
/* 覆盖全局 .active 背景（rgb 76,76,76）：激活项不加背景，仅按钮高亮标识 */
.workspace-item.active {
  background-color: transparent;
}
/* 当前激活工作区：不加背景，仅「设为当前」按钮高亮标识 */
.workspace-item.active .workspace-action.activate {
  color: var(--fontActiveColor);
  border-color: var(--fontActiveColor);
}
/* 路径仿输入框样式（与 .form-group input 完全一致：全局 height 27px + padding 2px 4px） */
.workspace-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  color: var(--fontColor);
  padding: 2px 4px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--menuColor);
  height: 27px;
  line-height: 27px;
}
.workspace-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
/* 工作区项内按钮：与 input-with-button 内按钮样式一致（拉伸、紧凑内边距） */
.workspace-action {
  flex-shrink: 0;
  height: auto;
  align-self: stretch;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  padding: 0 6px;
  margin: 0;
  width: auto;
}

/* 带滑块的值显示 */
.input-with-slider {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
}

.slider-value {
  min-width: 30px;
  text-align: center;
  color: var(--fontColor);
  font-size: 14px;
}

/* 按钮带状态 */
.button-with-status {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
}

.status-text {
  color: var(--fontActiveColor);
  font-size: 14px;
}

/* 状态指示器 */
.status-indicator {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 5px;
  font-size: 14px;
}

.status-indicator.online {
  background-color: rgba(46, 204, 113, 0.2);
  color: #2ecc71;
  border: 1px solid rgba(46, 204, 113, 0.3);
}

.status-indicator.offline {
  background-color: rgba(231, 76, 60, 0.2);
  color: #e74c3c;
  border: 1px solid rgba(231, 76, 60, 0.3);
}

.status-indicator i {
  font-size: 16px;
}

/* 配置描述文本 */
.config-description {
  flex: 1;
  font-size: 10px;
  color: var(--fontColor);
  opacity: 0.7;
  margin-left: 5px;
}

/* 语音设置 */
.voice-settings {
  width: 100%;
}

.range-value {
  min-width: 40px;
  text-align: center;
  color: var(--fontColor);
  font-size: 14px;
}

/* ====== 开关区块分组（界面页三套开关：导航模块 / 实例类型 / 知识管理视图。
   三者同用 nav-switch-item 行，靠「区块标题条 + 底色」区分层级归属，避免混淆） ====== */
.module-block {
  display: flex;
  flex-direction: column;
  width: 100%;
  box-sizing: border-box;
  margin-bottom: 8px;
  padding: 8px 10px;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  background: color-mix(in srgb, var(--menuColor) 55%, transparent);
}
.module-block-head {
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px dashed var(--borderColor);
}
.module-block-title-row { display: flex; align-items: center; gap: 8px; }
.module-block-bar {
  width: 3px;
  height: 15px;
  border-radius: 2px;
  background: var(--fontActiveColor);
  flex-shrink: 0;
}
.module-block-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--fontActiveColor);
  user-select: none;
}
.module-block-title i { margin-right: 5px; }
.module-block-desc {
  display: block;
  margin: 5px 0 0 11px;
  font-size: 11px;
  color: var(--fontColor);
  opacity: 0.8;
  line-height: 1.5;
}
/* 区块内开关网格铺满整行（column 布局下取消 flex:1 的纵向拉伸） */
.module-block .nav-switch-list { flex: none; width: 100%; }
/* 区块内联行（如「视图布局」下拉） */
.module-block-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.module-block-inline > span {
  flex-shrink: 0;
  /* 区块内多行下拉的标签统一宽度，保证下拉起始列对齐（8em≈96px，容纳中英文最长标签） */
  width: 8em;
  font-size: 12px;
  color: var(--fontColor);
  user-select: none;
  white-space: nowrap;
}
.module-block-inline select {
  flex: 1;
  min-width: 0;
  height: 33px;
  box-sizing: border-box;
  padding: 2px 4px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 14px;
}
.module-block-inline select:focus { outline: none; border-color: var(--fontActiveColor); }

/* ====== 功能开关（导航栏按钮显示/隐藏，样式参照工具管理模块） ====== */
.nav-switch-list {
  flex: 1;
  min-width: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 6px;
  align-content: start;
}
.nav-switch-item {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 8px;
  border: 1px solid var(--borderColor); border-radius: 5px;
  background: var(--menuColor);
  transition: all .12s;
  min-width: 0;
}
.nav-switch-item:hover { border-color: var(--fontActiveColor); }
.nav-switch-item.disabled { opacity: 0.55; }
.nav-switch-icon {
  width: 32px; height: 32px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent);
  border-radius: 5px; color: var(--fontActiveColor); font-size: 15px;
}
.nav-switch-icon.muted { background: color-mix(in srgb, var(--fontColor) 8%, transparent); color: var(--fontColor); }
.nav-switch-info { flex: 1; min-width: 0; }
.nav-switch-name { font-size: 12px; font-weight: 600; }
.nav-switch-toggle {
  width: 30px; height: 16px; border-radius: 8px; flex-shrink: 0;
  background: var(--borderColor); position: relative; cursor: pointer;
  transition: all .15s;
}
.nav-switch-toggle .nav-switch-knob {
  position: absolute; top: 2px; left: 2px;
  width: 12px; height: 12px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25);
  transition: all .15s;
}
.nav-switch-toggle.on { background: var(--fontActiveColor); }
.nav-switch-toggle.on .nav-switch-knob { left: 16px; }

/* 协作面板的开关：单列占满一行，高度与下方输入元素一致（紧凑版） */
.collab-switch-list {
  flex: 1;
  min-width: 0;
  display: grid;
  grid-template-columns: 1fr;
  gap: 0;
}
.nav-switch-item.compact {
  padding: 1px 8px;
  height: 36px;
  box-sizing: border-box;
  align-items: center;
}
.nav-switch-item.compact .nav-switch-icon {
  width: 18px;
  height: 18px;
  font-size: 11px;
  border-radius: 4px;
}
.nav-switch-item.compact .nav-switch-info {
  display: flex;
  align-items: center;
}
.nav-switch-item.compact .nav-switch-name {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 界面配置随软件分发开关行 */
.portable-config {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 布局方向下拉（置于 label 右侧，与其它输入框一致） */
.layout-select {
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
}

/* 窗口缩放控制：输入框 + 步进/重置按钮 */
.zoom-control {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 5px;
}
.zoom-control > input {
  flex: 1;
  min-width: 0;
}
.zoom-control .zoom-btn {
  flex-shrink: 0;
  width: auto;
  height: 30px;
  min-width: 24px;
  padding: 0 6px;
  margin: 0;
}
.zoom-control .range-value {
  min-width: auto;
  flex-shrink: 0;
}

/* ====== 自定义主题色卡 ====== */
.color-settings {
  /* 与表单输入列对齐：标签位置留空，卡片整体右移 120px（label 宽度） */
  margin-left: 130px;
  /* 与下方「常用操作」等表单分隔 */
  margin-bottom: 5px;
  width: calc(100% - 130px);
  box-sizing: border-box;
}

.color-grid {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 5px;
}

.color-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px;
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  background-color: var(--menuColor);
  box-sizing: border-box;
  transition: border-color 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
  cursor: pointer;
}

.color-card:hover {
  border-color: var(--fontActiveColor);
  transform: translateY(-1px);
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.12);
}

/* 色块：覆盖透明原生取色器，点击任意处唤起取色 */
.color-card-swatch {
  position: relative;
  flex: 0 0 42px;
  height: 42px;
  border-radius: 8px;
  border: 2px solid var(--borderColor);
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

.color-card-swatch input[type="color"] {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  padding: 0;
  margin: 0;
  border: none;
  opacity: 0;
  cursor: pointer;
}

/* 悬停时显示画笔徽标（白底保证任意色块上都可见） */
.color-card-swatch i {
  position: relative;
  z-index: 1;
  font-size: 12px;
  color: #333;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.8);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.2s ease;
  pointer-events: none;
}

.color-card:hover .color-card-swatch i {
  opacity: 1;
}

.color-card-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.color-card-name {
  font-size: 13px;
  color: var(--fontColor);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.color-card-value {
  font-size: 12px;
  color: var(--fontColor);
  opacity: 0.65;
  font-family: Consolas, 'Courier New', monospace;
  letter-spacing: 0.3px;
  user-select: all;
}

/* 操作按钮网格：按可用宽度自动分列（每列不小于按钮最小宽度，宽屏可整排放下，窄屏自动换行） */
.action-grid {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 5px;
}
/* 覆盖 .button 默认宽度/高度，让按钮填满网格单元格并与上方输入框组等高（box-sizing 防止 padding/border 撑出单元格导致重叠） */
.action-grid .button {
  width: 100%;
  box-sizing: border-box;
  height: 33px; /* 与 .form-group input/select 及安全策略选项一致 */
  padding: 0 6px;
}
/* 本地存储占用：进度条 + 大小/容量文本 */
.storage-usage {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.storage-bar {
  flex: 1;
  min-width: 0;
  height: 8px;
  border-radius: 4px;
  background-color: var(--borderColor);
  overflow: hidden;
  position: relative;
  cursor: default;
}
.storage-bar-fill {
  height: 100%;
  border-radius: 4px;
  background-color: var(--fontActiveColor);
  transition: width 0.3s ease;
}
.storage-bar-fill.warn {
  background-color: #e6a23c;
}
.storage-bar-fill.danger {
  background-color: #e74c3c;
}
.storage-text {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--fontColor);
  opacity: 0.85;
  white-space: nowrap;
  user-select: all;
}

.button {
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--menuColor);
  color: var(--fontColor);
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-size: 14px;
  white-space: nowrap;
  width:calc(100% - 20px);
  margin:0px;
  padding: 6px 6px;
}

.button:hover {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}

.button.active {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
  border-color: var(--fontActiveColor);
}

.button i {
  font-size: 14px;
}

/* 按钮组样式 */
.button-group {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 8px;
}
/* 让按钮恰好填满网格单元格、右缘对齐；不引入 box-sizing，保持原有高度（全局 .button height:23px content-box）不变 */
.button-group .button {
  /* calc(100% - 14px) 抵消 .button 的 padding(6px*2) + border(1px*2)，使 border-box 宽度恰为 100% */
  width: calc(100% - 14px);
}

/* 操作与状态同行：按钮组占左侧，状态指示器靠右，不再单独占一行 */
.action-with-status {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: stretch;
  gap: 8px; /* 与按钮组内部按钮间隔一致，保证元素间隔相同 */
}
.action-with-status .button-group {
  flex: 1;
}
/* 行内按钮：统一高度 33px（border-box），恰好填满网格单元格 */
.action-with-status .button-group .button {
  height: 33px;
  box-sizing: border-box;
  width: 100%;
}
/* 状态指示器：与按钮等高（33px），内容垂直居中 */
.action-with-status .status-indicator {
  flex: none;
  margin-left: auto;
  white-space: nowrap;
  height: 33px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  padding: 0 12px;
}

/* 响应式调整 */
@media (max-width: 600px) {
  .settings-nav {
    width: 40px;
    min-width: 40px;
  }
  
  .nav-item span {
    display: none;
  }
  
  .nav-item {
    justify-content: center;
    padding: 10px 10px;
  }

  /* 窄模式：隐藏一级分组，二级全部展开 */
  .nav-group-header {
    display: none;
  }
  .nav-group-children {
    display: flex !important; /* 覆盖 v-show 折叠，二级始终展开 */
    margin-left: 0;
    padding-left: 0;
    border-left: none;
  }
  .nav-item-sub {
    justify-content: center;
    padding: 4px 0;
  }
  .nav-item-sub i {
    font-size: 13px;
    width: 22px;
    height: 22px;
    line-height: 22px;
    color: var(--fontColor);
  }
  .nav-item-sub.active::before {
    display: none;
  }
  
  .form-group {
    display: grid;
    /* 显式单列占满整行：避免隐式 auto 列宽度不确定 */
    grid-template-columns: 1fr;
  }
  
  .form-group label {
    width: 100%;
  }

  /* select/input/textarea 是替换元素，grid 默认的 justify-self:stretch 对它们不生效，
     需显式 width:100% 才能占满整行，保证右侧与其它行对齐（正常模式靠 flex:1，不受影响） */
  .form-group > input,
  .form-group > select,
  .form-group > textarea {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    justify-self: stretch;
  }
  
  .config-description {
    margin-left: 0;
    margin-top: 5px;
  }
  
  .action-grid {
    grid-template-columns: repeat(2, 1fr);
  }

  .color-grid {
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 6px;
    margin-bottom: 5px;
  }

  .color-card-swatch {
    flex-basis: 36px;
    height: 36px;
  }

  /* 窄屏表单改为上下堆叠，取消左缩进，色卡占满整行 */
  .color-settings {
    margin-left: 0;
    width: 100%;
  }
  
  .button-group {
    grid-template-columns: repeat(2, 1fr);
  }
  
  .voice-settings .form-group {
    flex-direction: row;
    align-items: center;
  }
  
  .voice-settings .form-group label {
    width: 80px;
    min-width: 80px;
  }
  
  .input-with-slider {
    flex-direction: column;
    align-items: stretch;
    gap: 5px;
  }
  
  .slider-value {
    align-self: flex-end;
  }
}

/* Python状态指示器 */
.python-status {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 5px;
  font-size: 14px;
}

.python-status.installed {
  background-color: rgba(46, 204, 113, 0.2);
  color: #2ecc71;
  border: 1px solid rgba(46, 204, 113, 0.3);
}

.python-status.not-installed {
  background-color: rgba(231, 76, 60, 0.2);
  color: #e74c3c;
  border: 1px solid rgba(231, 76, 60, 0.3);
}

.python-status i {
  font-size: 16px;
}

/* 环境选择器 */
.environment-selector {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.environment-option {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  height: 33px; /* 与输入框/常用操作按钮高度统一 */
  box-sizing: border-box;
  padding: 0 10px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--menuColor);
  color: var(--fontColor);
  cursor: pointer;
  transition: all 0.2s ease;
  gap: 6px;
  white-space: nowrap;
}

.environment-option:hover {
  background-color: var(--menuActiveColor);
}

.environment-option.active {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
  border-color: var(--fontActiveColor);
}

.environment-option i {
  font-size: 16px;
}

.environment-option span {
  font-size: 14px;
  font-weight: 500;
  text-align: center;
}

/* 环境警告 */
.environment-warning {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  margin: 8px 0px;
  background-color: rgba(230, 162, 60, 0.15);
  border: 1px solid rgba(230, 162, 60, 0.3);
  border-radius: 6px;
  color: #e6a23c;
}

.environment-warning i {
  font-size: 16px;
}

.environment-warning span {
  font-size: 13px;
  font-weight: 500;
}

/* 环境测试 */
.environment-test {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.test-controls {
  display: flex;
  gap: 8px;
}

.test-result {
  padding: 6px;
  border-radius: 6px;
}

.test-result.success {
  background-color: rgba(46, 204, 113, 0.1);
  border: 1px solid rgba(46, 204, 113, 0.2);
}

.test-result.error {
  background-color: rgba(231, 76, 60, 0.1);
  border: 1px solid rgba(231, 76, 60, 0.2);
}

.result-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.result-header i {
  font-size: 16px;
}

.result-header i.fa-check-circle {
  color: #2ecc71;
}

.result-header i.fa-times-circle {
  color: #e74c3c;
}

.result-header strong {
  color: var(--fontActiveColor);
  font-size: 14px;
}

.result-content {
  max-height: 200px;
  overflow-y: auto;
  background-color: var(--backgroundColor);
  border-radius: 4px;
  padding: 10px;
}

.result-content pre {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  white-space: pre-wrap;
  word-wrap: break-word;
  color: var(--fontColor);
}

/* 包管理 */
.package-management {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 包搜索框 */
.package-search {
  position: relative;
  width: 100%;
}

.package-search input {
  width: calc(100% - 36px);
  padding: 4px 4px 4px 30px;
  margin: 0px;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  background-color: var(--menuColor);
  color: var(--fontColor);
  font-size: 14px;
  transition: all 0.2s ease;
}

.package-search i {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--fontColor);
  opacity: 0.6;
}

/* 安装状态 */
.installation-status {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background-color: rgba(52, 152, 219, 0.15);
  border: 1px solid rgba(52, 152, 219, 0.3);
  border-radius: 6px;
  color: #3498db;
}

.installation-status i {
  font-size: 16px;
}

.installation-status span {
  font-size: 14px;
  font-weight: 500;
}

/* 包列表容器 */
.package-list-container {
  max-height: 300px;
  overflow-y: auto;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  background-color: var(--menuColor);
}

/* 空包状态 */
.empty-packages {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  color: var(--fontColor);
  opacity: 0.6;
  gap: 12px;
}

.empty-packages i {
  font-size: 48px;
}

.empty-packages span {
  font-size: 14px;
  text-align: center;
}

/* 包项 */
.package-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 4px;
  border-bottom: 1px solid var(--borderColor);
  transition: all 0.2s ease;
}

.package-item:hover {
  background-color: var(--menuActiveColor);
}

.package-item:last-child {
  border-bottom: none;
}

.package-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.package-name {
  color: var(--fontActiveColor);
  font-size: 14px;
  font-weight: 600;
}

.package-version {
  color: var(--fontColor);
  font-size: 12px;
  opacity: 0.7;
}

.package-actions {
  display: flex;
  gap: 8px;
}

.button.small {
  width: auto;
  padding: 6px 10px;
  font-size: 12px;
}

/* 加载中 */
.loading-packages {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  color: var(--fontColor);
  gap: 12px;
}

.loading-packages i {
  font-size: 24px;
}

.loading-packages span {
  font-size: 14px;
}

/* 包数量信息 */
.package-count {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background-color: var(--backgroundColor);
  border-radius: 6px;
  border: 1px solid var(--borderColor);
}

.package-count i {
  color: var(--fontActiveColor);
  font-size: 14px;
}

.package-count span {
  color: var(--fontColor);
  font-size: 13px;
}

/* 响应式调整 */
@media (max-width: 600px) {
  /* 小窗下保持 3 列并排（与正常模式一致），不降为单列 */
  .environment-selector {
    grid-template-columns: repeat(3, 1fr);
  }
  
  .environment-option {
    padding: 10px 10px;
  }
  
  .environment-option i {
    font-size: 18px;
  }
  
  .environment-option span {
    font-size: 14px;
  }
  
  .package-item {
    flex-direction: row;
    align-items: flex-start;
    gap: 10px;
  }
  
  .package-actions {
    align-self: flex-end;
  }
  
  .test-controls {
    flex-direction: column;
  }
}

/* ASR 语音输入设置 */
.shortcut-input {
  flex: 1;
  display: flex;
  gap: 5px;
  align-items: center;
}

.shortcut-input input {
  cursor: pointer;
  background-color: var(--menuColor);
  user-select: none;
}

.shortcut-input input:focus {
  border-color: var(--fontActiveColor);
  background-color: var(--backgroundColor);
}

.shortcut-input input::selection {
  background: transparent;
}

.checkbox-group {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 14px;
  color: var(--fontColor);
}

.checkbox-label input[type="checkbox"] {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin: 0;
  cursor: pointer;
}

/* ASR 测试按钮录音状态 */
.button.recording {
  background-color: #e74c3c !important;
  color: white !important;
  border-color: #c0392b !important;
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% {
    transform: scale(1);
    box-shadow: 0 0 0 0 rgba(231, 76, 60, 0.4);
  }
  50% {
    transform: scale(1.02);
    box-shadow: 0 0 0 10px rgba(231, 76, 60, 0);
  }
}

/* fa-fade 动画（Font Awesome自带） */
.fa-fade {
  animation: fa-fade 1.5s ease-in-out infinite;
}

/* 局域网地址显示 */
.lan-addresses {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.lan-address-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background-color: var(--backgroundColor);
  border: 1px solid var(--borderColor);
  border-radius: 5px;
}

.lan-address-item i {
  color: var(--fontActiveColor);
  font-size: 14px;
}

.lan-address-item code {
  flex: 1;
  min-width: 0;
  word-break: break-all;
  color: var(--fontActiveColor);
  font-size: 13px;
  font-weight: 600;
  background: none;
  user-select: all;
  cursor: pointer;
}
.lan-link-code:hover { text-decoration: underline; }

.lan-host-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--fontColor);
}
.lan-host-label code {
  font-size: 13px;
  font-weight: 600;
  color: var(--fontActiveColor);
  background: none;
  user-select: all;
  cursor: pointer;
}

/* 连接信息统一“复制”按钮（三个协作连接样式一致） */
.lan-copy-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  color: var(--fontActiveColor);
  background: var(--menuColor);
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s;
}
.lan-copy-btn:hover { background: var(--menuActiveColor); }
.lan-copy-btn:active { opacity: 0.7; }

/* ONNX 模型状态 */
.onnx-model-status {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 5px;
  font-size: 14px;
  background-color: rgba(46, 204, 113, 0.1);
  border: 1px solid rgba(46, 204, 113, 0.2);
  color: #2ecc71;
}

.onnx-model-status.loading {
  background-color: rgba(52, 152, 219, 0.1);
  border: 1px solid rgba(52, 152, 219, 0.2);
  color: #3498db;
}

.onnx-model-status i {
  font-size: 16px;
}
.fullscreen-btn{
  width: 24px;
  height: 17px;
  margin-left:5px; 
}

/* 离线地图（MBTiles）列表 */
.mb-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}
.mb-item {
  height: 33px; /* 与 .button / .form-group input、select 高度统一（border-box） */
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  background: var(--menuColor);
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  white-space: nowrap;
}
.mb-item > .fa {
  color: var(--primaryColor);
  flex-shrink: 0;
}
.mb-name {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
}
.mb-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mb-tag {
  font-size: 10px;
  color: var(--primaryColor);
  border: 1px solid var(--borderColor);
  border-radius: 3px;
  padding: 0 3px;
  flex-shrink: 0;
}
.mb-meta {
  font-size: 11px;
  color: var(--borderColor);
  flex-shrink: 0;
}
.mb-remove {
  width: auto;
  margin: 0;
  padding: 0 8px;
  flex-shrink: 0;
}
</style>