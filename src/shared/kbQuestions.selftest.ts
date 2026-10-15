/**
 * kbQuestions.selftest.ts — 问题库纯逻辑自测
 *
 * 重点钉住 P1-3「生成选择题选项」的解析契约：
 * - 提示词约定 `问题：/选项A：正文/…/答案：B/---` 必须解析成 { text, answer:'B', choiceMap }；
 * - **同时兼容模型的偷懒写法**（`A. 正文` / `A) 正文` / `答案：选项正文` 而不是字母）；
 * - 最要紧的一条：**关闭选项开关时（纯问答输出）的解析结果必须与以前逐位一致** ——
 *   老问题库、老提示词是老用户的实际数据，解析器改动不能把它们读坏。
 *
 * 用法：`npm run test:selftest kbQuestions`
 */

import {
  normalizeChoiceAnswer,
  parseQuestionAnswerPairs,
  splitQuestionText,
} from '@/shared/kbQuestions'

export interface KbQuestionsCase {
  name: string
  ok: boolean
  detail?: string
}

export function runKbQuestionsSelfTest(): KbQuestionsCase[] {
  const cases: KbQuestionsCase[] = []
  const add = (name: string, ok: boolean, detail?: string) =>
    cases.push({ name, ok, ...(detail ? { detail } : {}) })

  // ==================== A. 选择题：提示词约定的标准格式 ====================
  {
    const raw = [
      '问题：光合作用的场所是？',
      '选项A：叶绿体',
      '选项B：粒线体',
      '选项C：细胞核',
      '选项D：液泡',
      '答案：A',
      '---',
      '问题：呼吸作用的主要产物是？',
      '选项A：氧气',
      '选项B：二氧化碳',
      '选项C：葡萄糖',
      '选项D：蛋白质',
      '答案：B',
    ].join('\n')
    const pairs = parseQuestionAnswerPairs(raw)
    add('A1 两道选择题都解析出来', pairs.length === 2, `len=${pairs.length}`)
    add('A2 题干正确', pairs[0]?.text === '光合作用的场所是？', pairs[0]?.text)
    add('A3 四个选项都进 choiceMap',
      !!pairs[0]?.choiceMap && Object.keys(pairs[0].choiceMap!).length === 4,
      JSON.stringify(pairs[0]?.choiceMap))
    add('A4 选项正文正确', pairs[0]?.choiceMap?.A === '叶绿体', pairs[0]?.choiceMap?.A)
    add('A5 答案归一成标签', pairs[0]?.answer === 'A' && pairs[1]?.answer === 'B',
      `${pairs[0]?.answer} / ${pairs[1]?.answer}`)
    add('A6 第二题独立（不串题）',
      pairs[1]?.text === '呼吸作用的主要产物是？' && pairs[1]?.choiceMap?.C === '葡萄糖')
    add('A7 题干不含选项正文（未被误吞）',
      !String(pairs[0]?.text).includes('叶绿体'))
  }

  // ==================== B. 兼容模型的偷懒写法 ====================
  {
    const dotted = [
      '问题：下列哪个是向量？',
      'A. 标量',
      'B. 有方向的量',
      'C. 矩阵',
      'D. 张量',
      '答案：B',
    ].join('\n')
    const p1 = parseQuestionAnswerPairs(dotted)
    add('B1 选项写成「A. 正文」也能解析',
      p1[0]?.choiceMap?.B === '有方向的量' && p1[0]?.answer === 'B',
      JSON.stringify(p1[0]?.choiceMap))
    const paren = ['问题：q', 'A) 甲', 'B) 乙', 'C) 丙', 'D) 丁', '答案：C'].join('\n')
    const p2 = parseQuestionAnswerPairs(paren)
    add('B2 选项写成「A) 正文」也能解析', p2[0]?.choiceMap?.D === '丁' && p2[0]?.answer === 'C')
    const bodyAns = ['问题：q', '选项A：甲', '选项B：乙', '答案：乙'].join('\n')
    const p3 = parseQuestionAnswerPairs(bodyAns)
    add('B3 答案写成选项正文 → 归一成标签', p3[0]?.answer === 'B', String(p3[0]?.answer))
    const labelAns = ['问题：q', '选项A：甲', '选项B：乙', '答案：选项B'].join('\n')
    const p4 = parseQuestionAnswerPairs(labelAns)
    add('B4 答案写成「选项B」→ 归一成 B', p4[0]?.answer === 'B', String(p4[0]?.answer))
    const bare = ['问题：q', '选项A', '甲', '选项B', '乙', '答案：甲'].join('\n')
    const p5 = parseQuestionAnswerPairs(bare)
    add('B5 选项正文写在下一行也能补上',
      p5[0]?.choiceMap?.A === '甲' && p5[0]?.choiceMap?.B === '乙', JSON.stringify(p5[0]?.choiceMap))
  }

  // ==================== C. 最要紧：关闭选项开关时行为必须与以前一致 ====================
  {
    const plain = ['问题：什么是熵？', '答案：混乱度的度量', '问题：什么是焓？', '答案：热含量'].join('\n')
    const p = parseQuestionAnswerPairs(plain)
    add('C1 纯问答：两条都解析出来', p.length === 2, `len=${p.length}`)
    add('C2 纯问答：问题与答案分开字段',
      p[0]?.text === '什么是熵？' && p[0]?.answer === '混乱度的度量')
    add('C3 纯问答：**不产生 choiceMap**', p[0]?.choiceMap === undefined && p[1]?.choiceMap === undefined)
    add('C4 纯问答：答案里带冒号不被切坏',
      parseQuestionAnswerPairs('问题：q\n答案：a：b').at(0)?.answer === 'a：b',
      String(parseQuestionAnswerPairs('问题：q\n答案：a：b').at(0)?.answer))

    // 无标签旧格式（纯问题列表）不进选择题分支
    const bareList = ['第一个问题？', '第二个问题？'].join('\n')
    const pb = parseQuestionAnswerPairs(bareList)
    add('C5 无 Q/A 标签的旧格式仍按逐行问题处理',
      pb.length === 2 && pb[0]?.text === '第一个问题？' && pb[0]?.choiceMap === undefined,
      JSON.stringify(pb))
    add('C6 无标签旧格式与 splitQuestionText 一致',
      JSON.stringify(pb.map(x => x.text)) === JSON.stringify(splitQuestionText(bareList)))

    // 正文里出现裸单字母：不能被当成答案吞掉（回归：我第一版就踩了这个坑）
    const strayLetter = ['问题：下面哪个是 A 选项', 'A', '答案：甲'].join('\n')
    const ps = parseQuestionAnswerPairs(strayLetter)
    add('C7 正文里的裸单字母不当答案（问题文本不丢）',
      (ps[0]?.text || '').includes('下面哪个是'), String(ps[0]?.text))
    add('C8 正文里的裸单字母不影响后续答案', ps[0]?.answer === '甲', String(ps[0]?.answer))
  }

  // ==================== D. 边界与容错 ====================
  {
    add('D1 空输入 → 空数组', parseQuestionAnswerPairs('').length === 0)
    add('D2 只有答案没有问题 → 忽略孤儿答案',
      parseQuestionAnswerPairs('答案：孤零零').length === 0)
    add('D3 题干空但有选项：不产出空题',
      parseQuestionAnswerPairs(['选项A：甲', '选项B：乙', '答案：A'].join('\n')).every(p => (p.text || '').trim() !== ''))
    add('D4 单选项 / 三选项也接受（不强制恰好 4 个）',
      parseQuestionAnswerPairs(['问题：q', '选项A：甲', '答案：A'].join('\n'))[0]?.choiceMap?.A === '甲',
      JSON.stringify(parseQuestionAnswerPairs(['问题：q', '选项A：甲', '答案：A'].join('\n'))[0]?.choiceMap))
    add('D5 选项标签小写 → 归一大写',
      parseQuestionAnswerPairs(['问题：q', '选项a：甲', '答案：a'].join('\n'))[0]?.choiceMap?.A === '甲',
      JSON.stringify(parseQuestionAnswerPairs(['问题：q', '选项a：甲', '答案：a'].join('\n'))[0]?.choiceMap))
    add('D6 多选答案 `A,C` 保留为标签集合',
      parseQuestionAnswerPairs(['问题：q', '选项A：甲', '选项B：乙', '选项C：丙', '答案：A,C'].join('\n'))[0]?.answer === 'A,C',
      String(parseQuestionAnswerPairs(['问题：q', '选项A：甲', '选项B：乙', '选项C：丙', '答案：A,C'].join('\n'))[0]?.answer))
  }

  // ==================== E. normalizeChoiceAnswer 单元 ====================
  {
    const M = { A: '叶绿体', B: '粒线体' }
    add('E1 已是标签 → 原样', normalizeChoiceAnswer('A', M) === 'A')
    add('E2 正文 → 标签', normalizeChoiceAnswer('粒线体', M) === 'B')
    add('E3 无选项表 → 原样返回', normalizeChoiceAnswer('粒线体', null) === '粒线体')
    add('E4 认不出来 → 原样返回（绝不硬编）', normalizeChoiceAnswer('完全不相干的回答', M) === '完全不相干的回答')
    add('E5 空白 → 空串', normalizeChoiceAnswer('   ', M) === '')
  }

  return cases
}
