/**
 * ai-km-knowledge（本地知识库）执行器
 *
 * 与 `knowledge-retrieval` 共用检索实现与输出形状（`result` 对象数组），
 * 区别只在于本节点直接绑定本地 .kb 文件（无需 Dify 数据集）。
 */
import { resolveSelectorText, stringifyValue } from '../template'
import { retrieveLocalKnowledge } from './shared/retrieval'
import type { NodeExecutionContext, NodeExecutionResult, WorkflowNodeExecutor } from '../types'

export const localKnowledgeExecutor: WorkflowNodeExecutor = {
  type: 'ai-km-knowledge',
  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const data = ctx.node as unknown as Record<string, unknown>
    const kbPath = stringifyValue(data.kb_path).trim()
    if (!kbPath) throw new Error('请先选择本地知识库文件')

    const query = resolveSelectorText(data.query_variable_selector as string[], ctx.pool).trim()
      || stringifyValue(data.query).trim()
    if (!query) throw new Error('检索内容为空，请选择查询变量')

    const config = (data.multiple_retrieval_config ?? {}) as Record<string, unknown>
    const chunks = await retrieveLocalKnowledge(ctx, {
      kbPath,
      query,
      topK: Number(config.top_k ?? 5),
      scoreThreshold: Number(config.score_threshold ?? 0),
      summaryWeight: Number(config.summary_weight ?? 0.7),
      embedModel: stringifyValue(data.embed_model) || undefined,
      missingModelStrategy: (data.missing_model_strategy as 'error' | 'fallback') ?? 'error',
      fallbackModels: Array.isArray(data.fallback_models) ? (data.fallback_models as string[]) : undefined,
    })

    return { outputs: { result: chunks } }
  },
}
