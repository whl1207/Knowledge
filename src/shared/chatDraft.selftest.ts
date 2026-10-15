/**
 * chatDraft.selftest.ts — 输入框草稿「按聊天隔离」自测（纯计算，不依赖 Vue / DOM）
 *
 * 覆盖：各聊天的草稿互不覆盖（核心需求）、越界安全、切走再切回仍是自己那份、
 * 清空其中一栏不影响别人、id 定位（语音输入锁定的归属聊天）、语音接续的空格规则、
 * 以及「草稿在聊天对象上 → 序列化后仍在」（切模块 / 重启可恢复的依据）。
 *
 * 用法（开发期）：
 *   import { runChatDraftSelfTest } from '@/shared/chatDraft.selftest'
 *   console.table(runChatDraftSelfTest())
 * 或命令行：`node scripts/run-selftests.mjs chatDraft`
 */

import { joinAsrText, readChatDraft, resolveDraftChat, writeChatDraft, type DraftChat } from './chatDraft'

export interface ChatDraftCase {
  name: string
  ok: boolean
  detail?: string
}

/** 造一栏聊天（只带本模块关心的字段） */
function chat(id: string, draft?: string): DraftChat {
  return { id, draft }
}

export function runChatDraftSelfTest(): ChatDraftCase[] {
  const cases: ChatDraftCase[] = []
  const add = (name: string, ok: boolean, detail = '') => cases.push({ name, ok, detail })

  // 1. 读：空列表 / 越界 / 该栏不存在 → 空串（不抛错）
  add('读：空列表返回空串', readChatDraft([], 0) === '')
  add('读：负索引返回空串', readChatDraft([chat('a', 'x')], -1) === '')
  add('读：越界返回空串', readChatDraft([chat('a', 'x')], 5) === '')
  add('读：无 draft 字段返回空串', readChatDraft([chat('a')], 0) === '')

  // 2. 核心需求：三个聊天各写各的，互不覆盖
  {
    const chats = [chat('a'), chat('b'), chat('c')]
    writeChatDraft(chats, 0, 'A 的问题')
    writeChatDraft(chats, 1, 'B 的问题')
    writeChatDraft(chats, 2, 'C 的问题')
    add('隔离：三栏内容各自独立', readChatDraft(chats, 0) === 'A 的问题'
      && readChatDraft(chats, 1) === 'B 的问题'
      && readChatDraft(chats, 2) === 'C 的问题',
      `${readChatDraft(chats, 0)}|${readChatDraft(chats, 1)}|${readChatDraft(chats, 2)}`)
    add('隔离：草稿落在各自聊天对象上', chats[0].draft === 'A 的问题' && chats[2].draft === 'C 的问题')

    // 切到 B 继续追加，不碰 A
    writeChatDraft(chats, 1, `${readChatDraft(chats, 1)} + 补充`)
    add('隔离：改写 B 不影响 A', readChatDraft(chats, 0) === 'A 的问题', readChatDraft(chats, 0))
    add('隔离：改写 B 生效', readChatDraft(chats, 1) === 'B 的问题 + 补充', readChatDraft(chats, 1))

    // 清空 B（发送后清输入框），A / C 不受影响
    writeChatDraft(chats, 1, '')
    add('隔离：清空 B 不影响 A / C', readChatDraft(chats, 1) === '' && readChatDraft(chats, 0) === 'A 的问题' && readChatDraft(chats, 2) === 'C 的问题')
  }

  // 3. 模拟「切走再切回」：currentIndex 变了，读到的仍是原来那栏
  {
    const chats = [chat('a'), chat('b')]
    let current = 0
    writeChatDraft(chats, current, '第一栏没发完')
    current = 1
    add('切栏：新栏是空的（不继承上一栏）', readChatDraft(chats, current) === '')
    writeChatDraft(chats, current, '第二栏内容')
    current = 0
    add('切回：第一栏还是自己那份', readChatDraft(chats, current) === '第一栏没发完', readChatDraft(chats, current))
    current = 1
    add('再切：第二栏也还在', readChatDraft(chats, current) === '第二栏内容', readChatDraft(chats, current))
  }

  // 4. 写：越界 / 空位不抛错，返回 false
  {
    const chats = [chat('a')]
    add('写：越界返回 false 且不改动', writeChatDraft(chats, 3, 'x') === false && chats[0].draft === undefined)
    add('写：空栏返回 false', writeChatDraft([undefined], 0, 'x') === false)
    add('写：合法位置返回 true', writeChatDraft(chats, 0, 'ok') === true && chats[0].draft === 'ok')
  }

  // 5. 按 id 定位（语音输入在录音开始时锁定归属聊天）
  {
    const chats: DraftChat[] = [chat('a', '甲'), chat('b', '乙')]
    add('定位：按 id 命中目标栏', resolveDraftChat(chats, 'b', 0)?.draft === '乙')
    add('定位：id 找不到 → 退回当前栏', resolveDraftChat(chats, '不存在', 0)?.draft === '甲')
    add('定位：id 为空 → 退回当前栏', resolveDraftChat(chats, '', 1)?.draft === '乙')
    add('定位：退回索引越界 → undefined', resolveDraftChat(chats, '不存在', 9) === undefined)
    add('定位：空列表 → undefined', resolveDraftChat([], 'a', 0) === undefined)
    // 找到的那一栏就是对象本身：写回即写回原聊天（不是副本）
    const target = resolveDraftChat(chats, 'a', 1)
    if (target) target.draft = '甲改'
    add('定位：写回原对象（非副本）', chats[0].draft === '甲改')
  }

  // 6. 语音接续：连续两句之间补空格，已有空格不重复补
  add('语音：空草稿直接用识别结果', joinAsrText('', '你好') === '你好')
  add('语音：已有内容补一个空格', joinAsrText('你好', '世界') === '你好 世界')
  add('语音：已以空格结尾不重复补', joinAsrText('你好 ', '世界') === '你好 世界')
  add('语音：识别结果为空时保持原样', joinAsrText('你好', '') === '你好')

  // 7. 草稿在聊天对象上：序列化 / 反序列化后仍在（重启恢复的依据）
  {
    const chats = [chat('a', '重启前写了一半')]
    const restored: DraftChat[] = JSON.parse(JSON.stringify(chats))
    add('持久化：序列化往返后草稿仍在', readChatDraft(restored, 0) === '重启前写了一半', readChatDraft(restored, 0))
  }

  return cases
}

/** 打印自测结果并返回是否全通过 */
export function logChatDraftSelfTest(): boolean {
  const cases = runChatDraftSelfTest()
  const failed = cases.filter((c) => !c.ok)
  // eslint-disable-next-line no-console
  console.table(cases.map((c) => ({ 用例: c.name, 结果: c.ok ? '通过' : '失败', 备注: c.detail ?? '' })))
  // eslint-disable-next-line no-console
  console.log(`[chatDraft] ${cases.length - failed.length}/${cases.length} 通过`)
  return failed.length === 0
}
