/**
 * learningGrade.ts — 练习作答的**确定性判分**（纯函数，无 IO / 无 UI / 无 LLM）
 *
 * 设计对齐 HKUDS/DeepTutor：
 * - 三态判定 `boolean | null`（`null` = **不判**），对应它 `services/practice/answers.py:check_answer`
 *   与 `learning/grading.py:grade_answer`；
 * - **判不出来就绝不判错**：主观题、没有可判分的期望答案、题目本身畸形 —— 一律返回 `null`，
 *   由调用方交给自评（四档评分）。把"表述不清"记成"答错"是它明确踩过的坑（#1004：
 *   "marking it wrong is how a learner who typed their choice instead of tapping the card
 *   lost mastery for being right"）；
 * - 选项的正确性按**标签集合**比较，而不是字符串（`actual_keys == expected_keys`）。
 *
 * 为什么放在 `lib/`：纯输入→输出、无状态（docs/设计决策记录.md §1.2 的五判据之四）。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 练习卡题型。与 examView 的 single/multi/judge/essay 是同一族，但判分口径更保守。 */
export type PracticeQType = 'choice' | 'multi' | 'short' | 'open' | 'qualitative'

/** 一个选项：标签（A/B/C…）与选项正文是两个不同的东西，必须分开存 */
export interface PracticeOption {
  label: string
  body: string
}

/** 判分结果：true 对 / false 错 / null **不判**（交给自评） */
export type PracticeVerdict = boolean | null

export interface GradeInput extends GradeTuning {
  /** 题型。缺省按 'short' 处理（与 DeepTutor 的默认一致） */
  type?: PracticeQType
  /** 选择题：标签 → 正文。给了它且期望答案能映射到标签时，按标签集合比较 */
  choiceMap?: Record<string, string> | null
  /** 可判分的期望答案（选择题为正确标签或选项正文；主观题为参考答案） */
  expected: string
  /** 学习者的作答原文 */
  answer: string
}

// ---------------------------------------------------------------------------
// 文本归一
// ---------------------------------------------------------------------------

/**
 * 保守归一：转小写 + 折叠所有空白 + 全角字母数字转半角 + 去首尾常见标点。
 *
 * 刻意**不**做同义词、词形、繁简转换 —— 判分是永久记录，宁可返回 `null`（不判）
 * 也不要因为激进的归一化把错答案判成对。
 */
export function foldText(raw: unknown): string {
  let s = String(raw ?? '')
  // 全角 ASCII（Ａ-Ｚ ａ-ｚ ０-９）转半角
  s = s.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  s = s.replace(/[\u3000]/g, ' ')
  // 首尾标点：中英引号 / 括号（含 CJK 的「」『』【】〈〉《》）/ 句读。
  // ASCII 的 ()[] 已在上面那步由全角转半角得到，所以这里两种都要列。
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'“”‘’()[\]【】「」『』〈〉《》]+/, '')
    .replace(/[\s"'“”‘’()[\]【】「」『』〈〉《》。，、；：!?！？]+$/, '')
    .trim()
}

// ---------------------------------------------------------------------------
// 相似度（自实现，不引依赖）
// ---------------------------------------------------------------------------

function bigrams(s: string): Set<string> {
  const out = new Set<string>()
  if (s.length < 2) {
    if (s) out.add(s)
    return out
  }
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/**
 * 0..1 的字符串相似度：字符二元组与一元组的 Jaccard 取较大者。
 *
 * 为什么是两种都算：短答案（"牛顿第二定律"）一元组更有区分度；长答案（一句话）
 * 二元组才不会被共同的单字淹没。取 max 让两种场景都拿到合理的分数 —— 判分阈值
 * 才是决定严格程度的地方，相似度函数偏向"不错过"。
 */
export function similarity(a: string, b: string): number {
  const fa = foldText(a)
  const fb = foldText(b)
  if (!fa && !fb) return 1
  if (!fa || !fb) return 0
  if (fa === fb) return 1
  const uni = jaccard(new Set(fa.split('')), new Set(fb.split('')))
  const bi = jaccard(bigrams(fa), bigrams(fb))
  return Math.max(uni, bi)
}

// ---------------------------------------------------------------------------
// 选项标签解析（容错模型/导入数据的各种写法）
// ---------------------------------------------------------------------------

/**
 * 把一段文本解析成选项标签集合。
 *
 * 认这些写法（都是真实导入数据与模型输出里会出现的）：
 * `"A"` / `"a"` / `"A. 正文"` / `"A) 正文"` / `"A、正文"` / `"B,C"` / `"B C"` / `"B；C"`。
 * 认不出来返回空集 —— 调用方据此返回 `null`（不判），而不是当成错的。
 */
export function parseChoiceKeys(value: unknown, options: Record<string, string>): Set<string> {
  const raw = foldText(value)
  if (!raw) return new Set()
  const labels = Object.keys(options)
  if (!labels.length) return new Set()

  // 1) 整串恰好等于某个标签 / 选项正文 / “标签. 正文” / “标签) 正文”
  for (const key of labels) {
    const body = foldText(options[key])
    const fk = foldText(key)
    if (raw === fk || (body && raw === body)) return new Set([key])
    if (body && (raw === `${fk}. ${body}` || raw === `${fk}) ${body}` || raw === `${fk}、${body}`)) {
      return new Set([key])
    }
  }

  // 2) 多选：按分隔符切开，每段独立解析
  const parts = raw.split(/[,;，；、\s]+/).filter(Boolean)
  const keys = new Set<string>()
  for (const part of parts) {
    const hit = labels.find((key) => foldText(key) === part)
    if (hit) keys.add(hit)
  }
  if (keys.size) return keys

  // 3) 无分隔符的紧凑多选（"BC"）—— 仅当每个字符都是标签时才认，避免把单词首字母当选项
  if (parts.length === 1 && raw.length > 1) {
    const chars = raw.split('')
    if (chars.every((c) => labels.some((key) => foldText(key) === c))) {
      return new Set(labels.filter((key) => chars.includes(foldText(key))))
    }
  }
  return new Set()
}

// ---------------------------------------------------------------------------
// 开放题的关键词
// ---------------------------------------------------------------------------

/** 英文里几乎不携带答案信息的词，抽关键词时丢掉 */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'been',
  'has', 'have', 'had', 'not', 'but', 'its', 'it', 'is', 'of', 'in', 'on', 'to', 'a',
  'an', 'as', 'at', 'by', 'or', 'be', 'can', 'will', 'would', 'should', 'which',
])

/**
 * 期望答案 → 关键词**池**（扁平数组）。
 *
 * 对齐 DeepTutor `grading.py` 的原始口径：先把期望答案切成关键词，再算
 * `命中数 / 总数 >= 0.6`。切分边界包括中英标点与空白，`|` 额外表示
 * "问题库的多段答案"（`extraAnswer` 的约定）。
 *
 * ⚠️ 是**扁平池**而不是"每段都要命中"：分段会让"两个要点只说了一个"被直接判错，
 * 比命中率口径更严，也偏离了参照实现。（这点是被自测 D2 抓出来的——第一版写成了分段。）
 */
export function expectedKeywords(expected: unknown): string[] {
  const segments = String(expected ?? '').split('|')
  const out: string[] = []
  for (const seg of segments) {
    const cjk = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(seg)
    const words = cjk
      ? // 中文：按标点断句取长度 ≥ 2 的片段（中文没有词边界，不做分词）
        seg.split(/[,;，；。.、!！?？\n\r]+/).map((w) => w.trim()).filter((w) => w.length >= 2)
      : seg
          .toLowerCase()
          .split(/[^a-z0-9\u4e00-\u9fff]+/)
          .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    out.push(...words)
  }
  return Array.from(new Set(out))
}

// ---------------------------------------------------------------------------
// 判分
// ---------------------------------------------------------------------------

/** 主观题命中比例下限（`open` 判对的线） */
export const OPEN_MATCH_RATIO = 0.6
/** 短答案模糊匹配阈值：相似度 ≥ 此值**判对** */
export const SHORT_FUZZY_RATIO = 0.85
/** 只有 ≤ 这个长度的期望答案才允许模糊比对（长答案模糊比对极易误判为对） */
export const SHORT_FUZZY_MAX_CHARS = 30

/** 判分阈值（可按知识库调整严格度；不给就用默认值） */
export interface GradeTuning {
  /** `short` 判对的相似度下限，默认 0.85 */
  shortFuzzyRatio?: number
  /** 允许模糊比对的期望答案长度上限，默认 30 */
  shortFuzzyMaxChars?: number
  /** `open` 判对的关键词命中率下限，默认 0.6 */
  openMatchRatio?: number
  /**
   * 是否允许文本题**判错**。默认 false。
   *
   * 为什么默认关：字符串判分只能证明"像是答对了"，**证明不了"答错了"** ——
   * 学习者的措辞、同义词、语序都会让相似度掉到阈值以下。把它判错，
   * 就是在替学习者下一个系统没有依据的结论。关掉后，拿不准的一律 `null`（交自评）。
   * 打开（true）则维持旧口径：相似度/命中率不达标 → `false`。
   */
  allowTextWrong?: boolean
}

const DEFAULT_TUNING: Required<Pick<GradeTuning, 'shortFuzzyRatio' | 'shortFuzzyMaxChars' | 'openMatchRatio'>> = {
  shortFuzzyRatio: SHORT_FUZZY_RATIO,
  shortFuzzyMaxChars: SHORT_FUZZY_MAX_CHARS,
  openMatchRatio: OPEN_MATCH_RATIO,
}

/** 从入参里挑出调参字段（其余字段不参与） */
function pickTuning(input: GradeTuning): GradeTuning {
  const out: GradeTuning = {}
  if (typeof input.shortFuzzyRatio === 'number') out.shortFuzzyRatio = input.shortFuzzyRatio
  if (typeof input.shortFuzzyMaxChars === 'number') out.shortFuzzyMaxChars = input.shortFuzzyMaxChars
  if (typeof input.openMatchRatio === 'number') out.openMatchRatio = input.openMatchRatio
  if (typeof input.allowTextWrong === 'boolean') out.allowTextWrong = input.allowTextWrong
  return out
}

/**
 * 判分。**返回 `null` 表示"不判"**，调用方必须把它当作"没有裁决"处理
 * （交给四档自评 / AI 复核），绝不能当作"答错"。
 *
 * 各题型口径：
 * - `choice` / `multi`：选项标签集合严格相等 —— **只有这一类会返回 `false`**
 *   （因为答案唯一、可枚举，判错是有依据的）；
 * - `short`：折叠后全等，或期望答案 ≤ 30 字符时相似度 ≥ 0.85 → **判对**；
 *   其余 → `null`（**不判错**，见 `GradeTuning.allowTextWrong`）；
 * - `open`：关键词命中率 ≥ 0.6 → **判对**；其余 → `null`；
 * - `qualitative`：从来不由字符串判分，直接 `null`（它是导师/LLM 的门控）；
 * - **空作答 / 期望答案为空 → `null`**：没写答案不是答错，是"还没作答"，
 *   调用方据此显示四档自评而不是"需要再来一次"。
 */
export function gradeAnswer(input: GradeInput): PracticeVerdict {
  const type = input.type || 'short'
  const expected = String(input.expected ?? '').trim()
  const answer = String(input.answer ?? '').trim()
  const tune = { ...DEFAULT_TUNING, ...pickTuning(input) }

  // 判分需要一把"钥匙"。没有它就没有裁决 —— 而不是判错。
  if (!expected) return null
  // 空作答等于没作答，交回调用方（通常显示"请先写答案"）
  if (!answer) return null

  if (type === 'qualitative') return null

  if (type === 'choice' || type === 'multi') {
    const map = input.choiceMap || null
    if (!map || !Object.keys(map).length) {
      // 没有选项表就退化成文本题（对齐 answers.py：没有 options 走兜底路径）
      return gradeShort(expected, answer, tune)
    }
    const expectedKeys = parseChoiceKeys(expected, map)
    // 期望答案本身映射不到标签 → 题目数据坏了，绝不据此判错
    if (!expectedKeys.size) return null
    const actualKeys = parseChoiceKeys(answer, map)
    // 作答映射不到标签 → "读不出来"，不是"答错"
    if (!actualKeys.size) return null
    const same = actualKeys.size === expectedKeys.size && [...actualKeys].every((k) => expectedKeys.has(k))
    return same
  }

  if (type === 'open') return gradeOpen(expected, answer, tune)

  return gradeShort(expected, answer, tune)
}

/**
 * 短答案：**只负责证明"对"**。
 *
 * 折叠后全等、或在允许长度内相似度达标 → `true`；其余一律 `null`。
 * 不返回 `false` 的理由见 `GradeTuning.allowTextWrong`：措辞差异证明不了答错。
 */
function gradeShort(
  expected: string,
  answer: string,
  tune: { shortFuzzyRatio: number; shortFuzzyMaxChars: number; allowTextWrong?: boolean },
): PracticeVerdict {
  if (foldText(expected) === foldText(answer)) return true
  if (foldText(expected).length <= tune.shortFuzzyMaxChars) {
    const sim = similarity(expected, answer)
    if (sim >= tune.shortFuzzyRatio) return true
    // 明确"像但不够像"：旧口径在这里判错，现在是自评
    return tune.allowTextWrong ? false : null
  }
  // 长期望答案不做模糊比对（容易把"看起来像"判成对），也不判错
  return null
}

/**
 * 开放题：期望答案的关键词总命中率（扁平池，不是逐段）。
 * 同样**只负责证明"对"**；命中率不够 → `null`（除非显式打开 `allowTextWrong`）。
 */
function gradeOpen(
  expected: string,
  answer: string,
  tune: { openMatchRatio: number; allowTextWrong?: boolean },
): PracticeVerdict {
  const keywords = expectedKeywords(expected)
  if (!keywords.length) return null
  const hay = foldText(answer)
  let hit = 0
  for (const w of keywords) if (hay.includes(foldText(w))) hit++
  const ratio = hit / keywords.length
  if (ratio >= tune.openMatchRatio) return true
  return tune.allowTextWrong ? false : null
}

// ---------------------------------------------------------------------------
// 题型推断
// ---------------------------------------------------------------------------

/**
 * 由题干与可用信息推断题型。**只用来决定"怎么判"，不决定"能不能判"**。
 *
 * 关键：题型是 `short` 还是 `open` 不改变"有没有钥匙"这件事 ——
 * 只有拿到可判分的期望答案（`extraAnswer`）才可能自动判分；
 * 期望答案只有来源切片正文时，无论题干长什么样都必须走自评。
 */
export function classifyPracticeType(question: unknown, expected?: unknown): PracticeQType {
  const q = String(question ?? '')
  const exp = String(expected ?? '').trim()
  // 关键词是列举型的（"哪些/列举/步骤/特点…"）→ 开放题；否则短答案
  if (/(列举|哪些|哪几|包括|步骤|流程|特点|区别|原因|说明|阐述|论述|简述|试述|list|enumerate|describe|explain|steps|characteristics)/i.test(q)) {
    return 'open'
  }
  // 很长的参考答案本身就说明它是一段话，不是几个字
  if (exp.length > 60 || exp.includes('|')) return 'open'
  return 'short'
}

/**
 * 这条练习能不能自动判分？只有拿到**独立于切片正文**的期望答案才行。
 *
 * 调用方据此决定 UI：能判 → 显示「检查并揭示答案」；不能判 → 直接走四档自评。
 * （`extraAnswer` 为空的练习项，其 `back` 就是来源切片正文，拿它当"期望答案"
 * 等于把原文当答案，判出来必然是错的或者毫无意义。）
 */
export function isAutoGradable(item: {
  type?: PracticeQType
  expectedAnswer?: string
  choiceMap?: Record<string, string> | null
}): boolean {
  if (item.type === 'qualitative') return false
  if (item.choiceMap && Object.keys(item.choiceMap).length) return true
  return !!String(item.expectedAnswer ?? '').trim()
}
