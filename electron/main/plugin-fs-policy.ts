/**
 * plugin-fs-policy.ts — 「先读后写」策略的**状态层**（主进程）
 *
 * 纯判定在 `src/shared/fsPolicy.ts`；这里只负责两件事：
 * 1. **每个插件是否开启**（落盘到 `userData/plugin-fs-policy.json`，默认全关 = 行为与改造前一致）；
 * 2. **本进程内观察过哪些文件**（内存，按插件隔离，**不跨会话持久**，插件卸载 / 禁用即丢）。
 *
 * 为什么不把观察状态落盘（对齐 DSH）：
 * - 落盘会让"上次那个代码读过"变成"新代码也读过"，正好绕过策略要防的那件事；
 * - 策略的语义是"这一次运行里你看过它"，跨会话应当重新读。
 *
 * 为什么默认关：现有插件里有"生成报告并覆盖自己产物"的正常用法，一上来强制先读会全量破。
 * 开启是**用户对某个插件的选择**（设置 → 插件 → 数据 的入口见 plugin-files 的策略通道）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

import {
  observationOf,
  recordObservation,
  type FsObservation,
  type FsObservationTable,
} from '@/shared/fsPolicy'

const POLICY_FILE = 'plugin-fs-policy.json'
const VERSION = 1

interface PolicyStore {
  version: number
  /** 开启了「先读后写」的插件 id */
  enabled: string[]
}

/** 内存缓存：判权是同步路径，不能每次读盘 */
let cached: PolicyStore | null = null
/** 每个插件的观察表（进程内；卸载即丢） */
const observations = new Map<string, FsObservationTable>()

function policyFile(): string {
  return path.join(app.getPath('userData'), POLICY_FILE)
}

function normalize(raw: unknown): PolicyStore {
  const src = raw && typeof raw === 'object' ? (raw as Partial<PolicyStore>) : {}
  const enabled = Array.isArray(src.enabled)
    ? Array.from(new Set(src.enabled.filter((id): id is string => typeof id === 'string' && id.trim() !== '')))
    : []
  return { version: VERSION, enabled }
}

function load(): PolicyStore {
  if (cached) return cached
  try {
    const text = readFileSync(policyFile(), 'utf8')
    cached = normalize(JSON.parse(text))
  } catch {
    // 读不到 / 坏了：按"全关"处理（fail-open 到**改造前行为**，不是 fail-open 到"不检查权限"）
    cached = { version: VERSION, enabled: [] }
  }
  return cached
}

function save(store: PolicyStore): void {
  cached = store
  try {
    const file = policyFile()
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid.toString(36)}`
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
  } catch {
    // 落盘失败不影响本次运行（内存里已经是新值）；下次启动回落默认
  }
}

/** 该插件是否开启了「先读后写」 */
export function isFsPolicyEnabled(pluginId: string): boolean {
  const id = String(pluginId || '').trim()
  if (!id) return false
  return load().enabled.includes(id)
}

/** 开启 / 关闭（写盘）；返回最新状态 */
export function setFsPolicyEnabled(pluginId: string, enabled: boolean): boolean {
  const id = String(pluginId || '').trim()
  if (!id) return false
  const store = load()
  const set = new Set(store.enabled)
  if (enabled) set.add(id)
  else set.delete(id)
  save({ version: VERSION, enabled: Array.from(set).sort() })
  if (!enabled) observations.delete(id)
  return enabled
}

/** 该插件的观察表（不存在时创建；调用方只在策略开启时才用） */
export function observationTableOf(pluginId: string): FsObservationTable {
  const id = String(pluginId || '').trim()
  let table = observations.get(id)
  if (!table) {
    table = {}
    observations.set(id, table)
  }
  return table
}

/** 记录一次观察（present 带版本 / absent = 确认缺失） */
export function noteObserved(pluginId: string, targetKey: string, obs: FsObservation): void {
  recordObservation(observationTableOf(pluginId), targetKey, obs)
}

/** 读一次观察 */
export function observedOf(pluginId: string, targetKey: string): FsObservation | undefined {
  return observationOf(observations.get(String(pluginId || '').trim()), targetKey)
}

/**
 * 插件卸载 / 禁用 / 卸载时清掉它的观察（**不**动 enabled：用户的开关选择要留着，
 * 否则"禁用再启用"会悄悄把策略关掉）。彻底卸载时连开关一起清（见 clearPluginFsPolicy）。
 */
export function clearFsObservations(pluginId: string): void {
  observations.delete(String(pluginId || '').trim())
}

/** 卸载插件：观察与开关一起清（重装同名插件不应继承上一个代码的选择） */
export function clearPluginFsPolicy(pluginId: string): void {
  const id = String(pluginId || '').trim()
  if (!id) return
  observations.delete(id)
  const store = load()
  if (!store.enabled.includes(id)) return
  save({ version: VERSION, enabled: store.enabled.filter((x) => x !== id) })
}

/** 设置页展示用（只读快照） */
export function fsPolicySnapshot(): { enabled: string[]; observed: Record<string, number> } {
  const store = load()
  const observed: Record<string, number> = {}
  for (const [id, table] of observations) observed[id] = Object.keys(table).length
  return { enabled: store.enabled.slice(), observed }
}
