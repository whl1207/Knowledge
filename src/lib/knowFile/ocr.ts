/**
 * OCR 公共调用（PDF 单页 / 图片共用）
 *
 * 来源**不再写死 Ollama**，且可在 OCR 面板里显式选择：
 * 默认跟随「当前模型来源」（`llm.type`），可手动换成 Ollama / LM Studio / DeepSeek / GPUStack /
 * 自定义(OpenAI 兼容) / OpenAI / Anthropic / Google / Azure —— 只要是视觉模型都能用来做 OCR。
 * （DeepSeek：`deepseek-flash` 支持图像理解，`deepseek-v4-pro` 不支持，详见
 *  https://api-docs.deepseek.com/zh-cn/guides/vision ）
 *
 * 调用统一走 `AIUtils.sendChat`：Electron 下委托主进程、浏览器/LAN 模式下走代理，
 * 图片通过多模态消息（`message.images` → OpenAI `image_url` / Ollama `images`）传递。
 *
 * 另一件事：新版 Ollama（llama-server 引擎）内置死循环守卫 —— 连续 101 个「TrimSpace 后内容完全相同」
 * 的流式输出块会被判定为复读，直接中断请求并返回 HTTP 500：
 *   "prediction aborted, token repeat limit reached"（见 ollama/ollama llm/llama_server.go）
 * 该守卫在服务端，客户端无法关闭。因此这里做两件事：
 *   1. 请求侧主动下发重复抑制采样参数（Ollama：repeat_penalty / repeat_last_n / stop / seed；
 *      其它 OpenAI 兼容后端：temperature / top_p / presence_penalty / frequency_penalty）；
 *   2. 命中复读后换一套更强的抑制参数重试（用同一套参数重试必然再次失败）。
 */
import { AIUtils } from '@/services/ai-utils'
import { deepSeekConfig, normalizeLlmType } from '@/shared/llmSources'
import { prepareImageDataUrl } from '@/lib/image/prepareImage'

/** Ollama 生成参数（options），仅列出 OCR 需要的字段 */
export interface OcrGenOptions {
  temperature: number
  top_p: number
  top_k: number
  repeat_penalty: number
  repeat_last_n: number
  presence_penalty: number
  frequency_penalty: number
  num_predict: number
  seed?: number
  stop?: string[]
}

/** 常见复读控制符：模型陷入复读时提前收尾，避免被服务端守卫判死 */
const LOOP_STOP_TOKENS = ['<|endoftext|>', '<|end_of_text|>', '<|im_end|>', '<|eot_id|>', '</s>', '<｜end▁of▁sentence｜>']

/** OCR 输入图片最长边上限：过大的图会让视觉模型更容易陷入复读，且传输慢 */
export const OCR_MAX_IMAGE_SIDE = 1600

/**
 * 逐级加强的重复抑制预设：
 * - 第 1 次：贴近默认采样，仅补上温和的重复抑制
 * - 第 2 / 3 次：加强 repeat_penalty、扩大 repeat_last_n、提高温度并换随机种子，跳出确定性复读
 */
export const OCR_ATTEMPT_OPTIONS: OcrGenOptions[] = [
  {
    temperature: 0.1, top_p: 0.9, top_k: 40,
    repeat_penalty: 1.08, repeat_last_n: 320,
    presence_penalty: 0.1, frequency_penalty: 0.1,
    num_predict: 8192, stop: LOOP_STOP_TOKENS,
  },
  {
    temperature: 0.35, top_p: 0.9, top_k: 60,
    repeat_penalty: 1.25, repeat_last_n: 512,
    presence_penalty: 0.35, frequency_penalty: 0.35,
    num_predict: 8192, seed: randomSeed(), stop: LOOP_STOP_TOKENS,
  },
  {
    temperature: 0.6, top_p: 0.95, top_k: 80,
    repeat_penalty: 1.45, repeat_last_n: 1024,
    presence_penalty: 0.5, frequency_penalty: 0.5,
    num_predict: 8192, seed: randomSeed(), stop: LOOP_STOP_TOKENS,
  },
]

/** 单页 OCR 的最大尝试次数（= 预设档数） */
export const OCR_MAX_ATTEMPTS = OCR_ATTEMPT_OPTIONS.length

function randomSeed(): number {
  return Math.floor(Math.random() * 2147483647)
}

function errMessage(err: unknown): string {
  if (!err) return ''
  const msg = err instanceof Error ? err.message : String(err)
  return (msg || '').trim()
}

/** 是否为 Ollama 服务端「输出重复」硬中断（token repeat limit / prediction aborted） */
export function isRepeatLimitError(err: unknown): boolean {
  return /token repeat limit|prediction aborted/i.test(errMessage(err))
}

/** 简短失败原因（进度提示用） */
export function ocrShortReason(err: unknown, zh: boolean): string {
  if (isRepeatLimitError(err)) return zh ? '模型输出重复被服务端中断' : 'repetition loop aborted by server'
  const raw = errMessage(err)
  if (!raw) return zh ? '未知错误' : 'unknown error'
  return raw.length > 80 ? `${raw.slice(0, 80)}…` : raw
}

/** 最终失败文案（带排查建议） */
export function ocrErrorText(err: unknown, zh: boolean): string {
  const raw = errMessage(err)
  if (isRepeatLimitError(err)) {
    return zh
      ? `模型输出陷入重复，已被 Ollama 服务端强制中断（token repeat limit reached；新版 Ollama 的死循环保护，客户端无法关闭）。`
        + `建议换用其他 OCR 视觉模型、缩小输入图片，或调整远端 Ollama 版本。`
        + (raw ? `原始信息：${raw}` : '')
      : `The model fell into a repetition loop and Ollama aborted the request server-side (token repeat limit reached; a hard guard in newer Ollama builds that clients cannot disable). `
        + `Try another OCR vision model, a smaller image, or a different Ollama build.`
        + (raw ? ` Raw: ${raw}` : '')
  }
  return raw || (zh ? '未知错误' : 'Unknown error')
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// 来源（provider）：面板里可显式选择，默认跟随「当前模型来源」
// ---------------------------------------------------------------------------

/**
 * OCR 可选来源（面板下拉顺序）。都能传图片：
 * - ollama / lmstudio / gpustack / custom / openai：OpenAI 兼容 image_url（或 Ollama images）
 * - deepseek：deepseek-flash 支持图像理解（deepseek-v4-pro 不支持）；
 *   Chat 端点用 image_url data URL，Responses 端点用 input_image（由接口样式决定）
 * - anthropic / google / azure：各自原生图片块
 */
export const OCR_SELECTABLE_SOURCES = ['ollama', 'lmstudio', 'deepseek', 'gpustack', 'custom', 'openai', 'anthropic', 'google', 'azure']

/** 记住用户选的 OCR 来源（仅 OCR 用，不写回主模型来源设置） */
export const OCR_SOURCE_PREF_KEY = 'ocr-source'

export function loadOcrSourcePref(): string {
  try {
    // 单来源：历史别名 'deepseek-responses' 归一到 'deepseek'
    return normalizeLlmType(localStorage.getItem(OCR_SOURCE_PREF_KEY) || '')
  } catch { return '' }
}

export function saveOcrSourcePref(provider: string): void {
  if (!provider) return
  try { localStorage.setItem(OCR_SOURCE_PREF_KEY, normalizeLlmType(provider)) } catch { /* 忽略 */ }
}

const PROVIDER_LABELS: Record<string, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  gpustack: 'GPUStack',
  custom: 'Custom',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  anthropic: 'Anthropic',
  google: 'Google',
  azure: 'Azure',
}

/** 来源显示名（面板提示用） */
export function ocrProviderLabel(key: string): string {
  const k = normalizeLlmType(key)
  return PROVIDER_LABELS[k] || k || 'Ollama'
}

/**
 * 取某来源的连接配置（与 store.currentLLMConfig 同一套映射；custom 取激活来源）。
 * 配置里带 model 字段，OCR 调用时会被目标模型名覆盖。
 */
export function llmConfigByKey(llm: any, key: string): any {
  if (!llm) return null
  switch (normalizeLlmType(key)) {
    case 'ollama': return llm.ollama
    case 'lmstudio': return llm.lmstudio
    case 'openai': return llm.openai
    case 'deepseek': return deepSeekConfig(llm)
    case 'gpustack': return llm.gpustack
    case 'anthropic': return llm.anthropic
    case 'google': return llm.google
    case 'azure': return llm.azure
    case 'custom': {
      const c = llm.custom
      if (!c) return null
      const srcs = Array.isArray(c.sources) ? c.sources : []
      const idx = (typeof c.activeIndex === 'number' && c.activeIndex >= 0 && c.activeIndex < srcs.length) ? c.activeIndex : 0
      return srcs[idx] ? { ...c, ...srcs[idx] } : c
    }
    default: return null
  }
}

/** 模型名里含 ocr → 最可能是 OCR 专用模型（deepseek-ocr / glm-ocr / olmocr / nanonets-ocr …） */
const OCR_NAME_RE = /ocr/i
/**
 * 通用视觉/多模态模型名关键词（挑不到 ocr 时退而求其次）。
 * 取值刻意保守，只认「明确带 vision/vl/多模态」的命名，避免把纯文本模型误判为能识图
 * （例如 granite-3.1-8b-instruct、llama-3.2-3b、gemma-3-1b 这类文本模型不能进来自动选中）。
 */
const VISION_NAME_RE = /(vision|multimodal|llava|bakllava|moondream|minicpm-v|internvl|florence|pixtral|idefics|smolvlm|janus|glm-?4v|qwen.*vl|[-_.]vl[-_.\d]|gemma-?3-(?:4|12|27)b|llama-?3\.2-(?:11|90)b)/i

/** 云厂商模型名里没有视觉关键词 → 按来源补规则 */
const PROVIDER_VISION_HINTS: Record<string, RegExp> = {
  // DeepSeek：deepseek-flash 支持图像理解（旧名 deepseek-v4-flash-vision-exp 仍可调用）
  deepseek: /(flash|vision)/i,
  openai: /(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|o3|o4)/i,
  anthropic: /claude/i,
  google: /gemini/i,
}

/** 已知不支持图像理解的模型（按来源排除） */
const PROVIDER_NON_VISION: Record<string, RegExp> = {
  // DeepSeek 官方模型表：图像理解「deepseek-flash 支持 / deepseek-v4-pro 不支持」
  deepseek: /(v4-pro|reasoner)/i,
}

/** 单个模型是否「看起来能识图」（带来源上下文，云厂商命名按 PROVIDER_* 规则判定） */
export function isVisionLikeModel(name: string, provider?: string): boolean {
  const s = String(name || '').trim()
  if (!s) return false
  const p = provider ? normalizeLlmType(provider) : undefined
  if (p && PROVIDER_NON_VISION[p]?.test(s)) return false
  if (OCR_NAME_RE.test(s) || VISION_NAME_RE.test(s)) return true
  const hint = p ? PROVIDER_VISION_HINTS[p] : undefined
  return !!hint && hint.test(s)
}

/**
 * 来源模型列表排序：OCR 专用 → 视觉模型 → 其它。
 * 不过滤掉任何模型（用户可能用名字里没有关键词的视觉模型），只保证「像 OCR 的排在前面」。
 */
export function rankOcrModels(models: any[], provider?: string): string[] {
  const uniq = Array.from(new Set((models || []).map((m) => String(m || '').trim()).filter(Boolean)))
  const ocr: string[] = []
  const vision: string[] = []
  const rest: string[] = []
  for (const m of uniq) {
    if (OCR_NAME_RE.test(m)) ocr.push(m)
    else if (isVisionLikeModel(m, provider)) vision.push(m)
    else rest.push(m)
  }
  return [...ocr, ...vision, ...rest]
}

/**
 * 列表里是否存在「看起来能识图」的模型。
 * 自动选模型前用它判断，避免把纯文本模型（deepseek-v4-pro 等）自动选上。
 */
export function hasVisionLikeModel(models: any[], provider?: string): boolean {
  return (models || []).some((m) => isVisionLikeModel(String(m || ''), provider))
}

/** 按来源记住上次选的 OCR 模型（换来源不会串味） */
const OCR_MODEL_PREF_PREFIX = 'ocr-model:'
export function loadOcrModelPref(provider: string): string {
  try { return localStorage.getItem(OCR_MODEL_PREF_PREFIX + provider) || '' } catch { return '' }
}

export function saveOcrModelPref(provider: string, model: string): void {
  if (!provider || !model) return
  try { localStorage.setItem(OCR_MODEL_PREF_PREFIX + provider, model) } catch { /* 忽略 */ }
}

// ---------------------------------------------------------------------------
// 调用
// ---------------------------------------------------------------------------

export interface OcrRunOptions {
  /** 模型来源：ollama / lmstudio / gpustack / custom / openai ... */
  provider: string
  /** 该来源的连接配置（model_url / base_url / api_key 等） */
  config: any
  /** 视觉模型名 */
  model: string
  /** 图片 base64（不含 data URL 前缀，且须为 JPEG —— 见 prepareOcrImage） */
  imageBase64: string
  /** 提示词 */
  prompt: string
  /** 是否中文文案 */
  zh?: boolean
  /** 返回 true 表示用户已取消：当次结果作废、立即返回空串 */
  cancelled?: () => boolean
  /** 第 2 次起回调（用于 UI 显示「重试 n/N」）；reason 为简短失败原因 */
  onRetry?: (attempt: number, total: number, reason: string) => void
}

/** 单次请求：按档位下发采样参数（Ollama 走 options，其它后端走顶层字段） */
async function runOcrOnce(opts: OcrRunOptions, level: OcrGenOptions): Promise<string> {
  const llmConfig: any = {
    stream: false,
    temperature: level.temperature,
    top_p: level.top_p,
    max_tokens: level.num_predict,
    // 抑制复读：OpenAI 兼容后端（LM Studio / GPUStack / 自定义）只认这两个惩罚项
    frequency_penalty: level.frequency_penalty,
    presence_penalty: level.presence_penalty,
  }
  if (opts.provider === 'ollama') {
    // Ollama 专属：重复惩罚 / 重复窗口 / top_k / stop / seed + 保活
    llmConfig.options = { ...level }
    llmConfig.keep_alive = '5m'
  }
  const messages = [{ role: 'user', content: opts.prompt, images: [opts.imageBase64] }]
  const cfg = { ...(opts.config || {}), model: opts.model }
  const text = await AIUtils.sendChat(opts.provider, cfg, llmConfig, messages as any, {})
  return String(text || '')
}

/**
 * 做单张图片 OCR。内部按 OCR_ATTEMPT_OPTIONS 逐级加强重复抑制重试；
 * 全部失败时抛出带建议的 Error；用户取消时返回空串。
 */
export async function ocrImage(opts: OcrRunOptions): Promise<string> {
  const zh = opts.zh !== false
  const total = OCR_ATTEMPT_OPTIONS.length
  let lastErr: unknown = null

  for (let i = 0; i < total; i++) {
    if (opts.cancelled?.()) return ''
    if (i > 0) {
      opts.onRetry?.(i + 1, total, ocrShortReason(lastErr, zh))
      await sleep(1000)
      if (opts.cancelled?.()) return ''
    }
    try {
      const text = await runOcrOnce(opts, OCR_ATTEMPT_OPTIONS[i])
      if (text.trim()) return text
      lastErr = new Error(zh ? '模型返回空内容' : 'model returned empty content')
    } catch (err) {
      if (opts.cancelled?.()) return ''
      lastErr = err
    }
  }

  throw new Error(ocrErrorText(lastErr, zh))
}

// ---------------------------------------------------------------------------
// 图片预处理
// ---------------------------------------------------------------------------

/**
 * OCR 输入图预处理：按最长边等比缩小 + 转 JPEG（白底）。
 * 实现已抽到共享模块 `lib/image/prepareImage.ts`（与 agent 上传图片共用同一套逻辑），
 * 这里保留旧名字供现有调用点使用。
 */
export async function prepareOcrImage(dataUrl: string, maxSide = OCR_MAX_IMAGE_SIDE, quality = 0.9): Promise<string> {
  return prepareImageDataUrl(dataUrl, maxSide, quality)
}
