// src/platform/lanKb.ts — 局域网共享知识库
// 主机在「设置 → 协作 → 局域网共享」配置知识库目录后，LAN HTTP 服务暴露：
//   GET /api/kb/list   列出共享目录中的 .kb
//   GET /api/kb/read   读取某个 .kb 的完整 JSON
//   GET /api/kb/search 对某个 .kb 检索（主机侧向量化/词法匹配）
// 远端网页端（无 ipcRenderer）在 home 知识库模式通过这些接口「选择终端设定的文件夹中现有的
// 知识库」来使用；也可继续上传自己的文件作为知识库。主机端负责把知识库目录 + 嵌入配置同步给主进程。
import * as kbAi from '@/shared/kbAiClient'
import { normalizeLlmType, normalizeLlmTypeList, resolveLlmSource } from '@/shared/llmSources'
import { resolveLimitFor } from '@/lib/contextUsage'

export interface SharedKbFile {
  name: string
  size: number
  mtime: number
}

export interface SharedKbListResult {
  enabled: boolean
  dir: string
  files: SharedKbFile[]
}

export interface SharedKbSearchResult {
  ok: boolean
  method: 'dense' | 'lexical' | 'none'
  model?: string
  total?: number
  context: string
  blocks: { label: string; content: string; similarity: number }[]
  error?: string
}

/** 远端浏览器：列出主机共享目录中的 .kb（由局域网 HTTP 服务提供） */
export async function listSharedKbs(): Promise<SharedKbListResult> {
  if (typeof window === 'undefined' || !window.location?.origin) {
    return { enabled: false, dir: '', files: [] }
  }
  try {
    const resp = await fetch(`${window.location.origin}/api/kb/list`)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data: any = await resp.json()
    return {
      enabled: !!data.enabled,
      dir: data.dir || '',
      files: Array.isArray(data.files) ? data.files : [],
    }
  } catch (e) {
    console.warn('获取共享知识库列表失败:', e)
    return { enabled: false, dir: '', files: [] }
  }
}

/** 远端浏览器：检索主机共享目录中的某个 .kb（主机完成向量化或词法匹配后返回 topK） */
export async function searchSharedKb(name: string, query: string, topK = 5): Promise<SharedKbSearchResult> {
  if (typeof window === 'undefined' || !window.location?.origin) {
    throw new Error('当前环境不支持局域网共享知识库')
  }
  const url = `${window.location.origin}/api/kb/search?name=${encodeURIComponent(name)}&topK=${topK}&query=${encodeURIComponent(query)}`
  const resp = await fetch(url)
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`
    try {
      const body: any = await resp.json()
      if (body?.error) msg = body.error
    } catch { /* ignore */ }
    throw new Error(msg)
  }
  return resp.json()
}

/** 主机（Electron）：由当前 AI 配置构建「主机嵌入配置」，随局域网共享同步给主进程，
 *  供 /api/kb/search 对共享 .kb 做向量检索（保证与建库嵌入模型一致）。 */
export function buildLanEmbedPayload(store: any): { llmType: string; base: string; model: string; apiKey: string } {
  const llm = store?.AIconfig?.llm || {}
  // 单来源：历史别名 'deepseek-responses' 归一到 'deepseek'
  const type: string = normalizeLlmType(llm.type || 'ollama')
  const cfg: any = kbAi.getProviderConfig(llm, type) || {}
  const baseKey: Record<string, string> = {
    ollama: 'model_url',
    lmstudio: 'base_url',
    openai: 'base_url',
    deepseek: 'base_url',
    gpustack: 'base_url',
    azure: 'endpoint',
    custom: 'api_url',
    google: 'base_url',
  }
  const base = (cfg[baseKey[type] || 'model_url'] as string) || ''
  const apiKey = (cfg.api_key as string) || ''
  const model = (cfg.embed_model as string) || ''
  // 当前来源自带嵌入模型 → 直接用当前来源
  if (model && type !== 'anthropic' && type !== 'deepseek') {
    return { llmType: type, base, model, apiKey }
  }
  // 当前来源无嵌入模型（DeepSeek/Anthropic 等）→ 回退到「嵌入兜底」设置的来源（与 kbAi.effectiveEmbedSpec 一致）
  const fb = kbAi.buildEmbedFallbackFromStore(store)
  if (fb) {
    const fbc: any = fb.config || {}
    return {
      llmType: fb.llmType,
      base: (fbc[baseKey[fb.llmType] || 'model_url'] as string) || '',
      model: fb.embed,
      apiKey: (fbc.api_key as string) || '',
    }
  }
  // 兜底已关闭/未配置 → 保留历史默认（Ollama）
  const oc: any = kbAi.getProviderConfig(llm, 'ollama') || {}
  return {
    llmType: 'ollama',
    base: (oc.model_url as string) || 'http://127.0.0.1:11434',
    model: (oc.embed_model as string) || 'nomic-embed-text:latest',
    apiKey: (oc.api_key as string) || '',
  }
}

/**
 * 主机（Electron）：由当前 AI 配置构建「访客智能体用的主机模型」配置，随局域网共享同步给
 * 主进程。网页端没有本地执行能力，「智能体」模式由主机侧跑 agent 循环，
 * 因此模型也由主机提供（访客无需配置 Key）。
 *
 * @param policy 访客权限策略（可选）：`guestLlmType` / `guestLlmModel` 用于指定
 *   访客会话用哪个来源与模型；留空 = 跟随主机当前来源与当前模型。
 */
export function buildLanLlmPayload(
  store: any,
  policy?: { guestLlmType?: string; guestLlmModel?: string },
): { provider: string; config: any; llmConfig: any; contextLimit: number } {
  const llm = store?.AIconfig?.llm || {}
  // 来源：访客指定（含 custom:<索引>）优先，否则跟随主机当前激活来源
  const rawType = String(policy?.guestLlmType || '').trim()
  const customIdx = rawType.startsWith('custom:') ? (parseInt(rawType.slice('custom:'.length), 10) || 0) : undefined
  const type = rawType ? normalizeLlmType(rawType) : normalizeLlmType(llm.type || 'ollama')
  const { config } = resolveLlmSource(llm, type, customIdx)
  const guestConfig = { ...(config || {}) }
  // 模型：访客指定则覆盖来源当前模型
  const model = String(policy?.guestLlmModel || '').trim()
  if (model) guestConfig.model = model
  // ⚠️ 必须净化：config 来自 store（Vue 响应式 Proxy），嵌套数组/对象仍是 Proxy，
  // 直接经 ipcRenderer.invoke 会抛 “An object could not be cloned.”（本功能曾因此完全下发失败）
  return JSON.parse(JSON.stringify({
    provider: type,
    config: guestConfig,
    llmConfig: {
      type,
      stream: true,
      temperature: llm.temperature,
      max_tokens: llm.max_tokens,
      // 远端自托管后端的并发基准跟随本机设置（与桌面端 agent 会话一致）
      remoteMaxInflight: llm.remoteMaxInflight,
    },
    // 上下文窗口上限：与主页圆环同源解析，主进程据此做预算检查与主动压缩
    contextLimit: resolveLimitFor(llm, {
      provider: type,
      model: guestConfig.model,
      customSourceIndex: customIdx ?? llm.custom?.activeIndex,
    }).limit,
  }))
}

// ==================== 网页端可选模型来源（对齐主机配置） ====================

/** 下发给网页端的模型来源快照：主机的来源清单 + 各来源地址 / 模型（**不含任何密钥**） */
export interface LanModelSourcesPayload {
  llm: any
  disabled: string[]
}

/**
 * 主机（Electron）：构建「网页端可选的模型来源」快照，随访客策略一起下发主进程。
 *
 * 为什么需要：网页端（浏览器）用的是它**自己**的本地配置——默认地址、默认全来源。
 * 于是①主机在「模型 → 来源」里关掉的来源，网页端照样列出来；②网页端按自己的默认地址
 * 去探测（如 LM Studio 的 `localhost:1234`），而主机的服务在别的地址 / 端口时永远刷不出模型。
 * 把主机的来源清单（含地址与已探测模型）下发后，网页端即可与主机桌面端完全一致。
 *
 * ⚠️ 必须剥离密钥：api_key / apiKeyRef / token 一律清空再下发（网页端只借用地址，不借用凭据）。
 */
export function buildLanModelSourcesPayload(store: any): LanModelSourcesPayload {
  const llm = store?.AIconfig?.llm || {}
  const disabled: string[] = Array.isArray(store?.llmDisabledSources)
    ? store.llmDisabledSources.filter((x: any) => typeof x === 'string')
    : []
  const snapshot = {
    types: normalizeLlmTypeList(llm.types || []),
    type: normalizeLlmType(llm.type || 'ollama'),
    ollama: llm.ollama,
    lmstudio: llm.lmstudio,
    openai: llm.openai,
    deepseek: llm.deepseek,
    gpustack: llm.gpustack,
    anthropic: llm.anthropic,
    google: llm.google,
    azure: llm.azure,
    custom: llm.custom,
  }
  return {
    // 走一遍 JSON 净化：store 里全是响应式 Proxy，直接 invoke 会抛 “An object could not be cloned.”
    llm: stripLanSecrets(JSON.parse(JSON.stringify(snapshot))),
    disabled,
  }
}

/** 递归清空密钥字段（密钥只留在主机本机，绝不随局域网下发） */
function stripLanSecrets<T>(value: T): T {
  const SECRET_KEYS = new Set(['api_key', 'apiKeyRef', 'token'])
  const walk = (v: any, seen: WeakSet<object>): any => {
    if (!v || typeof v !== 'object') return v
    if (seen.has(v)) return undefined
    seen.add(v)
    if (Array.isArray(v)) return v.map((item) => walk(item, seen))
    const out: Record<string, any> = {}
    for (const k of Object.keys(v)) out[k] = SECRET_KEYS.has(k) ? '' : walk(v[k], seen)
    return out
  }
  return walk(value, new WeakSet())
}

// ==================== 网页端上传 .kb 的本地检索 ====================
// web 知识库模式除「共享 KB」外仅允许上传 .kb 文件。上传的 .kb 在浏览器本地解析，
// 用词法（中文二元组 + 英文词命中）检索其切片——无需主机/嵌入模型即可工作。

export interface LocalKbHit {
  label: string
  content: string
  similarity: number
}

export interface LocalKbSearchResult {
  method: 'lexical'
  total: number
  context: string
  blocks: LocalKbHit[]
}

function lanLocalTokenize(text: string): string[] {
  const out = new Set<string>()
  const lower = String(text || '').toLowerCase()
  const words = lower.match(/[a-z0-9_]+/g) || []
  for (const w of words) if (w.length > 1) out.add(w)
  const cjk = lower.replace(/[^\u4e00-\u9fff]/g, '')
  for (let i = 0; i + 1 < cjk.length; i++) out.add(cjk.slice(i, i + 2))
  if (cjk.length === 1) out.add(cjk)
  return Array.from(out)
}

/** 解析若干 .kb JSON 文本 → 切片列表（A=内容、label=切片标签） */
export function kbJsonTextsToBlocks(rawTexts: string[]): { label: string; A: string }[] {
  const blocks: { label: string; A: string }[] = []
  for (const raw of rawTexts) {
    try {
      const data = JSON.parse(raw)
      if (!data || !Array.isArray(data.blocks)) continue
      for (const b of data.blocks) {
        if (!b || typeof b.A !== 'string' || !b.A.trim()) continue
        blocks.push({ label: b.label || '', A: b.A })
      }
    } catch { /* 跳过非法 .kb */ }
  }
  return blocks
}

/** 对 .kb 切片做客户端词法检索，返回 topK（无可用切片返回 null） */
export function lexicalSearchBlocks(blocks: { label: string; A: string }[], query: string, topK = 5): LocalKbSearchResult | null {
  if (!blocks.length) return null
  const q = String(query || '').trim()
  const tokens = lanLocalTokenize(q)
  if (!tokens.length) return null
  const scored = blocks
    .map((b) => {
      const lower = b.A.toLowerCase()
      let hit = 0
      for (const token of tokens) if (lower.includes(token)) hit++
      return { b, s: hit / tokens.length }
    })
    .sort((a, c) => c.s - a.s)
  const top = scored.slice(0, topK).filter(x => x.s > 0)
  const context = (top.length ? q + '\n\n参考资料：\n' : q) + top.map(x => `《${x.b.label || ''}》：${x.b.A}`).join('\n')
  return {
    method: 'lexical',
    total: blocks.length,
    context,
    blocks: top.map(x => ({ label: x.b.label, content: x.b.A, similarity: Number(x.s.toFixed(4)) })),
  }
}

/** 快捷：多个 .kb 文本（来自上传）直接检索 */
export function searchUploadedKbTexts(rawTexts: string[], query: string, topK = 5): LocalKbSearchResult | null {
  return lexicalSearchBlocks(kbJsonTextsToBlocks(rawTexts), query, topK)
}
