/**
 * ai-km-mcp（MCP 工具）执行器
 *
 * 与 `tool` 节点共用 MCP 调用实现；本节点把服务配置直接内联在节点上（或引用设置里的服务）。
 */
import { stringifyValue } from '../template'
import { callMcpTool, resolveToolParameters, type McpServerConfigLike } from './shared/mcp'
import type { NodeExecutionContext, NodeExecutionResult, WorkflowNodeExecutor } from '../types'

export const mcpToolExecutor: WorkflowNodeExecutor = {
  type: 'ai-km-mcp',
  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const data = ctx.node as unknown as Record<string, unknown>
    const toolName = stringifyValue(data.tool_name).trim()
    if (!toolName) throw new Error('请先选择要调用的工具')

    const server = (data.mcp_server ?? {}) as McpServerConfigLike
    const mode = server.mode ?? 'inline'

    // 引用设置里的服务时，从 store.mcpServers 取配置并沿用其 id
    let serverConfig: McpServerConfigLike = server
    let serverId = server.server_id || undefined
    if (mode === 'server') {
      const configured = (ctx.store?.mcpServers ?? []).find((item: any) => item?.id === serverId)
      if (!configured) throw new Error('引用的 MCP 服务不存在，请在设置里检查')
      serverConfig = {
        transport: configured.transport ?? 'stdio',
        command: configured.command,
        args: configured.args,
        env: configured.env,
        server_url: configured.serverUrl ?? configured.server_url,
      }
      serverId = configured.id
      ctx.log('info', `使用设置中的 MCP 服务：${configured.name || configured.id}`)
    }

    const parameters = resolveToolParameters(ctx, (data.tool_parameters ?? {}) as Record<string, unknown>)
    const { text, json } = await callMcpTool(ctx, { serverConfig, serverId, toolName, parameters })

    const outputs: Record<string, unknown> = { text }
    if (json !== undefined) outputs.json = json
    return { outputs }
  },
}
