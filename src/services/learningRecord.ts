/**
 * 学习记录落盘层（A2：与 .kb 同目录的 <库名>.learning，绝不写回 .kb；兼容读取旧 <库名>.learning.json）
 * 约定见 docs/设计决策记录.md §五 学习模块（存储设计）。
 *
 * 存储主体：objects 以「文件相对路径」为 key（kind='file'）。切片归属唯一文件，
 * 因此 attempt 只存一份于其所属文件对象；实体轴（P2）由同一份 attempt 经
 * entityNames/blockId 投影聚合。
 */
import { computeMasteryFromEvidence, displayMastery, evidenceQuality, gateKindOf, initSrs, isSrsDue, isGatePassed, KbType, Lsrs, MASTERY_GATE, masterySource, objectStatusOf, QUALITY_PASS, ratingIsSuccess, srsNext, uid, type GateKind, type SrsRating } from '@/services/learningCore'
import { getPlatform, hasCapability } from '@/platform'

export type AttemptSrc = 'self' | 'exam' | 'review'
/** 错因标签（P2.5）：记忆混淆 / 概念不清 / 步骤错误 / 粗心 */
export type ErrType = 'memory' | 'concept' | 'procedure' | 'careless' | ''

export interface LAttempt {
  id: string
  q: string                    // 题干（flashcard 前）
  ok: boolean
  score: number                // 0..100
  at: number
  src: AttemptSrc
  blockId: any                 // 所属切片（作答时快照）
  filePath: string             // 所属文件
  entityNames: string[]        // 切片相关实体（快照，供实体轴投影）
  errType?: ErrType            // 错因标签（仅在错题上标注）
  /** 正确答案快照（作答时固化；错题本/复习重看不依赖切片现状，无生成答案时=来源切片正文） */
  answer?: string
  /** answer 是否来自问题库生成答案（true=独立答案+出处切片；false/缺省=answer 即切片正文） */
  hasAnswer?: boolean
  /**
   * 是否**未看答案、未用提示**独立完成（P0，对齐 DeepTutor 的 QuizAttempt.independent）。
   * 缺省 = true：旧记录一律按独立完成处理，因此历史掌握度不会因升级而掉分。
   * 看过答案区才作答 / 点过「解析」的，应传 false。
   */
  independent?: boolean
  /** 本题用掉的提示数 / 看过答案的次数（P0，对齐 LearningEvidence.hints_used）。缺省 0 */
  hintsUsed?: number
  /**
   * 四档评分（P1，对齐 DeepTutor `services/practice/scheduler.py` 的 Rating）。
   *
   * 判得出分的题由判分结果直接给 `good` / `again`（学习者无从改判）；
   * 判不了分的题由学习者自评。缺省 = 由 `ok` 反推（good / again），
   * 因此旧调用点与旧记录的行为完全不变。
   */
  rating?: SrsRating
  /**
   * 这次作答属于**质性**门控（concept/design 的 Feynman 检查）。
   *
   * 为什么必须标出来：质性知识点不用正确率判掌握，所以这类作答
   * **不参与** `objectMastery` 的加权正确率 —— 否则"讲了三遍都判没过"会把
   * 分数拉到 0，而分数对质性门控本来就不该有影响。
   */
  qualitative?: boolean
}

export interface LObject {
  kind: 'file'
  key: string                  // 文件相对路径
  label: string
  type?: KbType                // 知识类型（决定分型复习节奏；默认 memory）
  blockIds: (string | number)[]  // 覆盖切片快照（stale 检测用）
  attempts: LAttempt[]
  srs: Lsrs
  stale?: boolean
  staleSince?: number
  masteredAt?: number
  lastPracticedAt?: number
  /** 学习者声明已掌握（跳测/压缩已会内容，与作答证据式掌握分开） */
  claimMastered?: boolean
  /**
   * 质性门控的判定记录（P1-2，对齐 DeepTutor 的 `qualitative_mastery`）：
   * `concept` / `design` 型知识点由导师判定"用自己的话讲一遍"是否足够，
   * **bool 而不是分数**。学习者声明用 `claimMastered`，两者绝不混。
   */
  qualitativePass?: boolean
  /** 最近一次质性判定（含模型短评），供错题本/地图展示 */
  qualitative?: QualitativeEvidence
}

/** 一次质性判定（Feynman 检查）的证据 */
export interface QualitativeEvidence {
  passed: boolean
  /** 学习者的讲解原文 */
  explanation?: string
  /** 模型短评（强在哪 / 缺什么） */
  feedback?: string
  at: number
  /** 生成时用的语言 */
  lang?: 'zh' | 'en'
}

export interface DayStat { ok: number; total: number }
export interface LMeta {
  totalPractice: number
  totalCorrect: number
  lastPracticeAt: number
  /** 按日聚合（作答高频小写，attempts 会被裁剪，长期趋势依赖此聚合） */
  dayStats: Record<string, DayStat>
}

/** AI 解析类型：explain=短讲解；diagram=图解/解析（分步拆解 + 知识结构图） */
export type LExplainKind = 'explain' | 'diagram'
/**
 * AI 解析结果（随学习记录持久化）：同一题再次打开直接复用，不重复烧 token。
 * key = explainCacheKey(kind, blockId, 题干)（题干指纹，换题/改题自动失效）。
 */
export interface LExplainEntry {
  text: string
  at: number
  kind: LExplainKind
  /** 生成时用的语言（英文库/英文界面为 'en'） */
  lang?: 'zh' | 'en'
}

export interface LData {
  schemaVersion: 1
  kbFile: string
  updatedAt: number
  objects: Record<string, LObject>
  meta: LMeta
  /** AI 解析/图解的本地缓存（可选字段：旧记录无此项也能正常读） */
  explains?: Record<string, LExplainEntry>
}

const MAX_ATTEMPTS = 40
const MAX_DAYSTATS = 120
/** 解析缓存条数上限（超出按时间淘汰最旧，避免 .learning 无限膨胀） */
const MAX_EXPLAINS = 300

function dayKeyOf(t: number): string {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function emptyMeta(): LMeta {
  return { totalPractice: 0, totalCorrect: 0, lastPracticeAt: 0, dayStats: {} }
}

export function emptyLData(kbFile: string): LData {
  const now = Date.now()
  return {
    schemaVersion: 1,
    kbFile,
    updatedAt: now,
    objects: {},
    meta: emptyMeta(),
    explains: {},
  }
}

// ==================== AI 解析缓存（随 .learning 一并落盘） ====================

/** 题干指纹：djb2 哈希（去空白 + 截断），避免把整个题干当 key 撑大 .learning */
function fingerprint(s: string): string {
  const t = String(s || '').replace(/\s+/g, ' ').trim().slice(0, 400)
  let h = 5381
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** 缓存 key：类型 + 切片 id + 题干指纹（题干改了会自动重新生成） */
export function explainCacheKey(kind: LExplainKind, blockId: any, question: string): string {
  return `${kind}:${blockId ?? ''}:${fingerprint(question)}`
}

/** 读取已缓存的解析（无则 undefined） */
export function getExplain(data: LData | null | undefined, key: string): LExplainEntry | undefined {
  const e = data?.explains?.[key]
  return e && e.text ? e : undefined
}

/** 写入解析缓存（自动剪枝，返回是否真的写入了） */
export function setExplain(
  data: LData,
  key: string,
  text: string,
  kind: LExplainKind,
  lang?: 'zh' | 'en',
): boolean {
  const body = String(text || '').trim()
  if (!key || !body) return false
  if (!data.explains) data.explains = {}
  data.explains[key] = { text: body, at: Date.now(), kind, lang }
  const keys = Object.keys(data.explains)
  if (keys.length > MAX_EXPLAINS) {
    keys
      .sort((a, b) => (data.explains![a].at || 0) - (data.explains![b].at || 0))
      .slice(0, keys.length - MAX_EXPLAINS)
      .forEach(k => { delete data.explains![k] })
  }
  data.updatedAt = Date.now()
  return true
}

/** 删除某条解析缓存（用于「重新生成」前清旧值） */
export function clearExplain(data: LData, key: string): void {
  if (data.explains && data.explains[key]) { delete data.explains[key]; data.updatedAt = Date.now() }
}

/** 由 .kb 路径推导学习记录文件路径（新约定：同目录 <库名>.learning，不再追加 json） */
export function learningDataPath(kbPath: string): string {
  const p = kbPath.endsWith('.kb') ? kbPath.slice(0, -3) : kbPath
  return p + '.learning'
}
/** 旧约定 <库名>.learning.json（仅用于兼容读取历史记录） */
function legacyJsonPath(kbPath: string): string {
  const p = kbPath.endsWith('.kb') ? kbPath.slice(0, -3) : kbPath
  return p + '.learning.json'
}

export async function loadLData(kbPath: string): Promise<LData | null> {
  // 新路径优先；旧 .learning.json 兜底（迁移存量记录），保证历史数据仍可读
  for (const path of [learningDataPath(kbPath), legacyJsonPath(kbPath)]) {
    try {
      const content = await getPlatform().fs.readText(path)
      const raw = JSON.parse(content)
      if (!raw || typeof raw !== 'object' || !raw.objects) return null
      const data = raw as LData
      // 迁移/兜底：meta
      if (!data.meta) data.meta = emptyMeta()
      if (!data.meta.dayStats) data.meta.dayStats = {}
      // 兼容旧记录：补上解析缓存容器
      if (!data.explains) data.explains = {}
      if (!data.schemaVersion) data.schemaVersion = 1
      return data
    } catch (e) { /* 尝试下一候选 */ }
  }
  return null // 均不存在或损坏 → 视为空
}

export async function saveLData(kbPath: string, data: LData): Promise<boolean> {
  try {
    data.updatedAt = Date.now()
    const ok = await getPlatform().fs.saveText(learningDataPath(kbPath), JSON.stringify(data))
    return !!ok
  } catch (e) {
    console.error('[learning] 保存学习记录失败:', e)
    return false
  }
}

/** 用当前 .kb 的文件分组同步对象集合：新建文件对象 / 内容变更标记 stale / 删除文件标记 stale */
export function syncObjectsWithKb(
  data: LData,
  files: { key: string; label: string; type?: KbType; blockIds: (string | number)[] }[],
): boolean {
  let changed = false
  const now = Date.now()
  const seen = new Set<string>()
  for (const f of files) {
    seen.add(f.key)
    const o = data.objects[f.key]
    if (!o) {
      data.objects[f.key] = {
        kind: 'file',
        key: f.key,
        label: f.label,
        type: f.type || 'memory',
        blockIds: f.blockIds,
        attempts: [],
        srs: initSrs(now, f.type),
      }
      changed = true
    } else {
      if (o.label !== f.label) { o.label = f.label; changed = true }
      // 旧对象缺类型时补默认（不覆盖用户手动设置的类型）
      if (!o.type && f.type) { o.type = f.type; changed = true }
      const same = o.blockIds.length === f.blockIds.length && o.blockIds.every(id => f.blockIds.includes(id))
      if (!same) {
        // .kb 内容已变：保留记录并标记 stale（决策 5），更新切片快照
        o.stale = true
        o.staleSince = o.staleSince || now
        o.blockIds = f.blockIds
        changed = true
      }
    }
  }
  // 已不存在的文件对象 → 标记 stale（保留历史）
  for (const key of Object.keys(data.objects)) {
    if (seen.has(key)) continue
    const o = data.objects[key]
    if (!o.stale) { o.stale = true; o.staleSince = o.staleSince || now; changed = true }
  }
  return changed
}

/** 记录一次作答到文件对象：追加 attempt + 推进 SRS + 更新统计（含按日聚合）；返回该对象新掌握度 */
export function recordAttempt(
  data: LData,
  objKey: string,
  attempt: Omit<LAttempt, 'id'>,
): number {
  const o = data.objects[objKey]
  if (!o) return 0
  const now = Date.now()
  const full: LAttempt = { id: uid('a'), ...attempt }
  o.attempts.push(full)
  if (o.attempts.length > MAX_ATTEMPTS) o.attempts = o.attempts.slice(-MAX_ATTEMPTS)
  const noOf = attemptNumbers(o.attempts)
  // SRS 与掌握度用**同一个**证据质量分（对齐 DeepTutor：quality < 0.5 在那里就是 lapse）。
  // 于是"看了答案才答对"不会把复习间隔拉长——没能独立回忆起来，就不该拿到更长的间隔。
  const q = evidenceQuality(evidenceInputOf(full, noOf[noOf.length - 1]))
  // 四档评分决定档位：'hard' 不推进、'easy' 多进一档、'again' 视为失败
  // （同会话窗口内不会掉档，见 srsNext 的同会话分支）
  const rating: SrsRating = full.rating || (full.ok ? 'good' : 'again')
  o.srs = srsNext(o.srs, q >= QUALITY_PASS && ratingIsSuccess(rating), now, o.type, rating)
  o.lastPracticedAt = now
  // 掌握度按证据质量折算：看过答案/用提示之后的「对」不足以推开 0.9 的门。
  // 质性作答不进加权正确率（质性门控读 qualitativePass，不读分数）。
  // `masteredAt` 只在**量化**知识点上落：它表示"作答证据已过 0.9"，质性走的是另一条门。
  const m = objectMastery(o)
  const qualitativeGate = gateKindOfObject(o) === 'qualitative'
  if (!o.masteredAt && !qualitativeGate && m >= MASTERY_GATE) o.masteredAt = now

  data.meta.totalPractice += 1
  if (full.ok) data.meta.totalCorrect += 1
  data.meta.lastPracticeAt = now
  // 按日聚合（供近 7/30 天趋势与连续打卡）
  const day = dayKeyOf(now)
  const ds = data.meta.dayStats[day] || { ok: 0, total: 0 }
  ds.total += 1
  if (full.ok) ds.ok += 1
  data.meta.dayStats[day] = ds
  // 定期裁剪过期日数据，防止文件无限膨胀
  const keys = Object.keys(data.meta.dayStats)
  if (keys.length > MAX_DAYSTATS) {
    keys.sort()
    const drop = keys.length - MAX_DAYSTATS
    for (const k of keys.slice(0, drop)) delete data.meta.dayStats[k]
  }
  data.updatedAt = now
  return m
}

/**
 * 一次作答的**证据质量**（0..1）：答错=0；独立答对=1；看过答案/用提示/反复重试后答对 < 0.5
 * —— 也就是**推不开任何一档的掌握度门**。缺省字段（旧记录）按独立、零提示、第 1 次处理 → 恒为 1。
 *
 * @param attemptNo 这是对同一题的第几次尝试（1 起）；调用方按已落盘的 attempts 计数传入
 */
export function attemptQuality(a: LAttempt, attemptNo = 1): number {
  return evidenceQuality(evidenceInputOf(a, attemptNo))
}

/** `LAttempt` → 证据质量输入（缺省值在这里收敛成一处，避免调用方各写一套） */
function evidenceInputOf(a: LAttempt, attemptNo = 1) {
  return {
    ok: a.ok,
    independent: a.independent,
    hintsUsed: a.hintsUsed,
    attemptNo,
  }
}

/**
 * 该对象是否有**可判分的答案键**（问题库给了独立答案）。
 * 只用于"这道题能不能自动判分"，**不**参与门控判定（门只看知识类型）。
 */
export function hasAnswerKey(o: LObject): boolean {
  return o.attempts.some(a => a.hasAnswer === true && !!String(a.answer || '').trim())
}

/** 该对象走哪种门（量化 / 质性）：只看知识类型 */
export function gateKindOfObject(o: LObject): GateKind {
  return gateKindOf(o.type)
}

/**
 * 对象掌握度（派生，不落盘）：按证据质量折算后再走 `computeMastery`。
 *
 * **质性作答被排除**：它们不提供正确率证据（见 `LAttempt.qualitative`）。
 */
export function objectMastery(o: LObject): number {
  const items = o.attempts.filter(a => !a.qualitative)
  const noOf = attemptNumbers(items)
  return computeMasteryFromEvidence(items.map((a, i) => evidenceInputOf(a, noOf[i])))
}

/** 用于**门控**的掌握度：质性通过映射为 1，其余按证据质量加权正确率 */
export function objectGateMastery(o: LObject): number {
  return displayMastery(objectMastery(o), o.qualitativePass, gateKindOfObject(o) === 'qualitative')
}

/** 对象状态（地图/总览/图谱统一口径，含双门控与来源区分） */
export function objectStatus(o: LObject): 'new' | 'learning' | 'mastered' {
  return objectStatusOf({
    mastery: objectMastery(o),
    qualitativePass: o.qualitativePass,
    qualitativeGate: gateKindOfObject(o) === 'qualitative',
    masteredAt: o.masteredAt,
    claimMastered: o.claimMastered,
  })
}

/** 掌握来源：`system`（评测通过）/ `learner`（学习者声明）/ `''`（未过门） */
export function objectMasterySource(o: LObject): 'system' | 'learner' | '' {
  return masterySource({
    mastery: objectMastery(o),
    qualitativePass: o.qualitativePass,
    qualitativeGate: gateKindOfObject(o) === 'qualitative',
    masteredAt: o.masteredAt,
    claimMastered: o.claimMastered,
  })
}

/**
 * 记录一次**质性判定**（P1-2，对齐 DeepTutor `record_qualitative_for_path`）。
 *
 * - 判定结果落 `qualitativePass` + `qualitative`（含模型短评），并写一条 `qualitative` 作答；
 * - 通过时**不**走 `masteredAt`（那是量化口径的标记），门控由 `isGatePassed` 读 `qualitativePass`；
 * - SRS 仍按结果推进（判过 → 成功；判不过 → 失败），所以"没过"会在几天后被重新安排。
 */
export function recordQualitativeCheck(
  data: LData,
  objKey: string,
  verdict: { passed: boolean; explanation?: string; feedback?: string; lang?: 'zh' | 'en' },
  now = Date.now(),
): number {
  const o = data.objects[objKey]
  if (!o) return 0
  o.qualitativePass = !!verdict.passed
  o.qualitative = {
    passed: !!verdict.passed,
    explanation: String(verdict.explanation || '').trim() || undefined,
    feedback: String(verdict.feedback || '').trim() || undefined,
    at: now,
    lang: verdict.lang,
  }
  recordAttempt(data, objKey, {
    q: String(verdict.explanation || '').trim() || '（质性检查：用自己的话讲一遍）',
    ok: !!verdict.passed,
    score: verdict.passed ? 100 : 0,
    at: now,
    src: 'self',
    blockId: o.key,
    filePath: o.key,
    entityNames: [],
    hasAnswer: false,
    // 质性判定：不参与加权正确率，但参与 SRS 与作答历史
    qualitative: true,
    rating: verdict.passed ? 'good' : 'again',
    independent: true,
    hintsUsed: 0,
  })
  return data.objects[objKey] ? objectMastery(data.objects[objKey]) : 0
}

/** 某次作答是「对同一题的第几次尝试」（1 起）：按 blockId 分组、按落盘顺序计数 */
export function attemptNoOf(attempts: LAttempt[], index: number): number {
  return attemptNumbers(attempts)[index] ?? 1
}

/**
 * 一次扫描算出每个下标对应「第几次尝试」（1 起）。
 * 不用在循环里对每个下标都重扫一遍前缀：attempts 上限 40，但这条路径每次作答都会走。
 */
function attemptNumbers(attempts: LAttempt[]): number[] {
  const seen: Record<string, number> = {}
  const out: number[] = new Array(attempts.length)
  for (let i = 0; i < attempts.length; i++) {
    const k = String(attempts[i]?.blockId)
    seen[k] = (seen[k] || 0) + 1
    out[i] = seen[k]
  }
  return out
}

export function clearObject(data: LData, key: string, now = Date.now()): void {
  const o = data.objects[key]
  if (!o) return
  o.attempts = []
  o.srs = initSrs(now, o.type)
  o.stale = false
  o.staleSince = undefined
  o.masteredAt = undefined
  o.lastPracticedAt = undefined
  o.claimMastered = false
  // 质性判定是"这一遍讲清楚了"的证据，重学时要一起清掉，否则过期的通过会一直开着门
  o.qualitativePass = undefined
  o.qualitative = undefined
  data.updatedAt = now
}

/** 声明已掌握（跳测/压缩已会内容）：单独记录来源，不与作答证据混淆 */
export function claimMastered(data: LData, key: string, now = Date.now()): void {
  const o = data.objects[key]
  if (!o || o.stale) return
  o.claimMastered = true
  o.masteredAt = o.masteredAt || now
  data.updatedAt = now
}

/** 对某次作答标注错因（仅错题有意义） */
export function tagAttemptErr(data: LData, key: string, attemptId: string, errType: ErrType): boolean {
  const o = data.objects[key]
  if (!o) return false
  const a = o.attempts.find(x => x.id === attemptId)
  if (!a) return false
  a.errType = errType
  data.updatedAt = Date.now()
  return true
}

/** 清除过期标记（记录保留，视为当前内容下的复习起点） */
export function clearStale(data: LData, key: string, now = Date.now()): void {
  const o = data.objects[key]
  if (!o) return
  o.stale = false
  o.staleSince = undefined
  data.updatedAt = now
}

/** 到期对象（含优先级：近期答错 / 连续答错 的在前） */
export function dueObjects(
  data: LData,
  now = Date.now(),
): { key: string; o: LObject; mastery: number }[] {
  const out: { key: string; o: LObject; mastery: number }[] = []
  for (const key of Object.keys(data.objects)) {
    const o = data.objects[key]
    if (!o.attempts.length || o.stale || o.claimMastered) continue
    if (isSrsDue(o.srs, now)) out.push({ key, o, mastery: objectMastery(o) })
  }
  // 优先级：近期(最近3次内)答错次数越多越靠前；其次按到期时间
  out.sort((a, b) => {
    const wa = recentWrongs(a.o, 3)
    const wb = recentWrongs(b.o, 3)
    if (wb !== wa) return wb - wa
    return a.o.srs.dueAt - b.o.srs.dueAt
  })
  return out
}

/** 统计最近 n 次作答中的答错次数 */
function recentWrongs(o: LObject, n: number): number {
  const slice = o.attempts.slice(-n)
  let c = 0
  for (const a of slice) if (!a.ok) c++
  return c
}

/** 错题（跨对象，倒序） */
export function wrongAttempts(data: LData): { key: string; o: LObject; a: LAttempt }[] {
  const out: { key: string; o: LObject; a: LAttempt }[] = []
  for (const key of Object.keys(data.objects)) {
    const o = data.objects[key]
    for (const a of o.attempts) if (!a.ok) out.push({ key, o, a })
  }
  out.sort((x, y) => y.a.at - x.a.at)
  return out
}

/** 近 N 天每日聚合（含空天占位，旧->新），供趋势展示 */
export function trendStats(
  data: LData,
  days = 7
): { day: string; ok: number; total: number }[] {
  const out: { day: string; ok: number; total: number }[] = []
  const base = new Date()
  base.setHours(0, 0, 0, 0)
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(base.getTime() - i * 86400000)
    const key = dayKeyOf(d.getTime())
    const ds = data.meta.dayStats[key] || { ok: 0, total: 0 }
    out.push({ day: key.slice(5), ok: ds.ok, total: ds.total })
  }
  return out
}

/** 连续学习天数：从今天（或昨天）向前连续有练习的天数 */
export function streakDays(data: LData): number {
  const base = new Date()
  base.setHours(0, 0, 0, 0)
  let n = 0
  // 若今天还没练过，允许从昨天开始算（保持连续不断）
  const todayKey = dayKeyOf(base.getTime())
  const todayTotal = data.meta.dayStats[todayKey]?.total || 0
  const start = todayTotal > 0 ? 0 : 1
  for (let i = start; i < 400; i++) {
    const d = new Date(base.getTime() - i * 86400000)
    const ds = data.meta.dayStats[dayKeyOf(d.getTime())]
    if (ds && ds.total > 0) n++
    else break
  }
  return n
}
