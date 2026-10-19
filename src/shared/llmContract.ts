/**
 * llmContract.ts — 插件大模型能力的**契约层**（纯逻辑，渲染层与自测共用）
 *
 * 形状对齐 DSH 的 `ctx.llm.stream`（见 docs/plan/插件能力面向DSH风格收敛-设计方案 §五）：
 * - **流**：`AsyncIterable<LlmChunk>`，**必以一个 `finish` 结束**；`aborted` / `error` 也是 `finish`，
 *   不是抛异常 —— 与 `ctx.agent.run` 的 `termination` 同一套哲学（失败不冒充成功、也不吞掉）；
 * - **稳定错误码**：`LLM_*` 族，插件按 code 分支，不解析 message；
 * - **结构化输出**：`schema` 由宿主负责"要求模型输出 JSON + 解析 + 浅校验"，
 *   失败给 `LLM_INVALID_OUTPUT`，而不是把半截文本丢给插件自己 `JSON.parse`。
 *
 * 有意不做（写清楚，免得被当成欠账）：
 * - **图片输入**：现有传输层（`AIUtils.sendChat`）只接受字符串内容，图片要改协议投影。
 *   这里先用 `LLM_UNSUPPORTED_CONTENT` 明确拒绝，而不是把 base64 拼进 prompt 冒充支持。
 * - **流式 token 用量**：传输层不解析 `usage` 分片，因此 `usage` 只在宿主拿得到时才发（当前不发）。
 * - **重试**：宿主不偷偷重试（DSH 也把重试做成独立组件）；要重试请插件自己决定。
 */

export const LLM_ERROR_CODES = [
  'LLM_NO_PROVIDER',
  'LLM_NO_MODEL',
  'LLM_NO_CREDENTIAL',
  'LLM_AUTH',
  'LLM_RATE_LIMIT',
  'LLM_CONTEXT_WINDOW',
  'LLM_QUOTA',
  'LLM_INVALID_OUTPUT',
  'LLM_UNSUPPORTED_CONTENT',
  'LLM_ABORTED',
  'LLM_FAILED',
] as const

export type LlmErrorCode = (typeof LLM_ERROR_CODES)[number]

export function isLlmErrorCode(value: unknown): value is LlmErrorCode {
  return typeof value === 'string' && (LLM_ERROR_CODES as readonly string[]).includes(value)
}

/** 一次调用的用量（宿主拿得到时才发；当前传输层不解析流式 usage） */
export interface LlmUsage {
  inputTokens?: number
  outputTokens?: number
}

export type LlmRole = 'system' | 'user' | 'assistant'

/**
 * 内容块。当前只实现 `text`；`image` 会被明确拒绝（`LLM_UNSUPPORTED_CONTENT`）。
 * 保留这个形状是为了让"以后支持图片"不需要改插件侧的类型。
 */
export type LlmContent =
  | { type: 'text'; text: string }
  | { type: 'image'; base64: string; mimeType?: string }

export interface LlmMessage {
  role: LlmRole
  content: LlmContent[]
}

/** 结构化输出要求：宿主把它变成"请只输出 JSON"的指令，并对结果做解析 + 浅校验 */
export interface LlmSchemaRequest {
  /** 给模型看的名字（可选，进提示词） */
  name?: string
  /** JSON Schema 的一个子集：目前用 `type` / `required` / `properties` 做浅校验 */
  schema: Record<string, unknown>
}

export type LlmFinishKind = 'ok' | 'error' | 'aborted'

export type LlmChunk =
  | { type: 'block-start'; block: { kind: 'text' } }
  | { type: 'text-delta'; text: string }
  | { type: 'usage'; usage: LlmUsage }
  | {
      type: 'finish'
      kind: LlmFinishKind
      code?: LlmErrorCode
      message?: string
      /** 结束时的完整文本（成功时 = 全部输出；失败时 = 中止前拿到的部分） */
      text?: string
      /** 给了 `schema` 且成功时的解析结果 */
      value?: unknown
    }

/**
 * 把内容块拼成现有传输层要的**字符串**消息。
 *
 * 图像块一律拒绝：拼进 prompt 只会让模型看到一坨 base64，比报错更糟。
 */
export function toPlainMessages(
  messages: LlmMessage[],
): { ok: true; messages: Array<{ role: LlmRole; content: string }> } | { ok: false; code: LlmErrorCode; message: string } {
  const out: Array<{ role: LlmRole; content: string }> = []
  for (const [i, m] of (Array.isArray(messages) ? messages : []).entries()) {
    if (!m || !Array.isArray(m.content)) return { ok: false, code: 'LLM_FAILED', message: `messages[${i}] 缺少 content 数组` }
    const parts: string[] = []
    for (const block of m.content) {
      if (!block || typeof block !== 'object') continue
      if ((block as { type?: string }).type === 'image') {
        return {
          ok: false,
          code: 'LLM_UNSUPPORTED_CONTENT',
          message: `messages[${i}] 含图片内容块：当前宿主只支持文本（图片输入尚未接通，别把 base64 拼进 prompt）`,
        }
      }
      const text = (block as { type?: string; text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
    out.push({ role: m.role || 'user', content: parts.join('\n') })
  }
  return { ok: true, messages: out }
}

/** `ctx.llm.chat()` 接受的消息形状：字符串内容（老写法）或内容块（与 `stream()` 一致） */
export interface ChatMessageInput {
  role?: string
  content?: string | Array<{ type?: string; text?: string }>
}

/**
 * 把 `chat()` 的入参归一成纯文本消息。
 *
 * 为什么必须单独有这一层：`chat()` 曾直接 `String(m.content)`——传内容块时得到的是
 * **"[object Object]"**，模型收到的就是这堆乱码（角色扮演插件的"模型提炼画面"踩过）。
 * 让"字符串 / 内容块"两条路都走这里，`stream()` 与 `chat()` 的形状才不会再次分叉。
 */
export function toChatMessages(
  input: ChatMessageInput[],
): { ok: true; messages: Array<{ role: LlmRole; content: string }> } | { ok: false; code: LlmErrorCode; message: string } {
  const out: Array<{ role: LlmRole; content: string }> = []
  for (const m of Array.isArray(input) ? input : []) {
    if (!m) continue
    if (Array.isArray(m.content)) {
      const one = toPlainMessages([{ role: (m.role || 'user') as LlmRole, content: m.content as LlmMessage['content'] }])
      if (!one.ok) return one
      out.push(one.messages[0])
      continue
    }
    if (m.content == null) continue // 没内容的消息直接跳过（与旧行为一致）
    if (typeof m.content !== 'string') {
      // 不许静默 String()：对象会被串成 "[object Object]" 发给模型，这种 bug 极难查
      return {
        ok: false,
        code: 'LLM_FAILED',
        message: `消息内容必须是字符串或内容块数组，收到 ${Object.prototype.toString.call(m.content)}`,
      }
    }
    out.push({ role: (m.role || 'user') as LlmRole, content: m.content })
  }
  return { ok: true, messages: out }
}

/** 由 chunks 拼出完整文本（自测与 `chat()` 的聚合实现共用） */
export function assembleText(chunks: LlmChunk[]): string {
  return chunks
    .filter((c): c is Extract<LlmChunk, { type: 'text-delta' }> => c.type === 'text-delta')
    .map((c) => c.text)
    .join('')
}

/** 终态校验：流里的最后一个 chunk 必须是 finish */
export function finishOf(chunks: LlmChunk[]): Extract<LlmChunk, { type: 'finish' }> | undefined {
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (chunks[i].type === 'finish') return chunks[i] as Extract<LlmChunk, { type: 'finish' }>
  }
  return undefined
}

/**
 * 把宿主/传输层的错误分类成稳定码。
 *
 * 为什么允许"看文案"分类：这一层的上游（fetch / 各家 SDK）只给 message，没有 code；
 * 分类只是为了让插件能分支（**不是**权限判据），分类不出来的统一 `LLM_FAILED`。
 */
export function classifyLlmError(error: unknown, aborted: boolean): LlmErrorCode {
  if (aborted) return 'LLM_ABORTED'
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const text = raw.toLowerCase()
  if (/401|403|unauthorized|invalid api key|authentication|permission denied/.test(text)) return 'LLM_AUTH'
  if (/429|rate limit|too many requests/.test(text)) return 'LLM_RATE_LIMIT'
  if (/context (length|window)|maximum context|too many tokens|prompt is too long/.test(text)) return 'LLM_CONTEXT_WINDOW'
  if (/quota|insufficient_quota|balance/.test(text)) return 'LLM_QUOTA'
  if (/api key|credential|not configured|未配置|缺少密钥/.test(text)) return 'LLM_NO_CREDENTIAL'
  if (/还没有选择模型|no model|model.*required/.test(text)) return 'LLM_NO_MODEL'
  return 'LLM_FAILED'
}

/** 从模型输出里取 JSON：容忍 ```json 围栏与前后废话（取第一段平衡的 {...} / [...]） */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  const raw = String(text ?? '').trim()
  if (!raw) return { ok: false, message: '输出为空' }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const candidates = [fenced ? fenced[1].trim() : '', raw]
  for (const candidate of candidates) {
    if (!candidate) continue
    const direct = tryParse(candidate)
    if (direct.ok) return direct
    const sliced = sliceBalanced(candidate)
    if (sliced) {
      const parsed = tryParse(sliced)
      if (parsed.ok) return parsed
    }
  }
  return { ok: false, message: '输出里没有可解析的 JSON' }
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

/** 取第一个平衡的 {...} 或 [...]（跳过字符串里的括号） */
function sliceBalanced(text: string): string | null {
  const start = text.search(/[[{]/)
  if (start < 0) return null
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/**
 * 对 `schema` 做**浅校验**（`type` / `required` / `properties.type`）。
 *
 * 为什么不实现完整 JSON Schema：宿主不该在插件链路上再养一个校验器实现；
 * 这里只做"能挡住最常见的错"的那一层，完整校验留给插件自己（文档写清）。
 */
export function checkAgainstSchema(value: unknown, schema: Record<string, unknown>): { ok: true } | { ok: false; message: string } {
  const type = typeof schema?.type === 'string' ? String(schema.type) : ''
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, message: `期望 object，实际 ${Array.isArray(value) ? 'array' : typeof value}` }
    const required = Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === 'string') : []
    const missing = required.filter((k) => !(k in (value as Record<string, unknown>)))
    if (missing.length) return { ok: false, message: `缺少必填字段：${missing.join(', ')}` }
    return { ok: true }
  }
  if (type === 'array') {
    return Array.isArray(value) ? { ok: true } : { ok: false, message: `期望 array，实际 ${typeof value}` }
  }
  if (type === 'string') return typeof value === 'string' ? { ok: true } : { ok: false, message: `期望 string，实际 ${typeof value}` }
  if (type === 'number') return typeof value === 'number' ? { ok: true } : { ok: false, message: `期望 number，实际 ${typeof value}` }
  if (type === 'boolean') return typeof value === 'boolean' ? { ok: true } : { ok: false, message: `期望 boolean，实际 ${typeof value}` }
  return { ok: true }
}

/** 由 schema 生成给模型的一段指令（结构化输出靠它，不靠 provider 私有参数） */
export function schemaInstruction(schema: LlmSchemaRequest): string {
  const name = schema?.name ? `「${schema.name}」` : ''
  return (
    `请只输出一个 JSON 值${name}，不要包含任何解释、前后缀或 Markdown 围栏之外的文字。` +
    `它必须满足下面的 JSON Schema：\n${JSON.stringify(schema.schema ?? {}, null, 2)}`
  )
}
