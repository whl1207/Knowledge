/**
 * stepDisplay.selftest.ts — 工作步骤展示策略（四档 + 收起时机）的纯逻辑自测
 *
 * 覆盖：四档策略表的开关组合、未知值归一、编辑/读取类工具分类、
 * 以及 shouldFoldTurn 的三个条件（档位允许 / 已跑完 / 收起时机 + 用户手动展开）。
 */

import {
  DEFAULT_STEP_COLLAPSE_TIMING,
  DEFAULT_STEP_DETAIL_MODE,
  STEP_COLLAPSE_TIMINGS,
  STEP_DETAIL_MODES,
  isEditTool,
  isResultFirstTool,
  normalizeStepCollapseTiming,
  normalizeStepDetailMode,
  shouldFoldTurn,
  stepDisplayPolicy,
} from './stepDisplay'

export interface StepDisplayCase {
  name: string
  ok: boolean
  detail?: string
}

export function runStepDisplaySelfTest(): StepDisplayCase[] {
  const cases: StepDisplayCase[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  add('默认档位是 standard', DEFAULT_STEP_DETAIL_MODE === 'standard')
  add('默认收起时机是 completion', DEFAULT_STEP_COLLAPSE_TIMING === 'completion')
  add('四个档位齐全', STEP_DETAIL_MODES.join(',') === 'compact,standard,detailed,verbose')
  add('两种收起时机', STEP_COLLAPSE_TIMINGS.join(',') === 'completion,next-input')

  add('未知档位归一到 standard', normalizeStepDetailMode('weird') === 'standard')
  add('未知时机归一到 completion', normalizeStepCollapseTiming('weird') === 'completion')
  add('合法档位原样返回', normalizeStepDetailMode('verbose') === 'verbose')

  const compact = stepDisplayPolicy('compact')
  const standard = stepDisplayPolicy('standard')
  const detailed = stepDisplayPolicy('detailed')
  const verbose = stepDisplayPolicy('verbose')

  add('简洁档：折叠 + 无摘要行 + 不保留思考预览', compact.foldCompletedTurns && !compact.showSummaryLine && !compact.settledReasoningPreview)
  add('简洁档：卡片默认折叠', compact.defaultExpanded === false)
  add('标准档：折叠 + 有摘要行', standard.foldCompletedTurns && standard.showSummaryLine)
  add('标准档：卡片默认折叠', standard.defaultExpanded === false)
  add('详细档：卡片默认展开', detailed.defaultExpanded === true && detailed.foldCompletedTurns === true)
  add('完全展开：不折叠、默认展开', !verbose.foldCompletedTurns && verbose.defaultExpanded === true)
  add('差异优先：简洁/标准/详细开，完全展开关', compact.diffFirst && standard.diffFirst && detailed.diffFirst && !verbose.diffFirst)
  add('结果优先：标准/详细开，完全展开关（参数与结果都显示）', standard.resultFirst && detailed.resultFirst && !verbose.resultFirst)

  add('编辑类工具识别', isEditTool('write_file') && isEditTool('replace_in_file') && isEditTool('multi_replace') && !isEditTool('read_file'))
  add('读取类工具识别', isResultFirstTool('read_file') && isResultFirstTool('search_files') && isResultFirstTool('glob') && !isResultFirstTool('shell'))

  // 收起时机：completion 立即折叠；next-input 要等新消息
  const base = { policy: standard, isExecuting: false, userExpanded: false }
  add('completion：跑完即折叠', shouldFoldTurn({ ...base, timing: 'completion', hasNewerMessage: false }) === true)
  add('next-input：没有新消息不折叠', shouldFoldTurn({ ...base, timing: 'next-input', hasNewerMessage: false }) === false)
  add('next-input：有新消息才折叠', shouldFoldTurn({ ...base, timing: 'next-input', hasNewerMessage: true }) === true)
  add('运行中永不折叠', shouldFoldTurn({ ...base, isExecuting: true, timing: 'completion', hasNewerMessage: true }) === false)
  add('用户手动展开优先', shouldFoldTurn({ ...base, userExpanded: true, timing: 'completion', hasNewerMessage: true }) === false)
  add('完全展开档永不折叠', shouldFoldTurn({ policy: verbose, isExecuting: false, userExpanded: false, timing: 'completion', hasNewerMessage: true }) === false)

  return cases
}
