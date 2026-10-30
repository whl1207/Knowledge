/**
 * outputTokens.selftest.ts — 输出上限夹取 / 降级 / 错误识别的纯逻辑自测
 *
 * 覆盖的是「请求前夹取」「400 降级」「报文识别」「字段定位」四件事：
 * 任何一条判错都会变成线上事故（要么白 400，要么把用户设的大值悄悄砍小）。
 *
 * 运行：node scripts/run-selftests.mjs outputTokens
 */

import {
  DEFAULT_MAX_TOKENS,
  MAX_TOKENS_SETTING_MAX,
  MIN_MAX_TOKENS,
  bodyMaxTokensField,
  clampBodyMaxTokens,
  clampMaxTokens,
  downgradeBodyMaxTokens,
  inferLimitModel,
  inferLimitProvider,
  isMaxTokensTooLargeError,
  knownMaxOutputTokens,
  normalizeRequestedMaxTokens,
} from './outputTokens'

interface Case {
  name: string
  ok: boolean
  detail?: string
}

const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

export function runOutputTokensSelfTest(): Case[] {
  const cases: Case[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, detail })

  // ---------- 上限表 ----------
  add('已知上限：gpt-4o 家族 16384', knownMaxOutputTokens('openai', 'gpt-4o-mini') === 16_384)
  add('已知上限：模型名大小写不敏感', knownMaxOutputTokens('openai', 'GPT-4O') === 16_384)
  add('已知上限：gpt-4-turbo 4096', knownMaxOutputTokens('openai', 'gpt-4-turbo-2024-04-09') === 4_096)
  add('已知上限：gpt-4 8192', knownMaxOutputTokens('openai', 'gpt-4') === 8_192)
  add('已知上限：gpt-4-32k 32768（先于 gpt-4 匹配）', knownMaxOutputTokens('openai', 'gpt-4-32k') === 32_768)
  add('已知上限：claude-3-haiku 4096', knownMaxOutputTokens('anthropic', 'claude-3-haiku-20240307') === 4_096)
  add('已知上限：claude-3-5-sonnet 8192', knownMaxOutputTokens('anthropic', 'claude-3-5-sonnet-20241022') === 8_192)
  add('已知上限：claude-3-5-haiku 8192（不是 4096）', knownMaxOutputTokens('anthropic', 'claude-3-5-haiku-latest') === 8_192)
  add('未知来源不夹取：deepseek', knownMaxOutputTokens('deepseek', 'deepseek-flash') === undefined)
  add('未知来源不夹取：ollama', knownMaxOutputTokens('ollama', 'qwen3:8b') === undefined)
  add('未知模型不夹取：gpt-5', knownMaxOutputTokens('openai', 'gpt-5') === undefined)

  // ---------- 夹取 ----------
  add('夹取：64000 → gpt-4o 上限', clampMaxTokens(64_000, 'openai', 'gpt-4o') === 16_384)
  add('夹取：未超上限保持原值', clampMaxTokens(8_000, 'openai', 'gpt-4o') === 8_000)
  add('夹取：未知模型保持原值', clampMaxTokens(64_000, 'openai', 'some-gateway-model') === 64_000)
  add('夹取：非法值回落默认值（未知模型）', clampMaxTokens('abc', 'openai', 'gpt-5') === DEFAULT_MAX_TOKENS)
  add('夹取：非法值回落默认值后仍受已知上限约束', clampMaxTokens('abc', 'openai', 'gpt-4o') === 16_384)
  add('归一：负数回落默认值', normalizeRequestedMaxTokens(-1) === DEFAULT_MAX_TOKENS)
  add('归一：超设置上限被截断', normalizeRequestedMaxTokens(10 ** 9) === MAX_TOKENS_SETTING_MAX)
  add('归一：小数向下取整', normalizeRequestedMaxTokens(1_234.9) === 1_234)

  // ---------- 字段定位 ----------
  {
    const body: any = { max_tokens: 4_000 }
    const f = bodyMaxTokensField(body)
    add('字段：OpenAI chat 的 max_tokens', !!f && num(f.get()) === 4_000, f ? String(f.get()) : 'null')
    f?.set(1_234)
    add('字段：set 写回原对象', body.max_tokens === 1_234)
  }
  add('字段：Responses 的 max_output_tokens', num(bodyMaxTokensField({ max_output_tokens: 900 })?.get()) === 900)
  add('字段：Google 的 generationConfig.maxOutputTokens', num(bodyMaxTokensField({ generationConfig: { maxOutputTokens: 700 } })?.get()) === 700)
  add('字段：Ollama 的 options.num_predict', num(bodyMaxTokensField({ options: { num_predict: 300 } })?.get()) === 300)
  add('字段：没有上限字段返回 null', bodyMaxTokensField({ messages: [] }) === null)
  add('字段：null body 返回 null', bodyMaxTokensField(null) === null)

  // ---------- 请求前夹取（body） ----------
  {
    const body: any = { model: 'gpt-4o', max_tokens: 64_000 }
    const r = clampBodyMaxTokens(body, 'openai', 'gpt-4o')
    add('body 夹取：64000 → 16384 并回报 from/to', !!r && r.from === 64_000 && r.to === 16_384 && body.max_tokens === 16_384, JSON.stringify(r))
  }
  {
    const body: any = { model: 'gpt-4o', max_tokens: 8_000 }
    add('body 夹取：未超上限不动', clampBodyMaxTokens(body, 'openai', 'gpt-4o') === null && body.max_tokens === 8_000)
  }
  {
    const body: any = { model: 'deepseek-flash', max_tokens: 200_000 }
    add('body 夹取：未知来源不动', clampBodyMaxTokens(body, 'deepseek', 'deepseek-flash') === null && body.max_tokens === 200_000)
  }
  {
    const body: any = { max_tokens: 200_000 }
    add('body 夹取：没有模型名不夹（端点也解析不到时）',
      clampBodyMaxTokens(body, 'openai', undefined) === null && body.max_tokens === 200_000)
  }

  // ---------- 降级 ----------
  {
    const body: any = { max_tokens: 16_384 }
    const a = downgradeBodyMaxTokens(body)
    const b = downgradeBodyMaxTokens(body)
    const c = downgradeBodyMaxTokens(body)
    add('降级：16384 → 8192 → 4096 → null', a === 8_192 && b === 4_096 && c === null && body.max_tokens === MIN_MAX_TOKENS, `${a}/${b}/${c}`)
  }
  {
    const body: any = { max_tokens: 5_000 }
    add('降级：4096 以下不再降', downgradeBodyMaxTokens(body) === 4_096 && body.max_tokens === 4_096)
  }
  add('降级：没有上限字段返回 null', downgradeBodyMaxTokens({ messages: [] }) === null)

  // ---------- 400 报文识别 ----------
  add('识别：OpenAI 原文', isMaxTokensTooLargeError(
    '{"error":{"message":"max_tokens is too large: 32768. This model supports at most 16384 completion tokens, whereas you provided 32768."}}'))
  add('识别：Anthropic 原文', isMaxTokensTooLargeError(
    '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 32768 > 4096, which is the maximum allowed number of output tokens for claude-3-haiku-20240307"}}'))
  add('识别：max_output_tokens 文案', isMaxTokensTooLargeError('{"error":{"message":"Invalid \'max_output_tokens\': value exceeds the maximum allowed"}}'))
  add('识别：中文网关文案', isMaxTokensTooLargeError('{"error":"max_tokens 超过上限，请调小"}'))
  add('不误判：上下文超限', !isMaxTokensTooLargeError('This model\'s maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.'))
  add('不误判：普通鉴权错误', !isMaxTokensTooLargeError('{"error":{"message":"Incorrect API key provided"}}'))
  add('不误判：空串', !isMaxTokensTooLargeError(''))

  // ---------- 来源 / 模型推断 ----------
  add('推断来源：Anthropic 端点', inferLimitProvider('https://api.anthropic.com/v1/messages') === 'anthropic')
  add('推断来源：Anthropic 头（自建网关）', inferLimitProvider('https://gw.example.com/v1/messages', { 'anthropic-version': '2023-06-01' }) === 'anthropic')
  add('推断来源：OpenAI 端点', inferLimitProvider('https://api.openai.com/v1/chat/completions') === 'openai')
  add('推断来源：Azure 端点', inferLimitProvider('https://x.openai.azure.com/openai/deployments/gpt-4o/chat/completions') === 'openai')
  add('推断来源：本地 / 未知端点为空', inferLimitProvider('http://127.0.0.1:11434/api/chat') === '')
  add('推断模型：body.model 优先', inferLimitModel('http://x/v1/chat/completions', { model: 'gpt-4o' }) === 'gpt-4o')
  add('推断模型：Azure 部署名', inferLimitModel('https://x.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-02-15', {}) === 'gpt-4o')
  add('推断模型：Google URL', inferLimitModel('https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=x', {}) === 'gemini-pro')
  add('推断模型：都没有为空', inferLimitModel('http://127.0.0.1:11434/api/chat', {}) === '')

  // 一致性：默认值必须落在设置范围内，否则设置页会显示一个填不进去的值
  add('默认值在设置范围内', DEFAULT_MAX_TOKENS > MIN_MAX_TOKENS && DEFAULT_MAX_TOKENS <= MAX_TOKENS_SETTING_MAX)

  return cases
}

/** 供日志型调用方使用（runner 优先用 run*，这里保持与其它套件一致的入口名） */
export function logOutputTokensSelfTest(): boolean {
  const cases = runOutputTokensSelfTest()
  const bad = cases.filter((c) => !c.ok)
  for (const c of cases) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  — ' + c.detail : ''}`)
  console.log(`[outputTokens] ${cases.length - bad.length}/${cases.length} passed`)
  return bad.length === 0
}
