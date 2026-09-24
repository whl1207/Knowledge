/**
 * python executor - Python节点
 */
import type { NodeExecutor, ExecutionContext } from '@/components/workFlow/engine/NodeExecutor'
import type { NodeData } from '@/components/workFlow/engine/WorkflowRunner'

export const pythonExecutor: NodeExecutor = {
  type: 'python',
  label: 'Python节点',
  async execute(node: NodeData, ctx: ExecutionContext): Promise<boolean> {
    const pythonCode = node.prompt || ''
    let codeToExecute = pythonCode

    // 解析模板变量：把 {{上游节点.字段}} 替换为实际数据（JSON 字面量），
    // 使 Python 代码能引用上游结果（例如把列表结果写成本地 CSV）；数组字段走全量缓存
    if (pythonCode.includes('{{')) {
      try {
        const resolved = ctx.resolveTemplateForCode
          ? ctx.resolveTemplateForCode(pythonCode, node.id)
          : ctx.resolveTemplate(pythonCode, node.id)
        if (resolved !== pythonCode) codeToExecute = resolved
      } catch { /* 模板解析失败则使用原始代码 */ }
    }
    // 诊断：代码中仍含未解析的模板变量 → 上游节点没有可用输出
    if (codeToExecute.includes('{{')) {
      ctx.log?.('⚠️ Python 代码含未解析模板 {{...}}：上游节点无可用输出（可能未执行、被跳过或节点名称不匹配）。请先完整运行工作流，确保上游（如列表操作）已成功产出，或核对模板中的节点名。', 'warning')
    }

    if (!codeToExecute.trim()) {
      // getUpstreamDataWithPorts is provided via context
      const upstreamData = ctx.getUpstreamDataWithPorts?.(node.id)
      if (upstreamData && Object.keys(upstreamData).length > 0) {
        for (const [, value] of Object.entries(upstreamData)) {
          if (value && typeof value === 'string') {
            if (value.includes('def ') || value.includes('import ') || value.includes('print(') || value.includes('```python') || value.includes('plt.')) {
              let extractedCode = value
              const codeBlockMatch = value.match(/```python\s*([\s\S]*?)```/)
              if (codeBlockMatch) extractedCode = codeBlockMatch[1].trim()
              else extractedCode = value.trim()
              codeToExecute = extractedCode
              break
            }
          }
        }
      }
    }

    if (!codeToExecute.trim()) {
      node.result = JSON.stringify({ result: ctx.t('no_python_code'), type: 'python', success: false, error: ctx.t('code_empty') })
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }

    try {
      const environment = ctx.store.pythonSandbox || (ctx.store.TrustedPython ? 'trusted' : 'safe') || 'safe'
      const result = await ctx.safeIpcInvoke!('executePython', { code: codeToExecute, environment, input: null })

      if (result && result.success) {
        node.result = JSON.stringify({ result: result.output?.trim() || result.result || '✓', type: 'python', success: true, executionTime: result.executionTime, logs: result.logs })
        node.status = 'success'
        ctx.callbacks.onNodeStatusUpdate?.(node.id, 'success', node.result)
        ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'success', node.result)
        return true
      } else {
        let errorMessage = result?.error || result?.output || ctx.t('unknown_error')
        // 诊断增强：unknown_error 时把底层返回与调用上下文 dump 出来，便于定位
        if (!result?.error && !result?.output) {
          const dump = result === undefined || result === null
            ? 'executePython 返回空（IPC 未连通？）'
            : `返回: ${JSON.stringify(result).slice(0, 600)}`
          errorMessage += ` | 环境=${environment} 代码长度=${codeToExecute.length} | ${dump}`
        }
        node.result = JSON.stringify({ result: `${ctx.t('python_execution_error')}: ${errorMessage}`, type: 'python', success: false, error: errorMessage, timestamp: new Date().toISOString() })
        node.status = 'error'
        ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
        ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
        return false
      }
    } catch (error: any) {
      node.result = JSON.stringify({ result: `${ctx.t('python_execution_exception')}: ${error.message}`, type: 'python', success: false, error: error.message, timestamp: new Date().toISOString() })
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }
  }
}
