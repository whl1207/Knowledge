/**
 * graph.ts — 图谱 = 数据集的投影（不是独立存储）
 *
 * 两种投影（同一套节点/边结构，直接给 KnowledgeGraphViewer 用）：
 *
 * 1) buildCrawlGraph —— 爬取轨迹图（链接采集 ≈ 轨迹可视化）：
 *   节点 = 页面行（unit）：id/url/标题/状态/深度/发现链接数（title 悬停可见）
 *   边   = unit.meta.parentUrl 指向父行 → 轨迹树（哪一页发现了哪一页），精确因果
 *   节点颜色 = 行状态（轨迹“走到哪了”）：完成绿 / 执行中蓝 / 失败红 / 待处理灰 / 跳过橙
 *
 * 2) buildAccessGraph —— 访问路径图（任意执行器的“信源轨迹”，智能体为中心）：
 *   节点 = 每行一个「智能体」节点（有过程快照且抓到可投影调用时创建）
 *        + 该行访问过的信源（网页/本地文件/联网搜索/知识库）+ 调用过的 MCP 服务
 *   边   = 智能体 → 信源 / MCP 服务（标签=动作：读取 / 抓取 / 搜索 / 检索 / MCP），星形拓扑
 *   （早期的“行内顺序链”已改为星形：一眼看出“这一步由哪个智能体做了什么”）
 *
 * 两个投影都受 `maxNodes` 约束（默认 2000，可通过 return 的 truncated 得知是否截断）。
 *
 * 因为图谱是投影，运行中行状态变化、新行加入（frontier 扩展）会自动反映到图上，
 * 无需像旧 CollectWeb 那样在 addGraphNode / addGraphEdge 里手工维护三份平行结构。
 */
import type { PipelineUnit } from './types'
import { normalizeUrl, parseLinksField } from './fetch'

export interface PipelineGraphNode {
  id: string
  label: string
  /** viewer 内置类型：source=网页信源 / file=原始文件 / data=数据实体 / agent=智能体 / mcp=MCP 服务 */
  type: 'source' | 'file' | 'data' | 'agent' | 'mcp'
  /** viewer 支持的颜色：green/blue/orange/red/gray/purple */
  color: 'green' | 'blue' | 'orange' | 'red' | 'gray' | 'purple'
  /**
   * 语义分类（供图谱界面按类型筛选 / 图例）：
   *   page=爬取页面（爬取轨迹图统一分类，颜色表示状态）
   *   agent / web / file / search / kb / mcp = 访问路径图的智能体与访问对象类型
   */
  kind?: 'page' | 'agent' | 'web' | 'file' | 'search' | 'kb' | 'mcp'
  url?: string
  data?: Record<string, any>
}

export interface PipelineGraphEdge {
  id: string
  source: string
  target: string
  type: string
  label: string
}

export interface PipelineGraph {
  nodes: PipelineGraphNode[]
  edges: PipelineGraphEdge[]
  /** 爬取轨迹专用：各层页数分布（0 层 = 种子；图为投影，顺带给出“追溯到的深度”） */
  depthStats?: Array<{ depth: number; total: number }>
  /** 是否因节点上限截断（图谱工具栏可调上限，默认 2000） */
  truncated?: boolean
}

/** 行状态 → 节点颜色（viewer 支持 green/blue/orange/red/gray） */
const STATUS_COLOR: Record<string, PipelineGraphNode['color']> = {
  completed: 'green',
  running: 'blue',
  failed: 'red',
  pending: 'gray',
  skipped: 'orange',
}
const STATUS_TEXT: Record<string, string> = {
  completed: '已完成',
  running: '执行中',
  failed: '失败',
  pending: '待处理',
  skipped: '跳过',
}

/**
 * 图谱文案（节点 tooltip 字段名 / 边标签 / 类型名）：中英各一份。
 * ⚠ 英文界面下图谱 tooltip 不能再出现中文——用 graphText(zh) 取当前语言的一份。
 */
const TEXT_ZH = {
  status: '状态', depth: '深度', links: '发现链接', error: '错误', result: '结果',
  edgeFound: '发现', edgeLink: '链接',
  type: '类型', action: '动作', firstStep: '首次步骤', service: '服务', tool: '工具', params: '参数',
  agentType: '智能体', mcpType: 'MCP 服务',
  agentFallback: (n: number) => `智能体 ${n}`,
  steps: '过程步骤', sourceVisits: '信源访问', mcpCalls: 'MCP 调用',
  statuses: STATUS_TEXT,
  kinds: { web: '网页', file: '本地文件', search: '联网搜索', kb: '知识库检索' } as Record<string, string>,
  actions: { read_file: '读取', web_fetch: '抓取', web_search: '搜索', search_files: '查找', kb_search: '检索' } as Record<string, string>,
}
const TEXT_EN: typeof TEXT_ZH = {
  status: 'Status', depth: 'Depth', links: 'Links found', error: 'Error', result: 'Result',
  edgeFound: 'found', edgeLink: 'links',
  type: 'Type', action: 'Action', firstStep: 'First step', service: 'Service', tool: 'Tool', params: 'Argument',
  agentType: 'Agent', mcpType: 'MCP service',
  agentFallback: (n: number) => `Agent ${n}`,
  steps: 'Steps', sourceVisits: 'Sources visited', mcpCalls: 'MCP calls',
  statuses: { completed: 'Completed', running: 'Running', failed: 'Failed', pending: 'Pending', skipped: 'Skipped' },
  kinds: { web: 'Web page', file: 'Local file', search: 'Web search', kb: 'KB search' },
  actions: { read_file: 'read', web_fetch: 'fetch', web_search: 'search', search_files: 'find', kb_search: 'retrieve' },
}
/** 取当前界面语言的图谱文案 */
export const graphText = (zh: boolean) => (zh ? TEXT_ZH : TEXT_EN)

/**
 * 解析每行的爬取深度（图谱“追溯深度”的兜底）：
 * 优先取 meta.depth（执行时精确记录）；缺失时沿 meta.parentUrl 链向上回溯，
 * 父行不在表内时按“根的下一层（1）”计；带环路保护。
 */
export function resolveRowDepths(rows: PipelineUnit[], urlField = 'url'): Map<string, number> {
  const byUrl = new Map<string, PipelineUnit>()
  for (const r of rows) {
    const u = String(r.data?.[urlField] || '')
    if (u) byUrl.set(normalizeUrl(u), r)
  }
  const memo = new Map<string, number>()
  const depthOf = (row: PipelineUnit, guard: Set<string>): number => {
    const known = memo.get(row.id)
    if (known !== undefined) return known
    const raw = row.meta?.depth
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      memo.set(row.id, raw)
      return raw
    }
    const parentUrl = String(row.meta?.parentUrl || '')
    if (!parentUrl || guard.has(row.id)) {
      memo.set(row.id, 0)
      return 0
    }
    guard.add(row.id)
    const parent = byUrl.get(normalizeUrl(parentUrl))
    const v = parent ? depthOf(parent, guard) + 1 : 1
    memo.set(row.id, v)
    return v
  }
  for (const r of rows) depthOf(r, new Set())
  return memo
}

/**
 * 把任务行投影为爬取图谱（轨迹树）。
 * @param rows 任务行（urls 源：每行 = 一个页面）
 * @param opts.urlField 行内网页地址字段名（默认 'url'；文本源可能是 text/自定义名，由 resolveContentField 提供）
 * @param opts.includeRefs 是否附加「引用边」：行内 links 字段解析到已有行时补一条虚线语义的边
 *   （v1 默认关闭——导航栏互链会让图变成毛球；后续“结构视图”再启用）
 * @param opts.maxNodes 节点上限（默认 2000，图谱工具栏可调）
 */
export function buildCrawlGraph(rows: PipelineUnit[], opts?: { includeRefs?: boolean; urlField?: string; maxNodes?: number; zh?: boolean }): PipelineGraph {
  const urlField = opts?.urlField || 'url'
  const maxNodes = Math.max(1, opts?.maxNodes ?? 2000)
  const T = graphText(opts?.zh !== false)
  const depths = resolveRowDepths(rows, urlField)
  const depthAgg = new Map<number, number>()
  const nodes: PipelineGraphNode[] = []
  const edges: PipelineGraphEdge[] = []
  const edgeKeys = new Set<string>()
  const nodeIdSet = new Set<string>()
  let truncated = false
  const rowByUrl = new Map<string, PipelineUnit>()
  for (const row of rows) {
    const url = String(row.data?.[urlField] || '')
    if (url) rowByUrl.set(normalizeUrl(url), row)
  }

  const pushEdge = (from: PipelineUnit, to: PipelineUnit, type: string, label: string) => {
    // 两端节点都必须在图上（节点上限截断后不补边，避免悬空引用）
    if (!nodeIdSet.has(from.id) || !nodeIdSet.has(to.id)) return
    const key = `${from.id}->${to.id}`
    if (edgeKeys.has(key)) return
    edgeKeys.add(key)
    edges.push({ id: `e_${key}`, source: from.id, target: to.id, type, label })
  }

  for (const row of rows) {
    const url = String(row.data?.[urlField] || '')
    if (!url) continue
    if (nodes.length >= maxNodes) { truncated = true; break }
    const title = String(row.data?.title || '').trim()
    const links = parseLinksField(row.data?.links)
    const depth = depths.get(row.id) ?? 0
    depthAgg.set(depth, (depthAgg.get(depth) || 0) + 1)
    const tooltip: Record<string, any> = {
      [T.status]: T.statuses[row.status] || row.status,
      [T.depth]: depth,
      [T.links]: links.length,
    }
    if (row.error) tooltip[T.error] = String(row.error).substring(0, 120)
    if (row.result) tooltip[T.result] = String(row.result).substring(0, 120)
    nodeIdSet.add(row.id)
    nodes.push({
      id: row.id,
      label: (title || url).substring(0, 30),
      type: 'source',
      kind: 'page',
      color: STATUS_COLOR[row.status] || 'gray',
      url,
      data: tooltip,
    })

    // 轨迹边：父页面 → 本页（爬取时从哪一跳过来）
    const parentUrl = String(row.meta?.parentUrl || '')
    if (parentUrl) {
      const parent = rowByUrl.get(normalizeUrl(parentUrl))
      if (parent) pushEdge(parent, row, 'links_to', T.edgeFound)
    }

    // 引用边（可选）：本页链接到的其它已知页
    if (opts?.includeRefs) {
      for (const l of links) {
        const target = rowByUrl.get(normalizeUrl(l))
        if (target && target.id !== row.id) pushEdge(row, target, 'ref', T.edgeLink)
      }
    }
  }
  const depthStats = [...depthAgg.entries()].sort((a, b) => a[0] - b[0]).map(([depth, total]) => ({ depth, total }))
  return { nodes, edges, depthStats, truncated }
}

// ==================== 访问路径图（以「智能体」为中心的星形轨迹） ====================
/**
 * 把任务行的过程快照（row.trace 里的工具调用）投影为「访问路径图」：
 *   每行（抓到可投影调用时）→ 一个「智能体」节点（紫）；
 *   智能体 →（边，标签=动作）信源节点（网页绿 / 本地文件蓝 / 联网搜索橙 / 知识库灰）；
 *   智能体 →（边，标签=MCP）MCP 服务节点（红；serverId 缺失时按工具名建节点）。
 * 不再画行内顺序链：边表达**归属**（谁访问了谁 / 谁调用了哪个 MCP），一眼看出哪一步由哪个智能体做了什么。
 */
interface AccessToolSpec {
  kind: 'file' | 'web' | 'search' | 'kb'
  /** 从工具入参里取值的候选键（按优先级） */
  keys: string[]
}

const ACCESS_TOOLS: Record<string, AccessToolSpec> = {
  read_file: { kind: 'file', keys: ['path', 'filePath', 'file_path'] },
  web_fetch: { kind: 'web', keys: ['url'] },
  web_search: { kind: 'search', keys: ['query', 'q'] },
  search_files: { kind: 'search', keys: ['query', 'pattern'] },
  kb_search: { kind: 'kb', keys: ['query'] },
}

const ACCESS_KIND_COLOR: Record<string, PipelineGraphNode['color']> = {
  web: 'green',
  file: 'blue',
  search: 'orange',
  kb: 'gray',
}

/** 从工具入参字符串（可能被截断）中取候选键的值：优先 JSON 解析，失败则正则容错 */
function pickArgValue(args: string, keys: string[]): string {
  if (!args) return ''
  try {
    const obj = JSON.parse(args)
    for (const k of keys) {
      const v = obj?.[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
      if (v !== undefined && v !== null && String(v).trim()) return String(v).trim()
    }
  } catch { /* 参数被截断或非 JSON → 走正则 */ }
  for (const k of keys) {
    const m = args.match(new RegExp(`"${k}"\\s*:\\s*"([^"]{1,300})`))
    if (m) return m[1].trim()
  }
  return ''
}

/** 节点短标签：文件取文件名；网址取 主机+路径短写；搜索/检索取查询词 */
function accessLabel(kind: string, value: string): string {
  if (kind === 'file') {
    const parts = value.split(/[\\/]/).filter(Boolean)
    return (parts[parts.length - 1] || value).slice(0, 30)
  }
  if (kind === 'web') {
    try {
      const u = new URL(value)
      const short = `${u.hostname}${u.pathname}`
      return (short.length > 30 ? short.slice(0, 30) + '…' : short) || value.slice(0, 30)
    } catch {
      return value.slice(0, 30)
    }
  }
  return value.slice(0, 26)
}

/**
 * 解析 mcp_call 入参（镜像主进程 tools.ts 的多层兜底）：
 * tool / toolName（可能在 args 内层）与 serverId / server_id（可能在 args 内层）。
 * 参数被截断或非 JSON 时用正则容错。
 */
function parseMcpCallArgs(args: string): { tool: string; server: string } {
  if (!args) return { tool: '', server: '' }
  try {
    const obj = JSON.parse(args)
    const inner = obj?.args && typeof obj.args === 'object' && !Array.isArray(obj.args) ? obj.args : {}
    return {
      tool: String(obj?.tool || obj?.toolName || inner.tool || inner.toolName || '').trim(),
      server: String(obj?.serverId || inner.serverId || inner.server_id || '').trim(),
    }
  } catch { /* 参数被截断或非 JSON → 走正则 */ }
  const tool = (args.match(/"tool(?:Name)?"\s*:\s*"([^"]{1,120})/)?.[1] || '').trim()
  const server = (args.match(/"server_?[iI]d"\s*:\s*"([^"]{1,120})/)?.[1] || '').trim()
  return { tool, server }
}

export interface AccessGraphOptions {
  /** 最多分析的行数（默认 300，避免大批量时开销过大） */
  maxRows?: number
  /** 节点上限（默认 2000；图谱工具栏可调） */
  maxNodes?: number
  /** 智能体节点标签（调用方按行号/标题生成）；缺省「智能体 N」 */
  agentLabel?: (row: PipelineUnit, index: number) => string
  /** MCP serverId → 显示名（缺省用 serverId） */
  mcpServerName?: (serverId: string) => string
  /** 图谱文案语言（false = 英文；缺省中文） */
  zh?: boolean
}

/**
 * 构建访问路径图（智能体为中心）。
 * @param rows 任务行（行的过程快照 row.trace 里有工具调用记录；未运行过的行自动跳过）
 */
export function buildAccessGraph(rows: PipelineUnit[], opts?: AccessGraphOptions): PipelineGraph {
  const T = graphText(opts?.zh !== false)
  const maxRows = Math.max(1, opts?.maxRows ?? 300)
  const maxNodes = Math.max(1, opts?.maxNodes ?? 2000)
  const nodes: PipelineGraphNode[] = []
  const edges: PipelineGraphEdge[] = []
  const nodeById = new Map<string, PipelineGraphNode>()
  const edgeKeys = new Set<string>()
  let truncated = false

  const pushNode = (node: PipelineGraphNode): boolean => {
    if (nodeById.has(node.id)) return true
    if (nodeById.size >= maxNodes) { truncated = true; return false }
    nodeById.set(node.id, node)
    nodes.push(node)
    return true
  }
  const pushEdge = (source: string, target: string, label: string) => {
    const key = `${source}->${target}`
    if (edgeKeys.has(key)) return
    edgeKeys.add(key)
    edges.push({ id: `a_${key}`, source, target, type: 'visit', label })
  }

  let scanned = 0
  let seq = 0
  for (const row of rows) {
    const trace = Array.isArray(row.trace) ? row.trace : []
    // 跑过的行都上图：即使没调用任何工具，也保留一个（孤立的）智能体节点
    if (!trace.length && !((row.stepsCount || 0) > 0)) continue
    if (scanned++ >= maxRows) break
    const agentId = `agent:${row.id}`
    const agentLabelText = (opts?.agentLabel?.(row, seq) || '').trim() || T.agentFallback(seq + 1)
    seq++
    // 先行创建智能体节点（达节点上限则跳过该行）
    if (!pushNode({
      id: agentId,
      label: agentLabelText,
      type: 'agent',
      kind: 'agent',
      color: 'purple',
      data: {
        [T.type]: T.agentType,
        [T.status]: T.statuses[row.status] || row.status,
        [T.steps]: trace.length || (row.stepsCount || 0),
        [T.sourceVisits]: 0,
        [T.mcpCalls]: 0,
      },
    })) continue
    let stepNo = 0
    let sourceVisits = 0
    let mcpCallCount = 0
    for (const step of trace) {
      stepNo++
      for (const call of step.toolCalls || []) {
        const name = String(call.name || '')
        // MCP 调用 → 服务节点（拿不到 serverId 时按工具名建节点，仍能看出“这行调过 MCP”）
        if (name === 'mcp_call') {
          const parsed = parseMcpCallArgs(String(call.args || ''))
          const targetId = parsed.server ? `mcp:${parsed.server}` : (parsed.tool ? `mcp:tool:${parsed.tool}` : '')
          if (!targetId) continue
          const serverName = parsed.server ? (opts?.mcpServerName?.(parsed.server) || parsed.server) : ''
          const mcpLabel = (serverName || parsed.tool || parsed.server).slice(0, 30)
          if (pushNode({
            id: targetId,
            label: mcpLabel,
            type: 'mcp',
            kind: 'mcp',
            color: 'red',
            data: {
              [T.type]: T.mcpType,
              [T.service]: serverName || undefined,
              'serverId': parsed.server || undefined,
              [T.tool]: parsed.tool || undefined,
              [T.firstStep]: stepNo,
            },
          })) {
            pushEdge(agentId, targetId, 'MCP')
            mcpCallCount++
          }
          continue
        }
        const spec = ACCESS_TOOLS[name]
        if (!spec) continue
        const value = pickArgValue(String(call.args || ''), spec.keys)
        if (!value) continue
        const id = `${spec.kind}:${value}`
        if (pushNode({
          id,
          label: accessLabel(spec.kind, value),
          type: spec.kind === 'web' ? 'source' : spec.kind === 'file' ? 'file' : 'data',
          kind: spec.kind,
          color: ACCESS_KIND_COLOR[spec.kind] || 'gray',
          url: spec.kind === 'web' ? value : undefined,
          data: {
            [T.type]: T.kinds[spec.kind] || spec.kind,
            [T.action]: T.actions[name] || name,
            [T.firstStep]: stepNo,
            [T.params]: value.length > 90 ? value.slice(0, 90) + '…' : value,
          },
        })) {
          pushEdge(agentId, id, T.actions[name] || name)
          sourceVisits++
        }
      }
    }
    const agentNode = nodeById.get(agentId)
    if (agentNode?.data) {
      agentNode.data[T.sourceVisits] = sourceVisits
      agentNode.data[T.mcpCalls] = mcpCallCount
    }
  }
  return { nodes, edges, truncated }
}
