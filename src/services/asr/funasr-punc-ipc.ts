// src/services/asr/funasr-punc-ipc.ts
// 官方 ct-punc 标点模型的渲染端客户端：读模型目录文件 → 初始化 asr-onnx-worker 的
// punc 单 session → 包装 FunasrPuncEngine（funasr-punc.ts）供「本地补标点」使用。
// 供 asr-manager.ts（funasr-online 引擎的本地标点选项）按需懒加载/缓存。
//
// 需要 Electron 环境（window.ipcRenderer）：
//   readFileBinary → Uint8Array（model[_quant].onnx）
//   readFile       → 文本（config.yaml / tokens.json）

import type { FunasrPuncConfig } from '@/services/asr/funasr-punc-config'
import { buildFunasrPuncConfig } from '@/services/asr/funasr-punc-config'
import { FunasrPuncEngine } from '@/services/asr/funasr-punc'

function pathJoin(dir: string, file: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.endsWith(sep) ? dir + file : dir + sep + file
}

function toFloat32(buf: ArrayBuffer): Float32Array {
  return new Float32Array(buf)
}

export interface FunasrPuncHandle {
  dir: string
  cfg: FunasrPuncConfig
  punctuate: (text: string) => Promise<string>
  release: () => Promise<void>
}

// 懒创建单例 worker（独立于 funasr-online 的 worker；punc 与 encoder/decoder 互不干扰）
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
      if (String(m.type).endsWith('-error')) p.reject(new Error(m.message || 'funasr punc worker 错误'))
      else p.resolve(m)
    }
    worker.onerror = (e: ErrorEvent) => {
      const err = new Error(e.message || 'funasr punc worker 错误')
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

export interface FunasrPuncDirOptions {
  dir: string
  preferQuant?: boolean // 默认优先 model_quant.onnx
}

// 加载 ct-punc 模型目录并返回可用的句柄（含 engine；目录不存在对应文件则抛错）
export async function loadFunasrPunc(opts: FunasrPuncDirOptions): Promise<FunasrPuncHandle> {
  const { dir } = opts
  const quant = opts.preferQuant !== false
  const cands = quant ? ['model_quant.onnx', 'model.onnx'] : ['model.onnx', 'model_quant.onnx']

  let modelBytes: Uint8Array | null = null
  for (const f of cands) {
    const b = await readBinary(pathJoin(dir, f))
    if (b) { modelBytes = b; break }
  }
  if (!modelBytes) {
    throw new Error(`标点模型目录缺少 onnx：${dir}\n需要 model[_quant].onnx（ct-punc）`)
  }
  const yamlText = await readText(pathJoin(dir, 'config.yaml'))
  const tokensText = await readText(pathJoin(dir, 'tokens.json'))
  if (!yamlText || !tokensText) {
    throw new Error(`标点模型目录缺少 config.yaml / tokens.json：${dir}`)
  }
  const cfg = buildFunasrPuncConfig({ yamlText, tokensText })

  const init = await requestWorker('init-punc', { model: modelBytes },
    [modelBytes.buffer as ArrayBuffer])

  const inference = {
    async runText(ids: Int32Array): Promise<Float32Array> {
      const res = await requestWorker('run-punc', {
        inputs: [
          { type: 'int32', data: ids, dims: [1, ids.length] },
          { type: 'int32', data: Int32Array.from([ids.length]), dims: [1] }
        ]
      })
      const outs = res.outputs as { type: string; dims: number[]; data: ArrayBuffer }[]
      if (!outs || !outs.length) throw new Error('punc 推理无输出')
      return toFloat32(outs[0].data)
    }
  }
  const engine = new FunasrPuncEngine(cfg, inference)

  const release = async () => {
    try { await requestWorker('release-punc', {}) } catch (e) { /* ignore */ }
  }

  return {
    dir,
    cfg,
    punctuate: (text: string) => engine.punctuate(text),
    release
  }
}
