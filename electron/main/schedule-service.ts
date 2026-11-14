/**
 * schedule-service.ts — 自动化任务（主进程：持久化 + 计时 + 投递）
 *
 * 复刻 DSH `dsh-schedule` 的核心契约，去掉 AI-KM 用不上的部分：
 *
 * - **任务 = 指令 + 时间 + 目的地**，不存执行结果；投递只证明「进了收件箱」，不代表模型执行成功；
 * - 时间规则七种收敛为六种（at / every / daily / weekly / cron / rrule），见 `@/shared/scheduleTime`；
 * - 目的地三种：`chat`（复用已有聊天）、`new_chat_once`（首次投递时建聊天，之后复用）、`new_chat`（每次新建）；
 * - **错过只补最近一次**：触发后把 `scheduledAt` 直接推进到「现在之后的第一次」，中间错过的合并；
 * - 投递先写 `pending`（崩溃/重启后仍在），渲染层入队成功后 `ack` 才写回执 —— at-least-once；
 * - 编辑带 `expectedUpdatedAt` 做 CAS（冲突返回 `schedule_conflict`），暂停/恢复不丢规则；
 * - 目标聊天归档时删除其任务（`disposeForChat`），删除任务不撤回已投递的消息；
 * - 存储：`<userData>/schedules.json`（原子写、宿主打开时整体载入内存校验）。
 *
 * 与 DSH 的差异（AI-KM 的架构决定）：真正「执行」必须由渲染层的 Agent 循环发起
 * （LLM 配置在渲染层），所以这里只负责到点把指令送进目标聊天的收件箱；
 * 窗口不在时投递保持 pending，下次启动由渲染层补投。
 */

import { app } from 'electron'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from './atomic-write'
import {
  describeTiming,
  nextOccurrence,
  normalizeTiming,
  type ScheduleTiming,
} from '@/shared/scheduleTime'

const FILE_NAME = 'schedules.json'
const VERSION = 1
const MAX_HISTORY = 200
/** 同一任务两次投递之间的最小间隔（DSH 默认 60s；`every` 的 60s 下限已由 timing 保证） */
const MIN_DELIVERY_GAP_MS = 60_000

export type ScheduleTargetKind = 'chat' | 'new_chat_once' | 'new_chat'

export interface ScheduleTarget {
  kind: ScheduleTargetKind
  /** kind='chat' 必有；new_chat_once 首次投递后回填 */
  chatId?: string
  /** 新建聊天时套用的模板（模型配置 / 工作区快照，渲染层创建时用） */
  chatTemplate?: {
    workspace?: string
    noWorkspace?: boolean
    config?: Record<string, any>
  }
  /** 新聊天标题（空 = 用任务标题） */
  title?: string
}

export interface ScheduleReceipt {
  scheduledAt: string
  deliveredAt: string
  chatId?: string
  /** 投递内容快照（之后改任务不影响历史） */
  prompt: string
}

export interface SchedulePending {
  scheduledAt: string
  createdAt: string
  chatId?: string
  prompt: string
  title: string
  target: ScheduleTarget
}

export interface ScheduleTask {
  id: string
  title: string
  prompt: string
  timing: ScheduleTiming
  target: ScheduleTarget
  status: 'active' | 'paused' | 'ended'
  /** 已提交的下一次发生时刻（UTC ISO） */
  scheduledAt: string
  createdAt: string
  updatedAt: string
  lastDelivery?: ScheduleReceipt
  deliveryHistory: ScheduleReceipt[]
  /** 尚未被渲染层确认的投递（at-least-once；下次启动补投） */
  pending?: SchedulePending | null
}

export interface ScheduleError {
  ok: false
  code: string
  message: string
}

export type ScheduleResult<T> = ({ ok: true } & T) | ScheduleError

function filePath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

function nowIso(): string {
  return new Date().toISOString()
}

function newId(): string {
  return `sch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

// ---------------- 内存状态 ----------------

let tasks: ScheduleTask[] = []
let loaded = false
/** 广播回调（由 ipc 层注入，避免与服务层互相 import 成环） */
let broadcast: (channel: string, payload: unknown) => void = () => {}
let timer: ReturnType<typeof setTimeout> | null = null

export function setScheduleBroadcast(fn: (channel: string, payload: unknown) => void): void {
  broadcast = typeof fn === 'function' ? fn : () => {}
}

function emitChanged(): void {
  try {
    broadcast('schedule:changed', { at: nowIso() })
  } catch { /* 广播失败不影响任务 */ }
}

function emitDeliver(task: ScheduleTask, pending: SchedulePending): void {
  try {
    broadcast('schedule:deliver', { taskId: task.id, title: task.title, occurrences: [pending] })
  } catch { /* 忽略 */ }
}

// ---------------- 存储 ----------------

function sanitizeTarget(input: any): ScheduleTarget | null {
  const kind = String(input?.kind || '')
  if (kind !== 'chat' && kind !== 'new_chat_once' && kind !== 'new_chat') return null
  const chatId = typeof input?.chatId === 'string' && input.chatId.trim() ? input.chatId.trim() : undefined
  if (kind === 'chat' && !chatId) return null
  const tpl = input?.chatTemplate && typeof input.chatTemplate === 'object' ? input.chatTemplate : undefined
  return { kind, ...(chatId ? { chatId } : {}), ...(tpl ? { chatTemplate: tpl } : {}), ...(typeof input?.title === 'string' ? { title: input.title } : {}) }
}

function decodeTask(raw: any): ScheduleTask | null {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.id || '').trim()
  const title = String(raw.title || '').trim()
  const prompt = String(raw.prompt || '').trim()
  if (!id || !title || !prompt) return null
  const timingCheck = normalizeTiming(raw.timing)
  if (!timingCheck.ok || !timingCheck.timing) return null
  const target = sanitizeTarget(raw.target)
  if (!target) return null
  const status = raw.status === 'paused' || raw.status === 'ended' ? raw.status : 'active'
  const scheduledAt = typeof raw.scheduledAt === 'string' && Number.isFinite(Date.parse(raw.scheduledAt))
    ? new Date(raw.scheduledAt).toISOString()
    : new Date(nextOccurrence(timingCheck.timing, Date.now()) || Date.now()).toISOString()
  const history: ScheduleReceipt[] = Array.isArray(raw.deliveryHistory)
    ? raw.deliveryHistory.filter((r: any) => r && typeof r.scheduledAt === 'string').slice(-MAX_HISTORY)
    : []
  return {
    id,
    title,
    prompt,
    timing: timingCheck.timing,
    target,
    status,
    scheduledAt,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
    ...(raw.lastDelivery && typeof raw.lastDelivery === 'object' ? { lastDelivery: raw.lastDelivery } : {}),
    deliveryHistory: history,
    ...(raw.pending && typeof raw.pending === 'object' ? { pending: raw.pending } : {}),
  }
}

export async function loadSchedules(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const text = await fsp.readFile(filePath(), 'utf8')
    const parsed = JSON.parse(text)
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.tasks) ? parsed.tasks : [])
    tasks = (list as any[]).map((raw) => decodeTask(raw)).filter((t): t is ScheduleTask => !!t)
  } catch (e: any) {
    if (e?.code !== 'ENOENT') {
      console.warn('[schedule] 读取任务文件失败，按空任务启动:', e)
      try { await fsp.copyFile(filePath(), `${filePath()}.corrupt-${Date.now()}`) } catch { /* 忽略 */ }
    }
    tasks = []
  }
  armTimer()
}

async function persist(): Promise<void> {
  try {
    await fsp.mkdir(app.getPath('userData'), { recursive: true }).catch(() => {})
    await atomicWrite(filePath(), JSON.stringify({ version: VERSION, savedAt: nowIso(), tasks }))
  } catch (e) {
    console.error('[schedule] 写入失败:', e)
  }
}

// ---------------- 计时 ----------------

function armTimer(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const next = tasks
    .filter((t) => t.status === 'active')
    .map((t) => Date.parse(t.scheduledAt))
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b)[0]
  if (!next) return
  const delay = Math.max(0, Math.min(next - Date.now(), 2 ** 31 - 1))
  timer = setTimeout(() => {
    timer = null
    void fireDue()
  }, delay)
  // 主进程退出时不要因为这个定时器挂住
  if (typeof (timer as any)?.unref === 'function') (timer as any).unref()
}

/** 触发所有到点任务（错过只补最近一次：推进到「现在之后」的第一次） */
export async function fireDue(): Promise<void> {
  await loadSchedules()
  const now = Date.now()
  let changed = false
  for (const task of tasks) {
    if (task.status !== 'active') continue
    const at = Date.parse(task.scheduledAt)
    if (!Number.isFinite(at) || at > now) continue
    const occurrenceIso = new Date(at).toISOString()
    const pending: SchedulePending = {
      scheduledAt: occurrenceIso,
      createdAt: nowIso(),
      prompt: task.prompt,
      title: task.title,
      target: { ...task.target },
    }
    // 同一任务连错多次也只保留最近一次待投递
    task.pending = pending
    changed = true
    // 推进到下一次（中间错过的全部合并）
    let next = nextOccurrence(task.timing, now)
    // 最小投递间隔（`new_chat` 每次新建会话更贵，DSH 同样有间隔）
    for (let i = 0; next && i < 5; i++) {
      const last = task.lastDelivery ? Date.parse(task.lastDelivery.deliveredAt) : 0
      if (!last || next - last >= MIN_DELIVERY_GAP_MS) break
      next = nextOccurrence(task.timing, Math.max(next, last + MIN_DELIVERY_GAP_MS))
    }
    if (next) task.scheduledAt = new Date(next).toISOString()
    else task.status = 'ended'
    task.updatedAt = nowIso()
    emitDeliver(task, pending)
  }
  if (changed) {
    await persist()
    emitChanged()
  }
  armTimer()
}

// ---------------- 查询 ----------------

export function listTasks(query: { active?: boolean; limit?: number; offset?: number } = {}) {
  const limit = Math.max(1, Math.min(500, Number(query.limit) || 100))
  const offset = Math.max(0, Number(query.offset) || 0)
  let list = tasks.slice()
  if (query.active === true) list = list.filter((t) => t.status === 'active')
  if (query.active === false) list = list.filter((t) => t.status !== 'active')
  list.sort((a, b) => {
    const aActive = a.status === 'active' ? 0 : 1
    const bActive = b.status === 'active' ? 0 : 1
    if (aActive !== bActive) return aActive - bActive
    if (aActive === 0) return Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt)
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  })
  return { items: list.slice(offset, offset + limit), total: list.length, limit, offset }
}

export function viewTask(id: string): ScheduleResult<{ task: ScheduleTask }> {
  const task = tasks.find((t) => t.id === id)
  if (!task) return { ok: false, code: 'schedule_not_found', message: '任务不存在' }
  return { ok: true, task }
}

export function taskHistory(id: string, limit = 50) {
  const task = tasks.find((t) => t.id === id)
  if (!task) return { ok: false as const, code: 'schedule_not_found', message: '任务不存在' }
  const n = Math.max(1, Math.min(MAX_HISTORY, Number(limit) || 50))
  return { ok: true as const, records: task.deliveryHistory.slice(-n).reverse() }
}

/** 尚未被渲染层确认的投递（启动时 / 窗口恢复后补投） */
export function pendingDeliveries(): Array<{ taskId: string; title: string; pending: SchedulePending }> {
  return tasks
    .filter((t) => !!t.pending)
    .map((t) => ({ taskId: t.id, title: t.title, pending: t.pending as SchedulePending }))
}

// ---------------- 增删改 ----------------

function validateBasics(title: string, prompt: string): ScheduleError | null {
  if (!title.trim()) return { ok: false, code: 'schedule_input_invalid', message: '标题不能为空' }
  if (title.trim().length > 120) return { ok: false, code: 'schedule_input_invalid', message: '标题最多 120 字' }
  if (!prompt.trim()) return { ok: false, code: 'schedule_input_invalid', message: '指令不能为空' }
  return null
}

export interface CreateInput {
  title: string
  prompt: string
  timing: any
  target: any
}

export async function createTask(input: CreateInput): Promise<ScheduleResult<{ task: ScheduleTask }>> {
  await loadSchedules()
  const title = String(input?.title || '').trim()
  const prompt = String(input?.prompt || '').trim()
  const basic = validateBasics(title, prompt)
  if (basic) return basic
  const timingCheck = normalizeTiming(input?.timing)
  if (!timingCheck.ok || !timingCheck.timing) {
    return { ok: false, code: 'schedule_input_invalid', message: timingCheck.message || '时间规则不合法' }
  }
  const target = sanitizeTarget(input?.target)
  if (!target) return { ok: false, code: 'schedule_input_invalid', message: '目的地不合法' }
  const first = nextOccurrence(timingCheck.timing, Date.now())
  if (!first) return { ok: false, code: 'schedule_input_invalid', message: '这次时间规则没有未来的发生时刻' }
  const task: ScheduleTask = {
    id: newId(),
    title,
    prompt,
    timing: timingCheck.timing,
    target,
    status: 'active',
    scheduledAt: new Date(first).toISOString(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    deliveryHistory: [],
  }
  tasks.push(task)
  await persist()
  armTimer()
  emitChanged()
  return { ok: true, task }
}

export interface UpdateInput {
  id: string
  action: 'update' | 'delete'
  patch?: { title?: string; prompt?: string; timing?: any; target?: any; active?: boolean }
  expectedUpdatedAt?: string | null
}

export async function editTask(input: UpdateInput): Promise<ScheduleResult<{ task?: ScheduleTask; deleted?: boolean }>> {
  await loadSchedules()
  const task = tasks.find((t) => t.id === input?.id)
  if (!task) return { ok: false, code: 'schedule_not_found', message: '任务不存在' }
  if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== null && input.expectedUpdatedAt !== task.updatedAt) {
    return { ok: false, code: 'schedule_conflict', message: '任务已被其它地方修改，请刷新后重试' }
  }
  if (input.action === 'delete') {
    tasks = tasks.filter((t) => t.id !== task.id)
    await persist()
    armTimer()
    emitChanged()
    return { ok: true, deleted: true }
  }
  const patch = input.patch || {}
  if (patch.title !== undefined) {
    const title = String(patch.title).trim()
    if (!title) return { ok: false, code: 'schedule_input_invalid', message: '标题不能为空' }
    if (title.length > 120) return { ok: false, code: 'schedule_input_invalid', message: '标题最多 120 字' }
    task.title = title
  }
  if (patch.prompt !== undefined) {
    const prompt = String(patch.prompt).trim()
    if (!prompt) return { ok: false, code: 'schedule_input_invalid', message: '指令不能为空' }
    task.prompt = prompt
  }
  if (patch.timing !== undefined) {
    const check = normalizeTiming(patch.timing)
    if (!check.ok || !check.timing) {
      return { ok: false, code: 'schedule_input_invalid', message: check.message || '时间规则不合法' }
    }
    task.timing = check.timing
    const next = nextOccurrence(task.timing, Date.now())
    if (!next) return { ok: false, code: 'schedule_input_invalid', message: '这次时间规则没有未来的发生时刻' }
    task.scheduledAt = new Date(next).toISOString()
    task.status = 'active'
  }
  if (patch.target !== undefined) {
    const target = sanitizeTarget(patch.target)
    if (!target) return { ok: false, code: 'schedule_input_invalid', message: '目的地不合法' }
    task.target = target
  }
  if (patch.active !== undefined) {
    if (patch.active) {
      const next = nextOccurrence(task.timing, Date.now())
      if (!next) return { ok: false, code: 'schedule_input_invalid', message: '没有未来的发生时刻，无法恢复' }
      task.status = 'active'
      task.scheduledAt = new Date(next).toISOString()
    } else {
      task.status = 'paused'
    }
  }
  task.updatedAt = nowIso()
  await persist()
  armTimer()
  emitChanged()
  return { ok: true, task }
}

/** 立即执行：投递一次，但**不移动**下一次发生时刻（DSH 同语义） */
export async function runTaskNow(id: string): Promise<ScheduleResult<{ pending: SchedulePending }>> {
  await loadSchedules()
  const task = tasks.find((t) => t.id === id)
  if (!task) return { ok: false, code: 'schedule_not_found', message: '任务不存在' }
  if (task.status === 'ended') return { ok: false, code: 'schedule_input_invalid', message: '任务已结束，先恢复再执行' }
  const pending: SchedulePending = {
    scheduledAt: nowIso(),
    createdAt: nowIso(),
    prompt: task.prompt,
    title: task.title,
    target: { ...task.target },
  }
  task.pending = pending
  task.updatedAt = nowIso()
  await persist()
  emitDeliver(task, pending)
  emitChanged()
  return { ok: true, pending }
}

/**
 * 渲染层确认「已入队」：写回执 + 清 pending。
 * `chatId` 用于 `new_chat_once` 首次投递后回填目标；`new_chat` 只记历史。
 */
export async function ackDelivery(input: {
  taskId: string
  scheduledAt: string
  chatId?: string
}): Promise<ScheduleResult<{ task: ScheduleTask }>> {
  await loadSchedules()
  const task = tasks.find((t) => t.id === input?.taskId)
  if (!task) return { ok: false, code: 'schedule_not_found', message: '任务不存在' }
  const pending = task.pending
  if (!pending || pending.scheduledAt !== input.scheduledAt) {
    // 已被其它窗口确认 / 已被更新的投递覆盖：幂等返回
    return { ok: true, task }
  }
  const receipt: ScheduleReceipt = {
    scheduledAt: pending.scheduledAt,
    deliveredAt: nowIso(),
    prompt: pending.prompt,
    ...(input.chatId ? { chatId: input.chatId } : (pending.chatId ? { chatId: pending.chatId } : {})),
  }
  task.lastDelivery = receipt
  task.deliveryHistory = [...task.deliveryHistory, receipt].slice(-MAX_HISTORY)
  if (task.target.kind === 'new_chat_once' && !task.target.chatId && receipt.chatId) {
    task.target.chatId = receipt.chatId
  }
  task.pending = null
  task.updatedAt = nowIso()
  await persist()
  emitChanged()
  return { ok: true, task }
}

/** 目标聊天归档 / 删除：删除其任务（DSH 的 archiveAdmission） */
export async function disposeForChat(chatId: string): Promise<{ removed: number }> {
  await loadSchedules()
  if (!chatId) return { removed: 0 }
  const before = tasks.length
  tasks = tasks.filter((t) => !(t.target.kind === 'chat' && t.target.chatId === chatId))
  const removed = before - tasks.length
  if (removed) {
    await persist()
    armTimer()
    emitChanged()
  }
  return { removed }
}

/** 清理全部已结束任务（暂停与活动保留） */
export async function deleteInactive(): Promise<{ removed: number }> {
  await loadSchedules()
  const before = tasks.length
  tasks = tasks.filter((t) => t.status !== 'ended')
  const removed = before - tasks.length
  if (removed) {
    await persist()
    emitChanged()
  }
  return { removed }
}

/** 供工具 / UI 的描述（任务 + 人类可读时间） */
export function decorateTask(task: ScheduleTask, zh = true) {
  return {
    ...task,
    scheduledAtLocal: new Date(task.scheduledAt).toLocaleString(zh ? 'zh-CN' : 'en-US', { hour12: false }),
    scheduleText: describeTiming(task.timing, zh),
  }
}
