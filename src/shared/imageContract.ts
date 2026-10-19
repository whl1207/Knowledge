/**
 * imageContract.ts — 插件生图能力的**契约层**（纯逻辑，渲染层与自测共用）
 *
 * 与 DSH 的关系（先把话说清楚）：DSH **没有生图能力**——它在 asar 里与图片相关的只有
 * `dsh-attachment`（附件）与 `dsh-compaction-image-offload`（视觉 token 卸载），都是**输入侧**。
 * 所以这里"参照 DSH"指的是照它的**能力缝样式**（`dsh-llm` 那一套）：
 * - **一份契约**（`ctx.image`），实现可换（当前是本地 Qwen-Image Gradio 服务）；
 * - **稳定错误码**（`IMAGE_*`），插件按 code 分支，不解析文案；
 * - **显式取消**（`AbortSignal` + 插件级 `cancelAll`），失败**不抛异常**而是返回结构化结果；
 * - **不把密钥交给插件**（token 由用户在设置里配置，插件只拿"能画/不能画"与原因）。
 *
 * 有意不做：把生成结果写进用户的相册/知识库——插件拿到 URL 后要不要落盘、落哪，
 * 由它用 `ctx.fs`（用户授权过的路径）自己决定。
 */

export const IMAGE_ERROR_CODES = [
  'IMAGE_NOT_CONFIGURED',
  'IMAGE_UNREACHABLE',
  'IMAGE_TIMEOUT',
  'IMAGE_CANCELLED',
  'IMAGE_NO_PROMPT',
  'IMAGE_TOO_MANY_REFS',
  'IMAGE_FAILED',
] as const

export type ImageErrorCode = (typeof IMAGE_ERROR_CODES)[number]

export function isImageErrorCode(value: unknown): value is ImageErrorCode {
  return typeof value === 'string' && (IMAGE_ERROR_CODES as readonly string[]).includes(value)
}

/** 一张生成出来的图（`url` 可直接放进 <img src>；`path` 是服务端路径，诊断用） */
export interface PluginImage {
  url: string
  path?: string
}

export interface PluginImageRequest {
  prompt: string
  negative?: string
  width?: number
  height?: number
  steps?: number
  /**
   * 参考图（base64，不含 data: 前缀；最多 3 张）。
   * ⚠️ 参考图**不需要** `fs` 权限：它是插件自己拿到的数据，不是用户文件。
   */
  reference?: Array<{ base64: string; mimeType?: string }>
  /** 单次等待上限（含模型冷启动）；默认 5 分钟，上限 15 分钟 */
  timeoutMs?: number
  signal?: AbortSignal
  /** 进度回调：服务端队列位置 / 一行日志（可选） */
  onProgress?: (progress: { queue?: number; logLine?: string }) => void
}

export interface PluginImageResult {
  /** 成功与否由 `code` 缺省判断：只有 `ok === true` 才有 images */
  ok: boolean
  images: PluginImage[]
  code?: ImageErrorCode
  error?: string
  elapsedMs: number
  /** 服务端日志尾部（失败时最有用） */
  log?: string
}

export interface PluginImageInfo {
  /** 设置页点过「测试连接」后为 true；未连过但服务在跑也可能画出图 */
  connected: boolean
  version: string
  modelType: string
  base: string
}

/** 生图参数的硬边界（与 `qwenImageGenerate` 内部一致，避免两处各写一套数字） */
export const IMAGE_LIMITS = {
  minSide: 256,
  maxSide: 4096,
  defaultSide: 1024,
  minSteps: 1,
  maxSteps: 100,
  defaultSteps: 4,
  maxRefs: 3,
  defaultTimeoutMs: 5 * 60_000,
  maxTimeoutMs: 15 * 60_000,
} as const

export type NormalizedImageRequest =
  | {
      ok: true
      prompt: string
      negative: string
      width: number
      height: number
      steps: number
      refs: Array<{ base64: string; mimeType?: string }>
      timeoutMs: number
    }
  | { ok: false; code: ImageErrorCode; message: string }

const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/**
 * 归一化请求：夹紧尺寸/步数/超时、限制参考图数量、校验提示词。
 * 放在契约层是为了让"参数不合法的判定"两侧只有一份（自测直接打这里）。
 */
export function normalizeImageRequest(
  request: Partial<PluginImageRequest> | undefined,
  defaults: { width?: number; height?: number; steps?: number; negative?: string } = {},
): NormalizedImageRequest {
  const prompt = String(request?.prompt ?? '').trim()
  if (!prompt) return { ok: false, code: 'IMAGE_NO_PROMPT', message: 'prompt 不能为空' }
  const refs = Array.isArray(request?.reference) ? request.reference.filter((r) => r && typeof r.base64 === 'string' && r.base64) : []
  if (refs.length > IMAGE_LIMITS.maxRefs) {
    return { ok: false, code: 'IMAGE_TOO_MANY_REFS', message: `参考图最多 ${IMAGE_LIMITS.maxRefs} 张（收到 ${refs.length} 张）` }
  }
  return {
    ok: true,
    prompt,
    negative: String(request?.negative ?? defaults.negative ?? '').trim(),
    width: clampInt(request?.width ?? defaults.width, IMAGE_LIMITS.minSide, IMAGE_LIMITS.maxSide, IMAGE_LIMITS.defaultSide),
    height: clampInt(request?.height ?? defaults.height, IMAGE_LIMITS.minSide, IMAGE_LIMITS.maxSide, IMAGE_LIMITS.defaultSide),
    steps: clampInt(request?.steps ?? defaults.steps, IMAGE_LIMITS.minSteps, IMAGE_LIMITS.maxSteps, IMAGE_LIMITS.defaultSteps),
    refs,
    timeoutMs: clampInt(request?.timeoutMs, 5_000, IMAGE_LIMITS.maxTimeoutMs, IMAGE_LIMITS.defaultTimeoutMs),
  }
}

/**
 * 错误分类。上游是 Gradio 的 HTTP/轮询错误，只有 message，所以这里"看文案"分类——
 * 仅用于让插件能分支（**不是**权限判据），分不出来一律 `IMAGE_FAILED`。
 */
export function classifyImageError(error: unknown, aborted = false): ImageErrorCode {
  if (aborted) return 'IMAGE_CANCELLED'
  const text = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase()
  if (/超时|timeout|timed out/.test(text)) return 'IMAGE_TIMEOUT'
  if (/无法连接|连接失败|econnrefused|failed to fetch|networkerror|http 5|http 4|缺少 add_task/.test(text)) return 'IMAGE_UNREACHABLE'
  if (/未配置|no.*url|服务地址/.test(text)) return 'IMAGE_NOT_CONFIGURED'
  if (/请输入提示词|prompt/.test(text)) return 'IMAGE_NO_PROMPT'
  return 'IMAGE_FAILED'
}
