// 检索原语层：可复用的原子检索/索引增强工具
//
// 两类原语：
// 1. 查询时检索原语（Query-time Retrieval Primitives）
//    输入查询，产出打分/证据/元信息，可被策略管线组合。如 dense_score / entity_link /
//    graph_hop / community_select / boost。
// 2. 索引增强原语（Ingestion-time Index Augmentation Primitives）
//    在构建/处理阶段丰富知识库索引，不接收查询。如 semantic_enhance（切片→Q向量 + 文件→摘要向量）、
//    extract_entities（本体抽取）、build_communities（社区检测）、generate_reports（社区报告）。
//
// 原语保持纯函数风格：所有副作用（LLM 调用、嵌入）都通过 RetrievalContext / IngestionContext
// 注入的 services 执行，便于在聊天 / 测试 / 实验管道中复用同一套逻辑。

import { multiHopExpand } from '@/shared/graphrag/multiHop'
import { matchEntitiesFromQuery, computeBM25Score } from '@/shared/graphrag/search'
import { buildQueryEntityMatchPrompt } from '@/shared/graphrag/prompts'

// ========== 共享缓存（性能） ==========

// 实体嵌入向量缓存（跨查询 / 跨策略共享）
// getCurrentOntologyContext() 每次调用会重建实体对象，缓存在对象上的 _vec 随之失效，
// 导致每个查询都对全部实体重新嵌入（最多 300 次顺序 embed 调用，本体召回极慢）。
// 改用模块级 Map 以「name + description」为 key 缓存，首次嵌入后后续查询直接命中。
const entityVectorCache = new Map<string, number[] | undefined>()

/** 清空实体向量缓存（本体重建/编辑后可调用，避免陈旧向量） */
export function clearEntityVectorCache() {
  entityVectorCache.clear()
}

/** 预热实体向量缓存：批量测试前一次性嵌入全部实体的 name/description 向量，避免首问逐实体嵌入 */
export async function prewarmEntityVectors(
  entities: Array<{ name: string; description?: string }>,
  embed: (text: string) => Promise<number[] | undefined>,
): Promise<number> {
  let n = 0
  for (const e of entities) {
    if (!e?.name) continue
    const cacheKey = (e.description ? `${e.name}\u0000${e.description}` : e.name).toLowerCase()
    if (entityVectorCache.has(cacheKey)) continue
    const vec = await embed(e.description ? `${e.name} ${e.description}` : e.name)
    entityVectorCache.set(cacheKey, vec)
    n++
  }
  return n
}

/** 查询向量缓存：一次 runStrategy 内 entity_link / dense_score / file_score 共享同一查询嵌入，避免重复嵌入 */
async function embedQuery(ctx: RetrievalContext): Promise<number[] | undefined> {
  const cache = (ctx as any)._queryVecCache as Map<string, number[] | undefined> | undefined
  if (cache?.has(ctx.query)) return cache.get(ctx.query)
  const v = await ctx.services.embed(ctx.query)
  let m = (ctx as any)._queryVecCache
  if (!m) { m = new Map(); ;(ctx as any)._queryVecCache = m }
  m.set(ctx.query, v)
  return v
}

// ========== 类型定义 ==========

export type RetrievalPrimitiveId =
  | 'dense_score'
  | 'entity_link'
  | 'graph_hop'
  | 'community_select'
  | 'file_score'
  | 'boost'

export type IngestionPrimitiveId =
  | 'semantic_enhance'
  | 'summarize_file'
  | 'extract_entities'
  | 'build_communities'
  | 'generate_reports'

export type PrimitiveId = RetrievalPrimitiveId | IngestionPrimitiveId

/** 增强方向：base=基础检索；semantic=语义增强（增强语义文本→Q向量）；structural=结构化增强（本体/图谱/社区） */
export type PrimitiveDimension = 'base' | 'semantic' | 'structural'

export interface Evidence {
  id: string
  label: string
  filePath: string
  content: string
  score: number
  method: string
  reason?: string
  /** Agentic：该证据由哪个工具子查询召回（子查询文本） */
  subQuery?: string
  /** Agentic：该证据在工具子查询下的检索分数（0~1 余弦相似度），供最终重排融合 */
  subScore?: number
}

export interface RetrievalConfig {
  url: string
  embed: string
  chat: string
  process: string
  locale: string
  summaryWeight: number
  bm25Enabled: boolean
  bm25Weight: number
  bm25K1: number
  bm25B: number
  searchNum: number
  think?: boolean
  /** Agentic：最终重排时融合子查询检索分数的权重（0=只用原始问题，1=只用子查询分数） */
  agentSubQueryWeight?: number
}

export interface RetrievalServices {
  embed(text: string): Promise<number[] | undefined>
  /** 普通对话（非流式），返回文本 */
  chat(messages: any[]): Promise<string>
  /** 流式对话，逐块回调 */
  streamChat(messages: any[], onChunk: (chunk: string) => void): Promise<string>
  /** Agentic 对话：返回 content + tool_calls */
  agenticChat(messages: any[], tools: any[]): Promise<{ content: string; tool_calls: any[] }>
  cosineSimilarity(a: number[], b: number[]): number
  computeBM25(query: string, docs: string[], k1: number, b: number): number[]
}

export interface RetrievalContext {
  query: string
  blocks: any[]
  entities: Array<{ id: string; name: string; type?: string; description?: string }>
  relations: Array<{ source: string; target: string; type?: string }>
  entityToBlocksIndex: Map<string, Set<string>>
  communityReports?: any[]
  communityResult?: { assignments?: Map<string, number>; count?: number }
  /** 文件级摘要索引（方案B：独立于切片的文件粒度数据，file_score 消费） */
  fileIndex?: FileSummaryIndex
  /** 问题增强索引：blockId → 该切片关联的问题向量（Q 增强通道；问题只存问题库，不再写回切片） */
  questionVectorsByBlock?: Map<string, number[][]>
  config: RetrievalConfig
  services: RetrievalServices
}

export interface MatchedEntity {
  name: string
  confidence: number
}

/** 异构图推理节点（方案C：实体 → 切片 → 文件 回链） */
export interface HeteroHopNode {
  type: 'slice' | 'file'
  id: string
  name: string
  hop: number
  path: string[]
  viaRelation: string
}

export interface PrimitiveResult {
  /** blockId → score（dense_score=基础分；boost=乘数，由管线按 mode 处理） */
  scores?: Map<string, number>
  /** blockId → 分解分明细（切片/问题/文件 原始通道分，供结果分项展示；与总分分离，不影响排序）
   * hasQ / hasFile：该切片是否携带对应增强通道（缺失时下游按「切片分兜底」归一化） */
  details?: Map<string, { sliceScore?: number; questionScore?: number; fileScore?: number; bm25Score?: number; hasQ?: boolean; hasFile?: boolean }>
  evidence?: Evidence[]
  matchedEntities?: MatchedEntity[]
  communityEntities?: string[]
  hopNodes?: Array<{ id: string; name: string; hop: number; path: string[]; viaRelation: string }>
  heteroNodes?: HeteroHopNode[]
  paths?: string[]
  heteroPaths?: string[]
  boostStats?: { boostedCount: number; detail: string }
  llmCalls?: number
}

/** 管线执行过程中的共享状态（前序原语的结果供后续原语消费） */
export interface PipelineState {
  matchedEntities?: MatchedEntity[]
  communityEntities?: string[]
  hopNodes?: any[]
  heteroNodes?: HeteroHopNode[]
  paths?: string[]
  heteroPaths?: string[]
}

/** 文件级摘要索引条目（方案B） */
export interface FileSummaryEntry {
  /** 文件摘要文本 */
  content: string
  /** 摘要向量 */
  vector?: number[]
  /** 文件内容指纹（用于幂等/增量判定） */
  contentHash?: string
}

/** 文件级摘要索引：filePath → 摘要条目 */
export type FileSummaryIndex = Map<string, FileSummaryEntry>

/** 索引增强原语上下文（构建/处理阶段） */
export interface IngestionContext {
  blocks: any[]
  config: {
    url: string
    embed: string
    chat: string
    process: string
    /** 语义增强提示词（semantic_enhance 生成增强语义文本用） */
    processPrompt: string
    /** 文件摘要提示词（summarize_file 生成文件摘要用，可选） */
    fileSummaryPrompt?: string
    think?: boolean
  }
  services: {
    embed(text: string): Promise<number[] | undefined>
    streamChat(messages: any[], onChunk: (chunk: string) => void): Promise<string>
    /** 把推理摘要回写到文件（可选；提供后 summarize_file 会把摘要写回 YAML frontmatter 实现持久化） */
    syncFileSummary?(filePath: string, summary: string): Promise<boolean>
  }
  /** 文件级摘要索引（summarize_file 写入） */
  fileIndex?: FileSummaryIndex
  /** 问题库（问题语义增强：为缺向量的问题补全 qVector；直接改动问题对象即生效） */
  questions?: any[]
  onProgress?: (msg: string) => void
  isCancelled?: () => boolean
}

// ========== 查询时原语 ==========

/**
 * dense_score：稠密 + BM25 混合打分
 * 两个语义通道：问题增强得分（由问题库经 questionVectorsByBlock 索引关联到切片，取 max）
 * 与切片得分（A_vector），由增强权重 summaryWeight 分配（切片权重 = 1 - summaryWeight）。
 * 步骤参数：summaryWeight（增强权重，覆盖全局默认）、bm25Enabled/bm25Weight（BM25）。
 */
export async function denseScore(ctx: RetrievalContext, params: any = {}): Promise<PrimitiveResult> {
  const { blocks, config, services } = ctx
  const queryEmbedding = await embedQuery(ctx)

  const documents = blocks.map((b: any) => b.A || '')
  const bm25Enabled = params.bm25Enabled ?? config.bm25Enabled
  const bm25Scores = bm25Enabled ? services.computeBM25(ctx.query, documents, params.bm25K1 ?? config.bm25K1, params.bm25B ?? config.bm25B) : []

  const SUMMARY_WEIGHT = params.summaryWeight ?? config.summaryWeight
  const SLICE_WEIGHT = 1 - SUMMARY_WEIGHT
  const BM25_WEIGHT = params.bm25Weight ?? config.bm25Weight
  const COSINE_WEIGHT = bm25Enabled ? 1 - BM25_WEIGHT : 1

  const scores = new Map<string, number>()
  // 分解分（切片/问题 原始通道分）：随 scores 一并回传，管线累积到 meta 供结果分项展示（不影响排序）
  const details = new Map<string, { sliceScore: number; questionScore: number; bm25Score: number; hasQ: boolean }>()
  blocks.forEach((b: any, i: number) => {
    let enhanceScore = 0
    let sliceScore = 0
    // 该切片是否携带可用的问题增强通道（问题库索引中确有该切片的关联问题向量）。
    // 仅当增强权重 >0 且确有问题增强索引时才评估 Q 通道；
    // summaryWeight=0 时增强对总分为零贡献，跳过可避免「相似度」等纯切片策略白跑问题向量余弦（大幅提速）
    let hasQ = false
    if (SUMMARY_WEIGHT > 0 && queryEmbedding && ctx.questionVectorsByBlock?.size) {
      // 问题增强通道（Q）：增强分 = 与 query 最大相似度的「该切片关联问题」向量。
      // 问题向量来自问题库（computeBlockQuestionVectors 按 blockId 关联），不再冗余存于切片。
      const cand: number[][] = ctx.questionVectorsByBlock.get(b.id) || []
      hasQ = cand.length > 0
      for (const v of cand) {
        try {
          const s = services.cosineSimilarity(queryEmbedding, v)
          if (s > enhanceScore) enhanceScore = s
        } catch { /* 单条失败忽略 */ }
      }
    }
    if (b.A_vector && queryEmbedding) {
      try { sliceScore = services.cosineSimilarity(queryEmbedding, b.A_vector) } catch { sliceScore = 0 }
    }
    const bm25Score = bm25Enabled ? (bm25Scores[i] || 0) : 0

    // 归一化兜底（方案 A）：该切片没有关联问题（问题增强通道缺失，问题得分恒为 0）时，
    // 把增强权重让渡给切片本体分（等效 summaryWeight=0，总分≈切片相似度），
    // 避免无 Q 的高相关切片被 (1-summaryWeight)×s 稀释而挤出 topK、拖累「问题增强/本体/多跳」等策略的召回。
    // 有 Q 的切片仍按策略既定加权（SUMMARY_WEIGHT×q + SLICE_WEIGHT×s），与历史评测可比。
    const useEnhance = SUMMARY_WEIGHT > 0 && hasQ
    const effSummary = useEnhance ? SUMMARY_WEIGHT : 0
    const effSlice = useEnhance ? SLICE_WEIGHT : 1
    const cosineScore = effSummary * enhanceScore + effSlice * sliceScore
    const p = bm25Enabled ? COSINE_WEIGHT * cosineScore + BM25_WEIGHT * bm25Score : cosineScore
    scores.set(b.id, p)
    details.set(b.id, { sliceScore, questionScore: enhanceScore, bm25Score, hasQ })
  })

  return { scores, details }
}

/**
 * entity_link：查询 → 本体实体匹配（三方融合）
 * 1. 字符串模糊匹配（matchEntitiesFromQuery）
 * 2. 语义实体链接（查询向量 vs 实体 name+description 向量，向量按实体缓存）
 * 3. LLM 辅助匹配（零命中/低置信时兜底，携带实体描述）
 */
export async function entityLink(ctx: RetrievalContext): Promise<PrimitiveResult> {
  const { entities, services, config } = ctx
  const matched: MatchedEntity[] = []
  const seen = new Set<string>()

  // 1. 字符串模糊匹配
  try {
    const nameMap = new Map<string, any>()
    for (const e of entities) nameMap.set(e.name.toLowerCase(), e)
    const fuzzyNames = matchEntitiesFromQuery(ctx.query, nameMap)
    for (const n of fuzzyNames) {
      if (!seen.has(n)) { seen.add(n); matched.push({ name: n, confidence: 1 }) }
    }
  } catch { /* 忽略模糊匹配失败 */ }

  // 2. 语义实体链接（实体数过多时跳过，避免嵌入开销爆炸）
  if (entities.length > 0 && entities.length <= 300) {
    try {
      const qv = await embedQuery(ctx)
      const candidates: MatchedEntity[] = []
      for (const e of entities) {
        // 模块级缓存：实体对象每次由 getCurrentOntologyContext() 重建，_vec 不可靠，
        // 以「name + description」为 key 跨查询共享，避免每个查询对全部实体重新嵌入
        const cacheKey = (e.description ? `${e.name}\u0000${e.description}` : e.name).toLowerCase()
        let vec = (e as any)._vec || entityVectorCache.get(cacheKey)
        if (!vec) {
          vec = await services.embed(e.description ? `${e.name} ${e.description}` : e.name)
          entityVectorCache.set(cacheKey, vec)
          ;(e as any)._vec = vec
        }
        if (vec && qv) {
          const sim = services.cosineSimilarity(qv, vec)
          // 阈值从 0.32 放宽到 0.26：提升实体链接覆盖率（配合 boost 的 minBaseScore 门槛抑制假阳性误伤）
          if (sim > 0.26) candidates.push({ name: e.name, confidence: sim })
        }
      }
      candidates.sort((a, b) => b.confidence - a.confidence)
      for (const c of candidates.slice(0, 6)) {
        if (!seen.has(c.name)) { seen.add(c.name); matched.push(c) }
      }
    } catch { /* 忽略语义匹配失败 */ }
  }

  // 3. LLM 辅助匹配（携带描述提升语义判断）：零命中或仅有低置信匹配（<0.5）时兜底复核
  //    语义匹配误命中错误实体（confidence 偏低）时也触发 LLM，避免带着错误实体直接 boost
  if (config.process && (matched.length === 0 || matched.every(m => m.confidence < 0.5))) {
    try {
      const entityList = entities.map(e => e.description ? `${e.name}（${e.description.slice(0, 60)}）` : e.name)
      const prompt = buildQueryEntityMatchPrompt({ query: ctx.query, entityNames: entityList, language: config.locale })
      const resp = await services.chat([{ role: 'user', content: prompt }])
      const jsonMatch = resp.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        for (const name of (parsed.matchedEntities || [])) {
          const key = String(name).toLowerCase()
          const ent = entities.find(e => e.name.toLowerCase() === key)
          if (ent && !seen.has(ent.name)) { seen.add(ent.name); matched.push({ name: ent.name, confidence: 0.7 }) }
        }
      }
      return { matchedEntities: matched, llmCalls: 1 }
    } catch { /* 忽略 LLM 匹配失败 */ }
  }

  return { matchedEntities: matched }
}

/**
 * graph_hop：种子实体 → BFS 多跳扩展（关系图遍历）
 * 输出：跳数衰减的邻居实体、推理路径、关联切片证据。
 */
export async function graphHop(
  ctx: RetrievalContext,
  params: { hops?: number; maxPerHop?: number } = {},
  state: PipelineState = {},
): Promise<PrimitiveResult> {
  const seeds = state.matchedEntities || []
  const seedNames = seeds.map((m: MatchedEntity) => m.name)
  const nameToEntity = new Map(ctx.entities.map(e => [e.name.toLowerCase(), e]))
  const seedEntities: Array<{ id: string; name: string }> = []
  for (const m of seeds) {
    const ent = nameToEntity.get(m.name.toLowerCase())
    if (ent) seedEntities.push({ id: ent.id, name: ent.name })
  }
  if (seedEntities.length === 0) return { hopNodes: [], paths: [] }

  const expansion = multiHopExpand({
    seedEntities,
    entities: ctx.entities.map(e => ({ id: e.id, name: e.name })),
    relations: ctx.relations.map(r => ({ source: r.source, target: r.target, type: r.type || 'related_to' })),
    maxHops: params.hops ?? 2,
    maxPerHop: params.maxPerHop ?? 5,
  })

  // 异构回链（方案C）：实体 → 切片 → 文件，使图推理融合切片与文件节点
  const heteroNodes: HeteroHopNode[] = []
  const heteroPaths: string[] = []
  const seenSlice = new Set<string>()
  const seenFile = new Set<string>()
  for (const node of expansion.allNodes) {
    const bid = ctx.entityToBlocksIndex.get(node.name.toLowerCase())
    if (!bid || bid.size === 0) continue
    for (const id of bid) {
      const b = ctx.blocks.find(x => x.id === id)
      if (!b) continue
      if (!seenSlice.has(id)) {
        seenSlice.add(id)
        const sliceLabel = b.label || id
        heteroNodes.push({ type: 'slice', id, name: sliceLabel, hop: node.hop, path: [...node.path, `切片「${sliceLabel}」`], viaRelation: 'mentions' })
        heteroPaths.push(`${node.path.join(' → ')} → 切片「${sliceLabel}」`)
      }
      if (b.filePath && !seenFile.has(b.filePath)) {
        seenFile.add(b.filePath)
        const fname = basename(b.filePath)
        heteroNodes.push({ type: 'file', id: b.filePath, name: fname, hop: node.hop, path: [...node.path, `文件「${fname}」`], viaRelation: 'belongs_to' })
        heteroPaths.push(`${node.path.join(' → ')} → 文件「${fname}」`)
      }
    }
  }

  return {
    hopNodes: expansion.allNodes,
    heteroNodes,
    paths: expansion.paths.slice(0, 10),
    heteroPaths: heteroPaths.slice(0, 10),
  }
}

/** 取路径最后一段作为文件名 */
function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/**
 * community_select：匹配实体 → 所在社区的全部实体
 * 优先使用社区检测结果（assignments: entityId → communityId），否则用关系连通分量兜底。
 */
export async function communitySelect(ctx: RetrievalContext, params?: any, state: PipelineState = {}): Promise<PrimitiveResult> {
  const seeds = state.matchedEntities || []
  const seedNames = seeds.map((m: MatchedEntity) => m.name)
  if (seedNames.length === 0) return { communityEntities: [] }

  const assign = ctx.communityResult?.assignments
  if (assign && assign.size > 0) {
    const nameToId = new Map(ctx.entities.map(e => [e.name, e.id]))
    const commIds = new Set<string>()
    for (const n of seedNames) {
      const id = nameToId.get(n) || n
      const cid = assign.get(id)
      if (cid !== undefined) commIds.add(String(cid))
    }
    if (commIds.size > 0) {
      const names = ctx.entities
        .filter(e => commIds.has(String(assign.get(e.id))))
        .map(e => e.name)
      if (names.length) return { communityEntities: names }
    }
  }

  // 连通分量兜底
  const adj = new Map<string, string[]>()
  for (const rel of ctx.relations) {
    if (!rel.source || !rel.target) continue
    if (!adj.has(rel.source)) adj.set(rel.source, [])
    if (!adj.has(rel.target)) adj.set(rel.target, [])
    adj.get(rel.source)!.push(rel.target)
    adj.get(rel.target)!.push(rel.source)
  }
  const visited = new Set<string>(seedNames)
  const result = new Set<string>()
  const queue = [...seedNames]
  while (queue.length) {
    const cur = queue.shift()!
    result.add(cur)
    for (const nb of adj.get(cur) || []) {
      if (!visited.has(nb)) { visited.add(nb); queue.push(nb) }
    }
  }
  return { communityEntities: Array.from(result) }
}

/**
 * boost：对关联切片做分数提升
 * source: 'entity' 使用匹配实体；'hop' 使用跳数衰减；'community' 使用社区实体。
 * boostWeight: 提升倍率（步骤级参数，默认 1.5）。
 * 返回 scores = 每块的乘数（管线按 mode='multiply' 应用）。
 */
export async function boost(
  ctx: RetrievalContext,
  params: { source: 'entity' | 'hop' | 'community'; boostWeight?: number },
  state: PipelineState = {},
): Promise<PrimitiveResult> {
  const { entityToBlocksIndex, blocks } = ctx
  const boostWeight = params.boostWeight ?? 1.5
  const blockBoost = new Map<string, number>()
  const detail: string[] = []
  const paths: string[] = state.paths || []

  if (params.source === 'hop' && ((state.hopNodes && state.hopNodes.length) || (state.heteroNodes && state.heteroNodes.length))) {
    const HOP_WEIGHTS = [1.0, 0.6, 0.3, 0.15]
    // 实体 hop 提升（原有多跳回链）
    for (const node of state.hopNodes || []) {
      const bid = entityToBlocksIndex.get(node.name.toLowerCase())
      if (!bid || bid.size === 0) continue
      // 倍率至少为 1：hop 越远权重越低，但不允许降权（保持 boost 语义）
      const w = Math.max(1, (HOP_WEIGHTS[node.hop] ?? 0.1) * boostWeight)
      for (const id of bid) blockBoost.set(id, Math.max(blockBoost.get(id) || 0, w))
      detail.push(`${node.name}(hop${node.hop}×${w.toFixed(2)})`)
    }
    // 异构回链提升（方案C）：切片直接提升 + 文件内扩展谨慎降权
    const fileToBlocks = new Map<string, string[]>()
    for (const b of blocks) {
      if (!b.filePath) continue
      if (!fileToBlocks.has(b.filePath)) fileToBlocks.set(b.filePath, [])
      fileToBlocks.get(b.filePath)!.push(b.id)
    }
    for (const node of state.heteroNodes || []) {
      const w = Math.max(1, (HOP_WEIGHTS[node.hop] ?? 0.1) * boostWeight)
      if (node.type === 'slice') {
        blockBoost.set(node.id, Math.max(blockBoost.get(node.id) || 0, w))
        detail.push(`${node.name}(hop${node.hop}×${w.toFixed(2)})`)
      } else if (node.type === 'file') {
        // 文件相关 ≠ 切片相关：文件内扩展使用更保守的权重（0.6），避免 precision 崩
        const fw = Math.max(1, w * 0.6)
        for (const id of fileToBlocks.get(node.id) || []) {
          blockBoost.set(id, Math.max(blockBoost.get(id) || 0, fw))
        }
        detail.push(`${node.name}(hop${node.hop}×${fw.toFixed(2)})`)
      }
    }
  } else {
    const names = params.source === 'community'
      ? (state.communityEntities || [])
      : (state.matchedEntities || []).map(m => m.name)
    for (const n of names) {
      const bid = entityToBlocksIndex.get(n.toLowerCase())
      if (bid && bid.size > 0) {
        for (const id of bid) blockBoost.set(id, Math.max(blockBoost.get(id) || 0, boostWeight))
        detail.push(`${n}(×${boostWeight})`)
      } else {
        // 兜底：文本匹配
        for (const b of blocks) {
          if ((b.A && b.A.toLowerCase().includes(n.toLowerCase())) ||
              (b.Q && b.Q.toLowerCase().includes(n.toLowerCase()))) {
            blockBoost.set(b.id, Math.max(blockBoost.get(b.id) || 0, boostWeight))
          }
        }
      }
    }
  }

  const scores = new Map<string, number>()
  for (const [id, w] of blockBoost) scores.set(id, w)
  return {
    scores,
    paths,
    boostStats: { boostedCount: blockBoost.size, detail: detail.join(', ') },
  }
}

/** 查询时原语注册表 */
export const RETRIEVAL_PRIMITIVES: Record<RetrievalPrimitiveId, (ctx: RetrievalContext, params?: any, state?: PipelineState) => Promise<PrimitiveResult>> = {
  dense_score: (ctx, params) => denseScore(ctx, params),
  entity_link: (ctx) => entityLink(ctx),
  graph_hop: (ctx, params, state) => graphHop(ctx, params, state),
  community_select: (ctx, params, state) => communitySelect(ctx, params, state),
  file_score: (ctx, params) => fileScore(ctx, params),
  boost: (ctx, params, state) => boost(ctx, params, state),
}

/**
 * file_score：文件级语义打分（查询向量 vs 文件摘要向量）
 * 每个切片得分 = 其所属文件的摘要向量与查询向量的余弦相似度。
 * 通过管线 mode 与 dense_score 融合（weighted 加权求和 / max 取最大 / multiply 乘性提升）。
 */
export async function fileScore(ctx: RetrievalContext, params?: any): Promise<PrimitiveResult> {
  const { blocks, services } = ctx
  const fileIndex = ctx.fileIndex
  const scores = new Map<string, number>()
  if (!fileIndex || fileIndex.size === 0) return { scores }
  const queryEmbedding = await embedQuery(ctx)
  const vecCache = new Map<string, number[] | undefined>()
  // 分解分（文件 原始通道分）：随 scores 一并回传，供结果分项展示
  const details = new Map<string, { fileScore: number; hasFile: boolean }>()
  for (const b of blocks) {
    if (!b?.filePath) continue
    if (!vecCache.has(b.filePath)) {
      const entry = fileIndex.get(b.filePath)
      vecCache.set(b.filePath, entry?.vector || undefined)
    }
    const vec = vecCache.get(b.filePath)
    const hasFile = !!vec
    let s = 0
    if (vec && queryEmbedding) {
      try { s = services.cosineSimilarity(queryEmbedding, vec) } catch { s = 0 }
    }
    scores.set(b.id, s)
    // hasFile：标记该切片是否有文件摘要向量（缺失时下游 UI 提示「切片分兜底」，本步骤为叠加型不惩罚 base）
    details.set(b.id, { fileScore: s, hasFile })
  }
  return { scores, details }
}

// ========== 索引增强原语 ==========

/** 文件摘要默认提示词（未配置 fileSummaryPrompt 时使用） */
const DEFAULT_FILE_SUMMARY_PROMPT = `请阅读下面的文件内容，提炼出该文件的摘要：概括核心主题、关键概念、主要观点与结论，并补充必要的事实与隐含信息，以便后续检索匹配。请用简洁连贯的段落输出摘要（200字以内），不要输出额外解释。\n\n文件内容：\n`

/** 计算文件切片的聚合指纹（用于文件摘要幂等/增量判定） */
function hashFileBlocks(fileBlocks: any[]): string {
  let h = 5381
  for (const b of fileBlocks) {
    const s = b?.contentHash || b?.A || ''
    for (let i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0 }
  }
  return String(h >>> 0)
}

/**
 * summarize_file：文件级语义增强（聚合摘要 + 向量，方案B）
 * 对每个文件（按 block.filePath 分组）用摘要提示词生成文件摘要并嵌入，写入 ctx.fileIndex，
 * 供检索原语 file_score 消费。三种处理：
 *   1) 已有摘要 + 向量 + 内容未变（contentHash 匹配）→ 完全复用（skipped++，不重算）
 *   2) 已有摘要文本但缺向量 / 内容已变 → 跳过 LLM，仅对已有摘要向量化（快速补向量）
 *   3) 无摘要 → 用 LLM 生成摘要再向量化（首次全量，慢）
 * 步骤参数：maxSlices（每文件最多聚合的切片数，默认 200）、maxChars（聚合文本截断，默认 30000 ——
 * 按文件开头顺序聚合切片，保证长文件摘要覆盖前约 30000 字）。
 */
export async function summarizeFile(
  ctx: IngestionContext,
  params: { maxSlices?: number; maxChars?: number; reuseExistingSummary?: boolean } = {},
): Promise<{ processed: number; failed: number; skipped?: number }> {
  const { blocks, config, services, onProgress, isCancelled } = ctx
  const fileIndex = ctx.fileIndex
  if (!fileIndex) return { processed: 0, failed: 0 }
  const maxSlices = params.maxSlices ?? 200
  const maxChars = params.maxChars ?? 30000
  const reuseExistingSummary = params.reuseExistingSummary ?? false

  const byPath = new Map<string, any[]>()
  for (const b of blocks) {
    if (!b?.filePath) continue
    if (!byPath.has(b.filePath)) byPath.set(b.filePath, [])
    byPath.get(b.filePath)!.push(b)
  }

  let processed = 0
  let failed = 0
  let skipped = 0
  let idx = 0
  for (const [filePath, fileBlocks] of byPath) {
    idx++
    if (isCancelled?.()) return { processed, failed, skipped }
    const contentHash = hashFileBlocks(fileBlocks)
    const existing = fileIndex.get(filePath)

    // 摘要 + 向量均已缓存且内容未变 → 完全复用（不重算、不向量化）
    if (existing?.content && existing.vector?.length && existing.contentHash === contentHash) {
      skipped++
      continue
    }

    // 已有摘要文本：跳过 LLM 生成，仅对已有摘要向量化（补 vector）。
    // reuseExistingSummary=true（预热）：只要有摘要就只向量化（即使内容已变）；
    // 默认（管线/增量）：仅当内容未变时复用摘要补向量，内容变了则重新生成摘要。
    const hasSummary = reuseExistingSummary
      ? !!(existing?.content)
      : (!!(existing?.content) && existing.contentHash === contentHash)
    let summary = existing?.content || ''
    let fileText = ''
    if (!hasSummary) {
      // 按文件开头顺序聚合切片文本，累计到覆盖 maxChars（默认前约 30000 字）为止；
      // maxSlices 仅作保险上限，避免异常超多切片拖慢。聚合后再按 maxChars 截断。
      let picked = 0
      let textLen = 0
      const samples: string[] = []
      for (const b of fileBlocks) {
        if (picked >= maxSlices || textLen >= maxChars) break
        const t = b.A || ''
        if (!t) continue
        samples.push(t)
        picked++
        textLen += t.length
      }
      fileText = samples.join('\n\n')
      if (!fileText.trim()) continue
      if (fileText.length > maxChars) fileText = fileText.slice(0, maxChars)
      onProgress?.(`文件摘要: ${idx}/${byPath.size} ${filePath.split(/[\\/]/).pop()}`)
    } else {
      onProgress?.(`文件摘要: ${idx}/${byPath.size} ${filePath.split(/[\\/]/).pop()}（仅向量化）`)
    }

    try {
      if (!hasSummary) {
        summary = await services.streamChat(
          [{ role: 'user', content: (config.fileSummaryPrompt || DEFAULT_FILE_SUMMARY_PROMPT) + fileText }],
          () => {},
        )
      }
      const vec = await services.embed(summary)
      fileIndex.set(filePath, { content: summary, vector: vec || undefined, contentHash })
      processed++
      // 仅新生成摘要时才回写 frontmatter（仅向量化时文件内容未变，避免误触发增量检测）
      if (!hasSummary) {
        // 回写文件 frontmatter 实现持久化（可选服务；失败仅记录，不影响主流程）
        try {
          const ok = await services.syncFileSummary?.(filePath, summary)
          if (ok === false) console.warn(`文件摘要回写失败: ${filePath}`)
        } catch (e) {
          console.warn('文件摘要回写异常:', filePath, e)
        }
      }
    } catch (error) {
      console.error('summarize_file 失败:', error)
      failed++
    }
  }
  return { processed, failed, skipped }
}

/**
 * semantic_enhance → 问题语义增强（方案 A：切片「语义增强」迁移到问题库）
 * 说明：检索的 Q 增强通道已由问题库承载（每条问题独立向量，经问题→切片关联索引消费）。
 * 本原语职责：
 *  1) 清理切片遗留的旧 Q/Q_vector/Q_vectors 字段（兼容旧「问题存切片」格式）；
 *  2) 问题语义增强：为问题库中「有文本但缺向量」的活动问题补全问题向量（Q 增强通道数据源），
 *     是「问题增强」检索策略的依赖处理管线（跑管线后自动保证问题向量就绪）。
 * 幂等：已有向量的问题跳过。
 */
export async function semanticEnhance(ctx: IngestionContext): Promise<{ processed: number; failed: number }> {
  const { blocks, questions, services, onProgress, isCancelled } = ctx
  // 1) 清理切片遗留旧问题字段（不再使用「问题存切片」格式）
  let cleaned = 0
  for (const b of blocks || []) {
    if (!b) continue
    if (b.Q !== undefined || b.Q_vector !== undefined || b.Q_vectors !== undefined) {
      delete b.Q
      delete b.Q_vector
      delete b.Q_vectors
      cleaned++
    }
  }
  // 2) 问题语义增强：为缺向量的问题补全向量（问题文本 → 向量）
  let processed = 0
  let failed = 0
  const qs = questions || []
  for (const q of qs) {
    if (isCancelled?.()) break
    if (q.status === 'merged') continue
    const t = q.text ? String(q.text).trim() : ''
    if (!t) continue
    if (q.qVector && q.qVector.length) continue
    try {
      const v = await services.embed(t)
      if (v && v.length) { q.qVector = v; processed++ }
    } catch (e) { console.warn('问题语义增强失败:', String(t).slice(0, 40), e); failed++ }
  }
  if (processed > 0) {
    onProgress?.(`问题语义增强：为 ${processed} 个问题生成向量（失败 ${failed}）`)
  } else {
    onProgress?.(cleaned > 0
      ? `问题语义增强：已清理 ${cleaned} 个切片的旧问题字段；问题向量均已就绪`
      : '问题语义增强：问题向量均已就绪，无需补充')
  }
  return { processed, failed }
}

/**
 * extract_entities：切片 → 本体实体/关系抽取（结构化增强）
 * 占位实现：完整逻辑在 knowRAG 的 startBuildOntology 中（本原语先注册供 UI 展示，执行接入为后续步骤）。
 */
export async function extractEntities(ctx: IngestionContext): Promise<{ processed: number; failed: number }> {
  const { onProgress } = ctx
  onProgress?.('本体推理（extract_entities）：请在「本体」页执行完整构建')
  return { processed: 0, failed: 0 }
}

/**
 * build_communities：实体图 → 社区检测（Louvain）
 * 占位实现：完整逻辑在 knowRAG 中（注册供 UI 展示，执行接入为后续步骤）。
 */
export async function buildCommunities(ctx: IngestionContext): Promise<{ processed: number; failed: number }> {
  const { onProgress } = ctx
  onProgress?.('社区检测（build_communities）：请在「本体」页执行')
  return { processed: 0, failed: 0 }
}

/**
 * generate_reports：社区 → 社区报告（LLM 摘要）
 * 占位实现：完整逻辑在 knowRAG 中（注册供 UI 展示，执行接入为后续步骤）。
 */
export async function generateReports(ctx: IngestionContext): Promise<{ processed: number; failed: number }> {
  const { onProgress } = ctx
  onProgress?.('报告生成（generate_reports）：请在「本体」页执行')
  return { processed: 0, failed: 0 }
}

/** 索引增强原语注册表 */
export const INGESTION_PRIMITIVES: Record<IngestionPrimitiveId, (ctx: IngestionContext, params?: Record<string, any>) => Promise<unknown>> = {
  semantic_enhance: (ctx) => semanticEnhance(ctx),
  summarize_file: (ctx, params) => summarizeFile(ctx, params),
  extract_entities: (ctx) => extractEntities(ctx),
  build_communities: (ctx) => buildCommunities(ctx),
  generate_reports: (ctx) => generateReports(ctx),
}

/** 原语元数据（供配置 UI 展示） */
export const PRIMITIVE_META: Record<PrimitiveId, { label: string; labelEn: string; category: 'retrieval' | 'ingestion'; dimension: PrimitiveDimension; description: string; descriptionEn: string }> = {
  dense_score: {
    label: '稠密检索', labelEn: 'Dense Search', category: 'retrieval', dimension: 'base',
    description: '向量相似度 + BM25 混合打分（基础检索）', descriptionEn: 'Vector similarity + BM25 hybrid scoring (base retrieval)',
  },
  entity_link: {
    label: '实体链接', labelEn: 'Entity Link', category: 'retrieval', dimension: 'structural',
    description: '查询 → 本体实体匹配（字符串 + 语义 + LLM）', descriptionEn: 'Query to ontology entity matching (string + semantic + LLM)',
  },
  graph_hop: {
    label: '图谱多跳', labelEn: 'Graph Hop', category: 'retrieval', dimension: 'structural',
    description: '种子实体沿关系边 BFS 扩展，输出推理路径', descriptionEn: 'BFS expansion from seed entities over relations, outputs reasoning paths',
  },
  community_select: {
    label: '社区选择', labelEn: 'Community Select', category: 'retrieval', dimension: 'structural',
    description: '匹配实体所在社区的全部实体（全局上下文）', descriptionEn: 'All entities in the communities of matched entities (global context)',
  },
  boost: {
    label: '分数提升', labelEn: 'Score Boost', category: 'retrieval', dimension: 'structural',
    description: '对关联切片做乘性分数提升（实体/跳数/社区）', descriptionEn: 'Multiplicative score boost for linked slices (entity/hop/community)',
  },
  semantic_enhance: {
    label: '问题语义增强', labelEn: 'Question Semantic Enhance', category: 'ingestion', dimension: 'semantic',
    description: '为问题库缺失向量的问题生成问题向量（Q 增强通道；「问题增强」策略的依赖处理管线）', descriptionEn: 'Embed missing question vectors in the question bank (Q-enhancement channel; dependency pipeline for the Question strategy)',
  },
  summarize_file: {
    label: '文件语义增强', labelEn: 'File Semantic Enhance', category: 'ingestion', dimension: 'semantic',
    description: '文件→聚合摘要→摘要向量（文件级语义增强，写入 fileIndex）', descriptionEn: 'File to aggregated summary vector (file-level semantic enhancement, writes fileIndex)',
  },
  file_score: {
    label: '文件打分', labelEn: 'File Score', category: 'retrieval', dimension: 'semantic',
    description: '查询 vs 文件摘要向量的相似度（文件级打分）', descriptionEn: 'Query vs file summary vector similarity (file-level scoring)',
  },
  extract_entities: {
    label: '本体推理', labelEn: 'Extract Entities', category: 'ingestion', dimension: 'structural',
    description: '切片 → 本体实体/关系抽取（结构化增强）', descriptionEn: 'Slice to ontology entities/relations (structural enhancement)',
  },
  build_communities: {
    label: '社区检测', labelEn: 'Build Communities', category: 'ingestion', dimension: 'structural',
    description: '实体图 → 社区检测（Louvain）', descriptionEn: 'Entity graph to communities (Louvain)',
  },
  generate_reports: {
    label: '报告生成', labelEn: 'Generate Reports', category: 'ingestion', dimension: 'structural',
    description: '社区 → 社区报告（LLM 摘要）', descriptionEn: 'Communities to community reports (LLM summary)',
  },
}
