/**
 * useAskForm.selftest.ts — ask_user 表单的「逐题确认」状态
 *
 * 锁住弹窗/待我处理共用的判定：
 * - 只答第一题时 allAnswered=false、firstUnansweredIndex 指向第二题；
 * - 主按钮据此显示「下一题」而不是提交；
 * - 选项 / 多选 / 自定义任一非空才算已答；空白自定义不算。
 */

import { useAskForm } from './useAskForm'
import type { AskUserQuestion } from '@/types/agent'

export interface AskFormCase { name: string; ok: boolean; detail?: string }

export function runAskFormSelfTest(): AskFormCase[] {
  const cases: AskFormCase[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  const questions: AskUserQuestion[] = [
    { id: 'q1', question: '第一题', options: [{ label: 'A' }, { label: 'B' }] },
    { id: 'q2', question: '第二题', options: [{ label: 'C' }, { label: 'D' }] },
    { id: 'q3', question: '第三题' },
  ]
  const form = useAskForm(() => questions)

  add('初始未答', form.answeredCount.value === 0 && form.allAnswered.value === false)
  add('初始第一道未答是第 1 题', form.firstUnansweredIndex.value === 0)

  form.pick('q1').single = 'A'
  add('只答第一题：已答 1 / 全部未答完', form.answeredCount.value === 1 && form.allAnswered.value === false)
  add('只答第一题：下一道未答是第 2 题', form.firstUnansweredIndex.value === 1)
  add('只答第一题：不能直接当作全部完成', form.allAnswered.value === false)

  form.pick('q2').selected = ['C', 'D']
  add('第二题多选计入已答', form.answeredCount.value === 2 && form.firstUnansweredIndex.value === 2)

  form.pick('q3').custom = '   '
  add('空白自定义不算已答', form.answeredCount.value === 2 && form.allAnswered.value === false)

  form.pick('q3').custom = '补充说明'
  add('三题答完：allAnswered=true', form.allAnswered.value === true && form.firstUnansweredIndex.value === -1)
  add('答案按题序产出',
    form.buildAnswers().map((a) => a.id).join(',') === 'q1,q2,q3'
    && form.buildAnswers()[2].custom === '补充说明')

  add('单题也遵循同一判定', (() => {
    const one = useAskForm(() => [{ id: 'only', question: '只问一题' }])
    const before = one.allAnswered.value === false && one.firstUnansweredIndex.value === 0
    one.pick('only').single = 'yes'
    return before && one.allAnswered.value === true && one.firstUnansweredIndex.value === -1
  })())

  return cases
}
