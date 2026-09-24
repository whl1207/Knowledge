// GraphRAG 风格的提取提示词模板
// 参考 Microsoft GraphRAG 的 prompt 设计

/**
 * 生成实体和关系抽取的系统提示词
 * 参考 GraphRAG GRAPH_EXTRACTION_PROMPT 的设计
 */
export function buildExtractionSystemPrompt(params: {
  entityTypes: string
  relationTypes: string
  contextPrompt?: string
  language?: string
}): string {
  const { entityTypes, relationTypes, contextPrompt, language = 'zh' } = params

  const prompt = language === 'zh'
    ? `你是一个知识图谱构建专家。请从文本中提取所有实体以及实体之间的关系。

## 实体类型
可提取的实体类型包括：${entityTypes}

## 关系类型说明
${relationTypes}

## 提取规则
1. 识别所有符合实体类型的命名实体
2. 为每个实体提供准确、完整的描述
3. 识别实体之间明确的关系
4. 为每个关系评估强度（1-10分）

## 输出格式
必须返回严格的JSON格式，不要包含任何其他内容：

{
  "entities": [
    {"name": "实体名称", "type": "实体类型", "description": "实体描述"}
  ],
  "relations": [
    {"source": "源实体", "target": "目标实体", "type": "关系类型", "description": "关系描述", "strength": 8}
  ]
}

## 注意事项
1. 实体名称为原始文本中的名称，保持原样
2. 实体描述应是基于文本内容的客观概括
3. 关系强度1-10，10为最强关联
4. 如果文本中没有合适的实体或关系，返回空数组
5. 只返回JSON，不要有任何其他内容
6. 确保JSON格式正确，可以被直接解析
${contextPrompt || ''}`

    : `You are a knowledge graph construction expert. Extract all entities and their relationships from the text.

## Entity Types
Available entity types: ${entityTypes}

## Relation Types
${relationTypes}

## Extraction Rules
1. Identify all named entities matching the entity types
2. Provide accurate, complete descriptions for each entity
3. Identify clear relationships between entities
4. Rate relationship strength (1-10)

## Output Format
Return strict JSON format only:

{
  "entities": [
    {"name": "Entity Name", "type": "entity_type", "description": "Entity description"}
  ],
  "relations": [
    {"source": "Source Entity", "target": "Target Entity", "type": "relation_type", "description": "Relation description", "strength": 8}
  ]
}

## Notes
1. Entity names should be exactly as they appear in the text
2. Descriptions should be objective summaries based on text
3. Relationship strength: 1-10, 10 being strongest
4. Return empty arrays if no suitable entities or relations found
5. Return JSON only, no other content
${contextPrompt || ''}`

  return prompt
}

/**
 * 生成实体描述推理提示词
 * 参考 GraphRAG summarize_descriptions 的设计
 */
export function buildEntityDescriptionPrompt(params: {
  entityName: string
  entityTypes: string
  content: string
  language?: string
  /**
   * 自定义提示词模板（可选）
   * 支持占位符：{{entityName}} {{entityTypes}} {{content}} {{language}}
   * 留空或未提供时使用默认提示词
   */
  customPrompt?: string
}): string {
  const { entityName, entityTypes, content, language = 'zh', customPrompt } = params

  // 如果提供了自定义提示词模板，则替换占位符后返回
  if (customPrompt && customPrompt.trim()) {
    return customPrompt
      .replace(/\{\{entityName\}\}/g, entityName)
      .replace(/\{\{entityTypes\}\}/g, entityTypes)
      .replace(/\{\{content\}\}/g, content)
      .replace(/\{\{language\}\}/g, language)
  }

  return language === 'zh'
    ? `你是一个知识图谱专家。请根据提供的文本内容，为实体"${entityName}"生成一个准确、完整的描述。

实体类型参考：${entityTypes}

要求：
1. 描述应完全基于提供的文本，不要添加外部知识
2. 概括该实体的核心特征、定义、职能或作用
3. 如果文本中有多个方面的信息，应综合概括
4. 描述应简洁明了，控制在200字以内
5. 不要用引号包裹整个描述
6. 只返回描述文本，不要有任何其他内容

文本内容：
${content}`
    : `You are a knowledge graph expert. Generate an accurate and complete description for the entity "${entityName}" based on the provided text.

Reference entity types: ${entityTypes}

Requirements:
1. Description must be based entirely on the provided text, no external knowledge
2. Summarize the entity's core characteristics, definition, function or role
3. Synthesize information from multiple aspects if present
4. Keep the description concise, within 200 characters
5. Do not wrap the entire description in quotes
6. Return the description text only

Text content:
${content}`
}

/**
 * 生成查询实体匹配提示词
 */
export function buildQueryEntityMatchPrompt(params: {
  query: string
  entityNames: string[]
  language?: string
}): string {
  const { query, entityNames, language = 'zh' } = params

  return language === 'zh'
    ? `用户查询: "${query}"

已知实体列表: ${entityNames.join(', ')}

请分析用户查询，找出查询中明确提到或高度相关的实体。
返回JSON格式：
{
  "matchedEntities": ["实体1", "实体2"],
  "reasoning": "匹配理由"
}

只返回JSON，不要有任何其他内容。`
    : `User query: "${query}"

Known entity list: ${entityNames.join(', ')}

Analyze the user query and find entities that are explicitly mentioned or highly relevant.
Return JSON format:
{
  "matchedEntities": ["Entity1", "Entity2"],
  "reasoning": "Matching reasoning"
}

Return JSON only.`
}

// ===== 社区报告生成 =====

/**
 * 生成社区报告的提示词
 * 参考 GraphRAG COMMUNITY_REPORT_PROMPT
 */
export function buildCommunityReportPrompt(params: {
  communityName: string
  entityNames: string[]
  contextText: string
  language?: string
}): string {
  const { communityName, entityNames, contextText, language = 'zh' } = params

  return language === 'zh'
    ? `你是一个知识图谱分析专家。请为以下知识领域生成一份结构化的分析报告。

## 领域名称
${communityName}

## 包含的实体
${entityNames.join('、')}

## 相关文本内容
${contextText.substring(0, 4000)}

## 报告要求
请生成包含以下结构的 JSON 报告：
{
  "title": "领域标题（简洁，10字以内）",
  "summary": "领域摘要（100字以内，概括该领域的核心内容）",
  "rating": 8.5,
  "findings": [
    {"summary": "发现要点标题", "explanation": "详细说明"}
  ]
}

要求：
1. title 应准确反映该领域的主题
2. summary 应概括核心信息和关键特征
3. findings 列出 3-5 个关键发现，每个发现包含简要总结和详细说明
4. rating 是 0-10 的浮点数，反映该领域的重要性
5. 所有内容必须基于提供的文本，不要添加外部知识
6. 只返回JSON，不要有任何其他内容`
    : `You are a knowledge graph analysis expert. Generate a structured analysis report for the following knowledge domain.

## Domain Name
${communityName}

## Entities
${entityNames.join(', ')}

## Related Text
${contextText.substring(0, 4000)}

## Requirements
Generate a JSON report with the following structure:
{
  "title": "Domain title (concise, under 10 words)",
  "summary": "Domain summary (under 100 words)",
  "rating": 8.5,
  "findings": [
    {"summary": "Finding title", "explanation": "Detailed explanation"}
  ]
}

Requirements:
1. Title should accurately reflect the domain topic
2. Summary should cover core information and key features
3. Findings list 3-5 key findings with summary and explanation
4. Rating is 0-10 float reflecting domain importance
5. All content must be based on provided text only
6. Return JSON only, no other content`
}

// ===== 多阶段搜索提示词 =====

/**
 * Map 阶段提示词：每个批次生成中间回答
 * 参考 GraphRAG MAP_SYSTEM_PROMPT
 */
export function buildMapPrompt(params: {
  contextData: string
  query: string
  maxLength: number
  language?: string
}): string {
  const { contextData, query, maxLength, language = 'zh' } = params

  return language === 'zh'
    ? `---角色---
你是一个数据分析师。你需要根据提供的参考资料回答用户问题。

---参考资料---
${contextData.substring(0, 3000)}

---任务---
请根据以上参考资料回答用户问题，然后对你的回答准确性评分。

用户问题：${query}

返回JSON格式（只返回JSON，不要有其他内容）：
{
  "points": [
    {"description": "关键点描述（不超过${maxLength}字）", "score": 85}
  ]
}

注意：
- points 数组包含 1-3 个关键点
- 每个 key point 的 score 是 0-100 的整数
- 如果参考资料与问题无关，score 返回 0`
    : `---Role---
You are a data analyst. Answer the user's question based on the provided reference materials.

---Reference Materials---
${contextData.substring(0, 3000)}

---Task---
Answer the user's question based on the reference materials, then rate the accuracy of your answer.

User question: ${query}

Return JSON format (JSON only):
{
  "points": [
    {"description": "Key point description (max ${maxLength} chars)", "score": 85}
  ]
}

Note:
- points array contains 1-3 key points
- Each point score is 0-100 integer
- If materials are irrelevant, return score 0`
}

/**
 * Reduce 阶段提示词：合并多个中间回答
 * 参考 GraphRAG REDUCE_SYSTEM_PROMPT
 */
export function buildReducePrompt(params: {
  analystReports: string
  query: string
  maxLength: number
  language?: string
}): string {
  const { analystReports, query, maxLength, language = 'zh' } = params

  return language === 'zh'
    ? `---角色---
你是一位高级分析师。请综合多位分析师的观点，生成一个完整的最终回答。

---分析师报告---
${analystReports}

---要求---
1. 优先采用评分高的分析师的观点
2. 合并互补的信息，避免重复
3. 生成连贯、全面的最终回答
4. 最终回答不超过${maxLength}字

用户问题：${query}`
    : `---Role---
You are a senior analyst. Synthesize multiple analyst perspectives into a complete final answer.

---Analyst Reports---
${analystReports}

---Requirements---
1. Prioritize higher-scored analysts' viewpoints
2. Merge complementary information, avoid repetition
3. Generate a coherent, comprehensive final answer
4. Final answer should not exceed ${maxLength} characters

User question: ${query}`
}
