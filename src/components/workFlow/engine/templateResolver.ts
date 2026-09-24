/**
 * templateResolver - 模板变量解析器
 *
 * 解析提示词中的 {{nodeName.outputKey}} 语法，
 * 从 VariablePool 中获取上游节点数据。
 *
 * 语法：
 *   {{节点名称}}            → 取该节点的 result 字段
 *   {{节点名称.字段名}}      → 取该节点的指定字段
 *   {{节点名称|result}}       → 取该节点的 result 字段（兼容写法）
 *
 * 示例：
 *   输入: "请根据 {{开始节点}} 的内容回答：{{推理节点.result}}"
 *   输出: "请根据 你好世界 的内容回答：答案是42"
 */

import type { VariablePool } from '@/components/workFlow/engine/VariablePool'
import type { NodeData } from '@/components/workFlow/engine/WorkflowRunner'

type NodeLike = { id: number; name: string; type: string }

// 模板正则：{{name}} 或 {{name.key}} 或 {{name|key}}
const TEMPLATE_REGEX = /\{\{([^}]+)\}\}/g

/** 节点名称归一化：去所有空白并转小写，用于宽松匹配（"步骤 3" ↔ "步骤3"） */
const normalizeNodeName = (name: string): string => name.replace(/\s+/g, '').toLowerCase()

/** 按名称查找节点：精确 → 大小写不敏感 → 忽略空白（兼容带空格/不带空格）→ 数字 ID */
function findNodeByName(nodes: NodeLike[], nodeName: string): NodeLike | undefined {
  let node = nodes.find(n => n.name === nodeName)
  if (!node) node = nodes.find(n => n.name.toLowerCase() === nodeName.toLowerCase())
  if (!node) {
    const target = normalizeNodeName(nodeName)
    node = nodes.find(n => normalizeNodeName(n.name) === target)
  }
  if (!node && /^\d+$/.test(nodeName)) {
    node = nodes.find(n => n.id === parseInt(nodeName))
  }
  return node
}

/**
 * 解析模板字符串中的变量引用，从 VariablePool 填充数据
 *
 * @param template 包含 {{var}} 的模板字符串
 * @param nodes 所有节点列表（用于按名称查找节点）
 * @param variablePool 变量池
 * @param currentNodeId 当前节点 ID（用于跳过自身引用）
 * @returns 解析后的字符串
 */
export function resolveTemplate(
  template: string,
  nodes: NodeLike[],
  variablePool: VariablePool,
  currentNodeId?: number,
): string {
  return template.replace(TEMPLATE_REGEX, (match, expression: string) => {
    const trimmed = expression.trim()
    const [nodeName, ...keyParts] = trimmed.split(/[.|]/).map(s => s.trim())

    // 按节点名称查找（精确 → 大小写 → 忽略空白 → 数字 ID）
    const node = findNodeByName(nodes, nodeName)

    if (!node) {
      console.warn(`[TemplateResolver] 未找到节点: "${nodeName}"`)
      return match // 保持原样
    }

    if (currentNodeId !== undefined && node.id === currentNodeId) {
      console.warn(`[TemplateResolver] 节点 "${nodeName}" 引用了自身`)
      return match
    }

    // 从 VariablePool 获取数据
    const output = variablePool.getNodeOutputs(node.id)
    if (!output) {
      console.warn(`[TemplateResolver] 节点 "${nodeName}" 没有输出数据`)
      return ''
    }

    // 按 key 路径查找（支持嵌套：{{node.a.b}} 逐层取值）
    let value: any = output
    const path = keyParts.length > 0 ? keyParts : ['result']
    for (const p of path) {
      if (value && typeof value === 'object' && p in value) {
        value = value[p]
      } else {
        console.warn(`[TemplateResolver] 节点 "${nodeName}" 没有字段 "${p}"`)
        return ''
      }
    }

    // 将值转为字符串
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    if (value === null || value === undefined) return ''
    try { return JSON.stringify(value, null, 2) } catch { return String(value) }
  })
}

/**
 * 查找模板中引用了哪些节点
 * @returns 被引用节点的 ID 数组
 */
export function findReferencedNodeIds(
  template: string,
  nodes: NodeLike[],
): number[] {
  const refs: number[] = []
  const matches = template.matchAll(TEMPLATE_REGEX)
  for (const match of matches) {
    const trimmed = match[1].trim()
    const nodeName = trimmed.split(/[.|]/)[0].trim()
    const node = findNodeByName(nodes, nodeName)
    if (node && !refs.includes(node.id)) refs.push(node.id)
  }
  return refs
}

/**
 * 解析模板中的变量引用并返回原始值（不做字符串化）。
 * 供迭代/列表等节点直接取数组等大对象，避免 JSON 字符串化/反序列化的性能开销。
 * 返回 null 表示表达式无法解析（节点不存在 / 字段缺失 / 自引用）。
 */
export function resolveTemplateRaw(
  template: string,
  nodes: NodeLike[],
  variablePool: VariablePool,
  currentNodeId?: number,
): { node: NodeLike; path: string[]; value?: any; found: boolean; selfRef?: boolean } | null {
  let result: { node: NodeLike; path: string[]; value?: any; found: boolean; selfRef?: boolean } | null = null
  template.replace(TEMPLATE_REGEX, (match, expression: string) => {
    const trimmed = expression.trim()
    const [nodeName, ...keyParts] = trimmed.split(/[.|]/).map(s => s.trim())

    const node = findNodeByName(nodes, nodeName)
    if (!node) return match

    if (currentNodeId !== undefined && node.id === currentNodeId) {
      result = { node, path: keyParts, selfRef: true, found: false }
      return match
    }

    const output = variablePool.getNodeOutputs(node.id)
    if (!output) {
      result = { node, path: keyParts, found: false }
      return match
    }

    const path = keyParts.length > 0 ? keyParts : ['result']
    let value: any = output
    for (const p of path) {
      if (value && typeof value === 'object' && p in value) value = value[p]
      else {
        result = { node, path, found: false }
        return match
      }
    }
    result = { node, path, value, found: true }
    return match
  })
  return result
}

/**
 * 检查模板字符串是否包含变量引用
 */
export function hasTemplateVariables(template: string): boolean {
  return TEMPLATE_REGEX.test(template)
}

/**
 * 提取模板中的所有变量表达式（不含 {{ }}）
 */
export function extractVariableExpressions(template: string): string[] {
  const exps: string[] = []
  const matches = template.matchAll(TEMPLATE_REGEX)
  for (const match of matches) {
    exps.push(match[1].trim())
  }
  return exps
}
