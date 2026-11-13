/**
 * toolCallRepair.ts — 修复模型把工具调用写成 XML 文本的情况
 *
 * 背景：部分模型（尤其非 OpenAI 原生 function calling 的本地/网关模型）会在正文里输出
 * `<tool_call><function=job_output><parameter=job_id>shell-2</tool_call>` 这类标记，
 * 甚至缺少 `</function>` / `</parameter>` 闭合。Agent 只认结构化 tool_calls，
 * 于是把它当普通正文，循环没有工具可执行就结束了。
 *
 * 这里做两件事（纯函数，主进程与自测共用）：
 * 1. 从正文中提取 XML 形态的工具调用并清理正文；
 * 2. 从畸形 arguments 原文中提取参数（作为 `_raw` 解析失败后的自动修复）。
 *
 * 只做保守修复：必须能识别出工具名，且调用方传入 knownTools 时名字必须存在。
 */

export interface RepairedToolCall {
  name: string
  args: Record<string, any>
}

export interface TextToolCallRepair {
  calls: RepairedToolCall[]
  /** 去掉被识别为工具调用的 XML 块后的正文 */
  cleaned: string
}

const FUNCTION_OPEN = /<function\s*(?:=\s*["']?([A-Za-z0-9_.-]+)["']?|name\s*=\s*["']([A-Za-z0-9_.-]+)["'])[^>]*>/i
const PARAM_OPEN = /<parameter\s*(?:=\s*["']?([A-Za-z0-9_.-]+)["']?|name\s*=\s*["']([A-Za-z0-9_.-]+)["'])[^>]*>/gi

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function parseValue(raw: string): any {
  const v = decodeEntities(String(raw || '')).trim()
  if (!v) return ''
  // 参数值本身常是 JSON 对象 / 数组；能解析就保留结构，不能就按字符串
  if ((v.startsWith('{') && v.endsWith('}')) || (v.startsWith('[') && v.endsWith(']'))) {
    try { return JSON.parse(v) } catch { /* 按字符串 */ }
  }
  return v
}

/** 解析一段 XML 里的全部 `<parameter=...>`；没有参数返回 null（避免把普通文本当工具调用） */
export function parseXmlToolArgs(text: string, expectedName?: string): Record<string, any> | null {
  const raw = String(text || '')
  if (!raw.includes('<parameter')) return null
  const args: Record<string, any> = {}
  PARAM_OPEN.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PARAM_OPEN.exec(raw))) {
    const key = String(m[1] || m[2] || '').trim()
    if (!key) continue
    const start = PARAM_OPEN.lastIndex
    const rest = raw.slice(start)
    // 值到最近一个闭合 / 下一个参数 / 工具调用结束为止；缺闭合也能拿到（用户示例就是缺闭合）
    const stop = rest.search(/<\/parameter>|<\/function>|<\/tool_call>|<parameter\s/i)
    const value = stop >= 0 ? rest.slice(0, stop) : rest
    args[key] = parseValue(value)
    PARAM_OPEN.lastIndex = start + (stop >= 0 ? stop : rest.length)
  }
  if (!Object.keys(args).length) return null
  if (expectedName && raw.includes('<function') && !FUNCTION_OPEN.test(raw)) return null
  return args
}

interface ParsedBlock { name: string; args: Record<string, any> }

function parseBlock(inner: string): ParsedBlock | null {
  const text = String(inner || '').trim()
  if (!text) return null
  // JSON 形态：<tool_call>{"name":"job_output","arguments":{"job_id":"shell-2"}}</tool_call>
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text)
      const name = String(obj?.name || obj?.tool || obj?.function?.name || '').trim()
      let args = obj?.arguments ?? obj?.args ?? obj?.function?.arguments ?? {}
      if (typeof args === 'string') {
        try { args = JSON.parse(args) } catch { args = {} }
      }
      if (name && args && typeof args === 'object' && !Array.isArray(args)) return { name, args }
    } catch { /* 继续按 XML 解析 */ }
  }
  const fn = FUNCTION_OPEN.exec(text)
  const name = String(fn?.[1] || fn?.[2] || '').trim()
  if (!name) return null
  const args = parseXmlToolArgs(text) || {}
  return { name, args }
}

/**
 * 从正文中提取 XML 工具调用。
 * @param text 模型正文
 * @param knownTools 允许的工具名（通常是本 turn 冻结的模型可见工具）；不传则不校验
 */
export function repairTextToolCalls(
  text: string,
  knownTools?: readonly string[] | null,
): TextToolCallRepair | null {
  const source = String(text || '')
  if (!source.includes('<tool_call') && !source.includes('<function')) return null
  const known = knownTools ? new Set(knownTools.map(String)) : null
  const calls: RepairedToolCall[] = []
  const ranges: Array<{ start: number; end: number }> = []

  // 优先按 <tool_call>...</tool_call> 分块；没有闭合时取到文本末尾
  const blockRe = /<tool_call\b[^>]*>([\s\S]*?)(?:<\/tool_call>|$)/gi
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(source))) {
    const parsed = parseBlock(m[1])
    if (parsed && (!known || known.has(parsed.name))) {
      calls.push({ name: parsed.name, args: parsed.args })
      ranges.push({ start: m.index, end: m.index + m[0].length })
    }
  }
  // 没有 <tool_call> 包裹、只有 <function=...> 的裸写法；必须有 <parameter（否则
  // 普通正文里提到 "<function=foo>" 也会被误当成调用）
  if (!calls.length && source.includes('<function') && source.includes('<parameter')) {
    const parsed = parseBlock(source)
    if (parsed && (!known || known.has(parsed.name))) {
      calls.push({ name: parsed.name, args: parsed.args })
      ranges.push({ start: 0, end: source.length })
    }
  }
  if (!calls.length) return null

  // 清理正文（保留 XML 块之外的文字；多块时从后往前删，避免下表偏移）
  let cleaned = source
  for (const r of ranges.sort((a, b) => b.start - a.start)) {
    cleaned = cleaned.slice(0, r.start) + cleaned.slice(r.end)
  }
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim()
  return { calls, cleaned }
}
