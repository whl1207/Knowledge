/**
 * events.selftest.ts — 动作回执事件缓冲（纯逻辑）
 *
 * 用法：`npm run test:selftest`（scripts/run-selftests.mjs 注册）
 */
import { BrowserEventBuffer, formatEventNote } from './events'

export interface BrowserEventsCase {
  name: string
  ok: boolean
  detail?: string
}

export function runBrowserEventsSelfTest(): BrowserEventsCase[] {
  const cases: BrowserEventsCase[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  {
    const b = new BrowserEventBuffer()
    b.record('tab1', { kind: 'popup', at: 1, tabId: 't2', url: 'https://x', label: 'p2' })
    b.record('tab1', { kind: 'dialog', at: 2, dialogType: 'confirm', message: 'Sure?' })
    const drained = b.drain('tab1')
    add('按标签缓存并按需取走', drained.length === 2, `len=${drained.length}`)
    add('取走后清空', b.drain('tab1').length === 0)
    add('不同标签互不影响', b.drain('tab2').length === 0)
  }

  {
    const b = new BrowserEventBuffer()
    for (let i = 0; i < 80; i++) b.record('t', { kind: 'console', at: i, level: 'error', text: `e${i}` })
    const drained = b.drain('t')
    add('事件上限：最多保留 50 条', drained.length === 50, `len=${drained.length}`)
    add('事件上限：保留最新的', drained[drained.length - 1].at === 79)
  }

  {
    const note = formatEventNote([
      { kind: 'popup', at: 1, tabId: 't2', url: 'https://x', label: 'p2' },
      { kind: 'dialog', at: 2, dialogType: 'alert', message: 'hi', handled: 'auto', accepted: true },
      { kind: 'download', at: 3, filename: 'a.pdf', state: 'completed' },
      { kind: 'console', at: 4, level: 'exception', text: 'boom' },
    ])
    add('格式化包含新标签', note.includes('新标签「p2」'), note)
    add('格式化包含弹窗处理', note.includes('alert') && note.includes('已自动处理'))
    add('格式化包含下载完成', note.includes('下载「a.pdf」完成'))
    add('格式化包含控制台异常', note.includes('控制台异常'))
  }

  {
    add('无事件时返回空串', formatEventNote([]) === '')
  }

  return cases
}

export function logBrowserEventsSelfTest(): boolean {
  const cases = runBrowserEventsSelfTest()
  const failed = cases.filter((c) => !c.ok)
  // eslint-disable-next-line no-console
  console.table(cases.map((c) => ({ 用例: c.name, 结果: c.ok ? '通过' : '失败', 备注: c.detail ?? '' })))
  // eslint-disable-next-line no-console
  console.log(`[browser-events] ${cases.length - failed.length}/${cases.length} 通过`)
  return failed.length === 0
}
