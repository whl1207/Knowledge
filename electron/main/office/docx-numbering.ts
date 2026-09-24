/**
 * Word 自动编号回填（.docx → 标题编号文本）
 *
 * 背景：Word 的「自动编号 / 多级列表」并不会把编号写进正文文字，而是存在
 * `word/numbering.xml`（编号定义：numId → abstractNum → 各级 numFmt/lvlText）
 * 与段落/样式的 `<w:numPr>` 里。mammoth 只能把「段落级编号」转成 `<ol>/<ul>`，
 * 一旦编号挂在**标题样式**上（Word 最常见的「第 X 章 / 1.1 / 1.1.1」自动编号），
 * 标题映射（p.Heading1 → h1）会先命中，编号就被整段丢掉了 ——
 * 预览与目录里的标题因此没有编号。
 *
 * 方案：在交给 mammoth 之前，先在 docx 包内解析编号定义，按文档顺序推演每个
 * 编号段落的当前编号文本（支持 %1..%9 与常见 numFmt），把编号作为首个 run
 * 注入到**标题段落**的 XML 中；列表类段落仍交给 mammoth 的 ol/ul 处理，
 * 避免出现双重编号。
 *
 * 原则：任何异常都回退为原 buffer（宁可不加编号，也不能破坏文档预览）。
 */
import { unzipEntries, packZip, type ZipEntryData } from './docx-zip'

// ==================== 数字格式化 ====================

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
const CN_UNITS = ['', '十', '百', '千']

/** 中文数字（一、二、……、十、十一、二十三、一百零一……） */
function toChineseNumber(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return String(n)
  if (n < 10) return CN_DIGITS[n]
  if (n >= 10000) {
    const wan = Math.floor(n / 10000)
    const rest = n % 10000
    return toChineseNumber(wan) + '万' + (rest > 0 ? toChineseNumber(rest) : '')
  }
  const s = String(n)
  let out = ''
  let pendingZero = false
  for (let i = 0; i < s.length; i++) {
    const d = Number(s[i])
    const unit = CN_UNITS[s.length - 1 - i]
    if (d === 0) { pendingZero = out !== ''; continue }
    if (pendingZero) { out += '零'; pendingZero = false }
    out += CN_DIGITS[d] + unit
  }
  return out.replace(/^一十/, '十')
}

const ROMAN: [number, string][] = [
  [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
  [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
]

function toRoman(n: number): string {
  let out = ''
  let v = Math.max(1, Math.min(3999, Math.floor(n)))
  for (const [num, sym] of ROMAN) {
    while (v >= num) { out += sym; v -= num }
  }
  return out
}

/** 字母序号：1→a、26→z、27→aa */
function toLetters(n: number): string {
  let v = Math.max(1, Math.floor(n))
  let out = ''
  while (v > 0) {
    const r = (v - 1) % 26
    out = String.fromCharCode(97 + r) + out
    v = Math.floor((v - 1) / 26)
  }
  return out
}

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'

/** 按 numFmt 格式化单个序号 */
function formatNumber(value: number, numFmt: string): string {
  const fmt = (numFmt || 'decimal').toLowerCase()
  switch (fmt) {
    case 'decimal': return String(value)
    case 'decimalzero': return value < 10 ? '0' + value : String(value)
    case 'lowerletter': return toLetters(value)
    case 'upperletter': return toLetters(value).toUpperCase()
    case 'lowerroman': return toRoman(value)
    case 'upperroman': return toRoman(value).toUpperCase()
    case 'chinesecounting':
    case 'chinesecountingthousand':
    case 'chineselegalsimplified':
    case 'japanesecounting':
    case 'japanesedigitalten':
    case 'ideographdigital':
    case 'ideographtraditional':
    case 'taiwanesecounting':
      return toChineseNumber(value)
    case 'decimalenclosedcircle':
      return value >= 1 && value <= CIRCLED.length ? CIRCLED[value - 1] : String(value)
    case 'decimalenclosedfullstop':
      return value >= 1 && value <= 20 ? value + '．' : String(value)
    case 'decimalenclosedparen':
      return value >= 1 && value <= 20 ? `(${value})` : String(value)
    case 'decimalfullwidth': return String(value)
    case 'ordinal': return value + 'th'
    case 'none': return ''
    default: return String(value)
  }
}

// ==================== 编号定义解析 ====================

interface NumberingLevel {
  numFmt: string
  lvlText: string
  start: number
  /** 该级别绑定的段落样式 ID（Word「多级列表链接到标题样式」） */
  pStyle?: string
  /** 编号与正文之间的分隔：tab（默认）/ space / nothing */
  suff: string
}

interface AbstractNum {
  levels: Map<number, NumberingLevel>
}

interface NumInstance {
  abstractNumId: string
  /** ilvl → startOverride */
  startOverrides: Map<number, number>
}

interface StyleInfo {
  name: string
  /** 标题级别（1..9），非标题为 undefined */
  headingLevel?: number
  basedOn?: string
  numId?: string
  ilvl?: number
}

function attr(tag: string, name: string): string | undefined {
  const m = attrRe(name).exec(tag)
  return m ? m[1] : undefined
}

const attrReCache = new Map<string, RegExp>()
function attrRe(name: string): RegExp {
  let re = attrReCache.get(name)
  if (!re) {
    re = new RegExp(`${name}="([^"]*)"`)
    attrReCache.set(name, re)
  }
  return re
}

function parseNumbering(xml: string): {
  abstractNums: Map<string, AbstractNum>
  nums: Map<string, NumInstance>
  /** pStyle → { abstractNumId, ilvl }：编号级别绑定到样式 */
  styleBound: Map<string, { abstractNumId: string; ilvl: number }>
} {
  const abstractNums = new Map<string, AbstractNum>()
  const nums = new Map<string, NumInstance>()
  const styleBound = new Map<string, { abstractNumId: string; ilvl: number }>()

  const abstractRe = /<w:abstractNum\b[^>]*>[\s\S]*?<\/w:abstractNum>/g
  let am: RegExpExecArray | null
  while ((am = abstractRe.exec(xml))) {
    const block = am[0]
    const id = attr(block.slice(0, block.indexOf('>') + 1), 'w:abstractNumId')
    if (!id) continue
    const levels = new Map<number, NumberingLevel>()
    const lvlRe = /<w:lvl\b[^>]*>[\s\S]*?<\/w:lvl>/g
    let lm: RegExpExecArray | null
    while ((lm = lvlRe.exec(block))) {
      const lvlXml = lm[0]
      const openTag = lvlXml.slice(0, lvlXml.indexOf('>') + 1)
      const ilvl = Number(attr(openTag, 'w:ilvl') ?? '0')
      if (!Number.isFinite(ilvl)) continue
      const tag = (name: string) => new RegExp(`<w:${name}\\b[^>]*>`).exec(lvlXml)?.[0] || ''
      const lvlTextTag = tag('lvlText')
      const pStyleTag = tag('pStyle')
      const numFmtTag = tag('numFmt')
      const startTag = tag('start')
      const suffTag = tag('suff')
      const level: NumberingLevel = {
        numFmt: (numFmtTag ? attr(numFmtTag, 'w:val') : '') || 'decimal',
        lvlText: lvlTextTag ? (attr(lvlTextTag, 'w:val') ?? '') : '',
        start: Number((startTag ? attr(startTag, 'w:val') : '') || '1') || 1,
        pStyle: pStyleTag ? attr(pStyleTag, 'w:val') : undefined,
        suff: (suffTag ? attr(suffTag, 'w:val') : '') || 'tab',
      }
      levels.set(ilvl, level)
      if (level.pStyle) styleBound.set(level.pStyle, { abstractNumId: id, ilvl })
    }
    abstractNums.set(id, { levels })
  }

  const numRe = /<w:num\b[^>]*>[\s\S]*?<\/w:num>/g
  let nm: RegExpExecArray | null
  while ((nm = numRe.exec(xml))) {
    const block = nm[0]
    const numId = attr(block.slice(0, block.indexOf('>') + 1), 'w:numId')
    const abstractNumId = attr(/<w:abstractNumId\b[^>]*>/.exec(block)?.[0] || '', 'w:val')
    if (!numId || !abstractNumId) continue
    const startOverrides = new Map<number, number>()
    const overrideRe = /<w:lvlOverride\b[^>]*>[\s\S]*?<\/w:lvlOverride>/g
    let om: RegExpExecArray | null
    while ((om = overrideRe.exec(block))) {
      const ovTag = om[0].slice(0, om[0].indexOf('>') + 1)
      const ilvl = Number(attr(ovTag, 'w:ilvl') ?? '0')
      const startTag = /<w:startOverride\b[^>]*>/.exec(om[0])?.[0]
      const start = startTag ? Number(attr(startTag, 'w:val')) : NaN
      if (Number.isFinite(ilvl) && Number.isFinite(start)) startOverrides.set(ilvl, start)
    }
    nums.set(numId, { abstractNumId, startOverrides })
  }

  return { abstractNums, nums, styleBound }
}

function parseStyles(xml: string): Map<string, StyleInfo> {
  const styles = new Map<string, StyleInfo>()
  if (!xml) return styles
  const styleRe = /<w:style\b[^>]*>[\s\S]*?<\/w:style>/g
  let sm: RegExpExecArray | null
  while ((sm = styleRe.exec(xml))) {
    const block = sm[0]
    const id = attr(block.slice(0, block.indexOf('>') + 1), 'w:styleId')
    if (!id) continue
    const nameTag = /<w:name\b[^>]*>/.exec(block)?.[0]
    const name = (nameTag ? attr(nameTag, 'w:val') : '') || ''
    const basedOnTag = /<w:basedOn\b[^>]*>/.exec(block)?.[0]
    const numPr = /<w:numPr\b[^>]*>[\s\S]*?<\/w:numPr>/.exec(block)?.[0]
    let numId: string | undefined
    let ilvl: number | undefined
    if (numPr) {
      const numIdTag = /<w:numId\b[^>]*>/.exec(numPr)?.[0]
      const ilvlTag = /<w:ilvl\b[^>]*>/.exec(numPr)?.[0]
      numId = numIdTag ? attr(numIdTag, 'w:val') : undefined
      const l = ilvlTag ? Number(attr(ilvlTag, 'w:val')) : NaN
      ilvl = Number.isFinite(l) ? l : undefined
    }
    // 标题级别：样式名 "heading 1"/"标题 1"，或样式 ID "Heading1"
    let headingLevel: number | undefined
    const byName = /^\s*(?:heading|标题)\s*([1-9])\s*$/i.exec(name)
    const byId = /^Heading([1-9])$/i.exec(id)
    if (byName) headingLevel = Number(byName[1])
    else if (byId) headingLevel = Number(byId[1])
    styles.set(id, { name, headingLevel, basedOn: basedOnTag ? attr(basedOnTag, 'w:val') : undefined, numId, ilvl })
  }
  return styles
}

// ==================== 段落编号解析与注入 ====================

const XML_ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
const escapeXml = (s: string) => s.replace(/[&<>]/g, (c) => XML_ESCAPE[c])

interface NumberingRef { numId: string; ilvl: number }

/** 段落自身的 numPr */
function readParagraphNumPr(xml: string): NumberingRef | null {
  const block = /<w:numPr\b[^>]*>[\s\S]*?<\/w:numPr>/.exec(xml)?.[0]
  if (!block) return null
  const numIdTag = /<w:numId\b[^>]*>/.exec(block)?.[0]
  const ilvlTag = /<w:ilvl\b[^>]*>/.exec(block)?.[0]
  const numId = numIdTag ? attr(numIdTag, 'w:val') : undefined
  if (!numId || numId === '0') return null
  const l = ilvlTag ? Number(attr(ilvlTag, 'w:val')) : 0
  return { numId, ilvl: Number.isFinite(l) ? l : 0 }
}

/** 样式链（basedOn）上解析 numPr */
function readStyleNumPr(styleId: string | undefined, styles: Map<string, StyleInfo>): NumberingRef | null {
  let cur = styleId
  for (let hop = 0; cur && hop < 10; hop++) {
    const info = styles.get(cur)
    if (!info) return null
    if (info.numId && info.numId !== '0') return { numId: info.numId, ilvl: info.ilvl ?? 0 }
    cur = info.basedOn
  }
  return null
}

/**
 * 段落标记是否被「修订删除」（`w:pPr/w:rPr/w:del`）。
 *
 * 语义：Word 里删除段落标记 = 该段与下一段合并。mammoth 也正是这样处理的 ——
 * 命中该标记的段落后，会把它的**保留内容**推迟并前插到下一个段落里。
 * 因此绝不能往这种段落注入编号 run：mammoth 会把这个编号带到下一个标题上，
 * 于是出现「4.7.8 4.8 数据输入输出总结」这种两段编号挤到一行的情况
 * （编号本身在 Word 里已随段落合并而消失）。同时这类段落也不应占用编号计数。
 */
function isParagraphMarkDeleted(paragraphXml: string): boolean {
  const pPr = /<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/.exec(paragraphXml)?.[0]
  if (!pPr) return false
  const rPr = /<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>/.exec(pPr)?.[0]
  return !!rPr && /<w:del\b/.test(rPr)
}

export interface RestoreNumberingResult {
  buffer: Buffer
  /** 实际回填了编号的标题数量（供调试/日志） */
  injected: number
}

/**
 * 把 Word 自动编号回填到标题段落（返回新 buffer；失败或无需处理时返回原 buffer）
 */
export function restoreDocxHeadingNumbers(buf: Buffer): RestoreNumberingResult {
  try {
    const entries = unzipEntries(buf)
    const docEntry = entries.find((e) => e.name === 'word/document.xml')
    if (!docEntry) return { buffer: buf, injected: 0 }
    const numberingXml = entries.find((e) => e.name === 'word/numbering.xml')?.data.toString('utf8')
    if (!numberingXml) return { buffer: buf, injected: 0 }
    const stylesXml = entries.find((e) => e.name === 'word/styles.xml')?.data.toString('utf8') || ''

    const { abstractNums, nums, styleBound } = parseNumbering(numberingXml)
    if (nums.size === 0) return { buffer: buf, injected: 0 }
    const styles = parseStyles(stylesXml)

    // abstractNumId → 第一个引用它的 numId（样式绑定的编号级别需要落到具体列表实例）
    const numIdByAbstract = new Map<string, string>()
    for (const [numId, inst] of nums) {
      if (!numIdByAbstract.has(inst.abstractNumId)) numIdByAbstract.set(inst.abstractNumId, numId)
    }

    // 编号计数器：按「列表实例(numId) + 级别(ilvl)」计数（与 Word 一致）
    const counters = new Map<string, number>()
    const counterKey = (numId: string, ilvl: number) => `${numId}:${ilvl}`

    const resolveLevel = (numId: string, ilvl: number): NumberingLevel | null => {
      const inst = nums.get(numId)
      if (!inst) return null
      return abstractNums.get(inst.abstractNumId)?.levels.get(ilvl) || null
    }

    const levelValue = (numId: string, level: number): number => {
      const cur = counters.get(counterKey(numId, level))
      if (cur !== undefined) return cur
      // 尚未出现过该级别：使用起始值（lvlOverride > w:start > 1）
      const inst = nums.get(numId)
      const override = inst?.startOverrides.get(level)
      if (override !== undefined) return override
      return resolveLevel(numId, level)?.start || 1
    }

    /** 按 lvlText 组合出当前编号文本 */
    const composeNumberText = (numId: string, ilvl: number): string => {
      const level = resolveLevel(numId, ilvl)
      if (!level) return ''
      const template = level.lvlText || `%${ilvl + 1}`
      return template.replace(/%(\d)/g, (_m, d: string) => {
        const idx = Number(d) - 1
        if (!Number.isFinite(idx) || idx < 0 || idx > 8) return ''
        const refLevel = resolveLevel(numId, idx)
        return formatNumber(levelValue(numId, idx), refLevel?.numFmt || 'decimal')
      })
    }

    let injected = 0
    const paragraphRe = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g
    const newDocumentXml = docEntry.data.toString('utf8').replace(paragraphRe, (paragraphXml) => {
      // 段落标记被修订删除 = 该段已并入下一段（mammoth 也会把内容前插到下一段）：
      // 既不参与编号计数，也不注入编号，否则编号会泄漏到下一个标题上
      if (isParagraphMarkDeleted(paragraphXml)) return paragraphXml

      const pStyleTag = /<w:pStyle\b[^>]*>/.exec(paragraphXml)?.[0]
      const pStyleId = pStyleTag ? attr(pStyleTag, 'w:val') : undefined
      const styleInfo = pStyleId ? styles.get(pStyleId) : undefined

      // 生效编号：段落 numPr → 样式链 numPr → 绑定到该样式的编号级别
      let ref = readParagraphNumPr(paragraphXml) || readStyleNumPr(pStyleId, styles)
      if (!ref && pStyleId) {
        const bound = styleBound.get(pStyleId)
        const numId = bound ? numIdByAbstract.get(bound.abstractNumId) : undefined
        if (bound && numId) ref = { numId, ilvl: bound.ilvl }
      }
      if (!ref) return paragraphXml

      const level = resolveLevel(ref.numId, ref.ilvl)
      if (!level) return paragraphXml

      // 先递增计数器（所有编号段落都参与，保证编号连续）
      const key = counterKey(ref.numId, ref.ilvl)
      const startValue = nums.get(ref.numId)?.startOverrides.get(ref.ilvl) ?? level.start ?? 1
      const current = counters.has(key) ? (counters.get(key) as number) + 1 : startValue
      counters.set(key, current)
      // 更深级别计数清零（Word 规则：上一级递增后，下级重新开始）
      for (const k of [...counters.keys()]) {
        const sep = k.lastIndexOf(':')
        if (k.slice(0, sep) === ref.numId && Number(k.slice(sep + 1)) > ref.ilvl) counters.delete(k)
      }

      // 仅标题段落回填；列表段落交 mammoth 的 ol/ul 处理，避免双重编号
      if (!styleInfo?.headingLevel) return paragraphXml
      if ((level.numFmt || '').toLowerCase() === 'bullet') return paragraphXml

      const text = composeNumberText(ref.numId, ref.ilvl)
      if (!text) return paragraphXml

      // 编号与正文的分隔（Word 默认 tab，Markdown 标题里用空格等价）
      const suffix = level.suff === 'nothing' ? '' : ' '
      const runXml = `<w:r><w:t xml:space="preserve">${escapeXml(text + suffix)}</w:t></w:r>`

      // 注入到 pPr 之后（无 pPr 则紧跟段落起始标签）
      const pPrMatch = /<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/.exec(paragraphXml)
      if (pPrMatch && pPrMatch.index === paragraphXml.indexOf('<w:pPr')) {
        const at = pPrMatch.index + pPrMatch[0].length
        injected++
        return paragraphXml.slice(0, at) + runXml + paragraphXml.slice(at)
      }
      const openEnd = paragraphXml.indexOf('>') + 1
      injected++
      return paragraphXml.slice(0, openEnd) + runXml + paragraphXml.slice(openEnd)
    })

    if (injected === 0) return { buffer: buf, injected: 0 }

    const repacked = packZip(
      entries.map((e: ZipEntryData) =>
        e.name === 'word/document.xml' ? { name: e.name, data: Buffer.from(newDocumentXml, 'utf8') } : e
      )
    )
    return { buffer: repacked, injected }
  } catch {
    return { buffer: buf, injected: 0 }
  }
}
