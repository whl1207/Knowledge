/**
 * file-search.ts — `search_files`（内容检索）与 `glob`（按路径找文件）的实现
 *
 * 设计要点（对照 DSH：`grep` + `glob` 两个工具，我们在同一层实现）：
 * - **零新依赖**：不打包 ripgrep，用有界并发遍历 + 逐文件读；大仓库靠 90s 工具超时兜底。
 * - **两种结果形态**：`value` 里是结构化命中（给 UI / 日志 / 引用），
 *   `modelText` 是**按文件分组的纯文本**（给模型，避免 JSON 转义与字段名重复）。
 * - **超限可续**：内联只放 maxResults 条，最多再收集到 SPILL_MAX_HITS 条；
 *   多出来的部分由调用方（tools.ts）落盘成 spill 文件，模型用 read_file 回读。
 * - **默认大小写敏感**（DSH / rg 同口径）：代码检索里 `read` 命中 `READ` 是噪声；
 *   需要忽略大小写时显式传 `ignoreCase: true`。
 * - **glob 语义与 .gitignore 共用一套**（`@/shared/globMatch`），不会再出现"过滤得到、查找找不到"。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ToolExecutionContext, ToolResult } from '@/types/tool'
import { compileFileGlobs, globToRegExp, matchesFileGlob } from '@/shared/globMatch'
import { formatGlobText, formatGrepText, type GrepHitText } from '@/shared/searchText'

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'dist-electron', 'release',
  '.vscode', '.idea', '__pycache__', '.venv', 'venv', 'out', 'build', 'coverage',
  'target', 'miniprogram_npm', '.mypy_cache', '.pytest_cache',
])

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp4',
  '.mp3', '.wav', '.db', '.sqlite', '.node', '.wasm',
])

/** 内联之外最多再收集多少条命中（够 spill 出"完整结果"即可，避免无界扫描） */
const SPILL_MAX_HITS = 1000
/** glob 默认 / 最大返回条数 */
const GLOB_DEFAULT_MAX = 100
const GLOB_HARD_MAX = 1000

export interface FileSearchOptions {
  root: string
  query: string
  regex?: boolean
  /** 忽略大小写（默认 false = 大小写敏感，与 DSH / rg 一致） */
  ignoreCase?: boolean
  /** @deprecated 旧参数：`false` 等价于 `ignoreCase: true` */
  caseSensitive?: boolean
  /** 逗号分隔的 glob（`*.ts`、`src/**`、`.ts` 都接受） */
  filePattern?: string
  maxResults?: number
  contextLines?: number
  maxFileSizeMB?: number
  includeHidden?: boolean
  respectGitignore?: boolean
  signal?: AbortSignal
}

export interface FileSearchHit {
  path: string
  line: number
  text: string
  /** 上下文行（不含命中行本身），仅 contextLines > 0 时存在 */
  before?: string[]
  after?: string[]
}

export interface GlobOptions {
  root: string
  pattern: string
  maxResults?: number
  includeHidden?: boolean
  respectGitignore?: boolean
  signal?: AbortSignal
}

export interface GlobFile {
  /** 相对搜索根的路径（`/` 分隔） */
  path: string
  size: number
  mtimeMs: number
}

interface IgnoreRule { re: RegExp; negate: boolean }

function loadGitignore(root: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  try {
    const file = path.join(root, '.gitignore')
    if (!fs.existsSync(file)) return rules
    const text = fs.readFileSync(file, 'utf8')
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const negate = line.startsWith('!')
      const body = negate ? line.slice(1) : line
      if (!body) continue
      rules.push({ re: globToRegExp(body), negate })
    }
  } catch { /* 读不到就不启用 gitignore */ }
  return rules
}

function isIgnored(rel: string, rules: IgnoreRule[]): boolean {
  let ignored = false
  for (const r of rules) {
    if (r.re.test(rel)) ignored = !r.negate
  }
  return ignored
}

function matchesPatterns(rel: string, patterns: RegExp[]): boolean {
  if (patterns.length === 0) return true
  return patterns.some((re) => re.test(rel))
}

function makeMatcher(opts: FileSearchOptions): (line: string) => boolean {
  // 兼容旧调用：caseSensitive === false 的老语义是"忽略大小写"
  const ignoreCase = opts.ignoreCase === true || opts.caseSensitive === false
  if (opts.regex) {
    const re = new RegExp(opts.query, ignoreCase ? 'i' : '')
    return (line) => re.test(line)
  }
  if (!ignoreCase) return (line) => line.includes(opts.query)
  const q = opts.query.toLowerCase()
  return (line) => line.toLowerCase().includes(q)
}

/** 一次有界遍历：把文件交给 onFile（串行 await，由调用方控制并发） */
async function walkFiles(
  root: string,
  opts: { includeHidden: boolean; ignoreRules: IgnoreRule[]; signal?: AbortSignal },
  onFile: (abs: string, rel: string) => Promise<void> | void,
  shouldStop: () => boolean,
): Promise<{ filesScanned: number; dirsScanned: number }> {
  let filesScanned = 0
  let dirsScanned = 0
  const walk = async (dir: string): Promise<void> => {
    if (shouldStop() || opts.signal?.aborted) return
    dirsScanned++
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch { return }
    for (const entry of entries) {
      if (shouldStop() || opts.signal?.aborted) break
      const abs = path.join(dir, entry.name)
      const rel = path.relative(root, abs).split(path.sep).join('/')
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue
        if (!opts.includeHidden && entry.name.startsWith('.')) continue
        if (isIgnored(rel + '/', opts.ignoreRules)) continue
        await walk(abs)
      } else if (entry.isFile()) {
        if (!opts.includeHidden && entry.name.startsWith('.')) continue
        if (isIgnored(rel, opts.ignoreRules)) continue
        filesScanned++
        await onFile(abs, rel)
      }
    }
  }
  await walk(root)
  return { filesScanned, dirsScanned }
}

/** 在执行上下文里跑一次内容搜索（路径围栏 / skill 解析由调用方先做） */
export async function searchFilesInRoot(opts: FileSearchOptions): Promise<ToolResult> {
  const root = path.resolve(opts.root)
  const query = String(opts.query || '').trim()
  if (!query) return { ok: false, error: 'query 参数必填', code: 'INVALID_ARGS' }
  if (opts.signal?.aborted) return { ok: false, error: '搜索已取消', code: 'SEARCH_ABORTED' }

  let matcher: (line: string) => boolean
  try {
    matcher = makeMatcher(opts)
  } catch (e: any) {
    return { ok: false, error: `正则表达式不合法: ${e?.message || e}`, code: 'SEARCH_INVALID_PATTERN' }
  }

  const inlineMax = Math.max(1, Math.min(500, Number(opts.maxResults) || 30))
  const hardMax = Math.max(inlineMax, SPILL_MAX_HITS)
  const contextLines = Math.max(0, Math.min(5, Number(opts.contextLines) || 0))
  const maxFileSize = Math.max(0.1, Math.min(50, Number(opts.maxFileSizeMB) || 2)) * 1024 * 1024
  const ignoreRules = opts.respectGitignore === false ? [] : loadGitignore(root)
  const patterns = compileFileGlobs(opts.filePattern)
  const started = Date.now()

  const results: FileSearchHit[] = []
  let scanTruncated = false
  const maxConcurrent = 6

  const shouldStop = () => !!opts.signal?.aborted || results.length >= hardMax

  const searchFile = async (abs: string, rel: string): Promise<void> => {
    if (shouldStop()) return
    const ext = path.extname(abs).toLowerCase()
    if (BINARY_EXT.has(ext)) return
    if (!matchesPatterns(rel, patterns)) return
    let st: fs.Stats
    try {
      st = await fs.promises.stat(abs)
    } catch { return }
    if (!st.isFile() || st.size > maxFileSize) return
    let text: string
    try {
      text = await fs.promises.readFile(abs, 'utf8')
    } catch { return }
    // 二进制兜底：文本文件里出现 NUL 基本就是二进制
    if (text.indexOf('\u0000') >= 0) return
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length && !shouldStop(); i++) {
      if (!matcher(lines[i])) continue
      const hit: FileSearchHit = {
        path: rel,
        line: i + 1,
        text: lines[i].slice(0, 500),
      }
      if (contextLines > 0) {
        hit.before = lines.slice(Math.max(0, i - contextLines), i).map((l) => l.slice(0, 300))
        hit.after = lines.slice(i + 1, i + 1 + contextLines).map((l) => l.slice(0, 300))
      }
      results.push(hit)
      if (results.length >= hardMax) {
        scanTruncated = true
        break
      }
    }
  }

  // 有界并发：先按目录收集文件，再分块读（避免一次打开几千个 fd）
  const pending: Array<{ abs: string; rel: string }> = []
  const flush = async () => {
    for (let i = 0; i < pending.length && !shouldStop(); i += maxConcurrent) {
      const chunk = pending.splice(0, maxConcurrent)
      await Promise.all(chunk.map((f) => searchFile(f.abs, f.rel)))
    }
  }

  let filesScanned = 0
  let dirsScanned = 0
  try {
    const counts = await walkFiles(
      root,
      { includeHidden: opts.includeHidden === true, ignoreRules, signal: opts.signal },
      async (abs, rel) => {
        pending.push({ abs, rel })
        if (pending.length >= maxConcurrent * 4) await flush()
      },
      shouldStop,
    )
    filesScanned = counts.filesScanned
    dirsScanned = counts.dirsScanned
    await flush()
  } catch (e: any) {
    return { ok: false, error: `搜索失败: ${e?.message || String(e)}`, code: 'SEARCH_FAILED' }
  }

  if (opts.signal?.aborted) return { ok: false, error: '搜索已取消', code: 'SEARCH_ABORTED' }

  results.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  const inline = results.slice(0, inlineMax)
  const totalHits = results.length
  const fileCount = new Set(results.map((h) => h.path)).size
  const truncated = totalHits > inlineMax || scanTruncated

  const modelText = formatGrepText(inline as GrepHitText[], {
    root,
    query,
    regex: !!opts.regex,
    shown: inline.length,
    totalHits,
    files: fileCount,
    truncated,
    note: truncated && scanTruncated ? `扫描已到 ${SPILL_MAX_HITS} 条上限` : undefined,
  })
  // 超限时把"完整命中"另存一份文本，供 tools.ts 落盘成 spill 文件
  const overflowText = totalHits > inline.length
    ? formatGrepText(results as GrepHitText[], {
        root,
        query,
        regex: !!opts.regex,
        shown: totalHits,
        totalHits,
        files: fileCount,
        truncated: scanTruncated,
        note: scanTruncated ? `扫描已到 ${SPILL_MAX_HITS} 条上限` : undefined,
      })
    : undefined

  return {
    ok: true,
    value: {
      query,
      results: inline,
      totalHits,
      truncated,
      filesScanned,
      dirsScanned,
      elapsedMs: Date.now() - started,
      regex: !!opts.regex,
      ignoreCase: opts.ignoreCase === true || opts.caseSensitive === false,
      filePattern: opts.filePattern || '',
      modelText,
      ...(overflowText ? { overflowText } : {}),
    },
  }
}

/**
 * 按路径 / 文件名查找文件（`glob` 工具）。
 *
 * 与 DSH 的 `glob` 对齐：不含 `/` 的模式按 basename 匹配任意深度；结果**按修改时间倒序**
 * （最近改的优先）；默认排除 node_modules / .git 等目录并尊重根 `.gitignore`。
 */
export async function globFilesInRoot(opts: GlobOptions): Promise<ToolResult> {
  const root = path.resolve(opts.root)
  const pattern = String(opts.pattern || '').trim()
  if (!pattern) return { ok: false, error: 'pattern 参数必填（如 **/*.md）', code: 'INVALID_ARGS' }
  if (opts.signal?.aborted) return { ok: false, error: '搜索已取消', code: 'SEARCH_ABORTED' }
  try {
    globToRegExp(pattern, { matchDir: false, ignoreCase: true })
  } catch (e: any) {
    return { ok: false, error: `glob 模式不合法: ${e?.message || e}`, code: 'SEARCH_INVALID_PATTERN' }
  }

  const maxResults = Math.max(1, Math.min(GLOB_HARD_MAX, Number(opts.maxResults) || GLOB_DEFAULT_MAX))
  const ignoreRules = opts.respectGitignore === false ? [] : loadGitignore(root)
  const started = Date.now()
  const found: GlobFile[] = []
  let scanTruncated = false
  const hardMax = GLOB_HARD_MAX
  const shouldStop = () => !!opts.signal?.aborted || found.length >= hardMax

  let counts = { filesScanned: 0, dirsScanned: 0 }
  try {
    counts = await walkFiles(
      root,
      { includeHidden: opts.includeHidden === true, ignoreRules, signal: opts.signal },
      async (abs, rel) => {
        if (shouldStop()) return
        if (!matchesFileGlob(rel, pattern)) return
        try {
          const st = await fs.promises.stat(abs)
          found.push({ path: rel, size: st.size, mtimeMs: st.mtimeMs })
        } catch { return }
        if (found.length >= hardMax) scanTruncated = true
      },
      shouldStop,
    )
  } catch (e: any) {
    return { ok: false, error: `查找失败: ${e?.message || String(e)}`, code: 'SEARCH_FAILED' }
  }
  if (opts.signal?.aborted) return { ok: false, error: '搜索已取消', code: 'SEARCH_ABORTED' }

  found.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))
  const inline = found.slice(0, maxResults)
  const total = found.length
  const truncated = total > inline.length || scanTruncated
  // 超限时另存一份完整列表，供 tools.ts 落盘成 spill 文件（与 search_files 同一套）
  const overflowText = total > inline.length
    ? formatGlobText(found, { root, pattern, total, truncated: scanTruncated, byMtime: true })
    : undefined

  return {
    ok: true,
    value: {
      pattern,
      root,
      files: inline,
      totalFound: total,
      truncated,
      filesScanned: counts.filesScanned,
      dirsScanned: counts.dirsScanned,
      elapsedMs: Date.now() - started,
      modelText: formatGlobText(inline, { root, pattern, total, truncated, byMtime: true }),
      ...(overflowText ? { overflowText } : {}),
    },
  }
}

/** 供 tools.ts 的工具描述使用 */
export const SEARCH_FILES_DESCRIPTION =
  '按文本搜索文件内容（默认大小写敏感），返回按文件分组、带行号的结果。支持正则（regex）、文件过滤（filePattern，如 "*.ts" 或 "src/**/*.vue"）、'
  + '忽略大小写（ignoreCase）与上下文行（contextLines 0~5）。默认遵守 .gitignore；命中超过 maxResults 时完整列表会另存为临时文件（返回里给路径）。'
