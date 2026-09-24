// GraphRAG 风格的类型定义
// 参考 Microsoft GraphRAG 数据模型设计

export interface ExtractedEntity {
  name: string
  type: string        // 实体类型，如 person, organization, geo, event, concept
  description: string
}

export interface ExtractedRelation {
  source: string
  target: string
  type: string        // 关系类型，如 is_a, part_of, depends_on, related_to
  description: string
  strength: number    // 关系强度 1-10
}

export interface BatchExtractionResult {
  entities: ExtractedEntity[]
  relations: ExtractedRelation[]
}

// GraphRAG 风格的社区定义
export interface Community {
  id: number          // 社区编号
  level: number       // 层次（Louvain/LPA 保留）
  entityIds: string[] // 包含的实体ID
  entityNames: string[]
  size: number
}

export interface CommunityDetectionResult {
  /** entityId → communityId */
  assignments: Map<string, number>
  /** communityId → Community */
  communities: Map<number, Community>
  /** 模块度（0~1，越高越好） */
  modularity: number
  /** 社区数量 */
  count: number
}

// 实体描述推理策略
export interface EntityDescriptionContext {
  combinedContent: string
  blockCount: number
  entityName: string
  entityType: string
}

// ===== 多阶段搜索类型 =====

/** 社区报告（LLM 生成） */
export interface CommunityReport {
  communityId: number
  title: string
  summary: string
  findings: Array<{ summary: string; explanation: string }>
  rating: number
  /** 社区稳定签名（成员实体 ID 集合哈希，用于增量报告复用判定） */
  signature?: string
}

/** Map 阶段中间结果 */
export interface MapResult {
  analystId: number
  answer: string
  score: number
  sourceCommunityId: number
}

/** Map-Reduce 搜索结果 */
export interface MultiStageSearchResult {
  answer: string
  mapResults: MapResult[]
  contextBlocks: string[]
  llmCalls: number
}
