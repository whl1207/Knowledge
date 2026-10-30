/**
 * readWindow.ts — 把一段文本渲染成「带行号的读取窗口」（主进程 / 渲染层 / 安卓共用）
 *
 * 对齐 DSH 的 `read`（`dsh-tool-fs` 的 read-render）：
 * - `offset` / `limit` 以**行**为单位（1-based），不再是字符偏移；
 * - 每行前缀行号（`12: ...`），模型报错里说的"第 12 行"因此可以直接对上；
 * - 单行超长截断并标注，避免一行 2MB 的压缩产物把内存/上下文撑爆；
 * - 行数 / 字符 / 字节三重上限，任一触发就停，footer 给出续读锚点；
 * - 越界（offset 超过总行数）直接报错，而不是返回空串让模型以为文件是空的。
 *
 * 为什么必须单独成文件：同一套判定要在主进程（electron/main/tools.ts）和渲染层
 * （src/lib/agent/rendererTools.ts）跑，两边分叉就会出现"桌面按行、手机按字符"这种
 * 模型换端必然犯错的语义漂移。本文件不 import node / DOM，纯函数、可自测。
 */

/** 单次返回的最大行数（默认值，同时是上限） */
export const READ_MAX_LINES = 2000
/** 单行超过这么多字符就截断（防止一行 2MB 的压缩 JS / 单行 CSV 撑爆） */
export const READ_MAX_LINE_CHARS = 2000
/** 单次返回的字节上限（≈50 KiB，对齐 DSH 的 readMaxBytes） */
export const READ_MAX_BYTES = 50 * 1024

export interface ReadWindowOptions {
  /** 1-based 起始行，默认 1 */
  offsetLine?: number
  /** 最多返回多少行，默认 READ_MAX_LINES */
  maxLines?: number
  /** 单行最多多少字符，默认 READ_MAX_LINE_CHARS */
  maxLineChars?: number
  /** 正文总字符预算（不含页眉页脚）；默认不限 */
  maxChars?: number
  /** 正文总字节预算（不含页眉页脚）；默认 READ_MAX_BYTES */
  maxBytes?: number
}

export interface ReadWindow {
  /** 模型看到的完整文本：页眉 + 带行号的正文 + footer */
  text: string
  /** 本次实际起始行（没有正文时 = offsetLine - 1） */
  startLine: number
  /** 本次实际结束行（没有正文时 = offsetLine - 1） */
  endLine: number
  /** 文件总行数 */
  totalLines: number
  /** 还有后续行时给出下一段起始行号（1-based） */
  nextOffset?: number
  /** 是否因为行数 / 字符 / 字节上限提前停下 */
  capped: boolean
}

export type ReadWindowOutcome =
  | { ok: true; window: ReadWindow }
  | { ok: false; code: 'OUT_OF_RANGE'; error: string }

/** 把原文切成行（去掉行尾 \r；末尾换行不算多一行） */
function toLines(rawText: string): string[] {
  const text = String(rawText ?? '')
  if (!text) return []
  const parts = text.split('\n')
  if (parts.length && parts[parts.length - 1] === '') parts.pop()
  return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

/** 单行截断：保留前缀 + 明确的"被截断"标记（模型不会误以为这行就这么短） */
function truncateLine(line: string, maxLineChars: number): string {
  if (line.length <= maxLineChars) return line
  return `${line.slice(0, maxLineChars)}… (单行超过 ${maxLineChars} 字符，已截断)`
}

/**
 * 渲染一个读取窗口。
 *
 * @param rawText 已解码的全文（PDF/Word/Excel 传提取后的文本）
 * @param displayPath 展示路径（写进页眉，多文件读取时模型能分清是哪个文件）
 * @param opts 窗口与上限
 */
export function renderReadWindow(
  rawText: string,
  displayPath: string,
  opts: ReadWindowOptions = {},
): ReadWindowOutcome {
  const lines = toLines(rawText)
  const totalLines = lines.length
  const offsetLine = Math.max(1, Math.floor(Number(opts.offsetLine) || 1))
  // 空文件只有 offset=1 合法（DSH 同口径）：other offsets 才报越界
  if (offsetLine > totalLines && !(totalLines === 0 && offsetLine === 1)) {
    return {
      ok: false,
      code: 'OUT_OF_RANGE',
      error: `offset ${offsetLine} 超出范围：${displayPath} 共 ${totalLines} 行（offset 从 1 开始）`,
    }
  }

  const maxLines = Math.max(1, Math.floor(Number(opts.maxLines) || READ_MAX_LINES))
  const maxLineChars = Math.max(80, Math.floor(Number(opts.maxLineChars) || READ_MAX_LINE_CHARS))
  const maxChars = Number.isFinite(opts.maxChars) ? Math.max(0, Math.floor(opts.maxChars as number)) : Number.POSITIVE_INFINITY
  const maxBytes = Number.isFinite(opts.maxBytes) ? Math.max(0, Math.floor(opts.maxBytes as number)) : READ_MAX_BYTES

  const encoder = new TextEncoder()
  const rows: string[] = []
  let usedChars = 0
  let usedBytes = 0
  let capped = false

  for (let n = offsetLine; n <= totalLines; n++) {
    if (rows.length >= maxLines) {
      capped = true
      break
    }
    const row = `${n}: ${truncateLine(lines[n - 1], maxLineChars)}`
    // 行间换行符也计入预算（与真实输出一致）
    const chars = row.length + (rows.length ? 1 : 0)
    const bytes = encoder.encode(row).length + (rows.length ? 1 : 0)
    if (usedChars + chars > maxChars || usedBytes + bytes > maxBytes) {
      capped = true
      break
    }
    rows.push(row)
    usedChars += chars
    usedBytes += bytes
  }

  const startLine = rows.length ? offsetLine : offsetLine - 1
  const endLine = rows.length ? offsetLine + rows.length - 1 : offsetLine - 1
  const nextOffset = endLine < totalLines ? endLine + 1 : undefined

  const header = `${displayPath}（共 ${totalLines} 行）`
  const footer = totalLines === 0
    ? '（空文件）'
    : nextOffset === undefined
      ? `（已读到文件末尾：第 ${startLine}-${endLine} 行，共 ${totalLines} 行）`
      : capped
        ? `（已截断：本次第 ${startLine}-${endLine} 行，共 ${totalLines} 行；继续读请传 offset=${nextOffset}）`
        : `（本次第 ${startLine}-${endLine} 行，共 ${totalLines} 行；继续读请传 offset=${nextOffset}）`

  const body = rows.length ? `\n${rows.join('\n')}\n` : '\n'
  return {
    ok: true,
    window: {
      text: `${header}${body}${footer}`,
      startLine,
      endLine,
      totalLines,
      nextOffset,
      capped,
    },
  }
}
