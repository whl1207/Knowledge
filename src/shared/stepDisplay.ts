/**
 * stepDisplay.ts — 工作步骤（工具卡片）展示策略（对齐 DSH 的 `ui-chat.transcriptView`）
 *
 * DSH 把"步骤显示多少"做成一张**策略表**，四档各对应四个开关
 * （foldCompletedTurns / stepGrouping / liveProcessDetail / settledReasoningPreview），
 * 而不是在模板里散落一堆 if。这里照搬同样的结构，并补两个 AI-KM 特有的开关：
 * - `diffFirst`：编辑类工具（write_file / replace_in_file / multi_replace）优先给差异，
 *   不再铺参数 JSON（diff 信息密度高得多）；
 * - `resultFirst`：读取/搜索类工具（read_file / search_files / glob / list_dir）优先给结果，
 *   参数（路径/查询词）本来就已在折叠行摘要里，展开后不必再占一块。
 *
 * 另外「收起时机」是**独立**的一档（DSH 的 `collapseTiming`）：
 * 回答一结束就收起，想回头看细节还得再展开，很多时候不方便。
 */

export type StepDetailMode = 'compact' | 'standard' | 'detailed' | 'verbose'
export type StepCollapseTiming = 'completion' | 'next-input'

export interface StepDisplayPolicy {
  mode: StepDetailMode
  /** 已完成的轮次是否把整段过程折成一行 */
  foldCompletedTurns: boolean
  /** 折叠行是否显示「单行摘要」（简洁档只留图标 + 名称） */
  showSummaryLine: boolean
  /** 思考结束后是否保留预览 */
  settledReasoningPreview: boolean
  /** 卡片默认是否展开 */
  defaultExpanded: boolean
  /** 编辑类工具优先展示差异 */
  diffFirst: boolean
  /** 读取类工具优先展示结果 */
  resultFirst: boolean
}

/** 四档策略（compact / standard / detailed 折叠，verbose 全展开） */
const POLICIES: Record<StepDetailMode, Omit<StepDisplayPolicy, 'mode'>> = {
  compact: {
    foldCompletedTurns: true,
    showSummaryLine: false,
    settledReasoningPreview: false,
    defaultExpanded: false,
    diffFirst: true,
    resultFirst: false,
  },
  standard: {
    foldCompletedTurns: true,
    showSummaryLine: true,
    settledReasoningPreview: true,
    defaultExpanded: false,
    diffFirst: true,
    resultFirst: true,
  },
  detailed: {
    foldCompletedTurns: true,
    showSummaryLine: true,
    settledReasoningPreview: true,
    defaultExpanded: true,
    diffFirst: true,
    resultFirst: true,
  },
  verbose: {
    foldCompletedTurns: false,
    showSummaryLine: true,
    settledReasoningPreview: true,
    defaultExpanded: true,
    diffFirst: false,
    resultFirst: false,
  },
}

export const STEP_DETAIL_MODES: readonly StepDetailMode[] = ['compact', 'standard', 'detailed', 'verbose']
export const STEP_COLLAPSE_TIMINGS: readonly StepCollapseTiming[] = ['completion', 'next-input']

export const DEFAULT_STEP_DETAIL_MODE: StepDetailMode = 'standard'
export const DEFAULT_STEP_COLLAPSE_TIMING: StepCollapseTiming = 'completion'

export function normalizeStepDetailMode(value: unknown): StepDetailMode {
  return STEP_DETAIL_MODES.includes(String(value) as StepDetailMode)
    ? (String(value) as StepDetailMode)
    : DEFAULT_STEP_DETAIL_MODE
}

export function normalizeStepCollapseTiming(value: unknown): StepCollapseTiming {
  return STEP_COLLAPSE_TIMINGS.includes(String(value) as StepCollapseTiming)
    ? (String(value) as StepCollapseTiming)
    : DEFAULT_STEP_COLLAPSE_TIMING
}

export function stepDisplayPolicy(mode: unknown): StepDisplayPolicy {
  const m = normalizeStepDetailMode(mode)
  return { mode: m, ...POLICIES[m] }
}

/**
 * 该轮过程现在要不要折起来（一行「已执行 N 步」）。
 *
 * 三个条件缺一不可：本档允许折叠、这一轮**已经跑完**、用户没手动展开过。
 * `collapseTiming === 'next-input'` 时，只有在这条消息**之后又出现了新消息**才折——
 * 也就是"下次有新消息时"，而不是回答一结束就收。
 */
export function shouldFoldTurn(opts: {
  policy: StepDisplayPolicy
  isExecuting: boolean
  timing: StepCollapseTiming
  hasNewerMessage: boolean
  userExpanded: boolean
}): boolean {
  if (!opts.policy.foldCompletedTurns) return false
  if (opts.isExecuting) return false
  if (opts.userExpanded) return false
  if (opts.timing === 'next-input' && !opts.hasNewerMessage) return false
  return true
}

/** 卡片默认展开与否（用户手动展开/收起优先，见调用方） */
export function stepDefaultExpanded(mode: unknown): boolean {
  return POLICIES[normalizeStepDetailMode(mode)].defaultExpanded
}

/** 编辑类工具：优先展示差异 */
const EDIT_TOOLS = new Set(['write_file', 'replace_in_file', 'multi_replace'])

/** 读取类工具：优先展示结果 */
const RESULT_FIRST_TOOLS = new Set(['read_file', 'search_files', 'glob', 'list_dir', 'read_image', 'kb_search'])

export function isEditTool(name: unknown): boolean {
  return EDIT_TOOLS.has(String(name || ''))
}

export function isResultFirstTool(name: unknown): boolean {
  return RESULT_FIRST_TOOLS.has(String(name || ''))
}
