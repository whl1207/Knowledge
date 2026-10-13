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

/** 能力是否可用 */
export function hasCapability(id: CapabilityId): boolean {
  return getPlatform().capabilities.has(id)
}
