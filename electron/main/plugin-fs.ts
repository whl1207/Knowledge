/**
 * plugin-fs.ts — 插件文件能力的**唯一实现**（主进程半边直接调用；界面半边经 IPC 转发）
 *
 * 为什么要"一份实现"：改造前同一件事有三个入口（界面 `ctx.files.*`、主进程 `ctx.host.readFile/*`、
 * `ctx.host.granted.*`），三套路径校验、三套错误文案。收敛后只有这里一套，两侧只是**传输方式**不同。
 *
 * 契约见 `src/shared/fsContract.ts`（纯逻辑：路径归一化、版本、字面量编辑）。
 * 设计见 `docs/plan/插件能力面向DSH风格收敛-设计方案（逐文件）.md` §四。
 *
 * 授权模型（**未改变**）：
 * - 插件自己的目录：读写都放行（与主进程半边 `ctx.host.readFile/writeFile` 的既有语义一致）；
 * - 用户授权过的路径：`plugin-grants.assertAccess` 判读/写（只读授权下写 → `FS_READ_ONLY_GRANT`）；
 * - 其余：`FS_NOT_GRANTED`。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import * as PDFJS from 'pdfjs-dist/legacy/build/pdf.mjs'
import xlsx from 'xlsx'
import { IPCError } from '@/types/ipc'
import { assertAccess } from './plugin-grants'
import {
  applyLiteralEdits,
  fsTargetOf,
  fsVersionOf,
  normalizeFsPath,
  type FsEdit,
  type FsEditResult,
  type FsErrorCode,
  type FsStat,
  type FsTarget,
  type FsTextResult,
  type FsWriteOptions,
  type FsWriteResult,
  type PluginFsApi,
} from '@/shared/fsContract'
import { decideEdit, decideRemove, decideWrite, type FsPolicyDecision } from '@/shared/fsPolicy'
import { isFsPolicyEnabled, noteObserved, observationTableOf } from './plugin-fs-policy'

const SHEET_MAX_BYTES = 32 * 1024 * 1024
const SHEET_MAX_ROWS = 20000
const SHEET_MAX_SHEETS = 20
const SHEET_MAX_COLS = 200
const DEFAULT_TEXT_MAX_BYTES = 200_000
const MAX_TEXT_MAX_BYTES = 2_000_000
const DEFAULT_BYTES_MAX = 40 * 1024 * 1024
const MAX_BYTES_MAX = 80 * 1024 * 1024

export interface PluginFsDeps {
  pluginId: string
  /** 插件目录（绝对路径）；其中的读写不需要用户授权 */
  pluginDir: string
  /** 清单是否声明了 `fs` 权限 */
  hasPermission: boolean
}

/** 把任意异常归一成带 `FS_*` code 的 IPCError（插件按 code 分支） */
export function asFsError(error: unknown, fallback: FsErrorCode = 'FS_FAILED'): IPCError {
  if (error instanceof IPCError) return error
  const err = error as NodeJS.ErrnoException | undefined
  const code = err && typeof err.code === 'string' ? err.code : ''
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'ENOENT') return new IPCError('FS_NOT_FOUND', message)
  if (code === 'EISDIR') return new IPCError('FS_NOT_DIRECTORY', message)
  if (code === 'ENOTDIR') return new IPCError('FS_NOT_DIRECTORY', message)
  if (code === 'EACCES' || code === 'EPERM') return new IPCError('FS_NOT_GRANTED', message)
  return new IPCError(fallback, message)
}

/** target 是否在 root 之内（按路径**段**比较；`/a/bc` 不会让 `/a/bcd` 通过） */
export function isInsideDir(root: string, target: string): boolean {
  const r = normalizeFsPath(root).replace(/\/+$/, '')
  const t = normalizeFsPath(target)
  if (!r || !t) return false
  return t === r || t.startsWith(`${r}/`)
}

/** 读 PDF 文本（pdfjs legacy 构建；与 `electron/main/index.ts` 的 readPdf 同一套做法） */
export async function readPdfText(buffer: Buffer): Promise<{ text: string; pages: number }> {
  const doc = await PDFJS.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise
  const chunks: string[] = []
  const numPages = doc.numPages
  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    chunks.push(content.items.map((it: any) => String(it?.str ?? '')).join(' '))
  }
  await doc.destroy()
  return { text: chunks.join('\n\n'), pages: numPages }
}

/** 读表格（xlsx / xls / csv → 每个工作表的表头 + 数据行） */
export async function readSheetFile(
  filePath: string,
  opts: { maxRows?: number; maxSheets?: number } = {},
): Promise<{
  path: string
  sheetCount: number
  sheets: Array<{ name: string; headers: string[]; rows: unknown[][]; truncated: boolean }>
}> {
  const stat = await fs.stat(filePath)
  if (stat.size > SHEET_MAX_BYTES) {
    throw new IPCError('FS_TOO_LARGE', `表格过大：${Math.round(stat.size / 1024 / 1024)}MB（上限 ${Math.round(SHEET_MAX_BYTES / 1024 / 1024)}MB）`)
  }
  const maxRows = Math.max(10, Math.min(Number(opts.maxRows) || SHEET_MAX_ROWS, SHEET_MAX_ROWS))
  const maxSheets = Math.max(1, Math.min(Number(opts.maxSheets) || SHEET_MAX_SHEETS, SHEET_MAX_SHEETS))
  const workbook = xlsx.read(await fs.readFile(filePath), { type: 'buffer' })
  const names = workbook.SheetNames.slice(0, maxSheets)
  const sheets = names.map((name) => {
    const worksheet = workbook.Sheets[name]
    const grid = worksheet ? (xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: '', blankrows: false }) as unknown[][]) : []
    const header = (Array.isArray(grid[0]) ? grid[0] : []).slice(0, SHEET_MAX_COLS).map((v) => String(v ?? '').trim())
    const body = grid.slice(1, maxRows + 1).map((row) => (Array.isArray(row) ? row.slice(0, SHEET_MAX_COLS) : []))
    return { name, headers: header, rows: body, truncated: grid.length - 1 > maxRows }
  })
  return { path: filePath, sheetCount: workbook.SheetNames.length, sheets }
}

/** 看起来像二进制就不当文本读（NUL 字节是最可靠的廉价判据） */
function looksBinary(buffer: Buffer): boolean {
  const n = Math.min(buffer.length, 4096)
  for (let i = 0; i < n; i++) if (buffer[i] === 0) return true
  return false
}

export function createPluginFs(deps: PluginFsDeps): PluginFsApi {
  const pluginDir = normalizeFsPath(deps.pluginDir)

  const requirePermission = (): void => {
    if (!deps.hasPermission) {
      throw new IPCError('PERMISSION_DENIED', `插件 ${deps.pluginId} 未声明 fs 权限（package.json 的 aikm.permissions）`)
    }
  }

  /**
   * 把 `plugin-grants.assertAccess` 的拒绝翻译成 `FS_*` 稳定码（**不解析文案**）。
   *
   * 判定方式：写请求被拒时，再按"读"判一次 —— 通过说明该路径**有只读授权**，
   * 于是 `FS_READ_ONLY_GRANT`；不通过则是压根没授权，`FS_NOT_GRANTED`。
   * 文案原样保留（作者看的是人话，代码看的是 code）。
   */
  const throwGrantError = (target: string, need: 'read' | 'write', error: unknown): never => {
    let code: 'FS_NOT_GRANTED' | 'FS_READ_ONLY_GRANT' = 'FS_NOT_GRANTED'
    if (need === 'write') {
      try {
        assertAccess(deps.pluginId, target, 'read')
        code = 'FS_READ_ONLY_GRANT'
      } catch {
        code = 'FS_NOT_GRANTED'
      }
    }
    throw new IPCError(code, error instanceof Error ? error.message : String(error))
  }

  /** 读：插件目录内放行；否则要求用户在授权清单里选过这个路径 */
  const assertReadable = (abs: string): void => {
    if (pluginDir && isInsideDir(pluginDir, abs)) return
    try {
      assertAccess(deps.pluginId, abs, 'read')
    } catch (e) {
      throwGrantError(abs, 'read', e)
    }
  }

  /** 写：插件目录内放行；否则**只认可写授权**（只读授权 → FS_READ_ONLY_GRANT） */
  const assertWritable = (abs: string): void => {
    if (pluginDir && isInsideDir(pluginDir, abs)) return
    try {
      assertAccess(deps.pluginId, abs, 'write')
    } catch (e) {
      throwGrantError(abs, 'write', e)
    }
  }

  const targetOf = (input: string | FsTarget, cwd?: string): FsTarget => {
    const t = fsTargetOf(input, cwd)
    if (!t.path) throw new IPCError('INVALID_ARGUMENT', '缺少路径')
    if (!path.isAbsolute(t.path)) {
      throw new IPCError('INVALID_ARGUMENT', `路径必须是绝对路径：${t.path}（相对路径请先 resolve，或传 { cwd }）`)
    }
    return t
  }

  const statOf = async (abs: string): Promise<FsStat> => {
    const st = await fs.stat(abs).catch(() => null)
    if (!st) return { path: abs, exists: false, isDir: false, size: 0, mtimeMs: 0, version: null }
    return {
      path: abs,
      exists: true,
      isDir: st.isDirectory(),
      size: st.size,
      mtimeMs: st.mtimeMs,
      version: st.isDirectory() ? null : fsVersionOf(st.size, st.mtimeMs, st.ctimeMs),
    }
  }

  /** 版本 / 存在性检查（写与删共用） */
  const assertVersion = async (abs: string, opts: FsWriteOptions | undefined): Promise<FsStat> => {
    const st = await statOf(abs)
    const presence = opts?.presence ?? 'any'
    if (presence === 'mustExist' && !st.exists) throw new IPCError('FS_NOT_FOUND', `文件不存在：${abs}`)
    if (presence === 'mustNotExist' && st.exists) {
      throw new IPCError('FS_STALE_VERSION', `文件已存在（presence=mustNotExist）：${abs}`)
    }
    const expected = opts?.expectedVersion
    if (typeof expected === 'string' && expected) {
      if (!st.exists) throw new IPCError('FS_STALE_VERSION', `文件已被删除：${abs}`)
      if (st.version !== expected) {
        throw new IPCError('FS_STALE_VERSION', `文件在读取之后被改过：${abs}（期望 ${expected}，实际 ${st.version ?? '未知'}）`)
      }
    }
    return st
  }

  // -------------------------------------------------------------------------
  // 「先读后写」策略（默认关；纯判定在 src/shared/fsPolicy.ts）
  //
  // 开启后：没读过就写/编辑 → FS_NOT_OBSERVED；读过则把**观察到的版本**当 expectedVersion
  // （于是"读完之后被别人改了"会以 FS_STALE_VERSION 失败）；观察到"缺失"则自动带
  // presence=mustNotExist（可以安全重建）。调用方显式给了版本 / 存在性要求时尊重调用方。
  // -------------------------------------------------------------------------

  const policyEnabled = (): boolean => isFsPolicyEnabled(deps.pluginId)
  const policyTable = () => (policyEnabled() ? observationTableOf(deps.pluginId) : undefined)

  const denyOrApply = (decision: FsPolicyDecision, targetKey: string, opts: FsWriteOptions | undefined): FsWriteOptions | undefined => {
    if (decision.kind === 'deny') throw new IPCError(decision.code, decision.message)
    if (!decision.expectedVersion && !decision.presence) return opts
    return {
      ...(opts ?? {}),
      // 调用方显式给的值优先（策略只补空缺）
      expectedVersion: opts?.expectedVersion ?? decision.expectedVersion,
      presence: opts?.presence && opts.presence !== 'any' ? opts.presence : (decision.presence ?? opts?.presence),
    }
  }

  /** 记录一次"看到了什么"（只在策略开启时才记，避免无谓内存增长） */
  const observePresent = (targetKey: string, version: string | null): void => {
    if (!policyEnabled()) return
    if (typeof version === 'string' && version) noteObserved(deps.pluginId, targetKey, { kind: 'present', version })
  }
  const observeAbsent = (targetKey: string): void => {
    if (!policyEnabled()) return
    noteObserved(deps.pluginId, targetKey, { kind: 'absent' })
  }


  /**
   * 原子写：同目录临时文件 + rename；失败回退直写（网络盘 / 跨设备时 rename 可能不支持）。
   *
   * `minMtimeMs`：把落盘后的 mtime **至少推进到它**。为什么需要：等长覆盖（自动保存最典型的
   * 形态）如果落在同一个时间戳刻度内，`size + mtime` 派生的版本**不会变**，于是"版本防护"
   * 静默失效（本仓冒烟测试实际抓到过）。用上一次 stat 的 mtime + 1ms 兜底，可保证
   * **经本 API 的每次写都产生新版本**；外部改动仍按真实 stat 检测。
   */
  const atomicWrite = async (abs: string, content: string, minMtimeMs?: number): Promise<number> => {
    const dir = path.dirname(abs)
    await fs.mkdir(dir, { recursive: true })
    const tmp = path.join(dir, `.${path.basename(abs)}.${process.pid.toString(36)}-${Date.now().toString(36)}.tmp`)
    const bytes = Buffer.byteLength(content, 'utf8')
    const bumpMtime = async (target: string): Promise<void> => {
      if (typeof minMtimeMs !== 'number' || !Number.isFinite(minMtimeMs)) return
      const st = await fs.stat(target).catch(() => null)
      if (!st || st.mtimeMs >= minMtimeMs) return
      await fs.utimes(target, st.atime, new Date(minMtimeMs)).catch(() => undefined)
    }
    try {
      await fs.writeFile(tmp, content, 'utf8')
      await bumpMtime(tmp)
      await fs.rename(tmp, abs)
      return bytes
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      try {
        await fs.writeFile(abs, content, 'utf8')
        await bumpMtime(abs)
        return bytes
      } catch {
        throw e
      }
    }
  }

  const api: PluginFsApi = {
    get available() {
      return deps.hasPermission
    },
    get reason() {
      return deps.hasPermission ? '' : `插件 ${deps.pluginId} 未声明 fs 权限（在 package.json 的 aikm.permissions 里加上 "fs"）`
    },

    resolve(input, opts) {
      return targetOf(input, opts?.cwd)
    },

    async stat(input) {
      requirePermission()
      const t = targetOf(input)
      assertReadable(t.path)
      try {
        return await statOf(t.path)
      } catch (e) {
        throw asFsError(e, 'FS_FAILED')
      }
    },

    async readText(input, opts): Promise<FsTextResult> {
      requirePermission()
      const t = targetOf(input)
      assertReadable(t.path)
      try {
        const st = await fs.stat(t.path)
        if (st.isDirectory()) throw new IPCError('FS_NOT_DIRECTORY', `目标是目录，不是文件：${t.path}`)
        const version = fsVersionOf(st.size, st.mtimeMs, st.ctimeMs)
        observePresent(t.path, version)
        if (/\.pdf$/i.test(t.path)) {
          const parsed = await readPdfText(await fs.readFile(t.path))
          return {
            path: t.path,
            text: parsed.text,
            version,
            size: st.size,
            truncated: false,
            pdf: true,
            pages: parsed.pages,
          }
        }
        const max = Math.max(1024, Math.min(Number(opts?.maxBytes) || DEFAULT_TEXT_MAX_BYTES, MAX_TEXT_MAX_BYTES))
        const buffer = await fs.readFile(t.path)
        if (looksBinary(buffer)) {
          throw new IPCError('FS_NOT_TEXT', `不是文本文件（含二进制字节）：${t.path}；请用 readBytes / readBase64，表格用 sheet.read`)
        }
        return {
          path: t.path,
          text: buffer.subarray(0, max).toString('utf8'),
          version,
          size: st.size,
          truncated: buffer.length > max,
        }
      } catch (e) {
        const err = asFsError(e, 'FS_FAILED')
        // 读一个不存在的文件 = 「确认缺失」也是一种观察（随后可以安全地新建它）
        if (err.code === 'FS_NOT_FOUND') observeAbsent(t.path)
        throw err
      }
    },

    async readBytes(input, opts) {
      requirePermission()
      const t = targetOf(input)
      assertReadable(t.path)
      try {
        const st = await fs.stat(t.path)
        if (st.isDirectory()) throw new IPCError('FS_NOT_DIRECTORY', `目标是目录，不是文件：${t.path}`)
        const max = Math.max(1024, Math.min(Number(opts?.maxBytes) || DEFAULT_BYTES_MAX, MAX_BYTES_MAX))
        if (st.size > max) throw new IPCError('FS_TOO_LARGE', `文件过大：${Math.round(st.size / 1024 / 1024)}MB（上限 ${Math.round(max / 1024 / 1024)}MB）`)
        const buffer = await fs.readFile(t.path)
        const version = fsVersionOf(st.size, st.mtimeMs, st.ctimeMs)
        observePresent(t.path, version)
        return { path: t.path, bytes: new Uint8Array(buffer), size: st.size, version }
      } catch (e) {
        const err = asFsError(e, 'FS_FAILED')
        if (err.code === 'FS_NOT_FOUND') observeAbsent(t.path)
        throw err
      }
    },

    async readBase64(input, opts) {
      requirePermission()
      const t = targetOf(input)
      assertReadable(t.path)
      try {
        const st = await fs.stat(t.path)
        if (st.isDirectory()) throw new IPCError('FS_NOT_DIRECTORY', `目标是目录，不是文件：${t.path}`)
        const max = Math.max(1024, Math.min(Number(opts?.maxBytes) || DEFAULT_BYTES_MAX, MAX_BYTES_MAX))
        if (st.size > max) throw new IPCError('FS_TOO_LARGE', `文件过大：${Math.round(st.size / 1024 / 1024)}MB（上限 ${Math.round(max / 1024 / 1024)}MB）`)
        const buffer = await fs.readFile(t.path)
        observePresent(t.path, fsVersionOf(st.size, st.mtimeMs, st.ctimeMs))
        return { path: t.path, base64: buffer.toString('base64'), size: st.size }
      } catch (e) {
        const err = asFsError(e, 'FS_FAILED')
        if (err.code === 'FS_NOT_FOUND') observeAbsent(t.path)
        throw err
      }
    },

    async listDir(input) {
      requirePermission()
      const t = targetOf(input)
      assertReadable(t.path)
      try {
        const entries = await fs.readdir(t.path, { withFileTypes: true })
        const rows: Array<{ name: string; path: string; isDir: boolean; size: number }> = []
        for (const entry of entries.slice(0, 500)) {
          const full = path.join(t.path, entry.name)
          const st = await fs.stat(full).catch(() => null)
          rows.push({ name: entry.name, path: normalizeFsPath(full), isDir: entry.isDirectory(), size: st ? st.size : 0 })
        }
        rows.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
        return { dir: t.path, entries: rows }
      } catch (e) {
        throw asFsError(e, 'FS_NOT_DIRECTORY')
      }
    },

    async writeText(input, text, opts): Promise<FsWriteResult> {
      requirePermission()
      const t = targetOf(input)
      assertWritable(t.path)
      if (typeof text !== 'string') throw new IPCError('INVALID_ARGUMENT', 'text 必须是字符串')
      try {
        const applied = policyEnabled()
          ? denyOrApply(decideWrite(policyTable(), t.path, { expectedVersion: opts?.expectedVersion, presence: opts?.presence }), t.path, opts)
          : opts
        const before = await assertVersion(t.path, applied)
        const bytes = await atomicWrite(t.path, text, before.exists ? before.mtimeMs + 1 : undefined)
        const st = await statOf(t.path)
        observePresent(t.path, st.version)
        return { path: t.path, bytes, version: st.version }
      } catch (e) {
        throw asFsError(e, 'FS_FAILED')
      }
    },

    async editText(input, edits: FsEdit[], opts): Promise<FsEditResult> {
      requirePermission()
      const t = targetOf(input)
      assertWritable(t.path)
      try {
        const applied = policyEnabled()
          ? denyOrApply(decideEdit(policyTable(), t.path, { expectedVersion: opts?.expectedVersion }), t.path, opts)
          : opts
        const st = await assertVersion(t.path, applied)
        if (!st.exists) throw new IPCError('FS_NOT_FOUND', `文件不存在：${t.path}`)
        const buffer = await fs.readFile(t.path)
        if (looksBinary(buffer)) throw new IPCError('FS_NOT_TEXT', `不是文本文件：${t.path}`)
        const plan = applyLiteralEdits(buffer.toString('utf8'), edits)
        // 主进程 tsconfig 未开 strictNullChecks：判别式联合不会自动收窄，显式转一次
        if (!plan.ok) {
          const failure = plan as Extract<typeof plan, { ok: false }>
          throw new IPCError(failure.code, failure.message)
        }
        const bytes = await atomicWrite(t.path, plan.text, st.exists ? st.mtimeMs + 1 : undefined)
        const after = await statOf(t.path)
        observePresent(t.path, after.version)
        return { path: t.path, applied: plan.applied, bytes, version: after.version }
      } catch (e) {
        throw asFsError(e, 'FS_FAILED')
      }
    },

    async remove(input, opts) {
      requirePermission()
      const t = targetOf(input)
      assertWritable(t.path)
      try {
        const applied = policyEnabled()
          ? denyOrApply(decideRemove(policyTable(), t.path, { expectedVersion: opts?.expectedVersion }), t.path, opts)
          : opts
        const st = await assertVersion(t.path, applied)
        if (!st.exists) return { removed: false, missing: true }
        if (st.isDir) await fs.rmdir(t.path) // 非空会抛错：刻意不做递归删除
        else await fs.unlink(t.path)
        observeAbsent(t.path)
        return { removed: true }
      } catch (e) {
        throw asFsError(e, 'FS_FAILED')
      }
    },

    sheet: {
      async read(input, opts) {
        requirePermission()
        const t = targetOf(input)
        assertReadable(t.path)
        if (!/\.(xlsx|xls|csv)$/i.test(t.path)) {
          throw new IPCError('INVALID_ARGUMENT', '仅支持 .xlsx / .xls / .csv（其它格式请用 readText / readBytes）')
        }
        try {
          return await readSheetFile(t.path, opts)
        } catch (e) {
          throw asFsError(e, 'FS_FAILED')
        }
      },
    },
  }

  return api
}
