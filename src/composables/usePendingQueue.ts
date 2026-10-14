/**
 * usePendingQueue.ts — 待执行队列（对齐 DeepSeek-Harness 的运行中输入语义）
 *
 * 三种投递方式（DSH 一致）：
 *
 * | 用户操作                     | 语义                                                        | AI-KM 实现                                   |
 * | ---------------------------- | ----------------------------------------------------------- | -------------------------------------------- |
 * | Enter（运行中）              | **排队**：等下一个 step 边界投给正在跑的 agent                | `enqueue()` → `push(item)`（push 原语）      |
 * | Ctrl+Enter（运行中）         | **插队**：越过排队顺序，尽快在下一个 step 边界投递            | `enqueue({ pin: true })` → 立刻 push         |
 * | 停止（■）                    | **打断**：取消当前轮（并清空队列）                            | home.vue `stopCurrentGeneration()`           |
 *
 * 关键点（勿改）：**排队与插队都不打断当前执行**——它们是 agent inbox 的投递方式，
 * 主进程/渲染层在**下一个 step 边界**消费（`claimPendingSteer()`），与 DSH 一致。
 * 真正中断执行的只有「停止」。
 *
 * 队列是**每聊天独立**的（对应 DSH 每个会话一个 inbox），并且是**渲染层唯一事实源**：
 * 条目在真正投递出去之前都能编辑 / 拖动排序 / 插入队列首 / 删除 / 批量删除，
 * 这样才谈得上「编辑队列」（一旦进了 agent inbox 就无法改写了）。
 */

import { ref, type Ref } from 'vue'

/** 队列条目（持久化形状：一切字段都必须是纯 JSON） */
export interface PendingQueueItem {
  id: string
  /** 入队时间（面板排序与展示） */
  at: number
  /** 真正投递给智能体/模型的正文（附件正文已按同格式前置） */
  text: string
  /** 面板里展示的正文（用户实际输入；只传文件时是文件名列表） */
  display: string
  /** 入队时的模式（仅用于展示与排查；实际发送按聊天当前模式） */
  mode: string
  /** 插队标记：Ctrl+Enter 入队 / 面板置顶，排在普通排队条目之前，且不入自动投递节流 */
  pinned?: boolean
  /** 附件 chips（与 ChatMessage.fileAttachments 同形状；内容为空表示只存展示） */
  fileAttachments?: Array<{ name: string; content: string; charCount: number }>
  /** 图片（data URL；图片不落盘，重载后丢失） */
  images?: string[]
}

export interface PendingQueueDeps {
  /** 每个聊天各自一个队列 */
  getChatId: () => string | undefined
  /** 该聊天当前是否正在执行（决定了能不能立即投递） */
  isChatBusy: (chatId: string) => boolean
  /**
   * 把一条排好序的条目投递给正在执行的 agent（**不打断本轮**，在下一个 step 边界生效）。
   * 返回实际投递出去的条数（0 = 当前没有可接收的会话，条目保留在队首）。
   */
  push: (chatId: string, item: PendingQueueItem) => Promise<number> | number
  /**
   * 判断一条排队消息的投递时机是否已到：
   * - `pinned`（插队）条目：随时可投（主进程会在下一个 step 边界消费）；
   * - 普通排队条目：等到「上一个 step 已经结束」才投（每步一条，顺序不乱、也不会
   *   因为提前投递而在 turn 结束后变成没人监听的游离 turn）。
   */
  canDeliver: (chatId: string, item: PendingQueueItem) => boolean
  /** 真正把条目作为「新一轮任务」发送（本轮已结束 / 该模式没有 step 边界时的回退路径） */
  sendAsNewTurn: (chatId: string, item: PendingQueueItem) => Promise<void> | void
  /** 是否允许为这个聊天出队（默认：必须是当前打开的聊天） */
  canFlush?: (chatId: string) => boolean
  /** 出队后的可持久化副作用（一般传 home 的 saveChats） */
  onAfterSend?: () => void
  /** 用户可见提示（一般传 ElMessage 的封装） */
  notify?: (text: string) => void
}

/** 单聊天队列上限：防止误按 Enter 堆出上百条 */
const QUEUE_LIMIT = 50
/** 存储键：与聊天存档分开，清空聊天记录时一并清理 */
const STORAGE_KEY = 'ai-chat-pending-queue'
/** 出队发送前等待「上一轮收尾 + 界面解锁」的上限 */
const SETTLE_TIMEOUT_MS = 3000
const POLL_MS = 60

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 排好序的队列：插队（pinned）条目在前（内部保持先入先出），普通条目在后 */
function orderQueue(list: PendingQueueItem[]): PendingQueueItem[] {
  const pinned = list.filter((i) => i.pinned)
  const normal = list.filter((i) => !i.pinned)
  return [...pinned, ...normal]
}

export function usePendingQueue(deps: PendingQueueDeps) {
  /** chatId → 待执行条目（面板展示顺序即投递顺序） */
  const pendingByChat = ref<Record<string, PendingQueueItem[]>>({})
  /** 正在出队投递的聊天（防止同一聊天并发两次出队） */
  const sending = ref<Record<string, boolean>>({})

  let seq = 0
  const makeId = () => `pq-${Date.now().toString(36)}-${(seq++).toString(36)}`

  // ---------------- 持久化 ----------------

  const persist = () => {
    try {
      const out: Record<string, PendingQueueItem[]> = {}
      for (const [chatId, list] of Object.entries(pendingByChat.value)) {
        if (Array.isArray(list) && list.length) out[chatId] = list
      }
      if (Object.keys(out).length) localStorage.setItem(STORAGE_KEY, JSON.stringify(out))
      else localStorage.removeItem(STORAGE_KEY)
    } catch { /* 存储满 / 隐私模式：队列退化为内存态，不影响投递 */ }
  }

  /** 从存储恢复（只保留仍存在的聊天；home 挂载时调用一次） */
  const restoreFromStorage = (knownChatIds: Set<string>) => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw)
      const next: Record<string, PendingQueueItem[]> = {}
      if (parsed && typeof parsed === 'object') {
        for (const [chatId, list] of Object.entries(parsed as Record<string, any>)) {
          if (!knownChatIds.has(chatId) || !Array.isArray(list)) continue
          const items = (list as any[])
            .filter((it) => it && typeof it.text === 'string' && it.text.trim())
            .map((it) => ({
              id: String(it.id || makeId()),
              at: Number(it.at) || Date.now(),
              text: String(it.text),
              display: String(it.display || it.text),
              mode: String(it.mode || 'normal'),
              pinned: !!it.pinned,
              fileAttachments: Array.isArray(it.fileAttachments) ? it.fileAttachments : undefined,
              // 图片只在内存里（data URL 体积大，且重载后原会话已结束，不适合落 localStorage）
            }))
            .slice(0, QUEUE_LIMIT)
          if (items.length) next[chatId] = orderQueue(items)
        }
      }
      pendingByChat.value = next
      persist()
    } catch { /* 存档损坏：忽略 */ }
  }

  // ---------------- 查询 ----------------

  const pendingOf = (chatId: string | undefined): PendingQueueItem[] =>
    (chatId && pendingByChat.value[chatId]) || []

  /** 当前聊天的队列（模板直读） */
  const pending = (): PendingQueueItem[] => pendingOf(deps.getChatId())

  const isSending = (chatId?: string): boolean => !!sending.value[chatId || deps.getChatId() || '']

  const hasPending = (): boolean => pending().length > 0

  /** 该聊天是否「有活要干」：正在投递，或队列里还有条目 */
  const isQueueBusy = (chatId: string | undefined): boolean => {
    if (!chatId) return false
    return !!sending.value[chatId] || (pendingByChat.value[chatId]?.length || 0) > 0
  }

  /** 该聊天队列里是否已有一条「已插队但还没投出去」的条目（面板置顶按钮的选中态） */
  const hasPinned = (chatId?: string): boolean => pendingOf(chatId || deps.getChatId()).some((i) => i.pinned)

  // ---------------- 变更 ----------------

  const writeQueue = (chatId: string, list: PendingQueueItem[]) => {
    pendingByChat.value = { ...pendingByChat.value, [chatId]: list }
    persist()
  }

  /**
   * 入队。`pin=true` 表示插队（Ctrl+Enter）：越过普通排队条目，排在**插队区**末尾
   * （同为先入先出，连续插队不会把后插的顶到最前）。
   */
  const enqueue = (
    item: Omit<PendingQueueItem, 'id' | 'at'> & { id?: string; at?: number },
    opts?: { pin?: boolean },
  ): PendingQueueItem | null => {
    const chatId = deps.getChatId()
    if (!chatId) return null
    const list = pendingOf(chatId)
    if (list.length >= QUEUE_LIMIT) {
      deps.notify?.('待执行队列已满（50 条），请先处理或清空')
      return null
    }
    const entry: PendingQueueItem = {
      ...item,
      id: item.id || makeId(),
      at: item.at || Date.now(),
      pinned: opts?.pin === true ? true : !!item.pinned,
    }
    writeQueue(chatId, orderQueue([...list, entry]))
    return entry
  }

  const removeItem = (id: string, chatId?: string) => {
    const cid = chatId || deps.getChatId()
    if (!cid) return
    writeQueue(cid, pendingOf(cid).filter((it) => it.id !== id))
  }

  /** 批量删除（面板「全部清除」；返回实际删除条数） */
  const removeItems = (ids: string[], chatId?: string): number => {
    const cid = chatId || deps.getChatId()
    if (!cid) return 0
    const set = new Set(ids)
    const list = pendingOf(cid)
    const kept = list.filter((it) => !set.has(it.id))
    writeQueue(cid, kept)
    return list.length - kept.length
  }

  /**
   * 就地编辑队列条目（只改还没投递出去的条目）。
   * 注意：**不重排**——面板顺序是唯一事实源，改正文/附件不该让条目在眼前跳位置。
   */
  const updateItem = (id: string, patch: Partial<Pick<PendingQueueItem, 'text' | 'display' | 'pinned'>>, chatId?: string) => {
    const cid = chatId || deps.getChatId()
    if (!cid) return
    const list = pendingOf(cid).map((it) => (it.id === id ? { ...it, ...patch } : it))
    writeQueue(cid, list)
  }

  /**
   * 切换插队标记（面板 ⚡）。
   * 语义：**只影响投递优先级与时机，不改面板顺序**——插队条目会被优先投递（普通条目等 step
   * 边界信号，插队条目随时可投，但仍然不打断本轮执行）。位置由用户拖动/上下移决定。
   */
  const togglePin = (id: string, chatId?: string) => {
    const cid = chatId || deps.getChatId()
    if (!cid) return
    const target = pendingOf(cid).find((it) => it.id === id)
    if (!target) return
    updateItem(id, { pinned: !target.pinned }, cid)
  }

  /** 拖动排序：按面板给出的完整顺序重写队列（插队区仍保持在最前，由 orderQueue 兜底） */
  const reorder = (ids: string[], chatId?: string) => {
    const cid = chatId || deps.getChatId()
    if (!cid) return
    const list = pendingOf(cid)
    const byId = new Map(list.map((it) => [it.id, it]))
    const next: PendingQueueItem[] = []
    for (const id of ids) {
      const it = byId.get(id)
      if (it) { next.push(it); byId.delete(id) }
    }
    // 面板未覆盖到的（并发新增）按原顺序补在后面
    for (const it of list) if (byId.has(it.id)) next.push(it)
    writeQueue(cid, next)
  }

  /** 上移 / 下移一位（键盘/触屏可用的排序入口） */
  const moveBy = (id: string, delta: number, chatId?: string) => {
    const cid = chatId || deps.getChatId()
    if (!cid) return
    const list = [...pendingOf(cid)]
    const from = list.findIndex((it) => it.id === id)
    if (from < 0) return
    const to = Math.max(0, Math.min(list.length - 1, from + delta))
    if (to === from) return
    const [it] = list.splice(from, 1)
    list.splice(to, 0, it)
    // 用「插队区大小 = 原插队条目数」重建 pinned：手动排序只改顺序，不改变谁插了队；
    // 但跨过插队/排队边界的那一条要跟着换区，否则 orderQueue 会把结果复原。
    const pinnedIds = new Set(pendingOf(cid).filter((i) => i.pinned).map((i) => i.id))
    const isPinnedZone = to < pinnedIds.size
    if (isPinnedZone) pinnedIds.add(id)
    else pinnedIds.delete(id)
    writeQueue(cid, list.map((item) => ({ ...item, pinned: pinnedIds.has(item.id) })))
  }

  const clear = (chatId?: string) => {
    const cid = chatId || deps.getChatId()
    if (!cid) return
    if (!pendingOf(cid).length) return
    writeQueue(cid, [])
  }

  const clearAll = () => {
    pendingByChat.value = {}
    persist()
  }

  // ---------------- 出队 ----------------

  /**
   * 等该聊天「可发送」：每 60ms 轮询，直到 !isChatBusy 或超时。
   * 用于需要「本轮确实收尾了」才能回退为新轮发送的场景。
   */
  const waitForSettle = async (chatId: string) => {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS
    while (deps.isChatBusy(chatId) && Date.now() < deadline) await sleep(POLL_MS)
    return !deps.isChatBusy(chatId)
  }

  /**
   * 尝试把队列里的条目投递出去（这一步由 home 在 step 边界 / 收尾时触发）：
   *
   * 1. 队列空 / 该聊天不是当前对话 / 已在投递中 → 直接返回；
   * 2. 本轮**仍在执行**：挑出**第一条 `canDeliver` 允许**的条目投给运行中的 agent——
   *    `push()` 走 steer 通道，主进程在下一个 step 边界消费（**不打断执行**）。
   *    注意这里不是只看出队首：普通排队条目要等「上一个 step 结束」，若队首被时机卡住，
   *    后面的插队条目可以越过它先投（插队语义），排序结果体现在投递顺序上；
   * 3. 本轮**已收尾**：回退为「新一轮任务」发送（该模式下没有 step 边界，
   *    例如普通聊天 / 知识库 / 工作流，以及 agent 轮刚好结束的情况）。
   *
   * 投递失败或被拒（返回 0）时，该条目按原位置放回队列，等下一次触发重试。
   */
  const flush = async (chatId?: string) => {
    const id = chatId || deps.getChatId()
    if (!id) return
    if (sending.value[id]) return
    while (pendingOf(id).length) {
      // 当前聊天才能发（投递与发送函数内部都基于 currentChat）
      if (!(deps.canFlush ? deps.canFlush(id) : id === deps.getChatId())) return
      const list = pendingOf(id)
      const busy = deps.isChatBusy(id)
      // 运行中：挑第一条时机已到的条目（队首被卡住时允许后面的插队条目越过）；都没到就等下次触发
      const idx = busy ? list.findIndex((it) => deps.canDeliver(id, it)) : 0
      if (idx < 0) return
      const item = list[idx]
      if (!item) return

      sending.value = { ...sending.value, [id]: true }
      // 先落盘移除，避免中途页面关闭导致重复投递
      writeQueue(id, list.filter((_, i) => i !== idx))
      let failed = false
      try {
        if (busy) {
          const delivered = await deps.push(id, item)
          if (!delivered) {
            // 没有可接收的会话（本轮刚好收尾 / 正在停止）：条目按原位置放回等重试
            const rest = pendingOf(id)
            writeQueue(id, [...rest.slice(0, idx), item, ...rest.slice(idx)])
            failed = true
          }
        } else {
          await deps.sendAsNewTurn(id, item)
        }
        if (!failed) deps.onAfterSend?.()
      } catch (e) {
        console.warn('[pending-queue] 出队失败，条目保留在队列中:', e)
        const rest = pendingOf(id)
        writeQueue(id, [...rest.slice(0, idx), item, ...rest.slice(idx)])
        failed = true
      } finally {
        const s = { ...sending.value }
        delete s[id]
        sending.value = s
      }
      // 失败则停止本轮出队，等下一次触发（step 边界 / 收尾 / 用户操作）再重试
      if (failed) return
      // 投递成功后：只有本轮已收尾（busy=false）时才继续发下一条；
      // 运行中的多条目由后续 step 边界逐个投递，避免抢跑成没人监听的游离 turn。
      if (busy) return
    }
  }

  return {
    pendingByChat: pendingByChat as Ref<Record<string, PendingQueueItem[]>>,
    pending,
    pendingOf,
    hasPending,
    hasPinned,
    isQueueBusy,
    isSending,
    enqueue,
    removeItem,
    removeItems,
    updateItem,
    togglePin,
    reorder,
    moveBy,
    clear,
    clearAll,
    flush,
    waitForSettle,
    restoreFromStorage,
    persist,
    QUEUE_LIMIT,
    STORAGE_KEY,
  }
}
