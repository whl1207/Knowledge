/**
 * globMatch.ts — glob → 正则（主进程 / 渲染层共用，纯函数）
 *
 * 从 `electron/main/file-search.ts` 抽出来：同一套 glob 语义要同时服务
 * `search_files` 的 `filePattern`、`.gitignore` 规则与新增的 `glob` 工具，
 * 两边分叉就会出现"过滤得到、查找找不到"这种自相矛盾。
 *
 * 支持的语法（与原来的实现保持一致）：
 * - `*` 匹配一段（不跨 `/`）；`**` 跨目录；`?` 匹配单字符；
 * - 不含 `/` 的模式匹配**任意层级**的同名条目（`*.ts` 等于 `** / *.ts`）；
 * - 含 `/` 或以前导 `/` 开头的模式从根锚定；
 * - 末尾 `/` 表示目录（按"目录及其下所有内容"匹配）。
 */

/** 把 glob 转成正则；`matchDir=false` 时用于匹配具体文件（结尾不再允许 `/...`） */
export function globToRegExp(glob: string, opts: { matchDir?: boolean; ignoreCase?: boolean } = {}): RegExp {
  let p = String(glob || '').trim().replace(/\\/g, '/')
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
        if (p[i + 1] === '/') {
          i++
          out += '(?:.*/)?'
        } else out += '.*'
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else {
      out += escapeRegExpChar(ch)
    }
  }

  const prefix = anchored || p.includes('/') ? '^' : '(?:^|/)'
  const allowTail = opts.matchDir !== false || dirOnly
  const suffix = allowTail ? '(?:/.*)?$' : '$'
  return new RegExp(prefix + out + suffix, opts.ignoreCase ? 'i' : '')
}

function escapeRegExpChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch
}

/** 整串转义（用于把 `.ts` 这种简写当后缀匹配） */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 单个文件路径是否匹配 glob（路径用 `/` 分隔、相对搜索根）。
 * 文件匹配默认大小写不敏感（Windows 上 `*.TS` 与 `*.ts` 是同一个文件；
 * 代码场景里模型也常写错大小写）。
 */
export function matchesFileGlob(relPath: string, pattern: string, ignoreCase = true): boolean {
  try {
    return globToRegExp(pattern, { matchDir: false, ignoreCase }).test(relPath)
  } catch {
    return false
  }
}

/**
 * 编译逗号分隔的 glob 列表（`search_files.filePattern` 用）。
 * 简写 `.ts` 按扩展名匹配（保持旧行为）。
 */
export function compileFileGlobs(csv?: string): RegExp[] {
  const text = String(csv || '').trim()
  if (!text) return []
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => {
      if (/^\.[A-Za-z0-9_+-]+$/.test(p)) return new RegExp(`${escapeRegExp(p)}$`, 'i')
      return globToRegExp(p, { matchDir: false, ignoreCase: true })
    })
}
