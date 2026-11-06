<!-- ModelContextWindow.vue - 模型来源「上下文窗口」行（各来源配置块复用）
     一行可编辑的窗口值：输入框里就是圆环实际使用的分母（= 主页右上角圆环的分母）。
     留空 / 保持自动值 = 用自动判定结果；直接改成别的数字 = 为该来源手填覆盖（再点 ✕ 回到自动）。
     hideWindow=true 时只隐藏「上下文窗口」行（组件仍挂载 → 探测与圆环分母继续更新），
     用于本地来源（Ollama / LM Studio）已有「模型加载状态」面板展示生效/上限的场景。

     自动判定优先级见 @/lib/contextUsage.resolveContextLimit：
       已加载实例实际值 > 上次读到的实际值 > 模型上限 > 模型标称窗口 > 来源默认值 > 未知兜底

     说明（实测 Ollama 0.34）：Ollama 桌面端「上下文长度」不在 Modelfile 里，也没有公开 HTTP 接口可读，
     只体现在「已加载实例」的 /api/ps 上 → 在块底部点一次「API 状态」即可重新读取，
     读到「实际生效值」会自动记住（跨会话），主页圆环的分母即以此为据。
     DeepSeek 官方 /models 不返回窗口字段，因此按「DeepSeek 官方模型标称 1M」展示；
     兼容网关若返回 context_length，会以探测到的真实值为准。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { usestore } from '@/store'
import { AIUtils } from '@/services/ai-utils'
import {
  contextWindowKey,
  customManualKeyById,
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
import { compactThresholdTokens } from '@/shared/contextBudget'
import { normalizeLlmType } from '@/shared/llmSources'

const props = withDefaults(defineProps<{
  /** 探测用来源键：ollama / lmstudio / openai / deepseek / anthropic / google / azure / gpustack / custom */
  provider: string
  /** 该来源的配置对象（Ollama 取 model_url、LM Studio 取 base_url） */
  config?: any
  /** 当前选择的模型标识（空 = 未选择） */
  model?: string
  /** 外部刷新令牌：值变化时强制重新探测（来源配置块内的刷新按钮统一收到「API 状态」行） */
  refreshToken?: number
  /** 隐藏「上下文窗口」行（本地来源已有「模型加载状态」面板展示生效/上限时用；组件仍挂载，探测与圆环分母照常更新） */
  hideWindow?: boolean
  /** 自定义来源：正在查看的来源索引（不传则用默认/激活来源） */
  customIndex?: number
}>(), { refreshToken: 0, hideWindow: false, customIndex: undefined })

const store = usestore()
const zh = () => store.locales === 'zh'

/** 探测用来源键（单来源：历史别名 'deepseek-responses' 归一到 'deepseek'） */
const providerKey = computed(() => normalizeLlmType(props.provider))

/** 自定义来源按来源索引分桶（多来源各有各的窗口；优先用「正在查看」的索引） */
const customIdx = computed(() => (providerKey.value === 'custom'
  ? (typeof props.customIndex === 'number' ? props.customIndex : (store.AIconfig.llm.custom?.activeIndex ?? 0))
  : undefined))
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

/** 自动判定到的窗口（不含手填覆盖；覆盖值在输入框里单独标注「手动」） */
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
    case 'model-name': return zh() ? '模型标称窗口' : 'model rated window'
    case 'provider-default': return zh() ? '来源默认窗口' : 'provider default'
    default: return zh() ? '未知来源，按 128K 估算' : 'unknown, assumed 128K'
  }
})

const title = computed(() => {
  if (!props.model) return zh() ? '先选择模型，再查看其上下文窗口' : 'Select a model first'
  const how: Record<string, string> = {
    real: '来自后端「已加载实例」的真实值（Ollama /api/ps、LM Studio loaded_context_length），已包含在 Ollama 侧手动设置的上下文长度',
    probed: '模型当前未加载，读不到实时值 → 用上次实际读到的值',
    'model-default': '模型能力上限（模型未加载时只能读到它；也可能与手动设置的实际生效值不同）',
    'model-name': '按模型名从已知模型表取到的标称窗口（该来源的接口不返回窗口信息）',
    'provider-default': '该来源不提供可读的窗口信息 → 按来源默认值估算',
    unknown: '无法判定来源与模型 → 按 128K 估算',
  }
  const howEn: Record<string, string> = {
    real: 'From the loaded backend instance (Ollama /api/ps, LM Studio loaded_context_length); includes the context length set manually in Ollama',
    probed: 'Model not loaded, no live value → using the last value actually read',
    'model-default': 'Model capability max (all that is readable while the model is unloaded; may differ from the effective value)',
    'model-name': 'Rated window from the known model table (this source exposes no readable window info)',
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
  // DeepSeek 官方 /models 不带窗口字段：显式说明 1M 是官方标称值，避免被当成「没读到」
  if (providerKey.value === 'deepseek' && !manual) {
    lines.push(zhText
      ? 'DeepSeek 官方模型标称 1M 窗口；其 /models 不返回窗口字段，因此按模型标称值显示（不是探测失败）。'
      : 'Official DeepSeek models are rated at 1M; its /models returns no window field, so the rated value is shown (not a failed probe).')
  }
  // 压缩阈值：占用（历史 + 工具 schema，不含输出预留）达到它就压缩旧轮次——不是等到窗口上限才动。
  // 用户看到的「明明几十万窗口，九万就压缩」多数就是把这行和上面的窗口上限混为一谈了。
  const effLimit = manual > 0 ? manual : auto.value.limit
  const compactAt = compactThresholdTokens({ limit: effLimit })
  lines.push(zhText
    ? `自动压缩阈值：约 ${compactAt.toLocaleString()} tokens（占用达到它就摘要旧轮次；窗口 ${effLimit.toLocaleString()} 是硬上限，不是压缩线）`
    : `Auto-compaction at about ${compactAt.toLocaleString()} tokens (old turns are summarized there; the ${effLimit.toLocaleString()} window is the hard limit, not the compaction line)`)
  lines.push(zhText
    ? '输入框里的数字就是当前生效值：改成别的数字 = 为这个来源手填覆盖（✕ 清除），清空 = 自动判定。在下方「API 状态」点一次即可重新读取。'
    : 'The number in the field is the effective value: type another number to override this source (✕ clears), clear it for auto. Click API Status below to re-read.')
  return lines.filter(Boolean).join('\n')
})

/** 手填覆盖值（0 = 不覆盖）：按来源分别保存，只影响该来源。
    自动探测不到或需要强制指定时，可直接在「上下文窗口」输入框填写。 */
const manualValue = computed(() => manualContextWindow(store.AIconfig.llm, providerKey.value, customIdx.value))

/** 手填值要写的键：自定义来源同时写「按来源 id」与「按索引」
 *  —— 旧读取路径仍只认索引键，id 键让来源增删/排序后手填值不失效 */
const manualKeys = (): string[] => {
  const keys = [contextWindowKey(providerKey.value, customIdx.value)]
  if (providerKey.value === 'custom') {
    const srcs = Array.isArray(store.AIconfig.llm.custom?.sources) ? store.AIconfig.llm.custom.sources : []
    const idx = typeof customIdx.value === 'number' ? customIdx.value : (store.AIconfig.llm.custom?.activeIndex ?? 0)
    const id = srcs[idx]?.id
    if (typeof id === 'number') keys.push(customManualKeyById(id))
  }
  return keys
}

/**
 * 输入框改动：填入别的数字 = 为该来源写入手动覆盖；清空（或恰好等于自动判定值）= 恢复自动。
 *
 * 输入框里默认显示的就是自动判定值（= 圆环分母），所以「点进去没改就失焦」不应该把自动值
 * 钉成覆盖值——否则换了模型 / 本地窗口变了，这个来源还卡在旧数字上。
 */
const onManualInput = (e: Event) => {
  const input = e.target as HTMLInputElement
  const n = Math.round(Number(input?.value))
  const autoN = auto.value.limit
  const useAuto = !(Number.isFinite(n) && n > 0) || n === autoN
  const llm: any = store.AIconfig.llm
  const byProvider: Record<string, number> = { ...(llm.contextWindowByProvider || {}) }
  const keys = manualKeys()
  if (useAuto) for (const k of keys) delete byProvider[k]
  else for (const k of keys) byProvider[k] = n
  llm.contextWindowByProvider = byProvider
  store.saveConfig()
  // 清空 / 输成自动值后，输入框要重新显示自动判定值（Vue 的 :value 在数据未变时不会回写）
  if (input && useAuto) input.value = String(autoN)
}

/** 清除该来源的覆盖值（回到自动） */
const clearOverride = () => {
  const llm: any = store.AIconfig.llm
  const byProvider: Record<string, number> = { ...(llm.contextWindowByProvider || {}) }
  for (const k of manualKeys()) delete byProvider[k]
  llm.contextWindowByProvider = byProvider
  store.saveConfig()
}

const clearOverrideTitle = computed(() => (zh()
  ? '清除该来源的手填覆盖值（回到自动判定）'
  : 'Clear the manual override for this source (back to auto)'))
</script>

<template>
  <!-- hideWindow：本地来源（Ollama / LM Studio）已在「模型加载状态」面板展示生效/上限，避免重复；
       组件仍挂载，因此探测与圆环分母照常更新 -->
  <div v-if="!hideWindow" class="form-group">
    <label>{{ zh() ? '上下文窗口' : 'Context Window' }}</label>
    <div class="input-with-button">
      <!-- 直接显示当前生效值（自动判定值或手填覆盖值）；改成别的数字即覆盖，留空即自动 -->
      <input
        class="ctx-window-value"
        type="number"
        min="1"
        step="1"
        :value="manualValue > 0 ? manualValue : auto.limit"
        :title="title"
        @change="onManualInput"
      />
      <span class="ctx-window-unit">
        tokens<span class="ctx-window-mode">{{ manualValue > 0 ? (zh() ? ' · 手动' : ' · manual') : (zh() ? ' · 自动' : ' · auto') }}</span>
      </span>
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
/* 可编辑值：显示当前生效值；改成别的数字 = 手填覆盖，清空 = 自动 */
.input-with-button > input.ctx-window-value { cursor: text; }
.ctx-window-unit { flex-shrink: 0; align-self: center; font-size: 11px; opacity: .55; }
@media (max-width: 620px) {
  .form-group { flex-wrap: wrap; }
  .form-group > label { width: 100%; min-width: 0; text-align: left; }
  .form-group > label::after { content: ''; }
  .form-group > input,
  .form-group > .input-with-button { width: 100%; flex-basis: 100%; }
}
</style>
