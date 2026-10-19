// src/services/image/qwenImage.ts
// Qwen-Image-Edit-2511（本地 Gradio 应用，默认 http://127.0.0.1:7861）的调用封装。
//
// 为什么不用 /gradio_api/call/<api>：这套应用（Gradio 5.47 / sse_v3）的「加入任务 / 刷新处理」
// 两个接口依赖 **会话级 State**（任务列表、生成结果都在 State 里），旧的 /call 两段式会拿到
// `event: error / data: null`；而 Gradio 自己的客户端走的是「队列协议」，实测可用：
//   ① 建会话：GET  /gradio_api/queue/data?session_hash=<uuid>   （长连接 SSE，收本会话所有事件）
//   ② 投任务：POST /gradio_api/queue/join  {data, fn_index, session_hash} → {event_id}
//   ③ 在 SSE 里等 event_id 的 process_completed → output.data 就是该接口的返回值列表
// 关键：add 任务与 refresh 处理**必须同一个 session_hash**，否则 refresh 看不到任务（会一直「队列为空」）。
//
// 业务流（应用自带的 task 队列）：
//   add_task_to_queue（25 个入参）→「任务 xxx 已添加」+ 排队数 1
//   refresh_ui_and_process_queue（0 个可见入参）→ 第一下开始处理，之后每次报告进度；
//   结束时 outputs[6]「最新生成结果」给 FileData，outputs[1]「生成结果画廊」给累计图片列表。

export interface QwenImageDefaults {
  base: string
  version: string
  /** add_task_to_queue 的 25 个入参（顺序 = 服务端 /info 的 parameters 顺序） */
  params: Array<{
    name: string
    label: string
    component: string
    /** 服务端默认值（token 默认值就是它 work/token.json 里保存的那个） */
    default?: any
    enum?: string[]
  }>
  /** api_name → fn_index */
  fnIndex: Record<string, number>
  /**
   * api_name → 该依赖的输入组件总数（含「隐藏输入」）。
   * 本应用把两个隐藏输入放在了参数最前面，客户端必须补 null 占位，
   * 否则服务端函数会因缺少位置参数直接抛异常（表现为 success=false / title=Error）。
   */
  inputCounts: Record<string, number>
}

export interface QwenImageConfig {
  base: string
  /** 模型类型：'Qwen(本地免费)' 或 'Banana2(收费)' */
  modelType?: string
  width?: number
  height?: number
  steps?: number
  negative?: string
  lora1?: string
  lora2?: string
  lora3?: string
  lora4?: string
  /** api token；留空则用服务端保存的默认值 */
  token?: string
  /** 视角（默认「无」：不覆盖提示词） */
  horizontal?: string
  vertical?: string
  distance?: string
  /** 是否强制回收显存：'开启' | '关闭' */
  refineText?: string
  timeoutMs?: number
}

export interface QwenImageGenOptions {
  prompt: string
  /** 参考图（0 张 = 文生图；最多 3 张） */
  images?: Blob[]
  fileNames?: string[]
  usePose?: boolean
  useInpaint?: boolean
  onLog?: (text: string) => void
  onQueue?: (count: number) => void
  /** 单次等待上限（含模型冷启动；默认 5 分钟） */
  maxWaitMs?: number
  /** 轮询间隔（默认 2.5s） */
  pollMs?: number
  signal?: AbortSignal
}

export interface QwenImageResult {
  /** 生成出来的图片（可直接显示的 URL + 服务端路径） */
  images: Array<{ url: string; path?: string }>
  /** 服务端最后一次返回的原始 outputs（调试用） */
  lastOutputs: any[]
  /** 处理日志（应用「当前任务实时日志」累积） */
  log: string
  sessionHash: string
}

const INFO_CACHE = new Map<string, { at: number; value: QwenImageDefaults }>()
const INFO_TTL_MS = 5 * 60_000

/** 规范化服务地址：去尾斜杠；容忍粘贴完整页面地址 / 带 /gradio_api 的地址 */
export function normalizeImageBase(url: string): string {
  let u = String(url || '').trim()
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`
  try {
    const parsed = new URL(u)
    let path = parsed.pathname || '/'
    const idx = path.indexOf('/gradio_api')
    if (idx >= 0) path = path.slice(0, idx)
    path = path.replace(/\/+$/, '')
    return parsed.origin + path
  } catch {
    return u.replace(/\/+$/, '')
  }
}

async function httpJson(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<any> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs))
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`)
    if (e instanceof TypeError) throw new Error(`无法连接 ${url}，请确认生图服务已启动`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** 读取服务信息：版本、add_task_to_queue 的入参（含默认值 / 枚举）、api_name→fn_index */
export async function qwenImageInfo(baseRaw: string, force = false): Promise<QwenImageDefaults> {
  const base = normalizeImageBase(baseRaw)
  if (!base) throw new Error('未配置生图服务地址（形如 http://127.0.0.1:7861）')
  const hit = INFO_CACHE.get(base)
  if (!force && hit && Date.now() - hit.at < INFO_TTL_MS) return hit.value

  const [info, config] = await Promise.all([
    httpJson(`${base}/gradio_api/info`),
    httpJson(`${base}/config`),
  ])
  const fnIndex: Record<string, number> = {}
  const inputCounts: Record<string, number> = {}
  for (const d of (config?.dependencies || [])) {
    if (!d?.api_name) continue
    // /config 里的 api_name 有的带前导斜杠、有的不带：统一成 /xxx
    const name = String(d.api_name)
    const key = name.startsWith('/') ? name : `/${name}`
    fnIndex[key] = Number(d.id)
    inputCounts[key] = Array.isArray(d.inputs) ? d.inputs.length : 0
  }
  const endpoint = info?.named_endpoints?.['/add_task_to_queue']
  const params = (endpoint?.parameters || []).map((p: any) => ({
    name: p.parameter_name || '',
    label: p.label || p.parameter_name || '',
    component: p.component || '',
    default: p.parameter_default,
    enum: Array.isArray(p.type?.enum) ? p.type.enum : undefined,
  }))
  if (!params.length) throw new Error('服务端没有 /add_task_to_queue 接口（不是 Qwen-Image-Edit 应用？）')

  const value: QwenImageDefaults = {
    base,
    version: String(config?.version || info?.version || ''),
    params,
    fnIndex,
    inputCounts,
  }
  INFO_CACHE.set(base, { at: Date.now(), value })
  return value
}

/** 取某个入参在服务端的默认值（找不到时用 fallback） */
export function paramDefault(info: QwenImageDefaults, name: string, fallback: any = null): any {
  const p = info.params.find(x => x.name === name)
  return p?.default !== undefined ? p.default : fallback
}

/** 取某个入参的枚举（没有时返回空数组） */
export function paramEnum(info: QwenImageDefaults, name: string): string[] {
  return info.params.find(x => x.name === name)?.enum || []
}

// ---------------- 队列协议 ----------------

interface QueueEvent {
  msg: string
  event_id?: string
  output?: { data?: any[]; error?: string | null; is_generating?: boolean }
  success?: boolean
  title?: string
}

class GradioQueueSession {
  readonly sessionHash: string
  private base: string
  private ctrl: AbortController | null = null
  private streamPromise: Promise<void> | null = null
  private waiters = new Map<string, { resolve: (v: QueueEvent) => void; reject: (e: Error) => void }>()
  /** 流可能比等待者先拿到结果（join 到开流之间完成），先存着 */
  private buffered = new Map<string, QueueEvent>()
  private disposed = false

  constructor(base: string) {
    this.base = base
    this.sessionHash = `aikm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }

  /**
   * 打开事件流（每次 join 后按需重建）。
   * 注意：队列跑空时服务端会主动发 close_stream 并断流，所以不能「一次开流用到底」，
   * 必须在每次 call 前确认流还开着（gradio_client 也是这么做的）。
   */
  private ensureStream(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('会话已关闭'))
    if (this.streamPromise) return this.streamPromise
    const ctrl = new AbortController()
    this.ctrl = ctrl
    const url = `${this.base}/gradio_api/queue/data?session_hash=${encodeURIComponent(this.sessionHash)}`
    this.streamPromise = (async () => {
      try {
        const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'text/event-stream' } })
        if (!res.ok || !res.body) throw new Error(`订阅事件流失败: HTTP ${res.status}`)
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) return
          buffer += decoder.decode(value, { stream: true })
          let sep = buffer.indexOf('\n\n')
          while (sep >= 0) {
            const chunk = buffer.slice(0, sep)
            buffer = buffer.slice(sep + 2)
            for (const line of chunk.split('\n')) {
              if (!line.startsWith('data:')) continue
              let msg: QueueEvent
              try { msg = JSON.parse(line.slice(5).trim()) } catch { continue }
              if (!msg?.msg || msg.msg === 'heartbeat') continue
              if (msg.msg === 'close_stream') return
              const id = msg.event_id
              if (!id) continue
              if (msg.msg === 'process_completed' || msg.msg === 'process_generating') {
                const w = this.waiters.get(id)
                if (w) {
                  this.waiters.delete(id)
                  w.resolve(msg)
                } else if (msg.msg === 'process_completed') {
                  this.buffered.set(id, msg)
                  if (this.buffered.size > 50) {
                    const oldest = this.buffered.keys().next().value
                    if (oldest) this.buffered.delete(oldest)
                  }
                }
              }
            }
            sep = buffer.indexOf('\n\n')
          }
        }
      } finally {
        // 流结束（close_stream / 网络中断）→ 下次 call 重新开一条
        this.streamPromise = null
        this.ctrl = null
      }
    })().catch((e) => {
      for (const [, w] of this.waiters) w.reject(e instanceof Error ? e : new Error(String(e)))
      this.waiters.clear()
    })
    return this.streamPromise
  }

  /** 投一个任务并等它完成（generating 事件忽略，只等 process_completed） */
  async call(fnIndex: number, data: any[], timeoutMs: number): Promise<QueueEvent> {
    // 顺序很重要：先 queue/join 建会话任务，再开 queue/data 长连接。
    // 反过来（先开流）服务端会回 unexpected_error / "404: Not Found" / session_not_found。
    const res = await httpJson(`${this.base}/gradio_api/queue/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, fn_index: fnIndex, session_hash: this.sessionHash }),
    }, 30_000)
    const eventId = res?.event_id
    if (!eventId) throw new Error('投递任务失败：服务端未返回 event_id')

    const early = this.buffered.get(eventId)
    if (early) {
      this.buffered.delete(eventId)
      return early
    }

    const waitForIt = new Promise<QueueEvent>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        this.waiters.delete(eventId)
        if (!settled) {
          settled = true
          reject(new Error(`等待任务结果超时（${Math.round(timeoutMs / 1000)}s）`))
        }
      }, timeoutMs)
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }
      this.waiters.set(eventId, {
        resolve: (ev) => finish(() => resolve(ev)),
        reject: (e) => finish(() => reject(e)),
      })
      const raced = this.buffered.get(eventId)
      if (raced) {
        this.buffered.delete(eventId)
        this.waiters.delete(eventId)
        finish(() => resolve(raced))
      }
    })

    // 流可能已经因 close_stream 断开 → 重新开一条；开流失败则让这次调用失败
    try {
      await this.ensureStream()
    } catch (e) {
      this.waiters.get(eventId)?.reject(e instanceof Error ? e : new Error(String(e)))
    }
    return waitForIt
  }

  close(): void {
    this.disposed = true
    try { this.ctrl?.abort() } catch { /* ignore */ }
    for (const [, w] of this.waiters) w.reject(new Error('会话已关闭'))
    this.waiters.clear()
  }
}

/** 隐藏输出会被塞在结果数组最前面（本应用 add 有 1 个）：按 /info 的返回个数取尾部 */
function tailOutputs(raw: any[], count: number): any[] {
  if (!Array.isArray(raw)) return []
  return count > 0 ? raw.slice(-count) : raw
}

function assertSuccess(ev: QueueEvent, what: string): any[] {
  if (!ev.success) {
    const msg = ev.output?.error || ev.output?.data?.[0] || ev.title || ''
    throw new Error(`${what}失败${msg ? `：${typeof msg === 'string' ? msg : JSON.stringify(msg)}` : '：服务端未开启错误详情（应用内部抛了异常）'}`)
  }
  return Array.isArray(ev.output?.data) ? ev.output!.data! : []
}

/** 上传参考图，返回服务端文件路径（FileData.path 用） */
async function uploadFiles(base: string, files: Blob[], names: string[]): Promise<string[]> {
  const form = new FormData()
  files.forEach((f, i) => form.append('files', f, names[i] || `image-${i}.png`))
  const res = await fetch(`${base}/gradio_api/upload`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`上传参考图失败: HTTP ${res.status}`)
  const json: any = await res.json()
  const list = Array.isArray(json) ? json : (json?.files || [])
  return list.map((x: any) => (typeof x === 'string' ? x : x?.path)).filter(Boolean)
}

function toFileData(path: string) {
  return { path, meta: { _type: 'gradio.FileData' }, orig_name: path.split(/[\\/]/).pop() || 'image.png' }
}

/** 从 FileData / 字符串里取出可显示的 URL（统一成 /gradio_api/file=<路径>，斜杠用 /） */
function fileToImage(v: any, base: string): { url: string; path?: string } | null {
  const asFileUrl = (p: string) => `${base}/gradio_api/file=${p.replace(/\\/g, '/')}`
  if (!v) return null
  if (typeof v === 'string') {
    if (/^https?:\/\//i.test(v)) return { url: v }
    if (/\.(png|jpe?g|webp|gif)$/i.test(v)) return { url: asFileUrl(v), path: v }
    return null
  }
  if (typeof v === 'object') {
    if (typeof v.url === 'string' && v.url) return { url: v.url.replace(/\\/g, '/'), path: v.path }
    if (typeof v.image === 'object') return fileToImage(v.image, base)
    if (typeof v.path === 'string' && /\.(png|jpe?g|webp)$/i.test(v.path)) return { url: asFileUrl(v.path), path: v.path }
  }
  return null
}

function collectImages(outputs: any[], base: string): Array<{ url: string; path?: string }> {
  const out: Array<{ url: string; path?: string }> = []
  const push = (v: any) => {
    const img = fileToImage(v, base)
    if (img) out.push(img)
  }
  const latest = outputs?.[6]
  if (latest) push(latest)
  const gallery = outputs?.[1]
  if (Array.isArray(gallery)) {
    for (const item of gallery) push(Array.isArray(item) ? item[0] : item)
  } else if (gallery && typeof gallery === 'object' && Array.isArray(gallery.value)) {
    for (const item of gallery.value) push(Array.isArray(item) ? item[0] : item)
  }
  // 去重（同一个文件可能在「最新结果」和「画廊」里各出现一次）
  const seen = new Set<string>()
  return out.filter(i => (seen.has(i.url) ? false : (seen.add(i.url), true)))
}

/**
 * 生成 / 编辑图片（整条任务队列流程）。
 * 0 张参考图 = 文生图；1~3 张 = 图生图 / 编辑。
 */
export async function qwenImageGenerate(cfg: QwenImageConfig, opts: QwenImageGenOptions): Promise<QwenImageResult> {
  const info = await qwenImageInfo(cfg.base)
  const addFn = info.fnIndex['/add_task_to_queue']
  const refreshFn = info.fnIndex['/refresh_ui_and_process_queue']
  if (addFn === undefined || refreshFn === undefined) {
    throw new Error('服务端缺少 add_task_to_queue / refresh_ui_and_process_queue 接口')
  }

  const prompt = String(opts.prompt || '').trim()
  if (!prompt) throw new Error('请输入提示词')

  const session = new GradioQueueSession(info.base)
  const logLines: string[] = []
  const pushLog = (s: string) => {
    const t = String(s || '').trim()
    if (!t) return
    logLines.push(t)
    if (logLines.length > 80) logLines.splice(0, logLines.length - 80)
    opts.onLog?.(t)
  }

  try {
    // 参考图上传（最多 3 张）
    const images = (opts.images || []).slice(0, 3)
    const paths = images.length ? await uploadFiles(info.base, images, opts.fileNames || []) : []
    const imgData = (i: number) => (paths[i] ? toFileData(paths[i]) : null)

    const token = String(cfg.token || '').trim() || String(paramDefault(info, 'token', ''))
    const modelType = cfg.modelType || String(paramDefault(info, 'model_type', 'Qwen(本地免费)'))
    const width = Math.max(256, Math.min(4096, Math.round(Number(cfg.width) || 1024)))
    const height = Math.max(256, Math.min(4096, Math.round(Number(cfg.height) || 1024)))
    const steps = Math.max(1, Math.min(100, Math.round(Number(cfg.steps) || 4)))

    // 顺序严格按服务端 /info 的 parameters 顺序：
    // [0]提示词 [1]迭代次数 [2]负面提示词 [3]图片1 [4]图片2 [5]图片3 [6]姿态控制 [7]局部重绘
    // [8]token [9]模型类型 [10..13]Lora1-4 [14..17]Lora权重 [18]指定宽高 [19]宽 [20]高
    // [21]水平视角 [22]垂直视角 [23]视角距离 [24]强制回收显存
    const data = [
      prompt,
      steps,
      String(cfg.negative || ''),
      imgData(0),
      imgData(1),
      imgData(2),
      !!opts.usePose,
      !!opts.useInpaint,
      token,
      modelType,
      cfg.lora1 || String(paramDefault(info, 'm1_lora_1', 'None')),
      cfg.lora2 || 'None',
      cfg.lora3 || 'None',
      cfg.lora4 || 'None',
      1, 1, 1, 1,
      true,
      width,
      height,
      cfg.horizontal || '无',
      cfg.vertical || '无',
      cfg.distance || '无',
      cfg.refineText || '开启',
    ]

    pushLog(`提交任务：${prompt.slice(0, 60)}${prompt.length > 60 ? '…' : ''}`)
    // 隐藏输入补 null（放在最前面）：add 有 2 个、refresh 有 5 个
    const padFor = (api: string, visible: number) =>
      Math.max(0, (info.inputCounts[api] ?? 0) - visible)
    const addData = [...Array(padFor('/add_task_to_queue', info.params.length)).fill(null), ...data]
    const refreshData = [...Array(padFor('/refresh_ui_and_process_queue', 0)).fill(null)]
    const addOut = tailOutputs(assertSuccess(await session.call(addFn, addData, 60_000), '加入生成队列'), 3)
    const detail = typeof addOut[0] === 'string' ? addOut[0] : JSON.stringify(addOut[0] || '')
    if (detail) pushLog(detail)
    const firstQueue = Number(addOut[2])
    if (!Number.isNaN(firstQueue)) opts.onQueue?.(firstQueue)

    const maxWaitMs = opts.maxWaitMs && opts.maxWaitMs > 0 ? opts.maxWaitMs : 5 * 60_000
    const pollMs = opts.pollMs && opts.pollMs > 0 ? opts.pollMs : 2500
    const started = Date.now()
    let lastOutputs: any[] = []
    let lastLog = ''
    let lastQueue = -1
    let imagesFound: Array<{ url: string; path?: string }> = []

    while (Date.now() - started < maxWaitMs) {
      if (opts.signal?.aborted) throw new Error('已取消')
      // refresh 的 7 个返回值：任务详情 / 画廊 / 打包文件 / markdown / 排队数 / 实时日志 / 最新结果
      const out = tailOutputs(
        assertSuccess(await session.call(refreshFn, refreshData, Math.min(120_000, maxWaitMs)), '处理生成任务'),
        7
      )
      lastOutputs = out

      const q = Number(out[4])
      if (!Number.isNaN(q) && q !== lastQueue) {
        lastQueue = q
        opts.onQueue?.(q)
      }
      const logText = typeof out[5] === 'string' ? out[5] : ''
      if (logText && logText !== lastLog) {
        const added = logText.startsWith(lastLog) ? logText.slice(lastLog.length) : logText
        lastLog = logText
        for (const line of added.split('\n')) pushLog(line)
      }

      imagesFound = collectImages(out, info.base)
      if (imagesFound.length) {
        pushLog('生成完成')
        return {
          images: imagesFound,
          lastOutputs,
          log: logLines.join('\n'),
          sessionHash: session.sessionHash,
        }
      }
      await new Promise(r => setTimeout(r, pollMs))
    }
    throw new Error(`等待生成结果超时（${Math.round(maxWaitMs / 1000)}s）`)
  } finally {
    session.close()
  }
}
