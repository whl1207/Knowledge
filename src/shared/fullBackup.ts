/**
 * fullBackup.ts — 「一键备份」文件的解析（纯函数，可自测）
 *
 * 一个备份文件现在同时带配置（`data`）与聊天记录（`chats`）。历史文件有三种形态，都必须认：
 * 1. 一键备份：`{ kind: 'full', data: {...}, chats: [...] }`
 * 2. 旧的配置备份：`{ kind: 'backup', data: {...} }`（没有 chats）
 * 3. 旧的聊天导出：`{ kind: 'chats', chats: [...] }` 或裸数组 `[...]`
 *
 * 这里只做「认文件 + 取出两个块」，不碰 localStorage / store；
 * 写入与提示由 `src/lib/settingsData.ts` 的 importFullBackup 负责。
 */

export interface BackupParts {
  /** 文件自报的 kind（没有则为空串；不参与判定，仅用于诊断） */
  kind: string
  /** 配置块（`data` 字段），没有则为 null */
  config: Record<string, any> | null
  /** 聊天块（`chats` 字段或裸数组，已过滤非法条目），没有则为 null */
  chats: any[] | null
}

/** 普通对象（排除 null / 数组） */
const isPlainObject = (v: any): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** 有效聊天条目：带 messages 或 config 的对象（与聊天记录导入同一口径） */
export const isChatEntry = (c: any): boolean =>
  isPlainObject(c) && (Array.isArray(c.messages) || !!c.config)

/**
 * 解析备份文本：
 * - 不是 JSON → 抛错（调用方提示「不是有效的备份文件」）；
 * - 是 JSON 但不是备份 → 返回 config / chats 都为 null（调用方据此提示没有可恢复内容）。
 */
export const parseBackupText = (text: string): BackupParts => {
  const parsed = JSON.parse(text)
  const parts: BackupParts = { kind: '', config: null, chats: null }
  if (Array.isArray(parsed)) {
    parts.chats = parsed.filter(isChatEntry)
    return parts
  }
  if (!isPlainObject(parsed)) return parts
  if (typeof parsed.kind === 'string') parts.kind = parsed.kind
  // 空 data 对象等于没有配置：不当作可恢复内容，避免「恢复成功但什么都没变」
  if (isPlainObject(parsed.data) && Object.keys(parsed.data).length) parts.config = parsed.data
  if (Array.isArray(parsed.chats)) parts.chats = parsed.chats.filter(isChatEntry)
  return parts
}
