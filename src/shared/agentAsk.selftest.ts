/**
 * agentAsk.selftest.ts — ask_user 结构化问答的纯逻辑自测
 *
 * 覆盖 DSH ask_user_question 契约的每个分支：多题 / 单选 / 多选 / 选项校验 /
 * 自定义回答 / 跳过语义 / 旧式纯文本兼容 / 回答归一化（脏数据不进模型上下文）。
 * 运行：npm run test:selftest agentAsk
 */

import {
  parseAskQuestions, coerceAskAnswers, askQuestionsDigest, askAnswersText,
  askAnswersToModel, isSkippedAnswer, ASK_MAX_QUESTIONS,
} from './agentAsk'
import type { AskUserQuestion } from '@/types/agent'

export interface AgentAskCase {
  name: string
  ok: boolean
  detail?: string
}

export function runAgentAskSelfTest(): AgentAskCase[] {
  const cases: AgentAskCase[] = []
  const check = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, detail })

  // ---- 结构化多题解析 ----
  const parsed = parseAskQuestions({
    questions: [
      { id: 'mode', header: '选择模式', question: '用哪种导出？', options: [{ label: '公文 (Recommended)', description: '标准红头' }, { label: '论文' }] },
      { id: 'tags', question: '要包含哪些章节？', options: [{ label: '摘要' }, { label: '结论' }], multi_select: true },
      { id: 'note', question: '还有什么要补充的？' },
    ],
  })
  check('结构化多题解析通过', parsed.ok === true, parsed.error)
  check('三题顺序与 id 保留', parsed.questions.map((q) => q.id).join(',') === 'mode,tags,note')
  check('header 保留', parsed.questions[0]?.header === '选择模式')
  check('选项 label / description 保留', parsed.questions[0]?.options?.[1]?.label === '论文' && parsed.questions[0]?.options?.[0]?.description === '标准红头')
  check('multi_select 归一为 multiSelect', parsed.questions[1]?.multiSelect === true && parsed.questions[0]?.multiSelect !== true)
  check('无选项题不产生 options', parsed.questions[2]?.options === undefined)

  // ---- 旧式纯文本兼容 ----
  const legacy = parseAskQuestions({ question: '项目放哪个目录？' })
  check('question 单问兼容', legacy.ok === true && legacy.legacy === true && legacy.questions[0]?.id === 'answer')
  check('camelCase multiSelect 也接受', parseAskQuestions({ questions: [{ id: 'a', question: 'q', options: [{ label: 'x' }], multiSelect: true }] }).questions[0]?.multiSelect === true)
  check('字符串选项也接受', parseAskQuestions({ questions: [{ id: 'a', question: 'q', options: ['甲', '乙'] }] }).questions[0]?.options?.length === 2)

  // ---- fail-loud ----
  check('两者都缺 → 拒绝', parseAskQuestions({}).ok === false)
  check('空 questions 且无 question → 拒绝', parseAskQuestions({ questions: [] }).ok === false)
  check('缺 question 字段 → 拒绝', parseAskQuestions({ questions: [{ id: 'a' }] }).ok === false)
  check('id 重复 → 拒绝', parseAskQuestions({ questions: [{ id: 'a', question: 'q1' }, { id: 'a', question: 'q2' }] }).ok === false)
  check('选项缺 label → 拒绝', parseAskQuestions({ questions: [{ id: 'a', question: 'q', options: [{}] }] }).ok === false)
  check('options 非数组 → 拒绝', parseAskQuestions({ questions: [{ id: 'a', question: 'q', options: '甲' }] }).ok === false)
  check('超题数上限 → 拒绝', parseAskQuestions({ questions: Array.from({ length: ASK_MAX_QUESTIONS + 1 }, (_, i) => ({ id: `q${i}`, question: 'q' })) }).ok === false)
  check('缺 id 自动补 q1/q2', parseAskQuestions({ questions: [{ question: 'a' }, { question: 'b' }] }).questions.map((q) => q.id).join(',') === 'q1,q2')
  check('重复选项自动去重', parseAskQuestions({ questions: [{ id: 'a', question: 'q', options: [{ label: '甲' }, { label: '甲' }] }] }).questions[0]?.options?.length === 1)

  // ---- 回答归一化 ----
  const questions: AskUserQuestion[] = parsed.questions
  const answers = coerceAskAnswers([
    { id: 'mode', selected: ['论文', '不存在的选项'] },
    { id: 'tags', selected: ['摘要', '结论', '摘要'] },
    { id: 'unknown', selected: ['x'] },
  ], questions)
  check('每题恰一条且顺序一致', answers.length === 3 && answers.map((a) => a.id).join(',') === 'mode,tags,note')
  check('未知选项 label 被丢弃', answers[0]?.selected.join(',') === '论文')
  check('多选去重', answers[1]?.selected.join(',') === '摘要,结论')
  check('未作答 = 跳过（空选择无 custom）', isSkippedAnswer(answers[2]))
  check('未知问题 id 被忽略', !answers.some((a) => a.id === 'unknown'))
  const single = coerceAskAnswers([{ id: 'mode', selected: ['论文', '公文 (Recommended)'] }], questions)
  check('单选题只保留一项', single[0]?.selected.length === 1)
  const custom = coerceAskAnswers([{ id: 'note', selected: [], custom: '  按去年的模板  ' }], questions)
  check('自定义回答去空白保留', custom[2]?.custom === '按去年的模板')
  check('自定义为空 → 无 custom 字段', coerceAskAnswers([{ id: 'note', custom: '   ' }], questions)[2]?.custom === undefined)
  check('非数组回答 → 全部按跳过', coerceAskAnswers(null, questions).every((a) => isSkippedAnswer(a)))

  // ---- 摘要 / 模型载荷 ----
  const digest = askQuestionsDigest(questions)
  check('摘要含题号 / header / 选项', digest.includes('1. ') && digest.includes('【选择模式】') && digest.includes('公文 (Recommended)') && digest.includes('可多选'), digest)
  check('纯文本摘要不含题号', askQuestionsDigest([{ id: 'answer', question: '就一个问题' }]) === '就一个问题')
  const text = askAnswersText(questions, answers)
  check('人读文本含选择与跳过', text.includes('论文') && text.includes('用户跳过'), text)
  const modelLegacy = askAnswersToModel(legacy.questions, coerceAskAnswers([{ id: 'answer', custom: 'D:/x' }], legacy.questions), true)
  check('旧式结果带 question/answer', modelLegacy.question === '项目放哪个目录？' && modelLegacy.answer === 'D:/x')
  const modelStructured = askAnswersToModel(questions, answers, false)
  check('结构化结果只有 answers', Array.isArray(modelStructured.answers) && modelStructured.question === undefined)

  return cases
}

/** 命令行入口（scripts/run-selftests.mjs 优先调用 log*） */
export function logAgentAskSelfTest(): boolean {
  const cases = runAgentAskSelfTest()
  const bad = cases.filter((c) => !c.ok)
  for (const c of cases) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
  }
  console.log(`[agentAsk] ${cases.length - bad.length}/${cases.length} passed`)
  return bad.length === 0
}
