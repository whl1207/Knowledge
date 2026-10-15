/**
 * agentAsk.ts — ask_user 的结构化问答逻辑（主进程 / 渲染层 / 界面共用）
 *
 * 契约参照 DSH 的 `ask_user_question`（@deepseek-ai/dsh-tool-ask-user +
 * @deepseek-ai/dsh-user-questions）：
 * - **一次调用可问多题**：`questions: [{ id, question, header?, options?, multi_select? }]`；
 * - **单选 / 多选**：有 `options` 时按 `multi_select` 渲染单选（radio）或多选（checkbox）；
 * - **自定义回答**：每题都留自由文本位（对应回答里的 `custom`），可与选项并存；
 * - **逐题对号**：回答 `{ id, selected: string[], custom? }`，与问题一一对应（顺序 = 提问顺序）；
 * - **跳过的题**：`selected` 为空且无 `custom`（与 DSH 一致，界面据此提示「留空 = 跳过」）；
 * - **纯文本兼容**：老式 `question: "..."` 仍可用，会被归一成"一个问题 + 无选项"。
 *
 * 本模块只做纯计算（校验 / 归一 / 取摘要），不碰 IPC 与 DOM，便于自测。
 */

import type { AskUserAnswer, AskUserOption, AskUserQuestion } from '@/types/agent'

/** 单次提问的题目数上限（题目过多会撑爆弹窗，通常说明该拆成多轮） */
export const ASK_MAX_QUESTIONS = 8
/** 单题选项数上限 */
export const ASK_MAX_OPTIONS = 12
/** 题干长度上限 */
export const ASK_QUESTION_MAX = 1000
/** 短标题长度上限 */
export const ASK_HEADER_MAX = 60
/** 选项标签长度上限 */
export const ASK_LABEL_MAX = 200
/** 自定义回答长度上限 */
export const ASK_CUSTOM_MAX = 4000

export interface ParsedAskQuestions {
  ok: boolean
  questions: AskUserQuestion[]
  /** 是否走的老式单问（`question` 字符串）路径 */
  legacy: boolean
  error?: string
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * 解析一次 ask_user 的入参（fail-loud）。
 *
 * @param input 工具入参：`questions`（新，结构化）或 `question`（旧，纯文本），二者取其一
 * @returns 规范化后的问题数组；非法时 `ok=false` 并给出可直接回给模型的修正提示
 */
export function parseAskQuestions(input: any): ParsedAskQuestions {
  const rawList = input?.questions
  const legacyText = str(input?.question)

  if (Array.isArray(rawList) && rawList.length > 0) {
    if (rawList.length > ASK_MAX_QUESTIONS) {
      return { ok: false, questions: [], legacy: false, error: `一次最多提 ${ASK_MAX_QUESTIONS} 个问题（收到 ${rawList.length} 个）：请只问当前真正阻塞你的问题` }
    }
    const questions: AskUserQuestion[] = []
    const usedIds = new Set<string>()
    for (let i = 0; i < rawList.length; i++) {
      const item: any = rawList[i]
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return { ok: false, questions: [], legacy: false, error: `第 ${i + 1} 个问题不是对象：每项需为 { id, question, options?, multi_select? }` }
      }
      const text = str(item.question)
      if (!text) {
        return { ok: false, questions: [], legacy: false, error: `第 ${i + 1} 个问题缺少 question 字段（要问用户的具体问题）` }
      }
      if (text.length > ASK_QUESTION_MAX) {
        return { ok: false, questions: [], legacy: false, error: `第 ${i + 1} 个问题过长（${text.length} 字符，上限 ${ASK_QUESTION_MAX}）：请精简成一两句` }
      }
      let id = str(item.id) || `q${i + 1}`
      if (usedIds.has(id)) {
        return { ok: false, questions: [], legacy: false, error: `问题 id 重复：${JSON.stringify(id)}（同一批内 id 必须唯一，回答按 id 回填）` }
      }
      usedIds.add(id)

      const header = str(item.header)
      if (header.length > ASK_HEADER_MAX) {
        return { ok: false, questions: [], legacy: false, error: `第 ${i + 1} 个问题的 header 过长（上限 ${ASK_HEADER_MAX} 字符）` }
      }

      const options = parseOptions(item.options, i)
      if (typeof options === 'string') {
        return { ok: false, questions: [], legacy: false, error: options }
      }

      const q: AskUserQuestion = { id, question: text }
      if (header) q.header = header
      if (options.length) q.options = options
      // 兼容 snake_case（DSH 工具入参）与 camelCase（本产品界面 / 内部）
      const multi = item.multi_select ?? item.multiSelect
      if (multi === true) q.multiSelect = true
      questions.push(q)
    }
    return { ok: true, questions, legacy: false }
  }

  if (legacyText) {
    if (legacyText.length > ASK_QUESTION_MAX) {
      return { ok: false, questions: [], legacy: true, error: `question 过长（${legacyText.length} 字符，上限 ${ASK_QUESTION_MAX}）` }
    }
    return { ok: true, questions: [{ id: 'answer', question: legacyText }], legacy: true }
  }

  return {
    ok: false,
    questions: [],
    legacy: false,
    error: '需要 questions（问题数组，支持单选/多选/多题）或 question（单个问题文本）之一；每题都可留自定义回答',
  }
}

/** 解析选项列表；返回数组 = 成功，返回字符串 = 错误说明 */
function parseOptions(raw: unknown, qi: number): AskUserOption[] | string {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) return `第 ${qi + 1} 个问题的 options 必须是数组（每项为 { label, description? }）`
  const out: AskUserOption[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const label = str(typeof item === 'string' ? item : item?.label)
    if (!label) return `第 ${qi + 1} 个问题的选项缺少 label`
    if (label.length > ASK_LABEL_MAX) return `第 ${qi + 1} 个问题的选项 label 过长（上限 ${ASK_LABEL_MAX} 字符）`
    if (seen.has(label)) continue // 重复选项丢弃（不 fail：模型常把同一项写两遍）
    seen.add(label)
    const description = str((item as any)?.description)
    const option: AskUserOption = { label }
    if (description) option.description = description
    out.push(option)
  }
  if (out.length > ASK_MAX_OPTIONS) return `第 ${qi + 1} 个问题最多 ${ASK_MAX_OPTIONS} 个选项（收到 ${raw.length} 个）`
  return out
}

/**
 * 问题数组 → 一段纯文本摘要（事件载荷的 `question` 字段、工作流日志、控制台展示用）。
 */
export function askQuestionsDigest(questions: AskUserQuestion[]): string {
  return questions
    .map((q, i) => {
      const head = q.header ? `【${q.header}】` : ''
      const opts = q.options?.length
        ? `\n   选项：${q.options.map((o) => o.label).join(' / ')}${q.multiSelect ? '（可多选）' : ''}`
        : ''
      return `${questions.length > 1 ? `${i + 1}. ` : ''}${head}${q.question}${opts}`
    })
    .join('\n')
}

/**
 * 归一化界面回传的回答（防止 IPC 上来的脏数据进入模型上下文）。
 * - 每题恰好一条，顺序与提问一致；
 * - 未知 id / 未知选项 label 一律丢弃；
 * - `custom` 去空、超长截断。
 */
export function coerceAskAnswers(raw: unknown, questions: AskUserQuestion[]): AskUserAnswer[] {
  const byId = new Map<string, any>()
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const id = str(item?.id)
      if (id && !byId.has(id)) byId.set(id, item)
    }
  }
  return questions.map((q) => {
    const item = byId.get(q.id)
    const allowed = new Set((q.options || []).map((o) => o.label))
    const selected: string[] = []
    if (Array.isArray(item?.selected)) {
      for (const s of item.selected) {
        const label = str(s)
        if (!label) continue
        // 有选项时只接受真实存在的标签；无选项（纯文本题）时保留模型/界面给的原值
        if (q.options?.length && !allowed.has(label)) continue
        if (!selected.includes(label)) selected.push(label)
      }
    }
    // 单选题最多保留一项（界面已保证；这里是防线）
    if (!q.multiSelect && selected.length > 1) selected.splice(1)
    const custom = str(item?.custom).slice(0, ASK_CUSTOM_MAX)
    const answer: AskUserAnswer = { id: q.id, selected }
    if (custom) answer.custom = custom
    return answer
  })
}

/** 该题是否被显式跳过（空选择 + 无自定义） */
export function isSkippedAnswer(a: AskUserAnswer | undefined): boolean {
  return !a || (!a.selected?.length && !a.custom)
}

/**
 * 回答 → 人读文本（工具结果摘要、界面回显、日志）。
 */
export function askAnswersText(questions: AskUserQuestion[], answers: AskUserAnswer[]): string {
  const byId = new Map(answers.map((a) => [a.id, a]))
  return questions
    .map((q, i) => {
      const a = byId.get(q.id)
      const parts: string[] = []
      if (a?.selected?.length) parts.push(a.selected.join('、'))
      if (a?.custom) parts.push(a.selected?.length ? `（补充：${a.custom}）` : a.custom)
      const label = q.header || q.question
      return `${questions.length > 1 ? `${i + 1}. ` : ''}${label} → ${parts.length ? parts.join('') : '（用户跳过，未作答）'}`
    })
    .join('\n')
}

/**
 * 回答 → 回给模型的工具结果值（DSH 形状 `{ answers }`）。
 * 老式纯文本单问额外带上 `question` / `answer` 两个字段，保持既有提示词的兼容。
 */
export function askAnswersToModel(questions: AskUserQuestion[], answers: AskUserAnswer[], legacy: boolean): Record<string, any> {
  const value: Record<string, any> = { answers }
  if (legacy && questions.length === 1) {
    const a = answers[0]
    value.question = questions[0].question
    value.answer = a?.custom || (a?.selected?.length ? a.selected.join('、') : '')
  }
  return value
}
