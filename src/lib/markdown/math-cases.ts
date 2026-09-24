/**
 * markdown/math-cases.ts — 公式渲染自测
 *
 * 用途：列举各种 LaTeX 书写形式，分别走「浏览视图链路」（renderMarkdown，含 preprocessMath）
 * 与「块编辑器行内链路」（md.renderInline，无预处理），对比哪些形式渲染不出来。
 *
 * 运行方式见 /memories/repo/blockeditor-core.md（esbuild 打包 + node）。
 */

import { renderMarkdown, preprocessMath } from './render'
import { renderInlineMarkdown, renderParagraphMarkdown } from './inline'

export interface MathCase {
  name: string
  src: string
}

export const MATH_CASES: MathCase[] = [
  { name: '行内 $..$', src: '能量 $E=mc^2$ 前后文' },
  { name: '行内 $..$ 带空格', src: '能量 $ E = mc^2 $ 前后文' },
  { name: '行内 \\(..\\)', src: '能量 \\(E=mc^2\\) 前后文' },
  { name: '行内 \\[..\\]', src: '能量 \\[E=mc^2\\] 前后文' },
  { name: '行内 下标/上标', src: '公式 $x_{1}^{2}$ 结束' },
  { name: '行内 分数', src: '分数 $\\frac{a}{b}$ 结束' },
  { name: '行内 希腊字母', src: '参数 $\\alpha + \\beta$ 结束' },
  { name: '行内 反斜杠命令无特征符', src: '集合 $\\emptyset$ 结束' },
  { name: '行内 纯数字美元（不应渲染）', src: '价格 $ 100 美元' },
  { name: '块级 $$ 独占行', src: '$$\nE = mc^2\n$$' },
  { name: '块级 $$ 单行', src: '$$E = mc^2$$' },
  { name: '块级 \\[..\\] 独占行', src: '\\[\nE = mc^2\n\\]' },
  { name: '块级 equation 环境', src: '\\begin{equation}\na = b\n\\end{equation}' },
  { name: '块级 aligned 环境', src: '\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}' },
  { name: '块级 bmatrix', src: '\\begin{bmatrix}\n1 & 2 \\\\\n3 & 4\n\\end{bmatrix}' },
  { name: '块级 积分', src: '$$\n\\int_0^1 x \\, dx\n$$' },
  { name: '段中多行（行内公式）', src: '第一行 $a+b$ 文字\n第二行 $c+d$ 文字' },
]

/** 是否真的产出了数学容器（MathJax CHTML / SVG 或 MathML） */
export function hasMathContainer(html: string): boolean {
  return /mjx-container|MathJax|<math[\s>]/.test(html)
}

export interface MathTestResult {
  name: string
  ok: boolean
  html: string
}

/** 浏览视图链路：renderMarkdown（含 preprocessMath） */
export function runMathSelfTest(cases: MathCase[] = MATH_CASES): MathTestResult[] {
  return cases.map((c) => {
    const html = renderMarkdown(c.src)
    return { name: c.name, ok: hasMathContainer(html), html }
  })
}

/** 块编辑器「行内」链路（标题/列表/引用/待办） */
export function runInlineEditorSelfTest(cases: MathCase[] = MATH_CASES): MathTestResult[] {
  return cases.map((c) => {
    const html = renderInlineMarkdown(c.src)
    return { name: c.name, ok: hasMathContainer(html), html }
  })
}

/** 块编辑器「段落块」链路 */
export function runParagraphEditorSelfTest(cases: MathCase[] = MATH_CASES): MathTestResult[] {
  return cases.map((c) => {
    const html = renderParagraphMarkdown(c.src)
    return { name: c.name, ok: hasMathContainer(html), html }
  })
}

/**
 * preprocessMath 预处理结果自测：逐条比对「预处理后的文本」。
 * 与 hasMathContainer 类的用例互补：这里关心的是「该不该被当成公式」，而不是「能不能渲染出公式」。
 */
export function runMathPreprocessSelfTest(): Array<{ name: string; ok: boolean; expected: string; actual: string }> {
  const cases: Array<{ name: string; src: string; expect: string }> = [
    // 参考文献标号是 LaTeX 转义的方括号（markdown-it 反斜杠转义后就是字面 [7]），不能动
    {
      name: '文献标号 \\[7\\] 保持字面',
      src: '\\[7\\] WANG Y, ASSOGBA K, FAN J X, et al. Multi-depot green VRP[J]. JCP, 2019, 232: 12-29.',
      expect: '\\[7\\] WANG Y, ASSOGBA K, FAN J X, et al. Multi-depot green VRP[J]. JCP, 2019, 232: 12-29.',
    },
    { name: '文献标号区间 \\[1-3\\] 保持字面', src: '\\[1-3\\] 作者.', expect: '\\[1-3\\] 作者.' },
    { name: '句中 \\[7\\] 也不转公式', src: '见文献 \\[7\\] 所述', expect: '见文献 \\[7\\] 所述' },
    { name: '单行 \\[E=mc^2\\] → 块级公式', src: '\\[E=mc^2\\]', expect: '\n$$\nE=mc^2\n$$\n' },
    { name: '多行 \\[7\\] \n独占行）仍按公式', src: '\\[\n7\n\\]', expect: '\n$$\n7\n$$\n' },
    { name: '句中 \\[E=mc^2\\] → 行内公式', src: '公式 \\[E=mc^2\\] 结束', expect: '公式 $E=mc^2$ 结束' },
  ]
  return cases.map((c) => {
    let actual = ''
    try {
      actual = preprocessMath(c.src)
    } catch (e) {
      actual = `[抛异常] ${String(e)}`
    }
    return { name: c.name, ok: actual === c.expect, expected: c.expect, actual }
  })
}
