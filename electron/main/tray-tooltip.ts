/**
 * 托盘提示文本构造（纯函数，便于单测；不依赖 electron）
 * ---------------------------------------------------------------------------
 * 托盘悬停提示的来源是渲染层汇总上报的后台任务列表（见 src/App.vue 的 trayTasks）；
 * 脚手架任务（批量运行 / 文件采集 / 表格推理…）由各脚手架计时器每秒上报
 * 「已完成/总数 + 预计剩余时间」，因此悬停即可看到每个任务还要跑多久。
 *
 * ⚠️ Windows 通知区域提示底层是固定长度字段（szTip，128 个字符），超长会被系统截断，
 *    所以这里既限制行数也限制总字符数：放不下的条目用「…」表示，完整列表看右键菜单。
 */

/** 单个后台任务的展示信息（渲染层汇总后上报） */
export interface TrayTaskItem {
  /** 任务名（如「批量智能体运行」） */
  name: string
  /** 进度 / 细节（如「12/50 · 剩 3分20秒」「45%」），可为空 */
  detail?: string
}

/** 悬停提示最多列出的任务行数 */
export const TOOLTIP_MAX_LINES = 6
/** 悬停提示总长度预算（Windows szTip 上限 128 字符，留出余量） */
export const TOOLTIP_MAX_CHARS = 118

/** 单条任务的展示文本（右键菜单用，可宽鬆） */
export function trayItemLine(it: TrayTaskItem): string {
  return `${it.name}${it.detail ? ` ${it.detail}` : ''}`
}

/** 单条任务的紧凑文本（悬停提示用：省下分隔符空格，多塞几个实例） */
export function trayItemLineCompact(it: TrayTaskItem): string {
  const detail = (it.detail || '').replace(/\s*·\s*/g, ' ').trim()
  return `${it.name}${detail ? ` ${detail}` : ''}`
}

/** 悬停提示：任务数 + **逐个实例**的进度 / 预计剩余时间（自动控制在系统长度上限内） */
export function buildTrayTooltip(items: TrayTaskItem[], locale: string): string {
  const zh = locale !== 'en'
  const total = items.length
  if (!total) return zh ? 'AI-KM（无后台任务）' : 'AI-KM (no background tasks)'
  const head = zh ? `AI-KM · ${total} 个任务运行中` : `AI-KM · ${total} task(s) running`
  const lines: string[] = []
  let used = head.length
  for (let i = 0; i < items.length; i++) {
    const line = ` · ${trayItemLineCompact(items[i])}`
    const rest = items.length - i - 1
    const tail = rest > 0 ? (zh ? ` · 还有 ${rest} 个` : ` · +${rest} more`) : ''
    if (lines.length >= TOOLTIP_MAX_LINES || used + line.length + tail.length + 1 > TOOLTIP_MAX_CHARS) {
      lines.push(zh ? ` · …还有 ${items.length - i} 个` : ` · …+${items.length - i} more`)
      break
    }
    used += line.length + 1
    lines.push(line)
  }
  return [head, ...lines].join('\n')
}
