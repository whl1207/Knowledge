/**
 * working-directory.ts — 会话级「当前工作目录」（对齐 DSH 的 `working_directory` 工具）
 *
 * 为什么需要：AI-KM 的文件工具全都锚定 `ctx.cwd`（聊天工作区）。模型想"进到 src/ 里看看"
 * 只能写绝对路径或 `workdir` 参数，`read_file` / `write_file` / `search_files` 之间没有
 * "当前目录"的概念。DSH 用一个独立工具切换会话 cwd，之后所有工具的相对路径都跟着走。
 *
 * 约束：
 * - **只允许切到工作区内**（`workspaceRoot` 或其子目录），避免模型把写盘范围挪到工作区外；
 * - 按 agent 会话隔离（同一聊天里的多次调用共享，别的会话看不见）；
 * - 只存内存，进程重启 / 会话销毁即失效（与 DSH 的 session 生命周期一致）。
 */

const dirs = new Map<string, string>()

/** 会话键：优先 agentId（一条对话一个 agent），退化到 sessionId */
export function workingDirKey(ctx: { agentId?: string; sessionId?: string }): string {
  return String(ctx.agentId || ctx.sessionId || '')
}

/** 当前生效的工作目录（没有覆盖时返回空串，调用方回退到 ctx.cwd） */
export function getWorkingDir(key: string): string {
  return key ? dirs.get(key) || '' : ''
}

/** 设置 / 重置（dir 为空 = 重置） */
export function setWorkingDir(key: string, dir: string): void {
  if (!key) return
  if (!dir) dirs.delete(key)
  else dirs.set(key, dir)
}

/** 会话结束时清理（disposeAgent 调用） */
export function forgetWorkingDir(key: string): void {
  if (key) dirs.delete(key)
}

/** 给工具上下文用的取值：有覆盖用覆盖，否则用原 cwd */
export function cwdFor(ctx: { agentId?: string; sessionId?: string; cwd?: string }): string {
  return getWorkingDir(workingDirKey(ctx)) || String(ctx.cwd || '')
}
