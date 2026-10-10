/**
 * drawio「复制为图片」用到的纯函数（无 Vue / store 依赖，便于单测与探针复用）。
 *
 * 流程：宿主向 drawio 内嵌协议要一张 scale=1 的 SVG → 解析逻辑尺寸 → 按用户选的倍率
 * 光栅化成 PNG → 交给主进程写系统剪贴板。
 *
 * 光栅化复用 Word 导出那套 `svgToPngDataUrl`（已在 mermaid → Word 路径上实测），
 * 但**默认不做净化**：`sanitizeSvgForCanvas` 会删掉所有 `<image>`、把 `<foreignObject>`
 * 标签降级成纯文本，而 drawio 导出的 SVG 里图片本就是 data URI（不会污染画布）、
 * 标签优先用 foreignObject 渲染（保留换行与富文本）。只有真的画布被污染时才退回净化版。
 */
import { svgToPngDataUrl, parseSvgSize } from '@/lib/markdown/mermaid'

/** 单张图片像素上限：约 32MP（位图约 128MB），超出按比例降倍率 */
export const MAX_IMAGE_PIXELS = 32_000_000

/** 可选倍率（按钮菜单里的三档） */
export const COPY_SCALES: Array<{ scale: number; zh: string; en: string }> = [
  { scale: 4, zh: '高清 4×', en: 'High 4×' },
  { scale: 2, zh: '标准 2×', en: 'Normal 2×' },
  { scale: 1, zh: '原始 1×', en: 'Original 1×' },
]

/** 解码 drawio 回传的 SVG（base64 / utf8 data URI，或已经是 SVG 原文） */
export function decodeSvgText(data: string): string {
  const v = String(data || '')
  if (!v) return ''
  const b64 = /^data:image\/svg\+xml;base64,/i.exec(v)
  if (b64) {
    try {
      const bin = atob(v.slice(b64[0].length))
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return new TextDecoder('utf-8').decode(bytes)
    } catch {
      return ''
    }
  }
  const utf8 = /^data:image\/svg\+xml;utf8,/i.exec(v)
  if (utf8) return decodeURIComponent(v.slice(utf8[0].length))
  if (v.startsWith('data:')) return ''
  // 原文（可能带 XML 声明）
  return /<svg[\s>]/i.test(v) ? v : ''
}

/** 图表的逻辑尺寸（px，即编辑器里 100% 缩放时的大小） */
export function svgLogicalSize(svg: string): { w: number; h: number } | null {
  const size = parseSvgSize(svg)
  if (!size || !(size.w > 0) || !(size.h > 0)) return null
  return { w: Math.round(size.w), h: Math.round(size.h) }
}

/**
 * 收敛倍率：不小于 1，且保证 w*n*h*n 不超过 maxPixels（超大图表自动降倍率，
 * 否则一次光栅化就要几百 MB 内存，还可能直接抛 "canvas is too large"）。
 */
export function clampScale(requested: number, w: number, h: number, maxPixels = MAX_IMAGE_PIXELS): number {
  const want = Math.max(1, Number(requested) || 1)
  const pixels = w * h
  if (!(pixels > 0) || !(maxPixels > 0)) return want
  const maxScale = Math.sqrt(maxPixels / pixels)
  if (want <= maxScale) return want
  // 降档到 0.25 的整数倍，避免出现 2.37 这种怪倍率（下限 1）
  const stepped = Math.max(1, Math.floor(maxScale * 4) / 4)
  return Math.min(want, stepped)
}

/**
 * SVG → PNG data URL。
 * drawio 导出的 SVG 用 `<switch><foreignObject>` 渲染富文本标签，用 blob: 加载时
 * Chromium 会判定画布污染（toDataURL 抛 SecurityError），所以这里直接用 data URI 加载；
 * 万一仍失败（跨域图片等）再退回净化版（把 foreignObject 降级成 <text>、去掉 <image>）。
 */
export async function drawioSvgToPngDataUrl(
  svg: string,
  scale: number,
  size?: { w: number; h: number } | null,
): Promise<string> {
  const explicit = size && size.w > 0 && size.h > 0 ? size : undefined
  try {
    return await svgToPngDataUrl(svg, scale, explicit, { sanitize: false, urlMode: 'data' })
  } catch (e) {
    try {
      return await svgToPngDataUrl(svg, scale, explicit, { urlMode: 'data' })
    } catch {
      throw e
    }
  }
}
