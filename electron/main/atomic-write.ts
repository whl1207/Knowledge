/**
 * atomic-write.ts — 原子写文件的公共实现（主进程）
 *
 * 为什么需要：直接 `fs.writeFileSync` 写到一半崩溃 / 断电，会留下**半截文件**；
 * 读到半截 JSON / 源码的用户看到的不是"写失败"，而是"文件坏了"。原子写保证读方
 * 只会看到旧内容或完整新内容。
 *
 * 实现对齐 DSH 的 `dsh-atomic-write`（以及本仓 `plugin-fs.ts` 里既有的那份）：
 * - 同目录临时文件（`wx` 语义由随机名 + 独占写入近似）+ `rename` 覆盖；
 * - 同目录保证 rename 落在同一文件系统；
 * - Windows 上 `EACCES` / `EBUSY` / `EPERM` 常见于杀毒 / 索引器瞬时占用目标，做有界重试；
 * - rename 失败（网络盘 / 跨设备）回退为直接写目标，至少不让调用方直接失败；
 * - 保留原文件权限位（有的话），避免 rename 出新 inode 后权限被 umask 放宽 / 收紧；
 * - **不做 fsync**：不承诺崩溃持久性（与 DSH 一致）。
 *
 * 两阶段 API（`stageWrite` / `commitStagedWrite` / `discardStagedWrite`）供**多文件批量**
 * 使用：`multi_replace` 要求"整批生效或整批不动"，逐文件 `atomicWrite` 做不到——第 2 个
 * 文件写失败时第 1 个已经落盘了。批量流程是：先把 N 份内容全部写成临时文件（这一步失败
 * 只清理临时文件，目标一个都没动），再逐个 rename（这一步只剩极短的窗口）。
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'

/** Windows 上目标被瞬时占用时的 rename 重试间隔（毫秒） */
const RENAME_RETRY_DELAYS = [10, 30, 80]

function isTransientRenameError(err: unknown): boolean {
  const code = String((err as any)?.code || '')
  return code === 'EACCES' || code === 'EBUSY' || code === 'EPERM'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 一批写入里的一份：临时文件 + 待写内容（内容留着，rename 失败时要回退直写） */
export interface StagedWrite {
  /** 目标绝对路径 */
  abs: string
  /** 同目录临时文件路径 */
  tmp: string
  /** 待写入的完整内容 */
  content: string
  /** UTF-8 字节数 */
  bytes: number
}

/**
 * 落盘校验失败：目标文件的字节数与预期不符（磁盘已满 / 网络盘截断 / 被其它程序改写）。
 *
 * 为什么要单独一类错误：这种失败意味着**盘上是一份坏文件**，调用方要做的不是"重试"，
 * 而是回滚或明确告知；与普通的 rename 失败（可直接回退直写）必须区分开。
 */
export class WriteVerifyError extends Error {
  readonly code = 'WRITE_VERIFY_FAILED'
  constructor(message: string) {
    super(message)
    this.name = 'WriteVerifyError'
  }
}

/** 落盘后按字节数复核（rename 成功 ≠ 内容完整：网络盘 / 磁盘满都能悄悄截断） */
async function verifyWrittenBytes(abs: string, expected: number): Promise<void> {
  const st = await fsp.stat(abs)
  if (st.size !== expected) {
    throw new WriteVerifyError(
      `写入校验失败：${abs} 实际 ${st.size} 字节，应为 ${expected} 字节（磁盘已满或被其它程序截断）`,
    )
  }
}

/**
 * 阶段一：把内容写成**同目录临时文件**（目标文件保持原样）。
 *
 * @param abs 目标绝对路径
 * @param content UTF-8 文本
 * @param opts.minMtimeMs 落盘后把 mtime **至少**推进到它（等长覆盖时保证版本变化）
 * @param opts.preserveMode 是否保留目标原权限位（默认 true）
 */
export async function stageWrite(
  abs: string,
  content: string,
  opts: { minMtimeMs?: number; preserveMode?: boolean } = {},
): Promise<StagedWrite> {
  const dir = path.dirname(abs)
  await fsp.mkdir(dir, { recursive: true })
  const tmp = path.join(
    dir,
    `.${path.basename(abs)}.${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`,
  )
  const bytes = Buffer.byteLength(content, 'utf8')

  // 保留原权限位：rename 会换 inode，不显式带上 mode 就会被 umask 重置。
  let mode: number | undefined
  if (opts.preserveMode !== false) {
    try {
      mode = (await fsp.stat(abs)).mode & 0o777
    } catch {
      /* 新文件：交给默认权限 */
    }
  }

  const writeOpts: { encoding: 'utf8'; mode?: number } = { encoding: 'utf8' }
  if (mode !== undefined) writeOpts.mode = mode

  try {
    await fsp.writeFile(tmp, content, writeOpts)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }

  await bumpMtime(tmp, opts.minMtimeMs)
  return { abs, tmp, content, bytes }
}

/** 阶段二：把临时文件 rename 到目标（瞬时失败有界重试；彻底失败回退直写） */
export async function commitStagedWrite(staged: StagedWrite): Promise<void> {
  const { abs, tmp } = staged
  let lastError: unknown
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS.length; attempt++) {
    try {
      await fsp.rename(tmp, abs)
      await verifyWrittenBytes(abs, staged.bytes)
      return
    } catch (err) {
      // 校验失败说明盘上已经是坏文件：再重试/回退直写都只会更糟，直接抛给调用方回滚
      if (err instanceof WriteVerifyError) throw err
      lastError = err
      if (!isTransientRenameError(err) || attempt === RENAME_RETRY_DELAYS.length) break
      await sleep(RENAME_RETRY_DELAYS[attempt])
    }
  }

  // rename 失败：清掉临时文件，回退直写（网络盘 / 跨设备 / 目标被独占但可写）。
  await fsp.rm(tmp, { force: true }).catch(() => undefined)
  try {
    await fsp.writeFile(abs, staged.content, 'utf8')
  } catch {
    throw lastError
  }
  await verifyWrittenBytes(abs, staged.bytes)
}

/** 放弃一份暂存写入（批量失败时清理，目标文件不受影响） */
export async function discardStagedWrite(staged: StagedWrite): Promise<void> {
  await fsp.rm(staged.tmp, { force: true }).catch(() => undefined)
}

/** 提交一份暂存写入：先做乐观并发比对（版本），再 rename；版本不符时丢弃暂存、目标不动 */
export type CheckedCommitResult =
  | { ok: true }
  | { ok: false; reason: 'stale' | 'missing' | 'verify' | 'io'; message: string }

/**
 * 带版本校验的提交（乐观并发，口径同 DSH 的 `replaceIfVersion`）。
 *
 * @param staged 已暂存的内容
 * @param expectedVersion 读取时记下的版本；与当前目标不一致 → 放弃本次写入
 * @param versionOf 由 stat 派生版本串（调用方与"读取时记版本"必须是同一个函数）
 */
export async function commitStagedChecked(
  staged: StagedWrite,
  expectedVersion: string,
  versionOf: (st: { size: number; mtimeMs: number; ctimeMs: number }) => string,
): Promise<CheckedCommitResult> {
  let currentVersion = ''
  try {
    currentVersion = versionOf(await fsp.stat(staged.abs))
  } catch {
    await discardStagedWrite(staged)
    return { ok: false, reason: 'missing', message: '目标文件在写入前被删除' }
  }
  if (currentVersion !== expectedVersion) {
    await discardStagedWrite(staged)
    return { ok: false, reason: 'stale', message: '文件在你读取之后已被修改（版本已变化）' }
  }
  try {
    await commitStagedWrite(staged)
    return { ok: true }
  } catch (e: any) {
    // 校验失败时盘上已经是坏文件，调用方要回滚而不是"重试"
    if (e instanceof WriteVerifyError) return { ok: false, reason: 'verify', message: e.message }
    return { ok: false, reason: 'io', message: e?.message || String(e) }
  }
}

/** 创建式提交：目标已存在时不覆盖（口径同 DSH 的 `createIfAbsent`） */
export type CreateCommitResult = { ok: true } | { ok: false; reason: 'exists' | 'verify' | 'io'; message: string }

/**
 * 只在目标**不存在**时落盘（原子）：
 * 用同目录硬链接把临时文件挂到目标名上——目标已存在时链接直接失败，
 * 不存在时这一步本身是原子的，因此不会出现"检查时不存在、写时把别人刚建的文件盖掉"。
 *
 * 不支持硬链接的文件系统（部分网络盘 / 容器卷）回退为"再 stat 一次 + rename"，
 * 牺牲一点原子性换取可用性；回退路径的竞态窗口只有几微秒。
 */
export async function commitStagedCreateIfAbsent(staged: StagedWrite): Promise<CreateCommitResult> {
  try {
    await fsp.link(staged.tmp, staged.abs)
  } catch (e: any) {
    if (isExistsError(e)) {
      await discardStagedWrite(staged)
      return { ok: false, reason: 'exists', message: '文件已存在（可能刚被其它程序 / 另一个 agent 创建）' }
    }
    // 硬链接不可用：退回"确认不存在再 rename"
    try {
      await fsp.stat(staged.abs)
      await discardStagedWrite(staged)
      return { ok: false, reason: 'exists', message: '文件已存在（可能刚被其它程序 / 另一个 agent 创建）' }
    } catch {
      try {
        await commitStagedWrite(staged)
        return { ok: true }
      } catch (err: any) {
        if (err instanceof WriteVerifyError) return { ok: false, reason: 'verify', message: err.message }
        return { ok: false, reason: 'io', message: err?.message || String(err) }
      }
    }
  }

  // 链接成功：目标与临时文件指向同一 inode，删掉临时名即可
  await fsp.rm(staged.tmp, { force: true }).catch(() => undefined)
  try {
    await verifyWrittenBytes(staged.abs, staged.bytes)
    return { ok: true }
  } catch (e: any) {
    if (e instanceof WriteVerifyError) return { ok: false, reason: 'verify', message: e.message }
    return { ok: false, reason: 'io', message: e?.message || String(e) }
  }
}

/** 目标已存在（EEXIST / EPERM 视平台而定） */
function isExistsError(err: unknown): boolean {
  const code = String((err as any)?.code || '')
  return code === 'EEXIST'
}

/** 把 mtime 至少推进到 `minMtimeMs`（等长覆盖也能产生新版本，版本防护不会静默失效） */
async function bumpMtime(target: string, minMtimeMs?: number): Promise<void> {
  if (typeof minMtimeMs !== 'number' || !Number.isFinite(minMtimeMs)) return
  const st = await fsp.stat(target).catch(() => null)
  if (!st || st.mtimeMs >= minMtimeMs) return
  await fsp.utimes(target, st.atime, new Date(minMtimeMs)).catch(() => undefined)
}

/**
 * 原子写（单文件便捷入口）：stage + commit。
 *
 * @returns 写入的 UTF-8 字节数
 */
export async function atomicWrite(
  abs: string,
  content: string,
  opts: { minMtimeMs?: number; preserveMode?: boolean } = {},
): Promise<number> {
  const staged = await stageWrite(abs, content, opts)
  await commitStagedWrite(staged)
  return staged.bytes
}
