/**
 * file-search.ts — `search_files` 的实现（从 tools.ts 抽出）
 *
 * 旧实现是「串行递归 + 每个文件 readFile + 大小写不敏感 includes」：
 * - 大仓库里慢，且不支持正则 / glob / .gitignore / 取消；
 * - 与 tools.ts 其它工具挤在同一个 3000 行文件里，改一次搜索要翻很久。
 *
 * 新实现保持零新依赖：
 * - 有界并发遍历（默认 6 个文件同时读）；
 * - 支持正则、大小写、`*.ts` / `src/**` 形式的文件过滤；
 * - 尊重根目录 `.gitignore` 的常见语法（注释 / 取反 / 目录 / **）；
 * - 响应 AbortSignal（turn 取消 / 工具超时）；
 * - 返回 `truncated` / `filesScanned` / `elapsedMs`，便于模型和 UI 判断结果是否完整。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ToolExecutionContext, ToolResult } from '@/types/tool'

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

export interface FileSearchOptions {
  root: string
  query: string
  regex?: boolean
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 把常见 gitignore / glob 语法转成正则（相对 POSIX 路径） */
function globToRegExp(glob: string): RegExp {
  let p = glob.trim().replace(/\\/g, '/')
  const dirOnly = p.endsWith('/')
  if (dirOnly) p = p.slice(0, -1)
  const anchored = p.startsWith('/')
  if (anchored) p = p.slice(1)
  let out = ''
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]
    if (ch === '*') {
      if (p[i + 1] === '*') {
        i++
        if (p[i + 1] === '/') { i++; out += '(?:.*/)?' }
        else out += '.*'
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else {
      out += escapeRegExp(ch)
    }
  }
  // 无斜杠的 pattern 匹配任意层级的一段；有斜杠的从根锚定
  const prefix = anchored || p.includes('/') ? '^' : '(?:^|/)'
  const suffix = dirOnly ? '(?:/.*)?$' : '(?:/.*)?$'
  return new RegExp(prefix + out + suffix)
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

function parseFilePatterns(pattern?: string): RegExp[] {
  if (!pattern || !pattern.trim()) return []
  return pattern.split(',').map((s) => s.trim()).filter(Boolean).map((p) => {
    // `.ts` / `.ts,.vue` 这类简写按扩展名匹配
    if (/^\.[A-Za-z0-9_+-]+$/.test(p)) return new RegExp(`${escapeRegExp(p)}$`, 'i')
    return globToRegExp(p)
  })
}

function matchesPatterns(rel: string, patterns: RegExp[]): boolean {
  if (patterns.length === 0) return true
  return patterns.some((re) => re.test(rel))
}

function makeMatcher(opts: FileSearchOptions): (line: string) => boolean {
  if (opts.regex) {
    const flags = opts.caseSensitive ? '' : 'i'
    const re = new RegExp(opts.query, flags)
    return (line) => re.test(line)
  }
  if (opts.caseSensitive) return (line) => line.includes(opts.query)
  const q = opts.query.toLowerCase()
  return (line) => line.toLowerCase().includes(q)
}

/** 在执行上下文里跑一次搜索（路径围栏 / skill 解析由调用方先做） */
export async function searchFilesInRoot(opts: FileSearchOptions): Promise<ToolResult> {
  const root = path.resolve(opts.root)
  const query = String(opts.query || '').trim()
  if (!query) return { ok: false, error: 'query 参数必填', code: 'INVALID_ARGS' }
  if (opts.signal?.aborted) return { ok: false, error: '搜索已取消', code: 'ABORTED' }

  let matcher: (line: string) => boolean
  try {
    matcher = makeMatcher(opts)
  } catch (e: any) {
    return { ok: false, error: `正则表达式不合法: ${e?.message || e}`, code: 'INVALID_ARGS' }
  }

  const maxResults = Math.max(1, Math.min(500, Number(opts.maxResults) || 30))
  const contextLines = Math.max(0, Math.min(5, Number(opts.contextLines) || 0))
  const maxFileSize = Math.max(0.1, Math.min(50, Number(opts.maxFileSizeMB) || 2)) * 1024 * 1024
  const includeHidden = opts.includeHidden === true
  const ignoreRules = opts.respectGitignore === false ? [] : loadGitignore(root)
  const patterns = parseFilePatterns(opts.filePattern)
  const started = Date.now()

  const results: FileSearchHit[] = []
  let filesScanned = 0
  let dirsScanned = 0
  let truncated = false
  const maxConcurrent = 6

  const shouldStop = () => !!opts.signal?.aborted || results.length >= maxResults

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
    filesScanned++
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
      if (results.length >= maxResults) {
        truncated = true
        break
      }
    }
  }

  const walk = async (dir: string): Promise<void> => {
    if (shouldStop()) return
    dirsScanned++
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch { return }

    const files: Array<{ abs: string; rel: string }> = []
    for (const entry of entries) {
      if (shouldStop()) break
      const abs = path.join(dir, entry.name)
      const rel = path.relative(root, abs).split(path.sep).join('/')
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue
        if (!includeHidden && entry.name.startsWith('.')) continue
        if (isIgnored(rel + '/', ignoreRules)) continue
        await walk(abs)
      } else if (entry.isFile()) {
        if (!includeHidden && entry.name.startsWith('.')) continue
        if (isIgnored(rel, ignoreRules)) continue
        files.push({ abs, rel })
      }
    }

    // 有界并发读文件：目录内先切块，避免一次 Promise.all 打开几千个 fd
    for (let i = 0; i < files.length && !shouldStop(); i += maxConcurrent) {
      const chunk = files.slice(i, i + maxConcurrent)
      await Promise.all(chunk.map((f) => searchFile(f.abs, f.rel)))
    }
  }

  try {
    await walk(root)
  } catch (e: any) {
    return { ok: false, error: `搜索失败: ${e?.message || String(e)}`, code: 'IO' }
  }

  if (opts.signal?.aborted) {
    return { ok: false, error: '搜索已取消', code: 'ABORTED' }
  }

  results.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  return {
    ok: true,
    value: {
      query,
      results,
      truncated: truncated || results.length >= maxResults,
      filesScanned,
      dirsScanned,
      elapsedMs: Date.now() - started,
      regex: !!opts.regex,
      caseSensitive: !!opts.caseSensitive,
      filePattern: opts.filePattern || '',
    },
  }
}

/** 供 tools.ts 的工具描述使用：让模型知道支持哪些参数 */
export const SEARCH_FILES_DESCRIPTION =
  '按文本搜索文件内容，返回匹配的文件路径、行号与内容片段。默认搜索工作区；传 skill 时搜索该技能目录。' +
  '支持正则（regex=true）、大小写敏感（caseSensitive=true）、文件过滤（filePattern，如 "*.ts" 或 "src/**/*.vue"）' +
  '与上下文行（contextLines，0~5）。默认有界并发遍历并遵守根目录 .gitignore；结果被 maxResults 截断时 truncated=true。'
