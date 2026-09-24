/**
 * ipc.ts — IPC 通道收编（命名空间 + 错误码）
 *
 * 借鉴 DeepSeek-Harness 的"命令/能力"分层思想，把散落的裸 IPC 通道按域收编：
 * - 每个新通道形如 `<namespace>:<method>`（如 `agent:create`、`sessionLog:derive`）；
 * - 统一返回 `{ ok, data } | { ok: false, error: { code, message } }`，
 *   渲染进程用 `invokeIpc()` 解包并抛出带 code 的 `IPCError`；
 * - 通道注册集中在 `electron/main/ipc-registry.ts`，便于审计与迁移。
 *
 * 注意：既有 80+ 个裸通道（loadSkills / ai:start / executeShell …）保持原样，
 * 迁移按 docs/subsystems/ipc.md 的清单逐步进行，本文件只约束新增通道。
 */

/** 稳定错误码（对齐 fail-loud 原则：能力缺失/参数非法在调用前显式失败） */
export const IpcErrorCode = {
  /** 参数缺失或非法 */
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  /** 资源不存在（agent/会话/技能/工具） */
  NOT_FOUND: 'NOT_FOUND',
  /** 能力不受支持（provider 缺能力等） */
  UNSUPPORTED: 'UNSUPPORTED',
  /** 内部错误 */
  INTERNAL: 'INTERNAL',
} as const

export type IpcErrorCodeValue = (typeof IpcErrorCode)[keyof typeof IpcErrorCode]

/** 跨进程错误：code 可被机器路由，message 面向人/模型 */
export class IPCError extends Error {
  readonly code: IpcErrorCodeValue | string
  constructor(code: IpcErrorCodeValue | string, message: string) {
    super(message)
    this.name = 'IPCError'
    this.code = code
  }
}

/** 统一的 IPC 响应信封（主进程注册通道返回；旧通道不适用） */
export type IpcResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } }

/** 序列化错误为信封（主进程使用） */
export function toIpcError(err: unknown): { code: string; message: string } {
  if (err instanceof IPCError) return { code: err.code, message: err.message }
  const message = err instanceof Error ? err.message : String(err)
  return { code: IpcErrorCode.INTERNAL, message }
}
