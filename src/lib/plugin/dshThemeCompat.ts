/**
 * dshThemeCompat.ts — DSH 设计令牌 → AI-KM 主题的**样式映射**（P5.1）
 *
 * 为什么需要：DSH 插件（如微信设置页）的 CSS 大量使用 `var(--dsw-alias-*)` 与
 * `var(--dsw-radius-*)`。这些令牌由 DSH 的 theme 包注入；AI-KM 没有，于是
 * `color: var(--dsw-alias-label-primary)` 变成"无效值"——颜色、背景、边框全部回退，
 * 页面就只剩裸排版（"很丑"）。
 *
 * 做法：注入**一份**作用域样式表（只作用于 `.aikm-dsh-react-slot`）：
 * - 静态色板用 DSH 的默认值（保证任何主题下都有颜色）；
 * - 语义别名优先映射 AI-KM 自己的主题变量（`--fontColor` / `--menuColor` / `--borderColor` …），
 *   所以切主题时插件页面跟着变；
 * - 补一个零特异性的表单/标题 reset，抵消宿主全局样式（Element Plus 等）的侵入。
 *
 * 不做的：像素级复刻 DSH 布局；插件自己的 class 样式仍然说话。
 */

const STYLE_ID = 'aikm-dsh-theme'

/** 只生成 CSS 文本（纯函数，可被自测钉住） */
export function buildDshThemeCss(): string {
  return `
.aikm-dsh-react-slot {
  /* DSH 静态色板（缺省值 = DSH 自己的浅色主题，深色主题下由别名的 color-mix 适配） */
  --dsw-static-neutral-bluish-00: rgb(255, 255, 255);
  --dsw-static-neutral-bluish-50: rgb(249, 250, 251);
  --dsw-static-neutral-bluish-100: rgb(235, 238, 242);
  --dsw-static-neutral-bluish-200: rgb(225, 229, 238);
  --dsw-static-neutral-bluish-300: rgb(207, 211, 214);
  --dsw-static-neutral-bluish-400: rgb(173, 178, 184);
  --dsw-static-neutral-bluish-500: rgb(151, 157, 166);
  --dsw-static-neutral-bluish-600: rgb(129, 133, 140);
  --dsw-static-neutral-bluish-700: rgb(97, 102, 107);
  --dsw-static-neutral-bluish-750: rgb(67, 69, 74);
  --dsw-static-neutral-bluish-800: rgb(53, 54, 56);
  --dsw-static-neutral-bluish-850: rgb(44, 44, 46);
  --dsw-static-neutral-bluish-900: rgb(27, 27, 28);
  --dsw-static-neutral-bluish-1000: rgb(15, 17, 21);
  --dsw-static-deepseek-500: rgb(65, 118, 230);
  --dsw-static-red-600: rgb(236, 19, 19);
  --dsw-static-green-500: rgb(34, 197, 94);
  --dsw-static-amber-500: rgb(245, 158, 11);

  /* 语义别名 → AI-KM 主题变量（无则回落到 DSH 默认） */
  --dsw-alias-label-primary: var(--fontColor, var(--dsw-static-neutral-bluish-1000));
  --dsw-alias-label-primary-foreground: var(--backgroundColor, var(--dsw-static-neutral-bluish-00));
  --dsw-alias-label-secondary: color-mix(in srgb, var(--fontColor, rgb(15, 17, 21)) 72%, transparent);
  --dsw-alias-label-tertiary: color-mix(in srgb, var(--fontColor, rgb(15, 17, 21)) 55%, transparent);
  --dsw-alias-label-dimmed: color-mix(in srgb, var(--fontColor, rgb(15, 17, 21)) 40%, transparent);

  --dsw-alias-bg-layer-1: var(--backgroundColor, var(--dsw-static-neutral-bluish-00));
  --dsw-alias-bg-layer-2: var(--menuColor, var(--dsw-static-neutral-bluish-50));
  --dsw-alias-bg-layer-3: var(--menuActiveColor, var(--dsw-static-neutral-bluish-100));
  --dsw-alias-bg-module-platform: var(--menuActiveColor, var(--dsw-static-neutral-bluish-100));

  --dsw-alias-border-l1: color-mix(in srgb, var(--borderColor, rgb(208, 215, 222)) 45%, transparent);
  --dsw-alias-border-l2: color-mix(in srgb, var(--borderColor, rgb(208, 215, 222)) 70%, transparent);
  --dsw-alias-border-l3: color-mix(in srgb, var(--borderColor, rgb(208, 215, 222)) 85%, transparent);
  --dsw-alias-border-l4: var(--borderColor, rgb(208, 215, 222));

  --dsw-alias-brand-primary: var(--el-color-primary, rgb(64, 158, 255));
  --dsw-alias-button-primary-fill: var(--dsw-alias-brand-primary);
  --dsw-alias-button-primary-hover: color-mix(in srgb, var(--dsw-alias-brand-primary) 85%, white);
  --dsw-alias-interactive-bg-hover: color-mix(in srgb, var(--fontColor, rgb(15, 17, 21)) 6%, transparent);
  --dsw-alias-interactive-bg-active: color-mix(in srgb, var(--fontColor, rgb(15, 17, 21)) 10%, transparent);

  --dsw-alias-state-business-primary: var(--dsw-static-deepseek-500);
  --dsw-alias-state-error-primary: var(--dsw-static-red-600);
  --dsw-alias-state-success-primary: var(--dsw-static-green-500);
  --dsw-alias-state-warn-primary: var(--dsw-static-amber-500);

  --dsw-alias-switch-thumb: var(--backgroundColor, var(--dsw-static-neutral-bluish-00));

  --dsw-radius-sm: 6px;
  --dsw-radius-md: 8px;
  --dsw-radius-lg: 12px;
  --dsw-focus-ring-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent);
  --dsw-focus-ring-width: 2px;

  /* 排版与盒模型：DSH 全局有 border-box；AI-KM 的 Element Plus 会改写 button/input */
  box-sizing: border-box;
  font-family: var(--el-font-family, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif);
  color: var(--dsw-alias-label-primary);
  color-scheme: inherit;
}
.aikm-dsh-react-slot *,
.aikm-dsh-react-slot *::before,
.aikm-dsh-react-slot *::after {
  box-sizing: border-box;
}
/* :where() 的零特异性：插件自己的 class 永远压过这里，只补宿主没给到的默认值 */
.aikm-dsh-react-slot :where(h1, h2, h3, h4, p, ul, ol) {
  margin: 0;
}
.aikm-dsh-react-slot :where(button) {
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
}
.aikm-dsh-react-slot :where(input, textarea, select) {
  font: inherit;
  color: inherit;
}
.aikm-dsh-react-slot :where(a) {
  color: var(--dsw-alias-state-business-primary);
}
`
}

/** 注入一次；没有 document 的环境（自测 / SSR）直接跳过 */
export function installDshThemeCompat(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = buildDshThemeCss()
  document.head.append(style)
}
