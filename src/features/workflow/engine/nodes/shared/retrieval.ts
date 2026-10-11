/**
 * 本地知识库检索（`knowledge-retrieval` 与 `ai-km-knowledge` 共用）
 *
 * 两者输出形状一致（`result` 为对象数组），便于在两者之间切换时下游引用不用改。
 */
import { getProviderConfig } from '@/shared/kbAiClient'
import { retrieveKnowledge } from '@/shared/kbRetrieval'
import { stringifyValue } from '../../template'
import type { NodeExecutionContext } from '../../types'

export interface RetrievalChunk {
  content: string
  score: number
  title: string
  metadata: Record<string, unknown>
}

export interface RetrievalParams {
  kbPath: string
  query: string
  topK: number
  scoreThreshold: number
  summaryWeight: number
  embedModel?: string
  missingModelStrategy?: 'error' | 'fallback'
  fallbackModels?: string[]
}

export async function retrieveLocalKnowledge(
  ctx: NodeExecutionContext,
  params: RetrievalParams,
): Promise<RetrievalChunk[]> {
  const llm = ctx.store?.AIconfig?.llm
  const llmType = llm?.type || 'ollama'

  ctx.log('info', `检索知识库（topK=${params.topK}）：${params.query.slice(0, 60)}`)
  const result = await retrieveKnowledge(params.query, params.kbPath, {
    topK: params.topK,
    summaryWeight: params.summaryWeight,
    llmType: llmType as never,
    providerConfig: getProviderConfig(llm, llmType) || undefined,
    ollamaHost: llm?.ollama?.model_url || 'http://127.0.0.1:11434',
    embedModel: stringifyValue(params.embedModel),
    missingModelStrategy: params.missingModelStrategy ?? 'error',
    fallbackModels: params.fallbackModels,
  } as never)

  const chunks = extractChunks(result)
    .filter((item) => params.scoreThreshold <= 0 || Number(item.score ?? 1) >= params.scoreThreshold)
    .map((item) => ({
      content: stringifyValue(item.content),
      score: Number(item.score ?? 0),
      title: stringifyValue(item.title),
      metadata: (item.metadata && typeof item.metadata === 'object' ? item.metadata : {}) as Record<string, unknown>,
    }))

  ctx.log('info', `命中 ${chunks.length} 条`)
  return chunks
}

/** 不同检索策略的返回结构略有差异，这里做一次宽松提取 */
function extractChunks(result: unknown): Array<Record<string, unknown>> {
  if (!result) return []
  const record = result as Record<string, unknown>
  const candidates = [record.chunks, record.results, record.blocks, record.contexts, record.data]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate as Array<Record<string, unknown>>
  }
  if (typeof record.context === 'string') return [{ content: record.context, score: 0 }]
  if (typeof result === 'string') return [{ content: result, score: 0 }]
  return []
}
