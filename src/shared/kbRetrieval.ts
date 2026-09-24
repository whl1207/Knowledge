// src/shared/kbRetrieval.ts
import { runStrategy, getStrategies } from '@/shared/graphrag/strategy'
import type { RetrievalContext } from '@/shared/graphrag/primitives'
import * as kbAi from '@/shared/kbAiClient'
import type { KbModelSpec, KbProvider } from '@/shared/kbAiClient'
import { effectiveEmbedSpec } from '@/shared/kbAiClient'
import { computeBlockQuestionVectors } from '@/shared/kbQuestions'
import type { KbQuestion } from '@/shared/kbQuestions'

// ==================== 类型定义 ====================

export interface KnowledgeBlock {
  filePath: string
  label: string
  content: string
  A_vector?: number[]
  [key: string]: any
}

export interface FileSummaryInfo {
  content: string
  vector?: number[]
}

export interface RetrievalOptions {
  /** 召回的文件数量（默认：5） */
  topK?: number
  /** 摘要的权重（0-1，默认：0.7） */
  summaryWeight?: number
  /** 模型来源（默认：ollama；不传 providerConfig 时使用 ollamaHost） */
  llmType?: KbProvider
  /** 来源连接配置（默认：{ model_url: ollamaHost }） */
  providerConfig?: any
  /** Ollama服务地址（默认：http://127.0.0.1:11434；仅 llmType=ollama 时使用） */
  ollamaHost?: string
  /** 嵌入模型（默认：优先使用知识库中的模型） */
  embedModel?: string
  /** 对话/处理模型（策略管线需要；默认取嵌入模型名） */
  chatModel?: string
  processModel?: string
  /** 是否返回调试信息（默认：false） */
  debug?: boolean
  /** 模型缺失时的处理策略：'error' 抛出错误，'fallback' 使用回退模型（默认：'error'） */
  missingModelStrategy?: 'error' | 'fallback'
  /** 回退嵌入模型列表（按优先级） */
  fallbackModels?: string[]
  /** 当前来源无嵌入模型时回退的 Ollama 配置（{ model_url, embed_model }；缺省用 ollamaHost + fallbackModels[0]） */
  embedFallbackConfig?: any
  /** 回退嵌入模型名（覆盖 embedFallbackConfig.embed_model / fallbackModels[0]） */
  embedFallbackModel?: string
  /** 嵌入兜底来源类型（默认 ollama，兼容旧调用） */
  embedFallbackType?: KbProvider
  /** 嵌入兜底来源的连接配置（不同来源字段不同；缺省时按 ollama 旧形态处理） */
  embedFallbackProviderConfig?: any
  /** 检索策略 id（来自 RAG 策略配置注册表；未知/未配置时退化为 'similarity'） */
  strategy?: string
}

export interface RelevantBlock {
  label: string
  content: string
  similarity: number
  summaryScore?: number
  sliceScore?: number
}

export interface RetrievalResult {
  /** 由最相关的知识片段组成的文本 */
  context: string
  /** 相关片段详细信息 */
  relevantBlocks: RelevantBlock[]
  /** 实际使用的嵌入模型 */
  usedEmbedModel: string
  /** 调试信息（仅在debug=true时返回） */
  debugInfo?: {
    config: RetrievalOptions
    knowledgeBaseModel?: string
    totalBlocks: number
    selectedCount: number
    similarityStats: {
      min: number
      max: number
      avg: number
    }
  }
}

export interface KnowledgeBaseConfig {
  embedModel?: string
  timestamp?: string
  version?: string
  summaryWeight?: number
  sliceWeight?: number
  [key: string]: any
}

export interface KnowledgeBaseData {
  config?: KnowledgeBaseConfig
  blocks: KnowledgeBlock[]
  fileSummaries?: Record<string, FileSummaryInfo>
  fileIndex?: Record<string, { content: string; vector?: number[]; contentHash?: string }>
  ontology?: any
  communityReports?: any[]
  communityResult?: any
  /** 问题库（方案 A：问题只存此处，每条带独立向量与关联切片引用） */
  questions?: KbQuestion[]
}

// ==================== 错误类定义 ====================

export class ModelNotAvailableError extends Error {
  constructor(
    public requestedModel: string,
    public availableModels: string[],
    message = `嵌入模型 "${requestedModel}" 不可用`
  ) {
    super(message)
    this.name = 'ModelNotAvailableError'
  }
}

export class KnowledgeBaseFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KnowledgeBaseFormatError'
  }
}

// ==================== 精简模式：向量缺失懒补全（会话内缓存） ====================
// .kb 若未保存向量数据（config.saveVectors=false），首次问答需按当前嵌入模型重新推导向量，
// 否则所有切片相似度都为 0、检索退化。以下缓存保证同一会话内只推导一次，后续问答直接复用；
// 不做跨会话持久化（app 重启后首个问答再次推导，符合「不存向量精简 KB」的语义）。
const blockVecSessionCache = new Map<string, number[]>()
const summaryVecSessionCache = new Map<string, number[]>()
const fileIndexVecSessionCache = new Map<string, number[]>()
const questionVecSessionCache = new Map<string, number[]>()

/** 简单内容哈希（仅作缓存 key；文本相同 → key 相同 → 共享向量，语义等价） */
function textHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return String(h >>> 0)
}

/** 为缺失 A_vector 的切片批量补全向量（BATCH=16，复用会话缓存）。仅改内存对象，不写回 .kb */
async function ensureMissingBlockVectors(blocks: KnowledgeBlock[], spec: KbModelSpec): Promise<number> {
  const missing: { block: KnowledgeBlock; key: string; text: string }[] = []
  for (const b of blocks) {
    if (!b) continue
    if (b.A_vector && b.A_vector.length > 0) continue
    const text = typeof b.A === 'string' ? b.A : ''
    if (!text.trim()) continue
    const key = `${spec.embed || ''}\u0000${b.contentHash ? String(b.contentHash) : textHash(text)}`
    const cached = blockVecSessionCache.get(key)
    if (cached) {
      b.A_vector = cached
      continue
    }
    missing.push({ block: b, key, text })
  }
  if (!missing.length) return 0

  const BATCH = 16
  let embedded = 0
  for (let start = 0; start < missing.length; start += BATCH) {
    const batch = missing.slice(start, start + BATCH)
    try {
      const embs = await kbAi.embed(spec, batch.map(x => x.text))
      for (let j = 0; j < batch.length; j++) {
        const vec = embs?.[j]
        if (!vec || !vec.length) continue
        batch[j].block.A_vector = vec
        blockVecSessionCache.set(batch[j].key, vec)
        embedded++
      }
    } catch (error) {
      console.warn(`切片向量懒补全失败（第 ${start + 1}-${Math.min(start + BATCH, missing.length)} 个）:`, error)
    }
  }
  return embedded
}

/** 为缺失的文件级摘要索引向量懒补全（供 file_search / file_score 通道消费） */
async function ensureMissingFileIndexVectors(fileIndex: Map<string, any>, spec: KbModelSpec): Promise<number> {
  if (!fileIndex || fileIndex.size === 0) return 0
  const missing: { path: string; entry: any; key: string; content: string }[] = []
  for (const [path, entry] of fileIndex) {
    if (!entry) continue
    if (entry.vector && entry.vector.length > 0) continue
    const content = typeof entry.content === 'string' ? entry.content : ''
    if (!content.trim()) continue
    const key = `${spec.embed || ''}\u0000${path}`
    const cached = fileIndexVecSessionCache.get(key)
    if (cached) {
      entry.vector = cached
      continue
    }
    missing.push({ path, entry, key, content })
  }
  if (!missing.length) return 0

  const BATCH = 16
  let embedded = 0
  for (let start = 0; start < missing.length; start += BATCH) {
    const batch = missing.slice(start, start + BATCH)
    try {
      const embs = await kbAi.embed(spec, batch.map(x => x.content))
      for (let j = 0; j < batch.length; j++) {
        const vec = embs?.[j]
        if (!vec || !vec.length) continue
        batch[j].entry.vector = vec
        fileIndexVecSessionCache.set(batch[j].key, vec)
        embedded++
      }
    } catch (error) {
      console.warn(`文件摘要索引向量懒补全失败:`, error)
    }
  }
  return embedded
}

/** 为问题库中「有文本但缺 qVector」的活动问题补全向量（供问题增强/作答检索通道） */
async function ensureMissingQuestionVectors(questions: any[] | undefined, spec: KbModelSpec): Promise<number> {
  if (!questions || questions.length === 0) return 0
  const missing: { q: any; key: string; text: string }[] = []
  for (const q of questions) {
    if (!q || q.status === 'merged') continue
    if (q.qVector && q.qVector.length > 0) continue
    const text = q.text ? String(q.text).trim() : ''
    if (!text) continue
    const key = `${spec.embed || ''}\u0000${textHash(text)}`
    const cached = questionVecSessionCache.get(key)
    if (cached) {
      q.qVector = cached
      continue
    }
    missing.push({ q, key, text })
  }
  if (!missing.length) return 0

  const BATCH = 16
  let embedded = 0
  for (let start = 0; start < missing.length; start += BATCH) {
    const batch = missing.slice(start, start + BATCH)
    try {
      const embs = await kbAi.embed(spec, batch.map(x => x.text))
      for (let j = 0; j < batch.length; j++) {
        const vec = embs?.[j]
        if (!vec || !vec.length) continue
        batch[j].q.qVector = vec
        questionVecSessionCache.set(batch[j].key, vec)
        embedded++
      }
    } catch (error) {
      console.warn(`问题向量懒补全失败:`, error)
    }
  }
  return embedded
}

// ==================== 主函数 ====================

/**
 * 知识库检索函数
 * 
 * @param query 查询问题
 * @param kbPath 知识库文件路径
 * @param options 检索选项
 * @returns 返回知识库中最相关的片段组成的文本
 * 
 * @example
 * ```typescript
 * // 基本用法
 * const result = await retrieveKnowledge(
 *   "什么是机器学习？",
 *   "/path/to/knowledge.kb"
 * )
 * 
 * // 高级用法
 * const result = await retrieveKnowledge(
 *   "什么是深度学习？",
 *   "/path/to/knowledge.kb",
 *   {
 *     topK: 10,
 *     summaryWeight: 0.7,
 *     missingModelStrategy: 'fallback',
 *     fallbackModels: ['mxbai-embed-large:latest', 'nomic-embed-text:latest'],
 *     debug: true
 *   }
 * )
 * ```
 */
export async function retrieveKnowledge(
  query: string,
  kbPath: string,
  options: RetrievalOptions = {}
): Promise<RetrievalResult> {
  // 默认配置
  const config: Required<RetrievalOptions> = {
    topK: 5,
    summaryWeight: 0.7,
    llmType: 'ollama',
    providerConfig: undefined as any,
    ollamaHost: 'http://127.0.0.1:11434',
    embedModel: '', // 默认留空，由知识库决定
    chatModel: '',
    processModel: '',
    debug: false,
    missingModelStrategy: 'error',
    fallbackModels: ['nomic-embed-text:latest', 'all-minilm:latest'],
    embedFallbackConfig: undefined as any,
    embedFallbackModel: '',
    // 嵌入兜底来源：'ollama' 为历史默认（未配置时行为与旧版一致）
    embedFallbackType: 'ollama',
    embedFallbackProviderConfig: undefined as any,
    strategy: 'similarity',
    ...options
  }

  try {
    // 1. 加载知识库（包括配置信息）
    const { blocks, fileSummaries, fileIndex, kbConfig, ontology, communityReports, communityResult, questions } = await loadKnowledgeBase(kbPath)

    // 2. 组装统一模型规格（多来源：ollama / openai / deepseek / ...）
    const spec = buildSpecFromOptions(config)

    // 3. 确定使用的嵌入模型：显式指定 > 知识库(.kb)配置 > 当前来源默认嵌入模型 > 自动探测
    //    （home 等调用方优先使用 .kb 文件里记录的嵌入模型，保证与已存向量维度一致）
    //    当前来源未配置嵌入模型（如 DeepSeek）时，嵌入整体回退到 Ollama；聊天/处理仍用当前来源。
    const embedSpec = effectiveEmbedSpec(spec)
    const usingFallbackEmbed = embedSpec !== spec
    const preferredEmbed = usingFallbackEmbed
      ? (config.embedModel || kbConfig?.embedModel || embedSpec.embed || '')
      : (config.embedModel || kbConfig?.embedModel || spec.config?.embed_model || '')
    const effectiveEmbedModel = await determineEmbedModel(
      embedSpec,
      preferredEmbed,
      config.missingModelStrategy,
      config.fallbackModels
    )
    embedSpec.embed = effectiveEmbedModel
    spec.embed = effectiveEmbedModel
    if (!spec.chat) spec.chat = spec.config?.model || effectiveEmbedModel
    if (!spec.process) spec.process = spec.config?.model || spec.chat

    // 3.5 精简模式懒补全：.kb 未保存向量数据（config.saveVectors=false）时，首次问答按当前
    //     嵌入模型重新推导切片/问题/文件级摘要索引向量（会话内缓存）；已存向量的 KB 无缺失则零开销。
    await ensureMissingBlockVectors(blocks, embedSpec)
    await ensureMissingQuestionVectors(questions, embedSpec)
    await ensureMissingFileIndexVectors(fileIndex, embedSpec)

    // 4. 验证模型一致性（如果知识库中有存储向量）
    if (config.debug && kbConfig?.embedModel) {
      console.log(`知识库使用模型: ${kbConfig.embedModel}, 实际使用模型: ${effectiveEmbedModel}`)

      if (kbConfig.embedModel !== effectiveEmbedModel) {
        console.warn(`⚠️ 警告: 使用的嵌入模型(${effectiveEmbedModel})与知识库创建时的模型(${kbConfig.embedModel})不一致，向量维度可能不匹配，检索准确性将下降`)
      }
    }

    // 5. 计算查询向量
    const queryEmbeddings = await kbAi.embed(embedSpec, query)
    const queryEmbedding = queryEmbeddings?.[0]

    if (!queryEmbedding) {
      throw new Error('查询向量化失败')
    }

    // 6. 批量计算文件摘要向量
    const fileSummaryVectors = await computeFileSummaryVectors(
      fileSummaries,
      embedSpec
    )

    // 7. 依据检索策略执行：相似度走本地等价路径；其余走 RAG 策略框架（本体/多跳/社区/Agentic/自定义）；失败回退相似度
    const strategyId = resolveStrategyId(config.strategy)
    let context = ''
    let relevantBlocks: RelevantBlock[] = []
    let selectedCount = 0

    // 相似度路径：复用已计算的 queryEmbedding / fileSummaryVectors
    const runSimilarityFallback = () => {
      const scoredBlocks = calculateSimilarities(blocks, queryEmbedding, fileSummaryVectors, config, kbConfig)
      scoredBlocks.sort((a, b) => b.similarity - a.similarity)
      const top = scoredBlocks.slice(0, config.topK)
      context = buildContext(query, top)
      relevantBlocks = top.map(block => ({
        label: block.label,
        content: block.A,
        similarity: block.similarity,
        summaryScore: block.summaryScore,
        sliceScore: block.sliceScore
      }))
      selectedCount = top.length
    }

    if (strategyId === 'similarity') {
      runSimilarityFallback()
    } else {
      let sr: any = null
      // 仅 pipeline 类策略可在主页执行（mapreduce/agentic 需要聊天模型与完整社区上下文，主页回退相似度）
      const strategyDef = getStrategies().find(s => s.id === strategyId)
      const canRunStrategy = strategyDef && strategyDef.kind === 'pipeline'
      if (!canRunStrategy) {
        runSimilarityFallback()
      } else {
        try {
          const ctx = buildRetrievalContextFromKb({
            query, blocks, kbConfig, ontology, communityReports, communityResult, fileIndex, questions,
            spec, embedSpec, embedModel: effectiveEmbedModel, config,
          })
          sr = await runStrategy(strategyId, query, ctx, {})
        } catch (error) {
          console.warn(`策略框架检索失败（${strategyId}），回退相似度:`, error)
          sr = null
        }

        const hasResult = sr && sr.sortedBlocks && sr.sortedBlocks.length > 0
        if (!hasResult) {
          runSimilarityFallback()
        } else {
          const top = sr.sortedBlocks.slice(0, config.topK)
          context = buildContext(query, top)
          relevantBlocks = top.map((b: any) => ({
            label: b.label,
            content: b.A,
            similarity: sr.scores.get(b.id) || 0
          }))
          selectedCount = top.length
        }
      }
    }

    // 8. 准备返回结果
    const result: RetrievalResult = {
      context,
      relevantBlocks,
      usedEmbedModel: effectiveEmbedModel
    }

    // 9. 添加调试信息（如果需要）
    if (config.debug) {
      const sims = relevantBlocks.map(b => b.similarity)
      result.debugInfo = {
        config: { ...config, strategy: strategyId },
        knowledgeBaseModel: kbConfig?.embedModel,
        totalBlocks: blocks.length,
        selectedCount,
        similarityStats: {
          min: sims.length ? Math.min(...sims) : 0,
          max: sims.length ? Math.max(...sims) : 0,
          avg: sims.length ? sims.reduce((s, v) => s + v, 0) / sims.length : 0
        }
      }
    }

    return result

  } catch (error) {
    console.error('知识库检索失败:', error)
    
    // 如果是模型不可用错误，提供更友好的错误信息
    if (error instanceof ModelNotAvailableError) {
      const modelError = error as ModelNotAvailableError
      const suggestion = modelError.availableModels.length > 0 
        ? `可用的模型有：${modelError.availableModels.join(', ')}。请安装 "${modelError.requestedModel}" 或使用 fallbackModels 配置。`
        : '系统中没有可用的嵌入模型。请至少安装一个嵌入模型。'
      
      throw new Error(`${modelError.message}。${suggestion}`)
    }
    
    throw error
  }
}

// ==================== 辅助函数 ====================

/**
 * 加载知识库文件（只读；学习模块等外部复用，绝不写回 .kb）
 */
export async function loadKnowledgeBase(kbPath: string): Promise<{
  blocks: KnowledgeBlock[]
  questions?: KbQuestion[]
  fileSummaries: Map<string, FileSummaryInfo>
  fileIndex: Map<string, any>
  kbConfig?: KnowledgeBaseConfig
  ontology?: {
    entities: any[]
    relations: any[]
    entityToBlocksIndex?: Array<{ entityName: string, blockIds: string[] }>
  }
  communityReports?: any[]
  communityResult?: any
}> {
  try {
    const content = await window.ipcRenderer.invoke('readFile', kbPath)
    const saveData = JSON.parse(content) as KnowledgeBaseData

    if (!saveData.blocks) {
      throw new KnowledgeBaseFormatError('知识库文件格式错误：缺少blocks字段')
    }

    const fileSummaries = new Map<string, FileSummaryInfo>()

    // 加载文件摘要信息
    if (saveData.config?.version === "2.0" && saveData.fileSummaries) {
      Object.entries(saveData.fileSummaries).forEach(([key, value]: [string, any]) => {
        fileSummaries.set(key, {
          content: value.content,
          vector: value.vector
        })
      })
    }

    // 加载文件级摘要索引（方案B：file_score 原语消费）
    const fileIndex = new Map<string, any>()
    if (saveData.fileIndex) {
      Object.entries(saveData.fileIndex).forEach(([key, value]: [string, any]) => {
        fileIndex.set(key, {
          content: value.content,
          vector: value.vector,
          contentHash: value.contentHash
        })
      })
    }

    return {
      blocks: saveData.blocks,
      questions: saveData.questions,
      fileSummaries,
      fileIndex,
      kbConfig: saveData.config,
      ontology: saveData.ontology,
      communityReports: saveData.communityReports,
      communityResult: saveData.communityResult,
    }

  } catch (error) {
    if (error instanceof KnowledgeBaseFormatError) {
      throw error
    }
    throw new KnowledgeBaseFormatError(`加载知识库文件失败: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 由检索选项组装统一模型规格（多来源支持）
 */
function buildSpecFromOptions(config: Required<RetrievalOptions>): KbModelSpec {
  const llmType: KbProvider = config.llmType || 'ollama'
  const providerConfig = config.providerConfig
    || (llmType === 'ollama' ? { model_url: config.ollamaHost, model: '' } : {})
  const fbCfg = config.embedFallbackConfig || {}
  const fbType: KbProvider = (config.embedFallbackType as KbProvider) || 'ollama'
  const fbProviderCfg = config.embedFallbackProviderConfig
    || (fbType === 'ollama' ? { model_url: fbCfg.model_url || config.ollamaHost || 'http://127.0.0.1:11434' } : fbCfg)
  const fbEmbed = String(
    config.embedFallbackModel
    || fbCfg.embed_model
    || (fbType === 'ollama' ? (config.fallbackModels?.[0] || 'nomic-embed-text:latest') : '')
  ).trim()
  return {
    llmType,
    config: providerConfig,
    embed: config.embedModel || '',
    chat: config.chatModel || '',
    process: config.processModel || '',
    // 当前来源无嵌入模型时，嵌入回退到「嵌入兜底」设置的来源（默认 Ollama；聊天/处理仍用原来源）
    embedFallback: fbEmbed ? { llmType: fbType, config: fbProviderCfg, embed: fbEmbed } : undefined,
  }
}

/**
 * 由 .kb 数据构造检索上下文（供策略框架 runStrategy 使用，与 knowRAG 共用同一套原语）
 */
function buildRetrievalContextFromKb(params: {
  query: string
  blocks: KnowledgeBlock[]
  questions?: KbQuestion[]
  kbConfig?: KnowledgeBaseConfig
  ontology?: { entities: any[], relations: any[], entityToBlocksIndex?: Array<{ entityName: string, blockIds: string[] }> }
  communityReports?: any[]
  communityResult?: any
  fileIndex?: Map<string, any>
  spec: KbModelSpec
  embedSpec?: KbModelSpec
  embedModel: string
  config: Required<RetrievalOptions>
}): RetrievalContext {
  const { query, blocks, questions, kbConfig, ontology, communityReports, communityResult, fileIndex, spec, embedSpec, embedModel, config } = params

  const entities = (ontology?.entities || []).map(e => ({
    id: e.id || e.name,
    name: e.name,
    type: e.nodeType || e.type,
    description: e.description || '',
  }))
  const relations = (ontology?.relations || []).map(r => ({
    source: r.source,
    target: r.target,
    type: r.type || 'related_to',
  }))

  // 实体 → 关联切片索引（优先 .kb 存储的索引，缺失时按实体名在切片文本中匹配）
  const entityToBlocksIndex = new Map<string, Set<string>>()
  if (ontology?.entityToBlocksIndex) {
    for (const item of ontology.entityToBlocksIndex) {
      entityToBlocksIndex.set(item.entityName.toLowerCase(), new Set(item.blockIds || []))
    }
  }
  if (entityToBlocksIndex.size === 0) {
    for (const e of entities) {
      const set = new Set<string>()
      for (const b of blocks) {
        if (b.A && b.A.includes(e.name)) set.add(b.id || `${b.filePath}#${b.label}`)
      }
      if (set.size) entityToBlocksIndex.set(e.name.toLowerCase(), set)
    }
  }

  // communityResult.assignments: 数组 → Map（nodeId → communityId）
  let assignments: Map<string, number> | undefined
  if (communityResult?.assignments) {
    assignments = new Map<string, number>()
    for (const a of communityResult.assignments) assignments.set(a.nodeId, a.comId)
  }

  const summaryWeight = kbConfig?.summaryWeight ?? config.summaryWeight

  return {
    query,
    blocks: blocks as any[],
    entities,
    relations,
    entityToBlocksIndex,
    communityReports,
    communityResult: assignments ? { assignments, count: communityResult?.count } : undefined,
    fileIndex: fileIndex || new Map<string, any>(),
    // 问题增强索引：.kb 问题库 → 关联切片（dense_score 问题增强分 max 池化）
    questionVectorsByBlock: computeBlockQuestionVectors(questions || []),
    config: {
      url: config.ollamaHost,
      embed: embedModel,
      chat: spec.chat || embedModel,
      process: spec.process || embedModel,
      locale: 'zh',
      summaryWeight,
      bm25Enabled: kbConfig?.bm25Enabled ?? false,
      bm25Weight: 0.3,
      bm25K1: 1.5,
      bm25B: 0.75,
      searchNum: config.topK,
    },
    services: kbAi.buildRetrievalServices(spec, { cosineSimilarity, computeBM25: () => [] }, embedSpec),
  }
}

/**
 * 校验策略是否在注册表中；不在则回退最基础的相似度策略
 */
export function resolveStrategyId(requested: string | undefined): string {
  const id = requested || 'similarity'
  if (getStrategies().some(s => s.id === id)) return id
  return 'similarity'
}

/**
 * 确定要使用的嵌入模型
 */
async function determineEmbedModel(
  spec: KbModelSpec,
  preferredModel: string | undefined,
  missingModelStrategy: 'error' | 'fallback',
  fallbackModels: string[]
): Promise<string> {
  try {
    // 获取当前来源可用的模型列表
    const availableModels = await kbAi.listModels(spec)

    // 如果没有可用的模型
    if (availableModels.length === 0) {
      throw new ModelNotAvailableError('', [], '系统中没有可用的嵌入模型')
    }

    // 如果有首选模型，检查是否可用
    if (preferredModel) {
      if (availableModels.includes(preferredModel)) {
        return preferredModel
      }

      // 模型不可用，根据策略处理
      if (missingModelStrategy === 'error') {
        throw new ModelNotAvailableError(preferredModel, availableModels)
      }
    }

    // 使用回退策略：尝试回退模型列表
    for (const fallbackModel of fallbackModels) {
      if (availableModels.includes(fallbackModel)) {
        console.warn(`首选模型 "${preferredModel || '未指定'}" 不可用，使用回退模型: ${fallbackModel}`)
        return fallbackModel
      }
    }

    // 所有回退模型都不可用，使用第一个可用的模型
    console.warn(`所有指定模型都不可用，使用第一个可用模型: ${availableModels[0]}`)
    return availableModels[0]

  } catch (error) {
    // 如果获取模型列表失败
    if (error instanceof ModelNotAvailableError) {
      throw error
    }

    console.error('获取模型列表失败:', error)

    // 如果无法获取模型列表，使用默认模型尝试
    const defaultModels = ['nomic-embed-text:latest', 'all-minilm:latest']

    for (const model of defaultModels) {
      try {
        // 尝试使用该模型进行简单的向量化测试
        spec.embed = model
        const embs = await kbAi.embed(spec, 'test')
        if (embs?.[0]) {
          console.warn(`使用默认模型 ${model} (无法获取模型列表)`)
          return model
        }
      } catch (e) {
        // 这个模型不可用，尝试下一个
        continue
      }
    }

    throw new ModelNotAvailableError('', [], '无法确定可用的嵌入模型')
  }
}

/**
 * 计算文件摘要向量
 */
async function computeFileSummaryVectors(
  fileSummaries: Map<string, FileSummaryInfo>,
  spec: KbModelSpec
): Promise<Map<string, number[]>> {
  const vectors = new Map<string, number[]>()
  const promises: Promise<void>[] = []
  
  for (const [path, summaryInfo] of fileSummaries.entries()) {
    // 如果已有向量，直接使用
    if (summaryInfo.vector) {
      vectors.set(path, summaryInfo.vector)
      continue
    }
    
    // 如果没有向量但有内容，计算向量
    if (summaryInfo.content) {
      // 会话缓存：精简模式下文件摘要向量未落盘，避免每个问答都重新嵌入
      const key = `${spec.embed || ''}\u0000${path}`
      const cached = summaryVecSessionCache.get(key)
      if (cached) {
        vectors.set(path, cached)
        continue
      }
      promises.push(
        (async () => {
          try {
            const embs = await kbAi.embed(spec, summaryInfo.content)

            if (embs?.[0]) {
              summaryVecSessionCache.set(key, embs[0])
              vectors.set(path, embs[0])
            }
          } catch (error) {
            console.warn(`文件摘要向量计算失败: ${path}`, error)
          }
        })()
      )
    }
  }
  
  if (promises.length > 0) {
    await Promise.all(promises)
  }
  
  return vectors
}

/**
 * 计算综合相似度
 */
function calculateSimilarities(
  blocks: KnowledgeBlock[],
  queryEmbedding: number[],
  fileSummaryVectors: Map<string, number[]>,
  config: Required<RetrievalOptions>,
  kbConfig?: KnowledgeBaseConfig
): any[] {
  const scoredBlocks: any[] = []
  
  // ============= 修复权重计算逻辑 =============
  let effectiveSummaryWeight: number
  let effectiveSliceWeight: number
  
  if (kbConfig) {
    // 使用知识库配置的权重，但确保有效性
    const kbSummaryWeight = kbConfig.summaryWeight ?? config.summaryWeight
    const kbSliceWeight = kbConfig.sliceWeight ?? (1 - config.summaryWeight)
    
    // 确保权重在有效范围内
    effectiveSummaryWeight = Math.max(0, Math.min(1, kbSummaryWeight))
    effectiveSliceWeight = Math.max(0, Math.min(1, kbSliceWeight))
    
    // 如果两者都提供了，确保它们和为1
    if (kbConfig.summaryWeight !== undefined && kbConfig.sliceWeight !== undefined) {
      const total = effectiveSummaryWeight + effectiveSliceWeight
      if (Math.abs(total - 1) > 0.01) {
        console.warn(`知识库权重之和不等于1: ${effectiveSummaryWeight} + ${effectiveSliceWeight} = ${total}，将归一化`)
        effectiveSummaryWeight = effectiveSummaryWeight / total
        effectiveSliceWeight = effectiveSliceWeight / total
      }
    } else if (kbConfig.summaryWeight !== undefined) {
      // 只提供了 summaryWeight，计算 sliceWeight
      effectiveSliceWeight = 1 - effectiveSummaryWeight
    } else if (kbConfig.sliceWeight !== undefined) {
      // 只提供了 sliceWeight，计算 summaryWeight
      effectiveSummaryWeight = 1 - effectiveSliceWeight
    } else {
      // 两个都没提供，使用默认配置
      effectiveSummaryWeight = config.summaryWeight
      effectiveSliceWeight = 1 - config.summaryWeight
    }
  } else {
    // 没有知识库配置，使用默认配置
    effectiveSummaryWeight = config.summaryWeight
    effectiveSliceWeight = 1 - config.summaryWeight
  }
  // ============= 权重计算结束 =============
  
  // 确保最终权重有效
  if (isNaN(effectiveSummaryWeight) || isNaN(effectiveSliceWeight)) {
    console.error('权重计算错误，使用默认值')
    effectiveSummaryWeight = config.summaryWeight
    effectiveSliceWeight = 1 - config.summaryWeight
  }
  
  const totalWeight = effectiveSummaryWeight + effectiveSliceWeight
  if (Math.abs(totalWeight - 1) > 0.01) {
    console.warn(`权重归一化: ${effectiveSummaryWeight} + ${effectiveSliceWeight} = ${totalWeight}`)
    const scale = 1 / totalWeight
    effectiveSummaryWeight *= scale
    effectiveSliceWeight *= scale
  }
  
  if (config.debug) {
    console.log('相似度计算 - 权重配置:')
    console.log('- 知识库配置:', kbConfig)
    console.log('- summaryWeight:', effectiveSummaryWeight)
    console.log('- sliceWeight:', effectiveSliceWeight)
    console.log('- 总和:', effectiveSummaryWeight + effectiveSliceWeight)
  }
  
  for (const block of blocks) {
    let summaryScore = 0
    let sliceScore = 0

    // 计算文件摘要相似度（仅当该文件确有摘要向量时计入；缺失走下方归一化兜底）
    const fileSummaryVector = fileSummaryVectors.get(block.filePath)
    const hasFileSummary = !!fileSummaryVector && fileSummaryVector.length > 0
    if (hasFileSummary) {
      summaryScore = cosineSimilarity(queryEmbedding, fileSummaryVector)
    }
    
    // 计算切片相似度
    if (block.A_vector && block.A_vector.length > 0) {
      sliceScore = cosineSimilarity(queryEmbedding, block.A_vector)
    }

    // 归一化兜底（与策略框架 dense_score 的缺失通道归一化一致）：该块所属文件没有摘要向量
    // （文件摘要通道缺失，摘要分恒为 0）时，把文件摘要权重让渡给切片本体分（等效 summaryWeight=0，
    // 相似度≈切片分），避免无文件摘要的高相关切片被 (1-summaryWeight)×s 稀释而挤出 topK。
    const effSummary = hasFileSummary ? effectiveSummaryWeight : 0
    const effSlice = hasFileSummary ? effectiveSliceWeight : 1
    // 计算最终相似度
    const similarity = calculateFinalSimilarity(
      summaryScore,
      sliceScore,
      effSummary,
      effSlice
    )
    
    if (config.debug && similarity > 0) {
      //console.log(`块 "${block.label}" 相似度: ${similarity} (summary=${summaryScore}, slice=${sliceScore})`)
    }
    
    scoredBlocks.push({
      ...block,
      summaryScore,
      sliceScore,
      similarity
    })
  }
  
  return scoredBlocks
}

/**
 * 计算最终相似度
 */
function calculateFinalSimilarity(
  summaryScore: number,
  sliceScore: number,
  summaryWeight: number,
  sliceWeight: number
): number {
  return summaryWeight * summaryScore + sliceWeight * sliceScore
}

/**
 * 查询关键词重叠度 [0,1]：查询中的有效词在切片内容（A/Q）中的覆盖率
 */
function keywordOverlap(query: string, text: string): number {
  if (!query || !text) return 0
  const words = query.toLowerCase().split(/[\s,，。.!?！？;；:：、]+/).filter(w => w.trim().length > 1)
  if (words.length === 0) return 0
  const textLower = text.toLowerCase()
  let hit = 0
  for (const w of words) {
    if (textLower.includes(w)) hit++
  }
  return hit / words.length
}

/**
 * 依据检索策略调整分数（在余弦相似度基础上对本体/多跳/社区/Agentic 做差异化加权）
 */
function applyStrategyAdjustments(
  scoredBlocks: any[],
  query: string,
  strategy: string
): void {
  if (strategy === 'similarity' || scoredBlocks.length === 0) return

  // 每个切片的查询关键词重叠度（只对需要内容匹配的策略计算）
  const kwScores = scoredBlocks.map(b =>
    keywordOverlap(query, (b.A || ''))
  )

  if (strategy === 'ontology') {
    // 本体：语义相似度 + 关键词/实体重叠加权
    scoredBlocks.forEach((b, i) => {
      b.similarity = 0.7 * b.similarity + 0.3 * kwScores[i]
    })
  } else if (strategy === 'multiHop') {
    // 多跳：前 5 名命中切片的同文件兄弟切片获得链式加成（模拟图的多跳扩展）
    const topPaths = new Set(scoredBlocks.slice(0, 5).map(b => b.filePath).filter(Boolean))
    scoredBlocks.forEach((b, i) => {
      if (topPaths.has(b.filePath)) {
        b.similarity += 0.08 + 0.1 * kwScores[i]
      }
    })
  } else if (strategy === 'community') {
    // 社区：命中文件作为社区，文件内所有切片获得加成
    const topPaths = new Set(scoredBlocks.slice(0, 8).map(b => b.filePath).filter(Boolean))
    scoredBlocks.forEach(b => {
      if (topPaths.has(b.filePath)) {
        b.similarity += 0.12
      }
    })
  } else if (strategy === 'agentic') {
    // Agentic：语义 + 关键词综合加权，检索更积极
    scoredBlocks.forEach((b, i) => {
      b.similarity = 0.7 * b.similarity + 0.3 * kwScores[i]
    })
  }
}

/**
 * 构建上下文文本
 */
function buildContext(query: string, blocks: any[]): string {
  let context = query + "\n\n参考资料：\n"
  
  for (const block of blocks) {
    context += `《${block.label}》：${block.A}\n`
  }
  
  return context
}

/**
 * 检查知识库的完整性
 */
export async function validateKnowledgeBase(
  kbPath: string,
  options: {
    ollamaHost?: string
    llmType?: KbProvider
    providerConfig?: any
    checkModelAvailability?: boolean
  } = {}
): Promise<{
  valid: boolean
  issues: string[]
  config?: KnowledgeBaseConfig
  availableModel?: string
}> {
  const issues: string[] = []

  try {
    // 加载知识库
    const { blocks, kbConfig } = await loadKnowledgeBase(kbPath)

    // 检查基本信息
    if (blocks.length === 0) {
      issues.push('知识库为空，没有知识块')
    }

    // 检查配置
    if (!kbConfig) {
      issues.push('知识库缺少配置信息')
    } else {
      if (!kbConfig.embedModel) {
        issues.push('知识库缺少嵌入模型配置')
      }

      if (!kbConfig.version) {
        issues.push('知识库缺少版本信息')
      }
    }

    // 检查模型可用性
    let availableModel: string | undefined
    if (options.checkModelAvailability && kbConfig?.embedModel) {
      try {
        const llmType: KbProvider = options.llmType || 'ollama'
        const spec: KbModelSpec = {
          llmType,
          config: options.providerConfig
            || (llmType === 'ollama' ? { model_url: options.ollamaHost || 'http://127.0.0.1:11434', model: '' } : {}),
          embed: kbConfig.embedModel,
          chat: '',
          process: '',
          // 当前来源无嵌入模型时回退 Ollama（与检索运行时一致）
          embedFallback: {
            llmType: 'ollama',
            config: { model_url: options.ollamaHost || 'http://127.0.0.1:11434' },
            embed: 'nomic-embed-text:latest',
          },
        }
        const effSpec = effectiveEmbedSpec(spec)
        const modelNames = await kbAi.listModels(effSpec)

        if (!modelNames.includes(kbConfig.embedModel)) {
          issues.push(`知识库使用的嵌入模型 "${kbConfig.embedModel}" 在当前系统中不可用`)

          // 查找可用的替代模型
          const commonModels = ['nomic-embed-text:latest', 'all-minilm:latest', 'mxbai-embed-large:latest']
          for (const model of commonModels) {
            if (modelNames.includes(model)) {
              availableModel = model
              break
            }
          }
        } else {
          availableModel = kbConfig.embedModel
        }
      } catch (error) {
        issues.push(`无法检查模型可用性: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    return {
      valid: issues.length === 0,
      issues,
      config: kbConfig,
      availableModel
    }

  } catch (error) {
    return {
      valid: false,
      issues: [`加载知识库失败: ${error instanceof Error ? error.message : String(error)}`]
    }
  }
}

// ==================== 工具函数 ====================

/**
 * 余弦相似度计算
 * 
 * @param vecA 向量A
 * @param vecB 向量B
 * @returns 余弦相似度值（范围：-1 到 1）
 * 
 * @example
 * ```typescript
 * const similarity = cosineSimilarity([1, 2, 3], [4, 5, 6])
 * ```
 */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (!vecA || !vecB) return 0
  if (vecA.length !== vecB.length) {
    console.warn(`向量维度不匹配: ${vecA.length}/${vecB.length}`)
    return 0
  }
  
  let dotProduct = 0
  let normA = 0
  let normB = 0
  
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i]
    normA += vecA[i] * vecA[i]
    normB += vecB[i] * vecB[i]
  }
  
  if (normA === 0 || normB === 0) return 0
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

// ==================== 模块导出 ====================

export default {
  retrieveKnowledge,
  validateKnowledgeBase,
  cosineSimilarity,
  ModelNotAvailableError,
  KnowledgeBaseFormatError
}