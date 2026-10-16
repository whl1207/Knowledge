/**
 * platform — 平台能力注册表（渲染层唯一入口）
 *
 * 渲染层一律经 `getPlatform()` 取平台能力，不再直接出现 `window.ipcRenderer` / `window.dsh`。
 * 后端在首次取用时按运行环境探测并缓存：
 *   Electron 桌面 → electron 后端（现有 IPC）
 *   其它（浏览器 dev / 局域网访客网页）→ browser 降级后端
 *
 * 「本地优先 + 可连桌面主机」混合形态接入时，只改这里一处：按环境注册 android 后端，
 * 或在 LAN 模式下注册 host 后端；调用方无需改动。
 */
import type { CapabilityId, CapabilityMode, Platform, RuntimeKind } from '@/platform/contract'
import { browserPlatform } from '@/platform/browser'
import { electronPlatform, isElectronRuntime } from '@/platform/electron'
import { createHostPlatform, hostRuntime } from '@/platform/host'
import { createAndroidPlatform, isAndroidRuntime } from '@/platform/android'
import { aikmIpcAvailable } from '@/lib/aikmIpc'

let cached: Platform | null = null

/** 手动注册后端（测试注入 / 特殊宿主）；传 null 恢复自动探测 */
export function registerPlatform(next: Platform | null): void {
  cached = next
}

/**
 * 解析当前运行环境的后端（首次调用探测并缓存）：
 *   Electron 桌面 → electron 后端（现有 IPC）
 *   安卓（Capacitor 壳）→ android 后端（Capacitor Filesystem 等）
 *   局域网访客网页（主机注入了 __AIKM_HOST__）→ host 后端（HTTP，主机代做）
 *   其它（本地浏览器 dev / 静态站）→ browser 降级后端
 */
export function getPlatform(): Platform {
  if (!cached) {
    if (isElectronRuntime()) {
      cached = electronPlatform
    } else if (isAndroidRuntime()) {
      cached = createAndroidPlatform()
    } else {
      const info = hostRuntime()
      cached = info ? createHostPlatform(info) : browserPlatform
      // 在 Electron 窗口里却拿不到 ipcRenderer：几乎总是 preload 没加载（产物缺失 / 路径不对），
      // 此时整个界面会静默退化成「网页模式」（没有窗口壳与桌面能力）。这里明确报出来，
      // 否则只能看到「软件变成了网页版」这种没有线索的现象。
      if (!info && typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent || '')) {
        console.error('[platform] 运行在 Electron 窗口里，但拿不到宿主 IPC 桥（aikmIpcAvailable() 为 false）—— preload 没有加载成功，'
          + '界面将退化为网页模式。请检查 dist-electron/preload/index.mjs（或 .cjs）是否存在，必要时重新 npm run build:web。')
      }
    }
  }
  return cached
}

export function getRuntimeKind(): RuntimeKind {
  return getPlatform().kind
}

/** 能力形态（local / host / none）——UI 据此显示、禁用或改写入口 */
export function capabilityMode(id: CapabilityId): CapabilityMode {
  return getPlatform().capabilities.mode(id)
}

/**
 * 是否「局域网访客网页」：页面由桌面主机的局域网共享服务投递（主机注入了 `__AIKM_HOST__`）。
 *
 * 与「无 ipcRenderer」不等价：**安卓壳**也没有 ipcRenderer，但它是本地应用（有真实文件系统、
 * 有渲染层智能体循环），不该按访客降级（例如把知识库退化成上传文件、智能体交给主机）。
 * 因此能力/界面判定请用本函数，而不是「有没有 ipcRenderer」。
 */
export function isHostGuestRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    !aikmIpcAvailable() &&
    !!(window as any).__AIKM_HOST__
  )
}

/** 能力是否可用 */
export function hasCapability(id: CapabilityId): boolean {
  return getPlatform().capabilities.has(id)
}
