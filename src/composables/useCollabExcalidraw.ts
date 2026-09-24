/**
 * useCollabExcalidraw.ts — Excalidraw（白板）协同会话
 *
 * 复用主进程 collab-service 的 WS 协议与房间机制（kind='excalidraw'），把白板场景
 * 以元素级 CRDT 写入 Yjs：
 *   - doc.getMap('elements')：elementId → 元素对象
 *   - doc.getArray('order')  ：元素 id 的 z 序
 *   - doc.getMap('files')    ：嵌入图片/文件（fileId → BinaryFileData）
 * 本地 onChange → 写 Yjs → 广播增量；远端 update → apply → updateScene 重建场景。
 * 光标/协作者通过 awareness 广播，写入 appState.collaborators（Excalidraw 原生渲染
 * 彩色光标 + 用户名徽标）。写盘沿用「仅主机」，视图状态由主机 appstate 消息保真。
 */
import { ref, readonly } from 'vue'
import * as Y from 'yjs'
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } from 'y-protocols/awareness'
import { uint8ToBase64, base64ToUint8 } from '@/lib/collab-codec'
import type { CollabMember } from '@/types/collab'

export type CollabSessionStatus = 'idle' | 'connecting' | 'connected'

/** 远端应用更新的 origin 哨兵（防回声） */
const REMOTE_ORIGIN = 'collab-remote'

/** Excalidraw 需要的 API 子集 */
export interface ExcalidrawLikeApi {
  getSceneElements(): any[]
  getAppState(): any
  getFiles(): Record<string, any>
  updateScene(data: { elements?: any[]; appState?: any; collaborators?: Map<string, any>; commitToHistory?: boolean }): void
  addFiles(files: any[]): void
}

export interface CollabExcalidrawController {
  status: Readonly<import('vue').Ref<CollabSessionStatus>>
  isHost: Readonly<import('vue').Ref<boolean>>
  canEdit: Readonly<import('vue').Ref<boolean>>
  roomId: Readonly<import('vue').Ref<string | null>>
  roomToken: Readonly<import('vue').Ref<string>>
  members: Readonly<import('vue').Ref<CollabMember[]>>
  error: Readonly<import('vue').Ref<string>>
  pendingEditRequests: Readonly<import('vue').Ref<CollabMember[]>>
  /** 宿主共享当前白板并进入会话 */
  startHost(
    api: ExcalidrawLikeApi,
    filePath: string,
    content: string,
    opts?: { token?: string; maxMembers?: number; permissionMode?: string; autoSaveSeconds?: number; name?: string },
  ): Promise<boolean>
  /** 客户端加入会话 */
  join(api: ExcalidrawLikeApi, url: string, name: string): Promise<boolean>
  /** 由 Excalidraw 的 onChange 调用（会话中） */
  handleSceneChange(elements: any[], appState: any, files: Record<string, any>): void
  /** 由指针移动监听调用（场景坐标） */
  handlePointerMove(x: number, y: number): void
  /** 请求服务端写盘（仅主机） */
  save(): Promise<boolean>
  leave(): void
  requestEdit(): void
  grantEdit(memberId: string): void
  denyEdit(memberId: string): void
  clearEditRequest(memberId: string): void
  onClosed(cb: (reason: string) => void): void
  destroy(): void
}

export function useCollabExcalidraw(): CollabExcalidrawController {
  const status = ref<CollabSessionStatus>('idle')
  const isHost = ref(false)
  const canEdit = ref(false)
  const roomId = ref<string | null>(null)
  const roomToken = ref('')
  const members = ref<CollabMember[]>([])
  const error = ref('')
  const pendingEditRequests = ref<CollabMember[]>([])

  let doc: Y.Doc | null = null
  let awareness: Awareness | null = null
  let ws: WebSocket | null = null
  let api: ExcalidrawLikeApi | null = null
  let ownMemberId = ''
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let closedCb: ((reason: string) => void) | null = null
  let pendingConnect: ((ok: boolean) => void) | null = null
  let saveResolve: ((ok: boolean) => void) | null = null
  let applyingRemote = false
  let appstateTimer: ReturnType<typeof setTimeout> | null = null
  let lastCursorSend = 0
  let cursorRaf = 0
  // 上次写入 Yjs 的场景签名：Excalidraw 的 onChange 是异步触发的，
  // applyingRemote 同步布尔拦不住回声，必须用「内容幂等」来跳过重复写回。
  let lastSceneKey = ''
  // 上次应用给 Excalidraw 的 files 指纹：addFiles 会清空并重载 imageCache，
  // 拖动元素时远端 update 每帧到达，若每次都 addFiles 会导致图片反复重载闪烁。
  let lastFilesKey = ''

  // ---------------- 发送 ----------------
  function sendWs(msg: Record<string, any>) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(msg))
      } catch (e) {
        console.warn('[collab-excalidraw] 发送失败:', e)
      }
    }
  }

  function sendAwareness() {
    if (!awareness || !ws || ws.readyState !== WebSocket.OPEN) return
    const clients = [...awareness.getStates().keys()]
    if (!clients.length) return
    try {
      const enc = encodeAwarenessUpdate(awareness, clients)
      sendWs({ type: 'awareness', update: uint8ToBase64(enc) })
    } catch (e) {
      console.warn('[collab-excalidraw] 编码 awareness 失败:', e)
    }
  }

  function sendUpdate(update: Uint8Array) {
    sendWs({ type: 'update', update: uint8ToBase64(update) })
  }

  // ---------------- Yjs 场景绑定 ----------------
  /** 场景内容签名（elements 顺序 + 各元素版本 + files key+长度），用于幂等跳过回声 */
  function sceneKey(elements: any[], files: Record<string, any>): string {
    const elKey = (elements || [])
      .map((el) => (el && el.id ? `${el.id}:${el.version ?? ''}:${el.versionNonce ?? ''}` : ''))
      .join('|')
    // files 内容指纹：fileId + dataURL 长度（图片内容变化时长变，用于触发同步）
    const fileKey = Object.keys(files || {})
      .sort()
      .map((id) => `${id}:${(files[id]?.dataURL || '').length}`)
      .join(',')
    return `${fileKey}#${elKey}`
  }

  /** 把 files 按需写入 Yjs：仅新增/删除/dataURL 变化时才 set，避免移动元素时反复全量重写大图片 */
  function writeFilesToYjs(filesMap: Y.Map<any>, files: Record<string, any>) {
    const fileIds = new Set(Object.keys(files || {}))
    filesMap.forEach((_v, id) => {
      if (!fileIds.has(id)) filesMap.delete(id)
    })
    Object.entries(files || {}).forEach(([id, f]) => {
      const existing = filesMap.get(id)
      if (!existing || existing.dataURL !== f?.dataURL || existing.mimeType !== f?.mimeType) {
        filesMap.set(id, f)
      }
    })
  }

  /** files 指纹（fileId + dataURL 长度），用于判断是否真正变化 */
  function filesKey(files: Record<string, any>): string {
    return Object.keys(files || {})
      .sort()
      .map((id) => `${id}:${(files[id]?.dataURL || '').length}`)
      .join(',')
  }

  function writeSceneToYjs(elements: any[], files: Record<string, any>): boolean {
    if (!doc || !canEdit.value) return false
    // 内容没变（远端应用后的回声 onChange / 无实际编辑）→ 不写 Yjs、不广播，打破回环
    const key = sceneKey(elements, files)
    if (key === lastSceneKey) return false
    lastSceneKey = key
    const elMap = doc.getMap('elements')
    const orderArr = doc.getArray('order')
    const filesMap = doc.getMap('files')
    const ids = new Set<string>()
    elements.forEach((el) => {
      if (el && el.id) {
        ids.add(el.id)
        elMap.set(el.id, el)
      }
    })
    elMap.forEach((_v, id) => {
      if (!ids.has(id)) elMap.delete(id)
    })
    const newOrder = elements.map((el) => el.id).filter(Boolean)
    const oldOrder = orderArr.toArray() as string[]
    const changed = newOrder.length !== oldOrder.length || newOrder.some((id, i) => oldOrder[i] !== id)
    if (changed) {
      orderArr.delete(0, orderArr.length)
      orderArr.insert(0, newOrder)
    }
    writeFilesToYjs(filesMap, files)
    return true
  }

  function buildSceneFromDoc() {
    const elMap = doc!.getMap('elements')
    const order = doc!.getArray('order').toArray() as string[]
    const elements = order.map((id) => elMap.get(id)).filter(Boolean)
    const files = Object.fromEntries(doc!.getMap('files').entries())
    return { elements, files }
  }

  function applySceneToExcalidraw() {
    if (!api || applyingRemote || !doc || status.value !== 'connected') return
    applyingRemote = true
    try {
      const { elements, files } = buildSceneFromDoc()
      // 记录本次应用后的场景签名，使随后异步触发的回声 onChange 被幂等跳过
      lastSceneKey = sceneKey(elements, files)
      // 顺序重要：必须先 updateScene 让 image 元素进入 scene，再 addFiles——
      // addFiles 内部会调用 addNewImagesToImageCache() 遍历 scene 中已有 image 元素
      // 从 this.files 取图加载；若先 addFiles，图片元素尚未进 scene，图片永远不加载（只剩边界框）
      const current = api.getAppState()
      api.updateScene({ elements, appState: { ...current, viewModeEnabled: !canEdit.value } })
      // Excalidraw addFiles 期望数组（BinaryFileData[]），不是对象（BinaryFiles）。
      // 注意：addFiles 会清空并重载 imageCache，只有 files 真正变化才调用，
      // 否则拖动元素时每帧 update 都会触发图片重载 → 闪烁。
      const fileKey = filesKey(files)
      if (fileKey !== lastFilesKey) {
        lastFilesKey = fileKey
        const fileArr = Object.values(files || {})
        if (fileArr.length) api.addFiles(fileArr)
      }
    } catch (e) {
      console.warn('[collab-excalidraw] 应用远端场景失败:', e)
    } finally {
      applyingRemote = false
    }
  }

  function applyPermission() {
    if (!api || applyingRemote || status.value !== 'connected') return
    applyingRemote = true
    try {
      const current = api.getAppState()
      api.updateScene({ appState: { ...current, viewModeEnabled: !canEdit.value } })
    } catch { /* ignore */ } finally {
      applyingRemote = false
    }
  }

  // ---------------- 光标 / 协作者 ----------------
  // 远端光标每帧都可能变化，updateScene 会触发全量重渲染，
  // 用 rAF 合并同一帧内的多次同步，避免高 CPU。
  function scheduleCursorSync() {
    if (cursorRaf) return
    cursorRaf = requestAnimationFrame(() => {
      cursorRaf = 0
      syncCursors()
    })
  }

  function syncCursors() {
    if (!api || !awareness || !doc || applyingRemote) return
    applyingRemote = true
    try {
      const collaborators = new Map<string, any>()
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === doc!.clientID) return
        const st = state as any
        const c = st?.cursor
        const user = st?.user
        if (!c || typeof c.x !== 'number' || typeof c.y !== 'number') return
        const color = typeof user?.color === 'string' ? user.color : '#888'
        collaborators.set(String(clientId), {
          pointer: { x: c.x, y: c.y, tool: 'pointer' },
          username: typeof user?.name === 'string' ? user.name : '',
          color: { background: color, stroke: color },
          id: String(clientId),
        })
      })
      const current = api.getAppState()
      api.updateScene({ appState: { ...current, collaborators } })
    } catch (e) {
      console.warn('[collab-excalidraw] 同步光标失败:', e)
    } finally {
      applyingRemote = false
    }
  }

  // ---------------- 公开回调（Excalidraw.vue 调用） ----------------
  function handleSceneChange(elements: any[], appState: any, files: Record<string, any>) {
    if (applyingRemote) return
    if (status.value !== 'connected') return
    const written = writeSceneToYjs(elements, files)
    // 主机节流上报 appState，供写盘保真（仅真正写入后上报，避免回声反复上报）
    if (written && isHost.value && api) {
      if (appstateTimer) clearTimeout(appstateTimer)
      appstateTimer = setTimeout(() => {
        appstateTimer = null
        if (status.value === 'connected') sendWs({ type: 'appstate', appState: api!.getAppState() })
      }, 800)
    }
  }

  function handlePointerMove(x: number, y: number) {
    if (!awareness) return
    const now = Date.now()
    if (now - lastCursorSend < 33) return // 节流 ~30fps
    lastCursorSend = now
    awareness.setLocalStateField('cursor', { x, y, tool: 'pointer', t: now })
  }

  // ---------------- 消息处理 ----------------
  function handleMessage(msg: any) {
    if (!msg || typeof msg.type !== 'string') return
    switch (msg.type) {
      case 'welcome': {
        ownMemberId = msg.memberId || ''
        isHost.value = !!msg.isHost
        members.value = Array.isArray(msg.members) ? msg.members : []
        const me = members.value.find((m) => m.id === ownMemberId)
        canEdit.value = me ? me.canEdit : true
        if (awareness && me) {
          awareness.setLocalStateField('user', { name: me.name, color: me.color })
        }
        break
      }
      case 'snapshot': {
        if (doc && msg.update) {
          try {
            Y.applyUpdate(doc, base64ToUint8(msg.update), REMOTE_ORIGIN)
          } catch (e) {
            console.warn('[collab-excalidraw] 应用快照失败:', e)
          }
        }
        status.value = 'connected'
        applySceneToExcalidraw()
        applyPermission()
        if (pendingConnect) {
          pendingConnect(true)
          pendingConnect = null
        }
        setTimeout(() => sendAwareness(), 60)
        break
      }
      case 'update': {
        if (doc && msg.update) {
          try {
            Y.applyUpdate(doc, base64ToUint8(msg.update), REMOTE_ORIGIN)
          } catch (e) {
            console.warn('[collab-excalidraw] 应用更新失败:', e)
          }
        }
        applySceneToExcalidraw()
        break
      }
      case 'awareness': {
        if (awareness && msg.update) {
          try {
            applyAwarenessUpdate(awareness, base64ToUint8(msg.update), REMOTE_ORIGIN)
          } catch (e) {
            console.warn('[collab-excalidraw] 应用 awareness 失败:', e)
          }
          scheduleCursorSync()
        }
        break
      }
      case 'members': {
        members.value = Array.isArray(msg.members) ? msg.members : []
        const me = members.value.find((m) => m.id === ownMemberId)
        if (me) {
          canEdit.value = me.canEdit
          if (me.role === 'host') isHost.value = true
        }
        applyPermission()
        break
      }
      case 'role': {
        if (msg.denied) {
          error.value = '编辑请求被拒绝'
        } else {
          canEdit.value = !!msg.canEdit
        }
        applyPermission()
        break
      }
      case 'host': {
        isHost.value = msg.hostId === ownMemberId
        break
      }
      case 'edit-request': {
        if (msg.member) {
          pendingEditRequests.value = [...pendingEditRequests.value, msg.member]
        }
        break
      }
      case 'saved': {
        if (saveResolve) {
          saveResolve(!!msg.ok)
          saveResolve = null
        }
        break
      }
      case 'appstate': {
        // 加入时同步主机的视口（scrollX/scrollY/zoom）：只应用视口字段，不覆盖权限等其它状态
        if (api && status.value === 'connected' && msg.appState && typeof msg.appState === 'object') {
          const v = msg.appState
          const hasView =
            typeof v.scrollX === 'number' ||
            typeof v.scrollY === 'number' ||
            (v.zoom && typeof v.zoom.value === 'number')
          if (hasView) {
            const current = api.getAppState()
            const next = { ...current }
            if (typeof v.scrollX === 'number') next.scrollX = v.scrollX
            if (typeof v.scrollY === 'number') next.scrollY = v.scrollY
            if (v.zoom && typeof v.zoom.value === 'number') next.zoom = v.zoom
            api.updateScene({ appState: next })
          }
        }
        break
      }
      case 'closed': {
        teardown(msg.reason || '会话已结束')
        break
      }
      case 'error': {
        error.value = msg.message || '发生错误'
        break
      }
      default:
        break
    }
  }

  // ---------------- 生命周期 ----------------
  function setupDocAndAwareness() {
    doc = new Y.Doc()
    awareness = new Awareness(doc)
    doc.on('update', (update: Uint8Array, origin: any) => {
      if (origin === REMOTE_ORIGIN) return
      sendUpdate(update)
    })
    awareness.on('update', (_changes: any, origin: any) => {
      if (origin === REMOTE_ORIGIN) return
      sendAwareness()
    })
    // 远端光标/状态变化 → 重算协作者光标（rAF 合并）
    awareness.on('change', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      if (!doc) return
      const remoteAdded = added.some((id) => id !== doc!.clientID)
      const remoteUpdated = updated.some((id) => id !== doc!.clientID)
      if (remoteAdded || remoteUpdated || removed.length) scheduleCursorSync()
    })
  }

  function connect(url: string, name: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        // eslint-disable-next-line no-new
        new URL(url)
      } catch {
        error.value = '协同地址无效'
        status.value = 'idle'
        resolve(false)
        return
      }
      const socket = new WebSocket(url)
      ws = socket
      status.value = 'connecting'
      error.value = ''
      setupDocAndAwareness()
      pendingConnect = resolve

      socket.onopen = () => {
        sendWs({ type: 'hello', name: name || '匿名' })
      }
      socket.onmessage = (ev) => {
        try {
          handleMessage(JSON.parse(ev.data))
        } catch (e) {
          console.warn('[collab-excalidraw] 解析消息失败:', e)
        }
      }
      socket.onerror = () => { /* onclose 统一处理 */ }
      socket.onclose = () => {
        if (pendingConnect) {
          const msg = error.value || '无法连接协同服务'
          pendingConnect(false)
          pendingConnect = null
          teardown(msg)
        } else if (status.value === 'connected') {
          teardown('连接已断开')
        } else if (status.value === 'connecting') {
          teardown(error.value || '连接已关闭')
        }
      }

      heartbeatTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          sendWs({ type: 'ping' })
          sendAwareness()
        }
      }, 10000)
    })
  }

  function teardown(reason: string) {
    if (cursorRaf) {
      cancelAnimationFrame(cursorRaf)
      cursorRaf = 0
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    if (appstateTimer) {
      clearTimeout(appstateTimer)
      appstateTimer = null
    }
    if (awareness) {
      try {
        awareness.destroy()
      } catch { /* ignore */ }
      awareness = null
    }
    if (ws) {
      try {
        ws.onclose = null
        ws.close()
      } catch { /* ignore */ }
      ws = null
    }
    if (pendingConnect) {
      pendingConnect(false)
      pendingConnect = null
    }
    if (saveResolve) {
      saveResolve(false)
      saveResolve = null
    }
    doc = null
    api = null
    applyingRemote = false
    lastSceneKey = ''
    lastFilesKey = ''
    status.value = 'idle'
    isHost.value = false
    canEdit.value = false
    roomId.value = null
    roomToken.value = ''
    members.value = []
    pendingEditRequests.value = []
    if (closedCb) {
      const cb = closedCb
      closedCb = null
      cb(reason)
    }
  }

  async function startHost(
    excalidrawApi: ExcalidrawLikeApi,
    filePath: string,
    content: string,
    opts: { token?: string; maxMembers?: number; permissionMode?: string; autoSaveSeconds?: number; name?: string } = {},
  ): Promise<boolean> {
    if (status.value !== 'idle') return false
    if (!window.dsh?.collab) {
      error.value = '协同服务不可用'
      return false
    }
    try {
      const res = await window.dsh.collab.shareFile(filePath, content, {
        ...opts,
        kind: 'excalidraw',
      })
      roomId.value = res.roomId
      roomToken.value = res.token || ''
      api = excalidrawApi
      const ok = await connect(res.url, opts.name?.trim() || '主机')
      if (!ok) {
        roomId.value = null
        roomToken.value = ''
        return false
      }
      return true
    } catch (e: any) {
      error.value = e?.message || String(e)
      status.value = 'idle'
      return false
    }
  }

  async function join(excalidrawApi: ExcalidrawLikeApi, url: string, name: string): Promise<boolean> {
    if (status.value !== 'idle') return false
    api = excalidrawApi
    return connect(url, name)
  }

  function leave() {
    if (status.value === 'idle') return
    teardown('left')
  }

  function save(): Promise<boolean> {
    return new Promise((resolve) => {
      if (status.value !== 'connected' || !ws) {
        resolve(false)
        return
      }
      saveResolve = resolve
      sendWs({ type: 'save-request' })
    })
  }

  function requestEdit() {
    sendWs({ type: 'request-edit' })
  }

  function grantEdit(memberId: string) {
    sendWs({ type: 'grant-edit', memberId })
  }

  function denyEdit(memberId: string) {
    sendWs({ type: 'deny-edit', memberId })
  }

  function clearEditRequest(memberId: string) {
    pendingEditRequests.value = pendingEditRequests.value.filter((m) => m.id !== memberId)
  }

  function onClosed(cb: (reason: string) => void) {
    closedCb = cb
  }

  function destroy() {
    if (status.value !== 'idle') teardown('left')
  }

  return {
    status: readonly(status),
    isHost: readonly(isHost),
    canEdit: readonly(canEdit),
    roomId: readonly(roomId),
    roomToken: readonly(roomToken),
    members: readonly(members) as Readonly<import('vue').Ref<CollabMember[]>>,
    error: readonly(error),
    pendingEditRequests: readonly(pendingEditRequests) as Readonly<import('vue').Ref<CollabMember[]>>,

    startHost,
    join,
    handleSceneChange,
    handlePointerMove,
    save,
    leave,
    requestEdit,
    grantEdit,
    denyEdit,
    clearEditRequest,
    onClosed,
    destroy,
  }
}
