/**
 * snapshot.ts — 可访问性树 → 紧凑文本 + 可引用节点（ref）
 *
 * 这是 P1 的"观测原语"：模型不再靠猜 CSS，而是读 `[ref=12]` 后直接点。实现要点：
 * - `Accessibility.getFullAXTree` 给 role/name/value/properties/backendDOMNodeId；
 * - 只给可交互节点分配 ref，纯文本节点不带 ref（省 token）；
 * - 空文本/空容器折叠，未知角色无名字时只保留子树；
 * - 默认限 8000 字符 / 120 ref，超限截断并提示；
 * - 主文档 only：Electron 单 target CDP 进不了 OOPIF（见方案 §1.4）。
 */
import type { CdpSession } from './cdp'

export interface RefEntry {
  ref: number
  backendNodeId: number
  role: string
  name: string
  value?: string
  disabled?: boolean
  loc?: string
  box?: { x: number; y: number; width: number; height: number }
  /** 跨域 iframe（OOPIF）里的元素：没有主文档 backendNodeId，用 frame 内 selector 定位 */
  frame?: { token: string; frameId: string; selector: string; offsetX: number; offsetY: number; url: string }
}

/** 一个跨域子 frame 的入口（service 从 WebFrameMain + CDP 组装） */
export interface OopifFrameSource {
  token: string
  frameId: string
  url: string
  offsetX: number
  offsetY: number
  executeJavaScript(code: string): Promise<any>
}

export interface SnapshotCapture {
  url: string
  title: string
  text: string
  refs: Map<number, RefEntry>
  truncated: boolean
  frameCount: number
}

export interface SnapshotOptions {
  maxChars?: number
  maxRefs?: number
  includeBox?: boolean
  /** 只输出可交互节点（表单/工具栏页省 token）；纯文本不输出 */
  interactiveOnly?: boolean
  /** 只抓该 backendNodeId 的子树（service 由 ref 解析得到） */
  rootBackendNodeId?: number
  /** 只保留视口内可见节点（DOMSnapshot 布局矩形） */
  viewportOnly?: boolean
  /** 跨域子 frame（OOPIF）：主文档 AX 树里没有它们的内容，用 frame 内 DOM 扫描补充 */
  oopifFrames?: OopifFrameSource[]
}

interface AxValue {
  value?: any
}

interface AxProperty {
  name?: string
  value?: AxValue
}

interface AxNode {
  nodeId: string
  ignored?: boolean
  role?: AxValue
  name?: AxValue
  value?: AxValue
  description?: AxValue
  properties?: AxProperty[]
  childIds?: string[]
  backendDOMNodeId?: number
}

const ACTIONABLE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox',
  'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'slider', 'spinbutton',
  'switch', 'tab', 'treeitem', 'menulist',
])

/** 即使没有名字也值得保留的结构角色（帮模型理解页面骨架） */
const STRUCTURAL_ROLES = new Set([
  'root', 'heading', 'list', 'listitem', 'table',
  'columnheader', 'rowheader', 'dialog', 'alertdialog', 'banner', 'main', 'navigation',
  'contentinfo', 'form', 'search', 'article', 'region', 'tabpanel', 'menu', 'menubar',
  'toolbar', 'tree', 'grid', 'group', 'separator', 'progressbar', 'iframe',
])

const SKIP_ROLES = new Set([
  'inlinetextbox', 'linebreak', 'none', 'presentation', 'generic', 'statictext',
])

export async function captureSnapshot(cdp: CdpSession, opts: SnapshotOptions = {}): Promise<SnapshotCapture> {
  const maxChars = clamp(opts.maxChars, 1000, 60_000, 8_000)
  const maxRefs = clamp(opts.maxRefs, 1, 500, 120)

  const [ax, pageInfo, frameTree] = await Promise.all([
    cdp.send<{ nodes: AxNode[] }>('Accessibility.getFullAXTree', {}, 20_000),
    cdp.send<{ result?: { value?: any } }>('Runtime.evaluate', {
      expression: '({ url: location.href, title: document.title })',
      returnByValue: true,
    }, 8_000).catch(() => null),
    cdp.send<{ frameTree?: any }>('Page.getFrameTree', {}, 8_000).catch(() => null),
  ])

  const url = String(pageInfo?.result?.value?.url || '')
  const title = String(pageInfo?.result?.value?.title || '')
  const frameCount = countFrames(frameTree?.frameTree)

  const nodes = Array.isArray(ax?.nodes) ? ax.nodes : []
  if (!nodes.length) {
    return { url, title, text: '（页面暂无可访问内容；可能仍在加载）', refs: new Map(), truncated: false, frameCount }
  }

  const byId = new Map<string, AxNode>()
  const childIds = new Set<string>()
  for (const n of nodes) {
    if (!n?.nodeId) continue
    byId.set(n.nodeId, n)
    for (const c of n.childIds || []) childIds.add(c)
  }
  const root = opts.rootBackendNodeId != null
    ? nodes.find((n) => n && n.backendDOMNodeId === opts.rootBackendNodeId)
    : (nodes.find((n) => n && !childIds.has(n.nodeId) && n.role?.value === 'RootWebArea')
      || nodes.find((n) => n && !childIds.has(n.nodeId))
      || nodes[0])
  if (!root) {
    return { url, title, text: '（找不到指定的快照根节点；请重新 browser_snapshot）', refs: new Map(), truncated: false, frameCount }
  }
  const actionableSubtree = opts.interactiveOnly ? collectActionableSubtrees(nodes) : null
  const viewport = opts.viewportOnly ? await loadViewportBounds(cdp) : null

  const ctx: RenderCtx = {
    lines: [],
    chars: 0,
    maxChars,
    maxRefs,
    refs: new Map(),
    nextRef: 1,
    truncated: false,
    totalActionable: 0,
    locCounts: countLocatorKeys(nodes),
    interactiveOnly: !!opts.interactiveOnly,
    actionableSubtree,
    viewport,
  }
  renderNode(root, 0, byId, ctx, opts.includeBox, true)
  if (frameCount > 1) {
    ctx.lines.push(`note: 页面还包含 ${frameCount - 1} 个子 frame，其内容未包含在此快照（P1 限制）`)
  }
  if (ctx.truncated) {
    ctx.lines.push(`note: 快照已截断（共 ${ctx.totalActionable} 个可交互节点，已输出 ${ctx.refs.size} 个 ref）。可滚动页面后重新快照，或调大 maxChars/maxRefs。`)
  }
  // includeBox：为已分配 ref 的节点补坐标（最多 40 个，逐个查询，失败忽略）
  if (opts.includeBox) await fillBoxes(cdp, ctx.refs)
  // 跨域 iframe：AX 树进不去，用 frame 内 DOM 扫描补交互节点（ref 带 frame 信息，动作走 frame 坐标）
  if (opts.oopifFrames?.length) await appendOopifFrames(ctx, opts.oopifFrames)

  return {
    url,
    title,
    text: ctx.lines.join('\n'),
    refs: ctx.refs,
    truncated: ctx.truncated,
    frameCount,
  }
}

interface RenderCtx {
  lines: string[]
  chars: number
  maxChars: number
  maxRefs: number
  refs: Map<number, RefEntry>
  nextRef: number
  truncated: boolean
  totalActionable: number
  /** role+name → 出现次数：只有唯一时才输出 locator（对齐 ego 的"唯一性证明"） */
  locCounts: Map<string, number>
  /** 只输出可交互节点 */
  interactiveOnly?: boolean
  /** interactiveOnly 下：节点 id → 子树内是否含可交互节点 */
  actionableSubtree?: Set<string> | null
  /** viewportOnly 下：backendNodeId → 页面坐标矩形 + 视口矩形 */
  viewport?: { bounds: Map<number, Rect>; rect: Rect } | null
}

interface Rect { x: number; y: number; w: number; h: number }

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/** 用 DOMSnapshot 的布局矩形 + 当前滚动位置，过滤视口内节点（比逐节点 getBoxModel 便宜） */
async function loadViewportBounds(cdp: CdpSession): Promise<{ bounds: Map<number, Rect>; rect: Rect } | null> {
  try {
    const [snap, vp] = await Promise.all([
      cdp.send<any>('DOMSnapshot.captureSnapshot', { computedStyles: [] }, 20_000),
      cdp.send<any>('Runtime.evaluate', {
        expression: '({x: window.scrollX, y: window.scrollY, w: window.innerWidth, h: window.innerHeight})',
        returnByValue: true,
      }, 5_000).catch(() => null),
    ])
    const v = vp?.result?.value || {}
    const rect: Rect = { x: Number(v.x) || 0, y: Number(v.y) || 0, w: Number(v.w) || 0, h: Number(v.h) || 0 }
    if (!rect.w || !rect.h) return null
    const doc = snap?.documents?.[0]
    if (!doc?.nodes || !doc?.layout) return null
    const bounds = new Map<number, Rect>()
    const layout = doc.layout
    const nodeIndex: number[] = Array.isArray(layout.nodeIndex) ? layout.nodeIndex : []
    const rects: any[] = Array.isArray(layout.bounds) ? layout.bounds : []
    for (let i = 0; i < nodeIndex.length; i++) {
      const backend = doc.nodes[nodeIndex[i]]?.backendNodeId
      const b = rects[i]
      if (typeof backend !== 'number' || !Array.isArray(b) || b.length < 4) continue
      bounds.set(backend, { x: Number(b[0]) || 0, y: Number(b[1]) || 0, w: Number(b[2]) || 0, h: Number(b[3]) || 0 })
    }
    return bounds.size ? { bounds, rect } : null
  } catch {
    return null
  }
}

function renderNode(node: AxNode | undefined, depth: number, byId: Map<string, AxNode>, ctx: RenderCtx, includeBox?: boolean, parentVisible = true): void {
  if (!node || ctx.truncated) return
  const role = normalizeRole(node.role?.value)
  const name = normalizeText(node.name?.value)

  // viewportOnly：有布局矩形的节点按视口过滤；无矩形的文本节点继承父级可见性
  let childVisible = parentVisible
  if (ctx.viewport) {
    if (typeof node.backendDOMNodeId === 'number' && role !== 'root') {
      const b = ctx.viewport.bounds.get(node.backendDOMNodeId)
      childVisible = !!b && intersects(b, ctx.viewport.rect)
      if (!childVisible) return
    } else if (typeof node.backendDOMNodeId !== 'number' && !parentVisible) {
      return
    }
  }

  // ignored 节点：不占一行，直接渲染子树（保持可访问性语义）
  if (node.ignored) {
    for (const id of node.childIds || []) renderNode(byId.get(id), depth, byId, ctx, includeBox, childVisible)
    return
  }

  const isActionable = ACTIONABLE_ROLES.has(role)
  const isStructural = STRUCTURAL_ROLES.has(role)
  const isText = role === 'statictext' || role === 'text'
  const skipLine = SKIP_ROLES.has(role) && !isText
  const hasRefCandidate = isActionable && typeof node.backendDOMNodeId === 'number'

  // interactiveOnly：只保留"自身可交互"或"子树里含可交互节点"的分支
  if (ctx.interactiveOnly && !hasRefCandidate) {
    if (ctx.actionableSubtree?.has(node.nodeId)) {
      for (const id of node.childIds || []) renderNode(byId.get(id), depth, byId, ctx, includeBox, childVisible)
    }
    return
  }

  // 文本：空文本不输出；非空输出一行 text "..."
  if (isText) {
    if (name) appendLine(ctx, `${'  '.repeat(depth)}text ${quote(name)}`, node, role, name, node.backendDOMNodeId, false, includeBox)
    return
  }

  if (skipLine) {
    for (const id of node.childIds || []) renderNode(byId.get(id), depth, byId, ctx, includeBox, childVisible)
    return
  }

  // 结构化但无名字、无可见内容 → 只保留子树（避免大量空 group 行）
  if (!name && !isStructural && !hasRefCandidate) {
    for (const id of node.childIds || []) renderNode(byId.get(id), depth, byId, ctx, includeBox, childVisible)
    return
  }

  let line = `${'  '.repeat(depth)}${role || 'group'}`
  if (name) line += ` ${quote(name)}`
  const value = valueOf(node)
  if (value) line += ` value=${quote(value)}`
  const flags = flagsOf(node)
  if (flags.length) line += ` ${flags.join(' ')}`

  let refId: number | undefined
  if (hasRefCandidate) {
    ctx.totalActionable++
    if (ctx.refs.size < ctx.maxRefs) {
      refId = ctx.nextRef++
      // 生成 role+name 的稳定 locator：只有该 role+name 在本页唯一时才输出，避免同名误定位
      const locKey = `${role}\u0000${name}`
      const unique = !!name && name.length <= 60 && (ctx.locCounts.get(locKey) || 0) === 1
      const safeLoc = unique ? `role:${role}[name=${quoteLoc(name)}]` : undefined
      ctx.refs.set(refId, {
        ref: refId,
        backendNodeId: node.backendDOMNodeId!,
        role,
        name,
        ...(value ? { value } : {}),
        ...(propsOf(node).disabled ? { disabled: true } : {}),
        ...(safeLoc ? { loc: safeLoc } : {}),
      })
      line += ` [ref=${refId}${safeLoc ? `, loc=${safeLoc}` : ''}]`
    } else {
      ctx.truncated = true
    }
  }

  if (!appendLine(ctx, line, node, role, name, node.backendDOMNodeId, isActionable, includeBox, refId)) return
  // 有名字的动作节点/标题：子节点通常只是重复的可访问名称（如 button > StaticText），跳过省 token
  const skipChildren = !!name && (isActionable || role === 'heading')
  if (skipChildren) return
  for (const id of node.childIds || []) renderNode(byId.get(id), depth + 1, byId, ctx, includeBox, childVisible)
}

async function appendOopifFrames(ctx: RenderCtx, frames: OopifFrameSource[]): Promise<void> {
  const scan = `(() => {
    const sel = 'button,a[href],input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=checkbox],[role=radio],[role=combobox],[role=tab]';
    const css = (el) => {
      if (el.id) return '#' + CSS.escape(el.id);
      const parts = [];
      let cur = el;
      while (cur && cur.nodeType === 1 && parts.length < 5) {
        let p = cur.tagName.toLowerCase();
        const parent = cur.parentElement;
        if (parent) {
          const sibs = Array.from(parent.children).filter((x) => x.tagName === cur.tagName);
          if (sibs.length > 1) p += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
        }
        parts.unshift(p);
        cur = cur.parentElement;
      }
      return parts.join(' > ');
    };
    const roleOf = (el) => {
      const r = (el.getAttribute('role') || '').toLowerCase();
      if (r) return r;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return 'combobox';
      if (tag === 'input') {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'submit' || t === 'button') return 'button';
        return 'textbox';
      }
      return 'group';
    };
    return Array.from(document.querySelectorAll(sel)).slice(0, 60).map((el) => {
      const r = el.getBoundingClientRect();
      const tag = el.tagName.toLowerCase();
      const name = String(el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().slice(0, 100);
      return { role: roleOf(el), name, selector: css(el), x: r.x, y: r.y, w: r.width, h: r.height, disabled: !!el.disabled, tag };
    });
  })()`

  let frameNo = 0
  for (const frame of frames.slice(0, 8)) {
    if (ctx.truncated) break
    let rows: any[] = []
    try { rows = await frame.executeJavaScript(scan) } catch { continue }
    if (!Array.isArray(rows) || !rows.length) continue
    frameNo++
    const header = `iframe "${frame.url || 'cross-origin frame'}" (可交互内容)`
    if (!pushRaw(ctx, header)) break
    for (const row of rows) {
      if (ctx.truncated || ctx.refs.size >= ctx.maxRefs) { ctx.truncated = true; break }
      if (!row || !(row.w > 0) || !(row.h > 0)) continue
      const role = String(row.role || 'group')
      const name = String(row.name || '')
      const refId = ctx.nextRef++
      ctx.refs.set(refId, {
        ref: refId,
        backendNodeId: 0,
        role,
        name,
        ...(row.disabled ? { disabled: true } : {}),
        frame: {
          token: frame.token,
          frameId: frame.frameId,
          selector: String(row.selector || ''),
          offsetX: frame.offsetX,
          offsetY: frame.offsetY,
          url: frame.url,
        },
      })
      const line = `  ${role}${name ? ` ${quote(name)}` : ''} [ref=${refId}]`
      if (!pushRaw(ctx, line)) break
    }
  }
  if (frameNo) ctx.lines.push(`note: 跨域 iframe 的内容来自 frame 内 DOM 扫描（坐标偏移在快照时计算）`)
}

function pushRaw(ctx: RenderCtx, line: string): boolean {
  if (ctx.chars + line.length + 1 > ctx.maxChars) {
    ctx.truncated = true
    return false
  }
  ctx.lines.push(line)
  ctx.chars += line.length + 1
  return true
}

function appendLine(  ctx: RenderCtx,
  line: string,
  _node: AxNode,
  _role: string,
  _name: string,
  _backendNodeId: number | undefined,
  _actionable: boolean,
  _includeBox?: boolean,
  _refId?: number,
): boolean {
  if (ctx.chars + line.length + 1 > ctx.maxChars) {
    ctx.truncated = true
    return false
  }
  ctx.lines.push(line)
  ctx.chars += line.length + 1
  return true
}

function normalizeRole(v: any): string {
  const role = String(v || '').toLowerCase()
  return role === 'rootwebarea' ? 'root' : role
}

function normalizeText(v: any): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim()
}

function valueOf(node: AxNode): string {
  const props = propsOf(node)
  // 密码框不输出值（即使浏览器给的是掩码也避免任何泄露）
  if (props.protected) return ''
  const raw = node.value?.value
  if (raw === undefined || raw === null) return ''
  const v = String(raw).replace(/\s+/g, ' ').trim()
  if (!v) return ''
  return v.length > 120 ? `${v.slice(0, 120)}…` : v
}

interface AxProps {
  disabled: boolean
  checked: boolean | 'mixed'
  expanded?: boolean
  selected?: boolean
  readonly?: boolean
  protected?: boolean
}

function propsOf(node: AxNode): AxProps {
  const out: AxProps = { disabled: false, checked: false }
  for (const p of node.properties || []) {
    const name = String(p?.name || '')
    const v = p?.value?.value
    if (name === 'disabled') out.disabled = v === true || v === 'true'
    else if (name === 'checked') out.checked = v === 'mixed' ? 'mixed' : v === true || v === 'true'
    else if (name === 'expanded') out.expanded = v === true || v === 'true'
    else if (name === 'selected') out.selected = v === true || v === 'true'
    else if (name === 'readonly') out.readonly = v === true || v === 'true'
    else if (name === 'protected') out.protected = v === true || v === 'true'
  }
  return out
}

function flagsOf(node: AxNode): string[] {
  const p = propsOf(node)
  const out: string[] = []
  if (p.disabled) out.push('disabled')
  if (p.checked === 'mixed') out.push('checked=mixed')
  else if (p.checked) out.push('checked')
  if (p.expanded === true) out.push('expanded')
  else if (p.expanded === false) out.push('collapsed')
  if (p.selected) out.push('selected')
  if (p.readonly) out.push('readonly')
  return out
}

function quote(text: string): string {
  return JSON.stringify(text.length > 200 ? `${text.slice(0, 200)}…` : text)
}

function quoteLoc(text: string): string {
  return JSON.stringify(text)
}

function collectActionableSubtrees(nodes: AxNode[]): Set<string> {
  const byId = new Map<string, AxNode>()
  for (const n of nodes) if (n?.nodeId) byId.set(n.nodeId, n)
  const memo = new Map<string, boolean>()
  const useful = new Set<string>()
  const visit = (node: AxNode | undefined): boolean => {
    if (!node) return false
    const cached = memo.get(node.nodeId)
    if (cached !== undefined) return cached
    memo.set(node.nodeId, false) // 防环
    const role = normalizeRole(node.role?.value)
    let hit = ACTIONABLE_ROLES.has(role) && typeof node.backendDOMNodeId === 'number'
    for (const id of node.childIds || []) {
      if (visit(byId.get(id))) hit = true
    }
    memo.set(node.nodeId, hit)
    if (hit) useful.add(node.nodeId)
    return hit
  }
  for (const n of nodes) visit(n)
  return useful
}

function countLocatorKeys(nodes: AxNode[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const n of nodes) {
    if (!n || n.ignored || typeof n.backendDOMNodeId !== 'number') continue
    const role = normalizeRole(n.role?.value)
    if (!ACTIONABLE_ROLES.has(role)) continue
    const name = normalizeText(n.name?.value)
    if (!name || name.length > 60) continue
    const key = `${role}\u0000${name}`
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return counts
}

function countFrames(tree: any): number {  if (!tree) return 1
  let n = 1
  for (const child of tree.childFrames || []) n += countFrames(child)
  return n
}

async function fillBoxes(cdp: CdpSession, refs: Map<number, RefEntry>): Promise<void> {
  let count = 0
  for (const entry of refs.values()) {
    if (count++ >= 40) break
    try {
      const box = await cdp.send<any>('DOM.getBoxModel', { backendNodeId: entry.backendNodeId }, 5_000)
      const quad = box?.model?.border
      if (Array.isArray(quad) && quad.length >= 8) {
        const xs = [quad[0], quad[2], quad[4], quad[6]]
        const ys = [quad[1], quad[3], quad[5], quad[7]]
        const x = Math.min(...xs)
        const y = Math.min(...ys)
        entry.box = { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
      }
    } catch { /* 单个节点失败忽略 */ }
  }
}

function clamp(v: unknown, min: number, max: number, def: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, Math.round(n)))
}
