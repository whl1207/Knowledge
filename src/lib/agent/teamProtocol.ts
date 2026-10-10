/**
 * teamProtocol.ts — Agent Teams 协议纯逻辑（无 Vue / 无 IPC，便于推理与测试）
 *
 * 只做三件事：
 * 1. 任务板 DAG 校验（存在性 + 无环）；
 * 2. ready 集与回合终止判定（**程序化**，不依赖 LLM 自称完成）；
 * 3. 看板文本化（给 Lead 的 prompt 注入用）。
 */

import type { SwarmTask, SwarmTaskStatus } from '@/types/swarmRoom'

/** 终态任务状态 */
export const TERMINAL_STATUS: SwarmTaskStatus[] = ['done', 'error', 'cancelled']

export function isTerminal(status: SwarmTaskStatus): boolean {
  return TERMINAL_STATUS.includes(status)
}

/** 已完成任务的 id 集（依赖判定的依据） */
export function doneIds(tasks: SwarmTask[]): Set<string> {
  return new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id))
}

/** 任务是否被依赖阻塞（存在未完成的 dep） */
export function isBlocked(task: SwarmTask, tasks: SwarmTask[]): boolean {
  if (!task.deps.length) return false
  const done = doneIds(tasks)
  return task.deps.some((d) => !done.has(d))
}

/**
 * 检测依赖成环（DFS 三色标记）。返回 true = 有环。
 * 不存在的 dep 不计入环（由 validateCreate 单独报"依赖不存在"）。
 */
export function hasCycle(tasks: Array<Pick<SwarmTask, 'id' | 'deps'>>): boolean {
  const map = new Map<string, string[]>()
  for (const t of tasks) map.set(t.id, (t.deps || []).filter((d) => map.has(d) || tasks.some((x) => x.id === d)))
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map<string, number>()
  for (const t of tasks) color.set(t.id, WHITE)

  const dfs = (id: string): boolean => {
    color.set(id, GRAY)
    for (const d of map.get(id) || []) {
      const c = color.get(d)
      if (c === GRAY) return true
      if (c === WHITE && dfs(d)) return true
    }
    color.set(id, BLACK)
    return false
  }
  for (const t of tasks) {
    if (color.get(t.id) === WHITE && dfs(t.id)) return true
  }
  return false
}

/** 生成下一个任务 id（t1 / t2 …） */
export function nextTaskId(tasks: SwarmTask[]): string {
  let max = 0
  for (const t of tasks) {
    const m = /^t(\d+)$/.exec(t.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `t${max + 1}`
}

/**
 * 新建任务时的校验（结构性，供 Lead 的工具调用）。
 * `assignee` 同时接受**成员名**与**名册下标**——模型更习惯直接填名字，
 * 之前只接受下标会让“分配”静默失败并回落给 Lead。
 * 返回解析后的下标，供上层直接写入任务。
 */
export function validateCreate(
  input: { title?: string; prompt?: string; assignee?: number | string; deps?: string[] },
  opts: { memberCount: number; memberNames?: string[]; existing: SwarmTask[] },
): { ok: true; assignee?: number } | { ok: false; error: string } {
  const title = String(input?.title || '').trim()
  const prompt = String(input?.prompt || '').trim()
  if (!title) return { ok: false, error: 'title 必填（3~8 字短标题）' }
  if (!prompt) return { ok: false, error: 'prompt 必填（完整任务描述）' }

  let assignee: number | undefined
  const raw = input?.assignee
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    const names = opts.memberNames || []
    const s = String(raw).trim()
    if (/^\d+$/.test(s)) {
      const a = Number(s)
      if (a < 0 || a >= opts.memberCount) {
        return { ok: false, error: `assignee 下标越界（应为 0~${opts.memberCount - 1}）：${s}` }
      }
      assignee = a
    } else {
      let idx = names.findIndex((n) => n === s)
      if (idx < 0) idx = names.findIndex((n) => n && (n.includes(s) || s.includes(n)))
      if (idx < 0) {
        return { ok: false, error: `找不到成员「${s}」；可用成员：${names.map((n, i) => `${i}=${n}`).join('、')}` }
      }
      assignee = idx
    }
  }

  const deps = (input.deps || []).map(String)
  const ids = new Set(opts.existing.map((t) => t.id))
  for (const d of deps) {
    if (!ids.has(d)) return { ok: false, error: `依赖不存在：${d}` }
  }
  // 以"假设新任务已加入"的姿态检测成环
  const probe = [...opts.existing.map((t) => ({ id: t.id, deps: t.deps })), { id: '__new__', deps }]
  if (hasCycle(probe)) return { ok: false, error: '依赖成环，请调整 deps' }
  return { ok: true, assignee }
}

/** 新任务初始状态：有依赖 → pending，无依赖 → ready */
export function initialStatus(deps: string[]): SwarmTaskStatus {
  return deps && deps.length ? 'pending' : 'ready'
}

/** 当前可派发的任务 id（pending/ready 且依赖全 done） */
export function readyTaskIds(tasks: SwarmTask[]): string[] {
  const done = doneIds(tasks)
  return tasks
    .filter((t) => (t.status === 'pending' || t.status === 'ready') && t.deps.every((d) => done.has(d)))
    .map((t) => t.id)
}

/** 回合是否已"任务侧收敛"：无 pending / ready / running */
export function tasksSettled(tasks: SwarmTask[]): boolean {
  return !tasks.some((t) => t.status === 'pending' || t.status === 'ready' || t.status === 'running')
}

/**
 * 回合终止判定（**程序化**）：任务侧收敛 且 无 in-flight 消息。
 * 第 3 条（Lead 已交付）由调用方另行判断。
 */
export function episodeSettled(tasks: SwarmTask[], inflightMessages: number): boolean {
  return tasksSettled(tasks) && inflightMessages <= 0
}

/** 看板文本化（注入 Lead 的 prompt） */
export function describeBoard(tasks: SwarmTask[]): string {
  if (!tasks.length) return '（任务板为空）'
  const mark: Record<SwarmTaskStatus, string> = {
    pending: '⏳', ready: '🟡', running: '🔵', done: '✅', error: '❌', cancelled: '⚪',
  }
  return tasks
    .map((t) => {
      const dep = t.deps.length ? ` ← ${t.deps.join(',')}` : ''
      const art = t.artifactRefs && t.artifactRefs.length ? ` 📎${t.artifactRefs.join(',')}` : ''
      return `${mark[t.status] || '•'} ${t.id} ${t.title}${dep}${art}`
    })
    .join('\n')
}
