/**
 * 两端对齐排版（T2 方案）对外入口
 *
 * 用法：
 *   typesetRoot(el)                       // 对 el 内的段落做两端对齐（可重复调用，内部先还原）
 *   revertTypeset(el)                     // 还原成原始 DOM
 *   scheduleTypeset(el, opts, 60)         // 防抖版（窗口 / 面板宽度变化时用）
 *   const off = installTypesetCopyFix(el) // 复制时去掉逐行包裹带来的假换行
 *
 * 只在「只读态」使用（浏览视图、块编辑器渲染态）；编辑态（textarea）不做，
 * 因为 textarea 的断行由浏览器引擎决定，JS 无法接管。
 */
export { typesetRoot, revertTypeset, isTypeset, DEFAULT_SELECTOR, type TypesetOptions } from './dom'
export { breakLines, greedy, type TsItem, type TsLine, type BreakOptions, type BreakResult } from './break'

import { typesetRoot, type TypesetOptions } from './dom'

const timers = new WeakMap<object, ReturnType<typeof setTimeout>>()

/** 防抖排版（同一 root 上重复调用只保留最后一次） */
export function scheduleTypeset(root: ParentNode | null, opts: TypesetOptions = {}, delay = 60): void {
  if (!root) return
  const prev = timers.get(root)
  if (prev) clearTimeout(prev)
  const t = setTimeout(() => {
    timers.delete(root)
    typesetRoot(root, opts)
  }, delay)
  timers.set(root, t)
}

/** 逐行包裹是块级元素，直接复制会被浏览器插入换行 → 复制时改写纯文本 */
export function installTypesetCopyFix(root: HTMLElement): () => void {
  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return
    const ae = document.activeElement as HTMLElement | null
    // textarea / input 里的选区走浏览器原生复制
    if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
    const anchor = sel.anchorNode
    if (!anchor || !root.contains(anchor)) return
    let holder: HTMLElement
    try {
      holder = document.createElement('div')
      holder.appendChild(sel.getRangeAt(0).cloneContents())
    } catch {
      return
    }
    const lines = holder.querySelectorAll('.ts-line')
    if (!lines.length) return // 选区里没有排版行 → 保持浏览器默认行为

    // 1) 拆掉逐行包裹（否则 display:block 会被序列化成换行）
    lines.forEach((line) => {
      const parent = line.parentNode
      if (!parent) return
      while (line.firstChild) parent.insertBefore(line.firstChild, line)
      parent.removeChild(line)
    })
    // 2) 去掉「块与块之间」的纯空白文本节点。
    //    这些是模板/缩进留下的换行，叠上第 3 步补的 \n 会变成多个换行符
    //    （复制两段文字粘出来中间空一行，就是这个原因）。pre/code 里的原样保留。
    //    注意 holder 自身的直接子节点也要清（跨块选区的块就挂在 holder 下，中间夹着缩进换行）。
    ;[holder, ...Array.from(holder.querySelectorAll('*'))].forEach((el) => {
      if (el.closest('pre, code, textarea')) return
      Array.from(el.childNodes).forEach((node) => {
        const text = node.nodeType === Node.TEXT_NODE ? node.nodeValue || '' : ''
        if (text && /\n/.test(text) && !text.trim()) node.parentNode?.removeChild(node)
      })
    })
    // 3) 只给「最内层、且有文字」的块级元素补一个换行，保证跨段落复制仍有分段。
    //    没有文字的要跳过：编辑器外壳（.be-gutter 的加号/手柄等）也在 BLOCK 里，
    //    给它补换行会在每段前面多出一个空行。
    const BLOCK = 'p,li,blockquote,div,h1,h2,h3,h4,h5,h6,tr,pre,figure'
    holder.querySelectorAll(BLOCK).forEach((b) => {
      if (b.querySelector(BLOCK)) return
      if (!(b.textContent || '').trim()) return
      b.after(document.createTextNode('\n'))
    })
    const text = (holder.textContent || '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      // 末尾换行是「分段标记」而不是内容：留着的话粘贴时会凭空多出一个空行
      .replace(/\n+$/, '')
    e.clipboardData.setData('text/plain', text)
    e.preventDefault()
  }
  root.addEventListener('copy', onCopy)
  return () => root.removeEventListener('copy', onCopy)
}
