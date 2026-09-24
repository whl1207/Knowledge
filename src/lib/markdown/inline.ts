/**
 * markdown/inline.ts — 块编辑器的「行内 Markdown」渲染
 *
 * 单独抽出成模块的原因：
 *  - 块编辑器里标题 / 列表 / 引用 / 待办的正文只需要行内结果（不要 <p>/<ul> 包裹）
 *  - 但行内渲染同样必须先做 LaTeX 预处理，否则 `$ E = mc^2 $`、`\(...\)`、`\[...\]`
 *    这类写法会原样输出（浏览视图因为走 renderMarkdown 反而是正常的）
 */

import { md, preprocessMath, renderMarkdown } from './render'

/**
 * 把块级公式定界符降级为行内（行内位置没有独立的 $$ 块）。
 * - 多行块（preprocessMath 把 \[...\] / 裸环境包成的独占行 $$）→ 合成单行行内公式；
 * - 单行块 $$x$$ → $x$。
 * ⚠️ 替换串里别写 `$$`（replace 会把它当成一个字面 $ 的转义），一律用回调拼字面量。
 */
function degradeDisplayMath(text: string): string {
  const merged = text.replace(
    /(^|\n)[ \t]*\$\$[ \t]*\n([\s\S]*?)\n[ \t]*\$\$[ \t]*(?=\n|$)/g,
    (_m, pre: string, body: string) => pre + '$' + String(body).replace(/\n/g, ' ').trim() + '$',
  )
  return merged.replace(/\$\$([^$]+)\$\$/g, (_m, body: string) => '$' + body + '$')
}

/**
 * 渲染一段行内 Markdown，换行渲染为 `<br>`。
 * 与浏览视图一致：先 preprocessMath，再做行内渲染。
 */
export function renderInlineMarkdown(text: string): string {
  if (!text) return ''
  const pre = degradeDisplayMath(preprocessMath(text))
  return pre
    .split('\n')
    .map((line) => md.renderInline(line))
    .join('<br>')
}

/**
 * 临时把 `softbreak` 规则改成 `<br>`（等价于 markdown-it 的 breaks: true）后渲染。
 * 不用 md.set({ breaks: true })：那是全局实例配置，会连带改变浏览视图等所有渲染；
 * md.render 是同步的，所以这里临时挂上 / 摘下规则是安全的（不会与其它渲染交错）。
 */
function renderWithSoftBreaks(src: string): string {
  const prev = md.renderer.rules.softbreak
  md.renderer.rules.softbreak = () => '<br>\n'
  try {
    return renderMarkdown(src)
  } finally {
    if (prev) md.renderer.rules.softbreak = prev
    else delete md.renderer.rules.softbreak
  }
}

/**
 * 渲染一个「段落块」：走完整块级链路（含 preprocessMath、$$ 块级公式、\begin{env} 环境），
 * 若结果只是一个 <p> 则拆掉外包裹，避免块内多出一层间距。
 *
 * 段落内的**软换行**（单个 \n）按硬换行渲染成 `<br>`：一个块里可能有多行文字
 * （Shift+Enter、粘贴多行、或存盘后被解析成同一个多行段落块），而标准 Markdown 会把软换行
 * 显示成空格 → 渲染态看着只有一行，点进去 textarea 里却有换行，两边对不上。
 * 标题 / 列表 / 引用 / 待办本来就走 renderInlineMarkdown（换行转 <br>），段落保持一致。
 */
export function renderParagraphMarkdown(text: string): string {
  if (!text) return ''
  const html = renderWithSoftBreaks(text)
  const m = /^<p>([\s\S]*?)<\/p>\s*$/.exec(html.trim())
  return m ? m[1] : html
}
