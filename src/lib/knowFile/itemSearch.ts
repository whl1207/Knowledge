/**
 * itemSearch.ts — 知识管理各视图共用的搜索解析
 *
 * 顶部工具栏只有一个搜索框（文件 / 看板 / 表格 / 图谱 / 地图 / 日历 共用），所以各视图必须用
 * 同一套语法，否则同一个关键词在不同视图里会得到不同结果（例如 `状态:待办` 在表格里能筛、
 * 在看板里却被当成字面量）。语法：
 *
 * - 关键词：文件名 / 路径 / 任意属性值包含它即算命中（空格分隔多个关键词，须全部命中）；
 * - `属性:值`：该属性值包含该值（大小写不敏感），如 `状态:待办`；
 * - `属性>数值`（也支持 `>=` `<` `<=` `=`）：按数值比较，如 `优先级>2`；
 * - 需要含空格的关键词用双引号包起来，如 `"项目 计划"`。
 */

export interface SearchTerm {
  kind: 'text' | 'eq' | 'cmp'
  field?: string
  op?: string
  value: string
  num?: number
}

/** 属性值的展示文本（数组按逗号连接），与各视图表格里的取值展示保持一致 */
export function searchTextOf(v: any): string {
  if (v === undefined || v === null) return ''
  if (Array.isArray(v)) return v.map((x) => String(x)).join(', ')
  return String(v)
}

/** 把搜索框内容解析成条件列表（无搜索时返回空数组 = 命中全部） */
export function parseSearchQuery(query: string): SearchTerm[] {
  const out: SearchTerm[] = []
  const parts = String(query ?? '').match(/(?:[^\s"]+|"[^"]*")+/g) || []
  for (const raw0 of parts) {
    const raw = raw0.replace(/^"|"$/g, '')
    const m = /^([^:><=!]+)(>=|<=|>|<|=|:)(.+)$/.exec(raw)
    if (m && m[3].trim() !== '') {
      const field = m[1].trim()
      const op = m[2]
      const value = m[3].trim()
      if (op === ':') out.push({ kind: 'eq', field, value })
      else out.push({ kind: 'cmp', field, op, value, num: Number(value) })
    } else if (raw.trim()) {
      out.push({ kind: 'text', value: raw.trim() })
    }
  }
  return out
}

/** item：`{ label, path, attributes }`（目录项与图谱节点都用这一份判定） */
export function matchSearchTerms(item: any, terms: SearchTerm[]): boolean {
  if (!terms.length) return true
  const attrs = item?.attributes || {}
  for (const t of terms) {
    if (t.kind === 'text') {
      const q = t.value.toLowerCase()
      if (!q) continue
      let hit =
        String(item?.label ?? '').toLowerCase().includes(q) ||
        String(item?.path ?? '').toLowerCase().includes(q)
      if (!hit) {
        for (const k of Object.keys(attrs)) {
          if (k.toLowerCase().includes(q) || searchTextOf(attrs[k]).toLowerCase().includes(q)) {
            hit = true
            break
          }
        }
      }
      if (!hit) return false
      continue
    }
    const s = searchTextOf(attrs[t.field as string])
    if (t.kind === 'eq') {
      if (!s.toLowerCase().includes(t.value.toLowerCase())) return false
    } else {
      const n = Number(s)
      const target = Number(t.num)
      if (!Number.isFinite(n) || !Number.isFinite(target)) return false
      if (t.op === '>' && !(n > target)) return false
      if (t.op === '>=' && !(n >= target)) return false
      if (t.op === '<' && !(n < target)) return false
      if (t.op === '<=' && !(n <= target)) return false
      if (t.op === '=' && n !== target) return false
    }
  }
  return true
}

/** 只取关键词（用于命中高亮） */
export function searchTextTerms(terms: SearchTerm[]): string[] {
  return terms.filter((t) => t.kind === 'text').map((t) => t.value)
}
