/**
 * drawio-service.ts — 内置 drawio MCP 服务（builtin-drawio）
 *
 * 与 office-service / browser-agent 同构：主进程内 SDK Server over InMemoryTransport，
 * 由 mcp-service 以「内置服务（builtin: true）」方式接入 → 设置页可见、Agent / 工作流
 * 通过 mcp_call 调用；同时经 mcp-expose 以 Streamable HTTP 暴露给外部 MCP 客户端。
 *
 * 设计取舍：
 *   - **无状态**：每次调用「读文件 → 改 → 写回」，不维护会话，避免多步编辑时状态漂移；
 *     需要精确多步场景可传 dryRun 先看结果。
 *   - **保留原文**：drawio-xml 的解析/序列化不做实体解码，压缩页保持压缩（见该文件注释）。
 *   - 兼容被 <object> 包裹的单元（tags / metadata）。
 *
 * 工具集覆盖：文档与页面、查看与检索、单元增删改、容器/图层/标签/元数据、
 * 布局（自动分层/网格/对齐/等距）、Mermaid/CSV 互转、SVG 导出、形状与风格检索、校验。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  XEl,
  asMxfile,
  pagesOf,
  pickPage,
  setPageModel,
  newPageEl,
  emptyModelXml,
  modelRoot,
  cellEntries,
  cellById,
  geomOf,
  ensureGeometry,
  normalizeGeom,
  num,
  styleSet,
  styleDel,
  styleGet,
  escapeAttr,
  serializeXml,
  parseXml,
  createEl,
  findChild,
  uniqueId,
  compressModel,
  decompressModel,
  type DrawioPage,
  type CellEntry,
} from './drawio-xml'
import {
  autoLayout,
  gridLayout,
  alignCells,
  distributeCells,
  fitPageSize,
  translateAll,
  parseMermaid,
  toMermaid,
  csvToDiagram,
  modelToSvg,
  makeVertex,
  makeEdge,
  searchShapes,
  COLOR_PAIRS,
  type AlignMode,
} from './drawio-ops'

// ---------------- 运行时懒加载 MCP Server SDK（与 office-service 同款约束） ----------------
interface ServerSdkBundle {
  Server: any
  InMemoryTransport: any
  ListToolsRequestSchema: any
  CallToolRequestSchema: any
}
let serverSdkCache: ServerSdkBundle | null = null
async function getServerSdk(): Promise<ServerSdkBundle> {
  if (serverSdkCache) return serverSdkCache
  const [serverMod, inMemoryMod, typesMod] = await Promise.all([
    import(/* @vite-ignore */ '@modelcontextprotocol/sdk/server/index.js'),
    import(/* @vite-ignore */ '@modelcontextprotocol/sdk/inMemory.js'),
    import(/* @vite-ignore */ '@modelcontextprotocol/sdk/types.js'),
  ])
  serverSdkCache = {
    Server: (serverMod as any).Server ?? (serverMod as any).McpServer,
    InMemoryTransport: (inMemoryMod as any).InMemoryTransport,
    ListToolsRequestSchema: (typesMod as any).ListToolsRequestSchema,
    CallToolRequestSchema: (typesMod as any).CallToolRequestSchema,
  }
  return serverSdkCache
}

export const DRAWIO_MCP_ID = 'builtin-drawio'
export const DRAWIO_MCP_NAME = 'drawio'

const DRAWIO_EXTS = ['.drawio', '.dio', '.drawio.xml', '.xml']

/** 从参数里按多别名取第一个非空值（兼容 LLM 命名方差：path/filePath、page/pageIndex…） */
function arg(args: Record<string, any>, keys: string[]): any {
  for (const k of keys) {
    const v = args?.[k]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

function asList(v: any): string[] {
  if (v === undefined || v === null || v === '') return []
  if (Array.isArray(v)) return v.map((x) => String(x))
  return String(v)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function fmtNum(v: any, dflt: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

// ---------------- 文件读写 ----------------

function resolveDocPath(args: Record<string, any>): string {
  const raw = String(arg(args, ['path', 'filePath', 'file', 'file_path']) || '').trim()
  if (!raw) throw new Error('缺少参数 path（.drawio 文件路径）')
  const abs = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw)
  const lower = abs.toLowerCase()
  if (!DRAWIO_EXTS.some((e) => lower.endsWith(e))) {
    throw new Error(`仅支持 drawio 文件（${DRAWIO_EXTS.join(' / ')}）：${abs}`)
  }
  return abs
}

interface LoadedDoc {
  path: string
  file: XEl
  pages: DrawioPage[]
}

function loadDoc(abs: string): LoadedDoc {
  if (!fs.existsSync(abs)) throw new Error(`文件不存在: ${abs}`)
  const text = fs.readFileSync(abs, 'utf8')
  const file = asMxfile(text)
  if (!file) throw new Error('内容不是合法的 drawio XML（既不是 <mxfile> 也不是 <mxGraphModel>）')
  return { path: abs, file, pages: pagesOf(file) }
}

function requirePage(doc: LoadedDoc, args: Record<string, any>): DrawioPage {
  const page = pickPage(doc.pages, arg(args, ['page', 'pageIndex', 'pageId', 'pageName']))
  if (!page) throw new Error(`找不到页面：${arg(args, ['page', 'pageIndex', 'pageId', 'pageName'])}`)
  return page
}

function requireRoot(doc: LoadedDoc, args: Record<string, any>): XEl {
  const page = requirePage(doc, args)
  const root = modelRoot(page.model)
  if (!root) throw new Error('该页内容无法解析（可能不是 mxGraphModel）')
  return root
}

function saveDoc(doc: LoadedDoc): void {
  // 写回时保留原始压缩状态；文件不存在则创建
  fs.writeFileSync(doc.path, serializeXml(doc.file) + '\n', 'utf8')
}

/** 沿 parent 链累加几何偏移，得到单元的绝对左上角（swimlane 计入 startSize 标题高度） */
function absolutePos(root: XEl, entry: CellEntry): { x: number; y: number } {
  let x = num(entry.geometry?.attrs.x, 0)
  let y = num(entry.geometry?.attrs.y, 0)
  let pid = entry.parent
  const guard = new Set<string>([entry.id])
  while (pid && pid !== '1' && pid !== '0' && !guard.has(pid)) {
    guard.add(pid)
    const p = cellById(root, pid)
    if (!p) break
    if (p.kind === 'vertex' && p.geometry) {
      x += num(p.geometry.attrs.x, 0)
      y += num(p.geometry.attrs.y, 0)
      if (/swimlane/.test(p.style)) y += num(styleGet(p.style, 'startSize'), 30)
    }
    pid = p.parent
  }
  return { x, y }
}

/** 以某个父单元为原点时的偏移量（顶层与图层返回 0,0） */
function offsetOf(root: XEl, parentId: string): { x: number; y: number } {
  if (!parentId || parentId === '0' || parentId === '1') return { x: 0, y: 0 }
  const p = cellById(root, parentId)
  if (!p) return { x: 0, y: 0 }
  const base = absolutePos(root, p)
  if (p.kind === 'vertex' && /swimlane/.test(p.style)) base.y += num(styleGet(p.style, 'startSize'), 30)
  return base
}

/** 输出：人类可读文本 + 便于程序消费的 JSON 块 */
function out(text: string, data?: any): string {
  if (data === undefined) return text
  let json = ''
  try {
    json = JSON.stringify(data, null, 2)
  } catch {
    json = '"[unserializable]"'
  }
  return `${text}\n\n\`\`\`json\n${json}\n\`\`\``
}

function cellBrief(e: ReturnType<typeof cellEntries>[number]): Record<string, any> {
  const g = geomOf(e)
  const brief: Record<string, any> = {
    id: e.id,
    kind: e.kind,
    label: e.value,
  }
  if (e.kind === 'vertex') brief.geometry = { x: g.x, y: g.y, w: g.w, h: g.h }
  if (e.kind === 'edge') {
    brief.source = e.source
    brief.target = e.target
  }
  if (e.parent && e.parent !== '1') brief.parent = e.parent
  if (e.style) brief.style = e.style
  if (Object.keys(e.custom).length) brief.custom = e.custom
  return brief
}

function summarizeStyle(style: string): string {
  const keys = ['shape', 'fillColor', 'strokeColor', 'fontColor', 'fontSize', 'fontStyle', 'rounded', 'ellipse', 'rhombus', 'dashed', 'edgeStyle']
  const hits: string[] = []
  for (const k of keys) {
    const v = styleGet(style, k)
    if (v !== null && v !== '') hits.push(`${k}=${v}`)
  }
  if (styleGet(style, 'ellipse') === '') hits.push('ellipse')
  if (styleGet(style, 'rhombus') === '') hits.push('rhombus')
  if (styleGet(style, 'swimlane') === '') hits.push('swimlane')
  return hits.join(';')
}

// ---------------- 片段合并（与渲染端 AI 面板同一套三态协议） ----------------

function applyFragment(root: XEl, fragmentXml: string, allowEdit: boolean): { added: string[]; updated: string[]; removed: string[] } {
  const doc = parseXml(fragmentXml)
  if (!doc) throw new Error('片段不是合法 XML')
  const fragRoot = doc.name === 'root' ? doc : modelRoot(doc)
  if (!fragRoot) throw new Error('片段缺少 <root>')
  const existing = new Map(cellEntries(root, true).map((c) => [c.id, c]))
  const raw = fragRoot.children.filter((c) => c.name === 'mxCell' || c.name === 'object')
  const added: string[] = []
  const updated: string[] = []
  const removed: string[] = []

  // 先给「新 id」分配唯一 id
  const idMap = new Map<string, string>()
  for (const el of raw) {
    const cell = el.name === 'mxCell' ? el : findChild(el, 'mxCell')
    if (!cell) continue
    const id = el.attrs.id || cell.attrs.id || ''
    if (!id || id === '0' || id === '1') continue
    if (existing.has(id) || cell.attrs.remove === '1' || el.attrs.remove === '1') continue
    idMap.set(id, uniqueId(root, 'a'))
  }
  const resolve = (ref: string | undefined): string | undefined => {
    if (!ref) return undefined
    if (idMap.has(ref)) return idMap.get(ref)
    return existing.has(ref) ? ref : undefined
  }

  for (const el of raw) {
    const isObject = el.name !== 'mxCell'
    const cell = isObject ? findChild(el, 'mxCell') : el
    if (!cell) continue
    const id = el.attrs.id || cell.attrs.id || ''
    if (!id || id === '0' || id === '1') continue

    if (cell.attrs.remove === '1' || el.attrs.remove === '1') {
      if (!allowEdit) continue
      const found = existing.get(id)
      if (found && root.children.includes(found.holder)) {
        root.children = root.children.filter((c) => c !== found.holder)
        removed.push(id)
      }
      continue
    }

    if (existing.has(id)) {
      if (!allowEdit) continue
      const found = existing.get(id)!
      const target = found.cell
      const newGeom = findChild(cell, 'mxGeometry')
      const oldGeom = found.geometry
      const oldPos = geomOf(found)
      for (const [k, v] of Object.entries(cell.attrs)) {
        if (k === 'remove' || k === 'front' || k === 'back' || k === 'id') continue
        // 更新已有单元时忽略 parent：否则模型随手写 parent="1" 会把容器/图层里的子单元拉回顶层。
        // 需要改父级请用 drawio_set_parent。
        if (k === 'parent') continue
        if (k === 'source' || k === 'target') {
          const r = resolve(v)
          if (r) target.attrs[k] = r
          continue
        }
        target.attrs[k] = v
      }
      if (newGeom) {
        target.children = target.children.filter((c) => c.name !== 'mxGeometry' && c.name !== 'geometry')
        target.children.push(newGeom)
      } else if (oldGeom) {
        // 保留原几何
      }
      if (target.attrs.vertex === '1') {
        const g = ensureGeometry(target)
        if (!newGeom?.attrs.x) g.attrs.x = String(oldPos.x)
        if (!newGeom?.attrs.y) g.attrs.y = String(oldPos.y)
        if (!newGeom?.attrs.width) g.attrs.width = String(oldPos.w)
        if (!newGeom?.attrs.height) g.attrs.height = String(oldPos.h)
      }
      if (el.attrs.front === '1' || cell.attrs.front === '1') {
        root.children = root.children.filter((c) => c !== found.holder)
        root.children.push(found.holder)
      } else if (el.attrs.back === '1' || cell.attrs.back === '1') {
        root.children = root.children.filter((c) => c !== found.holder)
        root.children.splice(2, 0, found.holder)
      }
      updated.push(id)
      continue
    }

    // 新增
    const imported = JSON.parse(JSON.stringify(cell)) as XEl
    const newId = idMap.get(id) || uniqueId(root, 'a')
    imported.attrs.id = newId
    delete imported.attrs.remove
    delete imported.attrs.front
    delete imported.attrs.back
    if (imported.attrs.parent) imported.attrs.parent = resolve(imported.attrs.parent) || '1'
    if (imported.attrs.edge === '1') {
      const s = resolve(imported.attrs.source)
      const t = resolve(imported.attrs.target)
      if (!s || !t) continue
      imported.attrs.source = s
      imported.attrs.target = t
      ensureGeometry(imported)
    } else {
      normalizeGeom(imported)
    }
    root.children.push(imported)
    added.push(newId)
  }
  return { added, updated, removed }
}

// ---------------- 工具定义 ----------------

const S = (type: string, desc = '', enumVals?: string[]) => (enumVals ? { type, description: desc, enum: enumVals } : { type, description: desc })
const PATH_ARG = S('string', '目标 .drawio 文件的绝对路径（支持 .drawio / .dio / .xml）')

export function toolDefinitions(): any[] {
  const tools: any[] = [
    {
      name: 'drawio_create',
      description:
        '新建一个 .drawio 文件（含一张空白页）。文件已存在时报错，除非 force=true。中文别名：创建 drawio 文件。',
      inputSchema: {
        type: 'object',
        properties: { path: PATH_ARG, pageName: S('string', '首页名，默认 Page-1'), force: S('boolean', '已存在时覆盖') },
        required: ['path'],
      },
    },
    {
      name: 'drawio_read_document',
      description:
        '读取 .drawio 文件概览：所有页（序号/id/名称/是否压缩/单元数/页面尺寸）。includeXml=true 时同时返回整份 XML。',
      inputSchema: {
        type: 'object',
        properties: { path: PATH_ARG, includeXml: S('boolean', '是否附上完整 XML（文件很大时慎用）') },
        required: ['path'],
      },
    },
    {
      name: 'drawio_list_pages',
      description: '列出所有页（序号、id、名称、压缩状态、单元数、页面尺寸）。中文别名：页面列表。',
      inputSchema: { type: 'object', properties: { path: PATH_ARG }, required: ['path'] },
    },
    {
      name: 'drawio_get_page',
      description: '取某页的 mxGraphModel XML 原文（压缩页自动解压，解压失败会报错）。page 可用序号/名称/id，缺省第 1 页。',
      inputSchema: {
        type: 'object',
        properties: { path: PATH_ARG, page: S('string', '页序号(0 起)/名称/id，缺省 0'), raw: S('boolean', 'true=返回原始压缩文本（不写回，仅查看）') },
        required: ['path'],
      },
    },
    {
      name: 'drawio_set_page',
      description: '用给定的 mxGraphModel/root XML 整体替换某页内容（其它页不动）。中文别名：覆盖页面内容。',
      inputSchema: {
        type: 'object',
        properties: { path: PATH_ARG, page: S('string', '页序号/名称/id'), content: S('string', 'mxGraphModel 或 root 或 mxfile XML') },
        required: ['path', 'content'],
      },
    },
    {
      name: 'drawio_add_page',
      description: '新增一页（可带 mxGraphModel 内容或在指定位置插入）。中文别名：加页。',
      inputSchema: {
        type: 'object',
        properties: { path: PATH_ARG, name: S('string', '页名'), content: S('string', '可选 mxGraphModel XML'), index: S('number', '插入位置，缺省追加到末尾') },
        required: ['path'],
      },
    },
    {
      name: 'drawio_rename_page',
      description: '重命名某页（或改页 id）。',
      inputSchema: { type: 'object', properties: { path: PATH_ARG, page: S('string', '页序号/名称/id'), name: S('string', '新名称'), id: S('string', '可选新 id') }, required: ['path', 'name'] },
    },
    {
      name: 'drawio_delete_page',
      description: '删除某页（最后一页不允许删除）。',
      inputSchema: { type: 'object', properties: { path: PATH_ARG, page: S('string', '页序号/名称/id') }, required: ['path', 'page'] },
    },

    {
      name: 'drawio_list_cells',
      description:
        '列出某页的单元：id / 类型(vertex|edge|layer) / 文本 / 位置尺寸 / 连线端点 / parent / style 摘要 / tags。支持 kind、query、limit 过滤。理解现有图的首选工具。',
      inputSchema: {
        type: 'object',
        properties: {
          path: PATH_ARG,
          page: S('string', '页序号/名称/id'),
          kind: S('string', '只看某类', ['vertex', 'edge', 'layer', 'other']),
          query: S('string', '模糊匹配 id 或文本'),
          limit: S('number', '最多返回条数，默认 100'),
          withStyle: S('boolean', '是否附上完整 style（默认给摘要）'),
        },
        required: ['path'],
      },
    },
    {
      name: 'drawio_get_cell',
      description: '取单个单元的完整 XML 与解析后的字段（含 geometry、style、tags/metadata）。',
      inputSchema: { type: 'object', properties: { path: PATH_ARG, page: S('string', '页'), id: S('string', '单元 id') }, required: ['path', 'id'] },
    },
    {
      name: 'drawio_search_cells',
      description: '按文本/样式关键字搜索单元（等同 list_cells 的 query，但会同时搜 style 与标签）。',
      inputSchema: { type: 'object', properties: { path: PATH_ARG, page: S('string', '页'), query: S('string', '关键字'), limit: S('number', '默认 50') }, required: ['path', 'query'] },
    },
    {
      name: 'drawio_outline',
      description: '输出图表结构摘要：节点清单（按层）+ 连线关系 + 容器层级，便于快速理解。中文别名：图结构概览。',
      inputSchema: { type: 'object', properties: { path: PATH_ARG, page: S('string', '页') }, required: ['path'] },
    },
    {
      name: 'drawio_stats',
      description: '统计形状与连线：形状种类（矩形/菱形/椭圆/圆柱…）、连线数、孤立节点、跨容器连线、最大层数。',
      inputSchema: { type: 'object', properties: { path: PATH_ARG, page: S('string', '页') }, required: ['path'] },
    },
    {
      name: 'drawio_validate',
      description:
        '校验文件：XML 是否可解析、id 是否重复、连线 source/target 是否悬空、顶点是否缺几何/零尺寸、坐标是否非 10 倍数、是否存在 XML 注释。返回问题清单。',
      inputSchema: { type: 'object', properties: { path: PATH_ARG, page: S('string', '页') }, required: ['path'] },
    },

    {
      name: 'drawio_add_node',
      description:
        '新增一个图形（顶点）。style 可直接给完整片段，也可用 shape(rect|rounded|ellipse|rhombus|cylinder|document|hexagon|cloud|note|text|swimlane|group…)+color(blue|green|orange|red|purple|yellow|gray) 让服务拼装。返回新 id。',
      inputSchema: {
        type: 'object',
        properties: {
          path: PATH_ARG,
          page: S('string', '页'),
          label: S('string', '文本（支持 &lt;br&gt; 换行，会按需转义）'),
          x: S('number', 'x'), y: S('number', 'y'), width: S('number', '宽，默认 140'), height: S('number', '高，默认 60'),
          style: S('string', '完整 style（给了就优先用它，忽略 shape/color）'),
          shape: S('string', '形状关键字或完整形状片段'),
          color: S('string', '配色名或色号（如 blue / #dae8fc）'),
          fillColor: S('string', '填充色'), strokeColor: S('string', '描边色'), fontColor: S('string', '文字色'),
          fontSize: S('number', '字号'), fontStyle: S('number', '1粗 2斜 4下划线（可相加）'),
          parent: S('string', '父容器 id（做嵌套时用，坐标相对父；默认 1）'),
          tags: S('string', '标签（空格分隔，会生成 <object> 包裹）'),
        },
        required: ['path'],
      },
    },
    {
      name: 'drawio_add_nodes',
      description: '批量新增图形：nodes 为对象数组，字段同 drawio_add_node。适合一次画多个节点。',
      inputSchema: { type: 'object', properties: { path: PATH_ARG, page: S('string', '页'), nodes: S('array', '节点数组') }, required: ['path', 'nodes'] },
    },
    {
      name: 'drawio_add_edge',
      description:
        '新增一条连线。默认样式 edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=classic;；可加 label、虚线 dashed、双向、无箭头、曲线、出入口(exitX/exitY/entryX/entryY)、样式(orthogonal|straight|er|curved|dashed|plain)。返回新 id。',
      inputSchema: {
        type: 'object',
        properties: {
          path: PATH_ARG, page: S('string', '页'),
          source: S('string', '起点单元 id'), target: S('string', '终点单元 id'),
          label: S('string', '连线文字'),
          style: S('string', '完整 style'), variant: S('string', '预设：orthogonal|straight|er|curved|dashed|plain'),
          dashed: S('boolean', '虚线'), strokeColor: S('string', '线色'), strokeWidth: S('number', '线宽'),
          startArrow: S('string', '起点箭头（classic/none/open…）'), endArrow: S('string', '终点箭头'),
          exitX: S('number'), exitY: S('number'), entryX: S('number'), entryY: S('number'),
          parent: S('string', '父级，默认 1（跨容器连线必须留在 1）'),
        },
        required: ['path', 'source', 'target'],
      },
    },
    {
      name: 'drawio_update_cell',
      description:
        '修改已有单元：文本(label)、style 合并(style) 或整段替换(styleFull)、位置尺寸(x/y/width/height)、parent、source/target（改接连线）。只改传入的字段，其余保持原样。',
      inputSchema: {
        type: 'object',
        properties: {
          path: PATH_ARG, page: S('string', '页'), id: S('string', '单元 id'),
          label: S('string', '新文本'), style: S('string', '要合并的样式片段（k=v; 形式）'), styleFull: S('string', '整段替换 style'),
          x: S('number'), y: S('number'), width: S('number'), height: S('number'),
          parent: S('string', '新 parent'), source: S('string'), target: S('string'),
          idNew: S('string', '同时改 id（会同步改写引用它的连线）'),
        },
        required: ['path', 'id'],
      },
    },
    {
      name: 'drawio_move_cell',
      description: '移动单元：给 x/y 绝对值，或给 dx/dy 相对位移。',
      inputSchema: { type: 'object', properties: { path: PATH_ARG, page: S('string', '页'), id: S('string', '单元 id'), x: S('number'), y: S('number'), dx: S('number'), dy: S('number') }, required: ['path', 'id'] },
    },
    {
      name: 'drawio_resize_cell',
      description: '调整单元尺寸：给 width/height，或给 scale 等比缩放（相对当前尺寸）。',
      inputSchema: { type: 'object', properties: { path: PATH_ARG, page: S('string', '页'), id: S('string', '单元 id'), width: S('number'), height: S('number'), scale: S('number', '等比缩放系数，如 1.5') }, required: ['path', 'id'] },
    },
    {
      name: 'drawio_set_style',
      description: '设置/删除样式属性：style 传 "fillColor=#ff6633;fontSize=16;"；删属性传值空串（如 "rotation="）。也支持 keys 数组+values 对象形式。',
      inputSchema: {
        type: 'object',
        properties: { path: PATH_ARG, page: S('string', '页'), id: S('string', '单元 id'), style: S('string', 'k=v; 片段（值空=删除该属性）'), replace: S('boolean', 'true=整段替换而不是合并') },
        required: ['path', 'id'],
      },
    },
    {
      name: 'drawio_set_label',
      description: '设置单元文本（顶点=value，连线=value，容器=value）。html=true（默认）会自动补 html=1 并支持 &lt;br&gt;。',
      inputSchema: { type: 'object', properties: { path: PATH_ARG, page: S('string', '页'), id: S('string', '单元 id'), label: S('string', '文本'), fontSize: S('number'), fontStyle: S('number'), fontColor: S('string'), align: S('string') }, required: ['path', 'id', 'label'] },
    },
    {
      name: 'drawio_delete_cell',
      description: '删除单元。withEdges=true（默认）时一并删掉连在它身上的连线。',
      inputSchema: { type: 'object', properties: { path: PATH_ARG, page: S('string', '页'), id: S('string', '单元 id'), withEdges: S('boolean', '默认 true') }, required: ['path', 'id'] },
    },
    {
      name: 'drawio_duplicate_cell',
      description: '复制单元（顶点会连带其内部子单元与内部连线）。dx/dy 控制副本偏移。',
      inputSchema: { type: 'object', properties: { path: PATH_ARG, page: S('string', '页'), id: S('string', '单元 id'), dx: S('number', '默认 40'), dy: S('number', '默认 40'), deep: S('boolean', '默认 true') }, required: ['path', 'id'] },
    },
    {
      name: 'drawio_connect',
      description: '在两个单元之间建立连线（已存在同向连线时只更新其文字/样式）。',
      inputSchema: { type: 'object', properties: { path: PATH_ARG, page: S('string', '页'), source: S('string'), target: S('string'), label: S('string'), style: S('string'), variant: S('string') }, required: ['path', 'source', 'target'] },
    },
    {
      name: 'drawio_set_z_order',
      description: '调整层级：front 置顶 / back 置底 / forward 上移一层 / backward 下移一层（可传多个 id）。',
      inputSchema: { type: 'object', properties: { path: PATH_ARG, page: S('string', '页'), id: S('string', '单元 id 或 id 列表'), action: S('string', 'front|back|forward|backward', ['front', 'back', 'forward', 'backward']) }, required: ['path', 'action'] },
    },
    {
      name: 'drawio_apply_fragment',
      description:
        '把 LLM 生成的 mxGraphModel 片段应用到页面（推荐给智能体用）：新 id=新增；既有 id=按给出字段更新；<mxCell id="X" remove="1"/>=删除；front/back 调整层级。allowEdit=false 时只新增不改不删。',
      inputSchema: {
        type: 'object',
        properties: { path: PATH_ARG, page: S('string', '页'), fragment: S('string', 'mxGraphModel 或 <root> 或一串 mxCell'), allowEdit: S('boolean', '允许改/删已有单元，默认 true') },
        required: ['path', 'fragment'],
      },
    },
    {
      name: 'drawio_set_parent',
      description:
        '改变单元的父级（把单元移入容器/泳道/组，移出到顶层用 parent="1"，移入图层用图层 id）。默认保持屏幕上的绝对位置（自动换算相对坐标），keepAbsolute=false 则保留原相对坐标。',
      inputSchema: {
        type: 'object',
        properties: {
          path: PATH_ARG, page: S('string', '页'),
          id: S('string', '单元 id 或 id 列表'),
          parent: S('string', '新父级 id（容器/组/图层 id，顶层为 "1"）'),
          keepAbsolute: S('boolean', '默认 true：视觉位置不变'),
        },
        required: ['path', 'id', 'parent'],
      },
    },

    {
      name: 'drawio_add_container',
      description: '新增容器：type=swimlane（带标题）/group（不可见）/custom（任意形状当容器）。adopt 传入要移入容器的单元 id 列表（坐标自动转成相对坐标）。',
      inputSchema: {
        type: 'object',
        properties: {
          path: PATH_ARG, page: S('string', '页'), label: S('string', '容器标题'),
          type: S('string', 'swimlane|group|custom', ['swimlane', 'group', 'custom']),
          x: S('number'), y: S('number'), width: S('number'), height: S('number'),
          style: S('string', 'custom/额外样式'), color: S('string', '配色'), adopt: S('string', '要移入的单元 id（逗号/空格分隔）'),
        },
        required: ['path'],
      },
    },
    {
      name: 'drawio_add_layer',
      description: '新增图层（parent=0 的 mxCell）。assign 传入要放进该层的单元 id；visible=false 表示默认隐藏。',
      inputSchema: { type: 'object', properties: { path: PATH_ARG, page: S('string', '页'), name: S('string', '图层名'), assign: S('string', '单元 id 列表'), visible: S('boolean', '默认 true') }, required: ['path', 'name'] },
    },
    {
      name: 'drawio_set_tags',
      description: '给单元设置标签（空格分隔，生成/更新 <object> 包裹）。tags 传空则移除标签包裹。',
      inputSchema: { type: 'object', properties: { path: PATH_ARG, page: S('string', '页'), id: S('string', '单元 id'), tags: S('string', '空格分隔的标签') }, required: ['path', 'id'] },
    },
    {
      name: 'drawio_set_metadata',
      description: '给单元设置自定义属性（<object> 包裹上的 k=v），可开 placeholders=true 让 label 里的 %key% 生效；mode=merge|replace。',
      inputSchema: {
        type: 'object',
        properties: { path: PATH_ARG, page: S('string', '页'), id: S('string', '单元 id'), properties: S('object', '键值对'), placeholders: S('boolean'), mode: S('string', 'merge|replace', ['merge', 'replace']) },
        required: ['path', 'id', 'properties'],
      },
    },

    {
      name: 'drawio_auto_layout',
      description:
        '按连线方向做分层自动布局（拓扑分层后按行/列排布，连通组件自然分层）。direction=vertical|horizontal；可给 nodeWidth/Height/colGap/rowGap/startX/startY。',
      inputSchema: {
        type: 'object',
        properties: { path: PATH_ARG, page: S('string', '页'), direction: S('string', 'vertical|horizontal', ['vertical', 'horizontal']), nodeWidth: S('number'), nodeHeight: S('number'), colGap: S('number'), rowGap: S('number'), startX: S('number'), startY: S('number') },
        required: ['path'],
      },
    },
    {
      name: 'drawio_grid_layout',
      description: '按固定列数平铺所有节点（同级节点很多、没有明显方向时用）。',
      inputSchema: { type: 'object', properties: { path: PATH_ARG, page: S('string', '页'), columns: S('number', '默认 4'), nodeWidth: S('number'), nodeHeight: S('number'), colGap: S('number'), rowGap: S('number') }, required: ['path'] },
    },
    {
      name: 'drawio_align',
      description: '把一组单元对齐：mode=left|right|center|top|bottom|middle（以这组单元的整体包围盒为基准）。',
      inputSchema: { type: 'object', properties: { path: PATH_ARG, page: S('string', '页'), ids: S('string', '单元 id 列表'), mode: S('string', 'left|right|center|top|bottom|middle', ['left', 'right', 'center', 'top', 'bottom', 'middle']) }, required: ['path', 'ids', 'mode'] },
    },
    {
      name: 'drawio_distribute',
      description: '把一组单元等距分布：axis=h（水平）|v（垂直），gap 不给则自动均分。',
      inputSchema: { type: 'object', properties: { path: PATH_ARG, page: S('string', '页'), ids: S('string', '单元 id 列表'), axis: S('string', 'h|v', ['h', 'v']), gap: S('number', '固定间距') }, required: ['path', 'ids'] },
    },
    {
      name: 'drawio_fit_page',
      description: '把页面尺寸（pageWidth/pageHeight）调整为刚好容纳全部内容（可选 pad）。',
      inputSchema: { type: 'object', properties: { path: PATH_ARG, page: S('string', '页'), pad: S('number', '留白，默认 40') }, required: ['path'] },
    },
    {
      name: 'drawio_translate_all',
      description: '整体平移某页所有顶层节点（dx/dy）。',
      inputSchema: { type: 'object', properties: { path: PATH_ARG, page: S('string', '页'), dx: S('number'), dy: S('number') }, required: ['path'] },
    },

    {
      name: 'drawio_import_mermaid',
      description: '把 Mermaid 流程图（flowchart/graph 子集：节点、带标签的边、虚线）转换为 drawio。mode=newFile 建新文件 / newPage 追加一页 / intoPage 合并进现有页。',
      inputSchema: {
        type: 'object',
        properties: { path: PATH_ARG, page: S('string', '页'), mermaid: S('string', 'Mermaid 文本'), name: S('string', '新页/文件名'), mode: S('string', 'newFile|newPage|intoPage', ['newFile', 'newPage', 'intoPage']), layout: S('boolean', '转换后做分层布局，默认 true') },
        required: ['path', 'mermaid'],
      },
    },
    {
      name: 'drawio_export_mermaid',
      description: '把某页导出为 Mermaid 文本（顶点+连线+标签）。writeTo 给了就顺带写文件（.md/.mmd）。',
      inputSchema: { type: 'object', properties: { path: PATH_ARG, page: S('string', '页'), writeTo: S('string', '可选输出文件路径'), direction: S('string', 'vertical|horizontal', ['vertical', 'horizontal']) }, required: ['path'] },
    },
    {
      name: 'drawio_import_csv',
      description: 'CSV 转 drawio：mode=table（表格网格）或 org（每行是一条层级路径 A,B,C → 树）。',
      inputSchema: { type: 'object', properties: { path: PATH_ARG, csv: S('string', 'CSV 文本'), mode: S('string', 'table|org', ['table', 'org']), page: S('string', '页（intoPage 用）'), title: S('string', '页名'), intoPage: S('boolean', 'true=合并进现有页，否则覆盖/新建') }, required: ['path', 'csv'] },
    },
    {
      name: 'drawio_export_svg',
      description: '把某页导出为 SVG（基础形状/菱形/椭圆/连线/文本的尽力而为渲染）。writeTo 给了就写文件，否则返回 SVG 文本。',
      inputSchema: { type: 'object', properties: { path: PATH_ARG, page: S('string', '页'), writeTo: S('string', '输出 .svg 路径') }, required: ['path'] },
    },

    {
      name: 'drawio_search_shapes',
      description: '检索形状/样式片段（矩形、菱形、圆柱、文档、云、便签、泳道、容器、UML、ER 连线、虚线/曲线…），返回可直接粘进 style 的字符串与配色对。生成前先查，避免瞎编 style。',
      inputSchema: { type: 'object', properties: { query: S('string', '关键词（中英均可，如 菱形 / database / 泳道）'), limit: S('number', '默认 10，最大 50') }, required: ['query'] },
    },
    {
      name: 'drawio_style_help',
      description: '返回 drawio 样式/结构速查：常用 style 属性、6 对标准配色、容器与泳道、图层、标签与元数据、暗色模式(light-dark)、连线风格选择、XML 硬约束（换行用 &#xa;、边必须有 mxGeometry、禁止注释、html=1 等）。',
      inputSchema: { type: 'object', properties: { section: S('string', '可选：styles|colors|containers|layers|tags|dark|edges|wellformed') } },
    },
  ]
  return tools
}

// ---------------- 工具执行 ----------------

function buildStyle(a: Record<string, any>, fallback = 'rounded=1;whiteSpace=wrap;html=1;'): string {
  const full = arg(a, ['style'])
  if (full) return String(full)
  const shape = String(arg(a, ['shape']) || '').trim()
  let style = fallback
  if (shape) {
    const preset: Record<string, string> = {
      rect: 'rounded=0;whiteSpace=wrap;html=1;',
      rectangle: 'rounded=0;whiteSpace=wrap;html=1;',
      rounded: 'rounded=1;whiteSpace=wrap;html=1;',
      ellipse: 'ellipse;whiteSpace=wrap;html=1;',
      circle: 'ellipse;whiteSpace=wrap;html=1;',
      rhombus: 'rhombus;whiteSpace=wrap;html=1;',
      diamond: 'rhombus;whiteSpace=wrap;html=1;',
      cylinder: 'shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;',
      database: 'shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;',
      document: 'shape=mxgraph.flowchart.document;whiteSpace=wrap;html=1;',
      hexagon: 'shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;',
      cloud: 'shape=cloud;whiteSpace=wrap;html=1;',
      note: 'shape=note;whiteSpace=wrap;html=1;size=14;',
      text: 'text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;',
      swimlane: 'swimlane;startSize=30;html=1;',
      group: 'group;',
    }
    style = preset[shape.toLowerCase()] || (shape.includes('=') ? shape : `shape=${shape};whiteSpace=wrap;html=1;`)
  }
  const color = String(arg(a, ['color']) || '').trim()
  if (color) {
    const pair = COLOR_PAIRS.find((c) => c.fill.toLowerCase() === color.toLowerCase() || c.zh === color || c.en === color)
    if (pair) {
      style = styleSet(style, 'fillColor', pair.fill)
      style = styleSet(style, 'strokeColor', pair.stroke)
    } else if (/^#?[0-9a-f]{6}$/i.test(color)) {
      style = styleSet(style, 'fillColor', color.startsWith('#') ? color : `#${color}`)
    }
  }
  for (const k of ['fillColor', 'strokeColor', 'fontColor'] as const) {
    const v = arg(a, [k])
    if (v) style = styleSet(style, k, String(v))
  }
  const fs = arg(a, ['fontSize'])
  if (fs !== undefined) style = styleSet(style, 'fontSize', String(fs))
  const fst = arg(a, ['fontStyle'])
  if (fst !== undefined) style = styleSet(style, 'fontStyle', String(fst))
  const align = arg(a, ['align'])
  if (align) style = styleSet(style, 'align', String(align))
  return style
}

function edgeStyleFor(a: Record<string, any>): string {
  const full = arg(a, ['style'])
  if (full) return String(full)
  const variant = String(arg(a, ['variant']) || 'orthogonal').toLowerCase()
  const presets: Record<string, string> = {
    orthogonal: 'edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=classic;',
    straight: 'html=1;endArrow=classic;',
    er: 'edgeStyle=entityRelationEdgeStyle;html=1;endArrow=ERone;startArrow=ERmany;',
    curved: 'curved=1;html=1;endArrow=classic;',
    dashed: 'edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=classic;dashed=1;dashPattern=8 8;',
    plain: 'html=1;endArrow=none;startArrow=none;',
  }
  let style = presets[variant] || presets.orthogonal
  if (arg(a, ['dashed']) === true) {
    style = styleSet(style, 'dashed', '1')
    style = styleSet(style, 'dashPattern', '8 8')
  }
  for (const [key, names] of [
    ['strokeColor', ['strokeColor']],
    ['strokeWidth', ['strokeWidth']],
    ['startArrow', ['startArrow']],
    ['endArrow', ['endArrow']],
    ['exitX', ['exitX']],
    ['exitY', ['exitY']],
    ['entryX', ['entryX']],
    ['entryY', ['entryY']],
  ] as Array<[string, string[]]>) {
    const v = arg(a, names)
    if (v !== undefined && v !== null && v !== '') style = styleSet(style, key, String(v))
  }
  return style
}

function wantedEntries(root: XEl, ids: string[]) {
  const all = cellEntries(root)
  return all.filter((e) => ids.includes(e.id))
}

export async function executeTool(name: string, args: Record<string, any> = {}): Promise<string> {
  const a = args || {}
  switch (name) {
    // ---------- 文档 / 页面 ----------
    case 'drawio_create': {
      const abs = resolveDocPath(a)
      if (fs.existsSync(abs) && arg(a, ['force']) !== true) throw new Error(`文件已存在（要覆盖请传 force=true）：${abs}`)
      const name0 = String(arg(a, ['pageName']) || 'Page-1')
      const file = createEl('mxfile', { host: 'app.diagrams.net' })
      const pageEl = newPageEl('page1', name0, emptyModelXml())
      file.children.push(pageEl)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, serializeXml(file) + '\n', 'utf8')
      return out(`已创建 ${abs}（第 1 页：${name0}）`, { path: abs, page: name0 })
    }
    case 'drawio_read_document':
    case 'drawio_list_pages': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const list = doc.pages.map((p) => ({
        index: p.index,
        id: p.id,
        name: p.name,
        compressed: p.compressed,
        cells: p.model ? cellEntries(modelRoot(p.model)).length : null,
        pageSize: p.model ? { width: num(p.model.attrs.pageWidth, 850), height: num(p.model.attrs.pageHeight, 1100) } : null,
      }))
      const lines = list.map((p) => `- [${p.index}] "${p.name}" (id=${p.id}) 单元 ${p.cells ?? '?'} 个${p.compressed ? ' · 压缩存储' : ''}`)
      const payload: any = { path: abs, pages: list }
      if (name === 'drawio_read_document' && arg(a, ['includeXml']) === true) payload.xml = serializeXml(doc.file)
      return out(`${abs} 共 ${list.length} 页：\n${lines.join('\n')}`, payload)
    }
    case 'drawio_get_page': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const page = requirePage(doc, a)
      if (arg(a, ['raw']) === true) {
        return out(`第 ${page.index} 页 "${page.name}"${page.compressed ? '（压缩存储）' : ''}：`, { page: page.name, raw: page.compressed ? page.el.text.trim() : null, xml: page.compressed ? null : serializeXml(page.model || page.el) })
      }
      if (!page.model) throw new Error('该页内容不是 mxGraphModel（可能不是 drawio 图表）')
      return out(`第 ${page.index} 页 "${page.name}" 的 mxGraphModel：\n\n\`\`\`xml\n${serializeXml(page.model)}\n\`\`\``, { page: page.name, cells: cellEntries(modelRoot(page.model)).length })
    }
    case 'drawio_set_page': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const page = requirePage(doc, a)
      const content = String(arg(a, ['content', 'xml']) || '')
      const parsed = parseXml(content)
      if (!parsed) throw new Error('content 不是合法 XML')
      const modelXml = parsed.name === 'mxGraphModel' ? serializeXml(parsed) : (modelRoot(parsed) ? serializeXml(parsed.name === 'root' ? wrapRoot(parsed) : parsed) : '')
      if (!modelXml) throw new Error('content 里没有找到 mxGraphModel/root')
      setPageModel(page, modelXml)
      saveDoc(doc)
      return out(`已替换第 ${page.index} 页 "${page.name}" 的内容（${cellEntries(modelRoot(page.model)).length} 个单元）`, { page: page.name })
    }
    case 'drawio_add_page': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const name = String(arg(a, ['name']) || `Page-${doc.pages.length + 1}`)
      const content = String(arg(a, ['content']) || emptyModelXml())
      const id = uniquePageId(doc, name)
      const el = newPageEl(id, name, content)
      const idx = Number(arg(a, ['index']))
      if (Number.isInteger(idx) && idx >= 0 && idx <= doc.file.children.filter((c) => c.name === 'diagram').length) {
        const diagrams = doc.file.children.filter((c) => c.name === 'diagram')
        const anchor = diagrams[idx]
        doc.file.children.splice(doc.file.children.indexOf(anchor), 0, el)
      } else {
        doc.file.children.push(el)
      }
      saveDoc(doc)
      return out(`已新增第 ${doc.pages.length + 1} 页 "${name}"`, { page: name, id })
    }
    case 'drawio_rename_page': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const page = requirePage(doc, a)
      const old = page.name
      page.el.attrs.name = String(arg(a, ['name']))
      const newId = arg(a, ['id'])
      if (newId) page.el.attrs.id = String(newId)
      saveDoc(doc)
      return out(`已把页 "${old}" 重命名为 "${page.el.attrs.name}"`, { name: page.el.attrs.name })
    }
    case 'drawio_delete_page': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      if (doc.pages.length <= 1) throw new Error('只剩一页，不能删除')
      const page = requirePage(doc, a)
      doc.file.children = doc.file.children.filter((c) => c !== page.el)
      saveDoc(doc)
      return out(`已删除第 ${page.index} 页 "${page.name}"，剩余 ${doc.pages.length - 1} 页`)
    }

    // ---------- 查看 / 检索 ----------
    case 'drawio_list_cells':
    case 'drawio_search_cells': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const root = requireRoot(doc, a)
      const kind = arg(a, ['kind'])
      const query = String(arg(a, ['query']) || '').toLowerCase()
      const limit = Math.max(1, Math.min(1000, fmtNum(arg(a, ['limit']), 100)))
      const withStyle = arg(a, ['withStyle']) === true
      let entries = cellEntries(root)
      if (kind) entries = entries.filter((e) => e.kind === kind)
      if (query) {
        entries = entries.filter(
          (e) =>
            e.id.toLowerCase().includes(query) ||
            e.value.toLowerCase().includes(query) ||
            e.style.toLowerCase().includes(query) ||
            (e.custom.tags || '').toLowerCase().includes(query),
        )
      }
      const total = entries.length
      const sliced = entries.slice(0, limit)
      const briefs = sliced.map((e) => {
        const b = cellBrief(e)
        if (!withStyle && typeof b.style === 'string') b.style = summarizeStyle(b.style)
        return b
      })
      const lines = briefs.map((b) => {
        if (b.kind === 'edge') return `- ${b.id} [连线] ${b.source}→${b.target}${b.label ? ` "${b.label}"` : ''}`
        if (b.kind === 'vertex') return `- ${b.id} [顶点] "${b.label}" (${b.geometry.x},${b.geometry.y}) ${b.geometry.w}x${b.geometry.h}${b.parent ? ` parent=${b.parent}` : ''}`
        return `- ${b.id} [${b.kind}] ${b.label ? `"${b.label}"` : ''}`
      })
      return out(`共 ${total} 个单元，返回 ${sliced.length} 个：\n${lines.join('\n')}`, { path: abs, total, cells: briefs })
    }
    case 'drawio_get_cell': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const root = requireRoot(doc, a)
      const id = String(arg(a, ['id']))
      const entry = cellById(root, id)
      if (!entry) throw new Error(`找不到单元 ${id}`)
      const g = geomOf(entry)
      return out(
        `单元 ${id}：\n\n\`\`\`xml\n${serializeXml(entry.holder)}\n\`\`\``,
        {
          id,
          kind: entry.kind,
          label: entry.value,
          geometry: entry.kind === 'vertex' ? { x: g.x, y: g.y, w: g.w, h: g.h } : undefined,
          source: entry.source || undefined,
          target: entry.target || undefined,
          parent: entry.parent,
          style: entry.style,
          custom: entry.custom,
        },
      )
    }
    case 'drawio_outline': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const root = requireRoot(doc, a)
      const entries = cellEntries(root)
      const byParent = new Map<string, typeof entries>()
      for (const e of entries.filter((x) => x.kind === 'vertex')) {
        const p = e.parent || '1'
        if (!byParent.has(p)) byParent.set(p, [])
        byParent.get(p)!.push(e)
      }
      const layers: string[] = []
      for (const [parent, list] of byParent) {
        const pname = parent === '1' ? '顶层' : `容器 ${parent}`
        layers.push(`【${pname}】${list.map((e) => `${e.id}"${e.value}"`).join('、')}`)
      }
      const edges = entries.filter((e) => e.kind === 'edge')
      const edgeLines = edges.map((e) => `${e.id}: ${e.source || '?'} → ${e.target || '?'}${e.value ? ` ("${e.value}")` : ''}`)
      const txt = [`节点（${entries.filter((e) => e.kind === 'vertex').length} 个）：`, ...layers, '', `连线（${edges.length} 条）：`, edgeLines.join('\n')].join('\n')
      return out(txt, { vertices: entries.filter((e) => e.kind === 'vertex').map((e) => ({ id: e.id, label: e.value, parent: e.parent })), edges: edgeLines })
    }
    case 'drawio_stats': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const root = requireRoot(doc, a)
      const entries = cellEntries(root)
      const vertices = entries.filter((e) => e.kind === 'vertex')
      const edges = entries.filter((e) => e.kind === 'edge')
      const shapeCount = new Map<string, number>()
      for (const v of vertices) {
        const st = v.style
        let kind = '矩形'
        const shapeHit = styleGet(st, 'shape')
        if (styleGet(st, 'ellipse') === '') kind = '椭圆'
        else if (styleGet(st, 'rhombus') === '') kind = '菱形'
        else if (styleGet(st, 'swimlane') === '') kind = '泳道/容器'
        else if (styleGet(st, 'group') === '') kind = '分组'
        else if (styleGet(st, 'text') === '') kind = '文本'
        else if (styleGet(st, 'rounded') === '1') kind = '圆角矩形'
        if (shapeHit) kind = shapeHit
        shapeCount.set(kind, (shapeCount.get(kind) || 0) + 1)
      }
      const linked = new Set<string>()
      for (const e of edges) {
        if (e.source) linked.add(e.source)
        if (e.target) linked.add(e.target)
      }
      const isolated = vertices.filter((v) => !linked.has(v.id)).map((v) => v.id)
      const crossContainer = edges.filter((e) => {
        const s = cellById(root, e.source)
        const t = cellById(root, e.target)
        return s && t && (s.parent || '1') !== (t.parent || '1')
      }).map((e) => e.id)
      return out(
        [
          `顶点 ${vertices.length} 个，连线 ${edges.length} 条`,
          `形状分布：${Array.from(shapeCount.entries()).map(([k, v]) => `${k}×${v}`).join('、') || '无'}`,
          `孤立顶点（无连线）：${isolated.length ? isolated.join(', ') : '无'}`,
          `跨容器连线：${crossContainer.length ? crossContainer.join(', ') : '无'}`,
        ].join('\n'),
        { vertices: vertices.length, edges: edges.length, shapes: Object.fromEntries(shapeCount), isolated, crossContainer },
      )
    }
    case 'drawio_validate': {
      const abs = resolveDocPath(a)
      const raw = fs.readFileSync(abs, 'utf8')
      const doc = loadDoc(abs)
      const root = requireRoot(doc, a)
      const entries = cellEntries(root, true)
      const issues: string[] = []
      if (/<!--/.test(raw)) issues.push('存在 XML 注释（drawio 会忽略，但官方建议生成时不要写注释）')
      const seen = new Set<string>()
      for (const e of entries) {
        if (!e.id) issues.push('存在没有 id 的单元')
        if (seen.has(e.id)) issues.push(`id 重复：${e.id}`)
        seen.add(e.id)
      }
      for (const e of entries.filter((x) => x.kind === 'edge')) {
        if (!e.source || !e.target) issues.push(`连线 ${e.id} 缺少 source/target（自闭合或半截连线）`)
        else {
          if (!cellById(root, e.source)) issues.push(`连线 ${e.id} 的 source=${e.source} 不存在（悬空引用）`)
          if (!cellById(root, e.target)) issues.push(`连线 ${e.id} 的 target=${e.target} 不存在（悬空引用）`)
        }
        if (!findChild(e.cell, 'mxGeometry')) issues.push(`连线 ${e.id} 缺少 <mxGeometry relative="1" as="geometry"/>（必须展开写）`)
      }
      for (const e of entries.filter((x) => x.kind === 'vertex')) {
        const g = e.geometry
        if (!g) issues.push(`顶点 ${e.id} 缺少 mxGeometry`)
        else {
          if (!Number.isFinite(Number(g.attrs.x)) || !Number.isFinite(Number(g.attrs.y))) issues.push(`顶点 ${e.id} 的 x/y 不是数字`)
          if (num(g.attrs.width, 0) < 5 || num(g.attrs.height, 0) < 5) issues.push(`顶点 ${e.id} 尺寸异常（${g.attrs.width}×${g.attrs.height}）`)
          const xs = [g.attrs.x, g.attrs.y, g.attrs.width, g.attrs.height].map((v) => Number(v)).filter((n) => Number.isFinite(n))
          if (xs.some((n) => n % 10 !== 0)) issues.push(`顶点 ${e.id} 坐标/尺寸不是 10 的倍数（不影响渲染，但对齐更整齐）`)
        }
      }
      return out(issues.length ? `发现 ${issues.length} 个问题：\n${issues.map((s) => `- ${s}`).join('\n')}` : '校验通过：未发现问题', { ok: issues.length === 0, issues })
    }

    // ---------- 编辑 ----------
    case 'drawio_add_node': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const root = requireRoot(doc, a)
      const id = String(arg(a, ['id']) || uniqueId(root, 'n'))
      const style = buildStyle(a, 'rounded=1;whiteSpace=wrap;html=1;')
      const vertex = makeVertex(
        id,
        String(arg(a, ['label']) || ''),
        fmtNum(arg(a, ['x']), 40),
        fmtNum(arg(a, ['y']), 40),
        fmtNum(arg(a, ['width']), 140),
        fmtNum(arg(a, ['height']), 60),
        style,
        String(arg(a, ['parent']) || '1'),
      )
      normalizeGeom(vertex)
      const tags = String(arg(a, ['tags']) || '').trim()
      if (tags) {
        const wrap = createEl('object', { id, label: escapeAttr(String(arg(a, ['label']) || '')), tags })
        delete vertex.attrs.id
        delete vertex.attrs.value
        wrap.children.push(vertex)
        root.children.push(wrap)
      } else {
        root.children.push(vertex)
      }
      saveDoc(doc)
      return out(`已新增顶点 ${id}${tags ? `（tags: ${tags}）` : ''}`, { id, style })
    }
    case 'drawio_add_nodes': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const root = requireRoot(doc, a)
      const nodes = Array.isArray(a.nodes) ? a.nodes : []
      if (!nodes.length) throw new Error('nodes 为空')
      const ids: string[] = []
      for (const n of nodes) {
        const id = String(n.id || uniqueId(root, 'n'))
        const style = buildStyle(n, 'rounded=1;whiteSpace=wrap;html=1;')
        const vertex = makeVertex(id, String(n.label || ''), fmtNum(n.x, 40), fmtNum(n.y, 40), fmtNum(n.width, 140), fmtNum(n.height, 60), style, String(n.parent || '1'))
        normalizeGeom(vertex)
        root.children.push(vertex)
        ids.push(id)
      }
      saveDoc(doc)
      return out(`已新增 ${ids.length} 个顶点：${ids.join(', ')}`, { ids })
    }
    case 'drawio_add_edge':
    case 'drawio_connect': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const root = requireRoot(doc, a)
      const source = String(arg(a, ['source']) || '')
      const target = String(arg(a, ['target']) || '')
      if (!source || !target) throw new Error('缺少 source / target')
      if (!cellById(root, source)) throw new Error(`source=${source} 不存在`)
      if (!cellById(root, target)) throw new Error(`target=${target} 不存在`)
      const style = edgeStyleFor(a)
      const label = String(arg(a, ['label']) || '')
      if (name === 'drawio_connect') {
        const dup = cellEntries(root).find((e) => e.kind === 'edge' && e.source === source && e.target === target)
        if (dup) {
          if (label) dup.cell.attrs.value = escapeAttr(label)
          dup.cell.attrs.style = style
          saveDoc(doc)
          return out(`已存在同向连线 ${dup.id}，已更新其文字/样式`, { id: dup.id, updated: true })
        }
      }
      const id = String(arg(a, ['id']) || uniqueId(root, 'e'))
      root.children.push(makeEdge(id, source, target, label, style, String(arg(a, ['parent']) || '1')))
      saveDoc(doc)
      return out(`已新增连线 ${id}：${source} → ${target}${label ? ` ("${label}")` : ''}`, { id })
    }
    case 'drawio_update_cell': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const root = requireRoot(doc, a)
      const id = String(arg(a, ['id']))
      const entry = cellById(root, id)
      if (!entry) throw new Error(`找不到单元 ${id}`)
      const cell = entry.cell
      const label = arg(a, ['label'])
      if (label !== undefined) {
        if (entry.holder.name === 'mxCell') cell.attrs.value = escapeAttr(label)
        else entry.holder.attrs.label = escapeAttr(label)
      }
      const styleFull = arg(a, ['styleFull'])
      const styleMerge = arg(a, ['style'])
      if (styleFull !== undefined) cell.attrs.style = String(styleFull)
      else if (styleMerge !== undefined) {
        let st = cell.attrs.style || ''
        for (const part of String(styleMerge).split(';')) {
          if (!part.trim()) continue
          const i = part.indexOf('=')
          const k = i < 0 ? part.trim() : part.slice(0, i).trim()
          const v = i < 0 ? '' : part.slice(i + 1)
          st = v === '' ? styleDel(st, k) : styleSet(st, k, v)
        }
        cell.attrs.style = st
      }
      const g = ensureGeometry(cell)
      for (const key of ['x', 'y', 'width', 'height'] as const) {
        const v = arg(a, [key])
        if (v !== undefined) g.attrs[key] = String(v)
      }
      const parent = arg(a, ['parent'])
      if (parent !== undefined) cell.attrs.parent = String(parent)
      for (const key of ['source', 'target'] as const) {
        const v = arg(a, [key])
        if (v !== undefined) {
          if (!cellById(root, String(v))) throw new Error(`${key}=${v} 不存在`)
          cell.attrs[key] = String(v)
        }
      }
      const idNew = arg(a, ['idNew'])
      if (idNew) {
        const oldId = id
        cell.attrs.id = String(idNew)
        if (entry.holder.name !== 'mxCell') entry.holder.attrs.id = String(idNew)
        for (const e of cellEntries(root)) {
          if (e.cell.attrs.source === oldId) e.cell.attrs.source = String(idNew)
          if (e.cell.attrs.target === oldId) e.cell.attrs.target = String(idNew)
          if (e.cell.attrs.parent === oldId) e.cell.attrs.parent = String(idNew)
        }
      }
      saveDoc(doc)
      return out(`已更新单元 ${id}${idNew ? `（新 id：${idNew}）` : ''}`)
    }
    case 'drawio_move_cell': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const root = requireRoot(doc, a)
      const entry = cellById(root, String(arg(a, ['id'])))
      if (!entry) throw new Error('找不到该单元')
      const g = ensureGeometry(entry.cell)
      const x = arg(a, ['x'])
      const y = arg(a, ['y'])
      const dx = fmtNum(arg(a, ['dx']), 0)
      const dy = fmtNum(arg(a, ['dy']), 0)
      g.attrs.x = String(x !== undefined ? Number(x) : num(g.attrs.x, 0) + dx)
      g.attrs.y = String(y !== undefined ? Number(y) : num(g.attrs.y, 0) + dy)
      saveDoc(doc)
      return out(`已移动 ${entry.id} 到 (${g.attrs.x}, ${g.attrs.y})`)
    }
    case 'drawio_resize_cell': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const root = requireRoot(doc, a)
      const entry = cellById(root, String(arg(a, ['id'])))
      if (!entry) throw new Error('找不到该单元')
      const g = ensureGeometry(entry.cell)
      const scale = Number(arg(a, ['scale']))
      const width = arg(a, ['width'])
      const height = arg(a, ['height'])
      if (Number.isFinite(scale) && scale > 0) {
        g.attrs.width = String(Math.max(20, Math.round(num(g.attrs.width, 140) * scale)))
        g.attrs.height = String(Math.max(20, Math.round(num(g.attrs.height, 60) * scale)))
      }
      if (width !== undefined) g.attrs.width = String(Math.max(20, Number(width)))
      if (height !== undefined) g.attrs.height = String(Math.max(20, Number(height)))
      saveDoc(doc)
      return out(`已调整 ${entry.id} 尺寸为 ${g.attrs.width}×${g.attrs.height}`)
    }
    case 'drawio_set_style': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const root = requireRoot(doc, a)
      const entry = cellById(root, String(arg(a, ['id'])))
      if (!entry) throw new Error('找不到该单元')
      const styleArg = String(arg(a, ['style']) || '')
      let st = arg(a, ['replace']) === true ? '' : entry.cell.attrs.style || ''
      for (const part of styleArg.split(';')) {
        if (!part.trim()) continue
        const i = part.indexOf('=')
        const k = i < 0 ? part.trim() : part.slice(0, i).trim()
        const v = i < 0 ? '' : part.slice(i + 1)
        st = v === '' ? styleDel(st, k) : styleSet(st, k, v)
      }
      if (arg(a, ['replace']) === true && !/html=1/.test(st)) st = styleSet(st, 'html', '1')
      entry.cell.attrs.style = st
      saveDoc(doc)
      return out(`已更新 ${entry.id} 的样式：${st}`)
    }
    case 'drawio_set_label': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const root = requireRoot(doc, a)
      const entry = cellById(root, String(arg(a, ['id'])))
      if (!entry) throw new Error('找不到该单元')
      const label = escapeAttr(String(arg(a, ['label'])))
      if (entry.holder.name === 'mxCell') entry.cell.attrs.value = label
      else entry.holder.attrs.label = label
      let st = entry.cell.attrs.style || ''
      if (!/html=1/.test(st)) st = styleSet(st, 'html', '1')
      for (const [key, names] of [
        ['fontSize', ['fontSize']],
        ['fontStyle', ['fontStyle']],
        ['fontColor', ['fontColor']],
        ['align', ['align']],
      ] as Array<[string, string[]]>) {
        const v = arg(a, names)
        if (v !== undefined && v !== null && v !== '') st = styleSet(st, key, String(v))
      }
      entry.cell.attrs.style = st
      saveDoc(doc)
      return out(`已设置 ${entry.id} 的文本`)
    }
    case 'drawio_delete_cell': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const root = requireRoot(doc, a)
      const ids = asList(arg(a, ['id', 'ids']))
      if (!ids.length) throw new Error('缺少 id')
      const withEdges = arg(a, ['withEdges']) !== false
      const entries = cellEntries(root)
      const victims = new Set(ids)
      if (withEdges) {
        for (const e of entries) {
          if (e.kind === 'edge' && (victims.has(e.source) || victims.has(e.target))) victims.add(e.id)
        }
      }
      // 连带删除容器内的子单元
      let grew = true
      while (grew) {
        grew = false
        for (const e of entries) {
          if (e.parent && victims.has(e.parent) && !victims.has(e.id)) {
            victims.add(e.id)
            grew = true
          }
        }
      }
      const holders = entries.filter((e) => victims.has(e.id)).map((e) => e.holder)
      root.children = root.children.filter((c) => !holders.includes(c))
      saveDoc(doc)
      return out(`已删除 ${victims.size} 个单元：${Array.from(victims).join(', ')}`, { removed: Array.from(victims) })
    }
    case 'drawio_duplicate_cell': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const root = requireRoot(doc, a)
      const srcId = String(arg(a, ['id']))
      const src = cellById(root, srcId)
      if (!src) throw new Error(`找不到单元 ${srcId}`)
      const dx = fmtNum(arg(a, ['dx']), 40)
      const dy = fmtNum(arg(a, ['dy']), 40)
      const deep = arg(a, ['deep']) !== false
      const all = cellEntries(root)
      const members = deep ? all.filter((e) => e.id === srcId || e.parent === srcId) : [src]
      const idMap = new Map<string, string>()
      const newIds: string[] = []
      for (const m of members) {
        const fresh = uniqueId(root, m.kind === 'edge' ? 'e' : 'n')
        idMap.set(m.id, fresh)
        newIds.push(fresh)
      }
      for (const m of members) {
        const copy = JSON.parse(JSON.stringify(m.cell)) as XEl
        copy.attrs.id = idMap.get(m.id)!
        const g = ensureGeometry(copy)
        if (m.kind === 'vertex') {
          const isTop = m.id === srcId
          g.attrs.x = String(num(g.attrs.x, 0) + (isTop ? dx : 0))
          g.attrs.y = String(num(g.attrs.y, 0) + (isTop ? dy : 0))
        }
        if (copy.attrs.source && idMap.has(copy.attrs.source)) copy.attrs.source = idMap.get(copy.attrs.source)!
        if (copy.attrs.target && idMap.has(copy.attrs.target)) copy.attrs.target = idMap.get(copy.attrs.target)!
        if (copy.attrs.parent && idMap.has(copy.attrs.parent)) copy.attrs.parent = idMap.get(copy.attrs.parent)!
        root.children.push(copy)
      }
      saveDoc(doc)
      return out(`已复制 ${srcId} → ${idMap.get(srcId)}（共 ${newIds.length} 个单元）`, { ids: newIds })
    }
    case 'drawio_set_z_order': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const root = requireRoot(doc, a)
      const ids = asList(arg(a, ['id', 'ids']))
      const action = String(arg(a, ['action']))
      let moved = 0
      for (const id of ids) {
        const entry = cellById(root, id)
        if (!entry) continue
        const holder = entry.holder
        const idx = root.children.indexOf(holder)
        if (idx < 0) continue
        root.children.splice(idx, 1)
        if (action === 'front') root.children.push(holder)
        else if (action === 'back') root.children.splice(Math.min(2, root.children.length), 0, holder)
        else if (action === 'forward') root.children.splice(Math.min(root.children.length, idx + 1), 0, holder)
        else root.children.splice(Math.max(2, idx - 1), 0, holder)
        moved++
      }
      saveDoc(doc)
      return out(`已按 ${action} 调整 ${moved} 个单元的层级`)
    }
    case 'drawio_apply_fragment': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const root = requireRoot(doc, a)
      const res = applyFragment(root, String(arg(a, ['fragment'])), arg(a, ['allowEdit']) !== false)
      saveDoc(doc)
      return out(
        `片段应用完成：新增 ${res.added.length}、更新 ${res.updated.length}、删除 ${res.removed.length}`,
        res,
      )
    }

    // ---------- 容器 / 图层 / 标签 / 元数据 ----------
    case 'drawio_add_container': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const root = requireRoot(doc, a)
      const type = String(arg(a, ['type']) || 'swimlane')
      const id = String(arg(a, ['id']) || uniqueId(root, 'c'))
      let style =
        type === 'group'
          ? 'group;'
          : type === 'custom'
            ? buildStyle(a, 'rounded=1;whiteSpace=wrap;html=1;container=1;pointerEvents=0;')
            : 'swimlane;startSize=30;html=1;'
      style = styleSet(style, 'html', '1')
      if (styleGet(style, 'pointerEvents') === null && type !== 'group') style = styleSet(style, 'pointerEvents', '0')
      const color = arg(a, ['color'])
      if (color) {
        const pair = COLOR_PAIRS.find((c) => c.zh === color || c.en === color || c.fill === color)
        if (pair) {
          style = styleSet(style, 'fillColor', pair.fill)
          style = styleSet(style, 'strokeColor', pair.stroke)
        }
      }
      const x = fmtNum(arg(a, ['x']), 40)
      const y = fmtNum(arg(a, ['y']), 40)
      const w = fmtNum(arg(a, ['width']), 320)
      const h = fmtNum(arg(a, ['height']), 200)
      const container = makeVertex(id, String(arg(a, ['label']) || ''), x, y, w, h, style, '1')
      normalizeGeom(container, w, h)
      root.children.push(container)

      const adopted: string[] = []
      for (const childId of asList(arg(a, ['adopt']))) {
        const child = cellById(root, childId)
        if (!child || child.kind !== 'vertex') continue
        const cg = ensureGeometry(child.cell)
        const absX = num(cg.attrs.x, 0)
        const absY = num(cg.attrs.y, 0)
        const offX = type === 'swimlane' ? 0 : 0
        const offY = type === 'swimlane' ? num(styleGet(style, 'startSize'), 30) : 0
        child.cell.attrs.parent = id
        cg.attrs.x = String(Math.max(10, absX - x - offX))
        cg.attrs.y = String(Math.max(10, absY - y - offY))
        adopted.push(childId)
      }
      saveDoc(doc)
      return out(`已新增容器 ${id}（${type}）${adopted.length ? `，移入 ${adopted.join(', ')}` : ''}`, { id, style, adopted })
    }
    case 'drawio_add_layer': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const root = requireRoot(doc, a)
      const id = String(arg(a, ['id']) || uniqueId(root, 'layer'))
      const layer = createEl('mxCell', { id, value: escapeAttr(String(arg(a, ['name']) || 'Layer')), parent: '0' })
      if (arg(a, ['visible']) === false) layer.attrs.visible = '0'
      root.children.push(layer)
      const assigned: string[] = []
      for (const cellId of asList(arg(a, ['assign']))) {
        const entry = cellById(root, cellId)
        if (!entry) continue
        entry.cell.attrs.parent = id
        assigned.push(cellId)
      }
      saveDoc(doc)
      return out(`已新增图层 ${id}「${layer.attrs.value}」${assigned.length ? `，放入 ${assigned.join(', ')}` : ''}`, { id, assigned })
    }
    case 'drawio_set_parent': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const root = requireRoot(doc, a)
      const parentId = String(arg(a, ['parent', 'newParent', 'into']) || '')
      if (!parentId) throw new Error('缺少 parent')
      if (parentId !== '0' && parentId !== '1') {
        const p = cellById(root, parentId)
        if (!p) throw new Error(`找不到父单元：${parentId}`)
        if (p.kind !== 'vertex' && p.kind !== 'layer') throw new Error(`父单元 ${parentId} 不是容器或图层`)
      }
      const keepAbs = arg(a, ['keepAbsolute', 'keep']) !== false
      const moved: string[] = []
      for (const id of asList(arg(a, ['id']))) {
        const entry = cellById(root, id)
        if (!entry) throw new Error(`找不到单元：${id}`)
        if (id === parentId) throw new Error('不能把单元设为自己的父级')
        const oldParent = entry.cell.attrs.parent || entry.parent || '1'
        if (keepAbs && entry.kind === 'vertex' && entry.geometry) {
          const absPos = absolutePos(root, entry)
          const off = offsetOf(root, parentId)
          entry.geometry.attrs.x = String(Math.round(absPos.x - off.x))
          entry.geometry.attrs.y = String(Math.round(absPos.y - off.y))
        }
        entry.cell.attrs.parent = parentId
        if (entry.holder !== entry.cell && entry.holder.attrs.parent) entry.holder.attrs.parent = parentId
        moved.push(`${id}(${oldParent}→${parentId})`)
      }
      saveDoc(doc)
      return out(`已改变父级：${moved.join('、')}`, { parent: parentId, moved })
    }
    case 'drawio_set_tags': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const root = requireRoot(doc, a)
      const entry = cellById(root, String(arg(a, ['id'])))
      if (!entry) throw new Error('找不到该单元')
      const tags = String(arg(a, ['tags']) || '').trim()
      if (entry.holder.name === 'mxCell') {
        if (!tags) return out('该单元本来就没有标签包裹，无需处理')
        const wrap = createEl('object', { id: entry.id, label: entry.cell.attrs.value || '' })
        wrap.attrs.tags = tags
        delete entry.cell.attrs.id
        delete entry.cell.attrs.value
        const idx = root.children.indexOf(entry.cell)
        wrap.children.push(entry.cell)
        root.children.splice(idx, 1, wrap)
      } else {
        if (tags) entry.holder.attrs.tags = tags
        else delete entry.holder.attrs.tags
      }
      saveDoc(doc)
      return out(`已把 ${entry.id} 的标签设为「${tags || '（空）'}」`)
    }
    case 'drawio_set_metadata': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const root = requireRoot(doc, a)
      const entry = cellById(root, String(arg(a, ['id'])))
      if (!entry) throw new Error('找不到该单元')
      const props = (a.properties || {}) as Record<string, any>
      const mode = String(arg(a, ['mode']) || 'merge')
      let holder = entry.holder
      if (holder.name === 'mxCell') {
        const wrap = createEl('object', { id: entry.id, label: entry.cell.attrs.value || '' })
        delete entry.cell.attrs.id
        delete entry.cell.attrs.value
        const idx = root.children.indexOf(entry.cell)
        wrap.children.push(entry.cell)
        root.children.splice(idx, 1, wrap)
        holder = wrap
      }
      if (mode === 'replace') {
        for (const k of Object.keys(holder.attrs)) {
          if (!['id', 'label', 'tags', 'placeholders'].includes(k)) delete holder.attrs[k]
        }
      }
      for (const [k, v] of Object.entries(props)) holder.attrs[k] = escapeAttr(v)
      if (arg(a, ['placeholders']) === true) holder.attrs.placeholders = '1'
      saveDoc(doc)
      return out(`已给 ${entry.id} 设置属性：${Object.keys(props).join(', ')}`)
    }

    // ---------- 布局 ----------
    case 'drawio_auto_layout': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const root = requireRoot(doc, a)
      const res = autoLayout(root, {
        direction: arg(a, ['direction']),
        nodeWidth: arg(a, ['nodeWidth']),
        nodeHeight: arg(a, ['nodeHeight']),
        colGap: arg(a, ['colGap']),
        rowGap: arg(a, ['rowGap']),
        startX: arg(a, ['startX']),
        startY: arg(a, ['startY']),
      })
      saveDoc(doc)
      return out(`已自动布局：移动 ${res.moved} 个节点，共 ${res.layers} 层`, res)
    }
    case 'drawio_grid_layout': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const root = requireRoot(doc, a)
      const res = gridLayout(root, fmtNum(arg(a, ['columns']), 4), {
        nodeWidth: arg(a, ['nodeWidth']),
        nodeHeight: arg(a, ['nodeHeight']),
        colGap: arg(a, ['colGap']),
        rowGap: arg(a, ['rowGap']),
      })
      saveDoc(doc)
      return out(`已网格布局：移动 ${res.moved} 个节点`, res)
    }
    case 'drawio_align': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const root = requireRoot(doc, a)
      const ids = asList(arg(a, ['ids', 'id']))
      const res = alignCells(root, ids, String(arg(a, ['mode'])) as AlignMode)
      saveDoc(doc)
      return out(`已对齐 ${res.moved} 个单元（${arg(a, ['mode'])}）`, res)
    }
    case 'drawio_distribute': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const root = requireRoot(doc, a)
      const ids = asList(arg(a, ['ids', 'id']))
      const gap = arg(a, ['gap'])
      const res = distributeCells(root, ids, String(arg(a, ['axis']) || 'h') === 'v' ? 'v' : 'h', gap === undefined ? undefined : Number(gap))
      saveDoc(doc)
      return out(`已等距分布 ${res.moved} 个单元`, res)
    }
    case 'drawio_fit_page': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const page = requirePage(doc, a)
      if (!page.model) throw new Error('该页不是可编辑的 mxGraphModel')
      const res = fitPageSize(page.model, fmtNum(arg(a, ['pad']), 40))
      saveDoc(doc)
      return out(`已把页面尺寸调整为 ${res.width}×${res.height}`, res)
    }
    case 'drawio_translate_all': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const root = requireRoot(doc, a)
      const res = translateAll(root, fmtNum(arg(a, ['dx']), 0), fmtNum(arg(a, ['dy']), 0))
      saveDoc(doc)
      return out(`已平移 ${res.moved} 个节点`, res)
    }

    // ---------- 互转 / 导出 ----------
    case 'drawio_import_mermaid': {
      const abs = resolveDocPath(a)
      const mermaid = String(arg(a, ['mermaid']) || '')
      const parsed = parseMermaid(mermaid)
      if (!parsed.nodes.length) throw new Error('未能从 Mermaid 里解析出节点（当前支持 flowchart/graph 子集）')
      const model = createEl('mxGraphModel', { dx: '800', dy: '600', grid: '1', gridSize: '10', page: '1', pageWidth: '850', pageHeight: '1100', math: '0', shadow: '0', adaptiveColors: 'auto' })
      const root = createEl('root')
      root.children.push(createEl('mxCell', { id: '0' }))
      root.children.push(createEl('mxCell', { id: '1', parent: '0' }))
      const idMap = new Map<string, string>()
      parsed.nodes.forEach((n, i) => {
        const id = `n${i + 1}`
        idMap.set(n.id, id)
        root.children.push(makeVertex(id, n.label, 40 + (i % 4) * 200, 40 + Math.floor(i / 4) * 120, 140, 60, n.style))
      })
      parsed.edges.forEach((e, i) => {
        const s = idMap.get(e.from)
        const t = idMap.get(e.to)
        if (!s || !t) return
        root.children.push(makeEdge(`e${i + 1}`, s, t, e.label, edgeStyleFor({ variant: e.dashed ? 'dashed' : 'orthogonal' })))
      })
      model.children.push(root)
      if (arg(a, ['layout']) !== false) autoLayout(root, { direction: parsed.direction })

      const mode = String(arg(a, ['mode']) || (fs.existsSync(abs) ? 'newPage' : 'newFile'))
      if (mode === 'newFile' && !fs.existsSync(abs)) {
        const file = createEl('mxfile', { host: 'app.diagrams.net' })
        file.children.push(newPageEl('page1', String(arg(a, ['name']) || 'Page-1'), serializeXml(model)))
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, serializeXml(file) + '\n', 'utf8')
        return out(`已由 Mermaid 创建 ${abs}（${parsed.nodes.length} 个节点 / ${parsed.edges.length} 条连线）`, { path: abs })
      }
      const doc = loadDoc(abs)
      if (mode === 'newPage') {
        const name = String(arg(a, ['name']) || `Page-${doc.pages.length + 1}`)
        doc.file.children.push(newPageEl(uniquePageId(doc, name), name, serializeXml(model)))
        saveDoc(doc)
        return out(`已在 ${abs} 追加一页「${name}」（${parsed.nodes.length} 节点 / ${parsed.edges.length} 连线）`)
      }
      const page = requirePage(doc, a)
      if (!page.model) throw new Error('目标页不可编辑')
      const targetRoot = modelRoot(page.model)!
      for (const child of root.children) {
        if (child.name !== 'mxCell') continue
        if (child.attrs.id === '0' || child.attrs.id === '1') continue
        targetRoot.children.push(JSON.parse(JSON.stringify(child)) as XEl)
      }
      // 合并时避免 id 冲突
      const seen = new Set<string>()
      for (const c of targetRoot.children) {
        const id = c.attrs.id
        if (!id || id === '0' || id === '1') continue
        if (seen.has(id)) c.attrs.id = uniqueId(targetRoot, 'm')
        else seen.add(id)
      }
      saveDoc(doc)
      return out(`已把 Mermaid 合并进第 ${page.index} 页「${page.name}」`)
    }
    case 'drawio_export_mermaid': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const root = requireRoot(doc, a)
      const dir = String(arg(a, ['direction']) || 'vertical') === 'horizontal' ? 'horizontal' : 'vertical'
      const md = toMermaid(root, dir)
      const writeTo = arg(a, ['writeTo'])
      if (writeTo) {
        const outPath = path.isAbsolute(String(writeTo)) ? String(writeTo) : path.resolve(process.cwd(), String(writeTo))
        fs.mkdirSync(path.dirname(outPath), { recursive: true })
        fs.writeFileSync(outPath, md + '\n', 'utf8')
        return out(`已导出 Mermaid 到 ${outPath}\n\n\`\`\`mermaid\n${md}\n\`\`\``, { path: outPath })
      }
      return out(`Mermaid：\n\n\`\`\`mermaid\n${md}\n\`\`\``, { mermaid: md })
    }
    case 'drawio_import_csv': {
      const abs = resolveDocPath(a)
      const csv = String(arg(a, ['csv']) || '')
      const res = csvToDiagram(csv, String(arg(a, ['mode']) || 'table') === 'org' ? 'org' : 'table', String(arg(a, ['title']) || ''))
      if (arg(a, ['intoPage']) === true && fs.existsSync(abs)) {
        const doc = loadDoc(abs)
        const page = requirePage(doc, a)
        if (!page.model) throw new Error('目标页不可编辑')
        const incoming = asMxfile(res.xml)!
        const incomingRoot = modelRoot(pagesOf(incoming)[0].model)!
        const targetRoot = modelRoot(page.model)!
        const used = new Set(cellEntries(targetRoot, true).map((c) => c.id))
        let counter = used.size
        for (const c of incomingRoot.children) {
          if (c.name !== 'mxCell' || c.attrs.id === '0' || c.attrs.id === '1') continue
          const copy = JSON.parse(JSON.stringify(c)) as XEl
          if (used.has(copy.attrs.id)) copy.attrs.id = `imp${++counter}`
          used.add(copy.attrs.id)
          targetRoot.children.push(copy)
        }
        saveDoc(doc)
        return out(`已把 CSV（${res.rows} 行 × ${res.cols} 列）合并进第 ${page.index} 页`)
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, res.xml + '\n', 'utf8')
      return out(`已由 CSV 生成 ${abs}（${res.rows} 行 × ${res.cols} 列，${String(arg(a, ['mode']) || 'table')} 模式）`, { path: abs })
    }
    case 'drawio_export_svg': {
      const abs = resolveDocPath(a)
      const doc = loadDoc(abs)
      const page = requirePage(doc, a)
      if (!page.model) throw new Error('该页不是可渲染的 mxGraphModel')
      const svg = modelToSvg(page.model)
      const writeTo = arg(a, ['writeTo'])
      if (writeTo) {
        const outPath = path.isAbsolute(String(writeTo)) ? String(writeTo) : path.resolve(process.cwd(), String(writeTo))
        fs.mkdirSync(path.dirname(outPath), { recursive: true })
        fs.writeFileSync(outPath, svg, 'utf8')
        return out(`已导出 SVG 到 ${outPath}（${svg.length} 字节）`, { path: outPath })
      }
      return out(`SVG（${svg.length} 字节）：\n\n\`\`\`svg\n${svg}\n\`\`\``)
    }

    // ---------- 辅助 ----------
    case 'drawio_search_shapes': {
      const res = searchShapes(String(arg(a, ['query']) || ''), fmtNum(arg(a, ['limit']), 10))
      const lines = res.map((s) => `- ${s.zh} / ${s.en}\n  style: ${s.style}`)
      return out(`找到 ${res.length} 个形状/样式：\n${lines.join('\n')}\n\n配色对：${COLOR_PAIRS.map((c) => `${c.zh}=${c.fill}/${c.stroke}`).join('、')}`, {
        shapes: res.map((s) => s.style),
        colors: COLOR_PAIRS,
      })
    }
    case 'drawio_style_help': {
      const section = String(arg(a, ['section']) || '')
      const blocks: Record<string, string> = {
        styles: [
          '常用 style 属性：rounded=1（圆角）、whiteSpace=wrap（换行）、html=1（**所有单元都加**）、fillColor/strokeColor/fontColor、fontSize/fontStyle(1粗2斜4下划线)/align/verticalAlign、shape=<名称>、ellipse/rhombus/swimlane/group/text、container=1、pointerEvents=0、rotation=45、flipH=1/flipV=1、opacity=50。',
          '专业形状优先：数据库 shape=cylinder3、文档 shape=mxgraph.flowchart.document、云 shape=cloud、便签 shape=note、UML shape=umlLifeline / shape=umlActor。需要行业图标先调 drawio_search_shapes。',
        ].join('\n'),
        colors: `标准配色对（浅填充/描边）：${COLOR_PAIRS.map((c) => `${c.zh} ${c.fill}/${c.stroke}`).join('、')}。`,
        containers: [
          '容器：`swimlane;startSize=30;`（带标题）/ `group;`（不可见）/ 任意形状加 `container=1;pointerEvents=0;`。',
          '子单元：parent=容器id，坐标**相对**容器（泳道 header 高度要避开）。跨容器连线必须 parent="1"，否则会被裁切。',
          '扁平泳道（BPMN 风格）：`swimlane;horizontal=0;startSize=110;`，每条 y=lane_index*150、height=150，子节点 x=120,y=45。',
        ].join('\n'),
        layers: '图层：parent="0" 且无 vertex/edge 的 mxCell 即一层；把单元 parent 指向它即入层；后出现的层在上；`visible="0"` 默认隐藏。',
        tags: '标签：需要 `<object id="x" label="…" tags="a b"><mxCell …/></object>` 包裹（`drawio_set_tags` 会自动包）。元数据：`<object … placeholders="1" owner="Team A">`，label 里写 `%owner%` 即可替换。',
        dark: '暗色：不写颜色时 fillColor/strokeColor/fontColor 用 "default" 自动适配；要显式控制用 `light-dark(#light,#dark)`；`<mxGraphModel adaptiveColors="auto">` 开启自动反色。',
        edges: [
          '连线风格按图类型统一选：流程图/架构/网络 → `edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=classic;`；UML 类/时序 → 不给 edgeStyle（直线）；ER → `edgeStyle=entityRelationEdgeStyle;`；思维导图 → `curved=1;`。',
          '其他：`dashed=1;dashPattern=8 8;` 可选/异步、`startArrow=classic;` 双向、`endArrow=none;` 无箭头、`exitX/exitY/entryX/entryY`（0/0.5/1=左或上/中/右或下）指定出入口。',
          '连线文字写 value；不要手写 <Array as="points"> 折点（交给 drawio 路由）。',
        ].join('\n'),
        wellformed: [
          '硬约束：① 每条连线必须有 `<mxGeometry relative="1" as="geometry"/>`（自闭合的 edge 单元无效）；② 属性值里的 & < > 要转义（`&amp; &lt; &gt;`），HTML 标签要 `&lt;b&gt;` 形式且 style 带 `html=1`；③ 换行用 `&#xa;`（html=0 也可）或 `&lt;br&gt;`（需 html=1），**不要写 \\n**；④ id 唯一；⑤ **禁止 XML 注释**。',
        ].join('\n'),
      }
      const chosen = section && blocks[section] ? { [section]: blocks[section] } : blocks
      return out(Object.entries(chosen).map(([k, v]) => `## ${k}\n${v}`).join('\n\n'), chosen)
    }
    default:
      throw new Error(`未知工具：${name}`)
  }
}

function wrapRoot(root: XEl): XEl {
  const model = createEl('mxGraphModel', { dx: '800', dy: '600', grid: '1', gridSize: '10', page: '1', pageWidth: '850', pageHeight: '1100', math: '0', shadow: '0' })
  model.children.push(root)
  return model
}

function uniquePageId(doc: LoadedDoc, name: string): string {
  const used = new Set(doc.pages.map((p) => p.id))
  let base = name.replace(/[^\w-]+/g, '') || 'page'
  let id = base
  let i = 1
  while (used.has(id)) id = `${base}${++i}`
  return id
}

/** 压缩页往返自检（供测试/排查用） */
export function selfCheckCompression(modelXml: string): boolean {
  try {
    return decompressModel(compressModel(modelXml)) === modelXml
  } catch {
    return false
  }
}

// ---------------- 内置服务接入（与 office-service 同构） ----------------

let sharedServer: any = null

async function getSharedServer(): Promise<any> {
  if (sharedServer) return sharedServer
  const sdk = await getServerSdk()
  const server = new sdk.Server({ name: DRAWIO_MCP_NAME, version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(sdk.ListToolsRequestSchema, async () => ({ tools: toolDefinitions() }))
  server.setRequestHandler(sdk.CallToolRequestSchema, async (req: any) => {
    const { name, arguments: args } = req.params || {}
    try {
      const text = await executeTool(String(name), (args || {}) as Record<string, any>)
      return { content: [{ type: 'text', text }] }
    } catch (e: any) {
      return { content: [{ type: 'text', text: `错误：${e?.message || e}` }], isError: true }
    }
  })
  sharedServer = server
  return server
}

/** 供 mcp-service：内置连接每次创建一对 InMemory transport 并挂到共享 Server（断开即回收） */
export async function createLocalServerPair(): Promise<{ server: any; clientTransport: any }> {
  const sdk = await getServerSdk()
  const server = await getSharedServer()
  const [clientTransport, serverTransport] = sdk.InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  return { server, clientTransport }
}

export async function connectTransport(transport: any): Promise<void> {
  const server = await getSharedServer()
  await server.connect(transport)
}

export function dispose(): void {
  sharedServer = null
  serverSdkCache = null
}

export const drawioService = {
  id: DRAWIO_MCP_ID,
  createLocalServerPair,
  connectTransport,
  dispose,
  executeTool,
  listToolNames: () => toolDefinitions().map((t: any) => t.name),
}
