/**
 * blockeditor/formula.ts — 「公式段落」的识别与写回
 *
 * 背景：`\[…\]`、裸 `\begin{cases}…\end{cases}` 这类展示公式写在 Markdown 里时，
 * 块类型仍是 paragraph（只有整行 `$$…$$` 才会被 parse.ts 识别成 math 块）。于是出现两个问题：
 *  1. 点进去用普通 textarea 编辑，看到的是原始 LaTeX 与反斜杠定界符，与 `$$` 公式块的 Monaco 公式编辑器体验不一致；
 *  2. 参与「渲染文本 → 源码」贪心映射时，MathJax 输出（字形是 path、文本是拼接结果）根本对不上，会删出莫名其妙的结果。
 *
 * 这里统一把「整块只有一条展示公式的段落」按公式块对待：
 *  - 渲染：包成 `$$…$$` 走同一条渲染链路；
 *  - 编辑：进 Monaco（lang=latex，不显示语言栏）；
 *  - 写回：保留原有定界符（`\[…\]` / `$$…$$` / 裸环境）、单行写法与公式后的收尾标点（`\]。` 里的 `。`）。
 */

import { Block } from './types'
import { blockText, setBlockText, contentText, setContentText } from './doc'

/** 公式后的收尾标点（中文论文里 `\]。`、`\],` 很常见） */
const TAIL_PUNCT = '[。，、；：？！）】》」』”’…,.;:!?)]'

/** 纯数字/分隔符（参考文献标号 `\[7\]`、`\[1-3\]`）——LaTeX 转义的方括号，不是公式 */
const RE_CITATION_MARK = /^[\d\s,;、\-–—]+$/

/** `\[ … \]`（可带尾随标点） */
const RE_BRACKET = new RegExp('^[ \\t]*\\\\\\[([\\s\\S]*?)\\\\\\]([^\\S\\n]*' + TAIL_PUNCT + '*)[ \\t]*$')
/** 裸 LaTeX 环境 `\begin{env} … \end{env}`（可带尾随标点） */
const RE_ENV = new RegExp('^[ \\t]*(\\\\begin\\{[a-zA-Z*]+\\}[\\s\\S]*?\\\\end\\{[a-zA-Z*]+\\})([^\\S\\n]*' + TAIL_PUNCT + '*)[ \\t]*$')

/** 整块恰为一条展示公式时的拆解结果 */
export interface FormulaPara {
  /** 公式正文（不含定界符） */
  body: string
  /** 开/闭定界符（裸 LaTeX 环境为 ''） */
  open: string
  close: string
  /** 公式后的收尾标点：不在编辑器里显示，写回时原样带回 */
  tail: string
  /** 原本是单行写法（`\[x=1\]`） */
  single: boolean
}

/** 段落里只放一条展示公式时返回拆解信息，否则 null */
export function formulaParagraph(b: Block | undefined | null): FormulaPara | null {
  if (!b || b.type !== 'paragraph') return null
  const text = blockText(b)
  let m = RE_BRACKET.exec(text)
  if (m) {
    // `\[7\]`、`\[1-3\]` 这类参考文献标号是 LaTeX 转义的方括号（渲染成字面 [7]），不能当公式：
    // 单行且内容只有数字与分隔符 → 仍按普通段落处理
    if (!/[\r\n]/.test(m[1]) && RE_CITATION_MARK.test(m[1].trim())) return null
    return { body: m[1].trim(), open: '\\[', close: '\\]', tail: m[2] || '', single: b.lines.length === 1 }
  }
  m = RE_ENV.exec(text)
  if (m) return { body: m[1].trim(), open: '', close: '', tail: m[2] || '', single: true }
  return null
}

/** 公式类块：math 块，或只含一条展示公式的段落 */
export function isFormulaBlock(b: Block | undefined | null): boolean {
  return !!b && (b.type === 'math' || !!formulaParagraph(b))
}

/** 公式编辑器里的文本（不含定界符与尾随标点）；非公式块返回 null */
export function formulaEditText(b: Block): string | null {
  if (b.type === 'math') return contentText(b)
  return formulaParagraph(b)?.body ?? null
}

/** 渲染用源码：`$$…$$` 里的内容（含尾随标点，与浏览视图一致）；非公式块返回 null */
export function formulaSource(b: Block): string | null {
  if (b.type === 'math') return contentText(b)
  const info = formulaParagraph(b)
  return info ? info.body + info.tail : null
}

/** 写回公式正文：保留原有定界符 / 单行写法 / 尾随标点 */
export function setFormulaText(b: Block, text: string): void {
  if (b.type === 'math') {
    setContentText(b, text)
    return
  }
  const info = formulaParagraph(b)
  if (!info) {
    setBlockText(b, text)
    return
  }
  const body = text.replace(/[\s\u00a0]+$/, '')
  if (!info.open) b.lines = [body + info.tail]
  else if (info.single && !body.includes('\n')) b.lines = [info.open + body + info.close + info.tail]
  else b.lines = [info.open, ...body.split('\n'), info.close + info.tail]
  b.dirty = true
}
