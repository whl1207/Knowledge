/**
 * htmlToMarkdown.selftest.ts — HTML→Markdown 正文转换自测（纯计算，不联网、不依赖 Vue / Electron）
 *
 * 重点覆盖的风险：
 *  1. **链接必须保留**：这是本次改造的目的 —— 旧实现剥标签后 `<a href>` 的 URL 全丢，
 *     模型无法顺着页面里的链接继续抓；
 *  2. **相对地址必须绝对化**：ai-km 的 web_fetch 只接受 http(s) 绝对地址，`/domains`
 *     原样交给模型等于给了一个必然失败的下一次调用；
 *  3. **死链不能进正文**：`javascript:` / `data:` / 纯 `#` 锚点降级为纯文字，否则模型
 *     会照着调用、或让超长 data URI 撑爆上下文；
 *  4. **不可见内容必须整块丢弃**：script/style/noscript/hidden/display:none 的文字
 *     一旦漏进正文，模型会把 JS 源码当页面内容读；
 *  5. **超深嵌套不能卡住主进程**：turndown 对超深 DOM 是超线性的，必须退回纯文本；
 *  6. 表格转 GFM 管道表格（turndown 默认没有表格规则），否则整张表压成一行行文字。
 *
 * 用法（开发期）：
 *   import { runHtmlToMarkdownSelfTest } from '@/shared/htmlToMarkdown.selftest'
 *   console.table(runHtmlToMarkdownSelfTest())
 * 或命令行：`node scripts/run-selftests.mjs htmlToMarkdown`
 */

import { htmlToMarkdown } from './htmlToMarkdown'

export interface HtmlToMarkdownCase {
  name: string
  ok: boolean
  detail?: string
}

export function runHtmlToMarkdownSelfTest(): HtmlToMarkdownCase[] {
  const cases: HtmlToMarkdownCase[] = []
  const add = (name: string, ok: boolean, detail = '') => cases.push({ name, ok, detail })

  // ---------- 1. 链接 ----------
  {
    const md = htmlToMarkdown('<p><a href="https://example.com/docs">文档</a></p>', { baseUrl: 'https://example.com/' })
    add('链接：绝对地址保留为 Markdown 链接', md === '[文档](https://example.com/docs)', md)
  }
  {
    const md = htmlToMarkdown('<p><a href="/domains">域名</a></p>', { baseUrl: 'https://www.iana.org/help/example-domains' })
    add('链接：相对地址按 baseUrl 绝对化',
      md === '[域名](https://www.iana.org/domains)', md)
  }
  {
    const md = htmlToMarkdown('<a href="docs/a.html">a</a>', { baseUrl: 'https://example.com/x/y/' })
    add('链接：相对路径按文档目录解析', md === '[a](https://example.com/x/y/docs/a.html)', md)
  }
  {
    const md = htmlToMarkdown('<p><a href="#">回顶部</a> 与 <a href="javascript:void(0)">点我</a></p>', { baseUrl: 'https://e.com/' })
    add('链接：纯锚点 / javascript: 降级为纯文字', md === '回顶部 与 点我', md)
  }
  {
    const md = htmlToMarkdown('<a href="https://e.com/x"><img src="/i.png" alt="图标"></a>', { baseUrl: 'https://e.com/' })
    add('链接：图标链接（无文字）只留地址', md.includes('https://e.com/x'), md)
  }
  {
    const md = htmlToMarkdown('<p><a href="https://e.com/a">多行\n  链接文字</a></p>')
    add('链接：文字里的换行被压平（否则 Markdown 结构会断）', md === '[多行 链接文字](https://e.com/a)', md)
  }
  {
    const md = htmlToMarkdown('<p>没有链接的段落</p>')
    add('链接：没有链接时不留空括号', !md.includes(']()'), md)
  }

  // ---------- 2. 图片 ----------
  {
    const md = htmlToMarkdown('<img src="/static/logo.svg" alt="首页">', { baseUrl: 'https://www.iana.org/help/example-domains' })
    add('图片：相对 src 绝对化并保留 alt', md === '![首页](https://www.iana.org/static/logo.svg)', md)
  }
  {
    const md = htmlToMarkdown('<img src="data:image/png;base64,AAAA" alt="x">')
    add('图片：data: URI 丢弃（避免超长内联数据进上下文）', md === '', md)
  }

  // ---------- 3. 不可见 / 活动内容 ----------
  {
    const md = htmlToMarkdown(
      '<div><script>alert(1)</script><style>.a{color:red}</style><noscript>no js</noscript>'
      + '<p>正文</p><p hidden>藏起来</p><p style="display: none">也不显示</p>'
      + '<p aria-hidden="true">读屏跳过</p><iframe src="https://e.com"></iframe></div>',
    )
    add('清理：script/style/noscript/iframe 与 hidden / display:none / aria-hidden 全部丢弃',
      md === '正文', JSON.stringify(md))
  }

  // ---------- 4. 结构 ----------
  {
    const md = htmlToMarkdown('<h2>标题</h2><ul><li>一</li><li>二</li></ul><pre><code>const a = 1</code></pre>')
    add('结构：标题 atx / 列表 - / 代码块 fenced',
      md.includes('## 标题') && md.includes('-   一') || (md.includes('## 标题') && md.includes('- 一')),
      JSON.stringify(md))
    add('结构：代码块保留内容', md.includes('const a = 1'), JSON.stringify(md))
  }

  // ---------- 5. 表格 ----------
  {
    const md = htmlToMarkdown(
      '<table><thead><tr><th>名</th><th align="right">值</th></tr></thead>'
      + '<tbody><tr><td>a</td><td>1</td></tr></tbody></table>',
    )
    add('表格：输出 GFM 管道表格 + 对齐分隔行',
      md.includes('| 名') && md.includes('| 值') && /\|\s*:?-{3,}/.test(md) && md.includes('| a'),
      JSON.stringify(md))
    add('表格：表头与表体之间不留空行（否则 GFM 会切成两张表）',
      !md.includes('|\n\n|'), JSON.stringify(md))
  }

  // ---------- 6. 基地址 ----------
  {
    const md = htmlToMarkdown('<base href="https://cdn.example.com/v2/"><a href="x">x</a>', { baseUrl: 'https://example.com/p' })
    add('基地址：页面里的 <base href> 优先于传入的 baseUrl', md === '[x](https://cdn.example.com/v2/x)', md)
  }

  // ---------- 7. 安全网 ----------
  {
    const deep = '<div>'.repeat(800) + '内容' + '</div>'.repeat(800)
    let out = ''
    let threw = false
    try {
      out = htmlToMarkdown(deep)
    } catch {
      threw = true
    }
    add('安全网：超深嵌套回退纯文本且不抛错（不把原始 HTML 交给模型）',
      !threw && out.includes('内容') && !out.includes('<div>'), out.slice(0, 60))
  }
  {
    const md = htmlToMarkdown('<p>a &amp; b&nbsp;c</p>')
    add('实体：&amp; / &nbsp; 正常解码', md.includes('a & b') && md.includes('c'), md)
  }
  {
    add('空输入：返回空串', htmlToMarkdown('') === '' && htmlToMarkdown('   ') === '')
  }

  return cases
}

/** 命令行入口（node scripts/run-selftests.mjs htmlToMarkdown 时走这个） */
export function logHtmlToMarkdownSelfTest(): boolean {
  const cases = runHtmlToMarkdownSelfTest()
  console.table(cases.map((c) => ({ case: c.name, result: c.ok ? 'PASS' : 'FAIL', detail: c.detail || '' })))
  const bad = cases.filter((c) => !c.ok)
  if (bad.length) console.error(`[htmlToMarkdown] ${bad.length} 个断言失败`)
  return bad.length === 0
}
