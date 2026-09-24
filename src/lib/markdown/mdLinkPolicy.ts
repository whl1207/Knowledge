/**
 * markdown-it 链接协议策略（本地文件图片渲染必需）
 *
 * markdown-it 默认的 `validateLink` 会**直接拒绝 `file:` 链接**
 * （BAD_PROTO_RE = /^(vbscript|javascript|file|data):/），于是
 * `![alt](file:///C:/…/docx-media/xxx/image1.png)` 不会生成 img token，
 * 预览里就会原样显示这串 Markdown 文本（Word 图片"显示不出来"的根因）。
 *
 * 本应用是本地桌面软件（渲染进程 webSecurity: false，图片走 file:/// 引用缓存文件），
 * 因此这里放开 `file:`；同时保持安全底线：
 *  - `javascript:` / `vbscript:` 仍然拒绝；
 *  - `data:` 仅允许图片类型（与 markdown-it 原策略一致）。
 *
 * 注意：md_read 预览、导出 Word/PDF、聊天渲染等所有可能处理 Word 转换结果的
 * markdown-it 实例都应调用一次。
 */
export function allowLocalFileLinks(md: { validateLink: (url: string) => boolean }): void {
  md.validateLink = (url: string) => {
    const s = String(url || '').trim().toLowerCase()
    if (/^(javascript|vbscript):/.test(s)) return false
    if (/^data:/.test(s)) return /^data:image\/(gif|png|jpeg|webp)/.test(s)
    return true
  }
}

/** 需要保持原样的协议 / 绝对路径（不参与「相对路径 → 本地绝对路径」解析） */
const EXTERNAL_HREF_RE = /^(https?:|data:|file:\/\/|\/|[A-Za-z]:|mailto:|tel:|#)/i

export interface MdLinkRewrite {
  /** anchor = 页内锚点；file = 本地文件；none = 保持原样（外链等） */
  kind: 'anchor' | 'file' | 'none'
  /** 重写后写入 href 的值 */
  href: string
  /** kind === 'file' 时的绝对路径 */
  path?: string
  /** kind === 'anchor' 时的锚点 id（不含 #） */
  anchor?: string
}

/**
 * 把 Markdown 链接 href 分类：页内锚点 / 本地文件 / 保持原样。
 *
 * 关键点：`#_Toc123456`（Word 目录项、交叉引用指向 Word 内部书签）必须识别为**页内锚点**。
 * 旧实现只判断「不以协议开头就是相对路径」，于是 `#_Toc123456` 被拼成
 * `D:/dir/#_Toc123456` 当文件打开，子窗口报 `Error reading file: ENOENT`。
 * 同理 `other.md#section` 这类跨文档链接要把 `#fragment` 摘掉再解析文件路径。
 */
export function rewriteMdLinkHref(href: string, mdBasePath = ''): MdLinkRewrite {
  const raw = String(href || '')
  if (!raw) return { kind: 'none', href: raw }
  if (/^#/.test(raw)) {
    return { kind: 'anchor', href: raw, anchor: raw.slice(1) }
  }
  if (EXTERNAL_HREF_RE.test(raw)) return { kind: 'none', href: raw }

  const hashIdx = raw.indexOf('#')
  const rawPath = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw
  const fragment = hashIdx >= 0 ? raw.slice(hashIdx + 1) : ''
  // 形如 `#foo` 已在上面处理；这里兜底 `?#foo` 之类的纯片段
  if (!rawPath) return { kind: 'anchor', href: raw, anchor: fragment }

  const normalizedHref = rawPath.replace(/\\/g, '/')
  let resolvedPath = ''
  if (mdBasePath) {
    resolvedPath = (mdBasePath + normalizedHref).replace(/\\/g, '/')
    // 解析 ./ 与 ../（如 ../../images/a.png）
    const parts = resolvedPath.split('/')
    const result: string[] = []
    for (const part of parts) {
      if (part === '.' || part === '') continue
      if (part === '..') { result.pop(); continue }
      result.push(part)
    }
    resolvedPath = result.join('/')
  }
  const finalPath = resolvedPath || normalizedHref
  return { kind: 'file', href: finalPath, path: finalPath }
}

/**
 * 归一化标题 / 目录项文字，用于页内锚点回退定位。
 *
 * Word 目录项在 Markdown 里形如 `[1.1 研究背景与意义 1](#_Toc234912279)`：
 * 文本尾部带页码（有时还会带 `…… 12` 点导引）、头部带自动编号；
 * 而正文标题是 `## 1.1 研究背景与意义`。两侧都按本函数归一化后才能对上。
 */
export function normalizeAnchorText(s: string): string {
  return String(s ?? '')
    .replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, '$1') // markdown 转义（如 2\. → 2.）
    .replace(/[\t\u00a0\u3000]+/g, ' ')
    .replace(/\s*[.·…]{2,}\s*\d+\s*$/, '')            // 点导引 + 页码「…… 12」
    .replace(/\s+\d+\s*$/, '')                        // 尾部页码（「1.1 研究背景与意义 1」）
    .replace(/^\s*\d+(?:\.\d+)*\s*[.、:：]?\s*/, '')   // 前导编号（「1.1 」）
    .replace(/^[（(]\s*\d+\s*[）)]\s*/, '')             // 前导「（1）」
    .replace(/\s+/g, '')
    .toLowerCase()
}

/** markdown-it 实例的最小形状（避免引入 markdown-it 类型依赖） */
type MdLike = {
  renderer: {
    rules: Record<string, any>
    renderToken: (tokens: any[], idx: number, options: any) => string
  }
}

/**
 * 给 markdown-it 实例安装链接渲染规则：
 *  - `#锚点` → `class="md-anchor-link"` + `data-anchor`（点击时页内跳转，不会当文件打开）
 *  - 相对路径 → `class="md-file-link"` + `data-path`（点击时打开本地文件）
 *
 * md_read 与其它渲染 md/Word 内容的预览组件应统一调用本函数。
 * @param getBasePath 返回当前文件所在目录（以 `/` 结尾，可为空字符串）
 */
export function applyMdLinkRule(md: MdLike, getBasePath: () => string): void {
  // 注意：markdown-it 渲染规则的第 5 个参数 self 是 **Renderer 实例**（不是 md 实例），
  // 所以这里的兜底实现直接用闭包里的 md.renderer.renderToken。
  const defaultRender =
    md.renderer.rules.link_open ||
    ((tokens: any[], idx: number, options: any) => md.renderer.renderToken(tokens, idx, options))
  md.renderer.rules.link_open = (tokens: any[], idx: number, options: any, env: any) => {
    const token = tokens[idx]
    const hrefIndex = token.attrIndex('href')
    if (hrefIndex >= 0 && token.attrs) {
      const rw = rewriteMdLinkHref(token.attrs[hrefIndex][1], getBasePath())
      if (rw.kind === 'anchor') {
        // 页内锚点（含 Word 目录页码链接）：保留原 href，仅打标记供点击拦截
        token.attrPush(['class', 'md-anchor-link'])
        token.attrPush(['data-anchor', rw.anchor || ''])
      } else if (rw.kind === 'file') {
        token.attrs[hrefIndex][1] = rw.href
        token.attrPush(['class', 'md-file-link'])
        token.attrPush(['data-path', rw.path || rw.href])
      }
    }
    return defaultRender(tokens, idx, options)
  }
}
