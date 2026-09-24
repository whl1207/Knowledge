/**
 * 共享 Mermaid 渲染工具模块
 * - SVG 缓存：按内容哈希缓存渲染结果，避免流式渲染闪烁
 * - 提供 render 和 cache 操作
 */
import mermaid from 'mermaid'
import { normalizeMermaidSource } from './mermaid-normalize'

// SVG 缓存：contentHash → svgString
const svgCache = new Map<string, string>()

// 已初始化标记
let initialized = false

// Mermaid 基础配置（预览用 HTML 标签；导出时临时切换为纯文本标签，避免 foreignObject 污染 canvas）
// 注意：mermaid v11 的 flowchart v2 渲染器读「顶层 htmlLabels」键，而不是 flowchart.htmlLabels
const baseConfig: any = {
  startOnLoad: false,
  securityLevel: 'loose',
  theme: 'default',
  htmlLabels: true,
  flowchart: { htmlLabels: true },
  // 渲染失败时直接抛错，不要让 mermaid 往页面里插「Syntax error in text」错误图
  // （所有宿主都有各自的失败占位；不关掉会在 <body> 里留下散落节点）
  suppressErrorRendering: true,
}

/** 确保 mermaid 只初始化一次 */
export function ensureMermaidInit(): void {
  if (initialized) return
  mermaid.initialize(baseConfig)
  initialized = true
}

/** 简单快速的内容哈希 */
export function hashContent(content: string): string {
  let hash = 0
  const text = content.trim()
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash |= 0
  }
  return 'mh_' + Math.abs(hash).toString(36)
}

/** 获取缓存的 SVG，不存在返回 undefined */
export function getCachedSvg(content: string): string | undefined {
  const key = hashContent(content)
  return svgCache.get(key)
}

/** 将 mermaid 源码渲染为 SVG 字符串（带缓存） */
export async function renderMermaidSvg(source: string): Promise<string> {
  ensureMermaidInit()

  const key = hashContent(source)
  const cached = svgCache.get(key)
  if (cached) return cached

  const renderId = `mermaid-render-${key}-${Date.now()}`
  try {
    const { svg } = await mermaid.render(renderId, source)
    // 缓存结果
    svgCache.set(key, svg)
    return svg
  } catch (err) {
    console.error('[Mermaid] render failed:', err)
    throw err
  }
}

/**
 * 推荐入口：规范化 + 渲染。
 *
 * 画图源码里「未加引号的标签」很常见（如 `C{关键催化剂：第二次世界大战 (WWII)}`、
 * `C[数学模型 (Math Models)]`），mermaid 遇到半角括号会直接 Parse error，
 * 必须先过 normalizeMermaidSource 加引号。**所有宿主统一走这里**，
 * 否则会出现「编辑器里报图表渲染失败、点展开却能显示」这种不一致。
 *
 * 规范化本身也可能把本来能解析的源码改坏（历史上踩过：边标签 `--"x{y}"-->` 被二次加引号），
 * 所以规范化失败时退回原始源码再试一次。
 */
export async function renderMermaidSvgLenient(source: string): Promise<string> {
  const normalized = normalizeMermaidSource(source)
  try {
    return await renderMermaidSvg(normalized)
  } catch (err) {
    if (normalized === source) throw err
    try {
      const svg = await renderMermaidSvg(source)
      // 回退成功也补一份规范化键的缓存：宿主按规范化键查询时同样能命中
      svgCache.set(hashContent(normalized), svg)
      return svg
    } catch {
      throw err
    }
  }
}

/** 缓存查询：与 renderMermaidSvgLenient 用同一个键（规范化后的源码） */
export function getCachedSvgLenient(source: string): string | undefined {
  return svgCache.get(hashContent(normalizeMermaidSource(source)))
}

/** 导出专用：以 htmlLabels:false 渲染 mermaid，输出不含 <foreignObject> 的纯 SVG。
 *
 * 含 foreignObject 的 SVG 绘制到 <canvas> 会污染画布（tainted），导致 toDataURL()
 * 抛出 SecurityError（如导出 Word/PNG 时报 "Tainted canvases may not be exported"）。
 * 该函数临时切换为纯文本标签渲染，供导出转 PNG 使用；不走共享缓存，避免覆盖预览版本。
 * 注意：v11 必须设置顶层 htmlLabels:false（flowchart.htmlLabels 会被忽略）。
 */
export async function renderMermaidSvgForExport(source: string): Promise<string> {
  ensureMermaidInit()
  const renderId = `mermaid-export-${Date.now()}-${Math.random().toString(36).slice(2)}`
  mermaid.initialize({
    ...baseConfig,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    sequence: { htmlLabels: false },
  })
  try {
    const { svg } = await mermaid.render(renderId, source)
    return svg
  } finally {
    // 恢复预览配置（htmlLabels:true）
    mermaid.initialize(baseConfig)
  }
}

/** 清除指定内容的缓存 */
export function clearMermaidCache(source?: string): void {
  if (source) {
    svgCache.delete(hashContent(source))
  } else {
    svgCache.clear()
  }
}

/** 获取当前缓存大小 */
export function getMermaidCacheSize(): number {
  return svgCache.size
}

/** 简易 XML 转义（用于把 foreignObject 文本放入 <text>） */
function escapeXmlForSvg(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 净化 SVG，使其可以安全绘制到 canvas（避免 "Tainted canvases may not be exported"）。
 * - 含 <foreignObject>（HTML 标签）的 SVG 绘制到 canvas 会污染画布 → 将其文本提取为 <text>；
 * - 去掉引用外部资源的 <image>；
 * - 去掉 @import 外部样式。
 */
export function sanitizeSvgForCanvas(svg: string): string {
  let out = svg.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, (fo) => {
    const x = parseFloat((fo.match(/\bx="([^"]*)"/i) || [])[1] || '0') || 0
    const y = parseFloat((fo.match(/\by="([^"]*)"/i) || [])[1] || '0') || 0
    const width = parseFloat((fo.match(/\bwidth="([^"]*)"/i) || [])[1] || '100') || 100
    const height = parseFloat((fo.match(/\bheight="([^"]*)"/i) || [])[1] || '20') || 20

    const blocks: string[] = []
    const divRe = /<div[^>]*>([\s\S]*?)<\/div>/gi
    let m: RegExpExecArray | null
    while ((m = divRe.exec(fo)) !== null) {
      const txt = m[1].replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim()
      if (txt) blocks.push(txt)
    }
    if (!blocks.length) {
      const all = fo.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
      if (all) blocks.push(all)
    }

    const lines = blocks.join('\n').split('\n')
    const cx = x + width / 2
    const fontSize = Math.max(10, Math.min(14, height / Math.max(lines.length, 1) - 2))
    const startY = y + fontSize / 2
    return lines
      .map((l, i) =>
        `<text x="${cx}" y="${startY + i * fontSize}" text-anchor="middle" font-size="${fontSize}" font-family="sans-serif" fill="#333">${escapeXmlForSvg(l)}</text>`
      )
      .join('')
  })
  // 去掉指向外部资源的 <image>（可能加载跨域图片污染 canvas）
  out = out.replace(/<image[\s\S]*?(?:\/>|<\/image>)/gi, '')
  // 去掉 @import 外部样式
  out = out.replace(/@import[^;]+;/gi, '')
  return out
}

/** 从 SVG 字符串解析真实尺寸（优先 viewBox，其次 width/height 属性） */
export function parseSvgSize(svg: string): { w: number; h: number } | null {
  const vb = svg.match(/\bviewBox\s*=\s*"([^"]*)"/i)
  if (vb) {
    const parts = vb[1].trim().split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return { w: parts[2], h: parts[3] }
    }
  }
  const wm = svg.match(/\bwidth\s*=\s*"([^"]+)"/i)
  const hm = svg.match(/\bheight\s*=\s*"([^"]+)"/i)
  const w = wm ? parseFloat(wm[1]) : NaN
  const h = hm ? parseFloat(hm[1]) : NaN
  if (!isNaN(w) && !isNaN(h) && w > 0 && h > 0) return { w, h }
  return null
}

/**
 * 把 SVG 的 width/height 固定为 viewBox 像素尺寸（并去掉 style 的 max-width）。
 *
 * mermaid 输出 width="100%" + viewBox，作为 <img> 时 Chromium 会按「默认 300×150 再适配
 * viewBox 比例」的极小尺寸渲染（如 181×150），此时 16px 字体被压到 ~2px，多行 <tspan dy=..>
 * 的亚像素舍入在放大后变成可见的文字偏移。固定为全分辨率尺寸可消除该问题。
 */
export function ensureSvgExplicitSize(svg: string, w: number, h: number): string {
  const W = Math.round(w)
  const H = Math.round(h)
  let out = svg
    .replace(/\swidth\s*=\s*"[^"]*"/i, ` width="${W}"`)
    .replace(/\sheight\s*=\s*"[^"]*"/i, ` height="${H}"`)
    // 去掉 style 中的 max-width（会限制图片渲染尺寸）
    .replace(/\sstyle\s*=\s*"[^"]*max-width\s*:[^"]*"/i, '')
  // 部分渲染器只给 style max-width + viewBox，缺 width/height 属性时补全
  if (!/width\s*=/.test(out)) {
    out = out.replace(/^<svg([^>]*?)\/?>/, (m, attrs) => `<svg${attrs} width="${W}">`)
  }
  if (!/height\s*=/.test(out)) {
    out = out.replace(/^<svg([^>]*?)\/?>/, (m, attrs) => `<svg${attrs} height="${H}">`)
  }
  return out
}

/**
 * 从 SVG 字符串生成 PNG 下载链接（绘制前先净化，避免 canvas 被污染）
 *
 * 注意：mermaid 输出的 SVG 使用 width="100%" + viewBox，必须：
 *  1) 从 viewBox 解析真实尺寸；
 *  2) 把 width/height 固定为 viewBox 像素尺寸，否则会以极小 intrinsic 尺寸渲染，
 *     导致多行文字出现亚像素偏移（放大后可见）；
 *  3) 用显式宽高绘制，否则只画出左上角。
 */
export function svgToPngDataUrl(svgString: string, scale = 2): Promise<string> {
  const cleanSvg = sanitizeSvgForCanvas(svgString)
  const svgSize = parseSvgSize(cleanSvg)
  const vbW = svgSize?.w || 300
  const vbH = svgSize?.h || 150
  // 固定 width/height 为 viewBox 像素尺寸，保证 <img> 全分辨率渲染
  const sizedSvg = ensureSvgExplicitSize(cleanSvg, vbW, vbH)
  return new Promise((resolve, reject) => {
    const blob = new Blob([sizedSvg], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)

    const img = new Image()
    img.onload = () => {
      const w = img.naturalWidth || vbW
      const h = img.naturalHeight || vbH
      const canvas = document.createElement('canvas')
      canvas.width = w * scale
      canvas.height = h * scale
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        URL.revokeObjectURL(url)
        reject(new Error('Canvas 2D context not available'))
        return
      }
      ctx.scale(scale, scale)
      // 显式指定目标宽高，避免 SVG 以不可靠的默认尺寸绘制导致只显示左上角
      ctx.drawImage(img, 0, 0, w, h)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = (e) => {
      URL.revokeObjectURL(url)
      reject(e)
    }
    img.src = url
  })
}

/**
 * 下载文件
 */
export function downloadFile(dataUrl: string, filename: string): void {
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}
