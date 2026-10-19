/**
 * webFetch.selftest.ts — 网页抓取通道配置自测（纯计算，不联网、不依赖 Vue / Electron）
 *
 * 重点覆盖的风险：
 *  1. 三张表（通道 id / 展示元信息 / 默认配置）必须同时有新增通道，否则设置页列得出来却跑不了；
 *  2. **至少保留一个通道**：全关时归一化必须兜底打开 direct，否则 web_fetch 会“无通道可走”；
 *  3. 旧存档（没有 webFetchConfig）必须平滑补齐默认值，且默认行为与旧版一致（direct + browser）；
 *  4. DeepSeek 的旧版 `/anthropic/v1` base 必须被迁移掉，否则升级后抓取全部 404。
 *
 * 用法（开发期）：
 *   import { runWebFetchSelfTest } from '@/shared/webFetch.selftest'
 *   console.table(runWebFetchSelfTest())
 * 或命令行：`node scripts/run-selftests.mjs webFetch`
 */

import {
  DEFAULT_WEB_FETCH_CONFIG,
  WEB_FETCH_CHANNELS,
  WEB_FETCH_CHANNEL_IDS,
  enabledWebFetchChannels,
  isWebFetchChannelId,
  normalizeWebFetchConfig,
  webFetchChannelMeta,
  type WebFetchConfig,
} from './webFetch'

export interface WebFetchCase {
  name: string
  ok: boolean
  detail?: string
}

export function runWebFetchSelfTest(): WebFetchCase[] {
  const cases: WebFetchCase[] = []
  const add = (name: string, ok: boolean, detail = '') => cases.push({ name, ok, detail })

  // ---------- 1. 三张表一致性 ----------
  add('清单：三个通道都注册了 id',
    WEB_FETCH_CHANNEL_IDS.length === 3 &&
    WEB_FETCH_CHANNEL_IDS.includes('direct') &&
    WEB_FETCH_CHANNEL_IDS.includes('deepseek') &&
    WEB_FETCH_CHANNEL_IDS.includes('browser'),
    WEB_FETCH_CHANNEL_IDS.join(','))
  add('元信息：每个 id 都有展示条目',
    WEB_FETCH_CHANNEL_IDS.every((id) => WEB_FETCH_CHANNELS.some((c) => c.id === id)))
  add('元信息：DeepSeek 标了需要 Key 并给了文档', (() => {
    const m = webFetchChannelMeta('deepseek')
    return m.needsKey === true && String(m.docs || '').includes('api-docs.deepseek.com')
  })(), String(webFetchChannelMeta('deepseek').docs))
  add('元信息：虚拟浏览器标了「仅桌面端」', webFetchChannelMeta('browser').desktopOnly === true)
  add('元信息：未知 id 回退直接访问', webFetchChannelMeta('nope').id === 'direct')
  add('默认配置：direct + browser 开启、deepseek 关闭（与旧行为一致）',
    DEFAULT_WEB_FETCH_CONFIG.channels.direct === true &&
    DEFAULT_WEB_FETCH_CONFIG.channels.browser === true &&
    DEFAULT_WEB_FETCH_CONFIG.channels.deepseek === false)
  add('默认配置：DeepSeek 排在 direct 之后、browser 之前（打开即成为第一层回退）', (() => {
    const o = DEFAULT_WEB_FETCH_CONFIG.order
    return o.indexOf('deepseek') === o.indexOf('direct') + 1 && o.indexOf('deepseek') < o.indexOf('browser')
  })(), DEFAULT_WEB_FETCH_CONFIG.order.join(' > '))
  add('默认配置：DeepSeek base 是官方地址（不是旧版 /anthropic）',
    DEFAULT_WEB_FETCH_CONFIG.deepseek.apiHost === 'https://api.deepseek.com',
    String(DEFAULT_WEB_FETCH_CONFIG.deepseek.apiHost))

  // ---------- 2. 归一化：缺字段 / 旧存档 ----------
  {
    const cfg = normalizeWebFetchConfig(null)
    add('归一化：空存档 == 出厂默认',
      JSON.stringify(cfg) === JSON.stringify(normalizeWebFetchConfig(DEFAULT_WEB_FETCH_CONFIG)),
      JSON.stringify(cfg))
    add('归一化：order 覆盖全部通道', cfg.order.length === 3 && cfg.order[0] === 'direct')
  }
  {
    const cfg = normalizeWebFetchConfig({
      order: ['browser', 'deepseek', 'direct', 'browser', 'bogus'],
      channels: { direct: false, deepseek: true },
    })
    add('归一化：order 去重并剔除非法 id',
      cfg.order.join(',') === 'browser,deepseek,direct', cfg.order.join(','))
    add('归一化：缺的开关取默认（browser 默认开启）', cfg.channels.browser === true)
    add('归一化：显式关闭被保留', cfg.channels.direct === false)
    add('归一化：显式开启被保留', cfg.channels.deepseek === true)
  }
  {
    const cfg = normalizeWebFetchConfig({ order: [], channels: { direct: false, deepseek: false, browser: false } })
    add('归一化：全部关闭时兜底打开 direct（web_fetch 至少有一个通道）', cfg.channels.direct === true)
    add('归一化：兜底后 order 仍是完整三项', cfg.order.length === 3)
  }
  {
    const cfg = normalizeWebFetchConfig({ order: ['weird'] })
    add('归一化：order 全是非法值时补全为默认顺序', cfg.order.join(',') === 'direct,deepseek,browser', cfg.order.join(','))
  }

  // ---------- 3. DeepSeek 配置 ----------
  {
    const cfg = normalizeWebFetchConfig({
      deepseek: { apiHost: 'https://api.deepseek.com/anthropic/v1', apiKey: 'sk-x', reuseChatKey: false },
    })
    add('迁移：旧版 /anthropic/v1 base 被剥掉',
      cfg.deepseek.apiHost === 'https://api.deepseek.com', String(cfg.deepseek.apiHost))
    add('配置：单独填的 Key 保留', cfg.deepseek.apiKey === 'sk-x', String(cfg.deepseek.apiKey))
    add('配置：reuseChatKey=false 保留', cfg.deepseek.reuseChatKey === false)
    add('配置：默认 reuseChatKey=true（零配置可用）',
      normalizeWebFetchConfig({}).deepseek.reuseChatKey === true)
    add('配置：base 留空回默认', normalizeWebFetchConfig({ deepseek: { apiHost: '  ' } }).deepseek.apiHost === 'https://api.deepseek.com')
    add('配置：凭据引用保留', normalizeWebFetchConfig({ deepseek: { apiKeyRef: 'deepseek' } }).deepseek.apiKeyRef === 'deepseek')
  }

  // ---------- 4. 启用通道顺序 ----------
  {
    const enabled = (raw: Partial<WebFetchConfig>) =>
      enabledWebFetchChannels(normalizeWebFetchConfig(raw)).join(',')
    add('通道：默认 = direct,browser（DeepSeek 关闭时不占位）', enabled({}) === 'direct,browser', enabled({}))
    add('通道：打开 DeepSeek 后 = direct,deepseek,browser',
      enabled({ channels: { direct: true, deepseek: true, browser: true } }) === 'direct,deepseek,browser')
    add('通道：关掉 direct 后从 chain 里消失',
      enabled({ channels: { direct: false, deepseek: true, browser: true } }) === 'deepseek,browser')
    add('通道：顺序按 order（可把 browser 提前）',
      enabled({
        order: ['browser', 'direct', 'deepseek'],
        channels: { direct: true, deepseek: true, browser: true },
      }) === 'browser,direct,deepseek')
    add('通道：全关时仍返回 direct（归一化兜底）',
      enabled({ channels: { direct: false, deepseek: false, browser: false } }) === 'direct')
  }

  add('类型守卫：isWebFetchChannelId 只认三个合法 id',
    isWebFetchChannelId('direct') && isWebFetchChannelId('deepseek') && isWebFetchChannelId('browser') &&
    !isWebFetchChannelId('cs:x') && !isWebFetchChannelId(''))

  return cases
}

/** 命令行入口（node scripts/run-selftests.mjs webFetch 时走这个） */
export function logWebFetchSelfTest(): boolean {
  const cases = runWebFetchSelfTest()
  const bad = cases.filter((c) => !c.ok)
  console.table(cases.map((c) => ({ case: c.name, ok: c.ok ? 'PASS' : 'FAIL', detail: c.detail || '' })))
  if (bad.length) console.error(`[webFetch] ${bad.length} 个断言失败`)
  return bad.length === 0
}
