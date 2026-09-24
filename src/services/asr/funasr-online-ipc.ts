// src/services/asr/funasr-online-ipc.ts
// FunASR online 双 session 的渲染端客户端：读模型目录文件 → 初始化 asr-onnx-worker 的
// encoder/decoder 两个 session → 实现 FunasrOnlineInference（缓存 fsmn 在主线程侧流转，
// worker 侧只做无状态 run）。供 FunasrOnlineRuntime（funasr-online.ts）端到端使用。
//
// 需要 Electron 环境（window.ipcRenderer）：
//   readFileBinary  → Uint8Array（onnx / wav）
//   readFile        → 文本（config.yaml / am.mvn / tokens.json）

import type { FunasrOnlineInference, FunasrOnlineModelConfig } from '@/services/asr/funasr-online'
import { buildFunasrOnlineConfig } from '@/services/asr/funasr-online-config'

function pathJoin(dir: string, file: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.endsWith(sep) ? dir + file : dir + sep + file
}

function toTypedArray(type: string, buf: ArrayBuffer): any {
  switch (type) {
    case 'float32': return new Float32Array(buf)
    case 'float64': return new Float64Array(buf)
    case 'int32': return new Int32Array(buf)
    case 'int64': return new BigInt64Array(buf)
    case 'uint8': return new Uint8Array(buf)
    default: return new Float32Array(buf)
  }
}

export interface FunasrOnlineLoaded {
  cfg: FunasrOnlineModelConfig
  inference: FunasrOnlineInference
  release: () => Promise<void>
}

// 懒创建单例 worker（与离线 OnnxWhisperRecognizer 各自独立，互不干扰）
let worker: Worker | null = null
let nextMsgId = 1
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./asr-onnx-worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data
      const p = m && m.id ? pending.get(m.id) : undefined
      if (!p) return
      pending.delete(m.id)
      if (String(m.type).endsWith('-error')) p.reject(new Error(m.message || 'funasr online worker 错误'))
      else p.resolve(m)
    }
    worker.onerror = (e: ErrorEvent) => {
      const err = new Error(e.message || 'funasr online worker 错误')
      for (const p of pending.values()) p.reject(err)
      pending.clear()
    }
  }
  return worker
}

function requestWorker(type: string, payload: any, transfer?: Transferable[]): Promise<any> {
  const id = nextMsgId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      const msg = { type, id, ...payload }
      const w = getWorker()
      if (transfer && transfer.length) w.postMessage(msg, transfer)
      else w.postMessage(msg)
    } catch (e) {
      pending.delete(id)
      reject(e)
    }
  })
}

async function readBinary(path: string): Promise<Uint8Array | null> {
  const ipc = (window as any).ipcRenderer
  if (!ipc) throw new Error('非 Electron 环境：无法读取本地模型')
  const b = await ipc.invoke('readFileBinary', path)
  return b instanceof Uint8Array ? b : null
}

async function readText(path: string): Promise<string | null> {
  const ipc = (window as any).ipcRenderer
  if (!ipc) return null
  const t = await ipc.invoke('readFile', path)
  if (typeof t !== 'string' || t.startsWith('Error reading file')) return null
  return t
}

function pick(bytes: Uint8Array | null, fallback: Uint8Array | null): Uint8Array | null {
  return bytes || fallback
}

export interface FunasrModelDirOptions {
  dir: string
  chunkSize?: [number, number, number]
  preferQuant?: boolean // 默认优先 *_quant.onnx
}

export async function loadFunasrOnline(opts: FunasrModelDirOptions): Promise<FunasrOnlineLoaded> {
  const { dir } = opts
  const quant = opts.preferQuant !== false
  const encCands = quant ? ['model_quant.onnx', 'model.onnx'] : ['model.onnx', 'model_quant.onnx']
  const decCands = quant ? ['decoder_quant.onnx', 'decoder.onnx'] : ['decoder.onnx', 'decoder_quant.onnx']

  let encoderBytes: Uint8Array | null = null
  let decoderBytes: Uint8Array | null = null
  for (const f of encCands) {
    const b = await readBinary(pathJoin(dir, f))
    if (b) { encoderBytes = b; break }
  }
  for (const f of decCands) {
    const b = await readBinary(pathJoin(dir, f))
    if (b) { decoderBytes = b; break }
  }
  if (!encoderBytes || !decoderBytes) {
    throw new Error(`模型目录缺少 encoder/decoder onnx：${dir}\n需要 model[_quant].onnx + decoder[_quant].onnx`)
  }

  const yamlText = await readText(pathJoin(dir, 'config.yaml'))
  const mvnText = await readText(pathJoin(dir, 'am.mvn'))
  const tokensText = await readText(pathJoin(dir, 'tokens.json'))
  if (!yamlText || !tokensText) {
    throw new Error(`模型目录缺少 config.yaml / tokens.json：${dir}`)
  }
  const cfg = buildFunasrOnlineConfig({ yamlText, mvnText, tokensText }, opts.chunkSize)

  const init = await requestWorker('init-online', { encoder: encoderBytes, decoder: decoderBytes },
    [encoderBytes.buffer as ArrayBuffer, decoderBytes.buffer as ArrayBuffer])

  const fsmnLayers = cfg.fsmnLayers

  const inference: FunasrOnlineInference = {
    async runEncoder(feats: Float32Array, featsRows: number) {
      const featsDim = cfg.nMels * cfg.lfrM
      const res = await requestWorker('run-online-enc', {
        inputs: [
          { type: 'float32', data: feats, dims: [1, featsRows, featsDim] },
          { type: 'int32', data: Int32Array.from([featsRows]), dims: [1] }
        ]
      })
      const outs = res.outputs as { type: string; dims: number[]; data: ArrayBuffer }[]
      const enc = outs[0]
      const alphas = outs[2]
      const encRows = enc.dims[1]
      const encDim = enc.dims[2]
      return {
        enc: toTypedArray(enc.type, enc.data),
        encRows,
        encDim,
        alphas: toTypedArray(alphas.type, alphas.data)
      }
    },
    async runDecoder(a: { enc: Float32Array; encRows: number; encDim: number; embeds: Float32Array; embedRows: number; fsmn: Float32Array[] }) {
      const inputs: { type: string; data: any; dims: number[] }[] = [
        { type: 'float32', data: a.enc, dims: [1, a.encRows, a.encDim] },
        { type: 'int32', data: Int32Array.from([a.encRows]), dims: [1] },
        { type: 'float32', data: a.embeds, dims: [1, a.embedRows, a.encDim] },
        { type: 'int32', data: Int32Array.from([a.embedRows]), dims: [1] }
      ]
      // fsmn 缓存：运行时持有 encDim*lorder 展平（每 encDim 行 lorder 列）
      inputs.push(...a.fsmn.map((f) => {
        const encDim = a.encDim
        const l = Math.floor(f.length / encDim)
        return { type: 'float32', data: f, dims: [1, encDim, l] }
      }))
      const res = await requestWorker('run-online-dec', { inputs })
      const outs = res.outputs as { type: string; dims: number[]; data: ArrayBuffer }[]
      const logits = outs[0]
      const rows = logits.dims[1]
      const vocab = logits.dims[2]
      const fsmnOut: Float32Array[] = []
      for (let i = 2; i < Math.min(2 + fsmnLayers, outs.length); i++) {
        fsmnOut.push(toTypedArray(outs[i].type, outs[i].data))
      }
      return {
        logits: toTypedArray(logits.type, logits.data),
        rows,
        vocab,
        fsmn: fsmnOut
      }
    }
  }

  const release = async () => {
    try { await requestWorker('release-online', {}) } catch (e) { /* ignore */ }
  }

  return { cfg, inference, release }
}
