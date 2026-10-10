/**
 * statusOptions.ts — 「状态」分类表（取值 / 顺序 / 图标）的用户配置。
 *
 * 默认表 = 内置的常见任务状态；用户可在看板视图的状态栏里调整**顺序**、改**图标**、增删分类，
 * 配置保存在 localStorage。看板（分列 / 筛选 / 新建默认值）与日历（条目状态图标）共用这一份配置，
 * 因此改完两处同时生效。
 * 只做「读配置 + 展示辅助」，不在这里写文件；未知取值退回内置图标表，仍未命中则不给图标。
 */
import { ref } from 'vue'

const KEY = 'knowFile-status-options'

export interface StatusOption {
  /** 属性取值（写进 frontmatter 的字符串） */
  value: string
  /** Font Awesome 类名（项目内置 FA 4.7） */
  icon: string
}

/** 内置图标表：用户配置之外的取值（含「待完成 / 完成」等同义写法）仍按它显示图标 */
export const STATUS_ICONS: Record<string, string> = {
  灵感: 'fa fa-lightbulb-o',
  规划: 'fa fa-sitemap',
  待办: 'fa fa-clock-o',
  待完成: 'fa fa-clock-o',
  进行中: 'fa fa-spinner',
  已完成: 'fa fa-check-circle-o',
  完成: 'fa fa-check-circle-o',
  未完成: 'fa fa-circle-o',
  已取消: 'fa fa-ban',
  已搁置: 'fa fa-pause',
}

/** 默认分类表（顺序即看板默认列序） */
export const DEFAULT_STATUS_OPTIONS: StatusOption[] = [
  '灵感',
  '规划',
  '待办',
  '进行中',
  '已完成',
  '未完成',
  '已取消',
  '已搁置',
].map((value) => ({ value, icon: STATUS_ICONS[value] || 'fa fa-tag' }))

/** 图标快选（编辑器下拉用；均为内置 FA 4.7 图标） */
export const ICON_PRESETS: string[] = [
  'fa fa-lightbulb-o',
  'fa fa-sitemap',
  'fa fa-clock-o',
  'fa fa-hourglass-half',
  'fa fa-spinner',
  'fa fa-circle-o',
  'fa fa-check-circle-o',
  'fa fa-thumbs-o-up',
  'fa fa-ban',
  'fa fa-pause',
  'fa fa-tag',
  'fa fa-bookmark',
  'fa fa-star',
  'fa fa-flag',
  'fa fa-fire',
  'fa fa-bolt',
  'fa fa-rocket',
  'fa fa-bug',
  'fa fa-exclamation-circle',
  'fa fa-question-circle',
  'fa fa-tasks',
  'fa fa-list-ol',
  'fa fa-calendar-check-o',
  'fa fa-heart',
]

const defaultOptions = () => DEFAULT_STATUS_OPTIONS.map((o) => ({ ...o }))

function read(): StatusOption[] {
  try {
    const raw = localStorage.getItem(KEY)
    // 未配置过 → 默认表；显式存过空数组 → 尊重用户的「全删」（列序改由文件里的取值决定）
    if (!raw) return defaultOptions()
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return defaultOptions()
    return parsed
      .filter((o: any) => o && typeof o.value === 'string' && o.value.trim())
      .map((o: any) => ({
        value: String(o.value).trim(),
        icon: typeof o.icon === 'string' && o.icon ? o.icon : 'fa fa-tag',
      }))
  } catch {
    return defaultOptions()
  }
}

/** 状态分类表（响应式：改动后看板列序与看板 / 日历图标立即更新） */
export const statusList = ref<StatusOption[]>(read())

/**
 * 归一化比较键：抹平「看起来一样、实际不等」的差异（零宽字符 / 首尾空格与成对引号 / 全半角），
 * 用于把文件里的取值对到分类表（列序与图标）。文件里的取值常从别处粘贴而来，可能自带这些不可见字符。
 */
export function statusKeyOf(value: any): string {
  return String(value ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/^[\s"'“”‘’「」]+|[\s"'“”‘’「」]+$/g, '')
    .normalize('NFKC')
}

/** 内置图标表按归一化键索引（取图标时同样容忍不可见差异） */
const STATUS_ICON_ENTRIES: Array<[string, string]> = Object.entries(STATUS_ICONS).map(([k, v]) => [statusKeyOf(k), v])

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(statusList.value))
  } catch (e) {
    console.error('保存状态分类失败:', e)
  }
}

/** 取图标：优先用户配置，其次内置表，未知取值返回空串（保持「只有文字」形态） */
export function statusIconFor(value: string): string {
  const key = statusKeyOf(value)
  if (!key) return ''
  const hit = statusList.value.find((o) => statusKeyOf(o.value) === key)
  if (hit) return hit.icon
  const builtin = STATUS_ICON_ENTRIES.find(([k]) => k === key)
  return builtin ? builtin[1] : ''
}

/** 取 `状态` 属性对应的图标（看板 / 日历共用） */
export function statusIconOf(attrs: any): string {
  if (!attrs || typeof attrs !== 'object') return ''
  const v = attrs['状态']
  return typeof v === 'string' ? statusIconFor(v) : ''
}

/** 新增分类（同名已存在则返回 false；「只差不可见字符」也算同名） */
export function addStatusOption(value: string, icon: string): boolean {
  const v = String(value || '').trim()
  if (!v) return false
  const key = statusKeyOf(v)
  if (statusList.value.some((o) => statusKeyOf(o.value) === key)) return false
  statusList.value.push({ value: v, icon: icon || 'fa fa-tag' })
  save()
  return true
}

/** 移除分类：文件里已用的取值不会改动，只是不再占默认列序（会作为额外列出现） */
export function removeStatusOption(value: string) {
  const next = statusList.value.filter((o) => o.value !== value)
  if (next.length === statusList.value.length) return
  statusList.value = next
  save()
}

/** 改某个分类的图标 */
export function setStatusIcon(value: string, icon: string) {
  const hit = statusList.value.find((o) => o.value === value)
  if (!hit) return
  hit.icon = icon || 'fa fa-tag'
  save()
}

/** 上移 / 下移一位（delta = -1 / 1） */
export function moveStatusOption(value: string, delta: number) {
  const i = statusList.value.findIndex((o) => o.value === value)
  const j = i + delta
  if (i < 0 || j < 0 || j >= statusList.value.length) return
  const [row] = statusList.value.splice(i, 1)
  statusList.value.splice(j, 0, row)
  save()
}

/** 恢复默认分类表 */
export function resetStatusOptions() {
  statusList.value = defaultOptions()
  save()
}
