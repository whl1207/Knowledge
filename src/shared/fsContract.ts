/**
 * fsContract.ts — 插件文件能力的**契约层**（纯逻辑，主进程与渲染进程共用）
 *
 * 形状对齐 DSH 的 `ctx.fs`（见 `docs/plan/插件能力面向DSH风格收敛-设计方案（逐文件）.md` §四），
 * 只抄形状、不抄实现：
 * - **目标身份化**：每个操作先把路径归一成 `FsTarget{targetKey, displayPath}`，同一个文件经不同
 *   写法（`C:\a\b.txt` / `c:/a/../a/b.txt`）得到**同一个** `targetKey`；
 * - **版本**：`{size, mtimeMs}` 派生 `version`，写入/编辑可带 `expectedVersion`（省略 = 无条件，与
 *   改造前行为一致；给了就必须匹配，否则 `FS_STALE_VERSION`）；
 * - **稳定错误码**：失败按 `code` 分支，绝不解析文案（`FS_*` 族，见 `FS_ERROR_CODES`）；
 * - **字面量编辑**：`editText` 的匹配/替换与歧义判定是纯函数，两个半边共用一份
 *   （`applyLiteralEdits`），避免"主进程能替换、界面半边不能"这种漂移。
 *
 * ⚠️ 本文件**不做 I/O**，也不 import node / DOM：它被主进程与渲染层同时 import。
 */

/** 文件能力的稳定错误码（插件按 code 分支；文案可读但**不是**判据） */
export const FS_ERROR_CODES = [
  'FS_NOT_FOUND',
  'FS_NOT_DIRECTORY',
  'FS_NOT_TEXT',
  'FS_TOO_LARGE',
  'FS_STALE_VERSION',
  'FS_AMBIGUOUS_EDIT',
  'FS_NOT_OBSERVED',
  'FS_NOT_GRANTED',
  'FS_READ_ONLY_GRANT',
  'FS_FAILED',
] as const

export type FsErrorCode = (typeof FS_ERROR_CODES)[number]

export function isFsErrorCode(value: unknown): value is FsErrorCode {
  return typeof value === 'string' && (FS_ERROR_CODES as readonly string[]).includes(value)
}

/**
 * 目标身份。
 *
 * `targetKey` 是**不透明**标识：同一文件的不同写法归一后相同（用于"是不是同一个文件"的判断）；
 * `displayPath` 是给人看/给模型看的路径。消费方不得解析 `targetKey`。
 */
export interface FsTarget {
  /** 归一后的绝对路径（分隔符统一为 `/`；Windows 盘符小写） */
  path: string
  /** 不透明身份键（当前实现 = 归一化路径，但契约上不许解析） */
  targetKey: string
  /** 展示用路径（保持 `path` 的形态，便于 UI 直接显示） */
  displayPath: string
}

export interface FsStat {
  path: string
  exists: boolean
  isDir: boolean
  size: number
  mtimeMs: number
  /** 文件版本；不存在时为 null */
  version: string | null
}

export interface FsEntry {
  name: string
  path: string
  isDir: boolean
  size: number
}

export interface FsReadTextOptions {
  maxBytes?: number
  signal?: AbortSignal
}

export interface FsTextResult {
  path: string
  text: string
  /** 读到时的版本（随后写入可回传它做乐观并发） */
  version: string | null
  size: number
  /** 是否因 maxBytes 截断 */
  truncated: boolean
  /** PDF 走了文本提取（同一方法两种返回形状，这里显式标出来） */
  pdf?: boolean
  pages?: number
}

export interface FsBytesResult {
  path: string
  bytes: Uint8Array
  size: number
  version: string | null
}

export interface FsWriteOptions {
  /**
   * 乐观并发：给了就要求目标当前版本**等于**它，否则 `FS_STALE_VERSION`。
   * **省略 = 无条件覆盖**（与改造前的 `writeText` 完全一致，老插件行为不变）。
   */
  expectedVersion?: string
  /**
   * 存在性要求：`mustNotExist` 用于"安全创建"（已存在 → `FS_STALE_VERSION`），
   * `mustExist` 用于"只改不改建"（不存在 → `FS_NOT_FOUND`）。默认 `any`。
   */
  presence?: 'any' | 'mustExist' | 'mustNotExist'
  signal?: AbortSignal
}

export interface FsWriteResult {
  path: string
  bytes: number
  /** 写入后的新版本 */
  version: string | null
}

/** 一次字面量替换 */
export interface FsEdit {
  /** 要查找的字面量（不是正则） */
  find: string
  replace: string
  /** 默认 `false`：要求恰好出现 1 次（0 次或多次都算歧义） */
  all?: boolean
}

export interface FsEditResult {
  path: string
  applied: number
  bytes: number
  version: string | null
}

/**
 * 插件看到的文件能力（两侧同形状）。
 *
 * 与 DSH 的差别（有意）：
 * - 多了 `sheet` / `pdf` 两个**类型专属**子命名空间：AI-KM 的基座能解析 xlsx / 渲染 PDF，
 *   这是优势，不该为了"像 DSH"砍掉；但基座（readText/readBytes）只做文本与字节。
 * - `signal` 只做"尽力而为"的取消（与 DSH 一致：seam 不设 I/O deadline）。
 */
export interface PluginFsApi {
  readonly available: boolean
  readonly reason: string

  /** 归一化成目标身份（不触盘） */
  resolve(path: string | FsTarget, opts?: { cwd?: string }): FsTarget
  stat(target: string | FsTarget, opts?: { signal?: AbortSignal }): Promise<FsStat>

  readText(target: string | FsTarget, opts?: FsReadTextOptions): Promise<FsTextResult>
  readBytes(target: string | FsTarget, opts?: { maxBytes?: number; signal?: AbortSignal }): Promise<FsBytesResult>
  readBase64(target: string | FsTarget, opts?: { maxBytes?: number; signal?: AbortSignal }): Promise<{ path: string; base64: string; size: number }>
  listDir(target: string | FsTarget, opts?: { signal?: AbortSignal }): Promise<{ dir: string; entries: FsEntry[] }>

  writeText(target: string | FsTarget, text: string, opts?: FsWriteOptions): Promise<FsWriteResult>
  editText(target: string | FsTarget, edits: FsEdit[], opts?: FsWriteOptions): Promise<FsEditResult>
  remove(target: string | FsTarget, opts?: FsWriteOptions): Promise<{ removed: boolean; missing?: boolean }>

  /** 类型专属读：表格（xlsx / xls / csv） */
  readonly sheet: {
    read(target: string | FsTarget, opts?: { maxRows?: number; maxSheets?: number; signal?: AbortSignal }): Promise<{
      path: string
      sheetCount: number
      sheets: Array<{ name: string; headers: string[]; rows: unknown[][]; truncated: boolean }>
    }>
  }
}

// ---------------------------------------------------------------------------
// 路径归一化
// ---------------------------------------------------------------------------

/**
 * 归一化路径：统一分隔符、折叠 `.` / `..`、去掉多余分隔与尾部斜杠、Windows 盘符小写。
 *
 * 为什么不直接 `path.resolve`：渲染层没有 `node:path`。这里用纯字符串实现，**两侧共用**，
 * 于是"同一个文件的不同写法"在两个半边得到同一个 key（这是 `targetKey` 的唯一保证来源）。
 */
export function normalizeFsPath(input: string, cwd?: string): string {
  let rest = String(input ?? '').trim()
  if (!rest) return ''

  let root = ''
  const drive = /^([a-zA-Z]):[\\/]+/.exec(rest)
  if (drive) {
    root = `${drive[1].toLowerCase()}:/`
    rest = rest.slice(drive[0].length)
  } else if (/^[\\/]/.test(rest)) {
    root = '/'
    rest = rest.replace(/^[\\/]+/, '')
  } else if (cwd) {
    // 相对路径：拼到 cwd 上再归一（cwd 本身是绝对的，故不会无限递归）
    const base = normalizeFsPath(cwd).replace(/[\\/]+$/, '')
    if (!base) return normalizeFsPath(rest)
    return normalizeFsPath(`${base}/${rest}`)
  }

  const segments: string[] = []
  for (const seg of rest.split(/[\\/]+/)) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      segments.pop()
      continue
    }
    segments.push(seg)
  }
  const joined = segments.join('/')
  return root ? `${root}${joined}` : joined
}

/** 由路径得到目标身份（不触盘；`cwd` 用于相对路径） */
export function fsTargetOf(input: string | FsTarget, cwd?: string): FsTarget {
  if (input && typeof input === 'object' && typeof (input as FsTarget).targetKey === 'string') {
    const t = input as FsTarget
    return { path: t.path, targetKey: t.targetKey, displayPath: t.displayPath || t.path }
  }
  const p = normalizeFsPath(String(input ?? ''), cwd)
  return { path: p, targetKey: p, displayPath: p }
}

// ---------------------------------------------------------------------------
// 版本
// ---------------------------------------------------------------------------

/**
 * 由 `stat` 派生版本串：`"<size>:<mtimeMs>[:<ctimeMs>]"`。
 *
 * 为什么不用内容哈希：内容哈希要读全文件（大文件代价高），而这一层的用途是**乐观并发**
 * （"我读到之后没人改过"），`size + 时间戳` 足够；真的需要内容一致性的场景应另做校验。
 *
 * ⚠️ **不要 floor 时间戳**：同长度覆盖（自动保存最典型的形态）如果在同一毫秒内完成，
 * 取整会让版本**不变**，于是"版本防护"静默失效。这里保留原始浮点（NTFS 有 100ns 分辨率），
 * 并把 `ctimeMs` 也带上（元数据变更也会变）。实测踩过：`alpha\nbeta\nalpha\n` → 同长度覆盖。
 */
export function fsVersionOf(size: number, mtimeMs: number, ctimeMs?: number): string {
  const s = Number.isFinite(size) && size >= 0 ? size : 0
  const m = Number.isFinite(mtimeMs) && mtimeMs > 0 ? mtimeMs : 0
  const c = Number.isFinite(ctimeMs as number) && (ctimeMs as number) > 0 ? (ctimeMs as number) : null
  return c === null ? `${s}:${m}` : `${s}:${m}:${c}`
}

export function isFsVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d+(\.\d+)?:\d+(\.\d+)?(:\d+(\.\d+)?)?$/.test(value)
}

// ---------------------------------------------------------------------------
// 字面量编辑（纯函数：两个半边共用同一份判定）
// ---------------------------------------------------------------------------

export interface LiteralEditPlan {
  ok: true
  text: string
  applied: number
}
export interface LiteralEditFailure {
  ok: false
  code: FsErrorCode
  message: string
}

/**
 * 应用一组字面量替换。
 *
 * 规则（与 DSH 的 `editText` 同口径）：
 * - `find` 为空 → 参数错误（`FS_FAILED`）；
 * - 默认要求 `find` **恰好出现 1 次**：0 次 → `FS_AMBIGUOUS_EDIT`（"要改的内容不存在"），
 *   多次 → `FS_AMBIGUOUS_EDIT`（"锚点不够独特，请写长一点"）；
 * - `all: true` 时替换全部出现（0 次仍是歧义）；
 * - 多个 edits **按顺序**应用（后一个能看到前一个的结果）。
 *
 * 之所以"多次也算歧义"而不是"全替换"：插件改用户文件时，"我以为只有一处"正是最容易误伤的情形；
 * 要全替换必须显式写 `all: true`。
 */
export function applyLiteralEdits(text: string, edits: FsEdit[]): LiteralEditPlan | LiteralEditFailure {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, code: 'FS_FAILED', message: 'edits 不能为空' }
  }
  let out = String(text ?? '')
  let applied = 0
  for (const [i, edit] of edits.entries()) {
    const find = typeof edit?.find === 'string' ? edit.find : ''
    const replace = typeof edit?.replace === 'string' ? edit.replace : ''
    if (!find) return { ok: false, code: 'FS_FAILED', message: `edits[${i}].find 不能为空` }

    let count = 0
    for (let at = out.indexOf(find); at !== -1; at = out.indexOf(find, at + find.length)) count++

    if (count === 0) {
      return { ok: false, code: 'FS_AMBIGUOUS_EDIT', message: `edits[${i}] 要替换的内容不存在（find 未命中）` }
    }
    if (count > 1 && edit.all !== true) {
      return {
        ok: false,
        code: 'FS_AMBIGUOUS_EDIT',
        message: `edits[${i}] 的 find 命中 ${count} 处；请写更长的锚点，或显式传 all: true`,
      }
    }
    out = edit.all === true ? out.split(find).join(replace) : out.replace(find, replace)
    applied += edit.all === true ? count : 1
  }
  return { ok: true, text: out, applied }
}
