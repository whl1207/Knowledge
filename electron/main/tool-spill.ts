/**
 * tool-spill.ts — 超大工具结果落盘（复刻 DSH 的 `dsh-spill-local`）
 *
 * 目的：让第一层的"掐中段"从**有损**变成**可回读**。工具结果超过
 * `TOOL_RESULT_SPILL_THRESHOLD_CHARS` 时：
 *   1. 完整序列化文本写到会话私有的 spill 目录；
 *   2. 模型只收到"头 + 尾 + 定位提示"（提示里给出绝对路径与回读方法）；
 *   3. 模型需要完整内容时用 `read_file` 打开该路径（可 offset/limit 分段读）。
 *
 * 与 DSH `dsh-spill-local` 对齐的几处关键取舍：
 * - **落在系统临时目录**（`mkdtemp(tmpdir()/aikm-spill-XXXX)`）而不是用户数据目录：
 *   spill 是**缓存**，丢了不影响正确性（模型会拿到"文件已失效"的明确报错并重跑工具），
 *   所以不占用户数据空间，也随系统清理。
 * - **会话私有子目录** `session-<sha256(sessionId)[0:12]>`：不同会话的产物不混在一起。
 * - **0600 + `wx` 独占写**：避免符号链接预置（DSH 同样用 `open(path, "wx", 384)`）。
 * - **best-effort**：写盘失败只告警并回退到"只有预览"，**绝不**把一次成功的工具调用变成失败
 *   （DSH 的 spill-policy 注释写得很清楚：a spill failure must NEVER turn a successful
 *   tool call into an isError）。
 * - **过期清扫**：启动时 best-effort 清理超过 `RETENTION_DAYS` 的旧目录。
 *
 * 只在桌面主进程使用。渲染层（手机 / 网页）没有可写文件系统，能力缺失时由
 * `agent-loop` 直接降级为"仅预览"。
 */

import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** spill 根目录前缀（清扫时按此前缀 + 随机后缀匹配，避免误删别的临时目录） */
const SPILL_ROOT_PREFIX = 'aikm-spill-'
/** 根目录随机后缀长度（与 DSH 的 `^dsh-spill-[A-Za-z0-9]{6}$` 同构） */
const ROOT_SUFFIX_LEN = 6
/** 保留天数：超过则启动时清扫 */
const RETENTION_DAYS = 30

/** 一次落盘的结果 */
export interface SpillSaveResult {
  /** 可直接交给 read_file 的绝对路径 */
  path: string
  /** 写入的字节数 */
  bytes: number
}

/** 文件名安全化：去掉路径分隔符与控制字符，限长 */
export function safeSpillFileName(name: string): string {
  const cleaned = String(name || 'result.txt')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 120)
  return cleaned.length > 0 ? cleaned : 'result.txt'
}

/** 会话私有目录名：`session-<sha256(sessionId)[0:12]>`（与 DSH 同构，避免路径注入） */
export function spillSessionDirName(sessionId: string): string {
  const hash = createHash('sha256').update(String(sessionId || 'unknown')).digest('hex').slice(0, 12)
  return `session-${hash}`
}

let cachedRoot: string | null = null

/** 取（必要时创建）spill 根目录；失败返回 null（调用方降级为仅预览） */
function spillRoot(): string | null {
  if (cachedRoot) return cachedRoot
  try {
    const root = fs.mkdtempSync(join(tmpdir(), SPILL_ROOT_PREFIX))
    // mkdtemp 默认 0700（私有），与 DSH 一致
    cachedRoot = root
    return root
  } catch {
    return null
  }
}

/**
 * 落盘一段完整文本。
 *
 * @param sessionId 归属会话（决定子目录）
 * @param suggestedName 建议文件名（如 `shell.txt`）
 * @param text 完整文本
 * @returns 落盘位置；失败返回 null（调用方必须降级，不要抛错打断工具链）
 */
export function saveSpillText(sessionId: string, suggestedName: string, text: string): SpillSaveResult | null {
  const root = spillRoot()
  if (!root) return null
  try {
    const dir = join(root, spillSessionDirName(sessionId))
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const fileName = `${randomBytes(6).toString('hex')}-${safeSpillFileName(suggestedName)}`
    const file = join(dir, fileName)
    // wx：独占创建（已存在则失败），mode 0600
    const fd = fs.openSync(file, 'wx', 0o600)
    try {
      const buf = Buffer.from(text, 'utf8')
      fs.writeSync(fd, buf)
      return { path: file, bytes: buf.byteLength }
    } finally {
      fs.closeSync(fd)
    }
  } catch (e: any) {
    console.warn('[tool-spill] 落盘失败，降级为仅有预览:', e?.message || String(e))
    return null
  }
}

/** 读取已落盘的原文（供"展开查看"这类需要完整内容的功能用；失败返回 null） */
export function readSpillText(path: string): string | null {
  try {
    return fs.readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * 启动时 best-effort 清扫过期 spill 目录。
 *
 * 只删除**形如** `aikm-spill-<6 位字母数字>` 的目录，其余一律不动——
 * 与 DSH 的清扫实现同一策略（宁可漏删，不可误删）。
 */
export function cleanupSpillDirs(maxAgeDays = RETENTION_DAYS): number {
  let removed = 0
  try {
    const base = tmpdir()
    const cutoff = Date.now() - Math.max(0, maxAgeDays) * 24 * 60 * 60 * 1000
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (!new RegExp(`^${SPILL_ROOT_PREFIX}[A-Za-z0-9]{${ROOT_SUFFIX_LEN}}$`).test(entry.name)) continue
      const full = join(base, entry.name)
      try {
        const stat = fs.statSync(full)
        if (stat.mtimeMs >= cutoff) continue
        fs.rmSync(full, { recursive: true, force: true })
        removed++
      } catch {
        /* 单个目录清理失败不影响其它 */
      }
    }
  } catch {
    /* 清扫是 best-effort：失败静默 */
  }
  return removed
}
