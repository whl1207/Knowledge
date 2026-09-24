/**
 * reasoning executor - 推理节点
 */
import type { NodeExecutor, ExecutionContext } from '@/components/workFlow/engine/NodeExecutor'
import type { NodeData } from '@/components/workFlow/engine/WorkflowRunner'
import { validateModelConfig, setAIModelConfig } from '@/components/workFlow/engine/executorHelpers'

export const reasoningExecutor: NodeExecutor = {
  type: 'reasoning',
  label: '推理节点',
  async execute(node: NodeData, ctx: ExecutionContext): Promise<boolean> {
    const validation = validateModelConfig(node, ctx.store, ctx.t)
    if (!validation.valid) {
      node.result = validation.message; node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }

    const contexts = await ctx.getNodeContextWithPorts(node.id, ctx.decisionPaths)
    const combinedContext = contexts.length > 0 ? `${ctx.t('relevant_context')}：\n\n` + contexts.join('\n\n') + '\n\n' : ''
    // 解析 prompt 中的 {{nodeName.key}} 模板变量
    const resolvedPrompt = ctx.resolveTemplate(node.prompt, node.id)
    const fullPrompt = combinedContext + `${ctx.t('user_instruction')}：` + resolvedPrompt
    const messages = [{ role: 'user', content: fullPrompt }]
    const originalConfig = setAIModelConfig(ctx.store, node)
    let streamContent = ''

    try {
      const aiResponse = await new Promise<string>((resolve, reject) => {
        if (!ctx.sendToAI) { reject(new Error('sendToAI 不存在')); return }
        ctx.sendToAI(messages, {
          onStream: (chunk: string) => {
            streamContent += chunk
            const streamingResult = JSON.stringify({ result: streamContent, model: node.model, model_type: node.model_type, timestamp: new Date().toISOString(), type: 'reasoning', streaming: true })
            node.result = streamingResult
            ctx.callbacks.onNodeStatusUpdate?.(node.id, 'running', streamingResult)
            ctx.callbacks.onNodeStream?.(node.id, chunk, streamContent)
          },
          onComplete: (fullContent: string) => resolve(fullContent),
          onError: (error: Error) => reject(error)
        }).catch(reject)
      })

      node.result = JSON.stringify({ result: aiResponse, model: node.model, model_type: node.model_type, timestamp: new Date().toISOString(), type: 'reasoning' })
      node.status = 'success'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'success', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'success', node.result)
      return true
    } catch (error: any) {
      node.result = JSON.stringify({ result: `${ctx.t('reasoning_error')}: ${error.message}`, model: node.model, model_type: node.model_type, timestamp: new Date().toISOString(), type: 'reasoning', error: error.message })
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    } finally {
      if (ctx.store.AIconfig?.llm) ctx.store.AIconfig.llm = originalConfig
    }
  }
}
