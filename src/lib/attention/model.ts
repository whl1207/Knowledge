/**
 * attention/model.ts — 「待我处理」条目的纯逻辑（不引 Vue / 不碰 DOM，便于单测）
 *
 * 只做四件事：
 * 1. 把 `AgentSessionView`（及其它来源）投影成条目：**跳过已销毁的会话**；
 * 2. 排序 / 分组（顺序即语义：先列需要人回答的，健康的组不出现）；
 * 3. 角标数字（只算待我处理；>99 → 99+）；
 * 4. 展示用的小工具：首行截断、相对时间、兜底标题。
 *
 * 为什么不在这里读 store：这份逻辑要被自测直接调用（见 model.selftest.ts），
 * 且面板 / 托盘 / 角标三处共用同一份判定，读 store 会让它变成不可测的胶水。
 */

import type { AskUserQuestion } from '@/types/agent'
import type { RunReport } from '@/types/agent'
import type { AttentionAction, AttentionGroup, AttentionItem, AttentionKind } from '@/types/attention'

/** 条目投影的最小视图形状（与 platform/agentBridge.ts 的 AgentSessionView 结构兼容） */
export interface AttentionSourceView {
  id: string
  label?: string
  status: string
  /** 视图上另有一个显式标记（dispose 后置 true，但 pending 字段不会自动清空） */
  disposed?: boolean
  pendingQuestion?: { askId: string; question: string; questions?: AskUserQuestion[] } | null
  pendingPlanReview?: { reviewId: string; plan: string } | null
  /** 运行状态上报（report_run）：blocked/failed → 出问题了；ready → 等你验收 */
  runReport?: RunReport | null
}

export interface AttentionProjectionOptions {
  /** 会话 id → 聊天 id；找不到返回 undefined（此时不提供「打开原处」） */
  resolveChatId?: (sessionId: string) => string | undefined
  /** 幂等键 → 首次出现时间；缺省用 now */
  resolveAt?: (key: string) => number | undefined
  now?: number
}

/** 分组展示顺序：先「要你回答」，再「要你裁决」，其余依次（P2/P3 再用）。 */
export const GROUP_ORDER: readonly AttentionGroup[] = ['answer', 'decide', 'problem', 'review', 'system']

const KIND_TO_GROUP: Record<AttentionKind, AttentionGroup> = {
  question: 'answer',
  plan: 'decide',
  'run-failed': 'problem',
  'run-ready': 'review',
  system: 'system',
}

export function groupOf(kind: AttentionKind): AttentionGroup {
  return KIND_TO_GROUP[kind] || 'system'
}

/** 标题兜底（模型没给题目/计划文本时不要显示空行） */
export function fallbackTitle(kind: AttentionKind, zh: boolean): string {
  switch (kind) {
    case 'question': return zh ? '有一个问题在等你回答' : 'A question is waiting for you'
    case 'plan': return zh ? '有一份计划在等你裁决' : 'A plan is waiting for your review'
    case 'run-failed': return zh ? '有一次运行失败了' : 'A run failed'
    case 'run-ready': return zh ? '有一次运行等你验收' : 'A run is ready for review'
    default: return zh ? '有一个问题需要处理' : 'Something needs attention'
  }
}

/** 取首行、去 Markdown 标题符号、按字符截断（不切代理对） */
export function firstLine(text: unknown, max = 96): string {
  const raw = String(text ?? '').replace(/\r/g, '').split('\n').find((line) => line.trim()) ?? ''
  const cleaned = raw.replace(/^\s{0,3}#{1,6}\s*/, '').replace(/^\s*[-*+]\s+/, '').trim()
  if (!cleaned) return ''
  const chars = Array.from(cleaned)
  if (chars.length <= max) return cleaned
  return chars.slice(0, Math.max(1, max - 1)).join('') + '…'
}

function questionActions(hasChat: boolean): AttentionAction[] {
  const actions: AttentionAction[] = [{ id: 'answer', label: { zh: '回答', en: 'Answer' }, primary: true }]
  if (hasChat) actions.push({ id: 'open', label: { zh: '打开原处', en: 'Open' } })
  actions.push({ id: 'stop-session', label: { zh: '停止会话', en: 'Stop session' }, danger: true })
  return actions
}

function planActions(hasChat: boolean): AttentionAction[] {
  const actions: AttentionAction[] = [
    { id: 'approve', label: { zh: '批准执行', en: 'Approve' }, primary: true },
    { id: 'keep-planning', label: { zh: '继续完善', en: 'Keep planning' } },
    // 「关闭」= dismiss 裁决（agent 停下等你指示），不是"拒绝"——与计划评审弹窗的按钮语义一致
    { id: 'dismiss', label: { zh: '关闭', en: 'Close' } },
  ]
  if (hasChat) actions.push({ id: 'open', label: { zh: '打开原处', en: 'Open' } })
  return actions
}

/** 运行状态上报（report_run）派生条目的动作：失败/受阻 → 打开原处 + 停止；就绪 → 打开原处 */
function reportActions(kind: 'run-failed' | 'run-ready', hasChat: boolean): AttentionAction[] {
  const actions: AttentionAction[] = []
  if (hasChat) actions.push({ id: 'open', label: { zh: '打开原处', en: 'Open' }, primary: true })
  if (kind === 'run-failed') {
    const stop = { id: 'stop-session' as const, label: { zh: '停止会话', en: 'Stop session' }, danger: true as const }
    if (actions.length) actions.push(stop)
    else actions.push({ ...stop, primary: true })
  }
  return actions
}

/**
 * 视图 → 条目。
 *
 * **必须跳过 `status === 'disposed'`（或 `disposed === true`）**：`agentBridge.dispose()` 只置标记、
 * 不清 pending 字段，主进程 reject 挂起 Promise 时也不 emit 事件——不过滤就会留下
 * 「点了没反应」的僵尸条目（见实施方案 R8）。
 */
export function itemsFromViews(
  views: readonly AttentionSourceView[],
  options: AttentionProjectionOptions = {},
): AttentionItem[] {
  const now = options.now ?? Date.now()
  const resolveChatId = options.resolveChatId
  const resolveAt = options.resolveAt
  const out: AttentionItem[] = []

  for (const view of views || []) {
    if (!view || !view.id) continue
    if (view.status === 'disposed' || view.disposed === true) continue
    const chatId = resolveChatId ? resolveChatId(view.id) : undefined

    const q = view.pendingQuestion
    if (q && q.askId) {
      const key = `question:${view.id}:${q.askId}`
      const questions = Array.isArray(q.questions) ? q.questions : []
      out.push({
        key,
        kind: 'question',
        group: groupOf('question'),
        title: firstLine(q.question || questions[0]?.question),
        sessionId: view.id,
        sessionLabel: view.label,
        chatId,
        at: resolveAt?.(key) ?? now,
        actions: questionActions(!!chatId),
        payload: { askId: q.askId, questions },
      })
    }

    const r = view.pendingPlanReview
    if (r && r.reviewId) {
      const key = `plan:${view.id}:${r.reviewId}`
      out.push({
        key,
        kind: 'plan',
        group: groupOf('plan'),
        title: firstLine(r.plan),
        sessionId: view.id,
        sessionLabel: view.label,
        chatId,
        at: resolveAt?.(key) ?? now,
        actions: planActions(!!chatId),
        payload: { reviewId: r.reviewId, plan: r.plan },
      })
    }

    // 运行状态上报（report_run）：只有结构化字段能进面板——blocked/failed → 出问题了；
    // ready → 等你验收。progress / waiting / dropped 只记录，不打扰人（对照原型 001-domain.md:112）。
    const report = view.runReport
    if (report) {
      const needsPerson = report.state === 'blocked' || report.state === 'failed'
      const isReady = report.state === 'ready'
      if (needsPerson || isReady) {
        const kind: 'run-failed' | 'run-ready' = needsPerson ? 'run-failed' : 'run-ready'
        const key = `report:${view.id}:${report.at || 0}`
        out.push({
          key,
          kind,
          group: groupOf(kind),
          // 有具体问题时优先显示问题（动作化标题），否则用一句话摘要
          title: firstLine(needsPerson && report.question ? report.question : report.summary),
          summary: needsPerson && report.question ? firstLine(report.summary) : undefined,
          sessionId: view.id,
          sessionLabel: view.label,
          chatId,
          at: resolveAt?.(key) ?? (report.at || now),
          actions: reportActions(kind, !!chatId),
          payload: {},
        })
      }
    }
  }
  return out
}

/** 排序：先按 GROUP_ORDER，再按出现时间倒序（同时间用 key 兜底，保证稳定） */
export function sortItems(items: readonly AttentionItem[]): AttentionItem[] {
  const rank = (g: AttentionGroup) => {
    const i = GROUP_ORDER.indexOf(g)
    return i < 0 ? GROUP_ORDER.length : i
  }
  return items.slice().sort((a, b) => {
    const d = rank(a.group) - rank(b.group)
    if (d !== 0) return d
    if (b.at !== a.at) return b.at - a.at
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  })
}

/** 分组：丢掉空组（「健康的不要占空间」——没有需要人的条目时组标题不出现） */
export function groupItems(items: readonly AttentionItem[]): Array<{ group: AttentionGroup; items: AttentionItem[] }> {
  const buckets = new Map<AttentionGroup, AttentionItem[]>()
  for (const item of sortItems(items)) {
    const list = buckets.get(item.group)
    if (list) list.push(item)
    else buckets.set(item.group, [item])
  }
  const out: Array<{ group: AttentionGroup; items: AttentionItem[] }> = []
  for (const group of GROUP_ORDER) {
    const list = buckets.get(group)
    if (list && list.length) out.push({ group, items: list })
  }
  return out
}

/** 角标：0 → 空串（入口常驻但不显示数字），>99 → 99+ */
export function badgeText(count: number): string {
  const n = Math.max(0, Math.floor(Number(count) || 0))
  if (n <= 0) return ''
  return n > 99 ? '99+' : String(n)
}

/** 组标题（中英） */
export function groupTitle(group: AttentionGroup, zh: boolean): string {
  switch (group) {
    case 'answer': return zh ? '需要你回答' : 'Needs your answer'
    case 'decide': return zh ? '需要你裁决' : 'Needs your decision'
    case 'problem': return zh ? '出问题了' : 'Problems'
    case 'review': return zh ? '等你验收' : 'Ready for review'
    default: return zh ? '系统问题' : 'System'
  }
}

/** 相对时间（展示用；未知/未来 → 空串或「刚刚」） */
export function relativeTime(at: number, now: number, zh: boolean): string {
  const ms = Number(at)
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const diff = Math.max(0, Number(now) - ms)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return zh ? '刚刚' : 'just now'
  if (min < 60) return zh ? `${min} 分钟前` : `${min} min ago`
  const hour = Math.floor(min / 60)
  if (hour < 24) return zh ? `${hour} 小时前` : `${hour} h ago`
  const day = Math.floor(hour / 24)
  return zh ? `${day} 天前` : `${day} d ago`
}
