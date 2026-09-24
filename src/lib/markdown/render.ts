/**
 * markdown.ts — Markdown / 代码高亮 / Mermaid 源码渲染工具层
 *
 * 从 home.vue 抽出（纯函数，无组件状态依赖）：
 * - 配置好的 markdown-it 实例（mathjax + mermaid fence + 代码高亮）；
 * - renderMarkdown：LaTeX 预处理 → 裸 <code> 提升 → 渲染 → 还原 <pre>；
 * - 代码高亮、Mermaid 源码规范化辅助。
 *
 * 使用：home.vue 直接 import { renderMarkdown, highlightCodeHtml, ... }。
 */

import MarkdownIt from 'markdown-it'
import markdownItMathjax from 'markdown-it-mathjax3'
import hljs from 'highlight.js'
import { hashContent } from '@/lib/markdown/mermaid'
import { allowLocalFileLinks } from '@/lib/markdown/mdLinkPolicy'

// ---------------------------------------------------------------------------
// markdown-it 实例（fence 规则：mermaid 代码块 → 渲染占位，由 renderMermaidDiagrams 处理）
// ---------------------------------------------------------------------------

export const md: MarkdownIt = new MarkdownIt({
  html: true,
  linkify: true,
  highlight: function (str: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return (
          '<pre class="hljs"><code>' +
          hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
          '</code></pre>'
        )
      } catch (__) {}
    }
    return '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + '</code></pre>'
  },
}).use(markdownItMathjax)

// 放开 file: 链接（Word 预览图片以 file:/// 引用缓存文件，默认策略会拒绝导致图片变成文本）
allowLocalFileLinks(md)

const defaultFence =
  md.renderer.rules.fence || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))

md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const info = token.info ? token.info.trim() : ''
  const langName = info ? info.split(/\s+/g)[0] : ''

  if (langName === 'mermaid') {
    const content = token.content.trim()
    const h = hashContent(content)
    const escaped = md.utils.escapeHtml(content)
    return `<div class="mermaid-wrapper" data-mermaid-hash="${h}"><div class="mermaid-src" style="display:none">${escaped}</div></div>`
  }

  return defaultFence(tokens, idx, options, env, self)
}

// ---------------------------------------------------------------------------
// LaTeX 预处理
// ---------------------------------------------------------------------------

/**
 * 判断 [0, index) 区间内是否已经处在 $...$ / $$...$$ 定界符之中。
 * 用于「裸环境包装」跳过已被公式定界符包含的内容（否则会把 $$ 里的 cases/aligned 拆成两段）。
 */
function insideMathDelim(text: string, index: number): boolean {
  const before = text.slice(0, index)
  if ((before.match(/\$\$/g) || []).length % 2 === 1) return true
  return (before.replace(/\$\$/g, '').match(/\$/g) || []).length % 2 === 1
}

/**
 * 预处理 LaTeX：统一转换为 markdown-it-mathjax3 能识别的格式。
 * 先保护代码块与 <pre> 内的内容（其中的 $ 不应被处理）。
 */
export const preprocessMath = (str: string): string => {
  if (!str) return str

  const blocks: string[] = []
  let result = str.replace(/```[\s\S]*?```/g, (m) => {
    blocks.push(m)
    return `\x00BLOCK${blocks.length - 1}\x00`
  })

  // 保护 HTML <pre>...</pre>（工具代码/结果框等原生预格式化文本）：
  // 原生展示，不做任何数学/markdown 处理，避免 run_python 等代码中的 $ _ \ 等被误解析
  result = result.replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, (m) => {
    blocks.push(m)
    return `\x00BLOCK${blocks.length - 1}\x00`
  })

  // 1. \[...\] → $$...$$（块级公式）/ $...$（行内出现时降级）
  //    ⚠️ 必须用回调返回字面量：replace 的**替换字符串**里 `$$` 是「一个字面 $」的转义，
  //    写成 '$$\n$1\n$$' 实际产出的是单个 $…$ → 块级公式被降级成行内公式
  //    （表现为「等号前那段没渲染」、公式不居中、$$ 内容被后续步骤拆坏）
  //    ⚠️ 紧跟的收尾标点（`\]。`、`\],` 这种 LaTeX 里很常见的写法）要一起吃掉并放进公式末尾：
  //    块级公式的闭合 $$ 必须独占一行，否则 markdown-it 会一路找到下一个 $$ 才闭合，
  //    把中间的正文/下一个公式整段吞进这一条公式里（实测会渲染出多余的 $ 。 和下一式的内容）
  result = result.replace(
    /\\\[([\s\S]*?)\\\]([^\S\n]*[。，、；：？！）】》」』”’…,.;:!?)]*)/g,
    (m: string, inner: string, tail: string, offset: number, full: string) => {
      const body = String(inner).trim()
      const after = String(tail || '')
      // LaTeX 转义的方括号（如参考文献标号 `\[7\]`、`\[1-3\]`）：内容只有数字与分隔符且不换行时
      // 一律保持字面量，交给 markdown-it 的反斜杠转义渲染成 `[7]`；
      // 否则会被当成展示公式，导致「标号 + 文献条目」被拆成两段（浏览/块编辑视图表现为两行）
      if (!/[\r\n]/.test(inner) && /^[\d\s,;、\-–—]+$/.test(body)) return m
      // 开定界符在行首（前面只有缩进）→ 记作块级公式；句中出现的 \[..\] 无法断开段落，
      // 保守按行内公式处理（否则行中间插入 $$ 会把整段切成几块、露出字面 $$）
      const atLineStart = /(^|\n)[ \t]*$/.test(full.slice(0, offset))
      return atLineStart ? `\n$$\n${body}${after}\n$$\n` : '$' + body + '$' + after
    },
  )

  // 2. \(...\) → $...$ （行内公式，去掉首尾空格避免被插件拒绝）
  result = result.replace(/\\\(([\s\S]*?)\\\)/g, (_, inner) => {
    return '$' + inner.trim() + '$'
  })

  // 3. 裸 LaTeX 环境 \begin{env}...\end{env} → $$...$$
  //    markdown-it-mathjax3 只认 $ / $$ 定界符，不写双美元的环境默认不会渲染
  //    已在 $…$ / $$…$$ 内的**不再包裹**：否则 `$$ x=1 \begin{cases}…\end{cases} $$` 会被
  //    从中间拆成两段公式（cases 那段还会漏成纯文本）
  result = result.replace(
    /\\begin\{([a-zA-Z*]+)\}[\s\S]*?\\end\{\1\}/g,
    (m: string, _env: string, offset: number) => (insideMathDelim(result, offset) ? m : `\n$$\n${m}\n$$\n`),
  )

  // 4. 处理所有 $...$（含已由步骤 2 产生的）：
  //    - 去掉内容首尾空格
  //    - 跳过不含 LaTeX 特征的（如 "$ 100"）
  //    - 用 \x00M/\x00 标记已识别的数学公式（供下一步使用）
  result = result.replace(/(?<!\$)\$([\s\S]*?)\$(?!\$)/g, (raw, inner) => {
    const trimmed = inner.trim()
    if (!trimmed) return raw
    if (!/[\\_{}^]/.test(trimmed)) return raw
    return '\x00MATH\x00' + trimmed + '\x00/MATH\x00'
  })

  // 5. 在已标记数学公式的结束符后紧跟数字时，插入零宽空格 \u200B
  result = result.replace(/\x00\/MATH\x00(?=\d)/g, '\x00/MATH\x00\u200B')

  // 6. 恢复 $ 符号标记
  result = result.replace(/\x00MATH\x00/g, '$').replace(/\x00\/MATH\x00/g, '$')

  // 恢复代码块
  result = result.replace(/\x00BLOCK(\d+)\x00/g, (_, idx) => blocks[+idx])
  return result
}

// ---------------------------------------------------------------------------
// 代码高亮 / 裸 code 提升
// ---------------------------------------------------------------------------

/** 高亮代码（highlight.js）并包装为 <pre class="hljs"><code>…</code></pre> */
export const highlightCodeHtml = (code: string, lang: string = '', extraClass: string = ''): string => {
  const cls = 'hljs' + (extraClass ? ' ' + extraClass : '')
  const langName = (lang || '').toLowerCase()
  try {
    if (langName && hljs.getLanguage(langName)) {
      return (
        `<pre class="${cls}"><code>` +
        hljs.highlight(code, { language: langName, ignoreIllegals: true }).value +
        '</code></pre>'
      )
    }
  } catch (__) {}
  return `<pre class="${cls}"><code>` + md.utils.escapeHtml(code) + '</code></pre>'
}

/**
 * 将裸 <code>...</code>（模型有时直接输出 <code> 标签包裹的多行代码）提升为
 * <pre class="hljs"> 并高亮，避免 markdown-it 把代码内容当 markdown 渲染
 * （# 变标题、* 变强调等）；已有 <pre>/``` 的块不受影响。
 */
export const wrapBareCodeBlocks = (str: string): string => {
  if (!str) return str
  const blocks: string[] = []
  // 1. 先保护 ```fence 与已有 <pre>...</pre>（工具代码/结果框、fence 高亮块等），内部不再处理
  let result = str.replace(/```[\s\S]*?```/g, (m) => {
    blocks.push(m)
    return `\x00CODEBLK${blocks.length - 1}\x00`
  })
  result = result.replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, (m) => {
    blocks.push(m)
    return `\x00CODEBLK${blocks.length - 1}\x00`
  })
  // 2. 处理裸 <code>...</code>（含换行的多行代码块）→ <pre class="hljs"> 包裹并高亮
  result = result.replace(/<code\b[^>]*>[\s\S]*?<\/code>/gi, (m) => {
    if (!/\n/.test(m)) return m // 单行 inline code 保持原样
    const openMatch = /^<code\b[^>]*>/i.exec(m)
    const open = openMatch ? openMatch[0] : '<code>'
    const lang = (/class=["'][^"']*language-([\w+#.-]+)["']/i.exec(open)?.[1] || '').trim()
    const inner = m.slice(open.length, -'</code>'.length)
    return highlightCodeHtml(inner, lang)
  })
  // 3. 恢复已保护的 <pre> 块
  return result.replace(/\x00CODEBLK(\d+)\x00/g, (_, idx) => blocks[+idx])
}

// ---------------------------------------------------------------------------
// 渲染入口
// ---------------------------------------------------------------------------

/**
 * 渲染 markdown 到 HTML。
 * 保护已高亮的 <pre>...</pre>（工具代码/结果框等原生预格式化 HTML）：
 * markdown-it 的块级 HTML 规则会在「空行」处中断 <div> 包裹的内容，导致
 * <div class="tool-box"> 内部含空行的高亮代码被当作 markdown 重新解析。
 * 因此先把 <pre> 整体用 HTML 注释占位，等 md.render 完成后再原样恢复。
 */
export const renderMarkdown = (str: string): string => {
  if (!str) return str
  const preBlocks: string[] = []
  const guarded = str.replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, (m) => {
    preBlocks.push(m)
    return `<!--PRE${preBlocks.length - 1}-->`
  })
  const rendered = md.render(preprocessMath(wrapBareCodeBlocks(guarded)))
  return rendered.replace(/<!--PRE(\d+)-->/g, (_, idx) => preBlocks[+idx] ?? '')
}

/** HTML 转义（配合 dangerouslyUseHTMLString 拼接安全文本时使用） */
export const escapeHtml = (str: string): string => {
  return String(str ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
  )[c])
}

/**
 * 渲染 Agent 提问（ElMessageBox 弹窗等紧凑场景）：
 * 复用 renderMarkdown，但把 mermaid 占位块还原为源码代码块——
 * 弹窗内不会执行 mermaid 渲染，否则会出现空白占位框。
 */
export const renderQuestionMarkdown = (str: string): string => {
  const html = renderMarkdown(str || '')
  return html.replace(
    /<div class="mermaid-wrapper"[^>]*>\s*<div class="mermaid-src"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi,
    (_m, escaped) => `<pre class="hljs"><code>${escaped ?? ''}</code></pre>`,
  )
}

// ---------------------------------------------------------------------------
// Mermaid 源码规范化（渲染前的清洗）
// 实现已归口到 ./mermaid-normalize（唯一一份，勿在此重复），此处仅转发导出以兼容既有调用方
// ---------------------------------------------------------------------------
export { sanitizeMermaidIdentifier, normalizeClassDiagramSource, normalizeMermaidSource } from '@/lib/markdown/mermaid-normalize'
