/**
 * agentPlanReview.ts — 计划评审（exit_plan_mode）的共享契约
 *
 * 对齐 DSH 计划模式的退出工具：agent 提交完整计划 → 用户裁决 →
 * 批准则返回成功，要求继续完善则返回**失败并带上反馈**（模型据此修订后重新提交），
 * 关闭评审则返回失败并提示用户接手。
 *
 * 传输复用 ask_user 的回答通道（`agent:answer`）：
 * - `message`    = 裁决（'approve' | 'keep' | 'dismiss'）；
 * - `answers[0].custom` = 「继续完善」时的反馈文本。
 * 这样主进程、手机/网页端、LAN 访客三条链路都不必新增通道。
 */

import type { AskUserAnswer } from '@/types/agent'

/** 计划评审裁决：批准 / 继续完善 / 关闭评审（用户接手） */
export type PlanReviewVerdict = 'approve' | 'keep' | 'dismiss'

export interface PlanReviewOutcome {
  verdict: PlanReviewVerdict
  /** 'keep' 时用户写下的反馈 */
  feedback?: string
}

/** 裁决的线上值（IPC / LAN 传输用字面量，界面按钮据此回传） */
export const PLAN_REVIEW_APPROVE = 'approve'
export const PLAN_REVIEW_KEEP = 'keep'
export const PLAN_REVIEW_DISMISS = 'dismiss'

/** 评审请求 / 回复共用的 id 前缀（`resolveAnswer` 据此路由到评审而非提问） */
export const PLAN_REVIEW_ID_PREFIX = 'review-'

/** 是否为计划评审的回复 id */
export function isPlanReviewId(id: string): boolean {
  return String(id || '').startsWith(PLAN_REVIEW_ID_PREFIX)
}

/** 反馈文本长度上限（防止把整段说明塞进输入框） */
export const PLAN_REVIEW_FEEDBACK_MAX = 4000

/**
 * 解析一条评审回复。无法识别的裁决一律按「关闭评审」处理（fail-safe：
 * 宁可让模型停下来等用户，也不要把它当成批准而擅自执行）。
 */
export function parsePlanReviewReply(message: unknown, answers?: AskUserAnswer[]): PlanReviewOutcome {
  const raw = typeof message === 'string' ? message.trim().toLowerCase() : ''
  const verdict: PlanReviewVerdict =
    raw === PLAN_REVIEW_APPROVE ? 'approve'
      : raw === PLAN_REVIEW_KEEP ? 'keep'
        : 'dismiss'
  const feedback = String(answers?.[0]?.custom ?? '').trim().slice(0, PLAN_REVIEW_FEEDBACK_MAX)
  const outcome: PlanReviewOutcome = { verdict }
  if (feedback) outcome.feedback = feedback
  return outcome
}

/** 评审结果 → 工具结果文案（主进程与渲染层共用，保证两侧措辞一致） */
export function planReviewMessage(outcome: PlanReviewOutcome): { ok: boolean; text: string } {
  if (outcome.verdict === 'approve') {
    return { ok: true, text: '用户已批准该计划，可以开始执行；执行中用 update_todo 维护进度。' }
  }
  if (outcome.verdict === 'keep') {
    const feedback = outcome.feedback ? `\n\n用户反馈：${outcome.feedback}` : '\n\n用户没有留下文字反馈。'
    return {
      ok: false,
      text: `用户选择「继续完善计划」，计划尚未批准。${feedback}\n请据此修订计划（不确定的点先用 read_file / search_files 查清），然后再次调用 exit_plan_mode 提交评审；在此之前不要开始执行。`,
    }
  }
  return {
    ok: false,
    text: '用户关闭了计划评审（既未批准也未反馈）：请停下来，把当前理解与待确认的问题简要说明后交给用户决定，不要擅自继续执行。',
  }
}
