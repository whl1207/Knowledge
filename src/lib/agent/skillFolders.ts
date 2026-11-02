/**
 * skillFolders.ts — 技能列表的「文件夹 / 分类目录」分组（设置 → 技能 → 管理 / 智能体预设 → 技能 共用）
 *
 * 技能根目录允许用分类目录组织（2~3 级，见 electron/main/skill-service.ts 的
 * MAX_FOLDER_DEPTH）：`root/财务/技能`、`root/办公/文档/pdf` 等都算一个技能，
 * 它相对根的父路径存在 `SkillCandidate.folder` 里（`/` 分隔；直接放根下为空串）。
 *
 * 本模块把平铺的技能行按 folder 分桶，产出的 Section 形状与
 * `ToolGroupList.vue` 的 `sections` 入参一致 —— 两个面板共用同一套分组外壳
 * （折叠 / 组内计数 / 组内全开全关 / 搜索），只是行的样式各写各的。
 *
 * 纯逻辑：不 import Vue、不碰持久化、不读 store。
 */

/** 直接放在技能根目录下的技能归入这一组 */
export const SKILL_ROOT_FOLDER_ID = '__root__'

/** 分组所需的最小技能行结构（其余字段原样保留，供行插槽渲染） */
export interface GroupableSkillRow {
  name: string
  /** 相对技能根的父路径，`/` 分隔；直接放在根下为空串 / undefined */
  folder?: string
}

/** 一组渲染数据（字段与 toolGroups.ToolGroupSection 一致，可直接传给 ToolGroupList） */
export interface SkillFolderSection<T> {
  id: string
  labelZh: string
  labelEn: string
  icon: string
  defaultCollapsed: boolean
  rows: T[]
}

/**
 * 归一化 folder：统一 `/`、去掉首尾与重复的 `/`。
 * 历史数据 / 手写值里可能出现反斜杠或多余分隔符，分组前必须归一到同一把 key。
 */
export function normalizeSkillFolder(folder: unknown): string {
  return String(folder ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/')
}

/** 分组标题：用「 / 」分隔层级，让 2~3 级目录在一条组头里读得出来 */
export function skillFolderLabel(folder: unknown, zh = true): string {
  const norm = normalizeSkillFolder(folder)
  if (!norm) return zh ? '未分类（根目录）' : 'Uncategorized (root)'
  return norm.split('/').join(' / ')
}

/** 分组用的稳定 id（folder 路径即可；根目录用固定 id，避免空串当 key） */
export function skillFolderGroupId(folder: unknown): string {
  const norm = normalizeSkillFolder(folder)
  return norm ? `folder:${norm}` : SKILL_ROOT_FOLDER_ID
}

/**
 * 把平铺的技能行按 folder 分桶。
 *
 * - 组顺序：分类目录按路径升序（层级前缀天然相邻，读起来像目录树）；根目录组固定排最后。
 * - 组内顺序：按技能名升序（扫描顺序在不同文件系统上不稳定，UI 要稳）。
 * - 空组不输出；folder 缺失 / 空串统一进「未分类（根目录）」。
 */
export function groupSkillRowsByFolder<T extends GroupableSkillRow>(
  rows: readonly T[],
  opts: { zh?: boolean } = {},
): SkillFolderSection<T>[] {
  const zh = opts.zh !== false
  const buckets = new Map<string, { folder: string; rows: T[] }>()

  for (const row of rows) {
    const folder = normalizeSkillFolder(row.folder)
    const id = skillFolderGroupId(folder)
    const bucket = buckets.get(id)
    if (bucket) bucket.rows.push(row)
    else buckets.set(id, { folder, rows: [row] })
  }

  const sections: SkillFolderSection<T>[] = []
  // 分类目录（有 folder）按路径排序
  const folderKeys = Array.from(buckets.keys())
    .filter((id) => id !== SKILL_ROOT_FOLDER_ID)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  for (const id of folderKeys) {
    const bucket = buckets.get(id)!
    sections.push({
      id,
      labelZh: skillFolderLabel(bucket.folder, true),
      labelEn: skillFolderLabel(bucket.folder, false),
      icon: 'fa-folder-o',
      defaultCollapsed: false,
      rows: [...bucket.rows].sort((a, b) => String(a.name).localeCompare(String(b.name))),
    })
  }

  // 根目录（未分类）固定放最后：多数技能都按分类整理，根目录通常是零散技能
  const root = buckets.get(SKILL_ROOT_FOLDER_ID)
  if (root) {
    sections.push({
      id: SKILL_ROOT_FOLDER_ID,
      labelZh: skillFolderLabel('', zh),
      labelEn: skillFolderLabel('', false),
      icon: 'fa-cube',
      defaultCollapsed: false,
      rows: [...root.rows].sort((a, b) => String(a.name).localeCompare(String(b.name))),
    })
  }

  return sections
}

/** 某技能行所属的组 id（需要按组做批量操作时用） */
export function skillFolderIdOf(row: GroupableSkillRow): string {
  return skillFolderGroupId(row.folder)
}
