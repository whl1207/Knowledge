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

import { reactive } from 'vue'
import type {
  SwarmRoom, SwarmTask, SwarmMessage, SwarmTeamMember, SwarmEpisode, SwarmArtifact,
  SwarmTaskStatus, SwarmEpisodeStatus,
} from '@/types/swarmRoom'
import { nextTaskId, initialStatus, validateCreate, isTerminal } from '@/lib/agent/teamProtocol'

const DEFAULT_MAX_INFLIGHT = 3

const rooms = reactive<Record<string, SwarmRoom>>({})

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
  let r = rooms[chatId]
  if (!r) {
    r = rooms[chatId] = {
      chatId, members: [], tasks: [], messages: [], artifacts: [], episode: null, maxInflight: DEFAULT_MAX_INFLIGHT,
    }
  }
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

export function endEpisode(room: SwarmRoom, status: SwarmEpisodeStatus = 'done'): void {
  if (!room.episode) return
  room.episode.status = status
  room.episode.endedAt = Date.now()
}

/** 清空当前回合的协议数据（保留名册） */
export function clearEpisodeData(room: SwarmRoom): void {
  room.tasks = []
  room.messages = []
  room.artifacts = []
  room.episode = null
}

export function resetRoom(chatId: string): void {
  delete rooms[chatId]
}
