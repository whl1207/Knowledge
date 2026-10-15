/**
 * webSearchFirecrawl.selftest.ts — Firecrawl 搜索源纯逻辑自测（不联网）
 *
 * 覆盖三块最容易悄悄坏掉的地方：
 *  1. **免 Key 模式绝不能带 Authorization**（带了就会被当成无效 Key 拒掉，免 Key 直接失效）；
 *  2. 响应解析的宽容与严格：`data.web` 取不到时给空数组、`success:false` 必须抛错
 *     （当成"0 条结果"会让模型误判成"网上没有"）、标题缺失用 URL 兜底而不是丢结果；
 *  3. 额度类错误（401/402/403/429）在免 Key 下要翻成"去哪申请 Key"，填了 Key 时不误报。
 *
 * 用法（开发期）：
 *   import { runWebSearchFirecrawlSelfTest } from '@/shared/webSearchFirecrawl.selftest'
 *   console.table(runWebSearchFirecrawlSelfTest())
 * 或命令行：`node scripts/run-selftests.mjs webSearchFirecrawl`
 */

import {
  FIRECRAWL_DEFAULT_HOST,
  FIRECRAWL_SERVER_TIMEOUT_MS,
  buildFirecrawlSearchRequest,
  firecrawlErrorMessage,
  parseFirecrawlSearchResponse,
} from './webSearchFirecrawl'

export interface FirecrawlCase {
  name: string
  ok: boolean
  detail?: string
}

/** 造一份 Firecrawl 成功响应 */
function okResponse(web: Array<Record<string, unknown>>) {
  return { success: true, data: { web }, creditsUsed: web.length * 2 }
}

export function runWebSearchFirecrawlSelfTest(): FirecrawlCase[] {
  const cases: FirecrawlCase[] = []
  const add = (name: string, ok: boolean, detail = '') => cases.push({ name, ok, detail })

  // ---------- 请求组装 ----------
  {
    const req = buildFirecrawlSearchRequest({ query: '杭州 天气', maxResults: 5 })
    add('请求：默认走官方地址的 v2/search', req.url === `${FIRECRAWL_DEFAULT_HOST}/v2/search`, req.url)
    add('请求：方法是 POST', req.method === 'POST')
    let body: any = {}
    try { body = JSON.parse(req.body) } catch { /* 下面断言会失败并暴露 */ }
    add('请求：查询词进 body.query', body.query === '杭州 天气', String(body.query))
    add('请求：条数进 body.limit', body.limit === 5, String(body.limit))
    add('请求：只搜网页（sources=["web"]）',
      Array.isArray(body.sources) && body.sources.length === 1 && body.sources[0] === 'web',
      JSON.stringify(body.sources))
    add('请求：带服务端超时（官方契约要求 1000~300000ms）',
      body.timeout === FIRECRAWL_SERVER_TIMEOUT_MS, String(body.timeout))
  }
  {
    // 最要紧的一条：免 Key 就不能有 Authorization
    const req = buildFirecrawlSearchRequest({ query: 'x', maxResults: 5, apiKey: '' })
    const keys = Object.keys(req.headers).map((k) => k.toLowerCase())
    add('免 Key：不带 Authorization 头（带了会被当成无效 Key）', !keys.includes('authorization'),
      JSON.stringify(req.headers))
    add('免 Key：仍带 Content-Type', keys.includes('content-type'))
    const blank = buildFirecrawlSearchRequest({ query: 'x', maxResults: 5, apiKey: '   ' })
    add('免 Key：纯空白 Key 也按留空处理（不发 Authorization）',
      !Object.keys(blank.headers).map((k) => k.toLowerCase()).includes('authorization'))
  }
  {
    const req = buildFirecrawlSearchRequest({ query: 'x', maxResults: 5, apiKey: 'fc-test' })
    add('带 Key：用 Bearer 发送（官方正好收这个头）',
      req.headers.Authorization === 'Bearer fc-test', String(req.headers.Authorization))
  }
  {
    const a = buildFirecrawlSearchRequest({ query: 'x', maxResults: 5, apiHost: 'https://api.firecrawl.dev/' })
    add('地址：去尾斜杠（不拼出 //v2/search）', a.url === 'https://api.firecrawl.dev/v2/search', a.url)
    const b = buildFirecrawlSearchRequest({ query: 'x', maxResults: 5, apiHost: 'api.firecrawl.dev' })
    add('地址：缺协议自动补 https', b.url === 'https://api.firecrawl.dev/v2/search', b.url)
    const c = buildFirecrawlSearchRequest({ query: 'x', maxResults: 5, apiHost: 'http://127.0.0.1:8080' })
    add('地址：显式 http 原样保留（支持自建网关 / 代理）',
      c.url === 'http://127.0.0.1:8080/v2/search', c.url)
  }
  {
    const hi = buildFirecrawlSearchRequest({ query: 'x', maxResults: 999 })
    const lo = buildFirecrawlSearchRequest({ query: 'x', maxResults: 0 })
    add('条数：上限收敛到 20', JSON.parse(hi.body).limit === 20, String(JSON.parse(hi.body).limit))
    add('条数：下限收敛到 1', JSON.parse(lo.body).limit === 1, String(JSON.parse(lo.body).limit))
  }

  // ---------- 响应解析 ----------
  {
    const items = parseFirecrawlSearchResponse(okResponse([
      { title: '甲', url: 'https://a.example/1', description: '摘要甲' },
      { title: '乙', url: 'https://b.example/2', description: '摘要乙' },
    ]), 10)
    add('解析：条数与字段映射正确', items.length === 2
      && items[0].title === '甲' && items[0].url === 'https://a.example/1' && items[0].snippet === '摘要甲',
      JSON.stringify(items[0]))
    add('解析：截断到 maxResults', parseFirecrawlSearchResponse(okResponse([
      { title: 'a', url: 'https://a.example' },
      { title: 'b', url: 'https://b.example' },
      { title: 'c', url: 'https://c.example' },
    ]), 2).length === 2)
  }
  {
    add('解析：结构不符（data.web 不是数组）→ 空数组',
      parseFirecrawlSearchResponse({ data: { web: null } }, 10).length === 0)
    add('解析：完全空响应 → 空数组', parseFirecrawlSearchResponse(undefined, 10).length === 0)
    add('解析：非 http(s) 链接被丢弃（javascript: / 空）',
      parseFirecrawlSearchResponse(okResponse([
        { title: '坏', url: 'javascript:alert(1)' },
        { title: '空', url: '' },
        { title: '好', url: 'https://good.example' },
      ]), 10).length === 1)
    const noTitle = parseFirecrawlSearchResponse(okResponse([
      { url: 'https://notitle.example/page', description: '有摘要无标题' },
    ]), 10)
    add('解析：标题缺失用 URL 兜底（不静默丢结果，白花额度）',
      noTitle.length === 1 && noTitle[0].title === 'https://notitle.example/page',
      JSON.stringify(noTitle[0]))
    add('解析：摘要缺失为空串（不是 undefined）',
      parseFirecrawlSearchResponse(okResponse([{ title: 't', url: 'https://t.example' }]), 10)[0].snippet === '')
  }
  {
    let threw = ''
    try {
      parseFirecrawlSearchResponse({ success: false, error: 'quota exceeded' }, 10)
    } catch (e: any) { threw = e?.message || String(e) }
    add('解析：success=false 必须抛错（不能当成"0 条结果"，否则模型以为网上没有）',
      threw.includes('quota exceeded'), threw || '(没抛错)')
  }

  // ---------- 错误翻译 ----------
  {
    const hint = firecrawlErrorMessage(new Error('HTTP 402 — Payment Required'), false)
    add('报错：免 Key 402 给出额度提示与申请入口',
      hint.includes('额度') && hint.includes('firecrawl.dev'), hint.slice(0, 46))
    add('报错：免 Key 429 同样给出额度提示',
      firecrawlErrorMessage(new Error('HTTP 429'), false).includes('额度'))
    add('报错：免 Key 401/403 同样给出额度提示',
      firecrawlErrorMessage(new Error('HTTP 401'), false).includes('额度')
      && firecrawlErrorMessage(new Error('HTTP 403'), false).includes('额度'))
    add('报错：已填 Key 时不误报"额度用尽"（那是用户自己的额度问题）',
      !firecrawlErrorMessage(new Error('HTTP 402'), true).includes('额度'))
    add('报错：普通错误原样透传（不硬塞额度提示）',
      firecrawlErrorMessage(new Error('请求超时'), false) === '请求超时')
    add('报错：无 message 的异常也能转成字符串（不抛二次异常）',
      firecrawlErrorMessage('boom', false) === 'boom')
  }

  return cases
}

/** 命令行入口（node scripts/run-selftests.mjs webSearchFirecrawl 时走这个） */
export function logWebSearchFirecrawlSelfTest(): boolean {
  const cases = runWebSearchFirecrawlSelfTest()
  const bad = cases.filter((c) => !c.ok)
  console.table(cases.map((c) => ({ case: c.name, ok: c.ok ? 'PASS' : 'FAIL', detail: c.detail || '' })))
  if (bad.length) console.error(`[webSearchFirecrawl] ${bad.length} 个断言失败`)
  return bad.length === 0
}
