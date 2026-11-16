/**
 * timing-log.ts — 轻量性能埋点（追加到 `<userData>/timing.log`）
 *
 * 为什么需要：插件面板「打开要卡几秒」这类问题，靠读代码只能猜是哪一段（列表 IPC /
 * 数据统计 / 客户端半边装载）。这里给一条**可落盘**的通道：渲染层把关键阶段耗时发过来，
 * 主进程按行追加，事后直接看文件就能定位，不用让用户开 DevTools。
 *
 * 约束：
 * - 只写 ASCII 标签 + 数字，避免日志编码问题；
 * - 单文件超过 512KB 时截断重写（保留最近一段），不会无限增长；
 * - 任何异常都吞掉——埋点绝不能影响功能。
 */

import { app } from 'electron'
import { appendFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BYTES = 512 * 1024

function filePath(): string {
  return join(app.getPath('userData'), 'timing.log')
}

/** 记录一条耗时（label 用英文/数字，extra 拼在行尾） */
export function recordTiming(label: string, ms: number, extra?: string): void {
  try {
    const path = filePath()
    try {
      if (statSync(path).size > MAX_BYTES) {
        renameSync(path, `${path}.1`)
        writeFileSync(path, '', 'utf8')
      }
    } catch { /* 文件还不存在 */ }
    const line = `${new Date().toISOString()} ${String(label).slice(0, 80)} ${Math.round(Number(ms) || 0)}ms${extra ? ` ${String(extra).slice(0, 200)}` : ''}\n`
    appendFileSync(path, line, 'utf8')
  } catch { /* 埋点失败不影响功能 */ }
}
