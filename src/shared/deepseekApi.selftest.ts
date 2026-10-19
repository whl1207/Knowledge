/**
 * deepseekApi.selftest.ts — DeepSeek Search / Fetch 接口纯逻辑自测（**不联网**）
 *
 * 覆盖四块最容易悄悄坏掉的地方：
 *  1. **端点与请求体**：Search 是 `POST /v1/tools/search`、Fetch 是 `POST /v1/tools/fetch`；
 *     旧版配置里的 `/anthropic/v1` 必须被剥掉，否则升级后所有请求都打到不存在的路径。
 *  2. **响应解析**：`results: []` 是合法的“没有匹配结果”（不能抛错），缺 `results` 必须抛错
 *     （否则模型会以为“网上没有”）；短摘要 / 长摘要 / 正文的兜底顺序。
 *  3. **Fetch 空正文**：必须视为失败（交给下一抓取通道），不能返回空字符串当成功。
 *  4. **错误翻译**：402 / 403 / 404 / 429 等状态要给出“下一步该做什么”，并带出服务端 message。
 *
 * 用法（开发期）：
 *   import { runDeepSeekApiSelfTest } from '@/shared/deepseekApi.selftest'
 *   console.table(runDeepSeekApiSelfTest())
 * 或命令行：`node scripts/run-selftests.mjs deepseekApi`
 */

import {
  DEEPSEEK_API_DEFAULT_HOST,
  DEEPSEEK_FETCH_PATH,
  DEEPSEEK_SEARCH_MAX_COUNT,
  DEEPSEEK_SEARCH_PATH,
  DeepSeekApiError,
  buildDeepSeekFetchRequest,
  buildDeepSeekSearchBody,
  buildDeepSeekSearchRequest,
  deepseekApiErrorMessage,
  extractDeepSeekErrorDetail,
  normalizeDeepSeekApiHost,
  parseDeepSeekFetchResponse,
  parseDeepSeekSearchResponse,
  runDeepSeekFetchApi,
  runDeepSeekSearchApi,
} from './deepseekApi'

export interface DeepSeekApiCase {
  name: string
  ok: boolean
  detail?: string
}

export async function runDeepSeekApiSelfTest(): Promise<DeepSeekApiCase[]> {
  const cases: DeepSeekApiCase[] = []
  const add = (name: string, ok: boolean, detail = '') => cases.push({ name, ok, detail })
  const throws = (fn: () => unknown): boolean => {
    try {
      fn()
      return false
    } catch {
      return true
    }
  }

  // ---------- 1. base 归一化 / 端点 ----------
  {
    add('地址：留空用官方 base', normalizeDeepSeekApiHost('') === DEEPSEEK_API_DEFAULT_HOST, normalizeDeepSeekApiHost(''))
    add('地址：缺协议补 https', normalizeDeepSeekApiHost('api.deepseek.com') === 'https://api.deepseek.com')
    add('地址：去尾斜杠', normalizeDeepSeekApiHost('https://api.deepseek.com///') === 'https://api.deepseek.com')
    add('迁移：旧版 /anthropic/v1 被剥掉（不能用旧端点拼 Search 路径）',
      normalizeDeepSeekApiHost('https://api.deepseek.com/anthropic/v1') === 'https://api.deepseek.com',
      normalizeDeepSeekApiHost('https://api.deepseek.com/anthropic/v1'))
    add('地址：用户多填 /v1 不重复', normalizeDeepSeekApiHost('https://api.deepseek.com/v1') === 'https://api.deepseek.com')
    add('地址：粘贴完整端点也不重复拼路径',
      normalizeDeepSeekApiHost('https://api.deepseek.com/v1/tools/search') === 'https://api.deepseek.com' &&
      normalizeDeepSeekApiHost('https://api.deepseek.com/v1/tools/fetch/') === 'https://api.deepseek.com')
    add('地址：自定义代理路径保留', normalizeDeepSeekApiHost('https://gw.example.com/deepseek/v1') === 'https://gw.example.com/deepseek')
  }
  {
    const req = buildDeepSeekSearchRequest({ query: '  DeepSeek V4  ', maxResults: 5, apiKey: 'sk-test' })
    add('Search 请求：URL = base + /v1/tools/search', req.url === `${DEEPSEEK_API_DEFAULT_HOST}${DEEPSEEK_SEARCH_PATH}`, req.url)
    add('Search 请求：路径常量正确', DEEPSEEK_SEARCH_PATH === '/v1/tools/search')
    add('Search 请求：POST', req.method === 'POST')
    add('Search 请求：Bearer 鉴权', req.headers.Authorization === 'Bearer sk-test', String(req.headers.Authorization))
    add('Search 请求：Content-Type = application/json',
      String(req.headers['Content-Type'] || '').toLowerCase().includes('application/json'))
    let body: any = {}
    try { body = JSON.parse(req.body) } catch { /* 下面断言会失败 */ }
    add('Search 请求：query 去首尾空白', body.query === 'DeepSeek V4', String(body.query))
    add('Search 请求：count = maxResults', body.count === 5, String(body.count))
    add('Search 请求：默认不带 need_content', body.need_content === undefined, String(body.need_content))
    add('Search 请求：默认不带未提供的可选字段',
      body.ori_question === undefined && body.localization === undefined)
  }
  {
    const body = buildDeepSeekSearchBody({ query: 'x', maxResults: 999, needContent: true, oriQuestion: '原始问题', localization: '1.2.3.4' })
    add('Search 请求：count 收敛到官方上限 50', body.count === DEEPSEEK_SEARCH_MAX_COUNT, String(body.count))
    add('Search 请求：need_content 显式 false 时也不出现',
      buildDeepSeekSearchBody({ query: 'x', needContent: false }).need_content === undefined)
    add('Search 请求：need_content=true 才出现', body.need_content === true)
    add('Search 请求：ori_question / localization 透传',
      body.ori_question === '原始问题' && body.localization === '1.2.3.4')
    add('Search 请求：count 至少 1', buildDeepSeekSearchBody({ query: 'x', maxResults: 0 }).count === 1)
    add('Search 请求：条数非法时回默认 10', buildDeepSeekSearchBody({ query: 'x', maxResults: NaN }).count === 10)
  }
  {
    const req = buildDeepSeekFetchRequest({ url: ' https://example.com/a ', apiKey: 'sk-test' })
    add('Fetch 请求：URL = base + /v1/tools/fetch', req.url === `${DEEPSEEK_API_DEFAULT_HOST}${DEEPSEEK_FETCH_PATH}`, req.url)
    add('Fetch 请求：路径常量正确', DEEPSEEK_FETCH_PATH === '/v1/tools/fetch')
    let body: any = {}
    try { body = JSON.parse(req.body) } catch { /* 下面断言会失败 */ }
    add('Fetch 请求：body.url 去空白', body.url === 'https://example.com/a', String(body.url))
    add('Fetch 请求：只有 url 一个字段', Object.keys(body).length === 1, JSON.stringify(body))
    add('Fetch 请求：无 Key 时不带 Authorization',
      !Object.keys(buildDeepSeekFetchRequest({ url: 'https://x' }).headers).map((k) => k.toLowerCase()).includes('authorization'))
  }

  // ---------- 2. Search 响应解析 ----------
  {
    const items = parseDeepSeekSearchResponse({
      results: [
        {
          rerank_score: 2.4,
          title: 'DeepSeek V4 发布',
          url: 'https://example.com/a',
          snippet: '短摘要',
          summary: '长摘要',
          content: '',
          site_name: 'Example',
          date: '2026-06-01T00:00:00+00:00',
          authority: 3,
        },
        { title: '', url: 'https://example.com/b', summary: '只有长摘要' },
        { title: '重复', url: 'https://example.com/a', snippet: '重复链接应被去掉' },
        { title: '无链接', url: '' },
        { title: '非法链接', url: 'ftp://example.com/c' },
      ],
    }, 10)
    add('解析：合法结果保留两条（去重 / 去非法链接）', items.length === 2, String(items.length))
    add('解析：标题 / 链接正确', items[0].title === 'DeepSeek V4 发布' && items[0].url === 'https://example.com/a')
    add('解析：短摘要优先 snippet', items[0].snippet === '短摘要', items[0].snippet)
    add('解析：长摘要保留在 summary', items[0].summary === '长摘要', String(items[0].summary))
    add('解析：排序 / 权威性 / 站点 / 时间带出',
      items[0].rerankScore === 2.4 && items[0].authority === 3 && items[0].siteName === 'Example' && !!items[0].date)
    add('解析：缺标题用 URL 兜底', items[1].title === 'https://example.com/b', items[1].title)
    add('解析：缺 snippet 时用 summary 兜底', items[1].snippet === '只有长摘要', items[1].snippet)
  }
  {
    add('解析：results 为空数组是合法的“无匹配”（不抛错）',
      parseDeepSeekSearchResponse({ results: [] }).length === 0)
    add('解析：缺 results 数组必须抛错（不能当成 0 条）',
      throws(() => parseDeepSeekSearchResponse({ data: [] })))
    add('解析：响应不是对象必须抛错', throws(() => parseDeepSeekSearchResponse(null)))
    add('解析：按 maxResults 截断', parseDeepSeekSearchResponse({
      results: Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, url: `https://e.com/${i}`, snippet: 's' })),
    }, 3).length === 3)
    add('解析：只有正文时用正文开头兜底摘要', (() => {
      const [it] = parseDeepSeekSearchResponse({ results: [{ title: 't', url: 'https://e.com', content: '<p>正文内容</p>' }] })
      return it.snippet === '正文内容'
    })())
    add('解析：need_content 的正文保留在 content，并按 4000 字符截断', (() => {
      const [it] = parseDeepSeekSearchResponse({
        results: [{ title: 't', url: 'https://e.com/c', snippet: 's', content: 'x'.repeat(5000) }],
      })
      return it.content?.length === 4000
    })())
  }

  // ---------- 3. Fetch 响应解析 ----------
  {
    const page = parseDeepSeekFetchResponse({ title: '标题', content: '# 标题\n\n正文' })
    add('Fetch 解析：标题 / 正文正确', page.title === '标题' && page.content.includes('正文'))
    add('Fetch 解析：空正文视为失败（交给下一通道）', throws(() => parseDeepSeekFetchResponse({ title: 'x', content: '   ' })))
    add('Fetch 解析：缺 content 视为失败', throws(() => parseDeepSeekFetchResponse({ title: 'x' })))
    add('Fetch 解析：正文去首尾空白', parseDeepSeekFetchResponse({ content: '  hi  ' }).content === 'hi')
  }

  // ---------- 4. 错误翻译 ----------
  {
    add('错误：402 → 提示余额不足', deepseekApiErrorMessage(402).includes('余额不足'), deepseekApiErrorMessage(402))
    add('错误：401 → 提示 Key 无效', deepseekApiErrorMessage(401).includes('API Key'))
    add('错误：403 → 提示 Fetch 被安全策略拒绝', /安全策略/.test(deepseekApiErrorMessage(403)))
    add('错误：404 → 提示未获取到内容', deepseekApiErrorMessage(404).includes('未能获取'))
    add('错误：429 → 提示 QPS 并建议重试', /QPS/.test(deepseekApiErrorMessage(429)) && /重试/.test(deepseekApiErrorMessage(429)))
    add('错误：504 → 提示下游超时', deepseekApiErrorMessage(504).includes('超时'))
    add('错误：未知 5xx → 建议稍后重试', deepseekApiErrorMessage(502).includes('稍后重试'))
    add('错误：带出 OpenAI 兼容错误体里的 message',
      deepseekApiErrorMessage(400, JSON.stringify({ error: { message: "'count' must be between 1 and 50", type: 'invalid_request_error', param: null, code: 'invalid_request_error' } })).includes("'count' must be between 1 and 50"))
    add('错误：非 JSON 响应体也带出截断原文', extractDeepSeekErrorDetail('upstream error').includes('upstream error'))
    add('错误：空响应体不拼多余冒号', !deepseekApiErrorMessage(500, '').endsWith('：'))
    add('错误类型：带 code / status',
      (() => { const e = new DeepSeekApiError('x', { code: 'HTTP_401', status: 401 }); return e.code === 'HTTP_401' && e.status === 401 })())
  }

  // ---------- 5. 网络封装（桩掉全局 fetch，不联网） ----------
  {
    const realFetch = globalThis.fetch
    const calls: Array<{ url: string; init: any }> = []
    const stub = (status: number, payload: unknown) => {
      globalThis.fetch = (async (url: any, init: any) => {
        calls.push({ url: String(url), init })
        return new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      }) as any
    }
    try {
      stub(200, { results: [{ title: '结果', url: 'https://e.com/a', snippet: '摘要' }] })
      const items = await runDeepSeekSearchApi({ query: ' 天气 ', maxResults: 3, apiKey: ' sk-test ' })
      const call = calls[0]
      add('网络：搜索走官方端点（POST）',
        call?.url === 'https://api.deepseek.com/v1/tools/search' && call?.init?.method === 'POST', String(call?.url))
      add('网络：Authorization 用 Bearer（Key 去空白）',
        call?.init?.headers?.Authorization === 'Bearer sk-test', String(call?.init?.headers?.Authorization))
      const body = JSON.parse(String(call?.init?.body || '{}'))
      add('网络：请求体带 query / count', body.query === '天气' && body.count === 3, JSON.stringify(body))
      add('网络：成功响应被解析成结果列表', items.length === 1 && items[0].url === 'https://e.com/a')

      calls.length = 0
      stub(401, { error: { message: 'Authentication Fails', type: 'authentication_error', param: null, code: 'invalid_api_key' } })
      let err: any = null
      try { await runDeepSeekSearchApi({ query: 'q', apiKey: 'bad' }) } catch (e) { err = e }
      add('网络：401 抛 DeepSeekApiError 并带出服务端 message',
        err instanceof DeepSeekApiError && err.status === 401 && String(err.message).includes('Authentication Fails'),
        String(err?.message))

      calls.length = 0
      stub(200, { title: '页面标题', content: '# 正文' })
      const page = await runDeepSeekFetchApi({ url: 'https://e.com/p', apiKey: 'sk' })
      add('网络：抓取走官方 Fetch 端点',
        calls[0]?.url === 'https://api.deepseek.com/v1/tools/fetch', String(calls[0]?.url))
      add('网络：抓取响应解析出正文', page.title === '页面标题' && page.content === '# 正文')

      calls.length = 0
      stub(404, { error: { message: 'no available content' } })
      let fetchErr: any = null
      try { await runDeepSeekFetchApi({ url: 'https://e.com/p', apiKey: 'sk' }) } catch (e) { fetchErr = e }
      add('网络：404 抛错并提示没取到可用正文',
        fetchErr instanceof DeepSeekApiError && String(fetchErr.message).includes('未能获取'), String(fetchErr?.message))

      calls.length = 0
      globalThis.fetch = (async () => { throw new TypeError('Failed to fetch') }) as any
      let netErr: any = null
      try { await runDeepSeekFetchApi({ url: 'https://e.com/p', apiKey: 'sk' }) } catch (e) { netErr = e }
      add('网络：网络异常被包成可读错误（不抛裸 TypeError）',
        netErr instanceof DeepSeekApiError && netErr.code === 'NETWORK' && String(netErr.message).includes('Failed to fetch'),
        String(netErr?.message))
    } finally {
      globalThis.fetch = realFetch
    }
  }

  return cases
}

/** 命令行入口（node scripts/run-selftests.mjs deepseekApi 时走这个） */
export async function logDeepSeekApiSelfTest(): Promise<boolean> {
  const cases = await runDeepSeekApiSelfTest()
  const bad = cases.filter((c) => !c.ok)
  console.table(cases.map((c) => ({ case: c.name, ok: c.ok ? 'PASS' : 'FAIL', detail: c.detail || '' })))
  if (bad.length) console.error(`[deepseekApi] ${bad.length} 个断言失败`)
  return bad.length === 0
}
