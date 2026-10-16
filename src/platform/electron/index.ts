/**
 * platform/electron — Electron 桌面后端
 *
 * 只是既有 IPC 的薄包装：通道名与参数形状与迁移前完全一致，
 * 迁移后行为不变；后续安卓 / 主机后端只需实现同一组端口。
 */
import type {
  AppEventChannel,
  AppPort,
  BrowserAgentPort,
  CapabilityId,
  CapabilityMode,
  DialogPort,
  EventsPort,
  FileSystemPort,
  HostPort,
  LlmPort,
  Platform,
  PlatformCapabilities,
  ShellPort,
  WatchPort,
  WindowPort,
  TerminalPort,
} from '@/platform/contract'
import { aikmIpcOrNull } from '@/lib/aikmIpc'

/** preload 暴露的 ipcRenderer（见 electron/preload/index.ts）；非 Electron 环境为 undefined */
function ipc(): any {
  return (typeof window !== 'undefined') ? aikmIpcOrNull() : undefined
}

/** 是否运行在 Electron 渲染进程（与既有代码一致的判定：preload 已注入 ipcRenderer） */
export function isElectronRuntime(): boolean {
  const api = ipc()
  return !!(api && typeof api.invoke === 'function')
}

const MODES: Record<CapabilityId, CapabilityMode> = {
  'fs.pathRead': 'local',
  'fs.pathWrite': 'local',
  'fs.remoteSave': 'local',
  'fs.watch': 'local',
  downloadSink: 'local',
  'dialog.native': 'local',
  'window.chrome': 'local',
  'shell.systemOpen': 'local',
  'shell.globalShortcut': 'local',
  'app.shell': 'local',
  'events.bus': 'local',
  'host.lanShare': 'local',
  'host.mcpExpose': 'local',
  'host.python': 'local',
  'host.docConvert': 'local',
  'host.tableLoad': 'local',
  'host.netFetch': 'local',
  'host.excelExport': 'local',
  'skills.store': 'local',
  'llm.hosted': 'local',
  browserAgent: 'local',
  // 桌面终端走主进程 node-pty（真 PTY）
  terminal: 'local',
  // 桌面语音走本地 ONNX 合成（sherpa-onnx），不需要系统 TTS
  'host.tts': 'local',
  // 桌面没有系统分享面板：分享入口按能力隐藏
  'shell.share': 'none',
  // 桌面进程不会被系统回收，不需要前台保活
  'app.longTask': 'none',
}

const capabilities: PlatformCapabilities = {
  kind: 'electron',
  mode(id) { return MODES[id] || 'none' },
  has(id) { return (MODES[id] || 'none') !== 'none' },
}

const fsPort: FileSystemPort = {
  async readText(path) {
    const api = ipc()
    if (!api?.invoke) throw new Error('IPC 不可用（请在 Electron 中运行）')
    return api.invoke('readFile', path)
  },

  async saveText(path, content) {
    const api = ipc()
    if (!api?.invoke) return false
    return api.invoke('saveFile', path, content)
  },

  async writeText(path, content) {
    const api = ipc()
    if (!api?.invoke) return { success: false, error: 'IPC 不可用（请在 Electron 中运行）' }
    return api.invoke('writeFile', path, content)
  },

  async writeBase64(path, base64) {
    const api = ipc()
    if (!api?.invoke) return false
    return api.invoke('writeFileBase64', path, base64)
  },

  async writeBinaryBase64(path, base64) {
    const api = ipc()
    if (!api?.invoke) return { success: false, error: 'IPC 不可用（请在 Electron 中运行）' }
    return api.invoke('writeBase64', path, base64)
  },

  saveTextSync(path, content) {
    const api = ipc()
    if (!api?.sendSync) return false
    try {
      return !!api.sendSync('saveFileSync', path, content)
    } catch (e) {
      console.warn('[platform] 同步写盘失败:', e)
      return false
    }
  },

  async saveMetadata(path, metadata) {
    const api = ipc()
    if (!api?.invoke) return false
    return api.invoke('saveFileMetadata', path, metadata)
  },

  async createFile(dirPath, fileName) {
    const api = ipc()
    if (!api?.invoke) return null
    return api.invoke('createFile', dirPath, fileName)
  },

  async createFolder(dirPath, folderName) {
    const api = ipc()
    if (!api?.invoke) return null
    return api.invoke('createFolder', dirPath, folderName)
  },

  async deleteFile(path) {
    const api = ipc()
    if (!api?.invoke) return false
    return api.invoke('deleteFile', path)
  },

  async deleteFolder(path) {
    const api = ipc()
    if (!api?.invoke) return { success: false, error: 'IPC 不可用（请在 Electron 中运行）' }
    return api.invoke('deleteFolder', path)
  },

  async copyFile(sourcePath, targetDir) {
    const api = ipc()
    if (!api?.invoke) return { success: false, error: 'IPC 不可用（请在 Electron 中运行）' }
    return api.invoke('copyFile', sourcePath, targetDir)
  },

  async moveFile(sourcePath, targetDir) {
    const api = ipc()
    if (!api?.invoke) return { success: false, error: 'IPC 不可用（请在 Electron 中运行）' }
    return api.invoke('moveFile', sourcePath, targetDir)
  },

  async renameFile(oldPath, newName) {
    const api = ipc()
    if (!api?.invoke) return { success: false, error: 'IPC 不可用（请在 Electron 中运行）' }
    return api.invoke('renameFile', oldPath, newName)
  },

  async ensureDir(dirPath) {
    const api = ipc()
    if (!api?.invoke) return { success: false, error: 'IPC 不可用（请在 Electron 中运行）' }
    return api.invoke('ensureDir', dirPath)
  },

  async listTree(folderPath, depth) {
    const api = ipc()
    if (!api?.invoke) return []
    return api.invoke('getFiles', folderPath, depth)
  },

  async listTreeWithRelations(folderPath, depth) {
    const api = ipc()
    if (!api?.invoke) return { fileList: [], relationList: [] }
    return api.invoke('getFilesRelation', folderPath, depth)
  },

  async getInfo(path) {
    const api = ipc()
    if (!api?.invoke) return null
    return api.invoke('getInf', path)
  },

  async readMetadata(path) {
    const api = ipc()
    if (!api?.invoke) return {}
    return api.invoke('getConfig', path)
  },

  async scan(folderPath, options) {
    const api = ipc()
    if (!api?.invoke) return { success: false, error: 'IPC 不可用（请在 Electron 中运行）' }
    return api.invoke('scanFolder', { folderPath, ...(options || {}) })
  },

  async searchFiles(rootPath, filterText) {
    const api = ipc()
    if (!api?.invoke) return []
    return api.invoke('search', rootPath, filterText)
  },

  async refreshTree(folderPaths, knownVersion) {
    const api = ipc()
    if (!api?.invoke) return { success: false, error: 'IPC 不可用（请在 Electron 中运行）' }
    return api.invoke('refreshMultiTree', folderPaths, knownVersion)
  },

  async isDirectory(path) {
    const api = ipc()
    if (!api?.invoke) return false
    return api.invoke('isDirectory', path)
  },

  async relativePath(fromFile, toFile) {
    const api = ipc()
    if (!api?.invoke) return null
    return api.invoke('getRelativePath', fromFile, toFile)
  },

  async resolveRelativePath(baseFile, relativePath) {
    const api = ipc()
    if (!api?.invoke) return null
    return api.invoke('resolveRelativePath', baseFile, relativePath)
  },

  async pickTaskFile() {
    const api = ipc()
    if (!api?.invoke) return { success: false, error: 'not-supported' }
    return api.invoke('loadTaskFile')
  },

  async readTaskFile(path, maxBytes) {
    const api = ipc()
    if (!api?.invoke) return { success: false, error: 'not-supported' }
    return api.invoke('readTaskFile', path, maxBytes)
  },

  async saveTaskFileAs(content) {
    const api = ipc()
    if (!api?.invoke) return { success: false, error: 'not-supported' }
    return api.invoke('saveTaskFile', content)
  },

  async saveTaskFileAuto(referencePath, content) {
    const api = ipc()
    if (!api?.invoke) return { success: false, error: 'not-supported' }
    return api.invoke('saveTaskFileAuto', referencePath, content)
  },

  async writeTaskFile(path, content) {
    const api = ipc()
    if (!api?.invoke) return { success: false, error: 'not-supported' }
    return api.invoke('writeTaskFile', path, content)
  },

  async readDataUrl(path) {
    const api = ipc()
    if (!api?.invoke) throw new Error('IPC 不可用（请在 Electron 中运行）')
    return api.invoke('readFileBase64', path)
  },

  async readBinary(path) {
    const api = ipc()
    if (!api?.invoke) throw new Error('IPC 不可用（请在 Electron 中运行）')
    return api.invoke('readFileBinary', path)
  },

  async saveBase64({ base64, targetPath, overwrite }) {
    const api = ipc()
    if (!api?.invoke) return { ok: false, error: 'not-electron' }
    try {
      return await api.invoke('exportDocx', { base64, targetPath, overwrite: !!overwrite })
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  },

  async saveRemoteDownload({ dir, name, data }) {
    const api = ipc()
    if (!api?.invoke) return { success: false, error: 'not-electron' }
    try {
      return await api.invoke('saveRemoteDownload', { dir, name, data })
    } catch (e: any) {
      return { success: false, error: String(e?.message || e) }
    }
  },

  async setDownloadDirHint(dir) {
    await ipc()?.invoke('drawio-export-dir', dir)
  },

  onDownloadComplete(cb) {
    const api = ipc()
    if (!api?.on || !api?.off) return () => {}
    const listener = (_e: any, payload: any) => {
      try { cb(String(payload?.path || '')) } catch (e) { console.warn('[platform] 下载完成回调失败:', e) }
    }
    api.on('app-download-done', listener)
    return () => {
      try { api.off('app-download-done', listener) } catch { /* 窗口关闭等场景，忽略 */ }
    }
  },
}

const watchPort: WatchPort = {
  onChange(cb) {
    const api = ipc()
    if (!api?.on || !api?.off) return () => {}
    const listener = (_e: any, payload: any) => cb(payload)
    api.on('fileSystemChanged', listener)
    return () => {
      try { api.off('fileSystemChanged', listener) } catch { /* 窗口关闭等场景，忽略 */ }
    }
  },

  async acquire(roots) {
    const api = ipc()
    if (!api?.invoke) throw new Error('IPC 不可用（请在 Electron 中运行）')
    await api.invoke('startWatching', roots)
  },

  async release() {
    const api = ipc()
    if (!api?.invoke) return
    await api.invoke('stopWatching')
  },

  async watchFile(path) {
    const api = ipc()
    if (!api?.invoke) return { success: false, error: 'not-supported' }
    return api.invoke('watchFile', path)
  },

  async unwatchFile() {
    const api = ipc()
    if (!api?.invoke) return { success: false, error: 'not-supported' }
    return api.invoke('unwatchFile')
  },
}

const dialogPort: DialogPort = {
  pickDirectory() {
    const api = ipc()
    if (!api?.invoke) return Promise.resolve(null)
    return api.invoke('openFolderDialog')
  },

  pickFile(options) {
    const api = ipc()
    if (!api?.invoke) return Promise.resolve(null)
    return api.invoke('selectFile', options || {})
  },

  pickFiles(options) {
    const api = ipc()
    if (!api?.invoke) return Promise.resolve([])
    return api.invoke('selectFiles', options || {})
  },

  saveFile(options) {
    const api = ipc()
    if (!api?.invoke) return Promise.resolve(null)
    return api.invoke('saveFileDialog', options || {})
  },

  pickTextFile() {
    const api = ipc()
    if (!api?.invoke) return Promise.resolve({ content: null, filePath: null })
    return api.invoke('openFile')
  },
}

const windowPort: WindowPort = {
  async minimize() {
    await ipc()?.invoke('minimize-window')
  },

  async toggleMaximize() {
    await ipc()?.invoke('maximize-window')
  },

  async close() {
    await ipc()?.invoke('close-window')
  },

  async toggleFullscreen() {
    const api = ipc()
    if (!api?.invoke) return false
    return !!await api.invoke('toggle-fullscreen')
  },

  async getZoom() {
    const api = ipc()
    if (!api?.invoke) return 1
    const res = await api.invoke('window:zoomGet')
    return typeof res?.factor === 'number' ? res.factor : 1
  },

  async setZoom(factor) {
    const api = ipc()
    if (!api?.invoke) return factor
    const res = await api.invoke('window:zoomSet', { factor })
    return typeof res?.factor === 'number' ? res.factor : factor
  },

  async restartApp() {
    // 主进程用 ipcMain.on 监听该通道（fire-and-forget），故走 send 而非 invoke
    ipc()?.send('restartApp')
  },

  async openFileWindow(payload) {
    await ipc()?.invoke('open-file-window', payload)
  },

  async openPluginPanelWindow(payload) {
    const api = ipc()
    if (!api?.invoke) return false
    // 主进程未注册该通道（如开发时主进程未重启）时抛出：按「没打开」处理，调用方退回浮层
    return !!await api.invoke('open-plugin-panel-window', payload)
  },

  async toggleDevTools() {
    ipc()?.send('dev', {})
  },
}

const shellPort: ShellPort = {
  async openWithSystemApp(path) {
    const api = ipc()
    if (!api?.invoke) return { success: false, error: 'IPC 不可用（请在 Electron 中运行）' }
    return api.invoke('openWithSystemApp', path)
  },

  async revealInFolder(path) {
    const api = ipc()
    if (!api?.invoke) return false
    try {
      return !!await api.invoke('openInFolder', path)
    } catch {
      // 主进程对不存在的路径会 throw：既有调用方按“定位失败”处理，这里收敛为 false
      return false
    }
  },

  async openByApp(path) {
    await ipc()?.invoke('openByApp', path)
  },

  async registerShortcut(accelerator) {
    const api = ipc()
    if (!api?.invoke) return { success: false, error: 'IPC 不可用（请在 Electron 中运行）' }
    return api.invoke('registerASRShortcut', accelerator)
  },

  async unregisterShortcut() {
    await ipc()?.invoke('unregisterASRShortcut')
  },

  /** 桌面没有系统分享面板（右键「发送到」不属于本应用职责）：入口按 shell.share 能力隐藏 */
  async share() {
    return { success: false, error: 'not-supported' }
  },
}

const appPort: AppPort = {
  getBehavior() {
    const api = ipc()
    if (!api?.invoke) return Promise.resolve({ closeToTray: false })
    return api.invoke('app-behavior:get')
  },

  setBehavior(payload) {
    const api = ipc()
    if (!api?.invoke) return Promise.resolve({ closeToTray: false })
    return api.invoke('app-behavior:set', payload || {})
  },

  getFileAssocState() {
    const api = ipc()
    if (!api?.invoke) return Promise.resolve({ ok: false, error: { message: 'not-supported' } })
    return api.invoke('file-assoc:get-state')
  },

  setFileAssoc(payload) {
    const api = ipc()
    if (!api?.invoke) return Promise.resolve({ ok: false, error: { message: 'not-supported' } })
    return api.invoke('file-assoc:set', payload || {})
  },

  dataDirPath(sub) {
    const api = ipc()
    if (!api?.invoke) return Promise.resolve({ success: false, path: '', error: 'not-supported' })
    return api.invoke('data-dir-path', sub ? { sub } : undefined)
  },

  openDataDir(sub) {
    const api = ipc()
    if (!api?.invoke) return Promise.resolve({ success: false, path: '', error: 'not-supported' })
    return api.invoke('open-data-dir', sub ? { sub } : undefined)
  },

  cleanUserdataCache() {
    const api = ipc()
    if (!api?.invoke) return Promise.resolve({ ok: false, error: 'not-supported' })
    return api.invoke('clean-userdata-cache')
  },

  userdataCacheInfo() {
    const api = ipc()
    if (!api?.invoke) return Promise.resolve({ ok: false, bytes: 0 })
    return api.invoke('userdata-cache-info')
  },

  isSettingsWindowOpen() {
    const api = ipc()
    if (!api?.invoke) return Promise.resolve(false)
    return api.invoke('get-settings-window-state').then((res: any) => !!res?.open)
  },

  async notifyUiReady() {
    await ipc()?.invoke('main-window-ui-ready')
  },

  async notifyFileChanged(payload) {
    await ipc()?.invoke('notify-file-changed', payload)
  },

  /** 桌面进程不会被系统回收，长任务不需要前台保活（能力位为 none，调用方本就不会调） */
  async beginLongTask() {
    return { success: false, error: 'not-supported' }
  },
  async updateLongTask() {
    return { success: false }
  },
  async endLongTask() {
    return { success: false }
  },

  /** 桌面窗口没有系统返回手势（关闭窗口由标题栏/快捷键负责） */
  onBackPressed() {
    return () => {}
  },
}

/**
 * 事件总线：on 会把监听器包一层（ipcRenderer 的监听器收到 (event, payload)，
 * 平台层只传 payload），off 必须用同一个包装函数才能真正移除。
 */
const eventWrappers = new Map<AppEventChannel, Map<(payload: any) => void, (event: any, payload: any) => void>>()

const eventsPort: EventsPort = {
  on(channel, cb) {
    const api = ipc()
    if (!api?.on) return () => {}
    let perChannel = eventWrappers.get(channel)
    if (!perChannel) { perChannel = new Map(); eventWrappers.set(channel, perChannel) }
    let wrapper = perChannel.get(cb)
    if (!wrapper) {
      wrapper = (_event: any, payload: any) => cb(payload)
      perChannel.set(cb, wrapper)
      api.on(channel, wrapper)
    }
    return () => {
      const w = perChannel!.get(cb)
      if (!w) return
      try { api.off(channel, w) } catch { /* 窗口关闭等场景，忽略 */ }
      perChannel!.delete(cb)
      if (!perChannel!.size) eventWrappers.delete(channel)
    }
  },

  emit(channel, payload) {
    const api = ipc()
    if (!api?.send) return
    try { api.send(channel, payload) } catch (e) { console.warn('[platform] 事件广播失败:', e) }
  },
}

/** 宿主侧重能力：全部由桌面主进程执行，网页端/安卓无此能力（可经宿主桥接后为 host） */
const hostPort: HostPort = {
  lan: {
    async getGuest() {
      const api = ipc()
      if (!api?.invoke) return { policy: null, info: null }
      return api.invoke('lan:getGuest')
    },
    async setGuest(policy) {
      const api = ipc()
      if (!api?.invoke) return { success: false }
      return api.invoke('lan:setGuest', policy)
    },
    async setKbDir(dir) {
      const api = ipc()
      if (!api?.invoke) return { success: false }
      return api.invoke('lan:setKbDir', dir)
    },
    async setEmbed(cfg) {
      const api = ipc()
      if (!api?.invoke) return { success: false }
      return api.invoke('lan:setEmbed', cfg)
    },
    async getServerInfo() {
      const api = ipc()
      if (!api?.invoke) return null
      return api.invoke('getLanServerInfo')
    },
    async startServer(port) {
      const api = ipc()
      if (!api?.invoke) return { success: false, error: 'not-supported' }
      return api.invoke('startLanServer', port)
    },
    async stopServer() {
      const api = ipc()
      if (!api?.invoke) return { success: false, error: 'not-supported' }
      return api.invoke('stopLanServer')
    },
  },

  mcp: {
    async info() {
      const api = ipc()
      if (!api?.invoke) return null
      return api.invoke('mcp-expose-info')
    },
    async setEnabled(payload) {
      const api = ipc()
      if (!api?.invoke) return null
      return api.invoke('mcp-expose-set', payload)
    },
  },

  python: {
    async execute(params) {
      const api = ipc()
      if (!api?.invoke) return { success: false, error: 'not-supported' }
      return api.invoke('executePython', params)
    },
    async checkInstallation() {
      const api = ipc()
      if (!api?.invoke) return { ok: false, error: 'not-supported' }
      return api.invoke('checkPythonInstallation')
    },
  },

  docs: {
    async docxToMarkdown(payload) {
      const api = ipc()
      if (!api?.invoke) return { error: 'not-supported' }
      return api.invoke('docxToMarkdown', payload)
    },
    async exportPdf(payload) {
      const api = ipc()
      if (!api?.invoke) return { success: false, error: 'not-supported' }
      return api.invoke('exportPdf', payload)
    },
    async printSlidesPdf(payload) {
      const api = ipc()
      if (!api?.invoke) return { success: false, error: 'not-supported' }
      return api.invoke('exportSlidesPdf', payload)
    },
  },

  table: {
    async start(path) {
      const api = ipc()
      if (!api?.invoke) return { success: false, error: 'not-supported' }
      return api.invoke('parseTableFile:start', path)
    },
    async chunk(path, offset, limit) {
      const api = ipc()
      if (!api?.invoke) return { success: false, error: 'not-supported' }
      return api.invoke('parseTableFile:chunk', path, offset, limit)
    },
    async done(path) {
      const api = ipc()
      if (!api?.invoke) return { success: false }
      return api.invoke('parseTableFile:done', path)
    },
  },

  excel: {
    async start(payload) {
      const api = ipc()
      if (!api?.invoke) return { success: false, error: 'not-supported' }
      return api.invoke('exportExcel:start', payload)
    },
    async chunk(payload) {
      const api = ipc()
      if (!api?.invoke) return { success: false, error: 'not-supported' }
      return api.invoke('exportExcel:chunk', payload)
    },
    async done() {
      const api = ipc()
      if (!api?.invoke) return { success: false, error: 'not-supported' }
      return api.invoke('exportExcel:done', {})
    },
    async abort() {
      const api = ipc()
      if (!api?.invoke) return { success: false }
      return api.invoke('exportExcel:abort', {})
    },
  },

  skills: {
    async list(roots) {
      const api = ipc()
      if (!api?.invoke) return []
      return api.invoke('loadSkills', roots)
    },
  },

  web: {
    async fetchTitle(url) {
      const api = ipc()
      if (!api?.invoke) return ''
      return api.invoke('fetchWebPageTitle', url)
    },
  },
  /** 本地 ONNX 语音合成（sherpa-onnx，主进程）：渲染层拿 WAV 字节自己播 */
  tts: {
    async status() {
      const api = ipc()
      if (!api?.invoke) return { available: false, error: 'IPC 不可用（请在 Electron 中运行）' }
      return api.invoke('tts:status')
    },
    async load(payload) {
      const api = ipc()
      if (!api?.invoke) return { available: false, error: 'IPC 不可用（请在 Electron 中运行）' }
      return api.invoke('tts:load', payload)
    },
    async synthesize(payload) {
      const api = ipc()
      if (!api?.invoke) throw new Error('IPC 不可用（请在 Electron 中运行）')
      return api.invoke('tts:synthesize', payload)
    },
    /** 桌面不做「直接朗读」：统一走 synthesize + <audio>，避免两套播放路径行为不一致 */
    async speak() {
      return { success: false, error: 'not-supported' }
    },
    async stop() {
      return { success: false }
    },
    async voices() {
      return []
    },
    async dispose() {
      const api = ipc()
      if (!api?.invoke) return { success: false }
      return api.invoke('tts:dispose')
    },
  },
}

/** LLM 接缝：桌面由主进程代理请求（绕开 CORS/CSP，并按 requestId 缓冲回答以支持 resume） */
const llmPort: LlmPort = {
  async start(requestId, spec) {
    const api = ipc()
    if (!api?.invoke) return { success: false, error: 'IPC 不可用（请在 Electron 中运行）' }
    return api.invoke('ai:start', { requestId, spec })
  },

  async abort(requestId) {
    const api = ipc()
    if (!api?.invoke) return { success: false }
    return api.invoke('ai:abort', { requestId })
  },

  async get(requestId) {
    const api = ipc()
    if (!api?.invoke) return null
    return api.invoke('ai:get', { requestId })
  },

  async release(requestId) {
    const api = ipc()
    if (!api?.invoke) return { success: false }
    return api.invoke('ai:release', { requestId })
  },

  async contextWindow(payload) {
    const api = ipc()
    if (!api?.invoke) return null
    return api.invoke('ai:contextWindow', payload)
  },

  async contextWindowDetail(payload) {
    const api = ipc()
    if (!api?.invoke) return null
    return api.invoke('ai:contextWindowDetail', payload)
  },

  async lmstudioModels(payload) {
    const api = ipc()
    if (!api?.invoke) return { models: [] }
    return api.invoke('ai:lmstudioModels', payload)
  },

  async lmstudioCli(payload) {
    const api = ipc()
    if (!api?.invoke) return { ok: false, available: false, models: [] }
    return api.invoke('ai:lmstudioCli', payload)
  },

  async ollamaModels(payload) {
    const api = ipc()
    if (!api?.invoke) return { models: [] }
    return api.invoke('ai:ollamaModels', payload)
  },

  async ollamaModelAction(payload) {
    const api = ipc()
    if (!api?.invoke) return { success: false }
    return api.invoke('ai:ollamaModelAction', payload)
  },

  async check(payload) {
    const api = ipc()
    if (!api?.invoke) return { success: false }
    return api.invoke('ai:check', payload)
  },

  onEvent(cb) {
    const api = ipc()
    if (!api?.on || !api?.off) return () => {}
    const listener = (_e: any, payload: any) => {
      try { cb(payload) } catch (e) { console.warn('[platform] AI 事件处理失败:', e) }
    }
    api.on('ai:event', listener)
    return () => {
      try { api.off('ai:event', listener) } catch { /* 窗口关闭等场景，忽略 */ }
    }
  },
}

/** 浏览器 Agent：桌面专属（主进程 WebContentsView 控制 + 独立窗口） */
const browserAgentPort: BrowserAgentPort = {
  async call(method, payload) {
    const api = ipc()
    if (!api?.invoke) throw new Error('IPC 不可用（请在 Electron 中运行）')
    return api.invoke(`browser-agent:${method}`, payload)
  },
}

/** 终端：桌面专属（主进程 node-pty 真 PTY；输出走 events 总线的 terminal:data / terminal:exit） */
const terminalPort: TerminalPort = {
  async call(method, payload) {
    const api = ipc()
    if (!api?.invoke) return { ok: false, error: 'not-supported' }
    return api.invoke(`terminal:${method}`, payload)
  },
}

export const electronPlatform: Platform = {
  kind: 'electron',
  capabilities,
  fs: fsPort,
  watch: watchPort,
  dialog: dialogPort,
  window: windowPort,
  shell: shellPort,
  app: appPort,
  events: eventsPort,
  host: hostPort,
  llm: llmPort,
  browserAgent: browserAgentPort,
  terminal: terminalPort,
}
