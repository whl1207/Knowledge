/**
 * notices.selftest.ts — 「动态」（ElMessage 收件箱副本）的纯逻辑自测
 *
 * 覆盖最容易出问题的三个点：
 * 1. 连续重复的同一句话不刷屏（3 秒内只留一条，刷新时间并重新标未读）；
 * 2. 容量上限（50 条），超了丢最旧；
 * 3. 已读 / 清空的语义（未读数只算未读，清空后无残留）。
 *
 * 运行：npm run test:selftest notices
 */

import { clearNotices, markNoticesRead, notices, pushNotice, unreadNoticeCount } from './notices'

export interface NoticesCase {
  name: string
  ok: boolean
  detail?: string
}

export function runNoticesSelfTest(): NoticesCase[] {
  const cases: NoticesCase[] = []
  const check = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, detail })

  clearNotices()
  check('初始为空', notices.value.length === 0 && unreadNoticeCount.value === 0)

  pushNotice('success', '已保存')
  check('普通入列', notices.value.length === 1 && notices.value[0].text === '已保存' && notices.value[0].kind === 'success')
  check('新条目未读', unreadNoticeCount.value === 1)

  pushNotice('success', '已保存')
  check('3 秒内同文案去重', notices.value.length === 1, `len=${notices.value.length}`)

  pushNotice('error', '已保存')
  check('同文案不同类别不去重', notices.value.length === 2)

  pushNotice('info', '   ')
  check('空白文案不入列', notices.value.length === 2)

  pushNotice('warning', '磁盘空间不足')
  check('不同文案入列', notices.value.length === 3 && notices.value[0].text === '磁盘空间不足')

  markNoticesRead()
  check('全部已读 → 未读归零', unreadNoticeCount.value === 0)
  check('已读后条目仍在（可回看）', notices.value.length === 3)

  pushNotice('info', '新的提示')
  check('新提示重新变为未读', unreadNoticeCount.value === 1)

  // 容量上限：连续推 60 条不同文案，只保留最近 50 条
  clearNotices()
  for (let i = 0; i < 60; i++) pushNotice('info', `提示 ${i}`)
  check('容量上限 50 条', notices.value.length === 50, `len=${notices.value.length}`)
  check('超限丢最旧、保留最新', notices.value[0].text === '提示 59', notices.value[0]?.text)

  clearNotices()
  check('清空后为空且未读归零', notices.value.length === 0 && unreadNoticeCount.value === 0)

  return cases
}
