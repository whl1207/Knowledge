/**
 * platform/android — 安卓后端（Capacitor 壳）
 *
 * 与 Electron 后端、host 后端并列的第三种实现：**同一套渲染层与能力契约**，
 * 差别只在能力怎么落地。选型见 package.json 的 @capacitor/* 依赖与 capacitor.config.ts。
 *
 * 能力现状（务实的第一版，逐步补齐）：
 * - 文件：Capacitor Filesystem（应用文档目录为根：读写 / 列目录 / 增删改 / 移动 / 重命名）
 *   以及**用户授权目录**（SAF：`saf:` 前缀路径，见 saf.ts），两者可在同一棵文件树里共存。
 * - 语音：系统 TTS 直接朗读（见 speech.ts），不需要模型、多数机型可离线。
 * - 系统集成：用其它应用打开 / 系统分享面板（见 share.ts，FileProvider + Intent）。
 * - 长任务：前台服务 + 进度通知（LongTaskService），长任务期间保持进程存活。
 * - LLM：`llm.hosted` = none → services/ai-utils 走 shared/ai-core 直连（WebView 可直接请求模型）
 * - 窗口壳 / 快捷键 / 宿主重能力（Python、Office、表格、插件）：无原生实现 → 降级；可经 host 后端连桌面主机补齐。
 *
 * 可测性：Capacitor 插件对象是 Proxy（属性不可覆盖），因此**原生适配器经参数注入**
 * （默认取真实插件），Node 侧可用内存实现跑单元验证——见 `AndroidDeps`。
 */

import { Capacitor, SystemBars, SystemBarType } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { SAF_PREFIX, SafFolder, createSafFilesystemAdapter, isSafPath, splitSafPath, safCache, type SafFilesystemAdapter } from '@/platform/android/saf'
import { createShareAdapter } from '@/platform/android/share'
import { createSpeechApi } from '@/platform/android/speech'
import type {
  AppPort,
  BrowserAgentPort,
  CapabilityId,
  CapabilityMode,
  DialogPort,
  EventsPort,
  FileSystemPort,
  HostPort,
  LlmPort,
  PathWriteResult,
  Platform,
  PlatformCapabilities,
  ShellPort,
  TtsApi,
  WatchPort,
  WindowPort,
  TerminalPort,
} from '@/platform/contract'

/**
 * Capacitor Filesystem 的最小适配面（只声明本后端用到的方法）。
 * `directory` 对 SAF 适配器无意义，故为可选（见 src/platform/android/saf.ts）。
 */
export interface AndroidFilesystemAdapter {
  /**
   * 读文件。`encoding` 与 Capacitor Filesystem 同口径：传值（如 `utf8`）按文本返回，
   * 不传则按二进制读、返回 base64（SAF 适配器据此在原生侧选择解码方式）。
   */
  readFile(opts: { path: string; directory?: string; encoding?: string }): Promise<{ data: string | Blob }>
  writeFile(opts: { path: string; data: string; directory?: string; encoding?: string; recursive?: boolean }): Promise<unknown>
  mkdir(opts: { path: string; directory?: string; recursive?: boolean }): Promise<unknown>
  rmdir(opts: { path: string; directory?: string; recursive?: boolean }): Promise<unknown>
  deleteFile(opts: { path: string; directory?: string }): Promise<unknown>
  rename(opts: { from: string; to: string; directory?: string; toDirectory?: string }): Promise<unknown>
  copy(opts: { from: string; to: string; directory?: string; toDirectory?: string }): Promise<unknown>
  stat(opts: { path: string; directory?: string }): Promise<{ type: string; size?: number; mtime?: number }>
  readdir(opts: { path: string; directory?: string }): Promise<{ files: Array<{ name: string; type?: string; size?: number; mtime?: number }> }>
}

/** 后端依赖（默认取真实 Capacitor 实现；测试可注入内存实现） */
export interface AndroidDeps {
  filesystem?: AndroidFilesystemAdapter
  /** SAF 目录授权适配器（用户授权了文件夹时使用；未提供则只能用应用沙箱） */
  saf?: AndroidFilesystemAdapter
  /** 原生平台判定（默认 Capacitor.isNativePlatform） */
  isNative?: () => boolean
  /** SAF 文件夹选择（默认走 SafFolder 插件；未安装时 reject） */
  pickSafFolder?: () => Promise<{ name: string } | null>
  /** 语音合成（默认走 NativeSpeech 插件 = 安卓系统 TTS） */
  speech?: TtsApi
  /** 打开 / 分享适配器（默认走 ShareOpen 插件） */
  share?: ReturnType<typeof createShareAdapter>
  /** 长任务前台服务（默认走 LongTask 插件） */
  longTask?: {
    begin(payload: { title?: string; text?: string; progress?: number; indeterminate?: boolean }): Promise<{ success: boolean; error?: string }>
    update(payload: { text?: string; progress?: number; indeterminate?: boolean }): Promise<{ success: boolean }>
    end(): Promise<{ success: boolean }>
  }
  /** SAF 路径取可共享 uri（默认走 SafFolder.getUri；未授权时返回 null） */
  resolveSafUri?: (path: string) => Promise<{ uri: string; name?: string } | null>
  /** 沙箱路径取 `file://` uri（默认走 Capacitor Filesystem.getUri） */
  resolveFileUrl?: (path: string) => Promise<string | null>
  /** 系统返回手势桥（默认走 BackButton 插件） */
  backButton?: {
    setHandled(payload: { handled: boolean }): Promise<{ handled: boolean }>
    exit(): Promise<{ success: boolean }>
    addListener(eventName: 'back', listener: () => void): Promise<unknown> | unknown
  }
  /** 应用缩放实现（默认为根元素 CSS zoom；测试可注入） */
  zoom?: { get(): Promise<number>; set(factor: number): Promise<number> }
  /** 是否在创建时应用沉浸式全屏（默认 true；测试可关闭避免触碰原生插件） */
  immersive?: boolean
}

const DOCS = Directory.Documents
const ENCODING = Encoding.UTF8
/** 应用私有存储前缀（`data:plugins/a.mjs` → 应用 files 目录下的 plugins/a.mjs） */
const DATA_PREFIX = 'data:'

function defaultFilesystem(): AndroidFilesystemAdapter {
  return Filesystem as unknown as AndroidFilesystemAdapter
}

/** SAF 适配器（懒加载并复用；插件不可用时为 null） */
let safAdapterPromise: Promise<SafFilesystemAdapter | null> | null = null

function defaultSafAdapter(): Promise<SafFilesystemAdapter | null> {
  if (!safAdapterPromise) {
    safAdapterPromise = (async () => {
      try {
        const adapter = createSafFilesystemAdapter()
        // 预热授权根名：路径解析（`saf:<根名>/…`）与界面展示都依赖它
        await adapter.refreshRoot()
        return adapter
      } catch {
        return null
      }
    })()
  }
  return safAdapterPromise
}

/**
 * 构造文件适配器，按路径前缀选后端：
 * - `saf:…`    → 用户授权的文件夹（SAF 插件；见 saf.ts）
 * - `data:…`   → 应用私有存储（Capacitor `Directory.Data`，永远可读写：配置 / 插件等应用自己的文件）
 * - 其它相对路径 → 应用文档目录（Capacitor `Directory.Documents`，即公共 Documents）
 *
 * 为什么需要 `data:`：Android 11+ 的分区存储下，应用**读不到别的应用 / adb 写进公共目录的文件**
 * （EACCES）。把应用自己管理的数据（插件、模型缓存等）放私有目录，就不受这条限制；
 * 而用户从文件管理器放进去的东西，要么让用户授权目录（`saf:`），要么由应用复制进来。
 */
function makeAdapter(deps: AndroidDeps): AndroidFilesystemAdapter {
  const files = deps.filesystem || defaultFilesystem()
  const saf = async (): Promise<AndroidFilesystemAdapter> => {
    const a = deps.saf || (await defaultSafAdapter())
    if (!a) throw new Error('尚未授权文件夹（SAF 插件不可用）')
    return a
  }
  /** 私有目录里的路径（去掉 data: 前缀，换 directory） */
  const asData = <T extends { path?: string; from?: string; to?: string }>(o: T): T => {
    const strip = (p?: string) => (typeof p === 'string' && p.startsWith(DATA_PREFIX) ? p.slice(DATA_PREFIX.length) : p)
    const next: any = { ...o, directory: Directory.Data }
    if ('path' in o) next.path = strip(next.path)
    if ('from' in o) next.from = strip(next.from)
    if ('to' in o) next.to = strip(next.to)
    if ('toDirectory' in o) next.toDirectory = Directory.Data
    return next as T
  }
  const via = <T>(path: string, safCall: (a: AndroidFilesystemAdapter) => Promise<T>, dataCall: () => Promise<T>, sandboxCall: () => Promise<T>): Promise<T> => {
    if (isSafPath(path)) return saf().then(safCall)
    if (String(path || '').startsWith(DATA_PREFIX)) return dataCall()
    return sandboxCall()
  }

  return {
    readFile: (o) => via(o.path, (a) => a.readFile(o), () => files.readFile(asData(o)), () => files.readFile(o)),
    writeFile: (o) => via(o.path, (a) => a.writeFile(o), () => files.writeFile(asData(o)), () => files.writeFile(o)),
    mkdir: (o) => via(o.path, (a) => a.mkdir(o), () => files.mkdir(asData(o)), () => files.mkdir(o)),
    rmdir: (o) => via(o.path, (a) => a.rmdir(o), () => files.rmdir(asData(o)), () => files.rmdir(o)),
    deleteFile: (o) => via(o.path, (a) => a.deleteFile(o), () => files.deleteFile(asData(o)), () => files.deleteFile(o)),
    rename: (o) => via(o.from, (a) => a.rename(o), () => files.rename(asData(o)), () => files.rename(o)),
    copy: (o) => via(o.from, (a) => a.copy(o), () => files.copy(asData(o)), () => files.copy(o)),
    stat: (o) => via(o.path, (a) => a.stat(o), () => files.stat(asData(o)), () => files.stat(o)),
    readdir: (o) => via(o.path, (a) => a.readdir(o), () => files.readdir(asData(o)), () => files.readdir(o)),
  }
}

/** 是否运行在 Capacitor 原生壳（安卓） */
export function isAndroidRuntime(deps: AndroidDeps = {}): boolean {
  try {
    return deps.isNative ? deps.isNative() : !!Capacitor?.isNativePlatform?.()
  } catch {
    return false
  }
}

const READ_ERROR_PREFIX = 'Error reading file: '

/**
 * 相对路径规范化：统一 / 分隔、去掉前导斜杠与 `.` 段（Capacitor Filesystem 只接受相对路径）。
 * - 空串 / `.` / `./` 表示**应用文档目录本身**（根），返回 `''`；
 * - `..` 段直接拒绝（返回 null），避免越出应用文档目录。
 */
export function toRelativePath(path: string): string | null {
  const raw = String(path ?? '').replace(/\\/g, '/').trim()
  if (raw === '' || raw === '.' || raw === './') return ''
  const out: string[] = []
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') return null
    out.push(seg)
  }
  return out.length ? out.join('/') : ''
}

/**
 * 交给 fs 适配器的路径：
 * - `saf:` / `data:` 原样交给适配器（按前缀路由到 SAF / 私有目录）；
 * - 其余用 `toRelativePath` 归一化成 Documents 相对路径（拒绝 `..`）。
 *
 * 为什么所有路径方法都必须经过它：旧实现先 `toRelativePath` 再直连 Capacitor，
 * 于是 `saf:知识库/x` 会被当成 Documents 下的 "saf:知识库/x"，读/写/删除/改名/建目录
 * 全部落到错误位置（或直接失败）——与视频播放、drawio 打开是同一类 SAF 路径 bug。
 */
function adapterPath(path: string): string | null {
  const raw = String(path ?? '')
  if (raw === '' || raw === '.' || raw === './') return ''
  if (isSafPath(raw) || raw.startsWith(DATA_PREFIX)) return raw
  return toRelativePath(raw)
}

/** 取父目录（相对路径 / SAF 路径通用） */
function parentOf(rel: string): string {
  const idx = rel.lastIndexOf('/')
  return idx > 0 ? rel.slice(0, idx) : ''
}

function joinRel(dir: string, name: string): string {
  const d = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '')
  return d ? `${d}/${name}` : String(name)
}

function fileNameOf(p: string): string {
  return String(p).replace(/\\/g, '/').split('/').pop() || 'file'
}

function base64ToText(b64: string | Blob): string {
  if (typeof b64 !== 'string') return ''
  try {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder('utf-8').decode(bytes)
  } catch {
    return ''
  }
}

/** 字节 → base64（分块拼接：几十 MB 一次性铺进参数表会炸栈） */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)))
  }
  return btoa(bin)
}

/** 「本地服务器直读」的地址缓存（同一文件反复读时省掉 getUri 那次桥调用） */
const localServerUrlCache = new Map<string, string>()

/**
 * 取「本地服务器」URL：`http://localhost/_capacitor_file_…` / `_capacitor_content_…`。
 * `<video>` / `<audio>` 直接吃这个地址（原始 `saf:` 路径 WebView 不认识）；
 * 读字节时也走它，避免整个文件经 Capacitor 桥 base64 往返。
 */
async function localServerUrlOf(path: string, deps: AndroidDeps): Promise<string> {
  const key = String(path || '')
  if (!key) return ''
  const cached = localServerUrlCache.get(key)
  if (cached) return cached
  try {
    const convert = (Capacitor as any)?.convertFileSrc
    if (typeof convert !== 'function') return ''
    let uri = ''
    if (isSafPath(key)) {
      const r = deps.resolveSafUri ? await deps.resolveSafUri(key) : await defaultResolveSafUri(key)
      uri = r?.uri ? String(r.uri) : ''
    } else {
      const r = deps.resolveFileUrl ? await deps.resolveFileUrl(key) : await defaultResolveFileUrl(key)
      uri = r ? String(r) : ''
    }
    if (!uri) return ''
    const url = String(convert(uri))
    if (!/^https?:/i.test(url)) return ''
    if (localServerUrlCache.size > 128) localServerUrlCache.clear()
    localServerUrlCache.set(key, url)
    return url
  } catch {
    return ''
  }
}

/**
 * 经 Capacitor 本地服务器读文件字节（`http://localhost/_capacitor_file_…` / `_capacitor_content_…`）。
 *
 * 为什么必须这么做：原来的读法是**整个文件经 Capacitor 桥搬回来**——原生先 base64，再包成
 * JSON 字符串，WebView 里再 atob 解回来。33MB 的 ROM 会变成约 44MB 的字符串在桥上来回，
 * 安卓上要好几秒、还极易 OOM（「读取 ROM 很慢」主要就慢在这一步）。
 * fetch 本地服务器拿到的是二进制正文，只多一次 getUri（毫秒级、且按路径缓存）。
 *
 * 任一步失败都返回 null，调用方退回原来的桥读法（老平台 / 没装 provider / 路径拿不到 uri）。
 */
async function fetchViaLocalServer(path: string, deps: AndroidDeps): Promise<Uint8Array | null> {
  const key = String(path || '')
  if (!key) return null
  const url = await localServerUrlOf(key, deps)
  if (!url) return null
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    // html5mode：没有扩展名的路径会被回退成 index.html，那种响应不能当文件内容
    const type = res.headers.get('content-type') || ''
    if (/text\/html/i.test(type) && !/\.html?$/i.test(key)) return null
    return new Uint8Array(await res.arrayBuffer())
  } catch {
    return null
  }
}

const MIME_EXT: Array<[RegExp, string]> = [
  [/\.pdf$/i, 'application/pdf'],
  [/\.png$/i, 'image/png'],
  [/\.jpe?g$/i, 'image/jpeg'],
  [/\.gif$/i, 'image/gif'],
  [/\.webp$/i, 'image/webp'],
  [/\.svg$/i, 'image/svg+xml'],
  [/\.bmp$/i, 'image/bmp'],
]

function mimeOf(rel: string): string {
  for (const [re, mime] of MIME_EXT) if (re.test(rel)) return mime
  return 'application/octet-stream'
}

function extOf(name: string, isDir: boolean): string {
  if (isDir) return 'folder'
  return name.includes('.') ? `.${name.split('.').pop()!.toLowerCase()}` : ''
}

/** frontmatter 扁平解析（与桌面 getConfig / host 后端同口径，仅取展示用的简单字段） */
function parseFrontmatter(text: string): Record<string, unknown> {
  if (!text.startsWith('---')) return {}
  const end = text.indexOf('\n---', 4)
  if (end < 0) return {}
  const out: Record<string, unknown> = {}
  for (const line of text.slice(text.indexOf('\n') + 1, end).split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!m) continue
    const v = m[2].trim()
    out[m[1]] = /^\[.*\]$/.test(v)
      ? v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      : v.replace(/^["']|["']$/g, '')
  }
  return out
}

/** 展示用名称：SAF 根去掉 `saf:` 前缀（文件树 / 工作区列表按名称显示） */
function displayNameOf(p: string): string {
  const s = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '')
  const raw = s.startsWith(SAF_PREFIX) ? s.slice(SAF_PREFIX.length) : s
  return raw.split('/').filter(Boolean).pop() || raw || s
}

/** 目录大小 / 修改时间汇总（与桌面 getDirectoryTree 同口径：大小累加、时间取最新） */
function aggregate(nodes: any[]): { size: number; mtime: number } {
  let size = 0
  let mtime = 0
  for (const n of nodes) {
    if (typeof n?.size === 'number') size += n.size
    if (typeof n?.mtime === 'number' && n.mtime > mtime) mtime = n.mtime
  }
  return { size, mtime }
}

/**
 * 工作区根节点：桌面 refreshMultiTree 会为每个根返回一个节点（含 children），
 * 文件树与工作区列表都按「根的 path」对齐，缺了这一层会显示成「根的子项」并弄乱工作区列表。
 */
function rootNode(path: string, children: any[]): any {
  const agg = aggregate(children)
  return {
    path,
    rel: path,
    label: displayNameOf(path),
    type: 'folder',
    extension: 'folder',
    children,
    size: agg.size,
    mtime: agg.mtime,
  }
}

/** 递归构建目录树（形状与桌面 getFiles 一致） */
async function buildTree(fs: AndroidFilesystemAdapter, rel: string, depth: number): Promise<any[]> {
  if (depth <= 0) return []
  let entries: Array<{ name: string; type?: string; size?: number; mtime?: number }>
  try {
    const res = await fs.readdir({ path: rel, directory: DOCS })
    entries = res.files || []
  } catch {
    return []
  }
  const out: any[] = []
  for (const ent of entries) {
    const childRel = joinRel(rel, ent.name)
    const isDir = ent.type === 'directory'
    const node: any = {
      path: childRel,
      rel: childRel,
      label: ent.name,
      type: isDir ? 'folder' : 'file',
      extension: extOf(ent.name, isDir),
      size: isDir ? undefined : ent.size,
      // 渲染层统一按 mtime（毫秒）排序 / 显示
      mtime: ent.mtime,
    }
    if (isDir) {
      node.children = await buildTree(fs, childRel, depth - 1)
      const agg = aggregate(node.children)
      node.size = agg.size
      node.mtime = Math.max(agg.mtime, Number(ent.mtime) || 0)
    }
    out.push(node)
  }
  out.sort((a, b) => (a.type === b.type ? String(a.label).localeCompare(String(b.label)) : a.type === 'folder' ? -1 : 1))
  return out
}

function fsPortOf(fs: AndroidFilesystemAdapter, deps: AndroidDeps): FileSystemPort {
  const write = async (path: string, data: string, encoding?: string) =>
    fs.writeFile({ path, data, directory: DOCS, encoding, recursive: true })

  const port: FileSystemPort = {
    async readText(path) {
      // 先试本地服务器直读（大文本，比如 588KB 的插件入口，能省一次几十万字符的桥往返）
      const fast = await fetchViaLocalServer(path, deps)
      if (fast) return new TextDecoder('utf-8').decode(fast)
      const p = adapterPath(path)
      if (p === null) return `${READ_ERROR_PREFIX}路径非法`
      try {
        // encoding 必须传：Capacitor 不传编码时按二进制读并返回 base64
        const res = await fs.readFile({ path: p, directory: DOCS, encoding: ENCODING })
        return typeof res.data === 'string' ? res.data : base64ToText(res.data)
      } catch (e: any) {
        return `${READ_ERROR_PREFIX}${e?.message || e}`
      }
    },

    async readDataUrl(path) {
      const fast = await fetchViaLocalServer(path, deps)
      if (fast) return `data:${mimeOf(path)};base64,${bytesToBase64(fast)}`
      const p = adapterPath(path)
      if (p === null) return `${READ_ERROR_PREFIX}路径非法`
      try {
        // 不传 encoding = 二进制读，两个后端都返回 base64
        const res = await fs.readFile({ path: p, directory: DOCS })
        const b64 = typeof res.data === 'string' ? res.data : ''
        return `data:${mimeOf(p)};base64,${b64}`
      } catch (e: any) {
        return `${READ_ERROR_PREFIX}${e?.message || e}`
      }
    },

    async readBinary(path) {
      // 大文件（ROM / 存档）走本地服务器：原来的桥读法要把整个文件 base64 + JSON 搬两趟
      const fast = await fetchViaLocalServer(path, deps)
      if (fast) return fast
      const p = adapterPath(path)
      if (p === null) return null
      try {
        const res = await fs.readFile({ path: p, directory: DOCS })
        const b64 = typeof res.data === 'string' ? res.data : ''
        if (!b64) return null
        const bin = atob(b64)
        const out = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
        return out
      } catch {
        return null
      }
    },

    // 视频 / 音频播放：把 saf: / data: / 相对路径换成 WebView 能直接加载的本地服务器 URL
    async urlOf(path) {
      return localServerUrlOf(path, deps)
    },

    async saveText(path, content) {
      const p = adapterPath(path)
      if (p === null) return false
      try {
        await write(p, content, ENCODING)
        return true
      } catch {
        return false
      }
    },

    async writeText(path, content) {
      const p = adapterPath(path)
      if (p === null) return { success: false, error: '路径非法' }
      try {
        await write(p, content, ENCODING)
        return { success: true, path: p }
      } catch (e: any) {
        return { success: false, error: String(e?.message || e) }
      }
    },

    async writeBase64(path, base64) {
      const p = adapterPath(path)
      if (p === null) return false
      try {
        await write(p, stripDataUrl(base64))
        return true
      } catch {
        return false
      }
    },

    async writeBinaryBase64(path, base64) {
      const p = adapterPath(path)
      if (p === null) return { success: false, error: '路径非法' }
      try {
        await write(p, stripDataUrl(base64))
        return { success: true, path: p }
      } catch (e: any) {
        return { success: false, error: String(e?.message || e) }
      }
    },

    /** 同步写盘在 WebView 里不存在：返回 false，调用方据此提示或改走异步保存 */
    saveTextSync() {
      return false
    },

    async saveMetadata() {
      // frontmatter 随 Markdown 文本一并写入，这里不单独提供
      return false
    },

    async createFile(dirPath, fileName) {
      const p = adapterPath(joinRel(dirPath, fileName))
      if (p === null) return null
      try {
        await write(p, '', ENCODING)
        return p
      } catch {
        return null
      }
    },

    async createFolder(dirPath, folderName) {
      const p = adapterPath(joinRel(dirPath, folderName))
      if (p === null) return null
      try {
        await fs.mkdir({ path: p, directory: DOCS, recursive: true })
        return p
      } catch {
        return null
      }
    },

    async deleteFile(path) {
      const p = adapterPath(path)
      if (p === null) return false
      try {
        await fs.deleteFile({ path: p, directory: DOCS })
        return true
      } catch {
        return false
      }
    },

    async deleteFolder(path) {
      const p = adapterPath(path)
      if (p === null) return { success: false, error: '路径非法' }
      // 根目录本身（Documents 根 / 授权根 / 私有 data 根）不允许删除
      const trimmed = p.replace(/\/+$/, '')
      if (trimmed === '' || trimmed === 'saf:' || trimmed === DATA_PREFIX
        || (isSafPath(trimmed) && !trimmed.slice(SAF_PREFIX.length).includes('/'))) {
        return { success: false, error: '不允许删除根目录本身' }
      }
      try {
        await fs.rmdir({ path: p, directory: DOCS, recursive: true })
        return { success: true }
      } catch (e: any) {
        return { success: false, error: String(e?.message || e) }
      }
    },

    async copyFile(sourcePath, targetDir) {
      const srcRaw = String(sourcePath || '')
      const dstRaw = joinRel(targetDir, fileNameOf(srcRaw))
      const src = adapterPath(srcRaw)
      const dst = adapterPath(dstRaw)
      if (!src || !dst) return { success: false, error: '路径非法' }
      try {
        await fs.copy({ from: src, to: dst, directory: DOCS, toDirectory: DOCS })
        return { success: true, newPath: dstRaw }
      } catch (e: any) {
        return { success: false, error: String(e?.message || e) }
      }
    },

    async moveFile(sourcePath, targetDir) {
      const srcRaw = String(sourcePath || '')
      const dstRaw = joinRel(targetDir, fileNameOf(srcRaw))
      const src = adapterPath(srcRaw)
      const dst = adapterPath(dstRaw)
      if (!src || !dst) return { success: false, error: '路径非法' }
      try {
        await fs.rename({ from: src, to: dst, directory: DOCS, toDirectory: DOCS })
        return { success: true, newPath: dstRaw }
      } catch (e: any) {
        return { success: false, error: String(e?.message || e) }
      }
    },

    async renameFile(oldPath, newName) {
      const srcRaw = String(oldPath || '')
      if (/[\\/]/.test(String(newName))) return { success: false, error: '名称非法' }
      const dstRaw = joinRel(parentOf(srcRaw), String(newName))
      const src = adapterPath(srcRaw)
      const dst = adapterPath(dstRaw)
      if (!src || !dst) return { success: false, error: '路径非法' }
      try {
        await fs.rename({ from: src, to: dst, directory: DOCS, toDirectory: DOCS })
        return { success: true, newPath: dstRaw }
      } catch (e: any) {
        return { success: false, error: String(e?.message || e) }
      }
    },

    async ensureDir(dirPath) {
      const p = adapterPath(dirPath)
      if (p === null) return { success: false, error: '路径非法' }
      try {
        await fs.mkdir({ path: p, directory: DOCS, recursive: true })
        return { success: true }
      } catch (e: any) {
        return { success: false, error: String(e?.message || e) }
      }
    },

    async listTree(folderPath, depth) {
      const p = adapterPath(folderPath)
      if (p === null) return []
      return await buildTree(fs, p, Math.min(8, Math.max(1, Number(depth) || 3)))
    },

    /** 图谱视图用：把嵌套树摊平成 fileList + relationList（与桌面 getFilesRelation 同形状） */
    async listTreeWithRelations(folderPath, depth) {
      const nodes = await port.listTree(folderPath, depth)
      const fileList: any[] = []
      const relationList: any[] = []
      const walk = (list: any[], parent: string) => {
        for (const n of list) {
          fileList.push({ path: n.path, label: n.label, type: n.type, extension: n.extension, size: n.size })
          relationList.push({ source: parent, target: n.path })
          if (n.children?.length) walk(n.children, n.path)
        }
      }
      walk(nodes, 'root')
      return { fileList, relationList }
    },

    async getInfo(path) {
      // 不能先 toRelativePath：那会把 `saf:知识库/x.drawio` 当成应用文档目录下的相对路径，
      // stat 必然失败 → Markdown 里点 .drawio 图表时误报「目标文件不存在」。
      // 直接把原始路径交给适配器：saf: 走 SAF、data: 走私有目录、其余按 Documents 相对路径。
      const raw = String(path || '')
      if (!raw) return null
      try {
        const st = await fs.stat({ path: raw, directory: DOCS })
        const isDir = st.type === 'directory'
        const name = fileNameOf(raw)
        return { type: isDir ? 'folder' : 'file', label: name, extension: extOf(name, isDir) }
      } catch {
        return null
      }
    },

    async readMetadata(path) {
      const p = adapterPath(path)
      if (p === null) return {}
      let target = p
      try {
        const st = await fs.stat({ path: p, directory: DOCS })
        if (st.type === 'directory') target = joinRel(p, '.README.md')
      } catch {
        return {}
      }
      if (!target.toLowerCase().endsWith('.md')) return {}
      return parseFrontmatter(await port.readText(target))
    },

    async scan(folderPath, options) {
      const nodes = await port.listTree(folderPath, 8)
      const exts = (options?.extensions || []).map((e) => String(e).toLowerCase())
      const files: any[] = []
      const max = Number(options?.maxFiles) || 5000
      const walk = (list: any[]) => {
        for (const n of list) {
          if (n.type === 'folder') walk(n.children || [])
          else if (!exts.length || exts.includes(String(n.extension).toLowerCase())) {
            if (files.length < max) files.push({ path: n.path, name: n.label, size: n.size, rel: n.rel })
          }
        }
      }
      walk(nodes)
      return { success: true, files }
    },

    async searchFiles(rootPath, filterText) {
      const kw = String(filterText || '').toLowerCase().trim()
      if (!kw) return []
      const nodes = await port.listTree(rootPath, 6)
      const hits: any[] = []
      const walk = (list: any[]) => {
        for (const n of list) {
          if (n.type === 'folder') walk(n.children || [])
          else if (String(n.label).toLowerCase().includes(kw)) hits.push({ path: n.path, label: n.label, extension: n.extension, size: n.size })
        }
      }
      walk(nodes)
      return hits
    },

    async refreshTree(folderPaths, knownVersion) {
      const roots = Array.isArray(folderPaths) ? folderPaths : []
      const tree: any[] = []
      for (const rp of roots) {
        // 每个工作区返回「根节点 + 其子树」，与桌面 refreshMultiTree 形状一致
        tree.push(rootNode(rp, await port.listTree(rp, 4)))
      }
      return { success: true, unchanged: false, tree, version: (Number(knownVersion) || 0) + 1 }
    },

    async isDirectory(path) {
      const p = adapterPath(path)
      if (p === null) return false
      try {
        const st = await fs.stat({ path: p, directory: DOCS })
        return st.type === 'directory'
      } catch {
        return false
      }
    },

    /** 纯字符串运算，无需往返原生 */
    async relativePath(fromFile, toFile) {
      const norm = (p: string) => String(p || '').replace(/\\/g, '/')
      const from = norm(fromFile).split('/')
      const to = norm(toFile).split('/')
      from.pop()
      let i = 0
      while (i < from.length && i < to.length && from[i] === to[i]) i++
      const up = from.length - i
      const tail = to.slice(i)
      if (!up && !tail.length) return ''
      return [...Array(up).fill('..'), ...tail].join('/') || null
    },

    async resolveRelativePath(baseFile, relativePath) {
      const rel = String(relativePath || '').replace(/\\/g, '/')
      if (rel.startsWith('/')) return rel
      const base = String(baseFile || '').replace(/\\/g, '/').split('/')
      base.pop()
      const out: string[] = []
      for (const seg of [...base, ...rel.split('/')]) {
        if (!seg || seg === '.') continue
        if (seg === '..') out.pop()
        else out.push(seg)
      }
      return out.join('/') || null
    },

    /** 任务文件的「选择并读取」需要原生文件选择器：暂不支持（后续接 SAF） */
    async pickTaskFile() {
      return { success: false, error: 'not-supported' }
    },

    async readTaskFile(path, maxBytes) {
      const text = await port.readText(path)
      const limited = typeof maxBytes === 'number' && text.length > maxBytes
      return { success: true, content: limited ? text.slice(0, maxBytes) : text, path, partial: limited }
    },

    async saveTaskFileAs() {
      return { success: false, error: 'not-supported' }
    },

    async saveTaskFileAuto(referencePath, content) {
      const r = await port.writeText(referencePath, content)
      return r.success ? { success: true, path: r.path } : { success: false, error: r.error }
    },

    async writeTaskFile(path, content) {
      const r = await port.writeText(path, content)
      return r.success ? { success: true, path: r.path } : { success: false, error: r.error }
    },

    /** 「另存到指定路径」：沙箱与 SAF 授权目录内可直接写，超出这两处的路径会写失败（调用方提示） */
    async saveBase64(payload): Promise<PathWriteResult> {
      const r = await port.writeBinaryBase64(payload.targetPath, payload.base64)
      return r.success ? { ok: true, path: r.path } : { ok: false, error: r.error }
    },

    /**
     * 保存「远程工作区」下载的二进制内容到本地目录。
     *
     * 安卓没有桌面那样的主进程写盘：数据在前端已经是字节数组，这里直接转 base64，
     * 复用与本地写盘完全相同的适配器（`fs.writeFile`），因此：
     *  - 工作区在应用 Documents / 私有 data: 目录 → Capacitor Filesystem 写入；
     *  - 工作区是 SAF 授权目录（`saf:<根名>/…`）→ 原生 SAF 插件写入。
     * 父目录不存在时先递归创建（下载到新建子目录也能落盘）。
     */
    async saveRemoteDownload({ dir, name, data }) {
      if (!String(name || '').trim()) return { success: false, error: '文件名无效' }
      const target = joinRel(dir, name)
      const p = adapterPath(target)
      if (p === null) return { success: false, error: '路径非法' }
      if (!Array.isArray(data)) return { success: false, error: '内容无效' }
      try {
        const parent = parentOf(p)
        // `saf:` / `data:` 本身就是根：不要再对空前缀做 mkdir
        if (parent && parent !== 'saf:' && parent !== 'data:') {
          let exists = false
          try {
            const st = await fs.stat({ path: parent, directory: DOCS })
            exists = st.type === 'directory'
          } catch { /* 不存在 → 下面创建 */ }
          if (!exists) await fs.mkdir({ path: parent, directory: DOCS, recursive: true }).catch(() => undefined)
        }
        // 不传 encoding = 二进制写（两个后端都按 base64 解码后落盘）
        await write(p, bytesToBase64(new Uint8Array(data)))
        return { success: true, path: p }
      } catch (e: any) {
        return { success: false, error: String(e?.message || e) }
      }
    },

    async setDownloadDirHint() { /* 下载目录由系统/浏览器管理 */ },

    onDownloadComplete() {
      return () => {}
    },
  }

  return port
}

/** 去掉 data URL 前缀（Capacitor writeFile 接受纯 base64） */
function stripDataUrl(base64: string): string {
  const s = String(base64 || '')
  return s.includes('base64,') ? s.slice(s.indexOf('base64,') + 7) : s
}

function capabilitiesOf(): PlatformCapabilities {
  /** 应用文档目录内的文件能力可用；SAF 授权后还可访问用户选定文件夹。
   *  系统级能力（窗口壳 / 全局快捷键 / 宿主重能力）暂缺。 */
  const modes: Partial<Record<CapabilityId, CapabilityMode>> = {
    'fs.pathRead': 'local',
    'fs.pathWrite': 'local',
    /** 远程工作区下载：写入当前工作区（Documents / data: / SAF 授权目录） */
    'fs.remoteSave': 'local',
    /** 选文件夹（SAF）可用：应用据此打开用户自己的目录作为工作区 */
    'dialog.native': 'local',
    /** 用其它应用打开（Intent ACTION_VIEW，无可用应用时退化为分享面板） */
    'shell.systemOpen': 'local',
    /** 系统分享面板（ACTION_SEND） */
    'shell.share': 'local',
    /** 系统 TTS 朗读（NativeSpeech） */
    'host.tts': 'local',
    /** 长任务前台服务 + 进度通知（LongTaskService） */
    'app.longTask': 'local',
  }
  return {
    kind: 'android',
    mode(id) { return modes[id] || 'none' },
    has(id) { return (modes[id] || 'none') !== 'none' },
  }
}

/** 以下端口在安卓上暂无原生实现：一律安全降级（调用方已有兜底分支） */
const watchPort: WatchPort = {
  onChange() { return () => {} },
  async acquire() { /* 无目录监听（需原生插件或轮询） */ },
  async release() { /* 同上 */ },
  async watchFile() { return { success: false, error: 'not-supported' } },
  async unwatchFile() { return { success: false, error: 'not-supported' } },
}

const dialogPort: DialogPort = {
  async pickDirectory() { return null },
  async pickFile() { return null },
  async pickFiles() { return [] },
  async saveFile() { return null },
  async pickTextFile() { return { content: null, filePath: null } },
}

/**
 * 对话框端口：安卓上只有「选文件夹」有意义 —— 走 SAF 系统界面，
 * 返回 `saf:<授权文件夹名>`，应用据此把它当作工作区根（文件树随后按 SAF 路径读写）。
 */
function makeDialogPort(deps: AndroidDeps): DialogPort {
  return {
    async pickDirectory() {
      try {
        const pick = deps.pickSafFolder || defaultPickSafFolder
        const res = await pick()
        if (!res?.name) return null
        return `${SAF_PREFIX}${res.name}`
      } catch {
        // 未安装插件 / 用户取消 / 提供方不支持：按「取消」处理，界面已有兜底
        return null
      }
    },
    async pickFile() { return null },
    async pickFiles() { return [] },
    async saveFile() { return null },
    async pickTextFile() { return { content: null, filePath: null } },
  }
}

/** 默认的 SAF 选择实现（用文件顶部同一个静态导入；本文件只在安卓后端被加载，不需要再动态引入） */
async function defaultPickSafFolder(): Promise<{ name: string } | null> {
  const res = await SafFolder.pickFolder()
  safCache.rootName = res?.name || ''
  // 新选的授权根立刻进清单：多授权根下每个 `saf:<名字>/…` 都按名字路由，界面提示也看这份清单
  const name = safCache.rootName
  if (name && safCache.rootNames.indexOf(name) < 0) safCache.rootNames = safCache.rootNames.concat([name])
  return res?.name ? { name: res.name } : null
}

/** 窗口壳：安卓由系统手势 / 返回键管理，应用内窗口按钮不适用；全屏 = 沉浸式（隐藏系统状态栏） */
function makeWindowPort(deps: AndroidDeps): WindowPort {
  const zoom = deps.zoom || defaultZoom()
  return {
    async minimize() { /* 无窗口壳 */ },
    async toggleMaximize() { /* 全屏由系统控制 */ },
    async close() { /* 返回键由系统处理 */ },
    async toggleFullscreen() {
      immersivePreferred = !immersivePreferred
      await applyImmersive(immersivePreferred)
      return immersivePreferred
    },
    getZoom: () => zoom.get(),
    setZoom: (factor) => zoom.set(factor),
    async restartApp() { /* 由系统重启 */ },
    async openFileWindow() { /* 单窗口，调用方应改为当前视图内打开 */ },
    async openPluginPanelWindow() { return false /* 单窗口，调用方退回应用内浮层 */ },
    async toggleDevTools() { /* 无 */ },
  }
}

/**
 * 应用缩放（网页 / 安卓的「窗口缩放」实现）。
 *
 * 桌面由 Electron 主进程改 webContents.zoomFactor；没有主进程时用 CSS `zoom` 缩放根元素：
 * Chromium 的 CSS zoom 与页面缩放一样会重排布局（不是 transform 那种只放大不改布局），
 * 弹层挂在 body 上也会一起缩放，因此界面比例与桌面保持一致。
 *
 * ⚠️ 为什么不用 WebView 自带的缩放 API（`WebSettings.setInitialScale` / `setTextZoom`）：
 * 它们都是**视觉缩放**（等价于双指捏合），布局宽度仍按 `width=device-width` 走，
 * 于是页面只是被放大、右侧 / 下边溢出要横向拖动，而不是像桌面 zoomFactor 那样**重排**；
 * `setTextZoom` 更是只放大文字。WebView 里能真正「重排式缩放」的只有 CSS zoom。
 * 代价是根元素带 zoom 时**后代里的视口单位会被再乘一次 zoom**（100vh → 120vh）——
 * 所以这里同时写一个 `--ui-zoom` 变量，各处写死的 `NNvh / NNvw` 统一用
 * `calc(NNvh / var(--ui-zoom, 1))` 折算（见 src/style.css 顶部注释）。
 */
function defaultZoom(): { get(): Promise<number>; set(factor: number): Promise<number> } {
  const clamp = (f: number) => {
    const n = Number(f)
    if (!Number.isFinite(n) || n <= 0) return 1
    return Math.min(2, Math.max(0.5, n))
  }
  const apply = (factor: number) => {
    try {
      const root = document.documentElement
      if (!root) return
      if (factor === 1) {
        root.style.removeProperty('zoom')
        root.style.removeProperty('--ui-zoom')
        return
      }
      root.style.setProperty('zoom', String(factor))
      // 供 CSS 折算视口单位：根元素带 zoom 时 `100vh` 实际是 `100vh × zoom`，
      // 所以各处写死的 `NNvh / NNvw` 统一写 `calc(NNvh / var(--ui-zoom, 1))`（见 style.css 顶部注释）
      root.style.setProperty('--ui-zoom', String(factor))
    } catch {
      /* 非 DOM 环境（自检）忽略 */
    }
  }
  return {
    async get() {
      try {
        const raw = document.documentElement?.style.getPropertyValue('zoom')
        const n = Number(raw)
        return Number.isFinite(n) && n > 0 ? n : 1
      } catch {
        return 1
      }
    },
    async set(factor) {
      const f = clamp(factor)
      apply(f)
      return f
    },
  }
}

/**
 * 沉浸式全屏：隐藏系统状态栏（应用自带顶栏，重复的系统栏只会侵占空间）。
 * 用 Capacitor 内置的 SystemBars 插件（无需额外依赖）；失败时静默忽略，
 * 界面只是多一条系统状态栏，不影响功能。
 */
let immersivePreferred = true

async function applyImmersive(hidden: boolean): Promise<boolean> {
  try {
    const bar = SystemBarType.StatusBar
    if (hidden) await SystemBars.hide({ bar })
    else await SystemBars.show({ bar })
    return hidden
  } catch {
    return false
  }
}

/**
 * 沉浸式保持器：系统状态栏会在很多时机被系统重新显示 —— 软键盘收起 / 权限或选择器弹窗 /
 * 切到后台再回来 / Activity 重建。只在启动时 hide 一次不够，用户看到的就是「状态栏一旦出现
 * 就再也消不掉」。
 *
 * 这里在 focus / visibilitychange / Capacitor resume 时重新隐藏（用户主动用
 * `window.toggleFullscreen` 关掉沉浸式后 `immersivePreferred=false`，不会被强行改回去），
 * 并在启动后补几次：首次调用常常早于 Activity / WebView 就绪，hide 会静默失败。
 */
let immersiveKeeperInstalled = false
function keepImmersive(): void {
  if (immersiveKeeperInstalled || typeof window === 'undefined') return
  immersiveKeeperInstalled = true
  let lastApply = 0
  const reapply = () => {
    if (!immersivePreferred) return
    const now = Date.now()
    // 合并 focus / visibility / resume 的连环触发（同一次回到前台只 hide 一次）
    if (now - lastApply < 250) return
    lastApply = now
    void applyImmersive(true)
  }
  window.addEventListener('focus', reapply)
  // 软键盘弹出 / 收起、旋转都会触发 resize，系统常在这时把状态栏放回来。
  // 收起动画结束时可能还会再放一次，所以延迟补一刀（reapply 自身有 250ms 合并窗口）。
  let resizeTimer: ReturnType<typeof setTimeout> | null = null
  window.addEventListener('resize', () => {
    reapply()
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(reapply, 500)
  })
  window.addEventListener('orientationchange', reapply)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) reapply() })
  document.addEventListener('resume', reapply as EventListener)
  document.addEventListener('deviceready', reapply as EventListener)
  // 首屏 Activity / WebView 尚未就绪时 hide 会失败：补几次，覆盖冷启动窗口
  for (const ms of [200, 600, 1500, 3000]) setTimeout(reapply, ms)
}

/** 默认的「路径 → 可共享 uri」解析（saf: 走 SAF document uri，其余走 Capacitor 的 file:// uri） */
async function defaultResolveSafUri(path: string): Promise<{ uri: string; name?: string } | null> {
  try {
    // 授权根名决定「saf:<根名>/…」怎么剥前缀（未预热时先问一次原生侧）
    if (!safCache.rootName) await createSafFilesystemAdapter().refreshRoot().catch(() => {})
    const rel = splitSafPath(path).rel
    const r = await SafFolder.getUri({ path: rel })
    return r?.uri ? { uri: String(r.uri), name: String(r.name || '') } : null
  } catch {
    return null
  }
}

async function defaultResolveFileUrl(path: string): Promise<string | null> {
  try {
    const p = String(path || '')
    const isData = p.startsWith(DATA_PREFIX)
    const rel = toRelativePath(isData ? p.slice(DATA_PREFIX.length) : p)
    if (rel === null) return null
    const r: any = await (Filesystem as any).getUri({ path: rel, directory: isData ? Directory.Data : DOCS })
    return r?.uri ? String(r.uri) : null
  } catch {
    return null
  }
}

/**
 * 把应用内路径解析成分享插件能吃下的参数：
 * `saf:` → content:// document uri；沙箱相对路径 → file://（原生侧经 FileProvider 转 content://）。
 */
async function sharePayloadOf(deps: AndroidDeps, path: string, opts?: { title?: string; mime?: string }) {
  const p = String(path || '')
  const base = { mime: opts?.mime, title: opts?.title }
  if (isSafPath(p)) {
    const resolved = deps.resolveSafUri ? await deps.resolveSafUri(p) : await defaultResolveSafUri(p)
    if (resolved?.uri) return { ...base, uri: resolved.uri }
    return null
  }
  const url = deps.resolveFileUrl ? await deps.resolveFileUrl(p) : await defaultResolveFileUrl(p)
  if (url) return { ...base, fileUrl: url }
  return null
}

/** 系统集成：用其它应用打开（ACTION_VIEW，无可用应用时原生侧退化为分享面板）、系统分享面板 */
function makeShellPort(deps: AndroidDeps): ShellPort {
  const shareAdapter = deps.share || createShareAdapter()
  return {
    async openWithSystemApp(path) {
      const payload = await sharePayloadOf(deps, path)
      if (!payload) return { success: false, error: '文件不存在或无法共享' }
      return await shareAdapter.open(payload)
    },
    /** 安卓没有「在文件管理器中定位」的通用接口 */
    async revealInFolder() { return false },
    async openByApp() { /* 历史通道：新代码请用 openWithSystemApp */ },
    async registerShortcut() { return { success: false, error: 'not-supported' } },
    async unregisterShortcut() { /* 无 */ },
    async injectSystemText() { return { success: false, error: 'not-supported' } },
    async systemDictationStatus() { return { supported: false, error: 'not-supported' } },
    async setAsrHoldMode() { return { success: false, supported: false, error: 'not-supported' } },
    async share(path, opts) {
      const payload = await sharePayloadOf(deps, path, opts)
      if (!payload) return { success: false, error: '文件不存在或无法共享' }
      return await shareAdapter.share(payload)
    },
  }
}

/** 长任务前台服务（默认走 LongTask 插件；插件缺失时静默降级为空操作） */
function makeLongTaskApi(deps: AndroidDeps) {
  const call = async (
    action: 'begin' | 'update' | 'end',
    payload?: { title?: string; text?: string; progress?: number; indeterminate?: boolean },
  ): Promise<{ success: boolean; error?: string }> => {
    if (deps.longTask) {
      if (action === 'begin') return await deps.longTask.begin(payload || {})
      if (action === 'update') return await deps.longTask.update(payload || {})
      return await deps.longTask.end()
    }
    try {
      const { LongTask } = await import('@/platform/android/tasks')
      if (action === 'begin') return await LongTask.begin(payload || {})
      if (action === 'update') return await LongTask.update(payload || {})
      return await LongTask.end()
    } catch {
      return { success: false, error: 'not-supported' }
    }
  }
  return {
    begin: (payload: { title?: string; text?: string; progress?: number; indeterminate?: boolean }) => call('begin', payload),
    update: (payload: { text?: string; progress?: number; indeterminate?: boolean }) => call('update', payload),
    end: () => call('end'),
  }
}

/**
 * 系统返回手势 / 返回键（BackButton 插件）。
 *
 * 与「长任务」同一套注入式写法：原生插件缺失（旧包 / 测试环境）时静默降级为
 * 「无人接管」，返回手势仍走系统默认（结束应用）。
 */
function makeBackApi(deps: AndroidDeps) {
  const listeners = new Set<() => boolean | Promise<boolean>>()
  let wired = false
  let wiring: Promise<void> | null = null

  const plugin = async () => deps.backButton || (await import('@/platform/android/back')).BackButton

  /** 有监听者时才通知原生「由渲染层接管返回」 */
  const wire = async (): Promise<void> => {
    if (wired || !listeners.size) return
    if (!wiring) {
      wiring = (async () => {
        const p = await plugin()
        await p.setHandled({ handled: true })
        await p.addListener('back', () => { void dispatch() })
        wired = true
      })().catch(() => { /* 插件缺失：返回手势继续走系统默认 */ })
    }
    await wiring
  }

  /** 依次问每个监听者是否处理；都没处理则交回系统（结束应用） */
  const dispatch = async (): Promise<void> => {
    let handled = false
    for (const cb of [...listeners]) {
      try {
        if (await cb()) handled = true
      } catch {
        /* 单个监听者出错不影响其它监听者 */
      }
    }
    if (handled) return
    try {
      const p = await plugin()
      await p.setHandled({ handled: false })
      await p.exit()
    } catch {
      /* 交回原生默认（退回系统行为） */
    }
  }

  return {
    onBackPressed(cb: () => boolean | Promise<boolean>): () => void {
      listeners.add(cb)
      void wire()
      return () => { listeners.delete(cb) }
    },
  }
}

/** 系统集成与长任务（依赖可注入，便于 Node 侧自检） */
function makeAppPort(deps: AndroidDeps): AppPort {
  const longTask = makeLongTaskApi(deps)
  const back = makeBackApi(deps)
  return {
    async getBehavior() { return { closeToTray: false } },
    async setBehavior() { return { closeToTray: false } },
    async getFileAssocState() { return { ok: false, error: { message: 'not-supported' } } },
    async setFileAssoc() { return { ok: false, error: { message: 'not-supported' } } },
    async dataDirPath() { return { success: false, path: '', error: 'not-supported' } },
    async openDataDir() { return { success: false, path: '', error: 'not-supported' } },
    async cleanUserdataCache() { return { ok: false, error: 'not-supported' } },
    async userdataCacheInfo() { return { ok: false, bytes: 0 } },
    async isSettingsWindowOpen() { return false },
    async notifyUiReady() { /* 无宿主握手 */ },
    async notifyFileChanged() { /* 单窗口 */ },
    async beginLongTask(payload) {
      const r = await longTask.begin(payload || {})
      return r.success ? { success: true } : { success: false, error: r.error }
    },
    async updateLongTask(payload) {
      return { success: (await longTask.update(payload || {})).success }
    },
    async endLongTask() {
      return { success: (await longTask.end()).success }
    },
    onBackPressed: (cb) => back.onBackPressed(cb),
  }
}

const eventsPort: EventsPort = {
  on() { return () => {} },
  emit() { /* 无多窗口广播 */ },
}

/** 宿主重能力：安卓上要么原生实现（后续），要么经 host 后端连桌面主机 */
const hostPort: HostPort = {
  lan: {
    async getGuest() { return { policy: null, info: null } },
    async setGuest() { return { success: false } },
    async setKbDir() { return { success: false } },
    async setEmbed() { return { success: false } },
    async getServerInfo() { return null },
    async startServer() { return { success: false, error: 'not-supported' } },
    async stopServer() { return { success: false, error: 'not-supported' } },
  },
  mcp: {
    async info() { return null },
    async setEnabled() { return null },
  },
  python: {
    async execute() { return { success: false, error: 'not-supported' } },
    async checkInstallation() { return { ok: false, error: 'not-supported' } },
  },
  docs: {
    async docxToMarkdown() { return { error: 'not-supported' } },
    async exportPdf() { return { success: false, error: 'not-supported' } },
    async printSlidesPdf() { return { success: false, error: 'not-supported' } },
  },
  table: {
    async start() { return { success: false, error: 'not-supported' } },
    async chunk() { return { success: false, error: 'not-supported' } },
    async done() { return { success: false } },
  },
  excel: {
    async start() { return { success: false, error: 'not-supported' } },
    async chunk() { return { success: false, error: 'not-supported' } },
    async done() { return { success: false, error: 'not-supported' } },
    async abort() { return { success: false } },
  },
  skills: {
    async list() { return [] },
  },
  web: {
    async fetchTitle() { return '' },
  },
  /** 系统 TTS（安卓自带引擎，无需模型；合成 WAV 由桌面承担） */
  tts: createSpeechApi(),
}

/** 安卓直连模型：`llm.hosted` 为 none → services/ai-utils 走 shared/ai-core 直连 */
const llmPort: LlmPort = {
  async start() { return { success: false, error: 'not-supported' } },
  async abort() { return { success: false } },
  async get() { return null },
  async release() { return { success: false } },
  async contextWindow() { return null },
  async contextWindowDetail() { return null },
  async lmstudioModels() { return { models: [] } },
  async lmstudioCli() { return { ok: false, available: false, models: [] } },
  async ollamaModels() { return { models: [] } },
  async ollamaModelAction() { return { success: false } },
  async check() { return { success: false } },
  onEvent() { return () => {} },
}

const browserAgentPort: BrowserAgentPort = {
  async call() { throw new Error('not-supported') },
}

/** 安卓没有可用的 PTY（也没有 node-pty）：终端标签按能力隐藏 */
const terminalPort: TerminalPort = {
  async call() { return { ok: false, error: 'not-supported' } },
}

/** 构造安卓后端（依赖可注入，默认使用真实 Capacitor 插件 / SAF 插件） */
export function createAndroidPlatform(deps: AndroidDeps = {}): Platform {
  const fs = makeAdapter(deps)
  const host = deps.speech ? { ...hostPort, tts: deps.speech } : hostPort
  // 沉浸式全屏：应用自带顶栏，隐藏系统状态栏（可用 window.toggleFullscreen 切回来）
  // keepImmersive 负责在系统重新显示状态栏后（键盘收起 / 回到前台 / Activity 重建）再隐藏。
  if (deps.immersive !== false) {
    void applyImmersive(true)
    keepImmersive()
  }
  return {
    kind: 'android',
    capabilities: capabilitiesOf(),
    fs: fsPortOf(fs, deps),
    watch: watchPort,
    dialog: makeDialogPort(deps),
    window: makeWindowPort(deps),
    shell: makeShellPort(deps),
    app: makeAppPort(deps),
    events: eventsPort,
    host,
    llm: llmPort,
    browserAgent: browserAgentPort,
    terminal: terminalPort,
  }
}
