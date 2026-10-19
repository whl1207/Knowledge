/**
 * platform/contract — 平台能力契约（M1 接缝）
 *
 * 渲染层不再直接依赖 Electron preload（`window.dsh` / `window.ipcRenderer`），
 * 只依赖这里的接口；每个运行环境注册一套实现：
 *   electron（桌面，现有 IPC）/ android（Capacitor 插件）/ browser（无宿主时的降级）
 *
 * 能力形态用 `CapabilityMode` 描述 —— 这是「本地优先 + 可连桌面主机」混合形态的关键：
 *   local = 本机本进程可直接完成
 *   host  = 需经局域网主机（访客网页模式的 HTTP / SSE 通道）
 *   none  = 当前环境不支持，调用方必须自行降级（例如退回浏览器式下载）
 *
 * 端口按迁移进度增补：只添加已有真实调用方的端口，不给未来可能的用法预留空契约。
 */

/** 运行环境 */
export type RuntimeKind = 'electron' | 'android' | 'host' | 'browser'

/** 能力标识（随迁移进度增补） */
export type CapabilityId =
  /** 按路径读文件（文本 / data URL / 二进制） */
  | 'fs.pathRead'
  /** 按路径直写磁盘（桌面由主进程实写；安卓为 SAF） */
  | 'fs.pathWrite'
  /** 保存局域网远程下载的二进制内容 */
  | 'fs.remoteSave'
  /** 目录变更监听（桌面为 fs.watch；安卓需轮询，可降级为 host） */
  | 'fs.watch'
  /** 宿主把页面发起的下载静默落盘，并回传真实路径 */
  | 'downloadSink'
  /** 原生文件/目录选择框（浏览器无此能力，只能退回访客侧 File API 或隐藏入口） */
  | 'dialog.native'
  /** 窗口壳控制：最小化 / 最大化 / 关闭 / 全屏 / 缩放 / 多窗口 / 重启（浏览器/手机无窗口壳） */
  | 'window.chrome'
  /** 用系统默认应用打开 / 在文件管理器中定位（手机为 Intent / 分享） */
  | 'shell.systemOpen'
  /** 系统分享面板（手机 / 支持 Web Share 的浏览器；桌面无此概念 → 入口按能力隐藏） */
  | 'shell.share'
  /** 系统级全局快捷键（浏览器无此能力） */
  | 'shell.globalShortcut'
  /** 应用壳：壳行为配置 / 文件关联 / 数据目录 / 设置窗口状态（桌面主进程维护） */
  | 'app.shell'
  /** 长任务前台服务：长任务期间保持进程存活 + 进度通知（安卓；桌面/网页天然不被回收） */
  | 'app.longTask'
  /** 窗口与宿主事件总线（多窗口广播 + 宿主事件推送；单窗口环境无此总线） */
  | 'events.bus'
  /** 局域网共享主机侧控制（启动/停止服务、共享目录、访客策略、嵌入配置） */
  | 'host.lanShare'
  /** 内置 MCP 服务对外暴露（端点开关与信息） */
  | 'host.mcpExpose'
  /** Python 执行与安装检测（桌面为沙箱子进程，安卓无此能力） */
  | 'host.python'
  /** 文档转换（Word→Markdown、HTML→PDF） */
  | 'host.docConvert'
  /** 大表格分块读取（避免整表入内存） */
  | 'host.tableLoad'
  /** 宿主侧联网抓取（如网页标题：浏览器受 CORS 限制读不到任意页面） */
  | 'host.netFetch'
  /** 分块导出 Excel */
  | 'host.excelExport'
  /** 技能库装载（宿主扫描技能目录并提供清单） */
  | 'skills.store'
  /** LLM 请求由宿主代理（桌面：是，可绕开 CORS/CSP 并落盘缓冲；纯网页/安卓：否，调用方直连） */
  | 'llm.hosted'
  /** 浏览器 Agent（桌面为独立窗口 + 主进程 WebContentsView 控制；其它环境无此子系统） */
  | 'browserAgent'
  /** 终端（桌面：主进程 node-pty 真 PTY；其它环境无 TTY，入口按能力隐藏） */
  | 'terminal'
  /** 语音合成 / 朗读（桌面为本地 ONNX 合成 WAV；安卓为系统 TTS 直接朗读；不支持时为 none） */
  | 'host.tts'

export type CapabilityMode = 'local' | 'host' | 'none'

/** 原生对话框的文件类型过滤（与 Electron 的 filters 同形） */
export interface FileDialogFilter {
  name: string
  extensions: string[]
}

export interface FileDialogOptions {
  filters?: FileDialogFilter[]
  /** Electron OpenDialog 的 properties（如 ['openFile', 'multiSelections']） */
  properties?: string[]
}

/** 按路径写盘的结果（与主进程 exportDocx 的返回契约一致） */
export interface PathWriteResult {
  ok: boolean
  path?: string
  error?: string
}

/** 写操作结果（与主进程同名通道同形） */
export interface WriteResult {
  success: boolean
  path?: string
  newPath?: string
  error?: string
}

/** .task 文件读写结果（与主进程同名通道同形） */
export interface TaskFileResult {
  success: boolean
  content?: string
  path?: string
  /** readTaskFile 只读文件头时为 true */
  partial?: boolean
  error?: string
}

export interface FileSystemPort {
  /**
   * 读文本：`.md`/`.txt`/`.kb` 等按 UTF-8 返回；`.docx` 由 Office 管线转 Markdown；`.pdf` 返回抽取文本。
   * 失败**不抛错**，返回 `Error reading file: …` 前缀字符串（沿用主进程既有契约，
   * 调用方以 `startsWith('Error reading file')` 判定）。
   */
  readText(path: string): Promise<string>
  /** 读为 data URL（`data:<mime>;base64,…`）；失败同样返回 `Error reading file: …` 字符串 */
  readDataUrl(path: string): Promise<string>
  /** 读二进制；不存在或失败返回 null */
  readBinary(path: string): Promise<Uint8Array | null>
  /**
   * 写文本并返回是否成功（原 `saveFile`）。目录不存在时由宿主创建。
   */
  saveText(path: string, content: string): Promise<boolean>
  /** 写文本，返回 {@link WriteResult}（原 `writeFile`；自动建目录） */
  writeText(path: string, content: string): Promise<WriteResult>
  /**
   * 按 base64 写文件，返回是否成功（原 `writeFileBase64`；接受 `data:…;base64,` 前缀）。
   * 二进制内容必须走这里，`saveText`/`writeText` 只按 UTF-8 写。
   */
  writeBase64(path: string, base64: string): Promise<boolean>
  /** 按 base64 写文件，返回 {@link WriteResult}（原 `writeBase64`） */
  writeBinaryBase64(path: string, base64: string): Promise<WriteResult>
  /**
   * **同步**写文本，仅用于窗口关闭前的兜底落盘（原 `saveFileSync`，Electron 走 sendSync）。
   * 无同步写盘能力的后端返回 false，调用方需据此提示或改走异步保存。
   */
  saveTextSync(path: string, content: string): boolean
  /** 更新 Markdown 文件的 YAML frontmatter 元数据（原 `saveFileMetadata`） */
  saveMetadata(path: string, metadata: Record<string, unknown>): Promise<boolean>
  /** 新建空文件，返回新路径（已存在或失败返回 null） */
  createFile(dirPath: string, fileName: string): Promise<string | null>
  /** 新建文件夹，返回新路径（已存在或失败返回 null） */
  createFolder(dirPath: string, folderName: string): Promise<string | null>
  /** 删除文件（桌面优先移入回收站）；返回是否成功 */
  deleteFile(path: string): Promise<boolean>
  /** 递归删除文件夹 */
  deleteFolder(path: string): Promise<{ success: boolean; error?: string }>
  /** 复制文件到目标目录，返回新路径 */
  copyFile(sourcePath: string, targetDir: string): Promise<WriteResult>
  /** 移动文件到目标目录，返回新路径 */
  moveFile(sourcePath: string, targetDir: string): Promise<WriteResult>
  /** 重命名文件（同目录内），返回新路径 */
  renameFile(oldPath: string, newName: string): Promise<WriteResult>
  /** 确保目录存在（递归创建） */
  ensureDir(dirPath: string): Promise<{ success: boolean; error?: string }>
  /** 读目录树（懒展开用；depth 默认由宿主决定） */
  listTree(folderPath: string, depth?: number): Promise<any[]>
  /** 读一次目录树 + 节点关系（图谱视图用） */
  listTreeWithRelations(folderPath: string, depth?: number): Promise<{ fileList: any[]; relationList: any[] }>
  /** 取单个路径的信息（type/label/extension）；不存在返回 null */
  getInfo(path: string): Promise<{ type: string; label: string; extension: string } | null>
  /** 读 Markdown 的 YAML frontmatter（目录则读其 .README.md）；非 md 返回空对象 */
  readMetadata(path: string): Promise<Record<string, unknown>>
  /** 按扩展名/排除规则扫描目录（脚手架用） */
  scan(
    folderPath: string,
    options?: { extensions?: string[]; excludeDirs?: string[]; excludeFiles?: string[]; maxFiles?: number },
  ): Promise<{ success: boolean; files?: any[]; error?: string }>
  /** 全文/文件名搜索 */
  searchFiles(rootPath: string, filterText: string): Promise<any[]>
  /** 多工作区树刷新（knownVersion 命中则 unchanged=true，避免整树传输） */
  refreshTree(
    folderPaths: string[],
    knownVersion?: number,
  ): Promise<{ success: boolean; unchanged?: boolean; tree?: any; version?: number; error?: string }>
  /** 是否目录（不存在返回 false） */
  isDirectory(path: string): Promise<boolean>
  /** 取相对路径（统一 / 分隔）；失败返回 null */
  relativePath(fromFile: string, toFile: string): Promise<string | null>
  /** 相对路径 → 绝对路径；失败返回 null */
  resolveRelativePath(baseFile: string, relativePath: string): Promise<string | null>
  /** 弹窗选择并读取 .task 文件（脚手架任务） */
  pickTaskFile(): Promise<TaskFileResult>
  /** 按路径读取 .task 文件（maxBytes 用于只读文件头） */
  readTaskFile(path: string, maxBytes?: number): Promise<TaskFileResult>
  /** 另存为 .task 文件（弹窗） */
  saveTaskFileAs(content: string): Promise<TaskFileResult>
  /** 按参考路径自动落盘 .task 文件（不弹窗） */
  saveTaskFileAuto(referencePath: string, content: string): Promise<TaskFileResult>
  /** 直接写 .task 文件到指定路径 */
  writeTaskFile(path: string, content: string): Promise<TaskFileResult>
  /**
   * 写 base64 内容到 targetPath：targetPath 只有文件名时由宿主落到系统下载目录；
   * overwrite=false（默认）时重名自动追加 (1)，避免静默覆盖。
   */
  saveBase64(payload: { base64: string; targetPath: string; overwrite?: boolean }): Promise<PathWriteResult>
  /**
   * 告知宿主「页面发起的下载兜底应落在哪个目录」（如 drawio 导出与图表同目录）。
   * 无此能力的环境静默忽略。
   */
  setDownloadDirHint(dir: string): Promise<void>
  /** 保存远程（局域网共享）下载的二进制内容到指定目录 */
  saveRemoteDownload(payload: {
    dir: string
    name: string
    data: number[]
  }): Promise<{ success: boolean; path?: string; error?: string }>
  /** 页面下载被宿主静默落盘后回调真实路径；不支持时返回空退订函数 */
  onDownloadComplete(cb: (path: string) => void): () => void
}

export interface WatchPort {
  /** 订阅文件变更（去抖由调用方负责）；不支持时返回空退订函数 */
  onChange(cb: (payload: unknown) => void): () => void
  /** 申请目录监听（幂等） */
  acquire(roots: string[]): Promise<void>
  /** 释放目录监听 */
  release(): Promise<void>
  /** 监听单个文件的变更（原 watchFile；变更经事件总线的 watchedFileChanged 推送） */
  watchFile(path: string): Promise<{ success: boolean; error?: string }>
  /** 取消单文件监听（原 unwatchFile） */
  unwatchFile(): Promise<{ success: boolean; error?: string }>
}

/** 原生对话框：不可用时一律按「用户取消」返回空值（调用方通常已有取消分支） */
export interface DialogPort {
  /** 选目录；取消或不支持返回 null */
  pickDirectory(): Promise<string | null>
  /** 选单个文件；取消或不支持返回 null */
  pickFile(options?: FileDialogOptions): Promise<string | null>
  /** 选多个文件；取消或不支持返回空数组 */
  pickFiles(options?: FileDialogOptions): Promise<string[]>
  /** 另存为；取消或不支持返回 null */
  saveFile(options?: { defaultPath?: string; filters?: FileDialogFilter[] }): Promise<string | null>
  /** 选一个文本文件并读回其原始内容（主进程一次完成选+读；取消返回空内容） */
  pickTextFile(): Promise<{ content: string | null; filePath: string | null }>
}

/** 打开文件窗口的载荷（与主进程 open-file-window 同形） */
export interface OpenFileWindowPayload {
  path: string
  view?: string
  remoteRootId?: string
  remoteRel?: string
  label?: string
  page?: string | number
}

/**
 * 以「独立子窗口」打开一个插件主面板的载荷（与主进程 open-plugin-panel-window 同形）。
 *
 * `key` 是 `panel.main` 槽位条目的 key（= store.mainPanel 的取值，历史字符串如 '知识管理'），
 * 子窗口自己会经插件运行时注册同名条目，因此只传 key 就够定位；
 * `pluginId` / `title` 只用于窗口标题与兜底文案（拿不到注册表时仍能显示标题）。
 */
export interface OpenPluginPanelPayload {
  key: string
  pluginId?: string
  title?: string
  icon?: string
}

/** 窗口壳控制：不可用时为静默空操作（不抛错，避免标题栏按钮报错） */
export interface WindowPort {
  minimize(): Promise<void>
  /** 切换最大化 / 还原 */
  toggleMaximize(): Promise<void>
  close(): Promise<void>
  /** 切换全屏，返回切换后的状态 */
  toggleFullscreen(): Promise<boolean>
  /** 全局缩放因子（1 = 100%） */
  getZoom(): Promise<number>
  /** 设置全局缩放因子，返回生效后的值 */
  setZoom(factor: number): Promise<number>
  /** 崩溃/初始化场景下重启应用（桌面为主进程重启；其它环境无操作） */
  restartApp(): Promise<void>
  /** 以独立窗口打开文件（手机/浏览器应改为当前窗口路由或新标签页） */
  openFileWindow(payload: OpenFileWindowPayload): Promise<void>
  /**
   * 以独立子窗口打开插件主面板（桌面为真窗口；无窗口壳的浏览器 / 安卓端应拒绝，
   * 调用方据此退回「应用内浮层」——见 store.openPluginPanel）。
   * 返回是否真的打开了独立窗口。
   */
  openPluginPanelWindow(payload: OpenPluginPanelPayload): Promise<boolean>
  /** 开合开发者工具（桌面调试用；其它环境无操作） */
  toggleDevTools(): Promise<void>
}

/** 系统集成：不可用时静默失败，调用方按返回值提示 */
export interface ShellPort {
  /** 用系统默认应用打开路径 */
  openWithSystemApp(path: string): Promise<{ success: boolean; error?: string }>
  /** 在系统文件管理器中定位该路径 */
  revealInFolder(path: string): Promise<boolean>
  /** 历史通道：用系统默认应用打开（不存在时静默忽略） */
  openByApp(path: string): Promise<void>
  /** 注册系统级全局快捷键（返回是否注册成功） */
  registerShortcut(accelerator: string): Promise<{ success: boolean; error?: string }>
  /** 注销全局快捷键 */
  unregisterShortcut(): Promise<void>
  /** 分享文件（手机为系统分享面板；支持 Web Share 的浏览器亦可；无能力时调用方隐藏入口） */
  share(path: string, opts?: { title?: string; mime?: string }): Promise<{ success: boolean; error?: string }>
}

/** 数据目录类操作的返回（与主进程 open-data-dir / data-dir-path 同形） */
export interface DataDirResult {
  success: boolean
  path: string
  error?: string
}

/** 文件关联查询/设置的返回（与主进程同名通道同形） */
export interface FileAssocResult {
  ok: boolean
  data?: unknown
  error?: { message?: string }
}

/**
 * 应用壳：壳行为与数据目录。这些都由桌面主进程维护，浏览器/手机没有对应概念，
 * 因此无能力时返回「安全默认值」（如 closeToTray=false），调用方据此提示或隐藏入口。
 */
export interface AppPort {
  /** 关闭按钮行为（折叠到托盘）等壳行为配置 */
  getBehavior(): Promise<{ closeToTray: boolean }>
  setBehavior(payload: { closeToTray?: boolean }): Promise<{ closeToTray: boolean }>
  getFileAssocState(): Promise<FileAssocResult>
  setFileAssoc(payload: { key?: string; mode?: string }): Promise<FileAssocResult>
  /** 应用数据目录（userData）路径；sub 为单层相对子目录 */
  dataDirPath(sub?: string): Promise<DataDirResult>
  /** 在系统文件管理器中打开数据目录 */
  openDataDir(sub?: string): Promise<DataDirResult>
  /** 清理可安全删除的缓存（Chromium 缓存 / Word 预览图片缓存） */
  cleanUserdataCache(): Promise<{ ok: boolean; freed?: number; removed?: string[]; failed?: string[]; error?: string }>
  /** 可安全删除的缓存占用（字节） */
  userdataCacheInfo(): Promise<{ ok: boolean; bytes: number }>
  /** 设置独立窗口是否已打开（决定设置页以浮层还是独立窗口呈现） */
  isSettingsWindowOpen(): Promise<boolean>
  /** 主窗口 UI 就绪（主进程据此冲刷早到的打开文件请求） */
  notifyUiReady(): Promise<void>
  /** 通知其它窗口某文件内容已变（单窗口环境无可通知对象） */
  notifyFileChanged(payload: { path: string; content?: string }): Promise<void>
  /**
   * 长任务前台服务：长任务（知识处理 / 批量导出等）开始时调用，
   * 让系统知道后台还在干活（安卓前台服务 + 进度通知）；其它环境为空操作。
   */
  beginLongTask(payload: { title?: string; text?: string; progress?: number; indeterminate?: boolean }): Promise<{ success: boolean; error?: string }>
  /** 更新长任务进度（通知文案与进度条） */
  updateLongTask(payload: { text?: string; progress?: number; indeterminate?: boolean }): Promise<{ success: boolean }>
  /** 结束长任务并移除通知 */
  endLongTask(): Promise<{ success: boolean }>
  /**
   * 系统返回手势 / 返回键（安卓壳；其它平台为空实现，永不回调）。
   *
   * 安卓壳的界面栈是渲染层状态（设置浮层 / 应用内文件窗口 / 主面板），WebView 不知道，
   * 因此返回手势要先问渲染层：回调返回 true = 已处理（不退出应用），false = 交回系统默认（结束应用）。
   * 返回退订函数。
   */
  onBackPressed(cb: () => boolean | Promise<boolean>): () => void
}

/**
 * 渲染层使用的宿主事件通道（新增需登记；未登记通道名会在此处编译报错）。
 * 约定：宿主把事件推给渲染层，渲染层也可用 emit 反向广播。
 */
export type AppEventChannel =
  | 'settings-config-changed'
  | 'settings-window-state'
  | 'window:zoom-changed'
  | 'open-file-request'
  | 'theme-changed'
  | 'chats-changed'
  | 'settings:navigate'
  | 'server-status'
  | 'asr-shortcut-toggle'
  | 'mcp-status-changed'
  | 'lan-server-status'
  | 'lan:guest-state'
  | 'lan:request-guest-policy'
  | 'browser-agent:event'
  | 'browser-agent:toast'
  /** 终端输出 / 退出（主进程 → 渲染层；见 TerminalPort） */
  | 'terminal:data'
  | 'terminal:exit'
  | 'file-content-changed'
  | 'file-window-set-page'
  | 'watchedFileChanged'
  | 'tray:status'
  | 'notify-theme-change'
  | 'theme-background-changed'

/** 宿主事件总线：多窗口广播与宿主事件推送（单窗口/无宿主时静默降级） */
export interface EventsPort {
  /**
   * 订阅；返回退订函数（比 ipcRenderer 的 on/off 配对更不易泄漏）。
   * 载荷沿用 any：宿主事件没有跨进程类型契约，与既有 ipcRenderer 监听器行为一致。
   */
  on(channel: AppEventChannel, cb: (payload: any) => void): () => void
  /** 广播（fire-and-forget）；宿主不在时不报错 */
  emit(channel: AppEventChannel, payload?: unknown): void
}

/** 宿主侧重能力总入口：这些能力都由宿主（桌面主进程 / 远端主机）执行，客户端只做调用。
 *  每个子 API 对应一个独立能力标识，便于按环境分别开合（网页端多为 none，可经宿主桥接为 host）。 */
export interface HostPort {
  readonly lan: LanShareApi
  readonly mcp: McpExposeApi
  readonly python: PythonApi
  readonly docs: DocConvertApi
  readonly table: TableLoadApi
  readonly excel: ExcelExportApi
  readonly skills: SkillsApi
  readonly web: HostWebApi
  readonly tts: TtsApi
  /** 独立安装的本地 Python 应用（Qwen3-TTS / Qwen-Image-Edit）：只有桌面能拉起来 */
  readonly pythonApps?: PythonAppsApi
}

/**
 * 语音合成接缝。两种落地方式，调用方按能力选择：
 * - 桌面：本地 ONNX（sherpa-onnx Kokoro / Piper）`synthesize` 合成 WAV 字节，渲染层用 <audio> 播放；
 * - 安卓：系统 TTS `speak` 直接朗读（无需模型、可离线），`synthesize` 不支持。
 * `status().available` 为 false 时调用方按「系统语音不可用」提示（不抛错）。
 */
export interface TtsApi {
  /** 能力状态：可用性 + 引擎信息（安卓为系统引擎包名与支持语言） */
  status(): Promise<{ available: boolean; engine?: string; version?: string; languages?: string[]; error?: string | null }>
  /** 加载本地模型（桌面 ONNX，返回采样率 / 音色数等信息；不支持的环境返回 available=false） */
  load(payload: { engine: string; modelDir: string; lang?: string }): Promise<{
    available?: boolean
    error?: string | null
    /** 采样率（Hz）与可用音色数，设置页据此展示 */
    sampleRate?: number
    numSpeakers?: number
    [key: string]: unknown
  }>
  /** 合成音频字节（WAV；桌面）。不支持的环境 reject，调用方退回 speak 或提示 */
  synthesize(payload: { engine: string; modelDir?: string; text: string; sid?: number; speed?: number; lang?: string }): Promise<Uint8Array>
  /**
   * 直接朗读文本，Promise 在**朗读结束**（或被 stop 打断）后 resolve；
   * 因此上层播放队列可以按句串行推进（安卓系统 TTS 走这条路）。
   */
  speak(payload: { text: string; lang?: string; rate?: number; pitch?: number; voice?: string; stopPrevious?: boolean }): Promise<{ success: boolean; error?: string }>
  /** 中断朗读（等待中的 speak 会以 success=false + stopped 结束） */
  stop(): Promise<{ success: boolean }>
  /** 可用音色（安卓系统 TTS；桌面返回空数组） */
  voices(): Promise<Array<{ name: string; locale?: string; quality?: number; latency?: number; network?: boolean }>>
  /** 释放引擎资源（桌面 ONNX；安卓为系统引擎，一般不调） */
  dispose(): Promise<{ success: boolean }>
}

/**
 * 独立安装的本地 Python 应用（桌面主进程负责拉起 / 停止）：
 * - `qwen3tts`：Qwen3-TTS-AllinOne（Gradio 7862 + 直连接口 9880）
 * - `qwenImage`：Qwen-Image-Edit-2511（Gradio 7861 + 内置 ComfyUI 8187）
 * 只有桌面提供；安卓 / 网页没有这个字段，调用方判断 `?.` 后再用。
 */
export interface PythonAppApi {
  /** 目录校验：找 app.py 与 py312\python.exe */
  check(dir: string): Promise<{ ok: boolean; python?: string; appPy?: string; error?: string }>
  /** 启动（已在本应用内运行 → alreadyRunning；已有外部服务在监听端口 → external） */
  start(dir: string): Promise<{ ok: boolean; pid?: number; alreadyRunning?: boolean; external?: boolean; error?: string }>
  /** 停止（只停本应用启动的进程） */
  stop(): Promise<{ ok: boolean; error?: string }>
  /** 运行状态 + 最近输出（设置页展示「启动中 / 失败原因」） */
  status(): Promise<{
    running: boolean
    pid?: number
    dir?: string
    startedAt?: number
    logTail?: string
    lastExit?: { code: number | null; at: number } | null
  }>
}

/** 可被桌面主进程管理的本地 Python 应用集合 */
export interface PythonAppsApi {
  qwen3tts?: PythonAppApi
  qwenImage?: PythonAppApi
}

/** 局域网共享主机侧控制（设置页「协作 → 共享 / 权限」） */
export interface LanShareApi {
  /** 当前访客策略 + 服务信息 */
  getGuest(): Promise<{ policy: any; info: any }>
  /** 下发访客策略（模式 / 预设白名单 / 工具 / 沙箱 / 并发 等） */
  setGuest(policy: any): Promise<{ success: boolean; policy?: any }>
  /** 设置共享知识库目录（网页端从该目录选择共享 .kb） */
  setKbDir(dir: string): Promise<{ success: boolean }>
  /** 设置用于共享库向量检索的嵌入配置 */
  setEmbed(cfg: any): Promise<{ success: boolean }>
  /** 服务信息（是否运行 / 端口 / 访问地址 / 令牌） */
  getServerInfo(): Promise<any>
  /** 启动局域网共享服务 */
  startServer(port?: number): Promise<{ success: boolean; port?: number; error?: string }>
  /** 停止局域网共享服务 */
  stopServer(): Promise<{ success: boolean; error?: string }>
}

/** 内置 MCP 服务的对外暴露端点 */
export interface McpExposeApi {
  info(): Promise<any>
  setEnabled(payload: { id: string; enabled: boolean }): Promise<any>
}

/** Python 执行（桌面为自带解释器的沙箱；返回结构与宿主执行器一致） */
export interface PythonApi {
  execute(params: { code: string; environment?: string; input?: string | null; cwd?: string }): Promise<any>
  checkInstallation(): Promise<any>
}

/** 文档转换 */
export interface DocConvertApi {
  /** .docx 字节（base64）→ Markdown（含图片落盘为 file:/// 引用） */
  docxToMarkdown(payload: { base64: string }): Promise<any>
  /**
   * 已渲染 HTML → PDF（宿主弹保存框并落盘）。
   * `landscape` 传 true 时按横向纸张打印（幻灯片导出用；不传 = 沿用宿主默认的竖版）。
   */
  exportPdf(payload: { html: string; title: string; landscape?: boolean }): Promise<{ success: boolean; path?: string; error?: string }>
  /**
   * 幻灯片整本导出：`head` + 每页片段 + `tail` 拼成「一页一份」的打印 HTML，宿主逐页打印后合并成一个 PDF。
   * （一页一份是为了绕开 Chromium 打印分页会把缩放页面盒再拆开的毛病；样式只随 head 走一份。）
   */
  printSlidesPdf(payload: { head: string; slides: string[]; tail: string; title: string }): Promise<{ success: boolean; path?: string; pages?: number; error?: string }>
}

/** 大表格分块读取协议（start → chunk* → done） */
export interface TableLoadApi {
  start(path: string): Promise<{ success: boolean; total?: number; error?: string }>
  chunk(path: string, offset: number, limit: number): Promise<{ success: boolean; rows?: any[]; error?: string }>
  done(path: string): Promise<{ success: boolean }>
}

/** 分块导出 Excel 协议（start → chunk* → done / abort） */
export interface ExcelExportApi {
  start(payload: { filename: string; header?: string[] }): Promise<{ success: boolean; path?: string; error?: string }>
  chunk(payload: { rows: Record<string, any>[]; header?: string[] }): Promise<{ success: boolean; count?: number; error?: string }>
  done(): Promise<{ success: boolean; path?: string; rows?: number; error?: string }>
  abort(): Promise<{ success: boolean }>
}

/** 技能库（宿主扫描技能目录并提供清单） */
export interface SkillsApi {
  /** 设置技能根目录并取回清单（参数沿用旧签名：字符串或字符串数组） */
  list(roots?: string | string[]): Promise<any[]>
}

/** 宿主侧联网辅助（浏览器受 CORS 限制，无法直接读任意网页） */
export interface HostWebApi {
  /** 抓取网页标题（失败/非 http(s) 返回空串） */
  fetchTitle(url: string): Promise<string>
}

/**
 * LLM 请求接缝。
 *
 * 两种形态：
 * - `llm.hosted` 为真（桌面）：请求交给宿主执行（可绕开 CORS/CSP、按 requestId 缓冲并落盘，
 *   渲染层切模块/刷新后仍可 resume）；
 * - 为假（纯网页 / 安卓）：调用方走 `shared/ai-core.ts` 直连兜底（本端口方法不会被调用）。
 */
export interface LlmPort {
  /** 启动会话：宿主按 spec 执行，事件经 onEvent 推送、结果经 done/error 结束 */
  start(requestId: string, spec: any): Promise<{ success: boolean; error?: string }>
  /** 中止会话 */
  abort(requestId: string): Promise<{ success: boolean }>
  /** 取回会话已缓冲的完整回答（切模块/刷新后 resume） */
  get(requestId: string): Promise<any | null>
  /** 释放会话缓冲（主进程不再保留该 requestId 的回答） */
  release(requestId: string): Promise<{ success: boolean }>
  /** 模型真实上下文窗口（tokens）；来源不支持时为 null */
  contextWindow(payload: { provider: string; config: any; model: string }): Promise<number | null>
  /** 上下文窗口明细（用于设置页展示来源与依据） */
  contextWindowDetail(payload: { provider: string; config: any; model: string }): Promise<any>
  /** LM Studio 模型列表（宿主探测，避免 CORS） */
  lmstudioModels(payload: { config: any }): Promise<any>
  /** LM Studio 命令行能力（仅桌面） */
  lmstudioCli(payload: any): Promise<any>
  /** Ollama 模型列表 */
  ollamaModels(payload: { config: any }): Promise<any>
  /** Ollama 模型操作（加载 / 卸载 / 拉取等） */
  ollamaModelAction(payload: any): Promise<any>
  /** 连接测试与余额查询等（按 provider 分发） */
  check(payload: any): Promise<any>
  /** 订阅会话事件（stream / reasoning / toolcalls / done / error …）；返回退订函数 */
  onEvent(cb: (payload: any) => void): () => void
}

/** 浏览器 Agent 的方法名（新增宿主机方法时在此登记） */
export type BrowserAgentMethod =
  | 'open' | 'open-file' | 'open-url' | 'set-theme' | 'devtools'
  | 'state' | 'add-tab' | 'switch-tab' | 'close-tab' | 'move-tab' | 'recycle-agent-tabs'
  | 'navigate' | 'action' | 'set-eval' | 'set-rail' | 'set-compact' | 'save-page' | 'save-markdown'
  | 'list-bookmarks' | 'save-bookmark' | 'update-bookmark' | 'remove-bookmark'
  | 'bookmark-mkdir' | 'bookmark-move' | 'bookmark-reorder' | 'bookmark-rename-folder'
  | 'remove-bookmark-folder' | 'clear-bookmark-folder' | 'import-bookmarks' | 'export-bookmarks'
  | 'favicon-batch' | 'cache-info' | 'clear-cache'
  /** 停靠到主页右侧栏（原生网页视图挂到主窗口，位置由渲染层上报的矩形决定） */
  | 'attach-dock' | 'set-dock-rect' | 'set-dock-visible' | 'detach-dock' | 'is-docked' | 'close'

/**
 * 浏览器 Agent（桌面专属子系统）。
 * 方法名沿用宿主机命名；无此能力的环境返回 reject，调用方既有 `.catch(() => …)` 会静默降级。
 */
export interface BrowserAgentPort {
  call(method: BrowserAgentMethod, payload?: any): Promise<any>
}

/** 终端宿主机方法名（新增时在此登记） */
export type TerminalMethod = 'create' | 'write' | 'resize' | 'kill'

/**
 * 终端（桌面专属：主进程 node-pty 真 PTY）。
 *
 * 渲染层只负责「终端界面」：输出经 `events.on('terminal:data')` 推送、退出经 `terminal:exit`，
 * 键盘输入 / 尺寸变化 / 关闭分别调用 write / resize / kill。
 * 无此能力的环境（安卓 / 纯网页 / 远端宿主）`call` 一律 reject，调用方按「终端不可用」提示。
 */
export interface TerminalPort {
  /**
   * create：起一个 shell 会话（id 由渲染层给，等于「终端」标签 id）。
   * 返回 `{ ok, id?, shell?, cwd?, error? }`；不看安全策略（命令由用户自己输入），
   * 只有环境不支持（无 PTY）或 node-pty 不可用时才失败。
   */
  call(
    method: TerminalMethod,
    payload?: {
      id?: string
      data?: string
      cols?: number
      rows?: number
      cwd?: string
    },
  ): Promise<any>
}

export interface PlatformCapabilities {
  readonly kind: RuntimeKind
  /** 能力形态：local / host / none */
  mode(id: CapabilityId): CapabilityMode
  /** 是否可用（mode !== 'none'） */
  has(id: CapabilityId): boolean
}

export interface Platform {
  readonly kind: RuntimeKind
  readonly capabilities: PlatformCapabilities
  readonly fs: FileSystemPort
  readonly watch: WatchPort
  readonly dialog: DialogPort
  readonly window: WindowPort
  readonly shell: ShellPort
  readonly app: AppPort
  readonly events: EventsPort
  readonly host: HostPort
  readonly llm: LlmPort
  readonly browserAgent: BrowserAgentPort
  readonly terminal: TerminalPort
}
