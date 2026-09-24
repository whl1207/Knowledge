// 检索策略层：原语的组合 + 统一执行器
//
// 策略 = 原语的有序组合（pipeline）+ 融合规则，或特殊执行形态（mapreduce / agentic）。
// 内置策略由 BUILTIN_STRATEGIES 定义；用户可通过 setUserStrategies 传入自定义/改名的策略
// （配置 UI 写入 localStorage 后在此合并），实现"策略可配置、名称可自定义"。
//
// 统一入口 runStrategy(id, query, ctx, hooks) 返回 StrategyResult，
// 聊天 / 测试 / 实验管道共用同一套检索逻辑（消除实现漂移）。

import {
  RETRIEVAL_PRIMITIVES,
  INGESTION_PRIMITIVES,
  denseScore,
  entityLink,
  graphHop,
  fileScore,
  communitySelect,
} from '@/shared/graphrag/primitives'
import type {
  RetrievalContext,
  IngestionContext,
  PrimitiveResult,
  PipelineState,
  Evidence,
  RetrievalPrimitiveId,
  IngestionPrimitiveId,
  MatchedEntity,
} from '@/shared/graphrag/primitives'
import { multiStageSearch } from '@/shared/graphrag/search'

// ========== 类型定义 ==========

export type StrategyKind = 'pipeline' | 'mapreduce' | 'agentic' | 'hybrid'
export type StepMode = 'set' | 'multiply' | 'weighted' | 'max'

export interface StrategyStep {
  primitive: RetrievalPrimitiveId
  /** set=设置基础分；multiply=乘性提升；weighted/max=多源融合 */
  mode?: StepMode
  params?: any
}

/** 处理管线步骤：摄取阶段原语（问题推理/摘要等） */
export interface IngestionStep {
  primitive: IngestionPrimitiveId
  params?: any
}

export interface StrategyDef {
  id: string
  label: string
  kind: StrategyKind
  /** 检索管线：查询阶段原语步骤 */
  steps: StrategyStep[]
  /** 处理管线：摄取阶段原语步骤（切片→问题/摘要向量等，跑一次建索引） */
  ingestionSteps?: IngestionStep[]
  /** Agentic 可调用的检索工具开关（kb_search / entity_link / graph_hop / community_search），默认全部开启 */
  agentTools?: Record<string, boolean>
  /** Agentic 最大检索步数（多轮工具循环上限，默认 5） */
  maxRounds?: number
  /** 混合策略（hybrid）：多路召回通道开关（dense/entity/file/community/graph） */
  channels?: Record<string, boolean>
  /** 混合策略：每通道候选切片上限 */
  channelTopN?: Record<string, number>
  /** 混合策略：统一排序配置（cosine 余弦重排 / rrf 排名融合） */
  rerank?: { metric?: 'cosine' | 'rrf'; topK?: number; fileBoost?: number; hopPenalty?: number }
  builtin?: boolean
  /** 开关：停用后不参与测试与问答下拉（默认启用） */
  enabled?: boolean
}

export interface StrategyResult {
  strategyId: string
  kind: StrategyKind
  /** pipeline：blockId → 最终分数 */
  scores: Map<string, number>
  /** pipeline：按分数降序的块 */
  sortedBlocks: any[]
  evidence: Evidence[]
  /** pipeline：top-K 拼接上下文（调用方决定 searchMode） */
  context: string
  /** mapreduce / agentic：最终回答 */
  answer?: string
  meta: {
    llmCalls: number
    matchedEntities?: string[]
    boostStats?: { boostedCount: number; detail: string }
    paths?: string[]
    heteroPaths?: string[]
    mapResults?: any[]
    /** blockId → 通道分解分（切片/问题/文件 原始分），供检索结果分项展示 */
    blockDetails?: Map<string, any>
  }
}

/** Agentic 检索的单个工具调用步骤（供 UI 回显推理过程） */
export interface AgentStep {
  /** 轮次（从 1 开始） */
  round: number
  /** 工具名（对应检索原语） */
  tool: string
  /** 工具参数 */
  args: any
  /** 工具返回结果 */
  result: string
  /** 状态：running=执行中 / done=完成 / error=失败 */
  status: 'running' | 'done' | 'error'
}

export interface StrategyHooks {
  onProgress?: (msg: string) => void
  onStream?: (chunk: string) => void
  onEvidence?: (evidence: Evidence[]) => void
  /** Agentic：每轮工具调用步骤（工具/参数/结果，供推理步骤回显） */
  onAgentStep?: (step: AgentStep) => void
}

// ========== 内置策略注册表 ==========

const BUILTIN_STRATEGIES: StrategyDef[] = [
  {
    id: 'similarity', label: '相似度', kind: 'pipeline', builtin: true,
    // 普通相似度：增强权重 0（不使用语义增强，纯切片相似度）
    steps: [{ primitive: 'dense_score', mode: 'set', params: { summaryWeight: 0 } }],
    // 普通相似度不需要语义增强（处理管线为空）
    ingestionSteps: [],
  },
  {
    id: 'question', label: '问题增强', kind: 'pipeline', builtin: true,
    // 问题增强：以问题库问题向量为增强通道（dense_score 读 ctx.questionVectorsByBlock，
    // 每条问题独立向量 max 池化）。纯问题库通道：0.7*问题增强相似度 + 0.3*切片相似度。
    steps: [
      { primitive: 'dense_score', mode: 'set', params: { summaryWeight: 0.7 } },
    ],
    // 依赖处理管线：问题语义增强（semantic_enhance）——选择本策略执行管线时，
    // 自动为问题库缺失向量的问题补全问题向量，保证 Q 增强通道数据就绪。
    ingestionSteps: [
      { primitive: 'semantic_enhance' },
    ],
  },
  {
    id: 'semantic_similarity', label: '文件增强', kind: 'pipeline', builtin: true,
    // 文件增强：以文件级摘要分为主（命中所属文件摘要的切片被强化）。
    // 先跑纯切片基线（不用问题增强通道），再用文件摘要分加权融合（文件为主）。
    // 需要混合检索（如叠加 问题增强/本体/多跳）时，请在策略配置里自行在后方追加步骤。
    steps: [
      { primitive: 'dense_score', mode: 'set', params: { summaryWeight: 0 } },
      { primitive: 'file_score', mode: 'weighted', params: { weight: 0.6 } },
    ],
    // 依赖处理管线：仅文件语义增强（summarize_file，写入 fileIndex 供 file_score 消费）
    ingestionSteps: [
      { primitive: 'summarize_file' },
    ],
  },
  {
    id: 'ontology', label: '本体增强', kind: 'pipeline', builtin: true,
    steps: [
      { primitive: 'entity_link' },
      // 打开问题增强基础通道（summaryWeight 与「问题增强」策略一致=0.7）：
      // 让本体增强与问题增强在同一基准分上对比，唯一差别是实体 boost，从而真正突出本体的增量贡献
      { primitive: 'dense_score', mode: 'set', params: { summaryWeight: 0.7 } },
      { primitive: 'file_score', mode: 'weighted', params: { weight: 0.3 } },
      // minBaseScore：基础分低于阈值时 boost 不生效，避免实体命中的无关切片被乘性放大而挤出正确答案
      { primitive: 'boost', mode: 'multiply', params: { source: 'entity', boostWeight: 1.5, minBaseScore: 0.2 } },
    ],
    // 本体策略：处理管线 = 问题语义增强 + 本体推理 + 文件语义增强（保证问题向量 / file_score 就绪）
    ingestionSteps: [
      { primitive: 'semantic_enhance' },
      { primitive: 'extract_entities' },
      { primitive: 'summarize_file' },
    ],
  },
  {
    id: 'multiHop', label: '多跳增强', kind: 'pipeline', builtin: true,
    steps: [
      { primitive: 'entity_link' },
      { primitive: 'graph_hop', params: { hops: 2, maxPerHop: 5 } },
      // 打开问题增强基础通道（summaryWeight 与「问题增强」策略一致=0.7）：
      // 让多跳增强在问题增强基准之上叠加图谱 hop 扩展，评测公平且能体现图谱的增量贡献
      { primitive: 'dense_score', mode: 'set', params: { summaryWeight: 0.7 } },
      { primitive: 'file_score', mode: 'weighted', params: { weight: 0.3 } },
      // minBaseScore：基础分低于阈值时 hop 提升不生效，避免远跳/文件内扩展的无关切片被放大
      { primitive: 'boost', mode: 'multiply', params: { source: 'hop', boostWeight: 1.5, minBaseScore: 0.2 } },
    ],
    // 多跳策略：处理管线 = 问题语义增强 + 本体推理 + 文件语义增强（保证问题向量 / file_score 就绪）
    ingestionSteps: [
      { primitive: 'semantic_enhance' },
      { primitive: 'extract_entities' },
      { primitive: 'summarize_file' },
    ],
  },
  {
    id: 'hybrid', label: '多路混合', kind: 'hybrid', builtin: true, steps: [],
    // 多路混合：确定性多通道召回（语义/实体/文件/社区/图谱），候选合并后统一排序
    // 处理管线由启用的通道自动推导（见 deriveChannelIngestion），不在内置中静态定义
    channels: { dense: true, entity: true, file: true, community: true, graph: false },
    channelTopN: { dense: 8, entity: 5, file: 3, community: 3, graph: 3 },
    rerank: { metric: 'cosine', topK: 10, fileBoost: 0.2, hopPenalty: 0.1 },
  },
  {
    id: 'community', label: '社区', kind: 'mapreduce', builtin: true, steps: [],
    // 社区策略：处理管线 = 本体推理 + 社区检测 + 报告生成
    ingestionSteps: [
      { primitive: 'extract_entities' },
      { primitive: 'build_communities' },
      { primitive: 'generate_reports' },
    ],
  },
  {
    id: 'agentic', label: 'Agentic', kind: 'agentic', builtin: true, steps: [],
    // Agentic 可调用的检索工具开关（kb_search / file_search / entity_link / graph_hop / community_search）
    // 处理管线由启用的工具自动推导（见 deriveAgentIngestion），不在内置中静态定义
    agentTools: { kb_search: true, file_search: true, entity_link: true, entity_slice: true, graph_hop: true, community_search: true },
    maxRounds: 5,
  },
  // 组合策略示例（多原语融合，论文消融用）
  {
    id: 'combo_dense_community', label: '稠密+社区', kind: 'pipeline', builtin: true,
    steps: [
      // 增强权重=0：结构型策略不做问题语义增强，dense_score 纯用切片向量+BM25（避免依赖 semantic_enhance）
      { primitive: 'dense_score', mode: 'set', params: { summaryWeight: 0 } },
      { primitive: 'entity_link' },
      { primitive: 'community_select' },
      { primitive: 'boost', mode: 'multiply', params: { source: 'community', boostWeight: 1.5 } },
    ],
    ingestionSteps: [
      { primitive: 'extract_entities' },
      { primitive: 'build_communities' },
      { primitive: 'generate_reports' },
    ],
  },
]

/** 用户自定义/改名的策略（由配置 UI 写入，调用方在加载时注入） */
let userStrategies: any[] = []

export function setUserStrategies(configs: any[]) {
  userStrategies = configs || []
}

/** 原始内置策略（不受用户配置影响，供配置 UI 计算增量/恢复默认） */
export function getBuiltinStrategies(): StrategyDef[] {
  return BUILTIN_STRATEGIES
}

/** Agentic 工具 → 所需处理管线原语映射 */
export const AGENT_TOOL_INGESTION: Record<string, IngestionPrimitiveId[]> = {
  kb_search: ['semantic_enhance', 'summarize_file'],
  file_search: ['summarize_file'],
  entity_link: ['extract_entities'],
  entity_slice: ['extract_entities'],
  graph_hop: ['extract_entities'],
  community_search: ['extract_entities', 'build_communities', 'generate_reports'],
}

/**
 * 由启用的 Agentic 工具推导处理管线（供只读展示与运行时就绪判定）。
 * 顺序固定：问题语义增强 → 文件语义增强 → 本体抽取 → 社区检测 → 报告生成。
 */
export function deriveAgentIngestion(agentTools?: Record<string, boolean>): IngestionStep[] {
  const order: IngestionPrimitiveId[] = ['semantic_enhance', 'summarize_file', 'extract_entities', 'build_communities', 'generate_reports']
  const enabled = agentTools || {}
  const need = new Set<IngestionPrimitiveId>()
  for (const [tool, on] of Object.entries(enabled)) {
    if (on === false) continue
    for (const p of AGENT_TOOL_INGESTION[tool] || []) need.add(p)
  }
  return order.filter(p => need.has(p)).map(p => ({ primitive: p }))
}

/** 混合策略召回通道 → 所需处理管线原语映射 */
export const CHANNEL_INGESTION: Record<string, IngestionPrimitiveId[]> = {
  dense: ['semantic_enhance', 'summarize_file'],
  entity: ['extract_entities'],
  graph: ['extract_entities'],
  file: ['summarize_file'],
  community: ['extract_entities', 'build_communities', 'generate_reports'],
}

/** 由启用的混合通道推导处理管线（供只读展示与运行时就绪判定）。 */
export function deriveChannelIngestion(channels?: Record<string, boolean>): IngestionStep[] {
  const order: IngestionPrimitiveId[] = ['semantic_enhance', 'summarize_file', 'extract_entities', 'build_communities', 'generate_reports']
  const enabled = channels || {}
  const need = new Set<IngestionPrimitiveId>()
  for (const [ch, on] of Object.entries(enabled)) {
    if (on === false) continue
    for (const p of CHANNEL_INGESTION[ch] || []) need.add(p)
  }
  return order.filter(p => need.has(p)).map(p => ({ primitive: p }))
}

/** 合并后的策略列表：内置策略应用用户改名/覆盖 + 用户新增策略 */
export function getStrategies(): StrategyDef[] {
  const merged: StrategyDef[] = BUILTIN_STRATEGIES.map(b => {
    const override = userStrategies.find(u => u.id === b.id)
    if (!override) return { ...b, enabled: true }
    return {
      ...b,
      label: override.label || b.label,
      kind: override.kind || b.kind,
      steps: override.steps?.length ? override.steps : b.steps,
      ingestionSteps: override.ingestionSteps?.length ? override.ingestionSteps : b.ingestionSteps,
      agentTools: { ...(b.agentTools || {}), ...(override.agentTools || {}) },
      maxRounds: override.maxRounds ?? b.maxRounds,
      channels: { ...(b.channels || {}), ...(override.channels || {}) },
      channelTopN: { ...(b.channelTopN || {}), ...(override.channelTopN || {}) },
      rerank: { ...(b.rerank || {}), ...(override.rerank || {}) },
      enabled: override.enabled !== false,
    }
  })
  for (const u of userStrategies) {
    if (!BUILTIN_STRATEGIES.some(b => b.id === u.id)) merged.push({ ...u, builtin: false, enabled: u.enabled !== false })
  }
  // Agentic：处理管线由启用的工具自动推导（kb_search→切片/文件语义增强；entity_link/graph_hop→本体；community_search→社区）
  // Hybrid：处理管线由启用的通道自动推导（dense→语义增强+文件摘要；entity/graph→本体；community→社区）
  return merged.map(s => s.kind === 'agentic' ? { ...s, ingestionSteps: deriveAgentIngestion(s.agentTools) }
    : s.kind === 'hybrid' ? { ...s, ingestionSteps: deriveChannelIngestion(s.channels) }
    : s)
}

/** 仅启用的策略（被开关停用的策略不参与测试与问答下拉） */
export function getEnabledStrategies(): StrategyDef[] {
  return getStrategies().filter(s => s.enabled !== false)
}

export function getStrategy(id: string): StrategyDef | undefined {
  return getStrategies().find(s => s.id === id)
}

// ========== 融合与管线执行 ==========

function fuseMaps(a: Map<string, number>, b: Map<string, number>, mode: 'weighted' | 'max', weightB = 1): Map<string, number> {
  const out = new Map<string, number>()
  const keys = new Set([...a.keys(), ...b.keys()])
  for (const k of keys) {
    const av = a.get(k) || 0
    const bv = (b.get(k) || 0) * weightB
    out.set(k, mode === 'max' ? Math.max(av, bv) : av + bv)
  }
  return out
}

async function runPipeline(def: StrategyDef, ctx: RetrievalContext, hooks: StrategyHooks): Promise<StrategyResult> {
  const state: PipelineState = {}
  let scores = new Map<string, number>()
  const evidence: Evidence[] = []
  const meta: any = { llmCalls: 0 }
  let hasBaseScore = false
  // 分解分明细（blockId → 切片/问题/文件 原始通道分），随 meta 回传供结果 UI 展示分项
  let blockDetails: Map<string, any> | undefined

  for (const step of def.steps || []) {
    const fn = RETRIEVAL_PRIMITIVES[step.primitive]
    if (!fn) continue
    const res: PrimitiveResult = await fn(ctx, step.params, state)

    if (res.matchedEntities) state.matchedEntities = res.matchedEntities
    if (res.communityEntities) state.communityEntities = res.communityEntities
    if (res.hopNodes) state.hopNodes = res.hopNodes
    if (res.heteroNodes) state.heteroNodes = res.heteroNodes
    if (res.paths) state.paths = res.paths
    if (res.heteroPaths) state.heteroPaths = res.heteroPaths
    if (res.llmCalls) meta.llmCalls += res.llmCalls
    if (res.evidence && res.evidence.length) evidence.push(...res.evidence)
    if (res.boostStats) meta.boostStats = res.boostStats

    if (res.scores) {
      const mode = step.mode || 'set'
      if (mode === 'multiply') {
        const out = new Map<string, number>()
        // 相关性门槛：基础分低于 minBaseScore 时不允许乘性提升（mult 归 1），
        // 避免实体/hop/社区命中的无关切片被放大而挤出真正相关的切片（结构增益纯净化）
        const minBase = typeof step.params?.minBaseScore === 'number' ? step.params.minBaseScore : 0
        for (const b of ctx.blocks) {
          const id = b.id
          const base = hasBaseScore ? (scores.get(id) ?? 0) : 1
          let mult = res.scores.get(id) ?? 1
          if (mult > 1 && base < minBase) mult = 1
          out.set(id, base * mult)
        }
        scores = out
        hasBaseScore = true
      } else if (mode === 'weighted' || mode === 'max') {
        // 加权融合支持步骤级权重系数（如 file_score 的 weight）：b 分乘以权重后叠加/取最大，默认 1（等权）
        const weightB = typeof step.params?.weight === 'number' ? step.params.weight : 1
        scores = hasBaseScore ? fuseMaps(scores, res.scores, mode, weightB) : new Map(res.scores)
        hasBaseScore = true
      } else {
        scores = new Map(res.scores)
        hasBaseScore = true
      }

      // 累积分解分（切片/问题/文件 原始通道分）：按 blockId 合并各步骤贡献（dense→slice/question；file_score→file）
      if (res.details && res.details.size) {
        if (!blockDetails) blockDetails = new Map()
        for (const [id, det] of res.details) {
          const prev = blockDetails.get(id) || {}
          blockDetails.set(id, Object.assign(prev, det))
        }
      }
    }
  }

  const sortedBlocks = ctx.blocks
    .map(b => ({ block: b, p: scores.get(b.id) || 0 }))
    .sort((a, b) => b.p - a.p)
    .map(x => x.block)

  if (meta.matchedEntities?.length) {
    hooks.onProgress?.(`实体匹配: ${meta.matchedEntities.join('、')}`)
  }
  if (meta.boostStats?.boostedCount) {
    hooks.onProgress?.(`本体增强: ${meta.boostStats.boostedCount} 个切片`)
  }

  // 回传图推理路径（实体路径 + 异构切片/文件路径）供佐证展示
  meta.paths = state.paths
  meta.heteroPaths = state.heteroPaths
  if (blockDetails && blockDetails.size) meta.blockDetails = blockDetails

  return {
    strategyId: def.id,
    kind: 'pipeline',
    scores,
    sortedBlocks,
    evidence,
    context: '',
    meta,
  }
}

// ========== 工具函数 ==========

/** 用单个检索词在知识库检索（dense_score + top-N），返回上下文与佐证（Agentic kb_search 用） */
export async function retrieveTopContext(
  ctx: RetrievalContext,
  query: string,
  topN: number,
): Promise<{ context: string; evidence: Evidence[]; scores: Map<string, number>; sorted: any[] }> {
  const subCtx: RetrievalContext = { ...ctx, query }
  const res = await denseScore(subCtx)
  let scores = res.scores || new Map<string, number>()
  // 方案B：融合文件级语义增强（file_score），让 kb_search 也吃到文件通道
  if (ctx.fileIndex && ctx.fileIndex.size > 0) {
    try {
      const file = await fileScore(subCtx)
      if (file.scores && file.scores.size) scores = fuseMaps(scores, file.scores, 'weighted', 0.3)
    } catch { /* 文件通道失败不影响基础检索 */ }
  }
  const sorted = ctx.blocks
    .map(b => ({ block: b, p: scores.get(b.id) || 0 }))
    .sort((a, b) => b.p - a.p)
  const top = sorted.slice(0, Math.max(1, topN))
  let context = ''
  const evidence: Evidence[] = []
  top.forEach(({ block: b, p }) => {
    context += `《${b.label}》：${b.A}。`
    evidence.push({ id: b.id, label: b.label || '', filePath: b.filePath || '', content: b.A || '', score: p || 0, method: 'dense' })
  })
  return { context, evidence, scores, sorted: top.map(t => t.block) }
}

// ========== MapReduce（社区全局搜索） ==========

async function runMapReduce(
  def: StrategyDef,
  ctx: RetrievalContext,
  hooks: StrategyHooks,
  opts: { skipAnswer?: boolean } = {},
): Promise<StrategyResult> {
  const result: StrategyResult = {
    strategyId: def.id,
    kind: 'mapreduce',
    scores: new Map<string, number>(),
    sortedBlocks: [],
    evidence: [],
    context: '',
    meta: { llmCalls: 0 },
  }
  const { communityReports, services } = ctx
  const language = ctx.config.locale

  if (!communityReports || communityReports.length === 0) {
    hooks.onProgress?.(language === 'zh' ? '未构建社区报告，无法执行社区搜索' : 'No community reports, cannot run community search')
    return result
  }

  hooks.onProgress?.(language === 'zh' ? '社区搜索启动中...' : 'Community search starting...')

  const searchResult = await multiStageSearch(ctx.query, {
    blocks: ctx.blocks,
    communityReports,
    chat: async (prompt: string) => services.chat([{ role: 'user', content: prompt }]),
    streamChat: async (prompt: string, onChunk: (chunk: string) => void) =>
      services.streamChat([{ role: 'user', content: prompt }], onChunk),
    onReduceStream: (chunk: string) => hooks.onStream?.(chunk),
    language,
    onProgress: (msg: string) => hooks.onProgress?.(msg),
    // 测试等仅需召回的场景跳过 Reduce 回答生成（省 1 次 LLM 调用）
    skipReduce: opts.skipAnswer,
  })

  result.answer = searchResult.answer
  result.meta.mapResults = searchResult.mapResults
  result.meta.llmCalls = searchResult.llmCalls

  const usedComIds = new Set(searchResult.mapResults.map(m => m.sourceCommunityId))
  result.evidence = communityReports
    .filter(r => usedComIds.has(r.communityId))
    .map(r => ({
      id: `community-${r.communityId}`,
      label: r.title || `社区${r.communityId}`,
      filePath: '',
      content: r.summary || '',
      score: r.rating,
      method: 'community',
      reason: r.findings?.map((f: any) => f.summary).join('；') || '',
    }))

  // ===== 方案A：社区推理「落回切片」=====
  // 相关社区 → 社区内实体 → entityToBlocksIndex → 候选切片 → dense_score 打分 → sortedBlocks
  // 使社区策略也能产出切片级召回，与其他策略在同一评估基准上对比。
  hooks.onProgress?.(language === 'zh' ? '社区 → 切片落回...' : 'Community to slice fallback...')
  const communityResult = ctx.communityResult as any

  // 1) 收集相关社区的实体名
  const communityEntityNames = new Set<string>()
  if (communityResult?.communities) {
    for (const comId of usedComIds) {
      const members = communityResult.communities.get?.(comId) || []
      members.forEach((n: string) => communityEntityNames.add(n))
    }
  }
  if (communityEntityNames.size === 0 && communityResult?.assignments) {
    for (const [nodeId, comId] of communityResult.assignments) {
      if (usedComIds.has(comId)) communityEntityNames.add(nodeId)
    }
  }

  // 2) 实体 → 候选切片（通过 entityToBlocksIndex；缺失时按实体名文本匹配兜底）
  const candidateBlockIds = new Set<string>()
  for (const name of communityEntityNames) {
    const bid = ctx.entityToBlocksIndex.get(name.toLowerCase())
    if (bid && bid.size) bid.forEach(id => candidateBlockIds.add(id))
  }
  if (candidateBlockIds.size === 0) {
    for (const b of ctx.blocks) {
      if (b.A && [...communityEntityNames].some(n => b.A.includes(n))) candidateBlockIds.add(b.id)
    }
  }

  // 3) 在候选切片上做稠密打分（若无候选则退化为全库 dense_score）
  const candidateBlocks = candidateBlockIds.size
    ? ctx.blocks.filter(b => candidateBlockIds.has(b.id))
    : ctx.blocks

  if (candidateBlocks.length) {
    const subCtx: RetrievalContext = { ...ctx, blocks: candidateBlocks }
    const dense = await denseScore(subCtx)
    const scores = dense.scores || new Map<string, number>()
    const sorted = candidateBlocks
      .map(b => ({ block: b, p: scores.get(b.id) || 0 }))
      .sort((a, b) => b.p - a.p)
      .map(x => x.block)
    result.sortedBlocks = sorted
    result.scores = scores
    // 分解分（社区落回切片的 dense 通道分）供结果分项展示
    if (dense.details?.size) result.meta.blockDetails = dense.details
    // 追加切片级证据（不覆盖社区报告证据）
    const ev = sorted.slice(0, ctx.config.searchNum || 5).map((b: any) => ({
      id: b.id,
      label: b.label || '',
      filePath: b.filePath || '',
      content: b.A || '',
      score: scores.get(b.id) || 0,
      method: 'community-slice',
      reason: language === 'zh' ? '社区关联切片' : 'community-linked slice',
    }))
    result.evidence.push(...ev)
  }

  return result
}

// ========== Hybrid（确定性多路召回 + 统一排序） ==========

async function runHybrid(
  def: StrategyDef,
  ctx: RetrievalContext,
  hooks: StrategyHooks,
  opts: { skipAnswer?: boolean } = {},
): Promise<StrategyResult> {
  const result: StrategyResult = {
    strategyId: def.id,
    kind: 'hybrid',
    scores: new Map<string, number>(),
    sortedBlocks: [],
    evidence: [],
    context: '',
    meta: { llmCalls: 0 },
  }
  const { services, config } = ctx
  const language = config.locale
  const zh = (zh: string, en: string) => (language === 'zh' ? zh : en)
  const channels = def.channels || {}
  const topN = def.channelTopN || {}
  const rerankCfg = def.rerank || {}

  // 预计算原始问题向量（统一排序复用）：
  // 写入 ctx._queryVecCache，让 dense/file/entity 等原语内部的 embedQuery 命中缓存，
  // 整个问题（含并行通道）只嵌入一次
  let queryVec: number[] | null = null
  try { queryVec = services.embed ? ((await services.embed(ctx.query)) || null) : null } catch { queryVec = null }
  if (!(ctx as any)._queryVecCache) (ctx as any)._queryVecCache = new Map<string, number[] | undefined>()
  ;(ctx as any)._queryVecCache.set(ctx.query, queryVec || undefined)

  // 实体定位一次、多通道共享：entity/community/graph 都依赖实体，避免重复 entityLink（含可能的 LLM 辅助匹配）
  const sharedLink = (channels.entity !== false || channels.community !== false || channels.graph !== false)
    ? await entityLink(ctx).catch(() => ({ matchedEntities: [], llmCalls: 0 }))
    : null
  const matchedEntities = sharedLink?.matchedEntities || []
  if (sharedLink?.llmCalls) result.meta.llmCalls += sharedLink.llmCalls

  const cap = (name: string, fallback: number) => Math.max(1, topN[name] || fallback)

  // 各通道并行召回（互相独立，单个失败不影响整体）
  const channelRuns: Array<{ name: string; run: () => Promise<{ blocks: any[]; evidence: Evidence[] }> }> = []

  if (channels.dense !== false) channelRuns.push({
    name: 'dense',
    run: async () => {
      const { evidence, sorted } = await retrieveTopContext(ctx, ctx.query, cap('dense', 8))
      return { blocks: sorted, evidence: evidence.map(e => ({ ...e, method: 'dense' })) }
    },
  })

  if (channels.entity !== false) channelRuns.push({
    name: 'entity',
    run: async () => {
      // 复用共享的实体定位结果（见 sharedLink），不再重复 entityLink
      const names = matchedEntities.map(m => m.name)
      const seen = new Set<string>()
      const blocks: any[] = []
      const evidence: Evidence[] = []
      for (const name of names) {
        const bid = ctx.entityToBlocksIndex.get(name.toLowerCase())
        if (!bid) continue
        for (const id of bid) {
          if (seen.has(id)) continue
          seen.add(id)
          const b = ctx.blocks.find(x => x.id === id)
          if (!b) continue
          blocks.push(b)
          evidence.push({ id: b.id, label: b.label || '', filePath: b.filePath || '', content: b.A || '', score: 0, method: 'entity', reason: zh('实体「' + name + '」关联', 'linked to entity "' + name + '"') })
        }
      }
      const n = cap('entity', 5)
      return { blocks: blocks.slice(0, n), evidence: evidence.slice(0, n) }
    },
  })

  if (channels.file !== false) channelRuns.push({
    name: 'file',
    run: async () => {
      const fileIndex = ctx.fileIndex
      if (!fileIndex || fileIndex.size === 0) return { blocks: [], evidence: [] }
      let qv = queryVec
      if (!qv?.length) { try { qv = services.embed ? ((await services.embed(ctx.query)) || null) : null } catch { qv = null } }
      const fileScored: { path: string; s: number }[] = []
      for (const [path, entry] of fileIndex) {
        let s = 0
        if (qv && entry?.vector?.length) { try { s = Math.max(0, services.cosineSimilarity(qv, entry.vector)) } catch { s = 0 } }
        fileScored.push({ path, s })
      }
      fileScored.sort((a, b) => b.s - a.s)
      const picked = new Set(fileScored.slice(0, cap('file', 3)).map(f => f.path))
      const blocks = ctx.blocks.filter(b => b.filePath && picked.has(b.filePath)).slice(0, cap('dense', 8))
      const evidence: Evidence[] = blocks.map(b => ({
        id: b.id, label: b.label || '', filePath: b.filePath || '', content: b.A || '',
        score: 0, method: 'file', reason: zh('文件「' + String(b.filePath || '').split(/[\\/]/).pop() + '」匹配', 'matched file "' + String(b.filePath || '').split(/[\\/]/).pop() + '"'),
      }))
      return { blocks, evidence }
    },
  })

  if (channels.community !== false) channelRuns.push({
    name: 'community',
    run: async () => {
      // 复用共享的实体定位结果（见 sharedLink）
      const state: PipelineState = { matchedEntities }
      const res = await communitySelect(ctx, undefined, state)
      const names = res.communityEntities || []
      const seen = new Set<string>()
      const blocks: any[] = []
      const evidence: Evidence[] = []
      for (const name of names) {
        const bid = ctx.entityToBlocksIndex.get(name.toLowerCase())
        if (!bid) continue
        for (const id of bid) {
          if (seen.has(id)) continue
          seen.add(id)
          const b = ctx.blocks.find(x => x.id === id)
          if (!b) continue
          blocks.push(b)
          evidence.push({ id: b.id, label: b.label || '', filePath: b.filePath || '', content: b.A || '', score: 0, method: 'community', reason: zh('社区实体「' + name + '」关联', 'community entity "' + name + '"') })
        }
      }
      const n = cap('community', 3)
      return { blocks: blocks.slice(0, n), evidence: evidence.slice(0, n) }
    },
  })

  if (channels.graph !== false) channelRuns.push({
    name: 'graph',
    run: async () => {
      // 复用共享的实体定位结果（见 sharedLink）
      const name = matchedEntities[0]?.name
      if (!name) return { blocks: [], evidence: [] }
      const state: PipelineState = { matchedEntities: [{ name, confidence: 1 } as MatchedEntity] }
      const res = await graphHop(ctx, { hops: 2, maxPerHop: 5 }, state)
      const seen = new Set<string>()
      const blocks: any[] = []
      const evidence: Evidence[] = []
      for (const node of res.hopNodes || []) {
        const bid = ctx.entityToBlocksIndex.get(node.name.toLowerCase())
        if (!bid) continue
        for (const id of bid) {
          if (seen.has(id)) continue
          seen.add(id)
          const b = ctx.blocks.find(x => x.id === id)
          if (!b) continue
          blocks.push(b)
          evidence.push({ id: b.id, label: b.label || '', filePath: b.filePath || '', content: b.A || '', score: 0, method: 'graph', reason: zh('从「' + name + '」hop' + node.hop + ' 到达', 'reached via hop' + node.hop + ' from "' + name + '"') })
        }
      }
      const n = cap('graph', 3)
      return { blocks: blocks.slice(0, n), evidence: evidence.slice(0, n) }
    },
  })

  if (channelRuns.length === 0) {
    hooks.onProgress?.(zh('未启用任何召回通道', 'No recall channels enabled'))
    return result
  }

  hooks.onProgress?.(zh('多路召回: ' + channelRuns.map(c => c.name).join(' + '), 'Multi-channel recall: ' + channelRuns.map(c => c.name).join(' + ')))
  const channelResults = await Promise.all(channelRuns.map(c => c.run().catch(() => ({ blocks: [], evidence: [] }))))

  // 候选合并 + 按切片 id 去重
  const blockMap = new Map<string, any>()
  const evMap = new Map<string, Evidence>()
  for (const cr of channelResults) {
    for (const b of cr.blocks) if (!blockMap.has(b.id)) blockMap.set(b.id, b)
    for (const e of cr.evidence) if (!evMap.has(e.id)) evMap.set(e.id, e)
  }
  const mergedEvidence = [...evMap.values()]

  // 统一排序（cosine 余弦重排 / rrf 排名融合）
  let ranked: Evidence[] = mergedEvidence
  if (rerankCfg.metric === 'rrf') {
    const rankAcc = new Map<string, number[]>()
    for (const cr of channelResults) {
      cr.blocks.forEach((b: any, i: number) => {
        const ranks = rankAcc.get(b.id) || []
        ranks.push(i + 1)
        rankAcc.set(b.id, ranks)
      })
    }
    const K = 60
    ranked = mergedEvidence.map(e => {
      const ranks = rankAcc.get(e.id) || []
      const rrf = ranks.reduce((sum, r) => sum + 1 / (K + r), 0)
      return { ...e, score: rrf }
    })
  } else {
    ranked = await rerankEvidenceAgainstQuery(ctx, mergedEvidence, queryVec)
  }

  ranked.sort((a, b) => (b.score || 0) - (a.score || 0))
  const topK = Math.max(1, rerankCfg.topK ?? config.searchNum ?? 10)
  const top = ranked.slice(0, topK)

  // 上下文（按重排后的 top）
  let context = ''
  top.forEach(e => { context += `《${e.label}》：${e.content}。` })

  // 结果（sortedBlocks 供测试召回；evidence 为全部重排后的候选）
  result.scores = new Map(ranked.map(e => [e.id, e.score || 0]))
  result.sortedBlocks = ranked.map(e => {
    const b = blockMap.get(e.id)
    const score = e.score || 0
    return b ? { ...b, p: score } : { id: e.id, label: e.label || '', filePath: e.filePath || '', A: e.content || '', p: score }
  })
  result.context = context
  result.evidence = ranked
  hooks.onEvidence?.(ranked)

  // 生成回答（测试等 skipAnswer 场景跳过）
  if (!opts.skipAnswer) {
    hooks.onProgress?.(zh('正在综合检索结果生成回答...', 'Synthesizing retrieved results into an answer...'))
    const prompt = `${ctx.query}\n\n${zh('请基于以下检索资料回答问题，并引用《标签》标注出处：', 'Answer based on the retrieved materials below, citing "《label》":')}\n${context || zh('（未检索到相关资料）', '(no relevant materials found)')}`
    const messages = [{ role: 'user', content: prompt }]
    if (services.streamChat) {
      result.answer = await services.streamChat(messages, chunk => hooks.onStream?.(chunk))
    } else if (services.chat) {
      result.answer = await services.chat(messages)
      if (result.answer) hooks.onStream?.(result.answer)
    }
  }

  return result
}

// ========== Agentic（LLM 路由多原语，OAG-RAG） ==========

function buildAgenticTools(ctx: RetrievalContext, enabled?: Record<string, boolean>) {
  const language = ctx.config.locale
  const desc = (zh: string, en: string) => (language === 'zh' ? zh : en)
  return [
    {
      type: 'function',
      function: {
        name: 'kb_search',
        description: desc(
          '在知识库中检索与检索词最相关的内容片段。单点事实类问题（定义/是什么/细节）用它；若已通过 file_search 定位到具体文件，可传入 file 参数限定在该文件内检索切片（文件级→切片级两阶段检索）。',
          'Search the knowledge base for snippets most relevant to the query. Use for factual questions; if file_search already located a specific file, pass the file param to search slices only within that file (file-level → slice-level two-stage retrieval).',
        ),
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '检索词或问题，尽量具体' },
            file: { type: 'string', description: '可选：限定检索的文件路径（来自 file_search 返回的文件名/路径）' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'file_search',
        description: desc(
          '在文件级摘要索引中检索与检索词最相关的文件（按文件摘要/主题匹配），返回整文件级信息。用于"哪个文件/文档涉及某主题、跨文件找内容、文件级概览"类问题。定位到文件后，可调用 kb_search 并传入 file 参数检索该文件内的切片。',
          'Search the file-level summary index for files most relevant to the query (by file summary/theme). Use for "which document covers a topic / cross-file lookups / file-level overview" questions. After locating a file, call kb_search with the file param to search slices within it.',
        ),
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '主题或问题，尽量具体' } },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'entity_link',
        description: desc(
          '找出查询中提到的本体实体（概念/人物/事件等）。回答关系类问题前先用它定位实体。',
          'Find ontology entities mentioned in the query. Use to locate entities before relational questions.',
        ),
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '需要定位实体的文本或问题' } },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'entity_slice',
        description: desc(
          '给定已定位的实体名，检索直接关联该实体的内容切片（按与问题的相关度排序）。entity_link 定位实体后，用它收敛检索该实体的具体内容片段。',
          'Given a located entity name, retrieve content slices directly linked to that entity (ranked by relevance to the question). Use after entity_link to converge on the entity-specific snippets.',
        ),
        parameters: {
          type: 'object',
          properties: { entity: { type: 'string', description: '实体名（来自 entity_link）' } },
          required: ['entity'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'graph_hop',
        description: desc(
          '从给定实体沿知识图谱关系扩展 1~2 跳，返回推理路径。用于"X 和 Y 有什么关系/为什么/导致/影响"类问题。',
          'Expand from an entity 1~2 hops over knowledge graph relations, returns reasoning paths. For relational/causal questions.',
        ),
        parameters: {
          type: 'object',
          properties: {
            entity: { type: 'string', description: '起始实体名（来自 entity_link）' },
            hops: { type: 'number', description: '扩展跳数（1 或 2）' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'community_search',
        description: desc(
          '检索知识库的社区报告，提供全局/主题级概览。用于"总结/概述/整体情况"类问题。',
          'Retrieve community reports for global/theme-level overview. Use for summarization/overview questions.',
        ),
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '主题或问题' } },
        },
      },
    },
  ].filter(t => !enabled || enabled[t.function.name] !== false)
}

function buildAgenticSystemPrompt(language: string): string {
  return language === 'zh'
    ? `你是知识库检索助手，可以调用工具检索资料。策略：先分析问题类型；单点事实用 kb_search；文件级/跨文档主题用 file_search 定位文件，再调用 kb_search 并传入 file 参数检索该文件内的切片（两阶段检索）；实体/关系问题先用 entity_link 定位实体，再用 entity_slice 收敛检索该实体关联切片，或用 graph_hop 沿关系扩展；全局/主题问题用 community_search；复杂问题组合调用。收集足够资料后，基于资料回答并引用《片段标签》标注出处。`
    : `You are a knowledge base retrieval assistant with graph tools. Strategy: analyze the question type; use kb_search for factual lookups; for file-level/cross-document themes use file_search to locate files, then call kb_search with the file param to search slices within those files (two-stage retrieval); use entity_link then entity_slice to converge on slices linked to the located entity, or graph_hop for relational/multi-hop expansion; use community_search for global questions; combine tools for complex questions. Answer based on retrieved materials, citing "《label》".`
}

function scoreCommunityReport(r: any, query: string): number {
  const ql = query.toLowerCase()
  let score = (r.rating || 0) * 10
  if (r.title?.toLowerCase().includes(ql)) score += 30
  if (r.summary?.toLowerCase().includes(ql)) score += 15
  for (const f of (r.findings || [])) {
    if (f.summary?.toLowerCase().includes(ql) || f.explanation?.toLowerCase().includes(ql)) { score += 10; break }
  }
  return score
}

async function executeAgenticTool(
  name: string,
  args: any,
  ctx: RetrievalContext,
  mergeEvidence: (evidence: Evidence[]) => void,
): Promise<string> {
  const language = ctx.config.locale
  const zh = (zh: string, en: string) => (language === 'zh' ? zh : en)

  if (name === 'kb_search') {
    const query = String(args.query || '').trim()
    if (!query) return '错误：缺少检索词'
    const filePath = args.file ? String(args.file).trim() : ''
    if (filePath) {
      // 两阶段检索：file_search 已定位文件 → 仅在该文件内检索切片
      const scopedBlocks = ctx.blocks.filter((b: any) => b.filePath === filePath)
      if (!scopedBlocks.length) return zh('未找到文件「' + filePath + '」的切片。', 'No slices found for file "' + filePath + '".')
      const subCtx: RetrievalContext = { ...ctx, blocks: scopedBlocks }
      const { context, evidence } = await retrieveTopContext(subCtx, query, ctx.config.searchNum || 5)
      mergeEvidence(evidence.map(e => ({ ...e, method: 'agentic', subQuery: query, subScore: e.score })))
      return context || zh('该文件内未检索到相关内容。', 'No relevant content found within this file.')
    }
    const { context, evidence } = await retrieveTopContext(ctx, query, ctx.config.searchNum || 5)
    mergeEvidence(evidence.map(e => ({ ...e, method: 'agentic', subQuery: query, subScore: e.score })))
    return context || zh('未检索到相关内容，请更换检索词。', 'No relevant content found, try another query.')
  }

  if (name === 'file_search') {
    const query = String(args.query || '').trim()
    const fileIndex = ctx.fileIndex
    if (!fileIndex || fileIndex.size === 0) {
      return zh('未生成文件摘要索引（需先执行文件语义增强 summarize_file）。', 'No file summary index (run summarize_file first).')
    }
    // 稠密：查询向量 vs 文件摘要向量
    let qv: number[] | null = null
    try { qv = ctx.services.embed ? ((await ctx.services.embed(query)) || null) : null } catch { qv = null }
    const scored: { path: string; entry: any; s: number }[] = []
    for (const [path, entry] of fileIndex) {
      let s = 0
      if (qv && entry?.vector?.length) {
        try { s = Math.max(0, ctx.services.cosineSimilarity(qv, entry.vector)) } catch { s = 0 }
      }
      scored.push({ path, entry, s })
    }
    scored.sort((a, b) => b.s - a.s)
    const top = scored.slice(0, Math.max(1, ctx.config.searchNum || 3))
    const text = top.map(x => `《${x.path}》：${x.entry.content || ''}`).join('\n\n')
    // 文件级佐证（无切片 id，用合成 id；分数为文件摘要匹配度，后续按原始问题重排）
    const ev: Evidence[] = top.map(x => ({
      id: `file:${x.path}`,
      label: x.path.split(/[\\/]/).pop() || x.path,
      filePath: x.path,
      content: x.entry.content || '',
      score: x.s,
      method: 'file',
      reason: zh('文件摘要匹配', 'file summary match'),
    }))
    mergeEvidence(ev.map(e => ({ ...e, subQuery: query, subScore: e.score })))
    return text || zh('未匹配到相关文件。', 'No matching files.')
  }

  if (name === 'entity_link') {
    const query = String(args.query || ctx.query || '').trim()
    const res = await entityLink({ ...ctx, query })
    if (!res.matchedEntities?.length) return zh('未匹配到相关实体。', 'No entities matched.')
    const detail = res.matchedEntities.map(m => `${m.name}(${m.confidence.toFixed(2)})`).join('、')
    return zh(`匹配实体: ${detail}`, `Matched entities: ${detail}`)
  }

  if (name === 'entity_slice') {
    const entityName = String(args.entity || '').trim()
    if (!entityName) return zh('错误：缺少实体名', 'Error: missing entity name')
    const bid = ctx.entityToBlocksIndex.get(entityName.toLowerCase())
    if (!bid || bid.size === 0) return zh('实体「' + entityName + '」暂无关联切片。', 'No slices linked to entity "' + entityName + '".')
    // 收敛：仅在该实体的关联切片上，按原始问题做稠密+文件融合检索
    const candidateBlocks = ctx.blocks.filter((b: any) => bid.has(b.id))
    const subCtx: RetrievalContext = { ...ctx, blocks: candidateBlocks }
    const { context, evidence } = await retrieveTopContext(subCtx, ctx.query, ctx.config.searchNum || 5)
    mergeEvidence(evidence.map((e: any) => ({ ...e, method: 'entity', reason: zh('实体「' + entityName + '」关联切片', 'slice linked to entity "' + entityName + '"') })))
    return context || zh('该实体无相关切片。', 'No relevant slices for this entity.')
  }

  if (name === 'graph_hop') {
    const entityName = String(args.entity || '').trim()
    if (!entityName) return zh('错误：缺少实体名', 'Error: missing entity name')
    const state: PipelineState = { matchedEntities: [{ name: entityName, confidence: 1 } as MatchedEntity] }
    const res = await graphHop(ctx, { hops: Number(args.hops) || 2, maxPerHop: 5 }, state)
    if (!res.hopNodes?.length) return zh(`实体「${entityName}」无关联关系。`, `Entity "${entityName}" has no relations.`)
    const pathsText = (res.paths || []).slice(0, 5).join('\n')
    // 关联切片证据
    let sliceInfo = ''
    const ev: Evidence[] = []
    for (const node of res.hopNodes) {
      const bid = ctx.entityToBlocksIndex.get(node.name.toLowerCase())
      if (!bid) continue
      for (const id of bid) {
        const b = ctx.blocks.find(x => x.id === id)
        if (!b) continue
        ev.push({
          id: b.id, label: b.label || '', filePath: b.filePath || '', content: b.A || '',
          score: 1 / (1 + node.hop), method: 'hop',
          reason: zh(`从「${node.path[0]}」经 ${node.viaRelation} 到达`, `from "${node.path[0]}" via ${node.viaRelation}`),
        })
      }
    }
    if (ev.length) {
      mergeEvidence(ev)
      // 收敛：把关联切片内容返回给 LLM（按 hop 就近伪分取 top3），便于直接引用而非只看到路径
      const topSlices = [...ev].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 3)
      const sliceCtx = topSlices.map(e => `《${e.label}》：${e.content}`).join('\n')
      sliceInfo = sliceCtx ? zh(`\n\n相关切片:\n${sliceCtx}`, `\n\nRelated slices:\n${sliceCtx}`) : zh(`，关联 ${ev.length} 个切片`, `, linked ${ev.length} slices`)
    }
    // 涉及文件（方案C：异构回链）
    let fileInfo = ''
    const fileSet = new Set<string>()
    for (const node of res.heteroNodes || []) {
      if (node.type === 'file') fileSet.add(node.name)
    }
    if (fileSet.size) fileInfo = zh(`，涉及文件: ${[...fileSet].join('、')}`, `, files: ${[...fileSet].join(', ')}`)
    return zh(`推理路径:\n${pathsText}${sliceInfo}${fileInfo}`, `Reasoning paths:\n${pathsText}${sliceInfo}${fileInfo}`)
  }

  if (name === 'community_search') {
    const query = String(args.query || ctx.query || '').trim()
    const reports = ctx.communityReports || []
    if (!reports.length) return zh('未构建社区报告。', 'No community reports built.')
    const scored = reports
      .map(r => ({ r, s: scoreCommunityReport(r, query) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 3)
    const text = scored
      .map(x => `【${x.r.title}】${x.r.summary}\n${(x.r.findings || []).map((f: any) => `- ${f.summary}`).join('\n')}`)
      .join('\n\n')
    // 匹配的社区报告也作为佐证回显（无切片 id，用合成 id；分数为社区主题匹配分，后续会按原始问题重排）
    const ev: Evidence[] = scored.map(x => ({
      id: `community:${x.r.id || x.r.title}`,
      label: x.r.title || zh('社区报告', 'community report'),
      filePath: '',
      content: `${x.r.summary || ''}\n${(x.r.findings || []).map((f: any) => `- ${f.summary}`).join('\n')}`,
      score: x.s,
      method: 'community',
      reason: zh('社区报告匹配', 'community report match'),
    }))
    mergeEvidence(ev)
    return text || zh('未匹配到社区报告。', 'No matching community reports.')
  }

  return zh('未知工具', 'Unknown tool')
}

/**
 * 对证据重排相关度（方案1：融合子查询分数）：
 * - 基础分：原始问题 vs 证据 的余弦相似度（对齐用户问题，保证 topK 裁剪与百分比展示可比）。
 * - 融合：对带 subScore 的证据（kb_search / file_search 用 LLM 子查询召回），按 agentSubQueryWeight
 *   加权融合「子查询检索分数」，避免精确子查询召回的证据被原始问题相似度一票否决。
 * - 无 subScore 的证据（entity_slice / graph_hop / community / 兜底检索）保持纯原始问题相似度。
 */
async function rerankEvidenceAgainstQuery(
  ctx: RetrievalContext,
  evidence: Evidence[],
  preQv?: number[] | null,
): Promise<Evidence[]> {
  if (!evidence.length) return evidence
  const { services } = ctx
  if (!services?.embed || !services?.cosineSimilarity) return evidence
  let qv = preQv
  if (!qv?.length) {
    try { qv = (await services.embed(ctx.query)) || null } catch { qv = null }
  }
  if (!qv) return evidence
  const blockById = new Map(ctx.blocks.map(b => [b.id, b]))
  const vecCache = new Map<string, number[]>()
  const out: Evidence[] = []
  for (const e of evidence) {
    let vec: number[] | null = null
    const blk = blockById.get(e.id)
    if (blk?.A_vector?.length) vec = blk.A_vector
    else if (e.content && vecCache.has(e.content)) vec = vecCache.get(e.content)!
    else if (e.content) {
      try { vec = (await services.embed(e.content)) || null; if (vec) vecCache.set(e.content, vec) } catch { vec = null }
    }
    let sim = 0
    if (vec?.length && qv.length) {
      try { sim = Math.max(0, services.cosineSimilarity(qv, vec)) } catch { sim = 0 }
    }
    // 方案1：融合子查询检索分数（仅带 subScore 的语义检索工具证据生效；量纲 0~1 与余弦一致）
    let finalScore = sim
    if (e.subScore != null) {
      const w = ctx.config.agentSubQueryWeight ?? 0.3
      const sub = Math.min(1, Math.max(0, e.subScore))
      finalScore = (1 - w) * sim + w * sub
    }
    out.push({ ...e, score: finalScore })
  }
  return out
}

async function runAgentic(
  def: StrategyDef,
  ctx: RetrievalContext,
  hooks: StrategyHooks,
  opts: { skipAnswer?: boolean } = {},
): Promise<StrategyResult> {
  const result: StrategyResult = {
    strategyId: def.id,
    kind: 'agentic',
    scores: new Map<string, number>(),
    sortedBlocks: [],
    evidence: [],
    context: '',
    meta: { llmCalls: 0 },
  }
  const { services, config } = ctx
  const language = config.locale
  const zh = (zh: string, en: string) => (language === 'zh' ? zh : en)

  if (!services.agenticChat) return result

  const tools = buildAgenticTools(ctx, def.agentTools)
  const systemPrompt = buildAgenticSystemPrompt(language)
  const messages: any[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: ctx.query },
  ]

  // 预计算原始问题向量（证据重排全程复用，避免每轮工具调用重复嵌入）
  let queryVec: number[] | null = null
  try { queryVec = services.embed ? ((await services.embed(ctx.query)) || null) : null } catch { queryVec = null }

  const allEvidence: Evidence[] = []
  const seenKeys = new Set<string>()
  const mergeEvidence = async (evidence: Evidence[]) => {
    evidence.forEach(e => {
      const key = e.id || `${e.label}|${e.content}`
      if (seenKeys.has(key)) return
      seenKeys.add(key)
      allEvidence.push(e)
    })
    // 每轮合并后按原始问题重排（工具子查询的分值与伪分值不可比，统一换成语义相关度）
    hooks.onEvidence?.([...(await rerankEvidenceAgainstQuery(ctx, allEvidence, queryVec))])
  }

  // 兜底保证：先对原始问题做一次稠密检索并合并证据。
  // 使 Agentic 以稠密检索为召回下限（任何情况下都有 top-k 切片佐证），
  // 再由 LLM 通过工具精细化——避免"模型直接回答/未调用检索工具 → 无佐证或证据稀疏"。
  try {
    const baseTopN = Math.max(1, config.searchNum || 5)
    const { evidence } = await retrieveTopContext(ctx, ctx.query, baseTopN)
    await mergeEvidence(evidence.map(e => ({ ...e, method: 'agentic' })))
  } catch { /* 基础检索失败不阻塞工具循环 */ }

  let answer = ''
  try {
    for (let round = 0; round < (def.maxRounds ?? 5); round++) {
      const response = await services.agenticChat(messages, tools)
      result.meta.llmCalls++
      const toolCalls = response.tool_calls || []
      const content = (response.content || '').trim()

      if (toolCalls.length === 0) {
        // 模型本轮给出最终正文（无工具调用）
        if (opts.skipAnswer) {
          // 仅需召回（如测试）：不再重复生成最终回答，直接采用本轮正文（可为空）
          answer = content
        } else if (services.streamChat) {
          // 最终回答：流式输出（携带含工具结果的上下文，让模型边生成边逐块推送）
          answer = await services.streamChat(messages, chunk => hooks.onStream?.(chunk))
          // 兜底：流式生成失败/为空时，直接采用模型本轮已生成的正文
          if (!answer && content) {
            answer = content
            hooks.onStream?.(content)
          }
        } else {
          // 无流式服务 → 一次性输出模型已生成的正文
          answer = content || ''
          hooks.onStream?.(answer)
        }
        break
      }

      const toolResults: string[] = []
      for (const tc of toolCalls) {
        let args: any = {}
        try {
          args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {})
        } catch { args = {} }
        const toolName = tc.function?.name || 'unknown'
        hooks.onProgress?.(zh(`执行工具 ${toolName}...（第 ${round + 1} 轮）`, `Running ${toolName}... (round ${round + 1})`))
        hooks.onAgentStep?.({ round: round + 1, tool: toolName, args, result: '', status: 'running' })
        // 工具开关：被禁用的工具直接跳过（正常情况下工具列表已过滤，此为兜底）
        if (def.agentTools && def.agentTools[toolName] === false) {
          const msg = zh('该工具已禁用', 'Tool disabled')
          hooks.onAgentStep?.({ round: round + 1, tool: toolName, args, result: msg, status: 'error' })
          toolResults.push(msg)
          continue
        }
        try {
          const tr = await executeAgenticTool(toolName, args, ctx, mergeEvidence)
          hooks.onAgentStep?.({ round: round + 1, tool: toolName, args, result: tr, status: 'done' })
          toolResults.push(tr)
        } catch (e: any) {
          hooks.onAgentStep?.({ round: round + 1, tool: toolName, args, result: String(e?.message || e), status: 'error' })
          toolResults.push(zh(`工具执行失败: ${e?.message || e}`, `Tool failed: ${e?.message || e}`))
        }
      }

      messages.push({ role: 'assistant', content: response.content || '', tool_calls: toolCalls })
      toolResults.forEach(tr => messages.push({ role: 'tool', content: tr }))
    }
  } catch (err: any) {
    // 模型不支持 tools → 退化为单次 dense 检索 + 回答
    console.warn('[Strategy/agentic] 模型不支持 tools，退化为单次检索:', err?.message || err)
    const { context, evidence } = await retrieveTopContext(ctx, ctx.query, config.searchNum || 5)
    await mergeEvidence(evidence.map(e => ({ ...e, method: 'agentic' })))
    messages.push({ role: 'user', content: `${ctx.query}\n\n参考资料：\n${context || ''}` })
    // 仅需召回（如测试）时跳过回答生成，证据已合并
    if (services.streamChat && !opts.skipAnswer) {
      answer = await services.streamChat(messages, chunk => hooks.onStream?.(chunk))
    }
  }

  // 多轮检索后仍未产出正文（模型一直调工具到 maxRounds 用尽等）→ 基于已收集证据强制生成答案
  if (!opts.skipAnswer && !answer) {
    const rankedNow = await rerankEvidenceAgainstQuery(ctx, allEvidence, queryVec)
    const topCtx = rankedNow
      .slice(0, Math.max(1, config.searchNum || 5))
      .map(e => `《${e.label}》：${e.content}`)
      .join('\n')
    hooks.onProgress?.(zh('正在综合检索结果生成回答...', 'Synthesizing retrieved results into an answer...'))
    const finalMessages = [
      ...messages,
      { role: 'user', content: `${ctx.query}\n\n${zh('请基于以下检索资料回答问题，并引用《标签》标注出处：', 'Answer based on the retrieved materials below, citing "《label》":')}\n${topCtx || zh('（未检索到相关资料）', '(no relevant materials found)')}` },
    ]
    if (services.streamChat) {
      answer = await services.streamChat(finalMessages, chunk => hooks.onStream?.(chunk))
    } else if (services.chat) {
      answer = await services.chat(finalMessages)
      if (answer) hooks.onStream?.(answer)
    }
  }

  // 收尾：按原始问题重排全部证据（保证 topK 裁剪与百分比展示对齐问题）
  const reranked = await rerankEvidenceAgainstQuery(ctx, allEvidence, queryVec)
  result.answer = answer || ''
  result.evidence = reranked
  hooks.onEvidence?.(reranked)
  return result
}

// ========== 统一入口 ==========

export async function runStrategy(
  id: string,
  query: string,
  ctx: RetrievalContext,
  hooks: StrategyHooks = {},
  opts: { skipAnswer?: boolean } = {},
): Promise<StrategyResult> {
  const def = getStrategy(id)
  if (!def) throw new Error(`Unknown strategy: ${id}`)
  const fullCtx: RetrievalContext = { ...ctx, query }
  switch (def.kind) {
    case 'pipeline': return runPipeline(def, fullCtx, hooks)
    case 'mapreduce': return runMapReduce(def, fullCtx, hooks, opts)
    case 'agentic': return runAgentic(def, fullCtx, hooks, opts)
    case 'hybrid': return runHybrid(def, fullCtx, hooks, opts)
  }
}

/**
 * runIngestion：执行某策略的处理管线（摄取阶段原语，如 semantic_enhance / extract_entities 等）。
 * 幂等：各原语内部对已处理数据跳过。返回各原语的处理结果（processed/failed 等）。
 */
export async function runIngestion(
  id: string,
  ctx: IngestionContext,
  hooks: { onProgress?: (msg: string) => void } = {},
): Promise<{ [primitive: string]: any }> {
  const def = getStrategy(id)
  if (!def) return {}
  const results: { [primitive: string]: any } = {}
  for (const step of def.ingestionSteps || []) {
    const fn = INGESTION_PRIMITIVES[step.primitive]
    if (!fn) continue
    const label = step.primitive
    hooks.onProgress?.(`处理阶段：${label}`)
    try {
      results[label] = await fn(ctx, step.params)
    } catch (error) {
      console.error(`runIngestion 原语 ${label} 失败:`, error)
      results[label] = { processed: 0, failed: 0 }
    }
  }
  return results
}
