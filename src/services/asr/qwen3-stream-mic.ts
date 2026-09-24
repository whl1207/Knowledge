// src/services/asr/qwen3-stream-mic.ts
// Qwen3-ASR「分段准流式」麦克风会话（方案 A）：
//   - 常驻音频采集图（AudioContext + ScriptProcessor，16k 单声道），按住即录
//   - 能量 VAD：说话停顿超过 silenceMs 就把这一段切出来提交给网页服务识别，文本边出边追加
//   - 单段最长 maxSegmentMs（默认 15s，可调到 3 分钟）强切，避免一句话太长导致等待过久
//   - 切点保留 overlapMs 音频作为下一段开头，避免切在字中间丢音
//   - 分段请求串行排队（服务端 queue 串行），文本按序产出；松手时把尾段补上
//
// 该模型/服务本身是「整段离线」模型（Gradio /run 无流式输出），所以这里的“流式”是
// 客户端分段：体感为「说完一句、停顿约 0.5~1.5s 出字」，而非逐字上屏。

import { pcm16kToWavBlob, runQwen3Gradio, type Qwen3GradioOptions } from '@/services/asr/qwen3-gradio'

const RATE = 16000

export interface Qwen3SegEvents {
  onStatus?: (s: 'idle' | 'listening' | 'processing' | 'error') => void
  // VAD 自动切段产出的文本（按顺序回调；stop 的尾段不走这里，由 stop() 返回）
  onSegmentFinal?: (text: string) => void
  onBusyChange?: (busy: boolean) => void
  onError?: (msg: string) => void
}

export interface Qwen3SegOptions {
  silenceMs?: number // 停顿多久切段（默认 800ms）
  overlapMs?: number // 切点重叠（默认 300ms）
  maxSegmentMs?: number // 单段最长（默认 15000ms，上限 180000ms = 3 分钟）
  minVoiceMs?: number // 该段最少有声时长（默认 200ms，太短不发请求）
  vadThreshold?: number // 能量（RMS）阈值（默认 0.02）
}

// 供设置页复用的取值范围
export const QWEN3_SEG_RANGE = {
  silenceMs: { min: 200, max: 3000, step: 50 },
  overlapMs: { min: 0, max: 800, step: 50 },
  maxSegmentMs: { min: 5000, max: 180000, step: 5000 },
}

function resampleTo16k(src: Float32Array, srcRate: number): Float32Array {
  if (srcRate === RATE || srcRate <= 0) return src
  const ratio = srcRate / RATE
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

function rmsOf(b: Float32Array): number {
  if (!b.length) return 0
  let s = 0
  for (let i = 0; i < b.length; i++) s += b[i] * b[i]
  return Math.sqrt(s / b.length)
}

const MIN_CUT_MS = 200 // 短于此的段直接丢弃（多半是噪声/静音尾巴）

export class Qwen3SegmentMicSession {
  private getOpts: () => Qwen3GradioOptions
  private ev: Qwen3SegEvents
  private o: Required<Qwen3SegOptions>

  // 常驻采集图
  private ctx: AudioContext | null = null
  private micStream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | null = null
  private audioRate = RATE

  // 分段状态
  private recording = false
  private buf = new Float32Array(0) // 上一切点之后累积的 16k 采样
  private voicedMs = 0 // 本段累计有声时长
  private everVoiced = false
  private lastVoiceAt = 0
  private chain: Promise<void> = Promise.resolve()
  private pending = 0
  private err: string | null = null

  constructor(getOpts: () => Qwen3GradioOptions, ev: Qwen3SegEvents = {}, opts: Qwen3SegOptions = {}) {
    this.getOpts = getOpts
    this.ev = ev
    this.o = {
      silenceMs: Math.min(3000, Math.max(200, opts.silenceMs ?? 800)),
      overlapMs: Math.min(800, Math.max(0, opts.overlapMs ?? 300)),
      maxSegmentMs: Math.min(180000, Math.max(5000, opts.maxSegmentMs ?? 15000)),
      minVoiceMs: Math.max(0, opts.minVoiceMs ?? 200),
      vadThreshold: opts.vadThreshold && opts.vadThreshold > 0 ? opts.vadThreshold : 0.02,
    }
  }

  get isRecording(): boolean {
    return this.recording
  }

  get isBusy(): boolean {
    return this.pending > 0
  }

  // 仅预热麦克风采集图（不加载任何模型）
  async warmupMic(): Promise<void> {
    try { await this.ensureMic() } catch (e) { /* ignore */ }
  }

  private async ensureMic(): Promise<void> {
    if (this.processor) return
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前环境不支持麦克风')
    if (!this.micStream || !this.micStream.getAudioTracks().some((t) => t.readyState === 'live')) {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: RATE,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      })
    }
    const audioContext = new AudioContext({ sampleRate: RATE })
    if (audioContext.state === 'suspended') {
      try { await audioContext.resume() } catch (e) { /* start 时再试 */ }
    }
    this.audioRate = audioContext.sampleRate || RATE
    const source = audioContext.createMediaStreamSource(this.micStream)
    const processor = audioContext.createScriptProcessor(1024, 1, 1)
    processor.onaudioprocess = (event) => {
      if (!this.recording) return
      const input = event.inputBuffer.getChannelData(0)
      this.pushBlock(this.audioRate === RATE ? input : resampleTo16k(input, this.audioRate))
    }
    source.connect(processor)
    const silentGain = audioContext.createGain()
    silentGain.gain.value = 0
    processor.connect(silentGain)
    silentGain.connect(audioContext.destination)

    this.ctx = audioContext
    this.source = source
    this.processor = processor
  }

  private pushBlock(block: Float32Array): void {
    const merged = new Float32Array(this.buf.length + block.length)
    merged.set(this.buf, 0)
    merged.set(block, this.buf.length)
    this.buf = merged

    const now = performance.now()
    if (rmsOf(block) > this.o.vadThreshold) {
      this.lastVoiceAt = now
      this.everVoiced = true
      this.voicedMs += (block.length / RATE) * 1000
    }

    const bufMs = (this.buf.length / RATE) * 1000
    // ① 停顿切段：说过话 + 本段够长 + 静音足够久
    if (this.everVoiced && this.voicedMs >= this.o.minVoiceMs && now - this.lastVoiceAt > this.o.silenceMs) {
      this.cut()
      return
    }
    // ② 单段最长强切（说不停时避免无限等待）；纯静音则直接丢弃，避免缓冲无限增长
    if (bufMs >= this.o.maxSegmentMs) {
      if (this.everVoiced) this.cut()
      else this.resetSegment()
    }
  }

  // 把当前缓冲切成一段提交识别（保留 overlapMs 作为下一段开头）
  private cut(): void {
    const pcm = this.buf
    const overlapLen = Math.min(Math.round((this.o.overlapMs / 1000) * RATE), pcm.length)
    this.buf = overlapLen > 0 ? pcm.slice(pcm.length - overlapLen) : new Float32Array(0)
    this.voicedMs = 0
    this.everVoiced = false
    this.lastVoiceAt = 0
    if ((pcm.length / RATE) * 1000 < MIN_CUT_MS) return
    void this.enqueue(pcm, true)
  }

  private resetSegment(): void {
    this.buf = new Float32Array(0)
    this.voicedMs = 0
    this.everVoiced = false
    this.lastVoiceAt = 0
  }

  // 串行提交一段：服务端是排队串行的，这里也保持先进先出，文本顺序即说话顺序
  private enqueue(pcm: Float32Array, emit: boolean): Promise<string> {
    const opts = this.getOpts()
    const wav = pcm16kToWavBlob(pcm)
    this.pending++
    if (this.pending === 1) this.ev.onBusyChange?.(true)
    const task = this.chain.then(async (): Promise<string> => {
      try {
        const text = await runQwen3Gradio(opts, wav, 'segment.wav')
        if (!text) return ''
        if (emit) this.ev.onSegmentFinal?.(text)
        return text
      } catch (e: any) {
        this.err = String((e && e.message) || e)
        this.ev.onError?.(this.err)
        return ''
      }
    })
    this.chain = task.then(() => { /* 保持链不断 */ })
    void task.finally(() => {
      this.pending--
      if (this.pending === 0) this.ev.onBusyChange?.(false)
    })
    return task
  }

  async start(): Promise<void> {
    if (this.recording) return
    try {
      await this.ensureMic()
      this.resetSegment()
      this.err = null
      if (this.ctx && this.ctx.state === 'suspended') {
        try { await this.ctx.resume() } catch (e) { /* ignore */ }
      }
      this.recording = true
      this.ev.onStatus?.('listening')
    } catch (e: any) {
      const msg = String((e && e.message) || e)
      this.ev.onError?.(msg)
      this.ev.onStatus?.('error')
    }
  }

  // 停止：把尾段补上（其文本由 stop() 返回，避免与 onSegmentFinal 重复），再等所有排队段完成
  async stop(): Promise<string> {
    if (!this.recording) return ''
    this.recording = false
    this.ev.onStatus?.('processing')
    const tail = this.buf
    const tailMs = (tail.length / RATE) * 1000
    const hadVoice = this.everVoiced || this.voicedMs > 0
    this.resetSegment()
    let tailText = ''
    if (hadVoice && tailMs >= MIN_CUT_MS) {
      tailText = await this.enqueue(tail, false)
    }
    await this.chain.catch(() => { /* 错误已在链内回调 */ })
    this.ev.onStatus?.('idle')
    return tailText
  }

  // 中止（如按住拖出取消）：丢弃本轮缓冲；已在途的请求无法撤回，其文本仍会按序回传
  abort(): void {
    this.recording = false
    this.resetSegment()
    this.ev.onStatus?.('idle')
  }

  async destroy(): Promise<void> {
    this.recording = false
    this.abort()
    await this.chain.catch(() => { /* ignore */ })
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
  }
}
