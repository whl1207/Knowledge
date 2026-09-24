<!-- ModelContextWindow.vue - 模型来源「上下文窗口」行（各来源配置块复用）
     整行只读展示：该模型的上下文窗口（= 主页右上角圆环的分母）+ 历史手动覆盖值。
     本页不提供修改入口；刷新入口已统一到各来源配置块底部的「API 状态」按钮（通过 refreshToken 触发重探）。
     hideWindow=true 时只隐藏「上下文窗口」行（组件仍挂载 → 探测与圆环分母继续更新），
     用于本地来源（Ollama / LM Studio）已有「模型加载状态」面板展示生效/上限的场景。

     自动判定优先级见 @/lib/contextUsage.resolveContextLimit：
       已加载实例实际值 > 上次读到的实际值 > 模型上限 > 模型名/来源默认值 > 未知兜底

     说明（实测 Ollama 0.34）：Ollama 桌面端「上下文长度」不在 Modelfile 里，也没有公开 HTTP 接口可读，
     只体现在「已加载实例」的 /api/ps 上 → 在块底部点一次「API 状态」即可重新读取，
     读到「实际生效值」会自动记住（跨会话），主页圆环的分母即以此为据。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { usestore } from '@/store'
import { AIUtils } from '@/services/ai-utils'
import {
  contextWindowKey,
  manualContextWindow,
  probedContextWindow,
  rememberProbedContextWindow,
  resolveContextLimit,
  realContextWindowCacheKey,
  getCachedRealContextWindow,
  getCachedLoadedContextWindow,
  hasProbedRealContextWindow,
  setCachedRealContextWindow,
} from '@/lib/contextUsage'
import { normalizeLlmType } from '@/shared/llmSources'

const props = withDefaults(defineProps<{
  /** 探测用来源键：ollama / lmstudio / openai / deepseek / anthropic / google / azure / gpustack / custom */
  provider: string
  /** 该来源的配置对象（Ollama 取 model_url、LM Studio 取 base_url） */
  config?: any
  /** 当前选择的模型标识（空 = 未选择） */
  model?: string
  /** 是否显示「窗口上限覆盖」只读行（默认显示；注意布尔 prop 缺省会被 Vue 当作 false，必须显式给默认值） */
  override?: boolean
  /** 外部刷新令牌：值变化时强制重新探测（来源配置块内的刷新按钮统一收到「API 状态」行） */
  refreshToken?: number
  /** 隐藏「上下文窗口」行（本地来源已有「模型加载状态」面板展示生效/上限时用；组件仍挂载，探测与圆环分母照常更新） */
  hideWindow?: boolean
}>(), { override: true, refreshToken: 0, hideWindow: false })

const store = usestore()
const zh = () => store.locales === 'zh'

/** 探测用来源键（单来源：历史别名 'deepseek-responses' 归一到 'deepseek'） */
const providerKey = computed(() => normalizeLlmType(props.provider))

/** 自定义来源按激活来源索引分桶（多来源各有各的窗口） */
const customIdx = computed(() => (providerKey.value === 'custom' ? (store.AIconfig.llm.custom?.activeIndex ?? 0) : undefined))
const cacheKey = computed(() => realContextWindowCacheKey(providerKey.value, props.model || '', customIdx.value))

const loading = ref(false)
/** 探测结果存在模块级 Map（非响应式）→ 用 tick 触发展示重算 */
const tick = ref(0)

/** 探测真实窗口：命中缓存直接用（refreshToken 变化 = 强制重探） */
const probe = async (force = false) => {
  const provider = providerKey.value
  const model = String(props.model || '')
  if (!provider || !model) return
  const key = cacheKey.value
  if (!force && hasProbedRealContextWindow(key)) { tick.value++; return }
  loading.value = true
  try {
    const res = await AIUtils.fetchModelContextWindowDetail(provider, props.config || {}, model)
    setCachedRealContextWindow(key, res?.limit || 0, res?.from === 'loaded')
    // 读到「已加载实例实际生效值」就记住（跨会话）：Ollama 手动设置的上下文长度只有这一刻读得到
    if (res?.from === 'loaded' && rememberProbedContextWindow(store.AIconfig.llm, key, res.limit)) store.saveConfig()
  } catch { /* 探测失败：按回退值展示 */ } finally {
    loading.value = false
    tick.value++
  }
}
watch(() => [providerKey.value, props.model], () => { void probe() }, { immediate: true })
// 外部（API 状态按钮）要求刷新时强制重探一遍
watch(() => props.refreshToken, () => { void probe(true) })

/** 自动判定到的窗口（不含手填覆盖，覆盖单独一行） */
const auto = computed(() => {
  void tick.value
  return resolveContextLimit({
    manual: 0,
    realLoaded: getCachedLoadedContextWindow(cacheKey.value),
    probed: probedContextWindow(store.AIconfig.llm, cacheKey.value),
    real: getCachedRealContextWindow(cacheKey.value),
    provider: providerKey.value,
    model: props.model,
  })
})

const sourceLabel = computed(() => {
  switch (auto.value.source) {
    case 'real': return zh() ? '模型实际 context' : 'model context'
    case 'probed': return zh() ? '上次读到的实际值' : 'last seen actual'
    case 'model-default': return zh() ? '模型上限' : 'model max'
    case 'model-name': return zh() ? '模型名默认值' : 'model-name default'
    case 'provider-default': return zh() ? '来源默认值' : 'provider default'
    default: return zh() ? '未知来源，按 128K 估算' : 'unknown, assumed 128K'
  }
})

/** 圆环实际使用的分母（手动覆盖优先），没有覆盖时就是自动判定值 */
const displayText = computed(() => {
  if (!props.model) return zh() ? '未选择模型' : 'No model selected'
  // 展示行只留数值：来源（模型上限 / 模型名默认值 / 上次读到的实际值…）与判定依据放 title
  const n = manualValue.value > 0 ? manualValue.value : auto.value.limit
  return `${n.toLocaleString()} tokens`
})

const title = computed(() => {
  if (!props.model) return zh() ? '先选择模型，再查看其上下文窗口' : 'Select a model first'
  const how: Record<string, string> = {
    real: '来自后端「已加载实例」的真实值（Ollama /api/ps、LM Studio loaded_context_length），已包含在 Ollama 侧手动设置的上下文长度',
    probed: '模型当前未加载，读不到实时值 → 用上次实际读到的值',
    'model-default': '模型能力上限（模型未加载时只能读到它；也可能与手动设置的实际生效值不同）',
    'model-name': '按模型名推断的默认窗口（该来源不提供可读的窗口信息）',
    'provider-default': '该来源不提供可读的窗口信息 → 按来源默认值估算',
    unknown: '无法判定来源与模型 → 按 128K 估算',
  }
  const howEn: Record<string, string> = {
    real: 'From the loaded backend instance (Ollama /api/ps, LM Studio loaded_context_length); includes the context length set manually in Ollama',
    probed: 'Model not loaded, no live value → using the last value actually read',
    'model-default': 'Model capability max (all that is readable while the model is unloaded; may differ from the effective value)',
    'model-name': 'Window inferred from the model name (this source exposes no readable window info)',
    'provider-default': 'This source exposes no window info → estimated from the provider default',
    unknown: 'Unknown source/model → assumed 128K',
  }
  const zhText = zh()
  const lines: string[] = []
  const manual = manualValue.value
  if (manual > 0) {
    lines.push(zhText
      ? `当前生效：${manual.toLocaleString()} tokens（手动覆盖）`
      : `Effective: ${manual.toLocaleString()} tokens (manual override)`)
    lines.push(zhText
      ? `自动判定为 ${auto.value.limit.toLocaleString()} tokens（${sourceLabel.value}）`
      : `Auto-detected: ${auto.value.limit.toLocaleString()} tokens (${sourceLabel.value})`)
  } else {
    lines.push(zhText
      ? `当前生效：${auto.value.limit.toLocaleString()} tokens（${sourceLabel.value}）`
      : `Effective: ${auto.value.limit.toLocaleString()} tokens (${sourceLabel.value})`)
  }
  lines.push(zhText ? (how[auto.value.source] || '') : (howEn[auto.value.source] || ''))
  lines.push(zhText
    ? '主页右上角圆环即以此为分母；在下方「API 状态」点一次即可重新读取。'
    : 'Used as the denominator of the context ring on the home page; click the API Status button below to re-read.')
  return lines.filter(Boolean).join('\n')
})

/** 手填覆盖值（0 = 不覆盖）：按来源分别保存，只影响该来源。
    本页只读展示（不允许在设置页现场改），仅在历史设置迁移过值时才可能非 0。 */
const manualValue = computed(() => manualContextWindow(store.AIconfig.llm, providerKey.value, customIdx.value))

/** 清除该来源的覆盖值（回到自动）——只在确实存在覆盖值时提供 */
const clearOverride = () => {
  const llm: any = store.AIconfig.llm
  const byProvider: Record<string, number> = { ...(llm.contextWindowByProvider || {}) }
  delete byProvider[contextWindowKey(providerKey.value, customIdx.value)]
  llm.contextWindowByProvider = byProvider
  store.saveConfig()
}

/** 覆盖行展示文本（只读）：也只留数值/无，说明放 title */
const overrideText = computed(() => {
  const m = manualValue.value
  return m > 0 ? `${m.toLocaleString()} tokens` : (zh() ? '无' : 'None')
})

const overrideTitle = computed(() => {
  const autoN = auto.value.limit.toLocaleString()
  const head = manualValue.value > 0
    ? (zh() ? `该来源存在手动覆盖值：圆环以它为分母（只读展示）。` : `A manual override exists for this source: the ring uses it (read-only).`)
    : (zh() ? `该来源未设置覆盖值，圆环直接用上方「上下文窗口」的自动判定值（当前 ${autoN}）。` : `No override for this source: the ring uses the auto value above (currently ${autoN}).`)
  const tail = zh()
    ? '上下文窗口由后端 / LM Studio / Ollama 设置决定，此页仅展示，不提供修改入口；改完后在下方「API 状态」点一次即可重新读取。'
    : 'The context window is decided by the backend / LM Studio / Ollama settings; this page only displays it. After changing it, click the API Status button below once.'
  return `${head}\n${tail}`
})

const clearOverrideTitle = computed(() => (zh()
  ? '清除该来源的历史覆盖值（回到自动判定）'
  : 'Clear the historical override for this source (back to auto)'))
</script>

<template>
  <!-- hideWindow：本地来源（Ollama / LM Studio）已在「模型加载状态」面板展示生效/上限，避免重复；
       组件仍挂载，因此探测与圆环分母照常更新 -->
  <div v-if="!hideWindow" class="form-group">
    <label>{{ zh() ? '上下文窗口' : 'Context Window' }}</label>
    <div class="input-with-button">
      <input class="ctx-window-value" type="text" readonly :value="displayText" :title="title" />
    </div>
  </div>
  <!-- 窗口上限覆盖：仅在确实存在历史覆盖值时才显示（用于清除），否则整行不出现 -->
  <div v-if="override !== false && manualValue > 0" class="form-group">
    <label>{{ zh() ? '窗口上限覆盖' : 'Window Limit Override' }}</label>
    <div class="input-with-button">
      <input class="ctx-window-value" type="text" readonly :value="overrideText" :title="overrideTitle" />
      <div v-if="manualValue > 0" class="button" style="width:30px;margin:0px;padding:4px 0px"
        @click="clearOverride" :title="clearOverrideTitle">
        <i class="fa fa-times"></i>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 父组件 LlmSettings 的样式是 scoped，且本组件为多根（fragment）——父级规则到不了组件内部，
   所以这里复刻一层同样的行布局，保证与「服务地址 / 模型名称」等行的观感、行高完全一致。
   改父级 .llm-content .form-group 的布局时，这里要同步。 */
.form-group {
  display: flex; align-items: center; gap: 8px;
  flex-wrap: nowrap; white-space: nowrap;
  margin-bottom: 0;
}
.form-group > * { margin: 0; }
.form-group > label {
  flex-shrink: 0; width: auto; min-width: 95px;
  text-align: right; font-size: 12px; line-height: 1;
}
.form-group > label::after { content: '：'; }
.form-group > input,
.form-group > .input-with-button { flex: 1; min-width: 0; }
.input-with-button { display: flex; align-items: stretch; gap: 4px; min-width: 0; margin: 0; }
.input-with-button > input { flex: 1; min-width: 0; margin: 0; }
.input-with-button > .button {
  flex-shrink: 0; height: auto; align-self: stretch;
  display: inline-flex; align-items: center; justify-content: center;
  min-height: 0; padding: 0 6px; margin: 0;
}
/* 只读展示值：不改配色（与其它输入框一致），仅鼠标指针不暗示可编辑 */
.input-with-button > input.ctx-window-value { cursor: default; }
@media (max-width: 620px) {
  .form-group { flex-wrap: wrap; }
  .form-group > label { width: 100%; min-width: 0; text-align: left; }
  .form-group > label::after { content: ''; }
  .form-group > input,
  .form-group > .input-with-button { width: 100%; flex-basis: 100%; }
}
</style>
