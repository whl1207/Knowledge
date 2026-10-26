/**
 * sanitizeHtml.ts — 统一的 HTML 消毒入口（Markdown / 模型输出 / 工具输出）
 *
 * 为什么需要：markdown-it 的 `html: true` 会原样放行 `<img onerror=...>`、`<script>` 等；
 * 文件窗口一旦同时开 nodeIntegration / contextIsolation:false，打开一个恶意 .md 就等于
 * 执行任意 Node 代码。DOMPurify 作为最后一道内容级防线，和窗口隔离 / CSP / IPC 校验叠加。
 *
 * 注意：
 * - 只在浏览器环境真正消毒（SSR / Node 自测没有 DOM，返回原文，避免 import 时崩）；
 * - 保留 `file:` / `data:` / `blob:` 的图片 URL（本地文件预览需要）；
 * - 只放行 md_read 自己注入的**唯一一个**安全 onerror（本地图片回退），其余事件属性一律剥掉。
 */

import DOMPurify from 'dompurify'

const SAFE_IMG_ONERROR = 'window.__mdFixLocalImg&&window.__mdFixLocalImg(this)'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let purifier: any = null

function getPurifier(): any {
  if (typeof window === 'undefined') return null
  if (purifier) return purifier
  // DOMPurify 的默认导出在不同打包形态下可能是实例，也可能是工厂函数
  purifier = typeof DOMPurify === 'function' ? DOMPurify(window as any) : DOMPurify
  purifier.addHook('uponSanitizeAttribute', (_node: any, data: any) => {
    const name = String(data?.attrName || '').toLowerCase()
    if (!name.startsWith('on')) return
    if (name === 'onerror' && data?.attrValue === SAFE_IMG_ONERROR) {
      // 这是 md_read 给本地图片挂的回退；只认这一条精确值
      data.keepAttr = true
      return
    }
    data.keepAttr = false
  })
  return purifier
}

export interface SanitizeHtmlOptions {
  /** 允许 <style>（默认 false；Markdown 正文不需要） */
  allowStyle?: boolean
}

/**
 * 消毒一段已经渲染好的 HTML。
 * 无 DOM 环境（Node 自测 / SSR）直接返回原文，调用方仍可做字符串级断言。
 */
export function sanitizeHtml(html: string, opts: SanitizeHtmlOptions = {}): string {
  if (!html) return html
  const p = getPurifier()
  if (!p) return html
  return String(p.sanitize(html, {
    // Markdown 的图片 / 本地预览链接需要这些 scheme；脚本 / javascript: 仍被 DOMPurify 拒绝
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|file|data|blob):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    ADD_ATTR: ['target', 'rel', 'download', 'data-mermaid-hash', 'data-toc-idx', 'data-lang', 'jax'],
    // MathJax 输出的是 <mjx-container> 自定义元素；不显式放行会被 DOMPurify 当成未知标签剥掉，
    // 表现为公式消失（正文其它部分正常），所以这里按标签名精确放行。
    ADD_TAGS: ['mjx-container', 'mjx-assistive-mml'],
    FORBID_TAGS: opts.allowStyle ? [] : ['style'],
    FORBID_ATTR: ['srcdoc'],
  }))
}
