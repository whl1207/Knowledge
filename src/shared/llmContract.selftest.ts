/**
 * llmContract.selftest.ts — 大模型契约层（流 / 结构化输出 / 错误分类）的纯逻辑自测
 *
 * 验的是"插件不必再自己 JSON.parse、也不必自己判断失败"这件事：
 * 分片拼装、终止帧、JSON 提取（含围栏与前后废话）、schema 浅校验、错误归类。
 */

import {
  assembleText,
  checkAgainstSchema,
  classifyLlmError,
  extractJson,
  finishOf,
  schemaInstruction,
  toPlainMessages,
  toChatMessages,
  type LlmChunk,
} from '@/shared/llmContract'

export interface SelfTestCase {
  name: string
  ok: boolean
  detail?: string
}

export function runLlmContractSelfTest(): SelfTestCase[] {
  const cases: SelfTestCase[] = []
  const check = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  // ---- 内容块 → 纯文本消息 ----
  const plain = toPlainMessages([
    { role: 'system', content: [{ type: 'text', text: '你是助手' }] },
    { role: 'user', content: [{ type: 'text', text: '第一行' }, { type: 'text', text: '第二行' }] },
  ])
  check(
    '文本块拼成字符串（多块用换行连接）',
    plain.ok === true && plain.messages.length === 2 && plain.messages[1].content === '第一行\n第二行',
    JSON.stringify(plain),
  )
  const withImage = toPlainMessages([{ role: 'user', content: [{ type: 'image', base64: 'AAAA' }] }])
  check(
    '图片块被明确拒绝（不把 base64 拼进 prompt）',
    withImage.ok === false && withImage.code === 'LLM_UNSUPPORTED_CONTENT',
    JSON.stringify(withImage),
  )
  // chat() 的入参：内容块必须变纯文本（曾经直接 String(content) → "[object Object]" 发给模型）
  const chatBlocks = toChatMessages([
    { role: 'user', content: [{ type: 'text', text: '把这段提炼成画面' }] },
    { role: 'user', content: '老写法的字符串' },
    { role: 'system', content: undefined },
  ])
  check(
    'toChatMessages：内容块 → 纯文本，不再是 [object Object]',
    chatBlocks.ok === true
      && chatBlocks.messages.length === 2
      && chatBlocks.messages[0].content === '把这段提炼成画面'
      && chatBlocks.messages[1].content === '老写法的字符串'
      && !JSON.stringify(chatBlocks).includes('[object Object]'),
    JSON.stringify(chatBlocks),
  )
  const chatBogus = toChatMessages([{ role: 'user', content: { foo: 1 } as any }])
  check('toChatMessages：非字符串/非块的对象 → LLM_FAILED（不许变成 [object Object]）', chatBogus.ok === false && chatBogus.code === 'LLM_FAILED', JSON.stringify(chatBogus))

  const chatImage = toChatMessages([{ role: 'user', content: [{ type: 'image', base64: 'AAA' }] as any }])
  check('toChatMessages：图片块 → LLM_UNSUPPORTED_CONTENT', chatImage.ok === false && chatImage.code === 'LLM_UNSUPPORTED_CONTENT', JSON.stringify(chatImage))

  const badShape = toPlainMessages([{ role: 'user' } as any])
  check('缺 content 数组 → LLM_FAILED', badShape.ok === false && badShape.code === 'LLM_FAILED', JSON.stringify(badShape))

  // ---- 流：拼装与终止帧 ----
  const chunks: LlmChunk[] = [
    { type: 'block-start', block: { kind: 'text' } },
    { type: 'text-delta', text: '你' },
    { type: 'text-delta', text: '好' },
    { type: 'finish', kind: 'ok', text: '你好' },
  ]
  check('assembleText 只拼 text-delta', assembleText(chunks) === '你好', assembleText(chunks))
  check('finishOf 取到终止帧', finishOf(chunks)?.kind === 'ok')
  check('没有 finish 的流 → finishOf 为 undefined', finishOf(chunks.slice(0, 3)) === undefined)

  // ---- JSON 提取 ----
  const direct = extractJson('{"a":1}')
  check('直接是 JSON → 解析成功', direct.ok === true && (direct as any).value.a === 1)
  const fenced = extractJson('这里是结果：\n```json\n{"risk":["x"]}\n```\n以上')
  check('Markdown 围栏 → 提取成功', fenced.ok === true && Array.isArray((fenced as any).value.risk))
  const noisy = extractJson('模型先解释了几句 {"total": 3} 后面还有话')
  check('前后有废话 → 取第一个平衡对象', noisy.ok === true && (noisy as any).value.total === 3)
  const nested = extractJson('{"a":{"b":[1,{"c":"}"}]}}')
  check('嵌套与字符串里的括号不误判', nested.ok === true && (nested as any).value.a.b[1].c === '}')
  const none = extractJson('没有 JSON 的一段话')
  check('没有 JSON → 失败', none.ok === false, JSON.stringify(none))

  // ---- schema 浅校验 ----
  const schema = { type: 'object', required: ['risk'], properties: { risk: { type: 'array' } } }
  check('符合 schema', checkAgainstSchema({ risk: [] }, schema).ok === true)
  const missing = checkAgainstSchema({ other: 1 }, schema)
  check('缺必填字段 → 报出字段名', missing.ok === false && String((missing as any).message).includes('risk'), JSON.stringify(missing))
  check('类型不符 → 失败', checkAgainstSchema([], schema).ok === false)
  check('无 type 的 schema 一律通过（不猜）', checkAgainstSchema({ any: 1 }, {}).ok === true)
  check(
    'schemaInstruction 带上 schema 正文',
    schemaInstruction({ name: 'risk', schema }).includes('"required"'),
    schemaInstruction({ name: 'risk', schema }).slice(0, 40),
  )

  // ---- 错误分类 ----
  check('401 → LLM_AUTH', classifyLlmError(new Error('HTTP 401 unauthorized'), false) === 'LLM_AUTH')
  check('429 → LLM_RATE_LIMIT', classifyLlmError(new Error('429 Too Many Requests'), false) === 'LLM_RATE_LIMIT')
  check('上下文超限 → LLM_CONTEXT_WINDOW', classifyLlmError(new Error('maximum context length exceeded'), false) === 'LLM_CONTEXT_WINDOW')
  check('额度 → LLM_QUOTA', classifyLlmError(new Error('insufficient_quota'), false) === 'LLM_QUOTA')
  check('未配置模型 → LLM_NO_MODEL', classifyLlmError(new Error('还没有选择模型'), false) === 'LLM_NO_MODEL')
  check('未知错误 → LLM_FAILED', classifyLlmError(new Error('boom'), false) === 'LLM_FAILED')
  check('aborted 优先于文案', classifyLlmError(new Error('HTTP 401'), true) === 'LLM_ABORTED')

  return cases
}
