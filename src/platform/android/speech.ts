/**
 * platform/android/speech — 安卓系统语音合成（NativeSpeech 插件）封装
 *
 * 原生侧见 android/app/src/main/java/com/whl/aikm/NativeSpeechPlugin.java：
 * 用 android.speech.tts.TextToSpeech 直接朗读，不需要模型、多数机型可离线。
 *
 * 与桌面（sherpa-onnx 合成 WAV）的差别：这里没有字节流，只有「朗读」——
 * `speak()` 的 Promise 在朗读结束时 resolve，上层的分句队列据此串行推进。
 */

import { registerPlugin } from '@capacitor/core'
import type { TtsApi } from '@/platform/contract'

/** 原生插件的最小接口（与 NativeSpeechPlugin.java 一一对应） */
export interface NativeSpeechPluginApi {
  status(): Promise<{ available: boolean; engine: string; languages: string[]; error: string }>
  voices(): Promise<{ voices: Array<{ name: string; locale?: string; quality?: number; latency?: number; network?: boolean }> }>
  speak(opts: {
    text: string
    lang?: string
    rate?: number
    pitch?: number
    voice?: string
    stopPrevious?: boolean
  }): Promise<{ done?: boolean; stopped?: boolean }>
  stop(): Promise<{ success: boolean }>
}

/** 原生插件实例（未安装时调用会 reject，由上层按能力降级） */
export const NativeSpeech = registerPlugin<NativeSpeechPluginApi>('NativeSpeech')

/** 用 NativeSpeech 插件实现语音合成接缝（依赖可注入，便于 Node 侧自检） */
export function createSpeechApi(plugin: NativeSpeechPluginApi = NativeSpeech): TtsApi {
  return {
    async status() {
      try {
        const r = await plugin.status()
        return {
          available: !!r?.available,
          engine: String(r?.engine || ''),
          languages: Array.isArray(r?.languages) ? r.languages : [],
          error: r?.error ? String(r.error) : null,
        }
      } catch (e: any) {
        return { available: false, engine: '', error: String(e?.message || e) }
      }
    },

    /** 系统语音不需要模型：保持与桌面同形，但明确未加载模型 */
    async load() {
      return { available: false, error: '安卓使用系统语音，无需加载模型' }
    },

    /** 系统 TTS 只能朗读、不能导出音频字节 */
    async synthesize() {
      throw new Error('当前环境不支持合成音频字节（请使用 speak）')
    },

    async speak(payload) {
      try {
        const r = await plugin.speak({
          text: String(payload?.text || ''),
          lang: payload?.lang,
          rate: payload?.rate,
          pitch: payload?.pitch,
          voice: payload?.voice,
          stopPrevious: payload?.stopPrevious === true,
        })
        // 被 stop 打断也按「本轮结束」返回，让队列继续推进（不当作错误）
        return r?.stopped ? { success: false, error: 'stopped' } : { success: true }
      } catch (e: any) {
        return { success: false, error: String(e?.message || e) }
      }
    },

    async stop() {
      try {
        await plugin.stop()
        return { success: true }
      } catch {
        return { success: false }
      }
    },

    async voices() {
      try {
        const r = await plugin.voices()
        return Array.isArray(r?.voices) ? r.voices : []
      } catch {
        return []
      }
    },

    async dispose() {
      // 系统引擎由系统托管，无需释放
      return { success: true }
    },
  }
}
