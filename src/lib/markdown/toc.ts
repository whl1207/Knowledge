/**
 * markdown/toc.ts — 目录（TOC）共用数据层
 *
 * 三个视图共用同一套目录数据与结构：
 *  - 浏览视图 `md_read.vue`（自己从渲染后的标题树算出 tocFlat，结构与此完全一致）
 *  - 源码编辑 `Edit_Code.vue`（从 Markdown 源码提取标题行）
 *  - 块编辑 `BlockEditor.vue`（从 heading 块提取）
 * 展示统一由 `components/knowFile/view/DocTocPanel.vue` 负责（样式完全按浏览视图做）。
 */

/** 目录项（扁平行；含画层级竖线 / 连接符所需的层级信息） */
export interface TocFlatItem {
  /** 稳定 id（点击跳转与高亮都按它比较） */
  id: number
  text: string
  /** 可选锚点（浏览视图给真实锚点，其它视图可不传） */
  href?: string
  anchor?: string
  /** 缩进深度（0 = 顶层），渲染时 paddingLeft = depth × 18 */
  depth: number
  /** 是否为同级最后一个（决定连接符画竖线还是只画肘） */
  isLast: boolean
  /** 祖先各自是否为同级最后一个（true → 该层竖线留空） */
  parentLasts: boolean[]
}

/** 标题原始信息（按文档顺序） */
export interface TocHeadingLike {
  level: number
  text: string
}

// ---------------------------------------------------------------------------
// 目录面板宽度：所有视图（浏览 / 源码编辑 / 块编辑 / PDF）共用一个 key，
// 保证「初始宽度一致」；在任一视图拖过之后，其它视图打开也是同一个宽度。
// ---------------------------------------------------------------------------

/** 共用的 localStorage key（各视图不再各存一份，否则初始宽度参差不齐） */
export const DOC_TOC_WIDTH_KEY = 'doc-toc-width'
/** 统一初始宽度（px） */
export const DOC_TOC_DEFAULT_WIDTH = 300
export const DOC_TOC_MIN_WIDTH = 180
export const DOC_TOC_MAX_WIDTH = 560

/** 读取目录面板宽度（带了兜底与限幅，localStorage 不可用时返回默认值） */
export function loadDocTocWidth(): number {
  try {
    const n = Number(localStorage.getItem(DOC_TOC_WIDTH_KEY))
    if (Number.isFinite(n) && n > 0) {
      return Math.max(DOC_TOC_MIN_WIDTH, Math.min(DOC_TOC_MAX_WIDTH, Math.round(n)))
    }
  } catch { /* 隐私模式等场景忽略 */ }
  return DOC_TOC_DEFAULT_WIDTH
}

/** 写入目录面板宽度（面板拖动结束由宿主持久化） */
export function saveDocTocWidth(w: number): void {
  if (!Number.isFinite(w)) return
  try { localStorage.setItem(DOC_TOC_WIDTH_KEY, String(Math.round(w))) } catch { /* 忽略 */ }
}

/**
 * 目录「是否展开」也共用一份：在任一视图打开目录后，切到其它视图（重新挂载时）也会打开。
 * 只记录用户显式操开合（状态栏按钮 / 面板关闭按钮），视图内部因互斥（标签、搜索）
 * 而临时收起不写回，避免把别的视图也关掉。
 */
export const DOC_TOC_OPEN_KEY = 'doc-toc-open'

/** 读取共享的展开状态（默认收起） */
export function loadDocTocOpen(): boolean {
  try { return localStorage.getItem(DOC_TOC_OPEN_KEY) === '1' } catch { return false }
}

/** 写入共享的展开状态 */
export function saveDocTocOpen(open: boolean): void {
  try { localStorage.setItem(DOC_TOC_OPEN_KEY, open ? '1' : '0') } catch { /* 忽略 */ }
}

/**
 * 标题级别序列 → 扁平目录项。
 * 深度用「级别栈」推导（支持跳级：h1 直接接 h3 时 h3 深度为 1）；
 * isLast 取「同级里后面还有没有同层项」；
 * parentLasts 取祖先的 isLast（长度 = depth-1：去掉最外层，直接父级竖线由连接符画，
 * 与 md_read / PdfViewer 的约定完全一致，保证三视图层级线一致）。
 */
export function flattenHeadingLevels(list: TocHeadingLike[]): TocFlatItem[] {
  return flattenTocTree(headingsToTree(list))
}

/**
 * 目录树节点（PDF 书签 / 标题树等天然就是树结构）。
 * 只要求「文字 + 子节点」，其余业务字段（页码 / 链接 / 锚点）由宿主自己带着走。
 */
export interface TocTreeNodeLike {
  text: string
  children?: TocTreeNodeLike[]
}

/**
 * 目录树 → 扁平目录项：**层级线规则的唯一实现**（depth / isLast / parentLasts）。
 *
 * 各视图的目录都是同一套层级线，之前 md_read / PdfViewer 各手写一份「树 → 扁平」的
 * walk（parentLasts 的 slice(1) 约定极易写错），这里收敛成一份，谁都别再手写。
 *
 * - id 按**前序遍历**序号 +1 生成（= 文档顺序，可与正文标题序号 / 书签下标对位），
 *   宿主按 id 找回业务对象（页码、锚点、行号…）；
 * - 需要额外字段时用 map 回调塞进目录项（返回 { text?, href?, anchor? }），
 *   或用 host 自己的 Map<id, node> 在映射后补。
 */
export function flattenTocTree<T extends TocTreeNodeLike>(
  nodes: T[],
  map?: (node: T, id: number) => { text?: string; href?: string; anchor?: string } | void
): TocFlatItem[] {
  const out: TocFlatItem[] = []
  let seq = 0
  const walk = (list: T[], depth: number, parentLasts: boolean[]) => {
    const total = list.length
    for (let i = 0; i < total; i++) {
      const node = list[i]
      const isLast = i === total - 1
      const id = ++seq
      const extra = map?.(node, id) || {}
      out.push({
        id,
        text: extra.text ?? node.text ?? '',
        href: extra.href,
        anchor: extra.anchor,
        depth,
        isLast,
        // 与 flattenHeadingLevels 同一个约定：去掉最外层标志（顶层没有竖线），
        // 直接父级的竖线由本行连接符绘制
        parentLasts: parentLasts.slice(1),
      })
      const children = (node.children || []) as T[]
      if (children.length > 0) walk(children, depth + 1, [...parentLasts, isLast])
    }
  }
  walk(nodes, 0, [])
  return out
}

/** 标题级别序列 → 标题树（用级别栈推导父子关系，支持跳级） */
function headingsToTree(list: TocHeadingLike[]): Array<TocTreeNodeLike & { children: TocTreeNodeLike[] }> {
  const roots: Array<TocTreeNodeLike & { children: TocTreeNodeLike[] }> = []
  const stack: Array<{ level: number; node: TocTreeNodeLike & { children: TocTreeNodeLike[] } }> = []
  for (const h of list) {
    const level = Math.min(6, Math.max(1, h.level))
    const node = { text: h.text, children: [] as TocTreeNodeLike[] }
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
    if (stack.length === 0) roots.push(node)
    else stack[stack.length - 1].node.children.push(node)
    stack.push({ level, node })
  }
  return roots
}


/** 去掉行内标记，只留纯文本当目录标题 */
export function plainHeadingText(body: string): string {
  return (body || '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .trim()
}

/**
 * 从 Markdown 源码提取标题（源码编辑视图用）。
 * 跳过 YAML frontmatter 与围栏代码块内部；返回行号（1 基）。
 */
export function extractMarkdownHeadings(md: string): Array<TocHeadingLike & { line: number }> {
  const out: Array<TocHeadingLike & { line: number }> = []
  const lines = (md || '').replace(/\r\n?/g, '\n').split('\n')
  let inFence = false
  let fenceChar = ''
  let inFrontmatter = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // YAML frontmatter：只认文件开头的 --- 开头块
    if (!inFence && i === 0 && line.trim() === '---') { inFrontmatter = true; continue }
    if (inFrontmatter) {
      if (line.trim() === '---') inFrontmatter = false
      continue
    }
    const fence = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence) {
      const ch = fence[1][0]
      if (!inFence) { inFence = true; fenceChar = ch } else if (ch === fenceChar) { inFence = false }
      continue
    }
    if (inFence) continue
    const m = /^(#{1,6})[ \t]+(.*)$/.exec(line)
    if (m) out.push({ level: m[1].length, text: plainHeadingText(m[2]), line: i + 1 })
  }
  return out
}
