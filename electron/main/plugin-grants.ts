/**
 * plugin-grants.ts — 插件文件授权（「已记住的路径」）的持久化
 *
 * 背景：插件的 `fs` 权限只表示「它想读文件」，具体哪个路径能读由主进程的
 * capability allowlist 决定——只有「用户在该插件里亲自选过」的文件 / 文件夹才放行。
 * 这份清单原先只活在一次运行里，于是「上次选的游戏目录 / 法规库目录」每次开机都要再选一遍
 * （插件一打开就撞「未授权访问」）。这里把它落盘，让用户在插件里选过的路径跨重启仍然有效：
 *
 * - **写入只有一个入口**：用户自己点出来的选择框（`plugin:files:pick` / `pick-dir`），
 *   插件没有任何办法给自己加路径；
 * - **撤销入口**：设置 → 插件 → 数据（逐条撤销 / 全部撤销），卸载插件时也会一起清掉；
 * - 文件落在 `userData/plugin-fs-grants.json`，先写临时文件再改名，写坏也只会退回空清单。
 *
 * ⚠️ 这不是沙箱：记住的只是「用户点过的那几个路径」，越界（含兄弟目录、写死的绝对路径）照样拒绝。
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

const GRANTS_FILE = 'plugin-fs-grants.json'
/** 单个插件最多记住多少条（插件反复弹选择框也不会把清单撑爆） */
const MAX_PER_PLUGIN = 32
const VERSION = 1

export interface PluginGrantEntry {
  path: string
  /** 现在还是个文件夹吗（可能已被删除 / 改名） */
  isDir: boolean
  exists: boolean
}

interface GrantsStore {
  version: number
  /** 插件 id → 用户选过的绝对路径（新的在前） */
  byPlugin: Record<string, string[]>
}

/** 内存缓存：`assertAllowed` 是同步调用，不能每次都读盘 */
let store: GrantsStore | null = null

function storeFile(): string {
  return path.join(app.getPath('userData'), GRANTS_FILE)
}

function loadStore(): GrantsStore {
  if (store) return store
  const byPlugin: Record<string, string[]> = {}
  try {
    const parsed = JSON.parse(readFileSync(storeFile(), 'utf8')) as Partial<GrantsStore>
    for (const [id, list] of Object.entries(parsed?.byPlugin || {})) {
      if (!id || !Array.isArray(list)) continue
      const paths = list.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map((p) => path.resolve(p))
      if (paths.length) byPlugin[id] = Array.from(new Set(paths)).slice(0, MAX_PER_PLUGIN)
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

/** 记住用户选过的路径（唯一写入入口；已记过的直接返回） */
export function addGrant(pluginId: string, target: string): void {
  const id = String(pluginId || '').trim()
  if (!id || !String(target || '').trim()) return
  const resolved = path.resolve(String(target))
  const data = loadStore()
  const list = data.byPlugin[id] || []
  if (list.includes(resolved)) return
  data.byPlugin[id] = [resolved, ...list].slice(0, MAX_PER_PLUGIN)
  saveStore()
}

/** 该插件被授权访问的路径（同步；来自内存缓存） */
export function grantPaths(pluginId: string): string[] {
  const id = String(pluginId || '').trim()
  if (!id) return []
  return loadStore().byPlugin[id] || []
}

/** 撤销一条授权（同时作用于内存与磁盘） */
export function revokeGrant(pluginId: string, target: string): boolean {
  const id = String(pluginId || '').trim()
  if (!id || !String(target || '').trim()) return false
  const resolved = path.resolve(String(target))
  const data = loadStore()
  const list = data.byPlugin[id]
  if (!list || !list.includes(resolved)) return false
  const next = list.filter((p) => p !== resolved)
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

/** 给设置页看的清单：路径 + 现在还在不在 / 还是不是文件夹 */
export function listGrants(pluginId: string): PluginGrantEntry[] {
  return grantPaths(pluginId).map((p) => {
    try {
      const stat = statSync(p)
      return { path: p, isDir: stat.isDirectory(), exists: true }
    } catch {
      return { path: p, isDir: false, exists: false }
    }
  })
}
