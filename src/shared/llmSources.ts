// src/shared/llmSources.ts
// DeepSeek 单来源 + 接口样式（api_style）统一解析与迁移
//
// 背景：历史上 DeepSeek 是**两个并列来源**（deepseek / deepseek-responses），设置页虽已
// 合并为一个「DeepSeek」条目，但其它模块的下拉、类型联合、存档仍按两个 provider 处理，
// 于是「DeepSeek Responses」会作为独立来源反复出现（初始化后尤其明显）。
//
// 这里把 DeepSeek 收敛为**单一来源**：
//   - 唯一来源键：'deepseek'
//   - 接口样式：llm.deepseek.api_style = 'chat' | 'responses'（唯一事实源）
//   - 'deepseek-responses' 仅作**历史存档/调用的输入别名**，读到即归一到上面两者
//
// 说明：llm.deepseekResponses 仍保留为「Responses 样式的凭据/模型记忆块」——两套密钥、
// 模型与可用模型列表不丢；设置页切换接口样式时由 deepSeekConfigForStyle 互相借用缺失字段。
// 本模块不依赖 Vue / DOM，可在渲染进程与主进程共用。

/** DeepSeek 接口样式：chat=Chat Completions（默认） / responses=Responses API */
export type DeepSeekApiStyle = 'chat' | 'responses'

/** 历史遗留的 DeepSeek Responses 来源键（已合并进 deepseek，仅作输入别名） */
export const DEEPSEEK_LEGACY_TYPE = 'deepseek-responses'

/** 内置来源键（不含已合并的 deepseek-responses；custom 由 UI 按来源条目展开） */
export const LLM_SOURCE_KEYS = [
  'ollama', 'lmstudio', 'openai', 'deepseek', 'gpustack',
  'anthropic', 'google', 'azure', 'custom',
]

/** 历史别名 → 现来源键（'deepseek-responses' → 'deepseek'，其余原样） */
export function normalizeLlmType(type?: string | null): string {
  const t = String(type ?? '').trim()
  return t === DEEPSEEK_LEGACY_TYPE ? 'deepseek' : t
}

/**
 * 归一来源键列表：合并历史别名并去重（保序）。
 * 用于 llm.types 与各处硬编码来源清单，保证列表里不再出现 'deepseek-responses'。
 */
export function normalizeLlmTypeList(list?: string[] | null): string[] {
  const out: string[] = []
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw !== 'string') continue
    const t = normalizeLlmType(raw)
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

/** 当前配置的 DeepSeek 接口样式（唯一事实源：llm.deepseek.api_style） */
export function deepSeekApiStyle(llm: any): DeepSeekApiStyle {
  return llm?.deepseek?.api_style === 'responses' ? 'responses' : 'chat'
}

/**
 * 来源键 / 请求配置 → 是否走 Responses 接口样式。
 * 兼容历史别名：provider 传 'deepseek-responses' 时一律按 responses 处理。
 */
export function deepSeekStyleOf(type: string | null | undefined, config?: any): DeepSeekApiStyle {
  if (String(type ?? '') === DEEPSEEK_LEGACY_TYPE) return 'responses'
  if (normalizeLlmType(type) !== 'deepseek') return 'chat'
  return config?.api_style === 'responses' ? 'responses' : 'chat'
}

/** 取某接口样式对应的配置块（缺失的密钥/凭据/地址从另一侧借用，避免切样式后凭据丢失） */
export function deepSeekConfigForStyle(llm: any, style: DeepSeekApiStyle): any {
  const own = (style === 'responses' ? llm?.deepseekResponses : llm?.deepseek) || {}
  const other = (style === 'responses' ? llm?.deepseek : llm?.deepseekResponses) || {}
  return {
    ...own,
    api_key: own.api_key || other.api_key || '',
    apiKeyRef: own.apiKeyRef || other.apiKeyRef || '',
    base_url: own.base_url || other.base_url || 'https://api.deepseek.com',
    api_style: style,
  }
}

/** 当前生效的 DeepSeek 配置（带 api_style 标记，供请求分流） */
export function deepSeekConfig(llm: any): any {
  return deepSeekConfigForStyle(llm, deepSeekApiStyle(llm))
}

/** 取当前接口样式下生效的 DeepSeek 模型名（Responses 样式用它的记忆块） */
export function deepSeekModel(llm: any): string {
  const target = deepSeekApiStyle(llm) === 'responses' ? llm?.deepseekResponses : llm?.deepseek
  return target?.model || ''
}

/** 把模型名写回当前接口样式对应的配置块（切样式后各自的模型记忆不互相覆盖） */
export function setDeepSeekModel(llm: any, model: string): void {
  const target = deepSeekApiStyle(llm) === 'responses' ? llm?.deepseekResponses : llm?.deepseek
  if (target) target.model = model
}

/**
 * 来源键 → { type, config }（单来源解析，供渲染层各 provider 组装点统一使用）：
 * - deepseek：config 为当前接口样式的配置块（含 api_style，请求层据此分流）；
 * - custom：合并激活（或指定索引）自定义来源的扁平配置；
 * - 其它：对应配置块浅拷贝。
 */
export function resolveLlmSource(
  llm: any,
  type?: string | null,
  customIndex?: number,
): { type: string; config: any } {
  const t = normalizeLlmType(type) || normalizeLlmType(llm?.type) || 'ollama'
  if (t === 'deepseek') return { type: 'deepseek', config: deepSeekConfig(llm) }
  if (t === 'custom') {
    const c = llm?.custom
    if (!c) return { type: 'custom', config: {} }
    const srcs = Array.isArray(c.sources) ? c.sources : []
    const idx = (typeof customIndex === 'number' && customIndex >= 0 && customIndex < srcs.length)
      ? customIndex
      : ((typeof c.activeIndex === 'number' && c.activeIndex >= 0 && c.activeIndex < srcs.length) ? c.activeIndex : 0)
    const src = srcs[idx]
    return { type: 'custom', config: src ? { ...c, ...src } : { ...c } }
  }
  return { type: t, config: { ...(llm?.[t] || {}) } }
}

/**
 * 一次性迁移：把「两个 DeepSeek 来源」的旧存档收敛为单一来源（幂等）。
 * 覆盖：
 *   1) 全局类型 llm.type === 'deepseek-responses' → 'deepseek' + api_style='responses'；
 *   2) llm.types 去掉历史别名（并去重）；
 *   3) llm.deepseek.api_style 缺失时兜底为 'chat'；
 *   4) 两个配置块互相补齐缺失的密钥/凭据/地址（切换样式后不丢凭据）。
 * @returns 是否发生改动（调用方据此决定是否 saveConfig）
 */
export function migrateDeepSeekMerge(llm: any): boolean {
  if (!llm) return false
  let changed = false
  const ds: any = (llm.deepseek = llm.deepseek || {})
  const dr: any = (llm.deepseekResponses = llm.deepseekResponses || {})

  if (llm.type === DEEPSEEK_LEGACY_TYPE) {
    llm.type = 'deepseek'
    ds.api_style = 'responses'
    changed = true
  } else if (ds.api_style !== 'chat' && ds.api_style !== 'responses') {
    ds.api_style = 'chat'
    changed = true
  }

  const sync = (key: string, fallback = '') => {
    if (!ds[key] && dr[key]) { ds[key] = dr[key]; changed = true }
    else if (!dr[key] && ds[key]) { dr[key] = ds[key]; changed = true }
    else if (!ds[key] && !dr[key] && fallback && !ds[key]) { ds[key] = fallback; changed = true }
  }
  sync('api_key')
  sync('apiKeyRef')
  sync('base_url', 'https://api.deepseek.com')
  sync('model', 'deepseek-flash')
  if (!Array.isArray(ds.available_models)) { ds.available_models = []; changed = true }
  if (!Array.isArray(dr.available_models)) { dr.available_models = []; changed = true }

  if (Array.isArray(llm.types)) {
    const next = normalizeLlmTypeList(llm.types)
    if (next.join('|') !== llm.types.join('|')) { llm.types = next; changed = true }
  }
  return changed
}
