/**
 * agentPlanReview.selftest.ts — exit_plan_mode 评审契约的纯逻辑自测
 *
 * 覆盖裁决解析（含 fail-safe）与模型可见文案：批准 = 成功、
 * 继续完善 = 失败带回反馈、关闭 = 失败提示用户接手。
 * 运行：npm run test:selftest agentPlanReview
 */

import {
  parsePlanReviewReply, planReviewMessage, isPlanReviewId,
  PLAN_REVIEW_APPROVE, PLAN_REVIEW_KEEP, PLAN_REVIEW_DISMISS, PLAN_REVIEW_ID_PREFIX,
} from './agentPlanReview'

export interface AgentPlanReviewCase {
  name: string
  ok: boolean
  detail?: string
}

export function runAgentPlanReviewSelfTest(): AgentPlanReviewCase[] {
  const cases: AgentPlanReviewCase[] = []
  const check = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, detail })

  check('评审 id 前缀识别', isPlanReviewId(`${PLAN_REVIEW_ID_PREFIX}abc`) && !isPlanReviewId('ask-abc'))

  // 裁决解析
  check('approve → 批准', parsePlanReviewReply(PLAN_REVIEW_APPROVE).verdict === 'approve')
  check('keep → 继续完善', parsePlanReviewReply(PLAN_REVIEW_KEEP).verdict === 'keep')
  check('dismiss → 关闭', parsePlanReviewReply(PLAN_REVIEW_DISMISS).verdict === 'dismiss')
  check('大小写 / 空白容错', parsePlanReviewReply('  APPROVE ').verdict === 'approve')
  check('未知裁决 fail-safe 为 dismiss', parsePlanReviewReply('yes-please').verdict === 'dismiss')
  check('非字符串裁决 fail-safe 为 dismiss', parsePlanReviewReply(undefined).verdict === 'dismiss')

  // 反馈提取
  const keep = parsePlanReviewReply(PLAN_REVIEW_KEEP, [{ id: 'feedback', selected: [], custom: '  先备份数据库  ' }])
  check('keep 带回反馈', keep.verdict === 'keep' && keep.feedback === '先备份数据库', JSON.stringify(keep))
  check('无反馈时不留字段', parsePlanReviewReply(PLAN_REVIEW_KEEP).feedback === undefined)
  check('批准不携带反馈', parsePlanReviewReply(PLAN_REVIEW_APPROVE, [{ id: 'feedback', selected: [], custom: 'x' }]).feedback === 'x')

  // 模型可见文案
  const approved = planReviewMessage({ verdict: 'approve' })
  check('批准 → 成功', approved.ok === true && approved.text.includes('已批准'), approved.text)
  const kept = planReviewMessage({ verdict: 'keep', feedback: '先备份' })
  check('继续完善 → 失败且带反馈', kept.ok === false && kept.text.includes('继续完善') && kept.text.includes('先备份'), kept.text)
  const keptNoFeedback = planReviewMessage({ verdict: 'keep' })
  check('继续完善无反馈也提示', keptNoFeedback.ok === false && keptNoFeedback.text.includes('没有留下文字反馈'))
  const dismissed = planReviewMessage({ verdict: 'dismiss' })
  check('关闭 → 失败且要求用户接手', dismissed.ok === false && dismissed.text.includes('关闭了计划评审'), dismissed.text)

  return cases
}

/** 命令行入口（scripts/run-selftests.mjs 优先调用 log*） */
export function logAgentPlanReviewSelfTest(): boolean {
  const cases = runAgentPlanReviewSelfTest()
  const bad = cases.filter((c) => !c.ok)
  for (const c of cases) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
  }
  console.log(`[agentPlanReview] ${cases.length - bad.length}/${cases.length} passed`)
  return bad.length === 0
}
