/**
 * tts.ts — 渲染层 TTS 能力
 *
 * 插件只说「念什么」，引擎 / 音色 / 语速全部走应用自己的 TTS 设置（设置 → 语音），
 * 因此插件不需要也不应该关心 Kokoro / Piper / Qwen3-TTS 这些差异。
 *
 * 与 ctx.notify 同一层级：不需要声明权限（只是把一句话交给应用已配置的语音通道读出来），
 * 但 `available` 为 false 时必须给出可读原因，插件要能降级。
 */

import type { PluginLogger } from '@/types/plugin'
import { usestore } from '@/store'

export interface PluginTtsApi {
  /** 应用当前是否具备可用的语音通道（TTS 管理器就绪且已连接） */
  readonly available: boolean
  /** 不可用时的原因（可直接展示给用户） */
  readonly reason: string
  /** 朗读一段文本；返回 ok=false 时带原因（不抛错，避免插件因语音失败而报错） */
  speak(text: string, opts?: { stopPrevious?: boolean }): Promise<{ ok: boolean; reason?: string }>
  /** 停止当前朗读 */
  stop(): void
}

export interface PluginTtsDeps {
  pluginId: string
  log: PluginLogger
}

export function createPluginTtsApi(deps: PluginTtsDeps): PluginTtsApi {
  /** store 可能尚未就绪（极早期装载），统一兜住 */
  const storeOf = (): any => {
    try {
      return usestore() as any
    } catch {
      return null
    }
  }

  const reasonOf = (): string => {
    const store = storeOf()
    if (!store) return '应用状态尚未就绪'
    if (typeof store.tts !== 'function') return '当前应用版本不支持语音'
    // store.tts() 会在首次调用时惰性创建 TTS 管理器，所以这里不看 ttsManager，
    // 只看「当前引擎是否连通」（非本地引擎未配置时 isTTSConnected 为 false）。
    if (store.isTTSConnected === false) return '当前语音引擎未连接（设置 → 语音）'
    return ''
  }

  return {
    get available() {
      return reasonOf() === ''
    },
    get reason() {
      return reasonOf()
    },

    async speak(text, opts) {
      const body = String(text ?? '').trim()
      if (!body) return { ok: false, reason: '文本为空' }
      const reason = reasonOf()
      if (reason) return { ok: false, reason }
      try {
        const store = storeOf()
        if (opts?.stopPrevious) store.stopTTS?.()
        store.tts(body)
        return { ok: true }
      } catch (e: any) {
        const message = e?.message || String(e)
        deps.log.warn(`[plugin:${deps.pluginId}] 朗读失败：${message}`)
        return { ok: false, reason: message }
      }
    },

    stop() {
      try {
        storeOf()?.stopTTS?.()
      } catch (e: any) {
        deps.log.warn(`[plugin:${deps.pluginId}] 停止朗读失败：${e?.message || String(e)}`)
      }
    },
  }
}
