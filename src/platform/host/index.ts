/**
 * platform/host — 局域网主机后端（网页端 / 手机浏览器用）
 *
 * 网页端由主机的局域网共享服务投递（`http://<ip>:3345`），页面与主机**同源**，
 * 因此能力经 `/api/*` 调用主机代做（主机就是 Electron 主进程，能力与桌面一致）。
 *
 * 当前已接通：**文件能力**（读 / 写 / 树 / 元数据 / 搜索；权限档位由主机侧策略决定）。
 * 未接通的能力一律降级为 none，由调用方走各自网页兜底（例如导出退回浏览器下载）。
 *
 * 检测方式：主机在投递 index.html 时注入 `window.__AIKM_HOST__`（见 electron/main/index.ts
 * 的 withHostRuntime），因此这里可以同步判定，无需探测请求。
 */
import type {
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

/** 主机注入的运行时信息（见 withHostRuntime） */
export interface HostRuntimeInfo {
  /** 文件访问档位（主机侧策略） */
  fs: 'off' | 'read' | 'write'
  /** 共享目录名（仅用于界面提示） */
  rootName: string
}

/** 读取主机注入的运行时信息；非局域网访客返回 null */
export function hostRuntime(): HostRuntimeInfo | null {
  if (typeof window === 'undefined') return null
  const info = (window as any).__AIKM_HOST__
  if (!info || typeof info !== 'object') return null
  const fs = info.fs === 'read' || info.fs === 'write' ? info.fs : 'off'
  return { fs, rootName: String(info.rootName || '') }
}

/** 主机文件接口（与 electron/main/lan-fs-api.ts 的路由一一对应） */
async function fsApi(route: string, body?: any): Promise<any> {
  const res = await fetch(`/api/fs/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  if (res.status === 403) {
    const j = await res.json().catch(() => ({}))
    throw new Error(j?.error || '主机拒绝了该文件操作')
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

const READ_ERROR_PREFIX = 'Error reading file: '

/** 展示用名称：路径末段 */
function nameOfPath(p: string): string {
  const norm = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '')
  return norm.split('/').filter(Boolean).pop() || norm
}

/** 目录大小 / 修改时间汇总（与桌面 getDirectoryTree 同口径：大小累加、时间取最新） */
function aggregate(nodes: any[]): { size: number; mtime: number } {
  let size = 0
  let mtime = 0
  for (const n of nodes) {
    if (typeof n?.size === 'number') size += n.size
    if (typeof n?.mtime === 'number' && n.mtime > mtime) mtime = n.mtime
  }
  return { size, mtime }
}

/**
 * 工作区根节点（桌面 refreshMultiTree 会为每个根返回一个节点）。
 * 文件树与工作区列表按「根的 path」对齐：缺这一层会把根的子项当成工作区。
 */
function rootNode(path: string, children: any[]): any {
  const agg = aggregate(children)
  return {
    path,
    rel: path,
    label: nameOfPath(path),
    type: 'folder',
    extension: 'folder',
    children,
    size: agg.size,
    mtime: agg.mtime,
  }
}

function fsPortOf(info: HostRuntimeInfo): FileSystemPort {
  const readable = info.fs !== 'off'
  const writable = info.fs === 'write'
  const writeDenied = { success: false, error: '主机未开启文件写入' } as const

  return {
    async readText(path) {
      if (!readable) throw new Error('主机未开启文件访问')
      const r = await fsApi('read', { path, mode: 'text' })
      return typeof r?.content === 'string' ? r.content : `${READ_ERROR_PREFIX}读取失败`
    },

    async readDataUrl(path) {
      if (!readable) throw new Error('主机未开启文件访问')
      const r = await fsApi('read', { path, mode: 'dataurl' })
      return typeof r?.content === 'string' ? r.content : `${READ_ERROR_PREFIX}读取失败`
    },

    async readBinary(path) {
      if (!readable) return null
      try {
        const res = await fetch('/api/fs/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, mode: 'binary' }),
        })
        if (!res.ok) return null
        return new Uint8Array(await res.arrayBuffer())
      } catch {
        return null
      }
    },

    async saveText(path, content) {
      if (!writable) return false
      try {
        return (await fsApi('write', { path, content }))?.ok === true
      } catch {
        return false
      }
    },

    async writeText(path, content) {
      if (!writable) return { ...writeDenied }
      const r = await fsApi('write', { path, content })
      return r?.ok ? { success: true, path: r.path } : { success: false, error: r?.error }
    },

    async writeBase64(path, base64) {
      if (!writable) return false
      try {
        return (await fsApi('write-base64', { path, base64 }))?.ok === true
      } catch {
        return false
      }
    },

    async writeBinaryBase64(path, base64) {
      if (!writable) return { ...writeDenied }
      const r = await fsApi('write-base64', { path, base64 })
      return r?.ok ? { success: true, path: r.path } : { success: false, error: r?.error }
    },

    /** 同步写盘在网页里不存在（HTTP 是异步的）：返回 false，调用方据此提示 */
    saveTextSync() {
      return false
    },

    async saveMetadata() {
      // frontmatter 由主机的 Markdown 写入路径统一处理，网页端不单独提供
      return false
    },

    async createFile(dirPath, fileName) {
      if (!writable) return null
      try {
        const r = await fsApi('touch', { path: `${dirPath}/${fileName}` })
        return r?.ok ? String(r.path) : null
      } catch {
        return null
      }
    },

    async createFolder(dirPath, folderName) {
      if (!writable) return null
      try {
        const r = await fsApi('mkdir', { path: `${dirPath}/${folderName}` })
        return r?.ok ? String(r.path) : null
      } catch {
        return null
      }
    },

    async deleteFile(path) {
      if (!writable) return false
      try {
        return (await fsApi('delete', { path }))?.ok === true
      } catch {
        return false
      }
    },

    async deleteFolder(path) {
      if (!writable) return { ...writeDenied }
      const r = await fsApi('delete', { path })
      return r?.ok ? { success: true } : { success: false, error: r?.error }
    },

    async copyFile(sourcePath, targetDir) {
      if (!writable) return { ...writeDenied }
      const r = await fsApi('copy', { from: sourcePath, to: targetDir })
      return r?.ok ? { success: true, newPath: r.path } : { success: false, error: r?.error }
    },

    async moveFile(sourcePath, targetDir) {
      if (!writable) return { ...writeDenied }
      const r = await fsApi('move', { from: sourcePath, to: targetDir })
      return r?.ok ? { success: true, newPath: r.path } : { success: false, error: r?.error }
    },

    async renameFile(oldPath, newName) {
      if (!writable) return { ...writeDenied }
      const r = await fsApi('rename', { path: oldPath, name: newName })
      return r?.ok ? { success: true, newPath: r.path } : { success: false, error: r?.error }
    },

    async ensureDir(dirPath) {
      if (!writable) return { ...writeDenied }
      const r = await fsApi('ensure-dir', { path: dirPath })
      return r?.ok ? { success: true } : { success: false, error: r?.error }
    },

    /** 目录树：主机返回嵌套节点（形状与桌面文件树一致） */
    async listTree(folderPath, depth) {
      if (!readable) return []
      const r = await fsApi('tree', { path: folderPath, depth })
      return Array.isArray(r?.nodes) ? r.nodes : []
    },

    /** 图谱视图用：把嵌套树摊平成 fileList + relationList（与桌面 getFilesRelation 同形状） */
    async listTreeWithRelations(folderPath, depth) {
      if (!readable) return { fileList: [], relationList: [] }
      const r = await fsApi('tree', { path: folderPath, depth })
      const nodes: any[] = Array.isArray(r?.nodes) ? r.nodes : []
      const fileList: any[] = []
      const relationList: any[] = []
      const walk = (list: any[], parent: string) => {
        for (const n of list) {
          fileList.push({ path: n.path, label: n.label, type: n.type, extension: n.extension, size: n.size })
          relationList.push({ source: parent, target: n.path })
          if (n.children?.length) walk(n.children, n.path)
        }
      }
      walk(nodes, 'root')
      return { fileList, relationList }
    },

    async getInfo(path) {
      if (!readable) return null
      const r = await fsApi('info', { paths: [path] })
      const it = r?.items?.[0]
      if (!it?.ok) return null
      return {
        type: it.isDir ? 'folder' : 'file',
        label: String(it.label || ''),
        extension: String(it.extension || ''),
      }
    },

    async readMetadata(path) {
      if (!readable) return {}
      const r = await fsApi('meta', { path })
      return r?.config && typeof r.config === 'object' ? r.config : {}
    },

    async scan(folderPath, options) {
      if (!readable) return { success: false, error: '主机未开启文件访问' }
      const r = await fsApi('tree', { path: folderPath, depth: 8 })
      const nodes: any[] = Array.isArray(r?.nodes) ? r.nodes : []
      const exts = (options?.extensions || []).map((e) => String(e).toLowerCase())
      const files: any[] = []
      const max = Number(options?.maxFiles) || 5000
      const walk = (list: any[]) => {
        for (const n of list) {
          if (n.type === 'folder') walk(n.children || [])
          else if (!exts.length || exts.includes(String(n.extension).toLowerCase())) {
            if (files.length < max) files.push({ path: n.path, name: n.label, size: n.size, rel: n.rel })
          }
        }
      }
      walk(nodes)
      return { success: true, files }
    },

    async searchFiles(rootPath, filterText) {
      if (!readable) return []
      const r = await fsApi('search', { path: rootPath, keyword: filterText })
      return Array.isArray(r?.items) ? r.items : []
    },

    async refreshTree(folderPaths, knownVersion) {
      if (!readable) return { success: false, error: '主机未开启文件访问' }
      const roots = Array.isArray(folderPaths) ? folderPaths : []
      const trees: any[] = []
      for (const rp of roots) {
        const r = await fsApi('tree', { path: rp, depth: 6 })
        // 与桌面 refreshMultiTree 同形：每个工作区一个「根节点 + 子树」
        trees.push(rootNode(rp, Array.isArray(r?.nodes) ? r.nodes : []))
      }
      // 网页端无版本号机制：始终全量返回，数据量由 depth 控制
      return { success: true, unchanged: false, tree: trees, version: (Number(knownVersion) || 0) + 1 }
    },

    async isDirectory(path) {
      if (!readable) return false
      try {
        const r = await fsApi('stat', { path })
        return r?.exist === true && r?.isDir === true
      } catch {
        return false
      }
    },

    /** 纯字符串运算，不需要主机往返 */
    async relativePath(fromFile, toFile) {
      const norm = (p: string) => String(p || '').replace(/\\/g, '/')
      const from = norm(fromFile).split('/')
      const to = norm(toFile).split('/')
      from.pop()
      let i = 0
      while (i < from.length && i < to.length && from[i] === to[i]) i++
      const up = from.length - i
      const tail = to.slice(i)
      if (!up && !tail.length) return ''
      return [...Array(up).fill('..'), ...tail].join('/') || null
    },

    async resolveRelativePath(baseFile, relativePath) {
      const rel = String(relativePath || '').replace(/\\/g, '/')
      if (rel.startsWith('/')) return rel
      const base = String(baseFile || '').replace(/\\/g, '/').split('/')
      base.pop()
      const out: string[] = []
      for (const seg of [...base, ...rel.split('/')]) {
        if (!seg || seg === '.') continue
        if (seg === '..') out.pop()
        else out.push(seg)
      }
      return out.join('/') || null
    },

    /** 任务文件的「选择并读取」需要原生对话框：网页端不支持 */
    async pickTaskFile() {
      return { success: false, error: 'not-supported' }
    },

    async readTaskFile(path, maxBytes) {
      if (!readable) return { success: false, error: 'not-supported' }
      const text = await this.readText(path)
      const limited = typeof maxBytes === 'number'
      return { success: true, content: limited ? text.slice(0, maxBytes) : text, path, partial: limited }
    },

    /** 另存为对话框在网页端不存在 */
    async saveTaskFileAs() {
      return { success: false, error: 'not-supported' }
    },

    async saveTaskFileAuto(referencePath, content) {
      if (!writable) return { ...writeDenied }
      const r = await fsApi('write', { path: referencePath, content })
      return r?.ok ? { success: true, path: referencePath } : { success: false, error: r?.error }
    },

    async writeTaskFile(path, content) {
      if (!writable) return { ...writeDenied }
      const r = await fsApi('write', { path, content })
      return r?.ok ? { success: true, path } : { success: false, error: r?.error }
    },

    /** 网页端没有「另存到任意路径」概念：交由调用方退回浏览器下载 */
    async saveBase64() {
      return { ok: false, error: 'not-electron' }
    },

    async saveRemoteDownload() {
      return { success: false, error: 'not-supported' }
    },

    async setDownloadDirHint() { /* 网页端由浏览器管理下载目录 */ },

    onDownloadComplete() {
      // 浏览器下载完成事件拿不到落盘路径
      return () => {}
    },
  }
}

function capabilitiesOf(info: HostRuntimeInfo): PlatformCapabilities {
  const modes: Partial<Record<CapabilityId, CapabilityMode>> = {
    'fs.pathRead': info.fs === 'off' ? 'none' : 'local',
    'fs.pathWrite': info.fs === 'write' ? 'local' : 'none',
  }
  return {
    kind: 'host',
    mode(id) { return modes[id] || 'none' },
    has(id) { return (modes[id] || 'none') !== 'none' },
  }
}

/** 以下端口在网页端本就没有对应能力：一律安全降级（调用方已有兜底分支） */
const watchPort: WatchPort = {
  onChange() { return () => {} },
  async acquire() { /* 网页端无目录监听 */ },
  async release() { /* 同上 */ },
  async watchFile() { return { success: false, error: 'not-supported' } },
  async unwatchFile() { return { success: false, error: 'not-supported' } },
}

const dialogPort: DialogPort = {
  async pickDirectory() { return null },
  async pickFile() { return null },
  async pickFiles() { return [] },
  async saveFile() { return null },
  async pickTextFile() { return { content: null, filePath: null } },
}

const windowPort: WindowPort = {
  async minimize() { /* 无窗口壳 */ },
  async toggleMaximize() { /* 无窗口壳 */ },
  async close() { /* 无窗口壳 */ },
  async toggleFullscreen() { return false },
  async getZoom() { return 1 },
  async setZoom(factor) { return factor },
  async restartApp() { /* 无窗口壳 */ },
  async openFileWindow() { /* 网页端应改为当前窗口路由，由调用方降级 */ },
  async openPluginPanelWindow() { return false /* 无窗口壳：调用方退回应用内浮层 */ },
  async toggleDevTools() { /* 无窗口壳 */ },
}

const shellPort: ShellPort = {
  async openWithSystemApp() { return { success: false, error: 'not-supported' } },
  async revealInFolder() { return false },
  async openByApp() { /* 无系统集成 */ },
  async registerShortcut() { return { success: false, error: 'not-supported' } },
  async unregisterShortcut() { /* 无系统集成 */ },
  /** 网页端没有系统分享面板（手机浏览器虽有 Web Share，但绕不过用户手势要求，交由调用方降级） */
  async share() { return { success: false, error: 'not-supported' } },
}

const appPort: AppPort = {
  async getBehavior() { return { closeToTray: false } },
  async setBehavior() { return { closeToTray: false } },
  async getFileAssocState() { return { ok: false, error: { message: 'not-supported' } } },
  async setFileAssoc() { return { ok: false, error: { message: 'not-supported' } } },
  async dataDirPath() { return { success: false, path: '', error: 'not-supported' } },
  async openDataDir() { return { success: false, path: '', error: 'not-supported' } },
  async cleanUserdataCache() { return { ok: false, error: 'not-supported' } },
  async userdataCacheInfo() { return { ok: false, bytes: 0 } },
  async isSettingsWindowOpen() { return false },
  async notifyUiReady() { /* 网页端无宿主就绪握手 */ },
  async notifyFileChanged() { /* 单页，无广播对象 */ },
  /** 网页端不需要长任务保活（标签页不会被系统回收） */
  async beginLongTask() { return { success: false, error: 'not-supported' } },
  async updateLongTask() { return { success: false } },
  async endLongTask() { return { success: false } },
  /** 网页端没有系统返回手势（返回键由浏览器自身处理） */
  onBackPressed() { return () => {} },
}

const eventsPort: EventsPort = {
  on() { return () => {} },
  emit() { /* 网页端无多窗口广播 */ },
}

const hostPort: HostPort = {
  lan: {
    async getGuest() { return { policy: null, info: null } },
    async setGuest() { return { success: false } },
    async setKbDir() { return { success: false } },
    async setEmbed() { return { success: false } },
    async getServerInfo() { return null },
    async startServer() { return { success: false, error: 'not-supported' } },
    async stopServer() { return { success: false, error: 'not-supported' } },
  },
  mcp: {
    async info() { return null },
    async setEnabled() { return null },
  },
  python: {
    async execute() { return { success: false, error: 'not-supported' } },
    async checkInstallation() { return { ok: false, error: 'not-supported' } },
  },
  docs: {
    async docxToMarkdown() { return { error: 'not-supported' } },
    async exportPdf() { return { success: false, error: 'not-supported' } },
    async printSlidesPdf() { return { success: false, error: 'not-supported' } },
  },
  table: {
    async start() { return { success: false, error: 'not-supported' } },
    async chunk() { return { success: false, error: 'not-supported' } },
    async done() { return { success: false } },
  },
  excel: {
    async start() { return { success: false, error: 'not-supported' } },
    async chunk() { return { success: false, error: 'not-supported' } },
    async done() { return { success: false, error: 'not-supported' } },
    async abort() { return { success: false } },
  },
  skills: {
    async list() { return [] },
  },
  web: {
    async fetchTitle() { return '' },
  },
  /**
   * 主机不代做语音（网页端由浏览器 Web Speech 承担，见 services/tts/manager.ts）：
   * status().available 固定 false，调用方据此走 Web Speech 分支。
   */
  tts: {
    async status() { return { available: false, error: null } },
    async load() { return { available: false, error: 'not-supported' } },
    async synthesize() { throw new Error('not-supported') },
    async speak() { return { success: false, error: 'not-supported' } },
    async stop() { return { success: false } },
    async voices() { return [] },
    async dispose() { return { success: true } },
  },
}

/** 网页端无宿主 LLM 代理：`llm.hosted` 为 none → 调用方走 shared/ai-core 直连（含 /__proxy 兜底） */
const llmPort: LlmPort = {
  async start() { return { success: false, error: 'not-supported' } },
  async abort() { return { success: false } },
  async get() { return null },
  async release() { return { success: false } },
  async contextWindow() { return null },
  async contextWindowDetail() { return null },
  async lmstudioModels() { return { models: [] } },
  async lmstudioCli() { return { ok: false, available: false, models: [] } },
  async ollamaModels() { return { models: [] } },
  async ollamaModelAction() { return { success: false } },
  async check() { return { success: false } },
  onEvent() { return () => {} },
}

const browserAgentPort: BrowserAgentPort = {
  async call() { throw new Error('not-supported') },
}

/** 远端宿主没有交互终端（终端是本地宿主进程的能力） */
const terminalPort: TerminalPort = {
  async call() { return { ok: false, error: 'not-supported' } },
}

/** 构造局域网主机后端 */
export function createHostPlatform(info: HostRuntimeInfo): Platform {
  return {
    kind: 'host',
    capabilities: capabilitiesOf(info),
    fs: fsPortOf(info),
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
}
