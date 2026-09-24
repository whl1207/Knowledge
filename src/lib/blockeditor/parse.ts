/**
 * blockeditor/parse.ts — Markdown -> Block[]（行导向解析）
 *
 * 为什么不用 markdown-it 的 token 流：
 *   token 流丢弃了原文的书写细节（列表符号 `*` / `+`、有序列表分隔符 `)`、
 *   围栏用 ``` 还是 ~~~、连续空行数量……），而我们的存储是 markdown 本身，
 *   必须逐字节可逆。所以这里做的是「有类型标注的行分组」，而不是语义解析；
 *   markdown-it 只负责渲染预览。
 *
 * 关键不变式：serialize(parse(src)) === src（对全部输入成立）
 */

import {
  Block,
  BlockType,
  BlockProps,
  ParsedDoc,
  MULTILINE_TYPES,
  LIST_TYPES,
  indentWidth,
  uid,
} from './types'

// --- 行模式 ---------------------------------------------------------------

/** 围栏开始：``` lang 或 ~~~ lang */
const RE_FENCE_OPEN = /^([ \t]*)(`{3,}|~{3,})[ \t]*([^\n]*)$/
/** 标题 */
const RE_HEADING = /^([ \t]*)(#{1,6})([ \t]+)(.*)$/
/** 待办 */
const RE_TODO = /^([ \t]*)([-*+])([ \t]+)\[([ xX])\]([ \t]+)(.*)$/
/** 无序列表 */
const RE_BULLET = /^([ \t]*)([-*+])([ \t]+)(.*)$/
/** 有序列表 */
const RE_ORDERED = /^([ \t]*)(\d{1,9})([.)])([ \t]+)(.*)$/
/** 引用 */
const RE_QUOTE = /^([ \t]*)(>)([ \t]?)(.*)$/
/** 分割线 */
const RE_DIVIDER = /^[ \t]{0,3}([-*_])([ \t]*\1){2,}[ \t]*$/
/** 块级公式围栏：单独一行的 $$ */
const RE_MATH_FENCE = /^([ \t]*)\$\$[ \t]*$/
/** 单行块级公式：$$E=mc^2$$（整行只有公式） */
const RE_MATH_LINE = /^([ \t]*)\$\$(.+?)\$\$[ \t]*$/
/** 表格分隔行 */
const RE_TABLE_DELIM = /^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/

/** 拆出前导空白与其余内容 */
function splitIndent(line: string): [string, string] {
  const m = /^([ \t]*)([\s\S]*)$/.exec(line)
  return m ? [m[1], m[2]] : ['', line]
}

/** 上一行是否可能作为表头（含 `|`），且下一行是分隔行 */
function isTableStart(lines: string[], i: number): boolean {
  const cur = lines[i]
  const next = lines[i + 1]
  if (cur === undefined || next === undefined) return false
  if (!cur.includes('|')) return false
  return RE_TABLE_DELIM.test(next) && next.includes('|')
}

/** 收集一个块，返回块与下一个待处理行号 */
function readBlock(lines: string[], start: number): { block: Block; next: number } {
  const line = lines[start]
  const [indent, body] = splitIndent(line)

  // 1) 围栏代码块（包含 mermaid / 普通代码）
  const fence = RE_FENCE_OPEN.exec(line)
  if (fence) {
    const marker = fence[2]
    const info = fence[3].trim()
    // 首行原样保留（`​​​js` 与 `​​​ js` 不能互相改写）
    const out: string[] = [body]
    let i = start + 1
    const closeRe = new RegExp('^[ \\t]*' + marker[0].repeat(3) + '[' + marker[0] + ']*[ \\t]*$')
    for (; i < lines.length; i++) {
      out.push(lines[i])
      if (closeRe.test(lines[i])) {
        i += 1
        break
      }
    }
    // 未闭合：按 markdown 语义吃掉剩余全部内容
    const lang = info.split(/\s+/)[0] || ''
    const props: BlockProps = {}
    if (lang) props.lang = lang
    const rest = info.slice(lang.length).trim()
    if (rest) props.info = rest
    return {
      block: make('code', indent, out, props),
      next: i,
    }
  }

  // 2) 块级公式 $$ ... $$
  if (RE_MATH_FENCE.test(line)) {
    const out: string[] = ['$$']
    let i = start + 1
    for (; i < lines.length; i++) {
      out.push(lines[i])
      if (RE_MATH_FENCE.test(lines[i])) {
        i += 1
        break
      }
    }
    return { block: make('math', indent, out), next: i }
  }

  // 2b) 单行公式 $$E=mc^2$$ → 也认成 math 块（这样才能用编辑器编辑公式）
  if (RE_MATH_LINE.test(line)) {
    return { block: make('math', indent, [body]), next: start + 1 }
  }

  // 3) 分割线（必须早于列表判断：`- - -` 同时符合无序列表）
  if (RE_DIVIDER.test(line)) {
    return { block: make('divider', indent, [body]), next: start + 1 }
  }

  // 4) 标题
  const h = RE_HEADING.exec(line)
  if (h) {
    return {
      block: make('heading', indent, [body], { level: h[2].length }),
      next: start + 1,
    }
  }

  // 5) 待办（早于无序列表）
  const td = RE_TODO.exec(line)
  if (td) {
    const checked = td[4].toLowerCase() === 'x'
    return {
      block: make('todo', td[1], [body], { checked }),
      next: start + 1,
    }
  }

  // 6) 无序列表
  if (RE_BULLET.test(line)) {
    return { block: make('bullet', indent, [body]), next: start + 1 }
  }

  // 7) 有序列表
  const o = RE_ORDERED.exec(line)
  if (o) {
    return {
      block: make('ordered', indent, [body], {
        start: parseInt(o[2], 10),
        delimiter: o[3],
      }),
      next: start + 1,
    }
  }

  // 8) 引用
  if (RE_QUOTE.test(line)) {
    return { block: make('quote', indent, [body]), next: start + 1 }
  }

  // 9) 表格
  if (isTableStart(lines, start)) {
    const out: string[] = []
    let i = start
    for (; i < lines.length; i++) {
      if (!lines[i].includes('|') || lines[i].trim() === '') break
      out.push(lines[i])
    }
    return { block: make('table', '', out), next: i }
  }

  // 10) 段落：连续非空、且不会被其它块类型打断的行
  const out: string[] = []
  let i = start
  for (; i < lines.length; i++) {
    const cur = lines[i]
    if (cur.trim() === '') break
    if (i > start && startsNewBlock(lines, i)) break
    out.push(cur)
  }
  if (out.length === 1) {
    return { block: make('paragraph', indent, [body]), next: i }
  }
  // 多行段落：整体原样保留（首行缩进不再剥离，保证可逆）
  return { block: make('paragraph', '', out), next: i }
}

/** 该行是否会打断段落（与 markdown 的段落中断规则近似） */
function startsNewBlock(lines: string[], i: number): boolean {
  const line = lines[i]
  if (RE_FENCE_OPEN.test(line)) return true
  if (RE_MATH_FENCE.test(line)) return true
  if (RE_MATH_LINE.test(line)) return true
  if (RE_DIVIDER.test(line)) return true
  if (RE_HEADING.test(line)) return true
  if (RE_TODO.test(line)) return true
  if (RE_BULLET.test(line)) return true
  if (RE_ORDERED.test(line)) return true
  if (RE_QUOTE.test(line)) return true
  if (isTableStart(lines, i)) return true
  return false
}

function make(type: BlockType, indent: string, lines: string[], props: BlockProps = {}): Block {
  return {
    id: uid(),
    type,
    lines,
    indent,
    indentLevel: 0,
    props,
    blankAfter: 0,
    dirty: false,
  }
}

/**
 * 缩进层级：按「缩进宽度栈」推导，避免把 4 空格硬编码成 2 级。
 * 只对列表类生效；遇到非列表块时栈重置。
 */
function assignIndentLevels(blocks: Block[]): string {
  const stack: number[] = []
  let unit = '  '
  let unitFound = false

  for (const blk of blocks) {
    if (!LIST_TYPES.includes(blk.type)) {
      stack.length = 0
      blk.indentLevel = 0
      continue
    }
    const w = indentWidth(blk.indent)
    while (stack.length && w < stack[stack.length - 1]) stack.pop()
    if (!stack.length || w > stack[stack.length - 1]) {
      // 记录一级缩进的真实宽度作为缩进单位（取最小正增量）
      if (stack.length) {
        const delta = w - stack[stack.length - 1]
        if (!unitFound && delta > 0) {
          if (blk.indent.includes('\t')) unit = '\t'
          else unit = ' '.repeat(Math.min(delta, 4))
          unitFound = true
        }
      }
      stack.push(w)
    }
    blk.indentLevel = stack.length - 1
  }
  return unit
}

/** 解析 Markdown 为文档模型 */
export function parseMarkdown(src: string): ParsedDoc {
  const eol: '\n' | '\r\n' = src.includes('\r\n') ? '\r\n' : '\n'
  const normalized = src.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const trailingNewline = normalized.endsWith('\n')

  const lines = normalized.split('\n')
  if (trailingNewline) lines.pop()

  const blocks: Block[] = []
  let leadingBlank = 0
  let i = 0

  while (i < lines.length && lines[i].trim() === '') {
    leadingBlank += 1
    i += 1
  }

  // 空行始终归属「它前面的那个块」（用 blankAfter 记录），
  // 这样连续空行数量才能逐字节还原。
  let pendingBlank = 0
  while (i < lines.length) {
    if (lines[i].trim() === '') {
      pendingBlank += 1
      i += 1
      continue
    }
    const { block, next } = readBlock(lines, i)
    if (blocks.length > 0) blocks[blocks.length - 1].blankAfter = pendingBlank
    pendingBlank = 0
    blocks.push(block)
    i = next
  }

  // 文件末尾的空行同样挂到最后一个块上
  if (pendingBlank > 0 && blocks.length > 0) {
    blocks[blocks.length - 1].blankAfter = pendingBlank
  }

  const indentUnit = assignIndentLevels(blocks)

  return { blocks, leadingBlank, trailingNewline, indentUnit, eol }
}

/** 供 UI 使用：判断单行文本对应的类型（不含多行块） */
export function detectLineType(line: string): BlockType | null {
  if (RE_DIVIDER.test(line)) return 'divider'
  if (RE_MATH_FENCE.test(line)) return 'math'
  if (RE_HEADING.test(line)) return 'heading'
  if (RE_TODO.test(line)) return 'todo'
  if (RE_BULLET.test(line)) return 'bullet'
  if (RE_ORDERED.test(line)) return 'ordered'
  if (RE_QUOTE.test(line)) return 'quote'
  return null
}

export { MULTILINE_TYPES }
