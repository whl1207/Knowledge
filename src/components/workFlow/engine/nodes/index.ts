/**
 * engine/nodes/index - 节点执行器注册表
 *
 * 新增节点类型只需：
 * 1. 在 src/components/workFlow/nodes/ 下新建文件夹
 * 2. 在此文件导入并注册一行
 */
import { NodeExecutorRegistry } from '@/components/workFlow/engine/NodeExecutor'
import { startExecutor } from '@/components/workFlow/nodes/start/index'
import { endExecutor } from '@/components/workFlow/nodes/end/index'
import { textExecutor } from '@/components/workFlow/nodes/text/index'
import { reasoningExecutor } from '@/components/workFlow/nodes/reasoning/index'
import { decisionExecutor } from '@/components/workFlow/nodes/decision/index'
import { webExecutor } from '@/components/workFlow/nodes/web/index'
import { webpageExecutor } from '@/components/workFlow/nodes/webpage/index'
import { localExecutor } from '@/components/workFlow/nodes/local/index'
import { pythonExecutor } from '@/components/workFlow/nodes/python/index'
import { knowledgeExecutor } from '@/components/workFlow/nodes/knowledge/index'
import { structuredExecutor } from '@/components/workFlow/nodes/structured/index'
import { mcpExecutor } from '@/components/workFlow/nodes/mcp/index'
import { subflowExecutor } from '@/components/workFlow/nodes/subflow/index'
import { iterationExecutor } from '@/components/workFlow/nodes/iteration/index'
import { aggregatorExecutor } from '@/components/workFlow/nodes/aggregator/index'
import { listExecutor } from '@/components/workFlow/nodes/list/index'
import { dataExecutor } from '@/components/workFlow/nodes/data/index'
import { agentExecutor } from '@/components/workFlow/nodes/agent/index'
import { wordExecutor } from '@/components/workFlow/nodes/word/index'

export function createExecutorRegistry(): NodeExecutorRegistry {
  const registry = new NodeExecutorRegistry()
  registry.register(startExecutor)
  registry.register(endExecutor)
  registry.register(textExecutor)
  registry.register(reasoningExecutor)
  registry.register(decisionExecutor)
  registry.register(webExecutor)
  registry.register(webpageExecutor)
  registry.register(localExecutor)
  registry.register(pythonExecutor)
  registry.register(knowledgeExecutor)
  registry.register(structuredExecutor)
  registry.register(mcpExecutor)
  registry.register(subflowExecutor)
  registry.register(iterationExecutor)
  registry.register(aggregatorExecutor)
  registry.register(listExecutor)
  registry.register(dataExecutor)
  registry.register(agentExecutor)
  registry.register(wordExecutor)
  return registry
}
