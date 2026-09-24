// GraphRAG 风格的检索增强工具
// 参考 GraphRAG Local Search 的实体感知检索设计

import {
  buildMapPrompt,
  buildReducePrompt,
} from '@/shared/graphrag/prompts'

/**
 * BM25 打分（归一化到 [0,1]）
 * 从 knowRAG 抽取为公共工具，聊天与测试共用
 */
export function computeBM25Score(query: string, documents: string[], k1: number = 1.5, b: number = 0.75): number[] {
    const avgDocLength = documents.reduce((sum, doc) => sum + doc.length, 0) / (documents.length || 1);
    const scores: number[] = [];

    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);

    const docFreq: {[term: string]: number} = {};
    const termFreqs: {[term: string]: number}[] = [];

    for (const doc of documents) {
        const terms = doc.toLowerCase().split(/\s+/);
        const tf: {[term: string]: number} = {};
        const seenTerms = new Set<string>();

        for (const term of terms) {
            tf[term] = (tf[term] || 0) + 1;
            if (!seenTerms.has(term)) {
                docFreq[term] = (docFreq[term] || 0) + 1;
                seenTerms.add(term);
            }
        }
        termFreqs.push(tf);
    }

    const N = documents.length;

    for (let i = 0; i < documents.length; i++) {
        const doc = documents[i];
        const tf = termFreqs[i];
        let score = 0;
        const docLength = doc.length;

        for (const term of queryTerms) {
            if (docFreq[term] && tf[term]) {
                const idf = Math.log((N - (docFreq[term] || 0) + 0.5) / ((docFreq[term] || 0) + 0.5) + 1);
                const termFreq = tf[term] || 0;
                const numerator = termFreq * (k1 + 1);
                const denominator = termFreq + k1 * (1 - b + b * docLength / avgDocLength);
                score += idf * numerator / denominator;
            }
        }
        scores.push(score);
    }

    const maxScore = Math.max(...scores, 1);
    return scores.map(s => s / maxScore);
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

  for (const [key, entity] of globalEntities.entries()) {
    const nameLower = entity.name.toLowerCase()

    // 精确匹配
    if (queryLower === nameLower) {
      if (!matchedNames.includes(entity.name)) {
        matchedNames.push(entity.name)
      }
      continue
    }

    // 子串匹配（查询包含实体名 或 实体名包含查询关键词）
    if (queryLower.includes(nameLower) && nameLower.length >= 2) {
      if (!matchedNames.includes(entity.name)) {
        matchedNames.push(entity.name)
      }
      continue
    }

    // 关键词匹配：将查询拆词后匹配实体名的各个部分
    const queryWords = queryLower.split(/[\s,，、.。:：;；！!？?]+/).filter(w => w.length >= 2)
    const entityWords = nameLower.split(/[\s_\-]+/)

    for (const qWord of queryWords) {
      for (const eWord of entityWords) {
        if (eWord.includes(qWord) || qWord.includes(eWord)) {
          if (!matchedNames.includes(entity.name)) {
            matchedNames.push(entity.name)
          }
          break
        }
      }
      if (matchedNames.includes(entity.name)) break
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

  // ---- 1. 选择相关社区（按评分排序取 top-N） ----
  const scoredReports = communityReports
    .map(r => {
      // 简单相关性：查询词在报告中的匹配度
      const ql = query.toLowerCase()
      let score = r.rating * 10 // 基础分来自社区的重要性
      if (r.title.toLowerCase().includes(ql)) score += 30
      if (r.summary.toLowerCase().includes(ql)) score += 15
      for (const f of r.findings) {
        if (f.summary.toLowerCase().includes(ql) || f.explanation.toLowerCase().includes(ql)) {
          score += 10
          break
        }
      }
      return { ...r, relevance: score }
    })
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 10) // 最多取 10 个

  if (scoredReports.length === 0) {
    return { answer: '', mapResults: [], llmCalls: 0 }
  }

  // ---- 2. Map 阶段：分批并行 ----
  const BATCH_SIZE = 3
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
