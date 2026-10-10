/**
 * PDF 翻译公共逻辑：文本分块（带坐标）+ LLM 逐段翻译 + 结果缓存。
 *
 * 关键点：分块坐标刻意与 pdf.js 文本层用**同一套数学** —— 在 scale=1 空间里算
 * left/top/宽高，输出到叠加层时写成 `calc(var(--scale-factor) * Npx)`。
 * 因此译文只需计算一次，缩放时由 CSS 变量自动跟随，不需要在缩放 / 平移时重算。
 * （`--scale-factor`：单页模式由组件写在叠加层上，连续模式由 .pdf-scroll 继承。）
 *
 * 调用统一走 `AIUtils.sendChat`（与 @/lib/knowFile/ocr 一致）：Electron 下委托主进程，
 * 浏览器 / LAN 模式走代理；纯文本请求，不带图片与工具。
 */
import { Util } from 'pdfjs-dist'
import { AIUtils } from '@/services/ai-utils'
import { llmConfigByKey, normalizeLlmType } from '@/shared/llmSources'

export type TranslateTarget = 'zh' | 'en'

/** 目标语言 → 提示词里的语言名 */
export function targetLangName(target: TranslateTarget, zh: boolean): string {
  if (target === 'zh') return zh ? '简体中文' : 'Simplified Chinese'
  return 'English'
}

/** 界面语言（store.locales）→ 翻译目标语言：英文界面译成英文，其余译成中文 */
export function targetLangOfLocale(locale: string): TranslateTarget {
  return locale === 'en' ? 'en' : 'zh'
}

// ---------------------------------------------------------------------------
// 分块（带坐标）
// ---------------------------------------------------------------------------

/** 页面内的一个文本块（段落级），坐标为 scale=1 的 CSS px */
export interface PdfTextBlock {
  /** 稳定键：`p{页}-{序号}`（缓存与叠加层以它为 key） */
  id: string
  page: number
  text: string
  left: number
  top: number
  width: number
  height: number
  /** 基准字号（取块内最大字号），叠加层字号以它为基准 */
  fontSize: number
  /** 旋转角（度）；非 0 的块 v1 不做叠加，只参与文本匹配 */
  angle: number
  /** 参与合成的行数 */
  lines: number
  /** 译文框的右边界上限（scale=1）：双栏页里限制在本栏内，不压到另一栏的文字 */
  maxRight: number
  /** 首行缩进（scale=1 px，>0 表示首行比正文缩进）；叠加层用 text-indent 还原 */
  indentFirst: number
  /** 悬挂缩进（scale=1 px，>0 表示“首行标号突出、正文缩进”）；叠加层用 padding + 负 text-indent 还原 */
  indentHanging: number
  /**
   * 公式 / 数字为主的块（无实际可翻译的自然语言）：不送去翻译，保留原样，
   * 避免「𝑅 1 = 」「(3)」「0.5 0.62」这类碎片被模型改写或产生无意义译文。
   */
  math?: boolean
}

/** 上升部 / 下降部相对字号的近似比例（与 pdf.js 的 fontAscent 度量接近，够用即可） */
const ASCENT_RATIO = 0.82
const DESCENT_RATIO = 0.22

/**
 * 同一行内超过「该倍数 × 字号」的水平空隙 → 视为分栏间隙 / 表格列间隙，切成不同的块。
 * 正文的词间空隙通常 ≤ 0.5 字号；双栏论文的栏间隙一般 ≥ 1.5 字号，取 1.6 可稳定区分。
 */
const GUTTER_RATIO = 1.6

/**
 * 单块上限：只作病态情况的安全网（正常段落一律完整合成一块，摘要这类长段落不会被截断）。
 * 模型完全能吃下更长的文本，真正决定请求粒度的是下面的分批上限。
 */
const MAX_PARA_LINES = 200
const MAX_PARA_CHARS = 8000

/** 纯页码 / 罗马页码行 */
const PAGE_NUM_RE = /^[\s\-–—_·.]*(\d{1,4}|[ivxlcdm]{1,7})[\s\-–—_·.]*$/i

interface RawItem {
  text: string
  left: number
  right: number
  baseline: number
  fontSize: number
  angle: number
}

interface LineBox {
  left: number
  right: number
  top: number
  bottom: number
  fontSize: number
}

/** 一个「行片段」：同一基线上、被栏间隙切开的连续文字 */
interface LineRun {
  text: string
  box: LineBox
  angle: number
  /** 同一行内紧邻右侧元素的左边界（表格单元格 / 分栏时用来限制译文框不压到它） */
  nextLeft?: number
  /** 本片段所属栏的右边界（scale=1；通栏片段 = 文字区右边界）—— 由 buildPageBlocks 填充 */
  colRight: number
}

interface Segment {
  text: string
  box: LineBox
  angle: number
  lines: number
  /** 译文框右边界参考（取块内各行的 nextLeft 最小值；缺省 = 无限制） */
  limit?: number
  /** 本段所属栏的右边界（取首行的 colRight） */
  colRight: number
  /** 首行左边界 */
  firstLeft: number
  /** 第二行（正文续行）左边界；单行块为 undefined */
  bodyLeft?: number
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\uf900-\ufaff]/

/** 文本项 → scale=1 空间几何（pdf.js 文本层内部用的是同一个翻转矩阵） */
function itemToRaw(item: any, flip: number[]): RawItem | null {
  const str = String(item?.str ?? '')
  if (!str.trim()) return null
  const width = Number(item?.width)
  const w = Number.isFinite(width) && width > 0 ? width : 0
  const tx = Util.transform(flip, item.transform)
  const fontSize = Math.hypot(tx[2], tx[3])
  if (!(fontSize > 0)) return null
  const deg = (Math.atan2(tx[1], tx[0]) * 180) / Math.PI
  return {
    text: str,
    left: tx[4],
    right: tx[4] + w,
    baseline: tx[5],
    fontSize,
    angle: Math.abs(deg) < 0.5 ? 0 : deg,
  }
}

/** 行内拼接：CJK 之间不加空格，其余按需补空格（PDF 常把空格放在项首尾） */
function joinItemText(parts: RawItem[]): string {
  let s = ''
  for (const it of parts) {
    if (!s) { s = it.text; continue }
    const prev = s[s.length - 1]
    const next = it.text[0] || ''
    const needSpace = !/\s$/.test(s) && !/^\s/.test(it.text) && !(CJK_RE.test(prev) && CJK_RE.test(next))
    s += (needSpace ? ' ' : '') + it.text
  }
  return s.replace(/\s+/g, ' ').trim()
}

function lineBox(parts: RawItem[]): LineBox {
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity, fontSize = 0
  for (const it of parts) {
    left = Math.min(left, it.left)
    right = Math.max(right, it.right)
    top = Math.min(top, it.baseline - it.fontSize * ASCENT_RATIO)
    bottom = Math.max(bottom, it.baseline + it.fontSize * DESCENT_RATIO)
    fontSize = Math.max(fontSize, it.fontSize)
  }
  return { left, right, top, bottom, fontSize }
}

/**
 * 按基线聚成行 → 行内再按水平空隙切成「行片段」。
 * 这一步是双栏排版的**关键**：左右栏文字共享基线，只有按栏间隙切开，
 * 才能让同一栏的相邻行重新变成相邻元素（后续聚段、叠加框都依赖它）。
 */
function rowRuns(items: RawItem[]): LineRun[] {
  const sorted = [...items].sort((a, b) => a.baseline - b.baseline || a.left - b.left)
  const rows: RawItem[][] = []
  for (const it of sorted) {
    const last = rows[rows.length - 1]
    if (last) {
      const tol = Math.max(2, Math.max(last[0].fontSize, it.fontSize) * 0.45)
      if (Math.abs(it.baseline - last[0].baseline) <= tol) { last.push(it); continue }
    }
    rows.push([it])
  }

  const runs: LineRun[] = []
  for (const row of rows) {
    row.sort((a, b) => a.left - b.left)
    // 先按水平空隙把这一行切成若干片段
    const parts: RawItem[][] = []
    let cur: RawItem[] = []
    for (const it of row) {
      const prev = cur[cur.length - 1]
      if (prev && it.left - prev.right > Math.max(prev.fontSize, it.fontSize) * GUTTER_RATIO) {
        parts.push(cur)
        cur = []
      }
      cur.push(it)
    }
    if (cur.length) parts.push(cur)
    // 记录每个片段右侧紧邻元素的左边界（译文框右界参考）
    for (let i = 0; i < parts.length; i++) {
      const text = joinItemText(parts[i])
      if (!text) continue
      const run: LineRun = { text, box: lineBox(parts[i]), angle: parts[i][0].angle, colRight: 0 }
      if (parts[i + 1]) run.nextLeft = lineBox(parts[i + 1]).left
      runs.push(run)
    }
  }
  return runs
}

/**
 * 一侧是否「像一栏」：至少 3 个片段，且 ≥60% 的片段左边界聚在同一处。
 * 真实分栏都有统一的栏左边距，因此这条能排除「页码 / 旋转标签 / 表格零散单元格」凑出的假双栏。
 */
function sideLooksLikeColumn(runs: LineRun[]): boolean {
  if (runs.length < 3) return false
  const lefts = runs.map((r) => r.box.left).sort((a, b) => a - b)
  const median = percentile(lefts, 0.5)
  const aligned = lefts.filter((l) => Math.abs(l - median) <= 2.5).length
  return aligned >= lefts.length * 0.6
}

/**
 * 双栏判定：找一个「几乎没有片段跨越」的竖直分界线（栏间隙），且两侧都成规模、都像一栏。
 * 单栏页面里正文行本身会横跨整个文字区，因此找不到这样的分界线，不会误判。
 * 允许极少数跨越（跨栏的图题 / 宽公式很常见），按「跨越最少 → 两侧最均衡」择优。
 * @returns 分界线 x（scale=1 坐标）；null = 单栏
 */
function detectColumnMid(runs: LineRun[], textLeft: number, textRight: number): number | null {
  const W = textRight - textLeft
  if (!(W > 40) || runs.length < 6) return null
  // 跨栏级别的片段（通栏标题 / 单栏区正文）不参与判定
  const colish = runs.filter((r) => r.box.right - r.box.left <= W * 0.6)
  if (colish.length < 8) return null

  const crossLimit = Math.max(2, Math.round(colish.length * 0.2))
  const candidates: { mid: number; cross: number; balance: number }[] = []
  for (let k = 0; k <= 15; k++) {
    const x = textLeft + W * (0.35 + k * 0.02)
    let left = 0, right = 0, cross = 0
    for (const r of colish) {
      if (r.box.right <= x) left++
      else if (r.box.left >= x) right++
      else cross++
    }
    const balance = Math.min(left, right)
    if (balance >= 3 && cross <= crossLimit) candidates.push({ mid: x, cross, balance })
  }
  candidates.sort((a, b) => a.cross - b.cross || b.balance - a.balance)
  for (const c of candidates) {
    const leftRuns = colish.filter((r) => r.box.right <= c.mid)
    const rightRuns = colish.filter((r) => r.box.left >= c.mid)
    if (sideLooksLikeColumn(leftRuns) && sideLooksLikeColumn(rightRuns)) return c.mid
  }
  return null
}

/** 列表标号开头（“(iii) ”“3.1 ”“1) ”“• ”）：这类首行会被标号顶到左边距之外，缩进量与后续行不同 */
const LIST_MARKER_RE = /^\s*(?:\((?:\d{1,2}|[A-Za-z]|[ivxlcdmIVXLCDM]{1,5})\)|\d{1,2}(?:\.\d{1,2})*[.)]|[•·▪‣]|[-–—*])\s+/

/**
 * 行片段 → 段落。**不按栏硬切**：所有片段按 y 统一扫描，靠「左边界对齐 + 横向重叠」自然完成
 * 分栏隔离（左右栏片段横向重叠为负，永远配不上）。每个片段带 `colRight`（本栏右界），
 * 段落以首行的 colRight 作为「是否排满」的参照 —— 跨栏标题的首行右界是整页，才不会把短标题
 * 当排满、也不至于把它与缩进的正文并成一块。
 * - 命中段首缩进 / 悬挂标号后，段落会记下 `bodyLeft`（正文续行左边界），后续行以它为对齐基准。
 */
function groupParagraphs(runs: LineRun[]): Segment[] {
  interface Open {
    texts: string[]; box: LineBox; angle: number; last: LineBox; chars: number; limit?: number
    colRight: number; firstLeft: number; bodyLeft?: number
  }
  const out: Segment[] = []
  const open: Open[] = []
  const flush = (p: Open) => out.push({
    text: p.texts.join(' '), box: p.box, angle: p.angle, lines: p.texts.length,
    limit: p.limit, colRight: p.colRight, firstLeft: p.firstLeft, bodyLeft: p.bodyLeft,
  })

  for (const run of runs) {
    const box = run.box
    const w = box.right - box.left
    if (!(w > 0)) continue

    // 1) 关掉不再紧接的段落（按 y 扫描，关闭后不可能再被延续）
    for (let i = open.length - 1; i >= 0; i--) {
      const p = open[i]
      if (box.top - p.box.bottom > Math.max(2.5, p.box.fontSize * 0.75)) { flush(p); open.splice(i, 1) }
    }

    // 2) 找最合适的开放段落：垂直最贴近优先，其次横向重叠最大
    let best: Open | null = null
    let bestGap = Infinity
    let bestOverlap = -Infinity
    for (const p of open) {
      const gap = box.top - p.box.bottom
      const tol = Math.max(2.5, p.box.fontSize * 0.75)
      if (gap > tol) continue
      if (Math.abs(run.angle - p.angle) > 1) continue
      if (Math.abs(box.fontSize - p.box.fontSize) > p.box.fontSize * 0.35) continue
      if (p.texts.length >= MAX_PARA_LINES || p.chars + run.text.length > MAX_PARA_CHARS) continue
      const lastW = p.last.right - p.last.left
      const refLeft = p.bodyLeft != null ? p.bodyLeft : p.box.left
      const shift = box.left - refLeft
      const loose = p.box.fontSize * 5
      // 横向重叠不足（另一栏 / 另一列）→ 不可能是同一段
      const overlap = Math.min(box.right, p.last.right) - Math.max(box.left, p.last.left)
      if (overlap < Math.min(w, lastW) * 0.35) continue
      // 新列表项 / 新编号标题：本行以标号开头且落在正文左边距上 → 另起一段（否则两类列表项会粘成一块）
      if (LIST_MARKER_RE.test(run.text) && Math.abs(shift) <= p.box.fontSize * 0.9) continue
      // 「段首缩进的首行」还要够宽：首行缩进只是把一行往右挪一点，整行仍应占满大部分栏宽；
      // 上方若有很窄的公式碎片（如孤立的 ∫ / ∑），不能当成段落首行被吞进来
      const colW = Math.max(1, p.colRight - p.box.left)
      const firstLineWide = lastW >= colW * 0.4
      const leftOk = Math.abs(shift) <= p.box.fontSize * 0.9
        // 段首缩进回退：本段只有一行、它是缩进的，下一行退回左边距
        || (p.bodyLeft == null && p.texts.length === 1 && shift < 0 && -shift <= loose && firstLineWide)
        // 列表悬挂标号：首行以“(iii) / 3.1 / • ”开头被顶出去，续行右移对齐
        || (p.bodyLeft == null && p.texts.length === 1 && shift > 0 && shift <= loose
          && LIST_MARKER_RE.test(p.texts[0]))
      if (!leftOk) continue
      // 上一行有没有排满：
      // - 多行段落看自身右边界，没排满说明本段已结束（段末短行）；
      // - **单行段落**要比栏右边界，否则短标题会被当成「排满」而吞掉后面的段落。
      const fillTol = Math.max(p.box.fontSize * 1.5, 6)
      const filled = p.texts.length === 1
        ? p.colRight - p.last.right <= fillTol
        : p.box.right - p.last.right <= fillTol
      if (!filled) {
        if (p.texts.length !== 1) continue
        // 单行且没排满：像标题。若下一行以大写字母 / 汉字开头（另起新句），判定为新段落，不并；
        // 若下一行是「标题的续行」（小写开头，如跨行标题），则继续并入。
        if (/^[A-Z\u3400-\u9fff]/.test(run.text)) continue
      }
      if (gap < bestGap || (gap === bestGap && overlap > bestOverlap)) {
        best = p
        bestGap = gap
        bestOverlap = overlap
      }
    }

    if (best) {
      // 第二行（正文续行）的左边界：用于还原首行缩进 / 悬挂缩进，并作为后续行的对齐基准
      if (best.texts.length === 1) {
        best.bodyLeft = box.left
      }
      best.texts.push(run.text)
      best.chars += run.text.length
      best.box = {
        left: Math.min(best.box.left, box.left),
        right: Math.max(best.box.right, box.right),
        top: Math.min(best.box.top, box.top),
        bottom: Math.max(best.box.bottom, box.bottom),
        fontSize: Math.max(best.box.fontSize, box.fontSize),
      }
      best.last = box
      if (run.nextLeft != null) best.limit = best.limit == null ? run.nextLeft : Math.min(best.limit, run.nextLeft)
      continue
    }

    open.push({
      texts: [run.text], box, angle: run.angle, last: box, chars: run.text.length,
      limit: run.nextLeft, colRight: run.colRight, firstLeft: box.left,
    })
  }
  for (const p of open) flush(p)
  return out.sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left)
}

/**
 * 公式字符（Unicode 数学字母、数学运算符、希腊字母、箭头、上下标）——用于识别公式块。
 * 注意 U+1D400–U+1D7FF（数学字母数字符号，如 𝑄 / 𝑅 / 𝑡）在 UTF-16 里是代理对，
 * 要用 \uD835\uDC00-\uD835\uDFFF 才能匹配到。
 * ASCII 的 = + − ( ) 太常见，不计入，避免把普通句子误判成公式。
 */
const MATH_RANGES = '\\u0370-\\u03ff\\u1d00-\\u1d7f\\u1d80-\\u1dbf\\u2000-\\u206f\\u2070-\\u209f\\u20d0-\\u20ff\\u2100-\\u214f\\u2190-\\u21ff\\u2200-\\u22ff\\u2300-\\u23ff\\u25a0-\\u25ff\\u27c0-\\u27ef\\u2900-\\u297f\\u2980-\\u29ff\\u2a00-\\u2aff'
/** U+1D400–U+1D7FF 是代理对，必须写成「高位代理 + 低位代理区间」的独立分支 */
const MATH_SURROGATE = '\\uD835[\\uDC00-\\uDFFF]'
const MATH_CHAR_RE = new RegExp(`[${MATH_RANGES}]|${MATH_SURROGATE}`)
const MATH_CHAR_GLOBAL_RE = new RegExp(`[${MATH_RANGES}]|${MATH_SURROGATE}`, 'g')

/** 自然语言「词」数：≥3 个 ASCII 字母的串，或单字 CJK（"1-s2.0-S0951" 这类不算） */
function wordCountOf(text: string): number {
  const latin = text.match(/[A-Za-z]{3,}/g)
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g)
  return (latin ? latin.length : 0) + (cjk ? cjk.length : 0)
}

/**
 * 是否「以公式 / 数字为主」，不需要翻译：
 * - 数学符号占比 ≥ 25%；或
 * - 有数学符号且几乎没有自然语言（≤2 个词）；或
 * - 完全没有自然语言（纯数字 / 符号碎片，如 "(3)"、"0.5 0.62"）。
 */
export function isMathBlock(text: string): boolean {
  const s = String(text || '')
  const compact = s.replace(/\s+/g, '')
  if (!compact) return true
  const words = wordCountOf(s)
  if (words === 0) return true
  const mathChars = (compact.match(MATH_CHAR_GLOBAL_RE) || []).length
  if (mathChars === 0) return false
  if (mathChars / compact.length >= 0.25) return true
  return mathChars >= 2 && words <= 2
}

/** 页眉页脚：整块位于页面上/下 6% 且单行、且是短文本 → 视为页眉页脚丢弃（保守，避免误伤正文标题） */
function isNoiseBlock(seg: Segment, pageHeight: number): boolean {
  if (PAGE_NUM_RE.test(seg.text)) return true
  if (seg.lines === 1 && seg.text.length <= 80) {
    if (seg.box.bottom < pageHeight * 0.06) return true
    if (seg.box.top > pageHeight * 0.94) return true
  }
  return false
}

/**
 * 分位数（`sorted` 需已升序）—— 文字区边界用分位数而非极值，
 * 避免个别游离元素（旋转标签、页码、脚注）把文字区撑大。
 */
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))
  return sorted[idx]
}

/**
 * 取某页的文本块（段落级，带坐标）。扫描件（无内嵌文字）返回空数组。
 *
 * 多栏页面：每个片段带上「本栏右界」（左栏 → 栏间中线，右栏/通栏 → 文字区右边界），
 * 聚段时**统一扫描全部片段**，靠左边界对齐 + 横向重叠把左右栏自然分开；
 * 这样跨栏标题（首行通栏、次行只占左半）也能正确合成一块，而不会被"带"切散。
 *
 * @param page pdf.js 的 PDFPageProxy
 * @param pageNum 页码（1 起）
 */
export async function buildPageBlocks(page: any, pageNum: number): Promise<PdfTextBlock[]> {
  const vp1 = page.getViewport({ scale: 1 })
  const { pageWidth, pageHeight, pageX, pageY } = vp1.rawDims
  const flip = [1, 0, 0, -1, -pageX, pageY + pageHeight]
  const content = await page.getTextContent()
  const raws: RawItem[] = []
  for (const item of (content?.items || []) as any[]) {
    const r = itemToRaw(item, flip)
    if (r) raws.push(r)
  }
  if (!raws.length) return []

  const runs = rowRuns(raws)
  if (!runs.length) return []
  const lefts = runs.map((r) => r.box.left).sort((a, b) => a - b)
  const rights = runs.map((r) => r.box.right).sort((a, b) => a - b)
  const textLeft = percentile(lefts, 0.1)
  const textRight = percentile(rights, 0.9)
  const mid = detectColumnMid(runs, textLeft, textRight)
  const areaRight = Math.min(pageWidth - 4, textRight)
  // 每栏的右边界：左栏到栏间中线为止；右栏 / 通栏到文字区右边界
  for (const r of runs) {
    r.colRight = mid == null ? areaRight : (r.box.right <= mid ? mid - 2 : areaRight)
  }

  const blocks: PdfTextBlock[] = []
  for (const seg of groupParagraphs([...runs].sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left))) {
    if (seg.text.length < 2) continue
    if (isNoiseBlock(seg, pageHeight)) continue
    const limit = seg.limit != null ? seg.limit - 3 : Infinity
    // 缩进还原：首行 vs 正文续行的左边界差（scale=1 px）
    const indentFirst = Math.max(0, seg.firstLeft - seg.box.left)
    const indentHanging = seg.bodyLeft != null ? Math.max(0, seg.bodyLeft - seg.box.left) : 0
    blocks.push({
      id: `p${pageNum}-${blocks.length}`,
      page: pageNum,
      text: seg.text,
      left: seg.box.left,
      top: seg.box.top,
      width: Math.max(1, seg.box.right - seg.box.left),
      height: Math.max(1, seg.box.bottom - seg.box.top),
      fontSize: seg.box.fontSize,
      angle: seg.angle,
      lines: seg.lines,
      // 右界 = min(本栏右界, 同行右侧紧邻元素的左边界)，但不小于本块自身的右边界
      maxRight: Math.min(areaRight, Math.max(seg.box.right, Math.min(seg.colRight, limit))),
      indentFirst,
      indentHanging,
      math: isMathBlock(seg.text) || undefined,
    })
  }
  return blocks
}

/** 文本归一（用于选区 ↔ 文本块匹配）：压缩空白 + 去软连字符 */
function normText(s: string): string {
  return String(s || '').replace(/\u00ad/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * 选区命中的文本块：先按整块包含匹配，失败则按「整页拼接文本」定位（支持跨块选中的碎片）。
 */
export function blocksForSelection(blocks: PdfTextBlock[], selection: string): PdfTextBlock[] {
  const sel = normText(selection)
  if (!sel) return []
  const exact = blocks.filter((b) => {
    const t = normText(b.text)
    return t.length >= 2 && sel.includes(t)
  })
  if (exact.length) return exact

  let pos = 0
  let glue = ''
  const spans = blocks.map((b) => {
    const t = normText(b.text)
    const span = { block: b, start: pos, end: pos + t.length }
    glue += (glue ? ' ' : '') + t
    pos += t.length + 1
    return span
  })
  const at = glue.indexOf(sel)
  if (at >= 0) {
    const end = at + sel.length
    return spans.filter((s) => s.end > at && s.start < end).map((s) => s.block)
  }

  // 兜底：选区被换行 / 分栏拆开时，用首段片段做前缀匹配
  const head = sel.slice(0, 12)
  return blocks.filter((b) => {
    const t = normText(b.text)
    if (t.length < 2) return false
    return t.includes(head) || sel.includes(t.slice(0, 12))
  })
}

/**
 * 译文叠加层的定位样式：与 pdf.js 文本层同一坐标系（乘 --scale-factor），缩放自动跟随。
 * 宽度允许超出原块（译文普遍比原文长），但不越过 `maxRight`（双栏页里就是本栏右边界）。
 * 原文的首行缩进 / 悬挂缩进会原样还原（text-indent / padding + 负 text-indent）。
 * 键是 **CSS 属性名（连字符形式）**，可直接 `el.style.setProperty(k, v)`
 * ——注意不要用 camelCase，`setProperty('fontSize', …)` 会被静默忽略。
 */
export function blockOverlayStyle(b: PdfTextBlock): Record<string, string> {
  const maxW = Math.max(b.width, b.maxRight - b.left)
  const width = Math.min(maxW, Math.max(b.width, b.fontSize * 16))
  const px = (v: number) => `calc(var(--scale-factor) * ${v.toFixed(2)}px)`
  const style: Record<string, string> = {
    left: px(b.left - 1),
    top: px(b.top - 1.2),
    width: px(width + 2),
    'min-height': px(b.height + 2.4),
    'font-size': px(b.fontSize),
    'line-height': '1.28',
  }
  const th = b.fontSize * 0.5 // 缩进阈值：小于半个字宽视为排版噪声
  if (b.indentHanging > th) {
    // 列表悬挂缩进：正文缩进、首行（标号）突出到左边距
    style['padding-left'] = px(b.indentHanging)
    style['text-indent'] = `calc(var(--scale-factor) * ${(-b.indentHanging).toFixed(2)}px)`
  } else if (b.indentFirst > th) {
    // 段首缩进
    style['text-indent'] = px(b.indentFirst)
  }
  return style
}

// ---------------------------------------------------------------------------
// 来源 / 模型偏好（独立于 OCR，不写回主模型来源设置）
// ---------------------------------------------------------------------------

export const TRANSLATE_SOURCE_PREF_KEY = 'pdf-translate-source'
const TRANSLATE_MODEL_PREF_PREFIX = 'pdf-translate-model:'

/** ''=跟随系统默认来源；否则为指定来源键 */
export function loadTranslateSourcePref(): string {
  try { return normalizeLlmType(localStorage.getItem(TRANSLATE_SOURCE_PREF_KEY) || '') } catch { return '' }
}

export function saveTranslateSourcePref(provider: string): void {
  try {
    if (provider) localStorage.setItem(TRANSLATE_SOURCE_PREF_KEY, normalizeLlmType(provider))
    else localStorage.removeItem(TRANSLATE_SOURCE_PREF_KEY)
  } catch { /* 忽略 */ }
}

export function loadTranslateModelPref(provider: string): string {
  if (!provider) return ''
  try { return localStorage.getItem(TRANSLATE_MODEL_PREF_PREFIX + provider) || '' } catch { return '' }
}

export function saveTranslateModelPref(provider: string, model: string): void {
  if (!provider || !model) return
  try { localStorage.setItem(TRANSLATE_MODEL_PREF_PREFIX + provider, model) } catch { /* 忽略 */ }
}

/** 实际生效的来源：显式偏好优先，否则跟随「当前模型来源」 */
export function activeTranslateProvider(llm: any, pref: string): string {
  return normalizeLlmType(pref) || normalizeLlmType(llm?.type) || 'ollama'
}

/** 某来源当前配置里的模型名 */
export function sourceModel(llm: any, provider: string): string {
  return String(llmConfigByKey(llm, provider)?.model || '')
}

// ---------------------------------------------------------------------------
// 结果缓存（段 hash + 目标语言 + 模型 → 译文）
// ---------------------------------------------------------------------------

const CACHE_KEY = 'pdf-translate-cache'
/** 缓存条目上限（超出按写入顺序淘汰最旧的） */
const CACHE_MAX = 500

let cacheMap: Record<string, string> | null = null

function loadCache(): Record<string, string> {
  if (cacheMap) return cacheMap
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    cacheMap = parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {}
  } catch { cacheMap = {} }
  return cacheMap
}

function flushCache(): void {
  if (!cacheMap) return
  try {
    const keys = Object.keys(cacheMap)
    if (keys.length > CACHE_MAX) {
      for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete cacheMap[k]
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(cacheMap))
  } catch { /* 忽略（配额满等） */ }
}

/** djb2：只用于缓存键，不需要抗碰撞强度 */
function hashText(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

export function makeCacheId(fileKey: string, target: string, model: string, text: string): string {
  return `${fileKey}|${target}|${model}|${hashText(text)}`
}

export function getCached(id: string): string | undefined {
  const v = loadCache()[id]
  return typeof v === 'string' && v ? v : undefined
}

export function putCached(id: string, text: string): void {
  if (!text) return
  const cache = loadCache()
  delete cache[id]
  cache[id] = text
  flushCache()
}

/** 清空本地译文缓存（localStorage + 内存，立即生效） */
export function clearTranslateCache(): void {
  cacheMap = {}
  try { localStorage.removeItem(CACHE_KEY) } catch { /* 忽略 */ }
}

/** 当前缓存条数（设置弹层显示用） */
export function translateCacheSize(): number {
  return Object.keys(loadCache()).length
}

// ---------------------------------------------------------------------------
// 调用
// ---------------------------------------------------------------------------

export interface TranslateBlockInput {
  id: string
  text: string
}

export interface TranslateOptions {
  /** 模型来源（ollama / lmstudio / openai / deepseek / gpustack / anthropic / google / azure / custom） */
  provider: string
  /** 该来源的连接配置 */
  config: any
  /** 模型名 */
  model: string
  /** 目标语言 */
  target: TranslateTarget
  /** 文案语言（zh=中文提示词 / 错误文案） */
  zh?: boolean
  signal?: AbortSignal
  /** 返回 true 表示已取消 */
  cancelled?: () => boolean
  /** 每完成一批回调（done/total 为块数） */
  onProgress?: (done: number, total: number) => void
  /** 每块译文就绪回调（可用于即时叠加） */
  onBlock?: (id: string, text: string) => void
}

export interface TranslateResult {
  /** blockId → 译文（含失败重试后仍缺的段不会出现在这里） */
  results: Record<string, string>
  /** 未能翻译的 blockId（多为模型漏号） */
  failed: string[]
  /** 被取消 */
  cancelled: boolean
}

/** 单次请求的块数 / 字符上限（块太少浪费轮次，太多模型容易漏段） */
const MAX_BATCH_ITEMS = 8
const MAX_BATCH_CHARS = 4000
/** 并发批次数：本地模型也能扛住 2~3 路 */
const CONCURRENCY = 3

const CTRL_CHARS = ''

function systemPrompt(target: TranslateTarget, zh: boolean): string {
  const lang = targetLangName(target, zh)
  if (zh) {
    return [
      `你是专业的文档翻译引擎，把用户提供的编号段落翻译为${lang}。`,
      '严格要求：',
      '1. 逐段输出，每段必须以 [[编号]] 开头，编号与原文完全一致；不得合并、拆分、增删或重排段落；',
      '2. 只输出译文本身，不要任何解释、前后缀、原文复述或 Markdown 代码块；',
      '3. 保留数字、单位、人名、机构名、专有名词、代码、URL 与引用标记原样；',
      '4. 数学公式与变量名必须原样保留（不得翻译或改写），并用 LaTeX 表示：行内公式写成 $...$，'
        + '独立公式写成 $$...$$；原文已是 Unicode 数学符号（如 𝑓、𝜋、∑）时也请转成等价的 LaTeX；',
      `5. 若某段已是${lang}或无实义内容，仍按原编号原样输出该段。`,
    ].join('\n')
  }
  return [
    `You are a professional document translation engine. Translate the numbered passages into ${lang}.`,
    'Strict requirements:',
    '1. Output passage by passage, each starting with its [[number]] exactly as given; never merge, split, drop or reorder passages;',
    '2. Output only the translation — no explanations, no prefixes/suffixes, no restating the source, no Markdown code fences;',
    '3. Keep numbers, units, names, organizations, terminology, code, URLs and citation markers unchanged;',
    '4. Keep every formula and variable name verbatim (never translate or rewrite them) and express math as LaTeX: '
      + 'inline math as $...$, display math as $$...$$; convert Unicode math symbols (e.g. 𝑓, 𝜋, ∑) into equivalent LaTeX;',
    `5. If a passage is already in ${lang} or has no meaningful content, still output it unchanged under its number.`,
  ].join('\n')
}

function userPrompt(batch: TranslateBlockInput[]): string {
  return batch.map((b, i) => `[[${i + 1}]] ${b.text}`).join('\n')
}

/** 解析 `[[n]] 译文` 协议；容忍模型少写空格 / 多余空行 */
function parseNumbered(text: string): Record<number, string> {
  const out: Record<number, string> = {}
  const re = /\[\[(\d+)\]\]\s*([\s\S]*?)(?=\n*\[\[\d+\]\]|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const idx = Number(m[1])
    const body = m[2].replace(/\s+$/, '').trim()
    if (idx >= 1) out[idx] = body
  }
  return out
}

function buildLlmConfig(provider: string): any {
  // 翻译要稳：低温度 + 放宽生成上限（长段落/整篇摘要也能一次翻完，不被截断）；不给工具、不开流式。
  // 注意：不要下发 stop —— `[[` 正是分段协议的标记，会被截断。
  const llmConfig: any = {
    stream: false,
    temperature: 0.2,
    top_p: 0.9,
    max_tokens: 8192,
  }
  if (normalizeLlmType(provider) === 'ollama') {
    llmConfig.options = { temperature: 0.2, top_p: 0.9, num_predict: 8192 }
    llmConfig.keep_alive = '5m'
  }
  return llmConfig
}

/** `$$…$$` / `\[…\]` 展示公式，`$…$` / `\(…\)` 行内公式；其余为纯文本 */
export type TexSegment = { type: 'text' | 'inline' | 'display'; value: string }

/** 纯数字 / 金额（$5、$1,000、$10.5%）：不当公式，避免货币符号被当成 TeX */
const PLAIN_NUMBER_BODY_RE = /^[\d\s,.·%/+-]*$/
/** 公式特征：TeX 标记、括号、运算符，或数学符号（希腊字母 / 数学运算符 / 上下标） */
const MATH_SIGNAL_RE = /[\\^_{}[\]()|=<>+*/]|[\u0370-\u03ff\u2200-\u22ff\u2a00-\u2aff\u1d00-\u1d7f\u2070-\u209f]/
/** 单个变量名（$S$、$D$、$Q0$）也算公式 */
const SINGLE_VAR_RE = /^[A-Za-z][A-Za-z0-9]{0,3}$/

/**
 * `$…$` 是否值得按公式渲染。行内 `$` 既可能是公式也可能是货币符号，
 * 这里只放行「像公式」的：含 TeX 标记 / 数学符号 / 括号运算符，或本身就是单个变量名。
 */
function inlineLooksLikeMath(body: string): boolean {
  const b = body.trim()
  if (!b) return false
  if (PLAIN_NUMBER_BODY_RE.test(b)) return false
  if (MATH_SIGNAL_RE.test(b)) return true
  return SINGLE_VAR_RE.test(b)
}

/** 把译文按 LaTeX 定界符切段，供叠加层渲染 */
export function splitTexSegments(text: string): TexSegment[] {
  const src = String(text || '')
  const out: TexSegment[] = []
  const re = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^$\n]{1,300}?)\$/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const display = m[1] != null ? m[1] : (m[2] != null ? m[2] : null)
    const inline = m[3] != null ? m[3] : (m[4] != null ? m[4] : null)
    const body = (display != null ? display : inline) || ''
    const isDisplay = display != null
    // 展示公式一律按公式处理；行内 `$…$` / `\(…\)` 需要「像公式」才认（否则当成正文里的 $）
    if (!isDisplay && !inlineLooksLikeMath(body)) continue
    if (m.index > last) {
      const t = src.slice(last, m.index)
      if (t) out.push({ type: 'text', value: t })
    }
    out.push({ type: isDisplay ? 'display' : 'inline', value: body.trim() })
    last = m.index + m[0].length
  }
  if (last < src.length) {
    const t = src.slice(last)
    if (t) out.push({ type: 'text', value: t })
  }
  return out.length ? out : [{ type: 'text', value: src }]
}

/** 简短失败原因（状态栏 / 提示用） */
export function translateErrorText(err: unknown, zh: boolean): string {
  const raw = err instanceof Error ? err.message : String(err || '')
  const msg = raw.replace(/\s+/g, ' ').slice(0, 160)
  if (!msg) return zh ? '翻译失败' : 'Translation failed'
  return msg
}

function splitBatches(blocks: TranslateBlockInput[]): TranslateBlockInput[][] {
  const out: TranslateBlockInput[][] = []
  let cur: TranslateBlockInput[] = []
  let chars = 0
  for (const b of blocks) {
    if (cur.length && (cur.length >= MAX_BATCH_ITEMS || chars + b.text.length > MAX_BATCH_CHARS)) {
      out.push(cur)
      cur = []
      chars = 0
    }
    cur.push(b)
    chars += b.text.length
  }
  if (cur.length) out.push(cur)
  return out
}

/**
 * 逐段翻译（分批 + 并发 + 单批重试 + 可取消）。
 * 返回每块译文；模型漏号的段进 `failed`（调用方可让用户重试）。
 */
export async function translateBlocks(blocks: TranslateBlockInput[], opts: TranslateOptions): Promise<TranslateResult> {
  const zh = opts.zh !== false
  const results: Record<string, string> = {}
  const failed: string[] = []
  const total = blocks.length
  if (!total) return { results, failed, cancelled: false }

  const batches = splitBatches(blocks)
  let done = 0
  let cancelled = false

  const isCancelled = () => cancelled || !!opts.cancelled?.() || !!opts.signal?.aborted

  const runBatch = async (batch: TranslateBlockInput[]): Promise<void> => {
    if (isCancelled()) return
    const cfg = { ...(opts.config || {}), model: opts.model }
    const messages = [
      { role: 'system', content: systemPrompt(opts.target, zh) },
      { role: 'user', content: userPrompt(batch) },
    ]
    const llmConfig = buildLlmConfig(opts.provider)
    let raw = ''
    let lastErr: unknown = null
    for (let attempt = 0; attempt < 2; attempt++) {
      if (isCancelled()) return
      try {
        raw = String(await AIUtils.sendChat(opts.provider, cfg, llmConfig, messages as any, { signal: opts.signal }) || '')
        if (raw.trim()) { lastErr = null; break }
        lastErr = new Error(zh ? '模型返回空内容' : 'model returned empty content')
      } catch (err) {
        if (isCancelled()) return
        lastErr = err
      }
    }
    if (lastErr) {
      for (const b of batch) failed.push(b.id)
      done += batch.length
      opts.onProgress?.(done, total)
      console.warn('[Translate] 批次失败:', translateErrorText(lastErr, zh))
      return
    }

    const parsed = parseNumbered(raw)
    for (let i = 0; i < batch.length; i++) {
      const b = batch[i]
      const text = parsed[i + 1]
      if (text) {
        results[b.id] = text
        opts.onBlock?.(b.id, text)
      } else {
        failed.push(b.id)
      }
    }
    done += batch.length
    opts.onProgress?.(done, total)
  }

  // 简易并发池：固定 CONCURRENCY 个 worker 抢批
  let cursor = 0
  const workers: Promise<void>[] = []
  for (let w = 0; w < Math.min(CONCURRENCY, batches.length); w++) {
    workers.push((async () => {
      while (true) {
        if (isCancelled()) { cancelled = true; return }
        const idx = cursor++
        if (idx >= batches.length) return
        await runBatch(batches[idx])
      }
    })())
  }
  await Promise.all(workers)

  if (opts.signal?.aborted || opts.cancelled?.()) cancelled = true
  return { results, failed, cancelled }
}
