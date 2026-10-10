/**
 * Dify DSL 校验与归一化
 *
 * 职责：把「任意来源的 YAML 对象」变成结构可靠的 DslDocument，同时收集问题清单。
 * 错误（error）= 无法打开；警告（warning）= 能打开但需用户知晓。
 * 行为刻意对齐 Dify 的导入逻辑（kind 强制为 app、缺 version 视为 0.1.0 等）。
 */

import {
  LEGACY_DSL_VERSION,
  checkVersionCompatibility,
  isKnownNodeType,
  type AnyNodeType,
  type DslDocument,
  type DslEdge,
  type DslGraph,
  type DslNode,
  type DslWorkflow,
  type NodeWrapperType,
  type VersionCompatibility,
  type XYPosition,
} from './types'

export interface DslIssue {
  level: 'error' | 'warning'
  message: string
  path?: string
}

export interface DslValidationResult {
  ok: boolean
  document?: DslDocument
  issues: DslIssue[]
  compatibility: VersionCompatibility
  /** 文件中声明的版本（缺失时为 LEGACY_DSL_VERSION） */
  importedVersion: string
  /** 无法识别的节点类型（原样保留，仅在 UI 标注） */
  unknownTypes: string[]
}

const DEFAULT_NODE_SIZE = { width: 244, height: 90 }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asPosition(value: unknown): XYPosition | null {
  if (!isRecord(value)) return null
  return { x: asNumber(value.x, 0), y: asNumber(value.y, 0) }
}

/** 容器入口节点的 wrapper 类型由 data.type 决定 */
function wrapperTypeOf(nodeType: string): NodeWrapperType {
  if (nodeType === 'iteration-start') return 'custom-iteration-start'
  if (nodeType === 'loop-start') return 'custom-loop-start'
  return 'custom'
}

/** 生成确定性边 id（与 Dify 的 `${source}-${sourceHandle}-${target}-${targetHandle}` 一致） */
export function makeEdgeId(source: string, sourceHandle: string, target: string, targetHandle: string): string {
  return `${source}-${sourceHandle}-${target}-${targetHandle}`
}

/**
 * 校验 + 归一化。传入的对象通常来自 parseDslYaml。
 */
export function validateAndNormalizeDsl(raw: Record<string, unknown>): DslValidationResult {
  const issues: DslIssue[] = []
  const importedVersionRaw = raw.version
  const importedVersion = typeof importedVersionRaw === 'string' && importedVersionRaw.trim()
    ? importedVersionRaw.trim()
    : LEGACY_DSL_VERSION
  const compatibility = checkVersionCompatibility(importedVersion)
  const fail = (): DslValidationResult => ({
    ok: false,
    issues,
    compatibility,
    importedVersion,
    unknownTypes: [],
  })

  if (importedVersionRaw !== undefined && typeof importedVersionRaw !== 'string') {
    issues.push({ level: 'error', message: 'version 字段必须是字符串', path: 'version' })
    return fail()
  }
  if (compatibility === 'pending') {
    issues.push({
      level: 'warning',
      message: `文件 DSL 版本 ${importedVersion} 高于本编辑器支持的 0.7.0，可能存在不兼容字段`,
      path: 'version',
    })
  } else if (compatibility === 'completed_with_warnings') {
    issues.push({
      level: 'warning',
      message: `文件 DSL 版本 ${importedVersion} 较旧，已尽力兼容`,
      path: 'version',
    })
  } else if (compatibility === 'unsupported') {
    issues.push({ level: 'error', message: `无法识别 DSL 版本：${String(importedVersionRaw)}`, path: 'version' })
    return fail()
  }

  if (raw.kind !== undefined && raw.kind !== 'app') {
    issues.push({ level: 'warning', message: `kind 已从「${String(raw.kind)}」修正为 app`, path: 'kind' })
  }

  // ── app 段 ──
  if (!isRecord(raw.app)) {
    issues.push({
      level: 'error',
      message: `缺少 app 段（文件顶层键：${Object.keys(raw).join(', ') || '无'}）`,
      path: 'app',
    })
    return fail()
  }
  const appRaw = raw.app
  if (typeof appRaw.mode !== 'string' || !appRaw.mode) {
    issues.push({ level: 'error', message: '缺少 app.mode', path: 'app.mode' })
    return fail()
  }
  if (appRaw.mode !== 'workflow' && appRaw.mode !== 'advanced-chat') {
    issues.push({
      level: 'error',
      message: `暂不支持的应用模式：${appRaw.mode}（仅支持 workflow / advanced-chat）`,
      path: 'app.mode',
    })
    return fail()
  }

  // ── workflow 段 ──
  if (!isRecord(raw.workflow)) {
    issues.push({ level: 'error', message: '缺少 workflow 段', path: 'workflow' })
    return fail()
  }
  const workflowRaw = raw.workflow
  if (!isRecord(workflowRaw.graph)) {
    issues.push({ level: 'error', message: 'workflow.graph 必须是映射', path: 'workflow.graph' })
    return fail()
  }
  const graphRaw = workflowRaw.graph
  const nodesRaw = Array.isArray(graphRaw.nodes) ? graphRaw.nodes : []
  const edgesRaw = Array.isArray(graphRaw.edges) ? graphRaw.edges : []
  if (!Array.isArray(graphRaw.nodes)) {
    issues.push({ level: 'warning', message: 'workflow.graph.nodes 缺失，按空图处理', path: 'workflow.graph.nodes' })
  }
  if (!Array.isArray(graphRaw.edges)) {
    issues.push({ level: 'warning', message: 'workflow.graph.edges 缺失，按空图处理', path: 'workflow.graph.edges' })
  }

  // ── 节点 ──
  const unknownTypes = new Set<string>()
  const nodes: DslNode[] = []
  const nodeIds = new Set<string>()
  nodesRaw.forEach((rawNode, index) => {
    const path = `workflow.graph.nodes[${index}]`
    if (!isRecord(rawNode)) {
      issues.push({ level: 'warning', message: '节点不是映射，已跳过', path })
      return
    }
    const rawId = rawNode.id
    let id: string
    if (typeof rawId === 'string' && rawId) id = rawId
    else if (typeof rawId === 'number' && Number.isFinite(rawId)) id = String(rawId)
    else {
      issues.push({ level: 'warning', message: '节点缺少 id，已跳过', path })
      return
    }
    if (nodeIds.has(id)) {
      issues.push({ level: 'warning', message: `节点 id 重复（${id}），已跳过重复项`, path: `${path}.id` })
      return
    }
    if (!isRecord(rawNode.data)) {
      issues.push({ level: 'warning', message: `节点 ${id} 缺少 data，已跳过`, path: `${path}.data` })
      return
    }
    const dataRaw = rawNode.data
    const nodeType = typeof dataRaw.type === 'string' && dataRaw.type ? dataRaw.type : ''
    if (!nodeType) {
      issues.push({ level: 'warning', message: `节点 ${id} 缺少 data.type，已跳过`, path: `${path}.data.type` })
      return
    }
    if (!isKnownNodeType(nodeType)) {
      unknownTypes.add(nodeType)
      issues.push({
        level: 'warning',
        message: `未识别的节点类型「${nodeType}」：原样保留，暂不可执行`,
        path: `${path}.data.type`,
      })
    }
    nodeIds.add(id)

    const position = asPosition(rawNode.position) ?? asPosition(rawNode.positionAbsolute) ?? { x: 0, y: 0 }
    const data: Record<string, unknown> = { ...dataRaw }
    if (typeof data.title !== 'string' || !data.title) data.title = nodeType
    if (typeof data.version !== 'string') data.version = '1'
    if (!isKnownNodeType(nodeType)) {
      data['x-ai-km'] = { ...(isRecord(data['x-ai-km']) ? data['x-ai-km'] : {}), origin: 'unknown' }
    }

    const node: DslNode = {
      type: wrapperTypeOf(nodeType),
      id,
      position,
      positionAbsolute: asPosition(rawNode.positionAbsolute) ?? position,
      width: asNumber(rawNode.width, DEFAULT_NODE_SIZE.width),
      height: asNumber(rawNode.height, DEFAULT_NODE_SIZE.height),
      sourcePosition: 'right',
      targetPosition: 'left',
      selected: false,
      data: data as DslNode['data'],
    }
    if (typeof rawNode.parentId === 'string' && rawNode.parentId) node.parentId = rawNode.parentId
    if (typeof rawNode.zIndex === 'number') node.zIndex = rawNode.zIndex
    if (rawNode.draggable === false) node.draggable = false
    if (rawNode.selectable === false) node.selectable = false
    nodes.push(node)
  })

  // ── 边 ──
  const edges: DslEdge[] = []
  const edgeIds = new Set<string>()
  edgesRaw.forEach((rawEdge, index) => {
    const path = `workflow.graph.edges[${index}]`
    if (!isRecord(rawEdge)) {
      issues.push({ level: 'warning', message: '连线不是映射，已跳过', path })
      return
    }
    const source = typeof rawEdge.source === 'string' ? rawEdge.source : ''
    const target = typeof rawEdge.target === 'string' ? rawEdge.target : ''
    if (!source || !target) {
      issues.push({ level: 'warning', message: '连线缺少 source/target，已跳过', path })
      return
    }
    if (!nodeIds.has(source) || !nodeIds.has(target)) {
      issues.push({
        level: 'warning',
        message: `连线 ${source} → ${target} 指向不存在的节点，已跳过`,
        path,
      })
      return
    }
    const sourceHandle = typeof rawEdge.sourceHandle === 'string' && rawEdge.sourceHandle
      ? rawEdge.sourceHandle
      : 'source'
    const targetHandle = typeof rawEdge.targetHandle === 'string' && rawEdge.targetHandle
      ? rawEdge.targetHandle
      : 'target'
    let id = typeof rawEdge.id === 'string' && rawEdge.id ? rawEdge.id : makeEdgeId(source, sourceHandle, target, targetHandle)
    if (edgeIds.has(id)) {
      id = `${id}#${index}`
      issues.push({ level: 'warning', message: `连线 id 重复，已重命名：${id}`, path: `${path}.id` })
    }
    edgeIds.add(id)

    const dataRaw = isRecord(rawEdge.data) ? rawEdge.data : {}
    const sourceNode = nodes.find((n) => n.id === source)
    const targetNode = nodes.find((n) => n.id === target)
    const containerId = sourceNode?.parentId ?? targetNode?.parentId
    const container = containerId ? nodes.find((n) => n.id === containerId) : undefined
    const inLoop = container?.data.type === 'loop'
    const edgesData = {
      sourceType: typeof dataRaw.sourceType === 'string' && dataRaw.sourceType
        ? dataRaw.sourceType
        : String(sourceNode?.data.type ?? ''),
      targetType: typeof dataRaw.targetType === 'string' && dataRaw.targetType
        ? dataRaw.targetType
        : String(targetNode?.data.type ?? ''),
      isInIteration: typeof dataRaw.isInIteration === 'boolean' ? dataRaw.isInIteration : !!containerId && !inLoop,
      iteration_id: (dataRaw.iteration_id ?? (containerId && !inLoop ? containerId : null)) as string | null,
      isInLoop: typeof dataRaw.isInLoop === 'boolean' ? dataRaw.isInLoop : !!containerId && inLoop,
      loop_id: (dataRaw.loop_id ?? (containerId && inLoop ? containerId : null)) as string | null,
    }
    edges.push({
      id,
      source,
      target,
      sourceHandle,
      targetHandle,
      type: 'custom',
      zIndex: asNumber(rawEdge.zIndex, 0),
      data: edgesData,
    })
  })

  const graph: DslGraph = { nodes, edges }
  const viewport = asPosition(graphRaw.viewport)
  if (viewport && isRecord(graphRaw.viewport)) {
    graph.viewport = { ...viewport, zoom: asNumber(graphRaw.viewport.zoom, 1) }
  }

  const workflow: DslWorkflow = { graph }
  if (isRecord(workflowRaw.features)) workflow.features = workflowRaw.features
  if (Array.isArray(workflowRaw.environment_variables)) {
    workflow.environment_variables = workflowRaw.environment_variables as DslWorkflow['environment_variables']
  }
  if (Array.isArray(workflowRaw.conversation_variables)) {
    workflow.conversation_variables = workflowRaw.conversation_variables as DslWorkflow['conversation_variables']
  }
  if (Array.isArray(workflowRaw.rag_pipeline_variables)) {
    workflow.rag_pipeline_variables = workflowRaw.rag_pipeline_variables
  }

  const document: DslDocument = {
    version: importedVersion,
    kind: 'app',
    app: { ...appRaw, mode: appRaw.mode } as DslDocument['app'],
    workflow,
    dependencies: Array.isArray(raw.dependencies) ? (raw.dependencies as DslDocument['dependencies']) : [],
  }
  if (isRecord(raw.site)) document.site = raw.site
  if (Array.isArray(raw.agent_packages)) document.agent_packages = raw.agent_packages
  if (isRecord(raw['x-ai-km'])) document['x-ai-km'] = raw['x-ai-km']

  return {
    ok: true,
    document,
    issues,
    compatibility,
    importedVersion,
    unknownTypes: Array.from(unknownTypes),
  }
}

/** 节点外壳类型（画布/引擎共用；容器入口节点单独渲染） */
export function nodeWrapperType(type: AnyNodeType): NodeWrapperType {
  return wrapperTypeOf(String(type))
}
