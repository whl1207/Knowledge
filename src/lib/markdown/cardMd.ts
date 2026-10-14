/**
 * cardMd.ts — 切片卡片（block_md）专用 markdown 渲染器
 *
 * 为什么单独一个模块：
 * 原实现把 `new MarkdownIt({...}).use(mathjax3).use(mark)` 写在 block_md.vue 的 `<script setup>` 里，
 * 也就是**每个卡片组件实例各建一个 markdown-it 实例**。切片页一次要渲染 40+ 张卡片，
 * 而 mathjax3 插件每个实例都会自己创建一份 MathJax 文档/字体度量 → 切一次切片页就要建几十份，
 * 每次进出切片页都重跑一遍，这是切片页明显卡顿的主要原因。
 *
 * 现在：全应用共用 1 个实例（懒加载到首次使用），并按「内容 → HTML」缓存渲染结果，
 * 同一批切片反复进出页面时直接命中缓存，不再重复做 markdown/公式解析。
 *
 * 与 @/lib/markdown/render 里公共 `md` 的区别：这里额外启用了 markdown-it-mark（`==高亮==`），
 * 以保持切片卡片原有的渲染行为不变（不去改动公共实例，避免影响其它视图的渲染结果）。
 */
import MarkdownIt from 'markdown-it'
import mathjax3 from 'markdown-it-mathjax3'
import mark from 'markdown-it-mark'
import hljs from 'highlight.js'
import { hashContent } from '@/lib/markdown/mermaid'

/** 共享的 markdown-it 实例（切片卡片用；含 mathjax 公式与 mermaid 占位） */
export const cardMd: MarkdownIt = new MarkdownIt({
  html: true,
  linkify: true,
  highlight: function (str: any, lang: any) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return '<pre class="hljs scoll"><code>' +
          hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
          '</code></pre>'
      } catch (__) { /* 高亮失败则退回转义输出 */ }
    }
    return '<pre class="hljs"><code>' + cardMd.utils.escapeHtml(str) + '</code></pre>'
  },
}).use(mathjax3)
  .use(mark)

// mermaid 代码块 → 渲染占位（真实 SVG 由宿主的 renderMermaidDiagrams 填充，与公共渲染器同一套占位结构）
const defaultFence = cardMd.renderer.rules.fence || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))
cardMd.renderer.rules.fence = (tokens: any, idx: number, options: any, env: any, self: any) => {
  const token = tokens[idx]
  const info = token.info ? token.info.trim() : ''
  const langName = info ? info.split(/\s+/g)[0] : ''

  if (langName === 'mermaid') {
    const content = token.content.trim()
    const h = hashContent(content)
    const escaped = cardMd.utils.escapeHtml(content)
    return `<div class="mermaid-wrapper" data-mermaid-hash="${h}"><div class="mermaid-src" style="display:none">${escaped}</div></div>`
  }

  return defaultFence(tokens, idx, options, env, self)
}

/**
 * 渲染结果缓存（内容 → HTML）：FIFO 淘汰 + 双重上限，避免长时间浏览大库时内存无限增长。
 * - 条目数上限 300；
 * - 单条内容超过 2 万字符（超大切片）不缓存，宁可每次渲染也不让缓存被单条巨物占满。
 * 内容变化（重新切片）时 key 变化，不会拿到旧 HTML。
 */
const CACHE_MAX_ENTRIES = 300
const CACHE_MAX_CONTENT = 20000
const htmlCache = new Map<string, string>()

/** 渲染 markdown 为 HTML（带内容级缓存）；空内容返回空串，与调用方原行为一致 */
export const renderCardHtml = (content: string): string => {
  const key = content ?? ''
  if (!key) return ''
  const hit = htmlCache.get(key)
  if (hit !== undefined) return hit
  const html = cardMd.render(key)
  if (key.length <= CACHE_MAX_CONTENT) {
    if (htmlCache.size >= CACHE_MAX_ENTRIES) {
      const oldest = htmlCache.keys().next().value
      if (oldest !== undefined) htmlCache.delete(oldest)
    }
    htmlCache.set(key, html)
  }
  return html
}

/** 清空渲染缓存（重新切片/换库后可选调用；不清也只是多占少量内存） */
export const clearCardHtmlCache = () => { htmlCache.clear() }
