/**
 * useCollabSession.ts — 渲染进程协同文件编辑会话
 *
 * 职责：
 * - 创建本地 Yjs Doc + Awareness，通过 WebSocket 与主进程 collab-service 同步；
 * - 收到快照后用 y-monaco 的 MonacoBinding 把 Y.Text 绑定到 Monaco 编辑器（双向）；
 * - 转发/应用 Yjs 增量更新与 Awareness（远端光标/选区）；
 * - 维护会话状态（status / isHost / canEdit / members / error）；
 * - 提供 save（请求服务端写盘）/ requestEdit / grantEdit / denyEdit。
 *
 * 协议见 electron/main/collab-service.ts 顶部注释。
 */
import { ref, readonly } from 'vue'
import * as Y from 'yjs'
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } from 'y-protocols/awareness'
import { MonacoBinding } from 'y-monaco'
import type * as monaco from 'monaco-editor'
import { uint8ToBase64, base64ToUint8, hexToRgba } from '@/lib/collab-codec'
import type { CollabMember } from '@/types/collab'

export type CollabSessionStatus = 'idle' | 'connecting' | 'connected'

/** 远端应用更新的 origin 哨兵（本地 doc.on('update') 与 awareness 均用它跳过回声） */
const REMOTE_ORIGIN = 'collab-remote'

/** 远端光标基础样式（y-monaco 渲染的 class） */
const CURSOR_BASE_CSS =
  '.yRemoteSelection{background-color:rgba(250,129,0,.35);}' +
  '.yRemoteSelectionHead{position:absolute;border-left:2px solid rgba(250,129,0,.5);}'

export interface CollabSessionController {
  status: Readonly<import('vue').Ref<CollabSessionStatus>>
  isHost: Readonly<import('vue').Ref<boolean>>
  canEdit: Readonly<import('vue').Ref<boolean>>
  roomId: Readonly<import('vue').Ref<string | null>>
  roomToken: Readonly<import('vue').Ref<string>>
  members: Readonly<import('vue').Ref<CollabMember[]>>
  error: Readonly<import('vue').Ref<string>>
  pendingEditRequests: Readonly<import('vue').Ref<CollabMember[]>>
  /** 宿主共享文件并进入会话（name：客户端名称，展示给其他成员） */
  startHost(
    editor: monaco.editor.IStandaloneCodeEditor,
    model: monaco.editor.ITextModel,
    filePath: string,
    content: string,
    opts?: { token?: string; maxMembers?: number; permissionMode?: string; autoSaveSeconds?: number; name?: string },
  ): Promise<boolean>
  /** 客户端加入会话（url 形如 ws://ip:port/collab/<roomId>?token=xxx） */
  join(editor: monaco.editor.IStandaloneCodeEditor, model: monaco.editor.ITextModel, url: string, name: string): Promise<boolean>
  /** 主动离开（reason='left'，不弹错误；其他原因由 onClosed 通知） */
  leave(): void
  /** 请求服务端把当前文档写入宿主磁盘 */
  save(): Promise<boolean>
  /** 请求编辑权（approve 模式） */
  requestEdit(): void
  /** 宿主批准 / 拒绝编辑请求 */
  grantEdit(memberId: string): void
  denyEdit(memberId: string): void
  /** 宿主处理完编辑请求后移除该条待办 */
  clearEditRequest(memberId: string): void
  /** 会话结束回调（reason：left / 错误信息 / 被关闭原因 / 连接断开） */
  onClosed(cb: (reason: string) => void): void
  /** 挂载到组件卸载时清理 */
  destroy(): void
}

export function useCollabSession(): CollabSessionController {
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
  let binding: MonacoBinding | null = null
  let ws: WebSocket | null = null
  let editorRef: monaco.editor.IStandaloneCodeEditor | null = null
  let modelRef: monaco.editor.ITextModel | null = null
  let ownMemberId = ''
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let cursorStyleEl: HTMLStyleElement | null = null
  let closedCb: ((reason: string) => void) | null = null
  let pendingConnect: ((ok: boolean) => void) | null = null
  let saveResolve: ((ok: boolean) => void) | null = null

  // ---------------- 发送 ----------------
  function sendWs(msg: Record<string, any>) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(msg))
      } catch (e) {
        console.warn('[collab] 发送失败:', e)
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
      console.warn('[collab] 编码 awareness 失败:', e)
    }
  }

  /** 广播 Yjs 内容增量更新 */
  function sendUpdate(update: Uint8Array) {
    sendWs({ type: 'update', update: uint8ToBase64(update) })
  }

  // ---------------- 远端光标样式 ----------------
  function ensureCursorStyles(clientId: number, color: string) {
    if (!cursorStyleEl) {
      cursorStyleEl = document.createElement('style')
      cursorStyleEl.id = 'collab-cursor-styles'
      cursorStyleEl.textContent = CURSOR_BASE_CSS
      document.head.appendChild(cursorStyleEl)
    }
    const selCls = `yRemoteSelection-${clientId}`
    if (cursorStyleEl.textContent && cursorStyleEl.textContent.includes(selCls)) return
    cursorStyleEl.textContent +=
      `.yRemoteSelection-${clientId}{background-color:${hexToRgba(color, 0.35)};}` +
      `.yRemoteSelectionHead-${clientId}{border-left:2px solid ${color};}`
  }

  function syncCursorStyles() {
    if (!awareness) return
    awareness.getStates().forEach((state, clientId) => {
      const color = (state as any)?.user?.color
      if (typeof color === 'string' && color) ensureCursorStyles(clientId, color)
    })
  }

  // ---------------- 成员名称徽标（浮在远端光标上方，类似 VS Code Live Share） ----------------
  const BADGE_CSS =
    '.collab-cursor-layer{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:10;}' +
    '.collab-cursor-badge{position:absolute;padding:0 5px;height:16px;line-height:16px;font-size:10px;color:#fff;border-radius:3px;white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,.3);}'
  let badgeLayerEl: HTMLDivElement | null = null
  let badgeStyleEl: HTMLStyleElement | null = null
  const badgeEls = new Map<number, HTMLDivElement>()
  let badgeScrollDisposable: monaco.IDisposable | null = null
  let badgeLayoutDisposable: monaco.IDisposable | null = null
  let badgeContentDisposable: monaco.IDisposable | null = null

  function ensureBadgeLayer() {
    if (badgeLayerEl || !editorRef) return
    const host = editorRef.getDomNode()?.parentElement
    if (!host) return
    if (!badgeStyleEl) {
      badgeStyleEl = document.createElement('style')
      badgeStyleEl.id = 'collab-badge-styles'
      badgeStyleEl.textContent = BADGE_CSS
      document.head.appendChild(badgeStyleEl)
    }
    badgeLayerEl = document.createElement('div')
    badgeLayerEl.className = 'collab-cursor-layer'
    host.appendChild(badgeLayerEl)
    badgeScrollDisposable = editorRef.onDidScrollChange(() => updateBadges())
    badgeLayoutDisposable = editorRef.onDidLayoutChange(() => updateBadges())
    badgeContentDisposable = modelRef?.onDidChangeContent(() => updateBadges()) ?? null
  }

  function updateBadges() {
    if (!editorRef || !modelRef || !doc || !awareness || !badgeLayerEl) return
    const ytext = doc.getText('content')
    const seen = new Set<number>()
    awareness.getStates().forEach((state, clientId) => {
      if (clientId === doc!.clientID) return
      const st = state as any
      const sel = st?.selection
      const user = st?.user
      if (!sel || !sel.head || !user || typeof user.name !== 'string' || !user.name) return
      const abs = Y.createAbsolutePositionFromRelativePosition(sel.head, doc!)
      if (!abs || abs.type !== ytext) return
      const pos = modelRef!.getPositionAt(abs.index)
      const vis = editorRef!.getScrolledVisiblePosition({ lineNumber: pos.lineNumber, column: pos.column })
      if (!vis) return
      seen.add(clientId)
      let badge = badgeEls.get(clientId)
      if (!badge) {
        badge = document.createElement('div')
        badge.className = 'collab-cursor-badge'
        badgeLayerEl!.appendChild(badge)
        badgeEls.set(clientId, badge)
      }
      badge.textContent = user.name.slice(0, 10)
      badge.style.backgroundColor = user.color || '#888'
      const BADGE_H = 16
      badge.style.left = `${vis.left}px`
      badge.style.top = `${Math.max(0, vis.top - BADGE_H)}px`
      badge.style.display = 'block'
    })
    badgeEls.forEach((el, id) => {
      if (!seen.has(id)) {
        el.remove()
        badgeEls.delete(id)
      }
    })
  }

  function destroyBadges() {
    badgeEls.forEach((el) => el.remove())
    badgeEls.clear()
    if (badgeScrollDisposable) { badgeScrollDisposable.dispose(); badgeScrollDisposable = null }
    if (badgeLayoutDisposable) { badgeLayoutDisposable.dispose(); badgeLayoutDisposable = null }
    if (badgeContentDisposable) { badgeContentDisposable.dispose(); badgeContentDisposable = null }
    if (badgeLayerEl) { badgeLayerEl.remove(); badgeLayerEl = null }
    if (badgeStyleEl) { badgeStyleEl.remove(); badgeStyleEl = null }
  }

  // ---------------- 绑定 Monaco ----------------
  function bindMonaco() {
    if (!editorRef || !modelRef || !doc || !awareness || binding) return
    try {
      binding = new MonacoBinding(doc.getText('content'), modelRef, new Set([editorRef]), awareness)
      syncCursorStyles()
      ensureBadgeLayer()
      updateBadges()
    } catch (e) {
      console.error('[collab] 绑定 Monaco 失败:', e)
      error.value = '编辑器绑定失败'
    }
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
            console.warn('[collab] 应用快照失败:', e)
          }
        }
        bindMonaco()
        status.value = 'connected'
        if (pendingConnect) {
          pendingConnect(true)
          pendingConnect = null
        }
        // 连接成功后广播一次本地 awareness，让远端立即看到光标
        setTimeout(() => sendAwareness(), 60)
        break
      }
      case 'update': {
        if (doc && msg.update) {
          try {
            Y.applyUpdate(doc, base64ToUint8(msg.update), REMOTE_ORIGIN)
          } catch (e) {
            console.warn('[collab] 应用更新失败:', e)
          }
        }
        break
      }
      case 'awareness': {
        if (awareness && msg.update) {
          try {
            applyAwarenessUpdate(awareness, base64ToUint8(msg.update), REMOTE_ORIGIN)
          } catch (e) {
            console.warn('[collab] 应用 awareness 失败:', e)
          }
          syncCursorStyles()
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
        break
      }
      case 'role': {
        if (msg.denied) {
          error.value = '编辑请求被拒绝'
        } else {
          canEdit.value = !!msg.canEdit
        }
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

  // ---------------- 会话生命周期 ----------------
  function setupDocAndAwareness() {
    doc = new Y.Doc()
    awareness = new Awareness(doc)
    // 本地内容编辑（y-monaco 绑定产生）→ 编码为 Yjs update 广播；远端应用不回声
    doc.on('update', (update: Uint8Array, origin: any) => {
      if (origin === REMOTE_ORIGIN) return
      sendUpdate(update)
    })
    awareness.on('update', (_changes: any, origin: any) => {
      // 本地状态变化（'local'）或远端超时清理（'timeout'）→ 广播当前状态；
      // 我们自己 apply 的远端更新（REMOTE_ORIGIN）→ 跳过，避免回声。
      if (origin === REMOTE_ORIGIN) return
      sendAwareness()
      syncCursorStyles()
    })
    // 光标/选区变化（本地或远端）→ 重算名称徽标位置
    awareness.on('change', () => updateBadges())
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
          console.warn('[collab] 解析消息失败:', e)
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
          sendAwareness() // 保持远端光标不过期
        }
      }, 10000)
    })
  }

  function teardown(reason: string) {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    if (binding) {
      try {
        binding.destroy()
      } catch (e) {
        console.warn('[collab] 销毁绑定失败:', e)
      }
      binding = null
    }
    if (awareness) {
      try {
        awareness.destroy()
      } catch (e) {
        console.warn('[collab] 销毁 awareness 失败:', e)
      }
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
    editorRef = null
    modelRef = null
    if (cursorStyleEl) {
      cursorStyleEl.remove()
      cursorStyleEl = null
    }
    destroyBadges()
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
    editor: monaco.editor.IStandaloneCodeEditor,
    model: monaco.editor.ITextModel,
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
      const res = await window.dsh.collab.shareFile(filePath, content, opts)
      roomId.value = res.roomId
      roomToken.value = res.token || ''
      editorRef = editor
      modelRef = model
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

  async function join(
    editor: monaco.editor.IStandaloneCodeEditor,
    model: monaco.editor.ITextModel,
    url: string,
    name: string,
  ): Promise<boolean> {
    if (status.value !== 'idle') return false
    editorRef = editor
    modelRef = model
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

  /** 宿主处理完编辑请求后移除该条待办 */
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
    leave,
    save,
    requestEdit,
    grantEdit,
    denyEdit,
    clearEditRequest,
    onClosed,
    destroy,
  }
}
