/**
 * plugin-approval.ts — 插件变更类操作的审批门槛（独立接缝，便于测试与复用）
 *
 * 与 sandbox-policy.ts 同一思路：把「策略」从「执行」里拆出来，成为可单测的纯函数。
 *
 * 模型（对齐 dsh 的 plugin_manager：每个操作都要求 danger-full-access 或本次调用批准）：
 * - 只读操作（list / inspect / logs / openDir / getConfig）**无需**审批；
 * - 变更操作（enable / disable / reload / uninstall / setConfig）必须携带
 *   `confirm: true`——代表 UI 已把「权限清单 + 插件不受沙箱保护」展示给用户并得到确认；
 * - 未确认时抛 `PERMISSION_DENIED`，调用方**不得**改变任何状态。
 *
 * ⚠️ 这只是「用户意图确认」，不是沙箱：插件代码与宿主同进程，一旦加载即拥有宿主权限。
 */

import { IPCError } from '@/types/ipc'

/** 变更类操作清单（新增变更操作必须登记在这里，避免漏掉审批） */
export const PLUGIN_MUTATING_ACTIONS = ['enable', 'disable', 'reload', 'uninstall', 'setConfig'] as const

export type PluginMutatingAction = (typeof PLUGIN_MUTATING_ACTIONS)[number]

export function isPluginMutatingAction(action: string): action is PluginMutatingAction {
  return (PLUGIN_MUTATING_ACTIONS as readonly string[]).includes(action)
}

/**
 * 校验变更操作是否已获用户确认。
 * @param payload IPC 载荷（须含 `confirm === true`）
 * @param action 面向人的动作描述（进错误文案与审计日志）
 */
export function requirePluginApproval(payload: { confirm?: unknown } | undefined, action: string): void {
  if (payload?.confirm === true) {
    console.log(`[plugin-approval] [audit] ${action}（用户已确认）`)
    return
  }
  throw new IPCError(
    'PERMISSION_DENIED',
    `「${action}」需要用户确认：插件与宿主同进程运行、不受工作区沙箱保护，`
      + 'UI 需先展示其权限并弹确认框，再以 { confirm: true } 重试',
  )
}
