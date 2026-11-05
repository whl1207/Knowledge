<!-- OnboardingWizard.vue — 首次使用引导（参照 DSH 的 onboarding：版本化步骤 / 条件跳过 / 进度可恢复）
 * 只做主流程编排，不复制已有的配置表单：
 * - 语言 / 主题：直接改 store（与设置页同一套字段）；
 * - 工作区：调 store.addRoot（与 设置 → 通用 → 基础 同一套逻辑）；
 * - 模型：只显示状态 + 测试连接，配置本身交给已有的「设置 → 模型 → 来源」编辑器（点按钮打开）。
 * 步骤按条件出现（已有工作区就不问工作区、已配模型就不问模型），显式重看时全部出现。 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { usestore, THEMES } from '@/store'
import { getPlatform, hasCapability } from '@/platform'
// 「去哪儿下载 / 去哪儿申请 Key」的唯一资料表（设置 → 模型 → 来源 用的是同一份）
import { llmSourceDoc, ONBOARDING_SOURCE_IDS, normalizeLlmSourceId } from '@/shared/llmSourceDocs'
import { llmSourceCategory, LLM_SOURCE_CATEGORY_LABELS } from '@/shared/llmSources'
import { openExternalUrl } from '@/lib/openExternal'

const props = withDefaults(defineProps<{
  /** 从第几步开始（恢复上次进度） */
  startStep?: number
  /** 显式重看：即使已经配过工作区 / 模型也把这两步列出来 */
  force?: boolean
}>(), { startStep: 0, force: false })

const emit = defineEmits<{
  (e: 'step', step: number): void
  (e: 'done', kind: 'finished' | 'skipped'): void
  /** 暂时收起引导；resume=true 表示等设置关闭后自动回来（进度保留） */
  (e: 'suspend', opts?: { resume?: boolean }): void
}>()

const store = usestore()
const zh = computed(() => store.locales === 'zh')
const t = (cn: string, en: string) => (zh.value ? cn : en)

// ================ 模型来源状态（只读投影，配置在设置页里改） ================
const SOURCE_LABELS: Record<string, { cn: string; en: string }> = {
  ollama: { cn: 'Ollama（本地）', en: 'Ollama (local)' },
  lmstudio: { cn: 'LM Studio（本地）', en: 'LM Studio (local)' },
  openai: { cn: 'OpenAI', en: 'OpenAI' },
  deepseek: { cn: 'DeepSeek', en: 'DeepSeek' },
  glm: { cn: 'GLM（智谱）', en: 'GLM (Zhipu)' },
  kimi: { cn: 'Kimi（Moonshot）', en: 'Kimi (Moonshot)' },
  mimo: { cn: 'MiMo（小米）', en: 'MiMo (Xiaomi)' },
  gpustack: { cn: 'GPUStack', en: 'GPUStack' },
  anthropic: { cn: 'Anthropic Claude', en: 'Anthropic Claude' },
  google: { cn: 'Google Gemini', en: 'Google Gemini' },
  azure: { cn: 'Azure OpenAI', en: 'Azure OpenAI' },
  custom: { cn: '自定义来源', en: 'Custom source' },
}

const llm = computed<any>(() => (store.AIconfig as any)?.llm || {})
/** 当前来源（历史 'deepseek-responses' 归一到 deepseek；与 store 的 testLlmSource 口径一致） */
const activeType = computed(() => {
  const t = String(llm.value.type || 'ollama')
  return t === 'deepseek-responses' ? 'deepseek' : t
})
const activeLabel = computed(() => {
  const label = SOURCE_LABELS[activeType.value]
  return label ? (zh.value ? label.cn : label.en) : activeType.value
})

/** 当前来源的关键字段（地址 / 模型 / 凭据），只用于展示与判断是否已配置 */
const activeSource = computed(() => {
  const l = llm.value
  switch (activeType.value) {
    case 'ollama': return { endpoint: l.ollama?.model_url || '', model: l.ollama?.model || '', key: '', local: true }
    case 'lmstudio': return { endpoint: l.lmstudio?.base_url || '', model: l.lmstudio?.model || '', key: l.lmstudio?.api_key || l.lmstudio?.apiKeyRef || '', local: true }
    case 'openai': return { endpoint: l.openai?.base_url || '', model: l.openai?.model || '', key: l.openai?.api_key || l.openai?.apiKeyRef || '', local: false }
    case 'deepseek': {
      const ds = l.deepseek || {}
      return { endpoint: ds.base_url || '', model: ds.model || '', key: ds.api_key || ds.apiKeyRef || '', local: false }
    }
    case 'gpustack': return { endpoint: l.gpustack?.base_url || '', model: l.gpustack?.model || '', key: l.gpustack?.api_key || '', local: true }
    case 'glm':
    case 'kimi':
    case 'mimo': {
      const c = l[activeType.value] || {}
      return { endpoint: c.base_url || '', model: c.model || '', key: c.api_key || c.apiKeyRef || '', local: false }
    }
    case 'anthropic': return { endpoint: 'https://api.anthropic.com', model: l.anthropic?.model || '', key: l.anthropic?.api_key || l.anthropic?.apiKeyRef || '', local: false }
    case 'google': return { endpoint: 'Google Generative Language API', model: l.google?.model || '', key: l.google?.api_key || l.google?.apiKeyRef || '', local: false }
    case 'azure': return { endpoint: l.azure?.endpoint || '', model: l.azure?.deployment || '', key: l.azure?.api_key || l.azure?.apiKeyRef || '', local: false }
    case 'custom': {
      const srcs = Array.isArray(l.custom?.sources) ? l.custom.sources : []
      const i = typeof l.custom?.activeIndex === 'number' ? l.custom.activeIndex : 0
      const c = srcs[i] || l.custom || {}
      return { endpoint: c.api_url || '', model: c.model || '', key: c.api_key || c.apiKeyRef || '', local: false }
    }
    default: return { endpoint: '', model: '', key: '', local: true }
  }
})

/** 已配置：云端来源看凭据，本地来源看模型名（与「能不能直接开始聊天」一致） */
const modelConfigured = computed(() => activeSource.value.local
  ? !!String(activeSource.value.model || '').trim()
  : !!String(activeSource.value.key || '').trim())

// ---------- 步骤 1：选择来源（展开分三类，和原来一样）；步骤 2：配置选中的来源 ----------
type OnbCategory = 'local' | 'cloud' | 'gateway'
/** 来源按分类分组（本地化 / 互联网 / 自定义网关），顺序与 设置 → 模型 → 来源 一致 */
const pickGroups = computed(() => {
  const groups: Array<{ key: OnbCategory; titleZh: string; titleEn: string; items: string[] }> = [
    { key: 'local', titleZh: LLM_SOURCE_CATEGORY_LABELS.local.zh, titleEn: LLM_SOURCE_CATEGORY_LABELS.local.en, items: [] },
    { key: 'cloud', titleZh: LLM_SOURCE_CATEGORY_LABELS.cloud.zh, titleEn: LLM_SOURCE_CATEGORY_LABELS.cloud.en, items: [] },
    { key: 'gateway', titleZh: LLM_SOURCE_CATEGORY_LABELS.gateway.zh, titleEn: LLM_SOURCE_CATEGORY_LABELS.gateway.en, items: [] },
  ]
  for (const id of ONBOARDING_SOURCE_IDS) {
    const g = groups.find((x) => x.key === llmSourceCategory(id)) || groups[1]
    g.items.push(id)
  }
  return groups.filter((g) => g.items.length)
})
const picked = ref(activeType.value)
const pickedCategory = computed<OnbCategory>(() => llmSourceCategory(picked.value) as OnbCategory)

/** 本地/网关要填地址；互联网来源只填 API Key；三者都可以填模型名（留空则测试时自动选第一个） */
const showAddress = computed(() => pickedCategory.value !== 'cloud')
const showKey = computed(() => pickedCategory.value !== 'local')

const draft = ref({ base_url: '', api_key: '', model: '' })
const pickedDoc = computed(() => llmSourceDoc(picked.value))
const docName = (id: string) => {
  const d = llmSourceDoc(id)
  return d ? (zh.value ? d.nameZh : d.nameEn) : id
}
const openDoc = (url?: string) => { void openExternalUrl(url) }

/** 从 store 读该来源当前的地址 / Key / 模型到输入框 */
const loadDraft = () => {
  const llm = (store.AIconfig as any)?.llm || {}
  const type = normalizeLlmSourceId(picked.value)
  if (type === 'custom') {
    const c = llm.custom || {}
    const srcs = Array.isArray(c.sources) ? c.sources : []
    const i = typeof c.activeIndex === 'number' && c.activeIndex >= 0 && c.activeIndex < srcs.length ? c.activeIndex : 0
    const s = srcs[i] || c
    draft.value = { base_url: s.api_url || c.api_url || '', api_key: s.api_key || c.api_key || '', model: s.model || c.model || '' }
    return
  }
  const b = llm[type] || {}
  draft.value = {
    base_url: b.base_url || b.model_url || b.endpoint || '',
    api_key: b.api_key || '',
    model: b.model || b.deployment || '',
  }
}

/** 把输入框写回 store（并把该来源设为默认），返回来源键 */
const applyDraft = (): string => {
  const llm = (store.AIconfig as any).llm
  if (!llm) return ''
  const type = normalizeLlmSourceId(picked.value)
  llm.type = type
  const v = draft.value
  if (type === 'custom') {
    const c = (llm.custom = llm.custom || { sources: [] })
    const srcs = Array.isArray(c.sources) ? c.sources : (c.sources = [])
    const i = typeof c.activeIndex === 'number' && c.activeIndex >= 0 && c.activeIndex < srcs.length ? c.activeIndex : 0
    const s = srcs[i] || (srcs[i] = { id: srcs.length + 1, name: 'Custom', api_url: '', api_key: '', model: '', available_models: [] })
    s.api_url = v.base_url
    s.api_key = v.api_key
    s.model = v.model
    c.api_url = v.base_url
    c.api_key = v.api_key
    c.model = v.model
    c.activeIndex = i
  } else {
    const b = (llm[type] = llm[type] || { available_models: [] })
    if ('model_url' in b) b.model_url = v.base_url
    if ('base_url' in b) b.base_url = v.base_url
    if ('endpoint' in b) b.endpoint = v.base_url
    if ('deployment' in b) b.deployment = v.model
    b.api_key = v.api_key
    if (type !== 'azure') b.model = v.model
  }
  try { store.saveConfig() } catch { /* 落盘失败不影响本次测试 */ }
  return type
}

watch(picked, () => { loadDraft() })
onMounted(() => { loadDraft(); applyFeatureDefaultsOnce() })
/** 保存当前输入并打开完整设置（字段更多的来源，如 Azure 的 deployment，继续在设置里补） */
const openFullSettings = () => {
  applyDraft()
  // 先收起引导：单窗口模式下设置是 z-index 更高的页面内浮层，两层叠着会互相挡按钮；
  // 关掉设置后 App 会自动把引导放回来（resume: true）
  emit('suspend', { resume: true })
  try { store.openSettings('llm') } catch { /* 打开失败不影响引导本身 */ }
}

// ================ 功能引导（导航模块开关） ================
interface FeatureDef { key: string; icon: string; zh: string; en: string; descZh: string; descEn: string }
const FEATURES: FeatureDef[] = [
  { key: '主页', icon: 'fa-home', zh: '对话', en: 'Chat', descZh: '和模型聊天；切到「智能体」后它会自己规划、调用工具', descEn: 'Chat with models; Agent mode plans and uses tools' },
  { key: '知识管理', icon: 'fa-book', zh: '知识管理', en: 'Knowledge', descZh: '文件、知识库、工作流、数据画布都在这里', descEn: 'Files, knowledge bases, workflows, data canvases' },
  { key: '知识处理', icon: 'fa-layer-group', zh: '知识处理', en: 'Knowledge processing', descZh: '把资料切片、向量化，生成可检索的知识库', descEn: 'Slice and embed documents into a searchable knowledge base' },
  { key: '学习', icon: 'fa-graduation-cap', zh: '学习', en: 'Learning', descZh: '用知识库刷题、复习，记录掌握度', descEn: 'Practice, review and track mastery' },
]
/** 首次安装的默认：只开「对话」和「知识管理」；浏览器 Agent 默认关闭 */
const DEFAULT_OFF_MODULES = ['知识处理', '学习']
const DEFAULT_OFF_EXTRAS = ['agent']
/** 其他导航入口（与设置页「导航与模块」同一组 key：hiddenExtras） */
const EXTRA_FEATURES: FeatureDef[] = [
  { key: 'attention', icon: 'fa-inbox', zh: '待我处理', en: 'Needs me', descZh: '智能体提问、计划待批、运行汇报的收件箱', descEn: 'Inbox for agent questions, plan approvals and run reports' },
  { key: 'agent', icon: 'fa-globe', zh: '浏览器 Agent', en: 'Browser Agent', descZh: '内置浏览器：让智能体打开网页、抓取内容、截图', descEn: 'Built-in browser: agents open pages, extract text and take screenshots' },
]

const isExtraNav = (key: string) => key === 'attention' || key === 'agent'
const featureOn = (key: string) => (isExtraNav(key) ? store.isExtraVisible(key) : store.isNavVisible(key))
const toggleFeature = (key: string) => {
  if (isExtraNav(key)) store.toggleExtra(key)
  else store.toggleNav(key)
  try { store.saveConfig() } catch { /* 落盘失败不影响界面开关 */ }
}
/**
 * 只在「没有历史导航配置」时套用默认（全新安装）。
 * 升级用户的模块保持原样：引导里能看到当前状态、想关再关，不会被擅自收走。
 */
/**
 * 全新安装的默认值只套一次：只开「对话 / 知识管理」，浏览器 Agent 关闭。
 * 判定「全新」看有没有使用痕迹（聊天 / 工作区 / 已配模型），而不是看某个存档键是否存在——
 * hiddenNavs / hiddenExtras 在启动时可能已经被其它地方写成空数组，按 null 判断并不可靠。
 */
const DEFAULTS_MARKER = 'kb-onboarding-defaults-v1'
const looksLikeFreshInstall = (): boolean => {
  try {
    const chats = JSON.parse(localStorage.getItem('ai-chats') || '[]')
    if (Array.isArray(chats) && chats.length) return false
    if (store.roots.length) return false
    const llm = (store.AIconfig as any)?.llm || {}
    const hasKey = (c: any) => !!(c?.api_key || c?.apiKeyRef)
    if (['deepseek', 'glm', 'kimi', 'mimo', 'openai', 'anthropic', 'google', 'azure'].some((k) => hasKey(llm[k]))) return false
    const hasModel = (c: any) => !!String(c?.model || '').trim()
    if (hasModel(llm.ollama) || hasModel(llm.lmstudio) || hasModel(llm.gpustack)) return false
    return true
  } catch {
    return false
  }
}
const applyFeatureDefaultsOnce = () => {
  try {
    if (localStorage.getItem(DEFAULTS_MARKER) === '1') return
    localStorage.setItem(DEFAULTS_MARKER, '1')
    if (!looksLikeFreshInstall()) return
    let changed = false
    for (const key of DEFAULT_OFF_MODULES) {
      if (store.isNavVisible(key)) { store.toggleNav(key); changed = true }
    }
    for (const key of DEFAULT_OFF_EXTRAS) {
      if (store.isExtraVisible(key)) { store.toggleExtra(key); changed = true }
    }
    if (changed) store.saveConfig()
  } catch { /* 忽略 */ }
}

const testing = ref(false)
const testState = ref<'' | 'ok' | 'fail'>('')
const testDetail = ref('')
/** 保存输入 → 探测该来源 → 模型名留空时用探测到的第一个补上 */
const testConnection = async () => {
  if (testing.value) return
  testing.value = true
  testState.value = ''
  testDetail.value = ''
  try {
    const type = applyDraft()
    const r: any = await (store as any).testLlmSource(type)
    if (r?.ok && !String(draft.value.model || '').trim() && Array.isArray(r.models) && r.models.length) {
      draft.value.model = r.models[0]
      applyDraft()
    }
    testState.value = r?.ok ? 'ok' : 'fail'
    testDetail.value = r?.ok
      ? t(`连接成功${Array.isArray(r.models) && r.models.length ? `，可用模型 ${r.models.length} 个` : ''}`,
          `Connected${Array.isArray(r.models) && r.models.length ? `, ${r.models.length} models available` : ''}`)
      : t('连接失败：检查地址 / Key / 服务是否已启动', 'Failed: check the address, key or whether the service is running')
  } catch (e: any) {
    testState.value = 'fail'
    testDetail.value = String(e?.message || e)
  } finally {
    testing.value = false
  }
}

// ================ 工作区 ================
const picking = ref(false)
const wsNote = ref('')
const pickWorkspace = async () => {
  if (picking.value) return
  picking.value = true
  wsNote.value = ''
  try {
    const p = await getPlatform().dialog.pickDirectory()
    if (!p) return
    const isNew = store.addRoot(p)
    wsNote.value = isNew
      ? t('已添加并设为当前工作区', 'Added and set as the current workspace')
      : t('该文件夹已在列表里，已切换过去', 'Already in the list — switched to it')
  } catch (e: any) {
    wsNote.value = t('当前环境无法打开文件夹选择器，请稍后在 设置 → 通用 → 基础 里手动填写路径',
      'Folder picker unavailable here — set the path later in Settings → General → Basic')
    void e
  } finally {
    picking.value = false
  }
}
const setActiveWorkspace = (p: string) => { store.setActiveRoot(p) }

// ================ 步骤 ================
type StepId = 'welcome' | 'workspace' | 'source' | 'model' | 'features' | 'done'
interface Step { id: StepId; icon: string; title: string; desc: string; nav: string }

/**
 * 某个步骤的标题 / 说明（随语言实时切换）。
 * 只负责文案：步骤是否出现在这次引导里由下方 stepIds 决定。
 */
const stepMeta = (id: StepId): Step => {
  switch (id) {
    case 'welcome':
      return {
        id, icon: 'fa fa-flag-o', nav: t('开始之前', 'Before you start'),
        title: t('开始之前', 'Before you start'),
        desc: t('两步就能开始用：选一个工作区、配一个模型。语言、主题和窗口模式也可以在这里先定下来。',
          'Two things and you are ready: a workspace and a model. Pick language, theme and window mode here too.'),
      }
    case 'workspace':
      return {
        id, icon: 'fa fa-folder-open-o', nav: t('选择目录', 'Workspace'),
        title: t('选择工作区', 'Choose a workspace'),
        desc: t('文件、知识库、工作流的源文件都存在这个文件夹里；也可以以后再加多个。',
          'Files, knowledge bases and workflows live in this folder. You can add more later.'),
      }
    case 'source':
      return {
        id, icon: 'fa fa-list', nav: t('选择来源', 'Source'),
        title: t('选择模型来源', 'Choose a source'),
        desc: t('本地部署（免 Key）/ 互联网 API（官网申请 Key）/ 自定义网关，选一个再填参数。',
          'Local (no key) / Cloud API (get a key from the provider) / Custom gateway — pick one, then fill in its fields.'),
      }
    case 'model':
      return {
        id, icon: 'fa fa-comments-o', nav: t('配置模型', 'Model'),
        title: t('配置模型', 'Set up a model'),
        desc: t('填所选来源的地址 / API Key 后点「保存并测试连接」。本地模型免 Key。',
          'Fill the endpoint / API key of the chosen source, then Save and test. Local models need no key.'),
      }
    case 'features':
      return {
        id, icon: 'fa fa-th-large', nav: t('选择功能', 'Modules'),
        title: t('选择要用的功能', 'Choose your modules'),
        desc: t('导航栏只显示你勾选的模块，之后随时能在「设置 → 通用 → 基础 → 导航与模块」里改。',
          'Only the modules you enable appear in the navigation bar; change them anytime under Settings → General → Basic.'),
      }
    default:
      return {
        id: 'done', icon: 'fa fa-check-circle-o', nav: t('开始使用', 'Start'),
        title: t('开始使用', 'Get started'),
        desc: t('这些都能随时在设置里改，不看引导也能用。', 'Everything here can be changed later in Settings.'),
      }
  }
}

/**
 * 这次引导要走的步骤**在打开时一次性定好**（与 DSH 的 onboarding 一致：条件步骤只在开始时判定）。
 * 否则「选完工作区 → 工作区步骤从列表里消失」「配好模型 → 模型步骤消失」，
 * 步骤条会当着用户的面跳掉一项，看起来像功能失效。
 */
const stepIds = ref<StepId[]>((() => {
  const ids: StepId[] = ['welcome']
  if (props.force || store.roots.length === 0) ids.push('workspace')
  if (props.force || !modelConfigured.value) ids.push('source', 'model')
  ids.push('features', 'done')
  return ids
})())

const steps = computed<Step[]>(() => stepIds.value.map(stepMeta))

const idx = ref(0)
/** 起始步：按上次进度定位到同 id 的步骤（步骤集合可能因条件变化而不同） */
const initialIdx = computed(() => {
  const want = Math.max(0, Math.min(props.startStep, steps.value.length - 1))
  return want
})
idx.value = initialIdx.value
watch(() => props.startStep, () => { idx.value = initialIdx.value })
// 当前步骤因为「已经配好了」而从列表里消失时，落到最后一步
watch(steps, (list) => {
  if (idx.value >= list.length) idx.value = list.length - 1
})

const current = computed(() => steps.value[Math.min(idx.value, steps.value.length - 1)])
const isLast = computed(() => idx.value >= steps.value.length - 1)
const go = (i: number) => { if (i >= 0 && i < steps.value.length) idx.value = i }
const prev = () => go(idx.value - 1)
const next = () => { if (isLast.value) finish('finished'); else go(idx.value + 1) }
const skip = () => finish('skipped')
const finish = (kind: 'finished' | 'skipped') => emit('done', kind)
watch(idx, (v) => emit('step', v), { immediate: true })

// ================ 外观 ================
/** 引导里只列内置主题（自建主题在设置里管理） */
const themeChoices = ['浅蓝', '深蓝', '深色', '午夜蓝', '海洋蓝', '极光绿']
  .filter((name) => !!THEMES[name])
const themeLabel = (name: string) => (zh.value ? name : (THEMES[name]?.labelEn || name))
const swatch = (name: string) => {
  const th: any = THEMES[name] || {}
  return `linear-gradient(135deg, ${th.backgroundColor || '#fff'} 0 45%, ${th.menuColor || '#eee'} 45% 72%, ${th.fontActiveColor || '#333'} 72%)`
}
const pickTheme = (name: string) => {
  if (store.UI.theme === name) return
  store.UI.theme = name
  store.changeTheme()
}
const pickLocale = (v: 'zh' | 'en') => {
  if (store.locales === v) return
  store.setLocale(v)
}
/** 窗口交互模式：只在有窗口壳的桌面端可选（安卓 / 网页强制单窗口） */
const windowModeSupported = hasCapability('window.chrome')
const setWindowMode = (mode: 'single' | 'multi') => {
  if (store.UI.windowMode === mode) return
  store.UI.windowMode = mode
  try { store.saveConfig() } catch { /* 落盘失败不影响本次会话 */ }
}
</script>

<template>
  <div class="ob-overlay" role="dialog" aria-modal="true">
    <div class="ob-card">
      <!-- 右上角收起：不标记完成，下次启动/下次打开还能接着走 -->
      <button class="ob-close" :title="t('暂时收起（进度保留）', 'Hide for now (progress kept)')"
              @click="emit('suspend', { resume: false })">
        <i class="fa fa-times"></i>
      </button>
      <aside class="ob-rail">
        <div class="ob-brand">
          <div class="ob-brand-icon"><i class="fa fa-book"></i></div>
          <div class="ob-brand-text">
            <b>{{ t('使用引导', 'Setup guide') }}</b>
            <span>{{ t('几分钟完成基础配置', 'A few minutes to get set up') }}</span>
          </div>
        </div>

        <ol class="ob-steps">
          <li v-for="(s, i) in steps" :key="s.id" class="ob-step" :class="{ active: i === idx, done: i < idx }" @click="go(i)">
            <span class="ob-step-num"><i v-if="i < idx" class="fa fa-check"></i><template v-else>{{ i + 1 }}</template></span>
            <span class="ob-step-label">{{ s.nav }}</span>
          </li>
        </ol>

        <p class="ob-rail-foot">
          {{ t('可随时跳过；之后在 设置 → 通用 → 基础 → 常用操作 里能重新打开。',
            'Skip anytime — reopen it later from Settings → General → Basic → Common Actions.') }}
        </p>
      </aside>

      <section class="ob-main">
        <header class="ob-head">
          <h2>{{ current.title }}</h2>
          <p>{{ current.desc }}</p>
        </header>

        <div class="ob-body">
          <!-- ① 语言 / 主题 -->
          <template v-if="current.id === 'welcome'">
            <div class="ob-field">
              <div class="ob-field-label">{{ t('界面语言', 'Language') }}</div>
              <div class="ob-chips">
                <button class="ob-chip" :class="{ on: zh }" @click="pickLocale('zh')">中文</button>
                <button class="ob-chip" :class="{ on: !zh }" @click="pickLocale('en')">English</button>
              </div>
            </div>

            <div class="ob-field">
              <div class="ob-field-label">{{ t('主题', 'Theme') }}</div>
              <div class="ob-themes">
                <button v-for="th in themeChoices" :key="th" class="ob-theme" :class="{ on: store.UI.theme === th }"
                        :title="themeLabel(th)" @click="pickTheme(th)">
                  <span class="ob-theme-swatch" :style="{ background: swatch(th) }"></span>
                  <span class="ob-theme-name">{{ themeLabel(th) }}</span>
                </button>
              </div>
            </div>

            <div v-if="windowModeSupported" class="ob-field">
              <div class="ob-field-label">{{ t('窗口模式', 'Window mode') }}</div>
              <div class="ob-chips">
                <button class="ob-chip" :class="{ on: store.UI.windowMode !== 'single' }" @click="setWindowMode('multi')">
                  {{ t('多窗口', 'Multi-window') }}
                </button>
                <button class="ob-chip" :class="{ on: store.UI.windowMode === 'single' }" @click="setWindowMode('single')">
                  {{ t('单窗口', 'Single window') }}
                </button>
              </div>
              <p class="ob-hint" style="margin-top:6px">
                <i class="fa fa-info-circle"></i>
                {{ t('多窗口：设置、文件、插件各开独立窗口；单窗口：文件进标签页、设置与插件是页面内浮层。',
                  'Multi-window: settings, files and plugins open in their own windows. Single window: files become tabs, settings and plugins slide in as overlays.') }}
              </p>
            </div>

            <p class="ob-hint">
              <i class="fa fa-info-circle"></i>
              {{ t('这些设置随时可以在「设置 → 通用 → 基础」里改，主题还能自定义配色。',
                'All of this can be changed later under Settings → General → Basic; themes support custom colors.') }}
            </p>
          </template>

          <!-- ② 工作区 -->
          <template v-else-if="current.id === 'workspace'">
            <div class="ob-field">
              <div class="ob-field-label">{{ t('当前工作区', 'Current workspace') }}</div>
              <div v-if="!store.roots.length" class="ob-empty">
                <i class="fa fa-folder-open-o"></i>
                <span>{{ t('还没有选择工作区。选一个文件夹就行，不会动里面已有的文件。',
                  'No workspace yet. Pick a folder — existing files are left untouched.') }}</span>
              </div>
              <ul v-else class="ob-ws-list">
                <li v-for="p in store.roots" :key="p" class="ob-ws" :class="{ on: p === store.root }" @click="setActiveWorkspace(p)">
                  <i class="fa" :class="p === store.root ? 'fa-check-circle' : 'fa-circle-o'"></i>
                  <span class="ob-ws-path" :title="p">{{ p }}</span>
                  <span v-if="p === store.root" class="ob-ws-tag">{{ t('当前', 'active') }}</span>
                </li>
              </ul>
              <div class="ob-row">
                <button class="ob-btn primary" :disabled="picking" @click="pickWorkspace">
                  <i class="fa" :class="picking ? 'fa-spinner fa-spin' : 'fa-folder-open'"></i>
                  {{ t('选择文件夹…', 'Choose folder…') }}
                </button>
                <span v-if="wsNote" class="ob-note">{{ wsNote }}</span>
              </div>
            </div>
            <p class="ob-hint">
              <i class="fa fa-info-circle"></i>
              {{ t('以后可以在「设置 → 通用 → 基础 → 工作区路径设置」里添加多个工作区并切换。',
                'You can add more workspaces later in Settings → General → Basic → Workspace paths.') }}
            </p>
          </template>

          <!-- ③ 选择来源：分三类展开（和原来一样） -->
          <template v-else-if="current.id === 'source'">
            <div v-for="group in pickGroups" :key="group.key" class="ob-src-group">
              <div class="ob-src-group-title">{{ zh ? group.titleZh : group.titleEn }}</div>
              <div class="ob-src-grid">
                <button v-for="id in group.items" :key="id" class="ob-src" :class="{ on: picked === id }"
                        :title="docName(id)" @click="picked = id">
                  <span class="ob-src-name">{{ docName(id) }}</span>
                  <span class="ob-src-kind">{{ zh ? group.titleZh : group.titleEn }}</span>
                </button>
              </div>
            </div>
            <p class="ob-hint">
              <i class="fa fa-info-circle"></i>
              {{ t('选一个来源，点「下一步」填它的地址 / API Key；本地部署的先去官网装好软件。',
                'Pick a source and press Next to fill its endpoint / API key; for local sources install the app first.') }}
            </p>
          </template>

          <!-- ④ 配置模型：只针对上一步选中的来源 -->
          <template v-else-if="current.id === 'model'">
            <div class="ob-picked">
              <span class="ob-picked-label">{{ t('当前来源', 'Source') }}</span>
              <b>{{ docName(picked) }}</b>
              <span class="ob-picked-tag">{{ zh ? pickGroups.find(g => g.key === pickedCategory)?.titleZh : pickGroups.find(g => g.key === pickedCategory)?.titleEn }}</span>
            </div>

            <!-- 去哪儿下载 / 去哪儿申请 Key（与 设置 → 模型 → 来源 同一份资料） -->
            <div v-if="pickedDoc && (pickedDoc.siteUrl || pickedDoc.docsUrl)" class="ob-doc-inline">
              <button v-if="pickedDoc.siteUrl" class="ob-link" :title="pickedDoc.siteUrl" @click="openDoc(pickedDoc.siteUrl)">
                {{ zh ? pickedDoc.siteLabelZh : pickedDoc.siteLabelEn }} <i class="fa fa-external-link"></i>
              </button>
              <button v-if="pickedDoc.docsUrl" class="ob-link" :title="pickedDoc.docsUrl" @click="openDoc(pickedDoc.docsUrl)">
                {{ zh ? pickedDoc.docsLabelZh : pickedDoc.docsLabelEn }} <i class="fa fa-external-link"></i>
              </button>
            </div>

            <!-- 地址 / Key 与模型名同一行（本地：地址+模型；互联网：Key+模型；网关：地址+Key，第二行模型） -->
            <div class="ob-grid2">
              <div v-if="showAddress" class="ob-field">
                <div class="ob-field-label">{{ t('服务地址', 'Endpoint') }}</div>
                <input v-model="draft.base_url" class="ob-input"
                       :placeholder="pickedCategory === 'gateway' ? 'https://gateway.example/v1' : 'http://127.0.0.1:11434'"/>
              </div>

              <div v-if="showKey" class="ob-field">
                <div class="ob-field-label">{{ t('API Key', 'API Key') }}</div>
                <input v-model="draft.api_key" type="password" class="ob-input"
                       :placeholder="t('在官网申请后粘贴到这里', 'Paste the key from the provider site')"/>
              </div>

              <div class="ob-field">
                <div class="ob-field-label">{{ t('模型名称（可留空）', 'Model (optional)') }}</div>
                <input v-model="draft.model" class="ob-input"
                       :placeholder="t('留空则自动选第一个', 'Empty picks the first one')"/>
              </div>
            </div>

            <div class="ob-row">
              <button class="ob-btn primary" :disabled="testing" @click="testConnection">
                <i class="fa" :class="testing ? 'fa-spinner fa-spin' : 'fa-plug'"></i>
                {{ t('保存并测试连接', 'Save and test') }}
              </button>
              <button class="ob-btn" @click="openFullSettings">
                <i class="fa fa-cogs"></i> {{ t('打开完整设置', 'Full settings') }}
              </button>
              <span v-if="testState" class="ob-note" :class="testState">{{ testDetail }}</span>
            </div>

            <p v-if="pickedDoc" class="ob-hint">
              <i class="fa fa-info-circle"></i>
              {{ zh ? pickedDoc.hintZh : pickedDoc.hintEn }}
            </p>
          </template>

          <!-- ④ 功能引导：导航模块开关（默认只开对话 / 知识管理） -->
          <template v-else-if="current.id === 'features'">
            <ul class="ob-feats">
              <li v-for="f in FEATURES" :key="f.key" class="ob-feat" :class="{ on: featureOn(f.key) }"
                  @click="toggleFeature(f.key)">
                <div class="ob-feat-icon"><i class="fa" :class="f.icon"></i></div>
                <div class="ob-feat-text">
                  <b>{{ zh ? f.zh : f.en }}</b>
                  <span>{{ zh ? f.descZh : f.descEn }}</span>
                </div>
                <span class="ob-switch" :class="{ on: featureOn(f.key) }"><span class="ob-switch-knob"></span></span>
              </li>
            </ul>
            <ul class="ob-feats">
              <li v-for="f in EXTRA_FEATURES" :key="f.key" class="ob-feat" :class="{ on: featureOn(f.key) }"
                  @click="toggleFeature(f.key)">
                <div class="ob-feat-icon"><i class="fa" :class="f.icon"></i></div>
                <div class="ob-feat-text">
                  <b>{{ zh ? f.zh : f.en }}</b>
                  <span>{{ zh ? f.descZh : f.descEn }}</span>
                </div>
                <span class="ob-switch" :class="{ on: featureOn(f.key) }"><span class="ob-switch-knob"></span></span>
              </li>
            </ul>
            <p class="ob-hint">
              <i class="fa fa-info-circle"></i>
              {{ t('默认只开「对话」和「知识管理」，浏览器 Agent 默认关闭。关掉的模块只是不显示在导航栏，数据不会丢；之后可在「设置 → 通用 → 基础 → 导航与模块」里随时改。',
                'Chat and Knowledge are on by default and Browser Agent is off. Turning a module off only hides it from the navbar — data stays. Change this anytime under Settings → General → Basic.') }}
            </p>
          </template>

          <!-- ⑤ 完成 -->
          <template v-else>
            <ul class="ob-summary">
              <li>
                <i class="fa" :class="zh ? 'fa-check-circle ok' : 'fa-check-circle ok'"></i>
                <b>{{ t('语言 / 主题', 'Language / theme') }}</b>
                <span>{{ zh ? '中文' : 'English' }} · {{ themeLabel(store.UI.theme) }}</span>
              </li>
              <li>
                <i class="fa" :class="store.root ? 'fa-check-circle ok' : 'fa-exclamation-circle warn'"></i>
                <b>{{ t('工作区', 'Workspace') }}</b>
                <span :title="store.root || ''">{{ store.root || t('未设置（可稍后在设置里选）', 'Not set (choose later in Settings)') }}</span>
              </li>
              <li>
                <i class="fa" :class="modelConfigured ? 'fa-check-circle ok' : 'fa-exclamation-circle warn'"></i>
                <b>{{ t('模型', 'Model') }}</b>
                <span>{{ modelConfigured ? `${activeLabel} · ${activeSource.model}` : t('未配置（没有模型无法对话）', 'Not configured (chat needs a model)') }}</span>
              </li>
            </ul>

            <div class="ob-tips">
              <div class="ob-tip"><i class="fa fa-comments-o"></i><div><b>{{ t('直接对话', 'Just chat') }}</b><span>{{ t('主页输入框提问；需要干活时切到「智能体」，它会自己规划并调用工具。', 'Ask in the Home box; switch to Agent when it should plan and use tools.') }}</span></div></div>
              <div class="ob-tip"><i class="fa fa-folder-open-o"></i><div><b>{{ t('知识管理', 'Knowledge') }}</b><span>{{ t('左侧导航进「知识管理」，在那里新建 / 打开文件、建知识库与工作流。', 'Open Knowledge from the sidebar to create files, knowledge bases and workflows.') }}</span></div></div>
              <div class="ob-tip"><i class="fa fa-cogs"></i><div><b>{{ t('随时调整', 'Change anytime') }}</b><span>{{ t('模型、工具、技能、联网搜索等都在「设置」里；本引导也能从「常用操作」重新打开。', 'Models, tools, skills and search live in Settings; reopen this guide from Common Actions.') }}</span></div></div>
            </div>
          </template>
        </div>

        <footer class="ob-foot">
          <button class="ob-btn ghost" @click="skip">{{ t('跳过引导', 'Skip') }}</button>
          <span class="ob-spacer"></span>
          <button v-if="idx > 0" class="ob-btn" @click="prev">{{ t('上一步', 'Back') }}</button>
          <button class="ob-btn primary" @click="next">
            {{ isLast ? t('开始使用', 'Get started') : t('下一步', 'Next') }}
            <i class="fa" :class="isLast ? 'fa-check' : 'fa-arrow-right'"></i>
          </button>
        </footer>
      </section>
    </div>
  </div>
</template>

<style scoped>
.ob-overlay {
  position: fixed; inset: 0; z-index: 1480;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, .45);
  /* 设置浮层（1500）要能盖住本层：用户在引导里点「打开模型设置」时不会被挡住 */
  backdrop-filter: blur(2px);
}
.ob-card {
  position: relative;
  width: min(880px, 94vw); height: min(600px, 90vh);
  display: flex; overflow: hidden;
  background: var(--backgroundColor); color: var(--fontColor);
  border: 1px solid var(--borderColor); border-radius: 14px;
  box-shadow: 0 24px 70px rgba(0, 0, 0, .35);
}
.ob-rail {
  width: 232px; flex-shrink: 0; display: flex; flex-direction: column;
  padding: 18px 14px; background: var(--menuColor);
  border-right: 1px solid var(--borderColor);
}
/* 收起按钮：贴在卡片右上角，任何一步都能把引导暂时收起来 */
.ob-close {
  position: absolute; top: 8px; right: 8px; z-index: 2;
  width: 24px; height: 24px; border: none; border-radius: 6px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  background: transparent; color: var(--fontColor); opacity: .5; font-size: 12px;
}
.ob-close:hover { opacity: 1; background: color-mix(in srgb, var(--fontColor) 10%, transparent); }
.ob-brand { display: flex; align-items: center; gap: 9px; margin-bottom: 16px; }
.ob-brand-icon {
  width: 32px; height: 32px; border-radius: 9px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--fontActiveColor); color: var(--backgroundColor); font-size: 15px;
}
.ob-brand-text { display: flex; flex-direction: column; line-height: 1.35; min-width: 0; }
.ob-brand-text b { font-size: 13px; }
.ob-brand-text span { font-size: 10px; opacity: .65; }
.ob-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.ob-step {
  display: flex; align-items: center; gap: 8px; padding: 7px 8px;
  border-radius: 7px; cursor: pointer; font-size: 12px; opacity: .65;
  transition: background .15s, opacity .15s;
}
.ob-step:hover { background: color-mix(in srgb, var(--fontColor) 7%, transparent); opacity: .9; }
.ob-step.active { background: var(--menuActiveColor); color: var(--fontActiveColor); opacity: 1; font-weight: 600; }
.ob-step.done { opacity: .85; }
.ob-step-num {
  width: 18px; height: 18px; flex-shrink: 0; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; border: 1px solid currentColor;
}
.ob-step.done .ob-step-num { border-color: transparent; background: var(--fontActiveColor); color: var(--backgroundColor); }
.ob-rail-foot { margin: auto 2px 0; font-size: 10px; line-height: 1.6; opacity: .55; }
.ob-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.ob-head { padding: 20px 24px 10px; }
.ob-head h2 { margin: 0 0 6px; font-size: 17px; color: var(--fontActiveColor); }
.ob-head p { margin: 0; font-size: 12px; line-height: 1.65; opacity: .7; }
.ob-body { flex: 1; min-height: 0; overflow: auto; padding: 6px 24px 14px; }
.ob-field { margin-bottom: 16px; }
.ob-field-label { font-size: 12px; font-weight: 600; margin-bottom: 8px; }
.ob-chips { display: flex; gap: 8px; }
/* 紧凑下拉 / 输入框：模型步骤只用「分类 + 来源 + 2~3 个输入框」，不铺满整屏 */
.ob-select, .ob-input {
  width: 100%; box-sizing: border-box; height: 32px; padding: 0 9px;
  border: 1px solid var(--borderColor); border-radius: 7px;
  background: var(--backgroundColor); color: var(--fontColor); font-size: 12px;
}
.ob-select:focus, .ob-input:focus { outline: none; border-color: var(--fontActiveColor); }
/* 分类是下拉，但不必占满整行 */
.ob-select.narrow { max-width: 240px; }
/* 地址 / Key 与模型名同一行（窄屏自动回落单列） */
.ob-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
/* 功能引导：模块开关列表 */
.ob-feats { list-style: none; margin: 2px 0 4px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.ob-feats-title { font-size: 10px; opacity: .55; margin: 10px 0 4px 2px; }
.ob-feat {
  display: flex; align-items: center; gap: 10px; padding: 9px 11px;
  border: 1px solid var(--borderColor); border-radius: 9px; cursor: pointer;
  transition: border-color .15s, background .15s;
}
.ob-feat:hover { border-color: var(--fontActiveColor); }
.ob-feat.on { border-color: var(--fontActiveColor); }
.ob-feat-icon {
  width: 28px; height: 28px; border-radius: 8px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--menuColor); color: var(--fontActiveColor); font-size: 13px;
}
.ob-feat-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ob-feat-text b { font-size: 12px; }
.ob-feat-text span { font-size: 10px; line-height: 1.5; opacity: .65; }
.ob-switch {
  width: 34px; height: 18px; border-radius: 9px; flex-shrink: 0; position: relative;
  background: var(--borderColor); transition: background .15s;
}
.ob-switch.on { background: var(--fontActiveColor); }
.ob-switch-knob {
  position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
  background: var(--backgroundColor); transition: transform .15s;
}
.ob-switch.on .ob-switch-knob { transform: translateX(16px); }

.ob-doc-inline { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 6px; }
.ob-chip {
  padding: 7px 16px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--borderColor); background: var(--backgroundColor);
  color: var(--fontColor); font-size: 12px; transition: all .15s;
}
.ob-chip:hover { border-color: var(--fontActiveColor); }
.ob-chip.on { background: var(--menuActiveColor); border-color: var(--fontActiveColor); color: var(--fontActiveColor); font-weight: 600; }
.ob-themes { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; }
.ob-theme {
  display: flex; flex-direction: column; gap: 5px; padding: 7px; cursor: pointer;
  border: 1px solid var(--borderColor); border-radius: 8px;
  background: var(--backgroundColor); color: var(--fontColor); font-size: 11px;
}
.ob-theme:hover { border-color: var(--fontActiveColor); }
.ob-theme.on { border-color: var(--fontActiveColor); box-shadow: 0 0 0 1px var(--fontActiveColor) inset; font-weight: 600; }
.ob-theme-swatch { display: block; height: 26px; border-radius: 5px; border: 1px solid var(--borderColor); }
.ob-theme-name { text-align: center; }
.ob-empty {
  display: flex; align-items: center; gap: 8px; padding: 14px;
  border: 1px dashed var(--borderColor); border-radius: 8px;
  font-size: 12px; opacity: .75;
}
.ob-ws-list { list-style: none; margin: 0 0 10px; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 190px; overflow: auto; }
.ob-ws {
  display: flex; align-items: center; gap: 8px; padding: 7px 9px;
  border: 1px solid var(--borderColor); border-radius: 7px; cursor: pointer; font-size: 12px;
}
.ob-ws:hover { background: color-mix(in srgb, var(--fontColor) 6%, transparent); }
.ob-ws.on { border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
.ob-ws-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.ob-ws-tag { flex-shrink: 0; font-size: 10px; opacity: .7; }
.ob-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ob-src-group + .ob-src-group { margin-top: 8px; }
.ob-src-group-title { font-size: 10px; opacity: .55; margin: 0 0 4px 2px; }
/* 配置模型页顶部的「当前来源」一行 */
.ob-picked {
  display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
  margin: 0 0 8px; padding: 7px 10px;
  border: 1px solid var(--borderColor); border-radius: 8px; background: var(--menuColor);
  font-size: 12px;
}
.ob-picked-label { font-size: 10px; opacity: .55; }
.ob-picked b { font-size: 12px; }
.ob-picked-tag { font-size: 10px; opacity: .6; margin-left: auto; }
.ob-src-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(142px, 1fr)); gap: 6px; }
.ob-src {
  display: flex; flex-direction: column; gap: 2px; align-items: flex-start; text-align: left;
  padding: 7px 9px; border: 1px solid var(--borderColor); border-radius: 7px;
  background: var(--backgroundColor); color: var(--fontColor); cursor: pointer; transition: all .15s;
}
.ob-src:hover { border-color: var(--fontActiveColor); }
.ob-src.on { border-color: var(--fontActiveColor); background: var(--menuActiveColor); color: var(--fontActiveColor); }
.ob-src-name { font-size: 12px; font-weight: 600; }
.ob-src-kind { font-size: 10px; opacity: .6; }
.ob-src.on .ob-src-kind { opacity: .8; }
/* 来源资料：本地部署下载站 / API Key 申请页（与设置页的链接同源） */
.ob-doc { border: 1px solid var(--borderColor); border-radius: 8px; padding: 9px 11px; margin: 0 0 14px; background: var(--menuColor); }
.ob-doc-hint { display: flex; gap: 7px; align-items: flex-start; font-size: 11px; line-height: 1.65; }
.ob-doc-hint > i { margin-top: 3px; color: var(--fontActiveColor); flex-shrink: 0; }
.ob-doc-links { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 7px; }
.ob-link {
  display: inline-flex; align-items: center; gap: 3px; padding: 0; border: none; background: none;
  cursor: pointer; color: var(--fontActiveColor); font-size: 11px;
}
.ob-link:hover { text-decoration: underline; }
.ob-link i { font-size: 10px; }
.ob-source { border: 1px solid var(--borderColor); border-radius: 9px; padding: 12px 14px; margin-bottom: 14px; }
.ob-source-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
.ob-source-name { font-size: 13px; font-weight: 600; }
.ob-badge { font-size: 10px; padding: 2px 8px; border-radius: 20px; }
.ob-badge.ok { background: color-mix(in srgb, #2da44e 18%, transparent); color: #2da44e; }
.ob-badge.warn { background: color-mix(in srgb, #bf8700 18%, transparent); color: #bf8700; }
.ob-kv { margin: 0 0 12px; display: flex; flex-direction: column; gap: 5px; font-size: 11px; }
.ob-kv > div { display: flex; gap: 8px; }
.ob-kv dt { width: 52px; flex-shrink: 0; opacity: .6; margin: 0; }
.ob-kv dd { margin: 0; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ob-note { font-size: 11px; opacity: .8; }
.ob-note.ok { color: #2da44e; opacity: 1; }
.ob-note.fail { color: #cf222e; opacity: 1; }
.ob-hint { display: flex; gap: 7px; align-items: flex-start; font-size: 11px; line-height: 1.65; opacity: .7; margin: 10px 0 0; }
.ob-hint i { margin-top: 3px; flex-shrink: 0; }
.ob-summary { list-style: none; margin: 2px 0 16px; padding: 0; display: flex; flex-direction: column; gap: 7px; }
.ob-summary li { display: flex; align-items: center; gap: 9px; font-size: 12px; }
.ob-summary b { flex-shrink: 0; min-width: 84px; }
.ob-summary span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .75; }
.ob-summary .ok { color: #2da44e; }
.ob-summary .warn { color: #bf8700; }
.ob-tips { display: flex; flex-direction: column; gap: 8px; }
.ob-tip { display: flex; gap: 10px; padding: 9px 11px; border: 1px solid var(--borderColor); border-radius: 8px; }
.ob-tip > i { color: var(--fontActiveColor); margin-top: 2px; }
.ob-tip b { display: block; font-size: 12px; margin-bottom: 2px; }
.ob-tip span { font-size: 11px; line-height: 1.6; opacity: .7; }
.ob-foot { display: flex; align-items: center; gap: 8px; padding: 12px 24px; border-top: 1px solid var(--borderColor); }
.ob-spacer { flex: 1; }
.ob-btn {
  display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 14px;
  border: 1px solid var(--borderColor); border-radius: 7px; cursor: pointer;
  background: var(--backgroundColor); color: var(--fontColor); font-size: 12px;
  transition: all .15s;
}
.ob-btn:hover { border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
.ob-btn:disabled { opacity: .6; cursor: default; }
.ob-btn.primary { background: var(--fontActiveColor); border-color: var(--fontActiveColor); color: var(--backgroundColor); }
.ob-btn.primary:hover { opacity: .9; color: var(--backgroundColor); }
.ob-btn.ghost { border-color: transparent; background: transparent; opacity: .7; }
.ob-btn.ghost:hover { opacity: 1; background: transparent; }

/* ====== 竖屏 / 手机 / 细长窗口：卡片改成上下结构，步骤条横向可滑动 ====== */
@media (max-width: 780px), (orientation: portrait) {
  .ob-overlay { padding: 8px; align-items: stretch; }
  .ob-card { width: 100%; height: 100%; max-height: none; flex-direction: column; border-radius: 12px; }
  .ob-rail {
    width: auto; flex-shrink: 0; flex-direction: row; align-items: center; gap: 10px;
    padding: 9px 12px; border-right: 0; border-bottom: 1px solid var(--borderColor);
  }
  .ob-brand { margin: 0; flex-shrink: 0; }
  .ob-brand-icon { width: 26px; height: 26px; font-size: 12px; border-radius: 7px; }
  .ob-brand-text span { display: none; }
  .ob-steps { flex-direction: row; gap: 4px; margin-left: auto; overflow-x: auto; }
  .ob-step { padding: 4px 8px; font-size: 11px; white-space: nowrap; }
  .ob-step-label { display: none; }            /* 竖屏只留序号，省高度 */
  .ob-step.active .ob-step-label { display: inline; }
  .ob-rail-foot { display: none; }
  .ob-head { padding: 12px 14px 6px; }
  .ob-head h2 { font-size: 15px; }
  .ob-head p { font-size: 11px; line-height: 1.55; }
  .ob-body { padding: 4px 14px 10px; }
  .ob-foot { padding: 9px 14px; }
  .ob-themes { grid-template-columns: repeat(auto-fill, minmax(78px, 1fr)); }
  .ob-grid2 { grid-template-columns: 1fr; }     /* 竖屏输入框单列，避免挤压 */
  .ob-src-grid { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); }
  .ob-select.narrow { max-width: none; }
}
/* 宽窗口但高度很矮（小笔记本横屏）：压缩纵向间距 */
@media (max-height: 640px) and (min-width: 781px) {
  .ob-head { padding: 12px 20px 6px; }
  .ob-body { padding: 2px 20px 8px; }
  .ob-foot { padding: 8px 20px; }
}
</style>
