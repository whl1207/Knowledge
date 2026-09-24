<script setup lang="ts">
/**
 * Drawio.vue — draw.io 图表（.drawio / .dio / .drawio.xml，及内容像图表的 .xml）查看与编辑
 *
 * 集成方式：把 drawio webapp 随应用打包（public/drawio → dist/drawio，见
 * scripts/fetch-drawio-webapp.mjs），用 drawio **官方 embed 模式 + JSON 协议**作为宿主，
 * 不依赖 drawio 内部实现（同源可达，后续做实时协同时可再叠加 diffSync 协议）：
 *
 *   configure 事件 → 宿主回 { action:'configure', config }
 *   init      事件 → 宿主回 { action:'load', xml, autosave:1 }（编辑器就绪）
 *   load      事件 → 图已加载（此后可交互）
 *   autosave  事件 → 宿主防抖 800ms 写盘（内容签名不变则跳过）
 *   save      事件 → 宿主立即写盘（drawio 内 Ctrl+S / 保存按钮）
 *   exit      事件 → 已隐藏退出按钮，忽略
 *
 * 写盘策略：drawio 回传的是完整 <mxfile>，**原样写回**，不做压缩/解压
 *（压缩过的老文件由 drawio 自身解压加载，首次改动后文件变为未压缩格式）。
 *
 * 只读模式（远程文件 / 预览）：不请求 autosave、忽略 save 事件，并用覆盖层阻断交互。
 */
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import { usestore } from '@/store'
import { DRAWIO_ASSET_DIR, newDrawioXml } from '@/shared/drawioFile'
import { useCollabDrawio, type DrawioCollabBridge } from '@/composables/useCollabDrawio'
import {
  buildDrawioMessages,
  collectDrawioContext,
  extractGraphFragment,
  mergeDrawioFragment,
  type DrawioMergeResult,
} from '@/shared/drawioAi'
import { installDrawioExportBridge, exportFilters, type DrawioExportHost } from '@/shared/drawioExportBridge'

const props = defineProps<{
  /** 文件绝对路径（写盘目标） */
  path: string
  /** 文件文本内容（首次加载喂给 drawio） */
  content?: string
  /** 只读预览（远程文件等）：禁止写盘并阻断编辑器交互 */
  readonly?: boolean
}>()

const store = usestore()

const frameRef = ref<HTMLIFrameElement | null>(null)
/** iframe 地址：仅挂载/重载时构建，主题切换等不重建（避免未保存内容丢失） */
const frameSrc = ref('')
/** 已收到 load 响应（编辑器渲染完成） */
const ready = ref(false)
/** 加载失败提示（看门狗超时 / 已收到错误） */
const fatal = ref('')

const zh = computed(() => store.locales === 'zh')
const fileName = computed(() => props.path.split(/[\\/]/).pop() || '')
/** 是否有未落盘的改动（已取消自动保存：编辑只改内存，Ctrl+S / 保存按钮才写盘） */
const dirty = ref(false)
/** 导出桥的跨调用状态（window.print 兜底需要记住 EditorUi 实例） */
const exportBridgeState: { ui?: any } = {}
/** 是否存在 Electron IPC：局域网浏览器模式下没有，也就无法写盘 */
const hasIpc = typeof window !== 'undefined' && !!(window as any).ipcRenderer

// ---- 协同编辑（局域网实时多人，走 drawio 官方 diff 协议）----
const collab = useCollabDrawio()
const showCollabPanel = ref(false)
const collabJoinUrl = ref('')
const collabJoinName = ref('')
const collabServerStatus = ref<{ running: boolean; port: number; ips: string[] }>({ running: false, port: 0, ips: [] })
/** 协同权限决定的编辑可达性：只读成员阻断交互（由 bridge.setEditable 更新） */
const collabEditable = ref(true)
const collabEnabled = computed(() => store.collab.enabled)
const isCollabActive = computed(() => collab.status.value !== 'idle')

/** 有效只读 = 显式只读（远程文件等）/ 没有 IPC 写不了盘 / 协同只读成员 */
const readonlyMode = computed(() => !!props.readonly || !hasIpc || !collabEditable.value)
/** 是否可写盘（协同会话中由宿主统一写盘） */
const canWrite = computed(() => !readonlyMode.value && !isCollabActive.value)

// ---- 智能操作（AI 生成图形 → 画布预览 → 确认写入）----
const showAiPanel = ref(false)
const aiInput = ref('')
const aiBusy = ref(false)
/** 流式收到的字符数（onStream 累加，中英文按 UTF-16 字符计） */
const aiStreamLen = ref(0)
/** 流式分块数：=1 说明接口整包返回（非流式），此时数字会一次性跳变，UI 要说明白 */
const aiStreamChunks = ref(0)
const aiBodyRef = ref<HTMLElement | null>(null)
/** retryReq：本条失败信息对应的原始需求（非空时在气泡里给「重试」按钮） */
const aiMessages = ref<Array<{ role: 'user' | 'assistant'; text: string; retryReq?: string }>>([])
/** 智能操作模式：auto=允许新增/调整/删除（由模型自己判断）；add=仅新增（不动已有图形） */
const aiMode = ref<'auto' | 'add'>('auto')
/** 预览态：AI 已合并出新 XML 并加载进编辑器，但尚未写盘 */
const aiPreview = ref<{
  xml: string
  backup: string
  backupSig: string
  added: number
  updated: number
  removed: number
  labels: string[]
  edgeLabels: string[]
  updatedLabels: string[]
  pages: number
} | null>(null)
let aiAbort: AbortController | null = null
/** 本地写盘路径（非协同）或协同会话中的宿主，才能插入内容 */
const canUseAi = computed(() => !readonlyMode.value && (!isCollabActive.value || collab.isHost.value))

// ---- 内部状态（非响应式，避免无谓渲染）----
let watchdog: ReturnType<typeof setTimeout> | null = null
let themeTimer: ReturnType<typeof setTimeout> | null = null
let latestXml = ''       // drawio 最近一次回传的 XML
let lastSig = ''         // 最近一次写盘内容签名（幂等守卫：防重复写盘 / 防远端回环）
let diskSig = ''         // 磁盘上内容的签名（只用于「未保存」标记：取消 AI 预览等场景会改 lastSig）
let lastRemotePatchKey = '' // 最近一次应用的远端 patch 指纹（避免把远端 apply 的结果再广播回去）
let exportWaiter: ((xml: string) => void) | null = null
let loadWaiter: ((ok: boolean) => void) | null = null
let attached = false
/** 主进程下载兜底落盘完成的通知监听（onMounted 注册 / onBeforeUnmount 注销） */
let downloadDoneHandler: ((e: any, payload: any) => void) | null = null
/** AI 预览中：阻断一切写盘与协同广播（确认/取消时再定） */
let previewActive = false

/** 根据应用背景色亮度判断深色/浅色（与 Excalidraw 视图保持一致） */
function isDarkTheme(): boolean {
  const raw = String(store.UI.backgroundColor || '').trim()
  // 只识别 #RGB / #RRGGBB / #RRGGBBAA；其它写法（rgb()/变量/空）一律当浅色，
  // 避免误判成深色 → 主题来回翻转 → iframe 反复重建
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(raw)
  if (!m) return false
  let hex = m[1]
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return r * 0.299 + g * 0.587 + b * 0.114 < 128
}

/** 当前主题键（drawio 的 ui 参数只在加载时生效，因此主题变化需重建 iframe） */
const themeKey = computed<'dark' | 'light'>(() => (isDarkTheme() ? 'dark' : 'light'))

/** 注入到 drawio 文档里的覆盖样式（同源直接操作，保持 public/drawio 与上游完全一致） */
const FRAME_STYLE_ID = 'aim-drawio-override'
const FRAME_CSS = [
  // 隐藏 drawio 自带的 GitHub 品牌链接（底部页签栏右侧），与应用整体风格统一
  '.geTabContainer a[href*="github.com"] { display: none !important; }',
  '.geTabContainer img[src*="github-logo"] { display: none !important; }',
].join('\n')

/**
 * 屏蔽 drawio 在 iframe 内注册的 beforeunload。
 * drawio 的 EditorUi.addBeforeUnloadListener 会给 window.onbeforeunload 挂上「已修改」判断，
 * 关闭子窗口时被 Chromium 的 will-prevent-unload 拦下（主进程只发提示、不 preventDefault）
 * → 表现为「编辑后子窗口关不掉」。我们的写盘是自动的（防抖 800ms + 卸载前 flush），
 * 没有未保存内容需要拦，所以直接把这个钩子做成空操作。
 */
function blockFrameBeforeUnload(w: Window) {
  try {
    Object.defineProperty(w, 'onbeforeunload', {
      configurable: true,
      get: () => null,
      set: () => {},
    })
  } catch (e) {
    console.warn('[Drawio] 屏蔽 beforeunload 失败（忽略）:', e)
  }
}

/** 当前 .drawio 文件所在目录（导出 / 下载的默认落地位置） */
function exportDirOf(filePath: string): string {
  return String(filePath || '').replace(/[\\/][^\\/]*$/, '')
}
function defaultExportPath(filename: string): string {
  const dir = exportDirOf(props.path)
  const name = String(filename || '').trim() || 'export.drawio'
  if (!dir) return name
  return dir + (dir.endsWith('\\') || dir.endsWith('/') ? '' : '\\') + name
}

/**
 * 导出桥的宿主实现。drawio 内嵌模式下「导出为 → 下载 / 设备」与「另存为到设备」
 * 本来都会失败（浏览器下载被静默处理 / File System Access 在 Electron 未实现）——
 * 统一改走主进程原生保存对话框（IPC：drawio-export-save / -pick / -write）。
 */
const exportHost: DrawioExportHost = {
  async save(p) {
    if (!hasIpc) {
      ElMessage.warning(zh.value ? '当前环境无法导出（无 Electron 主进程）' : 'Export unavailable (no Electron main process)')
      return { canceled: true }
    }
    const res = await (window as any).ipcRenderer
      .invoke('drawio-export-save', {
        defaultPath: defaultExportPath(p.filename),
        title: zh.value ? '导出图表' : 'Export diagram',
        filters: exportFilters(p.filename, zh.value),
        content: p.isBase64 ? undefined : p.data,
        base64: p.isBase64 ? p.data : undefined,
      })
      .catch((e: any) => {
        ElMessage.error((zh.value ? '导出失败: ' : 'Export failed: ') + (e?.message || e))
        return null
      })
    if (!res) return { canceled: true }
    if (res.canceled) {
      ElMessage.info(zh.value ? '已取消导出' : 'Export canceled')
      return { canceled: true }
    }
    if (res.error) {
      ElMessage.error((zh.value ? '导出失败: ' : 'Export failed: ') + res.error)
      return { canceled: true }
    }
    ElMessage.success((zh.value ? '已导出到 ' : 'Exported to ') + res.path)
    return res
  },
  async pick(suggestedName) {
    if (!hasIpc) return null
    const res = await (window as any).ipcRenderer
      .invoke('drawio-export-pick', {
        defaultPath: defaultExportPath(suggestedName),
        title: zh.value ? '另存为' : 'Save as',
        filters: exportFilters(suggestedName, zh.value),
      })
      .catch((e: any) => {
        ElMessage.error((zh.value ? '打开保存对话框失败: ' : 'Save dialog failed: ') + (e?.message || e))
        return null
      })
    return res && !res.canceled ? res.path : null
  },
  async write(path, p) {
    if (!hasIpc) return false
    const res = await (window as any).ipcRenderer
      .invoke('drawio-export-write', {
        path,
        content: p.isBase64 ? undefined : p.data,
        base64: p.isBase64 ? p.data : undefined,
      })
      .catch((e: any) => {
        ElMessage.error((zh.value ? '保存失败: ' : 'Save failed: ') + (e?.message || e))
        return null
      })
    if (res?.ok) {
      ElMessage.success((zh.value ? '已保存到 ' : 'Saved to ') + res.path)
      return true
    }
    return false
  },
  async pdf(p) {
    if (!hasIpc) {
      ElMessage.warning(zh.value ? '当前环境无法导出 PDF' : 'PDF export unavailable')
      return
    }
    const res = await (window as any).ipcRenderer
      .invoke('drawio-export-pdf', {
        defaultPath: defaultExportPath(p.filename),
        title: zh.value ? '导出为 PDF' : 'Export as PDF',
        svg: p.svg,
      })
      .catch((e: any) => {
        ElMessage.error((zh.value ? '导出 PDF 失败: ' : 'PDF export failed: ') + (e?.message || e))
        return null
      })
    if (!res) return
    if (res.canceled) ElMessage.info(zh.value ? '已取消导出' : 'Export canceled')
    else if (res.error) ElMessage.error((zh.value ? '导出 PDF 失败: ' : 'PDF export failed: ') + res.error)
    else ElMessage.success((zh.value ? '已导出 PDF 到 ' : 'PDF exported to ') + res.path)
  },
  async print(p) {
    if (!hasIpc) return
    const res = await (window as any).ipcRenderer
      .invoke('drawio-export-print', { defaultPath: defaultExportPath(p.filename), svg: p.svg, title: fileName.value })
      .catch((e: any) => {
        ElMessage.error((zh.value ? '打印失败: ' : 'Print failed: ') + (e?.message || e))
        return null
      })
    if (res?.error) ElMessage.error((zh.value ? '打印失败: ' : 'Print failed: ') + res.error)
  },
}

/** 把覆盖样式注入 iframe 文档（跨域时静默跳过，不影响功能） */
function prepareFrame() {
  const frame = frameRef.value
  const doc = frame?.contentDocument
  if (!doc) return
  const fw: any = frame?.contentWindow
  if (fw) {
    blockFrameBeforeUnload(fw)
    // 导出 / 另存为：接住 drawio 内嵌模式的浏览器下载与 File System Access，改走宿主原生对话框
    // （Electron 下前者会静默写入系统下载目录、后者 Promise 永不 settle，都表现为「点了没反应」）
    installDrawioExportBridge(fw, exportHost, (...a: any[]) => console.warn('[Drawio][export]', ...a), exportBridgeState)
  }
  try {
    if (!doc.getElementById(FRAME_STYLE_ID)) {
      const style = doc.createElement('style')
      style.id = FRAME_STYLE_ID
      style.textContent = FRAME_CSS
      ;(doc.head || doc.documentElement).appendChild(style)
    }
  } catch (e) {
    console.warn('[Drawio] 注入覆盖样式失败（忽略）:', e)
  }
}

/**
 * 组装 iframe 地址。
 * 用 `new URL(相对路径, document.baseURI)` 解析，三种运行形态都能命中 drawio 目录：
 * dev（http://localhost:5173/）、生产（file:///…/dist/index.html）、局域网共享（http://ip:端口/）。
 */
function buildSrc(nonce = 0): string {
  const base = new URL(DRAWIO_ASSET_DIR + 'index.html', document.baseURI).href
  const params = new URLSearchParams({
    embed: '1',
    proto: 'json',
    configure: '1',
    spin: '1',
    // 只读时不加载左侧形状库（减负，也弱化编辑入口）
    libraries: readonlyMode.value ? '0' : '1',
    // 隐藏 embed 自带按钮：保存/退出都由宿主接管
    noSaveBtn: '1',
    noExitBtn: '1',
    saveAndExit: '0',
    modified: '0',
    // 离线优先：db=0 关闭 Dropbox 集成（drawio 的加载前置条件为 "0" != urlParams.db），
    // 否则启动时会去拉 www.dropbox.com/static/api/2/dropins.js，无网络时长时间超时
    db: '0',
    // browser=0 去掉「导入自 → 浏览器…」（浏览器本地存储，桌面端无意义）：
    // drawio 以 isLocalStorage && "0" != urlParams.browser 为渲染前置条件，「导入自 → 设备…」不受影响
    browser: '0',
    lang: zh.value ? 'zh' : 'en',
    // ui 只在此处决定主题（不再开 themes=1，避免 drawio 内部主题菜单与应用主题不一致）
    ui: themeKey.value === 'dark' ? 'dark' : 'kennedy',
  })
  if (nonce) params.set('_r', String(nonce))
  return base + '?' + params.toString()
}

function send(payload: Record<string, any>) {
  const win = frameRef.value?.contentWindow
  if (!win) return
  try {
    win.postMessage(JSON.stringify(payload), '*')
  } catch (e) {
    console.error('[Drawio] postMessage 失败:', e)
  }
}

/**
 * 让属性顺序不影响比较：按属性名排序重挂。
 * 必须做这一步的原因：drawio 把 XML 解析成 mxCell 再导出时会用自己的属性顺序，
 * 而我们用 XMLSerializer 序列化会保留「解析时的顺序」→ 同一份内容两个来源的字符串不同，
 * 会被误判成「内容变了」而多写一次文件。
 */
function normalizeAttrOrder(doc: Document) {
  const all = doc.getElementsByTagName('*')
  for (let i = 0; i < all.length; i++) {
    const el = all[i] as Element
    const attrs = el.attributes
    if (!attrs || attrs.length < 2) continue
    const pairs: Array<[string, string]> = []
    for (let k = 0; k < attrs.length; k++) {
      const a = attrs[k]
      // 带命名空间的属性（形如 xlink:href）不能动，否则会破坏前缀绑定
      if (a.name !== a.localName) continue
      pairs.push([a.name, a.value])
    }
    if (pairs.length < 2) continue
    pairs.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    for (const [name, value] of pairs) {
      el.removeAttribute(name)
      el.setAttribute(name, value)
    }
  }
}

/**
 * 内容签名：忽略缩进换行与视图状态（dx/dy），只比较图本身。
 * 用于「内容没变就不写盘」——同 Excalidraw 视图的 sceneKey 幂等守卫经验。
 */
function signature(xml: string): string {
  if (!xml) return ''
  try {
    const doc = new DOMParser().parseFromString(xml, 'text/xml')
    if (doc.getElementsByTagName('parsererror').length) {
      return xml.replace(/\s+/g, ' ').trim()
    }
    const model = doc.getElementsByTagName('mxGraphModel')[0]
    if (model) {
      // 视图状态（滚动位置）不算内容变化，否则平移画布也会触发写盘
      model.removeAttribute('dx')
      model.removeAttribute('dy')
    }
    normalizeAttrOrder(doc)
    return new XMLSerializer().serializeToString(doc).replace(/>\s+</g, '><').trim()
  } catch {
    return xml.replace(/\s+/g, ' ').trim()
  }
}

/** 写入文件（沿用 Excalidraw 视图的 saveFile IPC + store 同步策略） */
async function persist(xml: string, silent: boolean): Promise<boolean> {
  try {
    const ok = await (window as any).ipcRenderer.invoke('saveFile', props.path, xml)
    if (ok) {
      // 回填签名：否则 lastSig 会一直是空，下一次 flush/自动保存会多写一次内容相同的文件
      lastSig = signature(xml) || lastSig
      diskSig = lastSig
      const cur = store.data[store.index]
      if (cur && cur.path === props.path) cur.content = xml
      // 广播「文件内容已变更」：否则其它视图（浏览视图/预览/其它窗口）仍显示旧内容，
      // 看起来就像「没落盘」（主进程不会在 saveFile 里自动广播，必须由保存方主动 notify）
      try {
        void (window as any).ipcRenderer
          .invoke('notify-file-changed', { path: props.path, content: xml })
          .catch(() => {})
      } catch { /* ignore */ }
      // 统一用 ElMessage 反馈保存结果；silent（卸载/切文件/进入 AI 预览前的兵底写盘）不打扰用户
      if (!silent) {
        ElMessage({
          message: (zh.value ? '已保存到 ' : 'Saved to ') + fileName.value,
          type: 'success',
          duration: 1600,
        })
      }
      dirty.value = false
      return true
    }
    lastSig = '' // 写盘失败：清掉签名，下次变更重试
    dirty.value = true
    if (!silent) ElMessage.error(zh.value ? '保存失败' : 'Save failed')
    return false
  } catch (e) {
    console.error('[Drawio] 保存失败:', e)
    lastSig = ''
    dirty.value = true
    if (!silent) ElMessage.error(zh.value ? '保存失败' : 'Save failed')
    return false
  }
}

/** 标记「有未落盘改动」（与磁盘基线 diskSig 比较，改回原样不算脏） */
function markDirty() {
  if (!canWrite.value || !latestXml) return
  if (!diskSig) {
    dirty.value = true
    return
  }
  dirty.value = signature(latestXml) !== diskSig
}

/** 落盘（内容已在磁盘上则跳过）。silent=true 时不弹提示（卸载/切文件/进入 AI 预览前的兜底写盘） */
async function flush(silent = true) {
  // AI 预览期间不写盘：磁盘内容保持在预览前的状态，取消才能干净回退
  if (previewActive) return
  if (!canWrite.value || !latestXml) return
  const sig = signature(latestXml)
  // 与磁盘基线比（不能用 lastSig：换主题重载 / 取消 AI 预览都会把它设成内存内容的签名）
  if (sig && sig === diskSig) {
    lastSig = sig
    dirty.value = false
    return
  }
  if (sig) lastSig = sig
  await persist(latestXml, silent)
}

/** drawio 回传内容：会话中走协同广播，否则只更新内存与「未保存」标记 */
function queueSave(xml: string, immediate: boolean, patch?: any) {
  // AI 预览期间不落盘、不广播：预览内容是否保留由用户确认/取消决定
  if (previewActive) return
  if (!xml) return
  latestXml = xml
  // 协同会话中：不直接写盘（由宿主统一写），只把增量广播出去
  if (isCollabActive.value) {
    markDirty()
    const key = patch ? JSON.stringify(patch) : ''
    if (patch && key !== lastRemotePatchKey && collab.canEdit.value) {
      collab.handleLocalDiff(patch, collab.isHost.value ? xml : undefined)
    }
    return
  }
  if (!canWrite.value) return
  markDirty()
  // 已取消自动保存：编辑过程中的 autosave 只更新内存与未保存标记；
  // 只有「显式保存」（编辑器内 Ctrl+S / 菜单保存 → {event:'save'}）才立即落盘并提示
  if (immediate) void flush(false)
}

/** 主动向编辑器索取当前 XML（宿主 Ctrl+S 时用，保证拿到最新内容） */
function requestXml(): Promise<string> {
  return new Promise((resolve) => {
    exportWaiter = resolve
    send({ action: 'export', format: 'xml' })
    setTimeout(() => {
      if (exportWaiter === resolve) {
        exportWaiter = null
        resolve('')
      }
    }, 4000)
  })
}

/** 保存（宿主 Ctrl+S / 面板保存按钮）：夺取当前 XML 并立即写盘；协同会话中仅主机可保存 */
async function saveNow() {
  if (isCollabActive.value) {
    if (!collab.isHost.value) {
      ElMessage.warning(zh.value ? '仅主机可保存，请请求主机保存' : 'Only the host can save')
      return
    }
    const ok = await collab.save()
    if (ok) ElMessage.success(zh.value ? '已同步保存到主机' : 'Saved (host)')
    else ElMessage.warning(zh.value ? '保存请求失败' : 'Save request failed')
    return
  }
  if (!canWrite.value) {
    ElMessage.warning(zh.value ? '只读预览，无法保存' : 'Read-only preview')
    return
  }
  const xml = await requestXml()
  if (xml) {
    latestXml = xml
    lastSig = ''
    await persist(xml, false)
  } else if (latestXml) {
    lastSig = ''
    await persist(latestXml, false)
  } else {
    ElMessage.warning(zh.value ? '尚未获取到图表内容' : 'Diagram not ready')
  }
}

function sendLoad(extra?: { dark?: boolean }) {
  // 优先用编辑器最近回传的内容：部分宿主（如 FileWindow）的 props.content 不会随保存刷新，
  // 重建 iframe（换主题）时必须用最新内容，否则会回退到打开时的旧版本
  const xml = (latestXml && latestXml.trim()) || (props.content && props.content.trim()) || newDrawioXml()
  // 协同会话中重新加载（换主题 / 重同步）必须继续带 diffSync，否则会静默掉出增量同步
  const inSession = isCollabActive.value
  send({
    action: 'load',
    xml,
    // 只读模式不订阅自动保存，编辑器也就不会回传变更
    autosave: canWrite.value || inSession ? 1 : 0,
    ...(inSession ? { diffSync: true } : {}),
    ...(extra?.dark !== undefined ? { dark: extra.dark } : {}),
    title: fileName.value,
    border: 8,
    fit: 1,
    maxFitScale: 1,
  })
  // 幂等基线：以「喂进去的内容」为基准，内容真变了才写盘
  lastSig = signature(xml)
  // 首次加载喂的是磁盘内容（latestXml 为空），以此为「未保存」比较基线；
  // 换主题等 keepContent 场景喂的是内存内容，不能当成磁盘基线
  if (!(latestXml && latestXml.trim())) diskSig = lastSig
  dirty.value = false
}

function onMessage(ev: MessageEvent) {
  const frame = frameRef.value
  if (!frame || ev.source !== frame.contentWindow) return
  let msg: any
  try {
    msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data
  } catch {
    return
  }
  if (!msg || typeof msg.event !== 'string') return

  switch (msg.event) {
    case 'configure':
      // 编辑器初始化前的一次性配置（VS Code/Electron 类宿主需要的两个开关）
      send({
        action: 'configure',
        config: {
          // 原生剪贴板在嵌入场景不可靠，改用 mxClipboard 内部复制粘贴
          useInternalClipboard: true,
          // 宿主拦截新窗口（主进程已 shell.openExternal 处理外链），避免弹窗逃逸
          suppressNewWindows: true,
        },
      })
      break
    case 'init':
      sendLoad()
      break
    case 'load':
      ready.value = true
      fatal.value = ''
      prepareFrame()
      if (watchdog) {
        clearTimeout(watchdog)
        watchdog = null
      }
      // 主动 load（预览/回退/重同步）的等待者：确认编辑器已经重建完成
      if (loadWaiter) {
        const done = loadWaiter
        loadWaiter = null
        done(true)
      }
      break
    case 'autosave':
      queueSave(String(msg.xml || ''), false, msg.patch)
      break
    case 'save':
      queueSave(String(msg.xml || ''), true, msg.patch)
      break
    case 'export':
      if (exportWaiter && msg.xml) {
        const resolve = exportWaiter
        exportWaiter = null
        resolve(String(msg.xml))
      }
      break
    case 'exit':
      // 已隐藏退出按钮；真出现时忽略（不关闭宿主视图）
      break
    default:
      break
  }
}

/** 宿主侧 Ctrl+S：iframe 未聚焦时也会命中这里 */
function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
    e.preventDefault()
    e.stopPropagation()
    void saveNow()
  }
}

/**
 * 重新加载编辑器。keepContent=true 时保留编辑器最近回传的内容：
 * 重载后重新喂给编辑器（换主题场景），避免宿主 props.content 陈旧导致内容回退
 */
function reload(keepContent = false) {
  ready.value = false
  fatal.value = ''
  if (!keepContent) {
    latestXml = ''
    dirty.value = false
    diskSig = ''
  }
  lastSig = ''
  frameSrc.value = buildSrc(Date.now() % 100000)
  startWatchdog()
}
// ---------------- 协同编辑（局域网实时多人） ----------------

/** 协同桥接：协同层通过这些回调驱动编辑器，不直接操作 drawio 内部对象 */
const collabBridge: DrawioCollabBridge = {
  isReady: () => ready.value && !!frameRef.value,
  applyPatch(patch: any) {
    // 远端增量：只应用到本地编辑器；写盘与再广播都不做
    //（实测：drawio 应用 patch 后内部 shadow 同步更新，不会再产生 diff → 不会回声）
    lastRemotePatchKey = JSON.stringify(patch)
    send({ action: 'patch', patch })
  },
  loadShared(xml: string) {
    // 用权威 XML 重建内容并开启 diffSync（sendLoad 会带上 diffSync）
    latestXml = xml
    lastSig = signature(xml)
    lastRemotePatchKey = ''
    sendLoad()
  },
  async exportXml() {
    return await requestXml()
  },
  setEditable(editable: boolean) {
    collabEditable.value = editable
  },
}

/** 共享/加入前的服务端准备：协同服务未启动则拉起 */
async function ensureCollabServer(): Promise<boolean> {
  const api = window.dsh?.collab
  if (!api) {
    ElMessage.error(zh.value ? '协同服务不可用（当前环境无 Electron 主进程）' : 'Collab service unavailable')
    return false
  }
  try {
    const st = await api.getStatus()
    collabServerStatus.value = st
    if (st.running) return true
    const res = await api.start({
      port: store.collab.port,
      maxMembers: store.collab.maxMembers,
      permissionMode: store.collab.permissionMode,
      token: store.collab.token || undefined,
    })
    if (res.success) {
      if (res.port) store.collab.port = res.port
      const st2 = await api.getStatus()
      collabServerStatus.value = st2
      return true
    }
    ElMessage.error(zh.value ? '协同服务启动失败: ' + (res.error || '未知错误') : 'Failed to start collab service: ' + (res.error || 'Unknown'))
    return false
  } catch (e: any) {
    ElMessage.error(zh.value ? '协同服务不可用: ' + (e?.message || e) : 'Collab service unavailable')
    return false
  }
}

/** 宿主：共享当前图表 */
async function shareCurrentFile() {
  if (!frameRef.value || !props.path) return
  if (!(await ensureCollabServer())) return
  // 共享基准用编辑器现导的 XML，保证包含尚未写盘的改动
  const xml = (await requestXml()) || latestXml || props.content || newDrawioXml()
  const ok = await collab.startHost(collabBridge, props.path, xml, {
    token: store.collab.token || undefined,
    maxMembers: store.collab.maxMembers,
    permissionMode: store.collab.permissionMode,
    autoSaveSeconds: store.collab.autoSaveSeconds,
    name: store.collab.nickname.trim() || '主机',
  })
  if (ok) {
    collabEditable.value = true
    if (!store.collab.token && collab.roomToken.value) store.collab.token = collab.roomToken.value
    const api = window.dsh?.collab
    if (api) {
      try {
        collabServerStatus.value = await api.getStatus()
      } catch { /* ignore */ }
    }
    showCollabPanel.value = true
    ElMessage.success(zh.value ? '已开始协同编辑' : 'Collaboration started')
  } else {
    ElMessage.error(zh.value ? '共享失败: ' + (collab.error.value || '未知错误') : 'Share failed: ' + (collab.error.value || 'Unknown error'))
  }
}

/** 客户端：加入会话 */
async function joinCollabSession() {
  const url = collabJoinUrl.value.trim()
  if (!url) return
  const typedName = collabJoinName.value.trim()
  if (typedName && typedName !== store.collab.nickname) store.collab.nickname = typedName
  const ok = await collab.join(collabBridge, url, typedName || store.collab.nickname.trim() || '访客')
  if (ok) {
    showCollabPanel.value = true
    ElMessage.success(zh.value ? '已加入协同会话' : 'Joined session')
  } else {
    ElMessage.error(zh.value ? '加入失败: ' + (collab.error.value || '未知错误') : 'Join failed: ' + (collab.error.value || 'Unknown error'))
  }
}

/** 退出会话：宿主先把权威 XML 刷给服务端，再关房（否则最后不到 1s 的改动会随关房丢失）；随后重建本地编辑 */
async function leaveCollabSession() {
  const wasHost = collab.isHost.value
  const rid = collab.roomId.value
  if (wasHost && rid) {
    // save() 会先现导 XML 上报（WS 有序，服务端先存后写），再请求写盘；随后 closeRoom 会用同一份内容
    try {
      await collab.save()
    } catch { /* ignore */ }
  }
  collab.leave()
  collabEditable.value = true
  const api = window.dsh?.collab
  if (wasHost && rid && api) {
    try {
      await api.closeRoom(rid)
    } catch { /* ignore */ }
  }
  reload(true)
}

/** 可复制的加入地址（含房间号与 token） */
const collabJoinLink = computed(() => {
  if (!collab.roomId.value) return ''
  const port = collabServerStatus.value.port || store.collab.port
  const ip = collabServerStatus.value.ips[0] || '127.0.0.1'
  const token = store.collab.token
  return `ws://${ip}:${port}/collab/${collab.roomId.value}?token=${encodeURIComponent(token)}`
})

function toggleCollabPanel() {
  showCollabPanel.value = !showCollabPanel.value
  if (showCollabPanel.value) {
    showAiPanel.value = false
    if (!collabJoinName.value.trim()) collabJoinName.value = store.collab.nickname || ''
  }
}

async function copyCollabLink() {
  const link = collabJoinLink.value
  if (!link) return
  try {
    await navigator.clipboard.writeText(link)
    ElMessage.success(zh.value ? '链接已复制' : 'Link copied')
  } catch {
    ElMessage.error(zh.value ? '复制失败' : 'Copy failed')
  }
}

function respondEditRequest(memberId: string, grant: boolean) {
  if (grant) collab.grantEdit(memberId)
  else collab.denyEdit(memberId)
  collab.clearEditRequest(memberId)
}

// 会话被服务端结束（宿主退出 / 服务停止）时回到本地编辑
collab.onClosed((reason) => {
  if (reason === 'left') return
  collabEditable.value = true
  ElMessage.warning(reason || (zh.value ? '协同会话已结束' : 'Session ended'))
  reload(true)
})

let collabStatusUnsub: (() => void) | null = null

// ---------------- 智能操作（AI）----------------

/** 拿编辑器当前内容（含尚未写盘的改动）作为上下文与合并基准 */
async function currentXml(): Promise<string> {
  const fromEditor = await requestXml()
  return (fromEditor && fromEditor.trim()) || latestXml || (props.content || '') || newDrawioXml()
}

/** 主动把画布内容换成指定 XML（预览 / 取消回退用），等 load 事件确认完成 */
function loadXmlIntoEditor(xml: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    latestXml = xml
    loadWaiter = resolve
    sendLoad()
    setTimeout(() => {
      if (loadWaiter === resolve) {
        loadWaiter = null
        resolve(false)
      }
    }, 8000)
  })
}

function pushAi(role: 'user' | 'assistant', text: string, retryReq = '') {
  aiMessages.value.push({ role, text, retryReq: retryReq || undefined })
  void nextTick(() => {
    const el = aiBodyRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

function toggleAiPanel() {
  showAiPanel.value = !showAiPanel.value
  if (!showAiPanel.value) return
  showCollabPanel.value = false
}

function stopAi() {
  try {
    aiAbort?.abort()
  } catch {
    /* ignore */
  }
  aiBusy.value = false
}

/** 生成一次并把回复转成 mxGraphModel 片段；失败时把错误回啥模型重试一次 */
async function generateFragment(messages: any[]): Promise<string | null> {
  let raw = ''
  const run = async (msgs: any[]): Promise<string> => {
    raw = ''
    aiStreamLen.value = 0
    aiStreamChunks.value = 0
    return store.sendToAI(msgs, {
      onStream: (chunk: string) => {
        raw += chunk
        aiStreamChunks.value++
        aiStreamLen.value = raw.length
      },
      signal: aiAbort?.signal,
    })
  }

  const first = await run(messages)
  const frag = extractGraphFragment(first)
  if (frag) return frag

  pushAi(
    'assistant',
    zh.value ? '本次输出不是合法图表 XML，正在重试…' : 'Output was not valid diagram XML, retrying…'
  )
  const second = await run([
    ...messages,
    { role: 'assistant', content: String(first || '').slice(0, 2000) },
    {
      role: 'user',
      content: zh.value
        ? '上面的输出不是合法的 mxGraphModel XML。请只输出一个 <mxGraphModel>…</mxGraphModel> 片段，不要任何其它文字或代码块标记。'
        : 'That was not valid mxGraphModel XML. Output only one <mxGraphModel>…</mxGraphModel> fragment, no other text or code fences.',
    },
  ])
  return extractGraphFragment(second)
}

/** 发送需求：生成 → 校验合并 → 进入画布预览 */
async function askAi() {
  const req = aiInput.value.trim()
  if (!req || aiBusy.value) return
  if (aiPreview.value) {
    pushAi('assistant', zh.value ? '请先确认或取消当前预览。' : 'Confirm or cancel the current preview first.')
    return
  }
  aiInput.value = ''
  pushAi('user', req)
  await runAi(req)
}

/** 失败后按原需求重跑（不重复插用户气泡） */
async function retryAi(req?: string) {
  if (!req || aiBusy.value || aiPreview.value) return
  await runAi(req)
}

/** 生成 → 校验合并 → 预览；各类失败都把原需求带上，气泡里显示「重试」 */
async function runAi(req: string) {
  aiBusy.value = true
  aiAbort = new AbortController()
  try {
    const base = await currentXml()
    const ctx = collectDrawioContext(base)
    const messages = buildDrawioMessages(req, ctx, zh.value, aiMode.value)
    const frag = await generateFragment(messages)
    if (!frag) {
      pushAi(
        'assistant',
        zh.value ? '模型没有返回可用的图表 XML，可直接重试一次。' : 'The model did not return usable diagram XML. You can retry.',
        req
      )
      return
    }
    const merged = mergeDrawioFragment(base, frag, { allowEdit: aiMode.value !== 'add' })
    if ('error' in merged) {
      pushAi('assistant', (zh.value ? '插入失败：' : 'Insert failed: ') + (merged as { error: string }).error, req)
      return
    }
    await startAiPreview(base, merged)
  } catch (e: any) {
    if (e?.name === 'AbortError') pushAi('assistant', zh.value ? '已停止生成。' : 'Generation stopped.')
    else pushAi('assistant', (zh.value ? '生成失败：' : 'Generation failed: ') + (e?.message || e), req)
  } finally {
    aiBusy.value = false
    aiAbort = null
  }
}

/** 进入预览：先把「未落盘的改动」写盘（保证取消能回到与磁盘一致的基线），再把新内容 load 进画布，期间不写盘 */
async function startAiPreview(base: string, merged: DrawioMergeResult) {
  // 只有确实有未落盘改动时才先写盘（保证取消能回到与磁盘一致的基线）：
  // 无条件 flush 会因为「参考签名来自 props.content 而编辑器导出的属性集更全」而误判成内容变了，白白多写一次
  if (dirty.value) {
    latestXml = base
    await flush(true)
  }
  const backupSig = signature(base) || lastSig
  previewActive = true
  aiPreview.value = {
    xml: merged.xml,
    backup: base,
    backupSig,
    added: merged.added,
    updated: merged.updated,
    removed: merged.removed,
    labels: merged.labels,
    edgeLabels: merged.edgeLabels,
    updatedLabels: merged.updatedLabels,
    pages: merged.pages,
  }
  const ok = await loadXmlIntoEditor(merged.xml)
  // 磁盘内容仍是 backup：签名回填，避免取消后误写
  lastSig = backupSig
  if (!ok) {
    previewActive = false
    aiPreview.value = null
    pushAi('assistant', zh.value ? '预览加载失败，已保持原内容。' : 'Preview failed to load; original content kept.')
    return
  }
  pushAi(
    'assistant',
    (zh.value
      ? '已在画布中预览（尚未写入文件）：' + changeSummary(merged.added, merged.updated, merged.removed)
      : 'Previewed on the canvas (not written yet): ' + changeSummary(merged.added, merged.updated, merged.removed)) +
      (merged.pages > 1 ? (zh.value ? '；多页图表，只改第 1 页' : '; multi-page diagram, page 1 only') : '') +
      (zh.value ? '。' : '.')
  )
}

/** 变更摘要文案：新增 n 个 / 调整 n 个 / 删除 n 个 */
function changeSummary(added: number, updated: number, removed: number): string {
  const parts: string[] = []
  if (added) parts.push((zh.value ? '新增 ' : 'add ') + added)
  if (updated) parts.push((zh.value ? '调整 ' : 'adjust ') + updated)
  if (removed) parts.push((zh.value ? '删除 ' : 'remove ') + removed)
  return parts.length ? parts.join(zh.value ? '、' : ', ') : zh.value ? '无变更' : 'no change'
}

/** 确认应用：落盘（协同会话中交宿主上报 + 全量重同步） */
async function confirmAiPreview() {
  const p = aiPreview.value
  if (!p) return
  previewActive = false
  aiPreview.value = null
  // 以预览内容为准：编辑器现导的 XML 与预览内容签名一致时才用它（它才是权威标准格式），
  // 否则用我们合并出来的 XML（签名不一致说明画布在预览期间被改过，不能拿它当“已含 AI 改动”）
  const exported = await requestXml()
  const xml = exported && signature(exported) === signature(p.xml) ? exported : p.xml
  if (isCollabActive.value) {
    if (!collab.isHost.value) {
      pushAi('assistant', zh.value ? '本次变更需主机执行。' : 'Only the host can apply changes.')
      return
    }
    // 整体重建不是增量 patch：让服务端把新内容作为权威基准下发给全体成员
    collab.resync(xml)
    const ok = await collab.save()
    pushAi(
      'assistant',
      ok
        ? (zh.value ? '已应用并同步保存（' : 'Applied and synced (') + changeSummary(p.added, p.updated, p.removed) + (zh.value ? '）。' : ').')
        : (zh.value ? '已应用，但保存请求失败。' : 'Applied, but save failed.')
    )
    return
  }
  lastSig = ''
  const ok = await persist(xml, false)
  pushAi(
    'assistant',
    ok
      ? (zh.value ? '已保存到文件（' : 'Saved to file (') + changeSummary(p.added, p.updated, p.removed) + (zh.value ? '）。' : ').')
      : (zh.value ? '已应用到画布，但写盘失败：内容仍在编辑器中，可点保存重试。' : 'Applied to canvas but the file write failed; use Save to retry.')
  )
}

/** 取消预览：把画布恢复成插入前的内容（未写盘，不动文件） */
async function cancelAiPreview() {
  const p = aiPreview.value
  if (!p) return
  previewActive = false
  aiPreview.value = null
  const ok = await loadXmlIntoEditor(p.backup)
  lastSig = p.backupSig
  pushAi('assistant', ok ? (zh.value ? '已取消，画布已恢复原状。' : 'Cancelled; canvas restored.') : (zh.value ? '已取消。' : 'Cancelled.'))
}

/** 切换文件 / 变成只读时，丢掉预览态（避免写盘一直被阻断） */
function resetAiPreview() {
  previewActive = false
  aiPreview.value = null
}

watch(canUseAi, (ok) => {
  if (!ok) {
    resetAiPreview()
    showAiPanel.value = false
  }
})

/** 看门狗：iframe 一直没握手成功则给出可重试的错误提示（而不是白屏） */
function startWatchdog() {
  if (watchdog) clearTimeout(watchdog)
  watchdog = setTimeout(() => {
    watchdog = null
    if (!ready.value) {
      fatal.value = zh.value
        ? '图表编辑器加载超时，请确认 drawio 运行时资源已就位（scripts/fetch-drawio-webapp.mjs）'
        : 'Diagram editor failed to load. Make sure the drawio runtime is present.'
    }
  }, 20000)
}

/** 关窗兵底：文件窗口关闭时组件可能来不及跑卸载流程，用同步 IPC 兵底写盘（仅有未保存改动时） */
function onWindowBeforeUnload() {
  if (!dirty.value || !latestXml || !hasIpc) return
  try {
    ;(window as any).ipcRenderer.sendSync('saveFileSync', props.path, latestXml)
    dirty.value = false
  } catch (e) {
    console.warn('[Drawio] 关窗兵底写盘失败:', e)
  }
}

onMounted(() => {
  frameSrc.value = buildSrc()
  startWatchdog()
  window.addEventListener('message', onMessage)
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('beforeunload', onWindowBeforeUnload)
  attached = true
  // 告知主进程当前图表所在目录：万一导出仍走了浏览器下载（will-download 兜底），
  // 也落在图表旁边而不是系统下载目录
  if (hasIpc) void (window as any).ipcRenderer.invoke('drawio-export-dir', exportDirOf(props.path))
  // 下载兜底落盘完成提示（主进程 will-download 处理完发回）
  if (hasIpc) {
    downloadDoneHandler = (_e: any, payload: any) => {
      if (payload?.path) ElMessage.success((zh.value ? '已保存导出的文件: ' : 'Exported file saved: ') + payload.path)
    }
    ;(window as any).ipcRenderer.on('app-download-done', downloadDoneHandler)
  }
  // 订阅协同服务状态（用于生成可复制的加入地址）
  if (window.dsh?.collab) {
    window.dsh.collab.getStatus().then((st) => { collabServerStatus.value = st }).catch(() => { /* ignore */ })
    collabStatusUnsub = window.dsh.collab.onStatus((st: any) => { collabServerStatus.value = st })
  }
})

onBeforeUnmount(() => {
  if (attached) {
    window.removeEventListener('message', onMessage)
    window.removeEventListener('keydown', onKeydown)
    window.removeEventListener('beforeunload', onWindowBeforeUnload)
    attached = false
  }
  if (downloadDoneHandler) {
    try { (window as any).ipcRenderer?.removeListener('app-download-done', downloadDoneHandler) } catch { /* ignore */ }
    downloadDoneHandler = null
  }
  if (collabStatusUnsub) {
    try { collabStatusUnsub() } catch { /* ignore */ }
    collabStatusUnsub = null
  }
  // 离开会话：卸载前断开，避免残留连接（宿主不关房，允许其它成员继续/重连）
  collab.destroy()
  if (watchdog) clearTimeout(watchdog)
  if (themeTimer) clearTimeout(themeTimer)
  // 卸载前把未保存的改动静默落地（已取消自动保存，但切标签/关标签不能丢内容）
  if (dirty.value) void flush(true)
})

// 切换文件：先把旧文件写完，再让 iframe 重新加载新内容
watch(
  () => props.path,
  () => {
    resetAiPreview()
    void flush()
    reload()
    if (hasIpc) void (window as any).ipcRenderer.invoke('drawio-export-dir', exportDirOf(props.path))
  }
)

// 主题跟随应用：
// - 编辑器就绪后，用 load 动作的 dark 参数**原地切换**（不重建 iframe，因此不会出现
//   「正在加载图表」遮罩，也不会丢视口/选中）；content 保持不变
// - 尚未就绪或窗口重建时，按新主题在新 URL 里带上 ui 参数
// 防抖取 1200ms：主题值要稳定下来才动作 —— 打开设置窗口时主窗口会同步
// settings-config-changed（UI 会从 localStorage 覆盖），瞬时抖动因此被吸收。
watch(themeKey, () => {
  if (themeTimer) clearTimeout(themeTimer)
  themeTimer = setTimeout(() => {
    themeTimer = null
    if (!ready.value) {
      reload(true)
      return
    }
    if (dirty.value) void flush(true)
    sendLoad({ dark: themeKey.value === 'dark' })
  }, 1200)
})
</script>

<template>
  <div class="drawio-wrap" :class="{ 'has-ai': showAiPanel }">
    <iframe
      v-if="frameSrc"
      ref="frameRef"
      class="drawio-frame"
      :src="frameSrc"
      title="drawio"
      @load="prepareFrame"
    ></iframe>

    <!-- 只读预览：覆盖层阻断一切交互（远程文件不允许改写） -->
    <div v-if="readonlyMode" class="drawio-lock"></div>

    <!-- 加载中 -->
    <div v-if="!ready && !fatal" class="drawio-mask">
      <i class="fa fa-spinner fa-spin"></i>
      <span>{{ zh ? '正在加载图表…' : 'Loading diagram…' }}</span>
    </div>

    <!-- 加载失败：提示 + 重试（避免白屏无提示） -->
    <div v-if="fatal" class="drawio-mask drawio-error">
      <i class="fa fa-exclamation-triangle"></i>
      <div class="drawio-error-title">{{ zh ? '图表加载失败' : 'Failed to load diagram' }}</div>
      <div class="drawio-error-msg">{{ fatal }}</div>
      <button class="drawio-btn" @click="reload()">
        <i class="fa fa-refresh"></i> {{ zh ? '重试' : 'Retry' }}
      </button>
    </div>

    <!-- 只读徽标 -->
    <div v-if="readonlyMode && ready" class="drawio-badge">
      <i class="fa fa-lock"></i> {{ zh ? '只读预览' : 'Read-only' }}
    </div>

    <!-- 右下角操作区：与 drawio 底部页签栏等高居中，只显图标（智能操作 / 协同 / 保存） -->
    <div v-if="ready" class="drawio-actions">
      <button
        v-if="canUseAi"
        class="drawio-action-btn"
        :class="{ active: showAiPanel }"
        :title="zh ? '智能操作（AI 生成并插入图形）' : 'Smart insert (AI)'"
        @click.stop="toggleAiPanel"
      >
        <i class="fa fa-magic"></i>
      </button>
      <button
        v-if="collabEnabled"
        class="drawio-action-btn"
        :class="{ active: isCollabActive }"
        :title="isCollabActive ? (zh ? '协同会话进行中，点击查看' : 'Collab session active, click to view') : (zh ? '协同编辑' : 'Collaboration')"
        @click.stop="toggleCollabPanel"
      >
        <i class="fa fa-users"></i>
        <span v-if="isCollabActive && collab.members.value.length" class="drawio-action-badge">{{ collab.members.value.length }}</span>
      </button>
      <button
        v-if="!readonlyMode"
        class="drawio-action-btn"
        :title="dirty
          ? (zh ? '有未保存的修改，点击保存 (Ctrl+S)' : 'Unsaved changes — click to save (Ctrl+S)')
          : (zh ? '保存 (Ctrl+S)' : 'Save (Ctrl+S)')"
        @click.stop="saveNow"
      >
        <i class="fa fa-floppy-o"></i>
        <span v-if="dirty" class="drawio-dirty-dot"></span>
      </button>
    </div>

    <!-- 协同编辑面板（与源码编辑视图 Edit_Code.vue 同一套结构与样式） -->
    <div v-if="collabEnabled && showCollabPanel" class="collab-panel" @click.stop>
      <div class="collab-panel-head">
        <span><i class="fa fa-users"></i> {{ zh ? '协同编辑' : 'Collaboration' }}</span>
        <button class="collab-close" @click="showCollabPanel = false" :title="zh ? '关闭' : 'Close'">×</button>
      </div>

      <!-- 未连接：共享 / 加入 -->
      <template v-if="!isCollabActive">
        <button class="collab-primary-btn" @click="shareCurrentFile">
          <i class="fa fa-share-alt"></i> {{ zh ? '共享此图表' : 'Share this diagram' }}
        </button>
        <div class="collab-tip">{{ zh ? '创建协同房间，复制加入地址给其他成员或加入会话' : 'Create a room and share the join link or join a session' }}</div>
        <div class="collab-field">
          <label>{{ zh ? '加入地址' : 'Join URL' }}</label>
          <input v-model="collabJoinUrl" :placeholder="zh ? 'ws://ip:端口/collab/房间号?token=…' : 'ws://ip:port/collab/room?token=…'" />
        </div>
        <div class="collab-field">
          <label>{{ zh ? '昵称' : 'Name' }}</label>
          <input v-model="collabJoinName" :placeholder="zh ? '显示给其他成员' : 'Shown to others'" />
        </div>
        <button class="collab-primary-btn" @click="joinCollabSession">
          <i class="fa fa-sign-in"></i> {{ zh ? '加入会话' : 'Join' }}
        </button>
      </template>

      <!-- 会话中 -->
      <template v-else>
        <div class="collab-status-row">
          <span class="collab-status-dot" :class="{ on: collab.status.value === 'connected' }"></span>
          <span>{{ collab.status.value === 'connecting' ? (zh ? '连接中…' : 'Connecting…') : (zh ? '已连接' : 'Connected') }}</span>
          <span class="collab-role">
            {{ collab.isHost.value ? (zh ? '主机' : 'Host') : (collab.canEdit.value ? (zh ? '可编辑' : 'Editor') : (zh ? '只读' : 'Reader')) }}
          </span>
        </div>

        <!-- 主机：可复制的加入地址 -->
        <div v-if="collab.isHost.value && collabJoinLink" class="collab-field">
          <label>{{ zh ? '加入地址' : 'Join URL' }}</label>
          <div class="collab-link-row">
            <code class="collab-link">{{ collabJoinLink }}</code>
            <button class="collab-mini-btn" @click="copyCollabLink" :title="zh ? '复制' : 'Copy'"><i class="fa fa-copy"></i></button>
          </div>
        </div>

        <div class="collab-members">
          <div class="collab-members-title">{{ zh ? '成员' : 'Members' }} ({{ collab.members.value.length }})</div>
          <div v-for="m in collab.members.value" :key="m.id" class="collab-member">
            <span class="collab-color" :style="{ backgroundColor: m.color }"></span>
            <span class="collab-member-name">{{ m.name }}</span>
            <span class="collab-member-role">{{ m.role === 'host' ? (zh ? '主机' : 'Host') : (m.role === 'editor' ? (zh ? '编辑' : 'Ed') : (zh ? '只读' : 'R')) }}</span>
          </div>
        </div>

        <!-- 主机：待批准的编辑请求 -->
        <div v-if="collab.isHost.value && collab.pendingEditRequests.value.length" class="collab-requests">
          <div class="collab-members-title">{{ zh ? '编辑请求' : 'Edit requests' }}</div>
          <div v-for="r in collab.pendingEditRequests.value" :key="r.id" class="collab-member">
            <span class="collab-color" :style="{ backgroundColor: r.color }"></span>
            <span class="collab-member-name">{{ r.name }}</span>
            <button class="collab-mini-btn ok" @click="respondEditRequest(r.id, true)" :title="zh ? '批准' : 'Approve'"><i class="fa fa-check"></i></button>
            <button class="collab-mini-btn no" @click="respondEditRequest(r.id, false)" :title="zh ? '拒绝' : 'Deny'"><i class="fa fa-times"></i></button>
          </div>
        </div>

        <button v-if="!collab.canEdit.value && !collab.isHost.value" class="collab-primary-btn" @click="collab.requestEdit()">
          <i class="fa fa-pencil"></i> {{ zh ? '请求编辑权' : 'Request edit' }}
        </button>

        <div class="collab-actions">
          <button class="collab-mini-btn" @click="saveNow()" :title="zh ? '保存到主机' : 'Save to host'"><i class="fa fa-floppy-o"></i> {{ zh ? '保存' : 'Save' }}</button>
          <button class="collab-mini-btn leave" @click="leaveCollabSession" :title="zh ? '退出会话' : 'Leave session'"><i class="fa fa-sign-out"></i> {{ zh ? '退出' : 'Leave' }}</button>
        </div>
      </template>
    </div>

    <!-- 智能操作：右侧对话栏（生成 → 画布预览 → 确认写入） -->
    <div v-if="showAiPanel" class="drawio-ai-panel" @click.stop>
      <div class="collab-panel-head">
        <span><i class="fa fa-magic"></i> {{ zh ? '智能操作' : 'Smart insert' }}</span>
        <button class="collab-close" @click="showAiPanel = false" :title="zh ? '关闭' : 'Close'">×</button>
      </div>

      <div ref="aiBodyRef" class="ai-body">
        <div v-for="(m, i) in aiMessages" :key="i" class="ai-msg" :class="m.role">
          <div class="ai-msg-text">
            <span>{{ m.text }}</span>
            <div v-if="m.retryReq && !aiBusy" class="ai-msg-actions">
              <button class="collab-mini-btn" @click="retryAi(m.retryReq)">
                <i class="fa fa-refresh"></i> {{ zh ? '重试' : 'Retry' }}
              </button>
            </div>
          </div>
        </div>
        <div v-if="aiBusy" class="ai-msg assistant">
          <div class="ai-msg-text">
            <i class="fa fa-spinner fa-spin"></i>
            {{ zh ? '正在生成…' : 'Generating…' }}{{ aiStreamLen ? (zh ? ' 已接收 ' + aiStreamLen + ' 字符' : ' ' + aiStreamLen + ' chars received') : '' }}
            <div v-if="aiStreamChunks === 1" class="ai-stream-hint">
              {{ zh ? '接口未返回流式分块（整包返回），所以数字是一次性跳变的，不是计数出错。' : 'No stream chunks were received (single response), so the number jumps at once — not a counting error.' }}
            </div>
          </div>
        </div>
      </div>

      <div v-if="aiPreview" class="ai-preview">
        <div class="ai-preview-title"><i class="fa fa-eye"></i> {{ zh ? '预览中（尚未写入文件）' : 'Preview (not written yet)' }}</div>
        <div class="ai-preview-summary">{{ changeSummary(aiPreview.added, aiPreview.updated, aiPreview.removed) }}</div>
        <div v-if="aiPreview.labels.length || aiPreview.edgeLabels.length || aiPreview.updatedLabels.length" class="ai-preview-list">
          <div v-for="(l, i) in aiPreview.labels" :key="'add' + i" class="ai-preview-item"><span class="ai-preview-op">+</span> {{ l }}</div>
          <div v-for="(l, i) in aiPreview.edgeLabels" :key="'edge' + i" class="ai-preview-item"><span class="ai-preview-op">→</span> {{ l }}</div>
          <div v-for="(l, i) in aiPreview.updatedLabels" :key="'upd' + i" class="ai-preview-item"><span class="ai-preview-op">~</span> {{ l }}</div>
        </div>
        <div class="ai-preview-tip">
          {{ zh ? '变更已在画布中预览，取消会恢复原状。' : 'Changes are previewed on the canvas; cancel restores the previous state.' }}
        </div>
        <div class="collab-actions">
          <button class="collab-mini-btn ok" @click="confirmAiPreview()"><i class="fa fa-check"></i> {{ zh ? '确认应用' : 'Apply' }}</button>
          <button class="collab-mini-btn no" @click="cancelAiPreview()"><i class="fa fa-times"></i> {{ zh ? '取消' : 'Cancel' }}</button>
        </div>
      </div>

      <div class="ai-input">
        <textarea
          v-model="aiInput"
          :placeholder="zh ? '描述需要插入的图形，例如：加一个三步审批流程（提交 → 审核 → 归档）' : 'Describe the shapes to insert…'"
          @keydown.ctrl.enter.prevent="askAi()"
          @keydown.meta.enter.prevent="askAi()"
        ></textarea>
        <div class="ai-input-actions">
          <select
            v-model="aiMode"
            class="ai-mode-select"
            :disabled="aiBusy || !!aiPreview"
            :title="zh ? '智能操作模式：自动=允许调整布局/连线（可改可删已有图形）；仅新增=只加不改' : 'Mode: Auto may adjust existing shapes; Add-only never touches them'"
          >
            <option value="auto">{{ zh ? '自动可调' : 'Auto' }}</option>
            <option value="add">{{ zh ? '仅新增' : 'Add only' }}</option>
          </select>
          <button v-if="aiBusy" class="collab-mini-btn no" @click="stopAi"><i class="fa fa-stop"></i> {{ zh ? '停止' : 'Stop' }}</button>
          <button v-else class="collab-mini-btn" :disabled="!aiInput.trim() || !!aiPreview" @click="askAi">
            <i class="fa fa-paper-plane"></i> {{ zh ? '生成' : 'Generate' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.drawio-wrap {
  position: absolute;
  inset: 0;
  background: var(--backgroundColor, #ffffff);
}
.drawio-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}
/* 智能操作面板打开时让出右侧空间（iframe 变窄，drawio 自身会跟着重排） */
.drawio-wrap.has-ai .drawio-frame {
  width: calc(100% - 320px);
}
/* 只读覆盖层：pointer-events 默认 auto，直接吃掉鼠标与焦点 */
.drawio-lock {
  position: absolute;
  inset: 0;
  z-index: 18;
  background: transparent;
  cursor: default;
}
.drawio-mask {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  font-size: 13px;
  background: var(--backgroundColor, #ffffff);
  color: var(--fontColor, #333);
}
.drawio-mask > i {
  font-size: 24px;
  opacity: 0.7;
}
.drawio-error > i {
  font-size: 30px;
  color: #e6a23c;
  opacity: 1;
}
.drawio-error-title {
  font-size: 14px;
  font-weight: 600;
}
.drawio-error-msg {
  max-width: 560px;
  font-size: 12px;
  line-height: 1.6;
  opacity: 0.7;
  text-align: center;
  word-break: break-all;
}
.drawio-btn {
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
.drawio-btn:hover {
  background: var(--menuActiveColor, #eaeaea);
}
/* 只读徽标：右下角浮层（置于操作区上方） */
.drawio-badge {
  position: absolute;
  right: 10px;
  bottom: 38px;
  z-index: 19;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  font-size: 11px;
  border-radius: 10px;
  border: 1px solid var(--borderColor, #ddd);
  background: var(--menuColor, rgba(255, 255, 255, 0.92));
  color: var(--fontColor, #666);
  pointer-events: none;
}

/* 右下角操作区：与 drawio 底部页签栏（.geTabContainer 实测高度 32px）等高，图标在其中垂直居中；
   只显图标（无按钮边框/底色），悬停时给淡底色反馈 */
.drawio-actions {
  position: absolute;
  right: 6px;
  bottom: 0;
  z-index: 19;
  height: 32px;
  display: flex;
  align-items: center;
  gap: 2px;
}
.drawio-wrap.has-ai .drawio-actions {
  right: 326px;
}
.drawio-action-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  font-size: 13px;
  line-height: 1;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--fontColor, #555);
  opacity: 0.72;
  cursor: pointer;
}
.drawio-action-btn:hover {
  opacity: 1;
  color: var(--fontActiveColor, #409eff);
  background: color-mix(in srgb, var(--fontColor, #333) 10%, transparent);
}
.drawio-action-btn.active {
  opacity: 1;
  color: var(--fontActiveColor, #409eff);
}
.drawio-action-badge {
  position: absolute;
  top: -3px;
  right: -3px;
  min-width: 13px;
  height: 13px;
  padding: 0 3px;
  font-size: 9px;
  line-height: 13px;
  border-radius: 7px;
  background: var(--fontActiveColor, #409eff);
  color: #fff;
}
/* 有未保存修改：保存按钮右上角小黄点（已取消自动保存，改完需 Ctrl+S） */
.drawio-dirty-dot {
  position: absolute;
  top: 1px;
  right: 1px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #e6a23c;
}

/* ===== 协同编辑面板（与源码编辑视图 Edit_Code.vue 同一套样式，保持一致/紧凑） ===== */
.collab-panel {
  position: absolute;
  right: 5px;
  /* 源码视图是 bottom:29px（其底栏高 28px）；本模块底栏（drawio 页签栏）高 32px，上移 5px 让位 */
  bottom: 34px;
  width: 276px;
  max-height: 72%;
  overflow-y: auto;
  background: var(--menuColor);
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  padding: 8px;
  z-index: 100;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: var(--fontColor);
}
.collab-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 4px;
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
.collab-panel-head .collab-close:hover {
  opacity: 1;
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
.collab-tip {
  font-size: 10px;
  opacity: 0.7;
  line-height: 1.3;
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
  padding: 0px
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

.drawio-wrap.has-ai .drawio-badge,
.drawio-wrap.has-ai .collab-panel {
  right: 326px;
}

/* ===== 智能操作面板（右侧对话栏） ===== */
.drawio-ai-panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 40;
  width: 320px;
  display: flex;
  flex-direction: column;
  font-size: 12px;
  border-left: 1px solid var(--borderColor, #ddd);
  color: var(--fontColor, #333);
}
.drawio-ai-panel .collab-panel-head {
  padding: 8px;
  border-bottom: 1px solid var(--borderColor, #ddd);
}
.ai-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ai-msg {
  display: flex;
}
.ai-msg.user {
  justify-content: flex-end;
}
.ai-msg-text {
  max-width: 92%;
  padding: 5px 8px;
  border-radius: 6px;
  font-size: 11px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  background: color-mix(in srgb, var(--fontColor, #333) 8%, transparent);
}
.ai-msg.user .ai-msg-text {
  background: color-mix(in srgb, var(--fontActiveColor, #409eff) 18%, transparent);
}
.ai-msg-actions {
  margin-top: 4px;
}
.ai-stream-hint {
  margin-top: 3px;
  font-size: 10px;
  line-height: 1.4;
  opacity: 0.6;
}
.ai-preview {
  padding: 7px 9px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  border-top: 1px dashed var(--borderColor, #ddd);
}
.ai-preview-title {
  font-size: 11px;
  font-weight: 600;
}
.ai-preview-summary {
  font-size: 10px;
  opacity: 0.8;
}
.ai-preview-op {
  display: inline-block;
  width: 10px;
  font-weight: 700;
  opacity: 0.75;
}
.ai-preview-list {
  max-height: 84px;
  overflow: auto;
  font-size: 11px;
  opacity: 0.85;
}
.ai-preview-item {
  padding: 1px 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-preview-tip {
  font-size: 10px;
  line-height: 1.5;
  opacity: 0.6;
}
.ai-input {
  padding: 7px 9px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  border-top: 1px solid var(--borderColor, #ddd);
}
.ai-input textarea {
  width: 100%;
  height: 64px;
  box-sizing: border-box;
  padding: 5px 6px;
  font-size: 11px;
  font-family: inherit;
  line-height: 1.5;
  resize: none;
  outline: none;
  border: 1px solid var(--borderColor, #ddd);
  border-radius: 4px;
  background: var(--backgroundColor, #fff);
  color: var(--fontColor, #333);
}
.ai-input textarea:focus {
  border-color: var(--fontActiveColor, #409eff);
}
.ai-input-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 5px;
}
/* 生成按钮不被下拉挤扁：不收缩、不换行，并与下拉同高 */
.ai-input-actions .collab-mini-btn {
  flex: 0 0 auto;
  white-space: nowrap;
  height: 22px;
  padding: 3px 10px;
}
/* 模式下拉：全局 style.css 里有 `select{width:calc(100% - 10px); margin:5px; height:31px; background:var(--menuColor)}`，
   width/margin/height 必须显式覆盖，否则它会撑满整行并把生成按钮挤扁。
   配色只能用主题里真实存在的变量（--backgroundColor/--menuColor/--borderColor/--fontColor...）：
   之前写的 var(--inputColor, #fff) 在该项目里**从头到尾没有定义**，会回退成白底；深色主题下 --fontColor 是白色
   → 白底白字。 */
.ai-mode-select {
  flex: 0 0 auto;
  width: auto;
  min-width: 0;
  max-width: 52%;
  height: 22px;
  margin: 0;
  padding: 0 4px;
  font-size: 11px;
  font-family: inherit;
  line-height: 1;
  color: var(--fontColor, #333);
  background-color: var(--backgroundColor, #fff);
  border: 1px solid var(--borderColor, #ddd);
  border-radius: 4px;
  outline: none;
  cursor: pointer;
}
/* 原生下拉弹层的配色也要给（否则深色主题下弹层是白底 + 继承白字，选项看不见） */
.ai-mode-select option {
  color: var(--fontColor, #333);
  background-color: var(--backgroundColor, #fff);
}
.ai-mode-select:hover {
  border-color: var(--fontActiveColor, #409eff);
}
.ai-mode-select:focus {
  border-color: var(--fontActiveColor, #409eff);
}
.ai-mode-select:disabled {
  opacity: 0.5;
  cursor: default;
}
.collab-mini-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.collab-mini-btn:disabled:hover {
  border-color: var(--borderColor, #ddd);
  color: var(--fontColor, #333);
}
</style>
