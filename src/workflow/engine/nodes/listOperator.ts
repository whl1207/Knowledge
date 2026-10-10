/**
 * list-operator（列表操作）执行器
 *
 * 对齐 Dify 的字段结构：`{ variable, filter_by, order_by, limit, extract_by }`
 * 依次执行 过滤 → 排序 → 去重/提取 → 截断，输出 `result`。
 */
import { resolveSelector } from '../template'
import type { NodeExecutionContext, NodeExecutionResult, WorkflowNodeExecutor } from '../types'
import { evaluateCondition, type Condition } from '../conditions'

interface ExtractConfig {
  enabled?: boolean
  value?: string
}

export const listOperatorExecutor: WorkflowNodeExecutor = {
  type: 'list-operator',
  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const data = ctx.node as unknown as Record<string, unknown>
    const raw = resolveSelector(toSelector(data.variable), ctx.pool)

    let items: unknown[]
    if (Array.isArray(raw)) items = [...raw]
    else if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) throw new Error('不是数组')
        items = parsed
      } catch {
        throw new Error('列表输入不是数组（可填 JSON 数组字符串）')
      }
    } else {
      throw new Error('列表输入为空，请检查变量')
    }

    const total = items.length

    // 1. 过滤
    const filterBy = data.filter_by as { enabled?: boolean; conditions?: Condition[]; logical_operator?: 'and' | 'or' } | undefined
    if (filterBy?.enabled && filterBy.conditions?.length) {
      const before = items.length
      items = items.filter((item) => evaluateItemConditions(filterBy.conditions as Condition[], item, filterBy.logical_operator ?? 'and'))
      ctx.log('info', `过滤：${before} → ${items.length}`)
    }

    // 2. 排序
    const orderBy = data.order_by as { enabled?: boolean; value?: string; order?: 'asc' | 'desc' } | undefined
    if (orderBy?.enabled && orderBy.value) {
      const field = String(orderBy.value)
      const direction = orderBy.order === 'desc' ? -1 : 1
      items.sort((a, b) => compareByField(a, b, field) * direction)
      ctx.log('info', `排序：按 ${field} ${orderBy.order === 'desc' ? '降序' : '升序'}`)
    }

    // 3. 去重
    if (data.deduplicate) {
      const seen = new Set<string>()
      items = items.filter((item) => {
        const key = JSON.stringify(item)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    }

    // 4. 提取字段
    const extractBy = data.extract_by as ExtractConfig | undefined
    if (extractBy?.enabled && extractBy.value) {
      const field = String(extractBy.value)
      items = items.map((item) => readField(item, field))
      ctx.log('info', `提取字段 ${field}`)
    }

    // 5. 截断
    const limit = data.limit as { enabled?: boolean; size?: number } | undefined
    if (limit?.enabled && Number(limit.size) > 0) {
      const size = Math.trunc(Number(limit.size))
      if (items.length > size) {
        ctx.log('info', `截断：${items.length} → ${size}`)
        items = items.slice(0, size)
      }
    }

    ctx.log('info', `结果 ${items.length} 项（原 ${total} 项）`)
    return { outputs: { result: items } }
  },
}

/** variable 字段可能是 selector 数组或 "节点.变量" 字符串 */
function toSelector(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[]
  if (typeof raw === 'string' && raw.includes('.')) return raw.split('.')
  return []
}

/** 逐项求值条件：把列表项字段作为取值来源 */
function evaluateItemConditions(conditions: Condition[], item: unknown, logical: 'and' | 'or'): boolean {
  const reader = {
    get: (selector: string[] | undefined | null) => {
      const field = (selector ?? [])[1]
      return field ? readField(item, field) : item
    },
  }
  const results = conditions.map((condition) => evaluateCondition(condition, reader))
  return logical === 'or' ? results.some(Boolean) : results.every(Boolean)
}

function readField(item: unknown, field: string): unknown {
  if (item === null || item === undefined) return undefined
  if (typeof item !== 'object') return undefined
  let current: unknown = item
  for (const segment of field.split('.')) {
    if (current === null || current === undefined) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function compareByField(a: unknown, b: unknown, field: string): number {
  const left = readField(a, field)
  const right = readField(b, field)
  const leftNumber = Number(left)
  const rightNumber = Number(right)
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber
  return String(left ?? '').localeCompare(String(right ?? ''))
}
