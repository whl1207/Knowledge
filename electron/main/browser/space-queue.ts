/**
 * space-queue.ts — 按 Space（owner）串行、跨 Space 并行的队列
 *
 * 对齐 ego-lite 的 NativeOperationGate：同一个 space 内的操作 FIFO（不串台），
 * 不同 space 的操作互不等待（多 agent 并行）。纯逻辑，可直接 selftest。
 */
export class KeyedQueue {
  private tails = new Map<string, Promise<void>>()

  /** 入队；key 相同串行，key 不同并行。任务抛错不影响后续任务。 */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const k = key || 'default'
    const prev = this.tails.get(k) || Promise.resolve()
    const result = prev.then(task, task)
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(k, tail)
    void tail.then(() => {
      if (this.tails.get(k) === tail) this.tails.delete(k)
    })
    return result
  }

  /** 该 key 是否还有排队/执行中的任务 */
  pending(key: string): boolean {
    return this.tails.has(key || 'default')
  }

  /** 当前有任务的 key 数量（诊断/上限用） */
  activeKeys(): number {
    return this.tails.size
  }
}
