/**
 * locale.ts — 插件文案服务（P2 服务化）
 *
 * 让插件用**中英双语字典**写文案，而不是到处写 `zh ? '中文' : 'English'`。
 * 与仓库其它模块的约定一致：语言取 `store.locales`（'zh' | 'en'）。
 *
 * 两种用法：
 * - 响应式（推荐，切语言自动重渲染）：`const L = ctx.locale.pick(dict)` → `L.value.title`
 * - 一次性：`ctx.locale.t(dict, 'title', { name })`
 *
 * 纯逻辑部分（`pickDict` / `interpolate`）不依赖 vue，便于单测。
 */

import { computed, type ComputedRef } from 'vue'

export type PluginLanguage = 'zh' | 'en'

/** 插件文案字典：`zh` 必填（缺省语言），`en` 缺省时回退 `zh` */
export interface PluginLocaleDict {
  zh: Record<string, string>
  en?: Record<string, string>
}

/** 取当前语言对应的整表（`en` 缺失或缺某键时逐项回退中文） */
export function pickDict(dict: PluginLocaleDict, language: string): Record<string, string> {
  const zh = dict?.zh ?? {}
  if (language !== 'en') return { ...zh }
  const en = dict?.en ?? {}
  return { ...zh, ...en }
}

/** 插值：把 `{{name}}` 换成参数值（缺参数时保留原样，便于发现遗漏） */
export function interpolate(text: string, params?: Record<string, string | number>): string {
  if (!params) return text
  return String(text).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (all, key: string) =>
    key in params ? String(params[key]) : all,
  )
}

export type PluginTranslateFn = (key: string, params?: Record<string, string | number>) => string

export interface PluginLocaleApi {
  /** 当前语言（非响应式；需要响应式用 languageRef） */
  readonly language: PluginLanguage
  /** 当前语言（响应式） */
  readonly languageRef: ComputedRef<PluginLanguage>
  /** 一次性翻译（内部按当前语言取表） */
  t(dict: PluginLocaleDict, key: string, params?: Record<string, string | number>): string
  /** 整表（响应式）：切语言时自动更新 */
  pick(dict: PluginLocaleDict): ComputedRef<Record<string, string>>
  /** 单条（响应式） */
  ref(dict: PluginLocaleDict, key: string): ComputedRef<string>
  /** 固定为某语言取词（用于生成日志 / 导出等非 UI 场景） */
  fixed(dict: PluginLocaleDict, language: PluginLanguage): PluginTranslateFn
}

/** 构造文案服务（语言来源由宿主注入，便于非窗口环境复用与测试） */
export function createPluginLocaleApi(options: { getLanguage: () => string }): PluginLocaleApi {
  const normalize = (raw: string): PluginLanguage => (raw === 'en' ? 'en' : 'zh')
  const languageRef = computed<PluginLanguage>(() => normalize(options.getLanguage()))

  const fixed = (dict: PluginLocaleDict, language: PluginLanguage): PluginTranslateFn => {
    const table = pickDict(dict, language)
    return (key, params) => interpolate(table[key] ?? key, params)
  }

  return {
    get language() {
      return normalize(options.getLanguage())
    },
    languageRef,
    t: (dict, key, params) => fixed(dict, normalize(options.getLanguage()))(key, params),
    pick: (dict) => computed(() => pickDict(dict, languageRef.value)),
    ref: (dict, key) => computed(() => pickDict(dict, languageRef.value)[key] ?? key),
    fixed,
  }
}
