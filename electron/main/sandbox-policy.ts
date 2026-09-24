// electron/main/sandbox-policy.ts
// 统一沙箱策略解析（路线图 2.5）：
// 把 pythonSandbox 三态（safe/workspace/trusted）升级为「每次调用先解析策略」的接缝：
//   resolvePolicy(scope) → { mode, workspaceRoot, enforcement }
// executePython / executeShell / executeSkillScript 统一走它，并返回 enforcement 报告
// （full = 完全执行只读沙箱；partial = 放行工作区写入与网络；none = 完全信任不设沙箱），
// 未知/缺省输入一律 fail-closed 落到 safe。

export type SandboxMode = 'safe' | 'workspace' | 'trusted'

export type SandboxEnforcement = 'full' | 'partial' | 'none'

export interface SandboxPolicy {
  /** 归一化后的沙箱模式 */
  mode: SandboxMode
  /** 工作区根目录（workspace 模式用于限定文件写入范围；未提供为 null） */
  workspaceRoot: string | null
  /** 执行强度报告：safe=full / workspace=partial / trusted=none */
  enforcement: SandboxEnforcement
}

/**
 * 解析一次调用的沙箱策略。
 * - 兼容旧 boolean（true=trusted, false=safe）与三态字符串；
 * - 未知/非法输入 → fail-closed 默认 'safe'（宁可不放行，不可误放行）。
 */
export function resolvePolicy(scope: unknown, opts?: { workspaceRoot?: string }): SandboxPolicy {
  let mode: SandboxMode = 'safe'
  if (scope === 'trusted' || scope === true) mode = 'trusted'
  else if (scope === 'workspace') mode = 'workspace'
  else if (scope === 'safe' || scope === false || scope == null) mode = 'safe'

  const enforcement: SandboxEnforcement = mode === 'safe' ? 'full' : mode === 'workspace' ? 'partial' : 'none'

  return {
    mode,
    workspaceRoot: opts?.workspaceRoot ?? null,
    enforcement,
  }
}

/** shell 是最高危执行面：仅在 trusted（完全信任）模式下放行（fail-closed）。 */
export function isShellAllowed(policy: SandboxPolicy): boolean {
  return policy.mode === 'trusted'
}
