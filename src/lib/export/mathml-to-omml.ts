/**
 * MathML → OMML（Office Math Markup Language，Word 原生可编辑公式）转换
 *
 * 数据来源：markdown-it-mathjax3 渲染时随 <mjx-container> 一起产出的 assistive MathML
 * （`<mjx-assistive-mml><math>…</math></mjx-assistive-mml>`），本质是 MathJax 内部的
 * MathML 树，结构规整，足以还原成 Word 的公式对象（可在 Word 里点开继续编辑）。
 *
 * 覆盖范围：
 *  - 分式 mfrac、根式 msqrt / mroot、上下标 msup / msub / msubsup
 *  - 上下限 munder / mover / munderover：∑ ∫ ∏ ⋃… → n 元运算符；lim / max / min… → 上下极限
 *  - 定界符 \left…\right（mrow + OPEN/CLOSE 标记）→ m:d，可随内容自动伸缩
 *  - 矩阵与方程组 mtable：pmatrix / bmatrix / array / cases → m:m；aligned / align → m:eqArr
 *  - 重音 \hat \vec \tilde 与上/下划线 \overline \underline → m:acc / m:bar
 *  - \text{} 中文（m:r + eastAsia 字体）、\mathbf / \mathbb / \mathcal 等数学字体
 *  - \boxed / \cancel 等 menclose、\binom（无横线分式）
 *
 * 设计原则：未识别的元素一律递归其子节点，宁可丢样式也不丢内容；
 * 输出只使用 Word 自身也会写出的常规 OMML 元素，避免 Word 报“内容有问题”。
 */

type Ctx = { bold?: boolean; upright?: boolean }
/** Word 数学字体样式：i=斜体（默认）、p=正体、b=粗体、bi=粗斜体 */
type Sty = 'i' | 'p' | 'b' | 'bi'

/** MathJax 的不可见字符（函数应用符 U+2061、不可见乘号 U+2062 等）与零宽字符 */
const INVISIBLE_RE = /[\u2061-\u2064\u200B-\u200D\uFEFF]/g

/** 大字运算符：MathJax 给它们挂上下限，Word 侧对应 n 元运算符对象 */
const BIG_OPS = new Set([
  '∑', '∏', '∐', '∫', '∬', '∭', '∮', '∯', '∰', '∱',
  '⋃', '⋂', '⋁', '⋀', '⨁', '⨂', '⨀', '⨄', '⨆', '⨅', '⨉', '⨿',
])

/** 重音字符（\hat \vec \tilde \dot \ddot \acute \grave \breve \check）→ 组合字符 */
const ACCENT_MAP: Record<string, string> = {
  '\u005e': '\u0302', // ^  \hat
  '\u02c6': '\u0302', // ˆ
  '\u007e': '\u0303', // ~  \tilde
  '\u02dc': '\u0303', // ˜
  '\u2192': '\u20d7', // →  \vec
  '\u2190': '\u20d6', // ←  \overleftarrow
  '\u02d9': '\u0307', // ˙  \dot
  '\u00a8': '\u0308', // ¨  \ddot
  '\u02c7': '\u030c', // ˇ  \check
  '\u00b4': '\u0301', // ´  \acute
  '\u0060': '\u0300', // `  \grave
  '\u02cb': '\u0300', // ˋ
  '\u02d8': '\u0306', // ˘  \breve
}

/** 上/下划线类字符（\overline \underline \bar \underbar）→ Word 的上/下划线对象 */
const BAR_CHARS = new Set(['―', '—', '‾', '¯', '_', '‗'])

/** \mathbb 的双线体：Cambria Math 里没有该字形，改用 Unicode 数学字母 */
const DOUBLE_STRUCK: Record<string, string> = {
  A: '𝔸', B: '𝔹', C: 'ℂ', D: '𝔻', E: '𝔼', F: '𝔽', G: '𝔾', H: 'ℍ', I: '𝕀', J: '𝕁',
  K: '𝕂', L: '𝕃', M: '𝕄', N: 'ℕ', O: '𝕆', P: 'ℙ', Q: 'ℚ', R: 'ℝ', S: '𝕊', T: '𝕋',
  U: '𝕌', V: '𝕍', W: '𝕎', X: '𝕏', Y: '𝕐', Z: 'ℤ',
}

/** \mathcal 的花体 */
const SCRIPT: Record<string, string> = {
  A: '𝓐', B: '𝓑', C: '𝓒', D: '𝓓', E: '𝓔', F: '𝓕', G: '𝓖', H: '𝓗', I: '𝓘', J: '𝓙',
  K: '𝓚', L: '𝓛', M: '𝓜', N: '𝓝', O: '𝓞', P: '𝓟', Q: '𝓠', R: '𝓡', S: '𝓢', T: '𝓣',
  U: '𝓤', V: '𝓥', W: '𝓦', X: '𝓧', Y: '𝓨', Z: '𝓩',
}

/** \mathfrak 的哥特体 */
const FRAKTUR: Record<string, string> = {
  A: '𝔄', B: '𝔅', C: 'ℭ', D: '𝔇', E: '𝔈', F: '𝔉', G: '𝔊', H: 'ℌ', I: 'ℑ', J: '𝔍',
  K: '𝔎', L: '𝔏', M: '𝔐', N: '𝔑', O: '𝔒', P: '𝔓', Q: '𝔔', R: 'ℜ', S: '𝔖', T: '𝔗',
  U: '𝔘', V: '𝔙', W: '𝔚', X: '𝔛', Y: '𝔜', Z: 'ℨ',
}

// ===== 基础工具 =====

function local(el: Element | null | undefined): string {
  if (!el) return ''
  return (el.localName || el.tagName || '').toLowerCase()
}

function kids(el: Element | null | undefined): Element[] {
  return el ? Array.from(el.children) : []
}

function isEmptyEl(el: Element | null | undefined): boolean {
  if (!el) return true
  return el.children.length === 0 && !(el.textContent || '').trim()
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 去掉不可见字符并把连续空白压成单空格（公式内换行/制表符只会破坏排版） */
function clean(s: string): string {
  return s.replace(INVISIBLE_RE, '').replace(/[ \t\r\n]+/g, ' ')
}

function mapChars(text: string, table: Record<string, string>): string {
  let out = ''
  for (const ch of text) out += table[ch] ?? ch
  return out
}

/** 生成一个数学 run（Word 侧即公式里的一段文字），默认 Cambria Math */
function run(text: string, sty: Sty, ctx: Ctx, cjk = false): string {
  if (!text) return ''
  let s: Sty = sty
  if (ctx.bold) s = s === 'i' ? 'b' : s === 'p' ? 'b' : s
  if (ctx.upright && s === 'i') s = 'p'
  const rpr = s === 'i' ? '' : `<m:rPr><m:sty m:val="${s}"/></m:rPr>`
  const ea = cjk ? ' w:eastAsia="宋体"' : ''
  return `<m:r>${rpr}<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"${ea}/></w:rPr><m:t>${esc(text)}</m:t></m:r>`
}

/** OMML 的“参数”容器：元素不存在时留空（Word 允许空参数，如 \left(\right)） */
function arg(el: Element | undefined | null, ctx: Ctx): string {
  return el ? convertElement(el, ctx) : ''
}

// ===== 定界符（\left( … \right)）=====

/**
 * 判断元素是否为 \left / \right 生成的定界符标记。
 * MathJax 有两种形态：<mo data-mjx-texclass="OPEN">(</mo>，
 * 或 <mrow data-mjx-texclass="OPEN"><mo>(</mo></mrow>（\binom 等，texclass 挂在外层 mrow 上）。
 * \right. 的标记没有文字，返回空串（表示该侧不画定界符）。
 */
function markerChar(el: Element, kind: 'OPEN' | 'CLOSE'): string | null {
  let node: Element | undefined = el
  let wrapperKind: string | null = null
  for (let i = 0; i < 2 && node; i++) {
    const name = local(node)
    if (name === 'mo') {
      const eff = node.getAttribute('data-mjx-texclass') || wrapperKind
      if (eff !== kind) return null
      return clean(node.textContent || '').trim()
    }
    if (name !== 'mrow') return null
    wrapperKind = node.getAttribute('data-mjx-texclass') || wrapperKind
    const cs = kids(node)
    if (cs.length !== 1) return null
    node = cs[0]
  }
  return null
}

/** 一层子节点序列：整体被一对定界符包住时输出 m:d（Word 的括号对象），否则平铺 */
function convertSequence(els: Element[], ctx: Ctx): string {
  if (els.length >= 2) {
    const beg = markerChar(els[0], 'OPEN')
    const end = markerChar(els[els.length - 1], 'CLOSE')
    if (beg !== null && end !== null) {
      const inner = convertList(els.slice(1, -1), ctx)
      const pr = `<m:dPr><m:begChr m:val="${esc(beg)}"/><m:endChr m:val="${esc(end)}"/><m:grow m:val="1"/></m:dPr>`
      return `<m:d>${pr}<m:e>${inner}</m:e></m:d>`
    }
  }
  return convertList(els, ctx)
}

function convertList(els: Element[], ctx: Ctx): string {
  let out = ''
  for (const el of els) out += convertElement(el, ctx)
  return out
}

// ===== 各类数学对象 =====

/** 上下标；基为大运算符时改为 n 元运算符对象（∫₀¹ 这种行内上下限） */
function scriptXml(kind: 'sSup' | 'sSub' | 'sSubSup', el: Element, ctx: Ctx): string {
  const cs = kids(el)
  const base = cs[0]
  const sub = kind === 'sSup' ? undefined : cs[1]
  const sup = kind === 'sSub' ? undefined : kind === 'sSubSup' ? cs[2] : cs[1]
  const bt = clean(base?.textContent || '').trim()
  if (base && local(base) === 'mo' && BIG_OPS.has(bt)) return naryXml(bt, sub, sup, 'subSup', ctx)
  const parts = [`<m:e>${arg(base, ctx)}</m:e>`]
  if (kind !== 'sSup') parts.push(`<m:sub>${arg(sub, ctx)}</m:sub>`)
  if (kind !== 'sSub') parts.push(`<m:sup>${arg(sup, ctx)}</m:sup>`)
  return `<m:${kind}>${parts.join('')}</m:${kind}>`
}

/** n 元运算符（∑/∫/⋃…）：chr=运算符字符，limLoc 决定上下限位置 */
function naryXml(chr: string, sub: Element | undefined, sup: Element | undefined, limLoc: 'undOvr' | 'subSup', ctx: Ctx): string {
  const pr = `<m:naryPr><m:chr m:val="${esc(chr)}"/><m:limLoc m:val="${limLoc}"/><m:grow m:val="1"/></m:naryPr>`
  return `<m:nary>${pr}<m:sub>${arg(sub, ctx)}</m:sub><m:sup>${arg(sup, ctx)}</m:sup><m:e/></m:nary>`
}

const limLowXml = (base: Element | undefined, lim: Element | undefined, ctx: Ctx): string =>
  `<m:limLow><m:e>${arg(base, ctx)}</m:e><m:lim>${arg(lim, ctx)}</m:lim></m:limLow>`

const limUppXml = (base: Element | undefined, lim: Element | undefined, ctx: Ctx): string =>
  `<m:limUpp><m:e>${arg(base, ctx)}</m:e><m:lim>${arg(lim, ctx)}</m:lim></m:limUpp>`

const barXml = (base: Element | undefined, pos: 'top' | 'bot', ctx: Ctx): string =>
  `<m:bar><m:barPr><m:pos m:val="${pos}"/></m:barPr><m:e>${arg(base, ctx)}</m:e></m:bar>`

const accXml = (base: Element | undefined, chr: string, ctx: Ctx): string =>
  `<m:acc><m:accPr><m:chr m:val="${esc(chr)}"/></m:accPr><m:e>${arg(base, ctx)}</m:e></m:acc>`

/** 上下限：大运算符 → n 元运算符；lim/max/min → 上下极限；重音 / 划线 → 对应对象 */
function underOverXml(el: Element, ctx: Ctx): string {
  const name = local(el)
  const cs = kids(el)
  const base = cs[0]
  const under = name === 'mover' ? undefined : cs[1]
  const over = name === 'munder' ? undefined : name === 'munderover' ? cs[2] : cs[1]
  const bt = clean(base?.textContent || '').trim()
  const ot = clean(over?.textContent || '').trim()
  const ut = clean(under?.textContent || '').trim()
  const isBig = !!base && local(base) === 'mo' && BIG_OPS.has(bt)

  if (isBig) return naryXml(bt, under, over, 'undOvr', ctx)

  if (name === 'munder') {
    if (ut === '_' || ut === '⏟') return barXml(base, 'bot', ctx)
    return limLowXml(base, under, ctx)
  }
  if (name === 'mover') {
    if (BAR_CHARS.has(ot)) return barXml(base, 'top', ctx)
    const acc = ACCENT_MAP[ot]
    if (acc && local(over) === 'mo') return accXml(base, acc, ctx)
    return limUppXml(base, over, ctx)
  }
  // munderover：非大运算符却同时带上标与下标（罕见）→ 叠加对象
  if (BAR_CHARS.has(ot)) {
    return `<m:sSub><m:e>${barXml(base, 'top', ctx)}</m:e><m:sub>${arg(under, ctx)}</m:sub></m:sSub>`
  }
  const acc = ACCENT_MAP[ot]
  if (acc && local(over) === 'mo') {
    // limUpp 内不能再套重音，这里输出“重音 + 下标”
    return `<m:sSub><m:e>${accXml(base, acc, ctx)}</m:e><m:sub>${arg(under, ctx)}</m:sub></m:sSub>`
  }
  return `<m:limLow><m:e>${limUppXml(base, over, ctx)}</m:e><m:lim>${arg(under, ctx)}</m:lim></m:limLow>`
}

/** 分式（\binom 用 linethickness="0" → 无横线分式） */
function fracXml(el: Element, ctx: Ctx): string {
  const cs = kids(el)
  const noBar = (el.getAttribute('linethickness') || '').trim() === '0'
  const pr = noBar ? '<m:fPr><m:type m:val="noBar"/></m:fPr>' : ''
  return `<m:f>${pr}<m:num>${arg(cs[0], ctx)}</m:num><m:den>${arg(cs[1], ctx)}</m:den></m:f>`
}

/** 表格：aligned/align → 公式数组；pmatrix/bmatrix/array/cases → 矩阵 */
function tableXml(el: Element, ctx: Ctx): string {
  const rows = kids(el).filter((c) => local(c) === 'mtr')
  if (!rows.length) return ''
  const cellsOf = (r: Element) => kids(r).filter((c) => local(c) === 'mtd')
  const colCount = Math.max(1, ...rows.map((r) => cellsOf(r).length))
  const aligns = (el.getAttribute('columnalign') || '').trim().split(/\s+/).filter(Boolean)
  const hasLines = !!(el.getAttribute('columnlines') || el.getAttribute('rowlines'))
  const isAligned = !hasLines && colCount >= 2 && aligns.length >= 2
    && Array.from({ length: colCount }).every((_, i) => (i % 2 === 0 ? aligns[i] === 'right' : aligns[i] === 'left'))
  if (isAligned) {
    return `<m:eqArr>${rows.map((r) => `<m:e>${convertList(cellsOf(r), ctx)}</m:e>`).join('')}</m:eqArr>`
  }
  let mcs = ''
  for (let i = 0; i < colCount; i++) {
    const a = aligns.length ? aligns[Math.min(i, aligns.length - 1)] : 'center'
    const jc = a === 'right' ? 'right' : a === 'left' ? 'left' : 'center'
    mcs += `<m:mc><m:mcPr><m:count m:val="1"/><m:mcJc m:val="${jc}"/></m:mcPr></m:mc>`
  }
  const body = rows.map((r) => {
    const cs = cellsOf(r)
    let cells = ''
    for (let i = 0; i < colCount; i++) cells += `<m:e>${cs[i] ? convertList(kids(cs[i]), ctx) : ''}</m:e>`
    return `<m:mr>${cells}</m:mr>`
  }).join('')
  return `<m:m><m:mPr><m:mcs>${mcs}</m:mcs></m:mPr>${body}</m:m>`
}

/** menclose：\boxed → 边框对象；\overline / \underline 类 → 上/下划线；其余保内容 */
function mencloseXml(el: Element, ctx: Ctx): string {
  const notations = (el.getAttribute('notation') || '').split(/\s+/).filter(Boolean)
  const inner = convertList(kids(el), ctx)
  if (notations.includes('box') || notations.includes('roundedbox')) return `<m:borderBox><m:e>${inner}</m:e></m:borderBox>`
  if (notations.includes('top')) return `<m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e>${inner}</m:e></m:bar>`
  if (notations.includes('bottom')) return `<m:bar><m:barPr><m:pos m:val="bot"/></m:barPr><m:e>${inner}</m:e></m:bar>`
  return inner
}

/** mfenced（原始 MathML 里可能出现）：开闭定界符 → m:d，分隔符按普通字符保留 */
function fencedXml(el: Element, ctx: Ctx): string {
  const beg = el.getAttribute('open') ?? '('
  const end = el.getAttribute('close') ?? ')'
  const inner = convertList(kids(el), ctx)
  const pr = `<m:dPr><m:begChr m:val="${esc(beg)}"/><m:endChr m:val="${esc(end)}"/></m:dPr>`
  return `<m:d>${pr}<m:e>${inner}</m:e></m:d>`
}

/** mmultiscripts（\prescript 前缀暂不支持，后缀逐层串起来） */
function multiscriptsXml(el: Element, ctx: Ctx): string {
  const cs = kids(el)
  let out = arg(cs[0], ctx)
  for (let i = 1; i < cs.length; i += 2) {
    const sub = cs[i]
    const sup = cs[i + 1]
    if (sub && local(sub) === 'mprescripts') break
    const hasSub = !isEmptyEl(sub)
    const hasSup = !isEmptyEl(sup)
    if (hasSub && hasSup) out = `<m:sSubSup><m:e>${out}</m:e><m:sub>${arg(sub, ctx)}</m:sub><m:sup>${arg(sup, ctx)}</m:sup></m:sSubSup>`
    else if (hasSub) out = `<m:sSub><m:e>${out}</m:e><m:sub>${arg(sub, ctx)}</m:sub></m:sSub>`
    else if (hasSup) out = `<m:sSup><m:e>${out}</m:e><m:sup>${arg(sup, ctx)}</m:sup></m:sSup>`
  }
  return out
}

/** 空格（\, \; \quad…）：按 em 宽度换成 Unicode 空格字符 */
function spaceXml(el: Element): string {
  const w = parseFloat(el.getAttribute('width') || '')
  const em = Number.isFinite(w) ? w : 0.25
  if (em <= 0) return ''
  if (em >= 0.9) return run('\u2003'.repeat(Math.min(4, Math.max(1, Math.round(em)))), 'p', {})
  return run(em >= 0.45 ? '\u2002' : '\u2009', 'p', {})
}

/** <mi>：单字母变量斜体；多字母函数名（log/sin/max…）与数学字体按规则处理 */
function miXml(el: Element, ctx: Ctx): string {
  const raw = clean(el.textContent || '').trim()
  if (!raw) return ''
  const mv = (el.getAttribute('mathvariant') || '').trim()
  let text = raw
  if (mv === 'double-struck') text = mapChars(raw, DOUBLE_STRUCK)
  else if (mv === 'script') text = mapChars(raw, SCRIPT)
  else if (mv === 'fraktur' || mv === 'bold-fraktur') text = mapChars(raw, FRAKTUR)
  if (mv === 'bold') return run(text, 'b', ctx)
  if (mv === 'bold-italic') return run(text, 'bi', ctx)
  if (mv === 'bold-sans-serif') return run(text, 'b', ctx)
  if (mv === 'italic' || mv === 'sans-serif-italic') return run(text, 'i', ctx)
  if (mv === 'double-struck' || mv === 'script' || mv === 'fraktur' || mv === 'bold-fraktur') return run(text, 'p', ctx)
  if (mv === 'normal' || mv === 'sans-serif' || mv === 'monospace') return run(text, 'p', ctx)
  // 多字母标识符（\log \arg \max）MathJax 按正体渲染
  if (raw.length > 1 && /^[A-Za-z]+$/.test(raw)) return run(text, 'p', ctx)
  return run(text, 'i', ctx)
}

/** <mtext>：\text{} 内容，正体；含中文时指定东亚字体，首尾空格用不换行空格保住 */
function mtextXml(el: Element, ctx: Ctx): string {
  const raw = el.textContent || ''
  let t = clean(raw)
  if (!t.trim()) return ''
  if (/^[ \t]/.test(raw)) t = '\u00A0' + t.replace(/^ +/, '')
  if (/[ \t]$/.test(raw)) t = t.replace(/ +$/, '') + '\u00A0'
  const cjk = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uff60]/.test(t)
  return run(t, ctx.bold ? 'b' : 'p', ctx, cjk)
}

/** 单个 MathML 元素 → OMML 片段 */
function convertElement(el: Element, ctx: Ctx): string {
  switch (local(el)) {
    case 'math':
    case 'mrow':
    case 'mpadded':
    case 'merror':
      return convertSequence(kids(el), ctx)
    case 'mstyle': {
      // \displaystyle / \scriptsize / \mathrm 等：只保留字体语义
      const mv = (el.getAttribute('mathvariant') || '').trim()
      const next: Ctx = mv === 'bold' || mv === 'bold-italic'
        ? { ...ctx, bold: true }
        : mv === 'normal'
          ? { ...ctx, upright: true }
          : ctx
      return convertSequence(kids(el), next)
    }
    case 'semantics': {
      const first = kids(el).find((k) => local(k) !== 'annotation' && local(k) !== 'annotation-xml')
      return first ? convertElement(first, ctx) : ''
    }
    case 'annotation':
    case 'annotation-xml':
    case 'mphantom': // \phantom 内容不可见
      return ''
    case 'mi':
      return miXml(el, ctx)
    case 'mo': {
      const t = clean(el.textContent || '').trim()
      return t ? run(t, 'p', ctx) : ''
    }
    case 'mn':
      return run(clean(el.textContent || '').trim(), 'p', ctx)
    case 'mtext':
      return mtextXml(el, ctx)
    case 'mspace':
      return spaceXml(el)
    case 'mfrac':
      return fracXml(el, ctx)
    case 'msqrt':
      return `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${convertSequence(kids(el), ctx)}</m:e></m:rad>`
    case 'mroot': {
      const cs = kids(el)
      return `<m:rad><m:deg>${arg(cs[1], ctx)}</m:deg><m:e>${arg(cs[0], ctx)}</m:e></m:rad>`
    }
    case 'msup':
      return scriptXml('sSup', el, ctx)
    case 'msub':
      return scriptXml('sSub', el, ctx)
    case 'msubsup':
      return scriptXml('sSubSup', el, ctx)
    case 'munder':
    case 'mover':
    case 'munderover':
      return underOverXml(el, ctx)
    case 'mtable':
      return tableXml(el, ctx)
    case 'mtr':
      return `<m:mr>${kids(el).map((c) => `<m:e>${convertElement(c, ctx)}</m:e>`).join('')}</m:mr>`
    case 'mtd':
      return convertSequence(kids(el), ctx)
    case 'menclose':
      return mencloseXml(el, ctx)
    case 'mfenced':
      return fencedXml(el, ctx)
    case 'mmultiscripts':
      return multiscriptsXml(el, ctx)
    default:
      // 未知元素：递归子节点，保证内容不丢
      return convertSequence(kids(el), ctx)
  }
}

/**
 * MathML（<math> 元素，或 assistive-mml 容器）→ OMML 片段。
 * 返回内容用于 `<m:oMath>…</m:oMath>`；无有效内容时返回空串。
 */
export function mathmlToOmml(mathEl: Element | null | undefined): string {
  if (!mathEl) return ''
  try {
    return convertElement(mathEl, {}).trim()
  } catch (e) {
    console.warn('[mathml-to-omml] 转换失败:', e)
    return ''
  }
}

/** MathML 的纯文本近似（供表格列宽估算等粗算用途） */
export function mathmlPlainText(mathEl: Element | null | undefined): string {
  if (!mathEl) return ''
  return clean(mathEl.textContent || '').trim()
}
