/**
 * plugin-tool-approval-store.ts — 「插件工具审批」的三态**存储**（按插件）
 *
 * 与 `plugin-agent-consent.ts` / `plugin-agent-config.ts` 同一套路：内存缓存 + 原子落盘
 * （先写 tmp 再改名）+ 坏文件当默认值。文件：`userData/plugin-tool-approval.json`。
 *
 * **刻意不 import `plugin-host`**：存储层要被 `plugin-host.ts` 的卸载清理直接调用，
 * 反过来又依赖 plugin-host 就会形成循环导入（启动路径上的隐患）。
 * 归因（"这个工具属于哪个插件"）与弹框在执行层 `plugin-tool-approval.ts` 里做。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

const APPROVAL_FILE = 'plugin-tool-approval.json'
const VERSION = 1

/**
 * 三态：
 * - `ask`（默认）：第一次遇到弹主进程对话框（允许 / 每次都问 / 拒绝）
 * - `allow`：以后不再问
 * - `deny`：直接拒绝
 */
export type PluginToolApproval = 'allow' | 'ask' | 'deny'

interface ApprovalStore {
  version: number
  byPlugin: Record<string, PluginToolApproval>
}

let store: ApprovalStore | null = null

const VALID: readonly PluginToolApproval[] = ['allow', 'ask', 'deny']

function storeFile(): string {
  return path.join(app.getPath('userData'), APPROVAL_FILE)
}

function loadStore(): ApprovalStore {
  if (store) return store
  const byPlugin: Record<string, PluginToolApproval> = {}
  try {
    const parsed = JSON.parse(readFileSync(storeFile(), 'utf8')) as Partial<ApprovalStore>
    for (const [id, v] of Object.entries(parsed?.byPlugin || {})) {
      if (id && VALID.includes(v as PluginToolApproval)) byPlugin[id] = v as PluginToolApproval
    }
  } catch {
    /* 没有文件 / 文件坏了 → 全部按默认 ask（最保守的可用状态） */
  }
  store = { version: VERSION, byPlugin }
  return store
}

function saveStore(): void {
  const current = store
  if (!current) return
  try {
    const file = storeFile()
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(current, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch (e) {
    console.warn('[plugin-tool-approval] 保存工具审批状态失败（本次运行内仍然生效）:', e)
  }
}

/** 该插件的工具审批状态（默认 `ask`；没有 id 时按最保守的 `deny`） */
export function toolApprovalOf(pluginId: string): PluginToolApproval {
  const id = String(pluginId || '').trim()
  if (!id) return 'deny'
  return loadStore().byPlugin[id] ?? 'ask'
}

/** 写入三态（设置页与弹框是两个入口） */
export function setToolApproval(pluginId: string, state: PluginToolApproval): boolean {
  const id = String(pluginId || '').trim()
  if (!id || !VALID.includes(state)) return false
  const data = loadStore()
  if (state === 'ask') delete data.byPlugin[id]
  else data.byPlugin[id] = state
  saveStore()
  return true
}

/** 清掉某插件的状态（卸载 / 「清空全部数据」时调用） */
export function clearToolApproval(pluginId: string): boolean {
  const id = String(pluginId || '').trim()
  if (!id) return false
  const data = loadStore()
  if (!data.byPlugin[id]) return false
  delete data.byPlugin[id]
  saveStore()
  return true
}

/** 给设置页看的总览（只有被改过的插件才在里面；默认 `ask` 不入表） */
export function listToolApproval(): Array<{ pluginId: string; state: PluginToolApproval }> {
  return Object.entries(loadStore().byPlugin).map(([pluginId, state]) => ({ pluginId, state }))
}
