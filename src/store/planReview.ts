/**
 * planReview.ts — 计划评审弹窗排队（渲染层）
 *
 * 对应 DSH 计划模式的 `exit_plan_mode`：agent 提交完整计划 → 用户裁决
 * （Approve / Keep planning + 反馈 / 关闭）→ 裁决作为工具结果回到同一个 turn。
 *
 * 与 store/askUser 同样的排队模型：一次只展示一条（先进先出），
 * 提交或关闭后自动让出下一条；界面只认本 store，不直接碰 agentBridge。
 */

import { computed, ref } from 'vue'
import type { PlanReviewVerdict } from '@/shared/agentPlanReview'

export interface PendingPlanReview {
  /** 与 agent 事件里的 reviewId 对应 */
  reviewId: string
  /** 提问方（智能体名 / 群成员名），用于弹窗标题 */
  source?: string
  /** 待评审的完整计划（Markdown） */
  plan: string
}

interface Waiter {
  resolve: (result: { verdict: PlanReviewVerdict; feedback: string }) => void
  reject: (reason?: any) => void
}

const queue = ref<PendingPlanReview[]>([])
const waiters = new Map<string, Waiter>()

/** 当前弹窗要展示的一份计划（null = 无待评审） */
export const currentReview = computed<PendingPlanReview | null>(() => queue.value[0] ?? null)
/** 队列长度（含当前展示的一条） */
export const reviewQueueLength = computed(() => queue.value.length)

/** 是否已经排着这条评审（避免恢复逻辑重复弹同一个） */
export function hasPlanReview(reviewId: string): boolean {
  return queue.value.some((q) => q.reviewId === reviewId) || waiters.has(reviewId)
}

/** 弹出计划评审（返回用户裁决；关闭 = 'dismiss'） */
export function requestPlanReview(req: PendingPlanReview): Promise<{ verdict: PlanReviewVerdict; feedback: string }> {
  return new Promise((resolve, reject) => {
    if (waiters.has(req.reviewId) || queue.value.some((q) => q.reviewId === req.reviewId)) return
    waiters.set(req.reviewId, { resolve, reject })
    queue.value = [...queue.value, req]
  })
}

/** 提交当前评审的裁决 */
export function submitPlanReview(verdict: PlanReviewVerdict, feedback = ''): void {
  settle(currentReview.value, (w) => w.resolve({ verdict, feedback }))
}

/**
 * 丢弃某条待评审（agent 侧已收口：turn 被中止 / 别处已裁决）。
 * 不产生裁决 —— 取消动作已经发生，这里只清理界面。
 */
export function dismissPlanReview(reviewId?: string): void {
  const cur = reviewId ? queue.value.find((q) => q.reviewId === reviewId) : queue.value[0]
  if (!cur) return
  settle(cur, (w) => w.reject(new Error('计划评审已失效')))
}

function settle(item: PendingPlanReview | null | undefined, done: (w: Waiter) => void): void {
  if (!item) return
  queue.value = queue.value.filter((q) => q.reviewId !== item.reviewId)
  const w = waiters.get(item.reviewId)
  waiters.delete(item.reviewId)
  if (w) done(w)
}
