/**
 * drawio-xml.ts — .drawio 文件的最小 XML 工具集（主进程用，纯 Node，无第三方依赖）
 *
 * 为什么不用 DOMParser：主进程没有 DOM，项目里也没有任何 XML 库（只装了 @modelcontextprotocol/sdk）。
 * 这里实现「保留原文」的宽松解析/序列化：
 *   - **不解码实体**（`&lt;br&gt;` 读进来还是 `&lt;br&gt;`），序列化时原样写回 → 往返无损
 *   - 只在「由工具参数写入新值」时用 escapeAttr() 显式转义（边界清晰，不会二次转义）
 *
 * 同时提供 drawio 语义层：mxfile / diagram(含 deflateRaw+base64 压缩页) / mxGraphModel / mxCell
 * （含被 <object> 包裹的带 tags/metadata 的单元）。
 */
import * as zlib from 'node:zlib'

// ==================== 基础 XML 节点模型 ====================

export interface XEl {
  name: string
  attrs: Record<string, string>
  children: XEl[]
  /** 文本内容（压缩页的 base64 就放在这里） */
  text: string
  selfClose: boolean
}

export function createEl(name: string, attrs: Record<string, string> = {}, text = ''): XEl {
  return { name, attrs, children: [], text, selfClose: !text }
}

export function escapeAttr(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function unescapeXml(v: string): string {
  return String(v ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#xa;/gi, '\n')
    .replace(/&#10;/g, '\n')
    .replace(/&amp;/g, '&')
}

const ATTR_RE = /([A-Za-z_:][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const TAG_RE =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([A-Za-z_:][\w.:-]*)\s*>|<([A-Za-z_:][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g

/**
 * 宽松解析：容忍未转义的实体、任意空白、注释、XML 声明、CDATA。
 * 返回根元素；解析失败返回 null。
 */
export function parseXml(text: string): XEl | null {
  const src = String(text || '')
  const stack: XEl[] = []
  let root: XEl | null = null
  TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG_RE.exec(src))) {
    if (m[0].startsWith('<!--') || m[0].startsWith('<?')) continue
    if (m[1] !== undefined) {
      // CDATA：当作文本
      if (stack.length) stack[stack.length - 1].text += m[1]
      continue
    }
    if (m[2]) {
      // 结束标签
      const el = stack.pop()
      if (el) {
        el.selfClose = false
        if (!stack.length && !root) root = el
      }
      continue
    }
    if (m[3]) {
      // 开始标签
      const el: XEl = { name: m[3], attrs: {}, children: [], text: '', selfClose: !!m[5] }
      ATTR_RE.lastIndex = 0
      let a: RegExpExecArray | null
      while ((a = ATTR_RE.exec(m[4] || ''))) el.attrs[a[1]] = a[2] !== undefined ? a[2] : a[3]
      if (stack.length) stack[stack.length - 1].children.push(el)
      else if (!root) root = el
      if (!el.selfClose) stack.push(el)
      else if (!stack.length && !root) root = el
      continue
    }
    if (m[6] !== undefined) {
      // 文本
      const txt = m[6]
      if (stack.length) {
        const top = stack[stack.length - 1]
        top.text += txt
        if (txt.trim()) top.selfClose = false
      }
    }
  }
  return root
}

export function serializeXml(el: XEl, indent = 0): string {
  const pad = '  '.repeat(indent)
  const attrs = Object.keys(el.attrs)
    .map((k) => ` ${k}="${el.attrs[k]}"`)
    .join('')
  const inline = (v: string) => v.replace(/"/g, '&quot;')
  if (el.name === 'mxfile' || el.name === 'mxGraphModel' || el.name === 'root' || el.name === 'diagram') {
    // 结构性元素：换行缩进便于人读
    if (el.name === 'root') {
      const kids = el.children.map((c) => serializeXml(c, indent + 1)).join('\n')
      return `${pad}<root>${kids ? '\n' + kids + '\n' + pad : ''}</root>`
    }
    if (el.name === 'mxfile') {
      const head = el.attrs.version !== undefined ? '' : ''
      void head
      const kids = el.children.map((c) => serializeXml(c, indent + 1)).join('\n')
      return `<mxfile${attrs}>${kids ? '\n' + kids + '\n' : ''}</mxfile>`
    }
    if (el.name === 'diagram') {
      // 压缩页：文本是 base64，不要缩进/换行
      if (el.text.trim()) return `${'  '.repeat(indent)}<diagram${attrs}>${el.text.trim()}</diagram>`
      const kids = el.children.map((c) => serializeXml(c, indent + 1)).join('\n')
      return `${pad}<diagram${attrs}>${kids ? '\n' + kids + '\n' + pad : ''}</diagram>`
    }
    const kids = el.children.map((c) => serializeXml(c, indent + 1)).join('\n')
    return `${pad}<mxGraphModel${attrs}>${kids ? '\n' + kids + '\n' + pad : ''}</mxGraphModel>`
  }
  // 单元：单行紧凑
  const kidStr = el.children.map((c) => serializeXml(c, 0)).join('')
  const body = kidStr + (el.text ? inline(el.text) : '')
  if (!body) return `<${el.name}${attrs}/>`
  return `<${el.name}${attrs}>${body}</${el.name}>`
}

export function findChild(el: XEl | null, name: string): XEl | null {
  if (!el) return null
  for (const c of el.children) if (c.name === name) return c
  return null
}

export function findAll(el: XEl | null, name: string, out: XEl[] = []): XEl[] {
  if (!el) return out
  for (const c of el.children) {
    if (c.name === name) out.push(c)
    findAll(c, name, out)
  }
  return out
}

export function findChildDeep(el: XEl | null, names: string[]): XEl | null {
  if (!el) return null
  if (names.includes(el.name)) return el
  for (const c of el.children) {
    const hit = findChildDeep(c, names)
    if (hit) return hit
  }
  return null
}

export function cloneEl(el: XEl): XEl {
  return {
    name: el.name,
    attrs: { ...el.attrs },
    children: el.children.map(cloneEl),
    text: el.text,
    selfClose: el.selfClose,
  }
}

// ==================== 压缩页（deflateRaw + base64） ====================

/** drawio 的压缩格式：base64( deflateRaw( utf8( encodeURIComponent(xml) ) ) ) */
export function compressModel(modelXml: string): string {
  const encoded = encodeURIComponent(modelXml)
  const buf = Buffer.from(encoded, 'utf8')
  return zlib.deflateRawSync(buf).toString('base64')
}

export function decompressModel(b64: string): string {
  const raw = zlib.inflateRawSync(Buffer.from(String(b64).trim(), 'base64'))
  return decodeURIComponent(raw.toString('utf8'))
}

// ==================== mxfile / 页面 ====================

export interface DrawioPage {
  index: number
  /** <diagram> 元素 */
  el: XEl
  id: string
  name: string
  /** 内容是否是压缩的 base64 */
  compressed: boolean
  /** 已解开的 mxGraphModel（不存在则 null） */
  model: XEl | null
}

/** 把任意 drawio XML（mxfile 或裸 mxGraphModel）规范成 mxfile 根元素 */
export function asMxfile(text: string): XEl | null {
  const root = parseXml(text)
  if (!root) return null
  if (root.name === 'mxfile') return root
  if (root.name === 'mxGraphModel') {
    const diagram = createEl('diagram')
    diagram.attrs.id = 'page1'
    diagram.attrs.name = 'Page-1'
    diagram.children.push(root)
    const file = createEl('mxfile')
    file.attrs.host = 'app.diagrams.net'
    file.children.push(diagram)
    return file
  }
  return null
}

export function pagesOf(mxfile: XEl): DrawioPage[] {
  const out: DrawioPage[] = []
  const diagrams = mxfile.children.filter((c) => c.name === 'diagram')
  diagrams.forEach((el, i) => {
    const modelDirect = findChild(el, 'mxGraphModel')
    const compressed = !modelDirect && !!el.text.trim()
    let model: XEl | null = modelDirect
    if (!model && compressed) {
      try {
        model = parseXml(decompressModel(el.text))
      } catch {
        model = null
      }
    }
    out.push({
      index: i,
      el,
      id: el.attrs.id || `page${i + 1}`,
      name: el.attrs.name || `Page-${i + 1}`,
      compressed,
      model,
    })
  })
  return out
}

/** 按 index / id / name 定位页面（三个都能用，方便 LLM 随便给） */
export function pickPage(pages: DrawioPage[], ref: any): DrawioPage | null {
  if (ref === undefined || ref === null || ref === '') return pages[0] || null
  const s = String(ref)
  const byIndex = Number.isInteger(Number(s)) ? pages[Number(s)] : undefined
  if (byIndex) return byIndex
  return pages.find((p) => p.id === s) || pages.find((p) => p.name === s) || null
}

/** 把 mxGraphModel XML 写回 page.el（保持原本的压缩状态） */
export function setPageModel(page: DrawioPage, modelXml: string): void {
  const model = parseXml(modelXml)
  if (!model) throw new Error('内容不是合法 XML')
  page.el.children = page.el.children.filter((c) => c.name !== 'mxGraphModel')
  if (page.compressed) {
    page.el.text = compressModel(modelXml)
    page.el.children = []
  } else {
    page.el.text = ''
    page.el.children.push(model)
  }
  page.model = model
}

export function newPageEl(id: string, name: string, modelXml: string): XEl {
  const el = createEl('diagram')
  el.attrs.id = id
  el.attrs.name = name
  const model = parseXml(modelXml)
  if (model) el.children.push(model)
  return el
}

// ==================== mxGraphModel / mxCell ====================

/** 新建一个空页面的 mxGraphModel XML */
export function emptyModelXml(): string {
  return (
    '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" ' +
    'arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">' +
    '<root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>'
  )
}

export function modelRoot(model: XEl | null): XEl | null {
  return findChild(model, 'root')
}

export interface CellEntry {
  /** 携带 id 的元素：mxCell 或 <object> 包裹层 */
  holder: XEl
  /** 真正的 mxCell（object 场景下是子元素；否则等于 holder） */
  cell: XEl
  id: string
  /** 文本：object 用 label，mxCell 用 value */
  value: string
  kind: 'vertex' | 'edge' | 'layer' | 'other'
  parent: string
  source: string
  target: string
  style: string
  geometry: XEl | null
  /** <object> 上的额外属性（tags/metadata/placeholders…） */
  custom: Record<string, string>
}

export function isCellEl(el: XEl): boolean {
  return el.name === 'mxCell' || el.name === 'object' || el.name === 'UserObject'
}

/** root 下的单元条目（保持文档顺序；不含 id=0/1 的根与默认层） */
export function cellEntries(root: XEl | null, includeRoots = false): CellEntry[] {
  if (!root) return []
  const out: CellEntry[] = []
  for (const el of root.children) {
    if (!isCellEl(el)) continue
    const holder = el
    const cell = el.name === 'mxCell' ? el : findChild(el, 'mxCell')
    if (!cell) continue
    const id = holder.attrs.id || cell.attrs.id || ''
    if (!includeRoots && (id === '0' || id === '1')) continue
    const vertex = cell.attrs.vertex === '1'
    const edge = cell.attrs.edge === '1'
    const layer = !vertex && !edge && (cell.attrs.parent === '0' || holder.attrs.parent === '0')
    const geometry = findChild(cell, 'mxGeometry') || findChild(cell, 'geometry')
    const custom: Record<string, string> = {}
    if (holder.name !== 'mxCell') {
      for (const k of Object.keys(holder.attrs)) {
        if (['id', 'label', 'placeholders', 'tags'].includes(k)) continue
        custom[k] = holder.attrs[k]
      }
      if (holder.attrs.tags) custom.tags = holder.attrs.tags
    }
    out.push({
      holder,
      cell,
      id,
      value: holder.name === 'mxCell' ? cell.attrs.value || '' : holder.attrs.label || '',
      kind: vertex ? 'vertex' : edge ? 'edge' : layer ? 'layer' : 'other',
      parent: cell.attrs.parent || holder.attrs.parent || '',
      source: cell.attrs.source || '',
      target: cell.attrs.target || '',
      style: cell.attrs.style || '',
      geometry,
      custom,
    })
  }
  return out
}

export function cellById(root: XEl | null, id: string): CellEntry | null {
  return cellEntries(root, true).find((c) => c.id === id) || null
}

/** 生成不与已有 id 冲突的新 id */
export function uniqueId(root: XEl | null, prefix = 'n'): string {
  const used = new Set(cellEntries(root, true).map((c) => c.id))
  let i = 1
  while (used.has(`${prefix}${i}`)) i++
  return `${prefix}${i}`
}

export function num(v: any, dflt: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

export function geomOf(entry: CellEntry): { x: number; y: number; w: number; h: number } {
  const g = entry.geometry
  return {
    x: num(g?.attrs.x, 0),
    y: num(g?.attrs.y, 0),
    w: num(g?.attrs.width, 120),
    h: num(g?.attrs.height, 60),
  }
}

export function ensureGeometry(cell: XEl, defaults: { w?: number; h?: number } = {}): XEl {
  let g = findChild(cell, 'mxGeometry')
  if (!g) {
    g = createEl('mxGeometry')
    g.attrs.as = 'geometry'
    cell.children.push(g)
  }
  if (cell.attrs.edge === '1') {
    if (g.attrs.relative === undefined) g.attrs.relative = '1'
  } else {
    if (g.attrs.x === undefined) g.attrs.x = '0'
    if (g.attrs.y === undefined) g.attrs.y = '0'
    if (g.attrs.width === undefined) g.attrs.width = String(defaults.w ?? 120)
    if (g.attrs.height === undefined) g.attrs.height = String(defaults.h ?? 60)
  }
  return g
}

/** 把 geometry 上缺失的字段补成合法值（不覆盖已有） */
export function normalizeGeom(cell: XEl, w = 120, h = 60): void {
  const g = ensureGeometry(cell, { w, h })
  if (cell.attrs.edge === '1') return
  for (const k of ['x', 'y'] as const) {
    if (g.attrs[k] === undefined || !Number.isFinite(Number(g.attrs[k]))) g.attrs[k] = '0'
  }
  for (const k of ['width', 'height'] as const) {
    const dflt = k === 'width' ? w : h
    const v = Number(g.attrs[k])
    if (g.attrs[k] === undefined || !Number.isFinite(v) || v < 5) g.attrs[k] = String(dflt)
  }
}

// ==================== style 字符串 ====================

export function styleGet(style: string, key: string): string | null {
  const parts = String(style || '').split(';')
  for (const p of parts) {
    const idx = p.indexOf('=')
    if (idx < 0) {
      if (p.trim() === key) return ''
      continue
    }
    if (p.slice(0, idx).trim() === key) return p.slice(idx + 1)
  }
  return null
}

export function styleSet(style: string, key: string, value: string): string {
  const parts = String(style || '')
    .split(';')
    .filter((p) => p.trim() !== '')
    .filter((p) => {
      const idx = p.indexOf('=')
      const k = idx < 0 ? p.trim() : p.slice(0, idx).trim()
      return k !== key
    })
  if (value !== '' && value !== null && value !== undefined) parts.push(`${key}=${value}`)
  return parts.join(';') + (parts.length ? ';' : '')
}

export function styleDel(style: string, key: string): string {
  return styleSet(style, key, '')
}
