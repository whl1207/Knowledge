/**
 * editDiff.ts — 编辑类工具的差异预览（主进程 / 渲染进程共享）
 *
 * 目标：AI 改完文件后，「能看清到底改了什么」（对齐 pi 的 edit 工具 diff 展示）。
 *
 * 关键设计（重要）：
 * - 差异**不进模型上下文**。工具结果的 `value` 仍只放小体量摘要（path / stats），
 *   差异行挂在 `ToolResult.preview` 上，由 `tool/result` 事件单独携带给渲染层；
 *   模型可见的 `deriveMessages()` 只序列化 `value`，因此不会被差异刷爆上下文。
 * - 只回传「变更块 ± 少量上下文」并做行数/体积上限裁剪，避免整文件塞进消息与 localStorage。
 * - 依赖纯函数 diff 引擎 `@/lib/diff`（Myers 行级），无 DOM / Node API，双端可用。
 */

import { diffLines, countStats } from '@/lib/diff'

/** 文本行数（与 diff 引擎的行切分保持一致：空文本 0 行） */
export function countTextLines(text: string): number {
  if (!text) return 0
  return text.split(/\r\n|\r|\n/).length
}

/** 单行类型：上下文 / 新增 / 删除 / 省略标记 */
export type EditDiffLineType = 'ctx' | 'add' | 'del' | 'gap'

export interface EditDiffLine {
  t: EditDiffLineType
  /** 旧文件行号（add 行无） */
  o?: number
  /** 新文件行号（del 行无） */
  n?: number
  /** 行内容（gap 为空串） */
  s: string
  /** gap：被省略的行数 */
  c?: number
}

export interface EditDiffStats {
  /** 新增行数 */
  added: number
  /** 删除行数 */
  removed: number
}

/** 单文件差异结果 */
export interface EditDiffResult {
  /** 新增/删除行数（超出体积上限未计算时为 undefined） */
  stats?: EditDiffStats
  /** 变更块 + 上下文的预览行（gap 表示中间省略） */
  lines: EditDiffLine[]
  /** 超出预览行数上限被丢弃的行数 */
  omitted?: number
  /** 未生成差异的原因 */
  skipped?: 'too-large' | 'binary'
}

/** 单文件预览（带路径，供 UI 直接渲染） */
export interface EditDiffFilePreview extends EditDiffResult {
  path: string
  /** 目标文件此前不存在（新建） */
  created?: boolean
}

/** 挂在工具结果上的差异预览载荷（UI 专用，模型不可见） */
export interface EditDiffPreview {
  kind: 'edit-diff'
  files: EditDiffFilePreview[]
}

/** 参与 diff 的文本总字符数上限（超出则跳过，避免 Myers 在超长文本上耗时） */
export const EDIT_DIFF_MAX_CHARS = 400_000
/** 预览行数上限（含上下文与 gap） */
export const EDIT_DIFF_MAX_LINES = 600
/** 变更行前后保留的上下文行数 */
export const EDIT_DIFF_CONTEXT_LINES = 3

/**
 * 计算编辑前后的行级差异预览。
 *
 * @param before 编辑前内容（新建文件传空串）
 * @param after  编辑后内容
 */
export function computeEditDiff(before: string, after: string): EditDiffResult {
  if (before === after) return { stats: { added: 0, removed: 0 }, lines: [] }
  // 体积保护：超限直接跳过（宁可不显示，也不让工具调用卡住）
  if (before.length + after.length > EDIT_DIFF_MAX_CHARS) return { lines: [], skipped: 'too-large' }
  // 二进制保护：含 NUL 字节无法按行展示
  if (before.includes('\u0000') || after.includes('\u0000')) return { lines: [], skipped: 'binary' }

  const ops = diffLines(before, after)
  const stats = countStats(ops)

  // 展平为带行号的线性序列
  const flat: EditDiffLine[] = []
  let o = 1
  let n = 1
  for (const op of ops) {
    for (const text of op.lines) {
      if (op.type === 'equal') flat.push({ t: 'ctx', o: o++, n: n++, s: text })
      else if (op.type === 'delete') flat.push({ t: 'del', o: o++, s: text })
      else flat.push({ t: 'add', n: n++, s: text })
    }
  }

  // 保留变更行 ± 上下文，其余折叠为 gap
  const keep = new Array<boolean>(flat.length).fill(false)
  for (let i = 0; i < flat.length; i++) {
    if (flat[i].t === 'ctx') continue
    const from = Math.max(0, i - EDIT_DIFF_CONTEXT_LINES)
    const to = Math.min(flat.length - 1, i + EDIT_DIFF_CONTEXT_LINES)
    for (let j = from; j <= to; j++) keep[j] = true
  }

  const lines: EditDiffLine[] = []
  let hidden = 0
  const flushGap = () => {
    if (hidden > 0) {
      lines.push({ t: 'gap', s: '', c: hidden })
      hidden = 0
    }
  }
  for (let i = 0; i < flat.length; i++) {
    if (keep[i]) {
      flushGap()
      lines.push(flat[i])
    } else {
      hidden++
    }
  }
  flushGap()

  // 行数上限：保留前 N 行，其余丢弃（并统计丢弃行数供 UI 提示）
  let omitted: number | undefined
  if (lines.length > EDIT_DIFF_MAX_LINES) {
    omitted = lines.length - EDIT_DIFF_MAX_LINES
    lines.length = EDIT_DIFF_MAX_LINES
    // 截断后若末行是 gap 标记则去掉，避免以「⋯」结尾产生误导
    if (lines.length > 0 && lines[lines.length - 1].t === 'gap') lines.pop()
  }

  return { stats, lines, omitted }
}

/** 组装 UI 用的预览载荷（无文件或全部无内容时返回 undefined，避免空 preview 占位） */
export function makeEditDiffPreview(files: EditDiffFilePreview[]): EditDiffPreview | undefined {
  if (!files.length) return undefined
  return { kind: 'edit-diff', files }
}
