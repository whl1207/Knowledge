/**
 * 学习记录落盘层（A2：与 .kb 同目录的 <库名>.learning，绝不写回 .kb；兼容读取旧 <库名>.learning.json）
 * 约定见 docs/设计决策记录.md §五 学习模块（存储设计）。
 *
 * 存储主体：objects 以「文件相对路径」为 key（kind='file'）。切片归属唯一文件，
 * 因此 attempt 只存一份于其所属文件对象；实体轴（P2）由同一份 attempt 经
 * entityNames/blockId 投影聚合。
 */
import { computeMastery, initSrs, isSrsDue, KbType, Lsrs, MASTERY_GATE, srsNext, uid } from '@/services/learningCore'

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
}

export interface DayStat { ok: number; total: number }
export interface LMeta {
  totalPractice: number
  totalCorrect: number
  lastPracticeAt: number
  /** 按日聚合（作答高频小写，attempts 会被裁剪，长期趋势依赖此聚合） */
  dayStats: Record<string, DayStat>
}

export interface LData {
  schemaVersion: 1
  kbFile: string
  updatedAt: number
  objects: Record<string, LObject>
  meta: LMeta
}

const MAX_ATTEMPTS = 40
const MAX_DAYSTATS = 120

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
  }
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
      const content = await window.ipcRenderer.invoke('readFile', path)
      const raw = JSON.parse(content)
      if (!raw || typeof raw !== 'object' || !raw.objects) return null
      const data = raw as LData
      // 迁移/兜底：meta
      if (!data.meta) data.meta = emptyMeta()
      if (!data.meta.dayStats) data.meta.dayStats = {}
      if (!data.schemaVersion) data.schemaVersion = 1
      return data
    } catch (e) { /* 尝试下一候选 */ }
  }
  return null // 均不存在或损坏 → 视为空
}

export async function saveLData(kbPath: string, data: LData): Promise<boolean> {
  try {
    data.updatedAt = Date.now()
    const ok = await window.ipcRenderer.invoke('saveFile', learningDataPath(kbPath), JSON.stringify(data))
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
  o.srs = srsNext(o.srs, full.ok, now, o.type)
  o.lastPracticedAt = now
  const m = computeMastery(o.attempts.map(a => a.ok))
  if (!o.masteredAt && m >= MASTERY_GATE) o.masteredAt = now

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

/** 对象掌握度（派生，不落盘） */
export function objectMastery(o: LObject): number {
  return computeMastery(o.attempts.map(a => a.ok))
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
