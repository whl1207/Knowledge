/**
 * scheduleClient.ts — 自动化任务的渲染层封装（IPC 解包 + 事件订阅 + 类型）
 *
 * 主进程侧见 `electron/main/schedule-service.ts`；这里只做三件事：
 * 1. 把 `{ ok, data }` 信封解成值 / 抛错；
 * 2. 订阅 `schedule:changed` / `schedule:deliver` 两个广播；
 * 3. 给 UI 与（未来的）工具复用同一套任务类型。
 */

import { aikmIpc, aikmIpcAvailable } from '@/lib/aikmIpc'
import { getPlatform } from '@/platform'
import type { ScheduleTiming } from '@/shared/scheduleTime'

export type ScheduleTargetKind = 'chat' | 'new_chat_once' | 'new_chat'

export interface ScheduleTarget {
  kind: ScheduleTargetKind
  chatId?: string
  chatTemplate?: {
    workspace?: string
    noWorkspace?: boolean
    config?: Record<string, any>
    /** 执行这个任务用的智能体预设 id（空 = 跟随目标对话；'__normal__' = 普通对话，不带预设） */
    agentPresetId?: string
    /** 快捷：'normal' 表示普通对话（不开智能体模式） */
    agentMode?: 'agent' | 'normal'
  }
  title?: string
}

export interface ScheduleReceipt {
  scheduledAt: string
  deliveredAt: string
  chatId?: string
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
  scheduledAt: string
  createdAt: string
  updatedAt: string
  lastDelivery?: ScheduleReceipt
  deliveryHistory: ScheduleReceipt[]
  pending?: SchedulePending | null
  /** 主进程 decorateTask 加的展示字段（本地化时间 / 规则描述） */
  scheduledAtLocal?: string
  scheduleText?: string
}

export interface ScheduleListResult {
  items: ScheduleTask[]
  total: number
  limit: number
  offset: number
}

export interface SchedulePendingItem {
  taskId: string
  title: string
  pending: SchedulePending
}

export interface ScheduleCreateInput {
  title: string
  prompt: string
  timing: ScheduleTiming
  target: ScheduleTarget
}

export interface ScheduleEditInput {
  id: string
  action: 'update' | 'delete'
  patch?: { title?: string; prompt?: string; timing?: ScheduleTiming; target?: ScheduleTarget; active?: boolean }
  expectedUpdatedAt?: string | null
}

/** 主进程 IPC 不可用时（浏览器 / 安卓）自动化任务整体不可用 */
export const scheduleAvailable = (): boolean => aikmIpcAvailable()

async function invoke<T>(channel: string, payload?: any): Promise<T> {
  const res: any = await aikmIpc.invoke(channel, payload)
  if (res && typeof res === 'object' && 'ok' in res) {
    if (!res.ok) {
      const err = new Error(String(res?.error?.message || channel)) as Error & { code?: string }
      err.code = String(res?.error?.code || '')
      throw err
    }
    return res.data as T
  }
  return res as T
}

/** 业务结果（服务层用 `{ok,code,message}` 表达拒绝，而不是抛错） */
type ServiceResult<T> = ({ ok: true } & T) | { ok: false; code: string; message: string }

export const listSchedules = (query: { active?: boolean; limit?: number; offset?: number } = {}) =>
  invoke<ScheduleListResult>('schedule:list', query)

export const viewSchedule = (id: string) => invoke<ServiceResult<{ task: ScheduleTask }>>('schedule:view', { id })

export const scheduleHistory = (id: string, limit = 50) =>
  invoke<ServiceResult<{ records: ScheduleReceipt[] }>>('schedule:history', { id, limit })

export const createSchedule = (input: ScheduleCreateInput) =>
  invoke<ServiceResult<{ task: ScheduleTask }>>('schedule:create', input)

export const editSchedule = (input: ScheduleEditInput) =>
  invoke<ServiceResult<{ task?: ScheduleTask; deleted?: boolean }>>('schedule:edit', input)

export const runScheduleNow = (id: string) =>
  invoke<ServiceResult<{ pending: SchedulePending }>>('schedule:run', { id })

export const pendingScheduleDeliveries = () =>
  invoke<{ items: SchedulePendingItem[] }>('schedule:pending')

export const ackScheduleDelivery = (input: { taskId: string; scheduledAt: string; chatId?: string }) =>
  invoke<ServiceResult<{ task: ScheduleTask }>>('schedule:ack', input)

export const deleteInactiveSchedules = () => invoke<{ removed: number }>('schedule:deleteInactive')

export const disposeScheduleForChat = (chatId: string) =>
  invoke<{ removed: number }>('schedule:chatDisposed', { chatId })

/**
 * 订阅主进程广播；返回退订函数。
 * 平台没有事件总线时退化为空订阅（浏览器端本来也没有任务）。
 */
export function onScheduleEvent(
  handlers: { changed?: () => void; deliver?: (payload: { taskId: string; title: string; occurrences: SchedulePending[] }) => void },
): () => void {
  if (!aikmIpcAvailable()) return () => {}
  const offs: Array<() => void> = []
  try {
    const events = getPlatform().events
    if (handlers.changed) offs.push(events.on('schedule:changed', () => handlers.changed!()))
    if (handlers.deliver) offs.push(events.on('schedule:deliver', (payload: any) => handlers.deliver!(payload)))
  } catch { /* 忽略：没有事件总线 */ }
  return () => { for (const off of offs) { try { off() } catch { /* 忽略 */ } } }
}
