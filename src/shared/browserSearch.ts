/**
 * src/shared/browserSearch.ts
 * 浏览器 Agent「地址栏搜索」统一配置：
 *   新标签页不再自带搜索框，搜索栏并入地址栏（输入网址直接打开，输入关键词用所选引擎搜索）。
 *   这里维护引擎表 + 搜索 URL 模板解析，供浏览器窗口（BrowserAgentShell）与设置面板
 *   （BrowserSettingsPanel）共用，避免两处各写一份引擎清单而对不上。
 */

/** 地址栏搜索引擎标识（custom=自定义 URL 模板） */
export type BrowserSearchEngineId = 'bing' | 'google' | 'baidu' | 'sogou' | 'duckduckgo' | 'custom'

export interface BrowserSearchEngine {
  id: BrowserSearchEngineId
  labelZh: string
  labelEn: string
  /** 默认搜索 URL 模板（{q} 为关键词占位符） */
  template: string
}

/** 内置引擎表（顺序即设置面板下拉顺序；默认第一项 Bing） */
export const BROWSER_SEARCH_ENGINES: BrowserSearchEngine[] = [
  { id: 'bing', labelZh: '必应 Bing', labelEn: 'Bing', template: 'https://www.bing.com/search?q={q}' },
  { id: 'google', labelZh: 'Google', labelEn: 'Google', template: 'https://www.google.com/search?q={q}' },
  { id: 'baidu', labelZh: '百度', labelEn: 'Baidu', template: 'https://www.baidu.com/s?wd={q}' },
  { id: 'sogou', labelZh: '搜狗', labelEn: 'Sogou', template: 'https://www.sogou.com/web?query={q}' },
  { id: 'duckduckgo', labelZh: 'DuckDuckGo', labelEn: 'DuckDuckGo', template: 'https://duckduckgo.com/?q={q}' },
  { id: 'custom', labelZh: '自定义模板', labelEn: 'Custom template', template: '' },
]

export const DEFAULT_BROWSER_SEARCH_ENGINE: BrowserSearchEngineId = 'bing'

/** 自定义模板占位符（兼容 {q} 与 {query}；两者都缺省时按 …?q= 追加） */
const TEMPLATE_PLACEHOLDER = /\{(?:q|query)\}/i

/** 把任意存档值归一化为合法引擎 id（未知 → 默认 Bing） */
export function normalizeSearchEngine(v: unknown): BrowserSearchEngineId {
  const id = String(v ?? '') as BrowserSearchEngineId
  return BROWSER_SEARCH_ENGINES.some(e => e.id === id) ? id : DEFAULT_BROWSER_SEARCH_ENGINE
}

/** 取引擎定义（未知 id 回退默认引擎，保证设置面板/地址栏始终有可用项） */
export function browserSearchEngine(id: unknown): BrowserSearchEngine {
  const nid = normalizeSearchEngine(id)
  return BROWSER_SEARCH_ENGINES.find(e => e.id === nid) || BROWSER_SEARCH_ENGINES[0]
}

/** 引擎显示名（bilingual） */
export function browserSearchEngineLabel(id: unknown, zh: boolean): string {
  const e = browserSearchEngine(id)
  return zh ? e.labelZh : e.labelEn
}

/**
 * 关键词 → 搜索 URL。
 * engineId=custom 时用 customTemplate；模板非法（无 scheme / 无占位符）时回退默认 Bing，避免地址栏回车无反应。
 */
export function buildBrowserSearchUrl(query: string, engineId: unknown, customTemplate?: string): string {
  const q = String(query ?? '').trim()
  const enc = encodeURIComponent(q)
  const id = normalizeSearchEngine(engineId)
  let tpl = ''
  if (id === 'custom') tpl = String(customTemplate ?? '').trim()
  else tpl = browserSearchEngine(id).template
  if (tpl && /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(tpl)) {
    if (TEMPLATE_PLACEHOLDER.test(tpl)) return tpl.replace(new RegExp(TEMPLATE_PLACEHOLDER.source, 'gi'), enc)
    return tpl + (tpl.includes('?') ? '&' : '?') + 'q=' + enc
  }
  return BROWSER_SEARCH_ENGINES[0].template.replace('{q}', enc)
}
