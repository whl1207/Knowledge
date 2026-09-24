/**
 * job-registry.ts — 后台任务运行时（路线图 2.4：ctx.jobs 的最小落地）
 *
 * 为长任务提供统一的**身份 + 生命周期 + 进度事件**：
 * - `JobId = <kind>-N`（每类任务独立递增计数）；
 * - owner = chatId / agentId（销毁 agent 时自动取消其全部 job）；
 * - `job_start / job_progress / job_end` 事件经 `sendToAll('job:event', ...)` 广播；
 * - 任务面板（渲染进程）通过 `jobs:list / jobs:get` 拉取，`job:event` 实时刷新。
 *
 * 本阶段接线：agent 循环的每个 turn 注册为一个 job（kind='agent'），
 * step 进度实时上报；agent cancel/dispose 自动取消其 job。
 * 后续：知识库构建、本体抽取、swarm 运行逐步接入同一运行时。
 */

import { sendToAll } from './ipc-registry'

export type JobKind = 'agent' | 'kb-build' | 'ontology' | 'swarm' | (string & {})

export type JobStatus = 'running' | 'completed' | 'cancelled' | 'error'

export interface JobInfo {
  id: string
  kind: JobKind
  owner: string
  title: string
  status: JobStatus
  /** 进度 0..100（null = 无确定进度） */
  progress: number | null
  detail?: string
  result?: any
  error?: string
  createdAt: number
  updatedAt: number
  endedAt?: number
}

export type JobEvent =
  | { type: 'job/start'; job: JobInfo }
  | { type: 'job/progress'; job: JobInfo }
  | { type: 'job/end'; job: JobInfo }

/** job:event 广播通道（渲染进程 window.dsh.jobs.onEvent 订阅） */
export const JOB_EVENT_CHANNEL = 'job:event'

class JobRegistry {
  private jobs = new Map<string, JobInfo>()
  private counters = new Map<string, number>()

  /** 创建任务；返回 job 信息（已广播 job/start）。 */
  start(kind: JobKind, owner: string, title: string, opts?: { progress?: number | null; detail?: string }): JobInfo {
    const n = (this.counters.get(kind) ?? 0) + 1
    this.counters.set(kind, n)
    const id = `${kind}-${n}`
    const job: JobInfo = {
      id,
      kind,
      owner,
      title,
      status: 'running',
      progress: opts?.progress ?? null,
      detail: opts?.detail,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.jobs.set(id, job)
    this.broadcast({ type: 'job/start', job })
    return { ...job }
  }

  /** 更新进度（0..100 或 null）；未找到时静默忽略。 */
  progress(id: string, progress: number | null, detail?: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    job.progress = progress
    if (detail !== undefined) job.detail = detail
    job.updatedAt = Date.now()
    this.broadcast({ type: 'job/progress', job: { ...job } })
  }

  /** 完成（带结果）。 */
  complete(id: string, result?: any): void {
    const job = this.jobs.get(id)
    if (!job || job.status !== 'running') return
    job.status = 'completed'
    job.result = result
    job.progress = 100
    job.endedAt = Date.now()
    job.updatedAt = Date.now()
    this.broadcast({ type: 'job/end', job: { ...job } })
  }

  /** 失败（带错误信息）。 */
  fail(id: string, error: string): void {
    const job = this.jobs.get(id)
    if (!job || job.status !== 'running') return
    job.status = 'error'
    job.error = error
    job.endedAt = Date.now()
    job.updatedAt = Date.now()
    this.broadcast({ type: 'job/end', job: { ...job } })
  }

  /** 取消单个任务。 */
  cancel(id: string, cause?: string): void {
    const job = this.jobs.get(id)
    if (!job || job.status !== 'running') return
    job.status = 'cancelled'
    job.detail = cause || job.detail || '已取消'
    job.endedAt = Date.now()
    job.updatedAt = Date.now()
    this.broadcast({ type: 'job/end', job: { ...job } })
  }

  /** 取消某 owner 的全部运行中任务（agent 销毁 / 会话关闭时调用）。 */
  cancelForOwner(owner: string, cause?: string): void {
    for (const job of this.jobs.values()) {
      if (job.owner === owner && job.status === 'running') {
        this.cancel(job.id, cause)
      }
    }
  }

  /** 列出全部任务（新→旧）。 */
  list(): JobInfo[] {
    return Array.from(this.jobs.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((j) => ({ ...j }))
  }

  /** 查询单个任务。 */
  get(id: string): JobInfo | null {
    const j = this.jobs.get(id)
    return j ? { ...j } : null
  }

  private broadcast(ev: JobEvent): void {
    // 保留最近 200 条任务，防止长期运行后内存无界增长
    if (this.jobs.size > 200) {
      const oldest = Array.from(this.jobs.values()).sort((a, b) => a.createdAt - b.createdAt)[0]
      if (oldest) this.jobs.delete(oldest.id)
    }
    try {
      sendToAll(JOB_EVENT_CHANNEL, ev)
    } catch (e) {
      console.error('[jobs] 广播失败:', e)
    }
  }
}

export const jobRegistry = new JobRegistry()
