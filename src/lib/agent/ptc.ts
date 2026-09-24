/**
 * ptc.ts — PTC（Code Mode）渲染进程辅助
 *
 * 提示词完全对齐 DeepSeek-Harness 的 Code Mode：标准提示 + 生成的 `tools:sdk` 段
 * （SDK 说明 + tools 声明，由主进程 code-sdk.ts 生成），不含其它附加提示。
 */

// ---------------------------------------------------------------------------
// 系统提示词组装
// ---------------------------------------------------------------------------

export interface BuildPtcPromptOptions {
  /** 基础提示（标准 Agent 提示），Code Mode 在其上叠加 tools:sdk 段 */
  basePrompt: string
  /** `tools:sdk` 段文本（来自主进程 agent:sdkDocs，DSH 固定说明 + 生成声明） */
  sdkDocs: string
}

/** 组装 Code Mode 系统提示词 = 基础提示 + tools:sdk 段（对齐 DSH，不加其它提示） */
export function buildPtcSystemPrompt(opts: BuildPtcPromptOptions): string {
  const { basePrompt, sdkDocs } = opts
  return [basePrompt, sdkDocs].filter(Boolean).join('\n\n')
}

// ---------------------------------------------------------------------------
// 结果解析
// ---------------------------------------------------------------------------

/** run_code 返回给模型的执行结果形状（与主进程 PtcRunOutput 对齐） */
export interface PtcRunOutput {
  result: unknown
  logs: Array<{ type: 'log' | 'info' | 'warn' | 'error'; text: string }>
  toolCalls: Array<{ name: string; input: any; ok: boolean; error?: string }>
}

/** 从 run_code 工具调用的 result 里安全提取 PtcRunOutput */
export function extractPtcRunOutput(raw: unknown): PtcRunOutput | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!('result' in r) && !('logs' in r) && !('toolCalls' in r)) return null
  return {
    result: r.result,
    logs: Array.isArray(r.logs) ? (r.logs as PtcRunOutput['logs']) : [],
    toolCalls: Array.isArray(r.toolCalls) ? (r.toolCalls as PtcRunOutput['toolCalls']) : [],
  }
}

/** 把任意值格式化为可读文本（供 UI pre 展示） */
export function formatPtcValue(v: unknown, maxLen = 6000): string {
  if (v === undefined) return 'undefined'
  if (v === null) return 'null'
  let s = ''
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v, (k, val) => (typeof val === 'bigint' ? `${val}n` : val), 2)
  } catch {
    s = String(v)
  }
  if (s === undefined) s = String(v)
  return s.length > maxLen ? s.substring(0, maxLen) + '\n... (truncated)' : s
}
