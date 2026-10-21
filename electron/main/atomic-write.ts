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

/**
 * 原子写：写同目录临时文件 → rename 覆盖目标。
 *
 * @param abs 目标绝对路径
 * @param content UTF-8 文本
 * @param opts.minMtimeMs 落盘后把 mtime **至少**推进到它（等长覆盖时保证版本变化）
 * @param opts.preserveMode 是否保留目标原权限位（默认 true）
 * @returns 写入的 UTF-8 字节数
 */
export async function atomicWrite(
  abs: string,
  content: string,
  opts: { minMtimeMs?: number; preserveMode?: boolean } = {},
): Promise<number> {
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

  const bumpMtime = async (target: string): Promise<void> => {
    if (typeof opts.minMtimeMs !== 'number' || !Number.isFinite(opts.minMtimeMs)) return
    const st = await fsp.stat(target).catch(() => null)
    if (!st || st.mtimeMs >= opts.minMtimeMs) return
    await fsp.utimes(target, st.atime, new Date(opts.minMtimeMs)).catch(() => undefined)
  }

  const writeOpts: { encoding: 'utf8'; mode?: number } = { encoding: 'utf8' }
  if (mode !== undefined) writeOpts.mode = mode

  try {
    await fsp.writeFile(tmp, content, writeOpts)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }

  await bumpMtime(tmp)

  let lastError: unknown
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS.length; attempt++) {
    try {
      await fsp.rename(tmp, abs)
      return bytes
    } catch (err) {
      lastError = err
      if (!isTransientRenameError(err) || attempt === RENAME_RETRY_DELAYS.length) break
      await sleep(RENAME_RETRY_DELAYS[attempt])
    }
  }

  // rename 失败：清掉临时文件，回退直写（网络盘 / 跨设备 / 目标被独占但可写）。
  await fsp.rm(tmp, { force: true }).catch(() => undefined)
  try {
    await fsp.writeFile(abs, content, 'utf8')
    await bumpMtime(abs)
    return bytes
  } catch {
    throw lastError
  }
}
