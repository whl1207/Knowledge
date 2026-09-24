/**
 * selftest.ts — 断行算法自测（纯计算，不依赖 DOM）
 *
 * 覆盖：最优性（K-P 优于贪心）、拉伸上限、不溢出、中文禁则、强制断行、稳定性。
 */
import { breakLines, greedy, type TsItem } from './break'
import { canBreakBetween, isCJK, NO_LINE_START } from './chars'

export interface TypesetCase {
  name: string
  ok: boolean
  detail?: string
}

/** 构造西文词序列：词宽给定，词间空格可拉伸 0.5×space、可压缩 0.34×space */
function words(ws: number[], spaceW: number): TsItem[] {
  const out: TsItem[] = []
  ws.forEach((w, i) => {
    out.push({ w, kind: 'box' })
    if (i < ws.length - 1) {
      out.push({
        w: spaceW,
        kind: 'glue',
        stretch: spaceW * 0.5,
        shrink: spaceW * 0.34,
        breakAfter: true,
        penalty: 0,
      })
    }
  })
  out[out.length - 1].breakAfter = true
  return out
}

/** 构造中文序列：逐字 box + 零宽胶（可断、可拉伸） */
function cjk(chars: string, charW: number, stretch: number): TsItem[] {
  const out: TsItem[] = []
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (i > 0) {
      const prev = chars[i - 1]
      const canBreak = canBreakBetween(prev, ch)
      out.push({
        w: 0,
        kind: 'glue',
        stretch: canBreak ? stretch : 0,
        shrink: 0,
        breakAfter: canBreak,
        penalty: 0,
      })
    }
    out.push({ w: charW, kind: 'box' })
    if (i === chars.length - 1) out[out.length - 1].breakAfter = true
  }
  return out
}

/** 每行（除末行）满足：自然宽 ≤ 行宽，且「有可拉伸量时」应该被拉满 */
function linesWithinLimit(items: TsItem[], lines: ReturnType<typeof breakLines>['lines'], measure: number): string | null {
  void items
  for (const line of lines) {
    if (line.natural > measure + 0.5) return `${line.last ? '末行' : '行'}溢出 ${line.natural.toFixed(1)} > ${measure}`
    if (line.last) continue
    if (line.stretch > 0.5 && line.natural + line.stretch + 0.5 < measure) {
      return `行拉不满 ${line.natural.toFixed(1)}+${line.stretch.toFixed(1)} < ${measure}`
    }
  }
  return null
}

export function runTypesetSelfTest(): TypesetCase[] {
  const cases: TypesetCase[] = []
  const push = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, detail })

  // 1) 中文：一行 10 字（字宽 15 → 150px），24 字应排成 3 行
  {
    const items = cjk('中文排版测试中文排版测试中文排版测试中文排版测试', 15, 1.2)
    const r = breakLines(items, { measure: 150 })
    push('中文逐字断行行数合理', r.lines.length === 3, `lines=${r.lines.length}`)
    push('中文行宽不溢出', linesWithinLimit(items, r.lines, 150) === null, linesWithinLimit(items, r.lines, 150) || '')
  }

  // 2) 中文禁则：断点不能落在「，」之前
  {
    const text = '中文测试中文，中文测试中文'
    const items = cjk(text, 15, 1.2)
    const r = breakLines(items, { measure: 76 }) // 约 5 字一行
    let bad = ''
    for (const line of r.lines) {
      // 取该行最后一个 box 的字符
      let lastCh = ''
      for (let i = line.start; i <= line.end; i++) {
        if (items[i] && items[i].kind === 'box') lastCh = text[Math.floor(i / 2)] || lastCh
      }
      if (lastCh && NO_LINE_START.has(lastCh)) bad = `行尾是禁则字符「${lastCh}」`
    }
    push('中文禁则（不把标点甩到行首）', bad === '', bad)
  }

  // 3) 西文：K-P 不应比贪心差（同一代价函数下）
  {
    const ws = [58, 72, 41, 66, 53, 84, 47, 61, 69, 38, 76, 55, 43, 67, 51, 80, 44, 62]
    const items = words(ws, 5)
    const measure = 320
    const kp = breakLines(items, { measure })
    const gd = greedy(items, measure)
    push('K-P 不劣于贪心', kp.demerits <= gd.demerits, `kp=${kp.demerits.toFixed(0)} greedy=${gd.demerits.toFixed(0)}`)
    push('K-P 行宽不溢出', linesWithinLimit(items, kp.lines, measure) === null, linesWithinLimit(items, kp.lines, measure) || '')
  }

  // 4) 拉伸超限时不应硬拉：不能溢出（可退化到贪心）
  {
    const items = words([200, 200, 200], 4) // 空格几乎不可拉伸
    const r = breakLines(items, { measure: 210 })
    const bad = linesWithinLimit(items, r.lines, 210)
    push('拉伸超限时不溢出', bad === null, bad || `fallback=${r.fallback}`)
  }

  // 5) 强制断行（<br>）必须生效
  {
    const items: TsItem[] = []
    items.push({ w: 50, kind: 'box' })
    items.push({ w: 10, kind: 'glue', stretch: 5, shrink: 3, breakAfter: true })
    items.push({ w: 50, kind: 'box' })
    items.push({ w: 0, kind: 'box', breakAfter: true, forced: true })
    items.push({ w: 60, kind: 'box', breakAfter: true })
    const r = breakLines(items, { measure: 300 })
    push('强制断行生效', r.lines.length >= 2 && r.lines[0].end <= 3, `lines=${r.lines.length}`)
  }

  // 6) 稳定性：同一输入多次调用结果一致
  {
    const items = cjk('稳定性测试稳定性测试稳定性测试', 15, 1.2)
    const a = breakLines(items, { measure: 100 })
    const b = breakLines(items, { measure: 100 })
    push(
      '结果稳定（同输入同输出）',
      JSON.stringify(a.lines) === JSON.stringify(b.lines),
      `${a.lines.length}/${b.lines.length}`
    )
  }

  // 7) 字符分类
  {
    push('CJK 判定', isCJK('中') && isCJK('，') && !isCJK('a') && !isCJK('1'))
    push('禁则表内容', NO_LINE_START.has('，') && NO_LINE_START.has('。') && !canBreakBetween('你', '，'))
  }

  return cases
}
