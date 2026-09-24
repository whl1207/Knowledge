/**
 * knowledge executor - 知识库节点
 */
import type { NodeExecutor, ExecutionContext } from '@/components/workFlow/engine/NodeExecutor'
import type { NodeData } from '@/components/workFlow/engine/WorkflowRunner'
import { retrieveKnowledge } from '@/shared/kbRetrieval'
import { getProviderConfig } from '@/shared/kbAiClient'
import { buildEmbedFallbackFromStore } from '@/shared/kbAiClient'

export const knowledgeExecutor: NodeExecutor = {
  type: 'knowledge',
  label: '知识库节点',
  async execute(node: NodeData, ctx: ExecutionContext): Promise<boolean> {
    if (!node.kbPath || node.kbPath.trim() === '') {
      node.result = JSON.stringify({ result: ctx.t('select_kb_file'), type: 'knowledge_retrieval', success: false, error: ctx.t('kb_file_required') })
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }

    const kbOptions = node.kbOptions || { topK: 5, summaryWeight: 0.7, embedModel: '', debug: false }
    let queryText = node.kbQuery || ''

    const sourceLinks = ctx.workflowData.links.filter(l => l.target === node.id)
    if (sourceLinks.length > 0) {
      const upstreamQuery = ctx.getAllUpstreamQueryTextWithPorts?.(node.id) || ''
      if (upstreamQuery.trim() !== '') queryText = upstreamQuery
    }

    if (!queryText || queryText.trim() === '') queryText = node.prompt
    if (!queryText || queryText.trim() === '') {
      node.result = JSON.stringify({ result: ctx.t('enter_query_text'), type: 'knowledge_retrieval', success: false, error: ctx.t('query_required') })
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }

    try {
      // 跟随默认模型来源（有的电脑没有 Ollama）；当前来源无嵌入模型时回退到 Ollama 嵌入
      const llm = ctx.store.AIconfig?.llm
      const llmType = llm?.type || 'ollama'
      const providerCfg = getProviderConfig(llm, llmType) || {}
      // 嵌入兜底（设置页「嵌入兜底」）：当前来源无嵌入能力时用该来源做向量化（默认 Ollama）
      const embedFallback = buildEmbedFallbackFromStore(ctx.store)
      const options = {
        topK: kbOptions.topK || 5, summaryWeight: kbOptions.summaryWeight || 0.7,
        embedModel: kbOptions.embedModel || '', debug: kbOptions.debug || false,
        llmType: llmType as any,
        providerConfig: providerCfg,
        // 当前来源无嵌入模型时回退到「嵌入兜底」设置（默认 Ollama）
        embedFallbackType: embedFallback?.llmType,
        embedFallbackProviderConfig: embedFallback?.config,
        embedFallbackModel: embedFallback?.embed,
        // 跟随来源后模型可能不匹配：默认 fallback 避免硬报错
        missingModelStrategy: kbOptions.missingModelStrategy || 'fallback',
        fallbackModels: kbOptions.fallbackModels || ['nomic-embed-text:latest', 'all-minilm:latest'],
        ollamaHost: llm?.ollama?.model_url || 'http://127.0.0.1:11434'
      }

      const retrievalResult = await retrieveKnowledge(queryText, node.kbPath, options)
      let resultText = ''
      if (retrievalResult.context) { resultText = retrievalResult.context }
      else if (retrievalResult.relevantBlocks && retrievalResult.relevantBlocks.length > 0) {
        resultText = `${ctx.t('relevant_knowledge')}：\n\n`
        retrievalResult.relevantBlocks.forEach((block: any, index: number) => {
          resultText += `${ctx.t('knowledge_item')} ${index + 1}】\n`
          if (block.text) resultText += `${block.text}\n`
          if (block.metadata?.source) resultText += `${ctx.t('source')}：${block.metadata.source}\n`
          resultText += '\n'
        })
      }

      node.result = JSON.stringify({
        type: 'knowledge_retrieval', success: true, query: queryText, kbPath: node.kbPath,
        result: resultText, context: retrievalResult.context,
        relevantBlocks: retrievalResult.relevantBlocks, usedEmbedModel: retrievalResult.usedEmbedModel,
        debugInfo: retrievalResult.debugInfo, timestamp: new Date().toISOString()
      })
      node.status = 'success'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'success', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'success', node.result)
      return true
    } catch (error: any) {
      node.result = JSON.stringify({ result: `${ctx.t('retrieval_error')}: ${error.message}`, type: 'knowledge_retrieval', success: false, error: error.message, timestamp: new Date().toISOString() })
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }
  }
}
