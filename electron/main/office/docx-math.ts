/**
 * Word 公式（OMML）→ LaTeX 回填
 *
 * 背景：mammoth 完全不认识 OMML（`m:oMath`/`m:oMathPara`），公式会被整段丢弃 —— 预览里
 * 「公式不见了」的根因。这里在交给 mammoth 之前，把 document.xml 里的 OMML 元素替换为
 * 纯文本 run（`$...$` 行内公式 / `$$...$$` 独立公式），mammoth 会当作普通文字输出，最终落到
 * Markdown 里由 markdown-it-mathjax3 渲染；导出 Word/PDF 时 md-to-docx 也会把公式转成图片。
 *
 * 覆盖常见 OMML 结构：分式、上下标、根式、括号、求和/积分等 n 元运算符、上下极限、
 * 重音、上/下划线、矩阵、方程组、函数……未识别的元素递归取子元素，尽量不丢内容。
 *
 * 原则：任何异常都回退为原 buffer（宁可不转公式，也不能破坏文档预览）。
 */
import { unzipEntries, packZip, type ZipEntryData } from './docx-zip'

// ==================== XML 轻量扫描 ====================

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&') // 最后替换 &，避免二次转义
}

function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 元素名：`<m:f m:x="1">` → `m:f` */function tagName(head: string): string {
  return head.replace(/\/\s*$/, '').trim().split(/[\s>]/)[0] || ''
}

/** XML 属性值：attr(xml, 'm:val')（在本元素头部字符串上查找） */
function attr(head: string, name: string): string | undefined {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(head)
  return m ? decodeXmlEntities(m[1]) : undefined
}

interface XmlEl { tag: string; head: string; inner: string; end: number }

/** 从 pos（应指向 '<'）读出一个完整元素，深度匹配同名标签 */
function readElement(xml: string, pos: number): XmlEl | null {
  if (xml[pos] !== '<') return null
  const gt = xml.indexOf('>', pos)
  if (gt < 0) return null
  const head = xml.slice(pos + 1, gt)
  if (!head || head.startsWith('/') || head.startsWith('?') || head.startsWith('!')) return null
  const tag = tagName(head)
  if (!tag) return null
  if (/\/\s*$/.test(head)) return { tag, head, inner: '', end: gt + 1 }
  let depth = 1
  let i = gt + 1
  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    if (lt < 0) break
    const gt2 = xml.indexOf('>', lt)
    if (gt2 < 0) break
    const h = xml.slice(lt + 1, gt2)
    if (h.startsWith('/')) {
      if (tagName(h.slice(1)) === tag) {
        depth--
        if (depth === 0) return { tag, head, inner: xml.slice(gt + 1, lt), end: gt2 + 1 }
      }
    } else if (!h.startsWith('?') && !h.startsWith('!')) {
      if (tagName(h) === tag && !/\/\s*$/.test(h)) depth++
    }
    i = gt2 + 1
  }
  return null
}

/** 顺序取出 inner 中的所有顶层子元素 */
function childrenOf(inner: string): XmlEl[] {
  const out: XmlEl[] = []
  let i = 0
  while (i < inner.length) {
    const lt = inner.indexOf('<', i)
    if (lt < 0) break
    const el = readElement(inner, lt)
    if (!el) {
      const gt = inner.indexOf('>', lt)
      i = gt < 0 ? inner.length : gt + 1
      continue
    }
    out.push(el)
    i = el.end
  }
  return out
}

// ==================== OMML → LaTeX ====================

const NARY_OPS: Record<string, string> = {
  '∑': '\\sum', '∏': '\\prod', '∐': '\\coprod', '∫': '\\int', '∬': '\\iint', '∭': '\\iiint',
  '∮': '\\oint', '⋃': '\\bigcup', '⋂': '\\bigcap', '⋁': '\\bigvee', '⋀': '\\bigwedge',
}

const ACC_OPS: Record<string, string> = {
  '^': '\\hat', '¯': '\\bar', '~': '\\tilde', '→': '\\vec', '˙': '\\dot', '¨': '\\ddot', 'ˇ': '\\check', '˘': '\\breve',
}

/** 括号字符 → LaTeX 定界符 */
function delim(ch: string): string {
  switch (ch) {
    case '{': return '\\{'
    case '}': return '\\}'
    case '⟨': return '\\langle'
    case '⟩': return '\\rangle'
    case '‖': return '\\|'
    case '⌊': return '\\lfloor'
    case '⌋': return '\\rfloor'
    case '⌈': return '\\lceil'
    case '⌉': return '\\rceil'
    case '': return '.'
    default: return ch
  }
}

function escapeMathText(s: string): string {
  return s.replace(/[\\{}$&#%_^]/g, (c) => '\\' + c)
}

function escapePlainText(s: string): string {
  return s.replace(/[\\{}$&#%_^~]/g, (c) => '\\' + c)
}

/** m:r（公式 run）→ LaTeX：正文/普通样式文字用 \text{}，变量按数学体 */
function runToLatex(runInner: string): string {
  const els = childrenOf(runInner)
  let text = ''
  for (const el of els) if (el.tag === 'm:t') text += decodeXmlEntities(el.inner)
  if (!text) return ''
  // 直立/普通文本（m:nor、m:sty="p"）或含中日韩字符 → \text{}，避免被当成变量排版
  const upright = /<m:nor\b/.test(runInner) || /<m:sty\b[^>]*m:val="(p|bi)"/.test(runInner)
  const hasCJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(text)
  if (upright || hasCJK) return `\\text{${escapePlainText(text)}}`
  return escapeMathText(text)
}

function convertChildren(inner: string): string {
  return childrenOf(inner).map(convertElement).join('')
}

/** 取第一个指定标签的子元素内容 */
function firstChildInner(inner: string, tag: string): string | null {
  for (const el of childrenOf(inner)) if (el.tag === tag) return el.inner
  return null
}

function convertElement(el: XmlEl): string {
  const { tag, inner } = el
  if (tag.endsWith('Pr')) return '' // 属性容器（m:fPr / m:dPr / m:ctrlPr…）
  switch (tag) {
    case 'm:t':
      return escapeMathText(decodeXmlEntities(inner))
    case 'm:r':
      return runToLatex(inner)
    case 'm:f': {
      const num = firstChildInner(inner, 'm:num')
      const den = firstChildInner(inner, 'm:den')
      return `\\frac{${num ? convertChildren(num) : ''}}{${den ? convertChildren(den) : ''}}`
    }
    case 'm:sSup': {
      const base = firstChildInner(inner, 'm:e') ?? ''
      const sup = firstChildInner(inner, 'm:sup') ?? ''
      return `{${convertChildren(base)}}^{${convertChildren(sup)}}`
    }
    case 'm:sSub': {
      const base = firstChildInner(inner, 'm:e') ?? ''
      const sub = firstChildInner(inner, 'm:sub') ?? ''
      return `{${convertChildren(base)}}_{${convertChildren(sub)}}`
    }
    case 'm:sSubSup': {
      const base = firstChildInner(inner, 'm:e') ?? ''
      const sub = firstChildInner(inner, 'm:sub') ?? ''
      const sup = firstChildInner(inner, 'm:sup') ?? ''
      return `{${convertChildren(base)}}_{${convertChildren(sub)}}^{${convertChildren(sup)}}`
    }
    case 'm:sPre': {
      const base = firstChildInner(inner, 'm:e') ?? ''
      const sub = firstChildInner(inner, 'm:sub') ?? ''
      const sup = firstChildInner(inner, 'm:sup') ?? ''
      return `{}_{${convertChildren(sub)}}^{${convertChildren(sup)}}{${convertChildren(base)}}`
    }
    case 'm:rad': {
      const deg = firstChildInner(inner, 'm:deg')
      const base = firstChildInner(inner, 'm:e') ?? ''
      const degLatex = deg ? convertChildren(deg) : ''
      return degLatex ? `\\sqrt[${degLatex}]{${convertChildren(base)}}` : `\\sqrt{${convertChildren(base)}}`
    }
    case 'm:d': {
      const pr = firstChildInner(inner, 'm:dPr') || ''
      const beg = attr(/<m:begChr\b[^>]*>/.exec(pr)?.[0] || '', 'm:val') ?? '('
      const end = attr(/<m:endChr\b[^>]*>/.exec(pr)?.[0] || '', 'm:val') ?? ')'
      const body = childrenOf(inner).filter((c) => c.tag !== 'm:dPr').map(convertElement).join('')
      return `\\left${delim(beg)}${body}\\right${delim(end)}`
    }
    case 'm:nary': {
      const pr = firstChildInner(inner, 'm:naryPr') || ''
      const chr = attr(/<m:chr\b[^>]*>/.exec(pr)?.[0] || '', 'm:val') ?? '∫'
      const op = NARY_OPS[chr] || '\\int'
      const sub = firstChildInner(inner, 'm:sub')
      const sup = firstChildInner(inner, 'm:sup')
      const body = firstChildInner(inner, 'm:e') ?? ''
      const subLatex = sub ? `_{${convertChildren(sub)}}` : ''
      const supLatex = sup ? `^{${convertChildren(sup)}}` : ''
      return `${op}${subLatex}${supLatex} ${convertChildren(body)}`
    }
    case 'm:limLow': {
      const base = firstChildInner(inner, 'm:e') ?? ''
      const lim = firstChildInner(inner, 'm:lim') ?? ''
      const name = convertChildren(base)
      const inner2 = convertChildren(lim)
      return /^\\(sum|prod|int|lim|max|min|bigcup|bigcap)/.test(name) ? `${name}_{${inner2}}` : `{${name}}_{${inner2}}`
    }
    case 'm:limUpp': {
      const base = firstChildInner(inner, 'm:e') ?? ''
      const lim = firstChildInner(inner, 'm:lim') ?? ''
      return `{${convertChildren(base)}}^{${convertChildren(lim)}}`
    }
    case 'm:acc': {
      const pr = firstChildInner(inner, 'm:accPr') || ''
      const chr = attr(/<m:chr\b[^>]*>/.exec(pr)?.[0] || '', 'm:val') ?? '^'
      const op = ACC_OPS[chr] || '\\hat'
      const base = firstChildInner(inner, 'm:e') ?? ''
      return `${op}{${convertChildren(base)}}`
    }
    case 'm:bar': {
      const pr = firstChildInner(inner, 'm:barPr') || ''
      const pos = attr(/<m:pos\b[^>]*>/.exec(pr)?.[0] || '', 'm:val') ?? 'bot'
      const base = firstChildInner(inner, 'm:e') ?? ''
      return pos === 'top' ? `\\overline{${convertChildren(base)}}` : `\\underline{${convertChildren(base)}}`
    }
    case 'm:func': {
      const name = firstChildInner(inner, 'm:fName') ?? ''
      const arg = firstChildInner(inner, 'm:e') ?? ''
      return `\\operatorname{${convertChildren(name)}}\\left(${convertChildren(arg)}\\right)`
    }
    case 'm:m': {
      const rows = childrenOf(inner)
        .filter((c) => c.tag === 'm:mr')
        .map((mr) => childrenOf(mr.inner).map(convertElement).join(' & '))
      return `\\begin{matrix}${rows.join(' \\\\ ')}\\end{matrix}`
    }
    case 'm:eqArr': {
      const rows = childrenOf(inner)
        .filter((c) => c.tag === 'm:e')
        .map(convertElement)
      return `\\begin{array}{l}${rows.join(' \\\\ ')}\\end{array}`
    }
    default:
      // 容器 / 未知元素：递归拼接（尽量保留内容）
      return convertChildren(inner)
  }
}

/** OMML 片段（m:oMath / m:oMathPara 的内容）→ LaTeX */
export function ommlToLatex(inner: string): string {
  try {
    return convertChildren(inner).replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

// ==================== 注入 document.xml ====================

/**
 * 公式占位符：只用字母/数字与 `@`（这些都是 turndown 不会转义的字符）。
 * 直接把 `$latex$` 写进 XML 会被 turndown 的转义规则破坏（`\frac` → `\\frac`），
 * 用 `_`/`-` 之类字符做占位符同样会被转义（`_` → `\_`）导致替换失败，故必须避开。
 * 流程：先写占位符 → Markdown 生成 → 再替换回 `$latex$`。
 */
const PLACEHOLDER_PREFIX = '@@AIMATH'
const PLACEHOLDER_SUFFIX = '@@'
const PLACEHOLDER_RE = /@@AIMATH(\d+)@@/g

export interface RestoreMathResult {
  buffer: Buffer
  /** 按占位符下标排列的公式（已带 `$`/`$$` 定界符），供 Markdown 生成后回填 */
  formulas: string[]
}

/** 把 Markdown 中的公式占位符替换回 `$latex$` / `$$latex$$` */
export function applyMathPlaceholders(markdown: string, formulas: string[]): string {
  if (!formulas.length || !markdown.includes(PLACEHOLDER_PREFIX)) return markdown
  return markdown.replace(PLACEHOLDER_RE, (whole, idx: string) => {
    const latex = formulas[Number(idx)]
    return latex !== undefined ? latex : whole
  })
}

/**
 * 把文档中的 OMML 公式替换为占位符文本 run（返回新 buffer + 公式表）
 */
export function restoreDocxMath(buf: Buffer): RestoreMathResult {
  try {
    const entries = unzipEntries(buf)
    const docEntry = entries.find((e) => e.name === 'word/document.xml')
    if (!docEntry) return { buffer: buf, formulas: [] }
    const xml = docEntry.data.toString('utf8')
    if (!xml.includes('<m:oMath')) return { buffer: buf, formulas: [] }

    const formulas: string[] = []
    let out = ''
    let i = 0
    while (i < xml.length) {
      // 只在「公式元素」处做元素级解析：不能从文档头逐个读元素，
      // 否则第一个 <w:document> 会把整篇文档吞掉、里面的公式永远访问不到。
      const p = xml.indexOf('<m:oMath', i)
      if (p < 0) { out += xml.slice(i); break }
      const el = readElement(xml, p)
      if (!el) { out += xml.slice(i, p + 1); i = p + 1; continue }
      if (el.tag === 'm:oMathPara' || el.tag === 'm:oMath') {
        // oMathPara = 独立公式（显示样式）；oMath = 行内公式
        const latex = ommlToLatex(el.inner)
        if (latex) {
          const wrapped = el.tag === 'm:oMathPara' ? `$$${latex}$$` : `$${latex}$`
          const index = formulas.length
          formulas.push(wrapped)
          out += xml.slice(i, p)
          out += `<w:r><w:t xml:space="preserve">${PLACEHOLDER_PREFIX}${index}${PLACEHOLDER_SUFFIX}</w:t></w:r>`
          i = el.end
          continue
        }
      }
      out += xml.slice(i, el.end)
      i = el.end
    }

    if (formulas.length === 0) return { buffer: buf, formulas: [] }
    const repacked = packZip(
      entries.map((e: ZipEntryData) =>
        e.name === 'word/document.xml' ? { name: e.name, data: Buffer.from(out, 'utf8') } : e
      )
    )
    return { buffer: repacked, formulas }
  } catch {
    return { buffer: buf, formulas: [] }
  }
}
