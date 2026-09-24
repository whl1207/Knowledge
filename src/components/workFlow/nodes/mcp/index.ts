/**
 * mcp executor - MCP节点
 */
import type { NodeExecutor, ExecutionContext } from '@/components/workFlow/engine/NodeExecutor'
import type { NodeData } from '@/components/workFlow/engine/WorkflowRunner'
import { mcpManager } from '@/platform/mcpManager'

export const mcpExecutor: NodeExecutor = {
  type: 'mcp',
  label: 'MCP节点',
  async execute(node: NodeData, ctx: ExecutionContext): Promise<boolean> {
    if (!node.mcpConfig) {
      node.result = JSON.stringify({ result: ctx.t('mcp_config_empty'), type: 'mcp', success: false, error: ctx.t('mcp_config_empty') })
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }

    // 解析连接模式：server=引用设置中的 MCP 服务（多节点共享同一连接），inline=节点内联配置
    const serverId = node.mcpConfig.mode === 'server' ? node.mcpConfig.serverId : undefined
    const serverName = serverId
      ? (ctx.store?.mcpServers || []).find((s: any) => s.id === serverId)?.name
      : undefined

    try {
      let connected = mcpManager.isConnected(node.id, serverId)
      if (!connected && node.mcpConfig.autoConnect !== false) {
        try {
          connected = await ctx.connectMcpNode(node.id)
          if (!connected) throw new Error(ctx.t('auto_connect_failed'))
        } catch (error: any) {
          node.result = JSON.stringify({ result: `${ctx.t('mcp_connect_failed')}: ${error.message}`, type: 'mcp', success: false, error: error.message, timestamp: new Date().toISOString() })
          node.status = 'error'
          ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
          ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
          return false
        }
      }

      if (!connected) {
        node.result = JSON.stringify({ result: ctx.t('mcp_not_connected'), type: 'mcp', success: false, error: ctx.t('mcp_not_connected'), timestamp: new Date().toISOString() })
        node.status = 'error'
        ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
        ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
        return false
      }

      const selectedTool = node.mcpConfig.selectedTool
      if (!selectedTool) {
        node.result = JSON.stringify({ result: ctx.t('no_mcp_tool_selected'), type: 'mcp', success: false, error: ctx.t('no_mcp_tool_selected'), availableTools: node.mcpTools?.map(t => t.name) || [], timestamp: new Date().toISOString() })
        node.status = 'error'
        ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
        ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
        return false
      }

      let toolArguments = node.mcpConfig.toolArguments || {}
      const contexts = await ctx.getNodeContextWithPorts(node.id, ctx.decisionPaths)
      if (contexts.length > 0 && (!toolArguments.input || !toolArguments.query)) {
        const combinedInput = contexts.join('\n\n')
        if (!toolArguments.input) toolArguments.input = combinedInput
        if (!toolArguments.query) toolArguments.query = combinedInput
      }
      if (node.prompt && node.prompt.trim() !== '' && !toolArguments.input && !toolArguments.query) {
        toolArguments.input = node.prompt
      }

      ctx.log(`${ctx.t('executing_mcp_tool')}: ${selectedTool}，${ctx.t('params')}: ${JSON.stringify(toolArguments)}`, 'info')

      const toolResult = await mcpManager.callTool(node.id, selectedTool, toolArguments, serverId)

      if (toolResult.success) {
        node.result = JSON.stringify({ type: 'mcp', success: true, result: toolResult.data, tool: selectedTool, arguments: toolArguments, serverId, serverName, rawResult: toolResult.raw, timestamp: new Date().toISOString() })
        node.status = 'success'
        ctx.callbacks.onNodeStatusUpdate?.(node.id, 'success', node.result)
        ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'success', node.result)
        ctx.log(`${ctx.t('mcp_tool_success')}: ${selectedTool}`, 'info')
        return true
      } else {
        node.result = JSON.stringify({ type: 'mcp', success: false, result: `${ctx.t('mcp_tool_failed')}: ${toolResult.error}`, tool: selectedTool, arguments: toolArguments, error: toolResult.error, details: toolResult.details, timestamp: new Date().toISOString() })
        node.status = 'error'
        ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
        ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
        ctx.log(`${ctx.t('mcp_tool_failed')}: ${selectedTool} - ${toolResult.error}`, 'error')
        return false
      }
    } catch (error: any) {
      node.result = JSON.stringify({ type: 'mcp', success: false, result: `${ctx.t('mcp_execution_exception')}: ${error.message}`, error: error.message, timestamp: new Date().toISOString() })
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      ctx.log(`${ctx.t('mcp_execution_exception')}: ${error.message}`, 'error')
      return false
    }
  }
}
