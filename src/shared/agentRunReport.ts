/**
 * agentRunReport.ts — 「运行状态上报」的契约与校验（参照 dsh-superagent-prototype 的结构化 Report）
 *
 * 原型的做法（`docs/001-domain.md:110-112`、`docs/002-authorization.md`）：
 * 执行器**必须上报结构化状态**，面板只认这些字段；并明确把
 * "从自由文本推断'在等人'"列为被否决的概念（`001-domain.md:60`）。
 *
 * AI-KM 的对应物：`report_run` 工具 + 会话事件 `report/write`（整值替换、最后一条胜出），
 * 由「待我处理」面板消费：
 * - `blocked` / `failed` → 出问题了（需要人）
 * - `ready` → 等你验收
 * - `progress` / `waiting` / `dropped` → 只记录，不打扰人
 *
 * 本模块只做纯校验（不碰 IPC / 日志），主进程工具与日志折叠共用同一份口径。
 */

import type { RunReportState } from '@/types/agent'

/** 允许的状态（顺序 = 文档顺序） */
export const RUN_REPORT_STATES: readonly RunReportState[] = ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']

/** 摘要上限（字符）：够说清"现在怎么样 / 为什么停"，不该是长报告 */
export const RUN_REPORT_SUMMARY_MAX = 300
/** 具体问题上限（字符）：一次只问一个具体问题 */
export const RUN_REPORT_QUESTION_MAX = 500

/** 归一化后的上报值（不含 at，时间由落盘方补） */
export interface NormalizedRunReport {
  state: RunReportState
  summary: string
  question?: string
}

export type NormalizeRunReportResult =
  | { ok: true; report: NormalizedRunReport }
  | { ok: false; error: string }

/** 这个状态是否需要人处理（面板据此决定要不要进「待我处理」） */
export function runReportNeedsPerson(state: RunReportState | undefined | null): boolean {
  return state === 'blocked' || state === 'failed' || state === 'ready'
}

/** 状态的可用中文名（工具返回文案 / 面板兜底标题共用） */
export function runReportStateLabel(state: RunReportState, zh = true): string {
  const zhMap: Record<RunReportState, string> = {
    progress: '进行中',
    waiting: '等待中',
    ready: '已就绪（待验收）',
    blocked: '受阻（等人）',
    failed: '失败',
    dropped: '无需处理',
  }
  const enMap: Record<RunReportState, string> = {
    progress: 'in progress',
    waiting: 'waiting',
    ready: 'ready for review',
    blocked: 'blocked on a person',
    failed: 'failed',
    dropped: 'nothing to do',
  }
  return zh ? zhMap[state] : enMap[state]
}

/**
 * 校验并归一化一次上报。失败一律 fail-loud（返回 ok:false 让模型重写），
 * 与 `update_todo` / `update_plan` 的写入前校验同一口径。
 */
export function normalizeRunReport(input: unknown): NormalizeRunReportResult {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const state = String(raw.state ?? '').trim() as RunReportState
  if (!RUN_REPORT_STATES.includes(state)) {
    return {
      ok: false,
      error: `state 必须是 ${RUN_REPORT_STATES.join(' / ')} 之一（收到 ${JSON.stringify(raw.state ?? null)}）`,
    }
  }
  const summary = String(raw.summary ?? '').trim()
  if (!summary) {
    return { ok: false, error: 'summary 必填：用一句话说明现在在做什么 / 卡在哪 / 需要人做什么（面向用户，别写内部术语）' }
  }
  if (summary.length > RUN_REPORT_SUMMARY_MAX) {
    return { ok: false, error: `summary 过长（${summary.length} 字符，上限 ${RUN_REPORT_SUMMARY_MAX}）：只写一句话结论，细节留在正文/工作区` }
  }
  const report: NormalizedRunReport = { state, summary }
  const question = String(raw.question ?? '').trim()
  if (question) {
    if (question.length > RUN_REPORT_QUESTION_MAX) {
      return { ok: false, error: `question 过长（${question.length} 字符，上限 ${RUN_REPORT_QUESTION_MAX}）：一次只问一个具体问题` }
    }
    // dropped = 无需人处理，问题没有意义（静默丢弃而不是报错，避免模型被细节绊住）
    if (state !== 'dropped') report.question = question
  }
  return { ok: true, report }
}
