/**
 * platform/longTask — 长任务保活（安卓前台服务 + 进度通知）
 *
 * 为什么需要：安卓在应用退到后台后会限制/回收 WebView 进程，知识处理（切片 / 向量化 /
 * 本体构建）、长时生成、批量导出这类跑几分钟的任务很容易被系统掐断。起一个带进度通知的
 * 前台服务，系统就不会回收，用户也能从通知栏看到进度并点回应用。
 *
 * 用法（模块级单例，多处并发调用也不会互相踩）：
 *   beginLongTask({ title: '知识处理', text: '正在切片…', progress: 12 })
 *   updateLongTask({ text: '正在向量化…', progress: 60 })
 *   endLongTask()
 *
 * 并发约定：内部用引用计数 + 最近一次文案。多个任务同时跑时，通知显示「最外层」任务的
 * 标题与最新进度；最后一个任务结束时才真正停服务。非安卓环境（无 `app.longTask` 能力）
 * 全部为空操作，因此调用点不需要判断平台。
 */

import { getPlatform, hasCapability } from '@/platform'

interface LongTaskState {
  /** 正在运行的任务数（引用计数） */
  count: number
  /** 最外层任务的标题（后进先出时取第一个未结束的） */
  titles: string[]
  text: string
  progress?: number
  indeterminate: boolean
}

const state: LongTaskState = { count: 0, titles: [], text: '', progress: undefined, indeterminate: true }

/** 节流：进度更新很密（每个切片都会调），通知不需要这么频繁 */
let lastSentAt = 0
const MIN_INTERVAL_MS = 700

function supported(): boolean {
  return hasCapability('app.longTask')
}

/** 开始一个长任务（返回结束函数，推荐用 try/finally 或它包裹的 runLongTask） */
export function beginLongTask(payload: { title?: string; text?: string; progress?: number; indeterminate?: boolean }): () => void {
  if (!supported()) return () => {}
  const title = String(payload?.title || '后台任务')
  state.count += 1
  state.titles.push(title)
  state.text = String(payload?.text || '')
  state.progress = typeof payload?.progress === 'number' ? payload.progress : undefined
  state.indeterminate = payload?.indeterminate !== false && state.progress === undefined
  lastSentAt = Date.now()
  void getPlatform().app
    .beginLongTask({ title, text: state.text, progress: state.progress, indeterminate: state.indeterminate })
    .catch(() => {})

  let ended = false
  return () => {
    if (ended) return
    ended = true
    state.count = Math.max(0, state.count - 1)
    const idx = state.titles.lastIndexOf(title)
    if (idx >= 0) state.titles.splice(idx, 1)
    if (state.count === 0) {
      void getPlatform().app.endLongTask().catch(() => {})
    }
  }
}

/** 更新进度（文案 / 百分比），会自动节流 */
export function updateLongTask(payload: { text?: string; progress?: number; indeterminate?: boolean }): void {
  if (!supported() || state.count === 0) return
  if (payload?.text !== undefined) state.text = String(payload.text)
  if (typeof payload?.progress === 'number') state.progress = payload.progress
  if (payload?.indeterminate !== undefined) state.indeterminate = payload.indeterminate
  const now = Date.now()
  if (now - lastSentAt < MIN_INTERVAL_MS) return
  lastSentAt = now
  void getPlatform().app
    .updateLongTask({ text: state.text, progress: state.progress, indeterminate: state.indeterminate })
    .catch(() => {})
}

/** 结束当前长任务（不等引用计数归零也强制收尾，用于「停止」按钮） */
export function endLongTask(): void {
  if (!supported()) return
  state.count = 0
  state.titles = []
  state.text = ''
  state.progress = undefined
  void getPlatform().app.endLongTask().catch(() => {})
}

/** 包裹一段长任务：开始 → 执行 → 结束（异常也会结束） */
export async function runLongTask<T>(
  payload: { title?: string; text?: string; progress?: number; indeterminate?: boolean },
  fn: () => Promise<T>,
): Promise<T> {
  const end = beginLongTask(payload)
  try {
    return await fn()
  } finally {
    end()
  }
}
