/**
 * plugin-host.ts — 插件宿主（P0 内核）
 *
 * 职责：扫描 `userData/plugins/` → 校验清单 → 加载（依赖驱动）→ 启停 / 重载 / 卸载 → 目录热重载。
 *
 * 与 dsh 的对应关系（有意简化，见 docs/plan/插件与工作台-实施方案（逐文件）.md）：
 * - dsh 用 profile + 组合包 + cordis.patch.yml 分层装配 → 这里简化为「本地目录 + 启用状态文件」；
 * - dsh 的 `dsh-hmr` 监视配置文件触发重载 → 这里用 fs.watch 监视插件目录，卸载→重载→重跑 apply；
 * - 保留的：**注册即副作用、卸载即撤销**、**inject 依赖驱动加载**、**坏插件只影响自己**。
 *
 * ⚠️ 插件代码与宿主同进程（对齐 dsh「已安装的宿主代码在宿主进程内运行，不受工作区沙箱约束」），
 * 清单权限是透明化与误操作防护，不是沙箱。设置页必须在启用前把权限展示给用户。
 */

import { app } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { brand, isValidPluginId, type PluginId } from '@/types/ids'
import { IPCError } from '@/types/ipc'
import type {
  AikmPluginManifest,
  AikmPluginModule,
  PluginContext,
  PluginDataFileStat,
  PluginEvent,
  PluginHostApi,
  PluginLogLevel,
  PluginLogLine,
  PluginPermission,
  PluginShellResult,
  PluginSnapshot,
  PluginStatus,
  PluginStorage,
} from '@/types/plugin'
import { PluginEventBus, PluginServiceRegistry, createPluginContext } from '@/shared/pluginContext'
import { checkApiVersion, isManifestFailure, parseManifest, PLUGIN_MANIFEST_FILE, PLUGIN_MANIFEST_KEY } from '@/shared/pluginManifest'
import { toolRegistry } from '@/shared/toolRegistry'
import { shellService } from './shell-service'
import { isShellAllowed, resolvePolicy } from './sandbox-policy'
import { createPluginToolRegistrar } from './plugin-tools'

/** 每个插件保留的日志行数（内存环形缓冲，供设置页查看） */
const LOG_LIMIT = 300
/** 客户端半边 bundle 的大小上限（IPC 传字符串，避免误打包大文件打满内存） */
const CLIENT_BUNDLE_MAX_BYTES = 4 * 1024 * 1024
/** 目录热重载的去抖窗口 */
const WATCH_DEBOUNCE_MS = 400
/** 状态文件名（与插件目录同级；扫描时按「非目录」跳过） */
const STATE_FILE = 'plugins-state.json'
/** 私有数据目录名（同级） */
const DATA_DIR = 'plugins-data'
/**
 * 深层扫描的最大相对深度（插件根目录 = 0）。
 * 用户常把插件按用途分文件夹存放（plugins/办公/表格工具），因此扫描会向下递归；
 * 但要防止误把某个大目录（如用户把整个桌面设为插件目录）整棵树走一遍。
 */
const MAX_SCAN_DEPTH = 4

interface PluginState {
  version: 1
  /** 自定义插件目录（null = 默认 userData/plugins）；由「设置 → 插件 → 管理 → 选择插件目录」写入 */
  root: string | null
  /** 用户显式禁用的插件 id */
  disabled: string[]
  /** 每插件配置（传给 ctx.config） */
  configs: Record<string, Record<string, unknown>>
}

interface PluginRecord {
  id: PluginId
  dir: string
  /** 相对插件根目录的路径（正斜杠分隔，如 `办公/表格工具`；顶层插件即目录名） */
  relDir: string
  manifest: AikmPluginManifest | null
  status: PluginStatus
  enabled: boolean
  error: string | null
  loadedAt: number | null
  /**
   * 加载世代：每次 load/unload 自增。
   * 用于丢弃「加载途中被卸载/重载」的那次加载（否则会留下无主的注册与副作用）。
   */
  epoch: number
  /** 实际用于加载的依赖（清单 inject ∪ 模块 inject） */
  inject: string[]
  config: Record<string, unknown>
  logs: PluginLogLine[]
  /** 运行态（卸载时清空） */
  context: PluginContext | null
  dispose: (() => Promise<void>) | null
  tools: string[]
  services: string[]
}

export interface PluginHostInitOptions {
  /** 事件出口（plugin-ipc 注入 sendToAll，避免与 ipc-registry 形成循环依赖） */
  eventSink: (event: PluginEvent) => void
  /**
   * 额外内置服务（插件可 inject）。
   *
   * 由应用侧注入而非本模块直接 import：宿主只依赖 `tools`（工具注册表，主/渲染共用）
   * 与 `shell`（shell-service，纯 child_process），其余应用服务（sessionLog / jobs / …）
   * 属于「装配」而非「宿主」，注入可让宿主保持无副作用、可单测。
   */
  builtinServices?: Record<string, unknown>
}

class PluginHost {
  private records = new Map<PluginId, PluginRecord>()
  private services = new PluginServiceRegistry()
  private events = new PluginEventBus()
  private eventSink: ((event: PluginEvent) => void) | null = null
  /** 应用侧注入的内置服务（sessions.list 等宿主能力按名取用） */
  private builtin: Record<string, unknown> = {}
  private watchers: fs.FSWatcher[] = []
  private watchTimer: NodeJS.Timeout | null = null
  private dirty = new Set<string>()
  private initialized = false
  /** 已 dispose：作废后续的加载（含 fs.watch 去抖回调），避免退出后「插件复活」 */
  private disposed = false
  /** 安装中（复制文件会触发 watcher）：期间忽略热重载，避免复制到一半被加载 */
  private installing = 0
  /**
   * 组操作互斥链：`setRoot` / `install` / `dispose` 与逐个插件的 enable/disable/reload
   * 不能交叉执行——否则「切换目录」的卸载会被仍在进行中的加载补回注册（实测踩到：
   * 切目录后旧插件的工具/服务残留，新目录的插件却因 dispatch 被跳过而没装载）。
   */
  private opChain: Promise<unknown> = Promise.resolve()
  /** dispatch 期间有新工作到来（新服务出现 / 状态变化）→ 再来一轮 */
  private dispatchAgain = false
  /**
   * 正在切换插件目录：期间**禁止**装载。
   * 实测踩坑：卸载插件会注销服务 → services.onChange 触发 dispatch → 此时根目录还没切、记录状态
   * 已回到 discovered，于是把旧目录的插件又装载了一遍（随后新目录的同名插件因「服务/工具已注册」而加载失败）。
   */
  private rootSwitching = false
  private importSeq = 0
  private dispatching = false
  /** 当前装载轮次（并发调用复用同一 promise，见 dispatchPending） */
  private currentDispatch: Promise<void> | null = null

  // ---------------------------------------------------------------------------
  // 路径
  // ---------------------------------------------------------------------------

  /** 插件根目录（dev 可用 AIKM_PLUGINS_DIR 隔离测试） */
  pluginsRoot(): string {
    const override = process.env.AIKM_PLUGINS_DIR
    if (override) return path.resolve(override)
    const custom = this.customRoot
    return custom ? custom : path.join(app.getPath('userData'), 'plugins')
  }

  /** 读取（或首次加载）配置里的自定义根目录 */
  private customRoot: string | null = null

  /**
   * 切换插件目录（「设置 → 插件 → 管理 → 选择插件目录」）。
   * 会先卸载全部插件（撤销其注册），清空注册表，再从新目录扫描并重新装载；
   * 目录不存在时自动创建（对齐技能目录的交互：选一个文件夹即可用）。
   * 传 null 表示恢复默认（userData/plugins）。
   */
  async setRoot(dir: string | null): Promise<string> {
    return this.withLock(async () => {
      const next = dir ? path.resolve(dir) : null
      try {
        if (next) fs.mkdirSync(next, { recursive: true })
      } catch (e) {
        throw new IPCError('INVALID_ARGUMENT', `插件目录不可用：${next}（${e instanceof Error ? e.message : String(e)}）`)
      }

      // 切换期间禁止任何装载（见 rootSwitching 注释）
      this.rootSwitching = true
      try {
        // 1) 卸载现有插件（含撤销工具 / 服务注册）
        for (const rec of this.records.values()) await this.unloadPlugin(rec, 'root-change')
        // 2) 切换根目录
        this.customRoot = next
        this.records.clear()
        this.dirty.clear()
        for (const w of this.watchers) {
          try {
            w.close()
          } catch {
            /* 忽略监听关闭错误 */
          }
        }
        this.watchers = []

        // 3) 新目录扫描（先把新根目录写盘，再扫描）
        const prev = this.loadState()
        this.writeState({ version: 1, root: next, disabled: prev.disabled, configs: prev.configs })
        try {
          fs.mkdirSync(this.dataRoot(), { recursive: true })
        } catch {
          /* 数据目录失败不影响扫描 */
        }
        this.scan()
      } finally {
        this.rootSwitching = false
      }

      // 4) 装载新目录的插件 + 重建 watcher
      await this.dispatchPending()
      if (this.initialized) this.startWatcher()
      console.log(
        `[plugin-host] 插件目录已切换：${this.pluginsRoot()}（已加载 ${this.list().filter((s) => s.status === 'active').length}/${this.records.size}）`,
      )
      return this.pluginsRoot()
    })
  }

  /** 当前是否为自定义目录（UI 用来决定是否显示「恢复默认」） */
  hasCustomRoot(): boolean {
    return !!this.customRoot
  }

  /** 插件私有数据根目录 */
  dataRoot(): string {
    return path.join(app.getPath('userData'), DATA_DIR)
  }

  /**
   * 状态文件固定放在 userData（**不能**放在插件根目录内）：
   * 插件目录现在可由用户切换，若状态文件跟着根目录走，切一次目录就会「丢掉」禁用列表与配置。
   * 首次运行会从旧的 `<插件根>/plugins-state.json` 迁移一次。
   */
  private stateFilePath(): string {
    return path.join(app.getPath('userData'), STATE_FILE)
  }

  /** 迁移旧位置的状态文件（P2 之前状态文件在插件根目录内） */
  private migrateLegacyState(): void {
    try {
      const legacy = path.join(this.pluginsRoot(), STATE_FILE)
      if (!fs.existsSync(this.stateFilePath()) && fs.existsSync(legacy)) {
        fs.copyFileSync(legacy, this.stateFilePath())
        console.log(`[plugin-host] 已迁移插件状态文件：${legacy} → ${this.stateFilePath()}`)
      }
    } catch (e) {
      console.warn('[plugin-host] 迁移插件状态文件失败（忽略）:', e)
    }
  }

  private pluginDataDir(id: PluginId): string {
    return path.join(this.dataRoot(), id)
  }

  /**
   * 列出插件在主进程侧的数据文件（`userData/plugins-data/<id>/`，例如 `ctx.storage` 的 storage.json）。
   * 渲染层读不到这个目录，所以「设置 → 插件 → 数据」要经 IPC 拿它；插件没有数据时返回空数组。
   */
  listDataFiles(id: string): PluginDataFileStat[] {
    const dir = this.dataDirOf(id)
    return dir ? this.walkDataDir(dir) : []
  }

  /** 一次列出所有插件的主进程侧数据文件（列表页显示占用用，只走一遍数据根目录） */
  listAllDataFiles(): Record<string, PluginDataFileStat[]> {
    const out: Record<string, PluginDataFileStat[]> = {}
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(this.dataRoot(), { withFileTypes: true })
    } catch {
      return out
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const stats = this.walkDataDir(path.join(this.dataRoot(), entry.name))
      if (stats.length) out[entry.name] = stats
    }
    return out
  }

  /** 递归列出一个目录下的文件（相对路径 + 字节数） */
  private walkDataDir(dir: string): PluginDataFileStat[] {
    const out: PluginDataFileStat[] = []
    const walk = (abs: string, prefix: string, depth: number): void => {
      if (depth > 8) return
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        const child = path.join(abs, entry.name)
        if (entry.isDirectory()) {
          walk(child, rel, depth + 1)
          continue
        }
        let size = 0
        try {
          size = fs.statSync(child).size
        } catch {
          size = 0
        }
        out.push({ name: rel, size })
      }
    }
    walk(dir, '', 0)
    out.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }

  /** 删除插件数据目录里的一个文件 / 子目录（相对路径，越界直接拒绝） */
  removeDataFile(id: string, name: string): boolean {
    const dir = this.dataDirOf(id)
    if (!dir) return false
    let target: string
    try {
      target = this.resolveInside(dir, name)
    } catch {
      return false
    }
    try {
      fs.rmSync(target, { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  }

  /** 删除插件的整个主进程数据目录（`userData/plugins-data/<id>/`） */
  clearDataDir(id: string): boolean {
    const dir = this.dataDirOf(id)
    if (!dir) return false
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  }

  /** 校验插件 id 并给出它的数据目录（id 非法返回 null，避免越界读写） */
  private dataDirOf(id: string): string | null {
    const pid = this.toPluginId(String(id ?? ''))
    return pid ? this.pluginDataDir(pid) : null
  }

  // ---------------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------------

  /** 串行执行组操作（见 opChain 注释）；前一个失败不阻断后续 */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(fn, fn)
    this.opChain = run.catch(() => undefined)
    return run
  }

  async init(options: PluginHostInitOptions): Promise<void> {
    if (this.initialized) return
    this.eventSink = options.eventSink
    this.builtin = options.builtinServices ?? {}
    // 自定义插件目录（用户在设置里选的）要在建目录 / 扫描之前就位
    this.customRoot = this.loadState().root
    this.migrateLegacyState()
    try {
      fs.mkdirSync(this.pluginsRoot(), { recursive: true })
      fs.mkdirSync(this.dataRoot(), { recursive: true })
    } catch (e) {
      console.error('[plugin-host] 创建插件目录失败:', e)
      return
    }

    this.registerBuiltinServices()
    // 服务变化 → 重试 pending 插件（依赖驱动加载）
    this.services.onChange(() => this.dispatchPending())

    this.scan()
    await this.dispatchPending()
    this.startWatcher()
    this.initialized = true

    const active = this.list().filter((s) => s.status === 'active').length
    console.log(`[plugin-host] 插件根目录: ${this.pluginsRoot()}（已加载 ${active}/${this.records.size}）`)  }

  /** 全量卸载（应用退出时调用） */
  async dispose(): Promise<void> {
    return this.withLock(async () => {
      this.disposed = true
      for (const w of this.watchers) {
        try {
          w.close()
        } catch {
          /* 忽略监听关闭错误 */
        }
      }
      this.watchers = []
      if (this.watchTimer) clearTimeout(this.watchTimer)
      this.watchTimer = null
      this.dirty.clear()
      for (const rec of this.records.values()) {
        await this.unloadPlugin(rec, 'shutdown')
      }
      this.initialized = false
    })
  }

  // ---------------------------------------------------------------------------
  // 查询
  // ---------------------------------------------------------------------------

  list(): PluginSnapshot[] {
    return Array.from(this.records.values())
      .map((rec) => this.snapshot(rec))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  get(id: string): PluginSnapshot | null {
    const rec = this.records.get(id as PluginId)
    return rec ? this.snapshot(rec) : null
  }

  /** 日志回看 */
  logs(id: string): PluginLogLine[] {
    return this.records.get(id as PluginId)?.logs.slice() ?? []
  }

  /**
   * 读取插件渲染层半边的 bundle 源码（P1：渲染层拿到后用 Blob URL 动态 import）。
   *
   * 为什么不做自定义协议：dev（http server）与生产（file://）行为一致，且不必改
   * `registerSchemesAsPrivileged` / CSP 白名单里的 scheme；代价是客户端半边必须是单文件 ESM。
   * 大小上限 4MB（IPC 传输的是字符串，避免误打包大文件把内存打满）。
   */
  readClientBundle(id: string): { entry: string; code: string } {
    const rec = this.requireRecord(id)
    const entry = rec.manifest?.client?.entry
    if (!entry) throw new IPCError('NOT_FOUND', `插件 ${id} 未声明 client 半边（package.json 的 aikm.client）`)
    const abs = this.resolveInside(rec.dir, entry)
    if (!fs.existsSync(abs)) throw new IPCError('PLUGIN_LOAD_FAILED', `客户端入口不存在：${entry}`)
    const stat = fs.statSync(abs)
    if (stat.size > CLIENT_BUNDLE_MAX_BYTES) {
      throw new IPCError(
        'PLUGIN_LOAD_FAILED',
        `客户端入口过大（${Math.round(stat.size / 1024)}KB > ${Math.round(CLIENT_BUNDLE_MAX_BYTES / 1024)}KB）：请先打包成单文件 ESM`,
      )
    }
    return { entry, code: fs.readFileSync(abs, 'utf8') }
  }

  /** 插件根目录（设置页「打开目录」用） */
  rootDir(): string {
    return this.pluginsRoot()
  }

  /** 服务名清单（设置页展示宿主能力面） */
  serviceNames(): string[] {
    return this.services.list()
  }

  // ---------------------------------------------------------------------------
  // 管理操作（审批在 plugin-ipc 层完成，这里只做状态与文件系统动作）
  // ---------------------------------------------------------------------------

  async enable(id: string): Promise<PluginSnapshot> {
    return this.withLock(async () => {
      const rec = this.requireRecord(id)
      this.assertApiVersion(rec)
      if (!rec.enabled) {
        rec.enabled = true
        this.removeDisabled(rec.id)
        this.saveState()
      }
      await this.loadPlugin(rec)
      return this.snapshot(rec)
    })
  }

  async disable(id: string): Promise<PluginSnapshot> {
    return this.withLock(async () => {
      const rec = this.requireRecord(id)
      await this.unloadPlugin(rec, 'user-disabled')
      rec.enabled = false
      rec.status = 'disabled'
      this.addDisabled(rec.id)
      this.saveState()
      this.pushChanged(rec)
      return this.snapshot(rec)
    })
  }

  async reload(id: string): Promise<PluginSnapshot> {
    return this.withLock(async () => {
      const rec = this.requireRecord(id)
      this.assertApiVersion(rec)
      // 清单可能已被作者改过：重载前重新扫描本插件目录
      this.rescanRecord(rec)
      await this.unloadPlugin(rec, 'reload')
      if (rec.enabled) await this.loadPlugin(rec)
      return this.snapshot(rec)
    })
  }

  async uninstall(id: string, deleteFiles = false): Promise<{ removed: boolean; deletedDir: boolean }> {
    return this.withLock(async () => {
      const rec = this.requireRecord(id)
      await this.unloadPlugin(rec, 'uninstall')
      this.records.delete(rec.id)
      this.removeDisabled(rec.id)
      this.removeConfig(rec.id)
      this.saveState()
      this.emit({ type: 'plugin/changed', id: rec.id, snapshot: null })

      let deletedDir = false
      if (deleteFiles) {
        try {
          fs.rmSync(rec.dir, { recursive: true, force: true })
          deletedDir = true
        } catch (e) {
          throw new IPCError('INTERNAL', `插件已从注册表移除，但删除目录失败：${e instanceof Error ? e.message : String(e)}`)
        }
      }
      return { removed: true, deletedDir }
    })
  }

  /**
   * 从本地目录安装插件（P2 本地安装能力；不做在线商店）。
   *
   * 步骤：校验目录名/id → 校验清单与 API 版本 → 必要时卸载并删除旧目录 → 复制（跳过
   * `node_modules` / `.git`，插件应自带打包好的单文件产物）→ 刷新注册表并立即加载。
   * 同名冲突时抛 `PLUGIN_EXISTS`，由 UI 询问用户后再以 `replace: true` 重试（不做静默覆盖）。
   */
  async installFromDirectory(srcDir: string, options: { replace?: boolean } = {}): Promise<PluginSnapshot> {
    return this.withLock(() => this.installInner(srcDir, options))
  }

  private async installInner(srcDir: string, options: { replace?: boolean }): Promise<PluginSnapshot> {
    const src = path.resolve(String(srcDir || ''))
    if (!src || !fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
      throw new IPCError('INVALID_ARGUMENT', `不是有效目录：${String(srcDir)}`)
    }
    const id = path.basename(src)
    if (!isValidPluginId(id)) {
      throw new IPCError(
        'INVALID_ARGUMENT',
        `目录名不能作为插件 id："${id}"（须以小写字母/数字开头，仅含 [a-z0-9._-]）`,
      )
    }
    const read = this.readManifest(src)
    const manifest = read.manifest
    if (!manifest) {
      throw new IPCError('PLUGIN_LOAD_FAILED', `插件包不可用：${read.message ?? read.problem ?? '清单缺失'}`)
    }
    const versionCheck = checkApiVersion(manifest.apiVersion)
    if (!versionCheck.ok) throw new IPCError('API_VERSION_MISMATCH', versionCheck.reason ?? 'API 版本不匹配')

    const dest = path.join(this.pluginsRoot(), id)
    const sameLocation = path.resolve(src) === path.resolve(dest)
    const existingRec = this.records.get(id as PluginId)
    // 深层扫描后同名插件可能位于子文件夹（plugins/办公/<id>）：覆盖安装要作用在它身上，
    // 否则会在根目录再建一份，出现两个同名插件（扫描只认最外层那份）。
    const prevDir = existingRec && path.resolve(existingRec.dir) !== path.resolve(dest) ? existingRec.dir : ''
    const exists = !!existingRec || fs.existsSync(dest)

    if (exists && !options.replace && !sameLocation) {
      const where = prevDir ? `（当前位于 ${existingRec?.relDir}）` : ''
      throw new IPCError('PLUGIN_EXISTS', `同名插件已存在：${id}${where}（如需覆盖请使用「覆盖安装」）`)
    }

    this.installing++
    try {
      if (!sameLocation) {
        if (exists) {
          // 覆盖安装：先卸载（撤销注册）再删旧目录，避免残留旧文件与占用
          if (existingRec) await this.unloadPlugin(existingRec, 'reinstall')
          fs.rmSync(prevDir || dest, { recursive: true, force: true })
        }
        fs.mkdirSync(dest, { recursive: true })
        fs.cpSync(src, dest, {
          recursive: true,
          force: true,
          // 跳过依赖与版本库目录：插件应自带打包产物（见 examples/plugins/hello-panel/README.md）
          filter: (from) => {
            const base = path.basename(from)
            return base !== 'node_modules' && base !== '.git' && base !== '.DS_Store'
          },
        })
      }
      const state = this.loadState()
      this.upsertRecord(id as PluginId, dest, state)
      const rec = this.requireRecord(id)
      rec.enabled = true
      this.removeDisabled(rec.id)
      rec.status = 'discovered'
      rec.error = null
      await this.loadPlugin(rec)
      this.log(rec, 'info', sameLocation ? '已在插件目录内，直接加载' : `已从 ${src} 安装`)
      return this.snapshot(rec)
    } finally {
      this.installing--
    }
  }

  /** 读取配置 */
  getConfig(id: string): Record<string, unknown> {
    return this.requireRecord(id).config
  }

  /**
   * 从「商店包」安装插件：包内容是一组内存中的文件（来自共享目录的 `/fs/bundle` 或任意商店索引）。
   *
   * 为什么先落盘到临时目录：安装流程（清单校验 / id 校验 / 复制 / 加载）只有一份，走
   * `installFromDirectory` 才能保证「从文件夹安装」与「从商店安装」完全同构；商店包本身
   * 不带路径语义，因此每个文件的相对路径都要重新校验（不许绝对路径 / 越界）。
   */
  async installFromBundle(
    bundle: {
      id?: string
      files: Array<{ path?: string; text?: string; base64?: string }>
    },
    options: { replace?: boolean } = {},
  ): Promise<PluginSnapshot> {
    const files = Array.isArray(bundle?.files) ? bundle.files : []
    if (!files.length) throw new IPCError('INVALID_ARGUMENT', '商店包为空')
    const manifestEntry = files.find((f) => normalizeRel(f.path) === PLUGIN_MANIFEST_FILE)
    if (!manifestEntry?.text) {
      throw new IPCError('PLUGIN_LOAD_FAILED', `商店包缺少 ${PLUGIN_MANIFEST_FILE}（或其内容不是文本）`)
    }
    let raw: any
    try {
      raw = JSON.parse(manifestEntry.text)
    } catch (e) {
      throw new IPCError('PLUGIN_LOAD_FAILED', `清单不是合法 JSON：${e instanceof Error ? e.message : String(e)}`)
    }
    const id = String(raw?.[PLUGIN_MANIFEST_KEY]?.id || bundle.id || '')
    if (!isValidPluginId(id)) {
      throw new IPCError('INVALID_ARGUMENT', `商店包里的插件 id 非法："${id}"（须以小写字母/数字开头，仅含 [a-z0-9._-]）`)
    }

    const stage = path.join(app.getPath('temp'), 'aikm-plugin-store', `${id}-${Date.now().toString(36)}`)
    const dir = path.join(stage, id)
    try {
      fs.mkdirSync(dir, { recursive: true })
      for (const f of files) {
        const rel = normalizeRel(f.path)
        if (!rel) continue
        const target = this.resolveInside(dir, rel)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        const buf = f.text != null ? Buffer.from(String(f.text), 'utf8') : Buffer.from(String(f.base64 || ''), 'base64')
        fs.writeFileSync(target, buf)
      }
    } catch (e) {
      this.removeDir(stage)
      throw new IPCError('PLUGIN_LOAD_FAILED', `商店包写入失败：${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      return await this.installFromDirectory(dir, options)
    } finally {
      this.removeDir(stage)
    }
  }

  private removeDir(dir: string): void {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch (e) {
      console.warn('[plugin-host] 清理临时目录失败（忽略）:', e)
    }
  }

  /** 写入配置（合并；改动在重新加载后生效——避免每次编辑都触发一次卸载/加载） */
  setConfig(id: string, patch: Record<string, unknown>): Record<string, unknown> {
    const rec = this.requireRecord(id)
    if (!patch || typeof patch !== 'object') {
      throw new IPCError('INVALID_ARGUMENT', 'patch 必须是对象')
    }
    rec.config = { ...rec.config, ...patch }
    this.saveState()
    this.pushChanged(rec)
    return rec.config
  }

  /** 安装前预检：id 或绝对路径 → 清单摘要（对齐 dsh 的 inspect()，只做本地目录版本） */
  inspect(spec: string): {
    ok: boolean
    id: string | null
    name: string | null
    version: string | null
    apiVersion: string | null
    permissions: PluginPermission[]
    problem: string | null
  } {
    const empty = { id: null, name: null, version: null, apiVersion: null, permissions: [] as PluginPermission[] }
    const text = String(spec || '').trim()
    if (!text) return { ok: false, ...empty, problem: 'invalid-spec' }

    const existing = this.records.get(text as PluginId)
    if (existing) {
      return {
        ok: true,
        id: existing.id,
        name: existing.manifest?.name ?? existing.id,
        version: existing.manifest?.version ?? null,
        apiVersion: existing.manifest?.apiVersion ?? null,
        permissions: existing.manifest?.permissions ?? [],
        problem: null,
      }
    }

    if (!path.isAbsolute(text)) return { ok: false, ...empty, problem: 'not-found' }
    if (!fs.existsSync(text) || !fs.statSync(text).isDirectory()) {
      return { ok: false, ...empty, problem: 'not-a-directory' }
    }
    const dirName = path.basename(text)
    const read = this.readManifest(text)
    const manifest = read.manifest
    if (!manifest) return { ok: false, ...empty, problem: read.problem }
    const versionCheck = checkApiVersion(manifest.apiVersion)
    if (!versionCheck.ok) {
      return {
        ok: false,
        id: dirName,
        name: manifest.name,
        version: manifest.version,
        apiVersion: manifest.apiVersion,
        permissions: manifest.permissions ?? [],
        problem: `api-version-mismatch: ${versionCheck.reason ?? ''}`,
      }
    }
    return {
      ok: true,
      id: dirName,
      name: manifest.name,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      permissions: manifest.permissions ?? [],
      problem: null,
    }
  }

  // ---------------------------------------------------------------------------
  // 扫描
  // ---------------------------------------------------------------------------

  private scan(): void {
    const state = this.loadState()
    const seen = new Set<PluginId>()

    for (const dir of this.collectPluginDirs()) {
      const name = path.basename(dir)
      const id = this.toPluginId(name)
      if (!id) {
        console.warn(`[plugin-host] 跳过目录（目录名不能作为插件 id）：${this.relDirOf(dir)}`)
        continue
      }
      if (seen.has(id)) {
        // 同名目录出现在不同文件夹里：只看最外层那一个，其余忽略（id 必须唯一）
        console.warn(`[plugin-host] 忽略重复插件 id 的目录：${this.relDirOf(dir)}（${id} 已由更外层目录占用）`)
        continue
      }
      seen.add(id)
      this.upsertRecord(id, dir, state)
    }

    // 目录已被删除的插件：清理注册表记录
    for (const id of Array.from(this.records.keys())) {
      if (!seen.has(id)) this.records.delete(id)
    }
  }

  /**
   * 收集插件目录（支持「分类文件夹」深层存放）。
   *
   * 规则：
   *  - 目录里有 `package.json` 且含 `aikm` 清单字段 → 该目录就是一个插件，**不再向下递归**
   *    （插件自己的子目录如 src/ 不会被误当插件）；
   *  - 否则视为分类文件夹，继续向下找，最多 MAX_SCAN_DEPTH 层；
   *  - 跳过隐藏目录（`.` 开头）、`node_modules`、`plugins-data` 等非插件目录；
   *  - 顺序稳定（按目录名排序），保证结果可预测。
   */
  private collectPluginDirs(): string[] {
    const root = this.pluginsRoot()
    const out: string[] = []
    const walk = (dir: string, depth: number): void => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch (e) {
        console.error(`[plugin-host] 扫描目录失败（跳过）：${dir}`, e)
        return
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === DATA_DIR) continue
        const child = path.join(dir, entry.name)
        if (this.looksLikePluginDir(child)) {
          out.push(child)
          continue
        }
        if (depth + 1 < MAX_SCAN_DEPTH) walk(child, depth + 1)
      }
    }
    walk(root, 0)
    return out
  }

  /** 目录是否「就是一个插件」：有 package.json 且 JSON 可解析、含 aikm 清单字段（清单内容合法性交给 readManifest 判定） */
  private looksLikePluginDir(dir: string): boolean {
    const file = path.join(dir, PLUGIN_MANIFEST_FILE)
    if (!fs.existsSync(file)) return false
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      return !!raw && typeof raw === 'object' && !!(raw as Record<string, unknown>)[PLUGIN_MANIFEST_KEY]
    } catch {
      // package.json 存在但坏了：大概率是用户正在编辑的插件 → 当作插件处理，让它在列表里显示错误原因
      return true
    }
  }

  /** 目录相对插件根目录的路径（正斜杠分隔；根目录本身返回空串） */
  private relDirOf(dir: string): string {
    return path.relative(this.pluginsRoot(), dir).replace(/\\/g, '/')
  }

  /** 插件所属「文件夹」：相对插件根目录的一级分类路径（顶层插件为 ''） */
  private folderOf(rec: PluginRecord): string {
    const idx = rec.relDir.lastIndexOf('/')
    return idx < 0 ? '' : rec.relDir.slice(0, idx)
  }

  /**
   * 重新扫描插件目录（设置页「重新扫描」用）：补上手动放进子文件夹的新插件、清掉已删除的，
   * 然后照常按依赖装配。已加载的插件不会被卸载重建（scan 只更新清单与状态）。
   */
  async rescan(): Promise<void> {
    return this.withLock(async () => {
      this.scan()
      await this.dispatchPending()
    })
  }

  /** 新增或刷新单个插件的清单解析结果（重载/热更新共用） */
  private upsertRecord(id: PluginId, dir: string, state: PluginState): void {
    const enabled = !state.disabled.includes(id)
    const existing = this.records.get(id)
    const rec: PluginRecord = existing ?? {
      id,
      dir,
      relDir: this.relDirOf(dir),
      manifest: null,
      status: 'discovered',
      enabled,
      error: null,
      loadedAt: null,
      epoch: 0,
      inject: [],
      config: {},
      logs: [],
      context: null,
      dispose: null,
      tools: [],
      services: [],
    }
    rec.dir = dir
    rec.relDir = this.relDirOf(dir)
    rec.enabled = enabled
    const rawConfig = state.configs[id]
    rec.config = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig) ? rawConfig : {}

    const read = this.readManifest(dir)
    const manifest = read.manifest
    if (!manifest) {
      rec.manifest = null
      rec.status = 'invalid'
      rec.error = read.message ?? read.problem ?? '清单不可用'
      this.records.set(id, rec)
      return
    }
    rec.manifest = manifest
    rec.inject = manifest.inject ?? []
    const versionCheck = checkApiVersion(manifest.apiVersion)
    if (!versionCheck.ok) {
      rec.status = 'invalid'
      rec.error = versionCheck.reason ?? 'API 版本不匹配'
    } else if (!enabled) {
      rec.status = 'disabled'
      rec.error = null
    } else if (rec.status === 'invalid' || rec.status === 'failed') {
      rec.status = 'discovered'
      rec.error = null
    }
    this.records.set(id, rec)
  }

  /** 重载前重新解析清单（作者可能在运行中改了 package.json） */
  private rescanRecord(rec: PluginRecord): void {
    const state = this.loadState()
    this.upsertRecord(rec.id, rec.dir, state)
  }

  /**
   * 读取并校验清单。
   * 返回扁平结构（manifest 为 null 即失败）：主进程 tsconfig 未开 strictNullChecks，
   * 判别式联合的自动收窄不可靠，扁平结构无需收窄。
   */
  private readManifest(
    dir: string,
  ): { manifest: AikmPluginManifest | null; problem: string | null; message: string | null } {
    const file = path.join(dir, PLUGIN_MANIFEST_FILE)
    if (!fs.existsSync(file)) {
      return { manifest: null, problem: 'no-manifest', message: `缺少 ${PLUGIN_MANIFEST_FILE}` }
    }
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      return {
        manifest: null,
        problem: 'bad-json',
        message: `package.json 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`,
      }
    }
    const parsed = parseManifest(raw, path.basename(dir))
    if (isManifestFailure(parsed)) {
      return { manifest: null, problem: parsed.problem, message: parsed.message }
    }
    return { manifest: parsed.manifest, problem: null, message: null }
  }

  // ---------------------------------------------------------------------------
  // 加载 / 卸载
  // ---------------------------------------------------------------------------

  private async loadPlugin(rec: PluginRecord): Promise<void> {
    // 已 dispose：不再加载（否则退出后 watch 回调会把插件与它的定时器一起复活）
    if (this.disposed) return
    if (!rec.manifest) {
      rec.status = 'invalid'
      rec.error = '清单不可用'
      this.pushChanged(rec)
      return
    }
    if (!rec.enabled) {
      rec.status = 'disabled'
      this.pushChanged(rec)
      return
    }
    if (!rec.manifest.main) {
      // 纯 UI 插件（P1 才加载渲染层半边）：主进程不做任何事
      rec.status = 'active'
      rec.error = null
      rec.loadedAt = Date.now()
      this.log(rec, 'info', '纯 UI 插件（main 缺省）：主进程无加载动作，渲染层半边将在 P1 生效')
      this.pushChanged(rec)
      return
    }
    // 并发保护：dispatch 与显式 reload/enable 可能同时命中同一插件，
    // 重复进入会导致工具/服务重复注册（toolRegistry 会抛「工具已注册」）
    if (rec.status === 'loading' || rec.status === 'active') return
    // 兜底：异常路径下若仍留有上一实例的注册（如上次加载失败但注册未清），先撤销，避免重复注册
    if (rec.dispose) {
      try {
        await rec.dispose()
      } catch {
        /* 已由 dispose 内部记录 */
      }
      rec.dispose = null
      rec.context = null
      rec.tools = []
      rec.services = []
    }

    const missing = rec.inject.filter((name) => !this.services.has(name))
    if (missing.length) {
      rec.status = 'pending'
      rec.error = `等待依赖服务：${missing.join('、')}`
      this.pushChanged(rec)
      return
    }

    rec.status = 'loading'
    rec.error = null
    this.pushChanged(rec)

    // 本次加载的世代：加载是异步的（import + apply），期间可能被 unload/reload
    const epoch = ++rec.epoch
    const log = this.createLogger(rec)
    try {
      const moduleExports = await this.importPluginModule(rec)
      if (rec.epoch !== epoch) return

      const plugin = normalizePluginModule(moduleExports)
      if (!plugin) throw new Error('插件模块未导出 apply(ctx)（默认导出或具名 apply 均可）')

      const inject = dedupe([...(rec.manifest.inject ?? []), ...(plugin.inject ?? [])])
      const missingAfter = inject.filter((name) => !this.services.has(name))
      if (missingAfter.length) {
        rec.inject = inject
        rec.status = 'pending'
        rec.error = `等待依赖服务：${missingAfter.join('、')}`
        this.pushChanged(rec)
        return
      }
      rec.inject = inject
      if (rec.epoch !== epoch) return

      const registrar = createPluginToolRegistrar({
        id: rec.id,
        permissions: rec.manifest.permissions ?? [],
        log,
      })
      const handle = createPluginContext({
        id: rec.id,
        name: rec.manifest.name,
        version: rec.manifest.version,
        dir: rec.dir,
        config: rec.config,
        services: {
          provide: (name, impl) => {
            const off = this.services.provide(name, impl)
            rec.services.push(name)
            return () => {
              off()
              rec.services = rec.services.filter((n) => n !== name)
            }
          },
          get: (name) => this.services.get(name),
        },
        registerTool: (def) => {
          const off = registrar(def)
          rec.tools.push(def.name)
          return () => {
            off()
            rec.tools = rec.tools.filter((n) => n !== def.name)
          }
        },
        subscribeHostEvent: (type, listener) => this.events.on(type, listener),
        host: this.createHostApi(rec),
        storage: this.createStorage(rec),
        log,
      })

      rec.context = handle.ctx
      rec.dispose = handle.dispose

      await plugin.apply(handle.ctx)

      // apply 期间被卸载/重载：立即撤销这次注册结果，避免泄漏
      if (rec.epoch !== epoch) {
        await handle.dispose()
        return
      }

      rec.status = 'active'
      rec.error = null
      rec.loadedAt = Date.now()
      this.log(rec, 'info', `${rec.manifest.name}@${rec.manifest.version} 已激活`)
      this.events.emit('plugin/loaded', { id: rec.id, tools: rec.tools.slice(), services: rec.services.slice() })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      rec.status = 'failed'
      rec.error = message
      // 回滚：apply 抛异常时撤销已经完成的注册（不留半成品）。
      // 若期间已被卸载/重载（epoch 变化），则新世代自己负责清理，这里不能动。
      if (rec.epoch === epoch && rec.dispose) {
        try {
          await rec.dispose()
        } catch {
          /* 回滚失败已由 dispose 内部记录 */
        }
      }
      if (rec.epoch === epoch) {
        rec.context = null
        rec.dispose = null
        rec.tools = []
        rec.services = []
      }
      this.log(rec, 'error', `加载失败：${message}`)
      this.events.emit('plugin/error', { id: rec.id, error: message })
    }
    this.pushChanged(rec)
    this.dispatchPending()
  }

  private async unloadPlugin(rec: PluginRecord, reason: string): Promise<void> {
    // 作废进行中的加载（其 await 返回后会看到 epoch 变化并放弃/回滚）
    rec.epoch++
    const wasActive = rec.status === 'active' || rec.status === 'failed'
    if (rec.dispose) {
      try {
        await rec.dispose()
      } catch (e) {
        this.log(rec, 'error', `卸载清理异常：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    rec.context = null
    rec.dispose = null
    rec.tools = []
    rec.services = []
    if (wasActive) {
      this.events.emit('plugin/unloaded', { id: rec.id, reason })
    }
    if (rec.enabled) {
      if (rec.status !== 'invalid') {
        rec.status = 'discovered'
        rec.error = null
        rec.loadedAt = null
      }
    } else {
      rec.status = 'disabled'
    }
    if (reason !== 'shutdown') this.pushChanged(rec)
  }

  /**
   * 装载所有「可装载」的插件，直到状态稳定：
   * - `discovered`（启用且清单可用，尚未加载）；
   * - `pending`（依赖未就绪）——服务刚注册时也走这里重试。
   *
   * **串行 await**：init() 依赖它在返回前把状态推到稳定（否则测试/UI 会看到
   * 「加载中却报 discovered」），并让「A 提供服务 → B 随之装载」的依赖链在
   * 同一轮里收敛。重入由 dispatching 标记挡住（loadPlugin 末尾的调用会直接返回）。
   */
  /**
   * 装载所有「可装载」的插件（`discovered` / 依赖已就绪的 `pending`）。
   *
   * 并发语义（实测踩坑）：`setRoot` / 安装 / 服务注册都可能与「上一轮装载的收尾」重叠，
   * 若此时直接返回，新发现的插件就永远不会被装载。因此：
   * - 已有轮次在跑 → 记下「还要再来一轮」并复用同一个 promise（调用方会等到本轮结束）；
   * - 本轮结束后若仍被标记 → 再补一轮，消除「标记设得太晚」的窗口。
   */
  private async dispatchPending(): Promise<void> {
    if (this.disposed) return
    if (this.rootSwitching) {
      // 目录切换中：等切换完成后再装载（setRoot 末尾会显式调一次）
      this.dispatchAgain = true
      return
    }
    if (this.currentDispatch) {
      this.dispatchAgain = true
      return this.currentDispatch
    }
    this.currentDispatch = this.drainLoadable()
    try {
      await this.currentDispatch
    } finally {
      this.currentDispatch = null
    }
    if (this.dispatchAgain && !this.disposed) {
      this.dispatchAgain = false
      await this.dispatchPending()
    }
  }

  /** 一轮装载：直到没有「状态真正发生变化」的插件为止 */
  private async drainLoadable(): Promise<void> {
    let progressed = true
    while (progressed) {
      progressed = false
      for (const rec of Array.from(this.records.values())) {
        if (rec.status !== 'discovered' && rec.status !== 'pending') continue
        if (!rec.enabled) continue
        if (!rec.inject.every((name) => this.services.has(name))) continue
        const before = rec.status
        await this.loadPlugin(rec)
        // 只有「状态真的变了」才算推进：否则(如已 dispose/清单失效)会退化成
        // 无限微任务循环，把定时器饿死（冒烟测试曾因此挂住进程）。
        if (rec.status !== before) progressed = true
      }
    }
  }

  /** 动态加载插件入口：优先 ESM import（带 rev 绕过缓存，热重载必需），失败回退 createRequire */
  private async importPluginModule(rec: PluginRecord): Promise<unknown> {
    const rel = rec.manifest?.main
    if (!rel) throw new Error('清单未声明 main')
    const entryAbs = this.resolveInside(rec.dir, rel)
    if (!fs.existsSync(entryAbs)) throw new Error(`入口文件不存在：${rel}`)

    const url = `${pathToFileURL(entryAbs).href}?rev=${Date.now()}-${this.importSeq++}`
    try {
      return await import(/* @vite-ignore */ url)
    } catch (importError) {
      // 回退：CommonJS / 原生扩展（require 有独立缓存，需手动失效才能热重载）
      try {
        const req = createRequire(pathToFileURL(path.join(rec.dir, PLUGIN_MANIFEST_FILE)).href)
        delete req.cache[entryAbs]
        return req(entryAbs)
      } catch {
        throw importError
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 宿主能力（权限判定见 docs/plan 的 §五 安全模型）
  // ---------------------------------------------------------------------------

  private createHostApi(rec: PluginRecord): PluginHostApi {
    const permissions = rec.manifest?.permissions ?? []
    const has = (p: PluginPermission) => permissions.includes(p)
    const deny = (p: PluginPermission, action: string): never => {
      throw new IPCError('PERMISSION_DENIED', `插件未声明 ${p} 权限，无法${action}（请在 package.json 的 aikm.permissions 中声明）`)
    }
    // 解析到插件目录内（越界抛 INVALID_ARGUMENT）
    const resolveInside = (rel: string) => this.resolveInside(rec.dir, rel)

    // ⚠️ 全部成员必须用箭头函数：对象字面量的方法体里 `this` 指向该对象本身，
    // 会让 this.emit / resolveInside 变成 undefined（冒烟测试抓到的真实缺陷）。
    return {
      readFile: async (relPath: string) => fs.promises.readFile(resolveInside(relPath), 'utf8'),
      writeFile: async (relPath: string, content: string) => {
        const abs = resolveInside(relPath)
        await fs.promises.mkdir(path.dirname(abs), { recursive: true })
        await fs.promises.writeFile(abs, String(content ?? ''), 'utf8')
      },
      listDir: async (relPath = '.') => {
        const entries = await fs.promises.readdir(resolveInside(relPath), { withFileTypes: true })
        return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort()
      },
      runShell: async (command: string, opts): Promise<PluginShellResult> => {
        if (!has('shell')) deny('shell', '执行 shell 命令')
        const policy = resolvePolicy(opts?.policy, { workspaceRoot: opts?.cwd })
        if (!isShellAllowed(policy)) {
          throw new IPCError(
            'PERMISSION_DENIED',
            `shell 被沙箱策略拒绝：当前模式 ${policy.mode}（仅 trusted 放行；调用时需显式传 { policy: 'trusted' }）`,
          )
        }
        const res = await shellService.executeCommand(command, opts?.cwd)
        this.log(rec, 'warn', `[audit] runShell: ${command}`)
        return {
          code: res.exitCode ?? (res.success ? 0 : -1),
          stdout: res.stdout,
          stderr: res.stderr,
          ...(res.error ? { error: res.error } : {}),
        }
      },
      fetch: async (url: string, init?: RequestInit) => {
        if (!has('net')) deny('net', '访问网络')
        if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
          throw new IPCError('INVALID_ARGUMENT', `fetch 仅支持 http(s) URL：${String(url)}`)
        }
        return fetch(url, init)
      },
      sessions: {
        list: async () => {
          if (!has('agent')) deny('agent', '读取会话日志')
          const service = this.builtin.sessionLog as { listSessions?: () => unknown } | undefined
          if (typeof service?.listSessions !== 'function') {
            throw new IPCError('UNSUPPORTED', '宿主未接入会话日志服务（sessionLog）')
          }
          const raw = service.listSessions() as unknown as Array<Record<string, unknown>>
          return raw.map((s) => ({
            id: String(s.id ?? s.requestId ?? ''),
            events: Number(s.events ?? 0),
            lastTs: Number(s.lastTs ?? 0),
          }))
        },
      },
      notify: (message: string) => {
        this.emit({ type: 'plugin/notify', id: rec.id, message: String(message ?? '') })
      },
    }
  }

  private createStorage(rec: PluginRecord): PluginStorage {
    const file = path.join(this.pluginDataDir(rec.id), 'storage.json')
    const load = (): Record<string, unknown> => {
      try {
        if (!fs.existsSync(file)) return {}
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
      } catch {
        return {}
      }
    }
    const save = (data: Record<string, unknown>): void => {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
    }
    return {
      async get<T>(key: string) {
        return load()[key] as T | undefined
      },
      async set(key: string, value: unknown) {
        const data = load()
        data[key] = value
        save(data)
      },
      async delete(key: string) {
        const data = load()
        if (!(key in data)) return false
        delete data[key]
        save(data)
        return true
      },
      async keys() {
        return Object.keys(load())
      },
    }
  }

  private createLogger(rec: PluginRecord) {
    const push = (level: PluginLogLevel, args: unknown[]): void => {
      const message = args
        .map((a) => {
          if (typeof a === 'string') return a
          try {
            return JSON.stringify(a)
          } catch {
            return String(a)
          }
        })
        .join(' ')
      const line: PluginLogLine = { ts: Date.now(), level, message }
      rec.logs.push(line)
      if (rec.logs.length > LOG_LIMIT) rec.logs.splice(0, rec.logs.length - LOG_LIMIT)
      const prefix = `[plugin:${rec.id}]`
      if (level === 'error') console.error(prefix, message)
      else if (level === 'warn') console.warn(prefix, message)
      else console.log(prefix, message)
      this.emit({ type: 'plugin/log', id: rec.id, line })
    }
    return {
      debug: (...args: unknown[]) => push('debug', args),
      info: (...args: unknown[]) => push('info', args),
      warn: (...args: unknown[]) => push('warn', args),
      error: (...args: unknown[]) => push('error', args),
    }
  }

  private log(rec: PluginRecord, level: PluginLogLevel, message: string): void {
    this.createLogger(rec)[level](message)
  }

  // ---------------------------------------------------------------------------
  // 目录热重载
  // ---------------------------------------------------------------------------

  private startWatcher(): void {
    const root = this.pluginsRoot()
    /**
     * 目录改动 → 定位所属插件。
     * 深层扫描后 `filename` 的第一段可能只是「分类文件夹」，不能再按第一段当插件 id
     * （否则子文件夹里的插件永远收不到热重载）；这里按绝对路径落在哪个插件目录里来找。
     */
    const onChange = (base: string, filename: string | null): void => {
      if (this.disposed || this.installing) return
      if (!filename) return
      const first = filename.split(/[\\/]/)[0]
      if (!first || first.startsWith('.')) return
      const rec = this.recordForPath(path.resolve(base, filename))
      if (!rec) return
      this.dirty.add(rec.id)
      if (this.watchTimer) clearTimeout(this.watchTimer)
      this.watchTimer = setTimeout(() => void this.flushDirty(), WATCH_DEBOUNCE_MS)
    }

    try {
      const watcher = fs.watch(root, { recursive: true }, (_event, filename) => onChange(root, filename as string | null))
      watcher.on('error', () => {
        /* 忽略监听错误（网络盘等场景不支持递归监听） */
      })
      this.watchers.push(watcher)
    } catch {
      // 回退：逐个插件目录非递归监听（对齐 skill-service 的做法）
      for (const rec of this.records.values()) {
        try {
          const watcher = fs.watch(rec.dir, (_event, filename) => onChange(rec.dir, filename as string | null))
          watcher.on('error', () => {
            /* 忽略 */
          })
          this.watchers.push(watcher)
        } catch {
          /* 单个目录监听失败不影响其余插件 */
        }
      }
    }
  }

  /** 改动路径落在哪个插件目录内（同一路径只可能命中一个插件；未命中返回 null） */
  private recordForPath(abs: string): PluginRecord | null {
    for (const rec of this.records.values()) {
      const rel = path.relative(rec.dir, abs)
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return rec
    }
    return null
  }

  private async flushDirty(): Promise<void> {
    if (this.disposed || this.installing || this.rootSwitching) return
    const ids = Array.from(this.dirty)
    this.dirty.clear()
    for (const id of ids) {
      const rec = this.records.get(id as PluginId)
      if (!rec || rec.status === 'disabled') continue
      try {
        await this.reload(rec.id)
        console.log(`[plugin-host] 检测到改动，已重载插件 ${rec.id}`)
      } catch (e) {
        console.warn(`[plugin-host] 热重载失败 ${rec.id}:`, e)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 状态持久化
  // ---------------------------------------------------------------------------

  private loadState(): PluginState {
    const empty: PluginState = { version: 1, root: null, disabled: [], configs: {} }
    try {
      const file = this.stateFilePath()
      if (!fs.existsSync(file)) return empty
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!parsed || typeof parsed !== 'object') return empty
      return {
        version: 1,
        root: typeof parsed.root === 'string' && parsed.root.trim() ? parsed.root : null,
        disabled: Array.isArray(parsed.disabled) ? parsed.disabled.filter((x: unknown) => typeof x === 'string') : [],
        configs: parsed.configs && typeof parsed.configs === 'object' ? parsed.configs : {},
      }
    } catch (e) {
      console.warn('[plugin-host] 读取插件状态失败（按空状态继续）:', e)
      return empty
    }
  }

  private saveState(): void {
    const state: PluginState = {
      version: 1,
      root: this.customRoot,
      disabled: Array.from(this.records.values())
        .filter((rec) => !rec.enabled)
        .map((rec) => rec.id),
      configs: Object.fromEntries(
        Array.from(this.records.values())
          .filter((rec) => Object.keys(rec.config).length > 0)
          .map((rec) => [rec.id, rec.config]),
      ),
    }
    this.writeState(state)
  }

  private addDisabled(id: PluginId): void {
    const state = this.loadState()
    if (!state.disabled.includes(id)) {
      state.disabled.push(id)
      this.writeState(state)
    }
  }

  private removeDisabled(id: PluginId): void {
    const state = this.loadState()
    const next = state.disabled.filter((x) => x !== id)
    if (next.length !== state.disabled.length) {
      state.disabled = next
      this.writeState(state)
    }
  }

  private removeConfig(id: PluginId): void {
    const state = this.loadState()
    if (state.configs[id]) {
      delete state.configs[id]
      this.writeState(state)
    }
  }

  /** 直接写盘（增删禁用项/配置时用；saveState 用于全量重建） */
  private writeState(state: PluginState): void {
    try {
      fs.mkdirSync(path.dirname(this.stateFilePath()), { recursive: true })
      fs.writeFileSync(this.stateFilePath(), JSON.stringify(state, null, 2), 'utf8')
    } catch (e) {
      console.error('[plugin-host] 保存插件状态失败:', e)
    }
  }
  // ---------------------------------------------------------------------------
  // 工具方法
  // ---------------------------------------------------------------------------

  private registerBuiltinServices(): void {
    // 宿主自带两项（插件可用 inject 声明依赖它们，对齐 dsh 的 ctx.tools / ctx.shell …）；
    // 其余应用服务由 init 的 builtinServices 注入（sessionLog / jobs …）
    const builtins: Record<string, unknown> = {
      tools: toolRegistry,
      shell: shellService,
      ...this.builtin,
    }
    for (const [name, impl] of Object.entries(builtins)) {
      if (!this.services.has(name)) this.services.provide(name, impl)
    }
  }

  private requireRecord(id: string): PluginRecord {
    const rec = this.records.get(id as PluginId)
    if (!rec) throw new IPCError('PLUGIN_NOT_FOUND', `插件不存在：${id}`)
    return rec
  }

  private assertApiVersion(rec: PluginRecord): void {
    if (!rec.manifest) {
      throw new IPCError('PLUGIN_LOAD_FAILED', `插件清单不可用：${rec.error ?? '未知原因'}`)
    }
    const check = checkApiVersion(rec.manifest.apiVersion)
    if (!check.ok) throw new IPCError('API_VERSION_MISMATCH', check.reason ?? 'API 版本不匹配')
  }

  private toPluginId(dirName: string): PluginId | null {
    return isValidPluginId(dirName) ? brand(dirName, 'PluginId') : null
  }

  /** 路径必须落在 `base` 内（插件只能碰自己的目录） */
  private resolveInside(base: string, rel: string): string {
    const abs = path.resolve(base, String(rel ?? '.'))
    const relative = path.relative(base, abs)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new IPCError('INVALID_ARGUMENT', `路径越界（仅允许插件目录内）：${rel}`)
    }
    return abs
  }

  private snapshot(rec: PluginRecord): PluginSnapshot {
    return {
      id: rec.id,
      name: rec.manifest?.name ?? rec.id,
      version: rec.manifest?.version ?? '0.0.0',
      apiVersion: rec.manifest?.apiVersion ?? '',
      description: rec.manifest?.description ?? '',
      dir: rec.dir,
      relDir: rec.relDir,
      folder: this.folderOf(rec),
      status: rec.status,
      enabled: rec.enabled,
      permissions: rec.manifest?.permissions ?? [],
      inject: rec.inject,
      tools: rec.tools.slice(),
      services: rec.services.slice(),
      hasMain: !!rec.manifest?.main,
      hasClient: !!rec.manifest?.client,
      clientEntry: rec.manifest?.client?.entry ?? null,
      config: { ...rec.config },
      declaredSlots: rec.manifest?.declares?.slots ?? [],
      error: rec.error,
      loadedAt: rec.loadedAt,
    }
  }

  private pushChanged(rec: PluginRecord): void {
    this.emit({ type: 'plugin/changed', id: rec.id, snapshot: this.snapshot(rec) })
  }

  private emit(event: PluginEvent): void {
    try {
      this.eventSink?.(event)
    } catch (e) {
      console.error('[plugin-host] 事件出口异常:', e)
    }
  }
}

/**
 * 商店包里相对路径的规范化：统一分隔符、去掉前导分隔符与 `.` 段；
 * 含 `..`（越界）或为空时返回 ''，由调用方跳过 / 报错。
 */
function normalizeRel(rel: unknown): string {
  const text = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '').trim()
  if (!text) return ''
  const parts = text.split('/').filter((p) => p && p !== '.')
  if (!parts.length || parts.some((p) => p === '..')) return ''
  return parts.join('/')
}

/** 规范化插件模块导出（默认导出优先，其次具名 apply） */
function normalizePluginModule(exports: unknown): AikmPluginModule | null {
  if (!exports || typeof exports !== 'object') return null
  const anyExports = exports as Record<string, unknown>
  const candidate = (anyExports.default ?? (anyExports.apply ? anyExports : null)) as AikmPluginModule | null
  if (!candidate || typeof candidate.apply !== 'function') return null
  return candidate
}

function dedupe(list: string[]): string[] {
  return Array.from(new Set(list.filter((x) => typeof x === 'string' && x.trim() !== '')))
}

export const pluginHost = new PluginHost()
