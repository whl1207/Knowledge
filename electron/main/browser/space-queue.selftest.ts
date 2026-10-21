/**
 * space-queue.selftest.ts — 按 Space 串行、跨 Space 并行（纯逻辑）
 */
import { KeyedQueue } from './space-queue'

export interface SpaceQueueCase {
  name: string
  ok: boolean
  detail?: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function runSpaceQueueSelfTest(): Promise<SpaceQueueCase[]> {
  const cases: SpaceQueueCase[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  {
    const q = new KeyedQueue()
    const order: number[] = []
    const t1 = q.run('a', async () => { await sleep(20); order.push(1) })
    const t2 = q.run('a', async () => { order.push(2) })
    await Promise.all([t1, t2])
    add('同 key 串行（按入队顺序）', JSON.stringify(order) === '[1,2]', order.join(','))
  }

  {
    const q = new KeyedQueue()
    let active = 0
    let maxActive = 0
    const job = async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await sleep(25)
      active--
    }
    await Promise.all([q.run('a', job), q.run('b', job), q.run('c', job)])
    add('不同 key 并行', maxActive === 3, `max=${maxActive}`)
  }

  {
    const q = new KeyedQueue()
    const t1 = q.run('a', async () => { throw new Error('boom') })
    let failed = false
    try { await t1 } catch { failed = true }
    let ran = false
    await q.run('a', async () => { ran = true })
    add('任务失败被上抛', failed)
    add('失败不毒化后续任务', ran)
  }

  {
    const q = new KeyedQueue()
    const t1 = q.run('a', () => sleep(10))
    add('pending 能反映排队中', q.pending('a') === true)
    await t1
    await sleep(0)
    add('结束后清理 tail', q.pending('a') === false)
    add('activeKeys 清理', q.activeKeys() === 0, `keys=${q.activeKeys()}`)
  }

  return cases
}
