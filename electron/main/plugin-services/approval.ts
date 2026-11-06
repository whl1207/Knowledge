/**
 * approval.ts — `ctx.approval` 的实现（P2）
 *
 * 与 `plugin-tool-approval` 共用同一条 `approval/request` 拦截链：
 * - 先让插件认领（手机 / 远程桥可以在手机上回答）；
 * - 无人认领 → 宿主弹框；
 * - 没有窗口 → **fail-closed 到 rejected**（绝不因为"问不到"就放行）。
 */

import { BrowserWindow, dialog } from 'electron'
import type { PluginLogger } from '@/types/plugin'
import type { ApprovalOutcome, ApprovalRequest, PluginApprovalService } from '@/shared/pluginServices'
import { runPluginWaterfall } from '../plugin-waterfall'

async function askByDialog(request: ApprovalRequest): Promise<ApprovalOutcome> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return 'rejected'
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['允许一次', '拒绝'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: '需要确认',
    message: String(request.displayReason || request.reason || request.toolName || '插件请求执行一个操作'),
    detail: request.command ? `命令：${String(request.command)}` : '这次允许只对本次调用有效。',
  })
  return response === 0 ? 'allowed-once' : 'rejected'
}

export function createApprovalService(log: PluginLogger): PluginApprovalService {
  return {
    async request(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalOutcome> {
      if (signal?.aborted) return 'cancelled'
      const outcome = await runPluginWaterfall<ApprovalOutcome>(
        'approval/request',
        request,
        () => askByDialog(request),
      )
      if (signal?.aborted && outcome === 'allowed-once') return 'cancelled'
      log.debug(`[approval] ${request.toolName || request.requestId} → ${outcome}`)
      return outcome
    },
  }
}
