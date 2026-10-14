/**
 * deepseekSearch.selftest.ts — DeepSeek 搜索的请求组装与响应解析自测（纯计算，无网络）
 *
 * 重点覆盖两处最容易写错的地方：
 *  1. 请求体**必须**带 `tools` 声明（少了它请求照样 200，但不会有任何搜索结果块）；
 *  2. 摘要**只能**从 citations 取（结果项本身没有 snippet）。
 *
 * 用法：`npm run test:selftest`
 */

import {
  buildDeepSeekSearchRequest,
  buildDeepSeekSearchUrl,
  collectAnswerText,
  collectCitationSnippets,
  DEEPSEEK_SEARCH_DEFAULT_BASE_URL,
  DEEPSEEK_SEARCH_DEFAULT_MAX_TOKENS,
  DEEPSEEK_SEARCH_DEFAULT_MAX_USES,
  DEEPSEEK_SEARCH_DEFAULT_MODEL,
  DEEPSEEK_SEARCH_TOOL_TYPE,
  DeepSeekSearchError,
  parseDeepSeekSearchResponse,
  type DeepSeekSearchItem,
} from './deepseekSearch'

export interface DeepSeekSearchCase {
  name: string
  ok: boolean
  detail?: string
}

/** 造一个"标准"的 Anthropic Messages 响应：text 块带 citations + 一个 tool_result 块 */
function makeResponse(
  items: Array<{ title: string; url: string; age?: string }>,
  citations: Array<{ url: string; text: string }> = [],
  answerText = '根据搜索结果……',
) {
  const blocks: any[] = []
  if (answerText) {
    blocks.push({
      type: 'text',
      text: answerText,
      citations: citations.map((c) => ({ type: 'web_search_result_location', url: c.url, cited_text: c.text, title: 'x' })),
    })
  } else if (citations.length) {
    blocks.push({
      type: 'text',
      text: '',
      citations: citations.map((c) => ({ type: 'web_search_result_location', url: c.url, cited_text: c.text, title: 'x' })),
    })
  }
  blocks.push({ type: 'text', text: '总结：……' })
  blocks.push({
    type: 'web_search_tool_result',
    tool_use_id: 'toolu_1',
    content: items.map((i) => ({ type: 'web_search_result', url: i.url, title: i.title, page_age: i.age ?? null })),
  })
  return { id: 'msg_1', type: 'message', role: 'assistant', model: 'deepseek-v4-flash', content: blocks }
}

export function runDeepSeekSearchSelfTest(): DeepSeekSearchCase[] {
  const cases: DeepSeekSearchCase[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  // 1. URL 组装
  {
    add('默认端点 = Anthropic 兼容 /v1', DEEPSEEK_SEARCH_DEFAULT_BASE_URL === 'https://api.deepseek.com/anthropic/v1', DEEPSEEK_SEARCH_DEFAULT_BASE_URL)
    add('URL 补 /messages', buildDeepSeekSearchUrl() === 'https://api.deepseek.com/anthropic/v1/messages', buildDeepSeekSearchUrl())
    add('URL 容忍尾斜杠', buildDeepSeekSearchUrl('https://x.dev/anthropic/v1/') === 'https://x.dev/anthropic/v1/messages')
    // 与对话端点相互独立：自定义 base 必须生效（DSH 也支持 $DEEPSEEK_SEARCH_BASE_URL 单独覆盖）
    add('自定义 base 生效', buildDeepSeekSearchUrl('http://localhost:8000/v1') === 'http://localhost:8000/v1/messages')
  }

  // 2. 请求体：必须有 tools 声明（少了它 = 静默无结果）
  {
    const body: any = buildDeepSeekSearchRequest({ query: '上海的天气' })
    add('带 model', body.model === DEEPSEEK_SEARCH_DEFAULT_MODEL, String(body.model))
    add('带 max_tokens', body.max_tokens === DEEPSEEK_SEARCH_DEFAULT_MAX_TOKENS)
    add('**带 tools 声明**（否则搜索不触发）', Array.isArray(body.tools) && body.tools.length === 1)
    add('工具类型 = web_search_20250305', body.tools?.[0]?.type === DEEPSEEK_SEARCH_TOOL_TYPE, String(body.tools?.[0]?.type))
    add('工具名 = web_search', body.tools?.[0]?.name === 'web_search')
    add('带 max_uses', body.tools?.[0]?.max_uses === DEEPSEEK_SEARCH_DEFAULT_MAX_USES)
    add('查询词进 user 消息', String(body.messages?.[0]?.content || '').includes('上海的天气'))
    add('user 消息只有一条', body.messages?.length === 1)
    add('role = user', body.messages?.[0]?.role === 'user')
    // 覆盖项
    const custom: any = buildDeepSeekSearchRequest({ query: 'q', model: 'other-model', maxUses: 2, maxTokens: 100 })
    add('覆盖 model', custom.model === 'other-model')
    add('覆盖 maxUses', custom.tools?.[0]?.max_uses === 2)
    add('覆盖 maxTokens', custom.max_tokens === 100)
    // 非法值回落
    const bad: any = buildDeepSeekSearchRequest({ query: 'q', maxUses: 0, maxTokens: -5 })
    add('maxUses=0 回落为 >=1', bad.tools?.[0]?.max_uses >= 1)
    add('maxTokens 负数回落为 >=1', bad.max_tokens >= 1)
  }

  // 3. citations 映射：首个 URL 胜出
  {
    const map = collectCitationSnippets([
      { type: 'text', citations: [{ url: 'https://a', cited_text: '第一段' }, { url: 'https://a', cited_text: '重复段' }] },
      { type: 'text', citations: [{ url: 'https://b', cited_text: '第二段' }] },
      { type: 'web_search_tool_result', content: [] },
    ])
    add('citations：收录两个 URL', map.size === 2, `size=${map.size}`)
    add('citations：同 URL 首次胜出', map.get('https://a') === '第一段', String(map.get('https://a')))
    add('citations：忽略非 text 块', !map.has('https://c'))
    add('citations：空输入不炸', collectCitationSnippets(undefined).size === 0 && collectCitationSnippets([]).size === 0)
    add('citations：缺 cited_text 的条目被跳过', collectCitationSnippets([{ type: 'text', citations: [{ url: 'https://d' }] }]).size === 0)
  }

  // 4. 正常解析：摘要来自 citations（**核心断言**）
  {
    const data = makeResponse(
      [{ title: '结果一', url: 'https://a' }, { title: '结果二', url: 'https://b' }],
      [{ url: 'https://a', text: 'A 的引用片段' }, { url: 'https://b', text: 'B 的引用片段' }],
    )
    const { items, answer } = parseDeepSeekSearchResponse(data)
    add('解析：两条结果', items.length === 2, `len=${items.length}`)
    add('解析：标题正确', items[0]?.title === '结果一')
    add('解析：链接正确', items[0]?.url === 'https://a')
    add('解析：**摘要来自 citations**', items[0]?.snippet === 'A 的引用片段', JSON.stringify(items[0]?.snippet))
    add('解析：第二条摘要也来自 citations', items[1]?.snippet === 'B 的引用片段')
    // 总结正文（服务端那一轮模型作答）必须带出来，否则白付了模型调用
    add('解析：**带出总结正文**', answer.includes('根据搜索结果'), JSON.stringify(answer))
    add('解析：总结包含多个 text 块', answer.includes('总结：'), JSON.stringify(answer))
  }

  // 4b. 总结正文：拼接 / 去空 / 无 text 块时为空串
  {
    const onlyTool = { content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://x', title: 't' }] }] }
    add('总结：没有 text 块时为空串', parseDeepSeekSearchResponse(onlyTool).answer === '')
    const withEmpty = {
      content: [
        { type: 'text', text: '   ' },
        { type: 'text', text: '有效总结' },
        { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://y', title: 't' }] },
      ],
    }
    add('总结：空白块被跳过', parseDeepSeekSearchResponse(withEmpty).answer === '有效总结')
    add('collectAnswerText：非数组输入不炸', collectAnswerText(undefined) === '' && collectAnswerText('x' as any) === '')
  }

  // 5. 关键回归：结果项本身没有 snippet，且**不能**凭空造一个
  {
    const data = makeResponse([{ title: '无引用', url: 'https://c' }], [], '')
    const { items } = parseDeepSeekSearchResponse(data)
    add('无 citations 时摘要为空（不编造）', items[0]?.snippet === '', JSON.stringify(items[0]?.snippet))
    add('无 citations 时仍返回结果', items.length === 1)
  }

  // 6. 去重 + 上限
  {
    const data = makeResponse([
      { title: 'a', url: 'https://same' },
      { title: 'b', url: 'https://same' },
      { title: 'c', url: 'https://other' },
    ])
    const { items } = parseDeepSeekSearchResponse(data)
    add('去重：同 URL 只保留一条', items.length === 2, `len=${items.length}`)
    add('去重：保留首次出现', items[0]?.title === 'a')

    const many = makeResponse(Array.from({ length: 12 }, (_, i) => ({ title: 't' + i, url: 'https://u' + i })))
    add('上限：maxResults=3 生效', parseDeepSeekSearchResponse(many, 3).items.length === 3)
    add('上限：默认 8', parseDeepSeekSearchResponse(many).items.length === 8)
    add('上限：截断时总结仍在', parseDeepSeekSearchResponse(many, 3).answer.length > 0)
  }

  // 7. 多个结果块合并（max_uses > 1 时可能出现）
  {
    const data = {
      content: [
        { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://1', title: 'one' }] },
        { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://2', title: 'two' }] },
      ],
    }
    const { items } = parseDeepSeekSearchResponse(data)
    add('多块：合并为一个列表', items.length === 2, `len=${items.length}`)
  }

  // 8. 失败必须显式（不能静默当成"0 条结果"）
  {
    const noBlocks = { content: [{ type: 'text', text: '我没搜，直接回答' }] }
    let err: any
    try { parseDeepSeekSearchResponse(noBlocks) } catch (e) { err = e }
    add('**无结果块 → 抛错**（不当作 0 条结果）', err instanceof DeepSeekSearchError, String(err?.name))
    add('无结果块的 code = WEB_PROVIDER_ERROR', err?.code === 'WEB_PROVIDER_ERROR')
    add('错误信息提示"可能没触发搜索"', String(err?.message || '').includes('触发'))

    let err2: any
    try { parseDeepSeekSearchResponse({}) } catch (e) { err2 = e }
    add('缺 content → 抛错', err2 instanceof DeepSeekSearchError)

    let err3: any
    try { parseDeepSeekSearchResponse({ content: [{ type: 'web_search_tool_result', content: [] }] }) } catch (e) { err3 = e }
    add('块存在但无可用项 → 抛错', err3 instanceof DeepSeekSearchError)
  }

  // 9. 工具级错误要透出来（如 max_uses 用尽），而不是当成空结果
  {
    const data = { content: [{ type: 'web_search_tool_result', error: { type: 'max_uses_exceeded', message: '用量已尽' } }] }
    let err: any
    try { parseDeepSeekSearchResponse(data) } catch (e) { err = e }
    add('工具级 error → 抛错并带上原文', err instanceof DeepSeekSearchError && String(err.message).includes('用量已尽'), String(err?.message))
  }

  // 10. 脏数据不崩：缺字段 / 非数组 / 空 url
  {
    const dirty = {
      content: [
        { type: 'web_search_tool_result', content: [
          { type: 'web_search_result' },                              // 缺 url
          { type: 'web_search_result', url: '' },                      // 空 url
          { type: 'web_search_result', url: 'https://ok', title: null }, // title 为 null
          { type: 'unknown_block' },                                   // 非结果项
        ] },
      ],
    }
    const { items } = parseDeepSeekSearchResponse(dirty)
    add('脏数据：只保留有 url 的项', items.length === 1, `len=${items.length}`)
    add('脏数据：title 为 null 归一为空串', items[0]?.title === '')
    // content 不是数组 → 等于"没有可用项"，应当抛错（而不是静默返回空列表）
    let errDirty: any
    try { parseDeepSeekSearchResponse({ content: [{ type: 'web_search_tool_result', content: 'oops' }] }) } catch (e) { errDirty = e }
    add('脏数据：content 非数组 → 抛错而非返回空', errDirty instanceof DeepSeekSearchError, String(errDirty?.name))
  }

  // 11. 纯函数：同输入同输出（可重放）
  {
    const data = makeResponse([{ title: 'x', url: 'https://x' }], [{ url: 'https://x', text: 's' }])
    const a = JSON.stringify(parseDeepSeekSearchResponse(data))
    const b = JSON.stringify(parseDeepSeekSearchResponse(data))
    add('确定性：同输入同输出', a === b)
  }

  return cases
}

/** 打印自测结果并返回是否全通过 */
export function logDeepSeekSearchSelfTest(): boolean {
  const cases = runDeepSeekSearchSelfTest()
  const failed = cases.filter((c) => !c.ok)
  // eslint-disable-next-line no-console
  console.table(cases.map((c) => ({ 用例: c.name, 结果: c.ok ? '通过' : '失败', 备注: c.detail ?? '' })))
  // eslint-disable-next-line no-console
  console.log(`[deepseekSearch] ${cases.length - failed.length}/${cases.length} 通过`)
  return failed.length === 0
}

export type { DeepSeekSearchItem }
