/**
 * fileWatch.ts — 文件系统变更订阅 + 目录监听租约（渲染层单例）
 *
 * 背景（切换「知识管理」卡顿 / MaxListenersExceededWarning）：
 *  - `panel.vue` 与 `view_file.vue` 各自 `window.ipcRenderer.on('fileSystemChanged', …)`；
 *    preload 的 on/off 依赖跨 contextBridge 的函数身份，重复挂载时旧监听不会被真正移除
 *    → 监听数持续累积（>10 触发 Node 的 MaxListenersExceededWarning）。
 *  - 后果：① 每个旧监听闭包持有整个已卸载组件的作用域，大工作区（十万级文件）下内存暴涨；
 *          ② 事件触发时多个旧闭包各自刷新，重复全量扫描/回传。
 *
 * 因此改为**全窗口唯一监听**：所有组件都经本模块订阅，平台层的文件变更订阅上永远只有 1 个
 * fileSystemChanged 监听（只注册、不解绑），去抖也共享——一次事件只刷新一次。
 *
 * 目录监听（`startWatching` / `stopWatching`）同样收敛为**租约**：
 *  - 首个订阅者 `acquireFileWatch()` 启动监听；
 *  - 最后一个订阅者 `releaseFileWatch()` 后**延迟 3 秒**才真正停止；
 *  - 期间重新挂载（在知识管理与知识处理之间来回切）直接复用现有 watcher，
 *    不再反复 `closeAllWatchers()` + 重建 recursive watcher（大工作区初始化很贵）。
 *
 * 平台差异：文件变更订阅与目录监听均由平台层能力提供（`fs.watch`）；
 * 无该能力的环境（浏览器 / 局域网访客网页）静默降级——不订阅、不监听。
 */
import { getPlatform, hasCapability } from '@/platform'

/** 事件去抖：多个组件共享同一个定时器（一次文件事件只刷新一次） */
const CHANGE_DEBOUNCE_MS = 400
/** 释放监听后的宽限期（毫秒）：期间重新申请则复用，不做 watcher 重建 */
const WATCH_RELEASE_GRACE_MS = 3000

type FileChangeListener = (data: any) => void

const listeners = new Set<FileChangeListener>()
let changeBound = false
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let pendingPayload: any = null

function flush(): void {
  debounceTimer = null
  const payload = pendingPayload
  pendingPayload = null
  for (const fn of [...listeners]) {
    try { fn(payload) } catch (e) { console.warn('[fileWatch] 监听器执行失败:', e) }
  }
}

/**
 * 绑定唯一的文件变更订阅（幂等）。
 * 只注册、不解绑：即使平台层的退订失效也不会累积（永远只有这一个）。
 */
function bindChangeOnce(): void {
  if (changeBound) return
  if (!hasCapability('fs.watch')) return
  changeBound = true
  getPlatform().watch.onChange((data: unknown) => {
    pendingPayload = data
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(flush, CHANGE_DEBOUNCE_MS)
  })
}

/**
 * 订阅文件系统变更（组件 onMounted 调用）。
 * @returns 取消订阅函数（组件 onBeforeUnmount 调用）
 */
export function onFileSystemChanged(fn: FileChangeListener): () => void {
  bindChangeOnce()
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
    if (!listeners.size && debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
      pendingPayload = null
    }
  }
}

// ---------------------------------------------------------------------------
// 目录监听租约（startWatching / stopWatching）
// ---------------------------------------------------------------------------

let leaseHolders = 0
let watching = false
let releaseTimer: ReturnType<typeof setTimeout> | null = null

/** 申请目录监听（幂等）：已监听则复用，不做重建 */
export async function acquireFileWatch(roots: string[]): Promise<void> {
  leaseHolders++
  if (releaseTimer) {
    clearTimeout(releaseTimer)
    releaseTimer = null
  }
  if (watching) return
  watching = true
  try {
    await getPlatform().watch.acquire(roots)
  } catch (e) {
    watching = false
    console.warn('[fileWatch] startWatching 失败:', e)
  }
}

/** 释放目录监听：最后一个持有者释放后延迟宽限期才真正停止（来回切模块不重建 watcher） */
export function releaseFileWatch(delayMs = WATCH_RELEASE_GRACE_MS): void {
  leaseHolders = Math.max(0, leaseHolders - 1)
  if (leaseHolders > 0) return
  if (releaseTimer) clearTimeout(releaseTimer)
  releaseTimer = setTimeout(async () => {
    releaseTimer = null
    if (leaseHolders > 0) return
    watching = false
    try {
      await getPlatform().watch.release()
    } catch { /* 忽略：窗口关闭等场景 */ }
  }, delayMs)
}

/** 当前是否持有目录监听（诊断用） */
export function isFileWatchActive(): boolean {
  return watching
}
