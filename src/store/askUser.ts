/**
 * askUser.ts — ask_user 弹窗排队（渲染层）
 *
 * 为什么要排队而不是各自弹一个：集群 / 工作流里可能同时有多个 agent 提问，
 * 一次只展示一条（先进先出），提交或取消后自动让出下一条。
 *
 * 契约对齐 DSH user-questions：
 * - 一次提问 = 一批问题（可多题、可单选/多选、每题可自定义回答）；
 * - 提交回结构化回答批 `{ id, selected, custom? }`，未作答的题即「跳过」；
 * - 取消 = 调用方自己的收口逻辑（通常是中止该 agent 的 turn）。
 *
 * 界面侧只认 store/askUser，不直接碰 agentBridge；这样聊天、集群、控制台、
 * 工作流四个入口共用同一个弹窗（AskUserHost.vue 挂在 App.vue）。
 */

import { computed, ref } from 'vue'
import type { AskUserAnswer, AskUserQuestion } from '@/types/agent'

export interface PendingAsk {
  /** 与 agent 事件里的 askId 对应（同一会话同一时刻只有一个待答） */
  askId: string
  /** 提问方（智能体名 / 群成员名），用于弹窗标题 */
  source?: string
  questions: AskUserQuestion[]
  /** 用户点了取消时的收口（调用方决定：中止 turn / 跳过） */
  onCancel?: () => void
}

interface Waiter {
  resolve: (answers: AskUserAnswer[]) => void
  reject: (reason?: any) => void
}

const queue = ref<PendingAsk[]>([])
const waiters = new Map<string, Waiter>()

/** 当前弹窗要展示的一批问题（null = 无待答） */
export const currentAsk = computed<PendingAsk | null>(() => queue.value[0] ?? null)
/** 队列长度（含当前展示的一条） */
export const askQueueLength = computed(() => queue.value.length)

/**
 * 弹窗问用户（返回结构化回答批）。同一 askId 重复调用只保留一条。
 */
export function requestUserAnswers(req: PendingAsk): Promise<AskUserAnswer[]> {
  return new Promise<AskUserAnswer[]>((resolve, reject) => {
    if (waiters.has(req.askId) || queue.value.some((q) => q.askId === req.askId)) {
      // 同一问题的重复事件（重连/重放）不重复弹窗
      return
    }
    waiters.set(req.askId, { resolve, reject })
    queue.value = [...queue.value, req]
  })
}

/** 提交当前弹窗的回答 */
export function submitAsk(answers: AskUserAnswer[]): void {
  settle(queue.value[0], (w) => w.resolve(answers))
}

/** 用户取消当前弹窗（调用 onCancel → 通常是中止 turn） */
export function cancelAsk(): void {
  const cur = queue.value[0]
  const onCancel = cur?.onCancel
  settle(cur, (w) => w.reject(new Error('用户取消了提问')))
  try { onCancel?.() } catch { /* 收口失败不影响队列 */ }
}

/**
 * 丢弃某条待答（agent 侧已收口：turn 被中止 / 别处已回答）。
 * 不触发 onCancel —— 取消动作已经发生，这里只清理界面。
 * 传 askId 时在整条队列里找（可能不在队首）；不传则丢弃队首。
 */
export function dismissAsk(askId?: string): void {
  const cur = askId ? queue.value.find((q) => q.askId === askId) : queue.value[0]
  if (!cur) return
  settle(cur, (w) => w.reject(new Error('提问已失效')))
}

/** 清空全部待答（切换会话 / 销毁视图时用） */
export function clearAsks(): void {
  const all = queue.value
  queue.value = []
  for (const q of all) {
    const w = waiters.get(q.askId)
    waiters.delete(q.askId)
    w?.reject(new Error('提问已失效'))
  }
}

function settle(item: PendingAsk | undefined, done: (w: Waiter) => void): void {
  if (!item) return
  queue.value = queue.value.filter((q) => q.askId !== item.askId)
  const w = waiters.get(item.askId)
  waiters.delete(item.askId)
  if (w) done(w)
}

/**
 * 兼容旧载荷：agent 事件只有 `question` 文本时，合成为"单个自由填写题"。
 */
export function questionsOf(pending: { question: string; questions?: AskUserQuestion[] }): AskUserQuestion[] {
  if (Array.isArray(pending.questions) && pending.questions.length) return pending.questions
  return [{ id: 'answer', question: String(pending.question || '') }]
}
