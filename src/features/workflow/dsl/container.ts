/**
 * 容器（迭代 / 循环）的公共约定
 *
 * 与 Dify 一致的两条规则：
 * 1. 子节点通过 `parentId` 归属容器，同时带 `data.isInIteration/isInLoop` 标记
 * 2. 容器内有一个合成入口节点，id 为 `<容器id>start`，类型 `iteration-start` / `loop-start`，
 *    它暴露内部变量（迭代：`item` / `index`；循环：`index` 与循环变量）
 *
 * 容器 → 入口节点的那条边**不写入 DSL**（Dify 也是在加载时合成的），因此这里不生成边。
 */

import type { DslNode } from './types'

/** 容器节点类型 */
export const CONTAINER_TYPES = ['iteration', 'loop'] as const

/** 容器入口节点类型 */
export const CONTAINER_ENTRY_BY_TYPE: Record<string, string> = {
  iteration: 'iteration-start',
  loop: 'loop-start',
}

export function isContainerType(type: string): boolean {
  return (CONTAINER_TYPES as readonly string[]).includes(type)
}

export function isContainerEntryType(type: string): boolean {
  return type === 'iteration-start' || type === 'loop-start'
}

/** 容器入口节点 id 约定 */
export function containerEntryId(containerId: string): string {
  return `${containerId}start`
}

/** 容器的直接子节点 */
export function containerChildren(nodes: DslNode[], containerId: string): DslNode[] {
  return nodes.filter((n) => n.parentId === containerId)
}

/** 解析容器入口节点：优先节点上显式记录的 start_node_id，其次按 id 约定 */
export function resolveContainerEntry(
  nodes: DslNode[],
  containerId: string,
  explicit?: unknown,
): DslNode | undefined {
  if (typeof explicit === 'string' && explicit) {
    const byId = nodes.find((n) => n.id === explicit)
    if (byId) return byId
  }
  const byConvention = nodes.find((n) => n.id === containerEntryId(containerId))
  if (byConvention) return byConvention
  return nodes.find((n) => n.parentId === containerId && isContainerEntryType(String(n.data.type)))
}
