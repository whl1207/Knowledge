/**
 * plugin-agent-budget.ts — 插件委派智能体的**用量记账**（并发 + 每小时调用数）
 *
 * 与 `plugin-grants.ts` 同一套路：内存缓存 + 原子落盘（先写 tmp 再改名）+ 坏文件当空清单。
 * 文件：`userData/plugin-agent-usage.json`。
 *
 * 判定逻辑本身是**纯函数**，在 `src/lib/plugin/agentContract.ts`（`canStartCall` / `pruneCallWindow`）——
 * 那里已被自测覆盖；本模块只负责"存哪、什么时候清"，不重复实现判定。
 *
 * 为什么并发要放内存、调用数要落盘：
 * - 并发是"进程内同时在飞几个"，进程重启即归零，落盘反而会制造幽灵占用；
 * - 调用数是**限速**，跨重启必须保留，否则重启一次就白送一小时额度。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

import { AGENT_RUN_LIMITS, canStartCall } from '@/lib/plugin/agentContract'
import { agentConfigOf } from './plugin-agent-config'

const USAGE_FILE = 'plugin-agent-usage.json'
/** 单个插件最多记多少条时间戳（窗口是 1 小时，上限 200 次/小时，留 2 倍余量足够） */
const MAX_PER_PLUGIN = AGENT_RUN_LIMITS.callsPerHour.max * 2
const VERSION = 1

interface UsageStore {
  version: number
  /** 插件 id → 发起时间戳（新的在前） */
  byPlugin: Record<string, number[]>
}

/** 内存缓存：判定是同步调用，不能每次读盘 */
let store: UsageStore | null = null
/** 正在飞行中的委派数（按插件 id；进程内） */
const inFlight = new Map<string, number>()

function storeFile(): string {
  return path.join(app.getPath('userData'), USAGE_FILE)
}

function loadStore(): UsageStore {
  if (store) return store
  const byPlugin: Record<string, number[]> = {}
  try {
    const parsed = JSON.parse(readFileSync(storeFile(), 'utf8')) as Partial<UsageStore>
    for (const [id, list] of Object.entries(parsed?.byPlugin || {})) {
      if (!id || !Array.isArray(list)) continue
      const stamps = list.filter((t): t is number => Number.isFinite(t)).slice(0, MAX_PER_PLUGIN)
      if (stamps.length) byPlugin[id] = stamps
    }
  } catch {
    /* 还没有这个文件 / 文件坏了：当空清单处理（最坏后果是多给一次额度，不会卡住用户） */
  }
  store = { version: VERSION, byPlugin }
  return store
}

function saveStore(): void {
  const current = store
  if (!current) return
  // ⚠️ `storeFile()` 必须在 try **里面**：`app.getPath('userData')` 在极端情况下会抛
  // （例如无 userData 的运行方式），而记账失败不该让委派本身失败 —— 那条路我们选择降级。
  try {
    const file = storeFile()
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(current, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch (e) {
    console.warn('[plugin-agent-budget] 保存用量失败（本次运行内仍然生效）:', e)
  }
}

/** 该插件当前在飞的委派数 */
export function inFlightOf(pluginId: string): number {
  return inFlight.get(String(pluginId || '').trim()) ?? 0
}

/** 该插件本窗口内已发起的次数（会顺手丢掉窗口外的） */
export function callsInWindowOf(pluginId: string, now = Date.now()): number {
  const id = String(pluginId || '').trim()
  if (!id) return 0
  const r = canStartCall(loadStore().byPlugin[id] ?? [], now)
  return r.used
}

export interface AcquireResult {
  ok: boolean
  /** 拒绝时的可读原因（会原样交给插件作者，所以要说清是并发还是限速、以及上限是多少） */
  reason?: string
  inFlight: number
  callsInWindow: number
}

/**
 * 每个插件的并发上限 —— **由用户在「插件 → 插件权限」里调**（默认 1，天花板 3）。
 *
 * 判定数据在 `plugin-agent-config.ts`；这里只读，不重复实现钳制（钳制在契约层的
 * `normalizePluginAgentLimits`，存进去的就是生效的）。
 */
function concurrencyLimitFor(pluginId: string): number {
  return agentConfigOf(pluginId).limits.concurrency
}

/** 每个插件的每小时次数上限（同上，默认 20，天花板 200） */
function callsPerHourLimitFor(pluginId: string): number {
  return agentConfigOf(pluginId).limits.callsPerHour
}

/**
 * 尝试占用一个名额（并发 + 限速两者都过才算成功）。
 * 成功时**立刻记账**：宁可多记一次（一次失败的调用也占额度），也不要漏记导致限速形同虚设。
 * 调用方必须在 finally 里配对 `releaseSlot`。
 */
export function acquireSlot(pluginId: string, now = Date.now()): AcquireResult {
  const id = String(pluginId || '').trim()
  if (!id) return { ok: false, reason: '缺少插件 id', inFlight: 0, callsInWindow: 0 }

  const limit = concurrencyLimitFor(id)
  const current = inFlightOf(id)
  if (current >= limit) {
    return {
      ok: false,
      reason: `并发上限：该插件同时最多 ${limit} 个委派（当前 ${current}）`,
      inFlight: current,
      callsInWindow: callsInWindowOf(id, now),
    }
  }

  const data = loadStore()
  const r = canStartCall(data.byPlugin[id] ?? [], now, callsPerHourLimitFor(id))
  if (!r.ok) {
    return {
      ok: false,
      reason: `调用频率上限：该插件每小时最多 ${r.limit} 次委派（本窗口已用 ${r.used}）`,
      inFlight: current,
      callsInWindow: r.used,
    }
  }

  data.byPlugin[id] = [now, ...r.timestamps].slice(0, MAX_PER_PLUGIN)
  saveStore()
  inFlight.set(id, current + 1)
  return { ok: true, inFlight: current + 1, callsInWindow: r.used + 1 }
}

/** 释放一个名额（幂等；与 acquireSlot 严格配对） */
export function releaseSlot(pluginId: string): void {
  const id = String(pluginId || '').trim()
  if (!id) return
  const current = inFlight.get(id) ?? 0
  if (current <= 1) inFlight.delete(id)
  else inFlight.set(id, current - 1)
}

/** 清掉某插件的用量记录（「插件 → 数据」撤销 / 卸载时调用） */
export function clearUsage(pluginId: string): boolean {
  const id = String(pluginId || '').trim()
  if (!id) return false
  inFlight.delete(id)
  controllers.delete(id)
  const data = loadStore()
  if (!data.byPlugin[id]) return false
  delete data.byPlugin[id]
  saveStore()
  return true
}

// ---------------------------------------------------------------------------
// 在飞委派的取消
//
// 设计里的要求：「插件卸载 / 禁用时撤销该插件在飞行的委派」，否则会出现
// **插件没了、钱还在烧**。取消句柄按插件 id 记账，卸载路径调 abortPluginRuns。
// ---------------------------------------------------------------------------

/** 插件 id → 在飞委派的取消句柄 */
const controllers = new Map<string, Set<AbortController>>()

/** 登记一个取消句柄；返回注销函数（调用方在 finally 里调） */
export function trackController(pluginId: string, controller: AbortController): () => void {
  const id = String(pluginId || '').trim()
  if (!id) return () => {}
  let set = controllers.get(id)
  if (!set) {
    set = new Set()
    controllers.set(id, set)
  }
  set.add(controller)
  return () => {
    const cur = controllers.get(id)
    if (!cur) return
    cur.delete(controller)
    if (!cur.size) controllers.delete(id)
  }
}

/** 取消某插件全部在飞委派；返回取消了几个（卸载 / 禁用 / 清数据时调用） */
export function abortPluginRuns(pluginId: string): number {
  const id = String(pluginId || '').trim()
  if (!id) return 0
  const set = controllers.get(id)
  if (!set || !set.size) return 0
  const n = set.size
  for (const c of Array.from(set)) {
    try {
      c.abort()
    } catch {
      /* 忽略：abort 不该抛 */
    }
  }
  controllers.delete(id)
  return n
}

/** 给设置页看的用量快照 */
export function usageSnapshot(): Record<string, { inFlight: number; callsInWindow: number }> {
  const now = Date.now()
  const out: Record<string, { inFlight: number; callsInWindow: number }> = {}
  for (const id of Object.keys(loadStore().byPlugin)) {
    out[id] = { inFlight: inFlightOf(id), callsInWindow: callsInWindowOf(id, now) }
  }
  for (const id of inFlight.keys()) {
    if (!out[id]) out[id] = { inFlight: inFlightOf(id), callsInWindow: 0 }
  }
  return out
}
