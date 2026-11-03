/**
 * toolGroups.ts — 工具列表的「能力域」分组表（设置 → 工具 → 管理 / 智能体预设 → 工具 共用）
 *
 * 为什么要单独一个模块：这两个界面渲染的是同一批工具（内置 `AGENT_TOOL_REGISTRY` + 插件工具），
 * 以前都是平铺一列，40 行堆在一起。分组若各写一份，加工具时必然一边有、一边没有 ——
 * 所以归属只在这里定义，两个面板只负责把 rows 传进 `ToolGroupList.vue`。
 *
 * 本模块是纯逻辑：不 import Vue、不碰持久化、不读 store。
 *
 * 归属规则（顺序即优先级）：
 *   1. 插件工具（`srcKind === 'plugin'`）恒归「MCP 与插件」，与它叫什么无关；
 *   2. 其余按 `TOOL_GROUPS[].tools` 精确匹配；
 *   3. 匹配不到的（新加工具忘了登记）落到「其他」兜底 —— 宁可多一组，
 *      也不能让工具在界面上消失。`toolGroups.selftest.ts` 会断言兜底组为空，
 *      提醒开发者把新工具登记进组。
 */

/** 一个能力域的定义；`tools` 里的名字必须真实存在于 AGENT_TOOL_REGISTRY（自测会校验） */
export interface ToolGroupDef {
  id: string
  labelZh: string
  labelEn: string
  icon: string
  tools: readonly string[]
  /** 首次打开时默认折叠（行数多、平时少动的组） */
  defaultCollapsed?: boolean
}

/** 插件工具归入的组（与内置 mcp_call 同组：都是「外部能力」） */
export const INTEGRATION_GROUP_ID = 'integration'
/** 未登记工具的兜底组 */
export const OTHER_GROUP_ID = 'other'

/**
 * 分组表：顺序即界面顺序（按使用频率排，浏览器 / 插件默认折叠放最后）。
 * 新增工具时**必须**往对应组的 `tools` 里加名字，否则自测报「其他组非空」。
 */
export const TOOL_GROUPS: readonly ToolGroupDef[] = [
  {
    id: 'files',
    labelZh: '文件与目录',
    labelEn: 'Files & Folders',
    icon: 'fa-folder-open',
    tools: ['read_file', 'read_image', 'write_file', 'replace_in_file', 'multi_replace', 'list_dir', 'search_files', 'glob', 'working_directory', 'export_word'],
  },
  {
    id: 'interaction',
    labelZh: '对话与计划',
    labelEn: 'Conversation & Plan',
    icon: 'fa-comments',
    tools: ['ask_user', 'update_plan', 'exit_plan_mode', 'update_todo', 'report_run'],
  },
  {
    id: 'web',
    labelZh: '联网搜索',
    labelEn: 'Web Search',
    icon: 'fa-globe',
    tools: ['web_search', 'web_fetch'],
  },
  {
    id: 'code',
    labelZh: '代码与命令',
    labelEn: 'Code & Shell',
    icon: 'fa-code',
    tools: ['run_python', 'shell'],
  },
  {
    id: 'knowledge',
    labelZh: '知识与技能',
    labelEn: 'Knowledge & Skills',
    icon: 'fa-cubes',
    tools: ['kb_search', 'skill'],
  },
  {
    id: 'subagent',
    labelZh: '子代理',
    labelEn: 'Subagents',
    icon: 'fa-sitemap',
    tools: ['run_subagent', 'job_output', 'job_kill', 'job_list'],
  },
  {
    id: 'browser',
    labelZh: '浏览器自动化',
    labelEn: 'Browser Automation',
    icon: 'fa-window-maximize',
    tools: [
      'browser_navigate', 'browser_snapshot', 'browser_extract_text', 'browser_extract_markdown',
      'browser_screenshot', 'browser_wait_for', 'browser_click', 'browser_fill', 'browser_press',
      'browser_hover', 'browser_select', 'browser_run', 'browser_upload', 'browser_dialog',
      'browser_space_finish',
    ],
    defaultCollapsed: true,
  },
  {
    id: 'browser-extra',
    labelZh: '浏览器扩展工具',
    labelEn: 'Browser Extras',
    icon: 'fa-window-maximize',
    tools: [
      'browser_claim_tab', 'browser_drag', 'browser_wheel', 'browser_paste',
      'browser_list_tabs', 'browser_new_tab', 'browser_switch_tab', 'browser_close_tab',
      'browser_get_html', 'browser_eval', 'browser_type', 'browser_scroll',
      'browser_help', 'browser_list_downloads', 'browser_download_wait', 'browser_download',
      'browser_playbook_save', 'browser_playbook_list', 'browser_playbook_get', 'browser_playbook_run',
      'browser_learning_list', 'browser_learning_get', 'browser_learning_save', 'browser_learning_delete',
      'browser_wait',
    ],
    defaultCollapsed: true,
  },
  {
    id: INTEGRATION_GROUP_ID,
    labelZh: 'MCP 与插件',
    labelEn: 'MCP & Plugins',
    icon: 'fa-plug',
    tools: ['mcp_call'],
    defaultCollapsed: true,
  },
]

/** 工具名 → 组 id（重复登记时先到先得；自测会断言无重复） */
const GROUP_OF = new Map<string, string>()
for (const group of TOOL_GROUPS) {
  for (const name of group.tools) {
    if (!GROUP_OF.has(name)) GROUP_OF.set(name, group.id)
  }
}

/** 某工具名所属的组 id（插件工具请先按 `srcKind` 判定，再调这里；未登记返回空串） */
export function toolGroupIdOf(name: string): string {
  return GROUP_OF.get(String(name)) || ''
}

/** 分组渲染所需的最小行结构（两个面板的行对象都满足，额外字段原样保留） */
export interface GroupableToolRow {
  name: string
  labelZh: string
  labelEn: string
  icon: string
  description: string
  /** 当前是否启用（全局白名单或该预设的生效集） */
  on: boolean
  /** 恒开工具：组内批量操作会跳过它 */
  alwaysOn?: boolean
  srcKind: 'builtin' | 'plugin'
}

/** 一组渲染数据 */
export interface ToolGroupSection<T> {
  id: string
  labelZh: string
  labelEn: string
  icon: string
  defaultCollapsed: boolean
  rows: T[]
}

/**
 * 把平铺的行按能力域分桶。
 *
 * 组内顺序 = 传入 rows 的顺序（即注册表顺序），这样「工具管理」和「预设」看到的名字顺序一致；
 * 空组不输出（没有插件时不显示「MCP 与插件」以外的空壳）；未登记的工具统一进「其他」。
 */
export function groupToolRows<T extends GroupableToolRow>(rows: readonly T[]): ToolGroupSection<T>[] {
  const buckets = new Map<string, T[]>()
  for (const row of rows) {
    const id = row.srcKind === 'plugin' ? INTEGRATION_GROUP_ID : (GROUP_OF.get(row.name) || OTHER_GROUP_ID)
    const list = buckets.get(id)
    if (list) list.push(row)
    else buckets.set(id, [row])
  }

  const out: ToolGroupSection<T>[] = []
  for (const def of TOOL_GROUPS) {
    const groupRows = buckets.get(def.id)
    if (!groupRows || !groupRows.length) continue
    out.push({
      id: def.id,
      labelZh: def.labelZh,
      labelEn: def.labelEn,
      icon: def.icon,
      defaultCollapsed: !!def.defaultCollapsed,
      rows: groupRows,
    })
  }

  const rest = buckets.get(OTHER_GROUP_ID)
  if (rest && rest.length) {
    out.push({
      id: OTHER_GROUP_ID,
      labelZh: '其他',
      labelEn: 'Other',
      icon: 'fa-ellipsis-h',
      defaultCollapsed: false,
      rows: rest,
    })
  }
  return out
}
