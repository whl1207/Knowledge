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
  /** Agentic：检索工具内部候选切片数（留空=跟随「处理配置 → 工具候选数」，默认 15）。
   *  可为不同 Agentic 策略设置不同值，便于做「候选池大小」消融。 */
  agentToolTopN?: number
  /** Agentic：最终重排时融合「工具通道分」的权重（留空=跟随「处理配置 → 子查询重排权重」，默认 0.5） */
  agentSubQueryWeight?: number
  /** Agentic：检索暖启动——把系统预取结果随首轮请求交给模型，避免重复检索同一问题（默认开） */
  agentWarmStart?: boolean
  /** Agentic：模型未调用任何工具时，自动按可用通道补一次确定性召回（默认开）。
   *  关掉可做「纯 LLM 路由 vs 确定性通道」的消融。 */
  agentFallback?: boolean
  /** Agentic（智能路由）自定义系统提示词：留空/未设置时使用内置默认（getDefaultAgentSystemPrompt）。
   *  自定义后不再区分界面语言，中英界面均使用该提示词。 */
  systemPrompt?: string
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
    /** Agentic：工具调用轨迹（轮次/工具/参数/结果），供测试页「检索过程」与问答「推理路径」回显 */
    agentSteps?: AgentStep[]
    /** Agentic：本次实际暴露给模型的工具名（已按用户开关与数据就绪过滤） */
    agentTools?: string[]
    /** Agentic：因索引未就绪而被隐藏的工具名（模型不会调用） */
    agentDroppedTools?: string[]
    /** Agentic：模型未返回工具调用、退化为单次稠密检索 */
    agentDegraded?: boolean
    /** Agentic：模型全程未调用任何检索工具（工具定义已下发但未被使用） */
    agentNoToolCalls?: boolean
    /** Agentic：已执行「模型不调工具」时的确定性补充召回 */
    agentFallback?: boolean
  }
}

/** Agentic 检索的单个工具调用步骤（供 UI 回显推理过程） */
export interface AgentStep {
  /** 轮次（从 1 开始；0 = 系统预取） */
  round: number
  /** 工具名（对应检索原语；模型决策/系统预取条目的 tool 为 '' 或对应预取通道） */
  tool: string
  /** 工具参数 */
  args: any
  /** 工具返回结果 */
  result: string
  /** 状态：running=执行中 / done=完成 / error=失败 */
  status: 'running' | 'done' | 'error'
  /** 步骤来源：prefetch=系统预取 / tool=模型调用的检索工具 / fallback=模型未调工具时系统补充召回 / model=模型的回合决策 */
  kind?: 'prefetch' | 'tool' | 'fallback' | 'model'
  /** 补充说明（如「模型未调用任何检索工具，直接作答」） */
  note?: string
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
      // minBaseScore 现解释为分位数(0-1)：只有当切片基础分不低于该题基础分的 60 分位时，
      // 实体增强才生效。旧值 0.2 是绝对阈值，实测在本知识库上几乎无切片低于它，门槛失效。
      { primitive: 'boost', mode: 'multiply', params: { source: 'entity', boostWeight: 1.5, minBaseScore: 0.6 } },
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
      // minBaseScore 现解释为分位数(0-1)：基础分低于该题 60 分位时 hop 提升不生效，
      // 避免远跳/文件内扩展的无关切片被放大（旧绝对值 0.2 在本语料上等于无门槛）
      { primitive: 'boost', mode: 'multiply', params: { source: 'hop', boostWeight: 1.5, minBaseScore: 0.6 } },
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
      // 与其它策略保持同一基础通道：问题增强 0.7 + 切片 0.3（不传 summaryWeight 即用全局默认，
      // 且无关联问题的切片会自动把权重让渡给切片通道）。
      // 旧实现写死 summaryWeight:0，等于关掉问题通道，使其系统性低于所有其它策略、无法公平比较。
      { primitive: 'dense_score', mode: 'set' },
      { primitive: 'entity_link' },
      { primitive: 'community_select' },
      // 加性加分而非乘性放大：结构覆盖集合较大时，单一乘性因子对排序中性甚至有害（已实测）。
      // 模式用 weighted（等权相加），boostWeight 即该加性项的权重。
      { primitive: 'boost', mode: 'weighted', params: { source: 'community', boostWeight: 0.05, asBonus: true } },
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
      agentToolTopN: override.agentToolTopN ?? b.agentToolTopN,
      agentSubQueryWeight: override.agentSubQueryWeight ?? b.agentSubQueryWeight,
      agentWarmStart: override.agentWarmStart ?? b.agentWarmStart,
      agentFallback: override.agentFallback ?? b.agentFallback,
      systemPrompt: override.systemPrompt ?? b.systemPrompt,
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
        // 相关性门槛：基础分低于门槛时不允许乘性提升（mult 归 1），
        // 避免实体/hop/社区命中的无关切片被放大而挤出真正相关的切片（结构增益纯净化）
        //
        // 改用「相对门槛」：绝对阈值（原 0.2）在不同语料上含义漂移——实测在运筹学
        // 知识库上几乎没有任何切片低于 0.2，门槛形同虚设。minBaseScore 现在解释为
        // 分位数（0-1），门槛取该题全部基础分的对应分位值，从而自适应语料与查询。
        const rawMinBase = typeof step.params?.minBaseScore === 'number' ? step.params.minBaseScore : 0
        let minBase = rawMinBase
        if (rawMinBase > 0 && rawMinBase <= 1 && hasBaseScore) {
          const vals = ctx.blocks
            .map(b => scores.get(b.id) ?? 0)
            .filter(v => v > 0)
            .sort((a, b) => a - b)
          if (vals.length) {
            const pos = Math.min(vals.length - 1, Math.max(0, Math.floor(rawMinBase * (vals.length - 1))))
            minBase = vals[pos]
          }
        }
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

/** 用单个检索词在知识库检索（dense_score + top-N），返回上下文与佐证（Agentic kb_search 用）。
 *  scores 为叠加文件通道后的排序分（可能 >1，用于取 top-N）；denseScores 为纯稠密通道分（0~1），
 *  供 Agentic 子查询分数（subScore）融合——量纲与余弦一致，避免被截断而丢失区分度。 */
export async function retrieveTopContext(
  ctx: RetrievalContext,
  query: string,
  topN: number,
  /** 拼进 context 的条数（默认与 topN 相同）：工具检索可取更大的 topN 扩池，
   *  但只把最相关的前若干条写进上下文，避免提示词体积随候选池线性增长。 */
  contextTopN?: number,
): Promise<{ context: string; evidence: Evidence[]; scores: Map<string, number>; denseScores: Map<string, number>; sorted: any[] }> {
  const subCtx: RetrievalContext = { ...ctx, query }
  const res = await denseScore(subCtx)
  const denseScores = res.scores || new Map<string, number>()
  let scores = denseScores
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
  // 证据池 = 全部 topN（参与最终融合排序）；上下文 = 前 contextTopN 条（模型实际读到的内容）
  const contextCount = Math.max(1, contextTopN ?? topN)
  let context = ''
  const evidence: Evidence[] = []
  top.forEach(({ block: b, p }, i) => {
    if (i < contextCount) context += `《${b.label}》：${b.A}。`
    evidence.push({ id: b.id, label: b.label || '', filePath: b.filePath || '', content: b.A || '', score: p || 0, method: 'dense' })
  })
  return { context, evidence, scores, denseScores, sorted: top.map(t => t.block) }
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

  // 1) 收集相关社区的成员实体名
  const communityEntityNames = new Set<string>()
  //
  // 三个坑（旧实现全踩）：
  //   a) usedComIds 来自报告的 communityId，类型是 string；而 communities/assignments 的键是 number
  //   b) communities 的值是**实体 nodeId**（如 e1/e2），不是实体名 —— 必须经 entities 反查成 name，
  //      否则 entityToBlocksIndex（按 name 建索引）永远查不到
  //   c) communities 在旧链路里根本没被加载（kbRetrieval 只转换了 assignments）
  const communityResult = ctx.communityResult as any
  const usedComIdNums = new Set<number>()
  for (const c of usedComIds) {
    const n = Number(c)
    if (!Number.isNaN(n)) usedComIdNums.add(n)
  }
  const id2name = new Map<string, string>()
  for (const e of ctx.entities) {
    const id = (e as any).id
    const nm = (e as any).name
    if (typeof id === 'string' && typeof nm === 'string') id2name.set(id, nm)
  }
  const addMember = (m: string) => {
    const nm = id2name.get(m) || m
    if (nm) communityEntityNames.add(nm)
  }

  const commMap = communityResult?.communities
  if (commMap && typeof commMap.get === 'function') {
    for (const comId of usedComIdNums) {
      for (const m of commMap.get(comId) || []) addMember(m)
    }
  }
  if (communityEntityNames.size === 0 && communityResult?.assignments) {
    const assign = communityResult.assignments
    const iter: Iterable<[string, number]> =
      typeof assign[Symbol.iterator] === 'function' ? assign : []
    for (const [nodeId, comId] of iter) {
      if (usedComIdNums.has(Number(comId))) addMember(nodeId)
    }
  }

  // 2) 实体 → 候选切片（通过 entityToBlocksIndex；缺失时按实体名文本匹配兜底）
  const candidateBlockIds = new Set<string>()
  for (const name of communityEntityNames) {
    const bid = ctx.entityToBlocksIndex.get(name.toLowerCase())
    if (bid && bid.size) bid.forEach(id => candidateBlockIds.add(id))
  }
  if (candidateBlockIds.size === 0 && communityEntityNames.size) {
    // 文本兜底：要求实体名长度 >= 3，避免单字实体（"图"/"基"/"弧"）命中几乎所有切片。
    // 旧实现无长度限制且逐片 includes，会把这个策略伪装成"正常但偏弱"。
    for (const b of ctx.blocks) {
      const body = b.A || ''
      if (body && [...communityEntityNames].some(n => n.length >= 3 && body.includes(n))) {
        candidateBlockIds.add(b.id)
      }
    }
  }

  // 3) 在候选切片上做稠密打分
  // 若社区映射完全缺失，**不退化到全库**：全库 dense 与纯稠密策略无法区分，
  // 评测时会表现为"策略正常但偏弱"，掩盖"社区数据未生成"这一真实原因。
  if (candidateBlockIds.size === 0) {
    hooks.onProgress?.(language === 'zh'
      ? '社区未关联到任何切片（社区数据可能缺失），本策略跳过切片落回'
      : 'No slices linked to communities (community data may be missing); skipping slice fallback')
    return result
  }
  const candidateBlocks = ctx.blocks.filter(b => candidateBlockIds.has(b.id))

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
      const { evidence, sorted, denseScores } = await retrieveTopContext(ctx, ctx.query, cap('dense', 8))
      // 带上 subScore：让统一重排阶段保留「问题通道 + 切片 + BM25 + 文件」的融合分。
      // 旧实现不带 subScore，重排时只剩纯切片余弦（rerankEvidenceAgainstQuery 的 sim 项），
      // 等于把 BM25（权重 0.3）与问题通道（权重 0.7）全部丢弃 —— 这正是多路混合策略
      // 在此前实测中明显低于纯问题增强的原因。
      return {
        blocks: sorted,
        evidence: evidence.map(e => ({
          ...e,
          method: 'dense',
          subQuery: ctx.query,
          subScore: denseScores.get(e.id) ?? e.score,
        })),
      }
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

/**
 * 工具数据就绪判定：索引/本体/社区尚未构建时该工具必然返回空，不再暴露给模型，
 * 避免模型把轮次浪费在「未构建」类空调用上（也避免模型据此误判无从检索而直接作答）。
 */
function agentToolAvailable(name: string, ctx: RetrievalContext): boolean {
  switch (name) {
    case 'kb_search': return (ctx.blocks || []).length > 0
    case 'file_search': return !!ctx.fileIndex && ctx.fileIndex.size > 0
    case 'entity_link': return (ctx.entities || []).length > 0
    case 'entity_slice': return (ctx.entityToBlocksIndex?.size || 0) > 0
    case 'graph_hop': return (ctx.entityToBlocksIndex?.size || 0) > 0 && (ctx.relations || []).length > 0
    case 'community_search': return (ctx.communityReports || []).length > 0
    default: return true
  }
}

function buildAgenticTools(ctx: RetrievalContext, enabled?: Record<string, boolean>): { tools: any[]; dropped: string[] } {
  const language = ctx.config.locale
  const desc = (zh: string, en: string) => (language === 'zh' ? zh : en)
  const all = [
    {
      type: 'function',
      function: {
        name: 'kb_search',
        description: desc(
          '在知识库中检索最相关的内容片段（返回内容 + 《片段标签》）。这是主检索工具：事实/定义/细节问题第一步就用它，并直接传原始问题（不要改写）；一次可并行发起多个不同检索词；结果不足时换更具体或同义的关键词再检索，不要重复同一检索词。若已用 file_search 定位到文件，可传 file 参数只在该文件内检索切片（文件级→切片级两阶段检索）。',
          'Search the knowledge base for the most relevant snippets (returns content with 《label》 tags). Primary tool: for factual/definition/detail questions call it first, passing the original question (do not rewrite it); you may issue several calls with different queries in parallel; if results are insufficient, retry with more specific synonyms instead of repeating the same query. If file_search already located a file, pass the file param to search slices within that file only (two-stage retrieval).',
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
          '找出查询中提到的本体实体（概念/人物/事件等），返回实体名与置信度。实体、关系、因果类问题先调用它定位实体，再配合 entity_slice / graph_hop 使用。',
          'Find ontology entities mentioned in the query, returning names and confidence. For entity/relation/causal questions, call it first to locate entities, then use entity_slice / graph_hop.',
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
          '从给定实体沿知识图谱关系扩展 1~2 跳，返回推理路径与关联切片。用于"X 和 Y 有什么关系/为什么/导致/影响"类问题；实体名须来自 entity_link 的结果。',
          'Expand from an entity 1~2 hops over knowledge graph relations, returning reasoning paths and related slices. For relational/causal questions; the entity name must come from entity_link results.',
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
          '检索知识库的社区报告，提供全局/主题级概览。用于"总结/概述/整体情况/主要主题"类问题；与 kb_search 组合可复述具体细节。',
          'Retrieve community reports for a global/theme-level overview. Use for summarization/overview/main-theme questions; combine with kb_search to ground details.',
        ),
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '主题或问题' } },
        },
      },
    },
  ]
  // 用户开关 + 数据就绪双重过滤：开关关闭或对应索引尚未构建的工具一律不暴露（dropped 供 UI/日志回显）
  const dropped: string[] = []
  const tools = all.filter((t: any) => {
    if (enabled && enabled[t.function.name] === false) return false
    if (!agentToolAvailable(t.function.name, ctx)) { dropped.push(t.function.name); return false }
    return true
  })
  return { tools, dropped }
}

/** 内置默认的 Agentic 系统提示词（策略配置页「填入默认提示词」与留空回退共用） */
export function getDefaultAgentSystemPrompt(language: string): string {
  return buildAgenticSystemPrompt(language)
}

function buildAgenticSystemPrompt(language: string): string {
  return language === 'zh'
    ? `你是知识库检索助手：先调用检索工具取回资料，再基于资料作答。
检索策略：
1. 第一轮用「原始问题」调用 kb_search（不要改写检索词），并可与其它工具并行调用；若结果已足以回答问题，立即给出答案。
2. 资料不足时换同义词或更具体的关键词再次检索，不要重复同一个检索词。
3. 按问题类型补充工具：单点事实用 kb_search；文件级/跨文档主题先用 file_search 定位文件，再用 kb_search 的 file 参数检索该文件内的切片；实体/关系/因果问题先用 entity_link 定位实体，再用 entity_slice 取该实体关联切片，或用 graph_hop 沿关系扩展；全局/概述问题用 community_search。
4. 每轮可并行调用多个工具，总轮次有限（默认 5 轮）：收集到足够资料就停止调用工具并作答。
5. 只依据检索到的资料回答，用《片段标签》标注出处；资料中确实没有的内容要说明"资料中未提及"，不要编造。`
    : `You are a knowledge base retrieval assistant: retrieve first with the tools, then answer from the retrieved material.
Strategy:
1. In the first round call kb_search with the ORIGINAL question (do not rewrite it); you may call several tools in parallel. If the results already answer the question, answer immediately.
2. If the material is insufficient, search again with synonyms or more specific keywords; never repeat the same query.
3. Pick tools by question type: factual lookups → kb_search; file-level/cross-document themes → file_search to locate files, then kb_search with the file param; entity/relation/causal questions → entity_link then entity_slice or graph_hop; global/overview questions → community_search.
4. Several tools may be called in parallel each round; total rounds are limited (default 5): stop calling tools and answer once you have enough.
5. Answer only from the retrieved material, citing 《label》. If the material truly lacks the answer, say so instead of inventing content.`
}

/** 轻量分词（用于覆盖率打分）：中文取字符二元组，拉丁/数字取长度 ≥2 的词 */
function tokenizeForOverlap(text: string): Set<string> {
  const out = new Set<string>()
  const s = String(text || '').toLowerCase()
  for (const w of (s.match(/[a-z0-9_]{2,}/g) || [])) out.add(w)
  const cjk = s.replace(/[^\u4e00-\u9fa5]/g, '')
  for (let i = 0; i + 1 < cjk.length; i++) out.add(cjk.slice(i, i + 2))
  if (cjk.length === 1) out.add(cjk)
  return out
}

/**
 * 社区报告相关度（0~1）：查询词覆盖率 + 标题覆盖率 + 评分先验（0.1 权重）。
 * 原实现用「整条查询文本 includes」判分，中文长问题几乎永不命中 → 退化为按 rating 排序（等于随机）。
 */
function scoreCommunityReport(r: any, query: string): number {
  const qTokens = tokenizeForOverlap(query)
  if (!qTokens.size) return 0
  const docTokens = tokenizeForOverlap([
    r.title || '',
    r.summary || '',
    ...(r.findings || []).map((f: any) => `${f.summary || ''} ${f.explanation || ''}`),
  ].join(' '))
  const titleTokens = tokenizeForOverlap(r.title || '')
  let hit = 0, titleHit = 0
  for (const t of qTokens) {
    if (docTokens.has(t)) hit++
    if (titleTokens.has(t)) titleHit++
  }
  const coverage = hit / qTokens.size
  const titleCoverage = titleHit / qTokens.size
  const prior = Math.max(0, Math.min(1, (r.rating || 0) / 5)) * 0.1
  return Math.min(1, coverage * 0.8 + titleCoverage * 0.2 + prior)
}

/**
 * 诊断用：模型是否把工具调用直接写成了正文（不支持 function calling 的服务/模型常见，
 * 例如把 {"name":"kb_search","arguments":{...}} 或 <tool_call>kb_search… 当成普通文本输出）。
 * 命中时返回被写进正文的工具名，用于在检索过程里给出明确提示。
 */
function detectToolCallInText(text: string, tools: any[]): string {
  if (!text || !tools?.length) return ''
  for (const t of tools) {
    const name = t?.function?.name
    if (!name) continue
    if (new RegExp(`["']?name["']?\\s*[:=]\\s*["']?${name}\\b`).test(text)) return name
    if (text.includes(`<tool_call>${name}`) || text.includes(`tool_call_id="${name}"`)) return name
  }
  return ''
}

/** 实体名解析：精确（忽略大小写）→ 唯一「包含」匹配（模型常带括号/后缀说明）；返回关联切片集合 */function resolveEntityBlocks(ctx: RetrievalContext, name: string): Set<string> | undefined {
  const idx = ctx.entityToBlocksIndex
  if (!idx || idx.size === 0) return undefined
  const key = name.trim().toLowerCase()
  const exact = idx.get(key)
  if (exact?.size) return exact
  const hits = [...idx.keys()].filter(k => k.includes(key) || key.includes(k))
  return hits.length === 1 ? idx.get(hits[0]) : undefined
}

async function executeAgenticTool(
  name: string,
  args: any,
  ctx: RetrievalContext,
  mergeEvidence: (evidence: Evidence[]) => void,
  /** 工具内部候选切片数（比最终呈现的 searchNum 更大，用于扩池抬高召回上限） */
  toolTopN: number,
): Promise<string> {
  const language = ctx.config.locale
  const zh = (zh: string, en: string) => (language === 'zh' ? zh : en)

  if (name === 'kb_search') {
    const query = String(args.query || '').trim()
    if (!query) return '错误：缺少检索词'
    const filePath = args.file ? String(args.file).trim() : ''
    if (filePath) {
      // 两阶段检索：file_search 已定位文件 → 仅在该文件内检索切片
      // 文件名解析：优先全路径精确匹配，退化到「路径后缀 / 文件名」匹配（模型常只回传文件名）
      const key = filePath.toLowerCase().replace(/\\/g, '/')
      const base = key.split('/').pop() || key
      const scopedBlocks = ctx.blocks.filter((b: any) => {
        const p = String(b.filePath || '').toLowerCase().replace(/\\/g, '/')
        return !!p && (p === key || p.endsWith('/' + base) || p === base)
      })
      if (!scopedBlocks.length) {
        const files = [...new Set(ctx.blocks.map((b: any) => b.filePath).filter(Boolean))].slice(0, 8)
        return zh(`未找到文件「${filePath}」的切片。可选文件：${files.join('、') || '（无）'}`,
          `No slices found for file "${filePath}". Available files: ${files.join(', ') || '(none)'}`)
      }
      const subCtx: RetrievalContext = { ...ctx, blocks: scopedBlocks }
      const { context, evidence, denseScores } = await retrieveTopContext(subCtx, query, toolTopN, ctx.config.searchNum || 5)
      mergeEvidence(evidence.map(e => ({ ...e, method: 'agentic', subQuery: query, subScore: denseScores.get(e.id) ?? e.score })))
      return context || zh('该文件内未检索到相关内容。', 'No relevant content found within this file.')
    }
    const { context, evidence, denseScores } = await retrieveTopContext(ctx, query, toolTopN, ctx.config.searchNum || 5)
    mergeEvidence(evidence.map(e => ({ ...e, method: 'agentic', subQuery: query, subScore: denseScores.get(e.id) ?? e.score })))
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
    // 附带关联切片数：模型据此判断是否值得再用 entity_slice 收敛（0 表示该实体无关联切片）
    const detail = res.matchedEntities
      .map(m => `${m.name}(${m.confidence.toFixed(2)}, 切片 ${ctx.entityToBlocksIndex.get(m.name.toLowerCase())?.size || 0})`)
      .join('、')
    return zh(`匹配实体: ${detail}`, `Matched entities: ${detail}`)
  }

  if (name === 'entity_slice') {
    const entityName = String(args.entity || '').trim()
    if (!entityName) return zh('错误：缺少实体名', 'Error: missing entity name')
    // 实体名解析：精确（不区分大小写）→ 唯一包含匹配（模型可能带后缀/括号说明）
    const bid = resolveEntityBlocks(ctx, entityName)
    if (!bid || bid.size === 0) {
      const names = [...ctx.entityToBlocksIndex.keys()].slice(0, 10)
      return zh(`实体「${entityName}」暂无关联切片。可用实体示例：${names.join('、') || '（无）'}`,
        `No slices linked to entity "${entityName}". Example entities: ${names.join(', ') || '(none)'}`)
    }
    // 收敛：仅在该实体的关联切片上，按原始问题做稠密+文件融合检索
    const candidateBlocks = ctx.blocks.filter((b: any) => bid.has(b.id))
    const subCtx: RetrievalContext = { ...ctx, blocks: candidateBlocks }
    const { context, evidence } = await retrieveTopContext(subCtx, ctx.query, toolTopN, ctx.config.searchNum || 5)
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
      .filter(x => x.s > 0.15)                       // 无关键词覆盖的报告不返回，避免按评分先验凑数
      .sort((a, b) => b.s - a.s)
      .slice(0, 3)
    if (!scored.length) {
      return zh('未匹配到与检索词相关的社区报告（可换用 kb_search 检索具体内容）。',
        'No community report matches the query (try kb_search instead).')
    }
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

/** 是否为「有效数值输入」：界面上清空输入会得到 ''、空值可能是 null/undefined，这些都不算提供了值 */
function hasNumericValue(value: unknown): boolean {
  if (value === '' || value === null || value === undefined) return false
  return Number.isFinite(Number(value))
}

/** 归一化正数配置（未提供或非法 → 用默认值） */
function positiveInt(value: unknown, fallback: number): number {
  if (!hasNumericValue(value)) return fallback
  const n = Math.floor(Number(value))
  return n > 0 ? n : fallback
}

/** 归一化 0~1 权重（未提供或非法 → 用默认值） */
function unitWeight(value: unknown, fallback: number): number {
  if (!hasNumericValue(value)) return fallback
  return Math.min(1, Math.max(0, Number(value)))
}

/**
 * 对证据重排相关度（融合「工具通道分」与「原始问题对齐」）：
 * - 基础分：原始问题 vs 证据正文 的余弦相似度（对齐用户问题，保证 topK 裁剪与百分比展示可比）。
 * - 融合：对带 subScore 的证据（kb_search / file_search 等按检索词召回的证据），按 agentSubQueryWeight
 *   加权融合「该证据在检索通道上的分数」（切片/问题/文件/BM25 多通道融合分，量纲同为 0~1 余弦），
 *   避免工具召回的精确证据被内容余弦（单一弱通道）一票否决。默认等权（0.5），可在配置中调节。
 * - 无 subScore 的证据（entity_slice / graph_hop / community）保持纯原始问题相似度：
 *   这些证据的通道分来自局部候选集（局部归一化，量纲与全局不可比）或跳数伪分，不参与融合。
 */
async function rerankEvidenceAgainstQuery(
  ctx: RetrievalContext,
  evidence: Evidence[],
  preQv?: number[] | null,
  /** 工具通道分权重（覆盖 ctx.config.agentSubQueryWeight；Agentic 策略级配置用） */
  subQueryWeight?: number,
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
    // 融合工具通道分（仅带 subScore 的语义检索工具证据生效；量纲 0~1 与余弦一致）
    let finalScore = sim
    if (e.subScore != null) {
      const w = unitWeight(subQueryWeight ?? ctx.config.agentSubQueryWeight, 0.5)
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

  const { tools, dropped } = buildAgenticTools(ctx, def.agentTools)
  // 工具内部候选池：优先策略级设置，其次「处理配置 → 工具候选数」，默认 15。
  // 比最终呈现的 searchNum 更大：工具召回的证据全部并入证据池参与最终重排，
  // 从而抬高召回上限；模型读到的上下文仍只取 searchNum 条（提示词体积不变）。
  const toolTopN = positiveInt(def.agentToolTopN ?? config.agentToolTopN, 15)
  // 重排权重：策略级优先，其次「处理配置 → 子查询重排权重」（0=只用原始问题内容余弦，1=只用工具通道分）
  const subQueryWeight = unitWeight(def.agentSubQueryWeight ?? config.agentSubQueryWeight, 0.5)
  // 暖启动 / 未调工具时的补检索：默认开，可在策略配置里关闭（消融用）
  const warmStart = def.agentWarmStart !== false
  const fallbackEnabled = def.agentFallback !== false
  if (toolTopN < (config.searchNum || 5)) {
    console.warn(`[Strategy/agentic] 工具候选数(${toolTopN}) 小于召回数量(${config.searchNum})：位次最多只能到 ${toolTopN}，建议工具候选数 ≥ 召回数量`)
  }
  result.meta.agentTools = tools.map((t: any) => t.function.name)
  result.meta.agentDroppedTools = dropped
  if (dropped.length) {
    hooks.onProgress?.(zh(`工具「${dropped.join('、')}」暂无可检索数据，本轮已跳过`,
      `Tools without data are skipped: ${dropped.join(', ')}`))
  }
  const systemPrompt = (def.systemPrompt || '').trim() || buildAgenticSystemPrompt(language)
  const messages: any[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: ctx.query },
  ]

  // 预计算原始问题向量（证据重排全程复用，避免每轮工具调用重复嵌入）
  let queryVec: number[] | null = null
  try { queryVec = services.embed ? ((await services.embed(ctx.query)) || null) : null } catch { queryVec = null }

  const blockMap = new Map(ctx.blocks.map((b: any) => [b.id, b]))
  // 证据排序口径（与最终回传一致）：切片级证据（能回源到 block）在前、按相关度降序；
  // 文件级 / 社区级佐证（合成 id）排在其后作补充上下文，避免占用切片位次
  const rankEvidence = (list: Evidence[]): Evidence[] => {
    const sliceLevel: Evidence[] = []
    const support: Evidence[] = []
    for (const e of list) (blockMap.has(e.id) ? sliceLevel : support).push(e)
    const byScore = (a: Evidence, b: Evidence) => (b.score || 0) - (a.score || 0)
    return [...sliceLevel.sort(byScore), ...support.sort(byScore)]
  }
  // 重排统一口径：融合工具通道分（权重 = subQueryWeight）与原始问题内容余弦
  const rerank = (list: Evidence[]) => rerankEvidenceAgainstQuery(ctx, list, queryVec, subQueryWeight)

  const allEvidence: Evidence[] = []
  const seenKeys = new Set<string>()
  const mergeEvidence = async (evidence: Evidence[]) => {
    evidence.forEach(e => {
      const key = e.id || `${e.label}|${e.content}`
      if (seenKeys.has(key)) return
      seenKeys.add(key)
      allEvidence.push(e)
    })
    // 每轮合并后按原始问题重排并排序（工具子查询的分值与伪分值不可比，统一换成语义相关度）
    hooks.onEvidence?.(rankEvidence(await rerank(allEvidence)))
  }

  // 工具调用轨迹（供问答「推理路径」面板与测试页「检索过程」回显）：
  // running 追加新条目，done/error 原地回填最近一条同轮同工具的 running 条目
  const agentSteps: AgentStep[] = []
  const recordStep = (step: AgentStep) => {
    if (step.status === 'running') {
      agentSteps.push(step)
    } else {
      let replaced = false
      for (let i = agentSteps.length - 1; i >= 0; i--) {
        const s = agentSteps[i]
        if (s.round === step.round && s.tool === step.tool && s.status === 'running') {
          agentSteps[i] = step
          replaced = true
          break
        }
      }
      if (!replaced) agentSteps.push(step)
    }
    hooks.onAgentStep?.(step)
  }

  // 兜底保证：先对原始问题做一次稠密检索并合并证据。
  // 使 Agentic 以稠密检索为召回下限（任何情况下都有 top-k 切片佐证），
  // 再由 LLM 通过工具精细化——避免"模型直接回答/未调用检索工具 → 无佐证或证据稀疏"。
  // 该路证据带 subScore（同一检索通道的分数），在最终重排中与 kb_search 结果同等对待，不被内容余弦稀释。
  try {
    const baseTopN = Math.max(1, config.searchNum || 5)
    const { evidence, denseScores } = await retrieveTopContext(ctx, ctx.query, baseTopN)
    await mergeEvidence(evidence.map(e => ({ ...e, method: 'agentic', subQuery: ctx.query, subScore: denseScores.get(e.id) ?? e.score })))
  } catch { /* 基础检索失败不阻塞工具循环 */ }

  // 系统预取（原始问题稠密检索）也记为轨迹首条：即使模型一次工具都不调用，也能看出「到底检索到了什么」
  if (allEvidence.length) {
    recordStep({
      round: 0, kind: 'prefetch', tool: 'kb_search',
      args: { query: ctx.query, retrieval: zh('系统预取（原始问题稠密检索 + 文件通道）', 'system pre-fetch (dense on the original question + file channel)') },
      result: zh(`命中 ${allEvidence.length} 个切片：${allEvidence.slice(0, 8).map(e => `《${e.label}》`).join('、')}`,
        `${allEvidence.length} slices: ${allEvidence.slice(0, 8).map(e => `《${e.label}》`).join(', ')}`),
      status: 'done',
    })
  }

  // 系统预取结果作为「暖启动」交给模型：模型不必再对同一问题重复 kb_search，
  // 首轮即可判断「已有什么、还缺什么」，把有限轮次用在补充检索上（同时减少重复检索耗时）。
  // 可在策略配置里关闭（agentWarmStart=false）以做「有无暖启动」的消融。
  if (allEvidence.length && warmStart) {
    const previewCount = Math.max(1, config.searchNum || 5)
    const preview = allEvidence.slice(0, previewCount)
      .map(e => `《${e.label}》：${String(e.content || '').slice(0, 300)}`)
      .join('\n')
    const hitNote = allEvidence.slice(0, 8).map(e => `《${e.label}》`).join('、')
    messages.push({
      role: 'user',
      content: zh(
        `系统已用原始问题预取 ${allEvidence.length} 个候选片段（命中：${hitNote}），无需再对同一问题重复检索。\n\n${preview}\n\n` +
        `请判断这些资料是否足以回答问题：足够就直接作答并引用《标签》；不足则调用工具补充检索（换更具体或同义的关键词，或用实体 / 文件 / 社区 / 图谱工具做定向补充）。`,
        `The system pre-fetched ${allEvidence.length} candidate snippets for the original question (hits: ${hitNote}); do not repeat the same search.\n\n${preview}\n\n` +
        `Decide whether this is enough: if yes, answer directly citing 《label》; if not, call tools to supplement (use more specific synonyms, or entity / file / community / graph tools).`,
      ),
    })
  }

  let answer = ''
  // 模型是否真正调用过检索工具（用于诊断「只调了一轮大模型 / 没有工具调用记录」）
  let modelUsedTools = false
  // 模型不调工具时是否已做过一次确定性补充召回（只补一次，避免空转）
  let fallbackDone = false
  /** 本次运行内的工具结果缓存（工具 + 参数 → 结果）：同参数重复调用直接复用，避免重复检索 */
  const toolResultCache = new Map<string, string>()

  /**
   * 确定性补充召回：模型未调用任何工具时，按「已启用且有数据」的通道补齐系统预取未覆盖的召回
   * （实体关联切片 / 图谱多跳 / 文件 / 社区），并把这些步骤记入轨迹（标为「系统补检索」）。
   * 作用：模型/服务不支持 function calling 时，Agentic 仍是多路召回，而不是退化成单轮稠密检索。
   */
  const runFallbackRound = async (): Promise<string[]> => {
    const outs: string[] = []
    if (!fallbackEnabled) return outs
    const isOn = (t: string) => !def.agentTools || def.agentTools[t] !== false
    const call = async (tool: string, args: any): Promise<string> => {
      if (!isOn(tool) || !agentToolAvailable(tool, ctx)) return ''
      recordStep({ round: 1, kind: 'fallback', tool, args, result: '', status: 'running' })
      try {
        const r = await executeAgenticTool(tool, args, ctx, mergeEvidence, toolTopN)
        recordStep({ round: 1, kind: 'fallback', tool, args, result: r, status: 'done' })
        if (r && !/未匹配到|暂无|未构建|未找到/.test(r)) outs.push(r)
        return r
      } catch (e: any) {
        recordStep({ round: 1, kind: 'fallback', tool, args, result: String(e?.message || e), status: 'error' })
        return ''
      }
    }
    // 实体通道：定位实体 → 取关联切片（可选再沿关系扩 1 跳）
    if (isOn('entity_link') && agentToolAvailable('entity_link', ctx)) {
      const link = await entityLink({ ...ctx, query: ctx.query }).catch(() => ({ matchedEntities: [] as MatchedEntity[] }))
      const names = (link.matchedEntities || []).slice(0, 2).map((m: MatchedEntity) => m.name)
      if (names.length) {
        recordStep({
          round: 1, kind: 'fallback', tool: 'entity_link', args: { query: ctx.query },
          result: zh(`匹配实体: ${names.join('、')}`, `Matched entities: ${names.join(', ')}`), status: 'done',
        })
        if (isOn('entity_slice') && agentToolAvailable('entity_slice', ctx)) {
          for (const n of names.slice(0, 1)) await call('entity_slice', { entity: n })
        }
        if (isOn('graph_hop') && agentToolAvailable('graph_hop', ctx)) {
          for (const n of names.slice(0, 1)) await call('graph_hop', { entity: n, hops: 1 })
        }
      }
    }
    if (isOn('file_search') && agentToolAvailable('file_search', ctx)) await call('file_search', { query: ctx.query })
    if (isOn('community_search') && agentToolAvailable('community_search', ctx)) await call('community_search', { query: ctx.query })
    if (outs.length) {
      result.meta.agentFallback = true
      hooks.onProgress?.(zh('模型未调用检索工具，已按可用通道做一次补充召回',
        'Model called no tools; ran a deterministic supplementary retrieval round'))
    }
    return outs
  }

  try {
    for (let round = 0; round < (def.maxRounds ?? 5); round++) {
      const response = await services.agenticChat(messages, tools)
      result.meta.llmCalls++
      const toolCalls = response.tool_calls || []
      const content = (response.content || '').trim()

      if (toolCalls.length === 0) {
        // 记录本轮「模型决策」：让「为什么只调了一轮大模型 / 有没有检索到东西」一眼可见
        const textCall = !modelUsedTools ? detectToolCallInText(content, tools) : ''
        recordStep({
          round: round + 1, kind: 'model', tool: '', args: {},
          status: textCall ? 'error' : 'done',
          note: modelUsedTools
            ? zh('模型给出最终回答（本轮无工具调用）', 'Final answer (no tool call this round)')
            : zh('模型未调用任何检索工具，直接作答', 'The model answered without calling any retrieval tool'),
          result: [
            textCall
              ? zh(`检测到模型把工具调用写成了正文（${textCall}）：所用服务/模型可能不支持 function calling；下方已按可用通道做一次确定性补充召回。`,
                `Tool call found in plain text (${textCall}): the served model may not support function calling; a deterministic supplementary round was run below.`)
              : '',
            content ? content.slice(0, 600) : zh('（模型返回空正文）', '(empty response)'),
          ].filter(Boolean).join('\n'),
        })

        // 模型迟迟不用工具 → 先做一次确定性补充召回，再决定是否收尾
        if (!modelUsedTools && !fallbackDone) {          fallbackDone = true
          const added = await runFallbackRound()
          if (added.length && !opts.skipAnswer) {
            // 问答：把补充资料交给模型再答一轮（下一轮若仍无工具调用则采用其正文）
            messages.push({
              role: 'user',
              content: `${zh('系统补充检索结果（供参考，勿重复检索）：', 'Supplementary retrieval (for reference, do not repeat the search):')}\n${added.join('\n\n')}`,
            })
            continue
          }
          // 测试（只需召回）或没有可补通道 → 直接采用本轮正文
        }

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

      modelUsedTools = true
      const toolResults: string[] = []
      for (const tc of toolCalls) {
        let args: any = {}
        try {
          args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {})
        } catch { args = {} }
        const toolName = tc.function?.name || 'unknown'
        // 同一轮内重复调用同一工具+同一参数 → 复用上次结果（检索在同一次运行内是确定性的），
        // 省一次检索耗时，也让模型看到「这是重复调用」而不误以为有新信息
        const cacheKey = `${toolName}|${JSON.stringify(args)}`
        if (toolResultCache.has(cacheKey)) {
          const cached = zh('（与上次相同参数，复用上次检索结果）\n', '(same args as before; reusing the previous result)\n') + toolResultCache.get(cacheKey)!
          recordStep({ round: round + 1, kind: 'tool', tool: toolName, args, result: cached, status: 'done', note: zh('重复调用，复用结果', 'duplicate call, reused') })
          toolResults.push(cached)
          continue
        }
        hooks.onProgress?.(zh(`执行工具 ${toolName}...（第 ${round + 1} 轮）`, `Running ${toolName}... (round ${round + 1})`))
        recordStep({ round: round + 1, kind: 'tool', tool: toolName, args, result: '', status: 'running' })
        // 工具开关：被禁用的工具直接跳过（正常情况下工具列表已过滤，此为兜底）
        if (def.agentTools && def.agentTools[toolName] === false) {
          const msg = zh('该工具已禁用', 'Tool disabled')
          recordStep({ round: round + 1, kind: 'tool', tool: toolName, args, result: msg, status: 'error' })
          toolResults.push(msg)
          continue
        }
        try {
          const tr = await executeAgenticTool(toolName, args, ctx, mergeEvidence, toolTopN)
          toolResultCache.set(cacheKey, tr)
          recordStep({ round: round + 1, kind: 'tool', tool: toolName, args, result: tr, status: 'done' })
          toolResults.push(tr)
        } catch (e: any) {
          recordStep({ round: round + 1, kind: 'tool', tool: toolName, args, result: String(e?.message || e), status: 'error' })
          toolResults.push(zh(`工具执行失败: ${e?.message || e}`, `Tool failed: ${e?.message || e}`))
        }
      }

      messages.push({ role: 'assistant', content: response.content || '', tool_calls: toolCalls })
      // 工具结果按各来源口径回传：OpenAI 兼容用 tool_call_id，Ollama 用 tool_name
      // （两个字段都带上，各来源只取自己认识的；缺失 tool_call_id 的 tool 消息会被严格校验的服务拒绝）
      toolCalls.forEach((tc: any, i: number) => messages.push({
        role: 'tool',
        tool_call_id: tc.id || `call_${round}_${i}`,
        tool_name: tc.function?.name,
        name: tc.function?.name,
        content: toolResults[i] ?? '',
      }))
    }
  } catch (err: any) {
    // 模型不支持 tools → 退化为单次 dense 检索 + 回答
    console.warn('[Strategy/agentic] 模型不支持 tools，退化为单次检索:', err?.message || err)
    result.meta.agentDegraded = true
    hooks.onProgress?.(zh('模型未返回工具调用，已退化为单次检索', 'Model returned no tool calls; degraded to a single retrieval'))
    const { context, evidence, denseScores } = await retrieveTopContext(ctx, ctx.query, config.searchNum || 5)
    await mergeEvidence(evidence.map(e => ({ ...e, method: 'agentic', subQuery: ctx.query, subScore: denseScores.get(e.id) ?? e.score })))
    messages.push({ role: 'user', content: `${ctx.query}\n\n参考资料：\n${context || ''}` })
    // 仅需召回（如测试）时跳过回答生成，证据已合并
    if (services.streamChat && !opts.skipAnswer) {
      answer = await services.streamChat(messages, chunk => hooks.onStream?.(chunk))
    }
  }

  // 诊断：模型全程未用工具时明确记录（含已下发工具数与 chat 模型），并在已做补充召回时标注
  result.meta.agentNoToolCalls = !modelUsedTools
  if (!modelUsedTools) {
    console.warn(`[Strategy/agentic] 模型未返回任何工具调用（已下发 ${tools.length} 个工具定义，chat=${config.chat || '未指定'}）` +
      (fallbackDone ? '；已执行确定性补充召回' : '；无可用补充通道'))
  }

  // 多轮检索后仍未产出正文（模型一直调工具到 maxRounds 用尽等）→ 基于已收集证据强制生成答案
  if (!opts.skipAnswer && !answer) {
    const rankedNow = rankEvidence(await rerank(allEvidence))
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

  // 收尾：按原始问题重排 + 排序后回传（排序在策略内收口：调用方按 top-K 取用时即按相关度取样，
  // 避免按「证据拼接顺序」截断而丢掉工具召回的证据——原先 agentic 因此退化为与单轮稠密检索等价）。
  const ranked = rankEvidence(await rerank(allEvidence))
  result.answer = answer || ''
  result.evidence = ranked
  result.scores = new Map(ranked.map(e => [e.id, e.score || 0]))
  result.sortedBlocks = ranked.map(e => {
    const b = blockMap.get(e.id)
    const score = e.score || 0
    return b ? { ...b, p: score } : { id: e.id, label: e.label || '', filePath: e.filePath || '', A: e.content || '', p: score }
  })
  result.context = ranked
    .filter(e => blockMap.has(e.id))
    .slice(0, Math.max(1, config.searchNum || 5))
    .map(e => `《${e.label}》：${e.content}`)
    .join('\n')
  result.meta.agentSteps = agentSteps
  hooks.onEvidence?.(ranked)
  return result
}

// ========== 统一入口 ==========

/**
 * 用「指定的策略定义」执行检索。
 * 与 runStrategy 的唯一区别：不按 id 去注册表查定义，而是直接执行传入的 def。
 * 用途：消融实验——同一策略的多个参数变体（改步骤参数 / 通道开关 / 轮次上限等）各自独立运行，
 * 不需要污染全局策略注册表；变体的 def.id 即变体 id（结果按该 id 归属统计）。
 */
export async function runStrategyWith(
  def: StrategyDef,
  query: string,
  ctx: RetrievalContext,
  hooks: StrategyHooks = {},
  opts: { skipAnswer?: boolean } = {},
): Promise<StrategyResult> {
  if (!def) throw new Error('runStrategyWith: strategy def is required')
  const fullCtx: RetrievalContext = { ...ctx, query }
  switch (def.kind) {
    case 'pipeline': return runPipeline(def, fullCtx, hooks)
    case 'mapreduce': return runMapReduce(def, fullCtx, hooks, opts)
    case 'agentic': return runAgentic(def, fullCtx, hooks, opts)
    case 'hybrid': return runHybrid(def, fullCtx, hooks, opts)
  }
}

export async function runStrategy(
  id: string,
  query: string,
  ctx: RetrievalContext,
  hooks: StrategyHooks = {},
  opts: { skipAnswer?: boolean } = {},
): Promise<StrategyResult> {
  const def = getStrategy(id)
  if (!def) throw new Error(`Unknown strategy: ${id}`)
  return runStrategyWith(def, query, ctx, hooks, opts)
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
