/**
 * decision executor - 决策节点
 */
import type { NodeExecutor, ExecutionContext } from '@/components/workFlow/engine/NodeExecutor'
import type { NodeData } from '@/components/workFlow/engine/WorkflowRunner'
import { validateModelConfig, setAIModelConfig, extractBranchIdFromResponse } from '@/components/workFlow/engine/executorHelpers'

export const decisionExecutor: NodeExecutor = {
  type: 'decision',
  label: '决策节点',
  async execute(node: NodeData, ctx: ExecutionContext): Promise<boolean> {
    if (!node.decisionBranches || node.decisionBranches.length < 2) {
      node.result = JSON.stringify({ result: ctx.t('decision_need_branches'), type: 'decision', success: false, error: ctx.t('insufficient_branches') })
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }

    try {
      const contexts = await ctx.getNodeContextWithPorts(node.id, ctx.decisionPaths)
      const inputData = contexts.join('\n\n')
      let selectedBranchId = ''
      let reason = ''
      const mode = node.decisionMode || 'llm'

      if (mode === 'llm') {
        const validation = validateModelConfig(node, ctx.store, ctx.t)
        if (!validation.valid) {
          node.result = JSON.stringify({ result: ctx.t('configure_llm_model'), type: 'decision', success: false, error: ctx.t('model_not_configured') })
          node.status = 'error'
          ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
          ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
          return false
        }

        const branchesInfo = node.decisionBranches.map(b =>
          `${ctx.t('branch_id')}: ${b.id}\n${ctx.t('branch_name')}: ${b.name}\n${ctx.t('description')}: ${b.description || ctx.t('none')}`
        ).join('\n\n')
        const decisionPrompt = node.decisionPrompt ||
          `${ctx.t('decision_prompt_template')}\n\n${ctx.t('input_content')}：{input}\n\n${ctx.t('available_branches')}：{branches}\n\n${ctx.t('return_branch_id_only')}`
        const fullPrompt = ctx.resolveTemplate(
          decisionPrompt.replace('{input}', inputData).replace('{branches}', branchesInfo),
          node.id
        )
        const messages = [{ role: 'user', content: fullPrompt }]
        const originalConfig = setAIModelConfig(ctx.store, node)

        try {
          const aiResponse = await new Promise<string>((resolve, reject) => {
            if (!ctx.sendToAI) { reject(new Error('sendToAI 不存在')); return }
            ctx.sendToAI(messages, { onComplete: (c: string) => resolve(c), onError: (e: Error) => reject(e) }).catch(reject)
          })
          selectedBranchId = extractBranchIdFromResponse(aiResponse, node.decisionBranches)
          reason = `LLM: ${aiResponse}`
        } finally {
          if (ctx.store.AIconfig?.llm) ctx.store.AIconfig.llm = originalConfig
        }
      } else if (mode === 'rule') {
        if (!node.decisionRules) {
          node.result = JSON.stringify({ result: ctx.t('configure_decision_rules'), type: 'decision', success: false, error: ctx.t('rules_not_configured') })
          node.status = 'error'
          ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
          ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
          return false
        }
        try {
          const rules = JSON.parse(node.decisionRules)
          if (!Array.isArray(rules)) throw new Error(ctx.t('rules_must_be_array'))
          for (const rule of rules) {
            if (rule.condition && rule.branch) {
              try {
                const safeEval = (condition: string): boolean => {
                  if (condition === 'true') return true
                  if (condition === 'false') return false
                  const lenMatch = condition.match(/input\.length\s*([><=!]+)\s*(\d+)/)
                  if (lenMatch) {
                    const op = lenMatch[1]; const val = parseInt(lenMatch[2]); const il = inputData.length
                    if (op === '>') return il > val; if (op === '<') return il < val
                    if (op === '>=') return il >= val; if (op === '<=') return il <= val
                    if (op === '==') return il === val; if (op === '!=') return il !== val
                  }
                  const incMatch = condition.match(/input\.includes\('([^']+)'\)/)
                  if (incMatch) return inputData.includes(incMatch[1])
                  return false
                }
                if (safeEval(rule.condition)) { selectedBranchId = rule.branch; reason = `${ctx.t('rule_match')}: ${rule.condition}`; break }
              } catch { continue }
            }
          }
          if (!selectedBranchId && rules.length > 0) {
            const last = rules[rules.length - 1]
            if (last.branch) { selectedBranchId = last.branch; reason = ctx.t('default_rule') }
          }
        } catch (error: any) {
          node.result = JSON.stringify({ result: `${ctx.t('rule_parse_failed')}: ${error.message}`, type: 'decision', success: false, error: error.message })
          node.status = 'error'
          ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
          ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
          return false
        }
      }

      if (!selectedBranchId || !node.decisionBranches.some(b => b.id === selectedBranchId)) {
        selectedBranchId = node.decisionBranches[0].id
        reason = ctx.t('default_branch_no_valid')
      }

      ctx.decisionPaths.set(node.id, selectedBranchId)
      const selectedBranch = node.decisionBranches.find(b => b.id === selectedBranchId)
      ctx.decisionDataTemplates.set(node.id, selectedBranch?.dataTemplate || '{input}')

      ctx.callbacks.onDecisionBranchSelected?.(node.id, node.name, selectedBranchId, selectedBranch?.name || selectedBranchId, reason)

      node.result = JSON.stringify({
        type: 'decision', success: true, mode,
        selectedBranch: selectedBranchId, selectedBranchName: selectedBranch?.name || selectedBranchId,
        reason, dataTemplate: ctx.decisionDataTemplates.get(node.id),
        allBranches: node.decisionBranches, inputPreview: inputData,
        timestamp: new Date().toISOString()
      })
      node.status = 'success'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'success', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'success', node.result)
      return true
    } catch (error: any) {
      node.result = JSON.stringify({ result: `${ctx.t('decision_failed')}: ${error.message}`, type: 'decision', success: false, error: error.message, timestamp: new Date().toISOString() })
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }
  }
}
