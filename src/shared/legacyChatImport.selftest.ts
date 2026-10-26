/**
 * legacyChatImport.selftest.ts — 旧版 ai-chats JSON 的解析/归一化
 */

import { normalizeLegacyChat, parseLegacyChatsFile } from './legacyChatImport'

export interface LegacyChatImportCase { name: string; ok: boolean; detail?: string }

const now = 1_700_000_000_000

function oldChat(over: any = {}) {
  return {
    id: 'old-1',
    title: '',
    mode: 'skill',
    config: { llmType: 'ollama', model: 'qwen', kbPath: '/kb/a.kb' },
    messages: [
      { role: 'user', content: '你好', timestamp: 1 },
      {
        role: 'assistant',
        content: '',
        timestamp: 2,
        isSkillRunning: true,
        skillName: 'demo',
        skillSteps: [{ id: 's1', status: 'success', type: 'tool', description: '读文件', result: 'ok' }],
        agentViewId: 'agent-old',
      },
    ],
    ...over,
  }
}

export function runLegacyChatImportSelfTest(): LegacyChatImportCase[] {
  const cases: LegacyChatImportCase[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  const chat = normalizeLegacyChat(oldChat(), 0, now)
  add('裸数组：可归一化', !!chat)
  add('mode=skill → agent2', chat?.mode === 'agent2')
  add('skillSteps → executionUnits', Array.isArray(chat?.messages?.[1]?.executionUnits) && chat.messages[1].executionUnits.length === 1)
  add('旧执行中 → isExecuting=false', chat?.messages?.[1]?.isExecuting === false)
  add('旧执行中且无正文 → 补中断提示', String(chat?.messages?.[1]?.content || '').includes('中断'))
  add('agentViewId 被移除', chat?.messages?.[1]?.agentViewId === undefined)
  add('不接管旧 agent 会话', chat?.agentSessionId === null && chat?.agentSessionSignature === null)
  add('补默认 config.kbTopK', chat?.config?.kbTopK === 5)
  add('空标题用首条用户消息', String(chat?.title || '').includes('你好'))

  const raw = parseLegacyChatsFile(JSON.stringify([oldChat()]), now)
  add('裸数组解析：1 条', raw.chats.length === 1 && raw.invalid === 0)

  const pack = parseLegacyChatsFile(JSON.stringify({ app: 'ai-km', kind: 'chats', chats: [oldChat()] }), now)
  add('当前导出包解析：1 条', pack.chats.length === 1)

  const backup = parseLegacyChatsFile(JSON.stringify({
    app: 'ai-km', kind: 'backup', data: { 'ai-chats': [oldChat({ id: 'old-2' })] },
  }), now)
  add('旧整包备份 data["ai-chats"] 解析：1 条', backup.chats.length === 1 && backup.chats[0].id === 'old-2')

  const keyed = parseLegacyChatsFile(JSON.stringify({ chats: { a: oldChat({ id: 'a' }), b: oldChat({ id: 'b' }) } }), now)
  add('id-keyed 对象解析：2 条', keyed.chats.length === 2)

  const mixed = parseLegacyChatsFile(JSON.stringify([oldChat({ id: 'x' }), { nope: true }, oldChat({ id: 'x' })]), now)
  add('无效条目跳过', mixed.invalid === 1 && mixed.chats.length === 2)
  add('重复 id 去重', new Set(mixed.chats.map((c: any) => c.id)).size === mixed.chats.length)

  let threw = false
  try { parseLegacyChatsFile('{"foo":1}', now) } catch { threw = true }
  add('无法识别的结构抛错', threw)

  return cases
}
