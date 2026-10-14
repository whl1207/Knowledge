/**
 * officeAi.ts — 把 AI-KM 当前模型配置归一化成「内嵌 Office 编辑器可用的一份连接信息」
 *
 * 编辑器把模型当作宿主注入的能力（见 docs/plan 附录 C）：它只发 `ai:stream` 请求，
 * 用哪家模型完全由宿主决定。这里负责把 store 里的多来源配置（ollama / openai / lmstudio /
 * deepseek / gpustack / custom …）压成两种线协议之一：
 *   kind: 'openai' → OpenAI 兼容 /chat/completions
 *   kind: 'ollama' → 原生 /api/chat（NDJSON 流）
 *
 * 暂不支持：anthropic / google / azure / deepseek-responses（协议不同，返回 null 表示不可用，
 * 编辑器 AI 面板会提示「未配置模型」而不是报错）。
 */
import { usestore, THEMES } from '@/store'
import { llmConfigByKey, deepSeekApiStyle } from '@/shared/llmSources'
import { AIUtils } from '@/services/ai-utils'

export interface OfficeAiConfig {
  kind: 'openai' | 'ollama'
  endpoint: string
  apiKey: string
  model: string
  label: string
  provider: string
}

/**
 * 基址 → 聊天端点。拼法与 AI-KM 各来源自身的用法保持一致：
 *  - GPUStack / 自定义来源 → AICore.buildCustomChatEndpoint（裸地址补 `/v1-openai/...`，见该函数注释）；
 *  - LM Studio / OpenAI / DeepSeek → `<基址>/v1/chat/completions`（基址已带 `/v1` 时不再重复）。
 *
 * ⚠️ 不要把 GPUStack 的规则套到 LM Studio 上：LM Studio 只认 `/v1/chat/completions`，
 * 打到 `/v1-openai/chat/completions` 时它会返回 **HTTP 200 + `{"error":"Unexpected endpoint…"}`**
 * （不是 4xx），流式解析拿不到任何增量，编辑器就会显示「AI 没有返回内容」。
 */
function chatEndpointOf(rawUrl: string, provider: string): string {
  const url = String(rawUrl || '').trim().replace(/\/+$/, '')
  if (!url) return ''
  if (/\/chat\/completions$/i.test(url) || /\/completions$/i.test(url)) return url
  // 显式写成 GPUStack 风格基址的来源，仍按 /v1-openai 前缀补全（保持既有行为）
  if (/\/v1-openai$/i.test(url)) return `${url}/chat/completions`
  if (provider === 'gpustack' || provider === 'custom') {
    const viaUtil = (AIUtils as any)?.buildCustomChatEndpoint
    if (typeof viaUtil === 'function') return String(viaUtil(url) || '')
    return `${url}/v1/chat/completions`
  }
  return `${url.replace(/\/v1$/i, '')}/v1/chat/completions`
}

/** 读取 AI-KM 当前模型连接信息；返回 null 表示当前来源不支持内嵌编辑器 */
export async function buildOfficeAiConfig(): Promise<OfficeAiConfig | null> {
  const store = usestore()
  const llm: any = (store as any).AIconfig?.llm
  if (!llm) return null

  const type = String(llm.type || '')
  const cfg: any = llmConfigByKey(llm, type) || {}
  let apiKey = ''
  try {
    apiKey = (await (store as any).resolveApiKey?.(cfg)) || ''
  } catch {
    /* 凭据解析失败时退回明文配置 */
  }
  apiKey = apiKey || cfg.api_key || cfg.apiKey || ''

  const label = (model: string) => `${type} · ${model}`

  switch (type) {
    case 'ollama': {
      const base = String(cfg.model_url || '').replace(/\/+$/, '')
      const model = String(cfg.model || '')
      if (!base || !model) return null
      return { kind: 'ollama', endpoint: `${base}/api/chat`, apiKey: '', model, label: label(model), provider: 'ollama' }
    }
    case 'openai':
    case 'lmstudio':
    case 'gpustack':
    case 'custom': {
      const endpoint = chatEndpointOf(type === 'custom' ? cfg.api_url : cfg.base_url, type)
      const model = String(cfg.model || '')
      if (!endpoint || !model) return null
      return { kind: 'openai', endpoint, apiKey: apiKey || 'not-needed', model, label: label(model), provider: type }
    }
    case 'deepseek': {
      // 仅支持 Chat Completions 风格；Responses API 风格暂不接入
      if (deepSeekApiStyle(llm) !== 'chat') return null
      const endpoint = chatEndpointOf(cfg.base_url, type)
      const model = String(cfg.model || '')
      if (!endpoint || !model) return null
      return { kind: 'openai', endpoint, apiKey: apiKey || 'not-needed', model, label: label(model), provider: 'deepseek' }
    }
    default:
      return null
  }
}

/**
 * 主题是否偏暗：按主题表里的背景色算相对亮度（0.2126R + 0.7152G + 0.0722B）。
 * AI-KM 的主题是命名主题（浅蓝 / 深色 / 午夜蓝…），没有明暗标记，
 * 早先用「名称里是否含暗/深」来猜，会漏判「午夜蓝」「灰色」这类名字不含暗字但确实是暗色的主题。
 */
function isDarkTheme(themeName: string): boolean {
  const hex = THEMES[themeName]?.backgroundColor
  if (!hex) return false
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex).trim())
  if (!m) return false
  const [r, g, b] = [1, 2, 3].map((i) => parseInt(m[i], 16) / 255)
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return luminance < 0.5
}

/** 宿主界面环境（编辑器要跟随主题与语言） */
export function officeEnvPayload(): { locale: string; dark: boolean } {
  const store = usestore()
  const themeName = String((store as any).UI?.theme || '')
  return {
    locale: store.locales === 'zh' ? 'zh-CN' : 'en-US',
    dark: isDarkTheme(themeName),
  }
}
