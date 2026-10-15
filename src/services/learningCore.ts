/**
 * 学习引擎（纯函数，无 IO/UI 依赖）——掌握度 + 间隔复习 + 题目拆分
 * 设计思路参考 HKUDS/DeepTutor learning 引擎（仅借鉴算法，不引代码）：
 * - computeMastery：近期加权正确率 + 低置信度封顶（单次蒙对不能算掌握）
 * - SRS：按知识类型采用不同间隔表，连对跳档、连错倒退、连续错 2 次重置
 * - 知识类型化（P2.5）：memory / procedure / concept / design 走不同复习节奏
 * - SRS 锚点（P0，对齐 DeepTutor scheduler.py 的 last_scheduled_at）：同会话内的重复练习
 *   只刷新回忆、**不推后已定到期日**；否则一天里连练几次 due 就往后跳几次，永远不到期
 * - 证据质量（P0，对齐 DeepTutor scheduler.py 的 _resolved_quality）：看过答案/用了提示的
 *   作答要按提示数扣分，不能让"重刷同一组卡"把 0.9 的门控刷过去
 * - 四档评分（P1，对齐 DeepTutor services/practice/scheduler.py 的 Rating）：判不了分的
 *   题由学习者自评 again / hard / good / easy，档位含义与它逐位一致
 */
import type { PracticeOption, PracticeQType } from '@/lib/learning/learningGrade'

export type { PracticeOption, PracticeQType }

export const MASTERY_GATE = 0.9
/** 近期权重：最旧 -> 最新，越新越重（先错后对 > 先对后错） */
const RECENCY_WEIGHTS = [0.5, 0.7, 0.85, 0.95, 1.0]
/** 低置信度封顶：尝试次数太少时掌握度不能超过该值 */
const CONFIDENCE_CAP: Record<number, number> = { 1: 0.5, 2: 0.8 }

/** 由一次对/错序列计算 0..1 掌握度 */
export function computeMastery(correctness: boolean[]): number {
  if (!correctness.length) return 0
  const recent = correctness.slice(-RECENCY_WEIGHTS.length)
  const weights = RECENCY_WEIGHTS.slice(RECENCY_WEIGHTS.length - recent.length)
  let score = 0
  let total = 0
  for (let i = 0; i < recent.length; i++) {
    score += (recent[i] ? 1 : 0) * weights[i]
    total += weights[i]
  }
  const acc = total ? score / total : 0
  const cap = CONFIDENCE_CAP[recent.length] !== undefined ? CONFIDENCE_CAP[recent.length] : 1
  return Math.min(acc, cap)
}

// ==================== 证据质量（独立完成 / 提示成本） ====================
/**
 * 一次作答的"独立性"输入。旧记录没有这些字段时按「独立、零提示、第 1 次」处理，
 * 因此历史 .learning 的掌握度与改动前完全一致（不会因为升级而集体掉分）。
 */
export interface EvidenceInput {
  ok: boolean
  /** 是否未看答案/未用提示完成（缺省 true） */
  independent?: boolean
  /** 本题用了几个提示 / 看过几次答案（缺省 0） */
  hintsUsed?: number
  /** 这是对同一题的第几次尝试，1 起（缺省 1） */
  attemptNo?: number
}

/** 独立答对的基础分 */
const QUALITY_OK = 1
/** 看过答案/用了提示之后答对的折价：独立回忆的强度只有一部分 */
const QUALITY_PEEKED = 0.4
/** 每多用一次提示再乘一次 */
const HINT_FACTOR = 0.6
/** 对同一题多试一次的折价（第 2 次起） */
const RETRY_FACTOR = 0.85
/**
 * 由一次作答算 0..1 的证据质量（对照 DeepTutor `_resolved_quality`）。
 *
 * 关键取舍（它那里是 `_FAIL_QUALITY = 0.5` 这条线）：
 * - **答错 = 0**；
 * - **独立答对 = 1**；
 * - **看过答案/用了提示之后答对 < 0.5** —— 于是它**推不开任何一档的掌握度门**。
 *   这正是要的效果：看过答案的「记得」是复述，不是回忆；把答案背下来不该算掌握。
 * - 同一题反复试（第 2 次起）也折价，同样进不了门。
 *
 * 下限 0.1 而不是 0：保留"这个知识点已经碰过"的信息，供将来的遗忘曲线 / 状态展示用。
 * 旧记录缺字段时恒为 1（独立、零提示、第 1 次）→ 历史掌握度不因升级而变动。
 */
export function evidenceQuality(a: EvidenceInput): number {
  if (!a.ok) return 0
  let q: number = QUALITY_OK
  if (a.independent === false) q *= QUALITY_PEEKED
  const hints = Math.max(0, Number(a.hintsUsed) || 0)
  if (hints) q *= Math.max(0.4, HINT_FACTOR ** hints)
  const extra = Math.max(0, (Number(a.attemptNo) || 1) - 1)
  if (extra) q *= RETRY_FACTOR ** extra
  return Math.max(0.1, Math.min(1, q))
}

/** 「算不算一次成功回忆」的质量线，与 DeepTutor 的 `_FAIL_QUALITY` 同值 */
export const QUALITY_PASS = 0.5

/**
 * 由整组作答算掌握度：先按证据质量折算 ok，再走原 `computeMastery`。
 * 于是"看过答案的 5 次全对"得 0（5 次都不算成功回忆），而
 * "看过 1 次 + 之后独立答对 4 次"得 0.875 —— 一次偷看不会被永久记账，但也不能靠它开门。
 */
export function computeMasteryFromEvidence(items: EvidenceInput[]): number {
  return computeMastery(items.map(a => evidenceQuality(a) >= QUALITY_PASS))
}

// ==================== 四档评分（自评） ====================
/**
 * 四档评分，语义与 DeepTutor `services/practice/scheduler.py` 的 `Rating` 逐位一致：
 * - `again` 本轮重新练（它那里 interval = 10 分钟，等于"今天再来一次"）
 * - `hard`  我需要提示（间隔 ×1.2，不推进档位）
 * - `good`  几天后再复习（按档位推进，首次给 3 天）
 * - `easy`  很有把握（额外 ×1.3）
 *
 * 只有**判不了分**的题才让学习者自评；判得出分的题由 `gradeAnswer` 直接给
 * `good` / `again`，不给学习者改判的机会（对齐它 `rate(correct ? 'good' : 'again')`）。
 */
export type SrsRating = 'again' | 'hard' | 'good' | 'easy'
export const SRS_RATINGS: SrsRating[] = ['again', 'hard', 'good', 'easy']

/** 判分结果 → 评分档：对给 good，错给 again（学习者无从改判） */
export function ratingFromVerdict(correct: boolean): SrsRating {
  return correct ? 'good' : 'again'
}

/** 评分的 i18n 文案键（与它 RATINGS 的四条说明同义） */
export const RATING_LABELS: Record<SrsRating, { zh: string; en: string; hintZh: string; hintEn: string }> = {
  again: { zh: '再来一次', en: 'Again', hintZh: '本轮再练一遍', hintEn: 'Practice again this round' },
  hard: { zh: '有点难', en: 'Hard', hintZh: '我需要提示', hintEn: 'I needed a hint' },
  good: { zh: '记住了', en: 'Mastered', hintZh: '过几天再复习', hintEn: 'Review in a few days' },
  easy: { zh: '很简单', en: 'Easy', hintZh: '我很有把握', hintEn: 'I knew it confidently' },
}

/**
 * 该评分是否算「这次回忆成功」。
 *
 * 返回 false 的评分会走 `srsNext` 的答错分支——但**同会话窗口内不会掉档**
 * （`srsNext` 的同会话分支会先把它挡掉），所以"本轮再来一次"只影响本轮，
 * 不会因为当场重练而把长期间隔打回去。
 */
export function ratingIsSuccess(r: SrsRating): boolean {
  return r !== 'again'
}

export type ObjStatus = 'new' | 'learning' | 'mastered'
/** @deprecated 单门控口径。新代码请用 `LObject` 的 `qualitativePass` / `masteredAt`（见 learningRecord.objectStatus） */
export function objStatus(m: number): ObjStatus {
  if (m <= 0) return 'new'
  return m >= MASTERY_GATE ? 'mastered' : 'learning'
}

// ==================== 双门控（P1-2） ====================
/**
 * 掌握有**两种门**，走哪一种是知识点类型决定的：
 *
 * - `quantitative`（memory / procedure，以及**有答案键**的 short/open 题）：
 *   近期加权正确率 ≥ 0.9。注释里那句"~0.9 mirrors Alpha School 的 90% before you advance"
 *   是参照实现的原话，`MASTERY_GATE` 就是它。
 * - `qualitative`（concept / design，以及**没有答案键**的开放/复述题）：
 *   由导师判定的 Feynman 式讲解是否足够，**bool 而不是分数** ——
 *   因为这类知识点"rarely a single canonical right answer to match against"，
 *   用正确率判它既不成立（答对但表述不同会被判错），也容易被蒙对两次越过。
 */
export type GateKind = 'quantitative' | 'qualitative'

/** 该类型是否走质性门控 */
export const QUALITATIVE_TYPES: KbType[] = ['concept', 'design']

/**
 * 一个学习对象（或一道练习）该走哪种门 —— **只看知识类型**。
 *
 * 为什么不让"有没有答案键"参与判定：门是**落在知识点上的**，而知识点（文件对象）
 * 是 `concept` 型就意味着它的掌握要靠讲解来判。如果因为该文件下恰好有一道题带答案键
 * 就把整个知识点切成量化门，同一个知识点的门会在两次练习之间来回跳 —— 门必须稳定。
 *
 * 答案键只决定**单道题怎么结算**（判分 / 自评），不决定知识点走哪种门。
 */
export function gateKindOf(type: KbType | null | undefined): GateKind {
  return QUALITATIVE_TYPES.includes((type || 'memory') as KbType) ? 'qualitative' : 'quantitative'
}

/**
 * 该知识点用于**门控**的掌握度。
 *
 * 质性通过 → 1.0 展示（对齐它 `display_mastery` 的 `_QUALITATIVE_PASS_DISPLAY = 1.0`）：
 * 质性掌握本身是 bool，但地图要有一个数才画得出颜色，映射成 1 保证
 * **地图配色与门控结论永远一致**，不会出现"图上 60% 但门已经开了"这种自相矛盾。
 */
export function displayMastery(mastery: number, qualitativePass: boolean | undefined, qualitativeGate: boolean): number {
  if (qualitativeGate && qualitativePass) return 1
  return Math.max(0, Math.min(1, Number(mastery) || 0))
}

/**
 * 硬门控：这个知识点算不算已掌握。
 *
 * 与「学习者声明掌握」分开：声明可以让路线前进，但**来源必须可区分**
 * （调用方读 `claimMastered` 单独展示），不能用声明冒充评测通过。
 */
export function isGatePassed(args: {
  mastery: number
  qualitativePass?: boolean
  qualitativeGate: boolean
  masteredAt?: number
  claimMastered?: boolean
}): boolean {
  if (args.claimMastered) return true
  if (args.qualitativeGate) return !!args.qualitativePass
  return args.mastery >= MASTERY_GATE || !!args.masteredAt
}

/** 掌握来源：`system`（评测通过）/ `learner`（学习者声明）/ `''`（未过门） */
export function masterySource(args: {
  mastery: number
  qualitativePass?: boolean
  qualitativeGate: boolean
  masteredAt?: number
  claimMastered?: boolean
}): 'system' | 'learner' | '' {
  if (args.qualitativeGate ? !!args.qualitativePass : (args.mastery >= MASTERY_GATE || !!args.masteredAt)) return 'system'
  if (args.claimMastered) return 'learner'
  return ''
}

/** 对象状态（供地图/总览/图谱统一口径） */
export function objectStatusOf(args: {
  mastery: number
  qualitativePass?: boolean
  qualitativeGate: boolean
  masteredAt?: number
  claimMastered?: boolean
}): ObjStatus {
  if (isGatePassed(args)) return 'mastered'
  if (args.mastery > 0 || args.qualitativePass === false || !!args.masteredAt) return 'learning'
  return 'new'
}

/** 质性判定结果（由模型给出的 Feynman 检查） */
export interface QualitativeVerdict {
  /** 讲解是否足以判定为掌握 */
  passed: boolean
  /** 模型给的短评（存为证据，展示给学习者） */
  feedback: string
}

// ==================== 知识类型（分型间隔复习） ====================
/** 学习对象/切片的知识类型：记忆(事实) / 程序(步骤技能) / 概念(需理解) / 设计(开放判断) */
export type KbType = 'memory' | 'procedure' | 'concept' | 'design'
export const KB_TYPES: KbType[] = ['memory', 'procedure', 'concept', 'design']

/** 每类知识点的复习间隔（天）：内容越“理解型”首次间隔越晚 */
export const TYPE_INTERVALS: Record<KbType, number[]> = {
  memory: [1, 3, 7, 14, 30, 60],
  procedure: [3, 7, 14, 30],
  concept: [3, 7, 14, 30, 60],
  design: [14, 28, 60],
}

/** 某类型的间隔表（缺省 memory，兼容旧数据） */
export function srsIntervals(type?: KbType | null): number[] {
  if (type && TYPE_INTERVALS[type]) return TYPE_INTERVALS[type]
  return TYPE_INTERVALS.memory
}

/** 由文本启发式猜测知识类型（无命中默认 memory） */
const TYPE_PATTERNS: { type: KbType; re: RegExp }[] = [
  {
    type: 'design',
    re: /(权衡|取舍|优缺点|评估|设计原则|架构选型|开放|你认为|如果.{0,12}(会|能|是否)|judg(e|ment)|trade-?off|evaluate|compare|pros? and cons?)/i,
  },
  {
    type: 'procedure',
    re: /(步骤|流程|怎么|如何|如何做|执行|命令|代码|配置|安装|调用|实现|procedure|step|how[- ]to|run|execute|install|command|api|cli)/i,
  },
  {
    type: 'concept',
    re: /(定义|概念|本质|区别|是什么|含义|分类|机制|原理|model|define|concept|meaning|what is|vs|difference|mechanism|theory)/i,
  },
]
export function guessKbType(text: string): KbType {
  const t = String(text || '')
  for (const p of TYPE_PATTERNS) if (p.re.test(t)) return p.type
  return 'memory'
}

/** 取一组文本中最常见类型（用于把切片的类型聚合到文件对象） */
export function dominantKbType(texts: string[]): KbType {
  const counts: Record<KbType, number> = { memory: 0, procedure: 0, concept: 0, design: 0 }
  for (const tx of texts) counts[guessKbType(tx)]++
  let best: KbType = 'memory'
  let bestN = -1
  for (const k of KB_TYPES) if (counts[k] > bestN) { best = k; bestN = counts[k] }
  return best
}

export function kbTypeLabel(type?: KbType | null, zh = true): string {
  switch (type) {
    case 'memory': return zh ? '记忆' : 'Memory'
    case 'procedure': return zh ? '步骤' : 'Procedure'
    case 'concept': return zh ? '概念' : 'Concept'
    case 'design': return zh ? '设计' : 'Design'
    default: return zh ? '记忆' : 'Memory'
  }
}
export function kbTypeIcon(type?: KbType | null): string {
  switch (type) {
    case 'procedure': return 'fa fa-list-ol'
    case 'concept': return 'fa fa-lightbulb-o'
    case 'design': return 'fa fa-puzzle-piece'
    default: return 'fa fa-database'
  }
}

// ==================== 间隔复习 ====================
/** 兼容导出：记忆型间隔表（天） */
export const SRS_INTERVALS_DAYS = TYPE_INTERVALS.memory
const DAY_MS = 86400000

export interface Lsrs {
  idx: number
  consecOk: number
  consecMiss: number
  dueAt: number
  /**
   * 最后一次真实作答时间（同会话重复练习只更新它）。
   * 缺省 = 旧记录，按「没有作答历史」处理。
   */
  lastReviewAt?: number
  /**
   * **设定当前 dueAt 的那一次**的时间锚点。
   *
   * 为什么必须有它：`dueAt` 若按 `now + 间隔` 重算，一天内连练 5 次 due 就往后跳 5 次，
   * 到期日永远不来。有锚点后 dueAt 恒等于 `lastScheduledAt + 当前档间隔`，
   * 同会话内的重复练习**一个字节都不动它**。
   *
   * 缺省 = 旧记录：首次推进时用当时时间兜底建锚（行为与改动前一致），不改变既有到期日。
   */
  lastScheduledAt?: number
}

/** 同会话重复练习的判定窗口上限（天）：低于此间隔内的作答不推后到期日 */
export const SAME_SESSION_DAYS = 0.25

/**
 * 当前档位对应的间隔（天）。落在表尾时返回表尾值——因此 dueAt 恒为
 * `lastScheduledAt + intervals[idx]`，不会因为反复作答而无限累加。
 */
function intervalDaysAt(its: number[], idx: number): number {
  const i = Math.max(0, Math.min(Math.floor(idx) || 0, its.length - 1))
  return its[i]
}

export function initSrs(now: number, type?: KbType | null): Lsrs {
  const its = srsIntervals(type)
  return {
    idx: 0,
    consecOk: 0,
    consecMiss: 0,
    dueAt: now + its[0] * DAY_MS,
    lastScheduledAt: now,
  }
}

export function isSrsDue(s: Lsrs, now: number): boolean {
  return s.dueAt <= now
}

/**
 * 推进 SRS。两个容易写错、且都已被自测钉住的点：
 *
 * 1. **同会话内的重复练习不推后到期日**（对齐 DeepTutor `scheduler.py` 的
 *    `same_session_days` 分支）。窗口 = `min(0.25 天, 当前间隔的一半)`——
 *    随间隔缩放，所以 14 天起步的 design 型不会把整场学习都当成"同一次练习"，
 *    而 1 天起步的 memory 型能正确识别"今天已经练过了"。
 *    判定的时间锚点取 `lastReviewAt ?? lastScheduledAt`：**首次作答也算在内**，
 *    否则 `initSrs` 刚建完的到期日会被第一次作答推后一次。
 * 2. **dueAt 基于 `lastScheduledAt` 重算，而不是 `now`**。这是"due 永不到期"的根因。
 */
export function srsNext(
  s: Lsrs,
  ok: boolean,
  now: number,
  type?: KbType | null,
  rating?: SrsRating | null,
): Lsrs {
  const its = srsIntervals(type)
  const maxIdx = its.length - 1
  const st: Lsrs = { ...s }
  const prevIdx = Math.max(0, Math.min(Math.floor(st.idx) || 0, maxIdx))

  // 1. 同会话重复练习：只刷新回忆，不重算档位与到期日
  //
  // 锚点取 `lastReviewAt ?? lastScheduledAt`：**首次作答也要走这个判定**。
  // 否则 initSrs 刚建完到期日，升级后的第一次作答就把它推后一次——
  // 上面 D3/D9 两条自测就是为这个漏洞写的。
  const sessionAnchor = st.lastReviewAt !== undefined ? st.lastReviewAt : st.lastScheduledAt
  if (sessionAnchor !== undefined) {
    const elapsedDays = Math.max(0, now - sessionAnchor) / DAY_MS
    const sameSessionDays = Math.min(SAME_SESSION_DAYS, intervalDaysAt(its, prevIdx) * 0.5)
    if (elapsedDays < sameSessionDays) {
      st.lastReviewAt = now
      return st
    }
  }

  // 2. 正常推进档位
  if (ok) {
    st.consecMiss = 0
    st.consecOk += 1
    // 「有点难」不推进档位：只按当前档重排（对齐它 `hard` → interval ×1.2 的克制口径）
    if (rating === 'hard') {
      st.idx = st.idx
    } else if (st.consecOk >= 2) {
      // 连续答对 2 次视为稳定，跳两档（防单点刷分）
      st.idx = st.idx + 2
      st.consecOk = 0
    } else {
      st.idx = st.idx + 1
    }
  } else {
    st.consecMiss += 1
    st.consecOk = 0
    st.idx = Math.max(0, st.idx - 1)
    if (st.consecMiss >= 2) st.consecMiss = 0
  }
  // 「很简单」额外多进一档
  if (rating === 'easy') st.idx = st.idx + 1
  st.idx = Math.max(0, Math.min(st.idx, maxIdx))

  // 3. 到期日 = 锚点 + 当前档间隔（锚点缺失才回落到 now：仅旧记录首次推进时发生）
  const anchor = st.lastScheduledAt !== undefined ? st.lastScheduledAt : now
  st.lastScheduledAt = anchor
  st.lastReviewAt = now
  st.dueAt = anchor + intervalDaysAt(its, st.idx) * DAY_MS
  return st
}

/**
 * 拆分切片推理问题（与 knowRAG 测试模块同一套清洗逻辑）：
 * 支持多行 Q（每行一问），过滤引导语/分组标题/过短非问句；失败回退整段。
 */
export function splitQuestions(raw: string): string[] {
  const out: string[] = []
  for (const line of String(raw || '').split(/\r?\n/)) {
    let t = line.trim()
    if (!t) continue
    t = t.replace(/^\s*(?:[-*+]\s+|\d+[\.\)、]\s*|#{1,6}\s*|>\s*)/, '')
    t = t.replace(/\*\*/g, '').trim()
    if (!t) continue
    if (/^(以下|下面|基于|根据|请|资料如下)/.test(t) && /[：:]/.test(t)) continue
    if (/[：:]\s*$/.test(t) && t.length < 30) continue
    if (!/[?？]$/.test(t) && t.length < 8) continue
    out.push(t)
  }
  return out.length ? out : [String(raw || '').trim() || '请用自己的话复述本切片要点']
}

export function uid(prefix = ''): string {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 9)
}

/** 到期文案：今天 / N 天后 / 已过期 N 天 */
export function fmtDue(dueAt: number, zh: boolean): string {
  const diffDays = Math.ceil((dueAt - Date.now()) / DAY_MS)
  if (diffDays <= 0) return zh ? '已到期' : 'Due now'
  if (diffDays === 1) return zh ? '明天' : 'tomorrow'
  return zh ? `${diffDays} 天后` : `in ${diffDays}d`
}

/** 掌握度文案（进度百分比） */
export function fmtPct(m: number): string {
  return `${Math.round(m * 100)}%`
}
