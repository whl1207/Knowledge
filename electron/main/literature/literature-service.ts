// electron/main/literature/literature-service.ts
// 内置 MCP 服务：学术文献检索（builtin-literature）
// 聚合五个「免 Key」公开数据源：CrossRef、OpenAlex、arXiv、PubMed(NCBI E-utilities)、Europe PMC；
// 另提供按 DOI 的双源合并详情、OpenAlex 作者检索与撤稿信息查询。全部走官方 API/开放数据接口，不经过网页反爬验证。
//
// 与 office / drawio 同构：主进程内 SDK Server over InMemoryTransport；
// 打包主进程时不能静态内联 MCP SDK（zod v4 内联损坏），一律 @vite-ignore 运行时加载。

// ---------------- 运行时懒加载 MCP Server SDK ----------------
interface ServerSdkBundle {
  Server: any
  InMemoryTransport: any
  ListToolsRequestSchema: any
  CallToolRequestSchema: any
}
let serverSdkCache: ServerSdkBundle | null = null
async function getServerSdk(): Promise<ServerSdkBundle> {
  if (serverSdkCache) return serverSdkCache
  const [serverMod, inMemoryMod, typesMod] = await Promise.all([
    import(/* @vite-ignore */ '@modelcontextprotocol/sdk/server/index.js'),
    import(/* @vite-ignore */ '@modelcontextprotocol/sdk/inMemory.js'),
    import(/* @vite-ignore */ '@modelcontextprotocol/sdk/types.js'),
  ])
  serverSdkCache = {
    Server: (serverMod as any).Server ?? (serverMod as any).McpServer,
    InMemoryTransport: (inMemoryMod as any).InMemoryTransport,
    ListToolsRequestSchema: (typesMod as any).ListToolsRequestSchema,
    CallToolRequestSchema: (typesMod as any).CallToolRequestSchema,
  }
  return serverSdkCache
}

// ---------------- 常量与基础工具 ----------------
export const LITERATURE_MCP_ID = 'builtin-literature'

const HTTP_TIMEOUT = 15000 // 单请求超时（毫秒）；多源工具已并发化，最坏等待 ≈ 单请求
const MAX_OUTPUT = 9000 // 单次工具返回文本上限（超出截断）
const UA = 'AI-KM-Literature-MCP/0.2 (open-data client; CrossRef/OpenAlex/arXiv/PubMed/Europe PMC)'

function str(v: any): string {
  const s = typeof v === 'string' ? v : v == null ? '' : String(v)
  return s.replace(/\s+/g, ' ').trim()
}
function clampInt(v: any, def: number, min: number, max: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.round(n)))
}
function intOrNull(v: any): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}
/** 判断输入是否形如 DOI（支持 10.xxxx/...、doi: 前缀与 doi.org 链接） */
function looksLikeDoi(q: string): boolean {
  return /^(?:doi:\s*)?(?:https?:\/\/(?:dx\.)?doi\.org\/)?10\.\d{4,9}\/\S+$/i.test(String(q || '').trim())
}
function truncate(text: string, max: number): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}
function fmtAuthors(authors: string[], max = 6): string {
  const list = authors.map((a) => str(a)).filter(Boolean)
  if (!list.length) return '（无作者信息）'
  return list.length > max ? `${list.slice(0, max).join('; ')} 等 ${list.length} 人` : list.join('; ')
}

/** 解码 XML 实体（arXiv Atom 返回） */
function decodeXmlEntities(s: string): string {
  return String(s || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 去掉 JATS/HTML 标签（CrossRef 摘要常带 <jats:p> 等） */
function stripTags(s: string): string {
  return String(s || '').replace(/<[^>]+>/g, ' ')
}

/** PMC 编号 → 纯数字（NCBI efetch 需要） */
function cleanPmcid(v: string): string {
  return str(v).replace(/^PMC/i, '').trim()
}

/** JATS XML（PMC 全文）→ 纯文本：只取标题、摘要与正文，去参考文献与出版元数据（PMID/DOI/卷期等噪声） */
function jatsToText(xml: string): string {
  const src = String(xml || '')
  const pick = (re: RegExp): string => {
    const m = src.match(re)
    return m ? m[1] : ''
  }
  let s = [
    pick(/<article-title[^>]*>([\s\S]*?)<\/article-title>/i),
    pick(/<abstract[^>]*>([\s\S]*?)<\/abstract>/i),
    pick(/<body[^>]*>([\s\S]*?)<\/body>/i),
  ]
    .filter(Boolean)
    .join('\n')
  if (!s) s = src
  s = s.replace(/<ref-list[\s\S]*?<\/ref-list>/gi, ' ')
  s = s.replace(/<back[\s\S]*?<\/back>/gi, ' ')
  s = s.replace(/<\/title>/gi, '\n')
  s = s.replace(/<\/(p|sec|abstract|disp-quote|list-item|caption|table-wrap)>/gi, '\n')
  s = s.replace(/<\/(td|th)>/gi, ' | ')
  s = s.replace(/<\/tr>/gi, '\n')
  s = s.replace(/<(br|\/list)\s*\/?>/gi, '\n')
  s = s.replace(/<[^>]+>/g, '')
  s = decodeXmlEntities(s)
  s = s.replace(/[ \t\u00a0]+/g, ' ')
  s = s.replace(/ ?\n ?/g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(HTTP_TIMEOUT),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
  return await res.json()
}
async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/atom+xml,application/xml,text/xml,*/*' },
    signal: AbortSignal.timeout(HTTP_TIMEOUT),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
  return await res.text()
}

// ---------------- 数据源 1：CrossRef ----------------
async function searchCrossref(args: any): Promise<string> {
  const query = str(args?.query ?? args?.q)
  if (!query) throw new Error('缺少参数 query（标题 / 关键词 / DOI）')
  // DOI 快通道：query 看起来是 DOI 时直接走精确查询
  if (looksLikeDoi(query)) return '（检测到 DOI，已自动转为 DOI 精确查询）\n\n' + (await getByDoi({ doi: query }))
  const rows = clampInt(args?.rows, 5, 1, 20)
  const params = new URLSearchParams()
  const field = str(args?.search_field)
  if (field === 'title') params.set('query.title', query)
  else if (field === 'author') params.set('query.author', query)
  else params.set('query.bibliographic', query)
  params.set('rows', String(rows))
  params.set('select', 'DOI,title,author,issued,container-title,type,is-referenced-by-count,abstract,update-to')
  const filters: string[] = []
  const yf = intOrNull(args?.year_from)
  const yt = intOrNull(args?.year_to)
  if (yf) filters.push(`from-pub-date:${yf}-01-01`)
  if (yt) filters.push(`until-pub-date:${yt}-12-31`)
  const type = str(args?.type)
  if (type) filters.push(`type:${type}`)
  const updateType = str(args?.update_type)
  if (updateType) filters.push(`update-type:${updateType}`)
  if (filters.length) params.set('filter', filters.join(','))
  const sort = str(args?.sort)
  if (sort === 'cited') {
    params.set('sort', 'is-referenced-by-count')
    params.set('order', 'desc')
  } else if (sort === 'newest') {
    params.set('sort', 'issued')
    params.set('order', 'desc')
  }
  const email = str(args?.email)
  if (email) params.set('mailto', email)

  const data = await fetchJson(`https://api.crossref.org/works?${params.toString()}`)
  const items: any[] = data?.message?.items || []
  if (!items.length) return `CrossRef 未找到匹配「${query}」的结果（可调整关键词 / 年份 / 类型后重试）`
  const total = data?.message?.['total-results'] ?? '?'
  const lines: string[] = [`【CrossRef】检索「${query}」— 共 ${total} 条匹配，显示 ${items.length} 条`, '']
  items.forEach((it, i) => {
    const title = truncate(Array.isArray(it.title) ? it.title[0] || '' : it.title || '', 300) || '（无标题）'
    const authors = fmtAuthors((it.author || []).map((a: any) => a.name || [a.given, a.family].filter(Boolean).join(' ')))
    const year = it.issued?.['date-parts']?.[0]?.[0] ?? ''
    const venue = truncate(it['container-title']?.[0] || '', 120)
    const doi = str(it.DOI)
    lines.push(`${i + 1}) ${title}`)
    lines.push(`   作者：${authors} ｜ ${year || '年份未知'} ｜ ${venue || '（无来源刊名）'}`)
    lines.push(`   引用 ${it['is-referenced-by-count'] ?? 0} ｜ 类型：${it.type || '?'} ｜ DOI: ${doi || '（无）'}`)
    if (doi) lines.push(`   https://doi.org/${doi}`)
    const updates = Array.isArray(it['update-to']) ? it['update-to'] : []
    for (const u of updates.slice(0, 3)) {
      const target = str(u?.DOI)
      if (!target) continue
      const src = str(u?.source)
      const recId = str(u?.['record-id'])
      const date = str(u?.updated?.['date-time']).slice(0, 10)
      lines.push(`   更新关系：${u?.label || u?.type || 'update'} → https://doi.org/${target}${src ? `（${src}${recId ? ` #${recId}` : ''}${date ? `，${date}` : ''}）` : ''}`)
    }
    const abs = truncate(stripTags(it.abstract || ''), 360)
    if (abs) lines.push(`   摘要：${abs}`)
    lines.push('')
  })
  return lines.join('\n')
}

// ---------------- 数据源 2：OpenAlex ----------------
function rebuildAbstract(inv: any): string {
  if (!inv || typeof inv !== 'object') return ''
  const words: string[] = []
  for (const [w, ps] of Object.entries(inv)) {
    for (const p of (Array.isArray(ps) ? ps : []) as number[]) words[p] = w
  }
  return words.filter(Boolean).join(' ')
}

const OPENALEX_SELECT =
  'id,doi,title,display_name,publication_year,publication_date,authorships,primary_location,best_oa_location,cited_by_count,type,abstract_inverted_index,open_access,is_retracted'

function fmtOpenAlexItem(it: any, index: number): string[] {
  const title = truncate(it.title || it.display_name || '', 300) || '（无标题）'
  const authors = fmtAuthors((it.authorships || []).map((a: any) => a?.author?.display_name))
  const year = it.publication_year || ''
  const venue = truncate(it.primary_location?.source?.display_name || '', 120)
  const doi = str(it.doi || '').replace(/^https?:\/\/doi\.org\//i, '')
  const oa = it.best_oa_location || it.primary_location || {}
  const oaUrl = str(oa.pdf_url || oa.landing_page_url || '')
  const lines: string[] = []
  lines.push(`${index}) ${title}`)
  lines.push(`   作者：${authors} ｜ ${year || '年份未知'} ｜ ${venue || '（无来源刊名）'}`)
  lines.push(`   被引 ${it.cited_by_count ?? 0} ｜ 类型：${it.type || '?'} ｜ DOI: ${doi || '（无）'}`)
  if (it.is_retracted) lines.push('   ⚠ 已被撤稿（OpenAlex is_retracted=true）')
  const isOa = !!it.open_access?.is_oa
  const oaStatus = str(it.open_access?.oa_status)
  if (oaUrl && isOa) {
    lines.push(`   开放获取${oa.pdf_url ? ' PDF' : '页面'}${oaStatus ? `（${oaStatus}）` : ''}：${oaUrl}`)
  }
  const abs = truncate(rebuildAbstract(it.abstract_inverted_index), 360)
  if (abs) lines.push(`   摘要：${abs}`)
  lines.push('')
  return lines
}

async function searchOpenAlex(args: any): Promise<string> {
  const query = str(args?.query ?? args?.q)
  const authorId = str(args?.author_id)
  if (!query && !authorId && !args?.retracted_only) {
    throw new Error('缺少参数 query（或用 author_id / retracted_only 过滤后可省略）')
  }
  // DOI 快通道
  if (query && looksLikeDoi(query)) return '（检测到 DOI，已自动转为 DOI 精确查询）\n\n' + (await getByDoi({ doi: query }))
  const perPage = clampInt(args?.per_page ?? args?.rows, 5, 1, 20)
  const params = new URLSearchParams()
  if (query) params.set('search', query)
  params.set('per-page', String(perPage))
  params.set('select', OPENALEX_SELECT)
  const filters: string[] = []
  const yf = intOrNull(args?.year_from)
  const yt = intOrNull(args?.year_to)
  if (yf) filters.push(`from_publication_date:${yf}-01-01`)
  if (yt) filters.push(`to_publication_date:${yt}-12-31`)
  if (args?.oa_only) filters.push('is_oa:true')
  if (args?.retracted_only) filters.push('is_retracted:true')
  if (authorId) filters.push(`author.id:${authorId.replace(/^https?:\/\/openalex\.org\//i, '')}`)
  if (filters.length) params.set('filter', filters.join(','))
  const sort = str(args?.sort)
  if (sort === 'cited') params.set('sort', 'cited_by_count:desc')
  else if (sort === 'newest') params.set('sort', 'publication_date:desc')
  const email = str(args?.email)
  if (email) params.set('mailto', email)

  const data = await fetchJson(`https://api.openalex.org/works?${params.toString()}`)
  const items: any[] = data?.results || []
  if (!items.length) return `OpenAlex 未找到匹配「${query}」的结果（可调整关键词 / 年份 / 是否仅 OA 后重试）`
  const lines: string[] = [`【OpenAlex】检索「${query || '（按过滤条件）'}」— 共 ${data?.meta?.count ?? '?'} 条匹配，显示 ${items.length} 条`, '']
  items.forEach((it, i) => lines.push(...fmtOpenAlexItem(it, i + 1)))
  return lines.join('\n')
}

// ---------------- 数据源 3：arXiv ----------------
function arxivTag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))
  return m ? decodeXmlEntities(m[1]).replace(/\s+/g, ' ').trim() : ''
}

async function searchArxiv(args: any): Promise<string> {
  const query = str(args?.query ?? args?.q)
  if (!query) throw new Error('缺少参数 query（关键词；支持 ti: / au: / cat: / all: 语法）')
  const maxResults = clampInt(args?.max_results, 5, 1, 20)
  // 多词默认展开为显式 AND（arXiv 松散匹配会返回上百万条噪声）；自带字段语法（含冒号）时按原样使用
  const searchQuery = query.includes(':')
    ? query
    : query
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => `all:${w}`)
        .join(' AND ')
  const sort = str(args?.sort)
  const params = new URLSearchParams()
  params.set('search_query', searchQuery)
  params.set('start', '0')
  params.set('max_results', String(maxResults))
  params.set('sortBy', sort === 'newest' ? 'submittedDate' : 'relevance')
  params.set('sortOrder', 'descending')

  const xml = await fetchText(`https://export.arxiv.org/api/query?${params.toString()}`)
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1])
  if (!entries.length) return `arXiv 未找到匹配「${query}」的预印本（可调整关键词或字段语法）`
  const total = xml.match(/<opensearch:totalResults[^>]*>(\d+)</)?.[1] ?? '?'
  const lines: string[] = [`【arXiv】检索「${searchQuery}」— 共 ${total} 条匹配，显示 ${entries.length} 条`, '']
  entries.forEach((block, i) => {
    const title = arxivTag(block, 'title') || '（无标题）'
    const summary = arxivTag(block, 'summary')
    const published = arxivTag(block, 'published').slice(0, 10)
    const updated = arxivTag(block, 'updated').slice(0, 10)
    const authors = [...block.matchAll(/<author>\s*<name>([^<]+)<\/name>/g)].map((m) => decodeXmlEntities(m[1]))
    const idRaw = arxivTag(block, 'id') // http://arxiv.org/abs/2401.12345v1
    const shortId = idRaw.replace(/^https?:\/\/arxiv\.org\/abs\//, '')
    const absUrl = shortId ? `https://arxiv.org/abs/${shortId}` : idRaw
    const pdfHref =
      block.match(/<link[^>]*title="pdf"[^>]*href="([^"]+)"/)?.[1] ||
      block.match(/<link[^>]*href="([^"]+)"[^>]*title="pdf"/)?.[1] ||
      ''
    const categories = [...new Set([...block.matchAll(/<category\s+term="([^"]+)"/g)].map((m) => m[1]))]
    const doi = arxivTag(block, 'arxiv:doi')
    lines.push(`${i + 1}) ${truncate(title, 300)}`)
    lines.push(`   作者：${fmtAuthors(authors)} ｜ 提交 ${published || '?'}${updated && updated !== published ? `（更新 ${updated}）` : ''}`)
    lines.push(`   arXiv: ${shortId || '?'} ｜ 分类：${categories.join(', ') || '?'}${doi ? ` ｜ DOI: ${doi}` : ''}`)
    if (absUrl) lines.push(`   ${absUrl}${pdfHref ? ` ｜ PDF: ${pdfHref}` : ''}`)
    const abs = truncate(summary, 360)
    if (abs) lines.push(`   摘要：${abs}`)
    lines.push('')
  })
  return lines.join('\n')
}

// ---------------- 数据源 4：PubMed（NCBI E-utilities） ----------------
async function searchPubmed(args: any): Promise<string> {
  const query = str(args?.query ?? args?.q)
  if (!query) throw new Error('缺少参数 query（关键词 / 主题词 / 作者）')
  const maxResults = clampInt(args?.max_results, 5, 1, 20)
  const yf = intOrNull(args?.year_from)
  const yt = intOrNull(args?.year_to)
  const term = query + (yf || yt ? ` AND (${yf || 1800}:${yt || 3000}[dp])` : '')
  const email = str(args?.email)

  const esParams = new URLSearchParams()
  esParams.set('db', 'pubmed')
  esParams.set('retmode', 'json')
  esParams.set('retmax', String(maxResults))
  esParams.set('sort', 'relevance')
  esParams.set('term', term)
  if (email) esParams.set('email', email)
  const es = await fetchJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${esParams.toString()}`)
  const uids: string[] = es?.esearchresult?.idlist || []
  if (!uids.length) return `PubMed 未找到匹配「${term}」的文献（可调整关键词 / 年份后重试）`

  const sumParams = new URLSearchParams()
  sumParams.set('db', 'pubmed')
  sumParams.set('retmode', 'json')
  sumParams.set('id', uids.join(','))
  const sum = await fetchJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${sumParams.toString()}`)
  const total = es?.esearchresult?.count ?? '?'
  const lines: string[] = [`【PubMed】检索「${term}」— 共 ${total} 条匹配，显示 ${uids.length} 条`, '']
  uids.forEach((uid, i) => {
    const it = sum?.result?.[uid] || {}
    const title = truncate(it.title || '', 300) || '（无标题）'
    const authors = fmtAuthors((it.authors || []).map((a: any) => a?.name))
    const journal = truncate(it.fulljournalname || it.source || '', 120)
    const doi =
      (it.articleids || []).find((a: any) => a?.idtype === 'doi')?.value ||
      str(it.elocationid || '').replace(/^doi:\s*/i, '')
    lines.push(`${i + 1}) ${title}`)
    lines.push(`   作者：${authors} ｜ ${it.pubdate || it.epubdate || '日期未知'} ｜ ${journal || '（无期刊名）'}`)
    lines.push(`   PMID: ${uid}${doi ? ` ｜ DOI: ${doi}` : ''}`)
    lines.push(`   https://pubmed.ncbi.nlm.nih.gov/${uid}/`)
    lines.push('')
  })
  return lines.join('\n')
}

// ---------------- 按 DOI 取详情（OpenAlex + CrossRef 双源合并） ----------------
function doiPath(doi: string): string {
  // 保留 '/'，逐段编码（CrossRef / OpenAlex 的路径形式都接受）
  return doi.split('/').map((seg) => encodeURIComponent(seg)).join('/')
}

async function getByDoi(args: any): Promise<string> {
  const raw = str(args?.doi ?? args?.DOI)
  if (!raw) throw new Error('缺少参数 doi（如 10.1016/j.jclepro.2024.141234）')
  const doi = raw.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim()

  const lines: string[] = [`【DOI 详情】${doi}`, '']
  // 两源并发启动；OpenAlex 成功则不必等 CrossRef 完成（慢网络下显著缩短等待）
  const oaPromise = fetchJson(`https://api.openalex.org/works/doi:${doiPath(doi)}?select=${OPENALEX_SELECT}`).catch(() => null)
  const crPromise = fetchJson(`https://api.crossref.org/works/${doiPath(doi)}`)
    .then((r) => r?.message || null)
    .catch(() => null)
  const oa: any = await oaPromise
  const cr: any = oa?.id ? null : await crPromise

  if (!oa?.id && !cr) throw new Error(`两个数据源都查不到该 DOI：${doi}（请检查 DOI 是否正确）`)

  if (oa?.id) {
    const title = truncate(oa.title || oa.display_name || '', 400)
    const authors = fmtAuthors((oa.authorships || []).map((a: any) => a?.author?.display_name), 10)
    const venue = truncate(oa.primary_location?.source?.display_name || '', 160)
    const publisher = truncate(oa.primary_location?.source?.host_organization_name || '', 120)
    lines.push(`标题：${title || '（无标题）'}`)
    lines.push(`作者：${authors}`)
    lines.push(`年份：${oa.publication_year || '?'} ｜ 来源：${venue || '（无）'}${publisher ? `（${publisher}）` : ''}`)
    lines.push(`被引：${oa.cited_by_count ?? 0} ｜ 类型：${oa.type || '?'} ｜ DOI: ${str(oa.doi || '').replace(/^https?:\/\/doi\.org\//i, '')}`)
    const oaInfo = oa.best_oa_location || oa.primary_location || {}
    const oaUrl = str(oaInfo.pdf_url || oaInfo.landing_page_url || '')
    const isOa = !!oa.open_access?.is_oa
    const oaStatus = str(oa.open_access?.oa_status)
    if (oaUrl && isOa) {
      lines.push(`开放获取${oaInfo.pdf_url ? ' PDF' : '页面'}${oaStatus ? `（${oaStatus}）` : ''}：${oaUrl}`)
    } else if (oaUrl && !/^https?:\/\/doi\.org\//i.test(oaUrl)) {
      lines.push(`来源页面：${oaUrl}`)
    }
    const abs = truncate(rebuildAbstract(oa.abstract_inverted_index), 700)
    if (abs) lines.push(`摘要：${abs}`)
  } else if (cr) {
    const title = truncate(Array.isArray(cr.title) ? cr.title[0] || '' : cr.title || '', 400)
    const authors = fmtAuthors((cr.author || []).map((a: any) => a.name || [a.given, a.family].filter(Boolean).join(' ')), 10)
    const year = cr.issued?.['date-parts']?.[0]?.[0] ?? ''
    lines.push(`标题：${title || '（无标题）'}`)
    lines.push(`作者：${authors}`)
    lines.push(`年份：${year || '?'} ｜ 来源：${truncate(cr['container-title']?.[0] || '', 160) || '（无）'}`)
    lines.push(`被引：${cr['is-referenced-by-count'] ?? 0} ｜ 类型：${cr.type || '?'} ｜ 出版方：${truncate(cr.publisher || '', 120) || '（无）'}`)
    const abs = truncate(stripTags(cr.abstract || ''), 700)
    if (abs) lines.push(`摘要：${abs}`)
  }
  lines.push('')
  lines.push(`来源：${oa?.id ? 'OpenAlex' : ''}${oa?.id && cr ? ' + ' : ''}${cr ? 'CrossRef' : ''}`)
  return lines.join('\n')
}

// ---------------- 作者检索（OpenAlex） ----------------
async function searchAuthors(args: any): Promise<string> {
  const query = str(args?.query ?? args?.q)
  if (!query) throw new Error('缺少参数 query（作者姓名）')
  const perPage = clampInt(args?.per_page ?? args?.rows, 5, 1, 20)
  const params = new URLSearchParams()
  params.set('search', query)
  params.set('per-page', String(perPage))
  params.set('select', 'id,display_name,orcid,works_count,cited_by_count,summary_stats,last_known_institutions')
  const email = str(args?.email)
  if (email) params.set('mailto', email)

  const data = await fetchJson(`https://api.openalex.org/authors?${params.toString()}`)
  const items: any[] = data?.results || []
  if (!items.length) return `OpenAlex 未找到匹配「${query}」的作者（可换英文全名再试）`
  const lines: string[] = [`【OpenAlex 作者】检索「${query}」— 共 ${data?.meta?.count ?? '?'} 位，显示 ${items.length} 位`, '']
  items.forEach((a, i) => {
    const shortId = str(a.id || '').replace(/^https?:\/\/openalex\.org\//i, '')
    const orcid = str(a.orcid || '').replace(/^https?:\/\/orcid\.org\//i, '')
    const hIndex = a.summary_stats?.h_index
    const insts = (a.last_known_institutions || []).slice(0, 2).map((x: any) => str(x?.display_name)).filter(Boolean)
    lines.push(`${i + 1}) ${str(a.display_name) || '（无名）'}`)
    lines.push(`   OpenAlex: ${shortId || '?'}${orcid ? ` ｜ ORCID: ${orcid}` : ''} ｜ 论文 ${a.works_count ?? '?'} 篇 ｜ 被引 ${a.cited_by_count ?? '?'} ｜ h-index ${hIndex ?? '?'}`)
    if (insts.length) lines.push(`   机构：${insts.join('；')}`)
    if (shortId) lines.push(`   （查其论文：search_openalex 传 author_id="${shortId}"）`)
    lines.push('')
  })
  return lines.join('\n')
}

// ---------------- 撤稿信息（OpenAlex 标记 + CrossRef 更新关系） ----------------
function fmtUpdateRel(u: any): string {
  const target = str(u?.DOI)
  const label = str(u?.label) || str(u?.type) || 'update'
  const src = str(u?.source)
  const recId = str(u?.['record-id'])
  const date = str(u?.updated?.['date-time']).slice(0, 10)
  const extra = src ? `（${src}${recId ? ` #${recId}` : ''}${date ? `，${date}` : ''}）` : ''
  return `${label} → https://doi.org/${target}${extra}`
}

async function getRetractionInfo(args: any): Promise<string> {
  const raw = str(args?.doi ?? args?.DOI)
  if (!raw) throw new Error('缺少参数 doi')
  const doi = raw.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim()
  const lines: string[] = [`【撤稿信息】${doi}`, '']

  // 三源并发查询（最坏等待 ≈ 单请求超时，避免顺序叠加；CrossRef 仅在 4xx 时回退全量记录）
  const fetchCrossref = async (): Promise<any> => {
    try {
      return (
        await fetchJson(
          `https://api.crossref.org/works/${doiPath(doi)}?select=DOI,title,type,publisher,update-to,updated-by`
        )
      )?.message || null
    } catch (e: any) {
      if (/HTTP 4\d\d/.test(String(e?.message || ''))) {
        try {
          return (await fetchJson(`https://api.crossref.org/works/${doiPath(doi)}`))?.message || null
        } catch { return null }
      }
      return null
    }
  }
  const [oaRes, crRes, epRes] = await Promise.all([
    fetchJson(
      `https://api.openalex.org/works/doi:${doiPath(doi)}?select=id,title,is_retracted,publication_year,cited_by_count`
    ).catch(() => null),
    fetchCrossref(),
    fetchJson(
      `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(`DOI:"${doi}"`)}&resultType=core&format=json&pageSize=1`
    ).catch(() => null),
  ])
  const oaFlag: boolean | null = oaRes?.id ? !!oaRes.is_retracted : null
  const oaTitle = oaRes?.id ? str(oaRes.title || '') : ''
  const msg: any = crRes
  const epRec = epRes?.resultList?.result?.[0]
  const epRels: any[] = epRec?.commentCorrectionList?.commentCorrection || []
  const epTitle = str(epRec?.title || '')

  if (oaFlag === null && !msg && !epRels.length && !epTitle) {
    throw new Error(`三个数据源都查不到该 DOI：${doi}（请检查 DOI 是否正确）`)
  }

  const crTitle = Array.isArray(msg?.title) ? msg.title[0] : msg?.title
  lines.push(`标题：${oaTitle || epTitle || truncate(str(crTitle || ''), 320) || '（未知）'}`)
  if (oaFlag !== null) lines.push(`OpenAlex 撤稿标记：${oaFlag ? '⚠ 是（is_retracted=true）' : '否（未标记撤稿）'}`)

  const updTo: any[] = Array.isArray(msg?.['update-to']) ? msg['update-to'] : []
  const updBy: any[] = Array.isArray(msg?.['updated-by']) ? msg['updated-by'] : []
  if (updTo.length) {
    lines.push('', 'CrossRef update-to（它是撤稿通知 / 更正声明时指向原文）：')
    for (const u of updTo.slice(0, 6)) lines.push(`  · ${fmtUpdateRel(u)}`)
  }
  if (updBy.length) {
    lines.push('', 'CrossRef updated-by（它被撤稿 / 更正，通知如下）：')
    for (const u of updBy.slice(0, 6)) lines.push(`  · ${fmtUpdateRel(u)}`)
  }
  if (epRels.length) {
    lines.push('', 'Europe PMC 撤稿 / 更正关系：')
    for (const r of epRels.slice(0, 6)) {
      const ref = str(r?.reference)
      const doiM = ref.match(/doi:\s*(10\.[^\s;]+)/i)
      lines.push(`  · ${str(r?.type) || '?'}${doiM ? ` → https://doi.org/${doiM[1]}` : ''}${ref ? `（${truncate(ref, 150)}）` : ''}`)
    }
  }
  if (!updTo.length && !updBy.length && !epRels.length) {
    lines.push('', '三个数据源均未登记更新关系（可能该文献未被撤稿，或通知尚未收录）。')
  }
  if (oaFlag && !updBy.length && !epRels.length) {
    lines.push('', '提示：OpenAlex 标记其为撤稿；可用 search_crossref（update_type=retraction）或 search_europepmc（retracted_only）检索对应撤稿通知。')
  }
  return lines.join('\n')
}

// ---------------- 数据源 5：Europe PMC（检索 + 撤稿关系；全文经 NCBI PMC efetch） ----------------
function fmtEpmcItem(it: any, index: number): string[] {
  const title = truncate(str(it?.title || ''), 300) || '（无标题）'
  const authors = fmtAuthors(str(it?.authorString || '').split(',').map((x) => x.trim()).filter(Boolean))
  const journal = truncate(str(it?.journalInfo?.journal?.title || ''), 120)
  const year = str(it?.pubYear || '')
  const doi = str(it?.doi || '')
  const pmid = str(it?.pmid || '')
  const pmcid = str(it?.pmcid || '')
  const lines: string[] = []
  lines.push(`${index}) ${title}`)
  lines.push(`   作者：${authors} ｜ ${year || '年份未知'} ｜ ${journal || '（无期刊名）'}`)
  lines.push(`   被引 ${it?.citedByCount ?? 0} ｜ DOI: ${doi || '（无）'}${pmid ? ` ｜ PMID: ${pmid}` : ''}${pmcid ? ` ｜ ${pmcid}` : ''}`)
  const urls: any[] = it?.fullTextUrlList?.fullTextUrl || []
  const oaUrls = urls.filter((u) => str(u?.availabilityCode).toUpperCase() === 'OA')
  const pick = oaUrls.find((u) => /pdf/i.test(str(u?.documentStyle))) || oaUrls[0]
  if (pick?.url) lines.push(`   开放获取全文：${str(pick.url)}`)
  const rels: any[] = it?.commentCorrectionList?.commentCorrection || []
  for (const r of rels.slice(0, 2)) {
    const ref = str(r?.reference)
    const doiM = ref.match(/doi:\s*(10\.[^\s;]+)/i)
    lines.push(`   撤稿关系：${str(r?.type) || '?'}${doiM ? ` → https://doi.org/${doiM[1]}` : ''}`)
  }
  const abs = truncate(str(it?.abstractText || ''), 320)
  if (abs) lines.push(`   摘要：${abs}`)
  lines.push('')
  return lines
}

async function searchEuropepmc(args: any): Promise<string> {
  const rawQuery = str(args?.query ?? args?.q)
  const retractedOnly = !!args?.retracted_only
  if (!rawQuery && !retractedOnly) throw new Error('缺少参数 query；或提供 retracted_only 过滤')
  let query = rawQuery
  if (query && looksLikeDoi(query)) {
    query = `DOI:"${query.replace(/^doi:\s*/i, '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')}"`
  }
  const yf = intOrNull(args?.year_from)
  const yt = intOrNull(args?.year_to)
  if (yf || yt) query += ` AND PUB_YEAR:[${yf ?? 1800} TO ${yt ?? 3000}]`
  if (args?.oa_only) query += ' AND OPEN_ACCESS:Y'
  if (retractedOnly) query += ' AND PUB_TYPE:"retracted publication"'
  const pageSize = clampInt(args?.max_results ?? args?.rows, 5, 1, 20)
  const params = new URLSearchParams()
  params.set('query', query)
  params.set('resultType', 'core')
  params.set('format', 'json')
  params.set('pageSize', String(pageSize))
  const sort = str(args?.sort)
  if (sort === 'cited') params.set('sort', 'CITED desc')
  else if (sort === 'newest') params.set('sort', 'P_PDATE_D desc')

  const data = await fetchJson(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params.toString()}`)
  const items: any[] = data?.resultList?.result || []
  if (!items.length) return `Europe PMC 未找到匹配「${query}」的记录（可调整关键词 / 过滤后重试）`
  const lines: string[] = [`【Europe PMC】检索「${query}」— 共 ${data?.hitCount ?? '?'} 条，显示 ${items.length} 条`, '']
  items.forEach((it, i) => lines.push(...fmtEpmcItem(it, i + 1)))
  return lines.join('\n')
}

async function getFulltext(args: any): Promise<string> {
  const doiIn = str(args?.doi ?? args?.DOI)
  const pmidIn = str(args?.pmid)
  const pmcidIn = str(args?.pmcid)
  if (!doiIn && !pmidIn && !pmcidIn) throw new Error('请提供 doi / pmid / pmcid 之一')
  const doi = doiIn.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim()
  const query = pmcidIn ? `PMCID:${pmcidIn}` : pmidIn ? `EXT_ID:${pmidIn} AND SRC:MED` : `DOI:"${doi}"`
  const params = new URLSearchParams()
  params.set('query', query)
  params.set('resultType', 'core')
  params.set('format', 'json')
  params.set('pageSize', '1')
  const data = await fetchJson(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params.toString()}`)
  const rec = data?.resultList?.result?.[0]
  if (!rec) throw new Error('Europe PMC 查不到该记录（请检查 DOI / PMID / PMCID）')

  const title = truncate(str(rec.title || ''), 300)
  const pmcid = str(rec.pmcid || pmcidIn || '')
  const lines: string[] = [
    `【全文】${title || query}`,
    `作者：${truncate(str(rec.authorString || ''), 200) || '（无）'}`,
    `来源：Europe PMC（${str(rec.source) || '?'}${rec.pmid ? ` · PMID ${rec.pmid}` : ''}${pmcid ? ` · ${pmcid}` : ''}${str(rec.pubYear) ? ` · ${rec.pubYear}` : ''}）`,
    '',
  ]

  let gotFullText = false
  if (pmcid) {
    try {
      const xml = await fetchText(
        `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=${cleanPmcid(pmcid)}&retmode=xml`
      )
      if (xml && xml.length > 500 && !/<error/i.test(xml.slice(0, 400))) {
        const text = jatsToText(xml)
        if (text.length > 500) {
          lines.push(text)
          gotFullText = true
        }
      }
    } catch { /* 回退摘要 */ }
  }

  if (!gotFullText) {
    lines.push('（未取得开放获取全文，以下为摘要与可用链接）：', '')
    const abs = str(rec.abstractText || '')
    lines.push(abs ? `摘要：${truncate(abs, 2600)}` : '（该记录无摘要）')
    const urls: any[] = rec.fullTextUrlList?.fullTextUrl || []
    const oaUrls = urls.filter((u) => str(u?.availabilityCode).toUpperCase() === 'OA')
    for (const u of (oaUrls.length ? oaUrls : urls).slice(0, 4)) {
      lines.push(`链接：${str(u?.url)}（${str(u?.site)}${str(u?.documentStyle) ? ' · ' + str(u?.documentStyle) : ''}${str(u?.availability) ? ' · ' + str(u?.availability) : ''}）`)
    }
  }
  return lines.join('\n')
}

// ---------------- 工具清单 ----------------
export function toolDefinitions(): any[] {
  return [
    {
      name: 'search_crossref',
      description:
        '检索 CrossRef 学术元数据库（期刊论文/会议/预印本/书籍章节，收录最全、免 Key）：按标题/关键词查找文献，返回标题、作者、年份、来源刊名、类型、被引数、DOI 与链接。query 传 DOI 时自动转精确查询；已知确切标题时用 search_field=title 精度最高；update_type 可过滤撤稿通知等更新关系。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词：标题、关键词或 DOI（DOI 会自动转为精确查询）' },
          search_field: { type: 'string', enum: ['bibliographic', 'title', 'author'], description: '检索字段：bibliographic 全字段（默认）/ title 标题（已知确切标题时精度最高）/ author 作者' },
          rows: { type: 'number', description: '返回条数（默认 5，最大 20）' },
          year_from: { type: 'number', description: '起始年份（可选，含）' },
          year_to: { type: 'number', description: '截止年份（可选，含）' },
          type: { type: 'string', description: '类型过滤（可选），如 journal-article / book-chapter / proceedings-article / posted-content' },
          update_type: { type: 'string', description: '更新关系过滤（可选）：如 retraction 撤稿通知 / correction 更正 / withdrawal 撤回；结果会给出被撤原文与 Retraction Watch 编号' },
          sort: { type: 'string', enum: ['relevance', 'cited', 'newest'], description: '排序：relevance 相关度（默认）/ cited 被引降序 / newest 最新' },
          email: { type: 'string', description: '可选：联系邮箱（CrossRef 礼貌池，走更稳定的限速通道）' },
        },
        required: ['query'],
      },
    },
    {
      name: 'search_openalex',
      description:
        '检索 OpenAlex 开放学术图谱（免 Key）：返回标题、作者、年份、来源期刊、被引数、DOI、开放获取（OA）状态与全文链接，并附摘要片段；支持 retracted_only（只看被撤稿文献）与 author_id（某作者的全部论文，ID 由 search_authors 获得）。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词：标题 / 关键词 / DOI（DOI 会自动转为精确查询）；省略时需提供 author_id 或 retracted_only' },
          per_page: { type: 'number', description: '返回条数（默认 5，最大 20）' },
          year_from: { type: 'number', description: '起始年份（可选，含）' },
          year_to: { type: 'number', description: '截止年份（可选，含）' },
          oa_only: { type: 'boolean', description: '仅返回开放获取（OA）文献' },
          retracted_only: { type: 'boolean', description: '仅返回已被撤稿的文献（is_retracted=true）' },
          author_id: { type: 'string', description: '限定某位作者（OpenAlex 作者 ID，如 A5086198262；由 search_authors 返回）' },
          sort: { type: 'string', enum: ['relevance', 'cited', 'newest'], description: '排序：relevance 相关度（默认）/ cited 被引降序 / newest 最新' },
          email: { type: 'string', description: '可选：联系邮箱（OpenAlex 礼貌池）' },
        },
      },
    },
    {
      name: 'search_arxiv',
      description:
        '检索 arXiv 预印本（物理/数学/计算机/统计/量化生物等，免 Key）：返回标题、作者、提交日期、分类、摘要与 abs / PDF 链接。查询支持 arXiv 语法（ti: 标题、au: 作者、cat:cs.AI 分类、all: 全字段；不写字段默认 all:）。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词；支持 ti: / au: / cat: / all: 语法（含冒号时按原样使用）' },
          max_results: { type: 'number', description: '返回条数（默认 5，最大 20）' },
          sort: { type: 'string', enum: ['relevance', 'newest'], description: '排序：relevance 相关度（默认）/ newest 最新提交' },
        },
        required: ['query'],
      },
    },
    {
      name: 'search_pubmed',
      description:
        '检索 PubMed 生物医学文献库（NCBI E-utilities，免 Key）：返回标题、作者、期刊、发表日期、PMID 与 DOI 链接。支持年份区间；检索撤稿文献可加 retracted publication[pt]，撤稿通知可加 retraction of publication[pt]；适合生命科学 / 医学 / 公共卫生主题。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词：关键词 / 主题词 / 作者（PubMed 语法如 [ti]、[au] 也可用）' },
          max_results: { type: 'number', description: '返回条数（默认 5，最大 20）' },
          year_from: { type: 'number', description: '起始年份（可选，含）' },
          year_to: { type: 'number', description: '截止年份（可选，含）' },
          email: { type: 'string', description: '可选：联系邮箱（NCBI 建议提供）' },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_by_doi',
      description:
        '按 DOI 获取单篇文献的完整元数据（OpenAlex + CrossRef 双源合并）：标题、作者、年份、期刊 / 出版方、被引数、开放获取状态与全文链接、摘要片段。核对引用信息、补全参考文献时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          doi: { type: 'string', description: 'DOI，如 10.1016/j.jclepro.2024.141234（也接受 https://doi.org/... 形式）' },
        },
        required: ['doi'],
      },
    },
    {
      name: 'search_authors',
      description:
        '检索 OpenAlex 作者库（免 Key）：按姓名查找学者，返回 OpenAlex 作者 ID、ORCID、论文数、被引数、h-index 与最近机构。拿到作者 ID 后可用 search_openalex 的 author_id 参数拉取其全部论文。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '作者姓名（英文姓名效果最好）' },
          per_page: { type: 'number', description: '返回条数（默认 5，最大 20）' },
          email: { type: 'string', description: '可选：联系邮箱（OpenAlex 礼貌池）' },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_retraction_info',
      description:
        '查询某 DOI 的撤稿 / 更正状态（OpenAlex 撤稿标记 + CrossRef update-to/updated-by + Europe PMC commentCorrection 三源合并）：返回是否被撤稿、撤稿通知的 DOI、日期与 Retraction Watch 编号。批量核查文献是否被撤（撤稿原因挖掘）时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          doi: { type: 'string', description: 'DOI，如 10.1177/1758835919874651（也接受 https://doi.org/... 形式）' },
        },
        required: ['doi'],
      },
    },
    {
      name: 'search_europepmc',
      description:
        '检索 Europe PMC（生命科学文献 + 预印本，免 Key，带开放获取全文链接与撤稿关系）：返回标题、作者、期刊、年份、DOI/PMID/PMCID、被引数、OA 全文链接与撤稿 / 更正关系（Retraction in/of）。支持年份区间、仅 OA、仅被撤稿（retracted_only）过滤；撤稿核查与找免费全文时优先用。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词；支持 Europe PMC 语法（TITLE:、AUTH:、DOI:"…"）；传 DOI 会自动转精确查询；省略时需提供 retracted_only' },
          max_results: { type: 'number', description: '返回条数（默认 5，最大 20）' },
          year_from: { type: 'number', description: '起始年份（可选，含）' },
          year_to: { type: 'number', description: '截止年份（可选，含）' },
          oa_only: { type: 'boolean', description: '仅返回开放获取（OA）文献（OPEN_ACCESS:Y）' },
          retracted_only: { type: 'boolean', description: '仅返回被撤稿文献（PUB_TYPE:"retracted publication"）' },
          sort: { type: 'string', enum: ['relevance', 'cited', 'newest'], description: '排序：relevance 相关度（默认）/ cited 被引降序 / newest 最新' },
        },
      },
    },
    {
      name: 'get_fulltext',
      description:
        '通过 Europe PMC 获取开放获取全文（经 NCBI PMC 拉取 JATS XML 并转为纯文本，含摘要与正文段落；非 OA 时回退为摘要 + 全文链接）：给定 doi / pmid / pmcid 任一即可。撤稿原因挖掘、精读正文、提取实验细节时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          doi: { type: 'string', description: 'DOI（三选一）' },
          pmid: { type: 'string', description: 'PubMed ID（三选一）' },
          pmcid: { type: 'string', description: 'PMC 编号，如 PMC12064978（三选一）' },
        },
      },
    },
  ]
}

// ---------------- 工具执行 ----------------
async function executeTool(name: string, args: any): Promise<string> {
  switch (name) {
    case 'search_crossref':
      return await searchCrossref(args)
    case 'search_openalex':
      return await searchOpenAlex(args)
    case 'search_arxiv':
      return await searchArxiv(args)
    case 'search_pubmed':
      return await searchPubmed(args)
    case 'get_by_doi':
      return await getByDoi(args)
    case 'search_authors':
      return await searchAuthors(args)
    case 'get_retraction_info':
      return await getRetractionInfo(args)
    case 'search_europepmc':
      return await searchEuropepmc(args)
    case 'get_fulltext':
      return await getFulltext(args)
    default:
      throw new Error(`未知工具: ${name}`)
  }
}

// ---------------- 共享单例 Server（内置连接与对外暴露共用） ----------------
let sharedServer: any = null
let sharedServerReady: Promise<any> | null = null

async function ensureServer(): Promise<any> {
  if (sharedServer) return sharedServer
  if (!sharedServerReady) {
    sharedServerReady = (async () => {
      const sdk = await getServerSdk()
      const server = new sdk.Server(
        { name: 'AI-KM Literature (学术文献检索)', version: '0.3.0' },
        { capabilities: { tools: {} } }
      )
      const tools = toolDefinitions()
      server.setRequestHandler(sdk.ListToolsRequestSchema, async () => ({ tools }))
      server.setRequestHandler(sdk.CallToolRequestSchema, async (req: any) => {
        const toolName = String(req?.params?.name || '')
        const args = req?.params?.arguments && typeof req.params.arguments === 'object' ? req.params.arguments : {}
        try {
          let text = await executeTool(toolName, args)
          if (text.length > MAX_OUTPUT) text = text.slice(0, MAX_OUTPUT) + '\n…（输出超长已截断，可减少返回条数或收窄检索词）'
          return { content: [{ type: 'text', text }] }
        } catch (err: any) {
          return { isError: true, content: [{ type: 'text', text: `查询失败：${err?.message || String(err)}` }] }
        }
      })
      sharedServer = server
      return server
    })()
  }
  return sharedServerReady
}

/** 供 mcp-service：内置连接每次创建一对 InMemory transport 并挂到共享 Server（断开即回收） */
export async function createLocalServerPair(): Promise<{ server: any; clientTransport: any }> {
  const sdk = await getServerSdk()
  const server = await ensureServer()
  const [clientTransport, serverTransport] = sdk.InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  return { server, clientTransport }
}

/** 供对外 HTTP 暴露层：把外部 transport 挂到同一共享 Server */
export async function connectTransport(transport: any): Promise<void> {
  const server = await ensureServer()
  await server.connect(transport)
}

export const literatureService = {
  createLocalServerPair,
  connectTransport,
  toolDefinitions,
  listToolNames: () => toolDefinitions().map((t: any) => t.name),
  /** 直接执行某个工具（调试 / 自动化测试用，跳过 MCP 传输层） */
  executeTool,
}
