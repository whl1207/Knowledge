/**
 * platform/android/share — 用系统应用打开 / 系统分享面板（ShareOpen 插件）封装
 *
 * 原生侧见 android/app/src/main/java/com/whl/aikm/SharePlugin.java：
 * ACTION_VIEW 打开、ACTION_SEND 分享；`content://` 直接用，`file://` 与沙箱相对路径经 FileProvider 转换。
 *
 * 传参二选一：
 * - `uri`：已是可共享的 uri（SAF 授权目录里的文件用 SafFolder.getUri 取，见本目录 saf.ts）；
 * - `fileUrl`：Capacitor Filesystem 给出的 `file://` 绝对路径（沙箱文件）。
 */

import { registerPlugin } from '@capacitor/core'

export interface ShareOpenPayload {
  uri?: string
  fileUrl?: string
  path?: string
  directory?: string
  mime?: string
  title?: string
  text?: string
}

/** 原生插件的最小接口（与 SharePlugin.java 一一对应） */
export interface ShareOpenPluginApi {
  open(payload: ShareOpenPayload): Promise<{ success: boolean; action?: string }>
  share(payload: ShareOpenPayload): Promise<{ success: boolean; action?: string }>
  canOpen(payload: ShareOpenPayload): Promise<{ openable: boolean; error?: string }>
}

/** 原生插件实例（未安装时调用会 reject，由上层按能力降级） */
export const ShareOpen = registerPlugin<ShareOpenPluginApi>('ShareOpen')

/** 用 ShareOpen 插件实现「打开 / 分享」两个动作 */
export function createShareAdapter(plugin: ShareOpenPluginApi = ShareOpen) {
  return {
    async open(payload: ShareOpenPayload): Promise<{ success: boolean; error?: string }> {
      try {
        const r = await plugin.open(payload)
        return r?.success ? { success: true } : { success: false, error: '没有可用的打开方式' }
      } catch (e: any) {
        return { success: false, error: String(e?.message || e) }
      }
    },

    async share(payload: ShareOpenPayload): Promise<{ success: boolean; error?: string }> {
      try {
        const r = await plugin.share(payload)
        return r?.success ? { success: true } : { success: false, error: '分享面板打开失败' }
      } catch (e: any) {
        return { success: false, error: String(e?.message || e) }
      }
    },

    async canOpen(payload: ShareOpenPayload): Promise<boolean> {
      try {
        return !!(await plugin.canOpen(payload))?.openable
      } catch {
        return false
      }
    },
  }
}
