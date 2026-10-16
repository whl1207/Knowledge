/**
 * plugin-grants.ts — 插件文件授权（「已记住的路径」）的持久化
 *
 * 背景：插件的 `fs` 权限只表示「它想读写文件」，具体哪个路径能用由主进程的
 * capability allowlist 决定——只有「用户在该插件里亲自选过」的文件 / 文件夹才放行。
 * 这份清单原先只活在一次运行里，于是「上次选的目录」每次开机都要再选一遍。这里把它落盘。
 *
 * **写入只有两个入口，都必须是用户亲手点的**：
 *   1. 选文件 / 选文件夹（只读）：`plugin:files:pick` / `pick-dir`；
 *   2. 选一个**可写文件夹**：`plugin:files:pick-writable`（授权模式为 `write`）。
 * 插件没有任何办法给自己加路径，也没有办法把只读授权升级成可写。
 *
 * - **撤销入口**：设置 → 插件 → 数据（逐条撤销 / 全部撤销），卸载插件时也会一起清掉；
 * - 文件落在 `userData/plugin-fs-grants.json`，先写临时文件再改名，写坏也只会退回空清单。
 *
 * 判定逻辑（路径归一、模式强弱、按路径段比较）全部在 `src/shared/pluginGrantPaths.ts`，
 * 本模块只负责"存哪、怎么读、坏了怎么办"。
 *
 * ⚠️ 这不是沙箱：记住的只是「用户点过的那几个路径」，越界（含兄弟目录、写死的绝对路径）照样拒绝。
 * 特别注意"只读"与"可写"是**两个不同的授权**：只读授权下写入一律拒绝（见 checkGrantAccess）。
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

import { IPCError } from '@/types/ipc'
import {
  checkGrantAccess,
  normalizeGrantRecords,
  samePath,
  strongerMode,
  type PluginGrantMode,
  type PluginGrantRecord,
} from '@/shared/pluginGrantPaths'

const GRANTS_FILE = 'plugin-fs-grants.json'
/** 单个插件最多记住多少条（插件反复弹选择框也不会把清单撑爆） */
const MAX_PER_PLUGIN = 32
const VERSION = 2

/** Windows / macOS 的默认文件系统不区分大小写，路径判定要跟着走（Linux 严格） */
const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin'

export interface PluginGrantEntry {
  path: string
  /** `read` = 只读；`write` = 可写（可读 + 可在其中创建 / 覆盖） */
  mode: PluginGrantMode
  /** 现在还是个文件夹吗（可能已被删除 / 改名） */
  isDir: boolean
  exists: boolean
}

interface GrantsStore {
  version: number
  /** 插件 id → 用户选过的绝对路径与模式（新的在前） */
  byPlugin: Record<string, PluginGrantRecord[]>
}

/** 内存缓存：路径校验是同步调用，不能每次都读盘 */
let store: GrantsStore | null = null

function storeFile(): string {
  return path.join(app.getPath('userData'), GRANTS_FILE)
}

function loadStore(): GrantsStore {
  if (store) return store
  const byPlugin: Record<string, PluginGrantRecord[]> = {}
  try {
    const parsed = JSON.parse(readFileSync(storeFile(), 'utf8')) as Partial<GrantsStore>
    for (const [id, list] of Object.entries(parsed?.byPlugin || {})) {
      if (!id) continue
      // 归一化在纯函数里：**旧存档（裸字符串数组）一律读成只读**，绝不让既有授权静默获得写权限
      const records = normalizeGrantRecords(list, MAX_PER_PLUGIN).map((r) => ({
        path: path.resolve(r.path),
        mode: r.mode,
      }))
      if (records.length) byPlugin[id] = records
    }
  } catch {
    /* 还没有这个文件 / 文件坏了：当空清单处理，插件会再让用户选一次 */
  }
  store = { version: VERSION, byPlugin }
  return store
}

function saveStore(): void {
  const current = store
  if (!current) return
  const file = storeFile()
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(current, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch (e) {
    console.warn('[plugin-grants] 保存插件文件授权失败（本次运行内仍然有效）:', e)
  }
}

/**
 * 记住用户选过的路径（唯一写入入口）。
 *
 * 同一路径已存在时**只升不降**：再次以 `write` 选中则升级；再以 `read` 选中保持原样
 * （避免"我只是又选了一次，怎么就不能写了"这种莫名回退。要降级就先撤销再选）。
 */
export function addGrant(pluginId: string, target: string, mode: PluginGrantMode = 'read'): PluginGrantRecord | null {
  const id = String(pluginId || '').trim()
  if (!id || !String(target || '').trim()) return null
  const resolved = path.resolve(String(target))
  const data = loadStore()
  const list = data.byPlugin[id] || []
  const existing = list.find((r) => samePath(r.path, resolved, CASE_INSENSITIVE_PATHS))
  if (existing) {
    existing.mode = strongerMode(existing.mode, mode)
    saveStore()
    return { ...existing }
  }
  const rec: PluginGrantRecord = { path: resolved, mode }
  data.byPlugin[id] = [rec, ...list].slice(0, MAX_PER_PLUGIN)
  saveStore()
  return { ...rec }
}

/** 该插件被授权访问的路径（同步；来自内存缓存，含只读与可写） */
export function grantPaths(pluginId: string): string[] {
  return grantRecords(pluginId).map((r) => r.path)
}

/** 该插件的全部授权记录（含模式） */
export function grantRecords(pluginId: string): PluginGrantRecord[] {
  const id = String(pluginId || '').trim()
  if (!id) return []
  return (loadStore().byPlugin[id] || []).map((r) => ({ ...r }))
}

/** 该插件的**可写**授权根（只有这些目录 / 文件里能写） */
export function writableGrantPaths(pluginId: string): string[] {
  return grantRecords(pluginId)
    .filter((r) => r.mode === 'write')
    .map((r) => r.path)
}

/**
 * 路径校验（读 / 写共用一处判定）：
 * - `need='read'`：任何授权（只读或可写）都放行；
 * - `need='write'`：**只认可写授权**。
 *
 * 拒绝时抛 `IPCError`（消息里说清是"未授权"还是"只读授权不能写"），由上层原样交给插件作者。
 */
export function assertAccess(pluginId: string, target: string, need: PluginGrantMode): void {
  const resolved = path.resolve(target)
  const res = checkGrantAccess(resolved, grantRecords(pluginId), need, CASE_INSENSITIVE_PATHS)
  if (res.ok) return
  throw new IPCError('PERMISSION_DENIED', res.reason || `未授权访问：${resolved}`)
}

/** 撤销一条授权（同时作用于内存与磁盘） */
export function revokeGrant(pluginId: string, target: string): boolean {
  const id = String(pluginId || '').trim()
  if (!id || !String(target || '').trim()) return false
  const resolved = path.resolve(String(target))
  const data = loadStore()
  const list = data.byPlugin[id]
  if (!list) return false
  const next = list.filter((r) => !samePath(r.path, resolved, CASE_INSENSITIVE_PATHS))
  if (next.length === list.length) return false
  if (next.length) data.byPlugin[id] = next
  else delete data.byPlugin[id]
  saveStore()
  return true
}

/** 清掉某个插件的全部授权（用户点「全部撤销」/ 卸载插件时调用） */
export function clearGrants(pluginId: string): boolean {
  const id = String(pluginId || '').trim()
  if (!id) return false
  const data = loadStore()
  if (!data.byPlugin[id]) return false
  delete data.byPlugin[id]
  saveStore()
  return true
}

/** 给设置页看的清单：路径 + 模式 + 现在还在不在 / 还是不是文件夹 */
export function listGrants(pluginId: string): PluginGrantEntry[] {
  return grantRecords(pluginId).map((rec) => {
    try {
      const stat = statSync(rec.path)
      return { path: rec.path, mode: rec.mode, isDir: stat.isDirectory(), exists: true }
    } catch {
      return { path: rec.path, mode: rec.mode, isDir: false, exists: false }
    }
  })
}
