/**
 * 变量引用的两种表示与互转（对齐 Dify 的 variableTransformer）
 *
 * - 结构化：`value_selector: ['<nodeId>', 'variableName']`（属性面板里用）
 * - 模板串：`{{#<nodeId>.<variableName>#}}`（提示词/回复文本里用）
 *
 * 命名空间 `sys` / `env` / `conversation` / `rag` 同样是 selector 的第一段。
 */

import {
  CONVERSATION_VARIABLE_NODE_ID,
  ENVIRONMENT_VARIABLE_NODE_ID,
  RAG_PIPELINE_VARIABLE_NODE_ID,
  SYSTEM_VARIABLE_NODE_ID,
  type ValueSelector,
} from './types'

/** Dify 的变量模板正则：{{#nodeId.var#}} */
export const VARIABLE_TEMPLATE_REGEX = /\{\{#([^#{}]+)#\}\}/g

/** 变量命名空间前缀 */
export const VARIABLE_NAMESPACES = [
  SYSTEM_VARIABLE_NODE_ID,
  ENVIRONMENT_VARIABLE_NODE_ID,
  CONVERSATION_VARIABLE_NODE_ID,
  RAG_PIPELINE_VARIABLE_NODE_ID,
] as const

/** selector → `{{#a.b#}}` 模板串 */
export function selectorToTemplate(selector: ValueSelector | undefined | null): string {
  if (!selector || selector.length < 2) return ''
  return `{{#${selector.join('.')}#}}`
}

/** `{{#a.b#}}` → selector；不是模板串时返回 null */
export function templateToSelector(text: string): ValueSelector | null {
  const m = String(text || '').trim().match(/^\{\{#([^#{}]+)#\}\}$/)
  if (!m) return null
  const parts = m[1].split('.')
  return parts.length >= 2 ? parts : null
}

/** 提取文本中所有变量引用 */
export function extractSelectors(text: string): ValueSelector[] {
  const result: ValueSelector[] = []
  const raw = String(text || '')
  for (const m of raw.matchAll(VARIABLE_TEMPLATE_REGEX)) {
    const parts = m[1].split('.')
    if (parts.length >= 2) result.push(parts)
  }
  return result
}

/** 是否属于系统 / 环境等命名空间（不是某个节点的输出） */
export function isNamespaceSelector(selector: ValueSelector | undefined | null): boolean {
  if (!selector || selector.length < 2) return false
  return (VARIABLE_NAMESPACES as readonly string[]).includes(selector[0])
}

/** selector 的稳定字符串键，用于去重与 Map 索引 */
export function selectorKey(selector: ValueSelector | undefined | null): string {
  return selector && selector.length >= 2 ? selector.join('.') : ''
}

/** 在文本光标处插入变量模板，返回新文本与插入后的光标位置 */
export function insertVariableAtCursor(
  text: string,
  cursor: number,
  selector: ValueSelector,
): { text: string; cursor: number } {
  const snippet = selectorToTemplate(selector)
  if (!snippet) return { text, cursor }
  const at = Math.max(0, Math.min(cursor, text.length))
  return {
    text: text.slice(0, at) + snippet + text.slice(at),
    cursor: at + snippet.length,
  }
}
