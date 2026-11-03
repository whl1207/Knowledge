/**
 * agentRunReport.selftest.ts — 运行状态上报契约的自测
 *
 * 锁定三件事：状态白名单、摘要必填且限长、dropped 时不带问题；
 * 这些判错会导致「面板多一条假待办」或「模型以为上报成功但其实被吞」。
 *
 * 运行：npm run test:selftest runReport
 */

import {
  RUN_REPORT_STATES,
  RUN_REPORT_SUMMARY_MAX,
  normalizeRunReport,
  runReportNeedsPerson,
  runReportStateLabel,
} from './agentRunReport'

export interface RunReportCase {
  name: string
  ok: boolean
  detail?: string
}

export function runAgentRunReportSelfTest(): RunReportCase[] {
  const cases: RunReportCase[] = []
  const check = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, detail })

  // ---- 正常路径 ----
  const blocked = normalizeRunReport({ state: 'blocked', summary: '缺少数据库密码，无法继续', question: '请提供只读数据库账号' })
  check('blocked 通过', blocked.ok === true, blocked.ok ? '' : blocked.error)
  if (blocked.ok) {
    check('blocked：state/summary/question', blocked.report.state === 'blocked' && blocked.report.summary.startsWith('缺少') && blocked.report.question === '请提供只读数据库账号')
  }

  const ready = normalizeRunReport({ state: 'ready', summary: '报告写好了，等你验收' })
  check('ready 通过且无 question 字段', ready.ok === true && ready.ok && !('question' in ready.report), JSON.stringify(ready))

  const progress = normalizeRunReport({ state: 'progress', summary: '正在跑第 3 步' })
  check('progress 通过', progress.ok === true)
  const waiting = normalizeRunReport({ state: 'waiting', summary: '等下一轮触发' })
  check('waiting 通过', waiting.ok === true)
  const dropped = normalizeRunReport({ state: 'dropped', summary: '无需处理：该问题无法复现', question: '这个不该出现' })
  check('dropped 通过', dropped.ok === true)
  check('dropped：问题被静默丢弃', dropped.ok === true && !('question' in dropped.report))

  // ---- 校验：状态白名单 ----
  check('未知 state 被拒', normalizeRunReport({ state: 'done', summary: 'x' }).ok === false)
  check('缺 state 被拒', normalizeRunReport({ summary: 'x' }).ok === false)
  check('状态白名单含六态', RUN_REPORT_STATES.length === 6 && RUN_REPORT_STATES.includes('blocked') && RUN_REPORT_STATES.includes('ready'))

  // ---- 校验：摘要 ----
  check('缺 summary 被拒', normalizeRunReport({ state: 'progress' }).ok === false)
  check('空白 summary 被拒', normalizeRunReport({ state: 'progress', summary: '   ' }).ok === false)
  const longSummary = normalizeRunReport({ state: 'progress', summary: 'a'.repeat(RUN_REPORT_SUMMARY_MAX + 1) })
  check('summary 超长被拒', longSummary.ok === false)
  const trimmed = normalizeRunReport({ state: 'progress', summary: '  正常  ' })
  check('summary 去空白', trimmed.ok === true && trimmed.report.summary === '正常')

  // ---- 校验：问题 ----
  const longQ = normalizeRunReport({ state: 'blocked', summary: '卡住', question: 'q'.repeat(600) })
  check('question 超长被拒', longQ.ok === false)

  // ---- 面板判定：哪些状态需要人 ----
  check('需要人：blocked/failed/ready', runReportNeedsPerson('blocked') && runReportNeedsPerson('failed') && runReportNeedsPerson('ready'))
  check('不需要人：progress/waiting/dropped', !runReportNeedsPerson('progress') && !runReportNeedsPerson('waiting') && !runReportNeedsPerson('dropped'))

  // ---- 文案兜底（面板/工具返回共用，中英各一份） ----
  check('状态中文名', runReportStateLabel('ready', true).includes('就绪'))
  check('状态英文名', runReportStateLabel('ready', false) === 'ready for review')

  return cases
}
