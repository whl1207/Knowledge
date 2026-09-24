/**
 * blockeditor/selftest.ts — 往返一致性自测（Markdown -> 块模型 -> Markdown）
 *
 * 目的：保证「打开文件 → 立刻保存」不会改动文件内容。
 * 任何一条用例失败都说明解析或序列化丢/改了原文信息。
 *
 * 用法（开发期）：
 *   import { logRoundTripSelfTest } from '@/lib/blockeditor/selftest'
 *   logRoundTripSelfTest()
 */

import { parseMarkdown } from './parse'
import { serializeMarkdown } from './serialize'
import {
  appendText as cmdAppendText,
  contentText,
  enterBlocks,
  mergeBackward,
  mergeForward,
  indentSubtree,
  moveBlocks,
  nudgeBlock,
  setBlockType,
  toggleTodo,
} from './doc'
import type { Block, ParsedDoc } from './types'
import { formulaEditText, formulaSource, isFormulaBlock, setFormulaText } from './formula'
import { runTableSelfTest } from './table'
import { runTypesetSelfTest } from '@/lib/typeset/selftest'
import { runMermaidNormalizeSelfTest } from '@/lib/markdown/mermaid-selftest'

// 表格 / 排版 / mermaid 规范化自测一并从这里导出，方便统一入口一把跑完
export { runTableSelfTest, runTypesetSelfTest, runMermaidNormalizeSelfTest }

/** 把一个块压缩成可比较的签名：类型 + 缩进层级 + 关键属性 */
function signature(b: Block): string {
  let s = b.type
  if (b.indentLevel > 0) s += `>${b.indentLevel}`
  if (b.type === 'heading') s += `#${b.props.level}`
  if (b.type === 'code') s += `(${b.props.lang ?? ''})`
  if (b.type === 'ordered') s += `(start=${b.props.start})`
  if (b.type === 'todo') s += b.props.checked ? '[x]' : '[ ]'
  return s
}

/** 结构用例：src -> 期望的块签名序列 */
export const STRUCTURE_CASES: Array<{ name: string; src: string; expect: string[] }> = [
  { name: '标题级别', src: '# a\n## b\n###### c\n', expect: ['heading#1', 'heading#2', 'heading#6'] },
  { name: '列表嵌套层级（2 空格）', src: '- a\n  - b\n    - c\n- d\n', expect: ['bullet', 'bullet>1', 'bullet>2', 'bullet'] },
  { name: '列表嵌套层级（4 空格）', src: '- a\n    - b\n        - c\n', expect: ['bullet', 'bullet>1', 'bullet>2'] },
  { name: '列表嵌套层级（tab）', src: '- a\n\t- b\n', expect: ['bullet', 'bullet>1'] },
  { name: '待办勾选状态', src: '- [ ] a\n- [x] b\n- [X] c\n', expect: ['todo[ ]', 'todo[x]', 'todo[x]'] },
  { name: '有序列表起点', src: '3. a\n4. b\n', expect: ['ordered(start=3)', 'ordered(start=4)'] },
  { name: '引用', src: '> a\n> b\n', expect: ['quote', 'quote'] },
  { name: '围栏与语言', src: '```js\nx\n```\n```mermaid\ngraph\n```\n', expect: ['code(js)', 'code(mermaid)'] },
  { name: '表格不被拆散', src: '| a | b |\n| --- | --- |\n| 1 | 2 |\n', expect: ['table'] },
  { name: '块级公式', src: '$$\nE=mc^2\n$$\n', expect: ['math'] },
  { name: '分割线', src: '---\n***\n- - -\n', expect: ['divider', 'divider', 'divider'] },
  { name: '多行段落', src: 'a\nb\nc\n', expect: ['paragraph'] },
  { name: '段落后接列表', src: 'a\nb\n- c\n', expect: ['paragraph', 'bullet'] },
  { name: '代码块内不误判', src: '```md\n# 不是标题\n- 不是列表\n```\n', expect: ['code(md)'] },
]

/** 执行结构断言 */
export function runStructureSelfTest(
  cases: typeof STRUCTURE_CASES = STRUCTURE_CASES
): Array<{ name: string; ok: boolean; expected: string[]; actual: string[] }> {
  return cases.map((c) => {
    const actual = parseMarkdown(c.src).blocks.map(signature)
    return {
      name: c.name,
      ok: actual.length === c.expect.length && actual.every((v, i) => v === c.expect[i]),
      expected: c.expect,
      actual,
    }
  })
}

export interface SelfTestCase {
  name: string
  src: string
}

export interface SelfTestResult {
  name: string
  ok: boolean
  expected: string
  actual: string
}

/** 覆盖各类语法与边界（含尾随空格、CRLF、无尾换行、未识别语法） */
export const ROUND_TRIP_CASES: SelfTestCase[] = [
  { name: '空文件', src: '' },
  { name: '仅换行', src: '\n' },
  { name: '多个开头空行', src: '\n\n\n正文\n' },
  { name: '无尾换行', src: '# 标题\n正文' },
  { name: 'CRLF', src: '# 标题\r\n正文\r\n' },
  { name: '尾部空行', src: '正文\n\n\n' },
  { name: '段落软换行', src: '第一行\n第二行\n第三行\n' },
  { name: '标题 1-6', src: '# h1\n## h2\n### h3\n#### h4\n##### h5\n###### h6\n' },
  { name: '无序列表（三种符号混用）', src: '- a\n* b\n+ c\n' },
  { name: '有序列表（两种分隔符）', src: '1. a\n2. b\n3) c\n' },
  { name: '嵌套列表 2 空格', src: '- a\n  - a1\n    - a2\n- b\n' },
  { name: '嵌套列表 4 空格', src: '- a\n    - a1\n        - a2\n' },
  { name: '嵌套列表 tab', src: '- a\n\t- a1\n\t\t- a2\n' },
  { name: '待办', src: '- [ ] 未完成\n- [x] 已完成\n- [X] 大写完成\n' },
  { name: '引用', src: '> 引用一\n> 引用二\n' },
  { name: '引用含空行', src: '> 引用一\n\n> 引用二\n' },
  { name: '分割线（三种写法）', src: '---\n\n***\n\n___\n\n- - -\n' },
  { name: '围栏代码块', src: '```js\nconst a = 1\n```\n' },
  { name: '围栏代码块无语言', src: '```\nplain\n```\n' },
  { name: '围栏代码块带额外 info', src: '```ts twoslash\nlet a = 1\n```\n' },
  { name: '波浪围栏', src: '~~~python\nprint(1)\n~~~\n' },
  { name: '代码块内含井号与横线', src: '```md\n# 不是标题\n- 不是列表\n```\n' },
  { name: 'mermaid 块', src: '```mermaid\ngraph TD\n  A --> B\n```\n' },
  { name: '块级公式', src: '$$\nE = mc^2\n$$\n' },
  { name: '行内公式', src: '能量 $E = mc^2$ 与前后文\n' },
  { name: '表格', src: '| a | b |\n| --- | --- |\n| 1 | 2 |\n' },
  { name: '表格含对齐', src: '| a | b |\n| :-- | --: |\n| 1 | 2 |\n' },
  { name: '图片', src: '![图](./img/a.png)\n' },
  { name: '链接', src: '[文档](./x.md)\n' },
  { name: 'HTML 块', src: '<div class="x">\n  <span>hi</span>\n</div>\n' },
  { name: 'YAML frontmatter', src: '---\ntitle: 测试\ntags:\n  - a\n---\n\n正文\n' },
  { name: '尾随空格', src: '正文   \n下一行\n' },
  { name: '行尾双空格换行', src: '第一行  \n第二行\n' },
  { name: '混合长文档', src: '# 标题\n\n段落一\n段落二\n\n- 列表\n  - 嵌套\n- [ ] 待办\n\n> 引用\n\n```mermaid\ngraph LR\n  A --> B\n```\n\n| x | y |\n| --- | --- |\n| 1 | 2 |\n\n---\n\n结束\n' },
  { name: '缩进段落（引用续行）', src: '> 引用\n\n  缩进段落\n' },
]

/** 执行往返自测，返回失败明细 */
export function runRoundTripSelfTest(cases: SelfTestCase[] = ROUND_TRIP_CASES): SelfTestResult[] {
  return cases.map((c) => {
    let actual = ''
    try {
      actual = serializeMarkdown(parseMarkdown(c.src))
    } catch (e) {
      actual = `[抛异常] ${String(e)}`
    }
    return { name: c.name, ok: actual === c.src, expected: c.src, actual }
  })
}

/** 文档速览：`type|indentLevel>文本`（换行显示为 \n，便于断言） */
function outline(doc: ParsedDoc): string {
  return doc.blocks
    .map((b) => `${b.type}|${b.indentLevel}>${b.lines.join('\\n')}`)
    .join(' ; ')
}

interface CommandCase {
  name: string
  src: string
  run: (doc: ParsedDoc) => string
  expect: string
}

/** 命令层用例（光标位置用 `index:offset` 表达） */
export const COMMAND_CASES: CommandCase[] = [
  {
    name: '回车拆列表项',
    src: '- abc',
    run: (d) => { const c = enterBlocks(d, 0, 3); return `${c.index}:${c.offset} ` + outline(d) },
    expect: '1:2 bullet|0>- a ; bullet|0>- bc',
  },
  {
    name: '空列表项回车退出列表',
    src: '- ',
    run: (d) => { const c = enterBlocks(d, 0, 2); return `${c.index}:${c.offset} ` + outline(d) },
    expect: '0:0 paragraph|0>',
  },
  {
    name: '嵌套空列表项回车先降级',
    src: '- a\n  - ',
    run: (d) => { const c = enterBlocks(d, 1, 2); return `${c.index}:${c.offset} ` + outline(d) },
    expect: '1:2 bullet|0>- a ; bullet|0>- ',
  },
  {
    name: '回车保持引用类型',
    src: '> abc',
    run: (d) => { const c = enterBlocks(d, 0, 3); return `${c.index}:${c.offset} ` + outline(d) },
    expect: '1:2 quote|0>> a ; quote|0>> bc',
  },
  {
    name: '有序列表回车编号递增',
    src: '1. a',
    run: (d) => { const c = enterBlocks(d, 0, 4); return `${c.index}:${c.offset} ` + outline(d) },
    expect: '1:3 ordered|0>1. a ; ordered|0>2. ',
  },
  {
    name: '标题回车后转段落',
    src: '# abc',
    run: (d) => { const c = enterBlocks(d, 0, 3); return `${c.index}:${c.offset} ` + outline(d) },
    expect: '1:0 heading|0># a ; paragraph|0>bc',
  },
  {
    name: '退格合并两个段落',
    src: 'aaa\n\nbbb',
    run: (d) => { const c = mergeBackward(d, 1)!; return `${c.index}:${c.offset} ` + outline(d) },
    expect: '0:3 paragraph|0>aaabbb',
  },
  {
    name: '退格把嵌套列表降级',
    src: '- a\n  - b',
    run: (d) => { const c = mergeBackward(d, 1)!; return `${c.index}:${c.offset} ` + outline(d) },
    expect: '1:0 bullet|0>- a ; bullet|0>- b',
  },
  {
    name: '首块退格无操作',
    src: '- abc',
    run: (d) => { const c = mergeBackward(d, 0); return `${c} ` + outline(d) },
    expect: 'null bullet|0>- abc',
  },
  {
    name: '退格把列表项降为段落（不跨类型拼接内容）',
    src: 'aaa\n\n- b',
    run: (d) => { const c = mergeBackward(d, 1)!; return `${c.index}:${c.offset} ` + outline(d) },
    expect: '1:0 paragraph|0>aaa ; paragraph|0>b',
  },
  {
    name: '块尾 Delete 合并下一块（段落后接段落）',
    src: 'aaa\n\nbbb\n\nccc\n',
    run: (d) => { const c = mergeForward(d, 0)!; return `${c.index}:${c.offset} ${outline(d)} :: ${serializeMarkdown(d)}` },
    expect: '0:3 paragraph|0>aaabbb ; paragraph|0>ccc :: aaabbb\n\nccc\n',
  },
  {
    name: '块尾 Delete：两段之间的空行随合并消失（不多留空行）',
    src: 'aaa\n\nbbb\n',
    run: (d) => { mergeForward(d, 0); return serializeMarkdown(d) },
    expect: 'aaabbb\n',
  },
  {
    name: '块尾 Delete 删掉下一块分割线',
    src: 'aaa\n\n---\n\nbbb\n',
    run: (d) => { const c = mergeForward(d, 0)!; return `${c.index}:${c.offset} ${outline(d)} :: ${serializeMarkdown(d)}` },
    expect: '0:3 paragraph|0>aaa ; paragraph|0>bbb :: aaa\n\nbbb\n',
  },
  {
    name: '块尾 Delete：标题保持类型、只并正文',
    src: '# h\n\nb\n',
    run: (d) => { const c = mergeForward(d, 0)!; return `${c.index}:${c.offset} ${outline(d)}` },
    expect: '0:3 heading|0># hb',
  },
  {
    name: '块尾 Delete 不合并代码块',
    src: 'aaa\n\n```js\nx\n```\n',
    run: (d) => `${mergeForward(d, 0)} ${outline(d)}`,
    expect: 'null paragraph|0>aaa ; code|0>```js\\nx\\n```',
  },
  {
    name: '缩进连同子树一起缩进',
    src: '- a\n- b\n  - c\n    - d',
    run: (d) => { indentSubtree(d, 1, 1); return outline(d) },
    expect: 'bullet|0>- a ; bullet|1>- b ; bullet|2>- c ; bullet|3>- d',
  },
  {
    name: '缩进越级被拒绝',
    src: '- a\n- b\n- c',
    run: (d) => `${indentSubtree(d, 2, 2)} ` + outline(d),
    expect: 'false bullet|0>- a ; bullet|0>- b ; bullet|0>- c',
  },
  {
    name: '整块移动到末尾（含子树）',
    src: '- a\n  - b\n- c',
    run: (d) => { moveBlocks(d, 0, 3); return outline(d) },
    expect: 'bullet|0>- c ; bullet|0>- a ; bullet|1>- b',
  },
  {
    name: '块上移一位',
    src: '- a\n- b',
    run: (d) => { const c = nudgeBlock(d, 1, -1); return `${c.index} ` + outline(d) },
    expect: '0 bullet|0>- b ; bullet|0>- a',
  },
  {
    name: '勾选待办',
    src: '- [ ] a',
    run: (d) => { toggleTodo(d, 0); return outline(d) },
    expect: 'todo|0>- [x] a',
  },
  {
    name: '段落转代码块',
    src: 'abc',
    run: (d) => { setBlockType(d, 0, 'code', { lang: 'js' }); return outline(d) },
    expect: 'code|0>```js\\nabc\\n```',
  },
  {
    name: '列表转二级标题',
    src: '- abc',
    run: (d) => { setBlockType(d, 0, 'heading', { level: 2 }); return outline(d) },
    expect: 'heading|0>## abc',
  },
  {
    name: '类型转换后再往返仍无 diff',
    src: '- abc\n- def',
    run: (d) => {
      setBlockType(d, 1, 'code', { lang: 'ts' })
      const once = serializeMarkdown(d)
      return serializeMarkdown(parseMarkdown(once)) === once ? 'stable' : once
    },
    expect: 'stable',
  },
]

/** 执行命令层自测 */
export function runCommandSelfTest(
  cases: CommandCase[] = COMMAND_CASES
): Array<{ name: string; ok: boolean; expected: string; actual: string }> {
  return cases.map((c) => {
    const doc = parseMarkdown(c.src)
    let actual = ''
    try {
      actual = c.run(doc)
    } catch (e) {
      actual = `[抛异常] ${String(e)}`
    }
    return { name: c.name, ok: actual === c.expect, expected: c.expect, actual }
  })
}

/** 公式块用例：内容提取（不能把围栏算进去）与单行写法 */
export function runMathBlockSelfTest(): Array<{
  name: string
  ok: boolean
  expected: string
  actual: string
}> {
  const cases: Array<{ name: string; run: () => string; expect: string }> = [
    {
      name: '多行公式块内容不含围栏',
      run: () => contentText(parseMarkdown('$$\nE=mc^2\n$$').blocks[0]),
      expect: 'E=mc^2',
    },
    {
      name: '单行公式块被识别为 math',
      run: () => parseMarkdown('$$E=mc^2$$').blocks.map((b) => b.type).join(','),
      expect: 'math',
    },
    {
      name: '单行公式块内容',
      run: () => contentText(parseMarkdown('$$E=mc^2$$').blocks[0]),
      expect: 'E=mc^2',
    },
    {
      name: '未闭合公式块不丢内容',
      run: () => contentText(parseMarkdown('$$\nE=mc^2').blocks[0]),
      expect: 'E=mc^2',
    },
    {
      name: '行内公式仍是段落',
      run: () => parseMarkdown('文字 $$x$$ 文字').blocks.map((b) => b.type).join(','),
      expect: 'paragraph',
    },
    {
      name: '公式块未编辑时逐字节往返',
      run: () => serializeMarkdown(parseMarkdown('$$E=mc^2$$')),
      expect: '$$E=mc^2$$',
    },
  ]

  return cases.map((c) => {
    let actual = ''
    try {
      actual = c.run()
    } catch (e) {
      actual = `[抛异常] ${String(e)}`
    }
    return { name: c.name, ok: actual === c.expect, expected: c.expect, actual }
  })
}

/**
 * 公式段落用例：`\[…\]` / 裸 `\begin{env}…\end{env}` 这类「整块只有一条展示公式的段落」
 * 要按公式块对待（可用 Monaco 编辑、写回保留原定界符），普通段落不能误判。
 */
export function runFormulaBlockSelfTest(): Array<{
  name: string
  ok: boolean
  expected: string
  actual: string
}> {
  const cases: Array<{ name: string; run: () => string; expect: string }> = [
    {
      name: '\\[…\\] 段落识别为公式块',
      run: () => String(isFormulaBlock(parseMarkdown('\\[\nx=1\n\\]').blocks[0])),
      expect: 'true',
    },
    {
      name: '\\[…\\]。 尾随标点不算进正文',
      run: () => formulaEditText(parseMarkdown('\\[\nx=1\n\\]。').blocks[0]) ?? '(null)',
      expect: 'x=1',
    },
    {
      name: '裸 cases 环境识别为公式块',
      run: () => formulaEditText(parseMarkdown('\\begin{cases}\n1, & x>0\\\\\n0, & \\text{否则}\n\\end{cases}').blocks[0]) ?? '(null)',
      expect: '\\begin{cases}\n1, & x>0\\\\\n0, & \\text{否则}\n\\end{cases}',
    },
    {
      name: '写回保留 \\[…\\] 与尾随标点',
      run: () => {
        const doc = parseMarkdown('\\[\nx=1\n\\]。')
        setFormulaText(doc.blocks[0], 'x=2')
        return serializeMarkdown(doc)
      },
      expect: '\\[\nx=2\n\\]。',
    },
    {
      name: '单行 \\[…\\] 写回仍单行',
      run: () => {
        const doc = parseMarkdown('\\[x=1\\]')
        setFormulaText(doc.blocks[0], 'x=2')
        return serializeMarkdown(doc)
      },
      expect: '\\[x=2\\]',
    },
    {
      name: '裸 cases 写回保留尾随标点',
      run: () => {
        const doc = parseMarkdown('\\begin{cases}\nx>0\n\\end{cases}，')
        // 裸环境的「正文」就是整个环境（编辑器里也能看到 \begin/\end），写回按原样落盘
        setFormulaText(doc.blocks[0], '\\begin{cases}\nx<0\n\\end{cases}')
        return serializeMarkdown(doc)
      },
      expect: '\\begin{cases}\nx<0\n\\end{cases}，',
    },
    {
      name: '渲染源码含尾随标点（与浏览视图一致）',
      run: () => formulaSource(parseMarkdown('\\[\nx=1\n\\]。').blocks[0]) ?? '(null)',
      expect: 'x=1。',
    },
    {
      name: '句中行内公式仍是普通段落',
      run: () => String(isFormulaBlock(parseMarkdown('文字 \\[x=1\\] 文字').blocks[0])),
      expect: 'false',
    },
    {
      name: '$$ 公式块仍走原链路',
      run: () => formulaEditText(parseMarkdown('$$\nE=mc^2\n$$').blocks[0]) ?? '(null)',
      expect: 'E=mc^2',
    },
    {
      name: '文献标号 \\[7\\] 段落不算公式',
      run: () => String(isFormulaBlock(parseMarkdown('\\[7\\] WANG Y, et al. 标题[J].')?.blocks?.[0])),
      expect: 'false',
    },
    {
      name: '独占一行的 \\[7\\] 也不算公式',
      run: () => String(isFormulaBlock(parseMarkdown('\\[7\\]').blocks[0])),
      expect: 'false',
    },
    {
      name: '多行 \\[7\\] 仍按公式处理',
      run: () => String(isFormulaBlock(parseMarkdown('\\[\n7\n\\]').blocks[0])),
      expect: 'true',
    },
    {
      name: '公式段落未编辑时逐字节往返',
      run: () => serializeMarkdown(parseMarkdown('\\[\nx=1\n\\]。')),
      expect: '\\[\nx=1\n\\]。',
    },
  ]

  return cases.map((c) => {
    let actual = ''
    try {
      actual = c.run()
    } catch (e) {
      actual = `[抛异常] ${String(e)}`
    }
    return { name: c.name, ok: actual === c.expect, expected: c.expect, actual }
  })
}

/** 在控制台输出简洁结果，返回是否全部通过 */
export function logRoundTripSelfTest(): boolean {
  const results = runRoundTripSelfTest()
  const structs = runStructureSelfTest()
  const cmds = runCommandSelfTest()
  const tables = runTableSelfTest()
  const maths = runMathBlockSelfTest()
  const formulas = runFormulaBlockSelfTest()
  const failed = results.filter((r) => !r.ok)
  const failedStruct = structs.filter((r) => !r.ok)
  const failedCmd = cmds.filter((r) => !r.ok)
  const failedTable = tables.filter((r) => !r.ok)
  const failedMath = maths.filter((r) => !r.ok)
  const failedFormula = formulas.filter((r) => !r.ok)

  if (failed.length === 0) {
    console.log(`[blockeditor] 往返自测通过：${results.length}/${results.length}`)
  } else {
    console.error(`[blockeditor] 往返自测失败：${failed.length}/${results.length}`)
    for (const f of failed) {
      console.error(`  用例：${f.name}\n  期望：${JSON.stringify(f.expected)}\n  实际：${JSON.stringify(f.actual)}`)
    }
  }

  if (failedStruct.length === 0) {
    console.log(`[blockeditor] 结构自测通过：${structs.length}/${structs.length}`)
  } else {
    console.error(`[blockeditor] 结构自测失败：${failedStruct.length}/${structs.length}`)
    for (const f of failedStruct) {
      console.error(`  用例：${f.name}\n  期望：${JSON.stringify(f.expected)}\n  实际：${JSON.stringify(f.actual)}`)
    }
  }

  if (failedCmd.length === 0) {
    console.log(`[blockeditor] 命令自测通过：${cmds.length}/${cmds.length}`)
  } else {
    console.error(`[blockeditor] 命令自测失败：${failedCmd.length}/${cmds.length}`)
    for (const f of failedCmd) {
      console.error(`  用例：${f.name}\n  期望：${JSON.stringify(f.expected)}\n  实际：${JSON.stringify(f.actual)}`)
    }
  }

  if (failedTable.length === 0) {
    console.log(`[blockeditor] 表格自测通过：${tables.length}/${tables.length}`)
  } else {
    console.error(`[blockeditor] 表格自测失败：${failedTable.length}/${tables.length}`)
    for (const f of failedTable) {
      console.error(`  用例：${f.name}\n  期望：${JSON.stringify(f.expected)}\n  实际：${JSON.stringify(f.actual)}`)
    }
  }

  if (failedMath.length === 0) {
    console.log(`[blockeditor] 公式块自测通过：${maths.length}/${maths.length}`)
  } else {
    console.error(`[blockeditor] 公式块自测失败：${failedMath.length}/${maths.length}`)
    for (const f of failedMath) {
      console.error(`  用例：${f.name}\n  期望：${JSON.stringify(f.expected)}\n  实际：${JSON.stringify(f.actual)}`)
    }
  }

  if (failedFormula.length === 0) {
    console.log(`[blockeditor] 公式段落自测通过：${formulas.length}/${formulas.length}`)
  } else {
    console.error(`[blockeditor] 公式段落自测失败：${failedFormula.length}/${formulas.length}`)
    for (const f of failedFormula) {
      console.error(`  用例：${f.name}\n  期望：${JSON.stringify(f.expected)}\n  实际：${JSON.stringify(f.actual)}`)
    }
  }

  return (
    failed.length === 0 &&
    failedStruct.length === 0 &&
    failedCmd.length === 0 &&
    failedTable.length === 0 &&
    failedMath.length === 0 &&
    failedFormula.length === 0
  )
}
