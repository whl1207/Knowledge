/**
 * knowledge-retrieval（知识检索）执行器
 *
 * Dify 里它检索的是**云端数据集**（`dataset_ids`），本地无法访问；
 * 因此这里支持在节点上额外记录一个本地知识库路径（`kb_path`）：
 * - 有 `kb_path` → 用本地知识库检索（输出形状与 Dify 一致：`result` 为对象数组）
 * - 没有 → 报错并提示改用「本地知识库」节点
 * 该额外字段导出到 Dify 时会被忽略（Dify 侧仍需自行绑定数据集）。
 */
import { resolveSelectorText, stringifyValue } from '../template'
import { retrieveLocalKnowledge } from './shared/retrieval'
import type { NodeExecutionContext, NodeExecutionResult, WorkflowNodeExecutor } from '../types'

export const knowledgeRetrievalExecutor: WorkflowNodeExecutor = {
  type: 'knowledge-retrieval',
  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const data = ctx.node as unknown as Record<string, unknown>
    const kbPath = stringifyValue(data.kb_path).trim()
    const query = resolveSelectorText(data.query_variable_selector as string[], ctx.pool).trim()
    if (!query) throw new Error('检索内容为空，请检查查询变量')

    if (!kbPath) {
      throw new Error('本地运行需要指定知识库文件（面板里选择）；Dify 数据集需在 Dify 内绑定')
    }

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
