/**
 * learningCore.selftest.ts — 学习引擎纯函数自测
 *
 * 覆盖 P0 两条不变量（都对着一类"悄悄算错、且没人会发现"的失败）：
 *
 * 1. **SRS 锚点**：同会话内的重复练习**不得推后到期日**。
 *    改动前的 `dueAt = now + 间隔` 会让一天里连练 5 次 due 往后跳 5 次，到期日永远不来。
 * 2. **证据质量**：看过答案 / 用了提示之后答对的，**不得推开掌握度门**。
 *    改动前是一串裸 bool，同一道题连点 3 次「记得」就等于 3 次完美回忆。
 *
 * 另外钉住向后兼容：旧 `.learning` 记录（缺 `lastReviewAt` / `lastScheduledAt` /
 * `independent` / `hintsUsed`）必须与改动前行为逐位一致——否则升级会让所有历史掌握度集体变动。
 *
 * 用法：`npm run test:selftest`（或 `npm run test:selftest learningCore`）
 */

import {
  computeMastery,
  computeMasteryFromEvidence,
  displayMastery,
  evidenceQuality,
  gateKindOf,
  initSrs,
  isGatePassed,
  isSrsDue,
  MASTERY_GATE,
  masterySource,
  objectStatusOf,
  QUALITATIVE_TYPES,
  QUALITY_PASS,
  ratingFromVerdict,
  ratingIsSuccess,
  SAME_SESSION_DAYS,
  SRS_RATINGS,
  srsIntervals,
  srsNext,
  TYPE_INTERVALS,
  type KbType,
  type Lsrs,
  type SrsRating,
} from '@/services/learningCore'

export interface LearningCoreCase {
  name: string
  ok: boolean
  detail?: string
}

const DAY = 86400000
const T0 = 1_760_000_000_000 // 固定时间基准，避免用当前时间导致用例不确定
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps

export function runLearningCoreSelfTest(): LearningCoreCase[] {
  const cases: LearningCoreCase[] = []
  const add = (name: string, ok: boolean, detail?: string) =>
    cases.push({ name, ok, ...(detail ? { detail } : {}) })

  // ==================== A. 基线掌握度（回归保护：这个函数不该被改动影响） ====================
  {
    add('A1 空序列 = 0', computeMastery([]) === 0)
    add('A2 全对 = 1', computeMastery([true, true, true, true, true]) === 1)
    add('A3 单次蒙对被 0.5 封顶', computeMastery([true]) === 0.5)
    add('A4 两次全对被 0.8 封顶', near(computeMastery([true, true]), 0.8))
    add('A5 先对后错 < 先错后对（新近权重生效）',
      computeMastery([true, true, false, false, true]) < computeMastery([false, false, true, true, true]),
      `${computeMastery([true, true, false, false, true])} vs ${computeMastery([false, false, true, true, true])}`)
    add('A6 只取最近 5 次（更早的不参与）',
      computeMastery([false, false, false, false, false, true, true, true, true, true]) ===
      computeMastery([true, true, true, true, true]))
  }

  // ==================== B. 证据质量：看过答案不算掌握 ====================
  {
    add('B1 独立答对 = 1', evidenceQuality({ ok: true }) === 1)
    add('B2 答错 = 0', evidenceQuality({ ok: false }) === 0)
    add('B3 缺省字段（旧记录）等同独立答对',
      evidenceQuality({ ok: true, independent: undefined, hintsUsed: undefined, attemptNo: undefined }) === 1)

    const peeked = evidenceQuality({ ok: true, independent: false })
    add('B4 看过答案后答对 < 0.5（推不开任何门）', peeked < QUALITY_PASS, String(peeked))

    const peekedHint = evidenceQuality({ ok: true, independent: false, hintsUsed: 1 })
    add('B5 再看解析更低', peekedHint < peeked, `${peekedHint} < ${peeked}`)

    const retried = evidenceQuality({ ok: true, attemptNo: 3 })
    add('B6 同一题第 3 次尝试 < 1（反复重试折价）', retried < 1 && retried > 0, String(retried))
    add('B7 第 1 次尝试不打折', evidenceQuality({ ok: true, attemptNo: 1 }) === 1)
    add('B8 质量恒在 0..1 且非负', [0, 1, 5, 99].every(h => {
      const q = evidenceQuality({ ok: true, independent: false, hintsUsed: h, attemptNo: h + 1 })
      return q >= 0 && q <= 1
    }))
  }

  // ==================== C. 门控：看过答案的"全对"过不了 0.9 ====================
  {
    const T = { ok: true }
    const peek = { ok: true, independent: false }
    add('C1 5 次独立全对 = 1（过门）', computeMasteryFromEvidence([T, T, T, T, T]) === 1)
    add('C2 看过答案的 5 次全对 = 0（开门失败）',
      computeMasteryFromEvidence([peek, peek, peek, peek, peek]) === 0,
      String(computeMasteryFromEvidence([peek, peek, peek, peek, peek])))
    add('C3 只看过一次 + 之后 4 次独立 → 仍不足以过门（0.875 < 0.9）',
      (() => { const m = computeMasteryFromEvidence([peek, T, T, T, T]); return m < 0.9 && m > 0.8 })(),
      String(computeMasteryFromEvidence([peek, T, T, T, T])))
    add('C4 看过 4 次 + 1 次独立 → 更低',
      computeMasteryFromEvidence([peek, peek, peek, peek, T]) < 0.5)
    add('C5 缺省字段（旧记录）与原 computeMastery 逐位一致',
      [[true], [true, true], [true, false, true], [true, true, false, false, true]]
        .every(seq => near(computeMasteryFromEvidence(seq.map(ok => ({ ok }))), computeMastery(seq))))
    add('C6 空序列 = 0', computeMasteryFromEvidence([]) === 0)
    // C7：同一个质量线也决定 SRS 的推进 / 倒退（learningRecord 传的就是 `quality >= QUALITY_PASS`）。
    // 语义：没能独立回忆起来（偷看后答对）不该拿到更长的复习间隔。
    add('C7 QUALITY_PASS 同时是掌握度与 SRS 的分界线',
      QUALITY_PASS === 0.5 &&
      evidenceQuality({ ok: true, independent: false }) < QUALITY_PASS &&
      evidenceQuality({ ok: true }) >= QUALITY_PASS)
  }

  // ==================== D. SRS 锚点：同会话重复练习不推后到期日 ====================
  {
    // D1 initSrs 建立锚点
    const s0 = initSrs(T0, 'memory')
    add('D1 initSrs 建立 lastScheduledAt 锚点',
      s0.lastScheduledAt === T0 && s0.idx === 0 && s0.dueAt === T0 + TYPE_INTERVALS.memory[0] * DAY)
    add('D2 新记录尚未作答（lastReviewAt 未定义）', s0.lastReviewAt === undefined)

    // D3 核心回归：同一天连练 5 次，dueAt 一个字节都不动
    {
      let s: Lsrs = s0
      const due0 = s.dueAt
      for (let i = 0; i < 5; i++) s = srsNext(s, true, T0 + 60_000 * (i + 1), 'memory')
      add('D3 同日连练 5 次：dueAt 不变（改动前会推后 5 次）',
        s.dueAt === due0 && s.idx === 0,
        `dueAt ${due0} -> ${s.dueAt}, idx=${s.idx}`)
      add('D4 但 lastReviewAt 每次都刷新（"今天练过了"这一事实不丢）',
        s.lastReviewAt === T0 + 60_000 * 5)
      add('D5 连练 5 次后仍未到期（不受重复练习影响）', !isSrsDue(s, T0 + 60_000 * 5))
    }

    // D6 超出同会话窗口后，正常推进且 dueAt = 锚点 + 新档间隔
    {
      const s1 = srsNext(s0, true, T0 + 2 * DAY, 'memory')
      const expected = T0 + TYPE_INTERVALS.memory[1] * DAY
      add('D6 隔天作答：档位推进 + dueAt = 锚点 + 新档间隔',
        s1.idx === 1 && s1.dueAt === expected,
        `idx=${s1.idx}, dueAt=${s1.dueAt}, expected=${expected}`)
      add('D7 隔天作答后锚点回到"设定 dueAt 的那次"', s1.lastScheduledAt === T0)
    }

    // D8 窗口随间隔缩放：design 起步 14 天，半天后的作答**已算新一次**（不是同会话）
    {
      const d0 = initSrs(T0, 'design')
      const d1 = srsNext(d0, true, T0 + 0.5 * DAY, 'design')
      add('D8 design（14 天起步）：半天后作答算新一次，档位推进', d1.idx === 1, `idx=${d1.idx}`)
    }

    // D9 memory 起步 1 天：窗口 = min(0.25, 0.5) = 0.25 天，故 0.2 天内算同会话、0.3 天后算新一次
    {
      const a = srsNext(initSrs(T0, 'memory'), true, T0 + 0.2 * DAY, 'memory')
      const b = srsNext(initSrs(T0, 'memory'), true, T0 + 0.3 * DAY, 'memory')
      add('D9 memory 窗口 = 0.25 天：0.2 天内不推进、0.3 天后推进',
        a.idx === 0 && b.idx === 1, `a.idx=${a.idx}, b.idx=${b.idx}`)
      add('D9b SAME_SESSION_DAYS 是窗口上限', SAME_SESSION_DAYS === 0.25)
    }

    // D10 表尾封顶：反复答对不会让 dueAt 无限后推
    {
      let s: Lsrs = initSrs(T0, 'design')
      let t = T0
      for (let i = 0; i < 12; i++) { t += 30 * DAY; s = srsNext(s, true, t, 'design') }
      const cap = TYPE_INTERVALS.design[TYPE_INTERVALS.design.length - 1]
      add('D10 表尾封顶：间隔不超过表尾值',
        s.idx === TYPE_INTERVALS.design.length - 1 && s.dueAt - s.lastScheduledAt! === cap * DAY,
        `idx=${s.idx}, span=${(s.dueAt - (s.lastScheduledAt || t)) / DAY}d, cap=${cap}d`)
    }

    // D11 连错倒退，但 idx 不为负。
    // 每次都跳出同会话窗口（design 起步 14 天 → 窗口 7 天，故用 10 天），
    // 否则同一场练习内的重复作答会被正确判定为"同会话"，测不到地板。
    {
      let s: Lsrs = initSrs(T0, 'design')
      let t = T0
      for (let i = 0; i < 4; i++) { t += 10 * DAY; s = srsNext(s, false, t, 'design') }
      add('D11 连错倒退回 0 且不越界（idx 不为负）', s.idx === 0, `idx=${s.idx}`)
      // 已在 0 档再错一次：仍不越界，且 dueAt 必须由**锚点**推出（而不是由 now 推出）
      const t2 = t + 10 * DAY
      const s2 = srsNext(s, false, t2, 'design')
      add('D11b 0 档再错：不越界，dueAt = 锚点 + 0 档间隔（不是 now + 间隔）',
        s2.idx === 0 && s2.dueAt === s.lastScheduledAt! + TYPE_INTERVALS.design[0] * DAY,
        `idx=${s2.idx}, dueAt=${s2.dueAt}, anchor=${s.lastScheduledAt}`)
    }

    // D12 旧记录兼容：缺锚点时行为与改动前一致（dueAt = now + 间隔），且**不改动既有 dueAt 之外的东西**
    {
      const legacy: Lsrs = { idx: 2, consecOk: 0, consecMiss: 0, dueAt: T0 + 999 * DAY }
      const s = srsNext(legacy, true, T0 + DAY, 'memory')
      add('D12 旧记录（无锚点）：首次推进用当前时间兜底建锚，行为与改动前一致',
        s.lastScheduledAt === T0 + DAY && s.dueAt === T0 + DAY + TYPE_INTERVALS.memory[3] * DAY,
        `idx=${s.idx}, lastScheduledAt=${s.lastScheduledAt}, dueAt=${s.dueAt}`)
    }

    // D13 不修改入参（纯函数）
    {
      const input: Lsrs = { idx: 1, consecOk: 0, consecMiss: 0, dueAt: T0 + DAY, lastScheduledAt: T0, lastReviewAt: T0 }
      const snapshot = JSON.stringify(input)
      srsNext(input, true, T0 + 10 * DAY, 'memory')
      add('D13 srsNext 不修改入参', JSON.stringify(input) === snapshot)
    }

    // D14 类型缺省：未给 type 时按 memory 间隔表
    {
      const s = srsNext(initSrs(T0, undefined), true, T0 + 3 * DAY, undefined)
      add('D14 未给 type 时回落 memory 间隔表',
        near(s.dueAt - (s.lastScheduledAt || 0), TYPE_INTERVALS.memory[1] * DAY))
      add('D15 srsIntervals 对未知类型回落 memory',
        srsIntervals(undefined) === TYPE_INTERVALS.memory && srsIntervals('memory' as KbType) === TYPE_INTERVALS.memory)
    }

    // D16 同会话判定是"严格小于"：恰好等于窗口时算新一次
    {
      const s = srsNext(initSrs(T0, 'memory'), true, T0 + SAME_SESSION_DAYS * DAY, 'memory')
      add('D16 恰好等于窗口长度 → 算新一次（严格小于）', s.idx === 1, `idx=${s.idx}`)
    }
  }

  // ==================== E. 四档评分（自评）驱动档位 ====================
  {
    const fresh = (t: KbType = 'memory') => initSrs(T0, t)
    const after = (rating: SrsRating, days: number, t: KbType = 'memory') =>
      srsNext(fresh(t), rating !== 'again', T0 + days * DAY, t, rating)

    add('E1 判分结果 → 评分档：对给 good，错给 again',
      ratingFromVerdict(true) === 'good' && ratingFromVerdict(false) === 'again')
    add('E2 ratingIsSuccess：只有 again 不算成功回忆',
      ratingIsSuccess('again') === false &&
      ratingIsSuccess('hard') && ratingIsSuccess('good') && ratingIsSuccess('easy'))
    add('E3 SRS_RATINGS 四档齐全且顺序固定',
      SRS_RATINGS.length === 4 && SRS_RATINGS.join() === 'again,hard,good,easy')

    // 跳出同会话窗口后按评分推进（10 天 > design 的 7 天窗口）
    add('E4 good：推进一档', after('good', 10, 'design').idx === 1, `idx=${after('good', 10, 'design').idx}`)
    add('E5 hard：**不推进**档位（只按当前档重排）', after('hard', 10, 'design').idx === 0,
      `idx=${after('hard', 10, 'design').idx}`)
    add('E6 easy：比 good 多进一档', after('easy', 10, 'design').idx === 2,
      `good=${after('good', 10, 'design').idx}, easy=${after('easy', 10, 'design').idx}`)
    add('E7 easy 仍受表尾封顶',
      (() => {
        let s: Lsrs = initSrs(T0, 'design')
        let t = T0
        for (let i = 0; i < 6; i++) { t += 10 * DAY; s = srsNext(s, true, t, 'design', 'easy') }
        return s.idx === TYPE_INTERVALS.design.length - 1
      })())

    // again：同会话窗口内**不掉档**（"本轮再练一遍"不该把长期间隔打回去）
    add('E8 again 在半天内：档位与到期日都不动（只是本轮再练）',
      (() => {
        const s0 = srsNext(fresh('design'), true, T0 + 10 * DAY, 'design', 'good')
        const before = s0.idx
        const s1 = srsNext(s0, false, T0 + 10 * DAY + 3600_000, 'design', 'again')
        return s1.idx === before && s1.dueAt === s0.dueAt
      })())

    // again 出了窗口：掉一档（它是真的忘了，不是本轮练习）
    add('E9 again 跳出窗口后：掉一档',
      (() => {
        const s0 = srsNext(fresh('design'), true, T0 + 10 * DAY, 'design', 'good')
        const s1 = srsNext(s0, false, T0 + 40 * DAY, 'design', 'again')
        return s1.idx === 0
      })())

    add('E10 不传 rating 时行为与改动前一致（good 语义）',
      (() => {
        const a = srsNext(fresh('design'), true, T0 + 10 * DAY, 'design')
        const b = srsNext(fresh('design'), true, T0 + 10 * DAY, 'design', 'good')
        return a.idx === b.idx && a.dueAt === b.dueAt
      })())
  }

  // ==================== F. 双门控（P1-2） ====================
  {
    add('F1 门只看知识类型：memory / procedure → 量化',
      gateKindOf('memory') === 'quantitative' && gateKindOf('procedure') === 'quantitative')
    add('F2 concept / design → 质性',
      gateKindOf('concept') === 'qualitative' && gateKindOf('design') === 'qualitative')
    add('F3 未给类型时回落 memory（量化）', gateKindOf(undefined) === 'quantitative')
    add('F4 QUALITATIVE_TYPES 只含 concept / design',
      QUALITATIVE_TYPES.length === 2 && QUALITATIVE_TYPES.join() === 'concept,design')

    // displayMastery：质性通过映射成 1，保证地图配色与门控结论同源
    add('F5 质性通过 → 显示 1（哪怕分数是 0）', displayMastery(0, true, true) === 1)
    add('F6 质性未通过 → 按分数显示', displayMastery(0.4, false, true) === 0.4 && displayMastery(0.4, undefined, true) === 0.4)
    add('F7 量化知识点不受 qualitativePass 影响', displayMastery(0.6, true, false) === 0.6)
    add('F8 非质性传入 true 也不会把分数抬到 1', displayMastery(0.6, true, false) !== 1)

    // isGatePassed
    add('F9 量化：达到 0.9 过门，0.89 不过',
      isGatePassed({ mastery: MASTERY_GATE, qualitativeGate: false }) === true &&
      isGatePassed({ mastery: 0.89, qualitativeGate: false }) === false)
    add('F10 量化：masteredAt 即过门（历史记录里分数可能已被裁剪）',
      isGatePassed({ mastery: 0, masteredAt: T0, qualitativeGate: false }) === true)
    add('F11 质性：只看 qualitativePass，分数再高也不算过',
      isGatePassed({ mastery: 1, qualitativePass: false, qualitativeGate: true }) === false &&
      isGatePassed({ mastery: 1, qualitativePass: undefined, qualitativeGate: true }) === false)
    add('F12 质性：判定通过即过门，分数为 0 也算',
      isGatePassed({ mastery: 0, qualitativePass: true, qualitativeGate: true }) === true)
    add('F13 学习者声明可以让路线前进（两种门都行）',
      isGatePassed({ mastery: 0, qualitativeGate: false, claimMastered: true }) === true &&
      isGatePassed({ mastery: 0, qualitativePass: false, qualitativeGate: true, claimMastered: true }) === true)

    // masterySource：声明与评测必须可区分
    add('F14 来源区分：量化评测通过 = system',
      masterySource({ mastery: 0.95, qualitativeGate: false }) === 'system')
    add('F15 来源区分：质性通过 = system',
      masterySource({ mastery: 0, qualitativePass: true, qualitativeGate: true }) === 'system')
    add('F16 来源区分：只有声明 = learner（绝不冒充 system）',
      masterySource({ mastery: 0, qualitativePass: false, qualitativeGate: true, claimMastered: true }) === 'learner' &&
      masterySource({ mastery: 0, qualitativeGate: false, claimMastered: true }) === 'learner')
    add('F17 来源区分：未过门 = 空串',
      masterySource({ mastery: 0.5, qualitativeGate: false }) === '')

    // objectStatusOf
    add('F18 状态：未开始 = new',
      objectStatusOf({ mastery: 0, qualitativeGate: false }) === 'new')
    add('F19 状态：练过但没过门 = learning',
      objectStatusOf({ mastery: 0.6, qualitativeGate: false }) === 'learning')
    add('F20 状态：质性判过 = mastered（分数为 0 也是）',
      objectStatusOf({ mastery: 0, qualitativePass: true, qualitativeGate: true }) === 'mastered')
    add('F21 状态：质性判没过 = learning（不是 new —— 已经碰过了）',
      objectStatusOf({ mastery: 0, qualitativePass: false, qualitativeGate: true }) === 'learning')
    add('F22 状态：声明掌握 = mastered',
      objectStatusOf({ mastery: 0, qualitativeGate: false, claimMastered: true }) === 'mastered')
  }

  return cases
}
