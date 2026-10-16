/**
 * pluginGrantPaths.ts — 插件文件授权里「路径 × 模式」的**纯判定**
 *
 * 授权（用户亲手选过的文件 / 文件夹）落在主进程（`electron/main/plugin-grants.ts`）。
 * 但"某个路径算不算被授权、够不够写"这件事**只在这里实现一次** —— 否则读校验与写校验
 * 会各写一份 `startsWith`，迟早分叉（这个项目已经吃过"同一份事实写两遍"的亏）。
 *
 * 三条与安全直接相关的规矩：
 *
 * 1. **旧存档默认只读**：历史上授权是裸字符串数组（没有模式）。归一化时一律当 `read` ——
 *    绝不能因为引入"可写"就让已存在的授权**静默获得写权限**。
 * 2. **模式只升不降**：同一路径再次以写模式选中则升级为 `write`；再以读模式选中**不降级**
 *    （避免"我只是又选了一次，怎么就不能写了"这种莫名其妙的回退）。要降级就先撤销再选。
 * 3. **目录授权覆盖子树**，文件授权只覆盖它自己。判定是**按路径段**比较，不做朴素 `startsWith` ——
 *    否则授权 `/a/bc` 会让 `/a/bcd` 通过。
 */

export type PluginGrantMode = 'read' | 'write'

export interface PluginGrantRecord {
  path: string
  mode: PluginGrantMode
}

/** 把存档里的一条记录归成 `{ path, mode }`；非法（空路径 / 非字符串）返回 null */
export function normalizeGrantRecord(raw: unknown): PluginGrantRecord | null {
  if (typeof raw === 'string') {
    const p = raw.trim()
    // 旧格式：只读（见顶部规矩 1）
    return p ? { path: p, mode: 'read' } : null
  }
  if (!raw || typeof raw !== 'object') return null
  const src = raw as Record<string, unknown>
  const p = typeof src.path === 'string' ? src.path.trim() : ''
  if (!p) return null
  const mode: PluginGrantMode = src.mode === 'write' ? 'write' : 'read'
  return { path: p, mode }
}

/** 归一化一整组记录（丢掉非法项；去重时取更强模式） */
export function normalizeGrantRecords(raw: unknown, limit = 32): PluginGrantRecord[] {
  if (!Array.isArray(raw)) return []
  const out: PluginGrantRecord[] = []
  for (const item of raw) {
    const rec = normalizeGrantRecord(item)
    if (!rec) continue
    const existing = out.find((r) => samePath(r.path, rec.path))
    if (existing) existing.mode = strongerMode(existing.mode, rec.mode)
    else out.push(rec)
    if (out.length >= limit) break
  }
  return out
}

/** `write` 强于 `read` */
export function strongerMode(a: PluginGrantMode, b: PluginGrantMode): PluginGrantMode {
  return a === 'write' || b === 'write' ? 'write' : 'read'
}

/** 路径是否相等（按需忽略大小写：Windows / macOS 的默认文件系统不区分） */
export function samePath(a: string, b: string, caseInsensitive = false): boolean {
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * 目标是否落在某个授权根内（自身或子项）。
 *
 * **按路径段比较**：`/a/bc` 不是 `/a/bcd` 的根，`/a/b` 是 `/a/b/c` 的根。
 * 调用方负责先把两边都 `path.resolve` 过（去掉 `..` 与末尾分隔符）。
 */
export function isInsideGrantRoot(target: string, root: string, caseInsensitive = false): boolean {
  const t = stripTrailingSep(target)
  const r = stripTrailingSep(root)
  if (!t || !r) return false
  const [a, b] = caseInsensitive ? [t.toLowerCase(), r.toLowerCase()] : [t, r]
  if (a === b) return true
  return a.startsWith(b.endsWith('/') ? b : `${b}/`)
}

/** 统一分隔符并去掉末尾分隔符（纯字符串操作，不碰文件系统） */
export function stripTrailingSep(p: string): string {
  const normalized = String(p ?? '').replace(/\\/g, '/')
  if (normalized === '/' || /^[a-zA-Z]:\/?$/.test(normalized)) {
    return normalized.endsWith('/') && normalized.length > 1 ? normalized.slice(0, -1) : normalized
  }
  return normalized.replace(/\/+$/, '')
}

/**
 * 找出覆盖该目标的授权。多条命中时：
 * - **模式取最强**（用户对这些根给过的权限是并集，任一根可写就可写）；
 * - **路径取最具体**（最长的那个根，用于报错/展示时说得准确）。
 */
export function matchGrant(
  target: string,
  grants: readonly PluginGrantRecord[],
  caseInsensitive = false,
): PluginGrantRecord | null {
  let bestPath: string | null = null
  let bestMode: PluginGrantMode = 'read'
  for (const g of grants) {
    if (!isInsideGrantRoot(target, g.path, caseInsensitive)) continue
    bestMode = strongerMode(bestMode, g.mode)
    if (bestPath === null || g.path.length > bestPath.length) bestPath = g.path
  }
  return bestPath === null ? null : { path: bestPath, mode: bestMode }
}

export interface GrantAccessResult {
  ok: boolean
  /** 命中的授权模式（`ok` 为真时有值） */
  mode?: PluginGrantMode
  /** 拒绝时的可读原因（原样交给插件作者，所以要说清是"没授权"还是"只读"） */
  reason?: string
}

/**
 * 判定一次访问是否放行。
 *
 * @param need `read` 允许只读授权；`write` **只认**写授权（只读授权不能写）
 */
export function checkGrantAccess(
  target: string,
  grants: readonly PluginGrantRecord[],
  need: PluginGrantMode,
  caseInsensitive = false,
): GrantAccessResult {
  const hit = matchGrant(target, grants, caseInsensitive)
  if (!hit) {
    return {
      ok: false,
      reason: `未授权访问：${target}（只能访问你在该插件里选择过的文件 / 文件夹）`,
    }
  }
  if (need === 'write' && hit.mode !== 'write') {
    return {
      ok: false,
      reason: `只读授权不能写入：${target}（该路径是你以"只读"方式授权给这个插件的；要写请重新以"可写文件夹"选一次）`,
    }
  }
  return { ok: true, mode: hit.mode }
}
