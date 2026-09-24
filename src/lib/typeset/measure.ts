/**
 * measure.ts — 文本宽度测量（隐藏镜像元素 + 缓存 + 批量合并到一次 reflow）
 *
 * 为什么不用 Canvas measureText：字体回退、字距（kerning/ligature）、letter-spacing
 * 的算法与真实布局存在系统偏差，逐行拉伸要求右端像素级对齐，所以直接用真实布局测量。
 *
 * 性能：每次测量都会触发一次布局，因此
 *   1) 结果按「样式 + 文本」缓存（中文逐字缓存命中率极高）
 *   2) 同一段落的测量合并成一批：先把 span 全部写进镜像，再一次性读宽度（一次 reflow）
 */

interface MeasureCache {
  /** key = 样式串 + \u0001 + 文本 */
  widths: Map<string, number>
}

const cache: MeasureCache = { widths: new Map() }

let mirror: HTMLElement | null = null

function ensureMirror(): HTMLElement {
  if (mirror && mirror.isConnected) return mirror
  const el = document.createElement('div')
  el.setAttribute('data-typeset-mirror', '1')
  el.style.cssText = [
    'position:absolute',
    'left:-99999px',
    'top:0',
    'visibility:hidden',
    'pointer-events:none',
    'white-space:pre',
    'margin:0',
    'padding:0',
    'border:0',
    'line-height:normal',
    'z-index:-1',
  ].join(';')
  document.body.appendChild(el)
  mirror = el
  return el
}

/** 参与测量的字体相关属性（少一个都可能导致宽度不一致） */
export interface MeasureStyle {
  /** CSS font 简写，如 `italic 600 15px "Segoe UI", sans-serif` */
  font: string
  letterSpacing?: string
  wordSpacing?: string
  fontKerning?: string
  fontFeatureSettings?: string
  textTransform?: string
}

/** 从计算样式构造测量样式 */
export function styleOf(cs: CSSStyleDeclaration): MeasureStyle {
  return {
    font: `${cs.fontStyle} ${cs.fontVariant} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`,
    letterSpacing: cs.letterSpacing,
    wordSpacing: cs.wordSpacing,
    fontKerning: cs.fontKerning,
    fontFeatureSettings: cs.fontFeatureSettings,
    textTransform: cs.textTransform,
  }
}

function applyStyle(el: HTMLElement, s: MeasureStyle): void {
  el.style.font = s.font
  el.style.letterSpacing = s.letterSpacing || 'normal'
  el.style.wordSpacing = s.wordSpacing || 'normal'
  el.style.fontKerning = s.fontKerning || 'auto'
  el.style.fontFeatureSettings = s.fontFeatureSettings || 'normal'
  el.style.textTransform = s.textTransform || 'none'
}

function keyOf(s: MeasureStyle, text: string): string {
  return `${s.font}\u0001${s.letterSpacing}\u0001${s.wordSpacing}\u0001${s.fontKerning}\u0001${s.fontFeatureSettings}\u0001${s.textTransform}\u0001${text}`
}

/** 单个文本宽（走缓存） */
export function measureText(text: string, s: MeasureStyle): number {
  if (!text) return 0
  const key = keyOf(s, text)
  const hit = cache.widths.get(key)
  if (hit !== undefined) return hit
  const el = ensureMirror()
  applyStyle(el, s)
  el.textContent = text
  const w = el.getBoundingClientRect().width
  cache.widths.set(key, w)
  return w
}

/**
 * 批量测量（一次 reflow）。
 * 返回与入参等长的宽度数组；已缓存的直接返回。
 */
export function measureMany(list: Array<{ text: string; style: MeasureStyle }>): number[] {
  const out = new Array<number>(list.length)
  const todo: number[] = []
  for (let i = 0; i < list.length; i++) {
    const { text, style } = list[i]
    if (!text) {
      out[i] = 0
      continue
    }
    const key = keyOf(style, text)
    const hit = cache.widths.get(key)
    if (hit !== undefined) out[i] = hit
    else todo.push(i)
  }
  if (!todo.length) return out

  const host = ensureMirror()
  const slots: HTMLElement[] = []
  for (const i of todo) {
    const span = document.createElement('span')
    span.style.cssText = 'display:inline-block;white-space:pre'
    applyStyle(span, list[i].style)
    span.textContent = list[i].text
    host.appendChild(span)
    slots.push(span)
  }
  // 一次性读（此后才是布局）
  for (let k = 0; k < todo.length; k++) {
    const w = slots[k].getBoundingClientRect().width
    out[todo[k]] = w
    cache.widths.set(keyOf(list[todo[k]].style, list[todo[k]].text), w)
  }
  for (const span of slots) span.remove()
  return out
}

/** 测量一个原子（图片 / 行内公式等）：克隆进镜像量尺寸 */
export function measureAtom(node: Element, s: MeasureStyle, inline: boolean): number {
  const host = ensureMirror()
  const box = document.createElement('span')
  box.style.cssText = `display:${inline ? 'inline-block' : 'block'};white-space:pre`
  applyStyle(box, s)
  const clone = node.cloneNode(true) as HTMLElement
  // 克隆进镜像：尺寸由 MathJax / 图片自身样式决定
  box.appendChild(clone)
  host.appendChild(box)
  const w = box.getBoundingClientRect().width
  box.remove()
  return w
}

/** 供调试/自测：缓存命中情况 */
export function measureCacheSize(): number {
  return cache.widths.size
}
