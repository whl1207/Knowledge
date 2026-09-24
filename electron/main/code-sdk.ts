/**
 * code-sdk.ts — PTC（程序化工具调用 / Code Mode）执行引擎
 *
 * 借鉴 DeepSeek-Harness 的 Code Mode SDK 设计：
 * - **能力目录不变**（tools 白名单仍控制"能做什么"），但模型可见的工具呈现
 *   坍缩为单个 `run_code`：模型编写一段 TypeScript 程序，通过注入的 `ctx`
 *   SDK 组合多步操作（读文件 / 写文件 / 检索知识库 / 联网 / 执行 Python 等）。
 * - **SDK 从统一工具注册表的 schema 自动生成**（generateSdkDocs），保证模型
 *   看到的 API 与实际注册一致；SDK 运行时（buildSdkRuntime）对每个工具做
 *   `toolRegistry.execute(...)` 的薄封装，自动继承沙箱策略与路径围栏。
 * - 程序在 `node:vm` 中执行：**不注入 require/process/Buffer 等原始能力**，
 *   只暴露 SDK；超时与取消走 execCtx.signal；console 输出被捕获返回。
 *
 * 本模块不依赖 agent-loop / tools（避免循环导入），可被 tools.ts、agent-loop.ts、
 * ipc-registry.ts 三方安全引用。
 */

import ts from 'typescript'
import vm from 'node:vm'
import { toolRegistry } from '@/shared/toolRegistry'
import type { ToolExecutionContext, ToolResult } from '@/types/tool'

// ---------------------------------------------------------------------------
// run_code 工具定义（schema / 描述）
// ---------------------------------------------------------------------------

export const RUN_CODE_DESCRIPTION =
  '执行一段由模型编写的 TypeScript 程序（Code Mode）。' +
  'code 是 async TypeScript 函数的函数体（仅可擦除语法），程序内通过生成的 tools SDK 调用工具；' +
  '只有 run_code 可被直接调用。返回 { result, logs, toolCalls }。'

export const RUN_CODE_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    code: {
      type: 'string',
      description:
        'async TypeScript 函数的函数体（仅可擦除语法——不用 enum 或命名空间；类型标注仅供参考，运行时按类型剥离执行）。' +
        '程序内用 await tools.name(args) 调用工具，用 return 和/或 console.log(...) 输出结果。',
    },
    description: { type: 'string', description: '程序所做内容的简短摘要' },
  },
  required: ['code', 'description'],
}

/** agent-loop 在 PTC 呈现下暴露给模型的唯一工具 schema */
export function runCodeFunctionSchema(): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: 'run_code', description: RUN_CODE_DESCRIPTION, parameters: RUN_CODE_INPUT_SCHEMA },
  }
}

// ---------------------------------------------------------------------------
// SDK 声明生成（模型可见，注入系统提示词）
// 对齐 DeepSeek-Harness 的 Code Mode：固定使用说明 + 生成的 tools 声明
// ---------------------------------------------------------------------------

/** 固定的模型可见使用约定（对应 DSH SDK_INSTRUCTIONS，渲染于声明之上） */
const SDK_INSTRUCTIONS = `## 为 run_code 编写代码

\`run_code\` 有两个必填参数：\`code\` —— 一个 async TypeScript 函数的函数体（仅可擦除语法——不用 \`enum\` 或命名空间；类型标注仅供参考，代码运行时按类型剥离执行）—— 以及 \`description\`，对程序所做内容的简短摘要。程序内部：

- 以 \`await tools.name(args)\` 调用工具——对特殊名称用引号访问：\`tools["my-tool"](args)\`。每次调用都解析为该工具的类型化规范 JSON 值。工具参数必须是无损 JSON。
- 失败的调用会以 \`ToolCallError\` 拒绝（reject），其 \`toolName\` 标识失败的工具，\`message\` 是人类可读的说明——用 \`try/catch\` 捕获以处理并继续。
- 相互独立的只读调用可用 \`Promise.all\` 重叠并发；会改变状态的操作（写文件 / 执行命令等）请自行用 \`await\` 串行，引擎不保证并发写操作的提交顺序。有依赖的操作用 \`await\` 顺序衔接。
- 用 \`return\` 和/或 \`console.log(...)\` 输出结果。只有你 print 或 return 的内容才是程序输出。成功工具结果若包含图片，会在运行后附加，以便你在下一步检查；其它中间结果不会进入对话，因此只提取你需要的部分。

可用工具：`

/** 把一个 JSON Schema 的 properties 渲染为 TS 对象类型（用于 ToolArgsMap） */
function schemaToTsObject(props: Record<string, any> | undefined, required: string[] | undefined): string {
  if (!props || typeof props !== 'object') return '{}'
  const req = new Set(Array.isArray(required) ? required : [])
  const keys = Object.keys(props)
  if (keys.length === 0) return '{}'
  const members = keys.map((k) => {
    const t = props[k]?.type
    const tsType = t === 'number' || t === 'integer' ? 'number' : t === 'boolean' ? 'boolean' : t === 'array' ? 'JsonValue[]' : t === 'object' ? 'Record<string, JsonValue>' : 'string'
    return `  ${k}${req.has(k) ? '' : '?'}: ${tsType};`
  })
  return `{\n${members.join('\n')}\n}`
}

/** 生成 Code Mode 的 `tools:sdk` 提示词段：固定说明 + 生成的 tools 声明（对齐 DSH） */
export function generateSdkDocs(scope?: string, whitelist?: string[]): string {
  const defs = toolRegistry
    .list(scope)
    .filter((d) => d.name !== 'run_code')
    .filter((d) => !Array.isArray(whitelist) || whitelist.includes(d.name))
    .sort((a, b) => a.name.localeCompare(b.name))

  const argsMembers = defs.map((d) => {
    const desc = d.description.replace(/\s+/g, ' ').trim()
    const props = ((d.inputSchema as any)?.properties || {}) as Record<string, any>
    const required = (d.inputSchema as any)?.required as string[] | undefined
    const doc = desc ? `  /** ${desc.replaceAll('*/', String.raw`*\/`)} */\n` : ''
    return `${doc}  ${d.name}: ${schemaToTsObject(props, required)};`
  })
  const outputMembers = defs.map((d) => `  ${d.name}: JsonValue;`)

  const declaration = [
    'type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }',
    '',
    `interface ToolArgsMap {\n${argsMembers.join('\n')}\n}`,
    '',
    `interface ToolOutputMap {\n${outputMembers.join('\n')}\n}`,
    '',
    'type ToolName = keyof ToolOutputMap',
    '',
    'declare class ToolCallError extends Error {',
    '  readonly name: "ToolCallError";',
    '  readonly toolName: ToolName;',
    '}',
    '',
    'declare const tools: {',
    '  [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>;',
    '}',
  ].join('\n')

  return `${SDK_INSTRUCTIONS}\n\n\`\`\`ts\n${declaration}\n\`\`\``
}

// ---------------------------------------------------------------------------
// SDK 运行时（程序内注入的 tools 对象，对齐 DSH：tools.name(args)）
// ---------------------------------------------------------------------------

export interface InternalToolCall {
  name: string
  input: any
  ok: boolean
  error?: string
}

/** 失败的工具调用在程序内以 ToolCallError 拒绝（对齐 DSH 的失败契约） */
export class ToolCallError extends Error {
  readonly name = 'ToolCallError' as const
  readonly toolName: string
  constructor(toolName: string, message: string) {
    super(message)
    this.toolName = toolName
  }
}

/** 构建注入程序的 tools SDK：每个方法 = 对统一注册表的薄封装
 * 调用形态与 DSH 一致：tools.name(args)（args 为对象）；
 * 能力目录 = agent 的工具白名单（execCtx.tools 由 agent-loop 注入；null 表示全部），
 * 与 generateSdkDocs 保持一致；run_code 本身不进入 SDK（防递归）。 */
export function buildSdkRuntime(execCtx: ToolExecutionContext, calls: InternalToolCall[]): Record<string, (input?: any) => Promise<any>> {
  const tools: Record<string, (input?: any) => Promise<any>> = {}
  const whitelist = Array.isArray((execCtx as any).tools) ? ((execCtx as any).tools as string[]) : null
  const defs = toolRegistry
    .list(execCtx.scope)
    .filter((d) => d.name !== 'run_code')
    .filter((d) => whitelist === null || whitelist.includes(d.name))
  for (const def of defs) {
    tools[def.name] = async (input: any) => {
      const res = await toolRegistry.execute(def.name, input ?? {}, execCtx)
      calls.push({ name: def.name, input: input ?? {}, ok: res.ok, error: res.error })
      if (!res.ok) throw new ToolCallError(def.name, res.error || `工具 ${def.name} 执行失败`)
      return res.value
    }
  }
  return tools
}

// ---------------------------------------------------------------------------
// 程序执行（transpile TS → vm 沙箱）
// ---------------------------------------------------------------------------

export interface PtcRunOutput {
  result: unknown
  logs: Array<{ type: 'log' | 'info' | 'warn' | 'error'; text: string }>
  toolCalls: InternalToolCall[]
}

// ---------------------------------------------------------------------------
// 回给模型 vs 给界面：对齐 DSH「只有 return / console.log 是程序输出」
// ---------------------------------------------------------------------------
// 程序内的每次子调用都带完整入参：入参是模型自己写的、对下一步推理价值很低，
// 全量回灌会让上下文随程序规模线性膨胀（且落盘到会话日志 JSONL）。
// 因此：模型只收「子调用摘要」，完整入参走 ToolResult.preview（UI 专用，不进模型上下文）。
/** 返回值进上下文的上限（字符，超出截断并说明） */
const MODEL_RESULT_MAX = 16_000
/** console 日志进上下文的上限（字符，按条累加） */
const MODEL_LOGS_MAX = 8_000
/** 子调用摘要条数上限（超出只报个数） */
const MODEL_TOOLCALLS_MAX = 400

/** 程序输出 → 模型可见值（结果与日志有上限；子调用只留名字/成败） */
function buildModelFacingOutput(output: PtcRunOutput): Record<string, unknown> {
  const total = output.toolCalls.length
  const toolCalls = output.toolCalls
    .slice(0, MODEL_TOOLCALLS_MAX)
    .map((c) => (c.ok ? { name: c.name, ok: true } : { name: c.name, ok: false, error: c.error }))

  // console 日志：保留 {type,text} 数组形状（界面按级别着色），只按字符预算截断
  const logs: PtcRunOutput['logs'] = []
  let used = 0
  let logsTruncated = false
  for (const l of output.logs) {
    if (used >= MODEL_LOGS_MAX) { logsTruncated = true; break }
    const text = l.text.length > MODEL_LOGS_MAX - used ? l.text.slice(0, MODEL_LOGS_MAX - used) : l.text
    logs.push({ type: l.type, text })
    used += text.length
  }
  if (logsTruncated) logs.push({ type: 'info', text: `…（console 输出已截断，共 ${output.logs.length} 条）` })

  let result: unknown = output.result
  try {
    const s = typeof result === 'string' ? result : JSON.stringify(result ?? null)
    if (typeof s === 'string' && s.length > MODEL_RESULT_MAX) {
      result = s.slice(0, MODEL_RESULT_MAX)
        + '\n…（返回值已截断；需要完整内容请分步提取，或在界面查看完整返回值）'
    }
  } catch { /* 不可序列化的返回值原样返回 */ }

  return { result, logs, toolCalls, toolCallsOmitted: Math.max(0, total - MODEL_TOOLCALLS_MAX) }
}

function fmtConsoleArg(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    const s = JSON.stringify(v, (k, val) => (typeof val === 'bigint' ? `${val}n` : val), 2)
    return s === undefined ? String(v) : s
  } catch {
    return String(v)
  }
}

/**
 * 执行一段 PTC 程序（对齐 DSH：`code` 是 async TypeScript 函数的函数体）：
 * 1. 把 `code` 包装为 `(async (tools) => { ... })()` 并用 `ts.transpileModule` 转译；
 * 2. 在 `node:vm` 沙箱上下文中运行，注入 `tools`（SDK 运行时）、`ToolCallError`、
 *    捕获的 `console`；不暴露 require/process 等原始能力；
 * 3. 程序用 `return`/`console.log` 输出结果；超时 / 取消按 execCtx.signal 处理。
 */
export async function executeCodeProgram(
  code: unknown,
  execCtx: ToolExecutionContext,
  opts?: { timeoutMs?: number },
): Promise<ToolResult> {
  const codeText = String(code ?? '')
  if (!codeText.trim()) return { ok: false, error: 'code 参数必填' }

  // ---- 1. 包装为 async 函数体并转译（tools 是程序可用的自由绑定，经 vm 全局注入） ----
  const wrapped = `(async () => {\n${codeText}\n})()`
  let js: string
  try {
    const out = ts.transpileModule(wrapped, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        allowJs: true,
        strict: false,
      },
      fileName: 'ptc-program.ts',
    })
    js = out.outputText
  } catch (e: any) {
    return { ok: false, error: `程序编译失败: ${e?.message || String(e)}` }
  }

  // ---- 2. 沙箱上下文 ----
  const calls: InternalToolCall[] = []
  const logs: PtcRunOutput['logs'] = []
  const capturedConsole = {
    log: (...a: unknown[]) => logs.push({ type: 'log', text: a.map(fmtConsoleArg).join(' ') }),
    info: (...a: unknown[]) => logs.push({ type: 'info', text: a.map(fmtConsoleArg).join(' ') }),
    warn: (...a: unknown[]) => logs.push({ type: 'warn', text: a.map(fmtConsoleArg).join(' ') }),
    error: (...a: unknown[]) => logs.push({ type: 'error', text: a.map(fmtConsoleArg).join(' ') }),
  }
  const context: Record<string, unknown> = {
    module: { exports: {} },
    console: capturedConsole,
    tools: buildSdkRuntime(execCtx, calls),
    ToolCallError,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
  }
  context.exports = (context.module as { exports: object }).exports

  let script: vm.Script
  try {
    script = new vm.Script(js, { filename: 'ptc-program.js' })
  } catch (e: any) {
    const msg = e?.message || String(e)
    // 截断/不完整程序：通常是程序过长被模型输出截断（未闭合模板字符串/括号）
    const truncated = /Unexpected end of input|Unexpected token|Unterminated|Unterminated string/.test(msg)
    return {
      ok: false,
      error: truncated
        ? `程序不完整或被截断（${msg}）。请写一个**较短且完整**的程序：不要内嵌超大的字符串或大量数据；`
          + '需要时拆成多个 run_code 小步，或用 tools.run_python 传较短的代码（让 Python 自己读文件/联网）。'
        : `程序解析失败: ${msg}`,
    }
  }

  // ---- 3. 执行（Promise.race：超时 / 取消） ----
  const timeoutMs = opts?.timeoutMs ?? 120_000
  const ctxObj = vm.createContext(context)
  const runPromise = script.runInContext(ctxObj) as Promise<unknown>

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`程序执行超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs)
  })

  const signal = execCtx.signal
  let onAbort: (() => void) | undefined
  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error('程序执行已取消'))
        signal.addEventListener('abort', onAbort, { once: true })
      })
    : null

  try {
    const result = await Promise.race(
      abortPromise ? [runPromise, timeoutPromise, abortPromise] : [runPromise, timeoutPromise],
    )
    const output: PtcRunOutput = { result, logs, toolCalls: calls }
    return { ok: true, value: output }
  } catch (e: any) {
    return { ok: false, error: `程序执行失败: ${e?.message || String(e)}`, value: { logs, toolCalls: calls } }
  } finally {
    if (timer) clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
}

// ---------------------------------------------------------------------------
// run_code 工具 handler（tools.ts 注册时使用）
// ---------------------------------------------------------------------------

/** run_code 工具实现：把 code（async 函数体）连同 agent 执行上下文交给 executeCodeProgram；
 *  回给模型的值只含「返回值 / 日志 / 子调用摘要」，程序内完整入参经 preview 发给界面。 */
export async function runCodeHandler(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const res = await executeCodeProgram(input?.code, ctx)
  if (!res.ok) return res
  const output = res.value as PtcRunOutput
  return {
    ok: true,
    value: buildModelFacingOutput(output),
    preview: { kind: 'ptc-run', toolCalls: output.toolCalls.map((c) => ({ name: c.name, input: c.input, ok: c.ok, error: c.error })) },
  }
}
