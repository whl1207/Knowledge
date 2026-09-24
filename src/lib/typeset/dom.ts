/**
 * dom.ts — 把 DOM 段落拆成排版 item、算断行、再按行重建 DOM（只读视图专用）
 *
 * 渲染方式：每行包一个 `display:block; white-space:nowrap` 的 span，
 * 行内用 word-spacing（西文空格）+ letter-spacing（中文间隙）把该行撑满行宽；
 * 末行不撑，保持左对齐。
 *
 * 关键性质：全程只「切分 / 包裹」已有节点，一个字符都不改，
 * 所以复制、搜索高亮、行内样式（粗体 / 链接 / 行内公式 / 图片）全部原样保留。
 *
 * 断点落在胶（空格）上时，该胶的字符留在两行之间，成为「行首可折叠空白」被浏览器丢弃 —— 正是想要的效果。
 */
import { breakLines, type TsItem, type TsLine } from './break'
import { isCJK, isSpace, canBreakBetween, stretchableAt } from './chars'
import { measureAtom, measureMany, styleOf, type MeasureStyle } from './measure'

export interface TypesetOptions {
  /** 每个中文间隙最大可拉伸量（em），默认 0.08 */
  maxStretchEm?: number
  /** 西文空格可拉伸 / 可压缩量（相对空格宽），默认 0.5 / 0.34 */
  spaceStretchRatio?: number
  spaceShrinkRatio?: number
  /** 少于这个字数的元素不排（默认 16） */
  minChars?: number
  /** 命中元素的选择器（默认正文段落 / 列表 / 引用） */
  selector?: string
}

const LINE_CLASS = 'ts-line'
const SKIP_SELECTOR = 'pre, table, svg, textarea, script, style'
const ATOM_TAGS = new Set(['IMG', 'SVG', 'VIDEO', 'AUDIO', 'MJX-CONTAINER', 'IFRAME'])
const BLOCK_CHILD_TAGS = new Set([
  'P', 'DIV', 'UL', 'OL', 'LI', 'TABLE', 'PRE', 'BLOCKQUOTE', 'HR', 'FIGURE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE', 'BR',
])

/** 默认要排的元素：多行流动文本 */
export const DEFAULT_SELECTOR = 'p, li, blockquote, .be-p, .be-li-text, .be-todo-text'

interface Unit {
  it: TsItem
  /** 文本单元 */
  node?: Text
  start?: number
  end?: number
  /** 零宽胶（中文逐字断点）的位置 */
  bpos?: { node: Node; offset: number }
  /** 原子元素（图片 / 行内公式） */
  atom?: Element
  /** 测量请求 */
  style?: MeasureStyle
  text?: string
}

interface Plan {
  el: HTMLElement
  units: Unit[]
  lines: TsLine[]
  measure: number
  cjkStretch: number
  spaceStretch: number
  spaceShrink: number
}

/** 测量探针（原子元素克隆量尺寸用） */
let probe: HTMLElement | null = null
function ensureProbe(): HTMLElement {
  if (probe && probe.isConnected) return probe
  const el = document.createElement('div')
  el.setAttribute('data-typeset-probe', '1')
  el.style.cssText =
    'position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;width:auto;white-space:pre;margin:0;padding:0;border:0'
  document.body.appendChild(el)
  probe = el
  return el
}

// --- 元素筛选 --------------------------------------------------------------

function isCandidate(el: HTMLElement, minChars: number): boolean {
  if (!el.isConnected) return false
  if (el.classList.contains(LINE_CLASS)) return false
  if (el.closest(SKIP_SELECTOR)) return false
  if ((el.textContent || '').trim().length < minChars) return false
  // 注意：纯文本段落没有元素子节点，这里不能要求 children.length > 0
  for (const child of Array.from(el.children)) {
    if (BLOCK_CHILD_TAGS.has(child.tagName)) return false
    const ccs = getComputedStyle(child)
    if (ccs.display === 'block' || ccs.display === 'flex' || ccs.display === 'grid' || ccs.display === 'table') return false
    if (ccs.position === 'absolute' || ccs.position === 'fixed') return false
    if (ccs.float !== 'none') return false
  }
  const cs = getComputedStyle(el)
  if (cs.display === 'flex' || cs.display === 'grid' || cs.display === 'inline') return false
  if (cs.whiteSpace !== 'normal' && cs.whiteSpace !== 'nowrap') return false
  if (el.clientWidth < 60) return false
  return true
}

function isAtomElement(el: Element): boolean {
  if (!ATOM_TAGS.has(el.tagName)) return false
  const cs = getComputedStyle(el)
  if (cs.display === 'block') return false
  if (cs.position === 'absolute' || cs.position === 'fixed') return false
  return true
}

// --- 拆 item ---------------------------------------------------------------

function planElement(el: HTMLElement, opt: Required<Omit<TypesetOptions, 'selector'>>): Plan | null {
  const cs = getComputedStyle(el)
  const baseStyle = styleOf(cs)
  const fontSize = parseFloat(cs.fontSize) || 15
  const measure = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)
  if (!(measure > 40)) return null

  const units: Unit[] = []
  const styleCache = new Map<Element, MeasureStyle>()
  const styleFor = (node: Node): MeasureStyle => {
    const pe = (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement) as Element | null
    if (!pe || pe === el) return baseStyle
    const hit = styleCache.get(pe)
    if (hit) return hit
    const s = styleOf(getComputedStyle(pe))
    styleCache.set(pe, s)
    return s
  }

  const cjkStretch = opt.maxStretchEm * fontSize
  let prevChar = ''
  let prevWasGlue = false

  const pushGlueBefore = (node: Node, offset: number, nextChar: string) => {
    if (!prevChar || prevWasGlue) return
    const canBreak = canBreakBetween(prevChar, nextChar)
    const stretch = stretchableAt(prevChar, nextChar) ? cjkStretch : 0
    if (!canBreak && stretch <= 0) return
    units.push({
      it: { w: 0, kind: 'glue', stretch, shrink: 0, breakAfter: canBreak, penalty: 0 },
      bpos: { node, offset },
    })
  }

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const textNode = node as Text
      const value = textNode.nodeValue || ''
      const st = styleFor(textNode)
      let i = 0
      while (i < value.length) {
        const ch = value[i]
        if (isSpace(ch)) {
          let j = i
          while (j < value.length && isSpace(value[j])) j++
          units.push({
            it: { w: 0, kind: 'glue', stretch: 0, shrink: 0, breakAfter: true, penalty: 0 },
            node: textNode,
            start: i,
            end: j,
            style: st,
            text: ' ',
          })
          prevChar = ' '
          prevWasGlue = true
          i = j
          continue
        }
        if (isCJK(ch)) {
          pushGlueBefore(textNode, i, ch)
          units.push({ it: { w: 0, kind: 'box' }, node: textNode, start: i, end: i + 1, style: st, text: ch })
          prevChar = ch
          prevWasGlue = false
          i++
          continue
        }
        let j = i
        while (j < value.length && !isSpace(value[j]) && !isCJK(value[j])) j++
        const word = value.slice(i, j)
        pushGlueBefore(textNode, i, word[0])
        units.push({ it: { w: 0, kind: 'box' }, node: textNode, start: i, end: j, style: st, text: word })
        prevChar = word[word.length - 1]
        prevWasGlue = false
        i = j
      }
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const elem = node as Element
    if (elem.hasAttribute('data-ts-skip')) return
    if (elem.tagName === 'BR') {
      units.push({ it: { w: 0, kind: 'box', breakAfter: true, forced: true, penalty: 0 } })
      prevChar = ''
      prevWasGlue = true
      return
    }
    if (isAtomElement(elem)) {
      pushGlueBefore(elem, 0, '\u0000')
      units.push({ it: { w: 0, kind: 'box' }, atom: elem, style: styleFor(elem) })
      prevChar = '\u0000'
      prevWasGlue = false
      return
    }
    for (const child of Array.from(elem.childNodes)) walk(child)
  }
  for (const child of Array.from(el.childNodes)) walk(child)
  if (units.length < 2) return null

  // 宽度：先批量量文本（一次 reflow），再量原子
  const widths = measureMany(units.map((u) => ({ text: u.text ?? '', style: u.style ?? baseStyle })))
  for (let k = 0; k < units.length; k++) {
    const u = units[k]
    u.it.w = u.atom ? measureAtom(u.atom, u.style ?? baseStyle, true) : widths[k] || 0
  }
  const spaceWidth = measureMany([{ text: ' ', style: baseStyle }])[0] || fontSize * 0.3
  for (const u of units) {
    if (u.it.kind === 'glue' && u.node) {
      u.it.stretch = spaceWidth * opt.spaceStretchRatio
      u.it.shrink = spaceWidth * opt.spaceShrinkRatio
    }
  }
  units[units.length - 1].it.breakAfter = true

  const broken = breakLines(units.map((u) => u.it), { measure })
  if (broken.lines.length < 2) return null
  return {
    el,
    units,
    lines: broken.lines,
    measure,
    cjkStretch,
    spaceStretch: spaceWidth * opt.spaceStretchRatio,
    spaceShrink: spaceWidth * opt.spaceShrinkRatio,
  }
}

// --- 把行落到 DOM ----------------------------------------------------------

type Pos = { node: Node; offset: number }

function indexOfNode(parent: Node, child: Node): number {
  let i = 0
  let n: Node | null = parent.firstChild
  while (n) {
    if (n === child) return i
    i++
    n = n.nextSibling
  }
  return -1
}

function startPos(u: Unit): Pos | null {
  if (u.node && u.start !== undefined) return { node: u.node, offset: u.start }
  if (u.bpos) return { node: u.bpos.node, offset: u.bpos.offset }
  if (u.atom && u.atom.parentNode) return { node: u.atom.parentNode, offset: indexOfNode(u.atom.parentNode, u.atom) }
  return null
}

function endPos(u: Unit): Pos | null {
  if (u.node && u.end !== undefined) return { node: u.node, offset: u.end }
  if (u.bpos) return { node: u.bpos.node, offset: u.bpos.offset }
  if (u.atom && u.atom.parentNode) return { node: u.atom.parentNode, offset: indexOfNode(u.atom.parentNode, u.atom) + 1 }
  return null
}

function clampOffset(node: Node, offset: number): number {
  const len = node.nodeType === Node.TEXT_NODE ? (node.nodeValue || '').length : node.childNodes.length
  return Math.max(0, Math.min(offset, len))
}

/** 切分内联元素会在边界留下空壳（空 <strong>/<a> 等），清理掉 */
function pruneEmptyInline(root: Element): void {
  const atoms = 'img,svg,br,video,audio,iframe,mjx-container,input,textarea,button'
  // 原子 / 数学容器内部一律不动：MathJax SVG 输出的字形是 <g><path>，既没有文字也不是原子，
  // 会被「空壳」规则当成空 <span> 误删 → 公式只剩宽度、字形全部消失（宽度正常但看不见字）。
  const protectedSel = 'mjx-container, mjx-assistive-mml, math, svg, img, video, audio, iframe'
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (!el.isConnected) continue
    if (el.matches(atoms) || el.matches('.' + LINE_CLASS)) continue
    if (el.closest(protectedSel)) continue
    if (el.hasAttribute('id') || el.hasAttribute('data-mermaid-hash')) continue
    if ((el.textContent || '').length) continue
    if (el.querySelector(atoms)) continue
    el.remove()
  }
}

/** 行内间隙统计（拉伸量分配用） */
function gapStats(units: Unit[], start: number, end: number): { spaces: number; cjk: number; chars: number } {
  let spaces = 0
  let cjk = 0
  let chars = 0
  for (let k = start; k <= end; k++) {
    const u = units[k]
    if (!u) continue
    if (u.it.kind === 'glue') {
      // 有宽度的胶是空格（正常 white-space 下折叠成一个）
      if (u.node) {
        spaces++
        chars += 1
      } else if (u.bpos) cjk++
      continue
    }
    if (u.node && u.start !== undefined && u.end !== undefined) chars += u.end - u.start
  }
  return { spaces, cjk, chars }
}

function applyPlan(plan: Plan): void {
  const { units, lines, measure, cjkStretch, spaceStretch, spaceShrink } = plan
  // 倒序处理：extractContents 会切分文本节点，倒序才能保证前面记录的 offset 依然有效
  for (let li = lines.length - 1; li >= 0; li--) {
    const line = lines[li]
    const endUnit = units[line.end]
    if (!endUnit) continue
    // 断点项（胶）留在两行之间：不计入上一行宽度，字符会成为行首/行尾可折叠空白被丢弃
    const effectiveEnd = endUnit.it.kind === 'glue' && line.end > line.start ? line.end - 1 : line.end
    const from = startPos(units[line.start])
    const to = endPos(units[effectiveEnd])
    if (!from || !to) continue

    let wordSpacing = 0
    let letterSpacing = 0
    const excess = measure - line.natural
    if (!line.last && Math.abs(excess) > 0.5) {
      const { spaces, cjk, chars } = gapStats(units, line.start, effectiveEnd)
      const spaceCap = spaces * spaceStretch
      const cjkCap = cjk * cjkStretch
      const total = spaceCap + cjkCap
      if (total > 0) {
        const shareSpace = (excess * spaceCap) / total
        const shareCjk = excess - shareSpace
        // 安全阀：需要超过预设拉伸量就不拉（保持左对齐），避免出现稀疏行
        const spaceOk = shareSpace <= spaceCap + 0.01 && shareSpace >= -(spaces * spaceShrink) - 0.01
        const cjkOk = shareCjk <= cjkCap + 0.01 && shareCjk >= -cjkCap - 0.01
        if (spaceOk && cjkOk) {
          if (spaces > 0) wordSpacing = shareSpace / spaces
          // letter-spacing 是按「字符」生效的（西文字符同样会加），要除字符数而不是间隙数
          letterSpacing = chars > 0 ? shareCjk / chars : 0
        }
      }
    }

    const range = document.createRange()
    try {
      range.setStart(from.node, clampOffset(from.node, from.offset))
      range.setEnd(to.node, clampOffset(to.node, to.offset))
    } catch {
      continue
    }
    if (range.collapsed) continue
    let frag: DocumentFragment
    try {
      frag = range.extractContents()
    } catch {
      continue
    }
    if (!frag.textContent && frag.childNodes.length === 0) continue

    const span = document.createElement('span')
    span.className = LINE_CLASS
    if (wordSpacing) span.style.wordSpacing = wordSpacing.toFixed(3) + 'px'
    if (letterSpacing) span.style.letterSpacing = letterSpacing.toFixed(3) + 'px'
    span.appendChild(frag)
    try {
      range.insertNode(span)
    } catch {
      /* 极少数异常：放弃本行 */
    }
  }
  pruneEmptyInline(plan.el)
}

// --- 对外入口 --------------------------------------------------------------

/** 还原：拆掉行包裹并合并被切分的文本节点（文本内容不变） */
export function revertTypeset(root: ParentNode): void {
  const lines = Array.from(root.querySelectorAll<HTMLElement>('.' + LINE_CLASS))
  if (!lines.length) return
  const parents = new Set<Node>()
  for (const line of lines) {
    const parent = line.parentNode
    if (!parent) continue
    parents.add(parent)
    while (line.firstChild) parent.insertBefore(line.firstChild, line)
    parent.removeChild(line)
  }
  for (const p of parents) {
    const el = p as Element
    if (typeof el.normalize === 'function') el.normalize()
  }
}

/** 对 root 下可排元素做两端对齐排版，返回处理的元素数 */
export function typesetRoot(root: ParentNode, opts: TypesetOptions = {}): number {
  const conf = {
    maxStretchEm: opts.maxStretchEm ?? 0.08,
    spaceStretchRatio: opts.spaceStretchRatio ?? 0.5,
    spaceShrinkRatio: opts.spaceShrinkRatio ?? 0.34,
    minChars: opts.minChars ?? 16,
  }
  if (typeof document === 'undefined' || !document.body) return 0
  ensureProbe()
  revertTypeset(root)
  const selector = opts.selector || DEFAULT_SELECTOR
  const targets = Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((el) => isCandidate(el, conf.minChars))
  let done = 0
  for (const el of targets) {
    try {
      const plan = planElement(el, conf)
      if (!plan) continue
      applyPlan(plan)
      done++
    } catch (e) {
      console.warn('[typeset] 段落排版失败：', e)
    }
  }
  return done
}

/** 元素是否已排版（调试 / 自测用） */
export function isTypeset(el: Element): boolean {
  return !!el.querySelector(':scope > .' + LINE_CLASS)
}
