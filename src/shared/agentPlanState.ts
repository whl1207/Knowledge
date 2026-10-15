/**
 * agentPlanState.ts — 执行计划 / 待办清单的**计划式投影**（最后一条胜出）
 *
 * 参照 DSH 的 session projection：计划与待办只以「整值替换」事件落盘
 * （`plan/write` / `todo/write`），UI 与恢复都从日志**折叠**出当前值——
 * 最后一条已记录值即状态，无需额外快照，也不会出现"内存与日志不一致"。
 *
 * 为什么需要单独一层纯函数：
 * - 主进程的 `sessionLog.projectAgentState()` 与渲染层/自测共用同一套折叠语义；
 * - 折叠是纯计算（无 fs / 无 electron），可直接跑自测（见 agentPlanState.selftest.ts）。
 */

import type { TodoItem } from '@/types/agent'

/** 计划 + 待办的折叠状态（`plan=null` 表示没有计划；`todos=[]` 表示清单已清空） */
/** 尚未裁决的计划评审（进程重启后仍在日志里 → UI 可据此恢复这条待办决策） */
export interface PendingReviewState {
  reviewId: string
  plan: string
}

/** 最后一次评审裁决（审计 / 提示用） */
export interface ReviewResultState {
  reviewId: string
  /** 'approve' | 'keep' | 'dismiss' | 'cancelled'（取消/销毁时收口） */
  verdict: string
  feedback?: string
}

export interface PlanTodoState {
  plan: string | null
  todos: TodoItem[]
  /** 待评审（null = 没有挂起的评审）；本条就是"进程重启后仍需用户裁决"的状态 */
  pendingReview: PendingReviewState | null
  /** 最近一次裁决结果 */
  lastReviewResult: ReviewResultState | null
}

/** 折叠的初始值（空状态） */
export function emptyPlanTodoState(): PlanTodoState {
  return { plan: null, todos: [], pendingReview: null, lastReviewResult: null }
}

/** 折叠能识别的最小事件形状（避免依赖 SessionEvent 的具体类型定义） */
export interface PlanTodoEventLike {
  type: string
  plan?: unknown
  todos?: unknown
  reviewId?: unknown
  verdict?: unknown
  feedback?: unknown
}

/**
 * 应用一条事件（对齐 DSH `projection.apply(state, event)` 的语义）：
 * - `plan/write` → 整值替换计划（null = 清除）；
 * - `todo/write` → 整值替换清单（[] = 清除）；
 * - `plan/review` → 记下待裁决的评审；
 * - `plan/review-result` → 该评审已裁决（清待评审 + 记结果）；
 * - 其他事件 → 原样返回**同一个引用**（不制造无谓的响应式更新）。
 */
export function foldPlanTodoState(state: PlanTodoState, event: PlanTodoEventLike): PlanTodoState {
  if (!event || typeof event.type !== 'string') return state
  if (event.type === 'plan/write') {
    const plan = typeof event.plan === 'string' && event.plan.trim() ? event.plan : null
    return { ...state, plan }
  }
  if (event.type === 'todo/write') {
    return { ...state, todos: normalizeTodos(event.todos) }
  }
  if (event.type === 'plan/review') {
    const reviewId = String(event.reviewId ?? '').trim()
    const plan = typeof event.plan === 'string' ? event.plan : ''
    if (!reviewId) return state
    return { ...state, pendingReview: { reviewId, plan } }
  }
  if (event.type === 'plan/review-result') {
    const reviewId = String(event.reviewId ?? '').trim()
    if (!reviewId) return state
    const verdict = String(event.verdict ?? '').trim() || 'dismiss'
    const feedback = typeof event.feedback === 'string' && event.feedback.trim() ? event.feedback.trim() : undefined
    const result: ReviewResultState = { reviewId, verdict }
    if (feedback) result.feedback = feedback
    // 只结算"当前挂起的那一条"：迟到的结果不该把新开的评审也关掉
    const pendingReview = state.pendingReview?.reviewId === reviewId ? null : state.pendingReview
    return { ...state, pendingReview, lastReviewResult: result }
  }
  return state
}

/** 按事件顺序折叠出最终状态（最后一条胜出） */
export function foldPlanTodoEvents(events: readonly PlanTodoEventLike[]): PlanTodoState {
  let state = emptyPlanTodoState()
  for (const ev of events) state = foldPlanTodoState(state, ev)
  return state
}

/** 归一化写入日志的 todo 数组（防止脏数据进状态；宽松、不抛错） */
function normalizeTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return []
  const out: TodoItem[] = []
  for (let i = 0; i < raw.length; i++) {
    const item: any = raw[i]
    if (!item || typeof item !== 'object') continue
    const title = String(item.title ?? item.content ?? '').trim()
    if (!title) continue
    const status = String(item.status ?? '').trim() as TodoItem['status']
    const todo: TodoItem = {
      id: String(item.id || `todo-${i + 1}`),
      title,
      status: (['pending', 'running', 'done', 'cancelled'].includes(status) ? status : 'pending') as TodoItem['status'],
    }
    if (typeof item.detail === 'string' && item.detail.trim()) todo.detail = item.detail.trim()
    out.push(todo)
  }
  return out
}
