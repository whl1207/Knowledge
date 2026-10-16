/**
 * plugin-agent-config.ts — 每个插件的**委派配置**（额度上限 + D5 放宽开关）
 *
 * 用户在「设置 → 插件 → 插件权限」里调的东西落在这里；判定逻辑仍在契约层
 * （`src/lib/plugin/agentContract.ts` 的 `normalizePluginAgentLimits` / `delegableToolSet`），
 * 本模块只负责"存哪、怎么读、坏了怎么办"。
 *
 * 与 `plugin-grants.ts` / `plugin-agent-consent.ts` 同一套路：内存缓存 + 原子落盘（tmp → rename）+ 坏数据当默认。
 * 文件：`userData/plugin-agent-config.json`。
 *
 * ## 为什么默认值必须等于"面板出现之前的行为"
 *
 * 面板是**加法**：没被用户调过的插件，其额度（1 / 20）与放宽状态（全关）必须与历史行为**逐字节一致**。
 * 所以这里不写"默认放行"，`agentConfigOf` 对未知插件返回 `DEFAULT_*`，且存档里只存**被改过的项**。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

import {
  DEFAULT_PLUGIN_AGENT_LIMITS,
  normalizePluginAgentLimits,
  type DelegationRelaxFlags,
  type PluginAgentLimits,
} from '@/lib/plugin/agentContract'

const CONFIG_FILE = 'plugin-agent-config.json'
const VERSION = 1

/** 存档里的原始形状（只在用户改过时才写项；读的时候一律过 normalize） */
interface StoredEntry {
  concurrency?: number
  callsPerHour?: number
  relaxFs?: boolean
  relaxMcp?: boolean
}

interface ConfigStore {
  version: number
  byPlugin: Record<string, StoredEntry>
}

export interface PluginAgentConfig {
  limits: PluginAgentLimits
  relax: DelegationRelaxFlags
}

/** 未配置插件的默认状态（= 面板出现之前的行为） */
export const DEFAULT_PLUGIN_AGENT_CONFIG: Readonly<PluginAgentConfig> = Object.freeze({
  limits: { ...DEFAULT_PLUGIN_AGENT_LIMITS },
  relax: Object.freeze({ fs: false, mcp: false }) as DelegationRelaxFlags,
})

let store: ConfigStore | null = null

function storeFile(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE)
}

function loadStore(): ConfigStore {
  if (store) return store
  const byPlugin: Record<string, StoredEntry> = {}
  try {
    const parsed = JSON.parse(readFileSync(storeFile(), 'utf8')) as Partial<ConfigStore>
    for (const [id, raw] of Object.entries(parsed?.byPlugin || {})) {
      if (!id || !raw || typeof raw !== 'object') continue
      const e: StoredEntry = {}
      if (Number.isFinite(Number((raw as StoredEntry).concurrency))) e.concurrency = Number((raw as StoredEntry).concurrency)
      if (Number.isFinite(Number((raw as StoredEntry).callsPerHour))) e.callsPerHour = Number((raw as StoredEntry).callsPerHour)
      if ((raw as StoredEntry).relaxFs === true) e.relaxFs = true
      if ((raw as StoredEntry).relaxMcp === true) e.relaxMcp = true
      if (Object.keys(e).length) byPlugin[id] = e
    }
  } catch {
    /* 没有这个文件 / 文件坏了 → 全部按默认（最保守：额度不变、放宽全关） */
  }
  store = { version: VERSION, byPlugin }
  return store
}

function saveStore(): void {
  const current = store
  if (!current) return
  // `storeFile()` 放 try 里面：拿不到 userData 时降级而不是抛（同 budget / consent 的处置）
  try {
    const file = storeFile()
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(current, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch (e) {
    console.warn('[plugin-agent-config] 保存委派配置失败（本次运行内仍然生效）:', e)
  }
}

/** 某插件的委派配置（未配置 → 默认值；坏数据自愈成默认） */
export function agentConfigOf(pluginId: string): PluginAgentConfig {
  const id = String(pluginId || '').trim()
  if (!id) return { limits: { ...DEFAULT_PLUGIN_AGENT_LIMITS }, relax: { fs: false, mcp: false } }
  const e = loadStore().byPlugin[id]
  return {
    limits: normalizePluginAgentLimits(e),
    relax: { fs: e?.relaxFs === true, mcp: e?.relaxMcp === true },
  }
}

/** 该插件是否被用户改过（面板用来区分"默认"与"已自定义"） */
export function isAgentConfigCustomized(pluginId: string): boolean {
  const id = String(pluginId || '').trim()
  return !!id && !!loadStore().byPlugin[id]
}

/** 写额度（过 normalize 后再存，于是"存进去的就是生效的"） */
export function setAgentLimits(pluginId: string, raw: unknown): PluginAgentConfig {
  const id = String(pluginId || '').trim()
  if (!id) return agentConfigOf('')
  const limits = normalizePluginAgentLimits(raw)
  const data = loadStore()
  const entry = data.byPlugin[id] ?? {}
  entry.concurrency = limits.concurrency
  entry.callsPerHour = limits.callsPerHour
  data.byPlugin[id] = entry
  saveStore()
  return agentConfigOf(id)
}

/** 写 D5 放宽开关（**唯一**能让被委派 agent 拿到文件 / MCP 工具的入口） */
export function setAgentRelax(pluginId: string, raw: unknown): PluginAgentConfig {
  const id = String(pluginId || '').trim()
  if (!id) return agentConfigOf('')
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const data = loadStore()
  const entry = data.byPlugin[id] ?? {}
  if (src.fs === true) entry.relaxFs = true
  else delete entry.relaxFs
  if (src.mcp === true) entry.relaxMcp = true
  else delete entry.relaxMcp
  if (Object.keys(entry).length) data.byPlugin[id] = entry
  else delete data.byPlugin[id]
  saveStore()
  return agentConfigOf(id)
}

/** 清掉某插件的委派配置（卸载 / 「清空全部数据」时调用；返回是否本来就有） */
export function clearAgentConfig(pluginId: string): boolean {
  const id = String(pluginId || '').trim()
  if (!id) return false
  const data = loadStore()
  if (!data.byPlugin[id]) return false
  delete data.byPlugin[id]
  saveStore()
  return true
}

/** 给「插件权限」页签看的总览 */
export function listAgentConfig(): Record<string, PluginAgentConfig> {
  const out: Record<string, PluginAgentConfig> = {}
  for (const id of Object.keys(loadStore().byPlugin)) out[id] = agentConfigOf(id)
  return out
}
