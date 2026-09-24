/**
 * 学习引擎（纯函数，无 IO/UI 依赖）——掌握度 + 间隔复习 + 题目拆分
 * 设计思路参考 HKUDS/DeepTutor learning 引擎（仅借鉴算法，不引代码）：
 * - computeMastery：近期加权正确率 + 低置信度封顶（单次蒙对不能算掌握）
 * - SRS：按知识类型采用不同间隔表，连对跳档、连错倒退、连续错 2 次重置
 * - 知识类型化（P2.5）：memory / procedure / concept / design 走不同复习节奏
 */
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

export type ObjStatus = 'new' | 'learning' | 'mastered'
export function objStatus(m: number): ObjStatus {
  if (m <= 0) return 'new'
  return m >= MASTERY_GATE ? 'mastered' : 'learning'
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
}

export function initSrs(now: number, type?: KbType | null): Lsrs {
  const its = srsIntervals(type)
  return { idx: 0, consecOk: 0, consecMiss: 0, dueAt: now + its[0] * DAY_MS }
}

export function isSrsDue(s: Lsrs, now: number): boolean {
  return s.dueAt <= now
}

export function srsNext(s: Lsrs, ok: boolean, now: number, type?: KbType | null): Lsrs {
  const its = srsIntervals(type)
  const maxIdx = its.length - 1
  const st: Lsrs = { ...s }
  if (ok) {
    st.consecMiss = 0
    st.consecOk += 1
    // 连续答对 2 次视为稳定，跳两档（防单点刷分）；否则进一档
    st.idx = st.consecOk >= 2 ? st.idx + 2 : st.idx + 1
    if (st.consecOk >= 2) st.consecOk = 0
  } else {
    st.consecMiss += 1
    st.consecOk = 0
    st.idx = Math.max(0, st.idx - 1)
    if (st.consecMiss >= 2) st.consecMiss = 0
  }
  st.idx = Math.max(0, Math.min(st.idx, maxIdx))
  st.dueAt = now + its[st.idx] * DAY_MS
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
