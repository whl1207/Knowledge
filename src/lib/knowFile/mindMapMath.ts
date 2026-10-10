/**
 * 思维导图（markmap）的 Markdown 预处理与节点收集规则。
 *
 * 两条「markmap 自身的脾气」决定了这里的做法：
 * 1) markmap 只把「标题 / 列表 / 表格 / 图片」变成节点，普通段落会被整段丢弃；而且同一个标题小节里
 *    「表格 / 独立图片（内部等级 7）」与「列表（等级 8）」会互相挤占，等级 7 的一侧总是胜出、
 *    另一侧整块消失。
 * 2) markmap 自带的 KaTeX 插件（@iktakahiro/markdown-it-katex）在本项目的打包环境下拿不到
 *    katex 的 renderToString，公式会退化成原文，所以公式统一由本模块用 katex 直接渲染：
 *    - 展示公式 $$…$$ 渲染成 div.md-math（它自身就是一个节点）；
 *    - 行内公式 $…$ 先换成占位符，等 markdown 渲染完再替换回 KaTeX HTML（避免 KaTeX 的 HTML 被当成 Markdown 再解析一遍）。
 *
 * 含公式内容的落点按小节内容选择：小节里有表格 / 独立图片时用 div（等级 7，与它们同级共存），
 * 否则包成列表项（等级 9，与列表同级共存）；缩进的公式同样包成同级列表项，不打断所在列表项。
 *
 * 注：小节里的块级内容若出现在子标题（`###` 等）之前，markmap 会丢弃该块（表格 / 列表同样如此），
 * 这类位置的公式与表格 / 列表一样不会进入导图。
 */
import katex from 'katex'
import { defaultOptions as markmapHtmlDefaults, type IHtmlParserOptions } from 'markmap-html-parser'
import type { Transformer } from 'markmap-lib'

/** 展示公式块 / 正文段落块的容器类名（两者都靠下面的节点收集规则成为节点） */
const MATH_CLASS = 'md-math'
const TEXT_CLASS = 'md-text'

/**
 * markmap 的 HTML → 节点收集规则：在默认规则之上，让展示公式块 / 段落块自身成为节点。
 *
 * 默认规则中 div / p 是「透明」的（只下钻到其子元素），这里保留该行为，仅对上述容器例外；
 * selector 需与 selectorRules 一起覆盖，故先取默认值再追加。
 */
export const MARKMAP_HTML_OPTIONS: Partial<IHtmlParserOptions> = {
  selector: `${markmapHtmlDefaults.selector},div.${MATH_CLASS},div.${TEXT_CLASS}`,
  selectorRules: {
    ...markmapHtmlDefaults.selectorRules,
    'div,p': ({ $node, getContent }) =>
      $node.is(`div.${MATH_CLASS},div.${TEXT_CLASS}`)
        ? { ...getContent($node) }
        : { queue: $node.children() },
  },
}

/** 行内公式占位符 → KaTeX HTML。按 markdown-it 实例存放：一个转换器只对应一次转换 */
const INLINE_MATH_TOKENS = new WeakMap<object, string[]>()
const TOKEN_RE = /@@MML(\d+)@@/g
const patchedRenderers = new WeakSet<object>()

/** 渲染 TeX；公式写错时不抛异常，由 KaTeX 以红色错误样式呈现 */
function renderTex(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode, throwOnError: false, strict: 'ignore' })
  } catch {
    return ''
  }
}

/**
 * 给 markmap 用的 markdown-it 实例挂上「占位符 → KaTeX HTML」替换：
 * markmap 内部调用 md.render()，本模块渲染段落时调用 md.renderInline()，两者都要替换。
 */
function patchRenderer(md: Transformer['md']) {
  if (patchedRenderers.has(md)) return
  const originalRender = md.render.bind(md)
  const originalRenderInline = md.renderInline.bind(md)
  const substitute = (html: string) => {
    const tokens = INLINE_MATH_TOKENS.get(md)
    if (!tokens || !html.includes('@@MML')) return html
    return html.replace(TOKEN_RE, (whole, index: string) => tokens[Number(index)] ?? whole)
  }
  md.render = ((src: string, env?: unknown) => substitute(originalRender(src, env))) as typeof md.render
  md.renderInline = ((src: string, env?: unknown) =>
    substitute(originalRenderInline(src, env))) as typeof md.renderInline
  patchedRenderers.add(md)
}

/** 把一行里的行内公式换成占位符（行内代码 `…` 与 \$ 转义原样保留），KaTeX HTML 收进 tokens */
function tokenizeInlineMath(line: string, tokens: string[]): string {
  if (!line.includes('$')) return line
  let out = ''
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (ch === '`') {
      const end = line.indexOf('`', i + 1)
      const stop = end === -1 ? line.length : end + 1
      out += line.slice(i, stop)
      i = stop
      continue
    }
    if (ch === '\\') {
      out += line.slice(i, i + 2)
      i += 2
      continue
    }
    if (ch === '$') {
      // 行首的 $$…$$ 是独立成段的展示公式，已在主流程里处理；这里只管行内的 $…$ 与 $$…$$
      const display = line.startsWith('$$', i)
      const open = i + (display ? 2 : 1)
      const close = line.indexOf(display ? '$$' : '$', open)
      if (close > open) {
        const tex = line.slice(open, close)
        // 首尾不留空白，避免把「$5 与 $8」这类金额当公式
        if (tex.trim() && !/^\s|\s$/.test(tex)) {
          const html = renderTex(tex, display)
          if (html) {
            tokens.push(html)
            out += `@@MML${tokens.length - 1}@@`
            i = close + (display ? 2 : 1)
            continue
          }
        }
      }
    }
    out += ch
    i++
  }
  return out
}

/** 每个标题小节里「有没有列表」「有没有表格 / 独立图片」—— 决定块级内容该放在哪一级 */
interface SectionFlags {
  list: boolean
  block: boolean
}

/** 该行是否属于「普通正文段落」（标题 / 列表 / 表格 / 引用 / 原始 HTML / 公式块 / 缩进行都不算） */
function isParagraphLine(line: string): boolean {
  if (!line.trim()) return false
  if (/^[ \t]/.test(line)) return false
  if (/^#{1,6}\s/.test(line)) return false
  if (/^(?:[-*+]|\d+\.)\s/.test(line)) return false
  if (/^\||^>|^</.test(line)) return false
  if (/^\s*(?:```|~~~)/.test(line)) return false
  if (/^[ \t]*\$\$/.test(line)) return false
  return true
}

const hasInlineMath = (text: string) => /\$[^$\n]+\$/.test(text)

/**
 * 让「展示公式块」与「含公式的正文段落」成为 markmap 的节点（其余内容原样保留）。
 *
 * @param markdown 已做 LaTeX 预处理、换行归一后的 Markdown（代码围栏内容不会被改写）
 * @param md       markmap 转换器自身的 markdown-it 实例（行内公式占位符由它渲染后替换回 KaTeX HTML）
 */
export function liftMindMapBlocks(markdown: string, md: Transformer['md']): string {
  const lines = markdown.split('\n')
  const inlineTokens: string[] = []
  INLINE_MATH_TOKENS.set(md, inlineTokens)
  patchRenderer(md)

  // 第一遍：标记代码围栏行，并统计每个标题小节的块级内容特征
  const fenced = new Array<boolean>(lines.length).fill(false)
  const sectionOf = new Array<number>(lines.length).fill(0)
  const sections: SectionFlags[] = [{ list: false, block: false }]
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    sectionOf[i] = sections.length - 1
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced[i] = true
      inFence = !inFence
      continue
    }
    if (inFence) {
      fenced[i] = true
      continue
    }
    if (/^#{1,6}\s/.test(line)) {
      sections.push({ list: false, block: false })
      sectionOf[i] = sections.length - 1
      continue
    }
    const cur = sections[sections.length - 1]
    if (/^\s*(?:[-*+]|\d+\.)\s/.test(line)) cur.list = true
    if (/^!\[[^\]]*\]\(/.test(line.trim())) cur.block = true
    if (/^\s*\|/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) cur.block = true
  }

  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) {
      out.push(lines[i])
      continue
    }
    const flags = sections[sectionOf[i]]

    // ① 独立成段的展示公式（$$…$$，可跨行）
    const open = /^([ \t]*)\$\$(.*)$/.exec(lines[i])
    if (open) {
      const indent = open[1]
      const rest = open[2]
      let body: string | null = null
      let last = i
      const closeIdx = rest.lastIndexOf('$$')
      if (closeIdx >= 0 && !rest.slice(closeIdx + 2).trim()) {
        body = rest.slice(0, closeIdx)
      } else {
        // 跨行公式：一直找到以 $$ 结尾的那一行
        const parts = [rest]
        let k = i + 1
        while (k < lines.length && !fenced[k] && !/\$\$[ \t]*$/.test(lines[k])) {
          parts.push(lines[k])
          k++
        }
        if (k < lines.length && !fenced[k]) {
          parts.push(lines[k].replace(/\$\$[ \t]*$/, ''))
          body = parts.join(' ')
          last = k
        }
      }
      const tex = (body ?? '').trim().replace(/\s+/g, ' ')
      const html = tex ? renderTex(tex, true) : ''
      if (!html) {
        out.push(...lines.slice(i, last + 1))
        i = last
        continue
      }
      const block = `<div class="${MATH_CLASS}">${html}</div>`
      // 落点与小节内其它提升块保持一致：小节里有表格 / 图片时统一用 div（等级 7），否则统一用列表项（等级 9），
      // 否则同小节的「表格 / 图片」或「本模块生成的 div」会把列表项整块挤掉。
      out.push(indent !== '' || !flags.block ? `${indent}- ${block}` : `${indent}${block}`)
      i = last
      continue
    }

    // ② 含行内公式的正文段落（连续行合并为一个节点，避免硬换行的段落被拆成多个）
    if (isParagraphLine(lines[i])) {
      let end = i
      while (end + 1 < lines.length && !fenced[end + 1] && isParagraphLine(lines[end + 1])) end++
      const text = lines.slice(i, end + 1).join(' ').trim()
      if (hasInlineMath(text)) {
        const tokenized = tokenizeInlineMath(text, inlineTokens)
        const html = md.renderInline(tokenized).trim()
        if (html) {
          out.push(flags.block ? `<div class="${TEXT_CLASS}">${html}</div>` : `- ${tokenized}`)
          i = end
          continue
        }
      }
      out.push(...lines.slice(i, end + 1).map((l) => tokenizeInlineMath(l, inlineTokens)))
      i = end
      continue
    }

    out.push(tokenizeInlineMath(lines[i], inlineTokens))
  }
  return out.join('\n')
}
