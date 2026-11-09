/**
 * visionSupport.ts — 模型是否支持图片输入的判定（主进程 / 渲染层共用，纯函数）
 *
 * 为什么要单独一个模块：
 * - 以前只有 OCR 面板用名称启发式判断「能不能识图」（src/lib/knowFile/ocr.ts），
 *   聊天 / 智能体请求从不判断，图片一律塞给服务端；非视觉模型直接 400，
 *   而 agent-loop 把 400 当致命错误，整轮就中止了（用户看到「不是多模态模型」）。
 * - 这里把判定收敛成三态：true（确定支持）/ false（确定不支持）/ undefined（不知道）。
 *   **只有 false 才拦图片**：名称里没有 vision 的本地模型也可能是视觉模型，
 *   把它判成 false 会误伤；不知道就交给「请求失败后去图重放」兜底。
 *
 * 判定优先级：显式开关（用户 / 预设 / provider 探测）> 已知不支持 > 名称启发式。
 * 纯函数、无 electron / DOM 依赖，可直接被 selftest 调用。
 */

import { normalizeLlmType } from '@/shared/llmSources'
import { parseHttpStatus } from '@/shared/llmRetry'

/** 模型名里含 ocr → 最可能是 OCR 专用模型（deepseek-ocr / glm-ocr / olmocr / nanonets-ocr …） */
const OCR_NAME_RE = /ocr/i

/**
 * 通用视觉/多模态模型名关键词（挑不到 ocr 时退而求其次）。
 * 取值刻意保守，只认「明确带 vision/vl/多模态」的命名，避免把纯文本模型误判为能识图。
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

/**
 * 单个模型是否「看起来能识图」（带来源上下文，云厂商命名按 PROVIDER_* 规则判定）。
 * 兼容旧调用（OCR 面板）：返回布尔值。
 */
export function isVisionLikeModel(name: string, provider?: string): boolean {
  const s = String(name || '').trim()
  if (!s) return false
  const p = provider ? normalizeLlmType(provider) : undefined
  if (p && PROVIDER_NON_VISION[p]?.test(s)) return false
  if (OCR_NAME_RE.test(s) || VISION_NAME_RE.test(s)) return true
  const hint = p ? PROVIDER_VISION_HINTS[p] : undefined
  return !!hint && hint.test(s)
}

export type VisionSupport = true | false | undefined

export interface VisionSupportOptions {
  /**
   * 显式能力（最高优先级）：用户配置 / 预设声明 / provider 的 capabilities 探测结果。
   * 传 true/false 时不再看名称；传 undefined 走启发式。
   */
  supportsVision?: boolean
  /** 名称启发式是否可用（默认 true；某些调用方只信显式值时可关掉） */
  useNameHints?: boolean
}

/**
 * 模型是否支持图片输入。
 *
 * @returns true 确定支持 / false 确定不支持 / undefined 不知道（不要据此拦截图片）
 */
export function modelSupportsVision(
  provider: string | undefined,
  model: string | undefined,
  options: VisionSupportOptions = {},
): VisionSupport {
  if (typeof options.supportsVision === 'boolean') return options.supportsVision
  const name = String(model || '').trim()
  if (!name) return undefined
  if (options.useNameHints === false) return undefined
  const p = provider ? normalizeLlmType(provider) : undefined
  if (p && PROVIDER_NON_VISION[p]?.test(name)) return false
  if (OCR_NAME_RE.test(name) || VISION_NAME_RE.test(name)) return true
  const hint = p ? PROVIDER_VISION_HINTS[p] : undefined
  if (hint && hint.test(name)) return true
  return undefined
}

/** 错误正文里出现这些词 → 说明这是「图片内容」相关的请求错误 */
const IMAGE_ERROR_HINT = /(?:image_url|image input|image content|image type|\bimages?\b|图片|图像|多模态|视觉|\bvision\b|\bmultimodal\b|\bvlm\b)/i

/** 错误正文里出现这些词 → 说明服务端明确「不支持 / 类型非法」 */
const IMAGE_UNSUPPORTED_HINT = /(?:not\s+support|unsupport|does\s+not\s+support|only\s+support|must\s+be\s+text|text[- ]only|not\s+a\s+multimodal|invalid\s*(?:content|type|value)|不支持|仅支持|只支持|无法(?:处理|识别)|不是多模态)/i

/**
 * 判断一次 LLM 请求失败是否由「模型不支持图片输入」造成。
 *
 * 命中后调用方应做两件事：把本会话的图片从请求投影里去掉、**重放一次**，
 * 而不是把整个 turn 结束掉。这里只做文本/状态判断，不依赖 provider 类型。
 *
 * 注意排除：
 * - 上下文超限（正文里可能带 image 字样，但那是另一条自愈路径）；
 * - 图片过大 / 下载失败（这类重试同一图片仍会失败，但去图继续通常也可接受；
 *   为避免误判成「不支持视觉」，这里只认「不支持 / 类型非法」措辞）。
 */
export function isImageUnsupportedError(message: string, status?: number): boolean {
  const text = String(message || '')
  if (!text) return false
  // 上下文超限有自己的压缩重放路径，不要在这里抢
  if (/context[\s_-]*(length|window)|上下文(长度)?(超|过)限|超出(最大)?上下文|prompt is too long|too many tokens/i.test(text)) {
    return false
  }
  if (!IMAGE_ERROR_HINT.test(text)) return false
  if (!IMAGE_UNSUPPORTED_HINT.test(text)) return false
  const code = typeof status === 'number' ? status : parseHttpStatus(text)
  // 400 / 415 / 422 是「请求内容类型不被接受」的典型状态；部分网关用 200 + SSE error，只能看文本
  if (typeof code === 'number' && code >= 400 && code !== 400 && code !== 415 && code !== 422) {
    // 例如 401/403/404/429 与图片无关，避免误判
    return false
  }
  return true
}
