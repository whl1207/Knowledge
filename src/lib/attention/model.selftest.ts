/**
 * model.selftest.ts — 「待我处理」条目投影的纯逻辑自测
 *
 * 覆盖最容易判错、且错了就会「界面上多/少一条」的分支：
 * 已销毁会话必须被过滤（R8）、无 chatId 时不给「打开原处」、
 * 组序与排序、角标封顶、首行截断、相对时间。
 *
 * 运行：npm run test:selftest attention
 */

import {
  badgeText,
  fallbackTitle,
  firstLine,
  groupItems,
  groupOf,
  groupTitle,
  itemsFromViews,
  relativeTime,
  sortItems,
  type AttentionSourceView,
} from './model'
import type { AttentionItem } from '@/types/attention'

export interface AttentionModelCase {
  name: string
  ok: boolean
  detail?: string
}

const baseTime = 1_760_000_000_000

function view(over: Partial<AttentionSourceView> = {}): AttentionSourceView {
  return { id: 's1', status: 'idle', ...over }
}

const ask = { askId: 'ask-1', question: '是否删除这 3 个重复文件？', questions: [{ id: 'q1', question: '是否删除？' }] }
const review = { reviewId: 'review-1', plan: '# 重构检索评分\n\n1. 先改接口\n2. 再改单测' }

export function runAttentionModelSelfTest(): AttentionModelCase[] {
  const cases: AttentionModelCase[] = []
  const check = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, detail })

  // ---- 基本投影 ----
  const empty = itemsFromViews([], { now: baseTime })
  check('空视图 → 空数组', arrayEq(empty, []))

  const qItems = itemsFromViews([view({ pendingQuestion: ask })], { now: baseTime })
  check('提问 → 1 条', qItems.length === 1, `len=${qItems.length}`)
  check('提问：kind/group/key', qItems[0]?.kind === 'question' && qItems[0]?.group === 'answer' && qItems[0]?.key === 'question:s1:ask-1', JSON.stringify(qItems[0] && { k: qItems[0].kind, g: qItems[0].group, key: qItems[0].key }))
  check('提问：标题取摘要', qItems[0]?.title === '是否删除这 3 个重复文件？', qItems[0]?.title)
  check('提问：payload 带 askId 与 questions', qItems[0]?.payload.askId === 'ask-1' && qItems[0]?.payload.questions?.length === 1)
  check('提问：无 chatId 时不给「打开原处」', !(qItems[0]?.actions || []).some((a) => a.id === 'open'), JSON.stringify(qItems[0]?.actions.map((a) => a.id)))
  check('提问：主操作是「回答」', qItems[0]?.actions.find((a) => a.primary)?.id === 'answer')
  check('提问：提供「停止会话」（破坏性）', qItems[0]?.actions.some((a) => a.id === 'stop-session' && a.danger === true))

  const qWithChat = itemsFromViews([view({ pendingQuestion: ask })], { now: baseTime, resolveChatId: () => 'chat-1' })
  check('提问：有 chatId 时给「打开原处」', qWithChat[0]?.chatId === 'chat-1' && qWithChat[0]?.actions.some((a) => a.id === 'open'))

  // ---- 已销毁会话必须过滤（R8：dispose 不会清 pending 字段） ----
  const disposedStatus = itemsFromViews([view({ status: 'disposed', pendingQuestion: ask })], { now: baseTime })
  check('已销毁（status）→ 不出现', arrayEq(disposedStatus, []), JSON.stringify(disposedStatus.map((i) => i.key)))
  const disposedFlag = itemsFromViews([view({ disposed: true, pendingPlanReview: review })], { now: baseTime })
  check('已销毁（disposed 标记）→ 不出现', arrayEq(disposedFlag, []), JSON.stringify(disposedFlag.map((i) => i.key)))

  // ---- 计划评审 ----
  const pItems = itemsFromViews([view({ pendingPlanReview: review })], { now: baseTime, resolveChatId: () => 'chat-1' })
  check('评审 → 1 条', pItems.length === 1)
  check('评审：kind/group', pItems[0]?.kind === 'plan' && pItems[0]?.group === 'decide')
  check('评审：标题取计划首行且去掉 # 号', pItems[0]?.title === '重构检索评分', pItems[0]?.title)
  check('评审：payload 带完整计划', String(pItems[0]?.payload.plan || '').includes('再改单测'))
  check('评审：动作含批准 / 继续完善 / 关闭 / 打开原处',
    ['approve', 'keep-planning', 'dismiss', 'open'].every((id) => (pItems[0]?.actions || []).some((a) => a.id === id)),
    JSON.stringify(pItems[0]?.actions.map((a) => a.id)))

  // ---- 同一会话同时挂着提问与评审：两条都要在，提问在前 ----
  const both = itemsFromViews([view({ pendingQuestion: ask, pendingPlanReview: review })], { now: baseTime })
  check('同会话两条：都产出', both.length === 2, `len=${both.length}`)
  check('同会话两条：提问排在评审前', groupItems(both)[0]?.group === 'answer' && groupItems(both)[1]?.group === 'decide')

  // ---- 首次出现时间：resolveAt 优先，缺省用 now ----
  const withAt = itemsFromViews([view({ pendingQuestion: ask })], {
    now: baseTime,
    resolveAt: (key) => (key.endsWith('ask-1') ? baseTime - 120_000 : undefined),
  })
  check('at：resolveAt 命中时用首次出现时间', withAt[0]?.at === baseTime - 120_000, String(withAt[0]?.at))
  const withoutAt = itemsFromViews([view({ pendingQuestion: ask })], { now: baseTime })
  check('at：缺省用 now', withoutAt[0]?.at === baseTime)

  // ---- 排序：组序优先，组内时间倒序，同时间 key 兜底 ----
  const a = item('question:s1:a', 'answer', baseTime - 5_000)
  const b = item('question:s1:b', 'answer', baseTime - 1_000)
  const c = item('plan:s1:c', 'decide', baseTime)
  const sorted = sortItems([a, c, b])
  check('排序：组内时间倒序（新在前）', sorted[0]?.key === 'question:s1:b' && sorted[1]?.key === 'question:s1:a')
  check('排序：answer 组整体在 decide 组前', sorted[2]?.key === 'plan:s1:c')
  const tie = sortItems([item('question:s1:z', 'answer', baseTime), item('question:s1:y', 'answer', baseTime)])
  check('排序：同时间按 key 稳定', tie[0]?.key === 'question:s1:y' && tie[1]?.key === 'question:s1:z')

  // ---- 分组：丢空组 ----
  const grouped = groupItems([a, c])
  check('分组：只出现有内容的两组', grouped.length === 2 && grouped[0].group === 'answer' && grouped[1].group === 'decide')
  check('分组：空输入 → 空数组', groupItems([]).length === 0)

  // ---- 运行状态上报（report_run）：只有 blocked / failed / ready 进面板 ----
  const at = baseTime
  const blockedView = view({ runReport: { state: 'blocked', summary: '缺少数据库密码', question: '请提供只读账号', at } })
  const blockedItems = itemsFromViews([blockedView], { now: baseTime, resolveChatId: () => 'chat-1' })
  check('上报 blocked → 1 条', blockedItems.length === 1, `len=${blockedItems.length}`)
  check('上报 blocked：kind/group', blockedItems[0]?.kind === 'run-failed' && blockedItems[0]?.group === 'problem')
  check('上报 blocked：标题优先用问题', blockedItems[0]?.title === '请提供只读账号', blockedItems[0]?.title)
  check('上报 blocked：动作含打开原处（主操作）与停止会话',
    blockedItems[0]?.actions.some((x) => x.id === 'open' && x.primary) && blockedItems[0]?.actions.some((x) => x.id === 'stop-session'))

  const readyItems = itemsFromViews([view({ runReport: { state: 'ready', summary: '报告已写完，等你验收', at } })], { now: baseTime, resolveChatId: () => 'chat-1' })
  check('上报 ready → 1 条（待验收）', readyItems.length === 1 && readyItems[0]?.kind === 'run-ready' && readyItems[0]?.group === 'review')
  check('上报 ready：标题用摘要', readyItems[0]?.title === '报告已写完，等你验收')

  for (const quiet of ['progress', 'waiting', 'dropped'] as const) {
    const list = itemsFromViews([view({ runReport: { state: quiet, summary: '内部进度', at } })], { now: baseTime })
    check(`上报 ${quiet} → 不打扰人`, list.length === 0, JSON.stringify(list.map((i) => i.key)))
  }

  const noChatBlocked = itemsFromViews([view({ runReport: { state: 'failed', summary: '脚本报错', at } })], { now: baseTime })
  check('上报无 chatId：不给「打开原处」，仍有停止会话',
    noChatBlocked[0]?.actions.length === 1 && noChatBlocked[0]?.actions[0]?.id === 'stop-session')

  check('上报已销毁会话 → 不出现',
    itemsFromViews([view({ status: 'disposed', runReport: { state: 'blocked', summary: 'x', at } })], { now: baseTime }).length === 0)

  // ---- 角标 ----
  check('角标：0 → 空串', badgeText(0) === '')
  check('角标：3 → "3"', badgeText(3) === '3')
  check('角标：负数 → 空串', badgeText(-2) === '')
  check('角标：150 → "99+"', badgeText(150) === '99+')

  // ---- 首行截断 ----
  check('firstLine：取第一个非空行', firstLine('\n\n第一行\n第二行') === '第一行')
  check('firstLine：去掉 markdown 标题与列表符号', firstLine('## 标题') === '标题' && firstLine('- 列表项') === '列表项')
  check('firstLine：空文本 → 空串', firstLine('   \n ') === '')
  const long = firstLine('a'.repeat(120), 20)
  check('firstLine：超长按上限截断并加省略号', Array.from(long).length === 20 && long.endsWith('…'), long)

  // ---- 分组标题 / 兜底标题（中英各一份，缺一份界面上会露中文） ----
  check('groupTitle：中文', groupTitle('answer', true) === '需要你回答' && groupTitle('decide', true) === '需要你裁决')
  check('groupTitle：英文', groupTitle('answer', false) === 'Needs your answer' && groupTitle('decide', false) === 'Needs your decision')
  check('fallbackTitle：提问有中英两份', fallbackTitle('question', true) !== fallbackTitle('question', false))
  check('fallbackTitle：评审有中英两份', fallbackTitle('plan', true) !== fallbackTitle('plan', false))
  check('groupOf：未知 kind 兜底到 system', groupOf('whatever' as any) === 'system')

  // ---- 相对时间 ----
  check('relativeTime：30 秒 → 刚刚', relativeTime(baseTime - 30_000, baseTime, true) === '刚刚')
  check('relativeTime：5 分钟', relativeTime(baseTime - 5 * 60_000, baseTime, true) === '5 分钟前')
  check('relativeTime：2 小时（英文）', relativeTime(baseTime - 2 * 3_600_000, baseTime, false) === '2 h ago')
  check('relativeTime：3 天', relativeTime(baseTime - 3 * 86_400_000, baseTime, true) === '3 天前')
  check('relativeTime：未来 / 非法 → 不崩', relativeTime(baseTime + 10_000, baseTime, true) === '刚刚' && relativeTime(NaN, baseTime, true) === '')

  return cases
}

function item(key: string, group: AttentionItem['group'], at: number): AttentionItem {
  return { key, kind: group === 'answer' ? 'question' : 'plan', group, title: key, sessionId: 's1', at, actions: [], payload: {} }
}

function arrayEq<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}
