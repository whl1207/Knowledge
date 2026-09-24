// src/shared/ai-core.ts
// AI 请求执行 + 解析核心（渲染进程与主进程共享的单一数据源）
//
// 说明：
// - 本文件必须保持「环境无关」：只使用 fetch / TextDecoder / AbortController /
//   ReadableStream 等浏览器与 Node 18+（Electron 主进程）都有的标准 API，
//   不能 import 任何浏览器专用或 Node 专用的包（如 ollama 浏览器 SDK）。
// - 主进程（electron/main/ai-service.ts）直接调用本模块的方法执行请求并解析。
// - 渲染进程（src/services/ai-utils.ts）在浏览器/LAN 模式下也直接调用本模块；
//   Electron 模式下则通过 IPC 桥委托给主进程。
// - resolveApiUrl：仅在浏览器（无 ipcRenderer）时把请求转发到 LAN 服务器的
//   /__proxy 代理；主进程环境没有 window，会直接使用原始 URL。

/**
 * 在浏览器环境（无 ipcRenderer）时，通过 LAN 服务器的 /__proxy 代理转发 API 请求，
 * 解决远程浏览器无法直连本地 AI 服务（Ollama、LM Studio 等）的问题。
 */
function resolveApiUrl(originalUrl: string): string {
  if (typeof window !== 'undefined' && !(window as any).ipcRenderer) {
    const origin = window.location.origin
    return `${origin}/__proxy?url=${encodeURIComponent(originalUrl)}`
  }
  return originalUrl
}

// 定义消息类型
export interface AIMessage {
    role: string;
    content: string;
    images?: any[];
    tool_calls?: any[];
    tool_name?: string;
    tool_call_id?: string;
}

// 定义配置类型
export interface OllamaConfig {
    model_url: string;
    model: string;
}

// LM Studio 配置类型
export interface LMStudioConfig {
    base_url: string;
    model: string;
    available_models: string[];
    api_key?: string; // LM Studio 默认不需要 API key，但保留以兼容
}

export interface LLMConfig {
    stream: boolean;
    temperature: number;
    top_p: number;
    max_tokens: number;
    /** 采样惩罚（OCR 等抑制复读场景）：OpenAI 兼容后端直接用，ollama 走 options */
    frequency_penalty?: number;
    presence_penalty?: number;
    format?: string;
    think?: boolean | string;
    logprobs?: boolean;
    top_logprobs?: number;
    keep_alive?: string | number;
    tools?: any[];
    options?: any;
}

export interface AICallbacks {
    onStream?: (chunk: string) => void;
    onComplete?: (content: string, metadata?: any) => void;
    onError?: (error: Error) => void;
    signal?: AbortSignal;
    tools?: any[];
    toolChoice?: any;
    onToolCalls?: (calls: any[]) => void;
    onToolCallArgs?: (callId: string, name: string, argsFragment: string) => void;
    onSearchStatus?: (info: any) => void;
    onReasoning?: (text: string) => void;
}

// 统一的「流式输出配置」接口（流式 chunk 也通过该接口输出）
export interface StreamOptions extends AICallbacks {}

// ---------- 自定义 API 模型端点推导辅助 ----------

interface ThinkStreamState { inThink: boolean; thinking: string }

/**
 * 增量消化 OpenAI 兼容流式正文中的 <think>…</think>（Qwen3/vLLM 深度思考，支持跨 chunk 未闭合段）：
 * 返回应进入正文流的文本；思考文本累积进 state 并经 onReasoning 逐段推送（整段累积刷新，供思考块展示）。
 * 孤立出现的 </think>（GPUStack/vLLM 偶发把收尾标签单独放进正文流）一律剔除，正文永不残留标签。
 */
function feedThinkState(rawText: string, st: ThinkStreamState, onReasoning?: (text: string) => void): string {
  let out = ''
  let chunk = String(rawText || '')
  const pushThink = (seg: string) => {
    if (!seg) return
    st.thinking += seg
    onReasoning?.(st.thinking)
  }
  if (st.inThink) {
    // 上块已进入思考：优先找本块的 </think> 收尾
    const end = chunk.indexOf('</think>')
    if (end === -1) { pushThink(chunk); return out }
    pushThink(chunk.slice(0, end))
    st.inThink = false
    chunk = chunk.slice(end + 8)
  }
  while (true) {
    const idx = chunk.indexOf('<think>')
    if (idx === -1) break
    out += chunk.slice(0, idx)
    chunk = chunk.slice(idx + 7)
    st.inThink = true
    const end = chunk.indexOf('</think>')
    if (end === -1) {
      // 思考未闭合：本 chunk 剩余全部属于思考文本（标签已剔除）
      if (chunk) { st.thinking += chunk; onReasoning?.(st.thinking) }
      return out
    }
    st.thinking += chunk.slice(0, end)
    onReasoning?.(st.thinking)
    st.inThink = false
    chunk = chunk.slice(end + 8)
  }
  out += chunk
  // 注意：不删除正文中孤立的 </think> —— GPUStack/vLLM 对 Qwen3 显式 enable_thinking 时
  // 会丢失 <think> 开标签、只给 </think> 收尾（畸形形态）。此处保留标签，交给渲染层
  // splitThinkText 把 </think> 之前的内容识别为思考，避免思考文本混入正文无法还原。
  return out
}

function stripTrailingSlash(s: string): string {
  return String(s || '').replace(/\/+$/, '')
}

/** 常见「聊天/补全/响应」请求路由后缀（用于推导基址与判断是否已是完整端点） */
const CHAT_ROUTE_SUFFIXES = [
  '/v1/chat/completions', '/chat/completions',
  '/v1/completions', '/completions',
  '/v1/responses', '/responses',
  '/v1/messages', '/messages',
  '/v1/chat', '/chat',
  '/v1/generate', '/generate',
  // GPUStack 等使用 /v1-openai 前缀的 OpenAI 兼容服务
  '/v1-openai/chat/completions', '/v1-openai/completions',
  '/v1-openai/embeddings', '/v1-openai/responses',
]

/**
 * 归一化自定义 api_url 为「聊天请求端点」：
 * - 已是完整聊天/补全/响应路由 → 原样返回（如 GPUStack 的 .../v1-openai/chat/completions）
 * - 以 /v1-openai 结尾（GPUStack 等 OpenAI 兼容基址）→ 补 /chat/completions
 * - 以 /v1 结尾（OpenAI 兼容基址）→ 补 /chat/completions
 * - 裸基址（仅主机无路径）→ 按 GPUStack 的 /v1-openai 前缀补全
 * - 其它形态 → 原样返回（视为完整自定义端点，不猜测）
 */
function isBareHostUrl(url: string): boolean {
  try {
    const u = new URL(url)
    const path = u.pathname || '/'
    return path === '/' || path === ''
  } catch {
    return false
  }
}
function buildCustomChatEndpoint(apiUrl: string): string {
  const url = stripTrailingSlash(apiUrl)
  if (!url) return url
  for (const suf of CHAT_ROUTE_SUFFIXES) {
    if (url.endsWith(suf)) return url
  }
  if (url.endsWith('/v1-openai')) return `${url}/chat/completions`
  if (url.endsWith('/v1')) return `${url}/chat/completions`
  if (isBareHostUrl(url)) return `${url}/v1-openai/chat/completions`
  return url
}

/** 从自定义 api_url 推导 /models 候选端点（兼容 OpenAI 兼容 / 网关 / GPUStack / 裸地址等形态） */
function buildModelsCandidates(apiUrl: string): string[] {
  let base = stripTrailingSlash(apiUrl)
  // 去掉常见「聊天/补全/响应」端点后缀得到服务基址
  for (const suf of CHAT_ROUTE_SUFFIXES) {
    if (base.endsWith(suf)) {
      base = stripTrailingSlash(base.slice(0, -suf.length))
      break
    }
  }
  const out: string[] = []
  if (base.endsWith('/v1-openai')) {
    // GPUStack 等：/v1-openai 基址 → /v1-openai/models
    out.push(`${base}/models`)
  } else if (base.endsWith('/v1')) {
    out.push(`${base}/models`)
  } else {
    // 裸基址：优先 GPUStack 的 /v1-openai/models，再回退标准 OpenAI 兼容 /v1/models、/models
    out.push(`${base}/v1-openai/models`, `${base}/v1/models`, `${base}/models`)
  }
  // 去重（个别后缀剥离后候选可能相同）
  return [...new Set(out)]
}

/** 从 /models 响应中提取模型 id 列表（兼容 {data:[{id}]} / {models:[]} / 字符串数组） */
function extractModelIds(data: any): string[] {
  const pick = (m: any) => (typeof m === 'string' ? m : m?.id)
  if (Array.isArray(data?.data)) return data.data.map(pick).filter(Boolean)
  if (Array.isArray(data?.models)) return data.models.map(pick).filter(Boolean)
  if (Array.isArray(data)) return data.map(pick).filter(Boolean)
  return []
}

// ---------- 推理强度（reasoning effort）归一化 ----------

/** 统一推理强度档位（UI 选择 / store 存储 / 各后端下发均用这五个值） */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'max'

/**
 * 归一化 think 配置为「是否开启思考 + 统一档位」。
 * 兼容历史值：false/null/''/'none' → 关闭；true → 开启（默认 high）；
 * 字符串档位支持 low/minimal、medium、high/xhigh、max/ultra。
 */
export function normalizeReasoning(think: any): { enabled: boolean; effort: ReasoningEffort } {
  if (think === false || think === null || think === undefined || think === '') return { enabled: false, effort: 'none' }
  if (think === true) return { enabled: true, effort: 'high' }
  const s = String(think).toLowerCase().trim()
  if (s === 'none' || s === 'off' || s === 'disabled' || s === 'false') return { enabled: false, effort: 'none' }
  if (s === 'low' || s === 'minimal') return { enabled: true, effort: 'low' }
  if (s === 'medium') return { enabled: true, effort: 'medium' }
  if (s === 'max' || s === 'ultra') return { enabled: true, effort: 'max' }
  return { enabled: true, effort: 'high' }
}

/** DeepSeek 官方档位：仅支持 none/low/high/max（medium 抬升为 high） */
function deepseekEffort(effort: ReasoningEffort): 'none' | 'low' | 'high' | 'max' {
  return effort === 'medium' ? 'high' : (effort === 'none' ? 'none' : effort)
}

/** Ollama / LM Studio 档位：仅支持 low/medium/high（max 回退为 high），关闭时用 none */
function localEffort(effort: ReasoningEffort): 'none' | 'low' | 'medium' | 'high' {
  return effort === 'max' ? 'high' : (effort === 'none' ? 'none' : effort)
}

// ---------- 上下文窗口探测（各来源差异大，按来源分派） ----------

/**
 * 上下文窗口探测结果。`from` 决定可信度排序（上层见 src/lib/contextUsage.ts）：
 *  - loaded：已加载实例**真正生效**的值（Ollama /api/ps、LM Studio loaded_context_length）
 *  - model-file：模型文件里写死的默认（Ollama Modelfile PARAMETER num_ctx）
 *  - model-max：模型能力上限（不一定是实际生效值）
 */
export interface ContextWindowProbe {
    limit: number
    from: 'loaded' | 'model-file' | 'model-max'
}

/**
 * LM Studio 模型条目（原生端点 /api/v0/models）。
 * type：llm（对话）/ vlm（视觉）/ embeddings（嵌入）；state：loaded / not-loaded。
 * 旧版 LM Studio 无原生端点时回退 /v1/models，此时 type / state 为空（未知）。
 */
export interface LmStudioModelInfo {
    id: string
    /** llm / vlm / embeddings；未知时为空串 */
    type: string
    /** loaded / not-loaded；未知时为空串 */
    state: string
    publisher?: string
    quantization?: string
    maxContextLength?: number
    loadedContextLength?: number
}

/** Ollama 模型条目（GET /api/tags + POST /api/show 合并） */
export interface OllamaModelInfo {
    name: string
    size?: number
    modifiedAt?: string
    family?: string
    parameterSize?: string
    quantization?: string
    /** /api/show capabilities：completion / vision / tools / thinking / embedding */
    capabilities?: string[]
    /** 模型能力上限（model_info.<arch>.context_length） */
    maxContextLength?: number
    /** Modelfile 里写死的 num_ctx（未加载时可参考的默认值） */
    defaultContextLength?: number
    embeddingLength?: number
}

/** Ollama 已加载实例（GET /api/ps） */
export interface OllamaLoadedModel {
    name: string
    size?: number
    sizeVram?: number
    /** 当前实际生效的上下文长度 */
    contextLength?: number
    expiresAt?: string
}

/** 模型名归一化比较（忽略 `:latest` 之类的 tag 后缀差异） */
function sameModelName(a: any, b: any): boolean {
    const norm = (s: any) => String(s || '').trim().replace(/:(latest|default)$/i, '')
    const x = norm(a)
    return !!x && x === norm(b)
}

/** Ollama /api/show 明细缓存（key = 模型名|modified_at）：避免每次刷新都重复拉取 */
const ollamaDetailCache = new Map<string, { capabilities: string[]; maxContextLength?: number; defaultContextLength?: number; embeddingLength?: number }>()

/** 从 model_info 里按后缀取第一个正数（键名带架构前缀，随模型变化：llama. / qwen35. / nomic-bert. …） */
function pickModelInfoNumber(info: any, suffix: string): number | undefined {
    if (!info || typeof info !== 'object') return undefined
    const key = Object.keys(info).find((k) => k.endsWith(suffix) && typeof info[k] === 'number' && info[k] > 0)
    return key ? Number(info[key]) : undefined
}

/** 解析 Modelfile parameters 里的 num_ctx（通常是参数文本；个别版本回传对象） */
function pickNumCtx(params: any): number | undefined {
    if (!params) return undefined
    if (typeof params === 'object' && !Array.isArray(params)) {
        const n = Number(params.num_ctx || 0)
        return n > 0 ? n : undefined
    }
    const m = /^[ \t]*num_ctx[ \t]+(\d+)/im.exec(String(params))
    return m ? Number(m[1]) : undefined
}

/**
 * 并发受限地补全每个 Ollama 模型的 capabilities / 上下文信息（命中缓存则零开销）。
 * /api/show 只读元数据、不会加载模型；单个失败不影响整表。
 */
async function fillOllamaModelDetails(base: string, models: OllamaModelInfo[], concurrency = 4): Promise<void> {
    const queue = models.slice(0, 60) // 上限：模型很多时不至于一次打爆本地服务
    let cursor = 0
    const runOne = async (m: OllamaModelInfo): Promise<void> => {
        const key = `${m.name}|${m.modifiedAt || ''}`
        let detail = ollamaDetailCache.get(key)
        if (!detail) {
            try {
                const res = await fetch(resolveApiUrl(`${base}/api/show`), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: m.name }),
                })
                if (res.ok) {
                    const data: any = await res.json()
                    detail = {
                        capabilities: Array.isArray(data?.capabilities) ? data.capabilities.map((c: any) => String(c)) : [],
                        maxContextLength: pickModelInfoNumber(data?.model_info, '.context_length'),
                        defaultContextLength: pickNumCtx(data?.parameters),
                        embeddingLength: pickModelInfoNumber(data?.model_info, '.embedding_length'),
                    }
                    ollamaDetailCache.set(key, detail)
                }
            } catch { /* 单个模型读取失败：跳过明细，不影响列表 */ }
        }
        if (detail) Object.assign(m, detail)
    }
    const worker = async (): Promise<void> => {
        while (cursor < queue.length) {
            const idx = cursor
            cursor += 1
            await runOne(queue[idx])
        }
    }
    const workers: Promise<void>[] = []
    for (let i = 0; i < Math.max(1, concurrency); i++) workers.push(worker())
    await Promise.all(workers)
}

/**
 * Ollama 实际生效的上下文窗口，按「真实生效程度」依次探测：
 *  1) /api/ps 中已加载实例的 context_length = 当前真正生效的 num_ctx（from: loaded）。
 *     用户在 Ollama 侧的所有手动设置（桌面端「上下文长度」、环境变量 OLLAMA_CONTEXT_LENGTH、
 *     模型加载时的 options.num_ctx）最终都只体现在这里——/api/show 里读不到它们；
 *  2) /api/show 的 parameters 里的 num_ctx（Modelfile 显式写死，from: model-file）；
 *  3) /api/show 的 model_info['<架构>.context_length'] = 模型能力上限（from: model-max）；
 *     未手动调小时，新版 Ollama 默认就按该上限加载（日志里 n_ctx = context_length）。
 * 第 1 项需要模型已加载（未加载时 /api/ps 为空），因此调用方在每次请求完成后应重探一次，
 * 并把读到的 loaded 值持久化（见 contextUsage.probedContextWindow）。
 */
async function fetchOllamaContextWindow(config: any, model: string): Promise<ContextWindowProbe | null> {
    const base = stripTrailingSlash(String((config && config.model_url) || 'http://127.0.0.1:11434'))
    try {
        const psRes = await fetch(resolveApiUrl(`${base}/api/ps`))
        if (psRes.ok) {
            const ps = await psRes.json()
            const hit = ((ps && ps.models) || []).find((m: any) => sameModelName(m && (m.name || m.model), model))
            const loaded = hit && (hit.context_length ?? (hit.details && hit.details.context_length))
            if (typeof loaded === 'number' && loaded > 0) return { limit: loaded, from: 'loaded' }
        }
    } catch { /* /api/ps 不可用（旧版本/未加载）：继续向下探测 */ }
    const res = await fetch(resolveApiUrl(`${base}/api/show`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: false }),
    })
    if (!res.ok) return null
    const data = await res.json()
    const params = data && data.parameters
    // /api/show 的 parameters 通常是 Modelfile 参数文本；个别版本回传对象
    const numCtx = (params && typeof params === 'object')
        ? Number(params.num_ctx || 0)
        : Number((/^[ \t]*num_ctx[ \t]+(\d+)/im.exec(String(params || '')) || [])[1] || 0)
    if (numCtx > 0) return { limit: numCtx, from: 'model-file' }
    const info = (data && data.model_info) || {}
    // 模型上限的键名带架构前缀，随模型变化（llama. / qwen35. / gemma4. / glmocr. …）：
    // 先按 general.architecture 拼，再兜底扫任意 *.context_length，不能写死 'llama.context_length'
    const arch = String(info['general.architecture'] || '')
    const byArch = arch ? info[`${arch}.context_length`] : undefined
    const cl = byArch
        ?? Object.keys(info).filter((k) => k.endsWith('.context_length'))
            .map((k) => info[k]).find((v: any) => typeof v === 'number' && v > 0)
        ?? (data && data.context_length)
    return typeof cl === 'number' && cl > 0 ? { limit: cl, from: 'model-max' } : null
}

/**
 * LM Studio 实际生效的上下文窗口：/api/v0/models 的 loaded_context_length
 * （当前已加载实例的窗口，from: loaded）优先，其次 max_context_length（模型能力上限）。
 * 端点不可用时返回 null，由调用方回退到默认表。
 */async function fetchLmStudioContextWindow(config: any, model: string): Promise<ContextWindowProbe | null> {
    const base = stripTrailingSlash(String((config && config.base_url) || ''))
    if (!base) return null
    try {
        const res = await fetch(resolveApiUrl(`${base}/api/v0/models`))
        if (!res.ok) return null
        const data = await res.json()
        const list = (data && (data.data || data.models)) || []
        const hit = list.find((m: any) => sameModelName(m && (m.id || m.model || m.name), model))
        const loaded = hit && Number(hit.loaded_context_length || 0)
        if (loaded > 0) return { limit: loaded, from: 'loaded' }
        const max = hit && Number(hit.max_context_length || 0)
        return max > 0 ? { limit: max, from: 'model-max' } : null
    } catch {
        return null
    }
}

// AI API工具函数（共享核心：主进程执行，渲染进程在浏览器模式兜底直连）
export class AIUtils {
    // 归一化自定义 api_url 为聊天请求端点（基址自动补 /chat/completions，GPUStack 等本地服务可用基址）
    static buildCustomChatEndpoint(apiUrl: string): string {
        return buildCustomChatEndpoint(apiUrl)
    }

    // 检查Ollama连接
    static async checkOllamaConnection(ollamaConfig: any) {
        try {
            // 浏览器环境用代理，Electron 环境直连
            const apiUrl = resolveApiUrl(`${ollamaConfig.model_url}/api/tags`)
            const response = await fetch(apiUrl)

            if (response.ok) {
                const result = await response.json()
                const models = result.models || []
                const online = true
                const available_models = models.map((model: any) => model.name)

                // 如果没有选择模型，使用第一个可用的模型
                let model = ollamaConfig.model
                if (!model && models.length > 0) {
                    model = models[0].name
                }

                return { online, available_models, model }
            } else {
                return { online: false, available_models: [], model: ollamaConfig.model }
            }
        } catch (error) {
            console.error('Ollama连接错误:', error)
            return { online: false, available_models: [], model: ollamaConfig.model }
        }
    }

    /**
     * 获取模型真实上下文窗口（tokens）——带来源信息，供上层按可信度排序（见 src/lib/contextUsage.ts）：
     *  - Ollama → /api/ps 已加载实例的 context_length（loaded）> Modelfile num_ctx（model-file）> 模型上限（model-max）；
     *  - LM Studio → /api/v0/models 的 loaded_context_length（loaded）> max_context_length（model-max）；
     *  - Google → /models 的 inputTokenLimit（model-max）；
     *  - 其余来源无法读取 → null
     */
    static async fetchModelContextWindowDetail(provider: string, config: any, model: string): Promise<ContextWindowProbe | null> {
        if (!provider || !model) return null
        try {
            if (provider === 'ollama') return await fetchOllamaContextWindow(config, model)
            if (provider === 'lmstudio') return await fetchLmStudioContextWindow(config, model)
            if (provider === 'google') {
                const base = 'https://generativelanguage.googleapis.com'
                const key = (config && config.api_key) || ''
                const response = await fetch(resolveApiUrl(`${base}/v1beta/models?key=${encodeURIComponent(key)}`))
                if (!response.ok) return null
                const data = await response.json()
                const found = ((data && data.models) || []).find((m: any) => m && m.name === `models/${model}`)
                const limit = found && found.inputTokenLimit
                return typeof limit === 'number' && limit > 0 ? { limit, from: 'model-max' } : null
            }
            return null
        } catch (error) {
            console.warn('读取模型上下文窗口失败:', provider, model, error)
            return null
        }
    }

    /** 获取模型真实上下文窗口（tokens）；只关心数值的调用方用这个（详情见 fetchModelContextWindowDetail） */
    static async fetchModelContextWindow(provider: string, config: any, model: string): Promise<number | null> {
        const probe = await AIUtils.fetchModelContextWindowDetail(provider, config, model)
        return probe ? probe.limit : null
    }

    /**
     * Ollama 模型清单（已安装 + 已加载）：
     *  - GET /api/tags → 全部本地模型（名称 / 体积 / family / 参数规模 / 量化）
     *  - GET /api/ps   → 已加载实例（体积 / 显存占用 / 生效上下文 / 到期时间）
     *  - POST /api/show（按需，带缓存）→ capabilities（completion / vision / tools / thinking / embedding）、
     *    model_info.*.context_length（能力上限）、Modelfile num_ctx（默认上下文）、embedding_length
     * 供「设置 → 模型 → Ollama」显示模型类型、参数、上下文与加载状态，并支持加载 / 卸载。
     */
    static async listOllamaModels(config: any): Promise<{
        online: boolean
        models: OllamaModelInfo[]
        loaded: OllamaLoadedModel[]
        error?: string
    }> {
        const base = stripTrailingSlash(String((config && config.model_url) || 'http://127.0.0.1:11434'))
        let tags: any
        try {
            const res = await fetch(resolveApiUrl(`${base}/api/tags`))
            if (!res.ok) return { online: false, models: [], loaded: [], error: `HTTP ${res.status}` }
            tags = await res.json()
        } catch (e: any) {
            return { online: false, models: [], loaded: [], error: e?.message || String(e) }
        }
        const rows: any[] = (tags && tags.models) || []
        const models: OllamaModelInfo[] = rows.map((m: any) => ({
            name: String(m?.name || m?.model || ''),
            size: Number(m?.size || 0) || undefined,
            modifiedAt: m?.modified_at ? String(m.modified_at) : undefined,
            family: m?.details?.family ? String(m.details.family) : undefined,
            parameterSize: m?.details?.parameter_size ? String(m.details.parameter_size) : undefined,
            quantization: m?.details?.quantization_level ? String(m.details.quantization_level) : undefined,
        })).filter((m: OllamaModelInfo) => !!m.name)
        // 已加载实例（/api/ps）：读取失败不影响主列表
        let loaded: OllamaLoadedModel[] = []
        try {
            const res = await fetch(resolveApiUrl(`${base}/api/ps`))
            if (res.ok) {
                const ps = await res.json()
                loaded = ((ps && ps.models) || []).map((m: any): OllamaLoadedModel => ({
                    name: String(m?.name || m?.model || ''),
                    size: Number(m?.size || 0) || undefined,
                    sizeVram: Number(m?.size_vram || 0) || undefined,
                    contextLength: Number(m?.context_length || 0) || undefined,
                    expiresAt: m?.expires_at ? String(m.expires_at) : undefined,
                })).filter((m: OllamaLoadedModel) => !!m.name)
            }
        } catch { /* /api/ps 不可用（旧版本）：仅缺加载状态 */ }
        // 逐模型补全 capabilities / 上下文（并发受限 + 按 名称+修改时间 缓存，避免重复请求）
        await fillOllamaModelDetails(base, models, 4)
        return { online: true, models, loaded }
    }

    /**
     * Ollama 加载 / 卸载模型（官方方式：/api/generate 的 keep_alive）。
     *  - 加载（对话 / 视觉）：POST /api/generate { model, prompt: '', keep_alive: '30m' }
     *  - 加载（嵌入模型）：/api/generate 会返回 “does not support generate” → 自动回退 POST /api/embed { model, input, keep_alive }
     *  - 卸载（两类通用）：POST /api/generate { model, keep_alive: 0 }（返回 done_reason=unload）
     */
    static async ollamaModelAction(config: any, action: 'load' | 'unload', model: string, keepAlive?: string): Promise<{ ok: boolean; output?: string; error?: string; via?: string }> {
        const base = stripTrailingSlash(String((config && config.model_url) || 'http://127.0.0.1:11434'))
        const name = String(model || '').trim()
        if (!name) return { ok: false, error: '缺少 model' }
        const post = async (path: string, body: any): Promise<{ ok: boolean; status: number; text: string; error?: string }> => {
            try {
                const res = await fetch(resolveApiUrl(`${base}${path}`), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                })
                const text = await res.text()
                if (res.ok) return { ok: true, status: res.status, text }
                let msg = `HTTP ${res.status}`
                try { const j = JSON.parse(text); if (j?.error) msg += `: ${j.error}` } catch { /* 非 JSON 响应 */ }
                return { ok: false, status: res.status, text, error: msg }
            } catch (e: any) {
                return { ok: false, status: 0, text: '', error: e?.message || String(e) }
            }
        }
        const keep = String(keepAlive || '30m') || '30m'
        if (action === 'unload') {
            const r = await post('/api/generate', { model: name, keep_alive: 0 })
            if (!r.ok) return { ok: false, error: r.error, output: r.text.slice(0, 500) }
            return { ok: true, via: 'generate', output: `${name} → unload` }
        }
        // 加载：先按对话 / 视觉模型预热
        const r1 = await post('/api/generate', { model: name, prompt: '', keep_alive: keep })
        if (r1.ok) return { ok: true, via: 'generate', output: `${name} → keep_alive ${keep}` }
        // 嵌入模型不支持 generate → 回退 /api/embed（input 非空才能触发加载）
        if (r1.status === 400 || /does not support generate/i.test(r1.error || '')) {
            const r2 = await post('/api/embed', { model: name, input: 'ping', keep_alive: keep })
            if (r2.ok) return { ok: true, via: 'embed', output: `${name} → keep_alive ${keep}（via /api/embed）` }
            return { ok: false, error: r2.error, output: r2.text.slice(0, 500) }
        }
        return { ok: false, error: r1.error, output: r1.text.slice(0, 500) }
    }

    static async checkLMStudioConnection(lmstudioConfig: {
        base_url: string;
        model?: string;
    }): Promise<{
        online: boolean;
        available_models: string[];
        model?: string;
    }> {
        if (!lmstudioConfig.base_url) {
            return { online: false, available_models: [], model: '' };
        }

        try {
            // LM Studio 使用 OpenAI 兼容的 /v1/models 端点
            const lmStudioUrl = resolveApiUrl(`${lmstudioConfig.base_url}/v1/models`)
            const response = await fetch(lmStudioUrl, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const data = await response.json();
                const available_models = data.data.map((model: any) => model.id);

                // 检查当前选择的模型是否在可用列表中
                let model = lmstudioConfig.model;
                if (model && !available_models.includes(model)) {
                    model = available_models.length > 0 ? available_models[0] : '';
                }
                if (!model && available_models.length > 0) {
                    model = available_models[0];
                }

                return { online: true, available_models, model };
            } else {
                console.error('LM Studio API连接失败:', response.statusText);
                return { online: false, available_models: [], model: lmstudioConfig.model };
            }
        } catch (error) {
            console.error('LM Studio连接错误:', error);
            return { online: false, available_models: [], model: lmstudioConfig.model };
        }
    }

    /**
     * LM Studio 模型清单（含类型与加载状态）：原生端点 /api/v0/models 提供
     * type（llm / vlm / embeddings）与 state（loaded / not-loaded），
     * 旧版 LM Studio 无该端点时回退 /v1/models（此时类型与状态未知，仅能列名字）。
     * 供「设置 → 模型 → LM Studio」显示哪些模型已加载，并提示知识库嵌入模型是否可用。
     */
    static async listLmStudioModels(config: { base_url?: string }): Promise<{
        online: boolean
        models: LmStudioModelInfo[]
        /** 是否来自原生端点（true = 有 type / state 信息） */
        native: boolean
        error?: string
    }> {
        const base = stripTrailingSlash(String((config && config.base_url) || '')).replace(/\/v1$/i, '')
        if (!base) return { online: false, models: [], native: false, error: 'base_url 为空' }
        try {
            const res = await fetch(resolveApiUrl(`${base}/api/v0/models`))
            if (res.ok) {
                const data: any = await res.json()
                const list = (data && (data.data || data.models)) || []
                const models: LmStudioModelInfo[] = list
                    .map((m: any) => {
                        const loadedCtx = Number(m?.loaded_context_length || 0) || undefined
                        // state 为主依据；个别版本只给 loaded 布尔或 loaded_context_length，一并兜底
                        const state = String(m?.state || '').toLowerCase()
                            || ((m?.loaded === true || loadedCtx) ? 'loaded' : (m?.loaded === false ? 'not-loaded' : ''))
                        return {
                            id: String(m?.id || m?.model || m?.name || ''),
                            type: String(m?.type || '').toLowerCase(),
                            state,
                            publisher: m?.publisher ? String(m.publisher) : undefined,
                            quantization: m?.quantization ? String(m.quantization) : undefined,
                            maxContextLength: Number(m?.max_context_length || 0) || undefined,
                            loadedContextLength: loadedCtx,
                        }
                    })
                    .filter((m: LmStudioModelInfo) => !!m.id)
                if (models.length) return { online: true, models, native: true }
            }
        } catch { /* 旧版本无原生端点：继续回退 */ }
        try {
            const res = await fetch(resolveApiUrl(`${base}/v1/models`))
            if (!res.ok) return { online: false, models: [], native: false, error: `HTTP ${res.status}` }
            const data: any = await res.json()
            const models: LmStudioModelInfo[] = (((data && data.data) || []) as any[])
                .map((m: any) => ({ id: String(m?.id || ''), type: '', state: '' }))
                .filter((m: LmStudioModelInfo) => !!m.id)
            return { online: true, models, native: false }
        } catch (e: any) {
            return { online: false, models: [], native: false, error: e?.message || String(e) }
        }
    }

    static async sendToLMStudio(
        lmstudioConfig: LMStudioConfig,
        llmConfig: LLMConfig,
        messages: AIMessage[],
        options?: {
            onStream?: (chunk: string) => void;
            onComplete?: (content: string, metadata?: any) => void;
            onError?: (error: Error) => void;
            signal?: AbortSignal;
            tools?: any[];        // function calling 工具定义（LM Studio 为 OpenAI 兼容）
            toolChoice?: any;     // 工具选择策略
            onToolCalls?: (calls: any[]) => void;
        }
    ): Promise<string> {
        if (!lmstudioConfig.model) {
            const error = new Error('请先在AI配置中选择一个LM Studio模型');
            options?.onError?.(error);
            throw error;
        }

        if (!lmstudioConfig.base_url) {
            const error = new Error('请先配置LM Studio服务地址');
            options?.onError?.(error);
            throw error;
        }

        try {
            // 构建符合 OpenAI 格式的请求体
            const requestBody: any = {
                model: lmstudioConfig.model,
                messages: messages.map(msg => {
                    const m: any = { role: msg.role };
                    if (msg.role === 'tool') {
                        m.content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
                    } else if (msg.images && msg.images.length > 0) {
                        // 多模态（视觉模型）：OpenAI 兼容的 content 数组形态（图片由 imageDataUrl 归一化）
                        const parts: any[] = [];
                        if (msg.content) parts.push({ type: 'text', text: msg.content });
                        for (const img of msg.images) {
                            const url = AIUtils.imageDataUrl(img);
                            if (url) parts.push({ type: 'image_url', image_url: { url } });
                        }
                        m.content = parts;
                    } else {
                        m.content = msg.content;
                    }
                    // 保留 function calling 相关的 tool_calls / tool_call_id（OpenAI 兼容）
                    if (msg.tool_calls && msg.tool_calls.length > 0) m.tool_calls = msg.tool_calls;
                    if (msg.tool_call_id) m.tool_call_id = msg.tool_call_id;
                    return m;
                }),
                stream: llmConfig.stream && !!options?.onStream,
                temperature: llmConfig.temperature || 0.7,
                max_tokens: llmConfig.max_tokens || 2048,
                top_p: llmConfig.top_p || 1,
                // 采样惩罚（OCR 等需要抑制复读的场景会用到；未配置时不带这两个字段，避免严格服务端报错）
                ...(typeof llmConfig.frequency_penalty === 'number' ? { frequency_penalty: llmConfig.frequency_penalty } : {}),
                ...(typeof llmConfig.presence_penalty === 'number' ? { presence_penalty: llmConfig.presence_penalty } : {}),
                // 推理强度（reasoning_effort）：LM Studio 支持 low/medium/high 与 none（关闭思考）
                reasoning_effort: (() => {
                    const r = normalizeReasoning(llmConfig.think)
                    return r.enabled ? localEffort(r.effort) : 'none'
                })(),
                // 流式时显式请求服务端返回 usage 统计：OpenAI 兼容接口在流式模式下
                // 默认不返回 usage，必须 stream_options.include_usage=true，
                // 否则输入/输出 token 无法统计（LM Studio / vLLM / 远端 OpenAI 兼容网关均适用）
                stream_options: (llmConfig.stream && !!options?.onStream) ? { include_usage: true } : null,
            };

            // function calling：注入 tools（OpenAI 兼容格式）
            if (options?.tools && options.tools.length > 0) {
                requestBody.tools = options.tools;
                requestBody.tool_choice = options?.toolChoice || 'auto';
            }

            const endpoint = `${lmstudioConfig.base_url}/v1/chat/completions`;
            const headers: Record<string, string> = {
                'Content-Type': 'application/json'
            };

            // 如果有 API key（LM Studio 默认不需要，但保留兼容）
            if (lmstudioConfig.api_key) {
                headers['Authorization'] = `Bearer ${lmstudioConfig.api_key}`;
            }

            // 浏览器环境走代理
            const proxiedEndpoint = resolveApiUrl(endpoint)

            // 使用通用的流式/非流式请求处理
            if (llmConfig.stream && options?.onStream) {
                return await AIUtils.makeStreamingRequest(proxiedEndpoint, requestBody, headers, {
                    ...options,
                    // 添加 OpenAI 特定的响应解析
                    parseResponse: (parsed: any) => {
                        let content = '';
                        if (parsed.choices && parsed.choices[0]) {
                            const delta = parsed.choices[0].delta;
                            if (delta && delta.content) {
                                content = delta.content;
                            }
                        }
                        return content;
                    }
                });
            } else {
                // 非流式请求
                const controller = new AbortController();
                if (options?.signal) {
                    options.signal.addEventListener('abort', () => controller.abort());
                }

                const response = await fetch(proxiedEndpoint, {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify(requestBody),
                    signal: controller.signal
                });

                if (!response.ok) {
                    throw new Error(`LM Studio API错误: ${response.status} ${response.statusText}`);
                }

                const data = await response.json();
                let content = '';

                // 解析 OpenAI 兼容的响应格式
                if (data.choices && data.choices[0]) {
                    if (data.choices[0].message && data.choices[0].message.content) {
                        content = data.choices[0].message.content;
                    } else if (data.choices[0].text) {
                        content = data.choices[0].text;
                    }
                }

                const usage = data.usage || {};
                options?.onComplete?.(content, usage && (usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined)
                    ? { prompt_tokens: usage.prompt_tokens || 0, completion_tokens: usage.completion_tokens || 0 }
                    : undefined);
                return content;
            }
        } catch (error) {
            console.error('[AIUtils] LM Studio请求失败:', error);
            options?.onError?.(error as Error);
            throw error;
        }
    }

    // 检查OpenAI兼容API连接
    static async checkOpenAIConnection(openaiConfig: any) {
        if (!openaiConfig.api_key && !openaiConfig.base_url?.includes('localhost')) {
            // 对于 LM Studio 等本地服务，允许没有 API key
            if (!openaiConfig.base_url) {
                return { online: false, available_models: [] };
            }
        }

        try {
            const response = await fetch(`${openaiConfig.base_url}/v1/models`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${openaiConfig.api_key || 'not-needed'}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const data = await response.json();
                const available_models = data.data.map((model: any) => model.id);
                return { online: true, available_models };
            } else {
                console.error('OpenAI API连接失败:', response.statusText);
                return { online: false, available_models: [] };
            }
        } catch (error) {
            console.error('OpenAI API连接错误:', error);
            return { online: false, available_models: [] };
        }
    }

    // 检查自定义 API 连接：从 api_url 推导 /models 候选端点逐个探测（OpenAI 兼容 / 网关）
    static async checkCustomConnection(customConfig: any) {
        const apiUrl = String(customConfig?.api_url || '').trim()
        if (!apiUrl) return { online: false, available_models: [] }

        const candidates = buildModelsCandidates(apiUrl)
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...(customConfig?.headers || {}),
        }
        const effKey = customConfig?.api_key
        if (effKey) headers['Authorization'] = `Bearer ${effKey}`

        // 逐个候选端点尝试，首个返回模型列表即视为成功；
        // 失败时记录状态（尤其 401=凭据错误，供 UI 提示）
        let lastStatus = 0
        let saw401 = false
        for (const url of candidates) {
            try {
                const response = await fetch(resolveApiUrl(url), { method: 'GET', headers })
                if (response.status === 401) saw401 = true
                if (!response.ok) { lastStatus = response.status || lastStatus; continue }
                const data = await response.json()
                const models = extractModelIds(data)
                if (models.length) return { online: true, available_models: models, status: response.status }
            } catch { /* 尝试下一个候选端点 */ }
        }

        // 全部失败：再对 api_url 本身做一次轻量 GET 探测（至少给出 online 状态）
        try {
            const response = await fetch(resolveApiUrl(apiUrl), { method: 'GET', headers })
            if (response.status === 401) saw401 = true
            const status = saw401 ? 401 : (response.status || lastStatus || 0)
            return { online: response.ok, available_models: [], status }
        } catch {
            return { online: false, available_models: [], status: saw401 ? 401 : lastStatus || 0 }
        }
    }

    // 检查DeepSeek Responses API连接
    static async checkDeepSeekResponsesConnection(responsesConfig: any) {
        if (!responsesConfig.api_key) {
            return { online: false, available_models: [] };
        }

        try {
            const apiUrl = resolveApiUrl(`${responsesConfig.base_url}/v1/models`)
            const response = await fetch(apiUrl, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${responsesConfig.api_key}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const data = await response.json();
                const available_models = (data.data || []).map((model: any) => model.id);
                return { online: true, available_models };
            }

            // 部分网关可能不支持 /v1/models：用最小响应请求探测。官方端点为 /responses
            // （旧 /v1/responses 仍作为回退候选），首个非 404 响应即为可达
            const base = stripTrailingSlash(String(responsesConfig.base_url || ''))
            const probeHeaders = {
                'Authorization': `Bearer ${responsesConfig.api_key}`,
                'Content-Type': 'application/json'
            }
            const probeBody = JSON.stringify({
                model: responsesConfig.model || 'deepseek-flash',
                input: 'ping',
                max_output_tokens: 1
            })
            let lastStatus = 0
            for (const probeUrl of [`${base}/responses`, `${base}/v1/responses`]) {
                try {
                    const probe = await fetch(resolveApiUrl(probeUrl), { method: 'POST', headers: probeHeaders, body: probeBody })
                    if (probe.ok) return { online: true, available_models: [], status: probe.status }
                    lastStatus = probe.status || lastStatus
                    if (probe.status !== 404) break
                } catch { /* 尝试下一个候选端点 */ }
            }
            return { online: false, available_models: [], status: lastStatus };
        } catch (error) {
            console.error('DeepSeek Responses API连接错误:', error);
            return { online: false, available_models: [] };
        }
    }

    /**
     * 查询 DeepSeek 账户余额（GET {base}/user/balance，Bearer 密钥）。
     * 官方响应：{ is_available: boolean, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
     * 注意：该端点不在 /v1 下（base_url 以 /v1 结尾时先去掉再拼），兼容部分网关把结果放在 data 里。
     */
    static async fetchDeepSeekBalance(deepseekConfig: any) {
        const apiKey = String(deepseekConfig?.api_key || '')
        if (!apiKey) return { ok: false, error: 'missing_api_key' as const }
        const base = stripTrailingSlash(String(deepseekConfig?.base_url || 'https://api.deepseek.com'))
        const bases = base.endsWith('/v1') ? [stripTrailingSlash(base.slice(0, -3))] : [base]
        const headers = { 'Accept': 'application/json', 'Authorization': `Bearer ${apiKey}` }
        let lastStatus = 0
        for (const b of bases) {
            try {
                const resp = await fetch(resolveApiUrl(`${b}/user/balance`), { method: 'GET', headers })
                lastStatus = resp.status
                if (!resp.ok) continue
                const data = await resp.json()
                const infos: any[] = Array.isArray(data?.balance_infos) ? data.balance_infos
                    : (Array.isArray(data?.data) ? data.data : [])
                return {
                    ok: true,
                    is_available: data?.is_available !== false,
                    balances: infos.map((b: any) => ({
                        currency: String(b?.currency || ''),
                        total: String(b?.total_balance ?? ''),
                        granted: String(b?.granted_balance ?? ''),
                        toppedUp: String(b?.topped_up_balance ?? ''),
                    })),
                }
            } catch (e) { /* 尝试下一个候选端点 */ }
        }
        return { ok: false, status: lastStatus }
    }

    // 检查Anthropic连接
    static async checkAnthropicConnection(anthropicConfig: any) {
        if (!anthropicConfig.api_key) {
            return { online: false };
        }

        try {
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'x-api-key': anthropicConfig.api_key,
                    'anthropic-version': anthropicConfig.api_version,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: anthropicConfig.model,
                    max_tokens: 1,
                    messages: [{ role: 'user', content: 'test' }]
                })
            });

            return { online: response.ok };
        } catch (error) {
            console.error('Anthropic API连接错误:', error);
            return { online: false };
        }
    }

    // 检查Google连接
    static async checkGoogleConnection(googleConfig: any) {
        if (!googleConfig.api_key) {
            return { online: false };
        }

        try {
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${googleConfig.model}:generateContent?key=${googleConfig.api_key}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        contents: [{
                            parts: [{ text: 'test' }]
                        }]
                    })
                }
            );

            return { online: response.ok };
        } catch (error) {
            console.error('Google Gemini API连接错误:', error);
            return { online: false };
        }
    }

    // 检查 Azure OpenAI 连接：对部署名发一次最小 chat 请求（max_tokens=1），根据响应状态判定
    static async checkAzureConnection(azureConfig: any) {
        const endpoint = stripTrailingSlash(String(azureConfig?.endpoint || ''))
        const deployment = String(azureConfig?.deployment || '')
        if (!endpoint || !deployment) return { online: false, status: 0 };
        const apiVersion = azureConfig?.api_version || '2024-02-15-preview';
        const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
        try {
            const response = await fetch(resolveApiUrl(url), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'api-key': String(azureConfig?.api_key || ''),
                },
                body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 })
            });
            return { online: response.ok, status: response.status };
        } catch (error) {
            console.error('Azure OpenAI连接错误:', error);
            return { online: false, status: 0 };
        }
    }

    // 发送到Ollama
    static async sendToOllama(ollamaConfig: OllamaConfig, llmConfig: LLMConfig, messages: AIMessage[], options?: {
        onStream?: (chunk: string) => void,
        onComplete?: (content: string, metadata?: any) => void,
        onError?: (error: Error) => void,
        signal?: AbortSignal,  // 添加 signal 参数
        tools?: any[],       // function calling 工具定义
        toolChoice?: any,    // 工具选择策略
        onToolCalls?: (calls: any[]) => void, // 工具调用结果回调
        onToolCallArgs?: (callId: string, name: string, argsFragment: string) => void // 工具参数流式增量（function calling）
    }) {
        // 检查模型是否已选择
        if (!ollamaConfig.model) {
            const error = new Error('请先在AI配置中选择一个Ollama模型');
            options?.onError?.(error);
            throw error;
        }

        try {
            // 格式化消息，确保包含多模态支持
            const formattedMessages = messages.map(message => {
                const formattedMessage: any = {
                    role: message.role,
                    content: message.content || ''
                };

                // 如果有图片数据，添加到消息中
                if (message.images && message.images.length > 0) {
                    formattedMessage.images = message.images
                        .map((img: any) => AIUtils.imageBase64(img))
                        .filter((img: string) => img); // 过滤掉空值
                }

                // 如果有工具调用结果（Ollama 期望 arguments 为对象，字符串则尝试解析）
                if (message.tool_calls) {
                    formattedMessage.tool_calls = message.tool_calls.map((tc: any) => ({
                        ...tc,
                        function: {
                            ...(tc.function || {}),
                            arguments: typeof tc.function?.arguments === 'string'
                                ? (() => { try { return JSON.parse(tc.function.arguments) } catch { return tc.function.arguments } })()
                                : tc.function?.arguments
                        }
                    }));
                }

                // 如果有工具执行结果
                if (message.tool_name) {
                    formattedMessage.tool_name = message.tool_name;
                }

                return formattedMessage;
            });

            // 构建请求参数
            const requestParams: any = {
                model: ollamaConfig.model,
                messages: formattedMessages,
                stream: llmConfig.stream,
                options: {
                    temperature: llmConfig.temperature,
                    top_p: llmConfig.top_p,
                    num_predict: llmConfig.max_tokens,
                }
            };

            // 添加可选参数
            if (llmConfig.format === 'json') {
                requestParams.format = 'json';
            }

            // 推理强度：Ollama 的 think 支持 true/false 或 'low'/'medium'/'high'（gpt-oss 等）
            {
                const r = normalizeReasoning(llmConfig.think)
                if (r.enabled) requestParams.think = localEffort(r.effort)
            }

            if (llmConfig.logprobs) {
                requestParams.logprobs = llmConfig.logprobs;
                if (llmConfig.top_logprobs) {
                    requestParams.top_logprobs = llmConfig.top_logprobs;
                }
            }

            if (llmConfig.keep_alive) {
                requestParams.keep_alive = llmConfig.keep_alive;
            }

            // 优先使用按调用传入的 tools（function calling），否则用全局配置
            if (options?.tools && options.tools.length > 0) {
                requestParams.tools = options.tools;
            } else if (llmConfig.tools && llmConfig.tools.length > 0) {
                requestParams.tools = llmConfig.tools;
            }

            // 如果有其他运行时选项
            if (llmConfig.options) {
                requestParams.options = {
                    ...requestParams.options,
                    ...llmConfig.options
                };
            }

            if (llmConfig.stream && options?.onStream) {
                // 流式响应
                let fullContent = '';
                // usage 统计（Ollama 在 done chunk 携带 prompt_eval_count / eval_count）
                let promptEvalCount = 0
                let evalCount = 0

                // 创建 AbortController 来处理中止
                const controller = new AbortController();

                // 如果提供了 signal，监听它的中止事件
                if (options.signal) {
                    options.signal.addEventListener('abort', () => {
                        controller.abort();
                    });
                }

                try {
                    // 使用 fetch 直接调用 Ollama API（浏览器环境走代理）
                    const ollamaApiUrl = resolveApiUrl(`${ollamaConfig.model_url}/api/chat`)
                    const response = await fetch(ollamaApiUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            ...requestParams,
                            stream: true
                        }),
                        signal: controller.signal  // 使用我们的 controller.signal
                    });

                    if (!response.ok) {
                        throw new Error(`HTTP error! status: ${response.status}`);
                    }

                    if (!response.body) {
                        throw new Error('响应体为空');
                    }

                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    // 工具调用收集（function calling，Ollama 在 message.tool_calls 一次性给出）
                    const toolCallsAcc: any[] = [];

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        // 解码并解析每一行
                        const chunk = decoder.decode(value);
                        const lines = chunk.split('\n').filter(line => line.trim());

                        for (const line of lines) {
                            try {
                                const data = JSON.parse(line);
                                if (typeof data.prompt_eval_count === 'number') promptEvalCount = data.prompt_eval_count
                                if (typeof data.eval_count === 'number') evalCount = data.eval_count
                                if (data.message?.content) {
                                    const content = data.message.content;
                                    fullContent += content;
                                    options.onStream(content);
                                }
                                // 工具调用（function calling）
                                if (data.message?.tool_calls && data.message.tool_calls.length > 0) {
                                    for (const tc of data.message.tool_calls) {
                                        if (tc.function?.name && !toolCallsAcc.some(t => t.function?.name === tc.function.name)) {
                                            toolCallsAcc.push({
                                                id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                                                type: 'function',
                                                function: { name: tc.function.name, arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments ?? '') }
                                            });
                                            // 参数整段回传（Ollama 非增量，一次给出）；arguments 可能是对象，规范化为字符串避免 UI 显示 [object Object]
                                            options?.onToolCallArgs?.(toolCallsAcc[toolCallsAcc.length - 1].id, tc.function.name, typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments ?? ''))
                                        }
                                    }
                                }
                            } catch (e) {
                                console.warn('解析JSON失败:', line, e);
                            }
                        }
                    }

                    if (toolCallsAcc.length > 0) options?.onToolCalls?.(toolCallsAcc);
                    options?.onComplete?.(fullContent, (promptEvalCount || evalCount) ? { prompt_tokens: promptEvalCount || 0, completion_tokens: evalCount || 0 } : undefined);
                    return fullContent;

                } catch (error: any) {
                    // 如果是中止错误，不调用 onError
                    if (error.name === 'AbortError') {
                        console.log('请求被用户中止');
                        return '';
                    }
                    throw error;
                }

            } else {
                // 非流式响应 - 使用 fetch 并支持中止
                try {
                    const controller = new AbortController();

                    if (options?.signal) {
                        options.signal.addEventListener('abort', () => {
                            controller.abort();
                        });
                    }

                    const ollamaApiUrl = resolveApiUrl(`${ollamaConfig.model_url}/api/chat`)
                    const response = await fetch(ollamaApiUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            ...requestParams,
                            stream: false
                        }),
                        signal: controller.signal
                    });

                    if (!response.ok) {
                        throw new Error(`HTTP error! status: ${response.status}`);
                    }

                    const data = await response.json();
                    const content = data.message?.content || '';
                    // 工具调用（非流式 function calling，Ollama 返回 message.tool_calls）
                    const toolCalls = data.message?.tool_calls || [];
                    if (toolCalls.length > 0) options?.onToolCalls?.(toolCalls);
                    const oPt = typeof data.prompt_eval_count === 'number' ? data.prompt_eval_count : 0
                    const oCt = typeof data.eval_count === 'number' ? data.eval_count : 0
                    options?.onComplete?.(content, (oPt || oCt) ? { prompt_tokens: oPt, completion_tokens: oCt } : undefined);
                    return content;

                } catch (error: any) {
                    if (error.name === 'AbortError') {
                        console.log('请求被用户中止');
                        return '';
                    }
                    throw error;
                }
            }

        } catch (error) {
            console.error('Ollama请求失败:', error);
            options?.onError?.(error as Error);
            throw error;
        }
    }

    // ==================== 图片入参归一化（各来源多模态接口共用） ====================
    //
    // home / 知识库上传与粘贴的图片有四种形态：裸 base64、data URL、Uint8Array、ArrayBuffer
    // （还有 { base64, mimeType } 这类包装）。以前的各分支直接拼 `data:image/jpeg;base64,${img}`，
    // data URL 会拼成 url 里嵌 data:，typed array 会变成 "[object Uint8Array]" → 图片静默丢失。
    // 统一在这里归一化，各 provider 分支只调这两个方法。

    /** Uint8Array → base64（分块转换，避免 String.fromCharCode 参数过多爆栈） */
    static bytesToBase64(bytes: Uint8Array): string {
        let binary = ''
        const chunk = 0x8000
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as any)
        }
        return btoa(binary)
    }

    /** 图片入参 → { mime, base64 }（无法识别时 base64 为空串） */
    static normalizeImage(img: any): { mime: string; base64: string } {
        try {
            if (typeof img === 'string') {
                const s = img.trim()
                const m = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/is.exec(s)
                if (m) return { mime: m[1] || 'image/jpeg', base64: (m[2] || '').replace(/\s+/g, '') }
                return { mime: 'image/jpeg', base64: s.replace(/\s+/g, '') }
            }
            if (img && typeof img === 'object') {
                const o: any = img
                if (typeof o.base64 === 'string') return { mime: o.mimeType || o.mime || 'image/jpeg', base64: o.base64 }
                if (typeof o.data === 'string') return { mime: o.mimeType || o.mime || 'image/jpeg', base64: o.data.replace(/^data:[^,]*,/, '') }
                let bytes: Uint8Array | null = null
                if (img instanceof Uint8Array) bytes = img
                else if (img instanceof ArrayBuffer) bytes = new Uint8Array(img)
                else if (ArrayBuffer.isView(img)) bytes = new Uint8Array(o.buffer, o.byteOffset, o.byteLength)
                if (bytes) return { mime: o.type || 'image/jpeg', base64: AIUtils.bytesToBase64(bytes) }
                if (typeof o.arrayBuffer === 'function') console.warn('Blob 图片需先转 base64/ArrayBuffer 再传入');
            }
        } catch (e) {
            console.warn('图片归一化失败:', e)
        }
        return { mime: 'image/jpeg', base64: '' }
    }

    /** 图片入参 → data URL（保留原始 mime，缺省 image/jpeg；无法识别时返回空串） */
    static imageDataUrl(img: any, fallbackMime = 'image/jpeg'): string {
        const { mime, base64 } = AIUtils.normalizeImage(img)
        if (!base64) return ''
        return `data:${mime || fallbackMime};base64,${base64}`
    }

    /** 图片入参 → 纯 base64（Ollama 这类只要 base64 的接口用） */
    static imageBase64(img: any): string {
        return AIUtils.normalizeImage(img).base64
    }

    // 辅助函数：将图片转换为base64格式
    static async imageToBase64(imageFile: File): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                // 移除data URL前缀（如"data:image/jpeg;base64,"）
                const base64String = (reader.result as string).split(',')[1];
                resolve(base64String);
            };
            reader.onerror = reject;
            reader.readAsDataURL(imageFile);
        });
    }

    // 辅助函数：将图片URL转换为base64格式
    static async imageUrlToBase64(imageUrl: string): Promise<string> {
        try {
            const response = await fetch(imageUrl);
            const blob = await response.blob();
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => {
                    const base64String = (reader.result as string).split(',')[1];
                    resolve(base64String);
                };
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        } catch (error) {
            console.error('图片URL转换失败:', error);
            throw error;
        }
    }

    // 辅助函数：创建包含图片的消息
    static createImageMessage(role: string, content: string, images: Array<string | Uint8Array> = []): AIMessage {
        return {
            role,
            content,
            images
        };
    }

    // OpenAI 兼容消息转换（纯文本 + 图片块 + tool_calls/tool_call_id），
    // 供 buildOpenAIRequest / LM Studio / Azure 等所有 OpenAI 兼容分支复用，避免各写一份图片处理。
    static toOpenAIMessages(messages: any[]) {
        return (messages || []).map(message => {
            const formattedMessage: any = {
                role: message.role,
                content: []
            };

            // 添加文本内容
            if (message.content) {
                formattedMessage.content.push({
                    type: "text",
                    text: message.content
                });
            }

            // 添加图片内容（base64 / data URL / Uint8Array 均由 imageDataUrl 归一化）
            if (message.images && message.images.length > 0) {
                for (const image of message.images) {
                    const url = AIUtils.imageDataUrl(image)
                    if (!url) continue
                    formattedMessage.content.push({
                        type: "image_url",
                        image_url: { url }
                    })
                }
            }

            // 工具调用（assistant 消息，function calling 结果回传）
            if (message.tool_calls && message.tool_calls.length > 0) {
                formattedMessage.tool_calls = message.tool_calls;
            }
            // 工具执行结果（tool 角色，OpenAI 要求 content 为纯字符串 + tool_call_id）
            if (message.role === 'tool') {
                formattedMessage.content = typeof message.content === 'string'
                    ? message.content
                    : JSON.stringify(message.content || '');
                if (message.tool_call_id) formattedMessage.tool_call_id = message.tool_call_id;
            }

            return formattedMessage;
        });
    }

    // 构建OpenAI请求体
    static buildOpenAIRequest(openaiConfig: any, llmConfig: any, messages: any[]) {
        const formattedMessages = AIUtils.toOpenAIMessages(messages);

        const requestBody: any = {
            model: openaiConfig.model,
            messages: formattedMessages,
            stream: llmConfig.stream,
            temperature: llmConfig.temperature,
            max_tokens: llmConfig.max_tokens,
            top_p: llmConfig.top_p,
            frequency_penalty: llmConfig.frequency_penalty,
            presence_penalty: llmConfig.presence_penalty,
            response_format: { type: "text" },
            stop: null,
            stream_options: llmConfig.stream ? { include_usage: true } : null,
        };
        // 推理强度（llmConfig.think：'none' 关闭 / low / medium / high / max，兼容旧布尔值）：
        // - DeepSeek 官方：thinking 开关 + 顶层 reasoning_effort（none/low/high/max）
        // - OpenAI / Azure 官方：仅开启时透传 reasoning_effort（o 系列 / GPT-5 等支持；不支持的模型忽略）
        // - 其它 OpenAI 兼容后端（GPUStack、本地 vLLM 等）：用 chat_template_kwargs.enable_thinking 控制 <think>
        const reasoning = normalizeReasoning(llmConfig?.think)
        const cfgUrl = String(openaiConfig?.api_url || openaiConfig?.base_url || '').toLowerCase()
        const isDeepSeekOfficial = cfgUrl.includes('deepseek.com')
        const isCloudOfficial = isDeepSeekOfficial || cfgUrl.includes('api.openai.com') ||
            cfgUrl.includes('azure.com') || cfgUrl.includes('azurefd.net') || cfgUrl.includes('azure.cn')
        if (isDeepSeekOfficial) {
            requestBody.thinking = { type: reasoning.enabled ? 'enabled' : 'disabled' }
            if (reasoning.enabled) requestBody.reasoning_effort = deepseekEffort(reasoning.effort)
        } else if (reasoning.enabled) {
            requestBody.reasoning_effort = reasoning.effort
        }
        if (!isCloudOfficial) requestBody.chat_template_kwargs = { enable_thinking: reasoning.enabled }
        return requestBody;
    }

    // 通用的API请求函数
    static async makeAPIRequest(endpoint: string, body: any, headers: Record<string, string>, options?: any) {
        // 浏览器环境走代理
        endpoint = resolveApiUrl(endpoint)
        const stream = body.stream && !!options?.onStream;
        // 没有 onStream 回调时强制非流式，防止 API 返回 SSE 数据但无解析器处理
        if (body.stream && !stream) {
            body.stream = false;
            body.stream_options = null;
        }

        // 检测 API 类型
        const isDeepSeek = endpoint.includes('deepseek.com');
        const isOpenAI = endpoint.includes('openai.com') || endpoint.includes('api.openai.com');
        const isOllama = endpoint.includes('localhost') || endpoint.includes('127.0.0.1');
        // 工具调用支持（阶段D）：options.tools 注入请求体（OpenAI 兼容 function calling）
        if (options?.tools && Array.isArray(options.tools) && options.tools.length > 0) {
            body.tools = options.tools;
            body.tool_choice = options?.toolChoice || 'auto';
        }
        if (stream) {
            // 流式响应 - 根据 API 类型选择不同的处理方式
            if (isDeepSeek) {
                // DeepSeek 使用 SSE 格式，但内容格式不同
                return await AIUtils.makeDeepSeekStreamingRequest(endpoint, body, headers, options);
            } else if (isOpenAI || isOllama) {
                // OpenAI 和 Ollama 使用标准的 SSE 格式
                return await AIUtils.makeStreamingRequest(endpoint, body, headers, options);
            } else {
                // 默认使用标准流式处理
                return await AIUtils.makeStreamingRequest(endpoint, body, headers, options);
            }
        } else {
            // 非流式响应
            return await AIUtils.makeStandardRequest(endpoint, body, headers, options);
        }
    }

    static async makeDeepSeekStreamingRequest(endpoint: string, body: any, headers: Record<string, string>, options?: any) {
        try {
            let finalUsage: any = null;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3600000); // 1小时超时

            // 支持外部 signal 中止
            const onAbort = () => controller.abort();
            if (options?.signal) {
                if (options.signal.aborted) controller.abort();
                else options.signal.addEventListener('abort', onAbort);
            }

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(body),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`HTTP错误! 状态码: ${response.status}`);
            }

            const reader = response.body?.getReader();
            if (!reader) {
                throw new Error('无法获取响应流');
            }

            const decoder = new TextDecoder('utf-8');
            let fullContent = '';
            let buffer = '';
            // 工具调用累积（function calling，按 index 拼接 arguments）
            const toolCallsAcc: any[] = [];

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                buffer += chunk;

                // 处理 SSE 格式的数据行
                const lines = buffer.split('\n');
                buffer = lines.pop() || ''; // 保留最后一个不完整的行

                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (!trimmedLine) continue;

                    // 处理 data: 前缀
                    if (trimmedLine.startsWith('data: ')) {
                        const data = trimmedLine.substring(6);

                        // 检查是否是结束标记
                        if (data === '[DONE]') continue;

                        try {
                            // 解析 JSON 数据
                            const parsed = JSON.parse(data);
                            if (parsed.usage) finalUsage = parsed.usage;

                            // 从 DeepSeek 的响应格式中提取内容
                            if (parsed.choices && parsed.choices[0]) {
                                const delta = parsed.choices[0].delta;
                                if (delta && delta.content) {
                                    const content = delta.content;
                                    fullContent += content;
                                    options?.onStream?.(content);
                                }
                                // 工具调用（function calling，按 index 累积 arguments）
                                if (delta && delta.tool_calls) {
                                    for (const tc of delta.tool_calls) {
                                        const idx = tc.index || 0;
                                        if (!toolCallsAcc[idx]) {
                                            toolCallsAcc[idx] = { id: tc.id || '', type: tc.type || 'function', function: { name: '', arguments: '' } };
                                        }
                                        if (tc.id) toolCallsAcc[idx].id = tc.id;
                                        if (tc.function?.name) toolCallsAcc[idx].function.name = tc.function.name;
                                        // 规范化参数片段为字符串（个别后端把 arguments 当对象返回，避免 += 出 [object Object]）
                                        const argsFrag = typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? '')
                                        if (argsFrag) toolCallsAcc[idx].function.arguments += argsFrag;
                                        // 参数增量回传（供 UI 流式展示代码）
                                        options?.onToolCallArgs?.(toolCallsAcc[idx].id, toolCallsAcc[idx].function.name, argsFrag)
                                    }
                                }
                            }
                        } catch (e) {
                            // 如果解析失败，记录错误但继续
                            console.warn('解析 DeepSeek 流式数据失败:', e, '原始数据:', data);
                        }
                    }
                }
            }

            if (options?.signal) options.signal.removeEventListener('abort', onAbort);

            const completedCalls = toolCallsAcc.filter(tc => tc && tc.function && tc.function.name);
            if (completedCalls.length > 0) options?.onToolCalls?.(completedCalls);
            options?.onComplete?.(fullContent, finalUsage ? { prompt_tokens: finalUsage.prompt_tokens || 0, completion_tokens: finalUsage.completion_tokens || 0 } : undefined);
            return fullContent;

        } catch (error) {
            console.error('DeepSeek流式请求失败:', error);
            options?.onError?.(error as Error);
            throw error;
        }
    }

    // ==================== DeepSeek Responses API（OpenAI Responses 格式；function 工具 + reasoning.effort） ====================

    // 构建DeepSeek Responses API请求体（messages → input items + function 工具 + 推理强度）
    static buildDeepSeekResponsesRequest(responsesConfig: any, llmConfig: any, messages: any[], options?: any) {
        let instructions = '';
        const input: any[] = [];

        for (const message of messages) {
            // system 消息 → instructions
            if (message.role === 'system') {
                const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content || '');
                instructions += (instructions ? '\n' : '') + text;
                continue;
            }
            // 工具调用 → function_call item
            if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
                message.tool_calls.forEach((tc: any) => {
                    input.push({
                        type: 'function_call',
                        call_id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                        name: tc.function?.name || tc.name || '',
                        arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {})
                    });
                });
                continue;
            }
            // 工具执行结果 → function_call_output item
            // （agent-loop 的 OpenAI 格式消息：tool 消息带 tool_call_id；兼容旧 ai-service 的 tool_name 字段）
            if (message.role === 'tool' && (message.tool_call_id || message.tool_name)) {
                input.push({
                    type: 'function_call_output',
                    call_id: message.tool_call_id || message.tool_name,
                    output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content || '')
                });
                continue;
            }
            // 普通消息：支持图片输入（Responses API 用 input_image 块，image_url 放 base64 data URL）
            // 注意：图片只能出现在 user / developer 消息里，assistant 带图会 400
            // （见 DeepSeek 图像理解文档 https://api-docs.deepseek.com/zh-cn/guides/vision ）
            const text = typeof message.content === 'string' ? message.content : '';
            const content: any[] = [
                { type: 'input_text', text: text }
            ];
            if (message.role !== 'assistant' && message.images && message.images.length > 0) {
                for (const img of message.images) {
                    const url = AIUtils.imageDataUrl(img);
                    if (!url) continue;
                    content.push({ type: 'input_image', image_url: url });
                }
            }
            input.push({
                type: 'message',
                role: message.role === 'assistant' ? 'assistant' : 'user',
                content
            });
        }

        // 注意：DeepSeek Responses API 已不再支持内置 web_search（服务端联网搜索）——
        // 官方兼容表明确「web_search / file_search / code_interpreter 等内置工具一律忽略」，
        // 因此这里只注入调用方显式传入的 function 工具（联网搜索改由本地 web_search 工具承担）。
        const tools: any[] = [];
        // 原生 function calling：注入自定义函数工具（OpenAI tools 格式 → Responses function 格式）
        if (options?.tools && Array.isArray(options.tools)) {
            for (const t of options.tools) {
                if (t?.type === 'function' && t.function?.name) {
                    tools.push({
                        type: 'function',
                        name: t.function.name,
                        description: t.function.description || '',
                        parameters: t.function.parameters || { type: 'object', properties: {} },
                        strict: false
                    });
                }
            }
        }

        const body: any = {
            model: responsesConfig.model || 'deepseek-flash',
            input: input.length > 0 ? input : 'Hello',
            stream: llmConfig.stream,
            max_output_tokens: llmConfig.max_tokens,
            temperature: llmConfig.temperature,
            top_p: llmConfig.top_p,
        };
        // 推理强度：Responses API 用顶层 reasoning.effort（none = 关闭思考；官方默认开启且为 high）
        {
            const reasoning = normalizeReasoning(llmConfig?.think)
            body.reasoning = { effort: reasoning.enabled ? deepseekEffort(reasoning.effort) : 'none' }
        }
        if (instructions) {
            body.instructions = instructions;
        }
        if (tools.length > 0) {
            body.tools = tools;
            body.tool_choice = options?.toolChoice || 'auto';
        }

        return body;
    }

    // DeepSeek Responses API 请求执行入口（兼容流式/非流式，透传联网搜索状态）
    static async makeDeepSeekResponsesRequest(endpoint: string, body: any, headers: Record<string, string>, options?: any) {
        endpoint = resolveApiUrl(endpoint)
        const stream = body.stream && !!options?.onStream;
        if (body.stream && !stream) {
            body.stream = false;
        }

        // 流式：直接解析事件流。DeepSeek Responses API 是「无状态 API」——
        // previous_response_id / conversation / store / stream_options 均不支持（静默忽略），
        // 因此不存在「续接轮」：多轮上下文由调用方在 input 中回传完整历史实现。
        if (stream) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3600000);
            const onAbort = () => controller.abort();
            if (options?.signal) {
                if (options.signal.aborted) controller.abort();
                else options.signal.addEventListener('abort', onAbort);
            }
            try {
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify(body),
                    signal: controller.signal
                });
                if (!response.ok) {
                    let detail = '';
                    try {
                        const errData = await response.json();
                        detail = JSON.stringify(errData);
                    } catch (e) { /* ignore */ }
                    throw new Error(`HTTP错误! 状态码: ${response.status}${detail ? ' ' + detail : ''}`);
                }
                const result: any = await AIUtils.parseDeepSeekResponsesStream(response, options);
                clearTimeout(timeoutId);
                if (options?.signal) options.signal.removeEventListener('abort', onAbort);
                options?.onComplete?.(result.content, {
                    prompt_tokens: result.prompt_tokens || 0,
                    completion_tokens: result.completion_tokens || 0,
                    total_tokens: (result.prompt_tokens || 0) + (result.completion_tokens || 0)
                });
                return result.content;
            } catch (error: any) {
                clearTimeout(timeoutId);
                if (options?.signal) options.signal.removeEventListener('abort', onAbort);
                if (error?.name === 'AbortError') { console.log('请求被用户中止'); return ''; }
                console.error('DeepSeek Responses API请求失败:', error);
                options?.onError?.(error as Error);
                throw error;
            }
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3600000);
        if (options?.signal) {
            options.signal.addEventListener('abort', () => controller.abort());
        }

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(body),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
                let detail = '';
                try {
                    const errData = await response.json();
                    detail = JSON.stringify(errData);
                } catch (e) { /* ignore */ }
                throw new Error(`HTTP错误! 状态码: ${response.status}${detail ? ' ' + detail : ''}`);
            }

            if (stream) {
                return await AIUtils.parseDeepSeekResponsesStream(response, options);
            }

            // 非流式：解析 response 对象
            const data = await response.json();
            const outputText = AIUtils.extractResponsesOutputText(data);
            // 非流式响应中的自定义函数工具调用（function_call 项）
            const fnCalls = AIUtils.extractResponsesFunctionCalls(data)
            if (fnCalls.length > 0) options?.onToolCalls?.(fnCalls);
            // 非流式响应中的联网搜索结果（web_search_call 项或 message 中的 url_citation 注解）
            const searchResults = AIUtils.extractWebSearchResults(data?.output, data?.output_text);
            if (searchResults.length > 0) {
                options?.onSearchStatus?.({ status: 'completed', results: searchResults });
            }
            const usage = data.usage || {};
            const promptTokens = usage.input_tokens || 0;
            const completionTokens = usage.output_tokens || 0;
            options?.onComplete?.(outputText, {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens
            });
            return outputText;
        } catch (error: any) {
            if (error.name === 'AbortError') {
                console.log('请求被用户中止');
                return '';
            }
            console.error('DeepSeek Responses API请求失败:', error);
            options?.onError?.(error as Error);
            throw error;
        }
    }

    // 从 Responses API 响应对象中提取输出文本
    static extractResponsesOutputText(data: any): string {
        if (typeof data?.output_text === 'string') {
            return data.output_text;
        }
        // 兜底：拼接 output 中 message 类型 item 的文本
        if (Array.isArray(data?.output)) {
            const parts: string[] = [];
            data.output.forEach((item: any) => {
                if (item?.content && Array.isArray(item.content)) {
                    item.content.forEach((c: any) => {
                        if (c?.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
                    });
                }
            });
            return parts.join('');
        }
        return '';
    }

    // 从 Responses API 非流式响应中提取自定义函数工具调用（function_call 项）
    static extractResponsesFunctionCalls(data: any): any[] {
        const calls: any[] = []
        if (Array.isArray(data?.output)) {
            data.output.forEach((item: any) => {
                if (item?.type === 'function_call' && item.name) {
                    calls.push({
                        id: item.call_id || item.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                        type: 'function',
                        function: {
                            name: item.name,
                            arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {})
                        }
                    })
                }
            })
        }
        return calls
    }

    // ==================== Anthropic 工具协议翻译（OpenAI function calling ↔ Anthropic tool_use） ====================

    // OpenAI tools → Anthropic tools
    static translateOpenAIToolsToAnthropic(tools: any[]): any[] {
        if (!Array.isArray(tools)) return []
        return tools
            .filter(t => t?.function?.name)
            .map(t => ({
                name: t.function.name,
                description: t.function.description || '',
                input_schema: t.function.parameters || { type: 'object', properties: {} }
            }))
    }

    // OpenAI messages → Anthropic messages（提取 system，tool 结果合并为 tool_result 块，连续同角色合并）
    static translateOpenAIMessagesToAnthropic(messages: any[]): { system: string; messages: any[] } {
        const systemParts: string[] = []
        const out: any[] = []
        const pushMessage = (role: string, contentBlocks: any[]) => {
            if (contentBlocks.length === 0) return
            const last = out[out.length - 1]
            if (last && last.role === role) {
                last.content.push(...contentBlocks)
            } else {
                out.push({ role, content: contentBlocks })
            }
        }
        for (const msg of messages) {
            if (msg.role === 'system') {
                const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '')
                if (text) systemParts.push(text)
                continue
            }
            if (msg.role === 'tool') {
                pushMessage('user', [{
                    type: 'tool_result',
                    tool_use_id: msg.tool_call_id || `call_${msg.tool_name || 'tool'}`,
                    content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '')
                }])
                continue
            }
            const contentBlocks: any[] = []
            if (msg.content) {
                contentBlocks.push({ type: 'text', text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '') })
            }
            if (msg.images && msg.images.length > 0) {
                for (const image of msg.images) {
                    const { mime, base64 } = AIUtils.normalizeImage(image)
                    if (!base64) continue
                    contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: mime || 'image/jpeg', data: base64 } })
                }
            }
            if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
                for (const tc of msg.tool_calls) {
                    contentBlocks.push({
                        type: 'tool_use',
                        id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                        name: tc.function?.name || tc.name || '',
                        input: typeof tc.function?.arguments === 'string'
                            ? (() => { try { return JSON.parse(tc.function.arguments) } catch { return {} } })()
                            : (tc.function?.arguments || {})
                    })
                }
            }
            pushMessage(msg.role === 'assistant' ? 'assistant' : 'user', contentBlocks)
        }
        return { system: systemParts.join('\n\n'), messages: out }
    }

    // 解析 Anthropic 非流式响应 → { content, toolCalls }
    static parseAnthropicResponse(data: any): { content: string; toolCalls: any[] } {
        let content = ''
        const toolCalls: any[] = []
        const blocks = Array.isArray(data?.content) ? data.content : []
        for (const block of blocks) {
            if (block.type === 'text' && typeof block.text === 'string') content += block.text
            else if (block.type === 'tool_use') {
                toolCalls.push({
                    id: block.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    type: 'function',
                    function: {
                        name: block.name || '',
                        arguments: typeof block.input === 'object' ? JSON.stringify(block.input || {}) : String(block.input || '{}')
                    }
                })
            }
        }
        return { content, toolCalls }
    }

    // Anthropic 请求（流式 SSE 事件 / 非流式），解析 tool_use → onToolCalls
    static async makeAnthropicRequest(endpoint: string, body: any, headers: Record<string, string>, options?: any) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3600000);
        const onAbort = () => controller.abort();
        if (options?.signal) {
            if (options.signal.aborted) controller.abort();
            else options.signal.addEventListener('abort', onAbort);
        }
        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(body),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (!response.ok) {
                let detail = '';
                try { const errData = await response.json(); detail = JSON.stringify(errData); } catch (e) { /* ignore */ }
                throw new Error(`Anthropic API错误: ${response.status}${detail ? ' ' + detail : ''}`);
            }
            if (body.stream && options?.onStream) {
                return await AIUtils.parseAnthropicStream(response, options);
            }
            const data = await response.json();
            const { content, toolCalls } = AIUtils.parseAnthropicResponse(data);
            if (toolCalls.length > 0) options?.onToolCalls?.(toolCalls);
            options?.onComplete?.(content);
            return content;
        } catch (error: any) {
            clearTimeout(timeoutId);
            if (options?.signal) options.signal.removeEventListener('abort', onAbort);
            if (error.name === 'AbortError') { console.log('请求被用户中止'); return ''; }
            console.error('Anthropic请求失败:', error);
            options?.onError?.(error as Error);
            throw error;
        }
    }

    // 解析 Anthropic 流式事件（event: + data:），累积 text 与 tool_use
    static async parseAnthropicStream(response: Response, options?: any) {
        const reader = response.body?.getReader();
        if (!reader) throw new Error('无法获取响应流');
        const decoder = new TextDecoder('utf-8');
        let fullContent = '';
        let buffer = '';
        // 按 index 累积 content block：tool_use 的 id/name 在 content_block_start，input 由 input_json_delta 累积
        const blocks = new Map<number, any>();
        const toolCalls: any[] = [];
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                if (trimmed.startsWith('event:')) continue; // 事件类型行，实际载荷在随后的 data: 行
                if (!trimmed.startsWith('data:')) continue;
                const payload = trimmed.substring(5).trim();
                if (!payload) continue;
                let ev: any;
                try { ev = JSON.parse(payload); } catch (e) { continue; }
                switch (ev.type) {
                    case 'content_block_start': {
                        const idx = ev.index || 0;
                        blocks.set(idx, { ...(ev.content_block || {}), inputJSON: '' });
                        const cb = ev.content_block || {}
                        if (cb.type === 'tool_use' && cb.id) {
                            options?.onToolCallArgs?.(cb.id, cb.name || '', '')
                        }
                        break;
                    }
                    case 'content_block_delta': {
                        const idx = ev.index || 0;
                        const block = blocks.get(idx);
                        if (!block) break;
                        const delta = ev.delta || {};
                        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
                            fullContent += delta.text;
                            options?.onStream?.(delta.text);
                        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
                            block.inputJSON += delta.partial_json;
                            options?.onToolCallArgs?.(block.id || '', block.name || '', delta.partial_json)
                        }
                        break;
                    }
                    case 'content_block_stop': {
                        const idx = ev.index || 0;
                        const block = blocks.get(idx);
                        if (block && block.type === 'tool_use') {
                            let input: any = {};
                            try { input = block.inputJSON ? JSON.parse(block.inputJSON) : (block.input || {}); } catch (e) { input = block.input || {}; }
                            toolCalls.push({
                                id: block.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                                type: 'function',
                                function: { name: block.name || '', arguments: JSON.stringify(input || {}) }
                            });
                        }
                        break;
                    }
                }
            }
        }
        const completed = toolCalls.filter(tc => tc?.function?.name)
        if (completed.length > 0) options?.onToolCalls?.(completed)
        options?.onComplete?.(fullContent);
        return fullContent;
    }

    // ==================== Google Gemini 工具协议翻译（OpenAI function calling ↔ Gemini functionCall） ====================

    // OpenAI tools → Gemini tools（functionDeclarations）
    static translateOpenAIToolsToGoogle(tools: any[]): any[] {
        if (!Array.isArray(tools)) return []
        const declarations = tools
            .filter(t => t?.function?.name)
            .map(t => ({
                name: t.function.name,
                description: t.function.description || '',
                parameters: t.function.parameters || { type: 'object', properties: {} }
            }))
        return declarations.length > 0 ? [{ functionDeclarations: declarations }] : []
    }

    // OpenAI messages → Gemini contents（functionCall / functionResponse parts）
    static translateOpenAIMessagesToGoogle(messages: any[]): any[] {
        const contents: any[] = []
        for (const msg of messages) {
            const parts: any[] = []
            if (msg.role === 'system') {
                parts.push({ text: `[System]\n${typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '')}` })
            } else if (typeof msg.content === 'string' && msg.content) {
                parts.push({ text: msg.content })
            }
            if (msg.images && msg.images.length > 0) {
                for (const image of msg.images) {
                    const { mime, base64 } = AIUtils.normalizeImage(image)
                    if (!base64) continue
                    parts.push({ inline_data: { mime_type: mime || 'image/jpeg', data: base64 } })
                }
            }
            if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
                for (const tc of msg.tool_calls) {
                    parts.push({
                        functionCall: {
                            name: tc.function?.name || tc.name || '',
                            args: typeof tc.function?.arguments === 'string'
                                ? (() => { try { return JSON.parse(tc.function.arguments) } catch { return {} } })()
                                : (tc.function?.arguments || {})
                        }
                    })
                }
            }
            if (msg.role === 'tool') {
                parts.push({
                    functionResponse: {
                        name: msg.tool_name || '',
                        response: { name: msg.tool_name || '', content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '') }
                    }
                })
            }
            if (parts.length > 0) {
                contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts })
            }
        }
        return contents
    }

    // 解析 Gemini 响应 → { content, toolCalls }
    static parseGoogleResponse(data: any): { content: string; toolCalls: any[] } {
        let content = ''
        const toolCalls: any[] = []
        const parts = data?.candidates?.[0]?.content?.parts
        if (Array.isArray(parts)) {
            for (const part of parts) {
                if (typeof part.text === 'string') content += part.text
                else if (part.functionCall) {
                    toolCalls.push({
                        id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                        type: 'function',
                        function: {
                            name: part.functionCall.name || '',
                            arguments: JSON.stringify(part.functionCall.args || {})
                        }
                    })
                }
            }
        }
        return { content, toolCalls }
    }

    // Gemini 请求（流式 SSE / 非流式），解析 functionCall → onToolCalls
    static async makeGoogleRequest(endpoint: string, body: any, headers: Record<string, string>, options?: any) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3600000);
        const onAbort = () => controller.abort();
        if (options?.signal) {
            if (options.signal.aborted) controller.abort();
            else options.signal.addEventListener('abort', onAbort);
        }
        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(body),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (!response.ok) {
                let detail = '';
                try { const errData = await response.json(); detail = JSON.stringify(errData); } catch (e) { /* ignore */ }
                throw new Error(`Google API错误: ${response.status}${detail ? ' ' + detail : ''}`);
            }
            if (body.stream && options?.onStream) {
                return await AIUtils.parseGoogleStream(response, options);
            }
            const data = await response.json();
            const { content, toolCalls } = AIUtils.parseGoogleResponse(data);
            if (toolCalls.length > 0) options?.onToolCalls?.(toolCalls);
            options?.onComplete?.(content);
            return content;
        } catch (error: any) {
            clearTimeout(timeoutId);
            if (options?.signal) options.signal.removeEventListener('abort', onAbort);
            if (error.name === 'AbortError') { console.log('请求被用户中止'); return ''; }
            console.error('Google请求失败:', error);
            options?.onError?.(error as Error);
            throw error;
        }
    }

    // 解析 Gemini 流式响应（SSE data: JSON，parts 含 functionCall）
    static async parseGoogleStream(response: Response, options?: any) {
        const reader = response.body?.getReader();
        if (!reader) throw new Error('无法获取响应流');
        const decoder = new TextDecoder('utf-8');
        let fullContent = '';
        let buffer = '';
        const toolCalls: any[] = [];
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data:')) continue;
                const payload = trimmed.substring(5).trim();
                if (!payload || payload === '[DONE]') continue;
                let data: any;
                try { data = JSON.parse(payload); } catch (e) { continue; }
                const parts = data?.candidates?.[0]?.content?.parts
                if (!Array.isArray(parts)) continue
                for (const part of parts) {
                    if (typeof part.text === 'string' && part.text) {
                        fullContent += part.text
                        options?.onStream?.(part.text)
                    } else if (part.functionCall) {
                        const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
                        toolCalls.push({
                            id: callId,
                            type: 'function',
                            function: {
                                name: part.functionCall.name || '',
                                arguments: JSON.stringify(part.functionCall.args || {})
                            }
                        })
                        // 参数整段回传（Gemini functionCall 一次性给出，非增量）
                        options?.onToolCallArgs?.(callId, part.functionCall.name || '', JSON.stringify(part.functionCall.args || {}))
                    }
                }
            }
        }
        if (toolCalls.length > 0) options?.onToolCalls?.(toolCalls)
        options?.onComplete?.(fullContent)
        return fullContent
    }

    // 清洗提取出的 URL，去掉误并入的尾随字符（如 markdown 粗体 **、标点等）
    static sanitizeUrl(raw: string | undefined): string {
        if (!raw) return '';
        let url = raw.trim();
        // 去掉尾部的 markdown 标记与常见标点
        url = url.replace(/[*_~`]+$/g, '');
        url = url.replace(/[.,;:!?]+$/g, '');
        return url;
    }

    // 从文本中提取 URL 链接（markdown 链接 + 裸 URL），作为联网搜索佐证的兜底来源
    static extractUrlsFromText(text: string | undefined): Array<{ title?: string; url?: string }> {
        const results: Array<{ title?: string; url?: string }> = [];
        if (!text) return results;

        // markdown 链接 [title](url)
        const mdRe = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
        let m: RegExpExecArray | null;
        while ((m = mdRe.exec(text)) !== null) {
            const url = AIUtils.sanitizeUrl(m[2]);
            if (url) results.push({ title: m[1] || url, url });
        }

        // 裸 URL（未被 markdown 链接捕获的，排除 * 避免把粗体标记并入）
        const bareRe = /https?:\/\/[^\s"'<>()\[\]*]+/g;
        while ((m = bareRe.exec(text)) !== null) {
            const url = AIUtils.sanitizeUrl(m[0]);
            if (url && !results.some(r => r.url === url)) {
                results.push({ title: url, url });
            }
        }

        return results;
    }

    // 从 web_search_call 输出项（或搜索完成事件对象）中提取来源列表（标题 + 链接）
    // - DeepSeek：结果在 item.action.sources（web_search_result 项：title / url / text / encrypted_content）
    // - OpenAI 兼容：部分实现直接附带 results 数组（{title, url}）
    // - open_page 动作：访问的网页本身也是一条来源
    static extractWebSearchSources(item: any): Array<{ title?: string; url?: string }> {
        const out: Array<{ title?: string; url?: string }> = [];
        if (!item || typeof item !== 'object') return out;
        const isSearchItem = item?.type === 'web_search_call'
            || String(item?.type || '').includes('web_search_call')
            || Array.isArray(item?.results)
            || Array.isArray(item?.action?.sources);
        if (!isSearchItem) return out;
        const sources: any[] = Array.isArray(item?.action?.sources)
            ? item.action.sources
            : Array.isArray(item?.results)
                ? item.results
                : [];
        for (const r of sources) {
            if (!r || typeof r !== 'object') continue;
            // 去掉 DeepSeek 注入的会话噪声片段（#ws_call_id=xxx），仅保留干净链接
            const url = AIUtils.sanitizeUrl(r?.url || r?.link).replace(/#ws_call_id=[^#]*$/i, '');
            const title = String(r?.title || r?.name || '').trim();
            if (url) {
                out.push({ title: title || url, url });
            } else if (title) {
                out.push({ title, url: '' });
            } else if (typeof r?.text === 'string' && r.text.trim()) {
                out.push({ title: r.text.trim().slice(0, 80), url: '' });
            }
        }
        // open_page 动作：访问的网页本身也是一条来源
        if (item?.action?.type === 'open_page' && item.action.url) {
            const url = AIUtils.sanitizeUrl(item.action.url).replace(/#ws_call_id=[^#]*$/i, '');
            if (url && !out.some(o => o.url === url)) out.push({ title: url, url });
        }
        return out;
    }

    // 从 Responses API 的 output items 中提取联网搜索结果
    // 优先级：url_citation 注解 / web_search_call（DeepSeek action.sources、OpenAI results）
    // → message 文本中的 markdown 链接 → output_text 中的链接
    static extractWebSearchResults(output: any[] | undefined, outputText?: string): Array<{ title?: string; url?: string }> {
        const results: Array<{ title?: string; url?: string }> = [];
        if (Array.isArray(output)) {
            for (const item of output) {
                // web_search_call 项（DeepSeek action.sources / OpenAI results / open_page）
                results.push(...AIUtils.extractWebSearchSources(item));
                // message 项：content 中的 url_citation 注解（OpenAI 兼容格式）
                if (item?.type === 'message' && Array.isArray(item.content)) {
                    item.content.forEach((c: any) => {
                        if (c?.type === 'output_text' && Array.isArray(c.annotations)) {
                            c.annotations.forEach((a: any) => {
                                if (a?.type === 'url_citation' && a?.url) {
                                    const url = AIUtils.sanitizeUrl(a.url);
                                    if (url) results.push({ title: a?.title || url, url });
                                }
                            });
                        }
                    });
                }
            }

            // 兜底：没有结构化注解时，从 message 内容文本中解析链接
            if (results.length === 0) {
                for (const item of output) {
                    if (item?.type === 'message' && Array.isArray(item.content)) {
                        item.content.forEach((c: any) => {
                            if (c?.type === 'output_text' && typeof c.text === 'string') {
                                results.push(...AIUtils.extractUrlsFromText(c.text));
                            }
                        });
                    }
                }
            }
        }

        // 兜底：仍为空时，从整个 output_text 解析
        if (results.length === 0 && outputText) {
            results.push(...AIUtils.extractUrlsFromText(outputText));
        }

        // 按 url 去重（无 url 的按标题去重），并丢弃空条目
        const seenUrl = new Set<string>();
        const seenTitle = new Set<string>();
        return results.filter(r => {
            if (r?.url) {
                if (seenUrl.has(r.url)) return false;
                seenUrl.add(r.url);
            } else {
                const key = String(r?.title || '').trim();
                if (!key) return false;
                if (seenTitle.has(key)) return false;
                seenTitle.add(key);
            }
            return true;
        });
    }

    // 清理搜索动作数据：过滤服务端混入查询列表的噪声字段（如 ws_call_id=xxx，非真实查询词）
    static cleanSearchAction(action: any) {
        if (!action || typeof action !== 'object') return action
        const a: any = { ...action }
        if (Array.isArray(a.queries)) {
            a.queries = a.queries.filter((q: any) => !/^ws_call_id\s*=/.test(String(q).trim()))
        }
        return a
    }

    // 解析 DeepSeek Responses API 事件流（reasoning_text / output_text / function_call / 兼容旧 web_search_call 事件）
    static async parseDeepSeekResponsesStream(response: Response, options?: any) {
        const reader = response.body?.getReader();
        if (!reader) throw new Error('无法获取响应流');

        const decoder = new TextDecoder('utf-8');
        let fullContent = '';
        let reasoning = ''; // 思维链文本（reasoning_text.delta 累积）
        let buffer = '';
        // 本轮内去重：同一搜索项可能被 output_item.done 与 completed 补发重复回调，用 itemId 过滤
        const seenStepIds = new Set<string>();
        let finalUsage: any = null;
        let lastResponseId: string | null = null;
        let needsContinuation = false;
        // 自定义函数工具调用收集（Responses API function_call item，按 call_id 累积参数）
        const toolCallsAcc = new Map<string, { id: string; name: string; args: string }>();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data:')) continue;
                const payload = trimmed.substring(5).trim();
                if (!payload || payload === '[DONE]') continue;

                let event: any;
                try {
                    event = JSON.parse(payload);
                } catch (e) {
                    continue;
                }

                switch (event.type) {
                    case 'response.reasoning_text.delta':
                        // 思维链增量：累积并通过 onReasoning 回调（用于「执行过程」展示思考过程）
                        if (typeof event.delta === 'string' && event.delta) {
                            reasoning += event.delta;
                            options?.onReasoning?.(reasoning);
                        }
                        break;
                    case 'response.reasoning_text.done':
                        {
                            const text = (typeof event.reasoning_text === 'string' && event.reasoning_text)
                                ? event.reasoning_text
                                : (typeof event.text === 'string' ? event.text : '')
                            if (text && !reasoning) reasoning = text
                            options?.onReasoning?.(reasoning)
                        }
                        break;
                    case 'response.output_text.delta':
                        if (typeof event.delta === 'string' && event.delta) {
                            fullContent += event.delta;
                            options?.onStream?.(event.delta);
                        }
                        break;
                    case 'response.web_search_call.in_progress':
                        console.log('[DeepSeekResponses] 开始联网搜索, 事件:', JSON.stringify(event))
                        options?.onSearchStatus?.({ status: 'searching', query: event.query });
                        break;
                    case 'response.web_search_call.searching':
                        options?.onSearchStatus?.({ status: 'searching', query: event.query });
                        break;
                    case 'response.web_search_call.completed':
                        // DeepSeek 文档事件：服务端联网搜索完成；部分实现直接在事件上携带结果
                        // （event.results / event.action.sources / event.item），提取到则立即上报，否则仅标记完成
                        {
                            const evItem: any = (event?.item && typeof event.item === 'object') ? event.item : event;
                            const evResults = AIUtils.extractWebSearchSources(evItem);
                            if (evResults.length > 0) {
                                options?.onSearchStatus?.({ status: 'completed', results: evResults });
                            } else {
                                options?.onSearchStatus?.({ status: 'completed', query: event?.query });
                            }
                        }
                        break;
                    case 'response.output_item.added': {
                        const item = event.item
                        if (item && item.type === 'function_call' && (item.call_id || item.id)) {
                            const cid = item.call_id || item.id
                            const cur = toolCallsAcc.get(cid) || { id: cid, name: '', args: '' }
                            cur.name = cur.name || item.name || ''
                            toolCallsAcc.set(cid, cur)
                        }
                        break
                    }
                    case 'response.function_call_arguments.delta': {
                        const callId = event.call_id || ''
                        const cur = toolCallsAcc.get(callId) || { id: callId, name: '', args: '' }
                        cur.args += (event.delta || '')
                        toolCallsAcc.set(callId, cur)
                        // 参数增量回传（供 UI 流式展示代码）
                        options?.onToolCallArgs?.(callId, cur.name, event.delta || '')
                        break
                    }
                    case 'response.function_call_arguments.done': {
                        const callId = event.call_id || ''
                        const cur = toolCallsAcc.get(callId) || { id: callId, name: event.name || '', args: '' }
                        cur.name = cur.name || event.name || ''
                        if (typeof event.arguments === 'string') cur.args = event.arguments
                        toolCallsAcc.set(callId, cur)
                        break
                    }
                    case 'response.output_item.done': {
                        // 搜索调用项、函数调用项或最终消息完成时，提取其中的引用链接/结果
                        const item = event.item
                        // 自定义函数调用（function_call item）→ 收集并最终经 onToolCalls 回传
                        if (item && item.type === 'function_call') {
                            const cur = toolCallsAcc.get(item.call_id || item.id || '') || { id: item.call_id || item.id || '', name: '', args: '' }
                            cur.name = cur.name || item.name || ''
                            if (typeof item.arguments === 'string') cur.args = item.arguments
                            toolCallsAcc.set(cur.id, cur)
                        }
                        if (item && (item.type === 'web_search_call' || item.type === 'message')) {
                            if (item.type === 'web_search_call') {
                                console.log('[DeepSeekResponses] web_search_call item:', JSON.stringify(item).slice(0, 1500))
                                // 每个搜索动作单独回调一次：search（查询词）或 open_page（访问的链接）
                                // 去重：同轮内 completed 补发会重复；key 优先用 itemId，缺失时退化为 action 内容指纹
                                const stepKey = item.id || JSON.stringify(AIUtils.cleanSearchAction(item.action))
                                if (stepKey && seenStepIds.has(stepKey)) {
                                    // 已回调过，跳过（仍继续提取 results，不影响参考来源）
                                } else {
                                    if (stepKey) seenStepIds.add(stepKey)
                                    options?.onSearchStatus?.({ status: 'step', action: AIUtils.cleanSearchAction(item.action), itemId: item.id });
                                }
                            }
                            const itemResults = AIUtils.extractWebSearchResults([item]);
                            if (itemResults.length > 0) {
                                options?.onSearchStatus?.({ status: 'completed', results: itemResults });
                            }
                        }
                        break;
                    }
                    case 'response.completed':
                    case 'response.incomplete':
                    case 'response.failed':
                        finalUsage = event.response?.usage || null;
                        {
                            const resp = event.response || {}
                            // 记录续接信息：联网搜索是异步多轮过程，响应中可能只有 web_search_call 而无正文，
                            // 需要用 previous_response_id 发起第二次请求，模型才能基于搜索结果生成文本
                            lastResponseId = resp.id || null
                            const hasSearchCall = Array.isArray(resp.output) && resp.output.some((it: any) => it?.type === 'web_search_call')
                            const incomplete = resp.status === 'incomplete' || !!resp.incomplete_details
                            needsContinuation = !!lastResponseId && (incomplete || (hasSearchCall && fullContent.length === 0))
                            // 诊断：确认响应对象结构与 output 是否存在
                            console.log('[DeepSeekResponses] completed, keys:', Object.keys(resp), 'output:', Array.isArray(resp.output) ? `array(${resp.output.length})` : typeof resp.output)
                            // 诊断：输出 output items 的结构概览（定位结果/链接所在字段）
                            if (Array.isArray(resp.output)) {
                                const outDump = resp.output.map((it: any) => {
                                    const s: any = { type: it.type, id: it.id, status: it.status, keys: Object.keys(it || {}) }
                                    if (it.action) s.action = it.action
                                    if (Array.isArray(it.content)) s.content = it.content.map((c: any) => ({ type: c.type, keys: Object.keys(c || {}) }))
                                    if (Array.isArray(it.results)) s.resultsCount = it.results.length
                                    return s
                                })
                                console.log('[DeepSeekResponses] output items:', JSON.stringify(outDump))
                            }
                            // 从最终响应补发每个搜索动作（应对 output_item.done 事件缺失导致步骤未显示）
                            // 去重：同一搜索项若已被 output_item.done 回调过则跳过，避免步骤重复展示
                            if (Array.isArray(resp.output)) {
                                resp.output.forEach((it: any) => {
                                    if (it?.type === 'web_search_call') {
                                        const stepKey = it.id || JSON.stringify(AIUtils.cleanSearchAction(it.action))
                                        if (stepKey && seenStepIds.has(stepKey)) return
                                        if (stepKey) seenStepIds.add(stepKey)
                                        options?.onSearchStatus?.({ status: 'step', action: AIUtils.cleanSearchAction(it.action), itemId: it.id });
                                    }
                                    // 兜底：补发 function_call 项（应对流式事件缺失导致工具调用未收集）
                                    if (it?.type === 'function_call' && (it.name || it.arguments)) {
                                        toolCallsAcc.set(it.call_id || it.id || '', {
                                            id: it.call_id || it.id || '',
                                            name: it.name || '',
                                            args: typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments || {})
                                        })
                                    }
                                });
                            }
                            // 注意：DeepSeek 流式 completed 事件的 response 往往不含 output_text/output，
                            // 因此用流式累积的 fullContent（真实回答全文）作为文本兜底提取链接
                            const finalResults = AIUtils.extractWebSearchResults(resp.output, fullContent || resp.output_text);
                            console.log('[DeepSeekResponses] 联网搜索完成，提取到', finalResults.length, '条链接; 回答开头:', fullContent.slice(0, 120))
                            options?.onSearchStatus?.({ status: 'completed', final: true, results: finalResults });
                        }
                        // 兜底：事件内可能附带完整输出文本
                        if (event.response && typeof event.response.output_text === 'string' && !fullContent) {
                            fullContent = event.response.output_text;
                            options?.onStream?.(fullContent);
                        }
                        break;
                }
            }
        }

        const usage = finalUsage || {};
        const promptTokens = usage.input_tokens || 0;
        const completionTokens = usage.output_tokens || 0;
        // 自定义函数工具调用（function_call）→ onToolCalls（在 onComplete 之前回传，供外层 ReAct 循环执行）
        const completedFunctionCalls = Array.from(toolCallsAcc.values())
            .filter(c => c.id && c.name)
            .map(c => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: c.args || '{}' }
            }))
        if (completedFunctionCalls.length > 0) options?.onToolCalls?.(completedFunctionCalls)
        return {
            content: fullContent,
            responseId: lastResponseId,
            needsContinuation,
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
        };
    }

    // 标准请求（非流式）
    static async makeStandardRequest(endpoint: string, body: any, headers: Record<string, string>, options?: any) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3600000);
            const onAbort = () => controller.abort();
            if (options?.signal) {
                if (options.signal.aborted) controller.abort();
                else options.signal.addEventListener('abort', onAbort);
            }

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(body),
                signal: controller.signal
            });

            clearTimeout(timeoutId);
            if (options?.signal) options.signal.removeEventListener('abort', onAbort);

            if (!response.ok) {
                // 读取并透出服务端真实错误（如 GPUStack/vLLM 的上下文超限或网关校验信息），避免只有裸状态码
                let detail = ''
                try {
                    const text = await response.text()
                    if (text) {
                        try {
                            const j = JSON.parse(text)
                            detail = j?.error?.message || j?.message || text
                        } catch { detail = text }
                    }
                } catch { /* ignore */ }
                throw new Error(`HTTP错误! 状态码: ${response.status}${detail ? ' ' + detail : ''}`);
            }

            const contentType = response.headers.get('content-type') || '';
            let content = '';
            let usage: any = null;

            if (contentType.includes('application/json')) {
                const data = await response.json();
                usage = data.usage || null;

                // 尝试多种可能的响应格式
                if (data.choices && data.choices[0]) {
                    // OpenAI/DeepSeek 格式
                    if (data.choices[0].message && data.choices[0].message.content) {
                        content = data.choices[0].message.content;
                    } else if (data.choices[0].text) {
                        content = data.choices[0].text;
                    }
                    // 工具调用（非流式 function calling）
                    if (data.choices[0].message && data.choices[0].message.tool_calls && data.choices[0].message.tool_calls.length > 0) {
                        options?.onToolCalls?.(data.choices[0].message.tool_calls);
                    }
                } else if (data.content && data.content[0]?.text) {
                    // Anthropic 格式
                    content = data.content[0].text;
                } else if (data.candidates && data.candidates[0]?.content?.parts[0]?.text) {
                    // Google 格式
                    content = data.candidates[0].content.parts[0].text;
                } else if (data.message?.content) {
                    // Ollama 格式
                    content = data.message.content;
                } else if (data.response) {
                    // 其他格式
                    content = data.response;
                } else if (typeof data === 'string') {
                    content = data;
                } else {
                    // 尝试将整个响应作为字符串
                    content = JSON.stringify(data);
                }
            } else {
                // 纯文本响应
                content = await response.text();
            }

            // 深度思考：剥离 <think>…</think>（识别任意标签，畸形“仅 </think>”形态保留供渲染层二次拆），思考经 onReasoning 输出
            if (typeof content === 'string' && /<\/?think>/i.test(content)) {
                const thinkSt: ThinkStreamState = { inThink: false, thinking: '' }
                content = feedThinkState(content, thinkSt, (t) => options?.onReasoning?.(t))
            }

            options?.onComplete?.(content, usage && (usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined)
                ? { prompt_tokens: usage.prompt_tokens || 0, completion_tokens: usage.completion_tokens || 0 }
                : undefined);
            return content;

        } catch (error) {
            console.error('API请求失败:', error);
            options?.onError?.(error as Error);
            throw error;
        }
    }

    // 流式请求
    static async makeStreamingRequest(endpoint: string, body: any, headers: Record<string, string>, options?: any) {
        try {
            let finalUsage: any = null;
            // 深度思考状态机：跨 chunk 累积 <think> 段
            const thinkSt: ThinkStreamState = { inThink: false, thinking: '' }
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3600000);
            const onAbort = () => controller.abort();
            if (options?.signal) {
                if (options.signal.aborted) controller.abort();
                else options.signal.addEventListener('abort', onAbort);
            }

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(body),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                // 读取并透出服务端真实错误（如 GPUStack/vLLM 的上下文超限或网关校验信息），避免只有裸状态码
                let detail = ''
                try {
                    const text = await response.text()
                    if (text) {
                        try {
                            const j = JSON.parse(text)
                            detail = j?.error?.message || j?.message || text
                        } catch { detail = text }
                    }
                } catch { /* ignore */ }
                throw new Error(`HTTP错误! 状态码: ${response.status}${detail ? ' ' + detail : ''}`);
            }

            const reader = response.body?.getReader();
            if (!reader) {
                throw new Error('无法获取响应流');
            }

            const decoder = new TextDecoder('utf-8');
            let fullContent = '';
            let buffer = '';
            // 工具调用累积（function calling，按 index 拼接 arguments）
            const toolCallsAcc: any[] = [];
            // 结束原因（finish_reason）：'length' = 被 max_tokens / 上下文截断
            let finishReason = '';
            // 流内错误（SSE data 里的 error 字段）：必须抛出，否则会被上层当成“空流”静默吞掉
            let streamError = '';

            // 获取自定义解析函数
            const parseResponse = options?.parseResponse || ((parsed: any) => {
                let content = '';
                if (parsed.choices && parsed.choices[0]) {
                    const delta = parsed.choices[0].delta;
                    if (delta && delta.content) {
                        content = delta.content;
                    }
                } else if (parsed.message && parsed.message.content) {
                    content = parsed.message.content;
                } else if (parsed.delta && parsed.delta.text) {
                    content = parsed.delta.text;
                } else if (parsed.candidates && parsed.candidates[0]?.content?.parts[0]?.text) {
                    content = parsed.candidates[0].content.parts[0].text;
                }
                return content;
            });

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                buffer += chunk;

                // 处理 SSE 格式的数据行
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (!trimmedLine) continue;

                    // 处理 data: 前缀
                    if (trimmedLine.startsWith('data: ')) {
                        const data = trimmedLine.substring(6);
                        if (data === '[DONE]') continue;

                        try {
                            const parsed = JSON.parse(data);
                            // 流内错误（如 LM Studio/llama.cpp 的 "Context size has been exceeded."）：
                            // 记录后中止消费，由下方抛出——否则上层会当成“空流”静默重试并产出空结果
                            const inbandError = parsed?.error;
                            if (inbandError && !parsed?.choices) {
                                streamError = typeof inbandError === 'string'
                                    ? inbandError
                                    : (inbandError.message || JSON.stringify(inbandError));
                                break;
                            }
                            if (parsed.usage) finalUsage = parsed.usage;
                            const fr = parsed?.choices?.[0]?.finish_reason;
                            if (fr) finishReason = String(fr);
                            // 推理通道（reasoning_content：gemma-4 / vLLM / DeepSeek-R1 等与正文分开返回）：
                            // 累积进与 <think> 标签共用的大脑状态，并按“全量快照”回调，
                            // 否则思考类模型的推理内容在 UI 完全不可见（只剩空正文）
                            const reasoningDelta = parsed?.choices?.[0]?.delta?.reasoning_content;
                            if (typeof reasoningDelta === 'string' && reasoningDelta) {
                                thinkSt.thinking += reasoningDelta;
                                options?.onReasoning?.(thinkSt.thinking);
                            }
                            const content = parseResponse(parsed);
                            if (content) {
                                // 深度思考：把 <think>…</think> 从流式正文剥离（含孤立 </think>），思考经 onReasoning 输出
                                const clean = feedThinkState(content, thinkSt, (t) => options?.onReasoning?.(t))
                                if (clean) {
                                    fullContent += clean;
                                    options?.onStream?.(clean);
                                }
                            }
                            // 工具调用（function calling，按 index 累积 arguments）
                            if (parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.tool_calls) {
                                for (const tc of parsed.choices[0].delta.tool_calls) {
                                    const idx = tc.index || 0;
                                    if (!toolCallsAcc[idx]) {
                                        toolCallsAcc[idx] = { id: tc.id || '', type: tc.type || 'function', function: { name: '', arguments: '' } };
                                    }
                                    if (tc.id) toolCallsAcc[idx].id = tc.id;
                                    if (tc.function?.name) toolCallsAcc[idx].function.name = tc.function.name;
                                    // 规范化参数片段为字符串（个别后端把 arguments 当对象返回，避免 += 出 [object Object]）
                                    const argsFrag = typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? '')
                                    if (argsFrag) toolCallsAcc[idx].function.arguments += argsFrag;
                                    // 参数增量回传（供 UI 流式展示代码）
                                    options?.onToolCallArgs?.(toolCallsAcc[idx].id, toolCallsAcc[idx].function.name, argsFrag)
                                }
                            }
                        } catch (e) {
                            // 忽略 JSON 解析错误
                            console.debug('解析流式数据失败:', e);
                        }
                    } else {
                        // 尝试直接解析 JSON（某些 API 不遵循 SSE 格式）
                        try {
                            const parsed = JSON.parse(trimmedLine);
                            const content = parseResponse(parsed);
                            if (content) {
                                fullContent += content;
                                options?.onStream?.(content);
                            }
                        } catch (e) {
                            // 忽略
                        }
                    }
                }
                // 流内错误：停止消费（reader 在下方 cancel）
                if (streamError) break;
            }

            if (options?.signal) options.signal.removeEventListener('abort', onAbort);

            if (streamError) {
                try { await reader.cancel(); } catch { /* ignore */ }
                throw new Error(`模型服务返回错误: ${streamError}`);
            }

            const completedCalls = toolCallsAcc.filter(tc => tc && tc.function && tc.function.name);
            // 空正文 + 无工具调用 + 被 max_tokens 截断：明确报错。
            // 若静默返回空内容，上层（agent 循环）会误判为“空流”反复重试并最终产出空结果，
            // 掩盖真实原因（max_tokens 太小 / 模型加载的上下文不足 / 思考耗尽输出预算）
            if (!fullContent && completedCalls.length === 0 && finishReason === 'length') {
                throw new Error('模型输出在产生正文前达到 max_tokens 上限（finish_reason=length），请增大 max_tokens 或提高模型上下文长度');
            }
            if (completedCalls.length > 0) options?.onToolCalls?.(completedCalls);
            options?.onComplete?.(fullContent, finalUsage
                ? { prompt_tokens: finalUsage.prompt_tokens || 0, completion_tokens: finalUsage.completion_tokens || 0, finish_reason: finishReason }
                : (finishReason ? { finish_reason: finishReason } : undefined));
            return fullContent;

        } catch (error) {
            console.error('流式请求失败:', error);
            options?.onError?.(error as Error);
            throw error;
        }
    }
}
