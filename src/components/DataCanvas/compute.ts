// compute.ts - 数据流执行引擎（含轻量级 SQL 引擎）
// 负责：拓扑排序 → 逐节点计算 → 得到 nodeId → 计算结果 的映射

import type { Model, DcNode, DcEdge } from '@/components/DataCanvas/types'

// 计算结果：nodeId -> 结果对象
export type ComputeResults = Record<string, any>

// ==================== 通用工具 ====================
function isTable(v: any): boolean {
  return v && typeof v === 'object' && Array.isArray(v.columns) && Array.isArray(v.rows)
}

// 数值化
function toNum(v: any): number {
  if (v === null || v === undefined) return 0
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  const n = Number(v)
  return isNaN(n) ? 0 : n
}
// 汇总一个源结果的所有数值（供饼图切片）
function tableNumericSum(result: any): number {
  if (!result) return 0
  if (result.type === 'value') return toNum(result.value)
  if (result.type === 'param') return (result.params || []).reduce((s: number, p: any) => s + toNum(p.value), 0)
  if (isTable(result)) {
    let sum = 0
    for (const row of result.rows) {
      for (const k of Object.keys(row || {})) sum += toNum(row[k])
    }
    return sum
  }
  return 0
}

// ==================== 拓扑排序 ====================
function topoSort(model: Model): DcNode[] {
  const nodes = model.nodes
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0]))
  const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]))
  const flowTargets = new Set<string>()

  for (const e of model.edges) {
    if (e.type !== 'dataflow') continue
    // source 可能形如 'subId:portId'，取子画布节点id
    const src = e.source.split(':')[0]
    if (!byId.has(src) || !byId.has(e.target)) continue
    if (!adj.has(src)) adj.set(src, [])
    adj.get(src)!.push(e.target)
    indeg.set(e.target, (indeg.get(e.target) || 0) + 1)
    flowTargets.add(e.target)
  }

  const queue: string[] = []
  indeg.forEach((d, id) => { if (d === 0) queue.push(id) })
  const order: DcNode[] = []
  while (queue.length) {
    const id = queue.shift()!
    const node = byId.get(id)
    if (node) order.push(node)
    for (const t of adj.get(id) || []) {
      indeg.set(t, (indeg.get(t) || 0) - 1)
      if (indeg.get(t) === 0) queue.push(t)
    }
  }
  // 环或孤立节点兜底
  const visited = new Set(order.map((n) => n.id))
  for (const n of nodes) if (!visited.has(n.id)) order.push(n)
  return order
}

// ==================== 主计算入口 ====================
export function computeModel(model: Model | null, allModels: Model[]): ComputeResults {
  if (!model) return {}
  const results: ComputeResults = {}
  const order = topoSort(model)
  const incomingMap: Record<string, DcEdge[]> = {}
  for (const e of model.edges) {
    if (e.type === 'dataflow') {
      ;(incomingMap[e.target] ||= []).push(e)
    }
  }
  for (const node of order) {
    try {
      results[node.id] = computeNode(node, incomingMap[node.id] || [], results, model, allModels)
    } catch (err: any) {
      results[node.id] = { error: err?.message || String(err) }
    }
  }
  return results
}

// ==================== 节点计算 ====================
function computeNode(
  node: DcNode,
  incoming: DcEdge[],
  results: ComputeResults,
  model: Model,
  allModels: Model[],
): any {
  switch (node.type) {
    case 'parameter':
      return { type: 'param', params: node.data.params || [] }

    case 'table': {
      const columns: string[] = node.data.columns || []
      const rawRows: any[] = node.data.rows || []
      // 兼容数组行（按列名转对象）与对象行，保证下游可用 row[列名] 取值
      const rows = rawRows.map((r: any) => {
        if (Array.isArray(r)) {
          const obj: Record<string, any> = {}
          columns.forEach((c, idx) => { obj[c] = r[idx] })
          return obj
        }
        return { ...r }
      })
      return { type: 'table', columns, rows }
    }

    case 'subcanvas': {
      const sub = allModels.find((m) => m.id === node.data.modelId)
      if (!sub) return { type: 'subcanvas', ports: {} }
      const subResults = computeModel(sub, allModels)
      // 收集所有内部节点结果作为可暴露端口；参数节点额外为每个参数生成子端口（nodeId:paramKey）
      const ports: Record<string, any> = {}
      for (const n of sub.nodes) {
        ports[n.id] = subResults[n.id]
        if (n.type === 'parameter') {
          const ps = subResults[n.id]?.params || n.data.params || []
          for (const p of ps) {
            if (p.key) ports[`${n.id}:${p.key}`] = { type: 'value', value: p.value }
          }
        }
      }
      return { type: 'subcanvas', ports }
    }

    case 'sql': {
      // 收集输入表：同时以源节点 id 与名称为键（SQL 中可用节点名引用）
      const tables: Record<string, any> = {}
      const nameById: Record<string, string> = {}
      for (const n of model.nodes) nameById[n.id] = n.name
      for (const e of incoming) {
        const srcId = e.source.split(':')[0]
        const srcRes = resolveSource(results, e)
        if (srcRes && isTable(srcRes)) {
          tables[srcId] = srcRes
          if (nameById[srcId]) tables[nameById[srcId]] = srcRes
        }
      }
      // 表关联（relation）连线涉及的表：供 JOIN 引用（直接读取表节点数据，避免依赖计算顺序）
      for (const e of model.edges) {
        if (e.type !== 'relation') continue
        const ids = [e.source.split(':')[0], e.target.split(':')[0]]
        for (const id of ids) {
          if (tables[id] || tables[nameById[id]]) continue
          const tn = model.nodes.find((n) => n.id === id)
          if (tn && tn.type === 'table') {
            const t = { type: 'table', columns: tn.data.columns || [], rows: (tn.data.rows || []).map((r: any) => ({ ...r })) }
            tables[id] = t
            if (nameById[id]) tables[nameById[id]] = t
          }
        }
      }
      const sql = node.data.sql || ''
      const out = executeSQL(sql, tables, node)
      return { type: 'table', ...out }
    }

    case 'variable': {
      // 收集输入值：优先使用端口名（参数 key/列名）；参数节点整表连接时展开为各参数变量
      const inputs: Record<string, any> = {}
      const nodeNameById: Record<string, string> = {}
      for (const n of model.nodes) nodeNameById[n.id] = n.name
      // 输入值数值化：形如 '5'/'3.14' 的字符串自动转 number，避免 a+b 变成字符串拼接
      const toNumeric = (v: any): any => {
        if (typeof v === 'number') return v
        if (typeof v === 'string' && v.trim() !== '') {
          const n = Number(v)
          if (!isNaN(n)) return n
        }
        return v
      }
      const put = (baseName: string, value: any) => {
        let name = baseName
        let k = 1
        while (name in inputs) name = `${baseName}_${k++}`
        inputs[name] = toNumeric(value)
      }
      for (const e of incoming) {
        const [srcId, portId] = splitSource(e.source)
        const srcRes = resolveSource(results, e)
        if (srcRes === undefined) continue
        if (srcRes.type === 'param' && !portId) {
          // 参数节点整表连接：每个参数作为一个独立输入变量
          for (const p of srcRes.params || []) {
            if (p.key) put(String(p.key), p.value)
          }
        } else {
          // 子画布参数端口 nodeId:paramKey → 取最后一段 paramKey 作为变量名
          const vname = portId ? String(portId).split(':').pop() || portId : nodeNameById[srcId] || srcId
          put(vname, unwrapValue(srcRes))
        }
      }
      const formula = node.data.formula || ''
      const value = evaluateFormula(formula, inputs)
      return { type: 'value', value }
    }

    case 'chart': {
      // 收集所有输入源
      const sources: { edge: DcEdge; result: any }[] = []
      for (const e of incoming) {
        const srcRes = resolveSource(results, e)
        if (srcRes !== undefined) sources.push({ edge: e, result: srcRes })
      }
      const source = sources.find((s) => isTable(s.result))?.result || null
      // 多条连线（柱状/折线/饼图通用）：每条连线一个类别（key=端口名/源节点名，值=该源数值和）
      // 仅支持数值形式输入（参数/变量）；单条连线走 source 表格 + 标签字段
      let multiSeries: { key: string; value: number }[] = []
      if (sources.length >= 2) {
        const nodeNameById: Record<string, string> = {}
        for (const n of model.nodes) nodeNameById[n.id] = n.name
        multiSeries = sources
          .map(({ edge, result }) => {
            const [srcId, portId] = splitSource(edge.source)
            // 端口 id 可能含冒号（子画布参数端口 nodeId:paramKey），取最后一段作为类别名
            const key = portId ? String(portId).split(':').pop() || nodeNameById[srcId] || srcId : nodeNameById[srcId] || srcId
            return { key, value: tableNumericSum(result) }
          })
          .filter((s) => s.value !== 0)
      }
      return { type: 'chart', source, sources, multiSeries, config: { ...node.data } }
    }

    default:
      return { type: 'unknown' }
  }
}

// 拆分连线源：srcId:portId（端口 id 可能含冒号，如子画布参数端口 nodeId:paramKey，只拆第一段冒号）
function splitSource(source: string): [string, string | undefined] {
  const idx = source.indexOf(':')
  return idx >= 0 ? [source.slice(0, idx), source.slice(idx + 1)] : [source, undefined]
}

// 解析连线源：dataflow 支持 nodeId:portId 多端口；子画布端口从 ports 取值
function resolveSource(results: ComputeResults, edge: DcEdge): any {
  const [srcId, portId] = splitSource(edge.source)
  const base = results[srcId]
  if (edge.type === 'dataflow' && portId && base) {
    // 子画布：端口为内部节点/参数端口 → 从 ports 取值
    if (base.type === 'subcanvas' && base.ports) {
      return base.ports[portId]
    }
    // 参数节点：端口为参数 key → 返回该参数值
    if (base.type === 'param') {
      const p = (base.params || []).find((x: any) => x.key === portId)
      return { type: 'value', value: p ? p.value : undefined }
    }
    // 表节点：端口为列名 → 返回该列值数组
    if (base.type === 'table') {
      const values = base.rows.map((r: any) => r[portId])
      return { type: 'value', value: values }
    }
  }
  return base
}

// 解包：value 结果取 value 字段，param 取 params
function unwrapValue(v: any): any {
  if (v && typeof v === 'object') {
    if ('value' in v && 'type' in v && v.type === 'value') return v.value
    if (v.type === 'param') {
      // 参数集合 → 对象
      const obj: Record<string, any> = {}
      for (const p of v.params || []) obj[p.key] = p.value
      return obj
    }
  }
  return v
}

// ==================== 公式计算 ====================
function evaluateFormula(formula: string, inputs: Record<string, any>): any {
  if (!formula) return undefined
  const argNames = Object.keys(inputs)
  const argVals = argNames.map((k) => inputs[k])
  const sum = (arr: any[]) => (arr || []).reduce((s: number, x: any) => s + (Number(x) || 0), 0)
  const helpers: Record<string, any> = {
    SUM: sum,
    AVG: (arr: any[]) => (arr && arr.length ? sum(arr) / arr.length : 0),
    MIN: (arr: any[]) => (arr && arr.length ? Math.min(...arr.map(Number)) : 0),
    MAX: (arr: any[]) => (arr && arr.length ? Math.max(...arr.map(Number)) : 0),
    COUNT: (arr: any[]) => (arr ? arr.length : 0),
    ABS: Math.abs, ROUND: Math.round, FLOOR: Math.floor, CEIL: Math.ceil,
  }
  try {
    const fn = new Function(...argNames, 'helpers', `with(helpers){ return (${formula}); }`)
    return fn(...argVals, helpers)
  } catch (e: any) {
    return { error: `公式错误: ${e?.message}` }
  }
}

// ==================== 轻量级 SQL 引擎 ====================
// 支持子集：SELECT 列/聚合/表达式 AS 别名 FROM t1, t2 [WHERE 条件] [GROUP BY 列] [ORDER BY 列 ASC|DESC] [LIMIT n]
// 支持 JOIN 语法：FROM a JOIN b ON 条件

function tokenize(sql: string): string[] {
  const tokens: string[] = []
  let i = 0
  const s = sql
  while (i < s.length) {
    const c = s[i]
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r') { i++; continue }
    // 反引号/双引号均视为标识符引用（去掉包裹符），如 `价格`、"设备价格构成"
    if (c === '`' || c === '"') {
      const quote = c
      let j = i + 1
      while (j < s.length && s[j] !== quote) j++
      tokens.push(s.slice(i + 1, j))
      i = j + 1
      continue
    }
    // 单引号为字符串字面量（保留引号，用于值比较）
    if (c === "'") {
      let j = i + 1
      while (j < s.length && s[j] !== "'") j++
      tokens.push(`'${s.slice(i + 1, j)}'`)
      i = j + 1
      continue
    }
    // 标识符：字母 / 下划线 / $ / 中文字符
    if (/[A-Za-z_$\u4e00-\u9fa5]/.test(c)) {
      let j = i
      while (j < s.length && /[A-Za-z0-9_$.\u4e00-\u9fa5]/.test(s[j])) j++
      tokens.push(s.slice(i, j))
      i = j
      continue
    }
    if (/[0-9]/.test(c)) {
      let j = i
      while (j < s.length && /[0-9.]/.test(s[j])) j++
      tokens.push(s.slice(i, j))
      i = j
      continue
    }
    if (s.startsWith('!=', i) || s.startsWith('<=', i) || s.startsWith('>=', i) || s.startsWith('<>', i)) {
      tokens.push(s.slice(i, i + 2))
      i += 2
      continue
    }
    tokens.push(c)
    i++
  }
  return tokens
}

interface PExpr { op: string; left: any; right: any }

class Parser {
  toks: string[]
  pos = 0
  constructor(toks: string[]) { this.toks = toks }
  peek() { return this.toks[this.pos] }
  next() { return this.toks[this.pos++] }
  eof() { return this.pos >= this.toks.length }
  eat(t: string) { if (this.peek() === t) { this.pos++; return true } return false }

  // 或
  parseOr(): PExpr | any {
    let left = this.parseAnd()
    while (this.peek()?.toUpperCase() === 'OR') { this.next(); const right = this.parseAnd(); left = { op: 'OR', left, right } }
    return left
  }
  // 与
  parseAnd(): PExpr | any {
    let left = this.parseCmp()
    while (this.peek()?.toUpperCase() === 'AND') { this.next(); const right = this.parseCmp(); left = { op: 'AND', left, right } }
    return left
  }
  // 比较
  parseCmp(): any {
    const left = this.parsePrimary()
    const t = this.peek()
    if (t === '=' || t === '!=' || t === '<>' || t === '<' || t === '>' || t === '<=' || t === '>=') {
      this.next()
      return { op: t === '<>' ? '!=' : t, left, right: this.parsePrimary() }
    }
    if (t?.toUpperCase() === 'LIKE') { this.next(); return { op: 'LIKE', left, right: this.parsePrimary() } }
    if (t?.toUpperCase() === 'IN') {
      this.next()
      const items: any[] = []
      if (this.eat('(')) {
        while (!this.eat(')')) { items.push(this.parsePrimary()); this.eat(',') }
      }
      return { op: 'IN', left, right: items }
    }
    if (t?.toUpperCase() === 'IS') {
      this.next()
      const neg = this.eat('NOT')
      if (this.peek()?.toUpperCase() === 'NULL') { this.next(); return { op: 'ISNULL', left, neg } }
      return { op: 'IS', left, neg, right: this.parsePrimary() }
    }
    return left
  }
  // 主表达式（标识符 / 数字 / 字符串 / 括号）
  parsePrimary(): any {
    const t = this.peek()
    if (t === '(') { this.next(); const e = this.parseOr(); this.eat(')'); return e }
    if (t === undefined) return undefined
    if (/^[0-9]/.test(t)) { this.next(); return { kind: 'num', val: Number(t) } }
    if (t.startsWith("'")) { this.next(); return { kind: 'str', val: t.slice(1, -1) } }
    if (t === '*') { this.next(); return { kind: 'star' } }
    this.next()
    return { kind: 'col', name: t }
  }
}

function evalWhere(expr: any, row: Record<string, any>, tableAlias?: string): boolean {
  if (!expr) return true
  if (expr.op === 'AND') return evalWhere(expr.left, row) && evalWhere(expr.right, row)
  if (expr.op === 'OR') return evalWhere(expr.left, row) || evalWhere(expr.right, row)
  const lv = exprVal(expr.left, row)
  if (expr.op === '=') return lv === exprVal(expr.right, row)
  if (expr.op === '!=') return lv !== exprVal(expr.right, row)
  if (expr.op === '<') return lv < exprVal(expr.right, row)
  if (expr.op === '>') return lv > exprVal(expr.right, row)
  if (expr.op === '<=') return lv <= exprVal(expr.right, row)
  if (expr.op === '>=') return lv >= exprVal(expr.right, row)
  if (expr.op === 'LIKE') {
    const pat = String(exprVal(expr.right, row)).replace(/%/g, '.*').replace(/_/g, '.')
    return new RegExp(`^${pat}$`, 'i').test(String(lv))
  }
  if (expr.op === 'IN') return (expr.right || []).some((x: any) => exprVal(x, row) === lv)
  if (expr.op === 'ISNULL') return expr.neg ? lv !== null && lv !== undefined : lv === null || lv === undefined
  return true
}

function exprVal(e: any, row: Record<string, any>): any {
  if (!e) return null
  if (e.kind === 'num') return e.val
  if (e.kind === 'str') return e.val
  if (e.kind === 'col') {
    // 支持 a.col 或 col
    const name = e.name
    if (name.includes('.')) return row[name.split('.')[1]]
    return row[name]
  }
  if (e.op) return e // 复合表达式不支持，返回对象（通常不会出现）
  return null
}

interface SqlSelectItem {
  raw: string
  agg: string | null
  col: string | null
  alias: string | null
}

function parseSelectItems(toks: string[], from: number): { items: SqlSelectItem[]; next: number } {
  const items: SqlSelectItem[] = []
  let i = from
  while (i < toks.length) {
    const start = i
    let agg: string | null = null
    let col: string | null = null
    const t = toks[i]
    if (['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'].includes(t?.toUpperCase())) {
      agg = t.toUpperCase()
      i++
      if (toks[i] === '(') {
        i++
        col = toks[i]
        if (col?.toUpperCase() === 'DISTINCT') { i++; col = toks[i] }
        i++
        if (toks[i] === ')') i++
      }
    } else if (t === '*') {
      col = '*'
      i++
    } else if (t) {
      // 列名（可能为 col AS alias 或 col alias）
      col = t
      i++
    } else {
      break
    }
    // 统一处理 AS alias / 直接 alias
    let alias: string | null = null
    if (toks[i]?.toUpperCase() === 'AS') {
      i++
      alias = toks[i]
      i++
    } else if (toks[i] && !/[,)]/.test(toks[i]) && !['FROM', 'WHERE', 'GROUP', 'ORDER', 'LIMIT', 'JOIN', 'ON'].includes(toks[i].toUpperCase())) {
      alias = toks[i]
      i++
    }
    items.push({ raw: toks.slice(start, i).join(' '), agg, col, alias })
    if (toks[i] === ',') i++
    else break
  }
  return { items, next: i }
}

function executeSQL(sql: string, tables: Record<string, any>, node: DcNode): { columns: string[]; rows: any[] } {
  const toks = tokenize(sql || '')
  const empty = { columns: [] as string[], rows: [] as any[][] }
  if (!toks.length) return empty
  // 期望以 SELECT 开头
  let i = 0
  if (toks[0]?.toUpperCase() !== 'SELECT') return { ...empty, columns: ['错误'], rows: [['SQL 必须以 SELECT 开头']] }
  i++
  const { items, next } = parseSelectItems(toks, i)
  i = next

  // 解析 FROM / JOIN
  const tableNames: string[] = []
  const joinClauses: { on: string }[] = []
  if (toks[i]?.toUpperCase() === 'FROM') {
    i++
    while (i < toks.length) {
      const t = toks[i]
      if (t?.toUpperCase() === 'JOIN') {
        i++
        const tn = toks[i]
        if (tn) { tableNames.push(tn); i++ }
        if (toks[i]?.toUpperCase() === 'ON') {
          i++
          let expr = ''
          while (i < toks.length && !['WHERE', 'GROUP', 'ORDER', 'LIMIT'].includes(toks[i].toUpperCase())) { expr += toks[i]; i++ }
          joinClauses.push({ on: expr })
        }
        continue
      }
      if (t && !['WHERE', 'GROUP', 'ORDER', 'LIMIT', 'JOIN', 'ON'].includes(t.toUpperCase())) {
        tableNames.push(t)
        i++
        if (toks[i] === ',') i++
        continue
      }
      break
    }
  }

  // 解析 WHERE / GROUP BY / ORDER BY / LIMIT
  let whereExpr: any = null
  const groupCols: string[] = []
  const orderBy: { col: string; dir: 'ASC' | 'DESC' }[] = []
  let limit: number | null = null

  if (toks[i]?.toUpperCase() === 'WHERE') {
    i++
    let j = i
    while (j < toks.length && !['GROUP', 'ORDER', 'LIMIT'].includes(toks[j].toUpperCase())) j++
    whereExpr = new Parser(toks.slice(i, j)).parseOr()
    i = j
  }
  if (toks[i]?.toUpperCase() === 'GROUP') {
    i++
    if (toks[i]?.toUpperCase() === 'BY') i++
    while (i < toks.length && toks[i] !== ',' && !['ORDER', 'LIMIT'].includes(toks[i]?.toUpperCase() || '')) {
      groupCols.push(toks[i]); i++
      if (toks[i] === ',') i++
      else break
    }
  }
  if (toks[i]?.toUpperCase() === 'ORDER') {
    i++
    if (toks[i]?.toUpperCase() === 'BY') i++
    while (i < toks.length) {
      const col = toks[i]; if (!col) break
      let dir: 'ASC' | 'DESC' = 'ASC'
      i++
      if (toks[i]?.toUpperCase() === 'ASC') { i++ }
      else if (toks[i]?.toUpperCase() === 'DESC') { dir = 'DESC'; i++ }
      orderBy.push({ col, dir })
      if (toks[i] === ',') i++
      else break
    }
  }
  if (toks[i]?.toUpperCase() === 'LIMIT') {
    i++
    limit = parseInt(toks[i], 10) || 0
  }

  // 组装数据源（FROM 多表 / JOIN）
  let source: Record<string, any>[] = []
  const sourceCols: string[] = []
  for (const tn of tableNames) {
    const t = tables[tn] || { columns: [], rows: [] }
    if (!sourceCols.length) {
      source = t.rows.map((r: any) => ({ ...r }))
      sourceCols.push(...(t.columns || []))
    } else {
      // 隐式笛卡尔积
      const merged: Record<string, any>[] = []
      for (const a of source) for (const b of t.rows) merged.push({ ...a, ...b })
      source = merged
      sourceCols.push(...(t.columns || []))
    }
  }

  // JOIN ON 过滤（简化为对合并行做表达式求值）
  if (joinClauses.length) {
    for (const jc of joinClauses) {
      try {
        const expr = new Parser(tokenize(jc.on)).parseOr()
        source = source.filter((row) => evalWhere(expr, row))
      } catch { /* ignore */ }
    }
  }

  // WHERE 过滤
  if (whereExpr) {
    try {
      source = source.filter((row) => evalWhere(whereExpr, row))
    } catch (e: any) {
      return { ...empty, columns: ['错误'], rows: [[`WHERE 解析失败: ${e?.message}`]] }
    }
  }

  // GROUP BY 聚合
  if (groupCols.length) {
    const groups = new Map<string, Record<string, any>[]>()
    for (const row of source) {
      const key = groupCols.map((c) => String(row[c] ?? '')).join('\u0001')
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(row)
    }
    source = Array.from(groups.entries()).map(([key, rows]) => {
      const first: Record<string, any> = { ...rows[0] }
      groupCols.forEach((c, idx) => { first[c] = key.split('\u0001')[idx] })
      return { __groupRows: rows, ...first }
    })
  }

  // ORDER BY
  if (orderBy.length) {
    source = [...source].sort((a, b) => {
      for (const ob of orderBy) {
        const av = a[ob.col]; const bv = b[ob.col]
        let r = 0
        if (av == null && bv == null) r = 0
        else if (av == null) r = -1
        else if (bv == null) r = 1
        else if (typeof av === 'number' && typeof bv === 'number') r = av - bv
        else r = String(av).localeCompare(String(bv))
        if (r !== 0) return ob.dir === 'DESC' ? -r : r
      }
      return 0
    })
  }

  // LIMIT
  if (limit != null && limit > 0) source = source.slice(0, limit)

  // 生成输出列
  const outCols: string[] = []
  const outRows: any[][] = []
  for (const item of items) {
    outCols.push(item.alias || item.col || item.raw)
  }
  const computeAgg = (agg: string, vals: number[]): number => {
    switch (agg) {
      case 'COUNT': return vals.length
      case 'SUM': return vals.reduce((s: number, x: number) => s + x, 0)
      case 'AVG': return vals.length ? vals.reduce((s: number, x: number) => s + x, 0) / vals.length : 0
      case 'MIN': return vals.length ? Math.min(...vals) : 0
      case 'MAX': return vals.length ? Math.max(...vals) : 0
      default: return 0
    }
  }
  const buildRow = (row: Record<string, any>, groupRows?: Record<string, any>[]): any[] => {
    const outRow: any[] = []
    for (const item of items) {
      if (item.agg) {
        const col = item.col
        const rows = groupRows && groupRows.length ? groupRows : [row]
        const vals = col === '*'
          ? rows.map(() => 1)
          : rows.map((r) => (col ? Number(r[col]) || 0 : 0))
        outRow.push(computeAgg(item.agg, vals))
      } else if (item.col === '*') {
        for (const c of sourceCols) outRow.push(row[c])
      } else if (item.col) {
        outRow.push(row[item.col])
      } else {
        outRow.push(null)
      }
    }
    return outRow
  }
  const hasAgg = items.some((it) => it.agg)
  if (hasAgg && !groupCols.length) {
    // 无 GROUP BY 的聚合：全表聚合成一行（如 SELECT SUM(col) FROM t）
    if (source.length) outRows.push(buildRow(source[0], source))
  } else {
    for (const row of source) outRows.push(buildRow(row, row.__groupRows))
  }

  // 处理 SELECT * 时列名
  let finalCols = outCols
  if (items.length === 1 && items[0].col === '*') finalCols = sourceCols

  // 数组行 → 对象行（键为列名），与数据表节点格式一致，保证 row[列名] 可访问
  const rows = outRows.map((r) => {
    const obj: Record<string, any> = {}
    finalCols.forEach((c, idx) => { obj[c] = r[idx] })
    return obj
  })

  return { columns: finalCols, rows }
}
