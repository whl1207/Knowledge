// src/shared/kbAiClient.ts
// 知识处理模块（knowRAG）的统一 AI 客户端
//
// 支持模型来源：ollama / lmstudio / openai / deepseek（单来源，Chat / Responses 接口样式）/
//               gpustack / anthropic / google / azure / custom
//
// 设计说明：
// - 聊天（chat / streamChat / agenticChat）统一收敛到 AIUtils.sendChat
//   （与 store.sendToAI 共用同一实现，位于 ai-utils.ts 的「统一聊天分派」），
//   本模块仅做 spec → 参数适配（provider / 连接配置 / 模型名）。
// - 嵌入（embed）与模型列表（listModels）为 AIUtils 尚未提供的能力，由本模块按
//   各来源直连 fetch 实现。
// - 各来源的连接配置（URL / API Key / 模型名）来自 store.AIconfig.llm[type]，
//   知识处理模块自身的模型选择（embed / chat / process）由调用方维护并传入 spec。
// - 不依赖 Vue，可在任意渲染进程文件中使用（kbRetrieval.ts 被主进程引用）。

import { AIUtils } from '@/services/ai-utils'
import { deepSeekConfig, deepSeekStyleOf, normalizeLlmType } from '@/shared/llmSources'

// ==================== 类型定义 ====================

export type KbProvider =
  | 'ollama'
  | 'lmstudio'
  | 'openai'
  | 'deepseek'
  | 'gpustack'
  | 'anthropic'
  | 'google'
  | 'azure'
  | 'custom'

export const KB_PROVIDERS: KbProvider[] = [
  'ollama', 'lmstudio', 'deepseek', 'gpustack', 'openai',
  'anthropic', 'google', 'azure', 'custom',
]

export const KB_PROVIDER_LABELS: Record<KbProvider, { zh: string; en: string }> = {
  ollama: { zh: 'Ollama（本地）', en: 'Ollama (Local)' },
  lmstudio: { zh: 'LM Studio（本地）', en: 'LM Studio (Local)' },
  openai: { zh: 'OpenAI', en: 'OpenAI' },
  deepseek: { zh: 'DeepSeek', en: 'DeepSeek' },
  gpustack: { zh: 'GPUStack（自托管）', en: 'GPUStack (self-hosted)' },
  anthropic: { zh: 'Anthropic Claude', en: 'Anthropic Claude' },
  google: { zh: 'Google Gemini', en: 'Google Gemini' },
  azure: { zh: 'Azure OpenAI', en: 'Azure OpenAI' },
  custom: { zh: '自定义 API', en: 'Custom API' },
}

/** 模型来源类型 → store.AIconfig.llm 中的配置键（历史别名 'deepseek-responses' 归一到 'deepseek'） */
export function providerConfigKey(type: string): string {
  return normalizeLlmType(type)
}

/**
 * 归一 KB 规格的来源与配置（兼容历史存档里的 'deepseek-responses'）：
 * DeepSeek 是单来源，接口样式随 config.api_style 下发（历史别名强制 responses）。
 */
export function normalizeKbSpecType(spec: KbModelSpec): { type: string; cfg: any } {
  const raw = String(spec?.llmType || 'ollama')
  const type = normalizeLlmType(raw)
  const cfg = { ...(spec?.config || {}) }
  if (type === 'deepseek' && (raw === 'deepseek-responses' || !cfg.base_url)) {
    // 历史别名 → 强制 Responses；配置缺 api_style 且有另一侧样式信息时由 deepSeekStyleOf 处理
    if (raw === 'deepseek-responses') cfg.api_style = 'responses'
  }
  return { type, cfg }
}

/** 嵌入回退规格：来源不提供嵌入模型时，嵌入改用该来源（如 DeepSeek → Ollama 嵌入），聊天/处理不受影响 */
export interface EmbedFallbackSpec {
  llmType: KbProvider
  config: any
  embed: string
}

/** 知识处理模块的模型规格：来源 + 连接配置 + 三个模型选择 */
export interface KbModelSpec {
  llmType: KbProvider
  /** 来源原始配置（store.AIconfig.llm[type] 的拷贝），含 url / api_key / model 等 */
  config: any
  /** 嵌入模型名 */
  embed: string
  /** 对话模型名 */
  chat: string
  /** 处理模型名（问题推理/本体/社区报告等；为空时回退 chat） */
  process: string
  /** 当前来源未配置嵌入模型时回退的嵌入规格（通常为 Ollama 嵌入；聊天/处理不受影响） */
  embedFallback?: EmbedFallbackSpec
  /** 是否启用思维链 / 推理强度（Ollama think、LM Studio reasoning_effort、DeepSeek reasoning.effort 等）；
   *  支持旧布尔值（true/false）与新档位字符串（'none'|'low'|'medium'|'high'|'max'） */
  think?: boolean | string
  temperature?: number
  maxTokens?: number
  topP?: number
}

export interface KbChatOptions {
  onStream?: (chunk: string) => void
  onComplete?: (content: string) => void
  onError?: (e: Error) => void
  signal?: AbortSignal
  tools?: any[]
  toolChoice?: any
  onToolCalls?: (calls: any[]) => void
  onToolCallArgs?: (callId: string, name: string, argsFragment: string) => void
  format?: string
  /** 单次调用覆盖思维链开关（缺省用 spec.think） */
  think?: boolean
}

// ==================== 工具函数 ====================

/** 浏览器（无 ipcRenderer）环境下把请求转发到 LAN 服务器 /__proxy，Electron 直连 */
function resolveApiUrl(originalUrl: string): string {
  if (typeof window !== 'undefined' && !(window as any).ipcRenderer) {
    const origin = window.location.origin
    return `${origin}/__proxy?url=${encodeURIComponent(originalUrl)}`
  }
  return originalUrl
}

function stripTrailingSlash(s: string): string {
  return String(s || '').replace(/\/+$/, '')
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const resp = await fetch(resolveApiUrl(url), init)
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`
    try {
      const body = await resp.json()
      msg += `: ${body?.error?.message || JSON.stringify(body).slice(0, 300)}`
    } catch { /* ignore */ }
    throw new Error(msg)
  }
  return resp.json()
}

/** 解析 API Key：优先 apiKeyRef（凭据引用），回退内联 api_key */
async function resolveApiKey(config: any): Promise<string> {
  if (!config) return ''
  const ref = config?.apiKeyRef
  if (typeof ref === 'string' && ref.trim()) {
    try {
      if ((window as any).dsh?.credentials?.resolve) {
        const res = await (window as any).dsh.credentials.resolve(ref.trim())
        if (res?.value) return res.value
      }
    } catch (e) {
      console.warn('[kbAi] 凭据解析失败:', e)
    }
  }
  return config?.api_key || ''
}

function authHeaders(config: any, apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
  }
}

/** 从 /models 响应提取模型 id 列表（兼容 {data:[{id}]} / {models:[]} / 字符串数组） */
function extractModelIds(data: any): string[] {
  const pick = (m: any) => (typeof m === 'string' ? m : m?.id)
  if (Array.isArray(data?.data)) return data.data.map(pick).filter(Boolean)
  if (Array.isArray(data?.models)) return data.models.map(pick).filter(Boolean)
  if (Array.isArray(data)) return data.map(pick).filter(Boolean)
  return []
}

/** 统一从 spec.config 推导「基础地址」 */
function providerBaseUrl(spec: KbModelSpec): string {
  const cfg = spec.config || {}
  switch (normalizeLlmType(spec.llmType)) {
    case 'ollama': return cfg.model_url || ''
    case 'lmstudio': return cfg.base_url || ''
    case 'openai': return cfg.base_url || ''
    case 'deepseek': return cfg.base_url || ''
    case 'gpustack': return cfg.base_url || ''
    case 'azure': return cfg.endpoint || ''
    case 'custom': return cfg.api_url || ''
    default: return ''
  }
}

/** 聊天/处理模型名：process 优先，回退 chat */
export function chatModelName(spec: KbModelSpec): string {
  return spec.process || spec.chat || spec.config?.model || ''
}

/**
 * 取「嵌入操作」使用的有效规格：
 * - 当前来源自备嵌入模型（config.embed_model 非空）→ 用当前来源；
 * - 否则回退到 embedFallback（通常为 Ollama 嵌入）。聊天/处理仍用原 spec。
 * - 若 spec 已解析到回退来源（llmType 与回退一致且已选 embed）→ 原样返回，保留解析结果。
 */
export function effectiveEmbedSpec(spec: KbModelSpec): KbModelSpec {
  if (!spec) return spec
  const fb = spec.embedFallback
  if (spec.config?.embed_model || !fb?.embed) return spec
  if (spec.llmType === fb.llmType && spec.embed) return spec
  return { ...spec, llmType: fb.llmType, config: fb.config, embed: fb.embed }
}

// ==================== 模型列表 ====================

/** 拉取来源可用模型名列表（string[]） */
export async function listModels(spec: KbModelSpec): Promise<string[]> {
  const type = normalizeLlmType(spec.llmType || 'ollama')
  const cfg = spec.config || {}
  try {
    switch (type) {
      case 'ollama': {
        const url = `${stripTrailingSlash(cfg.model_url || 'http://127.0.0.1:11434')}/api/tags`
        const data = await fetchJson(url)
        return (data?.models || []).map((m: any) => m.name).filter(Boolean)
      }
      case 'lmstudio':
      case 'openai':
      case 'deepseek': {
        const base = stripTrailingSlash(providerBaseUrl(spec))
        if (!base) return cfg.available_models || []
        // openai 的 base_url 已含 /v1；lmstudio/deepseek 需补 /v1
        const candidates = base.endsWith('/v1')
          ? [`${base}/models`]
          : [`${base}/v1/models`, `${base}/models`]
        for (const url of candidates) {
          try {
            const data = await fetchJson(url, { headers: authHeaders(cfg, await resolveApiKey(cfg)) })
            const ids = extractModelIds(data)
            if (ids.length) return ids
          } catch (e) { /* 尝试下一个候选端点 */ }
        }
        return cfg.available_models || []
      }
      case 'google': {
        const key = await resolveApiKey(cfg)
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`
        const data = await fetchJson(url)
        return (data?.models || [])
          .map((m: any) => String(m?.name || '').replace(/^models\//, ''))
          .filter((n: string) => n)
      }
      case 'anthropic':
        return cfg.model ? [cfg.model] : []
      case 'azure':
        return cfg.deployment ? [cfg.deployment] : (cfg.available_models || [])
      case 'gpustack': {
        const base = stripTrailingSlash(cfg.base_url || '')
        if (!base) return cfg.available_models || []
        // GPUStack 用 /v1-openai 前缀；兼容用户直接填 OpenAI 兼容基址（/v1）的情况
        const candidates = base.endsWith('/v1-openai')
          ? [`${base}/models`]
          : (base.endsWith('/v1')
            ? [`${base}/models`]
            : [`${base}/v1-openai/models`, `${base}/v1/models`, `${base}/models`])
        for (const url of candidates) {
          try {
            const data = await fetchJson(url, { headers: authHeaders(cfg, await resolveApiKey(cfg)) })
            const ids = extractModelIds(data)
            if (ids.length) return ids
          } catch (e) { /* 尝试下一个候选端点 */ }
        }
        return cfg.available_models || []
      }
      case 'custom': {
        const apiUrl = cfg.api_url || ''
        if (!apiUrl) return cfg.available_models || []
        let base = stripTrailingSlash(apiUrl)
        // 去掉常见聊天端点后缀得到服务基址（含 GPUStack 的 /v1-openai 前缀）
        for (const suf of ['/v1-openai/chat/completions', '/v1/chat/completions', '/chat/completions', '/v1-openai/completions', '/v1/completions', '/completions', '/v1/responses', '/responses', '/v1/messages', '/messages']) {
          if (base.endsWith(suf)) { base = stripTrailingSlash(base.slice(0, -suf.length)); break }
        }
        const candidates = base.endsWith('/v1-openai')
          ? [`${base}/models`]
          : (base.endsWith('/v1')
            ? [`${base}/models`]
            : [`${base}/v1-openai/models`, `${base}/v1/models`, `${base}/models`])
        for (const url of candidates) {
          try {
            const data = await fetchJson(url, { headers: authHeaders(cfg, await resolveApiKey(cfg)) })
            const ids = extractModelIds(data)
            if (ids.length) return ids
          } catch (e) { /* 尝试下一个候选端点 */ }
        }
        return cfg.available_models || []
      }
      default:
        return cfg.available_models || []
    }
  } catch (e) {
    console.error('[kbAi] 拉取模型列表失败:', type, e)
    // 拉取失败时回退到已缓存的模型列表，避免空列表
    return cfg.available_models || []
  }
}

// ==================== 嵌入 ====================

/**
 * 文本嵌入。input 为单个字符串或字符串数组，返回同顺序的向量数组（number[][]）。
 * 注意：部分来源（Anthropic / DeepSeek Responses 接口样式 / 不支持嵌入的自定义端点）会抛出明确错误。
 */
export async function embed(spec: KbModelSpec, input: string | string[]): Promise<number[][]> {
  // 当前来源无嵌入模型时，嵌入回退到 embedFallback（如 Ollama）；聊天/处理不受影响
  const eff = effectiveEmbedSpec(spec)
  const type = normalizeLlmType(eff.llmType || 'ollama')
  const cfg = eff.config || {}
  const model = eff.embed || cfg.model || ''
  const texts = Array.isArray(input) ? input : [input]

  // DeepSeek 的 Responses 接口样式没有嵌入端点（Chat 样式仍可尝试兼容网关，保持既有行为）
  if (type === 'deepseek' && deepSeekStyleOf(eff.llmType, cfg) === 'responses') {
    throw new Error('DeepSeek（Responses 接口样式）不提供嵌入接口，请改用支持嵌入的模型来源（如 Ollama / OpenAI 兼容）')
  }

  switch (type) {
    case 'ollama': {
      const url = `${stripTrailingSlash(cfg.model_url || 'http://127.0.0.1:11434')}/api/embed`
      const data = await fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: texts.length === 1 ? texts[0] : texts, truncate: true, keep_alive: '1h' }),
      })
      const embs = data?.embeddings || []
      return embs.map((v: any) => (Array.isArray(v) ? v : []))
    }
    case 'lmstudio':
    case 'openai':
    case 'deepseek':
    case 'gpustack':
    case 'custom': {
      const base = stripTrailingSlash(providerBaseUrl(eff))
      // GPUStack 用 /v1-openai 前缀；openai 的 base_url 已含 /v1；其余补 /v1
      const url = base.endsWith('/v1-openai')
        ? `${base}/embeddings`
        : (base.endsWith('/v1')
          ? `${base}/embeddings`
          : `${base}/v1/embeddings`)
      const key = await resolveApiKey(cfg)
      const data = await fetchJson(url, {
        method: 'POST',
        headers: authHeaders(cfg, key),
        body: JSON.stringify({ model, input: texts.length === 1 ? texts[0] : texts }),
      })
      const items = data?.data || []
      return items.map((it: any) => (Array.isArray(it?.embedding) ? it.embedding : []))
    }
    case 'azure': {
      const endpoint = stripTrailingSlash(cfg.endpoint || '')
      const deployment = eff.embed || cfg.deployment || ''
      const url = `${endpoint}/openai/deployments/${deployment}/embeddings?api-version=${cfg.api_version || '2024-02-15-preview'}`
      const key = await resolveApiKey(cfg)
      const data = await fetchJson(url, {
        method: 'POST',
        headers: { 'api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: texts.length === 1 ? texts[0] : texts }),
      })
      const items = data?.data || []
      return items.map((it: any) => (Array.isArray(it?.embedding) ? it.embedding : []))
    }
    case 'google': {
      const key = await resolveApiKey(cfg)
      const out: number[][] = []
      for (const text of texts) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${encodeURIComponent(key)}`
        const data = await fetchJson(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: { parts: [{ text }] } }),
        })
        const values = data?.embedding?.values || []
        out.push(Array.isArray(values) ? values : [])
      }
      return out
    }
    case 'anthropic':
      throw new Error('Anthropic Claude 不提供嵌入接口，请改用支持嵌入的模型来源（如 Ollama / OpenAI 兼容）')
    default:
      throw new Error(`不支持的模型来源: ${type}`)
  }
}

// ==================== 聊天 ====================

/** 构造统一的 llmConfig（AIUtils 需要） */
function buildLlmConfig(spec: KbModelSpec, opts: KbChatOptions): any {
  return {
    stream: !!opts.onStream,
    temperature: spec.temperature ?? 0.7,
    top_p: spec.topP ?? 1,
    max_tokens: spec.maxTokens ?? 8192,
    think: opts.think !== undefined ? opts.think : spec.think,
    format: opts.format,
  }
}

/** 聊天（非流式返回完整文本；传 onStream 时流式，返回拼接后的完整文本）。
 *  分派逻辑统一收敛到 AIUtils.sendChat（与 store.sendToAI 同一实现），本模块仅做 spec → 参数适配。 */
export async function chat(spec: KbModelSpec, messages: any[], opts: KbChatOptions = {}): Promise<string> {
  const { type, cfg } = normalizeKbSpecType(spec)
  const llmConfig = buildLlmConfig(spec, opts)
  // DeepSeek 单来源：接口样式随配置下发（历史别名 'deepseek-responses' 会被强制为 responses）
  const c = {
    ...cfg,
    ...(type === 'deepseek' ? { api_style: deepSeekStyleOf(spec.llmType, cfg) } : {}),
    model: chatModelName(spec),
  }
  return AIUtils.sendChat(type, c, llmConfig, messages, opts)
}

/** 流式聊天：逐块回调，返回拼接后的完整文本 */
export async function streamChat(
  spec: KbModelSpec,
  messages: any[],
  onChunk: (chunk: string) => void,
  opts: KbChatOptions = {},
): Promise<string> {
  return chat(spec, messages, { ...opts, onStream: onChunk })
}

/** Agentic 聊天：带工具，返回 content + tool_calls */
export async function agenticChat(
  spec: KbModelSpec,
  messages: any[],
  tools: any[],
  opts: KbChatOptions = {},
): Promise<{ content: string; tool_calls: any[] }> {
  let toolCalls: any[] = []
  const content = await chat(spec, messages, {
    ...opts,
    tools,
    onToolCalls: (calls) => { toolCalls = calls || [] },
  })
  return { content, tool_calls: toolCalls }
}

// ==================== 服务构建（对接 graphrag primitives） ====================

export interface KbServicesDeps {
  cosineSimilarity?: (a: number[], b: number[]) => number
  computeBM25?: (query: string, docs: string[], k1: number, b: number) => number[]
  /** 推理摘要写回文件（summarize_file 持久化用） */
  syncFileSummary?: (filePath: string, summary: string) => Promise<boolean>
}

/** 默认余弦相似度（未传入时兜底，维度不匹配返回 0） */
function defaultCosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 默认 BM25：未启用时返回空分（等价于关闭 BM25） */
function defaultComputeBM25(): number[] {
  return []
}

/** 构建查询时检索原语（RetrievalServices）：embed / chat / streamChat / agenticChat */
export function buildRetrievalServices(spec: KbModelSpec, deps: KbServicesDeps = {}, embedSpec?: KbModelSpec) {
  // 嵌入可用独立规格（当前来源无嵌入模型时已回退到 Ollama）；聊天/处理仍用原 spec
  const es = embedSpec || effectiveEmbedSpec(spec)
  return {
    embed: async (text: string): Promise<number[] | undefined> => {
      const v = await embed(es, text)
      return v?.[0]
    },
    chat: async (messages: any[]): Promise<string> => chat(spec, messages),
    streamChat: async (messages: any[], onChunk: (c: string) => void): Promise<string> =>
      streamChat(spec, messages, onChunk),
    agenticChat: async (messages: any[], tools: any[]): Promise<{ content: string; tool_calls: any[] }> =>
      agenticChat(spec, messages, tools),
    cosineSimilarity: deps.cosineSimilarity || defaultCosineSimilarity,
    computeBM25: deps.computeBM25 || defaultComputeBM25,
  }
}

/** 构建索引增强原语（IngestionContext.services）：embed / streamChat / syncFileSummary */
export function buildIngestionServices(spec: KbModelSpec, deps: KbServicesDeps = {}) {
  return {
    embed: async (text: string): Promise<number[] | undefined> => {
      const v = await embed(spec, text)
      return v?.[0]
    },
    streamChat: async (messages: any[], onChunk: (c: string) => void): Promise<string> =>
      streamChat(spec, messages, onChunk),
    syncFileSummary: deps.syncFileSummary,
  }
}

// ==================== 便捷封装 ====================

/** 从 store.AIconfig.llm 读取指定来源的配置。
 *  自定义来源返回「激活来源 sources[activeIndex]」与扁平字段合并后的配置——
 *  来源数组是权威数据（扁平字段可能未及时对齐，直接读扁平会导致地址/密钥空白）。 */
export function getProviderConfig(llm: any, type: string, customSourceId?: number | null): any {
  const t = normalizeLlmType(type || 'ollama')
  // DeepSeek 单来源：返回当前接口样式的配置（带 api_style，请求层据此选 Chat / Responses）
  if (t === 'deepseek') return deepSeekConfig(llm) || null
  const key = providerConfigKey(t)
  if (t === 'custom' && llm?.custom) {
    const c = llm.custom
    const srcs = Array.isArray(c.sources) ? c.sources : []
    // 指定来源 id 时（嵌入兜底可选具体自定义来源）优先按 id 查找；否则用当前激活来源
    const byId = (typeof customSourceId === 'number') ? srcs.find((s: any) => s?.id === customSourceId) : undefined
    const idx = (typeof c.activeIndex === 'number' && c.activeIndex >= 0 && c.activeIndex < srcs.length) ? c.activeIndex : 0
    const src = byId || srcs[idx]
    if (!src) return c
    return {
      ...c,
      ...src,
      // 模型列表：优先来源已保存的；否则回退扁平（兼容旧存档只有扁平列表的情况）
      available_models: Array.isArray(src.available_models) && src.available_models.length
        ? src.available_models
        : (Array.isArray(c.available_models) ? c.available_models : []),
    }
  }
  return llm?.[key] || null
}

/** 嵌入兜底设置（store.llm.embeddingFallback）：当前来源无嵌入能力时用哪个来源做向量化 */
export interface EmbedFallbackSetting {
  /** 兜底来源类型；'' = 不兜底 */
  llmType: KbProvider | ''
  /** 嵌入模型名；'' = 用该来源配置里的 embed_model */
  model: string
}

/** 读取嵌入兜底设置（缺省 ollama，兼容旧行为） */
export function embeddingFallbackSetting(llm: any): EmbedFallbackSetting {
  const s = llm?.embeddingFallback || {}
  const llmType = String(s.llmType ?? 'ollama') as KbProvider | ''
  return { llmType, model: String(s.model || '') }
}

/**
 * 由 store 的「嵌入兜底」设置构建 EmbedFallbackSpec（供 spec.embedFallback / 检索选项使用）。
 * 连接配置直接沿用该来源在设置里的配置（含 apiKeyRef→api_key 的明文值，调用方自行解析凭据）。
 * 返回 undefined = 未配置/关闭/该来源没有可用嵌入模型 → 调用方按原逻辑报错。
 */
export function buildEmbedFallbackFromStore(store: any): EmbedFallbackSpec | undefined {
  const llm = store?.AIconfig?.llm || {}
  const { llmType, model } = embeddingFallbackSetting(llm)
  if (!llmType) return undefined
  const cfg = getProviderConfig(llm, llmType, llm?.embeddingFallback?.customSourceId ?? null) || {}
  // Ollama 未配置 embed_model 时沿用历史默认（保证与旧行为一致）
  const embed = String(model || cfg.embed_model || (llmType === 'ollama' ? 'nomic-embed-text:latest' : '')).trim()
  if (!embed) return undefined
  return { llmType: llmType as KbProvider, config: cfg, embed }
}

/** 从「模型 ref」组装 KbModelSpec（knowRAG.vue / testManager.vue 通用） */
export function buildSpecFromModel(model: any, store: any): KbModelSpec {
  const llm = store?.AIconfig?.llm || {}
  const type: KbProvider = (llm.type as KbProvider) || 'ollama'
  const cfg = getProviderConfig(llm, type) || {}
  return {
    llmType: type,
    config: cfg,
    embed: model?.embed || cfg.embed_model || '',
    chat: model?.chat || cfg.model || '',
    process: model?.process || cfg.model || '',
    think: model?.think,
    temperature: llm.temperature ?? 0.7,
    maxTokens: llm.max_tokens ?? 8192,
    topP: llm.top_p ?? 1,
    // 当前来源无嵌入模型时，嵌入回退到「嵌入兜底」设置的来源（默认 Ollama）
    embedFallback: buildEmbedFallbackFromStore(store),
  }
}
