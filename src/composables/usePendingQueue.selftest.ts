/**
 * usePendingQueue.selftest.ts — 待执行队列（排队 / 插队 / 编辑 / 投递时机）自测
 *
 * 对齐 DSH 运行中输入语义的关键断言：
 * - 排队与插队**都不打断执行**：本轮在跑时条目一律走 `push`（steer 通道，下一个 step 边界生效），
 *   只有本轮已收尾才回退成「新一轮任务」（`sendAsNewTurn`）；
 * - 普通排队条目等 `canDeliver` 到点才投（每 step 一条，顺序不乱）；
 * - 插队条目优先投递，但仍需等 `canDeliver`（主进程在 step 边界领取）；
 * - 队列在投递前可编辑 / 排序 / 删除 / 批量删除，顺序不会被并发打乱；
 * - 投递被拒（会话刚好收尾）时条目按原顺序留在队首，不丢内容、不重复投递。
 *
 * 用法：`node scripts/run-selftests.mjs pendingQueue`
 */

import { usePendingQueue, type PendingQueueItem } from './usePendingQueue'

export interface PendingQueueCase {
  name: string
  ok: boolean
  detail?: string
}

/** node 环境没有 localStorage：装一个最小实现（被测模块只用到这几个方法） */
function installLocalStorageStub(): void {
  const store = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  }
}

interface Harness {
  api: ReturnType<typeof usePendingQueue>
  /** push 通道（运行中投递，不打断本轮）实际收到的条目 */
  pushed: string[]
  /** 回退为「新一轮任务」发送的条目 */
  newTurn: string[]
  /** 正在执行的聊天（模拟 agent 在跑） */
  busy: Set<string>
  /** 允许投递的聊天（模拟 step 边界已到） */
  deliverable: Set<string>
  /** push 返回 0（模拟会话刚好收尾、拒收） */
  rejectPush: { value: boolean }
  setCurrent: (id: string) => void
  notify: string[]
}

function makeHarness(): Harness {
  if (!(globalThis as any).localStorage) installLocalStorageStub()
  const pushed: string[] = []
  const newTurn: string[] = []
  const busy = new Set<string>()
  const deliverable = new Set<string>()
  const notify: string[] = []
  const rejectPush = { value: false }
  let current = 'chat-a'
  const h: Harness = {
    api: undefined as any,
    pushed,
    newTurn,
    busy,
    deliverable,
    rejectPush,
    setCurrent: (id) => { current = id },
    notify,
  }
  const api = usePendingQueue({
    getChatId: () => current,
    isChatBusy: (chatId: string) => busy.has(chatId),
    canFlush: (chatId: string) => chatId === current,
    canDeliver: (chatId: string, item: PendingQueueItem) => !!item.pinned || deliverable.has(chatId),
    push: (chatId: string, item: PendingQueueItem) => {
      if (rejectPush.value) return 0
      pushed.push(item.text)
      return 1
    },
    sendAsNewTurn: (chatId: string, item: PendingQueueItem) => { newTurn.push(item.text) },
    notify: (t: string) => { notify.push(t) },
  })
  h.api = api
  return h
}

const mk = (text: string) => ({ text, display: text, mode: 'agent2' })
const texts = (h: Harness) => h.api.pending().map((i) => i.text).join(',')
const pushedTexts = (h: Harness) => h.pushed.join(',')

export async function runPendingQueueSelfTest(): Promise<PendingQueueCase[]> {
  const cases: PendingQueueCase[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  installLocalStorageStub()

  // 1. 空闲时入队：直接按「新一轮任务」发出（与手动发送等价）
  {
    const h = makeHarness()
    h.api.enqueue(mk('空闲时的消息'))
    await h.api.flush()
    add('空闲：按新一轮任务发出', h.newTurn.join(',') === '空闲时的消息', h.newTurn.join(','))
    add('空闲：不走 push 通道', h.pushed.length === 0, String(h.pushed.length))
    add('空闲：队列清空', h.api.pending().length === 0)
  }

  // 2. 运行中入队：不打断执行——走 push（steer）而不是新轮
  {
    const h = makeHarness()
    h.busy.add('chat-a')
    h.deliverable.add('chat-a')
    h.api.enqueue(mk('运行中的补充要求'))
    await h.api.flush()
    add('运行中：走 push（不打断本轮）', pushedTexts(h) === '运行中的补充要求', pushedTexts(h))
    add('运行中：不回退为新轮发送', h.newTurn.length === 0, h.newTurn.join(','))
  }

  // 3. 投递时机未到（本 step 还没结束）：条目留在队列，等下一次触发
  {
    const h = makeHarness()
    h.busy.add('chat-a') // 没有 deliverable：等价于「step 边界还没到」
    h.api.enqueue(mk('等待 step 边界'))
    await h.api.flush()
    add('step 边界未到：不投递', h.pushed.length === 0 && h.newTurn.length === 0)
    add('step 边界未到：条目仍在队首', texts(h) === '等待 step 边界', texts(h))
    h.deliverable.add('chat-a') // step 边界到了
    await h.api.flush()
    add('step 边界到达：立刻投递', pushedTexts(h) === '等待 step 边界', pushedTexts(h))
  }

  // 4. 每 step 一条：一次 flush 只投一条（避免抢跑成没人监听的游离 turn）
  {
    const h = makeHarness()
    h.busy.add('chat-a')
    h.deliverable.add('chat-a')
    h.api.enqueue(mk('一'))
    h.api.enqueue(mk('二'))
    await h.api.flush()
    add('运行中一次只投一条', pushedTexts(h) === '一', pushedTexts(h))
    add('运行中剩余条目排在其后', texts(h) === '二', texts(h))
    await h.api.flush() // 下一个 step 边界
    add('下一个 step 边界投第二条', pushedTexts(h) === '一,二', pushedTexts(h))
  }

  // 5. 插队：越过排队顺序优先投递，且依然不打断执行
  {
    const h = makeHarness()
    h.busy.add('chat-a')
    h.deliverable.add('chat-a')
    h.api.enqueue(mk('排队一'))
    h.api.enqueue(mk('插队'), { pin: true })
    h.api.enqueue(mk('排队二'))
    add('插队条目排到普通排队之前', texts(h) === '插队,排队一,排队二', texts(h))
    await h.api.flush()
    add('插队条目先投递', pushedTexts(h) === '插队', pushedTexts(h))
    add('插队条目没走新轮路径', h.newTurn.length === 0, h.newTurn.join(','))
  }

  // 5b. 队首被时机卡住时，后面的插队条目可以越过它先投
  {
    const h = makeHarness()
    h.busy.add('chat-a')
    // canDeliver 只允许插队条目：普通条目「时机未到」
    h.deliverable.delete('chat-a')
    h.api.enqueue(mk('普通（时机未到）'))
    h.api.enqueue(mk('插队（可投）'), { pin: true })
    await h.api.flush()
    add('插队条目越过被卡住的队首', pushedTexts(h) === '插队（可投）', pushedTexts(h))
    add('被卡住的普通条目仍在队列最前', texts(h) === '普通（时机未到）', texts(h))
  }

  // 6. 连续插队保持先入先出（后插的不越过先插的）
  {
    const h = makeHarness()
    h.api.enqueue(mk('插一'), { pin: true })
    h.api.enqueue(mk('插二'), { pin: true })
    h.api.enqueue(mk('普通'))
    add('连续插队：插队区内先入先出', texts(h) === '插一,插二,普通', texts(h))
  }

  // 7. 投递被拒（会话刚好收尾）：条目按原顺序回到队首，不丢不重
  {
    const h = makeHarness()
    h.busy.add('chat-a')
    h.deliverable.add('chat-a')
    h.api.enqueue(mk('会被拒'))
    h.api.enqueue(mk('后面的'))
    h.rejectPush.value = true
    await h.api.flush()
    add('投递被拒：两条都留在队列', texts(h) === '会被拒,后面的', texts(h))
    add('投递被拒：没有落进聊天', h.pushed.length === 0 && h.newTurn.length === 0)
    h.rejectPush.value = false
    await h.api.flush()
    add('重试后按原顺序投递', pushedTexts(h) === '会被拒', pushedTexts(h))
    await h.api.flush()
    add('后续条目继续按顺序投递', pushedTexts(h) === '会被拒,后面的', pushedTexts(h))
  }

  // 8. 本轮收尾后：剩余条目回退为新一轮任务
  {
    const h = makeHarness()
    h.busy.add('chat-a')
    h.api.enqueue(mk('收尾后的'))
    await h.api.flush() // 运行中且 step 边界未到 → 不动
    add('运行中且未到边界：不提前发送', h.newTurn.length === 0 && h.pushed.length === 0)
    h.busy.delete('chat-a') // 本轮收尾
    await h.api.flush()
    add('收尾后：剩余条目按新一轮发出', h.newTurn.join(',') === '收尾后的', h.newTurn.join(','))
  }

  // 9. 每聊天独立 / 未打开的聊天不出队
  {
    const h = makeHarness()
    h.busy.add('chat-b')
    h.api.enqueue(mk('给 A 的'))
    await h.api.flush()
    add('其它聊天忙碌不阻塞本聊天', h.newTurn.join(',') === '给 A 的', h.newTurn.join(','))

    const h2 = makeHarness()
    h2.api.enqueue(mk('给 A 的'))
    h2.setCurrent('chat-b')
    await h2.api.flush('chat-a')
    add('目标聊天未打开：不出队', h2.newTurn.length === 0 && h2.pushed.length === 0)
    add('目标聊天未打开：条目保留', h2.api.pendingOf('chat-a').length === 1)
  }

  // 10. 编辑（投递前才能改）
  {
    const h = makeHarness()
    h.api.enqueue(mk('原始内容'))
    const id = h.api.pending()[0].id
    h.api.updateItem(id, { text: '改过的内容', display: '改过的内容' })
    add('编辑：正文就地更新', texts(h) === '改过的内容', texts(h))
    await h.api.flush()
    add('编辑：发出的是新内容', h.newTurn.join(',') === '改过的内容', h.newTurn.join(','))
  }

  // 11. 排序：拖动（reorder）/ 上下移（moveBy）/ 置顶（togglePin）
  {
    const h = makeHarness()
    h.api.enqueue(mk('一'))
    h.api.enqueue(mk('二'))
    h.api.enqueue(mk('三'))
    const ids = h.api.pending().map((i) => i.id)
    h.api.reorder([ids[2], ids[0], ids[1]])
    add('拖动排序：顺序按面板给出的顺序', texts(h) === '三,一,二', texts(h))

    const idOne = h.api.pending().find((i) => i.text === '一')!.id
    h.api.moveBy(idOne, -1)
    add('上移一位：与前一位置换', texts(h) === '一,三,二', texts(h))

    const idTwo = h.api.pending().find((i) => i.text === '二')!.id
    h.api.togglePin(idTwo)
    add('置顶：条目标记插队（位置由用户拖动决定）', h.api.pending().find((i) => i.text === '二')?.pinned === true)
    add('置顶：投递时优先于普通条目', h.api.pending().filter((i) => i.pinned).length === 1)
    h.api.togglePin(idTwo)
    add('取消置顶：回到普通排队（顺序不跳位）', texts(h) === '一,三,二', texts(h))
  }

  // 12. 删除：单条 / 批量
  {
    const h = makeHarness()
    h.api.enqueue(mk('一'))
    h.api.enqueue(mk('二'))
    h.api.enqueue(mk('三'))
    const second = h.api.pending()[1].id
    h.api.removeItem(second)
    add('单条删除：其余保持顺序', texts(h) === '一,三', texts(h))

    const removed = h.api.removeItems(h.api.pending().map((i) => i.id))
    add('批量删除：返回删除条数', removed === 2, String(removed))
    add('批量删除：队列清空', h.api.pending().length === 0)
  }

  // 13. 队列上限：超限拒绝并提示
  {
    const h = makeHarness()
    for (let i = 0; i < h.api.QUEUE_LIMIT; i++) h.api.enqueue(mk('第' + i))
    const extra = h.api.enqueue(mk('超限'))
    add('达到上限后拒绝入队', extra === null && h.api.pending().length === h.api.QUEUE_LIMIT, String(h.api.pending().length))
    add('拒绝入队时给出提示', h.notify.length === 1, h.notify.join('|'))
  }

  // 14. isQueueBusy / hasPinned（面板与发送按钮状态）
  {
    const h = makeHarness()
    add('空队列 → 不忙', !h.api.isQueueBusy('chat-a'))
    h.api.enqueue(mk('一'))
    add('有排队条目 → 忙', h.api.isQueueBusy('chat-a'))
    add('别的聊天互不影响', !h.api.isQueueBusy('chat-b'))
    add('无插队条目 → hasPinned=false', !h.api.hasPinned('chat-a'))
    h.api.enqueue(mk('二'), { pin: true })
    add('有插队条目 → hasPinned=true', h.api.hasPinned('chat-a'))
  }

  // 15. 持久化与恢复（含插队标记），以及「聊天已删除则丢弃」
  {
    installLocalStorageStub()
    const h = makeHarness()
    h.api.enqueue({ ...mk('持久的'), fileAttachments: [{ name: 'a.md', content: 'x', charCount: 1 }] })
    h.api.enqueue(mk('插队的'), { pin: true })
    const raw = localStorage.getItem(h.api.STORAGE_KEY) || ''
    add('队列写入独立存储键（不混入聊天存档）', raw.includes('持久的'))
    add('插队标记一并持久化', raw.includes('"pinned":true'))

    const h2 = makeHarness()
    h2.api.restoreFromStorage(new Set(['chat-a']))
    add('恢复：插队条目仍排在前面', texts(h2) === '插队的,持久的', texts(h2))
    add('恢复：附件字段完整', h2.api.pending().find((i) => i.text === '持久的')?.fileAttachments?.[0]?.name === 'a.md')

    const h3 = makeHarness()
    h3.api.restoreFromStorage(new Set(['chat-x']))
    add('恢复：聊天已删除则条目丢弃', h3.api.pendingOf('chat-a').length === 0)
  }

  // 16. clearAll（清空聊天记录联动）
  {
    const h = makeHarness()
    h.api.enqueue(mk('一'))
    h.api.clearAll()
    add('clearAll 清掉所有聊天的队列', Object.keys(h.api.pendingByChat.value).length === 0)
  }

  return cases
}

/** 打印自测结果并返回是否全通过（runner 的 run* 契约是返回数组，本函数供人工调用） */
export async function logPendingQueueSelfTest(): Promise<boolean> {
  const cases = await runPendingQueueSelfTest()
  const failed = cases.filter((c) => !c.ok)
  // eslint-disable-next-line no-console
  console.table(cases.map((c) => ({ 用例: c.name, 结果: c.ok ? '通过' : '失败', 备注: c.detail ?? '' })))
  // eslint-disable-next-line no-console
  console.log(`[pendingQueue] ${cases.length - failed.length}/${cases.length} 通过`)
  return failed.length === 0
}
