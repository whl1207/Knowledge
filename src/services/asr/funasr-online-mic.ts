// src/services/asr/funasr-online-mic.ts
// FunASR 官方流式 Paraformer 的麦克风会话（里程碑 3 核心，浏览器端）。
//   - 常驻音频采集图（AudioContext+ScriptProcessor，16k 单声道），按住即录
//   - 攒满 600ms(9600 采样@16k) 推一块 → FunasrOnlineRuntime.feedChunk → partial（实时出字）
//   - 松开 flush 剩余（isFinal=true）收尾出最终文本
// 与现有离线 OnnxWhisperRecognizer 的常驻采集图同套路（避免每按一次重建 AudioContext 丢开头）。
//
// 供 AsrSettings「按住录音流式自测」使用；后续可作为 ASRManager 新引擎的底层。

import { FunasrOnlineRuntime } from '@/services/asr/funasr-online'
import { loadFunasrOnline } from '@/services/asr/funasr-online-ipc'

const STEP = 9600 // 600ms @16k

export interface FunasrMicEvents {
  onPartial?: (text: string, isFinal: boolean) => void
  // VAD 自动断句出的一句最终文本（仍在持续监听，下一句另起）
  onUtteranceFinal?: (text: string) => void
  onStatus?: (s: 'idle' | 'loading' | 'listening' | 'processing' | 'error') => void
  onError?: (msg: string) => void
}

export interface FunasrMicOptions {
  vad?: boolean // 能量 VAD：说话停顿自动断句（默认 true）
  vadSilenceMs?: number // 静音多久触发断句（默认 900ms）
}

function resampleTo16k(src: Float32Array, srcRate: number): Float32Array {
  if (srcRate === 16000 || srcRate <= 0) return src
  const ratio = srcRate / 16000
  const n = Math.floor(src.length / ratio)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, src.length - 1)
    const frac = pos - i0
    out[i] = src[i0] * (1 - frac) + src[i1] * frac
  }
  return out
}

export class FunasrOnlineMicSession {
  readonly dir: string
  private ev: FunasrMicEvents
  private rt: FunasrOnlineRuntime | null = null
  private release: (() => Promise<void>) | null = null
  private loadP: Promise<void> | null = null

  // VAD / 分句
  private vad: boolean
  private vadSilenceMs: number
  private lastVoiceAt = 0
  private everVoiced = false
  private finalizing = false

  // 音频采集图（常驻复用）
  private ctx: AudioContext | null = null
  private micStream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | null = null
  private audioRate = 16000

  private recording = false
  private pending16 = new Float32Array(0) // 待喂给 runtime 的 16k 采样
  private accText = '' // 累积文本（partial 逐块追加 = 当前句最终）
  private chain: Promise<void> = Promise.resolve()
  private err: string | null = null
  private uttPcm = new Float32Array(0) // 当前句完整 16k 音频（供离线精修）
  lastUtterancePcm = new Float32Array(0) // 最近完成句的完整音频（供 stop 时精修）

  constructor(dir: string, ev: FunasrMicEvents = {}, opts: FunasrMicOptions = {}) {
    this.dir = dir
    this.ev = ev
    this.vad = opts.vad !== false
    this.vadSilenceMs = opts.vadSilenceMs || 900
  }

  // 加载双模型并构建运行时（懒加载：首次推块时才触发，加载期间录音/缓冲不丢）
  async ensureModel(): Promise<void> {
    if (this.rt) return
    if (this.loadP) return this.loadP
    if (!this.recording) this.ev.onStatus?.('loading')
    this.loadP = (async () => {
      const { cfg, inference, release } = await loadFunasrOnline({ dir: this.dir })
      this.rt = new FunasrOnlineRuntime(cfg, inference)
      this.release = release
      this.rt.reset() // 模型就绪即开始新一轮（若录音已开始则从头对齐）
      if (!this.recording) this.ev.onStatus?.('idle')
    })().catch((e) => {
      this.loadP = null
      const msg = String((e && e.message) || e)
      this.ev.onError?.(msg)
      throw new Error(msg)
    })
    return this.loadP
  }

  get loaded(): boolean {
    return !!this.rt
  }

  get isRecording(): boolean {
    return this.recording
  }

  // 预热：确保模型 + 常驻采集图就绪（不开始录音）
  async warmup(): Promise<void> {
    try { await this.ensureModel() } catch (e) { /* 错误已在 onError */ }
    try { await this.ensureMic() } catch (e) { /* ignore */ }
  }

  // 仅预热麦克风采集图（不加载 ~230MB 模型）
  async warmupMic(): Promise<void> {
    try { await this.ensureMic() } catch (e) { /* ignore */ }
  }

  private async ensureMic(): Promise<void> {
    if (this.processor) return
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前环境不支持麦克风')
    if (!this.micStream || !this.micStream.getAudioTracks().some((t) => t.readyState === 'live')) {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true
        }
      })
    }
    const audioContext = new AudioContext({ sampleRate: 16000 })
    if (audioContext.state === 'suspended') {
      try { await audioContext.resume() } catch (e) { /* start 时再试 */ }
    }
    this.audioRate = audioContext.sampleRate || 16000
    const source = audioContext.createMediaStreamSource(this.micStream)
    const processor = audioContext.createScriptProcessor(1024, 1, 1)
    const ctx = audioContext
    processor.onaudioprocess = (event) => {
      if (!this.recording) return
      const input = event.inputBuffer.getChannelData(0)
      const r = resampleTo16k(input, this.audioRate)
      this.pushPcm(r)
    }
    source.connect(processor)
    const silentGain = audioContext.createGain()
    silentGain.gain.value = 0
    processor.connect(silentGain)
    silentGain.connect(audioContext.destination)

    this.ctx = ctx
    this.source = source
    this.processor = processor
  }

  private pushPcm(block: Float32Array): void {
    // 累积当前句整段 16k 音频（供离线精修）
    const u = new Float32Array(this.uttPcm.length + block.length)
    u.set(this.uttPcm, 0)
    u.set(block, this.uttPcm.length)
    this.uttPcm = u

    const merged = new Float32Array(this.pending16.length + block.length)
    merged.set(this.pending16, 0)
    merged.set(block, this.pending16.length)
    this.pending16 = merged
    // 攒满整块立即推流（只推完整块，余量留到断句/停止时 flush）
    let idx = 0
    while (this.pending16.length - idx >= STEP) {
      const seg = this.pending16.slice(idx, idx + STEP)
      idx += STEP
      this.feed(seg, false)
    }
    if (idx > 0) this.pending16 = this.pending16.slice(idx)

    // 能量 VAD：更新有声时间；说过话且停顿足够 → 自动断句
    if (this.vad) {
      const now = performance.now()
      const rms = this.rmsOf(block)
      if (rms > 0.02) {
        this.lastVoiceAt = now
        this.everVoiced = true
      } else if (this.everVoiced && !this.finalizing && now - this.lastVoiceAt > this.vadSilenceMs) {
        this.autoFinalize()
      }
    }
  }

  private rmsOf(b: Float32Array): number {
    if (!b.length) return 0
    let s = 0
    for (let i = 0; i < b.length; i++) s += b[i] * b[i]
    return Math.sqrt(s / b.length)
  }

  // 串行喂块：保证 runtime 状态不被并发打乱；每块结果以 partial 回传
  private feed(seg: Float32Array, isFinal: boolean): void {
    this.chain = this.chain.then(async () => {
      // 首次喂块会触发 ~230MB 模型加载（在链内等待，期间音频已缓冲、不丢）
      await this.ensureModel()
      if (!this.rt) return
      const out = await this.rt.feedChunk(seg, isFinal)
      const text = (out || []).map((r) => r.text).join('')
      if (text) this.accText += text
      this.ev.onPartial?.(this.accText, isFinal)
    }).catch((e) => {
      this.err = String((e && e.message) || e)
      this.ev.onError?.(this.err)
    })
  }

  // 把当前待喂尾部 flush 成一句最终文本（VAD 自动断句 auto=true / 停止 auto=false）
  private commitSentence(auto: boolean): Promise<string> {
    const tail = this.pending16
    this.pending16 = new Float32Array(0)
    return new Promise<string>((resolve) => {
      this.chain = this.chain.then(async () => {
        await this.ensureModel()
        let full = this.accText
        if (this.rt) {
          const out = await this.rt.feedChunk(tail, true)
          const text = (out || []).map((r) => r.text).join('')
          if (text) {
            this.accText += text
            full = this.accText
          }
          this.rt.reset() // 下一句从头
        }
        this.accText = ''
        this.pending16 = new Float32Array(0)
        this.lastUtterancePcm = this.uttPcm // 供 stop 时离线精修
        this.uttPcm = new Float32Array(0)
        this.everVoiced = false
        this.lastVoiceAt = 0
        if (auto) {
          this.ev.onUtteranceFinal?.(full)
          this.ev.onPartial?.('', false)
        } else {
          this.ev.onPartial?.(full, true)
        }
        this.finalizing = false
        resolve(full)
      }).catch((e) => {
        this.finalizing = false
        this.err = String((e && e.message) || e)
        this.ev.onError?.(this.err)
        resolve(this.accText)
      })
    })
  }

  private autoFinalize(): void {
    if (this.finalizing || !this.recording) return
    this.finalizing = true
    void this.commitSentence(true) // 持续监听，串行链按序执行
  }

  // 开始录音：立即开录（模型在首个推块时后台加载，不阻塞、不丢开头）
  async start(): Promise<void> {
    if (this.recording) return
    try {
      await this.ensureMic()
      if (this.rt) this.rt.reset()
      this.pending16 = new Float32Array(0)
      this.accText = ''
      this.uttPcm = new Float32Array(0)
      this.lastUtterancePcm = new Float32Array(0)
      this.everVoiced = false
      this.lastVoiceAt = 0
      this.finalizing = false
      this.err = null
      if (this.ctx && this.ctx.state === 'suspended') {
        try { await this.ctx.resume() } catch (e) { /* ignore */ }
      }
      this.recording = true
      this.ev.onPartial?.('', false)
      this.ev.onStatus?.('listening')
    } catch (e: any) {
      const msg = String((e && e.message) || e)
      this.ev.onError?.(msg)
      this.ev.onStatus?.('error')
    }
  }

  // 停止录音：先等链上排队的断句完成，再 flush 当前句并返回其文本
  async stop(): Promise<string> {
    if (!this.recording) return this.accText
    this.recording = false
    this.ev.onStatus?.('processing')
    // 等在跑的 VAD 断句（若有）把这句收完
    await this.chain.catch(() => {})
    const full = await this.commitSentence(false)
    this.ev.onStatus?.('idle')
    return full
  }

  // 中止（如拖出取消）：丢弃本轮
  async abort(): Promise<void> {
    this.recording = false
    this.finalizing = false
    this.pending16 = new Float32Array(0)
    this.accText = ''
    this.uttPcm = new Float32Array(0)
    this.everVoiced = false
    this.lastVoiceAt = 0
    this.ev.onStatus?.('idle')
  }

  // 释放全部（采集图 + 模型）
  async destroy(): Promise<void> {
    this.recording = false
    try { await this.abort() } catch (e) { /* ignore */ }
    if (this.processor) {
      try { this.processor.disconnect() } catch (e) { /* ignore */ }
      this.processor = null
    }
    if (this.source) {
      try { this.source.disconnect() } catch (e) { /* ignore */ }
      this.source = null
    }
    if (this.ctx) {
      try { await this.ctx.close() } catch (e) { /* ignore */ }
      this.ctx = null
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => { try { t.stop() } catch (e) { /* ignore */ } })
      this.micStream = null
    }
    if (this.release) {
      try { await this.release() } catch (e) { /* ignore */ }
      this.release = null
    }
    this.rt = null
    this.loadP = null
  }
}
