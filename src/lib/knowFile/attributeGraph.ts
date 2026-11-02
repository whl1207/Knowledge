/**
 * attributeGraph.ts — 图谱「按字段展开属性」的纯计算
 *
 * 图谱视图把 frontmatter 属性值画成属性节点（字段设置面板里的开关）。这些节点/边是运行时的
 * 派生数据，必须能随时从「基础数据 + 字段开关」整体重建，否则很容易留下僵尸节点、重复边，
 * 或让下一条边指向已被删掉的节点（d3 的 forceLink 会直接抛 `node not found`）。
 *
 * 本模块只做数据变换，不碰 d3 / Vue，便于纯计算自测（attributeGraph.selftest.ts）。
 * 约定：
 *   - 基础节点：type 为 `file` / `folder`；属性节点：type 就是字段名（如 `标签`）。
 *   - 基础边：层级边没有 type；属性边带 type = 字段名（引用边在视图里单独存放，不在这里）。
 *   - `state = 1`：文件 → 属性值；`state = -1`：属性值 → 文件（反向）。
 */

import { attributeItemsOf } from './attributeValues'

/** 属性边 / 边样式统一使用的颜色（属性节点本身仍是默认配色，见 view_graph 的 nodeBaseFill） */
export const ATTRIBUTE_EDGE_COLOR = 'rgba(170, 170, 170, 0.4)'

/** 字段面板里的一项：state 0 = 收起，1 = 展开，-1 = 反向展开 */
export interface AttributeFieldState {
  name: string
  state?: number
}

/**
 * 取边的两端 id。d3 的 forceLink 会把 `source` / `target` 从 id 换成节点对象，
 * 所以两种形态都必须支持（旧实现直接用 `==` 比较数字，重绘后去重就失效了）。
 */
export function linkEndIds(link: any): [any, any] {
  return [link?.source?.id ?? link?.source, link?.target?.id ?? link?.target]
}

/** 是否为图谱的基础节点（文件 / 文件夹）；其余都是派生出来的属性节点 */
export function isBaseGraphNode(node: any): boolean {
  return node?.type === 'file' || node?.type === 'folder'
}

/** 下一个可用节点 id：不能再用 `nodes.length`（删过属性节点后会与已有 id 撞车） */
export function nextNodeId(nodes: any[]): number {
  let max = -1
  for (const node of nodes) {
    const id = Number(node?.id)
    if (Number.isFinite(id) && id > max) max = id
  }
  return max + 1
}

/** 去掉所有属性节点与属性边，只保留文件/文件夹节点和层级边 */
export function stripAttributeGraph(nodes: any[], links: any[]): void {
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (!isBaseGraphNode(nodes[i])) nodes.splice(i, 1)
  }
  for (let i = links.length - 1; i >= 0; i--) {
    if (links[i]?.type) links.splice(i, 1)
  }
}

/**
 * 为单个字段生成属性节点与属性边（就地修改传入的数组）。
 *
 * 同名字段值复用已有节点：既包括另一个字段已经建好的属性节点（`标签: AI` 与 `分类: AI`
 * 共用一个「AI」节点），也包括恰好同名的文件节点——沿用旧行为，让属性指向那个真实条目。
 */
export function buildAttributeExpansion(
  nodes: any[],
  links: any[],
  attribute: string,
  state: 1 | -1,
): void {
  const byLabel = new Map<string, any>()
  for (const node of nodes) {
    if (node && typeof node.label === 'string' && !byLabel.has(node.label)) {
      byLabel.set(node.label, node)
    }
  }

  // 属性边按「源-目标-字段」去重；d3 重绘后端点可能已是节点对象，统一用 id 比较
  const existingEdges = new Set<string>()
  const edgeKey = (s: any, t: any) => `${s}|${t}|${attribute}`
  for (const link of links) {
    const [s, t] = linkEndIds(link)
    existingEdges.add(`${s}|${t}|${link?.type ?? ''}`)
  }

  const hosts = nodes.filter((node: any) =>
    node?.attributes && Object.prototype.hasOwnProperty.call(node.attributes, attribute)
  )
  let id = nextNodeId(nodes)
  for (const host of hosts) {
    for (const item of attributeItemsOf(host.attributes[attribute])) {
      let valueNode = byLabel.get(item)
      if (!valueNode) {
        valueNode = {
          id: id++,
          label: item,
          path: '',
          type: attribute,
          x: Number(host.x) || 0,
          y: Number(host.y) || 0,
          vx: 0,
          vy: 0,
        }
        nodes.push(valueNode)
        byLabel.set(item, valueNode)
      }
      const source = state === 1 ? host.id : valueNode.id
      const target = state === 1 ? valueNode.id : host.id
      if (source === target) continue // 属性值恰好等于文件自身名称：不画自环
      const key = edgeKey(source, target)
      if (existingEdges.has(key)) continue
      existingEdges.add(key)
      links.push({
        id: links.length,
        index: links.length,
        source,
        target,
        type: attribute,
        style: { fill: ATTRIBUTE_EDGE_COLOR, stroke: ATTRIBUTE_EDGE_COLOR },
      })
    }
  }
}

/** 按字段开关整体重建属性图层（重复调用结果一致，不会叠加边或残留节点） */
export function applyAttributeGraph(
  nodes: any[],
  links: any[],
  fields: AttributeFieldState[],
): void {
  stripAttributeGraph(nodes, links)
  for (const field of fields || []) {
    if (!field) continue
    if (field.state === 1 || field.state === -1) {
      buildAttributeExpansion(nodes, links, field.name, field.state === -1 ? -1 : 1)
    }
  }
}
