/**
 * ai-km-subflow（子工作流）执行器
 *
 * 读取另一个工作流文件（Dify DSL YAML）并作为独立运行执行：
 * - 入参：节点上 `variables` 绑定（变量名 → 上游取值），写入子流程开始节点的同名变量
 * - 出参：子流程结束节点声明的输出，直接成为本节点的输出变量
 */
import { parseDslYaml } from '@/features/workflow/dsl/codec'
import { validateAndNormalizeDsl } from '@/features/workflow/dsl/validator'
import { stringifyValue } from '../template'
import type { NodeExecutionContext, NodeExecutionResult, WorkflowNodeExecutor } from '../types'

interface SubflowInput {
  variable?: string
  value_selector?: string[]
}

export const subflowExecutor: WorkflowNodeExecutor = {
  type: 'ai-km-subflow',
  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const data = ctx.node as unknown as Record<string, unknown>
    const path = stringifyValue(data.subflow_path).trim()
    if (!path) throw new Error('请先选择要调用的工作流文件')

    // 1. 读取并校验子流程文件
    let content: string
    try {
      const raw = await ctx.readTextFile(path)
      content = typeof raw === 'string' ? raw : stringifyValue(raw)
    } catch (error) {
      throw new Error(`读取子工作流失败：${(error as Error).message}`)
    }
    if (!content.trim()) throw new Error('子工作流文件为空')

    let document
    try {
      const result = validateAndNormalizeDsl(parseDslYaml(content))
      if (!result.ok || !result.document) {
        throw new Error(result.issues.find((i) => i.level === 'error')?.message || '文件格式不正确')
      }
      document = result.document
    } catch (error) {
      throw new Error(`子工作流解析失败：${(error as Error).message}`)
    }

    // 2. 组装入参
    const variables = Array.isArray(data.variables) ? (data.variables as SubflowInput[]) : []
    const inputs: Record<string, unknown> = {}
    for (const item of variables) {
      const name = String(item.variable || '').trim()
      if (!name) continue
      inputs[name] = ctx.pool.get(item.value_selector)
    }
    ctx.log('info', `运行子工作流 ${path.split(/[\\/]/).pop()}（${Object.keys(inputs).length} 个入参）`)

    // 3. 运行（懒加载避免循环依赖：subflow → runner → nodes → subflow）
    const { WorkflowRunner } = await import('../runner')
    const runner = new WorkflowRunner({ store: ctx.store, t: ctx.t })
    const result = await runner.run(document, { inputs, signal: ctx.signal })

    if (result.status !== 'success') {
      throw new Error(`子工作流执行失败：${result.error || '未知错误'}`)
    }
    const outputs = Object.keys(result.outputs).length ? result.outputs : { output: '' }
    ctx.log('info', `子工作流完成（${result.elapsedMs}ms），输出 ${Object.keys(outputs).join('、')}`)
    return { outputs }
  },
}
