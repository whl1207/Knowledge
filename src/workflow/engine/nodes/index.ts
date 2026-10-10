/**
 * 引擎节点执行器注册表
 *
 * 与属性面板的注册表（nodes/registry.ts）分开：那份定义「怎么编辑」，这份定义「怎么执行」。
 * 后续实现新节点只需在此加一行 + 一个执行器文件。
 */
import { answerExecutor } from './answer'
import { assignerExecutor, variableAssignerExecutor } from './assigner'
import { codeExecutor } from './code'
import { documentExtractorExecutor } from './documentExtractor'
import { endExecutor } from './end'
import { httpRequestExecutor } from './httpRequest'
import { ifElseExecutor } from './ifElse'
import { iterationExecutor } from './iteration'
import { knowledgeRetrievalExecutor } from './knowledgeRetrieval'
import { listOperatorExecutor } from './listOperator'
import { llmExecutor } from './llm'
import { loopExecutor } from './loop'
import { parameterExtractorExecutor } from './parameterExtractor'
import { csvExecutor } from './privateCsv'
import { localFileExecutor } from './privateFile'
import { localKnowledgeExecutor } from './privateKnowledge'
import { mcpToolExecutor } from './privateMcp'
import { subflowExecutor } from './privateSubflow'
import { wordExecutor } from './privateWord'
import { questionClassifierExecutor } from './questionClassifier'
import { startExecutor } from './start'
import { templateTransformExecutor } from './templateTransform'
import { toolExecutor } from './tool'
import { variableAggregatorExecutor } from './variableAggregator'
import type { WorkflowNodeExecutor } from '../types'

const EXECUTORS: WorkflowNodeExecutor[] = [
  startExecutor,
  endExecutor,
  answerExecutor,
  llmExecutor,
  ifElseExecutor,
  questionClassifierExecutor,
  iterationExecutor,
  loopExecutor,
  assignerExecutor,
  variableAssignerExecutor,
  codeExecutor,
  templateTransformExecutor,
  httpRequestExecutor,
  toolExecutor,
  variableAggregatorExecutor,
  listOperatorExecutor,
  documentExtractorExecutor,
  parameterExtractorExecutor,
  knowledgeRetrievalExecutor,
  // 本地扩展节点
  wordExecutor,
  csvExecutor,
  localFileExecutor,
  localKnowledgeExecutor,
  mcpToolExecutor,
  subflowExecutor,
]

const REGISTRY = new Map<string, WorkflowNodeExecutor>(EXECUTORS.map((e) => [e.type, e]))

/** 取执行器；未实现时返回 undefined（调度器据此给出明确报错） */
export function getExecutor(type: string): WorkflowNodeExecutor | undefined {
  return REGISTRY.get(type)
}

export function hasExecutor(type: string): boolean {
  return REGISTRY.has(type)
}

export function executableTypes(): string[] {
  return Array.from(REGISTRY.keys())
}
