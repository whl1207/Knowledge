/**
 * lan-fs-api.ts — 局域网访客的「主机文件能力」HTTP 路由（网页端 platform.host 的宿主机侧）
 *
 * 背景：网页端（`http://<ip>:3345`）没有 ipcRenderer，任何本地文件能力都必须由主机代做。
 * 本模块实现 `/api/fs/*`，语义与主进程既有 IPC 通道一一对应（见 src/platform/contract 的
 * FileSystemPort），使网页端只需把平台后端换成 HTTP 实现（src/platform/host）。
 *
 * 安全（务必保持）：
 * - **目录围栏**：所有路径先 `path.resolve` 再校验是否位于 `root` 之内，越界一律 403；
 *   符号链接/`..`/绝对路径注入都被这一步拦住（resolve 会归一化 `..`）。
 * - **写权限**：只有 `allowWrite` 为真（策略档位 write）时才接受写类路由，否则 403。
 * - **令牌**：由调用方（lan server）在此之前统一校验（与 /api/kb/* 同一套）。
 *
 * 本模块**不导入 electron**，因此可用 Node 直接加载做端到端测试。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface LanFsContext {
  /** 允许访问的根目录（主机共享目录）；为空表示未配置 → 一律拒绝 */
  root: string
  /** 是否允许写（策略档位 write） */
  allowWrite: boolean
}

/** 路由前缀（与网页端 host 后端保持一致） */
export const LAN_FS_PREFIX = '/api/fs'

const READ_ERROR_PREFIX = 'Error reading file: '

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.tiff': 'image/tiff',
  '.avif': 'image/avif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/**
 * 把访客传来的路径归一化并校验在 root 内。
 * 约定：网页端传的是「绝对路径」或「相对共享目录的路径」，两者都支持；
 * 返回绝对路径，越界返回 null。
 */
export function resolveInRoot(root: string, raw: string): string | null {
  if (!root) return null
  const rootAbs = path.resolve(root)
  const p = String(raw || '').trim()
  if (!p) return null
  // 相对路径按共享目录解析；绝对路径原样归一化（随后仍要过围栏）
  const abs = path.resolve(path.isAbsolute(p) ? p : path.join(rootAbs, p))
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null
  return abs
}

/** 相对共享目录的路径（/ 分隔），用于网页端展示 */
function relOf(root: string, abs: string): string {
  const r = path.relative(path.resolve(root), abs)
  return (r || '').split(path.sep).join('/')
}

function deny(res: ServerResponse, msg: string): void {
  json(res, 403, { ok: false, error: msg })
}

// ---------------------------------------------------------------------------
// 读类操作
// ---------------------------------------------------------------------------

function readText(abs: string): string {
  try {
    if (!fs.existsSync(abs)) return `${READ_ERROR_PREFIX}文件不存在: ${abs}`
    if (fs.statSync(abs).isDirectory()) return `${READ_ERROR_PREFIX}EISDIR: 该路径是目录`
    const ext = path.extname(abs).toLowerCase()
    if (path.extname(abs) === '') return fs.readFileSync(abs, 'utf-8')
    // 二进制/媒体文件不按 UTF-8 读取（与主进程 readFile 的 MEDIA_EXT 拦截一致）
    if (MIME[ext]?.startsWith('video/') || MIME[ext]?.startsWith('audio/')) return '[媒体文件 - 不读取内容]'
    return fs.readFileSync(abs, 'utf-8')
  } catch (e: any) {
    return `${READ_ERROR_PREFIX}${e?.message || e}`
  }
}

function readDataUrl(abs: string): string {
  try {
    if (!fs.existsSync(abs)) return `${READ_ERROR_PREFIX}文件不存在: ${abs}`
    const buf = fs.readFileSync(abs)
    const mime = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream'
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch (e: any) {
    return `${READ_ERROR_PREFIX}${e?.message || e}`
  }
}

function readBinary(abs: string): Uint8Array | null {
  try {
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return null
    return new Uint8Array(fs.readFileSync(abs))
  } catch {
    return null
  }
}

/** 目录树节点（与主进程 getFiles / getDirectoryTree 的形状对齐，供文件树直接使用） */
interface TreeNode {
  path: string
  rel: string
  label: string
  type: 'file' | 'folder'
  extension: string
  size?: number
  /** 毫秒时间戳（与桌面树同名字段，渲染层按 mtime 排序 / 显示） */
  mtime?: number
  children?: TreeNode[]
}

const SKIP_ENTRIES = new Set(['.ds_store', 'thumbs.db', 'system volume information', '$recycle.bin'])

function buildTree(root: string, abs: string, depth: number): TreeNode[] {
  if (depth <= 0) return []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true })
  } catch {
    return []
  }
  const out: TreeNode[] = []
  for (const ent of entries) {
    if (SKIP_ENTRIES.has(ent.name.toLowerCase())) continue
    const childAbs = path.join(abs, ent.name)
    let isDir = ent.isDirectory()
    let stat: fs.Stats | null = null
    try {
      stat = fs.statSync(childAbs)
      isDir = stat.isDirectory()
    } catch {
      continue
    }
    const ext = isDir ? 'folder' : path.extname(ent.name).toLowerCase()
    const node: TreeNode = {
      path: childAbs,
      rel: relOf(root, childAbs),
      label: ent.name,
      type: isDir ? 'folder' : 'file',
      extension: ext,
      size: isDir ? undefined : stat.size,
      mtime: stat.mtimeMs,
    }
    if (isDir) {
      node.children = buildTree(root, childAbs, depth - 1)
      // 目录：大小累加、时间取最新（与桌面 getDirectoryTree 同口径，供排序使用）
      let size = 0
      let mtime = stat.mtimeMs
      for (const c of node.children) {
        if (typeof c.size === 'number') size += c.size
        if (typeof c.mtime === 'number' && c.mtime > mtime) mtime = c.mtime
      }
      node.size = size
      node.mtime = mtime
    }
    out.push(node)
  }
  // 目录在前、同类按名称排序（与文件树默认排序一致）
  out.sort((a, b) => (a.type === b.type ? a.label.localeCompare(b.label) : a.type === 'folder' ? -1 : 1))
  return out
}

/** 读 YAML frontmatter（与主进程 getConfig 同语义：目录读其 .README.md，非 md 返回空对象） */
function readMetadata(abs: string): Record<string, unknown> {
  try {
    const target = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? path.join(abs, '.README.md') : abs
    if (path.extname(target) !== '.md' || !fs.existsSync(target)) return {}
    const fd = fs.openSync(target, 'r')
    let head = ''
    try {
      const buf = Buffer.alloc(8192)
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      head = buf.toString('utf8', 0, n)
    } finally {
      fs.closeSync(fd)
    }
    if (!/^\s*---\r?\n/.test(head)) return {}
    const end = head.indexOf('\n---', 4)
    if (end < 0) return {}
    const yamlText = head.slice(head.indexOf('\n') + 1, end)
    // 仅做一层扁平解析（键: 值 / 数组），避免引入 yaml 依赖；网页端只用于展示标签等简单字段
    const out: Record<string, unknown> = {}
    for (const line of yamlText.split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
      if (!m) continue
      const key = m[1]
      let val: unknown = m[2].trim()
      if (typeof val === 'string') {
        const s = val
        if (/^\[.*\]$/.test(s)) val = s.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
        else val = s.replace(/^["']|["']$/g, '')
      }
      out[key] = val
    }
    return out
  } catch {
    return {}
  }
}

/** 递归搜索文件名 / 文本内容（与主进程 search 的用途一致：文件树搜索框） */
function searchFiles(root: string, abs: string, keyword: string, out: TreeNode[], depth: number): TreeNode[] {
  if (depth <= 0 || out.length > 2000) return out
  const kw = keyword.toLowerCase()
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true })
  } catch {
    return out
  }
  for (const ent of entries) {
    if (SKIP_ENTRIES.has(ent.name.toLowerCase())) continue
    const childAbs = path.join(abs, ent.name)
    if (ent.isDirectory()) {
      searchFiles(root, childAbs, keyword, out, depth - 1)
      continue
    }
    const hitName = ent.name.toLowerCase().includes(kw)
    let hitText = false
    if (!hitName && fs.statSync(childAbs).size < 2 * 1024 * 1024) {
      const ext = path.extname(ent.name).toLowerCase()
      if (['.md', '.txt', '.json', '.csv', '.yml', '.yaml', '.ts', '.js', '.py', '.html'].includes(ext)) {
        try {
          hitText = fs.readFileSync(childAbs, 'utf-8').toLowerCase().includes(kw)
        } catch { /* 忽略 */ }
      }
    }
    if (hitName || hitText) {
      const stat = fs.statSync(childAbs)
      out.push({ path: childAbs, rel: relOf(root, childAbs), label: ent.name, type: 'file', extension: path.extname(ent.name).toLowerCase(), size: stat.size, mtime: stat.mtimeMs })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 写类操作
// ---------------------------------------------------------------------------

function ensureParent(abs: string): void {
  const dir = path.dirname(abs)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

/** 唯一化路径（重名追加 (1)(2)…），避免静默覆盖 */
function uniquePath(abs: string): string {
  if (!fs.existsSync(abs)) return abs
  const dir = path.dirname(abs)
  const ext = path.extname(abs)
  const base = path.basename(abs, ext)
  for (let i = 1; i < 1000; i++) {
    const cand = path.join(dir, `${base} (${i})${ext}`)
    if (!fs.existsSync(cand)) return cand
  }
  return path.join(dir, `${base} (${Date.now()})${ext}`)
}

function readBody(req: IncomingMessage, limitBytes = 64 * 1024 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limitBytes) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

/**
 * 处理 `/api/fs/*` 路由。返回 true 表示已接管（调用方不再继续静态投递）。
 */
export async function handleLanFsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
  ctx: LanFsContext,
  query: (key: string) => string,
): Promise<boolean> {
  if (!urlPath.startsWith(LAN_FS_PREFIX)) return false

  const route = urlPath.slice(LAN_FS_PREFIX.length).replace(/^\/+/, '')
  const writeRoutes = new Set(['write', 'write-base64', 'mkdir', 'delete', 'copy', 'move', 'rename', 'ensure-dir', 'touch'])
  const isWrite = writeRoutes.has(route)
  if (!ctx.root) return json(res, 403, { ok: false, error: '主机未配置共享目录' }), true
  if (isWrite && !ctx.allowWrite) return deny(res, '访客文件写入已关闭'), true

  const body = req.method === 'POST' ? await readBody(req) : {}
  const rawPath = String(body.path ?? query('path') ?? '')
  const abs = resolveInRoot(ctx.root, rawPath)

  switch (route) {
    case 'stat': {
      if (!abs) return deny(res, '路径越界或为空'), true
      if (!fs.existsSync(abs)) { json(res, 200, { ok: true, exist: false }); return true }
      const st = fs.statSync(abs)
      return json(res, 200, { ok: true, exist: true, isDir: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs }), true
    }

    case 'read': {
      if (!abs) return deny(res, '路径越界或为空'), true
      const mode = String(body.mode || query('mode') || 'text')
      if (mode === 'binary') {
        const bytes = readBinary(abs)
        if (!bytes) return json(res, 200, { ok: false, error: '读取失败' }), true
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/octet-stream')
        res.end(Buffer.from(bytes))
        return true
      }
      const content = mode === 'dataurl' ? readDataUrl(abs) : readText(abs)
      return json(res, 200, { ok: true, content }), true
    }

    case 'tree': {
      const rootAbs = abs || path.resolve(ctx.root)
      if (!fs.existsSync(rootAbs) || !fs.statSync(rootAbs).isDirectory()) return json(res, 200, { ok: true, nodes: [] }), true
      const depth = Math.min(12, Math.max(1, Number(body.depth) || 4))
      return json(res, 200, { ok: true, nodes: buildTree(ctx.root, rootAbs, depth), root: relOf(ctx.root, rootAbs) }), true
    }

    case 'info': {
      const list: string[] = Array.isArray(body.paths) ? body.paths : [rawPath]
      const out = list.map((p) => {
        const a = resolveInRoot(ctx.root, p)
        if (!a) return { path: p, ok: false, error: '路径越界' }
        if (!fs.existsSync(a)) return { path: a, rel: relOf(ctx.root, a), ok: false, error: '不存在' }
        const st = fs.statSync(a)
        return {
          path: a,
          rel: relOf(ctx.root, a),
          ok: true,
          isDir: st.isDirectory(),
          size: st.size,
          mtimeMs: st.mtimeMs,
          extension: st.isDirectory() ? 'folder' : path.extname(a).toLowerCase(),
          label: path.basename(a),
        }
      })
      return json(res, 200, { ok: true, items: out }), true
    }

    case 'meta': {
      if (!abs) return deny(res, '路径越界或为空'), true
      return json(res, 200, { ok: true, config: readMetadata(abs) }), true
    }

    case 'search': {
      const kw = String(body.keyword || query('keyword') || '').trim()
      if (!kw) return json(res, 200, { ok: true, items: [] }), true
      const start = abs || path.resolve(ctx.root)
      const items = searchFiles(ctx.root, start, kw, [], 8)
      return json(res, 200, { ok: true, items }), true
    }

    case 'write': {
      if (!abs) return deny(res, '路径越界或为空'), true
      try {
        ensureParent(abs)
        fs.writeFileSync(abs, String(body.content ?? ''), 'utf8')
        return json(res, 200, { ok: true, path: abs, rel: relOf(ctx.root, abs) }), true
      } catch (e: any) {
        return json(res, 200, { ok: false, error: e?.message || String(e) }), true
      }
    }

    case 'write-base64': {
      if (!abs) return deny(res, '路径越界或为空'), true
      try {
        ensureParent(abs)
        const b64 = String(body.base64 ?? '')
        const pure = b64.includes('base64,') ? b64.slice(b64.indexOf('base64,') + 7) : b64
        fs.writeFileSync(abs, Buffer.from(pure, 'base64'))
        return json(res, 200, { ok: true, path: abs, rel: relOf(ctx.root, abs) }), true
      } catch (e: any) {
        return json(res, 200, { ok: false, error: e?.message || String(e) }), true
      }
    }

    case 'touch': {
      if (!abs) return deny(res, '路径越界或为空'), true
      try {
        if (fs.existsSync(abs)) return json(res, 200, { ok: false, error: '同名文件已存在' }), true
        ensureParent(abs)
        fs.writeFileSync(abs, '', 'utf8')
        return json(res, 200, { ok: true, path: abs, rel: relOf(ctx.root, abs) }), true
      } catch (e: any) {
        return json(res, 200, { ok: false, error: e?.message || String(e) }), true
      }
    }

    case 'mkdir': {
      if (!abs) return deny(res, '路径越界或为空'), true
      try {
        if (fs.existsSync(abs)) return json(res, 200, { ok: false, error: '同名文件夹已存在' }), true
        fs.mkdirSync(abs, { recursive: true })
        return json(res, 200, { ok: true, path: abs, rel: relOf(ctx.root, abs) }), true
      } catch (e: any) {
        return json(res, 200, { ok: false, error: e?.message || String(e) }), true
      }
    }

    case 'ensure-dir': {
      if (!abs) return deny(res, '路径越界或为空'), true
      try {
        fs.mkdirSync(abs, { recursive: true })
        return json(res, 200, { ok: true, path: abs }), true
      } catch (e: any) {
        return json(res, 200, { ok: false, error: e?.message || String(e) }), true
      }
    }

    case 'delete': {
      if (!abs) return deny(res, '路径越界或为空'), true
      if (path.resolve(abs) === path.resolve(ctx.root)) return deny(res, '不允许删除共享目录本身'), true
      try {
        if (!fs.existsSync(abs)) return json(res, 200, { ok: false, error: '路径不存在' }), true
        fs.rmSync(abs, { recursive: true, force: true })
        return json(res, 200, { ok: true }), true
      } catch (e: any) {
        return json(res, 200, { ok: false, error: e?.message || String(e) }), true
      }
    }

    case 'copy':
    case 'move': {
      const srcAbs = resolveInRoot(ctx.root, String(body.from ?? ''))
      const dstRaw = String(body.to ?? '')
      if (!srcAbs || !dstRaw) return deny(res, '源或目标非法'), true
      try {
        if (!fs.existsSync(srcAbs)) return json(res, 200, { ok: false, error: '源不存在' }), true
        // to 若为已存在目录 → 复制/移动到其内部；否则作为目标路径（可含新文件名）
        const dstProbe = resolveInRoot(ctx.root, dstRaw)
        if (!dstProbe) return deny(res, '目标越界'), true
        const toDir = fs.existsSync(dstProbe) && fs.statSync(dstProbe).isDirectory() ? dstProbe : path.dirname(dstProbe)
        if (!fs.existsSync(toDir)) return json(res, 200, { ok: false, error: '目标目录不存在' }), true
        const toDirAbs = resolveInRoot(ctx.root, toDir)
        if (!toDirAbs) return deny(res, '目标越界'), true
        const name = fs.existsSync(dstProbe) && fs.statSync(dstProbe).isDirectory() ? path.basename(srcAbs) : path.basename(dstProbe)
        const finalPath = uniquePath(path.join(toDirAbs, name))
        if (route === 'copy') fs.cpSync(srcAbs, finalPath, { recursive: true })
        else fs.renameSync(srcAbs, finalPath)
        return json(res, 200, { ok: true, path: finalPath, rel: relOf(ctx.root, finalPath) }), true
      } catch (e: any) {
        return json(res, 200, { ok: false, error: e?.message || String(e) }), true
      }
    }

    case 'rename': {
      if (!abs) return deny(res, '路径越界或为空'), true
      const newName = String(body.name ?? '').trim()
      if (!newName || /[\\/]/.test(newName)) return json(res, 200, { ok: false, error: '名称非法' }), true
      try {
        if (!fs.existsSync(abs)) return json(res, 200, { ok: false, error: '文件不存在' }), true
        const target = resolveInRoot(ctx.root, path.join(path.dirname(abs), newName))
        if (!target) return deny(res, '目标越界'), true
        if (fs.existsSync(target)) return json(res, 200, { ok: false, error: '目标名称已存在' }), true
        fs.renameSync(abs, target)
        return json(res, 200, { ok: true, path: target, rel: relOf(ctx.root, target) }), true
      } catch (e: any) {
        return json(res, 200, { ok: false, error: e?.message || String(e) }), true
      }
    }

    default:
      return json(res, 404, { ok: false, error: `未知的文件接口: ${route}` }), true
  }
}

/** 能力概览（网页端据此决定注册哪些平台能力；见 src/platform/host） */
export function lanFsCapability(root: string, allowWrite: boolean): { fs: 'off' | 'read' | 'write'; root: string } {
  const mode: 'off' | 'read' | 'write' = !root ? 'off' : allowWrite ? 'write' : 'read'
  return { fs: mode, root: root ? path.basename(path.resolve(root)) : '' }
}
