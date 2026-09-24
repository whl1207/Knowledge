// src/services/asr/funasr-online.ts
// FunASR 官方「流式 Paraformer (online)」ONNX 运行时的 TypeScript 移植（里程碑 1）。
//
// 参考：scripts/funasr-online-ref/funasr_onnx/paraformer_online_bin.py
//       + utils/frontend.py (WavFrontendOnline, SinusoidalPositionEncoderOnline)
//       + utils/postprocess_utils.py (sentence_postprocess)
//
// 设计：纯算法、与 UI / onnxruntime-web 解耦。推理经注入接口 FunasrOnlineInference 完成
// （里程碑 2 由 asr-onnx-worker 双 session 流式协议实现；测试可回放 Python 基准）。
//
// 用法（语义 = 官方 demo：每 600ms 一块 step=chunk1*960，尾部 isFinal）：
//   const rt = new FunasrOnlineRuntime(cfg, inference)
//   const out = await rt.feedChunk(pcm9600, false)   // 每块返回 partial 文本
//   const end = await rt.feedChunk(pcmTail, true)     // 末尾块 isFinal=true
//   每轮按住说话开始前调 rt.reset() 清空跨块状态。

export interface FunasrOnlineModelConfig {
  fs: number
  frameLengthMs: number // 25
  frameShiftMs: number // 10
  nMels: number // 80
  lfrM: number // 7
  lfrN: number // 6
  lowFreq: number // 20（kaldi 默认）
  highFreq: number // 0 = nyquist(8000)；可显式给 7600
  // CMVN：FunASR am.mvn 的 <AddShift>/<Rescale> 括号内数值直接使用：(x+shift)*scale
  cmvnShift: Float32Array | null
  cmvnScale: Float32Array | null
  encoderOutputSize: number // encoder_conf.output_size（conformer 维度）
  fsmnLayers: number // decoder_conf.num_blocks
  fsmnLorder: number // decoder_conf.kernel_size - 1
  cifThreshold: number // predictor_conf.threshold
  tailThreshold: number // predictor_conf.tail_threshold
  vocab: string[] // tokens.json（index = token id）
  chunkSize: [number, number, number] // [5,10,5]
}

export interface FunasrEncoderResult {
  enc: Float32Array // encRows*encDim
  encRows: number
  encDim: number
  alphas: Float32Array // encRows（cif alphas）
}

export interface FunasrDecoderArgs {
  enc: Float32Array // encRows*encDim
  encRows: number
  encDim: number
  embeds: Float32Array // embedRows*encDim（CIF 触发帧）
  embedRows: number
  fsmn: Float32Array[] // 每层 encDim*fsmnLorder 的缓存（新会话前为全 0）
}

export interface FunasrDecoderResult {
  logits: Float32Array // rows*vocab
  rows: number
  vocab: number
  fsmn: Float32Array[] // 每层完整输出（保留，由调用方截尾）
}

export interface FunasrOnlineInference {
  runEncoder(feats: Float32Array, featsRows: number): Promise<FunasrEncoderResult>
  runDecoder(a: FunasrDecoderArgs): Promise<FunasrDecoderResult>
}

export interface FunasrChunkText {
  text: string
  tokens: string[]
}

// ==================== 内部状态 ====================

interface StreamCache {
  initialized: boolean
  startIdx: number // 位置编码游标
  cifHidden: Float32Array | null // encDim
  cifAlpha: number
  featsCache: Float32Array // rowsCache*featsDim
  featsCacheRows: number
  lastChunk: boolean
  isFinal: boolean
  decoderFsmn: Float32Array[] // 每层 encDim*lorder
}

// ==================== 运行时 ====================

export class FunasrOnlineRuntime {
  private cfg: FunasrOnlineModelConfig
  private inf: FunasrOnlineInference
  private featsDim: number // nMels*lfrM

  // 前端流式状态（等价 WavFrontendOnline，batch=1）
  private sampleBuf = new Float32Array(0) // 自下一帧起点起的残差采样
  private lfrCache = new Float32Array(0) // LFR 拼接缓存（nMels 帧）
  private lfrCacheRows = 0
  private lfrPadDone = false

  private cache: StreamCache

  // 预计算 fbank
  private flSamples = 0 // 帧长采样数
  private shSamples = 0 // 帧移采样数
  private fftSize = 512
  private hammingWindow!: Float32Array // hamming
  private filters: { start: number; center: number; end: number }[] = []

  constructor(cfg: FunasrOnlineModelConfig, inf: FunasrOnlineInference) {
    this.cfg = cfg
    this.inf = inf
    this.featsDim = cfg.nMels * cfg.lfrM
    this.flSamples = Math.round((cfg.frameLengthMs * cfg.fs) / 1000)
    this.shSamples = Math.round((cfg.frameShiftMs * cfg.fs) / 1000)
    this.cache = this.newCache()
    this.initFbank()
  }

  private newCache(): StreamCache {
    const c0 = this.cfg.chunkSize[0]
    const c2 = this.cfg.chunkSize[2]
    return {
      initialized: false,
      startIdx: 0,
      cifHidden: null,
      cifAlpha: 0,
      featsCache: new Float32Array((c0 + c2) * this.featsDim),
      featsCacheRows: 0,
      lastChunk: false,
      isFinal: false,
      decoderFsmn: []
    }
  }

  // 新一轮按住说话前调用：清空全部跨块状态（等价官方每个 utterance 新建 cache/frontend）
  reset(): void {
    this.sampleBuf = new Float32Array(0)
    this.lfrCache = new Float32Array(0)
    this.lfrCacheRows = 0
    this.lfrPadDone = false
    this.cache = this.newCache()
  }

  private initFbank(): void {
    const c = this.cfg
    const fftSize = this.fftSize
    // hamming（kaldi/knf 一致）：0.54-0.46*cos(2πi/(N-1))
    this.hammingWindow = new Float32Array(this.flSamples)
    for (let i = 0; i < this.flSamples; i++) {
      this.hammingWindow[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (this.flSamples - 1))
    }
    // Mel 滤波器组（Hz→mel→Hz→FFT bin，floor），与现有引擎 computeMelSpectrogram 同源
    const mel = (hz: number) => 2595 * Math.log10(1 + hz / 700)
    const lowHz = c.lowFreq
    const highHz = c.highFreq > 0 ? c.highFreq : c.fs / 2
    const melLow = mel(lowHz)
    const melHigh = mel(highHz)
    const binPoints: number[] = []
    for (let m = 0; m < c.nMels + 2; m++) {
      const mp = melLow + ((melHigh - melLow) / (c.nMels + 1)) * m
      const hz = 700 * (Math.pow(10, mp / 2595) - 1)
      binPoints.push(Math.floor(((fftSize + 1) * hz) / c.fs))
    }
    this.filters = []
    for (let m = 0; m < c.nMels; m++) {
      this.filters.push({ start: binPoints[m], center: binPoints[m + 1], end: binPoints[m + 2] })
    }
  }

  // 一次喂一块 16k float32 音频（官方按 600ms/9600 采样喂；返回 partial 文本列表）
  async feedChunk(samples: Float32Array, isFinal: boolean): Promise<FunasrChunkText[]> {
    const [c0, c1, c2] = this.cfg.chunkSize
    const c = this.cache

    // 官方短尾分支：<16*60 且 final 时直接吃 featsCache 走 infer（flush decoder）
    if (samples.length < 16 * 60 && isFinal && c.initialized) {
      c.lastChunk = true
      if (c.featsCacheRows <= 0) return []
      const r = await this.inferFeats(c.featsCache.subarray(0, c.featsCacheRows * this.featsDim), c.featsCacheRows)
      return r ? [r] : []
    }

    // 前端：fbank -> 在线 LFR+CMVN
    const feats = this.extractFeat(samples, isFinal)
    if (!feats) return []

    // 缩放 sqrt(encoderOutputSize)（官方 feats *= enc_size**0.5）
    const rows = feats.length / this.featsDim
    const k = Math.sqrt(this.cfg.encoderOutputSize)
    for (let i = 0; i < feats.length; i++) feats[i] *= k

    if (!c.initialized) this.prepareCache()
    c.isFinal = isFinal

    // 在线正弦位置编码
    this.applyPosEnc(feats, rows)
    c.startIdx += rows

    if (isFinal) {
      if (rows + c2 <= c1) {
        // 一块不足，单次 infer
        c.lastChunk = true
        const ov = this.addOverlapChunk(feats, rows)
        const r = await this.inferFeats(ov.data, ov.rows)
        return r ? [r] : []
      }
      // 拆 first/last 两块
      const rows1 = c1
      const f1 = feats.subarray(0, rows1 * this.featsDim)
      const ov1 = this.addOverlapChunk(f1, rows1)
      const r1 = await this.inferFeats(ov1.data, ov1.rows)

      c.lastChunk = true
      const takeFrom = Math.max(0, rows + c2 - c1) // python: feats[:, -(rows+chunk2-chunk1):]
      const f2 = feats.subarray(takeFrom * this.featsDim)
      const ov2 = this.addOverlapChunk(f2, rows - takeFrom)
      const r2 = await this.inferFeats(ov2.data, ov2.rows)
      return [this.mergeTexts(r1, r2)]
    }

    const ov = this.addOverlapChunk(feats, rows)
    const r = await this.inferFeats(ov.data, ov.rows)
    return r ? [r] : []
  }

  private mergeTexts(a: FunasrChunkText | null, b: FunasrChunkText | null): FunasrChunkText {
    const ta = a ? a.tokens : []
    const tb = b ? b.tokens : []
    return { text: (a ? a.text : '') + (b ? b.text : ''), tokens: [...ta, ...tb] }
  }

  private prepareCache(): void {
    const c = this.cache
    const encDim = this.cfg.encoderOutputSize
    const c0 = this.cfg.chunkSize[0]
    const c2 = this.cfg.chunkSize[2]
    c.initialized = true
    c.startIdx = 0
    c.cifHidden = new Float32Array(encDim)
    c.cifAlpha = 0
    c.lastChunk = false
    c.decoderFsmn = []
    for (let i = 0; i < this.cfg.fsmnLayers; i++) {
      c.decoderFsmn.push(new Float32Array(encDim * this.cfg.fsmnLorder))
    }
    // 与 python 一致：cache["feats"] 初始为 (1, chunk0+chunk2, featsDim) 全 0
    // （首块喂给 encoder 的窗口 = 左 5 行 0 上下文 + 当前 10 行 + 右 5 行前瞻 → 20 行）
    c.featsCacheRows = c0 + c2
  }

  // ---------- 前端：分块 fbank（等价 knf OnlineFbank + 帧对齐残差缓存） ----------

  private extractFeat(newSamples: Float32Array, isFinal: boolean): Float32Array | null {
    // 追加采样
    const buf = new Float32Array(this.sampleBuf.length + newSamples.length)
    buf.set(this.sampleBuf, 0)
    buf.set(newSamples, this.sampleBuf.length)

    const fl = this.flSamples
    const sh = this.shSamples
    let frames = 0
    if (buf.length >= fl) frames = Math.floor((buf.length - fl) / sh) + 1
    if (frames <= 0) {
      this.sampleBuf = buf
      return null
    }

    // 计算 fbank 帧（帧起点 i*sh），随后消费已覆盖的采样
    const fbank = this.computeFbank(buf, frames)
    this.sampleBuf = buf.slice(frames * sh)

    // 在线 LFR + CMVN
    return this.lfrCmvn(fbank, frames, isFinal)
  }

  private computeFbank(buf: Float32Array, frames: number): Float32Array {
    const nMels = this.cfg.nMels
    const fft = this.fftSize
    const fl = this.flSamples
    const out = new Float32Array(frames * nMels)
    const win = this.hammingWindow
    const filters = this.filters
    const windowed = new Float32Array(fft)
    const powerSpec = new Float32Array(fft / 2 + 1)
    for (let f = 0; f < frames; f++) {
      const start = f * this.shSamples
      windowed.fill(0)
      for (let i = 0; i < fl; i++) {
        windowed[i] = buf[start + i] * 32768 * win[i] // 官方 ×(1<<15)
      }
      // 功率谱（朴素 DFT 到 fft/2，与现有引擎一致）
      for (let k = 0; k <= fft / 2; k++) {
        let re = 0
        let im = 0
        for (let i = 0; i < fft; i++) {
          const ang = (-2 * Math.PI * k * i) / fft
          const v = windowed[i]
          re += v * Math.cos(ang)
          im += v * Math.sin(ang)
        }
        powerSpec[k] = re * re + im * im
      }
      for (let m = 0; m < nMels; m++) {
        const { start: fs, center, end } = filters[m]
        let energy = 0
        for (let k = Math.ceil(fs); k <= Math.floor(end) && k < powerSpec.length; k++) {
          let w = 0
          if (k <= center) w = center === fs ? 1 : (k - fs) / (center - fs)
          else w = end === center ? 1 : (end - k) / (end - center)
          energy += powerSpec[k] * w
        }
        out[f * nMels + m] = Math.log(Math.max(energy, 1e-10))
      }
    }
    return out
  }

  // 在线 LFR（右上下文 + 拼接缓存）→ CMVN；帧不足整 LFR 时返回 null 并暂存
  private lfrCmvn(fbank: Float32Array, newRows: number, isFinal: boolean): Float32Array | null {
    const lfrM = this.cfg.lfrM
    const nMels = this.cfg.nMels
    // 首次：左侧补 (lfrM-1)/2 行首帧（python: repeat first frame）
    if (!this.lfrPadDone) {
      const pad = (lfrM - 1) >> 1
      const padRows = new Float32Array(pad * nMels)
      for (let p = 0; p < pad; p++) padRows.set(fbank.subarray(0, nMels), p * nMels)
      this.lfrCache = padRows
      this.lfrCacheRows = pad
      this.lfrPadDone = true
    }

    // 拼接缓存 + 新帧
    const total = this.lfrCacheRows + newRows
    const combined = new Float32Array(total * nMels)
    combined.set(this.lfrCache, 0)
    combined.set(fbank, this.lfrCacheRows * nMels)

    if (total < lfrM) {
      // 不足一整 LFR 帧：缓存全部，等下一块
      this.lfrCache = combined
      this.lfrCacheRows = total
      return null
    }

    const { frames, splice } = this.applyLfr(combined, total, isFinal)
    this.lfrCache = splice.data
    this.lfrCacheRows = splice.rows
    if (frames.length === 0) return null

    // CMVN（每行维度 featsDim=nMels*lfrM）
    return this.applyCmvn(frames)
  }

  // 移植 WavFrontendOnline.apply_lfr：步长 lfrN、窗口 lfrM（右上下文）
  private applyLfr(inputs: Float32Array, T: number, isFinal: boolean):
    { frames: Float32Array; splice: { data: Float32Array; rows: number } } {
    const lfrM = this.cfg.lfrM
    const lfrN = this.cfg.lfrN
    const nMels = this.cfg.nMels
    const dim = this.featsDim

    // python: T_lfr = ceil((T - (lfr_m-1)//2) / lfr_n)
    const T_lfr = Math.ceil((T - (lfrM - 1) / 2) / lfrN)
    const outRows: Float32Array[] = []
    let spliceIdx = T_lfr
    for (let i = 0; i < T_lfr; i++) {
      if (lfrM <= T - i * lfrN) {
        // 取行 [i*lfrN, i*lfrN+lfrM) 展平
        const frame = new Float32Array(dim)
        for (let r = 0; r < lfrM; r++) {
          frame.set(inputs.subarray((i * lfrN + r) * nMels, (i * lfrN + r + 1) * nMels), r * nMels)
        }
        outRows.push(frame)
      } else {
        if (isFinal) {
          // 末尾补齐（重复最后一行）
          const avail = T - i * lfrN
          const pad = lfrM - avail
          const frame = new Float32Array(dim)
          for (let r = 0; r < avail; r++) {
            frame.set(inputs.subarray((i * lfrN + r) * nMels, (i * lfrN + r + 1) * nMels), r * nMels)
          }
          for (let p = 0; p < pad; p++) {
            frame.set(inputs.subarray((T - 1) * nMels, T * nMels), (avail + p) * nMels)
          }
          outRows.push(frame)
        } else {
          spliceIdx = i
          break
        }
      }
    }
    spliceIdx = Math.min(T - 1, spliceIdx * lfrN)
    const out = new Float32Array(outRows.length * dim)
    outRows.forEach((r, i) => out.set(r, i * dim))
    return { frames: out, splice: { data: inputs.slice(spliceIdx * nMels), rows: T - spliceIdx } }
  }

  private applyCmvn(frames: Float32Array): Float32Array {
    const sh = this.cfg.cmvnShift
    const sc = this.cfg.cmvnScale
    if (!sh || !sc) return frames
    const dim = this.featsDim
    for (let i = 0; i < frames.length; i++) {
      const d = i % dim
      frames[i] = (frames[i] + (d < sh.length ? sh[d] : 0)) * (d < sc.length ? sc[d] : 1)
    }
    return frames
  }

  // ---------- 在线正弦位置编码（SinusoidalPositionEncoderOnline） ----------

  private applyPosEnc(feats: Float32Array, rows: number): void {
    const dim = this.featsDim
    const half = dim / 2
    const logT = Math.log(10000) / (half - 1)
    const start = this.cache.startIdx
    for (let r = 0; r < rows; r++) {
      const pos = start + r + 1 // python positions 从 1 起，取 [start_idx, start_idx+T)
      const base = r * dim
      for (let k = 0; k < half; k++) {
        const ang = pos * Math.exp(-k * logT)
        feats[base + k] += Math.sin(ang)
        feats[base + half + k] += Math.cos(ang)
      }
    }
  }

  // ---------- overlap chunk（add_overlap_chunk） ----------

  private addOverlapChunk(feats: Float32Array, rows: number): { data: Float32Array; rows: number } {
    const c = this.cache
    const [c0, , c2] = this.cfg.chunkSize
    const dim = this.featsDim
    const cacheRows = c.featsCacheRows
    const overlapRows = cacheRows + rows
    const overlap = new Float32Array(overlapRows * dim)
    overlap.set(c.featsCache.subarray(0, cacheRows * dim), 0)
    overlap.set(feats, cacheRows * dim)

    let outData = overlap
    let outRows = overlapRows
    if (c.isFinal) {
      c.featsCacheRows = Math.min(c0, overlapRows)
      c.featsCache.set(overlap.subarray((overlapRows - c.featsCacheRows) * dim), 0)
      if (!c.lastChunk) {
        const need = c0 + this.cfg.chunkSize[1] + c2 - overlapRows
        if (need > 0) {
          const padded = new Float32Array((overlapRows + need) * dim)
          padded.set(overlap, 0)
          outData = padded
          outRows = overlapRows + need
        }
      }
    } else {
      const keep = Math.min(c0 + c2, overlapRows)
      c.featsCacheRows = keep
      c.featsCache.set(overlap.subarray((overlapRows - keep) * dim), 0)
    }
    return { data: outData, rows: outRows }
  }

  // ---------- 推理编排（对应官方 infer()） ----------

  private async inferFeats(feats: Float32Array, featsRows: number): Promise<FunasrChunkText | null> {
    const c = this.cache
    const encR = await this.inf.runEncoder(feats, featsRows)
    const { embeds, embedRows } = this.cifSearch(encR)
    if (embedRows <= 0) return null

    const decR = await this.inf.runDecoder({
      enc: encR.enc,
      encRows: encR.encRows,
      encDim: encR.encDim,
      embeds,
      embedRows,
      fsmn: c.decoderFsmn.length ? c.decoderFsmn : this.zeroFsmn()
    })
    // 截尾保存：与 python item[:, :, -lorder:] 一致——每个 encSize 行保留最后 lorder 列
    // （fsmn 输出 dims 为 (1, encSize, L)，C-order 下每个 encSize 行是连续 L 个）
    const lorder = this.cfg.fsmnLorder
    c.decoderFsmn = decR.fsmn.map((f) => {
      const encDim = encR.encDim
      const L = Math.floor(f.length / encDim)
      if (L <= lorder) return f
      const out = new Float32Array(encDim * lorder)
      for (let d = 0; d < encDim; d++) {
        const srcStart = d * L + (L - lorder)
        out.set(f.subarray(srcStart, srcStart + lorder), d * lorder)
      }
      return out
    })

    return this.decodeLogits(decR, embedRows)
  }

  private zeroFsmn(): Float32Array[] {
    const encDim = this.cfg.encoderOutputSize
    const lorder = this.cfg.fsmnLorder
    const arr: Float32Array[] = []
    for (let i = 0; i < this.cfg.fsmnLayers; i++) arr.push(new Float32Array(encDim * lorder))
    return arr
  }

  // CIF 搜索（移植 cif_search，batch=1）→ 触发帧 acoustic embeds
  private cifSearch(encR: FunasrEncoderResult): { embeds: Float32Array; embedRows: number } {
    const c = this.cache
    const [c0, c1] = this.cfg.chunkSize
    const encDim = encR.encDim
    const T = encR.encRows
    const th = this.cfg.cifThreshold
    const alphas = encR.alphas.slice(0, T)

    // 官方：清零非当前窗口的 alpha（[0,c0) 与 [c0+c1, T)）
    for (let i = 0; i < Math.min(c0, T); i++) alphas[i] = 0
    for (let i = c0 + c1; i < T; i++) alphas[i] = 0

    // 拼接 cache
    let hiddenTotal: Float32Array
    let alphaTotal: number[]
    if (c.cifHidden) {
      hiddenTotal = new Float32Array((T + 1) * encDim)
      hiddenTotal.set(c.cifHidden, 0)
      hiddenTotal.set(encR.enc, 1 * encDim)
      alphaTotal = [c.cifAlpha, ...Array.from(alphas)]
    } else {
      hiddenTotal = encR.enc.slice(0, T * encDim)
      alphaTotal = Array.from(alphas)
    }
    if (c.lastChunk) {
      const tailH = new Float32Array(encDim)
      hiddenTotal = this.concatRows(hiddenTotal, hiddenTotal.length / encDim, tailH)
      alphaTotal.push(this.cfg.tailThreshold)
    }

    const totalT = alphaTotal.length
    let integrate = 0
    let frames = new Float32Array(encDim)
    const listFrame: Float32Array[] = []
    for (let t = 0; t < totalT; t++) {
      const alpha = alphaTotal[t]
      if (alpha + integrate < th) {
        integrate += alpha
        for (let j = 0; j < encDim; j++) frames[j] += alpha * hiddenTotal[t * encDim + j]
      } else {
        // 触发一帧
        const w = th - integrate
        const fired = new Float32Array(encDim)
        for (let j = 0; j < encDim; j++) {
          fired[j] = frames[j] + w * hiddenTotal[t * encDim + j]
          frames[j] = 0
        }
        listFrame.push(fired)
        integrate += alpha
        integrate -= th
        for (let j = 0; j < encDim; j++) frames[j] = integrate * hiddenTotal[t * encDim + j]
      }
    }
    // 写回 cache
    c.cifAlpha = integrate
    if (integrate > 0) {
      const hid = new Float32Array(encDim)
      for (let j = 0; j < encDim; j++) hid[j] = frames[j] / integrate
      c.cifHidden = hid
    } else {
      c.cifHidden = frames
    }

    const K = listFrame.length
    const embeds = new Float32Array(K * encDim)
    listFrame.forEach((fr, i) => embeds.set(fr, i * encDim))
    return { embeds, embedRows: K }
  }

  private concatRows(base: Float32Array, baseRows: number, tail: Float32Array): Float32Array {
    const dim = tail.length
    const out = new Float32Array((baseRows + 1) * dim)
    out.set(base, 0)
    out.set(tail, baseRows * dim)
    return out
  }

  // ---------- 解码（decode_one + sentence_postprocess，batch=1） ----------

  private decodeLogits(decR: FunasrDecoderResult, validTokens: number): FunasrChunkText {
    const { logits, rows, vocab } = decR
    const ids: number[] = []
    for (let t = 0; t < rows; t++) {
      let mx = -Infinity
      let arg = 0
      const base = t * vocab
      for (let v = 0; v < vocab; v++) {
        const val = logits[base + v]
        if (val > mx) {
          mx = val
          arg = v
        }
      }
      ids.push(arg)
    }
    // python：yseq=[1]+ids+[2]，取 [1:-1] 后过滤 0/2
    const tokenInt = ids.filter((x) => x !== 0 && x !== 2)
    const vocabList = this.cfg.vocab
    let tokens = tokenInt.map((x) => (x < vocabList.length ? vocabList[x] : `<${x}>`))
    if (validTokens > 0 && tokens.length > validTokens) tokens = tokens.slice(0, validTokens)
    return sentencePostprocess(tokens)
  }
}

// ==================== sentence_postprocess（无时间戳） ====================
// 移植 postprocess_utils.py：返回 { text, realWords }

function isChineseChar(ch: string): boolean {
  return (ch >= '\u4e00' && ch <= '\u9fff') || (ch >= '0' && ch <= '9')
}

function isAllChinese(word: string[]): boolean {
  const cleaned = word.map((i) => i.replace(/ /g, '').replace(/<\/s>/g, '').replace(/<s>/g, ''))
  if (cleaned.length === 0) return false
  for (const ch of cleaned) if (!isChineseChar(ch)) return false
  return true
}

function isAllAlpha(word: string[]): boolean {
  const cleaned = word.map((i) => i.replace(/ /g, '').replace(/<\/s>/g, '').replace(/<s>/g, ''))
  if (cleaned.length === 0) return false
  for (const ch of cleaned) {
    if (!/^[A-Za-z]+$/.test(ch) && ch !== "'") return false
  }
  return true
}

// abbr_dispose（ASCII 缩略词大写），保持与官方文本一致
function abbrDispose(words: string[]): string[] {
  const out: string[] = []
  const size = words.length
  const isSingleAlpha = (i: number) => words[i] && words[i].length === 1 && /^[A-Za-z]$/.test(words[i])
  const abbrBegin: number[] = []
  const abbrEnd: number[] = []
  let lastNum = -1
  for (let num = 0; num < size; num++) {
    if (num <= lastNum) continue
    if (isSingleAlpha(num) && num + 1 < size && words[num + 1] === ' ' && isSingleAlpha(num + 2)) {
      abbrBegin.push(num)
      let e = num + 2
      num = e
      while (true) {
        if (num + 1 < size && words[num + 1] === ' ' && isSingleAlpha(num + 2)) {
          e = num + 2
          num = e
        } else break
      }
      abbrEnd.push(e)
      lastNum = e
    }
  }
  lastNum = -1
  for (let num = 0; num < size; num++) {
    if (num <= lastNum) continue
    if (abbrBegin.includes(num)) {
      out.push(words[num].toUpperCase())
      let n = num + 1
      while (n < size) {
        if (abbrEnd.includes(n)) {
          out.push(words[n].toUpperCase())
          lastNum = n
          break
        } else {
          if (/^[A-Za-z]$/.test(words[n])) out.push(words[n].toUpperCase())
          n++
        }
      }
    } else {
      out.push(words[num])
    }
  }
  return out
}

export function sentencePostprocess(wordsIn: string[]): { text: string; tokens: string[] } {
  // wash
  const middle: string[] = []
  for (const w of wordsIn) {
    if (w === '<s>' || w === '</s>' || w === '<unk>') continue
    middle.push(w)
  }
  const wordLists: string[] = []
  const realWords: string[] = []

  if (isAllChinese(middle)) {
    for (const ch of middle) wordLists.push(ch.replace(/ /g, ''))
  } else if (isAllAlpha(middle)) {
    let item = ''
    for (const ch of middle) {
      if (ch.includes('@@')) {
        item += ch.replace(/@@/g, '')
      } else {
        item += ch
        wordLists.push(item)
        wordLists.push(' ')
        item = ''
      }
    }
  } else {
    // 混合
    let alphaBlank = false
    let item = ''
    for (const ch of middle) {
      if (isAllChinese([ch])) {
        if (alphaBlank) wordLists.pop()
        wordLists.push(ch)
        alphaBlank = false
      } else if (ch.includes('@@')) {
        item += ch.replace(/@@/g, '')
        alphaBlank = false
      } else if (isAllAlpha([ch])) {
        item += ch
        wordLists.push(item)
        wordLists.push(' ')
        item = ''
        alphaBlank = true
      }
      // python 对非法字符 raise；此处容错跳过
    }
  }

  const processed = abbrDispose(wordLists)
  for (const ch of processed) if (ch !== ' ') realWords.push(ch)
  return { text: processed.join('').trim(), tokens: realWords }
}
