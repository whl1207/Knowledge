/**
 * shellText.selftest.ts — 命令结果文本化的自测
 *
 * 覆盖 DSH 对齐的标记约定：`[stderr]` 段、`[output truncated; full output: …]`、
 * `[timed out after Nms]`、`[stopped: …]`、`[killed by signal: …]`、`[exit code: N]`、
 * 无输出时的 `(no output)`，以及"干净退出不产生 exit 标记"。
 */

import { renderShellText } from '@/shared/shellText'

export interface SelfTestCase {
  name: string
  ok: boolean
  detail?: string
}

export function runShellTextSelfTest(): SelfTestCase[] {
  const cases: SelfTestCase[] = []
  const check = (name: string, ok: boolean, detail?: string) =>
    cases.push({ name, ok, ...(detail ? { detail } : {}) })

  check('干净退出：只有 stdout，无标记', renderShellText({ stdout: 'ok\n', exitCode: 0 }) === 'ok')
  check('无输出 → (no output)', renderShellText({ exitCode: 0 }) === '(no output)')
  check(
    'stderr 走独立段落',
    renderShellText({ stdout: 'out', stderr: 'warn', exitCode: 0 }) === 'out\n[stderr]\nwarn',
    renderShellText({ stdout: 'out', stderr: 'warn', exitCode: 0 }),
  )
  check(
    '非零退出 → [exit code: N]',
    renderShellText({ stdout: 'x', exitCode: 2 }) === 'x\n[exit code: 2]',
    renderShellText({ stdout: 'x', exitCode: 2 }),
  )
  check(
    '被信号终止 → 只有 signal 标记，不叠加 exit code',
    renderShellText({ stdout: '', exitCode: 137, signal: 'SIGKILL' }) === '(no output)\n[killed by signal: SIGKILL]',
    renderShellText({ stdout: '', exitCode: 137, signal: 'SIGKILL' }),
  )
  check(
    '超时标记带毫秒数',
    renderShellText({ stdout: 'partial', timedOut: true, timeoutMs: 120000 }).includes('[timed out after 120000ms]'),
  )
  check(
    '取消标记带原因',
    renderShellText({ aborted: true, abortReason: '用户停止' }).includes('[stopped: 用户停止]'),
  )
  check(
    '截断标记带落盘路径',
    renderShellText({ stdout: 'tail', truncated: true, truncatedPaths: ['C:/tmp/a.txt'] })
      === 'tail\n[output truncated; full output: C:/tmp/a.txt]',
    renderShellText({ stdout: 'tail', truncated: true, truncatedPaths: ['C:/tmp/a.txt'] }),
  )
  check(
    '落盘不可用 → (unavailable)',
    renderShellText({ truncated: true }).includes('[output truncated; full output: (unavailable)]'),
  )
  check(
    '多个标记按固定顺序排列',
    renderShellText({ stdout: 'x', timedOut: true, timeoutMs: 1000, exitCode: 0 })
      === 'x\n[timed out after 1000ms]',
    renderShellText({ stdout: 'x', timedOut: true, timeoutMs: 1000, exitCode: 0 }),
  )
  check(
    '超时时不叠加误导性的 exit code（Windows 杀进程恒为 1）',
    !renderShellText({ stdout: 'x', timedOut: true, timeoutMs: 1000, exitCode: 1 }).includes('[exit code:'),
  )
  check(
    '取消时同样不叠加 exit code',
    !renderShellText({ aborted: true, exitCode: 1 }).includes('[exit code:'),
  )

  return cases
}
