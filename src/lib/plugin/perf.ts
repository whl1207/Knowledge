/**
 * perf.ts — 渲染层性能埋点（发往主进程写进 `<userData>/timing.log`）
 *
 * 只在耗时 > 15ms 时上报，避免刷屏；埋点本身绝不影响功能（全部 try/catch）。
 */

import { aikmIpc, aikmIpcAvailable } from '@/lib/aikmIpc'

export function reportTiming(label: string, ms: number, extra?: string): void {
  const value = Number(ms) || 0
  if (value < 15) return
  try {
    if (aikmIpcAvailable()) aikmIpc.send('diag:timing', { label, ms: value, extra })
  } catch { /* 忽略 */ }
  try {
    console.info(`[timing] ${label} ${Math.round(value)}ms${extra ? ` ${extra}` : ''}`)
  } catch { /* 忽略 */ }
}
