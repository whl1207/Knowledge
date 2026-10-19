// GraphRAG 风格的检索增强工具
// 参考 GraphRAG Local Search 的实体感知检索设计

import {
  buildMapPrompt,
  buildReducePrompt,
} from '@/shared/graphrag/prompts'
/**
 * 中英混排分词器
 *
 * 中文没有空格，按空格切分会把整句当成一个 token，导致 BM25 对中文完全失效
 * （查询词几乎永远匹配不上文档词）。这里采用与离线评测一致的口径：
 *   - 拉丁词/数字：按字母数字串切分后取整词
 *   - 中文：连续汉字串切 bigram（相邻两字），同时保留单字以覆盖单字词
 * 该口径不依赖外部分词库，跨平台一致。
 */
export function tokenizeMixed(text: string): string[] {
  if (!text) return []
  // 去掉 LaTeX 公式，避免数学符号污染词频
  const cleaned = String(text).replace(/\$[^$]*\$/g, ' ')
  const out: string[] = []
  // 拉丁词与数字
  const latin = cleaned.match(/[A-Za-z][A-Za-z0-9\-.]{1,}/g) || []
  for (const w of latin) out.push(w.toLowerCase())
  // 中文串 → bigram + 单字
  const cjkRuns = cleaned.match(/[\u4e00-\u9fff]+/g) || []
  for (const seg of cjkRuns) {
    for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2))
    for (const ch of seg) out.push(ch)
  }
  return out
}

/**
 * BM25 打分（按查询归一化到 [0,1]）
 *
 * 使用 tokenizeMixed 分词，因此对中文有效。
 * 归一化：除以本次查询下的最大分（相对分，便于与余弦相似度融合）。
 */
export function computeBM25Score(query: string, documents: string[], k1: number = 1.5, b: number = 0.75): number[] {
  const queryTerms = tokenizeMixed(query)
  const N = documents.length
  if (!N || !queryTerms.length) return documents.map(() => 0)

  const docTokens: string[][] = documents.map(d => tokenizeMixed(d))
  const docLengths = docTokens.map(t => t.length)
  const avgDocLength = docLengths.reduce((s, x) => s + x, 0) / (N || 1) || 1

  // 文档频率
  const docFreq: Record<string, number> = {}
  const termFreqs: Array<Record<string, number>> = []
  for (const tokens of docTokens) {
    const tf: Record<string, number> = {}
    const seen = new Set<string>()
    for (const t of tokens) {
      tf[t] = (tf[t] || 0) + 1
      if (!seen.has(t)) {
        docFreq[t] = (docFreq[t] || 0) + 1
        seen.add(t)
      }
    }
    termFreqs.push(tf)
  }

  const scores: number[] = []
  for (let i = 0; i < N; i++) {
    const tf = termFreqs[i]
    let score = 0
    const dl = docLengths[i] || 1
    for (const term of queryTerms) {
      const df = docFreq[term] || 0
      const f = tf[term] || 0
      if (!df || !f) continue
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1)
      const numerator = f * (k1 + 1)
      const denominator = f + k1 * (1 - b + b * dl / avgDocLength)
      score += idf * numerator / denominator
    }
    scores.push(score)
  }

  const maxScore = Math.max(...scores, 1e-9)
  return scores.map(s => s / maxScore)
}

/**
 * 查询与社区报告的相关度（0~1）
 *
 * 旧实现用 `query.toLowerCase().includes(title)`，即拿**整条查询**在标题里找子串，
 * 真实问题几乎不可能被完整包含，导致相关度恒为 0、排序完全由 rating 决定
 * （与查询无关）。这里改为词项级覆盖率：
 *   相关度 = 查询词项在报告文本中的出现比例（按词项长度加权，长词更重）
 */
export function scoreReportRelevance(
  query: string,
  report: { title?: string; summary?: string; findings?: Array<{ summary?: string; explanation?: string }> },
): number {
  const qTerms = Array.from(new Set(tokenizeMixed(query)))
  if (!qTerms.length) return 0
  const titleTerms = new Set(tokenizeMixed(report.title || ''))
  const bodyText = [
    report.summary || '',
    ...(report.findings || []).map(f => `${f.summary || ''} ${f.explanation || ''}`),
  ].join(' ')
  const bodyTerms = new Set(tokenizeMixed(bodyText))

  let totalW = 0
  let gotW = 0
  for (const t of qTerms) {
    // 单字权重低，bigram/整词权重高，避免单字偶然命中虚高
    const w = t.length >= 2 ? 1 : 0.3
    totalW += w
    if (titleTerms.has(t)) gotW += w * 1.5          // 标题命中加权
    else if (bodyTerms.has(t)) gotW += w
  }
  return totalW > 0 ? Math.min(1, gotW / totalW) : 0
}

/**
 * 创建实体感知的分数提升回调
 * 使用 entityToBlocksIndex 快速定位实体关联的切片
 */
export function createEntityBoostCallback(params: {
  matchedEntityNames: string[]
  entityToBlocksIndex: Map<string, Set<string>>
  blocks: any[]
  boostWeight: number
  onStats?: (boostedCount: number, totalEntities: number) => void
}): (scores: Map<number, number>) => Map<number, number> {
  const {
    matchedEntityNames,
    entityToBlocksIndex,
    blocks,
    boostWeight,
    onStats
  } = params

  return (scores: Map<number, number>): Map<number, number> => {
    const boostedScores = new Map<number, number>()
    const boostedBlockIds = new Set<string>()

    // 1. 使用 entityToBlocksIndex 快速查找关联的切片
    const blocksToBoost = new Map<number, number>() // blockIndex -> boost factor

    for (const entityName of matchedEntityNames) {
      const key = entityName.toLowerCase()
      const blockIds = entityToBlocksIndex.get(key)

      if (!blockIds || blockIds.size === 0) {
        // 如果索引中没有，退回到文本匹配
        for (let i = 0; i < blocks.length; i++) {
          const block = blocks[i]
          if (block.A && block.A.toLowerCase().includes(key)) {
            const currentBoost = blocksToBoost.get(i) || 1.0
            blocksToBoost.set(i, Math.max(currentBoost, boostWeight))
            boostedBlockIds.add(block.id)
          }
        }
        continue
      }

      // 使用索引精确匹配
      for (const blockId of blockIds) {
        const idx = blocks.findIndex((b: any) => b.id === blockId)
        if (idx >= 0) {
          const currentBoost = blocksToBoost.get(idx) || 1.0
          blocksToBoost.set(idx, Math.max(currentBoost, boostWeight))
          boostedBlockIds.add(blockId)
        }
      }
    }

    // 2. 应用提升
    for (let i = 0; i < blocks.length; i++) {
      const originalScore = scores.get(i) || 0
      const boost = blocksToBoost.get(i)
      boostedScores.set(i, boost ? originalScore * boost : originalScore)
    }

    if (onStats) {
      onStats(boostedBlockIds.size, matchedEntityNames.length)
    }

    return boostedScores
  }
}

/**
 * 从查询文本中模糊匹配已知实体
 * 支持精确匹配、子串匹配和拼音/近义匹配
 */
export function matchEntitiesFromQuery(
  query: string,
  globalEntities: Map<string, any>
): string[] {
  const matchedNames: string[] = []
  const queryLower = query.toLowerCase()
  // 拉丁词元（如 Kruskal / M / Prim），用于"实体名含拉丁词"的精确化匹配
  const queryLatin = new Set(
    (queryLower.match(/[a-z][a-z0-9\-]{1,}/g) || [])
  )

  for (const [key, entity] of globalEntities.entries()) {
    const nameLower = entity.name.toLowerCase()

    // 精确匹配
    if (queryLower === nameLower) {
      if (!matchedNames.includes(entity.name)) {
        matchedNames.push(entity.name)
      }
      continue
    }

    // 子串匹配：查询包含实体名（实体名至少 2 字）
    if (queryLower.includes(nameLower) && nameLower.length >= 2) {
      if (!matchedNames.includes(entity.name)) {
        matchedNames.push(entity.name)
      }
      continue
    }

    // 结构化名称的精确化匹配：实体名形如「Kruskal 法」「大 M 法」「0-1 规划」，
    // 只有当其拉丁/数字词元**与**其中文词元都出现在查询中时才命中。
    // 旧的按标点分词 + includes 双向包含规则会退化成"单字命中"
    // （查询里的「图」「基」「弧」会命中「图解法」「基变量」「弧」等任意实体），
    // 使 boost 集合扩散到与查询无关的切片，增强失去选择性。
    const entityLatin = nameLower.match(/[a-z][a-z0-9\-]{1,}/g) || []
    const entityCjk = nameLower.match(/[\u4e00-\u9fff]{2,}/g) || []
    if (entityLatin.length > 0 && entityCjk.length > 0) {
      const latinHit = entityLatin.some((t: string) => queryLatin.has(t))
      const cjkHit = entityCjk.some((t: string) => queryLower.includes(t))
      if (latinHit && cjkHit) {
        if (!matchedNames.includes(entity.name)) {
          matchedNames.push(entity.name)
        }
      }
    }
  }

  return matchedNames
}

// ===== GraphRAG 多阶段搜索 =====

/**
 * 多阶段搜索入口
 * 参考 GraphRAG Global Search 的 Map-Reduce 模式
 *
 * 流程：
 * 1. 选择与查询最相关的社区报告
 * 2. 并行 Map：每批传 LLM 生成带评分的中间回答
 * 3. 排序评分 → 截断 token → Reduce 合并为最终回答
 */
export async function multiStageSearch(
  query: string,
  options: {
    blocks: Array<{ id: string; A: string; label?: string; A_vector?: number[]; p?: number }>
    communityReports: Array<{
      communityId: number
      title: string
      summary: string
      findings: Array<{ summary: string; explanation: string }>
      rating: number
    }>
    chat: (prompt: string) => Promise<string>
    /** 流式调用 LLM（用于 Reduce 阶段流式输出） */
    streamChat?: (prompt: string, onChunk: (chunk: string) => void) => Promise<string>
    /** Reduce 阶段流式输出的回调 */
    onReduceStream?: (chunk: string) => void
    maxMapTokens?: number
    maxReduceTokens?: number
    language?: string
    onProgress?: (msg: string) => void
    /** 仅需召回时跳过 Reduce 回答生成（测试场景加速） */
    skipReduce?: boolean
  }
): Promise<{
  answer: string
  mapResults: Array<{ answer: string; score: number; sourceCommunityId: number }>
  llmCalls: number
}> {
  const {
    blocks,
    communityReports,
    chat,
    maxMapTokens = 2000,
    maxReduceTokens = 3000,
    language = 'zh',
    onProgress
  } = options

  if (communityReports.length === 0) {
    return { answer: '', mapResults: [], llmCalls: 0 }
  }

  // ---- 1. 选择相关社区（词项级相关度排序，rating 仅作轻微先验） ----
  // 旧实现：score = rating*10 + (整条 query 是否为 title/summary 子串 ? 常数 : 0)
  //   -> 后三项几乎恒为 0，排序完全由 rating 决定，与查询无关。
  // 新实现：以词项覆盖率为主（0~1），rating 只占 10% 权重作为先验。
  const maxRating = Math.max(1, ...communityReports.map(r => Number(r.rating) || 0))
  // 最低相关度门槛：相关性只看词项覆盖率，rating 仅作 10% 先验。
  // 若完全无词项命中，说明该社区与本查询无关，不应因 rating 高而入选。
  const MIN_RELEVANCE = 0.25
  const scoredReports = communityReports
    .map(r => {
      const rel = scoreReportRelevance(query, r)
      const prior = (Number(r.rating) || 0) / maxRating   // 0~1
      return { ...r, relevance: rel * 0.9 + prior * 0.1, termRelevance: rel }
    })
    .filter(r => r.termRelevance >= MIN_RELEVANCE)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 10) // 最多取 10 个

  if (scoredReports.length === 0) {
    return { answer: '', mapResults: [], llmCalls: 0 }
  }

  // ---- 2. Map 阶段：逐社区分析 ----
  // 旧实现把 3 个社区塞进一个批次，却把该批所有结论都归因到 batch[0].communityId，
  // 导致下游「社区 -> 切片」漏掉 2/3 的相关社区。
  // 现改为一个社区一个批次（BATCH_SIZE = 1），归因精确；批次仍并发执行。
  const BATCH_SIZE = 1
  const batches: typeof scoredReports[] = []
  for (let i = 0; i < scoredReports.length; i += BATCH_SIZE) {
    batches.push(scoredReports.slice(i, i + BATCH_SIZE))
  }

  onProgress?.(language === 'zh'
    ? `Map 阶段: ${batches.length} 批社区报告并行分析...`
    : `Map phase: ${batches.length} batches of community reports...`)

  const mapResults: Array<{ answer: string; score: number; sourceCommunityId: number }> = []
  let llmCalls = 0

  // Map 阶段并行：各批次互相独立，Promise.all 并发执行，显著缩短墙钟时间
  const batchResults = await Promise.all(batches.map(async (batch, batchIdx) => {
    // 构建批次上下文
    const contextParts = batch.map(r => {
      const findingsText = r.findings.map(f => `- ${f.summary}: ${f.explanation}`).join('\n')
      return `【${r.title}】(重要性:${r.rating}) ${r.summary}\n${findingsText}`
    })
    const contextData = contextParts.join('\n\n')

    // 使用 prompts 中的 Map 提示词
    const mapPrompt = buildMapPrompt({
      contextData,
      query,
      maxLength: maxMapTokens,
      language
    })

    const out: Array<{ answer: string; score: number; sourceCommunityId: number }> = []
    try {
      const response = await chat(mapPrompt)
      llmCalls++

      // 解析 JSON 响应
      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        const points = parsed.points || []
        for (const p of points) {
          if (p.description && p.score > 0) {
            out.push({
              answer: p.description,
              score: p.score,
              sourceCommunityId: batch[0].communityId
            })
          }
        }
      }
    } catch (e) {
      console.warn(`Map batch ${batchIdx} failed:`, e)
    }
    return out
  }))
  for (const results of batchResults) mapResults.push(...results)

  onProgress?.(language === 'zh'
    ? `Map 阶段完成, 共 ${mapResults.length} 个中间结果`
    : `Map phase done, ${mapResults.length} results`)

  // 仅需召回时（如测试），跳过 Reduce 回答生成，直接返回社区评分结果
  if (options.skipReduce) {
    return { answer: '', mapResults, llmCalls }
  }

  if (mapResults.length === 0) {
    return { answer: '', mapResults, llmCalls }
  }

  // ---- 3. Reduce 阶段：排序 + 合并 ----
  onProgress?.(language === 'zh' ? 'Reduce 阶段: 合并中间结果...' : 'Reduce phase: merging results...')

  // 按评分排序
  const sorted = mapResults.sort((a, b) => b.score - a.score)

  // 截断 token
  let totalLen = 0
  const truncated: typeof sorted = []
  for (const r of sorted) {
    if (totalLen + r.answer.length > maxReduceTokens) break
    truncated.push(r)
    totalLen += r.answer.length
  }

  if (truncated.length === 0) {
    return { answer: '', mapResults, llmCalls }
  }

  // 构建 Reduce 报告文本
  const reportText = truncated.map((r, i) =>
    `----分析师 ${i + 1}----\n重要性评分: ${r.score}\n${r.answer}`
  ).join('\n\n')

  // 调用 LLM 合并
  const reducePrompt = buildReducePrompt({
    analystReports: reportText,
    query,
    maxLength: maxReduceTokens,
    language
  })

  try {
    let answer: string
    if (options.streamChat && options.onReduceStream) {
      // 流式 Reduce
      answer = await options.streamChat(reducePrompt, (chunk) => {
        options.onReduceStream!(chunk)
      })
    } else {
      // 非流式 Reduce
      answer = await chat(reducePrompt)
    }
    llmCalls++
    return { answer, mapResults: truncated, llmCalls }
  } catch (e) {
    console.warn('Reduce failed:', e)
    // 降级：返回评分最高的结果
    return { answer: truncated[0].answer, mapResults: truncated, llmCalls }
  }
}
