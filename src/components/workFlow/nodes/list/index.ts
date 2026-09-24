/**
 * list executor - 列表操作节点
 *
 * 对数组输入按顺序应用操作步骤：
 * - filter   : 按字段/运算符过滤（eq/neq/contains/gt/gte/lt/lte/is_empty/is_not_empty/exists）
 * - extract  : 仅保留指定字段
 * - sort     : 按字段升/降序
 * - limit    : 截取前 N 项
 * - unique   : 按字段（或整体）去重
 * - slice    : 取 [start, end) 区间
 */
import type { NodeExecutor, ExecutionContext } from '@/components/workFlow/engine/NodeExecutor'
import type { NodeData } from '@/components/workFlow/engine/WorkflowRunner'
import type { ListOpStep } from '@/components/workFlow/WorkflowTypes'
import { resolveArrayInput } from '@/components/workFlow/engine/executorHelpers'

function getField(item: any, field?: string): any {
  if (!field) return item
  return field.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), item)
}

function applyOp(list: any[], op: ListOpStep): any[] {
  switch (op.op) {
    case 'filter': {
      const field = op.field
      const val = (op.value || '').trim()
      const operator = op.operator || 'eq'
      const numVal = Number(val)
      const hasNum = val !== '' && !isNaN(numVal)
      return list.filter(item => {
        const fv = getField(item, field)
        const fvStr = fv === null || fv === undefined ? '' : String(fv)
        switch (operator) {
          case 'eq': return hasNum && typeof fv === 'number' ? fv === numVal : fvStr === val
          case 'neq': return hasNum && typeof fv === 'number' ? fv !== numVal : fvStr !== val
          case 'contains': return fvStr.includes(val)
          case 'gt': return hasNum ? (typeof fv === 'number' ? fv : Number(fvStr)) > numVal : false
          case 'gte': return hasNum ? (typeof fv === 'number' ? fv : Number(fvStr)) >= numVal : false
          case 'lt': return hasNum ? (typeof fv === 'number' ? fv : Number(fvStr)) < numVal : false
          case 'lte': return hasNum ? (typeof fv === 'number' ? fv : Number(fvStr)) <= numVal : false
          case 'is_empty': return fv === null || fv === undefined || fvStr === ''
          case 'is_not_empty': return fv !== null && fv !== undefined && fvStr !== ''
          case 'exists': return fv !== undefined
          default: return true
        }
      })
    }
    case 'extract': {
      const fields = op.fields || []
      if (fields.length === 0) return list
      return list.map(item => {
        if (typeof item !== 'object' || item === null) return item
        const out: Record<string, any> = {}
        for (const f of fields) out[f] = getField(item, f)
        return out
      })
    }
    case 'sort': {
      const field = op.field
      const order = op.order || 'asc'
      const dir = order === 'asc' ? 1 : -1
      return [...list].sort((a, b) => {
        const av = getField(a, field)
        const bv = getField(b, field)
        if (av === bv) return 0
        if (av === null || av === undefined) return -dir
        if (bv === null || bv === undefined) return dir
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
        return String(av).localeCompare(String(bv)) * dir
      })
    }
    case 'limit':
      return list.slice(0, Math.max(0, op.n || 0))
    case 'unique': {
      const field = op.field
      const seen = new Set<string>()
      const out: any[] = []
      for (const item of list) {
        const key = field ? JSON.stringify(getField(item, field)) : JSON.stringify(item)
        if (!seen.has(key)) { seen.add(key); out.push(item) }
      }
      return out
    }
    case 'slice': {
      const start = Math.max(0, op.start || 0)
      const end = op.end !== undefined && op.end >= 0 ? op.end : undefined
      return end === undefined ? list.slice(start) : list.slice(start, end)
    }
    default:
      return list
  }
}

export const listExecutor: NodeExecutor = {
  type: 'list',
  label: '列表操作节点',
  async execute(node: NodeData, ctx: ExecutionContext): Promise<boolean> {
    const cfg = node.listOpConfig || {}
    const ops: ListOpStep[] = cfg.operations || []

    let list: any[]
    try {
      list = await resolveArrayInput(cfg.inputList, ctx, node.id, ctx.t)
    } catch (e: any) {
      node.result = JSON.stringify({ result: `${ctx.t('list_input_error')}: ${e?.message}`, type: 'list', success: false, error: e?.message, timestamp: new Date().toISOString() })
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }

    try {
      for (const op of ops) {
        list = applyOp(list, op)
      }
      // 全量结果进运行期缓存（node.result 只留预览，避免大数组撑大 .flow/内存）
      ctx.setArrayCache?.(node.id, list)
      const PREVIEW_N = 20
      node.result = JSON.stringify({
        type: 'list', success: true,
        result: `${ctx.t('list_done')}：${list.length} 项`,
        output: list.slice(0, PREVIEW_N),
        outputCached: true, outputCount: list.length,
        count: list.length,
        first: list[0] ?? null, last: list[list.length - 1] ?? null,
        timestamp: new Date().toISOString()
      })
      node.status = 'success'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'success', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'success', node.result)
      return true
    } catch (e: any) {
      node.result = JSON.stringify({ result: `${ctx.t('list_error')}: ${e?.message}`, type: 'list', success: false, error: e?.message, timestamp: new Date().toISOString() })
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }
  }
}
