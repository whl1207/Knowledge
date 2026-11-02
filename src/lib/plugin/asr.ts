/**
 * asr.ts — 渲染层「插件语音识别服务」（插件上下文里的 `ctx.asr`）
 *
 * 为什么由宿主提供：插件 bundle 是 Blob URL 加载的单文件 ESM，不能 import 应用内部模块；
 * 而「文件转写」必须复用用户在「设置 → 语音 → 语音识别」里配置的引擎与模型。
 * 由宿主注入既避免插件再复制一套模型加载逻辑，也保证与语音输入走同一份配置。
 *
 * 能力范围：onnx-whisper（本地离线模型）/ whisper-api（OpenAI 兼容）/
 * qwen3-asr（OpenAI 兼容或 Gradio 网页服务）。其余引擎返回 ASR_ENGINE_UNSUPPORTED。
 * 失败不抛异常：统一返回 `{ ok, text?, code?, error? }`。
 */

import { transcribeAudioBlob, type ASRConfig } from '@/services/asr/manager'
import { usestore } from '@/store'

export interface PluginAsrTranscribeOptions {
  /** 识别语种，默认跟随 ASR 设置（zh / en / ja …） */
  language?: string
  /** 最多转写多少秒，默认 1800（30 分钟），上限 7200 */
  maxSeconds?: number
  /** 分片长度（秒），默认 30 */
  chunkSeconds?: number
  signal?: AbortSignal
  onProgress?: (progress: { done: number; total: number }) => void
}

export interface PluginAsrTranscribeResult {
  ok: boolean
  text?: string
  code?: string
  error?: string
}

export interface PluginAsrApi {
  /** 当前配置的引擎是否支持文件转写 */
  readonly available: boolean
  /** 不可用时的可读原因 */
  readonly reason: string
  /** 把音频 Blob / ArrayBuffer / Uint8Array 转成文字；失败不抛异常 */
  transcribe(audio: Blob | ArrayBuffer | Uint8Array, options?: PluginAsrTranscribeOptions): Promise<PluginAsrTranscribeResult>
}

const SUPPORTED: ReadonlySet<string> = new Set(['onnx-whisper', 'whisper-api', 'qwen3-asr'])

function readConfig(): ASRConfig | null {
  try {
    const store: any = usestore()
    const cfg = store?.AIconfig?.asr
    return cfg && typeof cfg === 'object' ? (cfg as ASRConfig) : null
  } catch {
    return null
  }
}

function reasonOf(config: ASRConfig | null): string {
  if (!config) return '还没有配置语音识别：请到「设置 → 语音 → 语音识别」选择引擎'
  if (!SUPPORTED.has(String(config.type))) {
    return `当前语音识别引擎（${config.type}）不支持文件转写；插件可用 ONNX Whisper / Whisper API / Qwen3-ASR`
  }
  return ''
}

export function createPluginAsrApi(): PluginAsrApi {
  return {
    get available() {
      const config = readConfig()
      return !!config && SUPPORTED.has(String(config.type))
    },

    get reason() {
      return reasonOf(readConfig())
    },

    async transcribe(audio, options = {}) {
      const config = readConfig()
      if (!config) return { ok: false, code: 'ASR_NOT_CONFIGURED', error: reasonOf(null) }
      if (!SUPPORTED.has(String(config.type))) {
        return { ok: false, code: 'ASR_ENGINE_UNSUPPORTED', error: reasonOf(config) }
      }
      try {
        const blob = audio instanceof Blob ? audio : new Blob([audio as BlobPart], { type: 'audio/mp4' })
        if (!blob.size) return { ok: false, code: 'ASR_EMPTY_AUDIO', error: '音频为空' }
        const text = await transcribeAudioBlob(blob, config, options)
        if (!text) return { ok: false, code: 'ASR_EMPTY', error: '没有识别到文字（可能是纯音乐或静音）' }
        return { ok: true, text }
      } catch (e: any) {
        return { ok: false, code: e?.code || 'ASR_FAILED', error: String(e?.message || e) }
      }
    },
  }
}
