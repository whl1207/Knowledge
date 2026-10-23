/**
 * platform/browser — 无宿主时的降级后端（浏览器 dev / 局域网访客网页）
 *
 * 这些能力在纯网页里都无法完成：写盘只能走浏览器下载、目录监听不存在、
 * 页面下载的实际落盘路径也无从获取。故一律 none，由调用方走各自的降级分支
 * （例如 download.ts 退回 `<a download>`）。
 *
 * 读文件调用的历史行为是「在浏览器里直接抛错」（`window.ipcRenderer` 为 undefined），
 * 这里保持抛错语义，只是换成可读的错误信息，避免让调用方把错误当内容处理。
 *
 * 局域网主机可用时才具备的能力（远端文件、主机端 agent）后续在此按 host 形态接入。
 */
import type {
  AppPort,
  BrowserAgentPort,
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

const IPC_UNAVAILABLE = 'IPC 不可用（请在 Electron 中运行）'

const capabilities: PlatformCapabilities = {
  kind: 'browser',
  mode() { return 'none' },
  has() { return false },
}

/** 'not-electron' 是与既有调用方约定的「环境不支持写盘」标识（见 privateWord / rendererTasks） */
const fsPort: FileSystemPort = {
  async readText() { throw new Error(IPC_UNAVAILABLE) },
  async readDataUrl() { throw new Error(IPC_UNAVAILABLE) },
  async readBinary() { return null },
  async saveText() { return false },
  async writeText() { return { success: false, error: 'not-supported' } },
  async writeBase64() { return false },
  async writeBinaryBase64() { return { success: false, error: 'not-supported' } },
  saveTextSync() { return false },
  async saveMetadata() { return false },
  async createFile() { return null },
  async createFolder() { return null },
  async deleteFile() { return false },
  async deleteFolder() { return { success: false, error: 'not-supported' } },
  async copyFile() { return { success: false, error: 'not-supported' } },
  async moveFile() { return { success: false, error: 'not-supported' } },
  async renameFile() { return { success: false, error: 'not-supported' } },
  async ensureDir() { return { success: false, error: 'not-supported' } },
  async listTree() { return [] },
  async listTreeWithRelations() { return { fileList: [], relationList: [] } },
  async getInfo() { return null },
  async readMetadata() { return {} },
  async scan() { return { success: false, error: 'not-supported' } },
  async searchFiles() { return [] },
  async refreshTree() { return { success: false, error: 'not-supported' } },
  async isDirectory() { return false },
  async relativePath() { return null },
  async resolveRelativePath() { return null },
  async pickTaskFile() { return { success: false, error: 'not-supported' } },
  async readTaskFile() { return { success: false, error: 'not-supported' } },
  async saveTaskFileAs() { return { success: false, error: 'not-supported' } },
  async saveTaskFileAuto() { return { success: false, error: 'not-supported' } },
  async writeTaskFile() { return { success: false, error: 'not-supported' } },
  async saveBase64() { return { ok: false, error: 'not-electron' } },
  async saveRemoteDownload() { return { success: false, error: 'not-electron' } },
  async setDownloadDirHint() { /* 无下载兜底目录概念，静默忽略 */ },
  onDownloadComplete() { return () => {} },
}

/** 无原生对话框：一律按「用户取消」返回空值，调用方已有取消分支 */
const dialogPort: DialogPort = {
  async pickDirectory() { return null },
  async pickFile() { return null },
  async pickFiles() { return [] },
  async saveFile() { return null },
  async pickTextFile() { return { content: null, filePath: null } },
}

/** 无窗口壳：静默空操作，避免标题栏按钮在网页里报错 */
const windowPort: WindowPort = {
  async minimize() { /* 无窗口壳 */ },
  async toggleMaximize() { /* 无窗口壳 */ },
  async close() { /* 无窗口壳 */ },
  async toggleFullscreen() { return false },
  async getZoom() { return 1 },
  async setZoom(factor) { return factor },
  async restartApp() { /* 无窗口壳 */ },
  async openFileWindow() { /* 多窗口在网页里应改为当前窗口路由或新标签页，由调用方降级 */ },
  async openPluginPanelWindow() { return false /* 无窗口壳：调用方退回应用内浮层 */ },
  async toggleDevTools() { /* 无窗口壳 */ },
}

/** 无系统集成：用浏览器下载 / 分享代替，调用方按失败处理 */
const shellPort: ShellPort = {
  async openWithSystemApp() { return { success: false, error: 'not-supported' } },
  async revealInFolder() { return false },
  async openByApp() { /* 无系统集成 */ },
  async registerShortcut() { return { success: false, error: 'not-supported' } },
  async unregisterShortcut() { /* 无系统集成 */ },
  async injectSystemText() { return { success: false, error: 'not-supported' } },
  async systemDictationStatus() { return { supported: false, error: 'not-supported' } },
  async setAsrHoldMode() { return { success: false, supported: false, error: 'not-supported' } },
  /** 网页端没有系统分享面板（手机浏览器虽有 Web Share，但需要用户手势与文件对象，交由调用方降级） */
  async share() { return { success: false, error: 'not-supported' } },
}

/** 无应用壳：返回安全默认值，调用方据此提示或隐藏入口 */
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
  async notifyUiReady() { /* 无宿主 */ },
  async notifyFileChanged() { /* 单窗口，无可通知对象 */ },
  /** 浏览器不需要长任务保活（标签页不会被系统回收，切后台由浏览器自行调度） */
  async beginLongTask() { return { success: false, error: 'not-supported' } },
  async updateLongTask() { return { success: false } },
  async endLongTask() { return { success: false } },
  /** 浏览器没有系统返回手势（返回键由浏览器自身处理） */
  onBackPressed() { return () => {} },
}

/** 无事件总线：订阅返回空退订函数，广播静默丢弃（单窗口本来也不需要同步） */
const eventsPort: EventsPort = {
  on() { return () => {} },
  emit() { /* 无宿主 */ },
}

const watchPort: WatchPort = {
  onChange() { return () => {} },
  async acquire() { /* 无目录监听能力，静默降级 */ },
  async release() { /* 同上 */ },
  async watchFile() { return { success: false, error: 'not-supported' } },
  async unwatchFile() { return { success: false, error: 'not-supported' } },
}

/** 无宿主侧重能力：一律返回失败/空值（网页端与安卓需经宿主桥接后才有） */
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
   * 宿主不提供语音合成：网页端由浏览器的 Web Speech（speechSynthesis）承担，见 services/tts/manager.ts，
   * 因此这里 status().available 固定为 false（调用方据此走 Web Speech 分支）。
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

/**
 * LLM 接缝（无宿主）：`llm.hosted` 为 none，调用方（services/ai-utils.ts）会走 `shared/ai-core.ts` 直连，
 * 因此这里的方法不会被真正调用，仅保证接口完整与失败可见。
 */
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

/** 无浏览器 Agent：调用方既有 `.catch(() => …)` 会静默降级 */
const browserAgentPort: BrowserAgentPort = {
  async call() { throw new Error('not-supported') },
}

/** 纯网页没有本地终端（无 PTY）：终端标签按能力隐藏 */
const terminalPort: TerminalPort = {
  async call() { return { ok: false, error: 'not-supported' } },
}

export const browserPlatform: Platform = {
  kind: 'browser',
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
