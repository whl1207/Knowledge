/**
 * src/utils/taskProgress.ts — 后台任务「进度 + 预计剩余时间」文案
 *
 * 供两处共用：
 *   · 底部状态栏 / 控件内提示（脚手架自己也在用 formatDuration，这里只管托盘文案）
 *   · App.vue 汇总上报给托盘（悬停托盘图标即看到每个脚手架任务还剩多久）
 */

/** 运行进度：已完成 / 总数 + 预计剩余毫秒（null = 尚在估算：本段还没跑完任何一项） */
export interface TaskProgress {
  done: number
  total: number
  etaMs: number | null
}

/** 剩余时间文案：`3分20秒` / `1小时5分`（en：`3m20s` / `1h5m`） */
export function formatEtaText(etaMs: number, zh: boolean): string {
  const sec = Math.max(0, Math.round(etaMs / 1000))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (zh) return h > 0 ? `${h}小时${m}分` : m > 0 ? `${m}分${s}秒` : `${s}秒`
  return h > 0 ? `${h}h${m}m` : m > 0 ? `${m}m${s}s` : `${s}s`
}

/** 托盘提示里的任务详情：`12/50 · 剩 3分20秒`（无进度返回空串） */
export function formatTaskProgressDetail(p: TaskProgress | undefined | null, zh: boolean): string {
  if (!p) return ''
  const parts: string[] = []
  if (p.total > 0) parts.push(`${p.done}/${p.total}`)
  if (p.etaMs != null && p.etaMs > 0) parts.push(`${zh ? '剩' : '~'}${formatEtaText(p.etaMs, zh)}`)
  else if (p.etaMs == null && p.total > 0 && p.done < p.total) parts.push(zh ? '剩 估算中' : '~ estimating')
  return parts.join(' · ')
}
