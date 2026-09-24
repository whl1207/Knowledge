/**
 * blockeditor/serialize.ts — Block[] -> Markdown
 *
 * 核心策略（避免「打开→保存」产生无意义 diff）：
 *   - 未编辑过的块（dirty === false）：缩进字符串、正文行全部原样输出；
 *   - 编辑过的块（dirty === true）：按 canonical 规则重写缩进（用文档推断出的缩进单位）；
 *   - 空行、文件首尾空行、换行符，全部按解析时记录的原始信息还原。
 *
 * 不变式：serializeMarkdown(parseMarkdown(src)) === src
 */

import { Block, ParsedDoc, MULTILINE_TYPES } from './types'

/** 渲染单个块的文本（不含其后的空行） */
function renderBlock(blk: Block, unit: string): string {
  const indent = blk.dirty ? unit.repeat(blk.indentLevel) : blk.indent

  if (blk.lines.length <= 1) {
    return indent + (blk.lines[0] ?? '')
  }

  // 多行块：代码/公式/表格/raw 的后续行属于内容，缩进只作用于首行
  if (MULTILINE_TYPES.includes(blk.type)) {
    return indent + blk.lines[0] + '\n' + blk.lines.slice(1).join('\n')
  }

  // 多行段落/引用：缩进作用于所有非空行
  if (!indent) return blk.lines.join('\n')
  return blk.lines.map((l) => (l === '' ? l : indent + l)).join('\n')
}

export interface SerializeOptions {
  /** 换行符，默认沿用解析时记录的 eol */
  eol?: '\n' | '\r\n'
}

/** 文档模型 -> Markdown 文本 */
export function serializeMarkdown(doc: ParsedDoc, opts: SerializeOptions = {}): string {
  const unit = doc.indentUnit || '  '
  let out = '\n'.repeat(doc.leadingBlank)

  for (const blk of doc.blocks) {
    out += renderBlock(blk, unit)
    out += '\n'.repeat(1 + blk.blankAfter)
  }

  if (!doc.trailingNewline && out.endsWith('\n')) out = out.slice(0, -1)

  const eol = opts.eol ?? doc.eol
  return eol === '\r\n' ? out.replace(/\n/g, '\r\n') : out
}

/**
 * 规范化单个块的源文本（供 UI 失焦 / 类型转换后调用）。
 * 会更新 blk.lines / props，并置 dirty = true。
 */
export function reparseBlock(blk: Block, src: string): void {
  const lines = src.split('\n')
  blk.lines = lines
  blk.dirty = true
}
