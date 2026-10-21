/**
 * events.ts — 浏览器动作期间的事件缓冲（popup / dialog / download / console）
 *
 * 对应 ego-lite 的 ActionReceipt 思路：动作只保证"派发了什么 + 立即观察到了什么"，
 * 不承诺业务状态。这里把动作窗口内发生的事件按标签缓存，动作结束后由工具结果带出，
 * 让模型知道"点完弹了新窗口/出现 confirm/触发了下载/控制台报错"。
 *
 * 纯逻辑（无 Electron 依赖），可直接 selftest。
 */

export type BrowserEvent =
  | { kind: 'dialog'; at: number; dialogType: string; message: string; handled?: 'auto' | 'user'; accepted?: boolean }
  | { kind: 'popup'; at: number; tabId: string; url: string; label?: string }
  | { kind: 'download'; at: number; filename: string; path?: string; state: string }
  | { kind: 'console'; at: number; level: 'error' | 'exception'; text: string }

const MAX_PER_TAB = 50

export class BrowserEventBuffer {
  private map = new Map<string, BrowserEvent[]>()

  record(tabId: string, event: BrowserEvent): void {
    if (!tabId) return
    const list = this.map.get(tabId) || []
    list.push(event)
    if (list.length > MAX_PER_TAB) list.splice(0, list.length - MAX_PER_TAB)
    this.map.set(tabId, list)
  }

  clear(tabId: string): void {
    this.map.delete(tabId)
  }

  /** 取走并清空该标签的事件（动作结束时调用） */
  drain(tabId: string): BrowserEvent[] {
    const list = this.map.get(tabId) || []
    this.map.delete(tabId)
    return list
  }

  peek(tabId: string): BrowserEvent[] {
    return [...(this.map.get(tabId) || [])]
  }
}

/** 把事件转成给模型看的一行摘要（无事件返回空串） */
export function formatEventNote(events: BrowserEvent[]): string {
  if (!events.length) return ''
  const parts: string[] = []
  for (const e of events) {
    if (e.kind === 'popup') parts.push(`新标签「${e.label || e.url || e.tabId}」`)
    else if (e.kind === 'dialog') {
      const handled = e.handled === 'user' ? '用户处理' : '已自动处理'
      parts.push(`${e.dialogType}("${e.message.slice(0, 120)}") ${handled}${e.accepted === false ? '（取消）' : ''}`)
    } else if (e.kind === 'download') parts.push(`下载「${e.filename}」${e.state === 'completed' ? '完成' : e.state}`)
    else if (e.kind === 'console') parts.push(`控制台${e.level === 'exception' ? '异常' : '错误'}：${e.text.slice(0, 120)}`)
  }
  return `\n回执：${parts.join('；')}`
}
