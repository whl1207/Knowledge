<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { ElMessageBox } from 'element-plus'
import { deepSeekStyleOf, normalizeLlmType } from '@/shared/llmSources'
import strategyConfig from '@/components/knowRAG/strategyConfig.vue'

// 定义组件接口
interface Props {
  store: any
  model: any
  getModel: () => Promise<void>
}

const props = defineProps<Props>()

// 定义类型
interface ConfigGroup {
  title: string
  icon: string
  description: string
}

interface ConfigItemOption {
  value?: string
  label?: string
  name?: string
  size?: number
}

interface ConfigItem {
  group: string
  key: string
  label: string
  labelEn: string
  type: 'text' | 'select' | 'number' | 'range' | 'textarea' | 'checkbox' | 'display' | 'embed'
  placeholder?: string
  placeholderEn?: string
  description: string
  descriptionEn: string
  options?: ConfigItemOption[] | any
  min?: number
  max?: number
  step?: number
  value?: string | (() => string)
  show?: () => boolean
}

interface KnowledgeBaseFile {
  label: string
  path: string
  config?: {
    embedModel?: string
    timestamp?: string
    version?: string
    blockCount?: number
    /** 是否把向量数据写入 .kb（false=精简模式，向量按需在首次问答重新推导） */
    saveVectors?: boolean
  }
  metadata?: {
    blockCount?: number
    hasEmbeddings?: boolean
    hasQuestions?: boolean
    avgVectorDimension?: number
    reasonedCount?: number
    /** 问题库活动问题总数（含手动/导入，未合并） */
    questionCount?: number
    fileCount?: number
  }
  ontology?: {
    entities?: number
    relations?: number
    communityCount?: number
    communityReportCount?: number
  }
}

// 本地化文本
const t = (zh: string, en: string): string => {
  return props.store.locales === 'zh' ? zh : en
}

// 配置分组（顺序即侧边栏顺序：知识库配置 → 策略配置 → 处理配置）
const configGroups = computed<Record<string, ConfigGroup>>(() => ({
  knowledgebase: {
    title: t('知识库配置', 'Knowledge Base Configuration'),
    icon: 'fa fa-database',
    description: t('知识库文件管理', 'Knowledge Base File Management')
  },
  strategy: {
    title: t('策略配置', 'Strategy Configuration'),
    icon: 'fa fa-cubes',
    description: t('检索策略：原语组合、参数与检索参数', 'Retrieval Strategy: primitive composition, params & retrieval params')
  },
  process: {
    title: t('处理配置', 'Processing Configuration'),
    icon: 'fa fa-cogs',
    description: t('切片、问题处理与本体推理配置', 'Slicing, Question Processing & Ontology Configuration')
  }
}))

// 知识库文件列表
const knowledgeBases = ref<KnowledgeBaseFile[]>([])
const isLoadingKb = ref(false)
const selectedKbIndex = ref(-1)
const kbScanPath = ref('')

// 配置项
const configItems = computed<ConfigItem[]>(() => [
  {
    group: 'process',
    key: 'embed',
    label: '嵌入模型',
    labelEn: 'Embedding Model',
    type: 'embed',
    description: '知识库切片/问题的向量化所用嵌入模型。选择「跟随默认」则使用设置页中配置的默认嵌入模型；选择其它模型后，会清空旧向量并用新模型重新向量化切片与问题（否则新旧向量维度不一致会导致检索失效）。',
    descriptionEn: 'Embedding model used to vectorize KB slices & questions. "Follow default" uses the default embedding model from Settings. Choosing another model clears old vectors and re-embeds slices & questions with it (mixed-dimension vectors break retrieval).'
  },
  {
    group: 'process',
    key: 'saveVectors',
    label: '保存向量数据到 KB 文件',
    labelEn: 'Save Vectors into KB File',
    type: 'checkbox',
    description: '开启（默认）：切片/文件摘要/问题向量写入 .kb，检索快但文件大。关闭：不把向量写入 .kb，KB 文件大幅精简；首次问答时用当前嵌入模型按需重新向量化（首次较慢，会话内缓存复用；需保持嵌入模型一致以免维度不匹配，重新开启并保存后向量会再写入）。',
    descriptionEn: 'ON (default): block/file-summary/question vectors are stored in the .kb (fast retrieval but larger file). OFF: vectors are NOT stored, so the .kb is much smaller; vectors are re-derived on first Q&A with the current embed model (slow first time, cached per session; keep the same embed model to avoid dimension mismatch, re-enable + save to write them back).'
  },
  {
    group: 'search',
    key: 'searchMethod',
    label: '检索方法',
    labelEn: 'Search Method',
    type: 'select',
    options: [
      { value: 'CS', label: t('余弦相似度 (CS)', 'Cosine Similarity (CS)') },
      { value: 'CS(M)', label: t('合并余弦相似度 (CS(M))', 'Merged Cosine Similarity (CS(M))') },
      { value: 'MDS', label: t('多维缩放 (MDS)', 'Multidimensional Scaling (MDS)') },
      { value: 'MDS(M)', label: t('合并多维缩放 (MDS(M))', 'Merged MDS (MDS(M))') },
      { value: 'PCA', label: t('主成分分析 (PCA)', 'Principal Component Analysis (PCA)') }
    ],
    description: '向量相似度计算方法',
    descriptionEn: 'Vector similarity calculation method'
  },
  {
    group: 'search',
    key: 'searchMode',
    label: '检索模式',
    labelEn: 'Search Mode',
    type: 'select',
    options: [
      { value: t('按数量', 'By Count'), label: t('按数量', 'By Count') },
      { value: t('按匹配率', 'By Match Rate'), label: t('按匹配率', 'By Match Rate') },
      { value: t('按字符', 'By Characters'), label: t('按字符', 'By Characters') }
    ],
    description: '知识片段召回策略',
    descriptionEn: 'Knowledge fragment retrieval strategy'
  },
  {
    group: 'search',
    key: 'searchNum',
    label: '检索数量',
    labelEn: 'Search Count',
    type: 'number',
    min: 1,
    max: 20,
    show: () => props.model.searchMode === t('按数量', 'By Count'),
    description: '按数量检索时返回的片段数',
    descriptionEn: 'Number of fragments to return when searching by count'
  },
  {
    group: 'search',
    key: 'matchRatio',
    label: '匹配率阈值',
    labelEn: 'Match Ratio Threshold',
    type: 'number',
    min: 0,
    max: 1,
    step: 0.01,
    show: () => props.model.searchMode === t('按匹配率', 'By Match Rate'),
    description: '按匹配率检索时的相似度阈值',
    descriptionEn: 'Similarity threshold when searching by match rate'
  },
  {
    group: 'search',
    key: 'searchCharacter',
    label: '字符限制',
    labelEn: 'Character Limit',
    type: 'number',
    min: 100,
    max: 10000,
    show: () => props.model.searchMode === t('按字符', 'By Characters'),
    description: '按字符检索时的最大字符数',
    descriptionEn: 'Maximum characters when searching by characters'
  },
  {
    group: 'search',
    key: 'summaryWeight',
    label: '增强权重',
    labelEn: 'Enhance Weight',
    type: 'range',
    min: 0,
    max: 1,
    step: 0.01,
    description: '语义增强相似度在综合评分中的权重（摘要向量 + 问题向量）',
    descriptionEn: 'Weight of semantic enhancement similarity in comprehensive score (summary + question vectors)'
  },
  {
    group: 'search',
    key: 'sliceWeight',
    label: '片段权重',
    labelEn: 'Fragment Weight',
    type: 'display',
    value: () => (1 - props.model.summaryWeight).toFixed(2),
    description: '片段相似度在综合评分中的权重（自动计算）',
    descriptionEn: 'Weight of fragment similarity in comprehensive score (auto calculated)'
  },
  {
    group: 'search',
    key: 'bm25Enabled',
    label: '启用BM25检索',
    labelEn: 'Enable BM25 Search',
    type: 'checkbox',
    description: '是否启用BM25算法进行检索（与余弦相似度混合使用）',
    descriptionEn: 'Whether to enable BM25 algorithm for search (mixed with cosine similarity)'
  },
  {
    group: 'search',
    key: 'bm25Weight',
    label: 'BM25权重',
    labelEn: 'BM25 Weight',
    type: 'range',
    min: 0,
    max: 1,
    step: 0.01,
    show: () => props.model.bm25Enabled,
    description: 'BM25算法在综合评分中的权重',
    descriptionEn: 'Weight of BM25 algorithm in comprehensive score'
  },
  {
    group: 'process',
    key: 'sliceStrategy',
    label: '切片策略',
    labelEn: 'Slice Strategy',
    type: 'select',
    options: [
      { value: '语义', label: t('语义（按主题相似度切分）', 'Semantic (Split by topic similarity)') },
      { value: '智能', label: t('智能（按一级标题切分）', 'Smart (Split by top-level headings)') },
      { value: '标识符', label: t('标识符（按多个空行切分）', 'Identifier (Split by empty lines)') }
    ],
    description: '文档切片时使用的策略',
    descriptionEn: 'Strategy used for document slicing'
  },
  {
    group: 'process',
    key: 'agentSubQueryWeight',
    label: '子查询重排权重',
    labelEn: 'Sub-query Rerank Weight',
    type: 'range',
    min: 0,
    max: 1,
    step: 0.05,
    description: '仅 Agentic 生效：最终重排时融合「工具子查询检索分数」与「原始问题相似度」，值越高越偏向子查询召回的精确结果（0=只用原始问题，1=只用子查询分数）',
    descriptionEn: 'Agentic only: final rerank blends tool sub-query retrieval score with original-question similarity. Higher = favor precise sub-query recall (0 = original query only, 1 = sub-query score only)'
  },
  {
    group: 'process',
    key: 'sliceMaxChars',
    label: '切片最大字符数',
    labelEn: 'Max Chars Per Slice',
    type: 'number',
    min: 500,
    max: 20000,
    step: 100,
    description: '单个切片的最大字符数，超过的切片会按句子二次切分',
    descriptionEn: 'Max characters per slice; oversized slices are re-split by sentences'
  },
  {
    group: 'process',
    key: 'sliceOverlapChars',
    label: '切片重叠字符数',
    labelEn: 'Slice Overlap Chars',
    type: 'number',
    min: 0,
    max: 2000,
    step: 50,
    description: '相邻切片首尾重叠的字符数（仅用于向量化，不改变展示原文）',
    descriptionEn: 'Chars of overlap between adjacent slices (used only for embedding, not for display)'
  },
  {
    group: 'process',
    key: 'semanticSplitThreshold',
    label: '语义切分阈值',
    labelEn: 'Semantic Split Threshold',
    type: 'range',
    min: 0.5,
    max: 0.99,
    step: 0.01,
    show: () => props.model.sliceStrategy === '语义',
    description: '语义切分时相邻片段相似度低于此值视为主题边界（越低切分越粗）',
    descriptionEn: 'Adjacent segment similarity below this is a topic boundary (lower = coarser split)'
  },
  {
    group: 'process',
    key: 'maxTestCases',
    label: '测试用例上限',
    labelEn: 'Max Test Cases',
    type: 'number',
    min: 1,
    max: 5000,
    step: 50,
    description: '测试页自动生成测试用例的最大条数（按推理问题逐行拆分后截取）',
    descriptionEn: 'Max number of test cases auto-generated in Test tab (after splitting inferred questions by line)'
  },
  {
    group: 'process',
    key: 'questionDedupThreshold',
    label: '问题去重阈值',
    labelEn: 'Question Dedup Threshold',
    type: 'range',
    min: 0,
    max: 0.99,
    step: 0.01,
    show: () => props.model.questionDedupEnabled,
    description: '问题语义相似度≥此值判定为重复（保留答案更贴合者）',
    descriptionEn: 'Questions with semantic similarity ≥ this are duplicates (keep the better-fitting answer)'
  },
  {
    group: 'process',
    key: 'questionDedupEnabled',
    label: '自动处理问题去重',
    labelEn: 'Auto Dedup Questions',
    type: 'checkbox',
    description: '从知识库读取用例后，对语义相似的问题自动去重并择优答案；关闭则不处理',
    descriptionEn: 'After loading cases from KB, auto-dedup semantically similar questions and keep the better answer; off = no processing'
  },
  {
    group: 'process',
    key: 'questionMergeEnabled',
    label: 'LLM合并相似问题',
    labelEn: 'LLM Merge Similar Questions',
    type: 'checkbox',
    description: '对判重的问题调用LLM综合成一条更完整规范的问题，并择优/合并答案；关闭则保留原问题表述',
    descriptionEn: 'Merge duplicate questions into one more complete one via LLM, pick/merge answers; off = keep original wording'
  },
  // ==================== 本体推理描述词配置（并入处理配置） ====================
  {
    group: 'process',
    key: 'ontologyEntityTypes',
    label: '实体类型描述词',
    labelEn: 'Entity Type Descriptors',
    type: 'textarea',
    placeholder: '概念、对象、事物、主体、人物、组织、地点等',
    placeholderEn: 'concepts, objects, things, subjects, people, organizations, places, etc.',
    description: '本体构建时AI识别实体的类型描述词，用中文顿号分隔',
    descriptionEn: 'Entity type descriptors for AI during ontology building, separated by commas'
  },
  {
    group: 'process',
    key: 'ontologyRelationTypes',
    label: '关系类型描述词',
    labelEn: 'Relation Type Descriptors',
    type: 'textarea',
    placeholder: '- **is_a**：继承关系。例如："医疗保险" is_a "保险合同"',
    placeholderEn: '- **is_a**: Inheritance relationship',
    description: '本体构建时AI识别关系类型的描述，每行一个关系类型定义',
    descriptionEn: 'Relation type descriptors for AI during ontology building, one type per line'
  },
  {
    group: 'process',
    key: 'entityDescriptionPrompt',
    label: '卡片描述推理提示词',
    labelEn: 'Card Description Reasoning Prompt',
    type: 'textarea',
    placeholder: '你是一个知识图谱专家。请根据提供的文本内容，为实体"{{entityName}}"生成一个准确、完整的描述。',
    placeholderEn: 'You are a knowledge graph expert. Generate an accurate and complete description for the entity "{{entityName}}" based on the provided text.',
    description: '批量推理卡片描述时使用的提示词模板。可用占位符：{{entityName}}、{{entityTypes}}、{{content}}、{{language}}，留空则使用默认提示词',
    descriptionEn: 'Prompt template for batch card description reasoning. Placeholders: {{entityName}}, {{entityTypes}}, {{content}}, {{language}}. Leave empty to use default prompt'
  },
  {
    group: 'process',
    key: 'ontologyBatchSize',
    label: '本体批量大小',
    labelEn: 'Ontology Batch Size',
    type: 'number',
    min: 1,
    max: 50,
    step: 1,
    description: '本体构建时每批处理的切片数量（1-50）',
    descriptionEn: 'Number of slices per batch when building ontology (1-50)'
  },
  {
    group: 'search',
    key: 'mdsIterations',
    label: 'MDS迭代次数',
    labelEn: 'MDS Iterations',
    type: 'number',
    min: 10,
    max: 1000,
    show: () => props.model.searchMethod.includes('MDS'),
    description: 'MDS算法的最大迭代次数',
    descriptionEn: 'Maximum iterations for MDS algorithm'
  },
  {
    group: 'search',
    key: 'mdsEpsilon',
    label: 'MDS收敛阈值',
    labelEn: 'MDS Convergence Threshold',
    type: 'number',
    min: 0.001,
    max: 1,
    step: 0.001,
    show: () => props.model.searchMethod.includes('MDS'),
    description: 'MDS算法的收敛判断阈值',
    descriptionEn: 'Convergence threshold for MDS algorithm'
  },
  {
    group: 'search',
    key: 'pcaComponents',
    label: 'PCA主成分数量',
    labelEn: 'PCA Components',
    type: 'number',
    min: 2,
    max: 10,
    show: () => props.model.searchMethod === 'PCA',
    description: 'PCA降维后的维度数量',
    descriptionEn: 'Number of dimensions after PCA reduction'
  }
])

// 活动配置分组
const activeGroup = ref<string>('knowledgebase')

// 获取当前组的配置项
const currentConfigItems = computed(() => {
  return configItems.value.filter(item => {
    if (item.group !== activeGroup.value) return false
    if (item.show && typeof item.show === 'function') {
      return item.show()
    }
    return true
  })
})

// ==================== 嵌入模型（处理配置；联动父级重新向量化） ====================
/** 判断模型名是否属于嵌入模型（与 knowRAG.autoSetEmbedModel 一致） */
const isEmbedModelName = (name: string) =>
  /^(bge|text-embedding|ada-embedding|instructor|e5|gte|m3e)|embed|embedding/i.test(name || '')
/** 设置页(AI 来源)配置的默认嵌入模型名（“跟随默认”选项使用；未配置时为空串，由父级自动选用） */
const defaultEmbedName = computed<string>(() => {
  const llm = props.store.AIconfig?.llm || {}
  const type = llm.type || 'ollama'
  // DeepSeek 单来源：嵌入模型取当前接口样式对应的配置块（历史别名归一到 deepseek）
  const key = deepSeekStyleOf(type, llm.deepseek) === 'responses' ? 'deepseekResponses' : normalizeLlmType(type)
  return (llm[key] && llm[key].embed_model) ? llm[key].embed_model : ''
})
/** 下拉候选：来源可用模型中的嵌入模型（排除“跟随默认”项避免重复）+ 自定义当前值（若不在候选里） */
const embedCandidates = computed<string[]>(() => {
  const list: string[] = (props.model?.list || []).map((m: any) => m.name).filter(Boolean)
  const out: string[] = []
  const add = (n: string) => { if (n && !out.includes(n)) out.push(n) }
  list.filter((n) => isEmbedModelName(n) && n !== defaultEmbedName.value).forEach(add)
  const cur = String(props.model?.embed || '')
  if (cur && cur !== defaultEmbedName.value) add(cur)
  return out
})
/** 用户更改嵌入模型：交给父级处理（确认 + 新模型重新向量化） */
const onEmbedModelChange = (next: string) => {
  if (String(props.model?.embed || '') === String(next || '')) return
  emit('embedModelChange', String(next || ''))
}

// 扫描知识库文件
const scanKnowledgeBases = async () => {
  if (!props.store.root) {
    kbScanPath.value = t('未选择文件夹', 'No folder selected')
    emit('updateState', kbScanPath.value)
    return
  }

  kbScanPath.value = props.store.root
  isLoadingKb.value = true
  emit('updateState', t('正在扫描知识库文件...', 'Scanning knowledge base files...'))

  try {
    const result = await window.ipcRenderer.invoke("getFilesRelation", props.store.root, 1)
    if (!result) {
      knowledgeBases.value = []
      return
    }

    const { fileList = [] } = result
    const kbFiles = fileList.filter((file: any) => file.path.endsWith('.kb'))
    
    // 读取每个知识库文件的元数据
    const processedFiles = await Promise.all(
      kbFiles.map(async (file: any) => {
        try {
          const content = await window.ipcRenderer.invoke('readFile', file.path)
          const data = JSON.parse(content)
          
          const kbFile: KnowledgeBaseFile = {
            label: file.label,
            path: file.path,
          }
          
          // 解析配置信息
          if (data.config) {
            kbFile.config = {
              embedModel: data.config.embedModel,
              timestamp: data.config.timestamp,
              version: data.config.version,
              blockCount: data.blocks?.length,
              // 精简模式：向量未写入 .kb，首次问答按需重新推导
              saveVectors: data.config.saveVectors !== false ? true : false
            }
          }
          
          // 解析本体信息（实体数、关系数、社区数、报告数）
          if (data.ontology) {
            kbFile.ontology = {
              entities: data.ontology.entities?.length || 0,
              relations: data.ontology.relations?.length || 0
            }
          }
          // 社区检测结果和报告
          if (data.communityResult) {
            if (!kbFile.ontology) kbFile.ontology = {}
            kbFile.ontology.communityCount = data.communityResult.count || data.communityResult.communities?.length || 0
          }
          if (data.communityReports) {
            if (!kbFile.ontology) kbFile.ontology = {}
            kbFile.ontology.communityReportCount = data.communityReports.length || 0
          }
          
          // 解析切片元数据（方案 A：问题由问题库 questions 承载，切片不再持有 Q）
          if (data.blocks && data.blocks.length > 0) {
            const firstBlock = data.blocks[0]
            const hasEmbeddings = !!firstBlock.A_vector
            const avgVectorDimension = hasEmbeddings ? firstBlock.A_vector.length : 0
            const activeQuestions = (data.questions || []).filter((q: any) => q && q.status !== 'merged' && q.text)
            const hasQuestions = activeQuestions.length > 0
            const reasonedCount = activeQuestions.filter((q: any) => q.origin === 'reasoned').length
            const fileCount = new Set(data.blocks.map((b: any) => b.label)).size
            
            kbFile.metadata = {
              blockCount: data.blocks.length,
              hasEmbeddings,
              hasQuestions,
              avgVectorDimension,
              reasonedCount,
              questionCount: activeQuestions.length,
              fileCount
            }
          }
          
          return kbFile
        } catch (e) {
          // 如果解析失败，只返回基本信息
          console.error(t('解析知识库文件失败:', 'Failed to parse knowledge base file:'), file.label, e)
          return {
            label: file.label,
            path: file.path,
            config: { version: 'unknown' }
          } as KnowledgeBaseFile
        }
      })
    )
    
    // 按文件名排序（按时间戳降序）
    processedFiles.sort((a: any, b: any) => {
      return b.label.localeCompare(a.label)
    })
    
    knowledgeBases.value = processedFiles
    emit('updateState', t(
      `扫描完成，找到 ${knowledgeBases.value.length} 个知识库文件`,
      `Scan complete, found ${knowledgeBases.value.length} knowledge base files`
    ))
    
  } catch (error) {
    console.error(t('扫描知识库出错:', 'Error scanning knowledge base:'), error)
    emit('updateState', t('扫描知识库失败', 'Failed to scan knowledge bases'))
  } finally {
    isLoadingKb.value = false
  }
}

// 加载知识库到主模块
const loadKnowledgeBase = async (index: number) => {
  const kbFile = knowledgeBases.value[index]
  emit('updateState', t(
    `正在加载知识库: ${kbFile.label}`,
    `Loading knowledge base: ${kbFile.label}`
  ))
  
  // 发送事件到父组件加载知识库
  emit('loadKnowledgeBase', index)
}

// 删除知识库文件
const deleteKnowledgeBase = async (index: number) => {
  const kbFile = knowledgeBases.value[index]
  try {
    await ElMessageBox.confirm(
      t(
        `确定要删除知识库文件 "${kbFile.label}" 吗？此操作不可恢复。`,
        `Are you sure you want to delete knowledge base file "${kbFile.label}"? This action cannot be undone.`
      ),
      t('提示', 'Confirm'),
      { confirmButtonText: t('确定', 'OK'), cancelButtonText: t('取消', 'Cancel'), type: 'warning' }
    )
  } catch { return }
  
  try {
    const success = await window.ipcRenderer.invoke('deleteFile', kbFile.path)
    if (success) {
      knowledgeBases.value.splice(index, 1)
      emit('updateState', t(
        `已删除知识库: ${kbFile.label}`,
        `Deleted knowledge base: ${kbFile.label}`
      ))
    }
  } catch (error:any) {
    console.error(t('删除知识库出错:', 'Error deleting knowledge base:'), error)
    emit('updateState', t(
      `删除失败: ${error.message}`,
      `Delete failed: ${error.message}`
    ))
  }
}

// 获取保存时间文本
const getSaveTimeText = (timestamp?: string) => {
  if (!timestamp) return t('未知', 'Unknown')
  try {
    const date = new Date(timestamp)
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString().substring(0, 5)
  } catch (e) {
    return timestamp
  }
}

// 监听根目录变化
watch(() => props.store.root, (newRoot) => {
  if (newRoot && activeGroup.value === 'knowledgebase') {
    scanKnowledgeBases()
  }
})

// 初始化
onMounted(() => {
  // 如果已经有根目录，立即扫描
  if (props.store.root) {
    scanKnowledgeBases()
  }
  
})



// 切换分组时扫描知识库
watch(activeGroup, (newGroup) => {
  if (newGroup === 'knowledgebase' && props.store.root) {
    scanKnowledgeBases()
  }
  
})

// 定义发射事件
const emit = defineEmits<{
  updateState: [state: string]
  loadKnowledgeBase: [index: number]
  strategiesChanged: []
  embedModelChange: [model: string]
}>()

// 策略配置变更：转发给父组件刷新策略注册表（QA 下拉等）
const handleStrategiesChanged = () => {
  emit('strategiesChanged')
  emit('updateState', t('策略配置已更新', 'Strategy config updated'))
}
</script>

<template>
  <div class="config-layout">
    <div class="config-body">
      <!-- 侧边栏 -->
      <div class="config-sidebar scoll">
        <div class="sidebar-groups">
          <div v-for="(group, key) in configGroups" :key="key"
            @click="activeGroup = key"
            :class="['group-item', { active: activeGroup === key }]">
            <div class="group-item-title">
              <i :class="group.icon"></i>
              <span>{{ group.title }}</span>
            </div>
            <div class="group-item-desc">{{ group.description }}</div>
          </div>
        </div>
      </div>

      <!-- 配置内容区 -->
      <div class="config-content scoll">
        <div class="config-inner">
          <!-- 知识库配置 -->
          <div v-if="activeGroup === 'knowledgebase'" class="kb-section">
            <!-- 标题行：h3 在左，列表统计在右（参照工具设置面板） -->
            <div class="group-title-row">
              <div class="kb-list-head">
                <div
                  @click="scanKnowledgeBases"
                  class="kb-refresh-btn"
                  :class="{ spinning: isLoadingKb }"
                  :title="t('重新扫描知识库文件', 'Rescan knowledge base files')"
                >
                  <i class="fa fa-refresh"></i>
                </div>
                <span class="kb-head-title">{{ t('知识库文件', 'Knowledge Bases') }}</span>
                <span class="kb-head-desc">{{ knowledgeBases.length }} {{ t('个', 'files') }}</span>
              </div>
            </div>

            <div class="kb-list scoll">
              <div v-if="isLoadingKb" class="kb-loading">
                <i class="fa fa-spinner fa-spin kb-loading-icon"></i>
              </div>
              <div v-else-if="knowledgeBases.length === 0" class="kb-empty">
                <i class="fa fa-database kb-empty-icon"></i>
                <div class="kb-empty-text">{{ t('未找到知识库文件', 'No knowledge base files found') }}</div>
                <div class="kb-empty-hint">{{ t('请确保已选择正确的文件夹', 'Please ensure you have selected the correct folder') }}</div>
              </div>
              <div v-else class="kb-list-content">
                <div v-for="(kb, index) in knowledgeBases" :key="index" class="kb-card">
                  <!-- 卡片头部：图标 + 名称/嵌入模型/保存时间 + 操作按钮 -->
                  <div class="kb-card-head">
                    <div class="kb-icon"><i class="fa fa-database"></i></div>
                    <div class="kb-info">
                      <div class="kb-name-row">
                        <span class="kb-name" :title="kb.label">{{ kb.label }}</span>
                        <span v-if="kb.config?.embedModel" class="kb-model-badge" :title="t('嵌入模型', 'Embed model')">
                          <i class="fa fa-cube"></i> {{ kb.config.embedModel }}
                        </span>
                      </div>
                      <div class="kb-desc">
                        <span>{{ getSaveTimeText(kb.config?.timestamp) }}</span>
                        <span v-if="kb.config?.version" class="kb-ver-badge">v{{ kb.config.version }}</span>
                      </div>
                    </div>
                    <div class="kb-actions">
                      <div @click="loadKnowledgeBase(index)" class="button icon-btn" :title="t('加载此知识库', 'Load this knowledge base')">
                        <i class="fa fa-play"></i>
                      </div>
                      <div @click="deleteKnowledgeBase(index)" class="button icon-btn danger" :title="t('删除此知识库', 'Delete this knowledge base')">
                        <i class="fa fa-trash"></i>
                      </div>
                    </div>
                  </div>
                  <!-- 紧凑统计：切片/文件/实体/关系/向量维度 -->
                  <div class="kb-meta">
                    <span class="meta-item" :title="t('切片数', 'Blocks')"><i class="fa fa-file-text-o"></i> {{ kb.metadata?.blockCount || kb.config?.blockCount || 0 }}</span>
                    <span class="meta-item" :title="t('涉及文件数', 'Files')"><i class="fa fa-files-o"></i> {{ kb.metadata?.fileCount || '?' }}</span>
                    <span class="meta-item" :title="t('问题库问题数（提取/手动/导入）', 'Question bank count (reasoned / manual / imported)')"><i class="fa fa-question-circle-o"></i> {{ kb.metadata?.questionCount ?? '?' }}</span>
                    <span class="meta-item" :title="t('实体数', 'Entities')"><i class="fa fa-cube"></i> {{ kb.ontology?.entities || 0 }}</span>
                    <span class="meta-item" :title="t('关系数', 'Relations')"><i class="fa fa-share-alt"></i> {{ kb.ontology?.relations || 0 }}</span>
                    <span class="meta-item" :title="t('向量维度', 'Vector dim')"><i class="fa fa-vector-square"></i> {{ kb.metadata?.avgVectorDimension || '?' }}</span>
                  </div>
                  <!-- 状态标签：向量化/推理/本体/社区/报告 -->
                  <div class="kb-status">
                    <span v-if="kb.metadata?.hasEmbeddings" class="kb-status-tag c-green" :title="t('切片已生成向量嵌入，可用于相似度检索', 'Blocks have embeddings, usable for similarity search')"><i class="fa fa-check-circle"></i> {{ t('已向量化', 'Embedded') }}</span>
                    <span v-if="kb.config?.saveVectors === false" class="kb-status-tag c-orange" :title="t('此知识库未保存向量数据（精简模式），首次问答时将用当前嵌入模型重新推导，仅会话内缓存', 'This KB stores no vector data (slim mode); vectors are re-derived on first Q&A using the current embed model and cached per session')"><i class="fa fa-file-archive-o"></i> {{ t('精简（向量按需）', 'Slim (on-demand vectors)') }}</span>
                    <span v-if="kb.metadata?.hasQuestions" class="kb-status-tag c-blue" :title="t('问题库包含问题（提取/手动/导入），供作答/检索使用', 'Question bank has questions (reasoned/manual/imported)')"><i class="fa fa-question-circle"></i> {{ t('有问题', 'Questions') }}</span>
                    <span v-if="kb.ontology?.entities && kb.ontology.entities > 0" class="kb-status-tag c-cyan" :title="t('本知识库包含的本体：实体 / 关系 数量', 'Ontology contained: entities / relations')"><i class="fa fa-sitemap"></i> {{ kb.ontology.entities }}n/{{ kb.ontology.relations }}r</span>
                    <span v-if="kb.ontology?.communityCount && kb.ontology.communityCount > 0" class="kb-status-tag c-teal" :title="t('本知识库检测到的社区数量', 'Number of communities detected in this KB')"><i class="fa fa-users"></i> {{ kb.ontology.communityCount }} {{ t('社区', 'comms') }}</span>
                    <span v-if="kb.ontology?.communityReportCount && kb.ontology.communityReportCount > 0" class="kb-status-tag c-indigo" :title="t('本知识库已生成的社区报告数量', 'Number of community reports generated in this KB')"><i class="fa fa-file-text-o"></i> {{ kb.ontology.communityReportCount }} {{ t('报告', 'reports') }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 策略配置 -->
          <div v-else-if="activeGroup === 'strategy'" class="strategy-section" style="height:100%;">
            <strategyConfig :store="store" :model="model" @change="handleStrategiesChanged" />
          </div>

          <!-- 其他配置组 -->
          <!-- 其他配置组（参照设置界面的表单行布局） -->
          <div v-else class="config-section">
            <div class="config-scroll scoll">
              <div v-if="currentConfigItems.length > 0" class="config-items">
                <div v-for="item in currentConfigItems" :key="item.key" class="config-item">
                  <div class="config-item-label" :class="{ left: item.type === 'checkbox' }" :title="t(item.description, item.descriptionEn)">
                    {{ t(item.label, item.labelEn) }}
                  </div>
                  <div class="config-item-field">
                    <template v-if="item.type === 'embed'">
                      <div class="config-embed-row">
                        <select :value="model.embed" class="config-select" :title="t(item.description, item.descriptionEn)" @change="onEmbedModelChange(($event.target as HTMLSelectElement).value)">
                          <option :value="defaultEmbedName">{{ t('跟随默认（设置页默认嵌入模型）', 'Follow default (Settings embedding model)') }}{{ defaultEmbedName ? ' · ' + defaultEmbedName : t('（未配置，自动选用可用嵌入模型）', ' (not set; auto pick embed model)') }}</option>
                          <option v-for="m in embedCandidates" :key="m" :value="m">{{ m }}</option>
                        </select>
                        <div class="config-embed-refresh" :title="t('刷新模型列表（从当前 AI 来源拉取）', 'Refresh model list (fetch from current AI source)')" @click="props.getModel && props.getModel()">
                          <i class="fa fa-refresh"></i>
                        </div>
                      </div>
                    </template>
                    <template v-else-if="item.type === 'text'">
                      <input v-model="model[item.key]" :placeholder="t(item.placeholder || '', item.placeholderEn || '')" class="config-input" />
                    </template>
                    <template v-else-if="item.type === 'select'">
                      <select v-model="model[item.key]" class="config-select">
                        <template v-if="Array.isArray(item.options)">
                          <option v-for="(option, idx) in item.options" :key="idx" :value="option.value || option">
                            {{ typeof option.label === 'string' && option.label.includes('(') ? option.label : t(option.label || option, option.label || option) }}
                          </option>
                        </template>
                        <template v-else-if="item.options && item.options.value">
                          <option v-for="(option, idx) in item.options.value" :key="idx" :value="option.name || option">
                            {{ option.name || option }}<template v-if="option.size"> ({{ (option.size/1024/1024/1024).toFixed(2) }}GB)</template>
                          </option>
                        </template>
                      </select>
                    </template>
                    <template v-else-if="item.type === 'number'">
                      <input type="number" v-model.number="model[item.key]" :min="item.min" :max="item.max" :step="item.step || 1" class="config-number" />
                    </template>
                    <template v-else-if="item.type === 'range'">
                      <div class="config-range-wrap">
                        <input type="range" v-model.number="model[item.key]" :min="item.min" :max="item.max" :step="item.step" class="config-range" />
                        <span class="config-range-value">{{ (model[item.key] * 100).toFixed(0) }}%</span>
                      </div>
                    </template>
                    <template v-else-if="item.type === 'textarea'">
                      <textarea v-model="model[item.key]" :placeholder="t(item.placeholder || '', item.placeholderEn || '')" class="config-textarea scoll"></textarea>
                    </template>
                    <template v-else-if="item.type === 'checkbox'">
                      <label class="config-checkbox-label">
                        <input type="checkbox" v-model="model[item.key]" class="config-checkbox-input" />
                        <span class="config-checkbox-text">{{ t('启用 ', 'Enable ') }}{{ t(item.label, item.labelEn) }}</span>
                      </label>
                    </template>
                    <template v-else-if="item.type === 'display'">
                      <div class="config-display">{{ typeof item.value === 'function' ? item.value() : item.value }}</div>
                    </template>
                  </div>
                </div>
              </div>

              <div v-if="currentConfigItems.length === 0" class="empty-state">
                <i class="fa fa-sliders empty-state-icon"></i>
                <div class="empty-state-text">{{ t('当前无可用配置项', 'No available configuration items') }}</div>
                <div class="empty-state-hint">{{ t('请检查当前检索模式设置', 'Please check the current search mode settings') }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ====== Layout ====== */
.config-layout { display: flex; width: 100%; height: 100%; }
.config-body { display: flex; flex: 1; gap: 5px; padding: 5px; box-sizing: border-box; }

/* ====== Sidebar ====== */
.config-sidebar { width: 150px; border: 1px solid var(--borderColor); border-radius: 5px; padding: 5px; display: flex; flex-direction: column; overflow-y: auto; flex-shrink: 0; }
.sidebar-groups { flex-shrink: 0; }
.group-item { padding: 5px; margin-bottom: 5px; border-radius: 4px; cursor: pointer; border: 1px solid transparent; transition: background-color 0.15s; }
.group-item:hover, .group-item.active { background-color: var(--menuColor) !important; }
.group-item.active { border-color: var(--borderColor); }
.group-item-title { display: flex; align-items: center; gap: 5px; }
.group-item-title i { font-size: 12px; }
.group-item-title span { font-size: 12px; font-weight: bold; }
.group-item-desc { font-size: 10px; color: var(--borderColor); margin-top: 3px; margin-left: 20px; }
.sidebar-actions { margin-top: auto; border-top: 1px solid var(--borderColor); padding-top: 5px; flex-shrink: 0; }
.sidebar-actions-title { font-weight: bold; font-size: 12px; margin-bottom: 5px; color: var(--borderColor); }
.sidebar-actions-buttons { display: flex; gap: 5px; }
.action-btn { align-items: center; justify-content: center; flex: 1; margin: 0 !important; }

/* ====== Content Area ====== */
.config-content { flex: 1; border: 1px solid var(--borderColor); border-radius: 5px; padding: 5px; display: flex; flex-direction: column; overflow-y: auto; }
.config-inner { flex: 1; }

/* ====== Knowledge Base（标题行 + Grid 列表，参照工具设置面板） ====== */
.kb-section { display: flex; flex-direction: column; gap: 6px; height: 100%; min-height: 0; }
.kb-list-head { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
/* 刷新按钮：仅图标，样式轻量 */
.kb-refresh-btn {
  flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; margin: 0; padding: 0;
  border: none; background: transparent;
  color: var(--borderColor); font-size: 11px;
  cursor: pointer; border-radius: 3px;
  transition: color .12s, background-color .12s;
}
.kb-refresh-btn:hover { color: var(--fontActiveColor); background: color-mix(in srgb, var(--fontColor) 6%, transparent); }
.kb-refresh-btn.spinning { color: var(--fontActiveColor); }
.kb-refresh-btn.spinning .fa { animation: kb-spin 1s linear infinite; }
@keyframes kb-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
.kb-head-title { font-size: 11px; opacity: .9; font-weight: 600; white-space: nowrap; }
.kb-head-desc { font-size: 10px; opacity: .6; white-space: nowrap; }

.kb-list { flex: 1; min-height: 0; overflow-y: auto; padding-right: 2px; }
.kb-loading { display: flex; justify-content: center; align-items: center; height: 100px; }
.kb-loading-icon { font-size: 24px; color: var(--borderColor); }
.kb-empty { display: flex; flex-direction: column; justify-content: center; align-items: center; height: 200px; color: var(--borderColor); }
.kb-empty-icon { font-size: 48px; margin-bottom: 16px; }
.kb-empty-text { margin-bottom: 8px; }
.kb-empty-hint { font-size: 12px; }

/* 知识库列表：2-3 列自适应网格 */
.kb-list-content {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 8px;
  align-content: start;
}

/* ====== KB Card（参照工具设置面板的 tool-item 风格） ====== */
.kb-card {
  display: flex; flex-direction: column; gap: 6px;
  padding: 8px;
  border: 1px solid var(--borderColor); border-radius: 5px;
  background: var(--menuColor);
  transition: all .12s;
  min-width: 0;
}
.kb-card:hover { border-color: var(--fontActiveColor); }
.kb-card-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.kb-icon {
  width: 32px; height: 32px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, #4CAF50 12%, transparent);
  border-radius: 5px; color: #4CAF50; font-size: 15px;
}
.kb-info { flex: 1; min-width: 0; }
.kb-name-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.kb-name { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-model-badge {
  font-size: 9px; padding: 0 5px; border-radius: 3px;
  background: color-mix(in srgb, var(--fontActiveColor) 12%, transparent);
  color: var(--fontActiveColor); white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; max-width: 140px;
}
.kb-desc { font-size: 10px; opacity: .7; margin-top: 1px; display: flex; align-items: center; gap: 6px; }
.kb-ver-badge {
  font-size: 9px; padding: 0 4px; border-radius: 3px;
  background: color-mix(in srgb, var(--fontColor) 8%, transparent);
  border: 1px solid var(--borderColor); color: var(--fontColor);
}
.kb-actions { display: flex; gap: 4px; flex-shrink: 0; }
.kb-actions .icon-btn { width: 23px; height: 23px; margin: 0; padding: 0; border: none; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; }
.kb-actions .icon-btn.danger:hover { color: #F56C6C; }

/* ====== KB 紧凑统计 ====== */
.kb-meta { display: flex; gap: 10px; flex-wrap: wrap; }
.kb-meta .meta-item { font-size: 10px; opacity: .75; display: inline-flex; align-items: center; gap: 3px; color: var(--fontColor); }

/* ====== KB Status ====== */
.kb-status { display: flex; gap: 5px; flex-wrap: wrap; }
.kb-status-tag {
  font-size: 9px; padding: 1px 5px; border-radius: 3px;
  background: color-mix(in srgb, var(--fontColor) 6%, transparent);
  border: 1px solid var(--borderColor); white-space: nowrap;
}

/* ====== Config Items（参考设置界面：label + 控件单行紧凑布局） ====== */
.config-section { display: flex; flex-direction: column; gap: 6px; height: 100%; overflow: hidden; }
.config-scroll { flex: 1; overflow-y: auto; padding-right: 5px; }
.config-items { display: flex; flex-direction: column; gap: 8px; }
.config-item { display: flex; align-items: center; gap: 8px; min-width: 0; }
.config-item-label {
  flex-shrink: 0; width: 150px; min-width: 0;
  text-align: right; font-size: 12px; color: var(--fontColor);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  cursor: help;
}
.config-item-label.left { text-align: left; }
.config-item-field { flex: 1; min-width: 0; display: flex; align-items: center; }

/* ====== Form Controls ====== */
.config-input, .config-select, .config-number { width: 100%; max-width: 100%; padding: 5px; border: 1px solid var(--borderColor); border-radius: 4px; font-size: 12px; background-color: var(--backgroundColor); color: var(--fontColor); box-sizing: border-box; margin:0px}
.config-input:focus, .config-select:focus, .config-number:focus, .config-textarea:focus { outline: none; border-color: var(--fontActiveColor); }
.config-range-wrap { display: flex; align-items: center; gap: 10px; width: 100%; }
.config-range { flex: 1; min-width: 0; width: 100%; margin:0px }
.config-range-value { font-size: 12px; min-width: 40px; flex-shrink: 0; text-align: right; }
.config-textarea { width: 100%; max-width: 100%; padding: 5px; border: 1px solid var(--borderColor); border-radius: 4px; font-size: 12px; min-height: 80px; resize: vertical; box-sizing: border-box; background-color: var(--backgroundColor); color: var(--fontColor); }
.config-checkbox-label { display: flex; align-items: center; gap: 5px; cursor: pointer; width: 100%; padding: 0px }
.config-checkbox-input { width: 16px; height: 16px; flex-shrink: 0; }
.config-checkbox-text { font-size: 12px; }
.config-display { padding: 6px 8px; border: 1px solid var(--borderColor); border-radius: 4px; font-size: 12px; background-color: var(--menuColor); box-sizing: border-box; }

/* ====== 嵌入模型选择行（处理配置） ====== */
.config-embed-row { display: flex; align-items: center; gap: 5px; width: 100%; min-width: 0; }
.config-embed-row .config-select { flex: 1; min-width: 0; }
.config-embed-refresh {
  flex-shrink: 0; width: 24px; height: 24px; margin: 0; padding: 0;
  border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--menuColor); color: var(--borderColor);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; cursor: pointer;
}
.config-embed-refresh:hover { color: var(--fontActiveColor); border-color: var(--fontActiveColor); }

/* ====== Weight Info ====== */
.weight-info { margin: 15px 0; padding: 12px; border: 1px dashed var(--borderColor); border-radius: 5px; background-color: rgba(0,0,0,0.02); }
.weight-info-title { font-size: 12px; color: var(--borderColor); margin-bottom: 8px; display: flex; align-items: center; gap: 5px; }
.weight-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; font-size: 11px; }
.weight-item { text-align: center; }
.weight-label { font-weight: bold; margin-bottom: 4px; }
.weight-value { font-size: 14px; font-weight: bold; }

/* ====== Empty State ====== */
.empty-state { display: flex; flex-direction: column; justify-content: center; align-items: center; height: 200px; color: var(--borderColor); width: 100%; }
.empty-state-icon { font-size: 48px; margin-bottom: 16px; }
.empty-state-text { margin-bottom: 8px; }
.empty-state-hint { font-size: 12px; }

/* ====== Color Helpers ====== */
.c-green { color: #4CAF50; }
.c-blue { color: #2196F3; }
.c-orange { color: #FF9800; }
.c-purple { color: #9C27B0; }
.c-brown { color: #795548; }
.c-cyan { color: #00BCD4; }
.c-teal { color: #009688; }
.c-indigo { color: #3F51B5; }
</style>