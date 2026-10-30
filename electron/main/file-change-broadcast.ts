/**
 * file-change-broadcast.ts — 把「文件内容已变」广播给所有窗口
 *
 * 为什么需要：渲染层的编辑器保存后会走 `notify-file-changed`（`src/platform/electron`），
 * 但 **agent 工具写盘不经过编辑器**：`write_file` / `replace_in_file` / `multi_replace`
 * 只在主进程 fs 层落盘，已打开的文件标签 / 独立文件窗口收不到任何通知，于是界面一直显示
 * 旧内容（用户会以为替换没生效）。
 *
 * 与 `ipcMain.handle('notify-file-changed')` 用同一条通道 `file-content-changed`，
 * 且**必须带 content**：FileWindow 的处理是 `payloadContent ?? ''`，不带内容会把正文刷成空白。
 *
 * 注意：不要在这里调用 `markSelfWrite`。那是"用户自己保存、别提示我"的抑制逻辑；
 * agent 写盘对界面来说就是外部变更，应该让视图刷新（`watchedFileChanged` 那条路仍会被抑制，
 * 这里走的是另一条通道）。
 */

import { BrowserWindow } from 'electron'

/** 广播一次文件内容变更（path 必填；content 建议总是带上） */
export function broadcastFileChanged(filePath: string, content?: string): void {
  const target = String(filePath || '')
  if (!target) return
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send('file-content-changed', { path: target, content })
    } catch {
      /* 窗口正在销毁 / 渲染进程已崩：忽略这一扇窗，不影响其它窗口 */
    }
  }
}
