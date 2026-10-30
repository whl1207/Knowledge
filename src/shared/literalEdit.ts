/**
 * literalEdit.ts — 字面量替换的**纯逻辑**（主进程工具 / 渲染层工具共用一份）
 *
 * 为什么单独一层：`replace_in_file` / `multi_replace` 在主进程（`electron/main/tools.ts`）
 * 与渲染层（`src/lib/agent/rendererTools.ts`，安卓 / 网页端）各有一份实现。历史上两边的
 * 语义已经漂了：一个要求 `replacements`、另一个要求 `edits`；一边支持 `occurrence`、
 * 另一边不支持；一边按原文定位、另一边按顺序累积。模型换端就必然失败一次。
 *
 * 本文件只做**匹配与拼装**，不做 I/O、不碰 node / DOM，两个半边共同 import：
 * - 换行风格归一（模型发 `\n`，文件可能是 CRLF）；
 * - 唯一性判定（默认恰好 1 处；`replaceAll` 显式全替换；`occurrence` 指定第几处）；
 * - 空操作（old === new）与空 old 的拒绝——对齐 DSH `edit` 的
 *   `old_string and new_string must differ`；
 * - 同一文件多笔编辑的**区间重叠**防护与偏移无关的落点拼装（按 index 降序应用）。
 *
 * 语义与 DSH 的 `ctx.fs.editText` 同口径（见 `docs/plan/插件能力面向DSH风格收敛-设计方案`）：
 * 默认 fail-closed，绝不"猜一处"；要全替换必须显式 `replace_all: true`。
 */

export type FileEol = '\r\n' | '\n'

/** 主换行风格：只要出现 CRLF 就按 CRLF 处理，否则按 LF */
export function detectEol(text: string): FileEol {
  return String(text ?? '').includes('\r\n') ? '\r\n' : '\n'
}

/** 把任意行尾统一为目标 EOL（先归一为 LF 再转目标，避免 CRLF 被二次处理） */
export function toFileEol(value: string, eol: FileEol): string {
  const lf = String(value ?? '').replace(/\r\n/g, '\n')
  return eol === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf
}

/** needle 在 hay 中的所有命中偏移（升序、互不重叠） */
export function collectOccurrences(hay: string, needle: string): number[] {
  const hits: number[] = []
  if (!needle) return hits
  let from = 0
  for (;;) {
    const i = hay.indexOf(needle, from)
    if (i === -1) break
    hits.push(i)
    from = i + needle.length
  }
  return hits
}

/** [0, index) 内的换行数 + 1 = 该偏移所在的 1-based 行号 */
export function lineNumberAt(text: string, index: number): number {
  return text.slice(0, Math.max(0, index)).split('\n').length
}

/** 一次命中的位置信息（不携带新内容） */
export interface LiteralMatch {
  /** 在原文中的起始偏移 */
  index: number
  /** 命中段的长度（按**归一后**的 old 计算，含 CRLF 时比模型给的 old 长） */
  length: number
  /** 1-based 起止行 */
  startLine: number
  endLine: number
  /** 命中的原文段（用于落盘前校验，防止拼装期间内容变化） */
  oldText: string
}

export type LiteralLocateCode = 'EMPTY_OLD' | 'NOOP' | 'NOT_FOUND' | 'AMBIGUOUS' | 'OUT_OF_RANGE'

export type LiteralLocateResult =
  | {
      ok: true
      /** 命中列表（`replaceAll` 时多笔；否则恰好 1 笔） */
      matches: LiteralMatch[]
      /** 该 old 在文中一共命中几处（`replaceAll` 时 = matches.length） */
      hitCount: number
      /** 实际用于匹配的原文（可能是归一换行后的版本） */
      usedOld: string
      /** 已归一为文件 EOL 的新文段 */
      newText: string
    }
  | {
      ok: false
      code: LiteralLocateCode
      /** 命中的偏移（NOT_FOUND 时为空） */
      hits: number[]
      /** 命中的行号（与 hits 对齐） */
      lines: number[]
    }

/**
 * 在 `text` 中定位一次字面量替换。
 *
 * 规则：
 * - `oldRaw` 为空 → `EMPTY_OLD`（删除内容请给足上下文的 old，new 传空串）；
 * - `oldRaw === newRaw` → `NOOP`（不写盘，避免空 diff 白耗一次工具轮次）；
 * - 先按原样匹配，未命中再按文件 EOL 归一后匹配（兼容 CRLF/LF）；
 * - `replaceAll: true` → 全部命中都返回（必须至少 1 处）；
 * - `occurrence`（1 起）→ 只取第几处，越界报 `OUT_OF_RANGE`；
 * - 不传 `replaceAll` / `occurrence` 且命中多处于 → `AMBIGUOUS`（fail-closed）。
 */
export function locateLiteralMatches(
  text: string,
  oldRaw: string,
  newRaw: string,
  opts: { occurrence?: number; replaceAll?: boolean } = {},
): LiteralLocateResult {
  const content = String(text ?? '')
  const oldValue = String(oldRaw ?? '')
  const newValue = String(newRaw ?? '')
  if (!oldValue) return { ok: false, code: 'EMPTY_OLD', hits: [], lines: [] }
  if (oldValue === newValue) return { ok: false, code: 'NOOP', hits: [], lines: [] }

  const eol = detectEol(content)
  const normalized = toFileEol(oldValue, eol)
  const candidates = normalized === oldValue ? [oldValue] : [oldValue, normalized]

  let usedOld = oldValue
  let hits: number[] = []
  for (const candidate of candidates) {
    const found = collectOccurrences(content, candidate)
    if (found.length > 0) {
      usedOld = candidate
      hits = found
      break
    }
  }
  if (!hits.length) return { ok: false, code: 'NOT_FOUND', hits: [], lines: [] }

  const lines = hits.map((i) => lineNumberAt(content, i))
  const replaceAll = opts.replaceAll === true
  let picked: number[]
  if (replaceAll) {
    picked = hits
  } else if (opts.occurrence !== undefined) {
    const occurrence = Number(opts.occurrence)
    if (!Number.isInteger(occurrence) || occurrence < 1) {
      return { ok: false, code: 'OUT_OF_RANGE', hits, lines }
    }
    if (occurrence > hits.length) return { ok: false, code: 'OUT_OF_RANGE', hits, lines }
    picked = [hits[occurrence - 1]]
  } else {
    if (hits.length > 1) return { ok: false, code: 'AMBIGUOUS', hits, lines }
    picked = hits
  }

  const newText = toFileEol(newValue, eol)
  const matches: LiteralMatch[] = picked.map((index) => {
    const oldText = content.slice(index, index + usedOld.length)
    const startLine = lineNumberAt(content, index)
    const endLine = startLine + oldText.split('\n').length - 1
    return { index, length: usedOld.length, startLine, endLine, oldText }
  })
  return { ok: true, matches, hitCount: hits.length, usedOld, newText }
}

/** 一笔待落盘的替换（位置 + 新内容） */
export interface LiteralEdit extends LiteralMatch {
  newText: string
}

export type ApplyPlanResult =
  | { ok: true; text: string }
  | { ok: false; index: number; reason: 'overlap' | 'mismatch' }

/**
 * 把一组替换应用到原文上（纯内存，无 IO）。
 *
 * - 与传入顺序无关：按 offset 排序后**降序**应用，避免前面的替换影响后面的偏移；
 * - 区间重叠 → `{ reason: 'overlap' }`（返回冲突的后一笔下标）；
 * - 落盘前逐笔校验命中段仍是原文 → `{ reason: 'mismatch' }`。
 */
export function applyLiteralEdits(text: string, edits: LiteralEdit[]): ApplyPlanResult {
  const content = String(text ?? '')
  if (!edits.length) return { ok: true, text: content }
  const sorted = [...edits].sort((a, b) => a.index - b.index)
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1].index + sorted[i - 1].length
    if (sorted[i].index < prevEnd) return { ok: false, index: i, reason: 'overlap' }
  }
  let current = content
  for (let i = sorted.length - 1; i >= 0; i--) {
    const edit = sorted[i]
    const segment = current.slice(edit.index, edit.index + edit.length)
    if (segment !== edit.oldText) return { ok: false, index: i, reason: 'mismatch' }
    current = current.slice(0, edit.index) + edit.newText + current.slice(edit.index + edit.length)
  }
  return { ok: true, text: current }
}
