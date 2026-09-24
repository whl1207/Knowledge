// src/services/asr/manager.ts
// ASR (Automatic Speech Recognition) 语音识别管理器

import { FunasrOnlineMicSession } from '@/services/asr/funasr-online-mic'
import { Qwen3SegmentMicSession } from '@/services/asr/qwen3-stream-mic'
import { runQwen3Gradio, toWav16k, type Qwen3GradioOptions } from '@/services/asr/qwen3-gradio'

export type ASRType = 'whisper-api' | 'whisper-local' | 'onnx-whisper' | 'qwen3-asr' | 'funasr-online'

export interface ASRConfig {
  type: ASRType
  language: string
  continuous: boolean
  autoSend: boolean
  // 标点校验模式（全局，对所有识别引擎生效）：none=无 / local=本地ct-punc / llm=大模型
  punctMode?: 'none' | 'local' | 'llm'
  puncDir?: string // 本地 ct-punc 标点模型目录（punctMode=local 时使用）
  shortcut: string
  whisper: {
    url: string
    api_key: string
    model: string
  }
  qwen3: {
    url: string
    api_key: string
    model: string
    // 接口协议：auto=按地址自动判断（.../audio/transcriptions → OpenAI 兼容，否则 Gradio 网页服务）
    protocol?: 'auto' | 'gradio' | 'openai'
    // Gradio（Qwen3-ASR 网页服务，API 名 /run）参数
    langDisp?: string // 语种选择（默认「自动识别」）
    returnTs?: boolean // 单词级时间戳
    splitPunc?: boolean // 跟随结果文本标点断句
    diarize?: boolean // 说话人角色识别
    maxChars?: number // 单行最大字符数
    // 识别方式：whole=整段（松手后一次识别）/ segment=流式（VAD 分段准实时，边说边出）
    mode?: 'whole' | 'segment'
    // 分段模式参数（mode=segment 时生效）
    silenceMs?: number // 停顿多久切段（默认 800ms）
    overlapMs?: number // 切点重叠（默认 300ms）
    maxSegmentMs?: number // 单段最长（默认 15000ms，上限 180000ms = 3 分钟）
  }
  onnx: {
    modelPath: string
    modelLoaded: boolean
    loading: boolean
    loadProgress: number
    provider: string
    availableModels: Array<{
      name: string
      path: string
      size: string
    }>
  }
  funasr: {
    dir: string // FunASR online 模型目录（model_quant.onnx/decoder_quant.onnx/config.yaml/...）
    refineModel?: string // 可选：离线单文件 onnx（如 sensevoice-small），松开时对整句做“两遍精修”；为空则跳过
    vad?: boolean // 能量 VAD 自动断句（说话停顿自动出句并继续听），默认 true
    punctMin?: number // 批处理标点阈值（字，punctMode=llm 时）；0=关闭批处理（逐句校验）
  }
}

export interface ASRResult {
  text: string
  isFinal: boolean
  confidence?: number
}

export type ASRStatus = 'idle' | 'listening' | 'processing' | 'error'

export type ASRCallback = {
  onResult?: (result: ASRResult) => void
  onStatusChange?: (status: ASRStatus) => void
  onError?: (error: string) => void
}

// 本地 ct-punc 标点引擎句柄缓存（按模型目录缓存；目录变化重建并释放旧实例）
let puncHandleCache: { dir: string; handle: import('@/services/asr/funasr-punc-ipc').FunasrPuncHandle } | null = null
// 进行中的加载（VAD 多句快速连发 / 多出口并发时只加载一次，避免模型重复读入内存）
let puncLoading: Promise<import('@/services/asr/funasr-punc-ipc').FunasrPuncHandle> | null = null

async function getFunasrPuncHandle(dir: string): Promise<import('@/services/asr/funasr-punc-ipc').FunasrPuncHandle> {
  if (puncHandleCache && puncHandleCache.dir === dir) return puncHandleCache.handle
  if (!puncLoading) {
    puncLoading = (async () => {
      if (puncHandleCache) {
        try { await puncHandleCache.handle.release() } catch (e) { /* ignore */ }
        puncHandleCache = null
      }
      const { loadFunasrPunc } = await import('@/services/asr/funasr-punc-ipc')
      const t0 = performance.now()
      const handle = await loadFunasrPunc({ dir })
      console.log(`[ASR][本地标点] 模型加载成功（${Math.round(performance.now() - t0)}ms）：${dir}`)
      puncHandleCache = { dir, handle }
      return handle
    })().finally(() => { puncLoading = null })
  }
  return puncLoading
}

// 按 asr.punctMode 对最终识别文本做标点校验：
//   none  → 原样返回；local → 本地 ct-punc 离线补标点（需配置全局 asr.puncDir，任意引擎）；
//   llm   → 大模型错字修正+补标点（需已连接大模型）。供 ASRManager.stop() 与 VAD 自动断句统一调用。
async function maybePolishText(config: ASRConfig, text: string): Promise<string> {
  if (!text) return text
  // ① 本地 ct-punc（punctMode=local，任意引擎）：离线补标点
  const puncDir = config.punctMode === 'local' ? config.puncDir : ''
  if (puncDir) {
    try {
      const handle = await getFunasrPuncHandle(puncDir)
      const t0 = performance.now()
      const punctuated = await handle.punctuate(text)
      if (punctuated && punctuated.trim() && punctuated.trim() !== text.trim()) {
        text = punctuated.trim()
        console.log(`[ASR][本地标点] ${text.length}→${punctuated.trim().length} 字（${Math.round(performance.now() - t0)}ms）：${punctuated.trim()}`)
      } else {
        console.warn(`[ASR][本地标点] 输出未变化（${Math.round(performance.now() - t0)}ms）：${punctuated?.trim() || ''}`)
      }
    } catch (e) {
      console.error('[ASR][本地标点] 处理失败，使用原文:', e)
    }
  }
  // ② 大模型校验（punctMode=llm；失败静默返回原文）
  if (config.punctMode !== 'llm') return text
  try {
    const { usestore } = await import('@/store')
    const store = usestore()
    const polished = await store.polishSpeechText(text)
    if (polished && polished.trim()) return polished.trim()
  } catch (e) {
    console.warn('[ASR] LLM 标点校验失败，使用原文:', e)
  }
  return text
}

// Whisper API 识别器 (OpenAI 兼容)
class WhisperAPIRecognizer {
  private config: ASRConfig
  private callbacks: ASRCallback
  private mediaRecorder: MediaRecorder | null = null
  private audioChunks: Blob[] = []
  private isRecording = false
  private stream: MediaStream | null = null

  constructor(config: ASRConfig, callbacks: ASRCallback) {
    this.config = config
    this.callbacks = callbacks
  }

  async start() {
    if (this.isRecording) return

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      this.mediaRecorder = new MediaRecorder(this.stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4'
      })
      this.audioChunks = []

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data)
        }
      }

      this.mediaRecorder.onstart = () => {
        this.isRecording = true
        this.callbacks.onStatusChange?.('listening')
      }

      this.mediaRecorder.onerror = (error) => {
        console.error('[ASR] 录音错误:', error)
        this.isRecording = false
        this.callbacks.onStatusChange?.('error')
      }

      this.mediaRecorder.start()
    } catch (error: any) {
      console.error('[ASR] 获取麦克风权限失败:', error)
      this.callbacks.onError?.(`无法访问麦克风: ${error.message}`)
      this.callbacks.onStatusChange?.('error')
    }
  }

  async stop(): Promise<string> {
    return new Promise((resolve) => {
      if (!this.mediaRecorder || !this.isRecording) {
        this.cleanup()
        resolve('')
        return
      }

      this.mediaRecorder.onstop = async () => {
        this.isRecording = false
        this.callbacks.onStatusChange?.('processing')
        // ⚠️ cleanup() 会清空 audioChunks：必须先把录音数据与 mimeType 取出来再清理
        const chunks = this.audioChunks
        const mimeType = this.mediaRecorder?.mimeType || 'audio/webm'
        this.cleanup()

        if (chunks.length === 0) {
          resolve('')
          return
        }

        try {
          const audioBlob = new Blob(chunks, { type: mimeType })
          const transcription = await this.transcribeAudio(audioBlob)
          resolve(transcription)
        } catch (error: any) {
          console.error('[ASR] 转录失败:', error)
          this.callbacks.onError?.(`转录失败: ${error.message}`)
          resolve('')
        }
      }

      this.mediaRecorder.stop()
    })
  }

  private async transcribeAudio(audioBlob: Blob): Promise<string> {
    const formData = new FormData()
    formData.append('file', audioBlob, 'recording.webm')
    formData.append('model', this.config.whisper.model || 'whisper-1')
    formData.append('language', this.config.language?.split('-')[0] || 'zh')
    formData.append('response_format', 'json')

    const headers: Record<string, string> = {}
    if (this.config.whisper.api_key) {
      headers['Authorization'] = `Bearer ${this.config.whisper.api_key}`
    }

    const response = await fetch(this.config.whisper.url, {
      method: 'POST',
      headers,
      body: formData
    })

    if (!response.ok) {
      throw new Error(`Whisper API 错误: ${response.status} ${response.statusText}`)
    }

    const result = await response.json()
    return result.text || ''
  }

  abort() {
    if (this.mediaRecorder && this.isRecording) {
      try {
        this.mediaRecorder.stop()
      } catch (e) {
        // ignore
      }
    }
    this.isRecording = false
    this.cleanup()
  }

  destroy() {
    this.abort()
  }

  private cleanup() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop())
      this.stream = null
    }
    this.mediaRecorder = null
    this.audioChunks = []
  }

  getStatus() {
    if (this.isRecording) return 'listening'
    return 'idle'
  }

  isSupported(): boolean {
    return !!(navigator.mediaDevices?.getUserMedia)
  }
}

// （Qwen3-ASR 网页服务（Gradio）协议实现已抽到 qwen3-gradio.ts，整段与分段两条路径共用）

// Qwen3-ASR 识别器（Gradio 网页服务 /run 或 OpenAI 兼容端点：本地 vLLM / Docker / 云端）
// mode='whole' 整段（松手后一次识别）；mode='segment' 流式（VAD 分段准实时，边说边出）
class Qwen3ASRRecognizer {
  private config: ASRConfig
  private callbacks: ASRCallback
  private mediaRecorder: MediaRecorder | null = null
  private audioChunks: Blob[] = []
  private isRecording = false
  private stream: MediaStream | null = null
  private seg: Qwen3SegmentMicSession | null = null // 分段准流式会话（mode=segment）

  constructor(config: ASRConfig, callbacks: ASRCallback) {
    this.config = config
    this.callbacks = callbacks
  }

  // 是否走分段准流式：仅 Gradio 网页服务支持（OpenAI 兼容端点没有 /run 接口）
  private useSegment(): boolean {
    return this.config.qwen3.mode === 'segment' && this.useGradio()
  }

  // 传给网页服务的入参（每次现取，设置改了立即生效）
  private gradioOpts(): Qwen3GradioOptions {
    const q = this.config.qwen3
    return {
      base: q.url,
      apiKey: q.api_key,
      langDisp: q.langDisp,
      returnTs: q.returnTs,
      splitPunc: q.splitPunc,
      diarize: q.diarize,
      maxChars: q.maxChars,
    }
  }

  // 分段会话（懒建 + 复用采集图）
  private ensureSegmentSession(): Qwen3SegmentMicSession {
    if (this.seg) return this.seg
    const q = this.config.qwen3
    this.seg = new Qwen3SegmentMicSession(() => this.gradioOpts(), {
      onSegmentFinal: (text) => {
        if (!text) return
        // 逐句即时校验（none=原文 / local=本地标点 / llm=逐句大模型），与 funasr-online 同套路
        void maybePolishText(this.config, text).then((final) => {
          this.callbacks.onResult?.({ text: final, isFinal: true })
        })
      },
      onStatus: (s) => {
        if (s === 'listening') this.callbacks.onStatusChange?.('listening')
        else if (s === 'processing') this.callbacks.onStatusChange?.('processing')
        // idle 统一由 ASRManager.stop() 在最终文本分发后发出
      },
      onError: (msg) => this.callbacks.onError?.(msg),
    }, {
      silenceMs: q.silenceMs,
      overlapMs: q.overlapMs,
      maxSegmentMs: q.maxSegmentMs,
    })
    return this.seg
  }

  // 仅预热麦克风采集图（分段模式：消除按住说话时开头的丢失）
  async warmupAudio(): Promise<void> {
    if (!this.useSegment()) return
    try { await this.ensureSegmentSession().warmupMic() } catch (e) { /* 预热失败静默 */ }
  }

  async start() {
    if (this.useSegment()) {
      await this.ensureSegmentSession().start()
      return
    }
    if (this.isRecording) return

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      this.mediaRecorder = new MediaRecorder(this.stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4'
      })
      this.audioChunks = []

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data)
        }
      }

      this.mediaRecorder.onstart = () => {
        this.isRecording = true
        this.callbacks.onStatusChange?.('listening')
      }

      this.mediaRecorder.onerror = (error) => {
        console.error('[Qwen3-ASR] 录音错误:', error)
        this.isRecording = false
        this.callbacks.onStatusChange?.('error')
      }

      this.mediaRecorder.start()
    } catch (error: any) {
      console.error('[Qwen3-ASR] 获取麦克风权限失败:', error)
      this.callbacks.onError?.(`无法访问麦克风: ${error.message}`)
      this.callbacks.onStatusChange?.('error')
    }
  }

  async stop(): Promise<string> {
    if (this.useSegment()) {
      // 尾段文本由会话返回（不走 onSegmentFinal），交给 ASRManager.stop() 统一校验 + 分发
      return this.seg ? this.seg.stop() : ''
    }
    return new Promise((resolve) => {
      if (!this.mediaRecorder || !this.isRecording) {
        this.cleanup()
        resolve('')
        return
      }

      this.mediaRecorder.onstop = async () => {
        this.isRecording = false
        this.callbacks.onStatusChange?.('processing')
        // ⚠️ cleanup() 会清空 audioChunks：必须先把录音数据与 mimeType 取出来再清理
        const chunks = this.audioChunks
        const mimeType = this.mediaRecorder?.mimeType || 'audio/webm'
        this.cleanup()

        if (chunks.length === 0) {
          resolve('')
          return
        }

        try {
          const audioBlob = new Blob(chunks, { type: mimeType })
          const transcription = await this.transcribeAudio(audioBlob)
          resolve(transcription)
        } catch (error: any) {
          console.error('[Qwen3-ASR] 转录失败:', error)
          this.callbacks.onError?.(`转录失败: ${error.message}`)
          resolve('')
        }
      }

      this.mediaRecorder.stop()
    })
  }

  private async transcribeAudio(audioBlob: Blob): Promise<string> {
    return this.useGradio() ? this.transcribeGradio(audioBlob) : this.transcribeOpenAI(audioBlob)
  }

  // 是否走 Gradio 网页服务协议：protocol 显式指定优先；auto 时按地址判断
  private useGradio(): boolean {
    const p = this.config.qwen3.protocol || 'auto'
    if (p === 'gradio') return true
    if (p === 'openai') return false
    const url = (this.config.qwen3.url || '').trim()
    if (!url) return false
    try {
      const fixed = /^https?:\/\//i.test(url) ? url : `http://${url}`
      const path = new URL(fixed).pathname.replace(/\/+$/, '')
      return !/\/audio\/transcriptions$/.test(path)
    } catch {
      return false
    }
  }

  // OpenAI 兼容端点（vLLM / Docker / 云端）：multipart 表单直传
  private async transcribeOpenAI(audioBlob: Blob): Promise<string> {
    const formData = new FormData()
    formData.append('file', audioBlob, 'recording.webm')
    formData.append('model', this.config.qwen3.model || 'Qwen/Qwen3-ASR-1.7B')
    // Qwen3-ASR 自动语种识别；仅在用户显式指定语言（非 auto）时强制 language
    const lang = (this.config.language || 'auto').split('-')[0]
    if (lang && lang !== 'auto') {
      formData.append('language', lang)
    }
    formData.append('response_format', 'json')

    const headers: Record<string, string> = {}
    if (this.config.qwen3.api_key) {
      headers['Authorization'] = `Bearer ${this.config.qwen3.api_key}`
    }

    const response = await fetch(this.config.qwen3.url, {
      method: 'POST',
      headers,
      body: formData
    })

    if (!response.ok) {
      throw new Error(`Qwen3-ASR 错误: ${response.status} ${response.statusText}`)
    }

    const result = await response.json()
    return result.text || ''
  }

  // Gradio 网页服务（Qwen3-ASR WebUI，API 名 /run）：整段模式的一次性识别
  // 上传音频 → POST /call/run 取 event_id → 读取 SSE 结果（输出 [1] 为识别文本）
  private async transcribeGradio(audioBlob: Blob): Promise<string> {
    // 录音多为 webm/opus：统一转 16k 单声道 WAV，转码失败则原样上传
    const audio = await toWav16k(audioBlob).catch(() => audioBlob)
    const fileName = audio.type === 'audio/wav' ? 'recording.wav' : 'recording.webm'
    const text = await runQwen3Gradio(this.gradioOpts(), audio, fileName)
    if (!text) throw new Error('识别结果为空')
    return text
  }

  abort() {
    if (this.mediaRecorder && this.isRecording) {
      try {
        this.mediaRecorder.stop()
      } catch (e) {
        // ignore
      }
    }
    this.isRecording = false
    this.seg?.abort()
    this.cleanup()
  }

  destroy() {
    this.abort()
    if (this.seg) {
      try { void this.seg.destroy() } catch (e) { /* ignore */ }
      this.seg = null
    }
  }

  private cleanup() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop())
      this.stream = null
    }
    this.mediaRecorder = null
    this.audioChunks = []
  }

  getStatus() {
    if (this.seg?.isRecording) return 'listening'
    if (this.isRecording) return 'listening'
    return 'idle'
  }

  isSupported(): boolean {
    return !!(navigator.mediaDevices?.getUserMedia)
  }
}

// 本地 Whisper 识别器 (通过 Python 服务)
class WhisperLocalRecognizer {
  private config: ASRConfig
  private callbacks: ASRCallback
  private mediaRecorder: MediaRecorder | null = null
  private audioChunks: Blob[] = []
  private isRecording = false
  private stream: MediaStream | null = null

  constructor(config: ASRConfig, callbacks: ASRCallback) {
    this.config = config
    this.callbacks = callbacks
  }

  async start() {
    if (this.isRecording) return

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      this.mediaRecorder = new MediaRecorder(this.stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4'
      })
      this.audioChunks = []

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data)
        }
      }

      this.mediaRecorder.onstart = () => {
        this.isRecording = true
        this.callbacks.onStatusChange?.('listening')
      }

      this.mediaRecorder.onerror = (error) => {
        console.error('[ASR] 录音错误:', error)
        this.isRecording = false
        this.callbacks.onStatusChange?.('error')
      }

      this.mediaRecorder.start()
    } catch (error: any) {
      console.error('[ASR] 获取麦克风权限失败:', error)
      this.callbacks.onError?.(`无法访问麦克风: ${error.message}`)
      this.callbacks.onStatusChange?.('error')
    }
  }

  async stop(): Promise<string> {
    return new Promise((resolve) => {
      if (!this.mediaRecorder || !this.isRecording) {
        this.cleanup()
        resolve('')
        return
      }

      this.mediaRecorder.onstop = async () => {
        this.isRecording = false
        this.callbacks.onStatusChange?.('processing')
        // ⚠️ cleanup() 会清空 audioChunks：必须先把录音数据与 mimeType 取出来再清理
        const chunks = this.audioChunks
        const mimeType = this.mediaRecorder?.mimeType || 'audio/webm'
        this.cleanup()

        if (chunks.length === 0) {
          resolve('')
          return
        }

        try {
          const audioBlob = new Blob(chunks, { type: mimeType })
          const transcription = await this.transcribeLocal(audioBlob)
          resolve(transcription)
        } catch (error: any) {
          console.error('[ASR] 本地转录失败:', error)
          this.callbacks.onError?.(`转录失败: ${error.message}`)
          resolve('')
        }
      }

      this.mediaRecorder.stop()
    })
  }

  private async transcribeLocal(audioBlob: Blob): Promise<string> {
    // 通过 IPC 调用本地 Python Whisper 服务
    try {
      // 将音频 blob 转换为 base64
      const buffer = await audioBlob.arrayBuffer()
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)))
      
      const result = await (window as any).ipcRenderer.invoke('transcribeAudio', {
        audioData: base64,
        mimeType: audioBlob.type,
        language: this.config.language || 'zh-CN'
      })

      if (result.success) {
        return result.text
      } else {
        throw new Error(result.error || '转录失败')
      }
    } catch (error: any) {
      // 如果 IPC 调用失败，尝试使用 Whisper API 作为备选
      console.warn('[ASR] 本地转录失败，尝试 API 备选:', error.message)
      this.callbacks.onError?.(error.message)
      return ''
    }
  }

  abort() {
    if (this.mediaRecorder && this.isRecording) {
      try {
        this.mediaRecorder.stop()
      } catch (e) {
        // ignore
      }
    }
    this.isRecording = false
    this.cleanup()
  }

  destroy() {
    this.abort()
  }

  private cleanup() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop())
      this.stream = null
    }
    this.mediaRecorder = null
    this.audioChunks = []
  }

  getStatus() {
    if (this.isRecording) return 'listening'
    return 'idle'
  }

  isSupported(): boolean {
    return !!(navigator.mediaDevices?.getUserMedia)
  }
}

// ONNX Whisper 本地语音识别器（使用 onnxruntime-web 在浏览器端运行 Whisper）
class OnnxWhisperRecognizer {
  private config: ASRConfig
  private callbacks: ASRCallback
  private mediaRecorder: MediaRecorder | null = null
  private audioChunks: Float32Array[] = []
  private isRecording = false
  private stream: MediaStream | null = null
  // 复用的麦克风流：避免每次按住都重新开启设备（设备启动有延迟，会导致开头语音丢失）
  private cachedStream: MediaStream | null = null
  // 常驻音频采集图（AudioContext + ScriptProcessor）：创建一次、持续复用。
  // 避免每次按住都 new AudioContext + await resume()（重建有几百 ms 延迟 → 开头语音丢失）
  private persistentContext: AudioContext | null = null
  private persistentSource: MediaStreamAudioSourceNode | null = null
  private persistentProcessor: ScriptProcessorNode | null = null
  // Web Worker：承载 ORT 会话与推理，避免阻塞主线程（解决识别时 UI/动画卡死）
  private worker: Worker | null = null
  private nextMsgId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()
  private sessionInitPromise: Promise<any> | null = null
  private inputNames: string[] = []
  private outputNames: string[] = []
  private inputMetadata: Record<string, any> = {}
  private modelReady = false
  private initPromise: Promise<void> | null = null
  private tokenMap: Map<number, string> = new Map()
  private mvnLoaded = false
  private mvnMean: Float32Array | null = null
  private mvnScale: Float32Array | null = null
  // SenseVoice：单模型、输出带 <|...|> 特殊 token；
  // 特征维度：sherpa-onnx 导出=80 维，FunASR 原生（iic model_quant.onnx）=560 维
  private isSenseVoice = false
  private senseVoiceFeatDim = 80

  // Whisper 模型参数
  private readonly SAMPLE_RATE = 16000
  private readonly N_FFT = 400
  private readonly HOP_LENGTH = 160
  private readonly N_MELS = 80
  
  // 语言到 token ID 映射
  private readonly langTokens: Record<string, number> = {
    'zh': 50285, 'en': 50259, 'ja': 50266, 'ko': 50264,
    'fr': 50265, 'de': 50267, 'es': 50268, 'ru': 50263
  }

  constructor(config: ASRConfig, callbacks: ASRCallback) {
    this.config = config
    this.callbacks = callbacks
  }

  // 初始化 ONNX Runtime 和加载模型
  async init() {
    if (this.initPromise) return this.initPromise
    
    this.initPromise = this._init()
    return this.initPromise
  }

  private async _init() {
    try {
      // 不设 processing 状态——模型在后台静默加载，不干扰录音状态
      
      const modelPath = this.config.onnx.modelPath
      if (!modelPath) {
        throw new Error('未设置 ONNX 模型路径，请在设置中配置')
      }

      // 在 Web Worker 中加载 onnxruntime-web 并创建推理会话（不阻塞主线程）
      const info = await this.initSessionInWorker(modelPath)
      this.inputNames = info.inputNames || []
      this.outputNames = info.outputNames || []
      this.inputMetadata = info.inputMetadata || {}

      // 识别 SenseVoice（文件名含 sense）：输出带 <|...|> 标签
      this.isSenseVoice = modelPath.toLowerCase().includes('sense')
      if (this.isSenseVoice) {
        // FunASR 原生导出（如 iic 的 model_quant.onnx）：560 维特征 + am.mvn + tokens.json；
        // sherpa-onnx 导出：80 维特征 + tokens.txt、无 am.mvn
        try { await this.loadMVN(modelPath) } catch (e) { /* 无 am.mvn → sherpa-onnx 80 维 */ }
        this.senseVoiceFeatDim = this.mvnLoaded ? 560 : 80
        console.log(`[ONNX-ASR] SenseVoice 特征维度: ${this.senseVoiceFeatDim} (mvnLoaded=${this.mvnLoaded})`)
      }

      // 加载 CMVN 和 tokenizer
      try {
        if (!this.isSenseVoice) {
          await this.loadMVN(modelPath)
        }
        await this.loadTokenizer(modelPath)
      } catch (e) {
        console.warn('[ONNX-ASR] 辅助文件加载警告:', (e as any).message)
      }

      // 所有初始化（CMVN/tokenizer 等）全部完成后才置 modelReady，
      // 避免 stop() 在 modelReady=true 后立即推理时 CMVN/特征维度尚未就绪的竞态
      this.modelReady = true
      // 不通知状态变化——模型在后台静默加载，不影响录音状态
      console.log('[ONNX-ASR] 模型加载成功:', modelPath)
      
    } catch (error: any) {
      console.error('[ONNX-ASR] 初始化失败:', error)
      this.modelReady = false
      this.callbacks.onError?.(`ONNX 模型加载失败: ${error.message}`)
      // 不通知状态变化——模型加载错误不应影响录音状态
      throw error
    }
  }

  // ===== Web Worker 推理通道 =====

  // 创建/复用 ONNX 推理 worker（懒创建）
  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./asr-onnx-worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (e: MessageEvent) => {
        const msg = e.data
        const p = msg && msg.id ? this.pending.get(msg.id) : undefined
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.type === 'init-error' || msg.type === 'run-error') {
          p.reject(new Error(msg.message || 'ASR worker 错误'))
        } else {
          p.resolve(msg)
        }
      }
      this.worker.onerror = (e: ErrorEvent) => {
        const err = new Error(e.message || 'ASR worker 错误')
        for (const p of this.pending.values()) p.reject(err)
        this.pending.clear()
      }
    }
    return this.worker
  }

  // 向 worker 发送请求并等待响应
  private requestWorker(type: string, payload: any, transfer?: Transferable[]): Promise<any> {
    const id = this.nextMsgId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        const worker = this.getWorker()
        const msg = { type, id, ...payload }
        if (transfer && transfer.length) worker.postMessage(msg, transfer)
        else worker.postMessage(msg)
      } catch (e) {
        this.pending.delete(id)
        reject(e)
      }
    })
  }

  // 在 worker 中创建 ONNX session（成功后缓存，供后续复用）
  private initSessionInWorker(modelPath: string): Promise<any> {
    if (this.sessionInitPromise) return this.sessionInitPromise
    this.sessionInitPromise = this.requestWorker('init', { modelPath }).catch((e) => {
      this.sessionInitPromise = null
      throw e
    })
    return this.sessionInitPromise
  }

  // 将 worker 返回的 ArrayBuffer 按张量类型还原为 TypedArray
  private toTypedArray(type: string, buf: ArrayBuffer): any {
    switch (type) {
      case 'float32': return new Float32Array(buf)
      case 'float64': return new Float64Array(buf)
      case 'int32': return new Int32Array(buf)
      case 'int64': return new BigInt64Array(buf)
      case 'uint8': return new Uint8Array(buf)
      case 'int8': return new Int8Array(buf)
      case 'uint16': return new Uint16Array(buf)
      case 'int16': return new Int16Array(buf)
      case 'uint32': return new Uint32Array(buf)
      case 'bool': return new Uint8Array(buf)
      default: return new Float32Array(buf)
    }
  }

  private initPromiseLocal: Promise<void> | null = null

  async start() {
    if (this.isRecording) return

    // 先开始录音，不等待模型加载
    try {
      // 复用常驻音频采集图（首次才创建）；创建失败则视为麦克风不可用
      await this.warmupAudio()
      if (!this.persistentProcessor) {
        throw new Error('音频采集图初始化失败')
      }
      // 若上下文处于 suspended（如预热阶段未获得用户手势而暂停），此处再次尝试恢复
      if (this.persistentContext && this.persistentContext.state === 'suspended') {
        await this.persistentContext.resume()
      }

      this.stream = this.cachedStream
      // 清空上一轮残留音频，从此刻开始累积（采集图常驻，onaudioprocess 一直在跑）
      this.audioChunks = []
      this.mediaRecorder = null
      this.isRecording = true
      // 兼容 stop() 判定路径
      ;(this as any)._audioContext = this.persistentContext
      ;(this as any)._audioChunks = this.audioChunks

      this.callbacks.onStatusChange?.('listening')

      // 后台加载模型（不阻塞录音）
      if (!this.modelReady) {
        this.initPromiseLocal = this.init()
        this.initPromiseLocal.catch(() => {}) // 错误由 init 内部处理
      }

    } catch (error: any) {
      console.error('[ONNX-ASR] 获取麦克风失败:', error)
      this.callbacks.onError?.(`无法访问麦克风: ${error.message}`)
      this.callbacks.onStatusChange?.('error')
    }
  }

  private audioWarmupPromise: Promise<void> | null = null

  // 预热/创建常驻音频采集图（获取麦克风 + AudioContext + ScriptProcessor 连接并保持运行）。
  // 不加载模型——模型仍按需在 start() 后台加载；预热成功后每次按住都立即开始录音。
  async warmupAudio(): Promise<void> {
    // 并发保护：避免重复创建（预热与 start() 可能同时触发）
    if (this.audioWarmupPromise) return this.audioWarmupPromise
    this.audioWarmupPromise = this._warmupAudioImpl()
    try {
      await this.audioWarmupPromise
    } finally {
      this.audioWarmupPromise = null
    }
  }

  private async _warmupAudioImpl(): Promise<void> {
    // 已就绪：仅确保上下文恢复运行（如被系统暂停）
    if (this.persistentProcessor) {
      if (this.persistentContext && this.persistentContext.state === 'suspended') {
        try { await this.persistentContext.resume() } catch (e) { /* 忽略 */ }
      }
      return
    }
    try {
      // 复用已获得的麦克风流，避免每次按住都重新开启设备（设备启动延迟会导致开头语音丢失）
      if (!this.cachedStream || !this.cachedStream.getAudioTracks().some(t => t.readyState === 'live')) {
        this.cachedStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: this.SAMPLE_RATE,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true
          }
        })
      }
      this.stream = this.cachedStream

      // 使用 AudioContext 进行音频处理
      const audioContext = new AudioContext({ sampleRate: this.SAMPLE_RATE })
      // 确保 AudioContext 处于运行状态（某些环境默认 suspended，会导致开头音频不进入录音缓冲）
      if (audioContext.state === 'suspended') {
        try { await audioContext.resume() } catch (e) { /* start() 会再次尝试 */ }
      }
      const source = audioContext.createMediaStreamSource(this.stream!)
      // 用较小的缓冲（1024=64ms），减少首个音频块等待时间
      const processor = audioContext.createScriptProcessor(1024, 1, 1)

      processor.onaudioprocess = (event) => {
        // 常驻运行时仅在录音状态下累积音频（避免空闲时内存无限增长）
        if (this.isRecording) {
          const inputData = event.inputBuffer.getChannelData(0)
          this.audioChunks.push(new Float32Array(inputData))
        }
      }

      source.connect(processor)
      // ScriptProcessor 必须连到 destination 才会持续触发 onaudioprocess；
      // 为避免把麦克风声音实时外放（回声/啸叫），经 0 增益 GainNode 静音后输出
      const silentGain = audioContext.createGain()
      silentGain.gain.value = 0
      processor.connect(silentGain)
      silentGain.connect(audioContext.destination)

      this.persistentContext = audioContext
      this.persistentSource = source
      this.persistentProcessor = processor
    } catch (error: any) {
      console.warn('[ONNX-ASR] 音频采集图初始化失败（首次录音时会重试）:', error.message)
      throw error
    }
  }

  async stop(): Promise<string> {
    if (!this.isRecording) return ''
    // 使用常驻 AudioContext 模式
    return this.stopWithAudioContext()
  }

  private async stopWithAudioContext(): Promise<string> {
    const audioChunks = this.audioChunks

    this.isRecording = false
    this.callbacks.onStatusChange?.('processing')

    // 保留常驻音频采集图与麦克风流（cachedStream）以便复用：
    // 不 close AudioContext、不 stop tracks——否则下次按住重建会有几百 ms 延迟导致开头语音丢失
    this.stream = null

    try {
      if (audioChunks.length === 0) return ''

      // 合并所有音频数据
      const totalLength = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0)
      const audioData = new Float32Array(totalLength)
      let offset = 0
      for (const chunk of audioChunks) {
        audioData.set(chunk, offset)
        offset += chunk.length
      }

      // 确保模型已加载（等待后台加载完成）
      if (!this.modelReady && this.initPromiseLocal) {
        await this.initPromiseLocal
      }
      if (!this.modelReady) {
        this.callbacks.onError?.('模型加载失败')
        return ''
      }

      // 执行推理
      const text = await this.runInference(audioData)
      return text

    } catch (error: any) {
      console.error('[ONNX-ASR] 音频处理失败:', error)
      this.callbacks.onError?.(`音频处理失败: ${error.message}`)
      return ''
    }
  }

  // 执行 ONNX 推理
  private async runInference(audioData: Float32Array): Promise<string> {
    if (!this.modelReady || !this.worker) {
      throw new Error('模型未加载')
    }

    try {
      // 1. 音频预处理 - 重采样到 16kHz
      const resampled = this.resampleAudio(audioData, this.SAMPLE_RATE)
      
      // 2. 提取 80 维 Mel 频谱特征
      // 样本范围：Paraformer/SenseVoice 期望 [-32768, 32767]（sherpa-onnx normalize_samples=0，需 ×32768），
      // Whisper 期望 [-1,1]，保持原样
      const modelPathLower = this.config.onnx.modelPath.toLowerCase()
      const sampleScale = modelPathLower.includes('whisper') ? 1 : 32768
      const melSpectrogram = this.computeMelSpectrogram(resampled, sampleScale)
      const nMels = 80
      const numFrames = Math.floor(melSpectrogram.length / nMels)
      if (numFrames === 0) {
        throw new Error('音频太短，无法提取特征')
      }
      
      // 3. 特征：Paraformer 与 FunASR 原生 SenseVoice 用 560 维（LFR 7 帧拼接 + CMVN）；
      //    sherpa-onnx 导出的 SenseVoice 用 80 维 fbank
      let featureData: Float32Array
      let featureDim: number
      let featureFrames = numFrames
      if (this.isSenseVoice && this.senseVoiceFeatDim === 80) {
        featureData = melSpectrogram
        featureDim = nMels // 80
      } else {
        // LFR：前向 7 帧窗口、步长 6 → 560 维；确保 CMVN 已加载
        if (!this.mvnLoaded) {
          await this.loadMVN(this.config.onnx.modelPath)
        }
        featureData = this.spliceContext(melSpectrogram, numFrames, nMels)
        featureDim = 560
        featureFrames = featureData.length / featureDim
      }

      // 4. 获取模型输入信息（含各输入声明的数据类型）
      const inputNames = this.inputNames
      const inputMetadata = this.inputMetadata
      // 从元数据解析张量元素类型：'tensor(int32)' → 'int32'
      const inputElemType = (name: string): string => {
        const meta = inputMetadata[name]
        if (meta && meta.type) {
          const m = /tensor\((\w+)\)/.exec(String(meta.type))
          if (m) return m[1]
        }
        return ''
      }

      // 4. 构建 feeds（plain 对象，交由 worker 包装成 ort.Tensor）
      const feeds: Record<string, any> = {}
      
      for (const name of inputNames) {
        const lower = name.toLowerCase()
        const elemType = inputElemType(name)
        // FunASR 原生导出的 language/textnorm/speech_lengths 是 int32，sherpa-onnx 导出可能为 int64
        const isInt64 = elemType === 'int64'
        
        // ⚠️ 必须先检查 length，再检查 speech/feature！
        // speech_lengths 包含 'speech'，若先匹配 speech 会错误地当作特征输入
        if (lower.includes('length') || lower.includes('len')) {
          // 音频长度输入 - 实际帧数（LFR 后）
          feeds[name] = isInt64
            ? { type: 'int64', data: BigInt64Array.from([BigInt(featureFrames)]), dims: [1] }
            : { type: 'int32', data: Int32Array.from([featureFrames]), dims: [1] }
        } else if (lower.includes('feature') || lower.includes('speech') || lower.includes('input') || lower.includes('mel')) {
          // 音频特征输入 - SenseVoice 用 80 维，其余用 560 维
          feeds[name] = { type: 'float32', data: featureData, dims: [1, featureFrames, featureDim] }
        } else if (lower.includes('language') || lower === 'lang') {
          // SenseVoice 语言输入（0=auto 1=zh 2=en 3=ja 4=ko 5=yue）
          const langId = this.getSenseVoiceLangId()
          feeds[name] = isInt64
            ? { type: 'int64', data: BigInt64Array.from([BigInt(langId)]), dims: [1] }
            : { type: 'int32', data: Int32Array.from([langId]), dims: [1] }
        } else if (lower.includes('textnorm') || lower.includes('use_itn') || lower === 'itn') {
          // SenseVoice 文本归一化开关（0=不归一化返回原文，1=启用 ITN；浏览器端无归一化模块恒填 0）
          feeds[name] = isInt64
            ? { type: 'int64', data: BigInt64Array.from([0n]), dims: [1] }
            : { type: 'int32', data: Int32Array.from([0]), dims: [1] }
        }
      }
      
      // 如果上面的匹配没覆盖任何输入，使用第一个输入名作为特征输入
      if (Object.keys(feeds).length === 0 && inputNames.length > 0) {
        console.warn('[ONNX-ASR] 无法识别输入名称，使用默认匹配')
        feeds[inputNames[0]] = { type: 'float32', data: featureData, dims: [1, featureFrames, featureDim] }
      }

      // 5. 把 feed 数据转移给 worker 做推理（session.run 在 worker 线程执行，不阻塞主线程）
      const transfer: Transferable[] = []
      for (const name of Object.keys(feeds)) {
        const data = feeds[name].data
        if (data instanceof ArrayBuffer) transfer.push(data)
        else if (data && data.buffer instanceof ArrayBuffer) transfer.push(data.buffer)
      }
      const resp = await this.requestWorker('run', { feeds }, transfer)

      // 6. 将输出张量数据还原为 TypedArray，供解码
      const results: Record<string, any> = {}
      for (const name of Object.keys(resp.results || {})) {
        const r = resp.results[name]
        results[name] = {
          type: r.type,
          dims: r.dims,
          data: this.toTypedArray(r.type, r.data)
        }
      }

      // 7. 解码输出
      const text = this.decodeOutput(results)
      return text
      
    } catch (error: any) {
      console.error('[ONNX-ASR] 推理失败:', error)
      throw error
    }
  }

  // 获取模型期望的输入帧数（通过试错或模型元数据）
  private getExpectedFrames(inputName: string): number {
    // 对于已知的 Paraformer 模型，期望 560 帧
    // 对于 Whisper 模型，期望可变长度（返回 0 表示不 pad）
    const modelPath = this.config.onnx.modelPath.toLowerCase()
    if (modelPath.includes('paraformer')) {
      return 560
    }
    
    return 0 // 0 表示不 pad
  }
  
  // 判断模型输入是否需要 int32 类型
  // INT8 量化模型（如 Paraformer int8）的输入需要 int32
  // 解码模型输出
  private decodeOutput(results: Record<string, any>): string {
    const outputNames = this.outputNames
    
    // SenseVoice 模型输出：单个 logits（batch, 1, seq, vocab），带 <|...|> 特殊 token
    if (this.isSenseVoice) {
      return this.decodeSenseVoiceOutput(results)
    }
    
    // Paraformer 模型输出: ['logits', 'token_num', 'us_alphas', 'us_cif_peak']
    // logits 形状: [batch, max_token_len, vocab_size]
    if (outputNames.includes('logits') && outputNames.includes('token_num')) {
      // 确保 tokenizer 已加载
      if (!this.tokenMap || this.tokenMap.size === 0) {
        this.loadTokenizer(this.config.onnx.modelPath).catch(() => {})
      }
      return this.decodeParaformerOutput(results)
    }
    
    // Whisper 模型输出: 单个输出 [batch, seq_len, vocab_size]
    // 使用贪心解码
    const outputName = outputNames[0]
    const outputData = results[outputName].data
    const tokens = this.greedyDecode(outputData)
    return this.decodeTokens(tokens)
  }

  // SenseVoice 语言 ID（0=auto 1=zh 2=en 3=ja 4=ko 5=yue）
  private getSenseVoiceLangId(): number {
    const lang = String(this.config.language || '').split('-')[0].toLowerCase()
    switch (lang) {
      case 'zh': return 1
      case 'en': return 2
      case 'ja': return 3
      case 'ko': return 4
      case 'yue': return 5
      default: return 0 // auto（含 fr/de/es/ru 等 SenseVoice 不支持的语言）
    }
  }

  // 解码 SenseVoice 输出（按输出维度自适应 vocab/seq，贪心+去重，剥离 <|...|> 标签）
  private decodeSenseVoiceOutput(results: Record<string, any>): string {
    try {
      const outputName = this.outputNames[0]
      const out = results[outputName]
      if (!out || !out.data) return ''
      const dims = out.dims || []
      const data = out.data
      // dims 形如 [batch, 1, seq, vocab] 或 [batch, seq, vocab]
      const vocabSize = dims.length ? dims[dims.length - 1] : 250000
      const seqLen = dims.length >= 2 ? dims[dims.length - 2] : Math.floor(data.length / vocabSize)

      // 贪心 argmax + 相邻去重（连续相同 token 只保留一个）
      const tokenIds: number[] = []
      let prev = -1
      for (let t = 0; t < seqLen; t++) {
        let best = 0
        let bestVal = -Infinity
        const base = t * vocabSize
        for (let v = 0; v < vocabSize && base + v < data.length; v++) {
          const val = data[base + v]
          if (val > bestVal) { bestVal = val; best = v }
        }
        if (best !== prev) { tokenIds.push(best); prev = best }
      }

      if (!this.tokenMap || this.tokenMap.size === 0) {
        this.loadTokenizer(this.config.onnx.modelPath).catch(() => {})
      }
      if (this.tokenMap.size > 0) {
        return this.decodeTokensWithMap(tokenIds)
      }
      return `[识别完成 ${tokenIds.length} tokens]`
    } catch (error: any) {
      console.error('[ONNX-ASR] SenseVoice 解码失败:', error.message)
      return '[解码失败]'
    }
  }

  // 加载 tokenizer（优先 tokens.txt，回退 FunASR 的 tokens.json）
  private async loadTokenizer(modelPath: string): Promise<void> {
    try {
      const sepIdx = Math.max(modelPath.lastIndexOf('\\'), modelPath.lastIndexOf('/'))
      const modelDir = modelPath.substring(0, sepIdx)
      const readLocal = async (file: string): Promise<string> => {
        if (!(window as any).ipcRenderer) throw new Error('非 Electron 环境')
        return await (window as any).ipcRenderer.invoke('readFile', file)
      }
      // readFile 对不存在的文件返回 "Error reading file: ..." 字符串，需视为未找到
      const readLocalContent = async (file: string): Promise<string | null> => {
        const content = await readLocal(file)
        if (!content || content.startsWith('Error reading file')) return null
        return content
      }

      // ① tokens.txt（sherpa-onnx 导出）
      try {
        const content = await readLocalContent(modelDir + '\\tokens.txt')
        if (content) {
          this.parseTxtTokenizer(content)
          console.log(`[ONNX-ASR] tokenizer(tokens.txt) 已加载: ${this.tokenMap.size} 个 token`)
          return
        }
      } catch { /* 继续尝试 tokens.json */ }

      // ② tokens.json（FunASR 原生导出，如 iic SenseVoiceSmall-onnx）
      try {
        const json = await readLocalContent(modelDir + '\\tokens.json')
        if (json) {
          this.parseJsonTokenizer(json)
          console.log(`[ONNX-ASR] tokenizer(tokens.json) 已加载: ${this.tokenMap.size} 个 token`)
        }
      } catch {
        console.warn('[ONNX-ASR] 未找到 tokens.txt / tokens.json')
      }
    } catch (error: any) {
      console.error('[ONNX-ASR] 加载 tokenizer 失败:', error.message)
    }
  }

  // 解析 sherpa-onnx 行式 tokens.txt（兼容 "token_string token_id" 成对与「每行一个 token、行号即 id」）
  private parseTxtTokenizer(content: string): void {
    const lines = content.split(/\r?\n/)
    this.tokenMap.clear()

    let pairCount = 0
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const lastSpace = trimmed.lastIndexOf(' ')
      if (lastSpace < 0) continue
      const tokenStr = trimmed.substring(0, lastSpace)
      const tokenId = parseInt(trimmed.substring(lastSpace + 1))
      if (!isNaN(tokenId)) {
        this.tokenMap.set(tokenId, tokenStr)
        pairCount++
      }
    }

    // 成对格式无效时回退：每行一个 token、行号即 id（保留 token 前导空格，如 " the"）
    if (pairCount === 0) {
      this.tokenMap.clear()
      lines.forEach((line, idx) => {
        if (line.trim()) this.tokenMap.set(idx, line.replace(/\r$/, ''))
      })
    }
  }

  // 解析 FunASR tokens.json（数组=行号即 id；对象兼容 token→id 与 id→token 两种方向）
  private parseJsonTokenizer(content: string): void {
    this.tokenMap.clear()
    const data = JSON.parse(content)
    if (Array.isArray(data)) {
      data.forEach((t, i) => { if (typeof t === 'string') this.tokenMap.set(i, t) })
      return
    }
    if (data && typeof data === 'object') {
      const entries = Object.entries(data)
      const numericKeys = entries.filter(([k]) => !isNaN(Number(k))).length
      const tokenFirst = numericKeys < entries.length / 2 // 键是 token、值是 id
      for (const [a, b] of entries) {
        if (tokenFirst) {
          const id = Number(b)
          if (typeof a === 'string' && !isNaN(id)) this.tokenMap.set(id, a)
        } else {
          const id = Number(a)
          if (typeof b === 'string' && !isNaN(id)) this.tokenMap.set(id, b)
        }
      }
    }
  }

  // 解码 Paraformer 输出
  private decodeParaformerOutput(results: Record<string, any>): string {
    try {
      const logits = results['logits']
      const tokenNum = results['token_num']
      
      // token_num 是模型预测的 token 数量
      const numTokens = Math.round(tokenNum.data[0])
      
      if (!logits || !logits.data || numTokens <= 0) {
        return ''
      }
      
      // logits 形状: [1, max_len, vocab_size]
      const logitsData = logits.data
      const dims = logits.dims
      const maxLen = dims ? dims[1] : numTokens
      const vocabSize = dims ? dims[2] : 8404
      
      // argmax 解码
      const tokenIds: number[] = []
      for (let t = 0; t < maxLen && tokenIds.length < numTokens; t++) {
        let maxIdx = 0
        let maxVal = -Infinity
        for (let v = 0; v < vocabSize; v++) {
          const val = logitsData[t * vocabSize + v]
          if (val > maxVal) {
            maxVal = val
            maxIdx = v
          }
        }
        tokenIds.push(maxIdx)
      }
      

      
      // 使用 tokenizer 解码
      if (this.tokenMap.size > 0) {
        return this.decodeTokensWithMap(tokenIds)
      }
      
      // 没有 tokenizer 时返回 token ID 列表
      return `[识别完成 ${tokenIds.length} tokens]`
    } catch (error: any) {
      console.error('[ONNX-ASR] Paraformer 解码失败:', error)
      return '[解码失败]'
    }
  }

  // 使用 tokenMap 解码 token ID 序列
  private decodeTokensWithMap(tokenIds: number[]): string {
    let result = ''
    let buffer = ''
    
    for (const id of tokenIds) {
      // 跳过特殊 token
      if (id === 0 || id === 1 || id === 2) continue
      
      const token = this.tokenMap.get(id)
      if (token === undefined) continue

      // 跳过 SenseVoice 标签 token（<|zh|>、<|NEUTRAL|>、<|Speech|> 等）
      if (/^<\|.*\|>$/.test(token)) continue
      
      // 处理 BPE 子词（@@ 后缀表示需要和下一个拼接）
      if (token.endsWith('@@')) {
        buffer += token.slice(0, -2) // 去掉 @@
      } else {
        buffer += token
        result += buffer
        buffer = ''
      }
    }
    
    result += buffer
    
    return result || '[空结果]'
  }

  // 加载 CMVN 归一化参数（Kaldi 文本格式，兼容单行/跨行/带标签行）
  private async loadMVN(modelPath: string): Promise<void> {
    try {
      const sepIdx = Math.max(modelPath.lastIndexOf('\\'), modelPath.lastIndexOf('/'))
      const modelDir = sepIdx >= 0 ? modelPath.substring(0, sepIdx) : ''
      const mvnPath = modelDir + '\\am.mvn'
      
      let content: string
      if ((window as any).ipcRenderer) {
        content = await (window as any).ipcRenderer.invoke('readFile', mvnPath)
      } else {
        console.warn('[ONNX-ASR] 非 Electron 环境，无法读取 am.mvn')
        return
      }
      if (!content || content.startsWith('Error reading file')) {
        console.warn('[ONNX-ASR] 未读取到 am.mvn:', mvnPath, '→', content?.slice(0, 80))
        return
      }
      if (content.includes('\0')) {
        console.warn('[ONNX-ASR] am.mvn 疑似二进制格式（含 NUL 字节），当前仅支持文本 Kaldi 格式')
        return
      }
      content = content.replace(/^\uFEFF/, '') // 去 BOM
      
      // 解析 CMVN（兼容标准 Kaldi 与 FunASR <Nnet> 两种格式）：
      //   ① 标准 Kaldi:  <AddShift> [ 1 2 3 ... ] </AddShift>（可单行或跨行矩阵）
      //   ② FunASR Nnet: <Nnet> <Splice> 560 560 / [ 0 ] / <AddShift> 560 560
      //                   <LearnRateCoef> 0 [ -8.31... ] </LearnRateCoef>（方括号内即 560 个值）
      // 策略：只收集方括号 [ ... ] 内的数字；遇新标签重置括号状态，避免维度行/学习率参数混入
      const lines = content.split(/\r?\n/)
      let parsingShift = false
      let parsingScale = false
      let bracketOpen = false
      const shiftValues: number[] = []
      const scaleValues: number[] = []
      
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        
        // 标签切换状态（不 continue——兼容 "<AddShift> [ ... ] </AddShift>" 单行紧凑格式）
        if (/^(<AddShift>|<Rescale>|<\/)/.test(trimmed)) {
          if (trimmed.startsWith('<AddShift>')) { parsingShift = true; parsingScale = false }
          else if (trimmed.startsWith('<Rescale>')) { parsingShift = false; parsingScale = true }
          else if (trimmed.startsWith('</')) { parsingShift = false; parsingScale = false }
          bracketOpen = false // 新标签：结束上一节的方括号段（FunASR 数字行可能无闭合 ]）
        }
        
        if (!parsingShift && !parsingScale) continue
        
        // 提取方括号内的内容（兼容跨行：左括号在前一行、右括号在后一行）
        const hasOpen = trimmed.includes('[')
        const hasClose = trimmed.includes(']')
        let inner = ''
        if (hasOpen && hasClose) {
          inner = trimmed.slice(trimmed.indexOf('[') + 1, trimmed.lastIndexOf(']'))
          bracketOpen = false
        } else if (hasOpen) {
          inner = trimmed.slice(trimmed.indexOf('[') + 1)
          bracketOpen = true
        } else if (bracketOpen) {
          inner = hasClose ? trimmed.slice(0, trimmed.lastIndexOf(']')) : trimmed
          if (hasClose) bracketOpen = false
        }
        
        // 空串过滤：''.split(/\s+/) 会产出空串，而 Number('')===0，会混入假 0
        const nums = inner.trim().split(/\s+/).filter(tk => tk !== '').map(Number).filter(n => !isNaN(n))
        if (parsingShift) shiftValues.push(...nums)
        else if (parsingScale) scaleValues.push(...nums)
      }
      
      if (shiftValues.length >= 560 && scaleValues.length >= 560) {
        this.mvnMean = new Float32Array(560)
        this.mvnScale = new Float32Array(560)
        for (let i = 0; i < 560; i++) {
          this.mvnMean[i] = -shiftValues[i]
          this.mvnScale[i] = scaleValues[i]
        }
        this.mvnLoaded = true
        console.log(`[ONNX-ASR] CMVN 已加载 (shift=${shiftValues.length}, scale=${scaleValues.length})`)
      } else {
        console.warn(`[ONNX-ASR] am.mvn 数值不足 560: shift=${shiftValues.length}, scale=${scaleValues.length}，将按 80 维处理`)
      }
    } catch (error: any) {
      console.warn('[ONNX-ASR] 加载 CMVN 失败:', error.message)
    }
  }

  // 上下文拼接（LFR：前向 7 帧窗口、步长 6，与 sherpa-onnx ApplyLfr 一致）：80 维 → 560 维 + CMVN 归一化
  private spliceContext(melData: Float32Array, numFrames: number, featDim: number): Float32Array {
    const windowSize = 7   // lfr_m
    const windowShift = 6  // lfr_n
    const outDim = windowSize * featDim // 560
    const numOutFrames = numFrames >= windowSize
      ? Math.floor((numFrames - windowSize) / windowShift) + 1
      : 0
    const result = new Float32Array(numOutFrames * outDim)
    
    for (let f = 0; f < numOutFrames; f++) {
      const srcStart = f * windowShift
      for (let c = 0; c < windowSize; c++) {
        const srcFrame = srcStart + c
        for (let m = 0; m < featDim; m++) {
          result[f * outDim + c * featDim + m] = melData[srcFrame * featDim + m]
        }
      }
    }
    
    // 应用 CMVN 归一化
    if (this.mvnLoaded && this.mvnMean && this.mvnScale) {
      for (let i = 0; i < result.length; i++) {
        const featIdx = i % outDim
        result[i] = (result[i] - this.mvnMean[featIdx]) * this.mvnScale[featIdx]
      }
    }
    
    return result
  }

  // 重采样音频
  private resampleAudio(audioData: Float32Array, targetSampleRate: number): Float32Array {
    // 如果已经是目标采样率，直接返回
    return audioData
  }

  // 计算 Mel 频谱图（使用 Mel 滤波器组）
  // sampleScale：Paraformer/SenseVoice 传 32768（样本转 [-32768, 32767]），Whisper 传 1
  private computeMelSpectrogram(audioData: Float32Array, sampleScale = 32768): Float32Array {
    const sampleRate = this.SAMPLE_RATE
    const frameLength = 400  // 25ms @ 16kHz
    const hopLength = 160    // 10ms @ 16kHz
    const fftSize = 512      // 2^9，零填充到 512
    const nMels = 80
    const lowHz = 20
    const highHz = 7600
    
    const numFrames = Math.floor((audioData.length - frameLength) / hopLength) + 1
    if (numFrames <= 0) return new Float32Array(0)
    
    // 构建 Mel 滤波器组
    // 将 Hz 转换为 Mel: mel = 2595 * log10(1 + hz/700)
    const melLow = 2595 * Math.log10(1 + lowHz / 700)
    const melHigh = 2595 * Math.log10(1 + highHz / 700)
    const melPoints = new Float32Array(nMels + 2)
    for (let i = 0; i < nMels + 2; i++) {
      melPoints[i] = melLow + (melHigh - melLow) / (nMels + 1) * i
    }
    
    // Mel → Hz: hz = 700 * (10^(mel/2595) - 1)
    const hzPoints = new Float32Array(nMels + 2)
    for (let i = 0; i < nMels + 2; i++) {
      hzPoints[i] = 700 * (Math.pow(10, melPoints[i] / 2595) - 1)
    }
    
    // Hz → FFT bin index
    const binPoints = new Float32Array(nMels + 2)
    for (let i = 0; i < nMels + 2; i++) {
      binPoints[i] = Math.floor((fftSize + 1) * hzPoints[i] / sampleRate)
    }
    
    // 构建三角滤波器权重
    const filterWeights: { start: number; center: number; end: number }[] = []
    for (let m = 0; m < nMels; m++) {
      filterWeights.push({
        start: binPoints[m],
        center: binPoints[m + 1],
        end: binPoints[m + 2]
      })
    }
    
    // Hamming 窗（与 sherpa-onnx 一致）
    const hannWindow = new Float32Array(frameLength)
    for (let i = 0; i < frameLength; i++) {
      hannWindow[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (frameLength - 1))
    }
    
    const melSpectrogram = new Float32Array(numFrames * nMels)
    
    for (let frame = 0; frame < numFrames; frame++) {
      const start = frame * hopLength
      
      // 加窗并零填充到 fftSize
      const windowed = new Float32Array(fftSize)
      for (let i = 0; i < frameLength; i++) {
        if (start + i < audioData.length) {
          windowed[i] = audioData[start + i] * sampleScale * hannWindow[i]
        }
      }
      
      // 计算功率谱（每个 FFT bin 的 |DFT|^2）
      const powerSpec = new Float32Array(fftSize / 2 + 1)
      for (let k = 0; k <= fftSize / 2; k++) {
        let real = 0, imag = 0
        for (let i = 0; i < fftSize; i++) {
          const angle = -2 * Math.PI * k * i / fftSize
          real += windowed[i] * Math.cos(angle)
          imag += windowed[i] * Math.sin(angle)
        }
        powerSpec[k] = real * real + imag * imag
      }
      
      // 应用 Mel 滤波器组到功率谱
      for (let mel = 0; mel < nMels; mel++) {
        const { start: fStart, center: fCenter, end: fEnd } = filterWeights[mel]
        let energy = 0
        
        for (let k = Math.ceil(fStart); k <= Math.floor(fEnd) && k < powerSpec.length; k++) {
          let weight = 0
          if (k <= fCenter) {
            weight = fCenter === fStart ? 1 : (k - fStart) / (fCenter - fStart)
          } else {
            weight = fEnd === fCenter ? 1 : (fEnd - k) / (fEnd - fCenter)
          }
          energy += powerSpec[k] * weight
        }
        
        melSpectrogram[frame * nMels + mel] = Math.log(Math.max(energy, 1e-10))
      }
    }
    
    return melSpectrogram
  }

  // 贪心解码
  private greedyDecode(outputData: Float32Array | number[]): number[] {
    const tokens: number[] = []
    const outputArray = Array.isArray(outputData) ? outputData : Array.from(outputData)
    
    // 简化的贪心解码：取每帧概率最高的 token
    const vocabSize = 51865 // Whisper 词汇表大小
    const numFrames = Math.floor(outputArray.length / vocabSize)
    
    let prevToken = -1
    for (let frame = 0; frame < numFrames && frame < 448; frame++) {
      const start = frame * vocabSize
      let maxProb = -Infinity
      let maxIdx = 0
      
      for (let i = 0; i < Math.min(vocabSize, outputArray.length - start); i++) {
        if (outputArray[start + i] > maxProb) {
          maxProb = outputArray[start + i]
          maxIdx = i
        }
      }
      
      // 跳过重复的 token
      if (maxIdx !== prevToken) {
        tokens.push(maxIdx)
        prevToken = maxIdx
      }
    }
    
    return tokens
  }

  // 解码 token 为文本（简化版本）
  private decodeTokens(tokens: number[]): string {
    // 过滤掉特殊 token
    const specialTokens = new Set([
      50256, // <|endoftext|>
      50257, // <|startoftranscript|>
      50258, // <|transcribe|>
      50259, // <|en|>
      50362, // <|notimestamps|>
      50363, // <|endofprompt|>
    ])
    
    // 添加语言 token
    const lang = this.config.language?.split('-')[0] || 'zh'
    if (this.langTokens[lang]) {
      specialTokens.add(this.langTokens[lang])
    }
    
    // 添加数字范围内的特殊 token
    for (let i = 50364; i <= 51000; i++) {
      specialTokens.add(i)
    }
    
    const filteredTokens = tokens.filter(t => !specialTokens.has(t) && t < 51865)
    
    // 返回 token ID 列表（实际应用中需要使用 tokenizer 解码）
    // 这里简化处理，返回 token 字符串表示
    if (filteredTokens.length === 0) return ''
    
    // 注意：实际 Whisper 推理需要完整的 tokenizer 和更复杂的解码逻辑
    // 这里返回占位结果，完整的实现需要集成 whisper-tokenizer
    return `[ONNX Whisper 识别结果: ${filteredTokens.length} tokens]`
  }

  // 用本模型对一段 16k float32 音频做一次性离线识别（供 FunASR “两遍精修” 复用）
  async recognizeBuffer(audio: Float32Array): Promise<string> {
    try {
      await this.init()
      if (!this.modelReady) return ''
      return await this.runInference(audio)
    } catch (e: any) {
      console.warn('[ONNX-ASR] recognizeBuffer 失败:', e)
      return ''
    }
  }

  abort() {
    // 取消录音：仅停止累积并清空缓冲。
    // 保留常驻音频采集图与麦克风流，便于下次立即开始录音（真正释放见 destroy()）
    this.isRecording = false
    this.audioChunks = []
    this.mediaRecorder = null
  }

  // 完全释放音频采集图与麦克风（仅销毁时调用）
  destroy() {
    this.isRecording = false
    this.audioChunks = []
    this.mediaRecorder = null
    if (this.persistentProcessor) {
      try { this.persistentProcessor.disconnect() } catch (e) {}
      this.persistentProcessor = null
    }
    if (this.persistentSource) {
      try { this.persistentSource.disconnect() } catch (e) {}
      this.persistentSource = null
    }
    if (this.persistentContext) {
      try { this.persistentContext.close().catch(() => {}) } catch (e) {}
      this.persistentContext = null
    }
    if (this.cachedStream) {
      this.cachedStream.getTracks().forEach(track => { try { track.stop() } catch (e) {} })
      this.cachedStream = null
    }
    this.stream = null
    ;(this as any)._audioContext = null
    ;(this as any)._audioChunks = null
    // 释放推理 worker
    if (this.worker) {
      try {
        this.worker.postMessage({ type: 'release' })
        this.worker.terminate()
      } catch (e) { /* ignore */ }
      this.worker = null
    }
    this.pending.clear()
    this.sessionInitPromise = null
  }

  getStatus() {
    if (this.isRecording) return 'listening'
    if (!this.modelReady) return 'idle'
    return 'idle'
  }

  isSupported(): boolean {
    return !!(navigator.mediaDevices?.getUserMedia)
  }

  // 检查模型是否已加载
  isModelReady(): boolean {
    return this.modelReady
  }
}

// ===== FunASR 官方流式 Paraformer 识别器（online：按住说话实时 partial，松开出最终文本） =====
// 底层复用 FunasrOnlineMicSession（600ms 推块 + cache 流式）；partial 以 isFinal:false 回传，
// final 文本由 ASRManager.stop() 统一分发（避免重复）。
class FunasrOnlineRecognizer {
  private config: ASRConfig
  private callbacks: ASRCallback
  private mic: FunasrOnlineMicSession | null = null
  // 离线精修识别器（按 refineModel 路径懒建）
  private refineRec: OnnxWhisperRecognizer | null = null
  private refineRecPath = ''
  // 批处理标点：未达阈值的原文先暂存（实时 partial 显示），攒够或结束时一次性补标点整体提交
  private pendingRaw = ''

  // 批处理阈值（字，punctMode=llm 时）；0 = 关闭批处理（逐句/结束时各自校验）
  private get punctMin(): number {
    const n = this.config.funasr?.punctMin
    return typeof n === 'number' && n > 0 ? n : 0
  }
  // 是否为“大模型批处理”模式（llm + 阈值）：攒够再一次性补标点；local/none/llm非批均即时逐句
  private get batching(): boolean {
    return this.config.punctMode === 'llm' && this.punctMin > 0
  }
  private async flushChunkIfEnough(): Promise<void> {
    while (this.pendingRaw && this.pendingRaw.length >= this.punctMin) {
      const chunk = this.pendingRaw
      this.pendingRaw = ''
      const final = await maybePolishText(this.config, chunk)
      this.callbacks.onResult?.({ text: final, isFinal: true })
    }
  }

  constructor(config: ASRConfig, callbacks: ASRCallback) {
    this.config = config
    this.callbacks = callbacks
  }

  private get dir(): string {
    return this.config.funasr?.dir || ''
  }

  private async ensureMic(): Promise<FunasrOnlineMicSession> {
    // 目录变化时重建（模型目录换了就重载）
    if (this.mic && this.mic.dir === this.dir) return this.mic
    if (this.mic) {
      try { await this.mic.destroy() } catch (e) { /* ignore */ }
      this.mic = null
    }
    if (!this.dir) throw new Error('请先在「语音输入设置」中配置 FunASR 模型目录')
    const mic = new FunasrOnlineMicSession(this.dir, {
      onPartial: (text, isFinal) => {
        if (isFinal) return // stop 收尾由 stop() 返回
        // 批处理：显示“已攒原文 + 当前句原文”，让用户先看到未加标点的文字
        if (this.batching) this.callbacks.onResult?.({ text: this.pendingRaw + text, isFinal: false })
        else this.callbacks.onResult?.({ text, isFinal: false })
      },
      onUtteranceFinal: (text) => {
        if (!text) return
        if (this.batching) {
          // 大模型批处理：攒起来，到阈值再由 maybePolishText 一次性补标点整体提交
          this.pendingRaw += text
          void this.flushChunkIfEnough()
        } else {
          // 逐句即时：maybePolishText 按 asr.punctMode 分派（none=原文 / local=本地标点 / llm=逐句大模型）
          void maybePolishText(this.config, text).then((final) => {
            this.callbacks.onResult?.({ text: final, isFinal: true })
          })
        }
      },
      onStatus: (s) => {
        if (s === 'listening') this.callbacks.onStatusChange?.('listening')
        else if (s === 'processing') this.callbacks.onStatusChange?.('processing')
        // idle 统一由 ASRManager.stop() 在最终文本分发后发出，避免实时态过早复位
      },
      onError: (msg) => this.callbacks.onError?.(msg)
    }, {
      vad: this.config.funasr?.vad !== false,
      vadSilenceMs: 900
    })
    this.mic = mic
    return mic
  }

  // 仅预热麦克风采集图（不加载 ~230MB 模型）
  async warmupAudio(): Promise<void> {
    try {
      const m = await this.ensureMic()
      await m.warmupMic()
    } catch (e: any) {
      this.callbacks.onError?.(String((e && e.message) || e))
    }
  }

  // 预加载模型（用于后台预热；230MB 较重，默认不由 ASRManager.preload 触发）
  async init(): Promise<void> {
    const m = await this.ensureMic()
    await m.warmup()
  }

  async start(): Promise<void> {
    try {
      this.pendingRaw = ''
      const m = await this.ensureMic()
      await m.start()
    } catch (e: any) {
      this.callbacks.onError?.(String((e && e.message) || e))
    }
  }

  async stop(): Promise<string> {
    let remain = ''
    try {
      remain = this.mic ? await this.mic.stop() : ''
    } catch (e) {
      remain = ''
    }
    let finalText = remain
    // 大模型批处理模式（llm + punctMin>0）：把未达阈值的已攒原文与最后这句合并，由 ASRManager.stop() 统一补标点
    if (this.batching) {
      // 未达阈值的已攒原文 + 最后这句，合并交给 ASRManager.stop() 统一补标点（只发一次 final）
      if (remain) this.pendingRaw += remain
      finalText = this.pendingRaw
      this.pendingRaw = ''
    }
    // “两遍精修”：仅当本次 stop 真的产出文本（VAD 已自动落过的句不再重复提交），
    // 且配置了离线单文件模型（如 sensevoice-small）时，对最近一句整段音频再识别替换 final
    const refinePath = this.config.funasr?.refineModel
    if (finalText && refinePath && this.mic && this.mic.lastUtterancePcm && this.mic.lastUtterancePcm.length > 1600) {
      try {
        const pcm = this.mic.lastUtterancePcm
        const offline = await this.offlineRecognizer(refinePath)
        const refined = await offline.recognizeBuffer(pcm)
        if (refined && refined.trim()) return refined.trim()
      } catch (e: any) {
        console.warn('[FunASR-2pass] 离线精修失败，回退流式:', e)
      }
    }
    return finalText
  }

  private async offlineRecognizer(path: string): Promise<OnnxWhisperRecognizer> {
    if (this.refineRec && this.refineRecPath === path) return this.refineRec
    if (this.refineRec) {
      try { await this.refineRec.destroy() } catch (e) { /* ignore */ }
      this.refineRec = null
    }
    this.refineRecPath = path
    this.refineRec = new OnnxWhisperRecognizer({
      ...this.config,
      type: 'onnx-whisper',
      onnx: {
        ...((this.config as any).onnx || {}),
        modelPath: path,
        modelLoaded: false,
        loading: false,
        loadProgress: 0
      }
    } as ASRConfig, {
      onResult: () => {},
      onStatusChange: () => {},
      onError: () => {}
    })
    return this.refineRec
  }

  abort(): void {
    this.mic?.abort().catch(() => {})
  }

  async destroy(): Promise<void> {
    if (this.mic) {
      try { await this.mic.destroy() } catch (e) { /* ignore */ }
      this.mic = null
    }
    if (this.refineRec) {
      try { await this.refineRec.destroy() } catch (e) { /* ignore */ }
      this.refineRec = null
    }
  }

  getStatus(): string {
    return this.mic?.isRecording ? 'listening' : 'idle'
  }

  isSupported(): boolean {
    return !!(navigator.mediaDevices?.getUserMedia) && !!(window as any).ipcRenderer
  }

  isModelReady(): boolean {
    return !!this.mic?.loaded
  }
}

// ASR 管理器主类
export class ASRManager {
  private recognizer: WhisperAPIRecognizer | WhisperLocalRecognizer | OnnxWhisperRecognizer | Qwen3ASRRecognizer | FunasrOnlineRecognizer | null = null
  private config: ASRConfig
  private callbacks: ASRCallback
  private currentStatus: ASRStatus = 'idle'

  constructor(config: ASRConfig, callbacks: ASRCallback = {}) {
    this.config = config
    this.callbacks = callbacks
  }

  // 切换 ASR 类型
  switchType(type: ASRType) {
    this.recognizer?.abort?.()
    this.recognizer?.destroy?.()
    this.recognizer = null
    this.config.type = type
    this.createRecognizer()
  }

  // 更新配置
  updateConfig(config: Partial<ASRConfig>) {
    this.recognizer?.abort?.()
    this.recognizer?.destroy?.()
    this.recognizer = null
    this.config = { ...this.config, ...config }
    this.createRecognizer()
  }

  // 创建识别器
  private createRecognizer() {
    switch (this.config.type) {
      case 'whisper-api':
        this.recognizer = new WhisperAPIRecognizer(this.config, {
          onResult: (result) => this.callbacks.onResult?.(result),
          onStatusChange: (status) => {
            this.currentStatus = status
            this.callbacks.onStatusChange?.(status)
          },
          onError: (error) => this.callbacks.onError?.(error)
        })
        break
      case 'whisper-local':
        this.recognizer = new WhisperLocalRecognizer(this.config, {
          onResult: (result) => this.callbacks.onResult?.(result),
          onStatusChange: (status) => {
            this.currentStatus = status
            this.callbacks.onStatusChange?.(status)
          },
          onError: (error) => this.callbacks.onError?.(error)
        })
        break
      case 'onnx-whisper':
        this.recognizer = new OnnxWhisperRecognizer(this.config, {
          onResult: (result) => this.callbacks.onResult?.(result),
          onStatusChange: (status) => {
            this.currentStatus = status
            this.callbacks.onStatusChange?.(status)
          },
          onError: (error) => this.callbacks.onError?.(error)
        })
        break
      case 'qwen3-asr':
        this.recognizer = new Qwen3ASRRecognizer(this.config, {
          onResult: (result) => this.callbacks.onResult?.(result),
          onStatusChange: (status) => {
            this.currentStatus = status
            this.callbacks.onStatusChange?.(status)
          },
          onError: (error) => this.callbacks.onError?.(error)
        })
        break
      case 'funasr-online':
        this.recognizer = new FunasrOnlineRecognizer(this.config, {
          onResult: (result) => this.callbacks.onResult?.(result),
          onStatusChange: (status) => {
            this.currentStatus = status
            this.callbacks.onStatusChange?.(status)
          },
          onError: (error) => this.callbacks.onError?.(error)
        })
        break
    }
  }
  
  // 预加载模型（初始化后自动调用，无需等待按键）
  async preload(): Promise<void> {
    if (this.config.type !== 'onnx-whisper') return
    if (!this.recognizer) this.createRecognizer()
    const onnxRec = this.recognizer as OnnxWhisperRecognizer
    if (onnxRec && !onnxRec.isModelReady()) {
      try {
        await onnxRec.init()
      } catch (e) {
        // 预加载失败不阻止后续使用，start() 时会重试
      }
    }
  }

  // 预热音频采集图（不加载模型）：消除按住录音时开头几秒的丢失；失败静默，start() 时会重试
  async warmup(): Promise<void> {
    if (this.config.type === 'funasr-online') {
      if (!this.recognizer) this.createRecognizer()
      const rec = this.recognizer as FunasrOnlineRecognizer
      try { await rec.warmupAudio() } catch (e) { /* 失败静默 */ }
      return
    }
    // Qwen3-ASR 分段准流式：预热麦克风采集图（不预热模型）
    if (this.config.type === 'qwen3-asr') {
      if (!this.recognizer) this.createRecognizer()
      const rec = this.recognizer as Qwen3ASRRecognizer
      try { await rec.warmupAudio() } catch (e) { /* 失败静默 */ }
      return
    }
    if (this.config.type !== 'onnx-whisper') return
    if (!this.recognizer) this.createRecognizer()
    const onnxRec = this.recognizer as OnnxWhisperRecognizer
    try {
      await onnxRec.warmupAudio()
    } catch (e) {
      // 预热失败静默，首次 start() 会重新尝试
    }
  }

  // 开始语音识别（不等待返回，立即开始录音，模型后台加载）
  start() {
    if (!this.recognizer) {
      this.createRecognizer()
    }
    this.recognizer?.start()
  }

  // 停止语音识别并返回识别的文本
  async stop(): Promise<string> {
    if (!this.recognizer) return ''
    const text = await this.recognizer.stop()
    this.currentStatus = 'idle'
    let finalText = text
    if (text) {
      // 标点校验（按 asr.punctMode 分派 local/llm；none 直接返回原文），与 VAD 自动断句同一套逻辑
      finalText = await maybePolishText(this.config, text)
      this.callbacks.onResult?.({ text: finalText, isFinal: true })
    }
    // 最终文本分发后再通知 idle（home 的实时 partial 态按此复位，避免过早清掉）
    this.callbacks.onStatusChange?.('idle')
    return finalText
  }

  // 中止语音识别
  abort() {
    this.recognizer?.abort()
    this.currentStatus = 'idle'
  }

  // 获取当前状态
  getStatus(): ASRStatus {
    return this.currentStatus
  }

  // 检查是否支持
  isSupported(): boolean {
    if (!this.recognizer) return false
    return this.recognizer.isSupported()
  }

  // 销毁
  destroy() {
    // Onnx 识别器：abort() 只停止录音，destroy() 才真正释放采集图与麦克风
    this.recognizer?.abort?.()
    this.recognizer?.destroy?.()
    this.recognizer = null
    this.currentStatus = 'idle'
  }
}

// 创建 ASR 管理器的工厂函数
export function createASRManager(config: ASRConfig, callbacks?: ASRCallback): ASRManager {
  return new ASRManager(config, callbacks)
}

// 获取可用 ASR 引擎列表
export function getAvailableASREngines(): { value: string; label_zh: string; label_en: string }[] {
  const engines = [
    { value: 'onnx-whisper', label_zh: 'ONNX Whisper（本地）', label_en: 'ONNX Whisper (Local)' },
    { value: 'whisper-api', label_zh: 'Whisper API', label_en: 'Whisper API' },
    { value: 'whisper-local', label_zh: 'Whisper 本地（Python）', label_en: 'Whisper Local (Python)' },
    { value: 'qwen3-asr', label_zh: 'Qwen3-ASR（本地网页服务 / OpenAI 兼容）', label_en: 'Qwen3-ASR (Local Web UI / OpenAI-compatible)' },
    { value: 'funasr-online', label_zh: 'FunASR 流式 Paraformer（官方 online，本地实时）', label_en: 'FunASR Streaming Paraformer (local)' },
  ]
  
  return engines
}
