/**
 * tool（工具）执行器
 *
 * Dify 的工具来自插件市场，本地无插件运行时；因此这里把 **MCP** 作为本地实现路径：
 * 节点上带 `mcp_server`（或 `provider_type: 'mcp'`）时，通过 MCP 客户端调用工具。
 * 其余 provider（builtin / plugin / workflow …）会给出明确提示，而不是静默失败。
 */
import { stringifyValue } from '../template'
import { callMcpTool, resolveToolParameters, type McpServerConfigLike } from './shared/mcp'
import type { NodeExecutionContext, NodeExecutionResult, WorkflowNodeExecutor } from '../types'

export const toolExecutor: WorkflowNodeExecutor = {
  type: 'tool',
  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const data = ctx.node as unknown as Record<string, unknown>
    const toolName = stringifyValue(data.tool_name).trim()
    const providerType = String(data.provider_type ?? '')
    const serverConfig = data.mcp_server as McpServerConfigLike | undefined

    if (!serverConfig && providerType !== 'mcp') {
      throw new Error(
        `「${providerType || '未知'}」类型的工具需要 Dify 插件运行时，本地不可用；`
        + '请改用 MCP 工具（本节点支持 MCP 服务）或「MCP 工具」节点',
      )
    }
    if (!toolName) throw new Error('请先选择要调用的工具')

    const parameters = resolveToolParameters(ctx, (data.tool_parameters ?? {}) as Record<string, unknown>)
    const { text, json } = await callMcpTool(ctx, { serverConfig: serverConfig ?? {}, toolName, parameters })

    const outputs: Record<string, unknown> = { text }
    if (json !== undefined) outputs.json = json
    return { outputs }
  },
}
