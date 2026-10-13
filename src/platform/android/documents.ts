/**
 * platform/android/documents — 系统文件选择 + 按 uri 读写（DocPicker 插件）封装
 *
 * 原生侧见 android/app/src/main/java/com/whl/aikm/DocPickerPlugin.java：
 * 走 SAF 的「文件」侧（ACTION_OPEN_DOCUMENT / ACTION_CREATE_DOCUMENT），
 * 与 SafFolder 的「目录」侧（ACTION_OPEN_DOCUMENT_TREE）互补。
 *
 * 用途：插件（ctx.files）与应用的「打开文件」在安卓上必须经系统选择器才能读到手机里的文件；
 * 挑过的 uri 会在原生侧记住可持久化读权限，重启后仍可读。
 */

import { registerPlugin } from '@capacitor/core'

export interface PickedDocument {
  uri: string
  name: string
  size: number
  mime: string
  isDir: boolean
}

/** 原生插件的最小接口（与 DocPickerPlugin.java 一一对应） */
export interface DocPickerPluginApi {
  pickFiles(opts?: { multiple?: boolean; mime?: string }): Promise<{ files: PickedDocument[] }>
  saveFile(opts: { name: string; mime?: string; data?: string; base64?: string }): Promise<{ success: boolean; uri?: string; name?: string }>
  readFile(opts: { uri: string; mode?: 'text' | 'base64'; maxBytes?: number }): Promise<{ text?: string; base64?: string; size?: number }>
  stat(opts: { uri: string }): Promise<PickedDocument & { exists: boolean }>
  remembered(): Promise<{ uris: string[] }>
}

/** 原生插件实例（未安装时调用会 reject，由上层按能力降级） */
export const DocPicker = registerPlugin<DocPickerPluginApi>('DocPicker')

/** 用 DocPicker 插件实现「挑文件 → 按 uri 读」的最小适配面 */
export function createDocumentsAdapter(plugin: DocPickerPluginApi = DocPicker) {
  return {
    async pickFiles(opts?: { multiple?: boolean; mime?: string }): Promise<PickedDocument[]> {
      try {
        const r = await plugin.pickFiles(opts)
        return Array.isArray(r?.files) ? r.files : []
      } catch {
        // 用户取消 / 插件缺失都按「没选到」处理（调用方已有取消分支）
        return []
      }
    },

    async readText(uri: string, maxBytes?: number): Promise<string> {
      const r = await plugin.readFile({ uri, mode: 'text', maxBytes })
      return typeof r?.text === 'string' ? r.text : ''
    },

    async readBase64(uri: string, maxBytes?: number): Promise<{ base64: string; size: number }> {
      const r = await plugin.readFile({ uri, mode: 'base64', maxBytes })
      return { base64: typeof r?.base64 === 'string' ? r.base64 : '', size: Number(r?.size || 0) }
    },

    async stat(uri: string): Promise<(PickedDocument & { exists: boolean }) | null> {
      try {
        return await plugin.stat({ uri })
      } catch {
        return null
      }
    },

    async saveFile(payload: { name: string; mime?: string; data?: string; base64?: string }) {
      try {
        return await plugin.saveFile(payload)
      } catch (e: any) {
        return { success: false, error: String(e?.message || e) }
      }
    },
  }
}
