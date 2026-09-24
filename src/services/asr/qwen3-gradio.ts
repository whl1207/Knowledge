// src/services/asr/qwen3-gradio.ts
// Qwen3-ASR 网页服务（Gradio）协议实现：上传音频 → POST /call/run 取 event_id → 读 SSE 取识别文本。
// 供两条路径共用：
//   ① 整段模式（qwen3-stream-mic 之外的 Qwen3ASRRecognizer：录完再整段转写）
//   ② 分段准流式（qwen3-stream-mic：VAD 分段逐段提交）
// 手册（Qwen3-ASR WebUI）：API 名 /run，6 个入参（file_path / lang_disp / return_ts / split_punc /
// diarize / max_chars），返回 5 个出参，其中 [1] 为识别文本。

export interface Qwen3GradioOptions {
  base: string // 形如 http://127.0.0.1:7867（自动规范化，可带尾斜杠或粘贴完整接口地址）
  apiKey?: string
  langDisp?: string // 语种选择（默认「自动识别」）
  returnTs?: boolean // 单词级时间戳
  splitPunc?: boolean // 跟随结果文本标点断句
  diarize?: boolean // 说话人角色识别
  maxChars?: number // 单行最大字符数
  timeoutMs?: number // 单次等待上限（默认 180s）
}

// Gradio 5/6 把 API 挂在 /gradio_api 下，4.x 直接挂根路径；按地址缓存实际可用前缀
const gradioPrefixCache = new Map<string, string>()

// 规范化网页服务地址：去尾斜杠；容忍用户粘贴完整页面/接口地址（含 /gradio_api/call/run 等）
export function normalizeGradioBase(url: string): string {
  let u = (url || '').trim()
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`
  try {
    const parsed = new URL(u)
    let path = parsed.pathname || '/'
    const idx = path.indexOf('/gradio_api')
    if (idx >= 0) path = path.slice(0, idx)
    else path = path.replace(/\/(call|upload|config|queue|run)\b.*$/i, '')
    path = path.replace(/\/+$/, '')
    return parsed.origin + path
  } catch {
    return u.replace(/\/+$/, '')
  }
}

// Float32 采样 → 16bit PCM WAV
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Blob {
  const dataLen = samples.length * 2
  const buf = new ArrayBuffer(44 + dataLen)
  const view = new DataView(buf)
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataLen, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // 单声道
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, dataLen, true)
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }
  return new Blob([buf], { type: 'audio/wav' })
}

// 16k 单声道 PCM → WAV（分段模式用，避免额外转码）
export function pcm16kToWavBlob(pcm: Float32Array): Blob {
  return encodeWavPcm16(pcm, 16000)
}

// 浏览器录音 Blob（多为 webm/opus）转 16kHz 单声道 WAV：
// 网页服务端不一定带 ffmpeg，WAV 兼容性最稳
export async function toWav16k(blob: Blob): Promise<Blob> {
  const arrayBuf = await blob.arrayBuffer()
  const AnyWindow = window as any
  const AC = AnyWindow.AudioContext || AnyWindow.webkitAudioContext
  if (!AC) throw new Error('当前环境不支持音频转码')
  const ctx = new AC()
  let audioBuf: AudioBuffer
  try {
    audioBuf = await ctx.decodeAudioData(arrayBuf)
  } finally {
    try { await ctx.close() } catch (e) { /* ignore */ }
  }
  const sampleRate = 16000
  const frames = Math.max(1, Math.ceil(audioBuf.duration * sampleRate))
  const OAC = AnyWindow.OfflineAudioContext || AnyWindow.webkitOfflineAudioContext
  if (!OAC) throw new Error('当前环境不支持音频重采样')
  const offline = new OAC(1, frames, sampleRate)
  const source = offline.createBufferSource()
  source.buffer = audioBuf
  source.connect(offline.destination)
  source.start()
  const rendered = await offline.startRendering()
  return encodeWavPcm16(rendered.getChannelData(0), sampleRate)
}

// 上传音频到 Gradio，返回服务端文件路径
async function gradioUpload(base: string, prefix: string, audio: Blob, fileName: string): Promise<string> {
  const formData = new FormData()
  formData.append('files', audio, fileName)
  const res = await fetch(`${base}${prefix}/upload`, { method: 'POST', body: formData })
  if (!res.ok) throw new Error(`上传音频失败: ${res.status} ${res.statusText}`)
  const json: any = await res.json()
  const first = Array.isArray(json) ? json[0] : json?.files?.[0]
  const serverPath = typeof first === 'string' ? first : first?.path
  if (!serverPath) throw new Error('上传音频失败：服务端未返回文件路径')
  return String(serverPath)
}

// 提交 /run 任务（手册固定 6 个入参），返回 event_id
async function gradioSubmit(
  base: string,
  prefix: string,
  opts: Qwen3GradioOptions,
  serverPath: string,
  fileName: string
): Promise<string> {
  const payload = {
    data: [
      { path: serverPath, orig_name: fileName, meta: { _type: 'gradio.FileData' } },
      opts.langDisp || '自动识别',
      opts.returnTs !== false,
      opts.splitPunc !== false,
      opts.diarize === true,
      typeof opts.maxChars === 'number' && isFinite(opts.maxChars) ? opts.maxChars : 40,
    ],
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.apiKey) headers['Authorization'] = `Bearer ${opts.apiKey}`
  const res = await fetch(`${base}${prefix}/call/run`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`调用失败: ${res.status} ${res.statusText}${detail ? ` - ${detail.slice(0, 200)}` : ''}`)
  }
  const json: any = await res.json()
  if (!json?.event_id) throw new Error('调用失败：服务端未返回 event_id')
  return String(json.event_id)
}

// 读取 SSE 结果流，返回 /run 的 5 个输出（[1] 为识别文本）
async function gradioAwaitResult(base: string, prefix: string, eventId: string, timeoutMs: number): Promise<any[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let finished = false // 正常拿到 complete 后不再 abort，避免控制台/网络面板出现无意义的 ERR_ABORTED
  try {
    const res = await fetch(`${base}${prefix}/call/run/${eventId}`, { method: 'GET', signal: controller.signal })
    if (!res.ok || !res.body) throw new Error(`获取结果失败: ${res.status} ${res.statusText}`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let eventName = ''
    let dataLines: string[] = []
    const parse = (raw: string): any => {
      try { return JSON.parse(raw) } catch { return raw }
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl = buffer.indexOf('\n')
      while (nl >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        if (!line) {
          // 空行 = 一个事件结束
          if (dataLines.length) {
            const parsed = parse(dataLines.join('\n'))
            if (eventName === 'complete') {
              finished = true
              return Array.isArray(parsed) ? parsed : []
            }
            if (eventName === 'error') {
              const msg = typeof parsed === 'string'
                ? parsed
                : (parsed?.error || parsed?.message || JSON.stringify(parsed))
              throw new Error(`识别失败: ${msg}`)
            }
          }
          eventName = ''
          dataLines = []
        } else if (line.startsWith('event:')) {
          eventName = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trim())
        }
        nl = buffer.indexOf('\n')
      }
    }
    throw new Error('识别失败：服务端未返回结果')
  } finally {
    clearTimeout(timer)
    if (!finished) {
      try { controller.abort() } catch (e) { /* ignore */ }
    }
  }
}

// 一次完整识别：上传 → 提交 → 等结果，返回识别文本
export async function runQwen3Gradio(
  opts: Qwen3GradioOptions,
  audio: Blob,
  fileName = 'recording.wav'
): Promise<string> {
  const base = normalizeGradioBase(opts.base)
  if (!base) throw new Error('未配置 API 地址')
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 180000
  const cached = gradioPrefixCache.get(base)
  const prefixes = cached !== undefined ? [cached] : ['/gradio_api', '']
  let lastError: any = new Error('识别失败')
  for (const prefix of prefixes) {
    try {
      const serverPath = await gradioUpload(base, prefix, audio, fileName)
      const eventId = await gradioSubmit(base, prefix, opts, serverPath, fileName)
      const data = await gradioAwaitResult(base, prefix, eventId, timeoutMs)
      gradioPrefixCache.set(base, prefix)
      return String(data?.[1] ?? '').trim()
    } catch (e: any) {
      lastError = e
      const msg = String(e?.message || e)
      // 前缀不对（404）→ 试下一个；连不上 → 给出可读提示
      if (/\b404\b/.test(msg)) {
        gradioPrefixCache.delete(base)
        continue
      }
      if (e instanceof TypeError) {
        throw new Error(`无法连接 ${base}，请确认 Qwen3-ASR 服务已启动`)
      }
      throw e
    }
  }
  throw lastError
}
