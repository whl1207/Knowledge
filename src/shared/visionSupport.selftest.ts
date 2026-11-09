/**
 * visionSupport.selftest.ts — 视觉能力三态判定 + 「图片不支持」错误识别
 *
 * 保护两件事：
 * 1) 名称启发式只对「明确像视觉模型」的返回 true，未知返回 undefined（不能误拦自命名视觉模型）；
 * 2) 服务端 400「不支持图片」能被识别，而去图重放不会把上下文超限/限流误判成图片问题。
 */

import { isImageUnsupportedError, isVisionLikeModel, modelSupportsVision } from './visionSupport'

export interface VisionSupportCase { name: string; ok: boolean; detail?: string }

export function runVisionSupportSelfTest(): VisionSupportCase[] {
  const cases: VisionSupportCase[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  add('deepseek-flash 支持视觉', modelSupportsVision('deepseek', 'deepseek-flash') === true)
  add('deepseek-v4-pro 不支持视觉', modelSupportsVision('deepseek', 'deepseek-v4-pro') === false)
  add('qwen2.5-vl 支持视觉', modelSupportsVision('ollama', 'qwen2.5-vl:7b') === true)
  add('llama3.1 纯文本 → 未知（不误拦）', modelSupportsVision('ollama', 'llama3.1:8b') === undefined)
  add('gpt-4o 支持视觉', modelSupportsVision('openai', 'gpt-4o') === true)
  add('空模型名 → 未知', modelSupportsVision('ollama', '') === undefined)
  add('显式 false 优先于名称', modelSupportsVision('openai', 'gpt-4o', { supportsVision: false }) === false)
  add('显式 true 优先于名称', modelSupportsVision('deepseek', 'deepseek-v4-pro', { supportsVision: true }) === true)
  add('旧 OCR 布尔入口仍可用', isVisionLikeModel('llava:13b') === true && isVisionLikeModel('llama3.1') === false)

  // 真实报文（OpenAI 兼容 / Ollama / DeepSeek / 200-SSE 网关）
  add('OpenAI image_url only supported',
    isImageUnsupportedError('HTTP错误! 状态码: 400 {"error":{"message":"Invalid content type. image_url is only supported by certain models."}}'))
  add('Ollama does not support images',
    isImageUnsupportedError('HTTP error! status: 400 this model does not support images'))
  add('DeepSeek image input unsupported',
    isImageUnsupportedError('状态码: 400 模型服务返回错误: this model does not support image input'))
  add('中文网关文案',
    isImageUnsupportedError('模型服务返回错误: 当前模型不支持图片输入，请使用纯文本'))
  add('上下文超限不误判',
    !isImageUnsupportedError('context_length_exceeded: image tokens exceed context window'))
  add('429 限流不误判为图片问题',
    !isImageUnsupportedError('status: 429 rate limit, image request rejected', 429))
  add('与图片无关的 400 不误判',
    !isImageUnsupportedError('status: 400 invalid_request_error: messages is required'))
  add('401 鉴权不误判',
    !isImageUnsupportedError('status: 401 image endpoint unauthorized', 401))

  return cases
}
