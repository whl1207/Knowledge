/**
 * useAskForm.ts — ask_user 回答表单的纯逻辑（Vue 响应式，但不碰 DOM / 弹窗）
 *
 * 为什么单独抽：同一套"多题 / 单选 / 多选 / 自定义回答 / 跳过"的编辑态与提交口径
 * 现在有两个消费者——聊天里的模态弹窗（AskUserDialog）与「待我处理」抽屉里的行内表单。
 * 复制一份必然漂移（DSH 契约要求未作答 = 跳过、自定义回答上限 ASK_CUSTOM_MAX），
 * 所以口径只留这一处。
 */

import { computed, reactive, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { AskUserAnswer, AskUserQuestion } from '@/types/agent'
import { ASK_CUSTOM_MAX } from '@/shared/agentAsk'

export interface AskFormQuestionState {
  /** 单选选中值（多选时不用） */
  single: string
  /** 多选选中值列表 */
  selected: string[]
  /** 自定义回答（与选项并存提交） */
  custom: string
}

export interface AskFormApi {
  /** 每题一份编辑态（key = question.id） */
  state: Record<string, AskFormQuestionState>
  /** 惰性取某题编辑态（模板可安全访问） */
  pick: (id: string) => AskFormQuestionState
  /** 多题翻页：当前下标 / 总题数 / 当前题 */
  index: Ref<number>
  total: ComputedRef<number>
  current: ComputedRef<AskUserQuestion | undefined>
  go: (step: number) => void
  /** 已作答题数（选项或自定义任一非空） */
  answeredCount: ComputedRef<number>
  /** 是否所有题都已作答 */
  allAnswered: ComputedRef<boolean>
  /** 第一道未作答题的下标；全部答完时为 -1 */
  firstUnansweredIndex: ComputedRef<number>
  /** 某题是否已作答（选项或自定义任一非空） */
  isAnswered: (id: string) => boolean
  /** 是否 DSH 约定的"推荐项"（只做视觉标记，不改 label） */
  isRecommended: (label: string) => boolean
  /** 按 questions 原顺序产出答案批；未作答的题 = selected 空且无 custom（跳过） */
  buildAnswers: () => AskUserAnswer[]
}

/**
 * @param getQuestions 题目来源（必须是 getter：模态里是 props.questions，抽屉里是条目 payload）
 */
export function useAskForm(getQuestions: () => AskUserQuestion[] | undefined): AskFormApi {
  const state = reactive<Record<string, AskFormQuestionState>>({})
  const index = ref(0)
  const questions = computed<AskUserQuestion[]>(() => getQuestions() || [])

  function reset(): void {
    for (const key of Object.keys(state)) delete state[key]
    for (const q of questions.value) state[q.id] = { single: '', selected: [], custom: '' }
    index.value = 0
  }
  watch(questions, reset, { immediate: true, deep: false })

  function pick(id: string): AskFormQuestionState {
    if (!state[id]) state[id] = { single: '', selected: [], custom: '' }
    return state[id]
  }

  const total = computed(() => questions.value.length)
  const current = computed<AskUserQuestion | undefined>(() => questions.value[index.value])

  function go(step: number): void {
    const next = index.value + step
    if (next < 0 || next > total.value - 1) return
    index.value = next
  }

  const answeredCount = computed(() => questions.value.filter((q) => isAnswered(q.id)).length)
  const allAnswered = computed(() => total.value > 0 && answeredCount.value === total.value)
  const firstUnansweredIndex = computed(() => questions.value.findIndex((q) => !isAnswered(q.id)))

  function isAnswered(id: string): boolean {
    const st = state[id]
    if (!st) return false
    return !!st.single || st.selected.length > 0 || String(st.custom || '').trim() !== ''
  }

  function isRecommended(label: string): boolean {
    return /\(\s*recommend(ed)?\s*\)|（\s*推荐\s*）|\(推荐\)/i.test(String(label || ''))
  }

  function buildAnswers(): AskUserAnswer[] {
    return questions.value.map((q) => {
      const st = pick(q.id)
      const selected = q.multiSelect ? st.selected.slice() : (st.single ? [st.single] : [])
      const custom = String(st.custom || '').trim().slice(0, ASK_CUSTOM_MAX)
      const answer: AskUserAnswer = { id: q.id, selected }
      if (custom) answer.custom = custom
      return answer
    })
  }

  return { state, pick, index, total, current, go, answeredCount, allAnswered, firstUnansweredIndex, isAnswered, isRecommended, buildAnswers }
}
