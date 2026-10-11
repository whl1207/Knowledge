/**
 * code（代码执行）执行器
 *
 * 只支持 python3（走主进程 executePython）。变量通过**预置赋值**注入（JSON 字面量即合法 Python），
 * 与 Dify 一致：
 *  - 脚本定义了 `main` 函数时（Dify 的写法）自动按声明的变量调用它，返回值作为输出；
 *  - 否则要求脚本自己 print 一个 JSON 对象，其键就是节点的输出变量。
 */
import { resolveSelector } from '../template'
import type { NodeExecutionContext, NodeExecutionResult, WorkflowNodeExecutor } from '../types'

/** JSON 字面量转 Python 字面量（true/false/null 三个关键字不同） */
function toPythonLiteral(value: unknown): string {
  const json = JSON.stringify(value === undefined ? null : value)
  if (json === undefined) return 'None'
  return json.replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False').replace(/\bnull\b/g, 'None')
}

/**
 * 运行器：Dify 的代码节点把用户代码包在壳里，由壳调用 `main` 并输出返回值。
 * 参数按**声明顺序**位置传参（与 Dify 的变量列表 = 函数参数列表一致）。
 *
 * 注意：safe / workspace 沙箱限制很紧——主进程静态检查禁止 `getattr(` / `sys.` 等，
 * 运行层的内置函数白名单里也没有 `globals`，`_safe_import` 还会拒绝白名单外的模块
 * （`inspect` 会被拒），所以这里只用 `dir()` / `callable` / `print` / `import json`。
 */
const RUNNER = [
  '',
  '# 工作流运行器：脚本定义 main 时自动调用，返回的 JSON 即节点输出',
  'if "main" in dir() and callable(main):',
  '    import json as __wf_json',
  '    print(__wf_json.dumps(main(*__wf_args), ensure_ascii=False, default=str))',
].join('\n')

export const codeExecutor: WorkflowNodeExecutor = {
  type: 'code',
  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const data = ctx.node as unknown as Record<string, unknown>
    const language = String(data.code_language ?? 'python3')
    const code = String(data.code ?? '')
    if (!code.trim()) throw new Error('请先填写代码')
    if (language !== 'python3') {
      ctx.log('warning', `代码语言 ${language} 暂不支持，仅支持 python3`)
      throw new Error(`代码语言「${language}」暂不支持（仅支持 python3）`)
    }

    const variables = Array.isArray(data.variables)
      ? (data.variables as Array<{ variable?: string; value_selector?: string[] }>)
      : []
    const prelude: string[] = ['# 由工作流注入的变量']
    const declared: string[] = []
    for (const item of variables) {
      const name = String(item.variable || '').trim()
      if (!name) continue
      const value = resolveSelector(item.value_selector, ctx.pool)
      const literal = toPythonLiteral(value)
      prelude.push(`${name} = ${literal}`)
      declared.push(literal)
    }
    prelude.push(`__wf_args = [${declared.join(', ')}]`)

    const fullCode = `${prelude.join('\n')}\n\n${code}\n${RUNNER}`
    const environment = ctx.store?.pythonSandbox || (ctx.store?.TrustedPython ? 'trusted' : 'safe')
    ctx.log('info', `执行 Python（${environment}，${fullCode.length} 字符）`)

    const result = await ctx.invokeIpc('executePython', { code: fullCode, environment, input: null })
    if (!result) throw new Error('executePython 返回空（IPC 未连通？）')
    if (!result.success) throw new Error(String(result.error || result.output || '代码执行失败'))

    const text = String(result.output ?? result.result ?? '').trim()
    const outputs: Record<string, unknown> = {}

    // 约定：输出 JSON 对象时，其键作为输出变量（脚本自己 print 的内容另起一行，取最后一行 JSON）
    const parsed = parseJsonOutput(text)
    if (parsed.ok && parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)) {
      Object.assign(outputs, parsed.value as Record<string, unknown>)
    } else if (parsed.ok) {
      outputs.result = parsed.value
    } else {
      outputs.result = text
    }

    ctx.log('info', `执行完成${result.executionTime ? `（${result.executionTime}ms）` : ''}`)
    return { outputs }
  },
}

/** 解析执行输出：整段是 JSON 就用它，否则退到最后一行的 JSON */
function parseJsonOutput(text: string): { ok: boolean; value?: unknown } {
  if (!text) return { ok: false }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    // 继续尝试逐行
  }
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (!/^[[{]/.test(line)) continue
    try {
      return { ok: true, value: JSON.parse(line) }
    } catch {
      // 换上一行
    }
  }
  return { ok: false }
}
