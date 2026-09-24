// src/services/asr/asr-onnx-worker.ts
// ONNX 推理 Web Worker：把 onnxruntime-web 的模型加载与 session.run 放到独立线程执行，
// 避免阻塞渲染主线程（解决「识别时 UI/动画卡死」，即主线程被单线程 WASM 推理占住的问题）。
//
// 职责划分：
//   主线程（OnnxWhisperRecognizer）：录音采集、特征预处理（Mel/LFR/CMVN）、tokenizer 解码
//   本 worker：ORT 初始化、创建 InferenceSession、执行推理，并返回输出张量
//
// 协议：
//   → { type:'init', id, modelPath }                    创建会话
//   ← { type:'init-done', id, inputNames, outputNames, inputMetadata }
//   ← { type:'init-error', id, message }
//   → { type:'run', id, feeds:{ name:{type,data,dims} } }  执行推理（feed data 走转移缓冲）
//   ← { type:'run-done', id, results:{ name:{type,dims,data:ArrayBuffer} } }
//   ← { type:'run-error', id, message }
//   → { type:'release', id }                              释放会话（可选）

let ort: any = null
let session: any = null

// ===== FunASR 流式 online：双 session（encoder + decoder）=====
let encSession: any = null
let decSession: any = null
let encInputNames: string[] = []
let encOutputNames: string[] = []
let decInputNames: string[] = []
let decOutputNames: string[] = []

// ===== ct-punc 标点恢复：单 session（文本分类，离线补标点）=====
let puncSession: any = null
let puncInputNames: string[] = []
let puncOutputNames: string[] = []

// 把 ort.Tensor 转成可 postMessage 的普通对象（data 取底层 ArrayBuffer 以便零拷贝转移）
function tensorToPlain(t: any): any {
  const data = t && t.data
  let buf: ArrayBuffer
  if (data instanceof ArrayBuffer) {
    buf = data
  } else if (data && typeof data.buffer !== 'undefined' && data.buffer instanceof ArrayBuffer) {
    // byteOffset 不为 0 或缓冲区比实际数据大时，拷贝一份干净缓冲（避免转移整块后读错位置）
    if (data.byteOffset === 0 && data.buffer.byteLength === data.byteLength) {
      buf = data.buffer
    } else {
      buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    }
  } else {
    // 标量（如 token_num 的 number）：包一层 float32
    buf = new Float32Array([data]).buffer
  }
  return {
    type: t && t.type ? t.type : 'float32',
    dims: Array.isArray(t && t.dims) ? t.dims : [],
    data: buf
  }
}

// 把主线程传来的 plain feed（{type,data,dims}）包装成 ort.Tensor
function buildFeeds(ortModule: any, feeds: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [name, f] of Object.entries(feeds || {})) {
    const { type, data, dims } = (f || {}) as any
    out[name] = new ortModule.Tensor(type, data, dims)
  }
  return out
}

// ===== FunASR online 辅助 =====

// 按输入名顺序把 plain 输入包成 feed 对象（python 端为位置传参，这里按 inputNames 对齐）
function buildOrderedFeeds(ortModule: any, inputNames: string[], inputsPlain: any[]): Record<string, any> {
  const feeds: Record<string, any> = {}
  for (let i = 0; i < inputNames.length; i++) {
    const f = inputsPlain[i] || {}
    feeds[inputNames[i]] = new ortModule.Tensor(f.type, f.data, f.dims)
  }
  return feeds
}

// 把 run 输出对象按 outputNames 顺序转 plain，返回可转移的 data
function serializeOutputs(outputNames: string[], results: Record<string, any>):
  { outputs: any[]; transfer: ArrayBuffer[] } {
  const outputs: any[] = []
  const transfer: ArrayBuffer[] = []
  for (const name of outputNames) {
    const p = tensorToPlain(results[name])
    outputs.push(p)
    if (p.data instanceof ArrayBuffer) transfer.push(p.data)
  }
  return { outputs, transfer }
}

async function ensureOrtLoaded(): Promise<void> {
  if (ort) return
  ort = await import('onnxruntime-web/wasm')
  const ortEnv = ort.env
  delete ortEnv.wasm.wasmPaths
}

// 支持直接传字节（ArrayBuffer/Uint8Array）或路径字符串；字节方式不依赖 file:// fetch
async function loadOrtModel(src: any): Promise<any> {
  await ensureOrtLoaded()
  const opts = {
    executionProviders: ['webgl', 'wasm'],
    graphOptimizationLevel: 'all'
  }
  if (src instanceof ArrayBuffer) return ort.InferenceSession.create(new Uint8Array(src), opts)
  if (src instanceof Uint8Array) return ort.InferenceSession.create(src, opts)
  return ort.InferenceSession.create(src, opts)
}

// 释放 online 会话（下次 init-online 重建）
async function releaseOnline(): Promise<void> {
  for (const s of [encSession, decSession]) {
    try { await s?.release?.() } catch (e) { /* ignore */ }
  }
  encSession = null
  decSession = null
}

// 释放 punc 会话（目录变化重建时调用；下次 init-punc 重建）
async function releasePunc(): Promise<void> {
  try { await puncSession?.release?.() } catch (e) { /* ignore */ }
  puncSession = null
  puncInputNames = []
  puncOutputNames = []
}

(self as any).onmessage = async (e: MessageEvent) => {
  const msg = e.data || {}
  const id = msg.id
  try {
    if (msg.type === 'init') {
      if (!session) {
        // 动态导入 onnxruntime-web 的 WASM-only 包（避免加载 JSEP）
        ort = await import('onnxruntime-web/wasm')
        // WASM bundle 已内联 WASM 二进制，无需设置 wasmPaths
        // 清除 wasmPaths 避免库尝试动态加载外部 .mjs 文件
        const ortEnv = ort.env
        delete ortEnv.wasm.wasmPaths
        session = await ort.InferenceSession.create(msg.modelPath, {
          // 尝试用 WebGL 后端（WASM 的广播运算有限制）；若 WebGL 不可用则回退到 WASM
          executionProviders: ['webgl', 'wasm'],
          graphOptimizationLevel: 'all'
        })
      }
      ;(self as any).postMessage({
        type: 'init-done',
        id,
        inputNames: session.inputNames,
        outputNames: session.outputNames,
        inputMetadata: (session as any).inputMetadata || {}
      })
    } else if (msg.type === 'run') {
      if (!session || !ort) throw new Error('模型未加载')
      const results = await session.run(buildFeeds(ort, msg.feeds))
      const plain: Record<string, any> = {}
      const transfer: ArrayBuffer[] = []
      for (const [name, tensor] of Object.entries(results)) {
        const p = tensorToPlain(tensor as any)
        plain[name] = p
        if (p.data instanceof ArrayBuffer) transfer.push(p.data)
      }
      ;(self as any).postMessage({ type: 'run-done', id, results: plain }, transfer)
    } else if (msg.type === 'init-online') {
      // 双 session：msg.encoder/msg.decoder 传 Uint8Array（字节）或路径字符串
      await releaseOnline()
      encSession = await loadOrtModel(msg.encoder ?? msg.encoderPath)
      decSession = await loadOrtModel(msg.decoder ?? msg.decoderPath)
      encInputNames = encSession.inputNames
      encOutputNames = encSession.outputNames
      decInputNames = decSession.inputNames
      decOutputNames = decSession.outputNames
      ;(self as any).postMessage({
        type: 'init-online-done',
        id,
        encInputNames,
        encOutputNames,
        decInputNames,
        decOutputNames
      })
    } else if (msg.type === 'run-online-enc') {
      if (!encSession || !ort) throw new Error('online encoder 未加载')
      const feeds = buildOrderedFeeds(ort, encInputNames, msg.inputs)
      const results = await encSession.run(feeds)
      const { outputs, transfer } = serializeOutputs(encOutputNames, results)
      ;(self as any).postMessage({ type: 'run-online-enc-done', id, outputs }, transfer)
    } else if (msg.type === 'run-online-dec') {
      if (!decSession || !ort) throw new Error('online decoder 未加载')
      const feeds = buildOrderedFeeds(ort, decInputNames, msg.inputs)
      const results = await decSession.run(feeds)
      const { outputs, transfer } = serializeOutputs(decOutputNames, results)
      ;(self as any).postMessage({ type: 'run-online-dec-done', id, outputs }, transfer)
    } else if (msg.type === 'init-punc') {
      // ct-punc：单 session 文本分类；msg.model 传字节或路径
      await releasePunc()
      puncSession = await loadOrtModel(msg.model ?? msg.modelPath)
      puncInputNames = puncSession.inputNames
      puncOutputNames = puncSession.outputNames
      ;(self as any).postMessage({
        type: 'init-punc-done',
        id,
        inputNames: puncInputNames,
        outputNames: puncOutputNames
      })
    } else if (msg.type === 'run-punc') {
      if (!puncSession || !ort) throw new Error('punc 模型未加载')
      const feeds = buildOrderedFeeds(ort, puncInputNames, msg.inputs)
      const results = await puncSession.run(feeds)
      const { outputs, transfer } = serializeOutputs(puncOutputNames, results)
      ;(self as any).postMessage({ type: 'run-punc-done', id, outputs }, transfer)
    } else if (msg.type === 'release-punc') {
      await releasePunc()
      ;(self as any).postMessage({ type: 'release-punc-done', id })
    } else if (msg.type === 'release-online') {
      await releaseOnline()
      ;(self as any).postMessage({ type: 'release-online-done', id })
    } else if (msg.type === 'release') {
      try { await session?.release?.() } catch (e) { /* ignore */ }
      session = null
      ;(self as any).postMessage({ type: 'release-done', id })
    }
  } catch (error: any) {
    const t = msg.type || ''
    const errType = (t === 'init' || t === 'init-online' || t === 'init-punc') ? `${t}-error` : 'run-error'
    ;(self as any).postMessage({
      type: errType,
      id,
      message: String((error && error.message) || error)
    })
  }
}
