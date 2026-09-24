<!-- LlmSettings.vue - 大语言模型设置（左右布局：左侧模型来源列表 + 右侧具体配置，样式参照 AgentPreset） -->
<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { usestore } from '@/store'
import { AIUtils } from '@/services/ai-utils'
import { ElMessage, ElMessageBox } from 'element-plus'
import { getProviderConfig } from '@/shared/kbAiClient'
import { deepSeekApiStyle } from '@/shared/llmSources'
import type { LmStudioModelInfo, OllamaModelInfo, OllamaLoadedModel } from '@/shared/ai-core'
import ModelContextWindow from './ModelContextWindow.vue'
import LlmTestRow from './LlmTestRow.vue'

const store = usestore()
const zh = () => store.locales === 'zh'

// ================ 模型来源列表（左侧：搜索 + 9 种内置来源 + 自定义来源） ================

interface LlmSourceDef { key: string; icon: string; labelZh: string; labelEn: string; descZh: string; descEn: string }

const llmSources: LlmSourceDef[] = [
  { key: 'ollama', icon: 'fa-server', labelZh: 'Ollama', labelEn: 'Ollama', descZh: '本地模型', descEn: 'Local model' },
  { key: 'lmstudio', icon: 'fa-laptop', labelZh: 'LM Studio', labelEn: 'LM Studio', descZh: '本地模型', descEn: 'Local model' },
  { key: 'deepseek', icon: 'fa-database', labelZh: 'DeepSeek', labelEn: 'DeepSeek', descZh: 'Chat / Responses', descEn: 'Chat / Responses' },
  { key: 'gpustack', icon: 'fa-cubes', labelZh: 'GPUStack', labelEn: 'GPUStack', descZh: '自托管推理平台', descEn: 'Self-hosted GPU platform' },
  { key: 'openai', icon: 'fa-cloud', labelZh: 'OpenAI', labelEn: 'OpenAI', descZh: '在线 API', descEn: 'Online API' },
  { key: 'anthropic', icon: 'fa-comment', labelZh: 'Anthropic', labelEn: 'Anthropic', descZh: 'Claude', descEn: 'Claude' },
  { key: 'google', icon: 'fa-google', labelZh: 'Google', labelEn: 'Google', descZh: 'Gemini', descEn: 'Gemini' },
  { key: 'azure', icon: 'fa-windows', labelZh: 'Azure', labelEn: 'Azure', descZh: '微软云', descEn: 'Microsoft Cloud' },
]

// ================ 自定义来源（可添加/重命名/删除，多个并存） ================

interface CustomSource {
  id: number
  name: string
  api_url: string
  api_key: string
  apiKeyRef: string
  model: string
  embed_model: string
  available_models: string[]
}

/** 全部自定义来源（取自 store.AIconfig.llm.custom.sources） */
const customSources = computed<CustomSource[]>(() =>
  Array.isArray(store.AIconfig.llm.custom.sources) ? store.AIconfig.llm.custom.sources : []
)

/** 当前激活的自定义来源索引 */
const customActiveIndex = computed(() => store.AIconfig.llm.custom.activeIndex || 0)

/** 来源是否激活（自定义来源：type=custom 且 activeIndex 匹配） */
const customActive = (index: number): boolean =>
  store.AIconfig.llm.type === 'custom' && customActiveIndex.value === index

/** 搜索过滤后的自定义来源（保留原索引以便操作） */
const filteredCustomSources = computed(() => {
  const kw = llmSourceKeyword.value.trim().toLowerCase()
  const items = customSources.value.map((src, index) => ({ src, index }))
  if (!kw) return items
  return items.filter(({ src }) =>
    (src.name || '').toLowerCase().includes(kw) ||
    (src.api_url || '').toLowerCase().includes(kw)
  )
})

/** 当前自定义来源显示名（含默认名回退） */
const customDefaultName = () => (zh() ? '自定义' : 'Custom')
const customName = (src?: CustomSource) => (src && src.name && src.name.trim()) ? src.name : customDefaultName()

/** 确保 sources 非空（从扁平 custom 播种），并把扁平字段与激活来源对齐（sources[] 为权威数据） */
const ensureCustomSources = () => {
  const c = store.AIconfig.llm.custom
  if (!Array.isArray(c.sources) || c.sources.length === 0) {
    c.sources = [{
      id: Date.now(),
      name: c.name || customDefaultName(),
      api_url: c.api_url || '',
      api_key: c.api_key || '',
      apiKeyRef: c.apiKeyRef || '',
      model: c.model || '',
      embed_model: c.embed_model || '',
      available_models: Array.isArray(c.available_models) ? c.available_models : [],
    }]
    c.activeIndex = 0
  }
  if (typeof c.activeIndex !== 'number' || c.activeIndex < 0 || c.activeIndex >= c.sources.length) {
    c.activeIndex = 0
  }
  // 扁平字段与激活来源对齐：即使重启后扁平字段未及时对齐，设置页也显示正确的地址/密钥/模型
  const src = c.sources[c.activeIndex]
  if (src) {
    c.name = src.name || c.name || ''
    c.api_url = src.api_url || c.api_url || ''
    c.api_key = src.api_key || c.api_key || ''
    c.apiKeyRef = src.apiKeyRef || c.apiKeyRef || ''
    c.model = src.model || c.model || ''
    c.embed_model = src.embed_model || c.embed_model || ''
    c.available_models = (Array.isArray(src.available_models) && src.available_models.length)
      ? src.available_models
      : (Array.isArray(c.available_models) ? c.available_models : [])
  }
}

/** 选中某个自定义来源：把该来源配置同步到扁平 custom，并切换到 custom 类型 */
const selectCustomSource = (index: number) => {
  const c = store.AIconfig.llm.custom
  const src = c.sources[index]
  if (!src) return
  c.activeIndex = index
  c.name = src.name || ''
  c.api_url = src.api_url || ''
  c.api_key = src.api_key || ''
  c.apiKeyRef = src.apiKeyRef || ''
  c.model = src.model || ''
  c.embed_model = src.embed_model || ''
  c.available_models = Array.isArray(src.available_models) ? src.available_models : []
  store.AIconfig.llm.type = 'custom'
  applyUseCredFromConfig()
  cancelRename()
  // 每个来源独立记忆「下拉/手填」模式：有模型列表 → 下拉；空列表 → 手填兜底
  customModelMode.value = (c.available_models && c.available_models.length) ? 'select' : 'input'
  store.saveConfig()
}

/** 新增自定义来源（自动命名 Custom N / 自定义 N）并激活 */
const addCustomSource = () => {
  const c = store.AIconfig.llm.custom
  ensureCustomSources()
  const n = c.sources.length + 1
  const src: CustomSource = {
    id: Date.now(),
    name: `${customDefaultName()} ${n}`,
    api_url: '',
    api_key: '',
    apiKeyRef: '',
    model: '',
    embed_model: '',
    available_models: [],
  }
  c.sources.push(src)
  selectCustomSource(c.sources.length - 1)
}

/** 删除自定义来源（若删除的是激活项则切换到相邻来源；否则修正 activeIndex 偏移） */
const removeCustomSource = (index: number) => {
  const c = store.AIconfig.llm.custom
  if (!Array.isArray(c.sources) || c.sources.length === 0) return
  cancelRename()
  const wasActive = store.AIconfig.llm.type === 'custom' && customActiveIndex.value === index
  const removedBeforeActive = customActiveIndex.value > index
  c.sources.splice(index, 1)
  if (c.sources.length === 0) {
    // 全部删除后播种一个空来源，保持 custom 类型可用
    ensureCustomSources()
    store.saveConfig()
    return
  }
  if (wasActive) {
    selectCustomSource(Math.min(index, c.sources.length - 1))
  } else if (removedBeforeActive) {
    // 删除项在激活项之前：激活来源索引前移一位，扁平字段不变
    c.activeIndex = customActiveIndex.value - 1
    store.saveConfig()
  }
}

/** 把扁平 custom 的编辑同步回 sources[activeIndex]（persist=true 时保存） */
const syncCustomSource = (persist = true) => {
  const c = store.AIconfig.llm.custom
  const i = c.activeIndex
  if (Array.isArray(c.sources) && c.sources[i]) {
    const s = c.sources[i]
    // 仅当扁平字段有值（或来源字段本就为空）时才覆盖——
    // 避免 home 临时切换到其它来源 / 瞬断导致的空白覆盖已保存的地址/密钥/模型等
    if (c.name || !s.name) s.name = c.name || ''
    if (c.api_url || !s.api_url) s.api_url = c.api_url || ''
    if (c.api_key || !s.api_key) s.api_key = c.api_key || ''
    if (c.apiKeyRef || !s.apiKeyRef) s.apiKeyRef = c.apiKeyRef || ''
    if (c.model || !s.model) s.model = c.model || ''
    if (c.embed_model || !s.embed_model) s.embed_model = c.embed_model || ''
    if (Array.isArray(c.available_models) && c.available_models.length) s.available_models = [...c.available_models]
  }
  if (persist) store.saveConfig()
}

// 自定义来源配置：任意字段变更后防抖持久化（地址/密钥/默认模型/嵌入模型等），
// 不再依赖输入框失焦/change 事件——即使输入后未失焦就关闭或刷新，重启后配置也不会丢。
// 注意：这里只保存（saveConfig），不做 flat→sources 强制同步——
// 避免把 home 临时切换到其它自定义来源的扁平字段写进当前来源（地址/密钥/模型不被污染）。
let customSaveTimer: any = null
watch(
  () => store.AIconfig?.llm?.custom,
  () => {
    clearTimeout(customSaveTimer)
    customSaveTimer = setTimeout(() => {
      store.saveConfig()
    }, 400)
  },
  { deep: true }
)

// 离开设置页时立即落盘未保存的编辑（防抖窗口内关闭/切换导致丢失）
onBeforeUnmount(() => {
  clearTimeout(customSaveTimer)
  // 提交当前编辑（地址/密钥/默认模型/嵌入模型）并保存
  syncCustomSource()
})

/** 重命名状态：正在重命名的来源索引 + 输入框文本 */
const renameIndex = ref<number | null>(null)
const renameText = ref('')
const startRename = (index: number) => {
  const src = customSources.value[index]
  renameIndex.value = index
  renameText.value = (src && src.name) || ''
}
const commitRename = () => {
  if (renameIndex.value === null) return
  const c = store.AIconfig.llm.custom
  const src = c.sources[renameIndex.value]
  if (src) {
    const name = renameText.value.trim()
    src.name = name
    if (store.AIconfig.llm.type === 'custom' && customActiveIndex.value === renameIndex.value) {
      c.name = name
    }
  }
  cancelRename()
  store.saveConfig()
}
const cancelRename = () => { renameIndex.value = null; renameText.value = '' }

/** 来源搜索关键词 */
const llmSourceKeyword = ref('')

/** 过滤后的来源列表（按名称/描述匹配） */
const filteredLlmSources = computed(() => {
  const kw = llmSourceKeyword.value.trim().toLowerCase()
  if (!kw) return llmSources
  return llmSources.filter(s =>
    s.labelZh.toLowerCase().includes(kw) || s.labelEn.toLowerCase().includes(kw) ||
    s.descZh.toLowerCase().includes(kw) || s.descEn.toLowerCase().includes(kw)
  )
})

const llmSourceActive = (key: string): boolean => store.AIconfig.llm.type === key
/** 选择来源：切换类型并持久化，延迟刷新该来源的模型列表（DeepSeek 单来源：接口样式在配置块内切换） */
const selectLlmSource = (key: string) => {
  store.AIconfig.llm.type = key
  applyUseCredFromConfig()
  cancelRename()
  store.saveConfig()
  setTimeout(async () => {
    if (key === 'ollama') await refreshOllamaModels()
    else if (key === 'lmstudio') await refreshLMStudioModels()
  }, 50)
}

/** 来源连接状态（持久化：store.llmSourceStatus，切换模块不丢失） */
const llmSourceStatus = (key: string): 'online' | 'offline' | 'untested' =>
  store.llmSourceStatus[key] || 'untested'

/** 自定义来源连接状态（按 source id；store.llmCustomSourceStatus） */
const customSourceStatusOf = (id: number): 'online' | 'offline' | 'untested' =>
  store.llmCustomSourceStatus[id] || 'untested'

// ================ 当前来源的帮助文本 ================

const getCurrentConfigHelp = computed(() => {
  const type = store.AIconfig.llm.type
  switch (type) {
    case 'ollama':
      return zh() ? 'Ollama是本地运行的AI模型服务。请确保Ollama服务已启动。' : 'Ollama is a local AI model service. Make sure Ollama service is running.'
    case 'lmstudio':
      return zh() ? 'LM Studio是本地运行的AI模型服务，兼容OpenAI API格式。请确保LM Studio服务已启动并加载了模型。' : 'LM Studio is a local AI model service compatible with OpenAI API format. Make sure LM Studio is running with a model loaded.'
    case 'openai':
      return zh() ? 'OpenAI官方API配置。需要有效的API密钥。' : 'OpenAI official API configuration. Requires valid API key.'
    case 'deepseek':
      return zh() ? 'DeepSeek 配置：需要 DeepSeek API 密钥；可选接口样式 Chat Completions（默认）/ Responses API；模型 deepseek-flash / deepseek-v4-pro；可查询账户余额。' : 'DeepSeek configuration: requires a DeepSeek API key; choose API style Chat Completions (default) / Responses API; models deepseek-flash / deepseek-v4-pro; account balance query supported.'
    case 'gpustack':
      return zh() ? 'GPUStack 自托管推理平台配置。填服务地址即可（裸地址自动补 /v1-openai），密钥可选。' : 'GPUStack self-hosted inference platform. Fill the server address (bare host auto-appends /v1-openai); API key optional.'
    case 'anthropic':
      return zh() ? 'Anthropic Claude API配置。需要Claude API密钥。' : 'Anthropic Claude API configuration. Requires Claude API key.'
    case 'google':
      return zh() ? 'Google Gemini API配置。需要Google AI密钥。' : 'Google Gemini API configuration. Requires Google AI key.'
    case 'azure':
      return zh() ? 'Azure OpenAI服务配置。需要Azure API密钥和部署信息。' : 'Azure OpenAI service configuration. Requires Azure API key and deployment info.'
    case 'custom':
      return zh()
        ? `自定义API配置（${customName(customSources.value[customActiveIndex.value])}）。请填写API端点和配置信息。`
        : `Custom API configuration (${customName(customSources.value[customActiveIndex.value])}). Fill in your API endpoint and configuration.`
    default:
      return ''
  }
})

// ================ 各类型刷新/切换处理 ================

const handleOllamaUrlChange = async () => { await refreshOllamaModels() }
const handleOllamaModelChange = () => { store.saveConfig() }
const refreshOllamaModels = async () => { await store.getAIconfig(); store.saveConfig(); await refreshOlModelStates() }

const handleLMStudioUrlChange = async () => { await refreshLMStudioModels() }
const handleLMStudioModelChange = () => { store.saveConfig() }
const refreshLMStudioModels = async () => { await store.getAIconfig(); store.saveConfig(); await refreshLmModelStates() }

// LM Studio：API 密钥 / 凭据引用 切换（同一输入框 + 按钮切换，合并为一个 form-group）
const lmstudioUseCred = ref(false)
const toggleLmstudioUseCred = () => { lmstudioUseCred.value = !lmstudioUseCred.value }

// ================ LM Studio 模型加载状态 / 加载卸载（哪些模型已加载） ================
// 两个数据源：
//  ① REST `GET /api/v0/models`：type（llm / vlm / embeddings）、state（loaded / not-loaded）、
//     max_context_length（模型能力上限）、loaded_context_length（已加载实例的窗口）。
//  ② CLI `lms ps --json`：identifier / status / **contextLength = LM Studio 里设置的、当前实际生效的
//     上下文长度**（这才是用户要看的「LM Studio 设置的上限」），同时用于加载 / 卸载按钮。
const lmModels = ref<LmStudioModelInfo[]>([])
const lmModelsLoading = ref(false)
const lmModelsError = ref('')
/** 已加载实例（lms ps --json） */
const lmLoaded = ref<Array<{ identifier: string; modelKey: string; type: string; status: string; contextLength: number; maxContextLength: number; ttlMs: number | null; parallel: number | null }>>([])
const lmCliAvailable = ref(false)
const lmCliError = ref('')
/** 正在加载 / 卸载的模型 id（空 = 空闲） */
const lmActionBusy = ref('')
/** 加载时手动指定的上下文长度（留空 = LM Studio 默认） */
const lmLoadContext = ref('')

/** 模型名归一化比较（忽略大小写与 :latest 后缀） */
const normLmModelId = (id: any): string => String(id || '').trim().toLowerCase().replace(/:(latest|default)$/i, '')
const lmInfoOf = (id: any): LmStudioModelInfo | undefined =>
  lmModels.value.find(m => normLmModelId(m.id) === normLmModelId(id))
/** 已加载实例（按 identifier / modelKey 归一匹配） */
const lmLoadedOf = (id: any): any | undefined =>
  lmLoaded.value.find(m => normLmModelId(m.identifier) === normLmModelId(id) || normLmModelId(m.modelKey) === normLmModelId(id))
const lmIsLoaded = (id: any): boolean => !!lmLoadedOf(id) || lmInfoOf(id)?.state === 'loaded'
const lmTypeLabel = (type: string): string => {
  if (type === 'embeddings' || type === 'embedding') return zh() ? '嵌入' : 'embedding'
  if (type === 'vlm') return zh() ? '视觉' : 'vision'
  if (type === 'llm') return zh() ? '对话' : 'chat'
  return ''
}
/** LM Studio 里设置的上下文长度（已加载实例实际生效值）；未加载时返回 0（读不到） */
const lmSetCtx = (id: any): number =>
  Number(lmLoadedOf(id)?.contextLength || 0) || Number(lmInfoOf(id)?.loadedContextLength || 0)
/** 模型能力上限（≠ LM Studio 里设置的值） */
const lmMaxCtx = (id: any): number =>
  Number(lmLoadedOf(id)?.maxContextLength || 0) || Number(lmInfoOf(id)?.maxContextLength || 0)
const lmFmtCtx = (n: number): string => (n > 0 ? (n >= 1024 ? `${Math.round(n / 1024)}K` : String(n)) : '')
/** 行内文案（模板里不写模板字符串，便于统一中英） */
const lmSetCtxText = (id: any): string => {
  const n = lmSetCtx(id)
  return n > 0 ? `${zh() ? '设置' : 'set'} ${lmFmtCtx(n)}` : ''
}
const lmMaxCtxText = (id: any): string => {
  const n = lmMaxCtx(id)
  return n > 0 ? `${zh() ? '上限' : 'max'} ${lmFmtCtx(n)}` : ''
}
const lmStateText = (id: any): string => (lmIsLoaded(id) ? (zh() ? '已加载' : 'loaded') : (zh() ? '未加载' : 'not loaded'))
/** 是否嵌入类模型（REST 用 embeddings，lms ps 用 embedding） */
const lmIsEmbedType = (type: any): boolean => /^embedding/i.test(String(type || ''))
/**
 * 「默认嵌入模型」下拉候选：LM Studio 只保留**嵌入模型**（REST /api/v0/models 的 type 可得）；
 * 尚未读到类型信息、或本地没有任何嵌入模型时不过滤（否则下拉会空掉）。
 */
const lmEmbedCandidates = (list: any[]): string[] => {
  const all = (Array.isArray(list) ? list : []).filter(Boolean)
  const embeds = lmModels.value.filter(m => lmIsEmbedType(m.type)).map(m => m.id)
  if (!embeds.length) return all
  const cur = String(store.AIconfig.llm.lmstudio.embed_model || '').trim()
  return [...new Set([...(cur ? [cur] : []), ...embeds])]
}
const lmStatusLabel = (id: any): string => {
  const st = String(lmLoadedOf(id)?.status || '')
  if (!st) return ''
  if (st === 'idle') return zh() ? '空闲' : 'idle'
  return st
}
/** 下拉项后缀：模型类型 + 加载状态（只有 LM Studio 能提供这两项信息） */
const lmSuffix = (id: any): string => {
  const info = lmInfoOf(id)
  const parts: string[] = []
  const ty = lmTypeLabel(info?.type || '')
  if (ty) parts.push(ty)
  if (info || lmLoadedOf(id)) {
    parts.push(lmIsLoaded(id) ? (zh() ? '已加载' : 'loaded') : (zh() ? '未加载' : 'not loaded'))
  }
  return parts.length ? `（${parts.join('·')}）` : ''
}
const lmLoadedList = computed(() => lmModels.value.filter(m => lmIsLoaded(m.id)))
const lmModelsSummary = computed(() => {
  if (lmModelsLoading.value) return zh() ? '读取中…' : 'Loading…'
  if (!lmModels.value.length) return zh() ? '未读取到模型（确认 LM Studio 已启动）' : 'No models found (is LM Studio running?)'
  const embedN = lmLoadedList.value.filter(m => normLmModelId(m.type) === 'embeddings').length
  return zh()
    ? `共 ${lmModels.value.length} 个，已加载 ${lmLoadedList.value.length} 个${embedN ? `（含嵌入模型 ${embedN} 个）` : ''}`
    : `${lmModels.value.length} models, ${lmLoadedList.value.length} loaded${embedN ? ` (${embedN} embedding)` : ''}`
})
/** 当前所选模型的上下文（LM Studio 设置值优先，其次模型上限）——直接显示「LM Studio 设置的上限」 */
const lmCurrentCtxText = computed(() => {
  const id = String(store.AIconfig.llm.lmstudio.model || '').trim()
  if (!id || !lmModels.value.length) return ''
  const set = lmSetCtx(id)
  const max = lmMaxCtx(id)
  if (set > 0) {
    return zh()
      ? `当前模型：LM Studio 设置 ${lmFmtCtx(set)}（生效中）${max ? ` · 模型上限 ${lmFmtCtx(max)}` : ''}`
      : `Current model: LM Studio setting ${lmFmtCtx(set)} (effective)${max ? ` · model max ${lmFmtCtx(max)}` : ''}`
  }
  if (max > 0) {
    return zh()
      ? `当前模型未加载：读不到 LM Studio 里设置的上下文长度（模型上限 ${lmFmtCtx(max)}）`
      : `Current model is not loaded: cannot read the context length set in LM Studio (model max ${lmFmtCtx(max)})`
  }
  return ''
})
/** 知识库嵌入提醒：默认嵌入模型未加载会直接导致 KB 问答报 No models loaded */
const lmEmbedHint = computed(() => {
  const embedModel = String(store.AIconfig.llm.lmstudio.embed_model || '').trim()
  if (!embedModel) {
    return zh()
      ? '未设置「默认嵌入模型」：知识库向量化会改走「嵌入兜底」来源，或直接报错。'
      : 'No default embedding model: KB embedding will use the fallback source, or fail.'
  }
  if (!lmModels.value.length) return ''
  if (!lmInfoOf(embedModel) && !lmLoadedOf(embedModel)) {
    return zh()
      ? `嵌入模型「${embedModel}」不在 LM Studio 的模型列表里：请核对名称。`
      : `Embedding model “${embedModel}” is not in LM Studio's model list: check the name.`
  }
  if (!lmIsLoaded(embedModel)) {
    return zh()
      ? `嵌入模型「${embedModel}」当前未加载：知识库问答会报 No models loaded。点该行右侧的 ⬇ 加载，或打开 Server 的 Just-In-Time 模型加载。`
      : `Embedding model “${embedModel}” is not loaded: KB Q&A will fail with “No models loaded”. Click ⬇ on that row to load it, or enable Just-In-Time loading.`
  }
  return ''
})
/** CLI 不可用提示（没装 lms 时按钮禁用） */
const lmCliHint = computed(() => {
  if (lmModelsLoading.value || lmCliAvailable.value) return ''
  return zh()
    ? '未检测到 LM Studio 命令行（lms）：无法在此加载 / 卸载。可在 LM Studio 的 Developer 页安装 CLI，或手动执行 lms load <模型>。'
    : 'LM Studio CLI (lms) not found, so models cannot be loaded/unloaded here. Install it from LM Studio → Developer, or run lms load <model> manually.'
})
/** 读取失败时的友好文案（浏览器预览 / 服务未启动时后端可能返回 HTML） */
const lmFriendlyError = (raw: any): string => {
  const s = String(raw || '')
  if (!s) return ''
  if (/Unexpected token|<!DOCTYPE|not valid JSON/i.test(s)) {
    return zh() ? '读取失败：返回的不是 JSON（请确认 LM Studio 服务已启动）' : 'Read failed: the response is not JSON (check that the LM Studio server is running)'
  }
  return s
}
/** 重新读取 LM Studio 模型清单（REST）与已加载实例（lms ps） */
const refreshLmModelStates = async () => {
  if (lmModelsLoading.value) return
  lmModelsLoading.value = true
  lmModelsError.value = ''
  try {
    const [rest, ps] = await Promise.all([
      AIUtils.listLmStudioModels(store.AIconfig.llm.lmstudio),
      AIUtils.lmStudioCli({ action: 'ps' }),
    ])
    lmModels.value = Array.isArray(rest?.models) ? rest.models : []
    if (!rest?.online) lmModelsError.value = lmFriendlyError(rest?.error) || (zh() ? '无法连接 LM Studio' : 'Cannot reach LM Studio')
    lmLoaded.value = Array.isArray(ps?.models) ? ps.models : []
    lmCliAvailable.value = ps?.available === true
    lmCliError.value = ps?.ok ? '' : lmFriendlyError(ps?.error)
  } catch (e: any) {
    lmModelsError.value = e?.message || String(e)
  } finally {
    lmModelsLoading.value = false
  }
}
/** 加载模型（可选指定上下文长度 = LM Studio 的「上下文长度」设置） */
const lmLoadModel = async (id: string) => {
  if (lmActionBusy.value) return
  const ctx = Math.floor(Number(lmLoadContext.value || 0))
  const detail = ctx > 0
    ? (zh() ? `上下文长度设为 ${lmFmtCtx(ctx)}。` : `Context length will be set to ${lmFmtCtx(ctx)}.`)
    : (zh() ? '使用 LM Studio 的默认上下文长度。' : 'LM Studio default context length will be used.')
  try {
    await ElMessageBox.confirm(
      zh() ? `即将在 LM Studio 中加载「${id}」。${detail}大模型可能需要数分钟，期间请勿关闭 LM Studio。`
        : `Load “${id}” in LM Studio. ${detail}This may take minutes for large models; keep LM Studio open.`,
      zh() ? '加载模型' : 'Load model',
      { confirmButtonText: zh() ? '开始加载' : 'Load', cancelButtonText: zh() ? '取消' : 'Cancel', type: 'warning' }
    )
  } catch { return }
  lmActionBusy.value = id
  const tip = ElMessage({ message: zh() ? `正在加载「${id}」…（可能需要数分钟）` : `Loading “${id}”…`, type: 'info', duration: 0 })
  try {
    const res = await AIUtils.lmStudioCli({ action: 'load', model: id, contextLength: ctx > 0 ? ctx : undefined })
    if (res?.ok) ElMessage.success(zh() ? `已加载「${id}」` : `Loaded “${id}”`)
    else ElMessage.error(String(res?.error || res?.output || (zh() ? '加载失败' : 'Load failed')).slice(0, 300))
  } finally {
    tip.close()
    lmActionBusy.value = ''
    await refreshLmModelStates()
    try { await store.getAIconfig(); store.saveConfig() } catch { /* 模型列表刷新失败不影响加载结果 */ }
  }
}
/** 卸载模型 */
const lmUnloadModel = async (id: string) => {
  if (lmActionBusy.value) return
  try {
    await ElMessageBox.confirm(
      zh() ? `即将从 LM Studio 卸载「${id}」。正在进行的对话 / 知识库向量化会中断，需要时再点 ⬇ 重新加载。`
        : `Unload “${id}” from LM Studio. Ongoing chats / KB embedding will be interrupted; click ⬇ to load it again.`,
      zh() ? '卸载模型' : 'Unload model',
      { confirmButtonText: zh() ? '卸载' : 'Unload', cancelButtonText: zh() ? '取消' : 'Cancel', type: 'warning' }
    )
  } catch { return }
  lmActionBusy.value = id
  try {
    const res = await AIUtils.lmStudioCli({ action: 'unload', model: id })
    if (res?.ok) ElMessage.success(zh() ? `已卸载「${id}」` : `Unloaded “${id}”`)
    else ElMessage.error(String(res?.error || res?.output || (zh() ? '卸载失败' : 'Unload failed')).slice(0, 300))
  } finally {
    lmActionBusy.value = ''
    await refreshLmModelStates()
  }
}
// 切到本地来源时自动读一次加载状态（挂载 / 改地址 / 点「API 状态」已由 refresh*Models 覆盖）
watch(() => store.AIconfig.llm.type, (t) => {
  if (t === 'lmstudio') void refreshLmModelStates()
  else if (t === 'ollama') void refreshOlModelStates()
})

// ================ 各来源统一的刷新入口（合并到「API 状态」按钮） ================
// 各来源配置块里的「刷新模型列表」按钮已取消：点击块底部的「API 状态」即测试连通性 +
// 回填可用模型 + 刷新加载状态 + 强制重探上下文窗口。
const contextRefreshTick = ref(0)
const onSourceRefreshed = async (key: string): Promise<void> => {
  contextRefreshTick.value++
  if (key === 'lmstudio') await refreshLmModelStates()
  else if (key === 'ollama') await refreshOlModelStates()
}
/** 自定义来源的「连接测试」按钮：同样兼任刷新入口（测试 + 回填模型列表 + 重探上下文窗口） */
const onCustomTestClick = async (): Promise<void> => {
  await testCustomConnection()
  contextRefreshTick.value++
}

// ================ Ollama 模型明细与加载状态（与 LM Studio 面板同款） ================
// 数据源：GET /api/tags（模型 + 体积 + family/参数/量化）、GET /api/ps（已加载实例 + 生效上下文）、
// POST /api/show（capabilities：completion / vision / tools / thinking / embedding、上下文上限、num_ctx）。
// 加载 / 卸载走 /api/generate 的 keep_alive（加载 = 时长；卸载 = 0）。
const olModels = ref<OllamaModelInfo[]>([])
const olLoaded = ref<OllamaLoadedModel[]>([])
const olLoading = ref(false)
const olError = ref('')
/** 正在加载 / 卸载的模型名（空 = 空闲） */
const olActionBusy = ref('')
/** 加载后保持时长 keep_alive（留空 = 30m；-1 = 常驻不过期） */
const olKeepAlive = ref('')

/** 模型名归一化比较（忽略 :latest 后缀差异） */
const normOlName = (n: any): string => String(n || '').trim().toLowerCase().replace(/:latest$/, '')
const olInfoOf = (name: any): OllamaModelInfo | undefined => olModels.value.find(m => normOlName(m.name) === normOlName(name))
const olLoadedOf = (name: any): OllamaLoadedModel | undefined => olLoaded.value.find(m => normOlName(m.name) === normOlName(name))
const olIsLoaded = (name: any): boolean => !!olLoadedOf(name)
const olFmtCtx = (n: number): string => (n > 0 ? (n >= 1024 ? `${Math.round(n / 1024)}K` : String(n)) : '')
const olFmtSize = (bytes?: number): string => {
  const n = Number(bytes || 0)
  if (!n) return ''
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)}G` : `${Math.round(n / 1024 ** 2)}M`
}
/** 模型类型：按 /api/show 的 capabilities 判定（嵌入 / 视觉 / 对话） */
const olTypeLabel = (m?: OllamaModelInfo): string => {
  const caps = m?.capabilities || []
  if (!caps.length) return ''
  if (caps.includes('embedding')) return zh() ? '嵌入' : 'embedding'
  if (caps.includes('vision')) return zh() ? '视觉' : 'vision'
  return zh() ? '对话' : 'chat'
}
/** 上下文：已加载显示「生效」值（含 Ollama 侧设置的 num_ctx）；未加载显示 Modelfile 的 num_ctx（默认） */
const olCtxText = (name: any): string => {
  const eff = Number(olLoadedOf(name)?.contextLength || 0)
  if (eff > 0) return `${zh() ? '生效' : 'eff'} ${olFmtCtx(eff)}`
  const def = Number(olInfoOf(name)?.defaultContextLength || 0)
  if (def > 0) return `${zh() ? '默认' : 'default'} ${olFmtCtx(def)}`
  return ''
}
const olMaxCtxText = (name: any): string => {
  const n = Number(olInfoOf(name)?.maxContextLength || 0)
  return n > 0 ? `${zh() ? '上限' : 'max'} ${olFmtCtx(n)}` : ''
}
/** 行悬停详情：family / 参数规模 / 量化 / 体积 / 能力 / 嵌入维度 / 到期时间 */
const olDetailTitle = (m: OllamaModelInfo): string => {
  const lines: string[] = [m.name]
  const meta = [m.family, m.parameterSize, m.quantization, olFmtSize(m.size)].filter(Boolean).join(' · ')
  if (meta) lines.push(meta)
  if (m.capabilities?.length) lines.push((zh() ? '能力：' : 'capabilities: ') + m.capabilities.join(' / '))
  if (m.embeddingLength) lines.push((zh() ? '嵌入维度：' : 'embedding dim: ') + m.embeddingLength)
  if (m.defaultContextLength) lines.push((zh() ? 'Modelfile num_ctx：' : 'Modelfile num_ctx: ') + m.defaultContextLength)
  if (m.maxContextLength) lines.push((zh() ? '模型上限：' : 'model max: ') + m.maxContextLength)
  const l = olLoadedOf(m.name)
  if (l) {
    lines.push((zh() ? '已加载：内存 ' : 'loaded: size ') + olFmtSize(l.size) + (l.sizeVram ? `，显存 ${olFmtSize(l.sizeVram)}` : ''))
    if (l.contextLength) lines.push((zh() ? '生效上下文：' : 'effective ctx: ') + l.contextLength)
    if (l.expiresAt) lines.push((zh() ? '驻留至：' : 'kept until: ') + l.expiresAt)
  }
  return lines.join('\n')
}
const olSummary = computed(() => {
  if (olLoading.value) return zh() ? '读取中…' : 'Loading…'
  if (!olModels.value.length) return olError.value || (zh() ? '未读取到模型（确认 Ollama 已启动）' : 'No models found (is Ollama running?)')
  const embedN = olModels.value.filter(m => (m.capabilities || []).includes('embedding')).length
  return zh()
    ? `共 ${olModels.value.length} 个，已加载 ${olLoaded.value.length} 个${embedN ? `（含嵌入模型 ${embedN} 个）` : ''}`
    : `${olModels.value.length} models, ${olLoaded.value.length} loaded${embedN ? ` (${embedN} embedding)` : ''}`
})
/** 嵌入模型提示：名称不对或不是嵌入模型时直接点出来（知识库向量化会失败） */
const olEmbedHint = computed(() => {
  const embed = String(store.AIconfig.llm.ollama.embed_model || '').trim()
  if (!embed || !olModels.value.length) return ''
  const info = olInfoOf(embed)
  if (!info) {
    return zh()
      ? `嵌入模型「${embed}」不在 Ollama 本地模型列表里：请核对名称。`
      : `Embedding model “${embed}” is not among Ollama's local models: check the name.`
  }
  const caps = info.capabilities || []
  if (caps.length && !caps.includes('embedding')) {
    return zh()
      ? `「${embed}」不是嵌入模型（能力：${caps.join(' / ')}）：知识库向量化会失败，请改选带「嵌入」标签的模型。`
      : `“${embed}” is not an embedding model (capabilities: ${caps.join(' / ')}); KB embedding will fail — pick one tagged embedding.`
  }
  return ''
})
/** 「默认嵌入模型」下拉候选：Ollama 只保留嵌入模型（能力未知时不过滤，避免下拉空掉） */
const olEmbedCandidates = (list: any[]): string[] => {
  const all = (Array.isArray(list) ? list : []).filter(Boolean)
  const embeds = olModels.value.filter(m => (m.capabilities || []).includes('embedding')).map(m => m.name)
  if (!embeds.length) return all
  const cur = String(store.AIconfig.llm.ollama.embed_model || '').trim()
  return [...new Set([...(cur ? [cur] : []), ...embeds])]
}
/** 重新读取 Ollama 模型清单（tags + ps + show） */
const refreshOlModelStates = async () => {
  if (olLoading.value) return
  olLoading.value = true
  olError.value = ''
  try {
    const res = await AIUtils.listOllamaModels(store.AIconfig.llm.ollama)
    olModels.value = Array.isArray(res?.models) ? res.models : []
    olLoaded.value = Array.isArray(res?.loaded) ? res.loaded : []
    if (!res?.online) olError.value = lmFriendlyError(res?.error) || (zh() ? '无法连接 Ollama' : 'Cannot reach Ollama')
  } catch (e: any) {
    olError.value = String(e?.message || e)
  } finally {
    olLoading.value = false
  }
}
/** 加载模型（预热并驻留 keep_alive 时长） */
const olLoadModel = async (name: string) => {
  if (olActionBusy.value) return
  const keep = String(olKeepAlive.value || '').trim() || '30m'
  try {
    await ElMessageBox.confirm(
      zh() ? `即将在 Ollama 中加载「${name}」，加载后保持 ${keep}${keep === '-1' ? '（常驻）' : ''}。大模型可能需要数分钟并占用内存 / 显存。`
        : `Load “${name}” in Ollama and keep it for ${keep}. Large models may take minutes and occupy RAM / VRAM.`,
      zh() ? '加载模型' : 'Load model',
      { confirmButtonText: zh() ? '开始加载' : 'Load', cancelButtonText: zh() ? '取消' : 'Cancel', type: 'warning' }
    )
  } catch { return }
  olActionBusy.value = name
  const tip = ElMessage({ message: zh() ? `正在加载「${name}」…` : `Loading “${name}”…`, type: 'info', duration: 0 })
  try {
    const res = await AIUtils.ollamaModelAction(store.AIconfig.llm.ollama, 'load', name, keep)
    if (res?.ok) ElMessage.success(zh() ? `已加载「${name}」` : `Loaded “${name}”`)
    else ElMessage.error(String(res?.error || (zh() ? '加载失败' : 'Load failed')).slice(0, 300))
  } finally {
    tip.close()
    olActionBusy.value = ''
    await refreshOlModelStates()
  }
}
/** 卸载模型（keep_alive = 0，立即释放内存 / 显存） */
const olUnloadModel = async (name: string) => {
  if (olActionBusy.value) return
  try {
    await ElMessageBox.confirm(
      zh() ? `即将从 Ollama 卸载「${name}」（keep_alive = 0）。正在进行的对话 / 知识库向量化会中断，需要时再点 ⬇ 重新加载。`
        : `Unload “${name}” from Ollama (keep_alive = 0). Ongoing chats / KB embedding will be interrupted; click ⬇ to load it again.`,
      zh() ? '卸载模型' : 'Unload model',
      { confirmButtonText: zh() ? '卸载' : 'Unload', cancelButtonText: zh() ? '取消' : 'Cancel', type: 'warning' }
    )
  } catch { return }
  olActionBusy.value = name
  try {
    const res = await AIUtils.ollamaModelAction(store.AIconfig.llm.ollama, 'unload', name)
    if (res?.ok) ElMessage.success(zh() ? `已卸载「${name}」` : `Unloaded “${name}”`)
    else ElMessage.error(String(res?.error || (zh() ? '卸载失败' : 'Unload failed')).slice(0, 300))
  } finally {
    olActionBusy.value = ''
    await refreshOlModelStates()
  }
}

// 其余来源：API 密钥 / 凭据引用 切换（各合并为一个 form-group，按钮切换）
const openaiUseCred = ref(false)
const deepseekUseCred = ref(false)
const deepseekResponsesUseCred = ref(false)
const gpustackUseCred = ref(false)
const anthropicUseCred = ref(false)
const googleUseCred = ref(false)
const azureUseCred = ref(false)
const customUseCred = ref(false)
const toggleUseCred = (v: boolean) => !v

/** 根据当前来源的实际配置自动初始化显示模式（仅在选择来源/挂载时调用，之后仍可手动切换）：
 *  有凭据引用(apiKeyRef) → 显示凭据；否则 → 显示 API 密钥 */
const applyUseCredFromConfig = () => {
  const type = store.AIconfig.llm.type
  const hasRef = (ref?: string) => !!(ref || '').trim()
  lmstudioUseCred.value = type === 'lmstudio' ? hasRef(store.AIconfig.llm.lmstudio.apiKeyRef) : false
  openaiUseCred.value = type === 'openai' ? hasRef(store.AIconfig.llm.openai.apiKeyRef) : false
  deepseekUseCred.value = type === 'deepseek' && deepSeekApiStyle(store.AIconfig.llm) === 'chat' ? hasRef(store.AIconfig.llm.deepseek.apiKeyRef) : false
  deepseekResponsesUseCred.value = type === 'deepseek' && deepSeekApiStyle(store.AIconfig.llm) === 'responses' ? hasRef(store.AIconfig.llm.deepseekResponses.apiKeyRef) : false
  gpustackUseCred.value = type === 'gpustack' ? hasRef(store.AIconfig.llm.gpustack.apiKeyRef) : false
  anthropicUseCred.value = type === 'anthropic' ? hasRef(store.AIconfig.llm.anthropic.apiKeyRef) : false
  googleUseCred.value = type === 'google' ? hasRef(store.AIconfig.llm.google.apiKeyRef) : false
  azureUseCred.value = type === 'azure' ? hasRef(store.AIconfig.llm.azure.apiKeyRef) : false
  customUseCred.value = type === 'custom' ? hasRef(store.AIconfig.llm.custom.apiKeyRef) : false
}

// DeepSeek 的「模型下拉/手填」与余额等合并逻辑见下方「DeepSeek：一个来源 + 接口样式」区块
const refreshDeepseekModels = async () => { await store.getAIconfig(); store.saveConfig() }
const handleDeepseekModelChange = () => { store.saveConfig() }

// ================ DeepSeek：单来源 + 接口样式（Chat Completions ⇄ Responses API） ================
// 说明：DeepSeek 是**单一来源**（llm.type='deepseek'），接口样式由 llm.deepseek.api_style 决定
// （'chat' 默认 / 'responses'）。历史来源键 'deepseek-responses' 已合并，不再出现在任何来源列表；
// llm.deepseekResponses 只是「Responses 样式的凭据/模型记忆块」，切换样式时与 deepseek 互相同步密钥与地址。
const isDeepSeekSource = computed(() => store.AIconfig.llm.type === 'deepseek')
/** 当前接口样式（chat=Chat Completions，responses=Responses API）：直接读写 llm.deepseek.api_style */
const dsStyle = computed<'chat' | 'responses'>({
  get: () => deepSeekApiStyle(store.AIconfig.llm),
  set: (v) => setDeepSeekStyle(v),
})
/** 当前接口样式对应的配置对象（两种样式字段结构一致：api_key/base_url/model/embed_model/available_models） */
const dsCfg = computed<any>(() => (dsStyle.value === 'responses' ? store.AIconfig.llm.deepseekResponses : store.AIconfig.llm.deepseek))
/** 嵌入模型「下拉/手填」模式按接口样式分别记忆（本地 UI 键，非来源键） */
const dsEmbedKey = computed(() => (dsStyle.value === 'responses' ? 'deepseek#responses' : 'deepseek'))
/** API 密钥/凭据引用切换：两种样式各自记忆 */
const dsUseCred = computed({
  get: () => (dsStyle.value === 'responses' ? deepseekResponsesUseCred.value : deepseekUseCred.value),
  set: (v: boolean) => {
    if (dsStyle.value === 'responses') deepseekResponsesUseCred.value = v
    else deepseekUseCred.value = v
  },
})
const dsModelMode = ref<'select' | 'input'>('select')
const showDsSelect = computed(() => dsModelMode.value === 'select' && (dsCfg.value.available_models || []).length > 0)
const dsModelOptions = computed(() => {
  const list = (dsCfg.value.available_models || []).filter(Boolean)
  const cur = String(dsCfg.value.model || '').trim()
  if (cur && !list.includes(cur)) return [cur, ...list]
  return list
})
const refreshDsModels = async () => { await store.getAIconfig(); store.saveConfig() }
const handleDsModelChange = () => { store.saveConfig() }
/** 切换接口样式：同步密钥/凭据/地址（目标为空时用当前侧的值），目标模型为空时给默认模型，并刷新余额 */
const setDeepSeekStyle = (v: 'chat' | 'responses') => {
  const llm: any = store.AIconfig.llm
  const toResponses = v === 'responses'
  if (toResponses === (deepSeekApiStyle(llm) === 'responses')) return
  const from: any = toResponses ? llm.deepseek : llm.deepseekResponses
  const to: any = toResponses ? llm.deepseekResponses : llm.deepseek
  if (!to.api_key) to.api_key = from.api_key || ''
  if (!to.apiKeyRef) to.apiKeyRef = from.apiKeyRef || ''
  if (!to.base_url) to.base_url = from.base_url || 'https://api.deepseek.com'
  if (!to.model) to.model = 'deepseek-flash'
  // 唯一事实源：来源仍是 'deepseek'，只改接口样式
  llm.deepseek.api_style = v
  llm.type = 'deepseek'
  applyUseCredFromConfig()
  store.saveConfig()
  fetchDeepSeekBalance()
}

// ================ DeepSeek：账户余额（GET /user/balance） ================
const dsBalance = ref<{ loading: boolean; ok: boolean; text: string }>({ loading: false, ok: false, text: '' })
/** 查询并展示账户余额；未填密钥时提示先填（并发时忽略重复点击） */
const fetchDeepSeekBalance = async () => {
  if (dsBalance.value.loading) return
  const cfg = dsCfg.value || {}
  const apiKey = (await store.resolveApiKey(cfg)) || cfg.api_key || ''
  if (!apiKey) {
    dsBalance.value = { loading: false, ok: false, text: zh() ? '未填 API 密钥，无法查询' : 'No API key configured' }
    return
  }
  dsBalance.value = { loading: true, ok: false, text: zh() ? '查询中...' : 'Loading...' }
  try {
    const r: any = await AIUtils.fetchDeepSeekBalance({ api_key: apiKey, base_url: cfg.base_url })
    if (r?.ok) {
      const infos: any[] = Array.isArray(r.balances) ? r.balances : []
      const text = infos.length
        ? infos.map((b: any) => `${b.currency || ''} ${b.total}${(b.granted || b.toppedUp) ? `（${zh() ? '赠送' : 'granted'} ${b.granted || '0'} / ${zh() ? '充值' : 'top-up'} ${b.toppedUp || '0'}）` : ''}`).join('  ')
        : (zh() ? '查询成功（无余额信息）' : 'OK (no balance info)')
      const msg = `${text}${r.is_available === false ? (zh() ? '（账户不可用）' : ' (unavailable)') : ''}`
      dsBalance.value = { loading: false, ok: true, text: msg }
    } else if (r?.error === 'missing_api_key') {
      dsBalance.value = { loading: false, ok: false, text: zh() ? '未填 API 密钥，无法查询' : 'No API key configured' }
    } else if (r?.error) {
      // 主进程/桥返回的结构化错误（如「未知 provider」= 主进程还是旧版本，需重启应用）
      const hint = /未知 provider/.test(String(r.error))
        ? (zh() ? '（请重启应用以加载主进程新版本）' : ' (restart the app to load the new main process)')
        : ''
      const msg = `${zh() ? '查询失败：' : 'Failed: '}${r.error}${hint}`
      dsBalance.value = { loading: false, ok: false, text: msg }
    } else {
      const st = Number(r?.status || 0)
      const msg = st === 401
        ? (zh() ? '查询失败：API 密钥无效' : 'Failed: invalid API key')
        : (zh() ? '查询失败，请检查地址与网络' : 'Failed; check URL and network')
      dsBalance.value = { loading: false, ok: false, text: msg }
    }
  } catch (e: any) {
    const msg = (zh() ? '查询失败：' : 'Failed: ') + (e?.message || String(e))
    dsBalance.value = { loading: false, ok: false, text: msg }
  }
}

// DeepSeek 余额：进入/切回该来源（含接口样式切换）时自动查询；
// immediate 保证「挂载时已经选中 DeepSeek」也会触发（依赖 fetchDeepSeekBalance，必须声明在其后）
watch(
  () => (isDeepSeekSource.value ? `${store.AIconfig.llm.type}:${dsCfg.value?.base_url || ''}:${dsCfg.value?.api_key || ''}:${dsCfg.value?.apiKeyRef || ''}` : ''),
  (key) => { if (key) fetchDeepSeekBalance() },
  { immediate: true }
)

// GPUStack：模型列表刷新 + 可编辑下拉（与 deepseek 同模式）
const gpustackModelMode = ref<'select' | 'input'>('select')
const showGPUStackSelect = computed(() => {
  if (gpustackModelMode.value !== 'select') return false
  return (store.AIconfig.llm.gpustack.available_models || []).length > 0
})
const gpuStackModelOptions = computed(() => {
  const list = (store.AIconfig.llm.gpustack.available_models || []).filter(Boolean)
  const cur = String(store.AIconfig.llm.gpustack.model || '').trim()
  if (cur && !list.includes(cur)) return [cur, ...list]
  return list
})
const refreshGPUStackModels = async () => { await store.getAIconfig(); store.saveConfig() }
const handleGPUStackModelChange = () => { store.saveConfig() }

// ================ 默认嵌入模型：下拉选择 / 手填兜底 ================
// 按来源 key 记录当前模式（select=下拉 / input=手动输入）
const embedModelMode = ref<Record<string, 'select' | 'input'>>({})
const embedModelModeOf = (key: string): 'select' | 'input' => embedModelMode.value[key] || 'select'
const toggleEmbedModelMode = (key: string) => {
  embedModelMode.value[key] = embedModelModeOf(key) === 'select' ? 'input' : 'select'
}
/** 嵌入模型下拉选项：当前值不在列表时置于首位（保证可选中） */
const embedModelOptions = (key: string, list: any[], cur: string): string[] => {
  const arr = (Array.isArray(list) ? list : []).filter(Boolean)
  const c = String(cur || '').trim()
  if (c && !arr.includes(c)) return [c, ...arr]
  return arr
}

// ================ 嵌入兜底（当前来源无嵌入能力时用哪个来源做向量化） ================
/** 兜底可选内置来源：仅本地/自托管嵌入来源（云端 API 不在此列） */
const EMBED_FALLBACK_KEYS = ['ollama', 'lmstudio', 'gpustack']
/** 兜底可选来源：内置来源 + 逐个自定义来源（与左侧「自定义来源」列表一致）；值形如 'ollama' / 'custom:3' */
const embedFallbackSources = computed(() => {
  const customs = Array.isArray(store.AIconfig.llm.custom?.sources) ? store.AIconfig.llm.custom.sources : []
  return [
    ...llmSources.filter(s => EMBED_FALLBACK_KEYS.includes(s.key)),
    ...customs.map((src: any, i: number) => ({
      key: `custom:${src?.id ?? i}`,
      icon: 'fa-plug',
      labelZh: src?.name || `${zh() ? '自定义' : 'Custom'} ${i + 1}`,
      labelEn: src?.name || `Custom ${i + 1}`,
      descZh: src?.api_url || '',
      descEn: src?.api_url || '',
    })),
  ]
})
/** 兜底下拉绑定值（'ollama' / 'custom:3' / ''=关闭） */
const embedFallbackKey = computed<string>({
  get: () => {
    const fb = store.AIconfig.llm.embeddingFallback
    if (!fb?.llmType) return ''
    if (fb.llmType === 'custom') return `custom:${fb.customSourceId ?? ''}`
    return fb.llmType
  },
  set: (v: string) => {
    const fb = store.AIconfig.llm.embeddingFallback
    if (!fb) return
    if (!v) {
      fb.llmType = ''
      fb.customSourceId = null
    } else if (v.startsWith('custom:')) {
      fb.llmType = 'custom'
      const id = Number(v.slice('custom:'.length))
      fb.customSourceId = Number.isFinite(id) ? id : null
    } else {
      fb.llmType = v
      fb.customSourceId = null
    }
    store.saveConfig()
  },
})
/** 兜底来源的连接配置（用于模型候选与提示；自定义来源按指定 id 解析） */
const embedFallbackSrcCfg = computed<any>(() => {
  const fb = store.AIconfig.llm.embeddingFallback
  return fb?.llmType ? (getProviderConfig(store.AIconfig.llm, fb.llmType, fb.customSourceId ?? null) || {}) : {}
})
/** 兜底提示：连接配置沿用该来源 + 模型留空时的实际取值 */
const embedFallbackHint = computed(() => {
  const t = store.AIconfig.llm.embeddingFallback?.llmType
  if (!t) {
    return zh()
      ? '当前来源不提供嵌入接口时（如 DeepSeek / Anthropic），知识库与检索的向量化会直接报错。'
      : 'If the current source has no embedding endpoint (e.g. DeepSeek / Anthropic), knowledge base & retrieval embedding will fail.'
  }
  const def = String(embedFallbackSrcCfg.value?.embed_model || (t === 'ollama' ? 'nomic-embed-text:latest' : ''))
  const reuse = zh() ? '连接配置沿用该来源在设置里的地址与密钥' : 'Connection settings reuse that source config'
  const used = zh()
    ? `模型留空 = 用该来源默认${def ? `（${def}）` : '（该来源未配置嵌入模型，需手选）'}`
    : `Empty model = source default${def ? ` (${def})` : ' (not configured - pick one)'}`
  return `${reuse}；${used}`
})
/** 兜底嵌入模型候选：当前值 + 该来源配置的嵌入模型 + 该来源已拉取的模型列表 */
const embedFallbackModels = computed<string[]>(() => {
  const fb = store.AIconfig.llm.embeddingFallback
  if (!fb?.llmType) return []
  const cfg = embedFallbackSrcCfg.value || {}
  const list: string[] = (Array.isArray(cfg.available_models) ? cfg.available_models : []).filter(Boolean)
  const cur = String(fb?.model || '').trim()
  const def = String(cfg.embed_model || '').trim()
  return [...new Set([...(cur ? [cur] : []), ...(def ? [def] : []), ...list])]
})
const embedFallbackLoading = ref(false)
/** 兜底来源的「嵌入模型」名单（Ollama 按 capabilities、LM Studio 按 type；无法判定时为空 = 不过滤） */
const embedFallbackEmbedNames = ref<string[]>([])
/** 拉取兜底来源的嵌入模型名单（仅本地来源有类型信息；云端 / 自定义来源留空，不过滤） */
const fetchEmbedFallbackEmbedNames = async (v: string): Promise<void> => {
  const cfg = embedFallbackSrcCfg.value || {}
  try {
    if (v === 'ollama') {
      const r: any = await AIUtils.listOllamaModels(cfg)
      embedFallbackEmbedNames.value = (r?.models || [])
        .filter((m: any) => (m.capabilities || []).includes('embedding'))
        .map((m: any) => String(m.name))
    } else if (v === 'lmstudio') {
      const r: any = await AIUtils.listLmStudioModels(cfg)
      embedFallbackEmbedNames.value = (r?.models || [])
        .filter((m: any) => /^embedding/i.test(String(m.type || '')))
        .map((m: any) => String(m.id))
    } else {
      embedFallbackEmbedNames.value = []
    }
  } catch {
    embedFallbackEmbedNames.value = []
  }
}
/** 兜底嵌入模型候选（只留嵌入模型；类型未知时不过滤；当前值始终保留可选中） */
const embedFallbackModelOptions = computed<string[]>(() => {
  const all = embedFallbackModels.value
  const embeds = embedFallbackEmbedNames.value
  if (!embeds.length) return all
  const cur = String(store.AIconfig.llm.embeddingFallback?.model || '').trim()
  // 已拿到该来源的嵌入模型名单：直接以它为准（该来源 list 为空/未拉取时也有候选）
  return [...new Set([...(cur ? [cur] : []), ...embeds, ...all.filter(m => embeds.includes(m))])]
})
/** 选中值不是该来源的嵌入模型时的提醒（否则知识库向量化会失败） */
const embedFallbackEmbedHint = computed(() => {
  const cur = String(store.AIconfig.llm.embeddingFallback?.model || '').trim()
  const embeds = embedFallbackEmbedNames.value
  if (!cur || !embeds.length || embeds.includes(cur)) return ''
  return zh()
    ? `「${cur}」不在该来源的嵌入模型列表里（知识库向量化会失败）：请改选带「嵌入」标签的模型，或清空以使用该来源默认。`
    : `“${cur}” is not an embedding model of that source (KB embedding will fail); pick an embedding-tagged model or clear it to use the source default.`
})
/** 自动/手动刷新兜底来源的模型列表（自定义来源按 id 单独探测，内置来源复用 testLlmSource） */
const refreshEmbedFallbackModels = async (key?: string) => {
  const v = key !== undefined ? key : embedFallbackKey.value
  if (!v || embedFallbackLoading.value) return
  embedFallbackLoading.value = true
  try {
    if (v.startsWith('custom:')) {
      const fb = store.AIconfig.llm.embeddingFallback
      const cfg = getProviderConfig(store.AIconfig.llm, 'custom', fb?.customSourceId ?? null) || {}
      const r: any = await AIUtils.checkCustomConnection({ ...cfg, api_key: (await store.resolveApiKey(cfg)) || cfg.api_key })
      const models: string[] = Array.isArray(r?.available_models) ? r.available_models : []
      const srcs = store.AIconfig.llm.custom?.sources || []
      const target = srcs.find((s: any) => s?.id === fb?.customSourceId) || srcs[0]
      if (target && models.length) target.available_models = models
      if (typeof fb?.customSourceId === 'number') {
        store.llmCustomSourceStatus[fb.customSourceId] = r?.online ? 'online' : 'offline'
      }
      if (models.length) store.saveConfig()
    } else {
      await store.testLlmSource(v)
    }
    // 顺带拉取该来源的嵌入模型名单（本地来源可按 capabilities / type 过滤候选）
    await fetchEmbedFallbackEmbedNames(v)
  } catch (e) {
    console.warn('[LLM] 拉取兜底来源模型列表失败:', v, e)
  } finally {
    embedFallbackLoading.value = false
  }
}
// 切换兜底来源 → 自动拉取该来源的模型列表（下拉候选立即有值）
watch(embedFallbackKey, (v) => { if (v) refreshEmbedFallbackModels(v) })

// ================ 自定义来源：刷新模型 + 下拉/手填兜底 ================

const customModelMode = ref<'select' | 'input'>('select')
const customModelLoading = ref(false)
/** 是否显示下拉（有可用模型列表 且 未切到手填模式） */
const showCustomSelect = computed(() => {
  if (customModelMode.value !== 'select') return false
  const list = store.AIconfig.llm.custom.available_models || []
  return list.length > 0
})
/** 下拉选项：当前模型不在列表时置于首位（保证可选中） */
const customModelOptions = computed(() => {
  const list = (store.AIconfig.llm.custom.available_models || []).filter(Boolean)
  const cur = String(store.AIconfig.llm.custom.model || '').trim()
  if (cur && !list.includes(cur)) return [cur, ...list]
  return list
})
/** 刷新当前自定义来源的可用模型（从 api_url 推导 /models 端点；失败则回退手填） */
const refreshCustomModels = async () => {
  const c = store.AIconfig.llm.custom
  if (!String(c.api_url || '').trim()) {
    // 未填写 API 地址时不拉取；保留已缓存的模型列表与默认模型/嵌入模型，避免瞬断或暂未填写时丢数据
    return
  }
  customModelLoading.value = true
  try {
    await store.getAIconfig() // 内部已按 custom 走 checkCustomConnection 并回填 available_models
    // 成功拉到列表 → 自动切下拉；失败（空列表）→ 兜底手填
    const list = store.AIconfig.llm.custom.available_models || []
    customModelMode.value = list.length ? 'select' : 'input'
    syncCustomSource()
  } finally {
    customModelLoading.value = false
  }
}
const toggleCustomModelMode = () => {
  customModelMode.value = customModelMode.value === 'select' ? 'input' : 'select'
}
const handleCustomModelChange = () => { syncCustomSource() }

// ================ 自定义来源：连接测试 ================
const customTestStatus = ref<'idle' | 'testing' | 'ok' | 'fail'>('idle')
const customTestMsg = ref('')
/** 测试当前自定义来源（api_url + api_key/apiKeyRef）：成功则回填模型列表并刷新下拉 */
const testCustomConnection = async () => {
  const c = store.AIconfig.llm.custom
  // 扁平 custom 无 id，需取当前激活来源的 id（sources[activeIndex].id）
  const activeSrcId = (Array.isArray(c.sources) && c.sources[c.activeIndex]) ? c.sources[c.activeIndex].id : undefined
  const apiUrl = String(c.api_url || '').trim()
  if (!apiUrl) {
    customTestStatus.value = 'fail'
    customTestMsg.value = zh() ? '请先填写 API 地址' : 'Please fill in the API URL'
    // 未填写地址也提交当前已编辑内容，避免关闭/刷新时丢失
    syncCustomSource()
    return
  }
  customTestStatus.value = 'testing'
  customTestMsg.value = zh() ? '测试中...' : 'Testing...'
  try {
    syncCustomSource(false)
    const cfg = { ...store.AIconfig.llm.custom, api_key: (await store.resolveApiKey(store.AIconfig.llm.custom)) || store.AIconfig.llm.custom.api_key }
    const r = await AIUtils.checkCustomConnection(cfg)
    const models = Array.isArray(r.available_models) ? r.available_models : []
    if (r.online) {
      customTestStatus.value = 'ok'
      if (activeSrcId !== undefined) store.llmCustomSourceStatus[activeSrcId] = 'online'
      if (models.length) {
        customTestMsg.value = zh() ? `连接成功，发现 ${models.length} 个模型` : `Connected, ${models.length} models`
        ElMessage.success(customTestMsg.value)
      } else {
        customTestMsg.value = zh() ? '连接成功（未获取到模型列表）' : 'Connected (no models)'
      }
      // 测试成功即回填模型列表并同步到 sources，避免下次只能手填
      store.AIconfig.llm.custom.available_models = models
      customModelMode.value = models.length ? 'select' : 'input'
      syncCustomSource()
    } else {
      customTestStatus.value = 'fail'
      if (activeSrcId !== undefined) store.llmCustomSourceStatus[activeSrcId] = 'offline'
      const status = Number(r?.status || 0)
      if (status === 401) {
        // 401 = 认证失败：提示可能凭据错误
        customTestMsg.value = zh()
          ? '连接失败：可能凭据（API Key）错误，请检查 API 密钥'
          : 'Connection failed: possible credential (API key) error, please check the API key'
        ElMessage.warning(customTestMsg.value)
      } else {
        customTestMsg.value = zh() ? '连接失败，请检查 API 地址、端口与密钥' : 'Connection failed; check URL, port and key'
      }
      // 连接失败也保存配置：测试即提交（地址/密钥/默认模型/嵌入模型都持久化），避免离线时丢数据
      syncCustomSource()
    }
  } catch (e: any) {
    customTestStatus.value = 'fail'
    customTestMsg.value = (zh() ? '连接失败：' : 'Connection failed: ') + (e?.message || String(e))
    // 异常也保存，防止已填配置丢失
    syncCustomSource()
  }
}

// ================ 连接测试 ================
// 内置来源：左侧列表状态圆点 + 进入模块时自动测试全部来源；
// 自定义来源：右侧「连接测试」按钮（见上方 testCustomConnection）。

// 离开设置页/窗口关闭前立即落盘未保存的编辑（防抖窗口内关闭/切换导致丢失）
const flushCustomSave = () => {
  clearTimeout(customSaveTimer)
  syncCustomSource()
}
onBeforeUnmount(() => {
  flushCustomSave()
  window.removeEventListener('beforeunload', flushCustomSave)
})

// 挂载时：① 测试全部来源连接状态；② 延迟刷新当前来源的模型列表（不覆盖已选模型）；③ 初始化自定义来源列表；④ 窗口关闭前落盘
onMounted(() => {
  ensureCustomSources()
  applyUseCredFromConfig()
  // 兼容旧存档：嵌入兜底字段缺失时补默认值（默认 Ollama）；自定义来源需落到具体来源 id
  const fbSetting = store.AIconfig.llm.embeddingFallback
  const customSrcs = Array.isArray(store.AIconfig.llm.custom?.sources) ? store.AIconfig.llm.custom.sources : []
  if (!fbSetting) {
    store.AIconfig.llm.embeddingFallback = { llmType: 'ollama', customSourceId: null, model: '' }
  } else if (fbSetting.llmType === 'custom') {
    if (typeof fbSetting.customSourceId !== 'number' || !customSrcs.some((s: any) => s?.id === fbSetting.customSourceId)) {
      const act = store.AIconfig.llm.custom?.activeIndex ?? 0
      fbSetting.customSourceId = customSrcs[act]?.id ?? customSrcs[0]?.id ?? null
    }
  } else if (fbSetting.llmType && !EMBED_FALLBACK_KEYS.includes(fbSetting.llmType)) {
    fbSetting.llmType = 'ollama'
  }
  store.testAllLlmSources()
  // 嵌入兜底：首次进入且尚无候选时自动拉一次（testAllLlmSources 通常已填充，这里只做兜底）
  if (store.AIconfig.llm.embeddingFallback?.llmType && embedFallbackModels.value.length === 0) {
    refreshEmbedFallbackModels()
  } else if (store.AIconfig.llm.embeddingFallback?.llmType) {
    // 已配置兜底来源：补拉一次嵌入模型名单（用于过滤「兜底嵌入模型」下拉）
    void fetchEmbedFallbackEmbedNames(embedFallbackKey.value)
  }
  window.addEventListener('beforeunload', flushCustomSave)
  setTimeout(async () => {
    // 以「存档中的类型」决定是否自动刷新，避免内存 type 与存档不一致（如应为 custom 却显示 ollama）时
    // 误调用 ollama 刷新并把 ollama 写回存档
    let savedType = ''
    try {
      const s = localStorage.getItem('AIconfig')
      if (s) savedType = (JSON.parse(s)?.llm?.type) || ''
    } catch { /* 存档解析失败则回退内存类型 */ }
    const effType = savedType || store.AIconfig.llm.type
    if (effType === 'ollama') await refreshOllamaModels()
    else if (effType === 'lmstudio') await refreshLMStudioModels()
  }, 100)
})
</script>

<template>
  <div class="llm-settings">
    <!-- ====== 左侧：模型来源列表 ====== -->
    <div class="llm-sidebar">
      <div class="llm-toolbar">
        <div class="notes-search-box">
          <i class="fa fa-search"></i>
          <input v-model="llmSourceKeyword" class="notes-search-input"
            :placeholder="zh() ? '搜索来源' : 'Search sources'" />
          <div v-if="llmSourceKeyword" class="notes-search-clear" @click="llmSourceKeyword = ''"
            :title="zh() ? '清除' : 'Clear'">
            <i class="fa fa-times-circle"></i>
          </div>
        </div>
        <!-- 添加自定义来源（样式同 Todo top-toolbar 操作按钮） -->
        <div class="toolbar-action-btn llm-add-btn" @click="addCustomSource"
          :title="zh() ? '添加自定义来源' : 'Add custom source'">
          <i class="fa fa-plus"></i>
        </div>
      </div>
      <div class="llm-source-list scoll">
        <div v-if="filteredLlmSources.length === 0 && filteredCustomSources.length === 0" class="empty-hint" style="height:auto;padding:16px 0;">
          <i class="fa fa-search" style="font-size:20px;"></i>
          <span>{{ zh() ? '无匹配来源' : 'No matching sources' }}</span>
        </div>
        <div
          v-for="s in filteredLlmSources"
          :key="s.key"
          class="llm-source-item"
          :class="{ active: llmSourceActive(s.key), disabled: store.isLlmSourceDisabled(s.key) }"
          @click="selectLlmSource(s.key)"
          :title="zh() ? s.descZh : s.descEn"
        >
          <div class="llm-source-avatar"><i class="fa" :class="s.icon"></i></div>
          <div class="llm-source-info">
            <span class="llm-source-name">{{ zh() ? s.labelZh : s.labelEn }}</span>
            <span class="llm-source-desc">{{ zh() ? s.descZh : s.descEn }}</span>
          </div>
          <span class="llm-source-status" :class="llmSourceStatus(s.key)">
            <i class="fa" :class="llmSourceStatus(s.key) === 'online' ? 'fa-check-circle' : llmSourceStatus(s.key) === 'offline' ? 'fa-times-circle' : 'fa-circle-thin'"></i>
          </span>
          <span class="llm-source-toggle" @click.stop="store.toggleLlmSource(s.key)"
            :title="store.isLlmSourceDisabled(s.key) ? (zh() ? '启用该来源' : 'Enable source') : (zh() ? '禁用该来源（home/RAG/工作流中不显示）' : 'Disable source (hidden in home/RAG/workflow)')">
            <i class="fa" :class="store.isLlmSourceDisabled(s.key) ? 'fa-toggle-off' : 'fa-toggle-on'"></i>
          </span>
        </div>

        <!-- 自定义来源分组 -->
        <template v-if="customSources.length">
          <div class="llm-source-group-title">
            <span>{{ zh() ? '自定义来源' : 'Custom Sources' }}</span>
            <span class="llm-source-group-count">{{ customSources.length }}</span>
          </div>
          <div
            v-for="cs in filteredCustomSources"
            :key="cs.src.id"
            class="llm-source-item custom"
            :class="{ active: customActive(cs.index), disabled: store.isLlmSourceDisabled('custom', cs.src.id) }"
            @click="selectCustomSource(cs.index)"
            :title="zh() ? '自定义 API' : 'Custom API'"
          >
            <div class="llm-source-avatar"><i class="fa fa-plug"></i></div>
            <div class="llm-source-info">
              <input v-if="renameIndex === cs.index" v-model="renameText"
                class="llm-source-rename-input" :placeholder="customDefaultName()"
                @click.stop @keydown.enter="commitRename" @keydown.esc="cancelRename"
                @blur="commitRename" autofocus />
              <template v-else>
                <span class="llm-source-name">{{ customName(cs.src) }}</span>
                <span class="llm-source-desc">{{ zh() ? '自定义 API' : 'Custom API' }}</span>
              </template>
            </div>
            <div class="llm-source-actions" @click.stop>
              <i class="fa fa-trash-o" @click="removeCustomSource(cs.index)"
                :title="zh() ? '删除' : 'Delete'"></i>
            </div>
            <span class="llm-source-status" :class="customSourceStatusOf(cs.src.id)">
              <i class="fa" :class="customSourceStatusOf(cs.src.id) === 'online' ? 'fa-check-circle' : customSourceStatusOf(cs.src.id) === 'offline' ? 'fa-times-circle' : 'fa-circle-thin'"></i>
            </span>
            <span class="llm-source-toggle" @click.stop="store.toggleLlmSource('custom', cs.src.id)"
              :title="store.isLlmSourceDisabled('custom', cs.src.id) ? (zh() ? '启用该来源' : 'Enable source') : (zh() ? '禁用该来源（home/RAG/工作流中不显示）' : 'Disable source (hidden in home/RAG/workflow)')">
              <i class="fa" :class="store.isLlmSourceDisabled('custom', cs.src.id) ? 'fa-toggle-off' : 'fa-toggle-on'"></i>
            </span>
          </div>
        </template>
      </div>
    </div>

    <!-- ====== 右侧：当前来源配置 ====== -->
    <div class="llm-content scoll">
      <div class="settings-group">
        <div class="llm-content-header">
          <h3>{{ zh() ? '大语言模型设置' : 'Large Language Model Settings' }}</h3>
          <div class="config-description" style="margin-left:0;margin-top:2px;font-size: 10px;">
            {{ getCurrentConfigHelp }}
          </div>
        </div>

        <!-- Ollama配置 -->
        <div v-if="store.AIconfig.llm.type === 'ollama'" class="llm-config-block">
          <div class="form-group">
            <label>{{ zh()?'模型地址' : 'Model URL' }}</label>
            <div class="input-with-button">
              <input :title="zh()?'例如: http://127.0.0.1:11434' : 'Example: http://127.0.0.1:11434'"
                    v-model="store.AIconfig.llm.ollama.model_url"
                    :placeholder="zh()?'请输入模型地址' : 'Enter model URL'"
                    @change="handleOllamaUrlChange"/>
            </div>
          </div>
          <div class="form-group">
            <label>{{ zh()?'模型类型' : 'Model Type' }}</label>
            <div class="input-with-button">
              <select v-model="store.AIconfig.llm.ollama.model" @change="handleOllamaModelChange">
                <option value="">{{ zh()?'请选择模型' : 'Select model' }}</option>
                <option v-for="(model, index) in store.AIconfig.llm.ollama.available_models" :key="index" :value="model">
                  {{ model }}
                </option>
              </select>
            </div>
          </div>
          <div class="form-group">
            <label>{{ zh()?'默认嵌入模型' : 'Default Embedding Model' }}</label>
            <div class="input-with-button">
              <select v-if="embedModelModeOf('ollama') === 'select'" v-model="store.AIconfig.llm.ollama.embed_model">
                <option value="">{{ zh()?'请选择嵌入模型' : 'Select embedding model' }}</option>
                <option v-for="m in embedModelOptions('ollama', olEmbedCandidates(store.AIconfig.llm.ollama.available_models), store.AIconfig.llm.ollama.embed_model)" :key="m" :value="m">{{ m }}</option>
              </select>
              <input v-else v-model="store.AIconfig.llm.ollama.embed_model"
                    :placeholder="zh()?'例如: nomic-embed-text:latest' : 'Example: nomic-embed-text:latest'"/>
              <div class="button" style="width:30px;margin:0px;padding:4px 0px" @click="toggleEmbedModelMode('ollama')"
                  :title="embedModelModeOf('ollama') === 'select' ? (zh()?'手动输入' : 'Manual input') : (zh()?'下拉选择' : 'Select')">
                <i class="fa" :class="embedModelModeOf('ollama') === 'select' ? 'fa-pencil' : 'fa-list'"></i>
              </div>
            </div>
          </div>
          <!-- Ollama 模型明细与加载状态（与 LM Studio 面板同款：grid 对齐、不限高度、可加载/卸载）
               可见：类型（按 /api/show capabilities）/ 生效或默认上下文 / 模型上限 / 是否已加载；悬停看参数·量化·体积·能力 -->
          <div class="form-group lm-models-group">
            <label>{{ zh()?'模型加载状态' : 'Loaded Models' }}</label>
            <div class="input-with-button">
              <div class="lm-models-box">
                <div class="lm-models-head">
                  <span class="lm-status-dot" :class="olModels.length ? (olLoaded.length ? 'ok' : 'warn') : 'off'"></span>
                  <span class="lm-models-summary">{{ olSummary }}</span>
                </div>
                <div v-if="olModels.length" class="lm-models-list">
                  <div v-for="m in olModels" :key="m.name" class="lm-model-row">
                    <i class="fa lm-row-icon" :class="olIsLoaded(m.name) ? 'fa-check-circle is-loaded' : 'fa-circle-o'"></i>
                    <span class="lm-model-name" :class="{ dim: !olIsLoaded(m.name) }" :title="olDetailTitle(m)">{{ m.name }}</span>
                    <span class="lm-model-tag" :class="{ dim: !olIsLoaded(m.name) }">{{ olTypeLabel(m) || '—' }}</span>
                    <span class="lm-model-ctx-set" :title="zh() ? '已加载实例实际生效的上下文长度（含 Ollama 侧设置的 num_ctx）；未加载时显示 Modelfile 的 num_ctx' : 'Effective context of the loaded instance (incl. num_ctx set in Ollama); Modelfile num_ctx when unloaded'">{{ olCtxText(m.name) }}</span>
                    <span class="lm-model-ctx" :title="zh() ? '模型能力上限（不等于实际生效值）' : 'Model capability max (not the effective value)'">{{ olMaxCtxText(m.name) }}</span>
                    <span class="lm-model-state" :title="olLoadedOf(m.name)?.expiresAt ? (zh() ? '驻留至 ' : 'kept until ') + (olLoadedOf(m.name)?.expiresAt || '') : undefined">{{ olIsLoaded(m.name) ? (zh()?'已加载':'loaded') : (zh()?'未加载':'not loaded') }}</span>
                    <span class="button lm-row-btn" :class="{ busy: olActionBusy === m.name }"
                          :title="olIsLoaded(m.name) ? (zh()?'卸载该模型（立即释放内存 / 显存）':'Unload this model (frees RAM / VRAM now)') : (zh()?'加载该模型并驻留（keep_alive）':'Load this model and keep it alive')"
                          @click.stop="olIsLoaded(m.name) ? olUnloadModel(m.name) : olLoadModel(m.name)">
                      <i class="fa" :class="olActionBusy === m.name ? 'fa-spinner fa-spin' : (olIsLoaded(m.name) ? 'fa-eject' : 'fa-download')"></i>
                    </span>
                  </div>
                </div>
                <div v-if="olModels.length" class="lm-load-ctx">
                  <span class="lm-load-ctx-label">{{ zh()?'加载后保持' : 'Keep alive' }}</span>
                  <input v-model="olKeepAlive" class="lm-load-ctx-input" :placeholder="zh()?'留空 = 30m（-1 = 常驻不过期）' : 'Empty = 30m (-1 = never expire)'"/>
                </div>
                <div v-if="olEmbedHint && olModels.length" class="config-description lm-embed-hint">{{ olEmbedHint }}</div>
              </div>
            </div>
          </div>
          <!-- 上下文窗口（圆环分母）：Ollama 手动设置的上下文长度体现在已加载实例上，点块底部「API 状态」可重读 -->
          <ModelContextWindow provider="ollama" :config="store.AIconfig.llm.ollama" :model="store.AIconfig.llm.ollama.model" :refresh-token="contextRefreshTick" :hide-window="true" />
          <!-- API 状态测试（配置块底部唯一按钮：测试连通性 + 刷新模型列表 / 加载状态 / 上下文窗口） -->
          <LlmTestRow source-key="ollama" @refreshed="onSourceRefreshed" />
        </div>

        <!-- LM Studio 配置 -->
        <div v-if="store.AIconfig.llm.type === 'lmstudio'" class="llm-config-block">
          <div class="form-group">
            <label>{{ zh()?'服务地址' : 'Service URL' }}</label>
            <input v-model="store.AIconfig.llm.lmstudio.base_url"
                  :placeholder="zh()?'例如: http://localhost:1234' : 'Example: http://localhost:1234'"
                  @change="handleLMStudioUrlChange"/>
          </div>
          <div class="form-group">
            <label>{{ zh()?'模型名称' : 'Model Name' }}</label>
            <div class="input-with-button">
              <select v-model="store.AIconfig.llm.lmstudio.model" @change="handleLMStudioModelChange">
                <option value="">{{ zh()?'请选择模型' : 'Select model' }}</option>
                <option v-for="model in store.AIconfig.llm.lmstudio.available_models" :key="model" :value="model">
                  {{ model }}{{ lmSuffix(model) }}
                </option>
              </select>
            </div>
          </div>
          <div class="form-group">
            <label>{{ lmstudioUseCred ? (zh()?'凭据引用' : 'Credential') : (zh()?'API密钥(可选)' : 'API Key (Optional)') }}</label>
            <div class="input-with-button">
              <input v-if="lmstudioUseCred" v-model="store.AIconfig.llm.lmstudio.apiKeyRef"
                    :placeholder="zh()?'填凭据管理中的名称，优先于 API 密钥' : 'Credential name from Credentials panel; takes precedence'"/>
              <input v-else type="password" v-model="store.AIconfig.llm.lmstudio.api_key"
                    :placeholder="zh()?'LM Studio 默认不需要 API 密钥' : 'LM Studio does not require API key by default'"/>
              <div class="button" style="width:30px;margin:0px;padding:4px 0px" @click="toggleLmstudioUseCred"
                  :title="lmstudioUseCred ? (zh()?'使用 API 密钥' : 'Use API key') : (zh()?'使用凭据引用' : 'Use credential')">
                <i class="fa" :class="lmstudioUseCred ? 'fa-key' : 'fa-credit-card'"></i>
              </div>
            </div>
          </div>
          <div class="form-group">
            <label>{{ zh()?'默认嵌入模型' : 'Default Embedding Model' }}</label>
            <div class="input-with-button">
              <select v-if="embedModelModeOf('lmstudio') === 'select'" v-model="store.AIconfig.llm.lmstudio.embed_model">
                <option value="">{{ zh()?'请选择嵌入模型' : 'Select embedding model' }}</option>
                <option v-for="m in embedModelOptions('lmstudio', lmEmbedCandidates(store.AIconfig.llm.lmstudio.available_models), store.AIconfig.llm.lmstudio.embed_model)" :key="m" :value="m">{{ m }}{{ lmSuffix(m) }}</option>
              </select>
              <input v-else v-model="store.AIconfig.llm.lmstudio.embed_model"
                    :placeholder="zh()?'例如: nomic-embed-text:latest' : 'Example: nomic-embed-text:latest'"/>
              <div class="button" style="width:30px;margin:0px;padding:4px 0px" @click="toggleEmbedModelMode('lmstudio')"
                  :title="embedModelModeOf('lmstudio') === 'select' ? (zh()?'手动输入' : 'Manual input') : (zh()?'下拉选择' : 'Select')">
                <i class="fa" :class="embedModelModeOf('lmstudio') === 'select' ? 'fa-pencil' : 'fa-list'"></i>
              </div>
            </div>
          </div>
          <!-- LM Studio 模型加载状态：type（对话/视觉/嵌入）、是否已加载、LM Studio 设置的上限，并可加载/卸载
               （无刷新按钮：统一由下方「API 状态」触发；列表用 grid 逐列对齐，不限高度、不出滑块） -->
          <div class="form-group lm-models-group">
            <label>{{ zh()?'模型加载状态' : 'Loaded Models' }}</label>
            <div class="input-with-button">
              <div class="lm-models-box">
                <div class="lm-models-head">
                  <span class="lm-status-dot" :class="lmModels.length ? (lmLoadedList.length ? 'ok' : 'warn') : 'off'"></span>
                  <span class="lm-models-summary">{{ lmModels.length ? lmModelsSummary : (lmModelsError || lmModelsSummary) }}</span>
                </div>
                <div v-if="lmCurrentCtxText" class="config-description lm-ctx-line">{{ lmCurrentCtxText }}</div>
                <div v-if="lmModels.length" class="lm-models-list">
                  <div v-for="m in lmModels" :key="m.id" class="lm-model-row">
                    <i class="fa lm-row-icon" :class="lmIsLoaded(m.id) ? 'fa-check-circle is-loaded' : 'fa-circle-o'"></i>
                    <span class="lm-model-name" :class="{ dim: !lmIsLoaded(m.id) }" :title="m.id">{{ m.id }}</span>
                    <span class="lm-model-tag" :class="{ dim: !lmIsLoaded(m.id) }">{{ lmTypeLabel(m.type) || '—' }}</span>
                    <span class="lm-model-ctx-set" :title="zh() ? 'LM Studio 里设置的上下文长度（已加载实例实际生效值）' : 'Context length set in LM Studio (effective on the loaded instance)'">{{ lmSetCtxText(m.id) }}</span>
                    <span class="lm-model-ctx" :title="zh() ? '模型能力上限（模型未加载时读不到 LM Studio 里设置的上下文长度）' : 'Model capability max (cannot read the LM Studio setting while unloaded)'">{{ lmMaxCtxText(m.id) }}</span>
                    <span class="lm-model-state" :title="lmStatusLabel(m.id) || undefined">{{ lmStateText(m.id) }}</span>
                    <span v-if="lmCliAvailable" class="button lm-row-btn" :class="{ busy: lmActionBusy === m.id }"
                          :title="lmIsLoaded(m.id) ? (zh()?'卸载该模型（释放显存）':'Unload this model (frees VRAM)') : (zh()?'在 LM Studio 中加载该模型':'Load this model in LM Studio')"
                          @click.stop="lmIsLoaded(m.id) ? lmUnloadModel(lmLoadedOf(m.id)?.identifier || m.id) : lmLoadModel(m.id)">
                      <i class="fa" :class="lmActionBusy === m.id ? 'fa-spinner fa-spin' : (lmIsLoaded(m.id) ? 'fa-eject' : 'fa-download')"></i>
                    </span>
                  </div>
                </div>
                <div v-if="lmCliAvailable && lmModels.length" class="lm-load-ctx">
                  <span class="lm-load-ctx-label">{{ zh()?'加载时上下文长度' : 'Context length on load' }}</span>
                  <input v-model="lmLoadContext" class="lm-load-ctx-input" :placeholder="zh()?'留空 = LM Studio 默认' : 'Empty = LM Studio default'"/>
                  <span class="lm-load-ctx-unit">tokens</span>
                </div>
                <div v-if="lmCliHint && lmModels.length" class="config-description lm-embed-hint">{{ lmCliHint }}</div>
                <div v-if="lmEmbedHint && lmModels.length" class="config-description lm-embed-hint">{{ lmEmbedHint }}</div>
                <div v-if="lmCliError && lmCliAvailable && lmModels.length" class="config-description lm-embed-hint">{{ lmCliError }}</div>
              </div>
            </div>
          </div>
          <!-- 上下文窗口（圆环分母）：LM Studio 已加载模型的窗口可读 -->
          <ModelContextWindow provider="lmstudio" :config="store.AIconfig.llm.lmstudio" :model="store.AIconfig.llm.lmstudio.model" :refresh-token="contextRefreshTick" :hide-window="true" />
          <!-- API 状态（配置块底部唯一按钮：测试连通性 + 刷新模型列表 / 加载状态 / 上下文窗口） -->
          <LlmTestRow source-key="lmstudio" @refreshed="onSourceRefreshed" />
        </div>

        <!-- OpenAI 配置（独立） -->
        <div v-if="store.AIconfig.llm.type === 'openai'" class="llm-config-block">
          <div class="form-group">
            <label>{{ openaiUseCred ? (zh()?'凭据引用' : 'Credential') : (zh()?'API密钥' : 'API Key') }}</label>
            <div class="input-with-button">
              <input v-if="openaiUseCred" v-model="store.AIconfig.llm.openai.apiKeyRef"
                    :placeholder="zh()?'填凭据管理中的名称（如 openai-key），优先于 API 密钥' : 'Credential name from Credentials panel (e.g. openai-key); takes precedence'"/>
              <input v-else type="password" v-model="store.AIconfig.llm.openai.api_key"
                    :placeholder="zh()?'请输入API密钥' : 'Enter API key'"/>
              <div class="button" style="width:30px;margin:0px;padding:4px 0px" @click="openaiUseCred = toggleUseCred(openaiUseCred)"
                  :title="openaiUseCred ? (zh()?'使用 API 密钥' : 'Use API key') : (zh()?'使用凭据引用' : 'Use credential')">
                <i class="fa" :class="openaiUseCred ? 'fa-key' : 'fa-credit-card'"></i>
              </div>
            </div>
          </div>
          <div class="form-group">
            <label>{{ zh()?'API地址' : 'API URL' }}</label>
            <input v-model="store.AIconfig.llm.openai.base_url"
                  :placeholder="zh()?'例如: https://api.openai.com/v1' : 'Example: https://api.openai.com/v1'"/>
          </div>
          <div class="form-group">
            <label>{{ zh()?'模型名称' : 'Model Name' }}</label>
            <div class="input-with-button">
              <input v-model="store.AIconfig.llm.openai.model"
                    :placeholder="zh()?'例如: gpt-4o-mini' : 'Example: gpt-4o-mini'"/>
            </div>
          </div>
          <div class="form-group">
            <label>{{ zh()?'默认嵌入模型' : 'Default Embedding Model' }}</label>
            <div class="input-with-button">
              <select v-if="embedModelModeOf('openai') === 'select'" v-model="store.AIconfig.llm.openai.embed_model">
                <option value="">{{ zh()?'请选择嵌入模型' : 'Select embedding model' }}</option>
                <option v-for="m in embedModelOptions('openai', store.AIconfig.llm.openai.available_models, store.AIconfig.llm.openai.embed_model)" :key="m" :value="m">{{ m }}</option>
              </select>
              <input v-else v-model="store.AIconfig.llm.openai.embed_model"
                    :placeholder="zh()?'例如: text-embedding-3-small' : 'Example: text-embedding-3-small'"/>
              <div class="button" style="width:30px;margin:0px;padding:4px 0px" @click="toggleEmbedModelMode('openai')"
                  :title="embedModelModeOf('openai') === 'select' ? (zh()?'手动输入' : 'Manual input') : (zh()?'下拉选择' : 'Select')">
                <i class="fa" :class="embedModelModeOf('openai') === 'select' ? 'fa-pencil' : 'fa-list'"></i>
              </div>
            </div>
          </div>
          <ModelContextWindow provider="openai" :config="store.AIconfig.llm.openai" :model="store.AIconfig.llm.openai.model" :refresh-token="contextRefreshTick" />
          <!-- API 状态测试（置于配置块最下方） -->
          <LlmTestRow source-key="openai" @refreshed="onSourceRefreshed" />
        </div>

        <!-- DeepSeek 配置（合并来源：Chat Completions ⇄ Responses API 接口样式切换） -->
        <div v-if="isDeepSeekSource" class="llm-config-block">
          <div class="form-group">
            <label>{{ zh()?'接口样式' : 'API Style' }}</label>
            <select v-model="dsStyle"
                  :title="zh() ? 'Chat Completions：经典对话接口（默认）；Responses API：OpenAI Responses 格式（用 reasoning.effort 控制推理强度；联网搜索由本地 web_search 工具承担）' : 'Chat Completions: classic chat API (default); Responses API: OpenAI Responses format (reasoning.effort; web search via the local web_search tool)'">
              <option value="chat">Chat Completions{{ zh() ? '（默认）' : ' (default)' }}</option>
              <option value="responses">Responses API</option>
            </select>
          </div>
          <div class="form-group">
            <label>{{ dsUseCred ? (zh()?'凭据引用' : 'Credential') : (zh()?'API密钥' : 'API Key') }}</label>
            <div class="input-with-button">
              <input v-if="dsUseCred" v-model="dsCfg.apiKeyRef"
                    :placeholder="zh()?'填凭据管理中的名称，优先于 API 密钥' : 'Credential name from Credentials panel; takes precedence'"/>
              <input v-else type="password" v-model="dsCfg.api_key"
                    :placeholder="zh()?'请输入DeepSeek API密钥' : 'Enter DeepSeek API key'"/>
              <div class="button" style="width:30px;margin:0px;padding:4px 0px" @click="dsUseCred = !dsUseCred"
                  :title="dsUseCred ? (zh()?'使用 API 密钥' : 'Use API key') : (zh()?'使用凭据引用' : 'Use credential')">
                <i class="fa" :class="dsUseCred ? 'fa-key' : 'fa-credit-card'"></i>
              </div>
            </div>
          </div>
          <div class="form-group">
            <label>{{ zh()?'API地址' : 'API URL' }}</label>
            <input v-model="dsCfg.base_url" placeholder="https://api.deepseek.com"/>
          </div>
          <div class="form-group">
            <label>{{ zh()?'模型名称' : 'Model Name' }}</label>
            <!-- DeepSeek：可编辑下拉（点底部「API 状态」拉取 /models；select ↔ 手填切换） -->
            <div class="input-with-button">
              <select v-if="showDsSelect" v-model="dsCfg.model" @change="handleDsModelChange">
                <option value="">{{ zh()?'请选择模型' : 'Select model' }}</option>
                <option v-for="m in dsModelOptions" :key="m" :value="m">{{ m }}</option>
              </select>
              <input v-else v-model="dsCfg.model" @change="handleDsModelChange"
                    :placeholder="zh()?'例如: deepseek-flash' : 'Example: deepseek-flash'"/>
              <div class="button" style="width:30px;margin:0px;padding:4px 0px"
                  @click="dsModelMode = dsModelMode === 'select' ? 'input' : 'select'"
                  :title="showDsSelect ? (zh()?'手动输入' : 'Manual input') : (zh()?'下拉选择' : 'Select')">
                <i class="fa" :class="showDsSelect ? 'fa-pencil' : 'fa-list'"></i>
              </div>
            </div>
          </div>
          <div class="form-group">
            <label>{{ zh()?'默认嵌入模型' : 'Default Embedding Model' }}</label>
            <div class="input-with-button">
              <select v-if="embedModelModeOf(dsEmbedKey) === 'select'" v-model="dsCfg.embed_model">
                <option value="">{{ zh()?'请选择嵌入模型' : 'Select embedding model' }}</option>
                <option v-for="m in embedModelOptions(dsEmbedKey, dsCfg.available_models, dsCfg.embed_model)" :key="m" :value="m">{{ m }}</option>
              </select>
              <input v-else v-model="dsCfg.embed_model"
                    :placeholder="zh()?'DeepSeek 无官方嵌入 API，可填兼容网关的嵌入模型' : 'DeepSeek has no official embeddings; fill a gateway-compatible embedding model'"/>
              <div class="button" style="width:30px;margin:0px;padding:4px 0px" @click="toggleEmbedModelMode(dsEmbedKey)"
                  :title="embedModelModeOf(dsEmbedKey) === 'select' ? (zh()?'手动输入' : 'Manual input') : (zh()?'下拉选择' : 'Select')">
                <i class="fa" :class="embedModelModeOf(dsEmbedKey) === 'select' ? 'fa-pencil' : 'fa-list'"></i>
              </div>
            </div>
          </div>
          <!-- 账户余额（GET /user/balance）：余额直接显示在按钮里，查到后按钮即「刷新」 -->
          <div class="form-group">
            <label>{{ zh()?'账户余额' : 'Balance' }}</label>
            <div class="input-with-button">
              <div class="button balance-btn"
                  :class="'status-' + (dsBalance.loading ? 'testing' : (dsBalance.ok ? 'ok' : (dsBalance.text ? 'fail' : 'idle')))"
                  @click="fetchDeepSeekBalance"
                  :title="dsBalance.text ? (zh()?'点击刷新账户余额' : 'Click to refresh the account balance') : (zh()?'查询 DeepSeek 账户余额' : 'Query DeepSeek account balance')">
                <i class="fa" :class="dsBalance.loading ? 'fa-spinner fa-spin' : (dsBalance.text ? 'fa-refresh' : 'fa-money')"></i>
                <span class="balance-btn-text">{{ dsBalance.loading ? (zh()?'查询中...' : 'Loading...') : (dsBalance.text || (zh()?'查询余额' : 'Query balance')) }}</span>
              </div>
            </div>
          </div>
          <!-- 上下文窗口（圆环分母）：DeepSeek 单来源，按“来源+当前模型”分桶 -->
          <ModelContextWindow provider="deepseek"
            :config="dsCfg" :model="dsCfg.model" />
          <!-- API 状态测试（置于配置块最下方；测当前接口样式） -->
          <LlmTestRow source-key="deepseek" @refreshed="onSourceRefreshed" />
        </div>

        <!-- Anthropic配置 -->
        <div v-if="store.AIconfig.llm.type === 'anthropic'" class="llm-config-block">
          <div class="form-group">
            <label>{{ anthropicUseCred ? (zh()?'凭据引用' : 'Credential') : (zh()?'API密钥' : 'API Key') }}</label>
            <div class="input-with-button">
              <input v-if="anthropicUseCred" v-model="store.AIconfig.llm.anthropic.apiKeyRef"
                    :placeholder="zh()?'填凭据管理中的名称，优先于 API 密钥' : 'Credential name from Credentials panel; takes precedence'"/>
              <input v-else type="password" v-model="store.AIconfig.llm.anthropic.api_key"
                    :placeholder="zh()?'请输入Claude API密钥' : 'Enter Claude API key'"/>
              <div class="button" style="width:30px;margin:0px;padding:4px 0px" @click="anthropicUseCred = toggleUseCred(anthropicUseCred)"
                  :title="anthropicUseCred ? (zh()?'使用 API 密钥' : 'Use API key') : (zh()?'使用凭据引用' : 'Use credential')">
                <i class="fa" :class="anthropicUseCred ? 'fa-key' : 'fa-credit-card'"></i>
              </div>
            </div>
          </div>
          <div class="form-group">
            <label>{{ zh()?'模型名称' : 'Model Name' }}</label>
            <input v-model="store.AIconfig.llm.anthropic.model"
                  :placeholder="zh()?'例如: claude-3-haiku-20240307' : 'Example: claude-3-haiku-20240307'"/>
          </div>
          <div class="form-group">
            <label>{{ zh()?'默认嵌入模型' : 'Default Embedding Model' }}</label>
            <div class="input-with-button">
              <select v-if="embedModelModeOf('anthropic') === 'select'" v-model="store.AIconfig.llm.anthropic.embed_model">
                <option value="">{{ zh()?'请选择嵌入模型' : 'Select embedding model' }}</option>
                <option v-for="m in embedModelOptions('anthropic', store.AIconfig.llm.anthropic.available_models, store.AIconfig.llm.anthropic.embed_model)" :key="m" :value="m">{{ m }}</option>
              </select>
              <input v-else v-model="store.AIconfig.llm.anthropic.embed_model"
                    :placeholder="zh()?'Anthropic 无嵌入接口，可留空' : 'Anthropic has no embeddings; leave empty'"/>
              <div class="button" style="width:30px;margin:0px;padding:4px 0px" @click="toggleEmbedModelMode('anthropic')"
                  :title="embedModelModeOf('anthropic') === 'select' ? (zh()?'手动输入' : 'Manual input') : (zh()?'下拉选择' : 'Select')">
                <i class="fa" :class="embedModelModeOf('anthropic') === 'select' ? 'fa-pencil' : 'fa-list'"></i>
              </div>
            </div>
          </div>
          <ModelContextWindow provider="anthropic" :config="store.AIconfig.llm.anthropic" :model="store.AIconfig.llm.anthropic.model" :refresh-token="contextRefreshTick" />
          <!-- API 状态测试（置于配置块最下方） -->
          <LlmTestRow source-key="anthropic" @refreshed="onSourceRefreshed" />
        </div>

        <!-- Google配置 -->
        <div v-if="store.AIconfig.llm.type === 'google'" class="llm-config-block">
          <div class="form-group">
            <label>{{ googleUseCred ? (zh()?'凭据引用' : 'Credential') : (zh()?'API密钥' : 'API Key') }}</label>
            <div class="input-with-button">
              <input v-if="googleUseCred" v-model="store.AIconfig.llm.google.apiKeyRef"
                    :placeholder="zh()?'填凭据管理中的名称，优先于 API 密钥' : 'Credential name from Credentials panel; takes precedence'"/>
              <input v-else type="password" v-model="store.AIconfig.llm.google.api_key"
                    :placeholder="zh()?'请输入Google AI密钥' : 'Enter Google AI key'"/>
              <div class="button" style="width:30px;margin:0px;padding:4px 0px" @click="googleUseCred = toggleUseCred(googleUseCred)"
                  :title="googleUseCred ? (zh()?'使用 API 密钥' : 'Use API key') : (zh()?'使用凭据引用' : 'Use credential')">
                <i class="fa" :class="googleUseCred ? 'fa-key' : 'fa-credit-card'"></i>
              </div>
            </div>
          </div>
          <div class="form-group">
            <label>{{ zh()?'模型名称' : 'Model Name' }}</label>
            <input v-model="store.AIconfig.llm.google.model"
                  :placeholder="zh()?'例如: gemini-pro' : 'Example: gemini-pro'"/>
          </div>
          <div class="form-group">
            <label>{{ zh()?'默认嵌入模型' : 'Default Embedding Model' }}</label>
            <div class="input-with-button">
              <select v-if="embedModelModeOf('google') === 'select'" v-model="store.AIconfig.llm.google.embed_model">
                <option value="">{{ zh()?'请选择嵌入模型' : 'Select embedding model' }}</option>
                <option v-for="m in embedModelOptions('google', store.AIconfig.llm.google.available_models, store.AIconfig.llm.google.embed_model)" :key="m" :value="m">{{ m }}</option>
              </select>
              <input v-else v-model="store.AIconfig.llm.google.embed_model"
                    :placeholder="zh()?'例如: text-embedding-004' : 'Example: text-embedding-004'"/>
              <div class="button" style="width:30px;margin:0px;padding:4px 0px" @click="toggleEmbedModelMode('google')"
                  :title="embedModelModeOf('google') === 'select' ? (zh()?'手动输入' : 'Manual input') : (zh()?'下拉选择' : 'Select')">
                <i class="fa" :class="embedModelModeOf('google') === 'select' ? 'fa-pencil' : 'fa-list'"></i>
              </div>
            </div>
          </div>
          <ModelContextWindow provider="google" :config="store.AIconfig.llm.google" :model="store.AIconfig.llm.google.model" :refresh-token="contextRefreshTick" />
          <!-- API 状态测试（置于配置块最下方） -->
          <LlmTestRow source-key="google" @refreshed="onSourceRefreshed" />
        </div>

        <!-- Azure配置 -->
        <div v-if="store.AIconfig.llm.type === 'azure'" class="llm-config-block">
          <div class="form-group">
            <label>{{ azureUseCred ? (zh()?'凭据引用' : 'Credential') : (zh()?'API密钥' : 'API Key') }}</label>
            <div class="input-with-button">
              <input v-if="azureUseCred" v-model="store.AIconfig.llm.azure.apiKeyRef"
                    :placeholder="zh()?'填凭据管理中的名称，优先于 API 密钥' : 'Credential name from Credentials panel; takes precedence'"/>
              <input v-else type="password" v-model="store.AIconfig.llm.azure.api_key"
                    :placeholder="zh()?'请输入Azure API密钥' : 'Enter Azure API key'"/>
              <div class="button" style="width:30px;margin:0px;padding:4px 0px" @click="azureUseCred = toggleUseCred(azureUseCred)"
                  :title="azureUseCred ? (zh()?'使用 API 密钥' : 'Use API key') : (zh()?'使用凭据引用' : 'Use credential')">
                <i class="fa" :class="azureUseCred ? 'fa-key' : 'fa-credit-card'"></i>
              </div>
            </div>
          </div>
          <div class="form-group">
            <label>{{ zh()?'端点地址' : 'Endpoint' }}</label>
            <input v-model="store.AIconfig.llm.azure.endpoint"
                  :placeholder="zh()?'例如: https://your-resource.openai.azure.com' : 'Example: https://your-resource.openai.azure.com'"/>
          </div>
          <div class="form-group">
            <label>{{ zh()?'部署名称' : 'Deployment' }}</label>
            <input v-model="store.AIconfig.llm.azure.deployment"
                  :placeholder="zh()?'部署名称' : 'Deployment name'"/>
          </div>
          <div class="form-group">
            <label>{{ zh()?'API版本' : 'API Version' }}</label>
            <input v-model="store.AIconfig.llm.azure.api_version"
                  :placeholder="zh()?'例如: 2024-02-15-preview' : 'Example: 2024-02-15-preview'"/>
          </div>
          <div class="form-group">
            <label>{{ zh()?'默认嵌入部署' : 'Default Embedding Deployment' }}</label>
            <div class="input-with-button">
              <select v-if="embedModelModeOf('azure') === 'select'" v-model="store.AIconfig.llm.azure.embed_model">
                <option value="">{{ zh()?'请选择嵌入部署' : 'Select embedding deployment' }}</option>
                <option v-for="m in embedModelOptions('azure', store.AIconfig.llm.azure.available_models, store.AIconfig.llm.azure.embed_model)" :key="m" :value="m">{{ m }}</option>
              </select>
              <input v-else v-model="store.AIconfig.llm.azure.embed_model"
                    :placeholder="zh()?'Azure 嵌入模型部署名' : 'Azure embedding deployment name'"/>
              <div class="button" style="width:30px;margin:0px;padding:4px 0px" @click="toggleEmbedModelMode('azure')"
                  :title="embedModelModeOf('azure') === 'select' ? (zh()?'手动输入' : 'Manual input') : (zh()?'下拉选择' : 'Select')">
                <i class="fa" :class="embedModelModeOf('azure') === 'select' ? 'fa-pencil' : 'fa-list'"></i>
              </div>
            </div>
          </div>
          <!-- 上下文窗口：Azure 以「部署名称」为模型标识 -->
          <ModelContextWindow provider="azure" :config="store.AIconfig.llm.azure" :model="store.AIconfig.llm.azure.deployment" :refresh-token="contextRefreshTick" />
          <!-- API 状态测试（置于配置块最下方） -->
          <LlmTestRow source-key="azure" @refreshed="onSourceRefreshed" />
        </div>

        <!-- GPUStack配置（内置自托管来源） -->
        <div v-if="store.AIconfig.llm.type === 'gpustack'" class="llm-config-block">
          <div class="form-group">
            <label>{{ zh()?'服务地址' : 'Server URL' }}</label>
            <input v-model="store.AIconfig.llm.gpustack.base_url"
                  :placeholder="zh()?'例如: http://localhost（裸地址自动补 /v1-openai）' : 'Example: http://localhost (bare host auto-appends /v1-openai)'"
                  @change="refreshGPUStackModels"/>
          </div>
          <div class="form-group">
            <label>{{ gpustackUseCred ? (zh()?'凭据引用' : 'Credential') : (zh()?'API密钥(可选)' : 'API Key (Optional)') }}</label>
            <div class="input-with-button">
              <input v-if="gpustackUseCred" v-model="store.AIconfig.llm.gpustack.apiKeyRef"
                    :placeholder="zh()?'填凭据管理中的名称，优先于 API 密钥' : 'Credential name from Credentials panel; takes precedence'"/>
              <input v-else type="password" v-model="store.AIconfig.llm.gpustack.api_key"
                    :placeholder="zh()?'GPUStack 本地部署可不填' : 'Optional for local GPUStack deployment'"/>
              <div class="button" style="width:30px;margin:0px;padding:4px 0px" @click="gpustackUseCred = toggleUseCred(gpustackUseCred)"
                  :title="gpustackUseCred ? (zh()?'使用 API 密钥' : 'Use API key') : (zh()?'使用凭据引用' : 'Use credential')">
                <i class="fa" :class="gpustackUseCred ? 'fa-key' : 'fa-credit-card'"></i>
              </div>
            </div>
          </div>
          <div class="form-group">
            <label>{{ zh()?'模型名称' : 'Model Name' }}</label>
            <div class="input-with-button">
              <select v-if="showGPUStackSelect" v-model="store.AIconfig.llm.gpustack.model" @change="handleGPUStackModelChange">
                <option value="">{{ zh()?'请选择模型' : 'Select model' }}</option>
                <option v-for="m in gpuStackModelOptions" :key="m" :value="m">{{ m }}</option>
              </select>
              <input v-else v-model="store.AIconfig.llm.gpustack.model" @change="handleGPUStackModelChange"
                    :placeholder="zh()?'模型标识符（可手填）' : 'Model identifier (or type manually)'"/>
              <div class="button" style="width:30px;margin:0px;padding:4px 0px"
                  @click="gpustackModelMode = gpustackModelMode === 'select' ? 'input' : 'select'"
                  :title="showGPUStackSelect ? (zh()?'手动输入' : 'Manual input') : (zh()?'下拉选择' : 'Select')">
                <i class="fa" :class="showGPUStackSelect ? 'fa-pencil' : 'fa-list'"></i>
              </div>
            </div>
          </div>
          <div class="form-group">
            <label>{{ zh()?'默认嵌入模型' : 'Default Embedding Model' }}</label>
            <div class="input-with-button">
              <select v-if="embedModelModeOf('gpustack') === 'select'" v-model="store.AIconfig.llm.gpustack.embed_model">
                <option value="">{{ zh()?'请选择嵌入模型' : 'Select embedding model' }}</option>
                <option v-for="m in embedModelOptions('gpustack', store.AIconfig.llm.gpustack.available_models, store.AIconfig.llm.gpustack.embed_model)" :key="m" :value="m">{{ m }}</option>
              </select>
              <input v-else v-model="store.AIconfig.llm.gpustack.embed_model"
                    :placeholder="zh()?'GPUStack 部署了嵌入模型时填写' : 'Fill if an embedding model is deployed on GPUStack'"/>
              <div class="button" style="width:30px;margin:0px;padding:4px 0px" @click="toggleEmbedModelMode('gpustack')"
                  :title="embedModelModeOf('gpustack') === 'select' ? (zh()?'手动输入' : 'Manual input') : (zh()?'下拉选择' : 'Select')">
                <i class="fa" :class="embedModelModeOf('gpustack') === 'select' ? 'fa-pencil' : 'fa-list'"></i>
              </div>
            </div>
          </div>
          <ModelContextWindow provider="gpustack" :config="store.AIconfig.llm.gpustack" :model="store.AIconfig.llm.gpustack.model" :refresh-token="contextRefreshTick" />
          <!-- API 状态测试（置于配置块最下方） -->
          <LlmTestRow source-key="gpustack" @refreshed="onSourceRefreshed" />
        </div>

        <!-- 自定义配置 -->
        <div v-if="store.AIconfig.llm.type === 'custom'" class="llm-config-block">
          <div class="form-group">
            <label>{{ zh()?'来源名称' : 'Source Name' }}</label>
            <input v-model="store.AIconfig.llm.custom.name"
                  :placeholder="customDefaultName()"
                  @input="syncCustomSource(false)" @change="syncCustomSource()"/>
          </div>
          <div class="form-group">
            <label>{{ zh()?'API地址' : 'API URL' }}</label>
            <input v-model="store.AIconfig.llm.custom.api_url"
                  :placeholder="zh()?'完整的API端点地址' : 'Full API endpoint URL'"
                  @input="syncCustomSource(false)" @change="syncCustomSource()"/>
          </div>
          <div class="form-group">
            <label>{{ customUseCred ? (zh()?'凭据引用' : 'Credential') : (zh()?'API密钥' : 'API Key') }}</label>
            <div class="input-with-button">
              <input v-if="customUseCred" v-model="store.AIconfig.llm.custom.apiKeyRef"
                    :placeholder="zh()?'填凭据管理中的名称，优先于 API 密钥' : 'Credential name from Credentials panel; takes precedence'"
                    @input="syncCustomSource(false)" @change="syncCustomSource()"/>
              <input v-else type="password" v-model="store.AIconfig.llm.custom.api_key"
                    :placeholder="zh()?'可选的API密钥' : 'Optional API key'"
                    @input="syncCustomSource(false)" @change="syncCustomSource()"/>
              <div class="button" style="width:30px;margin:0px;padding:4px 0px" @click="customUseCred = toggleUseCred(customUseCred)"
                  :title="customUseCred ? (zh()?'使用 API 密钥' : 'Use API key') : (zh()?'使用凭据引用' : 'Use credential')">
                <i class="fa" :class="customUseCred ? 'fa-key' : 'fa-credit-card'"></i>
              </div>
            </div>
          </div>
          <div class="form-group">
            <label>{{ zh()?'模型名称' : 'Model Name' }}</label>
            <!-- 自定义：点底部「连接测试」从 api_url 推导 /models 拉取下拉；拉不到列表时兜底为手填输入框 -->
            <div class="input-with-button">
              <select v-if="showCustomSelect" v-model="store.AIconfig.llm.custom.model" @change="handleCustomModelChange">
                <option value="">{{ zh()?'请选择模型' : 'Select model' }}</option>
                <option v-for="m in customModelOptions" :key="m" :value="m">{{ m }}</option>
              </select>
              <input v-else v-model="store.AIconfig.llm.custom.model"
                    :placeholder="zh()?'模型标识符（可手填）' : 'Model identifier (or type manually)'"
                    @input="syncCustomSource(false)" @change="syncCustomSource()"/>
              <div class="button" style="width:30px;margin:0px;padding:4px 0px"
                  @click="toggleCustomModelMode"
                  :title="customModelMode === 'select' ? (zh()?'手动输入' : 'Manual input') : (zh()?'下拉选择' : 'Select')">
                <i class="fa" :class="customModelMode === 'select' ? 'fa-pencil' : 'fa-list'"></i>
              </div>
            </div>
          </div>
          <div class="form-group">
            <label>{{ zh()?'默认嵌入模型' : 'Default Embedding Model' }}</label>
            <div class="input-with-button">
              <select v-if="embedModelModeOf('custom') === 'select'" v-model="store.AIconfig.llm.custom.embed_model" @change="syncCustomSource()">
                <option value="">{{ zh()?'请选择嵌入模型' : 'Select embedding model' }}</option>
                <option v-for="m in embedModelOptions('custom', store.AIconfig.llm.custom.available_models, store.AIconfig.llm.custom.embed_model)" :key="m" :value="m">{{ m }}</option>
              </select>
              <input v-else v-model="store.AIconfig.llm.custom.embed_model"
                    :placeholder="zh()?'自定义端点支持嵌入时填模型名' : 'Embedding model if this endpoint supports it'"
                    @input="syncCustomSource(false)" @change="syncCustomSource()"/>
              <div class="button" style="width:30px;margin:0px;padding:4px 0px" @click="toggleEmbedModelMode('custom')"
                  :title="embedModelModeOf('custom') === 'select' ? (zh()?'手动输入' : 'Manual input') : (zh()?'下拉选择' : 'Select')">
                <i class="fa" :class="embedModelModeOf('custom') === 'select' ? 'fa-pencil' : 'fa-list'"></i>
              </div>
            </div>
          </div>
          <!-- 上下文窗口（圆环分母）：自定义来源按「激活来源」分别计 -->
          <ModelContextWindow provider="custom" :config="store.AIconfig.llm.custom" :model="store.AIconfig.llm.custom.model" :refresh-token="contextRefreshTick" />
          <!-- 自定义来源：连接测试（置于配置块最下方） -->
          <div class="form-group">
            <label>{{ zh()?'连接测试' : 'Connection Test' }}</label>
            <div class="input-with-button">
              <div class="button test-custom-btn" :class="'status-' + customTestStatus"
                  @click="onCustomTestClick"
                  :title="zh()?'测试当前自定义来源的连通性，并刷新模型列表与上下文窗口' : 'Test this custom source and refresh the model list and context window'">
                <i class="fa" :class="customTestStatus === 'testing' ? 'fa-spinner fa-spin' : 'fa-plug'"></i>
                <span>{{ customTestStatus === 'testing' ? (zh()?'测试中...' : 'Testing...') : (zh()?'测试连接' : 'Test') }}</span>
              </div>
              <span v-if="customTestMsg" class="test-custom-msg" :class="'status-' + customTestStatus">{{ customTestMsg }}</span>
            </div>
          </div>
        </div>

        <!-- 通用参数配置 -->
        <div class="llm-config-block">
          <div class="form-group">
            <label>{{ zh()?'温度' : 'Temperature' }}<span class="temp-value">{{ store.AIconfig.llm.temperature }}</span></label>
            <div class="input-with-slider">
              <input type="range" v-model="store.AIconfig.llm.temperature" min="0" max="2" step="0.1" />
            </div>
          </div>
          <div class="form-group">
            <label>{{ zh()?'最大令牌数' : 'Max Tokens' }}</label>
            <input type="number" v-model="store.AIconfig.llm.max_tokens" min="100" max="30000" />
          </div>
          <div class="form-group">
            <label>{{ zh()?'流式响应' : 'Stream Response' }}</label>
            <input type="checkbox" v-model="store.AIconfig.llm.stream"
                  :title="zh()?'启用流式响应' : 'Enable stream response'"/>
          </div>
          <div class="form-group">
            <label>{{ zh()?'推理强度' : 'Reasoning Effort' }}</label>
            <select v-model="store.AIconfig.llm.think" @change="store.saveConfig()"
                  :title="zh() ? '关闭：直接作答；低/中/高/最高：先深度思考再作答（更耗 token）。仅支持推理强度的后端生效：DeepSeek（chat/Responses，档位 none/low/high/max）、Ollama（low/medium/high）、LM Studio（reasoning_effort）、其它 OpenAI 兼容后端（enable_thinking）' : 'Off: answer directly; Low/Medium/High/Max: reason first (more tokens). Applies to reasoning-capable backends: DeepSeek chat/Responses (none/low/high/max), Ollama (low/medium/high), LM Studio (reasoning_effort), other OpenAI-compatible backends (enable_thinking)'">
              <option value="none">{{ zh()?'关闭' : 'Off' }}</option>
              <option value="low">{{ zh()?'低' : 'Low' }}</option>
              <option value="medium">{{ zh()?'中' : 'Medium' }}</option>
              <option value="high">{{ zh()?'高' : 'High' }}</option>
              <option value="max">{{ zh()?'最高' : 'Max' }}</option>
            </select>
          </div>
          <div class="form-group">
            <label>{{ zh()?'远端自托管并发' : 'Remote Max Inflight' }}</label>
            <input type="number" v-model.number="store.AIconfig.llm.remoteMaxInflight" min="1" max="500"
                  @change="store.saveConfig()"
                  :title="zh() ? '远端自托管后端（内网/公网 LM Studio / Ollama / custom 端点）同一后端同时在途流式请求上限；本机 localhost 与云端官方 API 不受此限。默认 2，用于防远端单机推理服务并发空回/500；批量/集群等编排运行时会自动跟随自身设置的并发数，无需手工保持一致' : 'Max concurrent in-flight streaming requests per remote self-hosted backend (LM Studio / Ollama / custom, non-localhost). Localhost and cloud APIs are not limited. Default 2 prevents empty-stream/500 on remote single-machine inference servers; batch/swarm runs auto-follow their own configured concurrency'" />
          </div>
        </div>

        <!-- 嵌入兜底：当前来源不提供嵌入接口（DeepSeek / Anthropic 等）时，向量化改用所选来源 -->
        <div class="llm-config-block" v-if="store.AIconfig.llm.embeddingFallback">
          <div class="form-group">
            <label>{{ zh()?'嵌入兜底' : 'Embedding Fallback' }}</label>
            <select v-model="embedFallbackKey"
                  :title="zh() ? '当前模型来源不提供嵌入接口（如 DeepSeek / Anthropic）时，知识库建库与检索的向量化改用这里选的来源（自定义来源逐个列出）' : 'When the current source has no embedding endpoint (e.g. DeepSeek / Anthropic), KB building and retrieval embedding falls back to the source chosen here (custom sources listed individually)'">
              <option value="">{{ zh()?'关闭（不兜底）' : 'Off (no fallback)' }}</option>
              <option v-for="s in embedFallbackSources" :key="s.key" :value="s.key">{{ zh()? s.labelZh : s.labelEn }}</option>
            </select>
          </div>
          <div class="form-group" v-if="store.AIconfig.llm.embeddingFallback.llmType">
            <label>{{ zh()?'兜底嵌入模型' : 'Fallback Model' }}</label>
            <div class="input-with-button">
              <select v-model="store.AIconfig.llm.embeddingFallback.model" @change="store.saveConfig()"
                    :title="zh()?'该来源已拉取到的模型列表；留空则用该来源的默认嵌入模型' : 'Models fetched from that source; empty = use that source default'">
                <option value="">{{ zh()?'用该来源的默认嵌入模型' : "Use that source's default" }}</option>
                <option v-for="m in embedFallbackModelOptions" :key="m" :value="m">{{ m }}</option>
              </select>
              <div class="button" style="width:30px;margin:0px;padding:4px 0px" @click="refreshEmbedFallbackModels()"
                  :title="zh()?'刷新该来源的模型列表' : 'Refresh that source model list'">
                <i class="fa" :class="embedFallbackLoading ? 'fa-spinner fa-spin' : 'fa-refresh'"></i>
              </div>
            </div>
          </div>
          <!-- 提示：连接配置沿用该来源 + 模型留空时的实际取值。整行说明，不占 label 列、不显示冒号 -->
          <div class="config-description embed-fallback-hint" v-if="store.AIconfig.llm.embeddingFallback.llmType">
            {{ embedFallbackHint }}
          </div>
          <div class="config-description embed-fallback-hint" v-if="embedFallbackEmbedHint">
            {{ embedFallbackEmbedHint }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.llm-settings {
  display: flex; height: 100%; flex: 1; overflow: hidden;
  background: var(--backgroundColor); color: var(--fontColor);
}
/* ====== 左侧：来源列表（参照 AgentPreset .contact-sidebar） ====== */
.llm-sidebar {
  width: 190px; display: flex; flex-direction: column;
  border-right: 1px solid var(--borderColor); background: var(--menuColor);
  flex-shrink: 0;
}
.llm-toolbar {
  display: flex; align-items: center; gap: 5px;
  flex-shrink: 0; padding: 5px;
  border-bottom: 1px solid var(--borderColor); background: var(--menuColor);
}
.llm-toolbar .notes-search-box {
  flex: 1; min-width: 0; height: 26px;
  display: flex; align-items: center; gap: 6px;
  padding: 0 6px;
  border: 1px solid var(--borderColor); border-radius: 4px;
  background-color: var(--backgroundColor);
  color: var(--borderColor); font-size: 12px;
}
.llm-toolbar .notes-search-box > i { flex-shrink: 0; font-size: 12px; }
.llm-toolbar .notes-search-input {
  flex: 1; min-width: 0; border: none; outline: none; background: transparent;
  color: var(--fontColor); font-size: 12px; margin: 0;
}
.llm-toolbar .notes-search-clear { flex-shrink: 0; cursor: pointer; font-size: 12px; color: var(--borderColor); }
.llm-toolbar .notes-search-clear:hover { color: var(--fontActiveColor); }

/* 添加自定义来源按钮（样式参照 Todo.vue 的 .toolbar-action-btn） */
.llm-toolbar .toolbar-action-btn {
  flex-shrink: 0;
  width: 26px; height: 26px;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  cursor: pointer;
  color: var(--fontColor);
  background-color: var(--backgroundColor);
  font-size: 12px;
  padding: 0;
  transition: all 0.15s ease;
}
.llm-toolbar .toolbar-action-btn:hover {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}
.llm-toolbar .toolbar-action-btn.active {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
  border-color: var(--fontActiveColor);
}

/* 自定义来源分组标题 */
.llm-source-group-title {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 6px 3px;
  font-size: 10px; font-weight: 600; color: var(--fontColor); opacity: .65;
  text-transform: uppercase; letter-spacing: .4px;
}
.llm-source-group-count {
  background: color-mix(in srgb, var(--fontColor) 10%, transparent);
  border-radius: 8px; padding: 0 6px; font-size: 10px; line-height: 14px;
}
.llm-source-item.custom { padding-right: 3px; }
/* 行内重命名输入框 */
.llm-source-rename-input {
  width: 100%; min-width: 0; height: 18px;
  border: 1px solid var(--fontActiveColor); border-radius: 3px;
  background: var(--backgroundColor); color: var(--fontColor);
  font-size: 12px; padding: 0 3px; margin: 0; outline: none;
}
/* 悬停显示的 操作按钮（重命名/删除） */
.llm-source-actions {
  display: flex; align-items: center; gap: 2px;
  flex-shrink: 0; opacity: 0; transition: opacity .12s;
}
.llm-source-item.custom:hover .llm-source-actions { opacity: 1; }
.llm-source-item.custom.active .llm-source-actions { opacity: 1; }
.llm-source-actions i {
  width: 16px; height: 16px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 3px; font-size: 10px; cursor: pointer; color: var(--fontColor); opacity: .75;
  transition: all .12s;
}
.llm-source-actions i:hover { background: color-mix(in srgb, var(--fontActiveColor) 15%, transparent); color: var(--fontActiveColor); opacity: 1; }
.llm-source-actions i.fa-trash-o:hover { background: #fde8e8; color: #e74c3c; }

.llm-source-list { flex: 1; overflow-y: auto; padding: 2px; background-color: var(--backgroundColor); }
.llm-source-item {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 6px; margin-bottom: 1px; border-radius: 3px;
  cursor: pointer; transition: all .12s; border: 1px solid transparent;
}
.llm-source-item:hover { background: color-mix(in srgb, var(--fontColor) 6%, transparent); }
.llm-source-item.active { background: color-mix(in srgb, var(--fontActiveColor) 12%, transparent); border-color: var(--fontActiveColor); }
.llm-source-avatar {
  width: 26px; height: 26px; display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent); border-radius: 50%; flex-shrink: 0;
}
.llm-source-avatar i { font-size: 13px; color: var(--fontActiveColor); }
.llm-source-info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.llm-source-name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.llm-source-desc { font-size: 10px; color: var(--fontColor); opacity: .7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.llm-source-status { flex-shrink: 0; font-size: 10px; color: var(--borderColor); }
.llm-source-status.online { color: #4CAF50; }
.llm-source-status.offline { color: #f44336; }
.llm-source-status.untested { color: var(--borderColor); }

/* 来源启停开关 */
.llm-source-toggle {
  flex-shrink: 0; display: flex; align-items: center; justify-content: center;
  width: 18px; height: 18px; font-size: 14px; cursor: pointer;
  color: var(--fontActiveColor); opacity: .85; transition: all .12s;
}
.llm-source-toggle:hover { opacity: 1; transform: scale(1.12); }
.llm-source-toggle .fa-toggle-off { color: var(--borderColor); }
/* 禁用的来源：置灰 + 名称删除线 */
.llm-source-item.disabled { opacity: .45; }
.llm-source-item.disabled .llm-source-name { text-decoration: line-through; }

/* ====== 右侧：配置区 ====== */
.llm-content { flex: 1; min-width: 0; overflow-y: auto; padding: 8px; }
.llm-content .settings-group { display: flex; flex-direction: column; gap: 8px; }
.llm-content-header { border-bottom: 1px solid var(--borderColor); padding-bottom: 5px }
.llm-content-header h3 {
  position: relative; color: var(--fontActiveColor); margin: 0;
  padding: 0 0 4px 10px; font-size: 14px; font-weight: 600;
}
.llm-content-header h3::before {
  content: ''; position: absolute; left: 0; top: 2px; bottom: 6px;
  width: 3px; background: var(--fontActiveColor); border-radius: 2px;
}
.llm-config-block {
  border: 1px solid var(--borderColor); border-radius: 4px;
  padding: 6px; display: flex; flex-direction: column; gap: 6px;
}

/* ====== 表单单行布局：label + 控件同行，窗口很窄时才转为双行 ====== */
.llm-content .form-group {
  display: flex; align-items: center; gap: 8px;
  flex-wrap: nowrap; white-space: nowrap;
  margin-bottom: 0;
}
/* 统一清零 form-group 内元素的 margin（防止全局样式污染导致行高超出） */
.llm-content .form-group > * {
  margin: 0;
}
.llm-content .form-group > label {
  flex-shrink: 0; width: auto; min-width: 95px;
  text-align: right; font-size: 12px;
  line-height: 1;
}
.llm-content .form-group > label::after { content: '：'; }
.llm-content .form-group > input,
.llm-content .form-group > select,
.llm-content .form-group > textarea,
.llm-content .form-group > .input-with-button,
.llm-content .form-group > .checkbox-group,
.llm-content .form-group > .input-with-slider {
  flex: 1; min-width: 0;
}
/* input-with-button 内部：输入框占满剩余空间，按钮不溢出、与控件等高 */
.llm-content .input-with-button { display: flex; align-items: stretch; gap: 4px; min-width: 0; margin: 0; }
.llm-content .input-with-button > input,
.llm-content .input-with-button > select {
  flex: 1; min-width: 0; margin: 0;
}
.llm-content .input-with-button > .button {
  flex-shrink: 0;
  height: auto; align-self: stretch;  /* 与输入框/下拉等高 */
  display: inline-flex; align-items: center; justify-content: center;
  min-height: 0; padding: 0 6px; margin: 0;
}
/* 自定义来源：连接测试按钮 + 状态文案（按钮高度与输入框/其它图标按钮一致：27px） */
.llm-content .input-with-button > .test-custom-btn {
  flex-shrink: 0; width: auto;
  height: 27px; padding: 0 10px; font-size: 12px; white-space: nowrap; width: calc(100% - 22px)
}
.llm-content .test-custom-btn.status-testing { color: var(--fontActiveColor); }
.llm-content .test-custom-msg {
  align-self: center; min-width: 0; font-size: 12px; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}
.llm-content .test-custom-msg.status-ok { color: #4CAF50; }
.llm-content .test-custom-msg.status-fail { color: #f44336; }
.llm-content .test-custom-msg.status-testing { color: var(--fontActiveColor); }
/* DeepSeek 账户余额：余额直接显示在按钮内（查到后按钮即刷新按钮），超长省略 */
.llm-content .input-with-button > .balance-btn {
  flex: 1; min-width: 0; width: auto; height: 27px; padding: 0 10px;
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  font-size: 12px; white-space: nowrap; overflow: hidden;
}
.llm-content .balance-btn-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.llm-content .balance-btn.status-testing { color: var(--fontActiveColor); }
.llm-content .balance-btn.status-ok { color: #4CAF50; }
.llm-content .balance-btn.status-fail { color: #f44336; }
/* 温度数值：并入标签行内显示 */
.llm-content .temp-value {
  margin-left: 6px; font-size: 12px; color: var(--fontActiveColor);
  font-weight: 600;
}
.llm-content .form-group .config-description {
  width: 100%; margin: 0; font-size: 10px;
}
/* 嵌入兜底提示：整行说明（不占 label 列，因此不会出现单独的冒号），允许换行 */
.llm-content .embed-fallback-hint {
  font-size: 10px; opacity: .8; line-height: 1.5;
  margin: -2px 0 0 0; white-space: normal;
}
/* LM Studio 模型加载状态：已加载 / 未加载一览（字体与其它说明行一致） */
.llm-content .lm-models-box {
  flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px;
  border: 1px solid var(--borderColor, #8884); border-radius: 4px; padding: 4px 6px;
}
.llm-content .lm-models-head { display: flex; align-items: center; gap: 6px; font-size: 11px; min-width: 0; }
.llm-content .lm-models-summary { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.llm-content .lm-status-dot { width: 8px; height: 8px; border-radius: 50%; background: #888; flex-shrink: 0; }
.llm-content .lm-status-dot.ok { background: #4CAF50; }
.llm-content .lm-status-dot.warn { background: #ff9800; }
.llm-content .lm-status-dot.off { background: #f44336; }
/* 模型清单：grid 逐列对齐（图标 / 名称 / 类型 / 设置 / 上限 / 状态 / 操作）
   不限高度（有多少模型就多高，不出现滑块）；行用 display:contents 直接参与同一网格，
   因此各列在所有行之间严格对齐。缺失的单元格留空占位，避免列错位。 */
.llm-content .lm-models-list {
  display: grid;
  grid-template-columns: 13px minmax(0, 1fr) max-content max-content max-content max-content 22px;
  column-gap: 8px;
  row-gap: 3px;
  align-items: center;
}
.llm-content .lm-model-row { display: contents; }
.llm-content .lm-row-icon { font-size: 11px; color: #888; justify-self: center; }
.llm-content .lm-row-icon.is-loaded { color: #4CAF50; }
.llm-content .lm-model-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.llm-content .lm-model-tag {
  justify-self: start; font-size: 10px; padding: 0 4px; border-radius: 3px;
  background: rgba(128, 128, 128, .22);
}
.llm-content .lm-model-state { font-size: 10px; opacity: .8; white-space: nowrap; }
.llm-content .lm-model-ctx { font-size: 10px; opacity: .7; white-space: nowrap; }
.llm-content .lm-model-ctx-set { font-size: 10px; color: #4CAF50; white-space: nowrap; }
.llm-content .lm-model-name.dim,
.llm-content .lm-model-tag.dim { opacity: .6; }
.llm-content .lm-ctx-line { font-size: 10px; opacity: .85; white-space: normal; line-height: 1.5; }
.llm-content .lm-embed-hint { font-size: 10px; opacity: .85; white-space: normal; line-height: 1.5; }
/* 每行的加载（⬇）/ 卸载（⏏）按钮：紧凑方按钮，与行内文字同高 */
.llm-content .lm-row-btn {
  width: 22px; height: 18px; min-height: 0; padding: 0; justify-self: center;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 10px; line-height: 1; margin: 0;
}
.llm-content .lm-row-btn.busy { opacity: .7; cursor: default; }
/* 加载时的上下文长度（可选）：占满整行，输入框自适应 */
.llm-content .lm-load-ctx { display: flex; align-items: center; gap: 6px; font-size: 10px; }
.llm-content .lm-load-ctx-label { flex-shrink: 0; opacity: .8; }
.llm-content .lm-load-ctx-input { flex: 1; min-width: 0; height: 20px; padding: 0 6px; font-size: 10px; margin: 0; }
.llm-content .lm-load-ctx-unit { flex-shrink: 0; opacity: .6; }
.checkbox-label{
  padding: 0px
}
/* 窗口很窄（< 620px）时退化为双行：label 在上，控件在下 */
@media (max-width: 620px) {
  .llm-content .form-group {
    flex-wrap: wrap;
  }
  .llm-content .form-group > label {
    width: 100%; min-width: 0; text-align: left;
  }
  .llm-content .form-group > label::after { content: ''; }
  .llm-content .form-group > input,
  .llm-content .form-group > select,
  .llm-content .form-group > .input-with-button,
  .llm-content .form-group > .checkbox-group,
  .llm-content .form-group > .input-with-slider {
    width: 100%; flex-basis: 100%;
  }
}
</style>
