/**
 * fullBackup.selftest.ts — 「一键备份」文件解析的自测
 *
 * 覆盖：一键备份（配置 + 聊天）、旧配置备份（只有 data）、旧聊天导出（chats / 裸数组）、
 * 非法条目过滤、非备份 JSON、非 JSON 文本（抛错）。
 */

import { isChatEntry, parseBackupText } from '@/shared/fullBackup'

export interface SelfTestCase {
  name: string
  ok: boolean
  detail?: string
}

export function runFullBackupSelfTest(): SelfTestCase[] {
  const cases: SelfTestCase[] = []
  const check = (name: string, ok: boolean, detail?: string) =>
    cases.push({ name, ok, ...(detail ? { detail } : {}) })

  // ---- 一键备份：配置 + 聊天 ----
  const full = parseBackupText(JSON.stringify({
    app: 'ai-km', kind: 'full', version: 1,
    data: { AIconfig: { temperature: 0.3 }, pythonSandbox: 'trusted' },
    chats: [{ id: 'c1', messages: [] }, { id: 'c2', config: {} }],
  }))
  check('full：kind 保留', full.kind === 'full', full.kind)
  check('full：配置块取出', !!full.config && full.config.pythonSandbox === 'trusted')
  check('full：聊天块取出 2 条', full.chats?.length === 2, String(full.chats?.length))

  // ---- 旧配置备份：只有 data ----
  const cfgOnly = parseBackupText(JSON.stringify({ app: 'ai-km', kind: 'backup', data: { UI: { theme: 'dark' } } }))
  check('旧配置备份：没有聊天块', cfgOnly.chats === null)
  check('旧配置备份：配置仍在', !!cfgOnly.config && !!cfgOnly.config.UI)

  // ---- 旧聊天导出：chats 字段 ----
  const chatOnly = parseBackupText(JSON.stringify({ app: 'ai-km', kind: 'chats', chats: [{ id: 'c9', messages: [{ role: 'user' }] }] }))
  check('旧聊天导出：没有配置块', chatOnly.config === null)
  check('旧聊天导出：聊天 1 条', chatOnly.chats?.length === 1)

  // ---- 裸数组（最老的导出）----
  const bare = parseBackupText(JSON.stringify([{ id: 'a', config: {} }, { id: 'b', messages: [] }]))
  check('裸数组：按聊天块解析', bare.chats?.length === 2 && bare.config === null)

  // ---- 非法条目被过滤 ----
  const dirty = parseBackupText(JSON.stringify({
    data: {}, chats: [null, 'x', { foo: 1 }, { id: 'ok', messages: [] }],
  }))
  check('聊天块过滤非法条目', dirty.chats?.length === 1 && dirty.chats[0].id === 'ok')
  check('空配置块不被当作可恢复配置', parseBackupText(JSON.stringify({ data: {} })).config === null)

  // ---- 不是备份的 JSON ----
  const junk = parseBackupText(JSON.stringify({ hello: 'world' }))
  check('非备份 JSON：两块都为空', junk.config === null && junk.chats === null)

  // ---- 不是 JSON：必须抛错 ----
  let threw = false
  try { parseBackupText('not json') } catch { threw = true }
  check('非 JSON 文本抛错', threw)

  // ---- 聊天条目判定 ----
  check('isChatEntry：messages 数组算聊天', isChatEntry({ messages: [] }) === true)
  check('isChatEntry：config 算聊天', isChatEntry({ config: {} }) === true)
  check('isChatEntry：无 messages / config 不算', isChatEntry({ id: 'x' }) === false)

  return cases
}
