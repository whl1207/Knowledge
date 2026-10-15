/**
 * learningPrompt.selftest.ts — 学习模块提示词工厂的纯函数部分
 *
 * 重点只钉**质性判定结果解析**（`parseQualitativeVerdict`）：它是"模型说的算不算通过"
 * 的唯一边界，解析失败必须返回 `null`（没判出来），**绝不能返回 `false`（判不过）** ——
 * 那会让一个本可以通过的学习者因为模型多说了一句话而被记成没掌握。
 *
 * 用法：`npm run test:selftest learningPrompt`
 */

import { aiGradePrompt, parseAiGrade, parseQualitativeVerdict, qualitativeAssessPrompt } from '@/services/learningPrompt'

export interface LearningPromptCase {
  name: string
  ok: boolean
  detail?: string
}

export function runLearningPromptSelfTest(): LearningPromptCase[] {
  const cases: LearningPromptCase[] = []
  const add = (name: string, ok: boolean, detail?: string) =>
    cases.push({ name, ok, ...(detail ? { detail } : {}) })

  // ==================== A. 解析成功路径 ====================
  {
    add('A1 标准 JSON 通过',
      parseQualitativeVerdict('{"passed": true, "feedback": "讲清了因果"}')?.passed === true)
    add('A2 标准 JSON 不通过',
      parseQualitativeVerdict('{"passed": false, "feedback": "缺了边界条件"}')?.passed === false)
    add('A3 带 ```json 代码块仍能解析',
      parseQualitativeVerdict('```json\n{"passed": true, "feedback": "ok"}\n```')?.passed === true)
    add('A4 前后带解释文字仍能解析',
      parseQualitativeVerdict('判定如下：{"passed": true, "feedback": "ok"} 以上。')?.passed === true)
    add('A5 feedback 落到 feedback 字段',
      parseQualitativeVerdict('{"passed": true, "feedback": "讲对了核心"}')?.feedback === '讲对了核心')
    add('A6 兼容 comment / reason 作为短评字段',
      parseQualitativeVerdict('{"passed": true, "comment": "c"}')?.feedback === 'c' &&
      parseQualitativeVerdict('{"passed": true, "reason": "r"}')?.feedback === 'r')
    add('A7 短评缺失时返回空串（不是 undefined 崩溃）',
      parseQualitativeVerdict('{"passed": true}')?.feedback === '')
  }

  // ==================== B. 容错：字符串布尔值 ====================
  {
    add('B1 字符串 "true" 认作通过', parseQualitativeVerdict('{"passed": "true"}')?.passed === true)
    add('B2 字符串 "false" 认作不通过', parseQualitativeVerdict('{"passed": "false"}')?.passed === false)
    add('B3 大写 / 中文布尔都能认',
      parseQualitativeVerdict('{"passed": "TRUE"}')?.passed === true &&
      parseQualitativeVerdict('{"passed": "通过"}')?.passed === true &&
      parseQualitativeVerdict('{"passed": "不通过"}')?.passed === false)
  }

  // ==================== C. 解析失败 → null（绝不判不过） ====================
  {
    add('C1 空内容 → null', parseQualitativeVerdict('') === null && parseQualitativeVerdict(null) === null)
    add('C2 没有 JSON → null', parseQualitativeVerdict('我觉得他讲得还行') === null)
    add('C3 JSON 坏了 → null', parseQualitativeVerdict('{"passed": tru') === null)
    add('C4 缺 passed 字段 → null', parseQualitativeVerdict('{"feedback": "讲得不错"}') === null)
    add('C5 passed 是数字 → null（不猜 0/1）', parseQualitativeVerdict('{"passed": 1}') === null)
    add('C6 passed 是无法识别的字符串 → null', parseQualitativeVerdict('{"passed": "maybe"}') === null)
    add('C7 JSON 不是对象 → null', parseQualitativeVerdict('[1,2,3]') === null && parseQualitativeVerdict('"x"') === null)
  }

  // ==================== D. 提示词本身的硬约束 ====================
  {
    const zh = qualitativeAssessPrompt(true, '什么是熵', '熵是混乱度', '切片原文')
    const en = qualitativeAssessPrompt(false, 'What is entropy', 'disorder', 'slice text')
    add('D1 中文提示词要求只输出 JSON', zh.includes('{"passed"') && zh.includes('JSON'))
    add('D2 中文提示词明确「用自己的措辞讲对也算过」', zh.includes('算过'))
    add('D3 中文提示词明确不许因表述加码', zh.includes('不要加码'))
    add('D4 英文提示词同样要求只输出 JSON', en.includes('{"passed"') && en.includes('ONLY'))
    add('D5 空讲解也进提示词（让模型自己判不过，而不是被前端拦掉）',
      qualitativeAssessPrompt(true, 'q', '', 's').includes('没有写任何内容'))
    add('D6 题干 / 讲解 / 切片都注入到提示词',
      zh.includes('什么是熵') && zh.includes('熵是混乱度') && zh.includes('切片原文'))
  }

  // ==================== E. AI 复核判分（aiGradePrompt / parseAiGrade） ====================
  {
    add('E1 判对', parseAiGrade('{"correct": true, "reason": "意思一致"}')?.correct === true)
    add('E2 判错', parseAiGrade('{"correct": false, "reason": "把概念搞混了"}')?.correct === false)
    add('E3 理由落到 reason 字段',
      parseAiGrade('{"correct": true, "reason": "同一个意思"}')?.reason === '同一个意思')
    add('E4 兼容 isCorrect / is_correct 键名',
      parseAiGrade('{"isCorrect": true}')?.correct === true &&
      parseAiGrade('{"is_correct": false}')?.correct === false)
    add('E5 字符串布尔也能认',
      parseAiGrade('{"correct": "true"}')?.correct === true &&
      parseAiGrade('{"correct": "正确"}')?.correct === true)

    // 最要紧的一条：模型主动"说不清"必须落回 null（没裁决），而不是判错
    add('E6 correct: null（模型主动说不清）→ null', parseAiGrade('{"correct": null, "reason": "不好判断"}') === null)
    add('E7 字符串 "null" → null', parseAiGrade('{"correct": "null"}') === null)
    add('E8 数字 / 无法识别 → null', parseAiGrade('{"correct": 1}') === null && parseAiGrade('{"correct": "maybe"}') === null)
    add('E9 解析失败一律 null（绝不判错）',
      parseAiGrade('') === null && parseAiGrade('模型说答得不错') === null &&
      parseAiGrade('{"correct": tru') === null && parseAiGrade('{"reason": "没有结论"}') === null)
    add('E10 带代码块 / 前后文字仍能解析',
      parseAiGrade('```json\n{"correct": true, "reason": "ok"}\n```')?.correct === true &&
      parseAiGrade('判定：{"correct": false, "reason": "x"} 完毕')?.correct === false)

    // 提示词硬约束
    const zh = aiGradePrompt(true, '题目', '参考答案', '我的作答', '切片')
    const en = aiGradePrompt(false, 'Q', 'ref', 'my answer', 'slice')
    add('E11 提示词要求只输出 JSON', zh.includes('{"correct"') && en.includes('{"correct"'))
    add('E12 提示词明确"只判语义不看措辞"', zh.includes('只看意思是否一致') && en.includes('meaning'))
    add('E13 提示词给出"说不清就 null"的诚实出口', zh.includes('说不清就别说') && en.includes('cannot tell'))
    add('E14 空作答也进提示词（让模型判错，而不是前端拦掉）',
      aiGradePrompt(true, 'q', 'ref', '', 's').includes('没有作答'))
  }

  return cases
}
