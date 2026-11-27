/**
 * blockeditor/history.ts — 撤销 / 重做
 *
 * Markdown 是唯一真源，所以用「文档快照栈」即可，不必做操作日志。
 * 用 label + 时间窗做合并，避免每敲一个字都压栈。
 */

export interface Snapshot {
  /** 文档 Markdown 全文 */
  md: string
  /** 光标所在块下标（块会被增删，撤销时按下标近似恢复即可） */
  index: number
  /** 块内偏移 */
  offset: number
  /** 合并用的标签，如 'input'、'structure' */
  label: string
}

const COALESCE_MS = 600

export class SnapshotHistory {
  private stack: Snapshot[] = []
  private pos = -1
  private lastAt = 0
  private limit: number

  constructor(limit = 300) {
    this.limit = limit
  }

  /** 重置为一个初始状态（打开文件时调用） */
  reset(snap: Snapshot): void {
    this.stack = [snap]
    this.pos = 0
    this.lastAt = 0
  }

  get canUndo(): boolean {
    return this.pos > 0
  }

  get canRedo(): boolean {
    return this.pos >= 0 && this.pos < this.stack.length - 1
  }

  /**
   * 提交一个新状态。
   * 与上一个快照 label 相同且间隔小于窗口时，直接覆盖栈顶（合并连续输入）。
   */
  commit(snap: Snapshot, now = Date.now()): void {
    if (this.pos >= 0) {
      const top = this.stack[this.pos]
      if (top && top.md === snap.md) return // 内容未变，忽略
      if (top && top.label === snap.label && now - this.lastAt < COALESCE_MS) {
        this.stack[this.pos] = snap
        this.lastAt = now
        return
      }
    }
    // 丢弃 redo 分支
    this.stack.length = this.pos + 1
    this.stack.push(snap)
    this.pos = this.stack.length - 1
    this.lastAt = now
    if (this.stack.length > this.limit) {
      this.stack.shift()
      this.pos -= 1
    }
  }

  /** 立即结束合并窗口（结构性操作后调用） */
  breakCoalesce(): void {
    this.lastAt = 0
  }

  /**
   * 修正「初始快照」的光标位置。
   *
   * 打开文件时初始快照记为第 0 块；用户跳到中间某块做第一次编辑后按 Ctrl+Z，
   * 撤销回到的正是这个初始快照 —— 不修正就会把光标/视口拉回文档开头。
   * 只允许在只有初始快照（或撤销回初始态）时调用。
   */
  setInitialCaret(index: number, offset: number): void {
    if (this.stack.length === 0) return
    this.stack[0].index = index
    this.stack[0].offset = offset
  }

  undo(): Snapshot | null {
    if (!this.canUndo) return null
    this.pos -= 1
    this.lastAt = 0
    return this.stack[this.pos]
  }

  redo(): Snapshot | null {
    if (!this.canRedo) return null
    this.pos += 1
    this.lastAt = 0
    return this.stack[this.pos]
  }
}
