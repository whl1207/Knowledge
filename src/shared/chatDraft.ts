/**
 * chatDraft.ts — 聊天输入框草稿：**按聊天各自保存**（与 DSH 一致：每个消息栏管自己的输入框）
 *
 * 存在哪里：草稿就是聊天对象自己的 `draft` 字段，随聊天记录一起持久化。
 * 于是「切聊天 / 切模块（home 被卸载）/ 重启应用」三种场景共用同一份数据，
 * 不需要额外的存储键，也不会出现「两份草稿谁为准」的问题。
 *
 * 为什么抽成纯函数：输入框的每一次读写都经过这里，「切聊天不串栏」是最容易回归的行为，
 * 抽成不依赖 Vue / DOM 的纯函数后可直接跑自测（见 chatDraft.selftest.ts）。
 */

/** 能承载草稿的聊天：只描述本模块需要的形状，避免 shared 依赖 types/chat */
export interface DraftChat {
  id?: string
  draft?: string
}

/** 读：第 index 个聊天的草稿（列表为空 / 越界 / 该栏不存在 → 空串） */
export function readChatDraft(
  chats: readonly (DraftChat | undefined)[] | null | undefined,
  index: number,
): string {
  if (!chats || index < 0 || index >= chats.length) return ''
  return chats[index]?.draft ?? ''
}

/**
 * 写：把内容写回第 index 个聊天的草稿。
 * 返回是否真的写入（列表为空 / 越界 / 该栏不存在时返回 false，调用方无需先判断越界）。
 */
export function writeChatDraft(
  chats: (DraftChat | undefined)[] | null | undefined,
  index: number,
  value: string,
): boolean {
  if (!chats || index < 0 || index >= chats.length) return false
  const chat = chats[index]
  if (!chat) return false
  chat.draft = value
  return true
}

/**
 * 按 id 找聊天，找不到时退回第 fallbackIndex 栏。
 * 用于「归属聊天在动作开始时就锁定」的场景（如语音输入：录音中切走，结果仍写回原来那一栏）。
 */
export function resolveDraftChat<T extends DraftChat>(
  chats: readonly (T | undefined)[] | null | undefined,
  chatId: string,
  fallbackIndex: number,
): T | undefined {
  if (!chats || chats.length === 0) return undefined
  if (chatId) {
    const hit = chats.find((c) => c && String(c.id ?? '') === chatId)
    if (hit) return hit
  }
  return fallbackIndex >= 0 && fallbackIndex < chats.length ? (chats[fallbackIndex] as T | undefined) : undefined
}

/**
 * 语音识别的接续规则：把新识别出的一句接到已有内容后面。
 * 已有内容不以空格结尾时补一个空格，避免连续两句粘成一个词；空内容直接给结果。
 */
export function joinAsrText(current: string, text: string): string {
  if (!current) return text
  if (!text) return current
  return current.endsWith(' ') ? `${current}${text}` : `${current} ${text}`
}
