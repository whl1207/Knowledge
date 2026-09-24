/**
 * end executor - 结束节点
 */
import type { NodeExecutor, ExecutionContext } from '@/components/workFlow/engine/NodeExecutor'
import type { NodeData } from '@/components/workFlow/engine/WorkflowRunner'

export const endExecutor: NodeExecutor = {
  type: 'end',
  label: '结束节点',
  async execute(node: NodeData, ctx: ExecutionContext): Promise<boolean> {
    const sourceLinks = ctx.workflowData.links.filter(l => l.target === node.id)
    const results: Record<string, any> = {}

    for (const link of sourceLinks) {
      const sourceNode = ctx.workflowData.items.find(n => n.id === link.source)
      if (!sourceNode || sourceNode.status !== 'success') continue
      const nodeData = ctx.getSourceNodeData(sourceNode.id, link.sourcePort, node.id,
        ctx.decisionPaths, ctx.decisionDataTemplates)
      if (nodeData !== null) results[`node_${sourceNode.id}`] = nodeData
    }

    const summaryResult: any = {
      type: 'end', success: true, result: '',
      aggregated_results: results,
      decision_paths: Object.fromEntries(ctx.decisionPaths),
      timestamp: new Date().toISOString()
    }

    if (Object.keys(results).length > 0) {
      let outputText = ''
      if (ctx.decisionPaths.size > 0) {
        outputText += `## ${ctx.t('decision_paths')}\n\n`
        ctx.decisionPaths.forEach((branchId, nodeId) => {
          const dn = ctx.workflowData.items.find(n => n.id === nodeId)
          if (dn) { const b = dn.decisionBranches?.find(x => x.id === branchId); outputText += `- **${dn.name}** → ${b?.name || branchId}\n` }
        })
        outputText += '\n'
      }
      for (const [key, val] of Object.entries(results)) {
        const nid = key.replace('node_', '')
        const sn = ctx.workflowData.items.find(n => n.id === parseInt(nid))
        outputText += `\n## ${sn?.name || `${ctx.t('node')} ${nid}`}\n`
        outputText += typeof val === 'string' ? val : JSON.stringify(val, null, 2)
        outputText += '\n'
      }
      summaryResult.result = outputText
    } else {
      summaryResult.result = ctx.t('no_input_to_end')
    }

    node.result = JSON.stringify(summaryResult)
    node.status = 'success'
    ctx.callbacks.onNodeStatusUpdate?.(node.id, 'success', node.result)
    ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'success', node.result)
    return true
  }
}
