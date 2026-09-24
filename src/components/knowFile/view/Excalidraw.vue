<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { createRoot, type Root } from 'react-dom/client'
import * as React from 'react'
import { Excalidraw, serializeAsJSON } from '@excalidraw/excalidraw'
import { ElMessage } from 'element-plus'
import { usestore } from '@/store'
import { useCollabExcalidraw } from '@/composables/useCollabExcalidraw'
import { cleanExcalidrawAppState } from '@/shared/excalidrawAppState'

const store = usestore()

const props = defineProps<{
  path: string
  content?: string
}>()

// ---- 协同文件编辑（局域网实时多人，Excalidraw 白板） ----
const collab = useCollabExcalidraw()
const showCollabPanel = ref(false)
const collabJoinUrl = ref('')
const collabJoinName = ref('')
const collabServerStatus = ref<{ running: boolean; port: number; ips: string[] }>({ running: false, port: 0, ips: [] })
let collabStatusUnsub: (() => void) | null = null
let collabUnmounting = false

const collabEnabled = computed(() => store.collab.enabled)
const isCollabActive = computed(() => collab.status.value !== 'idle')

const collabJoinLink = computed(() => {
  if (!collab.roomId.value) return ''
  const port = collabServerStatus.value.port || store.collab.port
  const ip = collabServerStatus.value.ips[0] || '127.0.0.1'
  const token = store.collab.token
  return `ws://${ip}:${port}/collab/${collab.roomId.value}?token=${encodeURIComponent(token)}`
})

const collabIcon = () => {
  if (collab.status.value === 'connecting') return 'fa fa-spinner fa-spin'
  return 'fa fa-users'
}

// 打开面板时预填客户端名称
watch(showCollabPanel, (v) => {
  if (v && !collabJoinName.value.trim()) collabJoinName.value = store.collab.nickname || ''
})

// 会话结束回调：恢复可编辑并提示（主动离开不提示）
collab.onClosed((reason) => {
  if (excalidrawApi) {
    try {
      const cur = excalidrawApi.getAppState()
      excalidrawApi.updateScene({ appState: { ...cur, viewModeEnabled: false } })
    } catch { /* ignore */ }
  }
  if (reason !== 'left' && !collabUnmounting) {
    ElMessage.warning(store.locales === 'zh' ? ('协同会话结束: ' + reason) : ('Collab session ended: ' + reason))
  }
  showCollabPanel.value = false
})

/** 确保协同服务已启动 */
const ensureCollabServer = async (): Promise<boolean> => {
  if (!window.dsh?.collab) {
    ElMessage.error(store.locales === 'zh' ? '协同服务不可用（请先在设置中开启）' : 'Collab service unavailable')
    return false
  }
  try {
    const st = await window.dsh.collab.getStatus()
    if (st.running) {
      collabServerStatus.value = st
      return true
    }
    const res = await window.dsh.collab.start({
      port: store.collab.port,
      maxMembers: store.collab.maxMembers,
      permissionMode: store.collab.permissionMode,
    })
    if (res.success) {
      if (res.port) store.collab.port = res.port
      const st2 = await window.dsh.collab.getStatus()
      collabServerStatus.value = st2
      return true
    }
    ElMessage.error(store.locales === 'zh' ? ('协同服务启动失败: ' + res.error) : ('Collab start failed: ' + res.error))
    return false
  } catch (e: any) {
    ElMessage.error(store.locales === 'zh' ? ('协同服务启动失败: ' + e.message) : ('Collab start failed: ' + e.message))
    return false
  }
}

/** 宿主共享当前白板 */
const shareCurrentFile = async () => {
  if (!excalidrawApi || !props.path) return
  if (isCollabActive.value) {
    showCollabPanel.value = true
    return
  }
  if (!(await ensureCollabServer())) return
  const content = JSON.stringify({
    elements: excalidrawApi.getSceneElements(),
    appState: excalidrawApi.getAppState(),
    files: excalidrawApi.getFiles(),
  })
  const ok = await collab.startHost(excalidrawApi, props.path, content, {
    token: store.collab.token || undefined,
    maxMembers: store.collab.maxMembers,
    permissionMode: store.collab.permissionMode,
    autoSaveSeconds: store.collab.autoSaveSeconds,
    name: store.collab.nickname.trim() || '主机',
  })
  if (ok) {
    if (!store.collab.token && collab.roomToken.value) {
      store.collab.token = collab.roomToken.value
      store.saveConfig()
    }
    const st = await window.dsh?.collab.getStatus()
    if (st) collabServerStatus.value = st
    showCollabPanel.value = true
    ElMessage.success(store.locales === 'zh' ? '已开始共享，可复制加入地址' : 'Sharing started, copy the join link')
  } else {
    ElMessage.error(store.locales === 'zh' ? ('共享失败: ' + (collab.error.value || '未知错误')) : ('Share failed: ' + (collab.error.value || 'Unknown error')))
  }
}

/** 客户端加入会话 */
const joinCollabSession = async () => {
  if (!excalidrawApi) return
  if (isCollabActive.value) return
  const url = collabJoinUrl.value.trim()
  if (!url) {
    ElMessage.warning(store.locales === 'zh' ? '请输入加入地址' : 'Enter the join address')
    return
  }
  const typedName = collabJoinName.value.trim()
  const clientName = typedName || store.collab.nickname.trim() || '访客'
  if (typedName && typedName !== store.collab.nickname) {
    store.collab.nickname = typedName
    store.saveConfig()
  }
  const ok = await collab.join(excalidrawApi, url, clientName)
  if (ok) {
    showCollabPanel.value = true
    ElMessage.success(store.locales === 'zh' ? '已加入协同会话' : 'Joined collab session')
  } else {
    ElMessage.error(store.locales === 'zh' ? ('加入失败: ' + (collab.error.value || '未知错误')) : ('Join failed: ' + (collab.error.value || 'Unknown error')))
  }
}

/** 退出会话 */
const leaveCollabSession = async () => {
  const wasHost = collab.isHost.value
  const rid = collab.roomId.value
  collab.leave()
  if (wasHost && rid && window.dsh?.collab) {
    await window.dsh.collab.closeRoom(rid).catch(() => {})
  }
  showCollabPanel.value = false
}

/** 切换协同面板 */
const toggleCollabPanel = () => {
  if (!collabEnabled.value) return
  showCollabPanel.value = !showCollabPanel.value
}

/** 复制加入地址 */
const copyCollabLink = () => {
  if (!collabJoinLink.value) return
  navigator.clipboard.writeText(collabJoinLink.value)
    .then(() => ElMessage.success(store.locales === 'zh' ? '加入地址已复制' : 'Join link copied'))
    .catch(() => {})
}

/** 宿主批准/拒绝编辑请求 */
const respondEditRequest = (memberId: string, grant: boolean) => {
  if (grant) collab.grantEdit(memberId)
  else collab.denyEdit(memberId)
  collab.clearEditRequest(memberId)
}

/** 指针移动：计算场景坐标并广播自己的光标（仅协同会话中） */
const onPointerMove = (e: PointerEvent) => {
  if (!isCollabActive.value || !excalidrawApi || !containerRef.value) return
  try {
    // 用 Excalidraw 官方换算：viewportCoordsToSceneCoords
    //   x = (clientX - offsetLeft) / zoom - scrollX
    // 注意 scrollX/scrollY 要在除以 zoom 之后才减（它们是场景坐标偏移，不随缩放放大）
    const appState = excalidrawApi.getAppState()
    const zoom = appState?.zoom?.value || 1
    const scrollX = appState?.scrollX || 0
    const scrollY = appState?.scrollY || 0
    const offsetLeft = appState?.offsetLeft || 0
    const offsetTop = appState?.offsetTop || 0
    const x = (e.clientX - offsetLeft) / zoom - scrollX
    const y = (e.clientY - offsetTop) / zoom - scrollY
    collab.handlePointerMove(x, y)
  } catch { /* ignore */ }
}

const containerRef = ref<HTMLDivElement | null>(null)

let root: Root | null = null
let excalidrawApi: any = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
// 初始化阶段 scrollToContent 会触发一次 onChange，忽略该次以免打开即改写文件
let skipNextChange = true

// 解析 .excalidraw 初始数据
function parseInitialData() {
  const empty = { elements: [] as any[], appState: {} as any, files: {} as any }
  if (!props.content) return empty
  try {
    const json = JSON.parse(props.content)
    return {
      elements: Array.isArray(json.elements) ? json.elements : [],
      // ⚠️ 必须过滤运行时 appState 键（如 collaborators）：历史文件里可能残留 "collaborators": {}，
      // 直接喂给 Excalidraw 会让 UserList 执行 collaborators.forEach 抛错 → 整块白板渲染失败
      appState: cleanExcalidrawAppState(json.appState),
      files: json.files || {}
    }
  } catch {
    return empty
  }
}

// ---- 渲染兜底：React 错误边界 ----
// Excalidraw 内部（React）渲染异常会让整个白板变成空白且无提示，
// 这里包一层错误边界：捕获后交给 Vue 侧显示「出错 + 重试」，不影响其它界面。
const renderError = ref('')
class ExcalidrawBoundary extends React.Component<{ children?: React.ReactNode }, { failed: boolean }> {
  constructor(props: any) {
    super(props)
    this.state = { failed: false }
  }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: any) {
    console.error('[Excalidraw] 渲染异常，已降级为错误提示:', error)
    renderError.value = error?.message ? String(error.message) : String(error)
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

// 根据应用背景色亮度判断深色/浅色主题
function isDarkTheme() {
  const bg = store.UI.backgroundColor || '#ffffff'
  const hex = String(bg).replace('#', '')
  if (hex.length < 6) return true
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return r * 0.299 + g * 0.587 + b * 0.114 < 128
}

const theme = computed<'light' | 'dark'>(() => (isDarkTheme() ? 'dark' : 'light'))

// 应用主题切换时同步 Excalidraw 画布主题（官方 updateScene 方式，保留画布/撤销/选中状态）
watch(theme, (val) => {
  if (!excalidrawApi) return
  try {
    excalidrawApi.updateScene({ appState: { theme: val } })
  } catch { /* ignore */ }
})

// 嵌入网页校验：Excalidraw 内置只允许少数白名单域名，这里放开所有 http/https 链接。
// 如需限制，可改为域名数组，例如：['example.com', /\.wikipedia\.org$/]
const validateEmbeddable = (url: string) => /^https?:\/\//i.test(url)

// Excalidraw 内置支持嵌入的站点（YouTube/Vimeo/Figma/Twitter/Gist/Giphy 等）交给内置渲染，
// 其余网页统一用带 allow-same-origin 的沙箱渲染，避免 cookie/localStorage 被沙箱拦截。
const BUILTIN_EMBED_HOSTS = new Set([
  'youtube.com', 'youtu.be', 'vimeo.com', 'player.vimeo.com', 'figma.com',
  'twitter.com', 'x.com', 'gist.github.com', 'val.town', 'giphy.com',
  'simplepdf.eu', 'stackblitz.com', 'link.excalidraw.com'
])

const isBuiltinEmbedHost = (link: string) => {
  try {
    return BUILTIN_EMBED_HOSTS.has(new URL(link).hostname.replace(/^www\./, ''))
  } catch {
    return false
  }
}

// 判断被嵌入网址是否与应用同源：同源时不加 allow-same-origin，避免第三方内容越权访问宿主页面
const isSameOriginAsApp = (link: string) => {
  try {
    return new URL(link, window.location.href).origin === window.location.origin
  } catch {
    return false
  }
}

// 自定义嵌入渲染：给第三方网页补上 allow-same-origin，使其 cookie/localStorage/domain 正常工作
const renderEmbeddable = (element: any) => {
  const link = element.link || ''
  if (!link || isBuiltinEmbedHost(link)) return null
  const sandbox = isSameOriginAsApp(link)
    ? 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation allow-downloads'
    : 'allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation allow-downloads'
  return React.createElement('iframe', {
    className: 'excalidraw__embeddable',
    src: link,
    sandbox,
    allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture',
    allowFullScreen: true,
    referrerPolicy: 'no-referrer-when-downgrade',
    scrolling: 'no',
    title: 'Embedded Content'
  } as any)
}

// 写入 .excalidraw 文件；silent=true 时静默（自动保存不弹提示）
function persist(json: string, silent = false) {
  const name = props.path.split(/[\\/]/).pop() || ''
  window.ipcRenderer
    .invoke('saveFile', props.path, json)
    .then((ok: boolean) => {
      if (ok) {
        const cur = store.data[store.index]
        if (cur && cur.path === props.path) {
          cur.content = json
        }
        if (!silent) {
          ElMessage.success((store.locales === 'zh' ? '已保存到 ' : 'Saved to ') + name)
        }
      } else if (!silent) {
        ElMessage.error(store.locales === 'zh' ? '保存失败' : 'Save failed')
      }
    })
    .catch((e: any) => {
      console.error('[Excalidraw] 保存失败:', e)
      if (!silent) ElMessage.error(store.locales === 'zh' ? '保存失败' : 'Save failed')
    })
}

// 防抖自动保存：编辑后 800ms 静默写回文件（协同会话中由主机服务端写盘，这里跳过）
function scheduleSave(elements: any, appState: any, files: any) {
  if (isCollabActive.value) return
  if (skipNextChange) {
    skipNextChange = false
    return
  }
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      // 写盘前过滤运行时 appState（避免把 collaborators 这类 Map 写成 {} 污染文件）
      persist(serializeAsJSON(elements, cleanExcalidrawAppState(appState), files, 'local'), true)
    } catch (e) {
      console.error('[Excalidraw] 序列化失败:', e)
    }
  }, 800)
}

// 手动保存（Ctrl+S）：协同会话中仅主机可保存；否则立即写回当前打开的文件
function saveNow() {
  if (!excalidrawApi) return
  if (isCollabActive.value) {
    if (!collab.isHost.value) {
      ElMessage.warning(store.locales === 'zh' ? '仅主机可保存，请请求主机保存' : 'Only the host can save')
      return
    }
    collab.save().then((ok) => {
      if (ok) {
        ElMessage.success(store.locales === 'zh' ? '已同步保存到主机' : 'Saved (host)')
      } else {
        ElMessage.warning(store.locales === 'zh' ? '保存请求失败' : 'Save request failed')
      }
    })
    return
  }
  // 取消未触发的自动保存，避免旧数据覆盖刚保存的结果
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  try {
    const elements = excalidrawApi.getSceneElements()
    const appState = excalidrawApi.getAppState()
    const files = excalidrawApi.getFiles()
    persist(serializeAsJSON(elements, cleanExcalidrawAppState(appState), files, 'local'), false)
  } catch (e) {
    console.error('[Excalidraw] 保存失败:', e)
    ElMessage.error(store.locales === 'zh' ? '保存失败' : 'Save failed')
  }
}

// 拦截 Ctrl+S：阻止 Excalidraw 默认的下载行为，改为保存到当前文件
function handleKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
    e.preventDefault()
    e.stopPropagation()
    saveNow()
  }
}

// 挂载 Excalidraw（用错误边界包一层，内部渲染异常时降级为提示 + 可重试）
function mountExcalidraw() {
  if (!containerRef.value) return
  const initial = parseInitialData()
  renderError.value = ''
  root = createRoot(containerRef.value)
  root.render(
    React.createElement(
      ExcalidrawBoundary,
      null,
      React.createElement(
        Excalidraw,
        {
          initialData: {
            elements: initial.elements,
            appState: initial.appState,
            files: initial.files,
            scrollToContent: true
          },
          theme: theme.value,
          langCode: store.locales === 'zh' ? 'zh-CN' : 'en',
          //zenModeEnabled: true,
          validateEmbeddable,
          renderEmbeddable,
          onChange: (elements: any, appState: any, files: any) => {
            if (isCollabActive.value) {
              collab.handleSceneChange(elements, appState, files)
              return
            }
            scheduleSave(elements, appState, files)
          },
          excalidrawAPI: (api: any) => {
            excalidrawApi = api
          }
        } as any
      )
    )
  )
}

// 渲染兜底后的「重试」：卸载旧 React 树后重新挂载（初始数据会重新解析，已过滤坏字段）
async function retryRenderExcalidraw() {
  try { root?.unmount() } catch { /* ignore */ }
  root = null
  excalidrawApi = null
  renderError.value = ''
  await nextTick()
  mountExcalidraw()
}

onMounted(() => {
  if (!containerRef.value) return
  mountExcalidraw()
  window.addEventListener('keydown', handleKeydown, true)
  // 指针移动：协同会话中广播自己的光标（场景坐标）
  containerRef.value.addEventListener('pointermove', onPointerMove, true)
  // 订阅协同服务状态（用于生成可复制的加入地址）
  if (window.dsh?.collab) {
    collabStatusUnsub = window.dsh.collab.onStatus((st: any) => {
      collabServerStatus.value = st
    })
  }
})

onBeforeUnmount(() => {
  collabUnmounting = true
  // 退出协同会话
  if (isCollabActive.value) {
    const wasHost = collab.isHost.value
    const rid = collab.roomId.value
    collab.destroy()
    if (wasHost && rid && window.dsh?.collab) {
      window.dsh.collab.closeRoom(rid).catch(() => {})
    }
  }
  if (collabStatusUnsub) {
    collabStatusUnsub()
    collabStatusUnsub = null
  }
  window.removeEventListener('keydown', handleKeydown, true)
  if (containerRef.value) {
    containerRef.value.removeEventListener('pointermove', onPointerMove, true)
  }
  if (saveTimer) clearTimeout(saveTimer)
  excalidrawApi = null
  if (root) {
    root.unmount()
    root = null
  }
})
</script>

<template>
  <div class="excalidraw-collab-wrap">
    <div ref="containerRef" class="excalidraw-wrap"></div>

    <!-- 渲染兜底：Excalidraw 内部异常时给出提示与重试（避免整块白板空白且无提示） -->
    <div v-if="renderError" class="excalidraw-fallback">
      <i class="fa fa-exclamation-triangle"></i>
      <div class="excalidraw-fallback-title">{{ store.locales === 'zh' ? '白板渲染出错' : 'Whiteboard failed to render' }}</div>
      <div class="excalidraw-fallback-msg">{{ renderError }}</div>
      <button class="excalidraw-fallback-btn" @click="retryRenderExcalidraw">
        <i class="fa fa-refresh"></i> {{ store.locales === 'zh' ? '重试' : 'Retry' }}
      </button>
    </div>

    <!-- 协同入口按钮（右下角） -->
    <button v-if="collabEnabled" class="excalidraw-collab-btn" :class="{ active: isCollabActive }" @click.stop="toggleCollabPanel" :title="isCollabActive ? (store.locales=='zh'?'协同会话进行中，点击查看':'Collab session active, click to view') : (store.locales=='zh'?'协同编辑':'Collaboration')">
      <i :class="collabIcon()"></i>
      <span v-if="isCollabActive && collab.members.value.length" class="collab-badge">{{ collab.members.value.length }}</span>
    </button>

    <!-- 协同编辑面板（右下角） -->
    <div v-if="collabEnabled && showCollabPanel" class="excalidraw-collab-panel" @click.stop>
      <div class="collab-panel-head">
        <span><i class="fa fa-users"></i> {{ store.locales=='zh'?'协同编辑':'Collaboration' }}</span>
        <button class="collab-close" @click="showCollabPanel = false" :title="store.locales=='zh'?'关闭':'Close'">×</button>
      </div>

      <!-- 未连接：共享 / 加入 -->
      <template v-if="!isCollabActive">
        <button class="collab-primary-btn" @click="shareCurrentFile">
          <i class="fa fa-share-alt"></i> {{ store.locales=='zh'?'共享此白板':'Share this board' }}
        </button>
        <div class="collab-divider">{{ store.locales=='zh'?'创建协同房间，复制加入地址给其他成员或加入会话':'Create a room and share the join link or join a session' }}</div>
        <div class="collab-field">
          <label>{{ store.locales=='zh'?'加入地址':'Join URL' }}</label>
          <input v-model="collabJoinUrl" :placeholder="store.locales=='zh'?'ws://ip:端口/collab/房间号?token=…':'ws://ip:port/collab/room?token=…'"/>
        </div>
        <div class="collab-field">
          <label>{{ store.locales=='zh'?'昵称':'Name' }}</label>
          <input v-model="collabJoinName" :placeholder="store.locales=='zh'?'显示给其他成员':'Shown to others'"/>
        </div>
        <button class="collab-primary-btn" @click="joinCollabSession">
          <i class="fa fa-sign-in"></i> {{ store.locales=='zh'?'加入会话':'Join' }}
        </button>
      </template>

      <!-- 会话中 -->
      <template v-else>
        <div class="collab-status-row">
          <span class="collab-status-dot" :class="{ on: collab.status.value === 'connected' }"></span>
          <span>{{ collab.status.value === 'connecting' ? (store.locales=='zh'?'连接中…':'Connecting…') : (store.locales=='zh'?'已连接':'Connected') }}</span>
          <span v-if="isCollabActive" class="collab-role">
            {{ collab.isHost.value ? (store.locales=='zh'?'主机':'Host') : (collab.canEdit.value ? (store.locales=='zh'?'可编辑':'Editor') : (store.locales=='zh'?'只读':'Reader')) }}
          </span>
        </div>

        <!-- 主机：可复制的加入地址 -->
        <div v-if="collab.isHost.value && collabJoinLink" class="collab-field">
          <label>{{ store.locales=='zh'?'加入地址':'Join URL' }}</label>
          <div class="collab-link-row">
            <code class="collab-link">{{ collabJoinLink }}</code>
            <button class="collab-mini-btn" @click="copyCollabLink" :title="store.locales=='zh'?'复制':'Copy'"><i class="fa fa-copy"></i></button>
          </div>
        </div>

        <!-- 成员列表 -->
        <div class="collab-members">
          <div class="collab-members-title">{{ store.locales=='zh'?('成员 (' + collab.members.value.length + ')') : ('Members (' + collab.members.value.length + ')') }}</div>
          <div v-for="m in collab.members.value" :key="m.id" class="collab-member">
            <span class="collab-color" :style="{ backgroundColor: m.color }"></span>
            <span class="collab-member-name">{{ m.name }}</span>
            <span class="collab-member-role">{{ m.role === 'host' ? (store.locales=='zh'?'主机':'Host') : (m.role === 'editor' ? (store.locales=='zh'?'编辑':'Ed') : (store.locales=='zh'?'只读':'R')) }}</span>
          </div>
        </div>

        <!-- 主机：待批准的编辑请求 -->
        <div v-if="collab.isHost.value && collab.pendingEditRequests.value.length" class="collab-requests">
          <div class="collab-members-title">{{ store.locales=='zh'?'编辑请求':'Edit requests' }}</div>
          <div v-for="r in collab.pendingEditRequests.value" :key="r.id" class="collab-member">
            <span class="collab-color" :style="{ backgroundColor: r.color }"></span>
            <span class="collab-member-name">{{ r.name }}</span>
            <button class="collab-mini-btn ok" @click="respondEditRequest(r.id, true)" :title="store.locales=='zh'?'批准':'Approve'"><i class="fa fa-check"></i></button>
            <button class="collab-mini-btn no" @click="respondEditRequest(r.id, false)" :title="store.locales=='zh'?'拒绝':'Deny'"><i class="fa fa-times"></i></button>
          </div>
        </div>

        <!-- 只读成员：请求编辑权 -->
        <button v-if="!collab.canEdit.value && !collab.isHost.value" class="collab-primary-btn" @click="collab.requestEdit()">
          <i class="fa fa-pencil"></i> {{ store.locales=='zh'?'请求编辑权':'Request edit' }}
        </button>

        <!-- 操作 -->
        <div class="collab-actions">
          <button class="collab-mini-btn" @click="saveNow()" :title="store.locales=='zh'?'保存到主机':'Save to host'"><i class="fa fa-floppy-o"></i> {{ store.locales=='zh'?'保存':'Save' }}</button>
          <button class="collab-mini-btn leave" @click="leaveCollabSession" :title="store.locales=='zh'?'退出会话':'Leave session'"><i class="fa fa-sign-out"></i> {{ store.locales=='zh'?'退出':'Leave' }}</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.excalidraw-collab-wrap {
  position: absolute;
  inset: 0;
}
.excalidraw-wrap {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  background: var(--backgroundColor, #ffffff);
}
/* 渲染兜底提示（Excalidraw 内部 React 渲染异常时显示） */
.excalidraw-fallback {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  background: var(--backgroundColor, #ffffff);
  color: var(--fontColor, #333);
  box-sizing: border-box;
}
.excalidraw-fallback > i {
  font-size: 30px;
  color: #e6a23c;
}
.excalidraw-fallback-title {
  font-size: 14px;
  font-weight: 600;
}
.excalidraw-fallback-msg {
  font-size: 12px;
  opacity: 0.7;
  max-width: 560px;
  word-break: break-all;
  line-height: 1.6;
}
.excalidraw-fallback-btn {
  width: auto;
  margin-top: 4px;
  padding: 5px 14px;
  font-size: 12px;
  border: 1px solid var(--borderColor, #ccc);
  border-radius: 4px;
  background: var(--menuColor, #f5f5f5);
  color: var(--fontColor, #333);
  cursor: pointer;
}
.excalidraw-fallback-btn:hover {
  background: var(--menuActiveColor, #eaeaea);
}

/* 协同入口按钮（右下角浮层，Vue 模板元素，用应用 UI 变量与整体界面一致） */
.excalidraw-collab-btn {
  position: absolute;
  right: 12px;
  bottom: 12px;
  z-index: 30;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  border: 1px solid var(--borderColor);
  background-color: var(--menuColor);
  color: var(--fontColor);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.excalidraw-collab-btn:hover {
  background-color: var(--menuActiveColor);
}
.excalidraw-collab-btn i {
  font-size: 15px;
  pointer-events: none;
}
.excalidraw-collab-btn.active {
  color: #42b883;
}
.collab-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 7px;
  background: #42b883;
  color: #fff;
  font-size: 10px;
  line-height: 14px;
  position: absolute;
  top: -4px;
  right: -4px;
}

/* 协同面板（右下角下拉，位于按钮上方） */
.excalidraw-collab-panel {
  position: absolute;
  right: 12px;
  bottom: 56px;
  top: auto;
  z-index: 30;
  width: 276px;
  max-height: 72%;
  overflow-y: auto;
  background: var(--menuColor);
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  padding: 7px 9px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
  color: var(--fontColor);
}
.collab-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
  font-size: 13px;
}
.collab-panel-head .collab-close {
  background: transparent;
  border: none;
  color: var(--fontColor);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.7;
  padding: 0 2px;
}
.collab-primary-btn {
  width: 100%;
  padding: 3px 8px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background: var(--inputColor);
  color: var(--fontColor);
  cursor: pointer;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}
.collab-primary-btn:hover {
  background: var(--menuActiveColor);
}
.collab-divider {
  text-align: center;
  font-size: 10px;
  opacity: 0.6;
  margin: 1px 0;
}
.collab-field {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
.collab-field label {
  font-size: 10px;
  opacity: 0.75;
  min-width: 48px;
  flex-shrink: 0;
  white-space: nowrap;
  padding:0px
}
.collab-field input {
  flex: 1;
  min-width: 0;
  width: auto;
  box-sizing: border-box;
  padding: 2px 6px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--inputColor);
  color: var(--fontColor);
  font-size: 12px;
  margin: 0px
}
.collab-link-row {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: 1;
  min-width: 0;
}
.collab-link {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  background: var(--inputColor);
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  padding: 2px 5px;
}
.collab-status-row {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
}
.collab-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #f56c6c;
  flex-shrink: 0;
}
.collab-status-dot.on {
  background: #42b883;
}
.collab-role {
  margin-left: auto;
  font-size: 10px;
  opacity: 0.8;
  border: 1px solid var(--borderColor);
  border-radius: 3px;
  padding: 0 4px;
  white-space: nowrap;
}
.collab-members {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 130px;
  overflow-y: auto;
}
.collab-members-title {
  font-size: 10px;
  opacity: 0.7;
}
.collab-member {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 1px 0;
}
.collab-color {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
}
.collab-member-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.collab-member-role {
  font-size: 9px;
  opacity: 0.65;
}
.collab-requests {
  display: flex;
  flex-direction: column;
  gap: 3px;
  border-top: 1px dashed var(--borderColor);
  padding-top: 5px;
}
.collab-actions {
  display: flex;
  gap: 6px;
  border-top: 1px dashed var(--borderColor);
  padding-top: 5px;
}
.collab-mini-btn {
  padding: 2px 6px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--inputColor);
  color: var(--fontColor);
  font-size: 11px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.collab-mini-btn:hover {
  background: var(--menuActiveColor);
}
.collab-mini-btn.ok {
  color: #42b883;
}
.collab-mini-btn.no {
  color: #f56c6c;
}
.collab-mini-btn.leave {
  color: #e6a23c;
}

/* 项目全局样式给所有 label 加了 padding:5px / line-height:30px，
   Excalidraw 的工具栏按钮 <label class="ToolIcon"> 会被污染导致布局与官方不一致，
   这里在 Excalidraw 作用域内重置为浏览器默认值 */
:deep(.excalidraw label) {
  padding: 0;
  line-height: inherit;
}

/* 局域网集成使用：隐藏 Excalidraw 自带但不必要的 UI
   - .main-menu-trigger         ：左上角主菜单按钮（导出/保存等，本集成用不到）
   - .default-sidebar          ：右侧素材库侧边栏（在线库无用）
   - .layer-ui__wrapper__footer-left / .help-icon ：左下角帮助等图标
   - footer.App-toolbar        ：窗口较窄时底部出现的撤销/重做/复制/删除工具条
     （注意只隐藏 footer 那个；顶部工具栏也在 .App-toolbar 类名下，不能误删） */
:deep(.excalidraw .main-menu-trigger),
:deep(.excalidraw .default-sidebar),
:deep(.excalidraw .default-sidebar-trigger),
:deep(.excalidraw .layer-ui__wrapper__footer-left),
:deep(.excalidraw .help-icon),
:deep(.excalidraw footer.App-toolbar) {
  display: none !important;
}
</style>
