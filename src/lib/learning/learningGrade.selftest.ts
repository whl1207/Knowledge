/**
 * learningGrade.selftest.ts — 练习判分纯函数自测
 *
 * 这一套最该钉住的不是"判对了"，而是**"判不出来的时候没有判错"**：
 * 三态里的 `null`（不判）一旦被当成 `false`（答错），学习者会因为表述方式被判错，
 * 掌握度被永久污染。DeepTutor 把它写成了 bug 记录（#1004）。
 *
 * 用法：`npm run test:selftest learningGrade`
 */

import {
  classifyPracticeType,
  expectedKeywords,
  foldText,
  gradeAnswer,
  isAutoGradable,
  OPEN_MATCH_RATIO,
  parseChoiceKeys,
  SHORT_FUZZY_RATIO,
  similarity,
} from '@/lib/learning/learningGrade'

export interface LearningGradeCase {
  name: string
  ok: boolean
  detail?: string
}

const MAP = { A: '光合作用', B: '呼吸作用', C: '蒸腾作用', D: '发酵作用' }

export function runLearningGradeSelfTest(): LearningGradeCase[] {
  const cases: LearningGradeCase[] = []
  const add = (name: string, ok: boolean, detail?: string) =>
    cases.push({ name, ok, ...(detail ? { detail } : {}) })

  // ==================== A. 不判（null）的几种情形 —— 最高优先级 ====================
  {
    add('A1 期望答案为空 → 不判', gradeAnswer({ type: 'short', expected: '', answer: '随便写' }) === null)
    add('A2 期望答案只有空白 → 不判', gradeAnswer({ type: 'short', expected: '   ', answer: '随便写' }) === null)
    add('A3 学习者没作答 → 不判（不是答错）',
      gradeAnswer({ type: 'short', expected: '牛顿', answer: '' }) === null &&
      gradeAnswer({ type: 'short', expected: '牛顿', answer: '   ' }) === null)
    add('A4 主观题从来不判', gradeAnswer({ type: 'qualitative', expected: '要点', answer: '要点' }) === null)
    add('A5a 长期望答案：全等仍判对（全等是最强证据）', (() => {
      const long = '这是一段超过三十个字符的参考答案所以不允许模糊比对因为它涉及多个要点需要逐条命中才算答对'
      return gradeAnswer({ type: 'short', expected: long, answer: long }) === true
    })())
    add('A5b 长期望答案：**不相等**时不判（不做模糊比对，也不判错）',
      gradeAnswer({
        type: 'short',
        expected: '这是一段超过三十个字符的参考答案所以不允许模糊比对因为它涉及多个要点需要逐条命中才算答对',
        answer: '这是一段超过三十个字符的参考答案但写得不完全一样所以不应该做模糊比对',
      }) === null)

    // 坏数据：期望答案映射不到任何选项 → 绝不据此判错
    add('A6 选择题：期望答案映射不到选项 → 不判',
      gradeAnswer({ type: 'choice', choiceMap: MAP, expected: '???', answer: 'A' }) === null)
    add('A7 选择题：学习者作答映射不到选项 → 不判（读不出来 ≠ 答错）',
      gradeAnswer({ type: 'choice', choiceMap: MAP, expected: 'A', answer: '我觉得是第三个' }) === null)
    add('A8 选择题没有选项表 → 退化为文本题，因此也**不判错**（只可能判对或不判）',
      gradeAnswer({ type: 'choice', choiceMap: null, expected: 'E', answer: 'Z' }) === null &&
      gradeAnswer({ type: 'choice', choiceMap: {}, expected: 'E', answer: 'E' }) === true)
    add('A8b 退化为文本题后长期望答案不相等 → 不判',
      gradeAnswer({
        type: 'choice',
        choiceMap: null,
        expected: '这是一段超过三十个字符的参考答案所以不允许模糊比对因为它涉及多个要点需要逐条命中才算答对',
        answer: '这是一段超过三十个字符的参考答案但写得不完全一样所以不应该做模糊比对',
      }) === null)
    add('A9 开放题：期望答案抽不出关键词 → 不判',
      gradeAnswer({ type: 'open', expected: '，。；', answer: '任何回答' }) === null)
  }

  // ==================== B. 选择题：按标签集合比较 ====================
  {
    const c = (expected: string, answer: string) =>
      gradeAnswer({ type: 'choice', choiceMap: MAP, expected, answer })
    add('B1 同标签 → 对', c('A', 'A') === true)
    add('B2 异标签 → 错', c('A', 'B') === false)
    add('B3 小写 / 前后空白 → 仍判对', c('A', ' a ') === true)
    add('B4 答选项正文 → 判对（不是只有标签才算）', c('A', '光合作用') === true)
    add('B5 期望写成「A. 正文」→ 判对', c('A. 光合作用', 'A') === true)
    add('B6 期望写成「A) 正文」→ 判对', c('A) 光合作用', 'A') === true)
    add('B7 全角标签 → 判对', c('A', 'Ａ') === true)

    const m = (expected: string, answer: string) =>
      gradeAnswer({ type: 'multi', choiceMap: MAP, expected, answer })
    add('B8 多选：顺序无关', m('A,C', 'C,A') === true)
    add('B9 多选：逗号 / 分号 / 空格分隔都认', m('A,C', 'A C') === true && m('A,C', 'A；C') === true)
    add('B10 多选：少选 → 错', m('A,C', 'A') === false)
    add('B11 多选：多选 → 错', m('A,C', 'A,B,C') === false)
    add('B12 多选：紧凑写法 "AC" → 判对', m('A,C', 'AC') === true)
    add('B13 多选：紧凑写法不乱认单词首字母（"AB" 不是标签时 → 不判）',
      gradeAnswer({ type: 'multi', choiceMap: MAP, expected: 'A', answer: 'AB' }) === false)
  }

  // ==================== C. 短答案 ====================
  {
    const s = (expected: string, answer: string) => gradeAnswer({ type: 'short', expected, answer })
    add('C1 完全一致 → 对', s('牛顿第二定律', '牛顿第二定律') === true)
    add('C2 大小写 / 空白差异 → 对', s('F = ma', '  f  =  MA ') === true)
    add('C3 差一个字且相似度不够 → **不判**（不是判错）', s('牛顿第二定律', '牛顿第三定律') === null,
      `v=${String(s('牛顿第二定律', '牛顿第三定律'))} sim=${similarity('牛顿第二定律', '牛顿第三定律').toFixed(3)}`)
    add('C3b 相似度够（差标点）→ 对', s('光合作用', '光合作用。') === true)
    add('C4 完全无关 → **不判**（文本题只负责证明"对"）', s('牛顿第二定律', '光合作用') === null,
      String(s('牛顿第二定律', '光合作用')))
    add('C4b 打开 allowTextWrong 才回到旧口径判错',
      gradeAnswer({ type: 'short', expected: '牛顿第二定律', answer: '光合作用', allowTextWrong: true }) === false)
    add('C5 短答案相似度阈值默认 0.85', SHORT_FUZZY_RATIO === 0.85)
    add('C5b 阈值可配：调到 0.9 后"差一点"的仍判对/不判，调到 0.6 后更容易判对',
      gradeAnswer({ type: 'short', expected: '光合作用', answer: '光合作用中', shortFuzzyRatio: 0.6 }) === true &&
      gradeAnswer({ type: 'short', expected: '光合作用', answer: '光合作用中', shortFuzzyRatio: 0.99 }) === null)
    add('C5c 期望答案长度上限可配（默认 30）',
      gradeAnswer({ type: 'short', expected: '一二三四五', answer: '一二三四五', shortFuzzyMaxChars: 2 }) === true)
  }

  // ==================== C2. 空作答：没写 ≠ 答错 ====================
  {
    const empty = [
      { type: 'short' as const, expected: '牛顿' },
      { type: 'open' as const, expected: '速度，加速度' },
      { type: 'choice' as const, expected: 'A', choiceMap: MAP },
      { type: 'multi' as const, expected: 'A,C', choiceMap: MAP },
      { type: 'qualitative' as const, expected: '要点' },
    ]
    const bad = empty.filter(c => gradeAnswer({ ...c, answer: '' }) !== null)
    add('C2.1 空作答在**所有题型**下都不判（不是判错）', bad.length === 0,
      bad.map(b => b.type).join(','))
    add('C2.2 只有空白也算空作答',
      gradeAnswer({ type: 'short', expected: '牛顿', answer: '   ' }) === null)
    add('C2.3 空作答 + 打开 allowTextWrong 仍然不判（没作答不该被记错）',
      gradeAnswer({ type: 'short', expected: '牛顿', answer: '', allowTextWrong: true }) === null)
  }

  // ==================== D. 开放题：关键词命中率 ====================
  {
    const o = (expected: string, answer: string) => gradeAnswer({ type: 'open', expected, answer })
    add('D1 命中全部关键词 → 对', o('速度，加速度', '速度与加速度的关系') === true)
    add('D2 扁平池：2 个词命中 1 个 = 0.5 < 0.6 → **不判**', o('速度，加速度', '这里只提到速度') === null,
      String(o('速度，加速度', '这里只提到速度')))
    add('D3 命中 2/3 ≈ 0.67 ≥ 0.6 → 对', o('速度，加速度，位移', '速度和加速度都提到了') === true)
    add('D4 「|」也进同一个池子：2 个要点命中 1 个 → **不判**', o('速度 | 加速度', '速度是有的') === null)
    add('D5 「|」两段都命中 → 对', o('速度 | 加速度', '速度和加速度') === true)
    add('D6 命中比例下限默认 0.6', OPEN_MATCH_RATIO === 0.6)
    add('D6b 命中比例可配',
      gradeAnswer({ type: 'open', expected: '速度，加速度', answer: '只提到速度', openMatchRatio: 0.5 }) === true)
    add('D6c 打开 allowTextWrong 才判错',
      gradeAnswer({ type: 'open', expected: '速度，加速度', answer: '只提到速度', allowTextWrong: true }) === false)
    add('D7 英文按词抽关键词', o('velocity, acceleration', 'The velocity and acceleration both matter') === true)
    add('D8 英文停用词不算关键词', expectedKeywords('the of and').length === 0)
    add('D9 单个要点：命中就对', o('光合作用', '光合作用发生在叶绿体') === true)
    add('D9b 单个要点：命不中 → **不判**', o('光合作用', '呼吸作用发生在粒线体') === null,
      String(o('光合作用', '呼吸作用发生在粒线体')))
    add('D10 关键词池去重且不含空白项',
      expectedKeywords('速度，速度 | 加速度').length === 2 &&
      expectedKeywords('，。； | ，').length === 0)
  }

  // ==================== E. 归一化与相似度 ====================
  {
    add('E1 foldText 折叠空白并转小写', foldText('  Hello   World  ') === 'hello world')
    add('E2 foldText 全角转半角', foldText('ＡＢＣ１２３') === 'abc123')
    add('E3 foldText 去首尾标点', foldText('「答案。」') === '答案')
    add('E4 相同串相似度 = 1', similarity('abc', 'abc') === 1)
    add('E5 空串相似度：都空 = 1，一空 = 0', similarity('', '') === 1 && similarity('', 'a') === 0)
    add('E6 完全不同相似度低', similarity('abcde', 'vwxyz') < 0.2, String(similarity('abcde', 'vwxyz')))
    add('E7 相似度恒在 0..1', [['a', 'b'], ['abc', 'abd'], ['中文', '中文化']].every(
      ([x, y]) => { const v = similarity(x, y); return v >= 0 && v <= 1 }))
  }

  // ==================== F. 选项标签解析 ====================
  {
    add('F1 单标签', parseChoiceKeys('A', MAP).size === 1 && parseChoiceKeys('A', MAP).has('A'))
    add('F2 「A. 正文」', parseChoiceKeys('A. 光合作用', MAP).has('A'))
    add('F3 多标签带分隔符', parseChoiceKeys('B, C', MAP).size === 2)
    add('F4 认不出来 → 空集', parseChoiceKeys('我认为是第一个', MAP).size === 0)
    add('F5 空选项表 → 空集', parseChoiceKeys('A', {}).size === 0)
  }

  // ==================== G. 题型推断与可判分判定 ====================
  {
    add('G1 列举型题干 → open', classifyPracticeType('请列举三种材料') === 'open')
    add('G2 说明型题干 → open', classifyPracticeType('说明光合作用的过程') === 'open')
    add('G3 英文 describe → open', classifyPracticeType('Describe the process') === 'open')
    add('G4 普通事实提问 → short', classifyPracticeType('什么是牛顿第二定律') === 'short')
    add('G5 参考答案很长 → open', classifyPracticeType('问题', 'x'.repeat(61)) === 'open')
    add('G6 参考答案含 | → open', classifyPracticeType('问题', '要点一 | 要点二') === 'open')
    add('G7 定性型不可自动判分', isAutoGradable({ type: 'qualitative', expectedAnswer: '要点' }) === false)
    add('G8 有期望答案 → 可判分', isAutoGradable({ type: 'short', expectedAnswer: '牛顿' }) === true)
    add('G9 期望答案空白 → 不可判分', isAutoGradable({ type: 'short', expectedAnswer: '  ' }) === false)
    add('G10 有选项表 → 可判分', isAutoGradable({ type: 'choice', choiceMap: MAP }) === true)
    add('G11 无任何钥匙 → 不可判分（走自评）', isAutoGradable({}) === false)
  }

  return cases
}
