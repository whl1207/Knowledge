// 配对显著性检验与基础统计（检索策略对比用）
// 纯函数、无依赖：供测试面板做「同一批问题上的配对比较」并判断差异是否显著。

/** 均值（空数组返回 0） */
export function meanOf(list: number[]): number {
  return list.length ? list.reduce((s, x) => s + x, 0) / list.length : 0
}

/** 样本标准差（n < 2 时返回 undefined：单次运行没有标准差可言） */
export function stdOf(list: number[]): number | undefined {
  if (list.length < 2) return undefined
  const m = meanOf(list)
  return Math.sqrt(list.reduce((s, x) => s + (x - m) * (x - m), 0) / (list.length - 1))
}

/** 对数组合数 log C(n,k)：大 n 下避免阶乘溢出 */
export function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity
  const kk = Math.min(k, n - k)
  let s = 0
  for (let i = 1; i <= kk; i++) s += Math.log(n - kk + i) - Math.log(i)
  return s
}

/**
 * McNemar 精确检验（配对二分类、双侧）：p = 2·P(X ≤ min(b,c))，X ~ B(b+c, 0.5)。
 * 用于判断「两个策略在同一批问题上命中/未命中」的差异是否显著。
 */
export function mcnemarExactP(b: number, c: number): number {
  const n = b + c
  if (n <= 0) return 1
  const logs: number[] = []
  for (let i = 0; i <= n; i++) logs.push(logChoose(n, i) - n * Math.log(2))
  const maxLog = Math.max(...logs)
  let partial = 0
  for (let i = 0; i <= Math.min(b, c); i++) partial += Math.exp(logs[i] - maxLog)
  return Math.min(1, Math.max(0, 2 * Math.exp(maxLog) * partial))
}

/** 标准正态 CDF（Abramowitz–Stegun 7.1.26 近似，精度约 1e-7，足够 p 值展示） */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2)
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return z >= 0 ? 1 - p : p
}

/**
 * Wilcoxon 符号秩检验（配对、双侧）：正态近似 + 并列校正 + 连续性校正。
 * 输入为逐样本的「对比 - 基线」差值；零差值样本按标准做法剔除。返回双侧 p 值。
 */
export function wilcoxonSignedRankP(diffs: number[]): number {
  const d = diffs.filter(x => x !== 0)
  const n = d.length
  if (n === 0) return 1
  const order = d.map((v, i) => ({ v: Math.abs(v), i })).sort((a, b) => a.v - b.v)
  const ranks = new Array<number>(n).fill(0)
  const tieGroups: number[] = []
  let i = 0
  while (i < n) {
    let j = i
    while (j + 1 < n && order[j + 1].v === order[i].v) j++
    const size = j - i + 1
    tieGroups.push(size)
    const avgRank = (i + 1 + j + 1) / 2
    for (let k = i; k <= j; k++) ranks[order[k].i] = avgRank
    i = j + 1
  }
  let wPlus = 0
  for (let k = 0; k < n; k++) if (d[k] > 0) wPlus += ranks[k]
  const mu = (n * (n + 1)) / 4
  let variance = (n * (n + 1) * (2 * n + 1)) / 24
  for (const t of tieGroups) if (t > 1) variance -= (t ** 3 - t) / 48
  const sd = Math.sqrt(Math.max(variance, 1e-9))
  const delta = wPlus - mu
  const z = (delta - Math.sign(delta) * 0.5) / sd
  return Math.min(1, Math.max(0, 2 * (1 - normalCdf(Math.abs(z)))))
}
