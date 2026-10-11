/**
 * Dify DSL 默认值构造
 *
 * 新文件的形状刻意对齐 Dify 导出的工作流应用：同样的 features 字段集、
 * 同样的 start → end 骨架、同样的 viewport 默认值。
 */

import {
  SUPPORTED_DSL_VERSION,
  type DslAppMeta,
  type DslDocument,
  type DslEdge,
  type DslGraph,
  type DslNode,
  type EndNodeData,
  type StartNodeData,
  type WorkflowFeatures,
  type XYPosition,
} from './types'
import { makeEdgeId } from './validator'

export { makeEdgeId }

/** Dify 导出时写入的默认 features */
export function createDefaultFeatures(): WorkflowFeatures {
  return {
    file_upload: {
      enabled: false,
      allowed_file_extensions: ['.JPG', '.JPEG', '.PNG', '.GIF', '.WEBP', '.SVG'],
      allowed_file_types: ['image'],
      allowed_file_upload_methods: ['local_file', 'remote_url'],
      number_limits: 3,
      fileUploadConfig: {
        audio_file_size_limit: 50,
        batch_count_limit: 5,
        file_size_limit: 15,
        image_file_size_limit: 10,
        video_file_size_limit: 100,
        workflow_file_upload_limit: 10,
      },
      image: {
        enabled: false,
        number_limits: 3,
        transfer_methods: ['local_file', 'remote_url'],
      },
    },
    opening_statement: '',
    retriever_resource: { enabled: true },
    sensitive_word_avoidance: { enabled: false },
    speech_to_text: { enabled: false },
    suggested_questions: [],
    suggested_questions_after_answer: { enabled: false },
    text_to_speech: { enabled: false, language: '', voice: '' },
  }
}

/** 生成不与现有节点冲突的节点 id（Dify 用毫秒时间戳字符串） */
export function createNodeId(taken: Iterable<string> = []): string {
  const used = new Set(taken)
  let id = String(Date.now())
  let suffix = 0
  while (used.has(id)) id = `${Date.now()}${++suffix}`
  return id
}

export function createStartNode(id: string, title: string, position: XYPosition = { x: 80, y: 282 }): DslNode<StartNodeData> {
  return {
    type: 'custom',
    id,
    position,
    positionAbsolute: position,
    width: 244,
    height: 90,
    sourcePosition: 'right',
    targetPosition: 'left',
    selected: false,
    data: { type: 'start', title, desc: '', version: '1', variables: [] },
  }
}

export function createEndNode(id: string, title: string, position: XYPosition = { x: 638, y: 282 }): DslNode<EndNodeData> {
  return {
    type: 'custom',
    id,
    position,
    positionAbsolute: position,
    width: 244,
    height: 90,
    sourcePosition: 'right',
    targetPosition: 'left',
    selected: false,
    data: { type: 'end', title, desc: '', version: '1', outputs: [] },
  }
}

/** 空白工作流骨架：开始 → 结束 */
export function createEmptyGraph(opts: { startTitle: string; endTitle: string } = { startTitle: '开始', endTitle: '结束' }): DslGraph {
  const startId = createNodeId()
  const endId = createNodeId([startId])
  const start = createStartNode(startId, opts.startTitle)
  const end = createEndNode(endId, opts.endTitle)
  const edge: DslEdge = {
    id: makeEdgeId(startId, 'source', endId, 'target'),
    source: startId,
    target: endId,
    sourceHandle: 'source',
    targetHandle: 'target',
    type: 'custom',
    zIndex: 0,
    data: {
      sourceType: 'start',
      targetType: 'end',
      isInIteration: false,
      iteration_id: null,
      isInLoop: false,
      loop_id: null,
    },
  }
  return { nodes: [start, end], edges: [edge], viewport: { x: 0, y: 0, zoom: 0.7 } }
}

/** 新建工作流文档 */
export function createNewDocument(opts: { name: string; startTitle?: string; endTitle?: string }): DslDocument {
  const app: DslAppMeta = {
    name: opts.name,
    mode: 'workflow',
    icon: '🤖',
    icon_type: 'emoji',
    icon_background: '#FFEAD5',
    description: '',
    use_icon_as_answer_icon: false,
  }
  return {
    version: SUPPORTED_DSL_VERSION,
    kind: 'app',
    app,
    workflow: {
      graph: createEmptyGraph({
        startTitle: opts.startTitle ?? '开始',
        endTitle: opts.endTitle ?? '结束',
      }),
      features: createDefaultFeatures(),
      environment_variables: [],
      conversation_variables: [],
    },
    dependencies: [],
  }
}
