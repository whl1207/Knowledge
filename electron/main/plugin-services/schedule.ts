/**
 * schedule.ts — `ctx.schedule`（P3）
 *
 * `after / every / dailyAt`，全部返回 disposer；插件卸载时宿主统一清掉。
 * 触发回调里的异常只记日志，不打断后续定时（否则一个坏回调会把整个插件的定时静默停掉）。
 */

import type { PluginScheduleService } from '@/shared/pluginServices'
import type { PluginLogger } from '@/types/plugin'

export interface PluginScheduleHandle extends PluginScheduleService {
  dispose(): void
}

export function createPluginSchedule(pluginId: string, log: PluginLogger): PluginScheduleHandle {
  const timers = new Set<NodeJS.Timeout>()
  let disposed = false

  const run = (fn: () => void | Promise<void>): void => {
    if (disposed) return
    try {
      void Promise.resolve(fn()).catch((e) => {
        log.warn(`[schedule] ${pluginId} 回调失败: ${e instanceof Error ? e.message : String(e)}`)
      })
    } catch (e) {
      log.warn(`[schedule] ${pluginId} 回调异常: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const track = (timer: NodeJS.Timeout): (() => void) => {
    timers.add(timer)
    return () => {
      clearTimeout(timer)
      clearInterval(timer)
      timers.delete(timer)
    }
  }

  return {
    after(delayMs: number, fn: () => void | Promise<void>): () => void {
      const delay = Math.max(0, Math.round(Number(delayMs) || 0))
      const timer = setTimeout(() => {
        timers.delete(timer)
        run(fn)
      }, delay)
      return track(timer)
    },

    every(intervalMs: number, fn: () => void | Promise<void>): () => void {
      const interval = Math.max(1, Math.round(Number(intervalMs) || 1))
      const timer = setInterval(() => run(fn), interval)
      return track(timer)
    },

    dailyAt(hour: number, minute: number, fn: () => void | Promise<void>): () => void {
      const h = Math.min(23, Math.max(0, Math.round(Number(hour) || 0)))
      const m = Math.min(59, Math.max(0, Math.round(Number(minute) || 0)))
      let timer: NodeJS.Timeout | null = null
      let cancelled = false
      const arm = (): void => {
        if (cancelled || disposed) return
        const now = new Date()
        const next = new Date(now)
        next.setHours(h, m, 0, 0)
        if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
        timer = setTimeout(() => {
          timers.delete(timer as NodeJS.Timeout)
          run(fn)
          arm()
        }, Math.max(0, next.getTime() - now.getTime()))
        timers.add(timer)
      }
      arm()
      return () => {
        cancelled = true
        if (timer) {
          clearTimeout(timer)
          timers.delete(timer)
          timer = null
        }
      }
    },

    dispose(): void {
      disposed = true
      for (const timer of Array.from(timers)) {
        clearTimeout(timer)
        clearInterval(timer)
      }
      timers.clear()
    },
  }
}
