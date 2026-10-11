/** if-else / 循环结束条件可用的比较运算符（对齐 Dify 的 comparison_operator） */

export interface ComparisonOperator {
  value: string
  labelKey: string
  /** 不需要右侧值的运算符 */
  noValue?: boolean
}

export const COMPARISON_OPERATORS: ComparisonOperator[] = [
  { value: 'contains', labelKey: 'cond.contains' },
  { value: 'not contains', labelKey: 'cond.notContains' },
  { value: 'start with', labelKey: 'cond.startWith' },
  { value: 'end with', labelKey: 'cond.endWith' },
  { value: 'is', labelKey: 'cond.is' },
  { value: 'is not', labelKey: 'cond.isNot' },
  { value: 'empty', labelKey: 'cond.isEmpty', noValue: true },
  { value: 'not empty', labelKey: 'cond.isNotEmpty', noValue: true },
  { value: '=', labelKey: 'cond.eq' },
  { value: '≠', labelKey: 'cond.neq' },
  { value: '>', labelKey: 'cond.gt' },
  { value: '<', labelKey: 'cond.lt' },
  { value: '≥', labelKey: 'cond.gte' },
  { value: '≤', labelKey: 'cond.lte' },
  { value: 'in', labelKey: 'cond.in' },
  { value: 'not in', labelKey: 'cond.notIn' },
  { value: 'all of', labelKey: 'cond.allOf' },
  { value: 'exists', labelKey: 'cond.exists', noValue: true },
  { value: 'not exists', labelKey: 'cond.notExists', noValue: true },
  { value: 'null', labelKey: 'cond.isNull', noValue: true },
  { value: 'not null', labelKey: 'cond.isNotNull', noValue: true },
]

/** 该运算符是否需要填右侧值 */
export function needsValue(operator: string | undefined): boolean {
  const found = COMPARISON_OPERATORS.find((item) => item.value === operator)
  return !found?.noValue
}

/** 生成一个稳定的条件 id（Dify 用短 id） */
export function createConditionId(existing: Array<{ id?: string }>): string {
  let index = existing.length + 1
  const used = new Set(existing.map((item) => String(item.id ?? '')))
  while (used.has(String(index))) index++
  return String(index)
}
