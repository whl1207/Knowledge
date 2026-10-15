/**
 * chatWorkspace.ts — 工作区相关的纯逻辑：**每个聊天自己的激活工作区** + 按工作区分组
 *
 * 为什么需要「每个聊天一份」：
 * - 一个聊天可以对着不同项目/目录干活，切聊天时不该把另一个聊天的目录也换掉；
 * - 聊天自己的工作区要注入智能体上下文（system prompt 的当前工作目录 + 工具路径围栏），
 *   并作为右侧栏「文件 / 终端」的默认位置。
 *
 * 全局的 `store.root` 仍然保留，但角色变成**默认工作区**（兜底）：聊天没选过就跟随它；
 * 知识管理、文件树这些「不在某个聊天里」的界面也继续用它。
 *
 * 本文件不依赖 Vue / DOM，可直接自测（见 chatWorkspace.selftest.ts）。
 */

/** 能承载「自己的激活工作区」的聊天（只描述本模块需要的形状） */
export interface WorkspaceHolder {
  workspace?: string
}

/**
 * 读某个聊天实际生效的工作区：自己选过就用自己那份，否则回落到默认工作区。
 * 两侧都为空时返回 ''（上层按「未选择工作区」提示）。
 */
export function readChatWorkspace(chat: WorkspaceHolder | null | undefined, fallback = ''): string {
  const own = String(chat?.workspace ?? '').trim()
  if (own) return own
  return String(fallback ?? '').trim()
}

/** 路径末段（展示用）；容忍 / 与 \、结尾多余的斜杠 */
export function workspaceBaseName(path: string): string {
  const parts = String(path || '').replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

/** 分组用的比较键：统一分隔符 + 去掉结尾斜杠（大小写不敏感，Windows 常见） */
function workspaceKey(path: string): string {
  return String(path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export interface WorkspaceGroup<T> {
  /** 工作区路径（'' = 未选择工作区）；同一组保留**首次出现**的原始写法 */
  workspace: string
  /** 展示名（路径末段；空路径用 fallbackLabel） */
  label: string
  /** 该组下的条目（保持传入顺序） */
  items: T[]
}

/**
 * 按工作区把条目分组：
 * - 组顺序：给了 `order`（例如工作区注册表顺序）就按它排，未登记的组按首次出现追加；
 * - **「未选择工作区」永远排最后**（它是一个兜底桶，不是真正的工作区）；
 * - 只在结尾斜杠 / 分隔符上不同的路径算同一组；
 * - 不改动入参。
 */
export function groupByWorkspace<T>(
  items: readonly T[],
  pathOf: (item: T) => string,
  opts: { emptyLabel?: string; order?: readonly string[] } = {},
): WorkspaceGroup<T>[] {
  const emptyLabel = opts.emptyLabel ?? ''
  const groups = new Map<string, WorkspaceGroup<T>>()
  const order: string[] = []

  for (const item of items) {
    const raw = String(pathOf(item) ?? '').trim()
    const key = workspaceKey(raw)
    let group = groups.get(key)
    if (!group) {
      group = { workspace: raw, label: workspaceBaseName(raw) || emptyLabel, items: [] }
      groups.set(key, group)
      order.push(key)
    }
    group.items.push(item)
  }

  const rank = new Map<string, number>()
  for (const [i, p] of (opts.order || []).entries()) rank.set(workspaceKey(p), i)

  const sorted = order
    .map((key, i) => ({ key, i, group: groups.get(key)! }))
    .sort((a, b) => {
      const ra = rank.has(a.key) ? rank.get(a.key)! : Number.MAX_SAFE_INTEGER
      const rb = rank.has(b.key) ? rank.get(b.key)! : Number.MAX_SAFE_INTEGER
      if (ra !== rb) return ra - rb
      return a.i - b.i
    })
    .map((entry) => entry.group)

  // 未选择工作区分组永远放最后
  const empty: WorkspaceGroup<T>[] = []
  const rest: WorkspaceGroup<T>[] = []
  for (const g of sorted) (workspaceKey(g.workspace) ? rest : empty).push(g)
  return [...rest, ...empty]
}
