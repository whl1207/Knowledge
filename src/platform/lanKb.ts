// src/platform/lanKb.ts — 局域网共享知识库
// 主机在「设置 → 协作 → 局域网共享」配置知识库目录后，LAN HTTP 服务暴露：
//   GET /api/kb/list   列出共享目录中的 .kb
//   GET /api/kb/read   读取某个 .kb 的完整 JSON
//   GET /api/kb/search 对某个 .kb 检索（主机侧向量化/词法匹配）
// 远端网页端（无 ipcRenderer）在 home 知识库模式通过这些接口「选择终端设定的文件夹中现有的
// 知识库」来使用；也可继续上传自己的文件作为知识库。主机端负责把知识库目录 + 嵌入配置同步给主进程。
import * as kbAi from '@/shared/kbAiClient'
import { normalizeLlmType } from '@/shared/llmSources'

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
