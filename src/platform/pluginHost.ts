/**
 * platform/pluginHost — 渲染层插件宿主（非 Electron 平台的 PluginBridgeApi 实现）
 *
 * 背景：桌面版插件宿主在**主进程**（electron/main/plugin-host.ts）：扫描插件目录、解析清单、
 * 分发工具、管配置 / 日志 / 授权。安卓与网页端没有主进程，于是这一层把「宿主」搬到渲染层，
 * 直接用平台能力层（src/platform）读写手机上的插件目录——这样 **同一个插件（界面半边）**
 * 在安卓上也能装载：面板、设置页、槽位、ctx.tts、ctx.files 都在渲染层，本来就不依赖主进程。
 *
 * 落地范围（务实的第一版）：
 * - 插件目录：默认 `<应用文件根>/plugins`（安卓上即 /sdcard/Documents/plugins，用文件管理器就能放插件），
 *   也可指向任意可读目录（含 SAF 授权目录，如 `saf:知识库/plugins`）；
 * - 清单：复用 `shared/pluginManifest.parseManifest`，与桌面同一套校验（不出现「桌面能装、手机说非法」）；
 * - 用户选择：启用 / 禁用、配置 JSON、日志缓冲、文件授权记录都存 localStorage（每个插件 id 一份）；
 * - client 半边：读入口源码交给 `lib/plugin/runtime.ts`（Blob URL 动态 import）——与桌面同一条路径；
 * - 主进程半边（插件工具 / ctx.storage）：本平台没有进程可跑，工具列表因此为空；
 *   界面半边里的 `ctx.files` 走平台实现（见 lib/plugin/files.ts）。
 */

import type { PluginBridgeApi, PluginClientBundle } from '@/lib/plugin/bridge'
import type { PluginLogLine, PluginSnapshot } from '@/types/plugin'
import { PLUGIN_HOST_API_VERSION, type AikmPluginManifest } from '@/types/plugin'
import { PLUGIN_MANIFEST_FILE, checkApiVersion, parseManifest } from '@/shared/pluginManifest'
import { isValidPluginId } from '@/types/ids'
import { capabilityMode, getPlatform } from '@/platform'

/** localStorage 键（与应用既有约定一致：插件相关数据带 aikm.plugin. 前缀） */
const LS_ROOT = 'aikm.plugins.root'
const LS_ENABLED = 'aikm.plugins.enabled'
const LS_CONFIG = 'aikm.plugins.config.'
const LS_GRANTS = 'aikm.plugins.grants.'

/** 默认插件目录（相对平台文件根；安卓实际默认走私有目录，见 pluginRootDir()） */
export const DEFAULT_PLUGIN_DIR = 'plugins'

const LOG_LIMIT = 200
const READ_ERROR_PREFIX = 'Error reading file'

interface GrantRecord {
  path: string
  isDir: boolean
}

/** 宿主的易失状态（装载时间 / 日志缓冲）；重启后由扫描重建 */
const loadedAt = new Map<string, number>()
const logBuffers = new Map<string, PluginLogLine[]>()

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 配额 / 隐私模式：忽略 */
  }
}

function lsRemove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    /* 忽略 */
  }
}

function readJson<T>(key: string, fallback: T): T {
  const raw = lsGet(key)
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** 用户自定义的插件目录（空 = 用默认值） */
function customRootDir(): string {
  return (lsGet(LS_ROOT) || '').trim()
}

/**
 * 插件根目录：
 * - 用户自定义优先（可写成 SAF 授权目录，如 `saf:知识库/plugins`）；
 * - 安卓默认放**应用私有目录** `data:plugins`：Android 11+ 分区存储下，公共 Documents 里
 *   由别的应用 / adb 写入的文件本应用读不到（EACCES），私有目录才稳定可读写；
 * - 其它平台默认 `plugins`（相对平台文件根，桌面 = 当前目录下的 plugins）。
 */
export function pluginRootDir(): string {
  const custom = customRootDir()
  if (custom) return custom
  try {
    return getPlatform().kind === 'android' ? 'data:plugins' : DEFAULT_PLUGIN_DIR
  } catch {
    return DEFAULT_PLUGIN_DIR
  }
}

function enabledMap(): Record<string, boolean> {
  return readJson<Record<string, boolean>>(LS_ENABLED, {})
}

/** 默认启用：放进目录就该能用（手机上没有桌面那种「先扫描再手动启用」的审批面板） */
function isEnabled(id: string): boolean {
  return enabledMap()[id] !== false
}

function configOf(id: string): Record<string, unknown> {
  return readJson<Record<string, unknown>>(LS_CONFIG + id, {})
}

function grantsOf(id: string): GrantRecord[] {
  return readJson<GrantRecord[]>(LS_GRANTS + id, [])
}

function pushLog(id: string, level: PluginLogLine['level'], message: string): void {
  const list = logBuffers.get(id) || []
  list.push({ ts: Date.now(), level, message })
  if (list.length > LOG_LIMIT) list.splice(0, list.length - LOG_LIMIT)
  logBuffers.set(id, list)
}

function joinPath(dir: string, rel: string): string {
  const d = String(dir || '').replace(/[\\/]+$/, '')
  const r = String(rel || '').replace(/^[\\/]+/, '')
  return d ? `${d}/${r}` : r
}

function baseName(p: string): string {
  const norm = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '')
  return norm.split('/').filter(Boolean).pop() || norm
}

/**
 * 插件目录名（= 插件 id）。
 *
 * 安卓上 SAF 路径形如 `saf:<文件夹名>`：用户选中的那个文件夹本身就是一个授权根，
 * 直接按 `/` 取末段拿到的是 `saf:retro-emulator`，会被判成非法 id
 * （「目录名 "saf:retro-emulator" 不能作为插件 id」）。所以先剥掉平台前缀再取末段
 * ——与 android/index.ts 的 displayNameOf 同一口径（那边只处理展示，这边是校验与安装）。
 */
function dirNameOf(p: string): string {
  const norm = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '')
  const raw = norm.startsWith('saf:') ? norm.slice('saf:'.length) : norm
  return baseName(raw)
}

/** 读文本文件；读不到（含「不存在」）返回 null */
async function readTextOrNull(path: string): Promise<string | null> {
  try {
    const text = await getPlatform().fs.readText(path)
    if (typeof text !== 'string' || text.startsWith(READ_ERROR_PREFIX)) return null
    return text
  } catch {
    return null
  }
}

/**
 * 有上限的并发 map（保持结果顺序）。
 *
 * 为什么需要：安卓上每一次目录列举 / 读文件都是一次「JS ↔ 原生」往返（SAF 目录还要问内容提供者），
 * 串行做十几次就是几百毫秒。并发跑能把这些等待重叠起来；
 * 上限是为了稳定：不把内容提供者 / 桥一次性打爆（SAF 原生侧本来就是单线程队列）。
 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const width = Math.max(1, Math.min(limit, items.length))
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        out[i] = await fn(items[i], i)
      }
    }),
  )
  return out
}

/** 读一个插件目录的清单并转成 snapshot（清单非法时返回原因） */
async function snapshotOf(dir: string, relDir: string, id: string): Promise<{ snapshot: PluginSnapshot | null; invalid?: string }> {
  const text = await readTextOrNull(joinPath(dir, PLUGIN_MANIFEST_FILE))
  if (text === null) return { snapshot: null, invalid: `缺少 ${PLUGIN_MANIFEST_FILE}` }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e: any) {
    return { snapshot: null, invalid: `${PLUGIN_MANIFEST_FILE} 解析失败：${e?.message || e}` }
  }

  const parsed = parseManifest(raw, id)
  if (!parsed.ok) return { snapshot: null, invalid: parsed.message }
  const manifest: AikmPluginManifest = parsed.manifest
  const apiCheck = checkApiVersion(manifest.apiVersion, PLUGIN_HOST_API_VERSION)
  const enabled = isEnabled(parsed.id)
  const hasClient = !!manifest.client?.entry
  const hasMain = !!manifest.main
  const error = !apiCheck.ok
    ? apiCheck.reason
    : !hasClient
      ? hasMain
        ? '该插件只有主进程半边（工具），当前平台没有主进程，无法加载'
        : '没有可加载的入口'
      : null

  const snapshot: PluginSnapshot = {
    id: parsed.id,
    name: manifest.name || parsed.id,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    description: manifest.description || '',
    dir,
    relDir,
    folder: relDir.includes('/') ? relDir.slice(0, relDir.lastIndexOf('/')) : '',
    status: error ? 'invalid' : !enabled ? 'disabled' : 'active',
    enabled,
    permissions: manifest.permissions || [],
    inject: manifest.inject || [],
    // 主进程半边的工具在手机上没有运行环境：列表为空（界面半边照常工作）
    tools: [],
    services: [],
    hasMain,
    hasClient,
    clientEntry: manifest.client?.entry || null,
    config: configOf(parsed.id),
    declaredSlots: manifest.declares?.slots || [],
    error,
    loadedAt: loadedAt.get(parsed.id) || null,
  }
  return { snapshot }
}

/** 扫描插件根目录（顶层插件目录 + 一层分类文件夹里的插件） */
export interface PluginListResult {
  plugins: PluginSnapshot[]
  rootDir: string
  customRoot: boolean
  services: string[]
  invalidNamedDirs: string[]
}

/**
 * 扫描结果缓存（短 TTL）。
 *
 * 为什么需要：一次「启用 / 禁用 / 重载插件」会连着问好几遍清单——管理页 findSnapshot、
 * 渲染层同步 bridge.list()、装载前的 clientBundle()。安卓上每一次扫描都要经 Capacitor 桥、
 * SAF 目录还要逐个目录问内容提供者，重复扫就是白等（实测「开关插件很慢」主要来自这里）。
 * 目录内容变化都会调用 invalidatePluginScan()，所以 TTL 只是兜底。
 */
const SCAN_TTL_MS = 1500
let scanCache: { root: string; at: number; data: PluginListResult } | null = null

/** 让下一次 listPlugins() 重新扫（目录 / 启停 / 配置变化时调用） */
export function invalidatePluginScan(): void {
  scanCache = null
}

export async function listPlugins(): Promise<PluginListResult> {
  const rootDir = pluginRootDir()
  const customRoot = !!customRootDir()
  if (scanCache && scanCache.root === rootDir && Date.now() - scanCache.at < SCAN_TTL_MS) return scanCache.data
  const data = await scanPlugins(rootDir, customRoot)
  scanCache = { root: rootDir, at: Date.now(), data }
  return data
}

async function scanPlugins(rootDir: string, customRoot: boolean): Promise<PluginListResult> {
  const plugins: PluginSnapshot[] = []
  const invalidNamedDirs: string[] = []
  if (!capabilityMode('fs.pathRead').startsWith('local')) {
    return { plugins, rootDir, customRoot, services: [], invalidNamedDirs }
  }
  const fs = getPlatform().fs
  // 插件目录可能还不存在（安卓首次运行 / 用户自定义目录）：先建出来，读失败再按空列表处理
  try {
    await fs.ensureDir(rootDir)
  } catch {
    /* 建不了也没关系：下面的 listTree 会失败并返回空列表 */
  }

  /** 目录名必须是合法插件 id（与桌面一致：中文 / 大写 / 空格目录跳过并回报） */
  const considerDir = async (dir: string, relDir: string) => {
    const name = dirNameOf(dir)
    if (!isValidPluginId(name)) {
      invalidNamedDirs.push(`${relDir}（目录名不能作为插件 id）`)
      return
    }
    const { snapshot, invalid } = await snapshotOf(dir, relDir, name)
    if (snapshot) plugins.push(snapshot)
    else if (invalid) invalidNamedDirs.push(`${relDir}（${invalid}）`)
  }

  /** 只列一层目录（读不到按空处理） */
  const listDir = async (dir: string): Promise<any[]> => {
    try {
      const nodes = await fs.listTree(dir, 1)
      return Array.isArray(nodes) ? nodes : []
    } catch {
      return []
    }
  }
  const hasManifest = (nodes: any[]) => nodes.some((c) => c?.type === 'file' && baseName(c.path) === PLUGIN_MANIFEST_FILE)

  // ⚠️ 这里以前是 listTree(rootDir, 2)：会把**插件目录内部**也整棵列一遍（retro-emulator 的 core/ src/
  // standalone/… 十来个子目录），每个目录一次桥调用、SAF 目录还要一次内容提供者查询——手机上
  // 「开关插件 / 刷新列表很慢」主要就慢在这一步。现在只列一层：有清单的当场认作插件（不再进它内部），
  // 只有「没有清单」的目录才当分类文件夹再列一层。
  // 并发（外层 4 / 内层 3）：安卓上每次目录列举都是一次桥往返，串行十几次就是几百毫秒；
  // 上限压住是为了稳定——SAF 原生侧是单线程队列，一次塞太多只会排队。
  const top = await listDir(rootDir)
  const topDirs = top.filter((n) => n?.type === 'folder')
  await mapLimit(topDirs, 4, async (node) => {
    const children = await listDir(node.path)
    if (hasManifest(children)) {
      await considerDir(node.path, dirNameOf(node.path))
      return
    }
    const subs = children.filter((s) => s?.type === 'folder')
    await mapLimit(subs, 3, (sub) => considerDir(sub.path, `${dirNameOf(node.path)}/${dirNameOf(sub.path)}`))
  })

  plugins.sort((a, b) => a.id.localeCompare(b.id))
  // 并发扫描时 invalidNamedDirs 的收集顺序不确定：排序 + 去重，界面提示才是稳定的
  if (invalidNamedDirs.length > 1) {
    const uniq = Array.from(new Set(invalidNamedDirs))
    uniq.sort((a, b) => a.localeCompare(b))
    invalidNamedDirs.splice(0, invalidNamedDirs.length, ...uniq)
  }
  // 安卓上 SAF 授权可能已经失效（换过授权文件夹 / 文件夹被移动或删除）：这时底层只会返回空，
  // 用户看到的是「插件全没了」却没有任何原因。明确说一句，别让人以为插件丢了。
  if (!plugins.length && customRoot && (await safRootMissing(rootDir))) {
    invalidNamedDirs.push(
      `${rootDir}（这个文件夹的授权已失效：安卓上换过授权文件夹，或文件夹被移动 / 删除——请点「选择插件目录」重新选一次）`,
    )
  }
  return { plugins, rootDir, customRoot, services: [], invalidNamedDirs }
}

/**
 * 自定义插件目录是 SAF 路径、但它的授权根名已经不在原生授权清单里（= 授权失效）。
 * 只在安卓上问一次原生侧；其它平台 / 问不到时按「没失效」处理（不打扰用户）。
 */
async function safRootMissing(rootDir: string): Promise<boolean> {
  if (!String(rootDir || '').startsWith('saf:')) return false
  try {
    if (getPlatform().kind !== 'android') return false
    const saf = await import('@/platform/android/saf')
    if (!saf.safCache.rootNames.length) await saf.createSafFilesystemAdapter().refreshRoot().catch(() => {})
    const name = String(rootDir).slice('saf:'.length).split('/')[0]
    return !!name && saf.safCache.rootNames.length > 0 && saf.safCache.rootNames.indexOf(name) < 0
  } catch {
    return false
  }
}

/** 读插件 client 半边入口源码（runtime 用 Blob URL 动态 import） */
export async function clientBundleOf(id: string): Promise<PluginClientBundle> {
  const info = await listPlugins()
  const snap = info.plugins.find((p) => p.id === id)
  if (!snap) throw new Error(`插件未找到：${id}`)
  if (!snap.clientEntry) throw new Error(`插件 ${id} 没有界面半边入口`)
  const code = await readTextOrNull(joinPath(snap.dir, snap.clientEntry))
  if (code === null) throw new Error(`读取入口失败：${snap.clientEntry}`)
  // 记录装载时间：runtime 据此判断「重新载入」是否要重新 import
  loadedAt.set(id, Date.now())
  return { entry: snap.clientEntry, code }
}

/** 把选中的目录内容复制进插件根目录（手机上的「从文件夹安装插件」） */
async function installFromDir(sourceDir: string, replace: boolean): Promise<PluginSnapshot> {
  const fs = getPlatform().fs
  // ⚠️ 安卓上 sourceDir 是 `saf:<文件夹名>`（用户选的文件夹 = 一个授权根）：
  // 必须用 dirNameOf 剥掉前缀，否则会得到 `saf:retro-emulator` 这种非法 id
  const name = dirNameOf(sourceDir)
  if (!isValidPluginId(name)) throw new Error(`目录名 "${name}" 不能作为插件 id（须小写字母 / 数字 / . _ -）`)
  const target = joinPath(pluginRootDir(), name)
  if (!replace && (await readTextOrNull(joinPath(target, PLUGIN_MANIFEST_FILE))) !== null) {
    throw new Error(`插件 ${name} 已存在（可勾选「覆盖」重装）`)
  }
  const nodes = await fs.listTree(sourceDir, 8)

  const copyNode = async (node: any) => {
    const rel = String(node.path || '').slice(String(sourceDir).length).replace(/^[\\/]+/, '')
    const dest = joinPath(target, rel)
    if (node.type === 'folder') {
      await fs.ensureDir(dest)
      for (const child of node.children || []) await copyNode(child)
      return
    }
    const text = await readTextOrNull(node.path)
    if (text !== null) {
      const r = await fs.writeText(dest, text)
      if (!r.success) throw new Error(`写入失败：${rel}`)
      return
    }
    const bytes = await fs.readBinary(node.path)
    if (!bytes) throw new Error(`读取失败：${rel}`)
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    const r = await fs.writeBinaryBase64(dest, btoa(bin))
    if (!r.success) throw new Error(`写入失败：${rel}`)
  }

  await fs.ensureDir(target)
  for (const node of nodes) await copyNode(node)
  const { snapshot, invalid } = await snapshotOf(target, name, name)
  if (!snapshot) throw new Error(invalid || '安装后无法解析清单')
  return snapshot
}

/** 构造渲染层插件宿主（PluginBridgeApi） */
export function createLocalPluginHost(): PluginBridgeApi {
  const findSnapshot = async (id: string): Promise<PluginSnapshot> => {
    const { plugins } = await listPlugins()
    const snap = plugins.find((p) => p.id === id)
    if (!snap) throw new Error(`插件未找到：${id}`)
    return snap
  }
  const setEnabled = async (id: string, enabled: boolean): Promise<PluginSnapshot> => {
    const map = enabledMap()
    map[id] = enabled
    lsSet(LS_ENABLED, JSON.stringify(map))
    // 启停会改变 snapshot.status，清单要重扫（缓存里那份已经过期）
    invalidatePluginScan()
    return await findSnapshot(id)
  }

  return {
    list: () => listPlugins(),

    async inspect(spec) {
      const empty = { id: null, name: null, version: null, apiVersion: null, permissions: [] as string[] }
      const dir = String(spec || '').trim()
      if (!dir) return { ok: false, ...empty, problem: '缺少插件目录' }
      const name = dirNameOf(dir) // 安卓 SAF：`saf:<文件夹名>` 才是目录名，别把前缀当 id
      const { snapshot, invalid } = await snapshotOf(dir, name, name)
      if (!snapshot) return { ok: false, ...empty, problem: invalid || '无法解析清单' }
      return {
        ok: true,
        id: snapshot.id,
        name: snapshot.name,
        version: snapshot.version,
        apiVersion: snapshot.apiVersion,
        permissions: snapshot.permissions,
        problem: null,
      }
    },

    enable: (id) => setEnabled(id, true),
    disable: (id) => setEnabled(id, false),

    async reload(id) {
      // 改完界面半边点「重新载入」：装载时间变化 → runtime 会卸载后重新 import 入口
      loadedAt.set(id, Date.now())
      invalidatePluginScan() // 入口文件可能刚被改过，清单里的 version / 权限也要重读
      return await findSnapshot(id)
    },

    async uninstall(id) {
      const map = enabledMap()
      delete map[id]
      lsSet(LS_ENABLED, JSON.stringify(map))
      lsRemove(LS_CONFIG + id)
      lsRemove(LS_GRANTS + id)
      invalidatePluginScan()
      // 手机上没有「移到回收站」的概念：目录留给用户自己删（不静默删用户文件）
      return { removed: true, deletedDir: false }
    },

    async getConfig(id) {
      return configOf(id)
    },

    async setConfig(id, patch) {
      const next = { ...configOf(id), ...(patch || {}) }
      lsSet(LS_CONFIG + id, JSON.stringify(next))
      invalidatePluginScan() // snapshot 里带着 config 快照
      return next
    },

    async logs(id) {
      return logBuffers.get(id) || []
    },

    clientLog(id, level, message) {
      pushLog(id, level, String(message))
    },

    async openDir(id) {
      const root = pluginRootDir()
      // 没有系统文件管理器可唤起（安卓私有目录 / 网页）→ 只回路径，界面退化为提示
      return { path: id ? joinPath(root, id) : root, opened: false }
    },

    /** 渲染层没有独立的插件数据目录（配置与日志都在 localStorage / OPFS），这里按空处理 */
    async dataFiles(id) {
      return { id, entries: [] }
    },
    async dataFilesAll() {
      return { byId: {} }
    },
    async removeDataFile() {
      return { removed: false }
    },
    async clearDataFiles() {
      return { removed: false }
    },

    files: {
      async grants(options) {
        // 本地宿主（安卓 / 网页端）没有主进程授权存储：这里记住的路径一律**只读**
        return { id: options.id, entries: grantsOf(options.id).map((g) => ({ ...g, mode: 'read' as const, exists: true })) }
      },
      async pickWritableDirectory(): Promise<{ cancelled: boolean; dir: { path: string; name: string } | null }> {
        // fail-loud：可写授权需要主进程的授权存储。不能返回 { cancelled: true } 假装是用户取消了 ——
        // 那会让插件作者以为"用户点了取消"，而不是"这个平台根本没有这条能力"。
        throw new Error('当前平台不支持可写文件夹授权（授权由桌面端主进程保存）')
      },
      async revokeGrant(options) {
        const next = grantsOf(options.id).filter((g) => g.path !== options.path)
        lsSet(LS_GRANTS + options.id, JSON.stringify(next))
        return { removed: true }
      },
      async clearGrants(options) {
        lsRemove(LS_GRANTS + options.id)
        return { removed: true }
      },
    },

    clientBundle: (id) => clientBundleOf(id),

    /** 重新扫描：强制丢掉缓存再列一遍（用户在管理页点「刷新」） */
    async rescan() {
      invalidatePluginScan()
      return await listPlugins()
    },

    async install(options) {
      const picked = await getPlatform().dialog.pickDirectory()
      if (!picked) return { cancelled: true, snapshot: null }
      const snapshot = await installFromDir(picked, options?.replace === true)
      invalidatePluginScan()
      return { cancelled: false, snapshot }
    },

    async setRoot(options) {
      if (options?.path) {
        lsSet(LS_ROOT, options.path)
        invalidatePluginScan()
        return { cancelled: false, rootDir: options.path }
      }
      const dir = await getPlatform().dialog.pickDirectory()
      if (!dir) return { cancelled: true, rootDir: pluginRootDir() }
      lsSet(LS_ROOT, dir)
      invalidatePluginScan()
      return { cancelled: false, rootDir: dir }
    },

    async resetRoot() {
      lsRemove(LS_ROOT)
      invalidatePluginScan()
      return { cancelled: false, rootDir: pluginRootDir() }
    },

    onEvent() {
      // 渲染层宿主没有跨进程事件：订阅返回空退订函数（列表刷新由调用方手动触发）
      return () => {}
    },
  }
}

/** 当前平台是否能用渲染层插件宿主（能读文件即可；浏览器 dev / 局域网访客页会退回 null） */
export function localPluginHostAvailable(): boolean {
  return capabilityMode('fs.pathRead') !== 'none'
}
