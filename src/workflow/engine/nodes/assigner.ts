/**
 * assigner / variable-assigner（变量赋值）执行器
 *
 * 对齐 Dify：`items: [{ input_type: variable|constant, operation/write_mode, variable_selector, value }]`
 * - 目标是 `conversation` → 写会话变量
 * - 目标是容器节点 id → 改写该容器的循环变量（循环容器每轮会取回最新值）
 * - 其他节点目标：会写成该节点的输出覆盖（用于容器内回传结果）
 */
import { resolveSelector } from '../template'
import type { NodeExecutionContext, NodeExecutionResult, WorkflowNodeExecutor } from '../types'

interface AssignerItem {
  input_type?: 'variable' | 'constant'
  operation?: string
  write_mode?: string
  variable_selector?: string[]
  value?: unknown
}

function normalizeItems(raw: unknown): AssignerItem[] {
  return Array.isArray(raw) ? (raw as AssignerItem[]) : []
}

export function createAssignerExecutor(type: 'assigner' | 'variable-assigner'): WorkflowNodeExecutor {
  return {
    type,
    async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
      const data = ctx.node as unknown as Record<string, unknown>
      const items = normalizeItems(data.items)
      if (!items.length) throw new Error('请先配置赋值项')

      const updates: Record<string, unknown> = {}
      const conversationUpdates: Record<string, unknown> = {}
      const collected: Record<string, unknown> = {}

      for (const item of items) {
        const selector = item.variable_selector
        if (!selector || selector.length < 2) throw new Error('赋值项缺少目标变量')
        const [scope, ...path] = selector
        const name = path.join('.')
        const mode = item.operation || item.write_mode || 'over-write'

        if (mode === 'clear') {
          applyWrite(scope, name, undefined, updates, conversationUpdates)
          collected[name] = undefined
          continue
        }

        const raw = item.input_type === 'constant' ? item.value : resolveSelector(selectorOf(item), ctx.pool)
        let value = raw
        if (mode === 'append') {
          const current = updates[name] ?? ctx.pool.get(selector)
          if (Array.isArray(current)) value = [...current, raw]
          else value = `${current ?? ''}${raw ?? ''}`
        }

        applyWrite(scope, name, value, updates, conversationUpdates)
        collected[name] = value
      }

      for (const [name, value] of Object.entries(conversationUpdates)) ctx.log('info', `会话变量 ${name} 已更新`)
      return { outputs: updates, conversationUpdates }
    },
  }
}

/** 变量型赋值的取值来源：Dify 用 `value` 承载引用（数组形式） */
function selectorOf(item: AssignerItem): string[] {
  const raw = item.value
  if (Array.isArray(raw)) return raw as string[]
  return []
}

function applyWrite(
  scope: string,
  name: string,
  value: unknown,
  updates: Record<string, unknown>,
  conversationUpdates: Record<string, unknown>,
): void {
  if (scope === 'conversation') {
    conversationUpdates[name] = value
    return
  }
  updates[name] = value
}

export const assignerExecutor = createAssignerExecutor('assigner')
export const variableAssignerExecutor = createAssignerExecutor('variable-assigner')
