/**
 * 模板求值
 *
 * 两种用途：
 * - `resolveText`：把 `{{#节点.变量#}}` 替换成字符串，用于提示词 / 回复正文
 * - `resolveValue`：整串就是一个变量时返回**原始值**（数组、对象不经过字符串化）
 *
 * 找不到的变量：`resolveText` 留空并记录告警；`resolveValue` 返回 undefined。
 */

import type { ValueSelector } from '../dsl/types'
import { VARIABLE_TEMPLATE_REGEX } from '../dsl/variable'
import type { VariablePool } from './variablePool'

export interface ResolveWarning {
  selector: ValueSelector
  reason: 'missing'
}

export interface ResolveResult<T> {
  value: T
  warnings: ResolveWarning[]
}

/** 值转字符串（与 Dify 的插值行为一致：对象按 JSON 展开） */
export function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** 替换文本中的全部变量引用 */
export function resolveText(template: string, pool: VariablePool): ResolveResult<string> {
  const warnings: ResolveWarning[] = []
  const raw = String(template ?? '')
  const value = raw.replace(VARIABLE_TEMPLATE_REGEX, (match, expression: string) => {
    const segments = String(expression).split('.')
    if (segments.length < 2) return match
    const selector: ValueSelector = segments
    const found = pool.get(selector)
    if (found === undefined) {
      warnings.push({ selector, reason: 'missing' })
      return ''
    }
    return stringifyValue(found)
  })
  return { value, warnings }
}

/**
 * 求值单个表达式。
 * - 整串就是变量 → 返回原始值
 * - 纯文本 → 原样返回字符串
 * - 混合文本 → 返回插值后的字符串
 */
export function resolveValue(template: string, pool: VariablePool): ResolveResult<unknown> {
  const raw = String(template ?? '')
  const single = raw.trim().match(/^\{\{#([^#{}]+)#\}\}$/)
  if (single) {
    const segments = single[1].split('.')
    if (segments.length >= 2) {
      const selector: ValueSelector = segments
      const value = pool.get(selector)
      if (value === undefined) return { value: undefined, warnings: [{ selector, reason: 'missing' }] }
      return { value, warnings: [] }
    }
  }
  return resolveText(raw, pool)
}

/** selector 求值（属性面板里的 value_selector 字段） */
export function resolveSelector(selector: ValueSelector | undefined | null, pool: VariablePool): unknown {
  if (!selector || selector.length < 2) return undefined
  return pool.get(selector)
}

/** 把 selector 求值结果转成文本（找不到时返回空串） */
export function resolveSelectorText(selector: ValueSelector | undefined | null, pool: VariablePool): string {
  return stringifyValue(resolveSelector(selector, pool))
}
