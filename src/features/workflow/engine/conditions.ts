/**
 * if-else 的条件求值
 *
 * 对齐 Dify 的 condition 结构：
 * `{ id, comparison_operator, variable_selector, value, varType, sub_variable_condition? }`
 * 一个 case 内的多个条件用 `logical_operator`（and / or）组合。
 */

import type { ValueSelector } from '../dsl/types'

/** 条件求值只需要「按 selector 取值」这一能力，便于列表操作等场景传入自定义取数逻辑 */
export interface VariableReader {
  get(selector: ValueSelector | undefined | null): unknown
}

export interface Condition {
  id?: string
  comparison_operator?: string
  variable_selector?: ValueSelector
  value?: unknown
  varType?: string
  sub_variable_condition?: {
    logical_operator?: 'and' | 'or'
    conditions?: Condition[]
  }
}

export interface ConditionCase {
  case_id?: string
  logical_operator?: 'and' | 'or'
  conditions?: Condition[]
}

/** 单条条件求值 */
export function evaluateCondition(condition: Condition, pool: VariableReader): boolean {
  const operator = String(condition.comparison_operator ?? '')
  const left = pool.get(condition.variable_selector)
  const right = condition.value

  // 先处理不需要右侧值的运算符
  if (operator === 'empty') return isEmpty(left)
  if (operator === 'not empty') return !isEmpty(left)
  if (operator === 'null') return left === null || left === undefined
  if (operator === 'not null') return !(left === null || left === undefined)
  if (operator === 'exists') return left !== undefined && left !== ''
  if (operator === 'not exists') return left === undefined || left === ''

  const leftText = toText(left)
  const rightText = toText(right)
  const leftNumber = toNumber(left)
  const rightNumber = toNumber(right)

  switch (operator) {
    case 'contains':
      return leftText.includes(rightText)
    case 'not contains':
      return !leftText.includes(rightText)
    case 'start with':
      return leftText.startsWith(rightText)
    case 'end with':
      return leftText.endsWith(rightText)
    case 'is':
    case '=':
      return numericAwareEqual(left, right, leftText, rightText)
    case 'is not':
    case '≠':
      return !numericAwareEqual(left, right, leftText, rightText)
    case '>':
      return leftNumber !== undefined && rightNumber !== undefined && leftNumber > rightNumber
    case '<':
      return leftNumber !== undefined && rightNumber !== undefined && leftNumber < rightNumber
    case '≥':
      return leftNumber !== undefined && rightNumber !== undefined && leftNumber >= rightNumber
    case '≤':
      return leftNumber !== undefined && rightNumber !== undefined && leftNumber <= rightNumber
    case 'in': {
      const list = Array.isArray(right) ? right : String(rightText).split(',').map((s) => s.trim())
      return list.some((item) => numericAwareEqual(item, left, toText(item), leftText))
    }
    case 'not in': {
      const list = Array.isArray(right) ? right : String(rightText).split(',').map((s) => s.trim())
      return !list.some((item) => numericAwareEqual(item, left, toText(item), leftText))
    }
    case 'all of': {
      const list = Array.isArray(left) ? left : []
      const expected = Array.isArray(right) ? right : String(rightText).split(',').map((s) => s.trim())
      return expected.every((item) => list.some((v) => toText(v) === toText(item)))
    }
    default:
      // 未识别的运算符：不匹配（避免误走分支）
      return false
  }
}

/** 求值一个 case（条件为空视为命中） */
export function evaluateCase(item: ConditionCase, pool: VariableReader): boolean {
  const conditions = item.conditions ?? []
  if (!conditions.length) return true
  const results = conditions.map((condition) => evaluateNested(condition, pool))
  return (item.logical_operator ?? 'and') === 'or' ? results.some(Boolean) : results.every(Boolean)
}

/** 带子条件组的求值（Dify 支持一层子条件） */
function evaluateNested(condition: Condition, pool: VariableReader): boolean {
  const sub = condition.sub_variable_condition
  if (sub?.conditions?.length) {
    const results = sub.conditions.map((item) => evaluateCondition(item, pool))
    return (sub.logical_operator ?? 'and') === 'or' ? results.some(Boolean) : results.every(Boolean)
  }
  return evaluateCondition(condition, pool)
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value as object).length === 0
  return false
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  return String(value)
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** 两侧都能当数字时按数字比较，否则按字符串比较 */
function numericAwareEqual(left: unknown, right: unknown, leftText: string, rightText: string): boolean {
  const leftNumber = toNumber(left)
  const rightNumber = toNumber(right)
  if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber === rightNumber
  return leftText === rightText
}
