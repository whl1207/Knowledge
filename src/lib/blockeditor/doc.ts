/**
 * blockeditor/doc.ts — 文档命令层
 *
 * 所有编辑操作（回车拆块、退格合并、Tab 缩进、整块移动、类型转换）都收敛到这里，
 * 视图层只负责把「键盘/鼠标事件」翻译成命令 + 光标位置。
 *
 * 约定：命令直接原地修改 `doc.blocks`，返回新的光标位置（Caret）。
 */

import { Block, BlockType, BlockProps, LIST_TYPES, ParsedDoc, uid } from './types'

/** 光标位置：块下标 + 块内字符偏移（偏移基于 textarea 的值，即 lines.join('\n')） */
export interface Caret {
  index: number
  offset: number
}

// --- 文本与前缀 ------------------------------------------------------------

/** 块的完整源文本（textarea 显示的值） */
export function blockText(b: Block): string {
  return b.lines.join('\n')
}

export function setBlockText(b: Block, text: string): void {
  b.lines = text.split('\n')
  b.dirty = true
}

/** 各类型的行首前缀正则（只用于「单行可编辑块」） */
const PREFIX_RE: Partial<Record<BlockType, RegExp>> = {
  heading: /^(#{1,6}[ \t]+)/,
  todo: /^([-*+][ \t]+\[[ xX]\][ \t]+)/,
  bullet: /^([-*+][ \t]+)/,
  ordered: /^(\d{1,9}[.)][ \t]+)/,
  quote: /^(>[ \t]?)/,
}

/** 取块的行首前缀（如 `- [ ] `、`## `、`> `），无前缀返回 '' */
export function prefixOf(b: Block): string {
  const re = PREFIX_RE[b.type]
  if (!re) return ''
  return re.exec(b.lines[0] ?? '')?.[1] ?? ''
}

/** 围栏结束行 */
function isFenceClose(line: string): boolean {
  return /^[ \t]*(`{3,}|~{3,})[ \t]*$/.test(line)
}

/** 公式围栏行（单独一行的 $$） */
function isMathFence(line: string): boolean {
  return /^[ \t]*\$\$[ \t]*$/.test(line)
}

/** 块的「内容行」：剥掉围栏/前缀，用于内容编辑与类型转换 */
export function contentLines(b: Block): string[] {
  if (b.type === 'divider') return []

  if (b.type === 'math') {
    // 单行写法 $$E=mc^2$$
    if (b.lines.length === 1) {
      const m = /^\s*\$\$([\s\S]*)\$\$\s*$/.exec(b.lines[0])
      return m ? [m[1].trim()] : [b.lines[0]]
    }
    // 多行写法：末行必须是 $$ 才算闭合。
    // 坑：不能用 isFenceClose（那是反引号围栏的规则），否则末行的 $$ 会被当成内容留下来
    const closed = isMathFence(b.lines[b.lines.length - 1])
    return b.lines.slice(1, closed ? -1 : undefined)
  }

  if (b.type === 'code' && b.lines.length >= 2) {
    const closed = isFenceClose(b.lines[b.lines.length - 1])
    return b.lines.slice(1, closed ? -1 : undefined)
  }

  return b.lines
}

/** 块的纯内容（去掉类型前缀 / 围栏），用于合并与类型转换 */
export function bodyOf(b: Block): string {
  if (b.type === 'divider') return ''
  if (b.type === 'code' || b.type === 'math') return contentLines(b).join('\n')
  const first = (b.lines[0] ?? '').slice(prefixOf(b).length)
  return [first, ...b.lines.slice(1)].join('\n')
}

// --- 代码 / 公式块：只编辑内容，围栏由模型隐式维护 --------------------------

/** 代码/公式块的内容文本（不含围栏），直接给 textarea 使用 */
export function contentText(b: Block): string {
  return contentLines(b).join('\n')
}

/** 用「围栏 + 内容行」重建代码/公式块的行数组 */
function fencedLines(b: Block, text: string): string[] {
  const body = text.split('\n')
  if (b.type === 'math') return ['$$', ...body, '$$']
  const fence = /^(`{3,}|~{3,})/.exec(b.lines[0] ?? '')?.[1] ?? '```'
  const info = (b.props.lang ?? '') + (b.props.info ? ' ' + b.props.info : '')
  return [fence + info, ...body, fence]
}

/** 写回代码/公式块内容（保留原围栏与语言） */
export function setContentText(b: Block, text: string): void {
  b.lines = fencedLines(b, text)
  b.dirty = true
}

/** 修改代码块语言 */
export function setCodeLang(b: Block, lang: string): void {
  b.props = { ...b.props, lang: lang.trim() }
  b.lines = fencedLines(b, contentText(b))
  b.dirty = true
}

// --- 类型转换 --------------------------------------------------------------

/** 生成某类型对应的行首前缀 */
export function prefixFor(type: BlockType, props: BlockProps = {}): string {
  switch (type) {
    case 'heading':
      return '#'.repeat(Math.min(6, Math.max(1, props.level ?? 1))) + ' '
    case 'bullet':
      return '- '
    case 'ordered':
      return `${props.start ?? 1}. `
    case 'todo':
      return props.checked ? '- [x] ' : '- [ ] '
    case 'quote':
      return '> '
    default:
      return ''
  }
}

/** 把块改写为目标类型（内容尽量保留） */
export function applyType(b: Block, type: BlockType, props: BlockProps = {}): void {
  const body = bodyOf(b)
  const lines = body.split('\n')

  b.type = type
  b.props = { ...props }
  b.dirty = true

  switch (type) {
    case 'divider':
      b.lines = ['---']
      b.indentLevel = 0
      return
    case 'code':
      b.lines = ['```' + (props.lang ?? ''), ...lines, '```']
      b.indentLevel = 0
      return
    case 'math':
      b.lines = ['$$', ...lines, '$$']
      b.indentLevel = 0
      return
    case 'table':
      // 最小可用骨架，用户随后直接改源码
      b.lines = ['| 列 1 | 列 2 |', '| --- | --- |', '|  |  |']
      b.indentLevel = 0
      return
    case 'paragraph':
    case 'heading':
      // 段落/标题不再保留嵌套（缩进 4 空格会被 markdown 当成代码块）
      b.indentLevel = 0
      b.lines = [prefixFor(type, props) + (lines[0] ?? ''), ...lines.slice(1)]
      return
    default:
      // 列表类：保留当前缩进层级
      b.lines = [prefixFor(type, props) + (lines[0] ?? ''), ...lines.slice(1)]
      return
  }
}

/** 切换块的类型（保持光标落在内容起始处） */
export function setBlockType(doc: ParsedDoc, index: number, type: BlockType, props: BlockProps = {}): Caret {
  const b = doc.blocks[index]
  if (!b) return { index, offset: 0 }
  applyType(b, type, props)
  return { index, offset: prefixOf(b).length }
}

/** 勾选 / 取消勾选待办 */
export function toggleTodo(doc: ParsedDoc, index: number): boolean {
  const b = doc.blocks[index]
  if (!b || b.type !== 'todo') return false
  const checked = !b.props.checked
  b.props = { ...b.props, checked }
  b.lines[0] = (b.lines[0] ?? '').replace(/\[[ xX]\]/, checked ? '[x]' : '[ ]')
  b.dirty = true
  return true
}

// --- 插入 / 删除 -----------------------------------------------------------

/** 在 index 之后插入一个块（块后的空行跟着新块走） */
export function insertBlockAfter(doc: ParsedDoc, index: number, block: Block): Caret {
  const prev = doc.blocks[index]
  if (prev) {
    block.blankAfter = prev.blankAfter
    prev.blankAfter = 0
  }
  doc.blocks.splice(index + 1, 0, block)
  return { index: index + 1, offset: 0 }
}

/** 删除一个块（返回删除后应聚焦的位置） */
export function removeBlock(doc: ParsedDoc, index: number): Caret {
  if (doc.blocks.length <= 1) {
    // 至少保留一个空段落
    const only = doc.blocks[index]
    applyType(only, 'paragraph')
    setBlockText(only, '')
    only.blankAfter = 0
    return { index: 0, offset: 0 }
  }
  const gone = doc.blocks[index]
  const prev = doc.blocks[index - 1]
  if (prev && gone) prev.blankAfter += gone.blankAfter
  doc.blocks.splice(index, 1)
  return { index: Math.max(0, Math.min(index, doc.blocks.length - 1)), offset: 0 }
}

/**
 * 前向合并：把「下一块」的内容并进当前块（光标在块尾按 Delete 时用）。
 * 与 mergeBackward 方向相反，语义对齐 Notion / 谷歌文档：下一块的正文接到当前块末尾，下一块被删掉，
 * 光标停在接缝处；下一块是空块 / 分割线时直接删掉（光标不动）；
 * 下一块是代码 / 公式 / 表格这类块级内容时不动 —— 把围栏或表格源码当正文拼进来会毁掉它的语义。
 */
export function mergeForward(doc: ParsedDoc, index: number): Caret | null {
  const cur = doc.blocks[index]
  const next = doc.blocks[index + 1]
  if (!cur || !next) return null
  if (next.type === 'code' || next.type === 'math' || next.type === 'table' || next.type === 'raw') return null

  const curText = blockText(cur)
  const nextBody = bodyOf(next)
  // 空行归属：两块之间的空行随合并消失，只保留下一块后面的空行
  // （直接 removeBlock 会把两者累加，合并后凭空多出一个空行）
  cur.blankAfter = next.blankAfter
  doc.blocks.splice(index + 1, 1)

  // 空块 / 分割线：没有正文可接，只删块（光标位置不变）
  if (next.type === 'divider' || (nextBody.trim() === '' && next.lines.length <= 1)) {
    return { index, offset: curText.length }
  }

  setBlockText(cur, curText + nextBody)
  return { index, offset: curText.length }
}

/**
 * 回车：在光标处把块一分为二。
 * 视图层负责在 code / math / table 内不要调用本命令（那里回车应换行）。
 */
export function enterBlocks(doc: ParsedDoc, index: number, offset: number): Caret {
  const b = doc.blocks[index]
  if (!b) return { index, offset }

  const prefix = prefixOf(b)
  const text = blockText(b)
  // 光标落在前缀里时视为块首
  const off = Math.max(offset, prefix.length)
  const head = text.slice(0, off)
  const tail = text.slice(off)

  // 空列表项回车 → 退出列表（有缩进先降一级，否则转普通段落）
  if (LIST_TYPES.includes(b.type) && tail.trim() === '' && head.slice(prefix.length).trim() === '') {
    if (b.indentLevel > 0) {
      indentSubtree(doc, index, -1)
      setBlockText(b, prefixFor(b.type, b.props))
      return { index, offset: prefix.length }
    }
    applyType(b, 'paragraph')
    setBlockText(b, '')
    return { index, offset: 0 }
  }

  // 空引用同理：回车退出引用
  if (b.type === 'quote' && tail.trim() === '' && head.slice(prefix.length).trim() === '') {
    applyType(b, 'paragraph')
    setBlockText(b, '')
    return { index, offset: 0 }
  }

  setBlockText(b, head)

  // 新块类型：标题回车后转段落；有序列表编号递增；其余延续原类型
  let newType: BlockType = b.type
  let newProps: BlockProps = { ...b.props }
  if (b.type === 'heading' || b.type === 'divider') {
    newType = 'paragraph'
    newProps = {}
  } else if (b.type === 'ordered') {
    newProps = { ...b.props, start: (b.props.start ?? 1) + 1 }
  }

  const nb: Block = {
    id: uid(),
    type: newType,
    lines: [prefixFor(newType, newProps) + tail],
    indent: b.indent,
    indentLevel: LIST_TYPES.includes(newType) ? b.indentLevel : 0,
    props: newProps,
    // 原来挂在 b 后面的空行，现在跟在拆出来的新块后面
    blankAfter: b.blankAfter,
    dirty: true,
  }
  b.blankAfter = 0
  doc.blocks.splice(index + 1, 0, nb)
  return { index: index + 1, offset: prefixOf(nb).length }
}

/** 退格合并：把当前块并入上一块（返回 null 表示无操作） */
export function mergeBackward(doc: ParsedDoc, index: number): Caret | null {
  if (index <= 0) return null
  const prev = doc.blocks[index - 1]
  const cur = doc.blocks[index]
  if (!prev || !cur) return null

  const curBody = bodyOf(cur)

  // 当前块无内容 → 直接删掉，光标回到上一块末尾
  if (curBody.trim() === '' && cur.lines.length <= 1) {
    prev.blankAfter += cur.blankAfter
    doc.blocks.splice(index, 1)
    return { index: index - 1, offset: blockText(prev).length }
  }

  // 列表项退格 → 先降级（有缩进）再退出列表（无缩进且为空时已在上一步处理）
  if (LIST_TYPES.includes(cur.type)) {
    if (cur.indentLevel > 0) {
      indentSubtree(doc, index, -1)
      return { index, offset: 0 }
    }
    // 无缩进列表项退格 → 转普通段落
    applyType(cur, 'paragraph')
    return { index, offset: 0 }
  }

  const prevText = blockText(prev)
  setBlockText(prev, prevText + curBody)
  prev.blankAfter = cur.blankAfter
  doc.blocks.splice(index, 1)
  return { index: index - 1, offset: prevText.length }
}

// --- 缩进 / 移动 -----------------------------------------------------------

/** 取以 index 为根的子树范围 [start, end)（按缩进层级判定） */
export function subtreeRange(doc: ParsedDoc, index: number): [number, number] {
  const root = doc.blocks[index]
  if (!root) return [index, index + 1]
  let end = index + 1
  // 只有列表类才可能有子块；引用/段落按单块处理
  if (!LIST_TYPES.includes(root.type)) return [index, index + 1]
  while (end < doc.blocks.length) {
    const b = doc.blocks[end]
    if (!LIST_TYPES.includes(b.type)) break
    if (b.indentLevel <= root.indentLevel) break
    end += 1
  }
  return [index, end]
}

/**
 * 缩进/反缩进整棵子树。
 * 限制：一级最多比前一个同级项深一层（否则 markdown 缩进语义会乱）。
 */
export function indentSubtree(doc: ParsedDoc, index: number, delta: number): boolean {
  const root = doc.blocks[index]
  if (!root || !LIST_TYPES.includes(root.type)) return false

  const target = root.indentLevel + delta
  if (target < 0) return false
  if (delta > 0) {
    const prev = doc.blocks[index - 1]
    const maxLevel = prev && LIST_TYPES.includes(prev.type) ? prev.indentLevel + 1 : 0
    if (target > maxLevel) return false
  }

  const [start, end] = subtreeRange(doc, index)
  for (let i = start; i < end; i++) {
    doc.blocks[i].indentLevel = Math.max(0, doc.blocks[i].indentLevel + delta)
    doc.blocks[i].dirty = true
  }
  return true
}

/** 整块（含子树）移动到目标位置。to 为移动后的目标下标 */
export function moveBlocks(doc: ParsedDoc, from: number, to: number): Caret {
  const [start, end] = subtreeRange(doc, from)
  const slice = doc.blocks.slice(start, end)
  doc.blocks.splice(start, end - start)

  let target = to
  if (target > start) target -= slice.length
  target = Math.max(0, Math.min(target, doc.blocks.length))

  doc.blocks.splice(target, 0, ...slice)
  return { index: target, offset: 0 }
}

/** 上移/下移一个位置（含子树） */
export function nudgeBlock(doc: ParsedDoc, index: number, dir: -1 | 1): Caret {
  const [start, end] = subtreeRange(doc, index)
  if (dir === -1) {
    if (start === 0) return { index, offset: 0 }
    return moveBlocks(doc, index, start - 1)
  }
  if (end >= doc.blocks.length) return { index, offset: 0 }
  return moveBlocks(doc, index, end + 1)
}

/** 在当前块之后追加文本（ASR / 拖入文件等场景用） */
export function appendText(doc: ParsedDoc, text: string): Caret {
  const last = doc.blocks[doc.blocks.length - 1]
  if (!last) {
    const nb: Block = {
      id: uid(),
      type: 'paragraph',
      lines: text.split('\n'),
      indent: '',
      indentLevel: 0,
      props: {},
      blankAfter: 0,
      dirty: true,
    }
    doc.blocks.push(nb)
    return { index: 0, offset: text.length }
  }
  const cur = blockText(last)
  const next = cur + (cur ? '\n\n' : '') + text
  setBlockText(last, next)
  return { index: doc.blocks.length - 1, offset: next.length }
}
