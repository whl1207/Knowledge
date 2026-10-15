/**
 * webSearch.selftest.ts — 搜索源配置自测（纯计算，不联网、不依赖 Vue / Electron）
 *
 * 重点覆盖**新增 Firecrawl 源**引进来的三处风险：
 *  1. 内置清单 / 元信息 / 默认配置三张表必须同时加上它，否则设置页能列出却跑不了（或反之）；
 *  2. Firecrawl 与别的源相反——**Key 留空是合法状态**，归一化不能把它清掉、也不能要求必填；
 *  3. 旧存档（没有 firecrawl 字段、order 里没有它）必须能平滑补齐，且不打乱用户已有的排序。
 *
 * 用法（开发期）：
 *   import { runWebSearchSelfTest } from '@/shared/webSearch.selftest'
 *   console.table(runWebSearchSelfTest())
 * 或命令行：`node scripts/run-selftests.mjs webSearch`
 */

import {
  DEFAULT_WEB_SEARCH_CONFIG,
  WEB_SEARCH_PROVIDER_IDS,
  WEB_SEARCH_PROVIDERS,
  isBuiltinProviderId,
  normalizeWebSearchConfig,
  toCustomProviderId,
  webSearchProviderIcon,
  webSearchProviderMeta,
  type WebSearchConfig,
} from './webSearch'

export interface WebSearchCase {
  name: string
  ok: boolean
  detail?: string
}

export function runWebSearchSelfTest(): WebSearchCase[] {
  const cases: WebSearchCase[] = []
  const add = (name: string, ok: boolean, detail = '') => cases.push({ name, ok, detail })

  // 1. 三张表一致性：id 清单 / 元信息表 / 默认配置必须都有 firecrawl
  add('清单：firecrawl 是内置源 id', isBuiltinProviderId('firecrawl'))
  add('清单：firecrawl 在 id 列表中恰出现一次',
    WEB_SEARCH_PROVIDER_IDS.filter((id) => id === 'firecrawl').length === 1)
  add('元信息：firecrawl 有展示条目',
    WEB_SEARCH_PROVIDERS.filter((p) => p.id === 'firecrawl').length === 1)
  {
    const meta = webSearchProviderMeta('firecrawl', DEFAULT_WEB_SEARCH_CONFIG)
    add('元信息：不需要 Key（免 Key 可用）', meta.needsKey === false)
    add('元信息：不需要自建实例地址', meta.needsHost === false)
    add('元信息：不是自定义源', !meta.custom)
    add('元信息：中英文案都写了额度口径',
      meta.zh.includes('免 Key') && meta.en.includes('keyless'), `${meta.label} / ${meta.labelEn}`)
  }
  {
    const def = DEFAULT_WEB_SEARCH_CONFIG.firecrawl
    add('默认配置：firecrawl 有 apiHost 且指向官方接口',
      String(def?.apiHost || '').startsWith('https://api.firecrawl.dev'), String(def?.apiHost))
    add('默认配置：firecrawl 的 Key 默认为空', String(def?.apiKey || '') === '')
  }
  add('默认配置：出厂仍是 Bing 单源（不改变旧行为）',
    DEFAULT_WEB_SEARCH_CONFIG.providers.length === 1 && DEFAULT_WEB_SEARCH_CONFIG.providers[0] === 'bing')
  add('图标：firecrawl 有自己的图标（不是兜底放大镜）',
    webSearchProviderIcon('firecrawl') !== 'fa-search', webSearchProviderIcon('firecrawl'))

  // 2. 归一化：启用 firecrawl 能存活；留空 Key 不被清掉；条数字段照旧收敛
  {
    const cfg = normalizeWebSearchConfig({
      providers: ['firecrawl'],
      firecrawl: { apiKey: '', apiHost: 'https://api.firecrawl.dev' },
    })
    add('归一化：firecrawl 被接受为启用源',
      cfg.providers.length === 1 && cfg.providers[0] === 'firecrawl', JSON.stringify(cfg.providers))
    add('归一化：留空 Key 仍是空串（不报错、不塞占位值）',
      String(cfg.firecrawl.apiKey) === '')
    add('归一化：order 里包含 firecrawl', cfg.order.includes('firecrawl'))
  }
  {
    // 旧存档：order 只有老 9 个源、没有 firecrawl 字段
    const legacy = normalizeWebSearchConfig({
      providers: ['bing', 'duckduckgo'],
      order: ['duckduckgo', 'bing', 'baidu', 'searxng', 'bocha', 'zhipu', 'deepseek', 'tavily', 'brave'],
      maxResults: 8,
    })
    add('迁移：旧存档原样保留用户排序（前两位不变）',
      legacy.order[0] === 'duckduckgo' && legacy.order[1] === 'bing', legacy.order.slice(0, 3).join(' > '))
    add('迁移：新增的 firecrawl 被补进 order（不会丢失）', legacy.order.includes('firecrawl'))
    add('迁移：补进来的 firecrawl 排在老源之后（不打乱旧列表）',
      legacy.order.indexOf('firecrawl') >= 9, String(legacy.order.indexOf('firecrawl')))
    add('迁移：补进来的 firecrawl 默认**未启用**',
      !legacy.providers.includes('firecrawl'), JSON.stringify(legacy.providers))
    add('迁移：老字段 firecrawl 缺失时取到默认 apiHost',
      legacy.firecrawl.apiHost === 'https://api.firecrawl.dev', String(legacy.firecrawl.apiHost))
  }
  {
    // 自定义源仍与内置源共用 order/providers（新源不能把这条老逻辑挤坏）
    const cfg: WebSearchConfig = normalizeWebSearchConfig({
      customs: [{ id: 'c1', name: '内网', kind: 'json', apiHost: 'http://10.0.0.1/api' }],
      providers: ['firecrawl', toCustomProviderId('c1')],
      order: ['firecrawl', toCustomProviderId('c1')],
    })
    add('共存：内置 firecrawl 与自定义源可同时启用',
      cfg.providers.length === 2 && cfg.providers.includes('firecrawl')
      && cfg.providers.includes(toCustomProviderId('c1')), JSON.stringify(cfg.providers))
  }

  // 3. Firecrawl 的免 Key 报错映射与响应解析见 `webSearchFirecrawl.selftest.ts`
  //    （那部分是主进程 / 渲染层共用的纯函数，单独成套）

  return cases
}

/** 命令行入口（node scripts/run-selftests.mjs webSearch 时走这个） */
export function logWebSearchSelfTest(): boolean {
  const cases = runWebSearchSelfTest()
  const bad = cases.filter((c) => !c.ok)
  console.table(cases.map((c) => ({ case: c.name, ok: c.ok ? 'PASS' : 'FAIL', detail: c.detail || '' })))
  if (bad.length) console.error(`[webSearch] ${bad.length} 个断言失败`)
  return bad.length === 0
}
