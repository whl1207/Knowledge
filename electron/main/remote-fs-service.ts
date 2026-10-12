/**
 * remote-fs-service.ts — 局域网远程文件共享（HTTP 只读服务）
 *
 * 主机在设置 → 协作面板共享一个文件夹，客户端通过「添加远程工作区」访问：
 *   - 只读：仅提供目录列表 / 文件内容 / 下载，不提供写接口（编辑需下载到本地）
 *   - 安全：token 校验 + 路径白名单（强制限定在共享根目录内，防目录穿越）
 *   - 传输：HTTP JSON / 二进制流
 *
 * 路由（所有路径均需带 token）：
 *   GET /fs/info?token=…            → { name, rootPath, port } 共享信息
 *   GET /fs/list?path=相对路径&token=… → JSON 目录树（与 refreshMultiTree 同构：
 *                                       [{ label, path, type, children?, size?, mtime? }]）
 *   GET /fs/read?path=相对路径&token=… → 文件内容（文本原样 / 二进制 base64）
 *   GET /fs/download?path=相对路径&token=… → 原始二进制流（下载用）
 *   GET /fs/store?path=相对路径&token=…  → 商店清单（扫描出该目录下的插件 / 技能，含下载地址）
 *   GET /fs/bundle?path=相对路径&token=… → 目录打包（{ files:[{path,text|base64}] }，安装技能 / 插件用）
 *
 * 后两条让「共享目录」可以直接当插件商店 / 技能商店的来源：客户端只认 HTTP（渲染层无法用 FTP），
 * 这里复用了既有的 token、只读与目录穿越防护，不需要新协议 / 新端口。
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ipcMain, BrowserWindow } from 'electron'
import { asUint8 } from './buffer-view'

export const REMOTE_FS_DEFAULT_PORT = 3347

interface RemoteFsState {
  rootDir: string
  token: string
}

let server: Server | null = null
let serverPort = REMOTE_FS_DEFAULT_PORT
let state: RemoteFsState | null = null

// ---------------- 工具 ----------------

function getLanIPs(): string[] {
  const ips: string[] = []
  const interfaces = networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name]
    if (!iface) continue
    for (const info of iface) {
      if (info.family === 'IPv4' && !info.internal) ips.push(info.address)
    }
  }
  return ips
}

function makeToken(): string {
  return randomBytes(6).toString('hex')
}

/** 常量时间比较 token，避免时序攻击 */
function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(asUint8(ab), asUint8(bb))
}

function writeJson(res: ServerResponse, code: number, obj: unknown) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(obj))
}

/**
 * 把共享根目录内的相对路径解析为绝对路径，并校验不越界。
 * 返回 null 表示非法（目录穿越 / 不存在 / token 错误由调用方处理）。
 */
function resolveInsideRoot(rel: string): string | null {
  if (!state) return null
  const root = path.resolve(state.rootDir)
  // 去掉开头的 / 或 \，防止绝对路径注入
  const clean = String(rel || '').replace(/^[/\\]+/, '')
  const target = path.resolve(root, clean)
  const relToRoot = path.relative(root, target)
  if (relToRoot === '..' || relToRoot.startsWith('..' + path.sep) || path.isAbsolute(relToRoot)) {
    return null
  }
  return target
}

/** 返回目录树节点（与 refreshMultiTree 输出同构） */
function buildNode(abs: string): any {
  const stat = fs.statSync(abs)
  const isDir = stat.isDirectory()
  const node: any = {
    label: path.basename(abs),
    path: abs,
    type: isDir ? 'folder' : 'file',
    size: stat.isFile() ? stat.size : 0,
    mtime: Math.floor(stat.mtimeMs),
  }
  if (isDir) {
    try {
      const entries = fs.readdirSync(abs, { withFileTypes: true })
        .filter((d) => d.name !== '.git' && d.name !== 'node_modules')
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
        })
      // 子目录懒加载：仅返回一级，children 为空数组（客户端展开时再调 list）
      node.children = entries.map((d) => {
        const childAbs = path.join(abs, d.name)
        let cstat: fs.Stats | null = null
        try { cstat = fs.statSync(childAbs) } catch { /* ignore */ }
        return {
          label: d.name,
          path: childAbs,
          type: d.isDirectory() ? 'folder' : 'file',
          size: cstat?.isFile() ? cstat.size : 0,
          mtime: cstat ? Math.floor(cstat.mtimeMs) : 0,
          // 文件夹：子节点懒加载；文件：叶子
          children: d.isDirectory() ? [] : undefined,
        }
      })
    } catch {
      node.children = []
    }
  }
  return node
}

/** 读取文件：文本原样返回；二进制（图片/PDF/视频等）转 base64 */
function readFileContent(abs: string): { text?: string; base64?: string; size: number } {
  const buf = fs.readFileSync(abs)
  const isText = isLikelyText(abs)
  if (isText) {
    return { text: buf.toString('utf8'), size: buf.length }
  }
  return { base64: buf.toString('base64'), size: buf.length }
}

// ---------------------------------------------------------------------------
// 商店索引（把共享目录当作「插件商店 / 技能商店」的来源，复用同一套 token + 只读接口）
//
// 为什么不另开协议：客户端（渲染层）只认 HTTP；FTP 既没有内建的只读/白名单语义，
// 还必须新依赖 + 新端口 + 明文账号，收益只是"第三方工具也能连"。这里只加两个 GET：
//   GET /fs/store?path=<相对目录>&token=…   → 目录扫描出的商店清单（技能 + 插件）
//   GET /fs/bundle?path=<相对目录>&token=…  → 整个目录的内容（安装用，JSON + base64）
// ---------------------------------------------------------------------------

/** 商店扫描 / 打包的最大相对深度（共享根目录 = 0） */
const STORE_SCAN_DEPTH = 4
/** 目录打包上限：bundle 走 JSON（base64 会膨胀 4/3），必须设上限避免拉爆内存 */
const BUNDLE_MAX_FILE_BYTES = 8 * 1024 * 1024
const BUNDLE_MAX_TOTAL_BYTES = 32 * 1024 * 1024
const BUNDLE_MAX_FILES = 500
/** 技能 / 插件的识别特征（与「技能管理」「插件宿主」的扫描规则保持一致） */
const SKILL_FILE = 'SKILL.md'
const MANIFEST_FILE = 'package.json'
const MANIFEST_KEY = 'aikm'
const STORE_SKIP_DIRS = new Set(['node_modules', '.git', 'plugins-data'])

/** 读 SKILL.md 前几行作为描述（frontmatter 的 description 优先，其次首个非标题行） */
function skillBrief(abs: string): string {
  try {
    const head = fs.readFileSync(abs, 'utf8').slice(0, 3000)
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head)
    const desc = fm ? /^\s*description:\s*(.+)$/m.exec(fm[1])?.[1] : ''
    if (desc && desc.trim()) return desc.trim().replace(/^["']|["']$/g, '').slice(0, 300)
    for (const line of head.split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#') || t.startsWith('---') || /^[a-zA-Z_-]+:\s/.test(t)) continue
      return t.slice(0, 300)
    }
  } catch { /* 读取失败就当没有描述 */ }
  return ''
}

/** 目录是否是一个插件（有 package.json 且含 aikm 清单字段） */
function readPluginManifest(dir: string): any | null {
  const file = path.join(dir, MANIFEST_FILE)
  if (!fs.existsSync(file)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const aikm = raw && typeof raw === 'object' ? raw[MANIFEST_KEY] : null
    return aikm && typeof aikm === 'object' ? { ...aikm, __pkg: raw } : null
  } catch {
    return null
  }
}

/**
 * 扫描共享目录，生成商店清单。
 * 识别规则与本地一致：目录内有 SKILL.md = 技能；有 package.json 且含 aikm = 插件（不再向下钻）。
 * @param origin 请求来源（`http://host:port`），用于拼出下载地址，客户端可原样使用
 */
function buildStoreIndex(
  dir: string,
  relPrefix: string,
  origin: string,
  token: string,
  depth = 0,
  out: { skills: any[]; plugins: any[] } = { skills: [], plugins: [] },
): { skills: any[]; plugins: any[] } {
  const bundleUrl = (rel: string) =>
    `${origin}/fs/bundle?path=${encodeURIComponent(rel)}&token=${encodeURIComponent(token)}`
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const d of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!d.isDirectory()) continue
    if (d.name.startsWith('.') || STORE_SKIP_DIRS.has(d.name)) continue
    const childAbs = path.join(dir, d.name)
    const childRel = relPrefix ? `${relPrefix}/${d.name}` : d.name
    const manifest = readPluginManifest(childAbs)
    if (manifest) {
      out.plugins.push({
        id: String(manifest.id || d.name),
        name: String(manifest.name || manifest.id || d.name),
        version: String(manifest.version || ''),
        apiVersion: String(manifest.apiVersion || ''),
        description: String(manifest.description || ''),
        permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
        path: childRel,
        downloadUrl: bundleUrl(childRel),
      })
      continue
    }
    const skillFile = path.join(childAbs, SKILL_FILE)
    if (fs.existsSync(skillFile) && fs.statSync(skillFile).isFile()) {
      out.skills.push({
        name: d.name,
        description: skillBrief(skillFile),
        path: childRel,
        downloadUrl: bundleUrl(childRel),
      })
      continue
    }
    if (depth + 1 < STORE_SCAN_DEPTH) buildStoreIndex(childAbs, childRel, origin, token, depth + 1, out)
  }
  return out
}

/** 收集目录内所有文件（供 bundle 打包；跳过隐藏项 / 依赖目录 / 符号链接，并受大小上限约束） */
function collectBundleFiles(abs: string): Array<{ path: string; text?: string; base64?: string; size: number }> {
  const files: Array<{ path: string; text?: string; base64?: string; size: number }> = []
  let total = 0
  const walk = (dir: string, prefix: string, depth: number): void => {
    if (depth > STORE_SCAN_DEPTH || files.length >= BUNDLE_MAX_FILES || total > BUNDLE_MAX_TOTAL_BYTES) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of entries) {
      if (files.length >= BUNDLE_MAX_FILES || total > BUNDLE_MAX_TOTAL_BYTES) return
      if (d.name.startsWith('.') || STORE_SKIP_DIRS.has(d.name) || d.isSymbolicLink()) continue
      const childAbs = path.join(dir, d.name)
      const childRel = prefix ? `${prefix}/${d.name}` : d.name
      if (d.isDirectory()) {
        walk(childAbs, childRel, depth + 1)
        continue
      }
      let stat: fs.Stats
      try {
        stat = fs.statSync(childAbs)
      } catch {
        continue
      }
      if (!stat.isFile() || stat.size > BUNDLE_MAX_FILE_BYTES) continue
      total += stat.size
      files.push({ path: childRel, ...readFileContent(childAbs) })
    }
  }
  walk(abs, '', 0)
  return files
}

const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.css', '.scss', '.less',
  '.html', '.htm', '.xml', '.csv', '.tsv', '.log', '.py', '.ipynb', '.sh', '.bat',
  '.flow', '.swarm', '.kb', '.excalidraw', '.agent',
])
function isLikelyText(abs: string): boolean {
  const ext = path.extname(abs).toLowerCase()
  return TEXT_EXT.has(ext)
}

function notifyStatus() {
  const info = getRemoteFsStatus()
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) w.webContents.send('remote-fs-status', info)
  })
}

// ---------------- 请求处理 ----------------

function handleRequest(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }
  if (req.method !== 'GET') {
    writeJson(res, 405, { error: '仅支持 GET' })
    return
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const token = url.searchParams.get('token') || ''

  // token 校验（info 也需 token，避免泄露共享信息）
  if (!state || !state.token || !tokensEqual(token, state.token)) {
    writeJson(res, 403, { error: '无效的访问凭据' })
    return
  }

  const rel = url.searchParams.get('path') || ''
  const abs = resolveInsideRoot(rel)
  if (!abs) {
    writeJson(res, 400, { error: '路径无效或越界' })
    return
  }

  try {
    switch (url.pathname) {
      case '/fs/info': {
        writeJson(res, 200, {
          name: path.basename(state.rootDir),
          rootPath: state.rootDir,
          port: serverPort,
        })
        return
      }
      case '/fs/list': {
        if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
          writeJson(res, 404, { error: '目录不存在' })
          return
        }
        const tree = fs.readdirSync(abs, { withFileTypes: true })
          .filter((d) => d.name !== '.git' && d.name !== 'node_modules')
          .sort((a, b) => {
            if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
            return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
          })
          .map((d) => {
            const childAbs = path.join(abs, d.name)
            let cstat: fs.Stats | null = null
            try { cstat = fs.statSync(childAbs) } catch { /* ignore */ }
            return {
              label: d.name,
              path: childAbs,
              type: d.isDirectory() ? 'folder' : 'file',
              size: cstat?.isFile() ? cstat.size : 0,
              mtime: cstat ? Math.floor(cstat.mtimeMs) : 0,
              children: d.isDirectory() ? [] : undefined,
            }
          })
        writeJson(res, 200, { path: abs, tree })
        return
      }
      case '/fs/read': {
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          writeJson(res, 404, { error: '文件不存在' })
          return
        }
        const content = readFileContent(abs)
        writeJson(res, 200, content)
        return
      }
      case '/fs/download': {
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          writeJson(res, 404, { error: '文件不存在' })
          return
        }
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/octet-stream')
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(abs))}"`)
        res.setHeader('Cache-Control', 'no-store')
        fs.createReadStream(abs).pipe(res)
        return
      }
      case '/fs/store': {
        // 商店清单：把这个共享目录当成「插件商店 / 技能商店」来源时的索引（只读、需 token）
        if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
          writeJson(res, 404, { error: '目录不存在' })
          return
        }
        const rel = url.searchParams.get('path') || ''
        const origin = `http://${req.headers.host || `127.0.0.1:${serverPort}`}`
        const index = buildStoreIndex(abs, rel.replace(/^[/\\]+/, ''), origin, token)
        writeJson(res, 200, {
          version: 1,
          name: path.basename(state!.rootDir),
          path: rel,
          skills: index.skills,
          plugins: index.plugins,
        })
        return
      }
      case '/fs/bundle': {
        // 目录打包：安装技能 / 插件时一次性取回整个目录（文本原样，二进制 base64）
        if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
          writeJson(res, 404, { error: '目录不存在' })
          return
        }
        const files = collectBundleFiles(abs)
        if (!files.length) {
          writeJson(res, 400, { error: '目录为空或全部内容超出打包上限' })
          return
        }
        writeJson(res, 200, { path: url.searchParams.get('path') || '', files })
        return
      }
      default:
        writeJson(res, 404, { error: '未知接口' })
        return
    }
  } catch (e: any) {
    writeJson(res, 500, { error: e?.message || '服务器错误' })
  }
}

// ---------------- 生命周期 ----------------

function listenOnce(port: number): Promise<'ok' | 'busy' | 'fatal'> {
  return new Promise((resolve) => {
    let settled = false
    const s = createServer(handleRequest)
    s.on('error', (e: any) => {
      if (settled) return
      settled = true
      try { s.close() } catch { /* ignore */ }
      resolve(e?.code === 'EADDRINUSE' ? 'busy' : 'fatal')
    })
    s.listen(port, '0.0.0.0', () => {
      if (settled) return
      settled = true
      server = s
      resolve('ok')
    })
  })
}

export async function startRemoteFs(opts: {
  port?: number
  rootDir?: string
  token?: string
} = {}): Promise<{ success: boolean; port?: number; token?: string; error?: string }> {
  if (server) return { success: false, error: '远程文件服务已在运行' }
  const rootDir = opts.rootDir || ''
  if (!rootDir || !fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    return { success: false, error: '共享文件夹无效' }
  }
  const token = opts.token || makeToken()
  state = { rootDir, token }
  const base = opts.port || REMOTE_FS_DEFAULT_PORT
  for (let p = base; p <= base + 20; p++) {
    const r = await listenOnce(p)
    if (r === 'ok') {
      serverPort = p
      notifyStatus()
      return { success: true, port: p, token }
    }
    if (r === 'fatal') {
      state = null
      notifyStatus()
      return { success: false, error: '远程文件服务启动失败' }
    }
  }
  state = null
  notifyStatus()
  return { success: false, error: '远程文件服务端口被占用' }
}

export async function stopRemoteFs(): Promise<{ success: boolean }> {
  if (!server) return { success: false }
  const s = server
  server = null
  state = null
  return new Promise((resolve) => {
    try {
      s.close(() => {
        notifyStatus()
        resolve({ success: true })
      })
    } catch {
      notifyStatus()
      resolve({ success: true })
    }
  })
}

export function getRemoteFsStatus() {
  return {
    running: server !== null,
    port: serverPort,
    ips: server ? getLanIPs() : [],
    rootDir: server && state ? state.rootDir : '',
    token: server && state ? state.token : '',
    name: server && state ? path.basename(state.rootDir) : '',
  }
}

export function registerRemoteFsIpc() {
  ipcMain.handle('remoteFs:start', async (_e, payload) => startRemoteFs(payload || {}))
  ipcMain.handle('remoteFs:stop', async () => stopRemoteFs())
  ipcMain.handle('remoteFs:getStatus', async () => getRemoteFsStatus())
}

export function stopRemoteFsAll() {
  if (server) {
    try { server.close() } catch { /* ignore */ }
    server = null
    state = null
  }
}
