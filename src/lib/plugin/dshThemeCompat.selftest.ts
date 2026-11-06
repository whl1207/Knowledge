/**
 * dshThemeCompat.selftest.ts — DSH 设计令牌映射的自测（纯字符串）
 *
 * 微信设置页实际用到的每个 `--dsw-*` 令牌都必须在映射表里；漏一个，那一处就回退成
 * "没有样式"（颜色 / 边框 / 圆角全部失效）。
 */

import { buildDshThemeCss } from './dshThemeCompat'

export interface SelfTestResult {
  name: string
  ok: boolean
  detail?: string
}

/** 微信 client.js 里实际出现的令牌（从 bundle 里提取） */
const WECHAT_TOKENS = [
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l3',
  '--dsw-alias-border-l4',
  '--dsw-alias-brand-primary',
  '--dsw-alias-button-primary-fill',
  '--dsw-alias-button-primary-hover',
  '--dsw-alias-interactive-bg-active',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-label-dimmed',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-primary-foreground',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-state-business-primary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-switch-thumb',
  '--dsw-focus-ring-color',
  '--dsw-focus-ring-width',
  '--dsw-radius-lg',
  '--dsw-radius-md',
  '--dsw-radius-sm',
]

export function runDshThemeCompatSelfTest(): SelfTestResult[] {
  const results: SelfTestResult[] = []
  const css = buildDshThemeCss()

  results.push({
    name: '作用域限定在 .aikm-dsh-react-slot（不污染宿主）',
    ok: css.includes('.aikm-dsh-react-slot') && !/\nbody\s*\{/.test(css),
    detail: '',
  })

  const missing = WECHAT_TOKENS.filter((token) => !css.includes(`${token}:`))
  results.push({
    name: `微信用到的 ${WECHAT_TOKENS.length} 个令牌全部有定义`,
    ok: missing.length === 0,
    detail: missing.length ? `缺：${missing.join(', ')}` : '',
  })

  results.push({
    name: '语义色映射到 AI-KM 主题变量（切主题会跟随）',
    ok: css.includes('var(--fontColor') && css.includes('var(--backgroundColor') && css.includes('var(--borderColor'),
    detail: '',
  })

  results.push({
    name: '静态色板补齐（不依赖 DSH 主题包）',
    ok: css.includes('--dsw-static-neutral-bluish-1000:') && css.includes('--dsw-static-deepseek-500:'),
    detail: '',
  })

  results.push({
    name: '表单 reset 用 :where()（零特异性，不压插件 class）',
    ok: css.includes(':where(button)') && css.includes(':where(input, textarea, select)'),
    detail: '',
  })

  return results
}
