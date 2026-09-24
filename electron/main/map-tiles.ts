/**
 * map-tiles.ts — MBTiles 离线地图包服务
 *
 * 职责：
 *  - 内置包：随软件分发（public/maps/*.mbtiles，vite 拷入 dist，构建时 asarUnpack）
 *  - 用户包：设置 → 系统 里「挂载」外部 .mbtiles，复制进 userData/maps/，
 *            注册表 userData/maps/index.json 记录，跨重启自动恢复
 *  - 瓦片读取：sql.js（纯 WASM，无原生编译）整库载入，按 (z,x,y) 查 tiles 表，
 *            MBTiles 默认 TMS 坐标（tile_row 自南向北），需按 metadata.scheme 翻转
 *
 * IPC 通道（在 registerMapTilesIpc() 中注册）：
 *   map-tiles:list     → MapTileSource[]（信封通道）
 *   map-tiles:add      → 弹窗选 .mbtiles 挂载（信封通道）
 *   map-tiles:remove   → 移除用户包（信封通道）
 *   map-tiles:tile     → 裸二进制通道，返回瓦片 Buffer / null（不经 JSON，避免膨胀）
 *   map-tiles:changed  → 挂载/移除后广播给所有窗口
 */

import { app, ipcMain, dialog, BrowserWindow } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { IPCError } from '@/types/ipc'
import { registerIpc, sendToAll } from './ipc-registry'
import { asUint8 } from './buffer-view'

const require = createRequire(import.meta.url)
/** sql.js（CJS/UMD 工厂）：运行时加载，避免双 tsconfig 下模块增强可见性问题 */
const initSqlJs: (config?: { locateFile?: (f: string) => string }) => Promise<any> = require('sql.js')

export interface MapBounds {
  west: number
  south: number
  east: number
  north: number
}

export interface MapTileSource {
  /** 稳定 id（跨重启不变）：builtin:xx / user:xx */
  id: string
  name: string
  kind: 'builtin' | 'user'
  /** 包文件绝对路径 */
  file: string
  /** 瓦片实际图片格式（嗅探 metadata.format） */
  format: 'png' | 'jpg' | 'webp' | 'unknown'
  /** tms（默认，tile_row 需翻转）/ xyz（不翻转） */
  scheme: 'tms' | 'xyz'
  minZoom: number
  maxZoom: number
  bounds: MapBounds | null
  /** 文件字节数 */
  size: number
}

interface LoadedDb {
  src: MapTileSource
  db: any
  lastUsed: number
}

const CHANGE_CHANNEL = 'map-tiles:changed'
const MAX_OPEN_DB = 2 // 最多同时打开的 DB（避免多个大包把内存占满），LRU 淘汰

let builtinDir = '' // publicDir/maps（dev: 源 public/maps；打包: dist/maps）
let userDir = '' // userData/maps
let indexFile = '' // userData/maps/index.json

/** 已登记的全部地图源（按 id 索引），内部可变 */
const sourcesById = new Map<string, MapTileSource>()
/** LRU 打开的 sql.js 数据库 */
const openDbs = new Map<string, LoadedDb>()

let sqlPromise: Promise<any> | null = null
function sqlReady(): Promise<any> {
  if (!sqlPromise) sqlPromise = initSqlJs().catch((err: any) => {
    sqlPromise = null
    throw new Error(`sql.js 初始化失败: ${err?.message || err}`)
  })
  return sqlPromise
}

// ==================== 元数据读取 ====================

async function readMeta(file: string): Promise<{ meta: Record<string, string>; size: number }> {
  if (!fs.existsSync(file)) throw new IPCError('NOT_FOUND', `地图包不存在: ${file}`)
  const SQL = await sqlReady()
  const buf = fs.readFileSync(file)
  const db = new SQL.Database(buf)
  const meta: Record<string, string> = {}
  try {
    const res = db.exec('SELECT name, value FROM metadata')
    if (res.length && Array.isArray(res[0].values)) {
      for (const row of res[0].values) meta[String(row[0])] = String(row[1])
    }
    // 粗校验：必须存在 tiles 表（否则不是合法 MBTiles）
    const t = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='tiles'")
    if (!t.length || !t[0].values.length) {
      throw new IPCError('INVALID', '不是有效的 MBTiles 文件（缺少 tiles 表）')
    }
  } catch (err: any) {
    if (err instanceof IPCError) throw err
    throw new IPCError('INVALID', `无法解析 MBTiles 元数据: ${err?.message || err}`)
  } finally {
    db.close()
  }
  return { meta, size: buf.length }
}

function sourceFromMeta(file: string, kind: 'builtin' | 'user', id: string, meta: Record<string, string>, size: number): MapTileSource {
  const n = (k: string) => Number(meta[k])
  const fmt = (meta.format || '').toLowerCase()
  const boundsRaw = meta.bounds
  let bounds: MapBounds | null = null
  if (boundsRaw) {
    const parts = String(boundsRaw).split(',').map((s) => Number(s.trim()))
    if (parts.length === 4 && parts.every((p) => Number.isFinite(p))) {
      bounds = { west: parts[0], south: parts[1], east: parts[2], north: parts[3] }
    }
  }
  const isFiniteZ = (v: number) => Number.isFinite(v) && v >= 0 && v <= 30
  const minZoom = isFiniteZ(n('minzoom')) ? Math.floor(n('minzoom')) : 0
  const maxZoom = isFiniteZ(n('maxzoom')) ? Math.floor(n('maxzoom')) : 0
  return {
    id,
    name: (meta.name || path.basename(file, path.extname(file))).trim() || path.basename(file),
    kind,
    file,
    format: fmt === 'png' || fmt === 'jpg' || fmt === 'jpeg' || fmt === 'webp' ? (fmt === 'jpeg' ? 'jpg' : fmt) : 'unknown',
    scheme: String(meta.scheme || '').toLowerCase() === 'xyz' ? 'xyz' : 'tms',
    minZoom,
    maxZoom: Math.max(maxZoom, minZoom),
    bounds,
    size,
  }
}

// ==================== 扫描 / 注册表 ====================

async function scanBuiltin(): Promise<void> {
  if (!builtinDir || !fs.existsSync(builtinDir)) return
  const files = fs.readdirSync(builtinDir).filter((f) => f.toLowerCase().endsWith('.mbtiles'))
  for (const f of files) {
    const file = path.join(builtinDir, f)
    const id = 'builtin:' + path.basename(f, path.extname(f))
    if (sourcesById.has(id)) continue
    try {
      const { meta, size } = await readMeta(file)
      const src = sourceFromMeta(file, 'builtin', id, meta, size)
      sourcesById.set(id, src)
      console.log(`[map-tiles] 发现内置地图包: ${src.name} (${(size / 1048576).toFixed(1)} MB, z${src.minZoom}~z${src.maxZoom})`)
    } catch (err: any) {
      console.warn(`[map-tiles] 内置包 ${f} 解析失败，跳过:`, err?.message || err)
    }
  }
}

async function loadUserRegistry(): Promise<void> {
  if (!indexFile || !fs.existsSync(indexFile)) return
  try {
    const list = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as Array<{ id: string; file: string }>
    for (const item of list || []) {
      if (sourcesById.has(item.id)) continue
      if (!item.file || !fs.existsSync(item.file)) continue // 文件被移动/删除则忽略（挂载管理页会提示）
      try {
        const { meta, size } = await readMeta(item.file)
        sourcesById.set(item.id, sourceFromMeta(item.file, 'user', item.id, meta, size))
      } catch {
        /* 单个损坏包不影响其他 */
      }
    }
  } catch (err: any) {
    console.warn('[map-tiles] 用户注册表读取失败:', err?.message || err)
  }
}

function saveUserRegistry(): void {
  const list = [...sourcesById.values()]
    .filter((s) => s.kind === 'user')
    .map((s) => ({ id: s.id, file: s.file }))
  try {
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true })
    fs.writeFileSync(indexFile, JSON.stringify(list, null, 2), 'utf8')
  } catch (err: any) {
    console.warn('[map-tiles] 注册表写入失败:', err?.message || err)
  }
}

/** 把选中的外部包复制进 userData/maps（同名加时间戳避免覆盖），并登记 */
async function addUserFile(srcPath: string): Promise<MapTileSource | null> {
  if (!fs.existsSync(srcPath)) throw new IPCError('NOT_FOUND', '选择的文件不存在')
  const ext = path.extname(srcPath).toLowerCase() || '.mbtiles'
  const base = path.basename(srcPath, path.extname(srcPath))
  const { meta, size } = await readMeta(srcPath) // 校验 + 取元数据
  // 复制前先探测是否已登记同一来源
  const existing = [...sourcesById.values()].find((s) => path.resolve(s.file) === path.resolve(srcPath))
  if (existing) return existing

  if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true })
  const destName = `${base}_${Date.now()}${ext}`
  const dest = path.join(userDir, destName)
  await fs.promises.copyFile(srcPath, dest)
  const id = 'user:' + path.basename(destName, path.extname(destName))
  const src = sourceFromMeta(dest, 'user', id, meta, size)
  sourcesById.set(id, src)
  saveUserRegistry()
  sendToAll(CHANGE_CHANNEL, listSources())
  return src
}

// ==================== 对外 API ====================

export function listSources(): MapTileSource[] {
  return [...sourcesById.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'zh'))
}

export function getSource(id: string): MapTileSource | undefined {
  return sourcesById.get(id)
}

/** 初始化：扫内置包 + 恢复用户注册表（app ready 后调用） */
export async function initMapTiles(publicMapsDir: string): Promise<void> {
  builtinDir = publicMapsDir
  userDir = path.join(app.getPath('userData'), 'maps')
  indexFile = path.join(userDir, 'index.json')
  await scanBuiltin()
  await loadUserRegistry()
  console.log(`[map-tiles] 初始化完成，共 ${sourcesById.size} 个地图源`)
}

// ==================== 瓦片读取 ====================

async function ensureDb(src: MapTileSource): Promise<LoadedDb> {
  const cached = openDbs.get(src.id)
  if (cached) {
    cached.lastUsed = Date.now()
    return cached
  }
  // LRU 淘汰
  while (openDbs.size >= MAX_OPEN_DB) {
    let oldestId: string | null = null
    let oldest = Infinity
    for (const [k, v] of openDbs) {
      if (v.lastUsed < oldest) { oldest = v.lastUsed; oldestId = k }
    }
    if (oldestId) {
      try { openDbs.get(oldestId)?.db.close() } catch { /* ignore */ }
      openDbs.delete(oldestId)
    }
  }
  const SQL = await sqlReady()
  const buf = fs.readFileSync(src.file)
  const db = new SQL.Database(buf)
  const loaded: LoadedDb = { src, db, lastUsed: Date.now() }
  openDbs.set(src.id, loaded)
  return loaded
}

/**
 * 取一张瓦片。
 * @returns 瓦片字节（png/jpg），无则返回 null
 */
export async function getTileData(srcId: string, z: number, x: number, y: number): Promise<Uint8Array | null> {
  const src = sourcesById.get(srcId)
  if (!src) throw new IPCError('NOT_FOUND', `地图源不存在: ${srcId}`)
  const zi = Math.floor(z)
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const row = src.scheme === 'xyz' ? yi : Math.pow(2, zi) - 1 - yi // TMS → XYZ 翻转
  const loaded = await ensureDb(src)
  const stmt = loaded.db.prepare(
    'SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?'
  )
  try {
    stmt.bind([zi, xi, row])
    if (stmt.step()) {
      const values = stmt.get()
      const blob = values && values.length ? values[0] : null
      return blob ? asUint8(Buffer.from(blob as Uint8Array)) : null
    }
    return null
  } finally {
    try { stmt.free() } catch { /* ignore */ }
  }
}

// ==================== IPC 注册 ====================

export function registerMapTilesIpc(): void {
  registerIpc('map-tiles:list', () => listSources())

  registerIpc('map-tiles:add', async () => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    const r = await dialog.showOpenDialog(win, {
      title: '选择 MBTiles 离线地图包',
      filters: [{ name: 'MBTiles 地图包', extensions: ['mbtiles', 'sqlite', 'db'] }],
      properties: ['openFile'],
    })
    if (r.canceled || !r.filePaths.length) return null
    return addUserFile(r.filePaths[0])
  })

  registerIpc('map-tiles:remove', (payload) => {
    const id = String(payload?.id || '')
    const src = sourcesById.get(id)
    if (!src) throw new IPCError('NOT_FOUND', `地图源不存在: ${id}`)
    if (src.kind !== 'user') throw new IPCError('FORBIDDEN', '内置地图包不可移除')
    try { openDbs.get(id)?.db.close() } catch { /* ignore */ }
    openDbs.delete(id)
    sourcesById.delete(id)
    try { fs.rmSync(src.file, { force: true }) } catch { /* ignore */ }
    saveUserRegistry()
    sendToAll(CHANGE_CHANNEL, listSources())
    return true
  })

  // 裸二进制通道：不经 JSON 信封，避免 Uint8Array 被 JSON.stringify 膨胀
  ipcMain.handle('map-tiles:tile', async (_event, payload) => {
    const { id, z, x, y } = payload || {}
    if (typeof id !== 'string' || !Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) {
      return null
    }
    try {
      return await getTileData(id, Math.floor(z), Math.floor(x), Math.floor(y))
    } catch (err: any) {
      console.warn(`[map-tiles] 瓦片读取失败 ${id}/${z}/${x}/${y}:`, err?.message || err)
      return null
    }
  })
}
