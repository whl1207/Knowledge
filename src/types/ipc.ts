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
  /** 权限不足（插件未声明该权限 / 沙箱策略拒绝 / 用户未批准） */
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** 插件不存在（未安装 / id 非法） */
  PLUGIN_NOT_FOUND: 'PLUGIN_NOT_FOUND',
  /** 同名插件已存在（安装时需用户确认是否覆盖） */
  PLUGIN_EXISTS: 'PLUGIN_EXISTS',
  /** 插件加载失败（入口缺失 / apply 抛异常） */
  PLUGIN_LOAD_FAILED: 'PLUGIN_LOAD_FAILED',
  /** 插件要求的宿主 API 版本与当前宿主不匹配 */
  API_VERSION_MISMATCH: 'API_VERSION_MISMATCH',
  /** 插件委派智能体超出预算（并发 / 每小时调用数上限） */
  PLUGIN_AGENT_BUDGET: 'PLUGIN_AGENT_BUDGET',

  // -------------------------------------------------------------------------
  // 插件能力收敛（docs/plan/插件能力面向DSH风格收敛-设计方案（逐文件）.md）
  // `ctx.fs` 的稳定错误码。插件按 code 分支，绝不解析 message 文案。
  // -------------------------------------------------------------------------

  /** 文件不存在 */
  FS_NOT_FOUND: 'FS_NOT_FOUND',
  /** 目标不是目录（该传文件的地方传了目录，或反之） */
  FS_NOT_DIRECTORY: 'FS_NOT_DIRECTORY',
  /** 目标不是文本（二进制 / 非 UTF-8） */
  FS_NOT_TEXT: 'FS_NOT_TEXT',
  /** 超过调用方声明的上限（**报错而不是截断**） */
  FS_TOO_LARGE: 'FS_TOO_LARGE',
  /** 版本不符：文件在读取之后被改过（或 presence 要求不满足） */
  FS_STALE_VERSION: 'FS_STALE_VERSION',
  /** 字面量编辑有歧义（命中 0 处或多处） */
  FS_AMBIGUOUS_EDIT: 'FS_AMBIGUOUS_EDIT',
  /** 先读后写策略：目标未被本会话读过 */
  FS_NOT_OBSERVED: 'FS_NOT_OBSERVED',
  /** 路径不在该插件的授权范围内 */
  FS_NOT_GRANTED: 'FS_NOT_GRANTED',
  /** 只读授权下尝试写入 */
  FS_READ_ONLY_GRANT: 'FS_READ_ONLY_GRANT',
  /** 文件能力其它失败（I/O 异常等） */
  FS_FAILED: 'FS_FAILED',
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
