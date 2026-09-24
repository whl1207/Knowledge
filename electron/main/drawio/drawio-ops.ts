/**
 * drawio-ops.ts — drawio 的高层操作原语（纯 Node，主进程用）
 *
 * 内容分成四块：
 *   1) 形状/样式目录（drawio_search_shapes / drawio_style_help 的数据源）
 *   2) 布局：分层自动布局、网格布局、对齐、等距分布、适应页面尺寸
 *   3) 互转：Mermaid 导入/导出、CSV → 图
 *   4) 导出：SVG（基础形状的尽力而为渲染，用于快速预览/交付）
 *
 * 参考了官方 jgraph/drawio-mcp 的做法：形状检索先于生成、刚性网格、
 * 语义化形状优先、按图类型统一连线风格。
 */
import {
  XEl,
  createEl,
  escapeAttr,
  serializeXml,
  styleGet,
  cellEntries,
  geomOf,
  ensureGeometry,
  num,
  uniqueId,
  CellEntry,
  findChild,
} from './drawio-xml'

// ==================== 1) 形状 / 样式目录 ====================

export interface ShapeSnippet {
  /** 可直接写进 style 的形状片段 */
  style: string
  zh: string
  en: string
  /** 额外关键词，便于检索命中 */
  keys?: string
}

/** 基础形状 + 常用图形（style 片段可直接用） */
export const SHAPE_CATALOG: ShapeSnippet[] = [
  { style: 'rounded=0;whiteSpace=wrap;html=1;', zh: '矩形/处理', en: 'rectangle / process', keys: 'rect box 方框 矩形 处理' },
  { style: 'rounded=1;whiteSpace=wrap;html=1;', zh: '圆角矩形', en: 'rounded rectangle', keys: 'rounded 圆角' },
  { style: 'ellipse;whiteSpace=wrap;html=1;', zh: '椭圆', en: 'ellipse', keys: 'oval 椭圆' },
  { style: 'shape=mxgraph.flowchart.terminator;whiteSpace=wrap;html=1;', zh: '起止（圆角端）', en: 'terminator / start-end', keys: 'start end 开始 结束 起止' },
  { style: 'rhombus;whiteSpace=wrap;html=1;', zh: '菱形（判断）', en: 'diamond / decision', keys: 'decision 判断 决策 菱形' },
  { style: 'shape=mxgraph.flowchart.document;whiteSpace=wrap;html=1;', zh: '文档', en: 'document', keys: 'doc 文档 报表' },
  { style: 'shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;', zh: '数据库/圆柱', en: 'database / cylinder', keys: 'db database 数据库 存储 cylinder' },
  { style: 'shape=parallelogram;perimeter=parallelogramPerimeter;whiteSpace=wrap;html=1;', zh: '平行四边形（输入输出）', en: 'parallelogram / IO', keys: 'io 输入 输出' },
  { style: 'shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;', zh: '六边形（准备）', en: 'hexagon / preparation', keys: '准备 prepare' },
  { style: 'shape=trapezoid;perimeter=trapezoidPerimeter;whiteSpace=wrap;html=1;', zh: '梯形（手动操作）', en: 'trapezoid / manual op', keys: '手动' },
  { style: 'triangle;whiteSpace=wrap;html=1;', zh: '三角形', en: 'triangle', keys: '三角' },
  { style: 'shape=step;perimeter=stepPerimeter;whiteSpace=wrap;html=1;', zh: '步骤', en: 'step', keys: '步骤 step' },
  { style: 'shape=cloud;whiteSpace=wrap;html=1;', zh: '云', en: 'cloud', keys: '云 cloud 网际' },
  { style: 'shape=note;whiteSpace=wrap;html=1;size=14;', zh: '便签', en: 'note', keys: 'note 便签 注释' },
  { style: 'text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;', zh: '纯文本标签', en: 'text label', keys: 'text 文本 标签 title 标题' },
  { style: 'rounded=0;whiteSpace=wrap;html=1;shape=card;', zh: '卡片', en: 'card', keys: 'card 卡片' },
  { style: 'shape=mxgraph.basic.database;whiteSpace=wrap;html=1;', zh: '数据表', en: 'datastore table', keys: '数据表' },
  { style: 'swimlane;startSize=30;html=1;', zh: '泳道/容器（带标题）', en: 'swimlane container', keys: 'swimlane 泳道 容器 container 分组' },
  { style: 'swimlane;horizontal=0;startSize=110;html=1;', zh: '横向泳道（BPMN 风格）', en: 'flat horizontal swimlane (BPMN)', keys: '泳道 bpmn lane 横向' },
  { style: 'group;', zh: '不可见分组', en: 'invisible group', keys: 'group 分组 组合' },
  { style: 'shape=table;childLayout=tableLayout;startSize=0;collapsible=0;fillColor=none;', zh: '表格容器（跨职能流程）', en: 'table container (cross-functional)', keys: 'table 表格 跨职能' },
  { style: 'shape=umlLifeline;perimeter=lifelinePerimeter;whiteSpace=wrap;html=1;size=16;', zh: 'UML 时序生命线', en: 'UML lifeline', keys: 'uml 时序 sequence lifeline' },
  { style: 'shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;', zh: 'UML 角色', en: 'UML actor', keys: 'actor 角色 人' },
  { style: 'shape=image;imageAspect=0;aspect=fixed;verticalLabelPosition=bottom;verticalAlign=top;html=1;', zh: '图片图标（配 image= 用）', en: 'image icon (with image=)', keys: 'icon 图标 图片 logo' },
  { style: 'edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=classic;', zh: '正交折线箭头（流程图/架构默认）', en: 'orthogonal arrow', keys: 'edge arrow 箭头 连线 折线' },
  { style: 'edgeStyle=entityRelationEdgeStyle;html=1;endArrow=ERone;startArrow=ERmany;', zh: 'ER 关系线（一对多）', en: 'ER relation (1..*)', keys: 'er 实体关系 一对多' },
  { style: 'curved=1;html=1;endArrow=classic;', zh: '曲线箭头（思维导图）', en: 'curved arrow (mind map)', keys: 'curve 曲线 思维导图' },
  { style: 'html=1;endArrow=classic;dashed=1;dashPattern=8 8;', zh: '虚线箭头（可选/异步）', en: 'dashed arrow', keys: 'dashed 虚线 异步 可选' },
  { style: 'html=1;endArrow=none;startArrow=none;', zh: '无箭头连线（关联）', en: 'plain line', keys: '无箭头 关联 line' },
]

/** 标准配色对（浅色填充 + 描边） */
export const COLOR_PAIRS: Array<{ zh: string; en: string; fill: string; stroke: string }> = [
  { zh: '蓝', en: 'blue', fill: '#dae8fc', stroke: '#6c8ebf' },
  { zh: '绿', en: 'green', fill: '#d5e8d4', stroke: '#82b366' },
  { zh: '橙', en: 'orange', fill: '#ffe6cc', stroke: '#d79b00' },
  { zh: '红', en: 'red', fill: '#f8cecc', stroke: '#b85450' },
  { zh: '紫', en: 'purple', fill: '#e1d5e7', stroke: '#9673a6' },
  { zh: '黄', en: 'yellow', fill: '#fff2cc', stroke: '#d6b656' },
  { zh: '灰', en: 'gray', fill: '#f5f5f5', stroke: '#666666' },
]

export function searchShapes(query: string, limit = 10): ShapeSnippet[] {
  const q = String(query || '').toLowerCase().trim()
  if (!q) return SHAPE_CATALOG.slice(0, limit)
  const words = q.split(/\s+/)
  const scored = SHAPE_CATALOG.map((s) => {
    const hay = `${s.style} ${s.zh} ${s.en} ${s.keys || ''}`.toLowerCase()
    let score = 0
    for (const w of words) {
      if (!w) continue
      if (s.style.toLowerCase().includes(w)) score += 3
      if (hay.includes(w)) score += 2
    }
    return { s, score }
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
  return scored.slice(0, Math.max(1, Math.min(50, limit))).map((x) => x.s)
}

// ==================== 2) 布局 ====================

export interface LayoutOptions {
  direction?: 'vertical' | 'horizontal'
  nodeWidth?: number
  nodeHeight?: number
  colGap?: number
  rowGap?: number
  startX?: number
  startY?: number
}

/**
 * 分层自动布局：按边的方向做拓扑分层，同层内依次排列。
 * 只用连线关系推导层号（无环检测失败时按发现顺序兜底），不依赖外部布局库。
 */
export function autoLayout(root: XEl, opts: LayoutOptions = {}): { moved: number; layers: number } {
  const dir = opts.direction === 'horizontal' ? 'horizontal' : 'vertical'
  const w = num(opts.nodeWidth, 140)
  const h = num(opts.nodeHeight, 60)
  const colGap = num(opts.colGap, 60)
  const rowGap = num(opts.rowGap, 60)
  const startX = num(opts.startX, 40)
  const startY = num(opts.startY, 40)

  const entries = cellEntries(root)
  const vertices = entries.filter((e) => e.kind === 'vertex' && e.cell.attrs.parent === '1')
  const edges = entries.filter((e) => e.kind === 'edge')
  if (!vertices.length) return { moved: 0, layers: 0 }

  const ids = new Set(vertices.map((v) => v.id))
  const indeg = new Map<string, number>()
  const outAdj = new Map<string, string[]>()
  for (const v of vertices) {
    indeg.set(v.id, 0)
    outAdj.set(v.id, [])
  }
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target) || e.source === e.target) continue
    outAdj.get(e.source)!.push(e.target)
    indeg.set(e.target, (indeg.get(e.target) || 0) + 1)
  }

  // Kahn 拓扑分层
  const layer = new Map<string, number>()
  for (const v of vertices) layer.set(v.id, 0)
  const queue = vertices.filter((v) => (indeg.get(v.id) || 0) === 0).map((v) => v.id)
  const seen = new Set<string>(queue)
  while (queue.length) {
    const cur = queue.shift()!
    for (const nxt of outAdj.get(cur) || []) {
      layer.set(nxt, Math.max(layer.get(nxt) || 0, (layer.get(cur) || 0) + 1))
      if (!seen.has(nxt) && (indeg.get(nxt) || 0) > 0) {
        indeg.set(nxt, (indeg.get(nxt) || 0) - 1)
        if ((indeg.get(nxt) || 0) === 0) {
          seen.add(nxt)
          queue.push(nxt)
        }
      }
    }
  }

  const byLayer = new Map<number, CellEntry[]>()
  for (const v of vertices) {
    const l = layer.get(v.id) || 0
    if (!byLayer.has(l)) byLayer.set(l, [])
    byLayer.get(l)!.push(v)
  }
  const layerCount = byLayer.size
  for (const [l, list] of Array.from(byLayer.entries()).sort((a, b) => a[0] - b[0])) {
    list.forEach((v, i) => {
      const g = ensureGeometry(v.cell, { w, h })
      if (dir === 'vertical') {
        g.attrs.x = String(startX + i * (w + colGap))
        g.attrs.y = String(startY + l * (h + rowGap))
      } else {
        g.attrs.x = String(startX + l * (w + colGap))
        g.attrs.y = String(startY + i * (h + rowGap))
      }
      if (!g.attrs.width) g.attrs.width = String(w)
      if (!g.attrs.height) g.attrs.height = String(h)
    })
  }
  return { moved: vertices.length, layers: layerCount }
}

/** 网格布局：按给定列数平铺（适合同级节点很多、没有明显方向时） */
export function gridLayout(root: XEl, columns = 4, opts: LayoutOptions = {}): { moved: number } {
  const w = num(opts.nodeWidth, 140)
  const h = num(opts.nodeHeight, 60)
  const colGap = num(opts.colGap, 60)
  const rowGap = num(opts.rowGap, 60)
  const startX = num(opts.startX, 40)
  const startY = num(opts.startY, 40)
  const vertices = cellEntries(root).filter((e) => e.kind === 'vertex' && e.cell.attrs.parent === '1')
  const cols = Math.max(1, columns)
  vertices.forEach((v, i) => {
    const g = ensureGeometry(v.cell, { w, h })
    g.attrs.x = String(startX + (i % cols) * (w + colGap))
    g.attrs.y = String(startY + Math.floor(i / cols) * (h + rowGap))
    if (!g.attrs.width) g.attrs.width = String(w)
    if (!g.attrs.height) g.attrs.height = String(h)
  })
  return { moved: vertices.length }
}

export type AlignMode = 'left' | 'right' | 'center' | 'top' | 'bottom' | 'middle'

/** 对齐：以选中集合的包围盒为基准 */
export function alignCells(root: XEl, ids: string[], mode: AlignMode): { moved: number } {
  const entries = cellEntries(root).filter((e) => ids.includes(e.id) && e.kind === 'vertex')
  if (entries.length < 2) return { moved: 0 }
  const boxes = entries.map((e) => ({ e, g: geomOf(e) }))
  const minX = Math.min(...boxes.map((b) => b.g.x))
  const maxX = Math.max(...boxes.map((b) => b.g.x + b.g.w))
  const minY = Math.min(...boxes.map((b) => b.g.y))
  const maxY = Math.max(...boxes.map((b) => b.g.y + b.g.h))
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  for (const b of boxes) {
    const g = ensureGeometry(b.e.cell)
    if (mode === 'left') g.attrs.x = String(minX)
    else if (mode === 'right') g.attrs.x = String(maxX - b.g.w)
    else if (mode === 'center') g.attrs.x = String(cx - b.g.w / 2)
    else if (mode === 'top') g.attrs.y = String(minY)
    else if (mode === 'bottom') g.attrs.y = String(maxY - b.g.h)
    else if (mode === 'middle') g.attrs.y = String(cy - b.g.h / 2)
  }
  return { moved: boxes.length }
}

/** 等距分布（至少 3 个才有意义）：保持首尾不动，中间均匀 */
export function distributeCells(root: XEl, ids: string[], axis: 'h' | 'v', gap?: number): { moved: number } {
  const entries = cellEntries(root).filter((e) => ids.includes(e.id) && e.kind === 'vertex')
  if (entries.length < 2) return { moved: 0 }
  const boxes = entries.map((e) => ({ e, g: geomOf(e) }))
  const key = axis === 'h' ? 'x' : 'y'
  const sizeKey = axis === 'h' ? 'w' : 'h'
  boxes.sort((a, b) => a.g[key] - b.g[key])
  const first = boxes[0]
  const last = boxes[boxes.length - 1]
  const span = last.g[key] + last.g[sizeKey] - first.g[key]
  const totalSize = boxes.reduce((s, b) => s + b.g[sizeKey], 0)
  const autoGap = (span - totalSize) / Math.max(1, boxes.length - 1)
  const useGap = gap === undefined ? autoGap : num(gap, autoGap)
  let cursor = first.g[key]
  for (let i = 0; i < boxes.length; i++) {
    const g = ensureGeometry(boxes[i].e.cell)
    const target = i === 0 ? first.g[key] : i === boxes.length - 1 ? last.g[key] : cursor
    if (i < boxes.length - 1) {
      g.attrs[key] = String(Math.round(target))
      cursor = target + boxes[i].g[sizeKey] + useGap
    }
  }
  return { moved: boxes.length }
}

/** 把页面尺寸调到刚好容纳内容（避免内容超出纸张） */
export function fitPageSize(model: XEl, pad = 40): { width: number; height: number } {
  const root = findChild(model, 'root')
  const vertices = root ? cellEntries(root).filter((e) => e.kind === 'vertex') : []
  if (!vertices.length) {
    model.attrs.pageWidth = '850'
    model.attrs.pageHeight = '1100'
    return { width: 850, height: 1100 }
  }
  let maxX = 0
  let maxY = 0
  for (const v of vertices) {
    const g = geomOf(v)
    maxX = Math.max(maxX, g.x + g.w)
    maxY = Math.max(maxY, g.y + g.h)
  }
  const width = Math.round((maxX + pad) / 10) * 10
  const height = Math.round((maxY + pad) / 10) * 10
  model.attrs.pageWidth = String(width)
  model.attrs.pageHeight = String(height)
  return { width, height }
}

/** 平移整个页面内容（dx/dy） */
export function translateAll(root: XEl, dx: number, dy: number): { moved: number } {
  const vertices = cellEntries(root).filter((e) => e.kind === 'vertex' && e.cell.attrs.parent === '1')
  for (const v of vertices) {
    const g = ensureGeometry(v.cell)
    g.attrs.x = String(num(g.attrs.x, 0) + dx)
    g.attrs.y = String(num(g.attrs.y, 0) + dy)
  }
  return { moved: vertices.length }
}

// ==================== 3) Mermaid / CSV ====================

/**
 * Mermaid 流程图 → drawio 节点/边（支持 flowchart/graph TD|TB|LR|RL|BT 的子集）
 * 支持：A[文本] A(文本) A{文本} ((文本)) / A --> B / A -->|标签| B / A -- 标签 --> B
 */
export function parseMermaid(text: string): {
  direction: 'vertical' | 'horizontal'
  nodes: Array<{ id: string; label: string; style: string }>
  edges: Array<{ from: string; to: string; label: string; dashed: boolean }>
} {
  const src = String(text || '')
  const lines = src.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('%%'))
  const dirLine = lines.find((l) => /^(flowchart|graph)\s+(TD|TB|LR|RL|BT)/i.test(l))
  const dir = dirLine && /(LR|RL)/i.test(dirLine) ? 'horizontal' : 'vertical'
  const nodes = new Map<string, { id: string; label: string; style: string }>()
  const edges: Array<{ from: string; to: string; label: string; dashed: boolean }> = []

  const addNode = (id: string, label: string, brace: string) => {
    if (!id) return
    // Mermaid 形状：((x))=圆、(x)=圆角、{x}=菱形、[x]=矩形、>x]=非对称
    const style = /^\{/.test(brace)
      ? 'rhombus;whiteSpace=wrap;html=1;'
      : /^\(\(/.test(brace)
        ? 'ellipse;whiteSpace=wrap;html=1;'
        : /^\(/.test(brace)
          ? 'rounded=1;whiteSpace=wrap;html=1;'
          : /^>/.test(brace)
            ? 'shape=partialRectangle;whiteSpace=wrap;html=1;'
            : 'rounded=0;whiteSpace=wrap;html=1;'
    const prev = nodes.get(id)
    nodes.set(id, { id, label: label || prev?.label || id, style: brace ? style : prev?.style || style })
  }

  /** 读取一个节点表达式：id + 可选形状包壳与文本 */
  const readNode = (s: string, i: number): { id: string; label: string; brace: string; end: number } | null => {
    const m = /^\s*([A-Za-z0-9_][A-Za-z0-9_\-$.]*)/.exec(s.slice(i))
    if (!m) return null
    let idx = i + m[0].length
    let brace = ''
    let label = ''
    const b = /^\s*(\(\(|\[\(|\[\[|\[|\{\{|\{|\(|>)/.exec(s.slice(idx))
    if (b) {
      brace = b[1]
      idx += b[0].length
      const close = { '((': '))', '[': ']', '{': '}', '(': ')', '[(': ')]', '[[': ']]', '{{': '}}', '>': ']' }[brace] || ''
      const at = close ? s.indexOf(close, idx) : -1
      if (at >= 0) {
        label = s.slice(idx, at)
        idx = at + close.length
        brace += close
      } else {
        label = s.slice(idx)
        idx = s.length
      }
      label = label.replace(/^"+|"+$/g, '').trim()
    }
    return { id: m[1], label, brace, end: idx }
  }

  /** 读取一条连线：返回标签与是否虚线 */
  const readLink = (s: string, i: number): { label: string; dashed: boolean; end: number } | null => {
    const rest = s.slice(i)
    const m =
      /^\s*<{0,2}\s*(?:--\s+([^\n|]+?)\s+-->|-\.\s+([^\n|]+?)\s+\.->|==\s+([^\n|]+?)\s+==>|(-\.-{1,2}>?|-{1,3}[->xo]{0,2}|={2,3}>?))\s*(?:\|([^|]*)\|)?\s*/.exec(rest)
    if (!m) return null
    const token = m[4] || ''
    const label = String(m[1] || m[2] || m[3] || m[5] || '').trim()
    const looksLikeLink = !!token && /-|=/.test(token)
    if (!looksLikeLink) return null
    return { label, dashed: /^-?\./.test(token) || token.startsWith('-.'), end: i + m[0].length }
  }

  for (const line of lines) {
    if (/^(flowchart|graph|subgraph|end|click|style|classDef|class|linkStyle|direction|linkStyle)/i.test(line)) continue
    const first = readNode(line, 0)
    if (!first) continue
    addNode(first.id, first.label, first.brace)
    let prev = first
    let i = first.end
    let chained = false
    for (;;) {
      const l = readLink(line, i)
      if (!l) break
      const next = readNode(line, l.end)
      if (!next) break
      addNode(next.id, next.label, next.brace)
      edges.push({ from: prev.id, to: next.id, label: l.label, dashed: l.dashed })
      prev = next
      i = next.end
      chained = true
    }
    // 同一行里用 & 并列的节点：A & B --> C
    if (!chained && /&/.test(line)) {
      for (const part of line.split(/&|-->/)) {
        const n = readNode(part, 0)
        if (n) addNode(n.id, n.label, n.brace)
      }
    }
  }
  return { direction: dir, nodes: Array.from(nodes.values()), edges }
}

/** 导出为 Mermaid flowchart 文本（容器 → subgraph、菱形/圆 → 对应形状、带标签连线） */
export function toMermaid(root: XEl, direction: 'vertical' | 'horizontal' = 'vertical'): string {
  const entries = cellEntries(root)
  const vertices = entries.filter((e) => e.kind === 'vertex')
  const edges = entries.filter((e) => e.kind === 'edge')
  const safe = (s: string) => s.replace(/"/g, "'").replace(/\r?\n/g, ' ').replace(/[[\]{}()]/g, ' ').trim()
  const sid = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_')
  const isContainer = (style: string) => /swimlane|container=1|group/.test(style)
  const byId = new Map(vertices.map((v) => [v.id, v]))
  const containerIds = new Set(vertices.filter((v) => isContainer(v.style)).map((v) => v.id))
  // 只把“确实有子单元”的容器画成 subgraph，空容器按普通节点输出
  const childrenOf = new Map<string, typeof vertices>()
  for (const v of vertices) {
    const p = v.parent
    if (!containerIds.has(p)) continue
    const list = childrenOf.get(p) || []
    list.push(v)
    childrenOf.set(p, list)
  }
  for (const id of Array.from(containerIds)) if (!childrenOf.get(id)?.length) containerIds.delete(id)

  const lines: string[] = [`flowchart ${direction === 'vertical' ? 'TD' : 'LR'}`]
  const shapeOf = (style: string) => (/rhombus/.test(style) ? 'rhombus' : /ellipse/.test(style) ? 'ellipse' : /rounded=1/.test(style) ? 'rounded' : 'rect')
  const nodeLine = (v: (typeof vertices)[number], indent: string) => {
    const label = safe(v.value) || sid(v.id)
    const shape = shapeOf(v.style)
    if (shape === 'rhombus') return `${indent}${sid(v.id)}{"${label}"}`
    if (shape === 'ellipse') return `${indent}${sid(v.id)}(("${label}"))`
    if (shape === 'rounded') return `${indent}${sid(v.id)}("${label}")`
    return `${indent}${sid(v.id)}["${label}"]`
  }
  const emit = (v: (typeof vertices)[number], indent: string, seen: Set<string>) => {
    if (seen.has(v.id)) return
    seen.add(v.id)
    const kids = childrenOf.get(v.id)
    if (kids?.length) {
      lines.push(`${indent}subgraph ${sid(v.id)}["${safe(v.value) || sid(v.id)}"]`)
      for (const k of kids) emit(k, indent + '  ', seen)
      lines.push(`${indent}end`)
    } else {
      const l = nodeLine(v, indent)
      if (l) lines.push(l)
    }
  }
  const seen = new Set<string>()
  for (const v of vertices) {
    const p = v.parent
    if (byId.has(p) && containerIds.has(p)) continue // 由父容器负责输出
    emit(v, '  ', seen)
  }
  for (const e of edges) {
    if (!e.source || !e.target) continue
    if (!byId.has(e.source) || !byId.has(e.target)) continue
    const label = safe(e.value)
    const dashed = /dashed=1/.test(e.style)
    const link = dashed ? (label ? `-. "${label}" .->` : '-.->') : label ? `-- "${label}" -->` : '-->'
    lines.push(`  ${sid(e.source)} ${link} ${sid(e.target)}`)
  }
  return lines.join('\n')
}

/** CSV → 组织架构/树 或 表格图（第一行当表头；column/row 可选） */
export function csvToDiagram(
  csv: string,
  mode: 'table' | 'org' = 'table',
  title = '',
): { xml: string; rows: number; cols: number } {
  const rows = String(csv || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(',').map((c) => c.trim().replace(/^"(.*)"$/, '$1')))
  if (!rows.length) throw new Error('CSV 为空')
  const cols = Math.max(...rows.map((r) => r.length))
  const root = createEl('root')
  root.children.push(createEl('mxCell', { id: '0' }))
  root.children.push(createEl('mxCell', { id: '1', parent: '0' }))

  const w = 140
  const h = 60
  const gap = 40

  if (mode === 'org') {
    // 第一列当层级路径（A,B,C 表示 A→B→C），同名去重
    const dataRows = rows.slice(1)
    const byPath = new Map<string, string>()
    let counter = 0
    const addNode = (label: string, depth: number, pathKey: string) => {
      const id = `n${++counter}`
      byPath.set(pathKey, id)
      const cell = createEl('mxCell', {
        id,
        value: escapeAttr(label),
        style: `rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;`,
        vertex: '1',
        parent: '1',
      })
      const g = createEl('mxGeometry', {
        x: String(40 + depth * (w + gap * 2)),
        y: String(40 + (byPath.size - 1) * (h + gap / 2)),
        width: String(w + 20),
        height: String(h),
        as: 'geometry',
      })
      cell.children.push(g)
      root.children.push(cell)
      return id
    }
    const levels = Math.max(...dataRows.map((r) => r.length))
    const idsByLevel: string[][] = Array.from({ length: levels }, () => [])
    for (const r of dataRows) {
      let prevId = ''
      let pathKey = ''
      r.forEach((label, i) => {
        if (!label) return
        pathKey = pathKey ? `${pathKey}>${label}` : label
        let id = byPath.get(pathKey)
        if (!id) {
          id = addNode(label, i, pathKey)
          idsByLevel[i].push(id)
          if (prevId) {
            const e = createEl('mxCell', {
              id: `e${++counter}`,
              style: 'edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=none;',
              edge: '1',
              parent: '1',
              source: prevId,
              target: id,
            })
            e.children.push(createEl('mxGeometry', { relative: '1', as: 'geometry' }))
            root.children.push(e)
          }
        }
        prevId = id
      })
    }
  } else {
    // 表格：等宽高单元格 + 表头底色
    rows.forEach((r, ri) => {
      for (let ci = 0; ci < cols; ci++) {
        const label = r[ci] ?? ''
        const id = `c${ri}_${ci}`
        const isHeader = ri === 0
        const cell = createEl('mxCell', {
          id,
          value: escapeAttr(label),
          style: `rounded=0;whiteSpace=wrap;html=1;${isHeader ? 'fillColor=#f5f5f5;fontStyle=1;' : ''}`,
          vertex: '1',
          parent: '1',
        })
        cell.children.push(
          createEl('mxGeometry', {
            x: String(40 + ci * (w + 10)),
            y: String(40 + ri * (h / 2 + 10)),
            width: String(w),
            height: String(h / 2),
            as: 'geometry',
          }),
        )
        root.children.push(cell)
      }
    })
  }

  const model = createEl('mxGraphModel', {
    dx: '800',
    dy: '600',
    grid: '1',
    gridSize: '10',
    page: '1',
    pageWidth: String(Math.max(850, 40 + cols * (w + 10) + 40)),
    pageHeight: String(Math.max(1100, 40 + rows.length * (h + 10) + 40)),
    math: '0',
    shadow: '0',
  })
  model.children.push(root)
  const diagram = createEl('diagram', { id: 'page1', name: title || 'Page-1' })
  diagram.children.push(model)
  const mxfile = createEl('mxfile', { host: 'app.diagrams.net' })
  mxfile.children.push(diagram)
  return { xml: serializeXml(mxfile), rows: rows.length, cols }
}

// ==================== 4) SVG 导出（尽力而为） ====================

function svgColor(style: string, key: string, dflt: string): string {
  const v = styleGet(style, key)
  return v && v !== 'default' ? v : dflt
}

/** 把一页渲染成 SVG（矩形/菱形/椭圆/圆柱近似 + 直线/正交连线 + 文本） */
export function modelToSvg(model: XEl): string {
  const root = findChild(model, 'root')
  const entries = root ? cellEntries(root) : []
  const vertices = entries.filter((e) => e.kind === 'vertex')
  const edges = entries.filter((e) => e.kind === 'edge')
  const box = new Map<string, { x: number; y: number; w: number; h: number }>()
  for (const v of vertices) box.set(v.id, geomOf(v))

  let maxX = 0
  let maxY = 0
  for (const b of box.values()) {
    maxX = Math.max(maxX, b.x + b.w)
    maxY = Math.max(maxY, b.y + b.h)
  }
  const W = Math.max(200, maxX + 40)
  const H = Math.max(200, maxY + 40)

  const fillOf = (style: string) => svgColor(style, 'fillColor', '#ffffff')
  const strokeOf = (style: string) => svgColor(style, 'strokeColor', '#000000')
  const fontOf = (style: string) => svgColor(style, 'fontColor', '#000000')
  const textOf = (v: CellEntry) =>
    String(v.value || '')
      .replace(/&lt;br\s*\/?&gt;/gi, '\n')
      .replace(/&#xa;/gi, '\n')
      .replace(/<[^>]*>/g, '')
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`)
  parts.push(
    '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#000"/></marker></defs>',
  )
  for (const e of edges) {
    const a = box.get(e.source)
    const b = box.get(e.target)
    if (!a || !b) continue
    const x1 = a.x + a.w / 2
    const y1 = a.y + a.h / 2
    const x2 = b.x + b.w / 2
    const y2 = b.y + b.h / 2
    const dashed = /dashed=1/.test(e.style) ? ' stroke-dasharray="8 8"' : ''
    const arrow = /endArrow=none/.test(e.style) ? '' : ' marker-end="url(#arrow)"'
    parts.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${strokeOf(e.style)}" stroke-width="1.5"${dashed}${arrow}/>`,
    )
    if (e.value) {
      parts.push(
        `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 4}" font-size="11" fill="${fontOf(e.style)}" text-anchor="middle">${esc(textOf(e))}</text>`,
      )
    }
  }
  for (const v of vertices) {
    const g = box.get(v.id)!
    const st = v.style
    const fill = fillOf(st)
    const stroke = strokeOf(st)
    if (/ellipse/.test(st)) {
      parts.push(
        `<ellipse cx="${g.x + g.w / 2}" cy="${g.y + g.h / 2}" rx="${g.w / 2}" ry="${g.h / 2}" fill="${fill}" stroke="${stroke}"/>`,
      )
    } else if (/rhombus/.test(st)) {
      parts.push(
        `<polygon points="${g.x + g.w / 2},${g.y} ${g.x + g.w},${g.y + g.h / 2} ${g.x + g.w / 2},${g.y + g.h} ${g.x},${g.y + g.h / 2}" fill="${fill}" stroke="${stroke}"/>`,
      )
    } else {
      const r = /rounded=1/.test(st) ? 8 : 0
      parts.push(
        `<rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="${r}" fill="${fill}" stroke="${stroke}"/>`,
      )
    }
    const label = textOf(v)
    if (label) {
      const lines = label.split('\n')
      const cxm = g.x + g.w / 2
      const startY = g.y + g.h / 2 - ((lines.length - 1) * 14) / 2
      lines.forEach((ln, i) => {
        parts.push(
          `<text x="${cxm}" y="${startY + i * 14}" font-size="12" fill="${fontOf(st)}" text-anchor="middle" dominant-baseline="middle">${esc(ln)}</text>`,
        )
      })
    }
  }
  parts.push('</svg>')
  return parts.join('\n')
}

/** 生成一个新单元（顶点）的 mxCell 元素 */
export function makeVertex(
  id: string,
  label: string,
  x: number,
  y: number,
  w: number,
  h: number,
  style: string,
  parent = '1',
): XEl {
  const cell = createEl('mxCell', {
    id,
    value: escapeAttr(label),
    style,
    vertex: '1',
    parent,
  })
  cell.children.push(
    createEl('mxGeometry', { x: String(x), y: String(y), width: String(w), height: String(h), as: 'geometry' }),
  )
  return cell
}

/** 生成一个新单元（连线）的 mxCell 元素 */
export function makeEdge(id: string, from: string, to: string, label: string, style: string, parent = '1'): XEl {
  const cell = createEl('mxCell', {
    id,
    value: escapeAttr(label),
    style,
    edge: '1',
    parent,
    source: from,
    target: to,
  })
  cell.children.push(createEl('mxGeometry', { relative: '1', as: 'geometry' }))
  return cell
}

export function nextId(root: XEl, prefix = 'n'): string {
  return uniqueId(root, prefix)
}
