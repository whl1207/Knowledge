/**
 * run-mode.ts — 「开发模式 / 打包运行」相关路径与判定的**唯一来源**
 *
 * 为什么要独立一份：
 * 1. 主进程里原来 index.ts 与 browser-agent.ts 各写了一套（distElectron / distDir / publicDir /
 *    IS_DEV / url / preload），两处容易走偏；
 * 2. **只看环境变量判开发模式是不安全的**：宿主（IDE 调试脚本、agent harness、某些 CI 镜像）可能把
 *    `VITE_DEV_SERVER_URL` 留在环境里，那样连**打包版**都会去 `loadURL(http://localhost:…)`——
 *    表现就是「软件变成了网页模式」。因此这里要求「不是打包版」且「给了 dev server 地址」两条同时成立；
 * 3. preload 产物在 dev / build 下扩展名可能不同（.mjs / .cjs），**按实际存在的选**，并在一份都不存在时
 *    大声报错 —— preload 没加载时渲染层拿不到 `window.ipcRenderer`，会静默退化成 browserPlatform
 *    （没有窗口壳、没有桌面能力，看起来就是网页版）。
 */
import { app } from 'electron'
import * as fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { logError, logInfo } from './log'

/**
 * 本模块所在目录（打包后即 app.asar 内的 dist-electron/main）。
 * ⚠️ 不能用全局 `__dirname`：ESM 下被导入模块的顶层代码先于导入方模块体执行，
 * 而 index.ts 是在自己的模块体里才把 `globalThis.__dirname` 赋上的 —— 直接用会得到
 * 「ReferenceError: __dirname is not defined in ES module scope」，整个应用起不来。
 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

/** dev server 地址；打包版一律为空（即便环境里有残留的 VITE_DEV_SERVER_URL） */
export const DEV_SERVER_URL: string = app.isPackaged ? '' : String(process.env.VITE_DEV_SERVER_URL || '')

/** 是否开发模式（dev server + Electron；打包版永远 false） */
export const IS_DEV: boolean = !!DEV_SERVER_URL

/** 构建产物目录（打包后在 app.asar 内，结构与开发一致） */
export const DIST_ELECTRON_DIR = join(MODULE_DIR, '..')
export const DIST_DIR = join(DIST_ELECTRON_DIR, '../dist')
/** 静态资源目录：dev 走仓库 public/，打包走 dist/ */
export const PUBLIC_DIR = IS_DEV ? join(DIST_ELECTRON_DIR, '../public') : DIST_DIR
/** 主窗口 / 附属窗口加载的页面 */
export const INDEX_HTML = join(DIST_DIR, 'index.html')

/**
 * preload 产物候选路径。
 *
 * ⚠️ 顺序是 **.cjs 优先**：本项目 package.json 是 `"type": "module"`，而 preload 里是
 * `require('electron')` 这类 CJS 写法 —— 产物若叫 `.mjs`，Electron 会按 ESM 解析并抛
 * `ReferenceError: require is not defined in ES module scope`，**整个 preload 不执行**，
 * 渲染层拿不到 `window.ipcRenderer`（表现为窗口 load 完不出首帧 → 只看到控制台没有窗口）。
 * 产物格式由 vite.config.ts 的 preload.output 固定为 cjs + `.cjs` 扩展名。
 */
const PRELOAD_CANDIDATES = [
  join(MODULE_DIR, '../preload/index.cjs'),
  join(MODULE_DIR, '../preload/index.mjs'),
]

/**
 * 解析 preload 产物路径（每次创建窗口时调用，避免把「文件当时还不存在」固化下来）。
 * 两个候选都不存在时：打一条**能看懂的**错误日志并继续 —— 此时窗口会以网页模式运行。
 */
export function resolvePreload(): string {
  for (const p of PRELOAD_CANDIDATES) {
    try { if (fs.existsSync(p)) return p } catch { /* 忽略：继续试下一个 */ }
  }
  logError('preload', `missing — looked for ${PRELOAD_CANDIDATES.join(' | ')}. `
    + 'The renderer cannot reach the host IPC bridge without it (it never sits on window; '
    + 'the preload exposes a one-shot __aikmClaimIpcBridge) and will silently fall back to web mode. '
    + 'Rebuild with: npm run build:web')
  return PRELOAD_CANDIDATES[0]
}

// 启动时把「运行模式判定」记进日志（默认静默，AIKM_VERBOSE=1 可见）：
// 排查「打包版变成网页模式 / 加载了 localhost」这类问题时，第一眼就该看到这三项。
logInfo('run-mode', `packaged=${app.isPackaged} dev=${IS_DEV} url=${DEV_SERVER_URL || '(none)'}`
  + ` preload=${(() => { for (const p of PRELOAD_CANDIDATES) { try { if (fs.existsSync(p)) return p } catch { /* 忽略 */ } } return '(missing)' })()}`)
