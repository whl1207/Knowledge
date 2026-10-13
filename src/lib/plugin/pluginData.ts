/**
 * pluginData.ts — 插件数据的定位 / 统计 / 清理（「设置 → 插件 → 管理」里按插件查看与清理）。
 *
 * 约定（插件开发指南里也写了）——插件自己的数据只能放这三处，宿主才能按插件统计与清理：
 *   1) localStorage：键名以 `aikm.plugin.<id>.` 开头；
 *   2) OPFS（源私有文件系统）：`plugins/<id>/` 目录下的文件；
 *   3) 主进程私有数据：`userData/plugins-data/<id>/`（如 `ctx.storage` 的 storage.json），
 *      渲染层读不到，经 `plugin:data-files` 由主进程列出 / 删除。
 *
 * 注意：前两处存储跟**当前页面来源**绑定（打包版是 file://，dev 是 localhost），互不相通；
 * 清理只删上面三处，不动插件本体的磁盘文件（那是「移除插件」的事）。
 */

import { getPluginBridge, type PluginBridgeApi } from '@/lib/plugin/bridge'

export const PLUGIN_LS_PREFIX = 'aikm.plugin.'
/** OPFS 里插件数据目录的父目录：plugins/<id>/<...> */
export const PLUGIN_DATA_DIR = 'plugins'

export type PluginDataKind = 'localStorage' | 'file' | 'host'

export interface PluginDataEntry {
  kind: PluginDataKind
  /** localStorage 键名；OPFS 相对 `plugins/<id>/` 的路径；主进程侧相对 `plugins-data/<id>/` 的路径 */
  name: string
  size: number
}

export interface PluginDataSummary {
  id: string
  entries: PluginDataEntry[]
  lsBytes: number
  fileBytes: number
  /** 主进程私有数据（`userData/plugins-data/<id>/`）占用 */
  hostBytes: number
  totalBytes: number
  /** 环境是否支持 OPFS（区分「不支持」与「没有文件数据」） */
  filesSupported: boolean
  /** 是否连上了主进程数据桥（桌面版才有；网页版看不到主进程侧数据） */
  hostSupported: boolean
  /** 统计过程中遇到的错误（只用于提示，不阻塞界面） */
  error?: string
}

export const pluginLsPrefix = (id: string): string => `${PLUGIN_LS_PREFIX}${id}.`

/** 该插件在 localStorage 里的键（前缀匹配） */
export function pluginLsKeys(id: string): string[] {
  const prefix = pluginLsPrefix(id)
  const out: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith(prefix)) out.push(key)
    }
  } catch {
    /* 存储被禁用时忽略 */
  }
  return out
}

// ---------------------------------------------------------------------------
// 主进程私有数据（userData/plugins-data/<id>/）：渲染层读不到，靠 bridge 转发
// ---------------------------------------------------------------------------
/** 主进程数据桥（只有桌面版有；网页版返回 null，界面上会提示） */
function dataBridge(): Pick<PluginBridgeApi, 'dataFiles' | 'dataFilesAll' | 'removeDataFile' | 'clearDataFiles'> | null {
  const api = getPluginBridge()
  return api && typeof api.dataFiles === 'function' && typeof api.dataFilesAll === 'function' ? api : null
}

/** 是否连上了主进程数据桥（桌面版才看得到 `plugins-data/<id>/`） */
export function pluginHostDataSupported(): boolean {
  return !!dataBridge()
}

const toHostEntries = (list: Array<{ name: string; size: number }> | undefined): PluginDataEntry[] =>
  (Array.isArray(list) ? list : []).map((e) => ({ kind: 'host' as const, name: e.name, size: e.size }))

/** 某个插件在主进程侧的数据文件（读不到就返回空数组） */
export async function collectPluginHostData(id: string): Promise<PluginDataEntry[]> {
  const api = dataBridge()
  if (!api) return []
  try {
    const res = await api.dataFiles(id)
    return toHostEntries(res?.entries)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// OPFS：只用到目录遍历 / 删除 / 取文件大小这几个能力，所以自己声明最小接口，避免依赖 lib.dom 版本
// ---------------------------------------------------------------------------
type OpfsFileHandle = { kind: 'file'; name: string; getFile(): Promise<{ size: number }> }
type OpfsDirHandle = {
  kind: 'directory'
  name: string
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<OpfsDirHandle>
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<OpfsFileHandle>
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>
  values(): AsyncIterable<OpfsFileHandle | OpfsDirHandle>
}

function storageManager(): (StorageManager & { getDirectory?: () => Promise<OpfsDirHandle> }) | null {
  if (typeof navigator === 'undefined') return null
  return (navigator.storage as any) || null
}

export function pluginDataFilesSupported(): boolean {
  const sm = storageManager()
  return !!sm && typeof sm.getDirectory === 'function'
}

async function opfsRoot(): Promise<OpfsDirHandle | null> {
  const sm = storageManager()
  if (!sm || typeof sm.getDirectory !== 'function') return null
  try {
    // lib.dom 各版本对 FileSystemDirectoryHandle 的迭代方法声明不一致，这里按最小接口收窄
    return (await sm.getDirectory()) as unknown as OpfsDirHandle
  } catch {
    return null
  }
}

/** 打开（可选创建）插件数据目录 `plugins/<id>/` */
export async function openPluginDataDir(id: string, create = false): Promise<OpfsDirHandle | null> {
  const root = await opfsRoot()
  if (!root) return null
  try {
    const parent = await root.getDirectoryHandle(PLUGIN_DATA_DIR, { create })
    return await parent.getDirectoryHandle(id, { create })
  } catch {
    // create=false 时目录不存在会抛 NotFoundError —— 属于正常情况
    return null
  }
}

async function walkDir(dir: OpfsDirHandle, prefix: string, out: PluginDataEntry[]): Promise<void> {
  try {
    for await (const handle of dir.values()) {
      const path = prefix ? `${prefix}/${handle.name}` : handle.name
      if (handle.kind === 'directory') {
        await walkDir(handle as OpfsDirHandle, path, out)
      } else {
        let size = 0
        try {
          size = (await (handle as OpfsFileHandle).getFile()).size
        } catch {
          size = 0
        }
        out.push({ kind: 'file', name: path, size })
      }
    }
  } catch {
    /* 目录刚好被删 / 读不到就当作空 */
  }
}

/** 统计某个插件的 OPFS 数据（`plugins/<id>/` 递归） */
export async function collectPluginFileData(id: string): Promise<PluginDataEntry[]> {
  const dir = await openPluginDataDir(id, false)
  if (!dir) return []
  const out: PluginDataEntry[] = []
  await walkDir(dir, '', out)
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/** 统计一个插件的全部数据（localStorage + OPFS） */
export async function collectPluginData(id: string): Promise<PluginDataSummary> {
  const lsEntries: PluginDataEntry[] = pluginLsKeys(id).map((key) => {
    let value = ''
    try {
      value = localStorage.getItem(key) || ''
    } catch {
      value = ''
    }
    return { kind: 'localStorage' as const, name: key, size: (key.length + value.length) * 2 }
  })
  let fileEntries: PluginDataEntry[] = []
  const hostEntries = await collectPluginHostData(id)
  let error: string | undefined
  try {
    fileEntries = await collectPluginFileData(id)
  } catch (e: any) {
    error = e?.message ? String(e.message) : String(e)
  }
  const entries = [...lsEntries, ...fileEntries, ...hostEntries]
  return {
    id,
    entries,
    lsBytes: lsEntries.reduce((n, e) => n + e.size, 0),
    fileBytes: fileEntries.reduce((n, e) => n + e.size, 0),
    hostBytes: hostEntries.reduce((n, e) => n + e.size, 0),
    totalBytes: entries.reduce((n, e) => n + e.size, 0),
    filesSupported: pluginDataFilesSupported(),
    hostSupported: pluginHostDataSupported(),
    error,
  }
}

/** 列表里的展示顺序：本地文件 → 主进程文件 → 设置键 */
const KIND_ORDER: PluginDataKind[] = ['file', 'host', 'localStorage']

/** 批量统计（列表页用）：localStorage 只扫一遍，OPFS 与主进程侧各走一次数据根目录 */
export async function collectAllPluginData(ids: string[]): Promise<Record<string, PluginDataSummary>> {
  const out: Record<string, PluginDataSummary> = {}
  for (const id of ids) {
    out[id] = {
      id,
      entries: [],
      lsBytes: 0,
      fileBytes: 0,
      hostBytes: 0,
      totalBytes: 0,
      filesSupported: pluginDataFilesSupported(),
      hostSupported: pluginHostDataSupported(),
    }
  }
  // 1) localStorage：按 id 前缀归位（长 id 优先，避免一个 id 是另一个的前缀时误判）
  const sorted = [...ids].sort((a, b) => b.length - a.length)
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key) continue
      const hit = sorted.find((id) => key.startsWith(pluginLsPrefix(id)))
      if (!hit) continue
      let value = ''
      try {
        value = localStorage.getItem(key) || ''
      } catch {
        value = ''
      }
      const entry: PluginDataEntry = { kind: 'localStorage', name: key, size: (key.length + value.length) * 2 }
      out[hit].entries.push(entry)
      out[hit].lsBytes += entry.size
    }
  } catch {
    /* 忽略 */
  }
  // 2) OPFS：plugins/<id>/ 逐个算大小
  const root = await opfsRoot()
  if (root) {
    try {
      const parent = await root.getDirectoryHandle(PLUGIN_DATA_DIR, { create: false })
      for await (const handle of parent.values()) {
        const id = handle.name
        const target = out[id]
        if (handle.kind === 'directory') {
          const entries: PluginDataEntry[] = []
          await walkDir(handle as OpfsDirHandle, '', entries)
          entries.sort((a, b) => a.name.localeCompare(b.name))
          if (target) {
            target.entries.push(...entries)
            target.fileBytes = entries.reduce((n, e) => n + e.size, 0)
          }
        }
      }
    } catch {
      /* plugins/ 目录还不存在：正常 */
    }
  }
  // 2b) 主进程私有数据：一次拿到全部（只走一遍 dataRoot）
  const api = dataBridge()
  if (api) {
    try {
      const res = await api.dataFilesAll()
      for (const [id, list] of Object.entries(res?.byId || {})) {
        const target = out[id]
        if (!target) continue
        const entries = toHostEntries(list)
        target.entries.push(...entries)
        target.hostBytes = entries.reduce((n, e) => n + e.size, 0)
      }
    } catch {
      /* 主进程侧读不到：当作没有 */
    }
  }
  for (const id of Object.keys(out)) {
    out[id].entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)))
    out[id].totalBytes = out[id].lsBytes + out[id].fileBytes + out[id].hostBytes
  }
  return out
}

/** 删掉一条数据（localStorage 键 / OPFS 文件 / 主进程侧文件） */
export async function removePluginDataEntry(id: string, entry: PluginDataEntry): Promise<boolean> {
  if (entry.kind === 'localStorage') {
    try {
      localStorage.removeItem(entry.name)
      return true
    } catch {
      return false
    }
  }
  if (entry.kind === 'host') {
    const api = dataBridge()
    if (!api) return false
    try {
      const res = await api.removeDataFile(id, entry.name, true)
      return res?.removed !== false
    } catch {
      return false
    }
  }
  const dir = await openPluginDataDir(id, false)
  if (!dir) return false
  const parts = entry.name.split('/')
  try {
    let cur = dir
    for (let i = 0; i < parts.length - 1; i++) cur = await cur.getDirectoryHandle(parts[i], { create: false })
    await cur.removeEntry(parts[parts.length - 1], { recursive: true })
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 文件授权（用户在该插件里选过的路径）：落盘在主进程，见 electron/main/plugin-grants.ts
// ---------------------------------------------------------------------------
export interface PluginGrantEntry {
  path: string
  isDir: boolean
  exists: boolean
}

/** 文件授权桥（与 dataBridge 同一套降级规则：网页版返回 null） */
function grantsBridge(): Pick<PluginBridgeApi, 'files'>['files'] | null {
  const api = getPluginBridge()
  const files = api && api.files
  return files && typeof files.grants === 'function' ? files : null
}

/** 环境是否支持查看插件的文件授权（桌面版才有） */
export function pluginFileGrantsSupported(): boolean {
  return grantsBridge() !== null
}

/** 该插件记住的、可以被读取的文件 / 文件夹（跨重启有效） */
export async function collectPluginGrants(id: string): Promise<PluginGrantEntry[]> {
  const files = grantsBridge()
  if (!files) return []
  try {
    const res = await files.grants({ id })
    return Array.isArray(res?.entries) ? res.entries : []
  } catch {
    return []
  }
}

/** 撤销一条文件授权（下次该插件再读这个路径就要重新让用户选） */
export async function revokePluginGrant(id: string, target: string): Promise<boolean> {
  const files = grantsBridge()
  if (!files) return false
  try {
    const res = await files.revokeGrant({ id, path: target, confirm: true })
    return res?.removed !== false
  } catch {
    return false
  }
}

/** 清掉某个插件的全部文件授权 */
export async function clearPluginGrants(id: string): Promise<boolean> {
  const files = grantsBridge()
  if (!files) return false
  try {
    const res = await files.clearGrants({ id, confirm: true })
    return res?.removed !== false
  } catch {
    return false
  }
}

/** 清空一个插件的全部数据（localStorage + `plugins/<id>/` + 主进程 `plugins-data/<id>/`） */
export async function clearPluginData(id: string): Promise<{ keys: number; files: number }> {
  const keys = pluginLsKeys(id)
  for (const key of keys) {
    try {
      localStorage.removeItem(key)
    } catch {
      /* 忽略 */
    }
  }
  let files = 0
  try {
    files = (await collectPluginFileData(id)).length
  } catch {
    files = 0
  }
  const root = await opfsRoot()
  if (root) {
    try {
      const parent = await root.getDirectoryHandle(PLUGIN_DATA_DIR, { create: false })
      await parent.removeEntry(id, { recursive: true })
    } catch {
      /* 本来就没有目录：正常 */
    }
  }
  // 主进程私有数据（userData/plugins-data/<id>/）：渲染层删不了，交给主进程
  const api = dataBridge()
  if (api) {
    try {
      files += (await collectPluginHostData(id)).length
      await api.clearDataFiles(id, true)
    } catch {
      /* 删不掉就保持原样，界面上会看到它还在 */
    }
  }
  // 「清空全部数据」也把记住的文件授权一起收回（否则插件重启后还能读那些路径）
  try {
    await clearPluginGrants(id)
  } catch {
    /* 撤销失败就保持原样 */
  }
  return { keys: keys.length, files }
}
