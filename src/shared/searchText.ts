/**
 * searchText.ts — 搜索类工具的**模型可见文本**（主进程 / 渲染层共用，纯函数）
 *
 * 为什么不再直接喂 JSON：`search_files` 的结果是 `{ results: [{path, line, text, …}] }`，
 * `JSON.stringify` 之后每条命中都要重复一遍字段名（`"path":` / `"line":` / `"text":`），
 * 换行还要转义。DSH 的 grep 是按文件分组的纯文本（`Line 12: …`），本文件对齐它。
 *
 * 结构化的结果仍然留在 `value` 里给 UI / 日志用，模型只看这里的文本。
 */

export interface GrepHitText {  path: string
  line: number
  text: string
  /** 命中行之前的上下文（不含命中行） */
  before?: string[]
  /** 命中行之后的上下文 */
  after?: string[]
}

export interface GrepTextOptions {
  /** 搜索根（展示用，通常是绝对路径） */
  root: string
  /** 用户给的查询词 / 正则 */
  query: string
  /** 内联展示了多少处 */
  shown: number
  /** 一共命中多少处（可能 > shown） */
  totalHits: number
  /** 命中了多少个文件 */
  files: number
  /** 是否还有未展示的命中 */
  truncated: boolean
  /** 额外说明（例如"区分大小写"），可选 */
  note?: string
  /** 是否按正则解释（影响页眉文案） */
  regex?: boolean
}

/** 把命中列表渲染成"按文件分组"的纯文本 */
export function formatGrepText(hits: GrepHitText[], opts: GrepTextOptions): string {
  const header = `${opts.root}（${opts.regex ? '正则' : '关键词'} "${opts.query}"，命中 ${opts.totalHits} 处 / ${opts.files} 个文件${opts.note ? `；${opts.note}` : ''}）`
  if (!hits.length) return `${header}\n（没有匹配）`

  const lines: string[] = [header]
  let current = ''
  for (const hit of hits) {
    if (hit.path !== current) {
      if (current) lines.push('')
      current = hit.path
      lines.push(current)
    }
    for (const ctx of hit.before || []) lines.push(`  ${hit.line - (hit.before || []).length}: ${truncateLine(ctx)}`)
    lines.push(`  Line ${hit.line}: ${truncateLine(hit.text)}`)
    for (let i = 0; i < (hit.after || []).length; i++) {
      lines.push(`  ${hit.line + i + 1}: ${truncateLine((hit.after || [])[i])}`)
    }
  }
  if (opts.truncated) {
    lines.push('')
    lines.push(
      `…（只显示了前 ${opts.shown} 处，共 ${opts.totalHits} 处；请加 filePattern 缩小范围、换更精确的关键词，或提高 maxResults）`,
    )
  }
  return lines.join('\n')
}

export interface GlobItem { path: string; mtimeMs?: number }

export interface GlobTextOptions {
  root: string
  pattern: string
  /** 匹配到的总数（可能 > 展示数） */
  total: number
  /** 是否被上限截断 */
  truncated: boolean
  /** 结果是否按修改时间排序 */
  byMtime?: boolean
}

/** 把文件列表渲染成纯文本（每行一个路径，相对 root） */
export function formatGlobText(items: GlobItem[], opts: GlobTextOptions): string {
  const order = opts.byMtime ? '按修改时间倒序' : '按路径排序'
  const header = `${opts.root}（模式 "${opts.pattern}"，${order}，共 ${opts.total} 个）`
  if (!items.length) return `${header}\n（没有匹配的文件）`
  const lines = [header, ...items.map((it) => it.path)]
  if (opts.truncated) {
    lines.push(`…（已截断：只显示前 ${items.length} 个，共 ${opts.total} 个；请用更精确的 pattern 或指定 root）`)
  }
  return lines.join('\n')
}

/** 单行预览上限：与 read_file 的单行上限一致，避免一行压缩产物刷屏 */
export const SEARCH_PREVIEW_MAX_CHARS = 2000

function truncateLine(text: string): string {
  const s = String(text ?? '')
  return s.length > SEARCH_PREVIEW_MAX_CHARS ? `${s.slice(0, SEARCH_PREVIEW_MAX_CHARS)}…` : s
}
