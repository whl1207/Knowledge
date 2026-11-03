/**
 * attention.ts — 「待我处理」收件箱的共享类型（主进程 / 渲染层都会读，但只声明类型）
 *
 * 语义约定（见 docs/plan/待我处理收件箱-实施方案（逐文件）.md）：
 * - **待我处理**（kind = question / plan / run-failed / run-ready / system）：不解决不消失，
 *   没有「已读」；只有动作，或（P2 起）明确的「忽略 + 原因」；
 * - **动态**（不进本文件的 Actionable 区）：可已读、可清空、按天归档。
 *
 * P1 只产出 question / plan 两类；后三类先占位，P2 接入时无需改面板组件。
 */

import type { AskUserQuestion } from '@/types/agent'

/** 条目来源类别 */
export type AttentionKind = 'question' | 'plan' | 'run-failed' | 'run-ready' | 'system'

/** 面板内的分组（顺序即展示顺序，见 lib/attention/model.ts 的 GROUP_ORDER） */
export type AttentionGroup = 'answer' | 'decide' | 'problem' | 'review' | 'system'

/** 可用动作。同一动作在各类条目上的语义由 store/attention.ts 负责翻译成真实调用 */
export type AttentionActionId =
  | 'answer'
  | 'approve'
  | 'keep-planning'
  /** 计划评审的「关闭」（dismiss 裁决）；P2 起也用于「忽略一条失败」 */
  | 'dismiss'
  | 'open'
  | 'stop-session'

export interface AttentionAction {
  id: AttentionActionId
  /** 文案在这里给定（中英各一份），不在模板里拼 */
  label: { zh: string; en: string }
  /** 主操作（一条最多一个） */
  primary?: boolean
  /** 破坏性操作（按钮用警示色） */
  danger?: boolean
}

export interface AttentionItem {
  /** 幂等键：`${kind}:${sessionId}:${refId}`，列表 key 与去重用 */
  key: string
  kind: AttentionKind
  group: AttentionGroup
  /** 动作化标题（来自数据，≤1 行；空串时 UI 用 fallbackTitle 兜底） */
  title: string
  /** 次行摘要（可选） */
  summary?: string
  /** 归属会话（回答 / 打开原处都要它） */
  sessionId: string
  /** 会话标签（智能体名 / 群成员名 / 预设名），用于次行来源 */
  sessionLabel?: string
  /** 反查出来的聊天 id；undefined = 不显示「打开原处」（不要给点了没反应的按钮） */
  chatId?: string
  /** 首次出现时间（排序用；由 store 的首次观察表给出） */
  at: number
  actions: AttentionAction[]
  payload: {
    askId?: string
    reviewId?: string
    questions?: AskUserQuestion[]
    plan?: string
  }
}
