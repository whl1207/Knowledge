// src/services/tts/qwen3.ts
// Qwen3-TTS（Qwen3-TTS-AllinOne）接入实现，两种接口任选（自动探测）：
//
// ① Gradio 网页服务（默认 7862）—— 手册里的两条 API，音色可选：
//    /update_voices  0 入参 → 返回「音色列表」Dropdown（"使用参考音频" + voices/*.pt 的名字）
//    /do_job         9 入参 → 返回 [生成结果 Audio, 音频文件下载 File]
//      data = [音色, 文本, 参考音频文本, 参考音频, 语速, 分段大小, 并行批次, 语言, 模型类型]
//    Gradio 的调用是两段式：POST /call/<api> 拿 event_id → GET /call/<api>/<event_id> 读 SSE。
//
// ② FastAPI 直连接口（默认 9880）—— 一次 POST 直接拿 wav：
//    POST / {"text": "...", "speaker": "珊瑚", "lang": "chinese", "speed": 1.0}
//    （本文件按 Qwen3-TTS-AllinOne 的 sft_get 实测契约实现；其它兼容实现只要参数同名即可）
//
// 语言取值必须落在服务端的词表里（auto/chinese/english/...）。旧版本传 'zh' 会被服务端
// 直接 500（ValueError: Unsupported languages: ['zh']），所以这里统一做映射，只发英文名。
//
// ③ GPUStack（局域网部署的 Qwen3-TTS）—— OpenAI 兼容接口：
//    POST /v1-openai/audio/speech  {"model":"qwen3-tts","input":"...","voice":"...","response_format":"wav","speed":1}
//    GET  /v1-openai/models         列出可用模型（GPUStack 的 /v1/models 是管理接口，不是这个）
//    GET  /v1-openai/audio/voices?model=…   音色列表（部分后端没有，失败时前端回退成手动填写）
//    新版 GPUStack 同时接受 /v1 作为别名，所以先试 /v1-openai，再回退 /v1。

export type Qwen3Protocol = 'auto' | 'gradio' | 'api'
export type Qwen3Deploy = 'local' | 'gpustack'
export type Qwen3Transport = 'gradio' | 'api' | 'gpustack'
export type Qwen3ModelType = '0.6B' | '1.7B'

/** 语言下拉（值 = 服务端词表里的英文名，大小写不敏感；Gradio 用首字母大写） */
export const QWEN3_LANGS: { value: string; zh: string; en: string }[] = [
  { value: 'Auto', zh: '自动识别', en: 'Auto' },
  { value: 'Chinese', zh: '中文', en: 'Chinese' },
  { value: 'English', zh: '英文', en: 'English' },
  { value: 'Japanese', zh: '日文', en: 'Japanese' },
  { value: 'Korean', zh: '韩文', en: 'Korean' },
  { value: 'German', zh: '德文', en: 'German' },
  { value: 'French', zh: '法文', en: 'French' },
  { value: 'Russian', zh: '俄文', en: 'Russian' },
  { value: 'Portuguese', zh: '葡萄牙文', en: 'Portuguese' },
  { value: 'Spanish', zh: '西班牙文', en: 'Spanish' },
  { value: 'Italian', zh: '意大利文', en: 'Italian' },
]

export const QWEN3_MODEL_TYPES: Qwen3ModelType[] = ['0.6B', '1.7B']

/** 「使用参考音频」选项：需要同时上传参考音频，本接入不提供上传，列表里过滤掉 */
export const QWEN3_REFERENCE_VOICE = '使用参考音频'

const LANG_ALIAS: Record<string, string> = {
  '': 'Auto', auto: 'Auto', 自动: 'Auto', 自动识别: 'Auto',
  zh: 'Chinese', 'zh-cn': 'Chinese', 'zh-tw': 'Chinese', 'zh-hans': 'Chinese', chinese: 'Chinese',
  中文: 'Chinese', 汉语: 'Chinese', 普通话: 'Chinese',
  en: 'English', 'en-us': 'English', 'en-gb': 'English', english: 'English', 英文: 'English', 英语: 'English',
  ja: 'Japanese', jp: 'Japanese', japanese: 'Japanese', 日文: 'Japanese', 日语: 'Japanese',
  ko: 'Korean', kr: 'Korean', korean: 'Korean', 韩文: 'Korean', 韩语: 'Korean',
  de: 'German', german: 'German', 德文: 'German', 德语: 'German',
  fr: 'French', french: 'French', 法文: 'French', 法语: 'French',
  ru: 'Russian', russian: 'Russian', 俄文: 'Russian', 俄语: 'Russian',
  pt: 'Portuguese', portuguese: 'Portuguese', 葡萄牙文: 'Portuguese', 葡萄牙语: 'Portuguese',
  es: 'Spanish', spanish: 'Spanish', 西班牙文: 'Spanish', 西班牙语: 'Spanish',
  it: 'Italian', italian: 'Italian', 意大利文: 'Italian', 意大利语: 'Italian',
}

/** 把用户/旧存档里的任意语言写法（zh / 中文 / Chinese …）收敛到服务端词表，未知按自动识别 */
export function normalizeQwen3Lang(raw?: string): string {
  const key = String(raw ?? '').trim().toLowerCase()
  return LANG_ALIAS[key] || 'Auto'
}

/** 直连接口用的语言值：服务端内部按小写比对（'Chinese' 也接受，但小写最稳） */
export function qwen3ApiLang(raw?: string): string {
  return normalizeQwen3Lang(raw).toLowerCase()
}

export interface Qwen3RequestConfig {
  /** 接入方式：local=本地/自建 Qwen3-TTS-AllinOne；gpustack=GPUStack 的 OpenAI 兼容接口 */
  deploy?: Qwen3Deploy
  /** 服务地址：本地是 Gradio(7862) / 直连接口(9880) 的根地址；GPUStack 是它的服务根地址 */
  base: string
  protocol?: Qwen3Protocol
  /** GPUStack 的 API Key（Bearer；没开鉴权就留空） */
  apiKey?: string
  /** GPUStack 里部署的模型名（如 qwen3-tts） */
  model?: string
  /** GPUStack 返回的音频格式：wav / mp3 / opus / aac / flac / pcm */
  responseFormat?: string
  /** 音色名（= 服务端 voices 目录里的文件名，如「珊瑚」） */
  voice?: string
  /** 语言：Auto / Chinese / …（大小写、zh 等别名都能识别） */
  lang?: string
  /** 模型参数：0.6B / 1.7B（仅 Gradio /do_job 支持） */
  modelType?: string
  speed?: number
  /** 分段大小 100~900（Gradio /do_job） */
  chunkSize?: number
  /** 并行批次（Gradio /do_job） */
  batch?: number
  /** 参考音频文本（配合「使用参考音频」时用） */
  promptText?: string
  /** 参考音频（Gradio FileData；本接入默认不传） */
  promptAudio?: any
  timeoutMs?: number
}

export interface Qwen3SynthesisResult {
  buffer: ArrayBuffer
  mime: string
  /** wav / mp3 / audio（按 Content-Type 推断） */
  format: string
  transport: Qwen3Transport
  /** 实际使用的服务地址（自动探测时可能与配置不同） */
  base: string
  voice: string
  lang: string
}

export interface Qwen3Resolved {
  transport: Qwen3Transport
  /** 实际使用的根地址 */
  base: string
  /** 探测到的 Gradio 地址（可用来拉音色列表；没探到为 ''） */
  gradioBase: string
  /** 是否命中缓存（调试用） */
  cached: boolean
}

export interface Qwen3VoiceListResult {
  voices: string[]
  /** 提供音色列表的 Gradio 地址 */
  base: string
}

// Gradio 5/6 把 API 挂在 /gradio_api 下，4.x 直接挂根路径；按地址缓存实际可用前缀
const PREFIX_CACHE = new Map<string, string>()
// 地址 → 解析结果（短时间内复用，避免每句话都探测一轮）
const RESOLVE_CACHE = new Map<string, { at: number; value: Qwen3Resolved }>()
const RESOLVE_TTL_MS = 10 * 60_000

/** 规范化地址：去尾斜杠；容忍粘贴完整接口地址（含 /gradio_api/call/xxx、/call/xxx 等） */
export function normalizeQwen3Base(url: string): string {
  let u = String(url || '').trim()
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`
  try {
    const parsed = new URL(u)
    let path = parsed.pathname || '/'
    const idx = path.indexOf('/gradio_api')
    if (idx >= 0) path = path.slice(0, idx)
    else path = path.replace(/\/(call|upload|config|queue|run|info)\b.*$/i, '')
    path = path.replace(/\/+$/, '')
    return parsed.origin + path
  } catch {
    return u.replace(/\/+$/, '')
  }
}

function isLoopback(host: string): boolean {
  const h = String(host || '').toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h === '0.0.0.0'
}

// 服务端自带的两个端口（Gradio 网页服务 7862 / FastAPI 直连接口 9880，7861 为旧版网页端口）
const QWEN3_DEFAULT_PORTS = ['7861', '7862', '9880']

/**
 * 候选地址：配置的地址优先；只有地址本来就是这套服务的默认端口时，才补上另一个端口
 * （两个接口分居 7862 / 9880 —— 填哪个都能用；但端口是自定义的就不猜，避免把别的服务顶掉）。
 */
export function qwen3Candidates(url: string): string[] {
  const base = normalizeQwen3Base(url)
  if (!base) return []
  const out = [base]
  try {
    const u = new URL(base)
    if (isLoopback(u.hostname) && QWEN3_DEFAULT_PORTS.includes(u.port)) {
      for (const port of ['7862', '9880']) {
        if (u.port !== port) {
          const alt = new URL(base)
          alt.port = port
          out.push(alt.origin)
        }
      }
    }
  } catch { /* 非标准 URL：只用原地址 */ }
  return out
}

class Qwen3HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs))
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`)
    if (e instanceof TypeError) throw new Error(`无法连接 ${url}，请确认 Qwen3-TTS 服务已启动`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// ============ Gradio 两段式调用 ============

async function gradioProbe(base: string, timeoutMs: number): Promise<boolean> {
  // Gradio 5/6 挂在 /gradio_api 下，4.x 直接在根路径：两种都试
  for (const path of ['/gradio_api/info', '/info']) {
    try {
      const res = await fetchWithTimeout(`${base}${path}`, {}, timeoutMs)
      if (!res.ok) continue
      const json: any = await res.json().catch(() => null)
      const endpoints = json?.named_endpoints || {}
      if (typeof endpoints === 'object' && !!endpoints['/do_job']) return true
    } catch { /* 试下一个前缀 */ }
  }
  return false
}

async function apiProbe(base: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${base}/openapi.json`, {}, timeoutMs)
    if (!res.ok) return false
    const json: any = await res.json().catch(() => null)
    const paths = json?.paths
    return !!(paths && typeof paths === 'object' && (paths['/'] || paths['/sft_get']))
  } catch {
    return false
  }
}

/** 带前缀回退地执行一次 Gradio 调用（/gradio_api → '' 兼容 Gradio 4.x） */
async function withGradioPrefix<T>(base: string, fn: (prefix: string) => Promise<T>): Promise<T> {
  const cached = PREFIX_CACHE.get(base)
  const attempt = async (prefixes: string[]): Promise<T> => {
    let lastError: any
    for (const prefix of prefixes) {
      try {
        const out = await fn(prefix)
        PREFIX_CACHE.set(base, prefix)
        return out
      } catch (e: any) {
        lastError = e
        if (e instanceof Qwen3HttpError && e.status === 404) continue
        throw e
      }
    }
    throw lastError
  }
  if (cached !== undefined) {
    try {
      return await attempt([cached])
    } catch (e: any) {
      // 服务端换了 Gradio 版本 → 丢掉缓存，两种前缀重试
      PREFIX_CACHE.delete(base)
      if (e instanceof Qwen3HttpError && e.status === 404) return attempt(['/gradio_api', ''])
      throw e
    }
  }
  return attempt(['/gradio_api', ''])
}

function parseSseData(raw: string): any {
  try { return JSON.parse(raw) } catch { return raw }
}

/** 读 SSE 结果流，返回 /call/<api> 的 complete 事件数据（数组） */
async function readGradioEvent(
  base: string,
  prefix: string,
  api: string,
  eventId: string,
  timeoutMs: number
): Promise<any[]> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs))
  let finished = false
  try {
    const res = await fetch(`${base}${prefix}/call/${api}/${eventId}`, { method: 'GET', signal: ctrl.signal })
    if (!res.ok || !res.body) throw new Qwen3HttpError(res.status, `获取结果失败: HTTP ${res.status}`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let eventName = ''
    let dataLines: string[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl = buffer.indexOf('\n')
      while (nl >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        if (!line) {
          if (dataLines.length) {
            const parsed = parseSseData(dataLines.join('\n'))
            if (eventName === 'complete') {
              finished = true
              return Array.isArray(parsed) ? parsed : [parsed]
            }
            if (eventName === 'error') {
              // Gradio 有时只发 `event: error` + `data: null`：这时给可读的常见原因
              const msg = typeof parsed === 'string'
                ? parsed
                : (parsed?.error || parsed?.message || (parsed == null ? '' : JSON.stringify(parsed)))
              throw new Error(msg
                ? `服务端报错: ${msg}`
                : '服务端报错（未返回原因）：常见于音色名不存在、参考音频缺失或显存不足')
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
    throw new Error('服务端未返回结果（SSE 中断）')
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error(`等待合成结果超时（${Math.round(timeoutMs / 1000)}s）`)
    if (e instanceof TypeError) throw new Error(`无法连接 ${base}，请确认 Qwen3-TTS 服务已启动`)
    throw e
  } finally {
    clearTimeout(timer)
    if (!finished) {
      try { ctrl.abort() } catch { /* 已结束 */ }
    }
  }
}

async function gradioCall(base: string, api: string, data: any[], timeoutMs: number): Promise<any[]> {
  return withGradioPrefix(base, async (prefix) => {
    const res = await fetchWithTimeout(`${base}${prefix}/call/${api}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    }, Math.min(timeoutMs, 60_000))
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Qwen3HttpError(res.status, `调用 ${api} 失败: HTTP ${res.status}${detail ? ` - ${detail.slice(0, 200)}` : ''}`)
    }
    const json: any = await res.json().catch(() => null)
    if (!json?.event_id) throw new Error(`调用 ${api} 失败：服务端未返回 event_id`)
    return readGradioEvent(base, prefix, api, String(json.event_id), timeoutMs)
  })
}

// ============ 音色列表 ============

/** 解析 /update_voices 的返回值：Dropdown.update → {choices:[[值,标签],…]}，也兼容纯数组/字符串 */
function parseVoiceChoices(raw: any): string[] {
  const pick = (v: any): string[] => {
    if (!v) return []
    if (Array.isArray(v)) {
      const out: string[] = []
      for (const item of v) {
        if (typeof item === 'string') out.push(item)
        else if (Array.isArray(item) && item.length) out.push(String(item[0]))
        else if (item && typeof item === 'object' && typeof item.value === 'string') out.push(item.value)
      }
      return out
    }
    if (typeof v === 'string') return v.split(/[\n,，、]+/).map(s => s.trim()).filter(Boolean)
    return []
  }
  if (Array.isArray(raw)) {
    // [ {choices:[...]} ] 或 ['a','b'] 两种形态
    if (raw.length && (raw[0] && typeof raw[0] === 'object' && Array.isArray((raw[0] as any).choices))) {
      return pick((raw[0] as any).choices)
    }
    if (raw.length && typeof raw[0] === 'string' && raw.length > 1 && /[,，、\n]/.test(String(raw[0]))) {
      return pick(String(raw[0]))
    }
    return pick(raw)
  }
  if (raw && typeof raw === 'object' && Array.isArray((raw as any).choices)) return pick((raw as any).choices)
  return pick(raw)
}

/** 拉取音色列表（总是走 Gradio /update_voices；直连接口没有列表接口） */
export async function qwen3ListVoices(cfg: Pick<Qwen3RequestConfig, 'base' | 'protocol' | 'timeoutMs'>): Promise<Qwen3VoiceListResult> {
  const timeoutMs = cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : 20_000
  const candidates = qwen3Candidates(cfg.base)
  if (!candidates.length) throw new Error('未配置服务地址（形如 http://127.0.0.1:7862）')
  // 网页服务端口优先探测（直连接口可能正忙于合成，探测会挂住）
  const probeOrder = candidates.slice().sort((a, b) => qwen3PortRank(a) - qwen3PortRank(b))
  let lastError: any = null
  for (const base of probeOrder) {
    try {
      const data = await gradioCall(base, 'update_voices', [], timeoutMs)
      const voices = parseVoiceChoices(data)
      if (!voices.length) throw new Error('服务端返回的音色列表为空')
      return { voices, base }
    } catch (e: any) {
      lastError = e
    }
  }
  const hint = lastError?.message ? `（${lastError.message}）` : ''
  throw new Error(`无法获取音色列表：请确认 Qwen3-TTS 网页服务（默认 ${candidates[0]}，Gradio 端口 7862）已启动${hint}`)
}

// ============ 接口探测 ============

/**
 * 解析实际使用的接口。
 * auto：能找到 Gradio（/do_job）就用它 —— 网页服务的队列最稳，长时间合成也不会把探测卡住；
 *       找不到 Gradio 才用直连接口（一次 POST）。两者都没有就抛错。
 */
export async function resolveQwen3Transport(cfg: Pick<Qwen3RequestConfig, 'base' | 'protocol' | 'timeoutMs' | 'deploy'>): Promise<Qwen3Resolved> {
  // GPUStack：固定走 OpenAI 兼容接口，不做 Gradio 探测
  if (cfg.deploy === 'gpustack') {
    const base = normalizeGpuStackBase(cfg.base)
    if (!base) throw new Error('未配置 GPUStack 服务地址（形如 http://192.168.1.10:8080）')
    return { transport: 'gpustack', base, gradioBase: '', cached: false }
  }
  const base = normalizeQwen3Base(cfg.base)
  if (!base) throw new Error('未配置服务地址（形如 http://127.0.0.1:7862）')
  const key = `${cfg.protocol || 'auto'}|${base}`
  const hit = RESOLVE_CACHE.get(key)
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return { ...hit.value, cached: true }

  const candidates = qwen3Candidates(base)
  const probeTimeout = Math.min(cfg.timeoutMs || 2500, 2500)

  // 探测顺序按端口约定排：7862/7861（网页服务）/ 9880（直连接口）——
  // 直连接口一旦被长时间合成占住，探测会一直挂，放在最后才不至于让解析等好几秒。
  const probeOrder = candidates.slice().sort((a, b) => qwen3PortRank(a) - qwen3PortRank(b))
  let gradioBase = ''
  for (const c of probeOrder) {
    if (await gradioProbe(c, probeTimeout)) { gradioBase = c; break }
  }
  // 只有万不得已（没有 Gradio）才去碰直连接口
  const apiBase = !gradioBase && (await apiProbe(base, probeTimeout)) ? base : ''

  let value: Qwen3Resolved
  const protocol: Qwen3Protocol = cfg.protocol === 'gradio' || cfg.protocol === 'api' ? cfg.protocol : 'auto'
  if (protocol === 'gradio') {
    if (!gradioBase) {
      throw new Error(`Gradio 接口不可用：${candidates.join(' / ')} 上没找到 /gradio_api/call/do_job（请确认网页服务已启动，端口默认 7862）`)
    }
    value = { transport: 'gradio', base: gradioBase, gradioBase, cached: false }
  } else if (protocol === 'api') {
    value = { transport: 'api', base, gradioBase, cached: false }
  } else if (gradioBase) {
    // 网页服务（按手册 /do_job）：音色、分段、并行批次都能用，也更稳
    value = { transport: 'gradio', base: gradioBase, gradioBase, cached: false }
  } else if (apiBase) {
    // 只有直连接口：一次 POST 直接拿 wav
    value = { transport: 'api', base, gradioBase, cached: false }
  } else {
    throw new Error(`无法连接 Qwen3-TTS：${candidates.join(' / ')} 上没有可用的 Gradio 或直连接口`)
  }

  RESOLVE_CACHE.set(key, { at: Date.now(), value })
  return value
}

/** 探测排序：网页服务端口优先（7862 → 7861 → 9880 → 其它） */
function qwen3PortRank(url: string): number {
  try {
    const port = new URL(url).port
    if (port === '7862') return 0
    if (port === '7861') return 1
    if (port === '9880') return 2
    return 3
  } catch {
    return 3
  }
}

/** 清掉探测缓存（改了地址/端口或服务重启后调用） */
export function resetQwen3Cache(): void {
  PREFIX_CACHE.clear()
  RESOLVE_CACHE.clear()
}

// ============ GPUStack（局域网部署的 Qwen3-TTS，OpenAI 兼容接口） ============

const GS_API_SUFFIX = /\/(v1-openai|v1)\/(audio\/(speech|voices)|models)\/?$/i

/** 规范化 GPUStack 地址：容忍粘贴完整接口地址（含 /v1-openai/audio/speech、/v1、尾斜杠） */
export function normalizeGpuStackBase(url: string): string {
  let u = String(url || '').trim()
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`
  try {
    const parsed = new URL(u)
    let path = (parsed.pathname || '/').replace(/\/+$/, '')
    path = path.replace(GS_API_SUFFIX, '')
    path = path.replace(/\/audio\/(speech|voices)$/i, '')
    path = path.replace(/\/(v1-openai|v1)$/i, '')
    return parsed.origin + path
  } catch {
    return u.replace(/\/+$/, '')
  }
}

/** GPUStack 的 OpenAI 兼容根：/v1-openai 为主路径，/v1 是它的别名（也兼容其它 OpenAI 实现） */
export function gpuStackApiRoots(url: string): string[] {
  const base = normalizeGpuStackBase(url)
  if (!base) return []
  return [`${base}/v1-openai`, `${base}/v1`]
}

function gpuStackHeaders(apiKey?: string, json = false): Record<string, string> {
  const headers: Record<string, string> = {}
  if (json) headers['Content-Type'] = 'application/json'
  const key = String(apiKey || '').trim()
  if (key) headers['Authorization'] = `Bearer ${key}`
  return headers
}

export interface GpuStackListResult {
  items: string[]
  /** 实际可用的根地址（形如 http://host:port/v1-openai） */
  root: string
}

/** 兼容 OpenAI（data[].id）、GPUStack 管理接口（items[].name）与纯字符串数组 */
function parseModelIds(json: any): string[] {
  const list = Array.isArray(json?.data) ? json.data
    : Array.isArray(json?.models) ? json.models
      : Array.isArray(json?.items) ? json.items
        : Array.isArray(json) ? json
          : []
  const out: string[] = []
  for (const item of list) {
    const id = typeof item === 'string' ? item : (item?.id || item?.name || item?.model_name || '')
    if (id) out.push(String(id))
  }
  return Array.from(new Set(out))
}

/** 兼容 voices / data / 纯数组，元素可为字符串或 {voice|voice_id|id|name} */
function parseVoiceIds(json: any): string[] {
  const list = Array.isArray(json?.voices) ? json.voices
    : Array.isArray(json?.data) ? json.data
      : Array.isArray(json) ? json
        : []
  const out: string[] = []
  for (const item of list) {
    if (typeof item === 'string') out.push(item)
    else if (item && typeof item === 'object') {
      const v = item.voice || item.voice_id || item.id || item.name
      if (v) out.push(String(v))
    }
  }
  return Array.from(new Set(out))
}

function errorDetailOf(raw: string): string {
  const text = (raw || '').trim()
  if (!text) return ''
  try {
    const json: any = JSON.parse(text)
    return String(json?.error?.message || json?.error || json?.detail || json?.message || text).slice(0, 200)
  } catch {
    // 可能是一整页 HTML（贴错地址），只留开头
    return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
  }
}

/** 列出 GPUStack 上的模型（用于下拉选择 TTS 模型） */
export async function gpustackListModels(cfg: { base: string; apiKey?: string; timeoutMs?: number }): Promise<GpuStackListResult> {
  const timeoutMs = cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : 15_000
  const roots = gpuStackApiRoots(cfg.base)
  if (!roots.length) throw new Error('未配置 GPUStack 服务地址（形如 http://192.168.1.10:8080）')
  const tried: string[] = []
  let lastError: any = null
  for (const root of roots) {
    try {
      const res = await fetchWithTimeout(`${root}/models`, { headers: gpuStackHeaders(cfg.apiKey) }, timeoutMs)
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        const hint = res.status === 401 || res.status === 403
          ? '（API 密钥无效或无权限，请核对 GPUStack 的 API Key）'
          : ''
        lastError = new Error(`HTTP ${res.status}${hint}${detail ? ` - ${errorDetailOf(detail)}` : ''}`)
        tried.push(`${root} → ${lastError.message}`)
        continue
      }
      const json: any = await res.json().catch(() => null)
      const items = parseModelIds(json)
      if (!items.length) throw new Error('服务返回的模型列表为空（请先在 GPUStack 里部署 TTS 模型）')
      return { items, root }
    } catch (e: any) {
      lastError = e
      tried.push(`${root} → ${e?.message || String(e)}`)
    }
  }
  throw new Error(`无法获取 GPUStack 模型列表：${lastError?.message || '未知错误'}（试过 ${tried.join(' / ')}）`)
}

/** 列出某个 TTS 模型的音色（部分后端不提供该接口，调用方应允许手动填写） */
export async function gpustackListVoices(cfg: { base: string; apiKey?: string; model?: string; timeoutMs?: number }): Promise<GpuStackListResult> {
  const timeoutMs = cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : 15_000
  const roots = gpuStackApiRoots(cfg.base)
  if (!roots.length) throw new Error('未配置 GPUStack 服务地址（形如 http://192.168.1.10:8080）')
  const model = String(cfg.model || '').trim()
  const qs = model ? `?model=${encodeURIComponent(model)}` : ''
  const tried: string[] = []
  let lastError: any = null
  for (const root of roots) {
    try {
      const res = await fetchWithTimeout(`${root}/audio/voices${qs}`, { headers: gpuStackHeaders(cfg.apiKey) }, timeoutMs)
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`)
        tried.push(`${root} → HTTP ${res.status}`)
        continue
      }
      const json: any = await res.json().catch(() => null)
      const items = parseVoiceIds(json)
      if (!items.length) throw new Error('服务返回的音色列表为空')
      return { items, root }
    } catch (e: any) {
      lastError = e
      tried.push(`${root} → ${e?.message || String(e)}`)
    }
  }
  throw new Error(`该服务没有可用的音色列表接口（可直接手动填写音色名）：${lastError?.message || ''}${tried.length ? `（试过 ${tried.join(' / ')}）` : ''}`)
}

// ============ 合成 ============

function mimeToFormat(mime: string): string {
  const m = (mime || '').toLowerCase()
  if (m.includes('wav')) return 'wav'
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'
  if (m.includes('ogg')) return 'ogg'
  if (m.includes('flac')) return 'flac'
  return 'audio'
}

function clampNumber(v: any, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

async function synthesizeViaGradio(cfg: Qwen3RequestConfig, base: string, text: string, lang: string): Promise<Qwen3SynthesisResult> {
  const timeoutMs = cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : 180_000
  const voice = String(cfg.voice || '').trim()
  const promptAudio = cfg.promptAudio ?? null
  if (!voice || (voice === QWEN3_REFERENCE_VOICE && !promptAudio)) {
    throw new Error('请先选择音色（在 Qwen3-TTS 网页服务的「音色列表」里添加音色后会出现在这里）')
  }
  const speed = clampNumber(cfg.speed, 0.1, 2.5, 1.0)
  const chunkSize = clampNumber(cfg.chunkSize, 100, 900, 200)
  const batch = clampNumber(cfg.batch, 1, 64, 8)
  const modelType = cfg.modelType === '1.7B' ? '1.7B' : '0.6B'
  const data = [
    voice,
    text,
    String(cfg.promptText || ''),
    promptAudio,
    speed,
    chunkSize,
    batch,
    lang,
    modelType,
  ]
  const out = await gradioCall(base, 'do_job', data, timeoutMs)
  const file = (out || []).find(v => v && typeof v === 'object' && (v as any).url) as any
  if (!file?.url) throw new Error('服务端没有返回音频文件')
  // 服务端给的是本机绝对地址；路径里可能带 Windows 反斜杠，浏览器会按 / 处理
  const url = String(file.url)
  const res = await fetchWithTimeout(url, { headers: { Accept: 'audio/*' } }, 60_000)
  if (!res.ok) throw new Error(`下载合成音频失败: HTTP ${res.status}`)
  const mime = res.headers.get('content-type') || file.mime_type || 'audio/wav'
  const buffer = await res.arrayBuffer()
  if (!buffer.byteLength) throw new Error('服务端返回空音频')
  return { buffer, mime, format: mimeToFormat(mime), transport: 'gradio', base, voice, lang }
}

async function synthesizeViaApi(cfg: Qwen3RequestConfig, base: string, text: string, lang: string): Promise<Qwen3SynthesisResult> {
  const timeoutMs = cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : 180_000
  const voice = String(cfg.voice || '').trim()
  if (!voice || voice === QWEN3_REFERENCE_VOICE) {
    throw new Error('请先选择音色（直连接口需要已保存的音色名，如「珊瑚」）')
  }
  const body = {
    text,
    speaker: voice,
    lang: qwen3ApiLang(lang),
    speed: clampNumber(cfg.speed, 0.1, 2.5, 1.0),
    model_type: cfg.modelType === '1.7B' ? '1.7B' : '0.6B',
  }
  const res = await fetchWithTimeout(`${base}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'audio/*' },
    body: JSON.stringify(body),
  }, timeoutMs)
  const mime = res.headers.get('content-type') || ''
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    // 405 / HTML 基本都是打到了 Gradio 网页服务根路径上（它只认 /gradio_api/call/…）
    if (res.status === 405 || mime.includes('text/html')) {
      throw new Error(`${base} 不接受这种调用（HTTP ${res.status}）：它像是 Gradio 网页服务，请把「接口协议」改成 Gradio 或自动识别`)
    }
    // 5xx 常见于音色名不存在 / 参考音频缺失 / 显存不足，给个人能看懂的方向
    const hint = res.status >= 500 ? '（常见原因：音色名在服务端不存在、参考音频缺失或显存不足）' : ''
    throw new Error(`合成失败: HTTP ${res.status}${detail ? ` - ${detail.slice(0, 200)}` : ''}${hint}`)
  }
  if (mime.includes('application/json')) {
    const json: any = await res.json().catch(() => null)
    const msg = json?.error || json?.detail || JSON.stringify(json || {})
    throw new Error(`服务端报错: ${msg}`)
  }
  if (mime.includes('text/html')) {
    throw new Error(`该地址返回的是网页而不是音频：${base} 可能是 Gradio 网页服务，请把「接口协议」改成 Gradio（或自动识别）`)
  }
  const buffer = await res.arrayBuffer()
  if (!buffer.byteLength) throw new Error('服务端返回空音频')
  return { buffer, mime: mime || 'audio/wav', format: mimeToFormat(mime || 'audio/wav'), transport: 'api', base, voice, lang }
}

const GS_FORMATS = ['wav', 'mp3', 'opus', 'aac', 'flac', 'pcm']

function normalizeResponseFormat(v: any): string {
  const f = String(v || '').trim().toLowerCase()
  return GS_FORMATS.includes(f) ? f : 'wav'
}

function formatToMime(fmt: string): string {
  switch (fmt) {
    case 'mp3': return 'audio/mpeg'
    case 'opus': return 'audio/ogg'
    case 'aac': return 'audio/aac'
    case 'flac': return 'audio/flac'
    case 'pcm': return 'audio/L16'
    default: return 'audio/wav'
  }
}

/**
 * GPUStack 合成：一次 POST /audio/speech 直接拿音频。
 * /v1-openai 优先，404/405 时回退 /v1（GPUStack 的别名，也兼容其它 OpenAI 实现）。
 */
async function synthesizeViaGpuStack(cfg: Qwen3RequestConfig, text: string): Promise<Qwen3SynthesisResult> {
  const timeoutMs = cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : 180_000
  const base = normalizeGpuStackBase(cfg.base)
  const roots = gpuStackApiRoots(cfg.base)
  if (!base || !roots.length) throw new Error('未配置 GPUStack 服务地址（形如 http://192.168.1.10:8080）')
  const model = String(cfg.model || '').trim()
  if (!model) {
    throw new Error('请先填写 GPUStack 里部署的 TTS 模型名称（如 qwen3-tts；可点「刷新模型」从服务端列表选择）')
  }
  const voice = String(cfg.voice || '').trim()
  const fmt = normalizeResponseFormat(cfg.responseFormat)
  const body: Record<string, any> = {
    model,
    input: text,
    response_format: fmt,
    speed: clampNumber(cfg.speed, 0.25, 4, 1.0),
  }
  // 有些 TTS 模型没有音色概念：不填就不发 voice 字段，让服务端用默认音色
  if (voice) body.voice = voice
  // 语言是 vLLM-Omni / Qwen3-TTS 的扩展参数：只有显式选定才发（Auto = 让服务端自动识别）
  const lang = normalizeQwen3Lang(cfg.lang)
  if (lang && lang !== 'Auto') body.language = lang

  const tried: string[] = []
  for (const root of roots) {
    const res = await fetchWithTimeout(`${root}/audio/speech`, {
      method: 'POST',
      headers: { ...gpuStackHeaders(cfg.apiKey, true), Accept: 'audio/*' },
      body: JSON.stringify(body),
    }, timeoutMs)
    if (res.status === 404 || res.status === 405) {
      const detail = await res.text().catch(() => '')
      tried.push(`${root} → HTTP ${res.status}${detail ? `（${errorDetailOf(detail)}）` : ''}`)
      continue
    }
    const mime = (res.headers.get('content-type') || '').toLowerCase()
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      if (res.status === 401 || res.status === 403) {
        throw new Error(`GPUStack 拒绝访问（HTTP ${res.status}）：请检查 API 密钥${detail ? `（${errorDetailOf(detail)}）` : ''}`)
      }
      // 4xx 常见于模型名不存在 / 音色名不被该模型接受；5xx 多是显存或后端异常
      const hint = res.status >= 500
        ? '（常见原因：模型还在加载、显存不足或后端异常）'
        : '（请核对模型名称，以及该模型是否接受这个音色）'
      throw new Error(`GPUStack 合成失败: HTTP ${res.status}${detail ? ` - ${errorDetailOf(detail)}` : ''}${hint}`)
    }
    if (mime.includes('application/json')) {
      const json: any = await res.json().catch(() => null)
      const msg = json?.error?.message || json?.error || json?.detail || JSON.stringify(json || {})
      throw new Error(`GPUStack 返回错误: ${msg}`)
    }
    const buffer = await res.arrayBuffer()
    if (!buffer.byteLength) throw new Error('GPUStack 返回空音频')
    const mimeFmt = mimeToFormat(mime)
    const format = mimeFmt === 'audio' ? fmt : mimeFmt
    const resolvedMime = mime && !mime.includes('octet-stream') ? mime : formatToMime(fmt)
    return { buffer, mime: resolvedMime, format, transport: 'gpustack', base: root, voice, lang: '' }
  }
  throw new Error(`在 GPUStack 上找不到可用的语音接口（试过 ${tried.join(' / ')}）。请确认地址是 GPUStack 服务地址，且模型已部署为 TTS`)
}

// 合成串行链：播放队列会边播边预取下一句，而服务端是单卡串行 —— 并发提交只会顶爆显存
// （实测并发时服务端进程可能直接退出）。这里只做「排队」，某一句失败不影响后续句子。
let synthChain: Promise<void> = Promise.resolve()

/**
 * 合成一段语音（整段一次请求）。
 * 自动模式下：配置地址是 Gradio 就走 /do_job（按手册、支持音色/分段/并行/模型），
 * 是直连接口就走一次 POST；GPUStack 走 OpenAI 兼容 /audio/speech；都不通时抛错。
 */
export function qwen3Synthesize(cfg: Qwen3RequestConfig, text: string): Promise<Qwen3SynthesisResult> {
  const run = () => runQwen3Synthesize(cfg, text)
  const task = synthChain.then(run, run)
  synthChain = task.then(() => undefined, () => undefined)
  return task
}

async function runQwen3Synthesize(cfg: Qwen3RequestConfig, text: string): Promise<Qwen3SynthesisResult> {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim()
  if (!cleaned) throw new Error('合成文本为空')
  const lang = normalizeQwen3Lang(cfg.lang)
  const resolved = await resolveQwen3Transport(cfg)
  if (resolved.transport === 'gpustack') {
    return synthesizeViaGpuStack(cfg, cleaned)
  }
  if (resolved.transport === 'gradio') {
    return synthesizeViaGradio(cfg, resolved.base, cleaned, lang)
  }
  return synthesizeViaApi(cfg, resolved.base, cleaned, lang)
}
