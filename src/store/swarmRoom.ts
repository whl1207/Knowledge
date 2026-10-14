/**
 * swarmRoom.ts — Agent Teams 房间状态（**渲染层事实源**）
 *
 * 与 swarmState.ts 的区别：
 * - `swarmState` 是「当前运行」的运行态（消息/步骤/状态投影）；
 * - `swarmRoom` 是「房间」的**协议事实源**（名册 / 任务板 / 协议消息 / 回合）。
 *
 * 主进程协议工具（team-tools.ts）经 `agent/renderer-task` 调用本模块，
 * 因此所有群聊语义都只在这里发生（单一事实源）。
 */

import { reactive, watch } from 'vue'
import type {
  SwarmRoom, SwarmTask, SwarmMessage, SwarmTeamMember, SwarmEpisode, SwarmArtifact,
  SwarmTaskStatus, SwarmEpisodeStatus, SwarmEpisodeSnapshot, SwarmBoard,
} from '@/types/swarmRoom'
import { nextTaskId, initialStatus, validateCreate, isTerminal } from '@/lib/agent/teamProtocol'
import { chatsRef } from '@/store/chats'

const DEFAULT_MAX_INFLIGHT = 3

const rooms = reactive<Record<string, SwarmRoom>>({})

// ---------------------------------------------------------------------------
// 回合归档 + 持久化
//
// 两个必须一起做的修复：
// 1) **回合结束不清空**：`endEpisode` 只标记状态。以前任何一处“收尾顺手清任务板”都会让
//    用户刚跑完的泳道瞬间变空，任务过程再也看不到。
// 2) **房间要落盘**：房间只活在渲染层内存里，页面刷新（重启应用 / 开发期整页热更新）就全没了——
//    表现同样是“跑完泳道就没了”。这里按对话存档到 localStorage，并在模块加载时恢复。
//
// 新回合开始时把上一回合**归档**进 history（工作台可切回去看），而不是删掉：
// 「任务属于 Episode、不跨回合累积」与「任务过程要留着回看」两条同时成立。
// ---------------------------------------------------------------------------

/** 存档键（与 ai-chats 分开：集群房间是自己的工作台状态，不参与聊天记录导入导出） */
const ROOMS_KEY = 'ai-swarm-rooms'
/** 每个房间保留的历史回合上限（localStorage 容量有限，只留最近几回合） */
const MAX_HISTORY = 8
/** 存档里的长文本上限（任务描述 / 消息正文 / 任务结论） */
const MAX_TEXT = 4000
/** 落盘防抖：运行中 token / 工具次数变化频繁，别每次都 stringify 整张表 */
const PERSIST_DEBOUNCE_MS = 1200

/** 无内容的房间不落盘（每个项目组对话挂载时都会 ensureRoom 出一个空房间） */
function hasContent(r: SwarmRoom): boolean {
  return !!r.episode || r.tasks.length > 0 || r.messages.length > 0 || r.artifacts.length > 0 || r.history.length > 0
}

function clipText(s: unknown, max = MAX_TEXT): string | undefined {
  if (typeof s !== 'string') return undefined
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 存档用的精简副本：去掉会话 id / 暂存消息，长文本截断（导出供自测使用） */
export function serializeRoom(r: SwarmRoom): any {
  const member = (m: SwarmTeamMember) => ({ ...m, sessionId: undefined, pending: undefined })
  const task = (t: SwarmTask) => ({ ...t, prompt: clipText(t.prompt) ?? '', output: clipText(t.output) })
  const msg = (m: SwarmMessage) => ({ ...m, summary: clipText(m.summary, 500) ?? '', content: clipText(m.content) })
  return {
    chatId: r.chatId,
    maxInflight: r.maxInflight,
    episode: r.episode,
    members: r.members.map(member),
    tasks: r.tasks.map(task),
    messages: r.messages.map(msg),
    artifacts: r.artifacts,
    history: r.history.slice(-MAX_HISTORY).map((h) => ({
      episode: h.episode,
      members: h.members.map(member),
      tasks: h.tasks.map(task),
      messages: h.messages.map(msg),
      artifacts: h.artifacts,
    })),
  }
}

/** 恢复成员：会话 id 重启后必然失效（清掉），运行中的成员复位成 idle */
function restoreMember(m: any): SwarmTeamMember {
  return {
    ...m,
    sessionId: undefined,
    pending: [],
    status: m?.status === 'running' ? 'idle' : (m?.status || 'idle'),
    currentTaskId: undefined,
  }
}

/**
 * 恢复任务：**当前回合**里「运行中」的任务复位成 ready（配合任务页的「继续未完成任务」）；
 * 历史回合里同样状态的复位成 cancelled（那次运行确实被中断了，不能再假装它 ready 可跑）。
 */
function restoreTask(t: any, live: boolean): SwarmTask {
  const interrupted = t?.status === 'running'
  return {
    ...t,
    status: interrupted ? (live ? 'ready' : 'cancelled') : (t?.status || 'pending'),
    startedAt: interrupted ? undefined : t?.startedAt,
    endedAt: interrupted && !live ? (t?.endedAt || Date.now()) : t?.endedAt,
  }
}

/** 从存档恢复一个房间（导出供自测使用） */
export function restoreRoom(raw: any): SwarmRoom | null {
  if (!raw || typeof raw !== 'object' || !raw.chatId) return null
  const episode: SwarmEpisode | null = raw.episode
    ? { ...raw.episode, status: raw.episode.status === 'running' ? 'aborted' : raw.episode.status }
    : null
  const history: SwarmEpisodeSnapshot[] = (Array.isArray(raw.history) ? raw.history : [])
    .filter((h: any) => h && h.episode && h.episode.id)
    .slice(-MAX_HISTORY)
    .map((h: any) => ({
      episode: { ...h.episode, status: h.episode.status === 'running' ? 'aborted' : h.episode.status },
      members: (Array.isArray(h.members) ? h.members : []).map(restoreMember),
      tasks: (Array.isArray(h.tasks) ? h.tasks : []).map((t: any) => restoreTask(t, false)),
      messages: Array.isArray(h.messages) ? h.messages : [],
      artifacts: Array.isArray(h.artifacts) ? h.artifacts : [],
    }))
  const maxInflight = Number(raw.maxInflight)
  return {
    chatId: String(raw.chatId),
    members: (Array.isArray(raw.members) ? raw.members : []).map(restoreMember),
    tasks: (Array.isArray(raw.tasks) ? raw.tasks : []).map((t: any) => restoreTask(t, true)),
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    artifacts: Array.isArray(raw.artifacts) ? raw.artifacts : [],
    episode,
    history,
    maxInflight: Number.isFinite(maxInflight) && maxInflight > 0 ? Math.min(8, Math.max(1, maxInflight)) : DEFAULT_MAX_INFLIGHT,
  }
}

let hydrated = false
/** 从 localStorage 恢复房间（模块加载时调用一次；函数内幂等） */
function hydrateRooms(): void {
  if (hydrated) return
  hydrated = true
  if (typeof localStorage === 'undefined') return
  let raw: any = null
  try { raw = JSON.parse(localStorage.getItem(ROOMS_KEY) || 'null') } catch { raw = null }
  if (!raw || typeof raw !== 'object') return
  for (const [chatId, item] of Object.entries<any>(raw)) {
    const room = restoreRoom({ ...(item && typeof item === 'object' ? item : {}), chatId: item?.chatId || chatId })
    if (!room) continue
    rooms[room.chatId] = room
    // 计数器跟上已恢复的数据，避免恢复后新消息 / 新回合撞 id
    for (const m of room.messages) bumpCounter(m.id, 'm', (n) => { if (n > msgCounter) msgCounter = n })
    if (room.episode) bumpCounter(room.episode.id, 'ep', (n) => { if (n > episodeCounter) episodeCounter = n })
    for (const h of room.history) bumpCounter(h.episode.id, 'ep', (n) => { if (n > episodeCounter) episodeCounter = n })
  }
}

function bumpCounter(id: unknown, prefix: string, apply: (n: number) => void): void {
  const s = String(id ?? '')
  if (!s.startsWith(prefix)) return
  const n = Number(s.slice(prefix.length))
  if (Number.isFinite(n)) apply(n)
}

let persistTimer: ReturnType<typeof setTimeout> | null = null
function schedulePersist(): void {
  if (typeof localStorage === 'undefined') return
  if (persistTimer) return
  persistTimer = setTimeout(() => { persistTimer = null; persistRooms() }, PERSIST_DEBOUNCE_MS)
}

/** 立即落盘（防抖到期 / 页面卸载前调用） */
export function persistRooms(): void {
  if (typeof localStorage === 'undefined') return
  try {
    // 对话已被删除的房间一并不再保留，避免存档无限增长（对话列表还没加载时不删）
    const known = new Set((chatsRef.value || []).map((c: any) => String(c?.id || '')).filter(Boolean))
    const out: Record<string, any> = {}
    for (const [chatId, room] of Object.entries(rooms)) {
      if (!room || !hasContent(room)) continue
      if (known.size && !known.has(chatId)) continue
      out[chatId] = serializeRoom(room)
    }
    localStorage.setItem(ROOMS_KEY, JSON.stringify(out))
  } catch (e) {
    // 容量超限 / 序列化失败：不影响运行，下次变更再试
    console.warn('[swarmRoom] 房间存档失败:', e)
  }
}

/**
 * 归档当前回合：把任务板 / 名册 / 协议消息 / 产出物整体存进 history，然后清空「当前回合」。
 * 只在**新回合开始**时调用——回合结束（endEpisode）不做任何清理，泳道要留着。
 */
export function archiveEpisode(room: SwarmRoom): void {
  const ep = room.episode
  if (!ep) return
  if (!room.tasks.length && !room.messages.length && !room.artifacts.length) {
    room.episode = null
    return
  }
  room.history = [
    ...room.history,
    {
      episode: { ...ep, status: ep.status === 'running' ? 'aborted' : ep.status, endedAt: ep.endedAt || Date.now() },
      members: room.members.map((m) => ({ ...m, sessionId: undefined, pending: [] })),
      tasks: room.tasks.map((t) => ({ ...t })),
      messages: room.messages.map((m) => ({ ...m })),
      artifacts: room.artifacts.map((a) => ({ ...a })),
    },
  ].slice(-MAX_HISTORY)
  room.tasks = []
  room.messages = []
  room.artifacts = []
  room.episode = null
}

/** 当前回合的 id（无回合返回 ''） */
export function currentEpisodeId(room: SwarmRoom | null | undefined): string {
  return room?.episode?.id || ''
}

/**
 * 工作台要展示的回合视图：`episodeId` 缺省 = 当前回合；
 * 传历史回合 id 时返回该回合的快照（`live:false`，只读回看）。
 * 当前回合为空但存在历史（例如归档后崩在开新回合之前）时回退到最后一个历史回合。
 */
export function boardOf(room: SwarmRoom | null | undefined, episodeId?: string | null): SwarmBoard | null {
  if (!room) return null
  const liveId = room.episode?.id || ''
  const want = String(episodeId || '')
  if (want && want !== liveId) {
    const snap = room.history.find((h) => h.episode.id === want)
    if (snap) {
      return { episode: snap.episode, members: snap.members, tasks: snap.tasks, messages: snap.messages, artifacts: snap.artifacts, live: false }
    }
  }
  if (!room.episode && room.history.length) {
    const snap = room.history[room.history.length - 1]
    return { episode: snap.episode, members: snap.members, tasks: snap.tasks, messages: snap.messages, artifacts: snap.artifacts, live: false }
  }
  return { episode: room.episode, members: room.members, tasks: room.tasks, messages: room.messages, artifacts: room.artifacts, live: true }
}

/** 当前回合 + 历史回合（工作台的回合切换器：新的在前） */
export function episodeList(room: SwarmRoom | null | undefined): Array<{ id: string; goal: string; status: SwarmEpisodeStatus; startedAt: number; endedAt?: number; live: boolean; taskCount: number }> {
  if (!room) return []
  const live = room.episode
    ? [{ id: room.episode.id, goal: room.episode.goal, status: room.episode.status, startedAt: room.episode.startedAt, endedAt: room.episode.endedAt, live: true, taskCount: room.tasks.length }]
    : []
  const past = room.history
    .map((h) => ({ id: h.episode.id, goal: h.episode.goal, status: h.episode.status, startedAt: h.episode.startedAt, endedAt: h.episode.endedAt, live: false, taskCount: h.tasks.length }))
    .reverse()
  return [...live, ...past]
}

/** 只读访问全部房间（工作台按 chatId 取用） */
export function allRooms(): Record<string, SwarmRoom> {
  return rooms
}

export function roomOf(chatId: string | null | undefined): SwarmRoom | null {
  if (!chatId) return null
  return rooms[chatId] || null
}

/** 确保房间存在；传 members 时重建名册（保留已有会话/状态以兼容重复调用） */
export function ensureRoom(chatId: string, members?: SwarmTeamMember[]): SwarmRoom {
  hydrateRooms()
  let r = rooms[chatId]
  if (!r) {
    r = rooms[chatId] = {
      chatId, members: [], tasks: [], messages: [], artifacts: [], episode: null, history: [], maxInflight: DEFAULT_MAX_INFLIGHT,
    }
  }
  if (!Array.isArray(r.history)) r.history = []
  if (members && members.length) {
    const prev = new Map(r.members.map((m) => [m.name, m]))
    r.members = members.map((m) => ({ ...m, ...(prev.get(m.name) || {}) , idx: m.idx, name: m.name, role: m.role }))
  }
  return r
}

/** 由「名称/角色」清单构建名册（用于 applyMembers 之后同步） */
export function buildMembers(src: Array<{ name: string; role?: string; model?: string }>): SwarmTeamMember[] {
  return src.map((s, i) => ({
    idx: i,
    name: s.name || `A${i + 1}`,
    role: s.role || '',
    model: s.model,
    status: 'idle',
    recentTools: [],
  }))
}

// ---------------------------------------------------------------------------
// 名册
// ---------------------------------------------------------------------------

export function findMemberByName(room: SwarmRoom, name: string): SwarmTeamMember | undefined {
  return room.members.find((m) => m.name === name)
}

/** 由 agent 会话 id 反查成员（协议工具据此判断"谁在调用"） */
export function findMemberBySession(room: SwarmRoom, sessionId: string | undefined): SwarmTeamMember | undefined {
  if (!sessionId) return undefined
  return room.members.find((m) => m.sessionId === sessionId)
}

export function setMemberSession(room: SwarmRoom, idx: number, sessionId: string | undefined): void {
  const m = room.members.find((x) => x.idx === idx)
  if (m) m.sessionId = sessionId
}

export function setMemberStatus(
  room: SwarmRoom, idx: number, status: SwarmTeamMember['status'],
  patch: Partial<SwarmTeamMember> = {},
): void {
  const m = room.members.find((x) => x.idx === idx)
  if (m) Object.assign(m, { status, lastActiveAt: Date.now() }, patch)
}

/** 累计 token 用量（对齐 cc-haha 活动面板的 token 指标） */
export function noteMemberTokens(room: SwarmRoom, idx: number, delta: number): void {
  const m = room.members.find((x) => x.idx === idx)
  if (!m || !delta) return
  m.tokensTotal = (m.tokensTotal || 0) + delta
  m.lastActiveAt = Date.now()
}

/** 记录一次工具调用（工作台"最近活动"） */
export function noteMemberTool(room: SwarmRoom, idx: number, toolName: string): void {
  const m = room.members.find((x) => x.idx === idx)
  if (!m) return
  m.toolCount = (m.toolCount || 0) + 1
  m.recentTools = [toolName, ...(m.recentTools || [])].slice(0, 5)
  m.lastActiveAt = Date.now()
}

// ---------------------------------------------------------------------------
// 协议消息
// ---------------------------------------------------------------------------

let msgCounter = 0

export function pushMessage(
  room: SwarmRoom,
  partial: Omit<SwarmMessage, 'id' | 'ts' | 'episodeId' | 'delivered'> & { delivered?: boolean },
): SwarmMessage {
  const m: SwarmMessage = {
    id: `m${++msgCounter}`,
    ts: Date.now(),
    episodeId: room.episode?.id || 'ep0',
    delivered: false,
    ...partial,
  }
  room.messages.push(m)
  return m
}

/** 登记一个产出物（并挂到对应任务的 artifactRefs） */
export function addArtifact(room: SwarmRoom, art: Omit<SwarmArtifact, 'at'>): SwarmArtifact {
  if (!Array.isArray(room.artifacts)) room.artifacts = []
  const item: SwarmArtifact = { ...art, at: Date.now() }
  room.artifacts.push(item)
  if (art.taskId) {
    const t = room.tasks.find((x) => x.id === art.taskId)
    if (t) t.artifactRefs = [...(t.artifactRefs || []), art.name]
  }
  return item
}

/** 未投递消息数（回合终止判定用） */
export function inflightMessageCount(room: SwarmRoom): number {
  return room.messages.filter((m) => !m.delivered).length
}

// ---------------------------------------------------------------------------
// 任务板
// ---------------------------------------------------------------------------

/** 依赖满足时把 pending → ready（看板可读性；调度本身靠 readyTaskIds 判定） */
function promoteDependents(room: SwarmRoom): void {
  const done = new Set(room.tasks.filter((t) => t.status === 'done').map((t) => t.id))
  for (const t of room.tasks) {
    if (t.status === 'pending' && t.deps.length && t.deps.every((d) => done.has(d))) t.status = 'ready'
  }
}

export function createTask(
  room: SwarmRoom,
  input: { title?: string; prompt?: string; assignee?: number | string; deps?: string[]; background?: boolean },
): { ok: true; task: SwarmTask } | { ok: false; error: string } {
  const v = validateCreate(input, {
    memberCount: room.members.length,
    memberNames: room.members.map((m) => m.name),
    existing: room.tasks,
  })
  if (!v.ok) return v
  const deps = (input.deps || []).map(String)
  const task: SwarmTask = {
    id: nextTaskId(room.tasks),
    episodeId: room.episode?.id || 'ep0',
    title: String(input.title).trim(),
    prompt: String(input.prompt).trim(),
    assignee: v.assignee,
    deps,
    status: initialStatus(deps),
    background: !!input.background,
    createdAt: Date.now(),
  }
  room.tasks.push(task)
  promoteDependents(room)
  return { ok: true, task }
}

export function updateTask(
  room: SwarmRoom,
  input: { id?: string; status?: SwarmTaskStatus; output?: string; assignee?: number },
  actorIdx?: number,
): { ok: true; task: SwarmTask } | { ok: false; error: string } {
  const t = room.tasks.find((x) => x.id === input.id)
  if (!t) return { ok: false, error: `任务不存在：${input.id}` }
  // 成员只能改自己名下的任务；Lead（actorIdx undefined/-1）不受限
  if (actorIdx !== undefined && actorIdx >= 0 && t.assignee !== undefined && t.assignee !== actorIdx) {
    return { ok: false, error: `无权修改他人任务（${t.id} 属于成员 #${t.assignee}）` }
  }
  if (input.status) {
    t.status = input.status
    if (input.status === 'running' && !t.startedAt) t.startedAt = Date.now()
    if (isTerminal(input.status)) t.endedAt = Date.now()
  }
  if (input.output !== undefined) t.output = String(input.output).slice(0, 2000)
  if (input.assignee !== undefined) t.assignee = Number(input.assignee)
  if (input.status === 'done') promoteDependents(room)
  return { ok: true, task: t }
}

export function claimTask(
  room: SwarmRoom, id?: string, actorIdx?: number,
): { ok: true; task: SwarmTask } | { ok: false; error: string } {
  const t = room.tasks.find((x) => x.id === id)
  if (!t) return { ok: false, error: `任务不存在：${id}` }
  if (actorIdx === undefined || actorIdx < 0) return { ok: false, error: '只有成员可以认领任务' }
  if (t.assignee !== undefined && t.assignee !== actorIdx) {
    return { ok: false, error: `任务已被成员 #${t.assignee} 认领` }
  }
  t.assignee = actorIdx
  return { ok: true, task: t }
}

export function deleteTask(room: SwarmRoom, id?: string): { ok: true } | { ok: false; error: string } {
  const i = room.tasks.findIndex((x) => x.id === id)
  if (i < 0) return { ok: false, error: `任务不存在：${id}` }
  room.tasks.splice(i, 1)
  // 清理其它任务的依赖引用
  for (const t of room.tasks) t.deps = t.deps.filter((d) => d !== id)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 回合
// ---------------------------------------------------------------------------

let episodeCounter = 0

export function startEpisode(room: SwarmRoom, goal: string, leadIdx: number): SwarmEpisode {
  // 新回合开始：先把上一回合**归档**（不是删除）——任务板不该跨回合累积，
  // 但上一回合的任务过程要能在工作台切回去看（用户明确要求「跑完别把泳道删掉」）。
  if (room.episode) archiveEpisode(room)
  const ep: SwarmEpisode = {
    id: `ep${++episodeCounter}`,
    chatId: room.chatId,
    leadIdx,
    goal,
    status: 'running',
    startedAt: Date.now(),
  }
  room.episode = ep
  return ep
}

/**
 * 回合结束：**只标记状态，不清任何数据**。
 * 泳道 / 任务板 / 通信 / 产出物全部留在房间里（并随房间落盘），方便回看任务过程。
 * ⚠️ 不要在回合结束时调用 clearEpisodeData / archiveEpisode：那正是「跑完泳道就空了」的来源。
 */
export function endEpisode(room: SwarmRoom, status: SwarmEpisodeStatus = 'done'): void {
  if (!room.episode) return
  room.episode.status = status
  room.episode.endedAt = Date.now()
  schedulePersist()
}

/**
 * 清空当前回合的协议数据（保留名册）。
 *
 * ⚠️ 只在「确实要丢弃当前回合」时使用（当前无调用方）。回合正常结束请用 endEpisode()；
 * 开新回合请用 startEpisode()（它内部走 archiveEpisode 归档）。
 */
export function clearEpisodeData(room: SwarmRoom): void {
  room.tasks = []
  room.messages = []
  room.artifacts = []
  room.episode = null
}

export function resetRoom(chatId: string): void {
  delete rooms[chatId]
  try { persistRooms() } catch { /* 忽略 */ }
}

// ---------------------------------------------------------------------------
// 启动：恢复存档 + 监听变更落盘
// ---------------------------------------------------------------------------

hydrateRooms()
if (typeof window !== 'undefined') {
  // 房间是 reactive 的，深度监听 + 防抖落盘：任何任务/消息/名册变化都会被记住
  watch(rooms, () => { schedulePersist() }, { deep: true })
  // 页面卸载前把还没到点的变更立刻写下（否则「跑完最后一步就刷新」会丢掉尾巴）
  window.addEventListener('beforeunload', () => {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null }
    persistRooms()
  })
}

