/**
 * shellText.ts — 命令执行结果的**模型可见文本**（对齐 DSH 的 render）
 *
 * 为什么不再喂 JSON：`{stdout, stderr, exitCode}` 经过 `JSON.stringify` 后换行变 `\n`、
 * 引号变 `\"`，日志类输出 token 直接膨胀 10~20%。DSH 的 `bash` / `pwsh` 渲染成
 * **stdout 尾部 + `[stderr]` 段 + 每个状态标记独占一行**，本文件复刻这套约定：
 *
 * ```
 * build ok
 * [stderr]
 * warning: deprecated
 * [output truncated; full output: C:\...\shell-stdout.txt]
 * [exit code: 1]
 * ```
 *
 * 标记与 DSH 逐字对齐：`[output truncated; full output: <path>]`、
 * `[timed out after <n>ms]`、`[stopped: <reason>]`、`[killed by signal: <signal>]`、
 * `[exit code: <n>]`；没有任何输出时输出 `(no output)`。
 * 干净退出（0、无信号）**不产生** exit 标记。
 */

export interface ShellTextInput {
  stdout?: string
  stderr?: string
  exitCode?: number
  /** 被信号终止时的信号名（POSIX） */
  signal?: string
  timedOut?: boolean
  /** 超时时使用的毫秒数（拼进标记） */
  timeoutMs?: number
  /** 调用方取消 / 用户在界面上停止 */
  aborted?: boolean
  abortReason?: string
  /** 输出超过内联上限，完整内容已落盘 */
  truncated?: boolean
  /** 完整输出的落盘路径（stdout / stderr 可能各一个） */
  truncatedPaths?: string[]
}

const EMPTY_OUTPUT = '(no output)'

/** 渲染成模型可见的纯文本 */
export function renderShellText(input: ShellTextInput): string {
  const stdout = String(input.stdout ?? '')
  const stderr = String(input.stderr ?? '')
  const parts: string[] = []
  if (stdout.length) parts.push(stdout.replace(/\s+$/, ''))
  if (stderr.length) parts.push(`[stderr]\n${stderr.replace(/\s+$/, '')}`)
  if (!parts.length) parts.push(EMPTY_OUTPUT)

  const markers: string[] = []
  if (input.truncated) {
    const paths = (input.truncatedPaths || []).filter(Boolean).join(', ')
    markers.push(`[output truncated; full output: ${paths || '(unavailable)'}]`)
  }
  if (input.timedOut) markers.push(`[timed out after ${Math.max(0, Math.floor(Number(input.timeoutMs) || 0))}ms]`)
  if (input.aborted) markers.push(`[stopped: ${input.abortReason || 'cancelled'}]`)
  if (input.signal) markers.push(`[killed by signal: ${input.signal}]`)
  // 超时 / 取消已经说明"这次是被终止的"，再补一个 exit code（Windows 恒为 1）只会误导模型
  if (!input.signal && !input.timedOut && !input.aborted && typeof input.exitCode === 'number' && input.exitCode !== 0) {
    markers.push(`[exit code: ${input.exitCode}]`)
  }

  return [parts.join('\n'), ...markers].join('\n')
}
