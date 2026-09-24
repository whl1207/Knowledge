/**
 * image/prepareImage.ts — 上传图片统一预处理（渲染进程）
 *
 * 被两处共用：
 * - OCR（`lib/knowFile/ocr.ts`，PDF 页渲染图 / 图片文件）
 * - 智能体上传图片（`composables/useAgentRun.ts`，agent 循环的任务附图）
 *
 * 做两件事：按最长边等比缩小 + **统一转 JPEG（白底）**。
 * 为什么要强制 JPEG：
 * - OpenAI 兼容后端（LM Studio / GPUStack / 自定义 / DeepSeek）的图片按 `data:image/jpeg;base64,` 声明
 *   （见 shared/ai-core.ts 的 toOpenAIMessages），PNG 原文会被标错 mime；
 * - 透明底 PNG 转 JPEG 会变黑，故先铺白底。
 * 图片很大的另一个代价：agent 循环每个 step 都会把历史里的图片再发一次，图越大越慢越贵。
 *
 * 环境不支持 canvas / 转码失败时原样返回（交给后端自己按内容判断）。
 */

/** 默认最长边上限（px）：多数视觉模型内部也会缩到 ~1300–1600 */
export const DEFAULT_IMAGE_MAX_SIDE = 1600

/** 加载图片元素（失败即抛） */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片加载失败'))
    img.src = src
  })
}

/**
 * 图片 data URL 预处理：按最长边等比缩小 + 转 JPEG（白底）。
 * @param dataUrl  源图（必须是 data URL；Uint8Array 等请先用 AIUtils.imageDataUrl 转换）
 * @param maxSide  最长边上限（<=0 表示不限尺寸，仅转码）
 * @param quality  JPEG 质量
 */
export async function prepareImageDataUrl(
  dataUrl: string,
  maxSide = DEFAULT_IMAGE_MAX_SIDE,
  quality = 0.9,
): Promise<string> {
  if (!dataUrl) return dataUrl
  if (typeof document === 'undefined' || typeof Image === 'undefined') return dataUrl
  try {
    const img = await loadImage(dataUrl)
    const w0 = img.naturalWidth || 0
    const h0 = img.naturalHeight || 0
    if (!w0 || !h0) return dataUrl
    const longSide = Math.max(w0, h0)
    const ratio = maxSide > 0 && longSide > maxSide ? maxSide / longSide : 1
    const w = Math.max(1, Math.round(w0 * ratio))
    const h = Math.max(1, Math.round(h0 * ratio))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return dataUrl
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, w, h)
    const out = canvas.toDataURL('image/jpeg', quality)
    return out && out.length > 32 ? out : dataUrl
  } catch {
    return dataUrl
  }
}
