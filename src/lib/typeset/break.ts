/**
 * break.ts — 断行算法（Knuth-Plass 型动态规划 + 中文禁则），纯计算、可单测
 *
 * 与教科书 K-P 的对应关系：
 *   - box：字 / 西文词 / 行内原子（图片、公式），有宽度
 *   - glue：可断点 + 可拉伸量。西文空格是「有宽度的胶」，中文逐字断点用「零宽度胶」表示
 *   - penalty：断行代价（<br> 用 forced 表示强制断行）
 *
 * 与教科书不同的两点：
 *   1) 中文没有空格，逐字断点用零宽 glue + 有限 stretch 表达（行内加空隙＝字距拉伸）
 *   2) 末行不拉伸（左对齐），只惩罚过短（寡行）与溢出
 *
 * 复杂度：反向累加 + 剪枝后每行只看「大约一行的 item 数」，整体 O(n × 每行 item 数)。
 */

export interface TsItem {
  /** 宽度（px） */
  w: number
  kind: 'box' | 'glue'
  /** 可拉伸量（glue 才有） */
  stretch?: number
  /** 可压缩量（glue 才有） */
  shrink?: number
  /** 是否允许在本项之后断行 */
  breakAfter?: boolean
  /** 断行代价（0 正常；正数表示不愿在此断） */
  penalty?: number
  /** 强制断行（对应 <br>） */
  forced?: boolean
}

export interface TsLine {
  /** 起始 item 下标（含） */
  start: number
  /** 结束 item 下标（含；若是 glue 则其宽度不计入） */
  end: number
  /** 自然宽度（不含断点处的胶） */
  natural: number
  /** 本行可拉伸总量 */
  stretch: number
  /** 拉伸比例（0 表示不需要拉伸；末行为 0） */
  ratio: number
  /** 是否末行（左对齐，不拉伸） */
  last: boolean
}

export interface BreakOptions {
  /** 行宽（px） */
  measure: number
  /** 末行过短的惩罚阈值（占行宽比例，默认 0.35） */
  lastShortRatio?: number
}

export interface BreakResult {
  lines: TsLine[]
  demerits: number
  /** 是否退化成了贪心（DP 无解时的兜底） */
  fallback: boolean
}

const INF = Number.POSITIVE_INFINITY

/** 单行代价（导出以便自测 / 兜底比较） */
export function lineDemerits(
  w: number,
  stretch: number,
  shrink: number,
  measure: number,
  isLast: boolean,
  penalty: number,
  lastShortRatio: number,
  forcedBreak = false
): number {
  if (isLast) {
    // 末行左对齐：不要求拉伸，只罚溢出与过短（寡行）
    if (w > measure + 0.5) return INF
    const fill = measure > 0 ? w / measure : 1
    if (fill >= lastShortRatio) return Math.pow(1 + penalty, 2)
    const t = 1 - fill / lastShortRatio // 0..1
    return Math.pow(1 + 100 * t * t * t + penalty, 2)
  }
  if (w > measure) {
    // 溢出：要压缩，缩不了就很贵（但有限，保证 DP 总能有解）
    const deficit = w - measure
    if (shrink <= 0) return Math.pow(1 + 1e5 + 1e4 * (deficit / Math.max(1, measure)) + penalty, 2)
    const r = -deficit / shrink
    if (r >= -1) return Math.pow(1 + Math.min(1e5, 100 * Math.abs(r) ** 3) + penalty, 2)
    return Math.pow(1 + 1e5 + 1e4 * (Math.abs(r) - 1) + penalty, 2)
  }
  const excess = measure - w
  if (excess <= 0.5) return Math.pow(1 + penalty, 2)
  // 强迫断行（<br>）前面的短行无法避免：给个小惩罚就够了
  if (forcedBreak) return Math.pow(1 + 20 + penalty, 2)
  // 可拉伸区：K-P 经典三次代价（偏好「均匀拉伸」）
  // 超过可拉伸量：线性追加重罚。
  // 注意不能给「无法拉伸」更便宜的价 —— 否则 DP 会倾向于「把行断得只剩一个词」。
  const nominal = stretch > 0 ? stretch : measure * 0.005
  const r = excess / nominal
  const badness = r <= 1 ? 100 * r ** 3 : 100 + 1000 * (r - 1)
  return Math.pow(1 + Math.min(1e6, badness) + penalty, 2)
}

/**
 * 断行主函数。items.length 为 0 时返回空行集。
 */
export function breakLines(items: TsItem[], opts: BreakOptions): BreakResult {
  const measure = Math.max(1, opts.measure)
  const lastShortRatio = opts.lastShortRatio ?? 0.35
  const n = items.length
  if (!n) return { lines: [], demerits: 0, fallback: false }

  // 断点候选：breakAfter 的 item 下标（含强制断行）
  const cand: number[] = []
  for (let i = 0; i < n; i++) if (items[i].breakAfter) cand.push(i)
  if (!cand.length || cand[cand.length - 1] !== n - 1) cand.push(n - 1) // 末项必定是断点

  // 前缀和：宽度 / 拉伸 / 压缩
  const pw = new Float64Array(n + 1)
  const ps = new Float64Array(n + 1)
  const pk = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) {
    const it = items[i]
    const glue = it.kind === 'glue'
    pw[i + 1] = pw[i] + (it.w || 0)
    ps[i + 1] = ps[i] + (glue ? it.stretch ?? 0 : 0)
    pk[i + 1] = pk[i] + (glue ? it.shrink ?? 0 : 0)
  }
  const isGlue = (i: number) => items[i].kind === 'glue' && i >= 0 && i < n

  // 行 [a, b]：b 是断点项；若 b 是胶，其宽度/可拉伸量在断行处丢弃
  const lineW = (a: number, b: number) => pw[b + 1] - pw[a] - (isGlue(b) ? items[b].w || 0 : 0)
  const lineS = (a: number, b: number) => ps[b + 1] - ps[a] - (isGlue(b) ? items[b].stretch ?? 0 : 0)
  const lineK = (a: number, b: number) => pk[b + 1] - pk[a] - (isGlue(b) ? items[b].shrink ?? 0 : 0)

  // 最大的可行行宽（超过就一定要压缩，压缩能力有限）
  const maxStretchAll = ps[n]
  const maxW = measure + pk[n] + 1
  void maxStretchAll

  // 强制断行的位置：任何一行都不能跨过它
  const forcedBefore = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) forcedBefore[i + 1] = forcedBefore[i] + (items[i].forced ? 1 : 0)

  const best: Array<number> = new Array(cand.length).fill(INF)
  const prevOf: number[] = new Array(cand.length).fill(-2) // -2 = 不可达
  const ratioOf: number[] = new Array(cand.length).fill(0)

  for (let ci = 0; ci < cand.length; ci++) {
    const i = cand[ci]
    const isLast = ci === cand.length - 1
    const penalty = items[i].forced ? 0 : items[i].penalty ?? 0
    // 反向枚举上一断点（累加宽度超上限即剪枝：再往前只会更长）
    for (let cj = ci - 1; cj >= -1; cj--) {
      const prev = cj < 0 ? -1 : cand[cj]
      const a = prev + 1
      // 跨过强制断行（<br>）的区间不合法
      if (forcedBefore[i] - forcedBefore[a] > 0) {
        if (cj < 0) break
        continue
      }
      const w = lineW(a, i)
      if (w > maxW && cj < ci - 1) break
      const s = lineS(a, i)
      const k = lineK(a, i)
      const d = lineDemerits(
        w,
        s,
        k,
        measure,
        isLast,
        penalty,
        lastShortRatio,
        !!items[i].forced
      )
      if (d === INF) continue
      const base = prev < 0 ? 0 : best[cj]
      if (base === INF) continue
      const total = base + d
      if (total < best[ci]) {
        best[ci] = total
        prevOf[ci] = cj
        if (isLast) {
          ratioOf[ci] = 0
        } else if (w >= measure) {
          ratioOf[ci] = k > 0 ? -(w - measure) / k : 0
        } else {
          ratioOf[ci] = s > 0 ? (measure - w) / s : 0
        }
      }
      if (cj < 0) break
    }
  }

  const last = cand.length - 1
  if (best[last] === INF) {
    return greedy(items, measure)
  }

  // 回溯
  const lines: TsLine[] = []
  let ci = last
  while (ci >= 0) {
    const prev = prevOf[ci]
    const a = (prev < 0 ? -1 : cand[prev]) + 1
    const b = cand[ci]
    lines.push({
      start: a,
      end: b,
      natural: lineW(a, b),
      stretch: lineS(a, b),
      ratio: ratioOf[ci],
      last: ci === last,
    })
    if (prev < 0) break
    ci = prev
  }
  lines.reverse()
  return { lines, demerits: best[last], fallback: false }
}

/** 兜底：贪心 First-Fit（DP 无解时至少能排出不溢出的行） */
export function greedy(items: TsItem[], measure: number): BreakResult {
  const n = items.length
  if (!n) return { lines: [], demerits: 0, fallback: true }
  const isGlue = (i: number) => i >= 0 && i < n && items[i].kind === 'glue'
  const pw = new Float64Array(n + 1)
  const ps = new Float64Array(n + 1)
  const pk = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) {
    pw[i + 1] = pw[i] + (items[i].w || 0)
    ps[i + 1] = ps[i] + (isGlue(i) ? items[i].stretch ?? 0 : 0)
    pk[i + 1] = pk[i] + (isGlue(i) ? items[i].shrink ?? 0 : 0)
  }
  const lineW = (a: number, b: number) => pw[b + 1] - pw[a] - (isGlue(b) ? items[b].w || 0 : 0)
  const lineS = (a: number, b: number) => ps[b + 1] - ps[a] - (isGlue(b) ? items[b].stretch ?? 0 : 0)
  const lineK = (a: number, b: number) => pk[b + 1] - pk[a] - (isGlue(b) ? items[b].shrink ?? 0 : 0)

  const breaks: number[] = []
  for (let i = 0; i < n; i++) if (items[i].breakAfter) breaks.push(i)
  if (!breaks.length || breaks[breaks.length - 1] !== n - 1) breaks.push(n - 1)

  const lines: TsLine[] = []
  let start = 0
  for (let k = 0; k < breaks.length; k++) {
    const b = breaks[k]
    const isLast = k === breaks.length - 1
    const next = isLast ? -1 : breaks[k + 1]
    // 当前行已经能收：只要再放下一断点区间就溢出，就在 b 处断
    if (isLast || lineW(start, next) > measure) {
      lines.push({ start, end: b, natural: lineW(start, b), stretch: lineS(start, b), ratio: 0, last: isLast })
      start = b + 1
    }
  }
  // 用同一套代价函数算总分，便于与 DP 结果比较
  let demerits = 0
  for (const line of lines) {
    const d = lineDemerits(line.natural, line.stretch, lineK(line.start, line.end), measure, line.last, 0, 0.35)
    demerits += d === INF ? 1e9 : d
  }
  return { lines, demerits, fallback: true }
}
