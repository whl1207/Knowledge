/**
 * collab-service.ts — 局域网协同文件编辑（WebSocket 服务器）
 *
 * 架构：Host–Client 中心化。本服务在**主进程**运行，持有每个房间的权威 Yjs 文档：
 * - 宿主（共享者）通过 IPC collab:shareFile 创建房间并写入初始内容；
 * - 所有参与者（含宿主自身）以 WebSocket 客户端身份连入，服务端做同步中继：
 *   - 新成员加入 → 发送全量快照（encodeStateAsUpdate）；
 *   - 编辑更新 → 服务端 applyUpdate 到权威文档后转发给其他成员；
 *   - 光标/选区 → Awareness 二进制透传（各客户端各自维护 Awareness）；
 * - 权限：open（默认，全员可编）/ approve（请求-批准）/ readonly（只读）；
 * - 落盘：只有宿主对应的 filePath 会被服务端写盘（自动保存 + 显式 save-request）。
 *
 * 协议（JSON 文本帧，Yjs 更新走 base64）：
 *   Client→Server: hello / update / awareness / save-request / request-edit / grant-edit / deny-edit / ping / leave
 *   Server→Client: welcome / snapshot / update / awareness / members / role / host / edit-request / saved / closed / error / pong
 */
import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import * as fs from 'node:fs'
import { ipcMain, BrowserWindow } from 'electron'
import * as Y from 'yjs'
import type { CollabKind, CollabPermissionMode, CollabStatus, CollabShareResult } from '@/types/collab'
import { cleanExcalidrawAppState } from '@/shared/excalidrawAppState'

export const COLLAB_DEFAULT_PORT = 3346

interface CollabMember {
  id: string
  name: string
  color: string
  role: 'host' | 'editor' | 'reader'
  canEdit: boolean
  ws: WebSocket
  lastPing: number
}

/** 对外广播的成员信息：不含 ws / lastPing 等主进程内部字段（不能序列化，也不该暴露） */
type CollabMemberPublic = Omit<CollabMember, 'ws' | 'lastPing'>

interface CollabRoom {
  roomId: string
  filePath: string
  token: string
  maxMembers: number
  permissionMode: CollabPermissionMode
  doc: Y.Doc
  ytext: Y.Text
  members: Map<string, CollabMember>
  hostId: string | null
  saveTimer: NodeJS.Timeout | null
  /** 房间数据模型：text=纯文本（Monaco） / excalidraw=白板场景（elements+order+files） / drawio=draw.io 图表（完整 XML + 增量 patch） */
  kind: CollabKind
  /** excalidraw 初始文件里的 appState（用于写盘保真） */
  baseAppState: Record<string, any>
  /** 宿主实时上报的 appState（优先于 baseAppState） */
  liveAppState: Record<string, any> | null
  /** drawio：宿主上报的最新完整 XML（新成员加入 / 重同步 / 写盘的权威内容） */
  drawioXml: string
  /** drawio：正在等待宿主刷新权威 XML 的成员 → 超时定时器 */
  pendingSyncs: Map<string, NodeJS.Timeout>
}

let wss: WebSocketServer | null = null
let serverPort = COLLAB_DEFAULT_PORT
const rooms = new Map<string, CollabRoom>()

// ---------------- 工具 ----------------

function hashPath(p: string): string {
  return createHash('sha1').update(p.replace(/\\/g, '/')).digest('hex').slice(0, 12)
}

function b64(uint8: Uint8Array): string {
  return Buffer.from(uint8).toString('base64')
}

function unb64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'))
}

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
  return randomBytes(4).toString('hex')
}

const MEMBER_COLORS = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6',
  '#bcf60c', '#fabebe', '#008080', '#e6beff', '#9a6324', '#800000', '#aaffc3',
  '#808000', '#ffd8b1', '#000075', '#808080', '#f9f9f9', '#ffe119',
]
let colorIdx = 0
function nextColor(): string {
  const c = MEMBER_COLORS[colorIdx % MEMBER_COLORS.length]
  colorIdx += 1
  return c
}

function err(message: string): string {
  return JSON.stringify({ type: 'error', message })
}

function publicMembers(room: CollabRoom): CollabMemberPublic[] {
  return [...room.members.values()].map((m) => ({
    id: m.id,
    name: m.name,
    color: m.color,
    role: m.role,
    canEdit: m.canEdit,
  }))
}

function send(ws: WebSocket, type: string, payload: Record<string, any> = {}) {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type, ...payload }))
    } catch (e) {
      console.error('[collab] 发送失败:', e)
    }
  }
}

function broadcastMembers(room: CollabRoom) {
  const members = publicMembers(room)
  for (const m of room.members.values()) {
    send(m.ws, 'members', { members })
  }
}

function notifyStatus() {
  const payload: CollabStatus = {
    running: wss !== null,
    port: serverPort,
    ips: getLanIPs(),
    rooms: rooms.size,
  }
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) w.webContents.send('collab:status', payload)
  })
}

function saveRoomToDisk(room: CollabRoom): boolean {
  try {
    let content: string
    if (room.kind === 'drawio') {
      // drawio：宿主上报的完整 XML 即权威内容（diff 只在会话内中继，不落盘）
      content = room.drawioXml
    } else if (room.kind === 'excalidraw') {
      // 从 Yjs 场景重建 .excalidraw JSON（elements 按 order 的 z 序排列 + files）
      const elMap = room.doc.getMap('elements')
      const order = room.doc.getArray('order').toArray() as string[]
      const elements = order.map((id) => elMap.get(id)).filter(Boolean)
      const files = Object.fromEntries(room.doc.getMap('files').entries())
      // ⚠️ 必须过滤运行时 appState 键：Excalidraw 的 appState.collaborators 是 Map，
      // JSON 落盘后会变成 {}，下次打开时 UserList 执行 collaborators.forEach 抛错 → 整块白板空白
      const appState = cleanExcalidrawAppState(room.liveAppState || room.baseAppState)
      content = JSON.stringify({ elements, appState, files })
    } else {
      content = room.ytext.toString()
    }
    fs.writeFileSync(room.filePath, content, 'utf8')
    return true
  } catch (e) {
    console.error('[collab] 保存房间到磁盘失败:', e)
    return false
  }
}

/**
 * drawio：请求宿主现导一份权威 XML 给指定成员（新加入 / 主动重同步）。
 * 不能用缓存 XML 直接下发：宿主应用远端 patch 时不会触发自动保存，缓存可能落后于真实状态。
 * 宿主未响应时超时回退到缓存值（至少能拿到一个可用基准）。
 */
function requestDrawioSync(room: CollabRoom, memberId: string) {
  const target = room.members.get(memberId)
  if (!target) return
  const old = room.pendingSyncs.get(memberId)
  if (old) clearTimeout(old)
  const host = room.hostId ? room.members.get(room.hostId) : null
  if (!host || host.ws.readyState !== WebSocket.OPEN) {
    send(target.ws, 'drawio-sync', { xml: room.drawioXml })
    return
  }
  const timer = setTimeout(() => {
    room.pendingSyncs.delete(memberId)
    const m = room.members.get(memberId)
    if (m && m.ws.readyState === WebSocket.OPEN) {
      send(m.ws, 'drawio-sync', { xml: room.drawioXml })
    }
  }, 2500)
  room.pendingSyncs.set(memberId, timer)
  // 宿主自身请求同步时直接回缓存值
  if (host.id === memberId) {
    send(host.ws, 'drawio-sync', { xml: room.drawioXml })
    return
  }
  send(host.ws, 'drawio-need-sync', { memberId })
}

/** 宿主上报权威 XML 后，把它发给所有正在等待同步的成员 */
function flushDrawioSync(room: CollabRoom, xml: string) {
  if (!room.pendingSyncs.size) return
  for (const [memberId, timer] of room.pendingSyncs) {
    clearTimeout(timer)
    const m = room.members.get(memberId)
    if (m && m.ws.readyState === WebSocket.OPEN) {
      send(m.ws, 'drawio-sync', { xml })
    }
  }
  room.pendingSyncs.clear()
}

function hostWsUrl(roomId: string, token: string): string {
  return `ws://127.0.0.1:${serverPort}/collab/${roomId}?token=${encodeURIComponent(token)}`
}

// ---------------- 连接处理 ----------------

function onConnection(ws: WebSocket, req: IncomingMessage) {
  const rawUrl = req.url || ''
  const pathOnly = rawUrl.split('?')[0]
  const match = /\/collab\/([^/]+)\/?$/.exec(pathOnly)
  if (!match) {
    ws.send(err('无效的协同地址'))
    ws.close(4003, 'invalid path')
    return
  }
  const roomId = decodeURIComponent(match[1])
  const qs = new URLSearchParams(rawUrl.split('?')[1] || '')
  const token = qs.get('token') || ''

  const room = rooms.get(roomId)
  if (!room) {
    ws.send(err('房间不存在或已结束'))
    ws.close(4004, 'room not found')
    return
  }
  if (token !== room.token) {
    ws.send(err('房间 Token 错误'))
    ws.close(4001, 'bad token')
    return
  }
  if (room.members.size >= room.maxMembers) {
    ws.send(err('房间人数已满'))
    ws.close(4005, 'room full')
    return
  }

  const member: CollabMember = {
    id: randomBytes(8).toString('hex'),
    name: '匿名',
    color: nextColor(),
    role: 'editor',
    canEdit: true,
    ws,
    lastPing: Date.now(),
  }
  room.members.set(member.id, member)

  ws.on('message', (data) => onMessage(room, member, data))
  ws.on('close', () => onClose(room, member))
  ws.on('pong', () => { member.lastPing = Date.now() })
  ws.on('error', () => { /* 连接错误由 close 统一处理 */ })

  // 心跳检测：60s 无 pong 视为失联
  const pingTimer = setInterval(() => {
    if (Date.now() - member.lastPing > 60000) {
      clearInterval(pingTimer)
      try { ws.terminate() } catch { /* ignore */ }
    } else {
      send(ws, 'pong', { t: Date.now() })
    }
  }, 20000)
  ;(ws as any).__collabPingTimer = pingTimer
}

function onMessage(room: CollabRoom, member: CollabMember, data: any) {
  let msg: any
  try {
    msg = JSON.parse(data.toString())
  } catch {
    return
  }
  if (!msg || typeof msg.type !== 'string') return
  member.lastPing = Date.now()

  switch (msg.type) {
    case 'hello': {
      member.name = typeof msg.name === 'string' && msg.name.trim() ? msg.name.trim().slice(0, 20) : '匿名'
      if (room.hostId === null) {
        // 第一个连入者即宿主（共享者紧接 shareFile 连入）
        room.hostId = member.id
        member.role = 'host'
        member.canEdit = true
      } else if (room.permissionMode === 'open') {
        member.role = 'editor'
        member.canEdit = true
      } else {
        // approve / readonly：默认只读，approve 模式下可请求授权
        member.role = 'reader'
        member.canEdit = false
      }
      send(wsOf(member), 'welcome', {
        memberId: member.id,
        isHost: room.hostId === member.id,
        members: publicMembers(room),
        maxMembers: room.maxMembers,
        permissionMode: room.permissionMode,
      })
      send(wsOf(member), 'snapshot', { update: b64(Y.encodeStateAsUpdate(room.doc)) })
      if (room.kind === 'drawio') {
        // drawio：新人不能直接用可能已过期的缓存 XML，而是让宿主现导一份权威快照；
        // 超时（宿主不在/未响应）才回退到缓存值
        if (room.hostId === member.id) {
          send(wsOf(member), 'drawio-sync', { xml: room.drawioXml })
        } else {
          requestDrawioSync(room, member.id)
        }
      }
      // Excalidraw：新成员加入时把主机的当前视口（scrollX/scrollY/zoom）同步给它，
      // 让加入者一进来就看到主机正在查看的位置与缩放
      if (room.kind === 'excalidraw' && room.hostId && room.hostId !== member.id) {
        const view = room.liveAppState || room.baseAppState || {}
        if (view && (typeof view.scrollX === 'number' || typeof view.zoom !== 'undefined')) {
          send(wsOf(member), 'appstate', {
            appState: {
              scrollX: typeof view.scrollX === 'number' ? view.scrollX : undefined,
              scrollY: typeof view.scrollY === 'number' ? view.scrollY : undefined,
              zoom: view.zoom ?? undefined,
            },
          })
        }
      }
      broadcastMembers(room)
      break
    }
    case 'update': {
      if (!member.canEdit) {
        send(wsOf(member), 'error', { message: '当前无编辑权限' })
        return
      }
      if (typeof msg.update !== 'string' || !msg.update) return
      try {
        Y.applyUpdate(room.doc, unb64(msg.update))
      } catch (e) {
        console.error('[collab] 应用 Yjs 更新失败:', e)
        return
      }
      for (const [id, m] of room.members) {
        if (id !== member.id && m.ws.readyState === WebSocket.OPEN) {
          send(m.ws, 'update', { update: msg.update, from: member.id })
        }
      }
      break
    }
    case 'awareness': {
      if (typeof msg.update !== 'string' || !msg.update) return
      for (const [id, m] of room.members) {
        if (id !== member.id && m.ws.readyState === WebSocket.OPEN) {
          send(m.ws, 'awareness', { update: msg.update })
        }
      }
      break
    }
    case 'save-request': {
      // 仅宿主可写盘；其他成员拒绝（客户端已拦截，这里作强制校验）
      if (room.hostId !== member.id) {
        send(wsOf(member), 'saved', { ok: false })
        break
      }
      const ok = saveRoomToDisk(room)
      send(wsOf(member), 'saved', { ok })
      break
    }
    case 'appstate': {
      // 仅主机上报当前 appState（Excalidraw 视图状态），用于写盘保真；元素/文件走 Yjs
      if (room.hostId !== member.id) break
      if (msg.appState && typeof msg.appState === 'object') {
        room.liveAppState = msg.appState
      }
      break
    }
    case 'request-edit': {
      if (room.permissionMode !== 'approve') {
        // 非批准模式下直接授予编辑权
        member.role = 'editor'
        member.canEdit = true
        send(wsOf(member), 'role', { canEdit: true, role: 'editor' })
        broadcastMembers(room)
        break
      }
      const host = room.hostId ? room.members.get(room.hostId) : null
      if (host && host.ws.readyState === WebSocket.OPEN) {
        send(host.ws, 'edit-request', { member: { id: member.id, name: member.name, color: member.color } })
      }
      break
    }
    case 'grant-edit': {
      if (room.hostId !== member.id) break // 仅宿主可授权
      const target = room.members.get(msg.memberId)
      if (target) {
        target.role = 'editor'
        target.canEdit = true
        send(target.ws, 'role', { canEdit: true, role: 'editor' })
        broadcastMembers(room)
      }
      break
    }
    case 'deny-edit': {
      if (room.hostId !== member.id) break
      const target = room.members.get(msg.memberId)
      if (target) send(target.ws, 'role', { canEdit: false, denied: true })
      break
    }
    case 'drawio-diff': {
      // drawio 增量同步：网状中继（转发给除发送者外的所有成员）。
      // 应用远端 patch 会同步更新编辑器内部的 shadow，因此接收方不会因回声再发一次 diff，
      // 无需额外去重；成员间状态靠 drawio 自身的 diff 协议收敛。
      if (!member.canEdit) {
        send(wsOf(member), 'error', { message: '当前无编辑权限' })
        return
      }
      if (!msg.patch || typeof msg.patch !== 'object') return
      const fromHost = room.hostId === member.id
      // 仅宿主上报完整 XML：它才是权威内容（新成员同步 + 写盘都用它）
      if (fromHost && typeof msg.xml === 'string' && msg.xml) {
        room.drawioXml = msg.xml
      }
      const payload: Record<string, any> = { patch: msg.patch, from: member.id }
      for (const [id, m] of room.members) {
        if (id === member.id || m.ws.readyState !== WebSocket.OPEN) continue
        send(m.ws, 'drawio-diff', payload)
      }
      break
    }
    case 'drawio-xml': {
      // 仅宿主可上报权威 XML；收到后服务给正在等待同步的成员（新加入者 / 主动重同步者）
      if (room.hostId !== member.id) return
      if (typeof msg.xml !== 'string' || !msg.xml) return
      room.drawioXml = msg.xml
      flushDrawioSync(room, msg.xml)
      break
    }
    case 'drawio-sync-request': {
      // 客户端主动要一份权威 XML（本地重同步用）
      requestDrawioSync(room, member.id)
      break
    }
    case 'drawio-resync': {
      // 宿主在本地做了「非增量」的整体重建（如 AI 插入图形，走 load 而非 patch）：
      // 把新内容作为权威基准下发给全体成员重建 diff 基准，否则各方基准不一致会逐步漂移。
      if (room.hostId !== member.id) return
      if (typeof msg.xml !== 'string' || !msg.xml) return
      room.drawioXml = msg.xml
      for (const [id, m] of room.members) {
        if (id === member.id || m.ws.readyState !== WebSocket.OPEN) continue
        send(m.ws, 'drawio-sync', { xml: msg.xml })
      }
      break
    }
    case 'ping': {
      send(wsOf(member), 'pong', { t: Date.now() })
      break
    }
    case 'leave': {
      try { wsOf(member).close(1000, 'bye') } catch { /* ignore */ }
      break
    }
    default:
      break
  }
}

function wsOf(member: CollabMember): WebSocket {
  return member.ws
}

function onClose(room: CollabRoom, member: CollabMember) {
  room.members.delete(member.id)
  // drawio：清理该成员待同步的定时器
  const t = room.pendingSyncs.get(member.id)
  if (t) {
    clearTimeout(t)
    room.pendingSyncs.delete(member.id)
  }
  const timer = (member.ws as any).__collabPingTimer
  if (timer) clearInterval(timer)

  if (room.members.size === 0) {
    // 房间空 → 保存并销毁
    saveRoomToDisk(room)
    if (room.saveTimer) clearInterval(room.saveTimer)
    rooms.delete(room.roomId)
    notifyStatus()
    return
  }

  // 宿主离开 → 移交
  if (room.hostId === member.id) {
    const next = [...room.members.values()][0]
    room.hostId = next.id
    next.role = 'host'
    next.canEdit = true
    send(next.ws, 'host', { hostId: next.id })
    send(next.ws, 'role', { canEdit: true, role: 'host' })
  }
  broadcastMembers(room)
}

// ---------------- 对外 API（IPC） ----------------

async function listenOnce(port: number): Promise<'ok' | 'busy' | 'fatal'> {
  return new Promise((resolve) => {
    const server = new WebSocketServer({ port, host: '0.0.0.0' })
    let settled = false
    server.once('listening', () => {
      if (settled) return
      settled = true
      wss = server
      server.on('connection', (ws, req) => onConnection(ws, req))
      resolve('ok')
    })
    server.once('error', (e: any) => {
      if (settled) return
      settled = true
      wss = null
      try { server.close() } catch { /* ignore */ }
      resolve(e?.code === 'EADDRINUSE' ? 'busy' : 'fatal')
    })
  })
}

export async function startCollab(opts: {
  port?: number
  maxMembers?: number
  permissionMode?: CollabPermissionMode
  token?: string
} = {}): Promise<{ success: boolean; port?: number; error?: string }> {
  if (wss) return { success: false, error: '协同服务已在运行' }
  const base = opts.port || COLLAB_DEFAULT_PORT
  for (let p = base; p <= base + 20; p++) {
    const r = await listenOnce(p)
    if (r === 'ok') {
      serverPort = p
      notifyStatus()
      return { success: true, port: p }
    }
    if (r === 'fatal') {
      notifyStatus()
      return { success: false, error: '协同服务启动失败' }
    }
    // busy → 顺延端口（开发版与打包版并存）
  }
  notifyStatus()
  return { success: false, error: '协同服务端口被占用' }
}

export async function stopCollab(): Promise<{ success: boolean }> {
  if (!wss) return { success: false }
  for (const room of rooms.values()) {
    saveRoomToDisk(room)
    if (room.saveTimer) clearInterval(room.saveTimer)
    room.pendingSyncs.forEach((t) => clearTimeout(t))
    room.pendingSyncs.clear()
    for (const m of room.members.values()) {
      send(m.ws, 'closed', { reason: '服务已停止' })
      try { m.ws.close(4000, 'server-stopped') } catch { /* ignore */ }
    }
  }
  rooms.clear()
  const server = wss
  wss = null
  return new Promise((resolve) => {
    if (!server) { notifyStatus(); resolve({ success: false }); return }
    try {
      server.clients.forEach((c) => { try { c.terminate() } catch { /* ignore */ } })
      server.close(() => {
        notifyStatus()
        resolve({ success: true })
      })
    } catch {
      notifyStatus()
      resolve({ success: true })
    }
  })
}

export function getCollabStatus(): CollabStatus {
  return {
    running: wss !== null,
    port: serverPort,
    ips: getLanIPs(),
    rooms: rooms.size,
  }
}

export async function shareFile(
  filePath: string,
  content: string,
  options: {
    token?: string
    maxMembers?: number
    permissionMode?: CollabPermissionMode
    autoSaveSeconds?: number
    kind?: CollabKind
  } = {},
): Promise<CollabShareResult> {
  if (!wss) throw new Error('协同服务未启动')
  const roomId = `f${hashPath(filePath)}`
  const existing = rooms.get(roomId)
  if (existing) {
    // 同文件已在共享 → 复用房间（token 不变，避免已加入成员掉线）
    return { roomId, token: existing.token, url: hostWsUrl(roomId, existing.token), port: serverPort }
  }
  const token = options.token || makeToken()
  const kind: CollabKind = options.kind === 'excalidraw' ? 'excalidraw' : options.kind === 'drawio' ? 'drawio' : 'text'
  const doc = new Y.Doc()
  const room: CollabRoom = {
    roomId,
    filePath,
    token,
    maxMembers: options.maxMembers || 10,
    permissionMode: options.permissionMode || 'open',
    doc,
    ytext: doc.getText('content'),
    members: new Map(),
    hostId: null,
    saveTimer: null,
    kind,
    baseAppState: {},
    liveAppState: null,
    drawioXml: '',
    pendingSyncs: new Map(),
  }
  if (kind === 'drawio') {
    // drawio：初始内容就是宿主打开文件时的完整 XML（增量 diff 仅在会话内中继）
    room.drawioXml = content || ''
  } else if (kind === 'excalidraw') {
    // 解析 .excalidraw JSON，把 elements/files 写入 Yjs 场景（元素级 CRDT 合并）
    let parsed: any = null
    try {
      parsed = content ? JSON.parse(content) : null
    } catch { /* 解析失败则空场景 */ }
    const elements = Array.isArray(parsed?.elements) ? parsed.elements : []
    const elMap = room.doc.getMap('elements')
    elements.forEach((el: any) => {
      if (el && el.id) elMap.set(el.id, el)
    })
    const order = room.doc.getArray('order')
    const ids = elements.map((el: any) => el.id).filter(Boolean)
    if (ids.length) order.insert(0, ids)
    const files = parsed && typeof parsed.files === 'object' && parsed.files ? parsed.files : {}
    const fMap = room.doc.getMap('files')
    Object.entries(files).forEach(([id, f]) => fMap.set(id, f))
    // 初始 appState 同样过滤（老文件里可能已残留 "collaborators": {}）
    room.baseAppState = cleanExcalidrawAppState(parsed?.appState)
  } else if (content) {
    room.ytext.insert(0, content)
  }
  const interval = Math.max(5, options.autoSaveSeconds || 30) * 1000
  room.saveTimer = setInterval(() => saveRoomToDisk(room), interval)
  rooms.set(roomId, room)
  notifyStatus()
  return { roomId, token, url: hostWsUrl(roomId, token), port: serverPort }
}

export async function closeRoom(roomId: string): Promise<{ success: boolean }> {
  const room = rooms.get(roomId)
  if (!room) return { success: false }
  saveRoomToDisk(room)
  if (room.saveTimer) clearInterval(room.saveTimer)
  room.pendingSyncs.forEach((t) => clearTimeout(t))
  room.pendingSyncs.clear()
  for (const m of room.members.values()) {
    send(m.ws, 'closed', { reason: '主机已停止共享' })
    try { m.ws.close(4000, 'host-left') } catch { /* ignore */ }
  }
  rooms.delete(roomId)
  notifyStatus()
  return { success: true }
}

export async function saveRoom(roomId: string): Promise<{ ok: boolean; error?: string }> {
  const room = rooms.get(roomId)
  if (!room) return { ok: false, error: '房间不存在' }
  return { ok: saveRoomToDisk(room) }
}

// ---------------- IPC 挂载 ----------------

export function registerCollabIpc() {
  ipcMain.handle('collab:start', async (_e, payload) => startCollab(payload || {}))
  ipcMain.handle('collab:stop', async () => stopCollab())
  ipcMain.handle('collab:getStatus', async () => getCollabStatus())
  ipcMain.handle('collab:shareFile', async (_e, payload) => {
    return shareFile(payload?.filePath, payload?.content || '', payload?.options || {})
  })
  ipcMain.handle('collab:closeRoom', async (_e, { roomId }) => closeRoom(roomId))
  ipcMain.handle('collab:saveRoom', async (_e, { roomId }) => saveRoom(roomId))
}
