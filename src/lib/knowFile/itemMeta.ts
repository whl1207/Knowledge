/**
 * itemMeta.ts — 条目展示元数据工具（日历 / 看板 / 表格 / 甘特共用）
 *
 * 约定：这些信息都来自 Markdown 文件头部的 YAML frontmatter（`getConfig` 读取）：
 *   - `颜色`：条目配色（`#rgb` / `#rrggbb`），日历条目条、看板卡片、表格取色器共用
 *   - `状态`：任务状态文案，取值 → 图标映射见 statusOptions.ts（用户可在看板里自定义顺序与图标，
 *     未知取值不给图标、不报错）
 * 只做「读」与展示辅助，不在这里写文件。
 */

/**
 * 展示用条目名：去掉 Markdown 后缀（`.md` / `.markdown`），其余（文件夹、其它扩展名）原样返回。
 * 日历条目条 / 甘特任务名这类窄空间展示用，避免 `.md` 占据宽度。
 */
export function stripMdSuffix(label: any): string {
  return String(label ?? '').replace(/\.(md|markdown)$/i, '')
}

/** 时间字段占位值：表示「不指定具体字段，按文件自动挑」（日历 / 甘特的下拉都用它） */
export const DEFAULT_TIME_FIELD = '__default__'

/** 是否为时间类字段（字段名含 time / 时间，与项目既有约定一致） */
export function isTimeishField(key: any): boolean {
  const k = String(key ?? '')
  return k.toLowerCase().includes('time') || k.includes('时间')
}

/** 取属性里的日期；无值 / 非法值返回 null */
export function attrDateOf(item: any, field: string): Date | null {
  if (!field) return null
  const v = item && item.attributes ? item.attributes[field] : undefined
  if (v === undefined || v === null || v === '') return null
  const d = new Date(v)
  return isNaN(d.getTime()) ? null : d
}

/**
 * 解析「起始时间字段」：显式指定（且不是「默认」）优先；否则优先 `开始时间`，
 * 没有任何时间类字段时回退 `开始时间`（调用方自行决定是否再溡到文件时间）。
 */
export function resolveStartFieldOf(item: any, explicit?: string): string {
  if (explicit && explicit !== DEFAULT_TIME_FIELD) return explicit
  const attrs = (item && item.attributes) || {}
  const keys = Object.keys(attrs).filter(isTimeishField)
  if (keys.includes('开始时间')) return '开始时间'
  return keys.length ? keys[0] : '开始时间'
}

/** 从文件列表里收集时间类字段（按出现次数降序，供下拉选项用；避开无意义的全量属性列表） */
export function collectTimeFields(items: any[]): string[] {
  const map = new Map<string, number>()
  for (const it of items || []) {
    const attrs = it && it.attributes
    if (!attrs || typeof attrs !== 'object') continue
    for (const k of Object.keys(attrs)) {
      if (isTimeishField(k)) map.set(k, (map.get(k) || 0) + 1)
    }
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(e => e[0])
}

/** 从属性对象里取颜色（兼容 `颜色` / `color`；只接受 3/6 位十六进制，避免把非法值塞进 style） */
export function colorOfAttributes(attrs: any): string {
  if (!attrs || typeof attrs !== 'object') return ''
  const v = attrs['颜色'] !== undefined ? attrs['颜色'] : attrs['color']
  const s = typeof v === 'string' ? v.trim() : ''
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? s : ''
}

/**
 * 按 YIQ 亮度选对比文字色（黑 / 白）：彩色底上保证文字可读。
 * 与待办模块的取值算法一致，避免同一个颜色在两处文字色不同。
 */
export function contrastTextColor(bg: string): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(bg || '').trim())
  if (!m) return ''
  let hex = m[1]
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  const yiq = (r * 299 + g * 587 + b * 114) / 1000
  return yiq >= 128 ? '#000000' : '#FFFFFF'
}

/**
 * 颜色是否为深色（YIQ 亮度 < 128）：用于按主题切换配色等。
 * 只识别 #RGB / #RRGGBB / #RRGGBBAA，其它写法（空值 / 变量 / rgb()）按浅色处理。
 */
export function isDarkHexColor(color: string): boolean {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(color || '').trim())
  if (!m) return false
  let hex = m[1]
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return r * 0.299 + g * 0.587 + b * 0.114 < 128
}

/** 归档属性：写入用 `归档`；兼容读取历史导出里的 archived / hidden */
export const FIELD_ARCHIVED = '归档'
const ARCHIVED_ALIASES = ['归档', 'archived', 'hidden']

/** 条目是否已归档（`归档` / `archived` / `hidden` 任一为真；与看板卡片同一判定） */
export function isArchivedOf(attrs: any): boolean {
  if (!attrs || typeof attrs !== 'object') return false
  return ARCHIVED_ALIASES.some((k) => attrs[k] === true || attrs[k] === 'true')
}

/** 颜色属性名默认写法（兼容读取历史文件里的 `color`，见 colorFieldOf） */
export const COLOR_FIELD_DEFAULT = '颜色'

/** 颜色写入哪个属性：沿用文件里已有的写法（`颜色` / `color`），避免同一个文件里写出两套颜色字段 */
export function colorFieldOf(attrs: any): string {
  if (!attrs || typeof attrs !== 'object') return COLOR_FIELD_DEFAULT
  if (attrs[COLOR_FIELD_DEFAULT] !== undefined) return COLOR_FIELD_DEFAULT
  return attrs['color'] !== undefined ? 'color' : COLOR_FIELD_DEFAULT
}

/**
 * 预设色板：浅色主题用饱和的中明度色（条目上自动配黑 / 白文字），
 * 深色主题换成更深的宝石色系——浅色色卡铺在深色底上会过于刺眼，深色调在深色底上更耐看。
 * 两者色相一一对应（红 / 橙 / 黄 / 绿 / 青 / 蓝 / 靛 / 紫 / 玫红 / 灰）。
 */
export const COLOR_PRESETS_LIGHT = ['#e5484d', '#f76b15', '#f5b301', '#46a758', '#12a594', '#0090ff', '#5b5bd6', '#8e4ec6', '#e93d82', '#8d8d8d']
export const COLOR_PRESETS_DARK = ['#9b2c2c', '#9c4221', '#8a6704', '#276749', '#145c5c', '#2b6cb0', '#4c4fa8', '#6b46a8', '#9d3f6b', '#4a5568']

/** 按应用背景色亮度选一套色板（看板卡片菜单与日历条目菜单共用同一套预设色） */
export function colorPresetsFor(backgroundColor: any): string[] {
  return isDarkHexColor(String(backgroundColor || '')) ? COLOR_PRESETS_DARK : COLOR_PRESETS_LIGHT
}

/**
 * `状态` 分类的图标表与取值函数已移到 statusOptions.ts（支持在看板里自定义顺序 / 图标），
 * 这里原样再导出，既有引用（看板 / 日历）保持不变。
 */
export { STATUS_ICONS, statusIconOf } from './statusOptions'

/** 取 `状态` 属性原文（用于悬浮提示 / 对比色展示） */
export function statusTextOf(attrs: any): string {
  if (!attrs || typeof attrs !== 'object') return ''
  const v = attrs['状态']
  return v === undefined || v === null ? '' : String(v)
}
