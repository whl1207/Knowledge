import { app, BrowserWindow, shell, ipcMain, dialog, globalShortcut, Menu, nativeImage, screen, net, session } from 'electron'
import { release, networkInterfaces } from 'node:os'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as fs from 'fs'
import * as path from 'path'
import * as http from 'http'
import { Worker } from 'worker_threads'
import yaml from 'js-yaml'
import mammoth from "mammoth"
import { docxToMarkdown } from './office/docx-to-markdown'
import { asUint8 } from './buffer-view'
import xlsx from 'xlsx'
import * as PDFJS from 'pdfjs-dist'
import { pythonService } from './python-service'
import { trustedPythonService } from './trusted-python-service'
import { shellService } from './shell-service'
import { resolvePolicy, isShellAllowed } from './sandbox-policy'
import { credentialStore } from './credentials'
import { mcpService } from './mcp-service'
import { mcpExposeServer, MCP_EXPOSE_PORT } from './mcp-expose'
import { browserAgentService } from './browser-agent'
import { postgresService } from './postgres/postgres-service'
import * as aiService from './ai-service'
import { lmStudioCli } from './lmstudio-cli'
import { sessionLog } from './session-log'
import { skillService, parseSkillMetadata } from './skill-service'
import { registerNamespacedIpc, sendToAll } from './ipc-registry'
import { registerCoreTools, setWebSearchConfig, getWebSearchConfig, runWebSearch } from './tools'
import { setAgentBroadcast } from './agent-loop'
import { registerTtsIpc, disposeTtsService } from './tts-service'
import { registerCollabIpc, stopCollab } from './collab-service'
import { registerRemoteFsIpc, stopRemoteFsAll } from './remote-fs-service'
import { initMapTiles, registerMapTilesIpc } from './map-tiles'
import { registerFileAssocIpc } from './file-assoc'
import { getGlobalZoom, setGlobalZoom, stepZoom, excludeFromAppZoom } from './window-zoom'
// 托盘（「托管区」）：关闭按钮行为（直接退出 / 折叠到托盘）+ 悬停显示后台任务数与进度
import { trayService } from './tray-service'
import { randomUUID } from 'crypto'
import { TextDecoder } from 'util'
import { createRequire } from 'node:module'

globalThis.__filename = fileURLToPath(import.meta.url)
globalThis.__dirname = dirname(__filename)

// The built directory structure
// 用类型确定的局部常量（string）替代 process.env.*（类型为 string | undefined）传给 join()
const distElectron = join(__dirname, '..')
const distDir = join(distElectron, '../dist')
const publicDir = process.env.VITE_DEV_SERVER_URL ? join(distElectron, '../public') : distDir
process.env.DIST_ELECTRON = distElectron
process.env.DIST = distDir
process.env.VITE_PUBLIC = publicDir

// Disable GPU Acceleration for Windows 7
if (release().startsWith('6.1')) app.disableHardwareAcceleration()

// Set application name for Windows 10+ notifications
if (process.platform === 'win32') app.setAppUserModelId(app.getName())

// ==================== 开发版与打包版并存 ====================
// Electron 的单实例锁是基于 userData 路径生成的（%APPDATA%/<app 名>）。
// 开发版使用独立的 userData 目录（<app 名>-dev），这样「npm run dev」
// 启动的实例与打包安装的实例可以同时运行，且各自的设置、缓存、
// 窗口状态（window-bounds.json）互不干扰。
const IS_DEV = !!process.env.VITE_DEV_SERVER_URL
if (IS_DEV) {
  app.setPath('userData', path.join(app.getPath('appData'), `${app.getName()}-dev`))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

const boundsFilePath = path.join(app.getPath('userData'), 'window-bounds.json');

let win: BrowserWindow | null = null
// preload 构建产物可能是 index.mjs（ESM）或 index.cjs（CJS）：
// vite-plugin-electron 在「开发模式」输出 .mjs，而打包构建（isBuild）通常输出 .cjs。
// 若固定引用 index.mjs，打包后 preload 加载失败 → window.ipcRenderer 不存在
// → 所有 IPC（加载工作区项目等）失效，导致项目视图（树状图/瀑布流/日历）全空。
// 这里按实际存在的产物选择路径。
const preloadMjs = join(__dirname, '../preload/index.mjs')
const preloadCjs = join(__dirname, '../preload/index.cjs')
const preload = fs.existsSync(preloadMjs) ? preloadMjs : preloadCjs
const url: string = process.env.VITE_DEV_SERVER_URL || ''
const indexHtml = join(distDir, 'index.html')

// ==================== 启动参数解析 ====================
// 支持 --browser[=<url>] 或 --browser <url>：直接启动「浏览器 Agent」窗口（不进入软件本体）。
// 例： AI-KM.exe --browser                 → 打开浏览器 Agent 窗口（空白新标签）
//      AI-KM.exe --browser=https://x.com   → 打开浏览器并进入该网址
//      AI-KM.exe --browser https://x.com   → 同上
const LAUNCH_ARG: { browser: boolean; url: string } = (() => {
  const argv = process.argv || []
  const idx = argv.findIndex(a => a === '--browser' || a.startsWith('--browser='))
  if (idx < 0) return { browser: false, url: '' }
  let browserUrl = ''
  const inline = argv[idx].match(/^--browser=(.*)$/)
  if (inline?.[1]) browserUrl = inline[1]
  else {
    const next = argv[idx + 1]
    if (next && /^https?:\/\//i.test(next)) browserUrl = next
  }
  return { browser: true, url: browserUrl }
})()

// ==================== 文件类型关联（双击文件 / 系统「打开方式」） ====================
// 系统把待打开的文件经由命令行参数交给主进程（Windows/Linux），macOS 走 open-file 事件。
// 例：AI-KM.exe "D:\docs\笔记.md"（打包版）；开发版用 --open-file=<路径> 显式指定。

/** 交给系统默认应用打开的类型（压缩包 / 可执行 / 镜像等本软件不适合预览的文件） */
const SYSTEM_OPEN_EXTS = [
  '.exe', '.msi', '.dll', '.apk', '.dmg', '.deb', '.rpm', '.iso', '.appimage', '.run', '.bin', '.flatpak', '.snap',
  '.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.zst',
]

/** 单次最多打开的文件数（多选一批打开时，避免瞬间创建过多窗口） */
const MAX_OPEN_FILES = 10

/** 是否为磁盘上真实存在的文件（用于排除开关参数 / 目录 / 不存在的路径） */
function isRealFile(p: string): boolean {
  try { return fs.statSync(p).isFile() } catch { return false }
}

/**
 * 从命令行参数中解析「待打开文件」：
 *  - 打包版：文件关联/双击打开会把裸路径作为参数传入（AI-KM.exe "a\b.md"）
 *  - 开发版（npm run dev）的 argv 会带项目目录等，故只认显式 --open-file=<路径>，避免误开
 *  - 跳过 argv[0]（可执行文件路径 / dev 下的 '.'）与所有 - 开头的开关（如 --browser）
 */
function parseOpenFileArgs(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--open-file') {
      const next = argv[i + 1]
      if (next && isRealFile(next)) out.push(path.resolve(next))
      i++
    } else if (a.startsWith('--open-file=')) {
      const v = a.slice('--open-file='.length)
      if (v && isRealFile(v)) out.push(path.resolve(v))
    }
  }
  if (app.isPackaged) {
    for (const a of argv.slice(1)) {
      if (!a || a.startsWith('-')) continue
      if (isRealFile(a)) out.push(path.resolve(a))
    }
  }
  return Array.from(new Set(out))
}

// 启动参数携带的待打开文件（应用 ready 后再打开窗口）
const PENDING_FILE_OPENS: string[] = parseOpenFileArgs(process.argv)

// ==================== 窗口创建 ====================

async function createWindow() {
  win = new BrowserWindow({
    title: 'AI-KM',
    width: 900,
    height: 600,
    minWidth: 600,
    minHeight: 350,
    icon: join(publicDir, 'favicon.ico'),
    // 消除闪白：初始不显示，首帧渲染完成（ready-to-show）后再显示；后备背景用当前主题色
    show: false,
    backgroundColor: themeBackgroundColor,
    // 去掉系统标题栏：titleBarStyle 仅 macOS 生效，Linux 上必须用 frame:false 才能真正无边框。
    // 渲染层通过 -webkit-app-region: drag 的顶栏（panel-header）实现窗口拖动。
    ...(process.platform === 'linux' ? { frame: false } : { titleBarStyle: 'hidden' }),
    webPreferences: {
      preload,
      webSecurity: false,
      // 折叠到托管区后窗口不可见：Chromium 默认会节流后台窗口的定时器，
      // 会让渲染层驱动的后台任务（智能体循环 / 采集 / 工作流）变慢，也让托盘任务进度停止更新
      backgroundThrottling: false
    },
  })
  
  if (process.platform === 'linux') {
    win.setMenuBarVisibility(false)
    Menu.setApplicationMenu(null)
  }
  
  if (fs.existsSync(boundsFilePath)) {
    const bounds = JSON.parse(fs.readFileSync(boundsFilePath, { encoding: 'utf8' }));
    win.setBounds(bounds);
  }
  
  // 窗口缩放：所有窗口（含本窗口）统一由 window-zoom.ts 的 browser-window-created 钩子套用全局比例

  // 窗口缩放快捷键：Ctrl + = / + 放大，Ctrl + - 缩小（改写全局比例并同步到所有窗口）
  globalShortcut.register('CommandOrControl+=', () => { stepZoom(0.1) })
  globalShortcut.register('CommandOrControl+-', () => { stepZoom(-0.1) })
  
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(url)
    win.webContents.openDevTools({ mode: 'undocked' })
  } else {
    win.loadFile(indexHtml)
  }

  // 首帧渲染完成后显示窗口，避免加载期白屏；did-finish-load 兜底防止极端情况窗口不出现
  const mainWin = win
  mainWin.once('ready-to-show', () => {
    if (!mainWin.isDestroyed()) mainWin.show()
  })

  win.webContents.on('did-finish-load', () => {
    if (!mainWin.isDestroyed() && !mainWin.isVisible()) mainWin.show()
    win?.webContents.send('main-process-message', new Date().toLocaleString())
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })
  
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    shell.openExternal(url);
  })

  // 关闭按钮行为 = 折叠到托管区：拦截本次关闭，只隐藏窗口（后台任务继续运行）
  // 直接退出模式 / 正在退出应用时 shouldHideOnClose() 返回 false，走正常关闭
  win.on('close', (event) => {
    if (trayService.shouldHideOnClose()) {
      event.preventDefault()
      trayService.hideMainWindow(mainWin)
    }
  })

  // 设置里已开启「折叠到托管区」时，主窗口一创建就准备好托盘图标
  trayService.ensureTray()

  // 主窗口关闭时一并关闭「设置」独立窗口（否则应用会因仍有窗口存活而不退出）
  win.on('closed', () => {
    // 渲染层就绪标记复位：下次重新创建主窗口后需重新握手
    mainWindowUiReady = false
    // 主窗口已真正关闭（直接退出模式，或托盘模式下正在退出）→ 托盘失去意义
    trayService.destroyTray()
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close()
  })
}

// ==================== 应用生命周期 ====================

app.whenReady().then(async () => {
  // 上次「清理缓存」有被进程占用的目录未删掉：启动时窗口尚未创建、无进程占用，此刻补清；
  // 全部清掉才移除标记，仍有残留则保留给下次启动（避免删一半）。
  try {
    if (fs.existsSync(cacheCleanPendingPath())) {
      const r = await cleanUserDataCache(false)
      if (!r.failed.length) fs.rmSync(cacheCleanPendingPath(), { force: true })
      console.log(`[clean-userdata-cache] 启动补清缓存: 释放 ${r.freed} 字节, 遗留 ${r.failed.length} 个目录`)
    }
  } catch (e) {
    console.warn('[clean-userdata-cache] 启动补清失败:', e)
  }
  await pythonService.initialize()
  // 凭据接缝（路线图 2.3）：加载主进程受保护的 credentials.json
  credentialStore.load()
  // PostgreSQL MCP：注入作者消歧持久缓存文件（跨会话复用，避免重复扫大表）
  postgresService.setResolveCacheFile(path.join(app.getPath('userData'), 'pg-author-cache.json'))
  // 统一工具注册表：注册核心工具（read_file / write_file / run_python / kb_search / skill …）
  registerCoreTools()
  // 命名空间 IPC 通道（agent:* / sessionLog:* / skill:* / tools:*）
  registerNamespacedIpc()
  // 本地 ONNX TTS（Kokoro / Piper）主进程服务
  registerTtsIpc()
  // 局域网协同文件编辑（WebSocket 服务器 + 房间管理）
  registerCollabIpc()
  // 局域网远程文件共享（HTTP 只读：目录列表 / 预览 / 下载）
  registerRemoteFsIpc()
  // MBTiles 离线地图包服务：内置包扫描 + 用户包挂载注册表 + 瓦片读取
  registerMapTilesIpc()
  // 文件关联（默认打开方式）读写：设置 → 其他 → 文件关联
  registerFileAssocIpc()
  // 托盘（托管区）：读取「关闭按钮行为」配置 + 注册 app-behavior / tray:* IPC
  // （托盘图标本身随主窗口创建，见 createWindow；以 --browser 启动无主窗口时不建托盘）
  trayService.init({
    iconPath: join(publicDir, 'icon.png'),
    getMainWindow: () => win,
    // 右键菜单「设置…」：打开 / 聚焦设置独立窗口并定位到「基础」
    openSettings: (nav) => openSettingsWindowFromTray(nav || 'view'),
  })
  await initMapTiles(join(publicDir, 'maps'))
  if (LAUNCH_ARG.browser) {
    // 启动参数 --browser：直接打开「浏览器 Agent」窗口，不创建软件本体主窗口
    browserAgentService.ensureWindow(LAUNCH_ARG.url)
  } else {
    const startupFiles = PENDING_FILE_OPENS.splice(0)
    // 文件关联 / 双击打开：只有「需要主窗口承载的类型」才创建主窗口。
    // 目前只有 .kb 知识库需要（要跳到主窗口的「知识处理」模块）；md / 图片 / 代码等
    // 仅在文件独立窗口（FileWindow）中打开，避免每次双击文件都多弹一个主窗口。
    const needsMainWindow = startupFiles.length === 0
      || startupFiles.some(f => extname(f).toLowerCase() === '.kb')
    if (needsMainWindow) createWindow()
    if (startupFiles.length) openFilesWithApp(startupFiles)
  }
  // MCP 服务状态广播：推送给渲染进程（设置页 / 工作流监听 mcp-status-changed）
  mcpService.setBroadcast((payload) => {
    win?.webContents.send('mcp-status-changed', payload)
  })
  // 把内置 MCP 服务（Office Word / 浏览器 Agent）暴露为 Streamable HTTP（供其他软件连接，需本应用保持运行）
  const mcpExposePort = Number(process.env.MCP_EXPOSE_PORT) || MCP_EXPOSE_PORT
  mcpExposeServer.start(mcpExposePort).catch((err) => console.error('[mcp-expose] start error', err))
  // 页面发起的下载（drawio 内嵌编辑器的导出兜底）：默认会静默进系统下载目录，这里改为落到图表目录并提示
  setupDownloadFallback()
  // AI 会话事件广播：流式 chunk / 完成 / 错误推送给所有窗口（ai-utils 按 requestId 过滤）
  aiService.setBroadcast((payload) => {
    BrowserWindow.getAllWindows().forEach((w) => {
      if (!w.isDestroyed()) w.webContents.send('ai:event', payload)
    })
  })
  // Agent 循环事件广播：turn/step/tool/状态变化推送给所有窗口
  setAgentBroadcast((ev) => {
    sendToAll('agent:event', ev)
  })
  // 技能目录变更广播：skill-service 的 watcher 发现 added/removed/changed 后
  // 推送 skill:change，渲染进程增量刷新技能列表
  skillService.onChange((kind, names) => {
    BrowserWindow.getAllWindows().forEach((w) => {
      if (!w.isDestroyed()) w.webContents.send('skill:change', { kind, names })
    })
  })
})

app.on('window-all-closed', () => {
  win = null
  if (process.platform !== 'darwin') app.quit()
})

// 应用开始退出：此后不再把「关闭主窗口」拦截为折叠到托管区
app.on('before-quit', () => {
  trayService.markQuitting()
})

app.on('second-instance', (_event, commandLine) => {
  const args = (Array.isArray(commandLine) && commandLine.length ? commandLine : process.argv) || []
  const wantsBrowser = args.some(a => a === '--browser' || a.startsWith('--browser='))
  if (wantsBrowser) {
    // 再次以 --browser 启动（应用已在运行）：打开/聚焦浏览器 Agent 窗口
    browserAgentService.ensureWindow()
    return
  }
  // 携带文件参数（双击文件 / 系统「打开方式」再次启动）→ 打开对应文件独立窗口
  const files = parseOpenFileArgs(args)
  if (files.length) {
    openFilesWithApp(files)
    return
  }
  if (win) {
    if (win.isMinimized()) win.restore()
    // 折叠到托管区时窗口只是隐藏，visible=false 需要 show() 才能唤回
    if (!win.isVisible()) win.show()
    win.focus()
    return
  }
  // 仅浏览器模式运行中、再次普通启动 → 进入软件本体
  createWindow()
})

// macOS：Finder 双击 / 「打开方式」通过 open-file 事件下发文件路径（可能早于 app ready，先入队）
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  if (!filePath) return
  if (!app.isReady()) {
    PENDING_FILE_OPENS.push(filePath)
    return
  }
  openFilesWithApp([filePath])
})

app.on('activate', () => {
  const allWindows = BrowserWindow.getAllWindows()
  if (allWindows.length) {
    const first = allWindows[0]
    if (first.isMinimized()) first.restore()
    if (!first.isVisible()) first.show()
    first.focus()
  } else if (LAUNCH_ARG.browser) {
    // 以 --browser 启动、窗口全关后重新激活（macOS dock 点击）→ 回到浏览器 Agent
    browserAgentService.ensureWindow(LAUNCH_ARG.url)
  } else {
    createWindow()
  }
})

app.on('will-quit', () => {
  trayService.destroyTray()
  browserAgentService.dispose()
  postgresService.closeAll().catch((err) => console.error('[pg-mcp] close error', err))
  mcpService.shutdown().catch((err) => console.error('[mcp] shutdown error', err))
  mcpExposeServer.close().catch((err) => console.error('[mcp-expose] close error', err))
  disposeTtsService()
  stopCollab().catch(() => {})
  stopRemoteFsAll()
})

// ==================== IPC 处理器 ====================

ipcMain.handle('open-win', (_, arg) => {
  const childWindow = new BrowserWindow({
    webPreferences: {
      preload,
      nodeIntegration: true,
      contextIsolation: false,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    childWindow.loadURL(`${url}#${arg}`)
  } else {
    childWindow.loadFile(indexHtml, { hash: arg })
  }
})

// 新窗口首帧后备背景色：由渲染进程主题变化时上报缓存，避免加载期纯白
let themeBackgroundColor = '#f6f8fa'
ipcMain.on('theme-background-changed', (_e, color: string) => {
  if (typeof color === 'string' && /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(color)) {
    themeBackgroundColor = color
  }
})

// ==================== 文件独立窗口（FileWindow.vue） ====================
// 三类调用方共用：渲染进程 IPC、文件类型关联（双击打开 / 系统「打开方式」）、second-instance 转发。
// 同一文件 + 同一视图只保留一个窗口（重复打开时聚焦已有窗口，而不是无限新建）。
// pathKey → (viewKey → 窗口)；viewKey 为 'default' 表示「未指定视图」，由渲染层按扩展名推断。
const fileWindowsByPath = new Map<string, Map<string, BrowserWindow>>()

/** 窗口映射 key：绝对路径（Windows 大小写不敏感） */
function fileWindowKey(p: string): string {
  const abs = path.resolve(p)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

/** 视图 key：空/未知视图归入 default（渲染层按文件类型自行推断默认视图） */
function fileWindowViewKey(view?: string): string {
  return (view || '').trim() || 'default'
}

/** 关闭时从映射中移除（仅当映射仍指向该窗口，避免误删同路径新开的窗口） */
function unregisterFileWindow(pathKey: string, viewKey: string, target: BrowserWindow) {
  const byView = fileWindowsByPath.get(pathKey)
  if (!byView) return
  if (byView.get(viewKey) === target) {
    byView.delete(viewKey)
    if (!byView.size) fileWindowsByPath.delete(pathKey)
  }
}

/**
 * 创建 / 聚焦「文件独立窗口」（FileWindow.vue）。
 * @param view read（浏览）/ edit（源码编辑）/ blockedit（可视编辑）/ mindmap（思维导图）/ presentation（演示）；
 *             省略或未知值时由渲染层按文件扩展名推断（代码类 → 源码编辑，其余 → 浏览）
 *             （中文名与 src/lib/knowFile/fileViews.ts 保持一致，改那里时这里一起改）
 */
function openFileWindow(opts: {
  path: string
  view?: string
  remoteRootId?: string
  remoteRel?: string
  label?: string
}): BrowserWindow | null {
  const filePath = opts.path
  if (!filePath) return null
  const view = (opts.view || '').trim()
  const pathKey = fileWindowKey(filePath)
  const viewKey = fileWindowViewKey(view)
  const byView = fileWindowsByPath.get(pathKey)

  // 同一文件已经打开过：
  //  - 指定视图 → 命中「同视图」窗口；不同视图属不同需求，另开一个
  //  - 未指定视图（文件关联双击）→ 聚焦该文件任意已有窗口，避免重复开窗
  if (byView) {
    let exist = byView.get(viewKey)
    if (!exist && !view) exist = Array.from(byView.values())[0]
    if (exist && !exist.isDestroyed()) {
      if (exist.isMinimized()) exist.restore()
      exist.focus()
      return exist
    }
    if (exist) unregisterFileWindow(pathKey, viewKey, exist)
  }

  const fileName = opts.label
    || filePath.replace(/\\/g, '/').split('/').pop()
    || '文件'
  // 视图 → 窗口标题映射（read/edit/blockedit/mindmap/presentation）；
  // view 缺省时标题先只写文件名，渲染层挂载后会按实际视图重设 document.title
  const viewLabelMap: Record<string, string> = {
    read: '浏览',
    edit: '源码编辑',
    blockedit: '可视编辑',
    mindmap: '思维导图',
    presentation: '演示',
  }
  const viewLabel = viewLabelMap[view] || ''
  const childWindow = new BrowserWindow({
    title: viewLabel ? `${fileName} - ${viewLabel}` : fileName,
    width: 1000,
    height: 700,
    minWidth: 400,
    minHeight: 300,
    icon: join(publicDir, 'favicon.ico'),
    // 与主窗口一致：Linux 完全无边框（frame:false），配合 FileWindow 顶栏 drag 区拖动
    ...(process.platform === 'linux' ? { frame: false } : { titleBarStyle: 'hidden' }),
    // 消除闪白：初始不显示，首帧渲染完成（ready-to-show）后再显示；后备背景用当前主题色
    show: false,
    backgroundColor: themeBackgroundColor,
    webPreferences: {
      preload,
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false
    },
  })
  // 登记到映射表（同一路径的多个视图各自一个窗口），窗口关闭时清理
  if (byView) byView.set(viewKey, childWindow)
  else fileWindowsByPath.set(pathKey, new Map([[viewKey, childWindow]]))
  childWindow.on('closed', () => {
    unregisterFileWindow(pathKey, viewKey, childWindow)
  })

  // 首帧渲染完成后显示窗口，避免加载期白屏；did-finish-load 兜底防止极端情况窗口不出现
  childWindow.once('ready-to-show', () => {
    if (!childWindow.isDestroyed()) childWindow.show()
  })
  childWindow.webContents.on('did-finish-load', () => {
    if (!childWindow.isDestroyed() && !childWindow.isVisible()) childWindow.show()
  })

  // 未保存提示：渲染进程 beforeunload 阻止关闭时，通知其弹出保存提示（默认保持窗口打开）
  childWindow.webContents.on('will-prevent-unload', () => {
    if (!childWindow.isDestroyed()) {
      childWindow.webContents.send('file-window-close-request')
    }
  })

  // 远程只读文件：额外透传 remoteRootId/remoteRel/label，供 FileWindow 在独立渲染进程内直接走 HTTP 拉取。
  // view 缺省时不带该参数，由 FileWindow 按扩展名推断默认视图。
  let hash = `/file-view?path=${encodeURIComponent(filePath)}`
  if (view) hash = `/file-view?view=${encodeURIComponent(view)}&path=${encodeURIComponent(filePath)}`
  if (opts.remoteRootId) hash += `&rid=${encodeURIComponent(opts.remoteRootId)}`
  if (opts.remoteRel) hash += `&rel=${encodeURIComponent(opts.remoteRel)}`
  if (opts.label) hash += `&label=${encodeURIComponent(opts.label)}`
  if (process.env.VITE_DEV_SERVER_URL) {
    childWindow.loadURL(`${url}#${hash}`)
  } else {
    childWindow.loadFile(indexHtml, { hash })
  }
  return childWindow
}

ipcMain.handle('open-file-window', async (_, opts: {
  path: string
  view?: string
  remoteRootId?: string
  remoteRel?: string
  label?: string
}) => {
  openFileWindow(opts)
})

// ==================== 文件关联 / 命令行打开文件 ====================

/** 主窗口渲染层是否已挂载完成（就绪前到达的「主窗口内打开」请求先排队，避免消息丢失） */
let mainWindowUiReady = false
const pendingMainWindowOpens: string[] = []

function flushPendingMainWindowOpens() {
  if (!mainWindowUiReady || !win || win.isDestroyed()) return
  while (pendingMainWindowOpens.length) {
    win.webContents.send('open-file-request', { path: pendingMainWindowOpens.shift()! })
  }
}

/** 请求「用主窗口打开文件」（.kb 知识库等需跳转主界面模块的类型） */
function requestOpenInMainWindow(filePath: string) {
  // 主窗口不存在（例如此前只打开了文件独立窗口）→ 先补建主窗口，渲染层就绪后再投递
  if (!win || win.isDestroyed()) {
    pendingMainWindowOpens.push(filePath)
    createWindow()
    return
  }
  if (mainWindowUiReady) {
    win.webContents.send('open-file-request', { path: filePath })
    return
  }
  pendingMainWindowOpens.push(filePath)
}

/**
 * 有专属「浏览」视图、默认应以浏览打开的类型
 * （与 src/store/index.ts 里 openFileByMode 的 READ_EXTS 保持一致，两边修改需同步）
 */
const READ_VIEW_EXTS = [
  '.md', '.markdown', '.mdown', '.mkd', '.mdx',
  '.html', '.htm',
  '.docx', '.doc',
  '.pdf', '.xlsx', '.xls', '.csv', '.excalidraw',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp', '.ico', '.tiff', '.tif',
  '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv', '.m4v', '.3gp', '.mpg', '.mpeg',
  '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.opus', '.wma', '.ape', '.aiff',
]

/** 文件关联打开时的默认视图：有专属浏览视图的类型 → 浏览(read)，其余（代码/文本/未知）→ 源码编辑(edit) */
function pickDefaultView(filePath: string): string {
  return READ_VIEW_EXTS.includes(extname(filePath).toLowerCase()) ? 'read' : 'edit'
}

/**
 * 打开一批文件（文件类型关联双击 / 系统「打开方式」/ 命令行参数）：
 *  - .kb 知识库：交主窗口渲染层（跳转「知识处理」）
 *  - 系统打开类（压缩包 / 可执行 / 镜像等）：交给系统默认应用
 *  - 其余：文件独立窗口（FileWindow.vue）
 */
function openFilesWithApp(files: string[]) {
  const list = (files || []).filter(isRealFile).slice(0, MAX_OPEN_FILES)
  if (!list.length) return
  console.log('[open-file] 待打开文件:', list.join(' | '))
  // 主窗口已存在时前置（启动过程中主窗口尚未 ready-to-show，由它自己显示，这里不抢显示）
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    if (win.isVisible()) win.focus()
  }
  for (const f of list) {
    const ext = extname(f).toLowerCase()
    if (ext === '.kb') { requestOpenInMainWindow(f); continue }
    if (SYSTEM_OPEN_EXTS.includes(ext)) { shell.openPath(f).catch(() => {}); continue }
    openFileWindow({ path: f, view: pickDefaultView(f) })
  }
}

// 主窗口渲染层挂载完成握手：文件关联打开 .kb 等请求据此在就绪后投递
ipcMain.handle('main-window-ui-ready', () => {
  mainWindowUiReady = true
  flushPendingMainWindowOpens()
  return true
})

// ==================== 设置独立窗口 ====================
// 「设置」由主窗口内浮层改为独立子窗口：与主窗口一致的无系统标题栏方案
// （macOS 用 titleBarStyle:hidden，Linux 必须 frame:false），
// 顶部标题栏（Set.vue 的 .settings-header）作为 -webkit-app-region: drag 拖动区。
// 作用域：桌面版；浏览器/LAN 模式（无 ipcRenderer）仍在主窗口内显示浮层。
let settingsWin: BrowserWindow | null = null

/** 把设置窗口开合状态告诉主窗口（导航按钮高亮等 UI 用） */
function notifySettingsWindowState() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('settings-window-state', { open: !!settingsWin && !settingsWin.isDestroyed() })
  }
}

/** 创建/显示设置独立窗口；nav 为要定位的设置分类（如 agentpreset） */
/**
 * 把 target 窗口相对「锚点窗口」水平/垂直居中（锚点不存在时按其所在屏幕工作区居中）。
 * 注意：要在尺寸确定后调用（新建后立即调一次 + ready-to-show 再调一次），否则 DPI 缩放会让位置略有偏差。
 */
function centerOverWindow(target: BrowserWindow, anchor?: BrowserWindow | null): void {
  if (!target || target.isDestroyed()) return
  try {
    const b = target.getBounds()
    const a = anchor && !anchor.isDestroyed() ? anchor.getBounds() : null
    if (a) {
      target.setPosition(
        Math.round(a.x + (a.width - b.width) / 2),
        Math.round(a.y + (a.height - b.height) / 2),
      )
      return
    }
    const wa = screen.getDisplayMatching(b).workArea
    target.setPosition(
      Math.round(wa.x + (wa.width - b.width) / 2),
      Math.round(wa.y + (wa.height - b.height) / 2),
    )
  } catch { /* 定位失败不影响功能 */ }
}

function createSettingsWindow(nav = '', anchor?: BrowserWindow | null): BrowserWindow {
  if (settingsWin && !settingsWin.isDestroyed()) return settingsWin
  // 默认尺寸：约为主窗口的 80%（此前 92% 偏大），上限 1280×900，
  // 并受屏幕工作区限制，同时保证不比主窗口更大
  const mainBounds = win && !win.isDestroyed() ? win.getBounds() : null
  const mainW = mainBounds?.width || 900
  const mainH = mainBounds?.height || 600
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)
  // 屏幕工作区（排除任务栏）：窗口不能超出可视范围
  const workArea = screen.getPrimaryDisplay().workAreaSize
  const winW = Math.min(
    clamp(Math.round(mainW * 0.8), 800, 1280),
    Math.max(700, mainW - 24),
    Math.max(700, workArea.width - 60),
  )
  const winH = Math.min(
    clamp(Math.round(mainH * 0.8), 560, 900),
    Math.max(480, mainH - 24),
    Math.max(480, workArea.height - 60),
  )
  const w = new BrowserWindow({
    title: '设置',
    width: winW,
    height: winH,
    minWidth: 680,
    minHeight: 480,
    icon: join(publicDir, 'favicon.ico'),
    // 无系统标题栏/菜单（与主窗口一致的无边框方案；拖动由渲染层顶栏 drag 区提供）
    ...(process.platform === 'linux' ? { frame: false } : { titleBarStyle: 'hidden' }),
    // 无系统菜单：Windows/Linux 隐藏菜单栏（macOS 应用菜单属系统级，不随窗口）
    autoHideMenuBar: true,
    // 消除闪白：初始不显示，首帧渲染完成（ready-to-show）后再显示；后备背景用当前主题色
    show: false,
    backgroundColor: themeBackgroundColor,
    webPreferences: {
      preload,
      webSecurity: false,
    },
  })
  settingsWin = w
  if (process.platform !== 'darwin') w.setMenuBarVisibility(false)
  // 相对主窗口居中（主窗口不可用时退到请求方窗口 / 屏幕）：
  // 新建即调一次，ready-to-show（尺寸已定）再调一次，避免 DPI 舍入造成偏心
  const anchorWin = anchor && !anchor.isDestroyed() ? anchor : (win && !win.isDestroyed() ? win : null)
  centerOverWindow(w, anchorWin)
  w.once('ready-to-show', () => {
    centerOverWindow(w, anchorWin)
    if (!w.isDestroyed()) w.show()
  })
  w.webContents.on('did-finish-load', () => {
    if (!w.isDestroyed() && !w.isVisible()) w.show()
  })
  w.on('closed', () => {
    settingsWin = null
    notifySettingsWindowState()
  })
  // 首次定位通过 hash 传入（渲染进程 setup 阶段即可读取，无 IPC 时序问题）
  const hash = nav ? `/settings-window?nav=${encodeURIComponent(nav)}` : '/settings-window'
  if (process.env.VITE_DEV_SERVER_URL) {
    w.loadURL(`${url}#${hash}`)
  } else {
    w.loadFile(indexHtml, { hash })
  }
  notifySettingsWindowState()
  return w
}

// 查询设置独立窗口是否已打开（主窗口渲染进程重载后恢复导航按钮高亮）
ipcMain.handle('get-settings-window-state', () => ({
  open: !!settingsWin && !settingsWin.isDestroyed(),
}))

/**
 * 托盘右键菜单「设置…」入口：与渲染层 store.openSettings 一致，走设置独立窗口。
 * 窗口已打开 → 聚焦并切换分类（页面尚未加载完则等 did-finish-load 再发，避免消息丢失）。
 */
function openSettingsWindowFromTray(nav = 'view'): void {
  const anchor = win && !win.isDestroyed() ? win : null
  if (settingsWin && !settingsWin.isDestroyed()) {
    const w = settingsWin
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
    if (nav) {
      if (w.webContents.isLoading()) {
        w.webContents.once('did-finish-load', () => {
          if (!w.isDestroyed()) w.webContents.send('settings:navigate', nav)
        })
      } else {
        w.webContents.send('settings:navigate', nav)
      }
    }
    return
  }
  createSettingsWindow(nav, anchor)
}

ipcMain.handle('open-settings-window', (event, payload?: { nav?: string }) => {
  try {
    const nav = typeof payload?.nav === 'string' ? payload.nav : ''
    if (settingsWin && !settingsWin.isDestroyed()) {
      const w = settingsWin
      if (w.isMinimized()) w.restore()
      w.show()
      w.focus()
      // 窗口已存在：切换分类走 IPC 推送（页面仍在加载时等加载完成再发，避免消息丢失）
      if (nav) {
        if (w.webContents.isLoading()) {
          w.webContents.once('did-finish-load', () => {
            if (!w.isDestroyed()) w.webContents.send('settings:navigate', nav)
          })
        } else {
          w.webContents.send('settings:navigate', nav)
        }
      }
      return { ok: true, focused: true }
    }
    createSettingsWindow(nav, BrowserWindow.fromWebContents(event.sender))
    return { ok: true, created: true }
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) }
  }
})

// ==================== 浏览器 Agent（M0/M1：独立窗口 + 内嵌 WebContentsView + 进程内 MCP server） ====================
// 入口按钮 / MCP 工具首次导航都会惰性创建窗口；壳 UI 通过这些通道控制地址栏 / 前进后退 / 刷新 / 停止
ipcMain.handle('browser-agent:open', async (_e, payload: { url?: string } = {}) => {
  try {
    const w = browserAgentService.ensureWindow(payload?.url || '')
    return { ok: true, visible: !w.isDestroyed() }
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) }
  }
})
ipcMain.handle('browser-agent:navigate', async (_e, payload: { url?: string } = {}) => {
  try {
    await browserAgentService.navigate(payload?.url || '')
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) }
  }
})
ipcMain.handle('browser-agent:action', async (_e, payload: { action?: string } = {}) => {
  try {
    switch (payload?.action) {
      case 'back': browserAgentService.goBack(); break
      case 'forward': browserAgentService.goForward(); break
      case 'reload': browserAgentService.reload(); break
      case 'stop': browserAgentService.stop(); break
      default: return { ok: false, error: '未知 action' }
    }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) }
  }
})
ipcMain.handle('browser-agent:state', async () => {
  return { ok: true, data: browserAgentService.stateSnapshot }
})
ipcMain.handle('browser-agent:set-eval', async (_e, payload: { enabled?: boolean } = {}) => {
  browserAgentService.setAllowEval(!!payload?.enabled)
  return { ok: true }
})
// 壳右侧「设置」停靠栏展开/收起：让网页视图让出右侧宽度（DOM 侧栏与原生网页并排，互不遮挡）
ipcMain.handle('browser-agent:set-rail', async (_e, payload: { open?: boolean; width?: number } = {}) => {
  browserAgentService.setSideRail(!!payload?.open, payload?.width)
  return { ok: true }
})
// 紧凑模式：窗口过小时壳隐藏地址/工具条（仅保留标签栏），网页区同步上移
ipcMain.handle('browser-agent:set-compact', async (_e, payload: { compact?: boolean } = {}) => {
  browserAgentService.setCompact(!!payload?.compact)
  return { ok: true }
})
ipcMain.handle('browser-agent:close', async () => {
  browserAgentService.close()
  return { ok: true }
})
// 多标签页管理
ipcMain.handle('browser-agent:add-tab', async (_e, payload: { url?: string } = {}) => {
  try {
    await browserAgentService.addTab(payload?.url || undefined)
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) }
  }
})
ipcMain.handle('browser-agent:switch-tab', async (_e, payload: { id?: string } = {}) => {
  browserAgentService.switchTab(String(payload?.id || ''))
  return { ok: true }
})
ipcMain.handle('browser-agent:close-tab', async (_e, payload: { id?: string } = {}) => {
  browserAgentService.closeTab(String(payload?.id || ''))
  return { ok: true }
})
// 拖拽调整标签顺序
ipcMain.handle('browser-agent:move-tab', async (_e, payload: { id?: string; toIndex?: number } = {}) => {
  browserAgentService.moveTab(String(payload?.id || ''), Number(payload?.toIndex))
  return { ok: true }
})
// 手动回收 AI 会话产生的标签页（窗口内建能力；保留用户正在查看的标签；仅作手动入口，空闲时也会自动回收）
ipcMain.handle('browser-agent:recycle-agent-tabs', async () => {
  try {
    const closed = browserAgentService.recycleAgentTabs()
    return { ok: true, closed }
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) }
  }
})
ipcMain.handle('browser-agent:open-file', async (_e, payload: { path?: string } = {}) => {
  try {
    if (!payload?.path) return { ok: false, error: '缺少 path' }
    await browserAgentService.openFile(payload.path)
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) }
  }
})
// 内置浏览器打开外部 URL（设置页文档链接等；已有窗口时新标签打开，无窗口时首标签直达）
ipcMain.handle('browser-agent:open-url', async (_e, payload: { url?: string } = {}) => {
  try {
    if (!payload?.url) return { ok: false, error: '缺少 url' }
    await browserAgentService.openUrl(payload.url)
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) }
  }
})
ipcMain.handle('browser-agent:set-theme', async (_e, payload: { ui?: any } = {}) => {
  browserAgentService.setTheme(payload?.ui)
  return { ok: true }
})
ipcMain.handle('browser-agent:save-page', async (_e, payload: { mode?: string; root?: string } = {}) => {
  const mode = payload?.mode === 'full' ? 'full' : 'link'
  return browserAgentService.saveActivePage(mode, payload?.root || undefined)
})
ipcMain.handle('browser-agent:devtools', async () => {
  browserAgentService.openDevTools()
  return { ok: true }
})
// 浏览器缓存：查询大小 / 清理
ipcMain.handle('browser-agent:cache-info', async () => browserAgentService.cacheInfo())
ipcMain.handle('browser-agent:clear-cache', async () => browserAgentService.clearCache())
// 收藏夹/新标签页 favicon（批量取，主进程缓存到磁盘，避免每次联网加载）
ipcMain.handle('browser-agent:favicon-batch', async (_e, payload: { hosts?: string[] } = {}) =>
  browserAgentService.faviconBatch(Array.isArray(payload?.hosts) ? payload.hosts : []))
// 文件化书签（工作区 书签/ 目录）
ipcMain.handle('browser-agent:save-bookmark', async (_e, payload: { root?: string; url?: string; title?: string } = {}) => {
  return browserAgentService.saveBookmark(String(payload?.root || ''), String(payload?.url || ''), String(payload?.title || ''))
})
ipcMain.handle('browser-agent:list-bookmarks', async (_e, payload: { root?: string } = {}) => {
  return browserAgentService.listBookmarks(String(payload?.root || ''))
})
ipcMain.handle('browser-agent:remove-bookmark', async (_e, payload: { root?: string; path?: string } = {}) => {
  return browserAgentService.removeBookmark(String(payload?.root || ''), String(payload?.path || ''))
})
ipcMain.handle('browser-agent:update-bookmark', async (_e, payload: { root?: string; path?: string; title?: string; url?: string } = {}) => {
  return browserAgentService.updateBookmark(String(payload?.root || ''), String(payload?.path || ''), String(payload?.title || ''), String(payload?.url || ''))
})
// 收藏夹整理：移动书签到其它目录 / 同目录重排 / 新建文件夹
ipcMain.handle('browser-agent:bookmark-move', async (_e, payload: { root?: string; srcPath?: string; dstDirRel?: string } = {}) => {
  return browserAgentService.moveBookmark(String(payload?.root || ''), String(payload?.srcPath || ''), String(payload?.dstDirRel || ''))
})
ipcMain.handle('browser-agent:bookmark-reorder', async (_e, payload: { root?: string; order?: string[] } = {}) => {
  return browserAgentService.reorderBookmarks(String(payload?.root || ''), Array.isArray(payload?.order) ? payload.order : [])
})
ipcMain.handle('browser-agent:bookmark-mkdir', async (_e, payload: { root?: string; name?: string } = {}) => {
  return browserAgentService.createBookmarkFolder(String(payload?.root || ''), String(payload?.name || ''))
})
// 收藏夹导入/导出（兼容浏览器导出的 Netscape 书签 HTML，如 favorites_*.html）：选文件/保存位置由系统对话框完成
ipcMain.handle('browser-agent:import-bookmarks', async (e, payload: { root?: string } = {}) => {
  const root = String(payload?.root || '')
  const win = e.sender && !e.sender.isDestroyed() ? BrowserWindow.fromWebContents(e.sender) : null
  const opts: Electron.OpenDialogOptions = {
    title: '导入浏览器书签（Netscape HTML）',
    buttonLabel: '导入',
    filters: [{ name: '书签 HTML', extensions: ['html', 'htm'] }],
    properties: ['openFile'],
  }
  const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (picked.canceled || !picked.filePaths?.length) return { ok: false, canceled: true }
  return browserAgentService.importBookmarksFile(root, picked.filePaths[0])
})
ipcMain.handle('browser-agent:export-bookmarks', async (e, payload: { root?: string } = {}) => {
  const root = String(payload?.root || '')
  const win = e.sender && !e.sender.isDestroyed() ? BrowserWindow.fromWebContents(e.sender) : null
  const d = new Date()
  const defaultPath = `favorites_${d.getFullYear()}_${d.getMonth() + 1}_${d.getDate()}.html`
  const opts: Electron.SaveDialogOptions = {
    title: '导出收藏为浏览器书签（Netscape HTML）',
    buttonLabel: '导出',
    defaultPath,
    filters: [{ name: '书签 HTML', extensions: ['html'] }],
  }
  const picked = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  if (picked.canceled || !picked.filePath) return { ok: false, canceled: true }
  return browserAgentService.exportBookmarksFile(root, picked.filePath)
})
// 收藏夹：删除文件夹 / 清空文件夹 / 清空全部（主进程内均有越界与“仅书签目录”安全检查）
ipcMain.handle('browser-agent:remove-bookmark-folder', async (_e, payload: { root?: string; path?: string } = {}) => {
  return browserAgentService.removeBookmarkFolder(String(payload?.root || ''), String(payload?.path || ''))
})
ipcMain.handle('browser-agent:clear-bookmark-folder', async (_e, payload: { root?: string; path?: string } = {}) => {
  return browserAgentService.clearBookmarkFolderContents(String(payload?.root || ''), String(payload?.path || ''))
})
// 收藏夹：重命名文件夹（目录改名，内部书签/子目录随之移动；主进程有越界与“仅书签目录”安全检查）
ipcMain.handle('browser-agent:bookmark-rename-folder', async (_e, payload: { root?: string; path?: string; name?: string } = {}) => {
  return browserAgentService.renameBookmarkFolder(String(payload?.root || ''), String(payload?.path || ''), String(payload?.name || ''))
})
ipcMain.handle('browser-agent:clear-bookmarks', async (_e, payload: { root?: string } = {}) => {
  return browserAgentService.clearBookmarks(String(payload?.root || ''))
})

// ==================== 清理 userData 缓存/临时文件（设置-系统-常用操作） ====================
// 只删除 Chromium/Electron 可自动再生成的缓存目录，绝不触碰软件数据：
// 配置(Local Storage / Preferences / window-zoom.json 等)、IndexedDB / databases / WebStorage、
// AI 会话记录(session-logs / ai-sessions)、Network(cookie 等)、credentials.json 全部保留。
const USERDATA_SAFE_CACHE_DIRS = [
  'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'blob_storage',
  'VideoDecodeStats', 'shared_proto_db', 'Service Worker', 'Dictionaries',
  'Shared Dictionary', 'Session Storage',
]
/**
 * Word 预览图片缓存目录（与 docxMediaDir() 同名）：
 * 由 Word→Markdown 转换生成，可按需重建（重开 Word 文件即重新提取），
 * 因此也纳入「清理缓存」的统计与清理范围。
 */
const DOCX_MEDIA_DIR_NAME = 'docx-media'
// 运行中被占用(EPERM/EBUSY)而删不掉的目录：写此标记文件，下次启动（无进程占用）时补清
const CACHE_CLEAN_PENDING_MARK = '.cache-clean-pending'
const cacheCleanPendingPath = () => join(app.getPath('userData'), CACHE_CLEAN_PENDING_MARK)

/** 递归统计目录占用字节数（统计失败按 0 处理） */
function dirSize(dir: string): number {
  if (!fs.existsSync(dir)) return 0
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) return sum + dirSize(p)
      try { return sum + (fs.statSync(p).size || 0) } catch { return sum }
    }, 0)
  } catch {
    return 0
  }
}

/** 仅清理缓存目录：先让 Chromium 自清 HTTP 磁盘缓存（能删除它自己仍在占用的条目/句柄，避免 EPERM），
 *  再删除其余目录。返回释放字节数 / 成功与失败目录。
 *  includeDocxMedia：是否同时清理 Word 预览图片缓存（docx-media）。手动「清理缓存」时为 true；
 *  启动补清（针对上次被进程占用的 Chromium 目录）为 false —— 否则重启后已恢复的 Word 标签页图片会失效。 */
async function cleanUserDataCache(includeDocxMedia = true): Promise<{ freed: number; removed: string[]; failed: string[] }> {
  const base = app.getPath('userData')
  const removed: string[] = []
  const failed: string[] = []
  let freed = 0
  // 先由 Chromium 清理 HTTP 缓存（Cache 目录）：它能在自身运行时安全删除占用中的条目，释放绝大部分空间
  try { await session.defaultSession.clearCache() } catch { /* ignore */ }
  const targets = includeDocxMedia ? [...USERDATA_SAFE_CACHE_DIRS, DOCX_MEDIA_DIR_NAME] : USERDATA_SAFE_CACHE_DIRS
  for (const name of targets) {
    const dir = join(base, name)
    if (!fs.existsSync(dir)) continue
    const size = dirSize(dir)
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      removed.push(name)
      freed += size
    } catch (e) {
      failed.push(name)
      console.warn(`[clean-userdata-cache] 清理 ${name} 失败（将在重启后补清）:`, e)
    }
  }
  // 重建已删除的空目录，避免个别依赖目录存在的组件异常（docx-media 下次转换时会自动重建）
  for (const name of removed) {
    try { fs.mkdirSync(join(base, name), { recursive: true }) } catch { /* ignore */ }
  }
  return { freed, removed, failed }
}

/** 全部可清理缓存目录的当前总占用（字节） */
function totalSafeCacheSize(): number {
  const base = app.getPath('userData')
  let total = 0
  for (const name of USERDATA_SAFE_CACHE_DIRS) total += dirSize(join(base, name))
  // Word 预览图片缓存同样属于可清理缓存，计入展示占用
  total += dirSize(join(base, DOCX_MEDIA_DIR_NAME))
  return total
}

// 查询可清理的缓存占用（设置页确认框/提示用）
ipcMain.handle('userdata-cache-info', () => {
  return { ok: true, bytes: totalSafeCacheSize() }
})

// 执行清理
ipcMain.handle('clean-userdata-cache', async () => {
  try {
    const before = totalSafeCacheSize()
    const res = await cleanUserDataCache()
    const after = totalSafeCacheSize()
    // 存在被占用删不掉的目录：写标记，等下次启动（无进程占用）时补清
    if (res.failed && res.failed.length) {
      try { fs.writeFileSync(cacheCleanPendingPath(), new Date().toISOString(), 'utf8') } catch { /* ignore */ }
    }
    return { ok: true, freed: Math.max(0, before - after), removed: res.removed, failed: res.failed }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
})

// 主题变化广播：主窗口切换主题后通知其他窗口跟随
ipcMain.on('notify-theme-change', (event, ui) => {
  if (!ui || typeof ui !== 'object') return
  const senderId = event.sender.id
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed() && w.webContents.id !== senderId) {
      w.webContents.send('theme-changed', ui)
    }
  })
})

// 设置独立窗口写盘广播：通知其它窗口（主窗口）从 localStorage 重新同步配置。
// 仅转发来自设置窗口的消息，避免其它窗口误触发主窗口全量重载。
ipcMain.on('settings-config-changed', (event, payload) => {
  if (!settingsWin || settingsWin.isDestroyed()) return
  if (event.sender.id !== settingsWin.webContents.id) return
  const senderId = event.sender.id
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed() && w.webContents.id !== senderId) {
      w.webContents.send('settings-config-changed', payload)
    }
  })
})

// 聊天记录变更广播：设置窗口（独立窗口）导入/清空聊天后，通知其它窗口（主窗口）从 localStorage 重新加载。
// 两个窗口共享同一份 ai-chats 存档，不广播的话主窗口下一次 saveChats 会把导入结果覆盖掉。
ipcMain.on('chats-changed', (event) => {
  const senderId = event.sender.id
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed() && w.webContents.id !== senderId) {
      w.webContents.send('chats-changed')
    }
  })
})

// 文件内容变更广播（通道 B：任一窗口保存文件后，通知各窗口刷新预览）
// 注意：必须包含发起窗口自身——独立文件窗口在「编辑视图」保存后切回「浏览视图」时，
// 需要本窗口也收到广播才能用最新内容刷新预览；否则只有其他窗口会更新（原 bug）。
ipcMain.handle('notify-file-changed', (event, { path: filePath, content }: { path: string; content?: string }) => {
  if (!filePath) return
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) {
      w.webContents.send('file-content-changed', { path: filePath, content })
    }
  })
})

/** 根据 webContents id 返回对应的 BrowserWindow */
function getWinBySender(senderId: number): BrowserWindow | null {
  // 优先匹配主窗口
  if (win && !win.isDestroyed()) {
    if (win.webContents.id === senderId) {
      console.log('[getWinBySender] → mainWindow', senderId)
      return win
    }
  }
  // fallback: 按 id 遍历所有窗口
  const found = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.webContents.id === senderId)
  console.log('[getWinBySender] fallback:', senderId, found ? 'found' : 'null')
  return found || win
}

ipcMain.handle('toggle-fullscreen', (event) => {
  const target = getWinBySender(event.sender.id)
  if (!target) return false
  if (target.isFullScreen()) {
    target.setFullScreen(false)
  } else {
    target.setFullScreen(true)
  }
  return target.isFullScreen()
})

ipcMain.handle('minimize-window', (event) => {
  getWinBySender(event.sender.id)?.minimize()
})

ipcMain.handle('maximize-window', (event) => {
  const target = getWinBySender(event.sender.id)
  if (!target) return
  if (target.isMaximized()) {
    target.unmaximize()
  } else {
    target.maximize()
  }
})

ipcMain.handle('close-window', (event) => {
  getWinBySender(event.sender.id)?.close()
})

// 窗口缩放：读取 / 设置 / 步进（设置页输入、Ctrl+±、Ctrl+滚轮共用）
// 读写的都是**全局**缩放：任一窗口调整后，软件内所有窗口一起变（实现见 window-zoom.ts）
ipcMain.handle('window:zoomGet', () => ({ factor: getGlobalZoom() }))

ipcMain.handle('window:zoomSet', (_event, { factor }: { factor: number }) => {
  const n = typeof factor === 'number' && isFinite(factor) ? factor : getGlobalZoom()
  return { factor: setGlobalZoom(n) }
})

ipcMain.handle('window:zoomStep', (_event, { delta }: { delta: number }) => {
  const d = typeof delta === 'number' && isFinite(delta) ? delta : 0.1
  return { factor: stepZoom(d) }
})

// ==================== 联网搜索源配置（设置页「工具 → 搜索」） ====================
// 渲染进程把设置页配置推给主进程（webSearch:set-config），web_search 工具按该配置分发搜索源；
// webSearch:test 供设置页「测试搜索」按钮直接验证当前配置是否可用（返回 success 而非 ok，避免被 IPC 信封误判）。
ipcMain.handle('webSearch:get-config', () => getWebSearchConfig())

ipcMain.handle('webSearch:set-config', (_event, cfg?: unknown) => setWebSearchConfig(cfg))

ipcMain.handle(
  'webSearch:test',
  async (_event, payload?: { query?: string; config?: unknown; provider?: string }) => {
    const query = String(payload?.query || '').trim() || 'OpenAI'
    // 携带配置时同步落库（测试的就是设置页所见配置）
    let cfg = payload && 'config' in payload ? setWebSearchConfig(payload.config) : getWebSearchConfig()
    // 指定 provider 时只测该源（设置页每张源卡片各自的「测试」按钮；与启用状态无关）
    const only = String(payload?.provider || '').trim()
    if (only) cfg = { ...cfg, providers: [only] as any, strategy: 'fallback' }
    const started = Date.now()
    try {
      const r = await runWebSearch(query, cfg)
      return {
        success: true,
        query: r.query,
        provider: r.provider,
        providers: r.providers,
        via: r.via,
        elapsedMs: r.elapsedMs,
        results: r.results,
      }
    } catch (e: any) {
      return { success: false, error: e?.message || String(e), elapsedMs: Date.now() - started }
    }
  },
)

// 文件树相关函数
function getDirectoryTree(directoryPath: string): any {
  const absolutePath = path.resolve(directoryPath);
  const stats = fs.statSync(directoryPath);
  if (stats.isDirectory()) {
    const files = fs.readdirSync(directoryPath);
    // 递归统计文件夹总大小与最新的修改时间（用于排序）
    let size = 0
    let mtime = stats.mtimeMs
    const children = files.map(file => {
      const child = getDirectoryTree(path.join(directoryPath, file));
      if (child.size) size += child.size
      if (child.mtime && child.mtime > mtime) mtime = child.mtime
      return child
    })
    const tree = {
      label: path.basename(directoryPath),
      type: 'folder',
      path: absolutePath,
      children,
      extension: 'folder',
      size,
      mtime
    }
    return tree;
  } else {
    return {
      label: path.basename(directoryPath),
      type: 'file',
      path: absolutePath,
      extension: path.extname(directoryPath),
      mtime: stats.mtimeMs,
      size: stats.size
    };
  }
}

/** 有界并发 map：按输入顺序输出结果，限制同时执行的异步任务数（避免大目录并发 stat 打开过多句柄） */
async function pMap<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: (R | undefined)[] = new Array(items.length)
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = index++
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results as R[]
}

/** 异步非阻塞目录树扫描：readdir withFileTypes 免类型 stat、仅对文件 stat，有界并发；避免同步 statSync 阻塞主进程 */
async function getDirectoryTreeAsync(directoryPath: string, dirMtimes?: Map<string, number>): Promise<any> {
  const absolutePath = path.resolve(directoryPath)
  const stats = await fs.promises.stat(directoryPath)
  if (stats.isDirectory()) {
    // 记录文件夹自身 mtime（用于缓存深层校验：子项增删/重命名时该值变化）
    if (dirMtimes) dirMtimes.set(absolutePath, Math.round(stats.mtimeMs))
    const dirents = await fs.promises.readdir(directoryPath, { withFileTypes: true })
    const children = await pMap(dirents, 64, async (dirent) => {
      const childPath = path.join(directoryPath, dirent.name)
      if (dirent.isDirectory()) {
        return getDirectoryTreeAsync(childPath, dirMtimes)
      }
      if (dirent.isFile()) {
        const s = await fs.promises.stat(childPath)
        return { label: dirent.name, type: 'file', path: childPath, extension: path.extname(dirent.name), mtime: s.mtimeMs, size: s.size }
      }
      // 符号链接等特殊类型：stat 解析（失败则忽略）
      try {
        const s = await fs.promises.stat(childPath)
        if (s.isDirectory()) return getDirectoryTreeAsync(childPath, dirMtimes)
        return { label: dirent.name, type: 'file', path: childPath, extension: path.extname(dirent.name), mtime: s.mtimeMs, size: s.size }
      } catch {
        return null
      }
    })
    const nodes = children.filter((c: any) => c != null)
    let size = 0
    let mtime = stats.mtimeMs
    for (const c of nodes) {
      if (c.size) size += c.size
      if (c.mtime && c.mtime > mtime) mtime = c.mtime
    }
    return { label: path.basename(directoryPath), type: 'folder', path: absolutePath, children: nodes, extension: 'folder', size, mtime }
  } else {
    return { label: path.basename(directoryPath), type: 'file', path: absolutePath, extension: path.extname(directoryPath), mtime: stats.mtimeMs, size: stats.size }
  }
}

// ==================== 文件树缓存（按工作区根路径） ====================
// 目的：启动/重挂载知识管理面板时若每次都全量重扫数万~十余万文件并整树回传（每个节点带完整
// 绝对路径，JSON 数十 MB、渲染端 parse 出上百 MB 对象），切换面板就会卡顿甚至内存暴涨崩溃。方案：
//  1. 缓存每个根目录的扫描结果；文件系统监听触发变更时按根失效。
//  2. 服务缓存前做两层廉价校验：顶层签名（readdir 名称+类型）+ 全目录 mtime 指纹
//     （只 stat 文件夹、数量远少于文件），可捕获任意深度的增删/重命名。
//  3. 缓存跨面板切换保留（stopWatching 不清空），配合渲染端持久化 treeVersion：
//     数据未变时直接返回 unchanged，跳过整棵树回传与渲染端重新处理。
const treeCache = new Map<string, { tree: any; topNames: string[]; dirMtimes: Map<string, number> }>()
let treeVersion = 0

/** 读取目录顶层条目签名（文件夹带 '/' 后缀以区分类型），用于缓存廉价校验 */
async function readTopLevelSignature(directoryPath: string): Promise<string[]> {
  try {
    const dirents = await fs.promises.readdir(directoryPath, { withFileTypes: true })
    return dirents.map((d) => (d.isDirectory() ? d.name + '/' : d.name)).sort()
  } catch {
    return []
  }
}

/** 校验某根目录的缓存是否仍有效：顶层签名 + 全目录 mtime 指纹（可捕获任意深度的增删/重命名） */
async function isTreeCacheValid(directoryPath: string): Promise<boolean> {
  const topNames = await readTopLevelSignature(directoryPath)
  const cached = treeCache.get(directoryPath)
  if (!cached || cached.topNames.length !== topNames.length || !cached.topNames.every((n: string, i: number) => n === topNames[i])) {
    return false
  }
  // 深层校验：仅 stat 缓存中记录的每个文件夹（数量远少于文件），比对扫描时的 mtime。
  // 文件夹 mtime 在子项增删/重命名时变化 → 可检测知识处理等造成的深层结构变更，而无需全量重扫。
  const dirMtimes = cached.dirMtimes
  if (dirMtimes && dirMtimes.size) {
    for (const [dirPath, mtime] of dirMtimes) {
      try {
        if (Math.round((await fs.promises.stat(dirPath)).mtimeMs) !== mtime) return false
      } catch {
        return false
      }
    }
  }
  return true
}

/** 带缓存的目录树扫描：顶层与深层结构均未变化时直接返回缓存，避免重复全量重扫/回传 */
async function getDirectoryTreeCached(directoryPath: string): Promise<any> {
  const cached = treeCache.get(directoryPath)
  if (cached && (await isTreeCacheValid(directoryPath))) {
    return cached.tree
  }
  const topNames = await readTopLevelSignature(directoryPath)
  const dirMtimes = new Map<string, number>()
  const tree = await getDirectoryTreeAsync(directoryPath, dirMtimes)
  treeCache.set(directoryPath, { tree, topNames, dirMtimes })
  treeVersion++
  return tree
}

ipcMain.handle('getDirectoryTree', (event, folderPath) => {
  if (folderPath) {
    const tree = [getDirectoryTree(folderPath)];
    fs.watchFile(folderPath, (curr: any, prev: any) => {
      console.log("文件变化")
    })
    return tree;
  }
})

// ==================== CollectFile 文件夹递归扫描 ====================
// 支持扩展名过滤与排除目录剪枝（避免遍历 node_modules 等大目录）
// 自然排序：数字段按数值比较（1.md < 2.md < 10.md < 100.md），非数字段按字典序比较
function naturalCompare(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g
  const aParts = a.match(re) || []
  const bParts = b.match(re) || []
  const n = Math.min(aParts.length, bParts.length)
  for (let i = 0; i < n; i++) {
    const ap = aParts[i]
    const bp = bParts[i]
    const aNum = /^\d+$/.test(ap)
    const bNum = /^\d+$/.test(bp)
    if (aNum && bNum) {
      const diff = parseInt(ap, 10) - parseInt(bp, 10)
      if (diff !== 0) return diff
      // 数值相等（如 001 与 1）时按原始长度升序，保证排序稳定
      if (ap.length !== bp.length) return ap.length - bp.length
    } else {
      if (ap !== bp) return ap < bp ? -1 : 1
    }
  }
  return aParts.length - bParts.length
}

function scanFolderRecursive(
  dir: string,
  opts: { extensions: string[]; excludeDirs: string[]; excludeFiles: string[]; maxFiles: number },
  out: any[] = [],
  rootPath: string = dir
): any[] {
  if (opts.maxFiles > 0 && out.length >= opts.maxFiles) return out
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (opts.maxFiles > 0 && out.length >= opts.maxFiles) break
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (opts.excludeDirs.includes(entry.name)) continue
      scanFolderRecursive(fullPath, opts, out, rootPath)
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase()
      if (opts.extensions.length > 0 && !opts.extensions.includes(ext)) continue
      if (opts.excludeFiles.some(p => matchesFilePattern(entry.name, p))) continue
      let size = 0
      try { size = fs.statSync(fullPath).size } catch { /* ignore */ }
      out.push({
        filePath: fullPath,
        relativePath: path.relative(rootPath, fullPath),
        fileName: entry.name,
        extension: ext,
        size
      })
    }
  }
  // 按相对路径自然排序：同目录文件聚在一起，数字文件名按数值顺序（1.md、2.md、…、10.md）
  out.sort((a, b) => naturalCompare(a.relativePath, b.relativePath))
  return out
}

function matchesFilePattern(fileName: string, pattern: string): boolean {
  if (!pattern) return false
  if (pattern.includes('*')) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    try {
      return new RegExp('^' + escaped + '$').test(fileName)
    } catch {
      return false
    }
  }
  return fileName === pattern
}

ipcMain.handle('scanFolder', (event, { folderPath, extensions, excludeDirs, excludeFiles, maxFiles }) => {
  try {
    if (!folderPath) return { success: false, error: '未指定文件夹路径' }
    const files = scanFolderRecursive(folderPath, {
      extensions: (extensions || []).map((e: string) => String(e).toLowerCase()),
      excludeDirs: excludeDirs || [],
      excludeFiles: excludeFiles || [],
      maxFiles: maxFiles || 0
    })
    return { success: true, files }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

// Windows 系统保留文件/目录（根目录常见）：列出时跳过，避免无权限 stat/readdir 报错
const SYSTEM_ENTRIES = new Set([
  'system volume information', '$recycle.bin', 'dumpstack.log.tmp',
  'pagefile.sys', 'hiberfil.sys', 'swapfile.sys',
  '$windows.~bt', '$windows.~ws', '$winreagent'
])

function getFiles(folderPath: string, depth: number, fileList: any[] = []): any[] {
  let files: string[]
  try {
    files = fs.readdirSync(folderPath);
  } catch {
    // 无权限读取目录（如 System Volume Information），跳过该目录
    return fileList;
  }
  depth--;

  files.forEach(file => {
    // 跳过系统保留项（根目录常见，stat/readdir 会权限报错）
    if (SYSTEM_ENTRIES.has(file.toLowerCase())) return;
    const filePath = path.join(folderPath, file);
    let stats: fs.Stats
    try {
      stats = fs.statSync(filePath);
    } catch {
      // 权限受限条目（如 DumpStack.log.tmp）无法 stat，跳过
      return;
    }
    if (stats.isDirectory() && depth > 0) {
      getFiles(filePath, depth, fileList);
    } else {
      const fileExtension = path.extname(filePath);
      let fileData = {
        label: path.basename(filePath),
        type: stats.isDirectory() ? 'folder' : 'file',
        path: filePath,
        extension: stats.isDirectory() ? 'folder' : fileExtension,
        mtime: stats.mtimeMs,
        size: stats.size,
        // Unix 下无扩展名可执行文件（+x 权限位）标记为可执行，用于统一图标/系统打开
        executable: process.platform !== 'win32' && !stats.isDirectory() && (stats.mode & 0o111) !== 0,
        attributes: {}
      }
      try {
        fileData.attributes = getConfig(filePath)
      } catch { /* 元数据读取失败忽略 */ }
      fileList.push(fileData);
    }
  });
  return fileList;
}

async function getFilesRelation(folderPath: string, depth: number, parentIndex: number | undefined, fileList: any[] = [], relationList: any[] = []): Promise<{ fileList: any[], relationList: any[] }> {
  if (depth <= 0) return { fileList, relationList };
  
  const dirents = await fs.promises.readdir(folderPath, { withFileTypes: true })
  
  for (const dirent of dirents) {
    const filePath = path.join(folderPath, dirent.name)
    let isDir = dirent.isDirectory()
    let stats: any = null
    if (dirent.isFile() || isDir) {
      stats = await fs.promises.stat(filePath)
    } else {
      // 符号链接等特殊类型：stat 解析（失败则跳过）
      try { stats = await fs.promises.stat(filePath); isDir = stats.isDirectory() } catch { continue }
    }

    const fileData = {
      id: fileList.length,
      label: dirent.name,
      type: isDir ? 'folder' : 'file',
      path: filePath,
      extension: isDir ? 'folder' : path.extname(filePath),
      size: stats.size,
      mtime: stats.mtimeMs,
      attributes: {}
    }
    
    if (fileData.extension === '.md' || fileData.type === 'folder') {
      fileData.attributes = getConfig(filePath)
    }
    
    fileList.push(fileData)
    
    if (parentIndex !== undefined) {
      relationList.push({ source: parentIndex, target: fileData.id })
    }

    if (isDir && depth > 1) {
      await getFilesRelation(filePath, depth - 1, fileData.id, fileList, relationList)
    }
  }
  
  return { fileList, relationList }
}

function getConfig(fullPath: string): any {
  try {
    let isFolder = fs.statSync(fullPath).isDirectory()
    fullPath = isFolder ? (fullPath + "\\.README.md") : (fullPath)
    if (path.extname(fullPath) != '.md') return {}
    if (fs.existsSync(fullPath)) {
      // 只读文件头部（YAML frontmatter 位于文件开头），避免整文件读取的开销
      const fd = fs.openSync(fullPath, 'r')
      let fileContent = ''
      try {
        const buf = Buffer.alloc(8192)
        const bytes = fs.readSync(fd, asUint8(buf), 0, buf.length, 0)
        fileContent = buf.toString('utf8', 0, bytes)
      } finally {
        fs.closeSync(fd)
      }
      const matches = fileContent.match(/^---\r?\n([\s\S]+?)\r?\n---/)
      if (matches && matches.length > 1) {
        const yamlHeader = matches[1]
        try {
          const headerObj = yaml.load(yamlHeader)
          return headerObj
        } catch (error) {
          console.error('Failed to parse YAML header:', error)
          return {}
        }
      } else {
        return {}
      }
    } else {
      return {}
    }
  } catch (error) {
    console.error('An error occurred while trying to load the js-yaml module:', error);
    return {}
  }
}

ipcMain.handle('getConfig', (event, path) => {
  if (path) {
    return getConfig(path)
  }
})

ipcMain.handle('saveFileMetadata', async (event, filePath, metadata) => {
  try {
    if (!filePath || path.extname(filePath) !== '.md') return false
    if (!fs.existsSync(filePath)) return false

    const fileContent = fs.readFileSync(filePath, 'utf8')
    const matches = fileContent.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n?/)
    const rest = matches ? fileContent.slice(matches[0].length) : (matches === null ? fileContent : '')

    const yamlStr = yaml.dump(metadata || {})
    const newContent = `---\n${yamlStr}---\n${rest}`

    fs.writeFileSync(filePath, newContent, 'utf8')
    return true
  } catch (error) {
    console.error('保存文件元数据失败:', error)
    return false
  }
})

ipcMain.handle('getFiles', (event, folderPath, n) => {
  if (folderPath) {
    const files = getFiles(folderPath, n, [])
    return files
  }
})

ipcMain.handle('getFilesRelation', async (event, folderPath, n) => {
  if (folderPath) {
    const { fileList, relationList } = await getFilesRelation(folderPath, n, undefined)
    return { fileList, relationList }
  }
})

ipcMain.handle('selectFile', async (event, payload) => {
  const { filters, properties } = (payload && typeof payload === 'object') ? payload as any : {} as any
  // 用「发起请求的窗口」作为父窗口：此前一律用主窗口 win，
  // 导致子窗口（FileWindow）发起的选择框会把主窗口变成模态禁用状态
  // （Windows 上点击被禁用的窗口会响系统提示音、且要等对话框销毁后才恢复）
  const parent = BrowserWindow.fromWebContents(event.sender) || win
  const opts: Electron.OpenDialogOptions = {
    properties: properties || ['openFile'],
    ...(filters ? { filters } : {})
  }
  const result = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)

  if (!result.canceled) {
    return result.filePaths[0];
  } else {
    return null;
  }
});

// 保存文件对话框（导出场景，如 Agent 预设 .agent 文件、Word 导出选保存位置）
ipcMain.handle('saveFileDialog', async (event, payload) => {
  const { defaultPath, filters } = payload || {}
  // 用发起请求的窗口作为父窗口：否则子窗口（FileWindow）里发起会挂到主窗口上
  const parent = BrowserWindow.fromWebContents(event.sender) || win
  const opts: Electron.SaveDialogOptions = {
    defaultPath: defaultPath || 'export.agent',
    filters: filters || [
      { name: 'Agent Preset', extensions: ['agent'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  }
  const result = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts)
  if (!result.canceled && result.filePath) {
    return result.filePath
  }
  return null
})

/**
 * 导出 .docx（Word）：渲染层把已生成的字节（base64）与目标路径交给主进程直写。
 * - targetPath 非绝对路径（只有文件名）时落到系统下载目录；
 * - overwrite=false（默认）时重名自动追加 (1)，避免静默覆盖；
 * 返回 { ok, path }，path 为实际落盘路径（用于提示用户存到哪里）。
 */
ipcMain.handle('exportDocx', async (_event, payload) => {
  const { base64, targetPath, overwrite } = payload || {}
  if (typeof base64 !== 'string' || !base64) return { ok: false, error: '缺少导出内容' }
  try {
    const raw = String(targetPath || '').trim() || 'document.docx'
    const target = path.isAbsolute(raw) ? raw : path.join(app.getPath('downloads'), raw)
    const finalPath = overwrite ? target : uniqueFilePath(target)
    writeExportFile(finalPath, undefined, base64)
    console.log('[export-docx] 已保存到', finalPath)
    return { ok: true, path: finalPath }
  } catch (error: any) {
    console.error('[export-docx] 写盘失败', error)
    return { ok: false, error: String(error?.message || error) }
  }
})

ipcMain.handle('openFolderDialog', async (event) => {
  const result = await dialog.showOpenDialog(win!, {
    properties: ['openDirectory']
  });

  if (!result.canceled) {
    return result.filePaths[0];
  } else {
    return null;
  }
});

// ====== 大表格后台解析（worker_threads，避免阻塞主进程导致白屏） ======
// 同一路径可能被并发读取（例如实例首次激活时 onMounted/onActivated 各触发一次恢复，
// 或两个窗口打开同一任务）：
//   · tableParseInFlight —— 同一路径正在解析时复用同一个 Promise，避免重复解析整张表；
//   · refs 引用计数 —— 只有最后一个读者调用 done 时才释放，避免「先结束的读者把后一个读者的缓存删掉」。
const tableParseCache = new Map<string, { rows: any[][]; total: number; refs: number; usedAt: number }>()
const tableParseInFlight = new Map<string, Promise<any[][]>>()
/** 引用计数不为 0 也不该长期滞留（读者崩溃/刷新时兜底清理）：闲置超过该时长即释放 */
const TABLE_PARSE_IDLE_MS = 10 * 60 * 1000

function releaseIdleTableParseCache() {
  const now = Date.now()
  for (const [k, v] of tableParseCache) {
    if (now - v.usedAt > TABLE_PARSE_IDLE_MS) tableParseCache.delete(k)
  }
}

// xlsx 入口绝对路径：dev 指向 node_modules/xlsx/xlsx.js；打包后指向 app.asar/node_modules/xlsx/xlsx.js。
// worker eval 的 require 基于进程工作目录解析，找不到 asar 内的 xlsx，必须用绝对路径加载。
const nodeRequire = createRequire(import.meta.url)
const XLSX_ENTRY = nodeRequire.resolve('xlsx')

function parseTableInWorker(filePath: string): Promise<any[][]> {
  return new Promise((resolve, reject) => {
    const workerCode = `
      const { parentPort, workerData } = require('worker_threads');
      const xlsx = require(workerData.xlsxPath);
      const fs = require('fs');
      const path = require('path');
      try {
        const filePath = workerData.filePath;
        const ext = path.extname(filePath).toLowerCase();
        let rows;
        if (ext === '.csv' || ext === '.txt') {
          const text = fs.readFileSync(filePath, 'utf-8');
          const wb = xlsx.read(text, { type: 'string' });
          rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
        } else {
          const wb = xlsx.readFile(filePath);
          rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
        }
        parentPort.postMessage({ ok: true, rows });
      } catch (e) {
        parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
      }
    `;
    const worker = new Worker(workerCode, { eval: true, workerData: { filePath, xlsxPath: XLSX_ENTRY } });
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; fn() } };
    worker.once('message', (msg: any) => {
      worker.terminate();
      if (msg && msg.ok) finish(() => resolve(msg.rows))
      else finish(() => reject(new Error(msg?.error || '表格解析失败')));
    });
    worker.once('error', (e) => { worker.terminate(); finish(() => reject(e)) });
    worker.once('exit', (code) => { finish(() => { if (code !== 0) reject(new Error('表格解析线程异常退出: ' + code)) }) });
  });
}

// 开始解析：后台线程解析整个表格并缓存，返回总行数（同一路径并发调用共享一次解析）
ipcMain.handle('parseTableFile:start', async (event, filePath: string) => {
  try {
    releaseIdleTableParseCache()
    let parsing = tableParseInFlight.get(filePath)
    if (!parsing) {
      parsing = parseTableInWorker(filePath).finally(() => tableParseInFlight.delete(filePath))
      tableParseInFlight.set(filePath, parsing)
    }
    const rows = await parsing
    const exist = tableParseCache.get(filePath)
    if (exist) {
      exist.refs += 1
      exist.usedAt = Date.now()
    } else {
      tableParseCache.set(filePath, { rows, total: rows.length, refs: 1, usedAt: Date.now() })
    }
    return { success: true, total: rows.length };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

// 分批取解析结果（避免超大 JSON 一次性过 IPC 内存翻倍）
ipcMain.handle('parseTableFile:chunk', async (event, filePath: string, offset: number, limit: number) => {
  const entry = tableParseCache.get(filePath);
  if (!entry) return { success: false, error: '表格解析缓存不存在（可能已被释放）' };
  entry.usedAt = Date.now()
  const rows = entry.rows.slice(offset, offset + limit);
  return { success: true, rows };
});

// 解析完成，释放缓存：引用计数归零才真正释放（并发读者互不影响）
ipcMain.handle('parseTableFile:done', async (event, filePath: string) => {
  const entry = tableParseCache.get(filePath);
  if (entry) {
    entry.refs -= 1;
    entry.usedAt = Date.now();
    if (entry.refs <= 0) tableParseCache.delete(filePath);
  }
  return { success: true };
});

// 保存任务状态文件 (.task)
ipcMain.handle('saveTaskFile', async (event, content: string) => {
  const result = await dialog.showSaveDialog(win!, {
    title: '保存任务状态',
    defaultPath: `task_${new Date().toISOString().slice(0, 10)}.task`,
    filters: [{ name: '任务文件', extensions: ['task'] }]
  });

  if (!result.canceled && result.filePath) {
    try {
      await fs.promises.writeFile(result.filePath, content, 'utf-8');
      return { success: true, path: result.filePath };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
  return { success: false, error: '用户取消' };
});

// 读取任务状态文件 (.task)
ipcMain.handle('loadTaskFile', async (event) => {
  const result = await dialog.showOpenDialog(win!, {
    title: '读取任务状态',
    properties: ['openFile'],
    filters: [{ name: '任务文件', extensions: ['task'] }]
  });

  if (!result.canceled && result.filePaths.length > 0) {
    try {
      const content = fs.readFileSync(result.filePaths[0], 'utf-8');
      return { success: true, content, path: result.filePaths[0] };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
  return { success: false, error: '用户取消' };
});

// 读取指定路径的任务状态文件 (.task)：供「知识管理双击 .task → 跳转对应脚手架并加载」使用（不弹对话框）
// maxBytes 传入时只读文件开头片段（用于识别任务所属脚手架，避免把上百 MB 的任务文件整体读进渲染层）
ipcMain.handle('readTaskFile', async (event, filePath: string, maxBytes?: number) => {
  try {
    if (maxBytes && maxBytes > 0) {
      const handle = await fs.promises.open(filePath, 'r');
      try {
        const buf = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
        return { success: true, content: buf.subarray(0, bytesRead).toString('utf-8'), path: filePath, partial: true };
      } finally {
        await handle.close();
      }
    }
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return { success: true, content, path: filePath };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

// ===== 实例关联任务文件（Agent脚手架多开） =====
// 默认落点：userData/tasks（不受工作区/网盘影响，始终可写；路径可在导航栏 tooltip 查看）
const defaultTaskFilesDir = () => path.join(app.getPath('userData'), 'tasks')

// 写入指定路径的任务文件（覆盖写，目录不存在则创建）：供「实例关联文件」保存使用（不弹对话框）
ipcMain.handle('writeTaskFile', async (event, filePath: string, content: string) => {
  try {
    if (!filePath) throw new Error('缺少任务文件路径');
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, content, 'utf-8');
    return { success: true, path: filePath };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

// 新建实例时立即创建任务文件：返回唯一路径（同名自动追加 -2 / -3 序号），保证「一实例一文件」
ipcMain.handle('createTaskFile', async (event, opts: { baseName?: string; dir?: string; content?: string }) => {
  try {
    const dir = opts?.dir || defaultTaskFilesDir();
    await fs.promises.mkdir(dir, { recursive: true });
    // 文件名清洗：去掉 Windows 非法字符，限长
    const raw = String(opts?.baseName || 'task').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || 'task';
    const base = raw.slice(0, 60);
    let filePath = path.join(dir, `${base}.task`);
    let n = 2;
    while (true) {
      try {
        await fs.promises.access(filePath);
        filePath = path.join(dir, `${base}-${n++}.task`);
      } catch { break; } // 不存在 → 可用
    }
    await fs.promises.writeFile(filePath, opts?.content ?? '', 'utf-8');
    return { success: true, path: filePath };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

// 批量查询任务文件状态（供导航栏 L0 显示大小/修改时间/缺失标记；不读内容，成本极低）
ipcMain.handle('statTaskFiles', async (event, paths: string[]) => {
  const out: { path: string; exists: boolean; size?: number; mtime?: number }[] = [];
  for (const p of Array.isArray(paths) ? paths : []) {
    try {
      const st = await fs.promises.stat(p);
      out.push({ path: p, exists: st.isFile(), size: st.size, mtime: st.mtimeMs });
    } catch {
      out.push({ path: p, exists: false });
    }
  }
  return out;
});

// 定时自动保存任务快照：写到参考任务文件（referencePath）所在目录，文件名附加保存时间，不弹对话框
ipcMain.handle('saveTaskFileAuto', async (event, referencePath: string, content: string) => {
  try {
    if (!referencePath) throw new Error('缺少参考任务路径');
    const dir = path.dirname(referencePath);
    const base = path.basename(referencePath, path.extname(referencePath));
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    const filePath = path.join(dir, `${base}_${stamp}.task`);
    await fs.promises.writeFile(filePath, content, 'utf-8');
    return { success: true, path: filePath };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

// 导出 PDF：隐藏窗口渲染 HTML → printToPDF → 保存
ipcMain.handle('exportPdf', async (event, { html, title }: { html: string; title: string }) => {
  const result = await dialog.showSaveDialog(win!, {
    title: '导出 PDF',
    defaultPath: `${title || '文档'}.pdf`,
    filters: [{ name: 'PDF 文档', extensions: ['pdf'] }]
  })
  if (result.canceled || !result.filePath) {
    return { success: false, error: '用户取消' }
  }
  let pdfWin: BrowserWindow | null = null
  const tmpFile = path.join(app.getPath('temp'), `pdf-export-${Date.now()}.html`)
  try {
    fs.writeFileSync(tmpFile, html, 'utf-8')
    pdfWin = new BrowserWindow({
      show: false,
      width: 900,
      height: 1200,
      // ⚠️ 必须用独立 partition：本窗口加载的是 file:// 临时文件，与应用窗口同源，
      // 共用会话时会共享「同源缩放」（应用设了 150% 它也会变 150%，导致 printToPDF 变形；
      // 而把它压回 100% 又会把应用窗口的缩放一起拉回去）。
      webPreferences: { offscreen: true, partition: 'pdf-export' }
    })
    // 内部导出窗口：不参与全局缩放
    excludeFromAppZoom(pdfWin)
    await pdfWin.loadFile(tmpFile)
    const pdfData = await pdfWin.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4'
    })
    pdfWin.destroy()
    pdfWin = null
    try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
    fs.writeFileSync(result.filePath, asUint8(pdfData))
    return { success: true, path: result.filePath }
  } catch (error: any) {
    console.error('导出 PDF 失败:', error)
    if (pdfWin && !pdfWin.isDestroyed()) pdfWin.destroy()
    try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
    return { success: false, error: error.message }
  }
})

// ==================== 导出 Excel ====================
/** Excel 单元格最长字符数（xlsx 规范上限；超长会被 SheetJS 直接报错，导致整个导出失败） */
const MAX_EXCEL_CELL_CHARS = 32767
/**
 * 单元格清洗（与渲染层同一套规则，兜底其它调用方）：去 XML 非法控制字符 + 截到 Excel 单元格上限。
 * 超长单元格会让 xlsx 直接报 “Text length must not exceed 32767 characters”，导致整份导出失败。
 */
const sanitizeExcelCell = (v: any): string => {
  if (v === null || v === undefined) return ''
  let s = typeof v === 'string' ? v : (typeof v === 'object' ? JSON.stringify(v) : String(v))
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  if (s.length > MAX_EXCEL_CELL_CHARS) {
    const mark = '…（内容超长，已在导出时截断）'
    s = s.slice(0, MAX_EXCEL_CELL_CHARS - mark.length) + mark
  }
  return s
}
const sanitizeExcelRows = (data: Record<string, any>[]): Record<string, string>[] =>
  (data || []).map((row) => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(row || {})) out[k] = sanitizeExcelCell(v)
    return out
  })

/** 一次性导出（小数据 / 旧调用方）：选路径 → 建表 → 落盘 */
ipcMain.handle('exportExcel', async (event, { data, filename }: { data: Record<string, any>[]; filename: string }) => {
  const result = await dialog.showSaveDialog(win!, {
    title: '导出数据',
    defaultPath: `${filename}.xlsx`,
    filters: [{ name: 'Excel 文件', extensions: ['xlsx'] }]
  });

  if (!result.canceled && result.filePath) {
    try {
      const workbook = xlsx.utils.book_new()
      const worksheet = xlsx.utils.json_to_sheet(sanitizeExcelRows(data))
      xlsx.utils.book_append_sheet(workbook, worksheet, 'Sheet1')
      xlsx.writeFile(workbook, result.filePath)
      return { success: true, path: result.filePath }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  }
  return { success: false, error: '用户取消' }
});

/**
 * 分片式导出（大表格导出时渲染层逐片发过来，主进程逐片追加到同一张工作表）：
 * - 渲染层每片几千行，片间让出事件循环 → 界面不卡、还能显示进度；
 * - 主进程不再一次性 json_to_sheet 几十万行（那是导出卡顿的主因），改为每片 sheet_add_json 追加；
 * - 最后 exportExcel:done 一次性落盘。
 */
type ExcelExportSession = { filePath: string; header: string[]; ws: any | null; count: number }
let excelExportSession: ExcelExportSession | null = null

ipcMain.handle('exportExcel:start', async (_event, { filename, header }: { filename: string; header?: string[] }) => {
  excelExportSession = null
  const result = await dialog.showSaveDialog(win!, {
    title: '导出数据',
    defaultPath: `${filename}.xlsx`,
    filters: [{ name: 'Excel 文件', extensions: ['xlsx'] }]
  })
  if (result.canceled || !result.filePath) return { success: false, error: '用户取消' }
  excelExportSession = { filePath: result.filePath, header: Array.isArray(header) ? header.map(h => String(h)) : [], ws: null, count: 0 }
  return { success: true, path: result.filePath }
})

ipcMain.handle('exportExcel:chunk', async (_event, { rows, header }: { rows: Record<string, any>[]; header?: string[] }) => {
  const session = excelExportSession
  if (!session) return { success: false, error: '导出会话已结束' }
  try {
    const safe = sanitizeExcelRows(rows)
    if (Array.isArray(header) && header.length) session.header = header.map(h => String(h))
    const opts: any = session.header.length ? { header: session.header } : {}
    if (!session.ws) {
      session.ws = xlsx.utils.json_to_sheet(safe, opts)
    } else if (safe.length) {
      // origin: -1 = 追加到已有内容之后（表头已由第一片写入）
      xlsx.utils.sheet_add_json(session.ws, safe, { ...opts, skipHeader: true, origin: -1 })
    }
    session.count += safe.length
    return { success: true, count: session.count }
  } catch (error: any) {
    excelExportSession = null
    return { success: false, error: error.message }
  }
})

ipcMain.handle('exportExcel:done', async () => {
  const session = excelExportSession
  excelExportSession = null
  if (!session) return { success: false, error: '导出会话已结束' }
  try {
    const workbook = xlsx.utils.book_new()
    const worksheet = session.ws || xlsx.utils.json_to_sheet([], session.header.length ? { header: session.header } : {})
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Sheet1')
    xlsx.writeFile(workbook, session.filePath)
    return { success: true, path: session.filePath, rows: session.count }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

/** 中止导出：丢掉会话（不写文件、不留半成品） */
ipcMain.handle('exportExcel:abort', async () => {
  excelExportSession = null
  return { success: true }
})


async function readPdf(filePath: string): Promise<string> {
  const fileBuffer = fs.readFileSync(filePath)
  const uint8 = new Uint8Array(fileBuffer)
  const loadingTask = PDFJS.getDocument({ data: uint8 })
  const pdfDocument = await loadingTask.promise
  const pageCount = pdfDocument.numPages;
  let textContent = '';

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdfDocument.getPage(i);
    const content = await page.getTextContent();
    const strings = (content as { items: { str: string }[] }).items.map(item => item.str);
    textContent += strings.join(' ');
  }
  return textContent;
}

// 单独提取 Word 文档中的图片（不参与文字转 Markdown，供独立调用，例如需要单独保存/展示图片时使用）
async function extractWordImages(filePath: string): Promise<{
  images: { index: number; alt: string; contentType: string; base64: string }[]
}> {
  const images: { index: number; alt: string; contentType: string; base64: string }[] = []
  // 注意：convertImage 必须作为 convertToHtml 的第二个参数（options），写在 input 里会被 mammoth 忽略
  await mammoth.convertToHtml({ path: filePath }, {
    convertImage: (mammoth.images as any).imgElement(async (image: any) => {
      const base64 = await image.read('base64')
      images.push({
        index: images.length,
        alt: image.altText || '',
        contentType: image.contentType || 'image/png',
        base64
      })
      return { src: `data:${image.contentType || 'image/png'};base64,${base64}` }
    })
  } as any)
  return { images }
}

function convertToMarkdown(data: any[]): string {
  let markdown = '';
  const headers = data[0];
  markdown += '| ' + headers.join(' | ') + ' |\n';
  markdown += '| ' + headers.map(() => '---').join(' | ') + ' |\n';
  for (let i = 1; i < data.length; i++) {
    markdown += '| ' + data[i].join(' | ') + ' |\n';
  }
  return markdown;
}

// ==================== CSV → Markdown 表格 ====================
// 兼容带引号的字段（内含逗号/换行、转义引号 ""）、CRLF 行尾、BOM，
// 以及中文 Windows 常见的 GBK/GB2312 编码（Excel 导出 CSV 默认编码）。
// 单元格中的竖线转义为 \|，单元格内换行折叠为空格，保证生成的 Markdown 表格始终结构完整。
function decodeCsvBuffer(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return new TextDecoder('utf-8').decode(asUint8(buf.subarray(3))); // 去 UTF-8 BOM
  }
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return new TextDecoder('utf-16le').decode(asUint8(buf.subarray(2))); // UTF-16LE BOM
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    return new TextDecoder('utf-16be').decode(asUint8(buf.subarray(2))); // UTF-16BE BOM
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(asUint8(buf));
  } catch {
    // UTF-8 解码失败 → 回退 GBK（Windows 中文环境 Excel 导出的 CSV 常见编码）
    return new TextDecoder('gbk').decode(asUint8(buf));
  }
}

// 状态机式 CSV 解析：正确处理引号包裹的字段（含逗号、转义引号 ""、内嵌换行）、CRLF
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; } // 转义引号 "" → "
        else { inQuotes = false; i++; }
      } else {
        field += ch;
        i++;
      }
    } else if (ch === '"' && field.length === 0) {
      inQuotes = true;
      i++;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++; // CRLF 视为一个换行
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      i++;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function csvToMarkdown(rows: string[][]): string {
  // 过滤全空行（含仅有空单元格的行）
  const dataRows = rows.filter(r => r.some(c => String(c).trim() !== ''));
  if (dataRows.length === 0) return '';
  const cleanCell = (c: string): string => {
    let s = String(c ?? '')
      .replace(/\r\n|\r|\n/g, ' ')   // 单元格内换行（CRLF/LF/CR）折叠为空格（Markdown 行内不允许换行）
      .replace(/[ \t]+/g, ' ')
      .trim();
    return s.replace(/\|/g, '\\|'); // 竖线转义，避免破坏表格结构
  };
  const colCount = Math.max(...dataRows.map(r => r.length));
  let md = '| ' + dataRows[0].map((_, i) => cleanCell(dataRows[0][i] ?? '')).join(' | ') + ' |\n';
  md += '|' + Array.from({ length: colCount }, () => '---').join('|') + '|\n';
  for (let i = 1; i < dataRows.length; i++) {
    const row = dataRows[i];
    const cells = Array.from({ length: colCount }, (_, j) => cleanCell(row[j] ?? ''));
    md += '| ' + cells.join(' | ') + ' |\n';
  }
  return md;
}

async function createFile(directoryPath: string, fileName: string): Promise<string | null> {
  try {
    if (!fs.existsSync(directoryPath)) {
      throw new Error(`目录 ${directoryPath} 不存在`);
    }

    const filePath = path.join(directoryPath, fileName);

    if (fs.existsSync(filePath)) {
      throw new Error(`文件 ${filePath} 已存在`);
    }

    fs.writeFileSync(filePath, '');
    return filePath;
  } catch (error) {
    console.error('创建文件失败:', error);
    return null;
  }
}

ipcMain.handle('createFile', async (event, directoryPath: string, fileName: string) => {
  return await createFile(directoryPath, fileName);
});

ipcMain.handle('createFolder', async (event, directoryPath: string, folderName: string) => {
  try {
    if (!fs.existsSync(directoryPath)) return null;
    const folderPath = path.join(directoryPath, folderName);
    if (fs.existsSync(folderPath)) return null;
    fs.mkdirSync(folderPath);
    return folderPath;
  } catch (error) {
    console.error('创建文件夹失败:', error);
    return null;
  }
});

// ==================== 文件复制 ====================

ipcMain.handle('copyFile', async (event, sourcePath: string, targetDir: string) => {
  try {
    if (!fs.existsSync(sourcePath)) {
      return { success: false, error: '源文件不存在' };
    }
    if (!fs.existsSync(targetDir)) {
      return { success: false, error: '目标文件夹不存在' };
    }

    const stats = fs.statSync(sourcePath);
    const baseName = path.basename(sourcePath);
    const ext = path.extname(baseName);
    const nameWithoutExt = path.basename(baseName, ext);

    // 生成不重复的目标路径
    let targetPath = path.join(targetDir, baseName);
    let counter = 1;
    while (fs.existsSync(targetPath)) {
      targetPath = path.join(targetDir, `${nameWithoutExt}_副本${counter}${ext}`);
      counter++;
    }

    if (stats.isDirectory()) {
      fs.cpSync(sourcePath, targetPath, { recursive: true });
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
    return { success: true, newPath: targetPath };
  } catch (error: any) {
    console.error('复制文件失败:', error);
    return { success: false, error: error.message };
  }
});

function getInf(filePath: string): any {
  try {
    const stats = fs.statSync(filePath);
    const type = stats.isDirectory() ? 'folder' : 'file';
    const label = path.basename(filePath);
    const extension = type === 'folder' ? 'folder' : path.extname(filePath);
    return { type, label, extension };
  } catch (error) {
    console.error(`Error getting file info for path ${filePath}:`, error);
    return null;
  }
}

ipcMain.handle('getInf', async (event, path: string) => {
  return await getInf(path);
});

// 删除到回收站（Windows/Linux/macOS 通用）：优先 shell.trashItem 移入系统回收站，
// 失败（如目标位于无回收站概念的盘符/远程挂载等）则退回永久删除
const trashOrDelete = async (targetPath: string): Promise<boolean> => {
  try {
    await shell.trashItem(targetPath)
    return true
  } catch (err) {
    console.warn(`[主进程] 移入回收站失败，退回永久删除: ${targetPath}`, err)
    return false
  }
}

ipcMain.handle('deleteFile', async (event, filePath) => {
  try {
    console.log(`[主进程] 收到删除文件请求: ${filePath}`)
    if (await trashOrDelete(filePath)) {
      console.log(`[主进程] 文件已移入回收站: ${filePath}`)
      return true
    }
    // 退回永久删除
    fs.unlinkSync(filePath)
    console.log(`[主进程] 文件删除成功: ${filePath}`)
    return true;
  } catch (err) {
    console.error(`[主进程] 删除文件失败: ${filePath}`, err);
    return false;
  }
});

ipcMain.handle('deleteFolder', async (event, folderPath) => {
  const deleteFolderRecursive = (folderPath: string) => {
    if (fs.existsSync(folderPath)) {
      fs.readdirSync(folderPath).forEach((file) => {
        const curPath = path.join(folderPath, file);
        if (fs.lstatSync(curPath).isDirectory()) {
          deleteFolderRecursive(curPath);
        } else {
          fs.unlinkSync(curPath);
        }
      });
      fs.rmdirSync(folderPath);
    }
  };

  try {
    // 优先整体移入回收站（shell.trashItem 支持目录）
    if (!(await trashOrDelete(folderPath))) {
      // 退回永久递归删除
      deleteFolderRecursive(folderPath);
    }
    return { success: true };
  } catch (error) {
    console.error('删除文件夹失败:', error);
    throw error;
  }
});

ipcMain.handle('isDirectory', (event, filePath) => {
  try {
    const stats = fs.statSync(filePath);
    return stats.isDirectory();
  } catch (error) {
    return false;
  }
});

ipcMain.handle('getRelativePath', (event, fromFile: string, toFile: string) => {
  try {
    const fromDir = path.dirname(fromFile);
    const relativePath = path.relative(fromDir, toFile);
    return relativePath.replace(/\\/g, '/');
  } catch (error) {
    console.error('getRelativePath error:', error);
    return null;
  }
});

ipcMain.handle('resolveRelativePath', (event, baseFile: string, relativePath: string) => {
  try {
    const baseDir = path.dirname(baseFile);
    const resolved = path.resolve(baseDir, relativePath.replace(/\//g, '\\'));
    return resolved;
  } catch (error) {
    console.error('resolveRelativePath error:', error);
    return null;
  }
});

ipcMain.handle('openInFolder', async (event, filePath) => {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`路径不存在: ${filePath}`);
    }
    shell.showItemInFolder(filePath);
    return true;
  } catch (error) {
    console.error('打开文件位置失败:', error);
    throw error;
  }
});

// 打开本机应用数据目录（设置页「常用操作 → 打开数据目录」）：
// userData 下有配置、缓存、会话日志、Word 预览图片缓存等，排障/备份时直接定位
ipcMain.handle('open-data-dir', async () => {
  const dir = app.getPath('userData');
  try {
    const err = await shell.openPath(dir);
    if (err) return { success: false, error: err, path: dir };
    return { success: true, path: dir };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e), path: dir };
  }
});

// 用系统默认应用打开文件（Excel/Word/PDF 等交给系统应用编辑/查看）
ipcMain.handle('openWithSystemApp', async (event, filePath: string) => {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: `路径不存在: ${filePath}` };
    }
    const err = await shell.openPath(filePath);
    if (err) {
      return { success: false, error: err };
    }
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('readFileBase64', async (event, filePath) => {
  try {
    const fileBuffer = fs.readFileSync(filePath)
    const base64 = fileBuffer.toString('base64')
    const ext = path.extname(filePath).toLowerCase()
    let mime = 'application/octet-stream'
    if (ext === '.pdf') mime = 'application/pdf'
    else if (ext === '.png') mime = 'image/png'
    else if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg'
    return `data:${mime};base64,${base64}`
  } catch (error: any) {
    return `Error reading file: ${error.message}`
  }
})

// 音视频/媒体扩展名：读取内容前先拦截，避免把数百 MB 的媒体文件整体按 UTF-8 读入内存
const MEDIA_EXT = new Set(['.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.3gp', '.ts', '.rm', '.rmvb', '.vob', '.mp3', '.wav', '.flac', '.aac', '.ogg', '.wma', '.m4a', '.opus', '.mid', '.midi', '.amr'])

/**
 * Word 预览图片的落盘目录（userData 下持久目录）。
 * 标签内容会持久化到 localStorage，图片必须以 file:/// 引用而非内联 base64，
 * 且目录需跨重启有效 —— 不能放系统临时目录。
 */
function docxMediaDir(): string {
  return join(app.getPath('userData'), DOCX_MEDIA_DIR_NAME)
}

ipcMain.handle('readFile', async (event, filePath) => {
  // 检查是否为目录，避免 EISDIR 错误
  try {
    if (fs.statSync(filePath).isDirectory()) {
      return `Error reading file: EISDIR: illegal operation on a directory, read '${filePath}'`;
    }
  } catch (e: any) {
    return `Error reading file: ${e.message}`;
  }
  
  const fileExtension = path.extname(filePath);
  
  if (fileExtension == ".md" || fileExtension == "" || fileExtension == ".kb") {
    try {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      return fileContent;
    } catch (error: any) {
      return `Error reading file: ${error.message}`;
    }
  } else if (fileExtension == ".docx") {
    try {
      // 统一走 office/docx-to-markdown：提取图片（落盘 file:/// 引用）、标题输出 atx（目录依赖）、
      // 表格输出管道表格、回填自动编号、OMML 公式转 LaTeX
      return await docxToMarkdown({ filePath, mediaDir: docxMediaDir() })
    } catch (err) {
      console.error(err);
      throw err;
    }
  } else if (fileExtension == ".pdf") {
    const result = await readPdf(filePath)
    return result
  } else if (fileExtension == ".xlsx" || fileExtension == ".xls") {
    try {
      const workbook = xlsx.readFile(filePath);
      let allMarkdownContent = '';

      workbook.SheetNames.forEach(sheetName => {
        const worksheet = workbook.Sheets[sheetName]
        const jsonData = xlsx.utils.sheet_to_json(worksheet, { header: 1 })
        const markdownContent = convertToMarkdown(jsonData)
        allMarkdownContent += `## ${sheetName}\n\n`
        allMarkdownContent += markdownContent + '\n\n'
      })
      return allMarkdownContent
    } catch (error: any) {
      return `Error reading Excel file: ${error.message}`;
    }
  } else if (fileExtension == ".html" || fileExtension == ".htm") {
    try {
      // 返回原始 HTML 内容（源码编辑视图需要完整代码；浏览视图通过 iframe 加载原始文件，不依赖此处文本）
      return fs.readFileSync(filePath, 'utf-8');
    } catch (error: any) {
      return `Error reading HTML file: ${error.message}`;
    }
  } else if (fileExtension == ".js" || fileExtension == ".javascript") {
    try {
      const jsContent = fs.readFileSync(filePath, 'utf-8');
      return jsContent;
    } catch (error: any) {
      return `Error reading JavaScript file: ${error.message}`;
    }
  } else if (fileExtension == ".py" || fileExtension == ".python") {
    try {
      const pyContent = fs.readFileSync(filePath, 'utf-8');
      return pyContent;
    } catch (error: any) {
      return `Error reading Python file: ${error.message}`;
    }
  } else if (fileExtension == ".txt") {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch (error: any) {
      return `Error reading text file: ${error.message}`;
    }
  } else if (fileExtension == ".json") {
    try {
      const jsonContent = fs.readFileSync(filePath, 'utf-8');
      try {
        const parsed = JSON.parse(jsonContent);
        return JSON.stringify(parsed, null, 2);
      } catch {
        return jsonContent;
      }
    } catch (error: any) {
      return `Error reading JSON file: ${error.message}`;
    }
  } else if (fileExtension == ".csv") {
    try {
      const buf = fs.readFileSync(filePath);
      return csvToMarkdown(parseCsv(decodeCsvBuffer(buf)));
    } catch (error: any) {
      return `Error reading CSV file: ${error.message}`;
    }
  } else if (MEDIA_EXT.has(fileExtension)) {
    // 音视频等媒体文件：不读取内容，避免整文件 UTF-8 解码造成卡顿与内存膨胀
    return `[媒体文件 - 不读取内容]`;
  } else {
    try {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      return `${fileContent}`;
    } catch (error: any) {
      return `不支持的文件格式：${fileExtension}\n错误信息：${error.message}`;
    }
  }
});

// ── 数据节点专用：流式读取 CSV/TSV/TXT（避免大数据整文件读入内存导致卡顿） ──
// 返回 { ok, total, headers, rows, size, truncated, tooLarge?, error? }
function streamDataRows(filePath: string, opts: {
  delimiter?: string
  hasHeader?: boolean
  maxRows?: number      // >0：仅加载前 N 行（提前停止读取）
  previewRows?: number  // 保留前 N 行作为预览（非 collectAll 模式）
  collectAll?: boolean  // 是否收集全部行（构建 batches 用）
}): Promise<{ ok: boolean; total: number; headers: string[]; rows: any[]; size: number; truncated: boolean; error?: string }> {
  return new Promise((resolve) => {
    const delimiter = (opts.delimiter || ',').charAt(0)
    const hasHeader = opts.hasHeader !== false
    const maxRows = Math.max(0, opts.maxRows || 0)
    const collectAll = !!opts.collectAll
    const previewRows = collectAll ? 0 : Math.max(0, opts.previewRows ?? 100)
    // 需要保留的行数：collectAll 时 = maxRows（0=全部）；否则 = previewRows
    const keepRows = collectAll ? maxRows : previewRows

    const headers: string[] = []
    const rows: any[] = []
    let total = 0
    let size = 0
    let firstRow = true
    let truncated = false
    let done = false
    const finish = (r: { ok: boolean; total: number; headers: string[]; rows: any[]; size: number; truncated: boolean; error?: string }) => {
      if (done) return
      done = true
      resolve(r)
    }

    let field = ''
    let row: string[] = []
    let inQuotes = false

    const flushRow = () => {
      row.push(field)
      field = ''
      // 去掉最后一个字段的尾部 \r（CRLF）
      if (row.length > 0 && row[row.length - 1].endsWith('\r')) {
        row[row.length - 1] = row[row.length - 1].slice(0, -1)
      }
      if (firstRow) {
        firstRow = false
        if (hasHeader) {
          if (row.length > 0 && row[0].charCodeAt(0) === 0xFEFF) row[0] = row[0].slice(1)
          headers.push(...row.map(h => h.trim()))
          row = []
          return
        }
      }
      total++
      if (keepRows === 0 || total <= keepRows) {
        if (headers.length > 0) {
          const o: Record<string, any> = {}
          headers.forEach((h, i) => { o[h] = row[i] !== undefined ? row[i] : '' })
          rows.push(o)
        } else {
          rows.push([...row])
        }
      }
      row = []
    }

    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
    // 注意：@types/node 20.19+ / TS6 下 'data' 参数类型为 string | Buffer（即使设置了 encoding），
    // 因此这里不能直接标注 chunk: string，需在回调解包成文本。
    stream.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
      size += Buffer.byteLength(text, 'utf-8')
      for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        if (inQuotes) {
          if (ch === '"') {
            if (text[i + 1] === '"') { field += '"'; i++ }
            else inQuotes = false
          } else field += ch
        } else {
          if (ch === '"') inQuotes = true
          else if (ch === delimiter) { row.push(field); field = '' }
          else if (ch === '\n') { flushRow() }
          else field += ch
        }
      }
      // maxRows>0 时提前停止读取（只加载前 N 行）
      if (maxRows > 0 && total >= maxRows) {
        truncated = true
        stream.destroy()
      }
    })
    stream.on('close', () => {
      // destroy() 触发的关闭：不再处理末尾残余
      finish({ ok: true, total, headers, rows, size, truncated })
    })
    stream.on('end', () => {
      if (field !== '' || row.length > 0) flushRow()
      finish({ ok: true, total, headers, rows, size, truncated })
    })
    stream.on('error', (e) => {
      finish({ ok: false, total: 0, headers: [], rows: [], size, truncated: false, error: e.message })
    })
  })
}

// 数据节点读取：流式统计/预览/收集
ipcMain.handle('readDataFile', async (event, payload) => {
  // 先归一化成 any 再解构：`any | {}` 这种联合类型做解构会触发 TS2525（每个被解构变量都报缺默认值）
  const input: any = (payload && typeof payload === 'object') ? payload : {}
  const { filePath, delimiter, hasHeader, maxRows, previewRows, collectAll } = input
  if (!filePath) return { ok: false, error: '缺少文件路径' }
  const ext = path.extname(filePath).toLowerCase()

  if (ext === '.json') {
    try {
      const stat = fs.statSync(filePath)
      if (stat.size > 5 * 1024 * 1024) {
        return { ok: true, total: -1, headers: [], rows: [], size: stat.size, tooLarge: true, error: 'JSON 文件过大，请改用 CSV，或使用 Python 节点/工具读取' }
      }
      const content = fs.readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(content)
      const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.rows) ? parsed.rows : [])
      const headers = list.length > 0 && typeof list[0] === 'object' && list[0] !== null ? Object.keys(list[0]) : []
      const limit = collectAll ? (maxRows > 0 ? maxRows : list.length) : Math.max(0, previewRows ?? 100)
      return { ok: true, total: list.length, headers, rows: list.slice(0, limit), size: stat.size, truncated: list.length > limit }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  }

  return streamDataRows(filePath, { delimiter, hasHeader, maxRows, previewRows, collectAll })
});

// 单独提取 Word 文档中的图片（独立于文字转 Markdown 的 readFile）
ipcMain.handle('extractWordImages', async (event, filePath) => {
  try {
    return await extractWordImages(filePath)
  } catch (error: any) {
    console.error('[主进程] 提取 Word 图片失败', error)
    return { error: error.message || '提取 Word 图片失败' }
  }
});

ipcMain.handle('openAndReadFile', async (event, type) => {
  const result = await dialog.showOpenDialog(win!, {
    title: '打开文件',
    filters: [{
      name: type,
      extensions: type,
    }],
    buttonLabel: '打开'
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const filePath = result.filePaths[0];
    try {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      return fileContent;
    } catch (error: any) {
      return `Error reading file: ${error.message}`;
    }
  } else {
    return "";
  }
});

ipcMain.handle('saveFile', async (event, filePath, fileContent) => {
  try {
    fs.writeFileSync(filePath, fileContent);
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
});

// 同步写盘：drawio 取消自动保存后，关窗前的 beforeunload 里要用同步 IPC 兜底落盘
// （异步 invoke 在窗口销毁后不保证执行）
ipcMain.on('saveFileSync', (event, filePath, fileContent) => {
  try {
    fs.writeFileSync(String(filePath), String(fileContent ?? ''), 'utf8');
    event.returnValue = true;
  } catch (error) {
    console.error('[saveFileSync] 写盘失败', error);
    event.returnValue = false;
  }
});

// ==================== drawio 内嵌编辑器的「导出 / 另存为」 ====================
// 编辑器的「文件 → 导出为 → 下载 / 设备」在内嵌模式下有两条内部路径，本应用里都会「点了没反应」：
//   ① EditorUi.prototype.doSaveLocalFile → 造 <a download href="blob:"> 交给浏览器下载：
//      Electron 会静默写进系统下载目录（不弹框、不提示）
//   ② window.showSaveFilePicker（设备 / 另存为到设备）→ File System Access API：
//      Electron 只有 API 外壳、没接原生选择框，Promise 永不 settle（直接挂死）
// 渲染层（Drawio.vue + src/shared/drawioExportBridge.ts）把 ① 改为调用下面三个 IPC 弹原生「另存为」，
// ② 覆写成同一套 IPC；另外再加 will-download 兜底，万一仍走了浏览器下载也不会静默丢文件。

/** 当前打开的 .drawio 文件所在目录（渲染层同步，作为导出/下载的默认落地目录） */
let drawioExportDir = '';

/** 写盘：content 为文本、base64 为二进制（base64 可带 data URI 前缀） */
function writeExportFile(filePath: string, content?: string, base64?: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  if (typeof base64 === 'string' && base64.length > 0) {
    const pure = base64.includes('base64,') ? base64.slice(base64.indexOf('base64,') + 7) : base64
    fs.writeFileSync(filePath, Buffer.from(pure, 'base64'))
  } else {
    fs.writeFileSync(filePath, String(content ?? ''), 'utf8')
  }
}

/** 目标文件已存在时追加 (1)、(2)…（导入/下载兜底路径使用，避免静默覆盖） */
function uniqueFilePath(filePath: string): string {
  if (!fs.existsSync(filePath)) return filePath
  const dir = path.dirname(filePath)
  const ext = path.extname(filePath)
  const base = path.basename(filePath, ext)
  for (let i = 1; i < 1000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`)
    if (!fs.existsSync(candidate)) return candidate
  }
  return filePath
}

ipcMain.handle('drawio-export-dir', async (_event, dir) => {
  drawioExportDir = String(dir || '')
  return true
})

// 弹「另存为」并写盘（drawio 的下载 / 设备导出走这里）
ipcMain.handle('drawio-export-save', async (event, payload) => {
  const { defaultPath, title, filters, content, base64 } = payload || {}
  const parent = BrowserWindow.fromWebContents(event.sender) || win
  const opts: Electron.SaveDialogOptions = {
    title: title || undefined,
    defaultPath: String(defaultPath || 'export.drawio'),
    filters: Array.isArray(filters) && filters.length ? filters : [{ name: 'All Files', extensions: ['*'] }],
  }
  const result = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts)
  if (result.canceled || !result.filePath) return { canceled: true }
  try {
    writeExportFile(result.filePath, content, base64)
    return { canceled: false, path: result.filePath }
  } catch (e: any) {
    console.error('[drawio-export] 写盘失败', e)
    return { canceled: false, error: String(e?.message || e) }
  }
})

// 只弹对话框拿路径（showSaveFilePicker 桥接用；数据稍后再 write）
ipcMain.handle('drawio-export-pick', async (event, payload) => {
  const { defaultPath, title, filters } = payload || {}
  const parent = BrowserWindow.fromWebContents(event.sender) || win
  const opts: Electron.SaveDialogOptions = {
    title: title || undefined,
    defaultPath: String(defaultPath || 'untitled.drawio'),
    filters: Array.isArray(filters) && filters.length ? filters : [{ name: 'All Files', extensions: ['*'] }],
  }
  const result = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts)
  if (result.canceled || !result.filePath) return { canceled: true }
  return { canceled: false, path: result.filePath }
})

// 往已确定路径写内容（showSaveFilePicker 的 createWritable().close() 走这里）
ipcMain.handle('drawio-export-write', async (_event, payload) => {
  const { path: target, content, base64 } = payload || {}
  if (!target) return { ok: false, error: '缺少目标路径' }
  try {
    writeExportFile(String(target), content, base64)
    return { ok: true, path: String(target) }
  } catch (e: any) {
    console.error('[drawio-export] 写入失败', e)
    return { ok: false, error: String(e?.message || e) }
  }
})

/**
 * 下载兜底：Electron 默认把页面发起的下载静默写进系统下载目录（不弹框、不提示）。
 * 落到「当前图表所在目录」（没有则系统下载目录），完成后再告知渲染层提示用户。
 * 正常情况走不到这里 —— drawio 的导出已被上面的 IPC 接管。
 */
function setupDownloadFallback(): void {
  const onWillDownload = (_event: any, item: any, webContents: any) => {
    const name = String(item.getFilename() || 'download')
    const dir = drawioExportDir && fs.existsSync(drawioExportDir) ? drawioExportDir : app.getPath('downloads')
    const target = uniqueFilePath(path.join(dir, name))
    try {
      item.setSavePath(target)
    } catch (e) {
      console.warn('[download] setSavePath 失败，改用 Electron 默认行为', e)
      return
    }
    console.log('[download] 保存到', target)
    item.once('done', (_e: any, state: string) => {
      console.log(`[download] ${state} -> ${target}`)
      if (state === 'completed' && webContents && !webContents.isDestroyed()) {
        webContents.send('app-download-done', { path: target, name })
      }
    })
  }
  session.defaultSession.on('will-download', onWillDownload)
  app.on('session-created', (sess) => sess.on('will-download', onWillDownload))
}

// ==================== drawio 图表 → PDF / 打印（本地打印通道） ====================
// drawio 内嵌模式的「导出为 → PDF」会把 SVG 上传到它的云端导出服务换 PDF（离线直接失败），
// 「文件 → 打印」则调 window.print()（Electron 下什么都不发生）。
// 两者都在渲染层被截住（src/shared/drawioExportBridge.ts），把当前页 SVG 传到这里：
// 隐藏窗口渲染 SVG → printToPDF（存成 PDF 文件）或 print()（系统打印对话框）。
// 注意：只能拿「当前页」——内嵌协议没有切换页面导出的能力。

/** SVG 根元素的像素尺寸（drawio 导出带 width/height，兜底读 viewBox） */
function svgSizePx(svg: string): { w: number; h: number } {
  const unit = (raw?: string) => {
    if (!raw) return 0
    const n = parseFloat(raw)
    if (!Number.isFinite(n)) return 0
    return /pt/i.test(raw) ? (n * 96) / 72 : n
  }
  const w = unit(/\bwidth="([\d.]+(?:pt|px)?)"/i.exec(svg)?.[1])
  const h = unit(/\bheight="([\d.]+(?:pt|px)?)"/i.exec(svg)?.[1])
  if (w > 0 && h > 0) return { w, h }
  const vb = /viewBox="\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*"/i.exec(svg)
  if (vb) return { w: parseFloat(vb[1]) || 0, h: parseFloat(vb[2]) || 0 }
  return { w: 0, h: 0 }
}

/** 把图表 SVG 包成「页面尺寸 = 图形尺寸 + 边距」的可打印 HTML（preferCSSPageSize 生效） */
function buildDiagramHtml(svg: string): string {
  const pad = 24
  const size = svgSizePx(svg)
  const w = Math.max(200, Math.round((size.w || 800) + pad * 2))
  const h = Math.max(200, Math.round((size.h || 600) + pad * 2))
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: ${w}px ${h}px; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
.dg { box-sizing: border-box; padding: ${pad}px; }
.dg > svg { display: block; }
</style></head><body><div class="dg">${svg}</div></body></html>`
}

/** 隐藏窗口渲染 HTML 并执行动作（导出 PDF / 打印）；独立 partition 避免应用缩放影响 */
async function withPrintWindow<T>(
  html: string,
  fn: (wc: Electron.WebContents) => Promise<T>,
  offscreen = true,
): Promise<T> {
  const tmpFile = path.join(app.getPath('temp'), `drawio-print-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`)
  let printWin: BrowserWindow | null = null
  try {
    fs.writeFileSync(tmpFile, html, 'utf-8')
    printWin = new BrowserWindow({
      show: false,
      width: 900,
      height: 1200,
      webPreferences: { offscreen, partition: 'pdf-export' },
    })
    excludeFromAppZoom(printWin)
    await printWin.loadFile(tmpFile)
    return await fn(printWin.webContents)
  } finally {
    if (printWin && !printWin.isDestroyed()) printWin.destroy()
    try {
      fs.unlinkSync(tmpFile)
    } catch {
      /* ignore */
    }
  }
}

// drawio「导出为 → PDF」：本地打印通道（printToPDF），离线可用
ipcMain.handle('drawio-export-pdf', async (event, payload) => {
  const { defaultPath, title, svg } = payload || {}
  if (!svg) return { error: '缺少图表内容' }
  const parent = BrowserWindow.fromWebContents(event.sender) || win
  const opts: Electron.SaveDialogOptions = {
    title: title || '导出为 PDF',
    defaultPath: String(defaultPath || 'diagram.pdf'),
    filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
  }
  const result = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts)
  if (result.canceled || !result.filePath) return { canceled: true }
  try {
    const html = buildDiagramHtml(String(svg))
    const pdfData = await withPrintWindow(html, (wc) => wc.printToPDF({ printBackground: true, preferCSSPageSize: true }))
    fs.writeFileSync(result.filePath, asUint8(pdfData))
    return { canceled: false, path: result.filePath }
  } catch (e: any) {
    console.error('[drawio-pdf] 导出失败', e)
    return { canceled: false, error: String(e?.message || e) }
  }
})

// drawio「文件 → 打印」：本地打印通道（系统打印对话框）
ipcMain.handle('drawio-export-print', async (_event, payload) => {
  const { svg } = payload || {}
  if (!svg) return { error: '缺少图表内容' }
  try {
    const html = buildDiagramHtml(String(svg))
    await withPrintWindow(
      html,
      (wc) =>
        new Promise<void>((resolve) => {
          wc.print({ silent: false, printBackground: true }, (ok, failureReason) => {
            if (!ok) console.warn('[drawio-print] 打印未完成:', failureReason)
            resolve()
          })
        }),
      false,
    )
    return { ok: true }
  } catch (e: any) {
    console.error('[drawio-print] 打印失败', e)
    return { error: String(e?.message || e) }
  }
})

// 远程文件下载：把渲染进程传来的字节数组写入目标目录
ipcMain.handle('saveRemoteDownload', async (event, payload) => {
  try {
    const dir = payload?.dir
    const name = payload?.name
    const data = payload?.data
    if (!dir || !name || !Array.isArray(data)) {
      return { success: false, error: '参数无效' }
    }
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return { success: false, error: '目标目录不存在' }
    }
    const target = join(dir, name)
    fs.writeFileSync(target, asUint8(Buffer.from(data)))
    return { success: true, path: target }
  } catch (error: any) {
    return { success: false, error: error?.message || '保存失败' }
  }
});

// 远程 Word(.docx) 预览：接收 base64，主进程用 mammoth 转 HTML 后再转 Markdown
ipcMain.handle('docxToMarkdown', async (_event, payload: { base64?: string }) => {
  try {
    const base64 = payload?.base64
    if (!base64) return { error: '参数无效' }
    const buf = Buffer.from(base64, 'base64')
    // 与本地 readFile 的 .docx 分支完全同款实现（图片落盘 / atx 标题 / 管道表格 / 编号回填 / 公式 LaTeX）
    return await docxToMarkdown({ buffer: buf, mediaDir: docxMediaDir() })
  } catch (error: any) {
    console.error('[docxToMarkdown] 转换失败:', error)
    return { error: error?.message || 'Word 转换失败' }
  }
});

ipcMain.on('openTreePath', function (event, p) {
  dialog.showOpenDialog({
    properties: [p],
    title: '请选择位置，并读取树形关系',
    buttonLabel: '选择'
  }).then(result => {
    event.sender.send('selectedTreePath', result)
  })
})

ipcMain.on('closeWindow', () => {
  app.quit()
})

ipcMain.on('restartApp', () => {
  app.relaunch()
  app.quit()
})

ipcMain.handle('openByApp', async (event, path) => {
  const isWindows = process.platform === 'win32';
  if (isWindows) {
    if (path != "") {
      fs.exists(path, (exists: any) => {
        if (exists) shell.openPath(path)
      })
    }
  }
});

// 获取网页 <title>，用于显示联网搜索结果的网页标题（后台调用，失败返回空串）
ipcMain.handle('fetchWebPageTitle', async (event, url: string) => {
  try {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return ''
    const res = await net.fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      },
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) return ''
    const html = await res.text()
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    if (titleMatch && titleMatch[1]) {
      return titleMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200)
    }
    return ''
  } catch (e) {
    return ''
  }
})

ipcMain.on('dev', () => {
  if (win!.webContents.isDevToolsOpened()) {
    win!.webContents.closeDevTools();
  } else {
    win!.webContents.openDevTools({ mode: "undocked", activate: true });
  }
})

ipcMain.handle('openFile', async (event) => {
  const result = await dialog.showOpenDialog(win!, {
    properties: ['openFile']
  })

  if (!result.canceled && result.filePaths.length > 0) {
    const filePath = result.filePaths[0]
    const content = fs.readFileSync(filePath, 'utf-8')
    return { content, filePath }
  }

  return { content: null, filePath: null }
})

ipcMain.handle('showDialog', async (event, options) => {
  const result = await dialog.showMessageBox(options);
  return result;
});

ipcMain.handle('readFileBinary', async (event, filePath) => {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`文件不存在: ${filePath}`)
    }
    const fileBuffer = fs.readFileSync(filePath)
    return new Uint8Array(fileBuffer)
  } catch (error) {
    console.error('读取二进制文件失败:', error)
    return null
  }
})

ipcMain.handle('search', async (event, path, filterText) => {
  return search(path, filterText)
});

async function search(storePath: string, filterText: string, dirPath: string = storePath, results: any[] = [], floor: number = 1): Promise<any[]> {
  if (floor > 10) return results
  let filterTexts = filterText.split(" ")
  if (filterTexts.indexOf("") > -1) {
    filterTexts.splice(filterTexts.indexOf(""), 1)
  }

  let list = await fs.promises.readdir(dirPath)

  for (let itemPath of list) {
    const fullPath = path.join(dirPath, itemPath)
    const fileStat = await fs.promises.stat(fullPath)
    const isFile = fileStat.isFile()
    const dir = {
      label: path.basename(itemPath),
      path: path.join(dirPath, itemPath),
      extension: path.extname(itemPath),
    } as any

    if (!isFile) {
      await search(storePath, filterText, fullPath, results, floor + 1)
    }

    let nameCount = 0
    for (let i = 0; i < filterTexts.length; i++) {
      if (dir.label.indexOf(filterTexts[i]) > -1) {
        nameCount++
      }
    }

    let contentArr = []
    let length = 12

    if (dir.extension == ".md") {
      dir.content = await fs.readFileSync(path.join(dirPath, itemPath), 'utf-8')

      let count = 0
      for (let i = 0; i < filterTexts.length; i++) {
        if (dir.content.indexOf(filterTexts[i]) > -1) {
          count++
        }
      }

      if (count >= filterTexts.length) {
        let index = 0
        let num = 0
        while (index != -1) {
          num++
          let nextIndex = Infinity

          for (let i = 0; i < filterTexts.length; i++) {
            if (dir.content.indexOf(filterTexts[i], index) > -1 && dir.content.indexOf(filterTexts[i], index) < nextIndex) {
              nextIndex = dir.content.indexOf(filterTexts[i], index)
            }
          }

          if (nextIndex == Infinity || nextIndex == index) {
            break
          } else if (nextIndex > index) {
            let str = dir.content.slice(Math.max(0, nextIndex - length), Math.min(dir.content.length, nextIndex + length))
            contentArr.push(str)
            index = nextIndex + length
          }
        }
        dir.arr = contentArr
      }
    }

    if (nameCount >= filterTexts.length || contentArr.length > 0) {
      results.push(dir)
    }
  }

  return results
}

// ==================== Python 相关 ====================

ipcMain.handle('installPythonPackageWithEnvironment', async (event, { packageName, environment = 'safe' }) => {
  try {
    let result
    if (environment === 'trusted') {
      result = await trustedPythonService.installPackage(packageName)
    } else {
      result = await pythonService.installPackage(packageName)
    }
    return result
  } catch (error: any) {
    return {
      success: false,
      message: `安装包 ${packageName} 失败: ${error.message}`,
      error: error.message
    }
  }
})

ipcMain.handle('listPythonPackagesWithEnvironment', async (event, environment = 'safe') => {
  try {
    let result
    if (environment === 'trusted') {
      result = await trustedPythonService.listPackages()
    } else {
      result = await pythonService.listPackages()
    }
    return result
  } catch (error: any) {
    return {
      success: false,
      error: error.message
    }
  }
})

ipcMain.handle('executePython', async (event, params) => {
  console.log('[主进程] 收到 executePython 请求')
  
  try {
    if (!params) {
      console.error('[主进程] 错误: 参数为空')
      return {
        success: false,
        error: '参数不能为空',
        timestamp: Date.now()
      }
    }
    
    const { code, environment, cwd } = params
    console.log(`[主进程] 环境: ${environment}, 代码长度: ${code?.length || 0}`)
    
    if (!code || typeof code !== 'string') {
      return {
        success: false,
        error: '代码内容不能为空',
        timestamp: Date.now()
      }
    }
    
    // 归一化沙箱模式：统一策略解析（三态字符串 'safe'/'workspace'/'trusted'，
    // 兼容旧 boolean（true=trusted, false=safe）；未知输入 fail-closed 到 safe）
    const policy = resolvePolicy(environment, { workspaceRoot: cwd })
    const sandboxMode = policy.mode
    
    console.log(`[主进程] 沙箱模式: ${sandboxMode}（enforcement: ${policy.enforcement}）`)
    try {
      // trusted → 直接执行；safe/workspace → 安全检查（workspace 放行文件写入与网络）
      const result = sandboxMode === 'trusted'
        ? await trustedPythonService.executeCode(code, '', cwd)
        : await pythonService.executeCode(code, '', cwd, sandboxMode)
      
      console.log(`[主进程] ${sandboxMode} 环境执行完成:`, {
        success: result.success,
        outputLength: result.output?.length || 0,
        error: result.error?.substring(0, 100) || '无错误'
      })
      return {
        success: result.success,
        result: result.result,
        output: result.output,
        error: result.error,
        logs: result.logs,
        executionTime: result.executionTime,
        rawOutput: result.rawOutput,
        // Python 进程的工作目录（默认 store.root，未提供时为主进程 cwd）
        cwd: cwd || process.cwd(),
        // 沙箱策略报告（路线图 2.5：统一策略解析 + enforcement 报告）
        sandbox: policy,
      }
    } catch (error: any) {
      console.error(`[主进程] ${sandboxMode} 环境执行异常:`, error)
      return {
        success: false,
        error: `${sandboxMode} 环境执行异常: ${error.message}`,
        stack: error.stack,
        timestamp: Date.now()
      }
    }
  } catch (error: any) {
    console.error('[主进程] IPC处理器异常:', error)
    return {
      success: false,
      error: `IPC处理器异常: ${error.message}`,
      stack: error.stack,
      timestamp: Date.now()
    }
  }
})

ipcMain.handle('executeShell', async (event, params) => {
  console.log('[主进程] 收到 executeShell 请求')
  try {
    const { command, cwd, environment } = params || {}
    if (!command || typeof command !== 'string') {
      return { success: false, error: '命令不能为空' }
    }
    // 沙箱策略统一（路线图 2.5）：shell 是最高危执行面，仅 trusted 放行（fail-closed）
    const policy = resolvePolicy(environment, { workspaceRoot: cwd })
    if (!isShellAllowed(policy)) {
      const msg = `shell 执行被沙箱策略拒绝：当前模式 ${policy.mode}（enforcement: ${policy.enforcement}）。` +
        `仅「完全访问（trusted）」模式允许执行 shell 命令，请在设置 → 环境 中切换。`
      console.warn(`[主进程] ${msg}`)
      return { success: false, error: msg, sandbox: policy, denied: true }
    }
    const result = await shellService.executeCommand(command, cwd)
    console.log('[主进程] shell 执行完成:', {
      success: result.success,
      stdoutLength: result.stdout?.length || 0,
      stderrLength: result.stderr?.length || 0,
      exitCode: result.exitCode,
      executionTime: result.executionTime
    })
    return {
      ...result,
      // 工作目录（默认工作区根目录，未提供时为主进程 cwd）
      cwd: cwd || process.cwd(),
      sandbox: policy,
    }
  } catch (error: any) {
    console.error('[主进程] shell 执行异常:', error)
    return { success: false, error: `shell 执行异常: ${error.message}` }
  }
})

// ==================== 工作区文本搜索（供 agent search_files 工具，借鉴 Codex code_search / grep） ====================
// 默认跳过依赖/构建/版本控制目录，避免搜索结果被污染
const SEARCH_IGNORE_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'dist-electron', 'release', '.vscode', '.idea', '__pycache__', '.venv', 'venv', 'out', 'build', 'coverage', 'target', 'miniprogram_npm', '.mypy_cache', '.pytest_cache'])
const SEARCH_BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.rar', '.7z', '.exe', '.dll', '.so', '.dylib', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp4', '.mp3', '.wav', '.db', '.sqlite', '.node', '.wasm'])

ipcMain.handle('searchInWorkspace', async (event, params) => {
  try {
    const { root, query, path: subPath, filePattern, maxResults = 30, matchFileName = true, maxFileSizeMB = 2 } = params || {}
    if (!root || typeof root !== 'string') return { success: false, error: '缺少工作区根目录 root' }
    if (!query || typeof query !== 'string' || !query.trim()) return { success: false, error: '缺少搜索关键词 query' }
    const results = await searchTextInWorkspace(root, query.trim(), {
      subPath, filePattern, maxResults, matchFileName, maxFileSizeMB
    })
    return { success: true, results }
  } catch (error: any) {
    console.error('[主进程] searchInWorkspace 异常:', error)
    return { success: false, error: `搜索异常: ${error.message}` }
  }
})

// 递归遍历工作区，返回匹配 query 的文件/行（内容匹配为主，文件名匹配为补充）
async function searchTextInWorkspace(
  root: string,
  query: string,
  opts: { subPath?: string; filePattern?: string; maxResults?: number; matchFileName?: boolean; maxFileSizeMB?: number }
): Promise<any[]> {
  const baseDir = opts.subPath ? path.join(root, opts.subPath) : root
  if (!fs.existsSync(baseDir)) return []
  const results: any[] = []
  const maxResults = opts.maxResults || 30
  const maxFileSize = (opts.maxFileSizeMB || 2) * 1024 * 1024
  const queryLower = query.toLowerCase()

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 12 || results.length >= maxResults) return
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (results.length >= maxResults) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SEARCH_IGNORE_DIRS.has(entry.name)) continue
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      // 扩展名过滤
      const ext = path.extname(entry.name).toLowerCase()
      if (opts.filePattern) {
        const pattern = opts.filePattern.toLowerCase().replace(/^\./, '')
        if (ext !== '.' + pattern) continue
      }
      if (SEARCH_BINARY_EXT.has(ext)) continue
      const rel = path.relative(root, full).split(path.sep).join('/')

      // 内容匹配（逐行）
      let contentMatched = false
      try {
        const stat = await fs.promises.stat(full)
        if (stat.size <= maxFileSize) {
          const content = await fs.promises.readFile(full, 'utf8')
          const lines = content.split(/\r?\n/)
          for (let i = 0; i < lines.length; i++) {
            if (results.length >= maxResults) return
            const line = lines[i]
            if (line.toLowerCase().includes(queryLower)) {
              contentMatched = true
              results.push({
                file: rel,
                type: 'content',
                lineNumber: i + 1,
                line: line.substring(0, 400),
                preview: line.trim().substring(0, 200),
                matches: 1
              })
            }
          }
        }
      } catch {
        // 忽略二进制/编码读取失败
      }
      // 文件名匹配（内容未命中时补充，帮助定位）
      if (!contentMatched && opts.matchFileName !== false && entry.name.toLowerCase().includes(queryLower)) {
        if (results.length >= maxResults) return
        results.push({ file: rel, type: 'filename', lineNumber: 0, line: '', preview: entry.name, matches: 1 })
      }
    }
  }

  await walk(baseDir, 0)
  return results.slice(0, maxResults)
}

ipcMain.handle('checkPythonInstallation', async () => {
  return await pythonService.checkInstallation()
})

ipcMain.handle('validatePythonCode', async (event, code) => {
  return pythonService.validateCodeSecurity(code)
})

// ==================== Agent Skills 功能 ====================
// 技能多根发现与变更监听由 skill-service 统一管理（docs/subsystems/skills.md）：
// loadSkills 委托 skillService（兼容 string | string[] 传参，行为不变），
// 目录变更经 skill:change 事件推送给渲染进程。

ipcMain.handle('loadSkills', async (event, skillsPath) => {
  try {
    const roots = Array.isArray(skillsPath) ? skillsPath : [skillsPath]
    skillService.setRoots(roots)
    return skillService.list()
  } catch (error) {
    console.error('加载技能失败:', error)
    throw error
  }
})

ipcMain.handle('previewSkill', async (event, skillPath) => {
  try {
    const skillMdPath = path.join(skillPath, 'SKILL.md')
    if (!fs.existsSync(skillMdPath)) {
      throw new Error('SKILL.md 不存在')
    }
    
    const content = fs.readFileSync(skillMdPath, 'utf8')
    const metadata = parseSkillMetadata(content)
    
    const files = fs.readdirSync(skillPath).filter(f => {
      const filePath = path.join(skillPath, f)
      return fs.statSync(filePath).isFile()
    })
    
    return {
      metadata: metadata || {},
      content: content,
      files: files
    }
  } catch (error) {
    console.error('预览技能失败:', error)
    throw error
  }
})

ipcMain.handle('getSkillFile', async (event, skillPath, filename) => {
  try {
    const filePath = path.join(skillPath, filename)
    const realSkillPath = fs.realpathSync(skillPath)
    const realFilePath = fs.realpathSync(filePath)
    
    if (!realFilePath.startsWith(realSkillPath)) {
      throw new Error('不允许访问技能文件夹外的文件')
    }
    
    if (!fs.existsSync(filePath)) {
      throw new Error('文件不存在')
    }
    
    const stats = fs.statSync(filePath)
    if (stats.isDirectory()) {
      throw new Error('不能读取文件夹')
    }
    
    const ext = path.extname(filePath).toLowerCase()
    if (ext === '.py' || ext === '.js' || ext === '.json' || ext === '.txt' || ext === '.md') {
      const content = fs.readFileSync(filePath, 'utf8')
      return { type: 'text', content }
    } else {
      return { type: 'binary', path: filePath }
    }
  } catch (error) {
    console.error('读取技能文件失败:', error)
    throw error
  }
})

ipcMain.handle('executeSkillScript', async (event, skillPath, scriptName, args = []) => {
  try {
    const scriptPath = path.join(skillPath, 'scripts', scriptName)
    const realSkillPath = fs.realpathSync(skillPath)
    const realScriptPath = fs.realpathSync(scriptPath)
    
    if (!realScriptPath.startsWith(realSkillPath)) {
      throw new Error('不允许执行技能文件夹外的脚本')
    }
    
    if (!fs.existsSync(scriptPath)) {
      throw new Error('脚本不存在')
    }
    
    const stats = fs.statSync(scriptPath)
    if (stats.isDirectory()) {
      throw new Error('不能执行文件夹')
    }
    
    const ext = path.extname(scriptPath).toLowerCase()
    
    if (ext === '.py') {
      const code = fs.readFileSync(scriptPath, 'utf8')
      const result = await pythonService.executeCode(code)
      return result
    } else if (ext === '.js') {
      const code = fs.readFileSync(scriptPath, 'utf8')
      try {
        const func = new Function('args', code)
        const result = func(args)
        return { success: true, result }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    } else if (ext === '.sh' || ext === '.bat') {
      const { exec } = require('child_process')
      return new Promise((resolve) => {
        exec(`"${scriptPath}" ${args.join(' ')}`, (error: any, stdout: any, stderr: any) => {
          if (error) {
            resolve({ success: false, error: error.message, stderr })
          } else {
            resolve({ success: true, output: stdout })
          }
        })
      })
    } else {
      throw new Error(`不支持的脚本类型: ${ext}`)
    }
  } catch (error: any) {
    console.error('执行技能脚本失败:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('writeFile', async (event, filePath, content) => {
  console.log(`[主进程] 收到写入文件请求: ${filePath}`)
  
  try {
    if (!filePath) {
      throw new Error('文件路径不能为空')
    }
    
    const directory = path.dirname(filePath)
    if (!fs.existsSync(directory)) {
      console.log(`[主进程] 目录不存在，创建目录: ${directory}`)
      fs.mkdirSync(directory, { recursive: true })
    }
    
    fs.writeFileSync(filePath, content, 'utf8')
    
    console.log(`[主进程] 文件写入成功: ${filePath}`)
    return {
      success: true,
      path: filePath
    }
  } catch (error: any) {
    console.error(`[主进程] 写入文件失败: ${filePath}`, error)
    return {
      success: false,
      error: error.message
    }
  }
})

ipcMain.handle('ensureDir', async (event, dirPath) => {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true })
      console.log(`[主进程] 目录创建成功: ${dirPath}`)
    }
    return { success: true }
  } catch (error: any) {
    console.error(`[主进程] 创建目录失败: ${dirPath}`, error)
    return { success: false, error: error.message }
  }
})

// ==================== 文件重命名 ====================

ipcMain.handle('renameFile', async (event, oldPath: string, newName: string) => {
  try {
    if (!fs.existsSync(oldPath)) {
      return { success: false, error: '文件不存在' };
    }

    const dir = path.dirname(oldPath);
    const newPath = path.join(dir, newName);

    if (fs.existsSync(newPath)) {
      return { success: false, error: '目标文件已存在' };
    }

    fs.renameSync(oldPath, newPath);
    return { success: true, newPath };
  } catch (error: any) {
    console.error('重命名失败:', error);
    return { success: false, error: error.message };
  }
});

// ==================== 文件移动（拖拽） ====================

ipcMain.handle('moveFile', async (event, sourcePath: string, targetDir: string) => {
  try {
    if (!fs.existsSync(sourcePath)) {
      return { success: false, error: '源文件不存在' };
    }
    if (!fs.existsSync(targetDir)) {
      return { success: false, error: '目标文件夹不存在' };
    }

    const fileName = path.basename(sourcePath);
    const newPath = path.join(targetDir, fileName);

    if (fs.existsSync(newPath)) {
      return { success: false, error: '目标位置已存在同名文件' };
    }

    fs.renameSync(sourcePath, newPath);
    return { success: true, newPath };
  } catch (error: any) {
    console.error('移动文件失败:', error);
    return { success: false, error: error.message };
  }
});

// ==================== 文件系统监听 ====================

let watchers: fs.FSWatcher[] = [];
let watchTimeout: NodeJS.Timeout | null = null;

// 关闭所有文件夹监听
function closeAllWatchers() {
  for (const w of watchers) {
    try { w.close(); } catch (_) {}
  }
  watchers = [];
}

// 启动文件夹监听（支持单个路径或路径数组：多工作区）
ipcMain.handle('startWatching', async (event, folderPath: string | string[]) => {
  try {
    // 停止之前的监听
    closeAllWatchers();

    const paths = (Array.isArray(folderPath) ? folderPath : [folderPath])
      .filter((p: string) => p && fs.existsSync(p));
    if (!paths.length) {
      return { success: true };
    }

    for (const p of paths) {
      const w = fs.watch(p, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        // 工作区有变更：使该根目录的树缓存失效，下次刷新重新扫描
        treeCache.delete(p);

        // 防抖：避免短时间内多次触发
        if (watchTimeout) {
          clearTimeout(watchTimeout);
        }
        watchTimeout = setTimeout(() => {
          // 通知渲染进程文件系统变化
          if (win && !win.isDestroyed()) {
            win.webContents.send('fileSystemChanged', {
              type: eventType,
              file: filename,
              folder: p
            });
          }
          watchTimeout = null;
        }, 300);
      });
      watchers.push(w);
    }

    return { success: true };
  } catch (error: any) {
    console.error('启动文件监听失败:', error);
    return { success: false, error: error.message };
  }
});

// 停止文件监听
ipcMain.handle('stopWatching', async () => {
  try {
    closeAllWatchers();
    if (watchTimeout) {
      clearTimeout(watchTimeout);
      watchTimeout = null;
    }
    // 树缓存跨面板切换保留：重开时由顶层签名 + 目录 mtime 指纹廉价校验，
    // 数据未变则直接命中缓存，避免每次切换都全量重扫数万文件并整树回传
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

// ==================== 单文件变更监听（用于预览自动刷新） ====================

let fileWatcher: fs.FSWatcher | null = null
let fileWatchPath: string | null = null
let fileWatchTimeout: NodeJS.Timeout | null = null

ipcMain.handle('watchFile', async (event, filePath: string) => {
  try {
    // 停止之前的监听
    if (fileWatcher) {
      fileWatcher.close()
      fileWatcher = null
    }
    fileWatchPath = null

    if (!filePath || !fs.existsSync(filePath)) {
      return { success: false, error: '文件不存在' }
    }

    // 记录文件的初始 mtime，避免保存时自己触发
    let lastMtime = fs.statSync(filePath).mtimeMs

    fileWatcher = fs.watch(filePath, (eventType) => {
      if (eventType !== 'change') return

      // 防抖
      if (fileWatchTimeout) clearTimeout(fileWatchTimeout)
      fileWatchTimeout = setTimeout(() => {
        try {
          if (!fs.existsSync(filePath)) return
          const currentMtime = fs.statSync(filePath).mtimeMs
          // 只有 mtime 变化才通知（避免重复触发）
          if (currentMtime !== lastMtime) {
            lastMtime = currentMtime
            if (win && !win.isDestroyed()) {
              win.webContents.send('watchedFileChanged', { path: filePath })
            }
          }
        } catch (_) {}
        fileWatchTimeout = null
      }, 200)
    })

    fileWatchPath = filePath
    return { success: true }
  } catch (error: any) {
    console.error('启动文件监听失败:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('unwatchFile', async () => {
  try {
    if (fileWatcher) {
      fileWatcher.close()
      fileWatcher = null
    }
    if (fileWatchTimeout) {
      clearTimeout(fileWatchTimeout)
      fileWatchTimeout = null
    }
    fileWatchPath = null
    return { success: true }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

// 刷新文件树（单工作区）
ipcMain.handle('refreshTree', async (event, folderPath: string) => {
  try {
    if (!folderPath || !fs.existsSync(folderPath)) {
      return { success: false, error: '文件夹不存在' };
    }
    const tree = [getDirectoryTree(folderPath)];
    return { success: true, tree };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

// 刷新多个工作区文件树（多工作区支持）
ipcMain.handle('refreshMultiTree', async (event, folderPaths: string[], knownVersion?: number) => {
  try {
    const paths = (Array.isArray(folderPaths) ? folderPaths : [])
      .filter((p: string) => p && fs.existsSync(p));
    // 快速路径：所有根缓存仍有效且渲染端版本一致 → 数据未变，跳过整棵树回传
    if (typeof knownVersion === 'number') {
      const allValid = await Promise.all(paths.map((p: string) => isTreeCacheValid(p)))
      if (allValid.every(Boolean) && knownVersion === treeVersion) {
        return { success: true, unchanged: true, tree: null, version: treeVersion };
      }
    }
    const tree = await Promise.all(paths.map((p: string) => getDirectoryTreeCached(p)));
    return { success: true, unchanged: false, tree, version: treeVersion };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

// ==================== ASR 语音识别 - 全局快捷键 ====================

let registeredASRShortcut: string | null = null

// 注册 ASR 全局快捷键
ipcMain.handle('registerASRShortcut', async (event, shortcut: string) => {
  // 先注销旧的快捷键
  if (registeredASRShortcut) {
    globalShortcut.unregister(registeredASRShortcut)
    registeredASRShortcut = null
  }
  
  if (!shortcut || !win) return { success: false, error: '无效的快捷键' }
  
  try {
    // 将快捷键格式转换为 Electron 格式
    // 例如: "Ctrl+Shift+Space" -> "Ctrl+Shift+Space"
    // 注意：Alt+Space 是 Windows 系统菜单快捷键，会造成冲突
    // Electron 的 globalShortcut 不支持按键弹起检测，
    // 所以使用按下/弹起切换模式
    const electronShortcut = shortcut
      .replace('Win', 'CommandOrControl')
    
    const success = globalShortcut.register(electronShortcut, () => {
      // 按下快捷键时，通知渲染进程切换 ASR 状态
      win?.webContents.send('asr-shortcut-toggle')
    })
    
    if (success) {
      registeredASRShortcut = shortcut
      return { success: true }
    } else {
      return { success: false, error: '快捷键注册失败，可能与其他应用冲突' }
    }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

// 注销 ASR 全局快捷键
ipcMain.handle('unregisterASRShortcut', async () => {
  if (registeredASRShortcut) {
    globalShortcut.unregister(registeredASRShortcut)
    console.log('[ASR] 全局快捷键已注销:', registeredASRShortcut)
    registeredASRShortcut = null
  }
  return { success: true }
})

// 获取当前 ASR 快捷键状态
ipcMain.handle('getASRShortcutStatus', async () => {
  return {
    registered: !!registeredASRShortcut,
    shortcut: registeredASRShortcut
  }
})

// ==================== 局域网共享服务器 ====================

const LAN_SERVER_DEFAULT_PORT = 3345
let lanServer: http.Server | null = null
let lanServerPort = LAN_SERVER_DEFAULT_PORT
// 局域网共享知识库（设置页「协作→局域网共享」配置）：网页端从该目录选择共享 .kb；
// 主机嵌入配置用于 /api/kb/search 对共享 .kb 做向量检索（与建库模型保持一致）
let lanKbDir = ''
let lanKbEmbedConfig: { llmType?: string; base?: string; model?: string; apiKey?: string } | null = null
// 无向量 .kb（精简模式）的按需向量缓存：key=库名+嵌入模型+内容，避免每次问答重复嵌入
const lanKbVecCache = new Map<string, number[]>()

/** 简易内容哈希（作缓存 key） */
function lanTextHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return String(h >>> 0)
}

/** 获取本机所有 LAN IP 地址 */
function getLanIPs(): string[] {
  const ips: string[] = []
  const interfaces = networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name]
    if (!iface) continue
    for (const info of iface) {
      // 只取 IPv4 且非内环地址
      if (info.family === 'IPv4' && !info.internal) {
        ips.push(info.address)
      }
    }
  }
  return ips
}

/** MIME 类型映射 */
const mimeTypes: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
}

/** 向渲染进程推送服务器状态 */
function notifyLanServerStatus() {
  const running = lanServer !== null
  const ips = running ? getLanIPs() : []
  if (win && !win.isDestroyed()) {
    win.webContents.send('lan-server-status', {
      running,
      port: running ? lanServerPort : 0,
      ips,
    })
  }
}

// ==================== 局域网共享知识库（/api/kb/*） ====================
/** 查询参数解析（手动拆分查询串，避免 URLSearchParams 兼容差异） */
function parseLanQuery(rawUrl: string): Record<string, string> {
  const out: Record<string, string> = {}
  const qIdx = rawUrl.indexOf('?')
  if (qIdx === -1) return out
  for (const part of rawUrl.substring(qIdx + 1).split('&')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    try { out[decodeURIComponent(part.substring(0, eq))] = decodeURIComponent(part.substring(eq + 1)) } catch { /* ignore */ }
  }
  return out
}

/** 只允许裸文件名且必须以 .kb 结尾（拦截路径穿越） */
function safeLanKbName(name: string): string | null {
  const n = String(name || '').replace(/\\/g, '/').split('/').pop() || ''
  if (!n || !n.toLowerCase().endsWith('.kb')) return null
  if (n.includes('\0')) return null
  return n
}

/** 列出共享目录下的 .kb 文件 */
function listLanKbFiles() {
  if (!lanKbDir) return { enabled: false, dir: '', files: [] }
  try {
    if (!fs.existsSync(lanKbDir)) return { enabled: true, dir: lanKbDir, files: [] }
    const files = fs.readdirSync(lanKbDir)
      .filter(n => n.toLowerCase().endsWith('.kb'))
      .map(n => {
        try {
          const st = fs.statSync(join(lanKbDir, n))
          return { name: n, size: st.size, mtime: st.mtimeMs }
        } catch { return { name: n, size: 0, mtime: 0 } }
      })
      .sort((a, b) => b.mtime - a.mtime)
    return { enabled: true, dir: lanKbDir, files }
  } catch (e: any) {
    return { enabled: true, dir: lanKbDir, files: [], error: e?.message || String(e) }
  }
}

/** 读取共享目录下 .kb 的 JSON（不存在/越权返回 null） */
function readLanKbFile(name: string): any | null {
  const n = safeLanKbName(name)
  if (!n) return null
  try {
    const p = join(lanKbDir, n)
    if (!lanKbDir || !path.resolve(p).startsWith(path.resolve(lanKbDir))) return null
    const raw = fs.readFileSync(p, 'utf8')
    return JSON.parse(raw)
  } catch { return null }
}

/** 用主机嵌入配置把文本向量化（ollama / openai 兼容）；不可用返回 null */
async function lanEmbedQuery(text: string, model?: string): Promise<number[] | null> {
  const cfg = lanKbEmbedConfig
  const base = cfg?.base?.trim()
  const m = model || cfg?.model || ''
  if (!cfg || !base || !m) return null
  try {
    const type = (cfg.llmType || 'ollama').toLowerCase()
    if (type === 'ollama') {
      const resp = await fetch(`${base.replace(/\/+$/, '')}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m, input: text, truncate: true }),
      })
      if (!resp.ok) return null
      const data: any = await resp.json()
      return Array.isArray(data?.embeddings?.[0]) ? data.embeddings[0] : null
    }
    const basePath = base.endsWith('/v1-openai') || base.endsWith('/v1') ? base : `${base}/v1`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`
    const resp = await fetch(`${basePath.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: m, input: text }),
    })
    if (!resp.ok) return null
    const data: any = await resp.json()
    const it = data?.data?.[0]
    return Array.isArray(it?.embedding) ? it.embedding : null
  } catch (e) {
    console.warn('[lan-kb] 向量化失败:', (e as Error)?.message)
    return null
  }
}

/** 余弦相似度 */
function lanCos(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 中文按二元组 + 英文按词 分词 */
function lanTokenize(text: string): string[] {
  const out = new Set<string>()
  const lower = String(text || '').toLowerCase()
  const words = lower.match(/[a-z0-9_]+/g) || []
  for (const w of words) if (w.length > 1) out.add(w)
  const cjk = lower.replace(/[^\u4e00-\u9fff]/g, '')
  for (let i = 0; i + 1 < cjk.length; i++) out.add(cjk.slice(i, i + 2))
  if (cjk.length === 1) out.add(cjk)
  return Array.from(out)
}

/** 纯文本关键词命中打分（向量不可用时的词法回退） */
function lanLexicalScore(queryTokens: string[], text: string): number {
  if (!queryTokens.length) return 0
  const lower = String(text || '').toLowerCase()
  let hit = 0
  for (const token of queryTokens) if (lower.includes(token)) hit++
  return hit / queryTokens.length
}

/** 处理 /api/kb/*（list / read / search），由局域网请求处理器调用 */
async function handleLanKbApi(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string) {
  const send = (code: number, obj: any) => {
    res.statusCode = code
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(obj))
  }
  if (!lanKbDir) { send(503, { ok: false, enabled: false, error: '未配置知识库共享目录' }); return }

  // urlPath 可能带查询串（/api/kb/search?name=…）：路由匹配需去掉查询部分
  const pathOnly = urlPath.includes('?') ? urlPath.substring(0, urlPath.indexOf('?')) : urlPath

  if (pathOnly === '/api/kb/list') {
    send(200, listLanKbFiles())
    return
  }

  const query = parseLanQuery(req.url || '')
  if (pathOnly === '/api/kb/read') {
    const n = safeLanKbName(query.name || '')
    if (!n) { send(400, { ok: false, error: 'Invalid name' }); return }
    const data = readLanKbFile(n)
    if (!data) { send(404, { ok: false, error: 'KB not found' }); return }
    send(200, data)
    return
  }

  if (pathOnly === '/api/kb/search') {
    const n = safeLanKbName(query.name || '')
    if (!n) { send(400, { ok: false, error: 'Invalid name' }); return }
    const q = String(query.query || '').trim()
    if (!q) { send(400, { ok: false, error: 'Missing query' }); return }
    const topK = Math.min(20, Math.max(1, parseInt(query.topK || '5', 10) || 5))
    const data = readLanKbFile(n)
    if (!data || !Array.isArray(data.blocks)) { send(404, { ok: false, error: 'KB not found or empty' }); return }
    const blocks = (data.blocks as any[]).filter(b => b && typeof b.A === 'string' && b.A.trim())
    if (!blocks.length) { send(200, { ok: true, method: 'none', blocks: [], context: q }); return }

    const kbModel = data.config?.embedModel as string | undefined
    const tokens = lanTokenize(q)

    // —— 懒补全切片向量：.kb 未存向量（精简模式）时，用主机嵌入按需向量化（会话内按内容缓存），
    //    使 web 与桌面一致地使用向量余弦，而不是词法打分导致相似度普遍 100% ——
    const embedBase = lanKbEmbedConfig?.base?.trim()
    const embedOk = !!(embedBase && kbModel)
    if (embedOk) {
      const prefix = `${n}\u0000${kbModel}\u0000`
      const need: { b: any; key: string; text: string }[] = []
      for (const b of blocks) {
        if (Array.isArray(b.A_vector) && b.A_vector.length > 0) continue
        const key = prefix + (b.contentHash ? String(b.contentHash) : lanTextHash(b.A))
        const cached = lanKbVecCache.get(key)
        if (cached) { b.A_vector = cached; continue }
        need.push({ b, key, text: b.A })
      }
      for (let start = 0; start < need.length; start += 16) {
        const batch = need.slice(start, start + 16)
        for (const it of batch) {
          try {
            const vec = await lanEmbedQuery(it.text, kbModel)
            if (vec && vec.length) { it.b.A_vector = vec; lanKbVecCache.set(it.key, vec) }
          } catch { /* 单条失败忽略 */ }
        }
      }
    }

    const hasVectorsNow = blocks.some((b: any) => Array.isArray(b.A_vector) && b.A_vector.length > 0)
    let method = 'lexical'
    let scored: { b: any; s: number }[]
    const qv = hasVectorsNow ? await lanEmbedQuery(q, kbModel) : null
    if (qv && qv.length && hasVectorsNow) {
      scored = blocks.map((b: any) => ({ b, s: Math.max(0, lanCos(qv, b.A_vector || [])) }))
      method = 'dense'
    } else {
      scored = blocks.map((b: any) => ({ b, s: lanLexicalScore(tokens, b.A) }))
    }
    scored.sort((a, c) => c.s - a.s)
    const top = scored.slice(0, topK).filter(x => x.s > 0)
    const context = (top.length ? q + '\n\n参考资料：\n' : q) + top.map(x => `《${x.b.label || ''}》：${x.b.A}`).join('\n')
    const blocksOut = top.map(x => ({ label: x.b.label || '', content: x.b.A, similarity: Number(x.s.toFixed(4)) }))
    send(200, { ok: true, method, model: kbModel || '', total: blocks.length, blocks: blocksOut, context })
    return
  }

  send(404, { ok: false, error: 'Unknown API' })
}

// ==================== 网页端提问日志（web → 主机 /__proxy 聊天落 sessionLog） ====================
/** 判断代理请求体是否为聊天类（含 messages），并提取用户问题 / 系统提示 */
function lanProxyChatBody(body: Buffer): { question: string; system: string } | null {
  if (!body || !body.length) return null
  let obj: any = null
  try { obj = JSON.parse(body.toString('utf8')) } catch { return null }
  const pools: any[] = []
  if (Array.isArray(obj.messages)) pools.push(obj.messages)
  if (Array.isArray(obj.body?.messages)) pools.push(obj.body.messages)
  if (!pools.length) return null
  let question = ''
  let system = ''
  for (const pool of pools) {
    for (const m of pool) {
      if (!m || typeof m !== 'object') continue
      const content = typeof m.content === 'string' ? m.content : ''
      if (m.role === 'system' && !system) system = content
      else if (m.role === 'user' && content) {
        // 知识库检索会把「问题 + 参考资料」拼进 user content：只记录问题主体
        const cutIdx = content.search(/\n*参考资料[：:]/)
        question = (cutIdx !== -1 ? content.slice(0, cutIdx) : content).trim()
      }
    }
  }
  if (!question) return null
  return { question: question.slice(0, 4000), system: system.slice(0, 2000) }
}

/** 从（SSE data: 行 / ollama 裸 JSON 行 / 整段 JSON）响应中提取助手文本 */
function extractProxyAssistantText(raw: string): string {
  let acc = ''
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s === 'data: [DONE]') continue
    const jsonStr = s.startsWith('data:') ? s.slice(5).trim() : s
    if (!jsonStr) continue
    let o: any = null
    try { o = JSON.parse(jsonStr) } catch { continue }
    const delta = o?.choices?.[0]?.delta?.content
    if (typeof delta === 'string') { acc += delta; continue }
    const c = o?.choices?.[0]?.message?.content ?? o?.message?.content ?? o?.response
    if (typeof c === 'string') acc += c
  }
  if (!acc && raw.trim()) {
    try {
      const o = JSON.parse(raw)
      const c = o?.choices?.[0]?.message?.content ?? o?.response
      if (typeof c === 'string') acc = c
    } catch { /* ignore */ }
  }
  return acc.trim()
}

/** 创建并启动 LAN HTTP 服务器 */
async function startLanServer(port: number): Promise<{ success: boolean; error?: string }> {
  if (lanServer) {
    return { success: false, error: '服务器已在运行' }
  }

  // 确认 dist 目录存在且包含完整构建产物
  const distDir = process.env.DIST || join(__dirname, '../../dist')
  if (!fs.existsSync(distDir)) {
    return { success: false, error: `构建目录不存在: ${distDir}，请先运行 npm run build` }
  }
  if (!fs.existsSync(join(distDir, 'index.html'))) {
    return { success: false, error: `构建产物不完整（缺少 dist/index.html），请先运行 npm run build 生成前端产物（当前目录: ${distDir}）` }
  }

  return new Promise((resolve) => {
    lanServerPort = port
    lanServer = http.createServer((req, res) => {
      // 统一添加 CORS 头（代理和静态资源都需要）
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

      // OPTIONS 预检请求直接返回
      if (req.method === 'OPTIONS') {
        res.statusCode = 204
        res.end()
        return
      }

      let urlPath = req.url || '/'

      // ===== API 代理路由 =====
      if (urlPath.startsWith('/__proxy')) {
        // 手动解析查询字符串（兼容所有环境，避免 URLSearchParams / new URL 解析差异）
        const rawUrl = req.url || ''
        const qIdx = rawUrl.indexOf('?')
        let targetUrl = ''
        if (qIdx !== -1) {
          const qs = rawUrl.substring(qIdx + 1)
          for (const part of qs.split('&')) {
            const eqIdx = part.indexOf('=')
            if (eqIdx !== -1 && part.substring(0, eqIdx) === 'url') {
              targetUrl = decodeURIComponent(part.substring(eqIdx + 1))
              break
            }
          }
        }
        console.log('[lan-server] 代理请求:', rawUrl, '→', targetUrl)
        if (!targetUrl) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'Missing "url" parameter' }))
          return
        }

        // 先收集完 body，再发起代理请求（确保 Content-Length 正确设置）
        const bodyChunks: any[] = []
        req.on('data', (chunk: any) => bodyChunks.push(chunk))
        req.on('end', () => {
          try {
            const target = new URL(targetUrl)
            const targetPort = target.port || (target.protocol === 'https:' ? 443 : 80)
            const body = Buffer.concat(bodyChunks)

            console.log('[lan-server] 代理:', req.method, targetUrl, 'body:', body.length, 'bytes')

            // 网页端提问日志：识别聊天类请求 → 新建会话并记录用户问题
            // （web 无桌面主进程会话，经 /__proxy 代理的聊天在此落 sessionLog，供「设置→日志」检视）
            let lanWebSession: string | null = null
            try {
              const chat = lanProxyChatBody(body)
              if (chat) {
                lanWebSession = `lan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
                sessionLog.append(lanWebSession, 'session/start', {
                  createdAt: Date.now(),
                  systemPrompt: chat.system,
                })
                sessionLog.append(lanWebSession, 'user/message', {
                  content: chat.question,
                  source: `lan-web ${String((req as any).socket?.remoteAddress || '')}`,
                })
              }
            } catch (e) {
              console.warn('[lan-server] 网页提问日志失败:', e)
            }

            // 构造要转发的头（只转发必要项）
            const forwardHeaders: Record<string, string> = {}
            if (req.headers['content-type']) {
              forwardHeaders['Content-Type'] = req.headers['content-type'] as string
            }
            if (req.headers['authorization']) {
              forwardHeaders['Authorization'] = req.headers['authorization'] as string
            }
            if (req.headers['accept']) {
              forwardHeaders['Accept'] = req.headers['accept'] as string
            }
            if (body.length > 0) {
              forwardHeaders['Content-Length'] = String(body.length)
            }

            const proxyReq = http.request({
              hostname: target.hostname,
              port: targetPort,
              path: target.pathname + target.search,
              method: req.method,
              headers: forwardHeaders,
            }, (proxyRes) => {
              console.log('[lan-server] 代理响应状态:', proxyRes.statusCode)
              res.statusCode = proxyRes.statusCode || 200
              const hopByHop = ['transfer-encoding', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade']
              for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
                const key = proxyRes.rawHeaders[i].toLowerCase()
                if (!hopByHop.includes(key)) {
                  res.setHeader(proxyRes.rawHeaders[i], proxyRes.rawHeaders[i + 1])
                }
              }
              // 网页端提问日志：流式响应结束后记录助手回答并结束会话
              let webAnswerBuf = ''
              if (lanWebSession) {
                proxyRes.on('data', (chunk: any) => {
                  try { if (webAnswerBuf.length < 4 * 1024 * 1024) webAnswerBuf += chunk.toString('utf8') } catch { /* ignore */ }
                })
                proxyRes.on('end', () => {
                  try {
                    const answer = extractProxyAssistantText(webAnswerBuf)
                    if (answer) sessionLog.append(lanWebSession!, 'assistant/message', { content: answer.slice(0, 200000) })
                    sessionLog.append(lanWebSession!, 'session/end', { status: 'completed' })
                  } catch (e) {
                    console.warn('[lan-server] 网页回答落日志失败:', e)
                  }
                })
              }
              proxyRes.pipe(res)
            })

            proxyReq.on('error', (err) => {
              console.error('[lan-server] 代理失败:', err.message)
              if (!res.headersSent) {
                res.statusCode = 502
                res.end(JSON.stringify({ error: `Proxy error: ${err.message}` }))
              }
            })

            proxyReq.setTimeout(120000, () => {
              proxyReq.destroy()
              if (!res.headersSent) {
                res.statusCode = 504
                res.end(JSON.stringify({ error: 'Proxy timeout' }))
              }
            })

            if (body.length > 0) proxyReq.write(body)
            proxyReq.end()

          } catch (e: any) {
            console.error('[lan-server] 代理处理异常:', e.message)
            if (!res.headersSent) {
              res.statusCode = 400
              res.end(JSON.stringify({ error: `Proxy error: ${e.message}` }))
            }
          }
        })
        return
      }

      // ===== 局域网共享知识库 API（网页端 home 知识库模式列出/检索共享目录 .kb） =====
      if (urlPath.startsWith('/api/kb/')) {
        void handleLanKbApi(req, res, urlPath)
        return
      }

      // ===== 静态文件服务 =====
      // 去掉查询参数
      const pathOnly = req.url!.includes('?') ? req.url!.substring(0, req.url!.indexOf('?')) : req.url!

      // SPA 支持：没有扩展名的路径都返回 index.html
      const ext = extname(pathOnly)
      let filePath = ext ? join(distDir, pathOnly) : join(distDir, 'index.html')

      // 安全检查：防止路径穿越
      const resolved = path.resolve(filePath)
      if (!resolved.startsWith(path.resolve(distDir))) {
        res.statusCode = 403
        res.end('Forbidden')
        return
      }

      // 读取文件
      fs.readFile(resolved, (err, data) => {
        if (err) {
          // 文件不存在 → 返回 index.html（SPA 路由回退）
          if (err.code === 'ENOENT') {
            const indexPath = join(distDir, 'index.html')
            fs.readFile(indexPath, (err2, data2) => {
              if (err2) {
                res.statusCode = 500
                res.end(`Internal Server Error: ${indexPath} 不存在，请先运行 npm run build 生成前端产物`)
                return
              }
              res.statusCode = 200
              res.setHeader('Content-Type', 'text/html; charset=utf-8')
              res.end(data2)
            })
            return
          }
          res.statusCode = 500
          res.end(`Internal Server Error: ${err.message}`)
          return
        }

        // 用实际文件路径的扩展名判断 MIME 类型
        const fileExt = extname(resolved)
        const mime = mimeTypes[fileExt] || 'application/octet-stream'
        res.statusCode = 200
        res.setHeader('Content-Type', `${mime}; charset=utf-8`)
        res.end(data)
      })
    })

    lanServer.on('error', (err: NodeJS.ErrnoException) => {
      // 端口被占用时自动顺延，使开发版与打包版可以各自启动局域网共享
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE' && lanServerPort < port + 20) {
        lanServerPort += 1
        console.log(`[lan-server] 端口 ${lanServerPort - 1} 被占用，自动切换到 ${lanServerPort}`)
        try {
          lanServer!.listen(lanServerPort, '0.0.0.0', () => {
            notifyLanServerStatus()
            resolve({ success: true })
          })
        } catch (e) {
          lanServer = null
          notifyLanServerStatus()
          resolve({ success: false, error: (e as Error).message })
        }
        return
      }
      lanServer = null
      notifyLanServerStatus()
      resolve({ success: false, error: err.message })
    })

    lanServer.listen(port, '0.0.0.0', () => {
      notifyLanServerStatus()
      resolve({ success: true })
    })
  })
}

/** 停止 LAN HTTP 服务器 */
async function stopLanServer(): Promise<{ success: boolean }> {
  if (!lanServer) {
    return { success: false }
  }
  return new Promise((resolve) => {
    lanServer!.close(() => {
      lanServer = null
      notifyLanServerStatus()
      resolve({ success: true })
    })
    // 强制关闭所有连接
    lanServer!.closeAllConnections?.()
  })
}

/** 获取 LAN 服务器状态 */
function getLanServerInfo() {
  return {
    running: lanServer !== null,
    port: lanServer ? lanServerPort : 0,
    ips: getLanIPs(),
  }
}

// 局域网共享 IPC
ipcMain.handle('startLanServer', async (_, port?: number) => {
  return await startLanServer(port || LAN_SERVER_DEFAULT_PORT)
})

ipcMain.handle('stopLanServer', async () => {
  return await stopLanServer()
})

ipcMain.handle('getLanServerInfo', async () => {
  return getLanServerInfo()
})

// 局域网共享知识库目录/嵌入配置（渲染进程「协作→局域网共享」维护）
ipcMain.handle('lan:setKbDir', async (_e, dir?: string) => {
  lanKbDir = typeof dir === 'string' ? dir : ''
  return { success: true }
})
ipcMain.handle('lan:getKbDir', async () => ({ dir: lanKbDir }))
ipcMain.handle('lan:setEmbed', async (_e, cfg?: any) => {
  lanKbEmbedConfig = cfg && typeof cfg === 'object'
    ? { llmType: String(cfg.llmType || ''), base: String(cfg.base || ''), model: String(cfg.model || ''), apiKey: String(cfg.apiKey || '') }
    : null
  return { success: true }
})

// ==================== MCP 服务 IPC ====================
// 配置由渲染进程持有（localStorage），按 serverId 传入主进程缓存连接。

ipcMain.handle('mcp:connect', async (_e, payload) => {
  return await mcpService.connect(payload.serverId, payload.config)
})

ipcMain.handle('mcp:disconnect', async (_e, { serverId }) => {
  await mcpService.disconnect(serverId)
  return { success: true }
})

ipcMain.handle('mcp:listTools', async (_e, payload) => {
  return await mcpService.listTools(payload.serverId, payload.config)
})

ipcMain.handle('mcp:callTool', async (_e, payload) => {
  return await mcpService.callTool(payload.serverId, payload.config, payload.toolName, payload.args)
})

ipcMain.handle('mcp:test', async (_e, { config }) => {
  return await mcpService.testConnection(config)
})

ipcMain.handle('mcp:getStatus', async (_e, { serverId }) => {
  return mcpService.getStatus(serverId)
})

ipcMain.handle('mcp:disconnectAll', async () => {
  await mcpService.disconnectAll()
  return { success: true }
})

// 内置服务对外 HTTP 暴露状态（供设置页「说明」区展示外部软件接入方式）
ipcMain.handle('mcp-expose-info', async () => mcpExposeServer.info())
// 按端点开关对外暴露（各内置服务端点各自可开关）
ipcMain.handle('mcp-expose-set', async (_e, payload) => {
  return mcpExposeServer.setEnabled(String(payload?.id || ''), payload?.enabled !== false)
})

// ==================== AI 会话 IPC（主进程执行全部 AI 请求 + 断线续传缓冲） ====================
// 渲染进程 ai-utils.ts 通过 IPC 桥把请求委托给主进程，主进程缓冲完整回答并落盘，
// 前端切模块/中断后可用 ai:get 取回完整回答，ai:event 实时推送流式事件。

ipcMain.handle('ai:start', async (_e, payload) => {
  return await aiService.start(payload)
})

ipcMain.handle('ai:get', async (_e, { requestId }) => {
  return await aiService.get(requestId)
})

ipcMain.handle('ai:abort', async (_e, { requestId }) => {
  return await aiService.abort(requestId)
})

ipcMain.handle('ai:release', async (_e, { requestId }) => {
  return await aiService.release(requestId)
})

ipcMain.handle('ai:list', async () => {
  return await aiService.list()
})

ipcMain.handle('ai:check', async (_e, payload) => {
  return await aiService.check(payload)
})

ipcMain.handle('ai:contextWindow', async (_e, payload) => {
  return await aiService.fetchModelContextWindow(payload)
})

ipcMain.handle('ai:contextWindowDetail', async (_e, payload) => {
  return await aiService.fetchModelContextWindowDetail(payload)
})

// LM Studio 模型清单（type / state：哪些已加载）——设置页「模型 → LM Studio」用
ipcMain.handle('ai:lmstudioModels', async (_e, payload) => {
  return await aiService.listLmStudioModels(payload)
})

// LM Studio 命令行（lms）：已加载实例清单 / 加载模型 / 卸载模型
// （REST API 不提供加载卸载，官方路径就是 lms load / lms unload）
ipcMain.handle('ai:lmstudioCli', async (_e, payload) => {
  return await lmStudioCli(payload || {})
})

// Ollama 模型清单（已安装 + 已加载 + 逐模型明细）与加载 / 卸载
ipcMain.handle('ai:ollamaModels', async (_e, payload) => {
  return await aiService.listOllamaModels(payload)
})
ipcMain.handle('ai:ollamaModelAction', async (_e, payload) => {
  return await aiService.ollamaModelAction(payload)
})