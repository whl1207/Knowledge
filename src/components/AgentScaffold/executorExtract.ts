/**
 * executorExtract.ts — 结构化提取执行器（Step 3，移植自 CollectFile/collectFileAgent.ts）
 *
 * 一单元 = 一行任务，素材按「内容获取」（contentSource）三态取：
 *   none = 直接使用行数据（单字段取其值；多字段拼成「字段: 值」行）
 *   file = 把行内指定字段当作本地文件路径读取（readFile IPC，支持 md/txt/docx/pdf/xlsx/html）
 *   url  = 把行内指定字段当作网页地址抓取（顺带解析 title/links 字段，支持链接跟随）
 * → 长内容分段（段落/表格边界安全切分，表格分段自动补表头）
 * → 每段一次 LLM 提取（任务目标支持 {{列名}} 占位符；JSON 三级容错解析 + 最多 2 次强化提示重试）
 * → 汇总多条结构数据（字段对齐与主键合并由 dataRows 汇聚器完成）。
 *
 * 与旧实现差异（v1，对照移植的已知裁剪）：
 *   - LLM 调用统一走 store.sendToAI（跟随全局配置），不再携带 per-task 多后端参数与 jsonMode/Schema 强制输出；
 *   - 必填字段补全（completeRequiredFields）与主键冲突的 LLM 合并（mergeDataWithLLM）暂未移植；
 *   - 网络/后端错误直接冒泡（由 runner 判失败并按配置重试）；仅"JSON 解析多次失败"记警告并按 0 条继续（与旧实现一致）。
 */

import type {
  BatchConfig, BatchCallbacks, ExecutorContext, ExecutorDeps, ExecutorOutcome,
  PipelineExecutor, PipelineUnit,
} from './types'
import { effectiveContentSource, resolveContentField } from './types'
import { renderTemplate, schemaFieldList, schemaExampleJson } from './render'
import { tryParseJson } from './parsers'
import {
  fetchPage, filterHtmlToText, extractLinksFromHtml, formatLinkList,
  extractPageTitle, PIPELINE_LINKS_FIELD, PIPELINE_TITLE_FIELD,
} from './fetch'

export class ExtractExecutor implements PipelineExecutor {
  readonly kind = 'extract' as const
  private config: BatchConfig
  private store: any
  private callbacks: BatchCallbacks
  private deps: ExecutorDeps
  /** 进行中的 LLM 请求（按行 id 分组：可只中止某一行；abort() 中止全部） */
  private aborts = new Map<string, Set<AbortController>>()
  /** 最近一次单段提取的模型原始输出（整行 0 条时回传给 runner，保留到行上便于排查） */
  private lastRawOutput = ''
  // token 统计（累计）
  private totalInput = 0
  private totalOutput = 0

  constructor(config: BatchConfig, store: any, callbacks: BatchCallbacks = {}, deps?: ExecutorDeps) {
    this.config = config
    this.store = store
    this.callbacks = callbacks
    this.deps = deps || { log: () => {}, isStopRequested: () => false }
  }

  /** 新一轮批量的 token 归零（runner.start 调用） */
  resetTokens(): void {
    this.totalInput = 0
    this.totalOutput = 0
  }

  /** 停止：中止所有进行中的 LLM 请求 */
  abort(): void {
    for (const set of this.aborts.values()) for (const c of set) c.abort()
    this.aborts.clear()
  }

  /** 只中止某一行的进行中请求（行详情「停止」；其它行不受影响） */
  abortRow(rowId: string): void {
    const set = this.aborts.get(rowId)
    if (!set) return
    for (const c of set) c.abort()
    this.aborts.delete(rowId)
  }

  /** 登记 / 注销某一行的进行中请求 */
  private trackAbort(rowId: string, c: AbortController): void {
    let set = this.aborts.get(rowId)
    if (!set) { set = new Set(); this.aborts.set(rowId, set) }
    set.add(c)
  }
  private untrackAbort(rowId: string, c: AbortController): void {
    const set = this.aborts.get(rowId)
    if (!set) return
    set.delete(c)
    if (!set.size) this.aborts.delete(rowId)
  }

  // ==================== 执行 ====================
  async run(unit: PipelineUnit, ctx: ExecutorContext): Promise<ExecutorOutcome> {
    const schema = this.config.schema || []
    if (!schema.length) throw new Error('请先配置提取字段（目标结构）')

    // 素材获取：按「内容获取」三态取内容（无 = 直接用行数据；file = 读字段中的文件；url = 抓字段中的网页）
    const contentSrc = effectiveContentSource(this.config)
    const contentField = resolveContentField(this.config)
    let label: string
    let content: string
    let pageLinks: string[] | undefined
    if (contentSrc === 'url') {
      const page = await this.loadWebPage(unit, ctx, contentField)
      label = page.url
      content = page.body
      pageLinks = page.linkUrls
    } else if (contentSrc === 'file') {
      const filePath = String(unit.data?.[contentField] || unit.data?.filePath || '')
      label = String(unit.data?.relativePath || unit.data?.fileName || filePath)
      if (!filePath) throw new Error('缺少文件路径（请通过「扫描文件夹」生成任务行，或在「内容获取」中指定字段）')
      // 读取文件内容（readFile 支持 md/txt/docx/pdf/xlsx/html 等转文本）
      try {
        content = await window.ipcRenderer.invoke('readFile', filePath)
        if (!content || String(content).startsWith('Error reading file:')) {
          throw new Error(String(content || '读取文件失败'))
        }
      } catch (error: any) {
        throw new Error(`读取文件失败: ${error?.message || error}`)
      }
      ctx.log('info', `[${label}] 文件大小: ${(content.length / 1024).toFixed(1)}KB`)
    } else {
      // 无内容获取：直接使用行数据作为素材（单字段取该字段值；多字段拼成「字段: 值」行）
      const single = contentField ? String(unit.data?.[contentField] ?? '').trim() : ''
      if (single) {
        label = single.slice(0, 60)
        content = single
      } else {
        content = formatRowAsText(unit.data || {})
        label = content.split('\n')[0]?.slice(0, 60) || '(空行)'
      }
      ctx.log('info', `[${label}] 使用行数据作为素材（长度 ${content.length}）`)
    }

    if (!String(content || '').trim()) {
      ctx.log('warning', `[${label}] 无可分析内容，跳过提取（该行按 0 条数据完成）`)
      return { ok: true, rows: [], links: pageLinks }
    }

    // 长内容分段，每段分别提取后合并（边提取边汇总，段落/表格边界安全切分）
    const chunks = this.chunkContent(content, ctx)
    const rows: Array<Record<string, any>> = []
    // 各段模型原始输出（仅在一条记录都没解析出来时回传，避免体积膨胀）
    const rawOutputs: string[] = []
    for (let ci = 0; ci < chunks.length; ci++) {
      if (ctx.isStopRequested()) return { ok: false, error: '已手动停止' }
      const chunk = chunks[ci]
      ctx.log('info', `[${label}] 正在处理第 ${ci + 1}/${chunks.length} 段内容（长度 ${chunk.length}）...`)
      this.lastRawOutput = ''
      const extracted = await this.extractChunk(chunk, unit, ci, chunks.length, ctx)
      if (extracted.length > 0) {
        ctx.log('info', `[${label}] 第 ${ci + 1} 段提取到 ${extracted.length} 条数据`)
        rows.push(...extracted)
      } else if (this.lastRawOutput) {
        // 没解析出来 → 先留着原文（最多 8 段），以便整行 0 条时告诉用户模型到底答了什么
        if (rawOutputs.length < 8) rawOutputs.push(this.lastRawOutput)
      }
    }
    if (rows.length > 0) {
      ctx.log('info', `[${label}] 全部 ${chunks.length} 段共提取到 ${rows.length} 条数据`)
    }
    // 分段结果汇总策略（config.segmentMerge，默认 'one'）：
    // 一个文件被切成多段时，每段往往只能看到「部分内容」→ 各段返回的是同一条逻辑记录的片段。
    // 默认把这些片段按字段合并成一条记录，保证「一行任务 = 一条数据」；
    // 需要「一个文件里含多条独立记录」（如长长的清单 / 列表页）时改成 'each'。
    if (chunks.length > 1 && (this.config.segmentMerge || 'one') === 'one' && rows.length > 1) {
      const before = rows.length
      const merged = this.mergeSegmentRecords(rows)
      rows.splice(0, rows.length, merged)
      ctx.log('info', `[${label}] 已把 ${chunks.length} 段提取的 ${before} 条记录合并为 1 条（可在「输出 → 分段结果」改为每段各一条）`)
    }
    const rawText = rows.length ? undefined : rawOutputs.join('\n\n').slice(0, 20000)
    return { ok: true, rows, links: pageLinks, rawText }
  }

  /**
   * 把同一任务行各段提取出的记录合并成一条（逐字段）：
   *   - 字符串：去重后按段顺序用换行拼接（各段分别看到的片段合起来才是完整内容）；
   *   - 数字 / 布尔：保留第一个非空值（不求和 —— 分段里出现的往往是同一个标量）；
   *   - 数组：去重后拼接；字段顺序按首次出现的位置。
   */
  private mergeSegmentRecords(records: Array<Record<string, any>>): Record<string, any> {
    const out: Record<string, any> = {}
    for (const rec of records) {
      for (const [k, v] of Object.entries(rec || {})) {
        if (v === undefined || v === null || v === '') continue
        if (!(k in out)) {
          out[k] = v
          continue
        }
        const prev = out[k]
        if (Array.isArray(prev) || Array.isArray(v)) {
          const a = Array.isArray(prev) ? prev : [prev]
          const b = Array.isArray(v) ? v : [v]
          const seen = new Set<string>()
          out[k] = [...a, ...b].filter((x: any) => {
            const key = typeof x === 'string' ? x.trim() : JSON.stringify(x)
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })
        } else if (typeof prev === 'string' && typeof v === 'string') {
          const lines = prev.split('\n').map(s => s.trim()).filter(Boolean)
          const extra = v.split('\n').map(s => s.trim()).filter(Boolean)
          for (const line of extra) if (!lines.includes(line)) lines.push(line)
          out[k] = lines.join('\n')
        }
        // 其余情况（数字 / 布尔 / 对象）：保留第一个非空值，不求和也不拼接
      }
    }
    return out
  }

  // ==================== url 内容获取：抓取网页（「链接即字段」） ====================
  /**
   * 抓取页面 → 清洗正文 → 解析链接，并把页面信息写成行字段：
   *   title → 行字段（页面标题）；links → 行字段（逐行一条 URL，即“链接即字段”）
   * 同时写入 unit.meta.discoveredLinks：供 runner 在行结束后扩展 frontier（即使本次提取失败也能延续爬取轨迹）。
   * @param field 行内网页地址字段名（文本源 = textFieldName；表格源 = contentField）
   */
  private async loadWebPage(
    unit: PipelineUnit,
    ctx: ExecutorContext,
    field: string,
  ): Promise<{ url: string; body: string; linkUrls: string[] }> {
    const url = String(unit.data?.[field] || '')
    if (!url) throw new Error(field ? `字段「${field}」为空（该行没有网页地址）` : '缺少网页地址字段（请在「内容获取」中指定字段）')
    const res = await fetchPage(url)
    if (!res.ok) throw new Error(`抓取失败: ${res.error}`)
    const raw = res.raw || ''
    ctx.log('info', `[${url}] 页面大小: ${(raw.length / 1024).toFixed(1)}KB`)

    // 解析链接（锚文本 + 绝对 URL；关键词相关度排序），并限制单页链接数避免字段过大
    const MAX_LINKS = 500
    const linkInfos = extractLinksFromHtml(raw, url, this.config.urlKeywords || '')
    const kept = linkInfos.length > MAX_LINKS ? linkInfos.slice(0, MAX_LINKS) : linkInfos
    if (linkInfos.length > MAX_LINKS) {
      ctx.log('warning', `[${url}] 页面链接过多（${linkInfos.length}），仅保留前 ${MAX_LINKS} 条`)
    }
    const linkUrls = kept.map(l => l.url)

    // 链接即字段：title / links 写入行字段；discoveredLinks 供 runner 扩展 frontier
    const title = extractPageTitle(raw)
    unit.data[PIPELINE_TITLE_FIELD] = title
    unit.data[PIPELINE_LINKS_FIELD] = linkUrls.join('\n')
    unit.meta = { ...(unit.meta || {}), discoveredLinks: linkUrls }
    ctx.log('info', `[${url}] 提取到 ${linkInfos.length} 个链接`)

    // 分析对象：链接清单（旧「链接分析模式」，锚文本 + URL）或过滤后正文
    let body: string
    if (this.config.urlBody === 'links') {
      body = kept.length ? formatLinkList(kept) : ''
      if (!body) ctx.log('warning', `[${url}] 链接分析模式：未提取到任何链接，跳过数据提取`)
    } else {
      body = /^\s*[\[{]/.test(raw) ? raw : filterHtmlToText(raw)
      ctx.log('info', `[${url}] 过滤后长度: ${body.length}`)
    }
    return { url, body, linkUrls }
  }

  // ==================== 内容分段 ====================
  // 分段原则：优先在空行（段落）边界切分；段落仍超长时再按「整行」切分，
  // 保证任意分段都不会在行中间被截断。对于 Markdown 表格（CSV/Excel 转来的表格），
  // 每个分段都会重新带上表头，确保 LLM 始终知道列名。（移植自 CollectFile.chunkContent）
  private chunkContent(content: string, ctx: ExecutorContext): string[] {
    const chunkSize = this.config.maxContentPerFile || 8000
    // 统一换行符，避免 CRLF 文件在行尾残留 \r
    content = content.replace(/\r\n/g, '\n')
    if (content.length <= chunkSize) return [content]

    // 1. 按空行拆分为"段落块"：一个段落或一张 Markdown 表格作为整体，避免拆断
    const blocks = content.split(/\n\s*\n/).map(b => b.trim()).filter(b => b.length > 0)

    const chunks: string[] = []
    let current = ''
    const flush = () => { if (current.trim()) chunks.push(current.trim()); current = '' }

    for (const block of blocks) {
      // 块本身超长：先落库已累积内容，再单独安全拆分该块
      if (block.length > chunkSize) {
        flush()
        this.splitBlockSafely(block, chunkSize, chunks, ctx)
        continue
      }
      // 追加块（块之间用空行分隔）；超出上限则先落库
      if (current.length + block.length > chunkSize && current.length > 0) {
        flush()
      }
      current += (current ? '\n\n' : '') + block
    }
    flush()

    ctx.log('info', `内容已分为 ${chunks.length} 段（每段约 ${chunkSize} 字符）`)
    return chunks
  }

  // 识别 Markdown 表格：首行以 | 开头，且第二行是 --- 分隔行（允许 :---: 对齐写法）
  private splitTableParts(lines: string[]): { header: string; separator: string; body: string[] } | null {
    if (lines.length < 2) return null
    const first = lines[0].trim()
    if (!first.startsWith('|')) return null
    const sep = lines[1].trim()
    if (!/^\|?[\s:|-]+\|?$/.test(sep) || !sep.includes('-')) return null
    return { header: lines[0], separator: lines[1], body: lines.slice(2) }
  }

  // 超长块安全拆分：优先在空行/段落边界切，仍超长才按行切（行是完整单元，不会截断表格行）
  private splitBlockSafely(block: string, chunkSize: number, out: string[], ctx: ExecutorContext): void {
    const innerBlocks = block.split(/\n\s*\n/).map(b => b.trim()).filter(b => b.length > 0)
    let current = ''
    const flush = () => { if (current.trim()) out.push(current.trim()); current = '' }

    for (const inner of innerBlocks) {
      // 段落/表格整体未超长：直接合并
      if (inner.length <= chunkSize) {
        if (current.length + inner.length > chunkSize && current.length > 0) flush()
        current += (current ? '\n\n' : '') + inner
        continue
      }
      // 单个段落/表格仍超长：按行切分（保持整行完整）
      flush()
      this.splitLongBlockByLines(inner, chunkSize, out, ctx)
    }
    flush()
  }

  // 按整行切分超长内容：行是最小完整单元，绝不在行中间截断；表格类内容每个分段重新带上表头行
  private splitLongBlockByLines(inner: string, chunkSize: number, out: string[], ctx: ExecutorContext): void {
    const lines = inner.split('\n')
    const tableInfo = this.splitTableParts(lines)
    const headerLines = tableInfo ? [tableInfo.header, tableInfo.separator] : []
    const bodyLines = tableInfo ? tableInfo.body : lines

    let buf = ''
    const flushBuf = () => {
      if (!buf.trim()) { buf = ''; return }
      let seg = buf.trim()
      if (tableInfo) seg = headerLines.join('\n') + '\n' + seg
      out.push(seg)
      buf = ''
    }

    for (const line of bodyLines) {
      if (line.length > chunkSize) {
        // 单行本身超长：为保持行完整只能整行保留（无法拆开），单独成段并给出提示
        flushBuf()
        if (tableInfo) out.push(headerLines.join('\n') + '\n' + line.trim())
        else out.push(line.trim())
        ctx.log('warning', `检测到超长行（${line.length} 字符 > 每段 ${chunkSize} 字符），已整行保留以保证行完整`)
        continue
      }
      if (buf.length + line.length + 1 > chunkSize && buf.length > 0) {
        flushBuf()
      }
      buf += (buf ? '\n' : '') + line
    }
    flushBuf()
  }

  // ==================== 单段提取 ====================
  /** 单段提取：构造 prompt → 纯 LLM → JSON 容错解析（失败最多 2 次强化重试）→ 返回原始条数 */
  private async extractChunk(
    content: string,
    unit: PipelineUnit,
    chunkIndex: number,
    totalChunks: number,
    ctx: ExecutorContext,
  ): Promise<Array<Record<string, any>>> {
    const label = String(unit.data?.relativePath || unit.data?.fileName || unit.data?.url || unit.data?.text || '')
    const fileCtx = `[${label}${totalChunks ? ` 第${chunkIndex + 1}/${totalChunks}段` : ''}]`
    const prompt = this.buildPrompt(content, unit, ctx)
    const response = await this.send(prompt, ctx, unit.id)
    ctx.log('info', `原始JSON响应 ${fileCtx}:\n${response}`)
    this.lastRawOutput = String(response || '').trim()
    let parsed = tryParseJson(response)

    // 解析失败：最多再重试 2 次，逐步强化格式约束
    if (!parsed) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (ctx.isStopRequested()) break
        ctx.log('warning', `JSON解析失败，正在进行第 ${attempt} 次重试`)
        const retryResponse = await this.send(this.buildStrictPrompt(prompt, attempt), ctx, unit.id)
        ctx.log('info', `重试(${attempt})原始JSON响应 ${fileCtx}:\n${retryResponse}`)
        this.lastRawOutput = String(retryResponse || '').trim() || this.lastRawOutput
        parsed = tryParseJson(retryResponse)
        if (parsed) break
      }
    }
    if (!parsed) {
      ctx.log('warning', `数据提取失败：JSON 解析多次失败，该段按 0 条处理（原始输出已保留在该行）`)
      return []
    }
    return parsed
  }

  /** 提取 prompt（移植自 CollectFile.extractData；v1 不带 jsonMode/Schema 强制输出） */
  private buildPrompt(content: string, unit: PipelineUnit, ctx: ExecutorContext): string {
    const schema = this.config.schema || []
    const schemaStr = schemaFieldList(schema)
    // 基于真实 schema 字段名生成示例 JSON，避免 LLM 自行翻译/改写字段名
    const exampleJson = schemaExampleJson(schema)

    // 任务指令（统一后 = template「任务指令」；旧任务回退 goal「任务目标」）——支持 {{列名}}，每行渲染一次
    const instr = (this.config.template || '').trim() ? this.config.template : (this.config.goal || '')
    const goal = instr
      ? renderTemplate(instr, { ...(unit.data || {}), ...(unit.roundRefs || {}) }, ctx.rowIndex, this.config.keepUnmatched)
      : '按字段定义提取'

    // 来源行按「内容获取」自适应：网页 / 本地文件 / 行数据
    const contentSrc = effectiveContentSource(this.config)
    const contentField = resolveContentField(this.config)
    const intro = contentSrc === 'url' ? '以下网页内容' : contentSrc === 'file' ? '以下本地文档的内容' : '以下内容'
    const srcRef = contentSrc === 'url'
      ? String(unit.data?.[contentField] || '')
      : contentSrc === 'file'
        ? String(unit.data?.[contentField] || unit.data?.filePath || '')
        : `第 ${ctx.rowIndex + 1} 行`
    const srcLine = contentSrc === 'url' ? `页面 URL: ${srcRef}` : contentSrc === 'file' ? `文件路径: ${srcRef}` : `任务行: ${srcRef}`

    // 当前任务行数据（供 LLM 了解行上下文，如 url/title；links 字段可能很长，行内截断）
    const rowCtx = Object.entries(unit.data || {})
      .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
      .slice(0, 12)
      .map(([k, v]) => `${k}: ${String(v).replace(/\s+/g, ' ').slice(0, k === PIPELINE_LINKS_FIELD ? 160 : 300)}`)
      .join('\n')
    const rowCtxBlock = rowCtx ? `\n当前任务行数据:\n${rowCtx}\n` : ''

    return `你是一个数据提取专家。请从${intro}中提取指定字段的数据，整理成结构化表格数据。

任务指令: ${goal}

需要提取的字段（JSON 对象的键【必须】与下列字段名完全一致，包括大小写；禁止翻译、改写、增减括号或注释）:
${schemaStr}

${srcLine}
${rowCtxBlock}
内容:
${content}

要求:
1. 从内容中提取每个字段对应的值
2. 如果某个字段在内容中没有明确信息，留空；但标记为【必填】的字段必须尽可能根据上下文推断补全，不得留空
3. **严格只返回合法的JSON对象或JSON数组，不要包含任何其他文字、代码块标记或注释**
4. 如果内容不相关，返回空对象 {}
5. 如果有多条数据请返回数组 [ {...}, {...} ]，只有一条则返回 {...}

返回格式示例（键名必须严格使用上面的字段名，例如字段名是 Name 就写 "Name"，不要写成 "姓名"）:
${exampleJson}`
  }

  /** 更严格的解析重试提示（移植自 CollectFile.buildStrictPrompt） */
  private buildStrictPrompt(basePrompt: string, attempt: number): string {
    const returnRule = '如果有多条数据请返回数组 [ {...}, {...} ]，只有一条则返回 {...}。'
    const extra = attempt === 1
      ? `注意：请严格只返回合法的JSON对象或JSON数组，不要包含任何其他文字、代码块标记或注释。\n${returnRule}`
      : `警告：上次返回的内容无法解析为合法JSON。请只输出一个标准的JSON对象或JSON数组：\n- 不要有任何解释文字、代码块标记或注释\n- 不要使用尾随逗号、单引号\n- 所有键名和字符串值必须使用英文双引号\n- ${returnRule}`
    return basePrompt + `\n\n${extra}`
  }

  /** 调用 LLM（跟随全局配置；token 由 onComplete metadata 累计）；rowId 用于「只停某一行」 */
  private async send(prompt: string, ctx: ExecutorContext, rowId = ''): Promise<string> {
    const controller = new AbortController()
    if (rowId) this.trackAbort(rowId, controller)
    try {
      return await this.store.sendToAI(
        [{ role: 'user', content: prompt }],
        {
          signal: controller.signal,
          onComplete: (_c: string, metadata?: any) => { this.addTokens(metadata, rowId) },
        },
      )
    } finally {
      if (rowId) this.untrackAbort(rowId, controller)
    }
  }

  /** 累计 token（sendToAI 的 onComplete metadata）；rowId 非空时同时回传该行用量 */
  private addTokens(metadata?: any, rowId = ''): void {
    const pt = Number(metadata?.prompt_tokens ?? metadata?.promptTokens ?? 0) || 0
    const ct = Number(metadata?.completion_tokens ?? metadata?.completionTokens ?? 0) || 0
    this.totalInput += pt
    this.totalOutput += ct
    this.callbacks.onTokenUsage?.(this.totalInput, this.totalOutput, this.totalInput + this.totalOutput)
    if (rowId && (pt || ct)) this.callbacks.onRowTokenUsage?.(rowId, pt, ct)
  }
}

// ==================== 行数据 → 素材料文本（contentSource='none' 时） ====================
/** 把行数据渲染为「字段: 值」文本（单字段行取该字段值；links 字段可能很长，行内多截断） */
function formatRowAsText(data: Record<string, any>): string {
  const lines: string[] = []
  for (const [k, v] of Object.entries(data || {})) {
    let s = v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v))
    s = s.replace(/\s+/g, ' ').trim()
    if (!s) continue
    const cap = k === PIPELINE_LINKS_FIELD ? 200 : 500
    lines.push(`${k}: ${s.length > cap ? s.slice(0, cap) + '…' : s}`)
  }
  return lines.join('\n')
}

