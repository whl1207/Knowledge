/**
 * kbQuestions.ts — 问题库（Question Bank）数据层与纯逻辑工具
 *
 * 背景：重构前「问题」数据是双轨制 —— ① 切片 blocks[].Q（一切片多条问题拼成一行文本，
 * 整体 embed 成单个 Q_vector，检索时被多条问题语义稀释）；② testManager 的 testCases
 * 独立副本，二者不同步。
 *
 * 本模块把「问题」提升为一等实体（KbQuestion），每个问题独立文本 + 独立向量，
 * 并通过聚合把每切片的问题向量（block.Q_vectors）挂回切片，供 denseScore /
 * 本地相似度等检索路径做 max 池化（多向量），与旧的拼串 Q_vector 并存向后兼容。
 *
 * 纯逻辑、无 Vue / 无 UI 依赖；embed / chat / cosine 等外部能力以依赖对象注入，
 * 便于在 UI 组件与 headless 场景复用。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 一条问题可被哪些切片回答（参考答案来源切片） */
export interface QuestionAnswerRef {
  /** 切片 block id（与 blocks[].id 对应；headless 场景可能缺失时用 filePath+label 兜底） */
  blockId: string
  filePath?: string
  label?: string
}

/** 问题来源 */
export type QuestionOrigin = 'reasoned' | 'manual' | 'imported' | 'complex'

/** 问题状态（供「批量整理 + 用户审核」工作流使用） */
export type QuestionStatus = 'kept' | 'merged'

/** 问题库一等实体 */
export interface KbQuestion {
  id: string
  /** 单条规范问题（不再多行拼串） */
  text: string
  /** 独立问题向量（每条问题单独 embed） */
  qVector?: number[]
  /** 主来源切片 */
  srcBlockId?: string
  srcFilePath?: string
  srcLabel?: string
  /** 可回答该问题的切片（去重/多切片答案合并后含多个；第 0 个为「主答案」切片） */
  answerBlocks: QuestionAnswerRef[]
  origin: QuestionOrigin
  /** kept=正常；merged=被合并（status=merged 时不应计入活动问题集/检索聚合） */
  status: QuestionStatus
  /** 被合并进哪条问题（status==='merged' 时有效，供审核撤销） */
  mergedInto?: string
  /** 合并/创建时间戳 */
  createdAt?: number
  /** 用户备注（可选） */
  note?: string
  /** 外部参考答案文本（手动添加 / Excel 导入的问题，不来自切片；可含 | 多段） */
  extraAnswer?: string
}

/** 去重/合并过程产生的审核记录（供「审核与修改」面板逐条通过 / 撤销） */
export interface DedupReviewEntry {
  /** 保留下来的主问题 */
  kept: KbQuestion
  /** 判定重复、被并入主问题的原始问题（审核时可撤销回独立问题） */
  duplicates: KbQuestion[]
  /** 由 LLM 综合出的更规范问题文本（仅当启用问题合并时存在；可能等于 kept.text） */
  mergedText?: string
  /** 涉及切片数 */
  blockCount: number
}

export interface DedupOptions {
  threshold: number
  /** 是否启用 LLM 综合相似问题文本 */
  mergeEnabled: boolean
  /** 问题↔答案贴合度评分（择优主答案）；返回 0~1，0 表示不可用 */
  fitScore: (question: string, answerText: string) => Promise<number>
  /** LLM 综合两条相似问题为一条（失败时应返回问题 1 原文） */
  mergeText: (q1: string, q2: string) => Promise<string>
  /** 向量余弦相似度（问题↔问题） */
  cosineSimilarity: (a: number[], b: number[]) => number
  /** 是否启用「切片佐证」加权：同来源/来源切片相关的判重更可信（弱信号加权） */
  sliceEvidence?: boolean
  onProgress?: (p: { total: number; compared: number; dupCount: number; mergedCount: number; current: number }) => void
  locale?: string
}

/** 切片佐证弱加成（同来源切片的问题相似度 +0.04，避免过度误合并） */
const SLICE_EVIDENCE_BONUS = 0.04

export interface DedupResult {
  /** 整理后的活动问题集（kept） */
  kept: KbQuestion[]
  /** 审核记录 */
  review: DedupReviewEntry[]
  dupCount: number
  mergedCount: number
}

// ---------------------------------------------------------------------------
// 拆分 / 清洗
// ---------------------------------------------------------------------------

/** 占位「未推理」标记（与 knowRAG 切片默认值保持一致） */
export const NO_QUESTION_TEXT = '问题未推理'
export const NO_QUESTION_TEXT_EN = 'Question not reasoned'

/** 把文本按行拆分为多条问题（一条切片推理出的多行 → 多条独立问题；清洗编号/列表/引导语） */
export function splitQuestionText(raw: string): string[] {
  const out: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    let t = line.trim()
    if (!t) continue
    // 清理常见 Markdown 标记：编号 / 列表符号 / 标题 / 强调
    t = t.replace(/^\s*(?:[-*+]\s+|\d+[\.\)、]\s*|#{1,6}\s*|>\s*)/, '')
    t = t.replace(/\*\*/g, '').trim()
    if (!t) continue
    // 跳过引导语（"以下是根据...可以解答的若干问题：" 等）
    if (/^(以下|下面|基于|根据|请|资料如下)/.test(t) && /[：:]/.test(t)) continue
    // 跳过分组标题（较短且以冒号结尾，如 "**关于...的问题：**"）
    if (/[：:]\s*$/.test(t) && t.length < 30) continue
    // 跳过过短且非问句的杂行
    if (!/[?？]$/.test(t) && t.length < 8) continue
    out.push(t)
  }
  return out.length ? out : [raw.trim()]
}

/** 一条「问题 + 答案」对（提取流程：LLM 顺带生成答案；答案可缺省） */
export interface QuestionAnswerPair {
  /** 问题文本 */
  text: string
  /** 该问题的答案（与 text 分开存储，独立字段；空表示切不出答案） */
  answer?: string
}

const QA_LABEL_RE = /^\s*(?:\*{1,2}\s*)?(?:\[?\s*[\-–—]?\s*\d*[\.、\)\s]*)?(问题|问|Question|答案|答|Answer|Q|A)\s*\d*\s*[:：]\s*(.*)$/i
const QA_MARK_RE = /(?:问题|问|答案|答|Question|Answer|Q|A)\s*\d*\s*[:：]/i

/**
 * 解析「问题/答案」成对输出（reasoning 提取问题 + 答案）：
 * - 识别行首标签（问题/问/Q/Question/答案/答/A/Answer）：问题行开新条目，答案行挂到当前条目；
 * - 无标签行作为前一块的续行（问题文本换行/答案多行）拼入对应字段；
 * - 问题与答案分别存入 { text } 与 { answer }，两个独立字段、互不拼接；
 * - 全文无 Q/A 标签时退化为旧格式（每行一个问题，无答案）。
 */
export function parseQuestionAnswerPairs(raw: string): QuestionAnswerPair[] {
  const src = (raw || '').trim()
  if (!src) return []
  const lines = src.split(/\r?\n/)
  // 无 Q/A 标签 → 旧模板（纯问题列表，无答案）
  if (!lines.some((l) => QA_MARK_RE.test(l))) {
    return splitQuestionText(src).map((t) => ({ text: t }))
  }
  const out: QuestionAnswerPair[] = []
  let cur: QuestionAnswerPair | null = null
  let prevKind: 'q' | 'a' | null = null
  const clean = (s: string) => s.replace(/\*\*/g, '').trim()
  for (const line of lines) {
    const m = QA_LABEL_RE.exec(line)
    if (m) {
      const label = m[1].toLowerCase()
      const body = clean(m[2])
      const isQ = /^(q|question|问|问题)/.test(label)
      if (isQ) {
        if (cur) out.push(cur)
        cur = { text: body || '' }
        prevKind = 'q'
      } else {
        // 答案行：无前置问题（孤儿答案）则忽略
        if (!cur) { prevKind = 'a'; continue }
        cur.answer = body ? (cur.answer ? `${cur.answer}\n${body}` : body) : cur.answer
        prevKind = 'a'
      }
    } else {
      const body = clean(line)
      if (!body || !cur) continue
      // 无标签续行：前一块是答案则并入答案，否则并入问题文本
      if (prevKind === 'a') cur.answer = cur.answer ? `${cur.answer}\n${body}` : body
      else cur.text = cur.text ? `${cur.text} ${body}` : body
    }
  }
  if (cur && (cur.text || '').trim()) out.push(cur)
  return out
}

/** 判断切片是否有已推理问题 */
export function hasQuestion(block: any): boolean {
  const q = (block?.Q || '').trim()
  return !!q && q !== NO_QUESTION_TEXT && q !== NO_QUESTION_TEXT_EN
}

// ---------------------------------------------------------------------------
// blocks → questionBank（重建 / 全量同步，旧库向后兼容入口）
// ---------------------------------------------------------------------------

/**
 * 从 blocks 重建问题库：
 * - 对每个已推理切片，将其 Q 拆成多条独立问题；
 * - 主来源 = 该切片，答案 = 该切片；
 * - 无向量信息（qVector 为空，调用方按需补 embed）。
 * 用于：加载旧版 .kb（无 questions 字段）、用户手动「从切片重新同步」。
 */
export function buildQuestionBankFromBlocks(blocks: any[]): KbQuestion[] {
  const out: KbQuestion[] = []
  const seen = new Set<string>()
  for (const b of blocks || []) {
    if (!hasQuestion(b)) continue
    const blockId = b.id || `${b.filePath}#${b.label || ''}`
    const texts = splitQuestionText(b.Q)
    for (const text of texts) {
      if (!text) continue
      const key = `${blockId}::${text}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        id: `${blockId}#q${out.length}`,
        text,
        qVector: undefined,
        srcBlockId: blockId,
        srcFilePath: b.filePath,
        srcLabel: b.label,
        answerBlocks: [{ blockId, filePath: b.filePath, label: b.label }],
        origin: 'reasoned',
        status: 'kept',
        createdAt: Date.now(),
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 问题增强索引：questionBank → blockId → 关联问题向量（供检索 Q 增强通道 max 池化）
// 说明（方案 A）：问题只存问题库（每条独立 qVector + 关联切片引用 answerBlocks/srcBlockId），
// 检索时经该索引为每个切片取「其问题」的向量做 max 相似度；不再把问题文本/向量冗余写回切片。
// ---------------------------------------------------------------------------

/** 某切片的活动（kept）问题 */
export function activeQuestionsOfBlock(questions: KbQuestion[], blockId: string): KbQuestion[] {
  if (!blockId) return []
  return (questions || []).filter(q => q.status !== 'merged' && q.srcBlockId === blockId)
}

/**
 * 构建「切片 → 关联活动问题向量」索引（dense_score 的问题增强分 = 逐条 cos 取 max）。
 * 仅读取问题库，不修改任何切片字段。
 */
export function computeBlockQuestionVectors(questions: KbQuestion[]): Map<string, number[][]> {
  const map = new Map<string, number[][]>()
  for (const q of questions || []) {
    if (q.status === 'merged' || !q.srcBlockId || !q.qVector || !q.qVector.length) continue
    let arr = map.get(q.srcBlockId)
    if (!arr) { arr = []; map.set(q.srcBlockId, arr) }
    arr.push(q.qVector)
  }
  return map
}

// ---------------------------------------------------------------------------
// 语义去重 / 择优 / 多切片答案合并（整理问题库核心）
// ---------------------------------------------------------------------------

/**
 * 语义去重 + 择优 + 多切片答案合并（对 KbQuestion 级操作）。
 *
 * 判重信号：
 *  - 主信号：问题文本语义余弦 ≥ threshold；
 *  - 佐证（可选，sliceEvidence=true）：两个问题源自同一/高相关切片时，
 *    相似度做小幅加成（降低措辞差异导致的漏判；默认弱加权，不喧宾夺主）。
 *
 * 合并动作：
 *  - 文本：enableMerge 时用 LLM 综合成更完整规范的问题（失败回退保留主文本）；
 *  - 答案：两条问题的 answerBlocks 合并（主切片答案在前）；
 *  - 被并问题保留在库中 status='merged'，用于「审核与修改」时撤销/查看。
 */
export async function dedupAndMerge(
  questions: KbQuestion[],
  opts: DedupOptions,
): Promise<DedupResult> {
  const threshold = Number(opts.threshold) || 0.85
  const review: DedupReviewEntry[] = []
  let dupCount = 0
  let mergedCount = 0
  const total = questions.length

  const report = (i: number) => opts.onProgress?.({ total, compared: i + 1, dupCount, mergedCount, current: i + 1 })

  const kept: KbQuestion[] = []
  const keptQV: (number[] | undefined)[] = []
  const keptNorm: string[] = []

  for (let i = 0; i < total; i++) {
    const q = questions[i]
    if (q.status === 'merged') { report(i); continue }

    let dupIdx = -1
    if (q.qVector && q.qVector.length) {
      // 向量通道：主判据 = 问题文本语义余弦（可选切片佐证弱加权）
      for (let k = 0; k < kept.length; k++) {
        if (!keptQV[k]) continue
        let sim = 0
        try { sim = opts.cosineSimilarity(q.qVector, keptQV[k]!) } catch { sim = 0 }
        if (opts.sliceEvidence && q.srcBlockId && q.srcBlockId === kept[k].srcBlockId) {
          sim = Math.min(1, sim + SLICE_EVIDENCE_BONUS)
        }
        if (sim >= threshold) { dupIdx = k; break }
      }
    } else if (q.text) {
      // 无向量问题（人工/导入未向量化）：归一化文本相等/包含的轻量近似
      const norm = normText(q.text)
      for (let k = 0; k < kept.length; k++) {
        if (!norm || !keptNorm[k]) continue
        if (keptNorm[k] === norm || keptNorm[k].includes(norm) || norm.includes(keptNorm[k])) { dupIdx = k; break }
      }
    }

    if (dupIdx >= 0) {
      dupCount++
      // 择优：答案与问题贴合度更高者作为「主答案切片」（答案集首位）
      const newFit = await opts.fitScore(q.text, answerText(q))
      const oldFit = await opts.fitScore(kept[dupIdx].text, answerText(kept[dupIdx]))
      const newIsBetter = newFit > oldFit
      const primary = newIsBetter ? q : kept[dupIdx]
      const secondary = newIsBetter ? kept[dupIdx] : q

      const mergedText = opts.mergeEnabled ? await opts.mergeText(kept[dupIdx].text, q.text) : kept[dupIdx].text

      const dup: KbQuestion = { ...secondary, status: 'merged', mergedInto: primary.id }
      const ans = mergeAnswerRefs(primary, dup)
      primary.answerBlocks = ans.refs
      if (mergedText && mergedText !== primary.text) primary.text = mergedText
      kept[dupIdx] = primary
      keptQV[dupIdx] = primary.qVector
      keptNorm[dupIdx] = normText(primary.text)
      mergedCount += ans.extra
      review.push({ kept: { ...kept[dupIdx] }, duplicates: [dup], mergedText, blockCount: ans.refs.length })
    } else {
      kept.push(q)
      keptQV.push(q.qVector)
      keptNorm.push(normText(q.text))
    }
    report(i)
  }

  return { kept, review, dupCount, mergedCount }
}

function normText(s: string): string {
  return (s || '').replace(/[\s？?。.，,、]+/g, '').toLowerCase()
}

/** 聚合两条问题的参考答案切片，返回合并后的 refs 与新增（非主答案）切片数 */
function mergeAnswerRefs(primary: KbQuestion, dup: KbQuestion): { refs: QuestionAnswerRef[]; extra: number } {
  const refs: QuestionAnswerRef[] = []
  const seen = new Set<string>()
  const push = (r: QuestionAnswerRef) => {
    const key = r.blockId || `${r.filePath}#${r.label}`
    if (seen.has(key)) return
    seen.add(key)
    refs.push(r)
  }
  for (const r of primary.answerBlocks || []) push(r)
  let extra = 0
  for (const r of dup.answerBlocks || []) {
    const key = r.blockId || `${r.filePath}#${r.label}`
    if (!seen.has(key)) extra++
    push(r)
  }
  return { refs, extra }
}

/** 把一条问题的参考答案拼成文本（优先外部答案；否则按答案切片 A 拼接，主答案在前） */
export function answerText(q: KbQuestion, blocks?: any[], sep: string = ' | '): string {
  if (q.extraAnswer && q.extraAnswer.trim()) return q.extraAnswer.trim()
  const refs = q.answerBlocks || []
  if (!blocks || !blocks.length) {
    return refs.map(r => r.label || r.blockId).join(sep)
  }
  const parts: string[] = []
  const byId = new Map<string, any>()
  for (const b of blocks) byId.set(b.id, b)
  for (const r of refs) {
    const b = byId.get(r.blockId) || (r.filePath && blocks.find(x => x.filePath === r.filePath && x.label === r.label))
    const t = (b?.A || '').trim()
    if (t && !parts.some(x => x === t)) parts.push(t)
  }
  return parts.join(sep)
}

// ---------------------------------------------------------------------------
// 疑似重复分组检测（供「批量整理 + 用户审核」使用：只判组，不改动库）
// ---------------------------------------------------------------------------

export interface DupGroup {
  members: KbQuestion[]
  threshold: number
}

export interface DupDetectOptions {
  threshold: number
  cosineSimilarity: (a: number[], b: number[]) => number
  /** 同来源切片佐证弱加权 */
  sliceEvidence?: boolean
}

/**
 * 贪心分组：遍历活动问题，与每个组的代表成员（首个成员）比较语义相似度，
 * ≥ threshold 则并入该组；否则自成一组。返回含 ≥2 成员的疑似重复组。
 */
export function detectDuplicateGroups(questions: KbQuestion[], opts: DupDetectOptions): DupGroup[] {
  const reps: KbQuestion[] = []
  const groups: KbQuestion[][] = []
  const th = Number(opts.threshold) || 0.85
  for (const q of questions || []) {
    if (!q || q.status === 'merged') continue
    if (!q.qVector || !q.qVector.length) continue // 无向量的问题不参与语义检测（可先「补全向量」）
    let gi = -1
    let best = 0
    for (let g = 0; g < reps.length; g++) {
      if (!reps[g] || !reps[g].qVector) continue
      let sim = 0
      try { sim = opts.cosineSimilarity(q.qVector, reps[g].qVector!) } catch { sim = 0 }
      if (opts.sliceEvidence && q.srcBlockId && q.srcBlockId === reps[g].srcBlockId) {
        sim = Math.min(1, sim + SLICE_EVIDENCE_BONUS)
      }
      if (sim > best) { best = sim; gi = g }
    }
    if (best >= th && gi >= 0) groups[gi].push(q)
    else { reps.push(q); groups.push([q]) }
  }
  return groups.filter(g => g.length > 1).map(members => ({ members, threshold: th }))
}
